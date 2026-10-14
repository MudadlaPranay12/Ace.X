/**
 * emotion.js — the canonical emotion vocabulary shared by the Brain and the Body.
 *
 * Pipeline position (this module sits alongside actionMapper.js, BEFORE the
 * physical controllers):
 *
 *   Brain ──EMOTION {emotion,intensity}──▶ MessageParser
 *                                          │
 *                                          ▼
 *                                     emotion.js      ← normalise + validate
 *                                          │
 *                                          ▼
 *                                     ActionMapper    ← emotion → BehaviourState
 *                                          │
 *                                          ▼
 *                                BehaviourController  ← holds emotion + intensity
 *                                     ┌──────┴───────┐
 *                                     ▼                ▼
 *                             AnimationController  FaceController
 *                              (rigid poses,      (eyes, lids, mouth,
 *                               scaled by          scaled by
 *                               intensity)         intensity)
 *
 * DESIGN RULE — no duplicated controllers.
 * The eight canonical emotions map onto the BehaviourState values that already
 * exist and are already rendered. Only ERROR is genuinely new, because it needs
 * a visual read that CONCERNED (worry) cannot express: a hard failure is not a
 * soft concern. Everything else is an alias, so an EMOTION message and the
 * equivalent legacy ACTION/ROBOT_STATE message reach the exact same pose.
 *
 *   IDLE       → IDLE          resting, breathing, eyes on the user
 *   LISTENING  → OBSERVING     attentive, wide eyes, high gaze gain
 *   THINKING   → THINKING      eyes up-left, slow micro-nod, dim wander
 *   SPEAKING   → EXPLAINING    present gesture, mouth live, brightness pulse
 *   HAPPY      → SUCCESS       nod + laugh transient, brightest eyes
 *   CONFUSED   → CONFUSED      head tilt, uneven squint, lowered gaze
 *   ALERT      → CONCERNED     lean in, dim, raised-arm acknowledgement
 *   ERROR      → ERROR (new)   sharp head drop, dark eyes, flat frown
 *
 * INTENSITY is a 0..1 multiplier on how far from rest the Body deviates.
 * 0 = rest pose for that emotion, 1 = full expression. The Brain sets it from
 * urgency (severity, count of problems, proximity to a deadline it invented —
 * in practice, severity and repetition). Breathing and idle drift are never
 * scaled: the companion is never frozen.
 */

/** The canonical, closed vocabulary. Anything else is not an emotion. */
export const EMOTION = Object.freeze({
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  THINKING: 'THINKING',
  SPEAKING: 'SPEAKING',
  HAPPY: 'HAPPY',
  CONFUSED: 'CONFUSED',
  ALERT: 'ALERT',
  ERROR: 'ERROR',
});

/** Every legal emotion value, for validation without an Object.keys scan. */
export const EMOTIONS = Object.freeze([
  EMOTION.IDLE,
  EMOTION.LISTENING,
  EMOTION.THINKING,
  EMOTION.SPEAKING,
  EMOTION.HAPPY,
  EMOTION.CONFUSED,
  EMOTION.ALERT,
  EMOTION.ERROR,
]);

/**
 * Emotion → BehaviourState.
 *
 * The state names are written as plain strings rather than imported from
 * actionMapper.js on purpose: actionMapper imports this module, so importing
 * back would be a cycle. `BehaviourState` is a frozen string enum, so these
 * values are identical at runtime, and actionMapper.js asserts the mapping stays
 * in sync where it consumes it.
 */
export const EMOTION_TO_STATE = Object.freeze({
  [EMOTION.IDLE]: 'IDLE',
  [EMOTION.LISTENING]: 'OBSERVING',
  [EMOTION.THINKING]: 'THINKING',
  [EMOTION.SPEAKING]: 'EXPLAINING',
  [EMOTION.HAPPY]: 'SUCCESS',
  [EMOTION.CONFUSED]: 'CONFUSED',
  [EMOTION.ALERT]: 'CONCERNED',
  [EMOTION.ERROR]: 'ERROR',
});

/** Every BehaviourState an emotion can resolve to, for validation by callers. */
export const EMOTION_STATES = Object.freeze(
  Array.from(new Set(Object.values(EMOTION_TO_STATE)))
);

/** Reverse lookup, used to label the Body's own status read-out. */
export const STATE_TO_EMOTION = Object.freeze(
  Object.fromEntries(Object.entries(EMOTION_TO_STATE).map(([emotion, state]) => [state, emotion]))
);

/**
 * How long the Brain's intent for each emotion is held when it does not send an
 * explicit duration. Short and reactive emotions settle fast; thinking and
 * speaking persist because they describe work in progress, not a reaction.
 */
export const DEFAULT_EMOTION_HOLD_MS = Object.freeze({
  [EMOTION.IDLE]: 0,
  [EMOTION.LISTENING]: 2500,
  [EMOTION.THINKING]: 6000,
  [EMOTION.SPEAKING]: 4000,
  [EMOTION.HAPPY]: 3500,
  [EMOTION.CONFUSED]: 4000,
  [EMOTION.ALERT]: 5000,
  [EMOTION.ERROR]: 6000,
});

const MAX_HOLD_MS = 15000;

/**
 * Normalises a Brain-supplied emotion string to a canonical value.
 * Case-insensitive, and tolerant of hyphen/space separators ("very-happy" →
 * VERY_HAPPY, still unrecognised). These values arrive as JSON, so trimming is
 * not optional.
 *
 * Returns null for anything unrecognised. The caller must NOT guess a substitute
 * — an emotion outside the closed set means the sender is using a vocabulary this
 * Body does not have a pose for, so the honest response is the existing
 * non-emotion fallback, never an invented feeling.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normaliseEmotion(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const key = raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return EMOTIONS.includes(key) ? key : null;
}

/**
 * Clamps a Brain-supplied intensity to 0..1. Missing or malformed values fall
 * back to `fallback` so a sloppy sender cannot leave the Body half-expressive.
 *
 * @param {unknown} raw
 * @param {number} [fallback]
 */
export function normaliseIntensity(raw, fallback = 1) {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, n));
}

/**
 * Resolves an explicit Brain duration, else the emotion's default hold.
 *
 * Capped at MAX_HOLD_MS because a Brain that asks for a ten-minute hold has
 * almost certainly miscalculated, and a robot frozen in one expression for ten
 * minutes reads as broken.
 *
 * @param {unknown} explicitMs
 * @param {string} emotion canonical emotion
 */
export function holdForEmotion(explicitMs, emotion) {
  if (typeof explicitMs === 'number' && Number.isFinite(explicitMs) && explicitMs > 0) {
    return Math.min(explicitMs, MAX_HOLD_MS);
  }
  return DEFAULT_EMOTION_HOLD_MS[emotion] ?? 4000;
}

/**
 * Whether an emotion should keep the mouth animated while it is held. Only
 * SPEAKING produces speech; HAPPY's mouth rides the laugh transient instead.
 *
 * Kept here so the rule lives with the vocabulary rather than being restated in
 * the controller.
 *
 * @param {string} emotion canonical emotion
 */
export function isSpeaking(emotion) {
  return emotion === EMOTION.SPEAKING;
}