import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type * as ts from 'typescript';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { AetherEvent } from '../eventFilter/event';
import { Debounce } from '../eventFilter/debounce';
import { Logger } from '../utils/logger';
import { DEPRECATION_RULES, matchesPackage } from '../config/deprecationRules';
import type { DeprecationRule, InspectLanguage } from '../config/deprecationRules';
import { loadTypeScript } from '../utils/typescriptApi';

export interface DeprecatedApiUsage {
    file: string;
    line: number;
    packageName: string;
    installedVersion?: string;
    targetVersion?: string;
    deprecatedInVersion?: string;
    symbol: string;
    description: string;
    migrationHint: string;
}

interface ImportEntry {
    package: string;
    line: number;
}

const IMPORT_SCAN_DEBOUNCE_MS = 1200;
const MAX_MANIFEST_BYTES = 512 * 1024;

const MANIFEST_NAMES = [
    "package.json",
    "requirements.txt",
    "go.mod"
];

/**
 * Maps a file name to a ScriptKind. Takes the compiler API as an argument
 * because the compiler is resolved lazily — see utils/typescriptApi.ts for why
 * it is not a plain top-level import.
 */
function inferScriptKind(tsc: typeof ts, fileName: string): ts.ScriptKind {
    if (/\.tsx$/i.test(fileName)) {
        return tsc.ScriptKind.TSX;
    }
    if (/\.jsx$/i.test(fileName)) {
        return tsc.ScriptKind.JSX;
    }
    if (/\.(js|mjs|cjs)$/i.test(fileName)) {
        return tsc.ScriptKind.JS;
    }
    return tsc.ScriptKind.TS;
}

function stripVersion(version: string): string {
    return version.replace(/^[\^~>=<\s]*/, "").split(" ")[0];
}

/**
 * Inspects the active document for deprecated package imports and deprecated
 * SDK method/API usage across TypeScript/JS, Python, Go, and Java. Reads the
 * workspace package manifests to report the installed library version next to
 * each flagged API. Scanning is asynchronous and debounced so typing stays
 * responsive.
 */
