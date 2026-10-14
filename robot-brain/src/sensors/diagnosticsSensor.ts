import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { AetherEvent } from '../eventFilter/event';
import { Logger } from '../utils/logger';

const DUPLICATE_WINDOW_MS = 500;
const DIAG_EVICTION_INTERVAL_MS = 30000;

function isOutputDocument(uri: vscode.Uri): boolean {
    if (uri.scheme === 'output') { return true; }
    if (uri.scheme === 'vscode-userdata') { return true; }
    if (uri.fsPath.includes('extension-output')) { return true; }
    return false;
}

export class DiagnosticsSensor {

    private recentEntries: Map<string, number> = new Map();
    private lastDiagEviction: number = Date.now();
    private eventFilter: EventFilter;

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }

    public start(context: vscode.ExtensionContext): void {
        Logger.info("DIAGNOSTICS SENSOR", { "Event": "Started" });

        this.scanExistingDiagnostics();

        const diagnosticsListener = vscode.languages.onDidChangeDiagnostics((event) => {
            for (const uri of event.uris) {
                if (isOutputDocument(uri)) { continue; }

                const diagnostics = vscode.languages.getDiagnostics(uri);
                const fileName = uri.fsPath;
                const language = this.getLanguage(uri);

                for (const diagnostic of diagnostics) {
                    const severity = this.severityToString(diagnostic.severity);
                    const line = diagnostic.range.start.line + 1;

                    if (this.isDuplicate(uri.fsPath, diagnostic.message, line, severity)) {
                        continue;
                    }

                    this.publishDiagnosticEvent(fileName, language, diagnostic, severity, line);
                }

                // The per-diagnostic events above drive Context/Decision/Behaviour
                // and the teaching ladder. The batch below carries the WHOLE set of
                // a file at one moment, which is what the single-call explanation
                // path and the companion's "is the mistake still there?" check
                // need. It is published even when the set is empty: an empty batch
                // is the only honest signal that the file became clean, so the
                // resolution, the skill update and the gaze release all depend on
                // it being delivered.
                this.publishDiagnosticBatchEvent(fileName, language, diagnostics);
            }
        });

        context.subscriptions.push(diagnosticsListener);
    }

    private scanExistingDiagnostics(): void {
        const allDiagnostics = vscode.languages.getDiagnostics();
        let publishedCount = 0;

        for (const [uri, diagnostics] of allDiagnostics) {
            if (isOutputDocument(uri)) { continue; }
            if (uri.scheme !== 'file') { continue; }

            const fileName = uri.fsPath;
            const language = this.getLanguage(uri);

            for (const diagnostic of diagnostics) {
                const severity = this.severityToString(diagnostic.severity);
                const line = diagnostic.range.start.line + 1;

                this.publishDiagnosticEvent(fileName, language, diagnostic, severity, line);
                publishedCount++;
            }

            this.publishDiagnosticBatchEvent(fileName, language, diagnostics);
        }

        Logger.info("DIAGNOSTICS SENSOR", {
            "Event": "Startup scan complete",
            "Published": String(publishedCount)
        });
    }

    /**
     * One event carrying every diagnostic of a file at this moment, in the shape
     * PerceptionEngine.processDiagnosticBatch consumes. Deliberately not deduped
     * here: the DuplicateFilter already rejects a byte-identical payload inside
     * its 500 ms window, and the signature check that actually matters (has the
     * diagnostic SET changed?) lives in the batched explanation path.
     */
    private publishDiagnosticBatchEvent(
        filePath: string,
        language: string,
        diagnostics: readonly vscode.Diagnostic[]
    ): void {
        const entries = diagnostics.map((diagnostic) => {
            const severity = this.severityToString(diagnostic.severity);
            return {
                type: severity === "Warning" ? "WARNING" : "SEMANTIC_ERROR",
                details: diagnostic.message,
                line: diagnostic.range.start.line + 1,
                column: diagnostic.range.start.character + 1,
                endLine: diagnostic.range.end.line + 1,
                endColumn: diagnostic.range.end.character + 1,
                file: filePath,
                language,
                severity,
                code: diagnostic.code ? String(diagnostic.code) : undefined
            };
        });

        const event: AetherEvent = {
            id: `diag-batch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: EventType.DIAGNOSTIC_BATCH,
            timestamp: Date.now(),
            source: "DiagnosticsSensor",
            payload: {
                File: filePath,
                Language: language,
                TotalDiagnostics: entries.length,
                diagnostics: entries
            }
        };

        this.eventFilter.publish(event);
    }

    private publishDiagnosticEvent(
        filePath: string,
        language: string,
        diagnostic: vscode.Diagnostic,
        severity: string,
        line: number
    ): void {
        const event: AetherEvent = {
            id: `diag-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: EventType.DIAGNOSTICS_UPDATED,
            timestamp: Date.now(),
            source: "DiagnosticsSensor",
            payload: {
                File: filePath,
                Language: language,
                Severity: severity,
                Line: line,
                Column: diagnostic.range.start.character + 1,
                EndLine: diagnostic.range.end.line + 1,
                EndColumn: diagnostic.range.end.character + 1,
                Message: diagnostic.message,
                Code: diagnostic.code ? String(diagnostic.code) : undefined
            }
        };

        this.eventFilter.publish(event);

        const triggerLabel = severity === "Error" ? "TRIGGER_ROBOT" : "IGNORED";
        Logger.info("DIAGNOSTICS SENSOR", {
            "Event": "Diagnostics Updated",
            "File": filePath.split("\\").pop()?.split("/").pop() || "unknown",
            "Language": language,
            "Severity": severity,
            "Line": String(line),
            "Column": String(diagnostic.range.start.character + 1),
            "Message": diagnostic.message,
            "Action": triggerLabel,
            "Timestamp": new Date().toISOString()
        });
    }

    private evictStaleEntries(): void {
        const now = Date.now();
        if (now - this.lastDiagEviction < DIAG_EVICTION_INTERVAL_MS) {
            return;
        }
        this.lastDiagEviction = now;
        const cutoff = now - DUPLICATE_WINDOW_MS;
        for (const [key, time] of this.recentEntries) {
            if (time < cutoff) {
                this.recentEntries.delete(key);
            }
        }
    }

    private isDuplicate(filePath: string, message: string, line: number, severity: string): boolean {
        this.evictStaleEntries();

        const key = `${filePath}|${message}|${line}|${severity}`;
        const now = Date.now();
        const lastSeen = this.recentEntries.get(key);

        if (lastSeen !== undefined && (now - lastSeen) < DUPLICATE_WINDOW_MS) {
            return true;
        }

        this.recentEntries.set(key, now);
        return false;
    }

    private getLanguage(uri: vscode.Uri): string {
        const document = vscode.workspace.textDocuments.find(
            (doc) => doc.uri.toString() === uri.toString()
        );

        if (document) {
            return document.languageId;
        }

        return uri.fsPath.split(".").pop() || "unknown";
    }

    private severityToString(severity: vscode.DiagnosticSeverity): string {
        switch (severity) {
            case vscode.DiagnosticSeverity.Error:
                return "Error";
            case vscode.DiagnosticSeverity.Warning:
                return "Warning";
            case vscode.DiagnosticSeverity.Information:
                return "Information";
            case vscode.DiagnosticSeverity.Hint:
                return "Hint";
            default:
                return "Unknown";
        }
    }
}
