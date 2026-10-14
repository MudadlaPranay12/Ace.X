import type { PopupSeverity } from '../core/types';

/**
 * Canonical Eve popup state.
 *
 * The popup bar is the ONE primary intervention surface of the floating Eve
 * window. This model is derived exclusively from existing Ace.X evidence —
 * the current issue, live diagnostics, teaching rung, user skill and verified
 * resolutions — never from a second issue-detection system. Priority,
 * dismissal and expiry are handled by the publisher; this module only builds
 * one honest snapshot per input.
 */
export type { PopupSeverity };

export interface PopupIssueInput {
    matter: string;
    concept?: string;
    symbol?: string;
    recurrence: number;
    recurring: boolean;
    file: string;
    fileName: string;
    line: number;
    column?: number;
    severity: 'Error' | 'Warning' | 'Info';
    message: string;
    /** Brain-tailored caption text when the ladder already spoke. */
    captionText?: string;
    /** Grounded "what changed" headline/detail when known. */
    details?: string;
    teachingLevel: number;
    /** True for beginners / detailed verbosity: popup opens expanded. */
    verbose: boolean;
}

export interface PopupResolutionInput {
    verified: boolean;
    headline: string;
    takeaway: string;
    via: string;
    at: number;
}

export interface PopupSnapshotInput {
    issue: PopupIssueInput | null;
    resolution: PopupResolutionInput | null;
    voiceEnabled: boolean;
    now: number;
}

export interface PopupState {
    visible: boolean;
    severity: PopupSeverity;
    title: string;
    message: string;
    details?: string;
    file?: string;
    /** Full file path for reveal/open actions (file is display text). */
    filePath?: string;
    line?: number;
    column?: number;
    matter?: string;
    /** Expanded by default for beginners; experts start collapsed. */
    expanded: boolean;
    fixAvailable: boolean;
    /**
     * Always false: fix approval lives in the existing VS Code diff + modal
     * flow, where the proposal is visible. The popup triggers that flow but
     * never replaces its approval gate.
     */
    requiresApproval: boolean;
    voiceAvailable: boolean;
    timestamp: number;
}

/** Rank for "a more important popup replaces, a lesser one never interrupts". */
export function popupRank(severity: PopupSeverity): number {
    switch (severity) {
        case 'CRITICAL':
            return 4;
        case 'ERROR':
        case 'FAILURE':
            return 3;
        case 'SUCCESS':
        case 'WARNING':
            return 2;
        case 'INFO':
        default:
            return 1;
    }
}

/** Signature for change detection. Timestamp excluded on purpose: equal
 * content must compare equal no matter when it was built. */
export function popupSignature(state: PopupState): string {
    return [
        state.visible ? '1' : '0',
        state.severity,
        state.title,
        state.message,
        state.details ?? '',
        state.file ?? '',
        state.filePath ?? '',
        String(state.line ?? 0),
        state.matter ?? '',
        state.expanded ? '1' : '0',
        state.fixAvailable ? '1' : '0',
    ].join('|');
}

function severityLabel(severity: PopupSeverity): string {
    switch (severity) {
        case 'ERROR':
            return 'ERROR';
        case 'WARNING':
            return 'WARNING';
        case 'CRITICAL':
            return 'CRITICAL';
        case 'SUCCESS':
            return 'Fixed and verified';
        case 'FAILURE':
            return 'Not fixed';
        case 'INFO':
        default:
            return 'EVE';
    }
}

function fallbackMessage(issue: PopupIssueInput): string {
    const where = issue.line > 0 ? ` at ${issue.fileName}:${issue.line}` : '';
    const symbol = issue.symbol ? `\`${issue.symbol}\` ` : '';
    return `${symbol}${issue.message}${where}`;
}

/**
 * Builds one popup snapshot. The message prefers the Brain-tailored caption
 * (already adapted to skill level and verbosity); otherwise a deterministic
 * one-liner from the diagnostic itself. Never invents content.
 */
export function buildPopupState(input: PopupSnapshotInput): PopupState {
    const { issue, resolution, voiceEnabled, now } = input;
    if (issue) {
        const severity: PopupSeverity = issue.severity === 'Error'
            ? 'ERROR'
            : issue.severity === 'Warning'
                ? 'WARNING'
                : 'INFO';
        const where = issue.line > 0 ? `${issue.fileName}:${issue.line}` : issue.fileName;
        return {
            visible: true,
            severity,
            title: `${severityLabel(severity)}${issue.concept ? ` — ${issue.concept}` : ''}`,
            message: issue.captionText && issue.captionText.trim() ? issue.captionText : fallbackMessage(issue),
            details: issue.details,
            file: where,
            filePath: issue.file || undefined,
            line: issue.line > 0 ? issue.line : undefined,
            column: issue.column,
            matter: issue.matter,
            expanded: issue.verbose,
            fixAvailable: issue.teachingLevel >= 2 && issue.matter.length > 0,
            requiresApproval: false,
            voiceAvailable: voiceEnabled,
            timestamp: now,
        };
    }
    if (resolution) {
        const verified = resolution.verified;
        return {
            visible: true,
            severity: verified ? 'SUCCESS' : 'FAILURE',
            title: severityLabel(verified ? 'SUCCESS' : 'FAILURE'),
            message: resolution.takeaway,
            details: resolution.headline,
            matter: undefined,
            expanded: false,
            fixAvailable: false,
            requiresApproval: false,
            voiceAvailable: voiceEnabled,
            // The moment that matters is when the outcome happened, so stale
            // resolutions expire instead of lingering forever.
            timestamp: resolution.at,
        };
    }
    return {
        visible: false,
        severity: 'INFO',
        title: '',
        message: '',
        expanded: false,
        fixAvailable: false,
        requiresApproval: false,
        voiceAvailable: voiceEnabled,
        timestamp: now,
    };
}
