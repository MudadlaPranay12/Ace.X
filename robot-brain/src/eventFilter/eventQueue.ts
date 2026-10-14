import { AetherEvent } from "./event";

const MAX_QUEUE_SIZE = 500;

export class EventQueue {
    private events: AetherEvent[] = [];

    enqueue(event: AetherEvent): void {
        if (this.events.length >= MAX_QUEUE_SIZE) {
            this.events.splice(0, this.events.length - MAX_QUEUE_SIZE + 1);
        }
        this.events.push(event);
    }

    dequeue(): AetherEvent | undefined {
        return this.events.shift();
    }

    peek(): AetherEvent | undefined {
        if (this.events.length === 0) {
            return undefined;
        }
        return this.events[0];
    }

    size(): number {
        return this.events.length;
    }

    clear(): void {
        this.events = [];
    }

    isEmpty(): boolean {
        return this.events.length === 0;
    }
}
