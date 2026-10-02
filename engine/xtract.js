'use strict';

// engine/xtract.js — ffmpeg-driven local media operations (Xtract tab: Audio/
// Video/trim/convert/subs/frame/concat/normalize/the unified non-destructive
// pipeline) plus the Xtract "Capture" sub-panel (screenshot/recording save,
// PDF-page/annotate save — the parts of that panel that don't need a real
// Chromium window: screen/window listing and URL capture stay in main.js,
// see below). Extracted verbatim from main.js (Fase G, Step 3, 2026-09-03) —
// audited Electron-free: every op is spawn(ffmpeg)/fs/path, progress travels
// through the same `{sender}` duck-typed object as engine/live.js and
// engine/queue.js (a live IPC event.sender on desktop, bus.getBroadcastSender()
// from server.js), never a direct Electron API.
//
// `xtract:probeDuration` and `xtract:hasAudio` are NOT in this file's
// `routes[]` — both are called from the renderer with a raw string path as
// the IPC payload (`ipcRenderer.invoke('xtract:hasAudio', filePath)`), not an
// object, so the generic `args(body, sender)` mapping (which always treats
// `body` as an object) can't carry them. They're exported here and hand-wired
// in main.js/server.js instead — same reasoning as torrent.js/queue.js's
// hand-written REST routes (see wire-ipc.js's header comment).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { getFfmpegPath } = require('./binaries');
const { loadConfig } = require('./config');
const { log } = require('./log');
const { safeSend } = require('./bus');

function ffmpegProbeDuration(inputPath) {
  // Best-effort duration parse: run ffmpeg with no output and read stderr.
  // ffmpeg always prints duration during initial codec sniffing.
  return new Promise(resolve => {
    const proc = spawn(getFfmpegPath(), ['-hide_banner', '-i', inputPath]);
    let buf = '';
    proc.stderr.on('data', d => buf += d.toString());
    proc.on('close', () => {
      const m = buf.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return resolve(0);
      resolve(parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]));
    });
    proc.on('error', () => resolve(0));
  });
}

// `onProc` (optional): called with the spawned child process right after
// spawn — lets a caller that needs to CANCEL a long-running op (preview
// remux; nothing else does yet) track/kill it without ffmpegRun itself
// needing to know anything about cancellation.
function ffmpegRun(event, args, outputPath, opId, { onProc } = {}) {
  return new Promise(async (resolve) => {
    const totalSec = opId ? await ffmpegProbeDuration(args[args.indexOf('-i') + 1]) : 0;
    const ffmpegBin = getFfmpegPath();
    log('INFO', `xtract: ${ffmpegBin} ${args.map(a => /\s/.test(a) ? `"${a}"` : a).join(' ')}`);
    const proc = spawn(ffmpegBin, args);
    if (onProc) onProc(proc);
    let stderr = '';
    proc.stderr.on('data', d => {
      const chunk = d.toString();
      stderr += chunk;
      // Parse "time=HH:MM:SS.xx" → percentage if we know the total duration.
      const m = chunk.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m && totalSec > 0) {
        const cur = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
        const pct = Math.min(99, Math.round(cur / totalSec * 100));
        safeSend(event.sender, 'xtract:progress', { opId, pct });
      }
    });
    proc.on('error', e => resolve({ ok: false, error: `ffmpeg not found: ${e.message}` }));
    proc.on('close', code => {
      if (code !== 0) {
        // A fixed byte-slice of raw stderr cuts mid-word/mid-line — confirmed
        // live: a user-facing error literally read "thread with error:
        // Invalid argument", itself a truncated fragment missing whatever
        // came before "t" — the real diagnostic (which stream, which codec,
        // why) was already gone. ffmpeg also writes its progress stats with
        // \r (same line overwritten in a terminal), not \n, so those can
        // pile up as one giant "line" ahead of the actual error — normalize
        // \r to \n first, then drop pure stats-line noise and keep whole
        // lines from the tail instead of an arbitrary character cut.
        const lines = stderr.replace(/\r/g, '\n').split('\n')
          .map(l => l.trim())
          .filter(l => l && !/^(frame|size)=/.test(l));
        const logTail    = lines.slice(-30).join('\n');
        const clientTail = lines.slice(-15).join('\n');
        log('ERROR', `xtract: ffmpeg exit ${code}: ${logTail}`);
        return resolve({ ok: false, error: `ffmpeg exit ${code}:\n${clientTail}` });
      }
      // ffmpeg returned 0 but the output may still be unusable (empty / no
      // streams) — e.g. trim with start >= end produces a 0-byte file and
      // exit 0. Surface that as an explicit error so the user doesn't think
      // it worked.
      let size = 0;
      try { size = fs.statSync(outputPath).size; } catch {}
      if (size < 1024) {
        log('WARN', `xtract: output ${outputPath} is ${size} bytes — likely empty`);
        return resolve({ ok: false, error: `Output is empty (${size} bytes). Check that start < end and times are within the file duration.` });
      }
      safeSend(event.sender, 'xtract:progress', { opId, pct: 100 });
      log('INFO', `xtract: ✓ ${outputPath} (${size} bytes)`);
      resolve({ ok: true, path: outputPath });
    });
  });
}

