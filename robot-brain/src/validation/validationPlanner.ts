import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ValidationCommand } from './executionTypes';

export interface ValidationPlanInput {
    filePath: string;
    languageId: string;
    workspaceRoot: string;
}

function inside(root: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function packageScript(root: string, name: string): boolean {
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
        return typeof manifest.scripts?.[name] === 'string' && manifest.scripts[name].trim().length > 0;
    } catch {
        return false;
    }
}

/**
 * Selects only structured, known validation commands. It never accepts a
 * command string from a model or from a comment instruction.
 */
export function planValidation(input: ValidationPlanInput): ValidationCommand | undefined {
    const root = path.resolve(input.workspaceRoot);
    const file = path.resolve(input.filePath);
    if (!inside(root, file) || !fs.existsSync(file)) return undefined;

    const language = input.languageId.toLowerCase();
    if (language === 'python' || language === 'py') {
        return { executable: 'python', args: ['-m', 'py_compile', file], cwd: root, label: 'Python syntax check', kind: 'syntax', requiresApproval: false };
    }
    if (['javascript', 'javascriptreact', 'js'].includes(language)) {
        return { executable: 'node', args: ['--check', file], cwd: root, label: 'JavaScript syntax check', kind: 'syntax', requiresApproval: false };
    }
    if (['typescript', 'typescriptreact', 'ts'].includes(language)) {
        if (packageScript(root, 'typecheck')) {
            return { executable: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['run', 'typecheck'], cwd: root, label: 'Project TypeScript typecheck', kind: 'typecheck', requiresApproval: true };
        }
        return undefined;
    }
    if (packageScript(root, 'test')) {
        return { executable: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['test'], cwd: root, label: 'Project test script', kind: 'test', requiresApproval: true };
    }
    return undefined;
}
