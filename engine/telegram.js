'use strict';

// engine/telegram.js — the Telegram half of the "phone → FLUX" companion
// (main.js's REMOTE MODULE). Extracted verbatim from main.js (Phase F,
// 2026-08-24) so the bot can run from `server.js` too — polling
// `api.telegram.org` needs no inbound network exposure, so it works
// identically whether it's running on a desktop behind NAT or an always-on
// server, and the whole point of "trigger a download from your phone" is
// arguably stronger on a server that's actually on when the desktop isn't.
//
// The LAN mini-server transport (main.js's other half of REMOTE MODULE)
// stays desktop-only on purpose — its job (control FLUX from a phone) is
// superseded by server.js's real web UI once that's what you're running.
// Only the Telegram transport moves here.
const { httpPostJSON, fetchJSONWithUA } = require('./net');
const { loadConfig, saveConfig } = require('./config');
const bus = require('./bus');
const { log } = require('./log');
const { handleRemoteCommand } = require('./remote');

// Telegram polling state — owned here, same treatment already given to
// engine/queue.js's activeMediaProcs/isStopRequested (module-level state
// with functions as the access point, not raw exported `let`s).
let telegramPolling     = false;
let telegramPollTimer   = null;
let telegramOffset      = 0;
let telegramActiveToken = null;

// Pending pairing code — single-use, short-lived, in-memory only (never
// persisted). Typed as the first message to the bot, or via "/login <code>".
let pendingPairingCode = null; // { code, expiresAt }

function generatePairingCode() {
  pendingPairingCode = { code: String(Math.floor(100000 + Math.random() * 900000)), expiresAt: Date.now() + 10 * 60 * 1000 };
  return pendingPairingCode;
}

function telegramApiUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function telegramSendMessage(token, chatId, text) {
  try { await httpPostJSON(telegramApiUrl(token, 'sendMessage'), { chat_id: chatId, text }, { timeout: 10000 }); }
  catch (e) { log('WARN', `remote telegramSendMessage: ${e.message}`); }
}

// Populates Telegram's native "/" autocomplete menu in the client so the
// commands are discoverable without reading the in-app guide first. Harmless
// to call repeatedly (idempotent on Telegram's side) — fired once per polling
// start, i.e. on boot and whenever the token changes.
async function telegramSetMyCommands(token) {
  const commands = [
    { command: 'help',     description: 'Elenco comandi' },
    { command: 'download', description: 'Scarica un URL' },
    { command: 'torrent',  description: 'Cerca un torrent' },
    { command: 'trailer',  description: 'Cerca un trailer' },
    { command: 'login',    description: 'Associa un telefono' }
  ];
  try { await httpPostJSON(telegramApiUrl(token, 'setMyCommands'), { commands }, { timeout: 10000 }); }
  catch (e) { log('WARN', `remote telegramSetMyCommands: ${e.message}`); }
}

async function handleTelegramUpdate(token, update) {
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat && msg.chat.id;
  if (chatId == null) return;
  const cfg = loadConfig();
  const whitelisted = (cfg.remote_whitelist || []).some(w => String(w.chatId) === String(chatId));

  if (!msg.text) {
    // Non-text message (photo, sticker, voice note...). Only worth a reply
    // once paired — a stranger's non-text message stays silent like any
    // other unrecognized message (same reasoning as the block below).
    if (whitelisted) {
      await telegramSendMessage(token, chatId, 'Per ora capisco solo testo: un URL, una ricerca, "trailer <titolo>" o un link magnet.');
    }
    return;
  }
  const text = msg.text.trim();

  if (!whitelisted) {
    // Only a matching, unexpired pairing code (generated from the Remote
    // panel) whitelists a new chat. Any other message from an unrecognized
    // chat is silently dropped — no reply, so a stranger who finds the bot
    // gets no confirmation it's even listening. "/login <code>" is accepted
    // as an alias for typing the bare code, same check either way.
    const loginMatch = text.match(/^\/login\s+(\d{6})$/i);
    const code = loginMatch ? loginMatch[1] : text;
    if (pendingPairingCode && pendingPairingCode.code === code && Date.now() < pendingPairingCode.expiresAt) {
      const entry = {
        chatId,
        label: msg.chat.username ? `@${msg.chat.username}` : (msg.chat.first_name || String(chatId)),
        pairedAt: new Date().toISOString()
      };
      const updated = loadConfig();
      updated.remote_whitelist = [...(updated.remote_whitelist || []), entry];
      saveConfig(updated);
      pendingPairingCode = null;
      await telegramSendMessage(token, chatId, '✅ Telefono associato a FLUX.');
      // broadcastSend (not the old getSink()-only safeSend) so both the
      // desktop window AND any connected server.js web UI tab see the pairing
      // live (Phase C's bus.js extension — see design/flux-patterns.md §9).
      bus.broadcastSend('remote:paired', entry);
      log('INFO', `remote: Telegram chat ${chatId} paired`);
    }
    return;
  }

  await handleRemoteCommand(text, replyText => telegramSendMessage(token, chatId, replyText),
    { transport: 'telegram', sessionKey: `tg:${chatId}` });
}

function startTelegramPolling(token) {
  if (telegramPolling) return;
  telegramPolling = true;
  telegramOffset  = 0;
  telegramSetMyCommands(token);
  const tick = async () => {
    if (!telegramPolling) return;
    try {
      const url  = `${telegramApiUrl(token, 'getUpdates')}?timeout=0&offset=${telegramOffset}`;
      const data = await fetchJSONWithUA(url, 'FLUX/1.0.0', 8000);
      if (data && data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          telegramOffset = update.update_id + 1;
          try { await handleTelegramUpdate(token, update); }
          catch (e) { log('WARN', `remote: telegram update handling: ${e.message}`); }
        }
      }
    } catch (e) { /* transient network error — retried next tick */ }
    if (telegramPolling) telegramPollTimer = setTimeout(tick, 3000);
  };
  tick();
  log('INFO', 'remote: Telegram polling started');
}

function stopTelegramPolling() {
  telegramPolling = false;
  if (telegramPollTimer) { clearTimeout(telegramPollTimer); telegramPollTimer = null; }
  telegramActiveToken = null;
  log('INFO', 'remote: Telegram polling stopped');
}

// The Telegram half of main.js's syncRemoteServicesWithConfig — shared here
// so both main.js (which still orchestrates Telegram+LAN together) and
// server.js (Telegram only) start/stop/restart on a changed token with the
// SAME logic instead of two copies. Idempotent — safe to call on every
// config:save even when remote_bot_token didn't change.
function syncTelegramPolling(cfg) {
  if (cfg.remote_bot_token) {
    if (telegramActiveToken !== cfg.remote_bot_token) {
      stopTelegramPolling();
      telegramActiveToken = cfg.remote_bot_token;
      startTelegramPolling(cfg.remote_bot_token);
    }
  } else if (telegramPolling) {
    stopTelegramPolling();
  }
}

function getStatus() {
  const cfg = loadConfig();
  return {
    telegramConfigured: !!cfg.remote_bot_token,
    telegramPolling,
    whitelist: cfg.remote_whitelist || [],
  };
}

module.exports = {
  generatePairingCode,
  telegramApiUrl, telegramSendMessage, telegramSetMyCommands, handleTelegramUpdate,
  startTelegramPolling, stopTelegramPolling, syncTelegramPolling,
  getStatus,
};
