import { EventType } from "./eventTypes";
import type { AceEventPriority } from "./eventPriority";

export interface AetherEvent {
    id: string;
    type: EventType;
    source: string;
    timestamp: number;
    payload: unknown;
    /**
     * Normalization envelope. Identity and priority unify the different VS Code
     * event shapes into one Ace.X shape. They describe routing and stream
     * control only; semantic meaning remains with Perception.
     */
    priority?: AceEventPriority;
    developerId?: string;
    sessionId?: string;
    workspaceId?: string;
    projectId?: string;
    branchId?: string;
    teamId?: string;
}
