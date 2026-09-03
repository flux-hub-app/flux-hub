'use strict';

// server.js — headless entry point for FLUX's "server" scope: queue/download,
// torrent search, RSS + auto-download, subscriptions, scheduler, history,
// settings, module/binary status — exposed over a REST + SSE API instead of
// Electron IPC. Phase C of the Docker/TrueNAS plan (tracking #26,
// design/flux-patterns.md §10). No Electron anywhere in this file or its
// requires — `node server.js` (not electron.exe) is the proof.
//
// Explicitly OUT of scope (workstation-only features that presuppose a
// person at a screen — stay desktop-only, main.js untouched by this file):
// the LAN mini-server companion transport, and the handful of Xtract/Images
// panels that genuinely need a real Chromium window (screen/window capture
// listing, URL/HTML capture, PDF-page export — see engine/xtract.js's header
// comment). Xtract's ffmpeg pipeline, the image editor/batch ops, AI
// subtitles, IRC/XDCC, radio/live, music recognition, and the Telegram
// companion are IN scope (Fase G, Step 2-3, tracking #26) — see
// engine/xtract.js, engine/images.js, engine/ai.js, engine/irc.js,
// engine/radio.js, engine/live.js, engine/identify.js, engine/telegram.js.
//
// Auth (first pass): FLUX_ADMIN_PASSWORD env → POST /api/auth/login → signed
// session token → httpOnly cookie, same shape as the LAN companion's
// flux_session cookie. The companion's PIN-pairing flow (trusting an
// ADDITIONAL device from an already-authenticated session) is a deferred
// follow-up — see tracking #26 — this is password-only bootstrap auth.
//
// Static web UI (Phase D, 2026-08-23): serves renderer/ as-is, swapping
// index.html's <script src="renderer.js"> for <script src="api-http.js">
// (api-http.js takes over loading renderer.js itself, after auth — see its
// header comment). No build step, no second frontend: same HTML/CSS/i18n/
// icons as desktop, only window.api's implementation differs.
//
// Docker packaging is Phase E, not this file.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const enginePaths = require('./engine/paths');
const bus = require('./engine/bus');
const host = require('./engine/host');
const { createServerHost } = require('./engine/host-server');
const { log } = require('./engine/log');
const { loadConfig, saveConfig } = require('./engine/config');
const { loadHistory, appendHistory, computeHistoryStats, clearHistory } = require('./engine/history');
const { loadSchedule, saveSchedule } = require('./engine/schedule');
const {
  loadQueue, saveQueue, runQueue, runMediaDownloadRetry,
  activeMediaProcs, isStopRequested, setStopRequested, killProcessTree,
  isDrmHost, getStreamUrl, probeMedia,
} = require('./engine/queue');
const {
  runTorrentSearch, detectJackettOrProwlarr, listTorznabIndexers, saveTorrentItem,
} = require('./engine/torrent');
const { fetchTextSimple, describeNetError } = require('./engine/net');
const { parseFeed, discoverFeed } = require('./engine/rss');
const { sendNzbFromFile, sendToTorrentClient } = require('./engine/sendto');
const { startScheduler } = require('./engine/scheduler');
const {
  generatePairingCode, syncTelegramPolling, getStatus: getTelegramStatus,
} = require('./engine/telegram');
const binaryFetcher = require('./binary-fetcher');
const { wireRest } = require('./engine/wire-rest');
const ENGINE_MODULES = require('./engine/engine-modules');
// xtract:probeDuration / xtract:hasAudio aren't in engine/xtract.js's
// routes[] (see its header comment) — hand-wired below like the FS routes.
const xtractModule = require('./engine/xtract');

// ─── CONFIG FROM ENV ──────────────────────────────────────────────────────
const DATA_DIR       = process.env.FLUX_DATA_DIR;
const DOWNLOAD_DIR   = process.env.FLUX_DOWNLOAD_DIR || (DATA_DIR && path.join(DATA_DIR, 'downloads'));
const PORT           = parseInt(process.env.FLUX_PORT, 10) || 8080;
const ADMIN_PASSWORD = process.env.FLUX_ADMIN_PASSWORD;

