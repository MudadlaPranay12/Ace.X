/**
 * AnimationController — step 5 of the Body pipeline:
 *   WebSocket → MessageParser → ActionMapper → BehaviourController → AnimationController → Three.js
 *
 * CRITICAL FACT (discovered by inspecting eve.glb): the model contains
 *   0 animation clips, 0 skins, 0 morph targets, no eye/face bones.
 * It is a static 4-mesh robot: torso, two arms, one head. Therefore this
 * controller does NOT pretend the model has expressions or clips — it drives
 * believable behaviour exclusively through SAFE rigid transformations of the
 * groups the model actually has:
 *
 *   - pSphere7 (head group) — pivot moved to the neck at load time so nod /
 *     shake / look-at rotate around a natural point
 *   - pSphere1 (body group) — pivot moved to the torso centre so small twists
 *     and leans rotate the body without sliding it. VERIFIED: the pivot move
 *     compensates EVERY child of pSphere1 (polySurface3 arm wrapper AND
 *     polySurface8 torso) via -L⁻¹·delta (L = the group's rotation×scale
 *     matrix), so world geometry is preserved exactly (see /tmp verification:
 *     max deviation 0 for all 4 meshes).
 *   - ShoulderL/ShoulderR wrappers (NEW, runtime-created around polySurface6/
 *     polySurface7): each wraps the arm in a stretch-compensation sandwich
 *     T(P)·S⁻¹·G·S·T(−P) so gesture rotations are RIGID even though they live
 *     inside pSphere1's non-uniform y-stretch S=(1, 2.2805, 1). At rest the
 *     sandwich collapses to identity — world content is bit-exact unchanged.
 *   - model root — breathing bob (translation only, never scaling: no distortion)
 *
 * Everything is deterministic: slow sines for breathing/drift/micro-nods,
 * scripted envelopes for gestures. No Math.random() in any render path. All
 * angles are small (head ≤ ~6°, arms ≤ ~8°, lean ≤ ~5°) to stay professional:
 * attentive, calm, responsive — not a pet.
 */

import * as THREE from 'three';

const WORLD_X = new THREE.Vector3(1, 0, 0);
const WORLD_Y = new THREE.Vector3(0, 1, 0);
const WORLD_Z = new THREE.Vector3(0, 0, 0 + 0 + 1);

// Neck pivot offset in the head group's local frame (mesh-space: head geometry
// spans y −0.43..4.07 with mass around centroid y 2.34 → neck at y 2.4).
// Body pivot: torso content sits at x −4.78 in pSphere1's local frame.
const NECK_OFFSET = { x: 0, y: 2.4, z: 0 };
const TORSO_PIVOT = { x: -4.78, y: 0, z: 0 };

// pSphere1's baked non-uniform y-stretch is read live from bodyNode.scale in
// buildShoulders() — NOT hardcoded: the matrix stores 2.2805352210998535 and a
// rounded literal leaves measurable shear (verification: rigidity error 1.7e-6).

// Shoulder rigs. Pivot is expressed in the arm node's ORIGINAL content frame
// (mesh-space pivot + the node's own translation (-4.78, 0, 0.031)).
// Geometry-derived sides: mesh0/polySurface6 centroid x −0.47 = −X = character
// right (Eve faces +Z, verified via face normal (0.403,−0.078,0.912));
// mesh1/polySurface7 centroid x +0.50 = +X = character left.
// side: +1 = character left, −1 = character right. Outward lift = side·angle
// about local Z; forward swing = −angle about local X (shared channel).
const SHOULDER_RIGS = [
  { arm: 'polySurface6', outer: 'ShoulderR', rot: 'ShoulderRRot', pivot: [-5.03, 0.62, 0.141], side: -1 },
  { arm: 'polySurface7', outer: 'ShoulderL', rot: 'ShoulderLRot', pivot: [-4.53, 0.62, 0.031], side: +1 },
];

const GESTURE_MS = { nod: 900, shake: 1000, notice: 1100, present: 1600, wince: 1200, greet: 1800, attentive: 1200 };

