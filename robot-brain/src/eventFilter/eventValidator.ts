import type { AetherEvent } from './event';
import { EventType } from './eventTypes';

const EVENT_TYPES = new Set<string>(Object.values(EventType));

/**
 * Structural validation for the normalized Ace.X envelope.
 *
 * Validation checks integrity and required shape only. It never interprets the
 * payload: deciding what an event means remains Perception's responsibility.
 */
export function validateAetherEvent(event: AetherEvent): { valid: boolean; reason?: string } {
    if (!event || typeof event !== 'object') {
        return { valid: false, reason: 'event is not an object' };
    }
    if (typeof event.id !== 'string' || !event.id) {
        return { valid: false, reason: 'missing event id' };
    }
    if (typeof event.type !== 'string' || !EVENT_TYPES.has(event.type)) {
        return { valid: false, reason: `unknown event type: ${String(event.type)}` };
    }
    if (typeof event.source !== 'string' || !event.source) {
        return { valid: false, reason: 'missing event source' };
    }
    if (!Number.isFinite(event.timestamp)) {
        return { valid: false, reason: 'missing event timestamp' };
    }
    if (event.payload === undefined) {
        return { valid: false, reason: 'missing event payload' };
    }
    return { valid: true };
}
