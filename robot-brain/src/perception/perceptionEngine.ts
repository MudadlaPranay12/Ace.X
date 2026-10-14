import * as vscode from 'vscode';
import { EventType } from "../eventFilter/eventTypes";
import { AetherEvent } from "../eventFilter/event";
import { ObservationType } from "./observationType";
import { Observation } from "./observation";
import { WorkspaceState } from "./workspaceState";
import { ObservationPublisher } from "./observationPublisher";
import { Logger } from "../utils/logger";

interface EventMapping {
    observationType: ObservationType;
    confidence: number;
}

interface DiagnosticObservation {
    type: "SYNTAX_ERROR" | "SEMANTIC_ERROR" | "WARNING" | "INFO";
    details: string;
    line: number;
    column: number;
    file: string;
    language: string;
    severity: string;
    code?: string;
}

const SYNTAX_ERROR_TTL_MS = 30000;

/** Grace window bounds between proactive speech-bubble broadcasts for the
 *  same diagnostic set in the same file (see DiagnosticNotifyGate). The actual
 *  window is randomized inside [30s, 45s] so repeated unchanged-error alerts
 *  are suppressed without ever firing on a perfectly periodic cadence. */
const DIAGNOSTIC_GRACE_MIN_MS = 30000;
const DIAGNOSTIC_GRACE_MAX_MS = 45000;
const DIAGNOSTIC_NOTIFY_COOLDOWN_MS =
    DIAGNOSTIC_GRACE_MIN_MS + Math.floor(Math.random() * (DIAGNOSTIC_GRACE_MAX_MS - DIAGNOSTIC_GRACE_MIN_MS + 1));

export class PerceptionEngine {
    private workspaceState: WorkspaceState;
    private publisher: ObservationPublisher;
    private lastSyntaxError: Map<string, { timestamp: number; line: number; message: string; count: number }> = new Map();
    private lastSyntaxEviction: number = Date.now();

    /**
     * Deduplication gate for proactive speech bubbles. `lastNotifiedDiagnosticHash`
     * records the exact diagnostic signature that was last broadcast for each file,
     * and `lastNotificationTimestamp` records when that broadcast happened. A batch
     * with the SAME hash is suppressed until the cooldown window expires, so an
     * unchanged squiggly error no longer re-spawns "I found some issue" bubbles.
     */
    private lastNotifiedDiagnosticHash: Map<string, string> = new Map();
    private lastNotificationTimestamp: Map<string, number> = new Map();

    constructor() {
        this.workspaceState = new WorkspaceState();
        this.publisher = new ObservationPublisher();
    }

