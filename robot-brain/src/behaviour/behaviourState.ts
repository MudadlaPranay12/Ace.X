import { BehaviourAction } from "./behaviourAction";

export enum RobotBehaviourState {
    IDLE = "IDLE",
    OBSERVING = "OBSERVING",
    THINKING = "THINKING",
    SPEAKING = "SPEAKING",
    WAITING = "WAITING",
    COOLDOWN = "COOLDOWN",
    PROACTIVE_ASSIST = "PROACTIVE_ASSIST",
    DISABLED = "DISABLED"
}

const BUSY_WINDOW_MS = 3000;

export class BehaviourState {
    private _currentState: RobotBehaviourState = RobotBehaviourState.IDLE;
    private _lastAction: BehaviourAction = BehaviourAction.NONE;
    private _lastActionTime: number = 0;
    private _robotEnabled: boolean = true;

    get currentState(): RobotBehaviourState {
        return this._currentState;
    }

    set currentState(value: RobotBehaviourState) {
        this._currentState = value;
    }

    get lastAction(): BehaviourAction {
        return this._lastAction;
    }

    set lastAction(value: BehaviourAction) {
        this._lastAction = value;
    }

    get lastActionTime(): number {
        return this._lastActionTime;
    }

    set lastActionTime(value: number) {
        this._lastActionTime = value;
    }

    get cooldownUntil(): number {
        return this._lastActionTime + BUSY_WINDOW_MS;
    }

    get isBusy(): boolean {
        if (this._lastActionTime === 0) {
            return false;
        }
        return Date.now() - this._lastActionTime < BUSY_WINDOW_MS;
    }

    get userBusy(): boolean {
        return this.isBusy;
    }

    get robotEnabled(): boolean {
        return this._robotEnabled;
    }

    set robotEnabled(value: boolean) {
        this._robotEnabled = value;
    }

    reset(): void {
        this._currentState = RobotBehaviourState.IDLE;
        this._lastAction = BehaviourAction.NONE;
        this._lastActionTime = 0;
        this._robotEnabled = true;
    }
}
