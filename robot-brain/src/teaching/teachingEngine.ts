/**
 * TeachingEngine — the LEVEL 0..4 hint ladder (deterministic).
 *
 *   0 Silent observation  — notice, teach nothing
 *   1 Nudge               — "There may be a problem around line 42"
 *   2 Hint                — a targeted clue, no full explanation
 *   3 Explanation         — full explanation of the concept
 *   4 Fix                 — show the concrete fix
 *
 * The ladder NEVER jumps straight to a fix. The rung is chosen from the skill
 * profile, how often the same mistake has recurred, how stuck the developer
 * looks, severity, whether they asked directly, and whether an explanation was
 * already shown. Gemini may word a rung's content, but the rung is chosen here.
 */

import type { SkillLevel } from '../learning/skillProfile';
import type { TeachingLevel } from '../core/types';

export interface TeachingRequest {
    /** Stable identity of what is being taught (mistake key / concept). */
    matter: string;
    concept?: string;
    severity: 'error' | 'warning' | 'info';
    /** Decision confidence, 0..1. */
    confidence: number;
    /** How many times this matter has recurred (>= 1 when first seen). */
    recurrence: number;
    /** Struggle estimate, 0..1. */
    struggleLevel: number;
    skillLevel: SkillLevel;
    /** The developer explicitly asked for help. */
    directAsk?: boolean;
    /** An explanation of this matter was already shown recently. */
    explanationSeen?: boolean;
    now?: number;
}

export interface TeachingPlan {
    level: TeachingLevel;
    matter: string;
    concept?: string;
    reason: string;
    recurrence: number;
    skillLevel: SkillLevel;
}

/** Don't re-teach the same matter at the same-or-lower rung inside this window. */
const TEACH_COOLDOWN_MS = 45_000;

/**
 * The facts wording is allowed to use. Every field is optional because a
 * consumer may know less than another: missing facts must degrade the sentence,
 * never be filled in.
 */
export interface WordingInput {
    /** 1-based line the matter is about. */
    line: number;
    /** Concept label, when the caller classified one. */
    concept?: string;
    /** Identifier the diagnostic names, when it names one. */
    symbol?: string;
    /**
     * Whether the identifier is assigned above `line`.
     * `undefined` means "not checked" and suppresses every claim about it.
     */
    assignedBefore?: boolean;
}

interface TeachRecord {
    lastLevel: TeachingLevel;
    lastAt: number;
    timesTaught: number;
}

export class TeachingEngine {
    private readonly records: Map<string, TeachRecord> = new Map();

    plan(request: TeachingRequest): TeachingPlan {
        const now = request.now ?? Date.now();
        const recurrence = Math.max(1, request.recurrence);

        let level = this.baseLevel(request, recurrence);
        level = this.adjustForSkill(level, request.skillLevel);
        level = this.adjustForDirectAsk(level, request);

        // Never jump straight to FIX (4) without either a direct ask or a
        // repeated, high-friction struggle. This is the central guardrail of
        // the ladder: the companion teaches, it does not do the work for you.
        const fixEarned = !!request.directAsk || (recurrence >= 3 && request.struggleLevel >= 0.6);
        if (level >= 4 && !fixEarned) {
            level = 3;
        }

        const record = this.records.get(request.matter);
        if (record && now - record.lastAt < TEACH_COOLDOWN_MS && !request.directAsk) {
            // Already taught this matter recently: do not repeat the same rung.
            if (level <= record.lastLevel) {
                level = Math.min(1, level > 0 ? 1 : 0) as TeachingLevel;
            }
        }

        const plan: TeachingPlan = {
            level: level as TeachingLevel,
            matter: request.matter,
            concept: request.concept,
            recurrence,
            skillLevel: request.skillLevel,
            reason: this.describe(level, request, recurrence),
        };

        if (level > 0) {
            this.records.set(request.matter, {
                lastLevel: level as TeachingLevel,
                lastAt: now,
                timesTaught: (record?.timesTaught ?? 0) + 1,
            });
        }

        return plan;
    }

    /** Suppresses the cooldown for a matter (e.g. after it is resolved). */
    forget(matter: string): void {
        this.records.delete(matter);
    }

