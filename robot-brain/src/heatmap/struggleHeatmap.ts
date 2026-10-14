/**
 * StruggleHeatmap — aggregates where (which files / lines) the developer's
 * coding behaviour suggests the most friction, over a rolling window.
 *
 * It is the spatial counterpart to StruggleDetector: the detector answers "is
 * the developer stuck right now", the heatmap answers "which parts of the code
 * repeatedly cause trouble". Both are deterministic and behavioural only.
 */

export interface HeatmapCell {
    file: string;
    line: number;
    /** Decayed friction score. */
    score: number;
    /** Number of raw signals that landed here. */
    hits: number;
    lastAt: number;
}

const DEFAULT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CELLS = 500;

function cellId(file: string, line: number): string {
    return `${file}::${line}`;
}

export class StruggleHeatmap {
    private readonly cells: Map<string, HeatmapCell> = new Map();
    private readonly windowMs: number;

    constructor(windowMs: number = DEFAULT_WINDOW_MS) {
        this.windowMs = Math.max(60_000, windowMs);
    }

    record(file: string, line: number, weight = 1, now: number = Date.now()): void {
        if (!file) {
            return;
        }
        const safeLine = Number.isFinite(line) && line > 0 ? Math.floor(line) : 0;
        const id = cellId(file, safeLine);
        const existing = this.cells.get(id);
        if (existing) {
            existing.score += Math.max(0, weight);
            existing.hits += 1;
            existing.lastAt = now;
        } else {
            this.cells.set(id, {
                file,
                line: safeLine,
                score: Math.max(0, weight),
                hits: 1,
                lastAt: now,
            });
        }
        if (this.cells.size > MAX_CELLS) {
            this.evictWeakest(now);
        }
    }

    getTop(limit: number, now: number = Date.now()): HeatmapCell[] {
        this.decay(now);
        return [...this.cells.values()]
            .filter((c) => c.score > 0)
            .sort((a, b) => b.score - a.score || b.lastAt - a.lastAt)
            .slice(0, Math.max(0, limit))
            .map((c) => ({ ...c }));
    }

    /** A compact human-readable summary for the Learning Summary command. */
    getSummary(limit = 3, now: number = Date.now()): string {
        const top = this.getTop(limit, now);
        if (top.length === 0) {
            return 'No recurring friction recorded yet.';
        }
        return top
            .map((c) => {
                const name = c.file.split(/[\\/]/).pop() || c.file;
                const where = c.line > 0 ? `${name}:${c.line}` : name;
                return `${where} (${c.hits} signals)`;
            })
            .join(', ');
    }

    clear(): void {
        this.cells.clear();
    }

    private decay(now: number): void {
        const cutoff = now - this.windowMs;
        for (const [id, cell] of this.cells) {
            if (cell.lastAt < cutoff) {
                this.cells.delete(id);
                continue;
            }
            const ageRatio = (now - cell.lastAt) / this.windowMs; // 0..1
            cell.score = Math.max(0, cell.score * (1 - ageRatio) + cell.hits * (1 - ageRatio) * 0.1);
        }
    }

    private evictWeakest(now: number): void {
        const sorted = [...this.cells.values()].sort((a, b) => a.score - b.score || a.lastAt - b.lastAt);
        const remove = this.cells.size - MAX_CELLS;
        for (let i = 0; i < remove && i < sorted.length; i++) {
            this.cells.delete(cellId(sorted[i].file, sorted[i].line));
        }
        void now;
    }
}
