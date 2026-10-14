import * as vscode from 'vscode';
import {
  startRobotServer,
  stopRobotServer,
  sendToRobot,
  onRobotMessage,
  AUTHORITATIVE_ROBOT_PORT,
  setVoiceStateGetter
} from './utils/websocketServer';
import { askEve, generateCode } from './ai/gemini';
import { emitEmotion } from './behaviour/emotionMapper';
import { emitLifecycleState, emitSemanticEmotion } from './behaviour/semanticEmotion';
import { captionHoldMs } from './communication/communicationMode';
import { ProcessManager } from './ProcessManager';
import { StatusBar } from './StatusBar';
import { CompanionPanel } from './panel/companionPanel';
import { Logger } from './utils/logger';
import { EventFilter } from './eventFilter/eventFilter';
import { CognitivePipeline } from './pipeline/pipeline';
import { BrainMonitor } from './pipeline/brainMonitor';
import { FeedbackLoop } from './pipeline/feedbackLoop';
import { hasCodingIntentAtLine } from './intent';
import { AetherEvent } from './eventFilter/event';
import { EventType } from './eventFilter/eventTypes';
import { SessionManager } from './identity/sessionManager';
import { SensorCoordinator } from './sensors/sensorCoordinator';
import { UserModel } from './user/userModel';
import { LocalProjectCoordinator } from './coordination/projectCoordination';
import { AceSystem } from './aces/aceSystem';
import { RobotStatePublisher } from './ui/robotStatePublisher';
import { setStateSnapshotProvider } from './utils/websocketServer';
import { interpretVoiceCommand } from './voice/voiceCommands';
import {
  buildEveConversationContext,
  buildIssuePromptPrefix,
  describeLastChange,
  isAcknowledgment,
  selectTargetDiagnostic,
  type IssueTarget,
} from './conversation/eveConversation';
import { buildAdaptiveGuidance, buildGroundedContext, isArtifactFollowUp, missingContextMessage, type ExplanationArtifactContext } from './conversation/adaptiveExplanation';
import { parseCommand } from './commands/commandParser';
import { routeCommand } from './commands/commandRouter';
import { captureWriteTarget, insertGeneratedCode } from './workflow/writeWorkflow';
import { validateGeneratedCode } from './validation/generatedCodeValidator';
import { beginReplan, type ReplanState } from './workflow/replanPolicy';
import { SafeExecutor } from './validation/safeExecutor';
import { planValidation } from './validation/validationPlanner';
import { CommentCodingWorkflow } from './workflow/commentCodingWorkflow';
import { parseCommentInstructions } from './intent/commentInstruction';

process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason ?? 'Unknown rejection');
  Logger.info('EXTENSION', { 'Event': 'Unhandled promise rejection', 'Reason': message });
});

/**
 * SENSOR FILTER — prevents the output feedback loop.
 * Documents matching these schemes/filenames are never processed by sensors.
 */
function isOutputDocument(doc: { uri: vscode.Uri; fileName: string }): boolean {
  if (doc.uri.scheme === 'output') {return true;}
  if (doc.uri.scheme === 'vscode-userdata') {return true;}
  if (doc.fileName.includes('extension-output')) {return true;}
  return false;
}

