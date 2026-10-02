'use strict';

// engine/wire-rest.js — generic server.js-side wiring for the declarative
// route registry (Fase G, .claude/plans). Sibling of wire-ipc.js: same
// `routes` array on each engine/*.js module, read here to register REST
// routes on server.js's hand-rolled router (`on(method, pattern, handler)`)
// instead of a hand-written `on(...)` call per channel.
//
// Every generated route replies with `sendJSON(res, 200, result)` — the
// existing convention for every route built this way so far in this project
// (the function's own return value already carries `{ok:false, error}` on
// failure, no HTTP status-code branching needed). A route that legitimately
// needs a different status code (400 on bad input, 201 on create, etc.) is
// exactly the kind of per-transport divergence that stays hand-written in
// server.js instead of going through this generic path — see wire-ipc.js's
// header comment for the same principle on the IPC side.
const bus = require('./bus');

// `route.binary: true` — the route's POST body is raw bytes (a browser
// Blob/ArrayBuffer via api-http.js's POSTBIN, see engine/wire-rest.js's
// sibling on the client side), not JSON — the microphone-capture routes
// (identify) are the first users. `body` is still one object for `args()`:
// query-string params spread in, plus `buffer` holding the raw Buffer —
// same shape a IPC caller would send (`{apiKey, buffer}`).
function wireRest(on, modules, { readJSONBody, readBinaryBody, sendJSON }) {
  for (const mod of modules) {
    for (const route of (mod.routes || [])) {
      on(route.method, route.path, async (req, res, params, query) => {
        let body;
        if (route.binary) {
          const buffer = await readBinaryBody(req);
          body = { ...Object.fromEntries(query.entries()), buffer };
        } else if (route.method === 'GET' || route.method === 'DELETE') {
          body = Object.fromEntries(query.entries());
        } else {
          // route.maxBodyBytes: optional per-route override of the default
          // 10MB JSON body cap (readJSONBody(req) alone always uses that
          // default) — images:applyPipeline is the first user, its
          // `inputData` (a flattened annotate-canvas PNG, base64-encoded)
          // can exceed 10MB for a high-resolution photo.
          body = await readJSONBody(req, route.maxBodyBytes);
        }
        const result = await mod[route.fn](...route.args(body, bus.getBroadcastSender()));
        sendJSON(res, 200, result);
      });
    }
  }
}

module.exports = { wireRest };
