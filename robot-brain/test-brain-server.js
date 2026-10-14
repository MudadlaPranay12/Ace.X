const { WebSocketServer, WebSocket } = require('ws');

const AUTHORITATIVE_ROBOT_PORT = 8055;
const clients = new Set();

console.log('[TEST-BRAIN] Starting test Brain WebSocket server on port', AUTHORITATIVE_ROBOT_PORT);

const server = new WebSocketServer({ port: AUTHORITATIVE_ROBOT_PORT });

server.on('listening', () => {
    console.log('[TEST-BRAIN] Server listening on', AUTHORITATIVE_ROBOT_PORT);
});

server.on('error', (err) => {
    console.error('[TEST-BRAIN] Server error:', err.message);
});

server.on('connection', (ws) => {
    console.log('[TEST-BRAIN] Client connected');
    clients.add(ws);

    // Send initial connection status
    ws.send(JSON.stringify({ type: 'CONNECTION_STATUS', status: 'CONNECTED' }));

    // Send initial host window state
    ws.send(JSON.stringify({ type: 'HOST_WINDOW_STATE', focused: true, minimized: false }));

    // Send voice state
    ws.send(JSON.stringify({ type: 'VOICE_STATE', enabled: false }));

    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw.toString());
            console.log('[TEST-BRAIN] Received:', data.type, data);

            if (data.type === 'HELLO') {
                console.log('[TEST-BRAIN] Body hello:', data.client, data.version);
                ws.send(JSON.stringify({ type: 'HELLO_ACK' }));
                
                // Send BRAIN_READY to trigger connected state in Body
                setTimeout(() => {
                    ws.send(JSON.stringify({ type: 'BRAIN_READY' }));
                    console.log('[TEST-BRAIN] Sent BRAIN_READY');
                }, 100);
                
                // Send STATE_SYNC with current canonical frames
                setTimeout(() => {
                    ws.send(JSON.stringify({
                        type: 'STATE_SYNC',
                        payloads: [
                            { type: 'CAPTION', text: 'Brain linked', holdMs: 0, mode: 'UI' },
                            { type: 'EMOTION', emotion: 'IDLE', intensity: 1 }
                        ]
                    }));
                    console.log('[TEST-BRAIN] Sent STATE_SYNC');
                }, 200);
                return;
            }

            if (data.type === 'CHAT_MESSAGE') {
                console.log('[TEST-BRAIN] Chat message:', data.text);
                setTimeout(() => {
                    ws.send(JSON.stringify({
                        type: 'EVE_RESPONSE',
                        kind: 'chat',
                        requestId: data.requestId,
                        status: 'complete',
                        text: `Echo: ${data.text}`
                    }));
                }, 500);
                return;
            }

            if (data.type === 'FIX_REQUEST') {
                console.log('[TEST-BRAIN] Fix request for:', data.matter);
                ws.send(JSON.stringify({
                    type: 'ISSUE_STATE',
                    state: {
                        visible: true,
                        matter: data.matter,
                        title: 'Fix Applied',
                        severity: 'SUCCESS',
                        message: 'The fix has been applied. Review the changes in VS Code.',
                        fixAvailable: false
                    }
                }));
                return;
            }

            if (data.type === 'EXPLAIN_REQUEST') {
                console.log('[TEST-BRAIN] Explain request for:', data.message);
                ws.send(JSON.stringify({
                    type: 'EVE_RESPONSE',
                    kind: 'explain',
                    requestId: data.requestId,
                    status: 'complete',
                    text: 'This is a test explanation from the Brain.'
                }));
                return;
            }

        } catch (err) {
            console.error('[TEST-BRAIN] Invalid message:', err.message);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        console.log('[TEST-BRAIN] Client disconnected');
    });

    ws.on('error', (err) => {
        console.error('[TEST-BRAIN] Client error:', err.message);
        clients.delete(ws);
    });
});

// Heartbeat
setInterval(() => {
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.ping();
        }
    }
}, 30000);

console.log('[TEST-BRAIN] Ready. Launch robot-body Electron now.');
console.log('[TEST-BRAIN] Press Ctrl+C to stop.');