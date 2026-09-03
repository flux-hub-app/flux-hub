'use strict';

// engine/engine-modules.js — the single list of engine/ modules that declare
// a `routes[]` array (Fase G, .claude/plans). Both main.js (wireIpc) and
// server.js (wireRest) require THIS file and wire the same list, so a route
// declared once in a module reaches both transports without either entry
// point being hand-edited. Add a module here the moment its own routes[]
// exists — nothing else needs to change in main.js/server.js for it to take
// effect on both platforms.
module.exports = [
  require('./profiles'),
  require('./history'),
  require('./sendto'),
  require('./schedule'),
  require('./rss'),
  require('./queue'),
  require('./config'),
  require('./torrent'),
  // Fase G, Step 2:
  require('./radio'),
  require('./live'),
  require('./irc'),
  require('./tag'),
  require('./identify'),
  require('./fileops'),
  // Fase G, Step 3:
  require('./xtract'),
  require('./images'),
  require('./ai'),
];
