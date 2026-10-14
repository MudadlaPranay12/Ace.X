/**
 * Voice command interpretation for the Eve popup microphone.
 *
 * Transcripts arrive from the body's speech recognition as plain text plus
 * the popup's current-issue context. This module decides WHAT the developer
 * meant — explain/fix/dismiss/retry the CURRENT issue, or a free-form
 * question — and the extension executes it through the existing pipelines
 * (explainError, fixWithEve with its approval flow, dismissTeaching, ask).
 * Voice never bypasses the Brain and never applies edits silently.
 */

export type VoiceActionKind =
    | 'explain_issue'
    | 'fix_issue'
    | 'dismiss'
    | 'retry'
    | 'what_changed'
    | 'why_failed'
    | 'ask';

export interface VoiceIssueContext {
    hasIssue: boolean;
    file?: string;
    line?: number;
    matter?: string;
}

export interface VoiceCommand {
    kind: VoiceActionKind;
    /** Free-form question text (ask only). */
    question?: string;
    file?: string;
    line?: number;
    matter?: string;
}

function normalize(transcript: string): string {
    return transcript.trim().toLowerCase().replace(/[.?!,;:\s]+$/g, '').trim();
}

/**
 * Maps a transcript plus current-issue context to one action. Issue-bound
 * commands without a current issue degrade to free-form chat rather than
 * acting on nothing.
 */
export function interpretVoiceCommand(transcript: string, issue?: VoiceIssueContext): VoiceCommand {
    const text = normalize(transcript);
    if (!text) {
        return { kind: 'ask', question: '' };
    }
    const context = issue?.hasIssue === true ? issue : undefined;
    const withIssue = (kind: VoiceActionKind): VoiceCommand =>
        context
            ? { kind, file: context.file, line: context.line, matter: context.matter }
            : { kind: 'ask', question: transcript.trim() };

    if (/^(explain|explain this|explain it|explain that|what went wrong|what is wrong|what's wrong|why|why is this happening|why is it happening|tell me more|explain more)$/.test(text)) {
        return withIssue('explain_issue');
    }
    if (/^(fix|fix it|fix this|fix that|repair|repair it|solve it)$/.test(text)) {
        return withIssue('fix_issue');
    }
    if (/^(dismiss|dismiss this|dismiss it|close|close this|go away|never mind|nevermind|cancel)$/.test(text)) {
        return { kind: 'dismiss' };
    }
    if (/^(try again|retry|try it again)$/.test(text)) {
        return withIssue('retry');
    }
    if (/^(what did you change|what have you changed|what did it change|what changed)$/.test(text)) {
        return { kind: 'what_changed' };
    }
    if (/^(why did it fail|why did the fix fail|why failed|why did that fail)$/.test(text)) {
        return { kind: 'why_failed' };
    }
    return { kind: 'ask', question: transcript.trim() };
}

/**
 * Honest user-facing line for a microphone/recognition failure. Every code
 * path names the real condition — the popup never shows "Listening..." unless
 * the microphone is actually recording (enforced renderer-side).
 */
export function micErrorMessage(code: string): string {
    switch (code) {
        case 'not-allowed':
        case 'denied':
        case 'permission-denied':
            return 'Microphone unavailable. Microphone permission was denied for Eve.';
        case 'audio-capture':
        case 'no-mic':
        case 'device-not-found':
            return 'Microphone unavailable. No microphone was found on this machine.';
        case 'no-speech':
            return "I didn't catch that. Try speaking again.";
        case 'network':
        case 'service-not-allowed':
            return 'Voice input is unavailable. Speech recognition could not reach its service.';
        case 'aborted':
            return 'Voice input stopped.';
        case 'unsupported':
            return 'Voice input is unavailable. This Eve build has no speech recognition.';
        default:
            return 'Voice input is unavailable. Try the Explain or Fix buttons instead.';
    }
}

/** Hard ceiling for spoken output: TTS summarizes, never reads essays aloud. */
export const MAX_TTS_WORDS = 40;
export const MAX_TTS_CHARS = 280;

/** First two sentences, truncated — what Eve actually says for long text. */
export function ttsSummary(text: string): string {
    const cleaned = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!cleaned) {
        return '';
    }
    const sentences = cleaned.match(/[^.?!]+[.?!]+["']?/g) ?? [cleaned];
    const summary = sentences.slice(0, 2).join(' ').trim();
    if (summary.length <= MAX_TTS_CHARS) {
        return summary;
    }
    return `${summary.slice(0, MAX_TTS_CHARS - 1).trimEnd()}…`;
}

/** TTS fires only for short, enabled, engine-backed speech. Long text stays
 * on screen; the popup shows the full explanation instead. */
export function shouldSpeak(text: string, voiceEnabled: boolean, enginePresent: boolean): boolean {
    if (!voiceEnabled || !enginePresent) {
        return false;
    }
    const words = String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
    return words > 0 && words <= MAX_TTS_WORDS;
}
