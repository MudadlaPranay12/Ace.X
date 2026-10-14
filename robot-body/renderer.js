/**
 * renderer.js — Three.js bootstrap + wiring for the BotX Body.
 *
 * Pipeline (see behaviour/ for each stage):
 *   WebSocket → MessageParser → ActionMapper → BehaviourController → AnimationController
 *                                                                      ↘ FaceController
 * Both physical controllers consume the SAME BehaviourState snapshot — the
 * Body never invents cognitive states; it only expresses what the Brain decided.
 *
 * The WebSocket itself lives in the Electron MAIN process (wsClient.js) and
 * arrives here through window.brainAPI (preload.js).
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mapMessage } from './behaviour/actionMapper.js';
import { BehaviourController } from './behaviour/behaviourController.js';
import { AnimationController } from './behaviour/animationController.js';
import { FaceController } from './behaviour/faceController.js';

const log = (...args) => console.log('[BODY:RENDERER]', ...args);

// Speech output now goes through speakSummary() below (concise form only,
// with a truthful speaking state). The old full-text helpers are retired.

// Dev-only connection badge. The polished companion never shows a floating
// status chip — the robot expresses link state through its own face/behaviour
// (CONNECTING / DISCONNECTED poses). Load with ?debugStatus=1 (or set
// window.__BOTX_DEBUG_STATUS__ = true before renderer init) to reveal it.
const DEBUG_STATUS = (() => {
  try {
    return new URLSearchParams(window.location.search).get('debugStatus') === '1' ||
      window.__BOTX_DEBUG_STATUS__ === true;
  } catch (err) {
    return false;
  }
})();

let scene, camera, renderer, model, clock;
const behaviour = new BehaviourController();
const animation = new AnimationController();
const face = new FaceController();

// UI elements — the ONE Eve popup bar (issue surface) + response text.
// No chat panel, no voice dashboard: voice is one mic button + status line.
let responseBubble, bubbleState, bubbleType, bubbleText, bubbleActions;
let bubbleFile, bubbleDetails, bubbleVoice;

/**
 * Latest structured popup from the Brain (ISSUE_STATE). Null means "no
 * intervention": the bar hides and only Eve remains. The Brain decides;
 * this page only renders.
 */
let latestIssue = null;
/** Last matter rendered — a new matter resets the collapsed/expanded view. */
let lastIssueMatter = '';
/** Local expand override for the details section (presentation only). */
let detailsOpen = false;
const explanationRequests = new Map();
let requestSequence = 0;
let chatPending = null;
// Eve window mode: 'full' (existing 3D interface) or 'mini' (circular face).
// The MAIN process owns the window bounds; this flag only gates rendering and
// which view is visible. Mode changes always round-trip through main.
let eveMode = 'full';
/** Last link|viewState pushed to the mini face — DOM is touched only on change. */
let lastMiniKey = '';
/** A Brain CHAT_OPEN that arrived while mini: honoured on reaching full mode. */
let pendingChatOpen = false;
const chatReplies = new Map();
function nextRequestId() { return `${Date.now()}-${++requestSequence}`; }
function issueKey(issue) {
  return JSON.stringify([issue?.filePath || '', issue?.line || 0, issue?.message || '', issue?.severity || '']);
}
/** Last popup signature logged, so show/hide lines describe real changes. */
let lastPopupLog = '';

// Voice runtime state. Every label below reflects the actual recognizer and
// speech engine state — "Listening" is shown only while recording.
const voice = {
  state: 'idle', // idle | listening | processing | speaking | error
  recognition: null,
  error: '',
};

