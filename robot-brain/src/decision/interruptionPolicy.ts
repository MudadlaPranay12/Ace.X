/**
 * InterruptionPolicy — deterministic "should the companion say anything, and
 * how loudly?" gate.
 *
 * The TeachingEngine decides WHAT rung is appropriate. This policy decides
 * WHETHER to surface it now, given the developer's moment-to-moment state.
 * Separating the two is deliberate: a rung-3 explanation is not always worth an
 * interruption while the user is mid-keystroke or already fixing the problem.
 *
 * Outcomes (ordered by intrusiveness):
 *   SILENT      — do nothing
 *   OBSERVE     — look attentive, say nothing
 *   ACKNOWLEDGE — a brief non-verbal/brief-hold reaction
 *   NUDGE/HINT/EXPLAIN/FIX — speak the corresponding teaching rung
 */

import type { TeachingLevel } from '../core/types';

export type InterruptionOutcome =
    | 'SILENT'
    | 'OBSERVE'
    | 'ACKNOWLEDGE'
    | 'NUDGE'
    | 'HINT'
    | 'EXPLAIN'
    | 'FIX';

export interface InterruptionRequest {
    teachingLevel: TeachingLevel;
    confidence: number;
    severity: 'error' | 'warning' | 'info';
    struggleLevel: number;
    /** The developer is actively typing right now. */
    isTyping: boolean;
    /** Diagnostics changed because the developer is editing against them. */
    userAlreadyFixing: boolean;
    /** The companion interacted very recently. */
    recentlyInteracted: boolean;
    /** Milliseconds left before the interaction cooldown clears. */
    cooldownRemainingMs: number;
    directAsk?: boolean;
    now?: number;
}

export interface InterruptionDecision {
    outcome: InterruptionOutcome;
    reason: string;
    confidence: number;
    /** Whether a caption/speech should be attached to the outcome. */
    speak: boolean;
}

const LEVEL_TO_OUTCOME: Record<TeachingLevel, InterruptionOutcome> = {
    0: 'OBSERVE',
    1: 'NUDGE',
    2: 'HINT',
    3: 'EXPLAIN',
    4: 'FIX',
};

function downgrade(outcome: InterruptionOutcome, steps: number): InterruptionOutcome {
    const order: InterruptionOutcome[] = ['SILENT', 'OBSERVE', 'ACKNOWLEDGE', 'NUDGE', 'HINT', 'EXPLAIN', 'FIX'];
    const idx = order.indexOf(outcome);
    const next = Math.max(0, idx - Math.max(0, steps));
    return order[next];
}

export class InterruptionPolicy {
    decide(request: InterruptionRequest): InterruptionDecision {
        const base: InterruptionOutcome = LEVEL_TO_OUTCOME[request.teachingLevel] ?? 'OBSERVE';

        // A direct ask always wins: the developer explicitly invited an answer.
        if (request.directAsk) {
            return this.finalize(base === 'OBSERVE' ? 'EXPLAIN' : base, 'direct ask', request, true);
        }

        let outcome = base;
        let steps = 0;
        let reason = 'teaching level';

        if (request.userAlreadyFixing) {
            steps = Math.max(steps, 3); // they are already on it — back off hard
            reason = 'developer is already editing against the problem';
        }
        if (request.isTyping) {
            steps = Math.max(steps, outcome === 'FIX' || outcome === 'EXPLAIN' ? 2 : 1);
            reason = 'developer is actively typing';
        }
        if (request.recentlyInteracted || request.cooldownRemainingMs > 0) {
            steps = Math.max(steps, 1);
            reason = 'interaction cooldown active';
        }
        if (request.confidence < 0.75 && outcome !== 'NUDGE') {
            steps = Math.max(steps, 1);
            reason = 'low confidence observation';
        }

        outcome = downgrade(outcome, steps);

        // A soft warning that cannot be spoken becomes a glance, not silence,
        // so the companion still reads as attentive rather than absent.
        if (outcome === 'SILENT' && request.severity !== 'info' && request.struggleLevel >= 0.4) {
            outcome = 'OBSERVE';
            reason += ' + keep attending';
        }

        const speak = outcome === 'NUDGE' || outcome === 'HINT' || outcome === 'EXPLAIN' || outcome === 'FIX';
        return this.finalize(outcome, reason, request, speak);
    }

    private finalize(
        outcome: InterruptionOutcome,
        reason: string,
        request: InterruptionRequest,
        speak: boolean
    ): InterruptionDecision {
        return {
            outcome,
            reason,
            confidence: Math.max(0, Math.min(1, request.confidence)),
            speak: speak && (outcome === 'NUDGE' || outcome === 'HINT' || outcome === 'EXPLAIN' || outcome === 'FIX'),
        };
    }
}
