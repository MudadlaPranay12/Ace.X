import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { Logger } from '../utils/logger';

export type WebviewIpcDirection = 'inbound' | 'outbound';

export interface WebviewIpcHealth {
    inbound: number;
    outbound: number;
    lastInboundAt: number;
    lastOutboundAt: number;
    lastInboundType: string;
    lastOutboundType: string;
}

/**
 * Webview-IPC capability.
 *
 * The canonical robot view owns the transport (`postMessage`). This sensor
 * owns the observation: every Brain-bound message becomes one normalized
 * event, while outbound Brain→view traffic is counted for health without being
 * re-published as a new event. That prevents an observation feedback loop.
 */
export class WebviewIpcSensor {
    private readonly eventFilter: EventFilter;
    private inbound = 0;
    private outbound = 0;
    private lastInboundAt = 0;
    private lastOutboundAt = 0;
    private lastInboundType = '';
    private lastOutboundType = '';

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }

    start(context: vscode.ExtensionContext): void {
        context.subscriptions.push({ dispose: () => this.dispose() });
        Logger.info('WEBVIEW IPC SENSOR', { Event: 'Started' });
    }

    recordInbound(message: Record<string, unknown>): void {
        const type = typeof message['type'] === 'string' ? String(message['type']) : 'UNKNOWN';
        this.inbound += 1;
        this.lastInboundAt = Date.now();
        this.lastInboundType = type;
        this.eventFilter.publish({
            id: `webview-ipc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            type: EventType.WEBVIEW_IPC,
            source: 'WebviewIpcSensor',
            timestamp: this.lastInboundAt,
            payload: {
                Direction: 'inbound',
                MessageType: type,
                PayloadSize: JSON.stringify(message).length,
            },
        });
    }

    recordOutbound(messageType: string): void {
        this.outbound += 1;
        this.lastOutboundAt = Date.now();
        this.lastOutboundType = messageType;
    }

    health(): WebviewIpcHealth {
        return {
            inbound: this.inbound,
            outbound: this.outbound,
            lastInboundAt: this.lastInboundAt,
            lastOutboundAt: this.lastOutboundAt,
            lastInboundType: this.lastInboundType,
            lastOutboundType: this.lastOutboundType,
        };
    }

    dispose(): void {
        this.inbound = 0;
        this.outbound = 0;
        this.lastInboundAt = 0;
        this.lastOutboundAt = 0;
        this.lastInboundType = '';
        this.lastOutboundType = '';
    }
}
