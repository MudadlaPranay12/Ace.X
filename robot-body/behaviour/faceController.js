/**
 * FaceController — isolated facial logic for the BotX Body.
 *
 * Pipeline position (Phase 9 fan-out — both controllers consume the SAME
 * BehaviourState; neither invents states):
 *
 *                      BehaviourState
 *                           ↓
 *              ┌────────────┴────────────┐
 *              ↓                         ↓
 *   AnimationController            FaceController (this module)
 *      (body/head/arms)          (eyes/lids/mouth/expressions)
 *              ↓                         ↓
 *            Three.js ←──────────────────┘
 *
 * eve.glb has NO facial bones or morph targets — the eyes are painted into the
 * head's emissive texture (measured: glow rgb(0,63,255), emissiveStrength 10;
 * visor baseColor rgb(0,0,0)). This module therefore builds a lightweight
 * RUNTIME FaceRig on top of the artwork (GLB is never modified):
 *
 *   pSphere7 (head group, post neck-pivot surgery)
 *    └── pSphere7_HeadR_0 (mesh node — FaceRig uses its raw mesh coords)
 *         └── FaceRig   @ measured face centre (0.200, 3.255, 0.474)
 *              ├── EyePatchL / EyePatchR  — matte-black visor patches that
 *              │                            mask the painted eye artwork
 *              ├── EyeL / EyeR            — emissive-blue digital eye discs
 *              │                            (replace, don't layer over, painted eyes)
 *              ├── LidL / LidR            — matte-black lids that close over glow
 *              └── MouthGroup             — emissive smile/laugh overlay
 *                   ├── MouthStroke       — quadratic Bezier curve
 *                   └── MouthFill         — closed fill shape for open mouth
 *
 * FIX: The duplicate-eye problem occurred because procedural eye discs were
 * rendered ON TOP of the painted emissive eyes. The fix adds matte-black
 * visor patches (EyePatchL/R) positioned slightly behind the procedural eyes
 * but in front of the painted eyes, masking the native artwork. The procedural
 * eyes then read as the sole visible eye feature.
 *
 * Transient expression system: LAUGHING is a temporary overlay that triggers
 * on SUCCESS entry. It progresses through phases (squint → smile → open
 * mouth → bounce → fade) then returns to the base SUCCESS expression.
 * This is managed entirely within FaceController — no BehaviourController
 * changes needed.
 *
 * Everything is deterministic: expression values glide with exponential
 * damping, gaze/wander are slow sines, blink timing follows a fixed
 * pseudo-random-looking interval table — no Math.random() in any render path.
 */

import * as THREE from 'three';

// ── Face placement in head-mesh space ─────────────────────────────────────
// The initial UV-mapped estimate (0.219, 3.229, 0.474) sat ~0.37 units
// INSIDE the skull — lids/eyes were depth-occluded by the head. Final values
// are the converged result of in-page pixel alignment against the painted glow.
const FACE_CENTER = Object.freeze({ x: 0.200, y: 3.255, z: 0.474 });
const FACE_NORMAL = Object.freeze({ x: 0.403, y: -0.078, z: 0.912 });

