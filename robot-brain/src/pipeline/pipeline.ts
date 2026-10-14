import * as vscode from "vscode";
import { EventFilter } from "../eventFilter/eventFilter";
import { AetherEvent } from "../eventFilter/event";
import { PerceptionEngine } from "../perception/perceptionEngine";
import type { Observation } from "../perception/observation";
import { ObservationType } from "../perception/observationType";
import { ContextEngine } from "../context/contextEngine";
import type { Context } from "../context/context";
import { DecisionEngine } from "../decision/decisionEngine";
import type { Decision } from "../decision/decision";
import { DecisionType } from "../decision/decisionType";
import { BehaviourController } from "../behaviour/behaviourController";
import { MotionPlanner } from "../motion/motionPlanner";
import { MotionController } from "../motionController/motionController";
import { AIExplanationEngine } from "../explanation/aiExplanationEngine";
import type { DiagnosticAnalysisRequest } from "../explanation/explanationTypes";
import { LearningAgent } from "../learning/learningAgent";
import { CompanionLoop } from "./companionLoop";
import { Logger } from "../utils/logger";

const PIPELINE_LOG_PREFIX = "PIPELINE";

export class CognitivePipeline {
    private eventFilter: EventFilter;
    private perception: PerceptionEngine;
    private context: ContextEngine;
    private decision: DecisionEngine;
    private behaviour: BehaviourController;
    private motionPlanner: MotionPlanner;
    private motionController: MotionController;
    private explanation: AIExplanationEngine;
    private learning: LearningAgent;
    private companion: CompanionLoop;
    private brainChannel: vscode.OutputChannel;
    private eventCount: number = 0;
    private startTime: number;
    private acesAdvisor:
        | ((context: Context) => {
            type: DecisionType;
            confidence: number;
            reason: string;
            data?: Record<string, unknown>;
        } | undefined)
        | undefined;

    constructor(
        eventFilter: EventFilter,
        brainChannel: vscode.OutputChannel,
        apiKeyRetriever: () => Promise<string | undefined>,
        apiErrorHandler: (status: number) => void,
        extensionContext: vscode.ExtensionContext
    ) {
        this.startTime = Date.now();
        this.eventFilter = eventFilter;
        this.brainChannel = brainChannel;

        this.perception = new PerceptionEngine();
        this.context = new ContextEngine();
        this.decision = new DecisionEngine();
        this.motionPlanner = new MotionPlanner();
        this.behaviour = new BehaviourController(this.motionPlanner);
        this.motionController = new MotionController();
        this.explanation = new AIExplanationEngine();
        this.learning = new LearningAgent(extensionContext);
        this.companion = new CompanionLoop(this.learning);

        this.explanation.setApiKeyRetriever(apiKeyRetriever);
        this.explanation.setApiErrorHandler(apiErrorHandler);
        // The learning profile (skill level + verbosity → effective explanation
        // length) must reach prompt construction, not just live in storage.
        this.refreshPromptContext();

        this.wire();
        this.logBrain("Pipeline initialized", `Modules: Perception, Context, Decision, Behaviour, Motion, Explanation, Learning`);
    }

    getPerception(): PerceptionEngine { return this.perception; }
    getContext(): ContextEngine { return this.context; }
    getDecision(): DecisionEngine { return this.decision; }
    getBehaviour(): BehaviourController { return this.behaviour; }
    getMotionPlanner(): MotionPlanner { return this.motionPlanner; }
    getMotionController(): MotionController { return this.motionController; }
    getExplanation(): AIExplanationEngine { return this.explanation; }
    getLearning(): LearningAgent { return this.learning; }
    getCompanion(): CompanionLoop { return this.companion; }

    /**
     * Attaches the Ace.X advisory path. When the advisor returns a mapped
     * ACES decision for a context, it is published through the DecisionEngine;
     * otherwise the existing rule path runs unchanged.
     */
    setAcesAdvisor(
        advisor:
            | ((context: Context) => {
                type: DecisionType;
                confidence: number;
                reason: string;
                data?: Record<string, unknown>;
            } | undefined)
            | undefined
    ): void {
        this.acesAdvisor = advisor;
    }

