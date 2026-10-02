'use strict';

// engine/queue.js — the download queue: persistence (loadQueue/saveQueue),
// the yt-dlp spawn + retry logic (runMediaDownload/runMediaDownloadRetry),
// and the queue:run worker loop (runQueue). Extracted verbatim from main.js
// (Phase C, 2026-08-23).
//
// activeMediaProcs/killProcessTree/the stop-requested flag are ALSO used by
// main.js's own runLiveRecord and the media:stop IPC handler (Live Record is
// a workstation-only feature, out of the server "queue/download" scope per
// the Phase C plan, so it stays in main.js) — owned here as the single
// source of truth and required back into main.js, same pattern as
// safeSend/engine/bus.js.
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const enginePaths = require('./paths');
const { log } = require('./log');
const { loadConfig } = require('./config');
const { appendHistory } = require('./history');
const { safeSend } = require('./bus');
const { getYtDlpPath, getFfmpegDir, getYtDlpProxyArg, spawnYtDlp } = require('./binaries');
const { saveTorrentItem } = require('./torrent');

function queuePath() {
  return path.join(enginePaths.getPaths().userData, 'queue.json');
}

function loadQueue() {
  try {
    const p = queuePath();
    if (fs.existsSync(p)) {
      const q = JSON.parse(fs.readFileSync(p, 'utf8'));
      return q.map(item => item.status === 'running' ? { ...item, status: 'pending' } : item);
    }
  } catch {}
  return [];
}

function saveQueue(q) {
  try { fs.writeFileSync(queuePath(), JSON.stringify(q, null, 2), 'utf8'); }
  catch (e) { log('ERROR', `saveQueue: ${e.message}`); }
}

// Queue item ids added from main (engine/autopoll.js — headless RSS/
// subscription auto-queueing) are seeded from Date.now() so they never
// collide with the renderer's own `newId()` counter (a small incrementing
// integer starting near 0 for manually-queued items).
let mainQueueIdSeq = Date.now();
function newQueueId() { return ++mainQueueIdSeq; }

// ─── ACTIVE PROCESS TRACKING (shared with main.js's Live Record + Stop) ──────
const activeMediaProcs = new Set();
let queueStopRequested = false;
function isStopRequested() { return queueStopRequested; }
function setStopRequested(v) { queueStopRequested = !!v; }

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
      // 'audio' is the legacy pre-bitrate value (still present in persisted
      // queue items) → best VBR; the *_320/256/128 pills request a fixed CBR.
      case 'audio':
      case 'audio_320':
      case 'audio_256':
      case 'audio_128': {
        const mp3Quality = { audio: '0', audio_320: '320K', audio_256: '256K', audio_128: '128K' }[format];
        args.push('-x', '--audio-format', 'mp3', '--audio-quality', mp3Quality, '--ppa', 'FFmpegExtractAudio:-id3v2_version 3 -write_xing 1');
        break;
      }
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
      case 'video_2160':
        args.push('-f', mp4Compat
          ? `bestvideo[height<=2160]${h264Pref}+bestaudio${aacPref}/bestvideo[height<=2160]+bestaudio/best[height<=2160]`
          : 'bestvideo[height<=2160]+bestaudio/best[height<=2160]');
        args.push('--merge-output-format', 'mp4');
        break;
      case 'video_1440':
        args.push('-f', mp4Compat
          ? `bestvideo[height<=1440]${h264Pref}+bestaudio${aacPref}/bestvideo[height<=1440]+bestaudio/best[height<=1440]`
          : 'bestvideo[height<=1440]+bestaudio/best[height<=1440]');
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
    // --print after_move:... asks yt-dlp itself for the ABSOLUTE final path,
    // emitted once everything (download, merge, postprocessing, home/temp
    // move) is done — the authoritative answer, instead of us guessing it
    // from a "Destination:"/"Merging into" log line that isn't always
    // emitted in a parsable form (format/extractor dependent). The FLUXPATH:
    // prefix is just so this one line can't be confused with anything else
    // yt-dlp writes to stdout.
    args.push('-o', '%(title)s.%(ext)s', '--no-playlist', '--print', 'after_move:FLUXPATH:%(filepath)s', url);

    log('INFO', `yt-dlp attempt ${attempt}: ${url} [${format}]`);
    const proc = spawnYtDlp(ytdlp, args);
    activeMediaProcs.add(proc);
    let lastDestPath = null;
    let printedFinalPath = null;
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
        // The --print line is for us, not the user — skip forwarding it to
        // the on-screen/activity log.
        const printed = line.match(/^FLUXPATH:(.+)$/);
        if (printed) { printedFinalPath = printed[1].trim(); continue; }
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

      // Authoritative source: the --print after_move:filepath line — yt-dlp
      // telling us directly where the final file landed, after all
      // postprocessing and the temp→home move are done. Trust it whenever
      // the file is actually there.
      if (printedFinalPath && fs.existsSync(printedFinalPath)) {
        return resolve({ ok: true, code, path: printedFinalPath });
      }

      // Fallback for older yt-dlp builds without --print support (or the
      // rare case the printed path didn't materialise): reconstruct from the
      // last human-readable "Destination:" / "Merging into" / "Adding
      // metadata" line. During post-processing (ExtractAudio, Merger) yt-dlp
      // writes those to the TEMP dir (.flux-temp); resolve the real final
      // location by taking the basename and joining with the download
      // folder, rescuing (moving) the file ourselves if it never made the
      // temp→home move yt-dlp's --paths contract normally guarantees.
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

