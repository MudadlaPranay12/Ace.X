import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { AetherEvent } from '../eventFilter/event';
import { Logger } from '../utils/logger';

const COMMENT_TRIGGER_PATTERN = /\/\/\s*(TODO|FIX)\s*:\s*(botx)?/i;
const SUPPORTED_LANGUAGES = new Set([
    'typescript', 'typescriptreact', 'javascript', 'javascriptreact',
    'python', 'java'
]);
const SURROUNDING_CONTEXT_LINES = 5;
const TRIGGER_COOLDOWN_MS = 5000;

/**
 * Monitors active editor changes and line cursor positions. When a user types
 * `// TODO: botx` or `// FIX:` in supported language files, extracts the
 * comment text and surrounding 5 lines of code, then routes the payload to
 * the AI explanation engine for an immediate proactive solution.
 */
export class CommentSensor {
    private eventFilter: EventFilter;
    private lastTriggerKey: string = '';
    private lastTriggerTime: number = 0;

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }

    public start(context: vscode.ExtensionContext): void {
        Logger.info("COMMENT SENSOR", { "Event": "Started" });

        const selectionListener = vscode.window.onDidChangeTextEditorSelection((event) => {
            this.onSelectionChange(event);
        });

        const editorListener = vscode.window.onDidChangeActiveTextEditor(() => {
            // Reset on editor switch — no action needed
        });

        context.subscriptions.push(selectionListener, editorListener);
    }

    private onSelectionChange(selectionEvent: vscode.TextEditorSelectionChangeEvent): void {
        const editor = selectionEvent.textEditor;
        if (editor !== vscode.window.activeTextEditor) {
            return;
        }

        const document = editor.document;
        if (!SUPPORTED_LANGUAGES.has(document.languageId)) {
            return;
        }

        const selection = selectionEvent.selections[0];
        if (!selection) {
            return;
        }

        const lineIndex = selection.active.line;
        const lineText = document.lineAt(lineIndex).text;

        const match = COMMENT_TRIGGER_PATTERN.exec(lineText);
        if (!match) {
            return;
        }

        const triggerType = match[1].toUpperCase();
        const hasBotxTag = Boolean(match[2]);
        const triggerKey = `${document.uri.fsPath}:${lineIndex}:${triggerType}`;
        const now = Date.now();

        if (triggerKey === this.lastTriggerKey && now - this.lastTriggerTime < TRIGGER_COOLDOWN_MS) {
            return;
        }
        this.lastTriggerKey = triggerKey;
        this.lastTriggerTime = now;

        const commentText = lineText.replace(/\/\/\s*(TODO|FIX)\s*:\s*(botx)?\s*/i, '').trim();
        const surroundingCode = this.extractSurroundingCode(document, lineIndex);

        const aetherEvent: AetherEvent = {
            id: `comment-trigger-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: EventType.COMMENT_TRIGGER_DETECTED,
            timestamp: Date.now(),
            source: "CommentSensor",
            payload: {
                File: document.fileName,
                Language: document.languageId,
                Line: lineIndex + 1,
                Column: selection.active.character + 1,
                TriggerType: triggerType,
                CommentText: commentText,
                HasBotxTag: hasBotxTag,
                SurroundingCode: surroundingCode
            }
        };

        this.eventFilter.publish(aetherEvent);

        Logger.info("COMMENT SENSOR", {
            "Event": "Trigger detected",
            "Type": triggerType,
            "File": document.fileName.split(/[\\/]/).pop() || document.fileName,
            "Line": String(lineIndex + 1),
            "Comment": commentText.slice(0, 80)
        });
    }

    private extractSurroundingCode(document: vscode.TextDocument, centerLine: number): string {
        const totalLines = document.lineCount;
        const start = Math.max(0, centerLine - SURROUNDING_CONTEXT_LINES);
        const end = Math.min(totalLines - 1, centerLine + SURROUNDING_CONTEXT_LINES);
        const parts: string[] = [];
        for (let i = start; i <= end; i++) {
            const marker = i === centerLine ? '>>>' : '   ';
            parts.push(`${marker} ${String(i + 1).padStart(4)}: ${document.lineAt(i).text}`);
        }
        return parts.join('\n');
    }
}
