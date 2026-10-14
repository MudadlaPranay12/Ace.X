console.log('Main process started');

const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { BrainWSClient } = require('./wsClient');
const { clampRectToArea } = require('./geometry');

// ONE Eve only: a second launch focuses the existing window and quits.
// This is the single-instance guarantee — no second window, ever.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log('[BODY] Another Eve is already running — focusing it instead of opening a duplicate.');
  app.quit();
}

// The Brain listens on the single authoritative port 8055; the port can be
// overridden with ROBOT_WS_PORT for diagnostics.
app.setPath('userData', path.join(app.getPath('userData'), 'botx-companion'));

let win;
let userHidden = false; // true when user explicitly hid via command

// Host window state from Brain: { focused: boolean | null, minimized: boolean | null }
// null = unknown (waiting for Brain), false = inactive, true = active
// For initial visibility, we default to VISIBLE (true) to ensure Eve appears
let hostWindowState = { focused: true, minimized: false };
let initialShowDone = false;

// ---------------------------------------------------------------------------
// Eve window modes: 'full' (the existing 3D interface) or 'mini' (a circular
// face). ONE window serves both modes — switching never creates a second
// window, a second WebSocket client, or a second renderer loop, and the Brain
// process is entirely independent of which mode is showing.
// ---------------------------------------------------------------------------
const MINI_SIZE = 72;
let eveMode = 'full';
/** Last full-size bounds, restored when leaving mini mode. */
let expandedBounds = null;
/** Mode change requested before the page finished loading. */
let pendingMode = null;
/** Renderer page loads: must stay 1 — a reload would mean a second loop. */
let loadCount = 0;

// ---------------------------------------------------------------------------
// Eve geometry persistence — Eve stays exactly where the user put it.
// Stored in the body's own userData (no second database): x, y, width,
// height and alwaysOnTop. Written on move/resize/close, read at startup.
// Eve deliberately does NOT track or follow the VS Code window: earlier builds
// repositioned the companion on a timer, which fought the user every time
// they dragged Eve somewhere. User placement is the only memory.
// ---------------------------------------------------------------------------
const GEOMETRY_FILE = path.join(app.getPath('userData'), 'eve-geometry.json');
// Reduced default footprint for a more compact floating companion.
// Saved geometry always wins — these defaults only apply to fresh installs
// and explicit resets (Reset Eve Position command).
// Layout: top bar (34px) + viewport (Eve ≈150–180px tall + 8px head gap) +
// bottom margin (12px) ≈ 270px tall. The whole interface stays within the
// ~230–260 × ~230–290px compact target.
const MIN_WIDTH = 230;
const MIN_HEIGHT = 250;
const DEFAULT_WIDTH = 240;
const DEFAULT_HEIGHT = 270;
let saveGeometryTimer = null;

function saneNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function loadGeometry() {
  try {
    if (!fs.existsSync(GEOMETRY_FILE)) {
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(GEOMETRY_FILE, 'utf8'));
    const width = Math.max(MIN_WIDTH, saneNumber(raw.width, DEFAULT_WIDTH));
    const height = Math.max(MIN_HEIGHT, saneNumber(raw.height, DEFAULT_HEIGHT));
    return {
      x: saneNumber(raw.x, null),
      y: saneNumber(raw.y, null),
      width,
      height,
      alwaysOnTop: raw.alwaysOnTop !== false,
    };
  } catch (err) {
    console.log('[WINDOW] Could not read saved geometry, using defaults:', String((err && err.message) || err));
    return null;
  }
}

function persistGeometryNow() {
  if (!win || win.isDestroyed()) {
    return;
  }
  // Mini bounds must never overwrite the expanded restore point: moving the
  // small face around must not destroy where the full interface lives.
  if (eveMode !== 'full') {
    return;
  }
  try {
    const bounds = win.getBounds();
    const data = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      alwaysOnTop: win.isAlwaysOnTop(),
    };
    fs.writeFileSync(GEOMETRY_FILE, JSON.stringify(data), 'utf8');
  } catch (err) {
    console.log('[WINDOW] Could not persist geometry:', String((err && err.message) || err));
  }
}

function scheduleGeometrySave() {
  if (saveGeometryTimer) {
    clearTimeout(saveGeometryTimer);
  }
  saveGeometryTimer = setTimeout(() => {
    saveGeometryTimer = null;
    persistGeometryNow();
  }, 400);
}

let savedGeometry = loadGeometry();
if (savedGeometry) {
  console.log('[WINDOW] Restored saved geometry:', JSON.stringify(savedGeometry));
}

