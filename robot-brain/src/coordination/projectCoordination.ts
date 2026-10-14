import type { AceIdentity } from '../identity/identityTypes';
import { Logger } from '../utils/logger';

export type CoordinationMode = 'local-only' | 'team';

export type ProjectEventKind =
    | 'diagnostic'
    | 'commit'
    | 'branch'
    | 'test-result'
    | 'api-change'
    | 'ownership'
    | 'build-status'
    | 'issue';

export interface ProjectEvent {
    id: string;
    kind: ProjectEventKind;
    summary: string;
    branchId?: string;
    file?: string;
    severity?: 'info' | 'warning' | 'error';
    confidence: number;
    timestamp: number;
    localDeveloperId: string;
}

export interface ProjectContext {
    projectId: string;
    mode: CoordinationMode;
    branches: string[];
    recentEvents: ProjectEvent[];
    openIssues: string[];
    failingTests: string[];
    changedApis: string[];
    ownership: Record<string, string>;
}

export interface TeamContext {
    teamId: string;
    members: string[];
    handoffs: string[];
    sharedIssues: string[];
    dependencies: string[];
}

export interface ProjectCoordinationPort {
    mode(): CoordinationMode;
    recordEvent(event: Omit<ProjectEvent, 'id' | 'timestamp' | 'localDeveloperId'>): ProjectEvent;
    projectContext(): ProjectContext;
    teamContext(): TeamContext;
}

const MAX_EVENTS = 100;
const MAX_TEXT = 500;

/**
 * Local project/team coordination adapter.
 *
 * Every local Brain keeps its own observations. This adapter aggregates only
 * bounded structured metadata—diagnostics, commits, branch changes, test
 * results, API changes, ownership and build status—so a future team transport
 * can exchange the same contract without ever sending whole source files.
 */
export class LocalProjectCoordinator implements ProjectCoordinationPort {
    private readonly identity: () => AceIdentity;
    private coordinationMode: CoordinationMode = 'local-only';
    private readonly events: ProjectEvent[] = [];

    constructor(identity: () => AceIdentity) {
        this.identity = identity;
    }

    setMode(mode: CoordinationMode): void {
        this.coordinationMode = mode;
    }

    mode(): CoordinationMode {
        return this.coordinationMode;
    }

    recordEvent(event: Omit<ProjectEvent, 'id' | 'timestamp' | 'localDeveloperId'>): ProjectEvent {
        const identity = this.identity();
        const recorded: ProjectEvent = {
            ...event,
            id: `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Date.now(),
            localDeveloperId: identity.developerId,
            summary: event.summary.slice(0, MAX_TEXT),
            file: event.file?.slice(0, MAX_TEXT),
        };
        this.events.push(recorded);
        if (this.events.length > MAX_EVENTS) {
            this.events.splice(0, this.events.length - MAX_EVENTS);
        }
        Logger.info('COORDINATION', {
            Event: `Project ${recorded.kind}`,
            Summary: recorded.summary.slice(0, 120),
            Branch: recorded.branchId ?? identity.branchId ?? 'unknown',
        });
        return recorded;
    }

    projectContext(): ProjectContext {
        const identity = this.identity();
        const branches = new Set<string>();
        const openIssues = new Set<string>();
        const failingTests = new Set<string>();
        const changedApis = new Set<string>();
        const ownership: Record<string, string> = {};
        if (identity.branchId) {
            branches.add(identity.branchId);
        }
        for (const event of this.events) {
            if (event.branchId) {
                branches.add(event.branchId);
            }
            if (event.kind === 'diagnostic' && event.severity === 'error') {
                openIssues.add(event.summary);
            }
            if (event.kind === 'test-result' && event.severity === 'error') {
                failingTests.add(event.summary);
            }
            if (event.kind === 'api-change') {
                changedApis.add(event.summary);
            }
            if (event.kind === 'issue') {
                openIssues.add(event.summary);
            }
            if (event.kind === 'ownership' && event.file) {
                ownership[event.file] = event.localDeveloperId;
            }
        }
        return {
            projectId: identity.projectId,
            mode: this.coordinationMode,
            branches: [...branches],
            recentEvents: this.events.slice(-20).reverse(),
            openIssues: [...openIssues].slice(0, 20),
            failingTests: [...failingTests].slice(0, 20),
            changedApis: [...changedApis].slice(0, 20),
            ownership,
        };
    }

    teamContext(): TeamContext {
        const identity = this.identity();
        const members = new Set<string>([identity.developerId]);
        const handoffs = new Set<string>();
        const sharedIssues = new Set<string>();
        const dependencies = new Set<string>();
        for (const event of this.events) {
            members.add(event.localDeveloperId);
            if (event.kind === 'ownership' && event.file) {
                handoffs.add(`${event.file} touched by ${event.localDeveloperId}`);
            }
            if ((event.kind === 'diagnostic' || event.kind === 'test-result') && event.severity === 'error') {
                sharedIssues.add(event.summary);
            }
            if (event.kind === 'api-change') {
                dependencies.add(event.summary);
            }
        }
        return {
            teamId: identity.teamId,
            members: [...members],
            handoffs: [...handoffs].slice(0, 20),
            sharedIssues: [...sharedIssues].slice(0, 20),
            dependencies: [...dependencies].slice(0, 20),
        };
    }
}
