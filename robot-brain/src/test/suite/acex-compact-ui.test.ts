import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as vscode from 'vscode';
import { onBrainFrame } from '../../utils/websocketServer';
import { sendToRobot } from '../../utils/websocketServer';
import { RobotStatePublisher } from '../../ui/robotStatePublisher';
import { renderPanelHtml } from '../../panel/panelHtml';
import { selectTargetDiagnostic } from '../../conversation/eveConversation';

/**
 * ACE.X FINAL INTERACTION + COMPACT COMPANION UI PASS.
 *
 * Proves, against the REAL sources (not reimplementations):
 *
 *  1. The floating Eve popup is the ONE primary action surface — no
 *     duplicate Explain / Fix / Dismiss / Chat / Voice controls exist in
 *     the Companion panel, the VS Code status bar, or the in-VS-Code Eve
 *     webview.
 *  2. The popup's actual button handlers execute the real click path:
 *     the button-building + handler source is extracted VERBATIM from
 *     robot-body/renderer.js and executed with a DOM shim (a true Electron
 *     DOM click is not available inside the extension test host, so the DOM
 *     is shimmed while every handler line under test is the shipped code).
 *     Clicks carry the VISIBLE popup's own { matter, file, line } identity,
 *     retarget on popup replacement (no stale closures), and Dismiss hides
 *     the popup while notifying the Brain.
 *  3. The Companion panel is a compact status strip (no buttons, narrow,
 *     header + Eve state + one current line + one status line).
 *  4. Voice has exactly one control: the Eve popup microphone.
 *  5. Multi-diagnostic targeting binds Explain/Fix to the visible popup
 *     line, never to the first error.
 */

const BRAIN_ROOT = path.join(__dirname, '..', '..', '..');
const BODY_ROOT = path.join(BRAIN_ROOT, '..', 'robot-body');

function readSource(relative: string): string {
    return fs.readFileSync(path.join(BRAIN_ROOT, relative), 'utf8');
}

function readBody(relative: string): string {
    return fs.readFileSync(path.join(BODY_ROOT, relative), 'utf8');
}

// ── Real-handler sandbox ────────────────────────────────────────────────
// Executes the shipped popup-action region of renderer.js verbatim.

interface SandboxHost {
    log: Array<Record<string, unknown>>;
    flags: { voiceToggled: number; hideCalled: number };
}

const ACTION_BEGIN = '__EVE_POPUP_ACTIONS_BEGIN__';
const ACTION_END = '__EVE_POPUP_ACTIONS_END__';

function actionRegion(): string {
    const source = readBody('renderer.js');
    const begin = source.indexOf(`// ${ACTION_BEGIN}`);
    // The END marker must be matched as a full comment line: prose above may
    // mention the marker name without being the boundary.
    const end = source.indexOf(`\n// ${ACTION_END}`, begin);
    assert.ok(begin >= 0 && end > begin, 'renderer.js must expose the verifiable popup-action region');
    const endLine = source.indexOf('\n', end + 1) + 1;
    const region = source.slice(begin, endLine);
    assert.ok(region.includes('function buildPopupActions'), 'extracted region must contain the button renderer');
    assert.ok(region.includes('function dismissBubble'), 'extracted region must contain the dismiss handler');
    return region;
}

const SHIM_PRELUDE = `
let latestIssue = null;
let detailsOpen = false;
let dismissedCaption = null;
const __kids = [];
const bubbleActions = {
  _kids: __kids,
  set innerHTML(v) { __kids.length = 0; },
  get innerHTML() { return ''; },
  appendChild(b) { __kids.push(b); }
};
function __makeButton() {
  return {
    id: '', className: '', textContent: '', title: '', dataset: {},
    _handlers: {},
    setAttribute() {},
    addEventListener(t, h) { this._handlers[t] = h; },
    click() {
      const h = this._handlers['click'];
      if (!h) { throw new Error('button has no click handler'); }
      h({ stopPropagation() {} });
    }
  };
}
const document = { createElement(tag) { return __makeButton(); } };
const voice = { state: 'idle' };
const behaviour = { snapshot() { return { caption: 'shim caption' }; } };
const bubbleText = { textContent: '' };
function refreshResponseBar() {}
function toggleVoiceInput() { __host.flags.voiceToggled += 1; }
function hidePopup() { __host.flags.hideCalled += 1; }
function sendToBrain(m) { __host.log.push(JSON.parse(JSON.stringify(m))); }
function __setIssue(v) { latestIssue = v; }
function __getIssue() { return JSON.stringify(latestIssue); }
function __buttons() { return JSON.stringify(__kids.map((b) => ({ id: b.id, action: b.dataset.action, text: b.textContent }))); }
function __click(action) {
  const b = __kids.find((k) => k.dataset.action === action);
  if (!b) { throw new Error('no rendered button for action: ' + action); }
  b.click();
}
function __bubbleText() { return bubbleText.textContent; }
`;

