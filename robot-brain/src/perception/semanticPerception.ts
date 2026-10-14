import { ObservationType } from './observationType';
import type { Observation } from './observation';

export type PerceivedActivity =
    | 'CODING_ACTIVITY'
    | 'NAVIGATION'
    | 'COMMUNICATION'
    | 'EXECUTION'
    | 'REVIEW'
    | 'IDLE'
    | 'UNKNOWN';

export type PossibleIntent =
    | 'LEARN'
    | 'BUILD'
    | 'DEBUG'
    | 'EXPLORE'
    | 'RESEARCH'
    | 'ASSIGNMENT'
    | 'PROJECT'
    | 'REVIEW'
    | 'MAINTENANCE'
    | 'UNKNOWN';

export interface PerceivedMeaning {
    observationId: string;
    activity: PerceivedActivity;
    intents: PossibleIntent[];
    patterns: string[];
    struggleSignals: string[];
    state: string;
    confidence: number;
    basis: string[];
}

/**
 * Semantic perception: what a normalized observation means.
 *
 * The engine itself stays a faithful event-to-observation mapper. This layer
 * adds interpretation without editing files or making decisions: activity
 * classification, lightweight intent hypotheses, repeated-failure patterns and
 * behaviour-only struggle signals for agents and ACES to reason over.
 */
export class SemanticPerception {
    private readonly recent: Observation[] = [];
    private readonly capacity = 100;

    interpret(observation: Observation): PerceivedMeaning {
        this.recent.push(observation);
        if (this.recent.length > this.capacity) {
            this.recent.splice(0, this.recent.length - this.capacity);
        }

        const activity = this.activityFor(observation);
        const intents = this.intentsFor(observation, activity);
        const patterns = this.patternsFor(observation);
        const struggleSignals = this.struggleSignalsFor(observation, patterns);
        return {
            observationId: observation.id,
            activity,
            intents,
            patterns,
            struggleSignals,
            state: this.stateFor(observation, patterns),
            confidence: this.confidenceFor(observation, patterns),
            basis: this.basisFor(observation, patterns),
        };
    }

    recentObservations(count = 20): Observation[] {
        return this.recent.slice(Math.max(0, this.recent.length - count));
    }

    private activityFor(observation: Observation): PerceivedActivity {
        switch (observation.type) {
            case ObservationType.DOCUMENT_CHANGED:
            case ObservationType.TYPING_ACTIVITY:
            case ObservationType.CODING_INTENT:
            case ObservationType.DOCUMENT_UNDO:
            case ObservationType.DOCUMENT_REDO:
                return 'CODING_ACTIVITY';
            case ObservationType.CURSOR_MOVED:
            case ObservationType.LINE_NAVIGATED:
            case ObservationType.FILE_OPENED:
            case ObservationType.EDITOR_CHANGED:
                return 'NAVIGATION';
            case ObservationType.USER_INPUT:
            case ObservationType.WEBVIEW_IPC:
                return 'COMMUNICATION';
            case ObservationType.TERMINAL_OPENED:
            case ObservationType.TERMINAL_ACTIVE:
            case ObservationType.TERMINAL_CLOSED:
            case ObservationType.RUNTIME_CRASH:
            case ObservationType.SYSTEM_OUTPUT:
            case ObservationType.DEBUG_STARTED:
            case ObservationType.DEBUG_STOPPED:
            case ObservationType.DEBUG_INTERRUPTION:
                return 'EXECUTION';
            case ObservationType.FILE_SAVED:
            case ObservationType.SUCCESSFUL_CHECKPOINT:
            case ObservationType.GIT_CONFLICT_RESOLVED:
                return 'REVIEW';
            case ObservationType.TYPING_IDLE:
                return 'IDLE';
            default:
                return 'UNKNOWN';
        }
    }

