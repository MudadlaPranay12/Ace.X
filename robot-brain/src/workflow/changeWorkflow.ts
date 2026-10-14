import * as vscode from 'vscode';
import { Logger } from '../utils/logger';

export type ChangeProposalStatus = 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'APPLIED' | 'FAILED' | 'VERIFIED';

export interface ChangeProposal {
    id: string;
    file: string;
    line: number;
    originalText: string;
    replacement: string;
    reason: string;
    status: ChangeProposalStatus;
    createdAt: number;
    decidedAt?: number;
}

export interface VerificationOutcome {
    verified: boolean;
    detail: string;
}

/**
 * Canonical explain-first change workflow.
 *
 * Problem → Explain → user decision → proposal → diff → explicit approval →
 * apply → verify. Nothing here edits code without an explicit approval, and
 * application re-validates the source range so a stale proposal can never
 * overwrite newer edits.
 */
export class ChangeWorkflow {
    private readonly proposals = new Map<string, ChangeProposal>();

    propose(input: {
        file: string;
        line: number;
        originalText: string;
        replacement: string;
        reason: string;
    }): ChangeProposal {
        const proposal: ChangeProposal = {
            ...input,
            id: `change-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            status: 'PROPOSED',
            createdAt: Date.now(),
        };
        this.proposals.set(proposal.id, proposal);
        Logger.info('WORKFLOW', { Event: 'Change proposed', File: proposal.file, Line: String(proposal.line) });
        return proposal;
    }

    approve(id: string): ChangeProposal | undefined {
        const proposal = this.proposals.get(id);
        if (!proposal || proposal.status !== 'PROPOSED') {
            return undefined;
        }
        proposal.status = 'APPROVED';
        proposal.decidedAt = Date.now();
        return proposal;
    }

    reject(id: string): ChangeProposal | undefined {
        const proposal = this.proposals.get(id);
        if (!proposal || proposal.status !== 'PROPOSED') {
            return undefined;
        }
        proposal.status = 'REJECTED';
        proposal.decidedAt = Date.now();
        return proposal;
    }

    async applyApproved(uri: vscode.Uri, id: string): Promise<boolean> {
        const proposal = this.proposals.get(id);
        if (!proposal || proposal.status !== 'APPROVED') {
            return false;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        if (!document.getText().includes(proposal.originalText)) {
            proposal.status = 'FAILED';
            Logger.info('WORKFLOW', { Event: 'Apply rejected — source changed', File: proposal.file });
            return false;
        }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, this.locateRange(document, proposal), proposal.replacement);
        const applied = await vscode.workspace.applyEdit(edit);
        proposal.status = applied ? 'APPLIED' : 'FAILED';
        return applied;
    }

    /**
     * Verifies an applied change against live diagnostics: the proposal is
     * verified only when no error diagnostic remains on its line.
     */
    async verifyByDiagnostics(uri: vscode.Uri, id: string): Promise<VerificationOutcome> {
        const proposal = this.proposals.get(id);
        if (!proposal) {
            return { verified: false, detail: 'unknown proposal' };
        }
        const diagnostics = vscode.languages.getDiagnostics(uri);
        const remaining = diagnostics.filter(
            (diagnostic) =>
                diagnostic.severity === vscode.DiagnosticSeverity.Error &&
                diagnostic.range.start.line + 1 === proposal.line
        );
        const verified = remaining.length === 0;
        if (verified && proposal.status === 'APPLIED') {
            proposal.status = 'VERIFIED';
        }
        return {
            verified,
            detail: verified ? 'no error diagnostic remains on the edited line' : `${remaining.length} error(s) still reported`,
        };
    }

    private locateRange(document: vscode.TextDocument, proposal: ChangeProposal): vscode.Range {
        const text = document.getText();
        const offset = text.indexOf(proposal.originalText);
        if (offset < 0) {
            return new vscode.Range(proposal.line - 1, 0, proposal.line - 1, 0);
        }
        const start = document.positionAt(offset);
        const end = document.positionAt(offset + proposal.originalText.length);
        return new vscode.Range(start, end);
    }
}
