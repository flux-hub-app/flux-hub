'use strict';

// engine/images.js — sharp-driven image bulk operations (Images tab batch ops
// + the single-image editor used from Xtract > Image: crop/fx/recolor/rmbg/
// annotate/applyPipeline) + the EXIF-based image library organizer. Extracted
// verbatim from main.js (Fase G, Step 3, 2026-09-03) — audited Electron-free:
// every op is sharp/fs/path, `images:toVideo` reuses engine/xtract.js's
// ffmpegRun (same `{sender}` duck-typed progress object, not a direct
// Electron API).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { log } = require('./log');
const { loadConfig } = require('./config');
const { getFfmpegPath } = require('./binaries');
const { ffmpegRun } = require('./xtract');
// Shared safeSend (isDestroyed check + logged catch) instead of each
// handler hand-rolling its own bare try/catch around event.sender.send —
// flagged during the Fase G Step 1-2 audit (2026-08-25) as the one real
// inconsistency in this module's original main.js code, fixed here as part
// of Step 3's extraction.
const { safeSend: busSafeSend } = require('./bus');

// Loaded lazily so a missing sharp install (e.g. ARM/Mac dev box without
// rebuild) only fails when the user opens Image Editor, not at boot.
let _sharp = null;
let _sharpLoadError = null;
function getSharp() {
  if (_sharp === null) {
    try { _sharp = require('sharp'); }
    catch (e) { log('ERROR', `sharp load failed: ${e.message}`); _sharp = false; _sharpLoadError = e.message; }
  }
  return _sharp || null;
}
// The real reason (native binding mismatch, missing shared lib, etc.) was
// only ever logged server-side — every `{ok:false, error:'sharp not
// available'}` the client actually saw dropped it, making "sharp not
// available" undiagnosable without separately checking server logs. Now
// included directly in the error every caller already returns.
function sharpNotAvailableMsg() {
  return _sharpLoadError ? `sharp not available: ${_sharpLoadError}` : 'sharp not available';
}

// Single supported-formats set used by the loader + listing. Sharp handles
// these natively; HEIC needs libheif (compiled into sharp on Win/Mac/Linux
// 0.32+). RAW formats (CR2/NEF/ARW) need dcraw — out of scope for now.
// SVG is input-only: sharp rasterises it on load via librsvg, but cannot
// write SVG back out — every image-batch operation produces a raster format
// (jpg/png/webp). The image editor (Fabric) needs loadSVGFromURL instead of
// FabricImage.fromURL for SVG inputs (see ensureImageEditor in renderer.js).
const IMG_EXTS = new Set(['jpg','jpeg','png','webp','avif','tiff','tif','gif','bmp','heic','heif','svg']);

// Resolve the destination path for a per-file image op based on the
// caller's Output preferences (overwrite / outputFolder / fallback to
// next-to-source with a suffix). Centralised here so every handler
// (convert / resize / strip / rotate / heic / watermark / compress) gets
// the same path semantics. Side-effect: ensures outputFolder exists.
//   overwrite   → write back to source path (replaces extension if ext given)
//   outputFolder→ write into that folder (mkdir -p), no suffix
//   default     → src dir + suffix + ext
function resolveImageOut({ srcPath, overwrite, outputFolder, suffix, ext }) {
  const srcExt = path.extname(srcPath);
  const baseName = path.basename(srcPath, srcExt);
  // SVG is input-only for sharp (rasterised on read via librsvg, no writer
  // exists). For every operation that defaults to preserving the source
  // extension (resize, stripExif, watermark, fx, …) silently rewrite the
  // output to PNG when the source is SVG — otherwise sharp throws
  // "unsupported output format svg" at toFile() time.
  let finalExt = ext ? '.' + ext.replace(/^\./, '') : srcExt;
  if (!ext && /^\.svg$/i.test(srcExt)) finalExt = '.png';
  if (overwrite) {
    return path.join(path.dirname(srcPath), baseName + finalExt);
  }
  if (outputFolder) {
    try { fs.mkdirSync(outputFolder, { recursive: true }); } catch {}
    return path.join(outputFolder, baseName + finalExt);
  }
  return path.join(path.dirname(srcPath), baseName + (suffix || '') + finalExt);
}

async function imagesLoad({ paths, folder, recursive }) {
  // Two modes: explicit file list (from drag-drop / pick), or a folder
  // walk (recursive optional). Returns metadata for each image so the
  // renderer can show thumbnails + dimensions without re-stating.
  const out = [];
  const sharp = getSharp();
  const collect = async (p) => {
    if (!fs.existsSync(p)) return;
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      if (!recursive && p !== folder) return;
      for (const entry of fs.readdirSync(p)) await collect(path.join(p, entry));
      return;
    }
    const ext = path.extname(p).slice(1).toLowerCase();
    if (!IMG_EXTS.has(ext)) return;
    let width = 0, height = 0;
    if (sharp) {
      try { const m = await sharp(p).metadata(); width = m.width || 0; height = m.height || 0; }
      catch {}
    }
    out.push({ path: p, name: path.basename(p), ext, size: stat.size, width, height });
  };
  if (Array.isArray(paths)) for (const p of paths) await collect(p);
  if (folder) await collect(folder);
  return { ok: true, files: out };
}

