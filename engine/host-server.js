'use strict';

// engine/host-server.js — the headless implementation of engine/host.js's
// interface for server.js. None of these have a meaningful headless
// equivalent (no OS-level dialog/clipboard/shell inside a Docker container,
// no desktop to notify) — honest no-ops that log instead of doing nothing
// silently, so a handler that still expects one of these to work is visible
// in the server log rather than failing mysteriously. showOpenDialog/
// showSaveDialog are used by main.js's file/folder pickers, which the server
// profile doesn't expose (paths come from config, not a native picker) —
// callers should not reach these in practice, but they fail loud rather than
// throw a raw "dialog is not a function".
const { log } = require('./log');

function createServerHost() {
  return {
    showOpenDialog: async () => { log('WARN', 'host-server: showOpenDialog has no headless equivalent'); return { canceled: true, filePaths: [] }; },
    showSaveDialog: async () => { log('WARN', 'host-server: showSaveDialog has no headless equivalent'); return { canceled: true, filePath: null }; },

    notify: (title, body) => { log('INFO', `host-server: notify "${title}" — ${body}`); return false; },

    clipboardWrite: (text) => { log('WARN', 'host-server: clipboardWrite has no headless equivalent'); return false; },

    openPath: async (p) => { log('WARN', `host-server: openPath(${p}) has no headless equivalent`); return 'not supported headless'; },
    openExternal: async (u) => { log('WARN', `host-server: openExternal(${u}) has no headless equivalent`); return false; },
    revealInFolder: (p) => { log('WARN', `host-server: revealInFolder(${p}) has no headless equivalent`); return false; },
    trashItem: async (p) => { log('WARN', `host-server: trashItem(${p}) has no headless equivalent — file left in place`); return false; },
  };
}

module.exports = { createServerHost };
