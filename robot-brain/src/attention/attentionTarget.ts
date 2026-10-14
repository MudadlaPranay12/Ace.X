/**
 * AttentionTarget — deterministic model of what the companion should look
 * toward, shared between the Brain and the Body.
 *
 * The Brain computes the target (file/line/region + confidence + strength) and
 * sends it to the Body, which only translates it into an approximate gaze
 * direction. There is deliberately NO absolute editor screen coordinate in the
 * model: VS Code does not expose one, so "look toward the region" is the honest
 * contract. A future editor-window coordinate mapper can be added without
 * changing this shape.
 */

import type { AttentionTargetPayload, AttentionTargetType } from '../core/types';

export interface AttentionInput {
    targetType: AttentionTargetType;
    file?: string;
    line?: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
    confidence: number;
    strength: number;
    reason: string;
    ttlMs?: number;
}

const DEFAULT_TTL_MS = 15_000;

function clamp01(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.min(1, value));
}

export class AttentionTracker {
    private current: AttentionTargetPayload | undefined;

    set(input: AttentionInput, now: number = Date.now()): AttentionTargetPayload {
        const payload: AttentionTargetPayload = {
            type: 'ATTENTION_TARGET',
            targetType: input.targetType,
            file: input.file,
            line: input.line,
            column: input.column,
            endLine: input.endLine,
            endColumn: input.endColumn,
            confidence: clamp01(input.confidence),
            strength: clamp01(input.strength),
            reason: input.reason,
            expiresAt: now + Math.max(1000, input.ttlMs ?? DEFAULT_TTL_MS),
        };
        this.current = payload;
        return payload;
    }

    getCurrent(now: number = Date.now()): AttentionTargetPayload | undefined {
        if (this.current && this.current.expiresAt <= now) {
            this.current = undefined;
        }
        return this.current;
    }

    /**
     * Ends the current target now and returns the release payload to send.
     * It stays a canonical ATTENTION_TARGET with strength 0 and `expiresAt` in
     * the past, so the Body drops it on its next frame and the gaze returns to
     * normal — no new message type, no second gaze system.
     */
    release(now: number = Date.now()): AttentionTargetPayload | undefined {
        const current = this.getCurrent(now);
        this.current = undefined;
        if (!current) {
            return undefined;
        }
        return { ...current, strength: 0, reason: 'released', expiresAt: now };
    }

    clear(): void {
        this.current = undefined;
    }
}

/**
 * Builds an attention target from a diagnostic shape. Kept here so every caller
 * derives the target the same way. Severity raises strength; an error is a
 * stronger "look here" than a warning.
 */
export function attentionFromDiagnostic(input: {
    file?: string;
    line?: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
    severity?: string;
    confidence?: number;
}): AttentionInput {
    const isError = String(input.severity ?? '').toLowerCase() === 'error';
    return {
        targetType: isError ? 'error' : 'warning',
        file: input.file,
        line: input.line,
        column: input.column,
        endLine: input.endLine,
        endColumn: input.endColumn,
        confidence: clamp01(input.confidence ?? 0.9),
        strength: isError ? 0.85 : 0.6,
        reason: isError ? 'diagnostic error' : 'diagnostic warning',
    };
}

export function attentionFromCursor(input: {
    file?: string;
    line?: number;
    column?: number;
}): AttentionInput {
    return {
        targetType: 'cursor',
        file: input.file,
        line: input.line,
        column: input.column,
        confidence: 0.6,
        strength: 0.35,
        reason: 'active cursor',
        ttlMs: 8_000,
    };
}
