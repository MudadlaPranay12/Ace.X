export enum EventType {
    EDITOR_ACTIVE = "EDITOR_ACTIVE",
    EDITOR_SWITCHED = "EDITOR_SWITCHED",
    EDITOR_OPENED = "EDITOR_OPENED",

    CURSOR_MOVED = "CURSOR_MOVED",

    /** Document activity (DocumentActivitySensor): typing, edits, undo/redo. */
    DOCUMENT_CHANGED = "DOCUMENT_CHANGED",
    DOCUMENT_UNDO = "DOCUMENT_UNDO",
    DOCUMENT_REDO = "DOCUMENT_REDO",
    TYPING_ACTIVITY = "TYPING_ACTIVITY",
    TYPING_IDLE = "TYPING_IDLE",

    FILE_CREATED = "FILE_CREATED",
    FILE_DELETED = "FILE_DELETED",
    FILE_RENAMED = "FILE_RENAMED",
    FILE_SAVED = "FILE_SAVED",

    DIAGNOSTICS_UPDATED = "DIAGNOSTICS_UPDATED",

    /**
     * The complete diagnostic set of one file at one moment (errors + warnings),
     * published alongside the per-diagnostic DIAGNOSTICS_UPDATED events. This is
     * what the batched explanation path and the companion's resolution tracking
     * consume; an empty set is meaningful — it says the file is now clean.
     */
    DIAGNOSTIC_BATCH = "DIAGNOSTIC_BATCH",

    TERMINAL_OPENED = "TERMINAL_OPENED",
    TERMINAL_CLOSED = "TERMINAL_CLOSED",
    TERMINAL_ACTIVE = "TERMINAL_ACTIVE",
    TERMINAL_COMMAND_FAILED = "TERMINAL_COMMAND_FAILED",

    DEBUG_STARTED = "DEBUG_STARTED",
    DEBUG_STOPPED = "DEBUG_STOPPED",
    DEBUG_BREAKPOINT_HIT = "DEBUG_BREAKPOINT_HIT",

    GIT_BRANCH_CHANGED = "GIT_BRANCH_CHANGED",
    GIT_REPOSITORY_CHANGED = "GIT_REPOSITORY_CHANGED",
    GIT_COMMIT_SUCCESS = "GIT_COMMIT_SUCCESS",
    GIT_CONFLICT_DETECTED = "GIT_CONFLICT_DETECTED",
    GIT_CONFLICT_RESOLVED = "GIT_CONFLICT_RESOLVED",

    EXTENSION_INSTALLED = "EXTENSION_INSTALLED",
    EXTENSION_UNINSTALLED = "EXTENSION_UNINSTALLED",
    EXTENSION_ENABLED = "EXTENSION_ENABLED",
    EXTENSION_DISABLED = "EXTENSION_DISABLED",

    STUCK_RAPID_SAVE = "STUCK_RAPID_SAVE",
    STUCK_IDLE_FOCUS = "STUCK_IDLE_FOCUS",

    COMMENT_TRIGGER_DETECTED = "COMMENT_TRIGGER_DETECTED",

    ENVIRONMENT_CHECK = "ENVIRONMENT_CHECK",

    DEPRECATED_API_DETECTED = "DEPRECATED_API_DETECTED",

    /** Natural-language coding intent detected in a comment (e.g., "# hello world"). */
    CODING_INTENT_DETECTED = "CODING_INTENT_DETECTED",

    /** A semantically significant editor jump derived from cursor/editor motion. */
    LINE_NAVIGATED = "LINE_NAVIGATED",

    /** Explicit developer input: commands, questions, approvals and feedback. */
    USER_INPUT = "USER_INPUT",
    USER_QUESTION = "USER_QUESTION",
    USER_APPROVAL = "USER_APPROVAL",
    USER_FEEDBACK = "USER_FEEDBACK",

    /** VS Code Webview ↔ Brain communication observed by the canonical robot view. */
    WEBVIEW_IPC = "WEBVIEW_IPC",

    /** Build, test, runtime or debug output worth reasoning about. */
    SYSTEM_OUTPUT = "SYSTEM_OUTPUT",

    /** Structured local project/team event shared with coordination. */
    PROJECT_EVENT = "PROJECT_EVENT"
}
