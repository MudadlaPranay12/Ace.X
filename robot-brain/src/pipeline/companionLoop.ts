/**
 * CompanionLoop — the OBSERVE → UNDERSTAND → DECIDE-WHETHER-TO-INTERRUPT →
 * EXPRESS → TEACH → LEARN orchestrator.
 *
 * This is a deterministic coordinator, not a second brain. It consumes the
 * existing pipeline's observations and decisions and coordinates the new
 * companion subsystems:
 *
 *   - RecurringMistakes     "has this happened before?"
 *   - StruggleDetector      "is the developer stuck right now?"
 *   - StruggleHeatmap       "where does trouble keep happening?"
 *   - TeachingEngine        "which hint rung is appropriate?"
 *   - InterruptionPolicy    "is now the right moment?"
 *   - AttentionTracker      "what should the Body look toward?"
 *   - TimelineBuffer        "what just happened?" (60s replay)
 *   - CommunicationMode     caption (default) vs optional TTS
 *
 * Design rules:
 *   - Deterministic code decides; Gemini only words explanations.
 *   - The Body is never told to do something the Brain has not decided.
 *   - "Stuck" is phrased as coding-behaviour, never inferred emotion.
 */

import { ObservationType } from '../perception/observationType';
import type { Observation } from '../perception/observation';
import { DecisionType } from '../decision/decisionType';
import type { Decision } from '../decision/decision';
import { mistakeKey, RecurringMistakes } from '../learning/recurringMistakes';
import { StruggleDetector } from '../struggle/struggleDetector';
import { StruggleHeatmap } from '../heatmap/struggleHeatmap';
import { TeachingEngine, type TeachingPlan, type WordingInput } from '../teaching/teachingEngine';
import { InterruptionPolicy, type InterruptionOutcome } from '../decision/interruptionPolicy';
import {
    AttentionTracker,
    attentionFromCursor,
    attentionFromDiagnostic,
    type AttentionInput,
} from '../attention/attentionTarget';
import { TimelineBuffer, type TimelineEntry, type TimelineReplay } from '../timeline/timelineBuffer';
import { buildWhatChanged, extractIdentifier, isAssignedBefore, type WhatChangedReport } from '../timeline/whatChanged';
import { CommunicationMode, captionHoldMs } from '../communication/communicationMode';
import { sendToRobot } from '../utils/websocketServer';
import { BehaviourAction } from '../behaviour/behaviourAction';
import { emitEmotion } from '../behaviour/emotionMapper';
import { Logger } from '../utils/logger';
import type { TeachingLevel, TeachingStatePayload, StruggleStatePayload } from '../core/types';
import type { SkillLevel } from '../learning/skillProfile';
import type { LearningAgent } from '../learning/learningAgent';

/** Don't treat a repeated interaction as "just now" past this window. */
const DEFAULT_INTERACTION_COOLDOWN_MS = 20_000;
/** Recent enough that "is the developer typing right now?" is answered by activity. */
const TYPING_ACTIVE_MS = 2_500;
/** An explicit user question is never gated — it is what the user wants. */
const DIRECT_ASK_RELEVANT_MS = 90_000;
/** Don't re-buy the same explanation for the same mistake. */
const REPEAT_EXPLANATION_SUPPRESS_MS = 300_000;
/**
 * How long an explicit request protects the output channel while the answer is
 * still in flight. Matches the Gemini chat timeout (20 s) plus margin, so a
 * slow answer cannot be pre-empted by a passive frame and a lost answer cannot
 * latch protection forever.
 */
const EXPLICIT_IN_FLIGHT_MS = 30_000;
/**
 * Edits are recorded into the 60s timeline at most once per burst, so a fast
 * typist cannot push the diagnostic out of the window that "What Changed?" reads.
 */
const EDIT_RECORD_DEBOUNCE_MS = 1200;
/**
 * How long an applied fix may wait for the diagnostics to answer before Eve
 * admits she cannot confirm it. Long enough for a language server to re-analyse
 * and publish, short enough that the developer is not left waiting.
 */
const FIX_VERIFICATION_TIMEOUT_MS = 10_000;

const TEACHING_ACTION_NAMES: Record<TeachingLevel, string> = {
    0: 'Silent',
    1: 'Nudge',
    2: 'Hint',
    3: 'Explain',
    4: 'Fix',
};

function struggleLabel(level: number): string {
    if (level >= 0.5) {
        return 'HIGH';
    }
    if (level >= 0.2) {
        return 'MEDIUM';
    }
    return 'LOW';
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** Diagnostic codes arrive as string, number or nothing at all. */
function codeOf(value: unknown): string | number | undefined {
    return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function str(data: Record<string, unknown>, ...keys: string[]): string {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === 'string' && value) {
            return value;
        }
    }
    return '';
}

function num(data: Record<string, unknown>, ...keys: string[]): number {
    for (const key of keys) {
        const value = Number(data[key]);
        if (Number.isFinite(value)) {
            return value;
        }
    }
    return 0;
}

/** Host bridge: the live text of a file, when the host happens to have it open. */
export type SourceTextReader = (file: string) => string | undefined;

/** What the AI spend gate needs to know about one diagnostic. */
export interface ExplainGateRequest {
    matter: string;
    concept?: string;
    severity: 'error' | 'warning';
    confidence: number;
    recurrence?: number;
    now?: number;
}

/** The diagnostic a freshly applied fix is expected to remove. */
export interface FixVerificationInput {
    code?: string | number;
    message: string;
    file: string;
    fileName: string;
    /** 1-based line. */
    line: number;
    /** Short human description of what was changed, for "what did you change". */
    changeSummary?: string;
}

/**
 * One diagnostic as the Brain believes it to be right now. Read-only consumers
 * (the BotX panel) render this instead of re-reading VS Code diagnostics, so the
 * panel can never show a different problem than the one the Brain reacted to.
 */
export interface LiveDiagnostic {
    file: string;
    fileName: string;
    /** 1-based. */
    line: number;
    severity: 'Error' | 'Warning';
    message: string;
    code?: string;
}

/** The matter the panel should be talking about right now. */
export interface CurrentIssue {
    matter: string;
    concept?: string;
    symbol?: string;
    recurrence: number;
    recurring: boolean;
}

/** Everything a read-only consumer is allowed to see. */
export interface CompanionStateSnapshot {
    monitoringEnabled: boolean;
    teachingEnabled: boolean;
    teaching: {
        level: number;
        action: string;
        matter: string;
        concept?: string;
        recurrence: number;
    };
    struggle: {
        label: string;
        evidence: string[];
    };
    attention: {
        active: boolean;
        targetType: string;
        file?: string;
        line?: number;
        reason: string;
    };
    diagnostics: LiveDiagnostic[];
    issue: CurrentIssue | null;
    whatChanged: WhatChangedReport | null;
    resolution: {
        verified: boolean;
        headline: string;
        takeaway: string;
        via: string;
        change?: string;
        failureEvidence?: string;
    } | null;
    learning: {
        skill: SkillLevel;
        recurringMistakes: number;
        resolvedMistakes: number;
    };
    timeline: {
        at: number;
        time: string;
        kind: string;
        summary: string;
    }[];
}

/** Facts the deterministic wording helpers are allowed to use for one matter. */
interface ExpressFacts {
    level: TeachingLevel;
    severity: 'error' | 'warning';
    file: string;
    line: number;
    concept?: string;
    symbol?: string;
    assignedBefore?: boolean;
    coachNote: string;
}

