const { WebSocketServer, WebSocket } = require('ws');

const AUTHORITATIVE_ROBOT_PORT = 8055;
const clients = new Set();

console.log('[TEST-BRAIN-SYNC] Starting SYNCHRONIZED test Brain on port', AUTHORITATIVE_ROBOT_PORT);

const server = new WebSocketServer({ port: AUTHORITATIVE_ROBOT_PORT });

server.on('listening', () => {
    console.log('[TEST-BRAIN-SYNC] Server listening on', AUTHORITATIVE_ROBOT_PORT);
});

server.on('error', (err) => {
    console.error('[TEST-BRAIN-SYNC] Server error:', err.message);
});

function sendToAll(payload) {
    const msg = JSON.stringify(payload);
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(msg);
            } catch (e) {
                console.error('[TEST-BRAIN-SYNC] Send failed:', e.message);
            }
        }
    }
}

function emitEmotion(emotion, options = {}) {
    const payload = { type: 'EMOTION', emotion };
    if (typeof options.intensity === 'number') payload.intensity = Math.max(0, Math.min(1, options.intensity));
    if (options.speech) payload.speech = options.speech;
    if (typeof options.duration === 'number' && options.duration > 0) payload.duration = Math.min(options.duration, 15000);
    sendToAll(payload);
    console.log(`[TEST-BRAIN] EMOTION: ${emotion}`, options);
}

function emitLifecycleState(state, requestId, detail) {
    sendToAll({ type: 'LIFECYCLE_STATE', state, requestId, detail });
    console.log(`[TEST-BRAIN] LIFECYCLE_STATE: ${state}`);
}

function sendCaption(text, mode = 'CAPTION', duration) {
    sendToAll({ type: 'CAPTION', text, mode, duration });
    console.log(`[TEST-BRAIN] CAPTION: ${text}`);
}

function sendAttentionTarget(targetType, options = {}) {
    sendToAll({ 
        type: 'ATTENTION_TARGET', 
        targetType,
        confidence: options.confidence ?? 0.7,
        strength: options.strength ?? 0.5,
        reason: options.reason ?? 'test',
        expiresAt: Date.now() + (options.duration ?? 10000)
    });
    console.log(`[TEST-BRAIN] ATTENTION_TARGET: ${targetType}`);
}

// Track if sequence has been started
let sequenceStarted = false;
let captureReady = false;

