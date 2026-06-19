#!/usr/bin/env bash
# ============================================================
# build-mac.sh — FLUX build script (macOS: DMG + ZIP, x64 + arm64)
# Mirrors build.ps1 step-for-step. Run from project root on macOS.
# ============================================================
set -euo pipefail

# ── ANSI colours (no-op when stdout isn't a TTY) ─────────────────────
if [ -t 1 ]; then
    CYAN='\033[36m'; YELLOW='\033[33m'; GREEN='\033[32m'
    DARKGREEN='\033[2;32m'; DARKGRAY='\033[90m'; RED='\033[31m'; NC='\033[0m'
else
    CYAN=''; YELLOW=''; GREEN=''; DARKGREEN=''; DARKGRAY=''; RED=''; NC=''
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Scripts now live in <repo>/build/, project root is one level up.
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"
cd "$PROJECT_ROOT"

# Refuse to run on non-macOS — .icns generation and codesigning need Darwin.
if [ "$(uname -s)" != "Darwin" ]; then
    echo -e "${RED}ERROR: build-mac.sh must run on macOS.${NC}"
    echo -e "${RED}       (uname reports: $(uname -s))${NC}"
    exit 1
fi

echo
echo -e "${CYAN}============================================================${NC}"
echo -e "${CYAN}  FLUX -- Fetch, Load, Use & eXtract  |  macOS Build${NC}"
echo -e "${CYAN}============================================================${NC}"
echo

# ── [1/7] Kill any running FLUX processes from dist/ ────────────────
echo -e "${YELLOW}[1/6] Closing running FLUX instances...${NC}"
killed=0
# macOS: prefer pgrep -lf (matches the full command line, so /dist/mac/FLUX.app
# instances are caught even when the binary is just "FLUX").
if pgrep -f "$DIST_DIR" >/dev/null 2>&1; then
    pgrep -lf "$DIST_DIR" | while read -r pid rest; do
        echo -e "      ${DARKGRAY}Stopping pid $pid: $rest${NC}"
    done
    pkill -9 -f "$DIST_DIR" 2>/dev/null || true
    killed=1
fi
for name in "FLUX Hub" "FLUX hub" flux-hub FLUX flux flux-downloader; do
    if pgrep -x "$name" >/dev/null 2>&1; then
        echo -e "      ${DARKGRAY}Stopping process: $name${NC}"
        pkill -9 -x "$name" 2>/dev/null || true
        killed=1
    fi
done
if [ "$killed" -eq 1 ]; then
    sleep 2
    echo -e "      ${GREEN}Done.${NC}"
else
    echo -e "      ${DARKGRAY}No running instances found.${NC}"
fi

# ── [2/7] Clean dist/tmp + previous macOS artefacts ─────────────────
# Wipes the intermediate work dir AND any previous macOS finals so the
# user opens dist/ after the build and sees only the freshly-built files.
# Artefacts from other platforms (.exe/.AppImage/.deb/.rpm) are preserved.
echo -e "${YELLOW}[2/6] Cleaning dist/tmp + previous macOS artefacts...${NC}"
mkdir -p "$DIST_DIR"
rm -rf "$DIST_DIR/tmp" 2>/dev/null || true
shopt -s nullglob 2>/dev/null
for f in "$DIST_DIR"/*.dmg "$DIST_DIR"/*.pkg "$DIST_DIR"/*-mac*.zip "$DIST_DIR"/*-darwin*.zip; do
    [ -f "$f" ] && { echo -e "      ${DARKGRAY}Removing: $(basename "$f")${NC}"; rm -f "$f"; }
done
shopt -u nullglob 2>/dev/null
echo -e "      ${GREEN}Cleaned.${NC}"

# ── [3/7] Check Node.js ─────────────────────────────────────────────
echo -e "${YELLOW}[3/6] Checking Node.js...${NC}"
if ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}ERROR: Node.js not found. https://nodejs.org${NC}"; exit 1
fi
echo -e "      ${GREEN}Node.js $(node --version)${NC}"

# ── [4/7] Install dependencies ──────────────────────────────────────
echo -e "${YELLOW}[4/6] Installing dependencies...${NC}"
npm install --silent
echo -e "      ${GREEN}Done.${NC}"

# ── [5/7] Build native macOS icon (.icns) from icon.svg ─────────────
# scripts/build-icons.js skips .icns on non-Darwin, so run it explicitly here
# even if PNG/ICO were already generated on Windows.
echo -e "${YELLOW}[5/6] Building macOS icon (.icns)...${NC}"
if [ ! -f "$PROJECT_ROOT/assets/icon.svg" ]; then
    echo -e "${RED}ERROR: assets/icon.svg missing.${NC}"; exit 1
fi
node scripts/build-icons.js
if [ ! -f "$PROJECT_ROOT/assets/icon.icns" ]; then
    echo -e "${RED}ERROR: assets/icon.icns not produced (iconutil failed?).${NC}"; exit 1
fi
echo -e "      ${GREEN}assets/icon.icns OK${NC}"

# ── [6/6] Build ─────────────────────────────────────────────────────
# Phase 2b (slim installer): binaries (yt-dlp / ffmpeg / ffprobe / fpcalc) are
# NO LONGER bundled or fetched at build time. FLUX downloads each one into
# ~/Library/Application Support/flux-hub/vendor the first time the user opens a
# module that needs it (see binary-fetcher.js, which uses Electron net so the
# fetch works behind corporate TLS proxies). For DEV runs use `npm run fetch-all`.
#
# Builds both Intel (x64) and Apple Silicon (arm64) by default, per the
# `mac.target` config in package.json.
echo -e "${YELLOW}[6/6] Building FLUX (electron-builder --mac)...${NC}"
npx electron-builder --mac

# Post-build verification: at least one .app bundle must have been produced.
# (We no longer check for a bundled yt-dlp — binaries are fetched at first run.)
APP_DIRS=(
    "$DIST_DIR/mac/FLUX Hub.app"
    "$DIST_DIR/mac-arm64/FLUX Hub.app"
    "$DIST_DIR/mac-universal/FLUX Hub.app"
)
verified=0
for app in "${APP_DIRS[@]}"; do
    [ -d "$app" ] || continue
    verified=1
    echo -e "      ${GREEN}.app produced: $(basename "$(dirname "$app")")/$(basename "$app")${NC}"
done
if [ "$verified" -eq 0 ]; then
    echo -e "${RED}ERROR: No .app bundle found under dist/. Build did not produce expected output.${NC}"
    exit 1
fi

echo
echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN}  BUILD COMPLETE${NC}"
echo -e "${GREEN}============================================================${NC}"
echo
echo -e "  ${CYAN}DMG (x64)    : $DIST_DIR/FLUX Hub-*-x64.dmg${NC}"
echo -e "  ${CYAN}DMG (arm64)  : $DIST_DIR/FLUX Hub-*-arm64.dmg${NC}"
echo -e "  ${CYAN}ZIP (x64)    : $DIST_DIR/FLUX Hub-*-x64.zip${NC}"
echo -e "  ${CYAN}ZIP (arm64)  : $DIST_DIR/FLUX Hub-*-arm64.zip${NC}"
echo
echo -e "  ${DARKGRAY}Note: builds are NOT codesigned. macOS Gatekeeper will warn on first${NC}"
echo -e "  ${DARKGRAY}      launch. Right-click → Open → Open to bypass. For App-Store-grade${NC}"
echo -e "  ${DARKGRAY}      signing, set CSC_LINK + CSC_KEY_PASSWORD before running.${NC}"
echo
