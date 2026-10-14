# BotX Companion — Project Plan & Implementation State

## Executive Summary

| Field | Value |
|-------|-------|
| **Project Name** | BotX Companion (VS Code Extension) |
| **Objective** | Interactive 3D AI Assistant sidebar featuring an animated "Eve" robot model, real-time workspace perception, and Google AI Studio (Gemini) integration |
| **Tech Stack** | VS Code Extension API (TypeScript), Three.js r128, GLTFLoader, WebGL, Google AI Studio API (Gemini 2.0 Flash) |
| **Build Command** | `npm run compile` (TypeScript `tsc -p ./`) |
| **Entry Point** | `out/extension.js` |

---

## Implemented Components (Completed)

### 1. Layout Scaffolding
**File:** `src/CompanionWebviewProvider.ts`

Responsive 3-section sidebar UI built as a VS Code `WebviewViewProvider`:

| Section | Selector | Purpose |
|---------|----------|---------|
| Status Header | `.brain-card` | Top panel — "AETHER BRAIN" title, green ACTIVE badge, event tag container |
| 3D Canvas | `#viewport` > `#canvas-container` | Center area — Three.js WebGL renderer fills flex-1 space |
| Chat Input | `.input-bar` | Bottom bar — text input (`Ask Eve...`) + Send button |
| Response Area | `#eve-response` | Above input bar — renders Eve's AI responses with label, auto-shows/hides |

The provider registers as `botx-eyes` view type under the `botx-companion-view` Activity Bar container (defined in `package.json` contributes).

### 2. 3D Rendering Engine
**File:** `src/CompanionWebviewProvider.ts` (inline `<script>` in `_getHtmlForWebview()`)

- Three.js scene with `PerspectiveCamera` (45 FOV, positioned at `0, 1.0, 3.2`)
- `AmbientLight(0xffffff, 1.5)` — base illumination
- `DirectionalLight(0xffffff, 1.8)` at position `(2, 4, 3)` — key light
- `WebGLRenderer` with antialiasing and alpha transparency
- Responsive resize handler updates camera aspect ratio and renderer size

### 3. Model Pipeline
**File:** `src/CompanionWebviewProvider.ts`

- Loads `assets/eve.glb` via `THREE.GLTFLoader` with a CSP nonce
- Auto-scales to fit viewport: `scale = 2.2 / maxDim` where `maxDim = max(size.x, size.y, size.z)`
- Centers bounding box via `model.position.sub(center.multiplyScalar(scale))`
- Y-offset: `model.position.y = -0.3`
- Model URI resolved through `webview.asWebviewUri()` for secure local resource access

### 4. Idle Animation Loop
**File:** `src/CompanionWebviewProvider.ts`

Continuous `requestAnimationFrame` loop with two effects:
- **Float:** `position.y = -0.3 + Math.sin(time * speed) * amplitude`
  - Idle: `speed=0.8`, `amplitude=0.05`
  - Active (responding): `speed=2.5`, `amplitude=0.10`
- **Y-axis rotation:** `rotation.y += rotSpeed`
  - Idle: `0.003` rad/frame
  - Active: `0.012` rad/frame

The `animating` boolean flag is set `true` on send and cleared 3 seconds after the AI response arrives, creating a temporary "excited" animation state.

### 5. Webview Message Passing (Bidirectional)
**Files:** `src/CompanionWebviewProvider.ts`

**Webview → Extension Host:**
- `.chat-input` Enter key and `.send-btn` click both call `vscode.postMessage({ command: 'askEve', text })`
- Button is disabled during request; "Eve is thinking..." shown immediately

**Extension Host → Webview:**
- `onDidReceiveMessage` listener handles `askEve` — calls `chatWithEve()`, posts `{ command: 'eveResponse', text }` back
- `window.addEventListener('message')` in webview handles `eveResponse` — renders in `#eve-response`, re-enables input
- `setAnimation` messages from Decision Engine also handled (shows reason text)

