# FLUX Hub
### Fetch · Load · Use · eXtract

A free, open-source **desktop media hub** for **Windows, macOS and Linux**. FLUX Hub
unifies a set of best-of-breed open-source tools — yt-dlp, ffmpeg, Chromaprint,
WaveSurfer and more — behind one clean, coherent interface, so you can fetch media
from public sources, organise and tag your library, then convert or edit it, without
juggling command lines or scattered websites.

Everything runs locally on your device: **no account, no cloud, no telemetry, no ads.**

## Download

[![Download latest release](https://img.shields.io/github/v/release/flux-hub-app/flux-hub?display_name=tag&label=Download%20FLUX%20Hub&color=c8f542&style=for-the-badge)](https://github.com/flux-hub-app/flux-hub/releases/latest)

**[⬇️ Get the latest version → Windows · macOS · Linux](https://github.com/flux-hub-app/flux-hub/releases/latest)** — just download the file for your system and run it. No account, no setup. (First launch shows a one-time security prompt on each OS — see [For the end user](#for-the-end-user).)

> The installer is **slim** — the external binaries (yt-dlp, ffmpeg, fpcalc) are
> downloaded automatically from their official upstream sources the first time you use
> a feature that needs them.

The name says what it does: **F**etch (from public sources) · **L**oad (organise, tag,
queue) · **U**se (play, identify, edit) · e**X**tract (convert, compress, extract).

> 🇮🇹 **Italiano** — FLUX Hub è un media manager desktop gratuito e open-source (Windows,
> macOS, Linux) che unifica strumenti come yt-dlp, ffmpeg e Chromaprint dietro un'unica
> interfaccia: scarica media da fonti pubbliche, organizza e tagga la libreria, converti
> ed edita — tutto **in locale, senza account, cloud, telemetria o pubblicità**. La
> documentazione completa è in inglese qui sotto. Uso esclusivamente lecito: i Termini e
> la Privacy (versione italiana vincolante) sono mostrati al primo avvio.

---

## Contents

- [Download](#download)
- [For the end user](#for-the-end-user)
- [Modules & features](#modules--features)
- [Modular architecture](#modular-architecture)
- [Support the project](#support-the-project)
- [For developers — building from source](#for-developers--building-from-source)
- [Architecture & tech stack](#architecture--tech-stack)
- [Profiles & `.flux` files](#profiles--flux-files)
- [Project structure](#project-structure)
- [Release process](#release-process)
- [Auto-update](#auto-update)
- [Legal & licensing](#legal--licensing)
- [Configuration files](#configuration-files)

---

## For the end user

Download and run the installer for your platform:

| Platform | File |
|---|---|
| Windows | `FLUX Hub Setup x.x.x.exe` — guided installer |
| Windows | `FLUX Hub x.x.x.exe` — portable, no install |
| macOS | `FLUX Hub-x.x.x-arm64.dmg` / `-x64.dmg` — drag into Applications |
| Linux | `FLUX Hub-x.x.x.AppImage` (also `.deb` / `.rpm`) |

**No additional installation is required.** External tools are fetched on first use.

### First launch on macOS

FLUX Hub ships with **ad-hoc code signing** (free — this is an open-source project with
zero recurring costs, so there is no Apple Developer Program account behind it). The
binary is cryptographically signed but with a "null" identity, which Gatekeeper does
not recognise as a trusted publisher.

**On Intel Macs**, double-click `FLUX Hub.app` (open the `.dmg` first). The first time
you may see one of two dialogs:

- *"FLUX Hub cannot be opened because it is from an unidentified developer"* → open
  **System Settings → Privacy & Security**, scroll down, click **"Open Anyway"**
- *"FLUX Hub cannot be opened"* (dead-end dialog with only OK) → open Terminal and run:
  ```bash
  xattr -dr com.apple.quarantine "/Applications/FLUX Hub.app"
  ```
  Then double-click normally.

**On Apple Silicon (M1+) Macs** the ad-hoc signature is honoured directly, but the
quarantine flag still applies — the `xattr` command above is the reliable one-shot fix.

After the first launch, macOS remembers the choice.

> **Note:** in-app auto-update is **disabled on macOS** (an unsigned/un-notarized app
> can't update through Gatekeeper). Mac users update by downloading the new release
> manually. Windows and Linux auto-update normally.

### First launch on Windows

The `.exe` is **unsigned** (a Windows Authenticode certificate costs ~300–500 USD/year
and we keep no recurring costs on an open-source project). SmartScreen shows a *"Windows
protected your PC"* dialog on first launch. Click **"More info" → "Run anyway"**. From
the second launch onwards Windows remembers the choice.

If your IT department blocks all unsigned binaries, building from source is the
supported path — see *For developers* below.

### First launch on Linux

No signing prompts on Linux — pick the package that fits your distro:

- **AppImage** (portable, any distro) — make it executable, then run it:
  ```bash
  chmod +x "FLUX Hub-x.x.x.AppImage"
  ./"FLUX Hub-x.x.x.AppImage"
  ```
  On some distros the AppImage runtime needs **FUSE**. If you see
  *"dlopen(): error loading libfuse.so.2"*, install it (`sudo apt install libfuse2`
  on Debian/Ubuntu) or run once with `./"FLUX Hub-x.x.x.AppImage" --appimage-extract-and-run`.

- **Debian / Ubuntu (`.deb`)**:
  ```bash
  sudo apt install "./FLUX Hub-x.x.x.deb"     # resolves dependencies automatically
  ```

- **Fedora / RHEL / openSUSE (`.rpm`)**:
  ```bash
  sudo dnf install "./FLUX Hub-x.x.x.rpm"     # or: sudo zypper install ./FLUX*.rpm
  ```

Installed via `.deb`/`.rpm`, FLUX Hub appears in your application menu and updates through
your package manager. As with every platform, the external binaries are fetched on first
use into `~/.config/flux-hub/vendor/`.

---

## Modules & features

FLUX Hub is organised as a **modular platform** (single source of truth:
[`modules/registry.json`](./modules/registry.json)). Each module can be toggled on/off
in **Settings → Modules**.

| Module | What it does | Needs (fetched on first use) |
|---|---|---|
| **Core** | Home, Settings, Queue, History, Profiles, Scheduler. Always on — shared lifecycle, persistence, proxy/notifications. | — |
| **Media** | Download video/audio/podcasts/livestreams/radio/RSS/Spotify via yt-dlp. Format presets (MP4/MKV/MP3/FLAC/M4A/Opus, 720p/1080p), batch queue, retry/resume, live progress. | yt-dlp · ffmpeg · ffprobe |
| **Torrent** | Search YTS, Nyaa, TPB + custom sources. Save `.torrent`/`.magnet`, copy magnet links, or send-to-client (qBittorrent / Transmission WebUI). | — |
| **IRC / XDCC** | IRC client with SASL auth, channel browsing, private messages and DCC/XDCC transfers. TLS + SOCKS5 (Tor) for privacy. | — |
| **NZB / Usenet** | Forward `.nzb` files to your SABnzbd or NZBGet server over its HTTP API. | — |
| **Tag editor** | Edit ID3v2 / Vorbis / MP4 tags. Batch edit, album-art import/export, MusicBrainz auto-tagging, LRCLIB lyrics. | — |
| **Music recognition** | Identify a playing song via Shazam (no key) or AcoustID (your key). Microphone or file-based. | fpcalc · ffmpeg · ffprobe |
| **Convert Media** | Local A/V toolbox: trim, convert, extract audio/subtitles, split tracks, normalize loudness, frame export, concat, GIF. Offline. | ffmpeg · ffprobe |
| **Images** | Batch image ops: rename, convert (JPG/PNG/WebP/AVIF/HEIC), resize, watermark, EXIF strip, compress-to-size, dedupe, FX presets + single-image editor (crop, annotate). | — |
| **File & Sync** | Copy/sync folders to a device (USB, drive): incremental / two-way / mirror with a FreeFileSync-style preview. Optional audio→MP3 transcode + M3U playlist for the car. | ffmpeg · ffprobe *(transcode only)* |
| **Video Editor** | Batch ops on a folder of videos — the third editor alongside Tag (audio) and Image editors. Convert, resize, compress, extract audio, batch rename. | ffmpeg · ffprobe |

Other niceties: dark / light / auto theme, 10 UI languages (EN/IT/ES/FR/DE/PT/JA/RU/PL/ZH-CN),
in-app media player, global SOCKS5 proxy, configurable concurrency, scheduler, desktop
notifications.

---

## Modular architecture

- **Toggle modules** in Settings → Modules. Disabled modules hide their tabs.
- **Lazy binaries:** nothing heavy ships in the installer. The first time you open a
  view (or trigger an action) that needs a binary, FLUX Hub shows a dedicated download
  view and fetches exactly what's needed into `userData/vendor` — using Electron's
  `net` stack so it works through corporate proxies / system certificate stores.
- The registry declares, per module: its `tabs` (for visibility), its required
  `binaries`, and a stable `id` (the config key for enabled/disabled state).

---

## Support the project

FLUX Hub is built and maintained by one developer, in the open and for free. Donations
go toward code-signing certificates, maintenance time, and keeping the project
independent and ad-free.

- **Ko-fi** — https://ko-fi.com/fluxhub
- **GitHub Sponsors** — https://github.com/sponsors/flux-hub-app
- **Liberapay** — https://liberapay.com/flux-hub-app
- **PayPal** — https://paypal.me/fluxhubapp

---

## For developers — building from source

### Prerequisites

| All platforms | Node.js 18+ (https://nodejs.org), Git |
|---|---|
| **Windows** | Nothing else — the dispatcher handles the rest |
| **macOS** | Xcode Command Line Tools (`xcode-select --install`); Homebrew only for the `.dmg` target (see *Mac DMG caveat*) |
| **Linux** | `build-essential`, `python3`, plus your distro's AppImage/`.deb`/`.rpm` tooling |

> Behind a corporate proxy with TLS interception, prefix npm installs with
> `NODE_OPTIONS=--use-system-ca` so Node trusts the system certificate store.

### Quick start

```bash
git clone https://github.com/flux-hub-app/flux-hub.git
cd flux-hub
```

Then on each host run the matching dispatcher (**must run natively** — no cross-builds):

| Host | Command | Targets |
|---|---|---|
| Windows | `.\build.ps1` | NSIS installer (`.exe`) + portable (`.exe`), x64 |
| macOS | `chmod +x build.sh && ./build.sh` | `.dmg` + `.zip` (x64 + arm64) |
| Linux | `chmod +x build.sh && ./build.sh` | `.AppImage` + `.deb` + `.rpm`, x64 |

`build.sh` auto-detects macOS vs Linux and routes to the right script in `build/`. Output
lands in `dist/`. For multi-platform releases use GitHub Actions (see *Release process*).

### What the build script does

Each per-platform script (`build/build-{win|mac|linux}.{ps1|sh}`) runs:

1. Kills any running FLUX Hub from `dist/` so files aren't locked
2. Cleans previous platform artefacts from `dist/`
3. Verifies Node.js is present
4. `npm install`
5. Builds the platform icon (`.ico` / `.icns` / `.png`) from `assets/icon.svg`
6. Runs `electron-builder` for the matching target (on Unix, `afterPack` `chmod +x`'s any present binaries)

**Slim installer:** the build does **not** bundle or fetch the external binaries — there
is no `extraResources` vendor block, so the shipped installer carries no binaries (~180 MB
lighter). The installed app downloads each one into `userData/vendor` on first use (see
`binary-fetcher.js`). For local dev (`npm start`), populate `vendor/` with `npm run fetch-all`.

### External binaries — upstream sources

Fetched at runtime by the app (or via `npm run fetch-all` for dev) — **never bundled**:

| Binary | Source | Dev script | License |
|---|---|---|---|
| `yt-dlp` | https://github.com/yt-dlp/yt-dlp | `scripts/fetch-ytdlp.js` | Unlicense |
| `fpcalc` (Chromaprint) | https://github.com/acoustid/chromaprint | `scripts/fetch-chromaprint.js` | LGPL-2.1-or-later |
| `ffmpeg` (Win/Linux) | https://github.com/BtbN/FFmpeg-Builds (GPL) | `scripts/fetch-ffmpeg.js` | GPL-3.0 |
| `ffmpeg` (macOS) | https://evermeet.cx/ffmpeg/ | `scripts/fetch-ffmpeg.js` | GPL |

See [`THIRD-PARTY-LICENSES.md`](./THIRD-PARTY-LICENSES.md) for the full attribution list.

### Development mode (no build)

```bash
npm install
npm run fetch-all     # yt-dlp + ffmpeg + fpcalc into vendor/
npm start
```

`npm start` launches the app from source — no electron-builder step, fastest iteration loop.

### Troubleshooting

**Mac DMG caveat:** `dmgbuild` (electron-builder's DMG packer) needs `libintl.8.dylib`
from Homebrew's `gettext`. On `Library not loaded: .../libintl.8.dylib`:
```bash
brew install gettext && brew link --force gettext
```
The bundled `dmgbuild` may also target a newer macOS than your host. Workarounds: build on
a current macOS, build only `.zip` (remove `dmg` from `package.json → build.mac.target`),
or let GitHub Actions build the DMG on its `macos-latest` runner.

**Cross-builds are not supported** locally — each per-target script refuses to run on the
wrong OS. Use GitHub Actions for multi-platform output.

---

## Architecture & tech stack

Philosophy: **"boring tech"** — the simplest obvious tool for the job, optimised for
onboarding and longevity over apparent modernity.

### Process model (standard Electron)

```
┌─────────────────────────────────────────────────────────────┐
│  main.js              Node runtime, full privileges          │
│  • ~120 IPC handlers   • Spawns ffmpeg / fpcalc / yt-dlp     │
│  • Filesystem + network • Lifecycle + (Win/Linux) updater    │
└─────────────────────────────────────────────────────────────┘
                            ▲  ipcMain.handle / on
┌─────────────────────────────────────────────────────────────┐
│  preload.js           Bridge — contextBridge.exposeInMainWorld│
│  • Whitelisted API surface only — no privilege leak          │
│  • Renderer calls window.api.<namespace>.<method>(...)       │
└─────────────────────────────────────────────────────────────┘
                            ▲
┌─────────────────────────────────────────────────────────────┐
│  renderer/            Browser context — sandboxed            │
│  • contextIsolation: true, nodeIntegration: false            │
│  • Vanilla JS, no framework, no bundler                      │
└─────────────────────────────────────────────────────────────┘
```

Every cross-process call goes through `preload.js`. Renderer code never touches Node
APIs directly — the Electron security baseline.

### Stack choices, briefly

| Layer | Tool | Why |
|---|---|---|
| **Desktop runtime** | Electron | Heavy use of Chromium features: `printToPDF`, `capturePage`, `desktopCapturer`, `MediaRecorder`, `<video>` + HLS |
| **UI** | Vanilla HTML/CSS/JS | Imperative state (file lists, queue, modals). No framework, no build step |
| **CSS** | Plain CSS + custom properties | CSS variables drive dark/light/auto theming. Easy to fork visually |
| **Bundler / types** | None | `<script src>` from `index.html`; JS + JSDoc. Edit, refresh, done |
| **Media pipeline** | `ffmpeg` *(fetched)* | Industry standard A/V coverage |
| **Image processing** | `sharp` (libvips) | 10–100× faster than pure-JS on batch ops |
| **Audio fingerprint** | `chromaprint` / `fpcalc` *(fetched)* | What MusicBrainz/AcoustID expect |
| **Music recognition** | `node-shazam` + AcoustID | Shazam (no key) default; AcoustID with user key opt-in |
| **Waveform editor** | WaveSurfer.js v7 + Regions | Trim/fade via the regions plugin |
| **HLS streaming** | `hls.js` (vendored) | Cross-platform HLS playback |
| **PDF rasterise** | `pdfjs-dist` (Mozilla) | Same library Firefox uses |
| **Canvas editor** | `fabric.js` (vendored) | Image annotate / redact |
| **Downloader** | `yt-dlp` *(fetched)* | The reference URL downloader |
| **Persistence** | Plain JSON files | Tiny data scale; inspectable, backuppable, no SQLite native binding |
| **i18n** | Flat JSON per language | One file per locale in `renderer/languages/` |
| **Icons** | Lucide (full set vendored) | `renderer/vendor/lucide.min.js`; used via `data-lucide-icon="kebab-name"` |

### What's deliberately NOT here

- **No cloud / account / telemetry** — offline-first; all external APIs are called directly from the user's machine
- **No database** — JSON is enough
- **No CSS-in-JS / design-system framework** — a handful of utility classes cover most cases
- **No heavy test framework** — UI-level testing fits this scale better

### Where to look for what

| You want to change… | Start in… |
|---|---|
| A download source / search backend | `main.js` → `ipcMain.handle('torrent:…')` |
| A new IPC method | `main.js` (handler) → `preload.js` (expose) → `renderer.js` (call) |
| A new tab / section | `renderer/index.html` → `renderer/styles.css` → `renderer.js` |
| A new module | `modules/registry.json` first (the contract), then wire its tab/handlers |
| A translation | Copy `renderer/languages/en.json` → translate → add lang to the loader |
| An icon | Use `data-lucide-icon="name"` (any of the full Lucide set) |
| The splash | `renderer/splash.html` (self-contained, no preload) |
| Build / packaging | `package.json → build` (electron-builder) |

### Coding conventions

- **One big `renderer.js`** is intentional — sections marked with banner comments (`// ─── SECTION ───`)
- **IPC payloads** are JSON-serialisable `{ ok: boolean, … | error: string }`
- **i18n keys** are flat `snake_case`, grouped by tab; English is the source of truth
- **Logs**: `appendLog('<id>-log', text, type)` per tab; `showToast({…})` for global feedback; `log('LEVEL', msg)` in `main.js` → `flux.log`

---

## Profiles & `.flux` files

Settings can be saved as **named profiles** and exported to a `.flux` file (JSON under a
custom extension). Two export modes:

- **Export (shareable)** — strips credentials (qBittorrent/SABnzbd/IRC-SASL/SOCKS
  passwords, API keys, server tokens), local paths, sync profiles and playlists. Safe to
  share publicly.
- **Export all (backup)** — the complete configuration, for a personal backup or moving
  FLUX Hub to another computer. The app shows a warning before exporting: **keep this
  file private, do not share it.**

---

## Project structure

```
flux-hub/
├── main.js                  # Backend: ~120 IPC handlers, ffmpeg/fpcalc/yt-dlp orchestration,
│                            #   RSS, scheduler, history, fileops, (Win/Linux) updater, lifecycle
├── preload.js               # Whitelisted bridge — window.api.<namespace>.<method>
├── binary-fetcher.js        # Runtime first-use binary downloader (Electron net)
├── package.json             # Electron + electron-builder config (slim — no bundled binaries)
├── build.ps1 / build.sh     # Single-command build dispatchers (route to build/)
├── build/                   # Per-platform build scripts (win.ps1 / mac.sh / linux.sh)
├── scripts/                 # Dev helpers: fetch-ytdlp / fetch-ffmpeg / fetch-chromaprint, build-icons
├── shims/                   # ffmpeg-installer shim (lazy vendor path)
├── modules/                 # registry.json (module contract) + per-module placeholders
├── vendor/                  # Dev-only local binaries; NOT shipped (app fetches to userData/vendor)
├── renderer/
│   ├── index.html           # Single-page UI (all tabs)
│   ├── splash.html          # Standalone splash window (self-contained)
│   ├── styles.css           # Theme via CSS custom properties (dark / light / auto)
│   ├── renderer.js          # Full UI logic — sections marked with banners
│   ├── legal-content.js     # Authoritative T&C + Privacy (window.TOS_DOC, IT + EN)
│   ├── i18n.js              # Language loader + buildTOSHtml()
│   ├── languages/           # One JSON per locale (10 languages)
│   └── vendor/              # Vendored front-end libs (no CDN): hls, wavesurfer, pdfjs, fabric, lucide
├── documents/               # FLUX_Terms_of_Use.html (printable T&C / Privacy)
├── assets/                  # Icons (generated from icon.svg) + splash audio
├── .github/workflows/       # build-release.yml (multi-platform CI)
├── LICENSE                  # GPL-3.0
└── THIRD-PARTY-LICENSES.md  # Attributions for bundled libs + fetched binaries + assets
```

---

## Release process

Releases are produced by **GitHub Actions** (`.github/workflows/build-release.yml`) — no
local cross-compile. Each target builds on its native OS runner.

| Runner | Outputs |
|---|---|
| `macos-latest` | `FLUX Hub-x.x.x-arm64.dmg` + `-x64.dmg` (+ matching `.zip`) — ad-hoc signed |
| `windows-latest` | `FLUX Hub Setup x.x.x.exe` (NSIS) + `FLUX Hub x.x.x.exe` (portable) |
| `ubuntu-latest` | `FLUX Hub-x.x.x.AppImage`, `.deb`, `.rpm` |

**Triggers**

- **Push of a `v*` tag** → all platforms build in parallel, then a **draft** GitHub
  Release is created with the installers attached. Nothing reaches users until you publish
  the draft manually.
- **Manual dispatch** (Actions → "Build & Release" → "Run workflow") → builds uploaded as
  workflow artifacts only, no Release. Used to smoke-test the pipeline.

**Cutting a release**

```bash
npm version 1.0.1 --no-git-tag-version
git commit -am "chore: bump v1.0.1"
git tag v1.0.1
git push && git push --tags
# wait for the three jobs to go green, review the draft Release, click Publish
```

**Repo settings prerequisites** (one-time): Settings → Actions → General → Workflow
permissions → **Read and write** (so the workflow can create the Release). The
`build.publish` block in `package.json` is set to `flux-hub-app/flux-hub` for
`electron-updater`.

---

## Auto-update

`electron-updater` (optional dependency) checks GitHub Releases on startup and offers an
in-app upgrade banner when a new version is published. The release workflow produces the
matching `latest.yml` / `latest-mac.yml` / `latest-linux.yml` metadata it reads.

- **Windows / Linux:** auto-update works (AppImage updates; `.deb`/`.rpm` use the package manager).
- **macOS:** auto-update is **disabled** — an unsigned/un-notarized app can't update through
  Gatekeeper. Mac users download new releases manually.

---

## Legal & licensing

On first launch FLUX Hub shows the **Terms of Use and Privacy Policy**, which must be
explicitly accepted (lawyer-drafted; Italian binding + English courtesy; with an
art. 1341 c.c. second-acceptance step for the specific clauses). The software is for
**legal use only** — the user is solely responsible for the content they choose to
download. The authoritative text lives in the app at `renderer/legal-content.js`
(`window.TOS_DOC`).

- © 2026 **Enrico Tommasini** and FLUX contributors.
- Licensed **GPL-3.0-or-later** (version 3, or — at your option — any later version) —
  full text in [`LICENSE`](./LICENSE).
- Third-party components (bundled libraries, runtime-fetched binaries, media assets) and
  their licenses: [`THIRD-PARTY-LICENSES.md`](./THIRD-PARTY-LICENSES.md).
- The complete corresponding source code is available at this repository.

### Credits

- **Digitale Smart** (https://digitalesmart.it) & **TID** (https://tid.swiss) — technology stack
- **Iwona Ciardullo Kos** — legal expertise
- Splash sound effect by **Mauricio Póvoa** (Pixabay)

---

## Configuration files

`%APPDATA%\flux-hub\` (Windows) · `~/Library/Application Support/flux-hub/` (macOS) ·
`~/.config/flux-hub/` (Linux)

| File | Purpose |
|---|---|
| `config.json` | User settings, sources, RSS feeds, sync profiles, profile name |
| `profiles.json` | Saved named profiles |
| `queue.json` | Persisted download queue (resumes across restarts) |
| `history.json` | Download history (latest 500 entries) |
| `schedule.json` | Auto-download window + RSS poll interval |
| `vendor/` | Binaries fetched at first use (yt-dlp, ffmpeg, ffprobe, fpcalc) |
| `flux.log` | Application log |