// The queue:run IPC handler's body — extracted so it has the same shape as
// runTorrentSearch (engine/torrent.js). Runs `concurrency` workers over the
// queue, routing each item's media progress through queue:progress (tagged
// with the item id) instead of the raw media:progress channel, so the
// queue-log stays readable with concurrency > 1.
async function runQueue(event, queue, config) {
  const concurrency = Math.max(1, Math.min(5, parseInt(config.concurrency) || 1));
  const results = [];
  let cursor = 0;
  setStopRequested(false); // reset for this run

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
    while (cursor < queue.length && !isStopRequested()) {
      const idx = cursor++;
      await processOne(queue[idx]);
    }
    if (isStopRequested()) log('INFO', `queue worker exited early (stop requested)`);
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { results, stopped: isStopRequested() };
}

// ─── DRM DETECTION + PROBE/STREAM-URL (moved here 2026-08-23 for server.js's
// /api/media/* routes — same domain as the download machinery above, uses
// only engine/binaries.js, no Electron) ─────────────────────────────────────
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

// -g needs a SINGLE stream URL — fine for a real muxed (audio+video) format,
// but most modern YouTube videos (and many other sites) no longer expose
// one at all: every format is video-ONLY or audio-ONLY (DASH), and a plain
// <video>/<audio> element can't combine two separate HTTP resources into
// one playback. kind='audio' sidesteps this entirely (an audio-only format
// always exists and is a real playable URL); kind='video' tries a muxed
// format first and, if genuinely none exists, degrades to that same
// audio-only URL (marked `videoUnavailable`) rather than failing outright —
// the caller can fall back to an audio-only preview instead of a dead end.
function ytDlpSingleUrl(ytdlp, args) {
  return new Promise(resolve => {
    const proc = spawnYtDlp(ytdlp, args);
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
function getStreamUrl(url, kind = 'video') {
  const ytdlp = getYtDlpPath();
  if (!ytdlp) return Promise.resolve({ ok: false, error: 'yt-dlp not bundled' });
  if (!url || !/^https?:\/\//i.test(url)) return Promise.resolve({ ok: false, error: 'invalid URL' });
  const px = getYtDlpProxyArg();
  const audioArgs = ['--no-warnings', '-g', '--no-playlist', '-f', 'bestaudio/best', url];
  if (px) audioArgs.unshift('--proxy', px);
  if (kind === 'audio') return ytDlpSingleUrl(ytdlp, audioArgs);
  const videoArgs = ['--no-warnings', '-g', '--no-playlist', '-f', 'best[protocol^=m3u8]/best', url];
  if (px) videoArgs.unshift('--proxy', px);
  return ytDlpSingleUrl(ytdlp, videoArgs).then(r => {
    if (r.ok) return r;
    // No muxed format at all for this URL — fall back to audio-only instead
    // of a hard failure. Caller decides what "videoUnavailable" means for
    // its own UI (e.g. play audio-only with a toast instead of the video
    // modal), same idea as the desktop-only "not available" pattern.
    return ytDlpSingleUrl(ytdlp, audioArgs).then(ar => ar.ok ? { ...ar, videoUnavailable: true } : r);
  });
}

// Resolves a non-direct URL (YouTube watch page, podcast portal, etc.) to a
// playable HTTP media URL — used by the topbar player + Playlist when a URL
// isn't recognized as direct media by isDirectMediaUrl (renderer.js). Ported
// verbatim from main.js's media:resolveStreamUrl (2026-09-29) — no Electron
// dependency, same getYtDlpPath/getYtDlpProxyArg/spawnYtDlp already used by
// getStreamUrl above. Unlike that one, added a kill timer (same 15s as
// getStreamUrl) — the original main.js handler never had one, relying on
// the desktop user being present to notice a hang; a REST call has no such
// backstop.
function resolveStreamUrl(url, kind = 'audio') {
  return new Promise(resolve => {
    if (!url) return resolve({ ok: false, error: 'No URL provided' });
    const ytdlp = getYtDlpPath();
    if (!ytdlp) return resolve({ ok: false, error: 'yt-dlp not available' });
    const formatSel = kind === 'video' ? 'best[ext=mp4]/best' : 'bestaudio/best';
    const args = ['--print', 'title', '--print', 'url', '-f', formatSel, '--no-warnings', '--no-playlist', url];
    const px = getYtDlpProxyArg(); if (px) args.unshift('--proxy', px);
    const proc = spawnYtDlp(ytdlp, args);
    let out = '', err = '';
    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 15000);
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      clearTimeout(timer);
      const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
      const title  = lines.find(l => !/^https?:\/\//i.test(l)) || null;
      const direct = lines.find(l =>  /^https?:\/\//i.test(l)) || null;
      if (code === 0 && direct) return resolve({ ok: true, url: direct, title });
      resolve({ ok: false, error: (err.split('\n').filter(Boolean).pop() || `yt-dlp exit ${code}`).slice(0, 200) });
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
    const proc = spawnYtDlp(ytdlp, args);
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

// ─── RELATED-BY-SEARCH FALLBACK (moved here 2026-08-24 for engine/remote.js's
// "trailer <title>" command — same domain as probeMedia/getStreamUrl above,
// uses only engine/binaries.js) ─────────────────────────────────────────────
// Also still used by main.js's own media:related IPC handler (the full
// "related media" panel, which layers provider-specific adapters — YouTube
// Innertube, SoundCloud — on top of this as the generic fallback); main.js
// re-imports both this and RELATED_MAX_ITEMS rather than duplicating either.
const RELATED_MAX_ITEMS = 12;

function relatedFromSearch(query, maxItems = RELATED_MAX_ITEMS) {
  return new Promise(resolve => {
    const ytdlp = getYtDlpPath();
    if (!ytdlp) return resolve([]);
    const args = [
      '--no-warnings', '--flat-playlist',
      '--print', '%(id)s\t%(title)s\t%(channel,uploader,extractor_key)s\t%(duration_string|)s\t%(url)s',
      `ytsearch${maxItems}:${query}`
    ];
    const px = getYtDlpProxyArg(); if (px) args.unshift('--proxy', px);
    const proc = spawnYtDlp(ytdlp, args);
    let out = '';
    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 25000);
    proc.stdout.on('data', d => out += d.toString());
    proc.on('close', () => {
      clearTimeout(timer);
      resolve(out.trim().split('\n').filter(Boolean).map(line => {
        const [id, title, uploader, duration, url] = line.split('\t');
        if (!id || !title || !url) return null;
        return {
          url, title,
          uploader: uploader || null,
          duration: duration || null,
          thumbnail: /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null
        };
      }).filter(Boolean));
    });
    proc.on('error', () => { clearTimeout(timer); resolve([]); });
  });
}

// HEAD (falling back to GET on 4xx) a URL to check it's reachable before
// queuing it — used by the "check before adding" UX in the queue import
// flow. Verbatim duplicated in main.js's queue:checkUrl IPC handler AND
// server.js's GET /api/queue/checkUrl route (never extracted in Phase C);
// consolidated here so both transports share one copy via routes[] below.
function checkUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return Promise.resolve({ ok: false, error: 'Invalid URL' });
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
  return (async () => {
    let r = await probeOnce('HEAD', url);
    if (!r.ok && r.status >= 400 && r.status < 500) r = await probeOnce('GET', url);
    return r;
  })();
}

module.exports = {
  loadQueue, saveQueue, newQueueId,
  activeMediaProcs, isStopRequested, setStopRequested, killProcessTree,
  runMediaDownload, runMediaDownloadRetry, runQueue,
  isDrmHost, getStreamUrl, resolveStreamUrl, probeMedia, checkUrl,
  RELATED_MAX_ITEMS, relatedFromSearch,
  // Only load/checkUrl declared here — save/clear/run/importList each have
  // real per-transport divergence (REST-only input validation on save, or
  // no IPC equivalent at all for the paste-import shape) and stay
  // hand-written, see .claude/plans's Fase G Step 1 notes.
  routes: [
    { channel: 'queue:load',     method: 'GET', path: '/api/queue',          fn: 'loadQueue', args: () => [] },
    { channel: 'queue:checkUrl', method: 'GET', path: '/api/queue/checkUrl', fn: 'checkUrl',   args: body => [body.url] },
  ],
};