function defaultBounds() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  return {
    x: width - DEFAULT_WIDTH - 20,
    y: height - DEFAULT_HEIGHT - 40,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  };
}

function initialBounds() {
  if (savedGeometry && savedGeometry.x !== null && savedGeometry.y !== null) {
    return { ...savedGeometry };
  }
  return defaultBounds();
}

function getNativeHandleHex() {
  if (!win || win.isDestroyed()) return 'null';
  try {
    const handle = win.getNativeWindowHandle();
    if (!handle) return 'empty';
    return '0x' + handle.toString('hex').toUpperCase();
  } catch (e) {
    return 'error:' + e.message;
  }
}

// ---------------------------------------------------------------------------
// Brain WebSocket — starts immediately, never blocks Electron startup.
// ---------------------------------------------------------------------------
const brainLink = new BrainWSClient();
const MAX_PENDING = 100;
let pendingMessages = [];
let pendingStatus = null;

// --mode-test: automated Mini -> Full -> Mini verification, driven ONLY by an
// explicit CLI flag. Captures screenshots and logs bounds/DOM state at each
// stage, then quits. Never active in normal use or in shipped behaviour.
const MODE_TEST = process.argv.includes('--mode-test');
// --dom-diag: transparency forensics. Mini mode, then screenshots with the
// popup bar hidden and with the mini view hidden, to attribute every pixel.
const DOM_DIAG = process.argv.includes('--dom-diag');
function modeTestDir() {
  const arg = process.argv.find((a) => a.startsWith('--mode-test-dir='));
  return arg ? arg.slice('--mode-test-dir='.length) : require('os').tmpdir();
}

// Commands the Brain uses to control the window itself.
function setVisible(visible) {
  if (!win || win.isDestroyed()) {
    return;
  }
  userHidden = !visible;
  console.log(`[WINDOW] User visibility command: ${visible ? 'SHOW' : 'HIDE'} (userHidden=${userHidden})`);
  if (visible) {
    // An explicit show restores the full interface: Show Eve must never leave
    // the user facing a hidden mini face. Automatic host-state restores in
    // applyHostVisibility() intentionally do NOT expand.
    if (eveMode !== 'full') {
      setEveMode('full');
    }
    if (!win.isVisible()) {
      win.setAlwaysOnTop(savedGeometry ? savedGeometry.alwaysOnTop !== false : true, 'floating');
      win.showInactive();
      win.moveTop();
    }
  } else if (win.isVisible()) {
    win.hide();
    win.setAlwaysOnTop(false);
  }
}

function focusEve() {
  if (!win || win.isDestroyed()) {
    return;
  }
  setVisible(true);
  if (win.isMinimized()) {
    win.restore();
  }
  win.focus();
  win.moveTop();
  console.log('[WINDOW] Eve focused');
}

function setAlwaysOnTop(enabled) {
  if (!win || win.isDestroyed()) {
    return;
  }
  const next = typeof enabled === 'boolean' ? enabled : !win.isAlwaysOnTop();
  win.setAlwaysOnTop(next, 'floating');
  if (savedGeometry) {
    savedGeometry.alwaysOnTop = next;
  } else {
    savedGeometry = { ...defaultBounds(), alwaysOnTop: next };
  }
  persistGeometryNow();
  console.log(`[WINDOW] alwaysOnTop=${next}`);
}

function resetGeometry() {
  const bounds = defaultBounds();
  savedGeometry = { ...bounds, alwaysOnTop: true };
  if (win && !win.isDestroyed()) {
    win.setBounds(bounds);
    win.setAlwaysOnTop(true, 'floating');
    setVisible(true);
    persistGeometryNow();
  }
  console.log('[WINDOW] Geometry reset to defaults:', JSON.stringify(bounds));
}

// ---------------------------------------------------------------------------
// Eve Mini / Expanded modes. Single-window transitions with explicit bounds:
// shrinking keeps the window where it is (top-left anchored, clamped
// on-screen); expanding restores the last full bounds (persisted geometry when
// there is no live record). The renderer scene is retained — the GLB is never
// reloaded by a mode switch.
// ---------------------------------------------------------------------------

/** Keeps a rect inside real display space so Eve can never strand off-screen. */
function clampToScreen(rect) {
  try {
    const probe = { x: rect.x, y: rect.y, width: Math.min(rect.width, 64), height: Math.min(rect.height, 64) };
    return clampRectToArea(rect, screen.getDisplayMatching(probe).workArea);
  } catch {
    return rect;
  }
}

