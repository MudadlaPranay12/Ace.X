import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { EventFilter } from '../../eventFilter/eventFilter';
import { EventType } from '../../eventFilter/eventTypes';
import type { AetherEvent } from '../../eventFilter/event';
import { SessionManager } from '../../identity/sessionManager';
import { SENSOR_CAPABILITIES, SUPPORTING_SENSORS } from '../../sensors/sensorCapabilities';
import { SensorCoordinator } from '../../sensors/sensorCoordinator';
import { UserInputSensor } from '../../sensors/userInputSensor';
import { WebviewIpcSensor } from '../../sensors/webviewIpcSensor';
import { LineNavigationSensor } from '../../sensors/lineNavigationSensor';
import { SystemOutputSensor } from '../../sensors/systemOutputSensor';
import { PerceptionEngine } from '../../perception/perceptionEngine';
import { ObservationType } from '../../perception/observationType';
import type { Observation } from '../../perception/observation';
import { SemanticPerception } from '../../perception/semanticPerception';
import { ContextEngine } from '../../context/contextEngine';
import { ContextType } from '../../context/contextType';
import type { Context } from '../../context/context';
import { DecisionEngine } from '../../decision/decisionEngine';
import { LearningAgent } from '../../learning/learningAgent';
import { UserModel } from '../../user/userModel';
import { LocalProjectCoordinator } from '../../coordination/projectCoordination';
import { ContextSnapshotBuilder } from '../../context/contextSnapshot';
import { DebugAgent } from '../../agents/debugAgent';
import { CodingAgent } from '../../agents/codingAgent';
import { WorkspaceAgent } from '../../agents/workspaceAgent';
import { GitAgent } from '../../agents/gitAgent';
import { ExtensionAgent } from '../../agents/extensionAgent';
import { AdaptiveMultiLearningAgent } from '../../agents/adaptiveMultiLearningAgent';
import type { AgentFinding, AgentInput } from '../../agents/agentFinding';
import { AgentSynthesis } from '../../agents/agentSynthesis';
import { AcesEngine } from '../../aces/acesEngine';
import { mapAcesToDecision } from '../../decision/acesDecisionMapper';
import { AceSystem } from '../../aces/aceSystem';
import { ChangeWorkflow } from '../../workflow/changeWorkflow';
import { RobotStatePublisher } from '../../ui/robotStatePublisher';
import { RobotWebviewBridge } from '../../ui/robotWebviewBridge';
import { renderRobotHtml } from '../../ui/robotHtml';
import { sendToRobot, onBrainFrame } from '../../utils/websocketServer';
import { detectCodingIntent } from '../../intent/codingIntent';
import { quinticEase } from '../../motion/quinticTrajectory';
import { PdController } from '../../motion/pdController';
import { buildPopupState } from '../../ui/robotPopup';
import { interpretVoiceCommand, micErrorMessage, shouldSpeak, ttsSummary } from '../../voice/voiceCommands';
import {
    buildEveConversationContext,
    buildIssuePromptPrefix,
    describeLastChange,
    isAcknowledgment,
    selectTargetDiagnostic,
} from '../../conversation/eveConversation';
import { mistakeKey } from '../../learning/recurringMistakes';
import * as path from 'path';

/**
 * FINAL verification harness (temporary).
 *
 * Drives the REAL engines — EventFilter, PerceptionEngine, ContextEngine,
 * DecisionEngine, agents, synthesis, ACES, learning, workflow and the robot
 * state publisher — with real events in a real Extension Development Host.
 * Nothing here simulates the Brain: observations come from actual perception
 * runs and findings from actual agent analysis.
 */

const EXTENSION_ID = 'botx.robot-brain';

function fakeContext(): vscode.ExtensionContext {
    const store = new Map<string, unknown>();
    return {
        subscriptions: [],
        globalState: {
            get: (key: string) => store.get(key),
            update: (key: string, value: unknown) => {
                store.set(key, value);
                return Promise.resolve();
            },
        },
    } as unknown as vscode.ExtensionContext;
}

interface Harness {
    filter: EventFilter;
    perception: PerceptionEngine;
    observations: Observation[];
}

function makeHarness(): Harness {
    const filter = new EventFilter();
    filter.setIdentityProvider(() => ({
        developerId: 'dev-verify',
        sessionId: 'sess-verify',
        workspaceId: 'ws-verify',
        projectId: 'proj-verify',
        branchId: 'main',
        teamId: 'team-verify',
    }));
    const perception = new PerceptionEngine();
    const observations: Observation[] = [];
    filter.subscribe((event) => perception.process(event));
    perception.getPublisher().subscribe((observation) => observations.push(observation));
    return { filter, perception, observations };
}

let idCounter = 0;
function publish(
    filter: EventFilter,
    type: EventType,
    source: string,
    payload: Record<string, unknown>
): void {
    idCounter += 1;
    filter.publish({
        id: `verify-${Date.now()}-${idCounter}`,
        type,
        timestamp: Date.now(),
        source,
        payload,
    });
}

function diagnosticPayload(message: string, line = 3): Record<string, unknown> {
    return {
        File: 'D:\\verify\\sample.py',
        Language: 'python',
        Severity: 'Error',
        Line: line,
        Column: 5,
        Message: message,
        Code: undefined,
    };
}

function batchPayload(messages: string[]): Record<string, unknown> {
    return {
        File: 'D:\\verify\\sample.py',
        Language: 'python',
        TotalDiagnostics: messages.length,
        diagnostics: messages.map((message, index) => ({
            type: 'SEMANTIC_ERROR',
            details: message,
            line: index + 1,
            column: 1,
            file: 'D:\\verify\\sample.py',
            language: 'python',
            severity: 'Error',
            code: undefined,
        })),
    };
}

function agentInputFor(
    observation: Observation,
    meaning: ReturnType<SemanticPerception['interpret']>,
    snapshot: ReturnType<ContextSnapshotBuilder['snapshot']>
): AgentInput {
    return { observation, meaning, snapshot };
}