function init() {
  log('init() START');
  scene = new THREE.Scene();
  clock = new THREE.Clock();

  const canvas = document.getElementById('robotCanvas');
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
  // Position camera at natural height. Look slightly above model center (0, 0.15, 0)
  // to push Eve down in the viewport, centering her visually. The top bar is
  // separate HTML; canvas covers full viewport. Model bbox center ≈ (0,0,0) but
  // visual mass is lower (legs/feet), so a positive lookAt Y centers the silhouette.
  camera.position.set(0, 0.15, 5);
  camera.lookAt(0, 0.15, 0);

  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(width, height);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // Studio Lighting
  const ambient = new THREE.AmbientLight(0xffffff, 1.5);
  scene.add(ambient);

  const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
  keyLight.position.set(5, 5, 5);
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0x00f0ff, 1.5);
  rimLight.position.set(-5, 2, -5);
  scene.add(rimLight);

  const modelUri = window.__BOTX_MODEL_URI__ || 'assets/eve.glb';
  log(`Starting GLB load: ${modelUri}`);

  const loader = new GLTFLoader();
  let loadTimeout = setTimeout(() => {
    log('GLB load TIMEOUT after 10s');
  }, 10000);
  loader.load(modelUri, (gltf) => {
    clearTimeout(loadTimeout);
    log(`GLB load SUCCESS`);
    model = gltf.scene;
    scene.add(model);

    // Auto-scale + CENTER the model. Eve's authored content sits off-origin
    // (every part shares a −4.78 node offset → bbox centre x ≈ −0.048), and
    // scaling without recentering threw the robot entirely off-frame left
    // (pixel validation measured NDC x ≈ −2.6, silhouette count 0). The
    // committed original Body was a 2D SVG robot — there was no prior 3D
    // framing to preserve. Content centre now lands exactly at the scene
    // origin (camera looks at it); breathing bob reuses this as baseY.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3()).length();
    const center = box.getCenter(new THREE.Vector3());
    // Scale Eve to fill the compact window: the model's authored diagonal is
    // normalised to ~3.0 world units, which projects to ~170 CSS px tall in the
    // 240×270 default window (DPR 1.25) — inside the 150–180 px target with
    // headroom so she is never clipped at the minimum window size. Tuned
    // against the real Electron renderer (measurement harness, not shipped).
    const fitScale = 3.0 / size;
    model.scale.setScalar(fitScale);
    model.position.set(-center.x * fitScale, -center.y * fitScale, -center.z * fitScale);

    log(`GLB loaded: ${modelUri}`);
    log(`animation clips in eve.glb: ${gltf.animations.length}` +
      (gltf.animations.length === 0
        ? ' (static rig — procedural behaviour active)'
        : ` → [${gltf.animations.map(c => c.name).join(', ')}]`));

    // Order matters: AnimationController.attach() runs the head/body pivot
    // surgery first; the FaceRig parents onto the head mesh node afterwards.
    animation.attach(model);
    face.attach(model);
    animation.setState(behaviour.getViewState());
    face.setExpression(behaviour.getViewState());
    animate();
  }, (progress) => {
    if (progress.lengthComputable) {
      const percent = Math.round((progress.loaded / progress.total) * 100);
      log(`GLB load progress: ${percent}%`);
    }
  }, (err) => {
    clearTimeout(loadTimeout);
    log('ERROR loading 3D model:', String(err));
    animate(); // keep behaviour/status alive even without the model
  });

  document.body.classList.toggle('botx-debug-status', DEBUG_STATUS);
  wireBrainLink();
  wireStatusDom();
  wirePopupDom();
  wireChat();
  wireGaze();
  wireResize();
  wireModeButtons();

  // Validation/debug handle (harmless in production; used to drive states,
  // burst-step animation deterministically, and tune face rig parameters
  // during visual verification — the preview webview throttles RAF to 0).
  window.__botx = { behaviour, animation, face, renderer, scene, camera, frame: animate };
}

// ---------------------------------------------------------------------------
// Brain link (messages arrive via the main process preload bridge)
// ---------------------------------------------------------------------------
function wireBrainLink() {
  if (!window.brainAPI) {
    log('WARNING: window.brainAPI missing — WebSocket bridge unavailable');
    return;
  }

  window.brainAPI.onStatus((status) => {
    log('link status:', status);
    behaviour.setLinkStatus(status);
    refreshDom(behaviour.snapshot());
  });

  // Window mode changes applied by the main process (it owns the bounds).
  if (window.brainAPI.onMode) {
    window.brainAPI.onMode((mode) => applyEveMode(mode));
  }

  window.brainAPI.onMessage((message) => {
    log('message received:', message.type, message.animation || message.expression || '');
    // Reconnect state sync: replay the Brain's current canonical frames in
    // order through the same mapping, so a restarted Eve lands on present
    // state instead of replaying stale motion.
    if (message.type === 'STATE_SYNC' && Array.isArray(message.payloads)) {
      log(`STATE_SYNC: replaying ${message.payloads.length} canonical frame(s)`);
      for (const payload of message.payloads) {
        applyBrainPayload(payload);
      }
      refreshDom(behaviour.snapshot());
      return;
    }
    if (message.type === 'BRAIN_READY') {
      log('BRAIN_READY: Brain link established');
      behaviour.setLinkStatus('connected');
      refreshDom(behaviour.snapshot());
      return;
    }
    applyBrainPayload(message);
  });
}

function applyBrainPayload(message) {
  if (!message || typeof message.type !== 'string') {
    return;
  }
  if (message.type === 'CHAT_OPEN') {
    // Chat lives in the full interface. If Eve is mini, request expansion and
    // open the panel when the mode actually lands — never a fixed delay, so a
    // slow transition cannot swallow the request.
    if (eveMode !== 'full' && window.brainAPI && window.brainAPI.setMode) {
      pendingChatOpen = true;
      window.brainAPI.setMode('full');
      return;
    }
    openChatPanel();
    return;
  }
  if (message.type === 'EVE_RESPONSE') {
    if (message.kind === 'explain') {
      const request = explanationRequests.get(message.issueKey);
      if (request && request.requestId === message.requestId) {
        clearTimeout(request.timer);
        Object.assign(request, message);
        if (message.status !== 'loading') { detailsOpen = true; }
        refreshResponseBar();
      }
    } else if (message.kind === 'chat') {
      const history = document.getElementById('chatHistory');
      const nearBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 80;
      let entry = chatReplies.get(message.requestId);
      if (!entry) {
        entry = document.createElement('div');
        document.getElementById('chatHistory').appendChild(entry);
        chatReplies.set(message.requestId, entry);
      }
      renderChatEntry(entry, `Eve${message.status === 'error' ? ' — error' : ''}:`, message.text, message.status === 'error');
      if (message.status !== 'loading' && chatPending === message.requestId) {
        chatPending = null;
        document.getElementById('chatSend').disabled = false;
      }
      if (nearBottom) entry.scrollIntoView({ block: 'nearest' });
    }
    return;
  }
  // Structured popup state from the Brain. A new matter resets the local
  // expand override so each intervention starts at the Brain-chosen depth.
  if (message.type === 'ISSUE_STATE' && message.state && typeof message.state === 'object') {
    const incoming = message.state;
    if (!latestIssue || latestIssue.matter !== incoming.matter) {
      detailsOpen = false;
    }
    latestIssue = incoming;
    refreshResponseBar();
    return;
  }
  {
    const intent = mapMessage(message);
    if (!intent) {
      // Handle VOICE_STATE directly since it's not mapped by mapMessage
      if (message.type === 'VOICE_STATE' && typeof message.enabled === 'boolean') {
        log('Voice state synced from Brain:', message.enabled);
      }
      return; // ignored/reserved message — nothing to do
    }
    // Context channels the Brain already decided: the Body records state and
    // expresses it, it never re-derives a decision from them.
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
        // Diagnostic only — struggle is the Brain's read and is never turned
        // into an emotion here.
        log('struggle state from Brain:', intent.level, intent.evidence.join('; '));
        break;
      default:
        behaviour.submit(intent);
        break;
    }
    refreshDom(behaviour.snapshot());
  }
}

