import type { AcesInput, AcesResult } from './acesTypes';

/**
 * ACES engine — Adaptive Contextual Engineering System.
 *
 * ACES consumes perception output, context snapshots, the user model,
 * workspace/project/team context, learning history and agent findings, then
 * reasons deterministically about what happened, why, who is affected, scope,
 * confidence, user capability, current goal, intervention need, the safest
 * useful action and explanation depth. It never modifies user files; acting is
 * the decision and workflow layers' job.
 */
export class AcesEngine {
    reason(input: AcesInput): AcesResult {
        const { observation, meaning, snapshot, findings, synthesis } = input;
        const userCapability =
            `${snapshot.user.tier} overall; ` +
            `${snapshot.workspace.language || 'general'} at ${snapshot.user.domains[snapshot.workspace.language?.toLowerCase()]?.level ?? snapshot.user.globalLevel}`;
        const interventionNeeded = this.interventionNeeded(synthesis?.recommendedAction);
        const safestUsefulAction = synthesis?.recommendedAction ?? 'OBSERVE';
        const explanationDepth = this.explanationDepth(snapshot, safestUsefulAction);
        const reasoning = {
            whatHappened: `${observation.type} observed in ${snapshot.workspace.file || 'unknown file'}`,
            whatItMeans: `Perceived as ${meaning.activity} (${meaning.state}); patterns: ${meaning.patterns.join(', ') || 'none'}`,
            whyItHappened: synthesis?.rootCause,
            whoIsAffected: synthesis ? `${synthesis.scope} scope` : 'USER scope',
            scope: synthesis?.scope ?? 'USER',
            confidence: synthesis?.confidence ?? meaning.confidence,
            userCapability,
            currentGoal: snapshot.user.task ?? snapshot.user.intent,
            interventionNeeded,
            safestUsefulAction,
            explanationDepth,
        };
        return {
            reasoning,
            recommendedAction: safestUsefulAction,
            confidence: reasoning.confidence,
            summary:
                `${reasoning.scope} ${safestUsefulAction}: ${synthesis?.summary ?? meaning.state} ` +
                `(confidence ${reasoning.confidence.toFixed(2)}, ${findings.length} finding(s))`,
        };
    }

    private interventionNeeded(
        action: AcesResult['recommendedAction'] | undefined
    ): boolean {
        return action === 'EXPLAIN' || action === 'SUGGEST' || action === 'REQUEST_APPROVAL' || action === 'FIX';
    }

    private explanationDepth(
        snapshot: AcesInput['snapshot'],
        action: AcesResult['recommendedAction']
    ): 'SHORT' | 'MEDIUM' | 'DETAILED' {
        if (action === 'EXPLAIN' && (snapshot.user.tier === 'FIRST_YEAR' || snapshot.user.tier === 'BEGINNER')) {
            return 'DETAILED';
        }
        return snapshot.user.interventionPreference === 'MINIMAL' ? 'SHORT' : 'MEDIUM';
    }
}
