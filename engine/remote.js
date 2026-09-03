'use strict';

// engine/remote.js — the transport-agnostic command dispatcher for the
// "phone → FLUX" companion: "URL → download / free text → torrent search /
// trailer <title> / Shazam link", written once and shared by both the
// Telegram bot (engine/telegram.js) and main.js's LAN mini-server (which
// stays desktop-only — see engine/telegram.js's header comment). Extracted
// verbatim from main.js (Phase F, 2026-08-24), except ONE line: the original
// built `{ sender: mainWindow?.webContents }` (Electron-only) to route
// media/torrent progress back to the desktop window — replaced with
// `bus.getBroadcastSender()` (Phase C's engine/bus.js extension), which
// reaches the desktop window AND every server.js SSE client at once, and is
// a no-op when nothing is registered anywhere (same as the original being
// `undefined` when no window existed).
const { loadConfig } = require('./config');
const { runMediaDownloadRetry, isDrmHost, probeMedia, relatedFromSearch } = require('./queue');
const { runTorrentSearch, saveTorrentItem } = require('./torrent');
const { sendToTorrentClient } = require('./sendto');
const { appendHistory } = require('./history');
const bus = require('./bus');
const { log } = require('./log');
const enginePaths = require('./paths');
const binaryFetcher = require('../binary-fetcher');

function remoteSourceLabel(transport) {
  return transport === 'telegram' ? 'Telegram' : 'LAN';
}

// Per-sender session for multi-turn torrent result paging/selection (a bare
// number picks a result, "altri" pages). Keyed per transport+sender so two
// different phones (or Telegram + LAN) never cross-talk.
const remoteSessions      = new Map(); // key -> { query, results, page, at }
const REMOTE_SESSION_TTL  = 10 * 60 * 1000;
const RESULTS_PER_PAGE    = 5;
function getRemoteSession(key) {
  const s = remoteSessions.get(key);
  if (s && Date.now() - s.at < REMOTE_SESSION_TTL) return s;
  remoteSessions.delete(key);
  return null;
}

// Keycap emoji instead of plain "1." — renders as a real number regardless of
// transport (Telegram bubble, LAN page textContent) since it's plain unicode,
// not markup. The shared dispatcher has no notion of "Telegram formatting" vs
// "LAN formatting" by design, so any visibility fix has to work as plain text.
const RESULT_NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

// Curated subset of the Media tab's format presets — small enough to fit a
// numbered chat menu. Codes match the `format` switch in runMediaDownload.
const REMOTE_FORMAT_OPTIONS = [
  { code: 'video_1080', label: 'Video MP4 1080p' },
  { code: 'video_720',  label: 'Video MP4 720p' },
  { code: 'audio_320',  label: 'Solo audio MP3 (320k)' },
  { code: 'mkv',        label: 'Migliore qualità (MKV)' }
];

// Keyword aliases accepted as the optional 2nd argument of "/download <url> <format>",
// so a phone user can trigger a specific format in one message instead of the
// numbered-menu round trip. Maps onto the same REMOTE_FORMAT_OPTIONS codes.
const REMOTE_FORMAT_ALIASES = {
  '1080p': 'video_1080', '1080': 'video_1080',
  '720p':  'video_720',  '720':  'video_720',
  'mp3':   'audio_320',  'audio': 'audio_320', '320': 'audio_320',
  'mkv':   'mkv',        'best':  'mkv'
};

// Explicit slash commands are Telegram-idiomatic sugar over the exact same
// free-text flows below (see handleRemoteCommandInner) — kept as one hardcoded
// Italian block like every other bot reply string (see flux-mobile-companion
// memory: bot text is never per-locale, only the in-app Settings guide is).
const REMOTE_HELP_TEXT = [
  '🤖 Comandi disponibili:',
  '/download <url> [formato] — scarica un URL. Formati: 1080p, 720p, mp3, mkv. Senza formato, scegli da un menu.',
  '/torrent <titolo> — cerca un torrent.',
  '/trailer <titolo> — cerca il trailer su YouTube.',
  '/login <codice> — associa un nuovo telefono (dalla sua chat, non ancora associata).',
  '/help — mostra questo elenco.',
  '',
  'Funziona anche senza comandi: incolla un URL o un magnet, scrivi un titolo per cercarlo nei torrent, o "trailer <titolo>".'
].join('\n');

