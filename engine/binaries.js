'use strict';

// engine/binaries.js — yt-dlp/ffmpeg path resolution + the single yt-dlp
// spawn point (TLS-trust env injection). Extracted verbatim from main.js
// (Phase C, 2026-08-23), except getYtDlpCaEnv(): the original read
// `app.getPath('userData')` directly (Electron-only) — swapped for
// `enginePaths.getPaths().userData`, which is the same value on desktop
// (paths.js is configured from that same `app.getPath('userData')` call)
// and works headless too.
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { spawn } = require('child_process');
const enginePaths = require('./paths');
const { log } = require('./log');
const { loadConfig } = require('./config');

// ─── YT-DLP PATH (bundled — no runtime download) ─────────────────────────────
// yt-dlp is bundled at build time via:
//   - package.json `extraResources`  → resources/vendor/yt-dlp.exe
//   - package.json `asarUnpack`      → resources/app.asar.unpacked/vendor/yt-dlp.exe
// Both paths are checked at runtime as defense in depth.
function getYtDlpPath() {
  const { vendorDir, isPackaged, resourcesDir } = enginePaths.getPaths();
  const bin = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  if (isPackaged) {
    const candidates = [
      path.join(vendorDir, bin),                                       // lazy-fetched (userData/vendor)
      ...(resourcesDir ? [
        path.join(resourcesDir, 'vendor', bin),                        // bundled (legacy / non-slim builds)
        path.join(resourcesDir, 'app.asar.unpacked', 'vendor', bin),
        path.join(resourcesDir, bin),
      ] : []),
      path.join(path.dirname(process.execPath), 'vendor', bin),
      path.join(path.dirname(process.execPath), bin),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    log('WARN', `yt-dlp not present yet (lazy fetch pending). Searched: ${candidates.join(' | ')}`);
    return null;
  }
  const devBin = path.join(vendorDir, bin);
  return fs.existsSync(devBin) ? devBin : null;
}

// ffmpeg resolution: prefer the bundled vendor/ffmpeg (populated at build time
// by scripts/fetch-ffmpeg.js — BtbN for win/linux, evermeet.cx for darwin),
// fall back to whatever is in PATH. Used by XTRACT.
function getFfmpegPath() {
  const { vendorDir, isPackaged, resourcesDir } = enginePaths.getPaths();
  const bin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (isPackaged) {
    const candidates = [
      path.join(vendorDir, bin),                                       // lazy-fetched (userData/vendor)
      ...(resourcesDir ? [
        path.join(resourcesDir, 'vendor', bin),                        // bundled (legacy / non-slim builds)
        path.join(resourcesDir, 'app.asar.unpacked', 'vendor', bin),
      ] : []),
      path.join(path.dirname(process.execPath), 'vendor', bin)
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
  } else {
    const devBin = path.join(vendorDir, bin);
    if (fs.existsSync(devBin)) return devBin;
  }
  // Fall back to PATH — `ffmpeg` will be resolved by the shell.
  return bin;
}

// fpcalc (Chromaprint) resolution for AcoustID fingerprinting — same
// candidate-list shape as getYtDlpPath/getFfmpegPath above. Moved here from
// main.js (Fase G, Step 2) where it duplicated this exact pattern using raw
// `app.isPackaged`/`process.resourcesPath` instead of `enginePaths.getPaths()`
// — that was the only reason it wasn't already portable, not a real
// per-platform difference (server.js has no asar/resourcesPath concept, so
// its candidate list is just the single vendorDir entry, same as dev mode).
function getFpcalcPath() {
  const { vendorDir, isPackaged, resourcesDir } = enginePaths.getPaths();
  const bin = process.platform === 'win32' ? 'fpcalc.exe' : 'fpcalc';
  if (isPackaged) {
    const candidates = [
      path.join(vendorDir, bin),
      ...(resourcesDir ? [
        path.join(resourcesDir, 'vendor', bin),
        path.join(resourcesDir, 'app.asar.unpacked', 'vendor', bin),
      ] : []),
      path.join(path.dirname(process.execPath), 'vendor', bin),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return null;
  }
  const devBin = path.join(vendorDir, bin);
  return fs.existsSync(devBin) ? devBin : null;
}

// yt-dlp postprocessing (audio extraction, video+audio merge) needs BOTH
// ffmpeg AND ffprobe — passing the directory containing them via
// --ffmpeg-location lets yt-dlp discover both. Returns null if we don't
// have a bundled ffmpeg (then yt-dlp falls back to its PATH lookup, which
// is what produces the "ffprobe and ffmpeg not found" error in packaged
// builds where the user has no system-wide ffmpeg).
function getFfmpegDir() {
  const ff = getFfmpegPath();
  if (!ff || !path.isAbsolute(ff)) return null;
  return path.dirname(ff);
}

// Compose the yt-dlp --proxy argument value from current config, or null
// if proxy is disabled. socks5h:// resolves DNS server-side (privacy +
// makes .onion hostnames work via Tor).
function getYtDlpProxyArg() {
  const cfg = loadConfig();
  if (!cfg.socks_enabled || !cfg.socks_host) return null;
  const auth = (cfg.socks_user || cfg.socks_pass)
    ? `${encodeURIComponent(cfg.socks_user || '')}:${encodeURIComponent(cfg.socks_pass || '')}@`
    : '';
  return `socks5h://${auth}${cfg.socks_host}:${cfg.socks_port || 1080}`;
}

// ─── YT-DLP TLS TRUST (system certificate store) ─────────────────────────────
// yt-dlp's bundled Python trusts only its embedded certifi CA list, and its
// curl-impersonation transport only the CA bundle curl ships with. Behind
// TLS-intercepting software (corporate proxies, antivirus HTTPS scanning —
// e.g. Avast's Web Shield re-signs every connection with its own root) both
// reject the re-signed chain and EVERY yt-dlp request dies with
// CERTIFICATE_VERIFY_FAILED, while the rest of FLUX works because Electron
// net uses the OS store (same rationale as httpGetStream). Two-part fix,
// applied to every spawn via spawnYtDlp():
//   1. `--compat-options no-certifi` → the Python transport loads the OS
//      certificate store instead of certifi;
//   2. CURL_CA_BUNDLE (+ SSL_CERT_FILE for good measure) points at a PEM we
//      export from the OS store at first use (tls.getCACertificates('system'),
//      feature-detected) — the curl transport has no OS-store mode and needs
//      the file. Both verified live behind an Avast-intercepted network.
let ytDlpCaEnv; // undefined = not built yet, null = unavailable on this runtime
function getYtDlpCaEnv() {
  if (ytDlpCaEnv !== undefined) return ytDlpCaEnv;
  ytDlpCaEnv = null;
  try {
    const system = typeof tls.getCACertificates === 'function' ? tls.getCACertificates('system') : [];
    if (system.length) {
      const pem = path.join(enginePaths.getPaths().userData, 'ca-bundle.pem');
      fs.writeFileSync(pem, [...system, ...tls.rootCertificates].join('\n'));
      ytDlpCaEnv = { SSL_CERT_FILE: pem, REQUESTS_CA_BUNDLE: pem, CURL_CA_BUNDLE: pem };
      log('INFO', `yt-dlp CA bundle: ${system.length} system + ${tls.rootCertificates.length} bundled certs → ${pem}`);
    }
  } catch (e) {
    log('WARN', `yt-dlp CA bundle export failed (python transport still uses OS store via no-certifi): ${e.message}`);
  }
  return ytDlpCaEnv;
}

// Single spawn point for yt-dlp so the TLS-trust setup above cannot be
// forgotten on a new call site.
function spawnYtDlp(ytdlp, args, opts = {}) {
  const caEnv = getYtDlpCaEnv();
  return spawn(ytdlp, ['--compat-options', 'no-certifi', ...args], {
    shell: false,
    ...opts,
    ...(caEnv ? { env: { ...process.env, ...caEnv } } : {})
  });
}

module.exports = {
  getYtDlpPath, getFfmpegPath, getFfmpegDir, getFpcalcPath,
  getYtDlpProxyArg, getYtDlpCaEnv, spawnYtDlp,
};