if (!DATA_DIR) {
  console.error('FLUX_DATA_DIR is required (persistent volume for config/queue/history/vendor).');
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.error('FLUX_ADMIN_PASSWORD is required — refusing to start an unauthenticated download server.');
  process.exit(1);
}

enginePaths.configurePaths({
  userData: DATA_DIR,
  downloadFolder: DOWNLOAD_DIR,
  vendorDir: path.join(DATA_DIR, 'vendor'),
  isPackaged: true,     // no dev-mode concept for a server deployment
  resourcesDir: null,   // no packaged-resources dir headless — vendorDir-only binary resolution
});
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'vendor'), { recursive: true });

host.setHost(createServerHost());

// Declared here (not down by its only other user, the /api/modules route)
// because the self-healing modules_enabled block right below needs it at
// module-evaluation time — a `function` declaration is fully hoisted, but
// the `let _registryCache` it closes over is not (temporal dead zone),
// so calling loadRegistry() before this point would throw.
let _registryCache = null;
function loadRegistry() {
  if (_registryCache) return _registryCache;
  try { _registryCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'modules', 'registry.json'), 'utf8')); }
  catch (e) { log('ERROR', `loadRegistry: ${e.message}`); _registryCache = { version: 0, binaries: {}, modules: [] }; }
  return _registryCache;
}

// Server profile: derived from registry.json's per-module `server` field
// (Fase G, Step 1) instead of a hardcoded array here — a module becomes
// server-visible by marking itself in the registry, not by someone
// remembering to edit this file (the exact bug class that bit /api/modules
// before: a filter here silently drifting from what the registry declares).
const SERVER_MODULE_IDS = (loadRegistry().modules || []).filter(m => m.server).map(m => m.id);

// Every boot, self-healing: fill in ONLY module ids the saved config has
// never seen (`undefined`, not `false`/`true`) so the web UI hides
// workstation tabs on a fresh deployment AND after a future registry.json
// gains a new module id — never overrides a key the user (or a previous
// run of this same block) already set explicitly, so toggles made from the
// web UI's Settings > Modules always win from then on. Module gating itself
// is existing, already-tested renderer.js behavior (applyModuleVisibility(),
// see design/flux-patterns.md §1) — this only ensures the config it reads
// has an explicit value for every module, which engine/config.js's own
// DEFAULT_CONFIG deliberately does NOT provide for newer ids (files/video/
// ai/remote) — that omission is correct for an upgrading DESKTOP user (new
// modules default to ON there), but left those same ids with no explicit
// `false` here, which applyModuleVisibility() treats as "visible" — found
// live on the owner's first real deployment, not in review.
{
  const cfg = loadConfig();
  const reg = loadRegistry();
  let changed = false;
  for (const m of (reg.modules || [])) {
    if (cfg.modules_enabled[m.id] === undefined) {
      cfg.modules_enabled[m.id] = SERVER_MODULE_IDS.includes(m.id);
      changed = true;
    }
  }
  if (changed) {
    saveConfig(cfg);
    log('INFO', `filled in modules_enabled for new registry modules (server profile: ${SERVER_MODULE_IDS.join(', ')})`);
  }
}

// ─── AUTH: password login → token → cookie ────────────────────────────────
const sessions = new Map(); // token -> { createdAt }
const SESSION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year — same lifetime as the LAN companion's flux_session cookie

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function isAuthed(req) {
  const cookies = parseCookies(req);
  const bearer = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  const token = cookies.flux_session || bearer;
  if (!token || !sessions.has(token)) return false;
  const s = sessions.get(token);
  if (Date.now() - s.createdAt > SESSION_MAX_AGE_MS) { sessions.delete(token); return false; }
  return true;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 10 * 1024 * 1024) { req.destroy(); reject(new Error('request body too large')); return; }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJSONBody(req) {
  const raw = await readRequestBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('invalid JSON body'); }
}

