import * as assert from 'assert';
import * as net from 'net';
import { WebSocketServer } from 'ws';
import {
    AUTHORITATIVE_ROBOT_PORT,
    getBoundRobotPort,
    probeBrainServer,
    startRobotServer,
} from '../../utils/websocketServer';

/**
 * Startup lifecycle regressions for the port-8055 incident.
 *
 * A second Ace.X activation (second window, or main window plus Extension
 * Development Host) finds 8055 already held — usually by the FIRST Brain's
 * own extension-host process. Blaming that PID and telling the user to kill
 * it would destroy the healthy Brain. These tests pin the fixed behavior:
 * idempotent restarts, handshake-proven reuse of a healthy Brain, a clear
 * failure for foreign occupants, and owned state left intact throughout.
 *
 * All conflict tests use test-only ports so the extension's own 8055 server
 * in this host is never disturbed. `stopRobotServer` is deliberately never
 * called here: it would close the extension's live server.
 */

const STUB_BRAIN_PORT = 18055;
const FOREIGN_PORT = 18056;
const CLOSED_PORT = 18057;

/** A minimal stub that answers exactly like the real Brain handshake. */
function startStubBrain(port: number): Promise<WebSocketServer> {
    return new Promise((resolve) => {
        const stub = new WebSocketServer({ port });
        stub.on('connection', (ws) => {
            ws.on('message', (raw) => {
                try {
                    const data = JSON.parse(raw.toString()) as Record<string, unknown>;
                    if (data.type === 'HELLO') {
                        ws.send(JSON.stringify({ type: 'BRAIN_READY', state: 'observing' }));
                        ws.send(JSON.stringify({ type: 'STATE_SYNC', payloads: [] }));
                    }
                } catch {
                    // The probe only sends HELLO; ignore anything else.
                }
            });
        });
        stub.on('listening', () => resolve(stub));
    });
}

function closeServer(server: WebSocketServer): Promise<void> {
    return new Promise((resolve) => {
        server.close(() => resolve());
    });
}

suite('Ace.X startup lifecycle (port 8055 regressions)', function () {
    this.timeout(10000);

    test('repeat start reuses the owned server instead of binding twice', async function () {
        if (getBoundRobotPort() !== AUTHORITATIVE_ROBOT_PORT) {
            this.skip();
            return;
        }
        const again = await startRobotServer(AUTHORITATIVE_ROBOT_PORT);
        assert.strictEqual(again.ok, true, 'repeat start must stay linked');
        assert.strictEqual(again.reused, true, 'repeat start must report reuse, not a fresh bind');
        assert.strictEqual(getBoundRobotPort(), AUTHORITATIVE_ROBOT_PORT, 'owned port must not move');
    });

    test('probe recognizes the healthy Brain handshake', async function () {
        if (getBoundRobotPort() !== AUTHORITATIVE_ROBOT_PORT) {
            this.skip();
            return;
        }
        assert.strictEqual(await probeBrainServer(AUTHORITATIVE_ROBOT_PORT), true);
    });

    test('probe rejects a port with nothing listening', async () => {
        assert.strictEqual(await probeBrainServer(CLOSED_PORT, 800), false);
    });

    test('a healthy existing Brain server is reused on conflict', async function () {
        const stub = await startStubBrain(STUB_BRAIN_PORT);
        try {
            const result = await startRobotServer(STUB_BRAIN_PORT);
            assert.strictEqual(result.ok, true, 'healthy occupant must be adopted, not blamed');
            assert.strictEqual(result.reused, true, 'adoption must report reuse');
            assert.strictEqual(
                getBoundRobotPort(),
                AUTHORITATIVE_ROBOT_PORT,
                'adopting a foreign port must not disturb the owned server handle'
            );
        } finally {
            await closeServer(stub);
        }
    });

    test('a foreign occupant fails clearly without adopting', async function () {
        // A plain TCP listener: connects fine, but never speaks the Brain protocol.
        const sockets = new Set<net.Socket>();
        const foreign = net.createServer((socket) => {
            sockets.add(socket);
            socket.on('close', () => { sockets.delete(socket); });
            socket.write('not-a-brain');
        });
        await new Promise<void>((resolve) => { foreign.listen(FOREIGN_PORT, () => resolve()); });
        try {
            const result = await startRobotServer(FOREIGN_PORT);
            assert.strictEqual(result.ok, false, 'foreign occupant must block startup');
            assert.strictEqual(result.port, FOREIGN_PORT);
            assert.strictEqual(
                getBoundRobotPort(),
                AUTHORITATIVE_ROBOT_PORT,
                'a failed bind must not disturb the owned server handle'
            );
        } finally {
            // The foreign stub never ends its side; destroy open sockets so
            // close() is not held open by a lingering connection.
            for (const socket of sockets) {
                try { socket.destroy(); } catch { /* already gone */ }
            }
            await new Promise<void>((resolve) => { foreign.close(() => resolve()); });
        }
    });
});
