import type { AetherEvent } from './event';
import { EventType } from './eventTypes';

/**
 * Centralized synchronous debounce for high-frequency, low-information events.
 *
 * This complements sensor-level debounce: individual sensors still suppress
 * their own most immediate repeats, while the filter protects downstream
 * reasoning from cross-sensor cursor, typing and navigation storms. The check
 * is time-based rather than timer-based, so no startup or processing delays
 * are introduced.
 */
export class EventDebouncer {
    private readonly lastSeen = new Map<string, number>();

    /** Returns true when the event should be dropped as debounce noise. */
    shouldDrop(event: AetherEvent, now: number = Date.now()): boolean {
        const windowMs = this.windowFor(event.type);
        if (windowMs <= 0) {
            return false;
        }
        const key = this.keyFor(event);
        const previous = this.lastSeen.get(key);
        this.lastSeen.set(key, now);
        return previous !== undefined && now - previous < windowMs;
    }

    clear(): void {
        this.lastSeen.clear();
    }

    private windowFor(type: EventType): number {
        switch (type) {
            case EventType.CURSOR_MOVED:
                return 120;
            case EventType.TYPING_ACTIVITY:
                return 200;
            case EventType.DOCUMENT_CHANGED:
                return 150;
            case EventType.LINE_NAVIGATED:
                return 750;
            case EventType.EDITOR_ACTIVE:
            case EventType.EDITOR_SWITCHED:
                return 250;
            case EventType.FILE_SAVED:
                return 400;
            default:
                return 0;
        }
    }

    private keyFor(event: AetherEvent): string {
        const payload = event.payload as Record<string, unknown> | undefined;
        const file = String(payload?.['File'] ?? payload?.['Path'] ?? '');
        const line = String(payload?.['Line'] ?? '');
        return `${event.type}|${event.source}|${file}|${line}`;
    }
}
