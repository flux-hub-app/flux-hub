'use strict';

// engine/history.js — download history log (capped at 500 entries) +
// aggregate stats. Extracted verbatim from main.js (Phase C, 2026-08-23).
const fs = require('fs');
const path = require('path');
const enginePaths = require('./paths');
const { log } = require('./log');

function historyPath() {
  return path.join(enginePaths.getPaths().userData, 'history.json');
}

function loadHistory() {
  try {
    const p = historyPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return [];
}

function appendHistory(entry) {
  try {
    const h = loadHistory();
    // Stat the downloaded file at append time so the History stats bar can
    // sum bytes without re-scanning the disk on every render. Failures are
    // swallowed: the file may have been moved/deleted between download
    // completion and this stat, and a missing size is not worth blocking
    // the history write.
    let size = entry.size;
    if (size == null && entry.path && !/^https?:\/\//i.test(entry.path)) {
      try {
        const st = fs.statSync(entry.path);
        if (st.isFile()) size = st.size;
      } catch {}
    }
    h.unshift({ ...entry, size: size ?? null, ts: new Date().toISOString() });
    // Keep latest 500 entries
    const trimmed = h.slice(0, 500);
    fs.writeFileSync(historyPath(), JSON.stringify(trimmed, null, 2), 'utf8');
  } catch (e) { log('ERROR', `appendHistory: ${e.message}`); }
  // Both the IPC and REST callers always returned `true` unconditionally
  // (a write failure is logged, not surfaced) — returning it here too, once,
  // keeps that identical for both transports via the routes[] registry below.
  return true;
}

// Aggregate history into a small stats payload. Older entries (pre-size-
// tracking) get a one-shot lazy fill: if their file still exists, we stat
// it and persist the size back so subsequent renders are free. Run in main
// because stat-ing 500 files via IPC would be wasteful.
function computeHistoryStats() {
  const h = loadHistory();
  let dirty = false;
  let totalBytes = 0;
  const byKind = {};
  const bySource = {};
  let ok = 0, fail = 0;
  for (const e of h) {
    if (e.ok) ok++; else fail++;
    if (e.kind)   byKind[e.kind]     = (byKind[e.kind]     || 0) + 1;
    if (e.source) bySource[e.source] = (bySource[e.source] || 0) + 1;
    if (e.size == null && e.path && !/^https?:\/\//i.test(e.path)) {
      try {
        const st = fs.statSync(e.path);
        if (st.isFile()) { e.size = st.size; dirty = true; }
      } catch {}
    }
    if (typeof e.size === 'number') totalBytes += e.size;
  }
  if (dirty) {
    try { fs.writeFileSync(historyPath(), JSON.stringify(h, null, 2), 'utf8'); }
    catch (err) { log('ERROR', `computeHistoryStats save: ${err.message}`); }
  }
  return { total: h.length, ok, fail, byKind, bySource, totalBytes };
}

function clearHistory() {
  try { fs.writeFileSync(historyPath(), '[]', 'utf8'); return true; }
  catch { return false; }
}

module.exports = {
  loadHistory, appendHistory, computeHistoryStats, clearHistory,
  routes: [
    { channel: 'history:load',   method: 'GET',    path: '/api/history',       fn: 'loadHistory',         args: () => [] },
    { channel: 'history:clear',  method: 'DELETE',  path: '/api/history',      fn: 'clearHistory',        args: () => [] },
    { channel: 'history:stats',  method: 'GET',    path: '/api/history/stats', fn: 'computeHistoryStats', args: () => [] },
    { channel: 'history:append', method: 'POST',   path: '/api/history/append', fn: 'appendHistory',      args: body => [body] },
  ],
};
