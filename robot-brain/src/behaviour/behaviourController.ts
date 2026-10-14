import * as vscode from 'vscode';
import { DecisionType } from "../decision/decisionType";
import type { Decision } from "../decision/decision";
import { BehaviourAction } from "./behaviourAction";
import { RobotBehaviourState, BehaviourState } from "./behaviourState";
import { BehaviourPublisher, BehaviourEvent } from "./behaviourPublisher";
import { FSM } from "./fsm";
import { Logger } from "../utils/logger";
import { sendToRobot } from "../utils/websocketServer";
import type { AvatarExpression, AvatarAction, RobotCommand, RobotStateUpdatePayload } from "../core/types";
import { clampIntensity, deriveIntensity, emitEmotion, emotionForExpression, emotionForState } from "./emotionMapper";
import type { SkillLevel } from "../learning/skillProfile";
import { MotionPlanner } from "../motion/motionPlanner";
import type { EnvironmentStatus } from "../sensors/environmentSensor";
import type { DeprecatedApiUsage } from "../sensors/importInspector";

export class BehaviourController {
    private state: BehaviourState;
    private publisher: BehaviourPublisher;
    private fsm: FSM;
    private motionPlanner?: MotionPlanner;
    private stateMachineRunning: boolean = false;

    constructor(motionPlanner?: MotionPlanner) {
        this.state = new BehaviourState();
        this.publisher = new BehaviourPublisher();
        this.fsm = new FSM();
        this.motionPlanner = motionPlanner;
    }

    process(decision: Decision): void {
        if (!this.state.robotEnabled) {
            return;
        }

        const action = this.resolveAction(decision.type);

        if (action === BehaviourAction.NONE) {
            return;
        }

        if (this.state.isBusy || this.stateMachineRunning) {
            this.fsm.transition(RobotBehaviourState.COOLDOWN);
            this.state.currentState = RobotBehaviourState.COOLDOWN;
            Logger.info("BEHAVIOUR", {
                "State": "COOLDOWN",
                "Action": action,
                "Reason": "Behaviour busy, rejecting new action"
            });
            return;
        }

        const isIdleTransition = action === BehaviourAction.CELEBRATE ||
                                 action === BehaviourAction.ASK_USER ||
                                 action === BehaviourAction.SHOW_HINT ||
                                 action === BehaviourAction.SHOW_DOCUMENTATION ||
                                 action === BehaviourAction.SHOW_EXTENSION_HELP ||
                                 action === BehaviourAction.SHOW_GIT_HELP;

        if (isIdleTransition) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const diags = vscode.languages.getDiagnostics(editor.document.uri);
                const hasActiveErrors = diags.some(d =>
                    d.severity === vscode.DiagnosticSeverity.Error
                );
                if (hasActiveErrors) {
                    Logger.info("BEHAVIOUR", {
                        "State": "LOCKED",
                        "Action": action,
                        "Reason": "Active diagnostics prevent idle transition"
                    });
                    return;
                }
            }
        }

        this.state.lastAction = action;
        this.state.lastActionTime = Date.now();

        // Fast-track: immediately notify WebSocket clients on error help
        if (action === BehaviourAction.SHOW_ERROR_HELP || action === BehaviourAction.SHOW_WARNING) {
            sendToRobot({ type: "ACTION", animation: "thinking" });
        }

        const event: BehaviourEvent = {
            action,
            state: RobotBehaviourState.SPEAKING,
            timestamp: Date.now(),
            data: decision.data ? { ...decision.data } : undefined
        };

        this.publisher.publish(event);

        Logger.info("BEHAVIOUR", {
            "State": RobotBehaviourState.SPEAKING,
            "Action": action,
            "Timestamp": new Date(event.timestamp).toISOString()
        });

        this.runTimedStateMachine(action);
    }

    /**
     * Progressive Intervention — Phase 1 (Developer Tries First). When a
     * squiggly error appears, transition the FSM to THINKING silently: no
     * popup, no WebSocket broadcast, no edits to the user's code. The developer
     * keeps the space to fix it on their own first.
     */
    enterThinkingSilently(): void {
        if (!this.state.robotEnabled) {
            return;
        }
        if (this.state.currentState !== RobotBehaviourState.IDLE &&
            this.state.currentState !== RobotBehaviourState.OBSERVING) {
            return;
        }
        this.fsm.transition(RobotBehaviourState.OBSERVING);
        this.fsm.transition(RobotBehaviourState.THINKING);
        this.state.currentState = RobotBehaviourState.THINKING;
        this.state.lastAction = BehaviourAction.SHOW_HINT;
        this.state.lastActionTime = Date.now();
        // Silent means silent: no caption, and the thinking read is capped low
        // so a glance at the robot is enough to notice, not enough to interrupt.
        emitEmotion("THINKING", {
            intensity: deriveIntensity({ base: 0.3, silent: true }),
        });
        Logger.info("BEHAVIOUR", {
            "State": RobotBehaviourState.THINKING,
            "Event": "Phase 1 — silent THINKING (developer tries first)"
        });
    }

    /**
     * Cleanly forces the robot back to IDLE without broadcasting any speech
     * bubble or intermediate alert. Used by the guard clause when a file is
     * blank/whitespace or has zero diagnostics.
     */
    forceIdle(): void {
        this.state.currentState = RobotBehaviourState.IDLE;
        this.state.lastAction = BehaviourAction.NONE;
        this.state.lastActionTime = 0;
        this.fsm.reset();
        Logger.info("BEHAVIOUR", {
            "State": RobotBehaviourState.IDLE,
            "Event": "Guard clause — clean IDLE (no speech)"
        });
    }

