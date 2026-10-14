import { ContextType } from "../context/contextType";
import type { Context } from "../context/context";
import { DecisionType } from "./decisionType";
import { Decision } from "./decision";
import { DecisionState } from "./decisionState";
import { DecisionPublisher } from "./decisionPublisher";
import { Logger } from "../utils/logger";

interface DecisionRule {
    decisionType: DecisionType;
    confidence: number;
    reason: string;
}

/** Grace window between proactive speech-bubble broadcasts for the same
 *  diagnostic set in the same file. A new distinct error (hash change) always
 *  bypasses it. The window is randomized inside [30s, 45s] so an unchanged,
 *  unresolved error signature never re-triggers WebSocket broadcasts (or sound
 *  cues) on every save/typing pause. */
const DIAGNOSTIC_GRACE_MIN_MS = 30000;
const DIAGNOSTIC_GRACE_MAX_MS = 45000;
const DIAGNOSTIC_NOTIFY_COOLDOWN_MS =
    DIAGNOSTIC_GRACE_MIN_MS + Math.floor(Math.random() * (DIAGNOSTIC_GRACE_MAX_MS - DIAGNOSTIC_GRACE_MIN_MS + 1));

export class DecisionEngine {
    private state: DecisionState;
    private publisher: DecisionPublisher;

    /**
     * Deduplication gate: `lastNotifiedDiagnosticHash` records the exact
     * diagnostic signature last broadcast for each file and
     * `lastNotificationTimestamp` records when. Identical hashes inside the
     * cooldown window are suppressed so repeated proactive speech bubbles are not
     * emitted for an unchanged error.
     */
    private lastNotifiedDiagnosticHash: Map<string, string> = new Map();
    private lastNotificationTimestamp: Map<string, number> = new Map();

    constructor() {
        this.state = new DecisionState();
        this.publisher = new DecisionPublisher();
    }

    process(context: Context): void {
        const rule = this.resolveRule(context);

        if (rule.decisionType === DecisionType.DO_NOTHING) {
            this.state.lastContext = context.type;
            return;
        }

        if (this.state.isOnCooldown(rule.decisionType)) {
            return;
        }

        // Cooldown gate for proactive speech bubbles: when the SAME diagnostic
        // hash was already broadcast for this file inside the cooldown window,
        // suppress the decision instead of re-announcing it.
        if (rule.decisionType === DecisionType.SHOW_ERROR_HELP) {
            const file = String(context.data?.["file"] ?? context.data?.["File"] ?? "");
            const signature = this.buildDiagnosticSignature(context);
            if (file && !this.shouldNotifyDiagnostic(file, signature)) {
                Logger.info("DECISION", {
                    "Decision": rule.decisionType,
                    "Event": "Suppressed (unchanged diagnostic hash inside cooldown)",
                    "File": file,
                    "CooldownMs": String(DIAGNOSTIC_NOTIFY_COOLDOWN_MS)
                });
                return;
            }
        }

        const decision = this.buildDecision(context, rule);

        this.state.setCooldown(rule.decisionType);
        this.state.lastHint = rule.reason;
        this.state.lastContext = context.type;

        if (rule.decisionType === DecisionType.SHOW_ERROR_HELP) {
            const file = String(context.data?.["file"] ?? context.data?.["File"] ?? "");
            const signature = this.buildDiagnosticSignature(context);
            this.recordDiagnosticNotification(file, signature);
        }

        this.publisher.publish(decision);

        Logger.info("DECISION", {
            "Decision": decision.type,
            "Reason": decision.reason,
            "Confidence": String(decision.confidence),
            "Timestamp": new Date(decision.timestamp).toISOString()
        });
    }

    /**
     * True when a proactive speech bubble may be broadcast for the given file and
     * diagnostic signature. Suppressed only while the hash is UNCHANGED and inside
     * the cooldown window; a new distinct error is always broadcast immediately.
     */
    shouldNotifyDiagnostic(file: string, signature: string): boolean {
        const now = Date.now();
        const lastHash = this.lastNotifiedDiagnosticHash.get(file);
        if (lastHash === undefined || lastHash !== signature) {
            return true;
        }
        const lastTime = this.lastNotificationTimestamp.get(file) ?? 0;
        return now - lastTime >= DIAGNOSTIC_NOTIFY_COOLDOWN_MS;
    }

    recordDiagnosticNotification(file: string, signature: string): void {
        this.lastNotifiedDiagnosticHash.set(file, signature);
        this.lastNotificationTimestamp.set(file, Date.now());
    }

    resetDiagnosticNotifyGate(): void {
        this.lastNotifiedDiagnosticHash.clear();
        this.lastNotificationTimestamp.clear();
    }

