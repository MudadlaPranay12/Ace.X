import * as vscode from 'vscode';
import { renderPanelHtml } from './panelHtml';
import { hasRobotClients, onBrainFrame, type RobotPayload } from '../utils/websocketServer';
import type { CompanionStateSnapshot, CurrentIssue, LiveDiagnostic } from '../pipeline/companionLoop';
import type { WhatChangedReport } from '../timeline/whatChanged';
import { Logger } from '../utils/logger';
import type { CognitivePipeline } from '../pipeline/pipeline';
import { CodeSpotlight } from '../attention/codeSpotlight';

/**
 * CompanionPanel — the VS Code-native Ace.X status strip.
 *
 * ARCHITECTURE: this class is a READ-ONLY VIEW. It never decides and it
 * exposes NO action buttons (no Explain, no Fix, no Dismiss, no I'll Try,
 * no Chat, no Voice). The floating Eve popup is the ONE primary
 * intervention surface; this panel is a compact diagnostics/status
 * surface (~260-300px, header + Eve state + one current-issue line + one
 * status line, plus a verified-resolution line when one exists).
 *
 *   - State comes from `CompanionLoop.getStateSnapshot()`, which is a
 *     read-only view of fields the companion already maintains.
 *   - Live updates arrive on the ONE canonical Brain frame hook
 *     (`onBrainFrame`), i.e. the same EMOTION / TEACHING_STATE frames the
 *     Robot Body receives.
 *   - The single webview message handled is `ready` (initial state push).
 *     Every other inbound message is ignored on purpose.
 *
 * The Robot Body remains the canonical embodied Eve; this panel is a
 * status strip, not a replacement and not a second control surface.
 */

export interface CompanionPanelDeps {
    pipeline: CognitivePipeline;
    extensionUri: vscode.Uri;
    /**
     * Whether the canonical robot body is currently connected. Defaults to
     * the legacy WebSocket client count; the extension overrides it with the
     * in-VS Code view link so the panel never reports a false offline state.
     */
    isBodyConnected?: () => boolean;
}

export interface CompanionPanelState {
    monitoring: boolean;
    bodyConnected: boolean;
    eveState: string;
    /** One-line current-issue summary, e.g. "test.py:18 — customer_name". */
    current: string | null;
    /** Exactly one short status line. */
    statusLine: string;
    resolution: { verified: boolean; headline: string } | null;
    // ── Kept for diagnostics plumbing only (never rendered as panels) ────
    diagnostics: LiveDiagnostic[];
    teaching: { level: number; action: string };
    attention: string;
    struggle: string;
    struggleEvidence: string[];
    learning: { skill: string; recurringMistakes: number; resolvedMistakes: number };
    timeline: { time: string; kind: string; summary: string }[];
    /** Null when nothing is currently wrong. */
    issue: (CurrentIssue & { file: string; line: number }) | null;
    whatChanged: WhatChangedReport | null;
}

/** Canonical emotion → the coarse state a developer tool shows. */
function eveStateForEmotion(emotion: string): string {
    switch (emotion) {
        case 'THINKING':
            return 'Thinking';
        case 'CONFUSED':
        case 'ALERT':
            return 'Concerned';
        case 'SPEAKING':
            return 'Explaining';
        case 'ERROR':
            return 'Error';
        default:
            return 'Observing';
    }
}

/**
 * Frames that can change what the panel shows. CAPTION traffic is
 * Body-only: without a response area the panel has nothing to do with it,
 * and must not rebuild on every spoken line.
 */
const PANEL_FRAMES = new Set(['EMOTION', 'TEACHING_STATE', 'STRUGGLE_STATE', 'ATTENTION_TARGET']);