interface PopupButton {
    id: string;
    action: string;
    text: string;
}

function makePopupHarness(): {
    host: SandboxHost;
    setIssue: (issue: unknown) => void;
    build: (options: Record<string, unknown>) => void;
    buttons: () => PopupButton[];
    click: (action: string) => void;
    lastSent: () => Record<string, unknown>;
    sentCount: () => number;
    bubbleText: () => string;
    currentIssue: () => unknown;
} {
    const host: SandboxHost = { log: [], flags: { voiceToggled: 0, hideCalled: 0 } };
    const context = vm.createContext({ __host: host });
    vm.runInContext(`${SHIM_PRELUDE}\n${actionRegion()}`, context);
    const run = (code: string): void => {
        vm.runInContext(code, context);
    };
    const read = (code: string): string => {
        const value: unknown = vm.runInContext(code, context);
        return String(value);
    };
    return {
        host,
        setIssue: (issue: unknown) => run(`__setIssue(${JSON.stringify(issue)});`),
        build: (options: Record<string, unknown>) => run(`buildPopupActions(${JSON.stringify(options)});`),
        buttons: () => JSON.parse(read('__buttons()')) as PopupButton[],
        click: (action: string) => run(`__click(${JSON.stringify(action)});`),
        lastSent: () => host.log[host.log.length - 1],
        sentCount: () => host.log.length,
        bubbleText: () => read('__bubbleText()'),
        currentIssue: () => JSON.parse(read('__getIssue()') as string) as unknown,
    };
}

function errorPopup(matter: string, line: number, filePath = 'D:\\demo\\test.py'): Record<string, unknown> {
    return { visible: true, severity: 'ERROR', matter, filePath, line, file: `test.py:${line}` };
}

/** Messages cross the vm realm boundary, so compare their plain JSON shape. */
function plain(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value));
}

