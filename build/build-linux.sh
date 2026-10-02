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

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    echo
    echo -e "${CYAN}FLUX -- build & launch helper (Linux)${NC}"
    echo
    echo -e "  ${DARKGRAY}./build.sh              Build natively for this OS${NC}"
    echo -e "  ${DARKGRAY}./build.sh -h|--help    Show this help${NC}"
    echo
    echo -e "  ${CYAN}Dev mode (no build, fastest iteration):${NC}"
    echo "    npm install"
    echo -e "    npm run fetch-all      ${DARKGRAY}yt-dlp + ffmpeg + fpcalc into vendor/ (first time only)${NC}"
    echo "    npm start"
    echo
    echo -e "  ${DARKGRAY}Output : dist/*.AppImage + .deb + .rpm${NC}"
    echo -e "  ${DARKGRAY}Log    : build/build-linux.log${NC}"
    echo -e "  ${DARKGRAY}Details: build/README.md${NC}"
    echo
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Scripts now live in <repo>/build/, project root is one level up.
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"
cd "$PROJECT_ROOT"

# Mirror everything to build/build-linux.log (ANSI colour codes stripped for
# readability in a plain editor) while the terminal still gets the live
# coloured output. Lives next to the script, not in the project root.
LOG_FILE="$SCRIPT_DIR/build-linux.log"
exec > >(tee >(sed -u 's/\x1b\[[0-9;]*m//g' > "$LOG_FILE")) 2>&1

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

# ── AppImage update info + zsync ────────────────────────────────────
# electron-builder's own AppImage target has no support for the classic
# AppImageUpdate/zsync mechanism (it only writes app-update.yml for its own
# electron-updater flow, already wired in main.js) — the AppImage catalog
# (appimage.github.io) flags that as a warning on auto-discovered releases.
# Best-effort post-processing with the real appimagetool: re-embeds update
# info into the AppImage electron-builder just built, and produces the
# matching .zsync file if zsyncmake is available. Every failure mode here
# is non-fatal and leaves the already-working AppImage untouched — same
# principle as the .deb/xz lesson: an optional step must never wreck a good
# artifact or abort the whole build.
shopt -s nullglob 2>/dev/null
appimage_matches=("$DIST_DIR"/*.AppImage)
shopt -u nullglob 2>/dev/null
if [ "${#appimage_matches[@]}" -gt 0 ] && ! command -v file >/dev/null 2>&1; then
    echo -e "${YELLOW}Embedding AppImage update info...${NC}"
    echo -e "      ${DARKGRAY}'file' command not found — appimagetool requires it and cannot run without it.${NC}"
    echo -e "      ${DARKGRAY}Skipping (non-fatal, original AppImage kept as-is). Install it to enable this step:${NC}"
    echo -e "      ${DARKGRAY}  Debian/Ubuntu: sudo apt install file   |   Fedora: sudo dnf install file   |   Arch: sudo pacman -S file${NC}"
elif [ "${#appimage_matches[@]}" -gt 0 ]; then
    appimage_file="${appimage_matches[0]}"
    echo -e "${YELLOW}Embedding AppImage update info...${NC}"
    APPIMAGETOOL_DIR="$SCRIPT_DIR/.tools"
    APPIMAGETOOL="$APPIMAGETOOL_DIR/appimagetool-x86_64.AppImage"
    mkdir -p "$APPIMAGETOOL_DIR"
    if [ ! -x "$APPIMAGETOOL" ]; then
        echo -e "      ${DARKGRAY}Fetching appimagetool (build-time only, cached in build/.tools/)...${NC}"
        if ! curl -fsSL -o "$APPIMAGETOOL" "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"; then
            rm -f "$APPIMAGETOOL"
            echo -e "      ${DARKGRAY}Could not download appimagetool (offline?) — skipping, original AppImage kept as-is.${NC}"
        fi
        if [ -f "$APPIMAGETOOL" ]; then
            chmod +x "$APPIMAGETOOL"
        fi
    fi
    if [ -x "$APPIMAGETOOL" ]; then
        work="$(mktemp -d)"
        # --appimage-extract-and-run is appimagetool's OWN no-FUSE fallback
        # (needed to run appimagetool itself in containers without /dev/fuse);
        # --appimage-extract on the FLUX AppImage is the separate, unrelated
        # no-FUSE extraction of ITS contents into ./squashfs-root — that
        # becomes the AppDir appimagetool repackages from.
        (cd "$work" && "$appimage_file" --appimage-extract >/dev/null 2>&1) || true
        if [ -d "$work/squashfs-root" ]; then
            UPDATE_INFO="gh-releases-zsync|flux-hub-app|flux-hub|latest|FLUX*Hub-*.AppImage.zsync"
            new_appimage="$work/repackaged.AppImage"
            if ARCH=x86_64 "$APPIMAGETOOL" --appimage-extract-and-run -u "$UPDATE_INFO" \
                "$work/squashfs-root" "$new_appimage" >"$work/appimagetool.log" 2>&1 \
                && [ -s "$new_appimage" ]; then
                chmod +x "$new_appimage"
                mv -f "$new_appimage" "$appimage_file"
                echo -e "      ${GREEN}Update info embedded.${NC}"
                if [ -f "$work/repackaged.AppImage.zsync" ]; then
                    mv -f "$work/repackaged.AppImage.zsync" "$appimage_file.zsync"
                    echo -e "      ${GREEN}$(basename "$appimage_file.zsync") generated.${NC}"
                else
                    echo -e "      ${DARKGRAY}zsyncmake not found (apt package: zsync) — .zsync not generated, update info was still embedded.${NC}"
                fi
            else
                echo -e "      ${DARKGRAY}appimagetool repackaging failed — original AppImage from electron-builder left untouched. Log:${NC}"
                sed 's/^/      /' "$work/appimagetool.log" 2>/dev/null || true
            fi
        else
            echo -e "      ${DARKGRAY}Could not extract the AppImage for repackaging — skipping, original kept as-is.${NC}"
        fi
        rm -rf "$work"
    fi
fi

echo
echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN}  BUILD COMPLETE${NC}"
echo -e "${GREEN}============================================================${NC}"
echo
echo -e "  ${CYAN}AppImage : $DIST_DIR/FLUX*hub-*.AppImage${NC}"
echo -e "  ${CYAN}Debian   : $DIST_DIR/flux-hub_*_amd64.deb${NC}"
echo -e "  ${CYAN}RPM      : $DIST_DIR/flux-hub-*.x86_64.rpm${NC}"
echo
