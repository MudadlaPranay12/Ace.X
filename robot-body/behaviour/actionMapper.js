/**
 * ActionMapper — step 3 of the Body pipeline:
 *
 *   WebSocket → MessageParser → ActionMapper → BehaviourController → AnimationController → Three.js
 *
 * Pure translation layer: Brain protocol message → Body behaviour intent.
 * Contains NO cognition — the Brain decides, the Body only interprets:
 *
 *   Brain: ACTION   = thinking       →  Body intent: THINKING
 *   Brain: ACTION   = neutral        →  Body intent: IDLE (release)
 *   Brain: EMOTION  = ERROR          →  Body intent: ERROR        (intensity 0..1)
 *   Brain: EMOTION  = SPEAKING       →  Body intent: EXPLAINING   (intensity 0..1)
 *   Brain: ROBOT_STATE_UPDATE severity=error → Body intent: ERROR
 *
 * EMOTION is the canonical emotion channel (see emotion.js for the vocabulary
 * and the emotion→state table). The older ACTION/ROBOT_STATE messages still
 * work unchanged; EMOTION simply adds a closed vocabulary plus intensity.
 *
 * Protocol messages handled (all discovered from Brain sendToRobot call sites):
 *   CONNECTION_STATUS  {type, status}                  (the link channel)
 *   ACTION             {type, animation?, speech?}
 *   EMOTION            {type, emotion, intensity?, speech?, duration?}
 *   CAPTION            {type, text, mode, duration?}   (caption-only speech)
 *   TEACHING_STATE     {type, level, matter, ...}      (hint ladder state)
 *   ATTENTION_TARGET   {type, targetType, file, line, ...}
 *   STRUGGLE_STATE     {type, level, evidence, ...}
 *   EDITOR_CHANGED     {type}
 *   CURSOR_MOVE        {type}                      (high-frequency noise → ignored)
 *   ROBOT_STATE        {type, expression, action, speechBubble, duration, ...}
 *   ROBOT_STATE_UPDATE {type, payload:{expression, speechBubble, fixCount, ...}}
 *   WINDOW_ANCHOR / USER_DISMISS  (defined by Brain, never sent → reserved)
 *   WINDOW_VISIBILITY → consumed by main.js (window show/hide), never reaches
 *                       this mapper; listed here so the split is explicit
 *
 * The four "context" messages (CAPTION, TEACHING_STATE, ATTENTION_TARGET,
 * STRUGGLE_STATE) are NOT cognition: the Brain has already decided them. The
 * Body only records state it needs to express — it never re-derives a decision.
 */

import {
  EMOTION,
  EMOTION_TO_STATE,
  holdForEmotion,
  normaliseEmotion,
  normaliseIntensity,
} from './emotion.js';

export const BehaviourState = Object.freeze({
  IDLE: 'IDLE',
  OBSERVING: 'OBSERVING',
  THINKING: 'THINKING',
  CONCERNED: 'CONCERNED',
  CONFUSED: 'CONFUSED',
  EXPLAINING: 'EXPLAINING',
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR',
  CONNECTING: 'CONNECTING',
  DISCONNECTED: 'DISCONNECTED',
});

// emotion.js maps emotions to BehaviourState using plain strings to avoid an
// import cycle (it imports nothing from here). Assert the two agree so a rename
// on either side fails loudly at load rather than silently leaving an emotion
// with no pose.
for (const [emotion, state] of Object.entries(EMOTION_TO_STATE)) {
  if (BehaviourState[state] === undefined) {
    throw new Error(
      `[ActionMapper] emotion.js maps ${emotion} to "${state}", which is not a BehaviourState.`
    );
  }
}

/**
 * Priority based on actual Brain action semantics (ERROR > SUCCESS > EXPLAIN >
 * THINKING > OBSERVE > IDLE), not a blind copy of the spec example.
 */
export const PRIORITY = Object.freeze({
  ERROR: 100,
  CONCERNED: 90,
  SUCCESS: 80,
  CONFUSED: 65,
  EXPLAINING: 60,
  THINKING: 50,
  OBSERVING: 30,
  IDLE: 0,
  CONNECTING: 0,
  DISCONNECTED: 0,
});

const DEFAULT_HOLD_MS = Object.freeze({
  ERROR: 6000,
  CONCERNED: 5000,
  SUCCESS: 3500,
  CONFUSED: 4000,
  EXPLAINING: 4000,
  THINKING: 6000,
  OBSERVING: 2500,
  IDLE: 0,
});

