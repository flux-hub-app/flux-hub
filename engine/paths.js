'use strict';

// engine/paths.js — the "where do I read/write state" seam. main.js's real
// path constants (USER_DATA, CONFIG_PATH, VENDOR_DIR, ...) are still computed
// and used exactly as before; the only change is that the two inputs they
// derive from (userData dir, download folder) are configured once through
// this module instead of being read straight off `app.getPath(...)` at
// require-time. A future server.js entry point calls configurePaths() with
// values from env vars (FLUX_DATA_DIR / FLUX_DOWNLOAD_DIR) instead of Electron
// APIs — main.js itself doesn't need to know which one supplied them.
let current = null;

// isPackaged/resourcesDir (Phase C, 2026-08-19): the other two Electron-derived
// inputs that binary-path resolution (engine/binaries.js) needs —
// `app.isPackaged` and `process.resourcesPath`. Desktop passes Electron's real
// values; server.js passes `isPackaged: true` (a server deployment is never
// "dev mode") and `resourcesDir: null` (no packaged-resources concept headless —
// binaries live under vendorDir only, same as dev today).
function configurePaths({ userData, vendorDir, downloadFolder, isPackaged = false, resourcesDir = null }) {
  current = { userData, vendorDir, downloadFolder, isPackaged, resourcesDir };
  return current;
}

function getPaths() {
  if (!current) throw new Error('engine/paths: configurePaths() not called yet');
  return current;
}

module.exports = { configurePaths, getPaths };