### 6. Google AI Studio Integration (Gemini 2.0 Flash)
**File:** `src/ai/gemini.ts`

Two API paths share the same Gemini backend:

| Function | Purpose | System Prompt |
|----------|---------|---------------|
| `GeminiAgentEngine.analyzeMultipleErrors()` | Structured error analysis (JSON response) | Diagnostic-specific prompt |
| `chatWithEve(userMessage)` | Free-form chat | Eve personality prompt |

`chatWithEve()` specifics:
- Reads API key from `vscode.workspace.getConfiguration('botx').get('geminiApiKey')`
- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`
- System instruction: Eve personality (concise, friendly coding assistant, 2-4 sentences)
- Generation config: `temperature: 0.7`, `maxOutputTokens: 1024`
- Timeout: 20s via `AbortController`
- Error handling: 401 (bad key), 429 (rate limit), timeout, empty response, network failure
- All requests/responses logged via `Logger.info('AI', ...)`

### 7. Workspace Perception Sensors (11 Active)
**File:** `src/extension.ts`

All sensor events route through `Logger` + WebSocket (port 8055). Only the Decision Engine's FSM output reaches the UI.

| # | Sensor | Event |
|---|--------|-------|
| 1 | Active Editor Switcher | `onDidChangeActiveTextEditor` |
| 2 | Cursor Line/Selection | `onDidChangeTextEditorSelection` (200ms debounce) |
| 3 | Text Document Edits | `onDidChangeTextDocument` (500ms debounce, edit counter) |
| 4 | File Save | `onDidSaveTextDocument` |
| 5 | Diagnostics/Error | `onDidChangeDiagnostics` (error count) |
| 6 | Terminal Creation | `onDidOpenTerminal` |
| 7 | Terminal Output | `onDidEndTerminalShellExecution` |
| 8 | Debug Start | `onDidStartDebugSession` |
| 9 | Debug Termination | `onDidTerminateDebugSession` + custom events |
| 10 | Focus Inactivity | 30s idle timer (no edits/cursor/switches) |
| 11 | Extension Lifecycle | `extensions.onDidChange` (install/remove) |

### 8. Decision Engine → Animation Pipeline
**Files:** `src/decision/decisionEngine.ts`, `src/CompanionWebviewProvider.ts`

- `DecisionEngine` publishes decisions via an observable pattern
- `provider.notifyDecision(type, reason)` maps `DecisionType` → animation name via `DECISION_ANIMATION_MAP`
- Posts `{ command: 'setAnimation', animation, decisionType, reason }` to webview
- Supported animations: `idle`, `thinking`, `happy`, `alert`, `error`, `curious`, `listen`, `celebrate`, `sleep`

### 9. Configuration
**File:** `package.json`

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `botx.enableVoice` | boolean | `false` | Enable voice responses (currently disabled) |
| `botx.autoExplainErrors` | boolean | `true` | Automatically explain errors |
| `botx.cooldownSeconds` | number | `30` | Cooldown between suggestions |
| `botx.geminiApiKey` | string | `""` | Google AI Studio API key for Eve chat |

### 10. Build Infrastructure
- `.vscode/launch.json` and `.vscode/tasks.json` synced with `npm: compile` preLaunchTask
- Target: `out/extension.js`
- `npm run compile` = `tsc -p ./`
- Dependencies: `ws` (WebSocket), Three.js r128 + GLTFLoader bundled in `media/`

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│  VS Code Sidebar (Webview)                              │
│  ┌───────────────────────────────────────────────────┐  │
│  │ .brain-card — AETHER BRAIN status header          │  │
│  ├───────────────────────────────────────────────────┤  │
│  │ #viewport — Three.js canvas                       │  │
│  │   AmbientLight(1.5) + DirectionalLight(1.8)       │  │
│  │   eve.glb — auto-scaled, floating, rotating       │  │
│  │   Idle: sin(0.8t)*0.05, rot 0.003                 │  │
│  │   Active: sin(2.5t)*0.10, rot 0.012              │  │
│  ├───────────────────────────────────────────────────┤  │
│  │ #eve-response — AI reply display area              │  │
│  ├───────────────────────────────────────────────────┤  │
│  │ .input-bar — chat input + Send button              │  │
│  └──────────────────────┬────────────────────────────┘  │
│                         │ postMessage                    │
│                         ▼                                │
├─────────────────────────────────────────────────────────┤
│  Extension Host (Node.js)                               │
│  ┌───────────────────────────────────────────────────┐  │
│  │ onDidReceiveMessage('askEve')                     │  │
│  │   └─→ chatWithEve(text)                          │  │
│  │         └─→ Gemini 2.0 Flash API                 │  │
│  │         ◄── response text                         │  │
│  │   └─→ postMessage('eveResponse', text)            │  │
│  ├───────────────────────────────────────────────────┤  │
│  │ DecisionEngine → notifyDecision()                 │  │
│  │   └─→ postMessage('setAnimation', ...)            │  │
│  ├───────────────────────────────────────────────────┤  │
│  │ 11 Workspace Sensors → Logger → WebSocket(8055)   │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## Source File Map

```
src/
├── CompanionWebviewProvider.ts   — Webview UI, 3D scene, message bridge
├── extension.ts                  — Activation, sensors, command registration
├── ProcessManager.ts             — Electron robot-body lifecycle
├── ai/
│   └── gemini.ts                 — GeminiAgentEngine + chatWithEve()
├── behaviour/                    — Behaviour pipeline
├── config/
│   └── deprecationRules.ts       — Deprecation detection rules
├── context/                      — Context analysis
├── core/                         — Core pipeline
├── decision/
│   ├── decisionEngine.ts         — FSM decision engine
│   ├── decisionType.ts           — DecisionType enum
│   └── decision.ts               — Decision interface
├── eventFilter/                  — Event filtering
├── explanation/                  — Error explanation
├── learning/                     — Adaptive learning
├── motion/                       — Motion commands
├── motionController/             — Motor control
├── perception/                   — Perception pipeline
├── sensors/                      — Workspace sensors
└── utils/
    ├── logger.ts                 — Output channel logger
    └── websocketServer.ts        — WebSocket bridge (port 8055)