// All XTRACT outputs (audio/convert/trim/subs/frame/concat/meta/normalize) land
// in the user's configured FLUX download folder, not next to the source — so
// the source library stays untouched and one folder collects every edit.
function xtractOutputPath(inputPath, suffix, ext) {
  const cfg = loadConfig();
  const dir = cfg.download_folder || path.dirname(inputPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    log('WARN', `xtract: cannot create download folder ${dir}: ${e.message} — falling back to input folder`);
    return path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}${suffix}.${ext}`);
  }
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(dir, `${base}${suffix}.${ext}`);
}

// 1) Extract audio from any media file → mp3/flac/m4a/wav/opus
async function xtractAudio(event, { input, format, opId }) {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  const ext = format || 'mp3';
  const out = xtractOutputPath(input, '-audio', ext);
  // `-id3v2_version 3` + `-write_xing 1` fixes Windows Media Player which
  // refuses ID3v2.4 (ffmpeg default since ~5.0). Xing header is the standard
  // VBR sentinel — without it some players display the wrong duration.
  const codecArgs = {
    mp3:  ['-vn', '-c:a', 'libmp3lame', '-q:a', '0', '-id3v2_version', '3', '-write_xing', '1'],
    flac: ['-vn', '-c:a', 'flac'],
    m4a:  ['-vn', '-c:a', 'aac', '-b:a', '256k'],
    wav:  ['-vn', '-c:a', 'pcm_s16le'],
    opus: ['-vn', '-c:a', 'libopus', '-b:a', '160k']
  }[ext] || ['-vn'];
  // `-sn` — drop subtitle streams. Without it, ffmpeg's default stream
  // selection still grabs the source's "best" subtitle track (common on a
  // multi-language mux) and tries to carry it into an audio-only container
  // that can't hold one, which fails the whole mux with "Nothing was
  // written... because at least one of its streams received no packets" —
  // same failure class fixed below for xtractConvert/stageTrim. Audio
  // extraction never exposed subtitle handling as a feature, so dropping
  // them outright is the correct default, not a regression.
  const args = ['-hide_banner', '-y', '-i', input, ...codecArgs, '-sn', out];
  return ffmpegRun(event, args, out, opId);
}

// 2) Convert format (video → other video/container, or audio → another audio)
async function xtractConvert(event, { input, format, opId }) {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  const ext = format || 'mp4';
  const out = xtractOutputPath(input, '-converted', ext);
  // Stream-copy when feasible (mp4↔mkv), re-encode otherwise.
  const inExt = path.extname(input).slice(1).toLowerCase();
  let containerOnly = ['mp4', 'mkv', 'webm', 'mov'].includes(ext) && ['mp4', 'mkv', 'webm', 'mov'].includes(inExt);
  if (containerOnly && ext === 'webm') {
    // Same bug/fix as stageTrim's remuxOnly path (see WEBM_SAFE_VIDEO's
    // comment) — webm's muxer rejects almost anything an mp4/mkv/mov
    // source actually holds (H.264/HEVC + AAC/AC-3). Without this check,
    // copying straight to webm fails outright; the `else` branch below
    // (ffmpeg's own default encoder choice for a .webm output, normally
    // libvpx-vp9+libopus) already handles it correctly instead.
    const { videoCodec, audioCodec } = await probeCodecs(input);
    containerOnly = (!videoCodec || WEBM_SAFE_VIDEO.has(videoCodec)) && (!audioCodec || WEBM_SAFE_AUDIO.has(audioCodec));
  }
  // `-sn` on both branches — see xtractAudio's comment on the same flag:
  // ffmpeg's default stream selection still auto-maps a subtitle track
  // (common on a multi-language mux) even on a plain `-c copy` remux, and
  // the target container/codec may not accept it (webm only takes WebVTT;
  // most source subs are ASS/SRT) — mux then fails outright with "at least
  // one of its streams received no packets", even though video+audio alone
  // would have converted fine. Confirmed against a real multi-sub mkv→webm.
  const args = containerOnly
    ? ['-hide_banner', '-y', '-i', input, '-c', 'copy', '-sn', out]
    : ['-hide_banner', '-y', '-i', input, '-sn', out];
  return ffmpegRun(event, args, out, opId);
}

// 2a-bis) Audio-track surgery on a video: strip the original audio, or swap
// it with an external audio file. Video stream-copied both ways (no
// re-encode); replacement audio re-encoded to fit the container.
async function xtractAudiotrack(event, { input, mode, audio, opId }) {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  const ext = path.extname(input).slice(1).toLowerCase() || 'mp4';
  if (mode === 'replace') {
    if (!audio || !fs.existsSync(audio)) return { ok: false, error: 'Audio file not found' };
    const out = xtractOutputPath(input, '-newaudio', ext);
    // -map 0:v + 1:a = video from the source, audio from the picked file;
    // -shortest stops at the shorter of the two. WebM only accepts
    // Opus/Vorbis — every other container gets AAC.
    const acodec = ext === 'webm'
      ? ['-c:a', 'libopus', '-b:a', '160k']
      : ['-c:a', 'aac', '-b:a', '256k'];
    const args = ['-hide_banner', '-y', '-i', input, '-i', audio,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...acodec, '-shortest', out];
    return ffmpegRun(event, args, out, opId);
  }
  // Default: remove audio — video-only copy. `-sn` for the same reason as
  // every other copy/re-encode path in this file: the source's default
  // subtitle track would otherwise still get auto-mapped and can fail the
  // mux if the container doesn't accept its codec.
  const out = xtractOutputPath(input, '-noaudio', ext);
  return ffmpegRun(event, ['-hide_banner', '-y', '-i', input, '-c', 'copy', '-an', '-sn', out], out, opId);
}

// 2b) Resize a video to a target height (keeps aspect; -2 = even width). H.264/AAC mp4.
async function xtractResize(event, { input, height, opId }) {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  const h = parseInt(height, 10) || 720;
  const out = xtractOutputPath(input, `-${h}p`, 'mp4');
  const args = ['-hide_banner', '-y', '-i', input, '-vf', `scale=-2:${h}`, '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-c:a', 'aac', '-b:a', '160k', '-sn', out];
  return ffmpegRun(event, args, out, opId);
}

// 2c) Compress a video (H.264 CRF; higher = smaller/lower quality, 28 ≈ good).
async function xtractCompress(event, { input, crf, opId }) {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  const q = Math.min(40, Math.max(18, parseInt(crf, 10) || 28));
  const out = xtractOutputPath(input, '-compressed', 'mp4');
  const args = ['-hide_banner', '-y', '-i', input, '-c:v', 'libx264', '-crf', String(q), '-preset', 'medium', '-c:a', 'aac', '-b:a', '128k', '-sn', out];
  return ffmpegRun(event, args, out, opId);
}

// Parse "HH:MM:SS(.ms)" / "MM:SS" / "ss(.ms)" → seconds. Returns null on garbage.
function parseTimeToSeconds(s) {
  if (s == null) return null;
  const str = String(s).trim().replace(',', '.');
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  const parts = str.split(':');
  if (parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(parseFloat);
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  return null;
}

function formatSecondsHMS(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Audio codec args by container ext — used when trim needs re-encode (fades
// applied, can't stream-copy). Mirrors the xtract:audio handler.
const TRIM_AUDIO_CODECS = {
  // ID3v2.3 + Xing header — see xtractAudio for the WMP-compat rationale.
  mp3:  ['-c:a', 'libmp3lame', '-q:a', '0', '-id3v2_version', '3', '-write_xing', '1'],
  flac: ['-c:a', 'flac'],
  m4a:  ['-c:a', 'aac', '-b:a', '256k'],
  aac:  ['-c:a', 'aac', '-b:a', '256k'],
  wav:  ['-c:a', 'pcm_s16le'],
  ogg:  ['-c:a', 'libvorbis', '-q:a', '5'],
  opus: ['-c:a', 'libopus', '-b:a', '160k']
};

// Video output codec args (re-encode path when format change requested).
// MP4/MKV ship the same H.264+AAC payload; WebM uses VP9+Opus per spec.
const TRIM_VIDEO_CODECS = {
  mp4:  ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '192k'],
  mkv:  ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '192k'],
  webm: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-c:a', 'libopus', '-b:a', '128k']
};

// Containers whose payload is close enough to swap without re-encoding —
// mirrors xtractConvert's `containerOnly` check. Used by the pipeline's
// opt-in "remux only" mode (Xtract editor checkbox): a pure container/codec
// change with no real trim or fades doesn't need TRIM_VIDEO_CODECS at all.
const CONTAINER_REMUX_EXTS = new Set(['mp4', 'mkv', 'webm', 'mov']);
// WebM is the one exception in that set that ISN'T actually "close enough
// to swap freely" — its muxer only accepts VP8/VP9/AV1 video + Vorbis/Opus
// audio (ffmpeg's own error names exactly this), while mp4/mkv/mov sources
// are almost always H.264/HEVC + AAC/AC-3. stageTrim below probes the
// source codecs specifically when targeting webm before trusting a stream
// copy — found live converting a real .mkv ("Only VP8 or VP9 or AV1 video
// and Vorbis or Opus audio... are supported for WebM. Could not write
// header... Conversion failed!"), same class of bug already fixed tonight
// for the UNRELATED preview-remux feature (#44) via the SAME probeCodecs().
const WEBM_SAFE_VIDEO = new Set(['vp8', 'vp9', 'av1']);
const WEBM_SAFE_AUDIO = new Set(['vorbis', 'opus']);

// 3) Trim — fast lossless cut via -c copy. FLAC stores the original sample
// count in its STREAMINFO header and -c copy never rewrites it, so a trimmed
// FLAC would report the source duration to players. Re-encode FLAC (still
// lossless). -avoid_negative_ts make_zero guards mp4/mov where the seek lands
// before the first keyframe and ffmpeg would otherwise emit negative timestamps.
//
// When fadeIn / fadeOut > 0, ffmpeg needs to re-encode (filters incompatible
// with -c copy). Audio gets a format-appropriate codec; video falls back to
// stream copy + no fade (fades on video would need both -af and -vf which
// drops the fast-path benefit — out of scope for v1).
//
// Times are validated against the actual file duration before invoking ffmpeg.
async function probeDuration(input) {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'not found' };
  try {
    const dur = await ffmpegProbeDuration(input);
    return { ok: true, duration: dur };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Quick audio-presence check — scrapes ffmpeg -i stderr for any "Audio:" stream
// line. Used by the renderer to gate audio-only cards (Split, Extract audio,
// Normalize) on videos that ship with no audio track. Without this the UI
// shows those cards as runnable and ffmpeg fails later with "no audio stream
// to map" or produces a silent file.
function hasAudio(input) {
  if (!input || !fs.existsSync(input)) return Promise.resolve({ ok: false, error: 'not found' });
  return new Promise(resolve => {
    const proc = spawn(getFfmpegPath(), ['-hide_banner', '-i', input]);
    let buf = '';
    proc.stderr.on('data', d => buf += d.toString());
    proc.on('error', e => resolve({ ok: false, error: e.message }));
    proc.on('close', () => {
      const has = /Stream\s+#0:\d+(?:\[\w+\])?(?:\(\w+\))?:\s*Audio:/i.test(buf);
      resolve({ ok: true, hasAudio: has });
    });
  });
}

async function xtractTrim(event, { input, start, end, fadeIn = 0, fadeOut = 0, outputFormat, opId, gif }) {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  if (!start || !end) return { ok: false, error: 'Start and end required' };
  const startSec = parseTimeToSeconds(start);
  const endSec   = parseTimeToSeconds(end);
  if (startSec === null || endSec === null) {
    return { ok: false, error: `Invalid time format. Use HH:MM:SS, MM:SS or seconds (got start="${start}", end="${end}").` };
  }
  if (startSec >= endSec) {
    return { ok: false, error: `Start (${start} = ${startSec}s) must be before end (${end} = ${endSec}s).` };
  }
  const dur = await ffmpegProbeDuration(input);
  if (dur <= 0) {
    return { ok: false, error: 'Cannot read input duration — the file may be corrupted or in an unsupported format.' };
  }
  if (endSec > dur + 0.5) {
    return { ok: false, error: `End (${end}) is past file duration (${formatSecondsHMS(dur)}). Pick a value within the file length.` };
  }
  if (startSec >= dur) {
    return { ok: false, error: `Start (${start}) is past file duration (${formatSecondsHMS(dur)}).` };
  }
  const segDur = endSec - startSec;
  const fIn  = Math.max(0, Math.min(Number(fadeIn)  || 0, segDur));
  const fOut = Math.max(0, Math.min(Number(fadeOut) || 0, segDur));
  if (fIn + fOut > segDur) {
    return { ok: false, error: `Fade-in (${fIn}s) + fade-out (${fOut}s) exceed selection length (${segDur.toFixed(2)}s).` };
  }

  const inExt  = path.extname(input).slice(1).toLowerCase();
  const outExt = (outputFormat && String(outputFormat).toLowerCase()) || inExt || 'mp4';
  const formatChange = outExt !== inExt;
  const out = xtractOutputPath(input, '-trim', outExt);

  // GIF special-cases: no audio track exists on either end, and GIF output
  // needs a palette pass for decent colour (default ffmpeg gif encoder caps
  // at 256 colours globally — palettegen+paletteuse build a per-clip palette
  // for much better quality at the same size). Single-pass `filter_complex`
  // avoids the temp-file dance of the classic two-pass approach.
  const inIsGif  = inExt  === 'gif';
  const outIsGif = outExt === 'gif';

  const wantFades = fIn > 0 || fOut > 0;
  // Re-encode path required for fades OR when the output format differs from
  // the input. Pick the codec based on the OUTPUT container.
  if (wantFades || formatChange) {
    // ── GIF output branch — always re-encode through a palette filter.
    if (outIsGif) {
      const fps    = (gif && Number.isFinite(gif.fps))   ? Math.max(5, Math.min(30, gif.fps))   : 15;
      const widthN = (gif && Number.isFinite(gif.width)) ? gif.width                            : 480;
      // -1 = preserve source width (no scale filter); positive = target px.
      const scaleArg = widthN > 0 ? `scale=${widthN}:-1:flags=lanczos,` : '';
      // paletteuse supports several dither modes; bayer also takes a
      // bayer_scale parameter. Map our UI options to ffmpeg syntax.
      const dKind = (gif && gif.dither) || 'bayer';
      const ditherArg = dKind === 'bayer'           ? 'dither=bayer:bayer_scale=5:diff_mode=rectangle'
                      : dKind === 'sierra2'         ? 'dither=sierra2:diff_mode=rectangle'
                      : dKind === 'floyd_steinberg' ? 'dither=floyd_steinberg:diff_mode=rectangle'
                      :                                'dither=none:diff_mode=rectangle';
      const filter = `[0:v]fps=${fps},${scaleArg}split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=${ditherArg}`;
      const args = [
        '-hide_banner', '-y',
        '-ss', String(start), '-to', String(end),
        '-i', input,
        '-filter_complex', filter,
        '-loop', '0', '-an',
        out
      ];
      return ffmpegRun(event, args, out, opId);
    }
    const audioCodec = TRIM_AUDIO_CODECS[outExt];
    const videoCodec = TRIM_VIDEO_CODECS[outExt];
    let codecArgs;
    if (audioCodec && !videoCodec) {
      // Audio-only output: strip video, apply audio codec + any fade filter.
      const filters = [];
      if (fIn  > 0) filters.push(`afade=t=in:st=0:d=${fIn.toFixed(3)}`);
      if (fOut > 0) filters.push(`afade=t=out:st=${Math.max(0, segDur - fOut).toFixed(3)}:d=${fOut.toFixed(3)}`);
      codecArgs = ['-vn', ...(filters.length ? ['-af', filters.join(',')] : []), ...audioCodec];
    } else if (videoCodec) {
      // Video output: re-encode both streams; fade only the audio track.
      // GIF input has no audio track — strip the audio codec args from
      // videoCodec and skip audio fades. `-an` makes the absence explicit.
      if (inIsGif) {
        const noAudio = [];
        for (let i = 0; i < videoCodec.length; i++) {
          const a = videoCodec[i];
          if (a === '-c:a' || a === '-b:a') { i++; continue; }
          noAudio.push(a);
        }
        codecArgs = [...noAudio, '-an'];
      } else {
        const filters = [];
        if (fIn  > 0) filters.push(`afade=t=in:st=0:d=${fIn.toFixed(3)}`);
        if (fOut > 0) filters.push(`afade=t=out:st=${Math.max(0, segDur - fOut).toFixed(3)}:d=${fOut.toFixed(3)}`);
        codecArgs = [...(filters.length ? ['-af', filters.join(',')] : []), ...videoCodec];
      }
    } else {
      return { ok: false, error: `Unsupported output format: ${outExt}` };
    }
    const args = [
      '-hide_banner', '-y',
      '-ss', String(start), '-to', String(end),
      '-i', input,
      ...codecArgs,
      out
    ];
    return ffmpegRun(event, args, out, opId);
  }

  // Fast path: same format in/out, no fades → stream copy (lossless cut).
  const codec = inExt === 'flac'
    ? ['-c:a', 'flac']
    : ['-c', 'copy', '-avoid_negative_ts', 'make_zero'];
  const args = ['-hide_banner', '-y', '-ss', String(start), '-to', String(end), '-i', input, ...codec, out];
  return ffmpegRun(event, args, out, opId);
}

// 4) Extract first embedded subtitle track → SRT
async function xtractSubs(event, { input, opId }) {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  const out = xtractOutputPath(input, '-subs', 'srt');
  const args = ['-hide_banner', '-y', '-i', input, '-map', '0:s:0', out];
  return ffmpegRun(event, args, out, opId);
}

// 5) Frame export → single frame at timestamp as PNG/JPG
async function xtractFrame(event, { input, at, format, opId }) {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  if (!at) return { ok: false, error: 'Timestamp required' };
  const ext = format === 'jpg' ? 'jpg' : 'png';
  const out = xtractOutputPath(input, `-frame-${String(at).replace(/[:.]/g, '_')}`, ext);
  const args = ['-hide_banner', '-y', '-ss', String(at), '-i', input, '-frames:v', '1', '-q:v', '2', out];
  return ffmpegRun(event, args, out, opId);
}

// 6) Concat — joins same-format files via the concat demuxer. Caller supplies
// the additional files; we prepend the primary input as the first entry.
async function xtractConcat(event, { input, extras, opId }) {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  if (!extras || !extras.length) return { ok: false, error: 'Need at least one extra file' };
  const ext = path.extname(input).slice(1) || 'mp4';
  // Build a temp manifest for the concat demuxer. Use OS tmp so we don't
  // require write access to the source folder (which may be read-only).
  const tmpList = path.join(os.tmpdir(), `flux-concat-${Date.now()}.txt`);
  const all = [input, ...extras].map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(tmpList, all);
  const out = xtractOutputPath(input, '-merged', ext);
  const args = ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', tmpList, '-c', 'copy', out];
  const result = await ffmpegRun(event, args, out, opId);
  try { fs.unlinkSync(tmpList); } catch {}
  return result;
}

// 7) Metadata dump — parses ffmpeg's stderr probe output into a JSON sidecar.
// We dropped ffprobe from the bundle (~190 MB Win/Linux, 76 MB Mac) and lean
// on ffmpeg's own `-i` output which carries the same Duration / bitrate /
// sample-rate / codec / metadata-tags info, just unstructured. The parser
// pulls everything into a stable JSON shape that mirrors what the previous
// ffprobe sidecar exposed: { format: {...}, streams: [...], tags: {...} }.
function parseFfmpegMeta(stderr, inputPath) {
  const meta = {
    filename: inputPath,
    format: { name: null, duration_sec: null, start_sec: null, bitrate_kbps: null },
    streams: [],
    tags: {}
  };
  const lines = stderr.split(/\r?\n/);
  let inMetadata = false;
  let lastStreamRef = meta;          // where to attach Metadata blocks
  for (const line of lines) {
    let m;
    if ((m = line.match(/^Input\s+#0,\s*([^,]+),\s*from\s*'(.+)':/))) {
      meta.format.name = m[1].trim();
      inMetadata = false;
      lastStreamRef = meta;
      continue;
    }
    if (/^\s*Metadata:\s*$/.test(line)) { inMetadata = true; continue; }
    if (inMetadata && (m = line.match(/^\s{4}([^:]+?)\s*:\s*(.+?)\s*$/))) {
      const key = m[1].trim().toLowerCase();
      (lastStreamRef.tags = lastStreamRef.tags || {})[key] = m[2].trim();
      continue;
    }
    if ((m = line.match(/^\s*Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)(?:,\s*start:\s*([\d.]+))?(?:,\s*bitrate:\s*(\d+)\s*kb\/s)?/))) {
      meta.format.duration_sec = +m[1]*3600 + +m[2]*60 + parseFloat(m[3]);
      if (m[4]) meta.format.start_sec   = parseFloat(m[4]);
      if (m[5]) meta.format.bitrate_kbps = +m[5];
      inMetadata = false;
      continue;
    }
    if ((m = line.match(/^\s*Stream\s+#0:(\d+)(?:\[\w+\])?(?:\((\w+)\))?:\s*(Audio|Video|Subtitle|Data|Attachment):\s*(.+)$/))) {
      const idx = +m[1], lang = m[2] || null, type = m[3].toLowerCase(), tail = m[4];
      const codec = (tail.split(',')[0] || '').split(' ')[0] || null;
      const stream = { index: idx, type, language: lang, codec, raw: tail.trim() };
      if (type === 'audio') {
        const sr  = tail.match(/(\d+)\s*Hz/);
        const ch  = tail.match(/(mono|stereo|\d+\s*channels?)/i);
        const br  = tail.match(/(\d+)\s*kb\/s/);
        if (sr) stream.sample_rate_hz = +sr[1];
        if (ch) stream.channels       = ch[1].toLowerCase();
        if (br) stream.bitrate_kbps   = +br[1];
      } else if (type === 'video') {
        const dim = tail.match(/,\s*(\d+)x(\d+)\b/);
        const fps = tail.match(/([\d.]+)\s*fps/);
        const br  = tail.match(/(\d+)\s*kb\/s/);
        if (dim) { stream.width = +dim[1]; stream.height = +dim[2]; }
        if (fps) stream.fps = parseFloat(fps[1]);
        if (br)  stream.bitrate_kbps = +br[1];
      }
      meta.streams.push(stream);
      lastStreamRef = stream;
      inMetadata = false;
    }
  }
  return meta;
}

async function xtractMeta(event, { input, opId }) {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  const out = xtractOutputPath(input, '-meta', 'json');
  const ffmpeg = getFfmpegPath();
  return new Promise(resolve => {
    // -hide_banner trims the build-info preamble; the rest of stderr is what
    // we want to parse. Output is to NUL/null since we only care about info.
    const nullSink = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const proc = spawn(ffmpeg, ['-hide_banner', '-i', input, '-f', 'null', nullSink]);
    let err = '';
    proc.stderr.on('data', d => err += d.toString());
    proc.on('error', e => resolve({ ok: false, error: `ffmpeg not found: ${e.message}` }));
    proc.on('close', () => {
      // ffmpeg exits with code 1 on `-f null` because there's no real output;
      // we still get the full probe info on stderr, so we don't gate on code.
      try {
        const meta = parseFfmpegMeta(err, input);
        fs.writeFileSync(out, JSON.stringify(meta, null, 2));
        safeSend(event.sender, 'xtract:progress', { opId, pct: 100 });
        resolve({ ok: true, path: out });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  });
}

// 8) Audio normalize — EBU R128 loudnorm filter. Single-pass for speed.
async function xtractNormalize(event, { input, target, opId }) {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  const ext = path.extname(input).slice(1) || 'mp3';
  const out = xtractOutputPath(input, '-normalized', ext);
  const I = Number.isFinite(target) ? Math.max(-40, Math.min(-5, target)) : -14;
  const args = ['-hide_banner', '-y', '-i', input, '-af', `loudnorm=I=${I}:LRA=11:TP=-1`, out];
  return ffmpegRun(event, args, out, opId);
}

// ─── Unified non-destructive pipeline (Xtract Audio/Video single-window
// editor) ────────────────────────────────────────────────────────────────
// Trim/Concat/Audiotrack/Normalize no longer run ffmpeg individually from
// the renderer — they stage into a pipeline object shown live on the shared
// waveform/video preview, and Save applies the whole thing in ONE call here,
// through temp files in os.tmpdir(), in a fixed order that mirrors the image
// editor's fixed crop→colors→fx→annotations order:
//   concat (assemble the full timeline) → trim (cut the range, +fades) →
//   audiotrack (remove/replace audio) → normalize (final loudness pass)
// Each stage below duplicates the equivalent standalone handler's ffmpeg
// argument-building above rather than refactoring it in place — the
// standalone handlers stay untouched (and independently callable/testable)
// while this new chain is proven out.
function pipelineTmpPath(ext) {
  return path.join(os.tmpdir(), `flux-pipeline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

// `extras`: array of {path, fadeIn, start, end} (plain path strings also
// accepted for back-compat) — a "DJ mix" style queue where each track can
// carry its own fade-in + trim range, in the order the renderer's list has
// them. Any extra that stages a fade/trim gets pre-processed through
// stageTrim first (same logic the standalone Trim path uses, so the result
// matches exactly what the Trim card would have produced for that file) into
// a temp file; everything else is fed straight into the concat demuxer list
// untouched, matching the fast path for the common "just append" case.
async function stageConcat(event, current, extras, opId) {
  const ext = path.extname(current).slice(1).toLowerCase() || 'mp4';
  const tmpFiles = [];
  const resolvedPaths = [];
  for (const extra of extras) {
    const p = typeof extra === 'string' ? extra : extra.path;
    const fadeIn = typeof extra === 'object' ? (Number(extra.fadeIn) || 0) : 0;
    const start = (typeof extra === 'object' && extra.start) ? extra.start : '';
    const end   = (typeof extra === 'object' && extra.end)   ? extra.end   : '';
    if (fadeIn > 0 || (start && end)) {
      const extExt = path.extname(p).slice(1).toLowerCase() || ext;
      let segEnd = end;
      if (!segEnd) {
        const d = await ffmpegProbeDuration(p);
        segEnd = d > 0 ? formatSecondsHMS(d) : null;
      }
      if (segEnd) {
        const r = await stageTrim(event, p, { start: start || '00:00.0', end: segEnd, fadeIn, fadeOut: 0, outputFormat: extExt }, opId);
        if (r.ok) { resolvedPaths.push(r.path); tmpFiles.push(r.path); continue; }
      }
    }
    resolvedPaths.push(p);
  }
  const tmpList = path.join(os.tmpdir(), `flux-pipeline-concat-${Date.now()}.txt`);
  const all = [current, ...resolvedPaths].map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(tmpList, all);
  const out = pipelineTmpPath(ext);
  const args = ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', tmpList, '-c', 'copy', out];
  const r = await ffmpegRun(event, args, out, opId);
  try { fs.unlinkSync(tmpList); } catch {}
  for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch {} }
  return r;
}