/**
 * Channels that express emotion and are therefore scaled by the Brain's
 * intensity. Breathing, bob and drift are deliberately excluded — the companion
 * is alive at intensity 0, it is just calm.
 */
const INTENSITY_CHANNELS = Object.freeze(['headYaw', 'headPitch', 'headRoll', 'bodyYaw', 'lean', 'armL', 'armR', 'swing', 'osc', 'gazeGain']);

/**
 * Pose targets per view-state. Only states the Brain protocol can actually
 * produce are listed. New channels beyond the head set:
 *   lean   — body pitch about the torso pivot (+ = forward toward viewer)
 *   armL/  — outward appendage lift per side (negative = tuck in);
 *   armR   restrained: poses stay within ±0.03, gestures may reach ±0.10
 *   swing  — shared forward appendage swing (+ = toward viewer)
 *   osc    — micro-nod amplitude (slow, periodically fading in/out)
 */
const POSES = Object.freeze({
  IDLE:         { headYaw: 0.00, headPitch: 0.000, headRoll: 0.000, bodyYaw: 0.000, lean: 0.000, armL: 0.000, armR: 0.000, swing: 0.000, osc: 0.000, breathHz: 0.18, bob: 0.007, drift: 0.020, gazeGain: 0.70 },
  CONNECTING:   { headYaw: 0.00, headPitch: 0.015, headRoll: 0.000, bodyYaw: 0.000, lean: 0.000, armL: 0.010, armR: 0.010, swing: 0.000, osc: 0.000, breathHz: 0.20, bob: 0.007, drift: 0.012, gazeGain: 0.40 },
  DISCONNECTED: { headYaw: 0.00, headPitch: -0.04, headRoll: 0.000, bodyYaw: 0.000, lean: 0.015, armL: -0.020, armR: -0.020, swing: 0.000, osc: 0.000, breathHz: 0.13, bob: 0.005, drift: 0.006, gazeGain: 0.15 },
  // OBSERVING (Listening): Visibly attentive — head tilted toward interaction, arms slightly raised
  OBSERVING:    { headYaw: 0.00, headPitch: 0.060, headRoll: 0.000, bodyYaw: 0.000, lean: -0.015, armL: 0.025, armR: 0.025, swing: 0.000, osc: 0.000, breathHz: 0.22, bob: 0.008, drift: 0.012, gazeGain: 1.00 },
  // THINKING: Visible head tilt and slight body lean, micro-nod active
  THINKING:     { headYaw: 0.12, headPitch: 0.070, headRoll: 0.025, bodyYaw: 0.040, lean: -0.020, armL: 0.015, armR: 0.015, swing: 0.000, osc: 0.018, breathHz: 0.18, bob: 0.007, drift: 0.030, gazeGain: 0.45 },
  // ALERT. Leans in and holds the problem steady: faster breathing and a much
  // higher gaze gain than before, so "something needs attention" is visible in
  // the posture and the tracking, not only in the face. Still distinct from
  // ERROR, which braces and drops rather than leaning in.
  CONCERNED:    { headYaw: 0.00, headPitch: -0.02, headRoll: 0.000, bodyYaw: 0.000, lean: 0.045, armL: -0.012, armR: -0.012, swing: 0.010, osc: 0.000, breathHz: 0.16, bob: 0.005, drift: 0.007, gazeGain: 0.82 },
  CONFUSED:     { headYaw: 0.04, headPitch: -0.01, headRoll: -0.06, bodyYaw: 0.020, lean: 0.005, armL: 0.014, armR: 0.004, swing: 0.000, osc: 0.000, breathHz: 0.18, bob: 0.007, drift: 0.018, gazeGain: 0.60 },
  // EXPLAINING: Visibly presenting — right arm forward gesture, slight lean back
  EXPLAINING:   { headYaw: 0.00, headPitch: 0.035, headRoll: 0.000, bodyYaw: 0.020, lean: -0.010, armL: 0.012, armR: 0.035, swing: 0.018, osc: 0.008, breathHz: 0.22, bob: 0.007, drift: 0.009, gazeGain: 0.90 },
  // SUCCESS (Greeting/Completion): Noticeably raised arms, slight lean back, nod gesture
  SUCCESS:      { headYaw: 0.00, headPitch: 0.020, headRoll: 0.000, bodyYaw: 0.000, lean: -0.025, armL: 0.060, armR: 0.060, swing: 0.000, osc: 0.000, breathHz: 0.24, bob: 0.008, drift: 0.012, gazeGain: 0.90 },
  // Hard failure. Distinct from CONCERNED (worry) rather than louder worry: a
  // sharp downward head drop with a quick wince, arms tucked in tight, no
  // forward lean — the body reads as bracing, not leaning in to help.
  ERROR:        { headYaw: 0.00, headPitch: -0.085, headRoll: 0.000, bodyYaw: 0.000, lean: -0.055, armL: -0.045, armR: -0.045, swing: 0.000, osc: 0.000, breathHz: 0.10, bob: 0.004, drift: 0.005, gazeGain: 0.25 },
});

