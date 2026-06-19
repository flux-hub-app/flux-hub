'use strict';

/**
 * binary-fetcher.js — runtime (first-use) downloader for FLUX's external
 * binaries. Phase 2b of the modular architecture: instead of bundling
 * ~180 MB of yt-dlp + ffmpeg + ffprobe + fpcalc into the installer, the
 * installer ships slim and FLUX fetches each binary the first time the user
 * opens a module that needs it.
 *
 * This is the runtime sibling of scripts/fetch-*.js (which run at BUILD time
 * to populate the project vendor/ for dev). Same sources, same archive
 * layouts — but the destination is the writable userData/vendor (see
 * VENDOR_DIR in main.js) and progress is surfaced to the renderer via an
 * onProgress callback instead of stdout.
 *
 * Sources (all OSS, no DRM):
 *   - yt-dlp  : github.com/yt-dlp/yt-dlp releases (latest)
 *   - ffmpeg  : BtbN/FFmpeg-Builds (win/linux, one archive = ffmpeg+ffprobe)
 *               evermeet.cx (macOS, separate zips, universal x64+arm64)
 *   - ffprobe : same archive as ffmpeg — fetching either yields both
 *   - fpcalc  : acoustid/chromaprint releases (latest)
 *
 * Extraction uses OS tools that exist on every supported platform inside a
 * packaged app: PowerShell Expand-Archive / unzip for .zip, and the
 * Windows-10+/Unix `tar` for .tar.xz / .tar.gz.
 *
 * Networking: prefers Electron's `net` module (Chromium network stack), which
 * uses the OS certificate store — critical behind corporate TLS-intercepting
 * proxies where Node's bundled CA bundle rejects the chain ("unable to verify
 * the first certificate"). It also honours the system proxy automatically.
 * Falls back to Node `https` when Electron isn't present (e.g. CLI unit tests).
 */

const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const { execSync } = require('child_process');

const UA = 'flux-runtime-fetch';

// Electron's net (Chromium stack → system CA + system proxy). Absent in a
// plain-node context, in which case we fall back to the https module.
let electronNet = null;
try { electronNet = require('electron').net; } catch { /* not in Electron */ }

const YTDLP_RELEASES = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const CHROMA_RELEASES = 'https://api.github.com/repos/acoustid/chromaprint/releases/latest';
const BTBN_LATEST  = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';
const EVERMEET_API = 'https://evermeet.cx/ffmpeg/info';

const YTDLP_ASSET = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp' };
const CHROMA_PLATFORM = { win32: 'windows', darwin: 'macos', linux: 'linux' };
const CHROMA_ARCH     = { x64: 'x86_64', arm64: 'arm64' };

// On-disk filename for a given binary id on a given platform.
function binFilename(id, platform) {
  const exe = platform === 'win32';
  switch (id) {
    case 'yt-dlp':  return exe ? 'yt-dlp.exe'  : 'yt-dlp';
    case 'ffmpeg':  return exe ? 'ffmpeg.exe'  : 'ffmpeg';
    case 'ffprobe': return exe ? 'ffprobe.exe' : 'ffprobe';
    case 'fpcalc':  return exe ? 'fpcalc.exe'  : 'fpcalc';
    default: return id + (exe ? '.exe' : '');
  }
}

// Is the binary already present in the writable vendor dir?
function isPresent(id, vendorDir) {
  try { return fs.existsSync(path.join(vendorDir, binFilename(id, process.platform))); }
  catch { return false; }
}

// ─── HTTP ────────────────────────────────────────────────────────────────────
// Resolve a GET to a response object exposing .statusCode / .headers and the
// Node-stream-style .on('data'|'end'|'error') + .pause()/.resume(). Electron
// net auto-follows redirects; the https fallback follows them manually.
function rawGet(url, _redirects = 0) {
  if (electronNet) {
    return new Promise((resolve, reject) => {
      const req = electronNet.request({ url, redirect: 'follow' });
      req.setHeader('User-Agent', UA);
      req.on('response', res => resolve(res));
      req.on('error', reject);
      req.end();
    });
  }
  if (_redirects > 6) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        res.resume();
        return rawGet(res.headers.location, _redirects + 1).then(resolve).catch(reject);
      }
      resolve(res);
    }).on('error', reject);
  });
}

