# Ace.X — Developer Companion

Ace.X is a VS Code extension (**robot-brain**) plus a floating Electron companion
window (**robot-body**) containing Eve. The extension observes the workspace deterministically,
decides *whether and how* to help, and the companion expresses that decision.

There is exactly one of each: one Brain, one decision engine, one behaviour FSM,
one animation controller, one face controller, one gaze channel, one WebSocket
connection, one companion window. **Deterministic code decides; Gemini only
explains; the Body only expresses.**

---

## Architecture

```
VS Code workspace
   │
   ▼
Sensors ──▶ EventFilter (debounce / dedupe / queue)
   │
   ▼
PerceptionEngine ──▶ Observation { type, timestamp, source, confidence, strength?, data }
   │                              │
   │                              └──▶ CompanionLoop (sees every observation first)
   ▼
ContextEngine  (+ stuck-error tracking, AST dependency resolution)
   │
   ▼
DecisionEngine (deterministic rules + cooldowns + diagnostic dedupe)
   │            │
   │            └──▶ CompanionLoop (teaching ladder + interruption policy)
   ▼
BehaviourController → MotionPlanner → MotionController → WebSocket (:8055)
   │                                      │
   │                                      ├──▶ AIExplanationEngine (Gemini)
   │                                      │
   └── CompanionLoop → WebSocket
                          │
                          ▼
                 robot-body: MessageParser → ActionMapper → BehaviourController
                             → AnimationController + FaceController → Three.js
```

`CompanionLoop` (`robot-brain/src/pipeline/companionLoop.ts`) is the
orchestrator, **not** a second brain. It consumes observations and decisions from
the existing pipeline and coordinates the companion subsystems below.

---

## The companion loop

OBSERVE → UNDERSTAND → DECIDE → ATTENTION → EXPRESS → TEACH → LEARN

| Stage | Where | What happens |
| --- | --- | --- |
| OBSERVE | `CompanionLoop.observe` | Every observation lands here first — diagnostics, edits, saves, stuck signals |
| UNDERSTAND | RecurringMistakes + StruggleDetector + Heatmap | Is this known? Is the developer stuck? Where does trouble keep happening? |
| DECIDE | TeachingEngine + InterruptionPolicy | Which rung (0–4), and is now a moment worth interrupting? |
| ATTENTION | AttentionTracker | What should the Body look toward (approximate region, never coordinates)? |
| EXPRESS | EMOTION + CAPTION | How the robot feels (emotion) and what it says (caption) — separate channels |
| TEACH | TeachingEngine rung → caption | Nudge / hint / explain / fix, chosen deterministically |
| LEARN | LearningAgent + LearningMemory | Skill score, verbosity resolution and recurring-mistake counts persist across sessions |

| Subsystem | File | What it does |
| --- | --- | --- |
| Recurring mistakes | `learning/recurringMistakes.ts` | Keyed counters: has this mistake happened before? |
| Struggle detection | `struggle/struggleDetector.ts` | Weighted, decaying, explainable "may be stuck" estimate |
| Friction heatmap | `heatmap/struggleHeatmap.ts` | Which files/lines keep causing trouble |
| Teaching ladder | `teaching/teachingEngine.ts` | Chooses LEVEL 0–4 |
| Interruption policy | `decision/interruptionPolicy.ts` | Chooses SILENT / OBSERVE / ACKNOWLEDGE / NUDGE / HINT / EXPLAIN / FIX |
| Shared attention | `attention/attentionTarget.ts` | Deterministic attention target for the Body |
| Debugging timeline | `timeline/timelineBuffer.ts` | Rolling 60 s buffer for replay |
| Communication mode | `communication/communicationMode.ts` | CAPTION (default) vs optional TTS |

### The hint ladder (LEVEL 0–4)

| Level | Meaning |
| --- | --- |
| 0 | Silent observation — notice, teach nothing |
| 1 | Nudge — "There may be a problem around `file.ts:42`" |
| 2 | Hint — a targeted clue, no full explanation |
| 3 | Explanation — full concept explanation (Gemini) |
| 4 | Fix — the concrete fix (Gemini) |

The rung is chosen from skill level, recurrence, struggle, severity, whether the
developer asked directly, and whether an explanation was already shown. **The
ladder never jumps straight to a fix**: level 4 requires either a direct ask, or
a repeated mistake combined with high struggle. Levels ≤ 2 are worded
deterministically, so they cost no Gemini call — the companion tracks how many
calls the ladder avoided (reported by **BotX: Show Learning Summary**).

