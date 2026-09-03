'use strict';

// engine/bus.js — the "who do I notify" seam for events with no live IPC
// caller (scheduler ticks, auto-updater, background remote pairing). Handlers
// invoked from a renderer via ipcMain already have an `event.sender` to reply
// to and don't need this — only background code that fires on its own does.
//
// Desktop registers mainWindow.webContents as the sink. A future headless
// server would register an object shaped like { isDestroyed(), send() } that
// fans out over SSE instead — main.js's existing safeSend() already duck-types
// on that shape, so nothing else needs to change when that day comes.
const { log } = require('./log');

let sink = null;

function setSink(newSink) {
  sink = newSink;
}

function getSink() {
  return sink;
}

// Multi-sink fan-out (Phase C, 2026-08-23) — for server.js's SSE endpoint,
// where each connected browser tab is its own sink and a background event
// (scheduler tick, queue progress with no live IPC caller) must reach ALL of
// them, not just one. Desktop keeps using setSink()/getSink() untouched (a
// single mainWindow sink is a degenerate case of N=1); server.js additionally
// calls addSink()/removeSink() per SSE connection and broadcasts with
// broadcastSend() below instead of safeSend(getSink(), ...).
const sinks = new Set();

function addSink(newSink) {
  sinks.add(newSink);
}

function removeSink(oldSink) {
  sinks.delete(oldSink);
}

// Sends to the single desktop sink (if any) AND every registered SSE sink —
// safe to call unconditionally from shared engine/ code (autopoll, scheduler,
// torrent search progress) regardless of which host registered what.
function broadcastSend(channel, payload) {
  if (sink) safeSend(sink, channel, payload);
  for (const s of sinks) safeSend(s, channel, payload);
}

// A sender-shaped object (isDestroyed/send) whose send() fans out through
// broadcastSend(). Lets code that expects a single `event.sender` — like
// runTorrentSearch's progress events — reach every registered sink (desktop
// window AND all SSE clients) without knowing which host(s) are active. Used
// by engine/autopoll.js's pollSubscription() in place of the bare getSink().
function getBroadcastSender() {
  return { isDestroyed: () => false, send: (channel, payload) => broadcastSend(channel, payload) };
}

// The single send point every main→renderer/SSE message goes through — desktop
// IPC handlers pass their own live `event.sender`, background code passes
// getSink(). Moved here from main.js (Phase C, 2026-08-23) so engine/ modules
// (e.g. engine/torrent.js's progress events) can call it without reaching back
// into main.js. Duck-typed on { isDestroyed(), send() } — any compatible sink
// works, including a future SSE fan-out object.
function safeSend(sender, channel, payload) {
  try { if (sender && !sender.isDestroyed()) sender.send(channel, payload); }
  catch (e) { log('WARN', `safeSend ${channel}: ${e.message}`); }
}

module.exports = { setSink, getSink, addSink, removeSink, broadcastSend, getBroadcastSender, safeSend };
