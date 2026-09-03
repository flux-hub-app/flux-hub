'use strict';

// engine/fileops.js — the "File & Sync" tool (FreeFileSync-style folder
// compare/copy/mirror with optional MP3 transcode + playlist), the flat
// file browser + batch renamer (also used by Xtract/Tag Editor's "load a
// folder" flows), single-file rename, and URL import (download a remote
// file to disk — the drag&drop-from-buffer sibling, `file:saveDroppedBuffer`,
// needs G-bin and stays in main.js for Step 3). Extracted verbatim from
// main.js (Fase G, Step 2, 2026-08-26) — zero Electron dependency: every
// input is a folder/file path or a URL, never a fresh OS picker.
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const enginePaths = require('./paths');
const { log } = require('./log');
const { getFfmpegPath } = require('./binaries');
const { httpGetStream } = require('./net');
const { safeSend } = require('./bus');

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

// Audio formats we can transcode to MP3 for car compatibility.
const AUDIO_TRANSCODE_EXT = new Set(['.flac', '.opus', '.m4a', '.ogg', '.oga', '.wav', '.aac', '.wma', '.aiff', '.alac']);
const toMp3Rel = rel => rel.replace(/\.[^.\\/]+$/, '.mp3');

// Build a FreeFileSync-style per-file comparison. Returns one row per file
// (union of both sides) so the UI can show the two-pane grid with a center
// action + per-row checkbox. Categories:
//   new    — present on one side only → copy to the other
//   update — present on both, one side newer/changed → copy newer over older
//   delete — dest-only in mirror mode → remove from destination
//   equal  — identical on both sides → no action
//   ignore — dest-only in incremental mode → left untouched
// dir: 'toDest' (→), 'toSrc' (←), 'del' (✗), '' (none).
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
function fileopsPlan(payload = {}) {
  try {
    if (!payload.source || !fs.existsSync(payload.source)) return { ok: false, error: 'Source folder not found' };
    if (!payload.dest) return { ok: false, error: 'No destination selected' };
    return buildSyncPlan(payload);
  } catch (e) { return { ok: false, error: e.message }; }
}

// Execute ONLY the operations the caller passed (the rows the user left
// checked), streaming progress on 'fileops:progress'. `sender` is
// event.sender on IPC, bus.getBroadcastSender() on REST (same convention as
// every other long-running op in this codebase).
// ops = [{ srcRel, destRel, dir, transcode?, bytes }]. Deletions require
// confirmDelete (the caller confirms mirror deletes first). Transcode ops
// (audio → MP3 for the car) run ffmpeg instead of a plain copy.
async function fileopsRun(payload = {}, sender) {
  const { source, dest, ops = [], confirmDelete = false } = payload;
  if (!source || !fs.existsSync(source)) return { ok: false, error: 'Source folder not found' };
  if (!dest) return { ok: false, error: 'No destination selected' };
  try { fs.mkdirSync(dest, { recursive: true }); } catch (err) { return { ok: false, error: `Cannot create destination: ${err.message}` }; }

  const total = ops.length;
  const totalBytes = ops.reduce((s, o) => s + (o.bytes || 0), 0);
  let copied = 0, copiedBack = 0, transcoded = 0, deleted = 0, done = 0, doneBytes = 0;
  const errors = [];
  const send = (file, phase) => safeSend(sender, 'fileops:progress', { done, total, doneBytes, totalBytes, copied, copiedBack, transcoded, deleted, file, phase });

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
}

// List removable / external drives so the File & Sync tab can offer them as a
// one-click destination (the USB-for-the-car case). Best-effort + never throws.
//   win32  : Win32_LogicalDisk DriveType=2 (removable) via PowerShell.
//   darwin : mounted volumes under /Volumes (minus the boot volume).
//   linux  : auto-mount roots under /media and /run/media.
// In a container there's nothing to find here — an empty array is the
// honest answer, not an error (see engine/wire-rest.js's routes[] comment).
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

