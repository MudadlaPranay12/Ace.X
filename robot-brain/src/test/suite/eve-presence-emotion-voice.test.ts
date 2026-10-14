import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProcessManager } from '../../ProcessManager';
import { buildPopupState } from '../../ui/robotPopup';
import { resolveSemanticEmotion, SEMANTIC_PRIORITY, type SemanticRobotState } from '../../behaviour/semanticEmotion';

/**
 * ACE.X EVE SIZE + EMOTION + VOICE PASS.
 *
 * Proves against the REAL sources:
 *
 *  1. ONE Eve only — single-instance lock, one BrowserWindow, one launch
 *     entry (ensureEveRunning), no visible robot from tests, no body
 *     auto-launch in the test host.
 *  2. Smaller window defaults with saved geometry still respected.
 *  3. ONE central semantic → emotion mapping for all 14 required states,
 *     resolving onto the Body's closed 8-emotion vocabulary.
 *  4. Voice visibly drives Eve (LISTENING on recognizer start, THINKING on
 *     transcript, release back to the underlying state afterwards).
 *  5. Popup severity and Eve emotion agree.
 */

const BRAIN_ROOT = path.join(__dirname, '..', '..', '..');
const BODY_ROOT = path.join(BRAIN_ROOT, '..', 'robot-body');

function readBrain(relative: string): string {
    return fs.readFileSync(path.join(BRAIN_ROOT, relative), 'utf8');
}

function readBody(relative: string): string {
    return fs.readFileSync(path.join(BODY_ROOT, relative), 'utf8');
}

function allFiles(dir: string, extension: string, skip: string[] = ['node_modules', 'out']): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (skip.includes(entry.name)) {
                continue;
            }
            found.push(...allFiles(path.join(dir, entry.name), extension, skip));
        } else if (entry.name.endsWith(extension)) {
            found.push(path.join(dir, entry.name));
        }
    }
    return found;
}

/** The Body's closed emotion vocabulary (robot-body/behaviour/emotion.js). */
const BODY_VOCABULARY = ['IDLE', 'LISTENING', 'THINKING', 'SPEAKING', 'HAPPY', 'CONFUSED', 'ALERT', 'ERROR'];