suite('ACE.X single action surface', () => {
    test('companion panel renders status only: no buttons, no actions', () => {
        const fakeWebview = { cspSource: 'vscode-webview://test' } as unknown as vscode.Webview;
        const html = renderPanelHtml(fakeWebview);
        assert.ok(!html.includes('<button'), 'compact panel must not render any <button>');
        for (const forbidden of ['Explain', 'Fix with', 'Dismiss', 'Chat', 'Voice', 'voice', 'Timeline', 'timeline', 'Learning', 'learning', 'microphone', 'micButton', 'btn-explain', 'btn-fix', "type: 'explain'", "type: 'fix'", "type: 'dismiss'", "type: 'chat'", "type: 'voice'"]) {
            assert.ok(!html.includes(forbidden), `compact panel must not contain ${forbidden}`);
        }
        for (const required of ['monitor-text', 'eve-state', 'current-issue', 'status-line', 'resolution-line', 'ACE.X']) {
            assert.ok(html.includes(required), `compact panel must contain ${required}`);
        }
        // The webview posts exactly one message kind: ready. No action intents.
        const posts = html.match(/postMessage\(\{ type: '[^']+' \}\)/g) ?? [];
        assert.deepStrictEqual(posts, ["postMessage({ type: 'ready' })"], 'panel webview must only announce readiness');
    });

    test('companion panel is compact: narrow column, small type, no cards', () => {
        const fakeWebview = { cspSource: 'vscode-webview://test' } as unknown as vscode.Webview;
        const html = renderPanelHtml(fakeWebview);
        assert.ok(html.includes('max-width: 300px'), 'panel must cap its width to a narrow strip');
        assert.ok(!html.includes('min-height') && !html.includes('height: 100'), 'panel must not hard-code a tall surface');
    });

    test('companion panel host holds no action intents', () => {
        const source = readSource(path.join('src', 'panel', 'companionPanel.ts'));
        for (const forbidden of [
            'btn-explain', 'withDiagnostic', 'runAsk', 'openChat', 'toggleChat',
            "executeCommand('botx.explainError')", "executeCommand('botx.fixWithEve')",
            "executeCommand('botx.setVoice')", "'illTry'", "'whatChanged'",
        ]) {
            assert.ok(!source.includes(forbidden), `companionPanel.ts must not contain ${forbidden}`);
        }
        // CAPTION traffic is Body-only: the frames the panel subscribes to
        // must not include it (checked on the declaration, not on prose).
        const frames = source.match(/PANEL_FRAMES = new Set\(\[([^\]]*)\]\)/);
        assert.ok(frames, 'panel must declare its subscribed frames');
        assert.ok(!frames![1].includes('CAPTION'), 'panel must not rebuild on caption traffic');
        assert.ok(source.includes('statusLine'), 'panel state must carry one short status line');
        assert.ok(source.includes("message.type === 'ready'"), 'panel must only answer readiness');
    });

    test('status bar is one monitoring item plus Chat with Eve entry', () => {
        const source = readSource(path.join('src', 'StatusBar.ts'));
        const created = source.match(/createStatusBarItem/g) ?? [];
        assert.strictEqual(created.length, 2, `exactly two status bar items must exist (monitor + chat), found ${created.length}`);
        // The chat item must use the chatWithEve command
        assert.ok(source.includes('botx.chatWithEve'), 'chat item must use botx.chatWithEve command');
        assert.ok(source.includes('comment-discussion'), 'chat item must show chat icon');
        // The monitor item must not contain action controls
        for (const forbidden of ['voiceItem', 'toggleVoice', 'unmute', 'micButton', 'explainError', 'fixWithEve', 'btn-']) {
            assert.ok(!source.includes(forbidden), `StatusBar.ts must not contain ${forbidden}`);
        }
        assert.ok(source.includes('Ace.X: Monitoring'), 'the monitor item must read Ace.X: Monitoring');
    });

    test('in-VS-Code Eve webview is diagnostics-only: no duplicate buttons', () => {
        const source = readBody(path.join('..', 'robot-brain', 'media', 'robot', 'robot.js'));
        for (const forbidden of ['EXPLAIN_REQUEST', 'FIX_REQUEST', 'addAction', 'Fix with Ace.X', "postMessage({ type: 'DISMISS'"]) {
            assert.ok(!source.includes(forbidden), `robot.js must not contain a duplicate action surface (${forbidden})`);
        }
        assert.ok(source.includes("responseActions.innerHTML = '';"), 'the diagnostics view must always clear its action row');
    });

    test('voice has exactly one control: the Eve popup microphone', () => {
        const bodyHtml = readBody('index.html');
        const renderer = readBody('renderer.js');
        assert.ok(bodyHtml.includes('id="bubbleActions"'), 'Eve popup must own the action row');
        const micIds = renderer.match(/id = 'micButton'/g) ?? [];
        assert.strictEqual(micIds.length, 1, 'exactly one microphone control must exist in the Eve popup');
        assert.ok(renderer.includes('VOICE_TEXT') && renderer.includes('SpeechRecognition'), 'the mic must use the existing voice router');
        const fakeWebview = { cspSource: 'vscode-webview://test' } as unknown as vscode.Webview;
        assert.ok(!renderPanelHtml(fakeWebview).includes('mic'), 'the companion panel must not duplicate the mic');
        assert.ok(!readSource(path.join('src', 'StatusBar.ts')).includes('micButton'), 'the status bar must not duplicate the mic');
    });

    test('popup renderer replaces controls: never appends, never duplicates listeners', () => {
        const renderer = readBody('renderer.js');
        assert.ok(renderer.includes('bubbleActions.innerHTML = \'\';'), 'each render must replace the button row');
        const appends = renderer.match(/bubbleActions\.appendChild/g) ?? [];
        assert.ok(appends.length <= 2, `only the button helper and the mic may append, found ${appends.length}`);
        assert.ok(renderer.includes("btn.dataset.action = action"), 'buttons must carry stable verifiable actions');
        assert.ok(renderer.includes('eve-${action}-btn'), 'buttons must carry stable ids');
    });

    test('failure popups offer Explain + Retry; success popups offer neither', () => {
        const renderer = readBody('renderer.js');
        assert.ok(renderer.includes("'Retry'"), 'FAILURE popups must label the fix button Retry');
        assert.ok(renderer.includes('explain: !isSuccess'), 'FAILURE keeps Explain, SUCCESS keeps neither');
    });
});

suite('ACE.X popup click path (real handler source)', () => {
    test('Explain has a correlated response/loading path and duplicate guard', () => {
        const renderer = readBody('renderer.js');
        assert.ok(renderer.includes("type: 'EXPLAIN_REQUEST'"), 'Explain must use the Brain request path');
        assert.ok(renderer.includes('requestId'), 'Explain requests must be correlated to their issue');
        assert.ok(renderer.includes("status === 'loading'"), 'Explain must expose a loading state');
        assert.ok(renderer.includes('No response received from the Brain'), 'Explain must expose a timeout/error state');
        assert.ok(renderer.includes("status === 'loading') { return; }"), 'one click must produce one logical request');
        assert.ok(renderer.includes("type: 'EVE_RESPONSE'"), 'Explain must render the Brain response');
    });

    test('canonical Chat with Eve remains discoverable and persistent in the Body', () => {
        const statusBar = readSource(path.join('src', 'StatusBar.ts'));
        const extension = readSource(path.join('src', 'extension.ts'));
        const index = readBody('index.html');
        assert.ok(statusBar.includes("this.chatItem.command = 'botx.chatWithEve'"));
        assert.ok(extension.includes("chatOpen = true"));
        assert.ok(index.includes('id="eveChat"'));
        assert.ok(index.includes('id="chatForm"'));
    });

    test('clicking Explain sends EXPLAIN_REQUEST for the visible popup issue', () => {
        const popup = makePopupHarness();
        popup.setIssue(errorPopup('m-18', 18));
        popup.build({ fix: true, fixLabel: 'Fix', matter: 'm-18', explain: true, details: false, dismiss: true });
        const actions = popup.buttons().map((b) => b.action).sort();
        assert.deepStrictEqual(actions, ['dismiss', 'explain', 'fix', 'voice'], 'ERROR popup must render Explain/Fix/Dismiss/mic exactly once');
        popup.click('explain');
        assert.deepStrictEqual(plain(popup.lastSent()), {
            type: 'EXPLAIN_REQUEST', matter: 'm-18', file: 'D:\\demo\\test.py', line: 18,
            requestId: (popup.lastSent() as { requestId: string }).requestId, severity: 'ERROR',
        });
    });

    test('clicking Fix sends FIX_REQUEST for the visible popup issue and points at VS Code approval', () => {
        const popup = makePopupHarness();
        popup.setIssue(errorPopup('m-18', 18));
        popup.build({ fix: true, fixLabel: 'Fix', matter: 'm-18', explain: true, details: false, dismiss: true });
        popup.click('fix');
        const sent = popup.lastSent();
        assert.strictEqual(sent['type'], 'FIX_REQUEST');
        assert.strictEqual(sent['matter'], 'm-18');
        assert.strictEqual(sent['line'], 18);
        assert.ok(
            popup.bubbleText().includes('Review the proposed change in VS Code'),
            'Fix must point at the existing VS Code diff + modal approval, never approve itself'
        );
    });

    test('re-render replaces buttons: one issue never produces repeated rows', () => {
        const popup = makePopupHarness();
        popup.setIssue(errorPopup('m-18', 18));
        const options = { fix: true, fixLabel: 'Fix', matter: 'm-18', explain: true, details: false, dismiss: true };
        popup.build(options);
        popup.build(options);
        popup.build(options);
        assert.strictEqual(popup.buttons().length, 4, 'repeated renders must replace, not append');
        popup.click('explain');
        assert.strictEqual(popup.sentCount(), 1, 'one click must fire exactly once (no duplicated listeners)');
    });

    test('popup replacement retargets clicks: no stale closures', () => {
        const popup = makePopupHarness();
        popup.setIssue(errorPopup('m-18', 18));
        popup.build({ fix: true, fixLabel: 'Fix', matter: 'm-18', explain: true, details: false, dismiss: true });
        // The popup is replaced by ERROR B. The OLD Fix button instance must
        // still act on the CURRENT (visible) issue, because handlers read the
        // live popup identity at click time.
        popup.setIssue(errorPopup('m-7', 7));
        popup.click('fix');
        assert.strictEqual(popup.lastSent()['matter'], 'm-7');
        assert.strictEqual(popup.lastSent()['line'], 7);
        // After the replacement re-renders, handlers target ERROR B as well.
        popup.build({ fix: true, fixLabel: 'Fix', matter: 'm-7', explain: true, details: false, dismiss: true });
        popup.click('explain');
        assert.deepStrictEqual(plain(popup.lastSent()), {
            type: 'EXPLAIN_REQUEST', matter: 'm-7', file: 'D:\\demo\\test.py', line: 7,
            requestId: (popup.lastSent() as { requestId: string }).requestId, severity: 'ERROR',
        });
    });

    test('multiple diagnostics: clicks follow the visible popup line, never the first error', () => {
        const popup = makePopupHarness();
        const line1 = errorPopup('m-import', 1);
        const line7 = { ...errorPopup('m-discount', 7), file: 'test.py:7' };
        const line18 = errorPopup('m-customer', 18);
        popup.setIssue(line18);
        popup.build({ fix: true, fixLabel: 'Fix', matter: 'm-customer', explain: true, details: false, dismiss: true });
        popup.click('explain');
        assert.strictEqual(popup.lastSent()['line'], 18, 'visible line 18 must be explained, not line 1');
        popup.setIssue(line7);
        popup.build({ fix: true, fixLabel: 'Fix', matter: 'm-discount', explain: true, details: false, dismiss: true });
        popup.click('fix');
        assert.strictEqual(popup.lastSent()['line'], 7, 'visible line 7 must be fixed, not line 1');
        popup.setIssue(line1);
        popup.build({ fix: true, fixLabel: 'Fix', matter: 'm-import', explain: true, details: false, dismiss: true });
        popup.click('explain');
        assert.strictEqual(popup.lastSent()['line'], 1);
        assert.strictEqual(popup.lastSent()['matter'], 'm-import');
    });

    test('mic routes through the existing voice path; dismiss hides and notifies', () => {
        const popup = makePopupHarness();
        popup.setIssue(errorPopup('m-18', 18));
        popup.build({ fix: true, fixLabel: 'Fix', matter: 'm-18', explain: true, details: false, dismiss: true });
        const mic = popup.buttons().find((b) => b.action === 'voice');
        assert.ok(mic && mic.id === 'micButton', 'the single mic control must be identifiable');
        popup.click('voice');
        assert.strictEqual(popup.host.flags.voiceToggled, 1, 'mic must use the existing voice router');
        assert.strictEqual(popup.sentCount(), 0, 'toggling the mic must not fake an Explain/Fix request');
        popup.click('dismiss');
        assert.strictEqual(popup.lastSent()['type'], 'USER_DISMISS');
        assert.strictEqual(popup.currentIssue(), null, 'dismiss must clear the current popup issue');
        assert.strictEqual(popup.host.flags.hideCalled, 1, 'dismiss must hide the popup');
    });
});

suite('ACE.X brain-side issue targeting', () => {
    const diags = [
        { message: 'Import X could not be resolved', line: 0, severity: 'Error' },
        { message: '"discount_rate" is not defined', line: 6, severity: 'Warning' },
        { message: '"customer_name" is not defined', line: 17, severity: 'Error' },
    ];

    test('popup line wins over file order for line 18, line 7 and line 1', () => {
        assert.strictEqual(selectTargetDiagnostic(diags, { file: 'test.py', line: 18, matter: 'm-customer' }), 2);
        assert.strictEqual(selectTargetDiagnostic(diags, { file: 'test.py', line: 7, matter: 'm-discount' }), 1);
        assert.strictEqual(selectTargetDiagnostic(diags, { file: 'test.py', line: 1, matter: 'm-import' }), 0);
    });

    test('stale or unrelated popup targets match nothing instead of hijacking another error', () => {
        assert.strictEqual(selectTargetDiagnostic(diags, { line: 99 }), -1);
        assert.strictEqual(selectTargetDiagnostic([], { line: 1 }), -1);
        assert.strictEqual(selectTargetDiagnostic(diags, { matter: 'other', message: 'something else entirely' }), -1);
    });

    test('popup replacement emits the new matter; same content never re-renders', () => {
        const publisher = new RobotStatePublisher();
        publisher.start();
        const states: Array<{ matter?: string; line?: number }> = [];
        const stop = onBrainFrame((payload) => {
            if (payload.type === 'ISSUE_STATE') {
                const state = payload.state as { matter?: string; line?: number };
                // The test host runs the live extension on the same frame bus;
                // only track this test's own matters.
                if (state.matter === 'm-18' || state.matter === 'm-7') {
                    states.push({ matter: state.matter, line: state.line });
                }
            }
        });
        const issueFor = (matter: string, line: number) => ({
            matter,
            recurrence: 2,
            recurring: true,
            file: 'D:\\demo\\test.py',
            fileName: 'test.py',
            line,
            severity: 'Error' as const,
            message: `"name-${matter}" is not defined`,
            teachingLevel: 2,
            verbose: false,
        });
        let current = issueFor('m-18', 18);
        publisher.setIssueProvider(() => ({ issue: current, resolution: null, voiceEnabled: false }));
        sendToRobot({ type: 'TEACHING_STATE', level: 2, matter: 'm-18' });
        sendToRobot({ type: 'TEACHING_STATE', level: 2, matter: 'm-18' });
        assert.strictEqual(states.length, 1, 'identical popup content must not re-render');
        current = issueFor('m-7', 7);
        sendToRobot({ type: 'TEACHING_STATE', level: 2, matter: 'm-7' });
        assert.strictEqual(states.length, 2, 'ERROR B must replace ERROR A');
        assert.deepStrictEqual(states[1], { matter: 'm-7', line: 7 }, 'the replacement must carry the new issue identity');
        stop();
        publisher.dispose();
    });
});
