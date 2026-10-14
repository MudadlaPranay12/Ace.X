import type { SkillLevel } from '../learning/skillProfile';

export interface ExplanationArtifactContext {
    taskId: string;
    file: string;
    language: string;
    code: string;
    selectedLines?: string;
    lineStart?: number;
    lineEnd?: number;
    diff?: string;
    diagnostic?: { message: string; severity?: string; line?: number };
    recentExplanation?: string;
}

export type ExplanationStyle = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';

export function explanationStyle(skill: SkillLevel): ExplanationStyle {
    return skill === 'BEGINNER' ? 'BEGINNER' : skill === 'INTERMEDIATE' ? 'INTERMEDIATE' : 'ADVANCED';
}

export function isArtifactFollowUp(question: string): boolean {
    return /\b(explain|why|what did you use|why did you use|make (?:it|this) faster|optimi[sz]e|the loop|that line|this line|what changed|common mistake|dry run)\b/i.test(question.trim());
}

export function buildAdaptiveGuidance(skill: SkillLevel): string {
    switch (explanationStyle(skill)) {
        case 'BEGINNER': return 'Explanation style: beginner. Start with what the code does in plain language. Define unfamiliar syntax, show a small concrete dry run, and mention common mistakes. Avoid assuming prior knowledge.';
        case 'INTERMEDIATE': return 'Explanation style: intermediate. Explain key control flow and assumptions, include a brief example, and mention practical correctness or maintainability considerations without over-explaining basic syntax.';
        case 'ADVANCED': return 'Explanation style: advanced. Be concise and focus on correctness, invariants, complexity, trade-offs, edge cases, and maintainability. Do not give beginner material unless requested.';
    }
}

export function buildGroundedContext(context: ExplanationArtifactContext, skill: SkillLevel): string {
    const lines = [buildAdaptiveGuidance(skill), `Grounded artifact task: ${context.taskId}`, `File: ${context.file}`, `Language: ${context.language}`, 'Use only the supplied artifact and metadata. Do not invent lines, edits, execution results, or tests.', `Inserted/current code:\n${context.code.slice(0, 12000)}`];
    if (context.selectedLines) lines.push(`Selected lines/context:\n${context.selectedLines.slice(0, 6000)}`);
    if (context.lineStart !== undefined) lines.push(`Relevant line range: ${context.lineStart}-${context.lineEnd ?? context.lineStart}`);
    if (context.diff) lines.push(`Actual latest diff:\n${context.diff.slice(0, 8000)}`);
    if (context.diagnostic) lines.push(`Diagnostic: ${context.diagnostic.severity ?? 'unknown'} at line ${context.diagnostic.line ?? 'unknown'} — ${context.diagnostic.message}`);
    if (context.recentExplanation) lines.push(`Recent explanation (avoid repeating it unless needed):\n${context.recentExplanation.slice(0, 4000)}`);
    return lines.join('\n');
}

export function missingContextMessage(question: string): string {
    if (/\b(loop|line|code|this|that|it|faster|optimi[sz]e|use)\b/i.test(question)) return 'I need the relevant code to answer that accurately. Open the file and select the code or tell me which file and line you mean.';
    return 'I need a little more context to answer accurately. Tell me which file, code, or recent change you mean.';
}
