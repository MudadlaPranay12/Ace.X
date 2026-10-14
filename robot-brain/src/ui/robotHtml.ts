import * as vscode from 'vscode';

/**
 * Canonical Ace.X robot view markup: Eve's 3D canvas on top, one response bar
 * directly beneath it, and nothing else. No chat box, no voice button, no
 * dashboard — the Brain decides everything the view shows.
 */
export function renderRobotHtml(webview: vscode.Webview, extensionUri: vscode.Uri, surface: string): string {
    const nonce = createNonce();
    const robotJs = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'robot', 'robot.js'));
    const modelUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'robot', 'eve.glb'));
    const threeUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'media', 'robot', 'vendor', 'three', 'build', 'three.module.min.js')
    );
    const addonsUri =
        webview.asWebviewUri(
            vscode.Uri.joinPath(extensionUri, 'media', 'robot', 'vendor', 'three', 'examples', 'jsm')
        ).toString() + '/';
    const csp = [
        "default-src 'none'",
        `style-src ${webview.cspSource} 'nonce-${nonce}'`,
        `script-src ${webview.cspSource} 'nonce-${nonce}'`,
        `connect-src ${webview.cspSource}`,
        `img-src ${webview.cspSource} data:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ace.X Robot</title>
<style nonce="${nonce}">
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; }
body { display: flex; flex-direction: column; }
#robotCanvas { flex: 1 1 auto; width: 100%; min-height: 0; display: block; }
#acexBrand {
    flex: 0 0 auto; text-align: center; padding-top: 6px;
    font-size: 10px; font-weight: 700; letter-spacing: .22em;
    color: var(--vscode-descriptionForeground, #8a9fb3);
    user-select: none;
}
#eveStatus {
    position: absolute; top: 12px; left: 0; right: 0; text-align: center;
    font-size: 11px; color: var(--vscode-descriptionForeground, #8a9fb3);
    pointer-events: none;
}
#eveStatus.hidden { display: none; }
#eveStatus.error { color: var(--vscode-editorWarning-foreground, #cca700); }
#responseBar {
    flex: 0 0 auto; margin: 6px 8px 8px; padding: 8px 10px;
    background: var(--vscode-sideBar-background, rgba(13,17,23,0.9));
    border: 1px solid var(--vscode-panel-border, rgba(0,242,254,0.35));
    border-radius: 10px; color: var(--vscode-foreground, #d7e3ea);
    font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
    font-size: 12px; line-height: 1.5;
}
#responseBar.hidden { display: none; }
#responseLabel {
    font-size: 10px; letter-spacing: .09em; text-transform: uppercase;
    color: var(--vscode-descriptionForeground, #6b8a9a); margin-bottom: 3px;
}
#responseText { white-space: pre-wrap; word-break: break-word; }
#responseActions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
#responseActions:empty { display: none; }
.acex-btn {
    font-family: inherit; font-size: 11px; padding: 3px 10px; cursor: pointer;
    color: #0d1117; background: linear-gradient(135deg, #00f2fe, #00c8d8);
    border: none; border-radius: 6px; font-weight: 600;
}
.acex-btn.secondary { background: transparent; color: var(--vscode-descriptionForeground, #8a9fb3); border: 1px solid rgba(0,242,254,0.3); }
.acex-btn:focus-visible { outline: 2px solid #00f2fe; outline-offset: 2px; }
</style>
</head>
<body data-surface="${surface}" data-model="${modelUri}">
<div id="acexBrand">ACE.X</div>
<canvas id="robotCanvas"></canvas>
<div id="eveStatus" role="status">Initializing Eve...</div>
<section id="responseBar" class="hidden" role="status" aria-live="polite">
<div id="responseLabel">EVE</div>
<div id="responseText"></div>
<div id="responseActions"></div>
</section>
<script type="importmap" nonce="${nonce}">
{
    "imports": {
        "three": "${threeUri}",
        "three/addons/": "${addonsUri}"
    }
}
</script>
<script type="module" nonce="${nonce}" src="${robotJs}"></script>
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