/** The wording facts remembered for a matter, so a resolution needs no re-reading. */
interface WordingMemo {
    line: number;
    concept?: string;
    symbol?: string;
}

/** A fix Eve applied that is waiting for the real diagnostic state to answer. */
interface PendingVerification {
    signature: string;
    label: string;
    concept?: string;
    symbol?: string;
    file: string;
    fileName: string;
    line: number;
    startedAt: number;
    changeSummary?: string;
}

interface ResolutionRecord {
    verified: boolean;
    headline: string;
    takeaway: string;
    via: string;
    at: number;
    /** What was actually changed, when Eve applied it. */
    change?: string;
    failureEvidence?: string;
}

interface EditBurst {
    at: number;
    line: number;
}

export class CompanionLoop {
    private readonly learning: LearningAgent;
    private readonly recurring = new RecurringMistakes();
    private readonly struggle = new StruggleDetector();
    private readonly heatmap = new StruggleHeatmap();
    private readonly teaching = new TeachingEngine();
    private readonly interruption = new InterruptionPolicy();
    private readonly attention = new AttentionTracker();
    private readonly timeline = new TimelineBuffer();
    private readonly communication = new CommunicationMode();

    private teachingEnabled = true;
    private monitoringEnabled = true;
    private autoExplainEnabled = true;
    private interactionCooldownMs = DEFAULT_INTERACTION_COOLDOWN_MS;
    private lastInteractionAt = 0;
    private lastTypingAt = 0;
    private lastStruggleEmitted = -1;
    private lastAttentionSignature = '';
    private geminiAvoided = 0;
    private geminiRequested = 0;
    private geminiExecuted = 0;
    private explicitGeminiRequest = 0;
    private lastDirectAskAt = 0;
    /** While an explicit answer's caption is on screen, nothing passive may replace it. */
    private explicitCaptionUntil = 0;
    private readonly lastExplainedAt = new Map<string, number>();
    /** Live diagnostic signatures; replaced wholesale on every batch. */
    private knownDiagnosticKeys = new Set<string>();
    /**
     * The diagnostic set the companion currently believes is present, recorded
     * from the same observation that drives everything else. Read-only
     * consumers (the BotX panel) render this instead of re-reading VS Code
     * diagnostics, so the panel can never show a different problem than the one
     * the Brain reacted to.
     */
    private liveDiagnostics: LiveDiagnostic[] = [];
    /** The most recent ladder decision, kept so state can be shown, not recomputed. */
    private lastPlan?: TeachingPlan;
    /** Optional host-provided live file text; see {@link SourceTextReader}. */
    private sourceText?: SourceTextReader;
    /**
     * Debounce for edit timeline entries, per file. Without it a burst of
     * keystrokes would push the diagnostic that "What Changed?" is trying to
     * explain out of the rolling window.
     */
    private readonly lastEditAt = new Map<string, EditBurst>();
    /** The most recent genuinely-observed resolution, for the panel. */
    private lastResolution?: ResolutionRecord;
    /** Memo for getWhatChanged(), keyed by the diagnostic it describes. */
    private whatChangedMemo?: { signature: string; report: WhatChangedReport };
    /**
     * A fix Eve applied that is waiting for the real diagnostic state to answer
     * the only question that matters: did it actually go away?
     */
    private pendingVerification?: PendingVerification;
    /** Wording facts remembered per matter, so a resolution needs no re-reading. */
    private readonly wordingMemo = new Map<string, WordingMemo>();

    constructor(learning: LearningAgent) {
        this.learning = learning;
    }

    /**
     * Supplies live file text for the one grounded fact the companion cannot
     * derive from its own history. Optional by design: with no reader the
     * companion still works, it simply stops claiming anything about whether a
     * name was assigned earlier in the file.
     */
    setSourceTextReader(reader: SourceTextReader): void {
        this.sourceText = reader;
        this.whatChangedMemo = undefined;
    }

    /** Live text of `file` when the host has it, else undefined. Never cached. */
    private readSource(file: string | undefined): string | undefined {
        if (!file || !this.sourceText) {
            return undefined;
        }
        try {
            return this.sourceText(file);
        } catch (err) {
            Logger.info('COMPANION', { Event: 'Source text unavailable', File: file, Error: String(err) });
            return undefined;
        }
    }

    /** Facts the wording helpers are allowed to use for one diagnostic. */
    private wordingFor(diagnostic: LiveDiagnostic): WordingInput {
        const symbol = extractIdentifier(diagnostic.message);
        const text = this.readSource(diagnostic.file);
        return {
            line: diagnostic.line,
            concept: this.conceptFor(diagnostic.code, diagnostic.message),
            symbol,
            assignedBefore: symbol && typeof text === 'string'
                ? isAssignedBefore(text, symbol, diagnostic.line)
                : undefined,
        };
    }

    /**
     * Teaching Mode (botx.teachingMode). This is the ONE runtime source of
     * truth for the teaching ladder — extension.ts only mirrors the persisted
     * configuration into it, never keeps a second flag of its own.
     *
     * SEMANTICS — Teaching Mode controls "teaching/interruption behaviour",
     * NOT "whether Eve exists or expresses basic state".
     *
     * Teaching OFF means:
     *   - no passive hints (level 1 nudges)
     *   - no passive explanations (level 2+ ladder rungs)
     *   - no teaching ladder escalation
     *   - explicit requests (Ask Companion, Explain Error) STILL WORK
     *
     * Base awareness expressions CONTINUE:
     *   - LISTENING / THINKING / SPEAKING emotions from BehaviourController
     *   - idle breathing, gaze, blink
     *   - connection status poses (CONNECTING/DISCONNECTED)
     *   - struggle/attention signals to the Body
     *
     * The Robot Body behaviour is NOT changed by this flag.
     */
    setTeachingEnabled(enabled: boolean): boolean {
        if (this.teachingEnabled === enabled) {
            return false;
        }
        this.teachingEnabled = enabled;
        if (!enabled) {
            // The Body must stop accenting a ladder that is no longer running,
            // so teaching-off is a state change, not just a silent flag.
            this.lastPlan = undefined;
            const payload: TeachingStatePayload = { type: 'TEACHING_STATE', level: 0, matter: '' };
            sendToRobot(payload);
            this.timeline.record('teaching', 'teaching mode off — passive escalation disabled');
        } else {
            this.timeline.record('teaching', 'teaching mode on');
        }
        return true;
    }

    isTeachingEnabled(): boolean {
        return this.teachingEnabled;
    }

    /**
     * Monitoring (botx.monitoring). OFF stops passive companion processing:
     * no observation intake, no teaching decisions, no automatic Gemini calls,
     * and the gaze target is released. Explicit commands (Ask Companion,
     * Explain Error) never consult this flag, and no learning state is lost.
     */
    setMonitoringEnabled(enabled: boolean): boolean {
        if (this.monitoringEnabled === enabled) {
            return false;
        }
        this.monitoringEnabled = enabled;
        if (!enabled) {
            this.releaseAttention('monitoring off');
            this.lastStruggleEmitted = -1;
            this.timeline.record('decision', 'monitoring off — passive companion processing stopped');
        } else {
            this.timeline.record('decision', 'monitoring on — passive companion processing resumed');
        }
        return true;
    }

    isMonitoringEnabled(): boolean {
        return this.monitoringEnabled;
    }

    /** botx.autoExplainErrors — hard gate on *automatic* Gemini explanations. */
    setAutoExplainEnabled(enabled: boolean): void {
        this.autoExplainEnabled = enabled;
    }

