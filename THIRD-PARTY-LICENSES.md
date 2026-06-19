# Third-Party Licenses & Attributions

FLUX Hub is free software released under the **GNU General Public License v3.0 or
later** (see [`LICENSE`](./LICENSE)). The complete corresponding source code is
available at the project's public repository.

FLUX Hub bundles, vendors, or fetches at runtime the third-party components listed
below. Each remains under its own license, and the relevant copyright notices are
reproduced here in accordance with those licenses. This file is informational and
does not modify any of the licenses it references.

---

## 1. Runtime dependencies (npm, bundled in the application package)

| Component | Version | License | Project |
|---|---|---|---|
| Electron | 42.x | MIT | https://github.com/electron/electron |
| fabric.js | 7.4.x | MIT | https://github.com/fabricjs/fabric.js |
| music-metadata | 10.9.x | MIT | https://github.com/Borewit/music-metadata |
| node-id3 | 0.2.x | MIT | https://github.com/Zazama/node-id3 |
| pdfjs-dist (PDF.js) | 5.7.x | Apache-2.0 | https://github.com/mozilla/pdf.js |
| sharp | 0.34.x | Apache-2.0 | https://github.com/lovell/sharp |
| node-shazam | 1.2.x | **GPL-2.0** | https://github.com/Maxal30/node-shazam |
| electron-updater (optional) | 6.x | MIT | https://github.com/electron-userland/electron-builder |

**Note on `sharp`:** the native layer (`@img/sharp-*`) embeds **libvips**, licensed
**LGPL-3.0-or-later** (`Apache-2.0 AND LGPL-3.0-or-later`). libvips:
https://github.com/libvips/libvips

**Note on `node-shazam` (GPL-2.0):** this dependency is GPL-2.0. It is copyleft and
compatible with FLUX Hub's overall copyleft (GPL-3.0-or-later) distribution; its full
license text accompanies the package under `node_modules/node-shazam`.

---

## 2. Vendored front-end libraries (`renderer/vendor/`)

These are shipped as static files (no CDN) inside the renderer.

| File | Component | License | Project |
|---|---|---|---|
| `hls.min.js` | hls.js | Apache-2.0 | https://github.com/video-dev/hls.js |
| `wavesurfer.esm.js`, `wavesurfer.regions.esm.js` | WaveSurfer.js | BSD-3-Clause | https://github.com/katspaugh/wavesurfer.js |
| `pdf.min.mjs`, `pdf.worker.min.mjs` | PDF.js (Mozilla) | Apache-2.0 | https://github.com/mozilla/pdf.js |
| `fabric.min.mjs` | Fabric.js | MIT | https://github.com/fabricjs/fabric.js |
| `lucide.min.js` | Lucide icons | ISC | https://github.com/lucide-icons/lucide |

---

## 3. External binaries — fetched at runtime, NOT redistributed by FLUX Hub

To keep the installer slim, FLUX Hub does **not** bundle these binaries. On first use
of a feature that needs them, the application downloads them directly from their
official upstream sources to the user's machine (the user is the recipient of the
download, exactly as with a package manager). FLUX Hub therefore does not distribute
them and does not carry their source-distribution obligations; each tool's upstream is
the distributor.

| Binary | License | Official source |
|---|---|---|
| yt-dlp | Unlicense (public domain) | https://github.com/yt-dlp/yt-dlp |
| ffmpeg (Windows/Linux) | **GPL-3.0** (BtbN full GPL build) | https://github.com/BtbN/FFmpeg-Builds · https://ffmpeg.org |
| ffmpeg (macOS) | GPL | https://evermeet.cx/ffmpeg/ · https://ffmpeg.org |
| fpcalc / Chromaprint | LGPL-2.1-or-later | https://acoustid.org/chromaprint |

> If FLUX Hub is ever changed to bundle the GPL ffmpeg binary inside the installer, it
> would then be redistributing GPL software and must additionally provide or offer the
> corresponding ffmpeg source code. As long as ffmpeg is fetched from BtbN/ffmpeg.org
> at runtime, that obligation rests with the upstream distributor.

---

## 4. External services / APIs (queried, no code bundled)

FLUX Hub queries the following third-party services directly from the user's device.
No code from them is bundled; their terms/privacy policies apply to those queries:
MusicBrainz, Cover Art Archive, AcoustID, LRCLIB, RadioBrowser, OpenSubtitles,
Shazam (via node-shazam), and the BitTorrent / video sources the user chooses.

---

## 5. Bundled media assets

| Asset | Attribution | Source |
|---|---|---|
| `assets/splash.mp3` (startup sound) | Sound Effect by **Mauricio Póvoa** | Pixabay (Pixabay Content License) — https://pixabay.com/users/magiaz-10236927/ |

---

## Obtaining the source code (GPL-3.0)

In accordance with the GNU GPL, the complete corresponding source code for FLUX Hub is
available at the project's public repository. The full text of the GNU General Public
License v3.0 is in [`LICENSE`](./LICENSE).
