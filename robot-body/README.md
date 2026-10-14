# BotX Robot Body

The companion process. A frameless, transparent, always-on-top Electron window
rendering Eve with Three.js, driven entirely by messages from the Brain over a
local WebSocket.

The Brain (the VS Code extension in `robot-brain/`) owns *what* is happening. This
process owns *how it looks*. It never makes decisions, reads files, or talks to
the network.

## Runtime

- Windows x64 only.
- Three.js is vendored in `vendor/three/` — there is no CDN and no network access
  at runtime.
- Eve is a single model (`assets/eve.glb`). All animation, expressions and gaze
  are procedural.

`eve.glb` contains no animation clips, no skin and no morph targets, so there is
nothing to play back. Everything the robot does is generated at runtime:

| Concern | Where |
| --- | --- |
| Emotion vocabulary and intensity rules | `behaviour/emotion.js` |
| Message → emotion → behaviour state | `behaviour/actionMapper.js` |
| State, hold timers, deduplication | `behaviour/behaviourController.js` |
| Rigid pose, gestures, breathing | `behaviour/animationController.js` |
| Eyes, lids, mouth, blink, gaze | `behaviour/faceController.js` |

## Message pipeline

```
Brain ──WebSocket──▶ MessageParser ──▶ ActionMapper ──▶ BehaviourController
                                                        │            │
                                                        ▼            ▼
                                              AnimationController  FaceController
                                                        │            │
                                                        └─── Three.js ───┘
```

- `messageParser.js` runs in the Electron **main** process. Its only job is to
  reject frames that cannot be trusted: malformed JSON, non-objects, oversized
  frames, and frames without a string `type`. It can never throw into the socket
  handler.
- `renderer.js` receives validated messages over the preload bridge and calls
  `mapMessage()`.

### Accepted message types

| Type | Effect |
| --- | --- |
| `CONNECTION_STATUS` | Link indicator; drives face brightness |
| `EMOTION` | Canonical emotion + intensity — the primary expression channel |
| `CAPTION` | Caption-only speech (no state change) |
| `TEACHING_STATE` | Records the Brain's hint rung (0–4); exposed for diagnostics |
| `ATTENTION_TARGET` | Aims the gaze toward a region of the editor |
| `STRUGGLE_STATE` | Recorded for logging only — never turned into an emotion |
| `ACTION` | Legacy: animation name, still honoured |
| `EDITOR_CHANGED` | Attentive idle (`OBSERVING`) |
| `CURSOR_MOVE` | Deliberately ignored — sensor noise |
| `ROBOT_STATE` | Legacy: expression/action/speech |
| `ROBOT_STATE_UPDATE` | Expression + real error details |
| `WINDOW_VISIBILITY` | Handled in `main.js`, never reaches the renderer |

Messages with an unrecognised string `type` are ignored, so the Brain can add
message types without breaking an older companion.

### Attention targets

VS Code exposes no absolute editor screen coordinates, so `ATTENTION_TARGET` is
deliberately *not* precise pointing. Each `targetType` maps to an approximate
region vector (`ATTENTION_REGION_VECTOR` in `behaviour/actionMapper.js`) —
roughly, "turn toward where the code is" — and that vector is blended with the
live mouse position by the target's `strength`. Errors pull harder than
warnings; a live target is never overridden by the weaker cursor target. A
future editor-window coordinate mapper can replace the table without changing
the protocol or either controller.

## Emotions

The Brain sends what it feels, never a pose:

```jsonc
{ "type": "EMOTION", "emotion": "SPEAKING", "intensity": 0.9, "speech": "…" }
```

Eight emotions, defined in `behaviour/emotion.js`: `IDLE`, `LISTENING`,
`THINKING`, `SPEAKING`, `HAPPY`, `CONFUSED`, `ALERT`, `ERROR`.

Each maps to a behaviour state and a pose. Seven of them are aliases of states
that already existed. `ERROR` is the one genuinely new state, because it needs a
visual read that `CONCERNED` cannot express — a hard failure is not a soft
concern, so it drops the head sharply, darkens the eyes, turns the gaze away and
inverts the mouth, while `CONCERNED` leans in and looks at you.

Intensity is a multiplier on deviation from rest:

- Pose and face channels are blended toward their **rest** values, so intensity
  `0` resolves to a calm neutral robot rather than a half-applied emotion.
- Breathing, bob and idle drift are **never** scaled. The companion is alive at
  intensity `0`; it is just calm.
- Blink cadence is not scaled either — a robot that blinks slower as things get
  worse reads as broken, not sad.
- Gesture one-shots are scaled, so a low-intensity wince produces no visible
  wince at all.

When the Brain is disconnected the Body drops intensity to `0.3` — low, but not
zero, so a stale message cannot leave the robot fully lit while offline. It is
not `0`: the `DISCONNECTED` pose and face dim the robot so it reads as
unattended, and zeroing intensity would blend those channels back toward a
normal resting expression.

## Window modes

One window serves two modes — there is never a second window, a second
WebSocket client, or a second renderer loop:

- **Full** (default, 240×270, min 230×250): the existing 3D interface —
  viewport, popup bar, chat panel, status indicator. Nothing about it changed.
- **Mini** (72×72): a circular CSS face (60 px) with blinking eyes, an
  error-red eye tint driven by the same behaviour snapshot, and a link-status
  dot (green/amber/grey). The GPU render loop is skipped; the behaviour state
  machine keeps ticking so expansion is instant and the GLB is never reloaded.

The ring around the face is the drag handle; the face itself is one real
`<button>` (click, Enter, Space), and the top bar gains a minimize button
(Escape also minimizes when chat is closed). Full-mode fixed surfaces (popup
bar, chat panel) are force-hidden while mini — presentation only; Brain state,
chat history and the issue frame are untouched and re-render on expand.

`main.js` owns the bounds: shrinking records the full position first (mini
moves never overwrite it), expanding restores it, every transition is clamped
to real display space, and an explicit Brain show (`WINDOW_VISIBILITY`
`visible: true`, i.e. `Ace.X: Show Eve`) expands as well as shows. Automatic
host-state restores never change the mode, and minimizing never stops the
Brain. Verification hook: `electron . --mode-test` runs Mini → Full → chat
round-trip → Mini with screenshots and quits; `--dom-diag` attributes pixels
per surface. Both are inert without their flags.

## Development

```powershell
npm install                 # from the repository root
npm run start-body          # run this process standalone
npm run package:body        # build dist/win-unpacked
```

Standalone mode drives the state machine from `window.__botx`, which is exposed
for inspection and tuning (the preview webview throttles `requestAnimationFrame`
to zero, so burst-stepping through `__botx.frame()` is the only way to verify a
frame visually).

## Packaging size

`npm run package:body` produces a `dist/win-unpacked` tree of roughly **322 MB**,
dominated by the Electron runtime and Chromium resources, which compress to
about **235 MB** for the executable alone. Packed into the VSIX it measured about
**143 MB**.

That is over the practical size budget for Marketplace distribution, so this
build targets local installation and sideloading. Reducing it means a different
packaging strategy (a shared runtime, or moving the Body out of the extension),
not a configuration change. The single largest available win is dropping
`electronLanguages` to `["en-US"]` (already done) and excluding `node_modules`
from `app.asar` (already done) — beyond that, the Electron runtime itself is the
floor.