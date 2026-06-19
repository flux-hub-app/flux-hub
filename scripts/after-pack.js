'use strict';

// electron-builder afterPack hook.
//
// Cross-compiling from Windows to macOS/Linux: NTFS has no POSIX exec bit, so
// vendor/yt-dlp and vendor/fpcalc land in the packaged .app/AppImage without
// +x. macOS/Linux refuse to spawn them. This hook chmods them after the bundle
// has been laid out but before the DMG/AppImage container is finalised.
//
// On a native Mac/Linux build this is a no-op (the source already has +x).
// On a Windows native build the binaries are .exe and the chmod call is harmless.

const fs   = require('fs');
const path = require('path');

const BINARIES = [
  'yt-dlp', 'yt-dlp.exe',
  'fpcalc', 'fpcalc.exe',
  'ffmpeg', 'ffmpeg.exe',
  'ffprobe', 'ffprobe.exe'
];

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context;

  // Only Unix targets need the exec bit. Win32 ignores POSIX modes.
  if (electronPlatformName === 'win32') return;

  // Resources root: macOS .app vs Linux unpacked dir
  const resourcesDirs = electronPlatformName === 'darwin'
    ? [path.join(appOutDir, 'FLUX.app', 'Contents', 'Resources')]
    : [path.join(appOutDir, 'resources')];

  for (const resDir of resourcesDirs) {
    for (const sub of ['vendor', path.join('app.asar.unpacked', 'vendor')]) {
      const dir = path.join(resDir, sub);
      if (!fs.existsSync(dir)) continue;
      for (const bin of BINARIES) {
        const f = path.join(dir, bin);
        if (fs.existsSync(f)) {
          try {
            fs.chmodSync(f, 0o755);
            console.log(`  afterPack: chmod +x ${path.relative(appOutDir, f)}`);
          } catch (e) {
            console.warn(`  afterPack: chmod failed for ${f}: ${e.message}`);
          }
        }
      }
    }
  }
};
