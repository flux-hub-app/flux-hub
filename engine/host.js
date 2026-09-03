'use strict';

// engine/host.js — the "desktop-only capability" seam: native file/folder
// pickers, OS notifications, clipboard, shell integration. These have no
// headless equivalent by nature (there's no OS-level dialog to show inside a
// Docker container) — a future server host implements the same shape with
// web equivalents instead (showOpenDialog/showSaveDialog become a
// server-side directory browser endpoint; notify/openPath/clipboard become
// no-ops or are dropped from the API surface entirely for the server profile).
// main.js's IPC handlers call getHost().<fn>() instead of the Electron
// module directly, so they don't need to know which host is active.
let host = null;

function setHost(newHost) {
  host = newHost;
}

function getHost() {
  if (!host) throw new Error('engine/host: setHost() not called yet');
  return host;
}

module.exports = { setHost, getHost };
