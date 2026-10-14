import type { Context } from '../context/context';
import type { ContextEngine } from '../context/contextEngine';
import type { LearningAgent } from '../learning/learningAgent';
import type { UserModel } from '../user/userModel';
import type { LocalProjectCoordinator } from '../coordination/projectCoordination';
import { ObservationType } from '../perception/observationType';
import { SemanticPerception } from '../perception/semanticPerception';
import { ContextSnapshotBuilder } from '../context/contextSnapshot';
import { DebugAgent } from '../agents/debugAgent';
import { CodingAgent } from '../agents/codingAgent';
import { WorkspaceAgent } from '../agents/workspaceAgent';
import { GitAgent } from '../agents/gitAgent';
import { ExtensionAgent, type ExtensionHealthSources } from '../agents/extensionAgent';
import { AdaptiveMultiLearningAgent } from '../agents/adaptiveMultiLearningAgent';
import type { AgentFinding, AgentInput } from '../agents/agentFinding';
import { AgentSynthesis } from '../agents/agentSynthesis';
import { AcesEngine } from './acesEngine';
import type { AcesResult } from './acesTypes';
import { mapAcesToDecision, type MappedAcesDecision } from '../decision/acesDecisionMapper';
import { robotClientCount } from '../utils/websocketServer';
import { Logger } from '../utils/logger';

export interface AceSystemDeps {
    contextEngine: ContextEngine;
    learning: LearningAgent;
    userModel: UserModel;
    coordinator: LocalProjectCoordinator;
    identity: () => import('../identity/identityTypes').AceIdentity;
    pipelineStats: () => { uptime: number; eventsProcessed: number };
    sensorHealth: () => { capabilities: string[]; supportingSensors: readonly string[] };
    eventQueueSize: () => number;
}

interface WebviewHealth {
    inbound: number;
    outbound: number;
    lastOutboundAt: number;
}

const AGENT_WORTHY_TYPES: ReadonlySet<ObservationType> = new Set([
    ObservationType.DIAGNOSTIC_BATCH,
    ObservationType.ERROR_DETECTED,
    ObservationType.SYNTAX_ERROR,
    ObservationType.WARNING_DETECTED,
    ObservationType.CODING_INTENT,
    ObservationType.SYSTEM_OUTPUT,
    ObservationType.RUNTIME_CRASH,
    ObservationType.DEBUG_INTERRUPTION,
    ObservationType.GIT_BRANCH_CHANGED,
    ObservationType.GIT_REPOSITORY_CHANGED,
    ObservationType.GIT_CONFLICT_DETECTED,
    ObservationType.GIT_CONFLICT_RESOLVED,
    ObservationType.SUCCESSFUL_CHECKPOINT,
    ObservationType.USER_INPUT,
    ObservationType.FILE_OPENED,
    ObservationType.EDITOR_CHANGED,
]);

/**
 * Owns the Ace.X advisory path: semantic perception, context snapshots, the
 * six specialized agents, synthesis and ACES reasoning.
 *
 * The legacy pipeline keeps running unchanged underneath. AceSystem only
 * produces a decision override when ACES recommends a real intervention
 * (explain, suggest, approval or fix); everything else flows through the
 * existing DecisionEngine rules exactly as before.
 */
export class AceSystem {
    private readonly semantic = new SemanticPerception();
    private readonly snapshots: ContextSnapshotBuilder;
    private readonly debug = new DebugAgent();
    private readonly coding = new CodingAgent();
    private readonly workspace = new WorkspaceAgent();
    private readonly git = new GitAgent();
    private readonly extension: ExtensionAgent;
    private readonly adaptive: AdaptiveMultiLearningAgent;
    private readonly synthesis = new AgentSynthesis();
    private readonly aces = new AcesEngine();
    private readonly deps: AceSystemDeps;
    private webviewHealthProvider: () => WebviewHealth = () => ({ inbound: 0, outbound: 0, lastOutboundAt: 0 });

    constructor(deps: AceSystemDeps, userModel: UserModel, coordinator: LocalProjectCoordinator) {
        this.deps = deps;
        this.snapshots = new ContextSnapshotBuilder({
            contextEngine: deps.contextEngine,
            identity: deps.identity,
            userModel,
            project: () => coordinator.projectContext(),
            team: () => coordinator.teamContext(),
        });
        const health = (): ExtensionHealthSources => {
            const view = this.webviewHealthProvider();
            return {
                sensorCapabilities: deps.sensorHealth().capabilities,
                supportingSensors: deps.sensorHealth().supportingSensors,
                eventQueueSize: deps.eventQueueSize(),
                pipelineUptimeMs: deps.pipelineStats().uptime,
                pipelineEvents: deps.pipelineStats().eventsProcessed,
                webviewInbound: view.inbound,
                webviewOutbound: view.outbound,
                lastWebviewOutboundAt: view.lastOutboundAt,
                wsClients: robotClientCount(),
            };
        };
        this.extension = new ExtensionAgent(health);
        this.adaptive = new AdaptiveMultiLearningAgent(deps.learning, userModel, coordinator);
        this.userModel = userModel;
        this.coordinator = coordinator;
    }

