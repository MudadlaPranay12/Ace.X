/**
 * robot.js — canonical Ace.X Eve runtime inside the VS Code Webview.
 *
 * DIAGNOSTICS-ONLY surface. It reuses the proven Body pipeline modules
 * (staged under ./body/):
 *
 *   Brain postMessage → mapMessage → BehaviourController → AnimationController → Three.js
 *                                                                          ↘ FaceController
 *
 * The Brain decides everything; this file only expresses Brain state and
 * renders the Eve GLB. It posts readiness/render proof back, but NEVER
 * renders its own Explain / Fix / Dismiss action buttons: the floating Eve
 * popup is the ONE primary intervention surface, and a second button set
 * here would act on a possibly different issue. The response bar below Eve
 * shows Brain text only.
 *
 * Gaze smoothing uses a small PD loop and the opening camera move uses a
 * quintic ease — both shape motion only, never decisions.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mapMessage } from './body/behaviour/actionMapper.js';
import { BehaviourController } from './body/behaviour/behaviourController.js';
import { AnimationController } from './body/behaviour/animationController.js';
import { FaceController } from './body/behaviour/faceController.js';

const vscode = acquireVsCodeApi();
const SURFACE = document.body.dataset.surface || 'view';
const MODEL_URI = document.body.dataset.model || './eve.glb';

const behaviour = new BehaviourController();
const animation = new AnimationController();
const face = new FaceController();

let scene = null;
let camera = null;
let renderer = null;
let model = null;
let clock = null;
let rafId = 0;
let running = false;
/** True while the host suspended this surface (single-active-Eve rule). */
let hostSuspended = false;
let flyInStart = 0;
const FLY_IN_MS = 1400;
const CAMERA_REST_Z = 5;

// PD gaze smoothing: Brain-approved target in, critically-damped gaze out.
const gazePd = { x: 0, y: 0, vx: 0, vy: 0, kp: 10, kd: 3.5 };
const mouseGaze = { x: 0, y: 0 };

const canvas = document.getElementById('robotCanvas');
const responseBar = document.getElementById('responseBar');
const responseLabel = document.getElementById('responseLabel');
const responseText = document.getElementById('responseText');
const responseActions = document.getElementById('responseActions');
const eveStatus = document.getElementById('eveStatus');

function eveLog(stage, detail) {
  console.log(`[Eve] ${stage}${detail ? ` — ${detail}` : ''}`);
}

function showEveStatus(text, isError) {
  if (!eveStatus) {
    return;
  }
  eveStatus.textContent = text;
  eveStatus.classList.remove('hidden');
  eveStatus.classList.toggle('error', !!isError);
}

function hideEveStatus() {
  if (eveStatus) {
    eveStatus.classList.add('hidden');
  }
}

/** Success is shown briefly so the state is seen, never left as clutter. */
let onlineTimer = 0;
function showEveOnline() {
  showEveStatus('Eve Online', false);
  if (onlineTimer) {
    clearTimeout(onlineTimer);
  }
  onlineTimer = setTimeout(() => {
    onlineTimer = 0;
    if (eveStatus && eveStatus.textContent === 'Eve Online') {
      hideEveStatus();
    }
  }, 2000);
}

function showEveFailed(detail) {
  const short = String(detail).slice(0, 160);
  showEveStatus(`Eve failed to load: ${short}`, true);
}

function quinticEase(t) {
  const x = Math.max(0, Math.min(1, t));
  return 10 * x * x * x - 15 * x * x * x * x + 6 * x * x * x * x * x;
}

function pdStep(current, vel, target, dt, kp, kd, lo, hi) {
  const step = Math.max(1 / 240, Math.min(0.1, dt));
  const accel = kp * (target - current) - kd * vel;
  const nextVel = vel + accel * step;
  const next = current + nextVel * step;
  return [Math.max(lo, Math.min(hi, next)), nextVel];
}

function describeBox(box) {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const round = (v) => Math.round(v * 1000) / 1000;
  return `size=(${round(size.x)},${round(size.y)},${round(size.z)}) center=(${round(center.x)},${round(center.y)},${round(center.z)})`;
}

function statsFor(root) {
  let meshes = 0;
  const materials = new Set();
  root.traverse((node) => {
    if (node.isMesh) {
      meshes += 1;
      const list = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of list) {
        if (material) {
          materials.add(material.type);
        }
      }
    }
  });
  return { meshes, materials: [...materials] };
}

