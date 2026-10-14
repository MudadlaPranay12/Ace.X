/**
 * StruggleDetector — deterministic, camera-free estimate of whether the
 * developer may be stuck.
 *
 * DESIGN RULE (do not violate): this reasons ONLY from coding behaviour visible
 * to VS Code — repeated failures, rapid saves, undo/redo churn, long idle focus
 * after an error, and absence of forward progress. It never infers emotion or
 * affect, and its output must be phrased as "coding-behaviour suggests the
 * developer may be stuck", never "the user is frustrated".
 *
 * The estimate is a small weighted sum over a rolling window with time decay.
 * It is intentionally simple and explainable: every point of `level` is backed
 * by an entry in `evidence`.
 */

export type StruggleSignal =
    | 'ERROR'
    | 'WARNING'
    | 'RAPID_SAVE'
    | 'UNDO_REDO'
    | 'IDLE_FOCUS'
    | 'FAILED_ATTEMPT'
    | 'SWITCHING_FILES'
    | 'TYPING'
    | 'PROGRESS';

export interface StruggleEstimate {
    /** 0 = not struggling, 1 = strongly struggling. */
    level: number;
    evidence: string[];
    confidence: number;
    expiresAt: number;
}

interface SignalEntry {
    signal: StruggleSignal;
    weight: number;
    detail: string;
    at: number;
}

const WINDOW_MS = 120_000;
const ESTIMATE_TTL_MS = 20_000;

const SIGNAL_WEIGHTS: Record<StruggleSignal, number> = {
    ERROR: 0.18,
    WARNING: 0.04,
    RAPID_SAVE: 0.12,
    UNDO_REDO: 0.10,
    IDLE_FOCUS: 0.14,
    FAILED_ATTEMPT: 0.26,
    SWITCHING_FILES: 0.05,
    TYPING: 0,
    PROGRESS: -0.30,
};

const MAX_ENTRIES = 128;

export class StruggleDetector {
    private entries: SignalEntry[] = [];

    /**
     * Records a behavioural signal. `TYPING` and `PROGRESS` are recorded too so
     * that activity and forward progress actively reduce the estimate instead of
     * merely not adding to it.
     */
    record(signal: StruggleSignal, detail = '', now: number = Date.now()): void {
        this.entries.push({ signal, weight: SIGNAL_WEIGHTS[signal], detail, at: now });
        if (this.entries.length > MAX_ENTRIES) {
            this.entries.splice(0, this.entries.length - MAX_ENTRIES);
        }
    }

    evaluate(now: number = Date.now()): StruggleEstimate {
        this.prune(now);

        let level = 0;
        const evidence: string[] = [];
        const detailCounts = new Map<string, number>();

        for (const entry of this.entries) {
            const age = now - entry.at;
            const decay = 1 - age / WINDOW_MS; // 1 → 0 across the window
            const contribution = entry.weight * Math.max(0, decay);
            level += contribution;
            if (entry.detail) {
                detailCounts.set(entry.detail, (detailCounts.get(entry.detail) ?? 0) + 1);
            }
            if (entry.weight > 0 && entry.detail && !evidence.includes(entry.detail)) {
                evidence.push(entry.detail);
            }
        }

        level = Math.max(0, Math.min(1, level));

        // Confidence scales with how much signal we actually have: one weak
        // signal is a weak read, a cluster of failures is a strong one.
        const signalMass = this.entries.reduce((sum, e) => sum + Math.max(0, e.weight), 0);
        const confidence = Math.max(0, Math.min(1, signalMass / 0.5));

        const repeated = [...detailCounts.values()].filter((c) => c >= 2).length;
        if (repeated > 0) {
            evidence.unshift('repeated failed attempts');
        }

        return {
            level: Math.round(level * 100) / 100,
            evidence: evidence.slice(0, 6),
            confidence: Math.round(confidence * 100) / 100,
            expiresAt: now + ESTIMATE_TTL_MS,
        };
    }

    /** Clears all accumulated signals (e.g. after a successful checkpoint). */
    reset(): void {
        this.entries = [];
    }

    private prune(now: number): void {
        const cutoff = now - WINDOW_MS;
        this.entries = this.entries.filter((e) => e.at >= cutoff);
    }
}
