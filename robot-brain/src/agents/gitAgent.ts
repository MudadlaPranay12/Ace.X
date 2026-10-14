import * as vscode from 'vscode';
import { ObservationType } from '../perception/observationType';
import { clampConfidence, type AgentFinding, type AgentInput, type SpecializedAgent } from './agentFinding';

interface GitRepositoryState {
    branch?: string;
    commit?: string;
    ahead?: number;
    behind?: number;
    workingTreeChanges?: number;
    mergeChanges?: number;
    message?: string;
}

function readRepositories(): GitRepositoryState[] {
    try {
        const gitExtension = vscode.extensions.getExtension<{ getAPI: (version: number) => unknown }>('vscode.git');
        const api = gitExtension?.exports?.getAPI(1) as
            | { repositories?: Array<{ state?: Record<string, unknown>; log?: (options?: unknown) => Array<{ message?: string }> }> }
            | undefined;
        if (!api?.repositories) {
            return [];
        }
        return api.repositories.map((repository) => {
            const state = (repository.state ?? {}) as Record<string, unknown>;
            const head = (state['HEAD'] ?? {}) as Record<string, unknown>;
            let message: string | undefined;
            try {
                const log = repository.log?.({ maxEntries: 1 });
                message = log?.[0]?.message;
            } catch {
                message = undefined;
            }
            return {
                branch: typeof head['name'] === 'string' ? String(head['name']) : undefined,
                commit: typeof head['commit'] === 'string' ? String(head['commit']) : undefined,
                ahead: typeof head['ahead'] === 'number' ? Number(head['ahead']) : undefined,
                behind: typeof head['behind'] === 'number' ? Number(head['behind']) : undefined,
                workingTreeChanges: Array.isArray(state['workingTreeChanges']) ? state['workingTreeChanges'].length : undefined,
                mergeChanges: Array.isArray(state['mergeChanges']) ? state['mergeChanges'].length : undefined,
                message,
            };
        });
    } catch {
        return [];
    }
}

/**
 * Git agent: branches, commits, diffs, merges, conflicts, remote status and
 * uncommitted changes. Missing Git integration yields no finding rather than
 * a guessed repository state.
 */
export class GitAgent implements SpecializedAgent {
    readonly name = 'git' as const;

    analyze(input: AgentInput): AgentFinding[] {
        const { observation, snapshot } = input;
        if (
            observation.type !== ObservationType.GIT_BRANCH_CHANGED &&
            observation.type !== ObservationType.GIT_REPOSITORY_CHANGED &&
            observation.type !== ObservationType.GIT_CONFLICT_DETECTED &&
            observation.type !== ObservationType.GIT_CONFLICT_RESOLVED &&
            observation.type !== ObservationType.SUCCESSFUL_CHECKPOINT
        ) {
            return [];
        }
        const repositories = readRepositories();
        if (repositories.length === 0) {
            return [];
        }
        const findings: AgentFinding[] = [];
        for (const repository of repositories.slice(0, 5)) {
            const conflicts = repository.mergeChanges ?? 0;
            const uncommitted = repository.workingTreeChanges ?? 0;
            const severity = conflicts > 0 ? 'HIGH' : uncommitted > 10 ? 'MEDIUM' : 'INFO';
            findings.push({
                agent: this.name,
                scope: conflicts > 0 ? 'PROJECT' : 'WORKSPACE',
                category: conflicts > 0 ? 'MERGE_CONFLICT' : 'REPOSITORY_STATE',
                severity,
                confidence: clampConfidence(observation.confidence * 0.9),
                summary: conflicts > 0
                    ? `Merge conflict on ${repository.branch ?? 'unknown branch'}`
                    : `${uncommitted} uncommitted change(s) on ${repository.branch ?? 'unknown branch'}`,
                evidence: [
                    { kind: 'branch', summary: repository.branch ?? 'unknown branch' },
                    ...(typeof repository.ahead === 'number' || typeof repository.behind === 'number'
                        ? [{ kind: 'remote', summary: `ahead ${repository.ahead ?? 0}, behind ${repository.behind ?? 0}` }]
                        : []),
                    ...(repository.message ? [{ kind: 'commit', summary: repository.message.slice(0, 200) }] : []),
                ],
                possibleCause: conflicts > 0 ? 'Two branches changed overlapping content.' : undefined,
                suggestedActions: conflicts > 0
                    ? [
                        { kind: 'EXPLAIN', label: 'Explain the conflicting change', reason: 'Conflicts need understanding before resolution.' },
                        { kind: 'SUGGEST', label: 'Suggest a resolution order', reason: 'Untracked merging can lose work.' },
                    ]
                    : [{ kind: 'OBSERVE', label: 'Repository state recorded', reason: 'No Git intervention is warranted.' }],
                learningSignals: [
                    {
                        domain: 'git',
                        concept: conflicts > 0 ? 'merge conflicts' : 'repository hygiene',
                        detail: `branch ${repository.branch ?? 'unknown'}`,
                    },
                ],
                context: {
                    branch: repository.branch ?? snapshot.identity.branchId,
                    projectId: snapshot.identity.projectId,
                },
            });
        }
        return findings;
    }
}
