'use strict';

// engine/sendto.js — forward torrents to qBittorrent/Transmission, or .nzb
// files to SABnzbd/NZBGet, instead of downloading inside FLUX. Extracted
// verbatim from main.js (Phase C, 2026-08-23). Uses only Node core (fs,
// path) + the global fetch/FormData/Blob (Node 18+) — no Electron API.
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');

// Forward a local .nzb file to an existing Usenet client. SABnzbd takes the
// raw NZB body via multipart; NZBGet takes a base64-encoded payload via
// JSON-RPC. Both support a "category" hint for routing.
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

// `filePath` lets History/Downloads resend a previously-saved .torrent/.magnet
// file (no magnet/URL kept around from that point on) — a .magnet file is
// just its magnet URI as text, a .torrent file needs an actual upload
// (qBittorrent: multipart field; Transmission: base64 metainfo), not a link.
async function sendToTorrentClient({ magnet, url: torrentUrl, filePath, name, test } = {}) {
  const cfg = loadConfig();
  if (!cfg.sendto_enabled && !test) return { ok: false, error: 'send-to-client disabled' };
  const baseUrl = (cfg.sendto_url || '').replace(/\/+$/, '');
  if (!baseUrl) return { ok: false, error: 'sendto_url not configured' };

  let link = magnet || torrentUrl;
  let fileBuffer = null;
  if (!link && filePath) {
    try {
      if (/\.magnet$/i.test(filePath)) link = fs.readFileSync(filePath, 'utf8').trim();
      else fileBuffer = fs.readFileSync(filePath);
    } catch (e) {
      return { ok: false, error: `Impossibile leggere il file: ${e.message}` };
    }
  }
  if (!test && !link && !fileBuffer) return { ok: false, error: 'no magnet / URL / file to send' };

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
      let addRes;
      if (fileBuffer) {
        const formData = new FormData();
        formData.append('torrents', new Blob([fileBuffer]), path.basename(filePath));
        if (cfg.sendto_category) formData.append('category', cfg.sendto_category);
        addRes = await fetch(`${baseUrl}/api/v2/torrents/add`, {
          method: 'POST',
          headers: cookie ? { 'Cookie': cookie, 'Referer': baseUrl } : { 'Referer': baseUrl },
          body: formData
        });
      } else {
        const formBody = new URLSearchParams({ urls: link });
        if (cfg.sendto_category) formBody.set('category', cfg.sendto_category);
        const addHeaders = { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': baseUrl };
        if (cookie) addHeaders['Cookie'] = cookie;
        addRes = await fetch(`${baseUrl}/api/v2/torrents/add`, { method: 'POST', headers: addHeaders, body: formBody });
      }
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
      const args = fileBuffer
        ? { metainfo: fileBuffer.toString('base64'), 'download-dir': cfg.sendto_category || undefined }
        : { filename: link, 'download-dir': cfg.sendto_category || undefined };
      const addRes = await fetch(rpcUrl, {
        method: 'POST',
        headers: { ...baseHeaders, 'X-Transmission-Session-Id': sid },
        body: JSON.stringify({ method: 'torrent-add', arguments: args })
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

module.exports = {
  sendNzbFromFile, sendToTorrentClient,
  routes: [
    { channel: 'sendto:torrent', method: 'POST', path: '/api/sendto/torrent',
      fn: 'sendToTorrentClient', args: body => [body || {}] },
    { channel: 'sendto:test',    method: 'POST', path: '/api/sendto/test',
      fn: 'sendToTorrentClient', args: () => [{ test: true }] },
    { channel: 'sendnzb:fromFile', method: 'POST', path: '/api/sendnzb/fromFile',
      fn: 'sendNzbFromFile', args: body => [body || {}] },
    { channel: 'sendnzb:test',     method: 'POST', path: '/api/sendnzb/test',
      fn: 'sendNzbFromFile', args: () => [{ test: true }] },
  ],
};
