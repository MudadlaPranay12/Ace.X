'use strict';

/**
 * wsClient — WebSocket client lifecycle for the BotX Body (Electron MAIN process).
 *
 * Connects to the BotX Brain (robot-brain) and guarantees:
 *   - automatic connect attempt at Electron startup (never blocks startup)
 *   - automatic retry while the Brain is unavailable (exponential backoff + jitter)
 *   - automatic reconnect after disconnection (Brain restart safe)
 *   - never more than ONE simultaneous connection
 *   - malformed messages are filtered by MessageParser and can never crash this client
 *
 * Emits:
 *   'status'  ( 'connecting' | 'connected' | 'disconnected' )
 *   'message' ( validated message object )
 *
 * Uses Node's built-in global WebSocket (Electron 44 / Node 24) — no npm dependency.
 */

const { EventEmitter } = require('events');
const { parseMessage } = require('./messageParser');

const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 15000;

function log(...args) {
  console.log('[BODY:WS]', ...args);
}

class BrainWSClient extends EventEmitter {
  /**
   * @param {{ url?: string, port?: number }} options
   */
  constructor(options = {}) {
    super();
    const port = options.port || Number(process.env.ROBOT_WS_PORT || 8055);
    this.url = options.url || `ws://localhost:${port}`;
    /** @type {WebSocket | null} */
    this.socket = null;
    /** @type {NodeJS.Timeout | null} */
    this.retryTimer = null;
    this.status = 'disconnected';
    this.retryAttempt = 0;
    this.stopped = false;
    this.connecting = false;
  }

  /** Current lifecycle status: 'connecting' | 'connected' | 'disconnected' */
  getStatus() {
    return this.status;
  }

  /** Begin connecting. Safe to call multiple times — never opens a second socket. */
  connect() {
    if (this.stopped) {
      return;
    }
    if (this.socket || this.connecting) {
      return; // single-connection guarantee
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    this.connecting = true;
    // Only surface 'connecting' on the very first attempt and after a real
    // disconnect cycle — retries stay visually 'disconnected' so the status
    // indicator does not flap every backoff attempt (spec §15).
    if (this.retryAttempt === 0) {
      this.setStatus('connecting');
    }
    log(`connecting to ${this.url} (attempt ${this.retryAttempt + 1})`);

    let socket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      this.connecting = false;
      log('failed to create WebSocket:', String(err));
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) {
        return; // stale socket — ignore
      }
      this.connecting = false;
      this.retryAttempt = 0;
      this.setStatus('connected');
      log(`connected to Brain at ${this.url}`);
      // Handshake: announce this body so the Brain answers with BRAIN_READY
      // plus a STATE_SYNC of its current canonical frames.
      try {
        socket.send(JSON.stringify({ type: 'HELLO', client: 'ace-x-electron-body', version: '1.0' }));
      } catch (err) {
        log('failed to send HELLO:', String(err));
      }
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket) {
        return;
      }
      try {
        const message = parseMessage(event.data);
        if (message) {
          this.emit('message', message);
        }
      } catch (err) {
        log('unexpected error while handling message:', String(err));
        // never crash the connection handler
      }
    };

    socket.onerror = () => {
      // 'close' always follows — reconnect logic lives there. Log only.
      if (this.socket === socket && this.status !== 'connected') {
        log('connection error (Brain not available yet)');
      }
    };

    socket.onclose = (event) => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      this.connecting = false;
      const wasConnected = this.status === 'connected';
      this.setStatus('disconnected');
      log(wasConnected
        ? `disconnected from Brain (code ${event && event.code})`
        : 'could not reach Brain');
      this.scheduleRetry();
    };
  }

  scheduleRetry() {
    if (this.stopped || this.retryTimer) {
      return;
    }
    const exp = Math.min(BASE_RETRY_MS * Math.pow(2, this.retryAttempt), MAX_RETRY_MS);
    const delay = exp + Math.floor(Math.random() * 400); // jitter
    this.retryAttempt++;
    log(`retrying in ${delay}ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  setStatus(status) {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.emit('status', status);
  }

  /** Stop all activity (called on app quit). */
  stop() {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.onclose = null;
        socket.close();
      } catch {
        /* already closing */
      }
    }
    this.setStatus('disconnected');
    log('client stopped');
  }
}

module.exports = { BrainWSClient };
