import { WebSocketServer, WebSocket } from 'ws';
import { execFile } from 'child_process';
import { Logger } from './logger';
import type {
    RobotCommand,
    WindowAnchorPayload,
    WindowVisibilityPayload,
    RobotStateUpdatePayload,
    EmotionPayload,
    AttentionTargetPayload,
    TeachingStatePayload,
    CaptionPayload,
    StruggleStatePayload,
    HostWindowStatePayload,
    RobotPayload,
    BrainReadyPayload,
    BrainStateSyncPayload,
} from '../core/types';

export type { RobotPayload } from '../core/types';

const clients: Set<WebSocket> = new Set();
let server: WebSocketServer | null = null;
let messageCallback: ((data: Record<string, unknown>) => void) | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let boundPort: number | null = null;
let voiceStateGetter: (() => boolean) | null = null;

// Default getter that reads from VS Code workspace config (works before pipeline init)
function getDefaultVoiceState(): boolean {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const vscode: { workspace: { getConfiguration: (section: string) => { get: <T>(key: string, fallback: T) => T } } } = require('vscode');
        return vscode.workspace.getConfiguration('botx').get<boolean>('enableVoice', false);
    } catch {
        return false;
    }
}

const HEARTBEAT_INTERVAL_MS = 30000;
const ACTION_COOLDOWN_MS = 3000;
let lastActionTime = 0;

/**
 * Register a callback to get the current voice state. Called when a new Body connects.
 */
export function setVoiceStateGetter(getter: (() => boolean) | null): void {
    voiceStateGetter = getter;
}

/** Outcome of binding the ONE authoritative port. */
export interface RobotServerStart {
    ok: boolean;
    port: number;
    /** "PID 1234 (BotX Companion.exe)" when the owner could be identified. */
    owner?: string;
    /**
     * True when no new socket was bound: either this process already owns the
     * server (idempotent repeat call) or a healthy Brain was found on the
     * port and adopted. Adopted links own no socket — disposal is a no-op.
     */
    reused?: boolean;
}

/** The port is a contract, not a preference. One value, defined once. */
export const AUTHORITATIVE_ROBOT_PORT = 8055;

/**
 * Identifies who is holding a TCP port, best effort.
 *
 * Used only to make a startup failure actionable. It never decides anything and
 * never retries: if the lookup fails the port is still reported as unavailable.
 */
function findPortOwner(port: number): Promise<string | undefined> {
    return new Promise((resolve) => {
        const command = process.platform === 'win32' ? 'netstat' : 'lsof';
        const args = process.platform === 'win32'
            ? ['-ano', '-p', 'tcp']
            : ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'];

        execFile(command, args, { timeout: 4000, windowsHide: true }, (err, stdout) => {
            if (err || !stdout) {
                resolve(undefined);
                return;
            }
            const pid = process.platform === 'win32'
                ? parseWindowsOwner(stdout, port)
                : parseLsofOwner(stdout, port);
            if (!pid) {
                resolve(undefined);
                return;
            }
            resolve(`PID ${pid}`);
        });
    });
}

/** netstat rows look like: "  TCP  0.0.0.0:8055  0.0.0.0:0  LISTENING  1234". */
function parseWindowsOwner(netstatOutput: string, port: number): string | undefined {
    const pattern = new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i');
    for (const line of netstatOutput.split(/\r?\n/)) {
        const match = pattern.exec(line);
        if (match) {
            return match[1];
        }
    }
    return undefined;
}

/** lsof rows look like: "COMMAND PID USER ... TCP 127.0.0.1:8055 (LISTEN)". */
function parseLsofOwner(lsofOutput: string, port: number): string | undefined {
    const pattern = new RegExp(`^\\S+\\s+(\\d+)\\s+\\S+\\s+\\S+\\s+TCP\\s+\\S*:${port}\\b`, 'm');
    const match = pattern.exec(lsofOutput);
    return match ? match[1] : undefined;
}

/**
 * Logs the three lines that make a blocked startup actionable, then returns the
 * owner description so the caller can surface it in the UI as well.
 */
async function reportPortBlocked(port: number): Promise<string | undefined> {
    const owner = await findPortOwner(port);
    console.log(`[COMMUNICATION] Port ${port} unavailable`);
    console.log(owner ? `[COMMUNICATION] Owner PID=${owner.replace('PID ', '')}` : '[COMMUNICATION] Owner PID=unknown');
    console.log('[COMMUNICATION] BotX startup blocked');
    Logger.info('WEBSOCKET', {
        Event: 'Port unavailable — startup blocked',
        Port: String(port),
        Owner: owner ?? 'unknown',
    });
    return owner;
}

