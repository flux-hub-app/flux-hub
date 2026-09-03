'use strict';

// engine/wire-ipc.js — generic Electron-side wiring for the declarative
// route registry (Fase G, .claude/plans). Each engine/*.js module MAY export
// a `routes` array: { channel, fn, args }. wireIpc() reads that array and
// registers ipcMain.handle(channel, ...) so main.js never hand-writes a
// one-line wrapper per channel — the module declares its own wiring once,
// next to the function it describes, and BOTH main.js (via this file) and
// server.js (via wire-rest.js) read the same declaration.
//
// `args(body, sender)` maps the IPC payload to the function's positional
// arguments — `sender` is `event.sender` here (a live webContents, always
// present for an IPC call), and `bus.getBroadcastSender()` on the REST side
// (see wire-rest.js) — the same duck-typed sink shape used everywhere else
// in this codebase (engine/bus.js).
//
// Only modules with GENUINELY IDENTICAL behaviour on both transports declare
// routes here. A handler with real per-transport divergence (extra REST
// input validation, a side effect only one side needs) stays hand-written in
// main.js/server.js — forcing it into this generic shape would either lose
// that behaviour or bloat this file with per-route escape hatches, which
// defeats the point of it being generic.
function wireIpc(ipcMain, modules) {
  for (const mod of modules) {
    for (const route of (mod.routes || [])) {
      ipcMain.handle(route.channel, (event, body) =>
        mod[route.fn](...route.args(body === undefined ? {} : body, event.sender))
      );
    }
  }
}

module.exports = { wireIpc };
