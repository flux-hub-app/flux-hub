'use strict';

// engine/host-desktop.js — the desktop implementation of engine/host.js's
// interface: thin passthrough to the Electron APIs main.js was already
// calling directly. Behavior is byte-identical to before the extraction —
// this file only moves where the calls live, it doesn't change what they do.
const { dialog, shell, Notification, clipboard } = require('electron');

// `getMainWindow` is a getter (not the window itself) because host wiring
// happens before `mainWindow` is assigned in main.js's boot sequence.
function createDesktopHost(getMainWindow) {
  return {
    showOpenDialog: (opts) => dialog.showOpenDialog(getMainWindow(), opts),
    showSaveDialog: (opts) => dialog.showSaveDialog(getMainWindow(), opts),

    notify: (title, body) => {
      if (!Notification.isSupported()) return false;
      new Notification({ title: String(title || 'FLUX'), body: String(body || '') }).show();
      return true;
    },

    clipboardWrite: (text) => {
      clipboard.writeText(String(text));
      return true;
    },

    openPath: (p) => shell.openPath(p),
    openExternal: (u) => shell.openExternal(u),
    revealInFolder: (p) => { shell.showItemInFolder(p); return true; },
    trashItem: (p) => shell.trashItem(p),
  };
}

module.exports = { createDesktopHost };