/** How long the startup probe waits for a Brain handshake before giving up. */
const PROBE_TIMEOUT_MS = 2500;

/**
 * Asks whoever listens on `port` to prove it is a BotX Brain, using the real
 * protocol: HELLO must be answered with BRAIN_READY plus STATE_SYNC.
 *
 * A successful TCP connect proves nothing — only the handshake does. The
 * probe never sends anything but HELLO, never registers a message callback,
 * and always closes its socket. Used on EADDRINUSE so a second Ace.X
 * window/host reuses a healthy first Brain instead of blaming its process.
 */
export function probeBrainServer(port: number, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        let socket: WebSocket | null = null;
        const finish = (healthy: boolean): void => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            if (socket) {
                const doomed = socket;
                socket = null;
                try { doomed.removeAllListeners(); } catch { /* already gone */ }
                try { doomed.terminate(); } catch { /* already gone */ }
            }
            resolve(healthy);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        let sawReady = false;
        let sawSync = false;
        try {
            socket = new WebSocket(`ws://127.0.0.1:${port}`);
        } catch {
            finish(false);
            return;
        }
        socket.on('open', () => {
            try {
                socket?.send(JSON.stringify({ type: 'HELLO', client: 'ace-x-startup-probe', version: '1.0' }));
            } catch {
                finish(false);
            }
        });
        socket.on('message', (raw) => {
            try {
                const data = JSON.parse(raw.toString()) as Record<string, unknown>;
                if (data.type === 'BRAIN_READY') { sawReady = true; }
                if (data.type === 'STATE_SYNC') { sawSync = true; }
                if (sawReady && sawSync) { finish(true); }
            } catch {
                // Malformed frames prove nothing either way; keep waiting.
            }
        });
        // `error` alone settles nothing (a close always follows a refused or
        // non-WebSocket endpoint); `close` without a proven handshake is fatal.
        // The listener itself is mandatory: without it, `ws` rethrows the
        // error as uncaught and can fail an unrelated running test.
        socket.on('error', () => { /* settled on close */ });
        socket.on('close', () => finish(false));
    });
}

/**
 * Binds the ONE authoritative port. There is no fallback port and no retry.
 *
 * Silently moving to another port was actively dangerous: the Robot Body is
 * launched with a fixed port, so a Brain on 8056 and a Body on 8055 look healthy
 * while never connecting. A conflict is now a loud, early startup failure —
 * unless the occupant proves to be a healthy Brain (see the EADDRINUSE path),
 * in which case it is reused instead of fought.
 *
 * Ownership rule: the module-level `server` handle is assigned ONLY on a
 * successful bind. A failed bind never disturbs the owned handle, so a
 * conflicting second start cannot orphan a live server.
 */
