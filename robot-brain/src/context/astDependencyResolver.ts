import type * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import { loadTypeScript } from "../utils/typescriptApi";

export interface ResolvedDependency {
    moduleSpecifier: string;
    targetFile: string;
    importedSymbols: string[];
    exports: string[];
}

interface RequestedSymbols {
    symbols: string[];
    resolveAll: boolean;
}

interface SourceFileCacheEntry {
    contentHash: string;
    sourceFile: ts.SourceFile;
}

interface ExportCacheEntry {
    contentHash: string;
    exportsBySymbol: Map<string, string>;
    allExports: string[];
    hasDefaultExport: boolean;
}

const MAX_TARGET_FILE_BYTES = 256 * 1024;
const MAX_EXPORTS_PER_FILE = 12;
const MAX_EXPORT_TEXT_LENGTH = 800;

function hashCode(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return String(hash);
}

function isTsLikeFileName(fileName: string): boolean {
    return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(fileName);
}

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

/**
 * Lightweight AST-based import & dependency resolver built on the TypeScript
 * Compiler API. For a file with diagnostics it:
 *   - parses the file into a SourceFile AST,
 *   - collects the identifiers referenced on the error lines,
 *   - maps those identifiers to import bindings,
 *   - resolves the module specifier to a workspace file and extracts the
 *     exported interfaces/types/functions (signatures) for the used symbols.
 *
 * ASTs and resolved exports are cached keyed by content hash so unchanged
 * files are never re-parsed (keeps latency low).
 */
export class AstDependencyResolver {
    private sourceFileCache: Map<string, SourceFileCacheEntry> = new Map();
    private exportCache: Map<string, ExportCacheEntry> = new Map();

    async resolve(filePath: string, fileContent: string, errorLines: number[]): Promise<ResolvedDependency[]> {
        if (!filePath || !fileContent || !isTsLikeFileName(filePath) || errorLines.length === 0) {
            return [];
        }

        // Resolved once per call, not per node visit. A null compiler means AST
        // resolution is unavailable; returning no dependencies is correct, since
        // the caller formats an empty contribution rather than failing.
        const tsc = loadTypeScript();
        if (!tsc) {
            return [];
        }

        const sourceFile = this.getOrParse(tsc, filePath, fileContent);
        if (!sourceFile) {
            return [];
        }

        const errorIdentifiers = this.collectIdentifiersOnLines(tsc, sourceFile, new Set(errorLines));
        if (errorIdentifiers.size === 0) {
            return [];
        }

        const resolved: ResolvedDependency[] = [];
        for (const statement of sourceFile.statements) {
            if (!tsc.isImportDeclaration(statement)) {
                continue;
            }

            const moduleSpecifier = tsc.isStringLiteral(statement.moduleSpecifier)
                ? statement.moduleSpecifier.text
                : "";
            if (!moduleSpecifier) {
                continue;
            }

            const importClause = statement.importClause;
            if (!importClause) {
                continue;
            }

            const requested = this.collectRequestedSymbols(tsc, sourceFile, importClause, errorIdentifiers);
            if (requested.symbols.length === 0 && !requested.resolveAll) {
                continue;
            }

            const targetFile = await this.resolveModuleToFile(sourceFile.fileName, moduleSpecifier);
            if (!targetFile) {
                continue;
            }

            const exports = await this.extractExports(tsc, targetFile, requested);
            if (exports.length === 0) {
                continue;
            }

            resolved.push({
                moduleSpecifier,
                targetFile,
                importedSymbols: requested.symbols.length > 0 ? requested.symbols : ["*"],
                exports
            });
        }

        return resolved;
    }

    format(dependencies: ResolvedDependency[]): string {
        if (dependencies.length === 0) {
            return "";
        }
        return dependencies
            .map((dep) => {
                const used = dep.importedSymbols.join(", ");
                const exportsText = dep.exports.map((entry) => `    ${entry}`).join("\n");
                return `- ${dep.targetFile} (import '${dep.moduleSpecifier}', used: ${used}):\n${exportsText}`;
            })
            .join("\n\n");
    }