    /** botx.cooldownSeconds — interaction cooldown between surfaced messages. */
    setInteractionCooldown(seconds: number): void {
        if (Number.isFinite(seconds) && seconds >= 0) {
            this.interactionCooldownMs = Math.floor(seconds * 1000);
        }
    }

    setVoiceEnabled(enabled: boolean): void {
        this.communication.setVoiceEnabled(enabled);
    }

    /** Whether a speech engine is currently enabled (used by the voice-state getter). */
    getVoiceEnabled(): boolean {
        return this.communication.getVoiceEnabled();
    }

    /**
     * True while an explicit answer's caption should still be readable. The
     * pipeline uses this to hold back passive EMOTION/state-machine frames that
     * would otherwise clear it on the Body (an emotion change takes the old
     * caption with it).
     */
    isExplicitAnswerActive(now: number = Date.now()): boolean {
        return now < this.explicitCaptionUntil;
    }

    // ────────────────────────────────────────────────────────────────────────
    // AI SPEND GATE
    //
    // This is the only place `geminiAvoided` is incremented, and it only
    // increments when a call that would otherwise have been made was actually
    // skipped. That keeps the number honest: no rung counting, no estimates.
    // ────────────────────────────────────────────────────────────────────────

    /** Record that the user explicitly asked something. Never gated. */
    noteDirectAsk(now: number = Date.now()): void {
        this.lastDirectAskAt = now;
        // Claim the output channel for the answer that is now in flight: while
        // the model is generating, no passive emotion or caption may fire and
        // then be replaced — or worse, replace — the answer.
        this.explicitCaptionUntil = Math.max(this.explicitCaptionUntil, now + EXPLICIT_IN_FLIGHT_MS);
        // One authoritative accounting path: an explicit ask is both a Gemini
        // request being initiated right now AND an explicit request. Callers
        // must not also call noteGeminiRequested() for the same ask.
        this.explicitGeminiRequest += 1;
        this.geminiRequested += 1;
    }

    /**
     * Canonical mistake key for a diagnostic, so callers outside this class
     * suppress the same matter the tracker counts.
     */
    matterKey(code: string | number | undefined, message: string): string {
        return mistakeKey(code, message);
    }

    /**
     * Called when Gemini actually delivered an explanation. `matter` is only
     * supplied by the passive path so the repeat-suppression window applies to
     * that mistake; explicit answers are never suppressed, so they omit it.
     */
    noteExplanationDelivered(matter?: string, now: number = Date.now()): void {
        this.geminiExecuted += 1;
        if (matter) {
            this.lastExplainedAt.set(matter, now);
        }
    }

    /** Called when a passive Gemini call is actually requested (gate approved). */
    noteGeminiRequested(): void {
        this.geminiRequested += 1;
    }

    /**
     * Gate for the automatic diagnostic-explanation path.
     *
     * @returns true when Gemini is warranted, false when the deterministic
     *          ladder already answered (or the user already has the answer).
     */
    shouldExplain(request: ExplainGateRequest): boolean {
        const now = request.now ?? Date.now();
        const matter = request.matter;
        if (!this.monitoringEnabled) {
            this.countAvoided(matter, 'monitoring is off', now);
            return false;
        }
        if (!this.autoExplainEnabled) {
            this.countAvoided(matter, 'automatic explanations are disabled', now);
            return false;
        }
        if (!this.teachingEnabled) {
            this.countAvoided(matter, 'teaching mode is off', now);
            return false;
        }
        // The explicit paths (Ask Companion / Explain Error) call Gemini
        // directly and never come through this gate, so an explicit request can
        // never be blocked by a cooldown. A *passive* diagnostic in the same
        // moment is still suppressed: the user already has an answer, and
        // spending again would buy the same explanation twice.
        if (now - this.lastDirectAskAt <= DIRECT_ASK_RELEVANT_MS) {
            this.countAvoided(matter, 'an explicit answer was just delivered — passive call skipped', now);
            return false;
        }
        const explainedAt = this.lastExplainedAt.get(matter);
        if (explainedAt !== undefined && now - explainedAt < REPEAT_EXPLANATION_SUPPRESS_MS) {
            this.countAvoided(matter, 'already explained within the suppression window', now);
            return false;
        }
        const plan = this.teaching.plan({
            matter,
            concept: request.concept,
            severity: request.severity,
            confidence: request.confidence,
            recurrence: request.recurrence ?? Math.max(1, this.recurring.countFor(matter)),
            struggleLevel: this.struggle.evaluate(now).level,
            skillLevel: this.learning.getSkillLevel(),
            directAsk: false,
            now,
        });
        if (plan.level <= 2) {
            this.countAvoided(matter, `level ${plan.level} answered deterministically (${plan.reason})`, now);
            return false;
        }
        this.noteGeminiRequested();
        return true;
    }

    private countAvoided(matter: string, reason: string, now: number): void {
        this.geminiAvoided += 1;
        this.timeline.record('teaching', `Gemini call avoided — ${reason}`, undefined, now);
        Logger.info('COMPANION', {
            Event: 'Gemini call avoided',
            Matter: matter,
            Reason: reason,
            Avoided: String(this.geminiAvoided),
        });
    }

    /**
     * True when this behaviour action belongs to the teaching ladder, so the
     * legacy Behaviour → Explanation chain must not also act on it.
     *
     * The pipeline has two explanation routes that meet on the same diagnostic:
     * the gated batch path (this loop's `shouldExplain` gate) and the older
     * per-decision `AIExplanationEngine.process()` call. Both fired for a single
     * error, so the developer got the ladder's caption and then a second
     * explanation bubble for the same mistake — and the second Gemini call was
     * made outside the gate, so it never appeared in the spend accounting.
     *
     * Diagnostic actions are the ladder's: the batch path either bought a gated
     * Gemini explanation for them or counted the call it deliberately avoided.
     * Non-diagnostic actions (documentation, debugging, Git, celebration) are
     * not ladder decisions and keep the legacy route untouched.
     *
     * @returns true to suppress the legacy explanation for this action.
     */
    ownsExplanation(action: BehaviourAction): boolean {
        return action === BehaviourAction.SHOW_ERROR_HELP
            || action === BehaviourAction.SHOW_WARNING
            || action === BehaviourAction.SHOW_HINT;
    }

    // ────────────────────────────────────────────────────────────────────────
    // OBSERVE / UNDERSTAND
    // ────────────────────────────────────────────────────────────────────────

