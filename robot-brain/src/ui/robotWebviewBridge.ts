import * as vscode from 'vscode';
import type { WebviewIpcSensor } from '../sensors/webviewIpcSensor';
import { Logger } from '../utils/logger';

export type RobotViewInboundType =
    | 'ROBOT_READY'
    | 'ROBOT_RENDERED'
    | 'ROBOT_ERROR'
    | 'EXPLAIN_REQUEST'
    | 'FIX_REQUEST'
    | 'DISMISS';

export interface RobotRenderReport {
    surface: string;
    meshes: number;
    materials: string[];
    animations: number;
    animationReady: boolean;
    faceRigReady: boolean;
    bbox: string;
}

export interface RobotViewHostHandlers {
    onReady(surface: string): void;
    onRendered(report: RobotRenderReport): void;
    onError(surface: string, error: string): void;
    onExplain(surface: string): void;
    onFix(surface: string, matter?: string): void;
    onDismiss(surface: string): void;
}

/**
 * Typed Brain ↔ Eve-Webview bridge over VS Code postMessage.
 *
 * Outbound Brain state travels as ROBOT_STATE / STATE_SYNC / SUSPEND / RESUME
 * messages; inbound view intents arrive as ROBOT_READY / EXPLAIN_REQUEST /
 * FIX_REQUEST / DISMISS. Every message in both directions is observed by the
 * WebviewIpcSensor — the transport owns delivery, the sensor owns observation.
 */
export class RobotWebviewBridge implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private disposed = false;

    constructor(
        private readonly webview: vscode.Webview,
        private readonly ipc: WebviewIpcSensor,
        private readonly handlers: RobotViewHostHandlers,
        private readonly surface: string
    ) {
        this.disposables.push(
            webview.onDidReceiveMessage((message) => {
                this.handleIncoming(message);
            })
        );
    }

    post(type: 'ROBOT_STATE' | 'STATE_SYNC' | 'SUSPEND' | 'RESUME', body?: Record<string, unknown>): void {
        if (this.disposed) {
            return;
        }
        void this.webview.postMessage({ type, surface: this.surface, ...(body ?? {}) });
        this.ipc.recordOutbound(type);
    }

    dispose(): void {
        this.disposed = true;
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private handleIncoming(message: unknown): void {
        if (!message || typeof message !== 'object') {
            return;
        }
        const record = message as Record<string, unknown>;
        if (typeof record['type'] !== 'string') {
            return;
        }
        try {
            this.ipc.recordInbound(record);
        } catch (err) {
            Logger.info('ROBOT VIEW', { Event: 'IPC observe failed', Error: String(err) });
        }
        switch (record['type'] as RobotViewInboundType) {
            case 'ROBOT_READY':
                this.handlers.onReady(this.surface);
                break;
            case 'ROBOT_RENDERED':
                this.handlers.onRendered({
                    surface: this.surface,
                    meshes: Number(record['meshes'] ?? 0),
                    materials: Array.isArray(record['materials']) ? (record['materials'] as string[]) : [],
                    animations: Number(record['animations'] ?? 0),
                    animationReady: record['animationReady'] === true,
                    faceRigReady: record['faceRigReady'] === true,
                    bbox: String(record['bbox'] ?? ''),
                });
                break;
            case 'ROBOT_ERROR':
                this.handlers.onError(this.surface, String(record['error'] ?? 'unknown view error'));
                Logger.info('ROBOT VIEW', { Event: 'Eve render error', Surface: this.surface, Error: String(record['error'] ?? '') });
                break;
            case 'EXPLAIN_REQUEST':
                this.handlers.onExplain(this.surface);
                break;
            case 'FIX_REQUEST':
                this.handlers.onFix(this.surface, typeof record['matter'] === 'string' ? String(record['matter']) : undefined);
                break;
            case 'DISMISS':
                this.handlers.onDismiss(this.surface);
                break;
            default:
                break;
        }
    }
}
