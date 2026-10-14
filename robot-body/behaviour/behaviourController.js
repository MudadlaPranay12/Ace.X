/**
 * BehaviourController — step 4 of the Body pipeline:
 *
 *   WebSocket → MessageParser → ActionMapper → BehaviourController → AnimationController → Three.js
 *
 * Small explicit Body-side state machine with priority arbitration:
 *
 *   - short reactions COMPLETE unless a genuinely higher-priority event arrives
 *   - duplicate messages within the dedupe window only extend the hold —
 *     they never restart behaviour (no animation flapping)
 *   - at most ONE pending intent waits behind an active reaction (single-slot
 *     queue, highest priority wins) — commands can never pile up
 *   - connection status is an orthogonal overlay: DISCONNECTED keeps the robot
 *     visible and breathing; reconnect runs CONNECTED → OBSERVING → IDLE
 *   - an explicit Brain 'neutral' release ends a reaction early, but never
 *     within its first 1.5s (prevents flapping on interleaved messages)
 */

import { BehaviourState, PRIORITY } from './actionMapper.js';
import { EMOTION, STATE_TO_EMOTION, isSpeaking } from './emotion.js';

const DEDUPE_MS = Object.freeze({
  OBSERVING: 4000,
  THINKING: 2000,
  CONCERNED: 1500,
  CONFUSED: 1500,
  SUCCESS: 1500,
  EXPLAINING: 1000,
  ERROR: 1500,
  IDLE: 500,
});

const MIN_REACTION_AGE_FOR_RELEASE_MS = 1500;
const PENDING_TTL_MS = 5000;
const RECONNECT_OBSERVE_MS = 1500;

export class BehaviourController {
  constructor() {
    this.behaviour = BehaviourState.IDLE;
    // Canonical emotion label for the active behaviour, and how far from rest
    // the Body should express it (0..1). Both default to "rest, full scale" so
    // a Brain that only sends legacy ACTION/ROBOT_STATE still animates exactly
    // as it did before the emotion channel existed.
    this.emotion = EMOTION.IDLE;
    this.intensity = 1;
    this.link = 'connecting'; // 'connecting' | 'connected' | 'disconnected'
    this.enteredAt = 0;
    this.holdUntil = 0;
    this.speech = null;
    this.speechUntil = 0;
    this.speechMode = 'CAPTION'; // 'CAPTION' | 'TTS'
    this.speaking = false; // true only while a SPEAKING emotion is held
    this.pending = null; // single-slot queue: { intent, receivedAt }
    this.firstConnect = true;
    this.firstGreeting = true;
    this.listeners = new Set();
    this.lastLogLine = '';

    // Context state the Brain decided and the Body merely records/expresses.
    // `attention` is the region the companion should look toward (approximate —
    // VS Code exposes no screen coordinates). `teaching` is the Brain's hint
    // ladder rung. Neither is ever re-derived here.
    this.attention = null; // { targetType, vector, confidence, strength, expiresAt }
    this.teaching = { level: 0, matter: '', concept: undefined, recurrence: 0, updatedAt: 0 };
  }

  /**
   * Records where the Brain wants the companion to look. The Body stores the
   * region vector; renderer.js blends it with the mouse gaze.
   * @param {{targetType:string, vector:{x:number,y:number}, confidence:number, strength:number, expiresAt:number}|null} target
   */
  setAttentionTarget(target) {
    if (target === null || target === undefined) {
      this.attention = null;
      this.log('attention cleared');
      return;
    }
    this.attention = {
      targetType: target.targetType,
      vector: target.vector,
      confidence: target.confidence,
      strength: target.strength,
      // A missing/expired expiresAt must not make the target permanent.
      expiresAt: Number(target.expiresAt) || Date.now() + 15000,
    };
    this.log(`attention → ${target.targetType} @ strength ${target.strength}`);
  }

  /** The live attention target, or null once it has expired. */
  getAttentionTarget(now = Date.now()) {
    if (this.attention && this.attention.expiresAt <= now) {
      this.attention = null;
    }
    return this.attention;
  }

  /**
   * Records the Brain's teaching rung (0..4). The Body does not choose a rung;
   * it only exposes the current one for diagnostics and posture accent.
   */
  setTeachingState(state) {
    if (!state || typeof state.level !== 'number') {
      return;
    }
    this.teaching = {
      level: state.level,
      matter: state.matter || '',
      concept: state.concept,
      recurrence: state.recurrence,
      updatedAt: Date.now(),
    };
    this.log(`teaching level ${state.level} — ${state.matter || 'unspecified'}`);
  }