function fetchJSON(url) {
  return rawGet(url).then(res => new Promise((resolve, reject) => {
    if (res.statusCode !== 200) { try { res.resume(); } catch {} return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    res.on('error', reject);
  }));
}

// HEAD a URL and return its Content-Length in bytes (0 on any failure). Used by
// probeSize for ffmpeg, where there's no API to ask — only the archive itself.
function headContentLength(url, _redirects = 0) {
  return new Promise(resolve => {
    if (_redirects > 6) return resolve(0);
    try {
      if (electronNet) {
        const req = electronNet.request({ method: 'HEAD', url, redirect: 'follow' });
        req.setHeader('User-Agent', UA);
        req.on('response', res => {
          resolve(parseInt(res.headers['content-length'] || '0', 10) || 0);
          res.on('data', () => {}); res.on('end', () => {});
        });
        req.on('error', () => resolve(0));
        req.end();
      } else {
        const u = new URL(url);
        const r = https.request({ method: 'HEAD', hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': UA } }, res => {
          if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume(); return headContentLength(res.headers.location, _redirects + 1).then(resolve);
          }
          resolve(parseInt(res.headers['content-length'] || '0', 10) || 0); res.resume();
        });
        r.on('error', () => resolve(0));
        r.end();
      }
    } catch { resolve(0); }
  });
}

// Best-effort precise download size in BYTES for a binary id (0 if unknown).
// yt-dlp/fpcalc: the release API exposes asset.size. ffmpeg/ffprobe: HEAD the
// archive (one archive carries both; on macOS sum the two evermeet zips).
async function probeSize(id, opts = {}) {
  const platform = opts.platform || process.platform;
  const arch     = opts.arch || process.arch;
  try {
    if (id === 'yt-dlp') {
      const rel = await fetchJSON(YTDLP_RELEASES);
      const a = (rel.assets || []).find(x => x.name === YTDLP_ASSET[platform]);
      return a?.size || 0;
    }
    if (id === 'fpcalc') {
      const rel = await fetchJSON(CHROMA_RELEASES);
      const version = rel.tag_name.replace(/^v/, '');
      const platName = CHROMA_PLATFORM[platform]; const archName = CHROMA_ARCH[arch] || arch;
      const ext = platform === 'win32' ? 'zip' : 'tar.gz';
      const a = (rel.assets || []).find(x => x.name === `chromaprint-fpcalc-${version}-${platName}-${archName}.${ext}`)
             || (rel.assets || []).find(x => x.name.includes(platName) && x.name.includes(archName) && x.name.endsWith(ext));
      return a?.size || 0;
    }
    if (id === 'ffmpeg' || id === 'ffprobe') {
      if (platform === 'win32' || platform === 'linux') {
        const asset = platform === 'win32'
          ? 'ffmpeg-master-latest-win64-gpl.zip'
          : `ffmpeg-master-latest-${arch === 'arm64' ? 'linuxarm64' : 'linux64'}-gpl.tar.xz`;
        return await headContentLength(`${BTBN_LATEST}/${asset}`);
      }
      if (platform === 'darwin') {
        let total = 0;
        for (const n of ['ffmpeg', 'ffprobe']) {
          const info = await fetchJSON(`${EVERMEET_API}/${n}/release`);
          total += info.download?.zip?.size || info.size || 0;
        }
        return total;
      }
    }
  } catch { return 0; }
  return 0;
}