server.on('connection', (ws) => {
    console.log('[TEST-BRAIN] Client connected');
    clients.add(ws);

    // Send initial connection status
    ws.send(JSON.stringify({ type: 'CONNECTION_STATUS', status: 'CONNECTED' }));
    ws.send(JSON.stringify({ type: 'HOST_WINDOW_STATE', focused: true, minimized: false }));
    ws.send(JSON.stringify({ type: 'VOICE_STATE', enabled: false }));

    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw.toString());
            console.log('[TEST-BRAIN] Received:', data.type, data);

            if (data.type === 'HELLO') {
                console.log('[TEST-BRAIN] Body hello:', data.client, data.version);
                ws.send(JSON.stringify({ type: 'HELLO_ACK' }));
                
                // Send BRAIN_READY
                setTimeout(() => {
                    ws.send(JSON.stringify({ type: 'BRAIN_READY', state: 'observing' }));
                    console.log('[TEST-BRAIN] Sent BRAIN_READY');
                }, 100);
                
                // Send STATE_SYNC with initial IDLE state
                setTimeout(() => {
                    ws.send(JSON.stringify({
                        type: 'STATE_SYNC',
                        payloads: [
                            { type: 'EMOTION', emotion: 'IDLE', intensity: 0.5 },
                            { type: 'LIFECYCLE_STATE', state: 'IDLE' }
                        ]
                    }));
                    console.log('[TEST-BRAIN] Sent STATE_SYNC (IDLE)');
                }, 200);
                
                return;
            }

            // ===== SYNCHRONIZATION SIGNALS =====
            if (data.type === 'RENDERER_READY') {
                console.log('[TEST-BRAIN] Received RENDERER_READY signal');
                return;
            }

            if (data.type === 'CAPTURE_READY') {
                console.log('[TEST-BRAIN] Received CAPTURE_READY signal - starting sequence');
                if (!sequenceStarted) {
                    sequenceStarted = true;
                    startInteractionSequence(ws);
                }
                return;
            }

            if (data.type === 'CHAT_MESSAGE') {
                console.log('[TEST-BRAIN] Chat message:', data.text);
                setTimeout(() => {
                    sendToAll(JSON.stringify({
                        type: 'EVE_RESPONSE',
                        kind: 'chat',
                        requestId: data.requestId,
                        status: 'complete',
                        text: `Echo: ${data.text}`
                    }));
                }, 500);
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

function startInteractionSequence(ws) {
    console.log('\n========== STARTING INTERACTION SEQUENCE ==========\n');
    
    // 1. INITIAL GREETING (after connection)
    setTimeout(() => {
        console.log('[SEQ] 1. GREETING - User connects, Eve acknowledges');
        emitEmotion('HAPPY', { intensity: 0.7, duration: 3000 });
        emitLifecycleState('SUCCESS');
        sendCaption('Hello! I\'m Eve, your coding companion.', 'CAPTION', 3000);
        sendAttentionTarget('cursor', { duration: 5000 });
    }, 2000);  // Delayed to allow capture to start
    
    // 2. USER SAYS HI (simulate chat message)
    setTimeout(() => {
        console.log('[SEQ] 2. USER GREETING - "Hi Eve"');
        emitEmotion('LISTENING', { intensity: 0.6, duration: 2000 });
        emitLifecycleState('LISTENING');
        sendCaption('Listening...', 'CAPTION', 2000);
        sendAttentionTarget('cursor', { duration: 3000 });
    }, 7000);
    
    // 3. THINKING (processing)
    setTimeout(() => {
        console.log('[SEQ] 3. THINKING - Processing user input');
        emitEmotion('THINKING', { intensity: 0.75, duration: 4000 });
        emitLifecycleState('THINKING');
        sendCaption('Thinking...', 'CAPTION', 4000);
    }, 10000);
    
    // 4. SPEAKING (responding)
    setTimeout(() => {
        console.log('[SEQ] 4. SPEAKING - Delivering response');
        emitEmotion('SPEAKING', { intensity: 0.9, duration: 5000, speech: 'Hello! How can I help you with your code today?' });
        emitLifecycleState('EXPLAINING');
        sendCaption('Hello! How can I help you with your code today?', 'CAPTION', 5000);
        sendAttentionTarget('cursor', { duration: 6000 });
    }, 17000);
    
    // 5. RETURN TO LISTENING
    setTimeout(() => {
        console.log('[SEQ] 5. RETURN TO LISTENING - Ready for next input');
        emitEmotion('LISTENING', { intensity: 0.5, duration: 3000 });
        emitLifecycleState('LISTENING');
        sendCaption('Ready to help!', 'CAPTION', 3000);
    }, 24000);
    
    // 7. DEEP THINKING (harder question)
    setTimeout(() => {
        console.log('[SEQ] 7. DEEP THINKING - Processing complex query');
        emitEmotion('THINKING', { intensity: 0.8, duration: 6000 });
        emitLifecycleState('THINKING');
        sendCaption('Analyzing your code...', 'CAPTION', 6000);
    }, 28000);
    
    // 8. EXPLAINING (detailed response)
    setTimeout(() => {
        console.log('[SEQ] 8. EXPLAINING - Detailed response');
        emitEmotion('SPEAKING', { intensity: 0.85, duration: 8000, speech: 'Here is my explanation with code examples...' });
        emitLifecycleState('EXPLAINING');
        sendCaption('Here is my explanation with code examples...', 'CAPTION', 8000);
        sendAttentionTarget('active-symbol', { duration: 10000 });
    }, 35000);
    
    // 9. SUCCESS (completed)
    setTimeout(() => {
        console.log('[SEQ] 9. SUCCESS - Response complete');
        emitEmotion('HAPPY', { intensity: 0.7, duration: 3500 });
        emitLifecycleState('SUCCESS');
        sendCaption('Done! Let me know if you need more help.', 'CAPTION', 3500);
    }, 44000);
    
    // 10. ERROR SCENARIO
    setTimeout(() => {
        console.log('[SEQ] 10. ERROR - Simulated failure');
        emitEmotion('ERROR', { intensity: 0.85, duration: 5000 });
        emitLifecycleState('FAILURE');
        sendCaption('Something went wrong. Let me try again.', 'CAPTION', 5000);
        sendAttentionTarget('error', { duration: 6000 });
    }, 49000);
    
    // 11. RECOVERY
    setTimeout(() => {
        console.log('[SEQ] 11. RECOVERY - Back to normal');
        emitEmotion('LISTENING', { intensity: 0.5, duration: 3000 });
        emitLifecycleState('LISTENING');
        sendCaption('Recovered. Ready to continue.', 'CAPTION', 3000);
    }, 55000);
    
    // 12. IDLE
    setTimeout(() => {
        console.log('[SEQ] 12. IDLE - Back to rest');
        emitEmotion('IDLE', { intensity: 0.5 });
        emitLifecycleState('IDLE');
        sendAttentionTarget('cursor', { duration: 10000 });
    }, 61000);
    
    console.log('\n========== INTERACTION SEQUENCE SCHEDULED ==========\n');
}

console.log('[TEST-BRAIN-SYNC] Ready. Launch robot-body Electron now.');
console.log('[TEST-BRAIN-SYNC] Press Ctrl+C to stop.');