suite('ACE.X one Eve only', () => {
    test('body holds the single-instance lock and focuses instead of duplicating', () => {
        const main = readBody('main.js');
        assert.ok(main.includes('requestSingleInstanceLock'), 'main.js must take the single-instance lock');
        assert.ok(main.includes("app.on('second-instance'"), 'a duplicate launch must focus the existing Eve');
        const windows = main.match(/new BrowserWindow/g) ?? [];
        assert.strictEqual(windows.length, 1, `exactly one BrowserWindow may be constructed, found ${windows.length}`);
    });

    test('brain launches through one entry point that focuses existing Eve', () => {
        const extension = readBrain(path.join('src', 'extension.ts'));
        assert.ok(extension.includes('function ensureEveRunning'), 'all launch paths must go through ensureEveRunning');
        const direct = extension.match(/processManager\.launchRobotBody\(\)/g) ?? [];
        assert.strictEqual(direct.length, 1, `only ensureEveRunning may launch, found ${direct.length} call sites`);
        assert.ok(extension.includes('WINDOW_FOCUS'), 'an existing Eve must be focused, never duplicated');
        assert.ok(extension.includes('eveLaunchInitiated'), 'an in-flight launch must not double-spawn');
    });

    test('test host suppresses body auto-launch end to end', () => {
        const runTest = readBrain(path.join('src', 'test', 'suite', 'runTest.ts'));
        assert.ok(runTest.includes("ACEX_NO_EVE") && runTest.includes("'1'"), 'runTest must flag the test host');
        const extension = readBrain(path.join('src', 'extension.ts'));
        assert.ok(extension.includes('ACEX_NO_EVE'), 'the Brain must honour the test-host flag');
        assert.ok(extension.includes('auto-launch suppressed'), 'suppression must be logged, not silent');
        assert.strictEqual(process.env['ACEX_NO_EVE'], '1', 'this host itself must carry the flag');
    });

    test('process manager refuses a second launch while a child lives', () => {
        const manager = readBrain(path.join('src', 'ProcessManager.ts'));
        assert.ok(manager.includes('already running'), 'launchRobotBody must bail when a child lives');
    });

    test('a fresh process manager owns nothing and spawns nothing by itself', () => {
        // Construction alone must never spawn: the dev fallback can resolve
        // inside this repo, so this test deliberately never calls launch —
        // spawning a real Electron Eve from a unit test is exactly what the
        // one-Eve rule forbids. Double-launch protection is asserted
        // statically above; auto-launch suppression below.
        const empty = path.join(os.tmpdir(), `acex-no-body-${Date.now()}`);
        const manager = new ProcessManager({
            extensionUri: vscode.Uri.file(empty),
            wsPort: 8055,
            relaunchDelayMs: 50,
            maxRelaunchAttempts: 1,
        });
        try {
            assert.strictEqual(manager.isRunning(), false, 'a fresh manager must own no child');
            assert.strictEqual(manager.getLaunchMode(), null, 'no launch mode before any launch');
        } finally {
            manager.dispose();
        }
    });

    test('no test creates a visible robot surface', () => {
        const suiteDir = path.join(BRAIN_ROOT, 'src', 'test');
        const offenders: string[] = [];
        for (const file of allFiles(suiteDir, '.ts')) {
            // Self-exclusion: this file states the rule (prose and the scan
            // itself) but creates no views — verified by inspection.
            if (path.basename(file) === 'eve-presence-emotion-voice.test.ts') {
                continue;
            }
            const source = fs.readFileSync(file, 'utf8');
            if (source.includes('createWebviewPanel') || source.includes('createWebviewView')) {
                offenders.push(path.basename(file));
            }
        }
        assert.deepStrictEqual(offenders, [], `tests must stay headless, offenders: ${offenders.join(', ')}`);
    });

    test('brain source constructs no windows', () => {
        const offenders: string[] = [];
        for (const file of allFiles(path.join(BRAIN_ROOT, 'src'), '.ts')) {
            if (path.basename(file) === 'eve-presence-emotion-voice.test.ts') {
                continue;
            }
            if (fs.readFileSync(file, 'utf8').includes('new BrowserWindow')) {
                offenders.push(path.relative(BRAIN_ROOT, file));
            }
        }
        assert.deepStrictEqual(offenders, [], `only robot-body/main.js may construct windows: ${offenders.join(', ')}`);
    });
});

suite('ACE.X compact Eve window', () => {
    test('defaults are 240x270 with a 230x250 minimum', () => {
        const main = readBody('main.js');
        const number = (name: string): number => {
            const match = main.match(new RegExp(`const ${name} = (\\d+);`));
            assert.ok(match, `${name} must be declared`);
            return Number(match![1]);
        };
        assert.strictEqual(number('DEFAULT_WIDTH'), 240);
        assert.strictEqual(number('DEFAULT_HEIGHT'), 270);
        assert.strictEqual(number('MIN_WIDTH'), 230);
        assert.strictEqual(number('MIN_HEIGHT'), 250);
    });

    test('saved geometry still wins; reset uses the new compact defaults', () => {
        const main = readBody('main.js');
        assert.ok(main.includes('function defaultBounds'), 'fresh installs use defaultBounds');
        assert.ok(main.includes('function resetGeometry'), 'Reset Eve Position must exist');
        assert.ok(main.includes('savedGeometry = { ...bounds, alwaysOnTop: true }'), 'reset must persist the new defaults');
        // Preservation: clamping floors small values but never shrinks a
        // larger saved window back to defaults.
        assert.ok(main.includes('Math.max(MIN_WIDTH'), 'saved width survives when larger than the minimum');
        assert.ok(main.includes('return { ...savedGeometry }'), 'initial bounds restore the saved placement');
    });

    test('popup fits the compact window', () => {
        const html = readBody('index.html');
        assert.ok(html.includes('max-width: min(92%'), 'the popup must stay inside the compact window');
    });
});

