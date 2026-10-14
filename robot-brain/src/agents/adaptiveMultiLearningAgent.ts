import type { LearningAgent } from '../learning/learningAgent';
import type { UserModel, UserLearningOutcome } from '../user/userModel';
import type { LocalProjectCoordinator } from '../coordination/projectCoordination';
import { clampConfidence, type AgentFinding, type AgentInput, type SpecializedAgent } from './agentFinding';

export interface InterventionOutcome {
    matter: string;
    accepted: boolean;
    action: 'EXPLAIN' | 'SUGGEST' | 'FIX';
    timestamp: number;
}

export interface LearningSynthesis {
    userUpdated: boolean;
    projectUpdated: boolean;
    teamUpdated: boolean;
    interventionUpdated: boolean;
    notes: string[];
}

/**
 * Adaptive multi-learning agent.
 *
 * This coordinates the existing learning infrastructure across four scopes.
 * User learning updates the progressive UserModel and the existing global
 * LearningAgent. Project/team learning records bounded coordination metadata.
 * Intervention learning tracks accepted and rejected actions. Synthesis
 * combines those signals without ever rewriting a profile from one event.
 */
export class AdaptiveMultiLearningAgent implements SpecializedAgent {
    readonly name = 'learning' as const;
    private readonly learning: LearningAgent;
    private readonly userModel: UserModel;
    private readonly coordinator: LocalProjectCoordinator;
    private readonly interventions: InterventionOutcome[] = [];

    constructor(learning: LearningAgent, userModel: UserModel, coordinator: LocalProjectCoordinator) {
        this.learning = learning;
        this.userModel = userModel;
        this.coordinator = coordinator;
    }

    analyze(input: AgentInput): AgentFinding[] {
        const unresolved = input.snapshot.project.openIssues.length;
        if (unresolved < 3) {
            return [];
        }
        return [
            {
                agent: this.name,
                scope: 'PROJECT',
                category: 'REPEATED_PROJECT_DIFFICULTY',
                severity: 'MEDIUM',
                confidence: clampConfidence(0.7),
                summary: `${unresolved} unresolved project issues are accumulating`,
                evidence: input.snapshot.project.openIssues.slice(0, 5).map((issue) => ({ kind: 'issue', summary: issue })),
                suggestedActions: [
                    { kind: 'SUGGEST', label: 'Review the shared project pattern', reason: 'Several local issues point at the same area.' },
                ],
                learningSignals: [{ domain: 'project', detail: `${unresolved} open project issues` }],
                context: { projectId: input.snapshot.identity.projectId, branch: input.snapshot.identity.branchId },
            },
        ];
    }

    recordUserOutcome(outcome: UserLearningOutcome): LearningSynthesis {
        this.userModel.recordOutcome(outcome);
        if (typeof outcome.success === 'boolean') {
            this.learning.updateSkill(outcome.success);
        }
        return { userUpdated: true, projectUpdated: false, teamUpdated: false, interventionUpdated: false, notes: [`user domain updated`] };
    }

    recordProjectLearning(summary: string, branch?: string): LearningSynthesis {
        this.coordinator.recordEvent({ kind: 'issue', summary, branchId: branch, severity: 'warning', confidence: 0.7 });
        return { userUpdated: false, projectUpdated: true, teamUpdated: false, interventionUpdated: false, notes: ['project pattern recorded'] };
    }

    recordTeamHandoff(file: string, branch?: string): LearningSynthesis {
        this.coordinator.recordEvent({ kind: 'ownership', summary: `handoff for ${file}`, file, branchId: branch, severity: 'info', confidence: 0.8 });
        return { userUpdated: false, projectUpdated: false, teamUpdated: true, interventionUpdated: false, notes: ['team handoff recorded'] };
    }

    recordIntervention(intervention: Omit<InterventionOutcome, 'timestamp'>): LearningSynthesis {
        this.interventions.push({ ...intervention, timestamp: Date.now() });
        if (this.interventions.length > 100) {
            this.interventions.splice(0, this.interventions.length - 100);
        }
        this.userModel.recordOutcome({ acceptedSuggestion: intervention.accepted, success: intervention.accepted });
        const recent = this.interventions.slice(-10);
        const accepted = recent.filter((entry) => entry.accepted).length;
        return {
            userUpdated: true,
            projectUpdated: false,
            teamUpdated: false,
            interventionUpdated: true,
            notes: [`${accepted}/${recent.length} recent interventions accepted`],
        };
    }

    synthesize(): LearningSynthesis {
        return {
            userUpdated: true,
            projectUpdated: true,
            teamUpdated: true,
            interventionUpdated: this.interventions.length > 0,
            notes: [`${this.interventions.length} intervention outcomes retained`],
        };
    }
}
