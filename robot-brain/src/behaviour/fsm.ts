import { RobotBehaviourState } from "./behaviourState";

type TransitionMap = Record<RobotBehaviourState, RobotBehaviourState[]>;

const ALLOWED_TRANSITIONS: TransitionMap = {
    [RobotBehaviourState.IDLE]: [RobotBehaviourState.OBSERVING, RobotBehaviourState.DISABLED, RobotBehaviourState.PROACTIVE_ASSIST],
    [RobotBehaviourState.OBSERVING]: [RobotBehaviourState.THINKING, RobotBehaviourState.DISABLED, RobotBehaviourState.PROACTIVE_ASSIST],
    [RobotBehaviourState.THINKING]: [RobotBehaviourState.SPEAKING, RobotBehaviourState.DISABLED, RobotBehaviourState.PROACTIVE_ASSIST],
    [RobotBehaviourState.SPEAKING]: [RobotBehaviourState.WAITING, RobotBehaviourState.DISABLED, RobotBehaviourState.PROACTIVE_ASSIST],
    [RobotBehaviourState.WAITING]: [RobotBehaviourState.IDLE, RobotBehaviourState.DISABLED, RobotBehaviourState.PROACTIVE_ASSIST],
    [RobotBehaviourState.COOLDOWN]: [RobotBehaviourState.IDLE, RobotBehaviourState.DISABLED, RobotBehaviourState.PROACTIVE_ASSIST],
    [RobotBehaviourState.PROACTIVE_ASSIST]: [RobotBehaviourState.IDLE, RobotBehaviourState.OBSERVING, RobotBehaviourState.DISABLED],
    [RobotBehaviourState.DISABLED]: [RobotBehaviourState.IDLE]
};

export class FSM {
    private currentState: RobotBehaviourState;

    constructor(initialState: RobotBehaviourState = RobotBehaviourState.IDLE) {
        this.currentState = initialState;
    }

    getState(): RobotBehaviourState {
        return this.currentState;
    }

    canTransition(target: RobotBehaviourState): boolean {
        const allowed = ALLOWED_TRANSITIONS[this.currentState];
        return allowed.includes(target);
    }

    transition(target: RobotBehaviourState): boolean {
        if (!this.canTransition(target)) {
            return false;
        }

        this.currentState = target;
        return true;
    }

    reset(): void {
        this.currentState = RobotBehaviourState.IDLE;
    }
}
