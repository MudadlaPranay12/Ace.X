import * as vscode from 'vscode';
import { generateCode } from '../ai/gemini';
import { validateGeneratedCode } from '../validation/generatedCodeValidator';
import { CommentInstructionState } from './commentInstructionState';
import type { CommentInstruction } from '../intent/commentInstruction';
import { Logger } from '../utils/logger';

const LANGUAGE_MAP: Record<string, 'python' | 'javascript' | 'typescript' | 'java'> = {
    python: 'python', javascript: 'javascript', typescript: 'typescript', java: 'java',
};

/** Approval-gated, single-file comment instruction workflow. */
export class CommentCodingWorkflow {
    readonly state = new CommentInstructionState();

    async handle(instruction: CommentInstruction, documentVersion: number): Promise<string> {
        const tracked = this.state.detect(instruction, documentVersion);
        if (!tracked) return 'This Eve instruction was already handled or is already awaiting a decision.';
        const editor = vscode.window.activeTextEditor;
        if (!vscode.workspace.isTrusted || !editor || editor.document.uri.toString() !== instruction.fileUri || !vscode.workspace.getWorkspaceFolder(editor.document.uri) || editor.document.version !== documentVersion || !LANGUAGE_MAP[instruction.language]) {
            this.state.transition(instruction.id, 'STALE', documentVersion, 'The source is no longer the active document.');
            return 'The Eve instruction became stale before it could be prepared.';
        }
        const document = editor.document;
        if (!/^(write|create|generate)\b/i.test(instruction.text)) {
            this.state.transition(instruction.id, 'REJECTED', documentVersion, 'Ambiguous modification scope');
            return 'This initial comment workflow supports inserting new code only. Select existing code and use #write replace … for modifications.';
        }
        const start = new vscode.Position(instruction.startLine, 0);
        const end = new vscode.Position(instruction.endLine, document.lineAt(instruction.endLine).text.length);
        const contextStart = Math.max(0, instruction.startLine - 12);
        const contextEnd = Math.min(document.lineCount - 1, instruction.endLine + 20);
        const contextRange = new vscode.Range(contextStart, 0, contextEnd, document.lineAt(contextEnd).text.length);
        const context = document.getText(contextRange).slice(0, 8000);
        const originalComment = document.getText(new vscode.Range(start, end));
        const language = LANGUAGE_MAP[instruction.language];
        const generated = await generateCode(instruction.text, language, context);
        if (generated.failed) {
            this.state.transition(instruction.id, 'FAILED', document.version, generated.error ?? 'Code generation failed.');
            return `Eve could not prepare the comment instruction: ${generated.error ?? 'provider failure'}`;
        }
        const validation = validateGeneratedCode(generated.code, language);
        if (!validation.valid) {
            this.state.transition(instruction.id, 'FAILED', document.version, validation.error);
            return `Eve rejected the generated proposal: ${validation.error}`;
        }
        this.state.transition(instruction.id, 'PROPOSED', document.version);
        const source = document.getText();
        const offset = document.offsetAt(end);
        const preview = await vscode.workspace.openTextDocument({ language, content: source.slice(0, offset) + '\n' + validation.code + source.slice(offset) });
        await vscode.commands.executeCommand('vscode.diff', document.uri, preview.uri, 'Eve comment proposal');
        const choice = await vscode.window.showInformationMessage(
            `Eve found an instruction: “${instruction.text}”\nPropose a scoped edit below the comment?`,
            { modal: true }, 'Apply proposal', 'Cancel',
        );
        if (choice !== 'Apply proposal') {
            this.state.transition(instruction.id, 'CANCELLED', document.version, 'User cancelled the proposal.');
            return 'The Eve comment proposal was cancelled. No changes were made.';
        }
        if (document.version !== documentVersion || document.getText(new vscode.Range(start, end)) !== originalComment) {
            this.state.transition(instruction.id, 'STALE', document.version, 'The source changed before approval.');
            return 'The Eve proposal became stale before it could be applied.';
        }
        this.state.transition(instruction.id, 'APPROVED', document.version);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, end, `\n${validation.code.trimEnd()}`);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            this.state.transition(instruction.id, 'FAILED', document.version, 'VS Code rejected the scoped edit.');
            return 'Eve could not apply the approved proposal.';
        }
        this.state.transition(instruction.id, 'COMPLETED', document.version);
        Logger.info('COMMENT_WORKFLOW', { Event: 'Scoped instruction applied', InstructionId: instruction.id, File: document.fileName });
        return `Eve applied the approved proposal below the instruction in ${document.fileName}. The code was inserted but not executed.`;
    }
}
