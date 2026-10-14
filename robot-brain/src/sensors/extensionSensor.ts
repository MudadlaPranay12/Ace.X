
import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { AetherEvent } from '../eventFilter/event';
import { Logger } from '../utils/logger';

export class ExtensionSensor {

    public static isExtensionInstalled(extensionId: string): boolean {
        const ext = vscode.extensions.getExtension(extensionId);
        return ext !== undefined;
    }

    private knownExtensions: Map<string, boolean> = new Map();
    private eventFilter: EventFilter;

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }
    
    
    public start(context: vscode.ExtensionContext): void {

        Logger.info("EXTENSION SENSOR", {
            "Event": "Started"
        });

        this.snapshotExtensions();

        const changeListener = vscode.extensions.onDidChange(() => {
            this.detectChanges();
        });

        context.subscriptions.push(changeListener);
    }

    private publish(eventType: EventType, ext: vscode.Extension<unknown>, isActive: boolean): void {
        const ae: AetherEvent = {
            id: `ext-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: eventType,
            source: 'ExtensionSensor',
            timestamp: Date.now(),
            payload: {
                ExtensionId: ext.id,
                ExtensionName: ext.packageJSON?.displayName || ext.packageJSON?.name || ext.id,
                Active: isActive ? "Yes" : "No"
            }
        };
        this.eventFilter.publish(ae);
    }

    private snapshotExtensions(): void {
        for (const ext of vscode.extensions.all) {
            this.knownExtensions.set(ext.id, ext.isActive);
        }
        Logger.info("EXTENSION SENSOR", {
            "Event": "Snapshot complete",
            "Count": String(vscode.extensions.all.length)
        });
    }

    private detectChanges(): void {
        const current = new Map<string, boolean>();

        for (const ext of vscode.extensions.all) {
            current.set(ext.id, ext.isActive);
        }

        for (const [id, isActive] of current) {
            if (!this.knownExtensions.has(id)) {
                const ext = vscode.extensions.all.find((e) => e.id === id)!;
                this.publish(EventType.EXTENSION_INSTALLED, ext, isActive);
                Logger.info("EXTENSION SENSOR", {
                    "Event": "Extension Installed",
                    "Extension ID": id,
                    "Extension Name": ext?.packageJSON?.displayName || ext?.packageJSON?.name || id,
                    "Active": isActive ? "Yes" : "No",
                    "Timestamp": new Date().toISOString()
                });
            }
        }

        for (const [id] of this.knownExtensions) {
            if (!current.has(id)) {
                const ae: AetherEvent = {
                    id: `ext-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    type: EventType.EXTENSION_UNINSTALLED,
                    source: 'ExtensionSensor',
                    timestamp: Date.now(),
                    payload: {
                        ExtensionId: id
                    }
                };
                this.eventFilter.publish(ae);
                Logger.info("EXTENSION SENSOR", {
                    "Event": "Extension Uninstalled",
                    "Extension ID": id,
                    "Timestamp": new Date().toISOString()
                });
            }
        }

        for (const [id, wasActive] of this.knownExtensions) {
            if (current.has(id)) {
                const isActive = current.get(id) as boolean;
                if (wasActive !== isActive) {
                    const ext = vscode.extensions.all.find((e) => e.id === id)!;
                    const eventType = isActive ? EventType.EXTENSION_ENABLED : EventType.EXTENSION_DISABLED;
                    this.publish(eventType, ext, isActive);
                    Logger.info("EXTENSION SENSOR", {
                        "Event": isActive ? "Extension Enabled" : "Extension Disabled",
                        "Extension ID": id,
                        "Timestamp": new Date().toISOString()
                    });
                }
            }
        }

        this.knownExtensions = current;
    }
}