/**
 * Binds the ONE Eve popup bar. Every id here must exist in index.html — a
 * missing element disables only its own feature, never the renderer.
 */
function wirePopupDom() {
  responseBubble = document.getElementById('responseBubble');
  bubbleState = document.getElementById('bubbleState');
  bubbleType = document.getElementById('bubbleType');
  bubbleText = document.getElementById('bubbleText');
  bubbleActions = document.getElementById('bubbleActions');
  bubbleFile = document.getElementById('bubbleFile');
  bubbleDetails = document.getElementById('bubbleDetails');
  bubbleVoice = document.getElementById('bubbleVoice');
  if (!responseBubble) {
    log('WARNING: popup bar DOM missing — Eve renders without an issue surface');
  }
}

// ---------------------------------------------------------------------------
// Connection indicator + popup bar (robot stays primary)
// ---------------------------------------------------------------------------
let firstGreetingPlayed = false;
let lastViewState = 'IDLE';

function wireStatusDom() {
  behaviour.onChange((snapshot) => {
    // One snapshot → both physical controllers. viewState drives the pose and
    // the face set; emotion/intensity scale both, and `speaking` is what makes
    // the mouth articulate instead of merely holding an open shape.
    const intensity = behaviour.getEffectiveIntensity();
    animation.setState(snapshot.viewState);
    animation.setEmotion(snapshot.emotion, intensity);
    face.setExpression(snapshot.viewState);
    face.setEmotion(snapshot.emotion, intensity, snapshot.speaking);
    refreshDom(snapshot);

    // Trigger greeting gesture on first SUCCESS after connect
    if (!firstGreetingPlayed && snapshot.viewState === 'SUCCESS' && snapshot.link === 'connected') {
      firstGreetingPlayed = true;
      animation.triggerGesture('greet');
      // Also trigger attentive turn toward the interaction
      const target = behaviour.getAttentionTarget();
      if (target && target.vector) {
        animation.setAttentionTarget(target.vector.x, target.vector.y, target.strength);
        // Trigger attentive gesture for a smooth turn
        setTimeout(() => animation.triggerGesture('attentive'), 100);
      }
    }

    // Trigger attentive gesture when entering OBSERVING with LISTENING emotion (user message received)
    if (lastViewState !== 'OBSERVING' && snapshot.viewState === 'OBSERVING' && snapshot.emotion === 'LISTENING') {
      animation.triggerGesture('attentive');
      const target = behaviour.getAttentionTarget();
      if (target && target.vector) {
        animation.setAttentionTarget(target.vector.x, target.vector.y, target.strength);
      }
    }

    // Reset greeting flag on disconnect
    if (snapshot.link === 'disconnected') {
      firstGreetingPlayed = false;
    }

    lastViewState = snapshot.viewState;
  });
}

function refreshDom(snapshot) {
  const indicator = document.getElementById('statusIndicator');
  const text = document.getElementById('statusText');
   if (indicator && text) {
    const label = snapshot.link === 'connected'
       ? 'Brain linked'
       : snapshot.link === 'disconnected' ? 'Brain offline' : 'Linking…';
    if (text.textContent !== label) {
      text.textContent = label;
    }
    const cls = `status ${snapshot.link}`;
    if (indicator.className !== cls) {
      indicator.className = cls;
    }
  }

  // Update the popup bar from the structured issue or live caption.
  updateResponseBubble(snapshot);
}

/**
 * Renders the ONE Eve popup bar. The structured ISSUE_STATE frame wins when
 * the Brain sent one; otherwise the live caption is shown; otherwise only
 * Eve remains. Severity tints the edge; details open expanded for beginners
 * and collapsed for everyone else (More/Less toggles locally).
 */
function refreshResponseBar() {
  updateResponseBubble(behaviour.snapshot());
}

function updateResponseBubble(snapshot) {
  if (!responseBubble) return;

  const caption = snapshot.caption;
  const viewState = snapshot.viewState;
  const emotion = snapshot.emotion;
  const teaching = snapshot.teaching;
  const captionMode = snapshot.captionMode;

  if (latestIssue && latestIssue.visible) {
    renderIssuePopup(latestIssue);
  } else if (caption && caption !== dismissedCaption) {
    renderCaptionPopup(caption, viewState, emotion, teaching);
  } else {
    hidePopup();
    lastSpokenCaption = null;
  }

  // Spoken output: concise summaries only. A long explanation stays readable
  // on screen while Eve speaks its short form — never the reverse.
  if (caption && captionMode === 'TTS' && caption !== lastSpokenCaption) {
    lastSpokenCaption = caption;
    speakSummary(caption);
  }
  if (!caption) {
    lastSpokenCaption = null;
  }
}

