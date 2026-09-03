'use strict';

// engine/torrent.js — multi-source torrent search (built-in YTS/Nyaa/TPB +
// user-added Torznab/JSON/RSS sources), Jackett/Prowlarr indexer discovery,
// and saving a chosen result to disk. Extracted verbatim from main.js (Phase
// C, 2026-08-23).
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  httpGetStream, httpGetTextStatus, fetchTextSimple, fetchJSON,
  readResponseText, downloadFile, describeNetError,
} = require('./net');
const { decodeEntities } = require('./rss');
const { log } = require('./log');
const { safeSend } = require('./bus');

// ─── IPC: TORRENT SEARCH ─────────────────────────────────────────────────────
// Each search unit is a "task" — a built-in/generic source, OR (for a Torznab
// source on the "all" endpoint) ONE task per configured indexer. The renderer
// gets the full task list up front ('torrent:searchPlan') so it can draw a chip
// per unit, then a 'torrent:siteProgress' as each finishes (with its hit count)
// so chips turn green/grey live instead of one source-chip spinning for ages.
// Extracted from the ipcMain handler so the Remote-companion dispatcher can
// run the exact same multi-source search (progress events go to `event.sender`
// same as before — the Remote dispatcher passes { sender: mainWindow.webContents }
// so a search triggered from a phone also updates the desktop UI live).
async function runTorrentSearch(event, query, config) {
  const results = [], errors = [];
  const sites   = Object.keys(config.sites).filter(s => config.sites[s].enabled);

  const tasks = [];
  for (const site of sites) {
    const cfg  = config.sites[site] || {};
    const type = resolveSiteType(site, cfg);
    if (type === 'torznab') {
      const expanded = await expandTorznabTasks(site, cfg, query, config).catch(() => null);
      if (expanded && expanded.length) { tasks.push(...expanded); continue; }
    }
    tasks.push({ label: site, run: () => searchSite(site, query, config) });
  }

  safeSend(event.sender, 'torrent:searchPlan', { labels: tasks.map(t => t.label) });
  if (!tasks.length) return { results: [], errors: ['No sites enabled'] };

  // Cap concurrency so a source with 200 indexers doesn't fire 200 requests at
  // Jackett at once; slots free as each finishes (progress stays smooth).
  await runWithConcurrency(tasks, 8, async (task) => {
    try {
      const r = await task.run();
      results.push(...r);
      safeSend(event.sender, 'torrent:siteProgress', { site: task.label, count: r.length, ok: true });
    } catch (e) {
      errors.push(`${task.label}: ${describeNetError(e)}`);
      safeSend(event.sender, 'torrent:siteProgress', { site: task.label, count: 0, ok: false });
    }
  });
  results.sort((a, b) => b.seeds - a.seeds);
  return { results, errors };
}