const GESTURE_ON_ENTER = Object.freeze({
  SUCCESS: 'nod',
  CONFUSED: 'shake',
  CONCERNED: 'notice',
  EXPLAINING: 'present',
  ERROR: 'wince',
});

/** Gesture envelopes are also scaled by intensity — a 0.1 wince is not a wince. */
const GESTURE_INTENSITY_SCALE = Object.freeze({
  nod: 1.0,
  shake: 1.0,
  notice: 1.0,
  present: 1.0,
  wince: 0.9,
  greet: 1.0,
  attentive: 1.0,
});

const HEAD_YAW_CAP = 0.45;    // rad — gaze + pose combined
const HEAD_PITCH_CAP = 0.30;
const HEAD_ROLL_CAP = 0.14;
const BODY_YAW_CAP = 0.12;
const LEAN_CAP = 0.08;        // body pitch — subtle forward/back settle only
const ARM_CAP = 0.22;         // outward appendage lift (≈12.6°) — increased for visible gestures
const SWING_CAP = 0.16;       // forward appendage swing (≈9°) — increased for visible gestures
const DAMP = 5.5;             // exponential smoothing rate (≈0.18s time constant) — increased for smoother motion
const GAZE_DAMP = 6.5;        // slightly smoother gaze

function clamp(v, max) {
  return Math.max(-max, Math.min(max, v));
}

const SCRATCH_EULER = new THREE.Euler();
const SCRATCH_QUAT = new THREE.Quaternion();

export class AnimationController {
  constructor() {
    this.model = null;
    this.headNode = null;
    this.bodyNode = null;
    this.armRigs = [];
    this.rigReady = false;

    this.headBase = new THREE.Quaternion();
    this.bodyBase = new THREE.Quaternion();
    this.headAxes = null; // { yaw, pitch, roll } in each node's LOCAL frame
    this.bodyYawAxis = null;
    this.bodyPitchAxis = null;

    this.state = 'IDLE';
    this.prevState = 'IDLE';

    // Canonical emotion label and expression scale, set from the same
    // BehaviourState snapshot the FaceController receives (renderer.js).
    // intensity 0 = rest pose, 1 = the full pose in POSES.
    this.emotion = 'IDLE';
    this.intensity = 1;

    // smoothed channels
    this.cur = {
      headYaw: 0, headPitch: 0, headRoll: 0, bodyYaw: 0,
      lean: 0, armL: 0, armR: 0, swing: 0, osc: 0,
      breathHz: 0.20, bob: 0.011, drift: 0.035, gazeGain: 0.7,
    };

    // gaze (mouse attention)
    this.gazeTarget = { x: 0, y: 0 };
    this.gazeCur = { x: 0, y: 0 };

    // attention target from Brain (for intentional head turns, separate from gaze)
    this.attentionTarget = { x: 0, y: 0, strength: 0 };
    this.attentionCur = { x: 0, y: 0 };

    // one-shot gesture envelope
    this.gesture = null; // { name, startedAt }

    // transient overlay reference (set by renderer — face controller's transient state)
    this.transientActive = false;

    this.baseY = 0;
    this.time = 0;
  }

