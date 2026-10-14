import * as assert from 'assert';
import * as vscode from 'vscode';
import { validateGeneratedCode } from '../../validation/generatedCodeValidator';
import { captureWriteTarget, insertGeneratedCode } from '../../workflow/writeWorkflow';
import { generateCode } from '../../ai/gemini';

function fakeEditor(text: string, version = 1): { editor: vscode.TextEditor; getText: () => string; setText: (value: string) => void } {
    let content = text;
    const document = {
        uri: vscode.Uri.parse('untitled:write-phase2.py'),
        version,
        getText: (range?: vscode.Range) => range ? content.slice(0, range.start.character) : content,
        fileName: 'write-phase2.py',
        languageId: 'python',
        lineCount: content.split(/\r?\n/).length,
        lineAt: (line: number) => ({ text: content.split(/\r?\n/)[line] ?? '' }),
    } as unknown as vscode.TextDocument;
        const editor = {
        document,
        selection: new vscode.Selection(new vscode.Position(0, content.length), new vscode.Position(0, content.length)),
        edit: async (callback: (edit: { replace: (range: vscode.Range, value: string) => void }) => void) => {
            let replacement = '';
            let range: vscode.Range | undefined;
            callback({ replace: (nextRange, value) => { range = nextRange; replacement = value; } });
            if (!range) return false;
            const offset = (position: vscode.Position): number => content.split(/\r?\n/).slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.character;
            const start = offset(range.start);
            const end = offset(range.end);
            content = content.slice(0, start) + replacement + content.slice(end);
            return true;
        },
    } as unknown as vscode.TextEditor;
    return { editor, getText: () => content, setText: (value) => { content = value; } };
}

suite('Ace.X Phase 2 generated code validation', () => {
    test('accepts fenced Python and extracts only code', () => {
        const result = validateGeneratedCode('```python\ndef is_prime(n):\n    return n > 1\n```', 'python');
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.code, 'def is_prime(n):\n    return n > 1');
    });

    test('rejects empty, prose, and wrong-language responses', () => {
        assert.strictEqual(validateGeneratedCode('', 'python').valid, false);
        assert.strictEqual(validateGeneratedCode("Here's the code:\ndef is_prime(n):\n return True", 'python').valid, false);
        assert.strictEqual(validateGeneratedCode('public class Demo {}', 'python').valid, false);
    });
});

suite('Ace.X Phase 2 editor insertion', () => {
    test('inserts at the cursor and preserves unrelated source', async () => {
        const fake = fakeEditor('before\n');
        fake.editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0));
        const snapshot = captureWriteTarget(fake.editor, false);
        const result = await insertGeneratedCode(fake.editor, snapshot, 'def is_prime(n):\n    return True\n');
        assert.strictEqual(result.applied, true);
        assert.strictEqual(fake.getText(), 'before\ndef is_prime(n):\n    return True\n');
    });

    test('replaces only an explicitly selected edit region', async () => {
        const fake = fakeEditor('keep\nold code\nkeep\n');
        fake.editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 8));
        (fake.editor.document.getText as unknown as (range?: vscode.Range) => string) = (range?: vscode.Range) => range ? 'old code' : fake.getText();
        const snapshot = captureWriteTarget(fake.editor, true);
        const result = await insertGeneratedCode(fake.editor, snapshot, 'new code');
        assert.strictEqual(result.applied, true);
        assert.ok(fake.getText().includes('new code'));
        assert.ok(fake.getText().includes('keep'));
    });

    test('rejects stale document state without editing', async () => {
        const fake = fakeEditor('original');
        const snapshot = captureWriteTarget(fake.editor, false);
        Object.defineProperty(fake.editor.document, 'version', { value: 2 });
        const result = await insertGeneratedCode(fake.editor, snapshot, 'new');
        assert.strictEqual(result.applied, false);
        assert.strictEqual(fake.getText(), 'original');
    });
});

suite('Ace.X Phase 2 provider failures', () => {
    test('reports missing provider configuration', async () => {
        const result = await generateCode('check prime', 'python', '');
        assert.strictEqual(result.failed, true);
        assert.ok(result.error);
    });

    test('reports cancellation without claiming generated code', async () => {
        const controller = new AbortController();
        controller.abort();
        const result = await generateCode('check prime', 'python', '', controller.signal);
        assert.strictEqual(result.failed, true);
        assert.strictEqual(result.code, '');
    });
});

suite('Ace.X provider error mapping (deterministic fetch stub)', () => {
    const realFetch = globalThis.fetch;
    const setKey = async (value: string) => {
        // Test-host settings only (isolated user-data dir); a fake value that
        // is reset in teardown, so no real credential is ever involved.
        await vscode.workspace.getConfiguration('botx').update('geminiApiKey', value, vscode.ConfigurationTarget.Global);
    };
    setup(async () => { await setKey('test-key-not-real'); });
    teardown(async () => {
        globalThis.fetch = realFetch;
        await setKey('');
    });

    test('maps 429 to a rate-limit error without code', async () => {
        globalThis.fetch = (async () => ({ ok: false, status: 429 })) as unknown as typeof fetch;
        const result = await generateCode('check prime', 'python', '');
        assert.strictEqual(result.failed, true);
        assert.strictEqual(result.code, '');
        assert.ok(result.error && result.error.includes('rate limit'), `expected rate-limit wording, got: ${result.error}`);
    });

    test('maps 401 to a rejected-key error without code', async () => {
        globalThis.fetch = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
        const result = await generateCode('check prime', 'python', '');
        assert.strictEqual(result.failed, true);
        assert.strictEqual(result.code, '');
        assert.ok(result.error && result.error.includes('rejected'), `expected rejected-key wording, got: ${result.error}`);
    });

    test('maps an abort-shaped failure to a timeout error without code', async () => {
        globalThis.fetch = (async () => { throw new DOMException('Aborted', 'AbortError'); }) as unknown as typeof fetch;
        const result = await generateCode('check prime', 'python', '');
        assert.strictEqual(result.failed, true);
        assert.strictEqual(result.code, '');
        assert.ok(result.error && result.error.includes('timed out'), `expected timeout wording, got: ${result.error}`);
    });

    test('returns provider code on a well-formed success', async () => {
        const body = { candidates: [{ content: { parts: [{ text: '```python\ndef is_prime(n):\n    return n > 1\n```' }] } }] };
        globalThis.fetch = (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;
        const result = await generateCode('check prime', 'python', '');
        assert.strictEqual(result.failed, false);
        assert.ok(result.code.includes('def is_prime'));
    });
});
