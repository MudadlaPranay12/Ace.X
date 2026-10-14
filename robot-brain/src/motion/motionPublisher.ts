import { MotionPlan } from "./motionPlan";

type MotionListener = (plan: MotionPlan) => void;

export class MotionPublisher {
    private listeners: Set<MotionListener> = new Set();

    subscribe(listener: MotionListener): void {
        this.listeners.add(listener);
    }

    unsubscribe(listener: MotionListener): void {
        this.listeners.delete(listener);
    }

    publish(plan: MotionPlan): void {
        for (const listener of this.listeners) {
            listener(plan);
        }
    }

    clear(): void {
        this.listeners.clear();
    }
}
