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

const { app, BrowserWindow, ipcMain, globalShortcut, nativeTheme, desktopCapturer } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { spawn, exec } = require('child_process');
const net = require('net');
const tls = require('tls');
const binaryFetcher = require('./binary-fetcher');
const bus = require('./engine/bus');
const { safeSend } = require('./engine/bus');
const enginePaths = require('./engine/paths');
const host = require('./engine/host');
const { createDesktopHost } = require('./engine/host-desktop');
// HTTP helpers (Phase C, 2026-08-19) — extracted to engine/net.js since
// engine/torrent.js and engine/rss.js need them too and must stay Electron-free.
const {
  httpGetStream, fetchJSONWithUA, httpGetText, httpPostJSON,
  readResponseText, httpGetTextStatus, describeNetError,
  fetchJSON, fetchTextSimple, downloadFile,
} = require('./engine/net');
// Config/history/schedule/log (Phase C, 2026-08-23) — all four resolve their
// file paths from engine/paths.js lazily (per-call, not at require time), so
// requiring them here alongside the other engine/ modules is safe regardless
// of load order relative to enginePaths.configurePaths() below.
const { log } = require('./engine/log');
const { loadConfig, saveConfig } = require('./engine/config');
const { loadHistory, appendHistory, computeHistoryStats, clearHistory } = require('./engine/history');
const { loadSchedule, saveSchedule } = require('./engine/schedule');
const {
  getYtDlpPath, getFfmpegPath, getFfmpegDir, getFpcalcPath,
  getYtDlpProxyArg, getYtDlpCaEnv, spawnYtDlp,
} = require('./engine/binaries');
const { probeIsFeed, tryResolveYouTubeFeed, parseFeed, discoverFeed } = require('./engine/rss');
const { sendNzbFromFile, sendToTorrentClient } = require('./engine/sendto');
const {
  runTorrentSearch, fetchJackettApiKey, readJackettApiKey, saveTorrentItem,
  detectJackettOrProwlarr, listTorznabIndexers,
} = require('./engine/torrent');
const {
  loadQueue, saveQueue, newQueueId,
  activeMediaProcs, isStopRequested, setStopRequested, killProcessTree,
  runMediaDownload, runMediaDownloadRetry, runQueue,
  isDrmHost, getStreamUrl, probeMedia,
  RELATED_MAX_ITEMS, relatedFromSearch,
} = require('./engine/queue');
const { startScheduler, stopScheduler } = require('./engine/scheduler');
const { handleRemoteCommand } = require('./engine/remote');
const {
  generatePairingCode, stopTelegramPolling, syncTelegramPolling,
  getStatus: getTelegramStatus,
} = require('./engine/telegram');
// socks5Connect only (irc:* IPC channels are wired generically via
// wireIpc() below) — needed here for applyGlobalProxy's Electron-specific
// session.setProxy plumbing, the one piece of the SOCKS5 domain that
// couldn't move to engine/irc.js.
const { socks5Connect } = require('./engine/irc');

// Force the runtime app name to the slug "flux-hub" BEFORE any
// app.getPath('userData') call below. Electron derives userData from
// app.getName(); pinning it to the slug keeps config + the lazy-fetched
// vendor\ under %APPDATA%\flux-hub (display brand is "FLUX Hub" via
// build.productName; the build's clean-data wipe targets the same slug path).
app.setName('flux-hub');

// ─── PATHS ───────────────────────────────────────────────────────────────────
// The two real inputs (userData dir, downloads dir) are configured once
// through engine/paths.js instead of being read straight off app.getPath()
// here — a future headless server.js supplies its own via env vars instead.
// Every constant below is still derived and used exactly as before; only
// where the two source values come from is now swappable.
enginePaths.configurePaths({
  userData:       app.getPath('userData'),
  downloadFolder: path.join(app.getPath('downloads'), 'FLUX Hub'),
  // Runtime-writable vendor dir for the lazy binary fetcher (Phase 2b). In a
  // packaged build, process.resourcesPath/vendor is READ-ONLY (Program Files
  // on Windows, inside the signed .app bundle on macOS), so any binary
  // downloaded on first module use must land in a writable location →
  // userData/vendor. In dev the project-root vendor/ is writable and is what
  // scripts/fetch-*.js (and the same runtime fetcher) populate. Every
  // getXPath() resolver below checks this dir, so a fetched binary is picked
  // up with no rebuild.
  vendorDir: app.isPackaged ? path.join(app.getPath('userData'), 'vendor') : path.join(__dirname, 'vendor'),
  isPackaged:   app.isPackaged,
  resourcesDir: process.resourcesPath || null,
});
const { userData: USER_DATA, vendorDir: VENDOR_DIR } = enginePaths.getPaths();

// Desktop host wiring — native dialogs/notify/clipboard/shell. The getter
// closure is safe even though `mainWindow` is declared further down: it's
// only invoked later (on first dialog/notify call), by which point the
// window exists. See engine/host-desktop.js.
host.setHost(createDesktopHost(() => mainWindow));

// Declarative registry (Fase G, Step 1) — every engine/*.js module listed in
// engine/engine-modules.js that exports a `routes[]` gets its ipcMain.handle
// registered here, once, instead of a hand-written one-liner per channel
// scattered through this file. server.js reads the SAME list (via
// wireRest()) to register the REST equivalent — see engine/wire-ipc.js's
// header comment for what does and doesn't qualify for this path.
const { wireIpc } = require('./engine/wire-ipc');
const ENGINE_MODULES = require('./engine/engine-modules');
wireIpc(ipcMain, ENGINE_MODULES);