function bindOnce(port: number): Promise<RobotServerStart> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result: RobotServerStart): void => {
            if (settled) { return; }
            settled = true;
            resolve(result);
        };

        let candidate: WebSocketServer;
        try {
            candidate = new WebSocketServer({ port });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.info('WEBSOCKET', { Event: 'Server error', Error: message });
            // The constructor never assigned `server`, so owned state is intact.
            void reportPortBlocked(port).then((owner) => finish({ ok: false, port, owner }));
            return;
        }

        candidate.on('connection', (ws) => {
        clients.add(ws);
        (ws as any).isAlive = true;
        Logger.info('WEBSOCKET', { Event: 'Client connected', Total: String(clients.size) });

        const connectMsg = JSON.stringify({ type: "CONNECTION_STATUS", status: "CONNECTED" });
        try {
            ws.send(connectMsg);
        } catch (err) {
            Logger.info("WEBSOCKET", { Event: "Failed to send CONNECTION_STATUS", Error: String(err) });
        }

        // Send initial host window state as UNKNOWN (null) so the Body shows by default.
        // The Brain will update with real state once VS Code window tracking is established.
        // Sending a potentially wrong focused/minimized value here caused the Body to
        // hide immediately after showing (e.g., when the Extension Development Host
        // reports focused=false even though VS Code is visible).
        const initialHostState = JSON.stringify({ type: 'HOST_WINDOW_STATE', focused: null, minimized: null });
        try {
            ws.send(initialHostState);
            Logger.info('WEBSOCKET', { Event: 'Sent initial HOST_WINDOW_STATE (unknown) to new client' });
        } catch (e) {
            Logger.info('WEBSOCKET', { Event: 'Could not send initial host state', Error: String(e) });
        }

        // Send current voice state so the Body initializes with the correct setting.
        // Use custom getter if available, otherwise fall back to workspace config.
        const voiceEnabled = voiceStateGetter ? voiceStateGetter() : getDefaultVoiceState();
        try {
            const voiceStateMsg = JSON.stringify({ type: 'VOICE_STATE', enabled: voiceEnabled });
            ws.send(voiceStateMsg);
            Logger.info('WEBSOCKET', { Event: 'Sent initial VOICE_STATE to new client', Enabled: String(voiceEnabled) });
        } catch (e) {
            Logger.info('WEBSOCKET', { Event: 'Could not send initial voice state', Error: String(e) });
        }

        // No backlog is replayed on connect: the queue that used to flush here
        // was the way stale captions/attention frames came back to life after a
        // reconnect. The Brain's state is event-driven and self-expiring, so a
        // fresh connection simply receives the next state it is told about.

        ws.on('message', (raw) => {
            try {
                const data = JSON.parse(raw.toString()) as Record<string, unknown>;
                // Link-level handshake, answered on this socket before anything
                // else touches the message. Never counted as user input.
                if (data.type === 'HELLO') {
                    Logger.info('WEBSOCKET', {
                        Event: 'Body hello',
                        Client: String(data.client ?? 'unknown'),
                        Version: String(data.version ?? 'unknown'),
                    });
                    answerHandshake(ws);
                    return;
                }
                if (messageCallback) {
                    messageCallback(data);
                }
            } catch {
                Logger.info('WEBSOCKET', { Event: 'Invalid message received' });
            }
        });

        ws.on('pong', () => {
            (ws as any).isAlive = true;
        });

        ws.on('close', () => {
            clients.delete(ws);
            Logger.info('WEBSOCKET', { Event: 'Client disconnected', Total: String(clients.size) });
        });

        ws.on('error', (err) => {
            Logger.info('WEBSOCKET', { Event: 'Client error', Error: String(err) });
            clients.delete(ws);
        });
    });

    candidate.on('listening', () => {
        // Ownership is taken ONLY here, on a proven bind. Until this line the
        // module handle still points at any previously owned server (or null).
        server = candidate;
        boundPort = port;
        Logger.info('WEBSOCKET', { Event: 'Server started', Port: String(port) });
        console.log(`[COMMUNICATION] Brain server listening on ${port}`);
        heartbeatTimer = setInterval(() => {
            for (const client of clients) {
                if ((client as any).isAlive === false) {
                    clients.delete(client);
                    client.terminate();
                    Logger.info('WEBSOCKET', { Event: 'Client terminated (no pong)' });
                    continue;
                }
                (client as any).isAlive = false;
                client.ping();
            }
        }, HEARTBEAT_INTERVAL_MS);
        finish({ ok: true, port });
    });

    candidate.on('error', (err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        const code = (err as NodeJS.ErrnoException).code;
        Logger.info('WEBSOCKET', { Event: 'Server error', Error: errMsg });

        if (code === 'EADDRINUSE') {
            // The one authoritative port is taken. Close the failed candidate
            // WITHOUT touching the owned handle, then ask the occupant to
            // prove it is a Brain before deciding anything.
            try { candidate.close(); } catch { /* already failed */ }
            void (async () => {
                const owner = await findPortOwner(port);
                if (await probeBrainServer(port)) {
                    // Healthy Brain already serves this port (typically a first
                    // Ace.X window/extension host). Adopt it: no second server,
                    // no second Eve, no killed processes. The Body's
                    // single-instance lock focuses the existing Eve.
                    Logger.info('WEBSOCKET', {
                        Event: 'Reusing healthy Brain server on port',
                        Port: String(port),
                        Owner: owner ?? 'unknown',
                    });
                    finish({ ok: true, port, reused: true, owner });
                    return;
                }
                // A foreign occupant: stay silent and block startup — never
                // move the Brain somewhere the Body is not looking.
                const reported = await reportPortBlocked(port);
                finish({ ok: false, port, owner: reported ?? owner });
            })();
            return;
        }

        console.log(`[COMMUNICATION] WebSocket Server error on port ${port}: ${errMsg}`);
        console.log('[COMMUNICATION] BotX startup blocked');
        try { candidate.close(); } catch { /* already failed */ }
        finish({ ok: false, port });
    });
    });
}

/**
 * Starts the Robot communication server on the single authoritative port.
 *
 * Idempotent within one Brain lifecycle: a repeat call while this process
 * already owns the server reuses it (`reused: true`) instead of binding
 * against itself. Resolves `ok: false` only when the port is held by a
 * foreign occupant — callers MUST NOT continue as if the link were healthy.
 */
export function startRobotServer(port: number = AUTHORITATIVE_ROBOT_PORT): Promise<RobotServerStart> {
    if (server !== null && boundPort === port) {
        return Promise.resolve({ ok: true, port, reused: true });
    }
    return bindOnce(port);
}