let lastSpokenCaption = null;
/** Caption dismissed locally — stays hidden until genuinely new text arrives. */
let dismissedCaption = null;

function popupLogSignature(parts) {
  return parts.join('|');
}

function logPopup(show, parts) {
  const signature = popupLogSignature(show ? ['show', ...parts] : ['hide']);
  if (signature === lastPopupLog) {
    return;
  }
  lastPopupLog = signature;
  log(show ? `popup show [${parts.join(' | ')}]` : 'popup hide');
}

function setSeverity(severity) {
  responseBubble.classList.remove('sev-error', 'sev-warning', 'sev-success');
  if (severity === 'ERROR' || severity === 'CRITICAL' || severity === 'FAILURE') {
    responseBubble.classList.add('sev-error');
  } else if (severity === 'WARNING') {
    responseBubble.classList.add('sev-warning');
  } else if (severity === 'SUCCESS') {
    responseBubble.classList.add('sev-success');
  }
}

function renderIssuePopup(issue) {
  const explanation = explanationRequests.get(issueKey(issue));
  setSeverity(issue.severity);
  bubbleState.textContent = issue.title || 'EVE';
  bubbleType.textContent = '';
  if (bubbleFile) {
    if (issue.file) {
      bubbleFile.textContent = issue.file;
      bubbleFile.classList.remove('hidden');
    } else {
      bubbleFile.classList.add('hidden');
    }
  }
  bubbleText.textContent = issue.message || '';
  if (explanation) { bubbleType.textContent = explanation.status === 'loading' ? 'EXPLAINING…' : explanation.status === 'error' ? 'FAILED' : 'EXPLANATION'; }
  if (bubbleDetails) {
    const open = detailsOpen || issue.expanded === true;
    if (explanation || issue.details) {
      bubbleDetails.textContent = explanation ? explanation.text : issue.details;
      bubbleDetails.classList.toggle('hidden', !open);
    } else {
      bubbleDetails.classList.add('hidden');
    }
  }
  const isSuccess = issue.severity === 'SUCCESS';
  const isFailure = issue.severity === 'FAILURE';
  buildPopupActions({
    // A FAILURE resolution carries no matter of its own: Retry re-runs the
    // approval-gated fix flow, and the Brain falls back to current errors.
    fix: isFailure || (issue.fixAvailable === true && !!issue.matter),
    fixLabel: isFailure && !(issue.fixAvailable === true && !!issue.matter) ? 'Retry' : 'Fix',
    matter: issue.matter,
    // SUCCESS is terminal: no Explain, no Fix. FAILURE keeps Explain plus a
    // Retry that re-runs the approval-gated fix flow on current diagnostics.
    explain: !isSuccess,
    details: !!explanation || !!issue.details,
    dismiss: true,
  });
  responseBubble.classList.add('visible');
  logPopup(true, [issue.severity, issue.title || '', issue.file || '', (issue.message || '').slice(0, 80)]);
}

function renderCaptionPopup(caption, viewState, emotion, teaching) {
  setSeverity(viewState === 'ERROR' ? 'ERROR' : viewState === 'SUCCESS' ? 'SUCCESS' : 'INFO');
  bubbleState.textContent = getStateLabel(viewState, emotion);
  bubbleType.textContent = getTypeLabel(viewState, emotion, teaching);
  bubbleText.textContent = caption;
  if (bubbleFile) {
    bubbleFile.classList.add('hidden');
  }
  if (bubbleDetails) {
    bubbleDetails.classList.add('hidden');
  }
  buildPopupActions({
    fix: !!(teaching && teaching.matter && (teaching.level >= 2 || viewState === 'CONCERNED' || viewState === 'ERROR')),
    matter: teaching ? teaching.matter : undefined,
    explain: viewState === 'EXPLAINING' || viewState === 'CONCERNED' || viewState === 'CONFUSED',
    details: false,
    dismiss: true,
  });
  responseBubble.classList.add('visible');
  logPopup(true, ['caption', viewState, caption.slice(0, 80)]);
}

function hidePopup() {
  if (!responseBubble.classList.contains('visible')) {
    return;
  }
  responseBubble.classList.remove('visible');
  bubbleActions.innerHTML = '';
  logPopup(false, []);
}

function getStateLabel(viewState, emotion) {
  const labels = {
    IDLE: 'EVE',
    OBSERVING: 'EVE',
    THINKING: 'EVE',
    CONCERNED: 'EVE',
    CONFUSED: 'EVE',
    EXPLAINING: 'EVE',
    SUCCESS: 'EVE',
    ERROR: 'EVE',
    CONNECTING: 'EVE',
    DISCONNECTED: 'EVE',
  };
  return labels[viewState] || 'EVE';
}

function getTypeLabel(viewState, emotion, teaching) {
  if (viewState === 'ERROR') return 'ERROR';
  if (viewState === 'CONCERNED') return 'ALERT';
  if (viewState === 'CONFUSED') return 'CONFUSED';
  if (viewState === 'EXPLAINING') return 'EXPLAIN';
  if (viewState === 'SUCCESS') return 'DONE';
  if (viewState === 'THINKING') return 'THINKING';
  if (teaching && teaching.level >= 2) return 'HINT';
  if (teaching && teaching.level === 1) return 'NOTICE';
  return '';
}