// xtract:probeDuration / xtract:hasAudio are NOT in engine/xtract.js's
// routes[] — both are invoked from the renderer with a raw string path as
// the IPC payload, not an object, so the generic args(body, sender) mapping
// (which always treats `body` as an object) can't carry them. Hand-wired
// here instead, same reasoning as engine/torrent.js's runTorrentSearch.
const xtractModule = require('./engine/xtract');
ipcMain.handle('xtract:probeDuration', (_, input) => xtractModule.probeDuration(input));
ipcMain.handle('xtract:hasAudio', (_, input) => xtractModule.hasAudio(input));

// Create userData dir on first launch BEFORE any log() call. On Windows portable,
// the wrapper extracts to a fresh temp dir each run but userData lives at AppData,
// which doesn't exist on a brand-new install — without this mkdir log() silently
// fails on first boot (the "missing first-boot log" issue).
try { fs.mkdirSync(USER_DATA, { recursive: true }); } catch {}
try { fs.mkdirSync(VENDOR_DIR, { recursive: true }); } catch {}

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Moved to engine/config.js (Phase C, 2026-08-23) — required at the top of
// this file alongside bus/paths/host/net.

// ─── PROFILES ────────────────────────────────────────────────────────────────
// Moved to engine/profiles.js (Fase G, Step 1) — wired below via wireIpc(),
// alongside the other declarative-registry modules.

// ─── QUEUE ───────────────────────────────────────────────────────────────────
// Moved to engine/queue.js (Phase C, 2026-08-23) — imported at the top of
// this file alongside bus/paths/host/net.

// ─── HISTORY ─────────────────────────────────────────────────────────────────
// Moved to engine/history.js (Phase C, 2026-08-23).

// ─── SCHEDULE ────────────────────────────────────────────────────────────────
// Moved to engine/schedule.js (Phase C, 2026-08-23).

// ─── LOG ─────────────────────────────────────────────────────────────────────
// Moved to engine/log.js (Phase C, 2026-08-23).

// ─── YT-DLP / FFMPEG PATHS ───────────────────────────────────────────────────
// Moved to engine/binaries.js (Phase C, 2026-08-23).

// ─── SAFE SEND ───────────────────────────────────────────────────────────────
// Moved to engine/bus.js (Phase C, 2026-08-23) — imported at the top of this
// file alongside bus.setSink/getSink.

// ─── WINDOW ──────────────────────────────────────────────────────────────────
let mainWindow;
let splashWindow;
const bootStart = Date.now();
// activeMediaProcs/isStopRequested/setStopRequested/killProcessTree moved to
// engine/queue.js (Phase C, 2026-08-23) — imported at the top of this file.
// Still used here by the media:stop handler (runLiveRecord itself moved to
// engine/live.js in Fase G, Step 2 — it now imports these directly from
// engine/queue.js, same shared process-tracking state).

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
      if (mainWindow && !mainWindow.isDestroyed()) safeSend(bus.getSink(), 'config:splashAudioPref', enable);
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
  bus.setSink(mainWindow.webContents);

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
  ipcMain.handleOnce('app:ready', () => {
    revealMainWindow();
    // The renderer can route files now — flush anything that arrived during
    // boot (cold "Open with" launch args, early macOS open-file events).
    rendererReadyForFiles = true;
    if (pendingOpenFiles.length && mainWindow && !mainWindow.isDestroyed()) {
      log('INFO', `open-with: flushing ${pendingOpenFiles.length} boot file(s) → renderer`);
      safeSend(bus.getSink(), 'app:openFiles', pendingOpenFiles.splice(0));
    }
    return true;
  });
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

app.on('before-quit',   () => { stopTelegramPolling(); stopLanServer(); log('INFO', 'app:before-quit'); });
app.on('will-quit',     () => log('INFO', 'app:will-quit'));
app.on('quit',          (_, code) => log('INFO', `app:quit code=${code}`));
// ─── OS "OPEN WITH" INTEGRATION ──────────────────────────────────────────────
// The installer registers file associations (package.json → build.
// fileAssociations); files then arrive as launch argv (Win/Linux), via the
// second-instance argv when FLUX is already running, or through the macOS
// open-file event. Routing reuses the renderer's drag&drop logic
// ('app:openFiles' → handleDroppedFiles), so files land in the right tab.
const OPEN_WITH_RE = /\.(mp3|flac|m4a|aac|ogg|oga|opus|wav|mp4|mkv|webm|mov|avi|m4v|flv|wmv|gif|jpg|jpeg|png|webp|avif|tiff?|bmp|heic|heif|svg|pdf)$/i;
let pendingOpenFiles = [];
let rendererReadyForFiles = false;

function collectOpenFileArgs(argv) {
  // Skip the executable, electron switches, and the dev app-path arg ('.').
  return (argv || []).slice(1)
    .filter(a => a && !a.startsWith('-') && a !== '.' && OPEN_WITH_RE.test(a))
    .filter(a => { try { return fs.existsSync(a); } catch { return false; } });
}

function dispatchOpenFiles(paths) {
  if (!paths || !paths.length) return;
  log('INFO', `open-with: ${paths.length} file(s) → ${rendererReadyForFiles ? 'renderer' : 'queued for boot'}`);
  if (rendererReadyForFiles && mainWindow && !mainWindow.isDestroyed()) {
    safeSend(bus.getSink(), 'app:openFiles', paths);
  } else {
    // Renderer not up yet (cold "Open with" launch) — flushed on app:ready.
    pendingOpenFiles.push(...paths);
  }
}

