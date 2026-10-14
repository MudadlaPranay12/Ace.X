import * as vscode from 'vscode';
import type { BehaviourController } from '../behaviour/behaviourController';
import type { EventFilter } from '../eventFilter/eventFilter';
import { Logger } from '../utils/logger';
import { DiagnosticsSensor } from './diagnosticsSensor';
import { EditorSensor } from './editorSensor';
import { CursorSensor } from './cursorSensor';
import { FileSensor } from './fileSensor';
import { TerminalSensor } from './terminalSensor';
import { DebuggerSensor } from './debuggerSensor';
import { RapidSaveSensor } from './rapidSaveSensor';
import { IdleCodeFocusSensor } from './idleCodeFocusSensor';
import { CommentSensor } from './commentSensor';
import { ExtensionSensor } from './extensionSensor';
import { GitSensor } from './gitSensor';
import { GitConflictSensor } from './gitConflictSensor';
import { EnvironmentSensor } from './environmentSensor';
import { ImportInspector } from './importInspector';
import { DocumentActivitySensor } from './documentActivitySensor';
import { LineNavigationSensor } from './lineNavigationSensor';
import { UserInputSensor } from './userInputSensor';
import { WebviewIpcSensor } from './webviewIpcSensor';
import { SystemOutputSensor } from './systemOutputSensor';
import { SENSOR_CAPABILITIES, SUPPORTING_SENSORS, type SensorCapability } from './sensorCapabilities';

export interface SensorHealth {
    started: string[];
    capabilities: SensorCapability[];
    supportingSensors: readonly string[];
}

/**
 * Starts and owns every concrete sensor exactly once.
 *
 * Existing sensors keep their own listeners, payloads and disposal behavior.
 * New sensors only cover capabilities that had no publisher: settled line
 * navigation, explicit user input, canonical Webview IPC and debug-system
 * output. The capability registry remains exactly eleven entries.
 */
export class SensorCoordinator {
    private readonly eventFilter: EventFilter;
    private readonly behaviour: BehaviourController | undefined;
    private readonly diagnostics: DiagnosticsSensor;
    private readonly editor: EditorSensor;
    private readonly cursor: CursorSensor;
    private readonly file: FileSensor;
    private readonly terminal: TerminalSensor;
    private readonly debugger: DebuggerSensor;
    private readonly rapidSave: RapidSaveSensor;
    private readonly idle: IdleCodeFocusSensor;
    private readonly comment: CommentSensor;
    private readonly extension: ExtensionSensor;
    private readonly git: GitSensor;
    private readonly gitConflict: GitConflictSensor;
    private readonly environment: EnvironmentSensor;
    private readonly imports: ImportInspector;
    private readonly documentActivity: DocumentActivitySensor;
    private readonly lineNavigation: LineNavigationSensor;
    private readonly userInput: UserInputSensor;
    private readonly webviewIpc: WebviewIpcSensor;
    private readonly systemOutput: SystemOutputSensor;

    constructor(eventFilter: EventFilter, behaviour?: BehaviourController) {
        this.eventFilter = eventFilter;
        this.behaviour = behaviour;
        this.diagnostics = new DiagnosticsSensor(eventFilter);
        this.editor = new EditorSensor(eventFilter);
        this.cursor = new CursorSensor(eventFilter);
        this.file = new FileSensor(eventFilter);
        this.terminal = new TerminalSensor(eventFilter);
        this.debugger = new DebuggerSensor(eventFilter);
        this.rapidSave = new RapidSaveSensor(eventFilter);
        this.idle = new IdleCodeFocusSensor(eventFilter);
        this.comment = new CommentSensor(eventFilter);
        this.extension = new ExtensionSensor(eventFilter);
        this.git = new GitSensor(eventFilter, behaviour);
        this.gitConflict = new GitConflictSensor(eventFilter);
        this.environment = new EnvironmentSensor(eventFilter);
        this.imports = new ImportInspector(eventFilter);
        this.documentActivity = new DocumentActivitySensor(eventFilter);
        this.lineNavigation = new LineNavigationSensor(eventFilter);
        this.userInput = new UserInputSensor(eventFilter);
        this.webviewIpc = new WebviewIpcSensor(eventFilter);
        this.systemOutput = new SystemOutputSensor(eventFilter);
    }

    start(context: vscode.ExtensionContext): SensorHealth {
        this.diagnostics.start(context);
        console.log('[BotX] DiagnosticsSensor started');
        this.editor.start(context);
        console.log('[BotX] EditorSensor started');
        this.cursor.start(context);
        console.log('[BotX] CursorSensor started');
        this.file.start(context);
        console.log('[BotX] FileSensor started');
        this.terminal.start(context);
        console.log('[BotX] TerminalSensor started');
        this.debugger.start(context);
        console.log('[BotX] DebuggerSensor started');
        this.rapidSave.start(context);
        console.log('[BotX] RapidSaveSensor started');
        this.idle.start(context);
        console.log('[BotX] IdleCodeFocusSensor started');
        this.comment.start(context);
        console.log('[BotX] CommentSensor started');
        this.extension.start(context);
        console.log('[BotX] ExtensionSensor started');
        this.git.start(context);
        console.log('[BotX] GitSensor started');
        this.gitConflict.start(context);
        console.log('[BotX] GitConflictSensor started');
        this.environment.start(context);
        console.log('[BotX] EnvironmentSensor started');
        this.imports.start(context);
        console.log('[BotX] ImportInspector started');
        this.documentActivity.start(context);
        console.log('[BotX] DocumentActivitySensor started');
        this.lineNavigation.start(context);
        console.log('[BotX] LineNavigationSensor started');
        this.userInput.start(context);
        console.log('[BotX] UserInputSensor started');
        this.webviewIpc.start(context);
        console.log('[BotX] WebviewIpcSensor started');
        this.systemOutput.start(context);
        console.log('[BotX] SystemOutputSensor started');

        console.log('[BotX] All class-based sensors registered with EventFilter');
        Logger.info('SENSORS', {
            Event: 'All sensor capabilities started',
            Capabilities: String(SENSOR_CAPABILITIES.length),
            Supporting: SUPPORTING_SENSORS.join(', '),
        });
        return this.health();
    }

    getUserInput(): UserInputSensor {
        return this.userInput;
    }

    getWebviewIpc(): WebviewIpcSensor {
        return this.webviewIpc;
    }

    getLineNavigation(): LineNavigationSensor {
        return this.lineNavigation;
    }

    getSystemOutput(): SystemOutputSensor {
        return this.systemOutput;
    }

    health(): SensorHealth {
        return {
            started: [
                'DiagnosticsSensor',
                'EditorSensor',
                'CursorSensor',
                'FileSensor',
                'TerminalSensor',
                'DebuggerSensor',
                'RapidSaveSensor',
                'IdleCodeFocusSensor',
                'CommentSensor',
                'ExtensionSensor',
                'GitSensor',
                'GitConflictSensor',
                'EnvironmentSensor',
                'ImportInspector',
                'DocumentActivitySensor',
                'LineNavigationSensor',
                'UserInputSensor',
                'WebviewIpcSensor',
                'SystemOutputSensor',
            ],
            capabilities: SENSOR_CAPABILITIES.map((entry) => entry.capability),
            supportingSensors: SUPPORTING_SENSORS,
        };
    }
}