// Raw-bytes counterpart to readJSONBody — for routes whose body is a browser
// Blob/ArrayBuffer (microphone capture, canvas PNG, dropped file), not JSON.
// Accumulates Buffer chunks directly instead of a string (readRequestBody's
// `data += c` would corrupt binary bytes through string coercion). Same
// 10MB cap; a route expecting larger payloads (a dropped video file) can
// raise it locally once that route exists — see engine/wire-rest.js's
// `route.binary`.
function readBinaryBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('request body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// ─── MINIMAL ROUTER ────────────────────────────────────────────────────────
// No Express — coherent with the "plain http, no framework" style already
// used everywhere in main.js (see the LAN companion server, startLanServer).
const routes = [];
function on(method, pattern, handler) {
  const paramNames = [];
  const regexStr = pattern.replace(/:([A-Za-z0-9_]+)/g, (_, name) => { paramNames.push(name); return '([^/]+)'; });
  routes.push({ method, regex: new RegExp(`^${regexStr}$`), paramNames, handler });
}

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    r.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
    return { handler: r.handler, params };
  }
  return null;
}

// ─── ROUTES: AUTH + HEALTH (no auth required) ──────────────────────────────
on('GET', '/api/health', (req, res) => sendJSON(res, 200, { ok: true, version: require('./package.json').version }));

on('POST', '/api/auth/login', async (req, res) => {
  const body = await readJSONBody(req);
  if (!body.password || body.password !== ADMIN_PASSWORD) {
    return sendJSON(res, 401, { ok: false, error: 'wrong password' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { createdAt: Date.now() });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': `flux_session=${token}; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; HttpOnly; SameSite=Lax`,
  });
  res.end(JSON.stringify({ ok: true, token }));
});

on('POST', '/api/auth/logout', async (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.flux_session) sessions.delete(cookies.flux_session);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': 'flux_session=; Path=/; Max-Age=0' });
  res.end(JSON.stringify({ ok: true }));
});

// ─── ROUTES: CONFIG ────────────────────────────────────────────────────────
// GET /api/config + POST /api/config/resetTOS generated by wireRest() below
// (engine/config.js's routes[]) — PUT stays hand-written, it has a real side
// effect (syncTelegramPolling) the generic wrapper has no place for.
on('PUT', '/api/config', async (req, res) => {
  const body = await readJSONBody(req);
  const ok = saveConfig(body);
  syncTelegramPolling(body); // same pattern as desktop's config:save → syncRemoteServicesWithConfig
  sendJSON(res, 200, { ok });
});

// ─── ROUTES: SYSTEM (renderer error/warn forwarding) ───────────────────────
on('POST', '/api/log', async (req, res) => {
  const body = await readJSONBody(req);
  log(String(body.level || 'INFO').toUpperCase(), `[browser] ${body.msg}`);
  sendJSON(res, 200, { ok: true });
});

// ─── ROUTES: FS (checks against the SERVER's own disk — paths in this
// deployment always mean paths inside the container/host running server.js,
// never the browser's machine, so this is meaningfully real here, not a
// desktop-only concept like dialog/clipboard/shell below) ──────────────────
on('POST', '/api/fs/checkPathWritable', async (req, res) => {
  const { path: p } = await readJSONBody(req);
  try {
    if (!p) return sendJSON(res, 200, { ok: false, error: 'No path provided' });
    fs.mkdirSync(p, { recursive: true });
    const probe = path.join(p, `.flux-write-${Date.now()}.tmp`);
    fs.writeFileSync(probe, 'flux');
    fs.unlinkSync(probe);
    sendJSON(res, 200, { ok: true, path: p });
  } catch (e) {
    sendJSON(res, 200, { ok: false, error: e.message, path: p });
  }
});
on('GET', '/api/fs/exists', (req, res, params, query) => {
  const p = query.get('path');
  let exists = false;
  try { exists = !!p && fs.existsSync(p); } catch {}
  sendJSON(res, 200, { exists });
});

// ─── ROUTES: XTRACT (hand-wired subset — see engine/xtract.js's header
// comment on why these two aren't in its routes[]; the rest of Xtract's
// surface is generated by wireRest() below) ─────────────────────────────────
on('GET', '/api/xtract/probeDuration', async (req, res, params, query) => {
  sendJSON(res, 200, await xtractModule.probeDuration(query.get('input')));
});
on('GET', '/api/xtract/hasAudio', async (req, res, params, query) => {
  sendJSON(res, 200, await xtractModule.hasAudio(query.get('input')));
});

