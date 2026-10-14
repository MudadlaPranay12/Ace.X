import { SkillProfile, SkillLevel, ExplanationLength } from './skillProfile';

const LEVEL_INSTRUCTIONS: Record<SkillLevel, string> = {
    BEGINNER: [
        'You are mentoring a BEGINNER developer. Use DETAILED step-by-step reasoning.',
        'Explain EVERY concept — do not assume the user knows what a variable, function, or type is.',
        'Structure your response in these sections:',
        '1. WHAT WENT WRONG: Explain the error in plain English with an analogy if possible.',
        '2. WHY IT HAPPENED: Break down the root cause step by step.',
        '3. HOW TO FIX IT: Provide the exact code replacement with line numbers.',
        '4. LEARNING TIP: A brief note about the concept to help them learn.',
        'Use encouraging language. Never skip steps. Be patient and thorough.',
    ].join(' '),
    INTERMEDIATE: [
        'You are mentoring an INTERMEDIATE developer.',
        'State the architectural diagnostic failure precisely.',
        'Provide the replacement code block or terminal command immediately.',
        'Include a brief (1 sentence) explanation of WHY the fix works.',
        'Zero conversational fluff — but do not skip the reasoning entirely.',
    ].join(' '),
    ADVANCED: [
        'You are working with an ADVANCED developer.',
        'Give a one-line dense technical root-cause assessment.',
        'Follow immediately with a clean diff code snippet or terminal command.',
        'No conversational filler. No step-by-step breakdown.',
    ].join(' '),
    EXPERT: [
        'You are working with an EXPERT developer.',
        'Output ONLY: a one-line root-cause assessment followed by the exact terminal command or unified diff.',
        'No explanations. No reasoning. No conversational text.',
        'Format: [ROOT CAUSE]\n[COMMAND/DIFF]',
    ].join(' '),
};

const LENGTH_INSTRUCTIONS: Record<ExplanationLength, string> = {
    SHORT: 'Keep the answer to one or two short sentences — the reader asked for CONCISE explanations.',
    MEDIUM: 'Keep the answer to a short paragraph: the cause, the fix, and one sentence of why — the reader asked for BALANCED explanations.',
    DETAILED: 'Explain in depth: what went wrong, why it happens, and the fix step by step — the reader asked for DETAILED explanations.',
};

export class VocabularyAdapter {
    /**
     * Skill level AND effective verbosity, so the prompt carries both WHO is
     * being addressed and HOW MUCH to write. `preferredExplanationLength` is
     * the resolved verbosity (botx.verbosity, with AUTO derived from skill),
     * which is what makes the setting reach prompt construction.
     */
    static buildPromptModifier(profile: SkillProfile): string {
        const instruction = [
            LEVEL_INSTRUCTIONS[profile.skillLevel],
            LENGTH_INSTRUCTIONS[profile.preferredExplanationLength],
        ].join(' ');
        console.log(`[VOCABULARY ADAPTER] Applied: ${profile.skillLevel} / ${profile.preferredExplanationLength} explanation profile (score: ${profile.skillScore})`);
        return instruction;
    }
}