    private intentsFor(observation: Observation, activity: PerceivedActivity): PossibleIntent[] {
        const data = observation.data;
        const command = String(data['Full Line'] ?? data['inputLabel'] ?? data['outputText'] ?? '').toLowerCase();
        if (observation.type === ObservationType.CODING_INTENT) {
            return ['BUILD', 'LEARN'];
        }
        if (
            observation.type === ObservationType.ERROR_DETECTED ||
            observation.type === ObservationType.SYNTAX_ERROR ||
            observation.type === ObservationType.RUNTIME_CRASH ||
            observation.type === ObservationType.DEBUG_INTERRUPTION
        ) {
            return ['DEBUG'];
        }
        if (/\btest\b|\bpytest\b|\bjest\b|\bmocha\b/.test(command)) {
            return ['DEBUG', 'PROJECT'];
        }
        if (/\bbuild\b|\bcompile\b|\btsc\b/.test(command)) {
            return ['BUILD', 'PROJECT'];
        }
        if (activity === 'NAVIGATION') {
            return ['EXPLORE', 'REVIEW'];
        }
        if (activity === 'COMMUNICATION') {
            return ['LEARN', 'REVIEW'];
        }
        if (activity === 'CODING_ACTIVITY') {
            return ['BUILD'];
        }
        return ['UNKNOWN'];
    }

    private patternsFor(observation: Observation): string[] {
        const patterns: string[] = [];
        const window = this.recent.slice(-25);
        const diagnostics = window.filter((entry) =>
            entry.type === ObservationType.ERROR_DETECTED ||
            entry.type === ObservationType.SYNTAX_ERROR ||
            entry.type === ObservationType.DIAGNOSTIC_BATCH
        );
        const saves = window.filter((entry) => entry.type === ObservationType.FILE_SAVED);
        const navigations = window.filter((entry) => entry.type === ObservationType.LINE_NAVIGATED);

        if (observation.type === ObservationType.CODING_INTENT) {
            patterns.push('CODING_INTENT');
        }
        if (
            observation.type === ObservationType.RUNTIME_CRASH ||
            String(observation.data['outputFailed'] ?? '') === 'true' ||
            observation.type === ObservationType.SYSTEM_OUTPUT
        ) {
            patterns.push('EXECUTION_FAILURE');
        }
        if (diagnostics.length >= 3 && saves.length >= 2) {
            patterns.push('POSSIBLE_STRUGGLE_PATTERN');
        }
        if (diagnostics.length >= 3) {
            patterns.push('REPEATED_DIAGNOSTICS');
        }
        if (saves.length >= 4) {
            patterns.push('REPEATED_SAVES');
        }
        if (navigations.length >= 4) {
            patterns.push('REPEATED_NAVIGATION');
        }
        return patterns;
    }

    private struggleSignalsFor(observation: Observation, patterns: string[]): string[] {
        const signals: string[] = [];
        if (patterns.includes('POSSIBLE_STRUGGLE_PATTERN')) {
            signals.push('repeated diagnostics with repeated saves');
        }
        if (patterns.includes('REPEATED_DIAGNOSTICS')) {
            signals.push('same problem keeps reappearing');
        }
        if (observation.type === ObservationType.TYPING_IDLE) {
            signals.push('typing paused');
        }
        return signals;
    }

    private stateFor(observation: Observation, patterns: string[]): string {
        if (patterns.includes('POSSIBLE_STRUGGLE_PATTERN')) {
            return 'POSSIBLE_STRUGGLE';
        }
        if (observation.type === ObservationType.RUNTIME_CRASH) {
            return 'TEST_FAILURE';
        }
        if (observation.type === ObservationType.CODING_INTENT) {
            return 'CODING_ACTIVITY';
        }
        return this.activityFor(observation);
    }

    private confidenceFor(observation: Observation, patterns: string[]): number {
        const patternBoost = Math.min(0.12, patterns.length * 0.04);
        return Math.max(0.1, Math.min(0.98, observation.confidence * 0.9 + patternBoost));
    }

    private basisFor(observation: Observation, patterns: string[]): string[] {
        const basis = [`observation ${observation.type}`];
        for (const pattern of patterns) {
            basis.push(`pattern ${pattern}`);
        }
        return basis;
    }
}
