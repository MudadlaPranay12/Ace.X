import * as vscode from 'vscode';
import * as fs from 'fs';
import { ObservationType } from "../perception/observationType";
import type { Observation } from "../perception/observation";
import { ContextType } from "./contextType";
import { Context } from "./context";
import { WorkspaceContext } from "./workspaceContext";
import { ContextPublisher } from "./contextPublisher";
import { AstDependencyResolver } from "./astDependencyResolver";
import type { ResolvedDependency } from "./astDependencyResolver";
import { Logger } from "../utils/logger";

interface BaseMapping {
    contextType: ContextType;
    confidence: number;
}

const LANGUAGE_MAP: Record<string, ContextType> = {
    "java": ContextType.EDITING_JAVA,
    "typescript": ContextType.EDITING_TYPESCRIPT,
    "javascript": ContextType.EDITING_TYPESCRIPT,
    "python": ContextType.EDITING_PYTHON,
    "cpp": ContextType.EDITING_CPP,
    "c": ContextType.EDITING_CPP
};

const STUCK_THRESHOLD_MS = 3000;

const RE_EXPLAIN_DEBOUNCE_MS = 2000;

interface StuckErrorTracker {
    file: string;
    line: number;
    message: string;
    firstSeen: number;
    lastSeen: number;
    count: number;
    lastEmittedAt: number | null;
}

export class ContextEngine {
    private workspaceContext: WorkspaceContext;
    private publisher: ContextPublisher;
    private stuckErrorTracker: Map<string, StuckErrorTracker> = new Map();
    private astDependencyResolver: AstDependencyResolver = new AstDependencyResolver();
    private lastProjectHealthAlert: number = 0;

    constructor() {
        this.workspaceContext = new WorkspaceContext();
        this.publisher = new ContextPublisher();
    }

    process(observation: Observation): void {
        this.cleanupStaleTrackers();

        const baseMapping = this.resolveBaseMapping(observation);

        if (baseMapping === undefined) {
            return;
        }

        const contextType = this.resolveLanguageContext(observation, baseMapping.contextType);

        if (observation.type === ObservationType.EDITOR_CHANGED) {
            this.clearStuckTrackers();
        }

        const context = this.buildContext(observation, contextType, baseMapping.confidence);

        this.updateWorkspaceContext(observation, context);

        this.checkStuckOnError(observation);

        this.publisher.publish(context);

        Logger.info("CONTEXT", {
            "Context": context.type,
            "Confidence": String(context.confidence),
            "Source": observation.type,
            "File": String(context.data["File"] ?? context.data["fileName"] ?? ""),
            "Language": String(context.data["Language"] ?? context.data["language"] ?? ""),
            "Timestamp": new Date(context.timestamp).toISOString()
        });
    }

    getWorkspaceContext(): WorkspaceContext {
        return this.workspaceContext;
    }

    getPublisher(): ContextPublisher {
        return this.publisher;
    }