/** Full bounds to restore: live record wins, then persisted geometry, then defaults. */
function fullBoundsToRestore() {
  if (expandedBounds) {
    return { ...expandedBounds };
  }
  if (savedGeometry && savedGeometry.x !== null && savedGeometry.y !== null) {
    return {
      x: savedGeometry.x,
      y: savedGeometry.y,
      width: Math.max(savedGeometry.width, MIN_WIDTH),
      height: Math.max(savedGeometry.height, MIN_HEIGHT),
    };
  }
  return defaultBounds();
}

function notifyEveMode() {
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
    win.webContents.send('eve:mode', eveMode);
  } else {
    pendingMode = eveMode;
  }
}

function setEveMode(mode) {
  if ((mode !== 'mini' && mode !== 'full') || !win || win.isDestroyed()) {
    return;
  }
  if (eveMode === mode) {
    notifyEveMode();
    return;
  }
  if (mode === 'mini') {
    // Record the full interface position FIRST (persist still sees full mode).
    expandedBounds = { ...win.getBounds() };
    savedGeometry = { ...expandedBounds, alwaysOnTop: win.isAlwaysOnTop() };
    persistGeometryNow();
    const here = win.getBounds();
    const mini = clampToScreen({ x: Math.round(here.x), y: Math.round(here.y), width: MINI_SIZE, height: MINI_SIZE });
    eveMode = 'mini';
    win.setMinimumSize(MINI_SIZE, MINI_SIZE);
    win.setResizable(false);
    win.setBounds(mini);
  } else {
    const full = clampToScreen(fullBoundsToRestore());
    eveMode = 'full';
    win.setMinimumSize(MIN_WIDTH, MIN_HEIGHT);
    win.setResizable(true);
    win.setBounds(full);
  }
  notifyEveMode();
  console.log(`[WINDOW] mode=${eveMode} bounds=${JSON.stringify(win.getBounds())}`);
}

function applyHostVisibility() {
  if (!win || win.isDestroyed()) {
    return;
  }
  // Brain-authoritative host state + explicit user hide. Eve never moves here —
  // visibility only. A minimized host hides Eve; otherwise Eve stays visible
  // unless the user hid it.
  if (hostWindowState.minimized === true) {
    if (win.isVisible()) {
      win.hide();
    }
    return;
  }
  if (userHidden) {
    if (win.isVisible()) {
      win.hide();
    }
    return;
  }
  if (!win.isVisible()) {
    win.setAlwaysOnTop(savedGeometry ? savedGeometry.alwaysOnTop !== false : true, 'floating');
    win.showInactive();
    win.moveTop();
  }
}

function deliver(channel, payload) {
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
    win.webContents.send(channel, payload);
  } else if (channel === 'brain:message') {
    pendingMessages.push(payload);
    if (pendingMessages.length > MAX_PENDING) pendingMessages.shift();
  } else if (channel === 'brain:status') {
    pendingStatus = payload;
  }
}

brainLink.on('message', (message) => {
  if (message && message.type === 'WINDOW_VISIBILITY') {
    setVisible(Boolean(message.visible));
    return;
  }
  if (message && message.type === 'WINDOW_FOCUS') {
    focusEve();
    return;
  }
  if (message && message.type === 'WINDOW_ALWAYS_ON_TOP') {
    setAlwaysOnTop(typeof message.enabled === 'boolean' ? message.enabled : undefined);
    return;
  }
  if (message && message.type === 'WINDOW_GEOMETRY_RESET') {
    resetGeometry();
    return;
  }
  // Host window state from Brain (authoritative)
  if (message && message.type === 'HOST_WINDOW_STATE') {
    // null = unknown (Brain hasn't determined state yet); false = inactive; true = active
    const focused = message.focused === null ? null : Boolean(message.focused);
    const minimized = message.minimized === null ? null : Boolean(message.minimized);
    if (hostWindowState.focused !== focused || hostWindowState.minimized !== minimized) {
      console.log(`[WINDOW] Host window state from Brain: focused=${focused}, minimized=${minimized}`);
      hostWindowState = { focused, minimized };
      applyHostVisibility();
    }
    return;
  }
  deliver('brain:message', message);
});
brainLink.on('status', (status) => deliver('brain:status', status));
if (gotSingleInstanceLock) {
  brainLink.connect(); // attempt immediately — retries handled inside the client
}

// Renderer-requested window mode change (minimize button, mini face, Escape).
ipcMain.on('eve:set-mode', (_event, mode) => {
  if (mode === 'mini' || mode === 'full') {
    setEveMode(mode);
  }
});