// Mirrors the xtractTrim handler's branches (fast copy / re-encode for
// fades or format change / GIF palette pass) but always writes to a temp
// path instead of the final download-folder destination.
async function stageTrim(event, current, { start, end, fadeIn = 0, fadeOut = 0, outputFormat, gif, remuxOnly }, opId) {
  const startSec = parseTimeToSeconds(start);
  const endSec   = parseTimeToSeconds(end);
  if (startSec === null || endSec === null || startSec >= endSec) {
    return { ok: false, error: `Invalid trim range (start="${start}", end="${end}").` };
  }
  const dur = await ffmpegProbeDuration(current);
  if (dur > 0 && (endSec > dur + 0.5 || startSec >= dur)) {
    return { ok: false, error: `Trim range is past the current timeline length (${formatSecondsHMS(dur)}).` };
  }
  const segDur = endSec - startSec;
  const fIn  = Math.max(0, Math.min(Number(fadeIn)  || 0, segDur));
  const fOut = Math.max(0, Math.min(Number(fadeOut) || 0, segDur));

  const inExt  = path.extname(current).slice(1).toLowerCase();
  const outExt = (outputFormat && String(outputFormat).toLowerCase()) || inExt || 'mp4';
  const formatChange = outExt !== inExt;
  const inIsGif  = inExt  === 'gif';
  const outIsGif = outExt === 'gif';
  const out = pipelineTmpPath(outExt);
  const wantFades = fIn > 0 || fOut > 0;

  // "Remux only" — the Xtract editor's checkbox for the case where the only
  // real change is the container/codec (no fades, nothing else staged): a
  // stream copy keeps the exact source quality/size instead of forcing
  // TRIM_VIDEO_CODECS re-encode just because the extension changed. Only
  // offered for containers close enough to swap freely (see
  // CONTAINER_REMUX_EXTS) — anything else genuinely needs a re-encode.
  let remuxEligible = remuxOnly && formatChange && !wantFades && !inIsGif && !outIsGif &&
      CONTAINER_REMUX_EXTS.has(inExt) && CONTAINER_REMUX_EXTS.has(outExt);
  if (remuxEligible && outExt === 'webm') {
    // See WEBM_SAFE_VIDEO/WEBM_SAFE_AUDIO's comment above — verify the
    // SOURCE is actually webm-muxable before trusting a stream copy;
    // otherwise fall through to the re-encode path below, which already
    // targets webm correctly (TRIM_VIDEO_CODECS.webm: libvpx-vp9+libopus).
    const { videoCodec, audioCodec } = await probeCodecs(current);
    const videoOk = !videoCodec || WEBM_SAFE_VIDEO.has(videoCodec);
    const audioOk = !audioCodec || WEBM_SAFE_AUDIO.has(audioCodec);
    remuxEligible = videoOk && audioOk;
  }
  if (remuxEligible) {
    // `-sn` — see xtractConvert's comment: a stream-copy remux still
    // auto-maps the source's subtitle track by default, and the target
    // container may reject its codec outright (fatal mux failure, not a
    // skipped stream), even though video+audio alone copy fine.
    const args = ['-hide_banner', '-y', '-ss', String(start), '-to', String(end), '-i', current, '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-sn', out];
    return ffmpegRun(event, args, out, opId);
  }

  if (wantFades || formatChange) {
    if (outIsGif) {
      const fps    = (gif && Number.isFinite(gif.fps))   ? Math.max(5, Math.min(30, gif.fps))   : 15;
      const widthN = (gif && Number.isFinite(gif.width)) ? gif.width                            : 480;
      const scaleArg = widthN > 0 ? `scale=${widthN}:-1:flags=lanczos,` : '';
      const dKind = (gif && gif.dither) || 'bayer';
      const ditherArg = dKind === 'bayer'           ? 'dither=bayer:bayer_scale=5:diff_mode=rectangle'
                      : dKind === 'sierra2'         ? 'dither=sierra2:diff_mode=rectangle'
                      : dKind === 'floyd_steinberg' ? 'dither=floyd_steinberg:diff_mode=rectangle'
                      :                                'dither=none:diff_mode=rectangle';
      const filter = `[0:v]fps=${fps},${scaleArg}split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=${ditherArg}`;
      const args = ['-hide_banner', '-y', '-ss', String(start), '-to', String(end), '-i', current, '-filter_complex', filter, '-loop', '0', '-an', '-sn', out];
      return ffmpegRun(event, args, out, opId);
    }
    const audioCodec = TRIM_AUDIO_CODECS[outExt];
    const videoCodec = TRIM_VIDEO_CODECS[outExt];
    let codecArgs;
    if (audioCodec && !videoCodec) {
      const filters = [];
      if (fIn  > 0) filters.push(`afade=t=in:st=0:d=${fIn.toFixed(3)}`);
      if (fOut > 0) filters.push(`afade=t=out:st=${Math.max(0, segDur - fOut).toFixed(3)}:d=${fOut.toFixed(3)}`);
      codecArgs = ['-vn', ...(filters.length ? ['-af', filters.join(',')] : []), ...audioCodec];
    } else if (videoCodec) {
      if (inIsGif) {
        const noAudio = [];
        for (let i = 0; i < videoCodec.length; i++) {
          const a = videoCodec[i];
          if (a === '-c:a' || a === '-b:a') { i++; continue; }
          noAudio.push(a);
        }
        codecArgs = [...noAudio, '-an'];
      } else {
        const filters = [];
        if (fIn  > 0) filters.push(`afade=t=in:st=0:d=${fIn.toFixed(3)}`);
        if (fOut > 0) filters.push(`afade=t=out:st=${Math.max(0, segDur - fOut).toFixed(3)}:d=${fOut.toFixed(3)}`);
        codecArgs = [...(filters.length ? ['-af', filters.join(',')] : []), ...videoCodec];
      }
    } else {
      return { ok: false, error: `Unsupported output format: ${outExt}` };
    }
    // `-sn` — same mux-killer as the remuxEligible branch above: a real
    // (non-copy) re-encode still auto-maps the default subtitle track
    // unless told not to, and the target codec/container may not accept it.
    const args = ['-hide_banner', '-y', '-ss', String(start), '-to', String(end), '-i', current, ...codecArgs, '-sn', out];
    return ffmpegRun(event, args, out, opId);
  }

  const codec = inExt === 'flac' ? ['-c:a', 'flac'] : ['-c', 'copy', '-avoid_negative_ts', 'make_zero'];
  const args = ['-hide_banner', '-y', '-ss', String(start), '-to', String(end), '-i', current, ...codec, '-sn', out];
  return ffmpegRun(event, args, out, opId);
}