  /**
   * Move a group's rotation pivot by `delta` while preserving the world
   * position of ALL of its content. group.position += delta, and every child
   * gets -L⁻¹·delta where L is the group's linear (rotation×scale) matrix —
   * correct even for pSphere1's non-uniform y-stretch. This generalises the
   * previous single-child compensation, which missed polySurface8 (torso) and
   * displaced it by 0.0478 world units (≈90% of its size).
   */
  movePivot(group, delta) {
    group.updateMatrix();
    const linear = group.matrix.clone().setPosition(0, 0, 0); // rotation+scale only
    linear.invert();
    const comp = delta.clone().applyMatrix4(linear).negate();
    const kids = group.children.slice();
    group.position.add(delta);
    for (const child of kids) {
      child.position.add(comp);
    }
    return comp;
  }

  /**
   * Wrap each appendage in a stretch-compensated shoulder pivot:
   *
   *   polySurface3
   *    ├── ShoulderX (position=P, scale=S⁻¹)
   *    │    └── ShoulderXRot (scale=S, quaternion=G, animated)
   *    │         └── polySurface6/7 (position = original − P)
   *
   * Net world effect of G: rigid rotation of the arm about S·P — no shear
   * from pSphere1's y-stretch. At rest (G = identity) the sandwich collapses
   * to the arm's original transform exactly, so geometry never moves.
   */
  buildShoulders(model) {
    if (!this.bodyNode) {
      return;
    }
    // Exact local scale of pSphere1 (same float64 values the runtime matrix
    // is composed from) — cancellation S⁻¹·S is then bit-exact.
    const s = this.bodyNode.scale;
    for (const spec of SHOULDER_RIGS) {
      const arm = model.getObjectByName(spec.arm);
      if (!arm || !arm.parent) {
        console.log('[BODY:RIG] appendage not found, skipping shoulder:', spec.arm);
        continue;
      }
      const host = arm.parent; // polySurface3 (identity transform)
      const pivot = new THREE.Vector3(spec.pivot[0], spec.pivot[1], spec.pivot[2]);

      const outer = new THREE.Object3D();
      outer.name = spec.outer;
      outer.position.copy(pivot);
      outer.scale.set(1 / s.x, 1 / s.y, 1 / s.z);

      const rot = new THREE.Object3D();
      rot.name = spec.rot;
      rot.scale.copy(s);

      host.add(outer);
      outer.add(rot);
      rot.add(arm);              // local transform preserved by add()
      arm.position.sub(pivot);   // T(−P) so the sandwich collapses at rest

      this.armRigs.push({ rot, side: spec.side });
    }
  }

  /**
   * Bind to the loaded GLB. Applies neck/torso pivot surgery (content world
   * positions are preserved exactly — only rotation origins move), builds the
   * shoulder rigs, and resolves each rig axis into LOCAL space so parents'
   * static transforms are handled. Fully null-safe: if expected groups are
   * missing the robot still breathes via the model root.
   */
  attach(model) {
    this.model = model;
    this.baseY = model.position.y;

    const headNode = model.getObjectByName('pSphere7');
    const bodyNode = model.getObjectByName('pSphere1');

    if (headNode) {
      this.movePivot(headNode, new THREE.Vector3(NECK_OFFSET.x, NECK_OFFSET.y, NECK_OFFSET.z));
      this.headNode = headNode;
      this.headBase.copy(headNode.quaternion);
    }

    if (bodyNode) {
      // Compensates BOTH children now: polySurface3 (arm wrapper) and
      // polySurface8 (torso) — this is the Phase 1 bug fix.
      this.movePivot(bodyNode, new THREE.Vector3(TORSO_PIVOT.x, TORSO_PIVOT.y, TORSO_PIVOT.z));
      this.bodyNode = bodyNode;
      this.bodyBase.copy(bodyNode.quaternion);
    }

    if (model) {
      this.buildShoulders(model);
    }

    model.updateMatrixWorld(true);

    if (this.headNode) {
      this.headAxes = {
        yaw: this.localAxis(this.headNode, WORLD_Y),
        pitch: this.localAxis(this.headNode, WORLD_X),
        roll: this.localAxis(this.headNode, WORLD_Z),
      };
    }
    if (this.bodyNode) {
      this.bodyYawAxis = this.localAxis(this.bodyNode, WORLD_Y);
      this.bodyPitchAxis = this.localAxis(this.bodyNode, WORLD_X);
    }

    this.rigReady = !!(this.headNode && this.bodyNode);
    console.log('[BODY:RIG]', this.rigReady
      ? `head pivot @ neck, body pivot @ torso (all children compensated), shoulders: ${this.armRigs.length}/2 — procedural rig active`
      : `partial rig (head=${!!this.headNode}, body=${!!this.bodyNode}) — breathing only`);
  }

