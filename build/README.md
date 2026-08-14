# Build & launch — quick reference

Full details (prerequisites, architecture, troubleshooting): see the
[project README](../README.md#for-developers--building-from-source).

## Dev mode (no build — fastest loop)

```bash
npm install
npm run fetch-all     # yt-dlp + ffmpeg + fpcalc into vendor/ (first time only)
npm start
```

## Build an installer

Run from the **project root**, on the matching native OS (no cross-builds):

| OS | Command | Output |
|---|---|---|
| Windows | `.\build.ps1` | `dist\FLUX Hub Setup*.exe` (installer) + `dist\FLUX Hub*.exe` (portable) |
| macOS | `./build.sh` | `dist/FLUX Hub-*.dmg` + `.zip` (x64 + arm64) |
| Linux | `./build.sh` | `dist/*.AppImage` + `.deb` + `.rpm` |

`build.ps1` / `build.sh` are dispatchers in the project root — they auto-detect the OS and
hand off to the real script here in `build/` (`build-win.ps1`, `build-mac.sh`,
`build-linux.sh`). No need to call the `build/` scripts directly, though they work standalone
too.

### Windows flags (forwarded by `.\build.ps1`)

| Flag | Effect |
|---|---|
| *(none)* | Build, then ask whether to launch the portable |
| `-Launch` | Build, then auto-launch the portable — no prompt |
| `-NoLaunch` | Build, never ask (CI / scripted use) |
| `-CleanData` | Also wipe `%APPDATA%\flux-hub` (settings + fetched binaries) for a first-launch-clean test |
| `-Help` / `-h` | Show usage and exit (no build) |

Example: `.\build.ps1 -Launch`

macOS/Linux: `./build.sh -h` / `./build.sh --help` shows the same kind of summary.

### What each build script does

1. Closes any running FLUX Hub instance (so files aren't locked)
2. Cleans previous artefacts for that platform from `dist/`
3. Checks Node.js, runs `npm install`
4. Builds the platform icon from `assets/icon.svg`
5. Runs `electron-builder` for that target
6. Verifies the output exists and isn't a broken/empty package

**Slim installer:** no vendor binaries are bundled — FLUX fetches yt-dlp/ffmpeg/fpcalc into
`userData/vendor` the first time a module needs them.

### Build logs

Each run writes its own log next to the script: `build-win.log`, `build-mac.log`,
`build-linux.log` — check these first if a build fails. Gitignored (`*.log`), safe to delete.
