export type SkillLevel = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' | 'EXPERT';

export type ExplanationLength = 'SHORT' | 'MEDIUM' | 'DETAILED';

export type VerbosityMode = 'AUTO' | 'CONCISE' | 'BALANCED' | 'DETAILED';

export interface SkillProfile {
    userId: string;
    skillScore: number;
    skillLevel: SkillLevel;
    preferredExplanationLength: ExplanationLength;
    verbosityMode: VerbosityMode;
    acceptedSuggestions: number;
    ignoredSuggestions: number;
    lastUpdated: number;
}

export function calculateSkillLevel(score: number): SkillLevel {
    if (score <= 30) {return 'BEGINNER';}
    if (score <= 60) {return 'INTERMEDIATE';}
    if (score <= 85) {return 'ADVANCED';}
    return 'EXPERT';
}

export function getExplanationPreference(level: SkillLevel): ExplanationLength {
    switch (level) {
        case 'BEGINNER':
            return 'DETAILED';
        case 'INTERMEDIATE':
            return 'MEDIUM';
        case 'ADVANCED':
            return 'MEDIUM';
        case 'EXPERT':
            return 'SHORT';
    }
}

export function resolveVerbosity(verbosityMode: VerbosityMode, skillLevel: SkillLevel): ExplanationLength {
    if (verbosityMode !== 'AUTO') {
        switch (verbosityMode) {
            case 'CONCISE': return 'SHORT';
            case 'BALANCED': return 'MEDIUM';
            case 'DETAILED': return 'DETAILED';
        }
    }
    return getExplanationPreference(skillLevel);
}
