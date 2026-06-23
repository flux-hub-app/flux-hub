'use strict';

// Module-resolve intercept for `@ffmpeg-installer/ffmpeg`. We exclude that
// 62 MB package from the build (see package.json `files` exclusion) since
// we already bundle our own ffmpeg in vendor/. node-shazam's to_pcm.cjs
// hard-requires the package by name at load time, which would throw
// "Cannot find module" in the packaged app. Redirecting the resolution
// to our local shim returns the right shape (`{ path, version, url }`)
// pointing at our vendored binary.
const Module = require('module');
const _origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '@ffmpeg-installer/ffmpeg') {
    return require.resolve('./shims/ffmpeg-installer.js');
  }
  return _origResolve.call(this, request, parent, ...rest);
};

const { app, BrowserWindow, ipcMain, dialog, shell, Notification, clipboard, globalShortcut, nativeTheme, desktopCapturer } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { spawn, exec } = require('child_process');
const net = require('net');
const tls = require('tls');
const binaryFetcher = require('./binary-fetcher');

// Force the runtime app name to the slug "flux-hub" BEFORE any
// app.getPath('userData') call below. Electron derives userData from
// app.getName(); pinning it to the slug keeps config + the lazy-fetched
// vendor\ under %APPDATA%\flux-hub (display brand is "FLUX Hub" via
// build.productName; the build's clean-data wipe targets the same slug path).
app.setName('flux-hub');

// ─── PATHS ───────────────────────────────────────────────────────────────────
const USER_DATA     = app.getPath('userData');
const CONFIG_PATH   = path.join(USER_DATA, 'config.json');
const PROFILES_PATH = path.join(USER_DATA, 'profiles.json');
const QUEUE_PATH    = path.join(USER_DATA, 'queue.json');
const HISTORY_PATH  = path.join(USER_DATA, 'history.json');
const SCHEDULE_PATH = path.join(USER_DATA, 'schedule.json');
const LOG_PATH      = path.join(USER_DATA, 'flux.log');

// Runtime-writable vendor dir for the lazy binary fetcher (Phase 2b). In a
// packaged build, process.resourcesPath/vendor is READ-ONLY (Program Files on
// Windows, inside the signed .app bundle on macOS), so any binary downloaded
// on first module use must land in a writable location → userData/vendor.
// In dev the project-root vendor/ is writable and is what scripts/fetch-*.js
// (and the same runtime fetcher) populate. Every getXPath() resolver below
// checks this dir, so a fetched binary is picked up with no rebuild.
const VENDOR_DIR = app.isPackaged ? path.join(USER_DATA, 'vendor') : path.join(__dirname, 'vendor');

// Create userData dir on first launch BEFORE any log() call. On Windows portable,
// the wrapper extracts to a fresh temp dir each run but userData lives at AppData,
// which doesn't exist on a brand-new install — without this mkdir log() silently
// fails on first boot (the "missing first-boot log" issue).
try { fs.mkdirSync(USER_DATA, { recursive: true }); } catch {}
try { fs.mkdirSync(VENDOR_DIR, { recursive: true }); } catch {}

// ─── DEFAULT CONFIG ──────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  profile_name:    'Profilo 1',
  download_folder: path.join(app.getPath('downloads'), 'FLUX Hub'),
  max_results:     5,
  log_enabled:     true,
  tos_accepted:    false,
  lang:            'system',        // resolves to OS locale at first launch
  theme:           'dark',          // 'dark' | 'light' | 'auto' — dark on first launch
  concurrency:     1,               // parallel downloads (1-5)
  retry_count:     2,               // retry attempts on media download fail
  notify_on_done:  true,            // desktop notifications
  // MP4 compatibility mode: when ON (default), all yt-dlp MP4 downloads
  // prefer H.264 video + AAC audio. Trade-off: ~30% larger files than
  // VP9 / AV1 but the result plays natively in QuickTime, iMovie, iPhone
  // Photos, default Windows player, etc. When OFF, yt-dlp picks "best"
  // codec which on YouTube is usually VP9 (sub-optimal Mac compat but
  // smaller files). Defaults ON because cross-device playback matters
  // more than a few MB to most users.
  mp4_compat:      true,
  splash_audio:    true,            // play the boot jingle on the splash screen
  topbar_player_collapsed:  false,  // remember collapsed state of the topbar music card
  topbar_actions_collapsed: false,  // remember collapsed state of the topbar actions card
  history_enabled: true,
  auto_update:     false,           // off by default until GitHub repo is configured
  acoustid_key:    '',              // AcoustID API key — get free at https://acoustid.org/api-key
  sidebar_collapsed: false,         // sidebar UI state — persisted
  sites: {
    YTS:    { enabled: true,  api: 'https://yts.mx/api/v2', max_results: null },
    Nyaa:   { enabled: true,  api: 'https://nyaa.si',       max_results: null },
    TPB:    { enabled: true,  api: 'https://apibay.org',    max_results: null }
    // 1337x removed — no stable public API endpoint. Users can add a custom one via "Add Source".
  },
  rss_feeds: [],
  // rss_feeds: [{ name, url, auto_download: false, last_fetched, last_guids: [] }]

  // Library Manager — auto-organise audio downloads into subfolders by tag.
  // Disabled by default; user opts in from Settings → Integrations.
  // Pattern tokens: {artist} {albumartist} {album} {year} {genre} {title} {track}
  // Missing tags fall back to "Unknown <field>" so the move never errors.
  library_enabled: false,
  library_pattern: '{artist}/{album}',

  // Media-server trigger — fire a refresh request to Plex / Jellyfin (or a
  // generic webhook) after every successful download so the library shows
  // up immediately instead of waiting for a scheduled scan.
  mediaserver_enabled: false,
  mediaserver_type: 'jellyfin',        // 'plex' | 'jellyfin' | 'webhook'
  mediaserver_url: '',                 // base URL, e.g. http://nas.local:8096
  mediaserver_token: '',               // API token (Plex X-Plex-Token / Jellyfin API key)
  mediaserver_library_id: '',          // optional library/section id (Plex needs it)

  // Send-to-client — forward torrents to an existing qBittorrent or
  // Transmission WebUI instead of downloading inside FLUX.
  sendto_enabled: false,
  sendto_type: 'qbittorrent',          // 'qbittorrent' | 'transmission'
  sendto_url: '',                      // e.g. http://seedbox:8080
  sendto_user: '',
  sendto_pass: '',
  sendto_category: '',                 // qBittorrent only — optional category tag

  // Send-to-Usenet — forward .nzb files to an existing SABnzbd or NZBGet
  // instance. Same shape as the torrent send-to-client, separate keyspace
  // because the two protocols and their auth schemes are different.
  sendnzb_enabled: false,
  sendnzb_type: 'sabnzbd',             // 'sabnzbd' | 'nzbget'
  sendnzb_url: '',
  sendnzb_key: '',                     // SABnzbd API key OR NZBGet username
  sendnzb_pass: '',                    // NZBGet password (SABnzbd ignores this)
  sendnzb_category: '',                // optional SAB category / NZBGet category

  // IRC/XDCC defaults — bound to the new IRC tab. Single saved server keeps
  // the UI simple; a future iteration can add multi-network support.
  irc_server: '',                      // irc.example.net
  irc_port:   6697,                    // default to TLS port (6697) since we ship with irc_tls:true
  irc_tls:    true,                    // TLS by default — modern networks (Libera/OFTC/Rizon) require it
  irc_nick:   'FluxUser',
  irc_channels: '',                    // comma-separated list to auto-join
  irc_xdcc_passive: false,             // not implemented yet — placeholder
  irc_users_w: '20%',                  // width of the user-list column (CSS value)
  irc_main_h: '',                      // height of the IRC main pane (CSS value, '' = default clamp())

  // SASL PLAIN auth for IRC. Account/password are sent during connection
  // BEFORE registration so NickServ doesn't see a plaintext IDENTIFY. Many
  // networks (Libera, Rizon, OFTC) also enable host cloaking once SASL
  // succeeds, hiding the user's IP from other channel members.
  irc_sasl_enabled: false,             // explicit on/off — both this and creds required to attempt SASL
  irc_sasl_account: '',
  irc_sasl_password: '',

  // SOCKS5 proxy — when enabled, all IRC sockets (plain + TLS + DCC) are
  // tunneled through this proxy. Point it at a local Tor daemon
  // (127.0.0.1:9050) or a commercial SOCKS5 endpoint to get a VPN-like
  // effect for IRC traffic without OS-level configuration.
  socks_enabled: false,
  socks_host: '',
  socks_port: 1080,
  socks_user: '',
  socks_pass: '',

  // Modular architecture — per-module on/off state. Keys mirror module ids
  // in modules/registry.json. Defaults: every module enabled (migration
  // safety — pre-modular users keep all features). `core` is intentionally
  // omitted from the toggle UI since it's required, but kept here as true
  // for completeness. The renderer reads this to hide tabs of disabled
  // modules at boot, and the Settings > Modules toggles write back here.
  modules_enabled: {
    core:     true,
    media:    true,
    torrent:  true,
    irc:      true,
    nzb:      true,
    tag:      true,
    identify: true,
    xtract:   true,
    images:   true
  }
};

// ─── CONFIG ──────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const merged = {
        ...DEFAULT_CONFIG,
        ...saved,
        sites: { ...DEFAULT_CONFIG.sites, ...(saved.sites || {}) },
        // modules_enabled needs a shallow merge so a future-added module
        // (not present in the user's saved config) defaults to ON. Without
        // this, the spread above would replace the whole object and any
        // module added in a later version would be implicitly disabled
        // for upgrading users.
        modules_enabled: { ...DEFAULT_CONFIG.modules_enabled, ...(saved.modules_enabled || {}) }
      };
      // Migration: 1337x had no stable endpoint and was removed from defaults.
      // Old saved configs may still carry it — drop it here once.
      for (const k of Object.keys(merged.sites)) {
        if (/^1337x?$/i.test(k)) delete merged.sites[k];
      }
      // Migration: `core` must always be enabled — it's the shared lifecycle
      // foundation and can't be turned off. Force-on regardless of what's
      // in saved config (defensive against manual edits to config.json).
      merged.modules_enabled.core = true;
      return merged;
    }
  } catch (e) { log('ERROR', `loadConfig: ${e.message}`); }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (e) { log('ERROR', `saveConfig: ${e.message}`); return false; }
}

// ─── PROFILES ────────────────────────────────────────────────────────────────
function loadProfiles() {
  try {
    if (fs.existsSync(PROFILES_PATH)) return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
  } catch {}
  return {};
}

function saveProfiles(profiles) {
  try { fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2), 'utf8'); return true; }
  catch { return false; }
}

// ─── QUEUE ───────────────────────────────────────────────────────────────────
function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_PATH)) {
      const q = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
      return q.map(item => item.status === 'running' ? { ...item, status: 'pending' } : item);
    }
  } catch {}
  return [];
}

function saveQueue(q) {
  try { fs.writeFileSync(QUEUE_PATH, JSON.stringify(q, null, 2), 'utf8'); }
  catch (e) { log('ERROR', `saveQueue: ${e.message}`); }
}

// ─── HISTORY ─────────────────────────────────────────────────────────────────
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH)) return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch {}
  return [];
}

function appendHistory(entry) {
  try {
    const h = loadHistory();
    // Stat the downloaded file at append time so the History stats bar can
    // sum bytes without re-scanning the disk on every render. Failures are
    // swallowed: the file may have been moved/deleted between download
    // completion and this stat, and a missing size is not worth blocking
    // the history write.
    let size = entry.size;
    if (size == null && entry.path && !/^https?:\/\//i.test(entry.path)) {
      try {
        const st = fs.statSync(entry.path);
        if (st.isFile()) size = st.size;
      } catch {}
    }
    h.unshift({ ...entry, size: size ?? null, ts: new Date().toISOString() });
    // Keep latest 500 entries
    const trimmed = h.slice(0, 500);
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(trimmed, null, 2), 'utf8');
  } catch (e) { log('ERROR', `appendHistory: ${e.message}`); }
}

// Aggregate history into a small stats payload. Older entries (pre-size-
// tracking) get a one-shot lazy fill: if their file still exists, we stat
// it and persist the size back so subsequent renders are free. Run in main
// because stat-ing 500 files via IPC would be wasteful.
function computeHistoryStats() {
  const h = loadHistory();
  let dirty = false;
  let totalBytes = 0;
  const byKind = {};
  const bySource = {};
  let ok = 0, fail = 0;
  for (const e of h) {
    if (e.ok) ok++; else fail++;
    if (e.kind)   byKind[e.kind]     = (byKind[e.kind]     || 0) + 1;
    if (e.source) bySource[e.source] = (bySource[e.source] || 0) + 1;
    if (e.size == null && e.path && !/^https?:\/\//i.test(e.path)) {
      try {
        const st = fs.statSync(e.path);
        if (st.isFile()) { e.size = st.size; dirty = true; }
      } catch {}
    }
    if (typeof e.size === 'number') totalBytes += e.size;
  }
  if (dirty) {
    try { fs.writeFileSync(HISTORY_PATH, JSON.stringify(h, null, 2), 'utf8'); }
    catch (err) { log('ERROR', `computeHistoryStats save: ${err.message}`); }
  }
  return { total: h.length, ok, fail, byKind, bySource, totalBytes };
}

function clearHistory() {
  try { fs.writeFileSync(HISTORY_PATH, '[]', 'utf8'); return true; }
  catch { return false; }
}

// ─── SCHEDULE ────────────────────────────────────────────────────────────────
function loadSchedule() {
  try {
    if (fs.existsSync(SCHEDULE_PATH)) return JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
  } catch {}
  return { enabled: false, window_start: '02:00', window_end: '06:00', rss_poll_min: 60 };
}

function saveSchedule(s) {
  try { fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(s, null, 2), 'utf8'); return true; }
  catch { return false; }
}

// ─── LOG ─────────────────────────────────────────────────────────────────────
function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  try { fs.appendFileSync(LOG_PATH, line, 'utf8'); } catch {}
  console.log(line.trim());
}

// ─── YT-DLP PATH (bundled — no runtime download) ─────────────────────────────
// yt-dlp is bundled at build time via:
//   - package.json `extraResources`  → resources/vendor/yt-dlp.exe
//   - package.json `asarUnpack`      → resources/app.asar.unpacked/vendor/yt-dlp.exe
// Both paths are checked at runtime as defense in depth.
function getYtDlpPath() {
  const bin = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  if (app.isPackaged) {
    const candidates = [
      path.join(VENDOR_DIR, bin),                                       // lazy-fetched (userData/vendor)
      path.join(process.resourcesPath, 'vendor', bin),                  // bundled (legacy / non-slim builds)
      path.join(process.resourcesPath, 'app.asar.unpacked', 'vendor', bin),
      path.join(process.resourcesPath, bin),
      path.join(path.dirname(process.execPath), 'vendor', bin),
      path.join(path.dirname(process.execPath), bin),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    log('WARN', `yt-dlp not present yet (lazy fetch pending). Searched: ${candidates.join(' | ')}`);
    return null;
  }
  const devBin = path.join(VENDOR_DIR, bin);
  return fs.existsSync(devBin) ? devBin : null;
}

// ffmpeg resolution: prefer the bundled vendor/ffmpeg (populated at build time
// by scripts/fetch-ffmpeg.js — BtbN for win/linux, evermeet.cx for darwin),
// fall back to whatever is in PATH. Used by XTRACT.
function getFfmpegPath() {
  const bin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (app.isPackaged) {
    const candidates = [
      path.join(VENDOR_DIR, bin),                                       // lazy-fetched (userData/vendor)
      path.join(process.resourcesPath, 'vendor', bin),                  // bundled (legacy / non-slim builds)
      path.join(process.resourcesPath, 'app.asar.unpacked', 'vendor', bin),
      path.join(path.dirname(process.execPath), 'vendor', bin)
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
  } else {
    const devBin = path.join(VENDOR_DIR, bin);
    if (fs.existsSync(devBin)) return devBin;
  }
  // Fall back to PATH — `ffmpeg` will be resolved by the shell.
  return bin;
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

// ─── SAFE SEND ───────────────────────────────────────────────────────────────
function safeSend(sender, channel, payload) {
  try { if (sender && !sender.isDestroyed()) sender.send(channel, payload); }
  catch (e) { log('WARN', `safeSend ${channel}: ${e.message}`); }
}

// ─── WINDOW ──────────────────────────────────────────────────────────────────
let mainWindow;
let splashWindow;
const bootStart = Date.now();
let scheduleTimer = null;
const activeMediaProcs = new Set();
let queueStopRequested = false;

// Cross-platform process-tree kill. On Windows SIGTERM/SIGKILL only kills the
// node-spawned process; yt-dlp.exe may also have ffmpeg children. taskkill /T
// recursively kills the whole tree.
function killProcessTree(proc) {
  if (!proc || proc.killed) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      exec(`taskkill /pid ${proc.pid} /T /F`, () => {});
    } else {
      proc.kill('SIGTERM');
    }
  } catch (e) { log('WARN', `killProcessTree: ${e.message}`); }
}

// Tracks when the splash actually appeared on screen so revealMainWindow can
// enforce a minimum dwell time (config below). Without this, fast machines
// would flash the splash for ~100ms which feels broken.
let splashShownAt = 0;
// Tracks when the splash JINGLE actually started playing — separate from
// splashShownAt because Chromium's audio session has ~1-2 s init latency
// on macOS first-launch, which would otherwise have us close the splash
// mid-jingle (audio truncation bug). Set from the splash's console log
// listener; consumed by revealMainWindow to extend the dwell when needed.
let splashAudioStartedAt = 0;
// Dwell time auto-derived from the splash audio file's actual duration —
// see deriveSplashDwell() below. The default is the cold-boot fallback
// used during the few hundred ms before the probe finishes (boot still
// proceeds while we wait). If the audio is disabled in config the default
// wins (no point holding for audio that won't play) — 3 s is enough to
// register the FLUX logo without dragging boot perceptibly.
let SPLASH_MIN_MS = 3000;

// Read the splash audio's duration once at boot via music-metadata (already
// a dependency for tag editing). Adds ~150 ms of CPU work but is async, so
// the splash window opens immediately and we update SPLASH_MIN_MS in place
// before the dwell calculation runs (the +500 ms buffer below covers the
// gap between splash show and audio fully loaded).
async function deriveSplashDwell() {
  try {
    const cfg = loadConfig();
    if (cfg.splash_audio === false) return;       // muted → keep the 5 s default
    const audioFile = path.join(app.getAppPath(), 'assets', 'splash.mp3');
    if (!fs.existsSync(audioFile)) return;
    const mm = require('music-metadata');
    const meta = await mm.parseFile(audioFile);
    const dur = meta?.format?.duration;
    if (typeof dur === 'number' && dur > 0) {
      // Add a small buffer so the splash doesn't close on the very last
      // sample (audio elements often emit `ended` ~30 ms after the real
      // end, and the renderer's preload + first paint takes a beat).
      SPLASH_MIN_MS = Math.ceil(dur * 1000) + 500;
      log('INFO', `splash audio duration ${dur.toFixed(2)}s → SPLASH_MIN_MS=${SPLASH_MIN_MS}`);
    }
  } catch (e) {
    log('WARN', `splash duration probe failed: ${e.message} — keeping default ${SPLASH_MIN_MS}ms`);
  }
}

function createWindow() {
  const appRoot    = app.getAppPath();
  const preload    = path.join(appRoot, 'preload.js');
  const indexHtml  = path.join(appRoot, 'renderer', 'index.html');
  const splashHtml = path.join(appRoot, 'renderer', 'splash.html');

  // ── Splash window FIRST. backgroundColor + paintWhenInitiallyHidden:false
  // means the OS sees a coloured window immediately even before HTML loads.
  // We listen on 'ready-to-show' to record when the splash is actually
  // visible — used downstream to enforce the SPLASH_MIN_MS dwell time.
  splashWindow = new BrowserWindow({
    width: 420, height: 420,
    useContentSize: true,   // 420×420 = the rendered page (true square), not the outer frame
    center: true,
    frame: false,
    resizable: false,
    movable: true,
    transparent: false,
    backgroundColor: '#0b0b0b',
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,                  // we'll show() on ready-to-show for a smooth paint
    paintWhenInitiallyHidden: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Autoplay del jingle in splash.html — senza questo flag Chromium
      // blocca <audio autoplay> in mancanza di una user gesture.
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  splashWindow.setMenu(null);
  // Pass the user's splash-audio preference into the splash window via query
  // string. The splash runs with contextIsolation:true + no preload, so it
  // can't read config.json directly — a query param is the simplest channel.
  const splashCfg = loadConfig();
  splashWindow.loadFile(splashHtml, { search: splashCfg.splash_audio === false ? 'audio=0' : 'audio=1' });
  splashWindow.once('ready-to-show', () => {
    splashWindow?.show();
    splashShownAt = Date.now();
    log('INFO', `splash shown at boot+${Date.now() - bootStart}ms`);
  });
  // Listen on splash console messages to track ACTUAL audio playback start.
  // On macOS the WebAudio session takes 1-2 s to initialize on first use,
  // so `splashShownAt` and audio-start can differ significantly. Without
  // this, SPLASH_MIN_MS (computed as audioDuration + buffer from
  // splashShownAt) closes the splash mid-jingle. By recording when the
  // splash logs `playing`, the downstream dwell logic can recalibrate.
  splashWindow.webContents.on('console-message', (_e, _level, message) => {
    if (typeof message !== 'string') return;
    if (message.includes('[splash-audio] playing')) {
      splashAudioStartedAt = Date.now();
      log('INFO', `splash audio actually started at boot+${splashAudioStartedAt - bootStart}ms (delay from splash show: ${splashAudioStartedAt - splashShownAt}ms)`);
    } else if (message.includes('[splash-audio] pref-off') || message.includes('[splash-audio] pref-on')) {
      // The splash's mute toggle has no IPC channel — it signals its new
      // preference via this console marker. Persist it so the choice sticks
      // across launches (and so deriveSplashDwell honours it next boot).
      const enable = message.includes('pref-on');
      try { const cfg = loadConfig(); cfg.splash_audio = enable; saveConfig(cfg); log('INFO', `splash audio preference → ${enable}`); }
      catch (e) { log('WARN', `splash audio pref save failed: ${e.message}`); }
      // Tell the main window so its in-memory config + Settings checkbox stay in
      // sync — otherwise the renderer's stale config would show the old value
      // and clobber our save on its next config:save.
      if (mainWindow && !mainWindow.isDestroyed()) safeSend(mainWindow.webContents, 'config:splashAudioPref', enable);
    }
  });
  splashWindow.on('closed', () => { splashWindow = null; });

  // ── Defer main window creation by one tick. This lets the event loop
  // process the splash's first paint before competing for IPC/disk bandwidth
  // with the much heavier main window load (preload + index.html + node-shazam
  // module graph + ~30 IPC handlers). Without the defer, on slower hardware
  // the splash appears AFTER the main window's grey shell.
  setImmediate(() => { createMainWindow(preload, indexHtml); });
}

function createMainWindow(preload, indexHtml) {
  mainWindow = new BrowserWindow({
    width: 1180, height: 780,
    minWidth: 860, minHeight: 620,
    backgroundColor: '#0a0a0a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin',
    show: false,                 // stay hidden until renderer signals 'app:ready'
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  });

  mainWindow.setMenu(null);

  // ── Diagnostic logging — track ANY lifecycle event that could explain "restart"
  const wc = mainWindow.webContents;
  mainWindow.on('show',            () => log('INFO', 'window:show'));
  mainWindow.on('hide',            () => log('INFO', 'window:hide'));
  mainWindow.on('close',           () => log('INFO', 'window:close'));
  mainWindow.on('closed',          () => log('INFO', 'window:closed'));
  mainWindow.on('unresponsive',    () => log('WARN', 'window:unresponsive'));
  mainWindow.on('responsive',      () => log('INFO', 'window:responsive'));
  wc.on('did-start-loading',       () => log('INFO', 'wc:did-start-loading'));
  wc.on('did-finish-load',         () => log('INFO', 'wc:did-finish-load'));
  wc.on('did-fail-load',           (_e, code, desc, url) => log('ERROR', `wc:did-fail-load ${code} ${desc} ${url}`));
  wc.on('render-process-gone',     (_e, det) => log('ERROR', `wc:render-process-gone ${JSON.stringify(det)}`));
  wc.on('unresponsive',            () => log('WARN', 'wc:unresponsive'));
  wc.on('did-navigate',            (_e, url) => log('INFO', `wc:did-navigate ${url}`));
  wc.on('did-navigate-in-page',    (_e, url) => log('INFO', `wc:did-navigate-in-page ${url}`));
  wc.on('console-message', (...args) => {
    // Electron <35: (event, level:number, message, line, sourceId)
    // Electron 35+: (event, { level:string, message, lineNumber, sourceId })
    const [, a, b, c, d] = args;
    let lvlStr, message, line, sourceId;
    if (typeof a === 'object' && a !== null) {
      ({ level: lvlStr, message, lineNumber: line, sourceId } = a);
    } else {
      lvlStr = (typeof a === 'number') ? (['LOG','WARN','ERROR','VERBOSE'][a] || 'LOG') : String(a);
      [message, line, sourceId] = [b, c, d];
    }
    log(String(lvlStr || 'LOG').toUpperCase(), `[renderer] ${message}${sourceId?` (${path.basename(sourceId)}:${line||0})`:''}`);
  });

  // Permission handler — Electron 15+ auto-denies getUserMedia() unless the
  // main process opts in explicitly. Without this, the renderer would call
  // navigator.mediaDevices.getUserMedia({ audio: true }) and get "Permission
  // denied" / "Mic unavailable" with no OS prompt ever shown. We grant the
  // capture-related permissions FLUX legitimately uses; everything else
  // (notifications, geolocation, midi, etc.) stays denied.
  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    const allowed = ['media', 'display-capture', 'mediaKeySystem'];
    callback(allowed.includes(permission));
  });
  // Some Chromium internals (the OS-level mic indicator, codec sniffing)
  // also issue silent permission CHECKS — without this they default to false
  // and certain mic paths still no-op. Mirror the same allow-list.
  mainWindow.webContents.session.setPermissionCheckHandler((wc, permission) => {
    return ['media', 'display-capture', 'mediaKeySystem'].includes(permission);
  });

  mainWindow.loadFile(indexHtml);

  // Renderer signals 'app:ready' at end of its DOMContentLoaded init. We
  // close the splash and reveal the main window — but enforce SPLASH_MIN_MS
  // so the user actually SEES the splash even on fast hardware. Hardened
  // with two fallbacks so a renderer bug can never strand the splash forever.
  let revealScheduled = false;
  const revealMainWindow = () => {
    if (revealScheduled) return;
    revealScheduled = true;
    // How long has the splash been visible? splashShownAt=0 if it never
    // reached ready-to-show; fall back to bootStart in that case.
    const shownSince = splashShownAt || bootStart;
    const elapsed   = Date.now() - shownSince;
    // Two clocks: dwell from splash-shown, AND dwell from audio-actually-
    // started. SPLASH_MIN_MS = audio duration + 500ms buffer. We want
    // BOTH conditions met — the splash has been visible long enough AND
    // the audio (if it ever started) has had time to play through. On
    // macOS the audio session has 1-2 s init latency, so without the
    // second clock the splash closes mid-jingle (truncation bug).
    let remaining = Math.max(0, SPLASH_MIN_MS - elapsed);
    if (splashAudioStartedAt > 0) {
      const sinceAudio = Date.now() - splashAudioStartedAt;
      const audioRemaining = Math.max(0, SPLASH_MIN_MS - sinceAudio);
      if (audioRemaining > remaining) {
        log('INFO', `splash: audio still has ${audioRemaining}ms to finish — extending dwell`);
        remaining = audioRemaining;
      }
    }
    log('INFO', `splash dwell: elapsed=${elapsed}ms, holding +${remaining}ms`);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        mainWindow.show();
        mainWindow.focus();
      }
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    }, remaining);
  };
  ipcMain.handleOnce('app:ready', () => { revealMainWindow(); return true; });
  mainWindow.once('ready-to-show', () => {
    // Grace period — give the renderer a moment to call app:ready first.
    setTimeout(revealMainWindow, 1500);
  });
  setTimeout(revealMainWindow, 15000); // last-resort safety

  // DevTools shortcut (since native menu is removed). Press Ctrl+Shift+I to toggle.
  mainWindow.on('focus', () => {
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      if (mainWindow?.webContents) mainWindow.webContents.toggleDevTools();
    });
  });
  mainWindow.on('blur', () => globalShortcut.unregister('CommandOrControl+Shift+I'));
}

// ─── LIFECYCLE LOGGING (helps debug first-launch restart issues) ─────────────
log('INFO', `========== FLUX boot ==========`);
log('INFO', `version=${app.getVersion()} platform=${process.platform} packaged=${app.isPackaged}`);
log('INFO', `execPath=${process.execPath}`);
log('INFO', `resourcesPath=${process.resourcesPath || 'n/a'}`);
log('INFO', `userData=${USER_DATA}`);
log('INFO', `cmdline args=${JSON.stringify(process.argv)}`);

app.on('before-quit',   () => log('INFO', 'app:before-quit'));
app.on('will-quit',     () => log('INFO', 'app:will-quit'));
app.on('quit',          (_, code) => log('INFO', `app:quit code=${code}`));
app.on('second-instance', () => log('INFO', 'app:second-instance (another launch attempted)'));

