'use strict';

// engine/ai.js — AI-generated subtitles (local speech-to-text via ai-engine.js,
// whisper.cpp under the hood). Extracted verbatim from main.js (Fase G, Step 3,
// 2026-09-03) — audited Electron-free: ai-engine.js and binary-fetcher.js
// (both project-root, required below) have no Electron import; binary-fetcher.js
// already degrades gracefully when Electron's `net` isn't available (see its
// own header), the same pattern server.js already relies on for
// /api/binary/fetch.
const path = require('path');
const fs = require('fs');
const aiEngine = require('../ai-engine');
const binaryFetcher = require('../binary-fetcher');
const enginePaths = require('./paths');
const { getFfmpegPath } = require('./binaries');
const { loadConfig } = require('./config');
const { safeSend } = require('./bus');

// 4b) AI-generated subtitles — works on any file's own audio, no embedded
// subtitle track needed (unlike engine/xtract.js's xtractSubs).
async function aiTranscribe(event, { input, model, language, translate, opId }) {
  if (!input || !fs.existsSync(input)) return { ok: false, error: 'Input file not found' };
  const { vendorDir } = enginePaths.getPaths();
  const modelId = model === 'base' ? 'whisper-model-base' : 'whisper-model-tiny';
  const whisperPath = path.join(vendorDir, binaryFetcher.binFilename('whisper', process.platform));
  const modelPath   = path.join(vendorDir, binaryFetcher.binFilename(modelId, process.platform));
  const cfg = loadConfig();
  const result = await aiEngine.transcribe(
    input,
    { ffmpegPath: getFfmpegPath(), whisperPath, modelPath, language, translate: !!translate, outputDir: cfg.download_folder },
    p => safeSend(event.sender, 'ai:progress', { opId, ...p })
  );
  if (result.ok) safeSend(event.sender, 'ai:progress', { opId, phase: 'done' });
  return result;
}

module.exports = {
  aiTranscribe,
  routes: [
    { channel: 'ai:transcribe', method: 'POST', path: '/api/ai/transcribe', fn: 'aiTranscribe', args: (body, sender) => [{ sender }, body] },
  ],
};
