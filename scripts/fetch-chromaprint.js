/**
 * fetch-chromaprint.js
 * Downloads fpcalc (Chromaprint) into vendor/ for AcoustID fingerprinting.
 * Runs at build time; binary is bundled via package.json `extraResources`.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');

const VENDOR_DIR = path.join(__dirname, '..', 'vendor');
const RELEASES   = 'https://api.github.com/repos/acoustid/chromaprint/releases/latest';

const PLATFORM_MAP = { win32: 'windows', darwin: 'macos', linux: 'linux' };
const ARCH_MAP     = { x64: 'x86_64', arm64: 'arm64' };

function fetchJSON(url, _redirects = 0) {
  if (_redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'flux-build' } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        return fetchJSON(res.headers.location, _redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function downloadFile(url, dest, _redirects = 0) {
  if (_redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const follow = u => {
      https.get(u, { headers: { 'User-Agent': 'flux-build' } }, res => {
        if ([301, 302, 307, 308].includes(res.statusCode)) return follow(res.headers.location);
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0, lastPct = -1;
        const file = fs.createWriteStream(dest);
        res.on('data', chunk => {
          received += chunk.length;
          if (total > 0) {
            const pct = Math.round(received / total * 100);
            if (pct !== lastPct && pct % 5 === 0) {
              process.stdout.write(`\r  Downloading... ${pct}%`);
              lastPct = pct;
            }
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => { process.stdout.write('\n'); resolve(); }));
        file.on('error', err => { fs.unlink(dest, () => {}); reject(err); });
        res.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

async function main() {
  // Honour FLUX_TARGET_PLATFORM for cross-builds (e.g. Win → macOS).
  const platform = process.env.FLUX_TARGET_PLATFORM || process.platform;
  const arch     = process.env.FLUX_TARGET_ARCH
    ? (ARCH_MAP[process.env.FLUX_TARGET_ARCH] || process.env.FLUX_TARGET_ARCH)
    : (ARCH_MAP[process.arch] || process.arch);
  const platName = PLATFORM_MAP[platform];

  if (!platName) {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(0); // non-fatal — fpcalc just won't be available
  }

  const binName   = platform === 'win32' ? 'fpcalc.exe' : 'fpcalc';
  const destPath  = path.join(VENDOR_DIR, binName);
  const otherName = platform === 'win32' ? 'fpcalc' : 'fpcalc.exe';
  const otherPath = path.join(VENDOR_DIR, otherName);

  // Per-platform cache (mirrors fetch-ytdlp.js layout).
  const cacheDir  = path.join(VENDOR_DIR, '.cache');
  const cacheBin  = platform === 'win32' ? 'fpcalc-win32.exe' : `fpcalc-${platform}-${arch}`;
  const cachePath = path.join(cacheDir, cacheBin);

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  if (!fs.existsSync(cachePath)) {
    console.log('Fetching latest Chromaprint release info...');
    const release = await fetchJSON(RELEASES);
    const version = release.tag_name.replace(/^v/, '');
    const ext     = platform === 'win32' ? 'zip' : 'tar.gz';
    const expectedAssetName = `chromaprint-fpcalc-${version}-${platName}-${arch}.${ext}`;
    let asset = release.assets.find(a => a.name === expectedAssetName);
    if (!asset) {
      asset = release.assets.find(a => a.name.includes(platName) && a.name.includes(arch) && a.name.endsWith(ext));
    }
    if (!asset) {
      console.error(`No Chromaprint asset found for ${platName}-${arch}. Available:`);
      release.assets.forEach(a => console.error(`  ${a.name}`));
      process.exit(1);
    }
    const archivePath = path.join(cacheDir, asset.name);
    console.log(`Downloading ${asset.name} to cache...`);
    await downloadFile(asset.browser_download_url, archivePath);
    console.log('Extracting…');
    if (ext === 'zip') {
      if (process.platform === 'win32') {
        execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${cacheDir.replace(/'/g, "''")}' -Force"`, { stdio: 'inherit' });
      } else {
        execSync(`unzip -o "${archivePath}" -d "${cacheDir}"`, { stdio: 'inherit' });
      }
    } else {
      execSync(`tar -xzf "${archivePath}" -C "${cacheDir}"`, { stdio: 'inherit' });
    }
    const extractedDirName = asset.name.replace(/\.(zip|tar\.gz)$/, '');
    const extractedBin     = path.join(cacheDir, extractedDirName, binName);
    if (fs.existsSync(extractedBin)) {
      fs.renameSync(extractedBin, cachePath);
      fs.rmSync(path.join(cacheDir, extractedDirName), { recursive: true, force: true });
    } else {
      console.error(`fpcalc not found in expected location ${extractedBin}`);
      process.exit(1);
    }
    try { fs.unlinkSync(archivePath); } catch {}
  } else {
    console.log(`fpcalc (${platform}-${arch}) cache hit — skipping download.`);
  }

  // Stamp the active binary at vendor root; remove stale opposite-platform one.
  fs.copyFileSync(cachePath, destPath);
  if (fs.existsSync(otherPath)) { try { fs.unlinkSync(otherPath); } catch {} }
  if (process.platform !== 'win32') { try { fs.chmodSync(destPath, 0o755); } catch {} }
  console.log(`✓ fpcalc saved to ${destPath}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