// __EVE_POPUP_ACTIONS_BEGIN__
// The block through the matching END marker below is the verifiable click
// path: every popup button handler lives here and is exercised by executing
// THIS source (not a reimplementation) in acex-compact-ui.test.ts.
/**
 * One row of popup actions: contextual Fix/Explain, a local More/Less
 * toggle for details, Dismiss, and the single microphone control.
 * No chat panel, no voice dashboard — the mic button IS the voice UI.
 *
 * Deterministic renderer: the container is REPLACED (innerHTML = '') on
 * every render, never appended to, so one issue can never produce repeated
 * button rows and listeners can never duplicate. Every button carries a
 * stable id + data-action so the click path is verifiable (see
 * acex-compact-ui.test.ts). Handlers read the CURRENT popup identity at
 * click time (issueIdentity), never a stale closure over a past issue.
 */
function buildPopupActions(options) {
  bubbleActions.innerHTML = '';

  if (options.fix) {
    addBubbleButton(options.fixLabel || 'Fix', 'fix', () => requestFixWithBotX(options.matter), true);
  }
  if (options.explain) {
    addBubbleButton('Explain', 'explain', () => requestExplanation(), false);
  }
  if (options.details) {
    addBubbleButton(detailsOpen ? 'Less' : 'More', 'details', () => {
      detailsOpen = !detailsOpen;
      refreshResponseBar();
    }, false);
  }
  if (options.dismiss) {
    addBubbleButton('Dismiss', 'dismiss', () => dismissBubble(), false);
  }

  const mic = document.createElement('button');
  mic.id = 'micButton';
  mic.dataset.action = 'voice';
  mic.className = 'mic-btn' + (voice.state === 'listening' ? ' listening' : '');
  mic.textContent = voice.state === 'listening' ? '●' : voice.state === 'speaking' ? '♪' : '🎙';
  mic.title = voice.state === 'listening' ? 'Listening — click to stop' : 'Ask Eve by voice';
  mic.setAttribute('aria-label', 'Ask Eve by voice');
  mic.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleVoiceInput();
  });
  bubbleActions.appendChild(mic);
}

function addBubbleButton(label, action, handler, primary) {
  const btn = document.createElement('button');
  btn.className = `bubble-btn${primary ? '' : ' secondary'}`;
  btn.id = `eve-${action}-btn`;
  btn.dataset.action = action;
  btn.textContent = label;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    handler();
  });
  bubbleActions.appendChild(btn);
}

/** The popup's own issue identity travels with every request, so the Brain
 * acts on THIS issue — never a generic first-error fallback. Read live at
 * click time so popup replacement (ERROR A → ERROR B) retargets automatically. */
function issueIdentity() {
  const issue = latestIssue && latestIssue.visible ? latestIssue : null;
  if (!issue) {
    return {};
  }
  return {
    matter: typeof issue.matter === 'string' ? issue.matter : undefined,
    file: typeof issue.filePath === 'string' ? issue.filePath : undefined,
    line: typeof issue.line === 'number' ? issue.line : undefined,
  };
}

function requestFixWithBotX(matter) {
  // Structured fix request: the Brain reveals this exact issue and runs the
  // existing approval-gated fix flow on it. The LIVE popup identity wins over
  // the matter captured at render time, so a replaced popup can never fire a
  // fix for the issue it replaced; the render-time matter is only a fallback
  // for caption popups that carry teaching context instead of an issue.
  const identity = issueIdentity();
  sendToBrain({
    type: 'FIX_REQUEST',
    matter: identity.matter ?? (typeof matter === 'string' && matter ? matter : undefined),
    file: identity.file,
    line: identity.line,
  });
  // Approval lives in the existing VS Code diff + modal flow. The popup only
  // points at it — it never approves anything itself.
  if (bubbleText && (!latestIssue || latestIssue.visible)) {
    bubbleText.textContent = 'I found a possible fix. Review the proposed change in VS Code.';
  }
}

function requestExplanation() {
  // Structured explain request: the Brain explains this exact issue.
  const identity = issueIdentity();
  const key = JSON.stringify([latestIssue?.filePath || '', latestIssue?.line || 0, latestIssue?.message || '', latestIssue?.severity || '']);
  const requests = typeof explanationRequests === 'undefined' ? null : explanationRequests;
  if (requests?.get(key)?.status === 'loading') { return; }
  const requestId = typeof nextRequestId === 'undefined' ? String(Date.now()) : nextRequestId();
  const request = { requestId, status: 'loading', text: 'Explaining…' };
  request.timer = typeof setTimeout === 'undefined' ? null : setTimeout(() => {
    if (request.status === 'loading') {
      request.status = 'error';
      request.text = 'No response received from the Brain. Check the connection and try again.';
      refreshResponseBar();
    }
  }, 90000);
  requests?.set(key, request);
  detailsOpen = true;
  refreshResponseBar();
  sendToBrain({
    type: 'EXPLAIN_REQUEST',
    requestId,
    message: latestIssue?.message,
    severity: latestIssue?.severity,
    matter: identity.matter,
    file: identity.file,
    line: identity.line,
  });
}
function wireChat() {
  document.getElementById('chatToggle').addEventListener('click', () => {
    document.getElementById('eveChat').classList.toggle('hidden');
    document.getElementById('chatInput').focus();
  });
  const closeChat = () => {
    document.getElementById('eveChat').classList.add('hidden');
    document.getElementById('chatToggle').focus();
  };
  document.getElementById('chatClose').addEventListener('click', closeChat);
  document.getElementById('eveChat').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeChat(); }
  });
  document.getElementById('chatInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      document.getElementById('chatForm').requestSubmit();
    }
  });
  document.getElementById('chatForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text || chatPending) { return; }
    const requestId = nextRequestId();
    chatPending = requestId;
    document.getElementById('chatSend').disabled = true;
    const entry = document.createElement('div');
    renderChatEntry(entry, 'You:', text, false);
    document.getElementById('chatHistory').appendChild(entry);
    input.value = '';
    sendToBrain({ type: 'CHAT_MESSAGE', text, requestId });
    // Guard against a genuinely dropped Brain connection. This MUST stay above
    // the Brain's longest legitimate operation (code generation, currently
    // GEMINI_CODE_TIMEOUT_MS = 60s) so a slow-but-valid answer is never
    // reported as "No response received".
    setTimeout(() => {
      if (chatPending === requestId) {
        applyBrainPayload({ type: 'EVE_RESPONSE', kind: 'chat', requestId, status: 'error', text: 'No response received. Check the Brain connection and try again.' });
      }
    }, 90000);
  });
}