async function imagesThumbnail({ input, maxSize = 96 }) {
  // 96-px JPEG thumbnail returned as a base64 data URI for the file list.
  // Cheap: sharp's resize is sub-millisecond per image even at full res.
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: sharpNotAvailableMsg() };
  try {
    const buf = await sharp(input).rotate().resize(maxSize, maxSize, { fit: 'cover' }).jpeg({ quality: 70 }).toBuffer();
    return { ok: true, dataUri: 'data:image/jpeg;base64,' + buf.toString('base64') };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Rename takes a pattern with tokens ({name},{ext},{n},{nn},{nnn},{date},
// {time},{w},{h}) and a starting counter. Returns the new path for each
// success + a list of failures. `overwrite` is irrelevant here — rename
// is always in-place (that's the point).
function imagesRename({ files, pattern, start }) {
  const out = [];
  const fails = [];
  let counter = Math.max(0, parseInt(start, 10) || 0);
  const today = new Date();
  const datePart = today.toISOString().slice(0, 10);
  const timePart = today.toTimeString().slice(0, 8).replace(/:/g, '');
  for (const f of files) {
    const idx = counter++;
    const newName = (pattern || '{name}-{nn}.{ext}')
      .replace(/{name}/g, path.basename(f.path, path.extname(f.path)))
      .replace(/{ext}/g,  f.ext)
      .replace(/{nnn}/g,  String(idx).padStart(3, '0'))
      .replace(/{nn}/g,   String(idx).padStart(2, '0'))
      .replace(/{n}/g,    String(idx))
      .replace(/{date}/g, datePart)
      .replace(/{time}/g, timePart)
      .replace(/{w}/g,    String(f.width || ''))
      .replace(/{h}/g,    String(f.height || ''));
    // Sanitize: drop chars Windows refuses, collapse whitespace.
    const safeName = newName.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
    if (!safeName) { fails.push({ path: f.path, error: 'empty pattern output' }); continue; }
    const target = path.join(path.dirname(f.path), safeName);
    if (target === f.path) { out.push({ from: f.path, to: target, skipped: true }); continue; }
    try {
      if (fs.existsSync(target)) throw new Error('target exists');
      fs.renameSync(f.path, target);
      out.push({ from: f.path, to: target });
    } catch (e) {
      fails.push({ path: f.path, error: e.message });
    }
  }
  return { ok: true, renamed: out, failed: fails };
}

async function imagesConvert({ files, format, quality, overwrite, outputFolder }) {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: sharpNotAvailableMsg() };
  const out = [];
  const fails = [];
  const q = Math.max(1, Math.min(100, parseInt(quality, 10) || 85));
  for (const f of files) {
    try {
      let pipeline = sharp(f.path).rotate();
      if      (format === 'jpg' || format === 'jpeg') pipeline = pipeline.jpeg({ quality: q, mozjpeg: true });
      else if (format === 'png')                       pipeline = pipeline.png({ compressionLevel: 9 });
      else if (format === 'webp')                      pipeline = pipeline.webp({ quality: q });
      else if (format === 'avif')                      pipeline = pipeline.avif({ quality: q });
      else throw new Error(`unsupported format: ${format}`);
      const outExt = format === 'jpeg' ? 'jpg' : format;
      const target = resolveImageOut({ srcPath: f.path, overwrite, outputFolder, suffix: '-conv', ext: outExt });
      await pipeline.toFile(target);
      // If overwrite + format change, drop the old file (different ext = both still exist).
      if (overwrite && target !== f.path && fs.existsSync(f.path)) {
        try { fs.unlinkSync(f.path); } catch {}
      }
      out.push({ from: f.path, to: target });
    } catch (e) {
      fails.push({ path: f.path, error: e.message });
    }
  }
  return { ok: true, converted: out, failed: fails };
}

async function imagesResize({ files, maxWidth, maxHeight, scalePct, overwrite, outputFolder }) {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: sharpNotAvailableMsg() };
  const out = [];
  const fails = [];
  const mw = parseInt(maxWidth,  10) || 0;
  const mh = parseInt(maxHeight, 10) || 0;
  const sp = parseInt(scalePct,  10) || 0;
  if (mw <= 0 && mh <= 0 && sp <= 0) return { ok: false, error: 'no resize parameter' };
  for (const f of files) {
    try {
      // Probe once: need original W×H to compute scalePct AND to compute
      // density for SVG rasterisation (without this, sharp rasterises SVG
      // at 72 DPI which produces a tiny PNG from a small viewBox — looks
      // like "resize didn't work").
      const meta = await sharp(f.path).metadata();
      const isSvg = meta.format === 'svg';
      const naturalW = meta.width  || 0;
      const naturalH = meta.height || 0;

      let resizeOpts;
      if (sp > 0) {
        resizeOpts = { width: Math.round(naturalW * sp / 100) };
      } else {
        resizeOpts = {
          width:  mw > 0 ? mw : undefined,
          height: mh > 0 ? mh : undefined,
          fit:    'inside',
          withoutEnlargement: !isSvg   // SVG must be allowed to upscale — natural size = viewBox px
        };
      }

      // For SVG: compute the density so the initial rasterisation lands
      // at (at least) the target dimensions. Otherwise sharp rasterises at
      // 72 DPI → tiny bitmap → resize-up = blurry/no-op.
      let inputOpts = {};
      if (isSvg) {
        const targetW = resizeOpts.width
                      || (resizeOpts.height && naturalH ? Math.round(resizeOpts.height * naturalW / naturalH) : 0)
                      || 1024;  // sensible default if neither dim given
        if (naturalW > 0) {
          inputOpts.density = Math.max(72, Math.round(72 * targetW / naturalW));
        }
      }

      const target = resolveImageOut({ srcPath: f.path, overwrite, outputFolder, suffix: '-resize' });
      await sharp(f.path, inputOpts).rotate().resize(resizeOpts).toFile(target + '.tmp');
      // Atomic move so a failed write doesn't leave the user with a 0-byte file.
      fs.renameSync(target + '.tmp', target);
      out.push({ from: f.path, to: target });
    } catch (e) {
      fails.push({ path: f.path, error: e.message });
    }
  }
  return { ok: true, resized: out, failed: fails };
}

async function imagesStripExif({ files, overwrite, outputFolder }) {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: sharpNotAvailableMsg() };
  const out = [];
  const fails = [];
  for (const f of files) {
    try {
      const target = resolveImageOut({ srcPath: f.path, overwrite, outputFolder, suffix: '-clean' });
      // sharp drops EXIF/ICC/XMP by default unless withMetadata() is called.
      // Use toBuffer + write so we can do atomic move (avoid in-place truncate).
      const buf = await sharp(f.path).rotate().toBuffer();
      fs.writeFileSync(target + '.tmp', buf);
      fs.renameSync(target + '.tmp', target);
      out.push({ from: f.path, to: target });
    } catch (e) {
      fails.push({ path: f.path, error: e.message });
    }
  }
  return { ok: true, stripped: out, failed: fails };
}

async function imagesAutoRotate({ files, overwrite, outputFolder }) {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: sharpNotAvailableMsg() };
  const out = [];
  const fails = [];
  for (const f of files) {
    try {
      const target = resolveImageOut({ srcPath: f.path, overwrite, outputFolder, suffix: '-rotated' });
      // .rotate() with no arg reads EXIF Orientation and bakes it into the
      // pixel data, then strips the tag. Standard auto-orient pattern.
      const buf = await sharp(f.path).rotate().toBuffer();
      fs.writeFileSync(target + '.tmp', buf);
      fs.renameSync(target + '.tmp', target);
      out.push({ from: f.path, to: target });
    } catch (e) {
      fails.push({ path: f.path, error: e.message });
    }
  }
  return { ok: true, rotated: out, failed: fails };
}

async function imagesHeicToJpg({ files, quality, outputFolder }) {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: sharpNotAvailableMsg() };
  const out = [];
  const fails = [];
  const q = Math.max(1, Math.min(100, parseInt(quality, 10) || 92));
  for (const f of files) {
    if (!/\.heic|\.heif/i.test(f.path)) { fails.push({ path: f.path, error: 'not a HEIC file' }); continue; }
    try {
      // HEIC always produces JPG (extension change). No "overwrite" mode
      // here — originals are always kept (the user would lose data
      // otherwise). outputFolder lands the JPG in the chosen destination.
      const target = resolveImageOut({ srcPath: f.path, overwrite: false, outputFolder, suffix: '', ext: 'jpg' });
      await sharp(f.path).rotate().jpeg({ quality: q, mozjpeg: true }).toFile(target);
      out.push({ from: f.path, to: target });
    } catch (e) {
      fails.push({ path: f.path, error: e.message });
    }
  }
  return { ok: true, converted: out, failed: fails };
}

