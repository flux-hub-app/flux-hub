/**
 * fetch-ytdlp.js
 * Scarica yt-dlp nella cartella vendor/ prima del build.
 * Eseguito automaticamente da "npm run fetch-ytdlp".
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// Vendor lives at PROJECT ROOT (not under scripts/) — needed by package.json extraResources/asarUnpack
const VENDOR_DIR = path.join(__dirname, '..', 'vendor');
const RELEASES   = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';

const ASSET_MAP = {
  win32:  'yt-dlp.exe',
  darwin: 'yt-dlp_macos',
  linux:  'yt-dlp'
};

async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'ybd-downloader-build' }
    }, (res) => {
      // Follow redirect
      if (res.statusCode === 302 || res.statusCode === 301) {
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, { headers: { 'User-Agent': 'ybd-downloader-build' } }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          return follow(res.headers.location);
        }
        const total = parseInt(res.headers['content-length'] || '0');
        let received = 0;
        let lastPctLogged = -10;
        const file = fs.createWriteStream(dest);
        res.on('data', chunk => {
          received += chunk.length;
          file.write(chunk);
          if (total > 0) {
            const pct = Math.round(received / total * 100);
            // Log only every 10% so non-TTY hosts (PowerShell tool capture,
            // CI logs) don't get flooded.
            if (pct - lastPctLogged >= 10) {
              process.stdout.write(`  Downloading... ${pct}%\n`);
              lastPctLogged = pct;
            }
          }
        });
        res.on('end', () => { file.end(); process.stdout.write('  Download complete.\n'); resolve(); });
        res.on('error', reject);
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

async function main() {
  // Target platform = build platform (FLUX_TARGET_PLATFORM env var) ?? runtime.
  const platform   = process.env.FLUX_TARGET_PLATFORM || process.platform;
  const assetName  = ASSET_MAP[platform];

  if (!assetName) {
    console.error(`Unsupported target platform: ${platform}`);
    console.error(`Supported: ${Object.keys(ASSET_MAP).join(', ')}`);
    process.exit(1);
  }

  const destName  = platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const destPath  = path.join(VENDOR_DIR, destName);
  const otherName = platform === 'win32' ? 'yt-dlp' : 'yt-dlp.exe';
  const otherPath = path.join(VENDOR_DIR, otherName);

  // Per-platform cache slot so consecutive cross-builds don't re-download.
  // Layout:
  //   vendor/.cache/yt-dlp-win32.exe
  //   vendor/.cache/yt-dlp-darwin
  //   vendor/.cache/yt-dlp-linux
  // The active build copies the right slot to vendor/yt-dlp[.exe].
  const cacheDir  = path.join(VENDOR_DIR, '.cache');
  const cacheBin  = platform === 'win32' ? 'yt-dlp-win32.exe' : `yt-dlp-${platform}`;
  const cachePath = path.join(cacheDir, cacheBin);

  console.log(`Target platform: ${platform} (asset: ${assetName})`);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  if (fs.existsSync(cachePath)) {
    console.log(`yt-dlp (${platform}) cache hit — skipping download.`);
  } else {
    console.log('Fetching latest yt-dlp release info...');
    const release = await fetchJSON(RELEASES);
    const asset   = release.assets.find(a => a.name === assetName);
    if (!asset) {
      console.error(`Asset "${assetName}" not found in release ${release.tag_name}`);
      process.exit(1);
    }
    console.log(`Downloading yt-dlp ${release.tag_name} (${assetName}) to cache...`);
    await downloadFile(asset.browser_download_url, cachePath);
  }

  // Stamp the active binary at vendor root. Always overwrite — if a previous
  // build left the wrong-platform binary, replace it. Also delete the OTHER
  // platform's variant if it lingers, so electron-builder can't pick it up.
  fs.copyFileSync(cachePath, destPath);
  if (fs.existsSync(otherPath)) {
    try { fs.unlinkSync(otherPath); } catch {}
  }

  if (platform !== 'win32' && process.platform !== 'win32') {
    fs.chmodSync(destPath, 0o755);
  }

  console.log(`✓ yt-dlp ready: ${destPath}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
