import { ContextType } from '../context/contextType';
import type { Context } from '../context/context';
import type { AcesResult } from '../aces/acesTypes';
import { DecisionType } from './decisionType';

export interface MappedAcesDecision {
    type: DecisionType;
    confidence: number;
    reason: string;
    data: Record<string, unknown>;
}

/**
 * Maps an ACES recommendation onto the existing decision vocabulary.
 *
 * REQUEST_APPROVAL becomes ASK_USER and FIX requests become approval-gated
 * suggestions: the Brain explains first and only the explicit fix workflow may
 * apply edits. VERIFY becomes WAIT with a verification flag for the existing
 * diagnostic verification loop.
 */
export function mapAcesToDecision(context: Context, result: AcesResult): MappedAcesDecision {
    const baseData: Record<string, unknown> = {
        acesAction: result.recommendedAction,
        acesSummary: result.summary,
        acesConfidence: result.confidence,
        acesScope: result.reasoning.scope,
    };
    switch (result.recommendedAction) {
        case 'IGNORE':
            return { type: DecisionType.DO_NOTHING, confidence: result.confidence, reason: result.summary, data: baseData };
        case 'OBSERVE':
        case 'VERIFY':
            return { type: DecisionType.WAIT, confidence: result.confidence, reason: result.summary, data: baseData };
        case 'EXPLAIN':
            return {
                type: context.type === ContextType.USER_STUCK_ON_ERROR || context.type === ContextType.FIXING_COMPILER_ERROR
                    ? DecisionType.SHOW_ERROR_HELP
                    : DecisionType.SHOW_HINT,
                confidence: result.confidence,
                reason: result.summary,
                data: baseData,
            };
        case 'SUGGEST':
            return { type: DecisionType.SHOW_HINT, confidence: result.confidence, reason: result.summary, data: baseData };
        case 'REQUEST_APPROVAL':
        case 'FIX':
            return { type: DecisionType.ASK_USER, confidence: result.confidence, reason: result.summary, data: baseData };
        default:
            return { type: DecisionType.WAIT, confidence: result.confidence, reason: result.summary, data: baseData };
    }
}