// ── Expression targets per BehaviourState ──────────────────────────────────
//   lid      0..1 base fraction closed (blink adds on top)
//   asym     extra closure on the RIGHT lid only (subtle uneven squint)
//   bright   emissive multiplier (1 = matches painted eye glow)
//   bias     gaze bias in normalized [-0.5, 0.5] units (x right, y down)
//   wander   amplitude of slow deterministic eye wander
//   pulse    breathing brightness pulse amplitude (speech/explaining)
//   blink    interval multiplier (higher = calmer/slower blinking)
//   mouth    0..1 mouth visibility (0 = hidden, 1 = fully visible)
//   mouthW   mouth width multiplier (1 = normal smile)
//   mouthO   mouth openness (0 = closed smile, 1 = open laugh mouth)
//   mouthCurve +1 = smile curvature, -1 = frown curvature (0 = flat line)
//   mouthTilt  rotation of the mouth about the face normal (rad) — asymmetric
//              questioning mouth for CONFUSED
const EXPRESSIONS = Object.freeze({
  IDLE:         { lid: 0.02, asym: 0.00, bright: 1.00, biasX: 0.00, biasY: 0.00, wander: 0.05, pulse: 0.00, blink: 1.0, mouth: 0.22, mouthW: 0.82, mouthO: 0.0, mouthCurve: 0.00, mouthTilt: 0.00 },
  CONNECTING:   { lid: 0.06, asym: 0.00, bright: 0.85, biasX: 0.00, biasY: -0.04, wander: 0.06, pulse: 0.07, blink: 1.1, mouth: 0.16, mouthW: 0.80, mouthO: 0.0, mouthCurve: 0.00, mouthTilt: 0.00 },
  DISCONNECTED: { lid: 0.46, asym: 0.04, bright: 0.38, biasX: 0.00, biasY: 0.10, wander: 0.01, pulse: 0.00, blink: 2.2, mouth: 0.14, mouthW: 0.78, mouthO: 0.0, mouthCurve: -0.25, mouthTilt: 0.00 },
  OBSERVING:    { lid: 0.00, asym: 0.00, bright: 1.15, biasX: 0.04, biasY: -0.03, wander: 0.08, pulse: 0.00, blink: 0.9, mouth: 0.18, mouthW: 0.84, mouthO: 0.0, mouthCurve: 0.00, mouthTilt: 0.00 },
  THINKING:     { lid: 0.13, asym: 0.03, bright: 1.00, biasX: 0.15, biasY: -0.16, wander: 0.24, pulse: 0.00, blink: 1.3, mouth: 0.18, mouthW: 0.80, mouthO: 0.0, mouthCurve: -0.22, mouthTilt: 0.00 },
  // ALERT. Attentive, not distressed: eyes come OPEN and BRIGHT and hold on the
  // problem, with a small tight mouth. The previous dim, half-lidded treatment
  // made ALERT read almost identically to ERROR — this keeps the two apart by
  // construction. Worry here looks AT you; failure looks down and away.
  CONCERNED:    { lid: 0.04, asym: 0.02, bright: 1.25, biasX: 0.00, biasY: -0.02, wander: 0.04, pulse: 0.04, blink: 0.9, mouth: 0.26, mouthW: 0.66, mouthO: 0.0, mouthCurve: -0.45, mouthTilt: 0.00 },
  CONFUSED:     { lid: 0.10, asym: 0.22, bright: 0.95, biasX: -0.10, biasY: 0.05, wander: 0.11, pulse: 0.00, blink: 1.1, mouth: 0.30, mouthW: 0.94, mouthO: 0.0, mouthCurve: -0.45, mouthTilt: 0.20 },
  EXPLAINING:   { lid: 0.04, asym: 0.00, bright: 1.08, biasX: 0.00, biasY: -0.02, wander: 0.05, pulse: 0.10, blink: 1.0, mouth: 0.34, mouthW: 1.00, mouthO: 0.15, mouthCurve: 1.00, mouthTilt: 0.00 },
  SUCCESS:      { lid: 0.15, asym: 0.00, bright: 1.35, biasX: 0.00, biasY: -0.09, wander: 0.05, pulse: 0.00, blink: 0.9, mouth: 0.55, mouthW: 1.05, mouthO: 0.0, mouthCurve: 1.00, mouthTilt: 0.00 },
  // Hard failure. Lids low and symmetric, eyes at their dimmest, gaze pulled
  // down and away, and the mouth inverted (mouthCurve < 0 flips the Bezier so
  // the smile becomes a frown). ALERT stays open and bright and looks at you;
  // ERROR is the one that dims, drops, and frowns. That contrast is the whole
  // point — a failure must not look like a slightly stronger warning.
  ERROR:        { lid: 0.38, asym: 0.00, bright: 0.30, biasX: 0.00, biasY: 0.16, wander: 0.02, pulse: 0.00, blink: 1.8, mouth: 0.42, mouthW: 0.90, mouthO: 0.0, mouthCurve: -1.00, mouthTilt: 0.00 },
});

/**
 * Face channels scaled by the Brain's emotion intensity. Blink cadence is NOT
 * scaled — a robot that blinks slower as an error gets worse reads as broken,
 * not sad. Gaze bias IS scaled: a low-intensity emotion should not still pull
 * the eyes hard off-centre, or intensity would visibly govern everything except
 * where the robot is looking.
 */
const INTENSITY_CHANNELS = Object.freeze([
  'lid', 'asym', 'bright', 'biasX', 'biasY', 'wander', 'mouth', 'mouthO', 'mouthCurve', 'mouthTilt',
]);

/** Rest values used as the intensity anchor (same object as EXPRESSIONS.IDLE). */
const REST = EXPRESSIONS.IDLE;

// ── Deterministic blink spacing (seconds) ─────────────────────────────────
const BLINK_INTERVALS = Object.freeze([3.1, 2.4, 4.7, 3.3, 2.8, 5.2, 3.6, 2.6]);
const BLINK_CLOSE_S = 0.06;
const BLINK_OPEN_S = 0.09;

// ── Smoothing rates ───────────────────────────────────────────────────────
const DAMP = 4.0;        // expression smoothing (≈0.25 s)
const GAZE_DAMP = 5.5;   // gaze smoothing — matches AnimationController

// ── Transient laugh timing (seconds) ──────────────────────────────────────
const LAUGH_TOTAL = 3.5;
const LAUGH_SQUINT = 0.3;
const LAUGH_MOUTH_OPEN = 0.8;
const LAUGH_HOLD = 1.5;
const LAUGH_MOUTH_CLOSE = 0.6;
const LAUGH_FADE = 0.3;

// ── Linear-space radiance matching the painted emissive eye ────────────────
// sRGB(0,63,255) → linear ≈ (0, 0.0513, 1.0), × emissiveStrength 10.
const EYE_R = 0;
const EYE_G = 0.513;
const EYE_B = 10.0;

