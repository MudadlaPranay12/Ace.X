import * as vscode from 'vscode';
import {
    SkillProfile,
    SkillLevel,
    ExplanationLength,
    VerbosityMode,
    calculateSkillLevel,
    getExplanationPreference,
    resolveVerbosity,
} from './skillProfile';
import { LearningMemory } from './learningMemory';
import { LearningPublisher } from './learningPublisher';
import { Logger } from '../utils/logger';

const DEFAULT_USER_ID = 'default';

const UPDATE_INC = 2;
const UPDATE_DEC = 1;

export class LearningAgent {
    private profile: SkillProfile;
    private readonly memory: LearningMemory;
    private readonly publisher: LearningPublisher;

    constructor(context?: vscode.ExtensionContext) {
        this.memory = new LearningMemory(context);
        this.profile = this.memory.loadProfile(DEFAULT_USER_ID);
        this.publisher = new LearningPublisher();
        Logger.info("LEARNING", {
            "Event": "Profile loaded",
            "Score": String(this.profile.skillScore),
            "Level": this.profile.skillLevel,
            "Explanation mode": this.profile.preferredExplanationLength
        });
    }

    getProfile(): SkillProfile {
        return { ...this.profile };
    }

    getSkillLevel(): SkillLevel {
        return this.profile.skillLevel;
    }

    getExplanationPreference(): ExplanationLength {
        return this.profile.preferredExplanationLength;
    }

    getVerbosityMode(): VerbosityMode {
        return this.profile.verbosityMode;
    }

    setVerbosityMode(mode: VerbosityMode): void {
        this.profile.verbosityMode = mode;
        // If AUTO, recalculate preferredExplanationLength from skill level
        if (mode === 'AUTO') {
            this.profile.preferredExplanationLength = getExplanationPreference(this.profile.skillLevel);
        } else {
            this.profile.preferredExplanationLength = resolveVerbosity(mode, this.profile.skillLevel);
        }
        this.memory.saveProfile(this.profile);
        Logger.info("LEARNING", {
            "Event": "Verbosity mode changed",
            "Mode": mode,
            "Explanation length": this.profile.preferredExplanationLength
        });
    }

    getEffectiveVerbosity(): ExplanationLength {
        return resolveVerbosity(this.profile.verbosityMode, this.profile.skillLevel);
    }

    getPublisher(): LearningPublisher {
        return this.publisher;
    }

    updateSkill(success: boolean): void {
        const prevScore = this.profile.skillScore;
        if (success) {
            this.profile.skillScore = Math.min(100, this.profile.skillScore + UPDATE_INC);
            this.profile.acceptedSuggestions += 1;
        } else {
            this.profile.skillScore = Math.max(0, this.profile.skillScore - UPDATE_DEC);
            this.profile.ignoredSuggestions += 1;
        }

        this.profile.skillLevel = calculateSkillLevel(this.profile.skillScore);
        // An explicit verbosity mode must survive a skill change — only AUTO
        // derives the explanation length from the skill level.
        if (this.profile.verbosityMode === 'AUTO') {
            this.profile.preferredExplanationLength = getExplanationPreference(this.profile.skillLevel);
        }

        this.memory.saveProfile(this.profile);
        Logger.info("LEARNING", {
            "Event": success ? "Skill increased" : "Skill decreased",
            "Score": String(this.profile.skillScore),
            "Level": this.profile.skillLevel,
            "Explanation mode": this.profile.preferredExplanationLength
        });

        this.publisher.publish({
            type: success ? 'SKILL_INCREASE' : 'SKILL_DECREASE',
            detail: `Score: ${prevScore} -> ${this.profile.skillScore} | Level: ${this.profile.skillLevel}`,
            value: this.profile.skillScore,
            timestamp: Date.now()
        });
    }

    resetProfile(): void {
        this.profile = {
            userId: DEFAULT_USER_ID,
            skillScore: 25,
            skillLevel: 'BEGINNER',
            preferredExplanationLength: 'DETAILED',
            verbosityMode: 'AUTO',
            acceptedSuggestions: 0,
            ignoredSuggestions: 0,
            lastUpdated: Date.now(),
        };
        this.memory.saveProfile(this.profile);
        Logger.info("LEARNING", {
            "Event": "Profile reset",
            "Score": String(this.profile.skillScore),
            "Level": this.profile.skillLevel
        });
    }
}
