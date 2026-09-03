'use strict';

// engine/tag.js — audio tag editing (ID3v2/MP3 only for writes) + metadata
// enrichment (MusicBrainz search, Cover Art Archive, LRCLIB lyrics) + the
// auto-tag flow that ties them together. Extracted verbatim from main.js
// (Fase G, Step 2, 2026-08-26) — audited Electron-free: no dialog/shell/
// clipboard/notify anywhere in this domain, every input is a file path or
// plain scalars already known to the caller (never a fresh OS picker).
const fs = require('fs');
const path = require('path');
const { fetchJSONWithUA, describeNetError } = require('./net');
const { log } = require('./log');

// ─── TAG READ/WRITE ─────────────────────────────────────────────────────────
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

// ─── METADATA ENRICHMENT (MusicBrainz / CoverArt / LRCLIB) ─────────────────
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

// Plain http/https GET → Buffer. Local to this domain (its only real caller
// is coverArtFetch below) — no Electron dependency, works identically
// wherever it runs.
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

// ─── AUTO-TAG (ties the above together) ────────────────────────────────────
// Given a freshly-downloaded MP3 + an artist/title hint (or a "Artist - Title"
// string), query MusicBrainz for the best match, optionally fetch its release
// cover from Cover Art Archive, and write ID3v2 tags. Caller decides whether
// to await this — radio/Spotify downloads fire it fire-and-forget so a slow
// MB query doesn't block the UI.
async function autoTag({ filePath, artist, title, hint, minScore = 80, fetchCover = true } = {}) {
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
}

// ─── LRC SIDECAR (save/exists/read a .lrc next to the audio file) ─────────
function lrcSave({ audioPath, lyrics }) {
  try {
    const lrcPath = audioPath.replace(/\.[^.]+$/, '') + '.lrc';
    fs.writeFileSync(lrcPath, lyrics, 'utf8');
    return { ok: true, path: lrcPath };
  } catch (e) { return { ok: false, error: e.message }; }
}

function lrcExists(audioPath) {
  const lrcPath = audioPath.replace(/\.[^.]+$/, '') + '.lrc';
  return { exists: fs.existsSync(lrcPath), path: lrcPath };
}

function lrcRead(audioPath) {
  try {
    const lrcPath = audioPath.replace(/\.[^.]+$/, '') + '.lrc';
    if (!fs.existsSync(lrcPath)) return { ok: false, error: 'not found' };
    return { ok: true, content: fs.readFileSync(lrcPath, 'utf8'), path: lrcPath };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = {
  readTags, writeTags, musicBrainzSearch, coverArtFetch, lyricsFetch, autoTag,
  lrcSave, lrcExists, lrcRead,
  routes: [
    { channel: 'tag:read',    method: 'GET',  path: '/api/tag/read',    fn: 'readTags',       args: body => [body.filePath] },
    { channel: 'tag:write',   method: 'POST', path: '/api/tag/write',   fn: 'writeTags',       args: body => [body] },
    { channel: 'tag:autoTag', method: 'POST', path: '/api/tag/autoTag', fn: 'autoTag',         args: body => [body] },
    { channel: 'mb:search',   method: 'GET',  path: '/api/mb/search',   fn: 'musicBrainzSearch', args: body => [body.title, body.artist, body.album] },
    { channel: 'cover:fetch', method: 'GET',  path: '/api/cover/fetch', fn: 'coverArtFetch',   args: body => [body.mbid] },
    { channel: 'lrc:fetch',   method: 'GET',  path: '/api/lrc/fetch',   fn: 'lyricsFetch',     args: body => [body.title, body.artist, body.album, body.duration] },
    { channel: 'lrc:save',    method: 'POST', path: '/api/lrc/save',    fn: 'lrcSave',         args: body => [body] },
    { channel: 'lrc:exists',  method: 'GET',  path: '/api/lrc/exists',  fn: 'lrcExists',       args: body => [body.audioPath] },
    { channel: 'lrc:read',    method: 'GET',  path: '/api/lrc/read',    fn: 'lrcRead',         args: body => [body.audioPath] },
  ],
};
