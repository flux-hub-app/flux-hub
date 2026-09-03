'use strict';

// engine/live.js — live stream recording via yt-dlp with live-aware args
// (MKV container, HLS mpegts, --live-from-start). Extracted verbatim from
// main.js (Fase G, Step 2, 2026-08-26) — same yt-dlp spawn pattern already
// proven in engine/queue.js, zero Electron dependency: URL in, file on disk
// out, nothing captured from the client.
const fs = require('fs');
const path = require('path');
const { log } = require('./log');
const { loadConfig } = require('./config');
const { safeSend } = require('./bus');
const { getYtDlpPath, getFfmpegDir, getYtDlpProxyArg, spawnYtDlp } = require('./binaries');
const { activeMediaProcs, killProcessTree } = require('./queue');

// `event` is `{sender}` — a live IPC event.sender on desktop, or
// `{sender: bus.getBroadcastSender()}` from server.js (same convention
// already used by engine/queue.js's runQueue/runTorrentSearch).
async function runLiveRecord(event, url, format, fromStart, downloadFolder) {
  return new Promise((resolve) => {
    fs.mkdirSync(downloadFolder, { recursive: true });
    const ytdlp = getYtDlpPath();
    if (!ytdlp) return resolve({ ok: false, error: 'yt-dlp not bundled' });

    const fluxTempDir = path.join(downloadFolder, '.flux-temp');
    fs.mkdirSync(fluxTempDir, { recursive: true });

    // Live-friendly args: MKV container (resilient to incomplete writes), HLS mpegts,
    // resume disabled (live can't resume meaningfully).
    const args = [
      '-P', `home:${downloadFolder}`,
      '-P', `temp:${fluxTempDir}`,
      '--no-part',                       // write final file as it grows — partial captures usable
      '--hls-use-mpegts',                // safer for HLS live
      '--no-playlist',
      '--no-overwrites',
    ];
    // Point yt-dlp at bundled ffmpeg + ffprobe (same rationale as
    // media:download — without this, --merge-output-format + -x fail on
    // packaged builds without a system ffmpeg).
    const ffDir = getFfmpegDir();
    if (ffDir) args.push('--ffmpeg-location', ffDir);
    if (fromStart) args.push('--live-from-start');
    const cfgRate = parseInt(loadConfig()?.speed_limit_kbs, 10) || 0;
    if (cfgRate > 0) args.push('--limit-rate', `${cfgRate}K`);
    const proxyArg = getYtDlpProxyArg();
    if (proxyArg) args.push('--proxy', proxyArg);

    switch (format) {
      case 'audio':       args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0', '--ppa', 'FFmpegExtractAudio:-id3v2_version 3 -write_xing 1'); break;
      case 'video_1080':  args.push('-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]', '--merge-output-format', 'mkv'); break;
      case 'video_720':   args.push('-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]',  '--merge-output-format', 'mkv'); break;
      case 'video':
      default:            args.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mkv'); break;
    }
    args.push('-o', '%(title)s_%(release_timestamp,timestamp,epoch)s.%(ext)s', url);

    log('INFO', `live record: ${url} [${format}${fromStart?' fromStart':''}]`);
    const proc = spawnYtDlp(ytdlp, args);
    activeMediaProcs.add(proc);
    let lastDestPath = null;
    let stoppedByUser = false;
    proc.__fluxStop = () => { stoppedByUser = true; killProcessTree(proc); };

    proc.stdout.on('data', d => {
      // Per-line scan (see media:download stdout handler for the rationale —
      // $ end-anchor + multi-line chunks made earlier Destination lines
      // invisible, leaving lastDestPath stuck on .flux-temp partials).
      const text = d.toString();
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        safeSend(event.sender, 'live:progress', { line, error: false });
        const m = line.match(/^\[(?:download|hlsnative|Merger|ffmpeg)\]\s+(?:Destination:|Merging formats into|Adding metadata to)\s*"?([^"]+?)"?\s*$/);
        if (m) lastDestPath = m[1];
      }
    });
    // Same WARNING vs ERROR distinction as the media download path —
    // keep warnings out of the renderer's error styling.
    proc.stderr.on('data', d => {
      for (const raw of d.toString().split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const isWarning = /^WARNING:/i.test(line);
        safeSend(event.sender, 'live:progress', { line, error: !isWarning });
      }
    });
    proc.on('close', code => {
      activeMediaProcs.delete(proc);
      // Same .flux-temp → home resolution as the regular media download.
      let finalPath = lastDestPath;
      if (lastDestPath) {
        const candidate = path.join(downloadFolder, path.basename(lastDestPath));
        if (fs.existsSync(candidate)) finalPath = candidate;
      }
      if (stoppedByUser) return resolve({ ok: true, code, path: finalPath, stopped: true });
      // Live recordings exit non-zero when stream ends — treat as ok if we captured anything
      resolve({ ok: finalPath != null || code === 0, code, path: finalPath, error: code !== 0 ? `yt-dlp exited with code ${code}` : null });
    });
    proc.on('error', e => { activeMediaProcs.delete(proc); resolve({ ok: false, error: e.message }); });
  });
}

module.exports = {
  runLiveRecord,
  routes: [
    { channel: 'live:record', method: 'POST', path: '/api/live/record',
      fn: 'runLiveRecord',
      args: (body, sender) => [{ sender }, body.url, body.format, !!body.fromStart, body.downloadFolder] },
  ],
};
