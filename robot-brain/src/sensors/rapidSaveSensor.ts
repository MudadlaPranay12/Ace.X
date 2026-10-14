import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { AetherEvent } from '../eventFilter/event';
import { Logger } from '../utils/logger';

const RAPID_SAVE_THRESHOLD = 3;
const RAPID_SAVE_WINDOW_MS = 30000;

/**
 * Detects a developer struggling with a logic bug by watching for rapid,
 * repeated saves of the active document. When a file is saved >= 3 times
 * within a 30-second window, a STUCK_RAPID_SAVE observation is emitted to
 * the Perception Engine.
 */
export class RapidSaveSensor {
    private eventFilter: EventFilter;
    private savesByFile: Map<string, number[]> = new Map();
    private lastTriggerAt: Map<string, number> = new Map();

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }

    public start(context: vscode.ExtensionContext): void {
        Logger.info("RAPID SAVE SENSOR", {
            "Event": "Started"
        });

        const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.uri.scheme !== "file") {
                return;
            }
            this.recordActiveSave(document);
        });

        context.subscriptions.push(saveListener);
    }

    private recordActiveSave(document: vscode.TextDocument): void {
        const active = vscode.window.activeTextEditor;
        if (!active || active.document.uri.toString() !== document.uri.toString()) {
            return;
        }

        const file = document.fileName;
        const now = Date.now();

        const saves = (this.savesByFile.get(file) ?? []).filter(
            (ts) => now - ts <= RAPID_SAVE_WINDOW_MS
        );
        saves.push(now);
        this.savesByFile.set(file, saves);

        const lastTrigger = this.lastTriggerAt.get(file) ?? 0;
        if (saves.length >= RAPID_SAVE_THRESHOLD && now - lastTrigger >= RAPID_SAVE_WINDOW_MS) {
            this.lastTriggerAt.set(file, now);
            this.savesByFile.set(file, []);
            this.publishStuck(document, saves.length);
        }
    }

    private publishStuck(document: vscode.TextDocument, saveCount: number): void {
        const event: AetherEvent = {
            id: `stuck-rapid-save-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: EventType.STUCK_RAPID_SAVE,
            timestamp: Date.now(),
            source: "RapidSaveSensor",
            payload: {
                File: document.fileName,
                Language: document.languageId,
                SaveCount: saveCount,
                Reason: "Active document saved repeatedly in a short window"
            }
        };

        this.eventFilter.publish(event);

        Logger.info("RAPID SAVE SENSOR", {
            "Event": "Stuck Detected (Rapid Save)",
            "File": document.fileName.split("\\").pop()?.split("/").pop() || "unknown",
            "Language": document.languageId,
            "Saves": String(saveCount),
            "Timestamp": new Date().toISOString()
        });
    }
}