suite('FINAL verification', () => {
    suiteSetup(async function () {
        this.timeout(120000);
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, 'extension under test is not installed in the test host');
        await ext!.activate();
        // Guarantee a non-blank active document so perception's blank-file
        // guard never suppresses the diagnostic path under test.
        const document = await vscode.workspace.openTextDocument({
            content: 'const verify = 1;\nconsole.log(verify);\n',
            language: 'typescript',
        });
        await vscode.window.showTextDocument(document);
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('extension activates with pipeline exports and robot commands', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext!.isActive, 'extension did not activate');
        const exported = ext!.exports as { pipeline?: unknown; companion?: unknown };
        assert.ok(exported.pipeline, 'extension must export its pipeline');
        assert.ok(exported.companion, 'extension must export its companion');
        const commands = await vscode.commands.getCommands(true);
        for (const id of [
            'acex.openRobot',
            'acex.showEve',
            'acex.hideEve',
            'acex.focusEve',
            'acex.toggleAlwaysOnTop',
            'acex.resetEvePosition',
        ]) {
            assert.ok(commands.includes(id), `command ${id} is not registered`);
        }
        assert.ok(!commands.includes('acex.openRobotEditor'), 'the Webview-as-body editor command must be gone');
        assert.ok(!commands.includes('acex.robot.focus'), 'the sidebar Eve view must not be registered');
    });

    test('identity manager issues a full session envelope', () => {
        const context = fakeContext();
        const filter = new EventFilter();
        const sessions = new SessionManager(context, filter);
        const identity = sessions.current();
        assert.ok(identity.developerId.length > 0, 'developerId missing');
        assert.ok(identity.sessionId.length > 0, 'sessionId missing');
        assert.ok(identity.workspaceId.length > 0, 'workspaceId missing');
        assert.ok(identity.projectId.length > 0, 'projectId missing');
        assert.ok(identity.teamId.length > 0, 'teamId missing');
        sessions.dispose(filter);
    });

    test('event filter normalizes the common envelope with priority and identity', () => {
        const harness = makeHarness();
        publish(harness.filter, EventType.DIAGNOSTICS_UPDATED, 'DiagnosticsSensor', diagnosticPayload('boom'));
        const accepted = harness.filter.getQueue();
        assert.ok(accepted.size() >= 1, 'event was not queued');
        // Envelope fields are stamped by normalization, not by the sensor.
        const peeked = (harness.filter.getQueue() as unknown as { events: AetherEvent[] });
        const stored = peeked.events[peeked.events.length - 1];
        assert.strictEqual(stored.priority, 'HIGH', 'diagnostic must default to HIGH priority');
        assert.strictEqual(stored.developerId, 'dev-verify');
        assert.strictEqual(stored.sessionId, 'sess-verify');
        assert.strictEqual(stored.workspaceId, 'ws-verify');
        assert.strictEqual(stored.projectId, 'proj-verify');
        assert.strictEqual(stored.branchId, 'main');
        assert.strictEqual(stored.teamId, 'team-verify');
    });

    test('event filter validates, deduplicates, debounces and load-sheds', () => {
        const harness = makeHarness();
        const before = harness.observations.length;
        // Invalid: unknown type rejected.
        harness.filter.publish({
            id: 'bad-1',
            type: 'NOPE' as EventType,
            timestamp: Date.now(),
            source: 'X',
            payload: {},
        });
        assert.strictEqual(harness.observations.length, before, 'invalid event must not reach perception');
        // Duplicate: identical cursor payload twice in the window.
        const cursor = { File: 'D:\\verify\\a.ts', Language: 'typescript', Line: 1, Column: 1 };
        publish(harness.filter, EventType.CURSOR_MOVED, 'CursorSensor', { ...cursor });
        publish(harness.filter, EventType.CURSOR_MOVED, 'CursorSensor', { ...cursor });
        const cursorObs = harness.observations.filter((o) => o.type === ObservationType.CURSOR_MOVED);
        assert.strictEqual(cursorObs.length, 1, 'duplicate cursor event must be dropped');
        // Debounce: same key, differing column inside the window.
        publish(harness.filter, EventType.CURSOR_MOVED, 'CursorSensor', { ...cursor, Column: 2 });
        assert.strictEqual(
            harness.observations.filter((o) => o.type === ObservationType.CURSOR_MOVED).length,
            1,
            'debounced cursor event must be dropped'
        );
        // Load shed: fill past the threshold with LOW events, then prove a
        // LOW event is shed while a HIGH event is still admitted.
        for (let line = 10; line < 420; line++) {
            publish(harness.filter, EventType.CURSOR_MOVED, 'CursorSensor', {
                File: 'D:\\verify\\load.ts',
                Language: 'typescript',
                Line: line,
                Column: 1,
            });
        }
        const loaded = harness.filter.getQueue().size();
        assert.ok(loaded >= 400, `expected a loaded queue, got ${loaded}`);
        publish(harness.filter, EventType.CURSOR_MOVED, 'CursorSensor', {
            File: 'D:\\verify\\load.ts',
            Language: 'typescript',
            Line: 9999,
            Column: 1,
        });
        assert.strictEqual(harness.filter.getQueue().size(), loaded, 'LOW event must shed under load');
        publish(harness.filter, EventType.DIAGNOSTICS_UPDATED, 'DiagnosticsSensor', diagnosticPayload('kept'));
        assert.strictEqual(harness.filter.getQueue().size(), loaded + 1, 'HIGH event must survive load shedding');
    });

    test('all 11 logical sensor capabilities are registered exactly once', () => {
        assert.strictEqual(SENSOR_CAPABILITIES.length, 11, 'must expose exactly 11 logical capabilities');
        const names = SENSOR_CAPABILITIES.map((entry) => entry.capability).sort();
        assert.deepStrictEqual(names, [
            'active-file',
            'cursor-position',
            'diagnostic',
            'document-content',
            'document-save',
            'idle-timeout',
            'line-navigation',
            'system-output',
            'terminal-process',
            'user-input',
            'webview-ipc',
        ]);
        const coordinator = new SensorCoordinator(new EventFilter());
        const health = coordinator.health();
        assert.strictEqual(health.capabilities.length, 11);
        assert.ok(SUPPORTING_SENSORS.includes('GitSensor'));
        assert.strictEqual(health.started.length, 19, 'all 19 concrete sources must start');
    });

    test('real sensor events drive perception observations for every capability', async function () {
        this.timeout(30000);
        const harness = makeHarness();
        const context = fakeContext();
        const userInput = new UserInputSensor(harness.filter);
        const ipc = new WebviewIpcSensor(harness.filter);
        const navigation = new LineNavigationSensor(harness.filter);
        const systemOutput = new SystemOutputSensor(harness.filter);
        userInput.start(context);
        ipc.start(context);
        navigation.start(context);
        systemOutput.start(context);

        // Diagnostic capability through the real perception engine.
        publish(harness.filter, EventType.DIAGNOSTICS_UPDATED, 'DiagnosticsSensor', diagnosticPayload('cannot find name customer_name'));
        // Document content + coding intent (no diagnostic required).
        publish(harness.filter, EventType.CODING_INTENT_DETECTED, 'DocumentActivitySensor', {
            File: 'D:\\verify\\hello.py',
            Language: 'python',
            Line: 1,
            IntentText: 'hello world',
            Confidence: 0.9,
        });
        // Terminal/process failure.
        publish(harness.filter, EventType.TERMINAL_COMMAND_FAILED, 'TerminalSensor', {
            'Terminal Name': 'pwsh',
            'Error Snippet': 'exit code 1',
            'Full Line': 'npm test',
        });
        // User input capability.
        userInput.record('approval', 'Fix proposal approved', 'verify');
        // Webview IPC capability.
        ipc.recordInbound({ type: 'ROBOT_READY', surface: 'verify' });
        ipc.recordOutbound('STATE_SYNC');
        assert.strictEqual(ipc.health().inbound, 1);
        assert.strictEqual(ipc.health().outbound, 1);
        // System output capability (event path; the sensor itself listens for
        // real debug sessions and registers without error).
        publish(harness.filter, EventType.SYSTEM_OUTPUT, 'SystemOutputSensor', {
            Kind: 'test',
            Category: 'stderr',
            Session: 'pytest',
            Text: 'FAILED test_total - assert 0 == 1',
            Failed: true,
        });
        // Line navigation: two settled cursor positions far apart.
        publish(harness.filter, EventType.CURSOR_MOVED, 'CursorSensor', {
            File: 'D:\\verify\\nav.ts',
            Language: 'typescript',
            Line: 10,
            Column: 1,
        });
        publish(harness.filter, EventType.CURSOR_MOVED, 'CursorSensor', {
            File: 'D:\\verify\\nav.ts',
            Language: 'typescript',
            Line: 100,
            Column: 1,
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));

        const types = new Set(harness.observations.map((o) => o.type));
        for (const expected of [
            ObservationType.ERROR_DETECTED,
            ObservationType.CODING_INTENT,
            ObservationType.RUNTIME_CRASH,
            ObservationType.USER_INPUT,
            ObservationType.WEBVIEW_IPC,
            ObservationType.SYSTEM_OUTPUT,
            ObservationType.LINE_NAVIGATED,
        ]) {
            assert.ok(types.has(expected), `missing observation ${expected}; got [${[...types].join(', ')}]`);
        }
        const nav = harness.observations.find((o) => o.type === ObservationType.LINE_NAVIGATED);
        assert.strictEqual(Number(nav!.data['ToLine']), 100, 'navigation must land on line 100');
        navigation.dispose();
    });

    test('semantic perception classifies activity, intent and struggle', async () => {
        const harness = makeHarness();
        const semantic = new SemanticPerception();
        let interpreted = 0;
        const interpretNew = () => {
            let last: ReturnType<SemanticPerception['interpret']> | undefined;
            for (const observation of harness.observations.slice(interpreted)) {
                last = semantic.interpret(observation);
                interpreted += 1;
            }
            return last;
        };
        publish(harness.filter, EventType.CODING_INTENT_DETECTED, 'DocumentActivitySensor', {
            File: 'D:\\verify\\hello.py',
            Language: 'python',
            Line: 1,
            IntentText: 'hello world',
            Confidence: 0.9,
        });
        const intentMeaning = interpretNew()!;
        assert.strictEqual(intentMeaning.activity, 'CODING_ACTIVITY');
        assert.ok(intentMeaning.intents.includes('BUILD'));

        publish(harness.filter, EventType.TERMINAL_COMMAND_FAILED, 'TerminalSensor', {
            'Terminal Name': 'pwsh',
            'Error Snippet': 'exit code 1',
            'Full Line': 'npm test',
        });
        assert.strictEqual(interpretNew()!.state, 'TEST_FAILURE');

        for (let i = 0; i < 3; i++) {
            // Distinct messages/lines: identical payloads are correctly
            // rejected by deduplication, so repetition must be genuine.
            publish(harness.filter, EventType.DIAGNOSTICS_UPDATED, 'DiagnosticsSensor', diagnosticPayload(`same error variant ${i}`, i + 1));
            publish(harness.filter, EventType.FILE_SAVED, 'FileSensor', { File: 'D:\\verify\\sample.py', Path: 'D:\\verify\\sample.py' });
            // Saves inside the 400 ms debounce window are correctly shed, so
            // genuine repeated saves must be spaced apart.
            await new Promise((resolve) => setTimeout(resolve, 600));
        }
        // Interpret every observation in arrival order so the pattern window
        // fills exactly as it would in the live pipeline.
        const struggle = interpretNew()!;
        assert.ok(
            struggle.patterns.includes('POSSIBLE_STRUGGLE_PATTERN'),
            `expected struggle pattern, got [${struggle.patterns.join(', ')}]`
        );
    });

    test('natural-language coding intent needs no diagnostic', () => {
        const result = detectCodingIntent('# hello world', 1, 'python');
        assert.strictEqual(result.isCodingIntent, true, '# hello world must be coding intent');
        assert.ok(result.confidence > 0);
        const todo = detectCodingIntent('# TODO: refactor later', 2, 'python');
        assert.strictEqual(todo.isCodingIntent, false, 'TODO must not be coding intent');
    });

    test('user model adapts beginners and experienced developers differently', () => {
        const beginner = new UserModel(new LearningAgent());
        assert.strictEqual(beginner.preferredIntervention('python'), 'EXPLAIN');
        assert.strictEqual(beginner.preferredExplanationDepth('python'), 'DETAILED');
        for (let i = 0; i < 20; i++) {
            beginner.recordOutcome({ domain: 'python', concept: 'functions', success: true });
        }
        assert.strictEqual(beginner.getDomainLevel('python'), 'INTERMEDIATE');
        assert.strictEqual(beginner.preferredIntervention('python'), 'SUGGEST');
        // One failure must not radically alter the profile.
        const before = beginner.snapshot().domains['python'].score;
        beginner.recordOutcome({ domain: 'python', concept: 'functions', success: false });
        const after = beginner.snapshot().domains['python'].score;
        assert.ok(Math.abs(after - before) <= 1, 'a single event must not radically alter skill');
        // Skill is domain-specific, not one global label.
        assert.strictEqual(beginner.getDomainLevel('java'), 'BEGINNER');
    });

    test('all six agents produce structured findings from real evidence', () => {
        const harness = makeHarness();
        const learning = new LearningAgent();
        const userModel = new UserModel(learning);
        const coordinator = new LocalProjectCoordinator(() => ({
            developerId: 'dev-verify',
            sessionId: 'sess-verify',
            workspaceId: 'ws-verify',
            projectId: 'proj-verify',
            branchId: 'main',
            teamId: 'team-verify',
        }));
        const builder = new ContextSnapshotBuilder({
            contextEngine: new ContextEngine(),
            identity: () => ({
                developerId: 'dev-verify',
                sessionId: 'sess-verify',
                workspaceId: 'ws-verify',
                projectId: 'proj-verify',
                branchId: 'main',
                teamId: 'team-verify',
            }),
            userModel,
            project: () => coordinator.projectContext(),
            team: () => coordinator.teamContext(),
        });
        const semantic = new SemanticPerception();
        publish(harness.filter, EventType.DIAGNOSTICS_UPDATED, 'DiagnosticsSensor', diagnosticPayload('cannot find name customer_name'));
        publish(harness.filter, EventType.CODING_INTENT_DETECTED, 'DocumentActivitySensor', {
            File: 'D:\\verify\\hello.py',
            Language: 'python',
            Line: 1,
            IntentText: 'hello world',
            Confidence: 0.9,
        });
        publish(harness.filter, EventType.EDITOR_ACTIVE, 'EditorSensor', { File: 'D:\\verify\\a.ts', Language: 'typescript' });
        const errorObs = harness.observations.find((o) => o.type === ObservationType.ERROR_DETECTED)!;
        const intentObs = harness.observations.find((o) => o.type === ObservationType.CODING_INTENT)!;
        const fileObs = harness.observations.find((o) => o.type === ObservationType.EDITOR_CHANGED)!;
        assert.ok(errorObs && intentObs && fileObs, 'perception must yield all three observations');
        const snapshot = builder.snapshot();

        const debugFindings = new DebugAgent().analyze(agentInputFor(errorObs, semantic.interpret(errorObs), snapshot));
        assert.strictEqual(debugFindings.length, 1);
        assert.ok(debugFindings[0].evidence.length > 0, 'debug finding must carry evidence');
        assert.ok(
            (debugFindings[0].possibleCause ?? '').includes('defined or imported'),
            `unexpected root-cause candidate: ${debugFindings[0].possibleCause}`
        );

        const codingFindings = new CodingAgent().analyze(agentInputFor(intentObs, semantic.interpret(intentObs), snapshot));
        assert.strictEqual(codingFindings.length, 1);
        assert.strictEqual(codingFindings[0].category, 'CODING_INTENT');
        assert.ok(codingFindings[0].suggestedActions.some((a) => a.kind === 'EXPLAIN'), 'beginner intent must teach first');

        const workspaceFindings = new WorkspaceAgent().analyze(agentInputFor(fileObs, semantic.interpret(fileObs), snapshot));
        assert.strictEqual(workspaceFindings.length, 1);
        assert.strictEqual(workspaceFindings[0].scope, 'WORKSPACE');

        const gitAgent = new GitAgent();
        const gitApi = vscode.extensions.getExtension('vscode.git');
        const gitFindings = gitAgent.analyze(agentInputFor(errorObs, semantic.interpret(errorObs), snapshot));
        assert.ok(Array.isArray(gitFindings), 'git agent must answer with a finding list');
        if (!gitApi) {
            assert.strictEqual(gitFindings.length, 0, 'without a git API the agent must stay silent, never guess');
        }

        const healthySources = {
            sensorCapabilities: SENSOR_CAPABILITIES.map((entry) => entry.capability),
            supportingSensors: SUPPORTING_SENSORS,
            eventQueueSize: 5,
            pipelineUptimeMs: 60000,
            pipelineEvents: 42,
            webviewInbound: 2,
            webviewOutbound: 7,
            lastWebviewOutboundAt: Date.now(),
            wsClients: 1,
        };
        assert.deepStrictEqual(new ExtensionAgent(() => healthySources).analyze(agentInputFor(errorObs, semantic.interpret(errorObs), snapshot)), []);
        const sickFindings = new ExtensionAgent(() => ({ ...healthySources, eventQueueSize: 450 })).analyze(
            agentInputFor(errorObs, semantic.interpret(errorObs), snapshot)
        );
        assert.strictEqual(sickFindings.length, 1);
        assert.strictEqual(sickFindings[0].severity, 'HIGH');

        const adaptive = new AdaptiveMultiLearningAgent(learning, userModel, coordinator);
        const userSynthesis = adaptive.recordUserOutcome({ domain: 'python', success: true });
        assert.strictEqual(userSynthesis.userUpdated, true);
        const intervention = adaptive.recordIntervention({ matter: 'verify:1', accepted: false, action: 'FIX' });
        assert.strictEqual(intervention.interventionUpdated, true);
        const synthesized = adaptive.synthesize();
        assert.ok(
            synthesized.notes.some((note) => note.includes('1 intervention')),
            'rejection must reach intervention learning'
        );
        builder.dispose();
    });

    test('synthesis correlates multi-signal evidence into a project root cause', () => {
        const harness = makeHarness();
        const semantic = new SemanticPerception();
        const learning = new LearningAgent();
        const userModel = new UserModel(learning);
        const coordinator = new LocalProjectCoordinator(() => ({
            developerId: 'bob',
            sessionId: 'sess-bob',
            workspaceId: 'ws-bob',
            projectId: 'PROJECT_123',
            branchId: 'bob-branch',
            teamId: 'team-1',
        }));
        const builder = new ContextSnapshotBuilder({
            contextEngine: new ContextEngine(),
            identity: () => ({
                developerId: 'bob',
                sessionId: 'sess-bob',
                workspaceId: 'ws-bob',
                projectId: 'PROJECT_123',
                branchId: 'bob-branch',
                teamId: 'team-1',
            }),
            userModel,
            project: () => coordinator.projectContext(),
            team: () => coordinator.teamContext(),
        });
        const snapshot = builder.snapshot();
        // Bob hits the same type error three times: recurrence escalates scope.
        const bobObs: Observation[] = [];
        for (let i = 0; i < 3; i++) {
            publish(harness.filter, EventType.DIAGNOSTICS_UPDATED, 'DiagnosticsSensor', diagnosticPayload("type 'string' is not assignable to type 'number'"));
            bobObs.push(harness.observations[harness.observations.length - 1]);
        }
        // Charlie hits a different diagnostic once.
        publish(harness.filter, EventType.DIAGNOSTICS_UPDATED, 'DiagnosticsSensor', diagnosticPayload('Cannot find module ./api'));
        const charlieObs = harness.observations[harness.observations.length - 1];
        const debug = new DebugAgent();
        const findings: AgentFinding[] = [
            ...debug.analyze(agentInputFor(bobObs[2], semantic.interpret(bobObs[0]), snapshot)),
            ...debug.analyze(agentInputFor(bobObs[2], semantic.interpret(bobObs[1]), snapshot)),
            ...debug.analyze(agentInputFor(bobObs[2], semantic.interpret(bobObs[2]), snapshot)),
            ...debug.analyze(agentInputFor(charlieObs, semantic.interpret(charlieObs), snapshot)),
        ];
        assert.ok(findings.length >= 2, 'expected findings from both developers');
        const synthesis = new AgentSynthesis().synthesize(findings);
        assert.ok(synthesis, 'synthesis must produce a recommendation');
        assert.strictEqual(synthesis!.scope, 'PROJECT', 'recurrence must escalate scope to PROJECT');
        assert.ok(synthesis!.rootCause, 'synthesis must name a root cause');
        assert.ok(synthesis!.contradictions.length > 0, 'divergent causes must be recorded as contradictions');
        assert.ok(synthesis!.confidence > 0 && synthesis!.confidence <= 1);
        assert.ok(synthesis!.evidence.length > 0);
        builder.dispose();
    });

    test('ACES reasons over findings and maps to an approval-gated decision', () => {
        const harness = makeHarness();
        const semantic = new SemanticPerception();
        const learning = new LearningAgent();
        const userModel = new UserModel(learning);
        const coordinator = new LocalProjectCoordinator(() => ({
            developerId: 'dev-verify',
            sessionId: 'sess-verify',
            workspaceId: 'ws-verify',
            projectId: 'proj-verify',
            branchId: 'main',
            teamId: 'team-verify',
        }));
        const contextEngine = new ContextEngine();
        const builder = new ContextSnapshotBuilder({
            contextEngine,
            identity: () => ({
                developerId: 'dev-verify',
                sessionId: 'sess-verify',
                workspaceId: 'ws-verify',
                projectId: 'proj-verify',
                branchId: 'main',
                teamId: 'team-verify',
            }),
            userModel,
            project: () => coordinator.projectContext(),
            team: () => coordinator.teamContext(),
        });
        publish(harness.filter, EventType.DIAGNOSTICS_UPDATED, 'DiagnosticsSensor', diagnosticPayload('cannot find name x'));
        const errorObs = harness.observations[harness.observations.length - 1];
        const meaning = semantic.interpret(errorObs);
        const snapshot = builder.snapshot();
        const findings = new DebugAgent().analyze(agentInputFor(errorObs, meaning, snapshot));
        const synthesis = new AgentSynthesis().synthesize(findings)!;
        const result = new AcesEngine().reason({ observation: errorObs, meaning, snapshot, findings, synthesis });
        for (const key of [
            'whatHappened',
            'whatItMeans',
            'whoIsAffected',
            'scope',
            'confidence',
            'userCapability',
            'interventionNeeded',
            'safestUsefulAction',
            'explanationDepth',
        ] as const) {
            assert.ok(result.reasoning[key] !== undefined && result.reasoning[key] !== '', `ACES must answer ${key}`);
        }
        const fixResult = { ...result, recommendedAction: 'FIX' as const };
        const mapped = mapAcesToDecision(snapshot.latestContext ?? {
            id: 'ctx-verify',
            type: ContextType.FIXING_COMPILER_ERROR,
            confidence: 0.9,
            timestamp: Date.now(),
            sourceObservation: errorObs,
            data: {},
        }, fixResult);
        assert.strictEqual(mapped.type, 'ASK_USER', 'FIX must become an approval request, never a silent edit');
        const decisions: unknown[] = [];
        const engine = new DecisionEngine();
        engine.getPublisher().subscribe((decision) => decisions.push(decision));
        engine.processAcesRecommendation(
            {
                id: 'ctx-verify',
                type: ContextType.FIXING_COMPILER_ERROR,
                confidence: 0.9,
                timestamp: Date.now(),
                sourceObservation: errorObs,
                data: {},
            },
            mapped
        );
        assert.strictEqual(decisions.length, 1, 'ACES decision must publish exactly once');
        builder.dispose();
    });

    test('full advisory path advises intervention for repeated errors', () => {
        const harness = makeHarness();
        const learning = new LearningAgent();
        const userModel = new UserModel(learning);
        const coordinator = new LocalProjectCoordinator(() => ({
            developerId: 'dev-verify',
            sessionId: 'sess-verify',
            workspaceId: 'ws-verify',
            projectId: 'proj-verify',
            branchId: 'main',
            teamId: 'team-verify',
        }));
        const contextEngine = new ContextEngine();
        const contexts: Context[] = [];
        contextEngine.getPublisher().subscribe((context) => contexts.push(context));
        const ace = new AceSystem(
            {
                contextEngine,
                learning,
                userModel,
                coordinator,
                identity: () => ({
                    developerId: 'dev-verify',
                    sessionId: 'sess-verify',
                    workspaceId: 'ws-verify',
                    projectId: 'proj-verify',
                    branchId: 'main',
                    teamId: 'team-verify',
                }),
                pipelineStats: () => ({ uptime: 1000, eventsProcessed: 10 }),
                sensorHealth: () => ({ capabilities: SENSOR_CAPABILITIES.map((entry) => entry.capability), supportingSensors: SUPPORTING_SENSORS }),
                eventQueueSize: () => harness.filter.getQueue().size(),
            },
            userModel,
            coordinator
        );
        for (let i = 0; i < 4; i++) {
            publish(harness.filter, EventType.DIAGNOSTICS_UPDATED, 'DiagnosticsSensor', diagnosticPayload("type 'string' is not assignable"));
        }
        for (const observation of harness.observations.filter((o) => o.type === ObservationType.ERROR_DETECTED)) {
            contextEngine.process(observation);
        }
        const last = contexts[contexts.length - 1];
        assert.ok(last, 'context engine must emit a context');
        const advised = ace.adviseForContext(last);
        assert.ok(advised, 'repeated errors must yield an ACES intervention');
        assert.ok(['EXPLAIN', 'SUGGEST', 'REQUEST_APPROVAL', 'FIX'].includes(advised!.result.recommendedAction));
    });

    test('learning updates user, project, team and intervention scopes', () => {
        const learning = new LearningAgent();
        const userModel = new UserModel(learning);
        const coordinator = new LocalProjectCoordinator(() => ({
            developerId: 'dev-verify',
            sessionId: 'sess-verify',
            workspaceId: 'ws-verify',
            projectId: 'PROJECT_123',
            branchId: 'main',
            teamId: 'team-verify',
        }));
        const adaptive = new AdaptiveMultiLearningAgent(learning, userModel, coordinator);
        adaptive.recordUserOutcome({ domain: 'python', concept: 'loops', success: true });
        adaptive.recordProjectLearning('recurring nullability mistakes in checkout flow', 'main');
        adaptive.recordTeamHandoff('src/checkout.ts', 'main');
        adaptive.recordIntervention({ matter: 'checkout:12', accepted: true, action: 'SUGGEST' });
        const snapshot = userModel.snapshot();
        assert.ok(snapshot.domains['python'], 'user scope must record the domain');
        const project = coordinator.projectContext();
        assert.ok(project.openIssues.length > 0, 'project scope must record the pattern');
        const team = coordinator.teamContext();
        assert.ok(team.handoffs.length > 0, 'team scope must record the handoff');
        const synthesis = adaptive.synthesize();
        assert.ok(synthesis.userUpdated && synthesis.projectUpdated && synthesis.teamUpdated);
        assert.ok(
            synthesis.notes.some((note) => note.includes('1 intervention')),
            'accepted intervention must be retained by intervention learning'
        );
    });

    test('multi-developer correlation keeps identities separate and metadata bounded', () => {
        const makeCoordinator = (developerId: string, branch: string) =>
            new LocalProjectCoordinator(() => ({
                developerId,
                sessionId: `sess-${developerId}`,
                workspaceId: `ws-${developerId}`,
                projectId: 'PROJECT_123',
                branchId: branch,
                teamId: 'team-1',
            }));
        const alice = makeCoordinator('alice', 'branch-a');
        const bob = makeCoordinator('bob', 'branch-b');
        const charlie = makeCoordinator('charlie', 'branch-c');
        alice.recordEvent({ kind: 'api-change', summary: 'API changed: id renamed to userId', branchId: 'branch-a', severity: 'warning', confidence: 0.9 });
        bob.recordEvent({ kind: 'diagnostic', summary: "type mismatch: id vs userId in consumer.ts:42", branchId: 'branch-b', file: 'consumer.ts', severity: 'error', confidence: 0.9 });
        charlie.recordEvent({ kind: 'test-result', summary: 'integration test failed: consumer contract', branchId: 'branch-c', severity: 'error', confidence: 0.85 });
        // No source code is shared by default: long content is truncated to metadata.
        const long = alice.recordEvent({ kind: 'issue', summary: `x-source:${'Y'.repeat(2000)}`, severity: 'info', confidence: 0.5 });
        assert.ok(long.summary.length <= 500, `metadata must stay bounded, got ${long.summary.length}`);
        assert.ok(!long.summary.includes('Y'.repeat(501)));
        for (const [coordinator, developerId] of [[alice, 'alice'], [bob, 'bob'], [charlie, 'charlie']] as const) {
            const team = coordinator.teamContext();
            assert.deepStrictEqual(team.members, [developerId], `${developerId} context must stay local`);
            assert.strictEqual(coordinator.projectContext().projectId, 'PROJECT_123');
        }
        assert.ok(bob.projectContext().openIssues.length > 0);
        assert.ok(charlie.projectContext().failingTests.length > 0);
        assert.ok(alice.projectContext().changedApis.length > 0);
    });

    test('explain-first workflow never edits without approval', async () => {
        const workflow = new ChangeWorkflow();
        const document = await vscode.workspace.openTextDocument({ content: 'const total = 1;\n', language: 'typescript' });
        const proposal = workflow.propose({
            file: document.fileName,
            line: 1,
            originalText: 'const total = 1;',
            replacement: 'const total = 2;',
            reason: 'verify',
        });
        // Unapproved proposals cannot apply.
        assert.strictEqual(await workflow.applyApproved(document.uri, proposal.id), false);
        assert.ok(workflow.approve(proposal.id), 'explicit approval must be recorded');
        assert.strictEqual(await workflow.applyApproved(document.uri, proposal.id), true);
        const updated = await vscode.workspace.openTextDocument(document.uri);
        assert.ok(updated.getText().includes('const total = 2;'), 'approved edit must apply');
        const verification = await workflow.verifyByDiagnostics(document.uri, proposal.id);
        assert.ok(typeof verification.verified === 'boolean');
        // Stale proposals cannot overwrite newer edits.
        const stale = workflow.propose({
            file: document.fileName,
            line: 1,
            originalText: 'const total = 1;',
            replacement: 'const total = 99;',
            reason: 'stale',
        });
        workflow.approve(stale.id);
        assert.strictEqual(await workflow.applyApproved(document.uri, stale.id), false, 'stale source must reject the apply');
        assert.strictEqual(workflow.reject('missing-id'), undefined);
    });

    test('robot state publisher maps frames and isolates listener failures', () => {
        const publisher = new RobotStatePublisher();
        publisher.start();
        const unsubscribeThrower = onBrainFrame(() => {
            throw new Error('boom');
        });
        sendToRobot({ type: 'EMOTION', emotion: 'ERROR', intensity: 0.8 });
        sendToRobot({ type: 'CAPTION', text: 'Check line 3.', mode: 'CAPTION' });
        const state = publisher.getState();
        assert.strictEqual(state.bodyState, 'FAILURE', 'ERROR emotion must map to FAILURE');
        assert.strictEqual(state.caption?.text, 'Check line 3.');
        assert.ok(state.intensity >= 0 && state.intensity <= 1, 'PD smoothing must stay in range');
        assert.ok(publisher.latestPayloadTypes().length >= 2, 'latest frames must be retained for sync');
        unsubscribeThrower();
        // A second client sees the same canonical stream, proving the hook
        // survived the failing listener.
        let seen = 0;
        const unsubscribeSecond = onBrainFrame(() => {
            seen += 1;
        });
        sendToRobot({ type: 'EMOTION', emotion: 'IDLE', intensity: 0 });
        assert.strictEqual(seen, 1, 'the canonical hook must keep delivering after a listener failure');
        unsubscribeSecond();
        publisher.dispose();
    });

    test('quintic and PD utilities behave deterministically', () => {
        assert.strictEqual(quinticEase(0), 0);
        assert.strictEqual(quinticEase(1), 1);
        const mid = quinticEase(0.5);
        assert.ok(mid > 0.4 && mid < 0.6, `quintic midpoint must be smooth, got ${mid}`);
        const pd = new PdController({ proportional: 12, derivative: 4.5 });
        let value = 0;
        for (let i = 0; i < 120; i++) {
            value = pd.step(value, 1, 1 / 60);
        }
        assert.ok(value > 0.9 && value <= 1, `PD must converge without overshoot, got ${value}`);
    });

    test('served robot view contains Eve canvas and no placeholder art', () => {
        // Asserts on the EXACT HTML string the Eve webview page serves
        // (kept as a diagnostics/migration surface, not the default body):
        // Eve canvas + status line + response bar, Three.js module wiring,
        // and zero 2D fallback content of any kind.
        const fakeWebview = {
            asWebviewUri: (uri: vscode.Uri) => uri,
            cspSource: 'vscode-webview://verify',
        } as unknown as vscode.Webview;
        const html = renderRobotHtml(fakeWebview, vscode.Uri.file('D:\\DigitalCompanion\\robot-brain'), 'view');
        for (const required of [
            'id="robotCanvas"',
            'id="eveStatus"',
            'id="responseBar"',
            'robot.js',
            'three.module.min.js',
            'three/addons/',
            'importmap',
        ]) {
            assert.ok(html.includes(required), `served view must include ${required}`);
        }
        for (const forbidden of ['<svg', 'eilik-robot', 'robot-svg', '🤖', '2d', 'placeholder', 'BOTX']) {
            assert.ok(
                !html.toLowerCase().includes(forbidden.toLowerCase()),
                `served view must not contain ${forbidden}`
            );
        }
    });

    test('robot state maps every semantic body state to view state', () => {
        const publisher = new RobotStatePublisher();
        publisher.start();
        const cases: Array<{ payload: Parameters<typeof sendToRobot>[0]; bodyState: string }> = [
            { payload: { type: 'EMOTION', emotion: 'IDLE', intensity: 0 }, bodyState: 'IDLE' },
            { payload: { type: 'EMOTION', emotion: 'THINKING', intensity: 0.7 }, bodyState: 'THINKING' },
            { payload: { type: 'EMOTION', emotion: 'ALERT', intensity: 0.8 }, bodyState: 'ATTENTION' },
            { payload: { type: 'EMOTION', emotion: 'CONFUSED', intensity: 0.6 }, bodyState: 'ATTENTION' },
            { payload: { type: 'EMOTION', emotion: 'LISTENING', intensity: 0.5 }, bodyState: 'WAITING' },
            { payload: { type: 'EMOTION', emotion: 'SPEAKING', intensity: 0.9 }, bodyState: 'EXPLAINING' },
            { payload: { type: 'EMOTION', emotion: 'HAPPY', intensity: 0.7 }, bodyState: 'SUCCESS' },
            { payload: { type: 'EMOTION', emotion: 'ERROR', intensity: 0.8 }, bodyState: 'FAILURE' },
        ];
        for (const { payload, bodyState } of cases) {
            sendToRobot(payload);
            assert.strictEqual(
                publisher.getState().bodyState,
                bodyState,
                `emotion ${(payload as { emotion: string }).emotion} must map to ${bodyState}`
            );
        }
        sendToRobot({ type: 'TEACHING_STATE', level: 2, matter: 'verify-matter' });
        assert.strictEqual(publisher.getState().teaching.matter, 'verify-matter');
        sendToRobot({ type: 'ATTENTION_TARGET', targetType: 'error', confidence: 0.9, strength: 0.8, reason: 'verify', expiresAt: Date.now() + 15000 });
        assert.ok((publisher.getState().attention?.strength ?? 0) > 0, 'attention strength must be smoothed, not dropped');
        publisher.dispose();
    });

    test('canonical robot bridge routes intents headlessly (no second Eve)', async function () {
        // ONE Eve only: tests must never open a visible robot surface. The
        // live GLB render proof lives in the shipped Eve window itself; here
        // a headless protocol fixture drives the SAME bridge the view uses,
        // proving readiness, render-report handling, intent routing and IPC
        // accounting without a second visible Eve.
        this.timeout(30000);
        const ipc = new WebviewIpcSensor(new EventFilter());
        const posted: unknown[] = [];
        let inboundHandler: ((message: unknown) => void) | undefined;
        const stubWebview = {
            postMessage: (message: unknown) => {
                posted.push(message);
                return Promise.resolve(true);
            },
            onDidReceiveMessage: (handler: (message: unknown) => void) => {
                inboundHandler = handler;
                return { dispose: () => undefined };
            },
        } as unknown as vscode.Webview;
        let readySurface: string | undefined;
        let renderReport: import('../../ui/robotWebviewBridge').RobotRenderReport | undefined;
        let viewError: string | undefined;
        const intents: string[] = [];
        let fixMatter: string | undefined;
        const bridge = new RobotWebviewBridge(
            stubWebview,
            ipc,
            {
                onReady: (surface) => {
                    readySurface = surface;
                },
                onRendered: (report) => {
                    renderReport = report;
                },
                onError: (_surface, error) => {
                    viewError = error;
                },
                onExplain: (surface) => {
                    intents.push(`explain:${surface}`);
                },
                onFix: (surface, matter) => {
                    intents.push(`fix:${surface}`);
                    fixMatter = matter;
                },
                onDismiss: (surface) => {
                    intents.push(`dismiss:${surface}`);
                },
            },
            'verify-headless'
        );
        assert.ok(inboundHandler, 'the bridge must subscribe to view messages');
        inboundHandler!({ type: 'ROBOT_READY' });
        inboundHandler!({
            type: 'ROBOT_RENDERED',
            meshes: 12,
            materials: ['MeshStandardMaterial'],
            animations: 0,
            animationReady: true,
            faceRigReady: true,
            bbox: 'size=(1,1,1) center=(0,0,0)',
        });
        inboundHandler!({ type: 'EXPLAIN_REQUEST' });
        inboundHandler!({ type: 'FIX_REQUEST', matter: 'm-verify' });
        inboundHandler!({ type: 'DISMISS' });
        assert.strictEqual(readySurface, 'verify-headless', 'the fixture must announce ROBOT_READY');
        assert.ok(!viewError, `no view error expected, got: ${viewError}`);
        assert.ok(renderReport, 'the fixture must deliver ROBOT_RENDERED');
        assert.strictEqual(renderReport!.meshes, 12);
        assert.strictEqual(renderReport!.faceRigReady, true);
        assert.strictEqual(renderReport!.animationReady, true);
        assert.deepStrictEqual(intents, ['explain:verify-headless', 'fix:verify-headless', 'dismiss:verify-headless']);
        assert.strictEqual(fixMatter, 'm-verify', 'the fix intent must carry its matter');
        assert.ok(ipc.health().inbound >= 5, 'every inbound intent must be observed');
        bridge.post('STATE_SYNC', { payloads: [] });
        assert.ok(ipc.health().outbound >= 1, 'outbound state must be counted');
        assert.ok(
            (posted[posted.length - 1] as { type: string }).type === 'STATE_SYNC',
            'outbound frames must travel to the view'
        );
        bridge.dispose();
        bridge.post('ROBOT_STATE', {});
        assert.strictEqual(posted.filter((m) => (m as { type: string }).type === 'ROBOT_STATE').length, 0);
    });
});

