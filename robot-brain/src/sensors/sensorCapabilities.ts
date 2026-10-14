import { EventType } from '../eventFilter/eventTypes';

/**
 * The eleven logical Ace.X sensor capabilities.
 *
 * Concrete VS Code listeners may outnumber these capabilities: several narrow
 * sources can contribute to one capability, and a few specialized domain
 * sources support agents without becoming separate logical capabilities. The
 * registry below is the contract that prevents two publishers from owning the
 * same logical capability.
 */
export type SensorCapability =
    | 'diagnostic'
    | 'active-file'
    | 'cursor-position'
    | 'document-save'
    | 'document-content'
    | 'terminal-process'
    | 'idle-timeout'
    | 'line-navigation'
    | 'user-input'
    | 'webview-ipc'
    | 'system-output';

export interface SensorCapabilityDefinition {
    capability: SensorCapability;
    label: string;
    observes: string[];
    sources: string[];
    events: EventType[];
}

export const SENSOR_CAPABILITIES: readonly SensorCapabilityDefinition[] = [
    {
        capability: 'diagnostic',
        label: 'Diagnostic Sensor',
        observes: ['errors', 'warnings', 'compile diagnostics', 'deprecated API use'],
        sources: ['DiagnosticsSensor', 'ImportInspector'],
        events: [EventType.DIAGNOSTICS_UPDATED, EventType.DIAGNOSTIC_BATCH, EventType.DEPRECATED_API_DETECTED],
    },
    {
        capability: 'active-file',
        label: 'Active-File Sensor',
        observes: ['opened file', 'switched file', 'active editor', 'language'],
        sources: ['EditorSensor'],
        events: [EventType.EDITOR_ACTIVE, EventType.EDITOR_SWITCHED, EventType.EDITOR_OPENED],
    },
    {
        capability: 'cursor-position',
        label: 'Cursor-Position Sensor',
        observes: ['line', 'column', 'selection', 'focused region'],
        sources: ['CursorSensor'],
        events: [EventType.CURSOR_MOVED],
    },
    {
        capability: 'document-save',
        label: 'Document-Save Sensor',
        observes: ['save', 'autosave', 'save frequency', 'save patterns'],
        sources: ['FileSensor', 'RapidSaveSensor'],
        events: [
            EventType.FILE_SAVED,
            EventType.FILE_CREATED,
            EventType.FILE_DELETED,
            EventType.FILE_RENAMED,
            EventType.STUCK_RAPID_SAVE,
        ],
    },
    {
        capability: 'document-content',
        label: 'Document-Content Sensor',
        observes: ['insertions', 'deletions', 'undo', 'redo', 'typing', 'coding intent'],
        sources: ['DocumentActivitySensor', 'CommentSensor'],
        events: [
            EventType.DOCUMENT_CHANGED,
            EventType.DOCUMENT_UNDO,
            EventType.DOCUMENT_REDO,
            EventType.TYPING_ACTIVITY,
            EventType.TYPING_IDLE,
            EventType.COMMENT_TRIGGER_DETECTED,
            EventType.CODING_INTENT_DETECTED,
        ],
    },
    {
        capability: 'terminal-process',
        label: 'Terminal / Process Sensor',
        observes: ['commands', 'terminal lifecycle', 'process lifecycle', 'exit codes', 'command completion'],
        sources: ['TerminalSensor', 'DebuggerSensor'],
        events: [
            EventType.TERMINAL_OPENED,
            EventType.TERMINAL_CLOSED,
            EventType.TERMINAL_ACTIVE,
            EventType.TERMINAL_COMMAND_FAILED,
            EventType.DEBUG_STARTED,
            EventType.DEBUG_STOPPED,
            EventType.DEBUG_BREAKPOINT_HIT,
        ],
    },
    {
        capability: 'idle-timeout',
        label: 'Idle-Timeout Sensor',
        observes: ['inactivity', 'prolonged focus', 'repeated save patterns', 'possible stuck behaviour'],
        sources: ['IdleCodeFocusSensor'],
        events: [EventType.STUCK_IDLE_FOCUS],
    },
    {
        capability: 'line-navigation',
        label: 'Line-Navigation Sensor',
        observes: ['definition/reference jumps', 'navigation', 'repeated navigation', 'returns to a location'],
        sources: ['LineNavigationSensor'],
        events: [EventType.LINE_NAVIGATED],
    },
    {
        capability: 'user-input',
        label: 'User-Input Sensor',
        observes: ['commands', 'questions', 'approval', 'rejection', 'feedback'],
        sources: ['UserInputSensor'],
        events: [
            EventType.USER_INPUT,
            EventType.USER_QUESTION,
            EventType.USER_APPROVAL,
            EventType.USER_FEEDBACK,
        ],
    },
    {
        capability: 'webview-ipc',
        label: 'Webview-IPC Sensor',
        observes: ['VS Code Webview to Brain communication'],
        sources: ['WebviewIpcSensor'],
        events: [EventType.WEBVIEW_IPC],
    },
    {
        capability: 'system-output',
        label: 'System-Output Sensor',
        observes: ['build output', 'test output', 'runtime output', 'execution results'],
        sources: ['SystemOutputSensor', 'EnvironmentSensor'],
        events: [EventType.SYSTEM_OUTPUT, EventType.ENVIRONMENT_CHECK],
    },
];

/**
 * Specialized concrete sources that remain active for agents and context but
 * are not separate logical capabilities.
 */
export const SUPPORTING_SENSORS: readonly string[] = [
    'GitSensor',
    'GitConflictSensor',
    'ExtensionSensor',
];
