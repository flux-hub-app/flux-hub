'use strict';

// engine/scheduler.js — the background loop that ticks every minute and,
// inside the configured time window, polls RSS feeds/subscriptions marked
// for auto-download via engine/autopoll.js. Extracted verbatim from main.js
// (Phase C, 2026-08-23) — was already Electron-free before this move (see
// design/flux-patterns.md §9), this just relocates it so a headless
// server.js can start the exact same loop with no BrowserWindow at all.
const bus = require('./bus');
const { log } = require('./log');
const { loadConfig } = require('./config');
const { loadSchedule } = require('./schedule');
const { createAutopoll } = require('./autopoll');

const autopollEngine = createAutopoll();

// Timer handle owned here (not by the caller) so main.js's window-all-closed
// cleanup and the schedule:save IPC handler's restart both go through
// stopScheduler()/startScheduler() instead of reaching into a shared `let`.
let schedulerTimer = null;

function isInTimeWindow(now, start, end) {
  const [sh, sm] = (start || '00:00').split(':').map(Number);
  const [eh, em] = (end   || '23:59').split(':').map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  const s   = sh * 60 + sm;
  const e   = eh * 60 + em;
  if (s === e) return true;
  if (s < e)   return cur >= s && cur < e;
  return cur >= s || cur < e; // wrap past midnight
}

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(() => {
    try {
      const sched = loadSchedule();
      const cfg   = loadConfig();
      if (!sched.enabled) return;

      const now      = new Date();
      const inWindow = isInTimeWindow(now, sched.window_start, sched.window_end);
      if (!inWindow) return;

      // Poll RSS feeds marked auto_download
      (cfg.rss_feeds || []).filter(f => f.auto_download).forEach(feed => {
        const minutes = (Date.now() - new Date(feed.last_fetched || 0).getTime()) / 60000;
        if (minutes < (sched.rss_poll_min || 60)) return;
        autopollEngine.pollFeed(feed.url, feed.name)
          .then(r => { if (r.ok && r.queued) bus.broadcastSend('scheduler:pollComplete', { kind: 'rss' }); })
          .catch(e => log('ERROR', `autopoll rss "${feed.name}": ${e.message}`));
      });

      // Poll enabled subscriptions (search-based "follow a title", for content
      // with no ready-made RSS feed — see the config.subscriptions comment).
      (cfg.subscriptions || []).filter(s => s.enabled).forEach(sub => {
        const minutes = (Date.now() - new Date(sub.last_checked || 0).getTime()) / 60000;
        if (minutes < (sched.subs_poll_min || 60)) return;
        autopollEngine.pollSubscription(sub.id)
          .then(r => { if (r.ok && r.queued) bus.broadcastSend('scheduler:pollComplete', { kind: 'subscription' }); })
          .catch(e => log('ERROR', `autopoll subscription "${sub.query}": ${e.message}`));
      });
    } catch (e) { log('ERROR', `scheduler: ${e.message}`); }
  }, 60 * 1000); // every minute
}

function stopScheduler() {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
}

module.exports = { startScheduler, stopScheduler, isInTimeWindow };
