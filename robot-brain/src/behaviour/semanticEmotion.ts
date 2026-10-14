import type { EmotionName } from '../core/types';
import { emitEmotion } from './emotionMapper';
import { sendToRobot } from '../utils/websocketServer';

/**
 * semanticEmotion — the ONE central semantic state → emotion mapping.
 *
 * The Brain reasons in product-level semantic states (THINKING, LISTENING,
 * WAITING_FOR_APPROVAL, VERIFYING, ...); the Body renders the closed
 * 8-emotion vocabulary (robot-body/behaviour/emotion.js) plus intensity.
 * This module is the single place where the first resolves onto the
 * second. No other file maps semantic states to emotions — voice,
 * diagnostics, popup, success and fix flows all resolve through here.
 *
 * Priority (§23) is owned by the Body's BehaviourController (holds,
 * dedupe, single-slot queue); the export below only documents the intended
 * ordering so callers and tests agree on what outranks what. Durations and
 * settling transitions live in the Body, never as locks here.
 */

export type SemanticRobotState =
    | 'IDLE'
    | 'ATTENTION'
    | 'THINKING'
    | 'LISTENING'
    | 'PROCESSING'
    | 'WRITING'
    | 'TEACHING'
    | 'FIXING'
    | 'EXPLAINING'
    | 'WAITING_FOR_APPROVAL'
    | 'EXECUTING'
    | 'VERIFYING'
    | 'SUCCESS'
    | 'FAILURE'
    | 'ERROR'
    | 'STRUGGLE'
    | 'DISCONNECTED';

export type LifecycleState = SemanticRobotState | 'WRITING' | 'TEACHING' | 'FIXING' | 'RECONNECTING';

export interface ResolvedEmotion {
    emotion: EmotionName;
    /** 0..1 expression scale. Severity moves it; calm states stay low. */
    intensity: number;
    reason: string;
}

/**
 * Intended precedence, highest first. The Body enforces this through its
 * own arbitration — this list is documentation plus test oracle, never a
 * lock: every entry still settles through holds, never permanently.
 */
export const SEMANTIC_PRIORITY: readonly SemanticRobotState[] = [
    'ERROR',
    'FAILURE',
    'SUCCESS',
    'WAITING_FOR_APPROVAL',
    'EXECUTING',
    'VERIFYING',
    'EXPLAINING',
    'PROCESSING',
    'WRITING',
    'TEACHING',
    'FIXING',
    'LISTENING',
    'THINKING',
    'ATTENTION',
    'STRUGGLE',
    'IDLE',
    'DISCONNECTED',
];

/**
 * Resolves one semantic state onto the Body's emotion vocabulary.
 *
 * Severity only modulates intensity and the ERROR/WARNING split — it never
 * invents a new emotion. Healthy monitoring resolves to a calm, low
 * IDLE: "calm + alive + aware" comes from the Body's breathing/drift/gaze
 * at rest, not from a stronger emotion here.
 */
export function resolveSemanticEmotion(
    state: SemanticRobotState,
    options: { severity?: string } = {}
): ResolvedEmotion {
    const severity = (options.severity || '').toLowerCase();
    switch (state) {
        case 'IDLE':
            return { emotion: 'IDLE', intensity: 0.5, reason: 'healthy monitoring — calm and alive at rest' };
        case 'ATTENTION':
            return { emotion: 'LISTENING', intensity: 0.6, reason: 'attentive, watching the active context' };
        case 'THINKING':
            return { emotion: 'THINKING', intensity: 0.7, reason: 'agents/ACES reasoning in progress' };
        case 'LISTENING':
            return { emotion: 'LISTENING', intensity: 0.7, reason: 'microphone actually recording' };
        case 'PROCESSING':
            return { emotion: 'THINKING', intensity: 0.7, reason: 'voice transcript handed to the Brain' };
        case 'WRITING':
            return { emotion: 'THINKING', intensity: 0.75, reason: 'code generation and insertion in progress' };
        case 'TEACHING':
            return { emotion: 'SPEAKING', intensity: 0.8, reason: 'teaching the requested concept' };
        case 'FIXING':
            return { emotion: 'THINKING', intensity: 0.75, reason: 'approved fix workflow in progress' };
        case 'EXPLAINING':
            return { emotion: 'SPEAKING', intensity: 0.85, reason: 'delivering an explanation' };
        case 'WAITING_FOR_APPROVAL':
            return { emotion: 'LISTENING', intensity: 0.65, reason: 'fix proposed — attentive wait for approval' };
        case 'EXECUTING':
            return { emotion: 'THINKING', intensity: 0.75, reason: 'approved fix being applied' };
        case 'VERIFYING':
            return { emotion: 'THINKING', intensity: 0.65, reason: 'checking real diagnostic state' };
        case 'SUCCESS':
            return { emotion: 'HAPPY', intensity: 0.75, reason: 'fix verified — brief celebration, then settle' };
        case 'FAILURE':
            // Concern, not alarm: the edit applied but the problem remains.
            return { emotion: 'ALERT', intensity: 0.7, reason: 'applied but not verified' };
        case 'ERROR':
            if (severity === 'warning') {
                // Warnings read as focused curiosity, never full panic.
                return { emotion: 'ALERT', intensity: 0.6, reason: 'warning — attentive, not alarmed' };
            }
            return { emotion: 'ERROR', intensity: 0.85, reason: 'real error — concerned, gaze to context' };
        case 'STRUGGLE':
            // Empathetic concern at low strength, from existing evidence only.
            return { emotion: 'ALERT', intensity: 0.55, reason: 'strong struggle evidence — supportive' };
        case 'DISCONNECTED':
            // The Body's link overlay renders the DISCONNECTED pose itself;
            // the emotion label stays a quiet rest so it cannot fight the pose.
            return { emotion: 'IDLE', intensity: 0.3, reason: 'link overlay owns the disconnected read' };
    }
}

/**
 * Emits the resolved emotion for one semantic state. The Body's hold/dedupe
 * keeps this spam-free: repeats inside the dedupe window only extend, and
 * lower-priority arrivals queue behind important ones.
 */
export function emitSemanticEmotion(
    state: SemanticRobotState,
    options: { severity?: string; duration?: number } = {}
): ResolvedEmotion {
    const resolved = resolveSemanticEmotion(state, options);
    emitEmotion(resolved.emotion, { intensity: resolved.intensity, duration: options.duration });
    // The Body receives the product lifecycle state as data and maps it onto
    // its existing closed pose vocabulary. It never decides this state.
    emitLifecycleState(state);
    return resolved;
}

export function emitLifecycleState(state: LifecycleState, requestId?: string, detail?: string): void {
    sendToRobot({ type: 'LIFECYCLE_STATE', state, requestId, detail } as any);
}
