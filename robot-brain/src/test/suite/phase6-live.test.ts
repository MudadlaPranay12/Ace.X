import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * LIVE Phase 6 check against a real workspace.
 *
 * Unlike the headless harness, nothing here is simulated: the diagnostics come
 * from the real language server analysing the real file on disk, and every
 * assertion is made against the real CompanionLoop the extension activated.
 *
 * The file is D:\BotXDemo\test.py, which references two names that are never
 * assigned. A real analyser must report those; if it does not, this test fails
 * loudly rather than quietly passing on an empty diagnostic set.
 */

const WORKSPACE_FILE = 'test.py';
/**
 * Pylance needs to index the workspace on a cold start. Cold language-server
 * startup in a fresh test host has been observed to exceed 150 s on this
 * machine, while a warm server answers in seconds — so the budget covers a
 * cold start, not a fast one.
 */
const ANALYSIS_TIMEOUT_MS = 150_000;
const POLL_MS = 500;

interface DiagnosticSnapshot {
    errors: string[];
    messages: string[];
}

/**
 * Environment gate for this live suite. The tests need a real Python language
 * server (Pylance) plus the demo fixture, so they only run when both are
 * present and are skipped — never failed — otherwise. Skipping is honest
 * here: without a language server there is nothing real to observe.
 */
async function ensureLiveFixture(): Promise<vscode.Uri | undefined> {
    const python = vscode.extensions.getExtension('ms-python.python');
    if (!python) {
        return undefined;
    }
    // Activate up front so cold interpreter discovery happens on our terms
    // instead of racing the diagnostic polling budget below.
    console.log(`[PHASE6] workspace trusted: ${vscode.workspace.isTrusted}, python active before: ${python.isActive}`);
    const activatedAt = Date.now();
    await python.activate();
    console.log(`[PHASE6] python.activate() resolved after ${Date.now() - activatedAt}ms, active: ${python.isActive}`);
    const found = vscode.workspace.workspaceFolders?.find((folder) =>
        fs.existsSync(path.join(folder.uri.fsPath, WORKSPACE_FILE))
    );
    const filePath = found
        ? path.join(found.uri.fsPath, WORKSPACE_FILE)
        : path.join('D:\\BotXDemo', WORKSPACE_FILE);
    if (!fs.existsSync(filePath)) {
        return undefined;
    }
    return vscode.Uri.file(filePath);
}

/**
 * Resolves the demo file, preferring an open workspace folder and falling
 * back to the documented demo path. The document is opened because language
 * servers only publish diagnostics for opened documents.
 */
async function openWorkspaceFile(uri: vscode.Uri): Promise<vscode.Uri> {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    return uri;
}

async function waitForRealDiagnostics(uri: vscode.Uri): Promise<DiagnosticSnapshot> {
    const deadline = Date.now() + ANALYSIS_TIMEOUT_MS;
    await openWorkspaceFile(uri);

    let elapsed = 0;
    while (Date.now() < deadline) {
        const diagnostics = vscode.languages.getDiagnostics(uri);
        elapsed = ANALYSIS_TIMEOUT_MS - (deadline - Date.now());
        if (elapsed > 0 && Math.round(elapsed / 1000) % 30 === 0) {
            console.log(`[PHASE6] waiting for diagnostics: ${Math.round(elapsed / 1000)}s elapsed, ${diagnostics.length} so far`);
        }
        const errors = diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
        if (errors.length > 0) {
            return {
                errors: errors.map((d) => d.message),
                messages: diagnostics.map((d) => d.message),
            };
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }

    throw new Error(`No real diagnostics appeared in ${WORKSPACE_FILE} within ${ANALYSIS_TIMEOUT_MS}ms`);
}

function companionOf(): {
    getStateSnapshot: () => any;
    getWhatChanged: () => any;
} {
    // The extension exports its pipeline for exactly this kind of inspection.
    const api = vscode.extensions.getExtension('botx.robot-brain');
    assert.ok(api, 'The BotX extension should be present in the test host');
    const exported = api!.exports as { pipeline?: { getCompanion: () => any } };
    assert.ok(exported.pipeline, 'The extension should export its pipeline');
    return exported.pipeline!.getCompanion();
}

suite('Phase 6 live companion', function () {
    // Pylance indexing on a cold workspace is slow; this suite cannot use the
    // 10s default.
    this.timeout(ANALYSIS_TIMEOUT_MS + 30_000);

    test('observes a real diagnostic from a real language server', async function () {
        const uri = await ensureLiveFixture();
        if (!uri) {
            this.skip();
            return;
        }
        const snapshot = await waitForRealDiagnostics(uri);
        assert.ok(snapshot.errors.length > 0, 'Expected at least one real error');

        // The Brain must have observed it, not merely the test.
        const companion = companionOf();
        const state = companion.getStateSnapshot();
        assert.ok(
            state.diagnostics.length > 0,
            'The companion should have observed the real diagnostics through its sensor'
        );
        assert.ok(state.issue !== null, 'The companion should have a current issue');
        assert.ok(state.attention.active, 'The companion should be attending to the real diagnostic');
        assert.strictEqual(state.monitoringEnabled, true, 'Monitoring should be on by default');
    });

    test('answers What Changed? from real recorded history, or says it cannot', async function () {
        const fixture = await ensureLiveFixture();
        if (!fixture) {
            this.skip();
            return;
        }
        const companion = companionOf();

        // Make a real, recorded edit in the open document so the timeline has
        // genuine history behind the diagnostic.
        const uri = await openWorkspaceFile(fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);

        // A trailing-whitespace edit: a real change event for the timeline
        // that cannot alter the diagnostic set, so no transient empty batch
        // can announce a resolution that never happened.
        const original = document.lineAt(0).text;
        await editor.edit((builder) => builder.insert(new vscode.Position(0, original.length), ' '));
        await editor.edit((builder) => builder.delete(new vscode.Range(new vscode.Position(0, original.length), new vscode.Position(0, original.length + 1))));

        // Let the real diagnostics re-publish after the edit.
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const report = companion.getWhatChanged();
        assert.ok(report !== null, 'What Changed should produce a report while a diagnostic is active');

        if (report.known) {
            // When it claims to know something, the claim must be specific.
            assert.ok(report.headline.length > 0, 'A known report must have a headline');
            assert.ok(
                report.detail === undefined || report.detail.includes('before the diagnostic'),
                `Evidence must say when the change happened, got: ${report.detail}`
            );
        } else {
            // The honest fallback, and it must be the exact agreed wording.
            assert.strictEqual(
                report.headline,
                'Not enough history to determine what introduced this.'
            );
        }

        assert.strictEqual(document.lineAt(0).text, original, 'the test must leave the file as it found it');
    });

    test('claims no resolution while the diagnostic is still present', async function () {
        const fixture = await ensureLiveFixture();
        if (!fixture) {
            this.skip();
            return;
        }
        const companion = companionOf();
        const state = companion.getStateSnapshot();

        assert.ok(state.diagnostics.length > 0, 'Precondition: a real diagnostic is present');
        assert.strictEqual(
            state.resolution,
            null,
            'A diagnostic that is still reported must never be described as resolved'
        );
    });
});
