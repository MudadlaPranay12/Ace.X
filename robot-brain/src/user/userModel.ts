import * as vscode from 'vscode';
import type { SkillLevel } from '../learning/skillProfile';
import type { LearningAgent } from '../learning/learningAgent';
import { Logger } from '../utils/logger';

export type UserIntent =
    | 'LEARN'
    | 'BUILD'
    | 'DEBUG'
    | 'EXPLORE'
    | 'RESEARCH'
    | 'ASSIGNMENT'
    | 'PROJECT'
    | 'REVIEW'
    | 'MAINTENANCE';

export type ExperienceTier =
    | 'FIRST_YEAR'
    | 'BEGINNER'
    | 'INTERMEDIATE'
    | 'ADVANCED'
    | 'EXPERIENCED'
    | 'SENIOR'
    | 'LEAD';

export type InterventionPreference = 'EXPLAIN' | 'SUGGEST' | 'FIX' | 'MINIMAL';

export interface UserLearningOutcome {
    domain?: string;
    concept?: string;
    language?: string;
    file?: string;
    success: boolean;
    acceptedSuggestion?: boolean;
    requestedMoreExplanation?: boolean;
    requestedLessExplanation?: boolean;
    timeToResolutionMs?: number;
}

interface DomainSkill {
    score: number;
    observations: number;
}

interface PersistedUserModel {
    domains: Record<string, DomainSkill>;
    conceptsKnown: string[];
    knowledgeGaps: string[];
    learningGoal?: string;
    currentTask?: string;
    currentIntent?: UserIntent;
    explanationRequests: number;
    acceptedInterventions: number;
    rejectedInterventions: number;
    preferredExamples: string[];
}

const STORAGE_KEY = 'acex_user_model_v1';
const DOMAIN_LEARNING_RATE = 1;
const MAX_CONCEPTS = 100;

function normalizeDomain(value: string | undefined): string {
    const domain = (value ?? '').trim().toLowerCase();
    if (!domain) {
        return 'general';
    }
    if (domain === 'js' || domain === 'jsx') {
        return 'javascript';
    }
    if (domain === 'ts' || domain === 'tsx') {
        return 'typescript';
    }
    if (domain === 'py') {
        return 'python';
    }
    if (domain === 'c++' || domain === 'cxx' || domain === 'cc') {
        return 'cpp';
    }
    if (domain === 'c#') {
        return 'csharp';
    }
    return domain;
}

function scoreToLevel(score: number): SkillLevel {
    if (score <= 30) {
        return 'BEGINNER';
    }
    if (score <= 60) {
        return 'INTERMEDIATE';
    }
    if (score <= 85) {
        return 'ADVANCED';
    }
    return 'EXPERT';
}

/**
 * Progressive skill-specific user model.
 *
 * The global LearningAgent remains the persisted skill/verbosity source. This
 * model adds what the global profile cannot represent: per-language and
 * per-concept mastery, current intent and task, intervention preference and
 * small incremental learning updates. No questionnaire is required; every
 * value is inferred from observed outcomes.
 */
export class UserModel {
    private readonly learning: LearningAgent;
    private readonly context: vscode.ExtensionContext | undefined;
    private state: PersistedUserModel;

    constructor(learning: LearningAgent, context?: vscode.ExtensionContext) {
        this.learning = learning;
        this.context = context;
        this.state = this.load();
    }

    getGlobalLevel(): SkillLevel {
        return this.learning.getSkillLevel();
    }

    getDomainLevel(domain: string): SkillLevel {
        return scoreToLevel(this.domainScore(normalizeDomain(domain)));
    }

    estimateTier(): ExperienceTier {
        const global = this.learning.getProfile();
        const domains = Object.values(this.state.domains);
        const average = domains.length > 0
            ? domains.reduce((total, entry) => total + entry.score, 0) / domains.length
            : global.skillScore;
        if (average <= 20) {
            return 'FIRST_YEAR';
        }
        if (average <= 35) {
            return 'BEGINNER';
        }
        if (average <= 60) {
            return 'INTERMEDIATE';
        }
        if (average <= 80) {
            return 'ADVANCED';
        }
        if (global.acceptedSuggestions >= 25) {
            return 'LEAD';
        }
        return global.skillLevel === 'EXPERT' ? 'EXPERIENCED' : 'ADVANCED';
    }

    setIntent(intent: UserIntent, task?: string): void {
        this.state.currentIntent = intent;
        if (task) {
            this.state.currentTask = task;
        }
        this.save();
    }

    setLearningGoal(goal: string): void {
        this.state.learningGoal = goal;
        this.save();
    }

    preferredIntervention(domain = 'general'): InterventionPreference {
        const total = this.state.acceptedInterventions + this.state.rejectedInterventions;
        const level = this.getDomainLevel(domain);
        if (total >= 5 && this.state.acceptedInterventions * 2 < this.state.rejectedInterventions) {
            return 'MINIMAL';
        }
        if (level === 'BEGINNER') {
            return 'EXPLAIN';
        }
        if (level === 'INTERMEDIATE') {
            return 'SUGGEST';
        }
        return 'FIX';
    }