    observe(observation: Observation, now: number = Date.now()): void {
        if (!this.monitoringEnabled) {
            // Monitoring is off: passive observation processing stops here so
            // no struggle, attention, timeline or teaching state is advanced.
            return;
        }
        this.sweepAttention(now);
        switch (observation.type) {
            case ObservationType.DIAGNOSTIC_BATCH:
                this.observeDiagnosticBatch(observation, now);
                break;
            case ObservationType.ERROR_DETECTED:
            case ObservationType.SYNTAX_ERROR:
            case ObservationType.WARNING_DETECTED:
                this.observeSingleDiagnostic(observation, now);
                break;
            case ObservationType.STUCK_RAPID_SAVE:
                this.struggle.record('RAPID_SAVE', 'rapid saves', now);
                this.timeline.record('struggle', 'rapid saves detected', undefined, now);
                this.emitStruggle(now);
                break;
            case ObservationType.STUCK_IDLE_FOCUS:
                this.struggle.record('IDLE_FOCUS', 'idle focus after activity', now);
                this.timeline.record('struggle', 'idle focus detected', undefined, now);
                this.emitStruggle(now);
                break;
            case ObservationType.DOCUMENT_UNDO:
            case ObservationType.DOCUMENT_REDO:
                this.struggle.record('UNDO_REDO', 'undo/redo churn', now);
                this.timeline.record(
                    'edit',
                    observation.type === ObservationType.DOCUMENT_UNDO ? 'undo' : 'redo',
                    observation.data,
                    now,
                );
                this.emitStruggle(now);
                break;
            case ObservationType.DOCUMENT_CHANGED:
            case ObservationType.TYPING_ACTIVITY:
                this.lastTypingAt = now;
                this.struggle.record('TYPING', '', now);
                this.recordEdit(observation, now);
                break;
            case ObservationType.TYPING_IDLE:
                // Typing stopped: the interruption policy uses this to stop
                // deferring messages, and struggle decays naturally.
                this.lastTypingAt = 0;
                break;
            case ObservationType.RUNTIME_CRASH:
            case ObservationType.DEBUG_INTERRUPTION:
                this.struggle.record('FAILED_ATTEMPT', 'runtime failure', now);
                this.timeline.record('command', 'runtime failure', observation.data, now);
                this.emitStruggle(now);
                break;
            case ObservationType.SUCCESSFUL_CHECKPOINT:
                this.struggle.record('PROGRESS', 'progress checkpoint', now);
                this.struggle.reset();
                this.timeline.record('progress', 'successful checkpoint', observation.data, now);
                this.emitStruggle(now);
                break;
            case ObservationType.CURSOR_MOVED:
                this.maybeAttentionFromCursor(observation, now);
                break;
            case ObservationType.FILE_SAVED:
                this.timeline.record('save', 'file saved', observation.data, now);
                break;
            default:
                break;
        }
    }

    /**
     * Records a real edit into the TimelineBuffer so "What Changed?" has
     * something true to say.
     *
     * Debounced per file: a burst of keystrokes must not evict the diagnostic it
     * is trying to explain from the rolling window. The recorded LINE is
     * deliberately the position of the first change in the burst, because that
     * is where the developer actually started typing.
     */
    private recordEdit(observation: Observation, now: number): void {
        const data = observation.data;
        const file = str(data, 'File', 'file');
        const line = num(data, 'Line', 'line');
        const last = this.lastEditAt.get(file);
        if (last) {
            const withinBurst = now - last.at < EDIT_RECORD_DEBOUNCE_MS;
            if (withinBurst && last.line === line) {
                // Same burst, same line: already recorded, nothing new to say.
                return;
            }
        }
        const burstLine = last && now - last.at < EDIT_RECORD_DEBOUNCE_MS ? last.line : line;
        this.lastEditAt.set(file, { at: now, line: burstLine });
        this.timeline.record(
            'edit',
            line > 0 ? `edit on line ${line}` : 'edit',
            {
                file,
                line: burstLine,
                reason: str(data, 'Reason', 'reason') || 'edit',
            },
            now,
        );
    }

    private observeDiagnosticBatch(observation: Observation, now: number): void {
        const data = observation.data;
        const file = str(data, 'File', 'file', 'filePath');
        const errors = asRecordArray(data['errors']);
        const warnings = asRecordArray(data['warnings']);
        const primary = errors[0] ?? warnings[0];
        const currentKeys = new Set<string>();
        const currentDiagnostics: LiveDiagnostic[] = [];
        const baseName = file ? (file.split(/[\\/]/).pop() || file) : '';

        const recordDiagnostic = (entry: Record<string, unknown>, severity: 'error' | 'warning'): void => {
            const line = num(entry, 'line', 'Line');
            const message = str(entry, 'message', 'Message', 'details');
            const code = codeOf(entry['code']);
            const key = mistakeKey(code, message);
            currentKeys.add(key);
            currentDiagnostics.push({
                file,
                fileName: baseName,
                line,
                severity: severity === 'error' ? 'Error' : 'Warning',
                message,
                code: code === undefined ? undefined : String(code),
            });
            const concept = this.conceptFor(code, message);
            this.recurring.record(key, message || file, concept, now);
            this.struggle.record(
                severity === 'error' ? 'ERROR' : 'WARNING',
                severity === 'error' ? `error at ${file}:${line}` : '',
                now,
            );
            this.heatmap.record(file, line, severity === 'error' ? 1 : 0.4, now);
            this.timeline.record(
                'diagnostic',
                message || `${severity} at ${file}:${line}`,
                { file, line, severity, signature: key },
                now,
            );
            // Remember the wording facts for this matter so a resolution can
            // produce a takeaway without re-reading anything.
            this.wordingMemo.set(key, { line, concept, symbol: extractIdentifier(message) });
        };

        for (const entry of errors) {
            recordDiagnostic(entry, 'error');
        }
        for (const entry of warnings) {
            recordDiagnostic(entry, 'warning');
        }
        // Replaced wholesale, exactly like the signature set: an empty batch is
        // the honest statement that this file is clean now.
        this.liveDiagnostics = currentDiagnostics;
        // Detect resolved mistakes: keys we knew about that are no longer present
        for (const knownKey of this.knownDiagnosticKeys) {
            if (!currentKeys.has(knownKey)) {
                this.recurring.markResolved(knownKey, now);
                this.learning.updateSkill(true);
                this.timeline.record('progress', `Resolved: ${knownKey}`, { key: knownKey }, now);
                this.announceResolution(knownKey, now);
            }
        }
        // A batch with no diagnostics means everything we were tracking is
        // gone: the gaze target must not outlive the issue it pointed at.
        if (this.knownDiagnosticKeys.size > 0 && currentKeys.size === 0) {
            this.releaseAttention('issue resolved', now);
        }
        this.knownDiagnosticKeys = currentKeys;
        this.whatChangedMemo = undefined;
        // A fix Eve applied is only finished when the diagnostic is really gone.
        // This is the closed loop: the verdict comes from real diagnostic state,
        // never from the WorkspaceEdit having been accepted.
        this.settlePendingVerification(currentKeys, now);
        if (primary) {
            const target = attentionFromDiagnostic({
                file,
                line: num(primary, 'line', 'Line'),
                column: num(primary, 'column', 'Column'),
                severity: errors.length > 0 ? 'error' : 'warning',
                confidence: observation.confidence,
            });
            this.setAttention(target, now);
        }
        this.emitStruggle(now);
    }

    /**
     * Publishes the resolution of one matter: a verified statement plus one short
     * takeaway. Called only when the diagnostic was observed to disappear.
     */
    private announceResolution(key: string, now: number): void {
        const record = this.recurring.lookup(key);
        const memo = this.wordingMemo.get(key);
        const label = record?.label ?? memo?.symbol ?? 'the issue';
        const takeaway = this.teaching.takeawayFor({
            line: memo?.line ?? 0,
            concept: record?.concept ?? memo?.concept,
            symbol: memo?.symbol,
        });
        // A fix Eve applied that the developer actually kept gets the verified
        // wording; anything else is a manual fix. The recorded change travels
        // with a verified Eve fix so "what did you change" has a real answer.
        const via = this.pendingVerification?.signature === key ? 'fix' : 'manual';
        const headline = via === 'fix'
            ? '✓ Fixed and verified.'
            : 'Looks fixed. Nice catch.';
        this.lastResolution = {
            verified: true,
            headline,
            takeaway,
            via,
            at: now,
            change: via === 'fix' ? this.pendingVerification?.changeSummary : undefined,
        };
        this.lastPlan = undefined;
        this.teaching.forget(key);
        const text = `${headline}\n\nTakeaway: ${takeaway}`;
        const captionMs = captionHoldMs(text);
        emitEmotion('HAPPY', { intensity: 0.7, duration: captionMs });
        this.communication.speak(text, (payload) => sendToRobot(payload));
        Logger.info('COMPANION', {
            Event: 'Diagnostic resolved',
            Matter: key,
            Via: via,
            Takeaway: takeaway,
            Label: label,
        });
    }