/**
     * Releases the robot back to a resting posture after a proactive alert has
     * had its full duration, and tells the Body to do the same.
     *
     * The FSM transition alone is not enough: the Body holds the last emotion it
     * was given for its own duration, so without this frame a robot that
     * showed ALERT would keep holding that posture long after the Brain decided
     * the alert was over.
     *
     * @param expectedState only release if we are still in the state that armed the timer
     */
    private releaseToIdle(expectedState: RobotBehaviourState): void {
        if (this.state.currentState !== expectedState) {
            return;
        }

        this.state.currentState = RobotBehaviourState.IDLE;
        this.state.lastAction = BehaviourAction.NONE;
        this.state.lastActionTime = 0;
        this.fsm.reset();
        emitEmotion(emotionForState(RobotBehaviourState.IDLE), { intensity: 0 });

        Logger.info("BEHAVIOUR", {
            "State": RobotBehaviourState.IDLE,
            "Event": "Proactive alert released to neutral"
        });
    }

    /**
     * Reacts to a STUCK_* observation from the Perception Engine (e.g. rapid
     * saves or idle code focus). Transitions the FSM to PROACTIVE_ASSIST and
     * dispatches an immediate intermediate state to robot-body via WebSocket.
     */
    onStuckObservation(observation: { type: string; timestamp: number; data?: Record<string, unknown> }): void {
        if (!this.state.robotEnabled) {
            return;
        }

        if (this.state.isBusy || this.stateMachineRunning) {
            Logger.info("BEHAVIOUR", {
                "State": "BLOCKED",
                "Observation": observation.type,
                "Reason": "Behaviour busy, skipping proactive assist"
            });
            return;
        }

        this.fsm.transition(RobotBehaviourState.PROACTIVE_ASSIST);
        this.state.currentState = RobotBehaviourState.PROACTIVE_ASSIST;
        this.state.lastAction = BehaviourAction.SHOW_HINT;
        this.state.lastActionTime = Date.now();

        Logger.info("BEHAVIOUR", {
            "State": RobotBehaviourState.PROACTIVE_ASSIST,
            "Observation": observation.type,
            "Reason": "Stuck state detected"
        });

        // broadcastRobotStateUpdate also emits the canonical EMOTION frame for
        // this expression, so the robot shows ALERT with the caption above.
        this.broadcastRobotStateUpdate(
            "ALERT",
            "Looks like you might be stuck here! Need a quick logic review?",
            0
        );

        // Let the robot return to a neutral state so it can act again.
        setTimeout(() => this.releaseToIdle(RobotBehaviourState.PROACTIVE_ASSIST), 8000);
    }

    /**
     * Reacts to a workspace environment check (EnvironmentSensor). Missing env
     * variables or uninstalled packages transition the FSM to PROACTIVE_ASSIST
     * (Phase 1) and dispatch a non-intrusive speech bubble to robot-body
     * (Phase 2). A cleanly configured workspace returns the robot to IDLE.
     */
    onEnvironmentStatus(status: EnvironmentStatus): void {
        if (!this.state.robotEnabled) {
            return;
        }

        if (status.clean) {
            if (this.state.currentState !== RobotBehaviourState.IDLE) {
                this.forceIdle();
            }
            return;
        }

        if (this.state.isBusy || this.stateMachineRunning) {
            Logger.info("BEHAVIOUR", {
                "State": "BLOCKED",
                "Event": "Environment status ignored",
                "Reason": "Behaviour busy, skipping environment alert"
            });
            return;
        }

        const missingKeyCount = status.missingEnvKeys.length;
        const dependenciesMissing = status.hasPackageJson && !status.dependenciesInstalled;

        // Phase 1 — set robot state to WORRIED/ALERT.
        this.fsm.transition(RobotBehaviourState.PROACTIVE_ASSIST);
        this.state.currentState = RobotBehaviourState.PROACTIVE_ASSIST;
        this.state.lastAction = BehaviourAction.SHOW_WARNING;
        this.state.lastActionTime = Date.now();

        Logger.info("BEHAVIOUR", {
            "State": RobotBehaviourState.PROACTIVE_ASSIST,
            "Event": "Workspace setup incomplete",
            "Missing env keys": String(missingKeyCount),
            "Dependencies installed": dependenciesMissing ? "No" : "Yes"
        });

        // Phase 2 — dispatch a non-intrusive speech bubble to robot-body.
        const parts: string[] = [];
        if (missingKeyCount > 0) {
            parts.push(`${missingKeyCount} environment key${missingKeyCount === 1 ? "" : "s"} missing`);
        }
        if (dependenciesMissing) {
            parts.push("dependencies not installed");
        }
        const speech = `Workspace setup incomplete: ${parts.join(", ")}.`;
        const expression = dependenciesMissing && missingKeyCount === 0 ? "ALERT" : "worried";
        // One canonical EMOTION frame for this trigger, carried by
        // broadcastRobotStateUpdate. Severity "warning" keeps it at alert
        // strength rather than error strength — an unconfigured workspace is
        // worth noticing, not flinching at — while problemCount scales it with
        // how much is actually missing.
        this.broadcastRobotStateUpdate(expression, speech, missingKeyCount + (dependenciesMissing ? 1 : 0), {
            severity: "warning"
        });

// Let the robot return to a neutral state so it can act again.
        setTimeout(() => this.releaseToIdle(RobotBehaviourState.PROACTIVE_ASSIST), 8000);
    }

    /**
     * Reacts to Git merge conflict detected in an open document
     * (GitConflictSensor). Phase 1 silently transitions the FSM to
     * PROACTIVE_ASSIST (ALERT/CONFUSED). Phase 2 broadcasts a speech bubble to
     * robot-body summarizing how many conflict blocks need attention.
     */
    onGitConflictDetected(conflictCount: number, fileName: string): void {
        if (!this.state.robotEnabled) {
            return;
        }

        if (this.state.isBusy || this.stateMachineRunning) {
            Logger.info("BEHAVIOUR", {
                "State": "BLOCKED",
                "Event": "Git conflict alert ignored",
                "Reason": "Behaviour busy"
            });
            return;
        }

        // Phase 1 — silent ALERT/CONFUSED transition.
        this.fsm.transition(RobotBehaviourState.PROACTIVE_ASSIST);
        this.state.currentState = RobotBehaviourState.PROACTIVE_ASSIST;
        this.state.lastAction = BehaviourAction.SHOW_GIT_HELP;
        this.state.lastActionTime = Date.now();

        Logger.info("BEHAVIOUR", {
            "State": RobotBehaviourState.PROACTIVE_ASSIST,
            "Event": "Git merge conflict detected",
            "File": fileName,
            "Blocks": String(conflictCount)
        });

        // Phase 2 — speech bubble to robot-body (port 8055).
        const label = conflictCount === 1 ? "block" : "blocks";
        this.broadcastRobotStateUpdate(
            "ALERT",
            `Git Merge Conflict: ${conflictCount} ${label} need resolution in this file.`,
            conflictCount
        );

        // Let the robot return to a neutral state so it can act again.
        setTimeout(() => this.releaseToIdle(RobotBehaviourState.PROACTIVE_ASSIST), 8000);
    }

    /**
     * Reacts to all conflict markers being removed from a document. Transitions
     * the robot cleanly back to HAPPY/IDLE.
     */
    onGitConflictResolved(fileName: string): void {
        if (!this.state.robotEnabled) {
            return;
        }

        this.forceIdle();
        this.broadcastRobotStateUpdate("HAPPY", "Conflict resolved — nice work!", 0);
        Logger.info("BEHAVIOUR", {
            "State": RobotBehaviourState.IDLE,
            "Event": "Git conflict resolved",
            "File": fileName
        });
    }

    /**
     * Phase 1 of deprecated API detection. Silently transitions the FSM to
     * THINKING so the developer keeps their flow; the non-intrusive speech
     * bubble (Phase 2) is dispatched post-debounce by the extension wiring.
     */
    onDeprecatedApiDetected(deprecations: DeprecatedApiUsage[]): void {
        if (!this.state.robotEnabled) {
            return;
        }
        if (this.state.currentState !== RobotBehaviourState.IDLE &&
            this.state.currentState !== RobotBehaviourState.OBSERVING) {
            return;
        }

        this.fsm.transition(RobotBehaviourState.OBSERVING);
        this.fsm.transition(RobotBehaviourState.THINKING);
        this.state.currentState = RobotBehaviourState.THINKING;
        this.state.lastAction = BehaviourAction.SHOW_WARNING;
        this.state.lastActionTime = Date.now();

        // Deprecated API is a warning, not a failure: ALERT rather than ERROR,
        // and still quiet enough not to break the developer's flow.
        emitEmotion("ALERT", {
            intensity: deriveIntensity({ severity: "warning", problemCount: deprecations.length, base: 0.35, silent: true }),
        });

        Logger.info("BEHAVIOUR", {
            "State": RobotBehaviourState.THINKING,
            "Event": "Phase 1 — silent THINKING (deprecated API)",
            "Deprecations": String(deprecations.length)
        });
    }

    private async runTimedStateMachine(action: BehaviourAction): Promise<void> {
        this.stateMachineRunning = true;
        try {
const OBSERVE_MS = 50;
            const THINK_MS = 100;
            const WAIT_MS = 500;

            const actionDuration = this.resolveActionDuration(action);
            // How hard the robot feels this particular action. Errors speak
            // louder; a hint is deliberately quiet.
            const intensity = this.intensityForAction(action);

            // Emotional ramp across the sequence: the robot notices quietly,
            // thinks with a little more commitment, then delivers the point at
            // full strength for the action. This is what makes the transition
            // read as a considered reaction rather than a single state flip.
            this.fsm.transition(RobotBehaviourState.OBSERVING);
            this.state.currentState = RobotBehaviourState.OBSERVING;
            Logger.info('BEHAVIOUR', { "State": RobotBehaviourState.OBSERVING, "Action": action });
            emitEmotion(emotionForState(RobotBehaviourState.OBSERVING), {
                intensity: clampIntensity(intensity * 0.7),
                duration: OBSERVE_MS + THINK_MS,
            });

            await this.delay(OBSERVE_MS);

            this.fsm.transition(RobotBehaviourState.THINKING);
            this.state.currentState = RobotBehaviourState.THINKING;
            Logger.info('BEHAVIOUR', { "State": RobotBehaviourState.THINKING, "Action": action });
            emitEmotion(emotionForState(RobotBehaviourState.THINKING), {
                intensity: clampIntensity(intensity * 0.9),
            });

            await this.delay(THINK_MS);

            this.fsm.transition(RobotBehaviourState.SPEAKING);
            this.state.currentState = RobotBehaviourState.SPEAKING;
            Logger.info('BEHAVIOUR', { "State": RobotBehaviourState.SPEAKING, "Action": action });
            emitEmotion(emotionForState(RobotBehaviourState.SPEAKING), { intensity });

            this.fsm.transition(RobotBehaviourState.WAITING);
            this.state.currentState = RobotBehaviourState.WAITING;
            Logger.info('BEHAVIOUR', { "State": RobotBehaviourState.WAITING, "Action": action });

            await this.delay(actionDuration + WAIT_MS);

            this.fsm.transition(RobotBehaviourState.IDLE);
            this.state.currentState = RobotBehaviourState.IDLE;
            Logger.info('BEHAVIOUR', { "State": RobotBehaviourState.IDLE, "Action": action });
            emitEmotion(emotionForState(RobotBehaviourState.IDLE), { intensity: 0 });
            sendToRobot({ type: "ACTION", animation: "neutral" });
        } catch (err) {
            Logger.info("BEHAVIOUR", {
                "State": "ERROR",
                "Action": action,
                "Reason": `State machine error: ${String(err)}`
            });
        } finally {
            this.stateMachineRunning = false;
        }
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Base intensity for a behaviour action. Everything user-visible keys off
     * the action rather than the FSM state, because the state is the same
     * (SPEAKING) whether the robot is apologising for a compiler error or
     * offering to open the docs.
     */
    private intensityForAction(action: BehaviourAction): number {
        switch (action) {
            case BehaviourAction.SHOW_ERROR_HELP:
                return 0.9;
            case BehaviourAction.SHOW_WARNING:
                return 0.7;
            case BehaviourAction.SHOW_DEBUG_HELP:
            case BehaviourAction.SHOW_GIT_HELP:
                return 0.6;
            case BehaviourAction.CELEBRATE:
                return 0.85;
            case BehaviourAction.SHOW_HINT:
            case BehaviourAction.ASK_USER:
                return 0.45;
            case BehaviourAction.SHOW_DOCUMENTATION:
            case BehaviourAction.SHOW_EXTENSION_HELP:
                return 0.35;
            default:
                return 0.5;
        }
    }

    private resolveActionDuration(action: BehaviourAction): number {
        switch (action) {
            case BehaviourAction.SHOW_ERROR_HELP:
                return 5000;
            case BehaviourAction.SHOW_DEBUG_HELP:
                return 4000;
            case BehaviourAction.SHOW_GIT_HELP:
            case BehaviourAction.SHOW_EXTENSION_HELP:
                return 3000;
            case BehaviourAction.SHOW_HINT:
            case BehaviourAction.SHOW_WARNING:
            case BehaviourAction.SHOW_DOCUMENTATION:
                return 2500;
            case BehaviourAction.CELEBRATE:
                return 3000;
            default:
                return 2000;
        }
    }

    getState(): BehaviourState {
        return this.state;
    }

    /**
     * Receives the expression output from the explanation agent (Gemini) and
     * broadcasts a structured ROBOT_STATE_UPDATE message to robot-body. When an
     * optional `errorInfo` is supplied, the exact compiler error (message,
     * relative file path, 1-based line, severity) rides inside the payload so
     * robot-body can render the REAL error inline and cue the alert chime.
     */
    broadcastRobotStateUpdate(
        expression: string,
        speechBubble: string,
        fixCount: number,
        errorInfo?: { errorText?: string; filePath?: string; line?: number; severity?: string }
    ): void {
        const payload: RobotStateUpdatePayload = {
            type: "ROBOT_STATE_UPDATE",
            payload: {
                expression,
                speechBubble,
                fixCount,
                timestamp: Date.now(),
                errorText: errorInfo?.errorText,
                filePath: errorInfo?.filePath,
                line: errorInfo?.line,
                severity: errorInfo?.severity
            }
        };

        sendToRobot(payload);

        // Alongside the legacy ROBOT_STATE_UPDATE (still consumed by other
        // listeners), emit the canonical emotion so the robot's face and posture
        // come from one vocabulary. Severity and fix count decide intensity;
        // an unrecognised expression falls back to ALERT rather than inventing
        // a new emotion, because this message is always about a real problem.
        const emotion = emotionForExpression(expression) ?? "ALERT";
        emitEmotion(emotion, {
            intensity: deriveIntensity({
                severity: errorInfo?.severity,
                problemCount: fixCount,
                base: 0.5,
            }),
            speech: speechBubble,
        });

        Logger.info("ROBOT", {
            "Event": "ROBOT_STATE_UPDATE broadcast",
            "Expression": expression,
            "Emotion": emotion,
            "Speech": speechBubble.slice(0, 80),
            "FixCount": String(fixCount)
        });
    }

    getPublisher(): BehaviourPublisher {
        return this.publisher;
    }

    enable(): void {
        this.state.robotEnabled = true;
        this.fsm.reset();
        this.state.currentState = RobotBehaviourState.IDLE;
    }

    disable(): void {
        this.state.robotEnabled = false;
        this.fsm.transition(RobotBehaviourState.DISABLED);
        this.state.currentState = RobotBehaviourState.DISABLED;
    }

    triggerState(event: string, skillLevel?: SkillLevel, contextData?: Record<string, unknown>): void {
        // Passive sensor-driven expression (e.g. git commit/conflict) is part
        // of monitoring: when monitoring is off this must stay silent too.
        if (!this.state.robotEnabled) {
            return;
        }
        const mapping = this.resolveStateMapping(event, skillLevel);
        if (!mapping) {
            return;
        }

        let targetX: number | undefined;
        let targetY: number | undefined;
        let alignment: 'left-editor' | 'right-editor' | 'bottom-panel' | 'floating' | undefined;

        if (contextData?.editor && typeof contextData.line === 'number' && this.motionPlanner) {
            const anchor = this.motionPlanner.calculateEditorAnchor(
                contextData.editor as import('vscode').TextEditor,
                contextData.line as number,
            );
            targetX = anchor.targetX;
            targetY = anchor.targetY;
            alignment = anchor.alignment;
        } else if (!contextData && (event === 'COMPILING_SUCCESS' || event === 'GIT_COMMIT_SUCCESS')) {
            targetX = 400;
            targetY = 300;
            alignment = 'floating';
        }

        if (event === 'USER_STUCK_ON_ERROR' && contextData?.editor) {
            mapping.action = 'POINT_LEFT';
        }

        const command: RobotCommand = {
            type: 'ROBOT_STATE',
            expression: mapping.expression,
            action: mapping.action,
            speechBubble: mapping.speechBubble,
            duration: mapping.duration,
        };

        if (targetX !== undefined) {
            command.targetX = targetX;
            command.targetY = targetY;
            command.alignment = alignment;
            console.log(`[ACTUATOR] Synchronizing state ${mapping.expression} with target coordinates (X: ${targetX}, Y: ${targetY})`);
        }

        sendToRobot(command);

        // Canonical emotion for the same trigger, so the robot's posture comes
        // from the closed vocabulary rather than from the expression string
        // alone (which has no intensity dimension). Success is the one trigger
        // worth being loud about — it is the payoff the user was working toward.
        const emotion = emotionForExpression(mapping.expression);
        if (emotion) {
            emitEmotion(emotion, {
                intensity: deriveIntensity({ base: emotion === "HAPPY" ? 0.85 : 0.7 }),
                speech: mapping.speechBubble,
                duration: mapping.duration,
            });
        }

        const targetStr = targetX !== undefined ? `(X: ${targetX}, Y: ${targetY})` : '(floating)';
        Logger.pipelineTrace({
            actuator: `Target ${targetStr}`,
            actuatorTarget: mapping.action,
            express: mapping.expression,
            expressSpeech: mapping.speechBubble,
        });
    }

    private resolveStateMapping(event: string, skillLevel?: SkillLevel): { expression: AvatarExpression; action: AvatarAction; speechBubble: string; duration: number } | null {
        switch (event) {
            case 'GIT_COMMIT_SUCCESS':
                return { expression: 'happy', action: 'JUMP', speechBubble: 'Push successful! You rock!', duration: 4000 };
            case 'GIT_MERGE_CONFLICT':
                return { expression: 'shocked', action: 'ALERT_RED', speechBubble: 'Oh no! Merge conflict detected!', duration: 5000 };
            case 'DIAGNOSTIC_ERROR_FOUND':
                return { expression: 'thinking', action: 'NOD', speechBubble: 'Diagnostic error detected at cursor. Inspecting.', duration: 4000 };
            case 'COMPILING_SUCCESS':
                return { expression: 'thinking', action: 'NOD', speechBubble: 'Build passed cleanly! Nice code.', duration: 4000 };
            case 'USER_STUCK_ON_ERROR':
                return { expression: 'thinking', action: 'NOD', speechBubble: 'Diagnosing error at cursor. Analyzing diagnostic data.', duration: 4000 };
            default:
                return null;
        }
    }

    private resolveAction(decisionType: DecisionType): BehaviourAction {
        switch (decisionType) {
            case DecisionType.SHOW_ERROR_HELP:
                return BehaviourAction.SHOW_ERROR_HELP;

            case DecisionType.SHOW_WARNING:
                return BehaviourAction.SHOW_WARNING;

            case DecisionType.SHOW_HINT:
                return BehaviourAction.SHOW_HINT;

            case DecisionType.SUGGEST_DOCUMENTATION:
                return BehaviourAction.SHOW_DOCUMENTATION;

            case DecisionType.SUGGEST_DEBUGGING:
                return BehaviourAction.SHOW_DEBUG_HELP;

            case DecisionType.SUGGEST_GIT_ACTION:
                return BehaviourAction.SHOW_GIT_HELP;

            case DecisionType.SUGGEST_EXTENSION:
                return BehaviourAction.SHOW_EXTENSION_HELP;

            case DecisionType.CONGRATULATE:
                return BehaviourAction.CELEBRATE;

            case DecisionType.ASK_USER:
                return BehaviourAction.ASK_USER;

            case DecisionType.WAIT:
            case DecisionType.DO_NOTHING:
            case DecisionType.UNKNOWN:
            default:
                return BehaviourAction.NONE;
        }
    }
}
