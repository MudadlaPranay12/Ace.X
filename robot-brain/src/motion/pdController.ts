/**
 * Proportional-derivative controller for smooth robot-motion channels.
 *
 * The PD loop corrects toward a Brain-decided target (proportional term) while
 * damping oscillation (derivative term). It never chooses a target itself: the
 * Brain decides where to go, and this only shapes how a numeric channel —
 * intensity, attention strength, gaze — gets there without overshoot.
 */
export interface PdGains {
    proportional: number;
    derivative: number;
}

export class PdController {
    private readonly gains: PdGains;
    private velocity = 0;

    constructor(gains: PdGains = { proportional: 12, derivative: 4.5 }) {
        this.gains = gains;
    }

    /**
     * Advances the channel toward `target` over `dt` seconds.
     * Returns the new value, clamped to [min, max].
     */
    step(current: number, target: number, dt: number, min = 0, max = 1): number {
        const clampedDt = Math.max(1 / 240, Math.min(0.1, dt));
        const error = target - current;
        const acceleration = this.gains.proportional * error - this.gains.derivative * this.velocity;
        this.velocity += acceleration * clampedDt;
        return Math.max(min, Math.min(max, current + this.velocity * clampedDt));
    }

    reset(): void {
        this.velocity = 0;
    }
}