    clear(): void {
        this.sourceFileCache.clear();
        this.exportCache.clear();
    }

    private collectRequestedSymbols(
        tsc: typeof ts,
        sourceFile: ts.SourceFile,
        importClause: ts.ImportClause,
        errorIdentifiers: Set<string>
    ): RequestedSymbols {
        const symbols: string[] = [];
        let resolveAll = false;

        if (importClause.name && errorIdentifiers.has(importClause.name.text)) {
            symbols.push("default");
        }

        const namedBindings = importClause.namedBindings;
        if (namedBindings) {
            if (tsc.isNamespaceImport(namedBindings)) {
                const ns = namedBindings.name.text;
                if (errorIdentifiers.has(ns)) {
                    resolveAll = true;
                    symbols.push(...this.findNamespaceMembers(tsc, sourceFile, ns));
                }
            } else if (tsc.isNamedImports(namedBindings)) {
                for (const specifier of namedBindings.elements) {
                    const localName = specifier.name.text;
                    if (errorIdentifiers.has(localName)) {
                        symbols.push(specifier.propertyName ? specifier.propertyName.text : localName);
                    }
                }
            }
        }

        return { symbols: Array.from(new Set(symbols)), resolveAll };
    }

    private findNamespaceMembers(tsc: typeof ts, sourceFile: ts.SourceFile, ns: string): string[] {
        const members = new Set<string>();
        const walk = (node: ts.Node) => {
            if (tsc.isPropertyAccessExpression(node) &&
                tsc.isIdentifier(node.expression) &&
                node.expression.text === ns) {
                members.add(node.name.text);
            }
            tsc.forEachChild(node, walk);
        };
        tsc.forEachChild(sourceFile, walk);
        return Array.from(members);
    }