// Pick a sharp-WRITABLE output format. `requested` = an explicit extension
// ('' / null = keep the source's). Inputs sharp can read but not encode
// (svg, heic/heif, bmp, jxl…) fall back to PNG so the op never fails.
const SHARP_WRITABLE = new Set(['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif']);
function pickOutFormat(input, requested) {
  let f = (requested || '').toLowerCase();
  if (!f) f = path.extname(input).slice(1).toLowerCase();
  if (f === 'jpg') f = 'jpeg';
  if (!SHARP_WRITABLE.has(f)) f = 'png';
  return { toFmt: f, outExt: f === 'jpeg' ? 'jpg' : f };
}

// Single-image crop (XTRACT > Image). Coordinates are pixels in the source.
async function imagesCrop({ input, x, y, width, height, output, format }) {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: sharpNotAvailableMsg() };
  try {
    const { toFmt, outExt } = pickOutFormat(input, format);
    const target = output || input.replace(/\.[^.]+$/, '-crop.' + outExt);
    await sharp(input).rotate().extract({
      left:   Math.max(0, Math.round(x)),
      top:    Math.max(0, Math.round(y)),
      width:  Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height))
    }).toFormat(toFmt).toFile(target + '.tmp');
    fs.renameSync(target + '.tmp', target);
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Replace one colour with another across the whole image (XTRACT > Image).
// Raw-pixel pass: any pixel whose R/G/B are each within `tolerance` (0-100%,
// mapped to 0-255) of `from` is rewritten to `to`. Alpha is preserved.
async function imagesReplaceColor({ input, from, to, tolerance, output }) {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: sharpNotAvailableMsg() };
  try {
    const hex = h => { h = String(h || '').replace('#', ''); return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0]; };
    const [fr, fg, fb] = hex(from);
    const [tr, tg, tb] = hex(to);
    const tolPx = Math.round(Math.max(0, Math.min(100, tolerance ?? 10)) / 100 * 255);
    const { data, info } = await sharp(input).rotate().raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    for (let i = 0; i < data.length; i += ch) {
      if (Math.abs(data[i] - fr) <= tolPx && Math.abs(data[i + 1] - fg) <= tolPx && Math.abs(data[i + 2] - fb) <= tolPx) {
        data[i] = tr; data[i + 1] = tg; data[i + 2] = tb;
      }
    }
    const { toFmt, outExt } = pickOutFormat(input, null);
    const target = output || input.replace(/\.[^.]+$/, '-recolor.' + outExt);
    await sharp(data, { raw: { width: info.width, height: info.height, channels: ch } })
      .toFormat(toFmt).toFile(target + '.tmp');
    fs.renameSync(target + '.tmp', target);
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// XTRACT > Image > Remove background (colour). Quick chroma-key: any pixel
// whose R/G/B are each within `tolerance` (0-100%, mapped to 0-255) of the
// picked background colour becomes fully transparent (alpha 0). Always writes
// a PNG so the alpha channel survives — JPEG has no alpha. Solid / near-solid
// backgrounds only; arbitrary photo backgrounds need the AI segmentation path
// tracked in the roadmap.
async function imagesRemoveBgColor({ input, color, tolerance, output }) {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: sharpNotAvailableMsg() };
  try {
    const hex = h => { h = String(h || '').replace('#', ''); return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0]; };
    const [cr, cg, cb] = hex(color);
    const tolPx = Math.round(Math.max(0, Math.min(100, tolerance ?? 20)) / 100 * 255);
    // ensureAlpha() guarantees a 4th channel even for opaque/JPEG sources.
    const { data, info } = await sharp(input).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels; // 4 after ensureAlpha
    let cleared = 0;
    for (let i = 0; i < data.length; i += ch) {
      if (Math.abs(data[i] - cr) <= tolPx && Math.abs(data[i + 1] - cg) <= tolPx && Math.abs(data[i + 2] - cb) <= tolPx) {
        data[i + 3] = 0;
        cleared++;
      }
    }
    // Force .png output regardless of source extension — transparency needs it.
    const target = output || input.replace(/\.[^.]+$/, '-nobg.png');
    await sharp(data, { raw: { width: info.width, height: info.height, channels: ch } })
      .png().toFile(target + '.tmp');
    fs.renameSync(target + '.tmp', target);
    return { ok: true, path: target, cleared };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Classic sepia color matrix — applied via sharp.recomb(). Same values
// Photoshop uses for the "Sepia" preset filter. The 3 rows are R,G,B
// coefficients; each output channel is a weighted sum of input RGB.
const SEPIA_MATRIX = [
  [0.393, 0.769, 0.189],
  [0.349, 0.686, 0.168],
  [0.272, 0.534, 0.131]
];