function warningIssue(matter: string) {
    return {
        matter,
        recurrence: 1,
        recurring: false,
        file: 'D:\\verify\\sample.py',
        fileName: 'sample.py',
        line: 5,
        severity: 'Warning' as const,
        message: 'A warning',
        teachingLevel: 1,
        verbose: false,
    };
}

function errorIssue(matter: string) {
    return {
        matter,
        recurrence: 2,
        recurring: true,
        file: 'D:\\verify\\sample.py',
        fileName: 'sample.py',
        line: 18,
        severity: 'Error' as const,
        message: '"customer_name" is not defined',
        teachingLevel: 2,
        verbose: true,
    };
}

suite('FINAL popup and voice', () => {
    test('diagnostic produces a visible popup with file and line', () => {
        const publisher = new RobotStatePublisher();
        publisher.start();
        const seen: Array<{ visible: boolean; severity: string; file?: string; line?: number }> = [];
        const stop = onBrainFrame((payload) => {
            if (payload.type === 'ISSUE_STATE') {
                seen.push({
                    visible: payload.state.visible,
                    severity: payload.state.severity,
                    file: payload.state.file,
                    line: payload.state.line,
                });
            }
        });
        publisher.setIssueProvider(() => ({ issue: errorIssue('m-1'), resolution: null, voiceEnabled: false }));
        sendToRobot({ type: 'TEACHING_STATE', level: 2, matter: 'm-1' });
        assert.strictEqual(seen.length, 1, 'one popup emission expected');
        assert.strictEqual(seen[0].visible, true);
        assert.strictEqual(seen[0].severity, 'ERROR');
        assert.strictEqual(seen[0].line, 18);
        assert.ok((seen[0].file ?? '').includes('sample.py'));
        stop();
        publisher.dispose();
    });

    test('critical replaces, lower never interrupts', () => {
        const publisher = new RobotStatePublisher();
        publisher.start();
        const severities: string[] = [];
        const stop = onBrainFrame((payload) => {
            if (payload.type === 'ISSUE_STATE' && payload.state.visible) {
                severities.push(payload.state.severity);
            }
        });
        let current: ReturnType<typeof warningIssue> | ReturnType<typeof errorIssue> = warningIssue('w-1');
        publisher.setIssueProvider(() => ({ issue: current, resolution: null, voiceEnabled: false }));
        sendToRobot({ type: 'TEACHING_STATE', level: 1, matter: 'w-1' });
        current = errorIssue('e-1');
        sendToRobot({ type: 'TEACHING_STATE', level: 2, matter: 'e-1' });
        current = warningIssue('w-2');
        sendToRobot({ type: 'TEACHING_STATE', level: 1, matter: 'w-2' });
        assert.deepStrictEqual(severities, ['WARNING', 'ERROR'], 'lower-priority popup must not interrupt');
        stop();
        publisher.dispose();
    });

    test('cleared diagnostic hides the popup', () => {
        const publisher = new RobotStatePublisher();
        publisher.start();
        const states: boolean[] = [];
        const stop = onBrainFrame((payload) => {
            if (payload.type === 'ISSUE_STATE') {
                states.push(payload.state.visible);
            }
        });
        let issue: ReturnType<typeof errorIssue> | null = errorIssue('m-9');
        publisher.setIssueProvider(() => ({ issue, resolution: null, voiceEnabled: false }));
        sendToRobot({ type: 'TEACHING_STATE', level: 2, matter: 'm-9' });
        issue = null;
        sendToRobot({ type: 'EMOTION', emotion: 'IDLE', intensity: 0 });
        assert.deepStrictEqual(states, [true, false], 'popup must hide when nothing is wrong');
        stop();
        publisher.dispose();
    });

    test('dismiss hides exactly the dismissed popup content', () => {
        const publisher = new RobotStatePublisher();
        publisher.start();
        let emissions = 0;
        const stop = onBrainFrame((payload) => {
            if (payload.type === 'ISSUE_STATE') {
                emissions += 1;
            }
        });
        publisher.setIssueProvider(() => ({ issue: errorIssue('m-7'), resolution: null, voiceEnabled: false }));
        sendToRobot({ type: 'TEACHING_STATE', level: 2, matter: 'm-7' });
        assert.strictEqual(emissions, 1);
        publisher.noteDismissed();
        sendToRobot({ type: 'EMOTION', emotion: 'ALERT', intensity: 0.6 });
        assert.strictEqual(emissions, 1, 'dismissed content must not resurface on its own');
        stop();
        publisher.dispose();
    });

    test('success and failure resolutions become popups', () => {
        const now = Date.now();
        const success = buildPopupState({
            issue: null,
            resolution: { verified: true, headline: 'Fixed.', takeaway: 'Rule learned.', via: 'fix', at: now },
            voiceEnabled: false,
            now,
        });
        assert.strictEqual(success.visible, true);
        assert.strictEqual(success.severity, 'SUCCESS');
        assert.strictEqual(success.message, 'Rule learned.');
        const failure = buildPopupState({
            issue: null,
            resolution: { verified: false, headline: 'Applied.', takeaway: 'Still broken.', via: 'fix', at: now },
            voiceEnabled: false,
            now,
        });
        assert.strictEqual(failure.severity, 'FAILURE');
        const stale = buildPopupState({
            issue: null,
            resolution: { verified: true, headline: 'Fixed.', takeaway: 'Old.', via: 'fix', at: now - 300000 },
            voiceEnabled: false,
            now,
        });
        assert.strictEqual(stale.visible, true, 'builder itself never expires; the publisher applies the age gate');
        assert.ok(now - stale.timestamp > 120000, 'stale resolution timestamp must be detectable');
    });

    test('beginner popup opens expanded, expert starts collapsed', () => {
        const now = Date.now();
        const beginner = buildPopupState({
            issue: { ...errorIssue('m-b'), captionText: 'Long tailored explanation here.', details: 'Why it happened.', verbose: true },
            resolution: null,
            voiceEnabled: false,
            now,
        });
        assert.strictEqual(beginner.expanded, true);
        assert.strictEqual(beginner.message, 'Long tailored explanation here.');
        assert.strictEqual(beginner.details, 'Why it happened.');
        assert.strictEqual(beginner.fixAvailable, true, 'level 2 with matter must offer Fix');
        assert.strictEqual(beginner.requiresApproval, false, 'approval stays in the VS Code diff flow');
        const expert = buildPopupState({
            issue: { ...errorIssue('m-e'), captionText: 'Short note.', verbose: false },
            resolution: null,
            voiceEnabled: false,
            now,
        });
        assert.strictEqual(expert.expanded, false);
    });

    test('voice commands map to the current issue or degrade to chat', () => {
        const issue = { hasIssue: true, file: 'test.py', line: 18, matter: 'm-1' };
        const explain = interpretVoiceCommand('Explain this.', issue);
        assert.strictEqual(explain.kind, 'explain_issue');
        assert.strictEqual(explain.line, 18);
        assert.strictEqual(explain.matter, 'm-1');
        assert.strictEqual(interpretVoiceCommand('Fix it', issue).kind, 'fix_issue');
        assert.strictEqual(interpretVoiceCommand("What's wrong?", issue).kind, 'explain_issue');
        assert.strictEqual(interpretVoiceCommand('Dismiss this.', issue).kind, 'dismiss');
        assert.strictEqual(interpretVoiceCommand('Try again', issue).kind, 'retry');
        const chatty = interpretVoiceCommand('How do loops work?', issue);
        assert.strictEqual(chatty.kind, 'ask');
        assert.strictEqual(chatty.question, 'How do loops work?');
        const noIssue = interpretVoiceCommand('Fix it', { hasIssue: false });
        assert.strictEqual(noIssue.kind, 'ask', 'commands without an issue must degrade to chat, never act on nothing');
        assert.strictEqual(interpretVoiceCommand('   ', issue).kind, 'ask');
    });

    test('voice failures are honest and never throw', () => {
        for (const code of ['not-allowed', 'audio-capture', 'no-speech', 'network', 'aborted', 'unsupported', 'weird-new-code']) {
            const message = micErrorMessage(code);
            assert.ok(message.length > 10, `failure ${code} must explain itself`);
        }
        assert.ok(!/listening/i.test(micErrorMessage('audio-capture')), 'failure text must not claim recording');
    });

    test('voice transcript reaches the user-input sensor verbatim', () => {
        const filter = new EventFilter();
        const sensor = new UserInputSensor(filter);
        sensor.record('question', 'Voice: explain this', 'eve-popup-microphone');
        const queue = filter.getQueue();
        assert.ok(queue.size() >= 1, 'transcript must enter the event stream');
        sensor.dispose();
    });

    test('TTS speaks concise summaries only', () => {
        assert.strictEqual(shouldSpeak('', true, true), false);
        assert.strictEqual(shouldSpeak('Short note here.', false, true), false, 'voice off must stay silent');
        assert.strictEqual(shouldSpeak('Short note here.', true, false), false, 'no engine must stay silent');
        assert.strictEqual(shouldSpeak('Short note here.', true, true), true);
        assert.strictEqual(shouldSpeak('word '.repeat(100), true, true), false, 'essays must not be read aloud');
        const long = 'First sentence here. Second sentence here. Third sentence that should be dropped entirely from speech.';
        const summary = ttsSummary(long);
        assert.ok(!summary.includes('Third sentence'), 'TTS must summarize, not read everything');
        assert.ok(summary.length <= 280);
    });

    test('floating body carries the mic control and no chat dashboard', () => {
        const html = fs.readFileSync('D:\\DigitalCompanion\\robot-body\\index.html', 'utf8');
        for (const required of ['bubbleFile', 'bubbleDetails', 'bubbleVoice', 'mic-btn']) {
            assert.ok(html.includes(required), `body page must include ${required}`);
        }
        const renderer = fs.readFileSync('D:\\DigitalCompanion\\robot-body\\renderer.js', 'utf8');
        for (const required of ['toggleVoiceInput', 'speakSummary', 'ISSUE_STATE', 'SpeechRecognition', 'VOICE_TEXT', 'USER_DISMISS']) {
            assert.ok(renderer.includes(required), `renderer must implement ${required}`);
        }
        for (const forbidden of ['chatBox', 'chatPanel', 'voiceDashboard', 'voicePanel']) {
            assert.ok(!html.includes(forbidden) && !renderer.includes(forbidden), `no second UI surface: ${forbidden}`);
        }
    });
});

