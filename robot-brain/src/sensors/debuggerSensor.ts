import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { AetherEvent } from '../eventFilter/event';
import { Logger } from '../utils/logger';

export class DebuggerSensor {
    private eventFilter: EventFilter;

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }

    public start(context: vscode.ExtensionContext): void {
        Logger.info("DEBUGGER SENSOR", { "Event": "Started" });

        const startListener = vscode.debug.onDidStartDebugSession((session) => {
            this.publishEvent(EventType.DEBUG_STARTED, {
                "Configuration": session.name,
                "Type": session.type
            });
            Logger.info("DEBUGGER SENSOR", {
                "Event": "Debug Started",
                "Configuration": session.name
            });
        });

        const stopListener = vscode.debug.onDidTerminateDebugSession((session) => {
            this.publishEvent(EventType.DEBUG_STOPPED, {
                "Configuration": session.name
            });
            Logger.info("DEBUGGER SENSOR", {
                "Event": "Debug Stopped",
                "Configuration": session.name
            });
        });

        const customEventListener = vscode.debug.onDidReceiveDebugSessionCustomEvent((customEvent) => {
            if (this.isBreakpointException(customEvent)) {
                const reason = String(customEvent.body?.reason ?? customEvent.body?.description ?? "exception");
                const line = Number(customEvent.body?.line ?? customEvent.body?.hitLine ?? 0);
                const file = String(customEvent.body?.source?.path ?? customEvent.body?.file ?? "");

                this.publishEvent(EventType.DEBUG_BREAKPOINT_HIT, {
                    "Session": customEvent.session.name,
                    "Reason": reason,
                    "Line": line,
                    "File": file,
                    "Exception": reason,
                    "StackTrace": customEvent.body?.stackTrace ?? ""
                });
                Logger.info("DEBUGGER SENSOR", {
                    "Event": "Breakpoint hit",
                    "Session": customEvent.session.name,
                    "Reason": reason,
                    "Line": String(line)
                });
            }
        });

        context.subscriptions.push(startListener);
        context.subscriptions.push(stopListener);
        context.subscriptions.push(customEventListener);
    }

    private isBreakpointException(customEvent: vscode.DebugSessionCustomEvent): boolean {
        const eligibleEvents = [
            "stopped", "breakpoint", "exception", "entry",
            "paused", "error", "signal"
        ];
        return eligibleEvents.includes(customEvent.event?.toLowerCase() ?? "");
    }

    private publishEvent(type: EventType, payload: Record<string, unknown>): void {
        const event: AetherEvent = {
            id: `debug-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type,
            timestamp: Date.now(),
            source: "DebuggerSensor",
            payload
        };
        this.eventFilter.publish(event);
    }
}