const VISOR_R = 0;
const VISOR_G = 0;
const VISOR_B = 0;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function smoothstep(x) {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Quadratic Bezier: B(t) = (1-t)²·P0 + 2(1-t)t·P1 + t²·P2 */
function qBez(t, p0, p1, p2) {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

export class FaceController {
  constructor() {
    // Live-tunable rig parameters.
    this.cfg = {
      // Every value below is an ABSOLUTE head-local dimension (the same space
      // as FACE_CENTER and the eve.glb head mesh). There is deliberately NO
      // global face multiplier: the previous `faceScale: 2.2` grew positions,
      // sizes, lids and the mouth by the same factor, which pushed the lids off
      // the head and made the eyes/mouth far larger than the visor.
      //
      // Head mesh bounds (pSphere7_HeadR_0 POSITION accessor, head-local):
      //   x ∈ [-0.964,  0.964]  (half-width  0.964)
      //   y ∈ [ 2.577,  4.069]  (half-height 0.746, centre 3.323)
      //   z ∈ [-0.917,  0.905]  (front surface at z = 0.905)
      // The FaceRig sits at z = 0.474 and stands its features off along the
      // face normal; the usable visor is the central front region, so every
      // feature below stays well inside ±0.35 of the face centre.
      eyeRX: 0.183,        // eye half-width  (head-local)
      eyeRY: 0.108,        // eye half-height
      sep: 0.287,          // half distance between eye centres (matches painted eyes)
      eyeZ: 0.44,          // eye stand-off along the face normal
      lidZ: 0.48,          // lids sit slightly proud of the eyes
      lidRX: 0.20,         // lid ellipse half-width (covers the eye when closed)
      lidRY: 0.155,        // lid ellipse half-height
      shift: 0.42,         // gaze travel as a fraction of the eye radius
      patchR: 0.21,        // visor patch radius — masks the painted eye glow
      patchZ: 0.415,       // patches sit behind the eyes, in front of the artwork

      // Head-local centre of the painted visor face. The FaceRig origin is not
      // the visual face centre (the model's face sits left of the rig origin),
      // so every feature is offset by this measured amount. Derived by raycasting
      // the painted eye/mouth pixels onto the eye/mouth stand-off planes, then
      // refined by in-page blob measurement: the procedural eyes are centred on
      // the painted eye centroids so the black patches fully mask the artwork.
      faceCenterX: -0.42,
      faceCenterY: 0.018,

      // Head-yaw registration compensation (head-local units per radian).
      // The painted eyes are part of the curved head surface, but the procedural
      // eyes are flat discs on the FaceRig plane, so turning the head slides the
      // flat pair off the painted glow and past the matte patch margin that
      // masks it.
      //
      // Measured on the packaged app by sweeping injected head yaw and counting
      // painted-glow pixels outside the projected patch (registration offset is
      // ~0.06 head-local per radian, so the coefficient is negative to pull the
      // eyes back toward the artwork):
      //     yaw rad    0.15   0.18   0.22   0.27   0.33   0.39   0.45
      //     k =  0     18     26     13      9     34     70    122
      //     k = -0.30  18     26     20     14      2      1     19
      // The mask only starts to fail past ~0.30 rad, which needs near-maximum
      // lateral gaze (HEAD_YAW_CAP is 0.45); below that this term is exactly
      // zero-effect, and at neutral yaw it is 0 by construction.
      //
      // This is a pure horizontal REGISTRATION offset only: added to the base
      // placement of both eyes, scaled by the measured head yaw, independent of
      // gaze, and it does not touch eye size, spacing, stand-off planes, or any
      // of the geometry constants above.
      yawRegK: -0.30,

      // Mouth — authored at absolute head-local size; the group is never
      // multiplied by a global scale, only by the per-expression width/height
      // multipliers below (which stay near 1).
      mouthHalfW: 0.14,    // stroke half-width
      mouthDepth: 0.05,    // mid-stroke curve depth (negative = frown)
      mouthStrokeR: 0.02,  // tube radius
      mouthW: 1.0,         // group width multiplier
      mouthH: 1.0,         // group height multiplier
      mouthY: -0.20,       // mouth centre below the eye line
      mouthZ: 0.46,        // mouth stand-off, in front of the visor
    };

    this.ready = false;
    this.state = 'IDLE';

    // Canonical emotion label, expression scale, and whether the Brain is
    // currently delivering a SPEAKING caption. All three arrive from the same
    // BehaviourController snapshot the AnimationController receives.
    this.emotion = 'IDLE';
    this.intensity = 1;
    this.speaking = false;

    this.cur = { lid: 0.02, asym: 0, bright: 1, biasX: 0, biasY: 0, wander: 0.05, pulse: 0, mouth: 0, mouthW: 1, mouthO: 0, mouthCurve: 0, mouthTilt: 0 };
    this.gaze = { x: 0, y: 0 };
    this.gazeT = { x: 0, y: 0 };

    this.time = 0;
    this.blinkIndex = 0;
    this.blinkTimer = BLINK_INTERVALS[0];
    this.blinkPhase = -1;

    this.laughActive = false;
    this.laughTimer = 0;
    this.laughProgress = 0;
    this.laughOpacity = 0;

    this.rig = null;
    this.headNode = null;
    this.headYawRef = null;
    this._yawQ = new THREE.Quaternion();
    this._yawAxis = new THREE.Vector3();
    this.headYawValue = 0;
    this.registrationX = 0;
    this.eyeL = null;
    this.eyeR = null;
    this.lidL = null;
    this.lidR = null;
    this.eyeMat = null;
    this.eyeMatBright = null;
    this.patchL = null;
    this.patchR = null;
    this.mouthStroke = null;    // smile
    this.mouthFlat = null;      // neutral
    this.mouthFrownSoft = null; // concerned / uncertain
    this.mouthFrown = null;     // error
    this.mouthFill = null;
    this.eyePupilMat = null;
    this.eyeGlintMat = null;
    this.mouthGroup = null;
    this.mouthStrokeMat = null;
    this.mouthFillMat = null;
  }

  log(...args) {
    console.log('[BODY:FACE]', ...args);
  }

  /** Whether a transient expression (laugh) is currently active. */
  hasTransient() {
    return this.laughActive;
  }

  /**
   * Build the FaceRig. MUST be called AFTER AnimationController.attach()
   * (the head's neck-pivot surgery runs there).
   */
  attach(model) {
    if (!model) {
      return;
    }
    const head = model.getObjectByName('pSphere7');
    if (!head || !head.children.length) {
      this.log('head group not found — face rig disabled (body animation unaffected)');
      return;
    }
    const headMesh = head.children.find((c) => /HeadR/i.test(c.name)) || head.children[0];

    const rig = new THREE.Object3D();
    rig.name = 'FaceRig';
    rig.position.set(FACE_CENTER.x, FACE_CENTER.y, FACE_CENTER.z);

    const z = new THREE.Vector3(FACE_NORMAL.x, FACE_NORMAL.y, FACE_NORMAL.z).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const y = up.clone().addScaledVector(z, -up.dot(z)).normalize();
    const x = new THREE.Vector3().crossVectors(y, z).normalize();
    rig.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));

    // ── Shared geometry/materials ─────────────────────────────────────────
    const eyeGeo = new THREE.CircleGeometry(1, 28);
    // Lids are ELLIPSES (unit circles scaled to the eye aspect), never planes.
    // The old PlaneGeometry(1, 1) scaled by lidW·eyeR became an oversized black
    // rectangle that floated above the head once the eye radius was inflated.
    const lidGeo = new THREE.CircleGeometry(1, 24);

    this.eyeMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setRGB(EYE_R, EYE_G, EYE_B),
      toneMapped: true,
    });
    this.eyeMatBright = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setRGB(EYE_R * 1.4, EYE_G * 1.4, EYE_B * 1.4),
      toneMapped: true,
    });
    // Pupil (dark aperture) and catch-light (highlight) layers. Both are plain
    // discs parented to the eye, so they inherit its size, gaze offset and
    // asymmetric scaling for free. This is what turns the flat glow discs into
    // readable eyes — a bright iris, a dark pupil and a single highlight.
    this.eyePupilMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setRGB(EYE_R * 0.02, EYE_G * 0.02, EYE_B * 0.02),
      toneMapped: true,
    });
    this.eyeGlintMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setRGB(0.9, 0.98, 1.2),
      toneMapped: true,
    });
    const lidMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, toneMapped: true });
    const patchMat = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: true });

    // ── Visor patches (mask painted eyes behind procedural eyes) ──────────
    // Unit circle. applyStatic supplies the absolute radius (cfg.patchR).
    // It used to be pre-sized here AND scaled again in applyStatic, which
    // squared the radius and left the patches far too small to mask the glow.
    const patchGeo = new THREE.CircleGeometry(1, 32);
    this.patchL = new THREE.Mesh(patchGeo, patchMat);
    this.patchR = new THREE.Mesh(patchGeo, patchMat);
    this.patchL.name = 'EyePatchL';
    this.patchR.name = 'EyePatchR';

    // ── Procedural eyes ───────────────────────────────────────────────────
    this.eyeL = new THREE.Mesh(eyeGeo, this.eyeMat);
    this.eyeR = new THREE.Mesh(eyeGeo, this.eyeMat);
    this.eyeL.name = 'EyeL';
    this.eyeR.name = 'EyeR';

    // ── Iris detail: pupil + catch-light (children of each eye) ───────────
    const pupilGeo = new THREE.CircleGeometry(0.40, 24);
    const glintGeo = new THREE.CircleGeometry(0.15, 16);
    const addEyeDetail = (eye, label) => {
      const pupil = new THREE.Mesh(pupilGeo, this.eyePupilMat);
      pupil.name = `${label}Pupil`;
      pupil.position.set(0, 0, 0.012);
      const glint = new THREE.Mesh(glintGeo, this.eyeGlintMat);
      glint.name = `${label}Glint`;
      glint.position.set(-0.30, 0.34, 0.024);
      eye.add(pupil, glint);
    };
    addEyeDetail(this.eyeL, 'EyeL');
    addEyeDetail(this.eyeR, 'EyeR');

    // ── Lids ──────────────────────────────────────────────────────────────
    this.lidL = new THREE.Mesh(lidGeo, lidMat);
    this.lidR = new THREE.Mesh(lidGeo, lidMat);
    this.lidL.name = 'LidL';
    this.lidR.name = 'LidR';

    // ── Mouth (smile / laugh overlay) ─────────────────────────────────────
    this.mouthGroup = new THREE.Object3D();
    this.mouthGroup.name = 'MouthGroup';

    this.mouthStrokeMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setRGB(EYE_R * 0.9, EYE_G * 0.9, EYE_B * 0.9),
      toneMapped: true,
    });
    this.mouthFillMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setRGB(EYE_R * 0.7, EYE_G * 0.7, EYE_B * 0.7),
      side: THREE.DoubleSide,
      toneMapped: true,
    });

    // Mouth stroke — quadratic Bezier curve, extruded as a tube. The geometry
    // is AUTHORED at final head-local size (half-width, depth and tube radius
    // from cfg) instead of a unit curve scaled by a tiny multiplier: the old
    // unit curve was scaled by mouthH≈0.025, so the tube came out ~0.0005 units
    // thick and was invisible at any window size. Four baked curves cover the
    // canonical shapes (neutral / smile / concerned / error); applyMouth()
    // shows exactly one.
    const mHalfW = this.cfg.mouthHalfW;
    const mDepth = this.cfg.mouthDepth;
    const mR = this.cfg.mouthStrokeR;
    const RES = 24;

    const makeCurvedStroke = (depth) => {
      const pts = [];
      for (let i = 0; i <= RES; i++) {
        const t = i / RES;
        pts.push(new THREE.Vector3(
          qBez(t, -mHalfW, 0, mHalfW),
          qBez(t, 0, 2 * depth, 0),
          0
        ));
      }
      const curve = new THREE.CatmullRomCurve3(pts, false);
      return new THREE.TubeGeometry(curve, RES, mR, 8, false);
    };
    const makeFlatStroke = () => {
      const curve = new THREE.LineCurve3(
        new THREE.Vector3(-mHalfW, 0, 0),
        new THREE.Vector3(mHalfW, 0, 0)
      );
      return new THREE.TubeGeometry(curve, 1, mR, 8, false);
    };

    this.mouthStroke = new THREE.Mesh(makeCurvedStroke(mDepth), this.mouthStrokeMat);
    this.mouthFlat = new THREE.Mesh(makeFlatStroke(), this.mouthStrokeMat);
    this.mouthFrownSoft = new THREE.Mesh(makeCurvedStroke(-mDepth * 0.45), this.mouthStrokeMat);
    this.mouthFrown = new THREE.Mesh(makeCurvedStroke(-mDepth), this.mouthStrokeMat);
    this.mouthStroke.visible = false;
    this.mouthFlat.visible = true;
    this.mouthFrownSoft.visible = false;
    this.mouthFrown.visible = false;
    this.mouthGroup.add(this.mouthStroke, this.mouthFlat, this.mouthFrownSoft, this.mouthFrown);

    // Mouth fill — closed shape for open mouth / laugh
    const fillShape = new THREE.Shape();
    fillShape.moveTo(-mHalfW, 0);
    fillShape.quadraticCurveTo(0, mDepth * 0.9, mHalfW, 0);
    fillShape.quadraticCurveTo(0, -mDepth * 0.7, -mHalfW, 0);
    const fillGeo = new THREE.ShapeGeometry(fillShape);
    this.mouthFill = new THREE.Mesh(fillGeo, this.mouthFillMat);
    this.mouthFill.visible = false;
    this.mouthGroup.add(this.mouthFill);

    rig.add(this.patchL, this.patchR, this.eyeL, this.eyeR, this.lidL, this.lidR, this.mouthGroup);
    headMesh.add(rig);

    this.rig = rig;

    // Rest reference for the head-yaw measurement. AnimationController.attach()
    // has already run the neck-pivot surgery, so the head is still at its
    // unturned pose here: this is the world-space +X axis of the head node at
    // zero yaw, which the per-frame registration offset is measured against.
    this.headNode = head;
    head.updateWorldMatrix(true, false);
    this.headYawRef = new THREE.Vector3(1, 0, 0)
      .applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()));

    this.ready = true;
    this.applyStatic();
    this.log(`FaceRig attached @ (${FACE_CENTER.x}, ${FACE_CENTER.y}, ${FACE_CENTER.z}) ` +
      `normal (${FACE_NORMAL.x}, ${FACE_NORMAL.y}, ${FACE_NORMAL.z}) — ` +
      `eyes ${(this.cfg.sep * 2).toFixed(2)} apart, ` +
      `r=(${this.cfg.eyeRX}, ${this.cfg.eyeRY}), visor patches active`);
  }

  /**
   * Signed horizontal turn of the head, in radians, measured from the node the
   * animation system actually rotates (pSphere7) rather than from any
   * expression constant. Returns the angle the head's own +X axis has swept
   * about world +Y since the unturned pose, so it tracks every yaw contributor
   * — state yaw, slow drift, gaze-driven turn and gesture — and is 0 at rest.
   */
  headYaw() {
    const head = this.headNode;
    if (!head || !this.headYawRef) {
      return 0;
    }
    const x = this._yawAxis.set(1, 0, 0)
      .applyQuaternion(head.getWorldQuaternion(this._yawQ));
    const ref = this.headYawRef;
    return Math.atan2(x.x, x.z) - Math.atan2(ref.x, ref.z);
  }

  /** Per-frame static-size layout (cfg may be tuned live). */
  applyStatic() {
    if (!this.ready) {
      return;
    }
    const { eyeRX, eyeRY, lidRX, lidRY, patchR, eyeZ, lidZ, patchZ, sep, faceCenterX, faceCenterY } = this.cfg;

    // Eyes — absolute head-local radii, centred on the measured painted eyes.
    this.eyeL.scale.set(eyeRX, eyeRY, 1);
    this.eyeR.scale.set(eyeRX, eyeRY, 1);
    this.eyeL.position.set(faceCenterX + sep, faceCenterY, eyeZ);
    this.eyeR.position.set(faceCenterX - sep, faceCenterY, eyeZ);

    // Lids — ellipses sized to the eye, resting at z just in front of the eyes.
    this.lidL.scale.set(lidRX, lidRY, 1);
    this.lidR.scale.set(lidRX, lidRY, 1);
    this.lidL.position.z = lidZ;
    this.lidR.position.z = lidZ;

    // Visor patches — cover only the painted-eye region, behind the eyes.
    this.patchL.scale.set(patchR, patchR, 1);
    this.patchR.scale.set(patchR, patchR, 1);
    this.patchL.position.set(faceCenterX + sep, faceCenterY, patchZ);
    this.patchR.position.set(faceCenterX - sep, faceCenterY, patchZ);

    this.mouthGroup.scale.set(this.cfg.mouthW, this.cfg.mouthH, 1);
    this.mouthGroup.position.set(faceCenterX, this.cfg.mouthY, this.cfg.mouthZ);
  }

  /** @param {string} state a BehaviourState value */
  setExpression(state) {
    if (EXPRESSIONS[state]) {
      const entering = state !== this.state;
      this.state = state;
      if (entering && state === 'SUCCESS' && !this.laughActive) {
        this.triggerLaugh();
      }
    }
  }

  /**
   * Emotion + intensity + speaking flag from the BehaviourController snapshot.
   *
   * The laugh transient is suppressed at very low intensity: a Brain that asks
   * for HAPPY at intensity 0.1 wants a trace of warmth, not a laugh.
   */
  setEmotion(emotion, intensity, speaking) {
    if (typeof emotion === 'string' && emotion) {
      this.emotion = emotion;
    }
    if (typeof intensity === 'number' && Number.isFinite(intensity)) {
      this.intensity = Math.max(0, Math.min(1, intensity));
    }
    this.speaking = !!speaking;
    if (this.laughActive && this.intensity < 0.25) {
      this.laughActive = false;
      this.laughProgress = 0;
      this.laughOpacity = 0;
    }
  }

  /** Normalized mouse position in [-0.5, 0.5]. */
  setGaze(nx, ny) {
    this.gazeT.x = clamp(nx, -0.5, 0.5);
    this.gazeT.y = clamp(ny, -0.5, 0.5);
  }

  /** Request an explicit blink. */
  blink() {
    if (this.blinkPhase < 0) {
      this.blinkTimer = 0;
    }
  }

  /** Blink closure 0..1 for phase progress p∈[0,1). */
  blinkAmount(p) {
    const closeFrac = BLINK_CLOSE_S / (BLINK_CLOSE_S + BLINK_OPEN_S);
    if (p < closeFrac) {
      return smoothstep(p / closeFrac);
    }
    return smoothstep(1 - (p - closeFrac) / (1 - closeFrac));
  }

  // ── Transient laugh system ──────────────────────────────────────────────

  triggerLaugh() {
    this.laughActive = true;
    this.laughTimer = 0;
    this.laughProgress = 0;
    this.laughOpacity = 0;
  }

  updateLaugh(dt) {
    if (!this.laughActive) {
      return;
    }
    this.laughTimer += dt;
    const t = this.laughTimer;

    // Phase boundaries. The five durations sum to exactly LAUGH_TOTAL, so the
    // timeline is contiguous and the transient always ends at LAUGH_TOTAL:
    //
    //   0.0 -> 0.3  squint       progress 0 -> 1
    //   0.3 -> 1.1  mouth open   progress 1
    //   1.1 -> 2.6  hold         progress 1
    //   2.6 -> 3.2  mouth close  progress 1 -> 0
    //   3.2 -> 3.5  fade         progress 0
    //
    // Every phase interpolates against its own start, so progress is 0..1 by
    // construction. Anchoring the decay at LAUGH_TOTAL - LAUGH_FADE instead
    // left the 2.6s..3.2s window with negative fade progress, which drove
    // progress up to 3.0 and slammed the lid, brightness and mouth channels
    // into their clamps for the last ~0.4s of every laugh.
    const tOpen = LAUGH_SQUINT;                          // 0.3
    const tHold = tOpen + LAUGH_MOUTH_OPEN;              // 1.1
    const tClose = tHold + LAUGH_HOLD;                   // 2.6
    const tFade = tClose + LAUGH_MOUTH_CLOSE;            // 3.2
    // The four durations already sum to LAUGH_TOTAL (0.3+0.8+1.5+0.6+0.3 =
    // 3.5), and LAUGH_FADE is the tail that runs from tFade to the end. Taking
    // the earlier of the two keeps a shortened LAUGH_TOTAL authoritative.
    const tEnd = Math.min(tFade + LAUGH_FADE, LAUGH_TOTAL);   // 3.5

    let progress;
    if (t < tOpen) {
      progress = t / LAUGH_SQUINT;
    } else if (t < tHold) {
      progress = 1;
    } else if (t < tClose) {
      progress = 1;
    } else if (t < tFade) {
      progress = 1 - (t - tClose) / LAUGH_MOUTH_CLOSE;
    } else if (t < tEnd) {
      progress = 0;
    } else {
      this.laughActive = false;
      progress = 0;
    }
    this.laughProgress = clamp(progress, 0, 1);
    this.laughOpacity = this.laughProgress;
  }

  update(dt) {
    if (!this.ready) {
      return;
    }
    this.time += dt;
    const t = this.time;
    const expr = EXPRESSIONS[this.state] || EXPRESSIONS.IDLE;

    // 1) Glide expression channels. Intensity blends the target toward the rest
    //    face, so intensity 0 always resolves to a neutral face rather than a
    //    faint copy of the emotion. Blink cadence is excluded — it is a
    //    property of the state, not of the strength of the reaction.
    const k = 1 - Math.exp(-DAMP * dt);
    for (const key of Object.keys(this.cur)) {
      const raw = (expr[key] !== undefined) ? expr[key] : this.cur[key];
      const target = INTENSITY_CHANNELS.includes(key)
        ? REST[key] + (raw - REST[key]) * this.intensity
        : raw;
      this.cur[key] += (target - this.cur[key]) * k;
    }

    // 2) Glide gaze toward mouse target + expression bias + slow wander
    const gk = 1 - Math.exp(-GAZE_DAMP * dt);
    this.gaze.x += (this.gazeT.x - this.gaze.x) * gk;
    this.gaze.y += (this.gazeT.y - this.gaze.y) * gk;

    // One shared horizontal wander for the pair. The eyes are a single visual
    // unit, and giving each its own phase let them desync horizontally by more
    // than the matte patch margin, exposing the painted eye glow the patches
    // exist to mask. THINKING showed it clearly: its larger wander amplitude
    // combined with the head yaw to uncover a sliver at the outer edge of the
    // screen-left eye. Asymmetric expression is unaffected — it is carried by
    // the lid `asym` channel (lidEffR) and the mouth tilt, not by eye position.
    const wanderX = this.cur.wander * Math.sin(t * 0.53 + 1.1);
    const wanderY = this.cur.wander * 0.7 * Math.sin(t * 0.36 + 0.5);

    const gx = clamp((this.gaze.x + this.cur.biasX) / 0.5, -1, 1);
    const gy = clamp((this.gaze.y + this.cur.biasY) / 0.5, -1, 1);
    const { eyeRX, eyeRY, shift, sep, lidRY, faceCenterX, faceCenterY, yawRegK } = this.cfg;
    const maxX = eyeRX * shift;
    const maxY = eyeRY * shift;

    // Yaw registration offset. Because the painted eyes ride the curved head
    // surface while these are flat discs on the FaceRig plane, turning the head
    // separates the two in screen space; this tracks the real head yaw and
    // re-seats the pair on the painted glow. It is added to the shared base
    // placement, so both eyes move by the same amount and the rigid pair
    // relationship (2 * sep) is untouched, and it is independent of gx, so
    // cursor/attention gaze still works exactly as before.
    this.headYawValue = this.headYaw();
    const registrationX = yawRegK * Math.sin(this.headYawValue);
    this.registrationX = registrationX;

    const sx = (gx + wanderX) * maxX + registrationX;
    const sy = (gy + wanderY) * maxY;

    // 3) Blink scheduler
    let blink = 0;
    if (this.blinkPhase >= 0) {
      this.blinkPhase += dt / (BLINK_CLOSE_S + BLINK_OPEN_S);
      if (this.blinkPhase >= 1) {
        this.blinkPhase = -1;
        this.blinkIndex++;
        this.blinkTimer = BLINK_INTERVALS[this.blinkIndex % BLINK_INTERVALS.length] * this.curBlinkScale();
      } else {
        blink = this.blinkAmount(this.blinkPhase);
      }
    } else {
      this.blinkTimer -= dt;
      if (this.blinkTimer <= 0) {
        this.blinkPhase = 0;
      }
    }

    // 4) Update transient laugh
    this.updateLaugh(dt);

    // 5) Apply transient overlay — squint during laugh
    const transientLid = this.laughActive ? this.laughProgress * 0.45 : 0;
    const transientBright = this.laughActive ? this.laughProgress * 0.15 : 0;
    const effLid = clamp(this.cur.lid + transientLid, 0, 1);
    const effBright = clamp(this.cur.bright + transientBright, 0, 2);

    // 6) Apply eyes — centred on the measured painted-face centre so the
    // procedural eyes sit exactly where the model's painted eyes are.
    this.eyeL.position.x = faceCenterX + sep + sx;
    this.eyeR.position.x = faceCenterX - sep + sx;
    this.eyeL.position.y = faceCenterY + sy;
    this.eyeR.position.y = faceCenterY + sy;

    const pulse = this.cur.pulse > 0 ? 1 + this.cur.pulse * Math.sin(t * 2 * Math.PI * 1.15) : 1;
    const b = Math.max(0.05, effBright * pulse);
    const useBrightMat = b > 1.15;
    const mat = useBrightMat ? this.eyeMatBright : this.eyeMat;
    if (this.eyeL.material !== mat) { this.eyeL.material = mat; }
    if (this.eyeR.material !== mat) { this.eyeR.material = mat; }
    mat.color.setRGB(EYE_R * b, EYE_G * b, EYE_B * b);
    // Catch-light tracks the eye's overall brightness, so a dimmed ERROR eye
    // does not keep a fully bright pinpoint.
    const glintB = clamp(b, 0, 1);
    this.eyeGlintMat.color.setRGB(0.35 + 0.65 * glintB, 0.45 + 0.55 * glintB, 0.65 + 0.55 * glintB);

    // 7) Apply visor patches — same xy as eyes, z slightly behind
    this.patchL.position.x = this.eyeL.position.x;
    this.patchR.position.x = this.eyeR.position.x;
    this.patchL.position.y = this.eyeL.position.y;
    this.patchR.position.y = this.eyeR.position.y;
    this.patchL.position.z = this.cfg.patchZ;
    this.patchR.position.z = this.cfg.patchZ;

    // 8) Apply lids — closure = max(expression, blink); right lid gets asym.
    // Rest position sits the lid exactly one lid-half-height above the eye, so
    // an open lid stays adjacent to (never far above) the visor.
    const lidRest = eyeRY + lidRY;
    const lidEffL = clamp(Math.max(effLid, blink), 0, 1);
    const lidEffR = clamp(Math.max(effLid + this.cur.asym, blink), 0, 1);
    this.lidL.position.x = this.eyeL.position.x;
    this.lidR.position.x = this.eyeR.position.x;
    this.lidL.position.y = faceCenterY + sy + lidRest * (1 - lidEffL);
    this.lidR.position.y = faceCenterY + sy + lidRest * (1 - lidEffR);

    // 9) Apply mouth
    this.applyMouth(dt, t);
  }

  applyMouth(dt, t) {
    const baseMouth = this.cur.mouth;
    const transientMouth = this.laughActive ? this.laughOpacity * 0.85 : 0;
    let mouthAlpha = clamp(baseMouth + transientMouth, 0, 1);

    // Curvature selects which stroke geometry is shown. Negative = frown
    // (ERROR, and a light frown for CONFUSED), positive = smile.
    const curve = this.cur.mouthCurve;
    const frowning = curve < -0.05;

    // Speech articulation: while the Brain is delivering a SPEAKING caption the
    // mouth opens and closes on a deterministic syllable rhythm (two
    // incommensurate frequencies, so it never loops audibly). This is what
    // makes the companion look like it is talking rather than holding a pose.
    let speechOpen = 0;
    if (this.speaking && !frowning) {
      const syllable = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 3.1);
      const emphasis = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 5.7 + 1.3);
      speechOpen = (0.25 + 0.55 * syllable * emphasis) * this.intensity;
    }

    if (mouthAlpha < 0.01 && speechOpen < 0.02) {
      this.mouthGroup.visible = false;
      return;
    }
    this.mouthGroup.visible = true;
    if (speechOpen > 0) {
      mouthAlpha = clamp(mouthAlpha + speechOpen * 0.7, 0, 1);
    }

    let activeStroke = this.mouthFlat;
    if (curve >= 0.5) {
      activeStroke = this.mouthStroke;
    } else if (curve <= -0.75) {
      activeStroke = this.mouthFrown;
    } else if (curve <= -0.2) {
      activeStroke = this.mouthFrownSoft;
    }
    for (const stroke of [this.mouthStroke, this.mouthFlat, this.mouthFrownSoft, this.mouthFrown]) {
      stroke.visible = stroke === activeStroke;
    }

    const baseOpen = this.cur.mouthO;
    const transientOpen = this.laughActive ? this.laughProgress * 0.7 : 0;
    const openness = clamp(baseOpen + transientOpen + speechOpen, 0, 1);

    const wScale = this.cur.mouthW * (1 + openness * 0.3);

    // Subtle smile curve oscillation for active states
    const smilePulse = this.state === 'EXPLAINING'
      ? Math.sin(t * 2 * Math.PI * 1.15) * 0.05
      : Math.sin(t * 0.7) * 0.02;

    // A frowning mouth should not pulse as if it were smiling, and speech
    // articulation scales the pulse too so the shape change reads as motion.
    const pulseScale = frowning ? 0 : (0.4 + openness * 0.6);

    this.mouthGroup.scale.set(
      this.cfg.mouthW * wScale,
      this.cfg.mouthH * (1 + openness * 0.5),
      1
    );
    // CONFUSED tilts the mouth about the face normal for a questioning look.
    this.mouthGroup.rotation.z = this.cur.mouthTilt;

    // Stroke intensity — same emissive treatment for every shape, so the form
    // is what changes, not the colour. Keep a readable floor: scaling the glow
    // linearly by the (subtle, ~0.2) idle visibility made the mouth vanish.
    const strokeBright = 0.4 + 0.6 * mouthAlpha + smilePulse * pulseScale;
    this.mouthStrokeMat.color.setRGB(
      EYE_R * strokeBright,
      EYE_G * strokeBright,
      EYE_B * strokeBright
    );

    // Open mouth fill (visible during laugh / speech)
    const showFill = openness > 0.15;
    this.mouthFill.visible = showFill;
    if (showFill) {
      const fillAlpha = (openness - 0.15) / 0.85;
      this.mouthFillMat.color.setRGB(
        EYE_R * 0.5 * fillAlpha,
        EYE_G * 0.5 * fillAlpha,
        EYE_B * 0.5 * fillAlpha
      );
      this.mouthFill.scale.set(1, openness, 1);
    }
  }

  /** Blink interval scale for the current expression. */
  curBlinkScale() {
    const expr = EXPRESSIONS[this.state] || EXPRESSIONS.IDLE;
    return expr.blink;
  }
}