// Pushes a completed remote action to the desktop renderer (if FLUX is open)
// AND any connected server.js web UI tab (via broadcastSend, Phase C) so it
// shows up in the External Downloads tracker / desktop notification /
// History exactly like a download started from the UI — otherwise a
// phone-triggered download is invisible everywhere except the log, since it
// never goes through any renderer code path. `entry` is the same shape saved
// to History (kind, name, ok, path, error, source).
function recordRemoteHistory(entry) {
  appendHistory(entry);
  bus.broadcastSend('remote:actionDone', entry);
}

// Shown after a bare URL (no format specified yet) — either typed directly or
// via "/download <url>" without the optional format argument. Shared so the
// two entry points don't duplicate the menu-building/session-write logic.
async function remotePromptFormatMenu(url, title, sessionKey, replyFn) {
  remoteSessions.set(sessionKey, { type: 'format', url, title, at: Date.now() });
  const lines = [];
  if (title) lines.push(`🎬 ${title}`);
  lines.push(...REMOTE_FORMAT_OPTIONS.map((o, i) => `${RESULT_NUMBER_EMOJI[i] || `${i + 1}.`} ${o.label}`));
  lines.push('Rispondi con un numero per scegliere il formato e avviare il download.');
  await replyFn(lines.join('\n'));
}

// Actually runs a media download once url+format are both known — reached
// either from picking a number off remotePromptFormatMenu's menu, or directly
// from "/download <url> <format>" skipping the menu entirely.
async function remoteRunFormatDownload(url, formatCode, title, replyFn, ctx, senderEvent) {
  const cfg = loadConfig();
  if (!(await ensureRemoteBinaries(['yt-dlp', 'ffmpeg', 'ffprobe'], replyFn))) return;
  const opt = REMOTE_FORMAT_OPTIONS.find(o => o.code === formatCode);
  await replyFn(`⬇️ Avvio download (${opt ? opt.label : formatCode})...`);
  const res = await runMediaDownloadRetry(senderEvent, url, formatCode, cfg.download_folder, 2);
  // Prefer the probed title over the raw URL/path basename — yt-dlp doesn't
  // always log a parsable "Destination:" line (format/extractor dependent,
  // same limitation as the desktop Media tab), so `res.path` can be null on a
  // perfectly successful download. Falling back to the URL there would show a
  // bare link in History instead of a title.
  const displayName = title || url;
  await replyFn(res.ok ? `✅ Scaricato: ${displayName}` : `Errore download: ${res.error || 'sconosciuto'}`);
  recordRemoteHistory({ kind: 'media', name: displayName, ok: res.ok, error: res.ok ? null : res.error, path: res.path || null, source: remoteSourceLabel(ctx.transport) });
}

async function sendResultsPage(session, replyFn) {
  const start = session.page * RESULTS_PER_PAGE;
  const page  = session.results.slice(start, start + RESULTS_PER_PAGE);
  if (!page.length) { session.page = Math.max(0, session.page - 1); await replyFn('Non ci sono altri risultati.'); return; }
  const lines = page.map((r, i) => `${RESULT_NUMBER_EMOJI[i] || `${i + 1}.`} ${r.name} — ${r.seeds ?? '?'} seed, ${r.size || 'N/A'}`);
  const hasMore = start + RESULTS_PER_PAGE < session.results.length;
  lines.push(hasMore ? 'Rispondi con un numero per scaricare, o "altri" per i prossimi 5.' : 'Rispondi con un numero per scaricare.');
  await replyFn(lines.join('\n'));
}

