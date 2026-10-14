import * as vscode from 'vscode';
import type { CommandLanguage } from '../commands/commandTypes';

export interface WriteTargetSnapshot {
    uri: string;
    version: number;
    selection: vscode.Selection;
    selectedText: string;
    replaceSelection: boolean;
}

export function captureWriteTarget(editor: vscode.TextEditor, replaceSelection: boolean): WriteTargetSnapshot {
    return {
        uri: editor.document.uri.toString(),
        version: editor.document.version,
        selection: editor.selection,
        selectedText: editor.document.getText(editor.selection),
        replaceSelection,
    };
}

export async function insertGeneratedCode(
    editor: vscode.TextEditor,
    snapshot: WriteTargetSnapshot,
    code: string,
): Promise<{ applied: boolean; reason?: string; range: vscode.Range }> {
    const range = snapshot.replaceSelection ? snapshot.selection : new vscode.Range(snapshot.selection.active, snapshot.selection.active);
    if (editor.document.uri.toString() !== snapshot.uri) return { applied: false, reason: 'The active editor changed while Eve was generating code.', range };
    if (editor.document.version !== snapshot.version) return { applied: false, reason: 'The source changed while Eve was generating code. No code was inserted.', range };
    if (snapshot.replaceSelection && editor.document.getText(snapshot.selection) !== snapshot.selectedText) return { applied: false, reason: 'The selected text changed while Eve was generating code. No code was inserted.', range };
    const applied = await editor.edit((edit) => edit.replace(range, code), { undoStopBefore: true, undoStopAfter: true });
    return applied ? { applied: true, range } : { applied: false, reason: 'VS Code rejected the editor edit.', range };
}

export function languageMatchesEditor(language: CommandLanguage, languageId: string): boolean {
    const aliases: Record<string, CommandLanguage> = { py: 'python', js: 'javascript', ts: 'typescript', shellscript: 'shell', plaintext: language };
    return (aliases[languageId] ?? languageId) === language;
}