// XTRACT > Image > Effects. Each effect maps to a sharp pipeline step.
// Defaults (brightness/contrast/saturation = 100, hue = 0, blur/sharpen = 0
// and all toggles off) are no-ops — only non-default values produce a step.
async function imagesApplyEffects({
  input, output, brightness, contrast, saturation, hue, blur, sharpen,
  grayscale, sepia, invert
}) {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: sharpNotAvailableMsg() };
  try {
    // Normalise inputs — accept loose strings/numbers from the renderer.
    const b = Number(brightness ?? 100) / 100;     // 1.0 = no change
    const c = Number(contrast   ?? 100) / 100;
    const s = Number(saturation ?? 100) / 100;
    const h = Number(hue        ?? 0);
    const bl = Math.max(0, Number(blur    ?? 0));
    const sh = Math.max(0, Number(sharpen ?? 0));

    let pipe = sharp(input).rotate();

    // modulate() handles brightness + saturation (multipliers) + hue
    // (degrees rotation). Only call when any value diverges from default —
    // sharp's docs say no-op values can still trigger LUT building.
    if (b !== 1 || s !== 1 || h !== 0) {
      pipe = pipe.modulate({ brightness: b, saturation: s, hue: h });
    }
    // linear(a, b) computes a*pixel + b. Standard contrast formula: scale
    // around the midpoint (128) so brightness stays anchored.
    if (c !== 1) {
      pipe = pipe.linear(c, 128 * (1 - c));
    }
    // The boolean toggles compose in this order: grayscale strips colour,
    // then sepia tints, then invert flips. Order matches Photoshop's
    // adjustment-layer stacking.
    if (grayscale) pipe = pipe.grayscale();
    if (sepia)     pipe = pipe.recomb(SEPIA_MATRIX);
    if (invert)    pipe = pipe.negate({ alpha: false });
    if (bl > 0)    pipe = pipe.blur(bl);
    if (sh > 0)    pipe = pipe.sharpen({ sigma: sh });

    const target = output || input.replace(/(\.[^.]+)$/, '-fx$1');
    // Atomic write: tmp + rename so a failed encode doesn't truncate a
    // file already on disk.
    await pipe.toFile(target + '.tmp');
    fs.renameSync(target + '.tmp', target);
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// XTRACT > Image — non-destructive editor SAVE. Applies the whole pending
// edit stack (crop → effects → replace-color → remove-bg → resize) in ONE
// sharp pass, chaining in-memory buffers: no intermediate files, one output.
// Recipes are copies of the single-op handlers above — keep them in sync.
async function imagesApplyPipeline({ input, inputData, edits = {}, outputName, outputDir }) {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: sharpNotAvailableMsg() };
  try {
    const hex = h => { h = String(h || '').replace('#', ''); return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0]; };
    const steps = [];
    // inputData = flattened annotate canvas (PNG bytes at natural resolution)
    // — when present it replaces the file as the pipeline source, so all
    // other edits apply on top of the annotations.
    let pipe = sharp(inputData ? Buffer.from(inputData) : input).rotate();
    if (inputData) steps.push('annotate');

    // 1. Crop (natural-pixel rect from the renderer)
    if (edits.crop && edits.crop.w > 0 && edits.crop.h > 0) {
      pipe = pipe.extract({
        left:   Math.max(0, Math.round(edits.crop.x)),
        top:    Math.max(0, Math.round(edits.crop.y)),
        width:  Math.max(1, Math.round(edits.crop.w)),
        height: Math.max(1, Math.round(edits.crop.h))
      });
      steps.push('crop');
    }

    // 2+3. Replace-color and remove-bg share ONE raw materialisation. They
    // run BEFORE the effects so color matching happens on the ORIGINAL
    // pixels — an effect applied afterwards must not "un-match" the color
    // the user picked (same order as the renderer's composite preview).
    if (edits.recolor || edits.rmbg) {
      const { data, info } = await (edits.rmbg ? pipe.ensureAlpha() : pipe)
        .raw().toBuffer({ resolveWithObject: true });
      const ch = info.channels;
      if (edits.recolor) {
        const [fr, fg, fb] = hex(edits.recolor.from);
        const [tr, tg, tb] = hex(edits.recolor.to);
        const tol = Math.round(Math.max(0, Math.min(100, edits.recolor.tolerance ?? 10)) / 100 * 255);
        for (let i = 0; i < data.length; i += ch) {
          if (Math.abs(data[i] - fr) <= tol && Math.abs(data[i + 1] - fg) <= tol && Math.abs(data[i + 2] - fb) <= tol) {
            data[i] = tr; data[i + 1] = tg; data[i + 2] = tb;
          }
        }
        steps.push('recolor');
      }
      if (edits.rmbg) {
        const [cr, cg, cb] = hex(edits.rmbg.color);
        const tol = Math.round(Math.max(0, Math.min(100, edits.rmbg.tolerance ?? 20)) / 100 * 255);
        for (let i = 0; i < data.length; i += ch) {
          if (Math.abs(data[i] - cr) <= tol && Math.abs(data[i + 1] - cg) <= tol && Math.abs(data[i + 2] - cb) <= tol) {
            data[i + 3] = 0;
          }
        }
        steps.push('rmbg');
      }
      pipe = sharp(data, { raw: { width: info.width, height: info.height, channels: ch } });
    }

    // 4. Effects — AFTER the pixel ops (same recipe as imagesApplyEffects).
    if (edits.fx) {
      const fx = edits.fx;
      const b  = Number(fx.brightness ?? 100) / 100;
      const c  = Number(fx.contrast   ?? 100) / 100;
      const s  = Number(fx.saturation ?? 100) / 100;
      const h  = Number(fx.hue        ?? 0);
      const bl = Math.max(0, Number(fx.blur    ?? 0));
      const sh = Math.max(0, Number(fx.sharpen ?? 0));
      if (b !== 1 || s !== 1 || h !== 0) pipe = pipe.modulate({ brightness: b, saturation: s, hue: h });
      if (c !== 1)      pipe = pipe.linear(c, 128 * (1 - c));
      if (fx.grayscale) pipe = pipe.grayscale();
      if (fx.sepia)     pipe = pipe.recomb(SEPIA_MATRIX);
      if (fx.invert)    pipe = pipe.negate({ alpha: false });
      if (bl > 0)       pipe = pipe.blur(bl);
      if (sh > 0)       pipe = pipe.sharpen({ sigma: sh });
      steps.push('fx');
    }

    // 5. Resize — the renderer pre-computes pct → max px, so only bounds here.
    if (edits.resize && (edits.resize.maxWidth > 0 || edits.resize.maxHeight > 0)) {
      pipe = pipe.resize({
        width:  edits.resize.maxWidth  > 0 ? Math.round(edits.resize.maxWidth)  : undefined,
        height: edits.resize.maxHeight > 0 ? Math.round(edits.resize.maxHeight) : undefined,
        fit: 'inside'
      });
      steps.push('resize');
    }

    // Output: transparency forces PNG; otherwise requested format or source's.
    let toFmt, outExt;
    if (edits.rmbg) { toFmt = 'png'; outExt = 'png'; }
    else ({ toFmt, outExt } = pickOutFormat(input, edits.format || null));
    // Folder + name from the save modal (sanitized); auto-dedupe with " (n)"
    // so an existing file is never silently overwritten.
    const dir = (outputDir && typeof outputDir === 'string' && fs.existsSync(outputDir))
      ? outputDir : path.dirname(input);
    const safeName = String(outputName || '').replace(/[<>:"|?*\\/\x00-\x1f]/g, '_').trim()
      || path.basename(input, path.extname(input)) + '-edit';
    let target = path.join(dir, `${safeName}.${outExt}`);
    for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${safeName} (${n}).${outExt}`);
    await pipe.toFormat(toFmt).toFile(target + '.tmp');
    fs.renameSync(target + '.tmp', target);
    return { ok: true, path: target, steps };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Bulk watermark — overlays a text string on every selected image. Position
// is one of the 9 anchor points (tl/tc/tr/ml/mc/mr/bl/bc/br); colour, font
// size, opacity, and optional drop shadow are configurable. The watermark
// itself is generated as an SVG that sharp composites natively — much
// faster than rasterising text via canvas, and the SVG scales with the
// font-size input without aliasing.
async function imagesWatermark({
  files, text, fontSize = 32, color = '#ffffff', opacity = 0.7,
  position = 'br', padding = 24, shadow = true, overwrite, outputFolder
}) {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: sharpNotAvailableMsg() };
  if (!text) return { ok: false, error: 'text required' };
  const safeText = String(text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const op = Math.max(0, Math.min(1, Number(opacity)));
  const fSize = Math.max(8, Math.min(512, parseInt(fontSize, 10) || 32));
  const out = [];
  const fails = [];

  for (const f of files) {
    try {
      const meta = await sharp(f.path).metadata();
      const W = meta.width || 1, H = meta.height || 1;
      // SVG canvas matches image dimensions so the text-anchor calculation
      // is in image pixel space. text-anchor picks the right corner of
      // the text bounding box (start/middle/end ↔ left/center/right).
      const tx = position.endsWith('l') ? padding
               : position.endsWith('r') ? W - padding
               :                          W / 2;
      const ty = position.startsWith('t') ? padding + fSize
               : position.startsWith('b') ? H - padding
               :                            H / 2;
      const anchor = position.endsWith('l') ? 'start'
                   : position.endsWith('r') ? 'end'
                   :                          'middle';
      const shadowDef = shadow
        ? `<filter id="s" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="2" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.6"/></filter>`
        : '';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
        `<defs>${shadowDef}</defs>` +
        `<text x="${tx}" y="${ty}" font-family="sans-serif" font-size="${fSize}" ` +
        `font-weight="bold" fill="${color}" fill-opacity="${op}" text-anchor="${anchor}" ` +
        (shadow ? `filter="url(#s)" ` : '') + `>${safeText}</text></svg>`;
      const target = resolveImageOut({ srcPath: f.path, overwrite, outputFolder, suffix: '-wm' });
      await sharp(f.path).rotate()
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .toFile(target + '.tmp');
      fs.renameSync(target + '.tmp', target);
      out.push({ from: f.path, to: target });
    } catch (e) {
      fails.push({ path: f.path, error: e.message });
    }
  }
  return { ok: true, watermarked: out, failed: fails };
}

