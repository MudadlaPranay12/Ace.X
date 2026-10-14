import { DecisionType } from "./decisionType";

const COOLDOWN_MS = 10000;

export class DecisionState {
    private _lastDecision: DecisionType = DecisionType.DO_NOTHING;
    private _lastDecisionTime: number = 0;
    private _lastHint: string = "";
    private _lastContext: string = "";
    private cooldownMap: Map<string, number> = new Map();
    private lastCooldownEviction: number = Date.now();

    get lastDecision(): DecisionType {
        return this._lastDecision;
    }

    set lastDecision(value: DecisionType) {
        this._lastDecision = value;
    }

    get lastDecisionTime(): number {
        return this._lastDecisionTime;
    }

    set lastDecisionTime(value: number) {
        this._lastDecisionTime = value;
    }

    get cooldownActive(): boolean {
        if (this._lastDecisionTime === 0) {
            return false;
        }
        return Date.now() - this._lastDecisionTime < COOLDOWN_MS;
    }

    get cooldownUntil(): number {
        return this._lastDecisionTime + COOLDOWN_MS;
    }

    get lastHint(): string {
        return this._lastHint;
    }

    set lastHint(value: string) {
        this._lastHint = value;
    }

    get lastContext(): string {
        return this._lastContext;
    }

    set lastContext(value: string) {
        this._lastContext = value;
    }

    isOnCooldown(type: DecisionType): boolean {
        this.evictExpiredCooldowns();

        const expiry = this.cooldownMap.get(type);
        if (expiry === undefined) {
            return false;
        }
        return Date.now() < expiry;
    }

    setCustomCooldown(type: DecisionType, durationMs: number): void {
        const expiry = Date.now() + durationMs;
        this.cooldownMap.set(type, expiry);
    }

    setCooldown(type: DecisionType): void {
        const expiry = Date.now() + COOLDOWN_MS;
        this.cooldownMap.set(type, expiry);
        this._lastDecision = type;
        this._lastDecisionTime = Date.now();
    }

    reset(): void {
        this._lastDecision = DecisionType.DO_NOTHING;
        this._lastDecisionTime = 0;
        this._lastHint = "";
        this._lastContext = "";
        this.cooldownMap.clear();
    }

    private evictExpiredCooldowns(): void {
        const now = Date.now();
        if (now - this.lastCooldownEviction < COOLDOWN_MS) {
            return;
        }
        this.lastCooldownEviction = now;
        for (const [key, expiry] of this.cooldownMap) {
            if (now >= expiry) {
                this.cooldownMap.delete(key);
            }
        }
    }
}
