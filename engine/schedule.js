'use strict';

// engine/schedule.js — auto-download scheduler window/interval settings.
// Extracted verbatim from main.js (Phase C, 2026-08-23).
const fs = require('fs');
const path = require('path');
const enginePaths = require('./paths');

function schedulePath() {
  return path.join(enginePaths.getPaths().userData, 'schedule.json');
}

function loadSchedule() {
  try {
    const p = schedulePath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return { enabled: false, window_start: '02:00', window_end: '06:00', rss_poll_min: 60, subs_poll_min: 60 };
}

function saveSchedule(s) {
  try { fs.writeFileSync(schedulePath(), JSON.stringify(s, null, 2), 'utf8'); return true; }
  catch { return false; }
}

module.exports = {
  loadSchedule, saveSchedule,
  // Only `load` is declared here — `save` has a real per-caller side effect
  // (both main.js and server.js call startScheduler() right after saving, to
  // apply the new window/interval immediately) that the generic wireIpc/
  // wireRest wrapper has no place for, so it stays hand-written on both
  // sides rather than losing that behaviour for cosmetic uniformity.
  routes: [
    { channel: 'schedule:load', method: 'GET', path: '/api/schedule', fn: 'loadSchedule', args: () => [] },
  ],
};