// Compress to target file size — bisects quality from 1-95 until the
// output file is at or below the requested size. JPEG/WebP/AVIF respect
// quality; PNG falls back to compressionLevel sweep instead.
async function imagesCompressToSize({ files, targetKb, format, overwrite, outputFolder }) {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: sharpNotAvailableMsg() };
  const out = [];
  const fails = [];
  const targetBytes = Math.max(1, parseInt(targetKb, 10) || 0) * 1024;
  if (!targetBytes) return { ok: false, error: 'target size required' };
  const fmt = (format || 'jpg').toLowerCase();
  const ext = fmt === 'jpeg' ? 'jpg' : fmt;

  for (const f of files) {
    try {
      // Binary search quality in [5, 95]. Each step encodes to a buffer
      // (no disk write) until we find the highest quality that fits.
      let lo = 5, hi = 95, best = null, iters = 0;
      while (lo <= hi && iters < 10) {
        const q = Math.floor((lo + hi) / 2);
        let pipe = sharp(f.path).rotate();
        if      (fmt === 'jpg' || fmt === 'jpeg') pipe = pipe.jpeg({ quality: q, mozjpeg: true });
        else if (fmt === 'webp')                  pipe = pipe.webp({ quality: q });
        else if (fmt === 'avif')                  pipe = pipe.avif({ quality: q });
        else if (fmt === 'png') {
          // PNG quality lever is compressionLevel 0-9. Higher = more CPU,
          // smaller file. Sweep 0..9 instead of quality.
          pipe = pipe.png({ compressionLevel: Math.round(9 * (95 - q) / 90) });
        }
        else throw new Error('unsupported format: ' + fmt);
        const buf = await pipe.toBuffer();
        if (buf.length <= targetBytes) {
          best = { q, buf };
          lo = q + 1;  // try higher quality
        } else {
          hi = q - 1;  // need smaller, lower quality
        }
        iters++;
      }
      if (!best) {
        fails.push({ path: f.path, error: `cannot reach target size (image too complex even at quality=5)` });
        continue;
      }
      const target = resolveImageOut({ srcPath: f.path, overwrite, outputFolder, suffix: '-shrunk', ext });
      fs.writeFileSync(target + '.tmp', best.buf);
      fs.renameSync(target + '.tmp', target);
      if (overwrite && target !== f.path && fs.existsSync(f.path)) {
        try { fs.unlinkSync(f.path); } catch {}
      }
      out.push({ from: f.path, to: target, quality: best.q, size: best.buf.length });
    } catch (e) {
      fails.push({ path: f.path, error: e.message });
    }
  }
  return { ok: true, compressed: out, failed: fails };
}

// Perceptual hash (dHash) for image duplicate finding. Resize to 9x8 grey,
// compare each pixel to its right neighbour: 64-bit fingerprint. Files
// with Hamming distance ≤ 8 (12.5% bit diff) are grouped as duplicates.
// Catches same image at different resolutions / formats / minor edits.
async function imagesDedup(event, { paths, threshold }) {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: sharpNotAvailableMsg() };
  if (!Array.isArray(paths) || paths.length < 2) return { ok: false, error: 'need ≥2 files' };
  const maxDist = typeof threshold === 'number' ? Math.max(0, Math.min(64, threshold)) : 8;

  const safeSend = (ch, data) => busSafeSend(event.sender, ch, data);
  const fps = [];
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    safeSend('images:dedupProgress', { line: `hashing ${path.basename(p)} (${i+1}/${paths.length})`, progress: i / paths.length });
    try {
      // 9x8 grey buffer = 72 bytes. Compare horizontal pairs → 64-bit hash.
      const buf = await sharp(p).rotate().resize(9, 8, { fit: 'fill' }).grayscale().raw().toBuffer();
      // Build the hash as a Uint8Array of 8 bytes (one bit per pixel pair).
      const hash = new Uint8Array(8);
      for (let row = 0; row < 8; row++) {
        let byte = 0;
        for (let col = 0; col < 8; col++) {
          const a = buf[row * 9 + col];
          const b = buf[row * 9 + col + 1];
          if (a < b) byte |= (1 << col);
        }
        hash[row] = byte;
      }
      const stat = fs.statSync(p);
      fps.push({ path: p, hash, size: stat.size });
    } catch (e) {
      log('WARN', `images:dedup skipped ${p}: ${e.message}`);
    }
  }
  // Pairwise Hamming distance + union-find grouping (mirrors audio dedup).
  safeSend('images:dedupProgress', { line: 'comparing hashes…', progress: 0.95 });
  const popcount8 = (n) => {
    n = n - ((n >> 1) & 0x55);
    n = (n & 0x33) + ((n >> 2) & 0x33);
    return (n + (n >> 4)) & 0x0f;
  };
  const parent = fps.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < fps.length; i++) {
    for (let j = i + 1; j < fps.length; j++) {
      let dist = 0;
      for (let k = 0; k < 8; k++) dist += popcount8(fps[i].hash[k] ^ fps[j].hash[k]);
      if (dist <= maxDist) union(i, j);
    }
  }
  const byRoot = new Map();
  for (let i = 0; i < fps.length; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(fps[i]);
  }
  const groups = [];
  for (const arr of byRoot.values()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => b.size - a.size);
    groups.push(arr.map(({ path, size }) => ({ path, size })));
  }
  safeSend('images:dedupProgress', { line: `done — ${groups.length} group(s)`, progress: 1 });
  return { ok: true, groups, scanned: fps.length, skipped: paths.length - fps.length };
}

