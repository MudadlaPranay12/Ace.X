import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { EventFilter } from '../eventFilter/eventFilter';
import { EventType } from '../eventFilter/eventTypes';
import { AetherEvent } from '../eventFilter/event';
import { Debounce } from '../eventFilter/debounce';
import { Logger } from '../utils/logger';

export type DependencyState = "installed" | "missing" | "incomplete" | "no-package-json";

export interface EnvironmentStatus {
    workspaceRoot: string;
    envFileMissing: boolean;
    missingEnvKeys: string[];
    hasPackageJson: boolean;
    dependenciesInstalled: boolean;
    missingDependencies: string[];
    dependencyState: DependencyState;
    issues: string[];
    clean: boolean;
}

export class EnvironmentSensor {
    private eventFilter: EventFilter;
    private watchers: vscode.Disposable[] = [];

    constructor(eventFilter: EventFilter) {
        this.eventFilter = eventFilter;
    }

    public start(context: vscode.ExtensionContext): void {
        Logger.info("ENVIRONMENT SENSOR", { "Event": "Started" });

        this.checkAndPublish();

        const workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.checkAndPublish();
        });

        const envWatcher = vscode.workspace.createFileSystemWatcher("**/.env*");
        const packageWatcher = vscode.workspace.createFileSystemWatcher("**/package.json");

        const debouncer = new Debounce();
        const onConfigChanged = () => {
            debouncer.debounce("environment", () => this.checkAndPublish(), 500);
        };

        envWatcher.onDidCreate(onConfigChanged);
        envWatcher.onDidChange(onConfigChanged);
        envWatcher.onDidDelete(onConfigChanged);
        packageWatcher.onDidCreate(onConfigChanged);
        packageWatcher.onDidChange(onConfigChanged);
        packageWatcher.onDidDelete(onConfigChanged);

        const disposables: vscode.Disposable[] = [workspaceListener, envWatcher, packageWatcher];
        for (const disposable of disposables) {
            context.subscriptions.push(disposable);
            this.watchers.push(disposable);
        }
    }

    public dispose(): void {
        for (const disposable of this.watchers) {
            disposable.dispose();
        }
        this.watchers = [];
        Logger.info("ENVIRONMENT SENSOR", { "Event": "Disposed" });
    }

    private checkAndPublish(): void {
        const status = this.inspectWorkspace();
        this.publish(status);
    }

    private publish(status: EnvironmentStatus): void {
        const event: AetherEvent = {
            id: `env-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: EventType.ENVIRONMENT_CHECK,
            timestamp: Date.now(),
            source: "EnvironmentSensor",
            payload: status
        };
        this.eventFilter.publish(event);
        Logger.info("ENVIRONMENT SENSOR", {
            "Event": "Status checked",
            "Workspace": status.workspaceRoot,
            "Missing env keys": String(status.missingEnvKeys.length),
            "Dependencies": status.dependencyState,
            "Clean": status.clean ? "Yes" : "No"
        });
    }

    private inspectWorkspace(): EnvironmentStatus {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return {
                workspaceRoot: "",
                envFileMissing: false,
                missingEnvKeys: [],
                hasPackageJson: false,
                dependenciesInstalled: false,
                missingDependencies: [],
                dependencyState: "no-package-json",
                issues: [],
                clean: true
            };
        }

        const root = folders[0].uri.fsPath;
        const envPath = path.join(root, ".env");
        const baselinePath = this.findEnvBaseline(root);

        const hasEnv = fs.existsSync(envPath);
        let envFileMissing = false;
        let missingEnvKeys: string[] = [];

        if (baselinePath) {
            const baselineKeys = this.parseEnvKeys(baselinePath);
            if (!hasEnv) {
                envFileMissing = true;
                missingEnvKeys = Array.from(baselineKeys);
            } else {
                const envKeys = this.parseEnvKeys(envPath);
                missingEnvKeys = Array.from(baselineKeys).filter((key) => !envKeys.has(key));
            }
        }

        const packageJsonPath = path.join(root, "package.json");
        const hasPackageJson = fs.existsSync(packageJsonPath);
        const missingDependencies = this.findMissingDependencies(root, packageJsonPath);
        let dependencyState: DependencyState = "no-package-json";
        let dependenciesInstalled = false;

        if (hasPackageJson) {
            const nodeModulesExists = this.directoryExists(path.join(root, "node_modules"));
            if (!nodeModulesExists) {
                dependencyState = "missing";
            } else if (missingDependencies.length > 0) {
                dependencyState = "incomplete";
            } else {
                dependencyState = "installed";
                dependenciesInstalled = true;
            }
        }

        const issues: string[] = [];
        if (missingEnvKeys.length > 0) {
            issues.push(`${missingEnvKeys.length} environment key${missingEnvKeys.length === 1 ? "" : "s"} missing`);
        }
        if (hasPackageJson && !dependenciesInstalled) {
            issues.push(dependencyState === "incomplete"
                ? "dependencies incomplete"
                : "dependencies not installed");
        }

        return {
            workspaceRoot: root,
            envFileMissing,
            missingEnvKeys,
            hasPackageJson,
            dependenciesInstalled,
            missingDependencies,
            dependencyState,
            issues,
            clean: issues.length === 0
        };
    }

    private findEnvBaseline(root: string): string | null {
        for (const name of [".env.example", ".env.template"]) {
            const candidate = path.join(root, name);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    private parseEnvKeys(filePath: string): Set<string> {
        const keys = new Set<string>();
        let content = "";
        try {
            content = fs.readFileSync(filePath, "utf-8");
        } catch {
            return keys;
        }
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) {
                continue;
            }
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx === -1) {
                continue;
            }
            const key = trimmed.slice(0, eqIdx).trim();
            if (key) {
                keys.add(key);
            }
        }
        return keys;
    }

    private findMissingDependencies(root: string, packageJsonPath: string): string[] {
        let pkg: Record<string, unknown>;
        try {
            pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as Record<string, unknown>;
        } catch {
            return [];
        }

        const dependencyGroups = [pkg["dependencies"], pkg["devDependencies"], pkg["peerDependencies"]]
            .filter((group): group is Record<string, unknown> =>
                typeof group === "object" && group !== null);

        const names = new Set<string>();
        for (const group of dependencyGroups) {
            for (const name of Object.keys(group)) {
                names.add(name);
            }
        }

        if (names.size === 0) {
            return [];
        }

        const missing: string[] = [];
        for (const name of names) {
            const entry = name.startsWith("@") ? name : name.split("/")[0];
            if (!this.directoryExists(path.join(root, "node_modules", entry))) {
                missing.push(name);
            }
        }
        return missing;
    }

    private directoryExists(dirPath: string): boolean {
        try {
            return fs.statSync(dirPath).isDirectory();
        } catch {
            return false;
        }
    }
}
