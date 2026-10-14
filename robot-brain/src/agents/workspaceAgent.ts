import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ObservationType } from '../perception/observationType';
import { clampConfidence, type AgentFinding, type AgentInput, type SpecializedAgent } from './agentFinding';

const MAX_MANIFEST_BYTES = 64 * 1024;

function readManifest(root: string, name: string): string | undefined {
    try {
        const file = path.join(root, name);
        const stats = fs.statSync(file);
        if (!stats.isFile() || stats.size > MAX_MANIFEST_BYTES) {
            return undefined;
        }
        return fs.readFileSync(file, 'utf-8');
    } catch {
        return undefined;
    }
}

/**
 * Workspace agent: folders, open files, dependencies, workspace/build config
 * and architecture clues. Reads are bounded and local; missing manifests are
 * reported as absent, never guessed.
 */
export class WorkspaceAgent implements SpecializedAgent {
    readonly name = 'workspace' as const;

    analyze(input: AgentInput): AgentFinding[] {
        const { observation, snapshot } = input;
        if (
            observation.type !== ObservationType.FILE_OPENED &&
            observation.type !== ObservationType.EDITOR_CHANGED &&
            observation.type !== ObservationType.CODING_INTENT &&
            observation.type !== ObservationType.SYSTEM_OUTPUT
        ) {
            return [];
        }

        const folders = vscode.workspace.workspaceFolders ?? [];
        const openFiles = vscode.workspace.textDocuments
            .filter((document) => document.uri.scheme === 'file')
            .map((document) => document.fileName)
            .slice(0, 25);
        const manifests: string[] = [];
        let packageScripts = 0;
        for (const folder of folders.slice(0, 5)) {
            const packageJson = readManifest(folder.uri.fsPath, 'package.json');
            if (packageJson) {
                manifests.push(`${folder.name}/package.json`);
                try {
                    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, unknown> };
                    packageScripts += Object.keys(parsed.scripts ?? {}).length;
                } catch {
                    // Malformed manifests are evidence themselves, but parsing is not required.
                }
            }
            for (const name of ['requirements.txt', 'go.mod', 'pom.xml', 'Cargo.toml']) {
                if (readManifest(folder.uri.fsPath, name)) {
                    manifests.push(`${folder.name}/${name}`);
                }
            }
        }

        return [
            {
                agent: this.name,
                scope: 'WORKSPACE',
                category: 'WORKSPACE_STATE',
                severity: 'INFO',
                confidence: clampConfidence(0.8),
                summary: `${folders.length} folder(s), ${openFiles.length} open file(s) tracked`,
                evidence: [
                    { kind: 'workspace', summary: folders.map((folder) => folder.name).join(', ') || 'no folder open' },
                    { kind: 'open-files', summary: openFiles.map((file) => file.split(/[\\/]/).pop() ?? file).join(', ') || 'none' },
                    { kind: 'manifests', summary: manifests.join(', ') || 'no dependency manifest found' },
                ],
                suggestedActions:
                    packageScripts > 0
                        ? [{ kind: 'OBSERVE', label: 'Use declared workspace scripts', reason: `${packageScripts} npm script(s) describe the supported workflow.` }]
                        : [{ kind: 'OBSERVE', label: 'No build script evidence yet', reason: 'Avoid assuming how this workspace builds.' }],
                learningSignals: [
                    {
                        domain: snapshot.workspace.language || 'general',
                        detail: `workspace with ${openFiles.length} open files`,
                    },
                ],
                context: {
                    file: snapshot.workspace.file || undefined,
                    language: snapshot.workspace.language,
                    branch: snapshot.identity.branchId,
                    projectId: snapshot.identity.projectId,
                },
            },
        ];
    }
}