// Group VISUALLY-SIMILAR photos (burst shots, near-identical frames) and rank
// each group so the SHARPEST / highest-resolution shot is suggested as the one
// to keep. Reuses the dHash + Hamming/union-find grouping from imagesDedup,
// then adds a focus score (variance of a Laplacian response, measured on a
// resolution-normalised greyscale crop) and a megapixel score per image.
// The combined score (0.7·sharpness + 0.3·resolution, normalised within each
// group) decides the suggested "best". The renderer shows a thumbnail gallery
// and lets the user override the keeper before trashing the rest.
async function laplacianVariance(sharp, p) {
  // Normalise to a fixed size first so focus is comparable across resolutions
  // (a big blurry photo shouldn't beat a small sharp one just on pixel count).
  const buf = await sharp(p).rotate().grayscale().resize(320, 240, { fit: 'fill' })
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
    .raw().toBuffer();
  let sum = 0, sum2 = 0; const n = buf.length || 1;
  for (let i = 0; i < buf.length; i++) { const v = buf[i]; sum += v; sum2 += v * v; }
  const mean = sum / n;
  return Math.max(0, sum2 / n - mean * mean);
}

async function imagesGroupSimilar(event, { paths, threshold }) {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: sharpNotAvailableMsg() };
  if (!Array.isArray(paths) || paths.length < 2) return { ok: false, error: 'need ≥2 files' };
  const maxDist = typeof threshold === 'number' ? Math.max(0, Math.min(64, threshold)) : 10;
  const pathMod = require('path');
  const safeSend = (ch, data) => busSafeSend(event.sender, ch, data);

  const items = [];
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    safeSend('images:similarProgress', { line: `analyzing ${pathMod.basename(p)} (${i + 1}/${paths.length})`, progress: (i / paths.length) * 0.9 });
    try {
      const buf = await sharp(p).rotate().resize(9, 8, { fit: 'fill' }).grayscale().raw().toBuffer();
      const hash = new Uint8Array(8);
      for (let row = 0; row < 8; row++) {
        let byte = 0;
        for (let col = 0; col < 8; col++) { if (buf[row * 9 + col] < buf[row * 9 + col + 1]) byte |= (1 << col); }
        hash[row] = byte;
      }
      const meta = await sharp(p).metadata();
      const width = meta.width || 0, height = meta.height || 0;
      const sharpness = await laplacianVariance(sharp, p);
      const stat = fs.statSync(p);
      items.push({ path: p, hash, size: stat.size, width, height, sharpness });
    } catch (e) {
      log('WARN', `images:groupSimilar skipped ${p}: ${e.message}`);
    }
  }

  safeSend('images:similarProgress', { line: 'grouping…', progress: 0.95 });
  const popcount8 = (n) => { n = n - ((n >> 1) & 0x55); n = (n & 0x33) + ((n >> 2) & 0x33); return (n + (n >> 4)) & 0x0f; };
  const parent = items.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      let dist = 0;
      for (let k = 0; k < 8; k++) dist += popcount8(items[i].hash[k] ^ items[j].hash[k]);
      if (dist <= maxDist) union(i, j);
    }
  }
  const byRoot = new Map();
  for (let i = 0; i < items.length; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(items[i]);
  }
  const groups = [];
  for (const arr of byRoot.values()) {
    if (arr.length < 2) continue;
    const maxSharp = Math.max(...arr.map(x => x.sharpness)) || 1;
    const maxMp    = Math.max(...arr.map(x => x.width * x.height)) || 1;
    const scored = arr.map(x => {
      const mp = x.width * x.height;
      const sharpRel = x.sharpness / maxSharp;
      const resRel = mp / maxMp;
      return {
        path: x.path, size: x.size, width: x.width, height: x.height,
        megapixels: mp / 1e6,
        sharpness: Math.round(x.sharpness),
        sharpRel,                                  // 0..1 within group (for the UI bar)
        score: 0.7 * sharpRel + 0.3 * resRel
      };
    });
    scored.sort((a, b) => b.score - a.score);
    scored.forEach((x, i) => { x.best = i === 0; });
    groups.push(scored);
  }
  // Largest groups first — most decisions to make at the top.
  groups.sort((a, b) => b.length - a.length);
  safeSend('images:similarProgress', { line: `done — ${groups.length} group(s)`, progress: 1 });
  return { ok: true, groups, scanned: items.length, skipped: paths.length - items.length };
}

