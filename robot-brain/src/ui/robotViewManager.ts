import * as vscode from 'vscode';
import type { WebviewIpcSensor } from '../sensors/webviewIpcSensor';
import type { RobotFrame, RobotViewState } from './robotState';
import type { RobotStatePublisher } from './robotStatePublisher';
import { RobotWebviewBridge, type RobotViewHostHandlers } from './robotWebviewBridge';
import { AceXRobotViewProvider } from './aceXRobotViewProvider';
import { renderRobotHtml } from './robotHtml';
import { Logger } from '../utils/logger';

export interface RobotViewIntents {
    onExplain(surface: string): void;
    onFix(surface: string, matter?: string): void;
    onDismiss(surface: string): void;
}

type ActiveSurface = 'view' | 'panel';

/**
 * Owns the single active Eve surface.
 *
 * The canonical robot is the sidebar/panel WebviewView, which VS Code lets the
 * user move with native view placement. Opening Eve in an editor group creates
 * a WebviewPanel for the SAME Brain state — never a second robot: the manager
 * suspends whichever surface is inactive, so exactly one renderer is ever
 * live. Tab switches, file switches and reloads therefore cannot duplicate Eve.
 */
export class RobotViewManager implements vscode.Disposable {
    private readonly provider: AceXRobotViewProvider;
    private readonly disposables: vscode.Disposable[] = [];
    private panel: vscode.WebviewPanel | undefined;
    private panelBridge: RobotWebviewBridge | undefined;
    private active: ActiveSurface = 'view';
    private unsubscribeFrames: (() => void) | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly ipc: WebviewIpcSensor,
        private readonly publisher: RobotStatePublisher,
        private readonly intents: RobotViewIntents
    ) {
        const handlers: RobotViewHostHandlers = {
            onReady: (surface) => this.handleReady(surface),
            onRendered: (report) => this.handleRendered(report),
            onError: (surface, error) => this.handleViewError(surface, error),
            onExplain: (surface) => this.intents.onExplain(surface),
            onFix: (surface, matter) => this.intents.onFix(surface, matter),
            onDismiss: (surface) => this.intents.onDismiss(surface),
        };
        this.provider = new AceXRobotViewProvider(context.extensionUri, ipc, handlers);
        this.disposables.push(
            vscode.window.registerWebviewViewProvider(AceXRobotViewProvider.viewType, this.provider, {
                webviewOptions: { retainContextWhenHidden: true },
            })
        );
        this.unsubscribeFrames = publisher.subscribe((frame) => this.deliver(frame));
    }

    reveal(): void {
        if (this.active === 'panel' && this.panel) {
            this.panel.reveal();
            return;
        }
        this.provider.reveal();
    }

    openInEditor(): void {
        if (this.panel) {
            this.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'acex.robot.editor',
            'Ace.X Robot',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media', 'robot')],
            }
        );
        panel.webview.html = renderRobotHtml(panel.webview, this.context.extensionUri, 'panel');
        const handlers: RobotViewHostHandlers = {
            onReady: (surface) => this.handleReady(surface),
            onRendered: (report) => this.handleRendered(report),
            onError: (surface, error) => this.handleViewError(surface, error),
            onExplain: (surface) => this.intents.onExplain(surface),
            onFix: (surface, matter) => this.intents.onFix(surface, matter),
            onDismiss: (surface) => this.intents.onDismiss(surface),
        };
        this.panel = panel;
        this.panelBridge?.dispose();
        this.panelBridge = new RobotWebviewBridge(panel.webview, this.ipc, handlers, 'panel');
        this.active = 'panel';
        this.provider.suspend();
        panel.onDidDispose(
            () => {
                this.panelBridge?.dispose();
                this.panelBridge = undefined;
                this.panel = undefined;
                this.active = 'view';
                this.provider.resume();
                Logger.info('ROBOT VIEW', { Event: 'Editor surface closed — sidebar view resumed' });
            },
            undefined,
            this.disposables
        );
        Logger.info('ROBOT VIEW', { Event: 'Editor surface opened — sidebar view suspended' });
    }

    webviewHealth(): { inbound: number; outbound: number; lastOutboundAt: number } {
        const health = this.ipc.health();
        return { inbound: health.inbound, outbound: health.outbound, lastOutboundAt: health.lastOutboundAt };
    }

    dispose(): void {
        this.unsubscribeFrames?.();
        this.panelBridge?.dispose();
        this.provider.dispose();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private handleReady(surface: string): void {
        if (surface === 'panel' && this.active === 'panel') {
            this.publisher.setLink('connected');
            this.panelBridge?.post('STATE_SYNC', { payloads: this.publisher.latestPayloadTypes() });
            return;
        }
        if (surface === 'view' && this.active === 'view') {
            this.publisher.setLink('connected');
            this.provider.syncState(this.publisher.latestPayloadTypes());
        }
    }

    /**
     * Fires only when the view proves the Eve GLB is parsed, added to a live
     * Three.js scene and rigged — never on mere page boot. This is the host's
     * ground truth that Eve rendered rather than just loaded.
     */
    private handleRendered(report: { surface: string; meshes: number; materials: string[]; animations: number; animationReady: boolean; faceRigReady: boolean; bbox: string }): void {
        Logger.info('ROBOT VIEW', {
            Event: 'Eve rendered',
            Surface: report.surface,
            Meshes: String(report.meshes),
            Materials: report.materials.join(',') || 'none',
            Animations: String(report.animations),
            Motion: String(report.animationReady),
            FaceRig: String(report.faceRigReady),
            BBox: report.bbox,
        });
    }

    private handleViewError(surface: string, error: string): void {
        Logger.info('ROBOT VIEW', { Event: 'Eve view error (Brain unaffected)', Surface: surface, Error: error });
    }

    private deliver(frame: RobotFrame): void {
        try {
            if (this.active === 'panel' && this.panel) {
                this.panelBridge?.post('ROBOT_STATE', {
                    state: frame.state as unknown as Record<string, unknown>,
                    payload: frame.payload as unknown as Record<string, unknown>,
                });
                return;
            }
            this.provider.postFrame(frame);
        } catch (err) {
            // View delivery must never break the Brain: a rendering exception
            // stays inside the view layer and is logged once.
            Logger.info('ROBOT VIEW', { Event: 'Frame delivery failed safely', Error: String(err) });
        }
    }
}

export type { RobotViewState };
