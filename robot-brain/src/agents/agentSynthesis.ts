import { clampConfidence, type AgentFinding } from './agentFinding';

export interface SynthesizedRecommendation {
    rootCause?: string;
    scope: 'USER' | 'WORKSPACE' | 'PROJECT' | 'TEAM';
    confidence: number;
    severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    summary: string;
    findings: AgentFinding[];
    contradictions: string[];
    recommendedAction: 'IGNORE' | 'OBSERVE' | 'EXPLAIN' | 'SUGGEST' | 'REQUEST_APPROVAL' | 'FIX' | 'VERIFY';
    evidence: string[];
}

const SEVERITY_ORDER = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

/**
 * Correlates findings from all agents into one recommendation.
 *
 * Related evidence is merged, contradictions are named explicitly, and the
 * likely root cause is selected from findings rather than invented. A Git API
 * change plus a type mismatch plus failing tests, for example, synthesizes to
 * one project-level contract cause instead of three disconnected alerts.
 */
export class AgentSynthesis {
    synthesize(findings: AgentFinding[]): SynthesizedRecommendation | undefined {
        const ranked = [...findings].sort((left, right) => {
            const severity = SEVERITY_ORDER.indexOf(right.severity) - SEVERITY_ORDER.indexOf(left.severity);
            if (severity !== 0) {
                return severity;
            }
            return right.confidence - left.confidence;
        });
        if (ranked.length === 0) {
            return undefined;
        }

        const contradictions = this.findContradictions(ranked);
        const rootCause = this.findRootCause(ranked);
        const scope = this.scopeFor(ranked);
        const confidence = clampConfidence(
            ranked.reduce((total, finding) => total + finding.confidence, 0) / ranked.length +
                (rootCause ? 0.05 : 0) -
                contradictions.length * 0.05
        );
        return {
            rootCause,
            scope,
            confidence,
            severity: ranked[0].severity,
            summary: rootCause ?? ranked[0].summary,
            findings: ranked,
            contradictions,
            recommendedAction: this.actionFor(ranked, rootCause),
            evidence: ranked.flatMap((finding) => finding.evidence.map((entry) => `${finding.agent}:${entry.summary}`)).slice(0, 20),
        };
    }

    private findContradictions(findings: AgentFinding[]): string[] {
        const contradictions: string[] = [];
        const causes = new Map<string, string[]>();
        for (const finding of findings) {
            if (finding.possibleCause) {
                const list = causes.get(finding.category) ?? [];
                list.push(`${finding.agent}: ${finding.possibleCause}`);
                causes.set(finding.category, list);
            }
        }
        for (const [category, list] of causes) {
            if (list.length > 1) {
                contradictions.push(`Multiple causes proposed for ${category}: ${list.join(' | ')}`);
            }
        }
        const scopes = new Set(findings.map((finding) => finding.scope));
        if (scopes.has('USER') && scopes.has('PROJECT')) {
            contradictions.push('Findings disagree about scope: local user issue versus shared project issue.');
        }
        return contradictions;
    }

    private findRootCause(findings: AgentFinding[]): string | undefined {
        const apiChange = findings.find((finding) => finding.category === 'MERGE_CONFLICT' || finding.category === 'REPOSITORY_STATE');
        const diagnostic = findings.find((finding) => finding.category === 'DIAGNOSTIC' || finding.category === 'RUNTIME_FAILURE');
        if (apiChange && diagnostic && findings.some((finding) => finding.scope === 'PROJECT')) {
            return `Project change (${apiChange.summary}) is consistent with the observed failure (${diagnostic.summary}).`;
        }
        const repeated = findings.find((finding) => finding.summary.startsWith('Recurring failure'));
        return repeated?.possibleCause ?? repeated?.summary ?? findings.find((finding) => finding.possibleCause)?.possibleCause;
    }

    private scopeFor(findings: AgentFinding[]): SynthesizedRecommendation['scope'] {
        if (findings.some((finding) => finding.scope === 'TEAM')) {
            return 'TEAM';
        }
        if (findings.some((finding) => finding.scope === 'PROJECT')) {
            return 'PROJECT';
        }
        if (findings.some((finding) => finding.scope === 'WORKSPACE')) {
            return 'WORKSPACE';
        }
        return 'USER';
    }

    private actionFor(findings: AgentFinding[], rootCause: string | undefined): SynthesizedRecommendation['recommendedAction'] {
        if (findings.some((finding) => finding.severity === 'CRITICAL')) {
            return 'REQUEST_APPROVAL';
        }
        if (rootCause && findings.some((finding) => finding.severity === 'HIGH')) {
            return 'SUGGEST';
        }
        if (findings.some((finding) => finding.category === 'CODING_INTENT')) {
            return 'EXPLAIN';
        }
        if (findings.every((finding) => finding.severity === 'INFO')) {
            return 'IGNORE';
        }
        return 'OBSERVE';
    }
}