// Image sequence → video (timelapse / slideshow). Uses ffmpeg's image2
// demuxer with a temp folder of symlinked / copied images at sequential
// names (frame_0001.jpg etc.) so ffmpeg can read them in order.
async function imagesToVideo(event, { files, fps = 24, output, format = 'mp4', opId }) {
  if (!Array.isArray(files) || !files.length) return { ok: false, error: 'no files' };
  const ffmpeg = getFfmpegPath();
  if (!ffmpeg) return { ok: false, error: 'ffmpeg not available' };
  const fpsN = Math.max(1, Math.min(60, parseInt(fps, 10) || 24));
  // Stage frames into a temp dir with zero-padded names — image2 demuxer
  // requires a numeric sequence.
  const tmpDir = path.join(os.tmpdir(), `flux-imgseq-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    for (let i = 0; i < files.length; i++) {
      const src = files[i].path || files[i];
      const ext = path.extname(src).slice(1).toLowerCase() || 'jpg';
      // ffmpeg image2 wants identical extensions per glob; we copy with
      // padded numeric names. Copy (not symlink) because Windows symlinks
      // need elevation and we want this to work portably.
      fs.copyFileSync(src, path.join(tmpDir, `f_${String(i + 1).padStart(5, '0')}.${ext}`));
    }
    const firstExt = path.extname(files[0].path || files[0]).slice(1).toLowerCase() || 'jpg';
    const target = output || (files[0].path || files[0]).replace(/[^\\/]+$/, '') + `timelapse-${Date.now()}.${format}`;
    // -framerate before -i sets the INPUT fps (how fast to read frames);
    // -r AFTER sets the output frame rate. Setting both equal yields a
    // straight timelapse where each image = 1 frame at the chosen rate.
    const args = [
      '-hide_banner', '-y',
      '-framerate', String(fpsN),
      '-i', path.join(tmpDir, `f_%05d.${firstExt}`),
      '-c:v', format === 'webm' ? 'libvpx-vp9' : 'libx264',
      '-pix_fmt', 'yuv420p',
      '-r', String(fpsN),
      target
    ];
    const r = await ffmpegRun(event, args, target, opId);
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    // Best-effort cleanup of the temp staging dir.
    try {
      for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
      fs.rmdirSync(tmpDir);
    } catch {}
  }
}

// ─── Image library organizer (EXIF-based, mirrors the audio Library Manager) ─
// Move photos into <root>/<pattern>/ where the pattern uses date/camera
// tokens. The date comes from the EXIF capture time (DateTimeOriginal,
// fallback DateTime) with a final fallback to the file's modified time. Used
// both manually (imagesOrganize over a selection) and automatically after a
// download lands an image (imagesOrganizeAuto, gated by config). No new
// dependency: the EXIF tags are read straight from sharp's raw TIFF buffer.
const IMAGE_ORG_EXT = /\.(jpg|jpeg|png|webp|avif|tif|tiff|gif|bmp|heic|heif)$/i;

// Sanitise a tag value for use as a filesystem path component. Strips chars
// illegal on Windows (\<>:"/\\|?*), trims trailing dots/spaces (also illegal
// on Windows), and caps length at 80 chars so absurd metadata doesn't blow
// past the Windows 260-char MAX_PATH. (Duplicated from main.js's
// sanitisePathSegment — same tiny pure function used by the unrelated audio
// Library Manager, not worth a shared module for 10 lines.)
function sanitisePathSegment(s) {
  if (s == null) return '';
  const clean = String(s)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim();
  return clean.slice(0, 80);
}

// Minimal EXIF reader over sharp's raw exif buffer. Pulls only what we need:
// capture date (0x9003 DateTimeOriginal → 0x0132 DateTime) and camera make
// (0x010F) / model (0x0110). Returns {} on any malformed input so callers fall
// back to the filesystem date.
function readExifBasics(buf) {
  try {
    if (!buf || buf.length < 16) return {};
    let base = 0;
    if (buf.toString('ascii', 0, 4) === 'Exif') base = 6; // strip APP1 "Exif\0\0" if present
    const bo = buf.toString('ascii', base, base + 2);
    const le = bo === 'II' ? true : bo === 'MM' ? false : null;
    if (le === null) return {};
    const u16 = p => le ? buf.readUInt16LE(p) : buf.readUInt16BE(p);
    const u32 = p => le ? buf.readUInt32LE(p) : buf.readUInt32BE(p);
    const ascii = (entry) => {
      const len = entry.count;
      const pos = len <= 4 ? entry.valOff : base + u32(entry.valOff);
      if (pos < 0 || pos + len > buf.length) return '';
      return buf.toString('ascii', pos, pos + len).replace(/\0.*$/, '').trim();
    };
    const readIFD = (start) => {
      if (start < 0 || start + 2 > buf.length) return [];
      const n = u16(start);
      const entries = [];
      for (let i = 0; i < n; i++) {
        const e = start + 2 + i * 12;
        if (e + 12 > buf.length) break;
        entries.push({ tag: u16(e), type: u16(e + 2), count: u32(e + 4), valOff: e + 8 });
      }
      return entries;
    };
    const out = {};
    let exifPtr = null;
    for (const e of readIFD(base + u32(base + 4))) {
      if (e.tag === 0x0132 && !out.date) out.date = ascii(e);   // DateTime
      else if (e.tag === 0x010F) out.make = ascii(e);            // Make
      else if (e.tag === 0x0110) out.model = ascii(e);           // Model
      else if (e.tag === 0x8769) exifPtr = base + u32(e.valOff); // Exif sub-IFD pointer
    }
    if (exifPtr != null) {
      for (const e of readIFD(exifPtr)) {
        if (e.tag === 0x9003) { const d = ascii(e); if (d) out.date = d; } // DateTimeOriginal wins
      }
    }
    return out;
  } catch { return {}; }
}

// "YYYY:MM:DD HH:MM:SS" (or date-only) → Date, else null.
function parseExifDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/.exec(s || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return isNaN(d.getTime()) ? null : d;
}

async function imageCaptureInfo(sharp, filePath) {
  let date = null, make = '', model = '';
  try {
    const meta = await sharp(filePath).metadata();
    const ex = readExifBasics(meta.exif);
    date = parseExifDate(ex.date);
    make = ex.make || ''; model = ex.model || '';
  } catch { /* unreadable EXIF → fall back below */ }
  if (!date) { try { date = fs.statSync(filePath).mtime; } catch { date = new Date(0); } }
  return { date, make, model };
}

function imageOrgRelParts(pattern, info, filePath) {
  const pad = n => String(n).padStart(2, '0');
  const d = info.date;
  const tokens = {
    year:   String(d.getFullYear()),
    month:  pad(d.getMonth() + 1),
    day:    pad(d.getDate()),
    date:   `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    make:   info.make || 'Unknown',
    model:  info.model || 'Unknown',
    camera: [info.make, info.model].filter(Boolean).join(' ') || 'Unknown Camera',
    ext:    path.extname(filePath).replace(/^\./, '').toLowerCase()
  };
  return (pattern || '{year}/{month}').split(/[\\/]+/).map(seg => {
    const filled = seg.replace(/\{(\w+)\}/g, (_m, k) => tokens[k] != null ? tokens[k] : `{${k}}`);
    return sanitisePathSegment(filled);
  }).filter(Boolean);
}

// Move (or copy) one image into targetDir, cross-device safe, with " (N)"
// collision suffixing. Returns { moved, path } or a skip reason.
function placeImage(filePath, targetDir, copy) {
  fs.mkdirSync(targetDir, { recursive: true });
  const baseName = path.basename(filePath);
  let targetPath = path.join(targetDir, baseName);
  if (path.resolve(targetPath) === path.resolve(filePath)) return { moved: false, skipped: 'already in place', path: filePath };
  if (fs.existsSync(targetPath)) {
    const ext = path.extname(baseName);
    const stem = ext ? baseName.slice(0, -ext.length) : baseName;
    let n = 2;
    while (fs.existsSync(targetPath) && n < 1000) { targetPath = path.join(targetDir, `${stem} (${n})${ext}`); n++; }
  }
  if (copy) {
    fs.copyFileSync(filePath, targetPath);
  } else {
    try { fs.renameSync(filePath, targetPath); }
    catch (e) { if (e.code === 'EXDEV') { fs.copyFileSync(filePath, targetPath); fs.unlinkSync(filePath); } else throw e; }
  }
  return { moved: true, path: targetPath };
}