async function stageAudiotrack(event, current, { mode, audio }, opId) {
  const ext = path.extname(current).slice(1).toLowerCase() || 'mp4';
  if (mode === 'replace') {
    if (!audio || !fs.existsSync(audio)) return { ok: false, error: 'Replacement audio file not found' };
    const out = pipelineTmpPath(ext);
    const acodec = ext === 'webm' ? ['-c:a', 'libopus', '-b:a', '160k'] : ['-c:a', 'aac', '-b:a', '256k'];
    const args = ['-hide_banner', '-y', '-i', current, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...acodec, '-shortest', out];
    return ffmpegRun(event, args, out, opId);
  }
  const out = pipelineTmpPath(ext);
  return ffmpegRun(event, ['-hide_banner', '-y', '-i', current, '-c', 'copy', '-an', out], out, opId);
}

async function stageNormalize(event, current, { target }, opId) {
  const ext = path.extname(current).slice(1).toLowerCase() || 'mp3';
  const out = pipelineTmpPath(ext);
  const I = Number.isFinite(target) ? Math.max(-40, Math.min(-5, target)) : -14;
  const args = ['-hide_banner', '-y', '-i', current, '-af', `loudnorm=I=${I}:LRA=11:TP=-1`, out];
  return ffmpegRun(event, args, out, opId);
}

