# FLUX headless server (Fase E, 2026-08-23) — runs server.js, the "server
# profile" (queue/download, torrent search, RSS + auto-download,
# sottoscrizioni, scheduler, storico, impostazioni) exposed over REST + SSE.
# No Electron anywhere in this image — server.js never requires main.js or
# preload.js, and node:22-bookworm-slim has no Electron/Chromium in it.
#
# yt-dlp/ffmpeg/ffprobe/chromaprint are NOT baked into the image — same
# lazy-fetch-on-first-use as desktop (engine/binaries.js + binary-fetcher.js),
# landing in FLUX_DATA_DIR/vendor on the /data volume, so they survive a
# container recreate and don't bloat the image.
FROM node:22-bookworm-slim

# unzip/xz-utils: node:*-slim doesn't ship them, but binary-fetcher.js needs
# both to extract lazy-fetched binaries — ffmpeg/ffprobe on Linux arrive as
# .tar.xz (tar -xJf needs the `xz` binary), some archives are .zip (needs
# `unzip`). Without this, ffmpeg fetch silently fails ("fallito" in the UI)
# because tar can't find xz on a fresh container.
RUN apt-get update && apt-get install -y --no-install-recommends unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only production deps — devDependencies (electron, electron-builder, the
# icon-build tools) are desktop-build-only and never touched by server.js.
# No package-lock.json in the repo yet, hence `npm install` not `npm ci`.
COPY package.json ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund && npm cache clean --force

# App code — only what server.js's require graph (+ the static web UI it
# serves) actually reaches. main.js/preload.js/shims for the desktop build
# are deliberately NOT copied; this image never runs Electron. assets/ is
# needed too — index.html's logos reference it as `../assets/...`, which
# server.js serves from this same root sibling to renderer/ (see server.js's
# ASSETS_DIR) — only 650K, not worth trimming to the two SVGs actually used.
COPY server.js binary-fetcher.js ./
COPY engine ./engine
COPY renderer ./renderer
COPY modules ./modules
COPY assets ./assets

ENV NODE_ENV=production
ENV FLUX_DATA_DIR=/data
ENV FLUX_DOWNLOAD_DIR=/downloads
ENV FLUX_PORT=8080
# FLUX_ADMIN_PASSWORD has no default on purpose — server.js refuses to start
# without one (see server.js's own startup check). Set it via `docker run -e`
# / compose `environment:` / a Docker secret, never bake it into the image.

VOLUME ["/data", "/downloads"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FLUX_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
