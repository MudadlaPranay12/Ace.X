import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { Logger } from '../utils/logger';

export type SystemOutputKind = 'build' | 'test' | 'runtime' | 'debug';

interface DebugOutput {
    kind: SystemOutputKind;
    text: string;
    session: string;
    category: string;
}

const MAX_TEXT_LENGTH = 2000;

/**
 * System-output capability.
 *
 * Terminal lifecycle and command failure already have a publisher. Debug
 * console output does not, so this sensor listens only for debug-session
 * `output` events and normalizes stdout/stderr/test/build/runtime text. It
 * never duplicates debugger lifecycle events.
 */
export class SystemOutputSensor {
    private readonly eventFilter: EventFilter;

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }

    start(context: vscode.ExtensionContext): void {
        const listener = vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
            this.onDebugEvent(event);
        });
        context.subscriptions.push(listener);
        Logger.info('SYSTEM OUTPUT SENSOR', { Event: 'Started' });
    }

    private onDebugEvent(event: vscode.DebugSessionCustomEvent): void {
        if (event.event.toLowerCase() !== 'output') {
            return;
        }
        const body = (event.body ?? {}) as Record<string, unknown>;
        const text = String(body['output'] ?? '').trim();
        const category = String(body['category'] ?? 'stdout').toLowerCase();
        if (!text || category === 'telemetry') {
            return;
        }
        const output = this.classify(event.session, category, text);
        this.eventFilter.publish({
            id: `system-output-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            type: EventType.SYSTEM_OUTPUT,
            source: 'SystemOutputSensor',
            timestamp: Date.now(),
            payload: {
                Kind: output.kind,
                Category: output.category,
                Session: output.session,
                Text: output.text,
                Failed: category === 'stderr' || /error|failed|exception/i.test(text),
            },
        });
    }

    private classify(session: vscode.DebugSession, category: string, text: string): DebugOutput {
        const configuration = (session.configuration ?? {}) as Record<string, unknown>;
        const haystack = `${String(session.type ?? '')} ${String(configuration['name'] ?? '')} ${text}`.toLowerCase();
        let kind: SystemOutputKind = 'runtime';
        if (/\btest\b|jest|mocha|pytest|unittest|vitest/.test(haystack)) {
            kind = 'test';
        } else if (/\bbuild\b|compile|tsc|webpack|vite build/.test(haystack)) {
            kind = 'build';
        } else if (session.type.toLowerCase().includes('debug')) {
            kind = 'debug';
        }
        return {
            kind,
            text: text.slice(0, MAX_TEXT_LENGTH),
            session: session.name,
            category,
        };
    }
}