assets/
└── eve.glb                       — 3D robot model

media/
├── three.min.js                  — Three.js r128
└── GLTFLoader.js                 — GLTF model loader
```

---

## Lacking / Next Phase Actions

### Phase 1: Enhanced Chat Experience
- [ ] Conversation history — maintain multi-turn context in `chatWithEve()` (currently stateless single-turn)
- [ ] Streaming responses — use Gemini streaming API for real-time token-by-token display
- [ ] Markdown rendering — parse Eve's responses for code blocks, bold, links in `#eve-response`
- [ ] Workspace context injection — automatically include current file, selection, or diagnostics in the prompt

### Phase 2: Rich Animation States
- [ ] Talking animation — mouth/visor pulsing while response is streaming in
- [ ] Nodding animation — brief head tilt on successful response
- [ ] Error shake — brief vibration on API failure or rate limit
- [ ] Thinking pose — model tilts forward during API request (replaces simple "thinking" text)
- [ ] Idle sleep mode — eyes close after extended inactivity

### Phase 3: Proactive Intelligence
- [ ] Auto-explain on error — trigger `chatWithEve()` automatically when diagnostics change, push summary to `#eve-response`
- [ ] Context-aware suggestions — use sensor data (editor focus, cursor position) to proactively offer help
- [ ] Code fix application — parse Eve's suggested fixes and offer "Apply" button in response area