    private async resolveModuleToFile(importerFile: string, specifier: string): Promise<string | null> {
        if (!specifier.startsWith(".")) {
            return null;
        }
        const baseDir = path.dirname(importerFile);
        const base = path.resolve(baseDir, specifier);
        for (const candidate of this.buildCandidates(base)) {
            if (await this.fileExists(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    private buildCandidates(base: string): string[] {
        const ext = path.extname(base);
        if (ext && isTsLikeFileName(base)) {
            return [base];
        }
        return [
            base,
            `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, `${base}.mts`, `${base}.cts`,
            `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
            `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.d.ts`,
            `${base}/index.js`, `${base}/index.jsx`
        ];
    }

    private async extractExports(
        tsc: typeof ts,
        targetFile: string,
        requested: RequestedSymbols
    ): Promise<string[]> {
        const cache = await this.getExportCache(tsc, targetFile);
        if (!cache) {
            return [];
        }

        if (requested.resolveAll) {
            if (requested.symbols.length > 0) {
                const members = requested.symbols
                    .map((symbol) => cache.exportsBySymbol.get(symbol))
                    .filter((entry): entry is string => !!entry);
                if (members.length > 0) {
                    return members;
                }
            }
            return cache.allExports.slice(0, MAX_EXPORTS_PER_FILE);
        }

        return requested.symbols
            .map((symbol) => cache.exportsBySymbol.get(symbol))
            .filter((entry): entry is string => !!entry);
    }

    private async getExportCache(tsc: typeof ts, targetFile: string): Promise<ExportCacheEntry | undefined> {
        if (!await this.fileExists(targetFile)) {
            return undefined;
        }

        let content: string;
        try {
            const stat = await fs.promises.stat(targetFile);
            if (stat.size > MAX_TARGET_FILE_BYTES) {
                return undefined;
            }
            content = await fs.promises.readFile(targetFile, "utf-8");
        } catch {
            return undefined;
        }

        const contentHash = hashCode(content);
        const existing = this.exportCache.get(targetFile);
        if (existing && existing.contentHash === contentHash) {
            return existing;
        }

        const entry = this.buildExportCache(tsc, targetFile, content, contentHash);
        this.exportCache.set(targetFile, entry);
        return entry;
    }

    private buildExportCache(
        tsc: typeof ts,
        fileName: string,
        content: string,
        contentHash: string
    ): ExportCacheEntry {
        const exportsBySymbol = new Map<string, string>();
        const allExports: string[] = [];
        let hasDefaultExport = false;

        const sourceFile = this.getOrParse(tsc, fileName, content);
        if (sourceFile) {
            for (const statement of sourceFile.statements) {
                if (!this.isExported(statement)) {
                    continue;
                }

                if (tsc.isExportAssignment(statement) && tsc.isIdentifier(statement.expression)) {
                    exportsBySymbol.set("default", this.cap(statement.expression.text, MAX_EXPORT_TEXT_LENGTH));
                    hasDefaultExport = true;
                    continue;
                }

                const name = this.getDeclarationName(tsc, statement);
                if (!name) {
                    continue;
                }

                const text = this.cap(statement.getText(sourceFile), MAX_EXPORT_TEXT_LENGTH);
                if (!exportsBySymbol.has(name)) {
                    exportsBySymbol.set(name, text);
                    allExports.push(`${name}: ${text}`);
                }
                if (this.hasDefaultModifier(statement)) {
                    exportsBySymbol.set("default", text);
                    hasDefaultExport = true;
                }
            }
        }

        return { contentHash, exportsBySymbol, allExports, hasDefaultExport };
    }

    private isExported(node: ts.Node): boolean {
        return node.getText().trimStart().startsWith("export");
    }

    private hasDefaultModifier(node: ts.Node): boolean {
        const text = node.getText().trimStart();
        return text.startsWith("export default");
    }

    private getDeclarationName(tsc: typeof ts, statement: ts.Statement): string | null {
        if (tsc.isInterfaceDeclaration(statement) ||
            tsc.isTypeAliasDeclaration(statement) ||
            tsc.isFunctionDeclaration(statement) ||
            tsc.isClassDeclaration(statement) ||
            tsc.isEnumDeclaration(statement)) {
            return statement.name ? statement.name.text : null;
        }
        if (tsc.isVariableStatement(statement)) {
            const declaration = statement.declarationList.declarations[0];
            if (declaration && tsc.isIdentifier(declaration.name)) {
                return declaration.name.text;
            }
        }
        return null;
    }

    private collectIdentifiersOnLines(
        tsc: typeof ts,
        sourceFile: ts.SourceFile,
        lines: Set<number>
    ): Set<string> {
        const identifiers = new Set<string>();
        const walk = (node: ts.Node) => {
            if (tsc.isIdentifier(node)) {
                const { line } = tsc.getLineAndCharacterOfPosition(sourceFile, node.getStart());
                if (lines.has(line + 1)) {
                    identifiers.add(node.text);
                }
            }
            tsc.forEachChild(node, walk);
        };
        tsc.forEachChild(sourceFile, walk);
        return identifiers;
    }

    private getOrParse(tsc: typeof ts, fileName: string, content: string): ts.SourceFile | undefined {
        const contentHash = hashCode(content);
        const existing = this.sourceFileCache.get(fileName);
        if (existing && existing.contentHash === contentHash) {
            return existing.sourceFile;
        }
        try {
            const sourceFile = tsc.createSourceFile(
                fileName,
                content,
                tsc.ScriptTarget.Latest,
                true,
                inferScriptKind(tsc, fileName)
            );
            this.sourceFileCache.set(fileName, { contentHash, sourceFile });
            return sourceFile;
        } catch {
            return undefined;
        }
    }

    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.promises.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    private cap(text: string, maxLength: number): string {
        if (text.length <= maxLength) {
            return text;
        }
        return text.slice(0, maxLength).replace(/\s+\S*$/, "") + "\n// ... (truncated)";
    }
}
