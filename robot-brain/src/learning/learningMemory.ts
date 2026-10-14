import * as vscode from 'vscode';
import {
    SkillProfile,
    SkillLevel,
    calculateSkillLevel,
    getExplanationPreference,
    resolveVerbosity,
} from './skillProfile';

const STORAGE_KEY = 'eilik_user_profile';

function createDefaultProfile(userId: string): SkillProfile {
    return {
        userId,
        skillScore: 25,
        skillLevel: 'BEGINNER',
        preferredExplanationLength: 'DETAILED',
        verbosityMode: 'AUTO',
        acceptedSuggestions: 0,
        ignoredSuggestions: 0,
        lastUpdated: Date.now(),
    };
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export class LearningMemory {
    private readonly context: vscode.ExtensionContext | null;

    constructor(context?: vscode.ExtensionContext) {
        this.context = context ?? null;
    }

    loadProfile(userId: string): SkillProfile {
        if (!this.context) {
            return createDefaultProfile(userId);
        }

        const raw = this.context.globalState.get<string>(STORAGE_KEY);
        if (!raw) {
            return createDefaultProfile(userId);
        }

        try {
            const parsed = JSON.parse(raw) as Partial<SkillProfile>;
            const skillLevel = this.resolveLevel(parsed.skillLevel);
            const profile: SkillProfile = {
                userId: parsed.userId ?? userId,
                skillScore: clamp(parsed.skillScore ?? 25, 0, 100),
                skillLevel,
                preferredExplanationLength: parsed.preferredExplanationLength ?? getExplanationPreference(skillLevel),
                verbosityMode: parsed.verbosityMode ?? 'AUTO',
                acceptedSuggestions: parsed.acceptedSuggestions ?? 0,
                ignoredSuggestions: parsed.ignoredSuggestions ?? 0,
                lastUpdated: parsed.lastUpdated ?? Date.now(),
            };

            if (profile.userId !== userId) {
                profile.userId = userId;
            }

            return profile;
        } catch {
            return createDefaultProfile(userId);
        }
    }

    saveProfile(profile: SkillProfile): void {
        if (!this.context) {
            return;
        }

        profile.skillScore = clamp(profile.skillScore, 0, 100);
        profile.skillLevel = calculateSkillLevel(profile.skillScore);
        // Only auto-update preferredExplanationLength when verbosityMode is AUTO
        if (profile.verbosityMode === 'AUTO') {
            profile.preferredExplanationLength = getExplanationPreference(profile.skillLevel);
        }
        profile.lastUpdated = Date.now();

        try {
            this.context.globalState.update(STORAGE_KEY, JSON.stringify(profile));
        } catch {
            // Silently fail — persistence is best-effort
        }
    }

    private resolveLevel(value: unknown): SkillLevel {
        if (value === 'BEGINNER' || value === 'INTERMEDIATE' || value === 'ADVANCED' || value === 'EXPERT') {
            return value;
        }
        return 'BEGINNER';
    }
}