// ─── ROUTES: BINARY (lazy fetch — same binary-fetcher.js as desktop) ───────
on('POST', '/api/binary/fetch/:id', async (req, res, params) => {
  const { vendorDir } = enginePaths.getPaths();
  log('INFO', `binary:fetch ${params.id} → ${vendorDir}`);
  const r = await binaryFetcher.fetchBinary(params.id, {
    vendorDir,
    onProgress: p => bus.broadcastSend('binary:progress', p),
  });
  if (r.ok) log('INFO', `binary:fetch ${params.id} done (${(r.fetched || []).join(', ')})`);
  else      log('ERROR', `binary:fetch ${params.id} failed: ${r.error}`);
  sendJSON(res, 200, r);
});
on('GET', '/api/binary/probeSize/:id', async (req, res, params) => {
  let size = 0;
  try { size = await binaryFetcher.probeSize(params.id, {}); } catch {}
  sendJSON(res, 200, { size });
});
on('POST', '/api/binary/ensureForModule/:moduleId', async (req, res, params) => {
  const reg = loadRegistry();
  const mod = (reg.modules || []).find(m => m.id === params.moduleId);
  if (!mod) return sendJSON(res, 404, { ok: false, error: `Unknown module: ${params.moduleId}` });
  const { vendorDir } = enginePaths.getPaths();
  const fetched = [];
  for (const bid of (mod.binaries || [])) {
    if (binaryFetcher.isPresent(bid, vendorDir)) continue;
    const r = await binaryFetcher.fetchBinary(bid, {
      vendorDir,
      onProgress: p => bus.broadcastSend('binary:progress', { ...p, moduleId: params.moduleId }),
    });
    if (!r.ok) {
      log('ERROR', `binary:ensureForModule ${params.moduleId}/${bid} failed: ${r.error}`);
      return sendJSON(res, 200, { ok: false, error: r.error, binary: bid, moduleId: params.moduleId });
    }
    fetched.push(...(r.fetched || [bid]));
  }
  sendJSON(res, 200, { ok: true, fetched, moduleId: params.moduleId });
});

