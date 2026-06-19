/**
 * fetch-ffmpeg.js
 * Downloads ffmpeg + ffprobe into vendor/ for XTRACT (and as a fallback for the
 * Shazam fluent-ffmpeg override). Mirrors the layout of fetch-ytdlp.js /
 * fetch-chromaprint.js: per-platform cache under vendor/.cache, active binary
 * stamped at vendor root, opposite-platform leftovers removed, +x set on Unix.
 *
 * Sources:
 *   - win32  / linux : BtbN/FFmpeg-Builds (release tag `latest`, single archive
 *                      contains both ffmpeg and ffprobe under bin/).
 *   - darwin         : evermeet.cx (separate zips for ffmpeg and ffprobe; the
 *                      published builds are universal x64 + arm64).
 *
 * Honours FLUX_TARGET_PLATFORM / FLUX_TARGET_ARCH so the existing cross-build
 * scripts (build-mac.ps1, build-linux.ps1) can stamp the right slot.
 */

const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const { execSync } = require('child_process');

const VENDOR_DIR = path.join(__dirname, '..', 'vendor');
const CACHE_DIR  = path.join(VENDOR_DIR, '.cache');

const BTBN_LATEST  = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';
const EVERMEET_API = 'https://evermeet.cx/ffmpeg/info';

// Per-platform recipe: archive URL builder, archive filename, internal layout.
// Using BtbN's full GPL build — includes libx264/x265 which the trim+convert
// flow needs for MP4/MKV output. Total weight ≈ 386 MB which forces us to
// distribute via the "portable" electron-builder target instead of NSIS;
// the bundled 32-bit makensis.exe can't allocate the mmap needed for that
// payload (#12345). When a future code-signing pass moves the build to a
// 64-bit NSIS we can re-enable the installer target.
function recipeFor(platform, arch) {
  if (platform === 'win32') {
    const asset = 'ffmpeg-master-latest-win64-gpl.zip';
    return {
      kind: 'btbn',
      arch: 'x64',
      archiveName: asset,
      url: `${BTBN_LATEST}/${asset}`,
      innerDir: 'ffmpeg-master-latest-win64-gpl',
      bins: { ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' }
    };
  }
  if (platform === 'linux') {
    const archTag = arch === 'arm64' ? 'linuxarm64' : 'linux64';
    const asset = `ffmpeg-master-latest-${archTag}-gpl.tar.xz`;
    return {
      kind: 'btbn',
      arch: arch === 'arm64' ? 'arm64' : 'x64',
      archiveName: asset,
      url: `${BTBN_LATEST}/${asset}`,
      innerDir: `ffmpeg-master-latest-${archTag}-gpl`,
      bins: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }
    };
  }
  if (platform === 'darwin') {
    // evermeet returns universal binaries — same archive works for x64 + arm64.
    return {
      kind: 'evermeet',
      arch: arch === 'arm64' ? 'arm64' : 'x64',
      bins: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }
    };
  }
  return null;
}

function httpsGet(url, opts = {}, _redirects = 0) {
  if (_redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'flux-build' }, ...opts }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        return httpsGet(res.headers.location, opts, _redirects + 1).then(resolve).catch(reject);
      }
      resolve(res);
    }).on('error', reject);
  });
}

function fetchJSON(url) {
  return httpsGet(url).then(res => new Promise((resolve, reject) => {
    if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    res.on('error', reject);
  }));
}

function downloadFile(url, dest) {
  return httpsGet(url).then(res => new Promise((resolve, reject) => {
    if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
    const total = parseInt(res.headers['content-length'] || '0', 10);
    let received = 0, lastPctLogged = -10;
    const file = fs.createWriteStream(dest);
    res.on('data', chunk => {
      received += chunk.length;
      if (total > 0) {
        const pct = Math.round(received / total * 100);
        // Log every 10% so non-TTY hosts (PowerShell capture, CI) don't flood.
        if (pct - lastPctLogged >= 10) {
          process.stdout.write(`  Downloading... ${pct}%\n`);
          lastPctLogged = pct;
        }
      }
    });
    res.pipe(file);
    file.on('finish', () => file.close(() => { process.stdout.write('  Download complete.\n'); resolve(); }));
    file.on('error', err => { fs.unlink(dest, () => {}); reject(err); });
    res.on('error', reject);
  }));
}