  /** Convert a world-space direction into a node's local frame (parents are static after attach). */
  localAxis(node, worldDir) {
    const parent = node.parent;
    if (parent) {
      const pq = parent.getWorldQuaternion(new THREE.Quaternion());
      pq.invert();
      return worldDir.clone().applyQuaternion(pq).normalize();
    }
    return worldDir.clone();
  }

  /** Called by BehaviourController change events. */
  setState(state) {
    if (state === this.state) {
      return;
    }
    this.prevState = this.state;
    this.state = state;
    const gesture = GESTURE_ON_ENTER[state];
    if (gesture) {
      this.gesture = { name: gesture, startedAt: this.time };
    }
  }

  /**
   * Canonical emotion + expression scale from the same snapshot that drives
   * setState. Kept separate so a repeated EMOTION message that changes only
   * intensity (same state) still rescales the pose without restarting a
   * gesture — the dedupe window in BehaviourController deliberately suppresses
   * those repeat messages, so the Body must be able to absorb them quietly.
   */
  setEmotion(emotion, intensity) {
    if (typeof emotion === 'string' && emotion) {
      this.emotion = emotion;
    }
    if (typeof intensity === 'number' && Number.isFinite(intensity)) {
      this.intensity = Math.max(0, Math.min(1, intensity));
    }
  }

  /** Normalized mouse position in [-0.5, 0.5]. */
  setGazeTarget(nx, ny) {
    this.gazeTarget.x = clamp(nx, 0.5);
    this.gazeTarget.y = clamp(ny, 0.5);
  }

  /** Brain-directed attention target for intentional head turns.
   *  @param {number} nx Normalized x in [-0.5, 0.5]
   *  @param {number} ny Normalized y in [-0.5, 0.5]
   *  @param {number} strength 0..1 how strongly to turn toward target
   */
  setAttentionTarget(nx, ny, strength = 1) {
    this.attentionTarget.x = clamp(nx, 0.5);
    this.attentionTarget.y = clamp(ny, 0.5);
    this.attentionTarget.strength = clamp(strength, 1);
  }

  /** Externally trigger a named gesture (e.g., 'greet', 'attentive').
   *  Used by renderer for first-greeting and other explicit triggers.
   */
  triggerGesture(name) {
    if (GESTURE_MS[name]) {
      this.gesture = { name, startedAt: this.time };
    }
  }