// Handle messages from renderer to Brain
ipcMain.on('brain:send', (_event, message) => {
  if (brainLink.socket && brainLink.socket.readyState === 1) {
    brainLink.socket.send(JSON.stringify(message));
  }
});

app.on('will-quit', () => {
  brainLink.stop();
});

async function runDomDiag() {
  const dir = modeTestDir();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    try {
      const img = await win.capturePage();
      fs.writeFileSync(path.join(dir, name), img.toPNG());
      console.log(`[DOM-DIAG] shot ${name}`);
    } catch (err) {
      console.log('[DOM-DIAG] shot failed:', String((err && err.message) || err));
    }
  };
  const dom = (expr) => win.webContents.executeJavaScript(expr).catch((e) => 'ERR:' + String(e));
  const frame = () => dom('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  try {
    await sleep(2000);
    setEveMode('mini');
    await sleep(500);
    await frame();
    await shot('diag-01-mini-baseline.png');
    await dom("document.getElementById('responseBubble').style.display='none'");
    await frame();
    await shot('diag-02-mini-no-bubble.png');
    console.log(`[DOM-DIAG] bubbleRect=${await dom("JSON.stringify(document.getElementById('responseBubble').getBoundingClientRect())")}`);
    console.log(`[DOM-DIAG] bubbleBg=${await dom("getComputedStyle(document.getElementById('responseBubble')).backgroundColor")}`);
    await dom("document.getElementById('miniView').style.display='none'");
    await frame();
    await shot('diag-03-nothing-visible.png');
    console.log('[DOM-DIAG] done');
  } catch (err) {
    console.log('[DOM-DIAG] failed:', String((err && err.message) || err));
  }
  app.quit();
}

async function runModeTest() {
  const dir = modeTestDir();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    try {
      const img = await win.capturePage();
      const file = path.join(dir, name);
      fs.writeFileSync(file, img.toPNG());
      const size = img.getSize();
      console.log(`[MODE-TEST] shot ${file} ${size.width}x${size.height}`);
    } catch (err) {
      console.log('[MODE-TEST] shot failed:', String((err && err.message) || err));
    }
  };
  const dom = (expr) => win.webContents.executeJavaScript(expr).catch((e) => 'ERR:' + String(e));
  // Ensures the compositor has presented the latest DOM before a capture:
  // two renderer frames back-to-back mean the change is on screen, not queued.
  const frame = () => dom('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  try {
    console.log(`[MODE-TEST] start loadCount=${loadCount} dir=${dir}`);
    await sleep(2500);
    console.log(`[MODE-TEST] initial bounds=${JSON.stringify(win.getBounds())} mode=${eveMode}`);
    await shot('shot-01-full.png');
    setEveMode('mini');
    await sleep(600);
    console.log(`[MODE-TEST] mini bounds=${JSON.stringify(win.getBounds())} mode=${eveMode}`);
    console.log(`[MODE-TEST] miniViewClass=${await dom("document.getElementById('miniView').className")}`);
    console.log(`[MODE-TEST] miniStatus=${await dom("document.getElementById('miniStatus').className")}`);
    console.log(`[MODE-TEST] appClass=${await dom("document.getElementById('app').className")}`);
    console.log(`[MODE-TEST] sheets=${await dom("[...document.styleSheets].map(s=>s.href||'inline').join('|')")}`);
    console.log(`[MODE-TEST] faceRect=${await dom("JSON.stringify(document.getElementById('miniFace').getBoundingClientRect())")}`);
    console.log(`[MODE-TEST] ringRect=${await dom("JSON.stringify(document.getElementById('miniRing').getBoundingClientRect())")}`);
    console.log(`[MODE-TEST] appDisplay=${await dom("getComputedStyle(document.getElementById('app')).display")}`);
    console.log(`[MODE-TEST] viewport=${await dom("window.innerWidth+'x'+window.innerHeight")}`);
    await frame();
    await shot('shot-02-mini.png');
    setEveMode('full');
    await sleep(600);
    console.log(`[MODE-TEST] full bounds=${JSON.stringify(win.getBounds())} mode=${eveMode}`);
    deliver('brain:message', { type: 'CHAT_OPEN' });
    await sleep(700);
    console.log(`[MODE-TEST] chatClass=${await dom("document.getElementById('eveChat').className")}`);
    console.log(`[MODE-TEST] chatSend=${await dom("(function(){document.getElementById('chatInput').value='mode test ping';document.getElementById('chatForm').requestSubmit();return 'submitted';})()")}`);
    await sleep(2500);
    console.log(`[MODE-TEST] chatHistory=${JSON.stringify(await dom("document.getElementById('chatHistory').innerText"))}`);
    await shot('shot-03-chat.png');
    deliver('brain:message', { type: 'EMOTION', emotion: 'ERROR', intensity: 0.8 });
    await sleep(600);
    setEveMode('mini');
    await sleep(600);
    console.log(`[MODE-TEST] miniFaceClass=${await dom("document.getElementById('miniFace').className")}`);
    console.log(`[MODE-TEST] miniStatusAfterError=${await dom("document.getElementById('miniStatus').className")}`);
    await frame();
    await shot('shot-04-mini-error.png');
    console.log(`[MODE-TEST] done loadCount=${loadCount}`);
  } catch (err) {
    console.log('[MODE-TEST] failed:', String((err && err.message) || err));
  }
  app.quit();
}

