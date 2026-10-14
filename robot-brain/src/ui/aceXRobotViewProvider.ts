import * as vscode from 'vscode';
import type { WebviewIpcSensor } from '../sensors/webviewIpcSensor';
import type { RobotFrame } from './robotState';
import { RobotWebviewBridge, type RobotViewHostHandlers } from './robotWebviewBridge';
import { renderRobotHtml } from './robotHtml';
import { Logger } from '../utils/logger';

/**
 * Canonical Ace.X robot view provider.
 *
 * Exactly one Eve lives inside VS Code. The provider owns a single WebviewView
 * whose lifecycle is controlled by VS Code: switching editor tabs never
 * creates another window, and disposing the view stops updates. The view never
 * decides — it renders Brain state and posts intents back.
 */
export class AceXRobotViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'acex.robot';

    private view: vscode.WebviewView | undefined;
    private bridge: RobotWebviewBridge | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private suspended = false;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly ipc: WebviewIpcSensor,
        private readonly handlers: RobotViewHostHandlers
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media', 'robot')],
        };
        webviewView.webview.html = renderRobotHtml(webviewView.webview, this.extensionUri, 'view');
        this.bridge?.dispose();
        this.bridge = new RobotWebviewBridge(webviewView.webview, this.ipc, this.handlers, 'view');
        this.disposables.push(
            webviewView.onDidDispose(() => {
                this.bridge?.dispose();
                this.bridge = undefined;
                this.view = undefined;
            }),
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible && !this.suspended) {
                    this.handlers.onReady('view');
                }
            })
        );
        Logger.info('ROBOT VIEW', { Event: 'Canonical robot view resolved' });
    }

    postFrame(frame: RobotFrame): void {
        if (this.suspended || !this.view?.visible) {
            return;
        }
        this.bridge?.post('ROBOT_STATE', { state: frame.state, payload: frame.payload });
    }

    syncState(payloads: unknown[]): void {
        if (this.suspended || !this.view?.visible) {
            return;
        }
        this.bridge?.post('STATE_SYNC', { payloads });
    }

    suspend(): void {
        this.suspended = true;
        this.bridge?.post('SUSPEND');
    }

    resume(): void {
        this.suspended = false;
        this.bridge?.post('RESUME');
    }

    reveal(): void {
        void vscode.commands.executeCommand(`${AceXRobotViewProvider.viewType}.focus`);
    }

    dispose(): void {
        this.bridge?.dispose();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }
}