/** The port this Brain is actually listening on, or null when it is not up. */
export function getBoundRobotPort(): number | null {
    return boundPort;
}

export function onRobotMessage(callback: (data: Record<string, unknown>) => void): void {
    messageCallback = callback;
}

export type StateSnapshotProvider = () => RobotPayload[];
let stateSnapshotProvider: StateSnapshotProvider | null = null;

/**
 * Supplies the current canonical frames for the STATE_SYNC handshake. Read
 * live at handshake time so a reconnecting Eve receives present state, never
 * a replay of stale motion.
 */
export function setStateSnapshotProvider(provider: StateSnapshotProvider | null): void {
    stateSnapshotProvider = provider;
}

/**
 * Answers the floating-body handshake on the socket that asked: BRAIN_READY
 * plus one STATE_SYNC carrying the current canonical frames.
 */
function answerHandshake(ws: WebSocket): void {
    const ready: BrainReadyPayload = { type: 'BRAIN_READY', state: 'observing' };
    const sync: BrainStateSyncPayload = { type: 'STATE_SYNC', payloads: stateSnapshotProvider?.() ?? [] };
    for (const frame of [ready, sync]) {
        try {
            ws.send(JSON.stringify(frame));
        } catch (err) {
            Logger.info('WEBSOCKET', { Event: 'Handshake send failed', Error: String(err) });
            return;
        }
    }
    Logger.info('WEBSOCKET', {
        Event: 'Handshake answered',
        SyncFrames: String(sync.payloads.length),
    });
}

/**
 * ONE canonical Brain→consumer frame hook.
 *
 * `sendToRobot` is the single point every Brain frame leaves through, so a
 * listener here sees exactly the frames the Robot Body sees — EMOTION, CAPTION,
 * TEACHING_STATE, STRUGGLE_STATE, ATTENTION_TARGET — with no second copy of any
 * decision. Consumers (the BotX panel) mirror this stream; they never produce
 * it.
 */
export type BrainFrameListener = (payload: RobotPayload) => void;

const frameListeners: Set<BrainFrameListener> = new Set();

export function onBrainFrame(listener: BrainFrameListener): () => void {
    frameListeners.add(listener);
    return () => {
        frameListeners.delete(listener);
    };
}

/** Whether a Robot Body is currently attached. Read-only, for status display. */
export function hasRobotClients(): boolean {
    return clients.size > 0;
}

/** How many Robot Body clients are currently attached. */
export function robotClientCount(): number {
    return clients.size;
}

export function sendToRobot(payload: RobotPayload): void {
    // Listeners are notified BEFORE any WebSocket delivery decision: a frame is
    // meaningful Brain state even when no Body is attached, and dropping it
    // because the robot window happens to be closed would make the state
    // depend on the robot being visible.
    for (const listener of frameListeners) {
        try {
            listener(payload);
        } catch (err) {
            Logger.info('WEBSOCKET', { Event: 'Frame listener failed', Error: String(err) });
        }
    }

    if (payload.type === 'ACTION') {
        const now = Date.now();
        if (now - lastActionTime < ACTION_COOLDOWN_MS) {
            Logger.info("WEBSOCKET", { Event: "ACTION rate-limited", CooldownMs: String(ACTION_COOLDOWN_MS - (now - lastActionTime)) });
            return;
        }
        lastActionTime = now;
    }

    const message = JSON.stringify(payload);
    if (clients.size === 0) {
        // Transient state is dropped, never buffered. Queuing EMOTION/CAPTION/
        // ATTENTION_TARGET while nobody is listening would replay expired
        // content to the next client that connects.
        Logger.info("WEBSOCKET", { Event: "No clients — message dropped (state is not queued)", Type: payload.type });
        return;
    }
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (err) {
                Logger.info("WEBSOCKET", {
                    Event: "Send failed",
                    Error: String(err)
                });
                clients.delete(client);
            }
        }
    }
}

/**
 * Stops the Robot communication server — but ONLY a server this process
 * bound itself. An adopted link (`reused: true`, owned by another Brain)
 * leaves `server` null, so disposal here closes nothing foreign: closing
 * Eve's real Brain from a second window would drop the healthy Body.
 * Per-instance callback/timer state is always released.
 */
export function stopRobotServer(): void {
    messageCallback = null;
    frameListeners.clear();
    boundPort = null;
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (server) {
        for (const client of clients) {
            client.close();
        }
        clients.clear();
        server.close();
        server = null;
        Logger.info('WEBSOCKET', { Event: 'Server stopped' });
    }
}