// Expression semantics as actually emitted by the Brain
// (motionExecutor CHANGE_EXPRESSION, motionPlanner resolveExpression,
//  behaviourController broadcastRobotStateUpdate, ROBOT_STATE triggers).
const EXPRESSION_TO_STATE = Object.freeze({
  happy: BehaviourState.SUCCESS,
  confused: BehaviourState.CONFUSED,
  thinking: BehaviourState.THINKING,
  worried: BehaviourState.CONCERNED,
  alert: BehaviourState.CONCERNED,
  shocked: BehaviourState.CONCERNED,
  sad: BehaviourState.CONCERNED,
  // Hard failures get their own read — worry and failure are not the same.
  error: BehaviourState.ERROR,
  broken: BehaviourState.ERROR,
  failed: BehaviourState.ERROR,
});

const RELEASE_ANIMATIONS = new Set(['neutral', 'idle', 'sleeping']);

/** Closed vocabulary for ATTENTION_TARGET — anything else is not a target. */
const ATTENTION_TARGET_TYPES = Object.freeze([
  'error',
  'warning',
  'cursor',
  'changed-line',
  'active-symbol',
  'current-file',
]);

/**
 * Approximate direction the companion turns toward for each attention target.
 *
 * HONEST LIMITATION: VS Code exposes no absolute editor screen coordinates, and
 * the Body cannot know where on the user's screen the code actually is. The
 * companion window is docked to the bottom-right, so the code region is
 * reliably to its left and slightly above. These vectors therefore express
 * "look toward the region", never precise pointing. A future
 * editor-window coordinate mapper can replace this table without changing the
 * protocol or the controllers.
 */
const ATTENTION_REGION_VECTOR = Object.freeze({
  error: { x: -0.30, y: -0.10 },
  warning: { x: -0.22, y: -0.06 },
  cursor: { x: -0.26, y: -0.08 },
  'changed-line': { x: -0.26, y: -0.08 },
  'active-symbol': { x: -0.24, y: -0.04 },
  'current-file': { x: -0.20, y: 0.0 },
});

function normaliseUnit(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, n));
}

// ROBOT_STATE.action values (AvatarAction from core/types.ts)
const ACTION_TO_STATE = Object.freeze({
  JUMP: BehaviourState.SUCCESS,
  ALERT_RED: BehaviourState.CONCERNED,
  SHAKE: BehaviourState.CONFUSED,
  // NOD / POINT_LEFT follow their expression — no independent override
});

/**
 * Gesture names the Brain may send in ACTION.animation that mean "be idle".
 * Kept separate from RELEASE_ANIMATIONS because these are the neutral *actions*,
 * while those are neutral *expressions*.
 */
const NEUTRAL_ANIMATIONS = Object.freeze({
  neutral: BehaviourState.IDLE,
  idle: BehaviourState.IDLE,
  sleep: BehaviourState.IDLE,
  resting: BehaviourState.IDLE,
  calm: BehaviourState.IDLE,
  relax: BehaviourState.IDLE,
});

// Brain-authoritative product lifecycle → the safest existing physical pose.
// The Body renders this mapping; it never infers a lifecycle state itself.
const LIFECYCLE_TO_STATE = Object.freeze({
  IDLE: BehaviourState.IDLE,
  LISTENING: BehaviourState.OBSERVING,
  THINKING: BehaviourState.THINKING,
  WRITING: BehaviourState.THINKING,
  EXPLAINING: BehaviourState.EXPLAINING,
  TEACHING: BehaviourState.EXPLAINING,
  FIXING: BehaviourState.THINKING,
  WAITING_FOR_APPROVAL: BehaviourState.OBSERVING,
  VERIFYING: BehaviourState.THINKING,
  SUCCESS: BehaviourState.SUCCESS,
  FAILURE: BehaviourState.ERROR,
  RECONNECTING: BehaviourState.CONNECTING,
  DISCONNECTED: BehaviourState.DISCONNECTED,
});

function stateFromExpression(expression) {
  if (typeof expression !== 'string') {
    return null;
  }
  const key = expression.trim().toLowerCase();
  if (RELEASE_ANIMATIONS.has(key)) {
    return 'release';
  }
  return EXPRESSION_TO_STATE[key] || null;
}

function holdFor(state, explicitMs) {
  if (typeof explicitMs === 'number' && explicitMs > 0) {
    return Math.min(explicitMs, 15000);
  }
  return DEFAULT_HOLD_MS[state] || 4000;
}

/**
 * Speech-derived hold: proportional to text length, clamped — lets EXPLAINING
 * captions stay readable without any cognitive decision on the Body side.
 */
