'use strict';

// engine/radio.js — internet radio: RadioBrowser search/metadata (pure REST
// API, community-mirrored) + ICY (Shoutcast/Icecast) "now playing" metadata
// watcher (a second HTTP connection to the stream that discards audio bytes
// and parses the interleaved title blocks). Extracted verbatim from main.js
// (Fase G, Step 2, 2026-08-26) — zero Electron dependency; `radio` isn't
// even its own registry module, its tabs belong to `media` (already
// server-enabled since Fase C).
const { fetchJSONWithUA, describeNetError } = require('./net');
const { log } = require('./log');
const { safeSend } = require('./bus');

async function radioSearch({ name, country, tag, language, limit = 30 } = {}) {
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
    const url = `https://de1.api.radio-browser.info/json/stations/search?${params.toString()}`;
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

// ICY metadata watcher. Emits `radio:icyMeta` (via the shared bus.safeSend,
// so a live IPC sender OR the SSE broadcast sender both work) each time the
// StreamTitle changes.
const activeIcyClients = new Map(); // uuid -> ClientRequest

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

function startIcyWatchRoute({ uuid, url }, sender) {
  stopIcyWatch(uuid);
  startIcyWatch(uuid, url, sender);
  return { ok: true };
}

function stopIcyWatchRoute({ uuid }) {
  stopIcyWatch(uuid);
  return { ok: true };
}

module.exports = {
  radioSearch, radioMeta, startIcyWatch, stopIcyWatch,
  routes: [
    { channel: 'radio:search',        method: 'GET',  path: '/api/radio/search',    fn: 'radioSearch', args: body => [body] },
    { channel: 'radio:countries',     method: 'GET',  path: '/api/radio/countries', fn: 'radioMeta',   args: () => ['countries'] },
    { channel: 'radio:tags',          method: 'GET',  path: '/api/radio/tags',      fn: 'radioMeta',   args: () => ['tags', 200] },
    { channel: 'radio:languages',     method: 'GET',  path: '/api/radio/languages', fn: 'radioMeta',   args: () => ['languages', 200] },
    { channel: 'radio:startIcyWatch', method: 'POST', path: '/api/radio/startIcyWatch', fn: 'startIcyWatchRoute', args: (body, sender) => [body, sender] },
    { channel: 'radio:stopIcyWatch',  method: 'POST', path: '/api/radio/stopIcyWatch',  fn: 'stopIcyWatchRoute',  args: body => [body] },
  ],
  // internal, not exported as public API but referenced by routes[] above via string name
  startIcyWatchRoute, stopIcyWatchRoute,
};