function init() {
  eveLog('boot', `surface=${SURFACE}`);
  showEveStatus('Initializing Eve...', false);
  scene = new THREE.Scene();
  clock = new THREE.Clock();
  eveLog('Three.js initialized', `revision=${THREE.REVISION}`);
  camera = new THREE.PerspectiveCamera(45, window.innerWidth / Math.max(1, window.innerHeight - 80), 0.1, 100);
  camera.position.set(0, 0, 8);
  eveLog('camera initialized', 'fov=45 near=0.1 far=100 z=8');

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  eveLog('renderer ready', 'ACES tone mapping, sRGB, alpha');

  scene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(5, 5, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x00f0ff, 1.5);
  rim.position.set(-5, 2, -5);
  scene.add(rim);
  eveLog('lights created', 'ambient + key + rim');

  eveLog('GLTFLoader initialized', `model=${MODEL_URI}`);
  eveLog('loading Eve GLB', MODEL_URI);
  new GLTFLoader().load(MODEL_URI, (gltf) => {
    try {
      eveLog('Eve GLB loaded', `${gltf.animations.length} animation clip(s)`);
      model = gltf.scene;
      scene.add(model);
      eveLog('model added to scene', 'scene.add(model)');
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3()).length();
      const center = box.getCenter(new THREE.Vector3());
      const fitScale = 3 / size;
      model.scale.setScalar(fitScale);
      model.position.set(-center.x * fitScale, -center.y * fitScale, -center.z * fitScale);
      model.scale.multiplyScalar(0.9);
      eveLog('model framed', `${describeBox(box)} fitScale=${Math.round(fitScale * 1000) / 1000}`);
      let animationReady = false;
      let faceRigReady = false;
      try {
        animation.attach(model);
        animationReady = true;
        eveLog('motion controller attached', 'AnimationController');
      } catch (attachError) {
        eveLog('motion attach FAILED', String(attachError));
      }
      try {
        face.attach(model);
        faceRigReady = true;
        eveLog('FaceRig attached', 'FaceController runtime rig');
      } catch (attachError) {
        eveLog('FaceRig attach FAILED', String(attachError));
      }
      animation.setState(behaviour.getViewState());
      face.setExpression(behaviour.getViewState());
      const stats = statsFor(model);
      eveLog('model visible', `${stats.meshes} mesh(es), materials=[${stats.materials.join(',')}]`);
      showEveOnline();
      flyInStart = performance.now();
      vscode.postMessage({
        type: 'ROBOT_RENDERED',
        surface: SURFACE,
        meshes: stats.meshes,
        materials: stats.materials,
        animations: gltf.animations.length,
        animationReady,
        faceRigReady,
        bbox: describeBox(box),
      });
      eveLog('robot READY', 'Eve is rendering — behaviour loop live');
    } catch (error) {
      eveLog('Eve setup FAILED', String(error));
      showEveFailed(error);
      vscode.postMessage({ type: 'ROBOT_ERROR', surface: SURFACE, error: String(error) });
    }
  }, undefined, (error) => {
    eveLog('Eve GLB load FAILED', String(error && error.message ? error.message : error));
    showEveFailed(error && error.message ? error.message : error);
    vscode.postMessage({
      type: 'ROBOT_ERROR',
      surface: SURFACE,
      error: String(error && error.message ? error.message : error),
    });
  });

  behaviour.setLinkStatus('connected');
  behaviour.onChange((snapshot) => {
    const intensity = behaviour.getEffectiveIntensity();
    animation.setState(snapshot.viewState);
    animation.setEmotion(snapshot.emotion, intensity);
    face.setExpression(snapshot.viewState);
    face.setEmotion(snapshot.emotion, intensity, snapshot.speaking);
    renderResponseBar(snapshot);
  });

  window.addEventListener('mousemove', (e) => {
    mouseGaze.x = e.clientX / window.innerWidth - 0.5;
    mouseGaze.y = e.clientY / window.innerHeight - 0.5;
  });
  window.addEventListener('resize', () => {
    if (!camera || !renderer) {
      return;
    }
    camera.aspect = window.innerWidth / Math.max(1, window.innerHeight - 80);
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  window.addEventListener('message', (event) => onHostMessage(event.data));
  // One animation loop only, paused while the view is hidden so a background
  // Eve costs no GPU. Host SUSPEND (inactive surface) always wins.
  document.addEventListener('visibilitychange', () => {
    if (hostSuspended) {
      return;
    }
    if (document.hidden) {
      stopLoop();
    } else {
      startLoop();
    }
  });
  vscode.postMessage({ type: 'ROBOT_READY', surface: SURFACE });
  startLoop();
}

function onHostMessage(message) {
  if (!message || typeof message.type !== 'string') {
    return;
  }
  if (message.type === 'SUSPEND') {
    hostSuspended = true;
    stopLoop();
    return;
  }
  if (message.type === 'RESUME') {
    hostSuspended = false;
    if (!document.hidden) {
      startLoop();
    }
    return;
  }
  if (message.type === 'STATE_SYNC' && Array.isArray(message.payloads)) {
    for (const payload of message.payloads) {
      applyPayload(payload);
    }
    return;
  }
  if (message.type === 'ROBOT_STATE' && message.payload) {
    applyPayload(message.payload);
  }
}

function applyPayload(payload) {
  const intent = mapMessage(payload);
  if (!intent) {
    return;
  }
  switch (intent.kind) {
    case 'link':
      behaviour.setLinkStatus(intent.status);
      break;
    case 'attention':
      behaviour.setAttentionTarget(intent.target);
      break;
    case 'teaching':
      behaviour.setTeachingState(intent);
      break;
    case 'caption':
      behaviour.setCaption(intent.text, intent.holdMs, intent.mode);
      break;
    case 'struggle':
      break;
    default:
      behaviour.submit(intent);
      break;
  }
  refreshResponseBar();
}

function refreshResponseBar() {
  renderResponseBar(behaviour.snapshot());
}

function renderResponseBar(snapshot) {
  const caption = snapshot.caption;
  if (!caption) {
    // Idle shows only Eve. Thinking/explaining without words yet gets one
    // small, subtle indicator — never an empty card, never buttons.
    if (snapshot.viewState === 'THINKING' || snapshot.viewState === 'EXPLAINING') {
      responseBar.classList.remove('hidden');
      responseLabel.textContent = snapshot.viewState === 'THINKING' ? 'EVE · THINKING' : 'EVE · EXPLAINING';
      responseText.textContent = '…';
      responseActions.innerHTML = '';
      return;
    }
    responseBar.classList.add('hidden');
    responseActions.innerHTML = '';
    return;
  }
  responseBar.classList.remove('hidden');
  responseLabel.textContent = labelFor(snapshot);
  if (responseText.textContent !== caption) {
    responseText.textContent = caption;
  }
  buildActions(snapshot);
}

function labelFor(snapshot) {
  if (snapshot.viewState === 'ERROR') {
    return 'EVE · ERROR';
  }
  if (snapshot.viewState === 'EXPLAINING') {
    return 'EVE · EXPLAINING';
  }
  if (snapshot.teaching && snapshot.teaching.level >= 2) {
    return 'EVE · HINT';
  }
  return 'EVE';
}

function buildActions(snapshot) {
  // Diagnostics-only: this surface renders Brain text and never its own
  // Explain / Fix / Dismiss buttons. The floating Eve popup owns the ONE
  // primary action set; a second set here could target a different issue.
  // The container is always cleared so a stale button row can never linger.
  responseActions.innerHTML = '';
}

function applyGaze(dt) {
  const target = behaviour.getAttentionTarget();
  let gx = mouseGaze.x;
  let gy = mouseGaze.y;
  if (target && target.vector) {
    const w = Math.max(0, Math.min(1, target.strength));
    gx = gx * (1 - w) + target.vector.x * w;
    gy = gy * (1 - w) + target.vector.y * w;
  }
  const [sx, svx] = pdStep(gazePd.x, gazePd.vx, gx, dt, gazePd.kp, gazePd.kd, -0.5, 0.5);
  const [sy, svy] = pdStep(gazePd.y, gazePd.vy, gy, dt, gazePd.kp, gazePd.kd, -0.5, 0.5);
  gazePd.x = sx;
  gazePd.vx = svx;
  gazePd.y = sy;
  gazePd.vy = svy;
  animation.setGazeTarget(gazePd.x, gazePd.y);
  face.setGaze(gazePd.x, gazePd.y);
}

function startLoop() {
  if (running) {
    return;
  }
  running = true;
  const frame = () => {
    if (!running) {
      return;
    }
    rafId = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.1);
    if (flyInStart > 0 && camera.position.z > CAMERA_REST_Z) {
      const progress = (performance.now() - flyInStart) / FLY_IN_MS;
      camera.position.z = 8 + (CAMERA_REST_Z - 8) * quinticEase(progress);
      if (progress >= 1) {
        camera.position.z = CAMERA_REST_Z;
        flyInStart = 0;
      }
    }
    behaviour.tick();
    const snapshot = behaviour.snapshot();
    const intensity = behaviour.getEffectiveIntensity();
    applyGaze(dt);
    animation.setState(snapshot.viewState);
    animation.setEmotion(snapshot.emotion, intensity);
    face.setEmotion(snapshot.emotion, intensity, snapshot.speaking);
    animation.transientActive = face.hasTransient();
    animation.update(dt, !!model);
    face.update(dt);
    renderer.render(scene, camera);
  };
  rafId = requestAnimationFrame(frame);
}

function stopLoop() {
  running = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

try {
  init();
} catch (error) {
  // A rendering failure must stay inside the view: report it so the host can
  // see the failure without the Brain being affected. Never render a fake
  // robot in place of Eve — show the honest failure state instead.
  eveLog('init FAILED', String(error));
  showEveFailed(error);
  vscode.postMessage({ type: 'ROBOT_READY', surface: SURFACE, degraded: String(error) });
  vscode.postMessage({ type: 'ROBOT_ERROR', surface: SURFACE, error: String(error) });
}