async function xtractApplyPipeline(event, payload) {
  const { input, concatExtras, trim, audiotrackMode, audiotrackFile, normalize, outputFormat, outputName, outputDir, gif, opId } = payload;
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };

  const tmpFiles = [];
  let current = input;

  try {
    if (concatExtras && concatExtras.length) {
      const r = await stageConcat(event, current, concatExtras, opId);
      if (!r.ok) throw new Error(r.error);
      current = r.path; tmpFiles.push(current);
    }
    if (trim && trim.start && trim.end) {
      const r = await stageTrim(event, current, { ...trim, outputFormat: trim.outputFormat || outputFormat, gif }, opId);
      if (!r.ok) throw new Error(r.error);
      current = r.path; tmpFiles.push(current);
    }
    if (audiotrackMode === 'remove' || (audiotrackMode === 'replace' && audiotrackFile)) {
      const r = await stageAudiotrack(event, current, { mode: audiotrackMode, audio: audiotrackFile }, opId);
      if (!r.ok) throw new Error(r.error);
      current = r.path; tmpFiles.push(current);
    }
    if (normalize && Number.isFinite(normalize.target)) {
      const r = await stageNormalize(event, current, normalize, opId);
      if (!r.ok) throw new Error(r.error);
      current = r.path; tmpFiles.push(current);
    }

    const finalExt = (outputFormat || path.extname(current).slice(1) || path.extname(input).slice(1) || 'mp4').toLowerCase();
    const cfg = loadConfig();
    const dir = outputDir || cfg.download_folder || path.dirname(input);
    fs.mkdirSync(dir, { recursive: true });
    const safeName = (outputName || path.basename(input, path.extname(input))).replace(/[\\/:*?"<>|]/g, '_').trim() || 'output';
    let finalPath = path.join(dir, `${safeName}.${finalExt}`);
    let n = 1;
    while (fs.existsSync(finalPath)) { finalPath = path.join(dir, `${safeName} (${n}).${finalExt}`); n++; }

    if (current === input) {
      // Save was confirmed with nothing actually staged — shouldn't happen
      // (the renderer disables Save on an empty pipeline) but copy through
      // rather than error, so a stray click still produces something sane.
      fs.copyFileSync(current, finalPath);
    } else {
      // `current` lives in os.tmpdir() (pipelineTmpPath) while `dir` is the
      // user's configured download folder — on Windows these are routinely
      // on different drives, and a plain rename() across drives fails with
      // EXDEV ("cross-device link not permitted"). Same fallback already
      // used by engine/images.js's placeImage() for the same reason.
      try {
        fs.renameSync(current, finalPath);
      } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        fs.copyFileSync(current, finalPath);
        fs.unlinkSync(current);
      }
      const idx = tmpFiles.indexOf(current);
      if (idx !== -1) tmpFiles.splice(idx, 1);
    }
    return { ok: true, path: finalPath };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch {} }
  }
}

