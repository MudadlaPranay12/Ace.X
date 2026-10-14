import { ObservationType } from '../perception/observationType';
import { clampConfidence, type AgentFinding, type AgentInput, type SpecializedAgent } from './agentFinding';

function stackFrames(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^\s*at\s+.+:\d+/.test(line) || /Traceback|File ".+", line \d+/.test(line))
        .slice(0, 8);
}

function rootCauseCandidate(message: string, frames: string[]): string | undefined {
    const text = `${message}\n${frames.join('\n')}`.toLowerCase();
    if (/cannot find name|is not defined|undefined/.test(text)) {
        return 'A name is used before it is defined or imported in the observed scope.';
    }
    if (/cannot find module|no module named|failed to resolve/.test(text)) {
        return 'A dependency or module cannot be resolved from the observed import.';
    }
    if (/type .* is not assignable|type mismatch|expected .* but got/.test(text)) {
        return 'A value does not match the expected type at the reported location.';
    }
    if (/eaddrinuse|port .* (in use|already)/.test(text)) {
        return 'A required local port is already occupied by another process.';
    }
    return undefined;
}

/**
 * Debug agent: compiler diagnostics, runtime failures, stack traces, test
 * failures and repeated failures. It reports only what sensors and the
 * timeline observed, with root-cause candidates constrained to recognizable
 * diagnostic shapes.
 */
export class DebugAgent implements SpecializedAgent {
    readonly name = 'debug' as const;

    analyze(input: AgentInput): AgentFinding[] {
        const { observation, meaning, snapshot } = input;
        const data = observation.data;
        const isDiagnostic =
            observation.type === ObservationType.ERROR_DETECTED ||
            observation.type === ObservationType.SYNTAX_ERROR ||
            observation.type === ObservationType.WARNING_DETECTED ||
            observation.type === ObservationType.DIAGNOSTIC_BATCH;
        const isRuntime =
            observation.type === ObservationType.RUNTIME_CRASH ||
            observation.type === ObservationType.DEBUG_INTERRUPTION ||
            observation.type === ObservationType.SYSTEM_OUTPUT;

        if (!isDiagnostic && !isRuntime) {
            return [];
        }

        const message = String(
            data['Message'] ?? data['details'] ?? data['outputText'] ?? data['errorSnippet'] ?? ''
        ).slice(0, 500);
        if (!message && !isRuntime) {
            return [];
        }
        const file = String(data['File'] ?? data['file'] ?? snapshot.workspace.file ?? '');
        const line = Number(data['Line'] ?? data['line'] ?? 0);
        const frames = stackFrames(String(data['outputText'] ?? data['StackTrace'] ?? ''));
        const repeated = meaning.patterns.includes('REPEATED_DIAGNOSTICS');
        const severity = observation.type === ObservationType.WARNING_DETECTED ? 'MEDIUM' : 'HIGH';
        const confidence = clampConfidence(
            observation.confidence * (repeated ? 0.95 : 0.85) + (frames.length > 0 ? 0.05 : 0)
        );

        const finding: AgentFinding = {
            agent: this.name,
            scope: repeated ? 'PROJECT' : 'USER',
            category: isRuntime ? 'RUNTIME_FAILURE' : 'DIAGNOSTIC',
            severity,
            confidence,
            summary: repeated
                ? `Recurring failure: ${message || 'runtime failure'}`
                : message || 'Runtime failure observed',
            evidence: [
                { kind: 'observation', summary: `${observation.type} in ${file || 'unknown file'}` },
                ...(frames.map((frame) => ({ kind: 'stack-frame', summary: frame }))),
                ...(repeated ? [{ kind: 'pattern', summary: 'same diagnostic signature observed repeatedly' }] : []),
            ],
            possibleCause: rootCauseCandidate(message, frames),
            suggestedActions: [
                { kind: 'EXPLAIN', label: 'Explain the failure', reason: 'The developer needs the cause before any edit.' },
                ...(repeated
                    ? [{ kind: 'SUGGEST' as const, label: 'Suggest the underlying concept', reason: 'Repetition indicates a missing concept, not a typo.' }]
                    : []),
            ],
            learningSignals: [
                {
                    domain: String(data['Language'] ?? data['language'] ?? snapshot.workspace.language ?? 'general'),
                    concept: repeated ? 'recurring diagnostic' : undefined,
                    success: false,
                    detail: `debug observation ${observation.type}`,
                },
            ],
            context: {
                file: file || undefined,
                line: Number.isFinite(line) && line > 0 ? line : undefined,
                language: String(data['Language'] ?? data['language'] ?? snapshot.workspace.language ?? ''),
                branch: snapshot.identity.branchId,
                projectId: snapshot.identity.projectId,
            },
        };
        return [finding];
    }
}
