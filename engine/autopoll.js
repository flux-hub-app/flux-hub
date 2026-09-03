'use strict';

// engine/autopoll.js — the scheduler-driven "check a feed/subscription for new
// items and auto-queue them" logic. Previously this lived in renderer.js
// (autoPollFeed/autoPollSubscription), reached only via `scheduler:autoPoll*`
// messages sent to the window — which meant it silently did nothing with no
// window open. Moved here so main.js's scheduler can call it directly.
//
// Data-layer functions now live in engine/ too (Phase C, 2026-08-23:
// config/net/rss/torrent/queue/log) and are required directly, same as
// bus.js/host.js below — all are Electron-free engine modules meant to be
// used from anywhere in this layer (see design/flux-patterns.md §8-9).
const bus = require('./bus');
const host = require('./host');
const { loadConfig, saveConfig } = require('./config');
const { loadQueue, saveQueue, newQueueId } = require('./queue');
const { fetchTextSimple } = require('./net');
const { parseFeed } = require('./rss');
const { runTorrentSearch } = require('./torrent');
const { log } = require('./log');

// Classifies an RSS/Atom item the same way the renderer's RSS tab does, so
// an auto-polled item lands in the queue with the same type it would if the
// user had clicked "Queue" on it by hand. Deliberately duplicated (not
// shared) with renderer.js's own getRSSItemType — one copy renders UI badges
// in the DOM, this one drives headless queueing; both are ~6 lines of pure
// regex, not worth a cross-process shared module for.
function getRSSItemType(item) {
  const url  = item.enclosureUrl || '';
  const type = item.enclosureType || '';
  if (item.magnet) return 'torrent';
  if (/\.torrent($|\?)/i.test(url) || /bittorrent/i.test(type)) return 'torrent';
  if (/\.(mp3|m4a|ogg|opus|flac|wav|aac)($|\?)/i.test(url) || /^audio\//i.test(type)) return 'audio';
  if (/\.(mp4|m4v|mkv|webm|avi|mov)($|\?)/i.test(url) || /^video\//i.test(type)) return 'video';
  return 'link';
}

// Extracts a "SxxEyy" episode tag when present, so e.g. three different
// releases of the same episode collapse into one candidate group instead of
// grabbing all three. Titles with no such tag (the movie case) fall back to
// a normalized whole-name key.
function parseEpisodeTag(name) {
  const m = String(name || '').match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
  return m ? `S${m[1]}E${m[2]}` : String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function subscriptionResultId(item) {
  return item.magnet || item.url || item.name;
}

// One result per group (episode tag or normalized name): if `keyword` is set
// and at least one candidate in the group matches it (case-insensitive
// substring), only keyword-matching candidates are eligible; otherwise every
// candidate in the group is. Highest seed count wins among the eligible ones.
// Dedup runs AFTER picking the best-per-group (not before grouping): once the
// best release for an episode/title has been grabbed, a re-poll must not grab
// a different, lesser release of the SAME episode just because that specific
// id hasn't been seen before — grabbed_ids tracks "this episode is done", not
// merely "this exact id was seen". (Same fix as #25's test-caught bug.)
function pickSubscriptionMatches(results, sub) {
  const known = new Set(sub.grabbed_ids || []);
  const groups = new Map();
  for (const r of (results || [])) {
    const key = parseEpisodeTag(r.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const keyword = (sub.keyword || '').trim().toLowerCase();
  const picks = [];
  for (const candidates of groups.values()) {
    const eligible = keyword
      ? (candidates.filter(r => r.name.toLowerCase().includes(keyword)) || [])
      : candidates;
    const pool = eligible.length ? eligible : candidates;
    pool.sort((a, b) => (b.seeds || 0) - (a.seeds || 0));
    const best = pool[0];
    if (best && !known.has(subscriptionResultId(best))) picks.push(best);
  }
  return picks;
}

function createAutopoll() {
  async function pollFeed(feedUrl, feedName) {
    const cfg = loadConfig();
    const feeds = cfg.rss_feeds || [];
    const feedIdx = feeds.findIndex(f => f.url === feedUrl);
    if (feedIdx < 0) return { ok: false, error: 'feed not found' };
    const feed = feeds[feedIdx];

    let parsed;
    try {
      const xml = await fetchTextSimple(feedUrl, 20000);
      parsed = parseFeed(xml);
    } catch (e) {
      log('WARN', `autopoll rss "${feedName}": ${e.message}`);
      return { ok: false, error: e.message };
    }

    const knownGuids = new Set(feed.last_guids || []);
    const newItems = (parsed.items || []).filter(it => {
      const id = it.guid || it.link || it.title;
      return id && !knownGuids.has(id);
    });

    const queue = loadQueue();
    let queued = 0;
    for (const item of newItems) {
      const type = getRSSItemType(item);
      if (type === 'audio' || type === 'video') {
        queue.push({ id: newQueueId(), type: 'media', name: item.title, url: item.enclosureUrl, format: type, status: 'pending', origin: type === 'audio' ? 'podcast' : 'rss' });
        queued++;
      } else if (type === 'torrent') {
        const torrentItem = { name: item.title, type: item.magnet ? 'magnet' : 'torrent', magnet: item.magnet || null, url: item.enclosureUrl || null };
        queue.push({ id: newQueueId(), type: 'torrent', name: item.title, torrentItem, status: 'pending', origin: 'rss' });
        queued++;
      }
    }
    if (queued) saveQueue(queue);

    feed.last_guids   = (parsed.items || []).slice(0, 100).map(it => it.guid || it.link || it.title).filter(Boolean);
    feed.last_fetched = new Date().toISOString();
    cfg.rss_feeds = feeds;
    saveConfig(cfg);

    if (queued && cfg.notify_on_done) {
      try { host.getHost().notify(`FLUX — ${feedName}`, `${queued} new item(s) added to queue`); } catch {}
    }
    return { ok: true, queued };
  }

  async function pollSubscription(subId) {
    const cfg = loadConfig();
    const subs = cfg.subscriptions || [];
    const sub = subs.find(s => s.id === subId);
    if (!sub) return { ok: false, error: 'subscription not found' };

    let results = [];
    try {
      // runTorrentSearch reports progress via safeSend(event.sender, ...) —
      // bus.getBroadcastSender() fans that out to the desktop window AND
      // every SSE client at once (Phase C, 2026-08-23), instead of the single
      // sink getSink() would give. Safe when nothing is registered anywhere:
      // broadcastSend() just has zero sinks to reach.
      const r = await runTorrentSearch({ sender: bus.getBroadcastSender() }, sub.query, cfg);
      results = r.results || [];
    } catch (e) {
      log('WARN', `autopoll subscription "${sub.query}": ${e.message}`);
      return { ok: false, error: e.message };
    }

    const picks = pickSubscriptionMatches(results, sub);
    const queue = loadQueue();
    for (const item of picks) {
      queue.push({ id: newQueueId(), type: 'torrent', name: item.name, torrentItem: item, status: 'pending', origin: 'subscription' });
    }
    if (picks.length) saveQueue(queue);

    const known = new Set(sub.grabbed_ids || []);
    picks.forEach(p => known.add(subscriptionResultId(p)));
    sub.grabbed_ids  = [...known].slice(-200);
    sub.last_checked = new Date().toISOString();
    cfg.subscriptions = subs;
    saveConfig(cfg);

    if (picks.length && cfg.notify_on_done) {
      try { host.getHost().notify(`FLUX — ${sub.query}`, `${picks.length} new item(s) added to queue`); } catch {}
    }
    return { ok: true, queued: picks.length };
  }

  return {
    pollFeed, pollSubscription,
    getRSSItemType, parseEpisodeTag, subscriptionResultId, pickSubscriptionMatches,
  };
}

module.exports = { createAutopoll };
