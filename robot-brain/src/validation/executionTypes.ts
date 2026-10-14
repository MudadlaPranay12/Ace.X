export type ValidationState =
    | 'GENERATED'
    | 'INSERTED'
    | 'SAVED'
    | 'EXECUTION_PROPOSED'
    | 'EXECUTION_APPROVED'
    | 'EXECUTED'
    | 'TESTED'
    | 'VERIFIED'
    | 'FAILED'
    | 'CANCELLED'
    | 'TIMED_OUT';

export interface ValidationCommand {
    executable: string;
    args: string[];
    cwd: string;
    label: string;
    kind: 'syntax' | 'typecheck' | 'test' | 'build';
    requiresApproval: boolean;
}

export interface ValidationResult {
    requestId: string;
    state: ValidationState;
    command: ValidationCommand;
    exitCode?: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    cancelled: boolean;
    durationMs: number;
    detail: string;
}