// Download with a throttled progress callback (every ~1%). Writes via manual
// data handling (not .pipe) so it works uniformly across Electron net and
// Node https responses, with backpressure to cap memory on large archives.
function downloadFile(url, dest, onPct) {
  return rawGet(url).then(res => new Promise((resolve, reject) => {
    if (res.statusCode !== 200) { try { res.resume(); } catch {} return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
    const total = parseInt(res.headers['content-length'] || '0', 10);
    let received = 0, lastPct = -1;
    const file = fs.createWriteStream(dest);
    file.on('error', err => { fs.unlink(dest, () => {}); reject(err); });
    res.on('data', chunk => {
      received += chunk.length;
      if (!file.write(chunk)) { res.pause(); file.once('drain', () => res.resume()); }
      if (total > 0 && onPct) {
        const pct = Math.floor(received / total * 100);
        if (pct !== lastPct) { lastPct = pct; onPct(pct, received, total); }
      }
    });
    res.on('end', () => file.end(() => resolve()));
    res.on('error', reject);
  }));
}

// ─── EXTRACTION ────────────────────────────────────────────────────────────
function extractArchive(archivePath, destDir) {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.zip')) {
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -NonInteractive -Command "Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force"`,
        { stdio: 'ignore' }
      );
    } else {
      execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: 'ignore' });
    }
    return;
  }
  if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) {
    execSync(`tar -xJf "${archivePath}" -C "${destDir}"`, { stdio: 'ignore' });
    return;
  }
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: 'ignore' });
    return;
  }
  throw new Error(`Unsupported archive format: ${archivePath}`);
}

// Recursively find a file by name under a directory (BtbN/chromaprint archives
// nest the binary one level deep, but the inner folder name carries a version
// we don't want to hard-code — so we search instead of assuming the path).
function findFile(dir, name) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { const hit = findFile(full, name); if (hit) return hit; }
    else if (e.name === name) return full;
  }
  return null;
}

function chmodX(p) {
  if (process.platform !== 'win32') { try { fs.chmodSync(p, 0o755); } catch {} }
}

// ─── PER-BINARY FETCHERS ─────────────────────────────────────────────────────
async function fetchYtDlp(ctx) {
  const { platform, vendorDir, tmpDir, emit } = ctx;
  const assetName = YTDLP_ASSET[platform];
  if (!assetName) throw new Error(`yt-dlp: unsupported platform ${platform}`);
  emit({ phase: 'resolving' });
  const release = await fetchJSON(YTDLP_RELEASES);
  const asset = (release.assets || []).find(a => a.name === assetName);
  if (!asset) throw new Error(`yt-dlp asset "${assetName}" not found in ${release.tag_name}`);
  const dest = path.join(vendorDir, binFilename('yt-dlp', platform));
  const tmp  = path.join(tmpDir, assetName);
  emit({ phase: 'downloading', pct: 0 });
  await downloadFile(asset.browser_download_url, tmp, (pct, rec, tot) => emit({ phase: 'downloading', pct, received: rec, total: tot }));
  fs.copyFileSync(tmp, dest);
  chmodX(dest);
  return ['yt-dlp'];
}

async function fetchFfmpeg(ctx) {
  const { platform, arch, vendorDir, tmpDir, emit } = ctx;
  const ffmpegDest  = path.join(vendorDir, binFilename('ffmpeg', platform));
  const ffprobeDest = path.join(vendorDir, binFilename('ffprobe', platform));
  emit({ phase: 'resolving' });

  if (platform === 'win32' || platform === 'linux') {
    let asset, inner;
    if (platform === 'win32') {
      asset = 'ffmpeg-master-latest-win64-gpl.zip';
      inner = 'ffmpeg.exe';
    } else {
      const tag = arch === 'arm64' ? 'linuxarm64' : 'linux64';
      asset = `ffmpeg-master-latest-${tag}-gpl.tar.xz`;
      inner = 'ffmpeg';
    }
    const archivePath = path.join(tmpDir, asset);
    emit({ phase: 'downloading', pct: 0 });
    await downloadFile(`${BTBN_LATEST}/${asset}`, archivePath, (pct, rec, tot) => emit({ phase: 'downloading', pct, received: rec, total: tot }));
    emit({ phase: 'extracting' });
    extractArchive(archivePath, tmpDir);
    const srcFfmpeg  = findFile(tmpDir, binFilename('ffmpeg', platform));
    const srcFfprobe = findFile(tmpDir, binFilename('ffprobe', platform));
    if (!srcFfmpeg || !srcFfprobe) throw new Error('ffmpeg/ffprobe not found in BtbN archive — layout may have changed');
    fs.copyFileSync(srcFfmpeg, ffmpegDest);
    fs.copyFileSync(srcFfprobe, ffprobeDest);
  } else if (platform === 'darwin') {
    // evermeet: separate zips for ffmpeg and ffprobe (universal binaries).
    for (const [name, dest] of [['ffmpeg', ffmpegDest], ['ffprobe', ffprobeDest]]) {
      const info = await fetchJSON(`${EVERMEET_API}/${name}/release`);
      const zipUrl = info.download?.zip?.url || info.url;
      if (!zipUrl) throw new Error(`evermeet response missing ${name} URL`);
      const archivePath = path.join(tmpDir, `${name}.zip`);
      emit({ phase: 'downloading', pct: 0 });
      await downloadFile(zipUrl, archivePath, (pct, rec, tot) => emit({ phase: 'downloading', pct, received: rec, total: tot }));
      emit({ phase: 'extracting' });
      extractArchive(archivePath, tmpDir);
      const src = findFile(tmpDir, name);
      if (!src) throw new Error(`${name} not found after evermeet extraction`);
      fs.copyFileSync(src, dest);
    }
  } else {
    throw new Error(`ffmpeg: unsupported platform ${platform}`);
  }
  chmodX(ffmpegDest);
  chmodX(ffprobeDest);
  return ['ffmpeg', 'ffprobe'];
}

async function fetchFpcalc(ctx) {
  const { platform, arch, vendorDir, tmpDir, emit } = ctx;
  const platName = CHROMA_PLATFORM[platform];
  const archName = CHROMA_ARCH[arch] || arch;
  if (!platName) throw new Error(`fpcalc: unsupported platform ${platform}`);
  emit({ phase: 'resolving' });
  const release = await fetchJSON(CHROMA_RELEASES);
  const version = release.tag_name.replace(/^v/, '');
  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  const expected = `chromaprint-fpcalc-${version}-${platName}-${archName}.${ext}`;
  let asset = (release.assets || []).find(a => a.name === expected)
           || (release.assets || []).find(a => a.name.includes(platName) && a.name.includes(archName) && a.name.endsWith(ext));
  if (!asset) throw new Error(`fpcalc asset for ${platName}-${archName} not found in ${release.tag_name}`);
  const archivePath = path.join(tmpDir, asset.name);
  emit({ phase: 'downloading', pct: 0 });
  await downloadFile(asset.browser_download_url, archivePath, (pct, rec, tot) => emit({ phase: 'downloading', pct, received: rec, total: tot }));
  emit({ phase: 'extracting' });
  extractArchive(archivePath, tmpDir);
  const src = findFile(tmpDir, binFilename('fpcalc', platform));
  if (!src) throw new Error('fpcalc not found after extraction');
  const dest = path.join(vendorDir, binFilename('fpcalc', platform));
  fs.copyFileSync(src, dest);
  chmodX(dest);
  return ['fpcalc'];
}

const FETCHERS = {
  'yt-dlp':  fetchYtDlp,
  'ffmpeg':  fetchFfmpeg,
  'ffprobe': fetchFfmpeg,   // same archive yields both
  'fpcalc':  fetchFpcalc,
};

/**
 * Fetch a binary by id into vendorDir.
 * @param {string} id  one of yt-dlp | ffmpeg | ffprobe | fpcalc
 * @param {{ vendorDir:string, platform?:string, arch?:string, onProgress?:(p)=>void }} opts
 * @returns {Promise<{ok:boolean, fetched?:string[], error?:string}>}
 *   `fetched` lists every binary id now present as a result (ffmpeg → both).
 */
async function fetchBinary(id, opts = {}) {
  const fetcher = FETCHERS[id];
  if (!fetcher) return { ok: false, error: `Unknown binary: ${id}` };
  const platform = opts.platform || process.platform;
  const arch     = opts.arch || process.arch;
  const vendorDir = opts.vendorDir;
  if (!vendorDir) return { ok: false, error: 'vendorDir is required' };
  const emit = p => { try { opts.onProgress && opts.onProgress({ id, ...p }); } catch {} };

  // Per-fetch scratch dir under the vendor dir; wiped on success and failure.
  const tmpDir = path.join(vendorDir, `.fetch-tmp-${id}`);
  try {
    fs.mkdirSync(vendorDir, { recursive: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    const fetched = await fetcher({ id, platform, arch, vendorDir, tmpDir, emit });
    emit({ phase: 'done', pct: 100 });
    return { ok: true, fetched };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { fetchBinary, isPresent, binFilename, probeSize };