export function activate(context: vscode.ExtensionContext) {
  try {
    console.log('Activating BotX Companion Extension...');

    // The canonical Eve lives in the Ace.X Robot view inside VS Code. The
    // extension contributes a status bar item, commands and webviews.
    const statusBar = new StatusBar();
    context.subscriptions.push(statusBar);

    // ONE authoritative port for Brain → floating Eve Body. Binding is
    // asynchronous and may FAIL: if 8055 is taken, no body may be launched,
    // because a Body pointed at a port the Brain never opened is the exact
    // silent failure this replaced.
    const robotServerStart = startRobotServer(AUTHORITATIVE_ROBOT_PORT);
    let robotLinkUp = false;

    // The canonical floating Eve body (robot-body Electron). Owned for the
    // whole extension lifetime; at most one body process ever exists.
    const processManager = new ProcessManager({
      extensionUri: context.extensionUri,
      wsPort: AUTHORITATIVE_ROBOT_PORT,
      relaunchDelayMs: 2000,
      maxRelaunchAttempts: 5
    });
    context.subscriptions.push({ dispose: () => processManager.dispose() });

    const eveAutoStart = () =>
      vscode.workspace.getConfiguration('acex').get<boolean>('eveAutoStart', true);

    /**
     * Tests (and any headless host) must never produce a visible Eve:
     * runTest.ts sets ACEX_NO_EVE=1, which the test host inherits. Manual
     * Show/Focus Eve commands keep working — only the automatic launch is
     * suppressed.
     */
    const eveLaunchSuppressed = () => process.env['ACEX_NO_EVE'] === '1';

    /**
     * ONE Eve only — the single entry point for every launch path.
     *
     *   Brain READY → ensureEveRunning() → existing Eve? focus it : create it.
     *
     * A second request only ever focuses the existing window: the manager
     * refuses while a child lives, the in-flight flag covers the spawn gap,
     * and the body's single-instance lock focuses Eve for any out-of-band
     * duplicate. NEVER creates Eve #2.
     */
    let eveLaunchInitiated = false;
    function ensureEveRunning(): void {
      if (processManager.isRunning()) {
        sendToRobot({ type: 'WINDOW_VISIBILITY', visible: true });
        sendToRobot({ type: 'WINDOW_FOCUS' });
        return;
      }
      if (eveLaunchInitiated) {
        return;
      }
      eveLaunchInitiated = true;
      processManager.launchRobotBody();
      if (!processManager.isRunning()) {
        // Nothing spawned (no target found) — allow a later retry instead of
        // wedging the flag forever.
        eveLaunchInitiated = false;
      }
    }

    // The server-ready promise IS the startup signal — Eve launches exactly
    // once, directly from the listening callback. No timeout synchronization:
    // a Body launched before the port is bound would connect to nothing.
    void robotServerStart.then((result) => {
      robotLinkUp = result.ok;
      if (!result.ok) {
        const detail = result.owner
          ? `Port ${result.port} is already in use by ${result.owner}.`
          : `Port ${result.port} is already in use.`;
        Logger.info('PROCESS_MANAGER', { Event: 'Eve launch blocked — port unavailable', Detail: detail });
        // Deliberately non-destructive guidance: the occupant is often another
        // VS Code window already running Ace.X (a healthy first Brain), and
        // terminating VS Code processes to free the port would kill it.
        void vscode.window.showErrorMessage(
          `Ace.X could not start Eve: ${detail} This is often another VS Code window already running Ace.X, which already serves Eve. Use Eve from that window, or close the other window and run "Ace.X: Show Eve" again.`
        );
        return;
      }
      if (result.reused) {
        // A healthy Brain already serves this port (typically the first Ace.X
        // window). Adopt it: the link is up, and Eve is focused — never
        // duplicated — through the single-entry launch path below.
        Logger.info('WEBSOCKET', {
          Event: 'Reusing healthy Brain server — no second server started',
          Port: String(result.port),
          Owner: result.owner ?? 'unknown',
        });
      } else {
        Logger.info('WEBSOCKET', { Event: 'Brain frame server listening', Port: String(result.port) });
      }
      if (eveLaunchSuppressed()) {
        Logger.info('PROCESS_MANAGER', { Event: 'Eve auto-launch suppressed (ACEX_NO_EVE test host)' });
        return;
      }
      if (eveAutoStart()) {
        ensureEveRunning();
      } else {
        Logger.info('PROCESS_MANAGER', { Event: 'Eve autoStart disabled by setting' });
      }
    });

    const aetherChannel = vscode.window.createOutputChannel('Aether Brain');

    // Initialize Logger with the output channel
    Logger.setChannel(aetherChannel);

    // ────────────────────────────────────────────────────────────────────
    // PHASE 1: Event Filter Pipeline
    // Creates the central EventFilter, instantiates all 14 class-based
    // sensors, and subscribes to filtered events for the webview status bar.
    // ────────────────────────────────────────────────────────────────────
    const eventFilter = new EventFilter();
    console.log('[BotX] EventFilter created');

    // Ace.X identity: every normalized event carries developer / session /
    // workspace / project / branch / team context from here on.
    const sessionManager = new SessionManager(context, eventFilter);
    eventFilter.setIdentityProvider(() => sessionManager.current());
    context.subscriptions.push({ dispose: () => sessionManager.dispose(eventFilter) });

    // Map event types to status bar display (icon + text)
    // Returns null for events that should NOT appear in the status bar (too noisy)
    function getEventDisplay(event: AetherEvent): { text: string; icon: string } | null {
      const p = event.payload as any;
      const file = (p.File || p.FileName || '').split(/[/\\]/).pop() || '';

      switch (event.type) {
        case EventType.EDITOR_ACTIVE:
        case EventType.EDITOR_SWITCHED:
          return { text: file || 'File', icon: '\u25B6' };

        case EventType.FILE_SAVED:
          return { text: 'Saved ' + file, icon: '\u2714' };

        case EventType.TERMINAL_COMMAND_FAILED:
          return { text: 'Command failed', icon: '\u26A0' };

        case EventType.DEBUG_STARTED:
          return { text: 'Debug started', icon: '\u25B6' };

        case EventType.DEBUG_STOPPED:
          return { text: 'Debug stopped', icon: '\u25A0' };

        case EventType.DEBUG_BREAKPOINT_HIT:
          return { text: 'Breakpoint hit', icon: '\u25CF' };

        case EventType.STUCK_RAPID_SAVE:
          return { text: 'Rapid saves detected', icon: '\u26A0' };

        case EventType.STUCK_IDLE_FOCUS:
          return { text: 'Idle focus detected', icon: '\u23F3' };

        case EventType.COMMENT_TRIGGER_DETECTED:
          return { text: 'TODO/FIX detected', icon: '\u270F' };

        case EventType.GIT_CONFLICT_DETECTED:
          return { text: 'Git conflict', icon: '\u26A0' };

        case EventType.GIT_CONFLICT_RESOLVED:
          return { text: 'Conflict resolved', icon: '\u2714' };

        case EventType.GIT_COMMIT_SUCCESS:
          return { text: 'Committed', icon: '\u2714' };

        case EventType.DEPRECATED_API_DETECTED:
          return { text: 'Deprecated API found', icon: '\u26A0' };

        // Events that are too noisy for the status bar — skip
        case EventType.CURSOR_MOVED:
        case EventType.FILE_CREATED:
        case EventType.FILE_DELETED:
        case EventType.FILE_RENAMED:
        case EventType.EDITOR_OPENED:
        case EventType.TERMINAL_OPENED:
        case EventType.TERMINAL_CLOSED:
        case EventType.TERMINAL_ACTIVE:
        case EventType.EXTENSION_INSTALLED:
        case EventType.EXTENSION_UNINSTALLED:
        case EventType.EXTENSION_ENABLED:
        case EventType.EXTENSION_DISABLED:
        case EventType.ENVIRONMENT_CHECK:
        case EventType.GIT_BRANCH_CHANGED:
        case EventType.GIT_REPOSITORY_CHANGED:
          return null;

        default:
          return null;
      }
    }

    // Subscribe to EventFilter → route clean events to the status bar
    eventFilter.subscribe((event: AetherEvent) => {
      console.log('[STATUS] EventFilter → ' + event.type + ' | source: ' + event.source);

      // Diagnostics: update persistent error count in the status bar
      if (event.type === EventType.DIAGNOSTICS_UPDATED) {
        updateStatusBarDiagnostics();
        companionPanel.refresh('diagnostic changed');
        return;
      }

      // The batch is the companion's authoritative "what is wrong right now"
      // signal: it replaces the live diagnostic set, so the panel follows it.
      if (event.type === EventType.DIAGNOSTIC_BATCH) {
        updateStatusBarDiagnostics();
        companionPanel.refresh('diagnostic batch');
        return;
      }

      // Map event to status bar display
      const display = getEventDisplay(event);
      if (display) {
        statusBar.showEvent(display.text, display.icon, updateStatusBarDiagnostics);
      }
    });

    // ────────────────────────────────────────────────────────────────────
    // COGNITIVE PIPELINE — wires all modules together
    // EventFilter → Perception → Context → Decision → Behaviour → Motion/Explanation
    //
    // Built BEFORE the sensors start on purpose. DiagnosticsSensor scans the
    // already-open workspace during start(); if the pipeline were not listening
    // yet, every diagnostic that exists at activation time would be observed by
    // nobody — no recurrence count, no struggle signal, no attention target,
    // and nothing for the BotX panel to show until the file was touched.
    // ────────────────────────────────────────────────────────────────────
    const pipeline = new CognitivePipeline(
      eventFilter,
      aetherChannel,
      async () => {
        const config = vscode.workspace.getConfiguration('botx');
        const key = config.get<string>('geminiApiKey', '');
        if (key) { return key; }
        return context.globalState.get<string>('botx.apiKey') || undefined;
      },
      (status: number) => {
        if (status === 401 || status === 429) {
          Logger.info('PIPELINE', { Event: 'Gemini API error', Status: String(status) });
        }
      },
      context
    );

    // Register voice state getter so the WebSocket server can send the current
    // voice setting to newly connected Robot Bodies.
    setVoiceStateGetter(() => pipeline.getCompanion().getVoiceEnabled());

    // ────────────────────────────────────────────────────────────────────
    // THE EXPLICIT ASK PATHS
    //
    // Ask Companion, Chat with Eve and the Robot Body's chat bubble all reach
    // Eve through this function. There is exactly one Gemini call shape, one
    // caption delivery and one spend accounting site, so no consumer can
    // develop its own idea of what Eve said. The companion panel is a
    // status strip only and has no ask path — it never calls this.
    // ────────────────────────────────────────────────────────────────────
    const askLabels: Record<string, string> = { ask: 'ASK', chat: 'CHAT', body: 'CHAT' };
    // Session-only transport results; reconnects recover completed explicit asks.
    const explicitResponses = new Map<string, Extract<import('./core/types').RobotPayload, { type: 'EVE_RESPONSE' }>>();
    const conversation: string[] = [];
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const safeExecutor = workspaceRoot ? new SafeExecutor({ workspaceRoot }) : undefined;
    let activeExplanationContext: ExplanationArtifactContext | undefined;
    let replanState: ReplanState | undefined;
    let replanEvidence: string | undefined;
    let fixInProgress = false;
    let chatOpen = false;
    let chatBusy = false;
    const commentWorkflow = new CommentCodingWorkflow();
    let commentBusy = false;
    eventFilter.subscribe((event) => {
      if (event.type !== EventType.CODING_INTENT_DETECTED || commentBusy) return;
      const payload = event.payload as Record<string, unknown>;
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.toString() !== payload.FileUri || editor.document.version !== payload.DocumentVersion) return;
      const instruction = parseCommentInstructions(editor.document.getText(), editor.document.languageId, editor.document.uri.toString()).find(item => item.id === payload.InstructionId);
      if (!instruction) return;
      commentBusy = true;
      void (async () => {
        try {
          const choice = await vscode.window.showInformationMessage(`Eve instruction found: ${instruction.text}`, 'Prepare proposal', 'Dismiss');
          if (choice !== 'Prepare proposal') return;
          emitLifecycleState('WRITING');
          const text = await commentWorkflow.handle(instruction, Number(payload.DocumentVersion));
          conversation.push(`Comment instruction: ${instruction.text}`, `Eve: ${text}`);
          void vscode.window.showInformationMessage(text);
          emitLifecycleState(commentWorkflow.state.get(instruction.id)?.status === 'COMPLETED' ? 'SUCCESS' : 'FAILURE');
        } catch (error) {
          emitLifecycleState('FAILURE');
          void vscode.window.showErrorMessage(`Eve comment proposal failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally { commentBusy = false; }
      })();
    });
    function respond(frame: Extract<import('./core/types').RobotPayload, { type: 'EVE_RESPONSE' }>): void {
      explicitResponses.set(frame.requestId, frame);
      if (explicitResponses.size > 40) { explicitResponses.delete(explicitResponses.keys().next().value!); }
      sendToRobot(frame);
    }

    async function askEveFlow(question: string, source: 'ask' | 'chat' | 'body', contextPrefix?: string): Promise<{ text: string; failed: boolean }> {
      const trimmed = question.trim();
      Logger.info('COMMAND', { Event: 'explicit ask', Source: source, Question: trimmed.slice(0, 120) });

      // An explicit question is never gated: mark the ask so passive diagnostics
      // suppress themselves while the answer is in flight and on screen.
      pipeline.getCompanion().noteDirectAsk();

      // LISTENING first, so the companion acknowledges before the round-trip.
      emitEmotion('LISTENING', { intensity: 0.6 });
      emitLifecycleState('LISTENING');

      // Eve-window conversation carries the active issue as framing so the
      // model answers about THIS problem. Typed asks keep exact wording.
      const modelQuestion = contextPrefix ? `${contextPrefix}\n\nUser: ${trimmed}` : trimmed;
      const request = askEve(modelQuestion, { verbosity: pipeline.getLearning().getEffectiveVerbosity() });
      const thinkingTimer = setTimeout(() => emitEmotion('THINKING', { intensity: 0.75 }), 400);

      let reply: { text: string; failed: boolean };
      try {
        reply = source === 'body'
          ? await request
          : await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: 'Eve is thinking…' },
            () => request
          );
      } finally {
        clearTimeout(thinkingTimer);
      }

      const { text, failed } = reply;
      emitLifecycleState(failed ? 'FAILURE' : 'EXPLAINING');
      if (!failed) {
        pipeline.getCompanion().noteExplanationDelivered();
      }

      // EMOTION carries only how the robot reacts and is sent BEFORE the
      // caption (an emotion change clears a caption that is not set yet); the
      // caption hold keeps the answer readable for its full length.
      const captionMs = captionHoldMs(text);
      emitEmotion(failed ? 'ERROR' : 'SPEAKING', {
        intensity: failed ? 0.8 : 0.9,
        duration: captionMs
      });
      const holdMs = pipeline.getCompanion().speakLine(text) || captionMs;

      aetherChannel.appendLine(`[${askLabels[source] ?? 'ASK'}] ${trimmed}`);
      aetherChannel.appendLine(`[EVE] ${text}`);

      // Return to LISTENING rather than IDLE: the user just spoke.
      if (!failed) {
        setTimeout(() => emitEmotion('LISTENING', { intensity: 0.5 }), holdMs + 400);
      }

      companionPanel.refresh('explicit ask answered');
      return { text, failed };
    }

    // ────────────────────────────────────────────────────────────────────
    // BOTX COMPANION PANEL — compact VS Code-native status strip for Brain
    // state. A read-only view over existing state; it holds no buttons and
    // calls no commands. The floating Eve popup is the ONE intervention
    // surface; this panel is status/diagnostics only.
    // ────────────────────────────────────────────────────────────────────
    const companionPanel = new CompanionPanel({
      pipeline,
      extensionUri: context.extensionUri,
      // The canonical body is the floating Eve window attached over the
      // WebSocket link, so the default client-count signal is the truthful
      // one here: no client means no Eve.
    });
    context.subscriptions.push(companionPanel);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(CompanionPanel.viewType, companionPanel, {
        webviewOptions: { retainContextWhenHidden: true }
      })
    );
    statusBar.setMonitoring(pipeline.getCompanion().isMonitoringEnabled());

    // ────────────────────────────────────────────────────────────────────
    // ACE.X ADVISORY + EMBODIMENT
    //
    // The user model, project coordination, agents, synthesis and ACES reason
    // over the existing pipeline without replacing it. The canonical Eve is
    // the floating Electron window, fed over the WebSocket link; the Robot
    // State Publisher additionally feeds the STATE_SYNC handshake snapshot.
    // The Webview robot classes remain available for diagnostics only and are
    // not wired into the default experience.
    // ────────────────────────────────────────────────────────────────────
    // All concrete sensors, started exactly once behind the eleven logical
    // capabilities. Existing sensors keep their listeners and payloads; the
    // coordinator only adds publishers for capabilities that had none.
    const sensors = new SensorCoordinator(eventFilter, pipeline.getBehaviour());
    sensors.start(context);

    const userModel = new UserModel(pipeline.getLearning(), context);
    const projectCoordinator = new LocalProjectCoordinator(() => sessionManager.current());
    const aceSystem = new AceSystem(
      {
        contextEngine: pipeline.getContext(),
        learning: pipeline.getLearning(),
        userModel,
        coordinator: projectCoordinator,
        identity: () => sessionManager.current(),
        pipelineStats: () => pipeline.getStats(),
        sensorHealth: () => sensors.health(),
        eventQueueSize: () => eventFilter.getQueue().size(),
      },
      userModel,
      projectCoordinator
    );
    pipeline.setAcesAdvisor((ctx) => aceSystem.adviseForContext(ctx)?.decision);

    const robotState = new RobotStatePublisher();
    robotState.start();
    context.subscriptions.push({ dispose: () => robotState.dispose() });
    // A reconnecting Eve receives the current canonical state, never a replay
    // of stale motion: the snapshot is read live at handshake time.
    setStateSnapshotProvider(() => [
      ...robotState.latestPayloadTypes(),
      ...(chatOpen ? [{ type: 'CHAT_OPEN' as const }] : []),
      ...explicitResponses.values(),
    ]);
    // The popup bar's structured issue evidence, read live from the same Brain
    // state the panel renders: current issue joined with its diagnostic, the
    // latest teaching rung, skill-driven verbosity, and verified resolutions.
    robotState.setIssueProvider(() => {
      const snapshot = pipeline.getCompanion().getStateSnapshot();
      const primary = snapshot.diagnostics.find((d) => d.severity === 'Error') ?? snapshot.diagnostics[0] ?? null;
      const issue = snapshot.issue && primary
        ? {
          matter: snapshot.issue.matter,
          concept: snapshot.issue.concept,
          symbol: snapshot.issue.symbol ?? undefined,
          recurrence: snapshot.issue.recurrence,
          recurring: snapshot.issue.recurring,
          file: primary.file,
          fileName: primary.fileName,
          line: primary.line + 1,
          severity: primary.severity,
          message: primary.message,
          teachingLevel: snapshot.teaching.level,
          verbose: snapshot.learning.skill === 'BEGINNER',
        }
        : null;
      return {
        issue,
        resolution: snapshot.resolution
          ? {
            verified: snapshot.resolution.verified,
            headline: snapshot.resolution.headline,
            takeaway: snapshot.resolution.takeaway,
            via: snapshot.resolution.via,
            at: (snapshot.resolution as { at?: number }).at ?? Date.now(),
          }
          : null,
        voiceEnabled: pipeline.getCompanion().getVoiceEnabled(),
      };
    });
    aceSystem.setWebviewHealthProvider(() => {
      const health = sensors.getWebviewIpc().health();
      return { inbound: health.inbound, outbound: health.outbound, lastOutboundAt: health.lastOutboundAt };
    });

    // ────────────────────────────────────────────────────────────────────
    // GROUNDED CONTEXT READERS
    //
    // Two small bridges from VS Code into Brain state, both read-only and both
    // answering exactly one question each. Neither stores anything.
    //
    // 1. Live file text, so the companion can tell whether a name is assigned
    //    before the line that uses it instead of guessing. The text is read on
    //    demand and never persisted; with no open document the reader simply
    //    returns undefined and the companion makes no claim.
    // 2. The shared attention target, drawn in the editor by CodeSpotlight, so
    //    the developer sees the same thing the Robot Body is looking at.
    // ────────────────────────────────────────────────────────────────────
    pipeline.getCompanion().setSourceTextReader((file: string) => {
      // Only OPEN, saved documents are read. A dirty buffer is skipped because its
      // text is mid-edit and would make the companion reason about a state the
      // developer has not committed to; a file that is not open at all simply
      // yields undefined, and the companion then makes no claim about it rather
      // than guessing. Nothing is persisted.
      for (const document of vscode.workspace.textDocuments) {
        if (document.fileName === file && !document.isDirty) {
          return document.getText();
        }
      }
      return undefined;
    });

    // The editor highlight is kept in step with the Brain's shared attention
    // target by the panel's own refresh, which every diagnostic event already
    // triggers; this call covers the initial state.
    companionPanel.sync();

    function updateStatusBarDiagnostics(): void {
      const editor = vscode.window.activeTextEditor;
      if (!editor || isOutputDocument(editor.document)) {
        statusBar.setErrors(0);
        return;
      }
      const diags = vscode.languages.getDiagnostics(editor.document.uri);
      const errorCount = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
      statusBar.setErrors(errorCount);
    }

    // ────────────────────────────────────────────────────────────────────
    // Wire WebSocket messages from Body → Brain
    // ────────────────────────────────────────────────────────────────────
    onRobotMessage((data) => {
      if (!data || typeof data.type !== 'string') {
        return;
      }
      // Handle chat messages from the companion UI
      if (data.type === 'CHAT_MESSAGE' && typeof data.text === 'string') {
        const text = data.text.trim();
        if (!text) {
          return;
        }
        const requestId = String(data.requestId ?? '');
        if (!requestId) { return; }
        const previous = explicitResponses.get(requestId);
        if (previous) { sendToRobot(previous); return; }
        if (chatBusy) {
          respond({ type: 'EVE_RESPONSE', kind: 'chat', requestId, status: 'error', text: 'Please wait for the current answer before sending another message.' });
          return;
        }
        const parsed = parseCommand(text);
        const skillLevel = pipeline.getLearning().getSkillLevel();
        if (parsed.kind === 'ordinary' && isArtifactFollowUp(text) && !activeExplanationContext) {
          respond({ type: 'EVE_RESPONSE', kind: 'chat', requestId, status: 'error', text: missingContextMessage(text) });
          return;
        }
        if (parsed.kind === 'command') {
          chatBusy = true;
          respond({ type: 'EVE_RESPONSE', kind: 'chat', requestId, status: 'loading', text: parsed.command ? `Recognized #${parsed.command.replace('_', ' ')}…` : 'Checking command…' });
          void (async () => {
            try {
              const reply = await routeCommand(parsed, {
                chat: (question) => askEveFlow(question, 'body'),
                ask: async (question, useEditorContext) => {
                  const editor = vscode.window.activeTextEditor;
                  let codeContext: string | undefined;
                  if (useEditorContext && editor && !isOutputDocument(editor.document)) {
                    const doc = editor.document;
                    const range = editor.selection.isEmpty
                      ? new vscode.Range(Math.max(0, editor.selection.active.line - 10), 0, Math.min(doc.lineCount - 1, editor.selection.active.line + 10), doc.lineAt(Math.min(doc.lineCount - 1, editor.selection.active.line + 10)).text.length)
                      : editor.selection;
                    codeContext = `Current code in ${doc.fileName} (${doc.languageId}), lines ${range.start.line + 1}-${range.end.line + 1}:\n${doc.getText(range).slice(0, 6000)}`;
                  }
                   const validationEvidence = conversation.filter((entry) => entry.startsWith('Validation evidence')).slice(-1)[0];
                   const grounded = activeExplanationContext
                     ? buildGroundedContext(activeExplanationContext, skillLevel)
                     : [codeContext, validationEvidence].filter(Boolean).join('\n\n') || undefined;
                  const answer = await askEveFlow(`${buildAdaptiveGuidance(skillLevel)}\n${question}`, 'body', grounded);
                  conversation.length = 0;
                  conversation.push(`User: ${parsed.originalText}\n${codeContext ?? ''}`, `Eve: ${answer.text}`);
                  return answer;
                },
                fix: async () => {
                  const editor = vscode.window.activeTextEditor;
                  if (!editor || isOutputDocument(editor.document) || !vscode.languages.getDiagnostics(editor.document.uri).some(d => d.severity === vscode.DiagnosticSeverity.Error)) {
                    return { failed: true, text: 'Open the file containing an error diagnostic before using #fix this. No changes were made.' };
                  }
                  // The established command owns all approvals and outcome UI.
                  await vscode.commands.executeCommand('botx.fixWithEve');
                  return { failed: false, text: 'The Fix workflow has returned. See its VS Code approval and verification messages for the outcome; this acknowledgment does not claim a fix was applied or verified.' };
                },
                whatChanged: () => {
                  const resolution = pipeline.getCompanion().getStateSnapshot().resolution;
                  return { failed: false, text: resolution ? `${resolution.headline}\n${resolution.takeaway}` : "I haven't recorded an applied fix in this session." };
                },
                 write: async (writeCommand) => {
                  const editor = vscode.window.activeTextEditor;
                  if (!editor || isOutputDocument(editor.document)) {
                    return { failed: true, text: 'Open the destination editor before using #write. No file was created and no code was inserted.' };
                  }
                  const language = writeCommand.language ?? ({ python: 'python', javascript: 'javascript', typescript: 'typescript', java: 'java', c: 'c', cpp: 'cpp', csharp: 'csharp', go: 'go', rust: 'rust', kotlin: 'kotlin', ruby: 'ruby', php: 'php', swift: 'swift', dart: 'dart', sql: 'sql', shell: 'shell' } as Record<string, any>)[editor.document.languageId];
                  if (!language) {
                    return { failed: true, text: 'Specify a supported language, for example #write py code to check prime. No code was inserted.' };
                  }
                  const replaceSelection = !editor.selection.isEmpty && /\b(edit|replace|rewrite|refactor|change|update)\b/i.test(writeCommand.instruction);
                  const snapshot = captureWriteTarget(editor, replaceSelection);
                  const contextRange = editor.selection.isEmpty
                    ? new vscode.Range(Math.max(0, editor.selection.active.line - 10), 0, Math.min(editor.document.lineCount - 1, editor.selection.active.line + 10), editor.document.lineAt(Math.min(editor.document.lineCount - 1, editor.selection.active.line + 10)).text.length)
                    : editor.selection;
                  const context = editor.document.getText(contextRange).slice(0, 6000);
                  return vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Eve is generating ${language}…`, cancellable: true },
                    async (_progress, token) => {
                      emitLifecycleState('WRITING');
                      const abort = new AbortController();
                      const cancellation = token.onCancellationRequested(() => abort.abort());
                      let generated;
                      try {
                        generated = await generateCode(writeCommand.instruction, language, context, abort.signal);
                      } finally {
                        cancellation.dispose();
                      }
                      if (token.isCancellationRequested) { emitLifecycleState('FAILURE'); return { failed: true, text: 'Code generation was cancelled. No code was inserted.' }; }
                      if (generated.failed) { emitLifecycleState('FAILURE'); return { failed: true, text: `Code generation failed: ${generated.error ?? 'the provider did not return code'}` }; }
                      const validated = validateGeneratedCode(generated.code, language);
                      if (!validated.valid) { emitLifecycleState('FAILURE'); return { failed: true, text: `Generated code was rejected: ${validated.error}` }; }
                      if (vscode.window.activeTextEditor?.document.uri.toString() !== snapshot.uri) { emitLifecycleState('FAILURE'); return { failed: true, text: 'The active editor changed while Eve was generating code. No code was inserted.' }; }
                      const result = await insertGeneratedCode(editor, snapshot, validated.code);
                      if (!result.applied) { emitLifecycleState('FAILURE'); return { failed: true, text: result.reason ?? 'No code was inserted.' }; }
                      const location = replaceSelection ? 'replaced the selected code' : `inserted at line ${snapshot.selection.active.line + 1}`;
                      activeExplanationContext = {
                        taskId: `write-${Date.now().toString(36)}`,
                        file: editor.document.fileName,
                        language,
                        code: validated.code,
                        selectedLines: replaceSelection ? snapshot.selectedText : undefined,
                        lineStart: snapshot.selection.active.line + 1,
                        lineEnd: snapshot.selection.active.line + validated.code.split(/\r?\n/).length,
                        diff: `${replaceSelection ? snapshot.selectedText : '(cursor insertion)'}\n→\n${validated.code}`,
                      };
                      emitLifecycleState('SUCCESS');
                      return { failed: false, text: `Generated and inserted ${language} code: ${location}. The edit was applied to ${editor.document.fileName}; it was not executed or tested. Ask “Explain the loop” or “Why did you use this?” for a grounded explanation.` };
                    },
                   );
                 },
                 validate: async (testCommand) => {
                   const editor = vscode.window.activeTextEditor;
                   if (!editor || isOutputDocument(editor.document)) {
                     return { failed: true, text: 'Open a workspace source file before requesting validation. Nothing was executed.' };
                   }
                   if (!vscode.workspace.isTrusted || !workspaceRoot || !safeExecutor) {
                     return { failed: true, text: 'No workspace is open, so Eve cannot select a project validation command.' };
                   }
                   const plan = planValidation({ filePath: editor.document.fileName, languageId: editor.document.languageId, workspaceRoot });
                   if (editor.document.isDirty || editor.document.uri.scheme !== 'file') {
                     return { failed: true, text: 'Save this workspace file before validation. Nothing was executed.' };
                   }
                   const validationVersion = editor.document.version;
                   if (!plan) {
                     return { failed: true, text: `Eve could not find a configured safe validation strategy for ${editor.document.languageId}. No command was executed.` };
                   }
                   const proposal = `${plan.label}: ${plan.executable} ${plan.args.join(' ')}\nWorking directory: ${plan.cwd}`;
                   {
                     const choice = await vscode.window.showWarningMessage(`Approve validation?\n${proposal}`, { modal: true }, 'Run validation', 'Cancel');
                     if (choice !== 'Run validation') {
                       return { failed: true, text: 'Validation was cancelled. No command was executed.' };
                     }
                   }
                   if (editor.document.version !== validationVersion || editor.document.isDirty) {
                     return { failed: true, text: 'Source changed while approval was pending. Nothing was executed.' };
                   }
                   const requestId = `validation-${Date.now().toString(36)}`;
                   const result = await vscode.window.withProgress(
                     { location: vscode.ProgressLocation.Notification, title: `Eve is running ${plan.label}…`, cancellable: true },
                     async (_progress, token) => {
                       const cancellation = token.onCancellationRequested(() => { safeExecutor.cancel(requestId); });
                       try { return await safeExecutor.run(requestId, plan, true); } finally { cancellation.dispose(); }
                     },
                   );
                   const evidence = [result.detail, result.stdout ? `stdout:\n${result.stdout}` : '', result.stderr ? `stderr:\n${result.stderr}` : ''].filter(Boolean).join('\n');
                   if (editor.document.version !== validationVersion || editor.document.isDirty) {
                     return { failed: true, text: `Source changed during validation. Results do not validate the current buffer.\n${evidence}` };
                   }
                   conversation.push(`Validation evidence for ${editor.document.fileName}: ${result.state}\n${evidence.slice(0, 8000)}`);
                   if (result.state === 'TESTED' || result.state === 'EXECUTED') {
                     activeExplanationContext = { taskId: requestId, file: editor.document.fileName, language: editor.document.languageId, code: editor.document.getText().slice(0, 12000), lineStart: 1, lineEnd: editor.document.lineCount };
                     return { failed: false, text: `${plan.label} completed with exit code ${String(result.exitCode)}. This is actual validation evidence; it does not prove every behavior is correct.\n${evidence}` };
                   }
                   return { failed: true, text: `Validation did not succeed (${result.state}).\n${evidence}` };
                 },
               });
              respond({ type: 'EVE_RESPONSE', kind: 'chat', requestId, status: reply.failed ? 'error' : 'success', text: reply.text });
            } catch (error) {
              respond({ type: 'EVE_RESPONSE', kind: 'chat', requestId, status: 'error', text: String(error) });
            } finally { chatBusy = false; }
          })();
          return;
        }
        if (chatBusy) {
          respond({ type: 'EVE_RESPONSE', kind: 'chat', requestId, status: 'error', text: 'Please wait for the current answer before sending another message.' });
          return;
        }
        chatBusy = true;
        respond({ type: 'EVE_RESPONSE', kind: 'chat', requestId, status: 'loading', text: 'Thinking…' });
        void (async () => {
          try {
            // Gather editor context for ALL chat messages to improve explanation quality
            const editor = vscode.window.activeTextEditor;
            let codeContext: string | undefined;
            let editorContext: string | undefined;
            if (editor && !isOutputDocument(editor.document)) {
              const doc = editor.document;
              const range = editor.selection.isEmpty
                ? new vscode.Range(Math.max(0, editor.selection.active.line - 15), 0, Math.min(doc.lineCount - 1, editor.selection.active.line + 15), doc.lineAt(Math.min(doc.lineCount - 1, editor.selection.active.line + 15)).text.length)
                : editor.selection;
              const selectedCode = doc.getText(range).slice(0, 6000);
              codeContext = `Current code in ${doc.fileName} (${doc.languageId}), lines ${range.start.line + 1}-${range.end.line + 1}:\n${selectedCode}`;

              // Also include diagnostics for the current file
              const diags = vscode.languages.getDiagnostics(doc.uri);
              const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
              const warnings = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);
              if (errors.length > 0 || warnings.length > 0) {
                const diagLines = [...errors, ...warnings].slice(0, 5).map(d =>
                  `${d.range.start.line + 1}:${d.range.start.character + 1} [${d.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning'}] ${d.message.slice(0, 200)}`
                );
                editorContext = `Active diagnostics (${errors.length} errors, ${warnings.length} warnings):\n${diagLines.join('\n')}`;
              }
            }

            const followUp = /^(why\b|explain (that|this)\b|how would you fix|what changed|what did you change|and\b|but\b)/i.test(text);
            const followUpPrefix = followUp
              ? (activeExplanationContext ? buildGroundedContext(activeExplanationContext, skillLevel) : conversation.slice(-8).join('\n\n') || issuePromptPrefix())
              : undefined;

            // Combine all available context
            const contextParts = [
              followUpPrefix,
              codeContext,
              editorContext
            ].filter(Boolean);
            const prefix = contextParts.length > 0 ? contextParts.join('\n\n') : undefined;

            const resolution = pipeline.getCompanion().getStateSnapshot().resolution;
            const reply = /^what (changed|did you change)/i.test(text)
              ? { text: resolution ? `${resolution.headline}\n${resolution.takeaway}` : "I haven't recorded an applied fix in this session.", failed: false }
              : await askEveFlow(`${buildAdaptiveGuidance(skillLevel)}\n${text}`, 'body', prefix);
            if (!followUp) { conversation.length = 0; }
            conversation.push(`User: ${text}`, `Eve: ${reply.text}`);
            if (conversation.length > 16) { conversation.splice(0, conversation.length - 16); }
            respond({ type: 'EVE_RESPONSE', kind: 'chat', requestId, status: reply.failed ? 'error' : 'success', text: reply.text });
          } catch (error) {
            respond({ type: 'EVE_RESPONSE', kind: 'chat', requestId, status: 'error', text: String(error) });
          } finally { chatBusy = false; }
        })();
        return;
      }
      if (data.type === 'EXPLAIN_REQUEST' && typeof data.requestId === 'string') {
        const requestId = data.requestId;
        const prior = explicitResponses.get(requestId);
        if (prior) { sendToRobot(prior); return; }
        const file = typeof data.file === 'string' ? data.file : '';
        const line = typeof data.line === 'number' ? data.line : 0;
        const message = typeof data.message === 'string' ? data.message : '';
        const severity = typeof data.severity === 'string' ? data.severity : '';
        const issueKey = JSON.stringify([file, line, message, severity]);
        const frame = { type: 'EVE_RESPONSE' as const, kind: 'explain' as const, requestId, issueKey };
        respond({ ...frame, status: 'loading', text: 'Explaining…' });
        void (async () => {
          try {
            if (!file || !Number.isInteger(line) || line < 1 || !message) { throw new Error('This popup has no diagnostic context to explain.'); }
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            if (line > document.lineCount) { throw new Error('The issue line no longer exists. Refresh the diagnostic and try again.'); }
            const lines = document.getText().split(/\r?\n/);
            const languageId = document.languageId;

            // Gather broader context for better explanations
            const contextStart = Math.max(0, line - 30);
            const contextEnd = Math.min(lines.length - 1, line + 30);
            const surroundingCode = lines.slice(contextStart, contextEnd + 1).map((value, index) => `${contextStart + index + 1}: ${value}`).join('\n').slice(0, 8000);

            // Get all diagnostics for this file
            const allDiags = vscode.languages.getDiagnostics(document.uri);
            const allErrors = allDiags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
            const allWarnings = allDiags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);
            const diagSummary = allErrors.length > 0 || allWarnings.length > 0
              ? `All diagnostics in this file (${allErrors.length} errors, ${allWarnings.length} warnings):\n` +
                [...allErrors, ...allWarnings].slice(0, 8).map(d =>
                  `  Line ${d.range.start.line + 1}: [${d.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning'}] ${d.message.slice(0, 200)}`
                ).join('\n')
              : '';

            const start = Math.max(0, line - 6);
            const code = lines.slice(start, line + 5).map((value, index) => `${start + index + 1}: ${value}`).join('\n').slice(0, 6000);
            activeExplanationContext = {
              taskId: `diagnostic-${requestId}`,
              file,
              language: languageId,
              code,
              lineStart: start + 1,
              lineEnd: Math.min(lines.length, line + 5),
              diagnostic: { message, severity, line },
            };
            const question = `Explain this reported diagnostic: what it means, why it occurs, which supplied code or condition causes it, and how to address it. Distinguish evidence from uncertainty.\nFile: ${file}:${line}\nLanguage: ${languageId}\nSeverity: ${severity}\nDiagnostic: ${message}\nSource context (current buffer, lines ${contextStart + 1}-${contextEnd + 1}):\n${surroundingCode}\n${diagSummary}`;
            const reply = await askEveFlow(question, 'body');
            conversation.push(`Issue: ${file}:${line} ${message}\n${code}`, `Eve: ${reply.text}`);
            if (conversation.length > 16) { conversation.splice(0, conversation.length - 16); }
            respond({ ...frame, status: reply.failed ? 'error' : 'success', text: reply.text });
          } catch (error) {
            respond({ ...frame, status: 'error', text: error instanceof Error ? error.message : String(error) });
          }
        })();
        return;
      }
      // Structured intents from Eve's popup bar. They carry the popup's own
      // issue identity (matter/file/line), which becomes the preferred target
      // for the existing pipelines — never a generic request.
      //
      // NOTE: EXPLAIN_REQUEST frames carrying a string requestId are always
      // consumed by the direct explain path above (which returns early), so
      // this branch only sees FIX_REQUEST frames and EXPLAIN_REQUEST frames
      // without a requestId (legacy popup intents). Matching both types here
      // without the guard made the popup-Explain path unreachable.
      if ((data.type === 'FIX_REQUEST' || (data.type === 'EXPLAIN_REQUEST' && typeof (data as Record<string, unknown>)['requestId'] !== 'string')) && typeof data === 'object') {
        const record = data as Record<string, unknown>;
        const target: IssueTarget = {
          file: typeof record['file'] === 'string' ? String(record['file']) : undefined,
          line: typeof record['line'] === 'number' ? Number(record['line']) : undefined,
          matter: typeof record['matter'] === 'string' ? String(record['matter']) : undefined,
        };
        Logger.info('WEBSOCKET', {
          Event: data.type === 'EXPLAIN_REQUEST' ? 'Explain requested for popup issue' : 'Fix requested for popup issue',
          File: target.file ?? '',
          Line: String(target.line ?? ''),
          Matter: target.matter ?? '',
        });
        void (async () => {
          if (await revealIssueTarget(target)) {
            pendingIssueTarget = target;
          }
          if (data.type === 'EXPLAIN_REQUEST' && typeof record['requestId'] === 'string') {
            pendingExplainRequest = {
              requestId: String(record['requestId']),
              file: target.file,
              line: target.line,
              message: typeof record['message'] === 'string' ? String(record['message']) : undefined,
              severity: typeof record['severity'] === 'string' ? String(record['severity']) : undefined,
            };
          }
          await vscode.commands.executeCommand(data.type === 'EXPLAIN_REQUEST' ? 'botx.explainError' : 'botx.fixWithEve');
        })();
        return;
      }
      // Handle voice toggle from companion UI
      if (data.type === 'VOICE_TOGGLE' && typeof data.enabled === 'boolean') {
        Logger.info('WEBSOCKET', { Event: 'Voice toggle from Body', Enabled: String(data.enabled) });
        // Update the setting (single source of truth)
        void vscode.workspace.getConfiguration('botx').update('enableVoice', data.enabled, vscode.ConfigurationTarget.Global);
        // Update runtime
        pipeline.getCompanion().setVoiceEnabled(data.enabled);
      }
      // Voice transcript from Eve's microphone: treated as another USER INPUT
      // source and routed through the existing pipelines with the popup's
      // current issue as context. Never applies edits silently.
      if (data.type === 'VOICE_TEXT' && typeof data.text === 'string') {
        const text = data.text.trim();
        if (!text) {
          return;
        }
        Logger.info('WEBSOCKET', { Event: 'Voice transcript from Body', Text: text.slice(0, 80) });
        sensors.getUserInput().record('question', `Voice: ${text.slice(0, 120)}`, 'eve-popup-microphone');
        if (recordUnderstanding(text)) {
          return;
        }
        const issue = currentPopupIssue();
        const command = interpretVoiceCommand(text, issue);
        switch (command.kind) {
          case 'explain_issue':
          case 'retry':
            void vscode.commands.executeCommand('botx.explainError');
            break;
          case 'fix_issue':
            void vscode.commands.executeCommand('botx.fixWithEve');
            break;
          case 'dismiss':
            pipeline.getCompanion().dismissTeaching();
            robotState.noteDismissed();
            sensors.getUserInput().record('rejection', 'Intervention dismissed by voice');
            break;
          case 'what_changed':
            void answerWhatChanged();
            break;
          case 'why_failed':
            void answerWhyFailed();
            break;
          case 'ask':
            void askEveFlow(command.question || text, 'ask', issuePromptPrefix());
            break;
          default:
            break;
        }
      }
      // Popup dismiss from Eve: hides the current popup only. Brain state is
      // untouched; the publisher suppresses exactly this popup content.
      if (data.type === 'USER_DISMISS') {
        pipeline.getCompanion().dismissTeaching();
        robotState.noteDismissed();
        sensors.getUserInput().record('rejection', 'Intervention dismissed from Eve popup');
        Logger.info('WEBSOCKET', { Event: 'Popup dismissed from Body' });
      }
    });

    /**
     * The popup's current-issue context for voice commands ("explain this",
     * "fix it"): the same diagnostic the Brain points its attention at, so a
     * voice command can never act on a different problem than the one shown.
     */
    function currentPopupIssue(): { hasIssue: boolean; file?: string; line?: number; matter?: string; concept?: string; message?: string } {
      const snapshot = pipeline.getCompanion().getStateSnapshot();
      const primary = snapshot.diagnostics.find((d) => d.severity === 'Error') ?? snapshot.diagnostics[0];
      if (!snapshot.issue || !primary) {
        return { hasIssue: false };
      }
      return {
        hasIssue: true,
        file: primary.file,
        line: primary.line,
        matter: snapshot.issue.matter,
        concept: snapshot.issue.concept,
        message: primary.message,
      };
    }

    /**
     * The preferred diagnostic target for the next Explain/Fix command,
     * carried over from the popup that requested it. Consumed once: after the
     * command reads it, later unrelated invocations fall back to the active
     * editor's first error. This is what keeps issue identity attached from
     * popup → action instead of leaking across turns.
     */
    let pendingIssueTarget: IssueTarget | undefined;
    let pendingExplainRequest: { requestId: string; file?: string; line?: number; message?: string; severity?: string } | undefined;

    /** Reveals the popup's file/line so the existing commands act on it. */
    async function revealIssueTarget(target: IssueTarget): Promise<boolean> {
      if (!target.file) {
        return true;
      }
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.file));
        const editor = await vscode.window.showTextDocument(document, { preserveFocus: false });
        if (typeof target.line === 'number' && target.line > 0) {
          const position = new vscode.Position(
            Math.min(target.line - 1, Math.max(0, document.lineCount - 1)),
            0
          );
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
        return true;
      } catch (err) {
        Logger.info('COMMAND', { Event: 'Could not reveal popup issue', Error: String(err) });
        return false;
      }
    }

    /**
     * Short framing that binds a conversational question to the active issue.
     * Only used for Eve-window originated asks (voice/body chat); typed
     * command-palette questions keep the user's exact words.
     */
    function issuePromptPrefix(): string | undefined {
      const issue = currentPopupIssue();
      if (!issue.hasIssue) {
        return undefined;
      }
      const snapshot = pipeline.getCompanion().getStateSnapshot();
      return buildIssuePromptPrefix({
        file: issue.file,
        line: issue.line,
        message: issue.message,
        concept: issue.concept,
        skillLevel: snapshot.learning.skill,
      });
    }

    /**
     * Gentle learning signal for "I understand"-style turns. Records a small
     * success for the active issue's concept through the existing adaptive
     * learner — which by design never radically changes a profile from one
     * observation. Returns true when the text was an acknowledgment.
     */
    function recordUnderstanding(text: string): boolean {
      if (!isAcknowledgment(text)) {
        return false;
      }
      const issue = currentPopupIssue();
      if (!issue.hasIssue || !issue.concept) {
        return true;
      }
      aceSystem.getAdaptiveLearning().recordUserOutcome({ concept: issue.concept, success: true });
      Logger.info('LEARNING', { Event: 'Understanding acknowledged in conversation', Concept: issue.concept });
      sensors.getUserInput().record('feedback', `Understood: ${issue.concept}`);
      return true;
    }

    /** One deterministic spoken+caption line for conversational answers. */
    function sayLine(text: string): void {
      emitEmotion('SPEAKING', { intensity: 0.85, duration: captionHoldMs(text) });
      pipeline.getCompanion().speakLine(text);
      Logger.info('COMMAND', { Event: 'Eve conversational answer', Text: text.slice(0, 120) });
    }

    /** "What did you change?" — answered only from the recorded fix outcome. */
    async function answerWhatChanged(): Promise<void> {
      const resolution = pipeline.getCompanion().getStateSnapshot().resolution;
      const described = describeLastChange(
        resolution
          ? {
            verified: resolution.verified,
            takeaway: resolution.takeaway,
            change: (resolution as { change?: string }).change,
            fileName: undefined,
            line: undefined,
          }
          : null
      );
      if (!described) {
        sayLine("I haven't applied any fix yet. Tell me what you're working on, or pick an issue for me to explain.");
        return;
      }
      sayLine(described);
    }

    /** "Why did it fail?" — answered only from the recorded verification. */
    async function answerWhyFailed(): Promise<void> {
      const resolution = pipeline.getCompanion().getStateSnapshot().resolution;
      if (resolution && !resolution.verified) {
        sayLine(`${resolution.takeaway} Want me to take another look at it?`);
        return;
      }
      sayLine('No fix has failed recently. The last change I tracked was verified.');
    }

    // Communication channel: captions by default; TTS is opt-in and degrades
    // to captions when no speech engine is registered.
    pipeline.getCompanion().setVoiceEnabled(vscode.workspace.getConfiguration('botx').get<boolean>('enableVoice', false));

    // ── Settings → runtime. CompanionLoop is the single source of truth for
    // teaching/monitoring at runtime; VS Code configuration is the single
    // source of truth for persistence. Each line below mirrors one into the
    // other exactly once — no second flag lives anywhere in this file.
    const botxConfig = () => vscode.workspace.getConfiguration('botx');

    const teachingMode = botxConfig().get<boolean>('teachingMode', true);
    pipeline.getCompanion().setTeachingEnabled(teachingMode);

    const monitoringEnabled = botxConfig().get<boolean>('monitoring', true);
    pipeline.getCompanion().setMonitoringEnabled(monitoringEnabled);
    if (!monitoringEnabled) {
      pipeline.getBehaviour().disable();
    }

    pipeline.getCompanion().setAutoExplainEnabled(botxConfig().get<boolean>('autoExplainErrors', true));
    pipeline.getCompanion().setInteractionCooldown(botxConfig().get<number>('cooldownSeconds', 30));

    const verbosity = botxConfig().get<string>('verbosity', 'AUTO') as 'AUTO' | 'CONCISE' | 'BALANCED' | 'DETAILED';
    pipeline.getLearning().setVerbosityMode(verbosity);
    pipeline.refreshPromptContext();

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('botx.enableVoice')) {
          // The setting is the source of truth; this is the single mirror
          // point into the voice runtime and the Eve popup mic state. There
          // is no status-bar or panel voice control to update.
          const enabled = vscode.workspace.getConfiguration('botx').get<boolean>('enableVoice', false);
          pipeline.getCompanion().setVoiceEnabled(enabled);
          companionPanel.refresh('voice setting changed');
        }
        if (e.affectsConfiguration('botx.teachingMode')) {
          const enabled = vscode.workspace.getConfiguration('botx').get<boolean>('teachingMode', true);
          const changed = pipeline.getCompanion().setTeachingEnabled(enabled);
          if (changed) {
            vscode.window.showInformationMessage(
              enabled ? 'Ace.X: teaching mode on — Eve will nudge, hint and explain.' : 'Ace.X: teaching mode off — Eve observes silently.'
            );
          }
        }
        if (e.affectsConfiguration('botx.monitoring')) {
          const enabled = vscode.workspace.getConfiguration('botx').get<boolean>('monitoring', true);
          applyMonitoring(enabled, 'settings');
        }
        if (e.affectsConfiguration('botx.autoExplainErrors')) {
          pipeline.getCompanion().setAutoExplainEnabled(
            vscode.workspace.getConfiguration('botx').get<boolean>('autoExplainErrors', true)
          );
        }
        if (e.affectsConfiguration('botx.cooldownSeconds')) {
          pipeline.getCompanion().setInteractionCooldown(
            vscode.workspace.getConfiguration('botx').get<number>('cooldownSeconds', 30)
          );
        }
        if (e.affectsConfiguration('botx.verbosity')) {
          const mode = vscode.workspace.getConfiguration('botx').get<string>('verbosity', 'AUTO') as 'AUTO' | 'CONCISE' | 'BALANCED' | 'DETAILED';
          pipeline.getLearning().setVerbosityMode(mode);
          // The resolved length must reach Gemini prompt construction, not
          // merely live in the profile.
          pipeline.refreshPromptContext();
          vscode.window.showInformationMessage(`Ace.X: explanation verbosity set to ${mode}.`);
        }
      })
    );

    /**
     * Applies Monitoring ON/OFF everywhere it lives: CompanionLoop (passive
     * observation + teaching gates), BehaviourController (passive expression),
     * and the persisted botx.monitoring setting. Explicit commands never check
     * any of these, and no learning state is touched.
     */
    function applyMonitoring(enabled: boolean, source: 'command' | 'settings'): void {
      const changed = pipeline.getCompanion().setMonitoringEnabled(enabled);
      if (enabled) {
        pipeline.getBehaviour().enable();
      } else {
        pipeline.getBehaviour().disable();
      }
      // One flag, two surfaces: the footer item and the BotX panel.
      statusBar.setMonitoring(enabled);
      companionPanel.refresh('monitoring applied');
      if (changed && source === 'settings') {
        vscode.window.showInformationMessage(
          enabled ? 'Ace.X: monitoring on — Eve is observing again.' : 'Ace.X: monitoring paused — Eve only responds when asked.'
        );
      }
      Logger.info('CONFIG', { Event: 'monitoring applied', Enabled: String(enabled), Source: source });
    }

    // Wire Decision Engine → output channel (the Robot Body is driven through
    // the WebSocket protocol by BehaviourController/MotionController, not here)
    pipeline.getDecision().getPublisher().subscribe((decision) => {
      aetherChannel.appendLine(`[DECISION] ${decision.type} — ${decision.reason}`);
    });

    // Wire Explanation Engine → output channel
    pipeline.getExplanation().getPublisher().subscribe((explanation) => {
      aetherChannel.appendLine(
        `[EXPLANATION] ${explanation.shortText} (confidence ${explanation.confidence.toFixed(2)}, ${explanation.expression})`
      );
    });
    context.subscriptions.push({ dispose: () => pipeline.getExplanation().getPublisher().clear() });

    // Brain Monitor — periodic health reports to Aether Brain output channel
    const brainMonitor = new BrainMonitor(aetherChannel, pipeline);
    brainMonitor.start();
    context.subscriptions.push({ dispose: () => brainMonitor.stop() });

    // Feedback Loop — monitors pipeline execution success
    const feedbackLoop = new FeedbackLoop(pipeline);
    feedbackLoop.start();
    context.subscriptions.push({ dispose: () => feedbackLoop.dispose() });

    // ────────────────────────────────────────────────────────────────────
    // COMMAND HANDLERS — bound to package.json contributes.commands
    // ────────────────────────────────────────────────────────────────────
    context.subscriptions.push(
      vscode.commands.registerCommand('botx.explainError', async () => {
        const responseRequest = pendingExplainRequest;
        pendingExplainRequest = undefined;
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          if (responseRequest) { respond({ type: 'EVE_RESPONSE', kind: 'explain', requestId: responseRequest.requestId, status: 'error', text: 'No active editor is available for this explanation.' }); }
          vscode.window.showInformationMessage('No active editor to explain.');
          return;
        }
        const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
        const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
        if (errors.length === 0) {
          if (responseRequest) { respond({ type: 'EVE_RESPONSE', kind: 'explain', requestId: responseRequest.requestId, status: 'error', text: 'This diagnostic is no longer present. Refresh the issue and try again.' }); }
          vscode.window.showInformationMessage('No errors found in the current file.');
          return;
        }
        Logger.info('COMMAND', { Event: 'explainError triggered', Errors: String(errors.length) });

        // EXPLICIT request priority: this path never consults teaching mode,
        // monitoring, cooldowns or the repeat-suppression window. It explains
        // the error the user is looking at, right now.
        //
        // When a popup requested this (Explain button / "explain this"), the
        // popup's own issue identity wins over "first error in file", so the
        // explanation can never attach to a different problem. The target is
        // consumed once; a stale target (diagnostic gone) falls back honestly.
        const targetIndex = selectTargetDiagnostic(
          errors.map((d) => ({ message: d.message, line: d.range.start.line, severity: 'Error' })),
          pendingIssueTarget
        );
        pendingIssueTarget = undefined;
        const primary = targetIndex >= 0 ? errors[targetIndex] : errors[0];
        if (targetIndex < 0) {
          Logger.info('COMMAND', { Event: 'Popup issue already resolved; explaining current errors instead' });
        }
        const line = primary.range.start.line;
        const fileName = editor.document.fileName.split(/[\\/]/).pop() || editor.document.fileName;
        const snippet = editor.document.getText(primary.range).slice(0, 400);

        // Gather broader context for better explanations
        const doc = editor.document;
        const fullCode = doc.getText();
        const languageId = doc.languageId;

        // Get surrounding code context (30 lines before and after the error)
        const contextStart = Math.max(0, line - 30);
        const contextEnd = Math.min(doc.lineCount - 1, line + 30);
        const contextRange = new vscode.Range(contextStart, 0, contextEnd, doc.lineAt(contextEnd).text.length);
        const surroundingCode = doc.getText(contextRange).slice(0, 8000);

        // Get selected code if user has a selection
        let selectedCode: string | undefined;
        if (!editor.selection.isEmpty) {
          selectedCode = doc.getText(editor.selection).slice(0, 4000);
        }

        // Get all diagnostics for this file
        const allDiags = vscode.languages.getDiagnostics(doc.uri);
        const allErrors = allDiags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
        const allWarnings = allDiags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);
        const diagSummary = allErrors.length > 0 || allWarnings.length > 0
          ? `All diagnostics in this file (${allErrors.length} errors, ${allWarnings.length} warnings):\n` +
            [...allErrors, ...allWarnings].slice(0, 8).map(d =>
              `  Line ${d.range.start.line + 1}: [${d.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning'}] ${d.message.slice(0, 200)}`
            ).join('\n')
          : '';

        pipeline.getCompanion().noteDirectAsk();

        const question = [
          `Explain this error and how to fix it. Be specific to the code shown.`,
          `File: ${fileName}:${line + 1}`,
          `Error: ${primary.message}`,
          `Language: ${languageId}`,
          surroundingCode ? `Surrounding code (lines ${contextStart + 1}-${contextEnd + 1}):\n${surroundingCode}` : '',
          selectedCode ? `User selection:\n${selectedCode}` : '',
          snippet ? `Error location code: ${snippet}` : '',
          diagSummary,
          errors.length > 1 ? `(${errors.length} errors total in this file.)` : '',
        ].filter(Boolean).join('\n');

        emitEmotion('LISTENING', { intensity: 0.6 });
        const progress = vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: 'Eve is explaining…' },
          () => askEve(question, { verbosity: pipeline.getLearning().getEffectiveVerbosity() })
        );

        const thinkingTimer = setTimeout(() => emitEmotion('THINKING', { intensity: 0.75 }), 400);
        const { text, failed } = await progress;
        clearTimeout(thinkingTimer);

        if (!failed) {
          pipeline.getCompanion().noteExplanationDelivered();
        }

        aetherChannel.appendLine(`[EXPLAIN] ${fileName}:${line + 1} — ${primary.message}`);
        aetherChannel.appendLine(`[EVE] ${text}`);
        aetherChannel.show(true);

        // The answer travels on the canonical CAPTION channel, sized by the
        // existing reading-speed logic; EMOTION only carries the reaction —
        // and must be sent FIRST (an emotion change on the Body clears a caption
        // that has not been set yet), with a hold at least as long as the
        // caption so the emotion release cannot cut the answer short.
        const captionMs = captionHoldMs(text);
        emitEmotion(failed ? 'ERROR' : 'SPEAKING', {
          intensity: failed ? 0.8 : 0.9,
          duration: captionMs,
        });
        const holdMs = pipeline.getCompanion().speakLine(text) || captionMs;
        if (!failed) {
          setTimeout(() => emitEmotion('LISTENING', { intensity: 0.5 }), holdMs + 400);
        }
        Logger.info('COMMAND', { Event: 'explainError delivered', Failed: String(failed) });
        if (responseRequest) {
          respond({
            type: 'EVE_RESPONSE', kind: 'explain', requestId: responseRequest.requestId,
            status: failed ? 'error' : 'success', text,
            issueKey: JSON.stringify([responseRequest.file ?? editor.document.fileName, responseRequest.line ?? line + 1, responseRequest.message ?? primary.message, responseRequest.severity ?? 'Error']),
          });
        }
      })
    );

    // ── BotX panel command. The panel is a compact Brain status strip, so
    // this only reveals the BotX activity-bar view. All acting (Explain /
    // Fix / Dismiss / Voice) lives in the floating Eve popup.
    // ────────────────────────────────────────────────────────────────────
    context.subscriptions.push(
      vscode.commands.registerCommand('botx.openCompanionPanel', async () => {
        try {
          await vscode.commands.executeCommand(`${CompanionPanel.viewType}.focus`);
        } catch (err) {
          Logger.info('COMMAND', { Event: 'openCompanionPanel focus failed', Error: String(err) });
          void vscode.commands.executeCommand('workbench.view.extension.botx');
        }
        Logger.info('COMMAND', { Event: 'openCompanionPanel' });
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('botx.setVoice', async (enabled?: boolean) => {
        const current = vscode.workspace.getConfiguration('botx').get<boolean>('enableVoice', false);
        const next = typeof enabled === 'boolean' ? enabled : !current;
        // `botx.enableVoice` is the ONE source of truth. The configuration
        // listener below is what mirrors it into the companion, the status bar
        // and the panel — this command only writes it.
        await vscode.workspace.getConfiguration('botx')
          .update('enableVoice', next, vscode.ConfigurationTarget.Global);
        Logger.info('COMMAND', { Event: 'setVoice', Enabled: String(next) });
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('botx.toggleVoice', async () => {
        const current = vscode.workspace.getConfiguration('botx').get<boolean>('enableVoice', false);
        await vscode.commands.executeCommand('botx.setVoice', !current);
      })
    );

    // The canonical Eve is the floating window: show/hide/restart/focus
    // operate on it. Invoking show twice never creates a second window —
    // the process manager owns exactly one body process and the Electron app
    // holds a single-instance lock that focuses the existing window.
    function requireEveLink(): boolean {
      if (!robotLinkUp) {
        void vscode.window.showErrorMessage(
          `Ace.X cannot reach Eve: the Brain server is not listening on ${AUTHORITATIVE_ROBOT_PORT}.`
        );
        return false;
      }
      return true;
    }

    function showEve(source: string): void {
      if (!requireEveLink()) {
        return;
      }
      // One entry point: an existing Eve is focused, otherwise exactly one
      // window is created. Invoking show twice never creates a second
      // window — the process manager owns exactly one body process and the
      // Electron app holds a single-instance lock that focuses the existing
      // window.
      const wasRunning = processManager.isRunning();
      ensureEveRunning();
      statusBar.setCompanion(wasRunning ? 'Ace.X: Eve shown' : 'Ace.X: starting Eve…');
      Logger.info('COMMAND', { Event: source, Body: 'floating-eve' });
    }

    context.subscriptions.push(
      vscode.commands.registerCommand('botx.showCompanion', () => {
        showEve('showCompanion');
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('botx.hideCompanion', () => {
        sendToRobot({ type: 'WINDOW_VISIBILITY', visible: false });
        statusBar.setCompanion('Ace.X: Eve hidden');
        Logger.info('COMMAND', { Event: 'hideCompanion' });
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('botx.restartCompanion', () => {
        if (!requireEveLink()) {
          return;
        }
        if (!processManager.isRunning()) {
          ensureEveRunning();
        } else {
          processManager.restartRobotBody();
        }
        statusBar.setCompanion('Ace.X: Eve restarting…');
        Logger.info('COMMAND', { Event: 'restartCompanion', Body: 'floating-eve' });
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('acex.openRobot', () => {
        showEve('acex.openRobot');
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('acex.showEve', () => {
        showEve('acex.showEve');
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('acex.hideEve', () => {
        sendToRobot({ type: 'WINDOW_VISIBILITY', visible: false });
        statusBar.setCompanion('Ace.X: Eve hidden');
        Logger.info('COMMAND', { Event: 'acex.hideEve' });
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('acex.focusEve', () => {
        showEve('acex.focusEve');
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('acex.toggleAlwaysOnTop', () => {
        if (!requireEveLink()) {
          return;
        }
        sendToRobot({ type: 'WINDOW_ALWAYS_ON_TOP' });
        Logger.info('COMMAND', { Event: 'acex.toggleAlwaysOnTop' });
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('acex.resetEvePosition', () => {
        if (!requireEveLink()) {
          return;
        }
        sendToRobot({ type: 'WINDOW_GEOMETRY_RESET' });
        Logger.info('COMMAND', { Event: 'acex.resetEvePosition' });
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('botx.toggleMonitoring', () => {
        const enabled = !pipeline.getCompanion().isMonitoringEnabled();
        applyMonitoring(enabled, 'command');
        // Persist so the next session starts the same way. Configuration is
        // the persistence layer; CompanionLoop is the runtime truth.
        void vscode.workspace.getConfiguration('botx')
          .update('monitoring', enabled, vscode.ConfigurationTarget.Global)
          .then(() => Logger.info('COMMAND', { Event: 'toggleMonitoring', Monitoring: enabled ? 'on' : 'off' }));
        vscode.window.showInformationMessage(
          enabled
            ? 'Ace.X: monitoring on — Eve observes and teaches again. Explicit commands always work.'
            : 'Ace.X: monitoring paused — no passive interruptions or automatic explanations; Ask Companion and Explain Error still work.'
        );
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('botx.setApiKey', async () => {
        const apiKey = await vscode.window.showInputBox({
          prompt: 'Enter your Gemini API key for BotX',
          password: true,
          placeHolder: 'AIza...',
          validateInput: (value) => {
            if (!value || value.trim().length === 0) {return 'API key cannot be empty.';}
            return null;
          }
        });
        if (apiKey) {
          await context.globalState.update('botx.apiKey', apiKey);
          await vscode.workspace.getConfiguration('botx').update('geminiApiKey', apiKey, vscode.ConfigurationTarget.Global);
          Logger.info('COMMAND', { Event: 'setApiKey', Result: 'stored' });
          vscode.window.showInformationMessage('Ace.X: API key saved successfully.');
        }
      })
    );

    /**
     * Ask Companion — the one interactive path to Eve. The user types a question
     * in an input box, the robot thinks, then speaks the answer as its caption.
     * No webview, no chat panel: the companion is the interface, and the answer
     * is also echoed to the output channel so it is copyable and survives the
     * caption timing out.
     */
    context.subscriptions.push(
      vscode.commands.registerCommand('botx.askCompanion', async () => {
        const question = await vscode.window.showInputBox({
          prompt: 'Ask Eve',
          placeHolder: 'e.g. Why is this component re-rendering twice?',
          ignoreFocusOut: true
        });
        if (!question || !question.trim()) {
          return;
        }
        await askEveFlow(question, 'ask');
      })
    );

    /**
     * Chat with Eve — opens a quick input for a free-form question, sends it through
     * the same explicit Ask Companion path so it bypasses passive cooldowns and
     * appears as Eve's caption on the robot.
     */
    context.subscriptions.push(
      vscode.commands.registerCommand('botx.chatWithEve', async () => {
        chatOpen = true;
        showEve('chatWithEve');
        sendToRobot({ type: 'CHAT_OPEN' });
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('botx.replanFix', async () => {
        const editor = vscode.window.activeTextEditor;
        const resolution = pipeline.getCompanion().getStateSnapshot().resolution;
        if (!editor || !resolution || resolution.verified || !resolution.failureEvidence) {
          vscode.window.showInformationMessage('There is no failed verification with grounded evidence to replan.');
          return;
        }
        const issueKey = `${editor.document.uri.toString()}:${resolution.failureEvidence}`;
        const next = beginReplan(replanState, {
          issueKey,
          sourceVersion: editor.document.version,
          failureEvidence: resolution.failureEvidence,
        });
        if (!next.state) {
          vscode.window.showWarningMessage(next.reason ?? 'Replan limit reached.');
          return;
        }
        replanState = next.state;
        replanEvidence = next.state.failureEvidence;
        Logger.info('COMMAND', { Event: 'Bounded fix replan requested', Attempt: String(next.state.attempts), Evidence: next.state.failureEvidence.slice(0, 160) });
        await vscode.commands.executeCommand('botx.fixWithEve');
      })
    );

    /**
     * Fix with Eve — generates a structured fix proposal for the current error,
     * shows a diff preview in VS Code, and applies on user approval.
     * Never silently modifies code — user must explicitly approve.
     */
    context.subscriptions.push(
      vscode.commands.registerCommand('botx.fixWithEve', async () => {
        if (fixInProgress) {
          vscode.window.showInformationMessage('A Fix proposal is already in progress. Wait for its approval or verification result.');
          return;
        }
        fixInProgress = true;
        const releaseFix = () => { fixInProgress = false; };
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          releaseFix();
          vscode.window.showInformationMessage('No active editor to fix.');
          return;
        }
        const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
        const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
        if (errors.length === 0) {
          releaseFix();
          vscode.window.showInformationMessage('No errors found in the current file to fix.');
          return;
        }

        Logger.info('COMMAND', { Event: 'fixWithEve triggered', Errors: String(errors.length) });

        // EXPLICIT request: bypasses all passive gates
        pipeline.getCompanion().noteDirectAsk();

        // Same issue-identity rule as Explain: a popup Fix request targets
        // the popup's own diagnostic (by file + line + matter); anything else
        // falls back to the first error, and an empty file reports honestly.
        const targetIndex = selectTargetDiagnostic(
          errors.map((d) => ({ message: d.message, line: d.range.start.line, severity: 'Error' })),
          pendingIssueTarget
        );
        pendingIssueTarget = undefined;
        const primary = targetIndex >= 0 ? errors[targetIndex] : errors[0];
        const line = primary.range.start.line;
        const fileName = editor.document.fileName.split(/[\\/]/).pop() || editor.document.fileName;
        const filePath = editor.document.fileName;
        const snippet = editor.document.getText(primary.range).slice(0, 500);
        const fullContent = editor.document.getText();

        // Get surrounding context for better fix generation
        const startLine = Math.max(0, line - 10);
        const endLine = Math.min(editor.document.lineCount - 1, line + 10);
        const surroundingRange = new vscode.Range(startLine, 0, endLine, 0);
        const surroundingCode = editor.document.getText(surroundingRange);

        // Check for natural-language coding intent near the error
        const docText = editor.document.getText();
        const langId = editor.document.languageId;
        const codingIntent = hasCodingIntentAtLine(docText, line + 1, langId);

        // EXPLAIN FIRST: generate an explanation first (not a fix)
        const explainQuestion = [
          `Explain this error in plain language.`,
          `File: ${fileName}:${line + 1}`,
          `Error: ${primary.message}`,
          `Code context:\n${surroundingCode}`,
          codingIntent ? `Note: Nearby comment suggests coding intent: "${codingIntent.intentText}"` : '',
          errors.length > 1 ? `(${errors.length} errors total in this file — focusing on the first.)` : '',
        ].filter(Boolean).join('\n');

        emitEmotion('LISTENING', { intensity: 0.6 });

        const progress = vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: 'Eve is explaining…' },
          () => askEve(explainQuestion, { verbosity: pipeline.getLearning().getEffectiveVerbosity() })
        );

        const thinkingTimer = setTimeout(() => emitEmotion('THINKING', { intensity: 0.75 }), 400);
        const { text: explainText, failed: explainFailed } = await progress;
        clearTimeout(thinkingTimer);

        if (explainFailed) {
          releaseFix();
          const captionMs = captionHoldMs(explainText);
          emitEmotion('ERROR', { intensity: 0.8, duration: captionMs });
          pipeline.getCompanion().speakLine(explainText) || captionMs;
          vscode.window.showErrorMessage(`Explanation failed: ${explainText}`);
          return;
        }

        pipeline.getCompanion().noteExplanationDelivered();

        // Show explanation to user with "Fix with BotX" action
        const explainCaption = pipeline.getCompanion().getStateSnapshot().teaching.level >= 3
          ? explainText
          : `Eve explains: ${explainText}`;

        // Show explanation with "Fix with BotX" button in the panel
        pipeline.getCompanion().getStateSnapshot(); // triggers panel refresh with explanation
        
        // Ask user if they want the fix. Eve waits attentively while the
        // approval decision is pending — approval lives in this modal, never
        // in the popup.
        emitSemanticEmotion('WAITING_FOR_APPROVAL');
        const fixChoice = await vscode.window.showInformationMessage(
          `Eve explained the issue. Want BotX to fix it?`,
          { modal: true },
          'Fix with Ace.X',
          "I'll Try"
        );

        if (fixChoice !== 'Fix with Ace.X') {
          releaseFix();
          sensors.getUserInput().record('rejection', 'Fix proposal declined', `File: ${fileName}:${line + 1}`);
          aceSystem.getAdaptiveLearning().recordIntervention({ matter: `${fileName}:${line + 1}`, accepted: false, action: 'FIX' });
          vscode.window.showInformationMessage('You chose to handle it yourself. Eve will keep watching.');
          emitEmotion('LISTENING', { intensity: 0.5 });
          return;
        }

        // User chose "Fix with BotX" — now generate the fix
                  const fixQuestion = [
          `Generate a precise code fix for this error. Return ONLY the fixed code block.`,
          `File: ${fileName}:${line + 1}`,
          `Error: ${primary.message}`,
          `Code context:\n${surroundingCode}`,
          replanEvidence ? `Previous approved attempt failed verification. Use this actual evidence to produce a materially different proposal:\n${replanEvidence}` : '',
          codingIntent ? `Note: Nearby comment suggests coding intent: "${codingIntent.intentText}"` : '',
          errors.length > 1 ? `(${errors.length} errors total in this file — focusing on the first.)` : '',
        ].filter(Boolean).join('\n');

        emitEmotion('LISTENING', { intensity: 0.6 });

        const fixProgress = vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: 'Eve is preparing a fix…' },
          () => askEve(fixQuestion, { verbosity: 'DETAILED' })
        );

        const fixThinkingTimer = setTimeout(() => emitEmotion('THINKING', { intensity: 0.75 }), 400);
        const { text, failed } = await fixProgress;
        clearTimeout(fixThinkingTimer);

        if (failed) {
          releaseFix();
          const captionMs = captionHoldMs(text);
          emitEmotion('ERROR', { intensity: 0.8, duration: captionMs });
          pipeline.getCompanion().speakLine(text) || captionMs;
          vscode.window.showErrorMessage(`Fix generation failed: ${text}`);
          return;
        }

        pipeline.getCompanion().noteExplanationDelivered();

        // Parse the fix from Eve's response
        const fixMatch = text.match(/```[\w]*\n([\s\S]*?)```/);
        let proposedFix = fixMatch ? fixMatch[1].trim() : text.trim();

        if (!fixMatch) {
          const lines = text.split('\n');
          const codeLines = lines.filter(l => l.trim() && !l.toLowerCase().startsWith('eve:') && !l.toLowerCase().startsWith('here') && !l.toLowerCase().startsWith('this'));
          if (codeLines.length > 2) {
            proposedFix = codeLines.join('\n');
          }
        }

        // Show diff preview
        const originalCode = editor.document.getText(primary.range);
        const originalUri = editor.document.uri;
        const capturedRange = primary.range;
        
        const tempDoc = await vscode.workspace.openTextDocument({
          content: proposedFix,
          language: editor.document.languageId
        });

        const title = `Fix Preview: ${fileName}:${line + 1}`;
        await vscode.commands.executeCommand('vscode.diff', originalUri, tempDoc.uri, title);

        // The diff is on screen: keep the attentive wait (extends the hold
        // rather than restarting it) until the approval lands.
        emitSemanticEmotion('WAITING_FOR_APPROVAL');
        const choice = await vscode.window.showInformationMessage(
          'Apply this fix?',
          { modal: true },
          'Apply Fix',
          'Cancel'
        );

        if (choice === 'Apply Fix') {
          // Approved: Eve is now executing, then verifying against real
          // diagnostic state. The verified SUCCESS (or FAILURE) emotion comes
          // from the companion's own resolution path, so this hold settles
          // into it rather than locking anything.
          emitSemanticEmotion('EXECUTING');
          const currentText = editor.document.getText(capturedRange);
          if (currentText !== originalCode) {
            releaseFix();
            vscode.window.showErrorMessage('Cannot apply fix: the source code has changed since the proposal was generated. Please generate a new fix.');
            emitEmotion('ERROR', { intensity: 0.8, duration: 3000 });
            pipeline.getCompanion().speakLine('Source changed — fix rejected.') || 3000;
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            return;
          }
          
          const edit = new vscode.WorkspaceEdit();
          edit.replace(originalUri, capturedRange, proposedFix);
          const success = await vscode.workspace.applyEdit(edit);
          
          if (success) {
            sensors.getUserInput().record('approval', 'Fix proposal approved', `File: ${fileName}:${line + 1}`);
            aceSystem.getAdaptiveLearning().recordIntervention({ matter: `${fileName}:${line + 1}`, accepted: true, action: 'FIX' });
            emitSemanticEmotion('VERIFYING');
            pipeline.getCompanion().beginFixVerification({
              code: diagnosticCode(primary),
              message: primary.message,
              file: editor.document.fileName,
              fileName,
              line: line + 1,
              // Remember what was actually changed so "what did you change"
              // has a recorded answer instead of a guess.
              changeSummary: proposedFix.split(/\r?\n/).filter((l) => l.trim()).slice(0, 3).join(' ').slice(0, 300),
            });
            Logger.info('COMMAND', {
              Event: 'Fix applied — awaiting real diagnostic state',
              File: fileName,
              Line: String(line + 1),
            });
          } else {
            vscode.window.showErrorMessage('Failed to apply fix.');
            emitEmotion('ERROR', { intensity: 0.8, duration: 3000 });
            pipeline.getCompanion().speakLine('Fix could not be applied.') || 3000;
          }
        } else {
          vscode.window.showInformationMessage('Fix cancelled.');
          emitEmotion('IDLE', { intensity: 0.5, duration: 2000 });
        }

        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        releaseFix();
      })
    );

    /**
     * Normalises a VS Code diagnostic code to the scalar the Brain keys mistakes
     * by. VS Code allows a code to be a string, a number, or a
     * {value, target} link object; the Brain only ever sees the value.
     */
    function diagnosticCode(diagnostic: vscode.Diagnostic): string | number | undefined {
      const code = diagnostic.code as unknown;
      if (typeof code === 'string' || typeof code === 'number') {
        return code;
      }
      if (code && typeof code === 'object' && 'value' in (code as { value?: unknown })) {
        const value = (code as { value?: unknown }).value;
        return typeof value === 'string' || typeof value === 'number' ? value : undefined;
      }
      return undefined;
    }

    /**
     * SENSOR ROUTING — all sensor events write ONLY to Logger.     * They are NEVER forwarded directly to the webview/UI.
     * Only the Decision Engine's FSM output is allowed to reach the UI.
     */
    function logSensorEvent(sensorName: string, detail: string, wsType: string) {
      Logger.info(sensorName, { Event: detail });
      // Monitoring OFF: sensor activity is still logged, but no passive frames
      // reach the Body — a monitoring-paused companion must not keep reacting
      // to background events. Explicit commands send their own frames.
      if (!pipeline.getCompanion().isMonitoringEnabled()) {
        return;
      }
      sendToRobot({ type: wsType as any });
    }

    // ────────────────────────────────────────────────────────────────────
    // COMPANION COMMANDS — teaching ladder, timeline replay, learning summary
    // ────────────────────────────────────────────────────────────────────
    context.subscriptions.push(
      vscode.commands.registerCommand('botx.toggleTeachingMode', () => {
        const companion = pipeline.getCompanion();
        const enabled = !companion.isTeachingEnabled();
        // Runtime first (one source of truth), then persist. The configuration
        // listener re-applies the same value and is a no-op, so the message
        // below is shown exactly once.
        companion.setTeachingEnabled(enabled);
        void vscode.workspace.getConfiguration('botx')
          .update('teachingMode', enabled, vscode.ConfigurationTarget.Global);
        Logger.info('COMMAND', { Event: 'toggleTeachingMode', Enabled: String(enabled) });
        vscode.window.showInformationMessage(
          enabled
            ? 'Ace.X: teaching mode on — Eve will nudge, hint and explain.'
            : 'Ace.X: teaching mode off — no passive hints or ladder; Ask Companion and Explain Error still work.'
        );
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('botx.replayTimeline', () => {
        const lines = pipeline.getCompanion().getTimelineReport();
        aetherChannel.appendLine('[TIMELINE] Recent debugging timeline (last 60s):');
        for (const line of lines) {
          aetherChannel.appendLine(`  ${line}`);
        }
        aetherChannel.show(true);
        Logger.info('COMMAND', { Event: 'replayTimeline' });
        vscode.window.showInformationMessage('Ace.X: recent debugging timeline written to Aether Brain.');
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('botx.showLearningSummary', () => {
        const lines = pipeline.getCompanion().getLearningSummary();
        aetherChannel.appendLine('[LEARNING] Learning summary:');
        for (const line of lines) {
          aetherChannel.appendLine(`  ${line}`);
        }
        aetherChannel.show(true);
        Logger.info('COMMAND', { Event: 'showLearningSummary' });
        // The compact single-line form for the toast; the full report lives in
        // the output channel where it stays readable and copyable.
        vscode.window.showInformationMessage(`Ace.X: ${lines[0]}`);
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // SENSOR 1: Active Editor Switcher
    // Fires when the user switches between editor tabs or opens a file.
    // NOTE: updateStatusBarDiagnostics is NOT called here to avoid a race
    // condition where clearErrors kills the showEvent message. Error count
    // is updated via the EventFilter DIAGNOSTICS_UPDATED handler instead.
    // ────────────────────────────────────────────────────────────────────
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) {return;}
        if (isOutputDocument(editor.document)) {return;}
        const file = editor.document.fileName.split(/[/\\]/).pop() || editor.document.fileName;
        logSensorEvent('EDITOR FOCUS', `Analyzing: ${file}`, 'EDITOR_CHANGED');
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // SENSOR 2: Cursor Line/Selection Sensor
    // Fires on cursor movement or selection changes (debounced).
    // ────────────────────────────────────────────────────────────────────
    let cursorDebounce: ReturnType<typeof setTimeout> | undefined;
    context.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (isOutputDocument(event.textEditor.document)) {return;}
        if (cursorDebounce) {clearTimeout(cursorDebounce);}
        cursorDebounce = setTimeout(() => {
          const editor = event.textEditor;
          const file = editor.document.fileName.split(/[/\\]/).pop() || editor.document.fileName;
          const line = event.selections[0]?.active.line ?? 0;
          logSensorEvent('CURSOR MOVE', `${file} L${line + 1}`, 'CURSOR_MOVE');
        }, 200);
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // SENSOR 3: Text Document Edits (typing tracker)
    // Fires on every content change — used to detect typing velocity,
    // rapid-save patterns, and code-generation events.
    // ────────────────────────────────────────────────────────────────────
    let editDebounce: ReturnType<typeof setTimeout> | undefined;
    let editCount = 0;
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (isOutputDocument(e.document)) {return;}
        if (e.contentChanges.length === 0) {return;}
        editCount++;
        if (editDebounce) {clearTimeout(editDebounce);}
        editDebounce = setTimeout(() => {
          const file = e.document.fileName.split(/[/\\]/).pop() || e.document.fileName;
          logSensorEvent('TEXT EDIT', `${file} — ${editCount} change(s) in debounce window`, 'ACTION');
          editCount = 0;
        }, 500);
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // SENSOR 4: File Save Event Listener
    // Fires when a document is saved to disk.
    // ────────────────────────────────────────────────────────────────────
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (isOutputDocument(doc)) {return;}
        const file = doc.fileName.split(/[/\\]/).pop() || doc.fileName;
        logSensorEvent('FILE SAVED', `Saved: ${file}`, 'EDITOR_CHANGED');
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // SENSOR 5: (REMOVED)
    // DiagnosticsSensor now handles all diagnostic → EventFilter publishing.
    // The inline sensor's Logger/WebSocket/status-bar behavior is covered
    // by the CognitivePipeline (Perception → Context → Decision → Behaviour)
    // and the EventFilter subscriber that routes DIAGNOSTICS_UPDATED to the
    // webview for persistent error count updates.
    // ────────────────────────────────────────────────────────────────────

    // ────────────────────────────────────────────────────────────────────
    // SENSOR 6: Terminal Creation Listener
    // Fires when a new terminal is opened.
    // ────────────────────────────────────────────────────────────────────
    context.subscriptions.push(
      vscode.window.onDidOpenTerminal((term) => {
        logSensorEvent('TERMINAL CREATED', `Terminal opened: ${term.name}`, 'EDITOR_CHANGED');
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // SENSOR 7: Terminal Execution Output Listener
    // Fires when a terminal command completes execution.
    // ────────────────────────────────────────────────────────────────────
    context.subscriptions.push(
      vscode.window.onDidEndTerminalShellExecution((event) => {
        const cmd = event.execution.commandLine.value;
        const exitCode = event.exitCode;
        const status = exitCode === 0 ? 'success' : `exit ${exitCode}`;
        logSensorEvent('TERMINAL OUTPUT', `Command: ${cmd} [${status}]`, 'EDITOR_CHANGED');
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // SENSOR 8: Debug Session Start Listener
    // Fires when a debug session begins.
    // ────────────────────────────────────────────────────────────────────
    context.subscriptions.push(
      vscode.debug.onDidStartDebugSession((session) => {
        logSensorEvent('DEBUG STARTED', `Debug started: ${session.name}`, 'ACTION');
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // SENSOR 9: Debug Session Termination / Crash Listener
    // Fires when a debug session ends (normal or abnormal).
    // ────────────────────────────────────────────────────────────────────
    context.subscriptions.push(
      vscode.debug.onDidTerminateDebugSession((session) => {
        logSensorEvent('DEBUG TERMINATED', `Debug stopped: ${session.name}`, 'ACTION');
      })
    );
    context.subscriptions.push(
      vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
        if (['stopped', 'breakpoint', 'exception', 'paused'].includes(event.event?.toLowerCase() ?? '')) {
          const reason = String(event.body?.reason ?? event.event);
          logSensorEvent('DEBUG EVENT', `Breakpoint/Pause: ${reason}`, 'ACTION');
        }
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // SENSOR 10: Focus Inactivity Watcher (30s idle timer)
    // Fires after 30 seconds of no cursor movement, typing, or editor
    // switches — indicates the user may be reading/thinking.
    // ────────────────────────────────────────────────────────────────────
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const IDLE_THRESHOLD_MS = 30000;
    function resetIdleTimer() {
      if (idleTimer) {clearTimeout(idleTimer);}
      idleTimer = setTimeout(() => {
        logSensorEvent('IDLE DETECTED', `No edits for ${IDLE_THRESHOLD_MS / 1000}s — still in focus`, 'ACTION');
      }, IDLE_THRESHOLD_MS);
    }
    context.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection(() => resetIdleTimer())
    );
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(() => resetIdleTimer())
    );
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => resetIdleTimer())
    );
    resetIdleTimer();
    context.subscriptions.push({ dispose: () => { if (idleTimer) { clearTimeout(idleTimer); } } });

    // ────────────────────────────────────────────────────────────────────
    // HOST WINDOW STATE — authoritative VS Code window focus
    // The Brain owns this; the Body must obey for visibility.
    // Note: VS Code API only exposes 'focused' on window.state.
    // Minimized windows are not focused, so hiding on unfocused covers both.
    // ────────────────────────────────────────────────────────────────────
    let lastHostWindowState: { focused: boolean | null } | null = null;

    function sendHostWindowState(): void {
        const state = vscode.window.state;
        const focused = state.focused;

        // Only send if changed
        if (lastHostWindowState && lastHostWindowState.focused === focused) {
            return;
        }
        lastHostWindowState = { focused };

        // Only send authoritative state when we have a definitive reading.
        // During extension startup, VS Code may report focused=false even
        // though the window is visible (especially in Extension Development Host).
        // Send null (unknown) initially; the Body treats unknown as "show by default".
        // Once we receive a definitive focused=true, we start sending real state.
        if (focused === true) {
            sendToRobot({ type: 'HOST_WINDOW_STATE', focused: true, minimized: false });
            Logger.info('HOST_WINDOW', { Event: 'Window state changed', Focused: 'true' });
        } else if (lastHostWindowState.focused === false && focused === false) {
            // Still unknown/unfocused - don't send anything yet. The Body defaults to visible.
        }
    }

    // Initial state: UNKNOWN (null). The WebSocket server also sends unknown on connect.
    // This ensures the Body shows by default until we have a reliable focused=true.
    lastHostWindowState = { focused: null };

    // Listen for changes
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((e) => {
            sendHostWindowState();
        })
    );

    // ────────────────────────────────────────────────────────────────────
    // SENSOR 11: Extension Lifecycle / WebSocket Bridge Watcher
    // Fires when extensions are installed or removed, and monitors the
    // WebSocket bridge connection state.
    // ────────────────────────────────────────────────────────────────────
    const knownExtensions = new Set<string>(vscode.extensions.all.map(e => e.id));
    context.subscriptions.push(
      vscode.extensions.onDidChange(() => {
        const current = new Set<string>(vscode.extensions.all.map(e => e.id));
        for (const id of current) {
          if (!knownExtensions.has(id)) {
            const ext = vscode.extensions.getExtension(id);
            const name = ext?.packageJSON?.displayName || ext?.packageJSON?.name || id;
            logSensorEvent('EXTENSION INSTALLED', `New extension installed: ${name}`, 'ACTION');
          }
        }
        for (const id of knownExtensions) {
          if (!current.has(id)) {
            logSensorEvent('EXTENSION REMOVED', `Extension removed: ${id}`, 'ACTION');
          }
        }
        knownExtensions.clear();
        for (const id of current) {knownExtensions.add(id);}
      })
    );

    // WebSocket bridge health check (periodic)
    let wsHealthTimer: ReturnType<typeof setInterval> | undefined;
    wsHealthTimer = setInterval(() => {
      Logger.info('WEBSOCKET HEALTH', { Status: 'heartbeat', Clients: 'tracked' });
    }, 60000);
    context.subscriptions.push({
      dispose: () => {
        if (wsHealthTimer) {clearInterval(wsHealthTimer);}
      }
    });

    // ────────────────────────────────────────────────────────────────────
    // SHUTDOWN — dispose in reverse order of what was created: stop timers
    // and observers (subscriptions), release companion state, then close the
    // WebSocket server. Learning state needs no flush: LearningAgent persists
    // its profile on every change through LearningMemory.
    // ────────────────────────────────────────────────────────────────────
    context.subscriptions.push({
      dispose: () => {
        Logger.info('EXTENSION', { Event: 'Shutting down — releasing companion state' });
        pipeline.getCompanion().dispose();
        stopRobotServer();
      }
    });

    Logger.info('EXTENSION', { Event: 'Ace.X wired — 11 sensor capabilities, ACES advisory, canonical robot view' });

    // Extension API: expose the ONE existing pipeline so tooling and the live
    // integration test can read the same Brain state the panel and the Robot Body
    // read. This is the same single instance — not a second pipeline — and it
    // grants no additional capability beyond reading state.
    return {
      pipeline,
      companion: pipeline.getCompanion(),
    };
  } catch (error) {
    const errMsg = error ? ((error as any).stack || (error as any).message || String(error)) : 'Unknown error (payload undefined)';
    console.error('[Ace.X Activation Error]:', errMsg);
    vscode.window.showErrorMessage(`Ace.X Activation Error: ${errMsg}`);
  }
}

export function deactivate() {
  // Everything else was disposed through context.subscriptions. The WebSocket
  // server is stopped there too; this is a final safety net for hosts that
  // call deactivate() without disposing subscriptions first.
  stopRobotServer();
}
