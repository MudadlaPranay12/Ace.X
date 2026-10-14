import { EventType } from './eventTypes';

/**
 * Canonical Ace.X event priority.
 *
 * Priority is a stream-control property, not an AI judgment. It keeps rare,
 * actionable signals from being starved by high-frequency cursor and typing
 * traffic when the bounded queue comes under load.
 */
export type AceEventPriority = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

export function defaultPriorityForEventType(type: EventType): AceEventPriority {
    switch (type) {
        case EventType.GIT_CONFLICT_DETECTED:
        case EventType.DEBUG_BREAKPOINT_HIT:
        case EventType.USER_APPROVAL:
        case EventType.USER_FEEDBACK:
            return 'CRITICAL';
        case EventType.DIAGNOSTICS_UPDATED:
        case EventType.DIAGNOSTIC_BATCH:
        case EventType.TERMINAL_COMMAND_FAILED:
        case EventType.SYSTEM_OUTPUT:
        case EventType.CODING_INTENT_DETECTED:
        case EventType.USER_QUESTION:
            return 'HIGH';
        case EventType.EDITOR_ACTIVE:
        case EventType.EDITOR_SWITCHED:
        case EventType.EDITOR_OPENED:
        case EventType.FILE_SAVED:
        case EventType.FILE_CREATED:
        case EventType.FILE_DELETED:
        case EventType.FILE_RENAMED:
        case EventType.LINE_NAVIGATED:
        case EventType.DOCUMENT_CHANGED:
        case EventType.DOCUMENT_UNDO:
        case EventType.DOCUMENT_REDO:
        case EventType.WEBVIEW_IPC:
        case EventType.PROJECT_EVENT:
            return 'NORMAL';
        default:
            return 'LOW';
    }
}

export function comparePriority(left: AceEventPriority, right: AceEventPriority): number {
    const order: Record<AceEventPriority, number> = {
        CRITICAL: 0,
        HIGH: 1,
        NORMAL: 2,
        LOW: 3,
    };
    return order[left] - order[right];
}
