/**
 * whatChanged — answers "why did this error appear?" from what was ACTUALLY
 * recorded, and nothing else.
 *
 * Inputs come from two places only:
 *   - TimelineBuffer, the existing short-lived rolling window. It is the single
 *     record of what happened; this module never creates a second history.
 *   - the live text of the file, when the host has it open, for the one question
 *     a timeline cannot answer (is this name assigned before it is used?).
 *
 * Honesty rules, in priority order:
 *   1. Never describe an edit, save or terminal event that was not recorded.
 *   2. When the recorded history cannot answer the question, say exactly that.
 *   3. Every claim carries its evidence — which line, how long before.
 */

import type { TimelineEntry } from './timelineBuffer';

/** Diagnostic text → the identifier it is about, when the message names one. */
const IDENTIFIER_PATTERNS: readonly RegExp[] = [
    /name '([^']+)' is not defined/i,
    /cannot find name '([^']+)'/i,
    /undefined name:?\s*([A-Za-z_$][\w$]*)/i,
    /unknown identifier:?\s*([A-Za-z_$][\w$]*)/i,
    /'([^']+)' is not defined/i,
    /is undefined:?\s*([A-Za-z_$][\w$]*)/i,
    /\b([A-Za-z_$][\w$]*)\b (?:is|was) undefined/i,
];

/**
 * Best-effort identifier extraction. Returns undefined when the message does not
 * clearly name one — callers must degrade to message-only wording rather than
 * guess a variable name.
 */
export function extractIdentifier(message: string): string | undefined {
    const text = String(message ?? '');
    if (!text) {
        return undefined;
    }
    for (const pattern of IDENTIFIER_PATTERNS) {
        const match = pattern.exec(text);
        const candidate = match?.[1]?.trim();
        if (candidate && /^[A-Za-z_$][\w$]*$/.test(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

/** Escape a literal for use inside a RegExp. */
function escapeLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `symbol` is assigned at least once strictly ABOVE `line` (1-based).
 *
 * This is a conservative text scan, not a parser: it recognises the assignment
 * forms that actually produce "used before it is assigned" diagnostics
 * (`x = ...`, `let x = ...`, `var x: T = ...`, `for x in ...`, `def x(...)`,
 * `import x`), and deliberately does not try to understand expressions. The
 * wording that uses this result always says "no assignment was recorded",
 * which is precisely what was checked.
 */
export function isAssignedBefore(text: string, symbol: string, line: number): boolean {
    if (!text || !symbol || line <= 0) {
        return false;
    }
    const name = escapeLiteral(symbol);
    const lines = text.split(/\r?\n/);
    const upto = Math.min(lines.length, Math.max(0, line - 1));
    const assignment = new RegExp(
        `^\\s*(?:(?:const|let|var|final|public|private|protected|static)\\s+)*${name}\\s*(?::[^=]*)?=(?!=)`
    );
    const binding = new RegExp(
        `^\\s*(?:def|function|class|async\\s+function)\\s+${name}\\b`
        + `|^\\s*for\\s+${name}\\b`
        + `|^\\s*import\\s+${name}\\b`
        + `|^\\s*from\\s+\\S+\\s+import\\s+${name}\\b`
    );
    for (let i = 0; i < upto; i += 1) {
        const candidate = lines[i] ?? '';
        if (assignment.test(candidate) || binding.test(candidate)) {
            return true;
        }
    }
    return false;
}

export interface WhatChangedInput {
    /** Stable signature of the diagnostic being asked about. */
    signature: string;
    fileName: string;
    /** 1-based line of the diagnostic. */
    line: number;
    message: string;
    now: number;
    /** The recorded window. This module reads it and never writes to it. */
    entries: TimelineEntry[];
    /** Live file text, when the host has the document open. Never persisted. */
    documentText?: string;
}

export interface WhatChangedReport {
    /** False when the recorded history genuinely cannot answer the question. */
    known: boolean;
    /** One sentence answering "why did this appear?". */
    headline: string;
    /** Evidence line: what changed, where, and how long before the diagnostic. */
    detail?: string;
}

/** The diagnostic's first appearance in the window, if it is still in it. */
function firstSighting(entries: TimelineEntry[], signature: string): TimelineEntry | undefined {
    let first: TimelineEntry | undefined;
    for (const entry of entries) {
        if (entry.kind !== 'diagnostic') {
            continue;
        }
        if (String(entry.data?.['signature'] ?? '') !== signature) {
            continue;
        }
        if (!first || entry.at < first.at) {
            first = entry;
        }
    }
    return first;
}

/** The newest recorded change that happened at or before the first sighting. */
function lastChangeBefore(entries: TimelineEntry[], at: number): TimelineEntry | undefined {
    let change: TimelineEntry | undefined;
    for (const entry of entries) {
        if (entry.kind !== 'edit' && entry.kind !== 'save') {
            continue;
        }
        if (entry.at > at) {
            continue;
        }
        if (!change || entry.at >= change.at) {
            change = entry;
        }
    }
    return change;
}

/** "12 seconds before" / "3 minutes before", phrased for a human. */
export function humanizeGap(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) {
        return `${seconds} second${seconds === 1 ? '' : 's'}`;
    }
    const minutes = Math.round(seconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * Builds the report. The decision about WHETHER to intervene stays with the
 * teaching ladder and the interruption policy; this only answers a question the
 * developer asked.
 */
export function buildWhatChanged(input: WhatChangedInput): WhatChangedReport {
    const seen = firstSighting(input.entries, input.signature);
    if (!seen) {
        return {
            known: false,
            headline: 'Not enough history to determine what introduced this.',
        };
    }

    const change = lastChangeBefore(input.entries, seen.at);
    if (!change) {
        return {
            known: false,
            headline: 'Not enough history to determine what introduced this.',
        };
    }

    const symbol = extractIdentifier(input.message);
    const changeLine = Number(change.data?.['line'] ?? 0);
    const where = changeLine > 0 ? `line ${changeLine}` : 'this file';
    const gap = humanizeGap(seen.at - change.at);
    const detail = `First changed: ${where} · ~${gap} before the diagnostic`;

    // The timeline can say WHEN something changed. Only the live text can say
    // whether the identifier was ever assigned, so that clause is used only when
    // the host actually gave us the file.
    if (symbol && typeof input.documentText === 'string') {
        if (!isAssignedBefore(input.documentText, symbol, input.line)) {
            return {
                known: true,
                headline:
                    `${symbol} is referenced on line ${input.line}, but no assignment to it `
                    + 'was recorded before this diagnostic appeared.',
                detail,
            };
        }
        return {
            known: true,
            headline:
                `${symbol} is assigned earlier in ${input.fileName}, so this is not a missing assignment.`,
            detail,
        };
    }

    if (symbol) {
        return {
            known: true,
            headline: `${symbol} is referenced on line ${input.line} and is not defined at that point.`,
            detail,
        };
    }

    return {
        known: true,
        headline: `The last recorded change before this diagnostic was on ${where}.`,
        detail,
    };
}
