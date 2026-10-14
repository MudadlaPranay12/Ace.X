import { BehaviourAction } from "./behaviourAction";
import { RobotBehaviourState } from "./behaviourState";

export interface BehaviourEvent {
    action: BehaviourAction;
    state: RobotBehaviourState;
    timestamp: number;
    data?: Record<string, unknown>;
}

type BehaviourListener = (event: BehaviourEvent) => void;

export class BehaviourPublisher {
    private listeners: Set<BehaviourListener> = new Set();

    subscribe(listener: BehaviourListener): void {
        this.listeners.add(listener);
    }

    unsubscribe(listener: BehaviourListener): void {
        this.listeners.delete(listener);
    }

    publish(event: BehaviourEvent): void {
        for (const listener of this.listeners) {
            listener(event);
        }
    }

    clear(): void {
        this.listeners.clear();
    }
}
