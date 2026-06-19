# ============================================================
# build.ps1 - FLUX build script (Windows)
# ============================================================
# Usage:
#   .\build\build-win.ps1            -> build, then ask whether to launch the portable
#   .\build\build-win.ps1 -Launch    -> build, then auto-launch the portable (no prompt)
#   .\build\build-win.ps1 -NoLaunch  -> build, never ask (useful for CI / scripted runs)
#   .\build\build-win.ps1 -CleanData -> also wipe %APPDATA%\flux-hub (prefs + fetched
#                                       binaries) for a first-launch-clean test
# Same switches can be passed via the root .\build.ps1 dispatcher.
# ============================================================
param(
    [switch]$Launch,
    [switch]$NoLaunch,
    [switch]$CleanData
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"


# ── Disable Windows Console QuickEdit Mode ───────────────────────────────────
# Without this, ANY click in the console window pauses process output (the
# "selection holds the pipe" behaviour). Long-running steps like yt-dlp /
# fpcalc downloads appear frozen until the user right-clicks to dismiss the
# selection. Programmatically clearing ENABLE_QUICK_EDIT_INPUT prevents it.
try {
    $consoleSig = @"
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int handle);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
"@
    if (-not ('Win32.ConsoleCtl' -as [type])) {
        Add-Type -MemberDefinition $consoleSig -Name 'ConsoleCtl' -Namespace 'Win32' | Out-Null
    }
    $STD_INPUT_HANDLE = -10
    $ENABLE_QUICK_EDIT     = 0x0040
    $ENABLE_EXTENDED_FLAGS = 0x0080
    $h    = [Win32.ConsoleCtl]::GetStdHandle($STD_INPUT_HANDLE)
    $mode = 0
    [void][Win32.ConsoleCtl]::GetConsoleMode($h, [ref]$mode)
    $mode = ($mode -band (-bnot $ENABLE_QUICK_EDIT)) -bor $ENABLE_EXTENDED_FLAGS
    [void][Win32.ConsoleCtl]::SetConsoleMode($h, $mode)
} catch {
    # Non-fatal -- happens in non-console hosts (VS Code integrated terminal, etc.)
}
$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
# Scripts now live in <repo>\build\, so the project root is one level up.
$projectRoot = Split-Path -Parent $scriptDir
# Set CWD to project root so npm/npx/node find package.json + scripts/.
[Environment]::CurrentDirectory = $projectRoot
Set-Location -LiteralPath $projectRoot

# Redirect TEMP to dist\tmp (the single staging area for this build). Many
# users have FLUX on D: with C: nearly full; electron-builder stages
# hundreds of MB through TEMP and crashes with ENOSPC on the system one.
# Step [2/6] below wipes + recreates dist\tmp before the build proper starts.
$tmpDir = Join-Path $projectRoot 'dist\tmp'
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$env:TEMP = $tmpDir
$env:TMP  = $tmpDir
# Defensive: clear any FLUX_TARGET_PLATFORM env that might be leaking from a
# previous cross-build run in the same shell. We want process.platform = win32.
$env:FLUX_TARGET_PLATFORM = $null
$env:FLUX_TARGET_ARCH     = $null
$distDir   = Join-Path $projectRoot "dist"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  FLUX -- Fetch, Load, Use & eXtract  |  Windows Build" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# -- [1/6] Kill any running FLUX processes from dist\ ----------------
Write-Host "[1/5] Closing running FLUX instances..." -ForegroundColor Yellow
$killed = $false
# NB: Electron spawns a process tree (main + renderer + GPU + utility). Killing the
# parent cascades to children -- by the time PowerShell iterates to the next PID, it
# may already be dead. -ErrorAction SilentlyContinue swallows that race-condition.
Get-Process | Where-Object {
    try { $_.MainModule.FileName -like "$distDir\*" } catch { $false }
} | ForEach-Object {
    Write-Host "      Stopping: $($_.MainModule.FileName)" -ForegroundColor DarkGray
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    $killed = $true
}
Get-Process -Name "FLUX*" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "      Stopping $($_.ProcessName).exe (pid $($_.Id))" -ForegroundColor DarkGray
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    $killed = $true
}
if ($killed) {
    Start-Sleep -Seconds 2
    Write-Host "      Done." -ForegroundColor Green
} else {
    Write-Host "      No running instances found." -ForegroundColor DarkGray
}