// Lightweight duration probe used by the renderer right after file pick to
// display "Duration: HH:MM:SS" next to the filename, so the user can't enter
// trim values past the actual file length.
async function xtractProbe({ input }) {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  const dur = await ffmpegProbeDuration(input);
  if (dur <= 0) return { ok: false, error: 'Cannot read duration' };
  // `size`: lets the renderer skip WaveSurfer's own decode for huge files
  // (see ensureTrimEditor) — WaveSurfer materializes the ENTIRE file as one
  // in-memory Blob before decoding for the waveform, which is a known
  // Chromium failure point on files above roughly 1 GB ("The requested
  // file could not be read..." — a real Chromium Blob-size limitation, not
  // an actual permission problem despite the message). The <video>/<audio>
  // element's own native playback is unaffected — it streams via Range
  // requests and never materializes the whole file at once.
  let size = 0;
  try { size = fs.statSync(input).size; } catch {}
  // videoCodec/audioCodec: lets the renderer catch an audio-codec-only
  // incompatibility (classic H.264+AC-3 movie rip) for a file big enough to
  // skip WaveSurfer (see ensureTrimEditor's WAVEFORM_MAX_BYTES branch) —
  // below that threshold WaveSurfer's OWN separate decode attempt already
  // fails on AC-3 and triggers the existing error-driven remux flow, but a
  // file over the skip threshold never creates a WaveSurfer instance at
  // all, so that failure (and the native <video> element silently playing
  // video with NO audio and no error — confirmed live, no MediaError ever
  // fires for an unsupported secondary audio track) was never caught.
  const { videoCodec, audioCodec } = await probeCodecs(input);
  const audioSafe = audioCodec == null || CHROMIUM_SAFE_AUDIO.has(audioCodec);
  return { ok: true, duration: dur, formatted: formatSecondsHMS(dur), size, videoCodec, audioCodec, audioSafe };
}

// ffmpeg availability — XTRACT tab uses this to show a friendly disabled state
// when ffmpeg is missing entirely (no vendor binary AND not in PATH).
function xtractCheckFfmpeg() {
  return new Promise(resolve => {
    const ffmpegPath = getFfmpegPath();
    // Surface the resolved path + existence/exec bit so when the spawn fails
    // we can tell apart: missing file vs. no +x vs. quarantine block vs.
    // binary crashes at startup (dyld dylib mismatch, etc).
    const isAbsolute = path.isAbsolute(ffmpegPath);
    const exists     = isAbsolute && fs.existsSync(ffmpegPath);
    let mode = null, isExec = null;
    if (exists) {
      try {
        const st = fs.statSync(ffmpegPath);
        mode = (st.mode & 0o777).toString(8);
        isExec = !!(st.mode & 0o111);
      } catch {}
    }
    const ctx = `path=${ffmpegPath} absolute=${isAbsolute} exists=${exists} mode=${mode} exec=${isExec}`;
    log('INFO', `xtract:checkFfmpeg ${ctx}`);

    const proc = spawn(ffmpegPath, ['-version']);
    let ok = false;
    let stderrBuf = '';
    proc.stdout.on('data', () => { ok = true; });
    proc.stderr.on('data', d => { stderrBuf += d.toString(); });
    proc.on('error', e => {
      log('ERROR', `xtract:checkFfmpeg spawn error: ${e.message} (${ctx})`);
      resolve({ ok: false, error: `ffmpeg not runnable — ${e.message} [${ctx}]` });
    });
    proc.on('close', code => {
      if (ok && code === 0) return resolve({ ok: true });
      const tail = stderrBuf.trim().slice(-400);
      log('ERROR', `xtract:checkFfmpeg exit ${code} stderr-tail="${tail}" (${ctx})`);
      resolve({ ok: false, error: `ffmpeg exit ${code} — ${tail || 'no stderr'} [${ctx}]` });
    });
  });
}

