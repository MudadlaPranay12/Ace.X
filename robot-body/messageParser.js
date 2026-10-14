'use strict';

/**
 * MessageParser — step 2 of the Body pipeline:
 *
 *   WebSocket → MessageParser → ActionMapper → BehaviourController → AnimationController → Three.js
 *
 * Runs in the Electron MAIN process (CommonJS). Its only job is to turn raw
 * WebSocket frames into a validated object safely: malformed JSON, non-object
 * payloads, and frames without a string `type` are dropped with a log line and
 * can never crash the connection handler.
 *
 * Well-formed messages with an unknown-but-string `type` are forwarded so the
 * protocol stays forward-compatible (the ActionMapper decides semantics).
 */

const MAX_MESSAGE_BYTES = 256 * 1024; // sanity cap — the Brain never sends anything near this

function log(...args) {
  console.log('[BODY:PARSER]', ...args);
}

/**
 * @param {unknown} raw - raw frame data (string expected from the Brain)
 * @returns {Record<string, unknown> | null} validated message or null when dropped
 */
function parseMessage(raw) {
  if (typeof raw !== 'string') {
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      try {
        raw = Buffer.from(raw).toString('utf8');
      } catch {
        log('dropped non-text binary frame');
        return null;
      }
    } else {
      log('dropped frame of unsupported type:', typeof raw);
      return null;
    }
  }

  if (raw.length === 0 || raw.length > MAX_MESSAGE_BYTES) {
    log(`dropped frame with invalid size (${raw.length} bytes)`);
    return null;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    log('dropped malformed JSON frame:', raw.slice(0, 120));
    return null;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    log('dropped non-object frame');
    return null;
  }

  if (typeof data.type !== 'string' || data.type.length === 0) {
    log('dropped frame without a string type field');
    return null;
  }

  return data;
}

module.exports = { parseMessage };