    clear(): void {
        this.records.clear();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DETERMINISTIC WORDING
    //
    // The rung is chosen above; the words for the cheap rungs are chosen here,
    // for the same reason: a hint the developer can act on must not depend on a
    // network call. Rungs 3–4 are still worded by the explanation engine.
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * A hint that answers WHY, in one sentence, from facts already known.
     *
     * `assignedBefore` is tri-state on purpose:
     *   false     — the file was readable and no assignment precedes the line
     *   true      — the file was readable and one does
     *   undefined — the file was not available, so nothing is claimed about it
     */
    hintFor(input: WordingInput): string {
        const where = `line ${input.line}`;
        const subject = input.symbol ?? input.concept ?? 'This';

        if (input.symbol) {
            if (input.assignedBefore === false) {
                return `${input.symbol} is used on ${where} before it is assigned.`;
            }
            if (input.assignedBefore === true) {
                return `${input.symbol} is used on ${where} and is assigned later in the file — the value is not ready yet.`;
            }
            return `${input.symbol} is used on ${where} and is not defined at that point.`;
        }

        if (input.concept) {
            return `${subject} issue on ${where}. Try: ${this.takeawayFor(input)}`;
        }

        return `Something is wrong on ${where}. Try: ${this.takeawayFor(input)}`;
    }

    /**
     * One short, educational line tied to the matter that was just resolved.
     * Deliberately not an explanation — the developer already fixed it, so the
     * goal is a rule they can carry to the next occurrence.
     */
    takeawayFor(input: WordingInput): string {
        const concept = (input.concept ?? '').toLowerCase();

        if (concept.includes('import')) {
            return 'Import a module before using what it exports.';
        }
        if (concept.includes('type')) {
            return 'Match the value you assign to the declared type.';
        }
        if (concept.includes('bracket') || concept.includes('brace') || concept.includes('paren')) {
            return 'Close every bracket you open.';
        }
        if (concept.includes('semicolon') || concept.includes('syntax')) {
            return 'Finish each statement before starting the next.';
        }
        if (concept.includes('unused')) {
            return 'Remove code you are not using.';
        }
        if (concept.includes('null') || concept.includes('undefined') || input.symbol) {
            return 'Initialize variables before using them.';
        }
        return 'Define the value before the code that uses it.';
    }

    private baseLevel(request: TeachingRequest, recurrence: number): number {
        // Low-confidence observations stay silent: a guess is not a lesson.
        if (request.confidence < 0.7) {
            return 0;
        }

        let level = 0;
        if (request.severity === 'error') {
            level = 2;
        } else if (request.severity === 'warning') {
            level = 1;
        } else {
            level = 0;
        }

        if (recurrence >= 2) {
            level += 1;
        }
        if (recurrence >= 4) {
            level += 1;
        }
        if (request.struggleLevel >= 0.5) {
            level += 1;
        }
        if (request.struggleLevel >= 0.8) {
            level += 1;
        }

        return level;
    }

    private adjustForSkill(level: number, skill: SkillLevel): number {
        // Beginners need more context (higher rung); experts get terse nudges.
        switch (skill) {
            case 'BEGINNER':
                return level + 1;
            case 'INTERMEDIATE':
                return level;
            case 'ADVANCED':
                return level;
            case 'EXPERT':
                return level - 1;
            default:
                return level;
        }
    }

    private adjustForDirectAsk(level: number, request: TeachingRequest): number {
        if (!request.directAsk) {
            return level;
        }
        // A direct ask is an invitation: explain at least, and if this was
        // already explained, offer the fix.
        let next = Math.max(level, 3);
        if (request.explanationSeen || request.recurrence >= 2) {
            next = 4;
        }
        return next;
    }

    private describe(level: number, request: TeachingRequest, recurrence: number): string {
        const base = `severity=${request.severity} recurrence=${recurrence} struggle=${request.struggleLevel.toFixed(2)} skill=${request.skillLevel}`;
        switch (level) {
            case 0:
                return `silent (${base})`;
            case 1:
                return `nudge (${base})`;
            case 2:
                return `hint (${base})`;
            case 3:
                return `explanation (${base})`;
            default:
                return `fix (${base})`;
        }
    }
}