async function imagesOrganize(event, { files, root, pattern, copy } = {}) {
  const sharp = getSharp();
  if (!sharp) return { ok: false, error: sharpNotAvailableMsg() };
  if (!Array.isArray(files) || !files.length) return { ok: false, error: 'no files' };
  if (!root) return { ok: false, error: 'no destination root' };
  const safeSend = (ch, data) => busSafeSend(event.sender, ch, data);
  const results = []; const errors = []; let moved = 0;
  for (let i = 0; i < files.length; i++) {
    const fp = files[i];
    safeSend('images:organizeProgress', { line: `${path.basename(fp)} (${i + 1}/${files.length})`, progress: i / files.length });
    try {
      if (!fs.existsSync(fp)) { errors.push(`${path.basename(fp)}: not found`); continue; }
      if (!IMAGE_ORG_EXT.test(fp)) { errors.push(`${path.basename(fp)}: not an image`); continue; }
      const info = await imageCaptureInfo(sharp, fp);
      const parts = imageOrgRelParts(pattern, info, fp);
      if (!parts.length) { errors.push(`${path.basename(fp)}: empty pattern`); continue; }
      const r = placeImage(fp, path.join(root, ...parts), !!copy);
      if (r.moved) { moved++; results.push({ from: fp, to: r.path }); }
    } catch (e) { errors.push(`${path.basename(fp)}: ${e.message}`); }
  }
  safeSend('images:organizeProgress', { line: `done — ${moved} moved`, progress: 1 });
  return { ok: true, moved, results, errors };
}

// Automatic post-download organize (gated by config; mirrors libraryOrganize).
async function imagesOrganizeAuto({ filePath } = {}) {
  const cfg = loadConfig();
  if (!cfg.image_library_enabled) return { ok: true, moved: false, path: filePath };
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, moved: false, error: 'file not found', path: filePath };
  if (!IMAGE_ORG_EXT.test(filePath)) return { ok: true, moved: false, skipped: 'non-image', path: filePath };
  const sharp = getSharp();
  if (!sharp) return { ok: false, moved: false, error: sharpNotAvailableMsg(), path: filePath };
  const root = cfg.image_library_root || cfg.download_folder;
  try {
    const info = await imageCaptureInfo(sharp, filePath);
    const parts = imageOrgRelParts(cfg.image_library_pattern || '{year}/{month}', info, filePath);
    if (!parts.length) return { ok: true, moved: false, skipped: 'empty pattern', path: filePath };
    const r = placeImage(filePath, path.join(root, ...parts), false);
    if (r.moved) log('INFO', `imageOrganize: ${path.basename(filePath)} → ${path.relative(root, r.path)}`);
    return { ok: true, moved: !!r.moved, path: r.path || filePath };
  } catch (e) {
    log('ERROR', `imageOrganizeAuto failed: ${e.message}`);
    return { ok: false, moved: false, error: e.message, path: filePath };
  }
}

module.exports = {
  imagesLoad, imagesThumbnail, imagesRename, imagesConvert, imagesResize,
  imagesStripExif, imagesAutoRotate, imagesHeicToJpg, imagesCrop,
  imagesReplaceColor, imagesRemoveBgColor, imagesApplyEffects, imagesApplyPipeline,
  imagesWatermark, imagesCompressToSize, imagesDedup, imagesGroupSimilar,
  imagesToVideo, imagesOrganize, imagesOrganizeAuto,
  routes: [
    { channel: 'images:load',           method: 'POST', path: '/api/images/load',           fn: 'imagesLoad',           args: body => [body] },
    { channel: 'images:thumbnail',      method: 'POST', path: '/api/images/thumbnail',       fn: 'imagesThumbnail',      args: body => [body] },
    { channel: 'images:rename',         method: 'POST', path: '/api/images/rename',          fn: 'imagesRename',         args: body => [body] },
    { channel: 'images:convert',        method: 'POST', path: '/api/images/convert',         fn: 'imagesConvert',        args: body => [body] },
    { channel: 'images:resize',         method: 'POST', path: '/api/images/resize',          fn: 'imagesResize',         args: body => [body] },
    { channel: 'images:stripExif',      method: 'POST', path: '/api/images/stripExif',       fn: 'imagesStripExif',      args: body => [body] },
    { channel: 'images:autoRotate',     method: 'POST', path: '/api/images/autoRotate',      fn: 'imagesAutoRotate',     args: body => [body] },
    { channel: 'images:heicToJpg',      method: 'POST', path: '/api/images/heicToJpg',       fn: 'imagesHeicToJpg',      args: body => [body] },
    { channel: 'images:crop',           method: 'POST', path: '/api/images/crop',            fn: 'imagesCrop',           args: body => [body] },
    { channel: 'images:replaceColor',   method: 'POST', path: '/api/images/replaceColor',    fn: 'imagesReplaceColor',   args: body => [body] },
    { channel: 'images:removeBgColor',  method: 'POST', path: '/api/images/removeBgColor',   fn: 'imagesRemoveBgColor',  args: body => [body] },
    { channel: 'images:applyEffects',   method: 'POST', path: '/api/images/applyEffects',    fn: 'imagesApplyEffects',   args: body => [body] },
    // maxBodyBytes: `inputData` (a flattened annotate-canvas PNG,
    // base64-encoded — +33% over raw bytes) can exceed the generic 10MB
    // JSON body cap for a high-resolution photo — found live (save silently
    // hung forever: the server dropped the oversized request's connection
    // with no response ever sent, and the client had no error handling for
    // that either — see renderer.js's confirmImgSave for that other half).
    { channel: 'images:applyPipeline',  method: 'POST', path: '/api/images/applyPipeline',   fn: 'imagesApplyPipeline',  args: body => [body], maxBodyBytes: 50 * 1024 * 1024 },
    { channel: 'images:watermark',      method: 'POST', path: '/api/images/watermark',       fn: 'imagesWatermark',      args: body => [body] },
    { channel: 'images:compressToSize', method: 'POST', path: '/api/images/compressToSize',  fn: 'imagesCompressToSize', args: body => [body] },
    { channel: 'images:dedup',          method: 'POST', path: '/api/images/dedup',           fn: 'imagesDedup',          args: (body, sender) => [{ sender }, body] },
    { channel: 'images:groupSimilar',   method: 'POST', path: '/api/images/groupSimilar',    fn: 'imagesGroupSimilar',   args: (body, sender) => [{ sender }, body] },
    { channel: 'images:toVideo',        method: 'POST', path: '/api/images/toVideo',         fn: 'imagesToVideo',        args: (body, sender) => [{ sender }, body] },
    { channel: 'images:organize',       method: 'POST', path: '/api/images/organize',        fn: 'imagesOrganize',       args: (body, sender) => [{ sender }, body] },
    { channel: 'images:organizeAuto',   method: 'POST', path: '/api/images/organizeAuto',    fn: 'imagesOrganizeAuto',   args: body => [body] },
  ],
};
