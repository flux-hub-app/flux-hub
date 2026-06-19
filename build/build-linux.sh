#!/usr/bin/env bash
# ============================================================
# build-linux.sh — FLUX build script (Linux: AppImage + .deb + .rpm)
# Mirrors build.ps1 step-for-step. Run from project root.
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

echo
echo -e "${CYAN}============================================================${NC}"
echo -e "${CYAN}  FLUX -- Fetch, Load, Use & eXtract  |  Linux Build${NC}"
echo -e "${CYAN}============================================================${NC}"
echo

# ── [1/6] Kill any running FLUX processes from dist/ ────────────────
echo -e "${YELLOW}[1/5] Closing running FLUX instances...${NC}"
killed=0
# Match processes whose executable resolves under the dist/ tree. pgrep is
# unavailable on minimal containers, so fall back to ps + grep.
pids="$(ps -eo pid,comm,args | awk -v d="$DIST_DIR" '$0 ~ d && $0 !~ /awk/ {print $1}' || true)"
for pid in $pids; do
    exe="$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)"
    case "$exe" in
        "$DIST_DIR"/*)
            echo -e "      ${DARKGRAY}Stopping pid $pid ($exe)${NC}"
            kill -9 "$pid" 2>/dev/null || true
            killed=1
            ;;
    esac
done
# Also catch any plain "FLUX" / "flux" by name (AppImage runtime renames).
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

# ── [2/6] Clean dist/tmp + previous Linux artefacts ─────────────────
# Wipes the intermediate work dir AND any previous Linux finals so the
# user opens dist/ after the build and sees only the freshly-built files.
# Artefacts from other platforms (.exe/.dmg/.zip) are preserved.
echo -e "${YELLOW}[2/5] Cleaning dist/tmp + previous Linux artefacts...${NC}"
mkdir -p "$DIST_DIR"
rm -rf "$DIST_DIR/tmp" 2>/dev/null || true
shopt -s nullglob 2>/dev/null
for f in "$DIST_DIR"/*.AppImage "$DIST_DIR"/*.deb "$DIST_DIR"/*.rpm "$DIST_DIR"/*.tar.gz "$DIST_DIR"/*.tar.xz "$DIST_DIR"/*.snap "$DIST_DIR"/*.pacman; do
    [ -f "$f" ] && { echo -e "      ${DARKGRAY}Removing: $(basename "$f")${NC}"; rm -f "$f"; }
done
shopt -u nullglob 2>/dev/null
echo -e "      ${GREEN}Cleaned.${NC}"

# ── [3/6] Check Node.js ─────────────────────────────────────────────
echo -e "${YELLOW}[3/5] Checking Node.js...${NC}"
if ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}ERROR: Node.js not found. https://nodejs.org${NC}"; exit 1
fi
echo -e "      ${GREEN}Node.js $(node --version)${NC}"

# ── [4/6] Install dependencies ──────────────────────────────────────
echo -e "${YELLOW}[4/5] Installing dependencies...${NC}"
npm install --silent
echo -e "      ${GREEN}Done.${NC}"

# ── [5/5] Build ─────────────────────────────────────────────────────
# Phase 2b (slim installer): binaries (yt-dlp / ffmpeg / ffprobe / fpcalc) are
# NO LONGER bundled or fetched at build time. FLUX downloads each one into
# ~/.config/flux-hub/vendor the first time the user opens a module that needs it
# (see binary-fetcher.js, which uses Electron net so the fetch works behind
# corporate TLS proxies). For DEV runs use `npm run fetch-all`.
echo -e "${YELLOW}[5/5] Building FLUX (electron-builder --linux)...${NC}"
npx electron-builder --linux

# Post-build verification: confirm an artefact was produced. (We no longer
# check for a bundled yt-dlp — binaries are fetched at first run.)
shopt -s nullglob 2>/dev/null
artefacts=("$DIST_DIR"/*.AppImage "$DIST_DIR"/*.deb "$DIST_DIR"/*.rpm)
shopt -u nullglob 2>/dev/null
if [ "${#artefacts[@]}" -eq 0 ]; then
    echo -e "${RED}ERROR: No .AppImage/.deb/.rpm produced under dist/. Build failed.${NC}"
    exit 1
fi
for a in "${artefacts[@]}"; do
    echo -e "      ${GREEN}produced: $(basename "$a")${NC}"
done

echo
echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN}  BUILD COMPLETE${NC}"
echo -e "${GREEN}============================================================${NC}"
echo
echo -e "  ${CYAN}AppImage : $DIST_DIR/FLUX*hub-*.AppImage${NC}"
echo -e "  ${CYAN}Debian   : $DIST_DIR/flux-hub_*_amd64.deb${NC}"
echo -e "  ${CYAN}RPM      : $DIST_DIR/flux-hub-*.x86_64.rpm${NC}"
echo