// The desktop Media/Live/Radio tabs gate on ensureBinaries() in the renderer,
// which — when something's missing — routes the UI to a download prompt and
// aborts, since the fetch needs an on-screen confirmation. A phone has no
// FLUX screen to route to, so the Remote dispatcher fetches directly instead:
// otherwise a fresh slim install (no bundled binaries) would hard-fail every
// phone-triggered command with "yt-dlp is missing — reinstall FLUX", which is
// both wrong (nothing needs reinstalling) and a dead end for the user.
async function ensureRemoteBinaries(ids, replyFn) {
  const { vendorDir } = enginePaths.getPaths();
  const missing = ids.filter(id => !binaryFetcher.isPresent(id, vendorDir));
  if (!missing.length) return true;
  await replyFn(`⬇️ Scarico i componenti mancanti (${missing.join(', ')})... può richiedere un minuto.`);
  for (const bid of missing) {
    if (binaryFetcher.isPresent(bid, vendorDir)) continue; // e.g. the ffmpeg archive also yields ffprobe
    const r = await binaryFetcher.fetchBinary(bid, { vendorDir });
    if (!r.ok) {
      log('ERROR', `remote: binary fetch ${bid} failed: ${r.error}`);
      await replyFn(`Errore scaricando ${bid}: ${r.error}`);
      return false;
    }
  }
  return true;
}

// Shared by the magnet-link and numbered-pick branches: if the user has a
// torrent client configured (Settings → Integrations → Send to client), hand
// the magnet/URL off to it directly (useful when triggering from the phone —
// you want the download starting now, not a .torrent file waiting on the
// desktop). Falls back to the normal local save when send-to-client is off,
// not configured, or the client is unreachable.
async function remoteHandleTorrentItem(item, ctx) {
  const cfg = loadConfig();
  if (cfg.sendto_enabled) {
    const sent = await sendToTorrentClient({ magnet: item.magnet, url: item.url, name: item.name });
    if (sent.ok) {
      recordRemoteHistory({ kind: 'torrent', name: item.name, ok: true, error: null, path: null, source: `${remoteSourceLabel(ctx.transport)} → ${sent.sentTo || cfg.sendto_type}` });
      return `✅ Inviato a ${sent.sentTo || cfg.sendto_type}: ${item.name}`;
    }
  }
  const saved = await saveTorrentItem(item, cfg.download_folder);
  recordRemoteHistory({ kind: 'torrent', name: item.name, ok: saved.ok, error: saved.ok ? null : saved.error, path: saved.path || null, source: remoteSourceLabel(ctx.transport) });
  if (!saved.ok) return `Errore: ${saved.error}`;
  return cfg.sendto_enabled
    ? `⚠️ Client torrent non raggiungibile, salvato il file: ${saved.path}`
    : `✅ Salvato: ${saved.path}`;
}

// The shared dispatcher. `replyFn(text)` sends the response back on whatever
// channel the command arrived on; `ctx = { transport, sessionKey }` scopes
// the paging session. Media/torrent calls pass `bus.getBroadcastSender()` as
// their "event" so progress + results also show up live on desktop (and any
// connected server.js web UI tab) exactly like a normal in-app action.
//
// Every reachable branch below already replies, but this wrapper is the
// safety net: if anything throws unexpectedly (network hiccup, bug), the
// user on the other end MUST still get something back — with no FLUX screen
// in front of them, a silent failure is indistinguishable from "message
// never arrived", which is worse than an ugly error reply.
async function handleRemoteCommand(text, replyFn, ctx) {
  try {
    await handleRemoteCommandInner(text, replyFn, ctx);
  } catch (e) {
    log('ERROR', `remote: unhandled error in dispatcher: ${e.message}`);
    try { await replyFn(`❌ Errore imprevisto: ${e.message}`); } catch { /* reply channel itself is down — nothing more we can do */ }
  }
}

