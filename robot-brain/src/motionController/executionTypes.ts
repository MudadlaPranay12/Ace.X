export enum ExecutionStatus {
    PENDING = "PENDING",
    RUNNING = "RUNNING",
    COMPLETED = "COMPLETED",
    FAILED = "FAILED",
    SKIPPED = "SKIPPED",
    INTERRUPTED = "INTERRUPTED"
}

export interface ExecutionResult {
    motionId: string;
    status: ExecutionStatus;
    startTime: number;
    endTime?: number;
    error?: string;
}
