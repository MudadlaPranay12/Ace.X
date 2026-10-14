import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { AetherEvent } from '../eventFilter/event';
import { Logger } from '../utils/logger';

const IGNORED_URI_SCHEMES = new Set(["output", "vscode", "vscode-userdata", "git"]);

export class CursorSensor {

    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private eventFilter: EventFilter;

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }

    public start(context: vscode.ExtensionContext): void {

        Logger.info("CURSOR SENSOR", {
            "Event": "Started"
        });

        const cursorListener = vscode.window.onDidChangeTextEditorSelection((event) => {

            if (!this.isSourceDocument(event.textEditor.document)) {
                return;
            }

            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
            }

            this.debounceTimer = setTimeout(() => {
                this.publishCursorEvent(event);
            }, 150);
        });

        context.subscriptions.push(cursorListener);
    }

    private isSourceDocument(document: vscode.TextDocument): boolean {
        return !IGNORED_URI_SCHEMES.has(document.uri.scheme);
    }

    private publishCursorEvent(event: vscode.TextEditorSelectionChangeEvent): void {
        const editor = event.textEditor;
        const selection = event.selections[0];
        if (!selection) {return;}

        const cursorLine = selection.active.line;
        const cursorColumn = selection.active.character;
        const file = editor.document.fileName;
        const language = editor.document.languageId;

        const visibleRanges = editor.visibleRanges;
        let relativeLine = 0;
        if (visibleRanges.length > 0) {
            const firstVisible = visibleRanges[0].start.line;
            const lastVisible = visibleRanges[0].end.line;
            if (cursorLine >= firstVisible && cursorLine <= lastVisible) {
                relativeLine = cursorLine - firstVisible;
            } else {
                relativeLine = lastVisible - firstVisible;
            }
        }

        const editorConfig = vscode.workspace.getConfiguration('editor');
        const lineHeight = editorConfig.get<number>('lineHeight') || 20;
        const fontSize = editorConfig.get<number>('fontSize') || 14;
        const charWidth = fontSize * 0.6;
        const relativeY = relativeLine * lineHeight;
        const relativeX = cursorColumn * charWidth;

        const aetherEvent: AetherEvent = {
            id: `cursor-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: EventType.CURSOR_MOVED,
            timestamp: Date.now(),
            source: "CursorSensor",
            payload: {
                File: file,
                Language: language,
                Line: cursorLine + 1,
                Column: cursorColumn + 1,
                relativeX: Math.round(relativeX),
                relativeY: Math.round(relativeY)
            }
        };

        this.eventFilter.publish(aetherEvent);

        Logger.info("CURSOR SENSOR", {
            "Event": "Cursor Moved",
            "File": file.split("\\").pop()?.split("/").pop() || "unknown",
            "Language": language,
            "Line": String(cursorLine + 1),
            "Column": String(cursorColumn + 1)
        });
    }
}