function extractArchive(archivePath, destDir) {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.zip')) {
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force"`,
        { stdio: 'inherit' }
      );
    } else {
      execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: 'inherit' });
    }
    return;
  }
  if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) {
    // Windows 10+ ships a libarchive-based tar.exe that handles xz.
    execSync(`tar -xJf "${archivePath}" -C "${destDir}"`, { stdio: 'inherit' });
    return;
  }
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: 'inherit' });
    return;
  }
  throw new Error(`Unsupported archive format: ${archivePath}`);
}

// ── BtbN path: archive contains ffmpeg + ffprobe, we keep both ──────────────
// Bundling ffprobe is non-negotiable: yt-dlp's postprocessor (audio extract,
// video+audio merge) requires BOTH ffmpeg AND ffprobe, and the user's machine
// might have neither system-wide. The size cost (~80-100 MB extra per
// platform) buys us a media-download path that works on stock OS installs.
async function fetchBtbn(recipe, cacheBase) {
  const stampFfmpeg  = path.join(cacheBase, recipe.bins.ffmpeg);
  const stampFfprobe = path.join(cacheBase, recipe.bins.ffprobe);
  if (fs.existsSync(stampFfmpeg) && fs.existsSync(stampFfprobe)) {
    console.log(`ffmpeg+ffprobe cache hit at ${path.relative(VENDOR_DIR, cacheBase)} — skipping download.`);
    return { ffmpeg: stampFfmpeg, ffprobe: stampFfprobe };
  }
  fs.mkdirSync(cacheBase, { recursive: true });
  const archivePath = path.join(cacheBase, recipe.archiveName);
  console.log(`Downloading ${recipe.archiveName} from BtbN/FFmpeg-Builds...`);
  await downloadFile(recipe.url, archivePath);
  console.log('Extracting…');
  extractArchive(archivePath, cacheBase);
  const innerBin = path.join(cacheBase, recipe.innerDir, 'bin');
  const srcFfmpeg  = path.join(innerBin, recipe.bins.ffmpeg);
  const srcFfprobe = path.join(innerBin, recipe.bins.ffprobe);
  if (!fs.existsSync(srcFfmpeg))  throw new Error(`Expected ffmpeg under ${innerBin} not found — BtbN archive layout may have changed.`);
  if (!fs.existsSync(srcFfprobe)) throw new Error(`Expected ffprobe under ${innerBin} not found — BtbN archive layout may have changed.`);
  fs.renameSync(srcFfmpeg,  stampFfmpeg);
  fs.renameSync(srcFfprobe, stampFfprobe);
  try { fs.rmSync(path.join(cacheBase, recipe.innerDir), { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(archivePath); } catch {}
  return { ffmpeg: stampFfmpeg, ffprobe: stampFfprobe };
}

// ── evermeet path: separate zip for ffmpeg AND ffprobe ──────────────────────
async function fetchEvermeet(recipe, cacheBase) {
  const stampFfmpeg  = path.join(cacheBase, recipe.bins.ffmpeg);
  const stampFfprobe = path.join(cacheBase, recipe.bins.ffprobe);
  if (fs.existsSync(stampFfmpeg) && fs.existsSync(stampFfprobe)) {
    console.log(`ffmpeg+ffprobe cache hit at ${path.relative(VENDOR_DIR, cacheBase)} — skipping download.`);
    return { ffmpeg: stampFfmpeg, ffprobe: stampFfprobe };
  }
  fs.mkdirSync(cacheBase, { recursive: true });

  // ffmpeg
  if (!fs.existsSync(stampFfmpeg)) {
    console.log('Querying evermeet.cx for ffmpeg release info...');
    const info = await fetchJSON(`${EVERMEET_API}/ffmpeg/release`);
    const zipUrl = info.download?.zip?.url || info.url;
    if (!zipUrl) throw new Error(`evermeet response missing ffmpeg URL: ${JSON.stringify(info).slice(0, 200)}`);
    const archivePath = path.join(cacheBase, `ffmpeg-${info.version || 'release'}.zip`);
    console.log(`Downloading ffmpeg ${info.version || ''} from evermeet.cx...`);
    await downloadFile(zipUrl, archivePath);
    console.log('Extracting ffmpeg…');
    extractArchive(archivePath, cacheBase);
    if (!fs.existsSync(stampFfmpeg)) throw new Error(`Expected ffmpeg at ${stampFfmpeg} after extraction — evermeet layout may have changed.`);
    try { fs.unlinkSync(archivePath); } catch {}
  }

  // ffprobe (separate evermeet release endpoint + ZIP)
  if (!fs.existsSync(stampFfprobe)) {
    console.log('Querying evermeet.cx for ffprobe release info...');
    const info = await fetchJSON(`${EVERMEET_API}/ffprobe/release`);
    const zipUrl = info.download?.zip?.url || info.url;
    if (!zipUrl) throw new Error(`evermeet response missing ffprobe URL: ${JSON.stringify(info).slice(0, 200)}`);
    const archivePath = path.join(cacheBase, `ffprobe-${info.version || 'release'}.zip`);
    console.log(`Downloading ffprobe ${info.version || ''} from evermeet.cx...`);
    await downloadFile(zipUrl, archivePath);
    console.log('Extracting ffprobe…');
    extractArchive(archivePath, cacheBase);
    if (!fs.existsSync(stampFfprobe)) throw new Error(`Expected ffprobe at ${stampFfprobe} after extraction — evermeet layout may have changed.`);
    try { fs.unlinkSync(archivePath); } catch {}
  }

  return { ffmpeg: stampFfmpeg, ffprobe: stampFfprobe };
}

async function main() {
  const platform = process.env.FLUX_TARGET_PLATFORM || process.platform;
  const arch     = process.env.FLUX_TARGET_ARCH     || process.arch;

  const recipe = recipeFor(platform, arch);
  if (!recipe) {
    console.error(`Unsupported target platform/arch: ${platform}/${arch}`);
    console.error('Supported: win32 (x64), linux (x64, arm64), darwin (x64, arm64)');
    process.exit(0); // non-fatal — XTRACT will fall back to PATH lookup
  }

  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Per-platform cache slot so cross-builds don't re-download.
  //   vendor/.cache/ffmpeg-win32-x64/{ffmpeg.exe, ffprobe.exe}
  //   vendor/.cache/ffmpeg-linux-x64/{ffmpeg, ffprobe}
  //   vendor/.cache/ffmpeg-darwin-x64/{ffmpeg, ffprobe}
  const cacheBase = path.join(CACHE_DIR, `ffmpeg-${platform}-${recipe.arch}`);

  console.log(`Target: ${platform}/${recipe.arch} (kind=${recipe.kind})`);

  const cached = recipe.kind === 'btbn'
    ? await fetchBtbn(recipe, cacheBase)
    : await fetchEvermeet(recipe, cacheBase);

  // ── Stamp both binaries at vendor root, overwriting any prior ones ──
  const ffmpegDest  = path.join(VENDOR_DIR, recipe.bins.ffmpeg);
  const ffprobeDest = path.join(VENDOR_DIR, recipe.bins.ffprobe);
  fs.copyFileSync(cached.ffmpeg,  ffmpegDest);
  fs.copyFileSync(cached.ffprobe, ffprobeDest);

  // Remove opposite-platform ffmpeg/ffprobe leftovers so the packaged
  // bundle never ships a wrong-platform binary (e.g. ffmpeg.exe carried
  // over from a Windows checkout into a Mac build).
  for (const n of ['ffmpeg', 'ffmpeg.exe', 'ffprobe', 'ffprobe.exe']) {
    if (n === recipe.bins.ffmpeg || n === recipe.bins.ffprobe) continue;
    const stale = path.join(VENDOR_DIR, n);
    if (fs.existsSync(stale)) { try { fs.unlinkSync(stale); } catch {} }
  }

  if (process.platform !== 'win32') {
    try { fs.chmodSync(ffmpegDest,  0o755); } catch {}
    try { fs.chmodSync(ffprobeDest, 0o755); } catch {}
  }

  console.log(`✓ ffmpeg ready:  ${ffmpegDest}`);
  console.log(`✓ ffprobe ready: ${ffprobeDest}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