  getTeachingState() {
    return { ...this.teaching };
  }

  /**
   * Caption-only speech channel. Unlike an EMOTION message this changes no
   * state: it only (re)sets the caption and its lifetime. The Brain has already
   * decided whether a line should be spoken. Mouth articulation still requires a
   * SPEAKING emotion, so a caption can never make the mouth flap on its own.
   */
  setCaption(text, holdMs, mode = 'CAPTION', now = Date.now()) {
    if (this.link !== 'connected') {
      return false;
    }
    const trimmed = String(text ?? '').trim();
    if (!trimmed) {
      return false;
    }
    const hold = typeof holdMs === 'number' && holdMs > 0 ? Math.min(holdMs, 15000) : 4000;
    this.speech = trimmed;
    this.speechUntil = now + hold;
    this.speechMode = mode === 'TTS' ? 'TTS' : 'CAPTION';
    this.speaking = isSpeaking(this.emotion) && now <= this.speechUntil;
    this.emit();
    return true;
  }

  /** @param {(snapshot: object) => void} cb */
  onChange(cb) {
    this.listeners.add(cb);
  }

  log(...args) {
    console.log('[BODY:BEHAVIOUR]', ...args);
  }

  /**
   * Apply an intent from the ActionMapper.
   * @returns {boolean} whether the intent changed/extended the active behaviour
   */
  submit(intent, now = Date.now()) {
    if (!intent || !intent.state) {
      return false;
    }

    this.prunePending(now);

    // Explicit Brain release (ACTION 'neutral'/'idle')
    if (intent.release) {
      const reactionActive = this.behaviour !== BehaviourState.IDLE &&
        this.link === 'connected';
      if (!reactionActive) {
        return false;
      }
      if (now - this.enteredAt < MIN_REACTION_AGE_FOR_RELEASE_MS) {
        return false; // let a fresh reaction finish first
      }
      this.transition(BehaviourState.IDLE, { speech: null, holdMs: 0, reason: 'Brain release' }, now);
      return true;
    }

    // Link layer overrides: never start behaviours while offline
    if (this.link !== 'connected' && intent.state !== BehaviourState.IDLE) {
      return false;
    }

    const currentPriority = PRIORITY[this.behaviour] ?? 0;
    const expired = this.holdUntil > 0 && now >= this.holdUntil;

    // Dedupe: same state inside its window → extend hold only, no restart
    if (intent.state === this.behaviour && !expired && now - this.enteredAt < (DEDUPE_MS[intent.state] ?? 1000)) {
      this.holdUntil = Math.max(this.holdUntil, now + intent.holdMs);

      // Intensity and emotion are still absorbed even though the state does not
      // change. The Brain escalates on repeated identical problems (a second
      // error gets a stronger reaction), and silently dropping that would make
      // the escalation invisible. Cheap because the controllers interpolate —
      // no gesture restart, no state churn.
      const nextEmotion = intent.emotion || STATE_TO_EMOTION[intent.state] || EMOTION.IDLE;
      const nextIntensity = typeof intent.intensity === 'number' ? intent.intensity : this.intensity;
      const emotionChanged = nextEmotion !== this.emotion;
      const intensityChanged = Math.abs(nextIntensity - this.intensity) > 0.02;

      this.emotion = nextEmotion;
      this.intensity = nextIntensity;

      this.extendSpeech(intent, now);

      if (emotionChanged || intensityChanged) {
        this.log(`${this.behaviour} sustained — emotion ${this.emotion} @ ${this.intensity.toFixed(2)}`);
        this.emit();
      }
      return false; // no re-entry → no gesture restart, no state churn
    }

    if (intent.state !== BehaviourState.IDLE && this.behaviour !== BehaviourState.IDLE && !expired) {
      if (intent.priority < currentPriority) {
        // Lower priority waits: single-slot queue keeps only the strongest
        if (!this.pending || this.pending.intent.priority < intent.priority) {
          this.pending = { intent, receivedAt: now };
        }
        this.log(`deferred ${intent.state} (prio ${intent.priority}) behind ${this.behaviour} (prio ${currentPriority})`);
        return false;
      }
      if (intent.priority === currentPriority && intent.state !== this.behaviour) {
        // Equal rank: newest wins only for same-state refresh, otherwise queue
        if (!this.pending || this.pending.intent.priority < intent.priority) {
          this.pending = { intent, receivedAt: now };
        }
        return false;
      }
    }

    this.transition(intent.state, intent, now);
    return true;
  }