export class CompanionPanel implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'botx.companion';

    private view: vscode.WebviewView | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly unsubscribeFrames: () => void;
    /**
     * The shared attention target, drawn in the editor with native decorations.
     * It is fed from the same Brain target the Robot Body looks at, so the gaze
     * and the highlight can never disagree.
     */
    private readonly spotlight = new CodeSpotlight();

    /** Latest canonical emotion seen on the frame hook. */
    private lastEmotion = 'IDLE';
    private refreshQueued = false;

    constructor(private readonly deps: CompanionPanelDeps) {
        this.unsubscribeFrames = onBrainFrame((payload) => this.handleFrame(payload));
    }

    // ── WebviewViewProvider ────────────────────────────────────────────────

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, 'media')],
        };
        webviewView.webview.html = renderPanelHtml(webviewView.webview);
        this.disposables.push(
            webviewView.webview.onDidReceiveMessage((message) => {
                void this.handleMessage(message);
            })
        );
        this.disposables.push(
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) {
                    this.refresh('view visible');
                }
            })
        );
        this.refresh('view resolved');
    }

    // ── Canonical frame mirroring ──────────────────────────────────────────

    private handleFrame(payload: RobotPayload): void {
        if (!PANEL_FRAMES.has(payload.type)) {
            return;
        }

        if (payload.type === 'EMOTION') {
            this.lastEmotion = payload.emotion;
        }

        // TEACHING_STATE / STRUGGLE_STATE / ATTENTION_TARGET also change what
        // the panel shows, but the values themselves are read from the Brain's
        // own state in buildState() rather than from these frames, so there is
        // only ever one source for each number.
        this.refresh(`frame ${payload.type}`);
    }

    // ── Panel state ────────────────────────────────────────────────────────

    private buildState(): CompanionPanelState {
        const snapshot: CompanionStateSnapshot = this.deps.pipeline.getCompanion().getStateSnapshot();
        const issue = this.buildIssue(snapshot);
        const eveState = eveStateForEmotion(this.lastEmotion);
        const errorCount = snapshot.diagnostics.filter((d) => d.severity === 'Error').length;

        return {
            monitoring: snapshot.monitoringEnabled,
            bodyConnected: this.deps.isBodyConnected?.() ?? hasRobotClients(),
            eveState,
            current: issue ? issueSummary(issue) : null,
            statusLine: statusLineFor(snapshot.monitoringEnabled, issue, snapshot.teaching.action, errorCount),
            resolution: snapshot.resolution
                ? {
                    verified: snapshot.resolution.verified,
                    headline: snapshot.resolution.verified
                        ? `Fixed and verified: ${snapshot.resolution.headline}`
                        : `Not fixed: ${snapshot.resolution.headline}`,
                }
                : null,
            diagnostics: snapshot.diagnostics,
            teaching: { level: snapshot.teaching.level, action: snapshot.teaching.action },
            attention: snapshot.attention.active ? 'ACTIVE' : 'NONE',
            struggle: snapshot.struggle.label,
            struggleEvidence: snapshot.struggle.evidence,
            learning: {
                skill: snapshot.learning.skill,
                recurringMistakes: snapshot.learning.recurringMistakes,
                resolvedMistakes: snapshot.learning.resolvedMistakes,
            },
            timeline: snapshot.timeline.map((entry) => ({
                time: entry.time,
                kind: entry.kind,
                summary: entry.summary,
            })),
            // The Current Issue the panel names is the same diagnostic the
            // Brain points its attention at, so the strip and the editor
            // highlight can never describe different problems.
            issue,
            whatChanged: snapshot.whatChanged,
        };
    }

    /** Joins the Brain's current-matter summary with where it actually is. */
    private buildIssue(snapshot: CompanionStateSnapshot): (CurrentIssue & { file: string; line: number }) | null {
        if (!snapshot.issue) {
            return null;
        }
        const primary = snapshot.diagnostics.find((d) => d.severity === 'Error') ?? snapshot.diagnostics[0];
        if (!primary) {
            return null;
        }
        return {
            ...snapshot.issue,
            file: primary.file,
            line: primary.line,
        };
    }

    /**
     * Keeps the editor highlight in step with the Brain's shared attention
     * target. A released, expired or monitoring-off target clears it, so the
     * highlight can never outlive the reason it was drawn.
     */
    private syncSpotlight(snapshot: CompanionStateSnapshot): void {
        const attention = snapshot.attention;
        this.spotlight.update(
            snapshot.monitoringEnabled && attention.active
                ? {
                    file: attention.file,
                    line: attention.line,
                    active: true,
                }
                : { active: false }
        );
    }

    /**
     * Rebuilds state and pushes it to the webview. Frames can arrive in bursts
     * (a diagnostic batch emits teaching + struggle + attention together), so
     * refreshes are coalesced onto a microtask instead of one render per frame.
     */
    refresh(reason: string): void {
        // The editor highlight follows the Brain's shared attention target on
        // every refresh — including when the panel itself is collapsed, because
        // the highlight lives in the editor, not in the panel.
        this.sync();

        if (this.refreshQueued) {
            return;
        }
        this.refreshQueued = true;
        queueMicrotask(() => {
            this.refreshQueued = false;
            const view = this.view;
            if (!view || view.webview === undefined) {
                return;
            }
            const state = this.buildState();
            void view.webview.postMessage({ type: 'state', state });
            Logger.info('PANEL', { Event: 'State pushed', Reason: reason, Diagnostics: String(state.diagnostics.length) });
        });
    }

    /**
     * Pushes state to the webview AND keeps the editor highlight in step. Split
     * out of refresh() because the spotlight must also run when the panel itself
     * is collapsed — the highlight is an editor affordance, not a panel one.
     */
    sync(): void {
        this.syncSpotlight(this.deps.pipeline.getCompanion().getStateSnapshot());
    }

    // ── Panel intents: none. Status strip only. ────────────────────────────
    //
    // The webview posts `ready` when it boots; the reply is the current
    // state. There are no action intents to handle — Explain / Fix /
    // Dismiss / Chat / Voice all live exclusively in the floating Eve
    // popup, and any such message arriving here is ignored rather than
    // routed, so a second action surface can never grow back silently.

    private async handleMessage(message: { type?: string }): Promise<void> {
        if (!message || typeof message.type !== 'string') {
            return;
        }
        if (message.type === 'ready') {
            this.refresh('webview ready');
        }
    }

    dispose(): void {
        this.unsubscribeFrames();
        this.spotlight.dispose();
        while (this.disposables.length > 0) {
            const item = this.disposables.pop();
            try {
                item?.dispose();
            } catch {
                // Disposal must never throw during deactivation.
            }
        }
        this.view = undefined;
    }
}

/** One-line issue summary: "test.py:18 — customer_name". */
function issueSummary(issue: CurrentIssue & { file: string; line: number }): string {
    const fileName = issue.file.split(/[\\/]/).pop() || issue.file;
    const where = `${fileName}:${issue.line}`;
    const what = issue.symbol || issue.concept || issue.matter;
    return what ? `${where} — ${what}` : where;
}

/** Exactly one short status line for the compact strip. */
function statusLineFor(monitoring: boolean, issue: unknown, teachingAction: string, errorCount: number): string {
    if (!monitoring) {
        return 'Monitoring paused — Eve only responds when asked.';
    }
    if (issue) {
        const plural = errorCount === 1 ? '' : 's';
        return `${teachingAction} · ${errorCount} error${plural} in view. Use the Eve popup to act.`;
    }
    return 'Eve is observing.';
}