    /**
     * Re-reads the learning profile into Gemini prompt construction. Call this
     * whenever skill level or verbosity changes — the effective explanation
     * length (AUTO derives it from the profile) is applied in the engine's
     * prompt builder, so the setting actually shapes the prompt.
     */
    refreshPromptContext(): void {
        this.explanation.setPromptContext({ skillProfile: this.learning.getProfile() });
    }

    private wire(): void {
        // Skill changes re-derive the effective explanation length (AUTO mode),
        // so prompt construction must be refreshed whenever learning publishes.
        this.learning.getPublisher().subscribe(() => this.refreshPromptContext());

        // CompanionLoop is wired FIRST so it observes an observation BEFORE the
        // Context/Decision chain reacts to it: recurrence counts, struggle
        // signals and the attention target must be up to date when the teaching
        // decision is made for the same event.
        this.wireCompanion();
        this.wireEventFilterToPerception();
        this.wirePerceptionToContext();
        this.wirePerceptionBatchToExplanation();
        this.wireContextToDecision();
        this.wireDecisionToBehaviour();
        this.wireBehaviourToExplanation();
        this.wireBehaviourToMotion();
        this.wireExplanationToMotion();
    }

    private wireEventFilterToPerception(): void {
        this.eventFilter.subscribe((event: AetherEvent) => {
            this.eventCount++;
            this.logBrain("EventFilter → Perception", `${event.type} [${event.source}]`);
            this.perception.process(event);
        });
        this.logBrain("Wired", "EventFilter → PerceptionEngine");
    }

    private wirePerceptionToContext(): void {
        this.perception.getPublisher().subscribe((observation: Observation) => {
            if (observation.type === ObservationType.DIAGNOSTIC_BATCH) {
                return;
            }
            this.logBrain("Perception → Context", `${observation.type} conf=${observation.confidence.toFixed(2)}`);
            this.context.process(observation);
        });
        this.logBrain("Wired", "PerceptionEngine → ContextEngine");
    }

    private wirePerceptionBatchToExplanation(): void {
        this.perception.getPublisher().subscribe((observation: Observation) => {
            if (observation.type !== ObservationType.DIAGNOSTIC_BATCH) {
                return;
            }
            this.logBrain("Perception → Explanation (batch)", `${observation.type}`);
            this.handleBatchDiagnostic(observation).catch((err) => {
                this.logBrain("ERROR", `Batch diagnostic handler failed: ${String(err)}`);
            });
        });
        this.logBrain("Wired", "PerceptionEngine → AIExplanationEngine (batch diagnostic path)");
    }

