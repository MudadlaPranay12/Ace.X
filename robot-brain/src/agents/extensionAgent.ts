import { clampConfidence, type AgentFinding, type AgentInput, type SpecializedAgent } from './agentFinding';

export interface ExtensionHealthSources {
    sensorCapabilities: string[];
    supportingSensors: readonly string[];
    eventQueueSize: number;
    pipelineUptimeMs: number;
    pipelineEvents: number;
    webviewInbound: number;
    webviewOutbound: number;
    lastWebviewOutboundAt: number;
    /** Floating Eve bodies currently attached over the WebSocket link. */
    wsClients: number;
}

/**
 * Extension agent: sensor, pipeline, Brain, Webview and communication health.
 *
 * This is a local health check, not a second Brain. Missing optional external
 * bodies are not failures: the canonical robot is the VS Code Webview, so
 * health is judged by the internal event stream and view bridge.
 */
export class ExtensionAgent implements SpecializedAgent {
    readonly name = 'extension' as const;
    private readonly sources: () => ExtensionHealthSources;

    constructor(sources: () => ExtensionHealthSources) {
        this.sources = sources;
    }

    analyze(input: AgentInput): AgentFinding[] {
        const health = this.sources();
        const problems: string[] = [];
        if (health.sensorCapabilities.length !== 11) {
            problems.push(`expected 11 sensor capabilities, found ${health.sensorCapabilities.length}`);
        }
        if (health.eventQueueSize >= 400) {
            problems.push(`event queue under load at ${health.eventQueueSize} events`);
        }
        if (health.webviewOutbound === 0 && health.wsClients === 0) {
            problems.push('no robot body has received Brain state yet');
        }
        if (problems.length === 0) {
            return [];
        }
        return [
            {
                agent: this.name,
                scope: 'WORKSPACE',
                category: 'EXTENSION_HEALTH',
                severity: health.eventQueueSize >= 400 ? 'HIGH' : 'MEDIUM',
                confidence: clampConfidence(0.85),
                summary: problems.join('; '),
                evidence: [
                    { kind: 'sensors', summary: `${health.sensorCapabilities.length} capabilities started` },
                    { kind: 'queue', summary: `${health.eventQueueSize} queued events` },
                    { kind: 'pipeline', summary: `${health.pipelineEvents} events in ${Math.round(health.pipelineUptimeMs / 1000)}s` },
                    { kind: 'webview', summary: `${health.webviewInbound} inbound, ${health.webviewOutbound} outbound` },
                    { kind: 'body', summary: `${health.wsClients} floating Eve client(s) attached` },
                ],
                suggestedActions: [
                    { kind: 'OBSERVE', label: 'Keep the extension running', reason: 'Health findings are operational, not user-facing errors.' },
                ],
                learningSignals: [{ domain: 'extension', detail: problems.join('; ') }],
                context: {
                    branch: input.snapshot.identity.branchId,
                    projectId: input.snapshot.identity.projectId,
                },
            },
        ];
    }
}
