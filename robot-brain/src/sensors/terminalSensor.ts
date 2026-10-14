import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { AetherEvent } from '../eventFilter/event';
import { Logger } from '../utils/logger';

export class TerminalSensor {
    private eventFilter: EventFilter;

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }

    public start(context: vscode.ExtensionContext): void {
        Logger.info("TERMINAL SENSOR", { "Event": "Started" });

        const openListener = vscode.window.onDidOpenTerminal((terminal) => {
            const name = terminal.name;
            this.publishEvent(EventType.TERMINAL_OPENED, { "Terminal Name": name });
        });

        const closeListener = vscode.window.onDidCloseTerminal((terminal) => {
            this.publishEvent(EventType.TERMINAL_CLOSED, { "Terminal Name": terminal.name });
        });

        const activeListener = vscode.window.onDidChangeActiveTerminal((terminal) => {
            if (terminal) {
                this.publishEvent(EventType.TERMINAL_ACTIVE, { "Terminal Name": terminal.name });
            }
        });

        const NON_CRITICAL_EXIT_CODES = new Set([1, 130, 141]);

        const execEndListener = vscode.window.onDidEndTerminalShellExecution((event) => {
            const exitCode = event.exitCode;
            const commandLine = event.execution.commandLine.value;
            const terminalName = event.terminal.name;

            if (exitCode !== undefined && exitCode !== 0 && !NON_CRITICAL_EXIT_CODES.has(exitCode)) {
                this.publishEvent(EventType.TERMINAL_COMMAND_FAILED, {
                    "Terminal Name": terminalName,
                    "Error Snippet": `exit code ${exitCode}`,
                    "Full Line": commandLine
                });
                Logger.info("TERMINAL SENSOR", {
                    "Event": "Command Failed",
                    "Terminal": terminalName,
                    "Exit Code": exitCode
                });
            }
        });

        context.subscriptions.push(openListener);
        context.subscriptions.push(closeListener);
        context.subscriptions.push(activeListener);
        context.subscriptions.push(execEndListener);
    }

    private publishEvent(type: EventType, payload: Record<string, unknown>): void {
        const event: AetherEvent = {
            id: `terminal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type,
            timestamp: Date.now(),
            source: "TerminalSensor",
            payload
        };
        this.eventFilter.publish(event);
    }
}
