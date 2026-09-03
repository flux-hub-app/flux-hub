'use strict';

/**
 * ai-engine.js — shared local-AI engine for FLUX. One function per AI
 * capability (today: transcribe via Whisper); consumed by Xtract (and future
 * modules — bg removal, upscale) through main.js IPC handlers. Never a UI
 * destination of its own — this is the "shared engine, not a dedicated
 * module" answer to the architecture question in flux-ai-modules-planning.
 * See .claude/design/flux-patterns.md for the pattern this follows.
 *
 * transcribe() shells out to a locally-fetched whisper.cpp CLI binary (see
 * binary-fetcher.js — 'whisper' binary id, 'whisper-model-tiny'/'-base'
 * model ids), after first extracting the input's audio to 16-bit 16kHz mono
 * WAV via ffmpeg — whisper.cpp only accepts that exact format.
 */

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

function extractWav16k(ffmpegPath, inputPath, outWavPath) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outWavPath];
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', e => reject(new Error(`ffmpeg not runnable: ${e.message}`)));
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
      resolve();
    });
  });
}

// whisper-cli has no clean percentage progress to parse (unlike ffmpeg's
// "time=" stderr lines) — every stdout/stderr chunk just means "still
// working", so callers get an indeterminate 'transcribing' phase instead of
// a real pct. `-of <outBase>` makes it write `<outBase>.srt` directly
// (no txt/vtt/json requested).
function runWhisperCli(whisperPath, modelPath, wavPath, outBase, language, translate, onProgress) {
  return new Promise((resolve, reject) => {
    // whisper-cli defaults -l to "en" when omitted (NOT auto-detect) — always
    // pass it explicitly so a caller that doesn't specify a language still
    // gets real language auto-detection instead of silently English-only.
    // -tr/--translate is whisper's own built-in translate-to-English task —
    // no separate translation engine needed for that one target language;
    // any OTHER target language needs a real translation step (not this).
    const args = ['-m', modelPath, '-f', wavPath, '-of', outBase, '-osrt', '-l', language || 'auto'];
    if (translate) args.push('-tr');
    const proc = spawn(whisperPath, args);
    let stderr = '';
    proc.stdout.on('data', () => onProgress && onProgress({ phase: 'transcribing' }));
    proc.stderr.on('data', d => { stderr += d; onProgress && onProgress({ phase: 'transcribing' }); });
    proc.on('error', e => reject(new Error(`whisper not runnable: ${e.message}`)));
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`whisper exit ${code}: ${stderr.slice(-400)}`));
      resolve();
    });
  });
}

/**
 * Transcribes inputPath's audio to an SRT sidecar using a locally-fetched
 * whisper.cpp binary + model.
 * @param {string} inputPath  Any media file ffmpeg can read.
 * @param {{ ffmpegPath:string, whisperPath:string, modelPath:string, language?:string, translate?:boolean, outputDir?:string }} opts
 *   `language` is the SPOKEN language hint ('auto' lets whisper detect it).
 *   `translate` uses whisper's own translate-to-English task — it can only
 *   ever produce English text, it does not translate to other languages
 *   (that needs a separate translation engine, not built yet).
 * @param {(p:{phase:string}) => void} [onProgress]
 * @returns {Promise<{ok:boolean, path?:string, error?:string}>}
 */
async function transcribe(inputPath, opts, onProgress) {
  const { ffmpegPath, whisperPath, modelPath, language, translate } = opts;
  if (!inputPath || !fs.existsSync(inputPath)) return { ok: false, error: 'Input file not found' };
  if (!whisperPath || !fs.existsSync(whisperPath)) return { ok: false, error: 'Whisper binary not found — fetch it from Settings first' };
  if (!modelPath || !fs.existsSync(modelPath))     return { ok: false, error: 'Whisper model not found — fetch it from Settings first' };

  const outDir  = opts.outputDir || path.dirname(inputPath);
  const base    = path.basename(inputPath, path.extname(inputPath));
  const outBase = path.join(outDir, `${base}-ai-subs`);
  const tmpWav  = path.join(os.tmpdir(), `flux-whisper-${Date.now()}.wav`);

  try {
    onProgress && onProgress({ phase: 'extracting-audio' });
    await extractWav16k(ffmpegPath, inputPath, tmpWav);
    onProgress && onProgress({ phase: 'transcribing' });
    await runWhisperCli(whisperPath, modelPath, tmpWav, outBase, language, translate, onProgress);
    const srtPath = `${outBase}.srt`;
    if (!fs.existsSync(srtPath) || fs.statSync(srtPath).size === 0) {
      return { ok: false, error: 'Whisper produced no output (empty or missing .srt)' };
    }
    return { ok: true, path: srtPath };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { fs.unlinkSync(tmpWav); } catch {}
  }
}

module.exports = { transcribe };