    /**
     * Retrieves full file contents, surrounding code blocks around each error,
     * and language metadata for the file containing the diagnostics. Produces a
     * DIAGNOSTIC_ANALYSIS context that the explanation agent consumes.
     */
    async buildDiagnosticContext(observation: Observation): Promise<Context> {
        const data = observation.data;
        const file = String(data["File"] ?? "");
        const language = String(data["Language"] ?? data["language"] ?? "");
        const errors = Array.isArray(data["errors"]) ? data["errors"] as Record<string, unknown>[] : [];
        const warnings = Array.isArray(data["warnings"]) ? data["warnings"] as Record<string, unknown>[] : [];

        const fileContent = await this.readFileContent(file);

        const surroundingCode: Record<number, string> = {};
        const blockLines = new Set<number>();
        if (fileContent) {
            const lines = fileContent.split("\n");
            for (const diagnostic of [...errors, ...warnings]) {
                const line = Number(diagnostic["line"] ?? 0);
                if (line >= 1 && line <= lines.length) {
                    blockLines.add(line);
                }
            }
            for (const line of blockLines) {
                const start = Math.max(1, line - 3);
                const end = Math.min(lines.length, line + 3);
                surroundingCode[line] = lines
                    .slice(start - 1, end)
                    .map((content, index) => `${String(start + index).padStart(4)}: ${content}`)
                    .join("\n");
            }
        }

        const languageMetadata: Record<string, unknown> = {
            languageId: language,
            fileExtension: file.split(".").pop() || "",
            lineCount: fileContent ? fileContent.split("\n").length : 0,
            fileName: file.split(/[\\/]/).pop() || file,
            isKnownLanguage: LANGUAGE_MAP[language.toLowerCase()] !== undefined
        };

        // AST-based import & dependency resolution: parse the broken file and
        // resolve the exported signatures/interfaces of any imported symbols
        // referenced on the error lines. Results are cached per file content.
        const { dependencies, text } = await this.resolveDependenciesForFile(
            file,
            fileContent,
            language,
            blockLines
        );

        const context: Context = {
            id: `ctx-diag-${observation.id}-${Date.now()}`,
            type: ContextType.DIAGNOSTIC_ANALYSIS,
            confidence: 0.98,
            timestamp: Date.now(),
            sourceObservation: observation,
            data: {
                ...data,
                file,
                fileName: file.split(/[\\/]/).pop() || file,
                language,
                fileContent,
                errors,
                warnings,
                errorCount: errors.length,
                warningCount: warnings.length,
                totalDiagnostics: Number(data["totalDiagnostics"] ?? 0),
                surroundingCode,
                languageMetadata,
                resolvedDependencies: dependencies,
                resolvedDependenciesText: text
            }
        };

        this.workspaceContext.currentContext = context.type;
        this.workspaceContext.lastContextTime = context.timestamp;
        if (file) {
            this.workspaceContext.currentFile = file;
        }
        if (language) {
            this.workspaceContext.currentLanguage = language;
        }

        Logger.info("CONTEXT", {
            "Context": context.type,
            "Confidence": "0.98",
            "Source": observation.type,
            "File": context.data["fileName"] as string,
            "Language": language,
            "Errors": String(errors.length),
            "Warnings": String(warnings.length),
            "CodeBlocks": String(Object.keys(surroundingCode).length),
            "ResolvedDependencies": String(dependencies.length)
        });

        return context;
    }

    /**
     * Scans all open workspace diagnostics via vscode.languages.getDiagnostics().
     * If errors span >2 distinct files, emits a PROJECT_HEALTH_ALERT Context
     * payload summarizing broken files. Cooldown of 30s between alerts.
     */
    scanProjectHealth(): void {
        const now = Date.now();
        if (now - this.lastProjectHealthAlert < 30000) {
            return;
        }

        const allDiagnostics = vscode.languages.getDiagnostics();
        const fileErrorMap = new Map<string, number>();

        for (const [uri, diagnostics] of allDiagnostics) {
            if (uri.scheme !== 'file') {
                continue;
            }
            const errorCount = diagnostics.filter(
                d => d.severity === vscode.DiagnosticSeverity.Error
            ).length;
            if (errorCount > 0) {
                let relativePath = uri.fsPath;
                try {
                    relativePath = vscode.workspace.asRelativePath(uri);
                } catch {
                    // Use fsPath as fallback
                }
                fileErrorMap.set(relativePath, errorCount);
            }
        }

        if (fileErrorMap.size <= 2) {
            return;
        }

        this.lastProjectHealthAlert = now;

        const brokenFiles = Array.from(fileErrorMap.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([file, count]) => `${file.split(/[\\/]/).pop()} (${count} errors)`)
            .slice(0, 10);

        const totalErrors = Array.from(fileErrorMap.values()).reduce((a, b) => a + b, 0);
        const fileCount = fileErrorMap.size;

        const context: Context = {
            id: `ctx-project-health-${Date.now()}`,
            type: ContextType.PROJECT_HEALTH_ALERT,
            confidence: 0.90,
            timestamp: now,
            sourceObservation: {
                id: `obs-project-health-${Date.now()}`,
                type: ObservationType.DIAGNOSTIC_BATCH,
                timestamp: now,
                confidence: 0.90,
                source: "ContextEngine",
                data: {}
            },
            data: {
                fileCount,
                totalErrors,
                brokenFiles,
                brokenFileNames: brokenFiles.map(f => f.split(' (')[0]),
                summary: `${fileCount} files broken: ${brokenFiles.slice(0, 3).map(f => f.split(' (')[0]).join(', ')}${fileCount > 3 ? ` +${fileCount - 3} more` : ''}`
            }
        };

        this.workspaceContext.currentContext = context.type;
        this.workspaceContext.lastContextTime = context.timestamp;

        this.publisher.publish(context);

        Logger.info("CONTEXT", {
            "Context": "PROJECT_HEALTH_ALERT",
            "Confidence": "0.90",
            "Files": String(fileCount),
            "TotalErrors": String(totalErrors),
            "BrokenFiles": brokenFiles.slice(0, 5).join(", ")
        });
    }