    /**
     * Closes the fix loop. Called with the CURRENT diagnostic keys: if the matter
     * Eve just fixed is gone, the fix is verified; if it is still there, the
     * honest thing to say is that the edit was applied but the error remains.
     */
    private settlePendingVerification(currentKeys: Set<string>, now: number): void {
        const pending = this.pendingVerification;
        if (!pending) {
            return;
        }
        const stillPresent = currentKeys.has(pending.signature);
        const timedOut = now - pending.startedAt > FIX_VERIFICATION_TIMEOUT_MS;
        if (stillPresent && !timedOut) {
            return;
        }
        this.pendingVerification = undefined;
        if (stillPresent) {
            const text = 'Eve: The proposed change was applied, but the original diagnostic is still present. Review the evidence and use “Replan Fix with Eve” for one bounded revised proposal.';
            const captionMs = captionHoldMs(text);
            emitEmotion('ERROR', { intensity: 0.7, duration: captionMs });
            this.communication.speak(text, (payload) => sendToRobot(payload));
            this.lastResolution = {
                verified: false,
                headline: 'Applied, but not fixed.',
                takeaway: `Check ${pending.fileName}:${pending.line} yourself — the same diagnostic is still reported.`,
                via: 'fix',
                at: now,
                change: pending.changeSummary,
                failureEvidence: `Diagnostic still present after the approved change at ${pending.fileName}:${pending.line}: ${pending.label} (matter ${pending.signature}).`,
            };
            Logger.info('COMPANION', { Event: 'Fix not verified — diagnostic still present', Matter: pending.signature });
            return;
        }
        // Resolved. announceResolution() above already published the verified
        // wording for this key; nothing more to add here.
        Logger.info('COMPANION', { Event: 'Fix verified by real diagnostic state', Matter: pending.signature });
    }

    /**
     * Starts the verification loop for a fix Eve just applied. Nothing is claimed
     * here — the verdict is produced later by settlePendingVerification() from
     * whatever the diagnostics actually do.
     */
    beginFixVerification(input: FixVerificationInput, now: number = Date.now()): void {
        const symbol = extractIdentifier(input.message);
        this.pendingVerification = {
            signature: mistakeKey(input.code, input.message),
            label: input.message,
            concept: this.conceptFor(input.code, input.message),
            symbol,
            file: input.file,
            fileName: input.fileName,
            line: input.line,
            startedAt: now,
            changeSummary: input.changeSummary,
        };
        Logger.info('COMPANION', {
            Event: 'Awaiting verification of applied fix',
            Matter: this.pendingVerification.signature,
            File: input.fileName,
            Line: String(input.line),
        });
    }

    private observeSingleDiagnostic(observation: Observation, now: number): void {
        const data = observation.data;
        const file = str(data, 'File', 'file', 'filePath');
        const line = num(data, 'Line', 'line');
        const message = str(data, 'details', 'Message', 'message', 'errorText');
        const code = codeOf(data['Code'] ?? data['code']);
        const severity: 'error' | 'warning' =
            observation.type === ObservationType.WARNING_DETECTED ? 'warning' : 'error';
        const key = mistakeKey(code, message);
        const concept = this.conceptFor(code, message);
        this.knownDiagnosticKeys.add(key);
        const live: LiveDiagnostic = {
            file,
            fileName: file ? (file.split(/[\\/]/).pop() || file) : '',
            line,
            severity: severity === 'error' ? 'Error' : 'Warning',
            message,
            code: code === undefined ? undefined : String(code),
        };
        this.liveDiagnostics = [
            live,
            ...this.liveDiagnostics.filter((d) => d.message !== message || d.line !== line),
        ];
        this.recurring.record(key, message || file, concept, now);
        this.struggle.record(
            severity === 'error' ? 'ERROR' : 'WARNING',
            severity === 'error' ? `error at ${file}:${line}` : '',
            now,
        );
        this.heatmap.record(file, line, severity === 'error' ? 1 : 0.4, now);
        this.timeline.record(
            'diagnostic',
            message || `${severity} at ${file}:${line}`,
            { file, line, severity, signature: key },
            now,
        );
        this.wordingMemo.set(key, { line, concept, symbol: extractIdentifier(message) });
        this.whatChangedMemo = undefined;
        // Same closed loop as the batch path: a fix is only verified by real
        // diagnostic state.
        this.settlePendingVerification(this.knownDiagnosticKeys, now);
        this.setAttention(
            attentionFromDiagnostic({
                file,
                line,
                column: num(data, 'Column', 'column'),
                severity,
                confidence: observation.confidence,
            }),
            now,
        );
        this.emitStruggle(now);
    }

    private conceptFor(code: string | number | undefined, message: string): string | undefined {
        const text = `${String(code ?? '')} ${message}`.toLowerCase();
        if (text.includes('null') || text.includes('undefined')) {
            return 'nullability';
        }
        if (text.includes('type') && (text.includes('assign') || text.includes('mismatch'))) {
            return 'type assignment';
        }
        if (text.includes('import')) {
            return 'imports';
        }
        if (text.includes('semicolon') || text.includes("';' expected")) {
            return 'statement syntax';
        }
        if (text.includes('bracket') || text.includes('brace') || text.includes('paren')) {
            return 'bracket matching';
        }
        if (text.includes('unused')) {
            return 'unused code';
        }
        return undefined;
    }

    private maybeAttentionFromCursor(observation: Observation, now: number): void {
        const current = this.attention.getCurrent(now);
        // A cursor is a weak target; never override a live, stronger one.
        if (current && current.strength > 0.35 && current.expiresAt > now) {
            return;
        }
        const data = observation.data;
        this.setAttention(
            attentionFromCursor({
                file: str(data, 'File', 'file'),
                line: num(data, 'cursorLine', 'Line'),
                column: num(data, 'cursorColumn', 'Column'),
            }),
            now,
        );
    }

    private setAttention(input: AttentionInput, now: number): void {
        const payload = this.attention.set(input, now);
        const signature = `${payload.targetType}:${payload.file ?? ''}:${payload.line ?? 0}`;
        if (signature === this.lastAttentionSignature) {
            return;
        }
        this.lastAttentionSignature = signature;
        sendToRobot(payload);
        this.timeline.record('attention', `${payload.targetType} at ${payload.file ?? '?'}:${payload.line ?? '?'}`, payload as unknown as Record<string, unknown>, now);
        Logger.info('COMPANION', { Event: 'Attention target', Target: signature, Strength: String(payload.strength) });
    }

    /**
     * Retires an expired target Brain-side. The Body expires the same target on
     * its own `expiresAt`, so the gaze already falls back to normal; resetting
     * the signature here is what stops an identical diagnostic that reappears
     * later from being deduplicated against a target nobody is holding.
     */
    private sweepAttention(now: number): void {
        if (this.lastAttentionSignature === '' || this.attention.getCurrent(now)) {
            return;
        }
        this.lastAttentionSignature = '';
        this.timeline.record('attention', 'attention target expired — gaze returned to normal behaviour', undefined, now);
    }