function renderChatEntry(container, speaker, text, isError) {
  container.className = `chat-entry${isError ? ' chat-error' : ''}`;
  container.replaceChildren();
  const label = document.createElement('strong');
  label.textContent = speaker;
  container.appendChild(label);
  const source = String(text || '');
  const parts = source.split(/```(?:[\w+#-]+)?\s*\n?([\s\S]*?)```/g);
  for (let index = 0; index < parts.length; index += 1) {
    if (index % 2 === 0) {
      if (parts[index]) container.appendChild(document.createTextNode(` ${parts[index]}`));
      continue;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-code-wrap';
    const code = document.createElement('pre');
    code.className = 'chat-code';
    code.textContent = parts[index].trim();
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'chat-copy';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', 'Copy code block');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent || '');
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
      } catch {
        copy.textContent = 'Copy unavailable';
      }
    });
    wrapper.append(code, copy);
    container.appendChild(wrapper);
  }
}

function dismissBubble() {
  // Dismiss hides this popup now; the Brain records the dismissal and
  // suppresses exactly this content. Brain state itself is untouched.
  latestIssue = null;
  dismissedCaption = behaviour.snapshot().caption || dismissedCaption;
  hidePopup();
  sendToBrain({ type: 'USER_DISMISS' });
}
// __EVE_POPUP_ACTIONS_END__

// ---------------------------------------------------------------------------
// Voice: one mic button, truthful states, Brain-routed transcripts.
// - idle: mic idle, nothing recording.
// - listening: the recognizer actually started (onstart fired).
// - processing: transcript sent, Brain handling it.
// - speaking: speech synthesis actively producing audio.
// - error: the real failure, in plain words — never a fake state.
// The transcript always travels to the Brain (VOICE_TEXT) with the popup's
// current issue attached; interpretation and execution stay Brain-side.
// ---------------------------------------------------------------------------
function speechRecognizerClass() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function setVoiceUI() {
  if (!bubbleVoice) {
    return;
  }
  bubbleVoice.classList.remove('listening', 'error');
  if (voice.state === 'listening') {
    bubbleVoice.textContent = 'Listening…';
    bubbleVoice.classList.add('listening');
  } else if (voice.state === 'processing') {
    bubbleVoice.textContent = 'Processing…';
  } else if (voice.state === 'speaking') {
    bubbleVoice.textContent = 'Speaking…';
  } else if (voice.state === 'error') {
    bubbleVoice.textContent = voice.error;
    bubbleVoice.classList.add('error');
  } else {
    bubbleVoice.textContent = '';
  }
  // The mic button icon follows the same truthful state.
  refreshResponseBar();
}

function voiceErrorText(code) {
  switch (code) {
    case 'not-allowed':
    case 'denied':
    case 'permission-denied':
      return 'Microphone unavailable. Microphone permission was denied for Eve.';
    case 'audio-capture':
    case 'no-mic':
    case 'device-not-found':
      return 'Microphone unavailable. No microphone was found on this machine.';
    case 'no-speech':
      return "I didn't catch that. Try speaking again.";
    case 'network':
    case 'service-not-allowed':
      return 'Voice input is unavailable. Speech recognition could not reach its service.';
    case 'aborted':
      return 'Voice input stopped.';
    default:
      return 'Voice input is unavailable. Try the Explain or Fix buttons instead.';
  }
}