// Run `worker` over `items` with at most `limit` in flight at a time.
async function runWithConcurrency(items, limit, worker) {
  const queue = items.slice();
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

// Expand a Torznab "all" source into one task per configured indexer, so each
// indexer is queried independently (own progress + own timeout). Returns null
// for non-"all" URLs or when the indexer list can't be fetched / has < 2 entries
// (then the source runs as a single task via the plain aggregate).
async function expandTorznabTasks(site, cfg, query, config) {
  const base = (cfg.api || '').replace(/\/+$/, '').trim();
  if (!/\/api\/v2\.0\/indexers\/all\/results\/torznab$/i.test(base)) return null;
  const origin = (base.match(/^(https?:\/\/[^/]+)/i) || [])[1];
  if (!origin) return null;
  const jkey = cfg.apikey || await fetchJackettApiKey(origin) || readJackettApiKey();
  try { const p = await httpGetStream(`${origin}/api/v2.0/server/config`, { timeout: 4000, useSessionCookies: true }); p.resume && p.resume(); } catch {}
  let indexers = [];
  try {
    let listUrl = `${origin}/api/v2.0/indexers?configured=true`;
    if (jkey) listUrl += `&apikey=${encodeURIComponent(jkey)}`;
    const { status, body } = await httpGetTextStatus(listUrl, 8000, true);
    if (status === 200) { const d = JSON.parse(body); if (Array.isArray(d)) indexers = d.filter(i => i && i.id); }
  } catch { return null; }
  if (indexers.length < 2) return null;
  const limit = cfg.max_results || config.max_results || 5;
  return indexers.map(ix => ({
    label: `${site} | ${ix.name || ix.id}`,
    run: async () => {
      // Shorter per-indexer timeout so one slow tracker frees its slot quickly.
      const items = await torznabQuery(`${origin}/api/v2.0/indexers/${encodeURIComponent(ix.id)}/results/torznab`, jkey, query, limit, site, 35000);
      return items.map(it => ({ ...it, site: `${site} | ${ix.name || ix.id}` }));
    }
  }));
}

// Jackett exposes its own API key at /api/v2.0/server/config (this is how its
// dashboard shows it). From localhost with no admin password that's readable
// directly — far more reliable than guessing the on-disk config path.
async function fetchJackettApiKey(base) {
  try {
    const res = await httpGetStream(`${base}/api/v2.0/server/config`, { timeout: 4000 });
    if (res.statusCode !== 200) { try { res.resume && res.resume(); } catch {} return ''; }
    const cfg = JSON.parse(await readResponseText(res));
    return cfg?.api_key || cfg?.APIKey || '';
  } catch { return ''; }
}

// Best-effort read of Jackett's generated API key from its on-disk config, so a
// detected instance can be wired up automatically. Install layout varies, so we
// probe the common data-dir locations per platform.
function readJackettApiKey() {
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [ path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Jackett', 'ServerConfig.json'),
        path.join(process.env.ProgramData   || 'C:\\ProgramData',                  'Jackett', 'ServerConfig.json') ]
    : process.platform === 'darwin'
    ? [ path.join(home, '.config', 'Jackett', 'ServerConfig.json'),
        path.join(home, 'Library', 'Application Support', 'Jackett', 'ServerConfig.json') ]
    : [ path.join(home, '.config', 'Jackett', 'ServerConfig.json') ];
  for (const c of candidates) {
    try { const j = JSON.parse(fs.readFileSync(c, 'utf8')); if (j && j.APIKey) return j.APIKey; } catch { /* next */ }
  }
  return '';
}

// YTS mirror fallback list. yts.mx is the canonical/most-stable domain but
// gets blocked at the DNS/ISP level in several countries (notably Italy via
// court order). When DNS lookup fails on the user's configured endpoint, we
// transparently try the next mirror in this list. First one that resolves +
// returns valid JSON wins; the working URL is cached for the rest of the
// session so we don't pay the ENOTFOUND timeout on every search.
// Order matters: first entry is the current canonical domain, rest are
// historical mirrors kept as safety net. yts.mx is intentionally LAST — it
// went NXDOMAIN in Nov 2025 and every lookup on it just burns a DNS timeout,
// but a sibling could theoretically revive it, so we keep it as a last resort.
// yts.bz 301-redirects to the live front-end domain (Electron net follows it).
const YTS_FALLBACK_MIRRORS = [
  'https://yts.bz/api/v2',
  'https://yts.lt/api/v2',
  'https://yts.am/api/v2',
  'https://yts.rs/api/v2',
  'https://yts.mx/api/v2'
];
let _ytsWorkingMirror = null;  // session cache

async function fetchYtsWithFallback(pathQuery, configuredApi, configMirrors) {
  // Try the user's configured api first (so custom mirrors set via Settings
  // are honoured), then walk the fallback list. Skip duplicates. The fallback
  // list comes from config (`yts_mirrors`) so a domain change is a config edit,
  // not a code change; the hardcoded constant is the last-resort default.
  const mirrors = Array.isArray(configMirrors) && configMirrors.length
    ? configMirrors : YTS_FALLBACK_MIRRORS;
  const candidates = [];
  if (_ytsWorkingMirror) candidates.push(_ytsWorkingMirror);  // session-cached hit
  if (configuredApi && !candidates.includes(configuredApi)) candidates.push(configuredApi);
  for (const m of mirrors) if (!candidates.includes(m)) candidates.push(m);
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
        // Electron's net module reports failures as net::ERR_* strings, NOT the
        // libuv codes above. Without these, a dead mirror (e.g. yts.mx →
        // net::ERR_NAME_NOT_RESOLVED) throws instead of walking to the next
        // mirror — which was exactly the "YTS: net::ERR_NAME_NOT_RESOLVED" bug.
        /net::ERR_(NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|CONNECTION_\w+|TIMED_OUT|ADDRESS_UNREACHABLE|NETWORK_CHANGED|INTERNET_DISCONNECTED|CERT_\w+|HTTP2_\w+|EMPTY_RESPONSE)/i.test(msg) ||
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

// A torrent source is dispatched by its DESCRIPTOR TYPE, not its name. The
// three built-in sources (YTS / Nyaa / TPB) have bespoke handlers; any other
// source declares a generic type — 'torznab' (Jackett / Prowlarr), 'json', or
// 'rss' — so users can wire up new trackers from the UI without code changes.
// Legacy custom sources (added before types existed) carry no type and were
// never actually functional (they hit the old `default: return []`), so a
// missing type on a non-built-in name still resolves to null → skipped.
function resolveSiteType(site, siteCfg) {
  if (siteCfg.type) return String(siteCfg.type).toLowerCase();
  switch (site.toUpperCase()) {
    case 'YTS':  return 'yts';
    case 'NYAA': return 'nyaa';
    case 'TPB':  return 'apibay';
    default:     return null;
  }
}

async function searchSite(site, query, config) {
  const siteCfg = config.sites[site] || {};
  const limit   = siteCfg.max_results || config.max_results || 5;
  const encoded = encodeURIComponent(query);
  const type    = resolveSiteType(site, siteCfg);

  switch (type) {
    case 'yts': {
      const data = await fetchYtsWithFallback(
        `/list_movies.json?query_term=${encoded}&limit=${limit}&sort_by=seeds`,
        siteCfg.api,
        siteCfg.mirrors
      );
      if (data?.status !== 'ok' || !data?.data?.movies) return [];
      const out = [];
      for (const movie of data.data.movies)
        for (const t of (movie.torrents || []))
          out.push({ name: `${movie.title} (${movie.year}) [${t.quality}]`, seeds: +t.seeds||0, leeches: +t.peers||0, size: t.size||'N/A', url: t.url, magnet: null, type: 'torrent', site: 'YTS' });
      return out.sort((a,b) => b.seeds-a.seeds).slice(0, limit);
    }
    case 'nyaa': {
      const api = siteCfg.api || 'https://nyaa.si';
      return parseNyaaRSS(await fetchTextSimple(`${api}/?page=rss&q=${encoded}&c=0_0&f=0`), limit);
    }
    // 1337x removed — no working public endpoint. Users can now reach it (and
    // 500+ other trackers) via a 'torznab' source pointed at Jackett/Prowlarr.
    case 'apibay': {
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
        return { name: i.name||'Unknown', seeds: +i.seeders||0, leeches: +i.leechers||0, size: i.size?`${(+i.size/1048576).toFixed(2)} MB`:'N/A', url: null, magnet: mag, type: 'magnet', site };
      }).sort((a,b)=>b.seeds-a.seeds);
    }
    // Generic sources try the primary `api` then any user-set `mirrors` in
    // order, so a source that hops domains (or has a flaky host) fails over the
    // same way YTS does — without any source-specific code.
    case 'torznab': return withMirrors(siteCfg, base => searchTorznab(site, siteCfg, query, limit, base));
    case 'json':    return withMirrors(siteCfg, base => searchGenericJSON(site, siteCfg, query, limit, base));
    case 'rss':     return withMirrors(siteCfg, base => searchGenericRSS(site, siteCfg, query, limit, base));
    default:
      log('WARN', `Torrent source "${site}" has no recognised type — skipped`);
      return [];
  }
}