  transition(state, intent, now) {
    const previous = this.behaviour;
    const previousEmotion = this.emotion;
    this.behaviour = state;
    this.emotion = intent.emotion || STATE_TO_EMOTION[state] || EMOTION.IDLE;
    this.intensity = typeof intent.intensity === 'number' ? intent.intensity : 1;
    this.enteredAt = now;
    this.holdUntil = intent.holdMs > 0 ? now + intent.holdMs : 0;

    // The caption belongs to the emotion that carried it. A *different* emotion
    // arriving without text therefore takes the old caption with it — otherwise
    // an ALERT caption would sit under a robot that has already moved on to
    // THINKING, saying something that is no longer what it is reacting to.
    // Repeats of the same emotion keep their caption, so an intensity-only
    // refresh does not make a reply blink out.
    if (intent.speech) {
      this.speech = intent.speech;
      this.speechUntil = this.holdUntil || now + 4000;
    } else if (this.emotion !== previousEmotion) {
      this.speech = null;
      this.speechUntil = 0;
    }

    // Speech animation runs off the emotion, not off "a caption happens to
    // exist": a caption attached to THINKING must not make the mouth flap.
    this.speaking = isSpeaking(this.emotion) && !!this.speech && now <= this.speechUntil;

    this.log(`${previous} → ${state}` +
      (intent.holdMs ? ` (hold ${intent.holdMs}ms)` : '') +
      (this.intensity !== 1 ? ` (intensity ${this.intensity.toFixed(2)})` : '') +
      (intent.reason ? ` [${intent.reason}]` : '') +
      (intent.speech ? ` speech="${intent.speech.slice(0, 60)}"` : ''));
    this.emit();
  }

  extendSpeech(intent, now) {
    if (intent.speech && (this.speechUntil < now + 500)) {
      this.speech = intent.speech;
      this.speechUntil = now + intent.holdMs;
      // Re-evaluate: the caption was replaced or extended, so whether the mouth
      // should be animating may have changed independently of the state.
      this.speaking = isSpeaking(this.emotion) && now <= this.speechUntil;
      this.emit();
    }
  }

  prunePending(now) {
    if (this.pending && now - this.pending.receivedAt > PENDING_TTL_MS) {
      this.pending = null;
    }
  }

  /** Called every frame (or at a low tick rate) to expire holds. */
  tick(now = Date.now()) {
    let changed = false;

    if (this.speech && now > this.speechUntil) {
      this.speech = null;
      // Caption gone: speech animation must stop even though the underlying
      // SPEAKING state may still be held (e.g. a long hold with no text).
      if (this.speaking) {
        this.speaking = false;
      }
      changed = true;
    }

    if (this.holdUntil > 0 && now >= this.holdUntil && this.behaviour !== BehaviourState.IDLE) {
      const queued = this.pending;
      this.pending = null;
      if (queued && this.link === 'connected') {
        this.transition(queued.intent.state, queued.intent, now);
      } else {
        this.transition(BehaviourState.IDLE, { holdMs: 0, reason: 'hold expired' }, now);
      }
      changed = true;
    } else if (this.pending && now - this.pending.receivedAt > 0 && this.behaviour === BehaviourState.IDLE) {
      // Safety: never strand a queued intent behind IDLE
      const queued = this.pending;
      this.pending = null;
      this.transition(queued.intent.state, queued.intent, now);
      changed = true;
    }

    if (changed) {
      this.emit();
    }
  }