function toggleVoiceInput() {
  if (voice.state === 'listening' && voice.recognition) {
    try {
      voice.recognition.stop();
    } catch (err) {
      log('mic stop failed:', String(err));
    }
    return;
  }
  const Recognizer = speechRecognizerClass();
  if (!Recognizer) {
    voice.state = 'error';
    voice.error = voiceErrorText('unsupported');
    log('voice unavailable: no SpeechRecognition in this build');
    setVoiceUI();
    return;
  }
  const recognition = new Recognizer();
  voice.recognition = recognition;
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    // Only here — on actual recording start — may the UI say "Listening".
    // Eve reacts too: the Brain cannot know the mic started, so the Body
    // expresses LISTENING itself (attentive OBSERVING pose, eyes to the
    // user). Lower priority than ERROR by design — the Body arbitrates.
    voice.state = 'listening';
    voice.error = '';
    log('voice: microphone recording');
    setVoiceUI();
    applyBrainPayload({ type: 'EMOTION', emotion: 'LISTENING', intensity: 0.7 });
  };
  recognition.onresult = (event) => {
    const transcript = event.results && event.results[0] && event.results[0][0]
      ? String(event.results[0][0].transcript || '').trim()
      : '';
    voice.state = 'processing';
    setVoiceUI();
    if (transcript) {
      log(`voice transcript: ${transcript.slice(0, 120)}`);
      const issue = latestIssue && latestIssue.visible ? latestIssue : null;
      sendToBrain({
        type: 'VOICE_TEXT',
        text: transcript,
        file: issue && issue.file ? issue.file : undefined,
        line: issue && typeof issue.line === 'number' ? issue.line : undefined,
        matter: issue && issue.matter ? issue.matter : undefined,
      });
      // PROCESSING semantic: thinking expression while the Brain routes the
      // transcript. The Brain's answer (EXPLAINING / approval flow / chat)
      // overrides this as soon as it arrives.
      applyBrainPayload({ type: 'EMOTION', emotion: 'THINKING', intensity: 0.7 });
    } else {
      voice.state = 'error';
      voice.error = voiceErrorText('no-speech');
    }
    voice.state = voice.state === 'processing' ? 'idle' : voice.state;
    setVoiceUI();
  };
  recognition.onerror = (event) => {
    const code = event && event.error ? String(event.error) : 'unknown';
    voice.state = 'error';
    voice.error = voiceErrorText(code);
    log(`voice recognition error: ${code}`);
    setVoiceUI();
    // No transcript will follow: release back to the underlying state.
    applyBrainPayload({ type: 'ACTION', animation: 'neutral' });
  };
  recognition.onend = () => {
    voice.recognition = null;
    if (voice.state === 'listening') {
      // Ended without a result and without an error: back to idle, silently.
      voice.state = 'idle';
      setVoiceUI();
      applyBrainPayload({ type: 'ACTION', animation: 'neutral' });
    }
  };
  try {
    recognition.start();
  } catch (err) {
    voice.state = 'error';
    voice.error = voiceErrorText('aborted');
    log('voice start failed:', String(err));
    setVoiceUI();
  }
}

