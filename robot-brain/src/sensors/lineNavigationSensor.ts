import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import type { AetherEvent } from '../eventFilter/event';
import { EventType } from '../eventFilter/eventTypes';
import { Logger } from '../utils/logger';

interface NavigationPoint {
    file: string;
    line: number;
    column: number;
    timestamp: number;
}

interface NavigationTrailEntry extends NavigationPoint {
    kind: 'file-switch' | 'large-jump';
    lineDelta: number;
}

const LARGE_JUMP_LINES = 30;
const NAVIGATION_SETTLE_MS = 750;
const MAX_TRAIL_ENTRIES = 20;

/**
 * Line-navigation capability.
 *
 * This is the only publisher of LINE_NAVIGATED. It does not add another raw
 * cursor listener: it derives semantically significant navigation from the
 * already-normalized cursor/editor stream. Small caret motion stays cursor
 * noise; file switches and large settled jumps become navigation.
 */
export class LineNavigationSensor {
    private readonly eventFilter: EventFilter;
    private readonly trail: NavigationTrailEntry[] = [];
    private lastPoint: NavigationPoint | undefined;
    private settleTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly filterListener = (event: AetherEvent): void => {
        this.onFilteredEvent(event);
    };

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }

    start(context: vscode.ExtensionContext): void {
        this.eventFilter.subscribe(this.filterListener);
        context.subscriptions.push({ dispose: () => this.dispose() });
        Logger.info('LINE NAVIGATION SENSOR', { Event: 'Started' });
    }

    getRecentTrail(): NavigationTrailEntry[] {
        return [...this.trail];
    }

    dispose(): void {
        if (this.settleTimer) {
            clearTimeout(this.settleTimer);
            this.settleTimer = undefined;
        }
        this.eventFilter.unsubscribe(this.filterListener);
    }

    private onFilteredEvent(event: AetherEvent): void {
        if (
            event.type !== EventType.CURSOR_MOVED &&
            event.type !== EventType.EDITOR_ACTIVE &&
            event.type !== EventType.EDITOR_SWITCHED
        ) {
            return;
        }
        const payload = event.payload as Record<string, unknown> | undefined;
        const file = String(payload?.['File'] ?? '');
        const line = Number(payload?.['Line'] ?? 0);
        const column = Number(payload?.['Column'] ?? 0);
        if (!file || !Number.isFinite(line) || line <= 0) {
            return;
        }
        const current: NavigationPoint = { file, line, column, timestamp: Date.now() };
        const previous = this.lastPoint;
        this.lastPoint = current;
        if (!previous) {
            return;
        }

        if (current.file !== previous.file) {
            this.publishNavigation(current, previous, 'file-switch', Math.abs(current.line - previous.line));
            return;
        }

        const lineDelta = Math.abs(current.line - previous.line);
        if (lineDelta < LARGE_JUMP_LINES) {
            return;
        }

        if (this.settleTimer) {
            clearTimeout(this.settleTimer);
        }
        this.settleTimer = setTimeout(() => {
            this.settleTimer = undefined;
            this.publishNavigation(current, previous, 'large-jump', lineDelta);
        }, NAVIGATION_SETTLE_MS);
    }

    private publishNavigation(
        current: NavigationPoint,
        previous: NavigationPoint,
        kind: NavigationTrailEntry['kind'],
        lineDelta: number
    ): void {
        this.trail.push({ ...current, kind, lineDelta });
        if (this.trail.length > MAX_TRAIL_ENTRIES) {
            this.trail.splice(0, this.trail.length - MAX_TRAIL_ENTRIES);
        }
        this.eventFilter.publish({
            id: `navigation-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            type: EventType.LINE_NAVIGATED,
            source: 'LineNavigationSensor',
            timestamp: Date.now(),
            payload: {
                File: current.file,
                FromLine: previous.line,
                ToLine: current.line,
                Line: current.line,
                Column: current.column,
                LineDelta: lineDelta,
                Kind: kind,
            },
        });
        Logger.info('LINE NAVIGATION SENSOR', {
            Event: kind === 'file-switch' ? 'File navigation' : 'Large line jump',
            File: current.file.split(/[\\/]/).pop() || current.file,
            Line: String(current.line),
            Delta: String(lineDelta),
        });
    }
}
