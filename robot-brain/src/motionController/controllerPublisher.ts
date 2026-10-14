import { ExecutionResult } from "./executionTypes";

type ControllerListener = (result: ExecutionResult) => void;

export class ControllerPublisher {
    private listeners: Set<ControllerListener> = new Set();

    subscribe(listener: ControllerListener): void {
        this.listeners.add(listener);
    }

    unsubscribe(listener: ControllerListener): void {
        this.listeners.delete(listener);
    }

    publish(result: ExecutionResult): void {
        for (const listener of this.listeners) {
            listener(result);
        }
    }

    clear(): void {
        this.listeners.clear();
    }
}