// ─── FILE MANAGE (browse a folder + batch rename — the "video archive" use,
// also the base for the server "file picker" replacing native dialogs) ─────
// Flat file list for the Manage view. { rel, name, size }, sorted by rel.
function filesList({ folder, exts, recursive = true } = {}) {
  try {
    if (!folder || !fs.existsSync(folder)) return { ok: false, error: 'Folder not found' };
    // `exts`/`recursive` arrive as real types from IPC (array/boolean) but as
    // plain strings from a REST GET's query params (wireRest's generic
    // Object.fromEntries has no array/boolean concept) — normalise both here
    // rather than special-casing this one route's query parsing.
    const extList = Array.isArray(exts) ? exts : (typeof exts === 'string' && exts ? exts.split(',') : null);
    const extSet = (extList && extList.length)
      ? new Set(extList.map(x => { const l = x.toLowerCase(); return l.startsWith('.') ? l : '.' + l; })) : null;
    const isRecursive = typeof recursive === 'string' ? recursive !== 'false' : !!recursive;
    let raw;
    if (isRecursive) raw = walkFiles(folder, extSet);
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
}

// Batch-rename inside a folder. renames = [{ from (rel), to (rel) }]. Two-phase
// (rename to a temp name first) so reorders / swaps (A→B, B→A) don't collide.
// A target that already exists on the SECOND pass is skipped (collision-safe).
function filesRename({ folder, renames } = {}) {
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
}

function fileRename({ oldPath, newPath } = {}) {
  try {
    if (!oldPath || !newPath) return { ok: false, error: 'Missing paths' };
    if (fs.existsSync(newPath) && oldPath !== newPath) return { ok: false, error: `Destination already exists: ${newPath}` };
    fs.renameSync(oldPath, newPath);
    return { ok: true, path: newPath };
  } catch (e) {
    log('ERROR', `file:rename: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ─── DROPPED-CONTENT IMPORT (cross-app drag & drop) ────────────────────────
// Files dragged in from another app (typically an image dragged out of a
// browser) have no disk path — the renderer either forwards the File's bytes
// (file:saveDroppedBuffer, needs G-bin, stays in main.js for Step 3) or asks
// us to download the drag's source URL (this one — no client buffer needed,
// portable now).
function droppedDir() {
  const dir = path.join(enginePaths.getPaths().userData, 'dropped');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function sanitizeDroppedName(n) {
  return String(n || '').replace(/[^\w.\- ]+/g, '_').slice(-80);
}

const IMPORT_URL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fileImportUrl({ url } = {}) {
  try {
    if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'invalid URL' };
    const res = await httpGetStream(url, { ua: IMPORT_URL_UA, accept: '*/*', timeout: 25000 });
    if (res.statusCode !== 200) { try { res.resume && res.resume(); } catch {} return { ok: false, error: `HTTP ${res.statusCode}` }; }
    const chunks = [];
    await new Promise((resolve, reject) => {
      res.on('data', c => chunks.push(Buffer.from(c)));
      res.on('end', resolve);
      res.on('error', reject);
    });
    const buf = Buffer.concat(chunks);
    if (!buf.length) return { ok: false, error: 'empty response' };
    const mime = String(res.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    const extFromMime = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
      'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/tiff': 'tiff'
    }[mime];
    let name = '';
    try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { /* keep '' */ }
    name = sanitizeDroppedName(name);
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) name = (name || 'dropped') + '.' + (extFromMime || 'bin');
    const dest = path.join(droppedDir(), `${Date.now()}_${name}`);
    fs.writeFileSync(dest, buf);
    return { ok: true, path: dest, mime };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  walkFiles, buildSyncPlan, writeDestM3u, fileopsPlan, fileopsRun,
  listRemovableDrives, filesList, filesRename, fileRename,
  droppedDir, sanitizeDroppedName, fileImportUrl,
  routes: [
    { channel: 'fileops:plan',   method: 'POST', path: '/api/fileops/plan',   fn: 'fileopsPlan', args: body => [body] },
    { channel: 'fileops:run',    method: 'POST', path: '/api/fileops/run',    fn: 'fileopsRun',  args: (body, sender) => [body, sender] },
    { channel: 'fileops:drives', method: 'GET',  path: '/api/fileops/drives', fn: 'listRemovableDrives', args: () => [] },
    { channel: 'files:list',     method: 'GET',  path: '/api/files/list',     fn: 'filesList',   args: body => [body] },
    { channel: 'files:rename',   method: 'POST', path: '/api/files/rename',   fn: 'filesRename', args: body => [body] },
    { channel: 'file:rename',    method: 'POST', path: '/api/file/rename',    fn: 'fileRename',  args: body => [body] },
    { channel: 'file:importUrl', method: 'POST', path: '/api/file/importUrl', fn: 'fileImportUrl', args: body => [body] },
  ],
};
