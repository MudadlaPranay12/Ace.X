import type { EmotionName, EmotionPayload } from "../core/types";
import { RobotBehaviourState } from "./behaviourState";
import { sendToRobot } from "../utils/websocketServer";
import { Logger } from "../utils/logger";

/**
 * emotionMapper — the Brain side of the canonical emotion channel.
 *
 * The Body owns the vocabulary and the visual meaning (robot-body/behaviour/
 * emotion.js). The Brain's job is narrower: take what it already knows — an FSM
 * state, an AvatarExpression from the explanation model, a severity, how many
 * problems exist — and decide which of the eight emotions to express and how
 * hard.
 *
 * Intensity is derived, never invented by a model. A free-text "expression" that
 * arrives from Gemini is mapped onto the fixed set; nothing downstream ever
 * receives an emotion string that is not in `EmotionName`.
 */

/** FSM state → canonical emotion. One-to-one where possible. */
const STATE_TO_EMOTION: Record<RobotBehaviourState, EmotionName> = {
    [RobotBehaviourState.IDLE]: "IDLE",
    [RobotBehaviourState.OBSERVING]: "LISTENING",
    [RobotBehaviourState.THINKING]: "THINKING",
    [RobotBehaviourState.SPEAKING]: "SPEAKING",
    [RobotBehaviourState.WAITING]: "LISTENING",
    [RobotBehaviourState.COOLDOWN]: "IDLE",
    [RobotBehaviourState.PROACTIVE_ASSIST]: "ALERT",
    [RobotBehaviourState.DISABLED]: "IDLE",
};

/**
 * AvatarExpression (the existing, model-supplied vocabulary) → canonical
 * emotion. The Brain still sends the legacy ROBOT_STATE/ROBOT_STATE_UPDATE
 * messages for anything else that consumes them; this map only decides what the
 * robot *feels*, and it collapses the model's richer wording onto a closed set.
 *
 * `sad` maps to ALERT rather than ERROR on purpose. The model uses "sad" for
 * ordinary disappointment, not for a tool having failed; ERROR is reserved for
 * things that actually broke.
 */
const EXPRESSION_TO_EMOTION: Record<string, EmotionName> = {
    happy: "HAPPY",
    neutral: "IDLE",
    idle: "IDLE",
    sleeping: "IDLE",
    thinking: "THINKING",
    confused: "CONFUSED",
    worried: "ALERT",
    alert: "ALERT",
    shocked: "ALERT",
    sad: "ALERT",
    error: "ERROR",
    broken: "ERROR",
    failed: "ERROR",
};

function clamp01(value: number): number {
    if (!Number.isFinite(value)) {
        return 0.5;
    }
    return Math.max(0, Math.min(1, value));
}

/**
 * Clamps an intensity, rounded to two decimals. Exported so callers doing
 * arithmetic on a base intensity (e.g. lowering it for the silent phase) cannot
 * emit an out-of-range or noisy-precision value.
 */
export function clampIntensity(value: number): number {
    return clamp01(Number(value.toFixed(2)));
}

/**
 * Strength of a feeling, from signals the Brain already has.
 *
 * Deliberately conservative: severity moves it the most, because a compiler
 * error the user has not seen yet is genuinely more urgent than one they have
 * already been told about four times. Repeat counts saturate quickly so the
 * robot does not become progressively more frantic as the user works.
 */
export function deriveIntensity(options: {
    severity?: string;
    problemCount?: number;
    silent?: boolean;
    base?: number;
}): number {
    const base = options.base ?? 0.5;

    let intensity = base;

    const severity = (options.severity || "").toLowerCase();
    if (severity === "error") {
        intensity += 0.3;
    } else if (severity === "warning") {
        intensity += 0.15;
    } else if (severity === "info" || severity === "hint") {
        intensity += 0;
    }

    if (typeof options.problemCount === "number" && options.problemCount > 0) {
        // log1p keeps 20 errors from looking like a crisis 5x worse than 1.
        intensity += Math.min(0.15, Math.log1p(options.problemCount) * 0.06);
    }

    // A silent, progressive observation should never be delivered at full
    // strength — the whole point of the silent phase is non-intrusiveness.
    if (options.silent) {
        intensity = Math.min(intensity, 0.35);
    }

    return clamp01(Number(intensity.toFixed(2)));
}

/**
 * Canonical emotion for a Brain FSM state. Every FSM state has a mapping —
 * WAITING returns LISTENING because the robot is watching the user work, not
 * because it has an emotion of its own about it.
 */
export function emotionForState(state: RobotBehaviourState): EmotionName {
    return STATE_TO_EMOTION[state] ?? "IDLE";
}

/**
 * Canonical emotion for a model-supplied expression string.
 *
 * Returns null for an unrecognised value rather than guessing. Callers that
 * must emit something (e.g. an error report) choose ALERT themselves; callers
 * that can stay silent do.
 */
export function emotionForExpression(expression: string | undefined): EmotionName | null {
    if (!expression) {
        return null;
    }
    const key = expression.trim().toLowerCase();
    return EXPRESSION_TO_EMOTION[key] ?? null;
}

/**
 * How long a piece of text should stay on screen, approximated from reading
 * speed (~220 words/minute, plus a floor for very short text).
 *
 * The companion has no audio output, so a caption is the entire delivery of a
 * reply — sizing it by duration is what stops an answer from disappearing
 * halfway through being read.
 *
 * @param text caption text
 */
export function textHoldMs(text: string): number {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return Math.max(3000, Math.min(15000, 1000 + words * 275));
}

/**
 * Sends one EMOTION frame. The Body holds it for its own per-emotion default
 * unless `duration` is given, so callers that only care about the transition
 * (FSM changes) do not have to know the hold timings.
 */
export function emitEmotion(
    emotion: EmotionName,
    options: { intensity?: number; speech?: string; duration?: number } = {}
): void {
    const payload: EmotionPayload = { type: "EMOTION", emotion };

    if (typeof options.intensity === "number") {
        payload.intensity = clamp01(options.intensity);
    }
    if (options.speech) {
        payload.speech = options.speech;
    }
    if (typeof options.duration === "number" && options.duration > 0) {
        payload.duration = Math.min(options.duration, 15000);
    }

    sendToRobot(payload);

    Logger.info("EMOTION", {
        "Emotion": payload.emotion,
        "Intensity": String(payload.intensity ?? "default"),
        "HasSpeech": String(!!options.speech),
    });
}