// Single instance: a second launch (e.g. Explorer "Open with" while FLUX is
// already running) forwards its file args here and focuses the window.
if (!app.requestSingleInstanceLock()) {
  log('INFO', 'app: another instance holds the lock — forwarding argv and quitting');
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    log('INFO', 'app:second-instance (another launch attempted)');
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    dispatchOpenFiles(collectOpenFileArgs(argv));
  });
}
// macOS: Finder delivers files via open-file (may fire before app is ready).
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (OPEN_WITH_RE.test(String(p || ''))) dispatchOpenFiles([p]);
});

app.whenReady().then(() => {
  log('INFO', 'app:whenReady');
  // Cold "Open with" launch: media paths ride in on process.argv (queued
  // here, delivered to the renderer on app:ready).
  pendingOpenFiles.push(...collectOpenFileArgs(process.argv));
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
  syncRemoteServicesWithConfig(loadConfig());
  // Forward system theme changes (Windows/Mac) to renderer for 'auto' mode live update.
  nativeTheme.on('updated', () => {
    log('INFO', `nativeTheme:updated shouldUseDarkColors=${nativeTheme.shouldUseDarkColors}`);
    safeSend(bus.getSink(), 'theme:systemChanged', { dark: nativeTheme.shouldUseDarkColors });
  });
  app.on('activate', () => {
    log('INFO', 'app:activate');
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  stopScheduler();
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
    autoUpdater.on('update-available',   info => safeSend(bus.getSink(), 'updater:available',   info));
    autoUpdater.on('update-downloaded',  info => safeSend(bus.getSink(), 'updater:downloaded',  info));
    autoUpdater.on('error',              err  => log('ERROR', `updater: ${err.message}`));
    autoUpdater.checkForUpdates().catch(e => log('WARN', `updater check failed: ${e.message}`));

    ipcMain.handle('updater:download', () => autoUpdater.downloadUpdate());
    ipcMain.handle('updater:install',  () => autoUpdater.quitAndInstall());
  } catch (e) { log('ERROR', `initAutoUpdater: ${e.message}`); }
}

// ─── SCHEDULER (background loop) ─────────────────────────────────────────────
// Moved to engine/scheduler.js (Phase C, 2026-08-23) — imported at the top of
// this file alongside bus/paths/host/net.

// ─── IPC: TAG EDITOR + METADATA ENRICHMENT + LRC ────────────────────────────
// tag:read/write/autoTag, mb:search, cover:fetch, lrc:fetch/save/exists/read
// moved to engine/tag.js (Fase G, Step 2), wired via wireIpc().

// ─── IPC: RADIO BROWSER ─────────────────────────────────────────────────────
// radio:search/countries/tags/languages moved to engine/radio.js (Fase G,
// Step 2), wired via wireIpc().

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────
// httpGetStream/fetchJSONWithUA/httpGetText/httpPostJSON moved to engine/net.js
// (Phase C, 2026-08-19). fetchBinary moved to engine/tag.js (Fase G, Step 2 —
// its only real caller was coverArtFetch, not identify/Shazam as this comment
// used to say).

// ─── DROPPED-CONTENT IMPORT (cross-app drag & drop) ──────────────────────────
// Files dragged in from another app (typically an image dragged out of a
// browser) have no disk path — the renderer either forwards the File's bytes
// here, or asks us to download the drag's source URL (Electron net → OS cert
// store + system proxy, same rationale as httpGetStream).
const DROPPED_DIR = () => {
  const dir = path.join(app.getPath('userData'), 'dropped');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const sanitizeDroppedName = n =>
  String(n || '').replace(/[^\w.\- ]+/g, '_').slice(-80);

ipcMain.handle('file:saveDroppedBuffer', (_, { name, data } = {}) => {
  try {
    if (!data || !data.byteLength) return { ok: false, error: 'empty payload' };
    const safe = sanitizeDroppedName(name) || 'dropped';
    const dest = path.join(DROPPED_DIR(), `${Date.now()}_${safe}`);
    fs.writeFileSync(dest, Buffer.from(data));
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// file:importUrl moved to engine/fileops.js (Fase G, Step 2), wired via
// wireIpc() — file:saveDroppedBuffer above stays here for now (needs G-bin,
// Step 3), still using the local DROPPED_DIR/sanitizeDroppedName above it.

// ─── SONG RECOGNITION (ICY metadata + AcoustID via fpcalc) ───────────────────
// getFpcalcPath moved to engine/binaries.js (Fase G, Step 2), re-imported above.
// radio:startIcyWatch/stopIcyWatch moved to engine/radio.js, wired via wireIpc().

// ─── SHAZAM / ACOUSTID RECOGNITION ──────────────────────────────────────────
// shazam:identifyFromBuffer, acoustid:validateKey/identifyFromBuffer/identify
// + their helpers (fetchAnyStatusJSON, captureStreamBytes, runFpcalc,
// acoustidLookup) moved to engine/identify.js (Fase G, Step 2), wired via
// wireIpc(). runFpcalcRaw below is a DIFFERENT feature (audio dedup hashing,
// not song recognition) and stays here.

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
      await host.getHost().trashItem(p);
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

// acoustidLookup moved to engine/identify.js (Fase G, Step 2).

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
    const proc = spawnYtDlp(ytdlp, args);
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

// Playlist M3U export — write the playlist as a .m3u8 file in a folder of the
// user's choosing. The renderer builds the M3U text (it has the items); main
// just writes the file after asking for a destination via showSaveDialog.
ipcMain.handle('playlist:exportM3U', async (_, { name, content }) => {
  try {
    const safeName = String(name || 'playlist').replace(/[\\/:*?"<>|]/g, '_');
    const r = await host.getHost().showSaveDialog({
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
// acoustid:status moved to engine/identify.js (Fase G, Step 2), wired via wireIpc().
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
    // binFilename() is the single source of truth for id→filename (also used
    // by binary-fetcher.js itself and by main.js's own resolvers elsewhere) —
    // this used to duplicate that mapping with a local switch that silently
    // went stale for anything added after fpcalc (e.g. whisper's real name is
    // "whisper-cli.exe", not "whisper.exe"; model files aren't .exe at all).
    const name = binaryFetcher.binFilename(id, process.platform);
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
// config:load/resetTOS moved to engine/config.js, wired via wireIpc().
ipcMain.handle('config:save',  (_, c)  => {
  // remote_whitelist / remote_lan_devices can be written OUT-OF-BAND by
  // main.js itself — a phone pairing via Telegram/LAN happens without the
  // renderer's in-memory `config` object ever knowing about it. If we blindly
  // overwrote the file with the renderer's (now-stale) copy on its next
  // save — which can be ANY settings change, not just a Remote one — a
  // pairing that happened in between would silently vanish from disk. Always
  // take these two fields from the freshest on-disk state instead of
  // trusting the renderer's blob for them.
  const onDisk = loadConfig();
  c.remote_whitelist   = onDisk.remote_whitelist;
  c.remote_lan_devices = onDisk.remote_lan_devices;
  const r = saveConfig(c);
  // Re-apply the global SOCKS5 proxy in case the user toggled it on/off
  // or changed credentials. Cheap when unchanged — applyGlobalProxy
  // exits early if config matches the previously-applied state.
  applyGlobalProxy().catch(e => log('ERROR', `applyGlobalProxy: ${e.message}`));
  // (Re)start/stop the Remote-companion transports if the bot token or the
  // LAN toggle/port changed. Idempotent — no-op when nothing relevant moved.
  syncRemoteServicesWithConfig(c);
  return r;
});

// profiles:load/save/delete — moved to engine/profiles.js, wired via
// wireIpc(ipcMain, ENGINE_MODULES) near the top of this file.

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
  'tos_accepted',
  'remote_bot_token', 'remote_whitelist', 'remote_lan_devices'
];

ipcMain.handle('flux:export', async (_, cfg, mode = 'shareable') => {
  const full = mode === 'full';
  const base = (cfg.profile_name || 'profile').replace(/\s+/g, '_');
  const result = await host.getHost().showSaveDialog({
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
  const result = await host.getHost().showOpenDialog({
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
  const r = await host.getHost().showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
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
// ─── FILE OPS ENGINE (Files / Sync module) + fileops:drives + files:list/rename
// moved to engine/fileops.js (Fase G, Step 2), wired via wireIpc().
ipcMain.handle('dialog:pickFiles', async () => {
  const r = await host.getHost().showOpenDialog({
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
  const r = await host.getHost().showOpenDialog({
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
  const r = await host.getHost().showOpenDialog({
    properties: ['openFile'],
    filters: opts.filters || [{ name: 'All files', extensions: ['*'] }]
  });
  return r.canceled ? null : r.filePaths[0];
});

const AUDIO_EXTENSIONS = ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav'];

ipcMain.handle('dialog:pickAudioFolder', async (_, { recursive = false } = {}) => {
  const r = await host.getHost().showOpenDialog({ properties: ['openDirectory'] });
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

// file:rename moved to engine/fileops.js (Fase G, Step 2), wired via wireIpc().
ipcMain.handle('shell:openFolder',    (_, p) => host.getHost().openPath(p));
ipcMain.handle('shell:openExternal',  (_, u) => host.getHost().openExternal(u));
ipcMain.handle('shell:revealInFolder',(_, p) => host.getHost().revealInFolder(p));
ipcMain.handle('shell:openPath',      (_, p) => host.getHost().openPath(p));
ipcMain.handle('fs:exists',           (_, p) => { try { return p && fs.existsSync(p); } catch { return false; } });

// lrc:save/exists/read moved to engine/tag.js (Fase G, Step 2), wired via wireIpc().
ipcMain.handle('clipboard:write', (_, text) => {
  try {
    if (!text) return false;
    return host.getHost().clipboardWrite(text);
  } catch(e) { log('ERROR', `clipboard: ${e.message}`); return false; }
});
ipcMain.handle('notify:show', (_, { title, body }) => {
  try {
    return host.getHost().notify(title, body);
  } catch (e) { log('ERROR', `notify: ${e.message}`); return false; }
});

// ─── IPC: HISTORY ────────────────────────────────────────────────────────────
// history:load/clear/append/stats moved to engine/history.js, wired via wireIpc().

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
// sendnzb:fromFile/test + sendto:torrent/test moved to engine/sendto.js,
// wired via wireIpc() (Fase G, Step 1 — logic itself already moved Phase C).

// ─── IPC: IRC / XDCC ──────────────────────────────────────────────────
// ircState + DCC transfer handling + ircHandleLine + socks5Connect +
// wrapWithTls moved to engine/irc.js (Fase G, Step 2). socks5Connect is
// re-imported at the top of this file for applyGlobalProxy's use (the only
// genuinely Electron-specific piece of this domain, via
// require('electron').session).

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

// getYtDlpProxyArg/getYtDlpCaEnv/spawnYtDlp moved to engine/binaries.js
// (Phase C, 2026-08-23).

// openIrcTransport + irc:connect/disconnect/join/send/raw moved to
// engine/irc.js (Fase G, Step 2), wired via wireIpc().
// ─── IPC: SCHEDULE ───────────────────────────────────────────────────────────
// schedule:load moved to engine/schedule.js, wired via wireIpc().
ipcMain.handle('schedule:save', (_, s) => { const ok = saveSchedule(s); startScheduler(); return ok; });

// ─── IPC: QUEUE ──────────────────────────────────────────────────────────────
// queue:load/checkUrl moved to engine/queue.js, wired via wireIpc().
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
  const dlg = await host.getHost().showOpenDialog({
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

// runQueue (worker/concurrency loop) moved to engine/queue.js (Phase C, 2026-08-23).
ipcMain.handle('queue:run', (event, { queue, config }) => runQueue(event, queue, config));

// ─── IPC: TORRENT SEARCH ─────────────────────────────────────────────────────
// runTorrentSearch/runWithConcurrency/expandTorznabTasks/fetchJackettApiKey
// moved to engine/torrent.js (Phase C, 2026-08-23).
ipcMain.handle('torrent:search', (event, { query, config }) => runTorrentSearch(event, query, config));

// Detect a locally-running Jackett or Prowlarr by probing their default ports.
// ANY HTTP response (even 401) means the service is up; only a refused/failed
// connection means it's absent. For Jackett we pull the API key straight from
// its config endpoint (fallback: on-disk file) so the source auto-configures.
// torznab:detect moved to engine/torrent.js, wired via wireIpc().

// readJackettApiKey moved to engine/torrent.js (Phase C, 2026-08-23).

// Torznab indexer picker — list the indexers already configured in the user's
// Jackett or Prowlarr instance so they can target a single tracker instead of
// the "all" aggregate. Detects flavour from the URL shape; the API key is
// passed as a query param (both servers accept ?apikey=), so no custom headers.
ipcMain.handle('torrent:listIndexers', async (_, { url, apikey } = {}) => {
  try { return await listTorznabIndexers(url, apikey); }
  catch (e) { log('ERROR', `torrent:listIndexers: ${e.message}`); return { ok: false, error: describeNetError(e) }; }
});

// YTS_FALLBACK_MIRRORS/fetchYtsWithFallback/resolveSiteType/searchSite/
// withMirrors/formatBytes/getPath/pickField/fillSourceUrl/torznabQuery/
// searchTorznab/parseTorznabXML/searchGenericJSON/searchGenericRSS/
// parseNyaaRSS moved to engine/torrent.js (Phase C, 2026-08-23).

// ─── IPC: TORRENT SAVE ───────────────────────────────────────────────────────
ipcMain.handle('torrent:save', async (_, { item, downloadFolder }) => saveTorrentItem(item, downloadFolder));

// saveTorrentItem moved to engine/torrent.js (Phase C, 2026-08-23).

// ─── IPC: MEDIA DOWNLOAD (with retry/resume) ─────────────────────────────────
// DRM-protected streaming platforms — yt-dlp can't decrypt their Widevine /
// FairPlay streams, and we never want to be perceived as a tool that tries.
// Match by hostname (host + parents) so paths don't matter; substring match
// keeps the list short (one entry per brand, regardless of TLD).
// DRM_BLOCKED_HOSTS/isDrmHost moved to engine/queue.js (Phase C, 2026-08-23).

ipcMain.handle('media:download', async (event, { url, format, downloadFolder, retry }) => {
  if (isDrmHost(url)) {
    return { ok: false, drm: true, error: 'DRM-protected platform — not supported by FLUX.' };
  }
  return runMediaDownloadRetry(event, url, format, downloadFolder, retry ?? 2);
});

// runMediaDownloadRetry/runMediaDownload moved to engine/queue.js (Phase C, 2026-08-23).

// ─── IPC: MEDIA PROBE (fetch title without downloading) ──────────────────────
ipcMain.handle('media:probe', (_, url) => probeMedia(url));
ipcMain.handle('media:getStreamUrl', (_, url, kind) => getStreamUrl(url, kind));

// getStreamUrl/probeMedia moved to engine/queue.js (Phase C, 2026-08-23).

// ─── RELATED MEDIA PROVIDERS (player "you might also like") ──────────────────
// Per-platform adapters that fetch related/recommended items for a media URL,
// mirroring the torrent-source adapter philosophy: the dispatcher picks a
// native adapter (YouTube Innertube, SoundCloud api-v2) and falls back to a
// yt-dlp YouTube search on the probed title when no native adapter exists or
// the native call fails. Every adapter returns the same normalized shape:
//   { url, title, uploader, duration, thumbnail }

// Sites tend to serve leaner/complete payloads to a real browser UA; the
// Innertube WEB client in particular expects one.
const RELATED_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// RELATED_MAX_ITEMS moved to engine/queue.js (Phase F, 2026-08-24) — imported below.

function extractYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') return u.pathname.split('/')[1] || null;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{6,})/);
      if (m) return m[2];
    }
  } catch { /* invalid URL */ }
  return null;
}

// YouTube: Innertube `next` endpoint (the same watch-page recommendations the
// official web client renders — also what FreeTube/Invidious consume). The
// public Data API removed relatedToVideoId in 2023, so this IS the way.
async function relatedFromYouTube(videoId) {
  const data = await httpPostJSON('https://www.youtube.com/youtubei/v1/next?prettyPrint=false', {
    context: { client: { clientName: 'WEB', clientVersion: '2.20250620.00.00', hl: 'en', gl: 'US' } },
    videoId, racyCheckOk: true, contentCheckOk: true
  }, { ua: RELATED_BROWSER_UA, timeout: 12000 });

  const results = data?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results || [];
  const items = [];
  const walk = list => {
    for (const entry of list) {
      if (entry.itemSectionRenderer?.contents) { walk(entry.itemSectionRenderer.contents); continue; }
      // Legacy shape (still served to some clients/regions)
      const cv = entry.compactVideoRenderer || entry.videoRenderer;
      if (cv?.videoId) {
        items.push({
          url: `https://www.youtube.com/watch?v=${cv.videoId}`,
          title: cv.title?.simpleText || (cv.title?.runs || []).map(r => r.text).join('') || null,
          uploader: cv.longBylineText?.runs?.[0]?.text || cv.shortBylineText?.runs?.[0]?.text || null,
          duration: cv.lengthText?.simpleText || null,
          thumbnail: `https://i.ytimg.com/vi/${cv.videoId}/mqdefault.jpg`
        });
        continue;
      }
      // Current WEB shape: lockupViewModel. An 11-char contentId is a video;
      // playlists/mixes carry RD/PL ids and are skipped.
      const lv = entry.lockupViewModel;
      if (lv?.contentId && /^[A-Za-z0-9_-]{11}$/.test(lv.contentId)
          && (!lv.contentType || String(lv.contentType).includes('VIDEO'))) {
        const meta = lv.metadata?.lockupMetadataViewModel;
        const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows || [];
        const uploader = rows[0]?.metadataParts?.[0]?.text?.content || null;
        let duration = null;
        for (const ov of lv.contentImage?.thumbnailViewModel?.overlays || []) {
          const badges = (ov.thumbnailBottomOverlayViewModel?.badges || [])
            .concat(ov.thumbnailOverlayBadgeViewModel?.thumbnailBadges || []);
          for (const b of badges) {
            const txt = b.thumbnailBadgeViewModel?.text;
            if (txt && /^[\d:]+$/.test(txt)) duration = txt;
          }
        }
        items.push({
          url: `https://www.youtube.com/watch?v=${lv.contentId}`,
          title: meta?.title?.content || null,
          uploader, duration,
          thumbnail: `https://i.ytimg.com/vi/${lv.contentId}/mqdefault.jpg`
        });
      }
    }
  };
  walk(results);
  return items.filter(i => i.title);
}

// SoundCloud api-v2 needs a client_id that isn't published anywhere official:
// the web app embeds it in its asset bundles, so we scrape it once and cache
// it for the session (it rotates every few weeks → rescrape on 401/403).
let scClientIdCache = null; // { id, at }
async function getSoundCloudClientId(force = false) {
  if (!force && scClientIdCache && Date.now() - scClientIdCache.at < 6 * 3600e3) return scClientIdCache.id;
  const html = await httpGetText('https://soundcloud.com/', { ua: RELATED_BROWSER_UA });
  const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map(m => m[1]);
  // The id usually sits in one of the LAST bundles — walk them in reverse.
  for (const src of scripts.reverse().slice(0, 8)) {
    try {
      const js = await httpGetText(src, { ua: RELATED_BROWSER_UA, accept: '*/*' });
      const m = js.match(/client_id\s*[:=]\s*"([A-Za-z0-9]{20,40})"/);
      if (m) { scClientIdCache = { id: m[1], at: Date.now() }; return m[1]; }
    } catch { /* try next asset */ }
  }
  throw new Error('SoundCloud client_id not found');
}

function formatMsDuration(ms) {
  if (!ms || !isFinite(ms)) return null;
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60), sec = s % 60, h = Math.floor(m / 60);
  return h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
           : `${m}:${String(sec).padStart(2, '0')}`;
}

async function relatedFromSoundCloud(url) {
  const attempt = async force => {
    const cid = await getSoundCloudClientId(force);
    const track = await fetchJSONWithUA(`https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${cid}`, RELATED_BROWSER_UA, 12000);
    if (!track || track.kind !== 'track' || !track.id) throw new Error('not a resolvable SoundCloud track');
    const rel = await fetchJSONWithUA(`https://api-v2.soundcloud.com/tracks/${track.id}/related?client_id=${cid}&limit=14`, RELATED_BROWSER_UA, 12000);
    return (rel.collection || []).filter(t => t && t.permalink_url).map(t => {
      const art = t.artwork_url || t.user?.avatar_url || null;
      return {
        url: t.permalink_url,
        title: t.title || null,
        uploader: t.user?.username || null,
        duration: formatMsDuration(t.full_duration || t.duration),
        thumbnail: art ? art.replace('-large.', '-t300x300.') : null
      };
    }).filter(i => i.title);
  };
  try { return await attempt(false); }
  catch (e) {
    // Stale cached client_id → rescrape once and retry
    if (/HTTP (401|403)/.test(e.message)) return attempt(true);
    throw e;
  }
}

// Fallback for every other yt-dlp-supported site: strip the noise from the
// probed title and run a flat YouTube search (single HTTP round-trip). Not
// "related" in the algorithmic sense, but close enough to be useful.
function cleanRelatedQuery(title) {
  return String(title)
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\b(official|video|audio|lyrics?|lyric|hd|4k|full|remaster(ed)?|visualizer|mv|trailer)\b/gi, ' ')
    .replace(/[|"“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ').slice(0, 8).join(' ');
}

// relatedFromSearch moved to engine/queue.js (Phase F, 2026-08-24) — imported
// at the top of this file alongside RELATED_MAX_ITEMS.

ipcMain.handle('media:related', async (_, payload) => {
  const { url, title, uploader } = payload || {};
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid URL', items: [] };
  let host = '';
  try { host = new URL(url).hostname.replace(/^(www|m)\./, ''); } catch { /* keep '' */ }

  const dedupe = items => {
    const seen = new Set([url]);
    return items.filter(i => {
      if (!i.url || seen.has(i.url)) return false;
      seen.add(i.url);
      return true;
    }).slice(0, RELATED_MAX_ITEMS);
  };

  // 1. Native platform adapter
  try {
    const videoId = extractYouTubeVideoId(url);
    if (videoId) {
      const items = dedupe(await relatedFromYouTube(videoId));
      if (items.length) return { ok: true, provider: 'youtube', items };
    } else if (/(^|\.)soundcloud\.com$/.test(host)) {
      const items = dedupe(await relatedFromSoundCloud(url));
      if (items.length) return { ok: true, provider: 'soundcloud', items };
    }
  } catch (e) {
    log('WARN', `media:related native adapter (${host}): ${e.message}`);
  }

  // 2. Generic fallback: YouTube search on the probed title. Prefix the
  // uploader when the title doesn't already carry it (music titles usually
  // do, "Artist - Track"), so same-author content ranks first.
  if (title) {
    const query = cleanRelatedQuery(title);
    if (query) {
      const q = uploader && !query.toLowerCase().includes(String(uploader).toLowerCase())
        ? `${uploader} ${query}` : query;
      const items = dedupe(await relatedFromSearch(q));
      if (items.length) return { ok: true, provider: 'search', items };
    }
  }
  return { ok: true, provider: null, items: [] };
});

// ─── IPC: LIVE RECORD (yt-dlp with live-aware args) ─────────────────────────
// live:record moved to engine/live.js (Fase G, Step 2), wired via wireIpc().

// ─── IPC: MEDIA STOP (kills processes + halts queue + cleans partials) ───────
ipcMain.handle('media:stop', (_e, payload) => {
  let killed = 0;
  for (const p of activeMediaProcs) {
    if (typeof p.__fluxStop === 'function') p.__fluxStop();
    else killProcessTree(p);
    killed++;
  }
  activeMediaProcs.clear();
  setStopRequested(true);

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
// rss:fetch/discover moved to engine/rss.js (fetchFeed/discoverFeed, both now
// self-contained — no external try/catch needed), wired via wireIpc().
// probeIsFeed moved to engine/rss.js (Phase C, 2026-08-23).

// tryResolveYouTubeFeed/parseFeed/parseRSS/parseAtom/tag/attr/stripHtml/
// decodeEntities moved to engine/rss.js (Phase C, 2026-08-23).

// ─── FETCH HELPERS ───────────────────────────────────────────────────────────
// fetchJSON/fetchTextSimple/downloadFile moved to engine/net.js (Phase C,
// 2026-08-19) — imported at the top of this file.

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

// ─── REMOTE MODULE (phone → FLUX companion) ──────────────────────────────────
// Telegram transport + the shared command dispatcher moved to
// engine/telegram.js + engine/remote.js (Phase F, 2026-08-24) — the bot polls
// api.telegram.org (no inbound network exposure needed) so it can run from
// server.js too. The LAN mini-server below stays desktop-only: its job
// (control FLUX from a phone) is superseded by server.js real web UI once
// that is what is running.

// LAN server state.
let lanServer     = null;
let lanServerPort = null;
const lanSessions = new Map(); // token -> { label, at }

// Pending LAN pairing PIN — single-use, short-lived, in-memory only (never
// persisted). Normally consumed via the QR code (which embeds it in the
// pairing URL) rather than typed. Telegram's own pairing code now lives in
// engine/telegram.js.
let pendingLanPin = null; // { pin, expiresAt }

function generateLanPin() {
  pendingLanPin = { pin: String(Math.floor(100000 + Math.random() * 900000)), expiresAt: Date.now() + 10 * 60 * 1000 };
  return pendingLanPin;
}

// ─── REMOTE: LAN TRANSPORT (mini web server) ─────────────────────────────────
function getLanIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Minimal dark styling so the pairing/command page doesn't look like an OS
// default form — same spirit as the desktop UI's "no standard HTML" rule,
// scaled down for a single utility page served outside the app shell.
const LAN_PAGE_STYLE = `body{background:#0b0b0b;color:#eee;font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px}
input,button{width:100%;box-sizing:border-box;padding:12px;margin:8px 0;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#eee;font-size:16px}
button{background:#c8f542;color:#0b0b0b;font-weight:600;border:none;cursor:pointer}
.log{white-space:pre-wrap;background:#141414;border-radius:8px;padding:12px;margin-top:16px;font-size:14px;line-height:1.5;min-height:80px}
h1{font-size:20px}`;

async function handleLanRequest(req, res) {
  const u       = new URL(req.url, `http://${req.headers.host}`);
  const cookies = parseCookies(req);
  const token   = cookies.flux_session;
  const paired  = token && lanSessions.has(token);

  if (u.pathname === '/pair' && req.method === 'GET') {
    const pin = u.searchParams.get('pin') || '';
    if (pendingLanPin && pendingLanPin.pin === pin && Date.now() < pendingLanPin.expiresAt) {
      const newToken = require('crypto').randomBytes(24).toString('hex');
      const entry = { token: newToken, label: `LAN — ${new Date().toLocaleDateString()}`, pairedAt: new Date().toISOString() };
      const updated = loadConfig();
      updated.remote_lan_devices = [...(updated.remote_lan_devices || []), entry];
      saveConfig(updated);
      lanSessions.set(newToken, { label: entry.label, at: Date.now() });
      pendingLanPin = null;
      res.writeHead(302, { Location: '/', 'Set-Cookie': `flux_session=${newToken}; Path=/; Max-Age=31536000; HttpOnly` });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLUX Remote</title><style>${LAN_PAGE_STYLE}</style></head><body><h1>FLUX Remote</h1><p>PIN non valido o scaduto.</p></body></html>`);
  }

  if (u.pathname === '/qr.png' && req.method === 'GET') {
    if (!pendingLanPin || Date.now() >= pendingLanPin.expiresAt) { res.writeHead(404); return res.end(); }
    const QRCode  = require('qrcode');
    const pairUrl = `http://${getLanIPv4()}:${lanServerPort}/pair?pin=${pendingLanPin.pin}`;
    const buf     = await QRCode.toBuffer(pairUrl, { width: 300, margin: 1 });
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(buf);
  }

  if (u.pathname === '/command' && req.method === 'POST') {
    if (!paired) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'not paired' })); }
    const body = await readRequestBody(req);
    let text = '';
    try { text = String(JSON.parse(body).text || ''); } catch { /* empty text below */ }
    const replies = [];
    await handleRemoteCommand(text, async (msg) => { replies.push(msg); }, { transport: 'lan', sessionKey: `lan:${token}` });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, replies }));
  }

  if (u.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (!paired) {
      return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLUX Remote</title><style>${LAN_PAGE_STYLE}</style></head><body>
<h1>FLUX Remote</h1><p>Inquadra il QR dal pannello Remote di FLUX, oppure inserisci qui il PIN mostrato lì.</p>
<form method="GET" action="/pair"><input name="pin" placeholder="PIN a 6 cifre" maxlength="6" inputmode="numeric"><button type="submit">Associa</button></form>
</body></html>`);
    }
    return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLUX Remote</title><style>${LAN_PAGE_STYLE}</style></head><body>
<h1>FLUX Remote</h1>
<form id="f"><input name="text" placeholder="URL, ricerca torrent, o &quot;trailer &lt;titolo&gt;&quot;" autofocus autocomplete="off"><button type="submit">Invia</button></form>
<div class="log" id="log"></div>
<script>
document.getElementById('f').addEventListener('submit', async function (e) {
  e.preventDefault();
  var input = e.target.text;
  var text = input.value.trim();
  if (!text) return;
  var logEl = document.getElementById('log');
  logEl.textContent += '\\n> ' + text;
  input.value = '';
  try {
    var r = await fetch('/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text }) });
    var data = await r.json();
    (data.replies || []).forEach(function (m) { logEl.textContent += '\\n' + m; });
  } catch (err) {
    logEl.textContent += '\\n\\u26a0\\ufe0f Errore di comunicazione con FLUX.';
  }
  logEl.scrollTop = logEl.scrollHeight;
});
</script>
</body></html>`);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

function startLanServer(port) {
  const http = require('http');
  lanServer = http.createServer((req, res) => {
    handleLanRequest(req, res).catch(e => {
      log('ERROR', `remote LAN request: ${e.message}`);
      try { res.writeHead(500); res.end('Internal error'); } catch { /* response already sent */ }
    });
  });
  lanServer.on('error', e => log('ERROR', `remote LAN server: ${e.message}`));
  lanServer.listen(port, '0.0.0.0', () => log('INFO', `remote: LAN server listening on ${port}`));
  lanServerPort = port;
  // Reload paired-device sessions from config so a server restart (port
  // change, app relaunch) doesn't force every already-paired phone to redo
  // the PIN flow.
  lanSessions.clear();
  for (const d of (loadConfig().remote_lan_devices || [])) lanSessions.set(d.token, { label: d.label, at: Date.now() });
}

function stopLanServer() {
  if (lanServer) { try { lanServer.close(); } catch { /* already closed */ } lanServer = null; }
  lanServerPort = null;
  log('INFO', 'remote: LAN server stopped');
}

// ─── REMOTE: SERVICE SYNC + IPC ───────────────────────────────────────────────
// Idempotent — called after every config:save and once at app startup. Starts,
// stops, or restarts each transport only when something relevant actually
// changed, so a save that touches unrelated settings is a no-op here.
function syncRemoteServicesWithConfig(cfg) {
  syncTelegramPolling(cfg);

  const desiredPort = cfg.remote_lan_port || 8765;
  if (cfg.remote_lan_enabled) {
    if (!lanServer || lanServerPort !== desiredPort) {
      stopLanServer();
      startLanServer(desiredPort);
    }
  } else if (lanServer) {
    stopLanServer();
  }
}

ipcMain.handle('remote:generatePairingCode', () => {
  const cfg = loadConfig();
  if (!cfg.remote_bot_token) return { ok: false, error: 'Configura prima il token del bot Telegram.' };
  const p = generatePairingCode();
  return { ok: true, code: p.code, expiresAt: p.expiresAt };
});

ipcMain.handle('remote:generateLanPin', () => {
  const cfg = loadConfig();
  if (!cfg.remote_lan_enabled || !lanServer) return { ok: false, error: 'Attiva prima il server LAN.' };
  const p = generateLanPin();
  const base = `http://${getLanIPv4()}:${lanServerPort}`;
  return { ok: true, pin: p.pin, expiresAt: p.expiresAt, url: `${base}/`, pairUrl: `${base}/pair?pin=${p.pin}`, qrUrl: `${base}/qr.png` };
});

ipcMain.handle('remote:getStatus', () => {
  const cfg = loadConfig();
  return {
    ...getTelegramStatus(),
    lanEnabled:  !!cfg.remote_lan_enabled,
    lanRunning:  !!lanServer,
    lanPort:     cfg.remote_lan_port || 8765,
    lanIp:       getLanIPv4(),
    lanDevices:  cfg.remote_lan_devices || []
  };
});

ipcMain.handle('remote:removeWhitelistChat', (_, chatId) => {
  const cfg = loadConfig();
  cfg.remote_whitelist = (cfg.remote_whitelist || []).filter(w => String(w.chatId) !== String(chatId));
  saveConfig(cfg);
  return { ok: true };
});

ipcMain.handle('remote:removeLanDevice', (_, token) => {
  const cfg = loadConfig();
  cfg.remote_lan_devices = (cfg.remote_lan_devices || []).filter(d => d.token !== token);
  saveConfig(cfg);
  lanSessions.delete(token);
  return { ok: true };
});
