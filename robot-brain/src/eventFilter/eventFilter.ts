import { AetherEvent } from "./event";
import { EventQueue } from "./eventQueue";
import { DuplicateFilter } from "./duplicateFilter";
import { EventDebouncer } from "./eventDebounce";
import { comparePriority, defaultPriorityForEventType, type AceEventPriority } from "./eventPriority";
import { validateAetherEvent } from "./eventValidator";
import type { AceIdentity } from "../identity/identityTypes";
import { Logger } from "../utils/logger";

type EventListener = (event: AetherEvent) => void;
export type IdentityProvider = () => AceIdentity;

/**
 * When the bounded queue is this full, LOW events are shed before they can
 * displace actionable diagnostics, failures and explicit user decisions.
 */
const LOAD_SHED_QUEUE_SIZE = 400;
const LOWEST_ADMITTED_PRIORITY_UNDER_LOAD: AceEventPriority = 'NORMAL';

export class EventFilter {
    private queue: EventQueue;
    private duplicateFilter: DuplicateFilter;
    private debouncer: EventDebouncer;
    private listeners: Set<EventListener> = new Set();
    private identityProvider: IdentityProvider | undefined;

    constructor() {
        this.queue = new EventQueue();
        this.duplicateFilter = new DuplicateFilter();
        this.debouncer = new EventDebouncer();
    }

    setIdentityProvider(provider: IdentityProvider | undefined): void {
        this.identityProvider = provider;
    }

    publish(event: AetherEvent): void {
        const normalized = this.normalize(event);
        const validation = validateAetherEvent(normalized);
        if (!validation.valid) {
            Logger.info("EVENT FILTER", {
                "Event": "Event rejected (invalid)",
                "Type": String(event?.type ?? "unknown"),
                "Source": String(event?.source ?? "unknown"),
                "Reason": validation.reason ?? "unknown",
                "Queue size": this.queue.size()
            });
            return;
        }

        if (this.duplicateFilter.isDuplicate(normalized)) {
            Logger.info("EVENT FILTER", {
                "Event": "Event rejected (duplicate)",
                "Type": normalized.type,
                "Source": normalized.source,
                "Queue size": this.queue.size()
            });
            return;
        }

        if (this.debouncer.shouldDrop(normalized)) {
            Logger.info("EVENT FILTER", {
                "Event": "Event rejected (debounced)",
                "Type": normalized.type,
                "Source": normalized.source,
                "Queue size": this.queue.size()
            });
            return;
        }

        if (this.isShedUnderLoad(normalized.priority ?? 'NORMAL')) {
            Logger.info("EVENT FILTER", {
                "Event": "Event rejected (load shed)",
                "Type": normalized.type,
                "Source": normalized.source,
                "Priority": normalized.priority ?? 'NORMAL',
                "Queue size": this.queue.size()
            });
            return;
        }

        this.queue.enqueue(normalized);

        Logger.info("EVENT FILTER", {
            "Event": "Event accepted",
            "Type": normalized.type,
            "Source": normalized.source,
            "Priority": normalized.priority ?? 'NORMAL',
            "Queue size": this.queue.size()
        });

        for (const listener of this.listeners) {
            listener(normalized);
        }
    }

    subscribe(listener: EventListener): void {
        this.listeners.add(listener);
    }

    unsubscribe(listener: EventListener): void {
        this.listeners.delete(listener);
    }

    getQueue(): EventQueue {
        return this.queue;
    }

    clear(): void {
        this.queue.clear();
        this.duplicateFilter.clear();
        this.debouncer.clear();
        this.listeners.clear();
    }

    private normalize(event: AetherEvent): AetherEvent {
        const identity = this.identityProvider?.();
        return {
            ...event,
            id: event.id || `ace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
            timestamp: event.timestamp || Date.now(),
            priority: event.priority ?? defaultPriorityForEventType(event.type),
            developerId: event.developerId ?? identity?.developerId,
            sessionId: event.sessionId ?? identity?.sessionId,
            workspaceId: event.workspaceId ?? identity?.workspaceId,
            projectId: event.projectId ?? identity?.projectId,
            branchId: event.branchId ?? identity?.branchId,
            teamId: event.teamId ?? identity?.teamId,
        };
    }

    private isShedUnderLoad(priority: AceEventPriority): boolean {
        return (
            this.queue.size() >= LOAD_SHED_QUEUE_SIZE &&
            comparePriority(priority, LOWEST_ADMITTED_PRIORITY_UNDER_LOAD) > 0
        );
    }
}
