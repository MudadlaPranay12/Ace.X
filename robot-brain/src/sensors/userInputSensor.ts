import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { Logger } from '../utils/logger';

export type UserInputKind = 'command' | 'question' | 'approval' | 'rejection' | 'feedback';

export interface RecordedUserInput {
    kind: UserInputKind;
    label: string;
    detail?: string;
    timestamp: number;
}

const MAX_INPUT_ENTRIES = 50;

function eventTypeFor(kind: UserInputKind): EventType {
    switch (kind) {
        case 'question':
            return EventType.USER_QUESTION;
        case 'approval':
            return EventType.USER_APPROVAL;
        case 'rejection':
        case 'feedback':
            return EventType.USER_FEEDBACK;
        case 'command':
        default:
            return EventType.USER_INPUT;
    }
}

/**
 * User-input capability.
 *
 * There is intentionally no global VS Code command listener: explicit calls
 * from commands, approval dialogs, robot-view actions and feedback paths are
 * the only honest source for what the developer asked, approved, rejected or
 * reported. This class is therefore the single publisher for that capability.
 */
export class UserInputSensor {
    private readonly eventFilter: EventFilter;
    private readonly recent: RecordedUserInput[] = [];

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }

    start(context: vscode.ExtensionContext): void {
        context.subscriptions.push({ dispose: () => this.dispose() });
        Logger.info('USER INPUT SENSOR', { Event: 'Started' });
    }

    record(kind: UserInputKind, label: string, detail?: string): void {
        const entry: RecordedUserInput = {
            kind,
            label,
            detail,
            timestamp: Date.now(),
        };
        this.recent.push(entry);
        if (this.recent.length > MAX_INPUT_ENTRIES) {
            this.recent.splice(0, this.recent.length - MAX_INPUT_ENTRIES);
        }
        this.eventFilter.publish({
            id: `user-input-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            type: eventTypeFor(kind),
            source: 'UserInputSensor',
            timestamp: entry.timestamp,
            payload: {
                Kind: kind,
                Label: label,
                Detail: detail ?? '',
            },
        });
        Logger.info('USER INPUT SENSOR', {
            Event: `User ${kind}`,
            Label: label.slice(0, 120),
        });
    }

    getRecent(): RecordedUserInput[] {
        return [...this.recent];
    }

    dispose(): void {
        this.recent.length = 0;
    }
}
