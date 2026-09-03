'use strict';

// engine/identify.js — music recognition: Shazam (no key, unofficial API)
// and AcoustID (user key, fpcalc fingerprint + MusicBrainz-backed lookup).
// Extracted verbatim from main.js (Fase G, Step 2, 2026-08-26).
//
// The mic-capture buffer (WebM/Opus from the browser's own MediaRecorder —
// navigator.mediaDevices.getUserMedia is a standard Web API, not an Electron
// one) reaches here identically from both transports: IPC's structured
// clone hands over an ArrayBuffer, server.js's binary-body route (see
// engine/wire-rest.js's `route.binary` + renderer/api-http.js's POSTBIN)
// hands over a Buffer — `Buffer.from(buffer)` below normalises either.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const enginePaths = require('./paths');
const { log } = require('./log');
const { getFpcalcPath, getFfmpegPath } = require('./binaries');

// AcoustID returns 400 + JSON error body when the key is wrong or the
// fingerprint is malformed — a plain fetch that reads the body regardless
// of HTTP status, since the shared fetchJSONWithUA (engine/net.js) throws
// on non-200 and swallows the body.
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

async function acoustidLookup(fingerprint, duration, apiKey) {
  const params = new URLSearchParams({
    format:      'json',
    client:      apiKey,
    meta:        'recordings+releasegroups+compress',
    duration:    String(Math.round(duration)),
    fingerprint: fingerprint
  });
  const url = `https://api.acoustid.org/v2/lookup?${params.toString()}`;
  const r = await fetchAnyStatusJSON(url, 'FLUX/1.0.0', 20000);
  const data = r.body;
  if (!data) {
    return { ok: false, error: `AcoustID returned HTTP ${r.status} (no body)` };
  }
  if (data.status !== 'ok') {
    return { ok: false, error: data.error?.message || `AcoustID error (HTTP ${r.status})` };
  }
  const results = (data.results || []).filter(res => res.recordings && res.recordings.length);
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

// ─── SHAZAM (default, no API key) ──────────────────────────────────────────
// node-shazam uses shazamio-core (WASM port of the Rust fingerprinter) + a
// HTTP POST to amp.shazam.com — no auth, no key. Unofficial API → may break
// if Shazam changes endpoints; fails gracefully when that happens.
async function shazamIdentifyFromBuffer(buffer) {
  try {
    if (!buffer || !buffer.byteLength) return { ok: false, error: 'Empty microphone capture' };
    const tempFile = path.join(enginePaths.getPaths().userData, `.identify-shazam-${Date.now()}.webm`);
    fs.writeFileSync(tempFile, Buffer.from(buffer));
    log('INFO', `shazam: mic capture ${buffer.byteLength} bytes -> ${tempFile}`);

    // node-shazam's to_pcm.cjs calls `fluent_ffmpeg.setFfmpegPath(installerPath)`
    // at MODULE LOAD time, pointing at @ffmpeg-installer's bundled binary. We
    // removed that binary from the package (~100 MB saved) and override
    // fluent-ffmpeg's stored path with our vendor/ffmpeg right after node-shazam
    // loads — both libs share the same fluent-ffmpeg instance.
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
}

// ─── ACOUSTID (user-provided key) ──────────────────────────────────────────
async function acoustidValidateKey({ apiKey } = {}) {
  if (!apiKey || !apiKey.trim()) return { ok: false, error: 'Empty key' };
  try {
    // /v2/lookup validates the client key BEFORE the fingerprint, so a bad
    // key always returns "invalid API key" even with a placeholder fingerprint.
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
}

async function acoustidIdentifyFromBuffer(buffer, apiKey) {
  try {
    const fpcalc = getFpcalcPath();
    if (!fpcalc) return { ok: false, error: 'fpcalc binary not bundled — rebuild FLUX' };
    if (!apiKey) return { ok: false, error: 'AcoustID API key not configured' };
    if (!buffer || !buffer.byteLength) return { ok: false, error: 'Empty microphone capture' };

    const tempFile = path.join(enginePaths.getPaths().userData, `.identify-mic-${Date.now()}.webm`);
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
}

// Capture 15s of a live stream, fingerprint with fpcalc, query AcoustID.
async function acoustidIdentify({ streamUrl, apiKey } = {}) {
  try {
    const fpcalc = getFpcalcPath();
    if (!fpcalc) return { ok: false, error: 'fpcalc binary not bundled — rebuild FLUX' };
    if (!apiKey) return { ok: false, error: 'AcoustID API key not configured — open Settings' };
    if (!streamUrl) return { ok: false, error: 'No stream playing' };

    const tempFile = path.join(enginePaths.getPaths().userData, `.identify-${Date.now()}.bin`);
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
}

function acoustidStatus() {
  return { fpcalcAvailable: !!getFpcalcPath() };
}

module.exports = {
  shazamIdentifyFromBuffer, acoustidValidateKey, acoustidIdentifyFromBuffer,
  acoustidIdentify, acoustidStatus, acoustidLookup,
  routes: [
    { channel: 'shazam:identifyFromBuffer', method: 'POST', path: '/api/identify/shazamBuffer',
      fn: 'shazamIdentifyFromBuffer', args: body => [body.buffer], binary: true },
    { channel: 'acoustid:validateKey', method: 'POST', path: '/api/identify/validateKey',
      fn: 'acoustidValidateKey', args: body => [body] },
    { channel: 'acoustid:identifyFromBuffer', method: 'POST', path: '/api/identify/acoustidBuffer',
      fn: 'acoustidIdentifyFromBuffer', args: body => [body.buffer, body.apiKey], binary: true },
    { channel: 'acoustid:identify', method: 'POST', path: '/api/identify/acoustid',
      fn: 'acoustidIdentify', args: body => [body] },
    { channel: 'acoustid:status', method: 'GET', path: '/api/identify/status',
      fn: 'acoustidStatus', args: () => [] },
  ],
};
