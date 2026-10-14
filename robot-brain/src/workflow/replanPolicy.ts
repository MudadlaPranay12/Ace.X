export const MAX_REPLAN_ATTEMPTS = 2;

export interface ReplanState {
    issueKey: string;
    sourceVersion: number;
    attempts: number;
    failureEvidence: string;
}

export function beginReplan(state: ReplanState | undefined, input: { issueKey: string; sourceVersion: number; failureEvidence: string }): { state?: ReplanState; reason?: string } {
    if (state && state.issueKey === input.issueKey && state.sourceVersion === input.sourceVersion && state.attempts >= MAX_REPLAN_ATTEMPTS) {
        return { reason: `Replan limit reached (${MAX_REPLAN_ATTEMPTS}). Review the current diagnostic and make a new request after gathering new evidence.` };
    }
    const attempts = state && state.issueKey === input.issueKey && state.sourceVersion === input.sourceVersion ? state.attempts + 1 : 1;
    return { state: { ...input, attempts } };
}

export function resetReplan(): undefined { return undefined; }
