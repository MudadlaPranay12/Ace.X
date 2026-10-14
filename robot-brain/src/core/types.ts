export type AvatarExpression =
    | 'happy'
    | 'sad'
    | 'confused'
    | 'thinking'
    | 'neutral'
    | 'idle'
    | 'worried'
    | 'shocked'
    | 'sleeping';

export type AvatarAction = 'JUMP' | 'SHAKE' | 'ALERT_RED' | 'NOD' | 'POINT_LEFT' | 'NONE';

export type AvatarAnimation = 'nod' | 'shake' | 'raise-hand' | 'point' | 'gesture';

/**
 * Visibility control for the Robot Body's own window. Handled in the Body's
 * Electron main process (it owns the BrowserWindow), never forwarded on to the
 * Three.js renderer.
 */
export interface WindowVisibilityPayload {
    type: 'WINDOW_VISIBILITY';
    visible: boolean;
}

export interface RobotCommand {
    type: 'ROBOT_STATE';
    expression: AvatarExpression;
    action: AvatarAction;
    speechBubble?: string;
    duration?: number;
    targetX?: number;
    targetY?: number;
    alignment?: 'left-editor' | 'right-editor' | 'bottom-panel' | 'floating';
}

export interface WindowAnchorPayload {
    type: 'WINDOW_ANCHOR';
    targetX: number;
    targetY: number;
    alignment: 'left-editor' | 'right-editor' | 'bottom-panel' | 'floating';
}

/** Brings an already-running Eve window to the front. No new instance. */
export interface WindowFocusPayload {
    type: 'WINDOW_FOCUS';
}

/**
 * Toggles (or explicitly sets, when `enabled` is present) the Eve window's
 * always-on-top state. The Body owns the flag and persists it.
 */
export interface WindowAlwaysOnTopPayload {
    type: 'WINDOW_ALWAYS_ON_TOP';
    enabled?: boolean;
}

/** Restores Eve's default position and size, then persists them. */
export interface WindowGeometryResetPayload {
    type: 'WINDOW_GEOMETRY_RESET';
}

/**
 * Floating-body handshake. The Body announces itself with HELLO on connect;
 * the Brain answers on that same socket with BRAIN_READY plus a STATE_SYNC
 * carrying the current canonical frames — never a replay of stale motion.
 */
export interface BodyHelloPayload {
    type: 'HELLO';
    client: string;
    version: string;
}

export interface BrainReadyPayload {
    type: 'BRAIN_READY';
    state: 'observing';
}

export interface BrainStateSyncPayload {
    type: 'STATE_SYNC';
    payloads: RobotPayload[];
}

export type CursorMovePayload = { type: 'CURSOR_MOVE'; relativeX: number; relativeY: number };
export type ActionPayload = { type: 'ACTION'; animation?: string; speech?: string };
export type EditorChangedPayload = { type: 'EDITOR_CHANGED' };
export type UserDismissPayload = { type: 'USER_DISMISS' };

/** Popup severity for the floating Eve intervention bar. */
export type PopupSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL' | 'SUCCESS' | 'FAILURE';

/**
 * The ONE structured intervention frame for the Eve popup bar. Derived from
 * existing Brain evidence (current issue, teaching rung, verified
 * resolutions) — never a second issue feed, never prose to parse.
 */
export interface IssueStatePayload {
    type: 'ISSUE_STATE';
    state: {
        visible: boolean;
        severity: PopupSeverity;
        title: string;
        message: string;
        details?: string;
        file?: string;
        filePath?: string;
        line?: number;
        column?: number;
        matter?: string;
        expanded: boolean;
        fixAvailable: boolean;
        requiresApproval: boolean;
        voiceAvailable: boolean;
        timestamp: number;
    };
}

/**
 * Every Brain→consumer frame. One closed union so every consumer — the
 * floating Electron Eve, the diagnostics Webview, the panel — sees exactly
 * the same frames with no second copy of any decision.
 */
export type RobotPayload =
    | { type: 'LIFECYCLE_STATE'; state: 'IDLE' | 'LISTENING' | 'THINKING' | 'WRITING' | 'EXPLAINING' | 'TEACHING' | 'FIXING' | 'WAITING_FOR_APPROVAL' | 'VERIFYING' | 'SUCCESS' | 'FAILURE' | 'RECONNECTING' | 'DISCONNECTED'; requestId?: string; detail?: string }
    | { type: 'EVE_RESPONSE'; requestId: string; kind: 'explain' | 'chat'; status: 'loading' | 'success' | 'error'; text: string; issueKey?: string }
    | { type: 'CHAT_OPEN' }
    | CursorMovePayload
    | ActionPayload
    | EditorChangedPayload
    | UserDismissPayload
    | RobotCommand
    | WindowAnchorPayload
    | WindowFocusPayload
    | WindowAlwaysOnTopPayload
    | WindowGeometryResetPayload
    | RobotStateUpdatePayload
    | WindowVisibilityPayload
    | EmotionPayload
    | AttentionTargetPayload
    | TeachingStatePayload
    | CaptionPayload
    | StruggleStatePayload
    | HostWindowStatePayload
    | IssueStatePayload;