// ─── PREVIEW REMUX — Chromium can't play everything ffmpeg can decode ─────
// Old .avi (Chromium never shipped a full AVI demuxer) and some WebM VP9+
// Opus combos trip the browser's own player even though ffmpeg (which does
// the REAL edit) handles them fine. Rather than leave the editor unusable,
// make a disposable preview copy Chromium CAN play and load THAT into the
// trim editor instead — the original file, and `xtractInput` (what Save
// actually operates on), are never touched.
//
// A plain "-c copy, and if ffmpeg accepts it call it done" isn't enough:
// ffmpeg will happily stream-copy ANY codec into an mp4/m4a container
// without complaint — that fixes a pure CONTAINER problem (e.g. H.264
// wrapped in .avi) but does nothing for a CODEC Chromium never had a
// decoder for at all (old MPEG-4 Part 2 / Xvid / DivX video, AC-3 audio —
// both common in exactly the kind of downloaded-movie .avi/.mkv this
// feature exists for), which would silently produce an equally unplayable
// "fixed" file. So: probe the actual codecs first (same ffmpeg-stderr-
// parsing trick as ffmpegProbeDuration, no ffprobe dependency) and only
// trust a stream-copy for a stream whose codec is already in Chromium's
// real decoder set.
//
// Three tiers, cheapest viable one wins — this matters most for a large
// movie file, where "cheapest" is the difference between a few seconds
// and several minutes:
//   1. Both streams already Chromium-safe → full copy (container-only).
//   2. Video safe, audio isn't (classic "H.264 + AC-3 movie rip") → copy
//      video, transcode ONLY the audio — the video data (the vast bulk of
//      a movie's bytes) is never re-encoded.
//   3. Video codec itself unsafe (old Xvid/DivX/WMV) → full transcode.
// 'veryfast' preset throughout: this is a throwaway preview, not the
// deliverable (the real Save/pipeline runs the user's actual settings on
// the ORIGINAL file) — encode speed matters more than ratio here. Every
// ffmpeg call reuses ffmpegRun, so the same `xtract:progress` events the
// Save modal's bar already listens for work here for free.
const CHROMIUM_SAFE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const CHROMIUM_SAFE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
function probeCodecs(inputPath) {
  return new Promise(resolve => {
    const proc = spawn(getFfmpegPath(), ['-hide_banner', '-i', inputPath]);
    let buf = '';
    proc.stderr.on('data', d => { buf += d.toString(); });
    const done = () => {
      const vm = buf.match(/Stream #\d+:\d+[^\n]*:\s*Video:\s*([a-zA-Z0-9_]+)/);
      const am = buf.match(/Stream #\d+:\d+[^\n]*:\s*Audio:\s*([a-zA-Z0-9_]+)/);
      resolve({ videoCodec: vm ? vm[1].toLowerCase() : null, audioCodec: am ? am[1].toLowerCase() : null });
    };
    proc.on('close', done);
    proc.on('error', done);
  });
}
// Cancel support: a large movie can genuinely take minutes to transcode,
// with no way out otherwise (added after real large-file testing). Tracked
// per opId — activeRemuxProcs holds the CURRENTLY running child process (a
// fresh one replaces the previous entry when a tier falls through to the
// next), cancelledRemuxOps records that the user asked to stop so a killed
// process's resulting failure is reported as a cancellation, not fed into
// the next fallback tier.
const activeRemuxProcs = new Map();
const cancelledRemuxOps = new Set();
function xtractCancelPreviewRemux({ opId } = {}) {
  if (opId == null) return { ok: false, error: 'opId required' };
  cancelledRemuxOps.add(opId);
  const proc = activeRemuxProcs.get(opId);
  if (proc) { try { proc.kill('SIGTERM'); } catch {} }
  return { ok: true };
}
async function xtractPreviewRemux(event, { input, opId, kind } = {}) {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  // Output extension must match the ORIGINAL kind (audio vs video) — the
  // renderer's detectMediaKind() reads it back from the extension alone to
  // decide which editor mode (audio waveform vs video+waveform) to show,
  // and an audio source remuxed into a bare .mp4 would misclassify as
  // 'video'. `-vn` on the audio path drops any embedded cover-art stream
  // too, so there's no stray video track to confuse anything downstream.
  const isAudio = kind === 'audio';
  const out = pipelineTmpPath(isAudio ? 'm4a' : 'mp4');
  const run = args => ffmpegRun(event, args, out, opId, { onProc: p => activeRemuxProcs.set(opId, p) });
  const cancelled = () => cancelledRemuxOps.has(opId);
  try {
    const { videoCodec, audioCodec } = await probeCodecs(input);
    const audioSafe = audioCodec == null || CHROMIUM_SAFE_AUDIO.has(audioCodec);

    if (isAudio) {
      if (audioSafe) {
        const r = await run(['-hide_banner', '-y', '-i', input, '-vn', '-c:a', 'copy', out]);
        if (r.ok) return { ok: true, path: out, transcoded: false };
        try { fs.unlinkSync(out); } catch {}
        if (cancelled()) return { ok: false, cancelled: true };
      }
      const r2 = await run(['-hide_banner', '-y', '-i', input, '-vn', '-c:a', 'aac', '-b:a', '192k', out]);
      if (!r2.ok) {
        try { fs.unlinkSync(out); } catch {}
        return cancelled() ? { ok: false, cancelled: true } : r2;
      }
      return { ok: true, path: out, transcoded: true };
    }

    const videoSafe = CHROMIUM_SAFE_VIDEO.has(videoCodec);
    if (videoSafe && audioSafe) {
      const r = await run(['-hide_banner', '-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', out]);
      if (r.ok) return { ok: true, path: out, transcoded: false };
      try { fs.unlinkSync(out); } catch {}
      if (cancelled()) return { ok: false, cancelled: true };
    } else if (videoSafe) {
      // Video copy + audio-only transcode — the fast path for the common
      // "movie with AC-3/DTS audio" case.
      const r = await run(['-hide_banner', '-y', '-i', input, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
      if (r.ok) return { ok: true, path: out, transcoded: true };
      try { fs.unlinkSync(out); } catch {}
      if (cancelled()) return { ok: false, cancelled: true };
    }
    const r2 = await run(['-hide_banner', '-y', '-i', input, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
    if (!r2.ok) {
      try { fs.unlinkSync(out); } catch {}
      return cancelled() ? { ok: false, cancelled: true } : r2;
    }
    return { ok: true, path: out, transcoded: true };
  } finally {
    activeRemuxProcs.delete(opId);
    cancelledRemuxOps.delete(opId);
  }
}

// Deletes a temp preview-remux file once the editor moves on (new file
// loaded, or torn down). Restricted to our OWN naming convention under the
// OS temp dir — never a generic "delete this path" endpoint, since the
// path arrives from the client.
function xtractCleanupPreviewRemux({ path: p } = {}) {
  if (!p) return { ok: true };
  if (path.dirname(p) !== os.tmpdir() || !/^flux-pipeline-/.test(path.basename(p))) {
    return { ok: false, error: 'refused' };
  }
  try { fs.unlinkSync(p); } catch {}
  return { ok: true };
}

// ─── Xtract "Capture" sub-panel (screenshot/recording save) + PDF-page /
// annotate save — the parts of that panel that are plain fs writes (no
// Chromium window needed). Screen/window source listing and URL capture
// (capture:listSources, convert:fromUrl, convert:imagesToPdf) genuinely need
// an Electron BrowserWindow/desktopCapturer and stay hand-written in main.js.

// Save a screenshot (data URL from a <canvas>.toDataURL) to the download folder.
// Returns the absolute path so the renderer can auto-load it into the editor.
function captureSaveImage({ dataUrl, format }) {
  try {
    const cfg = loadConfig();
    const folder = cfg.download_folder;
    fs.mkdirSync(folder, { recursive: true });
    const ext = format === 'jpg' ? '.jpg' : '.png';
    const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const filePath = path.join(folder, `screenshot-${ts}${ext}`);
    const m = /^data:image\/[a-z]+;base64,(.+)$/.exec(dataUrl || '');
    if (!m) return { ok: false, error: 'Invalid data URL' };
    fs.writeFileSync(filePath, Buffer.from(m[1], 'base64'));
    log('INFO', `capture:saveImage -> ${filePath}`);
    return { ok: true, path: filePath };
  } catch (e) {
    log('ERROR', `capture:saveImage: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// Save a MediaRecorder-produced ArrayBuffer (WebM container, Opus audio, VP8/9
// video) and optionally remux/transcode to a friendlier format via ffmpeg.
// kind='audio' → audio-only output; kind='video' → video+audio.
async function captureSaveRecording({ buffer, kind, convert } = {}) {
  try {
    if (!buffer || !buffer.byteLength) return { ok: false, error: 'Empty recording buffer' };
    const cfg = loadConfig();
    const folder = cfg.download_folder;
    fs.mkdirSync(folder, { recursive: true });
    const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const isAudio  = kind === 'audio';
    const baseName = (isAudio ? 'recording-audio' : 'recording-screen') + '-' + ts;
    const rawPath  = path.join(folder, baseName + '.webm');
    fs.writeFileSync(rawPath, Buffer.from(buffer));
    log('INFO', `capture:saveRecording -> ${rawPath} (${buffer.byteLength} bytes, kind=${kind}, convert=${convert || 'none'})`);

    // Optional ffmpeg transcode to a more universally compatible format. The
    // raw WebM works in most players but Windows Media Player and many simple
    // viewers can't open it — MP3/MP4 makes the file usable everywhere.
    //
    // Even when keeping WebM, we MUST run it through ffmpeg with `-c copy`
    // to re-mux the container: MediaRecorder writes "live" WebM with a
    // duration field of Infinity (no final cluster written). WaveSurfer and
    // many other players hang on the decode step waiting for a duration
    // they'll never get. The remux rewrites the metadata properly without
    // re-encoding — fast, lossless.
    const ffmpegPath = getFfmpegPath();
    if (!ffmpegPath) return { ok: true, path: rawPath };
    const sameExt = (!convert || convert === 'webm');
    // When the output extension matches the input (webm → webm remux),
    // we can't write to outPath directly because ffmpeg would be reading
    // and writing the same file. Stage to a sibling .tmp.webm then rename.
    const outPath = path.join(folder, baseName + '.' + (convert || 'webm'));
    const ffOut   = sameExt ? path.join(folder, baseName + '.remux.webm') : outPath;
    let args;
    if (!convert || convert === 'webm') {
      // Remux only — fix the duration metadata, no codec change.
      args = ['-i', rawPath, '-y', '-c', 'copy', ffOut];
    } else if (isAudio) {
      // MP3: libmp3lame + ID3v2.3 for Windows Media Player compatibility.
      // M4A: AAC in MP4 container.
      if (convert === 'mp3') {
        args = ['-i', rawPath, '-y', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-id3v2_version', '3', '-write_xing', '1', outPath];
      } else if (convert === 'm4a') {
        args = ['-i', rawPath, '-y', '-vn', '-c:a', 'aac', '-b:a', '192k', outPath];
      } else {
        args = ['-i', rawPath, '-y', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', outPath];
      }
    } else {
      // MP4: H.264 video + AAC audio, fast preset for reasonable encode time.
      args = ['-i', rawPath, '-y', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outPath];
    }
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, args);
      let err = '';
      proc.stderr.on('data', d => { err += d.toString(); });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(err.slice(-500) || `ffmpeg exit ${code}`)));
      proc.on('error', reject);
    });
    // For the same-ext remux path: replace the raw with the remuxed copy
    // (different ext during ffmpeg, same final name). For cross-format
    // transcodes the raw is just deleted.
    if (sameExt) {
      try { fs.unlinkSync(rawPath); } catch {}
      fs.renameSync(ffOut, outPath);
    } else if (rawPath !== outPath) {
      try { fs.unlinkSync(rawPath); } catch {}
    }
    return { ok: true, path: outPath };
  } catch (e) {
    log('ERROR', `capture:saveRecording: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// Save an annotated raster image — the fabric.js canvas flattened to a
// data URL by the renderer. Output sits next to the original with a
// `-annotated-<ts>.png` suffix so the user can still find the source.
function convertSaveAnnotated({ dataUrl, baseName } = {}) {
  try {
    const cfg = loadConfig();
    const folder = cfg.download_folder;
    fs.mkdirSync(folder, { recursive: true });
    const safe = (baseName || 'image').replace(/[^a-z0-9.-]/gi, '_');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const filePath = path.join(folder, `${safe}-annotated-${ts}.png`);
    const m = /^data:image\/[a-z]+;base64,(.+)$/.exec(dataUrl || '');
    if (!m) return { ok: false, error: 'Invalid data URL' };
    fs.writeFileSync(filePath, Buffer.from(m[1], 'base64'));
    log('INFO', `convert:saveAnnotated -> ${filePath}`);
    return { ok: true, path: filePath };
  } catch (e) {
    log('ERROR', `convert:saveAnnotated: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// Save rasterised PDF pages (from pdf.js in the renderer) into a stable
// subfolder of the download folder. Renderer sends one base64 PNG per page;
// we drop them into `pdf-pages/<source-stub>-pNNN.png` so they survive across
// runs and the user can open the folder to find them.
function convertSavePdfPage({ dataUrl, baseName, pageNum } = {}) {
  try {
    const cfg = loadConfig();
    const folder = path.join(cfg.download_folder, 'pdf-pages');
    fs.mkdirSync(folder, { recursive: true });
    const safe = (baseName || 'pdf').replace(/[^a-z0-9.-]/gi, '_');
    const pageStr = String(pageNum || 1).padStart(3, '0');
    const filePath = path.join(folder, `${safe}-p${pageStr}.png`);
    const m = /^data:image\/[a-z]+;base64,(.+)$/.exec(dataUrl || '');
    if (!m) return { ok: false, error: 'Invalid data URL' };
    fs.writeFileSync(filePath, Buffer.from(m[1], 'base64'));
    return { ok: true, path: filePath };
  } catch (e) {
    log('ERROR', `convert:savePdfPage: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  ffmpegRun, ffmpegProbeDuration, xtractOutputPath, parseTimeToSeconds, formatSecondsHMS,
  probeDuration, hasAudio, xtractProbe, xtractCheckFfmpeg,
  captureSaveImage, captureSaveRecording, convertSaveAnnotated, convertSavePdfPage,
  routes: [
    { channel: 'xtract:audio',      method: 'POST', path: '/api/xtract/audio',      fn: 'xtractAudio',      args: (body, sender) => [{ sender }, body] },
    { channel: 'xtract:convert',    method: 'POST', path: '/api/xtract/convert',    fn: 'xtractConvert',    args: (body, sender) => [{ sender }, body] },
    { channel: 'xtract:audiotrack', method: 'POST', path: '/api/xtract/audiotrack', fn: 'xtractAudiotrack', args: (body, sender) => [{ sender }, body] },
    { channel: 'xtract:resize',     method: 'POST', path: '/api/xtract/resize',     fn: 'xtractResize',     args: (body, sender) => [{ sender }, body] },
    { channel: 'xtract:compress',   method: 'POST', path: '/api/xtract/compress',   fn: 'xtractCompress',   args: (body, sender) => [{ sender }, body] },
    { channel: 'xtract:trim',       method: 'POST', path: '/api/xtract/trim',       fn: 'xtractTrim',       args: (body, sender) => [{ sender }, body] },
    { channel: 'xtract:subs',       method: 'POST', path: '/api/xtract/subs',       fn: 'xtractSubs',       args: (body, sender) => [{ sender }, body] },
    { channel: 'xtract:frame',      method: 'POST', path: '/api/xtract/frame',      fn: 'xtractFrame',      args: (body, sender) => [{ sender }, body] },
    { channel: 'xtract:concat',     method: 'POST', path: '/api/xtract/concat',     fn: 'xtractConcat',     args: (body, sender) => [{ sender }, body] },
    { channel: 'xtract:meta',       method: 'POST', path: '/api/xtract/meta',       fn: 'xtractMeta',       args: (body, sender) => [{ sender }, body] },
    { channel: 'xtract:normalize',  method: 'POST', path: '/api/xtract/normalize',  fn: 'xtractNormalize',  args: (body, sender) => [{ sender }, body] },
    { channel: 'xtract:applyPipeline', method: 'POST', path: '/api/xtract/applyPipeline', fn: 'xtractApplyPipeline', args: (body, sender) => [{ sender }, body] },
    { channel: 'xtract:probe',      method: 'POST', path: '/api/xtract/probe',      fn: 'xtractProbe',      args: body => [body] },
    { channel: 'xtract:checkFfmpeg', method: 'GET', path: '/api/xtract/checkFfmpeg', fn: 'xtractCheckFfmpeg', args: () => [] },
    { channel: 'xtract:previewRemux', method: 'POST', path: '/api/xtract/previewRemux', fn: 'xtractPreviewRemux', args: (body, sender) => [{ sender }, body] },
    { channel: 'xtract:cancelPreviewRemux', method: 'POST', path: '/api/xtract/cancelPreviewRemux', fn: 'xtractCancelPreviewRemux', args: body => [body] },
    { channel: 'xtract:cleanupPreviewRemux', method: 'POST', path: '/api/xtract/cleanupPreviewRemux', fn: 'xtractCleanupPreviewRemux', args: body => [body] },
    { channel: 'capture:saveImage', method: 'POST', path: '/api/capture/saveImage', fn: 'captureSaveImage', args: body => [body] },
    { channel: 'capture:saveRecording', method: 'POST', path: '/api/capture/saveRecording', fn: 'captureSaveRecording', args: body => [body], binary: true },
    { channel: 'convert:saveAnnotated', method: 'POST', path: '/api/convert/saveAnnotated', fn: 'convertSaveAnnotated', args: body => [body] },
    { channel: 'convert:savePdfPage', method: 'POST', path: '/api/convert/savePdfPage', fn: 'convertSavePdfPage', args: body => [body] },
  ],
  // Exported for wireIpc/wireRest to bind — routes[] above references these
  // by name via mod[route.fn](...).
  xtractAudio, xtractConvert, xtractAudiotrack, xtractResize, xtractCompress,
  xtractTrim, xtractSubs, xtractFrame, xtractConcat, xtractMeta, xtractNormalize,
  xtractApplyPipeline, xtractPreviewRemux, xtractCancelPreviewRemux, xtractCleanupPreviewRemux,
};
