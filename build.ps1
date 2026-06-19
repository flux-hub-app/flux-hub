# ============================================================
# build.ps1 - FLUX Windows build (native)
# ============================================================
# Builds the Windows targets (NSIS installer + portable .exe) by handing off
# to build\build-win.ps1. Refuses to run on non-Windows hosts.
#
# Usage:
#   .\build.ps1              -> build, then prompt whether to launch the portable
#   .\build.ps1 -Launch      -> build, then auto-launch the portable (no prompt)
#   .\build.ps1 -NoLaunch    -> build, never ask (CI / scripted use)
#   .\build.ps1 -CleanData   -> also wipe %APPDATA%\FLUX (settings + fetched
#                               binaries) for a first-launch-clean test
#
# Cross-builds were removed: a previous version of this dispatcher offered
# .\build.ps1 mac and .\build.ps1 linux, which produced .zip/.tar.gz via
# @electron/packager. The output diverged from the native build-mac.sh /
# build-linux.sh (no .dmg, no .AppImage, different layout), confusing users.
# Now each platform builds on its own host:
#   - Windows : .\build.ps1
#   - macOS   : ./build.sh
#   - Linux   : ./build.sh
# ============================================================
param(
    [switch]$Launch,
    [switch]$NoLaunch,
    [switch]$CleanData
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# $IsWindows is an automatic variable ONLY in PowerShell 6+ (Core). Under
# Windows PowerShell 5.1 it doesn't exist, and Set-StrictMode -Version Latest
# turns the bare reference into a terminating error ("variable ... has not been
# set"). 5.1 only ever runs on Windows, so gate on the engine version first and
# never touch $IsWindows on the legacy edition.
$onWindows = $true
if ($PSVersionTable.PSVersion.Major -ge 6) { $onWindows = [bool]$IsWindows }
if (-not $onWindows) {
    Write-Host 'ERROR: build.ps1 must run on Windows.' -ForegroundColor Red
    Write-Host '       On macOS or Linux, use ./build.sh instead.' -ForegroundColor Red
    exit 1
}

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

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$buildScript = Join-Path $scriptDir 'build\build-win.ps1'

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  FLUX -- Windows build' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path $buildScript)) {
    Write-Host "ERROR: Build script not found: $buildScript" -ForegroundColor Red
    exit 1
}

Write-Host "  Launching: build\build-win.ps1" -ForegroundColor DarkGray
Write-Host '  (The script will self-elevate via UAC if it needs admin rights.)' -ForegroundColor DarkGray
Write-Host ''

# Forward the launch switches to build-win.ps1 so the prompt-or-not behaviour
# is consistent whether the user invokes the dispatcher or the per-platform
# script directly. -Launch wins over -NoLaunch if both are passed (same
# precedence as inside build-win.ps1).
$forwardArgs = @()
if ($Launch)   { $forwardArgs += '-Launch' }
if ($NoLaunch -and -not $Launch) { $forwardArgs += '-NoLaunch' }
if ($CleanData) { $forwardArgs += '-CleanData' }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $buildScript @forwardArgs
exit $LASTEXITCODE
