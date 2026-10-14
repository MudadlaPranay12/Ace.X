import type { RobotPayload } from '../utils/websocketServer';

/**
 * Canonical semantic robot state.
 *
 * The Brain owns this state; the VS Code Webview only maps it onto Eve's
 * pose, face, animation and response bar. No cognitive decision ever happens
 * in the view.
 */
export type RobotBodyState =
    | 'IDLE'
    | 'THINKING'
    | 'ATTENTION'
    | 'EXPLAINING'
    | 'WAITING'
    | 'EXECUTING'
    | 'VERIFYING'
    | 'SUCCESS'
    | 'FAILURE'
    | 'DISCONNECTED';

export type RobotLinkState = 'connecting' | 'connected' | 'disconnected';

export interface RobotViewState {
    bodyState: RobotBodyState;
    link: RobotLinkState;
    emotion?: string;
    intensity: number;
    caption?: { text: string; holdMs?: number };
    teaching: { level: number; matter: string; concept?: string; recurrence?: number };
    struggle?: { level: number; evidence: string[] };
    attention?: { targetType: string; strength: number };
    updatedAt: number;
}

export interface RobotFrame {
    state: RobotViewState;
    /** The exact Brain payload that triggered this frame, for protocol reuse. */
    payload: RobotPayload;
}

export function initialRobotViewState(): RobotViewState {
    return {
        bodyState: 'IDLE',
        link: 'connecting',
        intensity: 0,
        teaching: { level: 0, matter: '' },
        updatedAt: Date.now(),
    };
}