function createWindow() {
  console.log('Attempting to create window...');
  const raw = initialBounds();
  // Persisted geometry can dangle off-screen after a monitor change; clamp it.
  // (A fresh default has concrete coordinates; a saved one may carry nulls.)
  const bounds = (raw.x === null || raw.x === undefined || raw.y === null || raw.y === undefined)
    ? clampToScreen({ ...defaultBounds(), width: raw.width, height: raw.height })
    : clampToScreen(raw);

  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    transparent: true,
    alwaysOnTop: bounds.alwaysOnTop !== false,
    skipTaskbar: true,
    resizable: true,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    hasShadow: false,
    show: false, // We'll show manually after load
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Microphone permission for Eve's popup voice input. Only audio capture
  // is ever granted, and only for the Eve window itself; every other
  // permission stays denied. Without this handler Electron denies the
  // microphone by default and voice input could never work.
  try {
    win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
      if (webContents !== win.webContents) {
        callback(false);
        return;
      }
      if (permission === 'media' || permission === 'audioCapture') {
        console.log('[BODY] Microphone permission granted to Eve window.');
        callback(true);
      } else {
        callback(false);
      }
    });
  } catch (err) {
    console.log('[BODY] Could not install permission handler:', String((err && err.message) || err));
  }

  // The user owns the geometry from here on: persist every move/resize.
  win.on('move', scheduleGeometrySave);
  win.on('resize', scheduleGeometrySave);
  win.on('close', () => {
    if (saveGeometryTimer) {
      clearTimeout(saveGeometryTimer);
      saveGeometryTimer = null;
    }
    persistGeometryNow();
  });

  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const prefix = level === 3 ? 'ERROR' : level === 2 ? 'WARN' : 'LOG';
    console.log(`[RENDERER:${prefix}] ${message} (${sourceId}:${line})`);
  });

  win.webContents.on('did-finish-load', () => {
    loadCount += 1;
    console.log('[WINDOW] Renderer loaded (page load #' + loadCount + ')');
    console.log('[WINDOW] BrowserWindow created:', !!win);
    console.log('[WINDOW] Window bounds:', win.getBounds());
    console.log('[WINDOW] Native handle:', getNativeHandleHex());
    // Send any buffered messages first
    if (pendingStatus !== null) {
      win.webContents.send('brain:status', pendingStatus);
      pendingStatus = null;
    }
    if (pendingMessages.length > 0) {
      const queued = pendingMessages;
      pendingMessages = [];
      for (const message of queued) {
        win.webContents.send('brain:message', message);
      }
    }
    if (pendingMode !== null) {
      const mode = pendingMode;
      pendingMode = null;
      win.webContents.send('eve:mode', mode);
    }
    // Show at the persisted (or default) position — no repositioning, ever.
    win.setAlwaysOnTop(bounds.alwaysOnTop !== false, 'floating');
    win.showInactive();
    win.moveTop();
    initialShowDone = true;
    console.log('[WINDOW] Window shown, isVisible:', win.isVisible());
    if (MODE_TEST) {
      void runModeTest();
    }
    if (DOM_DIAG) {
      void runDomDiag();
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.on('brain-state', (event, state) => {
  if (win) win.webContents.send('brain-state', state);
});

// A duplicate launch never gets here: without the lock there is no window,
// no tracking and no connection — the second-instance handler above focuses
// the ONE Eve instead.
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) {
      win.restore();
    }
    setVisible(true);
    win.focus();
    win.moveTop();
    console.log('[BODY] Second launch focused the existing Eve.');
  }
});

app.whenReady().then(() => {
  if (gotSingleInstanceLock) {
    createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
