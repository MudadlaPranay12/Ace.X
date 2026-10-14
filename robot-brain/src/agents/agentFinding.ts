import type { Observation } from '../perception/observation';
import type { PerceivedMeaning } from '../perception/semanticPerception';
import type { AceContextSnapshot } from '../context/contextSnapshot';

export type AgentName = 'debug' | 'coding' | 'workspace' | 'git' | 'extension' | 'learning';
export type AgentScope = 'USER' | 'WORKSPACE' | 'PROJECT' | 'TEAM';
export type FindingSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface AgentEvidence {
    kind: string;
    summary: string;
    file?: string;
    line?: number;
}

export interface SuggestedAction {
    kind: 'EXPLAIN' | 'SUGGEST' | 'REQUEST_APPROVAL' | 'FIX' | 'OBSERVE' | 'VERIFY';
    label: string;
    reason: string;
}

export interface LearningSignal {
    domain?: string;
    concept?: string;
    success?: boolean;
    acceptedSuggestion?: boolean;
    detail: string;
}

/**
 * One structured agent finding. Agents return evidence and bounded suggested
 * actions, never arbitrary prose alone. Scope says who is affected; severity
 * and confidence say how strongly the evidence supports action.
 */
export interface AgentFinding {
    agent: AgentName;
    scope: AgentScope;
    category: string;
    severity: FindingSeverity;
    confidence: number;
    summary: string;
    evidence: AgentEvidence[];
    possibleCause?: string;
    suggestedActions: SuggestedAction[];
    learningSignals: LearningSignal[];
    context: {
        file?: string;
        line?: number;
        language?: string;
        branch?: string;
        projectId?: string;
    };
}

export interface AgentInput {
    observation: Observation;
    meaning: PerceivedMeaning;
    snapshot: AceContextSnapshot;
    now?: number;
}

export interface SpecializedAgent {
    readonly name: AgentName;
    analyze(input: AgentInput): AgentFinding[];
}

export function clampConfidence(value: number): number {
    if (!Number.isFinite(value)) {
        return 0.5;
    }
    return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}
