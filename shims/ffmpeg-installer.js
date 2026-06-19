'use strict';

// Drop-in shim for `@ffmpeg-installer/ffmpeg`. node-shazam's to_pcm.cjs
// requires that module at load time to learn the bundled ffmpeg's path,
// then passes the path to fluent-ffmpeg. We exclude the real @ffmpeg-
// installer package from the build (saves ~62 MB of duplicate ffmpeg
// binary) and intercept the require with this shim that returns the
// path of OUR vendored ffmpeg instead — same shape the real package
// exports: `{ path, version, url }`.

const path = require('path');
const fs   = require('fs');

// Resolve our vendored ffmpeg for node-shazam. Phase 2b made the binary
// lazy-fetched into the WRITABLE userData/vendor (process.resourcesPath/vendor
// is read-only in installed apps), so prefer that location, then the legacy
// bundled spot, then the dev repo vendor/. Returns the first that exists; if
// none exist yet (binary not fetched) it returns the best-guess location so
// that once the identify-module fetch lands the binary, fluent-ffmpeg finds
// it without a restart.
function vendorFfmpegPath() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [];
  let packaged = false;
  try {
    const { app } = require('electron');
    packaged = !!(app && app.isPackaged);
    if (packaged) candidates.push(path.join(app.getPath('userData'), 'vendor', exe)); // lazy-fetched
  } catch { /* electron app not available — treat as dev */ }
  if (process.resourcesPath && /[\\/]resources([\\/]|$)/.test(process.resourcesPath)) {
    candidates.push(path.join(process.resourcesPath, 'vendor', exe));                 // bundled (legacy)
  }
  candidates.push(path.resolve(__dirname, '..', 'vendor', exe));                       // dev
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return candidates[0];
}

// Lazy getter: node-shazam reads `.path` at use time, so computing it on each
// access (rather than once at require) means a binary fetched AFTER this shim
// loaded is still picked up within the same session.
module.exports = {
  get path() { return vendorFfmpegPath(); },
  version: 'vendor',
  url: 'https://flux'
};
