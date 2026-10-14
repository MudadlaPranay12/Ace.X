import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { AetherEvent } from '../eventFilter/event';
import { Logger } from '../utils/logger';

export class FileSensor {

    private eventFilter: EventFilter;

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }

    public start(context: vscode.ExtensionContext): void {

        Logger.info("FILE SENSOR", {
            "Event": "Started"
        });

        const createListener = vscode.workspace.onDidCreateFiles((event) => {
            for (const file of event.files) {
                const payload: Record<string, string> = {
                    File: file.fsPath.split("\\").pop()?.split("/").pop() || "unknown",
                    Path: file.fsPath
                };
                const ae: AetherEvent = {
                    id: `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    type: EventType.FILE_CREATED,
                    source: 'FileSensor',
                    timestamp: Date.now(),
                    payload
                };
                this.eventFilter.publish(ae);
                Logger.info("FILE SENSOR", {
                    "Event": "File Created",
                    "File": payload.File,
                    "Path": payload.Path,
                    "Timestamp": new Date().toISOString()
                });
            }
        });

        const deleteListener = vscode.workspace.onDidDeleteFiles((event) => {
            for (const file of event.files) {
                const payload: Record<string, string> = {
                    File: file.fsPath.split("\\").pop()?.split("/").pop() || "unknown",
                    Path: file.fsPath
                };
                const ae: AetherEvent = {
                    id: `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    type: EventType.FILE_DELETED,
                    source: 'FileSensor',
                    timestamp: Date.now(),
                    payload
                };
                this.eventFilter.publish(ae);
                Logger.info("FILE SENSOR", {
                    "Event": "File Deleted",
                    "File": payload.File,
                    "Path": payload.Path,
                    "Timestamp": new Date().toISOString()
                });
            }
        });

        const renameListener = vscode.workspace.onDidRenameFiles((event) => {
            for (const file of event.files) {
                const payload: Record<string, string> = {
                    File: file.newUri.fsPath.split("\\").pop()?.split("/").pop() || "unknown",
                    OldPath: file.oldUri.fsPath,
                    Path: file.newUri.fsPath
                };
                const ae: AetherEvent = {
                    id: `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    type: EventType.FILE_RENAMED,
                    source: 'FileSensor',
                    timestamp: Date.now(),
                    payload
                };
                this.eventFilter.publish(ae);
                Logger.info("FILE SENSOR", {
                    "Event": "File Renamed",
                    "File": payload.File,
                    "Path": payload.Path,
                    "Timestamp": new Date().toISOString()
                });
            }
        });

        const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.uri.scheme === "file") {
                const payload: Record<string, string> = {
                    File: document.fileName.split("\\").pop()?.split("/").pop() || "unknown",
                    Path: document.fileName
                };
                const ae: AetherEvent = {
                    id: `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    type: EventType.FILE_SAVED,
                    source: 'FileSensor',
                    timestamp: Date.now(),
                    payload
                };
                this.eventFilter.publish(ae);
                Logger.info("FILE SENSOR", {
                    "Event": "File Saved",
                    "File": payload.File,
                    "Path": payload.Path,
                    "Timestamp": new Date().toISOString()
                });
            }
        });

        context.subscriptions.push(createListener);
        context.subscriptions.push(deleteListener);
        context.subscriptions.push(renameListener);
        context.subscriptions.push(saveListener);
    }
}
