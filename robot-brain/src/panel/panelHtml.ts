import * as vscode from 'vscode';

/**
 * panelHtml — markup for the Ace.X Companion panel.
 *
 * COMPACT STATUS SURFACE ONLY. This panel renders Brain state and nothing
 * else: monitoring flag, Eve status, one current-issue summary line and one
 * short status line (plus a verified-resolution line when one exists).
 *
 * It holds NO action buttons — no Explain, no Fix, no Dismiss, no I'll Try,
 * no Chat, no Voice. The floating Eve popup is the ONE primary intervention
 * surface; this panel must never duplicate its controls.
 *
 * Everything visual uses VS Code theme variables so the panel looks native
 * in any theme, and nothing here loads a remote resource. Layout is capped
 * to a narrow (~260-300px) column with compact typography so the view stays
 * a small status strip instead of a second application.
 */

export function renderPanelHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const csp = [
        "default-src 'none'",
        `style-src ${webview.cspSource} 'nonce-${nonce}'`,
        `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ace.X Companion</title>
<style nonce="${nonce}">${panelCss()}</style>
</head>
<body>
<main id="root">
    <header class="head">
        <div class="head-row">
            <span class="wordmark">ACE.X</span>
            <span class="monitor" id="monitor-line"><span class="dot" id="monitor-dot"></span><span id="monitor-text">Monitoring</span></span>
        </div>
    </header>

    <section class="block">
        <div class="eve-row"><span class="label">Eve</span><span class="chip" id="eve-state">Observing</span></div>
        <div class="current"><span class="label">Current</span><span id="current-issue">Nothing to report</span></div>
        <p id="status-line" class="muted small">Eve is observing.</p>
        <p id="resolution-line" class="small hidden"></p>
    </section>
</main>
<script nonce="${nonce}">${panelScript()}</script>
</body>
</html>`;
}

function createNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
        text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return text;
}

function panelCss(): string {
    return `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
    margin: 0;
    padding: 8px 10px 10px;
    max-width: 300px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, transparent);
    line-height: 1.4;
}
.hidden { display: none !important; }
.muted { color: var(--vscode-descriptionForeground); }
.small { font-size: 11px; }
.wordmark { font-size: 12px; font-weight: 700; letter-spacing: .14em; }
.head { padding-bottom: 6px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); }
.head-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.monitor { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--vscode-descriptionForeground); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-charts-green, #3fb950); flex: none; }
.dot.paused { background: var(--vscode-charts-yellow, #d29922); }

.block { margin-top: 8px; }
.label {
    font-size: 10px; letter-spacing: .1em; text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
}
.eve-row, .current { display: flex; align-items: baseline; gap: 6px; margin-bottom: 4px; }
.chip {
    font-size: 10.5px; padding: 1px 7px; border-radius: 9px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    color: var(--vscode-foreground); white-space: nowrap;
}
#current-issue { font-size: 11.5px; font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
#status-line { margin: 4px 0 0; }
#resolution-line { margin: 4px 0 0; color: var(--vscode-charts-green, #3fb950); }
#resolution-line.unverified { color: var(--vscode-editorWarning-foreground, #cca700); }
`;
}

function panelScript(): string {
    return `
const vscode = acquireVsCodeApi();

const el = (id) => document.getElementById(id);

function setHidden(node, hidden) {
    if (node) { node.classList.toggle('hidden', hidden); }
}

function render(state) {
    // Monitoring flag only — no body status lives here.
    const monitorText = state.monitoring ? 'Monitoring' : 'Paused';
    el('monitor-text').textContent = monitorText;
    el('monitor-dot').classList.toggle('paused', !state.monitoring);

    el('eve-state').textContent = state.eveState || 'Observing';
    el('current-issue').textContent = state.current || 'Nothing to report';
    el('status-line').textContent = state.statusLine || '';

    // Verified resolutions only; unverified outcomes are worded differently.
    const resolution = state.resolution;
    setHidden(el('resolution-line'), !resolution);
    if (resolution) {
        el('resolution-line').classList.toggle('unverified', !resolution.verified);
        el('resolution-line').textContent = resolution.headline;
    }
}

window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.type === 'state') {
        render(message.state);
    }
});

vscode.postMessage({ type: 'ready' });
`;
}