function speechHold(text) {
  const words = String(text).trim().split(/\s+/).length;
  return Math.max(3000, Math.min(2500 + words * 350, 8000));
}

function intent(state, extra = {}) {
  return {
    state,
    priority: PRIORITY[state] ?? 0,
    holdMs: extra.holdMs ?? holdFor(state, extra.explicitMs),
    speech: extra.speech || null,
    release: extra.release || false,
    reason: extra.reason || state,
    // Present only when the Brain used the EMOTION channel. Controllers treat
    // an absent emotion as "full intensity" so legacy messages behave as before.
    emotion: extra.emotion ?? null,
    intensity: extra.intensity ?? 1,
  };
}

/**
 * @param {Record<string, unknown>} msg validated message from MessageParser
 * @returns {object | {kind:'link', status:string} | null}
 */
export function mapMessage(msg) {
  switch (msg.type) {
    case 'LIFECYCLE_STATE': {
      const raw = typeof msg.state === 'string' ? msg.state.toUpperCase() : '';
      const state = LIFECYCLE_TO_STATE[raw];
      if (!state) return null;
      return intent(state, { reason: `LIFECYCLE_STATE ${raw}`, holdMs: state === BehaviourState.IDLE ? 0 : undefined });
    }
    case 'CONNECTION_STATUS': {
      const status = String(msg.status || '').toUpperCase();
      if (status === 'CONNECTED') {
        return { kind: 'link', status: 'connected' };
      }
      return null; // reserved for future Brain-side status values
    }

    case 'ACTION': {
      const animation = typeof msg.animation === 'string' ? msg.animation.trim() : '';
      const speech = typeof msg.speech === 'string' && msg.speech.trim() ? msg.speech.trim() : null;
      const key = animation.toLowerCase();

      if (animation && RELEASE_ANIMATIONS.has(key)) {
        // Brain's explicit end-of-reaction signal (BehaviourController state machine)
        return intent(BehaviourState.IDLE, { release: true, speech, reason: 'ACTION neutral release' });
      }

      // Neutral action names release the reaction but are not an explicit
      // "release" — they read as "settle down", not "the reaction is over".
      if (animation && NEUTRAL_ANIMATIONS[key] === BehaviourState.IDLE) {
        return intent(BehaviourState.IDLE, { speech: null, reason: `ACTION ${key}` });
      }

      const state = stateFromExpression(animation) ||
        (animation ? null : (speech ? BehaviourState.EXPLAINING : BehaviourState.OBSERVING));

      if (!state) {
        // Unknown animation name — treat as observing rather than inventing behaviour
        return intent(BehaviourState.OBSERVING, { speech, reason: `ACTION unknown animation '${animation}'` });
      }

      const holdMs = state === BehaviourState.EXPLAINING && speech ? speechHold(speech) : undefined;
      return intent(state, { speech, holdMs, reason: `ACTION ${animation || 'speech-only'}` });
    }

    /**
     * EMOTION is the explicit emotion channel. Preferred over overloading
     * ACTION.animation because it is the only message that can also carry
     * intensity, and because a raw emoji/word the Brain did not mean as an
     * expression can no longer be mistaken for one.
     */
    case 'EMOTION': {
      const emotion = normaliseEmotion(msg.emotion);
      if (!emotion) {
        // An unrecognised emotion is a protocol error, not a feeling. Fall back
        // to attentive idle and DROP the speech: attaching a caption to a state
        // chosen as a guess would misreport what the robot is responding to.
        // Legacy ACTION/ROBOT_STATE remain the path for richer vocabulary.
        return intent(BehaviourState.OBSERVING, {
          speech: null,
          reason: `EMOTION unknown '${String(msg.emotion)}' — ignored, using OBSERVING`,
        });
      }

      const state = EMOTION_TO_STATE[emotion];
      const intensity = normaliseIntensity(msg.intensity, 1);
      const speech = typeof msg.speech === 'string' && msg.speech.trim() ? msg.speech.trim() : null;

      const extra = {
        emotion,
        intensity,
        speech,
        reason: `EMOTION ${emotion}`,
      };

      if (emotion === EMOTION.IDLE) {
        return intent(BehaviourState.IDLE, { ...extra, holdMs: 0 });
      }

      const holdMs = emotion === EMOTION.SPEAKING && speech
        ? Math.max(speechHold(speech), holdForEmotion(msg.duration, emotion))
        : holdForEmotion(msg.duration, emotion);

      return intent(state, { ...extra, holdMs });
    }

    case 'EDITOR_CHANGED':
      return intent(BehaviourState.OBSERVING, { reason: 'EDITOR_CHANGED' });

    case 'CAPTION': {
      const text = typeof msg.text === 'string' && msg.text.trim() ? msg.text.trim() : null;
      if (!text) {
        return null;
      }
      return {
        kind: 'caption',
        text,
        mode: msg.mode === 'TTS' ? 'TTS' : 'CAPTION',
        holdMs: typeof msg.duration === 'number' && msg.duration > 0 ? Math.min(msg.duration, 15000) : undefined,
      };
    }

    case 'TEACHING_STATE': {
      const level = Number(msg.level);
      if (!Number.isFinite(level) || level < 0 || level > 4) {
        return null;
      }
      return {
        kind: 'teaching',
        level: Math.floor(level),
        matter: typeof msg.matter === 'string' ? msg.matter : '',
        concept: typeof msg.concept === 'string' ? msg.concept : undefined,
        recurrence: Number.isFinite(Number(msg.recurrence)) ? Number(msg.recurrence) : undefined,
      };
    }

    case 'ATTENTION_TARGET': {
      const targetType = String(msg.targetType || '');
      if (!ATTENTION_TARGET_TYPES.includes(targetType)) {
        return null; // not a vocabulary this Body has a region for
      }
      const vector = ATTENTION_REGION_VECTOR[targetType];
      return {
        kind: 'attention',
        target: {
          targetType,
          vector,
          confidence: normaliseUnit(msg.confidence, 0.5),
          strength: normaliseUnit(msg.strength, 0.5),
          reason: typeof msg.reason === 'string' ? msg.reason : '',
          expiresAt: Number(msg.expiresAt) || 0,
        },
      };
    }

    case 'STRUGGLE_STATE': {
      // Recorded for logging/diagnostics only: the Brain already decided what
      // to express, and struggle is NEVER turned into an emotion here.
      const level = normaliseUnit(msg.level, 0);
      return {
        kind: 'struggle',
        level,
        evidence: Array.isArray(msg.evidence) ? msg.evidence.slice(0, 6).map(String) : [],
        expiresAt: Number(msg.expiresAt) || 0,
      };
    }

    case 'CURSOR_MOVE':
      return null; // high-frequency sensor noise — deliberately ignored (documented)

    case 'ROBOT_STATE': {
      const fromExpression = stateFromExpression(msg.expression);
      const fromAction = typeof msg.action === 'string' ? ACTION_TO_STATE[msg.action] : undefined;
      let state = fromExpression || fromAction || null;

      const speech = typeof msg.speechBubble === 'string' && msg.speechBubble.trim()
        ? msg.speechBubble.trim()
        : null;

      if (state === 'release') {
        return intent(BehaviourState.IDLE, { release: true, speech, reason: 'ROBOT_STATE neutral' });
      }
      if (!state) {
        state = speech ? BehaviourState.EXPLAINING : BehaviourState.OBSERVING;
      }
      return intent(state, {
        speech,
        explicitMs: typeof msg.duration === 'number' ? msg.duration : undefined,
        reason: `ROBOT_STATE ${String(msg.expression)}/${String(msg.action)}`,
      });
    }

    case 'ROBOT_STATE_UPDATE': {
      const payload = msg.payload;
      if (!payload || typeof payload !== 'object') {
        return null;
      }
      const fromExpression = stateFromExpression(payload.expression);
      let state = fromExpression === 'release' ? null : fromExpression;

      // Hard error information always raises to CONCERNED (subtle, not alarm)
      if (payload.severity === 'error' || typeof payload.errorText === 'string') {
        state = BehaviourState.CONCERNED;
      }

      const speech = typeof payload.speechBubble === 'string' && payload.speechBubble.trim()
        ? payload.speechBubble.trim()
        : null;

      if (!state) {
        state = speech ? BehaviourState.EXPLAINING : BehaviourState.OBSERVING;
      }
      // A caption with no stronger reaction reads as an explanation
      if (speech && state === BehaviourState.THINKING) {
        // THINKING wins over EXPLAINING — Brain said what it is doing; caption rides along
      }
      return intent(state, { speech, reason: `ROBOT_STATE_UPDATE ${String(payload.expression)}` });
    }

    case 'WINDOW_ANCHOR':
    case 'USER_DISMISS':
      return null; // defined in Brain protocol but never sent — reserved, no Body behaviour

    default:
      return null; // forward-compatible: unknown type parsed but not interpreted
  }
}
