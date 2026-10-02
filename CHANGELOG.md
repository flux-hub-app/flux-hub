# Changelog

## v1.0.3

### Run FLUX as a headless server (Docker / NAS)
- FLUX now runs two ways from the same app: the familiar desktop app, or a **headless server** (e.g. via Docker on a NAS/TrueNAS box) reachable from any browser on your network — same interface, same features.
- Docker image + `docker-compose` setup for a one-command deploy.
- Every module works the same in both modes — download, torrent search, streaming, Xtract Audio/Video/Image editing, AI subtitles, and more — except a handful that genuinely need the desktop (screen capture, native file manager, auto-update), which now show a clear "desktop app only" badge instead of a broken control.
- Local files (previews, Playlist, Xtract) stream correctly to the browser over the network, with full seeking/scrubbing support even on multi-GB files.
- Server file picker gets a Home/Back/Forward/Up navigation bar with clickable breadcrumbs.

### Fixed — Xtract Audio/Video reliability
- **Any video over 1 hour failed to trim or convert.** A timestamp formatting bug dropped the hour component entirely — fixed for any length.
- **Large files (1GB+) could end up silent, or fail to play back at all.** Waveform generation is now safely skipped for very large files (with manual time-entry fields as a fallback), and the play button is correctly wired up in that path.
- **Silent secondary audio tracks** (common AC-3 tracks in movie rips that Chromium can't decode) are now detected proactively and transparently fixed via the same automatic remux already used for unplayable videos, with a Cancel button.
- **Converting to WebM could fail** when the source video/audio codec isn't compatible with the WebM container — codecs are now checked upfront instead of failing mid-conversion.
- **Save stayed disabled** for a format-only conversion (no trim, no edits) in both Xtract Video and the Image editor.
- **Saving to a folder on a different drive than your temp folder** (common on Windows) now works instead of failing silently.
- ffmpeg error messages are no longer cut off mid-word, so the actual failure reason stays readable.

### Changed
- Activity log panel redesigned: no longer wedged between other cards, moved into normal page flow with a clear title.
- Subscriptions (Torrent tab) redesigned as cards in a 3-column grid.
- Redesigned close button on the Downloads modal.

---

## v1.0.2

### Mobile companion
- **Control FLUX from your phone**: pair a phone via a Telegram bot (6-digit pairing code) or a local LAN web page (QR/PIN) — no extra infrastructure needed for the Telegram route.
- Send a URL to download it, a title to search torrents, "trailer `<title>`" to find a trailer, a magnet link to start it immediately, or a Shazam link to resolve the recognized song. Results picked from your phone go straight to your torrent client when that integration is enabled.
- Explicit slash commands on Telegram (`/download`, `/torrent`, `/trailer`, `/login`, `/help`) alongside the existing free-text dispatcher.
- Every mobile action shows up in the regular desktop History, tagged "Telegram" or "LAN".
- **"Open with" FLUX** from Explorer/Finder: set FLUX as the default app for supported formats — opening a file from your file manager loads it straight in (reuses the already-open window instead of launching a second one).

### Xtract Audio/Video — rebuilt as one non-destructive editor
- Trim, Concat/Merge, replace audio track, and Normalize now all live on the same persistent canvas with real live preview — no more running tools one at a time. A single **Save** applies everything in a fixed order (concat → trim → audio track → normalize).
- The "one-shot" tools (split into tracks, extract metadata, extract audio/subtitles/frame) stay separate and untouched by the pipeline, grouped into their own "Tools" card since they write their own output instead of changing the loaded file.
- Fixed waveform redraw glitches and a normalization bug that could compound across edits instead of applying once.

### Image editor — rebuilt as a "mini Photoshop"
- Crop, color effects, color replace, background removal, resize, annotate, and compare — all in one window with a **live composite preview** of the whole edit stack.
- Fully non-destructive: per-tool and global Reset, a single Save with a folder/filename/format picker.
- Color picker (eyedropper) samples directly from the live composite.
- Compare tool with a draggable divider; drag & drop images in from the browser or other apps.

### Related media & streaming playlists
- After a successful probe, a "Related to your media" panel surfaces related content (YouTube, SoundCloud, or a generic search fallback) — click a card to jump to it.
- Streaming playlists now live inside the Media tab: paste a track/album/playlist link to get a track list with per-track or bulk download.
- Redesigned two-row format toolbar (resolution/codec pills for video, bitrate pills for audio) with inline preview.

### Also in this release
- yt-dlp now works behind TLS-intercepting corporate proxies/antivirus (was a hard certificate failure before).
- External platform names removed from in-app hints/placeholders/toasts across all 10 languages.
- Wide QA pass and polish; macOS build (Intel + Apple Silicon) validated on real hardware.

---

## v1.0.1

### Torrent sources — extensible & resilient
- **Add any tracker from the UI.** New source types beyond the built-ins: **Torznab** (Jackett / Prowlarr), **JSON API**, and **RSS**. A single Torznab source pointed at your Jackett/Prowlarr instance unlocks every indexer you configured there — hundreds of trackers, without shipping fragile scrapers inside FLUX.
- **Zero-config Torznab.** FLUX auto-detects a local Jackett/Prowlarr, fills in the URL and API key for you, and shows a guided download (to the official Jackett GitHub page) when none is running. An indexer picker lets you target a single tracker.
- **Live per-indexer progress.** When searching "all indexers", each tracker gets its own chip that turns green with a hit count as it returns, or grey when it finds nothing (grey ones fold into a collapsible list). No more a single chip spinning forever.
- **Resilient search.** A failing or slow tracker (Cloudflare challenge, timeout…) no longer blocks the others — each indexer is queried independently, with clear, readable error messages.
- **Click-to-filter.** Click an indexer chip to filter the results table down to that tracker.

### YTS fixed
- YTS changed domains (yts.mx went dark). FLUX now points at the current domain and **automatically fails over across mirrors** when one is down. The mirror list is editable per source.

### Results table
- **Sortable columns** — sort by name, seeds, leeches, size, or source (click a header, click again to reverse).
- **Dynamic name column** — long torrent names now grow as you widen the window instead of a fixed cut.

### Source management
- Redesigned, compact source cards with a green/red status dot and type / max-results badges.
- **Edit** any source in a popup — including per-source mirror URLs and max results — and **delete** even the built-in sources.

### Also in this release
- Wide QA pass and polish across the app: toasts, live & streaming, radio mirror failover, File & Sync, RSS, the download queue, and image background removal by color.
- Network requests routed through Electron's `net` stack, so search and metadata work behind TLS-intercepting corporate proxies.

---

## v1.0.0

Initial public release — an open-source media manager built on yt-dlp and ffmpeg: media download, torrent search, live & radio streaming, IRC, NZB, audio/image tools, and a modular architecture with lazy first-use binary fetching.
