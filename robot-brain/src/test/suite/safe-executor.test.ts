import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { SafeExecutor } from '../../validation/safeExecutor';
import type { ValidationCommand } from '../../validation/executionTypes';

const root = os.tmpdir();
const command = (args: string[]): ValidationCommand => ({ executable: process.execPath, args, cwd: root, label: 'test process', kind: 'syntax', requiresApproval: false });

suite('Ace.X safe validation executor', () => {
    test('requires explicit approval and rejects workspace escapes', async () => {
        const executor = new SafeExecutor({ workspaceRoot: root });
        const denied = await executor.run('approval', command(['-e', 'process.exit(0)']));
        assert.strictEqual(denied.state, 'CANCELLED');
        const outside = await executor.run('outside', { ...command(['-e', 'process.exit(0)']), cwd: path.dirname(root) }, true);
        assert.strictEqual(outside.state, 'FAILED');
    });

    test('captures nonzero exit and bounds output', async () => {
        const executor = new SafeExecutor({ workspaceRoot: root, maxOutputBytes: 32 });
        const result = await executor.run('failure', command(['-e', "process.stdout.write('x'.repeat(1000)); process.exit(3)"]), true);
        assert.strictEqual(result.state, 'FAILED');
        assert.strictEqual(result.exitCode, 3);
        assert.ok(result.stdout.length <= 32);
    });

    test('reports timeout, cancellation, duplicate requests, and startup failure', async () => {
        const executor = new SafeExecutor({ workspaceRoot: root, timeoutMs: 20 });
        const timeout = await executor.run('timeout', command(['-e', 'setTimeout(() => {}, 1000)']), true);
        assert.strictEqual(timeout.state, 'TIMED_OUT');
        const running = executor.run('cancel', command(['-e', 'setTimeout(() => {}, 1000)']), true);
        const duplicate = await executor.run('cancel', command(['-e', 'process.exit(0)']), true);
        assert.strictEqual(duplicate.state, 'FAILED');
        executor.cancel('cancel');
        assert.strictEqual((await running).state, 'CANCELLED');
        const missing = await executor.run('missing', { ...command([]), executable: 'definitely-not-a-real-executable' }, true);
        assert.strictEqual(missing.state, 'FAILED');
    });
});
