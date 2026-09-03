'use strict';

// engine/log.js — file+console logger shared by every engine/ module and
// main.js. LOG_PATH is resolved from engine/paths.js INSIDE the function
// (not once at module load) so this works no matter when it's required
// relative to enginePaths.configurePaths() — same lazy-resolve style already
// used by getFfmpegPath()/getYtDlpPath() in main.js (deliberate, not cached).
const fs = require('fs');
const path = require('path');
const enginePaths = require('./paths');

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  try {
    const logPath = path.join(enginePaths.getPaths().userData, 'flux.log');
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {}
  console.log(line.trim());
}

module.exports = { log };