    preferredExplanationDepth(domain = 'general'): 'SHORT' | 'MEDIUM' | 'DETAILED' {
        if (this.state.explanationRequests >= 3) {
            return 'DETAILED';
        }
        const level = this.getDomainLevel(domain);
        if (level === 'BEGINNER') {
            return 'DETAILED';
        }
        if (level === 'INTERMEDIATE' || level === 'ADVANCED') {
            return 'MEDIUM';
        }
        return 'SHORT';
    }

    recordOutcome(outcome: UserLearningOutcome): void {
        const domain = normalizeDomain(outcome.domain ?? outcome.language ?? this.domainFromFile(outcome.file));
        const skill = this.state.domains[domain] ?? { score: 25, observations: 0 };
        const delta = outcome.success ? DOMAIN_LEARNING_RATE : -DOMAIN_LEARNING_RATE;
        skill.score = Math.max(0, Math.min(100, skill.score + delta));
        skill.observations += 1;
        this.state.domains[domain] = skill;

        if (outcome.concept) {
            const concept = outcome.concept.toLowerCase();
            if (outcome.success) {
                this.remember(this.state.conceptsKnown, concept);
                this.state.knowledgeGaps = this.state.knowledgeGaps.filter((gap) => gap !== concept);
            } else if (!this.state.conceptsKnown.includes(concept)) {
                this.remember(this.state.knowledgeGaps, concept);
            }
        }
        if (outcome.acceptedSuggestion === true) {
            this.state.acceptedInterventions += 1;
        }
        if (outcome.acceptedSuggestion === false) {
            this.state.rejectedInterventions += 1;
        }
        if (outcome.requestedMoreExplanation) {
            this.state.explanationRequests += 1;
        }
        this.save();
        Logger.info('USER MODEL', {
            Event: 'Learning outcome recorded',
            Domain: domain,
            Success: String(outcome.success),
            Score: String(skill.score),
        });
    }

    snapshot(): {
        tier: ExperienceTier;
        globalLevel: SkillLevel;
        intent?: UserIntent;
        task?: string;
        goal?: string;
        domains: Record<string, { level: SkillLevel; score: number; observations: number }>;
        conceptsKnown: string[];
        knowledgeGaps: string[];
        interventionPreference: InterventionPreference;
    } {
        const domains: Record<string, { level: SkillLevel; score: number; observations: number }> = {};
        for (const [domain, skill] of Object.entries(this.state.domains)) {
            domains[domain] = { level: scoreToLevel(skill.score), score: skill.score, observations: skill.observations };
        }
        return {
            tier: this.estimateTier(),
            globalLevel: this.getGlobalLevel(),
            intent: this.state.currentIntent,
            task: this.state.currentTask,
            goal: this.state.learningGoal,
            domains,
            conceptsKnown: [...this.state.conceptsKnown],
            knowledgeGaps: [...this.state.knowledgeGaps],
            interventionPreference: this.preferredIntervention(),
        };
    }

    private domainScore(domain: string): number {
        return this.state.domains[domain]?.score ?? 25;
    }

    private domainFromFile(file?: string): string {
        if (!file) {
            return 'general';
        }
        const extension = file.split('.').pop()?.toLowerCase() ?? '';
        switch (extension) {
            case 'py':
                return 'python';
            case 'java':
                return 'java';
            case 'js':
            case 'jsx':
            case 'mjs':
            case 'cjs':
                return 'javascript';
            case 'ts':
            case 'tsx':
            case 'mts':
            case 'cts':
                return 'typescript';
            case 'sql':
                return 'sql';
            default:
                return 'general';
        }
    }

    private remember(list: string[], value: string): void {
        if (!list.includes(value)) {
            list.push(value);
        }
        if (list.length > MAX_CONCEPTS) {
            list.splice(0, list.length - MAX_CONCEPTS);
        }
    }

    private load(): PersistedUserModel {
        const fallback: PersistedUserModel = {
            domains: {},
            conceptsKnown: [],
            knowledgeGaps: [],
            explanationRequests: 0,
            acceptedInterventions: 0,
            rejectedInterventions: 0,
            preferredExamples: [],
        };
        try {
            const raw = this.context?.globalState.get<string>(STORAGE_KEY);
            if (!raw) {
                return fallback;
            }
            const parsed = JSON.parse(raw) as Partial<PersistedUserModel>;
            return { ...fallback, ...parsed };
        } catch {
            return fallback;
        }
    }

    private save(): void {
        try {
            void this.context?.globalState.update(STORAGE_KEY, JSON.stringify(this.state));
        } catch {
            // Persistence is best-effort; in-memory learning still applies.
        }
    }
}
