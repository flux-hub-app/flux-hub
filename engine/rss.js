'use strict';

// engine/rss.js — RSS/Atom feed discovery + parsing for the RSS tab and
// scheduler auto-poll (engine/autopoll.js). Extracted verbatim from main.js
// (Phase C, 2026-08-23).
//
// `decodeEntities` is also used by main.js's still-resident parseTorznabXML
// (torrent search result parsing, not this module's concern) — exported here
// and required back into main.js rather than duplicated. Once torrent search
// itself moves to engine/torrent.js (next extraction step), that module will
// require it from here directly and main.js's own reference goes away.
const { fetchTextSimple, describeNetError } = require('./net');
const { log } = require('./log');

// Verify a candidate URL by fetching its first chunk and checking it parses
// as an XML feed (RSS 2.0 or Atom). Used by rss:discover both for the user's
// URL (in case it's already a feed) and for fallback candidates.
async function probeIsFeed(url) {
  try {
    const body = await fetchTextSimple(url);
    return /^(<\?xml\b|<rss\b|<feed\b)/i.test(body.slice(0, 1024).trim());
  } catch { return false; }
}

// Resolve any YouTube URL (channel, @handle, playlist, /user/, /c/, short
// youtu.be) to its public feeds.videos.xml Atom feed. Returns null when the
// URL is not a YouTube address, letting the caller continue with the
// generic HTML autodiscovery path.
async function tryResolveYouTubeFeed(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtu.be') return null;
  const FEED_BASE = 'https://www.youtube.com/feeds/videos.xml';

  // Direct id captures — no fetch needed for /channel/UC... or /playlist?list=PL...
  const channelMatch = u.pathname.match(/^\/channel\/(UC[\w-]{20,})/i);
  if (channelMatch) {
    return { ok: true, feedUrl: `${FEED_BASE}?channel_id=${channelMatch[1]}`, source: 'youtube-channel' };
  }
  if (u.pathname === '/playlist' && u.searchParams.get('list')) {
    return { ok: true, feedUrl: `${FEED_BASE}?playlist_id=${u.searchParams.get('list')}`, source: 'youtube-playlist' };
  }
  // Single-video URL with a list= query param → subscribe to that playlist
  // (more useful than not subscribing at all).
  if (u.pathname === '/watch' && u.searchParams.get('list')) {
    return { ok: true, feedUrl: `${FEED_BASE}?playlist_id=${u.searchParams.get('list')}`, source: 'youtube-playlist' };
  }

  // Handle-style URLs: /@handle, /user/X, /c/X, youtu.be/@handle. These need
  // a page fetch — YT embeds the canonical channel ID as <meta itemprop=
  // "identifier"> or in the channelId microdata. We grep both because YT
  // shuffles its HTML structure regularly.
  const handlePath = /^\/(@[\w.-]+|user\/[\w.-]+|c\/[\w.-]+)$/i.test(u.pathname) ||
                     (host === 'youtu.be' && /^\/@[\w.-]+$/i.test(u.pathname));
  if (handlePath) {
    try {
      const html = await fetchTextSimple(u.href);
      const id = html.match(/"channelId"\s*:\s*"(UC[\w-]{20,})"/)?.[1] ||
                 html.match(/<meta\s+itemprop=["']identifier["']\s+content=["'](UC[\w-]{20,})["']/)?.[1] ||
                 html.match(/channel\/(UC[\w-]{20,})/)?.[1];
      if (id) {
        return { ok: true, feedUrl: `${FEED_BASE}?channel_id=${id}`, source: 'youtube-handle' };
      }
    } catch (e) {
      log('WARN', `youtube handle resolve failed for ${rawUrl}: ${e.message}`);
    }
  }
  // Catch-all: any youtube.com URL we couldn't parse — let the generic path
  // try, but don't return false success.
  return null;
}

function parseFeed(xml) {
  // Detect feed type — RSS 2.0 vs Atom
  const isAtom = /<feed[\s>][^>]*xmlns=["']?http:\/\/www\.w3\.org\/2005\/Atom/i.test(xml) || /<entry[\s>]/.test(xml);
  if (isAtom) return parseAtom(xml);
  return parseRSS(xml);
}

// Robust tag extraction with CDATA + nested support
function tag(block, name, attrFilter = null) {
  // Find <name ...>content</name> or <name ... /> (self-closing)
  const re = new RegExp(`<${name}(?:\\s+[^>]*?)?(?:\\s*/>|>([\\s\\S]*?)<\\/${name}\\s*>)`, 'i');
  const m = block.match(re);
  if (!m) return '';
  const content = (m[1] || '').trim();
  // Unwrap CDATA if present
  const cdata = content.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return cdata ? cdata[1].trim() : content;
}

function attr(block, tagName, attrName) {
  const re = new RegExp(`<${tagName}[^>]*?\\s${attrName}=["']([^"']+)["'][^>]*>`, 'i');
  const m = block.match(re);
  return m ? m[1] : null;
}

function stripHtml(s) { return String(s || '').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').trim(); }
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&apos;/g,"'");
}

function parseRSS(xml) {
  const channelMatch = xml.match(/<channel[\s>]([\s\S]*?)<\/channel>/i);
  const channel = channelMatch ? channelMatch[1] : xml;

  const meta = {
    title:       decodeEntities(stripHtml(tag(channel, 'title'))),
    description: decodeEntities(stripHtml(tag(channel, 'description'))),
    link:        tag(channel, 'link'),
  };

  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  for (const block of blocks.slice(0, 100)) {
    const title = decodeEntities(stripHtml(tag(block, 'title')));
    if (!title) continue;

    // pubDate or dc:date
    const pubDate = tag(block, 'pubDate') || tag(block, 'dc:date') || tag(block, 'date');

    // Enclosure (most reliable for podcasts/media)
    const enclosureUrl  = attr(block, 'enclosure', 'url');
    const enclosureType = attr(block, 'enclosure', 'type');
    const enclosureLen  = attr(block, 'enclosure', 'length');

    // Magnet link can be in many fields
    const magnetMatch = block.match(/magnet:\?xt=urn:btih:[^<"\s'&]+/i);
    const magnet = magnetMatch ? decodeEntities(magnetMatch[0]) : null;

    // Description / content:encoded / iTunes:summary
    const descRaw = tag(block, 'content:encoded') || tag(block, 'description') || tag(block, 'itunes:summary') || tag(block, 'summary');
    const description = decodeEntities(stripHtml(descRaw)).substring(0, 400);

    const link    = tag(block, 'link');
    const author  = decodeEntities(stripHtml(tag(block, 'dc:creator') || tag(block, 'author') || tag(block, 'itunes:author')));
    const guid    = tag(block, 'guid');
    const duration= tag(block, 'itunes:duration');
    const image   = attr(block, 'itunes:image', 'href') || attr(block, 'media:thumbnail', 'url') || attr(block, 'media:content', 'url');

    items.push({
      title, description, pubDate, link, author, guid, duration, image,
      enclosureUrl, enclosureType, enclosureLen, magnet
    });
  }
  return { meta, items };
}

function parseAtom(xml) {
  const meta = {
    title:       decodeEntities(stripHtml(tag(xml, 'title'))),
    description: decodeEntities(stripHtml(tag(xml, 'subtitle') || tag(xml, 'summary'))),
    link:        attr(xml, 'link', 'href'),
  };

  const items = [];
  const blocks = xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];
  for (const block of blocks.slice(0, 100)) {
    const title = decodeEntities(stripHtml(tag(block, 'title')));
    if (!title) continue;

    // Atom uses <link href="..." rel="..."> — prefer enclosure rel
    const linkBlocks = [...block.matchAll(/<link\s+([^/>]+)\s*\/?>/g)];
    let link = null, enclosureUrl = null, enclosureType = null;
    for (const lb of linkBlocks) {
      const attrs = lb[1];
      const href  = (attrs.match(/href=["']([^"']+)["']/) || [])[1];
      const rel   = (attrs.match(/rel=["']([^"']+)["']/)  || [])[1];
      const type  = (attrs.match(/type=["']([^"']+)["']/) || [])[1];
      if (rel === 'enclosure') { enclosureUrl = href; enclosureType = type || null; }
      else if (!link)          link = href;
    }

    const magnetMatch = block.match(/magnet:\?xt=urn:btih:[^<"\s'&]+/i);
    const magnet      = magnetMatch ? decodeEntities(magnetMatch[0]) : null;

    const descRaw     = tag(block, 'content') || tag(block, 'summary');
    const description = decodeEntities(stripHtml(descRaw)).substring(0, 400);

    const pubDate = tag(block, 'updated') || tag(block, 'published');
    const author  = decodeEntities(stripHtml(tag(block, 'name')));
    const guid    = tag(block, 'id');

    items.push({
      title, description, pubDate, link, author, guid,
      enclosureUrl, enclosureType, enclosureLen: null, magnet,
      duration: null, image: null
    });
  }
  return { meta, items };
}

// Discover an RSS/Atom feed URL from a podcast/article page. Strategy:
//   1. If the URL itself returns XML → it's already a feed
//   2. Scan the HTML <head> for <link rel="alternate" type="application/rss+xml">
//   3. Scan for inline .xml/.rss/feed references in href attributes
//   4. Try common conventional paths under the site root: /feed, /rss, /feed.xml…
// Returns the first candidate that probes as a real feed. Moved here (from
// main.js's rss:discover IPC handler) so server.js's REST endpoint can share
// the same logic instead of duplicating it (Phase C, 2026-08-23).
// Fetch + parse a feed by URL — the rss:fetch IPC channel / GET /api/rss/parse
// REST route both did this inline (fetchTextSimple + parseFeed + a
// describeNetError-wrapped catch), verbatim duplicated in main.js and
// server.js. Consolidated here so both transports share one implementation
// via the routes[] registry below instead of two copies drifting apart.
async function fetchFeed(url) {
  try {
    const xml = await fetchTextSimple(url, 20000);
    return { ok: true, ...parseFeed(xml) };
  } catch (e) { return { ok: false, error: describeNetError(e) }; }
}

async function discoverFeed(pageUrl) {
  if (!pageUrl) return { ok: false, error: 'No URL provided' };
  try { return await discoverFeedInner(pageUrl); }
  catch (e) { return { ok: false, error: describeNetError(e) }; }
}

// Same duplication as fetchFeed above: both callers wrapped discoverFeed()
// in an identical try/catch externally — moved inside discoverFeed() itself
// (renamed to discoverFeedInner) so it never throws, one implementation.
async function discoverFeedInner(pageUrl) {
  // ── YouTube channel/playlist short-circuit ──────────────────────────────
  // YT exposes public Atom feeds for any channel/playlist at
  //   feeds/videos.xml?channel_id=UC...
  //   feeds/videos.xml?playlist_id=PL...
  // We resolve common URL shapes (UC.../channel/UC..., @handle, /user/X,
  // /playlist?list=PL..., short youtu.be/@X) before falling through to the
  // generic HTML autodiscovery below.
  const yt = await tryResolveYouTubeFeed(pageUrl);
  if (yt) return yt;

  const html = await fetchTextSimple(pageUrl);
  const head = html.slice(0, 1024).trim();
  if (/^(<\?xml\b|<rss\b|<feed\b)/i.test(head)) {
    return { ok: true, feedUrl: pageUrl, source: 'direct' };
  }
  const base = new URL(pageUrl);

  // 2) <link rel="alternate" type="application/(rss|atom)+xml">
  const candidates = new Set();
  const reA = /<link[^>]*type=["']?application\/(?:rss|atom)\+xml["']?[^>]*href=["']?([^"'\s>]+)["']?[^>]*>/gi;
  const reB = /<link[^>]*href=["']?([^"'\s>]+)["']?[^>]*type=["']?application\/(?:rss|atom)\+xml["']?[^>]*>/gi;
  let m;
  while ((m = reA.exec(html))) try { candidates.add(new URL(m[1], base).href); } catch {}
  while ((m = reB.exec(html))) try { candidates.add(new URL(m[1], base).href); } catch {}

  // 3) Scan for inline references to .xml/.rss/feed in href/src attributes
  //    (some sites declare the feed only inside the body, not the head).
  const reInline = /href=["']([^"'\s>]+(?:\/feed\/?|\.rss|\.xml|\/rss\/?)(?:\?[^"'\s>]*)?)["']/gi;
  while ((m = reInline.exec(html))) try { candidates.add(new URL(m[1], base).href); } catch {}

  // 4) Common conventional paths at the site root.
  const root = `${base.protocol}//${base.host}`;
  for (const p of ['/feed', '/feed/', '/rss', '/rss.xml', '/feed.xml', '/feed.rss', '/atom.xml']) {
    candidates.add(root + p);
  }

  // Probe candidates in order; return the first that actually serves a feed.
  for (const cand of candidates) {
    if (await probeIsFeed(cand)) {
      return { ok: true, feedUrl: cand, allFeeds: [...candidates], source: 'probed' };
    }
  }
  return {
    ok: false,
    error: 'No RSS/Atom feed could be resolved from this URL. The page may not expose one — paste the direct .xml/.rss feed URL instead.',
    tried: [...candidates]
  };
}

module.exports = {
  probeIsFeed, tryResolveYouTubeFeed, parseFeed, decodeEntities, discoverFeed, fetchFeed,
  routes: [
    { channel: 'rss:fetch',    method: 'GET', path: '/api/rss/parse',    fn: 'fetchFeed',    args: body => [body.url] },
    { channel: 'rss:discover', method: 'GET', path: '/api/rss/discover', fn: 'discoverFeed', args: body => [body.url] },
  ],
};