  /** One-shot envelope contributions on top of the smoothed pose. */
  gestureOffset() {
    const out = { yaw: 0, pitch: 0, armL: 0, armR: 0 };
    if (!this.gesture) {
      return out;
    }
    const dur = GESTURE_MS[this.gesture.name] / 1000;
    const p = (this.time - this.gesture.startedAt) / dur;
    if (p >= 1) {
      this.gesture = null;
      return out;
    }
    // Amplitude follows the Brain's intensity: a near-zero intensity produces
    // no visible gesture at all rather than a full one.
    const amp = this.intensity * (GESTURE_INTENSITY_SCALE[this.gesture.name] ?? 1);
    if (this.gesture.name === 'nod') {
      // gentle double dip, decaying
      out.pitch = -0.10 * amp * Math.sin(4 * Math.PI * p) * (1 - p);
    } else if (this.gesture.name === 'shake') {
      out.yaw = 0.09 * amp * Math.sin(6 * Math.PI * p) * (1 - p);
    } else if (this.gesture.name === 'notice') {
      // small look-up-and-settle acknowledgement + very small quick arm flick
      out.pitch = 0.055 * amp * Math.sin(Math.PI * p);
      out.armL = 0.045 * amp * Math.sin(Math.PI * p);
      out.armR = 0.045 * amp * Math.sin(Math.PI * p);
    } else if (this.gesture.name === 'present') {
      // one restrained outward gesture, mostly the character's right arm
      out.armR = 0.10 * amp * Math.sin(Math.PI * p);
      out.armL = 0.03 * amp * Math.sin(Math.PI * p);
    } else if (this.gesture.name === 'wince') {
      // ERROR: a single quick recoil — head snaps down then overshoots back
      // up slightly. Two decaying beats so it reads as a flinch, not a nod.
      const beat = Math.sin(2 * Math.PI * Math.min(p * 1.6, 1));
      out.pitch = 0.085 * amp * beat * (1 - p * 0.5);
      out.yaw = 0.02 * amp * Math.sin(4 * Math.PI * p) * (1 - p);
    } else if (this.gesture.name === 'greet') {
      // Greeting: raise right arm in a friendly wave, slight head tilt
      // Phase 1 (0-0.3): arm rises
      // Phase 2 (0.3-0.7): small wave motion (wrist rotation simulated via arm swing)
      // Phase 3 (0.7-1.0): arm settles
      const wavePhase = Math.min(p / 0.3, 1);
      const settlePhase = Math.max(0, (p - 0.7) / 0.3);
      out.armR = 0.18 * amp * wavePhase * (1 - settlePhase * 0.5);
      out.armL = 0.05 * amp * wavePhase * (1 - settlePhase * 0.5);
      out.swing = 0.08 * amp * Math.sin(6 * Math.PI * p) * wavePhase * (1 - settlePhase);
      out.pitch = -0.03 * amp * Math.sin(Math.PI * p);
    } else if (this.gesture.name === 'attentive') {
      // Attentive: turn head toward interaction, slight lean forward
      // Quick turn-in, then settle into attentive pose
      const turnPhase = Math.min(p / 0.4, 1);
      out.yaw = 0.12 * amp * turnPhase * (1 - p * 0.3);
      out.pitch = 0.04 * amp * turnPhase * (1 - p * 0.2);
    }
    return out;
  }

  update(dt, modelVisible) {
    this.time += dt;
    const t = this.time;

    const pose = POSES[this.state] || POSES.IDLE;
    // Intensity scales the deviation-from-rest, not the pose itself: the target
    // for each expressive channel is blended toward that channel's rest value,
    // so intensity 0 always resolves to a calm upright robot rather than to a
    // half-applied emotion.
    const rest = POSES.IDLE;

    // 1) smooth pose channels (this IS the cross-fade — targets change, values glide)
    const k = 1 - Math.exp(-DAMP * dt);
    for (const key of Object.keys(this.cur)) {
      const base = INTENSITY_CHANNELS.includes(key)
        ? rest[key] + (pose[key] - rest[key]) * this.intensity
        : pose[key];
      this.cur[key] += (base - this.cur[key]) * k;
    }

    // 2) smooth gaze (attention) — never jitters
    const gk = 1 - Math.exp(-GAZE_DAMP * dt);
    this.gazeCur.x += (this.gazeTarget.x - this.gazeCur.x) * gk;
    this.gazeCur.y += (this.gazeTarget.y - this.gazeCur.y) * gk;

    // Smooth attention target for intentional head turns (separate from gaze)
    const ak = 1 - Math.exp(-GAZE_DAMP * dt * 0.7); // slightly slower than gaze
    this.attentionCur.x += (this.attentionTarget.x * this.attentionTarget.strength - this.attentionCur.x) * ak;
    this.attentionCur.y += (this.attentionTarget.y * this.attentionTarget.strength - this.attentionCur.y) * ak;

    // 3) deterministic slow drift — the robot is never frozen, never twitching
    const driftYaw = Math.sin(t * 0.11) * this.cur.drift + Math.sin(t * 0.041) * this.cur.drift * 0.6;
    const driftPitch = Math.sin(t * 0.07) * this.cur.drift * 0.4;

    // 4) micro-nod (THINKING/EXPLAINING): slow nod that periodically fades
    //    fully out and back in — reads as "occasional", never constant motion
    const oscMod = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 0.05 + 1.1);
    const microNod = this.cur.osc * Math.sin(t * 2 * Math.PI * 0.28) * oscMod;

