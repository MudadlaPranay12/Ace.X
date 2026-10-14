import * as vscode from 'vscode';
import { Logger } from '../utils/logger';

/**
 * CodeSpotlight — draws the companion's shared attention target in the editor
 * with native decorations.
 *
 * ARCHITECTURE: this class draws. It never decides.
 *
 *   - The target comes from the ONE authoritative AttentionTracker in the Brain,
 *     exposed on the companion snapshot. This module has no notion of which
 *     diagnostic matters, how severe it is, or whether the developer is stuck;
 *     if the Brain points somewhere, that is what gets highlighted.
 *   - When the Brain releases the target — because the diagnostic was resolved,
 *     because monitoring was switched off, or because the target expired — the
 *     decoration is removed. A highlight that outlives its reason is a lie.
 *   - When the developer moves to another file, the decoration goes with the
 *     target instead of being left behind in a file no longer being looked at.
 *
 * Deliberately subtle: a soft background wash plus an overview-ruler mark. It
 * must be noticeable without competing with VS Code's own squiggles, which stay
 * the primary signal for the diagnostic itself.
 */

export interface SpotlightTarget {
    /** Absolute path of the file the Brain is pointing at. */
    file?: string;
    /** 1-based start line. */
    line?: number;
    /** 1-based start column. */
    column?: number;
    /** 1-based end line, when the target covers a region. */
    endLine?: number;
    /** False when the Brain has no live target. */
    active: boolean;
}

interface PaintedTarget {
    file: string;
    startLine: number;
    startColumn: number;
    endLine: number;
}

export class CodeSpotlight implements vscode.Disposable {
    private readonly decoration: vscode.TextEditorDecorationType;
    private readonly disposables: vscode.Disposable[] = [];
    /** What is currently drawn, so a repeat refresh is a genuine no-op. */
    private painted: PaintedTarget | undefined;

    constructor() {
        this.decoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: false,
            backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
            overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
            overviewRulerLane: vscode.OverviewRulerLane.Right,
        });

        this.disposables.push(
            // Re-evaluate on every editor-context change so the highlight can never
            // be stranded in a document the developer has left.
            vscode.window.onDidChangeActiveTextEditor(() => this.repaint('active editor changed')),
            vscode.window.onDidChangeVisibleTextEditors(() => this.repaint('visible editors changed')),
            vscode.window.onDidChangeTextEditorSelection(() => this.repaint('selection changed'))
        );
    }

    /**
     * Draws, moves, or removes the highlight from the authoritative target.
     * Called on every panel refresh; it is a no-op when nothing relevant moved.
     */
    update(target: SpotlightTarget | undefined): void {
        const wanted = this.toPaintedTarget(target);
        if (!wanted) {
            this.clear();
            return;
        }

        const current = this.painted;
        if (current
            && current.file === wanted.file
            && current.startLine === wanted.startLine
            && current.startColumn === wanted.startColumn
            && current.endLine === wanted.endLine) {
            return;
        }

        this.painted = wanted;
        this.paint();
    }

    /** Removes the highlight everywhere. Called on release, monitoring off, dispose. */
    clear(): void {
        if (!this.painted) {
            return;
        }
        this.painted = undefined;
        this.eraseAll();
        Logger.info('SPOTLIGHT', { Event: 'Highlight cleared' });
    }

    /** Re-runs the paint for the target already held, e.g. after an editor change. */
    private repaint(_reason: string): void {
        if (this.painted) {
            this.paint();
        }
    }

    /** Normalises the Brain target into concrete, in-range editor coordinates. */
    private toPaintedTarget(target: SpotlightTarget | undefined): PaintedTarget | undefined {
        if (!target || !target.active || !target.file || !target.line || target.line < 1) {
            return undefined;
        }

        // An open document lets us clamp exactly; without one we still paint, and
        // vscode.Range clamps against the document when the editor receives it.
        const startLine = target.line - 1;
        const endLine = Math.max(target.line, target.endLine ?? target.line) - 1;
        return {
            file: target.file,
            startLine,
            startColumn: Math.max(0, (target.column ?? 1) - 1),
            endLine,
        };
    }

    private paint(): void {
        const target = this.painted;
        if (!target) {
            return;
        }

        let painted = 0;
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.fileName !== target.file) {
                // Only the file the Brain is actually pointing at gets the wash,
                // so a split view never shows a stale highlight in the other pane.
                editor.setDecorations(this.decoration, []);
                continue;
            }

            editor.setDecorations(this.decoration, [{
                range: this.rangeIn(editor.document, target),
                hoverMessage: 'Eve is looking here',
            }]);
            painted += 1;
        }

        Logger.info('SPOTLIGHT', {
            Event: 'Highlight drawn',
            File: target.file.split(/[\\/]/).pop(),
            Line: String(target.startLine + 1),
            Editors: String(painted),
        });
    }

    /** Builds a range that always lands inside the document. */
    private rangeIn(document: vscode.TextDocument, target: PaintedTarget): vscode.Range {
        const lastLine = Math.max(0, document.lineCount - 1);
        const startLine = Math.min(target.startLine, lastLine);
        const endLine = Math.min(Math.max(target.endLine, startLine), lastLine);
        const start = new vscode.Position(startLine, Math.min(target.startColumn, document.lineAt(startLine).text.length));
        const end = new vscode.Position(endLine, document.lineAt(endLine).text.length);
        return new vscode.Range(start, end);
    }

    private eraseAll(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this.decoration, []);
        }
    }

    dispose(): void {
        this.clear();
        this.decoration.dispose();
        while (this.disposables.length > 0) {
            try {
                this.disposables.pop()?.dispose();
            } catch {
                // Disposal must never throw during deactivation.
            }
        }
    }
}