    /**
     * Ends the current target immediately (resolution, monitoring off, lifecycle
     * reset). Reuses the canonical ATTENTION_TARGET payload with strength 0 and
     * an `expiresAt` of now, so no new protocol message and no duplicate gaze
     * system are introduced: the Body drops the target on the next frame.
     */
    releaseAttention(reason: string, now: number = Date.now()): void {
        const released = this.attention.release(now);
        this.lastAttentionSignature = '';
        if (!released) {
            return;
        }
        sendToRobot(released);
        this.timeline.record('attention', `released — ${reason}`, released as unknown as Record<string, unknown>, now);
        Logger.info('COMPANION', { Event: 'Attention released', Reason: reason });
    }

    private emitStruggle(now: number): void {
        const estimate = this.struggle.evaluate(now);
        if (Math.abs(estimate.level - this.lastStruggleEmitted) < 0.1) {
            return;
        }
        this.lastStruggleEmitted = estimate.level;
        const payload: StruggleStatePayload = {
            type: 'STRUGGLE_STATE',
            level: estimate.level,
            evidence: estimate.evidence,
            confidence: estimate.confidence,
            expiresAt: estimate.expiresAt,
        };
        sendToRobot(payload);
        this.timeline.record('struggle', `struggle=${estimate.level.toFixed(2)}`, { evidence: estimate.evidence }, now);
    }

    // ────────────────────────────────────────────────────────────────────────
    // DECIDE WHETHER TO INTERRUPT + EXPRESS + TEACH
    // ────────────────────────────────────────────────────────────────────────

    processDecision(decision: Decision, now: number = Date.now()): void {
        if (!this.monitoringEnabled) {
            // Monitoring off: no passive teaching decisions, no captions.
            return;
        }
        const teachable = decision.type === DecisionType.SHOW_ERROR_HELP
            || decision.type === DecisionType.SHOW_HINT
            || decision.type === DecisionType.SHOW_WARNING;
        if (!teachable) {
            this.timeline.record('decision', `${decision.type}: ${decision.reason}`, undefined, now);
            return;
        }
        const data = decision.data;
        const file = str(data, 'file', 'File', 'filePath');
        const line = num(data, 'line', 'Line');
        const message = str(data, 'errorText', 'message', 'Message', 'details');
        const code = codeOf(data['code']);
        const severity: 'error' | 'warning' =
            decision.type === DecisionType.SHOW_WARNING ? 'warning' : 'error';
        const key = mistakeKey(code, message);
        const recurrence = Math.max(1, this.recurring.countFor(key));
        const concept = this.recurring.lookup(key)?.concept ?? this.conceptFor(code, message);
        const symbol = extractIdentifier(message);
        const source = this.readSource(file);
        // Tri-state on purpose: with no readable file we make no claim at all.
        const assignedBefore = symbol && typeof source === 'string'
            ? isAssignedBefore(source, symbol, line)
            : undefined;
        const struggleEstimate = this.struggle.evaluate(now);
        if (!this.teachingEnabled) {
            this.timeline.record('teaching', 'teaching disabled — silent', undefined, now);
            return;
        }
        // Request priority, using the ONE existing mechanism: an explicit ask
        // moments ago means the message carrying that answer is never downgraded
        // by cooldowns or typing. The ladder still chooses the rung.
        const directAsk = now - this.lastDirectAskAt <= DIRECT_ASK_RELEVANT_MS;
        const plan = this.teaching.plan({
            matter: key,
            concept,
            severity,
            confidence: decision.confidence,
            recurrence,
            struggleLevel: struggleEstimate.level,
            skillLevel: this.learning.getSkillLevel(),
            directAsk,
            now,
        });
        const isTyping = now - this.lastTypingAt < TYPING_ACTIVE_MS;
        const cooldownRemainingMs = Math.max(0, this.interactionCooldownMs - (now - this.lastInteractionAt));
        const outcome: InterruptionOutcome = this.interruption.decide({
            teachingLevel: plan.level,
            confidence: decision.confidence,
            severity,
            struggleLevel: struggleEstimate.level,
            isTyping,
            userAlreadyFixing: isTyping && recurrence > 1,
            recentlyInteracted: cooldownRemainingMs > 0,
            cooldownRemainingMs,
            directAsk,
            now,
        }).outcome;
        // Note: no AI spend is counted here. The counter is owned by the
        // explain gate, which is the only place a call is genuinely skipped.
        this.emitTeaching(plan.level, key, concept, recurrence);
        // An explicit answer is still on screen: record what the ladder decided
        // but never express it — a passive emotion or caption here would replace
        // the answer the user asked for (and an EMOTION change clears it on the
        // Body). After the caption expires, direct-ask escalation still applies
        // for the rest of the relevance window.
        if (now < this.explicitCaptionUntil) {
            this.timeline.record(
                'teaching',
                `level ${plan.level} → ${outcome} (${plan.reason}) — suppressed: explicit answer still on screen`,
                undefined,
                now,
            );
            return;
        }
        this.timeline.record('teaching', `level ${plan.level} → ${outcome} (${plan.reason})`, undefined, now);
        // The coach note exists only when the authoritative counter says this
        // matter is genuinely recurring; below the threshold it is empty.
        this.expressOutcome(outcome, {
            level: plan.level,
            severity,
            file,
            line,
            concept,
            symbol,
            assignedBefore,
            coachNote: this.recurringCoach(key, line),
        });
        if (outcome !== 'SILENT' && outcome !== 'OBSERVE') {
            this.lastInteractionAt = now;
        }
        Logger.info('COMPANION', {
            Event: 'Teaching decision',
            Matter: key,
            Level: String(plan.level),
            Recurrence: String(recurrence),
            Outcome: outcome,
            GeminiAvoided: String(this.geminiAvoided),
        });
    }

    private emitTeaching(level: TeachingLevel, matter: string, concept: string | undefined, recurrence: number): void {
        // Keep the decision that was actually made so state can be displayed
        // without anyone recomputing the ladder a second time.
        this.lastPlan = {
            level,
            matter,
            concept,
            recurrence,
            skillLevel: this.learning.getSkillLevel(),
            reason: '',
        };
        const payload: TeachingStatePayload = {
            type: 'TEACHING_STATE',
            level,
            matter,
            concept,
            recurrence,
            skillLevel: this.learning.getSkillLevel(),
        };
        sendToRobot(payload);
    }

    private expressOutcome(outcome: InterruptionOutcome, facts: ExpressFacts): void {
        const { severity } = facts;
        if (outcome === 'SILENT') {
            return;
        }
        if (outcome === 'OBSERVE' || outcome === 'ACKNOWLEDGE') {
            emitEmotion('LISTENING', { intensity: severity === 'error' ? 0.6 : 0.45 });
            return;
        }
        // Expression and speech stay on separate channels: EMOTION carries HOW
        // the robot feels, CAPTION carries WHAT it says. The emotion hold is set
        // to the caption's own reading-time so the emotion release cannot end
        // the caption before it has been read (the Body clears a caption when
        // the carrying emotion changes), and TTS stays a drop-in later.
        const emotion = severity === 'error' ? 'ALERT' : 'LISTENING';
        const caption = this.captionFor(facts);
        emitEmotion(emotion, {
            intensity: severity === 'error' ? 0.85 : 0.6,
            duration: captionHoldMs(caption),
        });
        this.communication.speak(caption, (payload) => sendToRobot(payload));
    }