/** First two sentences, capped — what Eve actually says for long text. */
function ttsSummary(text) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return '';
  }
  const sentences = cleaned.match(/[^.?!]+[.?!]+["']?/g) || [cleaned];
  const summary = sentences.slice(0, 2).join(' ').trim();
  if (summary.length <= 280) {
    return summary;
  }
  return `${summary.slice(0, 279).trimEnd()}…`;
}

/**
 * Speaks the concise form of a caption. Truthful by construction: the
 * speaking state is set only while the speech engine is actually producing
 * audio (utterance onend clears it), and nothing is spoken without an engine.
 */
function speakSummary(caption) {
  if (!('speechSynthesis' in window)) {
    return;
  }
  const text = ttsSummary(caption);
  if (!text) {
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 0.8;
    utterance.onstart = () => {
      voice.state = 'speaking';
      setVoiceUI();
    };
    const clearSpeaking = () => {
      if (voice.state === 'speaking') {
        voice.state = 'idle';
        setVoiceUI();
        // Speech done: release back to the underlying semantic state
        // (SUCCESS / EXPLAINING hold / IDLE) instead of sticking on SPEAKING.
        applyBrainPayload({ type: 'ACTION', animation: 'neutral' });
      }
    };
    utterance.onend = clearSpeaking;
    utterance.onerror = clearSpeaking;
    window.speechSynthesis.speak(utterance);
  } catch (err) {
    log('TTS failed:', String(err));
  }
}

// ---------------------------------------------------------------------------
// Send message to Brain via main process
// ---------------------------------------------------------------------------
function sendToBrain(message) {
  if (window.brainAPI && window.brainAPI.send) {
    window.brainAPI.send(message);
  } else if (window.electronAPI && window.electronAPI.sendToBrain) {
    window.electronAPI.sendToBrain(message);
  } else {
    log('No brainAPI send method available');
  }
}

// ---------------------------------------------------------------------------
// NOTE: the popup bar is fixed beneath Eve by CSS. The old above-robot
// positioning (per-frame Box3 traversal + projection) was removed with it:
// no repeated scene traversal, no JS-driven layout fighting resizes.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Attention: the robot looks toward the cursor — and, when the Brain names an
// attention target, toward that region of the editor instead. There is no
// absolute editor coordinate available, so the target is an approximate region
// (see ATTENTION_REGION_VECTOR in actionMapper.js) blended by its strength.
// ---------------------------------------------------------------------------
let mouseGaze = { x: 0, y: 0 };

function wireGaze() {
  window.addEventListener('mousemove', (e) => {
    mouseGaze.x = (e.clientX / window.innerWidth) - 0.5;
    mouseGaze.y = (e.clientY / window.innerHeight) - 0.5;
  });
}

/** Blends mouse attention with the Brain's attention target, then re-asserts. */
function applyGaze() {
  const target = behaviour.getAttentionTarget();
  let gx = mouseGaze.x;
  let gy = mouseGaze.y;
  if (target && target.vector) {
    const w = Math.max(0, Math.min(1, target.strength));
    gx = gx * (1 - w) + target.vector.x * w;
    gy = gy * (1 - w) + target.vector.y * w;
    // Also set the attention target for intentional head turns (separate from gaze)
    animation.setAttentionTarget(target.vector.x, target.vector.y, target.strength);
  } else {
    // No Brain attention target — clear the intentional attention target
    animation.setAttentionTarget(0, 0, 0);
  }
  animation.setGazeTarget(gx, gy);
  face.setGaze(gx, gy);
}

function wireResize() {
  window.addEventListener('resize', refreshRendererSize);
}

/**
 * Fits the Three.js canvas to its element. Called on window resize AND when
 * returning from mini mode (the viewport has zero size while hidden, so the
 * camera/renderer must be re-fitted before the next frame renders).
 */
function refreshRendererSize() {
  if (!camera || !renderer) return;
  const canvas = renderer.domElement;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(width, height);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1); // clamp: no giant steps after stalls

  behaviour.tick();
  const snapshot = behaviour.snapshot();
  if (eveMode === 'mini') {
    // Mini face needs no GPU work: the CSS face carries the state, and the
    // behaviour snapshot stays fresh for the instant we expand again.
    syncMiniDom(snapshot);
    return;
  }
  // Re-asserted every frame, not just on change: link status can alter the
  // effective intensity without a state transition, the caption timer can end
  // speech while the state is still held, and the attention target blends with
  // the live mouse position continuously.
  const intensity = behaviour.getEffectiveIntensity();
  applyGaze();
  animation.setState(snapshot.viewState);
  animation.setEmotion(snapshot.emotion, intensity);
  face.setEmotion(snapshot.emotion, intensity, snapshot.speaking);
  animation.transientActive = face.hasTransient();
  animation.update(dt, !!model);
  face.update(dt);

  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Eve Mini / Expanded modes.
//
// One page, one animation loop, one Brain connection — modes only change which
// view is visible and whether the GPU renders. The main process owns the window
// bounds; applyEveMode() runs when main notifies us (never unilaterally,
// except when the bridge is missing and there is no window to resize).
// ---------------------------------------------------------------------------
function applyEveMode(mode) {
  if (mode !== 'mini' && mode !== 'full') {
    return;
  }
  const activatedFromFace = document.activeElement && document.activeElement.id === 'miniFace';
  eveMode = mode;
  const mini = mode === 'mini';
  const miniView = document.getElementById('miniView');
  const app = document.getElementById('app');
  if (miniView) {
    miniView.classList.toggle('hidden', !mini);
    miniView.setAttribute('aria-hidden', String(!mini));
  }
  if (app) {
    app.classList.toggle('hidden', mini);
    app.setAttribute('aria-hidden', String(mini));
  }
  // Full-mode fixed surfaces (popup bar, chat panel) are laid out for a
  // 240px+ window and render degenerately at mini size — force-hide them via
  // CSS while mini. State is untouched: expand re-renders everything live.
  document.body.classList.toggle('eve-mini', mini);
  if (!mini) {
    refreshRendererSize();
    // A Brain chat request that waited out the expansion opens now.
    if (pendingChatOpen) {
      pendingChatOpen = false;
      openChatPanel();
    }
    // Fixed full-mode surfaces were force-hidden while mini: re-render so a
    // live caption, issue, or open chat is visible again immediately.
    refreshResponseBar();
    // Keyboard users activated the face button to get here: keep focus inside
    // the restored interface instead of dropping it. Never steals focus when
    // expansion came from the Brain (chat request, Show Eve).
    if (activatedFromFace) {
      const btn = document.getElementById('minimizeBtn');
      if (btn) {
        btn.focus();
      }
    }
  }
  syncMiniDom(behaviour.snapshot());
  log('mode:', mode);
}

/**
 * Pushes link + error state onto the mini face. Change-gated: identical
 * snapshots never touch the DOM, so this is free to call every frame.
 */
function syncMiniDom(snapshot) {
  const dot = document.getElementById('miniStatus');
  const face = document.getElementById('miniFace');
  if (!dot || !face || !snapshot) {
    return;
  }
  const key = `${snapshot.link}|${snapshot.viewState}`;
  if (key === lastMiniKey) {
    return;
  }
  lastMiniKey = key;
  dot.className = 'mini-dot ' + (snapshot.link === 'connected'
    ? 'connected'
    : snapshot.link === 'connecting' ? 'connecting' : 'disconnected');
  face.classList.toggle('err', snapshot.viewState === 'ERROR');
}

/**
 * Opens the chat panel. Idempotent: safe to call when already open, and the
 * single place CHAT_OPEN-driven opens happen (direct or deferred by mode).
 */
function openChatPanel() {
  const panel = document.getElementById('eveChat');
  const input = document.getElementById('chatInput');
  if (!panel || !input) {
    return;
  }
  panel.classList.remove('hidden');
  input.focus();
}

function wireModeButtons() {
  const api = window.brainAPI;
  const min = document.getElementById('minimizeBtn');
  if (min && api && api.setMode) {
    min.addEventListener('click', (e) => {
      e.stopPropagation();
      api.setMode('mini');
    });
  }
  const face = document.getElementById('miniFace');
  if (face && api && api.setMode) {
    // A real <button>: click, Enter and Space all expand. The surrounding ring
    // stays a drag handle (see styles.css), so moving Eve never expands her.
    face.addEventListener('click', (e) => {
      e.stopPropagation();
      api.setMode('full');
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || eveMode !== 'full') {
      return;
    }
    const chat = document.getElementById('eveChat');
    if (chat && !chat.classList.contains('hidden')) {
      return; // the chat panel handles its own Escape
    }
    if (api && api.setMode) {
      api.setMode('mini');
    }
  });
}

try {
  init();
} catch (e) {
  log('FATAL: init() threw:', String(e));
  console.error(e);
}