// ─── ROUTES: MEDIA (yt-dlp download/probe/stream-url/stop) ─────────────────
on('POST', '/api/media/download', async (req, res) => {
  const body = await readJSONBody(req);
  if (isDrmHost(body.url)) return sendJSON(res, 200, { ok: false, drm: true, error: 'DRM-protected platform — not supported by FLUX.' });
  const result = await runMediaDownloadRetry(
    { sender: bus.getBroadcastSender() }, body.url, body.format, body.downloadFolder || loadConfig().download_folder, body.retry ?? 2
  );
  sendJSON(res, 200, result);
});
on('POST', '/api/media/probe', async (req, res) => {
  const body = await readJSONBody(req);
  sendJSON(res, 200, await probeMedia(body.url));
});
on('POST', '/api/media/getStreamUrl', async (req, res) => {
  const body = await readJSONBody(req);
  sendJSON(res, 200, await getStreamUrl(body.url));
});
on('POST', '/api/media/stop', async (req, res) => {
  let killed = 0;
  for (const p of activeMediaProcs) {
    if (typeof p.__fluxStop === 'function') p.__fluxStop();
    else killProcessTree(p);
    killed++;
  }
  activeMediaProcs.clear();
  setStopRequested(true);
  const body = await readJSONBody(req).catch(() => ({}));
  if (body.downloadFolder) {
    setTimeout(() => {
      const tempDir = path.join(body.downloadFolder, '.flux-temp');
      try { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }, 500);
  }
  sendJSON(res, 200, { ok: true, killed });
});

// ─── ROUTES: SEND-TO-CLIENT / SEND-TO-USENET ───────────────────────────────
// All 4 generated by wireRest() below (engine/sendto.js's routes[]).

// ─── ROUTES: TORZNAB (Jackett/Prowlarr detection + indexer picker) ─────────
// GET /api/torznab/detect generated by wireRest() below (engine/torrent.js).
on('POST', '/api/torrent/listIndexers', async (req, res) => {
  const body = await readJSONBody(req);
  try { sendJSON(res, 200, await listTorznabIndexers(body.url, body.apikey)); }
  catch (e) { log('ERROR', `torrent:listIndexers: ${e.message}`); sendJSON(res, 200, { ok: false, error: describeNetError(e) }); }
});

// ─── ROUTES: QUEUE — paste-list import ─────────────────────────────────────
// GET /api/queue/checkUrl generated by wireRest() below (engine/queue.js's
// checkUrl() — was verbatim duplicated here and in main.js, now one copy).
// Paste-only (no native file picker headless — see engine/host-server.js).
function parseImportTXT(content) {
  return content.split(/\r?\n/)
    .map(l => l.trim())
    .map(l => l.replace(/^["']+|["']+$/g, '').trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith(';'))
    .map(line => {
      const isUrl = /^https?:\/\//i.test(line);
      return { url: isUrl ? line : null, title: line, format: null, isSearchQuery: !isUrl };
    });
}
on('POST', '/api/queue/importList', async (req, res) => {
  const body = await readJSONBody(req);
  const text = String(body.text || '');
  if (!text.trim()) return sendJSON(res, 200, { ok: false, error: 'no text provided' });
  try {
    let content = text;
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    const rows = parseImportTXT(content);
    sendJSON(res, 200, { ok: true, rows, filePath: '', count: rows.length });
  } catch (e) {
    log('ERROR', `queue:importList (paste): ${e.message}`);
    sendJSON(res, 200, { ok: false, error: e.message });
  }
});

// ─── ROUTES: RSS (parse a feed / discover a feed URL from a page) ──────────
// Both generated by wireRest() below (engine/rss.js's fetchFeed/discoverFeed
// — were verbatim duplicated here and in main.js, now one copy each).

// ─── ROUTES: QUEUE ──────────────────────────────────────────────────────────
// GET /api/queue generated by wireRest() below (engine/queue.js's routes[]).
on('PUT', '/api/queue', async (req, res) => {
  const body = await readJSONBody(req);
  if (!Array.isArray(body)) return sendJSON(res, 400, { ok: false, error: 'body must be an array' });
  saveQueue(body);
  sendJSON(res, 200, { ok: true });
});
on('DELETE', '/api/queue', (req, res) => { saveQueue([]); sendJSON(res, 200, { ok: true }); });
on('POST', '/api/queue/run', async (req, res) => {
  const body = await readJSONBody(req);
  const queue  = Array.isArray(body.queue) ? body.queue : loadQueue();
  const config = body.config || loadConfig();
  const result = await runQueue({ sender: bus.getBroadcastSender() }, queue, config);
  sendJSON(res, 200, result);
});

// ─── ROUTES: TORRENT SEARCH ─────────────────────────────────────────────────
on('POST', '/api/torrent/search', async (req, res) => {
  const body = await readJSONBody(req);
  if (!body.query) return sendJSON(res, 400, { ok: false, error: 'query required' });
  const config = body.config || loadConfig();
  const result = await runTorrentSearch({ sender: bus.getBroadcastSender() }, body.query, config);
  sendJSON(res, 200, result);
});
on('POST', '/api/torrent/save', async (req, res) => {
  const body = await readJSONBody(req);
  if (!body.item) return sendJSON(res, 400, { ok: false, error: 'item required' });
  sendJSON(res, 200, await saveTorrentItem(body.item, body.downloadFolder || loadConfig().download_folder));
});

// ─── ROUTES: RSS FEEDS (sub-resource view over config.rss_feeds) ───────────
on('GET', '/api/rss/feeds', (req, res) => sendJSON(res, 200, loadConfig().rss_feeds || []));
on('POST', '/api/rss/feeds', async (req, res) => {
  const body = await readJSONBody(req);
  if (!body.url) return sendJSON(res, 400, { ok: false, error: 'url required' });
  const cfg = loadConfig();
  cfg.rss_feeds = cfg.rss_feeds || [];
  if (cfg.rss_feeds.some(f => f.url === body.url)) return sendJSON(res, 409, { ok: false, error: 'feed already exists' });
  const feed = { name: body.name || body.url, url: body.url, auto_download: !!body.auto_download, last_fetched: null, last_guids: [] };
  cfg.rss_feeds.push(feed);
  saveConfig(cfg);
  sendJSON(res, 201, { ok: true, feed });
});
on('DELETE', '/api/rss/feeds', async (req, res, params, query) => {
  const url = query.get('url');
  if (!url) return sendJSON(res, 400, { ok: false, error: 'url query param required' });
  const cfg = loadConfig();
  const before = (cfg.rss_feeds || []).length;
  cfg.rss_feeds = (cfg.rss_feeds || []).filter(f => f.url !== url);
  saveConfig(cfg);
  sendJSON(res, 200, { ok: true, removed: before - cfg.rss_feeds.length });
});

// ─── ROUTES: SUBSCRIPTIONS (sub-resource view over config.subscriptions) ───
on('GET', '/api/subscriptions', (req, res) => sendJSON(res, 200, loadConfig().subscriptions || []));
on('POST', '/api/subscriptions', async (req, res) => {
  const body = await readJSONBody(req);
  if (!body.query) return sendJSON(res, 400, { ok: false, error: 'query required' });
  const cfg = loadConfig();
  cfg.subscriptions = cfg.subscriptions || [];
  const sub = { id: crypto.randomBytes(6).toString('hex'), query: body.query, keyword: body.keyword || '', enabled: body.enabled !== false, last_checked: null, grabbed_ids: [] };
  cfg.subscriptions.push(sub);
  saveConfig(cfg);
  sendJSON(res, 201, { ok: true, subscription: sub });
});
on('DELETE', '/api/subscriptions/:id', async (req, res, params) => {
  const cfg = loadConfig();
  const before = (cfg.subscriptions || []).length;
  cfg.subscriptions = (cfg.subscriptions || []).filter(s => String(s.id) !== params.id);
  saveConfig(cfg);
  sendJSON(res, 200, { ok: true, removed: before - cfg.subscriptions.length });
});

// ─── ROUTES: SCHEDULE ────────────────────────────────────────────────────────
// GET /api/schedule generated by wireRest() below (engine/schedule.js).
on('PUT', '/api/schedule', async (req, res) => {
  const body = await readJSONBody(req);
  const ok = saveSchedule(body);
  startScheduler(); // same pattern as ipcMain 'schedule:save' — apply the new window/interval immediately
  sendJSON(res, 200, { ok });
});

// ─── ROUTES: REMOTE (Telegram bot only — the LAN mini-server transport
// stays desktop-only, see engine/telegram.js's header comment) ─────────────
on('GET', '/api/remote/status', (req, res) => {
  // renderer.js's Remote panel (renderRemoteStatus) reads the LAN fields
  // UNCONDITIONALLY — same shape desktop's remote:getStatus always returned
  // (Telegram+LAN merged), even though this server profile never runs the
  // LAN mini-server transport (see engine/telegram.js's header comment).
  // Omitting them crashes the panel on `status.lanDevices.length` — found by
  // driving the actual page through its real boot sequence, not a unit test.
  sendJSON(res, 200, {
    ...getTelegramStatus(),
    lanEnabled: false, lanRunning: false, lanPort: 8765, lanIp: null, lanDevices: [],
  });
});
on('POST', '/api/remote/generatePairingCode', (req, res) => {
  const cfg = loadConfig();
  if (!cfg.remote_bot_token) return sendJSON(res, 200, { ok: false, error: 'Configura prima il token del bot Telegram.' });
  const p = generatePairingCode();
  sendJSON(res, 200, { ok: true, code: p.code, expiresAt: p.expiresAt });
});
on('POST', '/api/remote/removeWhitelistChat', async (req, res) => {
  const body = await readJSONBody(req);
  const cfg = loadConfig();
  cfg.remote_whitelist = (cfg.remote_whitelist || []).filter(w => String(w.chatId) !== String(body.chatId));
  saveConfig(cfg);
  sendJSON(res, 200, { ok: true });
});

// ─── ROUTES: HISTORY ──────────────────────────────────────────────────────
// All 4 generated by wireRest() below (engine/history.js's routes[]).

// ─── ROUTES: MODULES ─────────────────────────────────────────────────────────
// Returns the FULL registry, unfiltered — same as desktop's modules:registry
// IPC handler. Tab hiding is NOT done by trimming this list: renderer.js's
// applyModuleVisibility() only ever ADDS `.hidden` to tabs of a module it
// finds in the registry with modules_enabled[id] === false — a module
// missing from the list entirely is invisible to that loop and its tabs
// stay visible (index.html ships every tab statically). SERVER_MODULE_IDS
// still does the real gating, at first boot only: it seeds modules_enabled
// so workstation modules start `false` and applyModuleVisibility() hides
// their tabs correctly, exactly like a desktop user who disabled them by
// hand. (Found live on the owner's first TrueNAS run — filtering this list
// looked "more correct" but silently defeated the hiding mechanism.)
on('GET', '/api/modules', (req, res) => {
  const reg = loadRegistry();
  const { vendorDir } = enginePaths.getPaths();
  const binaryStatus = {};
  for (const id of Object.keys(reg.binaries || {})) binaryStatus[id] = binaryFetcher.isPresent(id, vendorDir);
  // serverModuleIds lets renderer.js's Settings > Modules tell the truly
  // supported modules apart from ones that just show up because the
  // registry is unfiltered (see the comment above) — it renders those as a
  // locked badge instead of a toggle. Absent on desktop's own
  // modules:registry IPC handler (plain loadModuleRegistry(), no such
  // field), so that UI branch never triggers there.
  sendJSON(res, 200, { modules: reg.modules || [], binaries: reg.binaries || {}, binaryStatus, serverModuleIds: SERVER_MODULE_IDS });
});

// ─── ROUTES: SERVER FILE PICKER (Fase G, Step 2) ────────────────────────────
// One-level directory listing (dirs + files, NOT recursive like
// engine/fileops.js's files:list) — the browsing primitive behind
// api-http.js's real dialog.pickFile/pickFiles/pickImages/pickFolder/
// pickAudioFolder, replacing the native OS picker a browser can't open on
// the machine running server.js. No root restriction beyond what the OS
// user running this process can already read: the caller is already an
// authenticated admin who fully controls this FLUX instance and its
// filesystem access (same trust level as editing FLUX_DOWNLOAD_DIR itself)
// — restricting browsing to one folder would block the real use case of
// picking a file from another share mounted into the same container.
on('GET', '/api/browse', (req, res, params, query) => {
  const dir = query.get('path') || DOWNLOAD_DIR;
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return sendJSON(res, 200, { ok: false, error: 'Not a directory' });
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = [], files = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // hide dotfiles/dotdirs — clutter, never what the user wants to pick
      const full = path.join(dir, e.name);
      if (e.isDirectory()) dirs.push({ name: e.name, path: full });
      else if (e.isFile()) {
        let size = 0; try { size = fs.statSync(full).size; } catch {}
        files.push({ name: e.name, path: full, size });
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(dir) !== dir ? path.dirname(dir) : null;
    sendJSON(res, 200, { ok: true, path: dir, parent, dirs, files });
  } catch (e) {
    sendJSON(res, 200, { ok: false, error: e.message });
  }
});

// ─── ROUTES: declarative registry (Fase G) ─────────────────────────────────
// Generates GET/POST/DELETE routes for every `routes[]` array an engine/*.js
// module exports — the REST half of the SAME declaration main.js's wireIpc()
// reads (see engine/wire-rest.js, engine/engine-modules.js). Covers:
// profiles, history, sendto/sendnzb, schedule (load only), rss, queue (load/
// checkUrl only), config (load/resetTOS only), torznab:detect — see each
// module's own routes[] comment for why the rest of that domain stays
// hand-written above instead of going through this generic path.
wireRest(on, ENGINE_MODULES, { readJSONBody, readBinaryBody, sendJSON });

// ─── SSE ────────────────────────────────────────────────────────────────────
// One sink per connection, fanned out via engine/bus.js's addSink/broadcastSend
// (Phase C, 2026-08-23) — every browser tab open on /events gets every event,
// same channel names the desktop renderer already listens for over IPC.
on('GET', '/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
  });
  res.write(': connected\n\n');
  const sink = {
    isDestroyed: () => res.writableEnded || res.destroyed,
    send: (channel, payload) => { try { res.write(`event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`); } catch {} },
  };
  bus.addSink(sink);
  const keepalive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(keepalive); bus.removeSink(sink); });
});

