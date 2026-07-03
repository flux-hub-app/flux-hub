# Changelog

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
