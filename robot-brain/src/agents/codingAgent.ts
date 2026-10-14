import { ObservationType } from '../perception/observationType';
import { clampConfidence, type AgentFinding, type AgentInput, type SpecializedAgent } from './agentFinding';

function implementationRisk(message: string): 'LOW' | 'MEDIUM' {
    return /delete|remove|drop|migration|schema|production/.test(message.toLowerCase()) ? 'MEDIUM' : 'LOW';
}

/**
 * Coding agent: natural-language intent, syntax/structure observations and
 * learning situations. It never generates code here; it decides what kind of
 * teaching or assistance an intent needs for this particular developer.
 */
export class CodingAgent implements SpecializedAgent {
    readonly name = 'coding' as const;

    analyze(input: AgentInput): AgentFinding[] {
        const { observation, snapshot } = input;
        if (observation.type !== ObservationType.CODING_INTENT) {
            return [];
        }
        const data = observation.data;
        const intentText = String(data['IntentText'] ?? '').slice(0, 500);
        const language = String(data['Language'] ?? snapshot.workspace.language ?? 'general');
        const line = Number(data['Line'] ?? 0);
        const confidence = Number(data['Confidence'] ?? observation.confidence);
        const domainLevel = snapshot.user.domains[language.toLowerCase()]?.level ?? snapshot.user.globalLevel;
        const teachingFirst = domainLevel === 'BEGINNER' || snapshot.user.tier === 'FIRST_YEAR';
        const risk = implementationRisk(intentText);

        return [
            {
                agent: this.name,
                scope: 'USER',
                category: 'CODING_INTENT',
                severity: 'MEDIUM',
                confidence: clampConfidence(confidence),
                summary: intentText ? `Coding request: ${intentText}` : 'Coding intent detected',
                evidence: [
                    { kind: 'comment', summary: intentText || 'intent comment', line: line > 0 ? line : undefined },
                    { kind: 'language', summary: `language ${language}` },
                ],
                possibleCause: undefined,
                suggestedActions: teachingFirst
                    ? [
                        { kind: 'EXPLAIN', label: 'Teach the requested construct first', reason: 'Beginner profile needs the concept before code.' },
                        { kind: 'SUGGEST', label: 'Offer a small starter example', reason: 'A short example preserves learning while unblocking.' },
                    ]
                    : [
                        { kind: 'SUGGEST', label: 'Offer a concise implementation sketch', reason: 'Experienced profile needs leverage, not a lesson.' },
                        ...(risk === 'MEDIUM'
                            ? [{ kind: 'REQUEST_APPROVAL' as const, label: 'Confirm before generating a risky change', reason: 'Intent affects existing behavior.' }]
                            : []),
                    ],
                learningSignals: [
                    {
                        domain: language,
                        concept: 'natural-language coding intent',
                        detail: `intent confidence ${confidence}`,
                    },
                ],
                context: {
                    file: snapshot.workspace.file || undefined,
                    line: line > 0 ? line : undefined,
                    language,
                    branch: snapshot.identity.branchId,
                    projectId: snapshot.identity.projectId,
                },
            },
        ];
    }
}
