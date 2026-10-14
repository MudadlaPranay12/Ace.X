import { AetherEvent } from "./event";

const DUPLICATE_WINDOW_MS = 500;
const EVICTION_INTERVAL_MS = 30000;

export class DuplicateFilter {
    private recentSignatures: Map<string, number> = new Map();
    private lastEviction: number = Date.now();

    isDuplicate(event: AetherEvent): boolean {
        this.evictExpired();

        const signature = this.buildSignature(event);
        const now = Date.now();
        const lastSeen = this.recentSignatures.get(signature);

        if (lastSeen !== undefined && (now - lastSeen) < DUPLICATE_WINDOW_MS) {
            return true;
        }

        this.recentSignatures.set(signature, now);
        return false;
    }

    clear(): void {
        this.recentSignatures.clear();
    }

    private evictExpired(): void {
        const now = Date.now();
        if (now - this.lastEviction < EVICTION_INTERVAL_MS) {
            return;
        }
        this.lastEviction = now;
        const cutoff = now - DUPLICATE_WINDOW_MS;
        for (const [key, time] of this.recentSignatures) {
            if (time < cutoff) {
                this.recentSignatures.delete(key);
            }
        }
    }

    private buildSignature(event: AetherEvent): string {
        const payloadString = this.serializePayload(event.payload);
        return `${event.type}|${payloadString}|${event.source}`;
    }

    private serializePayload(payload: unknown): string {
        if (payload === undefined || payload === null) {
            return "null";
        }

        if (typeof payload === "object") {
            try {
                return JSON.stringify(payload, Object.keys(payload as Record<string, unknown>).sort());
            } catch {
                return String(payload);
            }
        }

        return String(payload);
    }
}
