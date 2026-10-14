import type { CommentInstruction } from '../intent/commentInstruction';

export type CommentInstructionStatus = 'DETECTED' | 'PROPOSED' | 'APPROVED' | 'COMPLETED' | 'REJECTED' | 'FAILED' | 'STALE' | 'CANCELLED';

export interface TrackedCommentInstruction {
    instruction: CommentInstruction;
    documentVersion: number;
    status: CommentInstructionStatus;
    updatedAt: number;
    failure?: string;
}

/** Session-scoped lifecycle store; it owns no AI or editor mutation. */
export class CommentInstructionState {
    private readonly records = new Map<string, TrackedCommentInstruction>();

    detect(instruction: CommentInstruction, documentVersion: number): TrackedCommentInstruction | undefined {
        const prior = this.records.get(instruction.id);
        if (prior) return undefined;
        const record = { instruction, documentVersion, status: 'DETECTED' as const, updatedAt: Date.now() };
        this.records.set(instruction.id, record);
        return record;
    }

    transition(id: string, status: CommentInstructionStatus, documentVersion: number, failure?: string): TrackedCommentInstruction | undefined {
        const record = this.records.get(id);
        if (!record) return undefined;
        if (status === 'APPROVED' && record.status !== 'PROPOSED') return undefined;
        if (status === 'COMPLETED' && record.status !== 'APPROVED') return undefined;
        record.status = status;
        record.documentVersion = documentVersion;
        record.updatedAt = Date.now();
        record.failure = failure;
        return record;
    }

    get(id: string): TrackedCommentInstruction | undefined { return this.records.get(id); }
    values(): readonly TrackedCommentInstruction[] { return [...this.records.values()]; }
}
