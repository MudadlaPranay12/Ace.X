export interface LearningEvent {
    type: string;
    detail: string;
    value: number;
    timestamp: number;
}

type LearningListener = (event: LearningEvent) => void;

export class LearningPublisher {
    private listeners: Set<LearningListener> = new Set();

    subscribe(listener: LearningListener): void {
        this.listeners.add(listener);
    }

    unsubscribe(listener: LearningListener): void {
        this.listeners.delete(listener);
    }

    publish(event: LearningEvent): void {
        for (const listener of this.listeners) {
            listener(event);
        }
    }

    clear(): void {
        this.listeners.clear();
    }
}