    /**
     * Resolves external imports used on the error lines via the AST resolver.
     * Only attempts resolution for TypeScript/JavaScript files; returns empty
     * for other languages so non-TS diagnostics are unaffected.
     */
    private async resolveDependenciesForFile(
        file: string,
        fileContent: string,
        language: string,
        errorLines: Set<number>
    ): Promise<{ dependencies: ResolvedDependency[]; text: string }> {
        const isTsLike = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(file) ||
            /^(typescript|javascript|typescriptreact|javascriptreact)$/i.test(language);

        if (!isTsLike || !fileContent) {
            return { dependencies: [], text: "" };
        }

        try {
            const dependencies = await this.astDependencyResolver.resolve(file, fileContent, Array.from(errorLines));
            return {
                dependencies,
                text: this.astDependencyResolver.format(dependencies)
            };
        } catch (err) {
            Logger.info("CONTEXT", {
                "Event": "AST dependency resolution failed",
                "File": file.split(/[\\/]/).pop() || file,
                "Error": String(err)
            });
            return { dependencies: [], text: "" };
        }
    }

    private async readFileContent(file: string): Promise<string> {
        if (!file) {
            return "";
        }

        try {
            const document = vscode.workspace.textDocuments.find(
                (doc) => doc.uri.scheme === "file" && doc.uri.fsPath === file
            );
            if (document) {
                return document.getText();
            }
        } catch (err) {
            Logger.info("CONTEXT", { "Event": "Text document lookup failed", "Error": String(err) });
        }

        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            return document.getText();
        } catch (err) {
            Logger.info("CONTEXT", { "Event": "openTextDocument failed", "Error": String(err) });
        }