### Teaching Mode and Monitoring

Two independent switches, each persisted in VS Code settings with the runtime
state held only in `CompanionLoop`:

| Setting | Command | ON | OFF |
| --- | --- | --- | --- |
| `botx.teachingMode` | `BotX: Toggle Teaching Mode` | The ladder nudges, hints and explains | Passive escalation and automatic explanations stop; explicit Ask Companion / Explain Error still work |
| `botx.monitoring` | `BotX: Toggle Monitoring` | Normal observation, teaching and expression | No passive interruptions, no automatic Gemini calls, no background expression — explicit commands still work, learning data untouched |

Monitoring pauses *companion processing*, not the window: it is unrelated to
Show/Hide Companion.

### Verbosity (`botx.verbosity`)

`AUTO` · `CONCISE` · `BALANCED` · `DETAILED`. AUTO derives the effective length
from the learning profile (beginners get detail, experts get terse). The
resolved length reaches Gemini prompt construction — it is a prompt instruction
and an output budget, not a stored preference. Explicit requests (Ask Companion,
Explain Error) are answered at the configured level rather than being clamped to
the passive "one or two sentences" default.

### Gemini gating and accounting

A Gemini call happens on one of two paths:

1. **Passive diagnostic path** — gated by monitoring → auto-explain → teaching
   mode → repeat suppression → the ladder (rungs ≤ 2 are worded deterministically
   and cost nothing). Each skipped opportunity increments `geminiAvoided` at the
   gate, the only place that counter is incremented.
2. **Explicit path** — Ask Companion and Explain Error never consult a cooldown,
   the ladder or monitoring. An explicit ask opens a window in which the *passive*
   path is suppressed instead (the answer is already on screen), so the same
   issue is never bought twice.

Counters live only in `CompanionLoop`, each with one increment site:

| Counter | Meaning |
| --- | --- |
| `geminiRequested` | A Gemini request was initiated (gate approved, or the user asked) |
| `geminiExecuted` | Gemini actually returned the explanation (fallback text does not count) |
| `geminiAvoided` | A real automatic opportunity was deliberately skipped |
| `explicitGeminiRequest` | The user asked directly |

Gemini decides none of the product's decisions: not monitoring, not interruption,
not skill or struggle score, not emotion, not attention. It words explanations —
and the reaction to its answer (the expression) is derived from Brain-side facts
(success, fixes, severity), not from model output.

### Reading the results

| Command | Shows |
| --- | --- |
| `BotX: Show Learning Summary` | Skill level/score, verbosity, accepted vs ignored suggestions, recurring mistake categories, unresolved patterns, improvement signals, Gemini spend, plus the current struggle read |
| `BotX: Replay Recent Debugging Timeline` | Last ~60 s: first change before the error, when the diagnostic first appeared, repeated attempts, diagnostic transitions, and whether it appears resolved — it says "insufficient information" rather than inventing terminal events |

The struggle read is behavioural only — repeated diagnostics, repeated attempts,
idle focus after an issue — phrased as *"coding behaviour suggests repeated
difficulty around this issue"*. No emotion is ever claimed or inferred; there is
no sentiment analysis.

### Honest limits

- VS Code exposes no absolute editor screen coordinates. `ATTENTION_TARGET`
  therefore means "look toward the region", never precise pointing. The Body
  maps each target type to an approximate region vector that a future
  editor-coordinate mapper can replace without changing the protocol.
- Targets expire (`expiresAt`), are released when the issue resolves, when
  monitoring stops and on lifecycle reset — a released target is the same
  canonical frame with strength 0 and an elapsed expiry, so the gaze falls back
  to normal without a second gaze system.
- Struggle is inferred from **coding behaviour only** (repeated failures, rapid
  saves, undo/redo churn, idle focus, absent progress). It is never a camera or
  affect inference, and is phrased as "coding-behaviour suggests the developer
  may be stuck".
- Terminal output is not captured, so the timeline records relevant terminal
  events but does not claim command contents.
- TTS is an extension point. With no speech engine registered the mode degrades
  to captions; `botx.enableVoice` does not fake a voice.

---

## WebSocket protocol

`ws://localhost:8055` (the Brain falls back to the next free port and tells the
Body which one via `ROBOT_WS_PORT`).

**Legacy, still supported:** `ACTION`, `ROBOT_STATE`, `ROBOT_STATE_UPDATE`,
`CONNECTION_STATUS`, `EDITOR_CHANGED`, `CURSOR_MOVE`, `WINDOW_VISIBILITY`.