  /**
   * Connection overlay: 'connecting' | 'connected' | 'disconnected'.
   * Reconnect runs CONNECTED → OBSERVING → IDLE (spec §15), without spam.
   */
  setLinkStatus(status, now = Date.now()) {
    if (this.link === status) {
      return;
    }
    const previous = this.link;
    this.link = status;
    this.log(`link: ${previous} → ${status}`);

    if (status === 'disconnected') {
      this.pending = null;
      this.speech = null;
      this.speechUntil = 0;
      this.speaking = false;
      this.holdUntil = 0;
      // A target decided by the Brain while it was connected must not survive
      // a link loss: without a Brain to refresh it, holding it would be a stale
      // gaze. The Brain will send a fresh target when it has one.
      this.attention = null;
      // Low, but not zero: the DISCONNECTED pose and face dim the robot so it
      // looks unattended, and zeroing intensity would blend those channels back
      // to a normal resting expression.
      this.intensity = 0.3;
      this.emit();
      return;
    }

    if (status === 'connected') {
      if (this.firstConnect) {
        this.firstConnect = false;
        this.behaviour = BehaviourState.IDLE;
        this.emotion = EMOTION.IDLE;
        this.speech = null;
        this.speechUntil = 0;
        this.speaking = false;
        this.intensity = 1;
        this.enteredAt = now;
        this.holdUntil = 0;
        // Belt and braces: nothing carried over a reconnect may outlive it.
        this.attention = null;
        this.emit();
      } else {
        // Re-entry: brief OBSERVING acknowledgement, then calm IDLE. Captions
        // and attention were already cleared on disconnect, so no stale content
        // is resurrected by the reconnect itself.
        this.transition(BehaviourState.OBSERVING,
          { holdMs: RECONNECT_OBSERVE_MS, reason: 'Brain reconnected' }, now);
      }
    }
  }

  /** Effective state for the AnimationController (link overlay wins). */
  getViewState(now = Date.now()) {
    if (this.link === 'disconnected') {
      return BehaviourState.DISCONNECTED;
    }
    if (this.link === 'connecting') {
      return BehaviourState.CONNECTING;
    }
    return this.behaviour;
  }

  getCaption(now = Date.now()) {
    if (this.link !== 'connected') {
      return null;
    }
    if (this.speech && now <= this.speechUntil) {
      return this.speech;
    }
    return null;
  }

  getLinkStatus() {
    return this.link;
  }

  snapshot(now = Date.now()) {
    return {
      viewState: this.getViewState(now),
      behaviour: this.behaviour,
      // Canonical emotion label + expression scale. Both physical controllers
      // read these; neither re-derives them, so the pose, the face and the
      // status read-out can never disagree about how Eve is feeling.
      emotion: this.emotion,
      intensity: this.intensity,
      speaking: this.speaking,
      link: this.link,
      caption: this.getCaption(now),
      captionMode: this.speechMode,
      // Hold accounting. The controllers do not need these (they interpolate),
      // but the state is observably incomplete without them: "how long is this
      // emotion going to last" is part of the companion's state, not an
      // implementation detail.
      holdUntil: this.holdUntil,
      holdRemainingMs: this.holdUntil > 0 ? Math.max(0, this.holdUntil - now) : 0,
      // Context the Brain decided. Exposed so the renderer can aim the gaze
      // and log the ladder without the Body deriving anything itself.
      attention: this.getAttentionTarget(now),
      teaching: this.getTeachingState(),
    };
  }

  /**
   * Intensity actually in effect right now, given the link overlay.
   *
   * DISCONNECTED is intentionally NOT forced to 0. It has its own authored pose
   * and face (dimmed eyes, lowered head) precisely so the companion looks
   * unattended rather than merely paused — zeroing intensity would blend those
   * channels back to rest and make a disconnected robot look perfectly normal,
   * which is the one thing it must not do. The stale emotion label still cannot
   * be rendered, because getViewState() reports DISCONNECTED to both
   * controllers instead of the behaviour state.
   *
   * CONNECTING does cap intensity: before the link is up the Brain's intent is
   * not yet trustworthy, so the companion reads as tentative rather than
   * committed.
   */
  getEffectiveIntensity(now = Date.now()) {
    if (this.link === 'connecting') {
      return Math.min(this.intensity, 0.5);
    }
    return this.intensity;
  }

  emit() {
    const snap = this.snapshot();
    const line = `${snap.viewState}|${snap.emotion}|${snap.intensity.toFixed(2)}|` +
      `${snap.link}|${snap.caption ? snap.caption.slice(0, 40) : ''}`;
    if (line === this.lastLogLine) {
      return;
    }
    this.lastLogLine = line;
    for (const cb of this.listeners) {
      try {
        cb(snap);
      } catch (err) {
        this.log('listener error:', String(err));
      }
    }
  }
}
