import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { AetherEvent } from '../eventFilter/event';
import { Debounce } from '../eventFilter/debounce';
import { Logger } from '../utils/logger';

export interface GitConflictBlock {
    file: string;
    startLine: number;
    currentBranchLabel: string;
    currentStart: number;
    dividerLine: number;
    incomingBranchLabel: string;
    endLine: number;
    currentCode: string;
    incomingCode: string;
}

const CONFLICT_SCAN_DEBOUNCE_MS = 400;

function isMarker(text: string, kind: "<" | "=" | ">"): boolean {
    if (kind === "<") {return text.startsWith("<<<<<<<");}
    if (kind === "=") {return text.startsWith("=======");}
    return text.startsWith(">>>>>>>");
}

function markerLabel(text: string, fallback: string): string {
    const label = text.slice(7).trim();
    return label || fallback;
}

export function parseGitConflictBlocks(document: vscode.TextDocument): GitConflictBlock[] {
    const blocks: GitConflictBlock[] = [];
    const lineCount = document.lineCount;

    let i = 0;
    while (i < lineCount) {
        const startText = document.lineAt(i).text;
        if (!isMarker(startText, "<")) {
            i += 1;
            continue;
        }

        const currentLines: string[] = [];
        let dividerLine = -1;
        let j = i + 1;
        while (j < lineCount) {
            const text = document.lineAt(j).text;
            if (isMarker(text, "=")) {
                dividerLine = j;
                break;
            }
            currentLines.push(text);
            j += 1;
        }

        if (dividerLine === -1) {
            break;
        }

        const incomingLines: string[] = [];
        let endLine = -1;
        let k = dividerLine + 1;
        while (k < lineCount) {
            const text = document.lineAt(k).text;
            if (isMarker(text, ">")) {
                endLine = k;
                break;
            }
            incomingLines.push(text);
            k += 1;
        }

        if (endLine === -1) {
            break;
        }

        blocks.push({
            file: document.uri.fsPath,
            startLine: i + 1,
            currentBranchLabel: markerLabel(startText, "HEAD"),
            currentStart: i + 2,
            dividerLine: dividerLine + 1,
            incomingBranchLabel: markerLabel(document.lineAt(endLine).text, "incoming"),
            endLine: endLine + 1,
            currentCode: currentLines.join("\n"),
            incomingCode: incomingLines.join("\n")
        });

        i = endLine + 1;
    }

    return blocks;
}

export class GitConflictSensor {
    private eventFilter: EventFilter;
    private conflictsByFile: Map<string, GitConflictBlock[]> = new Map();
    private scanDebouncer: Debounce = new Debounce();

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }

    public start(context: vscode.ExtensionContext): void {
        Logger.info("GIT CONFLICT SENSOR", { "Event": "Started" });

        const editor = vscode.window.activeTextEditor;
        if (editor) {
            this.scheduleScan(editor.document);
        }

        const activeEditorListener = vscode.window.onDidChangeActiveTextEditor((next) => {
            if (next) {
                this.scheduleScan(next.document);
            }
        });

        const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
            const active = vscode.window.activeTextEditor;
            if (active && event.document === active.document) {
                this.scheduleScan(event.document);
            }
        });

        const closeListener = vscode.workspace.onDidCloseTextDocument((document) => {
            const file = document.uri.fsPath;
            const hadConflicts = (this.conflictsByFile.get(file) ?? []).length > 0;
            this.conflictsByFile.delete(file);
            Logger.info("GIT CONFLICT SENSOR", {
                "Event": "Document closed",
                "File": file.split(/[\\/]/).pop() || file,
                "Tracked conflicts dropped": hadConflicts ? "Yes" : "No"
            });
        });

        context.subscriptions.push(activeEditorListener, changeListener, closeListener);
    }

    public getConflicts(uri: vscode.Uri): GitConflictBlock[] {
        const cached = this.conflictsByFile.get(uri.fsPath);
        if (cached) {
            return cached;
        }
        const document = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === uri.fsPath);
        if (!document) {
            return [];
        }
        const blocks = parseGitConflictBlocks(document);
        this.conflictsByFile.set(uri.fsPath, blocks);
        return blocks;
    }

    public getConflictAt(uri: vscode.Uri, line: number): GitConflictBlock | undefined {
        const blocks = this.getConflicts(uri);
        return blocks.find((block) =>
            line >= block.startLine - 1 && line <= block.endLine - 1
        );
    }

    private scheduleScan(document: vscode.TextDocument): void {
        this.scanDebouncer.debounce(
            document.uri.fsPath,
            () => this.scanDocument(document),
            CONFLICT_SCAN_DEBOUNCE_MS
        );
    }

    private scanDocument(document: vscode.TextDocument): void {
        const blocks = parseGitConflictBlocks(document);
        const file = document.uri.fsPath;
        const previous = this.conflictsByFile.get(file) ?? [];
        const previousCount = previous.length;

        this.conflictsByFile.set(file, blocks);

        if (blocks.length > 0 && blocks.length !== previousCount) {
            this.publishConflictDetected(document, blocks);
        } else if (blocks.length === 0 && previousCount > 0) {
            this.publishConflictResolved(file, previousCount);
        }
    }

    private publishConflictDetected(document: vscode.TextDocument, blocks: GitConflictBlock[]): void {
        const event: AetherEvent = {
            id: `git-conflict-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: EventType.GIT_CONFLICT_DETECTED,
            timestamp: Date.now(),
            source: "GitConflictSensor",
            payload: {
                File: document.uri.fsPath,
                FileName: document.fileName.split(/[\\/]/).pop() || document.fileName,
                ConflictCount: blocks.length,
                Blocks: blocks
            }
        };
        this.eventFilter.publish(event);
        Logger.info("GIT CONFLICT SENSOR", {
            "Event": "Conflict detected",
            "File": document.fileName.split(/[\\/]/).pop() || document.fileName,
            "Blocks": String(blocks.length),
            "Timestamp": new Date().toISOString()
        });
    }

    private publishConflictResolved(file: string, resolvedCount: number): void {
        const event: AetherEvent = {
            id: `git-conflict-resolved-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: EventType.GIT_CONFLICT_RESOLVED,
            timestamp: Date.now(),
            source: "GitConflictSensor",
            payload: {
                File: file,
                FileName: file.split(/[\\/]/).pop() || file,
                ResolvedCount: resolvedCount
            }
        };
        this.eventFilter.publish(event);
        Logger.info("GIT CONFLICT SENSOR", {
            "Event": "Conflict resolved",
            "File": file.split(/[\\/]/).pop() || file,
            "Resolved": String(resolvedCount),
            "Timestamp": new Date().toISOString()
        });
    }
}