**Emotion channel (canonical):** `EMOTION {emotion, intensity?, speech?, duration?}`
with the closed vocabulary `IDLE · LISTENING · THINKING · SPEAKING · HAPPY ·
CONFUSED · ALERT · ERROR`. Adding a value requires a Body pose to exist for it.

**Companion channel (new):**

| Message | Payload |
| --- | --- |
| `ATTENTION_TARGET` | `targetType, file, line, column, endLine, endColumn, confidence, strength, reason, expiresAt` |
| `TEACHING_STATE` | `level (0–4), matter, concept?, recurrence?, skillLevel?` |
| `CAPTION` | `text, mode (CAPTION\|TTS), duration?` |
| `STRUGGLE_STATE` | `level, evidence[], confidence, expiresAt` |

Expression and speech are separate channels: `EMOTION` carries **how** the robot
feels, `CAPTION` carries **what** it says. CAPTION is the canonical
communication channel (caption-only unless a real speech engine is registered),
the latest caption replaces the previous one, expired captions disappear, and an
IDLE transition never carries an obsolete caption forward.

---

## Commands

| Command | Title |
| --- | --- |
| `botx.askCompanion` | Ask Companion |
| `botx.showCompanion` / `botx.hideCompanion` / `botx.restartCompanion` | Companion window control |
| `botx.toggleMonitoring` | Toggle Monitoring |
| `botx.explainError` | Explain Error |
| `botx.toggleTeachingMode` | Toggle Teaching Mode |
| `botx.replayTimeline` | Replay Recent Debugging Timeline |
| `botx.showLearningSummary` | Show Learning Summary |
| `botx.setApiKey` | Set API Key |

**Explicit request priority:** Ask Companion and Explain Error call Gemini
directly — no cooldown, ladder, monitoring or repeat-suppression check can block
them. A passive background diagnostic can still be suppressed (and is, while an
explicit answer is on screen, so it is never cut short). There is one priority
mechanism, not two.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `botx.autoStart` | `true` | Launch the companion window on activation |
| `botx.enableVoice` | `false` | Opt in to voice; stays caption-only without a speech engine |
| `botx.autoExplainErrors` | `true` | Master switch for *automatic* Gemini explanations (the ladder still nudges/hints deterministically) |
| `botx.cooldownSeconds` | `30` | Interaction cooldown between surfaced messages |
| `botx.teachingMode` | `true` | The hint ladder (0–4). Off = observe silently, explicit asks still answered |
| `botx.monitoring` | `true` | Passive companion processing. Off = explicit commands only, learning data preserved |
| `botx.verbosity` | `AUTO` | `AUTO` / `CONCISE` / `BALANCED` / `DETAILED` — reaches Gemini prompt construction |
| `botx.geminiApiKey` | `""` | Gemini API key (also settable with `BotX: Set API Key`) |

---

## Privacy

**Persisted state is deliberately small:**

- The learning profile (skill score/level, verbosity mode, accepted/ignored
  suggestion counts) — VS Code `globalState`, no source code.
- Settings and the API key — VS Code configuration.
- Recurring-mistake counters, the friction heatmap and the struggle estimate are
  in-memory aggregates (counts, file/line buckets, decaying scores). No file
  contents are stored.

**Never persisted:** source files, full documents, terminal output, chat history.

- The timeline is in-memory, bounded to ~60 s, and never uploaded.
- Document content is only read where a feature genuinely needs it (the
  diagnostic-analysis path). The document-activity sensor reports counts,
  positions and paths — never text.
- Gemini receives bounded, per-request context only: the current error, the
  relevant file/line (and a bounded snippet for Explain Error), skill/verbosity
  summary, and explicit request text. It never receives the timeline, the
  heatmap, arbitrary history or raw internal counters.
- No message is buffered for a disconnected Body: captions, emotions and
  attention targets are dropped rather than queued, so a reconnect can never
  resurrect expired content.
- Gemini returns explanation text only. It never decides emotion, struggle,
  skill, attention or whether to interrupt.

---

## Getting started

```bash
npm install                     # repo root
cd robot-brain && npm install && npm run compile
cd ../robot-body && npm install
```

Press **F5** in `robot-brain` to launch an Extension Development Host. The
companion window starts automatically unless `botx.autoStart` is `false`.

The packaged companion lives at `<extension>/companion/win-x64/BotX Companion.exe`
and is resolved relative to the extension — never from a workspace or machine
absolute path.