# -- [2/6] Clean dist\tmp\ + previous Windows artefacts ----------------
# Wipes the intermediate work dir AND any previous Windows finals so the
# user opens dist\ after the build and sees only the freshly-built files.
# Artefacts from other platforms (.dmg/.AppImage/.deb/.rpm/.tar.gz) are
# preserved. Also nukes legacy dist\build-temp from older script revs.
Write-Host "[2/5] Cleaning dist\tmp\ + previous Windows artefacts..." -ForegroundColor Yellow
New-Item -ItemType Directory -Path $distDir -Force | Out-Null
$legacyBuildTemp = Join-Path $distDir 'build-temp'
if (Test-Path $legacyBuildTemp) {
    Write-Host "      Removing legacy dist\build-temp..." -ForegroundColor DarkGray
    Remove-Item -Recurse -Force $legacyBuildTemp -ErrorAction SilentlyContinue
}
Get-ChildItem $distDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -ieq '.exe' -or $_.Name -match '^FLUX.*\.(exe|msi)$' } |
    ForEach-Object {
        Write-Host "      Removing: $($_.Name)" -ForegroundColor DarkGray
        Remove-Item -Force $_.FullName -ErrorAction SilentlyContinue
    }
if (Test-Path $tmpDir) {
    $retries = 5
    for ($i = 0; $i -lt $retries; $i++) {
        try {
            Remove-Item -Recurse -Force $tmpDir -ErrorAction Stop
            Write-Host "      Cleaned." -ForegroundColor Green
            break
        } catch {
            if ($i -eq $retries - 1) {
                Write-Host "ERROR: Could not delete dist\tmp\: $_" -ForegroundColor Red
                exit 1
            }
            Write-Host "      Waiting for file locks to release..." -ForegroundColor DarkGray
            Start-Sleep -Seconds 2
        }
    }
} else {
    Write-Host "      dist\tmp\ not found, skipping." -ForegroundColor DarkGray
}
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

# -- [3/6] Check Node.js ----------------------------------------------
Write-Host "[3/5] Checking Node.js..." -ForegroundColor Yellow
try { $v = node --version 2>&1; Write-Host "      Node.js $v" -ForegroundColor Green }
catch { Write-Host "ERROR: Node.js not found. https://nodejs.org" -ForegroundColor Red; exit 1 }

# -- [4/6] Install dependencies ---------------------------------------
Write-Host "[4/5] Installing dependencies..." -ForegroundColor Yellow
npm install --silent
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: npm install failed." -ForegroundColor Red; exit 1 }
Write-Host "      Done." -ForegroundColor Green

# -- [5/5] Build ------------------------------------------------------
# Phase 2b (slim installer): binaries (yt-dlp / ffmpeg / ffprobe / fpcalc) are
# NO LONGER bundled or fetched at build time. FLUX downloads each one into
# userData\vendor the first time the user opens a module that needs it (see
# binary-fetcher.js). This is why there is no fetch step here and the build no
# longer carries ~180 MB of vendor binaries. For DEV runs (`npm start`) the
# binaries are populated by `npm run fetch-all` or by the same runtime fetcher.
Write-Host "[5/5] Building FLUX (electron-builder)..." -ForegroundColor Yellow
Set-Location $projectRoot
# electron-builder output redirected to dist\tmp so intermediates (win-unpacked,
# .icon-ico, builder cache) stay cleanly separated from the user-facing finals.
npx electron-builder --win --config.directories.output=dist/tmp
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: Build failed." -ForegroundColor Red; exit 1 }

# Post-build verification. electron-builder's portable target wipes the
# win-unpacked intermediate after creating the .exe, so the old "look for
# yt-dlp.exe in win-unpacked" check would always fail. We verify the final
# .exe files exist at a reasonable size instead — the binary verification
# of bundled tools happens at extraResources copy time inside electron-builder.
# Two artefacts expected now: NSIS installer ("FLUX Setup x.y.z.exe") and the
# portable ("FLUX x.y.z.exe"). Slim build (Phase 2b — no bundled binaries):
# the floor is 40 MB. The Electron runtime + app.asar (sharp, pdfjs, fabric)
# alone clear that comfortably, so anything smaller means electron-builder
# produced a broken/empty package — NOT a missing vendor bundle (binaries are
# now fetched at first run, not shipped).
$exes = @(Get-ChildItem $tmpDir -File -Filter '*.exe' -ErrorAction SilentlyContinue)
if (-not $exes -or $exes.Count -eq 0) {
    Write-Host "ERROR: no .exe produced under $tmpDir" -ForegroundColor Red
    exit 1
}
foreach ($exe in $exes) {
    $exeMB = [math]::Round($exe.Length / 1MB, 1)
    if ($exeMB -lt 40) {
        Write-Host "ERROR: $($exe.Name) is suspiciously small ($exeMB MB) — the package looks broken/empty." -ForegroundColor Red
        exit 1
    }
    $kind = if ($exe.Name -match '(?i)setup') { 'installer' } else { 'portable' }
    Write-Host ("      {0,-9}: {1} ({2} MB)" -f $kind, $exe.Name, $exeMB) -ForegroundColor Green
}

