/**
 * Quintic trajectory utilities for smooth robot motion.
 *
 * A quintic polynomial gives smooth position, velocity AND acceleration with
 * zero endpoints — no jerks when a gesture starts or lands. These are pure
 * functions over normalized time so both the Brain (planning) and the view
 * (playback) shape motion the same way.
 */
export interface QuinticSample {
    /** Normalized progress 0..1. */
    position: number;
    /** First derivative (velocity scale). */
    velocity: number;
    /** Second derivative (acceleration scale). */
    acceleration: number;
}

/** Smooth-step quintic: 10t³ − 15t⁴ + 6t⁵. */
export function quinticEase(time: number): number {
    const t = Math.max(0, Math.min(1, time));
    return 10 * t * t * t - 15 * t * t * t * t + 6 * t * t * t * t * t;
}

export function sampleQuintic(time: number): QuinticSample {
    const t = Math.max(0, Math.min(1, time));
    return {
        position: quinticEase(t),
        velocity: 30 * t * t - 60 * t * t * t + 30 * t * t * t * t,
        acceleration: 60 * t - 180 * t * t + 120 * t * t * t,
    };
}

/** Interpolates between two values along the quintic curve. */
export function quinticBetween(from: number, to: number, time: number): number {
    return from + (to - from) * quinticEase(time);
}