    /**
     * Strict guard for BotX's "Progressive Intervention" model. Returns false
     * when the active document is blank/whitespace or has zero compiler
     * diagnostics, so the caller skips Gemini analysis and speech bubbles
     * entirely (suppressing background noise on clean files).
     */
    shouldAnalyzeDocument(document: vscode.TextDocument, diagnostics: readonly vscode.Diagnostic[]): boolean {
        if (!document || !document.getText().trim()) {
            return false;
        }
        if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
            return false;
        }
        return true;
    }

    /**
     * Computes a unique signature for the active diagnostic set of a document:
     * `fileUri + "_" + diagnostics.map(d => d.code + ":" + d.range.start.line).sort().join("|")`.
     * When no diagnostics exist the signature collapses to the bare file, so a
     * subsequent empty batch never re-broadcasts a stale speech bubble.
     */
    computeDiagnosticBatchSignature(uri: string, diagnostics: readonly vscode.Diagnostic[]): string {
        const normalizedUri = uri.split(/[\\/]/).join("/");
        const entries = (Array.isArray(diagnostics) ? diagnostics : [])
            .map((d) => {
                const code = d.code !== undefined && d.code !== null ? String(d.code) : d.message;
                const line = d.range ? d.range.start.line : 0;
                return `${code}:${line}`;
            })
            .sort()
            .join("|");
        return `${normalizedUri}_${entries}`;
    }

    /**
     * Variant of `computeDiagnosticBatchSignature` that works on the already
     * batched `DiagnosticObservation` payload (line is 1-based here).
     */
    private computeDiagnosticBatchSignatureFromObservations(
        file: string,
        diagnostics: DiagnosticObservation[]
    ): string {
        const normalizedUri = file.split(/[\\/]/).join("/");
        const entries = (Array.isArray(diagnostics) ? diagnostics : [])
            .map((d) => `${d.code ?? d.details}:${Math.max(0, (d.line ?? 1) - 1)}`)
            .sort()
            .join("|");
        return `${normalizedUri}_${entries}`;
    }

    /**
     * True when a proactive speech bubble may be broadcast for the given file and
     * diagnostic signature. Broadcasts are suppressed while the hash is UNCHANGED
     * and inside the cooldown window (30s); a new distinct error (hash change) is
     * always broadcast immediately.
     */
    shouldBroadcastDiagnostic(file: string, signature: string): boolean {
        const now = Date.now();
        const lastHash = this.lastNotifiedDiagnosticHash.get(file);
        if (lastHash === undefined) {
            return true;
        }
        if (lastHash !== signature) {
            return true;
        }
        const lastTime = this.lastNotificationTimestamp.get(file) ?? 0;
        return now - lastTime >= DIAGNOSTIC_NOTIFY_COOLDOWN_MS;
    }

    /**
     * Records that a proactive speech bubble was broadcast for the file with the
     * given signature, resetting the cooldown clock.
     */
    recordDiagnosticNotification(file: string, signature: string): void {
        this.lastNotifiedDiagnosticHash.set(file, signature);
        this.lastNotificationTimestamp.set(file, Date.now());
    }

    /**
     * Clears the deduplication gate (e.g. when the active editor file changes) so
     * switching back to a file with the same errors re-evaluates them.
     */
    resetDiagnosticNotifyGate(): void {
        this.lastNotifiedDiagnosticHash.clear();
        this.lastNotificationTimestamp.clear();
    }

    process(event: AetherEvent): void {
        this.evictStaleSyntaxErrors();
        this.workspaceState.lastEventTime = event.timestamp;

        if (this.isSuppressedEvent(event)) {
            Logger.info("PERCEPTION", {
                "Event": "Suppressed (blank file) — no Gemini/speech",
                "Type": event.type
            });
            return;
        }

        // A batch event carries the whole diagnostic set of one file, so it is
        // published by processDiagnosticBatch rather than built field-by-field
        // here. It is deliberately NOT mapped through resolveMapping: an empty
        // batch is the resolution signal the companion needs.
        if (event.type === EventType.DIAGNOSTIC_BATCH) {
            const payload = event.payload as {
                File?: string;
                Language?: string;
                diagnostics?: DiagnosticObservation[];
            } | undefined;
            this.processDiagnosticBatch(payload?.diagnostics ?? [], {
                file: payload?.File,
                language: payload?.Language
            });
            return;
        }

        const mapping = this.resolveMapping(event);

        if (mapping === undefined) {
            return;
        }

        const observation = this.buildObservation(event, mapping);

        this.updateWorkspaceState(event, observation);

        this.publisher.publish(observation);

        Logger.info("PERCEPTION", {
            "Observation": observation.type,
            "Source": observation.source,
            "Confidence": String(observation.confidence)
        });
    }

    processRawDiagnostic(diagnostic: DiagnosticObservation): void {
        const event: AetherEvent = {
            id: `diag-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: EventType.DIAGNOSTICS_UPDATED,
            timestamp: Date.now(),
            source: "DiagnosticsSensor",
            payload: {
                File: diagnostic.file,
                Language: diagnostic.language,
                Severity: diagnostic.severity,
                Line: diagnostic.line,
                Column: diagnostic.column,
                Message: diagnostic.details,
                Code: diagnostic.code
            }
        };

        this.process(event);
    }

    processRawCursor(cursorEvent: { file: string; line: number; column: number; language: string }): void {
        const event: AetherEvent = {
            id: `cursor-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: EventType.CURSOR_MOVED,
            timestamp: Date.now(),
            source: "CursorSensor",
            payload: {
                File: cursorEvent.file,
                Language: cursorEvent.language,
                Line: cursorEvent.line,
                Column: cursorEvent.column
            }
        };

        this.process(event);
    }

    /**
     * Captures ALL diagnostic errors and warnings present in a document in a
     * single batched observation (not just the first error). The observation
     * carries the full arrays so downstream agents (context, explanation) can
     * analyze the entire document instead of a single diagnostic.
     *
     * For large files (100+ errors), diagnostics are sorted by severity
     * (Errors > Warnings) and proximity to the developer's current active
     * line cursor. Only the #1 primary error closest to the cursor is
     * selected for immediate robot-body display. Metadata includes:
     * `{ primaryErrorText, totalErrorsCount, currentErrorIndex }`.
     */
    processDiagnosticBatch(
        diagnostics: DiagnosticObservation[],
        meta?: { file?: string; language?: string }
    ): Observation | undefined {
        this.evictStaleSyntaxErrors();

        if (!Array.isArray(diagnostics)) {
            return undefined;
        }

        // An EMPTY batch is not discarded: it is how the pipeline learns that a
        // file became clean, which is what releases the gaze target, resolves the
        // recurring mistake and updates the skill profile. Dropping it here would
        // leave those permanently waiting for a message that never arrives.

        const file = meta?.file ?? diagnostics[0]?.file ?? "";
        const language = meta?.language ?? diagnostics[0]?.language ?? "";

        // Smart sort: severity first (Errors > Warnings), then by proximity
        // to the active cursor line for priority display.
        const cursorLine = this.workspaceState.currentCursorLine || 0;
        const sorted = [...diagnostics].sort((a, b) => {
            const aIsError = a.severity === "Error" || a.type === "SYNTAX_ERROR" || a.type === "SEMANTIC_ERROR";
            const bIsError = b.severity === "Error" || b.type === "SYNTAX_ERROR" || b.type === "SEMANTIC_ERROR";
            if (aIsError && !bIsError) { return -1; }
            if (!aIsError && bIsError) { return 1; }
            const aDist = Math.abs((a.line ?? 0) - cursorLine);
            const bDist = Math.abs((b.line ?? 0) - cursorLine);
            return aDist - bDist;
        });

        // Primary error: the #1 sorted diagnostic (closest error to cursor)
        const primaryError = sorted[0];
        const errorText = primaryError?.details ?? "";
        const errorLine = primaryError?.line ?? 1;
        const severity = primaryError?.severity ?? "";
        let filePath = file;
        if (file) {
            try {
                filePath = vscode.workspace.asRelativePath(file);
            } catch {
                filePath = file;
            }
        }

        // Compute currentErrorIndex (1-based) for the primary error
        const errorCount = sorted.filter(d =>
            d.severity === "Error" || d.type === "SYNTAX_ERROR" || d.type === "SEMANTIC_ERROR"
        ).length;
        const warningCount = sorted.filter(d =>
            d.severity === "Warning" || d.type === "WARNING"
        ).length;
        const primaryIndex = sorted.indexOf(primaryError) + 1;

        const batchSignature = this.computeDiagnosticBatchSignatureFromObservations(file, sorted);

        const errors: Record<string, unknown>[] = [];
        const warnings: Record<string, unknown>[] = [];

        for (const diagnostic of sorted) {
            const entry: Record<string, unknown> = {
                line: diagnostic.line,
                column: diagnostic.column,
                message: diagnostic.details,
                severity: diagnostic.severity,
                code: diagnostic.code,
                type: diagnostic.type
            };

            const isError = diagnostic.severity === "Error" ||
                diagnostic.type === "SYNTAX_ERROR" ||
                diagnostic.type === "SEMANTIC_ERROR";
            const isWarning = diagnostic.severity === "Warning" ||
                diagnostic.type === "WARNING";

            if (isError) {
                errors.push(entry);
            } else if (isWarning) {
                warnings.push(entry);
            } else {
                errors.push(entry);
            }
        }

        const observation: Observation = {
            id: `obs-diag-batch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: ObservationType.DIAGNOSTIC_BATCH,
            timestamp: Date.now(),
            confidence: errors.length > 0 ? 0.98 : 0.90,
            source: "DiagnosticsSensor",
            data: {
                File: file,
                Language: language,
                errors,
                warnings,
                errorCount: errors.length,
                warningCount: warnings.length,
                totalDiagnostics: diagnostics.length,
                diagnosticBatchSignature: batchSignature,
                errorText,
                filePath,
                line: errorLine,
                severity,
                totalErrorsCount: errorCount,
                totalWarningsCount: warningCount,
                currentErrorIndex: primaryIndex
            }
        };

        this.workspaceState.diagnosticCount = diagnostics.length;
        this.workspaceState.lastEventTime = observation.timestamp;

        if (file) {
            this.workspaceState.currentFile = file;
        }
        if (language) {
            this.workspaceState.currentLanguage = language;
        }

        this.publisher.publish(observation);

        Logger.info("PERCEPTION", {
            "Observation": observation.type,
            "Source": observation.source,
            "Errors": String(errors.length),
            "Warnings": String(warnings.length),
            "Total": String(diagnostics.length),
            "File": file.split(/[\\/]/).pop() || file
        });

        return observation;
    }

    getWorkspaceState(): WorkspaceState {
        return this.workspaceState;
    }

    getPublisher(): ObservationPublisher {
        return this.publisher;
    }

    /**
     * Guard applied to diagnostic, cursor, and save listeners: when the active
     * document is blank/whitespace, the background perception pipeline is
     * suppressed so we never invoke Gemini or dispatch speech bubbles for it.
     */
    private isSuppressedEvent(event: AetherEvent): boolean {
        if (!this.isActiveDocumentBlank()) {
            return false;
        }
        switch (event.type) {
            case EventType.DIAGNOSTICS_UPDATED:
            case EventType.CURSOR_MOVED:
            case EventType.FILE_SAVED:
            case EventType.EDITOR_ACTIVE:
            case EventType.EDITOR_SWITCHED:
            case EventType.EDITOR_OPENED:
                return true;
            default:
                return false;
        }
    }

    private isActiveDocumentBlank(): boolean {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return false;
        }
        return !editor.document.getText().trim();
    }

    private resolveMapping(event: AetherEvent): EventMapping | undefined {
        switch (event.type) {
            case EventType.EDITOR_ACTIVE:
            case EventType.EDITOR_SWITCHED:
                return { observationType: ObservationType.EDITOR_CHANGED, confidence: 1.0 };

            case EventType.EDITOR_OPENED:
                return { observationType: ObservationType.FILE_OPENED, confidence: 1.0 };

            case EventType.CURSOR_MOVED:
                return { observationType: ObservationType.CURSOR_MOVED, confidence: 1.0 };

            case EventType.DOCUMENT_CHANGED:
                return { observationType: ObservationType.DOCUMENT_CHANGED, confidence: 1.0 };

            case EventType.DOCUMENT_UNDO:
                return { observationType: ObservationType.DOCUMENT_UNDO, confidence: 1.0 };

            case EventType.DOCUMENT_REDO:
                return { observationType: ObservationType.DOCUMENT_REDO, confidence: 1.0 };

            case EventType.TYPING_ACTIVITY:
                return { observationType: ObservationType.TYPING_ACTIVITY, confidence: 1.0 };

            case EventType.TYPING_IDLE:
                return { observationType: ObservationType.TYPING_IDLE, confidence: 0.9 };

            case EventType.FILE_CREATED:
                return { observationType: ObservationType.FILE_CREATED, confidence: 1.0 };

            case EventType.FILE_DELETED:
                return { observationType: ObservationType.FILE_DELETED, confidence: 1.0 };

            case EventType.FILE_SAVED:
                return { observationType: ObservationType.FILE_SAVED, confidence: 1.0 };

            case EventType.FILE_RENAMED:
                return { observationType: ObservationType.FILE_RENAMED, confidence: 1.0 };

            case EventType.DIAGNOSTICS_UPDATED:
                return this.resolveDiagnosticMapping(event);

            case EventType.TERMINAL_OPENED:
                return { observationType: ObservationType.TERMINAL_OPENED, confidence: 1.0 };

            case EventType.TERMINAL_CLOSED:
                return { observationType: ObservationType.TERMINAL_CLOSED, confidence: 1.0 };

            case EventType.TERMINAL_ACTIVE:
                return { observationType: ObservationType.TERMINAL_ACTIVE, confidence: 1.0 };

            case EventType.TERMINAL_COMMAND_FAILED:
                return { observationType: ObservationType.RUNTIME_CRASH, confidence: 0.95 };

            case EventType.DEBUG_STARTED:
                return { observationType: ObservationType.DEBUG_STARTED, confidence: 1.0 };

            case EventType.DEBUG_STOPPED:
                return { observationType: ObservationType.DEBUG_STOPPED, confidence: 1.0 };

            case EventType.DEBUG_BREAKPOINT_HIT:
                return { observationType: ObservationType.DEBUG_INTERRUPTION, confidence: 0.90 };

            case EventType.GIT_BRANCH_CHANGED:
                return { observationType: ObservationType.GIT_BRANCH_CHANGED, confidence: 1.0 };

            case EventType.GIT_REPOSITORY_CHANGED:
                return { observationType: ObservationType.GIT_REPOSITORY_CHANGED, confidence: 1.0 };

            case EventType.GIT_COMMIT_SUCCESS:
                return { observationType: ObservationType.SUCCESSFUL_CHECKPOINT, confidence: 0.99 };

            case EventType.GIT_CONFLICT_DETECTED:
                return { observationType: ObservationType.GIT_CONFLICT_DETECTED, confidence: 0.95 };

            case EventType.GIT_CONFLICT_RESOLVED:
                return { observationType: ObservationType.GIT_CONFLICT_RESOLVED, confidence: 0.95 };

            case EventType.EXTENSION_INSTALLED:
                return { observationType: ObservationType.EXTENSION_INSTALLED, confidence: 1.0 };

            case EventType.EXTENSION_UNINSTALLED:
                return { observationType: ObservationType.EXTENSION_REMOVED, confidence: 1.0 };

            case EventType.EXTENSION_ENABLED:
                return { observationType: ObservationType.EXTENSION_ENABLED, confidence: 1.0 };

            case EventType.EXTENSION_DISABLED:
                return { observationType: ObservationType.EXTENSION_DISABLED, confidence: 1.0 };

            case EventType.ENVIRONMENT_CHECK:
                return { observationType: ObservationType.ENVIRONMENT_CHECK, confidence: 0.90 };

            case EventType.DEPRECATED_API_DETECTED:
                return { observationType: ObservationType.DEPRECATED_API_DETECTED, confidence: 0.90 };

            case EventType.STUCK_RAPID_SAVE:
                return { observationType: ObservationType.STUCK_RAPID_SAVE, confidence: 0.90 };

            case EventType.STUCK_IDLE_FOCUS:
                return { observationType: ObservationType.STUCK_IDLE_FOCUS, confidence: 0.85 };

            case EventType.COMMENT_TRIGGER_DETECTED:
                return { observationType: ObservationType.COMMENT_TRIGGER, confidence: 0.95 };

            case EventType.CODING_INTENT_DETECTED:
                return { observationType: ObservationType.CODING_INTENT, confidence: 0.95 };

            case EventType.LINE_NAVIGATED:
                return { observationType: ObservationType.LINE_NAVIGATED, confidence: 0.85 };

            case EventType.USER_INPUT:
            case EventType.USER_QUESTION:
            case EventType.USER_APPROVAL:
            case EventType.USER_FEEDBACK:
                return { observationType: ObservationType.USER_INPUT, confidence: 0.95 };

            case EventType.WEBVIEW_IPC:
                return { observationType: ObservationType.WEBVIEW_IPC, confidence: 0.9 };

            case EventType.SYSTEM_OUTPUT:
                return { observationType: ObservationType.SYSTEM_OUTPUT, confidence: 0.9 };

            case EventType.PROJECT_EVENT:
                return { observationType: ObservationType.PROJECT_EVENT, confidence: 0.7 };

            default:
                return undefined;
        }
    }

    private resolveDiagnosticMapping(event: AetherEvent): EventMapping | undefined {
        const payload = event.payload as Record<string, unknown> | undefined;

        if (!payload || typeof payload !== "object") {
            return { observationType: ObservationType.UNKNOWN, confidence: 0.5 };
        }

        const severity = String(payload["Severity"] || "");
        const message = String(payload["Message"] || "").toLowerCase();
        const line = Number(payload["Line"] || 0);
        const file = String(payload["File"] || "");
        const language = String(payload["Language"] || "").toLowerCase();

        if (severity === "Error" && this.isSyntaxError(message)) {
            const key = `${file}:${line}`;
            const now = Date.now();
            const last = this.lastSyntaxError.get(key);

            if (last && last.message === message && now - last.timestamp < 3000) {
                this.lastSyntaxError.set(key, { timestamp: now, line, message, count: last.count + 1 });
                return { observationType: ObservationType.SYNTAX_ERROR, confidence: 0.99 };
            }

            this.lastSyntaxError.set(key, { timestamp: now, line, message, count: 1 });
            return { observationType: ObservationType.SYNTAX_ERROR, confidence: 0.98 };
        }

        switch (severity) {
            case "Error":
                return { observationType: ObservationType.ERROR_DETECTED, confidence: 0.95 };
            case "Warning":
                return { observationType: ObservationType.WARNING_DETECTED, confidence: 0.85 };
            default:
                return undefined;
        }
    }

    private evictStaleSyntaxErrors(): void {
        const now = Date.now();
        if (now - this.lastSyntaxEviction < SYNTAX_ERROR_TTL_MS) {
            return;
        }
        this.lastSyntaxEviction = now;
        for (const [key, entry] of this.lastSyntaxError) {
            if (now - entry.timestamp > SYNTAX_ERROR_TTL_MS) {
                this.lastSyntaxError.delete(key);
            }
        }
    }

    private isSyntaxError(message: string): boolean {
        const syntaxKeywords = [
            "syntax error", "missing", "expected", "unexpected token",
            "';' expected", "',' expected", "')' expected",
            "illegal start", "not a statement", "unclosed",
            "bracket", "parenthesis", "insert", "semicolon",
            "class", "interface", "enum", "brace"
        ];
        return syntaxKeywords.some((keyword) => message.includes(keyword));
    }

    private buildObservation(event: AetherEvent, mapping: EventMapping): Observation {
        const payload = event.payload as Record<string, unknown> | undefined;

        const baseData: Record<string, unknown> = payload && typeof payload === "object"
            ? { ...payload }
            : {};

        const data = this.normalizeObservationData(event.type, baseData);

        return {
            id: `obs-${event.id}`,
            type: mapping.observationType,
            timestamp: event.timestamp,
            confidence: mapping.confidence,
            source: event.source,
            data
        };
    }

    private normalizeObservationData(eventType: EventType, payload: Record<string, unknown>): Record<string, unknown> {
        const data: Record<string, unknown> = { ...payload };

        if (eventType === EventType.DIAGNOSTICS_UPDATED) {
            data["details"] = payload["Message"] || "";
            data["syntaxError"] = this.isSyntaxError(String(payload["Message"] || "").toLowerCase());
            return data;
        }

        if (eventType === EventType.CURSOR_MOVED) {
            data["cursorLine"] = payload["Line"];
            data["cursorColumn"] = payload["Column"];
            return data;
        }

        if (eventType === EventType.TERMINAL_COMMAND_FAILED) {
            data["errorSnippet"] = payload["Error Snippet"] ?? "";
            data["terminalName"] = payload["Terminal Name"] ?? "";
            data["crash"] = true;
            return data;
        }

        if (eventType === EventType.DEBUG_BREAKPOINT_HIT) {
            data["reason"] = payload["Exception"] ?? payload["Reason"] ?? "";
            data["breakLine"] = payload["Line"] ?? 0;
            data["crashFile"] = payload["File"] ?? "";
            return data;
        }

        if (eventType === EventType.GIT_COMMIT_SUCCESS) {
            data["checkpoint"] = true;
            data["summary"] = payload["Message"] ?? "";
            return data;
        }

        if (eventType === EventType.GIT_CONFLICT_DETECTED) {
            data["conflict"] = true;
            data["conflictMessage"] = payload["Message"] ?? "";
            return data;
        }

        if (eventType === EventType.LINE_NAVIGATED) {
            data["navigationKind"] = payload["Kind"] ?? "";
            data["fromLine"] = payload["FromLine"] ?? 0;
            data["toLine"] = payload["ToLine"] ?? payload["Line"] ?? 0;
            data["lineDelta"] = payload["LineDelta"] ?? 0;
            return data;
        }

        if (
            eventType === EventType.USER_INPUT ||
            eventType === EventType.USER_QUESTION ||
            eventType === EventType.USER_APPROVAL ||
            eventType === EventType.USER_FEEDBACK
        ) {
            data["inputKind"] = payload["Kind"] ?? "";
            data["inputLabel"] = payload["Label"] ?? "";
            data["inputDetail"] = payload["Detail"] ?? "";
            return data;
        }

        if (eventType === EventType.WEBVIEW_IPC) {
            data["ipcDirection"] = payload["Direction"] ?? "";
            data["ipcMessageType"] = payload["MessageType"] ?? "";
            return data;
        }

        if (eventType === EventType.SYSTEM_OUTPUT) {
            data["outputKind"] = payload["Kind"] ?? "";
            data["outputText"] = payload["Text"] ?? "";
            data["outputFailed"] = payload["Failed"] ?? false;
            return data;
        }

        return data;
    }

    private updateWorkspaceState(event: AetherEvent, observation: Observation): void {
        const payload = event.payload as Record<string, unknown> | undefined;

        if (!payload || typeof payload !== "object") {
            return;
        }

        switch (observation.type) {
            case ObservationType.FILE_OPENED:
            case ObservationType.EDITOR_CHANGED: {
                const file = String(payload["File"] || "");
                const language = String(payload["Language"] || "");

                if (file) {
                    this.workspaceState.currentFile = file;
                    this.workspaceState.addOpenedFile(file);
                }
                if (language) {
                    this.workspaceState.currentLanguage = language;
                }
                break;
            }

            case ObservationType.CURSOR_MOVED: {
                const line = Number(payload["Line"] || 0);
                const column = Number(payload["Column"] || 0);

                this.workspaceState.currentCursorLine = line;
                this.workspaceState.currentCursorColumn = column;
                break;
            }

            case ObservationType.FILE_CREATED: {
                const file = String(payload["File"] || "");
                if (file) {
                    this.workspaceState.addOpenedFile(file);
                }
                break;
            }

            case ObservationType.FILE_DELETED: {
                const file = String(payload["File"] || "");
                if (file) {
                    this.workspaceState.removeOpenedFile(file);
                }
                break;
            }

            case ObservationType.ERROR_DETECTED:
            case ObservationType.WARNING_DETECTED:
            case ObservationType.SYNTAX_ERROR: {
                this.workspaceState.diagnosticCount += 1;
                break;
            }

            case ObservationType.TERMINAL_OPENED: {
                const name = String(payload["Terminal Name"] || "");
                if (name) {
                    this.workspaceState.activeTerminal = name;
                }
                break;
            }

            case ObservationType.TERMINAL_CLOSED: {
                this.workspaceState.activeTerminal = "";
                break;
            }

            case ObservationType.GIT_BRANCH_CHANGED: {
                const branch = String(payload["Branch"] || "");
                if (branch) {
                    this.workspaceState.gitBranch = branch;
                }
                break;
            }

            case ObservationType.RUNTIME_CRASH: {
                this.workspaceState.lastCrash = String(payload["Error Snippet"] ?? payload["errorSnippet"] ?? "");
                break;
            }

            case ObservationType.DEBUG_INTERRUPTION: {
                this.workspaceState.lastDebugBreak = String(payload["Exception"] ?? payload["Reason"] ?? "");
                break;
            }

            case ObservationType.SUCCESSFUL_CHECKPOINT: {
                this.workspaceState.lastCheckpoint = String(payload["Message"] ?? payload["summary"] ?? "");
                break;
            }

            case ObservationType.GIT_CONFLICT_DETECTED: {
                this.workspaceState.lastConflict = String(payload["Message"] ?? payload["conflictMessage"] ?? "");
                break;
            }

            case ObservationType.LINE_NAVIGATED: {
                const file = String(payload["File"] || "");
                if (file) {
                    this.workspaceState.currentFile = file;
                }
                this.workspaceState.currentCursorLine = Number(payload["ToLine"] ?? payload["Line"] ?? 0);
                this.workspaceState.currentCursorColumn = Number(payload["Column"] ?? 0);
                break;
            }

            case ObservationType.SYSTEM_OUTPUT: {
                if (payload["outputFailed"] === true) {
                    this.workspaceState.lastCrash = String(payload["outputText"] ?? "").slice(0, 500);
                }
                break;
            }

            default:
                break;
        }
    }
}

export { DiagnosticObservation };
