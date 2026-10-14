# BotX Companion

A proactive AI coding companion. The extension supplies the **Brain** (sensors,
perception, decision, behaviour, motion, explanation); a separate **Robot Body**
launches as a floating desktop window showing Eve, a 3D robot that reacts to what
you are doing.

VS Code contains no robot renderer of its own — the companion lives entirely in
its own window, which you can drag anywhere on your desktop.

## Features

- Floating Eve companion window — frameless, transparent, always on top, draggable
- Workspace monitoring: diagnostics, editor focus, file saves, terminal failures,
  debug sessions, rapid saves, idle focus, TODO/FIX comments, git conflicts and
  branches, deprecated APIs, environment problems, extension installs
- Decision pipeline: EventFilter → Perception → Context → Decision (FSM) →
  Behaviour → Motion / AI Explanation
- Canonical emotion channel — the Brain tells the Body how it feels and how
  strongly, and the Body turns that into posture, expression, gaze and speech
  animation (see [Emotions](#emotions))
- **BotX: Ask Companion** — ask Eve a question; she thinks, then speaks the answer
- **BotX: Explain Error** — explain the error in the active file, on demand,
  without waiting for the passive ladder
- Teaching Mode, Monitoring and Verbosity switches (see
  [Extension Settings](#extension-settings)) that actually gate behaviour
- Learning Summary and 60 s Debugging Replay reports
- Gemini-powered explanations and chat ("BotX: Set API Key")
- Windows-only companion runtime

## Companion loop

`OBSERVE → UNDERSTAND → DECIDE → ATTENTION → EXPRESS → TEACH → LEARN`,
orchestrated by `CompanionLoop` (`src/pipeline/companionLoop.ts`), which is a
coordinator — not a second brain. Deterministic subsystems decide; Gemini only
words explanations; the Body only expresses.

**Honest limits:**

- Attention is approximate. VS Code exposes no editor screen coordinates, so
  `ATTENTION_TARGET` means "look toward the region" — never exact pointing.
  Targets expire and are released on resolution / monitoring-off / reset.
- Struggle is read from coding behaviour only (repeated diagnostics and
  attempts, idle focus, undo churn). Emotions are never detected or inferred,
  and there is no sentiment analysis — wording is always about behaviour.
- Communication is caption-only unless a real speech engine is registered;
  `botx.enableVoice` cannot fake one.
- Explicit requests (Ask Companion, Explain Error) bypass passive gating
  entirely; Gemini never decides monitoring, interruption, skill, struggle,
  emotion or attention.

## Commands

All commands are under the **BotX** category in the Command Palette:

| Command | Description |
| --- | --- |
| BotX: Ask Companion | Ask Eve a question; she answers as a caption under the robot |
| BotX: Show Companion | Show (or launch) the Eve window |
| BotX: Hide Companion | Hide the Eve window without stopping it |
| BotX: Restart Companion | Restart the Robot Body process |
| BotX: Toggle Monitoring | Pause / resume passive companion processing (explicit commands keep working) |
| BotX: Explain Error | Explain the primary error in the active file on demand |
| BotX: Toggle Teaching Mode | Turn the hint ladder (LEVEL 0–4) on or off |
| BotX: Replay Recent Debugging Timeline | Write the last ~60 s of activity to the Aether Brain channel |
| BotX: Show Learning Summary | Skill level, suggestions, recurring mistakes, friction hotspots, Gemini spend, current struggle read |
| BotX: Set API Key | Store a Gemini API key |

The status bar shows Brain state: current event, diagnostic error count, and
monitoring status. Details go to the **Aether Brain** output channel.

## Emotions

The Brain does not send poses, expressions or animation names. It sends **how it
feels** on a closed vocabulary of eight emotions, plus an intensity:

`IDLE`, `LISTENING`, `THINKING`, `SPEAKING`, `HAPPY`, `CONFUSED`, `ALERT`, `ERROR`

```jsonc
// EMOTION frame on the Brain → Body WebSocket
{ "type": "EMOTION", "emotion": "ALERT", "intensity": 0.7, "speech": "3 errors here" }
```

- **Intensity** is `0..1` and scales how far the Body deviates from its resting
  posture and neutral face. It never freezes the companion: breathing and idle
  drift are always present, so intensity `0` is calm, not switched off.
- **Duration** is optional. Without it the Body holds each emotion for its own
  default — short for reactions, longer for work in progress.
- Only `SPEAKING` moves the mouth. A caption attached to `THINKING` is shown but
  does not make the robot look like it is talking.

The Brain derives intensity from signals it already has (diagnostic severity,
how many problems exist, whether the observation is meant to be silent). Model
output is mapped onto the fixed set — an emotion that is not in the list is never
sent.

The vocabulary lives in the Body (`robot-body/behaviour/emotion.js`), which owns
the visual meaning; each emotion maps onto an existing behaviour state and pose,
so adding a state means adding a pose, not a second controller.

## Extension Settings

- `botx.autoStart` (default `true`) — launch the companion window when the
  extension activates. When disabled, use **BotX: Show Companion** to start it.
- `botx.geminiApiKey` — Google AI Studio key for Eve's responses. Can also be
  stored via the command (stored globally).
- `botx.teachingMode` (default `true`) — the hint ladder. When off, Eve observes
  silently; Ask Companion and Explain Error still work.
- `botx.monitoring` (default `true`) — passive companion processing. When off,
  no passive interruptions and no automatic Gemini calls; explicit commands and
  learning data are unaffected.
- `botx.verbosity` (default `AUTO`) — `AUTO` / `CONCISE` / `BALANCED` /
  `DETAILED`. AUTO derives the length from the learning profile. The resolved
  length is an instruction in Gemini's prompt and scales its output budget.
- `botx.autoExplainErrors` (default `true`) — gates *automatic* Gemini
  explanations; deterministic rungs still nudge and hint.
- `botx.cooldownSeconds` (default `30`) — interaction cooldown between surfaced
  messages. Explicit requests ignore it.
- `botx.enableVoice` (default `false`) — opt in to voice. Captions remain the
  default and the fallback; no speech engine is registered yet, so enabling this
  never produces a silent-but-"speaking" robot.

## Companion resolution

The Brain looks for the Robot Body in this order:

1. **Packaged companion** — `<extension>/companion/win-x64/BotX Companion.exe`.
   This is what ships in the VSIX and is the only path used when installed.
2. **Development fallback** — the `electron` binary from the repository's
   `node_modules`, running the `robot-body` source folder. Used only under F5
   / Extension Development Host.

No workspace folder is required, and no absolute development path is referenced.

## Runtime dependencies

`ws` is the only production dependency and is the only `node_modules` content in
the VSIX.

The TypeScript Compiler API is **not** shipped (~23 MB, and nothing else needs
it at runtime). AST-based analysis — dependency resolution for error
explanations, and deprecated-API scanning — resolves the compiler lazily from
VS Code's own bundled `vscode.typescript-language-features` extension, falling
back to a normal `require('typescript')` when it is on the resolution path (for
example under F5). If neither resolves, those two analyses are skipped and
logged; everything else, including the companion, keeps working.

## Requirements

- Windows (x64). The companion runtime is packaged for win32-x64 only.
- Node.js and a Gemini API key for AI explanations (optional — the rest of the
  pipeline works without it).

## Development

```powershell
npm install                 # from the repository root
npm run compile-brain       # compile the Brain
npm run package:body        # build the packaged companion into robot-body/dist
npm run start-body          # run the companion standalone
```

Open `D:\DigitalCompanion` in VS Code and press F5 to launch an Extension
Development Host. The Brain auto-starts the companion from the packaged build if
one exists, otherwise from source.

## Coding commands

The persistent Eve chat accepts the explicit commands `#write`, `#explain`,
`#debug`, `#teach`, `#test`, `#review`, `#fix`, and `#what changed`. Generated
code is validated before insertion where a deterministic validator is available.
Insertion does not claim that code was executed or tested.

`#test` selects only structured, workspace-contained validation strategies. A
Python or JavaScript syntax check may run without a project-script approval;
configured project `typecheck` and `test` scripts require explicit approval.
Commands run with bounded output, a timeout, cancellation, duplicate-request
protection, and no shell command string. Missing tools or project scripts are
reported as unavailable rather than silently installed or substituted.

## Comment-driven coding

Comment instructions are deliberately separate from chat command parsing. The
initial supported forms are:

```python
# Eve: write a function to check whether a number is prime
```

```javascript
// Eve: implement binary search for this array
```

JavaScript, TypeScript, and Java block comments are also supported when the
explicit `Eve:` marker is present. Eve debounces document changes, assigns a
stable instruction identity, previews a scoped proposal, and asks for approval
before inserting code below the instruction. Ordinary comments, unmarked
documentation, quoted examples, and string literals do not authorize edits.
Comment instructions never authorize terminal execution. Support is currently
limited to Python, JavaScript, TypeScript, and Java; language-server and live
runtime behavior still depends on the later end-to-end test environment.

## Privacy and external AI

When Gemini features are used, the requested prompt and the bounded source or
diagnostic context needed for that request are sent to Google AI Studio. Do not
place secrets in source context. API keys are stored through VS Code's existing
configuration path and must not be committed. Validation commands run locally;
Ace.X does not silently install dependencies or upload command output as a
separate service.

## Release status

The repository contains Windows x64 packaging support for the canonical Electron
Body. Marketplace publication still requires project-owned publisher details,
license/third-party notice decisions, clean-install testing, and inspection of
the final VSIX and packaged Eve assets. No publication is performed by the
development scripts.

## Release Notes

### 0.0.1

Initial release of the Brain + Robot Body architecture: the sidebar robot
renderer was removed in favour of the standalone floating companion, the Robot
Body was packaged for win32-x64, Three.js was vendored locally (no CDN), and all
runtime paths were made extension-relative. The canonical emotion channel
replaces expression/action name overloads, and **Ask Companion** makes the robot
a conversational surface.