app.whenReady().then(() => {
  log('INFO', 'app:whenReady');
  // Probe the splash audio's duration in parallel with everything else.
  // The dwell calculation downstream waits up to its default (5 s) before
  // reading SPLASH_MIN_MS; the probe finishes in ~100-300 ms so the value
  // is set in time for any non-trivial boot.
  deriveSplashDwell();
  // Apply global SOCKS5 proxy (if configured) BEFORE the window opens, so
  // every fetch / image load from the renderer starts off proxied. Async
  // but doesn't block — failures fall back to direct connection.
  applyGlobalProxy().catch(e => log('ERROR', `applyGlobalProxy startup: ${e.message}`));
  createWindow();
  startScheduler();
  initAutoUpdater();
  // Forward system theme changes (Windows/Mac) to renderer for 'auto' mode live update.
  nativeTheme.on('updated', () => {
    log('INFO', `nativeTheme:updated shouldUseDarkColors=${nativeTheme.shouldUseDarkColors}`);
    safeSend(mainWindow?.webContents, 'theme:systemChanged', { dark: nativeTheme.shouldUseDarkColors });
  });
  app.on('activate', () => {
    log('INFO', 'app:activate');
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (scheduleTimer) clearInterval(scheduleTimer);
  if (process.platform !== 'darwin') app.quit();
});

// ─── AUTO-UPDATER (scaffolding) ──────────────────────────────────────────────
function initAutoUpdater() {
  try {
    const cfg = loadConfig();
    if (!cfg.auto_update || !app.isPackaged) { log('INFO', 'auto-update: disabled'); return; }
    // macOS auto-update is intentionally disabled: the app is not code-signed /
    // notarized, so Gatekeeper blocks Squirrel.Mac/electron-updater from applying
    // updates (it would only error). Mac users update manually for now. Re-enable
    // this once the app ships with an Apple Developer signature + notarization.
    if (process.platform === 'darwin') { log('INFO', 'auto-update: disabled on macOS (unsigned build)'); return; }
    // Never run with placeholder publish config (would hit 404 and might cause weirdness)
    try {
      const pkgPath = path.join(app.getAppPath(), 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const publish = pkg.build?.publish?.[0];
      if (!publish?.owner || publish.owner === 'YOUR_GITHUB_USER') {
        log('INFO', 'auto-update: publish.owner is placeholder, skipping');
        return;
      }
    } catch (e) { log('WARN', `auto-update: cannot read package.json: ${e.message}`); return; }

    let autoUpdater;
    try { autoUpdater = require('electron-updater').autoUpdater; }
    catch { log('INFO', 'electron-updater not installed — skipping auto-update'); return; }

    autoUpdater.autoDownload = false;
    autoUpdater.on('update-available',   info => safeSend(mainWindow?.webContents, 'updater:available',   info));
    autoUpdater.on('update-downloaded',  info => safeSend(mainWindow?.webContents, 'updater:downloaded',  info));
    autoUpdater.on('error',              err  => log('ERROR', `updater: ${err.message}`));
    autoUpdater.checkForUpdates().catch(e => log('WARN', `updater check failed: ${e.message}`));

    ipcMain.handle('updater:download', () => autoUpdater.downloadUpdate());
    ipcMain.handle('updater:install',  () => autoUpdater.quitAndInstall());
  } catch (e) { log('ERROR', `initAutoUpdater: ${e.message}`); }
}

// ─── SCHEDULER (background loop) ─────────────────────────────────────────────
function startScheduler() {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = setInterval(() => {
    try {
      const sched = loadSchedule();
      const cfg   = loadConfig();
      if (!sched.enabled) return;

      const now      = new Date();
      const inWindow = isInTimeWindow(now, sched.window_start, sched.window_end);
      if (!inWindow) return;

      // Poll RSS feeds marked auto_download
      (cfg.rss_feeds || []).filter(f => f.auto_download).forEach(feed => {
        const minutes = (Date.now() - new Date(feed.last_fetched || 0).getTime()) / 60000;
        if (minutes < (sched.rss_poll_min || 60)) return;
        safeSend(mainWindow?.webContents, 'scheduler:autoPoll', { feedUrl: feed.url, feedName: feed.name });
      });
    } catch (e) { log('ERROR', `scheduler: ${e.message}`); }
  }, 60 * 1000); // every minute
}

function isInTimeWindow(now, start, end) {
  const [sh, sm] = (start || '00:00').split(':').map(Number);
  const [eh, em] = (end   || '23:59').split(':').map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  const s   = sh * 60 + sm;
  const e   = eh * 60 + em;
  if (s === e) return true;
  if (s < e)   return cur >= s && cur < e;
  return cur >= s || cur < e; // wrap past midnight
}

// ─── IPC: TAG EDITOR (read/write audio file tags) ────────────────────────────
ipcMain.handle('tag:read', (_, filePath) => readTags(filePath));
ipcMain.handle('tag:write', (_, payload) => writeTags(payload));

function extractComment(c) {
  if (!c.comment) return '';
  // music-metadata v10 returns Comment[] with { text, descriptor?, language? } objects
  if (typeof c.comment === 'string') return c.comment;
  if (Array.isArray(c.comment)) {
    return c.comment
      .map(it => typeof it === 'string' ? it : (it?.text || ''))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

async function readTags(filePath) {
  try {
    const mm = await import('music-metadata');
    const meta = await mm.parseFile(filePath, { duration: true, skipCovers: false });
    const c = meta.common;
    const pic = (c.picture && c.picture[0]) || null;
    // pic.data is Uint8Array → MUST wrap in Buffer for base64 encoding
    // (Uint8Array.toString('base64') ignores the encoding and returns decimal-comma-list)
    const coverObj = pic ? { mime: pic.format, dataBase64: Buffer.from(pic.data).toString('base64') } : null;
    return {
      ok: true,
      format: meta.format.container || path.extname(filePath).replace(/^\./, '').toUpperCase(),
      codec:  meta.format.codec || null,
      duration: meta.format.duration ? Math.round(meta.format.duration) : null,
      bitrate:  meta.format.bitrate ? Math.round(meta.format.bitrate / 1000) : null,
      sampleRate: meta.format.sampleRate || null,
      tags: {
        title:       c.title || '',
        artist:      (c.artists && c.artists.join('; ')) || c.artist || '',
        album:       c.album || '',
        albumartist: c.albumartist || '',
        year:        c.year ? String(c.year) : (c.date || ''),
        genre:       (c.genre && c.genre.join('; ')) || '',
        track:       c.track && c.track.no ? String(c.track.no) : '',
        comment:     extractComment(c)
      },
      cover: coverObj
    };
  } catch (e) {
    log('ERROR', `tag:read ${filePath}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

function writeTags({ filePath, tags, coverBase64, coverMime }) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.mp3') return { ok: false, error: `Write not supported for ${ext} yet (MP3 only)` };
    const NodeID3 = require('node-id3');
    const id3Tags = {
      title:        tags.title || '',
      artist:       tags.artist || '',
      album:        tags.album || '',
      performerInfo: tags.albumartist || '',
      year:         tags.year || '',
      genre:        tags.genre || '',
      trackNumber:  tags.track || '',
      comment:      { language: 'eng', text: tags.comment || '' }
    };
    if (coverBase64 && coverMime) {
      id3Tags.image = {
        mime: coverMime,
        type: { id: 3, name: 'front cover' },
        description: 'Cover',
        imageBuffer: Buffer.from(coverBase64, 'base64')
      };
    }
    const result = NodeID3.write(id3Tags, filePath);
    if (result === true) return { ok: true };
    if (result && result.error) return { ok: false, error: String(result.error) };
    return { ok: true };
  } catch (e) {
    log('ERROR', `tag:write ${filePath}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ─── IPC: METADATA ENRICHMENT (MusicBrainz / CoverArt / LRCLIB) ─────────────
ipcMain.handle('mb:search', (_, { title, artist, album }) => musicBrainzSearch(title, artist, album));
ipcMain.handle('cover:fetch', (_, mbid) => coverArtFetch(mbid));
ipcMain.handle('lrc:fetch', (_, { title, artist, album, duration }) => lyricsFetch(title, artist, album, duration));

// Auto-tag flow: given a freshly-downloaded MP3 + an artist/title hint (or a
// "Artist - Title" string), query MusicBrainz for the best match, optionally
// fetch its release cover from Cover Art Archive, and write ID3v2 tags.
// Caller decides whether to await this — radio/Spotify downloads fire it
// fire-and-forget so a slow MB query doesn't block the UI.
ipcMain.handle('tag:autoTag', async (_, { filePath, artist, title, hint, minScore = 80, fetchCover = true } = {}) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'File not found' };
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.mp3') return { ok: false, error: `Auto-tag only supports MP3 (got ${ext})` };

    let a = (artist || '').trim();
    let tt = (title || '').trim();
    if (!a && !tt && hint) {
      const m = String(hint).match(/^(.+?)\s*[-–—]\s*(.+)$/);
      if (m) { a = m[1].trim(); tt = m[2].trim(); }
      else { tt = String(hint).trim(); }
    }
    if (!tt) return { ok: false, error: 'Cannot determine title from hint' };

    const mb = await musicBrainzSearch(tt, a, '');
    if (!mb.ok) return { ok: false, error: mb.error || 'MusicBrainz query failed' };
    if (!mb.results.length) return { ok: false, error: 'No MusicBrainz match' };
    const top = mb.results[0];
    if (typeof top.score === 'number' && top.score < minScore) {
      return { ok: false, error: `Low confidence (${top.score} < ${minScore}); not tagged.` };
    }

    let coverBase64 = null, coverMime = null;
    if (fetchCover && top.release_mbid) {
      try {
        const c = await coverArtFetch(top.release_mbid);
        if (c.ok) { coverBase64 = c.dataBase64; coverMime = c.mime; }
      } catch {} // missing cover is not fatal
    }

    const tags = {
      title:  top.title  || tt,
      artist: top.artist || a,
      album:  top.album  || '',
      year:   top.year   || ''
    };
    const w = writeTags({ filePath, tags, coverBase64, coverMime });
    if (!w.ok) return w;
    log('INFO', `tag:autoTag ${path.basename(filePath)} → "${tags.artist} - ${tags.title}" (score=${top.score}, cover=${!!coverBase64})`);
    return { ok: true, tags, cover: !!coverBase64, score: top.score };
  } catch (e) {
    log('ERROR', `tag:autoTag: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

async function musicBrainzSearch(title, artist, album) {
  try {
    const parts = [];
    if (title)  parts.push(`recording:"${title.replace(/"/g, '\\"')}"`);
    if (artist) parts.push(`artist:"${artist.replace(/"/g, '\\"')}"`);
    if (album)  parts.push(`release:"${album.replace(/"/g, '\\"')}"`);
    if (!parts.length) return { ok: false, error: 'No query terms' };
    const q = encodeURIComponent(parts.join(' AND '));
    const url = `https://musicbrainz.org/ws/2/recording/?query=${q}&fmt=json&limit=5`;
    // MusicBrainz requires a descriptive User-Agent
    const data = await fetchJSONWithUA(url, 'FLUX/1.0.0 (https://github.com/dev001)');
    if (!data?.recordings?.length) return { ok: true, results: [] };
    const results = data.recordings.slice(0, 5).map(r => ({
      mbid:    r.id,
      title:   r.title,
      artist:  (r['artist-credit'] || []).map(a => a.name).join('; '),
      album:   (r.releases && r.releases[0]?.title) || null,
      release_mbid: (r.releases && r.releases[0]?.id) || null,
      year:    (r.releases && r.releases[0]?.date && r.releases[0].date.substring(0, 4)) || null,
      score:   r.score
    }));
    return { ok: true, results };
  } catch (e) {
    log('ERROR', `mb:search: ${e.message}`);
    return { ok: false, error: describeNetError(e) };
  }
}

async function coverArtFetch(mbid) {
  try {
    if (!mbid) return { ok: false, error: 'Missing MBID' };
    // Cover Art Archive redirects to the image; we follow and capture bytes
    const url = `https://coverartarchive.org/release/${mbid}/front-500`;
    const result = await fetchBinary(url);
    return { ok: true, mime: result.mime || 'image/jpeg', dataBase64: result.buffer.toString('base64') };
  } catch (e) {
    log('ERROR', `cover:fetch: ${e.message}`);
    return { ok: false, error: describeNetError(e) };
  }
}

async function lyricsFetch(title, artist, album, duration) {
  try {
    const params = new URLSearchParams();
    if (title)  params.set('track_name', title);
    if (artist) params.set('artist_name', artist);
    if (album)  params.set('album_name', album);
    if (duration) params.set('duration', String(duration));
    const url = `https://lrclib.net/api/get?${params.toString()}`;
    const data = await fetchJSONWithUA(url, 'FLUX/1.0.0 (https://github.com/dev001)');
    if (!data) return { ok: true, plain: null, synced: null };
    return { ok: true, plain: data.plainLyrics || null, synced: data.syncedLyrics || null };
  } catch (e) {
    // LRCLIB returns 404 when no match — surface as empty rather than error
    if (/HTTP 404/.test(e.message)) return { ok: true, plain: null, synced: null };
    log('ERROR', `lrc:fetch: ${e.message}`);
    return { ok: false, error: describeNetError(e) };
  }
}

// ─── IPC: RADIO BROWSER ─────────────────────────────────────────────────────
// RadioBrowser is a community-mirrored API. Use SRV lookup or a known mirror.
const RADIO_API_BASE = 'https://de1.api.radio-browser.info';

ipcMain.handle('radio:search', (_, params) => radioSearch(params));
ipcMain.handle('radio:countries', () => radioMeta('countries'));
ipcMain.handle('radio:tags', () => radioMeta('tags', 200));
ipcMain.handle('radio:languages', () => radioMeta('languages', 200));

async function radioSearch({ name, country, tag, language, limit = 30 }) {
  try {
    const params = new URLSearchParams();
    if (name)     params.set('name', name);
    if (country)  params.set('country', country);
    if (tag)      params.set('tag', tag);
    if (language) params.set('language', language);
    params.set('limit', String(limit));
    params.set('order', 'clickcount');
    params.set('reverse', 'true');
    params.set('hidebroken', 'true');
    const url = `${RADIO_API_BASE}/json/stations/search?${params.toString()}`;
    const data = await fetchJSONWithUA(url, 'FLUX/1.0.0');
    if (!Array.isArray(data)) return { ok: true, results: [] };
    return {
      ok: true,
      results: data.map(s => ({
        uuid: s.stationuuid,
        name: s.name,
        url:  s.url_resolved || s.url,
        homepage: s.homepage || null,
        favicon:  s.favicon || null,
        country:  s.country || null,
        language: s.language || null,
        codec:    s.codec || null,
        bitrate:  s.bitrate || null,
        tags:     s.tags || ''
      }))
    };
  } catch (e) {
    log('ERROR', `radio:search: ${e.message}`);
    return { ok: false, error: describeNetError(e) };
  }
}

// Radio-browser mirrors. The metadata endpoints (countries/tags/languages) on a
// single mirror sometimes return an empty array even when search works, so we
// fail over across mirrors until one returns a non-empty list.
// radio-browser.info rotates its mirror hostnames; nl1/at1 went dead (ENOTFOUND).
// de1/de2 are live; `all.api` is the official round-robin DNS that resolves to
// whichever servers are currently up — kept last as a self-healing fallback.
const RADIO_MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://all.api.radio-browser.info'
];

async function radioMeta(kind, limit = 500) {
  let lastErr = null;
  for (const base of RADIO_MIRRORS) {
    try {
      const url = `${base}/json/${kind}?order=stationcount&reverse=true&limit=${limit}&hidebroken=true`;
      const data = await fetchJSONWithUA(url, 'FLUX/1.0.0');
      if (Array.isArray(data) && data.length) return { ok: true, items: data };
    } catch (e) {
      lastErr = e;
      log('WARN', `radio:meta ${kind} @ ${base}: ${e.message}`);
    }
  }
  log('ERROR', `radio:meta ${kind}: all mirrors empty/failed`);
  return { ok: false, error: lastErr ? describeNetError(lastErr) : 'no mirror returned metadata', items: [] };
}

// ─── HTTP HELPERS (with User-Agent override, binary support) ─────────────────
// Low-level GET that prefers Electron's `net` (Chromium network stack → OS
// certificate store + system proxy). This is critical behind corporate
// TLS-intercepting proxies, where Node's bundled CA bundle rejects the chain
// ("unable to verify the first certificate") — the same reason binary-fetcher.js
// uses net. Falls back to Node http/https when Electron net isn't available.
// Resolves to a Node-stream-like response ({ statusCode, headers, on('data'|'end'|'error') }).
function httpGetStream(url, { ua = 'FLUX/1.0.0', accept, timeout = 15000, _redirects = 0 } = {}) {
  let electronNet = null;
  try { electronNet = require('electron').net; } catch { /* not in Electron */ }
  if (electronNet) {
    return new Promise((resolve, reject) => {
      const req = electronNet.request({ url, redirect: 'follow' });
      req.setHeader('User-Agent', ua);
      if (accept) req.setHeader('Accept', accept);
      const timer = setTimeout(() => { try { req.abort(); } catch {} reject(new Error('Timeout')); }, timeout);
      req.on('response', res => { clearTimeout(timer); resolve(res); });
      req.on('error', e => { clearTimeout(timer); reject(e); });
      req.end();
    });
  }
  if (_redirects > 5) return Promise.reject(new Error('Too many redirects'));
  const mod = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': ua };
    if (accept) headers['Accept'] = accept;
    const req = mod.get(url, { timeout, headers }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        req.destroy();
        return httpGetStream(res.headers.location, { ua, accept, timeout, _redirects: _redirects + 1 }).then(resolve).catch(reject);
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchJSONWithUA(url, ua, timeout = 15000) {
  const res = await httpGetStream(url, { ua, accept: 'application/json', timeout });
  return new Promise((resolve, reject) => {
    if (res.statusCode !== 200) { try { res.resume && res.resume(); } catch {} return reject(new Error(`HTTP ${res.statusCode}`)); }
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(`Invalid JSON: ${d.substring(0,80)}`)); } });
    res.on('error', reject);
  });
}

async function fetchBinary(url, timeout = 20000, _redirects = 0) {
  if (_redirects > 5) throw new Error('Too many redirects');
  const mod = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { timeout, headers: { 'User-Agent': 'FLUX/1.0.0' } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        req.destroy();
        return fetchBinary(res.headers.location, timeout, _redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { req.destroy(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      const mime = res.headers['content-type'] || 'application/octet-stream';
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), mime }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── SONG RECOGNITION (ICY metadata + AcoustID via fpcalc) ───────────────────
function getFpcalcPath() {
  const bin = process.platform === 'win32' ? 'fpcalc.exe' : 'fpcalc';
  if (app.isPackaged) {
    const candidates = [
      path.join(VENDOR_DIR, bin),                                       // lazy-fetched (userData/vendor)
      path.join(process.resourcesPath, 'vendor', bin),                  // bundled (legacy / non-slim builds)
      path.join(process.resourcesPath, 'app.asar.unpacked', 'vendor', bin),
      path.join(path.dirname(process.execPath), 'vendor', bin),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return null;
  }
  const devBin = path.join(VENDOR_DIR, bin);
  return fs.existsSync(devBin) ? devBin : null;
}

// ICY (Shoutcast/Icecast) metadata reader.
// Opens a second HTTP connection to the stream with Icy-MetaData:1 header and
// parses the interleaved metadata blocks. Emits `radio:icyMeta` to the renderer
// each time the StreamTitle changes. Cheap because we discard the audio bytes.
const activeIcyClients = new Map(); // uuid -> ClientRequest

ipcMain.handle('radio:startIcyWatch', (event, { uuid, url }) => {
  stopIcyWatch(uuid);
  startIcyWatch(uuid, url, event.sender);
  return { ok: true };
});
ipcMain.handle('radio:stopIcyWatch', (_, uuid) => {
  stopIcyWatch(uuid);
  return { ok: true };
});

function stopIcyWatch(uuid) {
  const req = activeIcyClients.get(uuid);
  if (req) { try { req.destroy(); } catch {} activeIcyClients.delete(uuid); }
}

function startIcyWatch(uuid, url, sender, _redirects = 0) {
  if (_redirects > 3) return;
  const mod = url.startsWith('https') ? require('https') : require('http');
  const req = mod.get(url, {
    headers: {
      'Icy-MetaData': '1',
      'User-Agent':   'FLUX/1.0.0 (icy-watch)'
    },
    timeout: 15000
  }, res => {
    if ([301, 302, 307, 308].includes(res.statusCode)) {
      req.destroy();
      return startIcyWatch(uuid, res.headers.location, sender, _redirects + 1);
    }
    if (res.statusCode !== 200) {
      log('WARN', `ICY watch HTTP ${res.statusCode} for ${url}`);
      return;
    }
    const metaint = parseInt(res.headers['icy-metaint'] || '0', 10);
    if (!metaint) {
      log('INFO', `Station ${uuid} has no icy-metaint header — no live track info available`);
      req.destroy();
      return;
    }

    let bytesUntilMeta = metaint;
    let metaLenPending = false;
    let metaRemaining = 0;
    let metaBuf = Buffer.alloc(0);
    let lastTitle = '';

    res.on('data', chunk => {
      let off = 0;
      while (off < chunk.length) {
        if (metaLenPending) {
          // Single byte = (metadata length / 16). 0 means "no metadata this round".
          const metaLen = chunk[off] * 16;
          off++;
          metaLenPending = false;
          if (metaLen === 0) {
            bytesUntilMeta = metaint;
          } else {
            metaRemaining = metaLen;
            metaBuf = Buffer.alloc(0);
          }
        } else if (metaRemaining > 0) {
          const toRead = Math.min(metaRemaining, chunk.length - off);
          metaBuf = Buffer.concat([metaBuf, chunk.subarray(off, off + toRead)]);
          off += toRead;
          metaRemaining -= toRead;
          if (metaRemaining === 0) {
            // Metadata is in form: StreamTitle='Artist - Title';StreamUrl='...';
            const metaStr = metaBuf.toString('utf8').replace(/\0+$/, '');
            const m = metaStr.match(/StreamTitle='([^']*)'/);
            const title = m ? m[1].trim() : '';
            if (title && title !== lastTitle) {
              lastTitle = title;
              safeSend(sender, 'radio:icyMeta', { uuid, streamTitle: title });
            }
            bytesUntilMeta = metaint;
          }
        } else {
          // Audio block — count bytes but don't store (we don't play, only watch).
          const toSkip = Math.min(bytesUntilMeta, chunk.length - off);
          off += toSkip;
          bytesUntilMeta -= toSkip;
          if (bytesUntilMeta === 0) metaLenPending = true;
        }
      }
    });
    res.on('end',   () => activeIcyClients.delete(uuid));
    res.on('error', err => { log('WARN', `ICY stream error: ${err.message}`); activeIcyClients.delete(uuid); });
  });
  req.on('error',   err => { log('WARN', `ICY request error: ${err.message}`); activeIcyClients.delete(uuid); });
  req.on('timeout', () => { req.destroy(); activeIcyClients.delete(uuid); });
  activeIcyClients.set(uuid, req);
}

// AcoustID identify from a raw audio buffer (microphone capture path). The
// renderer sends an ArrayBuffer (WebM/Opus from MediaRecorder); we write it
// to a temp file, fingerprint with fpcalc, then query AcoustID. fpcalc reads
// WebM via embedded ffmpeg, so no format conversion is needed here.
// ─── SHAZAM RECOGNITION (default, no API key) ───────────────────────────────
// node-shazam uses shazamio-core (WASM port of the Rust fingerprinter) + a HTTP
// POST to amp.shazam.com — no auth, no key, returns title/artist/cover/etc.
// Identifies broader catalog than AcoustID-MusicBrainz (commercial+obscure).
//
// Tradeoffs: unofficial API → may break if Shazam changes endpoints. Fail
// gracefully when that happens so the user can switch to AcoustID in Settings.
ipcMain.handle('shazam:identifyFromBuffer', async (_, { buffer }) => {
  try {
    if (!buffer || !buffer.byteLength) return { ok: false, error: 'Empty microphone capture' };
    // Write the captured audio to a temp file — node-shazam's fromFilePath
    // accepts any format ffmpeg can decode (WebM/Opus from MediaRecorder works).
    const tempFile = path.join(USER_DATA, `.identify-shazam-${Date.now()}.webm`);
    fs.writeFileSync(tempFile, Buffer.from(buffer));
    log('INFO', `shazam: mic capture ${buffer.byteLength} bytes -> ${tempFile}`);

    // node-shazam's to_pcm.cjs calls `fluent_ffmpeg.setFfmpegPath(installerPath)`
    // at MODULE LOAD time, pointing at @ffmpeg-installer's bundled binary.
    // We removed @ffmpeg-installer's binary from the package (~100 MB saved)
    // and override fluent-ffmpeg's stored path with our vendor/ffmpeg right
    // after node-shazam loads — both libs share the same fluent-ffmpeg instance.
    const { Shazam } = require('node-shazam');
    try {
      const fluent = require('fluent-ffmpeg');
      const vendorFfmpeg = getFfmpegPath();
      fluent.setFfmpegPath(vendorFfmpeg);
      log('INFO', `shazam: ffmpeg path overridden to ${vendorFfmpeg}`);
    } catch (e) {
      log('WARN', `shazam: ffmpeg path override failed: ${e.message}`);
    }
    const shazam = new Shazam();
    const result = await shazam.fromFilePath(tempFile, false, 'en');
    try { fs.unlinkSync(tempFile); } catch {}

    if (!result || !result.track) {
      return { ok: true, title: null };  // recognised "no match"
    }
    const t = result.track;
    return {
      ok: true,
      title:  t.title || null,
      artist: t.subtitle || (t.artists && t.artists[0]?.alias) || '',
      // score isn't returned by Shazam; emit a confidence-like 1 for matched
      score:  t.title ? 1 : 0,
      cover:  t.images?.coverart || null,
      shareUrl: t.share?.href || null
    };
  } catch (e) {
    log('ERROR', `shazam:identifyFromBuffer: ${e.message}`);
    return { ok: false, error: `Shazam recognition failed: ${e.message}` };
  }
});

// AcoustID key validation. Reads the response body REGARDLESS of HTTP status:
// AcoustID returns 400 + JSON body { error: { message: "Invalid API key" } }
// when the key is wrong, but our standard fetchJSONWithUA throws on non-200
// and swallows the body. So we use a raw fetch here.
async function fetchAnyStatusJSON(url, ua = 'FLUX/1.0.0', timeout = 10000) {
  const mod = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { timeout, headers: { 'User-Agent': ua, 'Accept': 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(d); } catch { /* keep null */ }
        resolve({ status: res.statusCode, body: parsed, raw: d });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

ipcMain.handle('acoustid:validateKey', async (_, { apiKey }) => {
  if (!apiKey || !apiKey.trim()) return { ok: false, error: 'Empty key' };
  try {
    // /v2/lookup validates the client key BEFORE the fingerprint, so a bad
    // key always returns "invalid API key" even with a placeholder fingerprint.
    // Using a longer-looking fingerprint avoids the server short-circuiting
    // on "fingerprint too short" before the auth check.
    const url = `https://api.acoustid.org/v2/lookup?client=${encodeURIComponent(apiKey.trim())}&meta=recordings&duration=10&fingerprint=AQADtFkkRZmYJEqShCSSEEII`;
    const r = await fetchAnyStatusJSON(url);
    const body = r.body;
    if (body && body.status === 'ok')  return { ok: true };
    if (body && body.status === 'error') {
      const msg = (body.error && body.error.message) || '';
      log('INFO', `acoustid:validateKey status=${r.status} msg="${msg}"`);
      if (/invalid (api|client)/i.test(msg)) return { ok: false, error: 'Invalid API key' };
      // Any non-auth error means the key authenticated → accept it.
      return { ok: true };
    }
    return { ok: true, warning: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: true, warning: e.message };
  }
});

ipcMain.handle('acoustid:identifyFromBuffer', async (_, { buffer, apiKey }) => {
  try {
    const fpcalc = getFpcalcPath();
    if (!fpcalc) return { ok: false, error: 'fpcalc binary not bundled — rebuild FLUX' };
    if (!apiKey) return { ok: false, error: 'AcoustID API key not configured' };
    if (!buffer || !buffer.byteLength) return { ok: false, error: 'Empty microphone capture' };

    const tempFile = path.join(USER_DATA, `.identify-mic-${Date.now()}.webm`);
    fs.writeFileSync(tempFile, Buffer.from(buffer));
    log('INFO', `acoustid: mic capture ${buffer.byteLength} bytes → ${tempFile}`);

    const fp = await runFpcalc(fpcalc, tempFile);
    try { fs.unlinkSync(tempFile); } catch {}

    const lookup = await acoustidLookup(fp.fingerprint, fp.duration, apiKey);
    return { ok: true, ...lookup };
  } catch (e) {
    log('ERROR', `acoustid:identifyFromBuffer: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

// AcoustID identify: capture 15s of the stream, fingerprint with fpcalc, query AcoustID.
ipcMain.handle('acoustid:identify', async (_, { streamUrl, apiKey }) => {
  try {
    const fpcalc = getFpcalcPath();
    if (!fpcalc) return { ok: false, error: 'fpcalc binary not bundled — rebuild FLUX' };
    if (!apiKey) return { ok: false, error: 'AcoustID API key not configured — open Settings' };
    if (!streamUrl) return { ok: false, error: 'No stream playing' };

    const tempFile = path.join(USER_DATA, `.identify-${Date.now()}.bin`);
    log('INFO', `acoustid: capturing 15s from ${streamUrl}`);
    await captureStreamBytes(streamUrl, tempFile, 15);

    const stat = fs.existsSync(tempFile) ? fs.statSync(tempFile).size : 0;
    if (stat < 50_000) {
      try { fs.unlinkSync(tempFile); } catch {}
      return { ok: false, error: `Captured only ${stat} bytes — stream may be unreachable` };
    }

    const fp = await runFpcalc(fpcalc, tempFile);
    try { fs.unlinkSync(tempFile); } catch {}

    const lookup = await acoustidLookup(fp.fingerprint, fp.duration, apiKey);
    return { ok: true, ...lookup };
  } catch (e) {
    log('ERROR', `acoustid:identify: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

async function captureStreamBytes(url, dest, durationSec, _redirects = 0) {
  if (_redirects > 5) throw new Error('Too many redirects');
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    const req = mod.get(url, {
      headers: { 'User-Agent': 'FLUX/1.0.0', 'Icy-MetaData': '0' },
      timeout: 15000
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        req.destroy();
        return captureStreamBytes(res.headers.location, dest, durationSec, _redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        req.destroy();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      const timer = setTimeout(() => {
        req.destroy();
        file.close(() => resolve(dest));
      }, durationSec * 1000);
      file.on('error', err => { clearTimeout(timer); fs.unlink(dest, () => {}); reject(err); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Stream connection timeout')); });
  });
}

function runFpcalc(fpcalcPath, audioFile) {
  return new Promise((resolve, reject) => {
    const proc = spawn(fpcalcPath, ['-json', '-length', '15', audioFile]);
    let out = '', err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, 30000);
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `fpcalc exit ${code}`));
      try {
        const data = JSON.parse(out);
        if (!data.fingerprint) return reject(new Error('fpcalc produced no fingerprint'));
        resolve({ fingerprint: data.fingerprint, duration: data.duration });
      } catch (e) { reject(new Error(`fpcalc JSON parse: ${e.message}`)); }
    });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// Raw Chromaprint hash sequence for dedup — `-raw` outputs comma-separated
// int32s instead of the compressed base64. We take the first 30s of audio
// and compare files via Hamming distance over the first N (~6s) hashes.
function runFpcalcRaw(fpcalcPath, audioFile) {
  return new Promise((resolve, reject) => {
    const proc = spawn(fpcalcPath, ['-raw', '-length', '30', audioFile]);
    let out = '', err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, 30000);
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `fpcalc exit ${code}`));
      // Parse "FINGERPRINT=1853020488,1859311880,..." or per-line variants.
      const m = out.match(/FINGERPRINT=([\d,-]+)/);
      if (!m) return reject(new Error('fpcalc raw: no FINGERPRINT line'));
      // Int32Array with sign-preserving cast. Hamming distance treats them
      // as unsigned 32-bit but XOR + popcount works the same on Int32.
      const arr = m[1].split(',').map(s => parseInt(s, 10) | 0);
      resolve({ hashes: arr });
    });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ─── IPC: IMAGE BULK OPERATIONS (sharp-driven) ──────────────────────────────
// Loaded lazily so a missing sharp install (e.g. ARM/Mac dev box without
// rebuild) only fails when the user opens Image Editor, not at boot.
let _sharp = null;
function getSharp() {
  if (_sharp === null) {
    try { _sharp = require('sharp'); }
    catch (e) { log('ERROR', `sharp load failed: ${e.message}`); _sharp = false; }
  }
  return _sharp || null;
}

// Single supported-formats set used by the loader + listing. Sharp handles
// these natively; HEIC needs libheif (compiled into sharp on Win/Mac/Linux
// 0.32+). RAW formats (CR2/NEF/ARW) need dcraw — out of scope for now.
// SVG is input-only: sharp rasterises it on load via librsvg, but cannot
// write SVG back out — every image-batch operation produces a raster format
// (jpg/png/webp). The image editor (Fabric) needs loadSVGFromURL instead of
// FabricImage.fromURL for SVG inputs (see ensureImageEditor in renderer.js).
const IMG_EXTS = new Set(['jpg','jpeg','png','webp','avif','tiff','tif','gif','bmp','heic','heif','svg']);

// Resolve the destination path for a per-file image op based on the
// caller's Output preferences (overwrite / outputFolder / fallback to
// next-to-source with a suffix). Centralised here so every handler
// (convert / resize / strip / rotate / heic / watermark / compress) gets
// the same path semantics. Side-effect: ensures outputFolder exists.
//   overwrite   → write back to source path (replaces extension if ext given)
//   outputFolder→ write into that folder (mkdir -p), no suffix
//   default     → src dir + suffix + ext
function resolveImageOut({ srcPath, overwrite, outputFolder, suffix, ext }) {
  const srcExt = path.extname(srcPath);
  const baseName = path.basename(srcPath, srcExt);
  // SVG is input-only for sharp (rasterised on read via librsvg, no writer
  // exists). For every operation that defaults to preserving the source
  // extension (resize, stripExif, watermark, fx, …) silently rewrite the
  // output to PNG when the source is SVG — otherwise sharp throws
  // "unsupported output format svg" at toFile() time.
  let finalExt = ext ? '.' + ext.replace(/^\./, '') : srcExt;
  if (!ext && /^\.svg$/i.test(srcExt)) finalExt = '.png';
  if (overwrite) {
    return path.join(path.dirname(srcPath), baseName + finalExt);
  }
  if (outputFolder) {
    try { fs.mkdirSync(outputFolder, { recursive: true }); } catch {}
    return path.join(outputFolder, baseName + finalExt);
  }
  return path.join(path.dirname(srcPath), baseName + (suffix || '') + finalExt);
}

ipcMain.handle('images:load', async (_, { paths, folder, recursive }) => {
  // Two modes: explicit file list (from drag-drop / pick), or a folder
  // walk (recursive optional). Returns metadata for each image so the
  // renderer can show thumbnails + dimensions without re-stating.
  const out = [];
  const sharp = getSharp();
  const collect = async (p) => {
    if (!fs.existsSync(p)) return;
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      if (!recursive && p !== folder) return;
      for (const entry of fs.readdirSync(p)) await collect(path.join(p, entry));
      return;
    }
    const ext = path.extname(p).slice(1).toLowerCase();
    if (!IMG_EXTS.has(ext)) return;
    let width = 0, height = 0;
    if (sharp) {
      try { const m = await sharp(p).metadata(); width = m.width || 0; height = m.height || 0; }
      catch {}
    }
    out.push({ path: p, name: path.basename(p), ext, size: stat.size, width, height });
  };
  if (Array.isArray(paths)) for (const p of paths) await collect(p);
  if (folder) await collect(folder);
  return { ok: true, files: out };
});

ipcMain.handle('images:thumbnail', async (_, { input, maxSize = 96 }) => {
  // 96-px JPEG thumbnail returned as a base64 data URI for the file list.
  // Cheap: sharp's resize is sub-millisecond per image even at full res.
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: 'sharp not available' };
  try {
    const buf = await sharp(input).rotate().resize(maxSize, maxSize, { fit: 'cover' }).jpeg({ quality: 70 }).toBuffer();
    return { ok: true, dataUri: 'data:image/jpeg;base64,' + buf.toString('base64') };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Rename takes a pattern with tokens ({name},{ext},{n},{nn},{nnn},{date},
// {time},{w},{h}) and a starting counter. Returns the new path for each
// success + a list of failures. `overwrite` is irrelevant here — rename
// is always in-place (that's the point).
ipcMain.handle('images:rename', async (_, { files, pattern, start }) => {
  const out = [];
  const fails = [];
  let counter = Math.max(0, parseInt(start, 10) || 0);
  const today = new Date();
  const datePart = today.toISOString().slice(0, 10);
  const timePart = today.toTimeString().slice(0, 8).replace(/:/g, '');
  for (const f of files) {
    const idx = counter++;
    const newName = (pattern || '{name}-{nn}.{ext}')
      .replace(/{name}/g, path.basename(f.path, path.extname(f.path)))
      .replace(/{ext}/g,  f.ext)
      .replace(/{nnn}/g,  String(idx).padStart(3, '0'))
      .replace(/{nn}/g,   String(idx).padStart(2, '0'))
      .replace(/{n}/g,    String(idx))
      .replace(/{date}/g, datePart)
      .replace(/{time}/g, timePart)
      .replace(/{w}/g,    String(f.width || ''))
      .replace(/{h}/g,    String(f.height || ''));
    // Sanitize: drop chars Windows refuses, collapse whitespace.
    const safeName = newName.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
    if (!safeName) { fails.push({ path: f.path, error: 'empty pattern output' }); continue; }
    const target = path.join(path.dirname(f.path), safeName);
    if (target === f.path) { out.push({ from: f.path, to: target, skipped: true }); continue; }
    try {
      if (fs.existsSync(target)) throw new Error('target exists');
      fs.renameSync(f.path, target);
      out.push({ from: f.path, to: target });
    } catch (e) {
      fails.push({ path: f.path, error: e.message });
    }
  }
  return { ok: true, renamed: out, failed: fails };
});

ipcMain.handle('images:convert', async (_, { files, format, quality, overwrite, outputFolder }) => {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: 'sharp not available' };
  const out = [];
  const fails = [];
  const q = Math.max(1, Math.min(100, parseInt(quality, 10) || 85));
  const outExt = format === 'jpeg' ? 'jpg' : format;
  for (const f of files) {
    try {
      let pipeline = sharp(f.path).rotate();
      if      (format === 'jpg' || format === 'jpeg') pipeline = pipeline.jpeg({ quality: q, mozjpeg: true });
      else if (format === 'png')                       pipeline = pipeline.png({ compressionLevel: 9 });
      else if (format === 'webp')                      pipeline = pipeline.webp({ quality: q });
      else if (format === 'avif')                      pipeline = pipeline.avif({ quality: q });
      else throw new Error(`unsupported format: ${format}`);
      const target = resolveImageOut({ srcPath: f.path, overwrite, outputFolder, suffix: '-conv', ext: outExt });
      await pipeline.toFile(target);
      // If overwrite + format change, drop the old file (different ext = both still exist).
      if (overwrite && target !== f.path && fs.existsSync(f.path)) {
        try { fs.unlinkSync(f.path); } catch {}
      }
      out.push({ from: f.path, to: target });
    } catch (e) {
      fails.push({ path: f.path, error: e.message });
    }
  }
  return { ok: true, converted: out, failed: fails };
});

ipcMain.handle('images:resize', async (_, { files, maxWidth, maxHeight, scalePct, overwrite, outputFolder }) => {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: 'sharp not available' };
  const out = [];
  const fails = [];
  const mw = parseInt(maxWidth,  10) || 0;
  const mh = parseInt(maxHeight, 10) || 0;
  const sp = parseInt(scalePct,  10) || 0;
  if (mw <= 0 && mh <= 0 && sp <= 0) return { ok: false, error: 'no resize parameter' };
  for (const f of files) {
    try {
      // Probe once: need original W×H to compute scalePct AND to compute
      // density for SVG rasterisation (without this, sharp rasterises SVG
      // at 72 DPI which produces a tiny PNG from a small viewBox — looks
      // like "resize didn't work").
      const meta = await sharp(f.path).metadata();
      const isSvg = meta.format === 'svg';
      const naturalW = meta.width  || 0;
      const naturalH = meta.height || 0;

      let resizeOpts;
      if (sp > 0) {
        resizeOpts = { width: Math.round(naturalW * sp / 100) };
      } else {
        resizeOpts = {
          width:  mw > 0 ? mw : undefined,
          height: mh > 0 ? mh : undefined,
          fit:    'inside',
          withoutEnlargement: !isSvg   // SVG must be allowed to upscale — natural size = viewBox px
        };
      }

      // For SVG: compute the density so the initial rasterisation lands
      // at (at least) the target dimensions. Otherwise sharp rasterises at
      // 72 DPI → tiny bitmap → resize-up = blurry/no-op.
      let inputOpts = {};
      if (isSvg) {
        const targetW = resizeOpts.width
                      || (resizeOpts.height && naturalH ? Math.round(resizeOpts.height * naturalW / naturalH) : 0)
                      || 1024;  // sensible default if neither dim given
        if (naturalW > 0) {
          inputOpts.density = Math.max(72, Math.round(72 * targetW / naturalW));
        }
      }

      const target = resolveImageOut({ srcPath: f.path, overwrite, outputFolder, suffix: '-resize' });
      await sharp(f.path, inputOpts).rotate().resize(resizeOpts).toFile(target + '.tmp');
      // Atomic move so a failed write doesn't leave the user with a 0-byte file.
      fs.renameSync(target + '.tmp', target);
      out.push({ from: f.path, to: target });
    } catch (e) {
      fails.push({ path: f.path, error: e.message });
    }
  }
  return { ok: true, resized: out, failed: fails };
});

ipcMain.handle('images:stripExif', async (_, { files, overwrite, outputFolder }) => {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: 'sharp not available' };
  const out = [];
  const fails = [];
  for (const f of files) {
    try {
      const target = resolveImageOut({ srcPath: f.path, overwrite, outputFolder, suffix: '-clean' });
      // sharp drops EXIF/ICC/XMP by default unless withMetadata() is called.
      // Use toBuffer + write so we can do atomic move (avoid in-place truncate).
      const buf = await sharp(f.path).rotate().toBuffer();
      fs.writeFileSync(target + '.tmp', buf);
      fs.renameSync(target + '.tmp', target);
      out.push({ from: f.path, to: target });
    } catch (e) {
      fails.push({ path: f.path, error: e.message });
    }
  }
  return { ok: true, stripped: out, failed: fails };
});

ipcMain.handle('images:autoRotate', async (_, { files, overwrite, outputFolder }) => {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: 'sharp not available' };
  const out = [];
  const fails = [];
  for (const f of files) {
    try {
      const target = resolveImageOut({ srcPath: f.path, overwrite, outputFolder, suffix: '-rotated' });
      // .rotate() with no arg reads EXIF Orientation and bakes it into the
      // pixel data, then strips the tag. Standard auto-orient pattern.
      const buf = await sharp(f.path).rotate().toBuffer();
      fs.writeFileSync(target + '.tmp', buf);
      fs.renameSync(target + '.tmp', target);
      out.push({ from: f.path, to: target });
    } catch (e) {
      fails.push({ path: f.path, error: e.message });
    }
  }
  return { ok: true, rotated: out, failed: fails };
});

ipcMain.handle('images:heicToJpg', async (_, { files, quality, outputFolder }) => {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: 'sharp not available' };
  const out = [];
  const fails = [];
  const q = Math.max(1, Math.min(100, parseInt(quality, 10) || 92));
  for (const f of files) {
    if (!/\.heic|\.heif/i.test(f.path)) { fails.push({ path: f.path, error: 'not a HEIC file' }); continue; }
    try {
      // HEIC always produces JPG (extension change). No "overwrite" mode
      // here — originals are always kept (the user would lose data
      // otherwise). outputFolder lands the JPG in the chosen destination.
      const target = resolveImageOut({ srcPath: f.path, overwrite: false, outputFolder, suffix: '', ext: 'jpg' });
      await sharp(f.path).rotate().jpeg({ quality: q, mozjpeg: true }).toFile(target);
      out.push({ from: f.path, to: target });
    } catch (e) {
      fails.push({ path: f.path, error: e.message });
    }
  }
  return { ok: true, converted: out, failed: fails };
});

// Pick a sharp-WRITABLE output format. `requested` = an explicit extension
// ('' / null = keep the source's). Inputs sharp can read but not encode
// (svg, heic/heif, bmp, jxl…) fall back to PNG so the op never fails.
const SHARP_WRITABLE = new Set(['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif']);
function pickOutFormat(input, requested) {
  let f = (requested || '').toLowerCase();
  if (!f) f = path.extname(input).slice(1).toLowerCase();
  if (f === 'jpg') f = 'jpeg';
  if (!SHARP_WRITABLE.has(f)) f = 'png';
  return { toFmt: f, outExt: f === 'jpeg' ? 'jpg' : f };
}

// Single-image crop (XTRACT > Image). Coordinates are pixels in the source.
ipcMain.handle('images:crop', async (_, { input, x, y, width, height, output, format }) => {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: 'sharp not available' };
  try {
    const { toFmt, outExt } = pickOutFormat(input, format);
    const target = output || input.replace(/\.[^.]+$/, '-crop.' + outExt);
    await sharp(input).rotate().extract({
      left:   Math.max(0, Math.round(x)),
      top:    Math.max(0, Math.round(y)),
      width:  Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height))
    }).toFormat(toFmt).toFile(target + '.tmp');
    fs.renameSync(target + '.tmp', target);
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Replace one colour with another across the whole image (XTRACT > Image).
// Raw-pixel pass: any pixel whose R/G/B are each within `tolerance` (0-100%,
// mapped to 0-255) of `from` is rewritten to `to`. Alpha is preserved.
ipcMain.handle('images:replaceColor', async (_, { input, from, to, tolerance, output }) => {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: 'sharp not available' };
  try {
    const hex = h => { h = String(h || '').replace('#', ''); return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0]; };
    const [fr, fg, fb] = hex(from);
    const [tr, tg, tb] = hex(to);
    const tolPx = Math.round(Math.max(0, Math.min(100, tolerance ?? 10)) / 100 * 255);
    const { data, info } = await sharp(input).rotate().raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    for (let i = 0; i < data.length; i += ch) {
      if (Math.abs(data[i] - fr) <= tolPx && Math.abs(data[i + 1] - fg) <= tolPx && Math.abs(data[i + 2] - fb) <= tolPx) {
        data[i] = tr; data[i + 1] = tg; data[i + 2] = tb;
      }
    }
    const { toFmt, outExt } = pickOutFormat(input, null);
    const target = output || input.replace(/\.[^.]+$/, '-recolor.' + outExt);
    await sharp(data, { raw: { width: info.width, height: info.height, channels: ch } })
      .toFormat(toFmt).toFile(target + '.tmp');
    fs.renameSync(target + '.tmp', target);
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Classic sepia color matrix — applied via sharp.recomb(). Same values
// Photoshop uses for the "Sepia" preset filter. The 3 rows are R,G,B
// coefficients; each output channel is a weighted sum of input RGB.
const SEPIA_MATRIX = [
  [0.393, 0.769, 0.189],
  [0.349, 0.686, 0.168],
  [0.272, 0.534, 0.131]
];

// XTRACT > Image > Effects. Each effect maps to a sharp pipeline step.
// Defaults (brightness/contrast/saturation = 100, hue = 0, blur/sharpen = 0
// and all toggles off) are no-ops — only non-default values produce a step.
ipcMain.handle('images:applyEffects', async (_, {
  input, output, brightness, contrast, saturation, hue, blur, sharpen,
  grayscale, sepia, invert
}) => {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: 'sharp not available' };
  try {
    // Normalise inputs — accept loose strings/numbers from the renderer.
    const b = Number(brightness ?? 100) / 100;     // 1.0 = no change
    const c = Number(contrast   ?? 100) / 100;
    const s = Number(saturation ?? 100) / 100;
    const h = Number(hue        ?? 0);
    const bl = Math.max(0, Number(blur    ?? 0));
    const sh = Math.max(0, Number(sharpen ?? 0));

    let pipe = sharp(input).rotate();

    // modulate() handles brightness + saturation (multipliers) + hue
    // (degrees rotation). Only call when any value diverges from default —
    // sharp's docs say no-op values can still trigger LUT building.
    if (b !== 1 || s !== 1 || h !== 0) {
      pipe = pipe.modulate({ brightness: b, saturation: s, hue: h });
    }
    // linear(a, b) computes a*pixel + b. Standard contrast formula: scale
    // around the midpoint (128) so brightness stays anchored.
    if (c !== 1) {
      pipe = pipe.linear(c, 128 * (1 - c));
    }
    // The boolean toggles compose in this order: grayscale strips colour,
    // then sepia tints, then invert flips. Order matches Photoshop's
    // adjustment-layer stacking.
    if (grayscale) pipe = pipe.grayscale();
    if (sepia)     pipe = pipe.recomb(SEPIA_MATRIX);
    if (invert)    pipe = pipe.negate({ alpha: false });
    if (bl > 0)    pipe = pipe.blur(bl);
    if (sh > 0)    pipe = pipe.sharpen({ sigma: sh });

    const target = output || input.replace(/(\.[^.]+)$/, '-fx$1');
    // Atomic write: tmp + rename so a failed encode doesn't truncate a
    // file already on disk.
    await pipe.toFile(target + '.tmp');
    fs.renameSync(target + '.tmp', target);
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Bulk watermark — overlays a text string on every selected image. Position
// is one of the 9 anchor points (tl/tc/tr/ml/mc/mr/bl/bc/br); colour, font
// size, opacity, and optional drop shadow are configurable. The watermark
// itself is generated as an SVG that sharp composites natively — much
// faster than rasterising text via canvas, and the SVG scales with the
// font-size input without aliasing.
ipcMain.handle('images:watermark', async (_, {
  files, text, fontSize = 32, color = '#ffffff', opacity = 0.7,
  position = 'br', padding = 24, shadow = true, overwrite, outputFolder
}) => {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: 'sharp not available' };
  if (!text) return { ok: false, error: 'text required' };
  const safeText = String(text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const op = Math.max(0, Math.min(1, Number(opacity)));
  const fSize = Math.max(8, Math.min(512, parseInt(fontSize, 10) || 32));
  const out = [];
  const fails = [];

  for (const f of files) {
    try {
      const meta = await sharp(f.path).metadata();
      const W = meta.width || 1, H = meta.height || 1;
      // SVG canvas matches image dimensions so the text-anchor calculation
      // is in image pixel space. text-anchor picks the right corner of
      // the text bounding box (start/middle/end ↔ left/center/right).
      const tx = position.endsWith('l') ? padding
               : position.endsWith('r') ? W - padding
               :                          W / 2;
      const ty = position.startsWith('t') ? padding + fSize
               : position.startsWith('b') ? H - padding
               :                            H / 2;
      const anchor = position.endsWith('l') ? 'start'
                   : position.endsWith('r') ? 'end'
                   :                          'middle';
      const shadowDef = shadow
        ? `<filter id="s" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="2" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.6"/></filter>`
        : '';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
        `<defs>${shadowDef}</defs>` +
        `<text x="${tx}" y="${ty}" font-family="sans-serif" font-size="${fSize}" ` +
        `font-weight="bold" fill="${color}" fill-opacity="${op}" text-anchor="${anchor}" ` +
        (shadow ? `filter="url(#s)" ` : '') + `>${safeText}</text></svg>`;
      const target = resolveImageOut({ srcPath: f.path, overwrite, outputFolder, suffix: '-wm' });
      await sharp(f.path).rotate()
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .toFile(target + '.tmp');
      fs.renameSync(target + '.tmp', target);
      out.push({ from: f.path, to: target });
    } catch (e) {
      fails.push({ path: f.path, error: e.message });
    }
  }
  return { ok: true, watermarked: out, failed: fails };
});

// Compress to target file size — bisects quality from 1-95 until the
// output file is at or below the requested size. JPEG/WebP/AVIF respect
// quality; PNG falls back to compressionLevel sweep instead.
ipcMain.handle('images:compressToSize', async (_, { files, targetKb, format, overwrite, outputFolder }) => {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: 'sharp not available' };
  const out = [];
  const fails = [];
  const targetBytes = Math.max(1, parseInt(targetKb, 10) || 0) * 1024;
  if (!targetBytes) return { ok: false, error: 'target size required' };
  const fmt = (format || 'jpg').toLowerCase();
  const ext = fmt === 'jpeg' ? 'jpg' : fmt;

  for (const f of files) {
    try {
      // Binary search quality in [5, 95]. Each step encodes to a buffer
      // (no disk write) until we find the highest quality that fits.
      let lo = 5, hi = 95, best = null, iters = 0;
      while (lo <= hi && iters < 10) {
        const q = Math.floor((lo + hi) / 2);
        let pipe = sharp(f.path).rotate();
        if      (fmt === 'jpg' || fmt === 'jpeg') pipe = pipe.jpeg({ quality: q, mozjpeg: true });
        else if (fmt === 'webp')                  pipe = pipe.webp({ quality: q });
        else if (fmt === 'avif')                  pipe = pipe.avif({ quality: q });
        else if (fmt === 'png') {
          // PNG quality lever is compressionLevel 0-9. Higher = more CPU,
          // smaller file. Sweep 0..9 instead of quality.
          pipe = pipe.png({ compressionLevel: Math.round(9 * (95 - q) / 90) });
        }
        else throw new Error('unsupported format: ' + fmt);
        const buf = await pipe.toBuffer();
        if (buf.length <= targetBytes) {
          best = { q, buf };
          lo = q + 1;  // try higher quality
        } else {
          hi = q - 1;  // need smaller, lower quality
        }
        iters++;
      }
      if (!best) {
        fails.push({ path: f.path, error: `cannot reach target size (image too complex even at quality=5)` });
        continue;
      }
      const target = resolveImageOut({ srcPath: f.path, overwrite, outputFolder, suffix: '-shrunk', ext });
      fs.writeFileSync(target + '.tmp', best.buf);
      fs.renameSync(target + '.tmp', target);
      if (overwrite && target !== f.path && fs.existsSync(f.path)) {
        try { fs.unlinkSync(f.path); } catch {}
      }
      out.push({ from: f.path, to: target, quality: best.q, size: best.buf.length });
    } catch (e) {
      fails.push({ path: f.path, error: e.message });
    }
  }
  return { ok: true, compressed: out, failed: fails };
});

// Perceptual hash (dHash) for image duplicate finding. Resize to 9x8 grey,
// compare each pixel to its right neighbour: 64-bit fingerprint. Files
// with Hamming distance ≤ 8 (12.5% bit diff) are grouped as duplicates.
// Catches same image at different resolutions / formats / minor edits.
ipcMain.handle('images:dedup', async (event, { paths, threshold }) => {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: 'sharp not available' };
  if (!Array.isArray(paths) || paths.length < 2) return { ok: false, error: 'need ≥2 files' };
  const maxDist = typeof threshold === 'number' ? Math.max(0, Math.min(64, threshold)) : 8;

  const safeSend = (ch, data) => { try { event.sender.send(ch, data); } catch {} };
  const fps = [];
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    safeSend('images:dedupProgress', { line: `hashing ${require('path').basename(p)} (${i+1}/${paths.length})`, progress: i / paths.length });
    try {
      // 9x8 grey buffer = 72 bytes. Compare horizontal pairs → 64-bit hash.
      const buf = await sharp(p).rotate().resize(9, 8, { fit: 'fill' }).grayscale().raw().toBuffer();
      // Build the hash as a Uint8Array of 8 bytes (one bit per pixel pair).
      const hash = new Uint8Array(8);
      for (let row = 0; row < 8; row++) {
        let byte = 0;
        for (let col = 0; col < 8; col++) {
          const a = buf[row * 9 + col];
          const b = buf[row * 9 + col + 1];
          if (a < b) byte |= (1 << col);
        }
        hash[row] = byte;
      }
      const stat = fs.statSync(p);
      fps.push({ path: p, hash, size: stat.size });
    } catch (e) {
      log('WARN', `images:dedup skipped ${p}: ${e.message}`);
    }
  }
  // Pairwise Hamming distance + union-find grouping (mirrors audio dedup).
  safeSend('images:dedupProgress', { line: 'comparing hashes…', progress: 0.95 });
  const popcount8 = (n) => {
    n = n - ((n >> 1) & 0x55);
    n = (n & 0x33) + ((n >> 2) & 0x33);
    return (n + (n >> 4)) & 0x0f;
  };
  const parent = fps.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < fps.length; i++) {
    for (let j = i + 1; j < fps.length; j++) {
      let dist = 0;
      for (let k = 0; k < 8; k++) dist += popcount8(fps[i].hash[k] ^ fps[j].hash[k]);
      if (dist <= maxDist) union(i, j);
    }
  }
  const byRoot = new Map();
  for (let i = 0; i < fps.length; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(fps[i]);
  }
  const groups = [];
  for (const arr of byRoot.values()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => b.size - a.size);
    groups.push(arr.map(({ path, size }) => ({ path, size })));
  }
  safeSend('images:dedupProgress', { line: `done — ${groups.length} group(s)`, progress: 1 });
  return { ok: true, groups, scanned: fps.length, skipped: paths.length - fps.length };
});

// Group VISUALLY-SIMILAR photos (burst shots, near-identical frames) and rank
// each group so the SHARPEST / highest-resolution shot is suggested as the one
// to keep. Reuses the dHash + Hamming/union-find grouping from images:dedup,
// then adds a focus score (variance of a Laplacian response, measured on a
// resolution-normalised greyscale crop) and a megapixel score per image.
// The combined score (0.7·sharpness + 0.3·resolution, normalised within each
// group) decides the suggested "best". The renderer shows a thumbnail gallery
// and lets the user override the keeper before trashing the rest.
async function laplacianVariance(sharp, p) {
  // Normalise to a fixed size first so focus is comparable across resolutions
  // (a big blurry photo shouldn't beat a small sharp one just on pixel count).
  const buf = await sharp(p).rotate().grayscale().resize(320, 240, { fit: 'fill' })
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
    .raw().toBuffer();
  let sum = 0, sum2 = 0; const n = buf.length || 1;
  for (let i = 0; i < buf.length; i++) { const v = buf[i]; sum += v; sum2 += v * v; }
  const mean = sum / n;
  return Math.max(0, sum2 / n - mean * mean);
}

ipcMain.handle('images:groupSimilar', async (event, { paths, threshold }) => {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: 'sharp not available' };
  if (!Array.isArray(paths) || paths.length < 2) return { ok: false, error: 'need ≥2 files' };
  const maxDist = typeof threshold === 'number' ? Math.max(0, Math.min(64, threshold)) : 10;
  const pathMod = require('path');
  const safeSend = (ch, data) => { try { event.sender.send(ch, data); } catch {} };

  const items = [];
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    safeSend('images:similarProgress', { line: `analyzing ${pathMod.basename(p)} (${i + 1}/${paths.length})`, progress: (i / paths.length) * 0.9 });
    try {
      const buf = await sharp(p).rotate().resize(9, 8, { fit: 'fill' }).grayscale().raw().toBuffer();
      const hash = new Uint8Array(8);
      for (let row = 0; row < 8; row++) {
        let byte = 0;
        for (let col = 0; col < 8; col++) { if (buf[row * 9 + col] < buf[row * 9 + col + 1]) byte |= (1 << col); }
        hash[row] = byte;
      }
      const meta = await sharp(p).metadata();
      const width = meta.width || 0, height = meta.height || 0;
      const sharpness = await laplacianVariance(sharp, p);
      const stat = fs.statSync(p);
      items.push({ path: p, hash, size: stat.size, width, height, sharpness });
    } catch (e) {
      log('WARN', `images:groupSimilar skipped ${p}: ${e.message}`);
    }
  }

  safeSend('images:similarProgress', { line: 'grouping…', progress: 0.95 });
  const popcount8 = (n) => { n = n - ((n >> 1) & 0x55); n = (n & 0x33) + ((n >> 2) & 0x33); return (n + (n >> 4)) & 0x0f; };
  const parent = items.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      let dist = 0;
      for (let k = 0; k < 8; k++) dist += popcount8(items[i].hash[k] ^ items[j].hash[k]);
      if (dist <= maxDist) union(i, j);
    }
  }
  const byRoot = new Map();
  for (let i = 0; i < items.length; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(items[i]);
  }
  const groups = [];
  for (const arr of byRoot.values()) {
    if (arr.length < 2) continue;
    const maxSharp = Math.max(...arr.map(x => x.sharpness)) || 1;
    const maxMp    = Math.max(...arr.map(x => x.width * x.height)) || 1;
    const scored = arr.map(x => {
      const mp = x.width * x.height;
      const sharpRel = x.sharpness / maxSharp;
      const resRel = mp / maxMp;
      return {
        path: x.path, size: x.size, width: x.width, height: x.height,
        megapixels: mp / 1e6,
        sharpness: Math.round(x.sharpness),
        sharpRel,                                  // 0..1 within group (for the UI bar)
        score: 0.7 * sharpRel + 0.3 * resRel
      };
    });
    scored.sort((a, b) => b.score - a.score);
    scored.forEach((x, i) => { x.best = i === 0; });
    groups.push(scored);
  }
  // Largest groups first — most decisions to make at the top.
  groups.sort((a, b) => b.length - a.length);
  safeSend('images:similarProgress', { line: `done — ${groups.length} group(s)`, progress: 1 });
  return { ok: true, groups, scanned: items.length, skipped: paths.length - items.length };
});

// Image sequence → video (timelapse / slideshow). Uses ffmpeg's image2
// demuxer with a temp folder of symlinked / copied images at sequential
// names (frame_0001.jpg etc.) so ffmpeg can read them in order.
ipcMain.handle('images:toVideo', async (event, { files, fps = 24, output, format = 'mp4', opId }) => {
  if (!Array.isArray(files) || !files.length) return { ok: false, error: 'no files' };
  const ffmpeg = getFfmpegPath();
  if (!ffmpeg) return { ok: false, error: 'ffmpeg not available' };
  const fpsN = Math.max(1, Math.min(60, parseInt(fps, 10) || 24));
  // Stage frames into a temp dir with zero-padded names — image2 demuxer
  // requires a numeric sequence.
  const tmpDir = path.join(os.tmpdir(), `flux-imgseq-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    for (let i = 0; i < files.length; i++) {
      const src = files[i].path || files[i];
      const ext = path.extname(src).slice(1).toLowerCase() || 'jpg';
      // ffmpeg image2 wants identical extensions per glob; we copy with
      // padded numeric names. Copy (not symlink) because Windows symlinks
      // need elevation and we want this to work portably.
      fs.copyFileSync(src, path.join(tmpDir, `f_${String(i + 1).padStart(5, '0')}.${ext}`));
    }
    const firstExt = path.extname(files[0].path || files[0]).slice(1).toLowerCase() || 'jpg';
    const target = output || (files[0].path || files[0]).replace(/[^\\/]+$/, '') + `timelapse-${Date.now()}.${format}`;
    // -framerate before -i sets the INPUT fps (how fast to read frames);
    // -r AFTER sets the output frame rate. Setting both equal yields a
    // straight timelapse where each image = 1 frame at the chosen rate.
    const args = [
      '-hide_banner', '-y',
      '-framerate', String(fpsN),
      '-i', path.join(tmpDir, `f_%05d.${firstExt}`),
      '-c:v', format === 'webm' ? 'libvpx-vp9' : 'libx264',
      '-pix_fmt', 'yuv420p',
      '-r', String(fpsN),
      target
    ];
    const r = await ffmpegRun(event, args, target, opId);
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    // Best-effort cleanup of the temp staging dir.
    try {
      for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
      fs.rmdirSync(tmpDir);
    } catch {}
  }
});

// ─── IPC: AUDIO DUPLICATE FINDER (Chromaprint-based) ────────────────────────
// Given a list of audio paths, fingerprint each with fpcalc -raw, then group
// files that match within a Hamming-distance threshold over the first N
// hashes (~6s of audio). Two paths emit progress so the renderer can show
// a moving bar during the (potentially long) fingerprinting pass.
ipcMain.handle('audio:dedup', async (event, { paths, threshold }) => {
  if (!Array.isArray(paths) || !paths.length) {
    return { ok: false, error: 'no files to scan' };
  }
  const fpcalc = getFpcalcPath();
  if (!fpcalc) return { ok: false, error: 'fpcalc binary not bundled — rebuild FLUX' };
  const COMPARE_HASHES   = 50;      // ~6 seconds of audio at 8 hashes/sec
  const SIMILARITY_FLOOR = (typeof threshold === 'number' ? threshold : 0.85);
  // Pre-load file stats — we need size + bitrate to pick the "best" file
  // in each group later. Bitrate is computed from size + duration after the
  // fingerprint pass (duration comes free with -raw output, but parsing it
  // adds complexity; we re-stat after).
  const send = (line, progress) => safeSend(event.sender, 'audio:dedupProgress', { line, progress });
  const fingerprints = [];
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    send(`fingerprinting ${path.basename(p)} (${i + 1}/${paths.length})`, i / paths.length);
    try {
      const fp = await runFpcalcRaw(fpcalc, p);
      const size = fs.statSync(p).size;
      fingerprints.push({ path: p, hashes: fp.hashes.slice(0, COMPARE_HASHES), size });
    } catch (e) {
      log('WARN', `dedup: skipped ${p}: ${e.message}`);
      // Skip files that fpcalc can't read (corrupt, unsupported format) —
      // they simply don't participate in dedup, no hard failure.
    }
  }
  send('comparing fingerprints…', 0.95);
  // Pairwise Hamming distance. Quadratic in file count but each compare is
  // ~50 XORs+popcount, so 1000 files = 500k×50 = ~25M ops, sub-second.
  // O(n²) is fine up to ~5000 files; if you have more, the user will need
  // to scan in smaller batches (UX TODO).
  const TOTAL_BITS = COMPARE_HASHES * 32;
  const SIM_BITS_MIN = Math.floor(TOTAL_BITS * SIMILARITY_FLOOR);
  const popcount = (n) => {
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    n = (n + (n >>> 4)) & 0x0f0f0f0f;
    return (n * 0x01010101) >>> 24;
  };
  // Union-find over file indices — files that match get unioned, then we
  // collect groups in one pass.
  const parent = new Array(fingerprints.length).fill(0).map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < fingerprints.length; i++) {
    for (let j = i + 1; j < fingerprints.length; j++) {
      const a = fingerprints[i].hashes, b = fingerprints[j].hashes;
      const lim = Math.min(a.length, b.length);
      if (lim < COMPARE_HASHES) continue;       // too short, skip
      let same = 0;
      for (let k = 0; k < lim; k++) {
        same += 32 - popcount(a[k] ^ b[k]);
      }
      if (same >= SIM_BITS_MIN) union(i, j);
    }
  }
  // Materialise groups: only those with ≥2 members are duplicates.
  const byRoot = new Map();
  for (let i = 0; i < fingerprints.length; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(fingerprints[i]);
  }
  const groups = [];
  for (const arr of byRoot.values()) {
    if (arr.length < 2) continue;
    // Sort by size desc (proxy for "highest bitrate" since same audio at
    // higher bitrate yields a larger file). First entry = the "best" one to
    // keep by default.
    arr.sort((a, b) => b.size - a.size);
    groups.push(arr.map(({ path, size }) => ({ path, size })));
  }
  send(`done — ${groups.length} duplicate group(s) found`, 1);
  return { ok: true, groups, scanned: fingerprints.length, skipped: paths.length - fingerprints.length };
});

// Name-based dedup — no fingerprint cost. Normalises filenames (strip
// extension, lowercase, collapse separators, drop common dupe suffixes like
// "(2)", "[copy]", "- copy", " copy 2", " copia") and groups files whose
// normalised name is IDENTICAL. Trivial cases like
// "Song.mp3" + "Song (2).mp3" + "Song - copy.mp3" all collapse together.
// Returns the same shape as audio:dedup so the renderer can render either.
ipcMain.handle('audio:dedupByName', async (_, { paths }) => {
  if (!Array.isArray(paths) || !paths.length) {
    return { ok: false, error: 'no files to scan' };
  }
  const normalise = (p) => {
    let n = p.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    n = n.toLowerCase();
    // Drop common copy-suffix patterns (English + Italian + Spanish).
    n = n.replace(/\s*[-_]?\s*(copy|copia|copie|kopie|copia\s+di|copy\s+\d+|\(\d+\)|\[\d+\]|\[copy\]|\[copia\])\s*$/gi, '');
    // Collapse separators + whitespace.
    n = n.replace(/[._\-\s]+/g, ' ').trim();
    return n;
  };
  const byNorm = new Map();
  for (const p of paths) {
    let size = 0;
    try { size = fs.statSync(p).size; } catch { continue; }
    const key = normalise(p);
    if (!key) continue;
    if (!byNorm.has(key)) byNorm.set(key, []);
    byNorm.get(key).push({ path: p, size });
  }
  const groups = [];
  for (const arr of byNorm.values()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => b.size - a.size); // largest first = keep candidate
    groups.push(arr);
  }
  return { ok: true, groups, scanned: paths.length, skipped: 0 };
});

ipcMain.handle('audio:trashFiles', async (_, { paths }) => {
  if (!Array.isArray(paths) || !paths.length) return { ok: false, error: 'no paths' };
  const trashed = [];
  const failed  = [];
  for (const p of paths) {
    try {
      await shell.trashItem(p);
      trashed.push(p);
    } catch (e) {
      failed.push({ path: p, error: e.message });
    }
  }
  return { ok: true, trashed, failed };
});

// ─── Track detection + split ────────────────────────────────────────────────
// Two-step pipeline for the classic "YouTube full album" use case:
//   1. detectTracks → cascade through chapter metadata, then ffmpeg
//      silencedetect, returns candidate boundaries the user can edit.
//   2. splitTracks → executes the actual cuts with ffmpeg stream-copy when
//      possible (instant, lossless) or transcode when the input codec can't
//      be cleanly cut.
ipcMain.handle('audio:detectTracks', async (_, { input, noiseDb = -30, minSilence = 1.5 } = {}) => {
  try {
    if (!input || !fs.existsSync(input)) return { ok: false, error: 'file not found' };
    const ffmpegPath = getFfmpegPath();
    if (!ffmpegPath) return { ok: false, error: 'ffmpeg not bundled' };

    // ── Step 1: try chapter metadata via ffprobe (or ffmpeg with -f ffmetadata)
    // ffmpeg embeds ffprobe-like data probing when called with -hide_banner
    // and a non-existent output (`-f null -`) — we already use that pattern
    // for silencedetect below. For chapters we use `-show_chapters` on
    // ffmpeg's chapter dump format which is JSON-parseable.
    const chapters = await new Promise(resolve => {
      const args = ['-hide_banner', '-i', input, '-f', 'ffmetadata', '-'];
      const proc = spawn(ffmpegPath, args);
      let buf = '';
      proc.stdout.on('data', d => { buf += d.toString(); });
      proc.on('close', () => {
        // ffmetadata1 format: each [CHAPTER] block has TIMEBASE, START, END,
        // and an optional `title=` line. Times are integers in timebase units.
        const out = [];
        const re = /\[CHAPTER\][\s\S]*?TIMEBASE=([^\n]+)\s+START=(\d+)\s+END=(\d+)(?:\s+title=([^\n]+))?/g;
        let m;
        while ((m = re.exec(buf)) !== null) {
          const [, tb, startStr, endStr, titleRaw] = m;
          // TIMEBASE is "1/1000" or "1/1000000000" — divide num by denom.
          const tbParts = tb.split('/');
          const denom = parseInt(tbParts[1], 10) || 1;
          out.push({
            start: parseInt(startStr, 10) / denom,
            end:   parseInt(endStr,   10) / denom,
            title: titleRaw ? titleRaw.trim() : ''
          });
        }
        resolve(out);
      });
      proc.on('error', () => resolve([]));
    });
    if (chapters.length >= 2) {
      log('INFO', `audio:detectTracks: ${chapters.length} chapter(s) from metadata`);
      return { ok: true, source: 'chapters', tracks: chapters };
    }

    // ── Step 2: silencedetect fallback. The filter prints lines like:
    //     [silencedetect @ 0x...] silence_start: 184.32
    //     [silencedetect @ 0x...] silence_end: 186.84 | silence_duration: 2.52
    // We collect those + the total duration, then derive track boundaries
    // by taking the MIDPOINT of each silence span as the cut.
    const filter = `silencedetect=noise=${noiseDb}dB:d=${minSilence}`;
    const stderr = await new Promise(resolve => {
      const args = ['-hide_banner', '-nostats', '-i', input, '-af', filter, '-f', 'null', '-'];
      const proc = spawn(ffmpegPath, args);
      let buf = '';
      proc.stderr.on('data', d => { buf += d.toString(); });
      proc.on('close', () => resolve(buf));
      proc.on('error', () => resolve(''));
    });
    const silences = [];
    const reStart = /silence_start:\s*([0-9.]+)/g;
    const reEnd   = /silence_end:\s*([0-9.]+)/g;
    const starts = [...stderr.matchAll(reStart)].map(m => parseFloat(m[1]));
    const ends   = [...stderr.matchAll(reEnd)].map(m => parseFloat(m[1]));
    for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
      silences.push({ start: starts[i], end: ends[i] });
    }
    // Full duration — pulled from ffmpeg's "Duration: HH:MM:SS.xx" line.
    const durMatch = /Duration:\s+(\d+):(\d+):([\d.]+)/.exec(stderr);
    let total = 0;
    if (durMatch) {
      total = (+durMatch[1]) * 3600 + (+durMatch[2]) * 60 + parseFloat(durMatch[3]);
    }
    if (!total) return { ok: false, error: 'could not determine duration' };
    // Cut points = midpoint of each silence span. Track i spans (cut[i-1],
    // cut[i]); first track starts at 0, last track ends at total duration.
    const cuts = silences.map(s => (s.start + s.end) / 2);
    const tracks = [];
    let prev = 0;
    for (const cut of cuts) {
      if (cut - prev > 5) {     // ignore micro-segments < 5 s, almost certainly noise
        tracks.push({ start: prev, end: cut, title: '' });
        prev = cut;
      }
    }
    if (total - prev > 5) tracks.push({ start: prev, end: total, title: '' });
    log('INFO', `audio:detectTracks: silencedetect found ${tracks.length} segment(s)`);
    return { ok: true, source: 'silence', tracks, totalDuration: total };
  } catch (e) {
    log('ERROR', `audio:detectTracks: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

// Slice the source into one file per track. Uses stream-copy (-c copy)
// whenever the input codec is in a "cleanly cuttable" set; falls back to
// transcoding to MP3 otherwise. Output naming: "NN - <title>.<ext>" in a
// dedicated subfolder so the source folder doesn't get cluttered.
ipcMain.handle('audio:splitTracks', async (event, { input, tracks, format = 'auto' } = {}) => {
  try {
    if (!input || !fs.existsSync(input)) return { ok: false, error: 'file not found' };
    if (!Array.isArray(tracks) || !tracks.length) return { ok: false, error: 'no tracks provided' };
    const ffmpegPath = getFfmpegPath();
    if (!ffmpegPath) return { ok: false, error: 'ffmpeg not bundled' };

    const srcDir  = path.dirname(input);
    const srcBase = path.basename(input, path.extname(input));
    const srcExt  = path.extname(input).slice(1).toLowerCase();
    const outDir  = path.join(srcDir, `${srcBase}-tracks`);
    fs.mkdirSync(outDir, { recursive: true });

    // Pick the output container/codec. "auto" tries stream-copy in the
    // source extension; otherwise the user-requested format wins. Stream-
    // copy is instant + lossless for mp3/m4a/flac/opus/ogg; not safe for
    // wav→mp3 etc. (would need decode).
    const cuttable = ['mp3', 'm4a', 'aac', 'flac', 'opus', 'ogg'];
    const useCopy  = format === 'auto' && cuttable.includes(srcExt);
    const outExt   = useCopy ? srcExt : (format === 'auto' ? 'mp3' : format);

    const saved = [];
    const failed = [];
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const num = String(i + 1).padStart(2, '0');
      const safeTitle = (t.title || '').toString().replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 100).trim();
      const fileName = safeTitle ? `${num} - ${safeTitle}.${outExt}` : `${num} - track.${outExt}`;
      const outPath = path.join(outDir, fileName);
      const duration = Math.max(0.1, t.end - t.start);
      const args = ['-y', '-hide_banner', '-loglevel', 'error',
        '-ss', String(t.start),
        '-i', input,
        '-t', String(duration)];
      if (useCopy) {
        // -map 0 + -c copy preserves all tags; for albums extract only audio
        // (a YouTube "full album" video has video too — strip it).
        args.push('-vn', '-c:a', 'copy', '-map_metadata', '0');
      } else {
        args.push('-vn', '-c:a', outExt === 'mp3' ? 'libmp3lame' : (outExt === 'm4a' ? 'aac' : 'libmp3lame'),
                  '-b:a', '192k', '-id3v2_version', '3');
      }
      // Embed title + track number into the output metadata so the user's
      // edits become "real" tags. Album / artist fields stay empty so the
      // Tag Editor can auto-fill them via MusicBrainz on next ingest.
      if (t.title) args.push('-metadata', `title=${t.title}`);
      args.push('-metadata', `track=${i + 1}/${tracks.length}`);
      args.push(outPath);

      const code = await new Promise(resolve => {
        const proc = spawn(ffmpegPath, args);
        let err = '';
        proc.stderr.on('data', d => { err += d.toString(); });
        proc.on('close', code => resolve({ code, err }));
        proc.on('error', e => resolve({ code: -1, err: e.message }));
      });
      if (code.code === 0 && fs.existsSync(outPath)) {
        saved.push({ path: outPath, title: t.title || `Track ${i + 1}` });
      } else {
        failed.push({ index: i + 1, error: code.err?.slice(-300) || `ffmpeg exit ${code.code}` });
      }
    }
    log('INFO', `audio:splitTracks: ${saved.length}/${tracks.length} saved to ${outDir}`);
    return { ok: saved.length > 0, files: saved, failed, outDir };
  } catch (e) {
    log('ERROR', `audio:splitTracks: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

async function acoustidLookup(fingerprint, duration, apiKey) {
  const params = new URLSearchParams({
    format:      'json',
    client:      apiKey,
    meta:        'recordings+releasegroups+compress',
    duration:    String(Math.round(duration)),
    fingerprint: fingerprint
  });
  const url = `https://api.acoustid.org/v2/lookup?${params.toString()}`;
  // AcoustID returns 400 + JSON error body when the key is wrong or the
  // fingerprint is malformed. fetchAnyStatusJSON reads the body regardless of
  // status code so we can surface the actual server message instead of "HTTP 400".
  const r = await fetchAnyStatusJSON(url, 'FLUX/1.0.0', 20000);
  const data = r.body;
  if (!data) {
    return { ok: false, error: `AcoustID returned HTTP ${r.status} (no body)` };
  }
  if (data.status !== 'ok') {
    return { ok: false, error: data.error?.message || `AcoustID error (HTTP ${r.status})` };
  }
  const results = (data.results || []).filter(r => r.recordings && r.recordings.length);
  if (!results.length) return { ok: true, matches: [] };
  // Best result = highest score
  const best = results.sort((a, b) => b.score - a.score)[0];
  const rec = best.recordings[0];
  return {
    ok: true,
    score: best.score,
    title:    rec.title || null,
    artist:   (rec.artists || []).map(a => a.name).join('; ') || null,
    album:    (rec.releasegroups && rec.releasegroups[0]?.title) || null,
    mbid:     rec.id || null,
    matches:  results.length
  };
}

// "Download this song" → uses yt-dlp ytsearch1: to find and download top YouTube hit
ipcMain.handle('youtube:searchAndDownload', async (event, { query, format, downloadFolder }) =>
  runMediaDownloadRetry(event, `ytsearch1:${query}`, format || 'audio', downloadFolder, 1));

// Resolve a non-direct URL (YouTube watch page, podcast portal, etc.) to a
// playable HTTP media URL using yt-dlp. Returns the resolved direct URL plus
// the source title so the import-review modal can surface the actual matched
// track ("corrispondenza con ..."). Used by the topbar player + queue import.
ipcMain.handle('media:resolveStreamUrl', async (_, { url, kind = 'audio' } = {}) => {
  if (!url) return { ok: false, error: 'No URL provided' };
  const ytdlp = getYtDlpPath();
  if (!ytdlp) return { ok: false, error: 'yt-dlp not available' };
  const formatSel = kind === 'video' ? 'best[ext=mp4]/best' : 'bestaudio/best';
  return new Promise(resolve => {
    // --print emits one line per requested field, so we get
    //   <title>\n<resolved-url>\n
    // in deterministic order regardless of yt-dlp version quirks.
    const px = getYtDlpProxyArg();
    const args = [
      '--print', 'title',
      '--print', 'url',
      '-f', formatSel,
      '--no-warnings', '--no-playlist',
      url
    ];
    if (px) args.unshift('--proxy', px);
    const proc = spawn(ytdlp, args);
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('error', e => resolve({ ok: false, error: e.message }));
    proc.on('close', code => {
      const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
      const title    = lines.find(l => !/^https?:\/\//i.test(l)) || null;
      const direct   = lines.find(l =>  /^https?:\/\//i.test(l)) || null;
      if (code === 0 && direct) return resolve({ ok: true, url: direct, title });
      resolve({ ok: false, error: err.split('\n').filter(Boolean).pop() || `yt-dlp exit ${code}` });
    });
  });
});

// ─── SPOTIFY URL RESOLVER (gray-area, opt-in) ──────────────────────────────
// Resolves a public Spotify track/album/playlist URL into {title, artist,
// album, durationMs}. Uses oEmbed for single tracks and scrapes the public
// /embed/ page (__NEXT_DATA__ JSON) for collections. No DRM bypass — only
// metadata. Actual audio is fetched via YouTube search (youtube:searchAndDownload).
function fetchText(url, ua, timeout = 15000, _redirects = 0) {
  if (_redirects > 5) return Promise.reject(new Error('Too many redirects'));
  const mod = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = mod.get(url, {
      timeout,
      headers: {
        'User-Agent': ua || 'Mozilla/5.0 (compatible; FLUX/1.0)',
        'Accept': 'text/html,application/json,*/*'
      }
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        req.destroy();
        return fetchText(res.headers.location, ua, timeout, _redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { req.destroy(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function parseSpotifyUrl(input) {
  try {
    const u = new URL(String(input).trim());
    if (!/(^|\.)spotify\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/(track|album|playlist)\/([A-Za-z0-9]+)/);
    if (!m) return null;
    return { type: m[1], id: m[2] };
  } catch { return null; }
}

async function spotifyResolve(input) {
  const parsed = parseSpotifyUrl(input);
  if (!parsed) throw new Error('Invalid Spotify URL');
  const { type, id } = parsed;

  if (type === 'track') {
    const oembedUrl = `https://open.spotify.com/oembed?url=https://open.spotify.com/track/${id}`;
    const data = await fetchJSONWithUA(oembedUrl, 'FLUX/1.0.0 (https://github.com/dev001)');
    const title = data.title || `Spotify track ${id}`;
    const dash = title.indexOf(' - ');
    return {
      type, id, name: title,
      tracks: [{
        title:  dash > -1 ? title.slice(dash + 3).trim() : title,
        artist: dash > -1 ? title.slice(0, dash).trim() : '',
        album:  '',
        durationMs: 0
      }]
    };
  }

  const embedUrl = `https://open.spotify.com/embed/${type}/${id}`;
  const html = await fetchText(embedUrl, 'Mozilla/5.0 (compatible; FLUX/1.0; +https://github.com/dev001)');
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Spotify embed format changed — try again later');

  let next;
  try { next = JSON.parse(m[1]); }
  catch { throw new Error('Spotify embed JSON could not be parsed'); }

  const entity =
    next?.props?.pageProps?.state?.data?.entity ||
    next?.props?.pageProps?.entity ||
    next?.props?.pageProps?.data ||
    next?.props?.pageProps;
  if (!entity) throw new Error('Spotify response did not contain entity data');

  const list = entity.trackList || entity.tracks || entity.items || [];
  const tracks = [];
  for (const item of list) {
    const track = item.track || item;
    const title = track.title || track.name || '';
    const artist = (track.subtitle || (track.artists?.map(a => a.name).join(', ')) || '').trim();
    if (!title) continue;
    tracks.push({
      title,
      artist,
      album: track.album?.name || '',
      durationMs: track.duration || track.durationMs || 0,
      // 30-second MP3 preview hosted by Spotify's CDN (p.scdn.co). No auth
      // required for these URLs, so we can play them directly via <audio>.
      previewUrl: track.audioPreview?.url || null
    });
  }
  if (!tracks.length) throw new Error('No tracks found in Spotify response');

  return {
    type, id,
    name: entity.title || entity.name || `${type} ${id}`,
    tracks
  };
}

ipcMain.handle('spotify:resolve', async (_, url) => {
  try { return { ok: true, ...(await spotifyResolve(url)) }; }
  catch (e) { return { ok: false, error: e?.message || String(e) }; }
});

// ─── XTRACT: ffmpeg-driven local media operations ──────────────────────────
// All four operations share the same plumbing: spawn ffmpeg, parse stderr for
// progress ("time=HH:MM:SS"), resolve with the output path on exit code 0.
//
// Output path rule: same folder as input + suffix + extension. No prompts; the
// caller picks the format. Errors surface as { ok: false, error: ... }.

function ffmpegProbeDuration(inputPath) {
  // Best-effort duration parse: run ffmpeg with no output and read stderr.
  // ffmpeg always prints duration during initial codec sniffing.
  return new Promise(resolve => {
    const proc = spawn(getFfmpegPath(), ['-hide_banner', '-i', inputPath]);
    let buf = '';
    proc.stderr.on('data', d => buf += d.toString());
    proc.on('close', () => {
      const m = buf.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return resolve(0);
      resolve(parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]));
    });
    proc.on('error', () => resolve(0));
  });
}

function ffmpegRun(event, args, outputPath, opId) {
  return new Promise(async (resolve) => {
    const totalSec = opId ? await ffmpegProbeDuration(args[args.indexOf('-i') + 1]) : 0;
    const ffmpegBin = getFfmpegPath();
    log('INFO', `xtract: ${ffmpegBin} ${args.map(a => /\s/.test(a) ? `"${a}"` : a).join(' ')}`);
    const proc = spawn(ffmpegBin, args);
    let stderr = '';
    proc.stderr.on('data', d => {
      const chunk = d.toString();
      stderr += chunk;
      // Parse "time=HH:MM:SS.xx" → percentage if we know the total duration.
      const m = chunk.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m && totalSec > 0) {
        const cur = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
        const pct = Math.min(99, Math.round(cur / totalSec * 100));
        safeSend(event.sender, 'xtract:progress', { opId, pct });
      }
    });
    proc.on('error', e => resolve({ ok: false, error: `ffmpeg not found: ${e.message}` }));
    proc.on('close', code => {
      if (code !== 0) {
        log('ERROR', `xtract: ffmpeg exit ${code}: ${stderr.slice(-500)}`);
        return resolve({ ok: false, error: `ffmpeg exit ${code}: ${stderr.slice(-300)}` });
      }
      // ffmpeg returned 0 but the output may still be unusable (empty / no
      // streams) — e.g. trim with start >= end produces a 0-byte file and
      // exit 0. Surface that as an explicit error so the user doesn't think
      // it worked.
      let size = 0;
      try { size = fs.statSync(outputPath).size; } catch {}
      if (size < 1024) {
        log('WARN', `xtract: output ${outputPath} is ${size} bytes — likely empty`);
        return resolve({ ok: false, error: `Output is empty (${size} bytes). Check that start < end and times are within the file duration.` });
      }
      safeSend(event.sender, 'xtract:progress', { opId, pct: 100 });
      log('INFO', `xtract: ✓ ${outputPath} (${size} bytes)`);
      resolve({ ok: true, path: outputPath });
    });
  });
}

// All XTRACT outputs (audio/convert/trim/subs/frame/concat/meta/normalize) land
// in the user's configured FLUX download folder, not next to the source — so
// the source library stays untouched and one folder collects every edit.
function xtractOutputPath(inputPath, suffix, ext) {
  const cfg = loadConfig();
  const dir = cfg.download_folder || path.dirname(inputPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    log('WARN', `xtract: cannot create download folder ${dir}: ${e.message} — falling back to input folder`);
    return path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}${suffix}.${ext}`);
  }
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(dir, `${base}${suffix}.${ext}`);
}

// 1) Extract audio from any media file → mp3/flac/m4a/wav/opus
ipcMain.handle('xtract:audio', async (event, { input, format, opId }) => {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  const ext = format || 'mp3';
  const out = xtractOutputPath(input, '-audio', ext);
  // `-id3v2_version 3` + `-write_xing 1` fixes Windows Media Player which
  // refuses ID3v2.4 (ffmpeg default since ~5.0). Xing header is the standard
  // VBR sentinel — without it some players display the wrong duration.
  // Same fix applies to the trim path (TRIM_AUDIO_CODECS below) but the
  // audio-extract path is the main offender for "WMP won't open this".
  const codecArgs = {
    mp3:  ['-vn', '-c:a', 'libmp3lame', '-q:a', '0', '-id3v2_version', '3', '-write_xing', '1'],
    flac: ['-vn', '-c:a', 'flac'],
    m4a:  ['-vn', '-c:a', 'aac', '-b:a', '256k'],
    wav:  ['-vn', '-c:a', 'pcm_s16le'],
    opus: ['-vn', '-c:a', 'libopus', '-b:a', '160k']
  }[ext] || ['-vn'];
  const args = ['-hide_banner', '-y', '-i', input, ...codecArgs, out];
  return ffmpegRun(event, args, out, opId);
});

// 2) Convert format (video → other video/container, or audio → another audio)
ipcMain.handle('xtract:convert', async (event, { input, format, opId }) => {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  const ext = format || 'mp4';
  const out = xtractOutputPath(input, '-converted', ext);
  // Stream-copy when feasible (mp4↔mkv), re-encode otherwise.
  const inExt = path.extname(input).slice(1).toLowerCase();
  const containerOnly = ['mp4', 'mkv', 'webm', 'mov'].includes(ext) && ['mp4', 'mkv', 'webm', 'mov'].includes(inExt);
  const args = containerOnly
    ? ['-hide_banner', '-y', '-i', input, '-c', 'copy', out]
    : ['-hide_banner', '-y', '-i', input, out];
  return ffmpegRun(event, args, out, opId);
});

// 2b) Resize a video to a target height (keeps aspect; -2 = even width). H.264/AAC mp4.
ipcMain.handle('xtract:resize', async (event, { input, height, opId }) => {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  const h = parseInt(height, 10) || 720;
  const out = xtractOutputPath(input, `-${h}p`, 'mp4');
  const args = ['-hide_banner', '-y', '-i', input, '-vf', `scale=-2:${h}`, '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-c:a', 'aac', '-b:a', '160k', out];
  return ffmpegRun(event, args, out, opId);
});

// 2c) Compress a video (H.264 CRF; higher = smaller/lower quality, 28 ≈ good).
ipcMain.handle('xtract:compress', async (event, { input, crf, opId }) => {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  const q = Math.min(40, Math.max(18, parseInt(crf, 10) || 28));
  const out = xtractOutputPath(input, '-compressed', 'mp4');
  const args = ['-hide_banner', '-y', '-i', input, '-c:v', 'libx264', '-crf', String(q), '-preset', 'medium', '-c:a', 'aac', '-b:a', '128k', out];
  return ffmpegRun(event, args, out, opId);
});

// Parse "HH:MM:SS(.ms)" / "MM:SS" / "ss(.ms)" → seconds. Returns null on garbage.
function parseTimeToSeconds(s) {
  if (s == null) return null;
  const str = String(s).trim().replace(',', '.');
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  const parts = str.split(':');
  if (parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(parseFloat);
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  return null;
}

function formatSecondsHMS(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Audio codec args by container ext — used when trim needs re-encode (fades
// applied, can't stream-copy). Mirrors the xtract:audio handler.
const TRIM_AUDIO_CODECS = {
  // ID3v2.3 + Xing header — see xtract:audio handler for the WMP-compat rationale.
  mp3:  ['-c:a', 'libmp3lame', '-q:a', '0', '-id3v2_version', '3', '-write_xing', '1'],
  flac: ['-c:a', 'flac'],
  m4a:  ['-c:a', 'aac', '-b:a', '256k'],
  aac:  ['-c:a', 'aac', '-b:a', '256k'],
  wav:  ['-c:a', 'pcm_s16le'],
  ogg:  ['-c:a', 'libvorbis', '-q:a', '5'],
  opus: ['-c:a', 'libopus', '-b:a', '160k']
};

// Video output codec args (re-encode path when format change requested).
// MP4/MKV ship the same H.264+AAC payload; WebM uses VP9+Opus per spec.
const TRIM_VIDEO_CODECS = {
  mp4:  ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '192k'],
  mkv:  ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '192k'],
  webm: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-c:a', 'libopus', '-b:a', '128k']
};

// 3) Trim — fast lossless cut via -c copy. FLAC stores the original sample
// count in its STREAMINFO header and -c copy never rewrites it, so a trimmed
// FLAC would report the source duration to players. Re-encode FLAC (still
// lossless). -avoid_negative_ts make_zero guards mp4/mov where the seek lands
// before the first keyframe and ffmpeg would otherwise emit negative timestamps.
//
// When fadeIn / fadeOut > 0, ffmpeg needs to re-encode (filters incompatible
// with -c copy). Audio gets a format-appropriate codec; video falls back to
// stream copy + no fade (fades on video would need both -af and -vf which
// drops the fast-path benefit — out of scope for v1).
//
// Times are validated against the actual file duration before invoking ffmpeg:
// (a) catches the common slot mixup (HH:MM:SS positions filled as MM:SS:?? so
// what the user thinks is "10 seconds" becomes "10 minutes"), (b) catches
// re-trimming a previously-broken output (ffprobe returns 0 duration → bail
// with a helpful message instead of leaking the raw "Invalid data" error).
// Public probe — renderer needs duration for GIFs (WaveSurfer can't decode
// them) to pre-fill the trim end input. Reuses the internal helper.
ipcMain.handle('xtract:probeDuration', async (_, input) => {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'not found' };
  try {
    const dur = await ffmpegProbeDuration(input);
    return { ok: true, duration: dur };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Quick audio-presence check — scrapes ffmpeg -i stderr for any "Audio:" stream
// line. Used by the renderer to gate audio-only cards (Split, Extract audio,
// Normalize) on videos that ship with no audio track. Without this the UI
// shows those cards as runnable and ffmpeg fails later with "no audio stream
// to map" or produces a silent file.
ipcMain.handle('xtract:hasAudio', (_, input) => {
  if (!input || !fs.existsSync(input)) return Promise.resolve({ ok: false, error: 'not found' });
  return new Promise(resolve => {
    const proc = spawn(getFfmpegPath(), ['-hide_banner', '-i', input]);
    let buf = '';
    proc.stderr.on('data', d => buf += d.toString());
    proc.on('error', e => resolve({ ok: false, error: e.message }));
    proc.on('close', () => {
      const has = /Stream\s+#0:\d+(?:\[\w+\])?(?:\(\w+\))?:\s*Audio:/i.test(buf);
      resolve({ ok: true, hasAudio: has });
    });
  });
});

ipcMain.handle('xtract:trim', async (event, { input, start, end, fadeIn = 0, fadeOut = 0, outputFormat, opId, gif }) => {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  if (!start || !end) return { ok: false, error: 'Start and end required' };
  const startSec = parseTimeToSeconds(start);
  const endSec   = parseTimeToSeconds(end);
  if (startSec === null || endSec === null) {
    return { ok: false, error: `Invalid time format. Use HH:MM:SS, MM:SS or seconds (got start="${start}", end="${end}").` };
  }
  if (startSec >= endSec) {
    return { ok: false, error: `Start (${start} = ${startSec}s) must be before end (${end} = ${endSec}s).` };
  }
  const dur = await ffmpegProbeDuration(input);
  if (dur <= 0) {
    return { ok: false, error: 'Cannot read input duration — the file may be corrupted or in an unsupported format.' };
  }
  if (endSec > dur + 0.5) {
    return { ok: false, error: `End (${end}) is past file duration (${formatSecondsHMS(dur)}). Pick a value within the file length.` };
  }
  if (startSec >= dur) {
    return { ok: false, error: `Start (${start}) is past file duration (${formatSecondsHMS(dur)}).` };
  }
  const segDur = endSec - startSec;
  const fIn  = Math.max(0, Math.min(Number(fadeIn)  || 0, segDur));
  const fOut = Math.max(0, Math.min(Number(fadeOut) || 0, segDur));
  if (fIn + fOut > segDur) {
    return { ok: false, error: `Fade-in (${fIn}s) + fade-out (${fOut}s) exceed selection length (${segDur.toFixed(2)}s).` };
  }

  const inExt  = path.extname(input).slice(1).toLowerCase();
  const outExt = (outputFormat && String(outputFormat).toLowerCase()) || inExt || 'mp4';
  const formatChange = outExt !== inExt;
  const out = xtractOutputPath(input, '-trim', outExt);

  // GIF special-cases: no audio track exists on either end, and GIF output
  // needs a palette pass for decent colour (default ffmpeg gif encoder caps
  // at 256 colours globally — palettegen+paletteuse build a per-clip palette
  // for much better quality at the same size). Single-pass `filter_complex`
  // avoids the temp-file dance of the classic two-pass approach.
  const inIsGif  = inExt  === 'gif';
  const outIsGif = outExt === 'gif';

  const wantFades = fIn > 0 || fOut > 0;
  // Re-encode path required for fades OR when the output format differs from
  // the input. Pick the codec based on the OUTPUT container.
  if (wantFades || formatChange) {
    // ── GIF output branch — always re-encode through a palette filter.
    // fps=15 + 480-wide scale by default keeps the GIF reasonable (~2-5 MB
    // for a 10s clip). Fades aren't applied (no audio; visual fade-out on
    // GIF needs an alpha filter not worth the complexity for v1).
    if (outIsGif) {
      // User-tunable knobs with defensive defaults — bad values would just
      // break ffmpeg, so we clamp to sane ranges before substituting.
      const fps    = (gif && Number.isFinite(gif.fps))   ? Math.max(5, Math.min(30, gif.fps))   : 15;
      const widthN = (gif && Number.isFinite(gif.width)) ? gif.width                            : 480;
      // -1 = preserve source width (no scale filter); positive = target px.
      const scaleArg = widthN > 0 ? `scale=${widthN}:-1:flags=lanczos,` : '';
      // paletteuse supports several dither modes; bayer also takes a
      // bayer_scale parameter. Map our UI options to ffmpeg syntax.
      const dKind = (gif && gif.dither) || 'bayer';
      const ditherArg = dKind === 'bayer'           ? 'dither=bayer:bayer_scale=5:diff_mode=rectangle'
                      : dKind === 'sierra2'         ? 'dither=sierra2:diff_mode=rectangle'
                      : dKind === 'floyd_steinberg' ? 'dither=floyd_steinberg:diff_mode=rectangle'
                      :                                'dither=none:diff_mode=rectangle';
      const filter = `[0:v]fps=${fps},${scaleArg}split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=${ditherArg}`;
      const args = [
        '-hide_banner', '-y',
        '-ss', String(start), '-to', String(end),
        '-i', input,
        '-filter_complex', filter,
        '-loop', '0', '-an',
        out
      ];
      return ffmpegRun(event, args, out, opId);
    }
    const audioCodec = TRIM_AUDIO_CODECS[outExt];
    const videoCodec = TRIM_VIDEO_CODECS[outExt];
    let codecArgs;
    if (audioCodec && !videoCodec) {
      // Audio-only output: strip video, apply audio codec + any fade filter.
      const filters = [];
      if (fIn  > 0) filters.push(`afade=t=in:st=0:d=${fIn.toFixed(3)}`);
      if (fOut > 0) filters.push(`afade=t=out:st=${Math.max(0, segDur - fOut).toFixed(3)}:d=${fOut.toFixed(3)}`);
      codecArgs = ['-vn', ...(filters.length ? ['-af', filters.join(',')] : []), ...audioCodec];
    } else if (videoCodec) {
      // Video output: re-encode both streams; fade only the audio track.
      // GIF input has no audio track — strip the audio codec args from
      // videoCodec and skip audio fades. `-an` makes the absence explicit.
      if (inIsGif) {
        const noAudio = [];
        for (let i = 0; i < videoCodec.length; i++) {
          const a = videoCodec[i];
          if (a === '-c:a' || a === '-b:a') { i++; continue; }
          noAudio.push(a);
        }
        codecArgs = [...noAudio, '-an'];
      } else {
        const filters = [];
        if (fIn  > 0) filters.push(`afade=t=in:st=0:d=${fIn.toFixed(3)}`);
        if (fOut > 0) filters.push(`afade=t=out:st=${Math.max(0, segDur - fOut).toFixed(3)}:d=${fOut.toFixed(3)}`);
        codecArgs = [...(filters.length ? ['-af', filters.join(',')] : []), ...videoCodec];
      }
    } else {
      return { ok: false, error: `Unsupported output format: ${outExt}` };
    }
    const args = [
      '-hide_banner', '-y',
      '-ss', String(start), '-to', String(end),
      '-i', input,
      ...codecArgs,
      out
    ];
    return ffmpegRun(event, args, out, opId);
  }

  // Fast path: same format in/out, no fades → stream copy (lossless cut).
  const codec = inExt === 'flac'
    ? ['-c:a', 'flac']
    : ['-c', 'copy', '-avoid_negative_ts', 'make_zero'];
  const args = ['-hide_banner', '-y', '-ss', String(start), '-to', String(end), '-i', input, ...codec, out];
  return ffmpegRun(event, args, out, opId);
});

// 4) Extract first embedded subtitle track → SRT
ipcMain.handle('xtract:subs', async (event, { input, opId }) => {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  const out = xtractOutputPath(input, '-subs', 'srt');
  const args = ['-hide_banner', '-y', '-i', input, '-map', '0:s:0', out];
  return ffmpegRun(event, args, out, opId);
});

// 5) Frame export → single frame at timestamp as PNG/JPG
ipcMain.handle('xtract:frame', async (event, { input, at, format, opId }) => {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  if (!at) return { ok: false, error: 'Timestamp required' };
  const ext = format === 'jpg' ? 'jpg' : 'png';
  const out = xtractOutputPath(input, `-frame-${String(at).replace(/[:.]/g, '_')}`, ext);
  const args = ['-hide_banner', '-y', '-ss', String(at), '-i', input, '-frames:v', '1', '-q:v', '2', out];
  return ffmpegRun(event, args, out, opId);
});

// 6) Concat — joins same-format files via the concat demuxer. Caller supplies
// the additional files; we prepend the primary input as the first entry.
ipcMain.handle('xtract:concat', async (event, { input, extras, opId }) => {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  if (!extras || !extras.length) return { ok: false, error: 'Need at least one extra file' };
  const ext = path.extname(input).slice(1) || 'mp4';
  // Build a temp manifest for the concat demuxer. Use OS tmp so we don't
  // require write access to the source folder (which may be read-only).
  const tmpList = path.join(os.tmpdir(), `flux-concat-${Date.now()}.txt`);
  const all = [input, ...extras].map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(tmpList, all);
  const out = xtractOutputPath(input, '-merged', ext);
  const args = ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', tmpList, '-c', 'copy', out];
  const result = await ffmpegRun(event, args, out, opId);
  try { fs.unlinkSync(tmpList); } catch {}
  return result;
});

// 7) Metadata dump — parses ffmpeg's stderr probe output into a JSON sidecar.
// We dropped ffprobe from the bundle (~190 MB Win/Linux, 76 MB Mac) and lean
// on ffmpeg's own `-i` output which carries the same Duration / bitrate /
// sample-rate / codec / metadata-tags info, just unstructured. The parser
// pulls everything into a stable JSON shape that mirrors what the previous
// ffprobe sidecar exposed: { format: {...}, streams: [...], tags: {...} }.
ipcMain.handle('xtract:meta', async (event, { input, opId }) => {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  const out = xtractOutputPath(input, '-meta', 'json');
  const ffmpeg = getFfmpegPath();
  return new Promise(resolve => {
    // -hide_banner trims the build-info preamble; the rest of stderr is what
    // we want to parse. Output is to NUL/null since we only care about info.
    const nullSink = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const proc = spawn(ffmpeg, ['-hide_banner', '-i', input, '-f', 'null', nullSink]);
    let err = '';
    proc.stderr.on('data', d => err += d.toString());
    proc.on('error', e => resolve({ ok: false, error: `ffmpeg not found: ${e.message}` }));
    proc.on('close', () => {
      // ffmpeg exits with code 1 on `-f null` because there's no real output;
      // we still get the full probe info on stderr, so we don't gate on code.
      try {
        const meta = parseFfmpegMeta(err, input);
        fs.writeFileSync(out, JSON.stringify(meta, null, 2));
        safeSend(event.sender, 'xtract:progress', { opId, pct: 100 });
        resolve({ ok: true, path: out });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  });
});

// Parse the chunk of ffmpeg stderr emitted between "Input #0" and the next
// "Output" line. Captures: format name, duration, bitrate, start, per-stream
// codec/sample-rate/channels/bit-rate, and the file-level Metadata block.
function parseFfmpegMeta(stderr, inputPath) {
  const meta = {
    filename: inputPath,
    format: { name: null, duration_sec: null, start_sec: null, bitrate_kbps: null },
    streams: [],
    tags: {}
  };
  const lines = stderr.split(/\r?\n/);
  let inMetadata = false;
  let lastStreamRef = meta;          // where to attach Metadata blocks
  for (const line of lines) {
    let m;
    if ((m = line.match(/^Input\s+#0,\s*([^,]+),\s*from\s*'(.+)':/))) {
      meta.format.name = m[1].trim();
      inMetadata = false;
      lastStreamRef = meta;
      continue;
    }
    if (/^\s*Metadata:\s*$/.test(line)) { inMetadata = true; continue; }
    if (inMetadata && (m = line.match(/^\s{4}([^:]+?)\s*:\s*(.+?)\s*$/))) {
      const key = m[1].trim().toLowerCase();
      (lastStreamRef.tags = lastStreamRef.tags || {})[key] = m[2].trim();
      continue;
    }
    if ((m = line.match(/^\s*Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)(?:,\s*start:\s*([\d.]+))?(?:,\s*bitrate:\s*(\d+)\s*kb\/s)?/))) {
      meta.format.duration_sec = +m[1]*3600 + +m[2]*60 + parseFloat(m[3]);
      if (m[4]) meta.format.start_sec   = parseFloat(m[4]);
      if (m[5]) meta.format.bitrate_kbps = +m[5];
      inMetadata = false;
      continue;
    }
    if ((m = line.match(/^\s*Stream\s+#0:(\d+)(?:\[\w+\])?(?:\((\w+)\))?:\s*(Audio|Video|Subtitle|Data|Attachment):\s*(.+)$/))) {
      const idx = +m[1], lang = m[2] || null, type = m[3].toLowerCase(), tail = m[4];
      const codec = (tail.split(',')[0] || '').split(' ')[0] || null;
      const stream = { index: idx, type, language: lang, codec, raw: tail.trim() };
      if (type === 'audio') {
        const sr  = tail.match(/(\d+)\s*Hz/);
        const ch  = tail.match(/(mono|stereo|\d+\s*channels?)/i);
        const br  = tail.match(/(\d+)\s*kb\/s/);
        if (sr) stream.sample_rate_hz = +sr[1];
        if (ch) stream.channels       = ch[1].toLowerCase();
        if (br) stream.bitrate_kbps   = +br[1];
      } else if (type === 'video') {
        const dim = tail.match(/,\s*(\d+)x(\d+)\b/);
        const fps = tail.match(/([\d.]+)\s*fps/);
        const br  = tail.match(/(\d+)\s*kb\/s/);
        if (dim) { stream.width = +dim[1]; stream.height = +dim[2]; }
        if (fps) stream.fps = parseFloat(fps[1]);
        if (br)  stream.bitrate_kbps = +br[1];
      }
      meta.streams.push(stream);
      lastStreamRef = stream;
      inMetadata = false;
    }
  }
  return meta;
}

// 8) Audio normalize — EBU R128 loudnorm filter. Single-pass for speed; the
// reference target is the conservative spotify/iTunes -14 LUFS.
ipcMain.handle('xtract:normalize', async (event, { input, opId }) => {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  const ext = path.extname(input).slice(1) || 'mp3';
  const out = xtractOutputPath(input, '-normalized', ext);
  const args = ['-hide_banner', '-y', '-i', input, '-af', 'loudnorm=I=-14:LRA=11:TP=-1', out];
  return ffmpegRun(event, args, out, opId);
});

// Lightweight duration probe used by the renderer right after file pick to
// display "Duration: HH:MM:SS" next to the filename, so the user can't enter
// trim values past the actual file length.
ipcMain.handle('xtract:probe', async (_event, { input }) => {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  const dur = await ffmpegProbeDuration(input);
  if (dur <= 0) return { ok: false, error: 'Cannot read duration' };
  return { ok: true, duration: dur, formatted: formatSecondsHMS(dur) };
});

// ffmpeg availability — XTRACT tab uses this to show a friendly disabled state
// when ffmpeg is missing entirely (no vendor binary AND not in PATH).
ipcMain.handle('xtract:checkFfmpeg', async () => {
  return new Promise(resolve => {
    const ffmpegPath = getFfmpegPath();
    // Surface the resolved path + existence/exec bit so when the spawn fails
    // we can tell apart: missing file vs. no +x vs. quarantine block vs.
    // binary crashes at startup (dyld dylib mismatch, etc).
    const isAbsolute = path.isAbsolute(ffmpegPath);
    const exists     = isAbsolute && fs.existsSync(ffmpegPath);
    let mode = null, isExec = null;
    if (exists) {
      try {
        const st = fs.statSync(ffmpegPath);
        mode = (st.mode & 0o777).toString(8);
        isExec = !!(st.mode & 0o111);
      } catch {}
    }
    const ctx = `path=${ffmpegPath} absolute=${isAbsolute} exists=${exists} mode=${mode} exec=${isExec}`;
    log('INFO', `xtract:checkFfmpeg ${ctx}`);

    const proc = spawn(ffmpegPath, ['-version']);
    let ok = false;
    let stderrBuf = '';
    proc.stdout.on('data', () => { ok = true; });
    proc.stderr.on('data', d => { stderrBuf += d.toString(); });
    proc.on('error', e => {
      log('ERROR', `xtract:checkFfmpeg spawn error: ${e.message} (${ctx})`);
      resolve({ ok: false, error: `ffmpeg not runnable — ${e.message} [${ctx}]` });
    });
    proc.on('close', code => {
      if (ok && code === 0) return resolve({ ok: true });
      const tail = stderrBuf.trim().slice(-400);
      log('ERROR', `xtract:checkFfmpeg exit ${code} stderr-tail="${tail}" (${ctx})`);
      resolve({ ok: false, error: `ffmpeg exit ${code} — ${tail || 'no stderr'} [${ctx}]` });
    });
  });
});

// Playlist M3U export — write the playlist as a .m3u8 file in a folder of the
// user's choosing. The renderer builds the M3U text (it has the items); main
// just writes the file after asking for a destination via showSaveDialog.
ipcMain.handle('playlist:exportM3U', async (_, { name, content }) => {
  try {
    const safeName = String(name || 'playlist').replace(/[\\/:*?"<>|]/g, '_');
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Export playlist as M3U',
      defaultPath: `${safeName}.m3u8`,
      filters: [{ name: 'Playlist', extensions: ['m3u8', 'm3u'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, error: 'cancelled' };
    fs.writeFileSync(r.filePath, content, 'utf8');
    return { ok: true, path: r.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ─── IPC: APP / SYSTEM ───────────────────────────────────────────────────────
ipcMain.handle('app:getLocale', () => app.getLocale());
ipcMain.handle('app:getVersion', () => app.getVersion());

// Restart the app — used by Settings > Modules toggle when changes need a
// full reboot to take effect (tab bindings + IPC handlers are wired once
// at DOMContentLoaded, so flipping a module on/off mid-session won't apply
// cleanly). app.relaunch() schedules a fresh instance to start AFTER the
// current one exits; app.quit() triggers the exit.
ipcMain.handle('system:relaunch', () => {
  app.relaunch();
  app.quit();
});

// Updater check — best-effort. electron-updater is an optional dependency
// (graceful no-op if not installed). The renderer button just needs to know:
// (a) up to date, (b) update available with version, (c) error.
ipcMain.handle('updater:check', async () => {
  // macOS: auto-update is disabled (unsigned/un-notarized build — Gatekeeper would
  // block it). Report cleanly instead of erroring; mac users update manually.
  if (process.platform === 'darwin') {
    return { ok: false, unsupported: true, error: 'Auto-update is not available on macOS (the app is not code-signed). Please download updates manually.' };
  }
  try {
    const { autoUpdater } = require('electron-updater');
    const result = await autoUpdater.checkForUpdates();
    const updateInfo = result?.updateInfo;
    const currentVer = app.getVersion();
    const remoteVer  = updateInfo?.version;
    const updateAvailable = remoteVer && remoteVer !== currentVer;
    return {
      ok: true,
      updateAvailable: !!updateAvailable,
      version: remoteVer || currentVer,
      current: currentVer
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});
ipcMain.handle('acoustid:status', () => ({
  fpcalcAvailable: !!getFpcalcPath()
}));
ipcMain.handle('theme:getSystem', () => ({ dark: nativeTheme.shouldUseDarkColors }));

// Renderer-side error/log bridge (preload forwards uncaught/console.error here)
ipcMain.on('renderer:log', (_e, { level, msg }) => {
  log(String(level || 'INFO').toUpperCase(), `[renderer] ${String(msg).slice(0, 1000)}`);
});

// ─── IPC: MODULE REGISTRY ────────────────────────────────────────────────────
// Single source of truth for the modular architecture lives in
// modules/registry.json. The renderer reads it to render Settings > Modules
// and (in Phase 2) to hide tabs that belong to disabled modules. Loaded once
// on demand — the file is tiny and read+parsed in <1ms.
let _moduleRegistryCache = null;
function loadModuleRegistry() {
  if (_moduleRegistryCache) return _moduleRegistryCache;
  try {
    // In a packaged build modules/ sits inside app.asar via the `files`
    // entry in package.json — readFileSync transparently handles asar paths.
    const p = path.join(__dirname, 'modules', 'registry.json');
    _moduleRegistryCache = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    log('ERROR', `loadModuleRegistry: ${e.message}`);
    _moduleRegistryCache = { version: 0, binaries: {}, modules: [] };
  }
  return _moduleRegistryCache;
}
ipcMain.handle('modules:registry', () => loadModuleRegistry());

// Probe which of a module's required binaries are actually present in
// vendor/. The renderer uses this to render an "Installed" badge on the
// Settings > Modules page for Phase 1, and (in Phase 2) to trigger
// first-launch fetch of missing binaries.
ipcMain.handle('modules:binaryStatus', () => {
  const reg = loadModuleRegistry();
  const result = {};
  for (const [id, _] of Object.entries(reg.binaries || {})) {
    const winName = id === 'yt-dlp' ? 'yt-dlp.exe'
                  : id === 'ffmpeg' ? 'ffmpeg.exe'
                  : id === 'ffprobe' ? 'ffprobe.exe'
                  : id === 'fpcalc' ? 'fpcalc.exe'
                  : `${id}.exe`;
    const unixName = id;
    const name = process.platform === 'win32' ? winName : unixName;
    const candidates = app.isPackaged
      ? [
          path.join(VENDOR_DIR, name),                                   // lazy-fetched (userData/vendor)
          path.join(process.resourcesPath, 'vendor', name),              // bundled (legacy / non-slim builds)
          path.join(process.resourcesPath, 'app.asar.unpacked', 'vendor', name)
        ]
      : [path.join(VENDOR_DIR, name)];
    result[id] = candidates.some(c => fs.existsSync(c));
  }
  return result;
});

// Phase 2b — lazy binary fetch. The installer ships slim; FLUX downloads a
// binary into the writable VENDOR_DIR (userData/vendor) the first time the
// user opens a module that needs it. Progress is streamed back to the
// requesting renderer on the `binary:progress` channel.
ipcMain.handle('binary:fetch', async (e, id) => {
  log('INFO', `binary:fetch ${id} → ${VENDOR_DIR}`);
  const r = await binaryFetcher.fetchBinary(id, {
    vendorDir: VENDOR_DIR,
    onProgress: p => safeSend(e.sender, 'binary:progress', p)
  });
  if (r.ok) log('INFO', `binary:fetch ${id} done (${(r.fetched || []).join(', ')})`);
  else      log('ERROR', `binary:fetch ${id} failed: ${r.error}`);
  return r;
});

// Best-effort precise download size (bytes) for the confirm dialog. Never
// throws — returns 0 when the size can't be determined (UI falls back to the
// registry estimate).
ipcMain.handle('binary:probeSize', async (_, id) => {
  try { return await binaryFetcher.probeSize(id, {}); }
  catch { return 0; }
});

// Fetch every binary a module declares in registry.json that isn't already
// present. Sequential so progress reads cleanly; dedupes ffmpeg/ffprobe
// (one archive yields both, so the second is skipped via isPresent).
ipcMain.handle('binary:ensureForModule', async (e, moduleId) => {
  const reg = loadModuleRegistry();
  const mod = (reg.modules || []).find(m => m.id === moduleId);
  if (!mod) return { ok: false, error: `Unknown module: ${moduleId}` };
  const fetched = [];
  for (const bid of (mod.binaries || [])) {
    if (binaryFetcher.isPresent(bid, VENDOR_DIR)) continue;
    const r = await binaryFetcher.fetchBinary(bid, {
      vendorDir: VENDOR_DIR,
      onProgress: p => safeSend(e.sender, 'binary:progress', { ...p, moduleId })
    });
    if (!r.ok) {
      log('ERROR', `binary:ensureForModule ${moduleId}/${bid} failed: ${r.error}`);
      return { ok: false, error: r.error, binary: bid, moduleId };
    }
    fetched.push(...(r.fetched || [bid]));
  }
  return { ok: true, fetched, moduleId };
});

// ─── IPC: CONFIG / PROFILES / EXPORT ─────────────────────────────────────────
ipcMain.handle('config:load',  ()      => loadConfig());
ipcMain.handle('config:save',  (_, c)  => {
  const r = saveConfig(c);
  // Re-apply the global SOCKS5 proxy in case the user toggled it on/off
  // or changed credentials. Cheap when unchanged — applyGlobalProxy
  // exits early if config matches the previously-applied state.
  applyGlobalProxy().catch(e => log('ERROR', `applyGlobalProxy: ${e.message}`));
  return r;
});
ipcMain.handle('config:resetTOS', () => {
  const cfg = loadConfig();
  cfg.tos_accepted = false;
  return saveConfig(cfg);
});

ipcMain.handle('profiles:load',   ()           => loadProfiles());
ipcMain.handle('profiles:save',   (_, name, c) => {
  const p = loadProfiles();
  p[name] = { ...c, profile_name: name };
  return saveProfiles(p);
});
ipcMain.handle('profiles:delete', (_, name) => {
  const p = loadProfiles();
  delete p[name];
  return saveProfiles(p);
});

// Keys stripped from a "shareable" .flux export: credentials, API keys/tokens,
// local paths and personal collections. A "full" export keeps EVERYTHING (for a
// private backup / moving FLUX to another machine). The renderer warns before
// a full export.
const FLUX_SENSITIVE_KEYS = [
  'acoustid_key',
  'mediaserver_url', 'mediaserver_token', 'mediaserver_library_id',
  'sendto_url', 'sendto_user', 'sendto_pass', 'sendto_category',
  'sendnzb_url', 'sendnzb_key', 'sendnzb_pass', 'sendnzb_category',
  'irc_server', 'irc_nick', 'irc_channels', 'irc_sasl_account', 'irc_sasl_password',
  'socks_host', 'socks_port', 'socks_user', 'socks_pass',
  'download_folder', 'library_root', 'image_library_root',
  'sync_profiles', 'playlists', 'radio_favorites',
  'tos_accepted'
];

ipcMain.handle('flux:export', async (_, cfg, mode = 'shareable') => {
  const full = mode === 'full';
  const base = (cfg.profile_name || 'profile').replace(/\s+/g, '_');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: full ? 'Export FLUX Profile — full backup' : 'Export FLUX Profile — shareable',
    defaultPath: `flux_${base}_${full ? 'backup' : 'shared'}.flux`,
    filters: [{ name: 'FLUX Profile', extensions: ['flux'] }]
  });
  if (result.canceled) return { ok: false };
  try {
    const exportable = { ...cfg };
    if (!full) {
      // Shareable: drop every sensitive / path / personal key.
      for (const k of FLUX_SENSITIVE_KEYS) delete exportable[k];
    }
    fs.writeFileSync(result.filePath, JSON.stringify(exportable, null, 2), 'utf8');
    return { ok: true, path: result.filePath, mode: full ? 'full' : 'shareable' };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('flux:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import FLUX Profile',
    filters: [{ name: 'FLUX Profile', extensions: ['flux'] }],
    properties: ['openFile']
  });
  if (result.canceled) return { ok: false };
  try {
    const cfg = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    return { ok: true, config: cfg };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── IPC: DIALOG / SHELL / CLIPBOARD / NOTIFY ────────────────────────────────
ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
// Verify that a candidate folder exists (or can be created) and is writable.
// Used by the Settings save flow so the user can't end up with an unreadable
// download_folder where files appear to download but actually fail silently.
ipcMain.handle('app:checkPathWritable', async (_, p) => {
  try {
    if (!p) return { ok: false, error: 'No path provided' };
    fs.mkdirSync(p, { recursive: true });
    const probe = path.join(p, `.flux-write-${Date.now()}.tmp`);
    fs.writeFileSync(probe, 'flux');
    fs.unlinkSync(probe);
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e.message, path: p };
  }
});
// ─── FILE OPS ENGINE (Files / Sync module) ──────────────────────────────────
// Module-agnostic copy/sync engine shared by the Files tab and the one-click
// "Sync to…" hooks in other modules. Three modes:
//   • copy        — copy every source file to dest (overwrite).
//   • incremental — copy only new/changed files (size or mtime differ); never
//                   delete. The default — fast re-runs that only move deltas.
//   • mirror      — incremental + delete dest files absent from source. The
//                   deletion is DESTRUCTIVE → only runs when the caller passes
//                   confirmDelete:true (the renderer always shows a dry-run
//                   plan first). With an extension filter, mirror only deletes
//                   files OF THE FILTERED TYPES, never unrelated files on the
//                   destination.
// Change detection = size + mtime (≤2 s tolerance for FAT's 2 s granularity).
function walkFiles(root, exts, base = root, out = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(root, e.name);
    if (e.isDirectory()) { walkFiles(abs, exts, base, out); continue; }
    if (!e.isFile()) continue;
    if (exts && !exts.has(path.extname(e.name).toLowerCase())) continue;
    let st; try { st = fs.statSync(abs); } catch { continue; }
    out.push({ rel: path.relative(base, abs), abs, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

// Build a FreeFileSync-style per-file comparison. Returns one row per file
// (union of both sides) so the renderer can show the two-pane grid with a
// center action + per-row checkbox. Categories:
//   new    — present on one side only → copy to the other
//   update — present on both, one side newer/changed → copy newer over older
//   delete — dest-only in mirror mode → remove from destination
//   equal  — identical on both sides → no action
//   ignore — dest-only in incremental mode → left untouched
// dir: 'toDest' (→), 'toSrc' (←), 'del' (✗), '' (none).
// Audio formats we can transcode to MP3 for car compatibility.
const AUDIO_TRANSCODE_EXT = new Set(['.flac', '.opus', '.m4a', '.ogg', '.oga', '.wav', '.aac', '.wma', '.aiff', '.alac']);
const toMp3Rel = rel => rel.replace(/\.[^.\\/]+$/, '.mp3');

function buildSyncPlan({ source, dest, mode = 'incremental', exts = null, transcodeMp3 = false }) {
  const extSet = (Array.isArray(exts) && exts.length)
    ? new Set(exts.map(x => { const l = x.toLowerCase(); return l.startsWith('.') ? l : '.' + l; }))
    : null;
  const srcFiles  = walkFiles(source, extSet);
  const destByRel = new Map((fs.existsSync(dest) ? walkFiles(dest, extSet) : []).map(f => [f.rel, f]));
  const newer = (a, b) => a.mtimeMs > b.mtimeMs + 2000; // a strictly newer than b (2s FAT tolerance)
  // Transcode only makes sense one-way (no "transcode back"). Disabled for two-way.
  const transcode = transcodeMp3 && mode !== 'twoway';

  // Map each source to its EFFECTIVE destination rel: a non-MP3 audio file
  // becomes <name>.mp3 when transcoding, so "a.flac" is matched against the
  // existing "a.mp3" on the destination (no re-transcode on every run).
  const srcEntries = srcFiles.map(f => {
    const tr = transcode && AUDIO_TRANSCODE_EXT.has(path.extname(f.rel).toLowerCase());
    return { f, destRel: tr ? toMp3Rel(f.rel) : f.rel, tr };
  });
  const srcByDest = new Map(srcEntries.map(e => [e.destRel, e]));

  const rels = Array.from(new Set([...srcByDest.keys(), ...destByRel.keys()])).sort((a, b) => a.localeCompare(b));
  const rows = [];
  const counts = { new: 0, update: 0, delete: 0, equal: 0, ignore: 0, toDest: 0, toSrc: 0 };
  let bytesToDest = 0, bytesToSrc = 0;

  for (const drel of rels) {
    if (/\.m3u8?$/i.test(drel)) continue;   // generated playlist artifact — never sync/delete it
    const e = srcByDest.get(drel);          // source mapped to this dest rel (if any)
    const s = e && e.f;
    const d = destByRel.get(drel);
    let category = 'equal', dir = '', tr = false;
    if (s && !d) {                                   // source only → push to dest
      category = 'new'; dir = 'toDest'; tr = e.tr;
    } else if (!s && d) {                            // destination only
      if (mode === 'twoway')      { category = 'new';    dir = 'toSrc'; }
      else if (mode === 'mirror') { category = 'delete'; dir = 'del';   }
      else                        { category = 'ignore'; dir = '';      }
    } else {                                         // present on both
      if (mode === 'twoway') {
        if (newer(s, d))      { category = 'update'; dir = 'toDest'; }
        else if (newer(d, s)) { category = 'update'; dir = 'toSrc'; }
        else                  { category = 'equal';  dir = '';      }
      } else if (e.tr) {
        // transcoded pair: sizes differ inherently → compare by mtime only.
        if (newer(s, d)) { category = 'update'; dir = 'toDest'; tr = true; }
        else             { category = 'equal';  dir = '';       }
      } else {
        if (s.size !== d.size || newer(s, d)) { category = 'update'; dir = 'toDest'; }
        else                                  { category = 'equal';  dir = '';      }
      }
    }
    const bytes = dir === 'toDest' ? (s ? s.size : 0) : dir === 'toSrc' ? (d ? d.size : 0) : 0;
    counts[category]++;
    if (dir === 'toDest') { counts.toDest++; bytesToDest += bytes; }
    else if (dir === 'toSrc') { counts.toSrc++; bytesToSrc += bytes; }
    rows.push({
      srcRel:  s ? s.rel : null,
      destRel: drel,
      rel:     (s ? s.rel : drel),         // display/key
      srcSize:  s ? s.size : null,
      destSize: d ? d.size : null,
      category, dir, transcode: tr, bytes,
      included: category !== 'equal' && category !== 'ignore'
    });
  }
  return { ok: true, rows, counts, bytes: { toDest: bytesToDest, toSrc: bytesToSrc } };
}

// Write a playlist.m3u at the destination root listing every audio file there,
// sorted, with forward-slash relative paths (the most car-stereo-compatible
// form). Returns the track count. Overwrites any existing playlist.m3u.
const AUDIO_PLAYLIST_EXT = new Set(['.mp3', '.flac', '.m4a', '.opus', '.ogg', '.oga', '.wav', '.aac', '.wma', '.aiff', '.alac']);
function writeDestM3u(dest) {
  const files = walkFiles(dest, AUDIO_PLAYLIST_EXT).map(f => f.rel).sort((a, b) => a.localeCompare(b));
  const body = '#EXTM3U\n' + files.map(r => r.replace(/\\/g, '/')).join('\n') + (files.length ? '\n' : '');
  fs.writeFileSync(path.join(dest, 'playlist.m3u'), body, 'utf8');
  return files.length;
}

// Depth-first removal of directories left empty after a mirror delete.
function pruneEmptyDirs(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sub = path.join(dir, e.name);
    pruneEmptyDirs(sub);
    try { if (fs.readdirSync(sub).length === 0) fs.rmdirSync(sub); } catch {}
  }
}

// Dry-run: compute the per-file comparison without touching anything.
ipcMain.handle('fileops:plan', (_, payload = {}) => {
  try {
    if (!payload.source || !fs.existsSync(payload.source)) return { ok: false, error: 'Source folder not found' };
    if (!payload.dest) return { ok: false, error: 'No destination selected' };
    return buildSyncPlan(payload);
  } catch (e) { return { ok: false, error: e.message }; }
});

// Execute ONLY the operations the renderer passed (the rows the user left
// checked), streaming progress on 'fileops:progress'.
// ops = [{ srcRel, destRel, dir, transcode?, bytes }]. Deletions require
// confirmDelete (the renderer confirms mirror deletes first). Transcode ops
// (audio → MP3 for the car) run ffmpeg instead of a plain copy.
ipcMain.handle('fileops:run', async (e, payload = {}) => {
  const { source, dest, ops = [], confirmDelete = false } = payload;
  if (!source || !fs.existsSync(source)) return { ok: false, error: 'Source folder not found' };
  if (!dest) return { ok: false, error: 'No destination selected' };
  try { fs.mkdirSync(dest, { recursive: true }); } catch (err) { return { ok: false, error: `Cannot create destination: ${err.message}` }; }

  const total = ops.length;
  const totalBytes = ops.reduce((s, o) => s + (o.bytes || 0), 0);
  let copied = 0, copiedBack = 0, transcoded = 0, deleted = 0, done = 0, doneBytes = 0;
  const errors = [];
  const send = (file, phase) => safeSend(e.sender, 'fileops:progress', { done, total, doneBytes, totalBytes, copied, copiedBack, transcoded, deleted, file, phase });

  // Copy srcAbs → targetAbs, preserving the source mtime so a subsequent run
  // sees the pair as unchanged. Re-stats at copy time (the plan may be stale).
  const copyOne = (srcAbs, targetAbs, label) => {
    try {
      const st = fs.statSync(srcAbs);
      fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
      fs.copyFileSync(srcAbs, targetAbs);
      try { fs.utimesSync(targetAbs, new Date(), st.mtime); } catch {}
      doneBytes += st.size; return true;
    } catch (err) { errors.push(`${label} ${path.basename(srcAbs)}: ${err.message}`); return false; }
  };
  // Transcode srcAbs → targetAbs (.mp3) at 320k CBR, carrying tags. Stamps the
  // output's mtime to the source's so incremental re-runs skip it.
  const transcodeOne = (srcAbs, targetAbs) => new Promise(resolve => {
    const ffmpeg = getFfmpegPath();
    if (!ffmpeg) { errors.push(`transcode ${path.basename(srcAbs)}: ffmpeg not available`); return resolve(false); }
    let srcMtime = null;
    try { const st = fs.statSync(srcAbs); srcMtime = st.mtime; doneBytes += st.size; } catch {}
    try { fs.mkdirSync(path.dirname(targetAbs), { recursive: true }); }
    catch (err) { errors.push(`transcode ${path.basename(srcAbs)}: ${err.message}`); return resolve(false); }
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', srcAbs,
      '-map', '0:a:0', '-map_metadata', '0', '-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3', targetAbs];
    let errOut = '';
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    proc.stderr?.on('data', d => { errOut += d.toString(); });
    proc.on('error', err => { errors.push(`transcode ${path.basename(srcAbs)}: ${err.message}`); resolve(false); });
    proc.on('close', code => {
      if (code === 0) { if (srcMtime) { try { fs.utimesSync(targetAbs, new Date(), srcMtime); } catch {} } resolve(true); }
      else { errors.push(`transcode ${path.basename(srcAbs)}: ffmpeg exit ${code} ${errOut.trim().slice(0, 200)}`); resolve(false); }
    });
  });

  for (const op of ops) {
    const srcRel = op.srcRel || op.rel, destRel = op.destRel || op.rel;
    let phase = 'copy';
    if (op.dir === 'toDest') {
      if (op.transcode) { phase = 'transcode'; if (await transcodeOne(path.join(source, srcRel), path.join(dest, destRel))) transcoded++; }
      else              { if (copyOne(path.join(source, srcRel), path.join(dest, destRel), 'copy')) copied++; }
    } else if (op.dir === 'toSrc') {
      phase = 'copyBack';
      if (copyOne(path.join(dest, destRel), path.join(source, destRel), 'copy-back')) copiedBack++;
    } else if (op.dir === 'del') {
      phase = 'delete';
      if (confirmDelete) { try { fs.rmSync(path.join(dest, destRel), { force: true }); deleted++; } catch (err) { errors.push(`delete ${destRel}: ${err.message}`); } }
    }
    done++;
    send(destRel, phase);
  }
  if (deleted > 0) { try { pruneEmptyDirs(dest); } catch {} }
  let playlist = 0;
  if (payload.playlistM3u) {
    try { playlist = writeDestM3u(dest); }
    catch (err) { errors.push(`playlist: ${err.message}`); }
  }
  send('', 'done');
  log('INFO', `fileops:run "${source}" ↔ "${dest}": copied ${copied}, transcoded ${transcoded}, back ${copiedBack}, deleted ${deleted}, playlist ${playlist}, errors ${errors.length}`);
  return { ok: errors.length === 0, copied, transcoded, copiedBack, deleted, playlist, errors };
});

// List removable / external drives so the File & Sync tab can offer them as a
// one-click destination (the USB-for-the-car case). Best-effort + never throws.
//   win32  : Win32_LogicalDisk DriveType=2 (removable) via PowerShell.
//   darwin : mounted volumes under /Volumes (minus the boot volume).
//   linux  : auto-mount roots under /media and /run/media.
function listRemovableDrives() {
  try {
    if (process.platform === 'win32') {
      return new Promise(resolve => {
        const ps = 'Get-CimInstance Win32_LogicalDisk -Filter \\"DriveType=2\\" | Select-Object DeviceID,VolumeName,FreeSpace,Size | ConvertTo-Json -Compress';
        exec(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { timeout: 8000, windowsHide: true }, (err, stdout) => {
          if (err || !stdout || !stdout.trim()) return resolve([]);
          let data; try { data = JSON.parse(stdout); } catch { return resolve([]); }
          const arr = Array.isArray(data) ? data : [data];
          resolve(arr.filter(Boolean).map(d => ({
            path:  d.DeviceID + '\\',
            label: d.VolumeName ? `${d.VolumeName} (${d.DeviceID})` : d.DeviceID,
            free:  Number(d.FreeSpace) || 0,
            size:  Number(d.Size) || 0
          })));
        });
      });
    }
    const out = [];
    const addDirsIn = base => {
      try {
        for (const name of fs.readdirSync(base)) {
          const p = path.join(base, name);
          try { if (fs.statSync(p).isDirectory()) out.push({ path: p, label: name, free: 0, size: 0 }); } catch {}
        }
      } catch {}
    };
    if (process.platform === 'darwin') {
      addDirsIn('/Volumes');
      // Drop the boot volume (its /Volumes entry is a symlink to /).
      return out.filter(d => { try { return fs.realpathSync(d.path) !== '/'; } catch { return true; } });
    }
    const user = process.env.USER || process.env.USERNAME || '';
    addDirsIn(`/media/${user}`); addDirsIn('/media'); addDirsIn(`/run/media/${user}`);
    return out;
  } catch { return []; }
}
ipcMain.handle('fileops:drives', () => listRemovableDrives());

// ─── FILE MANAGE (browse a folder + batch rename — the "video archive" use) ──
// Flat file list for the Manage view. { rel, name, size }, sorted by rel.
ipcMain.handle('files:list', (_, { folder, exts, recursive = true } = {}) => {
  try {
    if (!folder || !fs.existsSync(folder)) return { ok: false, error: 'Folder not found' };
    const extSet = (Array.isArray(exts) && exts.length)
      ? new Set(exts.map(x => { const l = x.toLowerCase(); return l.startsWith('.') ? l : '.' + l; })) : null;
    let raw;
    if (recursive) raw = walkFiles(folder, extSet);
    else {
      raw = [];
      for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!e.isFile()) continue;
        if (extSet && !extSet.has(path.extname(e.name).toLowerCase())) continue;
        let st; try { st = fs.statSync(path.join(folder, e.name)); } catch { continue; }
        raw.push({ rel: e.name, abs: path.join(folder, e.name), size: st.size });
      }
    }
    const files = raw
      .map(f => ({ rel: f.rel, abs: f.abs || path.join(folder, f.rel), name: f.rel.split(/[\\/]/).pop(), size: f.size }))
      .sort((a, b) => a.rel.localeCompare(b.rel));
    return { ok: true, files };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Batch-rename inside a folder. renames = [{ from (rel), to (rel) }]. Two-phase
// (rename to a temp name first) so reorders / swaps (A→B, B→A) don't collide.
// A target that already exists on the SECOND pass is skipped (collision-safe).
ipcMain.handle('files:rename', (_, { folder, renames } = {}) => {
  // `folder` optional: when omitted, from/to are treated as ABSOLUTE paths
  // (the Video Editor loads files from anywhere, not one folder).
  if (folder && !fs.existsSync(folder)) return { ok: false, error: 'Folder not found' };
  const abs = p => (folder ? path.join(folder, p) : p);
  const stamp = `.flux-ren-${Date.now()}`;
  const errors = [];
  const staged = [];
  for (const r of (renames || [])) {
    if (!r.from || !r.to || r.from === r.to) continue;
    const fromAbs = abs(r.from);
    const tmpAbs = fromAbs + stamp;
    try { fs.renameSync(fromAbs, tmpAbs); staged.push({ tmpAbs, to: r.to }); }
    catch (err) { errors.push(`${r.from}: ${err.message}`); }
  }
  let renamed = 0;
  for (const s of staged) {
    const toAbs = abs(s.to);
    try {
      if (fs.existsSync(toAbs)) { errors.push(`${path.basename(s.to)}: target exists`); fs.renameSync(s.tmpAbs, s.tmpAbs.slice(0, -stamp.length)); continue; }
      fs.mkdirSync(path.dirname(toAbs), { recursive: true });
      fs.renameSync(s.tmpAbs, toAbs); renamed++;
    } catch (err) { errors.push(`${path.basename(s.to)}: ${err.message}`); try { fs.renameSync(s.tmpAbs, s.tmpAbs.slice(0, -stamp.length)); } catch {} }
  }
  return { ok: errors.length === 0, renamed, errors };
});

ipcMain.handle('dialog:pickFiles', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio', extensions: ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  return r.canceled ? [] : r.filePaths;
});

// Multi-file picker for images — same as dialog:pickFiles but with the
// image-extension filter set. Kept separate so the Tag Editor flow doesn't
// accidentally accept images and vice-versa.
ipcMain.handle('dialog:pickImages', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      // PDFs are accepted in the same picker as images — the renderer
      // rasterises each page into PNGs on the fly so the rest of the
      // pipeline (crop / watermark / compress / dedup / timelapse) just
      // sees regular image files.
      { name: 'Images & PDFs', extensions: ['jpg','jpeg','png','webp','avif','tiff','tif','gif','bmp','heic','heif','svg','pdf'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  return r.canceled ? [] : r.filePaths;
});

// Generic single-file picker — caller passes their own filters. Used by XTRACT
// which needs to accept both video and audio files.
ipcMain.handle('dialog:pickFile', async (_, opts = {}) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: opts.filters || [{ name: 'All files', extensions: ['*'] }]
  });
  return r.canceled ? null : r.filePaths[0];
});

const AUDIO_EXTENSIONS = ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav'];

ipcMain.handle('dialog:pickAudioFolder', async (_, { recursive = false } = {}) => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return { ok: false, files: [] };
  try {
    const files = scanAudioFiles(r.filePaths[0], recursive);
    return { ok: true, folder: r.filePaths[0], files };
  } catch (e) {
    log('ERROR', `scanAudioFiles: ${e.message}`);
    return { ok: false, error: e.message, files: [] };
  }
});

function scanAudioFiles(dir, recursive, results = [], depth = 0) {
  if (depth > 12) return results; // safety
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return results; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive) scanAudioFiles(full, true, results, depth + 1);
    } else if (e.isFile()) {
      if (AUDIO_EXTENSIONS.includes(path.extname(e.name).toLowerCase())) results.push(full);
    }
  }
  return results;
}

ipcMain.handle('file:rename', (_, { oldPath, newPath }) => {
  try {
    if (!oldPath || !newPath) return { ok: false, error: 'Missing paths' };
    if (fs.existsSync(newPath) && oldPath !== newPath) return { ok: false, error: `Destination already exists: ${newPath}` };
    fs.renameSync(oldPath, newPath);
    return { ok: true, path: newPath };
  } catch (e) {
    log('ERROR', `file:rename: ${e.message}`);
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('shell:openFolder',    (_, p) => shell.openPath(p));
ipcMain.handle('shell:openExternal',  (_, u) => shell.openExternal(u));
ipcMain.handle('shell:revealInFolder',(_, p) => { shell.showItemInFolder(p); return true; });
ipcMain.handle('shell:openPath',      (_, p) => shell.openPath(p));
ipcMain.handle('fs:exists',           (_, p) => { try { return p && fs.existsSync(p); } catch { return false; } });

ipcMain.handle('lrc:save', (_, { audioPath, lyrics }) => {
  try {
    const lrcPath = audioPath.replace(/\.[^.]+$/, '') + '.lrc';
    fs.writeFileSync(lrcPath, lyrics, 'utf8');
    return { ok: true, path: lrcPath };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('lrc:exists', (_, audioPath) => {
  const lrcPath = audioPath.replace(/\.[^.]+$/, '') + '.lrc';
  return { exists: fs.existsSync(lrcPath), path: lrcPath };
});
ipcMain.handle('lrc:read', (_, audioPath) => {
  try {
    const lrcPath = audioPath.replace(/\.[^.]+$/, '') + '.lrc';
    if (!fs.existsSync(lrcPath)) return { ok: false, error: 'not found' };
    return { ok: true, content: fs.readFileSync(lrcPath, 'utf8'), path: lrcPath };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('clipboard:write', (_, text) => {
  try {
    if (!text) return false;
    clipboard.writeText(String(text));
    return true;
  } catch(e) { log('ERROR', `clipboard: ${e.message}`); return false; }
});
ipcMain.handle('notify:show', (_, { title, body }) => {
  try {
    if (!Notification.isSupported()) return false;
    new Notification({ title: String(title || 'FLUX'), body: String(body || '') }).show();
    return true;
  } catch (e) { log('ERROR', `notify: ${e.message}`); return false; }
});

// ─── IPC: HISTORY ────────────────────────────────────────────────────────────
ipcMain.handle('history:load',   ()      => loadHistory());
ipcMain.handle('history:clear',  ()      => clearHistory());
ipcMain.handle('history:append', (_, e)  => { appendHistory(e); return true; });
ipcMain.handle('history:stats',  ()      => computeHistoryStats());

// ─── IPC: LIBRARY MANAGER ───────────────────────────────────────────────────
// Moves a freshly-downloaded audio file into a tag-based subfolder under the
// user's download root. Returns the new path (or the original on no-op).
ipcMain.handle('library:organize', (_, payload) => libraryOrganize(payload || {}));

// Sanitise a tag value for use as a filesystem path component. Strips chars
// illegal on Windows (\<>:"/\\|?*), trims trailing dots/spaces (also illegal
// on Windows), and caps length at 80 chars so absurd metadata doesn't blow
// past the Windows 260-char MAX_PATH.
function sanitisePathSegment(s) {
  if (s == null) return '';
  const clean = String(s)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim();
  return clean.slice(0, 80);
}

async function libraryOrganize({ filePath }) {
  const cfg = loadConfig();
  if (!cfg.library_enabled) return { ok: true, moved: false, path: filePath };
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, moved: false, error: 'file not found', path: filePath };
  }
  // Audio-only: skip if the file isn't a music format. Videos / torrents
  // have their own folder semantics and shouldn't get auto-shuffled.
  if (!/\.(mp3|flac|m4a|opus|ogg|wav|aac)$/i.test(filePath)) {
    return { ok: true, moved: false, skipped: 'non-audio', path: filePath };
  }
  // Read tags via music-metadata so we use the SAME source the Tag Editor
  // uses — keeps the organise rule consistent with what the user sees.
  let tags = {};
  try {
    const mm = await import('music-metadata');
    const meta = await mm.parseFile(filePath, { duration: false });
    tags = meta.common || {};
  } catch (e) {
    log('WARN', `libraryOrganize: tag read failed for ${filePath}: ${e.message}`);
  }
  // Pattern substitution. Each token falls back to "Unknown <Field>" so the
  // resulting path is always well-formed even with empty metadata.
  const tokens = {
    artist:      tags.artist      || 'Unknown Artist',
    albumartist: tags.albumartist || tags.artist || 'Unknown Artist',
    album:       tags.album       || 'Unknown Album',
    year:        (tags.year != null ? String(tags.year) : 'Unknown Year'),
    genre:       (Array.isArray(tags.genre) ? tags.genre[0] : tags.genre) || 'Unknown Genre',
    title:       tags.title       || path.basename(filePath, path.extname(filePath)),
    track:       (tags.track && tags.track.no != null) ? String(tags.track.no).padStart(2, '0') : ''
  };
  const pattern = cfg.library_pattern || '{artist}/{album}';
  const relParts = pattern.split(/[\\/]+/).map(seg => {
    const filled = seg.replace(/\{(\w+)\}/g, (_m, k) => tokens[k] != null ? tokens[k] : `{${k}}`);
    return sanitisePathSegment(filled);
  }).filter(Boolean);
  if (!relParts.length) return { ok: true, moved: false, skipped: 'empty pattern', path: filePath };

  const downloadRoot = cfg.download_folder;
  const targetDir = path.join(downloadRoot, ...relParts);
  const baseName  = path.basename(filePath);
  let targetPath  = path.join(targetDir, baseName);
  // Already in the right place? No-op.
  if (path.resolve(targetPath) === path.resolve(filePath)) {
    return { ok: true, moved: false, skipped: 'already in place', path: filePath };
  }
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    // Collision handling: if target exists, suffix " (N)" until free.
    if (fs.existsSync(targetPath)) {
      const ext = path.extname(baseName);
      const stem = baseName.slice(0, -ext.length);
      let n = 2;
      while (fs.existsSync(targetPath) && n < 100) {
        targetPath = path.join(targetDir, `${stem} (${n})${ext}`);
        n++;
      }
    }
    fs.renameSync(filePath, targetPath);
    log('INFO', `libraryOrganize: ${baseName} → ${path.relative(downloadRoot, targetPath)}`);
    return { ok: true, moved: true, path: targetPath };
  } catch (e) {
    log('ERROR', `libraryOrganize move failed: ${e.message}`);
    return { ok: false, moved: false, error: e.message, path: filePath };
  }
}

// ─── IMAGE ORGANIZER (categorize photos into folders by EXIF date) ──────────
// The image-side analogue of the audio Library Manager: move photos into
// <root>/<pattern>/ where the pattern uses date/camera tokens. The date comes
// from the EXIF capture time (DateTimeOriginal, fallback DateTime) with a
// final fallback to the file's modified time. Used both manually
// (images:organize over a selection) and automatically after a download lands
// an image (images:organizeAuto, gated by config). No new dependency: the EXIF
// tags are read straight from sharp's raw TIFF buffer.
const IMAGE_ORG_EXT = /\.(jpg|jpeg|png|webp|avif|tif|tiff|gif|bmp|heic|heif)$/i;

// Minimal EXIF reader over sharp's raw exif buffer. Pulls only what we need:
// capture date (0x9003 DateTimeOriginal → 0x0132 DateTime) and camera make
// (0x010F) / model (0x0110). Returns {} on any malformed input so callers fall
// back to the filesystem date.
function readExifBasics(buf) {
  try {
    if (!buf || buf.length < 16) return {};
    let base = 0;
    if (buf.toString('ascii', 0, 4) === 'Exif') base = 6; // strip APP1 "Exif\0\0" if present
    const bo = buf.toString('ascii', base, base + 2);
    const le = bo === 'II' ? true : bo === 'MM' ? false : null;
    if (le === null) return {};
    const u16 = p => le ? buf.readUInt16LE(p) : buf.readUInt16BE(p);
    const u32 = p => le ? buf.readUInt32LE(p) : buf.readUInt32BE(p);
    const ascii = (entry) => {
      const len = entry.count;
      const pos = len <= 4 ? entry.valOff : base + u32(entry.valOff);
      if (pos < 0 || pos + len > buf.length) return '';
      return buf.toString('ascii', pos, pos + len).replace(/\0.*$/, '').trim();
    };
    const readIFD = (start) => {
      if (start < 0 || start + 2 > buf.length) return [];
      const n = u16(start);
      const entries = [];
      for (let i = 0; i < n; i++) {
        const e = start + 2 + i * 12;
        if (e + 12 > buf.length) break;
        entries.push({ tag: u16(e), type: u16(e + 2), count: u32(e + 4), valOff: e + 8 });
      }
      return entries;
    };
    const out = {};
    let exifPtr = null;
    for (const e of readIFD(base + u32(base + 4))) {
      if (e.tag === 0x0132 && !out.date) out.date = ascii(e);   // DateTime
      else if (e.tag === 0x010F) out.make = ascii(e);            // Make
      else if (e.tag === 0x0110) out.model = ascii(e);           // Model
      else if (e.tag === 0x8769) exifPtr = base + u32(e.valOff); // Exif sub-IFD pointer
    }
    if (exifPtr != null) {
      for (const e of readIFD(exifPtr)) {
        if (e.tag === 0x9003) { const d = ascii(e); if (d) out.date = d; } // DateTimeOriginal wins
      }
    }
    return out;
  } catch { return {}; }
}

// "YYYY:MM:DD HH:MM:SS" (or date-only) → Date, else null.
function parseExifDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/.exec(s || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return isNaN(d.getTime()) ? null : d;
}

async function imageCaptureInfo(sharp, filePath) {
  let date = null, make = '', model = '';
  try {
    const meta = await sharp(filePath).metadata();
    const ex = readExifBasics(meta.exif);
    date = parseExifDate(ex.date);
    make = ex.make || ''; model = ex.model || '';
  } catch { /* unreadable EXIF → fall back below */ }
  if (!date) { try { date = fs.statSync(filePath).mtime; } catch { date = new Date(0); } }
  return { date, make, model };
}

function imageOrgRelParts(pattern, info, filePath) {
  const pad = n => String(n).padStart(2, '0');
  const d = info.date;
  const tokens = {
    year:   String(d.getFullYear()),
    month:  pad(d.getMonth() + 1),
    day:    pad(d.getDate()),
    date:   `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    make:   info.make || 'Unknown',
    model:  info.model || 'Unknown',
    camera: [info.make, info.model].filter(Boolean).join(' ') || 'Unknown Camera',
    ext:    path.extname(filePath).replace(/^\./, '').toLowerCase()
  };
  return (pattern || '{year}/{month}').split(/[\\/]+/).map(seg => {
    const filled = seg.replace(/\{(\w+)\}/g, (_m, k) => tokens[k] != null ? tokens[k] : `{${k}}`);
    return sanitisePathSegment(filled);
  }).filter(Boolean);
}

// Move (or copy) one image into targetDir, cross-device safe, with " (N)"
// collision suffixing. Returns { moved, path } or a skip reason.
function placeImage(filePath, targetDir, copy) {
  fs.mkdirSync(targetDir, { recursive: true });
  const baseName = path.basename(filePath);
  let targetPath = path.join(targetDir, baseName);
  if (path.resolve(targetPath) === path.resolve(filePath)) return { moved: false, skipped: 'already in place', path: filePath };
  if (fs.existsSync(targetPath)) {
    const ext = path.extname(baseName);
    const stem = ext ? baseName.slice(0, -ext.length) : baseName;
    let n = 2;
    while (fs.existsSync(targetPath) && n < 1000) { targetPath = path.join(targetDir, `${stem} (${n})${ext}`); n++; }
  }
  if (copy) {
    fs.copyFileSync(filePath, targetPath);
  } else {
    try { fs.renameSync(filePath, targetPath); }
    catch (e) { if (e.code === 'EXDEV') { fs.copyFileSync(filePath, targetPath); fs.unlinkSync(filePath); } else throw e; }
  }
  return { moved: true, path: targetPath };
}

ipcMain.handle('images:organize', async (event, { files, root, pattern, copy } = {}) => {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: 'sharp not available' };
  if (!Array.isArray(files) || !files.length) return { ok: false, error: 'no files' };
  if (!root) return { ok: false, error: 'no destination root' };
  const safeSend = (ch, data) => { try { event.sender.send(ch, data); } catch {} };
  const results = []; const errors = []; let moved = 0;
  for (let i = 0; i < files.length; i++) {
    const fp = files[i];
    safeSend('images:organizeProgress', { line: `${path.basename(fp)} (${i + 1}/${files.length})`, progress: i / files.length });
    try {
      if (!fs.existsSync(fp)) { errors.push(`${path.basename(fp)}: not found`); continue; }
      if (!IMAGE_ORG_EXT.test(fp)) { errors.push(`${path.basename(fp)}: not an image`); continue; }
      const info = await imageCaptureInfo(sharp, fp);
      const parts = imageOrgRelParts(pattern, info, fp);
      if (!parts.length) { errors.push(`${path.basename(fp)}: empty pattern`); continue; }
      const r = placeImage(fp, path.join(root, ...parts), !!copy);
      if (r.moved) { moved++; results.push({ from: fp, to: r.path }); }
    } catch (e) { errors.push(`${path.basename(fp)}: ${e.message}`); }
  }
  safeSend('images:organizeProgress', { line: `done — ${moved} moved`, progress: 1 });
  return { ok: true, moved, results, errors };
});

// Automatic post-download organize (gated by config; mirrors libraryOrganize).
ipcMain.handle('images:organizeAuto', async (_, { filePath } = {}) => {
  const cfg = loadConfig();
  if (!cfg.image_library_enabled) return { ok: true, moved: false, path: filePath };
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, moved: false, error: 'file not found', path: filePath };
  if (!IMAGE_ORG_EXT.test(filePath)) return { ok: true, moved: false, skipped: 'non-image', path: filePath };
  const sharp = getSharp();
  if (!sharp) return { ok: false, moved: false, error: 'sharp not available', path: filePath };
  const root = cfg.image_library_root || cfg.download_folder;
  try {
    const info = await imageCaptureInfo(sharp, filePath);
    const parts = imageOrgRelParts(cfg.image_library_pattern || '{year}/{month}', info, filePath);
    if (!parts.length) return { ok: true, moved: false, skipped: 'empty pattern', path: filePath };
    const r = placeImage(filePath, path.join(root, ...parts), false);
    if (r.moved) log('INFO', `imageOrganize: ${path.basename(filePath)} → ${path.relative(root, r.path)}`);
    return { ok: true, moved: !!r.moved, path: r.path || filePath };
  } catch (e) {
    log('ERROR', `imageOrganizeAuto failed: ${e.message}`);
    return { ok: false, moved: false, error: e.message, path: filePath };
  }
});

// ─── IPC: MEDIA SERVER TRIGGER ──────────────────────────────────────────────
// POST to Plex / Jellyfin (or a generic webhook) so the library refreshes
// without waiting for the scheduled scan.
ipcMain.handle('mediaserver:notify', (_, payload) => mediaserverNotify(payload || {}));
ipcMain.handle('mediaserver:test',   (_, payload) => mediaserverNotify({ ...payload, dryRun: false, test: true }));

async function mediaserverNotify({ kind, path: filePath, test } = {}) {
  const cfg = loadConfig();
  if (!cfg.mediaserver_enabled && !test) return { ok: true, skipped: 'disabled' };
  const baseUrl = (cfg.mediaserver_url || '').replace(/\/+$/, '');
  if (!baseUrl) return { ok: false, error: 'mediaserver_url not configured' };
  const token  = cfg.mediaserver_token || '';
  const libId  = cfg.mediaserver_library_id || '';
  let url, method = 'POST', headers = { 'Accept': 'application/json' }, body = null;
  try {
    if (cfg.mediaserver_type === 'plex') {
      // Plex: refresh a specific section. Library id required.
      if (!libId) return { ok: false, error: 'Plex requires a library section id' };
      url = `${baseUrl}/library/sections/${encodeURIComponent(libId)}/refresh${token ? `?X-Plex-Token=${encodeURIComponent(token)}` : ''}`;
    } else if (cfg.mediaserver_type === 'jellyfin') {
      // Jellyfin / Emby: global library refresh. Auth via MediaBrowser Token
      // header (works on both Jellyfin 10.x and Emby).
      url = `${baseUrl}/Library/Refresh`;
      if (token) headers['Authorization'] = `MediaBrowser Token="${token}"`;
    } else {
      // Generic webhook — fire JSON payload with what we know about the
      // download so the user can route it from there (n8n, Home Assistant…).
      url = baseUrl;
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ event: 'download.completed', kind, path: filePath });
    }
    const res = await fetch(url, { method, headers, body });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── IPC: OPENSUBTITLES (find subtitle .srt for a local video) ──────────────
// Three-step flow: hash the local video (first+last 64KB, OS "moviehash"
// algorithm) → POST search to api.opensubtitles.com → user picks a result,
// we follow the download_link (signed URL good for ~3h) and stream the .srt
// next to the video. The API key is user-provided (free registration, 200
// downloads/day free tier).
ipcMain.handle('subs:hash',     (_, payload) => subsComputeHash(payload || {}));
ipcMain.handle('subs:search',   (_, payload) => subsSearch(payload || {}));
ipcMain.handle('subs:download', (_, payload) => subsDownload(payload || {}));

// OpenSubtitles "moviehash" — first 64KB + last 64KB + file size, summed as
// little-endian 64-bit integers modulo 2^64. Standard algorithm documented
// at trac.opensubtitles.org/projects/opensubtitles/wiki/HashSourceCodes.
async function subsComputeHash({ filePath }) {
  if (!filePath) return { ok: false, error: 'filePath required' };
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    if (size < 131072) return { ok: false, error: 'file too small for moviehash (need >=128 KB)' };
    const CHUNK = 65536;
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(CHUNK), tail = Buffer.alloc(CHUNK);
    fs.readSync(fd, head, 0, CHUNK, 0);
    fs.readSync(fd, tail, 0, CHUNK, size - CHUNK);
    fs.closeSync(fd);
    // Sum 64-bit LE longs from head + tail + file size. BigInt avoids
    // precision loss on >2^53 byte files.
    let hash = BigInt(size);
    const MASK = (1n << 64n) - 1n;
    for (const buf of [head, tail]) {
      for (let i = 0; i < buf.length; i += 8) {
        hash = (hash + buf.readBigUInt64LE(i)) & MASK;
      }
    }
    return { ok: true, hash: hash.toString(16).padStart(16, '0'), size };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function subsSearch({ apiKey, query, moviehash, languages }) {
  if (!apiKey) return { ok: false, error: 'no_key' };
  const params = new URLSearchParams();
  if (moviehash) params.set('moviehash', moviehash);
  if (query)     params.set('query', query);
  if (languages) params.set('languages', languages);
  params.set('order_by', 'download_count');
  params.set('order_direction', 'desc');
  const url = `https://api.opensubtitles.com/api/v1/subtitles?${params}`;
  try {
    const res = await fetch(url, {
      headers: {
        'Api-Key': apiKey,
        'Accept': 'application/json',
        // OS docs require an explicit User-Agent identifying the app +
        // version — they throttle anonymous traffic aggressively.
        'User-Agent': `FLUX v${app.getVersion()}`
      }
    });
    if (res.status === 401) return { ok: false, error: 'invalid_key' };
    if (res.status === 429) return { ok: false, error: 'rate_limited' };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    // Flatten the response: each item has attributes + files[] (we only need
    // the first file id for the download endpoint).
    const results = (data.data || []).map(it => {
      const a = it.attributes || {};
      const f = (a.files || [])[0] || {};
      return {
        id:           f.file_id,
        release:      a.release || a.feature_details?.title || '',
        language:     a.language || '',
        downloads:    a.download_count || 0,
        fromHash:     !!(a.moviehash_match),
        srtName:      f.file_name || `${a.release || 'subtitle'}.srt`
      };
    }).filter(r => r.id);
    return { ok: true, results };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function subsDownload({ apiKey, fileId, targetDir, baseName }) {
  if (!apiKey || !fileId || !targetDir) return { ok: false, error: 'missing args' };
  try {
    // Step 1: request a download URL from OS. The actual .srt link is
    // signed and short-lived (~3h), so we can't just hardcode it.
    const dlRes = await fetch('https://api.opensubtitles.com/api/v1/download', {
      method:  'POST',
      headers: {
        'Api-Key':     apiKey,
        'Content-Type':'application/json',
        'Accept':      'application/json',
        'User-Agent':  `FLUX v${app.getVersion()}`
      },
      body: JSON.stringify({ file_id: fileId })
    });
    if (dlRes.status === 401) return { ok: false, error: 'invalid_key' };
    if (dlRes.status === 406) return { ok: false, error: 'quota_exceeded' };
    if (!dlRes.ok) return { ok: false, error: `HTTP ${dlRes.status}` };
    const dlData = await dlRes.json();
    const link = dlData.link;
    if (!link) return { ok: false, error: 'no download link in response' };
    // Step 2: fetch the actual .srt and write next to the video (same name,
    // different extension). Name collision adds a (2)/(3)/... suffix.
    const srtRes = await fetch(link);
    if (!srtRes.ok) return { ok: false, error: `srt fetch ${srtRes.status}` };
    const content = Buffer.from(await srtRes.arrayBuffer());
    let outPath = path.join(targetDir, `${baseName}.srt`);
    let n = 2;
    while (fs.existsSync(outPath)) {
      outPath = path.join(targetDir, `${baseName} (${n}).srt`);
      n++;
    }
    fs.writeFileSync(outPath, content);
    return { ok: true, path: outPath, remaining: dlData.remaining, resetTime: dlData.reset_time };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── IPC: SEND-TO-USENET (SABnzbd / NZBGet) ─────────────────────────────────
// Forward a local .nzb file to an existing Usenet client. SABnzbd takes the
// raw NZB body via multipart; NZBGet takes a base64-encoded payload via
// JSON-RPC. Both support a "category" hint for routing.
ipcMain.handle('sendnzb:fromFile', (_, payload) => sendNzbFromFile(payload || {}));
ipcMain.handle('sendnzb:test',     ()           => sendNzbFromFile({ test: true }));

async function sendNzbFromFile({ filePath, test } = {}) {
  const cfg = loadConfig();
  if (!cfg.sendnzb_enabled && !test) return { ok: false, error: 'NZB forwarding disabled' };
  const baseUrl = (cfg.sendnzb_url || '').replace(/\/+$/, '');
  if (!baseUrl) return { ok: false, error: 'sendnzb_url not configured' };

  let nzbBuffer = null, nzbName = null;
  if (!test) {
    if (!filePath) return { ok: false, error: 'no NZB file path' };
    try {
      nzbBuffer = fs.readFileSync(filePath);
      nzbName = path.basename(filePath);
    } catch (e) {
      return { ok: false, error: `read NZB: ${e.message}` };
    }
  }

  try {
    if (cfg.sendnzb_type === 'sabnzbd') {
      // SABnzbd: /sabnzbd/api?mode=addfile&apikey=KEY (multipart name=<file>)
      // Test mode uses mode=version which doesn't require a file.
      if (test) {
        const u = `${baseUrl}/sabnzbd/api?mode=version&output=json&apikey=${encodeURIComponent(cfg.sendnzb_key || '')}`;
        const res = await fetch(u);
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const j = await res.json().catch(() => null);
        if (!j || j.error) return { ok: false, error: j?.error || 'unexpected response' };
        return { ok: true };
      }
      // Real upload uses multipart/form-data — Node 18+ fetch + FormData/Blob.
      const form = new FormData();
      form.set('mode', 'addfile');
      form.set('apikey', cfg.sendnzb_key || '');
      form.set('output', 'json');
      form.set('nzbname', nzbName);
      if (cfg.sendnzb_category) form.set('cat', cfg.sendnzb_category);
      form.set('name', new Blob([nzbBuffer], { type: 'application/x-nzb' }), nzbName);
      const res = await fetch(`${baseUrl}/sabnzbd/api`, { method: 'POST', body: form });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const j = await res.json().catch(() => ({}));
      if (j.status === false || j.error) return { ok: false, error: j.error || 'SABnzbd refused the NZB' };
      return { ok: true, sentTo: 'sabnzbd' };
    } else if (cfg.sendnzb_type === 'nzbget') {
      // NZBGet: POST /jsonrpc with method "append".
      // Args: [NZBFilename, NZBContent (base64), Category, Priority,
      //        AddToTop, AddPaused, DupeKey, DupeScore, DupeMode]
      const auth = (cfg.sendnzb_key || cfg.sendnzb_pass)
        ? `Basic ${Buffer.from(`${cfg.sendnzb_key}:${cfg.sendnzb_pass}`).toString('base64')}`
        : null;
      const headers = { 'Content-Type': 'application/json' };
      if (auth) headers['Authorization'] = auth;
      if (test) {
        // version method is cheap + auth-checking.
        const res = await fetch(`${baseUrl}/jsonrpc`, {
          method: 'POST', headers,
          body: JSON.stringify({ method: 'version' })
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const j = await res.json().catch(() => null);
        if (!j || j.error) return { ok: false, error: j?.error?.message || 'unexpected response' };
        return { ok: true };
      }
      const params = [
        nzbName,
        nzbBuffer.toString('base64'),
        cfg.sendnzb_category || '',
        0,        // priority (0 = normal)
        false,    // addToTop
        false,    // addPaused
        '',       // dupeKey
        0,        // dupeScore
        'score'   // dupeMode
      ];
      const res = await fetch(`${baseUrl}/jsonrpc`, {
        method: 'POST', headers,
        body: JSON.stringify({ method: 'append', params })
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const j = await res.json().catch(() => ({}));
      // NZBGet returns the post-process ID (int > 0) on success, 0 on
      // outright rejection, or .error on protocol-level problems.
      if (j.error) return { ok: false, error: j.error.message || 'NZBGet error' };
      if (typeof j.result === 'number' && j.result <= 0) return { ok: false, error: 'NZBGet rejected the NZB (id=0)' };
      return { ok: true, sentTo: 'nzbget', id: j.result };
    }
    return { ok: false, error: `unsupported NZB client type: ${cfg.sendnzb_type}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── IPC: SEND-TO-CLIENT (qBittorrent / Transmission) ───────────────────────
ipcMain.handle('sendto:torrent', (_, payload) => sendToTorrentClient(payload || {}));
ipcMain.handle('sendto:test',    ()           => sendToTorrentClient({ test: true }));

async function sendToTorrentClient({ magnet, url: torrentUrl, name, test } = {}) {
  const cfg = loadConfig();
  if (!cfg.sendto_enabled && !test) return { ok: false, error: 'send-to-client disabled' };
  const baseUrl = (cfg.sendto_url || '').replace(/\/+$/, '');
  if (!baseUrl) return { ok: false, error: 'sendto_url not configured' };
  const link = magnet || torrentUrl;
  if (!test && !link) return { ok: false, error: 'no magnet / URL to send' };

  try {
    if (cfg.sendto_type === 'qbittorrent') {
      // qBittorrent WebUI v2 — login (sets cookie) then POST torrents/add.
      const loginRes = await fetch(`${baseUrl}/api/v2/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': baseUrl },
        body: new URLSearchParams({ username: cfg.sendto_user || '', password: cfg.sendto_pass || '' })
      });
      // qBittorrent returns 200 + body "Ok."/"Fails." and (usually) a SID cookie.
      // undici's Headers.get('set-cookie') is unreliable — prefer getSetCookie().
      // With "bypass auth for localhost" enabled, login succeeds with NO cookie,
      // so don't hard-require one; trust the HTTP status + body instead.
      const loginBody = (await loginRes.text().catch(() => '')).trim();
      if (!loginRes.ok || /^fails\.?$/i.test(loginBody)) {
        return { ok: false, error: 'qBittorrent login failed — check the WebUI URL, username and password' };
      }
      const setCookies = typeof loginRes.headers.getSetCookie === 'function' ? loginRes.headers.getSetCookie() : [];
      const cookie = (setCookies[0] || loginRes.headers.get('set-cookie') || '').split(';')[0];
      if (test) return { ok: true };
      const formBody = new URLSearchParams({ urls: link });
      if (cfg.sendto_category) formBody.set('category', cfg.sendto_category);
      const addHeaders = { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': baseUrl };
      if (cookie) addHeaders['Cookie'] = cookie;
      const addRes = await fetch(`${baseUrl}/api/v2/torrents/add`, {
        method: 'POST',
        headers: addHeaders,
        body: formBody
      });
      if (!addRes.ok) return { ok: false, error: `qBittorrent add failed: HTTP ${addRes.status}` };
      return { ok: true, sentTo: 'qbittorrent' };
    } else if (cfg.sendto_type === 'transmission') {
      // Transmission RPC. The first call returns 409 with the session id
      // header we need; replay with X-Transmission-Session-Id set.
      const rpcUrl = `${baseUrl}/transmission/rpc`;
      const auth = (cfg.sendto_user || cfg.sendto_pass)
        ? `Basic ${Buffer.from(`${cfg.sendto_user}:${cfg.sendto_pass}`).toString('base64')}`
        : null;
      const baseHeaders = { 'Content-Type': 'application/json' };
      if (auth) baseHeaders['Authorization'] = auth;
      // Probe to get session id.
      const probe = await fetch(rpcUrl, {
        method: 'POST', headers: baseHeaders,
        body: JSON.stringify({ method: 'session-get' })
      });
      const sid = probe.headers.get('x-transmission-session-id');
      if (!sid) return { ok: false, error: 'Transmission session id missing — wrong URL or creds?' };
      if (test) return { ok: true };
      const addRes = await fetch(rpcUrl, {
        method: 'POST',
        headers: { ...baseHeaders, 'X-Transmission-Session-Id': sid },
        body: JSON.stringify({ method: 'torrent-add', arguments: { filename: link, 'download-dir': cfg.sendto_category || undefined } })
      });
      const json = await addRes.json().catch(() => ({}));
      if (json.result !== 'success') return { ok: false, error: `Transmission: ${json.result || 'unknown error'}` };
      return { ok: true, sentTo: 'transmission' };
    }
    return { ok: false, error: `unsupported client type: ${cfg.sendto_type}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── IPC: IRC / XDCC ─────────────────────────────────────────────────────────
// Minimal IRC client built on raw TCP — avoids pulling a heavy IRC library
// for a single tab. Supports plain (non-TLS) connections, channel join /
// part, PRIVMSG send, and inbound DCC SEND (active mode). Files land in
// config.download_folder with collision-suffix naming.
const ircState = {
  socket: null,
  sender: null,        // current renderer webContents — used for safeSend
  nick: '',
  buffer: '',
  joined: new Set(),
  transfers: new Map(),     // id → transfer state object
  pendingResumes: new Map() // port → { senderNick, filename, size, position, finalPath, timer }
};
// Idle timeout for a stalled DCC connection — if no bytes for this many ms
// the transfer is aborted (partial file is KEPT on disk for the next
// RESUME attempt). 700 MB at 50 KB/s would take ~4 h — but a stall at 0
// bytes/s for 30 s is almost always a dead transfer.
const DCC_IDLE_TIMEOUT_MS = 30_000;
// Fallback if the bot doesn't reply to our DCC RESUME within this window —
// some older bots / fserves don't implement RESUME and just stay silent.
// In that case we delete the partial file and start fresh.
const DCC_RESUME_TIMEOUT_MS = 5_000;

// IRC line parser. RFC1459 / RFC2812 format: ":prefix command params... :trailing"
function ircParseLine(line) {
  let prefix = null;
  let i = 0;
  if (line[0] === ':') {
    const sp = line.indexOf(' ');
    prefix = line.slice(1, sp);
    i = sp + 1;
  }
  const trailIdx = line.indexOf(' :', i);
  let mid = line.slice(i);
  let trail = null;
  if (trailIdx >= 0) {
    trail = line.slice(trailIdx + 2);
    mid   = line.slice(i, trailIdx);
  }
  const tokens = mid.split(' ').filter(Boolean);
  const command = tokens[0];
  const params  = tokens.slice(1);
  if (trail != null) params.push(trail);
  return { prefix, command, params };
}

function ircSafeFilename(name) {
  return (name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 200) || 'file';
}

// CTCP DCC dispatcher — routes to SEND / ACCEPT handlers. The shared parser
// produces a token array honouring quoted filenames with spaces.
function ircHandleDcc(senderNick, ctcp) {
  const args = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(ctcp)) !== null) args.push(m[1] || m[2]);
  if (args[0] !== 'DCC') return;
  if (args[1] === 'SEND')   return ircHandleDccSend(senderNick, args);
  if (args[1] === 'ACCEPT') return ircHandleDccAccept(senderNick, args);
  // DCC CHAT / DCC RESUME echo back / DCC TSEND etc — ignored for now.
}

// DCC SEND: "DCC SEND filename ip port size".
//   ip is the IPv4 address packed as a 32-bit unsigned decimal integer.
// Decision tree:
//   • partial file exists with size < expected  → send DCC RESUME, wait for
//     DCC ACCEPT, then continue from that position (handled in
//     ircHandleDccAccept). Falls back to fresh start after a timeout.
//   • full file already exists with same size   → skip, emit done immediately.
//   • file exists with DIFFERENT size           → treat as collision, append
//     "(2)" / "(3)" suffix and start fresh (same as before).
//   • file doesn't exist                        → fresh transfer.
function ircHandleDccSend(senderNick, args) {
  const filename = args[2];
  const ipNum = Number(args[3]);
  const port  = parseInt(args[4], 10);
  const size  = parseInt(args[5], 10) || 0;
  if (!Number.isFinite(ipNum) || !port) return;
  const ip = `${(ipNum >>> 24) & 0xff}.${(ipNum >>> 16) & 0xff}.${(ipNum >>> 8) & 0xff}.${ipNum & 0xff}`;

  const cfg = loadConfig();
  const downloadFolder = cfg.download_folder;
  try { fs.mkdirSync(downloadFolder, { recursive: true }); } catch {}
  const safeName = ircSafeFilename(filename);
  const targetPath = path.join(downloadFolder, safeName);

  // Resume path — partial file of the same name exists, smaller than expected.
  if (size > 0 && fs.existsSync(targetPath)) {
    let existingSize = 0;
    try { existingSize = fs.statSync(targetPath).size; } catch {}
    if (existingSize === size) {
      // Already complete — synthesize a done event.
      const id = `done-${Date.now()}`;
      safeSend(ircState.sender, 'irc:event', { type: 'transfer-start', id, filename: safeName, size, from: senderNick });
      safeSend(ircState.sender, 'irc:event', { type: 'transfer-done',  id, path: targetPath, received: size, alreadyHad: true });
      return;
    }
    if (existingSize > 0 && existingSize < size) {
      // Park the request and ask the bot to resume from existingSize. We
      // need ACCEPT-loop reentry, so stash everything here and proceed in
      // ircHandleDccAccept when the bot replies.
      const fallbackTimer = setTimeout(() => {
        // Bot didn't ACCEPT — restart fresh with a collision suffix so the
        // partial file isn't overwritten (user may still want it).
        const pending = ircState.pendingResumes.get(port);
        ircState.pendingResumes.delete(port);
        if (!pending) return;
        const newPath = ircCollisionPath(downloadFolder, safeName);
        ircStartDccTransfer({ senderNick, filename: safeName, ip, port, size, finalPath: newPath, resumeFrom: 0 });
      }, DCC_RESUME_TIMEOUT_MS);
      ircState.pendingResumes.set(port, {
        senderNick, filename: safeName, ip, size, position: existingSize, finalPath: targetPath, timer: fallbackTimer
      });
      // Ask the bot to resume. CTCP framing = 0x01 + payload + 0x01.
      const resumeMsg = `PRIVMSG ${senderNick} :\x01DCC RESUME ${safeName} ${port} ${existingSize}\x01\r\n`;
      try { ircState.socket.write(resumeMsg); } catch {}
      return;
    }
    // existingSize > size or === 0 → fall through to collision-suffix flow.
  }

  // Fresh transfer — or collision suffix when an unrelated file already exists.
  const finalPath = fs.existsSync(targetPath)
    ? ircCollisionPath(downloadFolder, safeName)
    : targetPath;
  ircStartDccTransfer({ senderNick, filename: safeName, ip, port, size, finalPath, resumeFrom: 0 });
}

// DCC ACCEPT: "DCC ACCEPT filename port position".
//   Confirms the bot will resume from `position`. position MAY differ from
//   what we asked (rare — usually the bot honors our value).
function ircHandleDccAccept(senderNick, args) {
  const filename = args[2];
  const port     = parseInt(args[3], 10);
  const position = parseInt(args[4], 10) || 0;
  const pending  = ircState.pendingResumes.get(port);
  if (!pending) return;        // unknown port — possibly a duplicate ACCEPT
  clearTimeout(pending.timer);
  ircState.pendingResumes.delete(port);
  ircStartDccTransfer({
    senderNick: pending.senderNick,
    filename:   pending.filename,
    ip:         pending.ip,
    port,
    size:       pending.size,
    finalPath:  pending.finalPath,
    resumeFrom: position
  });
}

// Generic collision-suffix path resolver (extracted from the SEND handler).
// Tries "name (2).ext", "name (3).ext", … up to (99).
function ircCollisionPath(folder, safeName) {
  const ext  = path.extname(safeName);
  const stem = ext ? safeName.slice(0, -ext.length) : safeName;
  let n = 2, p = path.join(folder, safeName);
  while (fs.existsSync(p) && n < 100) {
    p = path.join(folder, `${stem} (${n})${ext}`);
    n++;
  }
  return p;
}

// Open the TCP connect + writeStream for a DCC transfer, fresh OR resumed.
//   resumeFrom > 0 → opens writeStream in append mode at that offset; the
//   ACK byte count starts FROM resumeFrom so the bot keeps sending past
//   the resume point. Idle timer resets on every chunk so a 30 s gap of
//   silence aborts the transfer cleanly (partial stays on disk for retry).
function ircStartDccTransfer({ senderNick, filename, ip, port, size, finalPath, resumeFrom = 0 }) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  safeSend(ircState.sender, 'irc:event', {
    type: 'transfer-start', id, filename, size, from: senderNick,
    resumed: resumeFrom > 0, resumeFrom
  });

  const dccSocket   = net.connect(port, ip);
  const writeStream = fs.createWriteStream(finalPath, { flags: resumeFrom > 0 ? 'a' : 'w' });
  let received   = resumeFrom;
  let lastEmit   = 0;
  let lastChunkAt = Date.now();
  const startedAt = Date.now();

  const armIdleTimer = () => {
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      try { dccSocket.destroy(new Error('Idle timeout: no data received')); } catch {}
    }, DCC_IDLE_TIMEOUT_MS);
  };
  const state = {
    socket: dccSocket, writeStream, path: finalPath, size, received,
    startedAt, idleTimer: null, cancelled: false
  };
  ircState.transfers.set(id, state);
  armIdleTimer();

  dccSocket.on('data', (chunk) => {
    received += chunk.length;
    state.received = received;
    lastChunkAt = Date.now();
    writeStream.write(chunk);
    // ACK with running byte count as 32-bit BE — required by mIRC and
    // classic ircds. The protocol field is uint32 (max 4 GiB). For files
    // past 4 GiB we SATURATE the ACK at 0xFFFFFFFF instead of wrapping
    // to zero, which keeps wait-for-ACK bots from stalling (they see
    // "client at 4 GiB" indefinitely and keep streaming; turbo-DCC bots
    // ignore mid-transfer ACKs altogether so the saturation is harmless).
    // This is what modern mIRC builds do and is the de-facto standard for
    // >4 GiB DCC transfers.
    const ack = Buffer.alloc(4);
    ack.writeUInt32BE(Math.min(received, 0xFFFFFFFF), 0);
    try { dccSocket.write(ack); } catch {}
    armIdleTimer();
    const now = Date.now();
    if (now - lastEmit > 250) {
      lastEmit = now;
      const elapsedSec = (now - startedAt) / 1000;
      const transferred = received - resumeFrom;   // bytes since this run started
      const speed = elapsedSec > 0.5 ? transferred / elapsedSec : 0;
      const remaining = Math.max(0, size - received);
      const etaSec = speed > 0 ? remaining / speed : null;
      safeSend(ircState.sender, 'irc:event', {
        type: 'transfer-progress', id, received, size, speed, etaSec
      });
    }
  });
  dccSocket.on('end', () => {
    clearTimeout(state.idleTimer);
    writeStream.end();
    ircState.transfers.delete(id);
    if (state.cancelled) return;   // cancel path already emitted
    safeSend(ircState.sender, 'irc:event', { type: 'transfer-done', id, path: finalPath, received });
  });
  dccSocket.on('error', (e) => {
    clearTimeout(state.idleTimer);
    try { writeStream.end(); } catch {}
    ircState.transfers.delete(id);
    if (state.cancelled) return;
    safeSend(ircState.sender, 'irc:event', { type: 'transfer-error', id, error: e.message, received });
  });
}

// Cancel an in-flight transfer. The socket is destroyed and the writeStream
// closed — but the partial file is INTENTIONALLY left on disk so the user
// can resume it later with a fresh XDCC request (the bot will see the
// existing partial and we'll send DCC RESUME).
function ircCancelTransfer(id) {
  const state = ircState.transfers.get(id);
  if (!state) return { ok: false, error: 'transfer not found' };
  state.cancelled = true;
  clearTimeout(state.idleTimer);
  try { state.socket.destroy(); } catch {}
  try { state.writeStream.end(); } catch {}
  ircState.transfers.delete(id);
  safeSend(ircState.sender, 'irc:event', { type: 'transfer-cancelled', id, received: state.received, path: state.path });
  return { ok: true, received: state.received, path: state.path };
}
ipcMain.handle('irc:cancelTransfer', (_, { id } = {}) => ircCancelTransfer(id));

function ircHandleLine(line) {
  if (!line) return;
  const { prefix, command, params } = ircParseLine(line);
  const senderNick = prefix ? prefix.split('!')[0] : null;
  if (command === 'PING') {
    try { ircState.socket.write(`PONG :${params[0] || ''}\r\n`); } catch {}
    return;
  }
  // ── SASL PLAIN handshake ────────────────────────────────────────────────
  // Flow:
  //   > CAP REQ :sasl     (sent at connect time when SASL is configured)
  //   < CAP * ACK :sasl   → send AUTHENTICATE PLAIN
  //   < AUTHENTICATE +    → send AUTHENTICATE <base64(user\0user\0pass)>
  //   < 903               → success → send CAP END
  //   < 902/904/905/906   → failure → log + CAP END anyway (continue unauth)
  // The state machine lives entirely in ircState.saslPending so it doesn't
  // pollute the general line handler.
  if (command === 'CAP' && params[1] === 'ACK' && /(^| )sasl( |$)/.test(params[2] || '')) {
    try { ircState.socket.write('AUTHENTICATE PLAIN\r\n'); } catch {}
    return;
  }
  if (command === 'CAP' && params[1] === 'NAK') {
    // Server refused our capability request — abort SASL and continue
    // registration without authentication.
    try { ircState.socket.write('CAP END\r\n'); } catch {}
    ircState.saslPending = false;
    safeSend(ircState.sender, 'irc:event', { type: 'sasl', ok: false, error: 'server refused SASL capability' });
    return;
  }
  if (command === 'AUTHENTICATE' && params[0] === '+') {
    const { account, password } = ircState.saslCreds || {};
    if (account && password) {
      // Format: <authzid>\0<authcid>\0<password>. We use same id for both.
      const payload = Buffer.from(`${account}\0${account}\0${password}`, 'utf8').toString('base64');
      // SASL payload may need to be split into 400-char chunks per RFC4422;
      // for typical short passwords one chunk suffices.
      try { ircState.socket.write(`AUTHENTICATE ${payload}\r\n`); } catch {}
    } else {
      try { ircState.socket.write('AUTHENTICATE *\r\n'); } catch {} // abort
    }
    return;
  }
  if (command === '903') {
    // RPL_SASLSUCCESS — finalize CAP negotiation so the server can register us.
    try { ircState.socket.write('CAP END\r\n'); } catch {}
    ircState.saslPending = false;
    safeSend(ircState.sender, 'irc:event', { type: 'sasl', ok: true });
    return;
  }
  if (command === '902' || command === '904' || command === '905' || command === '906' || command === '907') {
    // SASL failure family — proceed unauth so the user still gets connected.
    try { ircState.socket.write('CAP END\r\n'); } catch {}
    ircState.saslPending = false;
    safeSend(ircState.sender, 'irc:event', { type: 'sasl', ok: false, error: params[params.length - 1] || `SASL ${command}` });
    return;
  }
  if (command === 'JOIN') {
    if (senderNick === ircState.nick) ircState.joined.add(params[0]);
    safeSend(ircState.sender, 'irc:event', { type: 'join', from: senderNick, channel: params[0] });
    return;
  }
  if (command === 'PART') {
    safeSend(ircState.sender, 'irc:event', { type: 'part', from: senderNick, channel: params[0] });
    return;
  }
  if (command === 'QUIT') {
    safeSend(ircState.sender, 'irc:event', { type: 'quit', from: senderNick, reason: params[0] || '' });
    return;
  }
  if (command === 'NICK') {
    safeSend(ircState.sender, 'irc:event', { type: 'nick-change', from: senderNick, to: params[0] });
    return;
  }
  if (command === 'PRIVMSG') {
    const target = params[0];
    const text   = params[1] || '';
    if (text.charCodeAt(0) === 1) {
      // CTCP — strip the framing 0x01 bytes.
      const ctcp = text.replace(/\x01/g, '');
      if (ctcp.startsWith('DCC ')) { ircHandleDcc(senderNick, ctcp); return; }
      safeSend(ircState.sender, 'irc:event', { type: 'ctcp', from: senderNick, target, text: ctcp });
      return;
    }
    safeSend(ircState.sender, 'irc:event', { type: 'message', from: senderNick, target, text });
    return;
  }
  if (command === 'NOTICE') {
    safeSend(ircState.sender, 'irc:event', { type: 'notice', from: senderNick, target: params[0], text: params[1] || '' });
    return;
  }
  if (/^\d{3}$/.test(command)) {
    safeSend(ircState.sender, 'irc:event', { type: 'numeric', code: command, params, text: params.slice(-1)[0] });
    return;
  }
  safeSend(ircState.sender, 'irc:event', { type: 'raw', command, params });
}

// ── SOCKS5 client ────────────────────────────────────────────────────────────
// Minimal SOCKS5 connector for IRC traffic. Supports no-auth (0x00) and
// username/password auth (0x02). Returns a fully-tunneled net.Socket that
// behaves transparently after the handshake completes — caller can hand it
// to tls.connect({socket}) or use it raw.
function socks5Connect({ proxyHost, proxyPort, proxyUser, proxyPass, destHost, destPort }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, proxyHost);
    let stage = 'greet';   // greet → (auth) → connect → tunnel
    const fail = (msg) => { try { sock.destroy(); } catch {} reject(new Error(`SOCKS5: ${msg}`)); };

    sock.once('connect', () => {
      // Advertise both auth methods we support: 0x00 (no auth) and 0x02 (user/pass)
      sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
    });
    sock.on('error', reject);

    // The buffer may straddle SOCKS replies and IRC welcome bytes — accumulate
    // until we have a complete SOCKS reply, then hand the residual to the IRC
    // stream via socket.unshift().
    let buf = Buffer.alloc(0);
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      try {
        while (true) {
          if (stage === 'greet') {
            if (buf.length < 2) return;
            if (buf[0] !== 0x05) return fail('bad greeting reply');
            const method = buf[1];
            buf = buf.slice(2);
            if (method === 0xff) return fail('no acceptable auth method');
            if (method === 0x02) {
              const u = Buffer.from(proxyUser || '', 'utf8');
              const p = Buffer.from(proxyPass || '', 'utf8');
              sock.write(Buffer.concat([
                Buffer.from([0x01, u.length]), u,
                Buffer.from([p.length]), p
              ]));
              stage = 'auth';
            } else {
              sendConnect();
              stage = 'connect';
            }
            continue;
          }
          if (stage === 'auth') {
            if (buf.length < 2) return;
            if (buf[1] !== 0x00) return fail('auth failed');
            buf = buf.slice(2);
            sendConnect();
            stage = 'connect';
            continue;
          }
          if (stage === 'connect') {
            if (buf.length < 5) return;
            if (buf[0] !== 0x05) return fail('bad connect reply');
            if (buf[1] !== 0x00) return fail(`connect rejected (rep=${buf[1]})`);
            const atyp = buf[3];
            let replyLen;
            if (atyp === 0x01)      replyLen = 4 + 4 + 2;          // IPv4
            else if (atyp === 0x03) replyLen = 4 + 1 + buf[4] + 2; // domain
            else if (atyp === 0x04) replyLen = 4 + 16 + 2;         // IPv6
            else return fail(`unknown atyp ${atyp}`);
            if (buf.length < replyLen) return;
            const residual = buf.slice(replyLen);
            buf = Buffer.alloc(0);
            stage = 'tunnel';
            // Detach our data handler — the socket is now transparent.
            sock.removeAllListeners('data');
            sock.removeAllListeners('error');
            // Re-emit any post-reply bytes back into the stream so the next
            // consumer (TLS handshake or IRC parser) gets them.
            if (residual.length) sock.unshift(residual);
            return resolve(sock);
          }
        }
      } catch (e) { fail(e.message); }
    });

    function sendConnect() {
      const host = Buffer.from(destHost, 'utf8');
      sock.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
        host,
        Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff])
      ]));
    }
  });
}

// Wrap an existing socket (plain or SOCKS-tunneled) with TLS. We pass
// rejectUnauthorized:false because many IRC networks ship self-signed certs
// — strict verification would block users on the most common setups.
function wrapWithTls(socket, servername) {
  return tls.connect({ socket, servername, rejectUnauthorized: false });
}

// ── Global SOCKS5 proxy plumbing ─────────────────────────────────────────────
// When the user enables SOCKS5, we route ALL outgoing HTTP/HTTPS traffic
// through it — not just IRC. Three layers, one per network stack:
//   1) undici (Node fetch): setGlobalDispatcher with a custom connect that
//      routes through socks5Connect, with TLS wrap for https://.
//   2) Electron's session (renderer fetch + <img> + Electron net): use
//      session.setProxy with the SOCKS rules string.
//   3) yt-dlp: append --proxy socks5h:// to every spawn (see getYtDlpProxyArg).
// BT peer traffic is NOT proxied — peer connections are direct by protocol
// and any tunneling would break trackers/DHT.
let globalProxyApplied = false;
async function applyGlobalProxy() {
  const cfg = loadConfig();
  // Lazy require — undici is bundled with Node 18+ in Electron, but the
  // dispatcher APIs aren't used elsewhere, so we don't want to load it
  // at startup unless the user actually opts in.
  let undici;
  try { undici = require('undici'); } catch { undici = null; }

  if (!cfg.socks_enabled || !cfg.socks_host) {
    if (globalProxyApplied) {
      // Restore default dispatcher + clear Electron session proxy.
      if (undici) try { undici.setGlobalDispatcher(new undici.Agent()); } catch {}
      try { require('electron').session.defaultSession.setProxy({ proxyRules: '' }); } catch {}
      globalProxyApplied = false;
      log('INFO', 'Global SOCKS5 proxy disabled');
    }
    return;
  }

  const host = cfg.socks_host;
  const port = cfg.socks_port || 1080;
  const user = cfg.socks_user || '';
  const pass = cfg.socks_pass || '';

  // (1) undici dispatcher for main-process fetch calls. We craft an Agent
  //     whose `connect` function builds a SOCKS5-tunneled socket and
  //     optionally wraps it with TLS for https URLs.
  if (undici) {
    try {
      const dispatcher = new undici.Agent({
        connect: async (opts, cb) => {
          try {
            const hostname = opts.hostname;
            const destPort = parseInt(opts.port, 10) || (opts.protocol === 'https:' ? 443 : 80);
            const sock = await socks5Connect({
              proxyHost: host, proxyPort: port,
              proxyUser: user, proxyPass: pass,
              destHost: hostname, destPort
            });
            if (opts.protocol === 'https:') {
              const tlsSock = tls.connect({ socket: sock, servername: hostname });
              tlsSock.once('secureConnect', () => cb(null, tlsSock));
              tlsSock.once('error', cb);
            } else {
              cb(null, sock);
            }
          } catch (e) { cb(e); }
        }
      });
      undici.setGlobalDispatcher(dispatcher);
    } catch (e) {
      log('ERROR', `undici dispatcher setup: ${e.message}`);
    }
  }

  // (2) Electron session proxy — covers renderer fetch + Electron net.request
  //     + <img>/<audio> loads (e.g. cover art preview, RadioBrowser favicons).
  //     Auth in proxyRules isn't well supported by Chromium for SOCKS5 —
  //     for authed proxies the user should rely on (1) and yt-dlp, or
  //     configure auth at the proxy daemon (e.g. Tor cookie auth).
  try {
    const { session } = require('electron');
    const rule = `socks5://${host}:${port}`;
    session.defaultSession.setProxy({ proxyRules: rule });
  } catch (e) {
    log('ERROR', `session.setProxy: ${e.message}`);
  }

  globalProxyApplied = true;
  log('INFO', `Global SOCKS5 proxy active: ${host}:${port}`);
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

// Open the IRC transport: plain TCP, TLS, or either of those over SOCKS5,
// depending on user config. Returns a connected socket ready for write().
async function openIrcTransport({ server, port, useTls }) {
  const cfg = loadConfig();
  let raw;
  if (cfg.socks_enabled && cfg.socks_host) {
    raw = await socks5Connect({
      proxyHost: cfg.socks_host,
      proxyPort: cfg.socks_port || 1080,
      proxyUser: cfg.socks_user || '',
      proxyPass: cfg.socks_pass || '',
      destHost: server,
      destPort: port
    });
  } else {
    raw = await new Promise((resolve, reject) => {
      const s = net.connect(port, server);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
  }
  return useTls ? wrapWithTls(raw, server) : raw;
}

ipcMain.handle('irc:connect', async (event, opts = {}) => {
  if (ircState.socket) { try { ircState.socket.destroy(); } catch {} }
  const cfg = loadConfig();
  const { server, port = 6667, nick = 'FluxUser', tls: useTls = false } = opts;
  if (!server) return { ok: false, error: 'server required' };
  ircState.sender = event.sender;
  ircState.nick   = nick;
  ircState.buffer = '';
  ircState.joined.clear();
  // SASL creds — pulled from config (the renderer never sends them over IPC
  // so they don't transit through the event payload). Both the explicit
  // enable flag AND populated credentials are required to actually
  // attempt SASL — otherwise we silently skip it.
  const saslAccount  = (cfg.irc_sasl_account || '').trim();
  const saslPassword = cfg.irc_sasl_password || '';
  const useSasl = !!(cfg.irc_sasl_enabled && saslAccount && saslPassword);
  ircState.saslCreds   = useSasl ? { account: saslAccount, password: saslPassword } : null;
  ircState.saslPending = useSasl;

  let socket;
  try {
    socket = await openIrcTransport({ server, port, useTls });
  } catch (e) {
    return { ok: false, error: `transport: ${e.message}` };
  }
  ircState.socket = socket;

  return new Promise((resolve) => {
    let resolved = false;
    // SASL must be requested BEFORE NICK/USER so the server holds back 001
    // until CAP END is received. Issue CAP REQ :sasl first when configured.
    if (useSasl) {
      try { socket.write('CAP REQ :sasl\r\n'); } catch {}
    }
    try { socket.write(`NICK ${nick}\r\nUSER ${nick} 0 * :${nick}\r\n`); } catch {}

    socket.on('data', d => {
      ircState.buffer += d.toString('utf8');
      const lines = ircState.buffer.split(/\r\n|\r|\n/);
      ircState.buffer = lines.pop();
      for (const line of lines) ircHandleLine(line);
      if (!resolved && /\s001\s/.test(d.toString('utf8'))) {
        resolved = true;
        safeSend(ircState.sender, 'irc:event', { type: 'connected', nick, server, tls: useTls });
        resolve({ ok: true });
      }
    });
    socket.on('error', (e) => {
      if (!resolved) { resolved = true; resolve({ ok: false, error: e.message }); }
      safeSend(ircState.sender, 'irc:event', { type: 'error', error: e.message });
    });
    socket.on('close', () => {
      ircState.socket = null;
      safeSend(ircState.sender, 'irc:event', { type: 'disconnected' });
    });
    setTimeout(() => {
      if (!resolved) { resolved = true; resolve({ ok: true, warn: 'no welcome reply within 15s' }); }
    }, 15000);
  });
});

ipcMain.handle('irc:disconnect', () => {
  if (ircState.socket) {
    try { ircState.socket.write('QUIT :FLUX\r\n'); } catch {}
    try { ircState.socket.destroy(); } catch {}
    ircState.socket = null;
  }
  for (const tr of ircState.transfers.values()) {
    try { tr.socket.destroy(); } catch {}
    try { tr.writeStream.end(); } catch {}
  }
  ircState.transfers.clear();
  return { ok: true };
});

ipcMain.handle('irc:join', (_, { channel } = {}) => {
  if (!ircState.socket || !channel) return { ok: false, error: 'not connected' };
  try { ircState.socket.write(`JOIN ${channel}\r\n`); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
});

ipcMain.handle('irc:send', (_, { target, message } = {}) => {
  if (!ircState.socket || !target || !message) return { ok: false, error: 'not connected or empty payload' };
  try { ircState.socket.write(`PRIVMSG ${target} :${message}\r\n`); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
});

// Raw IRC command — escape hatch for LIST / NAMES / WHOIS / QUOTE etc. that
// don't fit the PRIVMSG mold. The renderer composes the full IRC line
// (without trailing CRLF) and main appends it.
ipcMain.handle('irc:raw', (_, { line } = {}) => {
  if (!ircState.socket || !line) return { ok: false, error: 'not connected or empty line' };
  try { ircState.socket.write(`${line}\r\n`); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
});

// ─── IPC: SCHEDULE ───────────────────────────────────────────────────────────
ipcMain.handle('schedule:load', () => loadSchedule());
ipcMain.handle('schedule:save', (_, s) => { const ok = saveSchedule(s); startScheduler(); return ok; });

// ─── IPC: QUEUE ──────────────────────────────────────────────────────────────
ipcMain.handle('queue:load',   ()      => loadQueue());
ipcMain.handle('queue:save',   (_, q)  => { saveQueue(q); return true; });
ipcMain.handle('queue:clear',  ()      => { saveQueue([]); return true; });

// Bulk import: open a file dialog (CSV / TXT), parse the contents into a
// normalized {title, url, format, isSearchQuery} list and hand it back to
// the renderer. Renderer is responsible for converting these to queue items.
// Format recognition mirrors the original tools/Media downloader.ps1:
//   .txt  one entry per line — URL or song title. Lines starting with # are
//         treated as comments and skipped; empties skipped.
//   .csv  comma/semicolon/tab-delimited. First-row header is auto-detected
//         when it contains any of: title / name / url / format / query / track
//         / artist. Header maps columns; otherwise the first column is the
//         title and the second (if any) is treated as URL.
// Lightweight URL reachability check used by the import-review modal so the
// user sees which rows will definitely work before they're added to queue.
// Strategy: HEAD with 5s timeout; if the server rejects HEAD (some don't),
// fall back to a short GET that closes the connection on first byte.
ipcMain.handle('queue:checkUrl', async (_, url) => {
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: 'Invalid URL' };
  const mod = url.startsWith('https') ? require('https') : require('http');
  const probeOnce = (method, target, _redirects = 0) => new Promise(resolve => {
    if (_redirects > 5) return resolve({ ok: false, status: 0, error: 'Too many redirects' });
    const req = mod.request(target, {
      method,
      timeout: 5000,
      headers: { 'User-Agent': 'FLUX/1.0 (link-check)' }
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        req.destroy();
        return probeOnce(method, res.headers.location, _redirects + 1).then(resolve);
      }
      const ok = res.statusCode >= 200 && res.statusCode < 400;
      req.destroy();
      resolve({ ok, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'Timeout' }); });
    req.on('error',   err => resolve({ ok: false, status: 0, error: err.message }));
    req.end();
  });
  let r = await probeOnce('HEAD', url);
  if (!r.ok && r.status >= 400 && r.status < 500) r = await probeOnce('GET', url);
  return r;
});

ipcMain.handle('queue:importList', async (_, pastedText) => {
  // Paste mode: parse the supplied text directly (treated as a TXT list),
  // skipping the file picker. Used by the "Search music from list" popup.
  if (typeof pastedText === 'string' && pastedText.trim()) {
    try {
      let content = pastedText;
      if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
      const rows = parseImportTXT(content);
      return { ok: true, rows, filePath: '', count: rows.length };
    } catch (e) {
      log('ERROR', `queue:importList (paste): ${e.message}`);
      return { ok: false, error: e.message };
    }
  }
  const dlg = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'List (CSV / TXT)', extensions: ['csv', 'txt'] },
      { name: 'All', extensions: ['*'] }
    ]
  });
  if (dlg.canceled || !dlg.filePaths.length) return { ok: false, cancelled: true };
  const filePath = dlg.filePaths[0];
  try {
    // Strip a BOM if present, then split on any newline style.
    let content = fs.readFileSync(filePath, 'utf8');
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    const ext = path.extname(filePath).toLowerCase();
    const rows = ext === '.csv' ? parseImportCSV(content) : parseImportTXT(content);
    return { ok: true, rows, filePath, count: rows.length };
  } catch (e) {
    log('ERROR', `queue:importList ${filePath}: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

function parseImportTXT(content) {
  return content.split(/\r?\n/)
    .map(l => l.trim())
    // Strip surrounding single/double quotes — exported Shazam-like lists
    // wrap each row in quotes, which we don't want as part of the search query.
    .map(l => l.replace(/^["']+|["']+$/g, '').trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith(';'))
    .map(line => {
      const isUrl = /^https?:\/\//i.test(line);
      return { url: isUrl ? line : null, title: line, format: null, isSearchQuery: !isUrl };
    });
}

// Robust CSV splitter that respects quoted fields containing the delimiter.
// Handles: `1,"Hello, world","Foo"` → ["1", "Hello, world", "Foo"]
function splitCSVRow(line, delim) {
  const out = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }       // RFC4180 escaped quote
      else if (ch === '"') { inQuote = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === delim) { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseImportCSV(content) {
  const rawLines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!rawLines.length) return [];
  const headerKeywords = new Set(['title', 'name', 'url', 'format', 'query', 'track', 'artist', 'tagtime', 'trackkey', 'index']);

  // Scan the first few lines for a header row. Shazam exports start with a
  // single-cell preamble line ("Shazam Library") before the real header, so
  // we look up to 5 lines deep instead of assuming line 0 is the header.
  let headerLineIdx = -1, headerFields = null, delim = ',';
  for (let i = 0; i < Math.min(5, rawLines.length); i++) {
    const line = rawLines[i];
    const tryDelim = line.includes('\t') ? '\t' : line.includes(';') ? ';' : ',';
    const fields = splitCSVRow(line, tryDelim).map(f => f.toLowerCase());
    if (fields.length >= 2 && fields.some(f => headerKeywords.has(f))) {
      headerLineIdx = i;
      headerFields = fields;
      delim = tryDelim;
      break;
    }
  }

  let titleIdx = 0, urlIdx = -1, formatIdx = -1, artistIdx = -1;
  let dataLines;
  if (headerLineIdx >= 0) {
    const find = (...names) => headerFields.findIndex(f => names.includes(f));
    titleIdx  = find('title', 'name', 'query', 'track');
    urlIdx    = find('url');
    formatIdx = find('format');
    artistIdx = find('artist');
    if (titleIdx === -1) titleIdx = 0;
    dataLines = rawLines.slice(headerLineIdx + 1);
  } else {
    // No header detected. Sniff delimiter from the first line and use index 0
    // as title; if column 2 looks like a URL, use it as the URL column.
    const first = rawLines[0];
    delim = first.includes('\t') ? '\t' : first.includes(';') ? ';' : ',';
    const firstFields = splitCSVRow(first, delim);
    if (firstFields.length >= 2 && /^https?:\/\//i.test(firstFields[1])) urlIdx = 1;
    dataLines = rawLines;
  }

  return dataLines.map(line => {
    const f = splitCSVRow(line, delim);
    let title = f[titleIdx] || '';
    let url   = urlIdx    >= 0 ? (f[urlIdx]    || '') : '';
    const format = formatIdx >= 0 ? (f[formatIdx] || '') : '';
    const artist = artistIdx >= 0 ? (f[artistIdx] || '') : '';
    // Shazam URLs (shazam.com/track/...) are landing pages, not media —
    // dropping them forces the search-query path on title+artist, which is
    // what the user actually wants to download.
    if (url && /(^|\.)shazam\.com\//i.test(url)) url = '';
    // If we have artist + title columns, combine them for a richer search query.
    if (artist && title && !/^https?:/.test(title)) title = `${artist} - ${title}`;
    // If title looks like a URL and no explicit URL column, treat it as URL.
    let effUrl = url;
    let isSearchQuery = !effUrl;
    if (!effUrl && /^https?:\/\//i.test(title)) { effUrl = title; isSearchQuery = false; }
    return { url: effUrl || null, title: title || effUrl, format: format || null, isSearchQuery };
  }).filter(r => r.title || r.url);
}

ipcMain.handle('queue:run', async (event, { queue, config }) => {
  const concurrency = Math.max(1, Math.min(5, parseInt(config.concurrency) || 1));
  const results = [];
  let cursor = 0;
  queueStopRequested = false; // reset for this run

  async function processOne(item) {
    safeSend(event.sender, 'queue:itemStart', { id: item.id });
    // Wrap event.sender so media progress for this item routes to queue:progress instead.
    // This keeps the queue-log informative even when concurrency > 1 (each line carries item.id).
    const wrappedEvent = {
      sender: {
        isDestroyed: () => event.sender.isDestroyed(),
        send: (channel, payload) => {
          if (channel === 'media:progress') {
            safeSend(event.sender, 'queue:progress', { id: item.id, name: item.name, ...payload });
          } else {
            safeSend(event.sender, channel, payload);
          }
        }
      }
    };
    let result;
    try {
      if (item.type === 'media') {
        if (!item.url) throw new Error('Missing URL');
        result = await runMediaDownloadRetry(wrappedEvent, item.url, item.format, config.download_folder, config.retry_count);
      } else if (item.type === 'torrent') {
        if (!item.torrentItem) throw new Error('Missing torrent data');
        result = await saveTorrentItem(item.torrentItem, config.download_folder);
      } else {
        throw new Error(`Unknown item type: ${item.type}`);
      }
      const itemOk = result?.ok ?? true;
      const stopped = !!result?.stopped;
      safeSend(event.sender, 'queue:itemDone', { id: item.id, ok: itemOk, error: result?.error, stopped });
      results.push({ id: item.id, ok: itemOk, error: result?.error, stopped });
      appendHistory({
        kind: item.type,
        name: item.name,
        ok: itemOk,
        error: result?.error || null,
        path: result?.path || null,
        source: item.torrentItem?.site || (item.type === 'media' ? 'yt-dlp' : null)
      });
    } catch (e) {
      safeSend(event.sender, 'queue:itemDone', { id: item.id, ok: false, error: e.message });
      results.push({ id: item.id, ok: false, error: e.message });
      appendHistory({ kind: item.type, name: item.name, ok: false, error: e.message });
    }
  }

  async function worker() {
    while (cursor < queue.length && !queueStopRequested) {
      const idx = cursor++;
      await processOne(queue[idx]);
    }
    if (queueStopRequested) log('INFO', `queue worker exited early (stop requested)`);
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { results, stopped: queueStopRequested };
});

// ─── IPC: TORRENT SEARCH ─────────────────────────────────────────────────────
ipcMain.handle('torrent:search', async (event, { query, config }) => {
  return new Promise((resolve) => {
    const results = [], errors = [];
    const sites   = Object.keys(config.sites).filter(s => config.sites[s].enabled);
    let pending   = sites.length;
    if (pending === 0) return resolve({ results: [], errors: ['No sites enabled'] });

    sites.forEach(site => {
      searchSite(site, query, config)
        .then(r  => { results.push(...r); })
        .catch(e => { errors.push(`${site}: ${describeNetError(e)}`); })
        .finally(() => {
          pending--;
          safeSend(event.sender, 'torrent:siteProgress', { site });
          if (pending === 0) {
            results.sort((a, b) => b.seeds - a.seeds);
            resolve({ results, errors });
          }
        });
    });
  });
});

function describeNetError(e) {
  const m = e?.message || String(e);
  if (/ECONNREFUSED.*127\.0\.0\.1/.test(m)) return `Domain resolves to localhost — check hosts file or DNS (${m})`;
  if (/ENOTFOUND/.test(m))                  return `DNS lookup failed — check connection or DNS resolver (${m})`;
  if (/ETIMEDOUT|Timeout/i.test(m))         return `Connection timed out — server slow or unreachable`;
  if (/HTTP 5\d\d/.test(m))                 return `Server error (${m})`;
  if (/HTTP 4\d\d/.test(m))                 return `Bad request / not found (${m})`;
  return m;
}

// YTS mirror fallback list. yts.mx is the canonical/most-stable domain but
// gets blocked at the DNS/ISP level in several countries (notably Italy via
// court order). When DNS lookup fails on the user's configured endpoint, we
// transparently try the next mirror in this list. First one that resolves +
// returns valid JSON wins; the working URL is cached for the rest of the
// session so we don't pay the ENOTFOUND timeout on every search.
const YTS_FALLBACK_MIRRORS = [
  'https://yts.mx/api/v2',
  'https://yts.am/api/v2',
  'https://yts.rs/api/v2',
  'https://yts.lt/api/v2'
];
let _ytsWorkingMirror = null;  // session cache

async function fetchYtsWithFallback(pathQuery, configuredApi) {
  // Try the user's configured api first (so custom mirrors set via Settings
  // are honoured), then walk the fallback list. Skip duplicates.
  const candidates = [];
  if (_ytsWorkingMirror) candidates.push(_ytsWorkingMirror);  // session-cached hit
  if (configuredApi && !candidates.includes(configuredApi)) candidates.push(configuredApi);
  for (const m of YTS_FALLBACK_MIRRORS) if (!candidates.includes(m)) candidates.push(m);
  let lastErr = null;
  for (const base of candidates) {
    try {
      const data = await fetchJSON(`${base}${pathQuery}`);
      _ytsWorkingMirror = base;   // cache for the session — subsequent searches hit this first
      return data;
    } catch (e) {
      lastErr = e;
      const msg = e.message || '';
      // Walk to the next mirror on anything MIRROR-SPECIFIC: DNS / network
      // failures, HTTP 5xx / 429 / 403 (yts.mx is flaky and frequently 500s or
      // is Cloudflare-gated), and non-JSON error pages (a mirror serving an HTML
      // error/captcha page). These differ between mirrors, so a sibling may
      // still work. Only a genuine query error (HTTP 400 / 404) would repeat
      // identically everywhere → fail fast on those.
      const mirrorSpecific =
        /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Timeout/i.test(msg) ||
        /HTTP (5\d\d|429|403)/.test(msg) ||
        /Invalid JSON/i.test(msg);
      if (!mirrorSpecific) throw e;
      log('WARN', `YTS mirror ${base} failed (${msg}) — trying next`);
    }
  }
  // All mirrors exhausted. Surface the last error (likely ENOTFOUND) so the
  // existing prettyNetworkError translator turns it into the user-facing toast.
  throw lastErr || new Error('All YTS mirrors unreachable');
}

async function searchSite(site, query, config) {
  const siteCfg = config.sites[site] || {};
  const limit   = siteCfg.max_results || config.max_results || 5;
  const encoded = encodeURIComponent(query);

  switch (site.toUpperCase()) {
    case 'YTS': {
      const data = await fetchYtsWithFallback(
        `/list_movies.json?query_term=${encoded}&limit=${limit}&sort_by=seeds`,
        siteCfg.api
      );
      if (data?.status !== 'ok' || !data?.data?.movies) return [];
      const out = [];
      for (const movie of data.data.movies)
        for (const t of (movie.torrents || []))
          out.push({ name: `${movie.title} (${movie.year}) [${t.quality}]`, seeds: +t.seeds||0, leeches: +t.peers||0, size: t.size||'N/A', url: t.url, magnet: null, type: 'torrent', site: 'YTS' });
      return out.sort((a,b) => b.seeds-a.seeds).slice(0, limit);
    }
    case 'NYAA': {
      const api = siteCfg.api || 'https://nyaa.si';
      return parseNyaaRSS(await fetchTextSimple(`${api}/?page=rss&q=${encoded}&c=0_0&f=0`), limit);
    }
    // case '1337X' removed — no working public endpoint. If user adds a custom 1337x-style
    // site via "Add Source", they can wire it through the generic fetchJSON path or add their own case.
    case 'TPB': {
      const api  = siteCfg.api || 'https://apibay.org';
      const data = await fetchJSON(`${api}/q.php?q=${encoded}&cat=0`);
      if (!Array.isArray(data)) return [];
      // apibay's "no results" response is a SINGLE sentinel row with
      //   name === '0' OR name === 'No results returned' AND a zero
      //   info_hash. Filter out so we don't surface a fake row in the UI.
      const real = data.filter(i =>
        i && i.name && i.name !== '0' && i.name !== 'No results returned'
        && i.info_hash && !/^0+$/.test(i.info_hash));
      if (!real.length) return [];
      return real.slice(0, limit).map(i => {
        const mag = `magnet:?xt=urn:btih:${i.info_hash}&dn=${encodeURIComponent(i.name)}&tr=udp://tracker.openbittorrent.com:80&tr=udp://tracker.opentrackr.org:1337`;
        return { name: i.name||'Unknown', seeds: +i.seeders||0, leeches: +i.leechers||0, size: i.size?`${(+i.size/1048576).toFixed(2)} MB`:'N/A', url: null, magnet: mag, type: 'magnet', site: 'TPB' };
      }).sort((a,b)=>b.seeds-a.seeds);
    }
    default: return [];
  }
}

// Note: magnet links pasted into the torrent search bar via DnD are NOT
// queries — currently they fall through to the generic search which produces
// 0 results. Future improvement: detect magnet → fast-path to direct download
// (sendto-torrent if configured) without round-tripping through TPB.

function parseNyaaRSS(xml, limit) {
  try {
    const items = [];
    for (const block of (xml.match(/<item>([\s\S]*?)<\/item>/g)||[]).slice(0, limit)) {
      const get  = t => { const m = block.match(new RegExp(`<${t}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${t}>|<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m?(m[1]||m[2]||'').trim():''; };
      const nyaa = t => { const m = block.match(new RegExp(`<nyaa:${t}[^>]*>([\\s\\S]*?)<\\/nyaa:${t}>`)); return m?m[1].trim():'0'; };
      const encl = block.match(/enclosure[^>]+url="([^"]+)"/);
      const title = get('title');
      if (!title) continue;
      items.push({ name: title, seeds: +nyaa('seeders')||0, leeches: +nyaa('leechers')||0, size: nyaa('size')||'N/A', url: encl?encl[1]:null, magnet: null, type: 'torrent', site: 'Nyaa' });
    }
    return items.sort((a,b)=>b.seeds-a.seeds);
  } catch (e) { log('ERROR', `Nyaa: ${e.message}`); return []; }
}

// ─── IPC: TORRENT SAVE ───────────────────────────────────────────────────────
ipcMain.handle('torrent:save', async (_, { item, downloadFolder }) => saveTorrentItem(item, downloadFolder));

async function saveTorrentItem(item, downloadFolder) {
  try {
    fs.mkdirSync(downloadFolder, { recursive: true });
    const safe = item.name.replace(/[\\/:*?"<>|]/g,'_').substring(0,120);
    if (item.type === 'magnet' && item.magnet) {
      const p = path.join(downloadFolder, `${safe}.magnet`);
      fs.writeFileSync(p, item.magnet, 'utf8');
      log('INFO', `Magnet saved: ${p}`);
      return { ok: true, path: p, type: 'magnet' };
    }
    if (item.url) {
      const p = path.join(downloadFolder, `${safe}.torrent`);
      await downloadFile(item.url, p);
      log('INFO', `Torrent saved: ${p}`);
      return { ok: true, path: p, type: 'torrent' };
    }
    return { ok: false, error: 'No URL or magnet available' };
  } catch (e) { log('ERROR', `Save: ${e.message}`); return { ok: false, error: e.message }; }
}

// ─── IPC: MEDIA DOWNLOAD (with retry/resume) ─────────────────────────────────
// DRM-protected streaming platforms — yt-dlp can't decrypt their Widevine /
// FairPlay streams, and we never want to be perceived as a tool that tries.
// Match by hostname (host + parents) so paths don't matter; substring match
// keeps the list short (one entry per brand, regardless of TLD).
const DRM_BLOCKED_HOSTS = [
  'netflix.com', 'nflxvideo.net',
  'primevideo.com', 'aiv-cdn.net', 'amazon.com/gp/video', 'amazon.', 'amazon.co.uk/gp/video',
  'disneyplus.com', 'disney-plus.', 'star-plus.',
  'hbomax.com', 'max.com', 'play.hbomax.com',
  'paramountplus.com',
  'peacocktv.com',
  'tv.apple.com', 'itunes.apple.com',
  'crunchyroll.com',
  'nowtv.it', 'nowtv.com', 'now.com/uk',
  'mediasetinfinity.mediaset.it',
  'sky.com', 'skygo.sky.com', 'skyshowtime.com',
  'discoveryplus.', 'dplay.com',
  'fubo.tv',
  'hotstar.com', 'starplus.com',
  'kocowa.com', 'viki.com',
  'wow.de', 'joyn.de'
];
function isDrmHost(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const full = (host + u.pathname).toLowerCase();
    return DRM_BLOCKED_HOSTS.some(needle => host.includes(needle) || full.includes(needle));
  } catch { return false; }
}

ipcMain.handle('media:download', async (event, { url, format, downloadFolder, retry }) => {
  if (isDrmHost(url)) {
    return { ok: false, drm: true, error: 'DRM-protected platform — not supported by FLUX.' };
  }
  return runMediaDownloadRetry(event, url, format, downloadFolder, retry ?? 2);
});

async function runMediaDownloadRetry(event, url, format, downloadFolder, retryCount) {
  const maxAttempts = Math.max(1, (retryCount ?? 2) + 1);
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await runMediaDownload(event, url, format, downloadFolder, attempt);
    if (result.ok) return result;
    if (result.stopped) return result; // user-initiated, do not retry
    lastErr = result;
    if (attempt < maxAttempts) {
      const wait = Math.min(30000, 2000 * Math.pow(2, attempt - 1));
      safeSend(event.sender, 'media:progress', { line: `⟳ Retry ${attempt}/${maxAttempts - 1} in ${wait/1000}s...`, error: false });
      await new Promise(r => setTimeout(r, wait));
    }
  }
  return lastErr;
}

async function runMediaDownload(event, url, format, downloadFolder, attempt = 1) {
  return new Promise((resolve) => {
    fs.mkdirSync(downloadFolder, { recursive: true });
    const ytdlp = getYtDlpPath();
    if (!ytdlp) {
      const msg = `yt-dlp is missing from the installation. Please reinstall FLUX.`;
      log('ERROR', msg);
      return resolve({ ok: false, error: msg });
    }

    // Route final + temp paths via -P so partial segments end up in .flux-temp/
    // (cleaned on Stop). NB: using -P requires a RELATIVE -o template, otherwise
    // yt-dlp emits "WARNING: --paths is ignored since an absolute path is given".
    const fluxTempDir = path.join(downloadFolder, '.flux-temp');
    fs.mkdirSync(fluxTempDir, { recursive: true });
    const args = [
      '--continue', '--no-overwrites',
      '-P', `home:${downloadFolder}`,
      '-P', `temp:${fluxTempDir}`,
    ];
    // Point yt-dlp at our bundled ffmpeg + ffprobe so postprocessing
    // (audio extraction, video+audio merge) works on systems without
    // a system-wide ffmpeg install. Without this the packaged app fails
    // with "Postprocessing: ffprobe and ffmpeg not found".
    const ffDir = getFfmpegDir();
    if (ffDir) args.push('--ffmpeg-location', ffDir);
    // User-configured speed cap. yt-dlp expects "<n>K" or "<n>M" etc.; we
    // store KB/s as an int so the unit is unambiguous. 0 = no limit.
    const cfgRate = parseInt(loadConfig()?.speed_limit_kbs, 10) || 0;
    if (cfgRate > 0) args.push('--limit-rate', `${cfgRate}K`);
    // Global SOCKS5 proxy (when configured) — yt-dlp gets its own --proxy
    // arg since it spawns as a child process and doesn't see our Node /
    // Electron dispatchers.
    const proxyArg = getYtDlpProxyArg();
    if (proxyArg) args.push('--proxy', proxyArg);
    // Compat mode: prefer H.264 video + AAC audio inside .mp4 so QuickTime
    // / iMovie / iPhone Photos / stock Windows player handle the file
    // without re-encoding. Off → yt-dlp picks "best" (usually VP9 on
    // YouTube — smaller but Mac-unfriendly). Toggled in Settings.
    const mp4Compat = loadConfig().mp4_compat !== false;
    const h264Pref  = '[vcodec^=avc1]';
    const aacPref   = '[acodec^=mp4a]';
    // Format presets
    switch (format) {
      case 'audio':       args.push('-x', '--audio-format', 'mp3',  '--audio-quality', '0', '--ppa', 'FFmpegExtractAudio:-id3v2_version 3 -write_xing 1'); break;
      case 'audio_flac':  args.push('-x', '--audio-format', 'flac', '--audio-quality', '0'); break;
      case 'audio_m4a':   args.push('-x', '--audio-format', 'm4a',  '--audio-quality', '0'); break;
      case 'audio_opus':  args.push('-x', '--audio-format', 'opus', '--audio-quality', '0'); break;
      case 'mkv':         args.push('--merge-output-format', 'mkv'); break;
      case 'mp4':
        args.push('-f', mp4Compat
          ? `bestvideo${h264Pref}+bestaudio${aacPref}/best[ext=mp4]/bestvideo+bestaudio/best`
          : 'bestvideo+bestaudio/best');
        args.push('--merge-output-format', 'mp4');
        break;
      case 'video_1080':
        args.push('-f', mp4Compat
          ? `bestvideo[height<=1080]${h264Pref}+bestaudio${aacPref}/bestvideo[height<=1080]+bestaudio/best[height<=1080]`
          : 'bestvideo[height<=1080]+bestaudio/best[height<=1080]');
        args.push('--merge-output-format', 'mp4');
        break;
      case 'video_720':
        args.push('-f', mp4Compat
          ? `bestvideo[height<=720]${h264Pref}+bestaudio${aacPref}/bestvideo[height<=720]+bestaudio/best[height<=720]`
          : 'bestvideo[height<=720]+bestaudio/best[height<=720]');
        args.push('--merge-output-format', 'mp4');
        break;
      case 'video':
      default:
        args.push('-f', mp4Compat
          ? `bestvideo${h264Pref}+bestaudio${aacPref}/bestvideo+bestaudio/best`
          : 'bestvideo+bestaudio/best');
        break;
    }
    // Relative template — combined with -P home: above this resolves to downloadFolder/title.ext
    args.push('-o', '%(title)s.%(ext)s', '--no-playlist', url);

    log('INFO', `yt-dlp attempt ${attempt}: ${url} [${format}]`);
    const proc = spawn(ytdlp, args, { shell: false });
    activeMediaProcs.add(proc);
    let lastDestPath = null;
    let stoppedByUser = false;
    proc.__fluxStop = () => { stoppedByUser = true; killProcessTree(proc); };

    proc.stdout.on('data', d => {
      // Split chunks on \n only (NOT on bare \r). yt-dlp uses bare \r to
      // redraw the live progress bar — keeping those grouped lets the
      // renderer's percentage parser see all snapshots in one event.
      // Real status lines (Destination, ExtractAudio, etc.) are \n-separated.
      // The previous one-pass match-on-chunk approach used $ as end-anchor,
      // which only matched the final line of the chunk — earlier
      // "Destination:" lines were silently dropped, so lastDestPath often
      // stuck to the original .webm in .flux-temp before the .mp3 extract.
      const text = d.toString();
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        safeSend(event.sender, 'media:progress', { line, error: false });
        const m = line.match(/^\[(?:download|ExtractAudio|Merger|ffmpeg)\]\s+(?:Destination:|Merging formats into|Adding metadata to)\s*"?([^"]+?)"?\s*$/);
        if (m) lastDestPath = m[1];
      }
    });
    // yt-dlp emits both fatal `ERROR:` and non-fatal `WARNING:` lines on
    // stderr. Only the former should trip the renderer's error styling
    // (red colour + auto-toast). Warnings come back as plain log lines so
    // the user sees them without thinking the download is broken — many
    // sites legitimately emit warnings (e.g. "unable to extract upload
    // date") while the download succeeds normally to 100%.
    proc.stderr.on('data', d => {
      for (const raw of d.toString().split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const isWarning = /^WARNING:/i.test(line);
        safeSend(event.sender, 'media:progress', { line, error: !isWarning });
      }
    });
    proc.on('close', code => {
      activeMediaProcs.delete(proc);
      if (stoppedByUser) return resolve({ ok: false, code, error: 'Stopped by user', stopped: true });
      if (code !== 0) return resolve({ ok: false, code, error: `yt-dlp exited with code ${code}` });
      // lastDestPath captures the most recent "Destination:" / "Merging into" /
      // "Adding metadata" line. During post-processing (ExtractAudio, Merger)
      // yt-dlp writes those to the TEMP dir (.flux-temp). After all
      // processing, yt-dlp moves the file from `temp:` to `home:` — but
      // that move isn't always logged on a parsable line, so the captured
      // path still points at .flux-temp.
      //
      // Resolve the real final location: take the basename, join with the
      // download folder, and use that if the file actually landed there
      // (which yt-dlp's --paths home:/temp: contract guarantees on success).
      // Edge case: occasionally yt-dlp leaves the post-processed file in
      // temp without moving (seen with some extractors / format combos).
      // In that case we move it ourselves so the saved path is always in
      // the user's clean download folder, never inside .flux-temp.
      let finalPath = lastDestPath;
      if (lastDestPath) {
        const candidate = path.join(downloadFolder, path.basename(lastDestPath));
        if (fs.existsSync(candidate)) {
          finalPath = candidate;
        } else if (fs.existsSync(lastDestPath) && lastDestPath !== candidate) {
          try {
            fs.renameSync(lastDestPath, candidate);
            finalPath = candidate;
            log('INFO', `media:download: rescued file from temp → ${candidate}`);
          } catch (e) {
            log('WARN', `media:download: temp→home rescue failed: ${e.message}`);
          }
        }
      }
      return resolve({ ok: true, code, path: finalPath });
    });
    proc.on('error', e => { activeMediaProcs.delete(proc); resolve({ ok: false, error: e.message }); });
  });
}

// ─── IPC: MEDIA PROBE (fetch title without downloading) ──────────────────────
ipcMain.handle('media:probe', (_, url) => probeMedia(url));
ipcMain.handle('media:getStreamUrl', (_, url) => getStreamUrl(url));

function getStreamUrl(url) {
  return new Promise(resolve => {
    const ytdlp = getYtDlpPath();
    if (!ytdlp) return resolve({ ok: false, error: 'yt-dlp not bundled' });
    if (!url || !/^https?:\/\//i.test(url)) return resolve({ ok: false, error: 'invalid URL' });

    // -g returns direct media URLs (one per stream when separate audio/video).
    // -f best/bestvideo+bestaudio gives a single combined URL when available.
    const args = ['--no-warnings', '-g', '--no-playlist', '-f', 'best[protocol^=m3u8]/best', url];
    const px = getYtDlpProxyArg(); if (px) args.unshift('--proxy', px);
    const proc = spawn(ytdlp, args, { shell: false });
    let out = '', err = '';
    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 15000);
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: (err || `exit ${code}`).trim().slice(0, 200) });
      const lines = out.trim().split('\n').filter(Boolean);
      resolve({ ok: true, url: lines[0] || null, urls: lines });
    });
    proc.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
  });
}

function probeMedia(url) {
  return new Promise(resolve => {
    const ytdlp = getYtDlpPath();
    if (!ytdlp) return resolve({ ok: false, error: 'yt-dlp not bundled' });
    if (!url || !/^https?:\/\//i.test(url)) return resolve({ ok: false, error: 'invalid URL' });
    // Short-circuit DRM-protected hosts BEFORE invoking yt-dlp — gives the
    // renderer a clear `drm: true` flag to show a specific user message
    // instead of a generic yt-dlp decryption error.
    if (isDrmHost(url)) return resolve({ ok: false, drm: true, error: 'DRM-protected platform — not supported by FLUX.' });

    // Probe also pulls best-format hints (resolution + audio bitrate +
    // codecs) so the UI can show a chip telling the user what's actually
    // available BEFORE they pick a format button. yt-dlp's --print
    // templates expand to "NA" for missing fields, which we filter out.
    const args = [
      '--no-warnings', '--skip-download', '--no-playlist',
      '--print', '%(title)s\t%(uploader|channel|extractor)s\t%(duration_string|duration)s\t%(is_live)s\t%(was_live)s\t%(resolution|NA)s\t%(vcodec|NA)s\t%(acodec|NA)s\t%(abr|NA)s\t%(ext|NA)s\t%(height|NA)s',
      url
    ];
    const px = getYtDlpProxyArg(); if (px) args.unshift('--proxy', px);
    const proc = spawn(ytdlp, args, { shell: false });
    let out = '', err = '';
    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 15000);
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: (err || `exit ${code}`).trim().slice(0, 200) });
      const [title, uploader, duration, isLive, wasLive, resolution, vcodec, acodec, abr, ext, height] = (out.trim().split('\n')[0] || '').split('\t');
      const clean = v => (v && v !== 'NA' && v !== 'none') ? v : null;
      resolve({
        ok: true,
        title:    title    || null,
        uploader: uploader || null,
        duration: duration || null,
        is_live:  isLive  === 'True',
        was_live: wasLive === 'True',
        resolution: clean(resolution),
        vcodec:     clean(vcodec),
        acodec:     clean(acodec),
        abr:        clean(abr),
        ext:        clean(ext),
        height:     parseInt(height, 10) || null
      });
    });
    proc.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
  });
}

// ─── IPC: LIVE RECORD (yt-dlp with live-aware args) ─────────────────────────
ipcMain.handle('live:record', (event, { url, format, fromStart, downloadFolder }) =>
  runLiveRecord(event, url, format, !!fromStart, downloadFolder));

async function runLiveRecord(event, url, format, fromStart, downloadFolder) {
  return new Promise((resolve) => {
    fs.mkdirSync(downloadFolder, { recursive: true });
    const ytdlp = getYtDlpPath();
    if (!ytdlp) return resolve({ ok: false, error: 'yt-dlp not bundled' });

    const fluxTempDir = path.join(downloadFolder, '.flux-temp');
    fs.mkdirSync(fluxTempDir, { recursive: true });

    // Live-friendly args: MKV container (resilient to incomplete writes), HLS mpegts,
    // resume disabled (live can't resume meaningfully).
    const args = [
      '-P', `home:${downloadFolder}`,
      '-P', `temp:${fluxTempDir}`,
      '--no-part',                       // write final file as it grows — partial captures usable
      '--hls-use-mpegts',                // safer for HLS live
      '--no-playlist',
      '--no-overwrites',
    ];
    // Point yt-dlp at bundled ffmpeg + ffprobe (same rationale as
    // media:download — without this, --merge-output-format + -x fail on
    // packaged builds without a system ffmpeg).
    const ffDir = getFfmpegDir();
    if (ffDir) args.push('--ffmpeg-location', ffDir);
    if (fromStart) args.push('--live-from-start');
    const cfgRate = parseInt(loadConfig()?.speed_limit_kbs, 10) || 0;
    if (cfgRate > 0) args.push('--limit-rate', `${cfgRate}K`);
    const proxyArg = getYtDlpProxyArg();
    if (proxyArg) args.push('--proxy', proxyArg);

    switch (format) {
      case 'audio':       args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0', '--ppa', 'FFmpegExtractAudio:-id3v2_version 3 -write_xing 1'); break;
      case 'video_1080':  args.push('-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]', '--merge-output-format', 'mkv'); break;
      case 'video_720':   args.push('-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]',  '--merge-output-format', 'mkv'); break;
      case 'video':
      default:            args.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mkv'); break;
    }
    args.push('-o', '%(title)s_%(release_timestamp,timestamp,epoch)s.%(ext)s', url);

    log('INFO', `live record: ${url} [${format}${fromStart?' fromStart':''}]`);
    const proc = spawn(ytdlp, args, { shell: false });
    activeMediaProcs.add(proc);
    let lastDestPath = null;
    let stoppedByUser = false;
    proc.__fluxStop = () => { stoppedByUser = true; killProcessTree(proc); };

    proc.stdout.on('data', d => {
      // Per-line scan (see media:download stdout handler for the rationale —
      // $ end-anchor + multi-line chunks made earlier Destination lines
      // invisible, leaving lastDestPath stuck on .flux-temp partials).
      const text = d.toString();
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        safeSend(event.sender, 'live:progress', { line, error: false });
        const m = line.match(/^\[(?:download|hlsnative|Merger|ffmpeg)\]\s+(?:Destination:|Merging formats into|Adding metadata to)\s*"?([^"]+?)"?\s*$/);
        if (m) lastDestPath = m[1];
      }
    });
    // Same WARNING vs ERROR distinction as the media download path —
    // keep warnings out of the renderer's error styling.
    proc.stderr.on('data', d => {
      for (const raw of d.toString().split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const isWarning = /^WARNING:/i.test(line);
        safeSend(event.sender, 'live:progress', { line, error: !isWarning });
      }
    });
    proc.on('close', code => {
      activeMediaProcs.delete(proc);
      // Same .flux-temp → home resolution as the regular media download.
      let finalPath = lastDestPath;
      if (lastDestPath) {
        const candidate = path.join(downloadFolder, path.basename(lastDestPath));
        if (fs.existsSync(candidate)) finalPath = candidate;
      }
      if (stoppedByUser) return resolve({ ok: true, code, path: finalPath, stopped: true });
      // Live recordings exit non-zero when stream ends — treat as ok if we captured anything
      resolve({ ok: finalPath != null || code === 0, code, path: finalPath, error: code !== 0 ? `yt-dlp exited with code ${code}` : null });
    });
    proc.on('error', e => { activeMediaProcs.delete(proc); resolve({ ok: false, error: e.message }); });
  });
}

// ─── IPC: MEDIA STOP (kills processes + halts queue + cleans partials) ───────
ipcMain.handle('media:stop', (_e, payload) => {
  let killed = 0;
  for (const p of activeMediaProcs) {
    if (typeof p.__fluxStop === 'function') p.__fluxStop();
    else killProcessTree(p);
    killed++;
  }
  activeMediaProcs.clear();
  queueStopRequested = true;

  // Wipe .flux-temp/ (partial yt-dlp segments). Small delay so taskkill releases handles.
  const downloadFolder = payload?.downloadFolder;
  if (downloadFolder) {
    setTimeout(() => {
      const tempDir = path.join(downloadFolder, '.flux-temp');
      try {
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        log('INFO', `media:stop cleaned ${tempDir}`);
      } catch (e) { log('WARN', `media:stop cleanup: ${e.message}`); }
    }, 500);
  }
  log('INFO', `media:stop killed ${killed} proc(s), queueStopRequested=true`);
  return { ok: true, killed };
});

// ─── IPC: RSS (robust parser) ────────────────────────────────────────────────
ipcMain.handle('rss:fetch', async (_, feedUrl) => {
  try {
    const xml   = await fetchTextSimple(feedUrl, 20000);
    const parsed = parseFeed(xml);
    return { ok: true, ...parsed };
  } catch (e) { return { ok: false, error: describeNetError(e) }; }
});

// Verify a candidate URL by fetching its first chunk and checking it parses
// as an XML feed (RSS 2.0 or Atom). Used by rss:discover both for the user's
// URL (in case it's already a feed) and for fallback candidates.
async function probeIsFeed(url) {
  try {
    const body = await fetchTextSimple(url);
    return /^(<\?xml\b|<rss\b|<feed\b)/i.test(body.slice(0, 1024).trim());
  } catch { return false; }
}

// Discover an RSS/Atom feed URL from a podcast/article page. Strategy:
//   1. If the URL itself returns XML → it's already a feed
//   2. Scan the HTML <head> for <link rel="alternate" type="application/rss+xml">
//   3. Scan for <meta property="og:audio" ...> or known podcast hints
//   4. Try common conventional paths under the site root: /feed, /rss, /feed.xml…
// Returns the first candidate that probes as a real feed.
ipcMain.handle('rss:discover', async (_, pageUrl) => {
  if (!pageUrl) return { ok: false, error: 'No URL provided' };
  try {
    // ── YouTube channel/playlist short-circuit ──────────────────────────────
    // YT exposes public Atom feeds for any channel/playlist at
    //   feeds/videos.xml?channel_id=UC...
    //   feeds/videos.xml?playlist_id=PL...
    // We resolve common URL shapes (UC.../channel/UC..., @handle, /user/X,
    // /playlist?list=PL..., short youtu.be/@X) before falling through to the
    // generic HTML autodiscovery below.
    const yt = await tryResolveYouTubeFeed(pageUrl);
    if (yt) return yt;

    const html = await fetchTextSimple(pageUrl);
    const head = html.slice(0, 1024).trim();
    if (/^(<\?xml\b|<rss\b|<feed\b)/i.test(head)) {
      return { ok: true, feedUrl: pageUrl, source: 'direct' };
    }
    const base = new URL(pageUrl);

    // 2) <link rel="alternate" type="application/(rss|atom)+xml">
    const candidates = new Set();
    const reA = /<link[^>]*type=["']?application\/(?:rss|atom)\+xml["']?[^>]*href=["']?([^"'\s>]+)["']?[^>]*>/gi;
    const reB = /<link[^>]*href=["']?([^"'\s>]+)["']?[^>]*type=["']?application\/(?:rss|atom)\+xml["']?[^>]*>/gi;
    let m;
    while ((m = reA.exec(html))) try { candidates.add(new URL(m[1], base).href); } catch {}
    while ((m = reB.exec(html))) try { candidates.add(new URL(m[1], base).href); } catch {}

    // 3) Scan for inline references to .xml/.rss/feed in href/src attributes
    //    (some sites declare the feed only inside the body, not the head).
    const reInline = /href=["']([^"'\s>]+(?:\/feed\/?|\.rss|\.xml|\/rss\/?)(?:\?[^"'\s>]*)?)["']/gi;
    while ((m = reInline.exec(html))) try { candidates.add(new URL(m[1], base).href); } catch {}

    // 4) Common conventional paths at the site root.
    const root = `${base.protocol}//${base.host}`;
    for (const p of ['/feed', '/feed/', '/rss', '/rss.xml', '/feed.xml', '/feed.rss', '/atom.xml']) {
      candidates.add(root + p);
    }

    // Probe candidates in order; return the first that actually serves a feed.
    for (const cand of candidates) {
      if (await probeIsFeed(cand)) {
        return { ok: true, feedUrl: cand, allFeeds: [...candidates], source: 'probed' };
      }
    }
    return {
      ok: false,
      error: 'No RSS/Atom feed could be resolved from this URL. The page may not expose one — paste the direct .xml/.rss feed URL instead.',
      tried: [...candidates]
    };
  } catch (e) {
    log('ERROR', `rss:discover ${pageUrl}: ${e.message}`);
    return { ok: false, error: describeNetError(e) };
  }
});

// Resolve any YouTube URL (channel, @handle, playlist, /user/, /c/, short
// youtu.be) to its public feeds.videos.xml Atom feed. Returns null when the
// URL is not a YouTube address, letting the caller continue with the
// generic HTML autodiscovery path.
async function tryResolveYouTubeFeed(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtu.be') return null;
  const FEED_BASE = 'https://www.youtube.com/feeds/videos.xml';

  // Direct id captures — no fetch needed for /channel/UC... or /playlist?list=PL...
  const channelMatch = u.pathname.match(/^\/channel\/(UC[\w-]{20,})/i);
  if (channelMatch) {
    return { ok: true, feedUrl: `${FEED_BASE}?channel_id=${channelMatch[1]}`, source: 'youtube-channel' };
  }
  if (u.pathname === '/playlist' && u.searchParams.get('list')) {
    return { ok: true, feedUrl: `${FEED_BASE}?playlist_id=${u.searchParams.get('list')}`, source: 'youtube-playlist' };
  }
  // Single-video URL with a list= query param → subscribe to that playlist
  // (more useful than not subscribing at all).
  if (u.pathname === '/watch' && u.searchParams.get('list')) {
    return { ok: true, feedUrl: `${FEED_BASE}?playlist_id=${u.searchParams.get('list')}`, source: 'youtube-playlist' };
  }

  // Handle-style URLs: /@handle, /user/X, /c/X, youtu.be/@handle. These need
  // a page fetch — YT embeds the canonical channel ID as <meta itemprop=
  // "identifier"> or in the channelId microdata. We grep both because YT
  // shuffles its HTML structure regularly.
  const handlePath = /^\/(@[\w.-]+|user\/[\w.-]+|c\/[\w.-]+)$/i.test(u.pathname) ||
                     (host === 'youtu.be' && /^\/@[\w.-]+$/i.test(u.pathname));
  if (handlePath) {
    try {
      const html = await fetchTextSimple(u.href);
      const id = html.match(/"channelId"\s*:\s*"(UC[\w-]{20,})"/)?.[1] ||
                 html.match(/<meta\s+itemprop=["']identifier["']\s+content=["'](UC[\w-]{20,})["']/)?.[1] ||
                 html.match(/channel\/(UC[\w-]{20,})/)?.[1];
      if (id) {
        return { ok: true, feedUrl: `${FEED_BASE}?channel_id=${id}`, source: 'youtube-handle' };
      }
    } catch (e) {
      log('WARN', `youtube handle resolve failed for ${rawUrl}: ${e.message}`);
    }
  }
  // Catch-all: any youtube.com URL we couldn't parse — let the generic path
  // try, but don't return false success.
  return null;
}

function parseFeed(xml) {
  // Detect feed type — RSS 2.0 vs Atom
  const isAtom = /<feed[\s>][^>]*xmlns=["']?http:\/\/www\.w3\.org\/2005\/Atom/i.test(xml) || /<entry[\s>]/.test(xml);
  if (isAtom) return parseAtom(xml);
  return parseRSS(xml);
}

// Robust tag extraction with CDATA + nested support
function tag(block, name, attrFilter = null) {
  // Find <name ...>content</name> or <name ... /> (self-closing)
  const re = new RegExp(`<${name}(?:\\s+[^>]*?)?(?:\\s*/>|>([\\s\\S]*?)<\\/${name}\\s*>)`, 'i');
  const m = block.match(re);
  if (!m) return '';
  const content = (m[1] || '').trim();
  // Unwrap CDATA if present
  const cdata = content.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return cdata ? cdata[1].trim() : content;
}

function attr(block, tagName, attrName) {
  const re = new RegExp(`<${tagName}[^>]*?\\s${attrName}=["']([^"']+)["'][^>]*>`, 'i');
  const m = block.match(re);
  return m ? m[1] : null;
}

function stripHtml(s) { return String(s || '').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').trim(); }
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&apos;/g,"'");
}

function parseRSS(xml) {
  const channelMatch = xml.match(/<channel[\s>]([\s\S]*?)<\/channel>/i);
  const channel = channelMatch ? channelMatch[1] : xml;

  const meta = {
    title:       decodeEntities(stripHtml(tag(channel, 'title'))),
    description: decodeEntities(stripHtml(tag(channel, 'description'))),
    link:        tag(channel, 'link'),
  };

  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  for (const block of blocks.slice(0, 100)) {
    const title = decodeEntities(stripHtml(tag(block, 'title')));
    if (!title) continue;

    // pubDate or dc:date
    const pubDate = tag(block, 'pubDate') || tag(block, 'dc:date') || tag(block, 'date');

    // Enclosure (most reliable for podcasts/media)
    const enclosureUrl  = attr(block, 'enclosure', 'url');
    const enclosureType = attr(block, 'enclosure', 'type');
    const enclosureLen  = attr(block, 'enclosure', 'length');

    // Magnet link can be in many fields
    const magnetMatch = block.match(/magnet:\?xt=urn:btih:[^<"\s'&]+/i);
    const magnet = magnetMatch ? decodeEntities(magnetMatch[0]) : null;

    // Description / content:encoded / iTunes:summary
    const descRaw = tag(block, 'content:encoded') || tag(block, 'description') || tag(block, 'itunes:summary') || tag(block, 'summary');
    const description = decodeEntities(stripHtml(descRaw)).substring(0, 400);

    const link    = tag(block, 'link');
    const author  = decodeEntities(stripHtml(tag(block, 'dc:creator') || tag(block, 'author') || tag(block, 'itunes:author')));
    const guid    = tag(block, 'guid');
    const duration= tag(block, 'itunes:duration');
    const image   = attr(block, 'itunes:image', 'href') || attr(block, 'media:thumbnail', 'url') || attr(block, 'media:content', 'url');

    items.push({
      title, description, pubDate, link, author, guid, duration, image,
      enclosureUrl, enclosureType, enclosureLen, magnet
    });
  }
  return { meta, items };
}

function parseAtom(xml) {
  const meta = {
    title:       decodeEntities(stripHtml(tag(xml, 'title'))),
    description: decodeEntities(stripHtml(tag(xml, 'subtitle') || tag(xml, 'summary'))),
    link:        attr(xml, 'link', 'href'),
  };

  const items = [];
  const blocks = xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];
  for (const block of blocks.slice(0, 100)) {
    const title = decodeEntities(stripHtml(tag(block, 'title')));
    if (!title) continue;

    // Atom uses <link href="..." rel="..."> — prefer enclosure rel
    const linkBlocks = [...block.matchAll(/<link\s+([^/>]+)\s*\/?>/g)];
    let link = null, enclosureUrl = null, enclosureType = null;
    for (const lb of linkBlocks) {
      const attrs = lb[1];
      const href  = (attrs.match(/href=["']([^"']+)["']/) || [])[1];
      const rel   = (attrs.match(/rel=["']([^"']+)["']/)  || [])[1];
      const type  = (attrs.match(/type=["']([^"']+)["']/) || [])[1];
      if (rel === 'enclosure') { enclosureUrl = href; enclosureType = type || null; }
      else if (!link)          link = href;
    }

    const magnetMatch = block.match(/magnet:\?xt=urn:btih:[^<"\s'&]+/i);
    const magnet      = magnetMatch ? decodeEntities(magnetMatch[0]) : null;

    const descRaw     = tag(block, 'content') || tag(block, 'summary');
    const description = decodeEntities(stripHtml(descRaw)).substring(0, 400);

    const pubDate = tag(block, 'updated') || tag(block, 'published');
    const author  = decodeEntities(stripHtml(tag(block, 'name')));
    const guid    = tag(block, 'id');

    items.push({
      title, description, pubDate, link, author, guid,
      enclosureUrl, enclosureType, enclosureLen: null, magnet,
      duration: null, image: null
    });
  }
  return { meta, items };
}

// ─── FETCH HELPERS ───────────────────────────────────────────────────────────
async function fetchJSON(url, timeout = 15000) {
  // Routes through httpGetStream (Electron net → system CA / proxy) like
  // fetchJSONWithUA, so torrent-site search works behind TLS-intercepting proxies.
  const res = await httpGetStream(url, { ua: 'Mozilla/5.0 (FLUX) AppleWebKit/537.36', timeout });
  return new Promise((resolve, reject) => {
    if (res.statusCode !== 200) { try { res.resume && res.resume(); } catch {} return reject(new Error(`HTTP ${res.statusCode}`)); }
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try { resolve(JSON.parse(d)); }
      catch { reject(new Error(`Invalid JSON from ${url}: ${d.substring(0,80)}`)); }
    });
    res.on('error', reject);
  });
}

// fetchTextSimple — used by RSS / Nyaa torrent helpers. NB: a SECOND function
// named fetchText exists above for the Spotify resolver with a different
// ─── CAPTURE / RECORD ───────────────────────────────────────────────────────
// Screen + window enumeration for screenshot / screen-record. desktopCapturer
// is main-process only in Electron 17+, so the renderer asks us for the list,
// picks one, and then calls getUserMedia with chromeMediaSourceId on its side.
ipcMain.handle('capture:listSources', async (_, { types = ['screen', 'window'], thumbSize } = {}) => {
  try {
    const sources = await desktopCapturer.getSources({
      types,
      thumbnailSize: thumbSize || { width: 320, height: 200 }
    });
    return {
      ok: true,
      sources: sources.map(s => ({
        id:        s.id,
        name:      s.name,
        type:      s.id.startsWith('window:') ? 'window' : 'screen',
        thumbnail: s.thumbnail?.toDataURL?.() || null
      }))
    };
  } catch (e) {
    log('ERROR', `capture:listSources: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

// Save a screenshot (data URL from a <canvas>.toDataURL) to the download folder.
// Returns the absolute path so the renderer can auto-load it into the editor.
ipcMain.handle('capture:saveImage', async (_, { dataUrl, format }) => {
  try {
    const cfg = loadConfig();
    const folder = cfg.download_folder;
    fs.mkdirSync(folder, { recursive: true });
    const ext = format === 'jpg' ? '.jpg' : '.png';
    const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const filePath = path.join(folder, `screenshot-${ts}${ext}`);
    const m = /^data:image\/[a-z]+;base64,(.+)$/.exec(dataUrl || '');
    if (!m) return { ok: false, error: 'Invalid data URL' };
    fs.writeFileSync(filePath, Buffer.from(m[1], 'base64'));
    log('INFO', `capture:saveImage -> ${filePath}`);
    return { ok: true, path: filePath };
  } catch (e) {
    log('ERROR', `capture:saveImage: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

// Save a MediaRecorder-produced ArrayBuffer (WebM container, Opus audio, VP8/9
// video) and optionally remux/transcode to a friendlier format via ffmpeg.
// kind='audio' → audio-only output; kind='video' → video+audio.
ipcMain.handle('capture:saveRecording', async (_, { buffer, kind, convert } = {}) => {
  try {
    if (!buffer || !buffer.byteLength) return { ok: false, error: 'Empty recording buffer' };
    const cfg = loadConfig();
    const folder = cfg.download_folder;
    fs.mkdirSync(folder, { recursive: true });
    const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const isAudio  = kind === 'audio';
    const baseName = (isAudio ? 'recording-audio' : 'recording-screen') + '-' + ts;
    const rawPath  = path.join(folder, baseName + '.webm');
    fs.writeFileSync(rawPath, Buffer.from(buffer));
    log('INFO', `capture:saveRecording -> ${rawPath} (${buffer.byteLength} bytes, kind=${kind}, convert=${convert || 'none'})`);

    // Optional ffmpeg transcode to a more universally compatible format. The
    // raw WebM works in most players but Windows Media Player and many simple
    // viewers can't open it — MP3/MP4 makes the file usable everywhere.
    //
    // Even when keeping WebM, we MUST run it through ffmpeg with `-c copy`
    // to re-mux the container: MediaRecorder writes "live" WebM with a
    // duration field of Infinity (no final cluster written). WaveSurfer and
    // many other players hang on the decode step waiting for a duration
    // they'll never get. The remux rewrites the metadata properly without
    // re-encoding — fast, lossless.
    const ffmpegPath = getFfmpegPath();
    if (!ffmpegPath) return { ok: true, path: rawPath };
    const sameExt = (!convert || convert === 'webm');
    // When the output extension matches the input (webm → webm remux),
    // we can't write to outPath directly because ffmpeg would be reading
    // and writing the same file. Stage to a sibling .tmp.webm then rename.
    const outPath = path.join(folder, baseName + '.' + (convert || 'webm'));
    const ffOut   = sameExt ? path.join(folder, baseName + '.remux.webm') : outPath;
    let args;
    if (!convert || convert === 'webm') {
      // Remux only — fix the duration metadata, no codec change.
      args = ['-i', rawPath, '-y', '-c', 'copy', ffOut];
    } else if (isAudio) {
      // MP3: libmp3lame + ID3v2.3 for Windows Media Player compatibility.
      // M4A: AAC in MP4 container.
      if (convert === 'mp3') {
        args = ['-i', rawPath, '-y', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-id3v2_version', '3', '-write_xing', '1', outPath];
      } else if (convert === 'm4a') {
        args = ['-i', rawPath, '-y', '-vn', '-c:a', 'aac', '-b:a', '192k', outPath];
      } else {
        args = ['-i', rawPath, '-y', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', outPath];
      }
    } else {
      // MP4: H.264 video + AAC audio, fast preset for reasonable encode time.
      args = ['-i', rawPath, '-y', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outPath];
    }
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, args);
      let err = '';
      proc.stderr.on('data', d => { err += d.toString(); });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(err.slice(-500) || `ffmpeg exit ${code}`)));
      proc.on('error', reject);
    });
    // For the same-ext remux path: replace the raw with the remuxed copy
    // (different ext during ffmpeg, same final name). For cross-format
    // transcodes the raw is just deleted.
    if (sameExt) {
      try { fs.unlinkSync(rawPath); } catch {}
      fs.renameSync(ffOut, outPath);
    } else if (rawPath !== outPath) {
      try { fs.unlinkSync(rawPath); } catch {}
    }
    return { ok: true, path: outPath };
  } catch (e) {
    log('ERROR', `capture:saveRecording: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

// ─── DOC CONVERSION (HTML/URL → PNG / PDF, IMG → PDF) ───────────────────────
// "Light slice" of document conversion: anything Chromium-headless can do
// natively. URL capture uses an offscreen BrowserWindow + capturePage() /
// printToPDF(). IMG → PDF builds a temp HTML with one <img> per page and
// reuses printToPDF(). No external binaries required.

// Helper: open a hidden offscreen window, run a fn against its webContents,
// return the fn's value. The window is destroyed afterwards either way.
async function withOffscreenWindow(url, opts, fn) {
  const win = new BrowserWindow({
    width:  opts?.width  || 1280,
    height: opts?.height || 800,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      offscreen: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      images: true,
      javascript: true
    }
  });
  try {
    await new Promise((resolve, reject) => {
      const done = () => { win.webContents.off('did-fail-load', failed); resolve(); };
      const failed = (_e, code, desc) => { win.webContents.off('did-finish-load', done); reject(new Error(`Load failed (${code}): ${desc}`)); };
      win.webContents.once('did-finish-load', done);
      win.webContents.once('did-fail-load', failed);
      win.loadURL(url);
    });
    // Settle delay — many pages finish DOMContentLoaded but paint web fonts
    // and lazy-loaded images a beat later. 600ms is enough for most.
    await new Promise(r => setTimeout(r, opts?.settleMs ?? 600));
    return await fn(win);
  } finally {
    try { win.destroy(); } catch {}
  }
}

ipcMain.handle('convert:fromUrl', async (_, { url, format = 'png', viewport, settleMs } = {}) => {
  try {
    if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: 'Provide a full http(s):// URL' };
    const cfg = loadConfig();
    const folder = cfg.download_folder;
    fs.mkdirSync(folder, { recursive: true });
    // Include milliseconds — two saves within the same wall-clock second
    // would otherwise produce identical paths, overwriting silently and
    // confusing downstream caches (video element, WaveSurfer peaks).
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    // Derive a friendly stub from the hostname so the output is more
    // identifiable than the timestamp alone.
    let hostStub = 'url';
    try { hostStub = new URL(url).hostname.replace(/^www\./i, '').replace(/[^a-z0-9.-]/gi, '_'); } catch {}

    const result = await withOffscreenWindow(url, {
      width:  viewport?.width  || 1280,
      height: viewport?.height || 800,
      settleMs
    }, async (win) => {
      if (format === 'pdf') {
        const buf = await win.webContents.printToPDF({
          marginsType: 1, printBackground: true,
          pageSize: viewport?.paper || 'A4', landscape: !!viewport?.landscape
        });
        const out = path.join(folder, `web-${hostStub}-${ts}.pdf`);
        fs.writeFileSync(out, buf);
        return out;
      }
      // PNG / JPG via capturePage(). Capture the full document height by
      // resizing the BrowserWindow content to the document size first.
      const fullHeight = await win.webContents.executeJavaScript(
        'Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)'
      ).catch(() => null);
      if (fullHeight && fullHeight > (viewport?.height || 800)) {
        win.setContentSize(viewport?.width || 1280, Math.min(fullHeight, 8000));
        await new Promise(r => setTimeout(r, 250));
      }
      const img = await win.webContents.capturePage();
      const ext = format === 'jpg' ? '.jpg' : '.png';
      const buf = format === 'jpg' ? img.toJPEG(92) : img.toPNG();
      const out = path.join(folder, `web-${hostStub}-${ts}${ext}`);
      fs.writeFileSync(out, buf);
      return out;
    });
    log('INFO', `convert:fromUrl ok → ${result}`);
    return { ok: true, path: result };
  } catch (e) {
    log('ERROR', `convert:fromUrl: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

// Save an annotated raster image — the fabric.js canvas flattened to a
// data URL by the renderer. Output sits next to the original with a
// `-annotated-<ts>.png` suffix so the user can still find the source.
ipcMain.handle('convert:saveAnnotated', async (_, { dataUrl, baseName } = {}) => {
  try {
    const cfg = loadConfig();
    const folder = cfg.download_folder;
    fs.mkdirSync(folder, { recursive: true });
    const safe = (baseName || 'image').replace(/[^a-z0-9.-]/gi, '_');
    // Include milliseconds — two saves within the same wall-clock second
    // would otherwise produce identical paths, overwriting silently and
    // confusing downstream caches (video element, WaveSurfer peaks).
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const filePath = path.join(folder, `${safe}-annotated-${ts}.png`);
    const m = /^data:image\/[a-z]+;base64,(.+)$/.exec(dataUrl || '');
    if (!m) return { ok: false, error: 'Invalid data URL' };
    fs.writeFileSync(filePath, Buffer.from(m[1], 'base64'));
    log('INFO', `convert:saveAnnotated -> ${filePath}`);
    return { ok: true, path: filePath };
  } catch (e) {
    log('ERROR', `convert:saveAnnotated: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

// Save rasterised PDF pages (from pdf.js in the renderer) into a stable
// subfolder of the download folder. Renderer sends one base64 PNG per page;
// we drop them into `pdf-pages/<source-stub>-pNNN.png` so they survive across
// runs and the user can open the folder to find them.
ipcMain.handle('convert:savePdfPage', async (_, { dataUrl, baseName, pageNum } = {}) => {
  try {
    const cfg = loadConfig();
    const folder = path.join(cfg.download_folder, 'pdf-pages');
    fs.mkdirSync(folder, { recursive: true });
    const safe = (baseName || 'pdf').replace(/[^a-z0-9.-]/gi, '_');
    const pageStr = String(pageNum || 1).padStart(3, '0');
    const filePath = path.join(folder, `${safe}-p${pageStr}.png`);
    const m = /^data:image\/[a-z]+;base64,(.+)$/.exec(dataUrl || '');
    if (!m) return { ok: false, error: 'Invalid data URL' };
    fs.writeFileSync(filePath, Buffer.from(m[1], 'base64'));
    return { ok: true, path: filePath };
  } catch (e) {
    log('ERROR', `convert:savePdfPage: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

// Build a single PDF from N image files, one per page. Each page is sized
// to the image's natural ratio so nothing is stretched or letterboxed.
ipcMain.handle('convert:imagesToPdf', async (_, { files } = {}) => {
  try {
    if (!Array.isArray(files) || !files.length) return { ok: false, error: 'No images provided' };
    const cfg = loadConfig();
    const folder = cfg.download_folder;
    fs.mkdirSync(folder, { recursive: true });
    // Include milliseconds — two saves within the same wall-clock second
    // would otherwise produce identical paths, overwriting silently and
    // confusing downstream caches (video element, WaveSurfer peaks).
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const outPath = path.join(folder, `images-${files.length}-${ts}.pdf`);

    // Build an HTML doc with one image per page. Encode each image inline
    // as base64 so the offscreen window doesn't need filesystem access.
    const pages = files.map((f, i) => {
      let mime = 'image/jpeg';
      const ext = path.extname(f).toLowerCase();
      if (ext === '.png') mime = 'image/png';
      else if (ext === '.gif') mime = 'image/gif';
      else if (ext === '.webp') mime = 'image/webp';
      else if (ext === '.bmp') mime = 'image/bmp';
      let dataUrl = '';
      try { dataUrl = `data:${mime};base64,` + fs.readFileSync(f).toString('base64'); }
      catch (e) { log('WARN', `convert:imagesToPdf skipping ${f}: ${e.message}`); return ''; }
      return `<div class="pg"${i ? '' : ' style="page-break-before:auto"'}><img src="${dataUrl}"/></div>`;
    }).filter(Boolean).join('\n');

    const html = `<!doctype html><html><head><meta charset="utf-8">
      <style>
        @page { margin: 12mm; }
        html, body { margin: 0; padding: 0; background: #fff; }
        .pg { page-break-after: always; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        .pg:last-child { page-break-after: auto; }
        img { max-width: 100%; max-height: 100vh; object-fit: contain; display: block; }
      </style></head><body>${pages}</body></html>`;
    const tmp = path.join(USER_DATA, `.images-pdf-${Date.now()}.html`);
    fs.writeFileSync(tmp, html, 'utf8');

    await withOffscreenWindow('file:///' + tmp.replace(/\\/g, '/'), { settleMs: 400, width: 1024, height: 1024 }, async (win) => {
      const buf = await win.webContents.printToPDF({ marginsType: 1, printBackground: false, pageSize: 'A4' });
      fs.writeFileSync(outPath, buf);
    });
    try { fs.unlinkSync(tmp); } catch {}
    log('INFO', `convert:imagesToPdf ok → ${outPath} (${files.length} images)`);
    return { ok: true, path: outPath, count: files.length };
  } catch (e) {
    log('ERROR', `convert:imagesToPdf: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

// signature (url, ua, timeout). JS function hoisting was making the later
// declaration shadow the earlier one, which broke Spotify with
// "timeout argument must be of type number, received string".
async function fetchTextSimple(url, timeout = 15000, _redirects = 0) {
  if (_redirects > 5) throw new Error('Too many redirects');
  const mod = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { timeout, headers: { 'User-Agent': 'Mozilla/5.0 (FLUX)' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        req.destroy();
        return fetchTextSimple(res.headers.location, timeout, _redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        req.destroy();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function downloadFile(url, dest, timeout = 30000, _redirects = 0) {
  if (_redirects > 5) throw new Error('Too many redirects');
  const mod = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { timeout, headers: { 'User-Agent': 'Mozilla/5.0 (FLUX)' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        req.destroy();
        return downloadFile(res.headers.location, dest, timeout, _redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        req.destroy();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', err => { fs.unlink(dest, () => {}); reject(err); });
    });
    req.on('error', e => { fs.unlink(dest,()=>{}); reject(e); });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}
