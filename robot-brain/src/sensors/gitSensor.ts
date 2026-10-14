import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { AetherEvent } from '../eventFilter/event';
import { Logger } from '../utils/logger';
import type { BehaviourController } from '../behaviour/behaviourController';

interface GitCommitInfo {
    message: string;
    hash?: string;
}

export class GitSensor {
    private eventFilter: EventFilter;
    private behaviourController: BehaviourController | null;

    constructor(eventFilter: EventFilter, behaviourController?: BehaviourController) {
        this.eventFilter = eventFilter;
        this.behaviourController = behaviourController ?? null;
    }

    public start(context: vscode.ExtensionContext): void {
        Logger.info("GIT SENSOR", { "Event": "Started" });

        this.detectRepositories();
        this.tryWatchGitApi(context);
        this.watchWorkspaceFolders(context);
    }

    private detectRepositories(): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            Logger.info("GIT SENSOR", { "Event": "No Workspace" });
            return;
        }
        for (const folder of workspaceFolders) {
            Logger.info("GIT SENSOR", {
                "Event": "Workspace Folder",
                "Repository": folder.uri.fsPath
            });
        }
    }

    private watchWorkspaceFolders(context: vscode.ExtensionContext): void {
        const workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
            for (const folder of event.added) {
                this.publishEvent(EventType.GIT_REPOSITORY_CHANGED, {
                    "Repository": folder.uri.fsPath,
                    "Action": "opened"
                });
            }
            for (const folder of event.removed) {
                this.publishEvent(EventType.GIT_REPOSITORY_CHANGED, {
                    "Repository": folder.uri.fsPath,
                    "Action": "closed"
                });
            }
        });
        context.subscriptions.push(workspaceListener);
    }

    private tryWatchGitApi(context: vscode.ExtensionContext): void {
        try {
            const gitExtension = vscode.extensions.getExtension("vscode.git");
            if (!gitExtension) {
                Logger.info("GIT SENSOR", { "Event": "Git extension not available" });
                return;
            }

            const gitApi = gitExtension.exports;
            if (!gitApi || typeof gitApi.getAPI !== "function") {
                Logger.info("GIT SENSOR", { "Event": "Git API not available" });
                return;
            }

            const api = gitApi.getAPI(1);
            if (!api || !api.repositories) {
                Logger.info("GIT SENSOR", { "Event": "No Git repositories found" });
                return;
            }

            for (const repo of api.repositories) {
                const repoPath = repo.rootUri.fsPath;
                const repoName = repoPath.split("\\").pop()?.split("/").pop() || "unknown";

                Logger.info("GIT SENSOR", {
                    "Event": "Repository tracked",
                    "Repository": repoName,
                    "Branch": repo.state.HEAD?.name || "unknown"
                });

                let lastCommitHash = repo.state.HEAD?.commit ?? "";
                let lastAhead = repo.state.HEAD?.ahead ?? 0;
                let lastBehind = repo.state.HEAD?.behind ?? 0;
                let pendingPush = false;

                if (typeof repo.state.onDidChange === "function") {
                    const stateListener = repo.state.onDidChange(() => {
                        const head = repo.state.HEAD;
                        const currentHash = head?.commit ?? "";
                        const refs = repo.state.HEAD?.name ?? "unknown";
                        const workingTreeChanges = repo.state.workingTreeChanges.length;
                        const mergeChanges = repo.state.mergeChanges.length;
                        const currentAhead = head?.ahead ?? 0;
                        const currentBehind = head?.behind ?? 0;

                        if (currentHash && currentHash !== lastCommitHash) {
                            pendingPush = true;
                            const commitInfo = this.extractCommitInfo(repo, currentHash);
                            if (commitInfo) {
                                this.publishEvent(EventType.GIT_COMMIT_SUCCESS, {
                                    "Repository": repoName,
                                    "Message": commitInfo.message,
                                    "Hash": commitInfo.hash ?? currentHash,
                                    "Branch": refs
                                });
                                Logger.info("GIT SENSOR", {
                                    "Event": "Commit detected",
                                    "Repository": repoName,
                                    "Message": commitInfo.message,
                                    "Branch": refs
                                });
                            }
                        }

                        if (pendingPush && currentAhead === 0 && currentBehind === 0) {
                            pendingPush = false;
                            this.behaviourController?.triggerState('GIT_COMMIT_SUCCESS');
                        }

                        if (mergeChanges > 0) {
                            this.publishEvent(EventType.GIT_CONFLICT_DETECTED, {
                                "Repository": repoName,
                                "Conflict Count": mergeChanges,
                                "Branch": refs,
                                "Message": `Merge conflict detected in ${repoName}`
                            });
                            Logger.info("GIT SENSOR", {
                                "Event": "Merge conflict detected",
                                "Repository": repoName,
                                "Count": String(mergeChanges)
                            });
                            this.behaviourController?.triggerState('GIT_MERGE_CONFLICT');
                        }

                        const newHash = head?.commit ?? "";
                        lastCommitHash = newHash;
                        lastAhead = currentAhead;
                        lastBehind = currentBehind;
                    });
                    context.subscriptions.push(stateListener);
                }
            }
        } catch (err) {
            Logger.info("GIT SENSOR", { "Event": "Git monitoring error", "Error": String(err) });
        }
    }

    private extractCommitInfo(repo: any, commitHash: string): GitCommitInfo | null {
        try {
            const log = repo.log?.({ maxEntries: 1 });
            if (log && log.length > 0) {
                return {
                    message: log[0].message,
                    hash: log[0].hash
                };
            }
        } catch {
            // log API may not be available
        }
        return { message: "Commit recorded", hash: commitHash };
    }

    private publishEvent(type: EventType, payload: Record<string, unknown>): void {
        const event: AetherEvent = {
            id: `git-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type,
            timestamp: Date.now(),
            source: "GitSensor",
            payload
        };
        this.eventFilter.publish(event);
    }
}