    /**
     * Deterministic wording for the lower rungs, so the companion can teach a
     * nudge or a hint without spending a Gemini call. Rungs 3–4 are worded by the
     * explanation engine; this only supplies a safe fallback.
     *
     * Rung 2 is where a hint earns its keep, so it is also where the grounded WHY
     * sentence from TeachingEngine is used: it answers from what the companion
     * actually knows about this line, or it says nothing at all.
     */
    private captionFor(facts: ExpressFacts): string {
        const { level, severity, file, line, concept, symbol, assignedBefore, coachNote } = facts;
        const name = file ? (file.split(/[\\/]/).pop() || file) : 'this file';
        const where = line > 0 ? `${name}:${line}` : name;
        let text: string;
        switch (level) {
            case 1:
                text = `There may be a ${severity === 'error' ? 'problem' : 'warning'} around ${where}.`;
                break;
            case 2:
                if (symbol) {
                    text = `${this.teaching.hintFor({ line, concept, symbol, assignedBefore })} Want a hint?`;
                } else {
                    text = concept
                        ? `This looks like a ${concept} issue near ${where}. Want a hint?`
                        : `Something looks off near ${where}. Want a hint?`;
                }
                break;
            default:
                text = `Let me explain the issue near ${where}.`;
        }
        // The recurrence note rides along with the teaching it explains, and is
        // only ever built from the authoritative RecurringMistakes state.
        return coachNote ? `${text}\n\n${coachNote}` : text;
    }

    /**
     * The recurring-pattern note. Deterministic and count-true: it can only be
     * built from a real RecurringMistakes record, so it cannot claim a pattern the
     * Brain has not actually observed. Below the recurrence threshold it returns an
     * empty string, which is what keeps Eve silent about a one-off.
     */
    private recurringCoach(key: string, line: number): string {
        const record = this.recurring.lookup(key);
        if (!record || !this.recurring.isRecurring(key)) {
            return '';
        }
        const where = line > 0 ? ` around line ${line}` : '';
        const subject = this.wordingMemo.get(key)?.symbol
            ?? (record.concept ? `this ${record.concept} issue` : 'this issue');
        const times = record.count >= 3 ? `${record.count} times` : 'this twice';
        return `Heads up: ${subject} has come up ${times}${where}. Worth learning the pattern now.`;
    }

    // ────────────────────────────────────────────────────────────────────────
    // COMMANDS
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Delivers an explicit, user-requested line through the canonical caption
     * channel (CAPTION), and returns how long the Body should hold it — sized
     * by the existing reading-speed logic. EMOTION carries only how the robot
     * feels about the line; the text itself always travels on CAPTION, so an
     * explicit answer is readable rather than welded to a pose.
     */
    speakLine(text: string, now: number = Date.now()): number {
        const caption = this.communication.speak(text, (payload) => sendToRobot(payload));
        if (!caption) {
            return 0;
        }
        const hold = caption.duration ?? 4000;
        // Protect the explicit answer: passive expressions must not replace or
        // interrupt a caption the user is still reading (caption lifecycle), and
        // this replaces the shorter in-flight claim now that the text exists.
        this.explicitCaptionUntil = now + hold;
        this.timeline.record('gemini', `caption: ${caption.text.slice(0, 120)}`, undefined, now);
        return hold;
    }

    replayTimeline(now: number = Date.now()): TimelineReplay {
        const replay = this.timeline.replay(now);
        if (replay.firstChangeBeforeError) {
            Logger.info('COMPANION', {
                Event: 'Timeline replay',
                FirstChange: replay.firstChangeBeforeError.summary,
                RepeatedAttempts: String(replay.repeatedFailedAttempts),
            });
        }
        return replay;
    }

    /**
     * Compact, honest replay of the last ~60 s for the developer. Every line is
     * derived from the live TimelineBuffer and the live diagnostic set — when
     * the buffer cannot answer a question it says so instead of inventing a
     * terminal event.
     */
    getTimelineReport(now: number = Date.now()): string[] {
        const at = (when: number) => new Date(when).toLocaleTimeString();
        const replay = this.replayTimeline(now);
        const entries = replay.entries;
        const lines = [
            `Window ${at(replay.windowStart)} → ${at(replay.windowEnd)} · ${entries.length} relevant event(s).`,
        ];
        if (entries.length === 0) {
            lines.push('Insufficient information: nothing was recorded in this window, so there is no timeline to replay.');
            return lines;
        }
        const diagnostics = entries.filter((e) => e.kind === 'diagnostic');
        const firstError = diagnostics.find((e) => String(e.data?.['severity'] ?? '').toLowerCase() === 'error');
        if (replay.errorFirstSeen === undefined || !firstError) {
            lines.push('No error diagnostic appeared in this window — there is no debugging episode to replay yet.');
            lines.push('What did happen:');
            for (const entry of entries.slice(-5)) {
                lines.push(`  ${at(entry.at)} [${entry.kind}] ${entry.summary}`);
            }
            return lines;
        }
        const signature = String(firstError.data?.['signature'] ?? '');
        if (replay.firstChangeBeforeError) {
            lines.push(`First relevant change before the error: ${at(replay.firstChangeBeforeError.at)} — ${replay.firstChangeBeforeError.summary}`);
        } else {
            lines.push('First relevant change before the error: not recorded in this window.');
        }
        lines.push(`Diagnostic first appeared: ${at(replay.errorFirstSeen)} — ${firstError.summary}`);
        lines.push(`Repeated attempts of the same error: ${replay.repeatedFailedAttempts}.`);
        // Important transitions: the first sighting of each distinct signature
        // plus every recorded resolution, in chronological order.
        const seenSignatures = new Set<string>();
        const transitions: TimelineEntry[] = [];
        for (const entry of diagnostics) {
            const key = String(entry.data?.['signature'] ?? entry.summary);
            if (seenSignatures.has(key)) {
                continue;
            }
            seenSignatures.add(key);
            transitions.push(entry);
        }
        for (const entry of entries) {
            if (entry.kind === 'progress' && entry.summary.startsWith('Resolved:')) {
                transitions.push(entry);
            }
        }
        transitions.sort((a, b) => a.at - b.at);
        if (transitions.length > 0) {
            lines.push('Diagnostic transitions:');
            for (const entry of transitions.slice(0, 8)) {
                lines.push(`  ${at(entry.at)} [${entry.kind}] ${entry.summary}`);
            }
        }
        if (!signature) {
            lines.push('Status: cannot tell whether it resolved — this error had no stable signature recorded.');
        } else if (this.knownDiagnosticKeys.has(signature)) {
            lines.push('Status: the error is still among current diagnostics — not resolved yet.');
        } else {
            lines.push('Status: the error is no longer among current diagnostics — it appears resolved.');
        }
        return lines;
    }

