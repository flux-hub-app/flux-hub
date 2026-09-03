'use strict';

// engine/net.js — HTTP helpers shared by engine/torrent.js and engine/rss.js.
// Extracted verbatim from main.js (Phase C, 2026-08-19): every function here
// already preferred Electron's `net` (OS cert store + system proxy — critical
// behind corporate TLS-intercepting proxies) with a graceful fallback to
// Node's own `http`/`https` when Electron isn't available (`require('electron')`
// resolves to a plain string outside the Electron runtime, so `.net` is
// `undefined` and the fallback branch runs untouched — no try/catch needed
// around the fallback itself, only around the `require('electron')` call).
//
// Known limitation carried over unchanged from before this extraction (NOT
// introduced by it): the SOCKS5 proxy set in Settings only covers the
// Electron-net path (via `session.defaultSession.setProxy`, desktop-only) and
// the undici/global-fetch path (`applyGlobalProxy`'s dispatcher, still in
// main.js) — the plain http/https fallback used here when Electron is absent,
// and `fetchTextSimple`/`downloadFile` always, are NOT proxied, on desktop or
// headless. Flagged for a future dedicated fix (inject the same SOCKS agent
// into these fallback paths); out of scope for this extraction.

// Low-level GET that prefers Electron's `net` (Chromium network stack → OS
// certificate store + system proxy). Resolves to a Node-stream-like response
// ({ statusCode, headers, on('data'|'end'|'error') }).
function httpGetStream(url, { ua = 'FLUX/1.0.0', accept, timeout = 15000, useSessionCookies = false, _redirects = 0 } = {}) {
  let electronNet = null;
  try { electronNet = require('electron').net; } catch { /* not in Electron */ }
  if (electronNet) {
    return new Promise((resolve, reject) => {
      // useSessionCookies makes net share the app session's cookie jar, so a
      // cookie set by one request is sent on the next — needed for Jackett's
      // indexers endpoint, which rejects requests without a session cookie.
      const req = electronNet.request({ url, redirect: 'follow', useSessionCookies });
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

// Text sibling of fetchJSONWithUA — same Electron net preference, returns the
// raw body (HTML/JS). Used by the SoundCloud client_id scraper.
async function httpGetText(url, { ua = 'FLUX/1.0.0', accept = 'text/html', timeout = 15000 } = {}) {
  const res = await httpGetStream(url, { ua, accept, timeout });
  return new Promise((resolve, reject) => {
    if (res.statusCode !== 200) { try { res.resume && res.resume(); } catch {} return reject(new Error(`HTTP ${res.statusCode}`)); }
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => resolve(d));
    res.on('error', reject);
  });
}

// POST counterpart of fetchJSONWithUA — same Electron `net` preference (OS
// cert store + system proxy). Needed by APIs that only accept POST bodies
// (YouTube's Innertube endpoint).
function httpPostJSON(url, body, { ua = 'FLUX/1.0.0', timeout = 15000 } = {}) {
  const payload = JSON.stringify(body);
  let electronNet = null;
  try { electronNet = require('electron').net; } catch { /* not in Electron */ }
  return new Promise((resolve, reject) => {
    const readBody = res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(d)); } catch { reject(new Error(`Invalid JSON: ${d.substring(0, 80)}`)); }
      });
      res.on('error', reject);
    };
    if (electronNet) {
      const req = electronNet.request({ url, method: 'POST', redirect: 'follow' });
      req.setHeader('User-Agent', ua);
      req.setHeader('Content-Type', 'application/json');
      const timer = setTimeout(() => { try { req.abort(); } catch {} reject(new Error('Timeout')); }, timeout);
      req.on('response', res => { clearTimeout(timer); readBody(res); });
      req.on('error', e => { clearTimeout(timer); reject(e); });
      req.write(payload);
      req.end();
    } else {
      const mod = url.startsWith('https') ? require('https') : require('http');
      const req = mod.request(url, {
        method: 'POST', timeout,
        headers: { 'User-Agent': ua, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, readBody);
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(payload);
      req.end();
    }
  });
}

// Drain a response stream to text, resolving even on a mid-stream error so a
// non-200 body (e.g. Jackett's 400 explanation) is still captured for surfacing.
function readResponseText(res) {
  return new Promise(resolve => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end',   () => resolve(d));
    res.on('error', () => resolve(d));
  });
}

// GET a URL and return { status, body } as text, capturing the body regardless
// of status code so callers can surface a server's error explanation.
async function httpGetTextStatus(url, timeout = 8000, useSessionCookies = false) {
  const res = await httpGetStream(url, { timeout, useSessionCookies });
  const status = res.statusCode;
  const body = await readResponseText(res);
  return { status, body };
}

function describeNetError(e) {
  const m = e?.message || String(e);
  if (/ECONNREFUSED.*127\.0\.0\.1/.test(m))            return `Domain resolves to localhost — check hosts file or DNS (${m})`;
  if (/ENOTFOUND|net::ERR_NAME_(NOT_RESOLVED|RESOLUTION_FAILED)/i.test(m)) return `DNS lookup failed — site domain is down or blocked (${m})`;
  if (/ETIMEDOUT|Timeout|net::ERR_TIMED_OUT/i.test(m)) return `Connection timed out — server slow or unreachable`;
  if (/net::ERR_CONNECTION_\w+/i.test(m))              return `Connection failed — server unreachable (${m})`;
  if (/HTTP 5\d\d/.test(m))                 return `Server error (${m})`;
  if (/HTTP 4\d\d/.test(m))                 return `Bad request / not found (${m})`;
  return m;
}

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

// signature (url, timeout). Deliberately plain http/https, NOT httpGetStream —
// used for RSS feed bodies and misc text fetches that don't need the Jackett
// cookie-jar behavior. See the module-level proxy-coverage note above.
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
  const fs = require('fs');
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
    req.on('error', e => { fs.unlink(dest, () => {}); reject(e); });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

module.exports = {
  httpGetStream, fetchJSONWithUA, httpGetText, httpPostJSON,
  readResponseText, httpGetTextStatus, describeNetError,
  fetchJSON, fetchTextSimple, downloadFile,
};
