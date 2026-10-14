/**
 * TimelineBuffer — a small rolling window (default 60s) of the companion's
 * observations and reactions, used by the "Replay recent debugging timeline"
 * feature.
 *
 * This is local, bounded, in-memory state. It is NOT telemetry and is never
 * uploaded. Entries carry short summaries plus structured data, so a replay can
 * answer concrete questions: what was the first known change before this error,
 * how many times was this same attempt repeated, and when did the error appear.
 */

export type TimelineKind =
    | 'diagnostic'
    | 'edit'
    | 'save'
    | 'cursor'
    | 'command'
    | 'decision'
    | 'gemini'
    | 'attention'
    | 'emotion'
    | 'teaching'
    | 'struggle'
    | 'progress';

export interface TimelineEntry {
    at: number;
    kind: TimelineKind;
    summary: string;
    data?: Record<string, unknown>;
}

export interface TimelineReplay {
    windowStart: number;
    windowEnd: number;
    entries: TimelineEntry[];
    /** The last change before the earliest error in the window, if any. */
    firstChangeBeforeError?: TimelineEntry;
    /** How many repeated failed attempts of the dominant error were seen. */
    repeatedFailedAttempts: number;
    /** When the dominant error first appeared in the window. */
    errorFirstSeen?: number;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_CAPACITY = 400;

export class TimelineBuffer {
    private entries: TimelineEntry[] = [];
    private readonly windowMs: number;
    private readonly capacity: number;

    constructor(windowMs: number = DEFAULT_WINDOW_MS, capacity: number = DEFAULT_CAPACITY) {
        this.windowMs = Math.max(1000, windowMs);
        this.capacity = Math.max(32, capacity);
    }

    record(kind: TimelineKind, summary: string, data?: Record<string, unknown>, now: number = Date.now()): void {
        this.entries.push({ at: now, kind, summary, data });
        this.prune(now);
    }

    getWindow(now: number = Date.now()): TimelineEntry[] {
        this.prune(now);
        return [...this.entries];
    }

    replay(now: number = Date.now()): TimelineReplay {
        const entries = this.getWindow(now);
        const windowStart = now - this.windowMs;

        const diagnostics = entries.filter((e) => e.kind === 'diagnostic');
        const firstError = diagnostics.find((e) => this.isErrorEntry(e));
        const errorFirstSeen = firstError?.at;

        let repeatedFailedAttempts = 0;
        if (firstError) {
            const signature = String(firstError.data?.['signature'] ?? firstError.summary);
            repeatedFailedAttempts = diagnostics.filter(
                (e) => e.kind === 'diagnostic' && String(e.data?.['signature'] ?? e.summary) === signature
            ).length;
            if (repeatedFailedAttempts > 0) {
                repeatedFailedAttempts -= 1; // first occurrence is not a repeat
            }
        }

        let firstChangeBeforeError: TimelineEntry | undefined;
        if (errorFirstSeen !== undefined) {
            for (const entry of entries) {
                if (entry.at > errorFirstSeen) {
                    break;
                }
                if (entry.kind === 'edit' || entry.kind === 'save') {
                    firstChangeBeforeError = entry;
                }
            }
        }

        return {
            windowStart,
            windowEnd: now,
            entries,
            firstChangeBeforeError,
            repeatedFailedAttempts,
            errorFirstSeen,
        };
    }

    clear(): void {
        this.entries = [];
    }

    size(): number {
        return this.entries.length;
    }

    private isErrorEntry(entry: TimelineEntry): boolean {
        return entry.kind === 'diagnostic' && String(entry.data?.['severity'] ?? '').toLowerCase() === 'error';
    }

    private prune(now: number): void {
        const cutoff = now - this.windowMs;
        while (this.entries.length > 0 && this.entries[0].at < cutoff) {
            this.entries.shift();
        }
        if (this.entries.length > this.capacity) {
            this.entries.splice(0, this.entries.length - this.capacity);
        }
    }
}