// ─── STATIC WEB UI ──────────────────────────────────────────────────────────
// Public (no auth) — the login form itself is part of the page (api-http.js
// injects it before doing anything else), so the shell must load first.
// Path-traversal guarded by resolving against the chosen root and rejecting
// anything that escapes it (a malformed/encoded ../ in the URL).
const RENDERER_DIR = path.join(__dirname, 'renderer');
// index.html references logos as `../assets/...` (a sibling of renderer/ in
// the desktop packaging — see package.json's `files` list) — the browser
// resolves that same relative path against the page's own root-served URL
// as plain `/assets/...`, so that prefix is served from this second root
// instead of nesting a copy inside renderer/.
const ASSETS_DIR = path.join(__dirname, 'assets');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.map': 'application/json',
};

function serveStatic(req, res, pathname) {
  const isAsset = pathname === '/assets' || pathname.startsWith('/assets/');
  const root = isAsset ? ASSETS_DIR : RENDERER_DIR;
  const rel  = isAsset ? decodeURIComponent(pathname).slice('/assets'.length) || '/'
             : pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const filePath = path.normalize(path.join(root, rel));
  if (!filePath.startsWith(root)) { res.writeHead(403); res.end(); return true; }
  let stat;
  try { stat = fs.statSync(filePath); } catch { return false; }
  if (!stat.isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME_TYPES[ext] || 'application/octet-stream';

  if (rel === '/index.html') {
    // api-http.js takes over BOTH roles preload.js had (exposing window.api)
    // AND loading renderer.js itself, gated behind auth — see its header
    // comment. Dropping the static <script src="renderer.js"> tag here means
    // renderer.js only ever runs after window.api is ready, same ordering
    // guarantee Electron gave for free via webPreferences.preload.
    const html = fs.readFileSync(filePath, 'utf8')
      .replace('<script src="renderer.js"></script>', '<script src="api-http.js"></script>');
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(html) });
    res.end(html);
    return true;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

// ─── HTTP SERVER + DISPATCH ─────────────────────────────────────────────────
const PUBLIC_ROUTES = new Set(['GET /api/health', 'POST /api/auth/login']);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method = req.method.toUpperCase();
  const match = matchRoute(method, u.pathname);

  if (!match) {
    if (method === 'GET' && serveStatic(req, res, u.pathname)) return;
    return sendJSON(res, 404, { ok: false, error: 'not found' });
  }

  if (!PUBLIC_ROUTES.has(`${method} ${u.pathname}`) && !isAuthed(req)) {
    return sendJSON(res, 401, { ok: false, error: 'unauthorized' });
  }

  try {
    await match.handler(req, res, match.params, u.searchParams);
  } catch (e) {
    log('ERROR', `${method} ${u.pathname}: ${e.message}`);
    if (!res.headersSent) {
      const status = /invalid JSON/i.test(e.message) ? 400 : /too large/i.test(e.message) ? 413 : 500;
      sendJSON(res, status, { ok: false, error: e.message });
    }
  }
});

server.listen(PORT, () => {
  log('INFO', `FLUX server listening on :${PORT} (data=${DATA_DIR} downloads=${DOWNLOAD_DIR})`);
  startScheduler();
  // Telegram bot (Phase F, 2026-08-24) — starts polling immediately if a
  // token is already configured (e.g. config copied over from desktop);
  // config:save's equivalent on desktop is PUT /api/config below, which
  // also calls syncTelegramPolling so a token set later takes effect live.
  syncTelegramPolling(loadConfig());
});

process.on('SIGTERM', () => { log('INFO', 'SIGTERM received, shutting down'); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { log('INFO', 'SIGINT received, shutting down');  server.close(() => process.exit(0)); });

module.exports = { server };
