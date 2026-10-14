import * as vscode from 'vscode';

/**
 * StatusBar — the ONE global system status item in the VS Code footer.
 *
 * This is deliberately ONLY a status display: a single item that reads
 * "Ace.X: Monitoring" (or Paused / N errors) and opens the compact
 * companion status strip on click. It carries NO action controls — no
 * Explain, no Fix, no Voice. The floating Eve popup is the ONE
 * primary intervention surface; the companion panel is status/diagnostics
 * only; this item is global system status only.
 *
 * A second status bar item provides the "Chat with Eve" entry point — a
 * deliberate, single canonical way to start a conversation with Eve.
 */
export class StatusBar implements vscode.Disposable {
    private readonly monitorItem: vscode.StatusBarItem;
    private readonly chatItem: vscode.StatusBarItem;
    private transientTimer: ReturnType<typeof setTimeout> | null = null;
    private monitoringEnabled = true;
    private errorCount = 0;

    constructor() {
        this.monitorItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102);
        this.monitorItem.command = 'botx.openCompanionPanel';
        this.monitorItem.name = 'Ace.X Monitoring';

        this.chatItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
        this.chatItem.command = 'botx.chatWithEve';
        this.chatItem.name = 'Ace.X Chat with Eve';
        this.chatItem.text = '$(comment-discussion) Chat with Eve';
        this.chatItem.tooltip = 'Start a conversation with Eve';
        this.chatItem.show();

        this.render();
        this.monitorItem.show();
    }

    /**
     * Monitoring is the runtime truth from CompanionLoop; the panel and this
     * item are two renderings of that one flag.
     */
    setMonitoring(enabled: boolean): void {
        if (this.monitoringEnabled === enabled) {
            return;
        }
        this.monitoringEnabled = enabled;
        this.render();
    }

    /** Diagnostic error count in the active editor; falls back to the idle view. */
    setErrors(errorCount: number): void {
        const next = Math.max(0, errorCount);
        if (this.errorCount === next) {
            return;
        }
        this.errorCount = next;
        this.render();
    }

    /**
     * Voice has no status-bar control: the single microphone lives in the
     * Eve popup. Kept as a no-op so existing callers keep compiling; the
     * `botx.enableVoice` setting remains the single source of truth.
     */
    setVoice(_enabled: boolean): void {
        return;
    }

    /** Persistent idle state, used before the pipeline is wired. */
    setIdle(text: string, tooltip?: string): void {
        this.clearTransient();
        this.monitorItem.text = `$(eye) ${text}`;
        this.monitorItem.tooltip = tooltip ?? 'Ace.X is monitoring your workspace';
        this.monitorItem.backgroundColor = undefined;
    }

    /** Companion process state — reflects what the Robot Body is actually doing. */
    setCompanion(text: string, tooltip?: string): void {
        this.monitorItem.text = `$(vm-active) ${text}`;
        this.monitorItem.tooltip = tooltip ?? 'Ace.X Companion status';
    }

    /**
     * Temporary event overlay (sensor activity). Reverts to the persistent
     * state when the timeout expires, so the status bar never keeps a stale
     * message.
     */
    showEvent(text: string, icon: string, restore: () => void): void {
        this.clearTransient();
        this.monitorItem.text = `${icon} ${text}`;
        this.monitorItem.tooltip = 'Ace.X activity';
        this.monitorItem.backgroundColor = undefined;
        this.transientTimer = setTimeout(() => {
            this.transientTimer = null;
            restore();
            this.render();
        }, 4000);
    }

    dispose(): void {
        this.clearTransient();
        this.monitorItem.dispose();
        this.chatItem.dispose();
    }

    /** The persistent monitoring view: errors win, otherwise monitoring state. */
    private render(): void {
        if (this.transientTimer) {
            return;
        }
        if (this.errorCount > 0) {
            this.monitorItem.text = `$(error) Ace.X: ${this.errorCount} error${this.errorCount > 1 ? 's' : ''}`;
            this.monitorItem.tooltip = 'Diagnostics with Error severity in the active editor';
            this.monitorItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            return;
        }
        this.monitorItem.backgroundColor = undefined;
        if (this.monitoringEnabled) {
            this.monitorItem.text = '$(eye) Ace.X: Monitoring';
            this.monitorItem.tooltip = 'Eve is observing this workspace. Click to open the Ace.X panel.';
            return;
        }
        this.monitorItem.text = '$(eye-closed) Ace.X: Paused';
        this.monitorItem.tooltip = 'Monitoring is paused — Eve only responds when asked. Click to open the Ace.X panel.';
    }

    private clearTransient(): void {
        if (this.transientTimer) {
            clearTimeout(this.transientTimer);
            this.transientTimer = null;
        }
    }
}
