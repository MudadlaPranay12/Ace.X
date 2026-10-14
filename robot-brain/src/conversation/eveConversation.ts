import type { SkillLevel } from '../learning/skillProfile';

/**
 * Eve's per-turn conversational context.
 *
 * This is a transient view assembled from existing stores — CompanionLoop
 * snapshot (issue, diagnostics, teaching, resolution), UserModel snapshot
 * (skill, intent, goal), project identity, last decision, robot body state
 * and recent user inputs. It creates no second memory and no second issue
 * tracker: every field is read, never written, and the object is rebuilt
 * fresh for each turn so a new issue can never leak into an old context.
 */
export interface EveConversationContext {
    /** Stable matter key of the active issue, if any. */
    matter?: string;
    concept?: string;
    symbol?: string;
    file?: string;
    /** 1-based. */
    line?: number;
    column?: number;
    language?: string;
    severity?: string;
    message?: string;
    currentTask?: string;
    currentIntent?: string;
    userGoal?: string;
    skillLevel?: SkillLevel;
    projectId?: string;
    branchId?: string;
    lastDecision?: string;
    lastVerification?: string;
    bodyState?: string;
    recentFeedback?: string[];
}

export interface IssueTarget {
    file?: string;
    /** 1-based line, when known. */
    line?: number;
    matter?: string;
    message?: string;
}

export interface TargetDiagnostic {
    message: string;
    /** 0-based line, VS Code convention. */
    line: number;
    severity: string;
}

/**
 * Selects which diagnostic an Explain/Fix action must operate on.
 *
 * Preference order, all deterministic: the exact requested line (errors
 * before warnings) → the requested matter/message → the first error →
 * nothing (-1), which callers treat as "no matching diagnostic" rather than
 * silently acting on an unrelated one. A stale popup (diagnostic gone) can
 * therefore never trigger work on a different problem.
 *
 * @returns index into `diagnostics`, or -1 when nothing matches.
 */
export function selectTargetDiagnostic(
    diagnostics: readonly TargetDiagnostic[],
    target?: IssueTarget
): number {
    if (diagnostics.length === 0) {
        return -1;
    }
    if (target?.line !== undefined && target.line > 0) {
        const wanted = target.line - 1;
        const atLine = diagnostics
            .map((diagnostic, index) => ({ diagnostic, index }))
            .filter(({ diagnostic }) => diagnostic.line === wanted);
        if (atLine.length > 0) {
            const error = atLine.find(({ diagnostic }) => diagnostic.severity === 'Error');
            return (error ?? atLine[0]).index;
        }
        return -1;
    }
    if (target?.matter || target?.message) {
        const needle = `${target.matter ?? ''} ${target.message ?? ''}`.toLowerCase();
        const hit = diagnostics.findIndex(
            (diagnostic) =>
                needle.includes(diagnostic.message.toLowerCase()) ||
                diagnostic.message.toLowerCase().includes((target.message ?? '').toLowerCase())
        );
        if (hit >= 0) {
            return hit;
        }
        return -1;
    }
    return 0;
}

/**
 * Two-line framing that binds a free-form question to the active issue, so
 * the model answers about THIS problem instead of chatting generally. Kept
 * deliberately short — Eve must sound like a companion reacting, not a
 * chatbot reciting context.
 */
export function buildIssuePromptPrefix(input: {
    file?: string;
    line?: number;
    message?: string;
    concept?: string;
    skillLevel?: SkillLevel;
}): string {
    const where = input.file && input.line ? `${input.file.split(/[\\/]/).pop()}:${input.line}` : 'the current issue';
    const what = input.message ? ` — ${input.message.slice(0, 200)}` : '';
    const depth = input.skillLevel === 'BEGINNER' ? 'Explain simply and concretely.' : 'Be concise.';
    return `Current issue (${where})${what}\nAnswer about THIS issue. ${depth}`;
}

/** Thank-you / understood signals that mark gentle learning progress. */
const ACKNOWLEDGMENT_PATTERN =
    /^(oh,?\s+)?(thanks?,?\s+)?(i\s+(understand|see|get\s+it)|got\s+it|thanks?(\s+you)?|thank\s+you|that\s+makes\s+sense|clear\s+now|makes\s+sense)[.!]*$/i;

export function isAcknowledgment(text: string): boolean {
    return ACKNOWLEDGMENT_PATTERN.test(text.trim());
}

/**
 * One human sentence describing the most recent applied change, or undefined
 * when there is nothing real to describe. Built only from the recorded
 * verification outcome — never invented.
 */
export function describeLastChange(input: {
    verified: boolean;
    takeaway: string;
    change?: string;
    fileName?: string;
    line?: number;
} | null | undefined): string | undefined {
    if (!input) {
        return undefined;
    }
    const where = input.fileName && input.line ? ` in ${input.fileName}:${input.line}` : '';
    if (input.verified && input.change) {
        return `I changed${where}: ${input.change} ${input.takeaway}`;
    }
    if (input.verified) {
        return `The fix${where} is verified. ${input.takeaway}`;
    }
    return undefined;
}

/**
 * Assembles one turn's context from already-existing snapshots. Pure join,
 * no storage: callers pass what they have and receive a single read-only
 * view for prompt framing and intent routing.
 */
export function buildEveConversationContext(input: {
    matter?: string;
    concept?: string;
    symbol?: string;
    file?: string;
    line?: number;
    column?: number;
    language?: string;
    severity?: string;
    message?: string;
    currentTask?: string;
    currentIntent?: string;
    userGoal?: string;
    skillLevel?: SkillLevel;
    projectId?: string;
    branchId?: string;
    lastDecision?: string;
    lastVerification?: string;
    bodyState?: string;
    recentFeedback?: string[];
}): EveConversationContext {
    return { ...input };
}
