#!/usr/bin/env node
'use strict';

// Generate every icon format FLUX ships from a single SVG source.
//
// Input  : assets/icon.svg
// Output : assets/icon.png       (1024×1024 — Linux electron-builder default)
//          assets/icon.ico       (multi-size — Windows electron-builder default)
//          assets/icon.icns      (multi-size — macOS electron-builder default)
//          assets/icon@<N>.png   (individual sizes 16/32/48/64/128/256/512/1024)
//
// Run with: node scripts/build-icons.js
// Behind a corporate proxy: prefix with NODE_OPTIONS=--use-system-ca
//
// Pure-JS pipeline (sharp for SVG→PNG, png2icons for the two container formats).
// No native macOS tooling required — Windows can produce .icns for cross-builds.

const fs   = require('fs');
const path = require('path');
const sharp     = require('sharp');
const png2icons = require('png2icons');

const SRC = path.join(__dirname, '..', 'assets', 'icon.svg');
const OUT = path.join(__dirname, '..', 'assets');
const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error('Missing source SVG:', SRC);
    process.exit(1);
  }
  const svg = fs.readFileSync(SRC);

  // 1) Rasterise each size from the SVG. density 384 keeps strokes crisp at small sizes.
  const sizePngs = {};
  for (const size of SIZES) {
    const buf = await sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();
    fs.writeFileSync(path.join(OUT, `icon@${size}.png`), buf);
    sizePngs[size] = buf;
    console.log('  PNG', size + 'x' + size, '→', `assets/icon@${size}.png`);
  }

  // 2) Canonical icon.png (1024) — Linux electron-builder.
  fs.writeFileSync(path.join(OUT, 'icon.png'), sizePngs[1024]);
  console.log('  icon.png        (1024×1024)');

  // 3) icon.ico — Windows. Multi-resolution from the largest source PNG.
  //    png2icons.createICO(buf, scaler, 0, false) — scaler 0 = BICUBIC. The
  //    library auto-generates the standard ICO size set.
  const icoBuf = png2icons.createICO(sizePngs[1024], png2icons.BICUBIC, 0, false, true);
  if (!icoBuf) throw new Error('png2icons returned null for ICO');
  fs.writeFileSync(path.join(OUT, 'icon.ico'), icoBuf);
  console.log('  icon.ico        (multi-res from 1024 source)');

  // 4) icon.icns — macOS. Same source PNG, different container format.
  //    Critical for cross-building macOS from Windows: no iconutil dependency.
  const icnsBuf = png2icons.createICNS(sizePngs[1024], png2icons.BICUBIC, 0);
  if (!icnsBuf) throw new Error('png2icons returned null for ICNS');
  fs.writeFileSync(path.join(OUT, 'icon.icns'), icnsBuf);
  console.log('  icon.icns       (multi-res from 1024 source)');

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
