import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { AetherEvent } from '../eventFilter/event';
import { Logger } from '../utils/logger';

const IDLE_FOCUS_MS = 45000;
const BEGINNER_HINT_IDLE_MS = 20000;

const IGNORED_URI_SCHEMES = new Set(["output", "vscode", "vscode-userdata", "git"]);

const CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "throw"]);

interface FunctionContext {
    name: string;
    startLine: number;
    snippet: string;
}

/**
 * Detects a developer stuck on a single function/block. When the cursor stays
 * on the same enclosing function/block for > 45 seconds while the editor and
 * window are active, a STUCK_IDLE_FOCUS observation is emitted to the
 * Perception Engine.
 *
 * Additionally, if a user is inactive for >20 seconds on an empty line or
 * fresh file, emits a BEGINNER_HINT observation so the AI engine can predict
 * what code the user is trying to write and return a beginner-friendly template.
 */
export class IdleCodeFocusSensor {
    private eventFilter: EventFilter;
    private currentContextKey: string = "";
    private focusStartTime: number = 0;
    private focusTimer: ReturnType<typeof setTimeout> | undefined;
    private beginnerHintTimer: ReturnType<typeof setTimeout> | undefined;
    private beginnerHintStartTime: number = 0;
    private lastBeginnerHintKey: string = "";

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }

    public start(context: vscode.ExtensionContext): void {
        Logger.info("IDLE CODE FOCUS SENSOR", {
            "Event": "Started"
        });

        const selectionListener = vscode.window.onDidChangeTextEditorSelection((event) => {
            this.onSelectionChange(event);
        });
        const editorListener = vscode.window.onDidChangeActiveTextEditor(() => {
            this.reset();
        });
        const windowListener = vscode.window.onDidChangeWindowState((state) => {
            if (!state.focused) {
                this.reset();
            }
        });

        context.subscriptions.push(selectionListener, editorListener, windowListener);
    }

    private onSelectionChange(event: vscode.TextEditorSelectionChangeEvent): void {
        const editor = event.textEditor;
        if (editor !== vscode.window.activeTextEditor) {
            this.reset();
            return;
        }

        const document = editor.document;
        if (!this.isSourceDocument(document)) {
            return;
        }

        const selection = event.selections[0];
        if (!selection) {
            return;
        }

        const key = this.buildContextKey(document, selection.active.line);

        if (key !== this.currentContextKey) {
            this.currentContextKey = key;
            this.focusStartTime = Date.now();
            this.scheduleTimer();
        }

        // Check for empty line / fresh file beginner hint
        this.scheduleBeginnerHint(editor, selection.active.line);
    }

    private scheduleBeginnerHint(editor: vscode.TextEditor, line: number): void {
        if (this.beginnerHintTimer) {
            clearTimeout(this.beginnerHintTimer);
        }

        const document = editor.document;
        const lineText = document.lineAt(line).text.trim();
        const isEmptyLine = lineText === '';
        const isFreshFile = document.lineCount <= 3 && document.getText().trim().length < 20;

        if (!isEmptyLine && !isFreshFile) {
            this.beginnerHintStartTime = 0;
            this.lastBeginnerHintKey = '';
            return;
        }

        const hintKey = `${document.uri.fsPath}:${line}:${isEmptyLine ? 'empty' : 'fresh'}`;
        if (hintKey === this.lastBeginnerHintKey) {
            return;
        }

        this.beginnerHintStartTime = Date.now();
        this.beginnerHintTimer = setTimeout(() => {
            this.beginnerHintTimer = undefined;
            this.checkBeginnerHint(editor, line);
        }, BEGINNER_HINT_IDLE_MS);
    }

    private checkBeginnerHint(editor: vscode.TextEditor, line: number): void {
        if (!vscode.window.state.focused) {
            return;
        }

        const document = editor.document;
        const currentLineText = document.lineAt(line).text.trim();
        if (currentLineText !== '') {
            return;
        }

        const hintKey = `${document.uri.fsPath}:${line}`;
        if (hintKey === this.lastBeginnerHintKey) {
            return;
        }
        this.lastBeginnerHintKey = hintKey;

        const imports = this.extractImports(document);
        const surroundingContext = this.extractSurroundingContext(document, line);

        const event: AetherEvent = {
            id: `beginner-hint-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: EventType.STUCK_IDLE_FOCUS,
            timestamp: Date.now(),
            source: "IdleCodeFocusSensor",
            payload: {
                File: document.fileName,
                Language: document.languageId,
                Line: line + 1,
                Column: 1,
                Function: "",
                FunctionCode: "",
                DurationMs: BEGINNER_HINT_IDLE_MS,
                Reason: "PROACTIVE_BEGINNER_HINT",
                Imports: imports,
                SurroundingContext: surroundingContext,
                IsEmptyLine: true,
                IsFreshFile: document.lineCount <= 3
            }
        };

        this.eventFilter.publish(event);

        Logger.info("IDLE CODE FOCUS SENSOR", {
            "Event": "Beginner Hint Triggered",
            "File": document.fileName.split("\\").pop()?.split("/").pop() || "unknown",
            "Language": document.languageId,
            "Line": String(line + 1)
        });
    }

    private extractImports(document: vscode.TextDocument): string {
        const lines = document.getText().split(/\r?\n/);
        const importLines: string[] = [];
        for (let i = 0; i < Math.min(lines.length, 30); i++) {
            const text = lines[i].trim();
            if (text.startsWith('import ') || text.startsWith('from ') || text.startsWith('require(')) {
                importLines.push(text);
            }
        }
        return importLines.join('\n');
    }

    private extractSurroundingContext(document: vscode.TextDocument, centerLine: number): string {
        const totalLines = document.lineCount;
        const start = Math.max(0, centerLine - 5);
        const end = Math.min(totalLines - 1, centerLine + 5);
        const parts: string[] = [];
        for (let i = start; i <= end; i++) {
            const marker = i === centerLine ? '>>>' : '   ';
            parts.push(`${marker} ${String(i + 1).padStart(4)}: ${document.lineAt(i).text}`);
        }
        return parts.join('\n');
    }

    private scheduleTimer(): void {
        if (this.focusTimer) {
            clearTimeout(this.focusTimer);
        }
        this.focusTimer = setTimeout(() => {
            this.focusTimer = undefined;
            this.checkIdleFocus();
        }, IDLE_FOCUS_MS);
    }

    private checkIdleFocus(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !vscode.window.state.focused || !this.currentContextKey) {
            return;
        }

        const elapsed = Date.now() - this.focusStartTime;
        if (elapsed >= IDLE_FOCUS_MS) {
            this.publishStuck(editor, this.currentContextKey);
            this.focusStartTime = Date.now();
            this.scheduleTimer();
        }
    }

    private publishStuck(editor: vscode.TextEditor, contextKey: string): void {
        const document = editor.document;
        const selection = editor.selection;
        const line = selection.active.line + 1;

        const fnContext = this.extractFunctionContext(document, line);

        const event: AetherEvent = {
            id: `stuck-idle-focus-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: EventType.STUCK_IDLE_FOCUS,
            timestamp: Date.now(),
            source: "IdleCodeFocusSensor",
            payload: {
                File: document.fileName,
                Language: document.languageId,
                Line: line,
                Column: selection.active.character + 1,
                Function: fnContext.name,
                FunctionCode: fnContext.snippet,
                DurationMs: IDLE_FOCUS_MS,
                Reason: "Cursor remained on the same function/block while active"
            }
        };

        this.eventFilter.publish(event);

        Logger.info("IDLE CODE FOCUS SENSOR", {
            "Event": "Stuck Detected (Idle Focus)",
            "File": document.fileName.split("\\").pop()?.split("/").pop() || "unknown",
            "Language": document.languageId,
            "Line": String(line),
            "Function": fnContext.name,
            "DurationMs": String(IDLE_FOCUS_MS)
        });
    }

    private buildContextKey(document: vscode.TextDocument, line: number): string {
        const fnContext = this.extractFunctionContext(document, line + 1);
        return `${document.uri.fsPath}:${fnContext.startLine}:${fnContext.name}`;
    }

    private extractFunctionContext(document: vscode.TextDocument, line: number): FunctionContext {
        const lines = document.getText().split(/\r?\n/);
        const idx = Math.max(0, Math.min(lines.length - 1, line - 1));

        const blockStart = this.findEnclosingBlockStart(lines, idx);
        const startLine = blockStart + 1;
        const name = this.findFunctionName(lines, blockStart);
        const snippet = this.extractBlockSnippet(lines, blockStart);

        return { name, startLine, snippet };
    }

    private findEnclosingBlockStart(lines: string[], idx: number): number {
        let balance = 0;
        for (let i = idx; i >= 0; i--) {
            const opens = (lines[i].match(/{/g) ?? []).length;
            const closes = (lines[i].match(/}/g) ?? []).length;
            balance += opens - closes;
            if (balance > 0) {
                return i;
            }
        }
        return idx;
    }

    private findFunctionName(lines: string[], blockStart: number): string {
        const maxScan = Math.max(0, blockStart - 20);
        for (let i = blockStart; i >= maxScan; i--) {
            const text = lines[i].trim();

            const fn = text.match(/\bfunction\s+([A-Za-z_$][\w$]*)/);
            if (fn) {
                return fn[1];
            }

            const method = text.match(/([A-Za-z_$][\w$]*)\s*\([^)]*\)/);
            if (method && !CONTROL_KEYWORDS.has(method[1]) && (text.includes("{") || text.includes("=>"))) {
                return method[1];
            }
        }
        return `block-${blockStart + 1}`;
    }

    private extractBlockSnippet(lines: string[], blockStart: number): string {
        let openCount = 0;
        let closeIdx = blockStart;
        for (let i = blockStart; i < lines.length; i++) {
            openCount += (lines[i].match(/{/g) ?? []).length;
            openCount -= (lines[i].match(/}/g) ?? []).length;
            if (openCount <= 0) {
                closeIdx = i;
                break;
            }
        }

        const MAX_LINES = 120;
        const start = Math.max(0, blockStart - 1);
        const end = Math.min(lines.length - 1, closeIdx + 1);
        const snippetLines = lines.slice(start, end + 1);

        if (snippetLines.length > MAX_LINES) {
            return snippetLines.slice(0, MAX_LINES).join("\n") + "\n// ... (truncated)";
        }
        return snippetLines.join("\n");
    }

    private isSourceDocument(document: vscode.TextDocument): boolean {
        return !IGNORED_URI_SCHEMES.has(document.uri.scheme);
    }

    private reset(): void {
        if (this.focusTimer) {
            clearTimeout(this.focusTimer);
        }
        this.focusTimer = undefined;
        this.currentContextKey = "";
        this.focusStartTime = 0;
        if (this.beginnerHintTimer) {
            clearTimeout(this.beginnerHintTimer);
        }
        this.beginnerHintTimer = undefined;
        this.beginnerHintStartTime = 0;
    }
}