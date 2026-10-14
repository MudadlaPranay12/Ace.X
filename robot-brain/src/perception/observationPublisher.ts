import { Observation } from "./observation";

type ObservationListener = (observation: Observation) => void;

export class ObservationPublisher {
    private listeners: Set<ObservationListener> = new Set();

    subscribe(listener: ObservationListener): void {
        this.listeners.add(listener);
    }

    unsubscribe(listener: ObservationListener): void {
        this.listeners.delete(listener);
    }

    publish(observation: Observation): void {
        for (const listener of this.listeners) {
            listener(observation);
        }
    }

    clear(): void {
        this.listeners.clear();
    }
}