suite('ACE.X central semantic emotion mapping', () => {
    const expected: Record<SemanticRobotState, string> = {
        IDLE: 'IDLE',
        ATTENTION: 'LISTENING',
        THINKING: 'THINKING',
        LISTENING: 'LISTENING',
        PROCESSING: 'THINKING',
        WRITING: 'THINKING',
        TEACHING: 'SPEAKING',
        FIXING: 'THINKING',
        EXPLAINING: 'SPEAKING',
        WAITING_FOR_APPROVAL: 'LISTENING',
        EXECUTING: 'THINKING',
        VERIFYING: 'THINKING',
        SUCCESS: 'HAPPY',
        FAILURE: 'ALERT',
        ERROR: 'ERROR',
        STRUGGLE: 'ALERT',
        DISCONNECTED: 'IDLE',
    };

    test('all fourteen required states resolve onto the closed body vocabulary', () => {
        const states = Object.keys(expected) as SemanticRobotState[];
        assert.strictEqual(states.length, 17);
        for (const state of states) {
            const resolved = resolveSemanticEmotion(state);
            assert.strictEqual(resolved.emotion, expected[state], `${state} must resolve to ${expected[state]}`);
            assert.ok(BODY_VOCABULARY.includes(resolved.emotion), `${resolved.emotion} needs a Body pose`);
            assert.ok(resolved.intensity >= 0 && resolved.intensity <= 1, 'intensity stays in 0..1');
            assert.ok(resolved.reason.length > 0, 'every resolution explains itself');
        }
    });

    test('healthy monitoring is calm; severity scales errors, warnings stay curious', () => {
        assert.strictEqual(resolveSemanticEmotion('IDLE').intensity, 0.5, 'healthy Eve rests at calm idle');
        const error = resolveSemanticEmotion('ERROR', { severity: 'error' });
        const warning = resolveSemanticEmotion('ERROR', { severity: 'warning' });
        assert.strictEqual(error.emotion, 'ERROR');
        assert.strictEqual(warning.emotion, 'ALERT', 'warnings must not read as full panic');
        assert.ok(error.intensity > warning.intensity, 'severity must move intensity');
        const struggle = resolveSemanticEmotion('STRUGGLE');
        assert.strictEqual(struggle.emotion, 'ALERT');
        assert.ok(struggle.intensity < error.intensity, 'struggle stays supportive, never frantic');
    });

    test('failure is concern and success is brief happiness, neither permanent', () => {
        assert.strictEqual(resolveSemanticEmotion('FAILURE').emotion, 'ALERT', 'failure is concern, not alarm');
        const success = resolveSemanticEmotion('SUCCESS');
        assert.strictEqual(success.emotion, 'HAPPY');
        // Holds settle through the Body — documented precedence, no locks.
        const order = [...SEMANTIC_PRIORITY];
        for (const required of ['ERROR', 'FAILURE', 'SUCCESS', 'WAITING_FOR_APPROVAL', 'EXECUTING', 'VERIFYING', 'EXPLAINING', 'PROCESSING', 'WRITING', 'TEACHING', 'FIXING', 'LISTENING', 'THINKING', 'ATTENTION', 'IDLE'] as const) {
            assert.ok(order.includes(required), `precedence must list ${required}`);
        }
        assert.ok(order.indexOf('ERROR') < order.indexOf('SUCCESS'), 'errors outrank success');
        assert.ok(order.indexOf('SUCCESS') < order.indexOf('IDLE'), 'success is not instantly idle');
    });

    test('Body lifecycle mapping uses existing poses and no second renderer', () => {
        const mapper = readBody(path.join('behaviour', 'actionMapper.js'));
        for (const state of ['WRITING', 'TEACHING', 'FIXING', 'WAITING_FOR_APPROVAL', 'VERIFYING', 'RECONNECTING', 'DISCONNECTED']) {
            assert.ok(mapper.includes(`${state}:`), `Body must map ${state}`);
        }
        assert.ok(mapper.includes('LIFECYCLE_STATE'), 'Body must consume Brain lifecycle state frames');
        assert.ok(readBody('renderer.js').includes('requestAnimationFrame(animate)'), 'one canonical render loop remains');
    });

    test('fix flow expresses approval, executing and verifying states', () => {
        const extension = readBrain(path.join('src', 'extension.ts'));
        for (const state of ['WAITING_FOR_APPROVAL', 'EXECUTING', 'VERIFYING'] as const) {
            assert.ok(
                extension.includes(`emitSemanticEmotion('${state}')`),
                `the fix flow must express ${state}`
            );
            assert.ok(BODY_VOCABULARY.includes(resolveSemanticEmotion(state).emotion));
        }
    });
});