// Try `fn(base)` against the source's primary api first, then each mirror in
// order; return the first call that doesn't throw (an empty result set counts
// as success — only a thrown network/HTTP error advances to the next base).
async function withMirrors(siteCfg, fn) {
  const bases = [siteCfg.api, ...(Array.isArray(siteCfg.mirrors) ? siteCfg.mirrors : [])]
    .map(b => (b || '').trim()).filter(Boolean);
  const seen = new Set();
  let lastErr = null, tried = 0;
  for (const base of bases) {
    if (seen.has(base)) continue;
    seen.add(base); tried++;
    try { return await fn(base); }
    catch (e) { lastErr = e; log('WARN', `source base ${base} failed (${e.message}) — trying next`); }
  }
  if (!tried) return [];
  throw lastErr || new Error('All source URLs unreachable');
}

// ─── GENERIC TORRENT SOURCE ADAPTERS (Torznab / JSON / RSS) ──────────────────
// These let a user add any tracker from Settings › Sources without shipping a
// bespoke handler. Torznab is the headline: point it at a self-hosted Jackett
// or Prowlarr instance and you inherit its 500+ community-maintained scrapers
// (Cloudflare handling included) behind one uniform query API.

function formatBytes(n) {
  n = +n; if (!n || n < 0) return 'N/A';
  const u = ['B','KB','MB','GB','TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 2 : 0)} ${u[i]}`;
}

// Dot-path getter: getPath(obj, 'data.results') → obj.data.results (null-safe).
function getPath(obj, p) {
  if (!p) return obj;
  return String(p).split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

// Read a field from a result item: honour an explicit mapping path if given,
// else probe a list of conventional field names. Returns '' when nothing hits.
function pickField(item, mapped, fallbacks) {
  if (mapped) { const v = getPath(item, mapped); if (v != null && v !== '') return v; }
  for (const k of fallbacks) if (item[k] != null && item[k] !== '') return item[k];
  return '';
}

// Substitute {query} / {limit} placeholders in a URL template. If the template
// carries no {query}, the query is appended as ?q= / &q= for convenience.
function fillSourceUrl(tpl, query, limit) {
  const enc = encodeURIComponent(query);
  if (/\{query\}/i.test(tpl))
    return tpl.replace(/\{query\}/gi, enc).replace(/\{limit\}/gi, String(limit));
  return `${tpl}${tpl.includes('?') ? '&' : '?'}q=${enc}`;
}

// One Torznab query against a fully-built base endpoint → parsed items. Handles
// Jackett's cookie gate and surfaces a clean <error> message (Jackett stuffs a
// whole .NET stack trace into the description, so keep only its first line).
async function torznabQuery(base, apikey, query, limit, site, timeout = 90000) {
  base = base.replace(/\/+$/, '');
  if (/\/results\/torznab$/i.test(base)) base += '/api';   // Jackett feed needs /api
  const isJackett = /\/api\/v2\.0\/indexers\//i.test(base);
  const sep = base.includes('?') ? '&' : '?';
  let url = `${base}${sep}t=search&q=${encodeURIComponent(query)}&limit=${limit}`;
  if (apikey) url += `&apikey=${encodeURIComponent(apikey)}`;
  let body;
  if (isJackett) {
    // Jackett requires a session cookie even on torznab; prime + share the jar.
    const origin = (base.match(/^(https?:\/\/[^/]+)/i) || [])[1];
    if (origin) { try { const p = await httpGetStream(`${origin}/api/v2.0/server/config`, { timeout: 4000, useSessionCookies: true }); p.resume && p.resume(); } catch {} }
    // The aggregate ("all") waits for every indexer, so it gets a generous
    // default; per-indexer callers pass a shorter timeout to free slow slots.
    const res = await httpGetTextStatus(url, timeout, true);
    body = res.body;
    if (res.status !== 200 && !/<rss|<error/i.test(body)) throw new Error(`HTTP ${res.status}`);
  } else {
    body = await fetchTextSimple(url);
  }
  const errM = body.match(/<error[^>]*\bdescription=["']([^"']+)["']/i);
  if (errM) {
    let desc = decodeEntities(errM[1].split(/ ---> |&#x[0-9a-f]+;|\r|\n/i)[0]).replace(/^[\w.]+Exception:\s*/i, '').trim();
    if (/challenge detected|cloudflare/i.test(desc))
      desc += ' — this tracker is behind Cloudflare; add a FlareSolverr instance in Jackett (Settings → FlareSolverr API URL) to scrape it.';
    throw new Error(desc);
  }
  return parseTorznabXML(body, limit, site);
}

async function searchTorznab(site, siteCfg, query, limit, baseOverride) {
  const base = (baseOverride || siteCfg.api || '').replace(/\/+$/, '').trim();
  if (!base) return [];
  // Jackett's "all" aggregate already runs every configured indexer, skips the
  // ones that fail (Cloudflare, timeout…), returns the survivors, and tags each
  // item with its originating indexer — so a single query is resilient AND
  // labelled. No client-side fan-out needed. (parseTorznabXML reads the tag.)
  return torznabQuery(base, siteCfg.apikey || '', query, limit, site);
}

function parseTorznabXML(xml, limit, site) {
  try {
    const items = [];
    for (const block of (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [])) {
      const tagVal = t => { const m = block.match(new RegExp(`<${t}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${t}>|<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')); return m ? (m[1] || m[2] || '').trim() : ''; };
      const attr   = n => { const m = block.match(new RegExp(`<torznab:attr[^>]*name=["']${n}["'][^>]*value=["']([^"']*)["']`, 'i')); return m ? m[1] : ''; };
      const title  = decodeEntities(tagVal('title'));
      if (!title) continue;
      const enclM   = block.match(/<enclosure[^>]*\burl=["']([^"']+)["']/i);
      const cand    = decodeEntities((enclM && enclM[1]) || tagVal('link') || '');
      let magnet = null, url = null;
      if (/^magnet:/i.test(cand)) magnet = cand; else if (cand) url = cand;
      const infohash = attr('infohash') || attr('infoHash');
      if (!magnet && infohash) magnet = `magnet:?xt=urn:btih:${infohash}&dn=${encodeURIComponent(title)}`;
      if (!magnet && !url) continue;
      const seeds   = +attr('seeders') || 0;
      const leechRaw = attr('leechers'), peers = +attr('peers') || 0;
      const leeches = leechRaw !== '' ? +leechRaw : Math.max(0, peers - seeds);
      const lenM    = block.match(/<enclosure[^>]*\blength=["'](\d+)["']/i);
      const sizeB   = +(attr('size') || tagVal('size') || (lenM && lenM[1]) || 0);
      // Jackett/Prowlarr tag each item with its originating indexer; surface it
      // in the site label ("test | 1337x") so the UI shows which tracker hit.
      const idxM    = block.match(/<(?:jackettindexer|prowlarrindexer)[^>]*>([\s\S]*?)<\/(?:jackettindexer|prowlarrindexer)>/i);
      const idxName = idxM ? decodeEntities(idxM[1].trim()) : '';
      const label   = idxName ? `${site} | ${idxName}` : site;
      items.push({ name: title, seeds, leeches, size: formatBytes(sizeB), url: magnet ? null : url, magnet, type: magnet ? 'magnet' : 'torrent', site: label });
    }
    return items.sort((a, b) => b.seeds - a.seeds).slice(0, limit);
  } catch (e) { log('ERROR', `Torznab (${site}): ${e.message}`); return []; }
}

async function searchGenericJSON(site, siteCfg, query, limit, baseOverride) {
  const tpl = (baseOverride || siteCfg.api || '').trim();
  if (!tpl) return [];
  const data = await fetchJSON(fillSourceUrl(tpl, query, limit));
  const map  = siteCfg.mapping || {};
  const arr  = map.path
    ? getPath(data, map.path)
    : (Array.isArray(data) ? data : (data.results || data.data || data.items || data.torrents || []));
  if (!Array.isArray(arr)) return [];
  const out = arr.slice(0, limit).map(it => {
    const name     = String(pickField(it, map.name, ['name', 'title']) || 'Unknown');
    const infohash = pickField(it, map.infohash, ['infohash', 'info_hash', 'hash', 'btih']);
    let   magnet   = pickField(it, map.magnet, ['magnet', 'magnet_uri', 'magnetUrl', 'magnetLink']) || null;
    const url      = pickField(it, map.url, ['url', 'link', 'torrent', 'torrent_url', 'download']) || null;
    if (!magnet && infohash) magnet = `magnet:?xt=urn:btih:${infohash}&dn=${encodeURIComponent(name)}&tr=udp://tracker.opentrackr.org:1337`;
    const seeds    = +pickField(it, map.seeds, ['seeds', 'seeders', 'seeder']) || 0;
    const leeches  = +pickField(it, map.leeches, ['leeches', 'leechers', 'peers', 'peer']) || 0;
    const rawSize  = pickField(it, map.size, ['size', 'filesize', 'size_bytes', 'sizebytes']);
    const size     = rawSize === '' ? 'N/A' : (/^\d+$/.test(String(rawSize)) ? formatBytes(+rawSize) : String(rawSize));
    return { name, seeds, leeches, size, url: magnet ? null : url, magnet, type: magnet ? 'magnet' : 'torrent', site };
  }).filter(x => x.magnet || x.url);
  return out.sort((a, b) => b.seeds - a.seeds);
}

async function searchGenericRSS(site, siteCfg, query, limit, baseOverride) {
  const tpl = (baseOverride || siteCfg.api || '').trim();
  if (!tpl) return [];
  const xml = await fetchTextSimple(fillSourceUrl(tpl, query, limit));
  const map = siteCfg.mapping || {};
  try {
    const items = [];
    for (const block of (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []).slice(0, limit)) {
      const tagVal = t => { const m = block.match(new RegExp(`<${t}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${t}>|<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')); return m ? (m[1] || m[2] || '').trim() : ''; };
      const title  = decodeEntities(tagVal('title'));
      if (!title) continue;
      const magM   = block.match(/magnet:\?xt=urn:btih:[^<"'\s&]+(?:&[^<"'\s]+)*/i);
      const magnet = magM ? decodeEntities(magM[0]) : null;
      const enclM  = block.match(/<enclosure[^>]*\burl=["']([^"']+)["']/i);
      const url    = magnet ? null : decodeEntities((enclM && enclM[1]) || tagVal('link') || '') || null;
      if (!magnet && !url) continue;
      const seeds   = +(map.seeds   ? tagVal(map.seeds)   : (tagVal('seeders')  || tagVal('seeds'))) || 0;
      const leeches = +(map.leeches ? tagVal(map.leeches) : (tagVal('leechers') || tagVal('peers'))) || 0;
      const lenM    = block.match(/<enclosure[^>]*\blength=["'](\d+)["']/i);
      const rawSize = (map.size ? tagVal(map.size) : tagVal('size')) || (lenM && lenM[1]) || '';
      const size    = rawSize === '' ? 'N/A' : (/^\d+$/.test(String(rawSize)) ? formatBytes(+rawSize) : String(rawSize));
      items.push({ name: title, seeds, leeches, size, url, magnet, type: magnet ? 'magnet' : 'torrent', site });
    }
    return items.sort((a, b) => b.seeds - a.seeds);
  } catch (e) { log('ERROR', `RSS source (${site}): ${e.message}`); return []; }
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

// Detect a locally-running Jackett or Prowlarr by probing their default ports.
// ANY HTTP response (even 401) means the service is up; only a refused/failed
// connection means it's absent. For Jackett we pull the API key straight from
// its config endpoint (fallback: on-disk file) so the source auto-configures.
// Moved here (from main.js's torznab:detect IPC handler) so server.js's REST
// endpoint can share the same logic (Phase C, 2026-08-23).
async function detectJackettOrProwlarr() {
  const targets = [
    { flavor: 'jackett',  base: 'http://127.0.0.1:9117', probe: '/api/v2.0/server/config', torznab: '/api/v2.0/indexers/all/results/torznab' },
    { flavor: 'prowlarr', base: 'http://127.0.0.1:9696', probe: '/api/v1/health',           torznab: '' }
  ];
  for (const tg of targets) {
    try {
      const res = await httpGetStream(tg.base + tg.probe, { timeout: 2000 });
      try { res.resume && res.resume(); } catch {}
      const apikey = tg.flavor === 'jackett'
        ? (await fetchJackettApiKey(tg.base) || readJackettApiKey())
        : '';
      return { ok: true, flavor: tg.flavor, base: tg.base, url: tg.base + tg.torznab, apikey };
    } catch { /* connection refused → not running; try next target */ }
  }
  return { ok: false, platform: process.platform, arch: process.arch };
}

// Torznab indexer picker — list the indexers already configured in the user's
// Jackett or Prowlarr instance so they can target a single tracker instead of
// the "all" aggregate. Detects flavour from the URL shape; the API key is
// passed as a query param (both servers accept ?apikey=), so no custom headers.
// Moved here (from main.js's torrent:listIndexers IPC handler), same reason
// as detectJackettOrProwlarr above.
async function listTorznabIndexers(url, apikey) {
  const raw = String(url || '').trim();
  if (!raw) return { ok: false, error: 'Enter the Torznab URL first' };
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: 'Invalid URL' }; }
  const origin = `${u.protocol}//${u.host}`;
  const key    = apikey ? String(apikey).trim() : '';

  // Jackett — recognised by its /api/v2.0/indexers path. Its indexers endpoint
  // REQUIRES the API key (returns 400 without it), so fetch it from the config
  // endpoint when the caller didn't pass one. Per-indexer Torznab endpoint is
  // {base}/api/v2.0/indexers/{id}/results/torznab.
  const jIdx = raw.indexOf('/api/v2.0/indexers');
  if (jIdx !== -1) {
    const base = raw.slice(0, jIdx);
    const jkey = key || await fetchJackettApiKey(base) || readJackettApiKey();
    // Jackett's indexers endpoint rejects requests with no session cookie
    // ("Cookies required"). Prime the cookie with a plain GET first, sharing
    // the session jar (useSessionCookies), then the list request carries it.
    try { const p = await httpGetStream(`${base}/api/v2.0/server/config`, { timeout: 4000, useSessionCookies: true }); p.resume && p.resume(); } catch {}
    let listUrl = `${base}/api/v2.0/indexers?configured=true`;
    if (jkey) listUrl += `&apikey=${encodeURIComponent(jkey)}`;
    const { status, body } = await httpGetTextStatus(listUrl, 8000, true);
    if (status !== 200) {
      const hint = !jkey ? ' — no API key found; paste your Jackett API key (top-right of its dashboard)' : '';
      return { ok: false, error: `Jackett HTTP ${status}${body ? ': ' + body.slice(0, 140) : ''}${hint}` };
    }
    let data; try { data = JSON.parse(body); } catch { return { ok: false, error: 'Jackett returned non-JSON' }; }
    if (!Array.isArray(data)) return { ok: false, error: 'Unexpected Jackett response' };
    const indexers = data.filter(i => i && (i.id || i.name)).map(i => ({
      id: i.id, name: i.name || i.id,
      torznab: `${base}/api/v2.0/indexers/${i.id}/results/torznab`
    }));
    return { ok: true, flavor: 'jackett', indexers, apikey: jkey };
  }

  // Prowlarr — v1 indexer list on the same host. Per-indexer Torznab endpoint
  // is {origin}/{id}/api (apikey stored separately on the FLUX source).
  let listUrl = `${origin}/api/v1/indexer`;
  if (key) listUrl += `?apikey=${encodeURIComponent(key)}`;
  const { status, body } = await httpGetTextStatus(listUrl);
  if (status !== 200) {
    const hint = !key ? ' — paste your Prowlarr API key (Settings › General)' : '';
    return { ok: false, error: `Prowlarr HTTP ${status}${body ? ': ' + body.slice(0, 140) : ''}${hint}` };
  }
  let data; try { data = JSON.parse(body); } catch { return { ok: false, error: 'Prowlarr returned non-JSON' }; }
  if (!Array.isArray(data)) return { ok: false, error: 'Unexpected Prowlarr response' };
  const indexers = data.filter(i => i && (i.id != null || i.name)).map(i => ({
    id: i.id, name: i.name || String(i.id),
    torznab: `${origin}/${i.id}/api`
  }));
  return { ok: true, flavor: 'prowlarr', indexers };
}

module.exports = {
  runTorrentSearch, runWithConcurrency, expandTorznabTasks,
  fetchJackettApiKey, readJackettApiKey, fetchYtsWithFallback,
  resolveSiteType, searchSite, withMirrors,
  torznabQuery, searchTorznab, parseTorznabXML,
  searchGenericJSON, searchGenericRSS, parseNyaaRSS,
  formatBytes, saveTorrentItem,
  detectJackettOrProwlarr, listTorznabIndexers,
  // Only torznab:detect declared here — search/save/listIndexers each have
  // REST-only input validation (400 on missing query/item) not present on
  // the IPC side, see .claude/plans's Fase G Step 1 notes.
  routes: [
    { channel: 'torznab:detect', method: 'GET', path: '/api/torznab/detect', fn: 'detectJackettOrProwlarr', args: () => [] },
  ],
};