    private readonly userModel: UserModel;
    private readonly coordinator: LocalProjectCoordinator;

    setWebviewHealthProvider(provider: () => WebviewHealth): void {
        this.webviewHealthProvider = provider;
    }

    getAdaptiveLearning(): AdaptiveMultiLearningAgent {
        return this.adaptive;
    }

    snapshotFor(context?: Context) {
        return this.snapshots.snapshot(context);
    }

    /**
     * Runs the advisory path for one context. Returns a mapped decision only
     * when ACES recommends an intervention; otherwise undefined (legacy rules
     * apply). Never throws: advisory failures must not break the pipeline.
     */
    adviseForContext(context: Context): { decision: MappedAcesDecision; result: AcesResult } | undefined {
        try {
            const observation = context.sourceObservation;
            const meaning = this.semantic.interpret(observation);
            const snapshot = this.snapshots.snapshot(context);
            this.forwardProjectEvent(observation.type, observation.data, snapshot.identity.branchId);
            if (!AGENT_WORTHY_TYPES.has(observation.type)) {
                return undefined;
            }
            const input: AgentInput = { observation, meaning, snapshot };
            const findings: AgentFinding[] = [
                ...this.debug.analyze(input),
                ...this.coding.analyze(input),
                ...this.git.analyze(input),
                ...this.extension.analyze(input),
                ...this.adaptive.analyze(input),
            ];
            if (
                observation.type === ObservationType.FILE_OPENED ||
                observation.type === ObservationType.EDITOR_CHANGED ||
                observation.type === ObservationType.CODING_INTENT ||
                observation.type === ObservationType.SYSTEM_OUTPUT
            ) {
                findings.push(...this.workspace.analyze(input));
            }
            const synthesis = this.synthesis.synthesize(findings);
            if (!synthesis) {
                return undefined;
            }
            const result = this.aces.reason({ observation, meaning, snapshot, findings, synthesis });
            if (
                result.recommendedAction !== 'EXPLAIN' &&
                result.recommendedAction !== 'SUGGEST' &&
                result.recommendedAction !== 'REQUEST_APPROVAL' &&
                result.recommendedAction !== 'FIX'
            ) {
                return undefined;
            }
            Logger.info('ACES', {
                Event: 'Intervention recommended',
                Action: result.recommendedAction,
                Scope: result.reasoning.scope,
                Confidence: String(result.confidence),
            });
            return { decision: mapAcesToDecision(context, result), result };
        } catch (err) {
            Logger.info('ACES', { Event: 'Advisory failed safely', Error: String(err) });
            return undefined;
        }
    }

    private forwardProjectEvent(
        type: ObservationType,
        data: Record<string, unknown>,
        branchId: string | undefined
    ): void {
        const file = String(data['File'] ?? data['file'] ?? '');
        const message = String(data['Message'] ?? data['message'] ?? data['outputText'] ?? '').slice(0, 300);
        switch (type) {
            case ObservationType.DIAGNOSTIC_BATCH: {
                const errors = Number(data['errorCount'] ?? 0);
                if (errors > 0) {
                    this.coordinator.recordEvent({
                        kind: 'diagnostic',
                        summary: `${errors} error(s) in ${file || 'unknown file'}${message ? `: ${message.slice(0, 160)}` : ''}`,
                        branchId,
                        file: file || undefined,
                        severity: 'error',
                        confidence: 0.9,
                    });
                }
                break;
            }
            case ObservationType.SUCCESSFUL_CHECKPOINT:
                this.coordinator.recordEvent({
                    kind: 'commit',
                    summary: String(data['summary'] ?? data['Message'] ?? 'checkpoint reached').slice(0, 300),
                    branchId,
                    severity: 'info',
                    confidence: 0.8,
                });
                break;
            case ObservationType.GIT_CONFLICT_DETECTED:
                this.coordinator.recordEvent({
                    kind: 'issue',
                    summary: `merge conflict: ${message || file || 'unknown'}`.slice(0, 300),
                    branchId,
                    file: file || undefined,
                    severity: 'error',
                    confidence: 0.9,
                });
                break;
            case ObservationType.SYSTEM_OUTPUT:
                if (data['outputFailed'] === true && String(data['outputKind'] ?? '') === 'test') {
                    this.coordinator.recordEvent({
                        kind: 'test-result',
                        summary: `test failure: ${message.slice(0, 200) || file || 'unknown'}`,
                        branchId,
                        file: file || undefined,
                        severity: 'error',
                        confidence: 0.85,
                    });
                }
                break;
            default:
                break;
        }
    }
}