# Promote ONLY the user-facing final installer/portable from dist\tmp\ to dist\.
# We deliberately drop the auto-updater metadata (blockmap, latest.yml,
# builder-debug.yml) since this build pipeline isn't wired to a release server
# yet. They can be re-enabled when electron-updater publishing is configured.
Write-Host "      Moving final artifacts to dist\..." -ForegroundColor Yellow
Get-ChildItem $tmpDir -File -Filter '*.exe' | ForEach-Object {
    $dest = Join-Path $distDir $_.Name
    Move-Item -Force $_.FullName $dest
    Write-Host "        -> $dest" -ForegroundColor DarkGreen
}

# Final cleanup: wipe the entire tmp\ + any updater metadata that landed in
# dist\ root. After this, dist\ contains only user-facing finals.
Write-Host "      Cleaning up build artefacts..." -ForegroundColor Yellow
if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue }
Get-ChildItem $distDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '\.(blockmap|yml)$' -or $_.Name -eq 'builder-debug.yml' } |
    Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  BUILD COMPLETE" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Installer: dist\FLUX Hub Setup*.exe" -ForegroundColor Cyan
Write-Host "  Portable:  dist\FLUX Hub*.exe" -ForegroundColor Cyan
Write-Host ""

# ── Optional: wipe user data for a clean test ───────────────────────────────
# %APPDATA%\flux-hub holds config / profiles / queue / history / flux.log AND the
# lazy-fetched vendor\ binaries. Removing it yields a first-launch-clean state
# so the download view + first-run flow (TOS, fetch prompts) can be tested from
# scratch. -CleanData wipes without asking; otherwise (interactive) we prompt,
# default NO. Safe: running FLUX instances were already killed in step [1/5].
$fluxData = Join-Path $env:APPDATA 'flux-hub'
$doWipe = $false
if ($CleanData) {
    $doWipe = $true
} elseif (-not $NoLaunch -and -not $Launch) {
    Write-Host "  Wipe FLUX preferences for a clean test?" -ForegroundColor Yellow
    Write-Host "    $fluxData" -ForegroundColor DarkGray
    Write-Host "    (deletes settings + downloaded binaries) [y/N] " -ForegroundColor Yellow -NoNewline
    $wipeReply = Read-Host
    if ($wipeReply -match '^(y|yes|s|si|sì)$') { $doWipe = $true }
}
if ($doWipe) {
    if (Test-Path $fluxData) {
        try {
            Remove-Item -Recurse -Force $fluxData -ErrorAction Stop
            Write-Host "  Wiped preferences: $fluxData" -ForegroundColor Green
        } catch {
            Write-Host "  WARN: could not wipe $fluxData -- $_" -ForegroundColor Yellow
            Write-Host "        (close any running FLUX and delete it manually)" -ForegroundColor DarkGray
        }
    } else {
        Write-Host "  Nothing to wipe ($fluxData not found)." -ForegroundColor DarkGray
    }
    Write-Host ""
}

# ── Optional: launch the portable right after build ─────────────────────────
# -Launch   → auto-launch, no prompt (handy when iterating manually)
# -NoLaunch → never ask (CI / scripted use)
# neither   → interactive prompt (Y default)
# We pick the portable (NOT the installer) — installer would start a UI flow
# the user almost certainly doesn't want when they just rebuilt.
$portable = Get-ChildItem $distDir -File -Filter 'FLUX*.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch '(?i)setup' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if ($portable) {
    $shouldLaunch = $false
    if ($Launch) {
        $shouldLaunch = $true
    } elseif (-not $NoLaunch) {
        Write-Host "  Launch the portable now? [Y/n] " -ForegroundColor Yellow -NoNewline
        $reply = Read-Host
        if ([string]::IsNullOrWhiteSpace($reply) -or $reply -match '^(y|yes|s|si|sì)$') {
            $shouldLaunch = $true
        }
    }
    if ($shouldLaunch) {
        Write-Host "  Launching: $($portable.Name)" -ForegroundColor Green
        # Start-Process detaches so this shell returns immediately and FLUX
        # keeps running even after the build script exits.
        Start-Process -FilePath $portable.FullName
    }
}