    private async handleBatchDiagnostic(observation: Observation): Promise<void> {
        try {
            if (!this.companion.isMonitoringEnabled()) {
                // Monitoring off: no passive explanation work — not even the
                // context build, which reads the document. Explicit commands
                // build their own request and are unaffected.
                this.logBrain("AI (batch)", "Skipped — monitoring is off");
                return;
            }

            const raw = observation.data as Record<string, unknown>;
            const batchFile = String(raw["File"] ?? raw["file"] ?? "");
            const signature = String(raw["diagnosticBatchSignature"] ?? "");
            const rawErrors = Array.isArray(raw["errors"]) ? raw["errors"] : [];
            const rawWarnings = Array.isArray(raw["warnings"]) ? raw["warnings"] : [];

            if (rawErrors.length === 0 && rawWarnings.length === 0) {
                // A clean file has nothing to explain. The companion still saw
                // this batch (resolution/gaze release), but no Gemini call is
                // warranted and none is counted.
                this.logBrain("AI (batch)", "Skipped — no diagnostics in the file");
                return;
            }

            // The editor re-fires on every keystroke. Rebuilding the context (file
            // read + AST dependency resolution) and re-asking Gemini for an
            // UNCHANGED diagnostic set is exactly the waste the ladder exists to
            // prevent, so an unchanged set is dropped before any work is done. A
            // changed set — including the empty one — always gets through.
            if (signature && !this.perception.shouldBroadcastDiagnostic(batchFile, signature)) {
                this.logBrain("AI (batch)", "Skipped — diagnostic set unchanged (cooldown)");
                return;
            }
            if (signature) {
                this.perception.recordDiagnosticNotification(batchFile, signature);
            }

            const ctx = await this.context.buildDiagnosticContext(observation);
            this.logBrain("Context (batch)", `Built DIAGNOSTIC_ANALYSIS conf=${ctx.confidence.toFixed(2)}`);

            const data = ctx.data as Record<string, unknown>;
            const errors = (Array.isArray(data["errors"]) ? data["errors"] : []) as Record<string, unknown>[];
            const warnings = (Array.isArray(data["warnings"]) ? data["warnings"] : []) as Record<string, unknown>[];
            const file = String(data["file"] ?? "");
            const fileName = String(data["fileName"] ?? file.split(/[\\/]/).pop() ?? "");
            const language = String(data["language"] ?? "");
            const fileContent = String(data["fileContent"] ?? "");
            const resolvedDependencies = String(data["resolvedDependenciesText"] ?? "");

            const diagnosticErrors = errors.map((e) => ({
                line: Number(e["line"] ?? 0),
                column: Number(e["column"] ?? 0),
                message: String(e["message"] ?? ""),
                severity: String(e["severity"] ?? "error"),
                code: e["code"] ? String(e["code"]) : undefined
            }));

            const diagnosticWarnings = warnings.map((w) => ({
                line: Number(w["line"] ?? 0),
                column: Number(w["column"] ?? 0),
                message: String(w["message"] ?? ""),
                severity: String(w["severity"] ?? "warning"),
                code: w["code"] ? String(w["code"]) : undefined
            }));

            const primaryError = diagnosticErrors[0] || diagnosticWarnings[0];

            const request: DiagnosticAnalysisRequest = {
                file,
                fileName,
                language,
                fileContent,
                surroundingCode: (data["surroundingCode"] ?? {}) as Record<number, string>,
                errors: diagnosticErrors,
                warnings: diagnosticWarnings,
                errorCount: diagnosticErrors.length,
                warningCount: diagnosticWarnings.length,
                resolvedDependencies,
                errorText: primaryError?.message,
                filePath: file,
                line: primaryError?.line,
                severity: primaryError?.severity
            };

            this.logBrain("AI (batch)", `Requesting analysis: ${diagnosticErrors.length} errors, ${diagnosticWarnings.length} warnings`);

            // The ladder decides whether this is worth an AI call. Nothing below
            // this line runs unless the deterministic gate said yes.
            const matter = this.companion.matterKey(primaryError?.code, primaryError?.message ?? "");
            const worthAi = this.companion.shouldExplain({
                matter,
                severity: primaryError && primaryError.severity === "warning" ? "warning" : "error",
                confidence: ctx.confidence
            });
            if (!worthAi) {
                this.logBrain("AI (batch)", `Skipped — deterministic ladder answered: ${matter}`);
                return;
            }

            const explanation = await this.explanation.analyzeDiagnostics(request);
            // Only a real Gemini answer counts as delivered — a deterministic
            // fallback after a failed call is "requested but not executed".
            if (explanation.source === 'gemini') {
                this.companion.noteExplanationDelivered(matter);
            }
            this.logBrain("AI (batch)", `Explanation published (${explanation.source ?? "unknown source"})`);
        } catch (err) {
            this.logBrain("ERROR", `Batch diagnostic analysis failed: ${String(err)}`);
        }
    }