    /**
     * Compact learning report: skill, tracked suggestion outcomes, recurring
     * categories, improvement signals, spend accounting and the current struggle
     * read. Deliberately excludes internal coefficients and never evaluates the
     * developer — only deterministic counters are reported.
     */
    getLearningSummary(now: number = Date.now()): string[] {
        const profile = this.learning.getProfile();
        const recurring = this.recurring.getTop(3, now);
        const unresolved = this.recurring.getRecurring(now);
        const resolvedCount = this.recurring.getResolvedCount();
        const lines = [
            `Skill: ${profile.skillLevel} (score ${profile.skillScore}/100) · explanation length: ${profile.preferredExplanationLength} · verbosity: ${profile.verbosityMode}.`,
            `Suggestions tracked: ${profile.acceptedSuggestions} accepted · ${profile.ignoredSuggestions} ignored.`,
            recurring.length > 0
                ? `Recurring mistake categories: ${recurring.map((r) => `${r.concept || r.label} ×${r.count}`).join(', ')}.`
                : 'Recurring mistake categories: none recorded yet.',
            unresolved.length > 0
                ? `Unresolved recurring patterns: ${unresolved.length} still present (${unresolved.slice(0, 3).map((r) => r.concept || r.label).join(', ')}).`
                : 'Unresolved recurring patterns: none.',
            `Improvement signals: ${resolvedCount} mistake(s) resolved this session · friction hotspots: ${this.heatmap.getSummary(3, now)}`,
            `Gemini spend: ${this.geminiRequested} requested · ${this.geminiExecuted} delivered · ${this.geminiAvoided} avoided by the hint ladder · ${this.explicitGeminiRequest} explicit.`,
        ];
        lines.push(...this.getStruggleSummary(now));
        return lines;
    }

    /**
     * Current/recent deterministic struggle state for the Learning Summary.
     * Behaviour only — never emotion, never sentiment: the wording is always
     * about coding behaviour.
     */
    getStruggleSummary(now: number = Date.now()): string[] {
        const estimate = this.struggle.evaluate(now);
        const recurringCount = this.recurring.getRecurring(now).length;
        const lines = [
            `Struggle signal: level ${estimate.level.toFixed(2)} · confidence ${estimate.confidence.toFixed(2)} · repeated diagnostics: ${recurringCount} recurring signature(s).`,
        ];
        if (estimate.evidence.length === 0) {
            lines.push('No repeated-difficulty signal observed in recent coding behaviour.');
            return lines;
        }
        lines.push(`Observed in coding behaviour: ${estimate.evidence.join(', ')}.`);
        if (estimate.level >= 0.4) {
            lines.push('Coding behaviour suggests repeated difficulty around this issue.');
        }
        return lines;
    }

    /**
     * Everything a read-only consumer is allowed to see, read straight from the
     * fields the companion already maintains. This is a VIEW of existing state,
     * never a second decision pass: no level is re-planned, no struggle level is
     * re-estimated, no teaching level is derived here.
     */
    getStateSnapshot(now: number = Date.now()): CompanionStateSnapshot {
        const level = this.lastPlan?.level ?? 0;
        const estimate = this.struggle.evaluate(now);
        const attention = this.attention.getCurrent(now);
        const recurring = this.recurring.getRecurring(now);
        return {
            monitoringEnabled: this.monitoringEnabled,
            teachingEnabled: this.teachingEnabled,
            teaching: {
                level,
                action: TEACHING_ACTION_NAMES[level],
                matter: this.lastPlan?.matter ?? '',
                concept: this.lastPlan?.concept,
                recurrence: this.lastPlan?.recurrence ?? 0,
            },
            struggle: {
                label: struggleLabel(estimate.level),
                evidence: estimate.evidence,
            },
            attention: {
                active: !!attention && attention.strength > 0,
                targetType: attention?.targetType ?? '',
                file: attention?.file,
                line: attention?.line,
                reason: attention?.reason ?? '',
            },
            diagnostics: [...this.liveDiagnostics],
            issue: this.currentIssue(now),
            whatChanged: this.getWhatChanged(now),
            resolution: this.lastResolution ? { ...this.lastResolution } : null,
            learning: {
                skill: this.learning.getSkillLevel(),
                recurringMistakes: recurring.length,
                resolvedMistakes: this.recurring.getResolvedCount(),
            },
            timeline: this.timeline.getWindow(now).slice(-6).reverse().map((entry) => ({
                at: entry.at,
                time: new Date(entry.at).toLocaleTimeString(),
                kind: entry.kind,
                summary: entry.summary,
            })),
        };
    }

    /**
     * The matter the panel should be talking about right now, built only from
     * Brain state. `recurring` is the real threshold check, not a re-derived one,
     * so the panel cannot over- or under-report a pattern.
     */
    currentIssue(now: number = Date.now()): CurrentIssue | null {
        const primary = this.liveDiagnostics.find((d) => d.severity === 'Error') ?? this.liveDiagnostics[0];
        if (!primary) {
            return null;
        }
        const code = primary.code;
        const key = mistakeKey(code, primary.message);
        const record = this.recurring.lookup(key);
        return {
            matter: key,
            concept: record?.concept ?? this.conceptFor(code, primary.message),
            symbol: extractIdentifier(primary.message),
            recurrence: this.recurring.countFor(key),
            recurring: this.recurring.isRecurring(key),
        };
    }

    /**
     * "What changed?" — answered only from the TimelineBuffer and, when needed,
     * from the live file. Returns null when there is no current issue to explain.
     *
     * Memoised per diagnostic, because the panel re-reads the snapshot on every
     * frame and the answer should not be recomputed each time.
     */
    getWhatChanged(now: number = Date.now()): WhatChangedReport | null {
        const primary = this.liveDiagnostics.find((d) => d.severity === 'Error') ?? this.liveDiagnostics[0];
        if (!primary) {
            return null;
        }
        // Same identity the timeline recorded for this diagnostic, so the report
        // is matched against the real entry rather than a re-derived key.
        const signature = mistakeKey(primary.code, primary.message);
        if (this.whatChangedMemo?.signature === signature) {
            return this.whatChangedMemo.report;
        }
        const report = buildWhatChanged({
            signature,
            fileName: primary.fileName || primary.file,
            line: primary.line,
            message: primary.message,
            now,
            entries: this.timeline.getWindow(now),
            documentText: this.readSource(primary.file),
        });
        this.whatChangedMemo = { signature, report };
        return report;
    }

    /**
     * "I'll Try." The developer takes over, so the current teaching response is
     * withdrawn — and nothing else changes: the diagnostic and the attention target
     * stay, because the problem is still there, and no code is touched.
     */
    dismissTeaching(now: number = Date.now()): void {
        if (!this.lastPlan) {
            return;
        }
        const matter = this.lastPlan.matter;
        this.teaching.forget(matter);
        this.lastPlan = undefined;
        this.timeline.record('teaching', 'developer took over — teaching dismissed', { matter }, now);
        emitEmotion('LISTENING', { intensity: 0.35 });
        Logger.info('COMPANION', { Event: 'Teaching dismissed by developer', Matter: matter });
    }

    /**
     * Lifecycle reset: releases anything the Body is still holding, then drops
     * all in-memory companion state. Learning state lives in LearningAgent and
     * is never cleared here.
     */
    clear(now: number = Date.now()): void {
        this.releaseAttention('lifecycle reset', now);
        this.recurring.clear();
        this.struggle.reset();
        this.heatmap.clear();
        this.teaching.clear();
        this.attention.clear();
        this.timeline.clear();
        this.knownDiagnosticKeys.clear();
        this.liveDiagnostics = [];
        this.lastPlan = undefined;
        this.lastStruggleEmitted = -1;
        this.lastAttentionSignature = '';
        this.explicitCaptionUntil = 0;
        this.lastEditAt.clear();
        this.wordingMemo.clear();
        this.whatChangedMemo = undefined;
        this.lastResolution = undefined;
        this.pendingVerification = undefined;
    }

    /** Extension teardown: no timers to stop (the loop is event-driven). */
    dispose(): void {
        this.clear();
    }
}
