import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { AetherEvent } from '../eventFilter/event';
import { Logger } from '../utils/logger';

const IGNORED_URI_SCHEMES = new Set(["output", "vscode", "vscode-userdata", "git"]);

export class EditorSensor {

    private eventFilter: EventFilter;

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }

    public start(context: vscode.ExtensionContext): void {

        Logger.info("EDITOR SENSOR", {
            "Event": "Started"
        });

        if (vscode.window.activeTextEditor) {
            this.publishEditorEvent("Editor Active", vscode.window.activeTextEditor);
        }

        const activeEditorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && this.isSourceDocument(editor.document)) {
                this.publishEditorEvent("Switched Editor", editor);
            }
        });

        const openDocumentListener = vscode.workspace.onDidOpenTextDocument((document) => {
            if (this.isSourceDocument(document)) {
                this.publishOpenEvent(document);
            }
        });

        context.subscriptions.push(activeEditorListener);
        context.subscriptions.push(openDocumentListener);
    }

    private isSourceDocument(document: vscode.TextDocument): boolean {
        return !IGNORED_URI_SCHEMES.has(document.uri.scheme);
    }

    private publishEditorEvent(eventName: string, editor: vscode.TextEditor): void {
        const event: AetherEvent = {
            id: `editor-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: eventName === "Editor Active" ? EventType.EDITOR_ACTIVE : EventType.EDITOR_SWITCHED,
            timestamp: Date.now(),
            source: "EditorSensor",
            payload: {
                File: editor.document.fileName,
                Language: editor.document.languageId
            }
        };

        this.eventFilter.publish(event);

        Logger.info("EDITOR SENSOR", {
            "Event": eventName,
            "File": editor.document.fileName.split("\\").pop()?.split("/").pop() || "unknown",
            "Language": editor.document.languageId,
            "Path": editor.document.fileName,
            "Timestamp": new Date().toISOString()
        });
    }

    private publishOpenEvent(document: vscode.TextDocument): void {
        const event: AetherEvent = {
            id: `editor-open-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: EventType.EDITOR_OPENED,
            timestamp: Date.now(),
            source: "EditorSensor",
            payload: {
                File: document.fileName,
                Language: document.languageId
            }
        };

        this.eventFilter.publish(event);

        Logger.info("EDITOR SENSOR", {
            "Event": "Opened File",
            "File": document.fileName.split("\\").pop()?.split("/").pop() || "unknown",
            "Language": document.languageId,
            "Path": document.fileName,
            "Timestamp": new Date().toISOString()
        });
    }
}
