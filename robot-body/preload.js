'use strict';

/**
 * preload — bridge between the Electron MAIN process (owns the WebSocket) and
 * the renderer page (owns Three.js + behaviour). Runs with contextIsolation
 * disabled, so window.brainAPI is directly visible to renderer.js modules.
 */

const { ipcRenderer } = require('electron');

window.brainAPI = {
  /** @param {(message: Record<string, unknown>) => void} cb */
  onMessage(cb) {
    ipcRenderer.on('brain:message', (_event, message) => cb(message));
  },
  /** @param {(status: 'connecting' | 'connected' | 'disconnected') => void} cb */
  onStatus(cb) {
    ipcRenderer.on('brain:status', (_event, status) => cb(status));
  },
  /** Send a message from renderer to Brain via main process */
  send(message) {
    ipcRenderer.send('brain:send', message);
  },
  /** @param {('mini' | 'full')} mode - request a window mode change (main owns the window) */
  setMode(mode) {
    ipcRenderer.send('eve:set-mode', mode);
  },
  /** @param {(mode: 'mini' | 'full') => void} cb - mode changes applied by the main process */
  onMode(cb) {
    ipcRenderer.on('eve:mode', (_event, mode) => cb(mode));
  },
};