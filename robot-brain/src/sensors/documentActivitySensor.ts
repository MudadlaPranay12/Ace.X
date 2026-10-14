import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { AetherEvent } from '../eventFilter/event';
import { Logger } from '../utils/logger';
import { parseCommentInstructions } from '../intent/commentInstruction';

/** After this long without an edit, the developer is considered to have stopped typing. */
const TYPING_IDLE_MS = 2500;

/**
 * DocumentActivitySensor — the behavioural signal source for struggle detection
 * and the debugging timeline.
 *
 * It reports three things and nothing more:
 *   - DOCUMENT_CHANGED / DOCUMENT_UNDO / DOCUMENT_REDO — what changed
 *   - TYPING_ACTIVITY — the developer is actively typing right now
 *   - TYPING_IDLE     — typing stopped
 *
 * PRIVACY: it reports counts, positions and file paths only. It never sends
 * document text to the timeline or anywhere else. Content is captured only where
 * a feature genuinely requires it (the existing diagnostic-analysis path), never
 * speculatively here.
 */
export class DocumentActivitySensor {
    private readonly eventFilter: EventFilter;
    private typingTimer: ReturnType<typeof setTimeout> | undefined;
    private idleTimer: ReturnType<typeof setTimeout> | undefined;
    private changeCounter = 0;
    private typingSince = 0;
    private readonly seenInstructions = new Set<string>();
    private readonly commentTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }

    start(context: vscode.ExtensionContext): void {
        Logger.info('DOCUMENT ACTIVITY SENSOR', { Event: 'Started' });

        context.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e))
        );

        context.subscriptions.push({
            dispose: () => {
                if (this.typingTimer) { clearTimeout(this.typingTimer); }
                if (this.idleTimer) { clearTimeout(this.idleTimer); }
                for (const timer of this.commentTimers.values()) clearTimeout(timer);
                this.commentTimers.clear();
            }
        });
    }

    private onChange(e: vscode.TextDocumentChangeEvent): void {
        if (e.document.uri.scheme !== 'file') {
            return;
        }
        if (e.contentChanges.length === 0) {
            return;
        }

        const now = Date.now();
        const file = e.document.fileName;
        const first = e.contentChanges[0];
        const line = first?.range.start.line ?? 0;

        if (this.typingSince === 0) {
            this.typingSince = now;
            this.publish(EventType.TYPING_ACTIVITY, file, e.document.languageId, now, { Line: line, BurstStart: true });
        } else {
            this.publish(EventType.TYPING_ACTIVITY, file, e.document.languageId, now, { Line: line, Changes: ++this.changeCounter });
        }

        this.publish(EventType.DOCUMENT_CHANGED, file, e.document.languageId, now, {
            Line: line,
            Changes: this.changeCounter,
            Reason: e.reason ?? 'edit',
            Characters: e.contentChanges.reduce((sum, c) => sum + (c.text?.length ?? 0), 0),
        });

        // Check for natural-language coding intent in the changed line
        // Only check when text was added (not just deleted)
        const addedText = e.contentChanges
            .filter(c => c.text && c.text.length > 0)
            .map(c => c.text)
            .join('\n');
        const uri = e.document.uri.toString();
        clearTimeout(this.commentTimers.get(uri));
        this.commentTimers.set(uri, setTimeout(() => {
            this.commentTimers.delete(uri);
            if (!e.document.isClosed && vscode.workspace.isTrusted && vscode.workspace.getWorkspaceFolder(e.document.uri)) this.checkCodingIntent(e.document);
        }, TYPING_IDLE_MS));

        if (e.reason === vscode.TextDocumentChangeReason.Undo) {
            this.publish(EventType.DOCUMENT_UNDO, file, e.document.languageId, now, { Line: line });
        } else if (e.reason === vscode.TextDocumentChangeReason.Redo) {
            this.publish(EventType.DOCUMENT_REDO, file, e.document.languageId, now, { Line: line });
        }

        // Debounce the typing/idle edges so a burst does not flood the filter.
        if (this.typingTimer) { clearTimeout(this.typingTimer); }
        if (this.idleTimer) { clearTimeout(this.idleTimer); }
        this.typingTimer = setTimeout(() => { this.typingSince = 0; this.changeCounter = 0; }, TYPING_IDLE_MS);
        this.idleTimer = setTimeout(() => {
            this.publish(EventType.TYPING_IDLE, file, e.document.languageId, Date.now(), { Line: line });
        }, TYPING_IDLE_MS);
    }

    /**
     * Checks if the given line contains a natural-language coding intent comment.
     *
     * Detection itself is delegated to the ONE existing deterministic detector in
     * `intent/codingIntent.ts`, so this sensor never keeps a second copy of the
     * verb list, the non-coding overrides or the confidence scoring. This method
     * only does the two things the detector deliberately does not do: confirm the
     * language has a single-line comment syntax, and confirm the changed line
     * actually IS a comment line rather than ordinary code that merely contains
     * a coding-like word.
     */
    private checkCodingIntent(document: vscode.TextDocument): void {
        for (const instruction of parseCommentInstructions(document.getText(), document.languageId, document.uri.toString())) {
            if (this.seenInstructions.has(instruction.id)) continue;
            this.seenInstructions.add(instruction.id);
            this.publish(EventType.CODING_INTENT_DETECTED, document.fileName || '', document.languageId, Date.now(), {
                InstructionId: instruction.id,
                FileUri: document.uri.toString(),
                Line: instruction.startLine + 1,
                StartLine: instruction.startLine + 1,
                EndLine: instruction.endLine + 1,
                IntentText: instruction.text,
                Language: instruction.language,
                Comment: instruction.raw,
                DocumentVersion: document.version,
            });
        }
    }

    /**
     * The single-line comment prefix for a VS Code languageId, or null when the
     * language has no single-line comment syntax this sensor recognises.
     */
    private getCommentConfig(languageId: string): { singleLinePrefix: string } | null {
        const map: Record<string, { singleLinePrefix: string }> = {
            python: { singleLinePrefix: '#' },
            python3: { singleLinePrefix: '#' },
            javascript: { singleLinePrefix: '//' },
            javascriptreact: { singleLinePrefix: '//' },
            typescript: { singleLinePrefix: '//' },
            typescriptreact: { singleLinePrefix: '//' },
            java: { singleLinePrefix: '//' },
            c: { singleLinePrefix: '//' },
            cpp: { singleLinePrefix: '//' },
            'c++': { singleLinePrefix: '//' },
            csharp: { singleLinePrefix: '//' },
            'c#': { singleLinePrefix: '//' },
            go: { singleLinePrefix: '//' },
            golang: { singleLinePrefix: '//' },
            rust: { singleLinePrefix: '//' },
            kotlin: { singleLinePrefix: '//' },
            php: { singleLinePrefix: '//' },
            ruby: { singleLinePrefix: '#' },
            swift: { singleLinePrefix: '//' },
            dart: { singleLinePrefix: '//' },
            sql: { singleLinePrefix: '--' },
            shell: { singleLinePrefix: '#' },
            bash: { singleLinePrefix: '#' },
            sh: { singleLinePrefix: '#' },
        };
        const normalized = languageId.toLowerCase();
        if (normalized === 'py') return map.python;
        if (normalized === 'js' || normalized === 'jsx') return map.javascript;
        if (normalized === 'ts' || normalized === 'tsx') return map.typescript;
        if (normalized === 'rb') return map.ruby;
        if (normalized === 'sh' || normalized === 'bash' || normalized === 'zsh') return map.shell;
        if (normalized === 'c++' || normalized === 'cxx' || normalized === 'cc') return map.cpp;
        if (normalized === 'c#') return map.csharp;
        if (normalized === 'golang') return map.go;
        if (normalized === 'rs') return map.rust;
        if (normalized === 'kt') return map.kotlin;
        if (normalized === 'pl') return { singleLinePrefix: '#' };
        return map[normalized] ?? { singleLinePrefix: '#' };
    }

    private publish(type: EventType, file: string, language: string, timestamp: number, extra: Record<string, unknown>): void {
        this.eventFilter.publish({
            id: `doc-activity-${type}-${timestamp}-${Math.random().toString(36).slice(2, 9)}`,
            type,
            timestamp,
            source: 'DocumentActivitySensor',
            payload: { File: file, Language: language, ...extra },
        } satisfies AetherEvent);
    }
}