        try {
            return await fs.promises.readFile(file, "utf-8");
        } catch (err) {
            Logger.info("CONTEXT", { "Event": "fs read failed", "Error": String(err) });
            return "";
        }
    }

    private resolveBaseMapping(observation: Observation): BaseMapping | undefined {
        switch (observation.type) {
            case ObservationType.FILE_OPENED:
            case ObservationType.CURSOR_MOVED:
                return { contextType: ContextType.READING_CODE, confidence: 1.0 };

            case ObservationType.FILE_SAVED:
            case ObservationType.FILE_CREATED:
                return { contextType: ContextType.WRITING_CODE, confidence: 0.95 };

            case ObservationType.EDITOR_CHANGED:
                return { contextType: ContextType.SWITCHING_FILES, confidence: 1.0 };

            case ObservationType.DIAGNOSTIC_BATCH:
                // Batch observations are consumed by the dedicated 4-agent
                // diagnostic flow (ContextEngine.buildDiagnosticContext) and
                // should not re-enter the legacy decision pipeline.
                return undefined;

            case ObservationType.SYNTAX_ERROR:
                return { contextType: ContextType.FIXING_COMPILER_ERROR, confidence: 0.98 };

            case ObservationType.ERROR_DETECTED:
                return { contextType: ContextType.FIXING_COMPILER_ERROR, confidence: 0.95 };

            case ObservationType.WARNING_DETECTED:
                return { contextType: ContextType.FIXING_COMPILER_ERROR, confidence: 0.80 };

            case ObservationType.DEBUG_STARTED:
                return { contextType: ContextType.DEBUGGING, confidence: 1.0 };

            case ObservationType.DEBUG_STOPPED:
                return { contextType: ContextType.IDLE, confidence: 1.0 };

            case ObservationType.TERMINAL_OPENED:
                return { contextType: ContextType.USING_TERMINAL, confidence: 1.0 };

            case ObservationType.TERMINAL_CLOSED:
                return { contextType: ContextType.IDLE, confidence: 1.0 };

            case ObservationType.GIT_BRANCH_CHANGED:
                return { contextType: ContextType.WORKING_WITH_GIT, confidence: 1.0 };

            case ObservationType.EXTENSION_INSTALLED:
            case ObservationType.EXTENSION_REMOVED:
                return { contextType: ContextType.MANAGING_EXTENSIONS, confidence: 1.0 };

            case ObservationType.CODING_INTENT:
                return { contextType: ContextType.WRITING_CODE, confidence: 0.95 };

            case ObservationType.LINE_NAVIGATED:
                return { contextType: ContextType.NAVIGATING, confidence: 0.8 };

            case ObservationType.USER_INPUT:
            case ObservationType.WEBVIEW_IPC:
                return { contextType: ContextType.INTERACTING, confidence: 0.9 };

            case ObservationType.SYSTEM_OUTPUT: {
                const kind = String(observation.data["outputKind"] ?? "").toLowerCase();
                if (kind === 'test') {
                    return { contextType: ContextType.RUNNING_TESTS, confidence: 0.85 };
                }
                if (kind === 'build') {
                    return { contextType: ContextType.BUILDING, confidence: 0.85 };
                }
                return { contextType: ContextType.SYSTEM_EVENT, confidence: 0.8 };
            }

            case ObservationType.PROJECT_EVENT:
                return { contextType: ContextType.SYSTEM_EVENT, confidence: 0.7 };

            default:
                return { contextType: ContextType.UNKNOWN, confidence: 0.50 };
        }
    }

    private resolveLanguageContext(observation: Observation, baseType: ContextType): ContextType {
        const language = String(observation.data["Language"] ?? observation.data["language"] ?? "").toLowerCase();

        const diagnosticContexts: readonly ContextType[] = Object.freeze([
            ContextType.FIXING_COMPILER_ERROR,
            ContextType.USER_STUCK_ON_ERROR,
            ContextType.DIAGNOSTIC_ANALYSIS,
            ContextType.PROJECT_HEALTH_ALERT,
        ]);

        if (diagnosticContexts.includes(baseType)) {
            return baseType;
        }

        if (language && language in LANGUAGE_MAP) {
            return LANGUAGE_MAP[language];
        }

        return baseType;
    }

    private buildContext(observation: Observation, contextType: ContextType, confidence: number): Context {
        return {
            id: `ctx-${observation.id}`,
            type: contextType,
            confidence,
            timestamp: observation.timestamp,
            sourceObservation: observation,
            data: { ...observation.data }
        };
    }

    private updateWorkspaceContext(observation: Observation, context: Context): void {
        this.workspaceContext.currentContext = context.type;
        this.workspaceContext.lastContextTime = context.timestamp;

        const data = observation.data;
        const file = String(data["File"] ?? data["fileName"] ?? "");
        const language = String(data["Language"] ?? data["language"] ?? "");
        const line = Number(data["Line"] ?? 0);
        const column = Number(data["Column"] ?? 0);
        const branch = String(data["Branch"] ?? "");

        if (file) {
            this.workspaceContext.currentFile = file;
        }

        if (language) {
            this.workspaceContext.currentLanguage = language;
        }

        if (line) {
            this.workspaceContext.cursorLine = line;
        }

        if (column) {
            this.workspaceContext.cursorColumn = column;
        }

        if (branch) {
            this.workspaceContext.gitBranch = branch;
        }

        switch (observation.type) {
            case ObservationType.ERROR_DETECTED: {
                const message = String(data["Message"] ?? "");
                if (message) {
                    this.workspaceContext.lastError = message;
                }
                break;
            }

            case ObservationType.DEBUG_STARTED: {
                this.workspaceContext.debuggerActive = true;
                break;
            }

            case ObservationType.DEBUG_STOPPED: {
                this.workspaceContext.debuggerActive = false;
                break;
            }

            case ObservationType.TERMINAL_OPENED: {
                this.workspaceContext.terminalActive = true;
                break;
            }

            case ObservationType.TERMINAL_CLOSED: {
                this.workspaceContext.terminalActive = false;
                break;
            }

            default:
                break;
        }
    }

    private isTrackableError(observation: Observation): boolean {
        return observation.type === ObservationType.SYNTAX_ERROR ||
               observation.type === ObservationType.ERROR_DETECTED ||
               observation.type === ObservationType.WARNING_DETECTED;
    }

    private checkStuckOnError(observation: Observation): void {
        if (!this.isTrackableError(observation)) {
            return;
        }

        const data = observation.data;
        const file = String(data["File"] ?? data["fileName"] ?? "");
        const line = Number(data["Line"] ?? 0);
        const message = String(data["Message"] ?? data["details"] ?? "");

        if (!file || !line || !message) {
            return;
        }

        const key = `${file}:${line}:${message}`;
        const now = Date.now();

        const existing = this.stuckErrorTracker.get(key);

        if (existing) {
            existing.lastSeen = now;
            existing.count += 1;

            if (now - existing.firstSeen >= STUCK_THRESHOLD_MS) {
                const canReEmit = existing.lastEmittedAt === null ||
                    (now - existing.lastEmittedAt) >= RE_EXPLAIN_DEBOUNCE_MS;

                if (canReEmit) {
                    this.emitStuckContext(existing, observation);
                    existing.lastEmittedAt = now;
                }
            }
        } else {
            this.stuckErrorTracker.set(key, {
                file,
                line,
                message,
                firstSeen: now,
                lastSeen: now,
                count: 1,
                lastEmittedAt: null
            });
        }
    }

    private emitStuckContext(tracker: StuckErrorTracker, observation: Observation): void {
        const severity = observation.type === ObservationType.WARNING_DETECTED ? "Warning" : "Error";
        const context: Context = {
            id: `ctx-stuck-${tracker.file}-${tracker.line}-${Date.now()}`,
            type: ContextType.USER_STUCK_ON_ERROR,
            confidence: 0.95,
            timestamp: observation.timestamp,
            sourceObservation: observation,
            data: {
                file: tracker.file,
                line: tracker.line,
                message: tracker.message,
                language: this.workspaceContext.currentLanguage,
                severity,
                description: `User is stuck on a ${severity.toLowerCase()} in ${tracker.file}`,
                stuckDurationMs: Date.now() - tracker.firstSeen,
                errorCount: tracker.count
            }
        };

        this.workspaceContext.currentContext = context.type;
        this.workspaceContext.lastContextTime = context.timestamp;

        this.publisher.publish(context);

        Logger.info("CONTEXT", {
            "Context": "USER_STUCK_ON_ERROR",
            "Confidence": "0.95",
            "Source": `${observation.type}_PERSISTENCE`,
            "File": tracker.file,
            "Line": String(tracker.line),
            "Duration": String(Date.now() - tracker.firstSeen)
        });
    }

    private clearStuckTrackers(): void {
        this.stuckErrorTracker.clear();
        Logger.info("CONTEXT", {
            "Context": "STUCK_TRACKERS_CLEARED",
            "Reason": "Editor switched — resetting error tracking for new file"
        });
    }

    private cleanupStaleTrackers(): void {
        const now = Date.now();
        const STALE_THRESHOLD_MS = 30000;

        for (const [key, tracker] of this.stuckErrorTracker.entries()) {
            if (now - tracker.lastSeen > STALE_THRESHOLD_MS) {
                this.stuckErrorTracker.delete(key);
            }
        }
    }
}