    const gesture = this.gestureOffset();

    if (this.headNode) {
      // Attention target influences head turn more strongly than gaze for intentional turns
      const attentionYaw = this.attentionCur.x * 0.85 * this.cur.gazeGain;
      const gazeYaw = this.gazeCur.x * 0.55 * this.cur.gazeGain;
      const yaw = clamp(
        this.cur.headYaw + driftYaw + attentionYaw + gazeYaw + gesture.yaw,
        HEAD_YAW_CAP
      );
      const pitch = clamp(
        this.cur.headPitch + microNod + driftPitch + this.gazeCur.y * 0.30 * this.cur.gazeGain + gesture.pitch,
        HEAD_PITCH_CAP
      );
      const roll = clamp(this.cur.headRoll, HEAD_ROLL_CAP);

      this.headNode.quaternion.copy(this.headBase);
      this.applyLocalRotation(this.headNode, this.headAxes.yaw, yaw);
      this.applyLocalRotation(this.headNode, this.headAxes.pitch, pitch);
      this.applyLocalRotation(this.headNode, this.headAxes.roll, roll);
    }

    if (this.bodyNode) {
      const bodyYaw = clamp(
        this.cur.bodyYaw + this.gazeCur.x * 0.22 * this.cur.gazeGain,
        BODY_YAW_CAP
      );
      const lean = clamp(this.cur.lean, LEAN_CAP);
      this.bodyNode.quaternion.copy(this.bodyBase);
      this.applyLocalRotation(this.bodyNode, this.bodyYawAxis, bodyYaw);
      this.applyLocalRotation(this.bodyNode, this.bodyPitchAxis, lean);
    }

    // 5) appendage gestures — small, pose + envelope, clamped; sign per side
    if (this.armRigs.length) {
      for (const rig of this.armRigs) {
        const poseOut = rig.side > 0 ? this.cur.armL : this.cur.armR;
        const gestOut = rig.side > 0 ? gesture.armL : gesture.armR;
        const out = clamp(poseOut + gestOut, ARM_CAP);
        const sw = clamp(this.cur.swing, SWING_CAP);
        // side·out: outward lift away from the torso; −sw: tip toward viewer
        SCRATCH_EULER.set(-sw, 0, rig.side * out, 'XYZ');
        rig.rot.quaternion.setFromEuler(SCRATCH_EULER);
      }
    }

    if (this.model) {
      // breathing bob — pure translation, no scaling, no distortion
      const breath = Math.sin(t * this.cur.breathHz * Math.PI * 2) * this.cur.bob;
      let bobY = breath;

      // Transient laugh overlay: gentle upward bounce during active laugh.
      // Layered on top of breathing — small, periodic, reads as "excited".
      if (this.transientActive) {
        const laughBounce = Math.sin(t * 2 * Math.PI * 0.8) * 0.006;
        bobY += laughBounce;
      }

      this.model.position.y = this.baseY + bobY;
    }
  }

  applyLocalRotation(node, localAxis, angle) {
    if (!node || !localAxis || !angle) {
      return;
    }
    const q = SCRATCH_QUAT.setFromAxisAngle(localAxis, angle);
    node.quaternion.premultiply(q);
  }
}