export class ImportInspector {
    private eventFilter: EventFilter;
    private deprecationsByFile: Map<string, DeprecatedApiUsage[]> = new Map();
    private scanDebouncer: Debounce = new Debounce();

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }

    public start(context: vscode.ExtensionContext): void {
        Logger.info("IMPORT INSPECTOR", { "Event": "Started" });

        const editor = vscode.window.activeTextEditor;
        if (editor) {
            this.scheduleScan(editor.document, 0);
        }

        const activeEditorListener = vscode.window.onDidChangeActiveTextEditor((next) => {
            if (next) {
                this.scheduleScan(next.document, 100);
            }
        });

        const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
            const active = vscode.window.activeTextEditor;
            if (active && event.document === active.document) {
                this.scheduleScan(event.document, IMPORT_SCAN_DEBOUNCE_MS);
            }
        });

        const closeListener = vscode.workspace.onDidCloseTextDocument((document) => {
            this.deprecationsByFile.delete(document.uri.fsPath);
            Logger.info("IMPORT INSPECTOR", {
                "Event": "Document closed",
                "File": document.fileName.split(/[\\/]/).pop() || document.fileName,
                "Cache dropped": "Yes"
            });
        });

        context.subscriptions.push(activeEditorListener, changeListener, closeListener);
    }

    public getDeprecations(uri: vscode.Uri): DeprecatedApiUsage[] {
        const cached = this.deprecationsByFile.get(uri.fsPath);
        if (cached) {
            return cached;
        }
        const document = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === uri.fsPath);
        if (document) {
            this.scheduleScan(document, 0);
        }
        return [];
    }

    private scheduleScan(document: vscode.TextDocument, delayMs: number): void {
        this.scanDebouncer.debounce(
            `import:${document.uri.fsPath}`,
            () => {
                this.scanDocument(document).catch((err) => {
                    const message = err instanceof Error ? err.message : String(err);
                    Logger.info("IMPORT INSPECTOR", { "Event": "scanDocument failed", "Reason": message });
                });
            },
            delayMs
        );
    }

    private async scanDocument(document: vscode.TextDocument): Promise<void> {
        const deprecations = await this.inspectDocument(document);
        const file = document.uri.fsPath;
        const previous = this.deprecationsByFile.get(file) ?? [];
        const signature = this.buildSignature(deprecations);
        const previousSignature = this.buildSignature(previous);

        this.deprecationsByFile.set(file, deprecations);

        if (signature === previousSignature) {
            return;
        }
        if (deprecations.length > 0 || previous.length > 0) {
            this.publish(deprecations, document);
        }
    }

    private async inspectDocument(document: vscode.TextDocument): Promise<DeprecatedApiUsage[]> {
        if (!document || document.uri.scheme !== "file") {
            return [];
        }

        const language = this.toInspectLanguage(document.languageId);
        if (!language) {
            return [];
        }

        const folders = vscode.workspace.workspaceFolders;
        const root = folders && folders.length > 0
            ? folders[0].uri.fsPath
            : path.dirname(document.uri.fsPath);

        const installedVersions = await this.loadInstalledVersions(root);

        const lines = document.getText().split(/\r?\n/);
        const imports = this.parseImports(lines, document.fileName, language);
        const rules = DEPRECATION_RULES.filter((rule) => rule.language === language);

        const usages: DeprecatedApiUsage[] = [];
        const seen = new Set<string>();

        for (const rule of rules) {
            if (rule.kind === "import") {
                for (const imp of imports) {
                    if (!matchesPackage(imp.package, rule.packageName)) {
                        continue;
                    }
                    const key = `${imp.line}:import:${rule.packageName}`;
                    if (seen.has(key)) {
                        continue;
                    }
                    seen.add(key);
                    usages.push(this.buildUsage(document, rule, imp.line, imp.package, installedVersions));
                }
                continue;
            }

            if (!rule.linePattern) {
                continue;
            }
            if (rule.requiresImport &&
                !imports.some((imp) => matchesPackage(imp.package, rule.packageName))) {
                continue;
            }
            for (let i = 0; i < lines.length; i++) {
                if (rule.linePattern.test(lines[i])) {
                    const key = `${i + 1}:symbol:${rule.packageName}.${rule.symbol ?? ""}`;
                    if (seen.has(key)) {
                        continue;
                    }
                    seen.add(key);
                    usages.push(this.buildUsage(document, rule, i + 1, rule.packageName, installedVersions));
                }
            }
        }

        return usages;
    }

    private buildUsage(
        document: vscode.TextDocument,
        rule: DeprecationRule,
        line: number,
        packageName: string,
        installedVersions: Map<string, string>
    ): DeprecatedApiUsage {
        return {
            file: document.uri.fsPath,
            line,
            packageName,
            installedVersion: installedVersions.get(packageName),
            targetVersion: rule.targetVersion,
            deprecatedInVersion: rule.deprecatedInVersion,
            symbol: rule.symbol ?? packageName,
            description: rule.description,
            migrationHint: rule.migrationHint
        };
    }

    private parseImports(lines: string[], fileName: string, language: InspectLanguage): ImportEntry[] {
        switch (language) {
            case "typescript":
                return this.parseImportsTypeScript(lines, fileName);
            case "python":
                return this.parseImportsPython(lines);
            case "go":
                return this.parseImportsGo(lines);
            case "java":
                return this.parseImportsJava(lines);
        }
    }

    private parseImportsTypeScript(lines: string[], fileName: string): ImportEntry[] {
        // Without the compiler, TS/JS import scanning falls back to the regex
        // path below — less accurate on edge cases, but never fatal.
        const tsc = loadTypeScript();
        if (!tsc) {
            return this.parseImportsGeneric(lines);
        }

        const content = lines.join("\n");
        try {
            const sourceFile = tsc.createSourceFile(
                fileName,
                content,
                tsc.ScriptTarget.Latest,
                true,
                inferScriptKind(tsc, fileName)
            );
            const imports: ImportEntry[] = [];
            for (const statement of sourceFile.statements) {
                if (!tsc.isImportDeclaration(statement)) {
                    continue;
                }
                if (!tsc.isStringLiteral(statement.moduleSpecifier)) {
                    continue;
                }
                const { line } = tsc.getLineAndCharacterOfPosition(sourceFile, statement.getStart(sourceFile));
                imports.push({ package: statement.moduleSpecifier.text, line: line + 1 });
            }
            return imports;
        } catch {
            return [];
        }
    }

    /**
     * Compiler-free ES/TS import scan, used only when the TypeScript Compiler
     * API cannot be resolved (see utils/typescriptApi.ts). Deliberately simple:
     * it matches static import/export-from specifiers on their own line, which
     * covers what deprecation rules care about. Dynamic `import()` calls and
     * `require()` are not import *declarations* and are out of scope for this
     * fallback.
     */
    private parseImportsGeneric(lines: string[]): ImportEntry[] {
        const imports: ImportEntry[] = [];
        for (let i = 0; i < lines.length; i++) {
            const text = lines[i].trim();
            if (text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) {
                continue;
            }
            const m = text.match(/^(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/) ??
                text.match(/^import\s*['"]([^'"]+)['"]/);
            if (m) {
                imports.push({ package: m[1], line: i + 1 });
            }
        }
        return imports;
    }

    private parseImportsPython(lines: string[]): ImportEntry[] {
        const imports: ImportEntry[] = [];
        for (let i = 0; i < lines.length; i++) {
            const text = lines[i].trim();
            const direct = text.match(/^import\s+([A-Za-z0-9_.]+)/);
            if (direct) {
                imports.push({ package: direct[1].split(".")[0], line: i + 1 });
                continue;
            }
            const from = text.match(/^from\s+([A-Za-z0-9_.]+)\s+import/);
            if (from) {
                imports.push({ package: from[1].split(".")[0], line: i + 1 });
            }
        }
        return imports;
    }

    private parseImportsGo(lines: string[]): ImportEntry[] {
        const imports: ImportEntry[] = [];
        let inBlock = false;
        for (let i = 0; i < lines.length; i++) {
            const text = lines[i].trim();
            if (inBlock) {
                if (text === ")") {
                    inBlock = false;
                    continue;
                }
                const m = text.match(/^"([^"]+)"/);
                if (m) {
                    imports.push({ package: m[1], line: i + 1 });
                }
                continue;
            }
            const single = text.match(/^import\s+"([^"]+)"/);
            if (single) {
                imports.push({ package: single[1], line: i + 1 });
                continue;
            }
            if (text.startsWith("import (")) {
                inBlock = true;
            }
        }
        return imports;
    }

    private parseImportsJava(lines: string[]): ImportEntry[] {
        const imports: ImportEntry[] = [];
        for (let i = 0; i < lines.length; i++) {
            const text = lines[i].trim();
            const m = text.match(/^import\s+(?:static\s+)?([A-Za-z0-9_.*]+);/);
            if (m) {
                imports.push({ package: m[1].replace(/\.\*$/, ""), line: i + 1 });
            }
        }
        return imports;
    }

    private async loadInstalledVersions(root: string): Promise<Map<string, string>> {
        const versions = new Map<string, string>();
        for (const name of MANIFEST_NAMES) {
            const manifestPath = path.join(root, name);
            if (!this.fileExists(manifestPath)) {
                continue;
            }
            try {
                const stat = fs.statSync(manifestPath);
                if (stat.size > MAX_MANIFEST_BYTES) {
                    continue;
                }
                const content = await fs.promises.readFile(manifestPath, "utf-8");
                this.parseManifest(name, content, versions);
            } catch (err) {
                Logger.info("IMPORT INSPECTOR", {
                    "Event": "Manifest read failed",
                    "Manifest": name,
                    "Error": String(err)
                });
            }
        }
        return versions;
    }

    private parseManifest(name: string, content: string, versions: Map<string, string>): void {
        if (name === "package.json") {
            this.parsePackageJson(content, versions);
        } else if (name === "requirements.txt") {
            this.parseRequirementsTxt(content, versions);
        } else if (name === "go.mod") {
            this.parseGoMod(content, versions);
        }
    }

    private parsePackageJson(content: string, versions: Map<string, string>): void {
        try {
            const pkg = JSON.parse(content) as {
                dependencies?: Record<string, string>;
                devDependencies?: Record<string, string>;
                peerDependencies?: Record<string, string>;
            };
            const groups = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies];
            for (const group of groups) {
                if (!group) {
                    continue;
                }
                for (const [name, version] of Object.entries(group)) {
                    if (!versions.has(name)) {
                        versions.set(name, stripVersion(version));
                    }
                }
            }
        } catch {
            // malformed package.json — ignore
        }
    }

    private parseRequirementsTxt(content: string, versions: Map<string, string>): void {
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) {
                continue;
            }
            const m = trimmed.match(/^([A-Za-z0-9_.\-]+)\s*(?:==|>=|<=|~=|!=)\s*([^\s;]+)/);
            if (m) {
                versions.set(m[1].toLowerCase(), stripVersion(m[2]));
            }
        }
    }

    private parseGoMod(content: string, versions: Map<string, string>): void {
        for (const line of content.split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Za-z0-9.\-_/]+)\s+v([0-9]+\.[0-9]+\.[0-9]+)/);
            if (m) {
                versions.set(m[1], m[2]);
            }
        }
    }

    private publish(deprecations: DeprecatedApiUsage[], document: vscode.TextDocument): void {
        const event: AetherEvent = {
            id: `deprecated-api-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: EventType.DEPRECATED_API_DETECTED,
            timestamp: Date.now(),
            source: "ImportInspector",
            payload: {
                File: document.uri.fsPath,
                FileName: document.fileName.split(/[\\/]/).pop() || document.fileName,
                Language: document.languageId,
                DeprecationCount: deprecations.length,
                Deprecations: deprecations
            }
        };
        this.eventFilter.publish(event);
        Logger.info("IMPORT INSPECTOR", {
            "Event": deprecations.length > 0 ? "Deprecations detected" : "Deprecations cleared",
            "File": document.fileName.split(/[\\/]/).pop() || document.fileName,
            "Count": String(deprecations.length),
            "Timestamp": new Date().toISOString()
        });
    }

    private buildSignature(deprecations: DeprecatedApiUsage[]): string {
        return deprecations
            .map((d) => `${d.line}:${d.symbol}`)
            .sort()
            .join("|");
    }

    private toInspectLanguage(languageId: string): InspectLanguage | undefined {
        switch (languageId) {
            case "typescript":
            case "typescriptreact":
            case "javascript":
            case "javascriptreact":
                return "typescript";
            case "python":
                return "python";
            case "go":
                return "go";
            case "java":
                return "java";
            default:
                return undefined;
        }
    }

    private fileExists(filePath: string): boolean {
        try {
            return fs.existsSync(filePath);
        } catch {
            return false;
        }
    }
}
