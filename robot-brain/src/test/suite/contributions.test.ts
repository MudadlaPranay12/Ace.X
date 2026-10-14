import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * Phase 5.2 — verifies that the BotX VS Code surface is actually wired into a
 * real Extension Development Host: the three status controls' commands, the
 * contributed webview view, and the panel opening without error.
 */

const EXTENSION_ID = 'botx.robot-brain';

async function activate(): Promise<void> {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `${EXTENSION_ID} is not installed in the test host`);
    await ext!.activate();
    assert.strictEqual(ext!.isActive, true, 'extension did not activate');
}

suite('Phase 5.2 contributions', () => {
    suiteSetup(async function () {
        this.timeout(120000);
        await activate();
    });

    test('all BotX commands are registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        for (const id of [
            'botx.openCompanionPanel',
            'botx.setVoice',
            'botx.toggleVoice',
            'botx.askCompanion',
            'botx.explainError',
            'botx.fixWithEve',
            'botx.showCompanion',
            'botx.hideCompanion'
        ]) {
            assert.ok(commands.includes(id), `command ${id} is not registered`);
        }
    });

    test('the companion webview view is contributed', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(
            commands.includes('botx.companion.focus'),
            'the botx.companion view did not register its focus command — the view contribution is missing'
        );
    });

    test('the BotX status configuration is readable', () => {
        const cfg = vscode.workspace.getConfiguration('botx');
        assert.strictEqual(typeof cfg.get<boolean>('monitoring'), 'boolean');
        assert.strictEqual(typeof cfg.get<boolean>('enableVoice'), 'boolean');
    });

    test('the companion panel opens without error', async function () {
        this.timeout(60000);
        await vscode.commands.executeCommand('botx.openCompanionPanel');
        await new Promise((r) => setTimeout(r, 2000));
    });

    test('voice can be flipped through the registered command', async function () {
        this.timeout(30000);
        // Re-fetch after every write: a WorkspaceConfiguration object holds the
        // model it was created from, so a stale one will not see the change.
        const read = () => vscode.workspace.getConfiguration('botx').get<boolean>('enableVoice');

        const before = read();
        await vscode.commands.executeCommand('botx.toggleVoice');
        await new Promise((r) => setTimeout(r, 500));
        assert.notStrictEqual(read(), before, 'toggleVoice did not change botx.enableVoice');

        await vscode.commands.executeCommand('botx.setVoice', before);
        await new Promise((r) => setTimeout(r, 500));
        assert.strictEqual(read(), before, 'setVoice did not restore botx.enableVoice');
    });
});
