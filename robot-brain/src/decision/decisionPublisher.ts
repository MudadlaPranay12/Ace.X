import { Decision } from "./decision";

type DecisionListener = (decision: Decision) => void;

export class DecisionPublisher {
    private listeners: Set<DecisionListener> = new Set();

    subscribe(listener: DecisionListener): void {
        this.listeners.add(listener);
    }

    unsubscribe(listener: DecisionListener): void {
        this.listeners.delete(listener);
    }

    publish(decision: Decision): void {
        for (const listener of this.listeners) {
            listener(decision);
        }
    }

    clear(): void {
        this.listeners.clear();
    }
}