    /**
     * Publishes a decision derived from an ACES recommendation.
     *
     * The existing rule path stays untouched: this is the single integration
     * point where ACES advice becomes a first-class Decision, still subject to
     * cooldowns and the same publisher every other decision uses.
     */
    processAcesRecommendation(
        context: Context,
        recommendation: { type: DecisionType; confidence: number; reason: string; data?: Record<string, unknown> }
    ): void {
        if (recommendation.type === DecisionType.DO_NOTHING) {
            this.state.lastContext = context.type;
            return;
        }
        if (this.state.isOnCooldown(recommendation.type)) {
            return;
        }
        const decision: Decision = {
            id: `dec-aces-${context.id}`,
            type: recommendation.type,
            confidence: recommendation.confidence,
            timestamp: Date.now(),
            reason: recommendation.reason,
            sourceContext: context,
            data: { ...context.data, ...(recommendation.data ?? {}) },
        };
        this.state.setCooldown(recommendation.type);
        this.state.lastHint = recommendation.reason;
        this.state.lastContext = context.type;
        this.publisher.publish(decision);
        Logger.info("DECISION", {
            "Decision": decision.type,
            "Reason": decision.reason,
            "Confidence": String(decision.confidence),
            "Source": "ACES",
            "Timestamp": new Date(decision.timestamp).toISOString()
        });
    }

    forceCooldown(type: DecisionType, durationMs: number): void {
        this.state.setCustomCooldown(type, durationMs);
        Logger.info("DECISION", {
            "Decision": type,
            "Event": "Forced cooldown",
            "Duration": `${durationMs}ms`
        });
    }

    getState(): DecisionState {
        return this.state;
    }

    getPublisher(): DecisionPublisher {
        return this.publisher;
    }

    private resolveRule(context: Context): DecisionRule {

        if (context.type === ContextType.USER_STUCK_ON_ERROR) {
            const language = String(context.data["language"] ?? context.data["Language"] ?? "code");
            return {
                decisionType: DecisionType.SHOW_ERROR_HELP,
                confidence: 0.98,
                reason: `User is stuck on a syntax error in ${String(context.data["file"] ?? "unknown")}`
            };
        }

        if (context.type === ContextType.DIAGNOSTIC_ANALYSIS) {
            return {
                decisionType: DecisionType.DO_NOTHING,
                confidence: 1.0,
                reason: "Diagnostic analysis handled by the dedicated explanation agent"
            };
        }

        switch (context.type) {

            case ContextType.EDITING_JAVA:
            case ContextType.EDITING_TYPESCRIPT:
            case ContextType.EDITING_PYTHON:
            case ContextType.EDITING_CPP:
                return {
                    decisionType: DecisionType.WAIT,
                    confidence: 0.60,
                    reason: "Active editing session in progress"
                };

            case ContextType.READING_CODE:
            case ContextType.WRITING_CODE:
            case ContextType.SWITCHING_FILES:
                return {
                    decisionType: DecisionType.DO_NOTHING,
                    confidence: 1.0,
                    reason: ""
                };

            case ContextType.FIXING_COMPILER_ERROR:
                return {
                    decisionType: DecisionType.SHOW_ERROR_HELP,
                    confidence: 0.98,
                    reason: "Compiler error detected"
                };

            case ContextType.DEBUGGING:
                return {
                    decisionType: DecisionType.SUGGEST_DEBUGGING,
                    confidence: 0.90,
                    reason: "Debug session is active"
                };

            case ContextType.USING_TERMINAL:
                return {
                    decisionType: DecisionType.WAIT,
                    confidence: 0.70,
                    reason: "User is working in terminal"
                };

            case ContextType.WORKING_WITH_GIT:
                return {
                    decisionType: DecisionType.SUGGEST_GIT_ACTION,
                    confidence: 0.85,
                    reason: "Git repository activity detected"
                };

            case ContextType.MANAGING_EXTENSIONS:
                return {
                    decisionType: DecisionType.SUGGEST_EXTENSION,
                    confidence: 0.80,
                    reason: "Extension changes detected"
                };

            case ContextType.IDLE:
                return {
                    decisionType: DecisionType.DO_NOTHING,
                    confidence: 1.0,
                    reason: ""
                };

            default:
                return {
                    decisionType: DecisionType.WAIT,
                    confidence: 0.50,
                    reason: "Uncertain context"
                };
        }
    }

    /**
     * Mirrors PerceptionEngine's diagnostic signature (`code:line` pairs for all
     * diagnostics in the batch context) so the cooldown gate is evaluated against
     * the same hash used by the perception layer.
     */
    private buildDiagnosticSignature(context: Context): string {
        const data = context.data as Record<string, unknown> | undefined;
        const file = String(data?.["File"] ?? data?.["file"] ?? "");
        const errors = (Array.isArray(data?.["errors"]) ? data?.["errors"] : []) as Record<string, unknown>[];
        const warnings = (Array.isArray(data?.["warnings"]) ? data?.["warnings"] : []) as Record<string, unknown>[];
        const normalizedUri = file.split(/[\\/]/).join("/");
        const entries = [...errors, ...warnings]
            .map((e) => `${String(e["code"] ?? e["message"] ?? "")}:${Number(e["line"] ?? 1) - 1}`)
            .sort()
            .join("|");
        return `${normalizedUri}_${entries}`;
    }

    private buildDecision(context: Context, rule: DecisionRule): Decision {
        const data: Record<string, unknown> = { ...context.data };

        if (context.type === ContextType.USER_STUCK_ON_ERROR) {
            data["actionProfile"] = {
                expression: "confused",
                animation: "shake",
                speechPrompt: "Explain the syntax error friendly and simply"
            };
        }

        return {
            id: `dec-${context.id}`,
            type: rule.decisionType,
            confidence: rule.confidence,
            timestamp: Date.now(),
            reason: rule.reason,
            sourceContext: context,
            data
        };
    }
}