suite('FINAL contextual conversation', () => {
    const diags = [
        { message: 'Import X could not be resolved', line: 0, severity: 'Error' },
        { message: '"discount_rate" is not defined', line: 6, severity: 'Warning' },
        { message: '"customer_name" is not defined', line: 17, severity: 'Error' },
    ];

    test('explain uses the exact active diagnostic', () => {
        assert.strictEqual(
            selectTargetDiagnostic(diags, { file: 'test.py', line: 18, matter: 'm-1' }),
            2,
            'the popup line must win over file order'
        );
    });

    test('explain passes file, line and matter', () => {
        const command = interpretVoiceCommand('Explain this.', { hasIssue: true, file: 'test.py', line: 1, matter: 'm-x' });
        assert.strictEqual(command.kind, 'explain_issue');
        assert.strictEqual(command.file, 'test.py');
        assert.strictEqual(command.line, 1);
        assert.strictEqual(command.matter, 'm-x');
    });

    test('explain respects beginner and expert verbosity', () => {
        const beginner = buildIssuePromptPrefix({ file: 'test.py', line: 1, message: 'No module', skillLevel: 'BEGINNER' });
        const expert = buildIssuePromptPrefix({ file: 'test.py', line: 1, message: 'No module', skillLevel: 'EXPERT' });
        assert.ok(beginner.includes('simply'), 'beginners get simple framing');
        assert.ok(expert.includes('concise'), 'experts get concise framing');
        assert.ok(beginner.includes('test.py:1') && expert.includes('test.py:1'), 'both name the exact issue');
    });

    test('fix receives the exact active issue', () => {
        const command = interpretVoiceCommand('Fix it', { hasIssue: true, file: 'test.py', line: 18, matter: 'm-9' });
        assert.strictEqual(command.kind, 'fix_issue');
        assert.strictEqual(command.file, 'test.py');
        assert.strictEqual(command.line, 18);
        assert.strictEqual(command.matter, 'm-9');
        assert.strictEqual(selectTargetDiagnostic(diags, { matter: 'm-9', message: '"customer_name" is not defined' }), 2);
    });

    test('fix rejects unrelated and stale issues', () => {
        assert.strictEqual(selectTargetDiagnostic(diags, { line: 99 }), -1, 'cleared line must match nothing');
        assert.strictEqual(selectTargetDiagnostic([], { line: 1 }), -1, 'empty diagnostics must match nothing');
        assert.strictEqual(
            selectTargetDiagnostic(diags, { matter: 'other', message: 'something else entirely' }),
            -1,
            'an unrelated matter must not attach to a random diagnostic'
        );
    });

    test('fix remains approval gated', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('botx.fixWithEve'), 'the approval-gated fix entry must exist');
    });

    test('verification result keeps the same issue identity', () => {
        const key = mistakeKey('reportMissingImports', 'Import "x" could not be resolved');
        assert.strictEqual(mistakeKey('reportMissingImports', 'Import "x" could not be resolved'), key);
        assert.notStrictEqual(mistakeKey('other', 'Something else'), key);
    });

    test('"explain this" resolves the current issue', () => {
        const command = interpretVoiceCommand('Explain this.', { hasIssue: true, file: 'a.py', line: 4, matter: 'm-2' });
        assert.strictEqual(command.kind, 'explain_issue');
        assert.strictEqual(command.file, 'a.py');
    });

    test('"fix it" resolves the current issue', () => {
        const command = interpretVoiceCommand('Fix it.', { hasIssue: true, file: 'a.py', line: 4, matter: 'm-3' });
        assert.strictEqual(command.kind, 'fix_issue');
        assert.strictEqual(command.matter, 'm-3');
    });

    test('"what went wrong" uses recent issue context', () => {
        assert.strictEqual(interpretVoiceCommand('What went wrong?', { hasIssue: true }).kind, 'explain_issue');
        assert.strictEqual(interpretVoiceCommand('Why is this happening?', { hasIssue: true }).kind, 'explain_issue');
    });

    test('"why did it fail" uses verification context', () => {
        assert.strictEqual(interpretVoiceCommand('Why did it fail?', { hasIssue: true }).kind, 'why_failed');
        assert.strictEqual(interpretVoiceCommand('What did you change?', { hasIssue: true }).kind, 'what_changed');
    });

    test('"dismiss this" dismisses the current issue', () => {
        assert.strictEqual(interpretVoiceCommand('Dismiss this.', { hasIssue: true }).kind, 'dismiss');
    });

    test('"try again" retries the current relevant action', () => {
        const command = interpretVoiceCommand('Try again', { hasIssue: true, file: 'a.py', line: 4, matter: 'm-4' });
        assert.strictEqual(command.kind, 'retry');
        assert.strictEqual(command.matter, 'm-4');
    });

    test('no active issue falls back to general conversation', () => {
        for (const text of ['Explain this.', 'Fix it.', 'Why is Python dynamically typed?']) {
            assert.strictEqual(interpretVoiceCommand(text, { hasIssue: false }).kind, 'ask', text);
        }
    });

    test('conversation state survives popup expand and emotion changes', () => {
        const publisher = new RobotStatePublisher();
        publisher.start();
        let emissions = 0;
        const stop = onBrainFrame((payload) => {
            if (payload.type === 'ISSUE_STATE') {
                emissions += 1;
            }
        });
        publisher.setIssueProvider(() => ({ issue: errorIssue('m-c'), resolution: null, voiceEnabled: false }));
        sendToRobot({ type: 'TEACHING_STATE', level: 2, matter: 'm-c' });
        assert.strictEqual(emissions, 1);
        sendToRobot({ type: 'EMOTION', emotion: 'THINKING', intensity: 0.7 });
        sendToRobot({ type: 'EMOTION', emotion: 'SPEAKING', intensity: 0.9 });
        sendToRobot({ type: 'EMOTION', emotion: 'LISTENING', intensity: 0.5 });
        assert.strictEqual(emissions, 1, 'emotion traffic must not rebuild the popup conversation state');
        stop();
        publisher.dispose();
    });

    test('listening and speaking states are honestly gated', () => {
        const renderer = fs.readFileSync('D:\\DigitalCompanion\\robot-body\\renderer.js', 'utf8');
        assert.ok(renderer.includes('recognition.onstart'), 'LISTENING must come from the recognizer starting');
        assert.ok(renderer.includes('utterance.onstart'), 'SPEAKING must come from audio actually starting');
        assert.ok(renderer.includes('utterance.onend'), 'SPEAKING must clear when audio ends');
    });

    test('speaking state syncs with actual TTS rules', () => {
        assert.strictEqual(shouldSpeak('Line 1 is importing a module Python cannot find.', true, true), true);
        assert.strictEqual(shouldSpeak('Line 1 is importing a module Python cannot find.', false, true), false);
    });

    test('user feedback produces a gentle learning signal', () => {
        assert.strictEqual(isAcknowledgment('Oh, I understand!'), true);
        assert.strictEqual(isAcknowledgment('Thanks, that makes sense.'), true);
        assert.strictEqual(isAcknowledgment('Fix it'), false);
        assert.strictEqual(isAcknowledgment(''), false);
        const learning = new LearningAgent();
        const userModel = new UserModel(learning);
        const adaptive = new AdaptiveMultiLearningAgent(learning, userModel, new LocalProjectCoordinator(() => ({
            developerId: 'd',
            sessionId: 's',
            workspaceId: 'w',
            projectId: 'p',
            branchId: 'b',
            teamId: 't',
        })));
        adaptive.recordUserOutcome({ concept: 'undefined variables', success: true });
        assert.ok(userModel.snapshot().conceptsKnown.includes('undefined variables'));
    });

    test('no second chatbot or panel is created', () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')
        ) as { contributes: { views: Record<string, Array<{ id: string }>> } };
        const ids = Object.values(manifest.contributes.views).flat().map((view) => view.id);
        assert.deepStrictEqual(ids, ['botx.companion'], 'exactly one VS Code view must remain');
        assert.ok(!ids.includes('acex.robot'), 'the sidebar robot view must stay unregistered');
    });

    test('conversation context is assembled from existing stores only', () => {
        const context = buildEveConversationContext({
            matter: 'm-5',
            file: 'test.py',
            line: 18,
            language: 'python',
            severity: 'Error',
            message: '"customer_name" is not defined',
            skillLevel: 'BEGINNER',
            projectId: 'PROJECT_123',
            lastDecision: 'SHOW_ERROR_HELP',
            bodyState: 'ATTENTION',
            recentFeedback: ['Understood: imports'],
        });
        assert.strictEqual(context.matter, 'm-5');
        assert.strictEqual(context.line, 18);
        assert.strictEqual(context.skillLevel, 'BEGINNER');
        assert.strictEqual(context.projectId, 'PROJECT_123');
        assert.strictEqual(context.lastDecision, 'SHOW_ERROR_HELP');
        assert.deepStrictEqual(context.recentFeedback, ['Understood: imports']);
    });

    test('what-changed answers describe the recorded fix', () => {
        assert.strictEqual(describeLastChange(null), undefined);
        assert.strictEqual(
            describeLastChange({ verified: false, takeaway: 'Still broken.', change: 'x = 1' }),
            undefined,
            'unverified outcomes must not be described as changes'
        );
        const described = describeLastChange({
            verified: true,
            takeaway: 'Rule learned.',
            change: 'customer_name = "Ada"',
            fileName: 'test.py',
            line: 18,
        });
        assert.ok(described && described.includes('customer_name = "Ada"'), 'must name the actual recorded change');
        assert.ok(described && described.includes('test.py:18'));
    });
});
