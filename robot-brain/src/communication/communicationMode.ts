/**
 * CommunicationMode — chooses how the companion expresses a spoken line and
 * keeps the BehaviourController decoupled from any speech engine.
 *
 * CAPTION is the default and the only fully-supported channel. TTS is an
 * optional, future sink: when no speech engine is registered the mode still
 * degrades to CAPTION rather than pretending to speak. This is the extension
 * point for adding TTS later without touching the decision or behaviour code.
 */

import type { CaptionPayload, CommunicationMode as CommunicationModeName } from '../core/types';

export type TtsSink = (text: string) => void;

const DEFAULT_MIN_CAPTION_MS = 3000;
const MAX_CAPTION_MS = 12000;
const MS_PER_WORD = 320;

/** Reading-speed-based caption hold, matching the Body's own speech timing. */
export function captionHoldMs(text: string): number {
    const words = String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
    return Math.max(DEFAULT_MIN_CAPTION_MS, Math.min(2500 + words * MS_PER_WORD, MAX_CAPTION_MS));
}

export class CommunicationMode {
    private mode: CommunicationModeName;
    private ttsSink: TtsSink | null = null;

    constructor(voiceEnabled = false) {
        this.mode = voiceEnabled ? 'TTS' : 'CAPTION';
    }

    setVoiceEnabled(enabled: boolean): void {
        // Voice enabled means we send CAPTION with mode='TTS'.
        // The Body handles actual TTS via browser SpeechSynthesis.
        // A sink is not required on the Brain side.
        this.mode = enabled ? 'TTS' : 'CAPTION';
    }

    setTtsSink(sink: TtsSink | null): void {
        this.ttsSink = sink;
        this.mode = sink ? this.mode : 'CAPTION';
    }

    getMode(): CommunicationModeName {
        return this.mode;
    }

    getVoiceEnabled(): boolean {
        return this.mode === 'TTS';
    }

    /**
     * Builds the caption payload for a line. Returns null for empty text so the
     * caller never sends an empty bubble.
     */
    buildCaption(text: string, duration?: number): CaptionPayload | null {
        const trimmed = String(text ?? '').trim();
        if (!trimmed) {
            return null;
        }
        return {
            type: 'CAPTION',
            text: trimmed,
            mode: this.mode,
            duration: duration ?? captionHoldMs(trimmed),
        };
    }

    /**
     * Sends a line through the active channel. Captions are always emitted; TTS
     * is additionally invoked only when a sink is registered. Returns the
     * caption payload (or null when there is nothing to say).
     */
    speak(text: string, emit: (payload: CaptionPayload) => void, duration?: number): CaptionPayload | null {
        const caption = this.buildCaption(text, duration);
        if (!caption) {
            return null;
        }
        emit(caption);
        if (this.mode === 'TTS' && this.ttsSink) {
            try {
                this.ttsSink(caption.text);
            } catch {
                // A failing speech engine must never break the expression path.
            }
        }
        return caption;
    }
}