    private wireContextToDecision(): void {
        this.context.getPublisher().subscribe((ctx: Context) => {
            this.logBrain("Context → Decision", `${ctx.type} conf=${ctx.confidence.toFixed(2)}`);
            const advised = this.acesAdvisor?.(ctx);
            if (advised) {
                this.logBrain("ACES → Decision", `${advised.type} reason="${advised.reason}"`);
                this.decision.processAcesRecommendation(ctx, advised);
                return;
            }
            this.decision.process(ctx);
        });
        this.logBrain("Wired", "ContextEngine → DecisionEngine (+ ACES advisor)");
    }

    private wireDecisionToBehaviour(): void {
        this.decision.getPublisher().subscribe((decision: Decision) => {
            if (this.companion.isExplicitAnswerActive()) {
                // An explicit answer is still on screen: the state machine's
                // EMOTION sequence would clear it on the Body. The CompanionLoop
                // still records this decision (suppressed) for the timeline.
                this.logBrain("Decision → Behaviour", `Deferred — explicit answer on screen (${decision.type})`);
                return;
            }
            this.logBrain("Decision → Behaviour", `${decision.type} reason="${decision.reason}"`);
            this.behaviour.process(decision);
        });
        this.logBrain("Wired", "DecisionEngine → BehaviourController");
    }

    private wireBehaviourToExplanation(): void {
        this.behaviour.getPublisher().subscribe((event) => {
            if (this.companion.ownsExplanation(event.action)) {
                // The gated batch path is the single owner of diagnostic
                // explanations: it either spent a Gemini call on this mistake or
                // counted the call the ladder deliberately avoided. Explaining it
                // again here would put a second bubble on screen for one error
                // and would spend Gemini outside the gate, so the spend summary
                // would under-report what was actually bought.
                this.logBrain("Behaviour → Explanation", `Suppressed — companion ladder owns ${event.action}`);
                return;
            }
            this.logBrain("Behaviour → Explanation", `${event.action}`);
            this.explanation.process(event);
        });
        this.logBrain("Wired", "BehaviourController → AIExplanationEngine");
    }

    private wireBehaviourToMotion(): void {
        this.behaviour.getPublisher().subscribe((event) => {
            this.logBrain("Behaviour → Motion", `${event.action}`);
            this.motionPlanner.processFromEvent(event);
        });
        this.motionPlanner.getPublisher().subscribe((plan) => {
            this.logBrain("MotionPlanner → MotionController", `${plan.motions.length} motion(s) priority=${plan.priority}`);
            this.motionController.executePlan(plan);
        });
        this.logBrain("Wired", "BehaviourController → MotionPlanner → MotionController");
    }

    private wireExplanationToMotion(): void {
        this.explanation.getPublisher().subscribe((explanation) => {
            if (this.companion.isExplicitAnswerActive()) {
                // A passive explanation that finished while the user's explicit
                // answer is on screen must not drive motion — the ACTION speech
                // frame would replace the answer on the Body. Accounting already
                // recorded it as delivered; only the expression is withheld.
                this.logBrain("Explanation → Motion", "Deferred — explicit answer on screen");
                return;
            }
            this.logBrain("Explanation → Motion", `${explanation.type} action=${explanation.action}`);
            this.motionPlanner.processFromExplanation(explanation);
        });
        this.logBrain("Wired", "AIExplanationEngine → MotionPlanner");
    }

    private wireCompanion(): void {
        this.perception.getPublisher().subscribe((observation: Observation) => {
            this.companion.observe(observation);
        });
        this.decision.getPublisher().subscribe((decision: Decision) => {
            this.companion.processDecision(decision);
        });
        this.logBrain("Wired", "CompanionLoop ← Perception + Decision (teaching/interruption/attention/timeline)");
    }

    getStats(): { uptime: number; eventsProcessed: number } {
        return {
            uptime: Date.now() - this.startTime,
            eventsProcessed: this.eventCount
        };
    }

    private logBrain(stage: string, detail: string): void {
        const msg = `[${PIPELINE_LOG_PREFIX}] ${stage}: ${detail}`;
        this.brainChannel.appendLine(msg);
    }
}
