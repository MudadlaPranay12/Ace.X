import * as vscode from 'vscode';
import { EventType } from '../eventFilter/eventTypes';
import type { EventFilter } from '../eventFilter/eventFilter';
import { Logger } from '../utils/logger';
import type { AceIdentity } from './identityTypes';

const DEVELOPER_STORAGE_KEY = 'acex.developerId';
const PROJECT_SETTING_KEY = 'projectId';
const TEAM_SETTING_KEY = 'teamId';
const UNKNOWN = 'unknown';

function randomSuffix(length = 8): string {
    return Math.random().toString(36).slice(2, 2 + length);
}

function stableHash(value: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return `ws-${(hash >>> 0).toString(36)}`;
}

function readGitBranch(): string | undefined {
    try {
        const gitExtension = vscode.extensions.getExtension<{ getAPI: (version: number) => unknown }>('vscode.git');
        const api = gitExtension?.exports?.getAPI(1) as
            | { repositories?: Array<{ state?: { HEAD?: { name?: string } } }> }
            | undefined;
        const branch = api?.repositories?.[0]?.state?.HEAD?.name;
        return typeof branch === 'string' && branch.length > 0 ? branch : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Owns local Ace.X identity for one running extension host.
 *
 * The developer ID is persisted per VS Code profile/machine. Session, branch,
 * workspace and project values are resolved from the live environment. Branch
 * changes are tracked through the existing Git event stream rather than by
 * polling the Git API.
 */
export class SessionManager {
    private readonly context: vscode.ExtensionContext;
    private readonly sessionId = `session-${Date.now().toString(36)}-${randomSuffix()}`;
    private readonly workspaceId: string;
    private branchId: string | undefined;
    private readonly filterListener: (event: { type: EventType; payload: unknown }) => void;

    constructor(context: vscode.ExtensionContext, eventFilter?: EventFilter) {
        this.context = context;
        this.workspaceId = this.resolveWorkspaceId();
        this.branchId = readGitBranch();

        this.filterListener = (event) => {
            if (event.type === EventType.GIT_BRANCH_CHANGED) {
                const payload = event.payload as Record<string, unknown> | undefined;
                const branch = String(payload?.['Branch'] ?? '').trim();
                if (branch) {
                    this.branchId = branch;
                }
            }
        };
        eventFilter?.subscribe(this.filterListener);

        Logger.info('IDENTITY', {
            Event: 'Session started',
            Developer: this.developerId(),
            Session: this.sessionId,
            Workspace: this.workspaceId,
            Project: this.projectId(),
            Branch: this.branchId ?? UNKNOWN,
            Team: this.teamId(),
        });
    }

    current(): AceIdentity {
        return {
            developerId: this.developerId(),
            sessionId: this.sessionId,
            workspaceId: this.workspaceId,
            projectId: this.projectId(),
            branchId: this.branchId,
            teamId: this.teamId(),
        };
    }

    refreshBranch(): void {
        this.branchId = readGitBranch() ?? this.branchId;
    }

    dispose(eventFilter?: EventFilter): void {
        eventFilter?.unsubscribe(this.filterListener);
    }

    private developerId(): string {
        const stored = this.context.globalState.get<string>(DEVELOPER_STORAGE_KEY);
        if (stored && stored.trim()) {
            return stored;
        }
        const created = `developer-${randomSuffix(12)}`;
        void this.context.globalState.update(DEVELOPER_STORAGE_KEY, created);
        return created;
    }

    private resolveWorkspaceId(): string {
        const file = vscode.workspace.workspaceFile?.fsPath;
        if (file) {
            return stableHash(`file:${file}`);
        }
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 0) {
            return 'ws-empty';
        }
        return stableHash(`folders:${folders.map((folder) => folder.uri.fsPath).sort().join('|')}`);
    }

    private projectId(): string {
        const configured = vscode.workspace
            .getConfiguration('acex')
            .get<string>(PROJECT_SETTING_KEY, '')
            .trim();
        return configured || this.workspaceId;
    }

    private teamId(): string {
        const configured = vscode.workspace
            .getConfiguration('acex')
            .get<string>(TEAM_SETTING_KEY, '')
            .trim();
        return configured || 'local-team';
    }
}