suite('ACE.X voice visibly drives Eve', () => {
    test('recognizer start shows listening; transcript shows processing; ends release', () => {
        const renderer = readBody('renderer.js');
        assert.ok(renderer.includes('recognition.onstart'), 'listening is gated on the recognizer starting');
        assert.ok(renderer.includes("emotion: 'LISTENING'"), 'recognizer start submits LISTENING to Eve');
        assert.ok(renderer.includes("emotion: 'THINKING'"), 'a transcript submits PROCESSING (thinking) to Eve');
        const releases = renderer.match(/animation: 'neutral'/g) ?? [];
        assert.ok(releases.length >= 2, 'voice end/speech end must release back to the underlying state');
        assert.ok(renderer.includes('utterance.onend'), 'speaking clears only when audio actually ends');
    });

    test('voice router still binds commands to the popup issue', () => {
        const extension = readBrain(path.join('src', 'extension.ts'));
        assert.ok(extension.includes('interpretVoiceCommand(text, issue)'), 'voice text routes with popup context');
        assert.ok(extension.includes('VOICE_TEXT'), 'the transcript channel is intact');
    });
});

suite('ACE.X popup and emotion agree', () => {
    test('error popup means concerned Eve; success popup means happy Eve', () => {
        const now = Date.now();
        const error = buildPopupState({
            issue: {
                matter: 'm-1', recurrence: 2, recurring: true, file: 'D:\\demo\\test.py',
                fileName: 'test.py', line: 18, severity: 'Error',
                message: '"customer_name" is not defined', teachingLevel: 2, verbose: false,
            },
            resolution: null, voiceEnabled: false, now,
        });
        assert.strictEqual(error.severity, 'ERROR');
        assert.strictEqual(resolveSemanticEmotion('ERROR').emotion, 'ERROR');
        const success = buildPopupState({
            issue: null,
            resolution: { verified: true, headline: 'Fixed.', takeaway: 'Rule learned.', via: 'fix', at: now },
            voiceEnabled: false, now,
        });
        assert.strictEqual(success.severity, 'SUCCESS');
        assert.strictEqual(resolveSemanticEmotion('SUCCESS').emotion, 'HAPPY');
        const failure = buildPopupState({
            issue: null,
            resolution: { verified: false, headline: 'Applied.', takeaway: 'Still broken.', via: 'fix', at: now },
            voiceEnabled: false, now,
        });
        assert.strictEqual(failure.severity, 'FAILURE');
        assert.strictEqual(resolveSemanticEmotion('FAILURE').emotion, 'ALERT');
    });

    test('thinking and explaining popups match thinking and speaking Eve', () => {
        assert.strictEqual(resolveSemanticEmotion('THINKING').emotion, 'THINKING');
        assert.strictEqual(resolveSemanticEmotion('EXPLAINING').emotion, 'SPEAKING');
        assert.strictEqual(resolveSemanticEmotion('WAITING_FOR_APPROVAL').emotion, 'LISTENING');
    });
});
