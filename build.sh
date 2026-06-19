#!/usr/bin/env bash
# ============================================================
# build.sh - FLUX build (macOS or Linux, native)
# ============================================================
# Auto-detects the host OS and dispatches to the matching script under build/:
#   - macOS  → build/build-mac.sh   (.dmg + .zip, x64 + arm64)
#   - Linux  → build/build-linux.sh (.AppImage + .deb + .rpm)
#
# Cross-builds were removed: per-platform scripts now run only on their native
# OS so the output matches what Release CI produces.
#   Windows users: use .\build.ps1 on Windows.
# ============================================================
set -euo pipefail

if [ -t 1 ]; then
    CYAN='\033[36m'; RED='\033[31m'; DARKGRAY='\033[90m'; NC='\033[0m'
else
    CYAN=''; RED=''; DARKGRAY=''; NC=''
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
host_os="$(uname -s)"

case "$host_os" in
    Darwin) target=mac;   script="$BUILD_DIR/build-mac.sh"   ;;
    Linux)  target=linux; script="$BUILD_DIR/build-linux.sh" ;;
    *)
        echo -e "${RED}ERROR: build.sh supports macOS and Linux hosts only (uname: $host_os).${NC}"
        echo -e "${RED}       On Windows, use .\\build.ps1.${NC}"
        exit 1
        ;;
esac

echo
echo -e "${CYAN}============================================================${NC}"
echo -e "${CYAN}  FLUX -- $target build (native $host_os)${NC}"
echo -e "${CYAN}============================================================${NC}"
echo

if [ ! -f "$script" ]; then
    echo -e "${RED}ERROR: Build script not found: $script${NC}"
    exit 1
fi

echo -e "  ${DARKGRAY}Launching: ${script#$SCRIPT_DIR/}${NC}"
echo

chmod +x "$script" 2>/dev/null || true
exec bash "$script"
