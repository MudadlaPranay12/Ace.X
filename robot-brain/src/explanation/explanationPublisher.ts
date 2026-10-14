import { Explanation } from "./explanationTypes";

type ExplanationListener = (explanation: Explanation) => void;

export class ExplanationPublisher {
    private listeners: Set<ExplanationListener> = new Set();

    subscribe(listener: ExplanationListener): void {
        this.listeners.add(listener);
    }

    unsubscribe(listener: ExplanationListener): void {
        this.listeners.delete(listener);
    }

    publish(explanation: Explanation): void {
        for (const listener of this.listeners) {
            listener(explanation);
        }
    }

    clear(): void {
        this.listeners.clear();
    }
}