async function handleRemoteCommandInner(text, replyFn, ctx) {
  let trimmed = String(text || '').trim();
  if (!trimmed) return;
  const cfg = loadConfig();
  const senderEvent = { sender: bus.getBroadcastSender() };
  const sessionKey  = ctx.sessionKey;

  // /help (and /start, Telegram's own first-contact command) → command list.
  // Only ever reached for an already-whitelisted sender: handleTelegramUpdate
  // gates unpaired chats before calling this dispatcher at all, so this can't
  // be used to probe a stranger bot for "is anyone listening" (same
  // anti-enumeration property as every other reply here).
  if (/^\/(help|start)\b/i.test(trimmed)) { await replyFn(REMOTE_HELP_TEXT); return; }

  // /login only makes sense from a NOT-yet-paired chat, handled earlier in
  // handleTelegramUpdate (mirrors the bare-code check). Reaching it here means
  // the sender is already paired — say so instead of falling through to a
  // torrent search for the literal text "/login ...".
  if (/^\/login\b/i.test(trimmed)) { await replyFn('Questo telefono è già associato a FLUX.'); return; }

  // "/torrent <query>" and "/trailer <title>" are sugar over the free-text
  // flows below — rewrite `trimmed` into the equivalent free-text form so
  // there's exactly one implementation of each action.
  const torrentCmdMatch = trimmed.match(/^\/torrent\s+(.+)$/i);
  if (torrentCmdMatch) trimmed = torrentCmdMatch[1].trim();
  const trailerCmdMatch = trimmed.match(/^\/trailer\s+(.+)$/i);
  if (trailerCmdMatch) trimmed = `trailer ${trailerCmdMatch[1].trim()}`;

  // "/download <url> [format]" — same URL flow as pasting a bare link, but
  // skips the numbered-menu round trip when a recognized format keyword is
  // given (e.g. "/download https://... 1080p").
  const downloadCmdMatch = trimmed.match(/^\/download\s+(\S+)(?:\s+(\S+))?/i);
  if (downloadCmdMatch) {
    const url    = downloadCmdMatch[1];
    const fmtKey = downloadCmdMatch[2] ? downloadCmdMatch[2].toLowerCase() : null;
    if (!/^https?:\/\//i.test(url)) { await replyFn('/download richiede un URL valido (http/https).'); return; }
    if (isDrmHost(url)) { await replyFn('Piattaforma DRM-protetta — non supportata.'); return; }
    const formatCode = fmtKey ? REMOTE_FORMAT_ALIASES[fmtKey] : null;
    if (fmtKey && !formatCode) {
      await replyFn(`Formato "${fmtKey}" non riconosciuto. Usa: 1080p, 720p, mp3, mkv — oppure /download <url> senza formato per scegliere da un menu.`);
      return;
    }
    if (!(await ensureRemoteBinaries(['yt-dlp'], replyFn))) return;
    const probe = await probeMedia(url).catch(() => ({ ok: false }));
    const title = probe.ok && probe.title ? probe.title : null;
    if (formatCode) { await remoteRunFormatDownload(url, formatCode, title, replyFn, ctx, senderEvent); return; }
    await remotePromptFormatMenu(url, title, sessionKey, replyFn);
    return;
  }

  // "altri" → next page of the last search in this session.
  if (/^(altri|more)$/i.test(trimmed)) {
    const s = getRemoteSession(sessionKey);
    if (!s || s.type !== 'torrent') { await replyFn('Nessuna ricerca recente da continuare.'); return; }
    s.page++; s.at = Date.now();
    await sendResultsPage(s, replyFn);
    return;
  }

  // A bare number → either a format choice (pending media download) or a
  // torrent-result pick, depending on what's waiting in this session.
  if (/^\d{1,2}$/.test(trimmed)) {
    const s = getRemoteSession(sessionKey);
    const idx = parseInt(trimmed, 10) - 1;

    if (s && s.type === 'format') {
      const opt = REMOTE_FORMAT_OPTIONS[idx];
      if (!opt) { await replyFn('Numero non valido — scegli uno dei formati proposti.'); return; }
      remoteSessions.delete(sessionKey);
      await remoteRunFormatDownload(s.url, opt.code, s.title, replyFn, ctx, senderEvent);
      return;
    }

    const item = s && s.type === 'torrent' && s.results[s.page * RESULTS_PER_PAGE + idx];
    if (!item) { await replyFn('Numero non valido — rifai la ricerca.'); return; }
    await replyFn(await remoteHandleTorrentItem(item, ctx));
    return;
  }

  // Shazam share-link → resolve to "<title>" and fall through to the
  // torrent-search branch below (same handling as any free-text query).
  const shazamMatch = trimmed.match(/^https?:\/\/(www\.)?shazam\.com\/track\/\d+\/([a-z0-9-]+)/i);
  const query = shazamMatch ? shazamMatch[2].replace(/-/g, ' ') : trimmed;

  // "trailer <title>" → same ytsearch adapter as the player's Correlati panel.
  const trailerMatch = !shazamMatch && trimmed.match(/^trailer\s+(.+)$/i);
  if (trailerMatch) {
    const title = trailerMatch[1].trim();
    if (!(await ensureRemoteBinaries(['yt-dlp'], replyFn))) return;
    await replyFn(`🎬 Cerco il trailer di "${title}"...`);
    try {
      const items = await relatedFromSearch(`${title} trailer`);
      if (!items.length) { await replyFn('Nessun trailer trovato.'); return; }
      await replyFn(`🎬 ${items[0].title}\n${items[0].url}`);
    } catch (e) {
      await replyFn(`Errore ricerca trailer: ${e.message}`);
    }
    return;
  }

  // Raw magnet link.
  if (/^magnet:\?/i.test(trimmed)) {
    const item = { name: `magnet-${Date.now()}`, type: 'magnet', magnet: trimmed };
    await replyFn(await remoteHandleTorrentItem(item, ctx));
    return;
  }

  // Any other URL (not a Shazam link) → ask which format, same presets as
  // the Media tab, then download on the numbered reply.
  if (!shazamMatch && /^https?:\/\//i.test(trimmed)) {
    if (isDrmHost(trimmed)) { await replyFn('Piattaforma DRM-protetta — non supportata.'); return; }
    if (!(await ensureRemoteBinaries(['yt-dlp'], replyFn))) return;
    // Probe the title now (same call the Media tab uses for its preview) so
    // History/replies show a real title even if yt-dlp's own output later
    // doesn't yield a parsable final path (format/extractor dependent).
    const probe = await probeMedia(trimmed).catch(() => ({ ok: false }));
    const title = probe.ok && probe.title ? probe.title : null;
    await remotePromptFormatMenu(trimmed, title, sessionKey, replyFn);
    return;
  }

  // Any slash command not matched above (typo, unsupported) → point to /help
  // instead of silently running it as a torrent-search query for "/whatever".
  if (trimmed.startsWith('/')) { await replyFn('Comando non riconosciuto. Scrivi /help per la lista dei comandi.'); return; }

  // Free text (or a Shazam-resolved title) → torrent search, top-5 paginated.
  await replyFn(`🔎 Cerco torrent per "${query}"...`);
  const { results, errors } = await runTorrentSearch(senderEvent, query, cfg);
  if (!results.length) {
    await replyFn(errors.length ? `Nessun risultato (${errors[0]}).` : 'Nessun risultato.');
    return;
  }
  remoteSessions.set(sessionKey, { type: 'torrent', query, results, page: 0, at: Date.now() });
  await sendResultsPage(remoteSessions.get(sessionKey), replyFn);
}

module.exports = {
  handleRemoteCommand,
  remoteSourceLabel, recordRemoteHistory,
};