/**
 * The canonical emotion channel. This is the only message that can express a
 * feeling AND how strongly it is felt, which is why the Brain prefers it over
 * overloading `RobotCommand.expression` (which is a fixed AvatarExpression set
 * with no intensity dimension).
 *
 * The Body validates against this exact vocabulary and ignores anything else,
 * so the set is deliberately closed: adding a value here requires a Body pose and
 * expression to exist for it.
 *
 * `duration` is the hold time in ms. Omit it to let the Body use its own
 * default per emotion (short for reactions, long for in-progress states).
 */
export type EmotionName =
    | 'IDLE'
    | 'LISTENING'
    | 'THINKING'
    | 'SPEAKING'
    | 'HAPPY'
    | 'CONFUSED'
    | 'ALERT'
    | 'ERROR';

export interface EmotionPayload {
    type: 'EMOTION';
    emotion: EmotionName;
    /** 0 = rest, 1 = full expression. Body clamps anything outside 0..1. */
    intensity?: number;
    /** Caption shown under the robot; also drives mouth articulation for SPEAKING. */
    speech?: string;
    /** Explicit hold time in ms; overrides the Body's per-emotion default. */
    duration?: number;
}

export interface RobotStateUpdatePayload {
    type: 'ROBOT_STATE_UPDATE';
    payload: {
        expression: string;
        speechBubble: string;
        fixCount: number;
        timestamp: number;
        errorText?: string;
        filePath?: string;
        line?: number;
        severity?: string;
    };
}

/**
 * What the Brain wants the Body to look toward. The Brain is the only system
 * allowed to compute this; the Body only translates it to an approximate gaze
 * direction. There is deliberately no absolute editor screen coordinate here —
 * VS Code does not expose one — so the Body must phrase/express this as
 * "look toward the region", never precise pointing.
 */
export type AttentionTargetType =
    | 'error'
    | 'warning'
    | 'cursor'
    | 'changed-line'
    | 'active-symbol'
    | 'current-file';

export interface AttentionTargetPayload {
    type: 'ATTENTION_TARGET';
    targetType: AttentionTargetType;
    file?: string;
    line?: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
    /** 0..1 — how certain the Brain is that this is the right thing to attend to. */
    confidence: number;
    /** 0..1 — how urgently the Body should move its gaze there. */
    strength: number;
    reason: string;
    /** Epoch ms after which the Body must drop this target. */
    expiresAt: number;
}

/** The teaching ladder. 0 = silent observation, 4 = direct fix. */
export type TeachingLevel = 0 | 1 | 2 | 3 | 4;

export interface TeachingStatePayload {
    type: 'TEACHING_STATE';
    level: TeachingLevel;
    /** The concept/mistake this rung is teaching, stable across recurrences. */
    matter: string;
    concept?: string;
    /** How many times the same mistake has recurred. */
    recurrence?: number;
    /** Skill level the level was chosen for (informational). */
    skillLevel?: string;
}

/** CAPTION is the default expression channel; TTS is a future, optional sink. */
export type CommunicationMode = 'CAPTION' | 'TTS';

export interface CaptionPayload {
    type: 'CAPTION';
    text: string;
    mode: CommunicationMode;
    duration?: number;
}

/**
 * Deterministic struggle estimate from coding behaviour only (no camera, no
 * affect inference). The Body may accent it but never re-derives it.
 */
export interface StruggleStatePayload {
    type: 'STRUGGLE_STATE';
    /** 0 = not struggling, 1 = strongly struggling. */
    level: number;
    evidence: string[];
    confidence: number;
    expiresAt: number;
}

/**
 * Authoritative VS Code window state from the Brain (VS Code extension).
 * The Brain knows when VS Code is focused/minimized via vscode.window APIs.
 * The Body must obey this for visibility; it only computes position.
 */
export interface HostWindowStatePayload {
    type: 'HOST_WINDOW_STATE';
    /** True when VS Code window has focus (is the active window). */
    focused: boolean;
    /** True when VS Code window is minimized. */
    minimized: boolean;
}
