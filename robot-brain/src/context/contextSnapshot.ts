import type { Context } from './context';
import type { ContextEngine } from './contextEngine';
import type { WorkspaceContext } from './workspaceContext';
import type { AceIdentity } from '../identity/identityTypes';
import type { UserModel } from '../user/userModel';
import type { ProjectContext, TeamContext } from '../coordination/projectCoordination';

export interface AceContextSnapshot {
    identity: AceIdentity;
    latestContext?: Context;
    user: ReturnType<UserModel['snapshot']>;
    workspace: {
        file: string;
        language: string;
        context: string;
        cursorLine: number;
        cursorColumn: number;
        terminalActive: boolean;
        debuggerActive: boolean;
        branch: string;
        lastError: string;
    };
    project: ProjectContext;
    team: TeamContext;
}

export interface ContextSnapshotSources {
    contextEngine: ContextEngine;
    identity: () => AceIdentity;
    userModel: UserModel;
    project: () => ProjectContext;
    team: () => TeamContext;
}

/**
 * Builds one read-only Ace.X context snapshot from existing state.
 *
 * Workspace state stays owned by ContextEngine, learning stays owned by
 * LearningAgent/UserModel, and project/team state stays owned by coordination.
 * This builder only joins those sources for ACES and agents; it creates no
 * competing context store.
 */
export class ContextSnapshotBuilder {
    private readonly sources: ContextSnapshotSources;
    private latestContext: Context | undefined;
    private readonly contextListener = (context: Context): void => {
        this.latestContext = context;
    };

    constructor(sources: ContextSnapshotSources) {
        this.sources = sources;
        this.sources.contextEngine.getPublisher().subscribe(this.contextListener);
    }

    snapshot(latestContext?: Context): AceContextSnapshot {
        const workspace: WorkspaceContext = this.sources.contextEngine.getWorkspaceContext();
        return {
            identity: this.sources.identity(),
            latestContext: latestContext ?? this.latestContext,
            user: this.sources.userModel.snapshot(),
            workspace: {
                file: workspace.currentFile,
                language: workspace.currentLanguage,
                context: workspace.currentContext,
                cursorLine: workspace.cursorLine,
                cursorColumn: workspace.cursorColumn,
                terminalActive: workspace.terminalActive,
                debuggerActive: workspace.debuggerActive,
                branch: workspace.gitBranch,
                lastError: workspace.lastError,
            },
            project: this.sources.project(),
            team: this.sources.team(),
        };
    }

    dispose(): void {
        this.sources.contextEngine.getPublisher().unsubscribe(this.contextListener);
    }
}