### Phase 4: Voice & External Integration
- [ ] Voice responses — text-to-speech via `botx.enableVoice` setting (currently placeholder)
- [ ] Robot-body sync — WebSocket messages to Electron app for physical robot animations
- [ ] Multi-model support — fallback chain (Gemini → local model) for offline use

---

## Prompt History

| Session | Date | Changes |
|---------|------|---------|
| 1 | — | Initial project scaffold, Three.js scene, eve.glb loading, idle animation |
| 2 | — | Updated light intensities (1.5/1.8), scale factor (2.2), y-offset (-0.3), added float animation with `Math.sin()` and Y-axis rotation |
| 3 | — | Added bidirectional webview messaging (`askEve`/`eveResponse`), `chatWithEve()` function in `gemini.ts`, `botx.geminiApiKey` config, `#eve-response` display area, animation boost during AI responses (speed/amp/rot doubled), disabled button state during request |
| 4 | — | Created `PROJECT_PLAN.md` — documented full architecture, implementation state, source map, and next-phase roadmap |

---

## Permanent Roadmap: Comment-Driven Coding with Eve

**Status:** Future feature — explicitly deferred until the explicit Chat command
parser and `#write` workflow are stable. This is a separate input source from
Chat commands and must not be implemented by adding comment syntax to the Chat
parser.

### Product intent

Allow an author to write an explicit Eve instruction inside a supported source
comment, for example:

```python
# Eve: write a function to check whether a number is prime
```

```javascript
/*
Eve: add input validation to this function
*/
```

The comment is a request for a scoped proposal, not permission for unrelated
workspace changes. Eve must show a diff and use the existing approval process
before applying every modification.

### Planned implementation phase

Add a dedicated roadmap phase after the explicit Chat `#write` and contextual
conversation phases:

**Phase C — Comment-Driven Coding**

Dependencies:

1. Stable explicit command parser and `#write` workflow.
2. Existing `codingIntent.ts` detector reviewed and extended deliberately.
3. `DocumentActivitySensor` and EventFilter event identity support.
4. Existing context engine for file, range, language, surrounding code, and
   active task.
5. Existing Gemini provider and structured code-generation validation.
6. Existing `WorkspaceEdit`, diff preview, approval, source-freshness checks,
   and diagnostic verification.
7. Existing Brain → WebSocket → canonical Electron Body lifecycle reporting.

### Current foundation and known gaps

Reusable foundation currently exists in:

- `robot-brain/src/intent/codingIntent.ts`
- `robot-brain/src/sensors/documentActivitySensor.ts`
- `robot-brain/src/eventFilter/`
- `robot-brain/src/agents/codingAgent.ts`
- `robot-brain/src/context/`
- `robot-brain/src/workflow/writeWorkflow.ts`
- `robot-brain/src/validation/generatedCodeValidator.ts`

The current detector is not yet the finished feature. It currently:

- detects natural-language coding-like comments using language-specific
  single-line prefixes;
- uses broad coding verbs and confidence scoring;
- is called from document edits after added text;
- emits `CODING_INTENT_DETECTED` events.

It does not yet reliably provide:

- an explicit `Eve:` marker requirement;
- safe multiline comment parsing;
- stable instruction identity across edits and reloads;
- handled-instruction deduplication;
- surrounding-code range capture;
- task/destination resolution;
- proposal lifecycle ownership;
- comment replacement/removal behavior;
- an approval-aware comment result state.

The comment detector must remain separate from `commands/commandParser.ts`.

### Initial supported syntax scope

Start with a deliberately small documented set:

- Python: `# Eve: ...`
- JavaScript/TypeScript: `// Eve: ...` and `/* Eve: ... */`
- Java: `// Eve: ...` and `/* Eve: ... */`

Only these forms should be enabled initially. Additional languages and nested
or language-specific documentation-comment forms require separate tests before
being enabled. Unsupported or ambiguous syntax must be ignored rather than
guessed.

### Planned components

Likely additions or extensions:

