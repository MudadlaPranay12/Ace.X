import type { Observation } from '../perception/observation';
import type { PerceivedMeaning } from '../perception/semanticPerception';
import type { AceContextSnapshot } from '../context/contextSnapshot';
import type { AgentFinding } from '../agents/agentFinding';
import type { SynthesizedRecommendation as Synthesis } from '../agents/agentSynthesis';

export interface AcesInput {
    observation: Observation;
    meaning: PerceivedMeaning;
    snapshot: AceContextSnapshot;
    findings: AgentFinding[];
    synthesis?: Synthesis;
}

export interface AcesReasoning {
    whatHappened: string;
    whatItMeans: string;
    whyItHappened?: string;
    whoIsAffected: string;
    scope: 'USER' | 'WORKSPACE' | 'PROJECT' | 'TEAM';
    confidence: number;
    userCapability: string;
    currentGoal?: string;
    interventionNeeded: boolean;
    safestUsefulAction: 'IGNORE' | 'OBSERVE' | 'EXPLAIN' | 'SUGGEST' | 'REQUEST_APPROVAL' | 'FIX' | 'VERIFY';
    explanationDepth: 'SHORT' | 'MEDIUM' | 'DETAILED';
}

export interface AcesResult {
    reasoning: AcesReasoning;
    recommendedAction: AcesReasoning['safestUsefulAction'];
    confidence: number;
    summary: string;
}

export type { Synthesis as SynthesizedRecommendation };
