import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import type { ValidationCommand, ValidationResult } from './executionTypes';

export interface SafeExecutorOptions {
    workspaceRoot: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
}

function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Executes planner-produced argv only; shell parsing is deliberately disabled. */
export class SafeExecutor {
    private readonly active = new Map<string, ChildProcessWithoutNullStreams>();
    private readonly cancelled = new Set<string>();
    private readonly options: Required<SafeExecutorOptions>;

    constructor(options: SafeExecutorOptions) {
        this.options = { timeoutMs: 30_000, maxOutputBytes: 256_000, ...options };
    }

    cancel(requestId: string): boolean {
        const child = this.active.get(requestId);
        if (!child) return false;
        this.cancelled.add(requestId);
        child.kill();
        return true;
    }

    run(requestId: string, command: ValidationCommand, approved = false): Promise<ValidationResult> {
        if (!approved) {
            return Promise.resolve({ requestId, state: 'CANCELLED', command, stdout: '', stderr: '', timedOut: false, cancelled: true, durationMs: 0, detail: 'Explicit approval is required before running validation.' });
        }
        if (this.active.has(requestId)) {
            return Promise.resolve({ requestId, state: 'FAILED', command, stdout: '', stderr: '', timedOut: false, cancelled: false, durationMs: 0, detail: 'A validation request with this identity is already running.' });
        }
        if (!isInside(this.options.workspaceRoot, command.cwd)) {
            return Promise.resolve({ requestId, state: 'FAILED', command, stdout: '', stderr: '', timedOut: false, cancelled: false, durationMs: 0, detail: 'The validation working directory is outside the workspace.' });
        }

        return new Promise((resolve) => {
            const started = Date.now();
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            let cancelled = false;
            const child = spawn(command.executable, command.args, { cwd: command.cwd, shell: false, windowsHide: true });
            this.active.set(requestId, child);
            const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
                const text = chunk.toString('utf8');
                if (target === 'stdout') stdout = (stdout + text).slice(-this.options.maxOutputBytes);
                else stderr = (stderr + text).slice(-this.options.maxOutputBytes);
            };
            child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
            child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
            const timer = setTimeout(() => { timedOut = true; child.kill(); }, this.options.timeoutMs);
            child.once('error', (error) => {
                clearTimeout(timer); this.active.delete(requestId);
                resolve({ requestId, state: 'FAILED', command, stdout, stderr: `${stderr}${error.message}`, timedOut, cancelled, durationMs: Date.now() - started, detail: 'The validation process could not be started.' });
            });
            child.once('close', (exitCode) => {
                clearTimeout(timer); this.active.delete(requestId);
                cancelled = this.cancelled.delete(requestId);
                const state = timedOut ? 'TIMED_OUT' : cancelled ? 'CANCELLED' : exitCode === 0 ? (command.kind === 'test' ? 'TESTED' : 'EXECUTED') : 'FAILED';
                resolve({ requestId, state, command, exitCode, stdout, stderr, timedOut, cancelled, durationMs: Date.now() - started, detail: exitCode === 0 ? `${command.label} completed successfully.` : `${command.label} exited with code ${String(exitCode)}.` });
            });
        });
    }
}