- `src/intent/commentInstruction.ts` — explicit marker and syntax parser;
- `src/intent/commentInstructionIdentity.ts` — stable file/range/content hash;
- `src/sensors/documentActivitySensor.ts` — changed-range extraction and event
  publication, reusing the existing detector rather than duplicating it;
- `src/eventFilter/eventTypes.ts` — structured comment-instruction event if the
  existing coding-intent event is insufficient;
- `src/context/` — bounded surrounding code and destination context;
- `src/workflow/commentProposalWorkflow.ts` — proposal, diff, approval, apply,
  stale-source rejection, verification, and handled-state transitions;
- `src/learning/` or existing global state — only if a small handled-instruction
  record is proven necessary; no new memory database;
- `src/test/suite/comment-instruction.test.ts`;
- `src/test/suite/comment-instruction-workflow.test.ts`.

### Safety rules

1. Ordinary comments, documentation, examples, quoted text, and commented-out
   code do not trigger.
2. The explicit `Eve:` marker is required.
3. Detection must not fire on every keystroke; edits are debounced and only
   completed changed comment ranges are considered.
4. One unchanged instruction identity produces at most one proposal.
5. A changed instruction gets a new identity and may be reconsidered.
6. Removing or editing the marker cancels/supersedes the pending instruction.
7. The proposal is scoped to the associated file/range and surrounding code.
8. Source version/range is revalidated before applying any edit.
9. Every generated modification requires the existing approval flow.
10. No terminal command, secret access, arbitrary file creation, or unrelated
    workspace modification is authorized by a comment instruction.
11. Provider failure, ambiguity, cancellation, stale source, and verification
    failure are reported honestly.
12. The Electron Body only renders lifecycle state; it does not parse comments,
    call AI, or apply edits.

### Test plan

Parser tests:

- Python `# Eve: ...`.
- JavaScript/TypeScript `// Eve: ...`.
- JavaScript/TypeScript/Java block comments.
- Whitespace and marker casing policy.
- Nested marker text and quoted `Eve:` text are ignored when not an actual
  supported comment instruction.
- Documentation comments and ordinary TODOs are ignored.
- Commented-out source is not treated as an instruction without the marker.
- Unsupported language/comment forms are ignored.
- Multiline range and instruction extraction are deterministic.

Sensor/EventFilter tests:

- Only changed comment ranges are inspected.
- Debounced edit bursts produce one event.
- Unchanged comment identity is suppressed after handling.
- Changed content produces a new identity.
- Deletion and undo do not leave a stale pending request.
- File, range, language, task, and surrounding-code evidence are preserved.

Workflow tests:

- Valid instruction produces one scoped proposal.
- Provider failure produces no edit.
- Empty or malformed code produces no edit.
- User cancellation produces no edit.
- Diff preview appears before approval.
- Approval applies only the intended range.
- Rejection leaves source unchanged.
- Stale source rejects application.
- Verification success and failure are distinct.
- A failed proposal can be explained and manually re-requested without an
  automatic retry loop.
- Duplicate events cannot produce duplicate proposals.

Runtime acceptance criteria:

1. Open a supported file and add one explicit `Eve:` instruction.
2. Confirm exactly one Brain event and one proposal.
3. Confirm Eve reports the file/range being considered.
4. Confirm the generated diff is scoped to the intended code.
5. Confirm no change occurs before approval.
6. Confirm rejection leaves the file unchanged.
7. Confirm approval applies only the approved proposal.
8. Confirm verification reports actual diagnostics.
9. Edit the comment again and confirm a new identity is required.
10. Disconnect/reconnect the Body and confirm the Brain remains authoritative
    and no duplicate proposal is created.

### Explicit deferral

This roadmap item is not part of Phase 1 and must not be implemented by
modifying the explicit `#` command parser. It should begin only after the
explicit command, write insertion, adaptive explanation, and Fix/Verify/Replan
flows have focused tests and live runtime checks.
