/**
 * RecurringMistakes — deterministic memory of mistakes the developer hits more
 * than once.
 *
 * This is NOT an AI feature. It is a small keyed counter. The Brain uses it to
 * decide whether a problem is a one-off (teach nothing) or a pattern (teach the
 * concept, and route to a lower hint rung next time). The concept label is
 * supplied by the deterministic caller — Gemini may word an explanation, but it
 * never decides that a recurrence happened.
 */

export interface MistakeRecord {
    /** Stable identity for the mistake: e.g. `${code}:${normalizedMessage}`. */
    key: string;
    /** Human-readable label used in logs and teaching prompts. */
    label: string;
    /** Concept the mistake belongs to (e.g. "nullability"), if known. */
    concept?: string;
    /** How many distinct times this mistake has been observed. */
    count: number;
    firstSeen: number;
    lastSeen: number;
    /** True once the mistake stopped appearing in a later diagnostic batch. */
    resolved: boolean;
}

const DEFAULT_RECURRING_THRESHOLD = 2;
const MAX_TRACKED = 200;
/** A mistake not seen for this long is considered forgotten (not "recurring"). */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Normalizes a diagnostic message so near-identical messages share a key. */
export function normalizeMistakeMessage(message: string): string {
    return String(message ?? "")
        .toLowerCase()
        .replace(/['"`][^'"`]*['"`]/g, "'X'")
        .replace(/\b\d+\b/g, "N")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
}

export function mistakeKey(code: string | number | undefined, message: string): string {
    const c = code !== undefined && code !== null ? String(code) : "no-code";
    return `${c}:${normalizeMistakeMessage(message)}`;
}

export class RecurringMistakes {
    private readonly records: Map<string, MistakeRecord> = new Map();
    private readonly recurringThreshold: number;

    constructor(recurringThreshold: number = DEFAULT_RECURRING_THRESHOLD) {
        this.recurringThreshold = Math.max(2, recurringThreshold);
    }

    /** Records another occurrence; returns the updated record. */
    record(key: string, label: string, concept?: string, now: number = Date.now()): MistakeRecord {
        const existing = this.records.get(key);
        if (existing) {
            existing.count += 1;
            existing.lastSeen = now;
            existing.resolved = false;
            if (concept) {
                existing.concept = concept;
            }
            return existing;
        }

        const record: MistakeRecord = {
            key,
            label: label || key,
            concept,
            count: 1,
            firstSeen: now,
            lastSeen: now,
            resolved: false,
        };
        this.records.set(key, record);
        this.evictStale(now);
        return record;
    }

    lookup(key: string): MistakeRecord | undefined {
        return this.records.get(key);
    }

    /** Count of how many times this exact mistake has been seen. */
    countFor(key: string): number {
        return this.records.get(key)?.count ?? 0;
    }

    isRecurring(key: string): boolean {
        return this.countFor(key) >= this.recurringThreshold;
    }

    /** Marks a mistake resolved (e.g. its diagnostic signature disappeared). */
    markResolved(key: string, now: number = Date.now()): void {
        const record = this.records.get(key);
        if (record) {
            record.resolved = true;
            record.lastSeen = now;
        }
    }

    /** All currently-unresolved mistakes that have recurred at least twice. */
    getRecurring(now: number = Date.now()): MistakeRecord[] {
        this.evictStale(now);
        return [...this.records.values()]
            .filter((r) => !r.resolved && r.count >= this.recurringThreshold)
            .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
    }

    getTop(limit: number, now: number = Date.now()): MistakeRecord[] {
        return this.getRecurring(now).slice(0, Math.max(0, limit));
    }

    /** How many tracked mistakes stopped appearing — an improvement signal. */
    getResolvedCount(): number {
        let count = 0;
        for (const record of this.records.values()) {
            if (record.resolved) {
                count += 1;
            }
        }
        return count;
    }

    size(): number {
        return this.records.size;
    }

    clear(): void {
        this.records.clear();
    }

    private evictStale(now: number): void {
        if (this.records.size <= MAX_TRACKED) {
            return;
        }
        const sorted = [...this.records.values()].sort((a, b) => a.lastSeen - b.lastSeen);
        const removeCount = this.records.size - MAX_TRACKED;
        for (let i = 0; i < removeCount; i++) {
            const rec = sorted[i];
            if (rec && now - rec.lastSeen > STALE_MS) {
                this.records.delete(rec.key);
            }
        }
    }
}
