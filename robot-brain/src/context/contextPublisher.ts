import { Context } from "./context";

type ContextListener = (context: Context) => void;

export class ContextPublisher {
    private listeners: Set<ContextListener> = new Set();

    subscribe(listener: ContextListener): void {
        this.listeners.add(listener);
    }

    unsubscribe(listener: ContextListener): void {
        this.listeners.delete(listener);
    }

    publish(context: Context): void {
        for (const listener of this.listeners) {
            listener(context);
        }
    }

    clear(): void {
        this.listeners.clear();
    }
}
