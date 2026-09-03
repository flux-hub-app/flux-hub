'use strict';

// engine/irc.js — minimal IRC client on raw TCP (SASL PLAIN, channel join/
// part, PRIVMSG, inbound DCC/XDCC file transfer) + a SOCKS5 client used both
// by IRC and by main.js's app-wide proxy setting. Extracted verbatim from
// main.js (Fase G, Step 2, 2026-08-26) — audited Electron-free: no
// dialog/shell/clipboard/notify anywhere in this domain, `socks5Connect`
// below is pure `net`/`tls`.
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const { log } = require('./log');
const { loadConfig } = require('./config');
const { safeSend } = require('./bus');

// One connection at a time, tracked globally — same shape on desktop and
// server (a single active IRC session per FLUX instance, not per browser
// tab). `sender` is whichever transport's caller passed it in (event.sender
// on IPC, bus.getBroadcastSender() on REST) — set fresh on every connect.
const ircState = {
  socket: null,
  sender: null,
  nick: '',
  buffer: '',
  joined: new Set(),
  transfers: new Map(),     // id → transfer state object
  pendingResumes: new Map() // port → { senderNick, filename, size, position, finalPath, timer }
};
// Idle timeout for a stalled DCC connection — if no bytes for this many ms
// the transfer is aborted (partial file is KEPT on disk for the next
// RESUME attempt). 700 MB at 50 KB/s would take ~4 h — but a stall at 0
// bytes/s for 30 s is almost always a dead transfer.
const DCC_IDLE_TIMEOUT_MS = 30_000;
// Fallback if the bot doesn't reply to our DCC RESUME within this window —
// some older bots / fserves don't implement RESUME and just stay silent.
// In that case we delete the partial file and start fresh.
const DCC_RESUME_TIMEOUT_MS = 5_000;

// IRC line parser. RFC1459 / RFC2812 format: ":prefix command params... :trailing"
function ircParseLine(line) {
  let prefix = null;
  let i = 0;
  if (line[0] === ':') {
    const sp = line.indexOf(' ');
    prefix = line.slice(1, sp);
    i = sp + 1;
  }
  const trailIdx = line.indexOf(' :', i);
  let mid = line.slice(i);
  let trail = null;
  if (trailIdx >= 0) {
    trail = line.slice(trailIdx + 2);
    mid   = line.slice(i, trailIdx);
  }
  const tokens = mid.split(' ').filter(Boolean);
  const command = tokens[0];
  const params  = tokens.slice(1);
  if (trail != null) params.push(trail);
  return { prefix, command, params };
}

function ircSafeFilename(name) {
  return (name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 200) || 'file';
}

// CTCP DCC dispatcher — routes to SEND / ACCEPT handlers. The shared parser
// produces a token array honouring quoted filenames with spaces.
function ircHandleDcc(senderNick, ctcp) {
  const args = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(ctcp)) !== null) args.push(m[1] || m[2]);
  if (args[0] !== 'DCC') return;
  if (args[1] === 'SEND')   return ircHandleDccSend(senderNick, args);
  if (args[1] === 'ACCEPT') return ircHandleDccAccept(senderNick, args);
  // DCC CHAT / DCC RESUME echo back / DCC TSEND etc — ignored for now.
}

// DCC SEND: "DCC SEND filename ip port size".
//   ip is the IPv4 address packed as a 32-bit unsigned decimal integer.
// Decision tree:
//   • partial file exists with size < expected  → send DCC RESUME, wait for
//     DCC ACCEPT, then continue from that position (handled in
//     ircHandleDccAccept). Falls back to fresh start after a timeout.
//   • full file already exists with same size   → skip, emit done immediately.
//   • file exists with DIFFERENT size           → treat as collision, append
//     "(2)" / "(3)" suffix and start fresh (same as before).
//   • file doesn't exist                        → fresh transfer.
function ircHandleDccSend(senderNick, args) {
  const filename = args[2];
  const ipNum = Number(args[3]);
  const port  = parseInt(args[4], 10);
  const size  = parseInt(args[5], 10) || 0;
  if (!Number.isFinite(ipNum) || !port) return;
  const ip = `${(ipNum >>> 24) & 0xff}.${(ipNum >>> 16) & 0xff}.${(ipNum >>> 8) & 0xff}.${ipNum & 0xff}`;

  const cfg = loadConfig();
  const downloadFolder = cfg.download_folder;
  try { fs.mkdirSync(downloadFolder, { recursive: true }); } catch {}
  const safeName = ircSafeFilename(filename);
  const targetPath = path.join(downloadFolder, safeName);

  // Resume path — partial file of the same name exists, smaller than expected.
  if (size > 0 && fs.existsSync(targetPath)) {
    let existingSize = 0;
    try { existingSize = fs.statSync(targetPath).size; } catch {}
    if (existingSize === size) {
      // Already complete — synthesize a done event.
      const id = `done-${Date.now()}`;
      safeSend(ircState.sender, 'irc:event', { type: 'transfer-start', id, filename: safeName, size, from: senderNick });
      safeSend(ircState.sender, 'irc:event', { type: 'transfer-done',  id, path: targetPath, received: size, alreadyHad: true });
      return;
    }
    if (existingSize > 0 && existingSize < size) {
      // Park the request and ask the bot to resume from existingSize. We
      // need ACCEPT-loop reentry, so stash everything here and proceed in
      // ircHandleDccAccept when the bot replies.
      const fallbackTimer = setTimeout(() => {
        // Bot didn't ACCEPT — restart fresh with a collision suffix so the
        // partial file isn't overwritten (user may still want it).
        const pending = ircState.pendingResumes.get(port);
        ircState.pendingResumes.delete(port);
        if (!pending) return;
        const newPath = ircCollisionPath(downloadFolder, safeName);
        ircStartDccTransfer({ senderNick, filename: safeName, ip, port, size, finalPath: newPath, resumeFrom: 0 });
      }, DCC_RESUME_TIMEOUT_MS);
      ircState.pendingResumes.set(port, {
        senderNick, filename: safeName, ip, size, position: existingSize, finalPath: targetPath, timer: fallbackTimer
      });
      // Ask the bot to resume. CTCP framing = 0x01 + payload + 0x01.
      const resumeMsg = `PRIVMSG ${senderNick} :\x01DCC RESUME ${safeName} ${port} ${existingSize}\x01\r\n`;
      try { ircState.socket.write(resumeMsg); } catch {}
      return;
    }
    // existingSize > size or === 0 → fall through to collision-suffix flow.
  }

  // Fresh transfer — or collision suffix when an unrelated file already exists.
  const finalPath = fs.existsSync(targetPath)
    ? ircCollisionPath(downloadFolder, safeName)
    : targetPath;
  ircStartDccTransfer({ senderNick, filename: safeName, ip, port, size, finalPath, resumeFrom: 0 });
}

// DCC ACCEPT: "DCC ACCEPT filename port position".
//   Confirms the bot will resume from `position`. position MAY differ from
//   what we asked (rare — usually the bot honors our value).
function ircHandleDccAccept(senderNick, args) {
  const filename = args[2];
  const port     = parseInt(args[3], 10);
  const position = parseInt(args[4], 10) || 0;
  const pending  = ircState.pendingResumes.get(port);
  if (!pending) return;        // unknown port — possibly a duplicate ACCEPT
  clearTimeout(pending.timer);
  ircState.pendingResumes.delete(port);
  ircStartDccTransfer({
    senderNick: pending.senderNick,
    filename:   pending.filename,
    ip:         pending.ip,
    port,
    size:       pending.size,
    finalPath:  pending.finalPath,
    resumeFrom: position
  });
}

// Generic collision-suffix path resolver (extracted from the SEND handler).
// Tries "name (2).ext", "name (3).ext", … up to (99).
function ircCollisionPath(folder, safeName) {
  const ext  = path.extname(safeName);
  const stem = ext ? safeName.slice(0, -ext.length) : safeName;
  let n = 2, p = path.join(folder, safeName);
  while (fs.existsSync(p) && n < 100) {
    p = path.join(folder, `${stem} (${n})${ext}`);
    n++;
  }
  return p;
}

// Open the TCP connect + writeStream for a DCC transfer, fresh OR resumed.
//   resumeFrom > 0 → opens writeStream in append mode at that offset; the
//   ACK byte count starts FROM resumeFrom so the bot keeps sending past
//   the resume point. Idle timer resets on every chunk so a 30 s gap of
//   silence aborts the transfer cleanly (partial stays on disk for retry).
function ircStartDccTransfer({ senderNick, filename, ip, port, size, finalPath, resumeFrom = 0 }) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  safeSend(ircState.sender, 'irc:event', {
    type: 'transfer-start', id, filename, size, from: senderNick,
    resumed: resumeFrom > 0, resumeFrom
  });

  const dccSocket   = net.connect(port, ip);
  const writeStream = fs.createWriteStream(finalPath, { flags: resumeFrom > 0 ? 'a' : 'w' });
  let received   = resumeFrom;
  let lastEmit   = 0;
  const startedAt = Date.now();

  const armIdleTimer = () => {
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      try { dccSocket.destroy(new Error('Idle timeout: no data received')); } catch {}
    }, DCC_IDLE_TIMEOUT_MS);
  };
  const state = {
    socket: dccSocket, writeStream, path: finalPath, size, received,
    startedAt, idleTimer: null, cancelled: false
  };
  ircState.transfers.set(id, state);
  armIdleTimer();

  dccSocket.on('data', (chunk) => {
    received += chunk.length;
    state.received = received;
    writeStream.write(chunk);
    // ACK with running byte count as 32-bit BE — required by mIRC and
    // classic ircds. The protocol field is uint32 (max 4 GiB). For files
    // past 4 GiB we SATURATE the ACK at 0xFFFFFFFF instead of wrapping
    // to zero, which keeps wait-for-ACK bots from stalling (they see
    // "client at 4 GiB" indefinitely and keep streaming; turbo-DCC bots
    // ignore mid-transfer ACKs altogether so the saturation is harmless).
    // This is what modern mIRC builds do and is the de-facto standard for
    // >4 GiB DCC transfers.
    const ack = Buffer.alloc(4);
    ack.writeUInt32BE(Math.min(received, 0xFFFFFFFF), 0);
    try { dccSocket.write(ack); } catch {}
    armIdleTimer();
    const now = Date.now();
    if (now - lastEmit > 250) {
      lastEmit = now;
      const elapsedSec = (now - startedAt) / 1000;
      const transferred = received - resumeFrom;   // bytes since this run started
      const speed = elapsedSec > 0.5 ? transferred / elapsedSec : 0;
      const remaining = Math.max(0, size - received);
      const etaSec = speed > 0 ? remaining / speed : null;
      safeSend(ircState.sender, 'irc:event', {
        type: 'transfer-progress', id, received, size, speed, etaSec
      });
    }
  });
  dccSocket.on('end', () => {
    clearTimeout(state.idleTimer);
    writeStream.end();
    ircState.transfers.delete(id);
    if (state.cancelled) return;   // cancel path already emitted
    safeSend(ircState.sender, 'irc:event', { type: 'transfer-done', id, path: finalPath, received });
  });
  dccSocket.on('error', (e) => {
    clearTimeout(state.idleTimer);
    try { writeStream.end(); } catch {}
    ircState.transfers.delete(id);
    if (state.cancelled) return;
    safeSend(ircState.sender, 'irc:event', { type: 'transfer-error', id, error: e.message, received });
  });
}

// Cancel an in-flight transfer. The socket is destroyed and the writeStream
// closed — but the partial file is INTENTIONALLY left on disk so the user
// can resume it later with a fresh XDCC request (the bot will see the
// existing partial and we'll send DCC RESUME).
function ircCancelTransfer(id) {
  const state = ircState.transfers.get(id);
  if (!state) return { ok: false, error: 'transfer not found' };
  state.cancelled = true;
  clearTimeout(state.idleTimer);
  try { state.socket.destroy(); } catch {}
  try { state.writeStream.end(); } catch {}
  ircState.transfers.delete(id);
  safeSend(ircState.sender, 'irc:event', { type: 'transfer-cancelled', id, received: state.received, path: state.path });
  return { ok: true, received: state.received, path: state.path };
}

function ircHandleLine(line) {
  if (!line) return;
  const { prefix, command, params } = ircParseLine(line);
  const senderNick = prefix ? prefix.split('!')[0] : null;
  if (command === 'PING') {
    try { ircState.socket.write(`PONG :${params[0] || ''}\r\n`); } catch {}
    return;
  }
  // ── SASL PLAIN handshake ────────────────────────────────────────────────
  // Flow:
  //   > CAP REQ :sasl     (sent at connect time when SASL is configured)
  //   < CAP * ACK :sasl   → send AUTHENTICATE PLAIN
  //   < AUTHENTICATE +    → send AUTHENTICATE <base64(user\0user\0pass)>
  //   < 903               → success → send CAP END
  //   < 902/904/905/906   → failure → log + CAP END anyway (continue unauth)
  // The state machine lives entirely in ircState.saslPending so it doesn't
  // pollute the general line handler.
  if (command === 'CAP' && params[1] === 'ACK' && /(^| )sasl( |$)/.test(params[2] || '')) {
    try { ircState.socket.write('AUTHENTICATE PLAIN\r\n'); } catch {}
    return;
  }
  if (command === 'CAP' && params[1] === 'NAK') {
    // Server refused our capability request — abort SASL and continue
    // registration without authentication.
    try { ircState.socket.write('CAP END\r\n'); } catch {}
    ircState.saslPending = false;
    safeSend(ircState.sender, 'irc:event', { type: 'sasl', ok: false, error: 'server refused SASL capability' });
    return;
  }
  if (command === 'AUTHENTICATE' && params[0] === '+') {
    const { account, password } = ircState.saslCreds || {};
    if (account && password) {
      // Format: <authzid>\0<authcid>\0<password>. We use same id for both.
      const payload = Buffer.from(`${account}\0${account}\0${password}`, 'utf8').toString('base64');
      // SASL payload may need to be split into 400-char chunks per RFC4422;
      // for typical short passwords one chunk suffices.
      try { ircState.socket.write(`AUTHENTICATE ${payload}\r\n`); } catch {}
    } else {
      try { ircState.socket.write('AUTHENTICATE *\r\n'); } catch {} // abort
    }
    return;
  }
  if (command === '903') {
    // RPL_SASLSUCCESS — finalize CAP negotiation so the server can register us.
    try { ircState.socket.write('CAP END\r\n'); } catch {}
    ircState.saslPending = false;
    safeSend(ircState.sender, 'irc:event', { type: 'sasl', ok: true });
    return;
  }
  if (command === '902' || command === '904' || command === '905' || command === '906' || command === '907') {
    // SASL failure family — proceed unauth so the user still gets connected.
    try { ircState.socket.write('CAP END\r\n'); } catch {}
    ircState.saslPending = false;
    safeSend(ircState.sender, 'irc:event', { type: 'sasl', ok: false, error: params[params.length - 1] || `SASL ${command}` });
    return;
  }
  if (command === 'JOIN') {
    if (senderNick === ircState.nick) ircState.joined.add(params[0]);
    safeSend(ircState.sender, 'irc:event', { type: 'join', from: senderNick, channel: params[0] });
    return;
  }
  if (command === 'PART') {
    safeSend(ircState.sender, 'irc:event', { type: 'part', from: senderNick, channel: params[0] });
    return;
  }
  if (command === 'QUIT') {
    safeSend(ircState.sender, 'irc:event', { type: 'quit', from: senderNick, reason: params[0] || '' });
    return;
  }
  if (command === 'NICK') {
    safeSend(ircState.sender, 'irc:event', { type: 'nick-change', from: senderNick, to: params[0] });
    return;
  }
  if (command === 'PRIVMSG') {
    const target = params[0];
    const text   = params[1] || '';
    if (text.charCodeAt(0) === 1) {
      // CTCP — strip the framing 0x01 bytes.
      const ctcp = text.replace(/\x01/g, '');
      if (ctcp.startsWith('DCC ')) { ircHandleDcc(senderNick, ctcp); return; }
      safeSend(ircState.sender, 'irc:event', { type: 'ctcp', from: senderNick, target, text: ctcp });
      return;
    }
    safeSend(ircState.sender, 'irc:event', { type: 'message', from: senderNick, target, text });
    return;
  }
  if (command === 'NOTICE') {
    safeSend(ircState.sender, 'irc:event', { type: 'notice', from: senderNick, target: params[0], text: params[1] || '' });
    return;
  }
  if (/^\d{3}$/.test(command)) {
    safeSend(ircState.sender, 'irc:event', { type: 'numeric', code: command, params, text: params.slice(-1)[0] });
    return;
  }
  safeSend(ircState.sender, 'irc:event', { type: 'raw', command, params });
}

// ── SOCKS5 client ────────────────────────────────────────────────────────────
// Minimal SOCKS5 connector for IRC traffic (also reused by main.js's
// app-wide proxy setting — the socket-tunneling logic is identical, only
// what wraps it differs). Supports no-auth (0x00) and username/password
// auth (0x02). Returns a fully-tunneled net.Socket that behaves
// transparently after the handshake completes.
function socks5Connect({ proxyHost, proxyPort, proxyUser, proxyPass, destHost, destPort }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, proxyHost);
    let stage = 'greet';   // greet → (auth) → connect → tunnel
    const fail = (msg) => { try { sock.destroy(); } catch {} reject(new Error(`SOCKS5: ${msg}`)); };

    sock.once('connect', () => {
      // Advertise both auth methods we support: 0x00 (no auth) and 0x02 (user/pass)
      sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
    });
    sock.on('error', reject);

    // The buffer may straddle SOCKS replies and IRC welcome bytes — accumulate
    // until we have a complete SOCKS reply, then hand the residual to the IRC
    // stream via socket.unshift().
    let buf = Buffer.alloc(0);
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      try {
        while (true) {
          if (stage === 'greet') {
            if (buf.length < 2) return;
            if (buf[0] !== 0x05) return fail('bad greeting reply');
            const method = buf[1];
            buf = buf.slice(2);
            if (method === 0xff) return fail('no acceptable auth method');
            if (method === 0x02) {
              const u = Buffer.from(proxyUser || '', 'utf8');
              const p = Buffer.from(proxyPass || '', 'utf8');
              sock.write(Buffer.concat([
                Buffer.from([0x01, u.length]), u,
                Buffer.from([p.length]), p
              ]));
              stage = 'auth';
            } else {
              sendConnect();
              stage = 'connect';
            }
            continue;
          }
          if (stage === 'auth') {
            if (buf.length < 2) return;
            if (buf[1] !== 0x00) return fail('auth failed');
            buf = buf.slice(2);
            sendConnect();
            stage = 'connect';
            continue;
          }
          if (stage === 'connect') {
            if (buf.length < 5) return;
            if (buf[0] !== 0x05) return fail('bad connect reply');
            if (buf[1] !== 0x00) return fail(`connect rejected (rep=${buf[1]})`);
            const atyp = buf[3];
            let replyLen;
            if (atyp === 0x01)      replyLen = 4 + 4 + 2;          // IPv4
            else if (atyp === 0x03) replyLen = 4 + 1 + buf[4] + 2; // domain
            else if (atyp === 0x04) replyLen = 4 + 16 + 2;         // IPv6
            else return fail(`unknown atyp ${atyp}`);
            if (buf.length < replyLen) return;
            const residual = buf.slice(replyLen);
            buf = Buffer.alloc(0);
            stage = 'tunnel';
            // Detach our data handler — the socket is now transparent.
            sock.removeAllListeners('data');
            sock.removeAllListeners('error');
            // Re-emit any post-reply bytes back into the stream so the next
            // consumer (TLS handshake or IRC parser) gets them.
            if (residual.length) sock.unshift(residual);
            return resolve(sock);
          }
        }
      } catch (e) { fail(e.message); }
    });

    function sendConnect() {
      const host = Buffer.from(destHost, 'utf8');
      sock.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
        host,
        Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff])
      ]));
    }
  });
}

// Wrap an existing socket (plain or SOCKS-tunneled) with TLS. We pass
// rejectUnauthorized:false because many IRC networks ship self-signed certs
// — strict verification would block users on the most common setups.
function wrapWithTls(socket, servername) {
  return tls.connect({ socket, servername, rejectUnauthorized: false });
}

// Open the IRC transport: plain TCP, TLS, or either of those over SOCKS5,
// depending on user config. Returns a connected socket ready for write().
async function openIrcTransport({ server, port, useTls }) {
  const cfg = loadConfig();
  let raw;
  if (cfg.socks_enabled && cfg.socks_host) {
    raw = await socks5Connect({
      proxyHost: cfg.socks_host,
      proxyPort: cfg.socks_port || 1080,
      proxyUser: cfg.socks_user || '',
      proxyPass: cfg.socks_pass || '',
      destHost: server,
      destPort: port
    });
  } else {
    raw = await new Promise((resolve, reject) => {
      const s = net.connect(port, server);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
  }
  return useTls ? wrapWithTls(raw, server) : raw;
}

async function ircConnect(opts = {}, sender) {
  if (ircState.socket) { try { ircState.socket.destroy(); } catch {} }
  const cfg = loadConfig();
  const { server, port = 6667, nick = 'FluxUser', tls: useTls = false } = opts;
  if (!server) return { ok: false, error: 'server required' };
  ircState.sender = sender;
  ircState.nick   = nick;
  ircState.buffer = '';
  ircState.joined.clear();
  // SASL creds — pulled from config (the renderer never sends them over the
  // wire so they don't transit through the request payload). Both the
  // explicit enable flag AND populated credentials are required to actually
  // attempt SASL — otherwise we silently skip it.
  const saslAccount  = (cfg.irc_sasl_account || '').trim();
  const saslPassword = cfg.irc_sasl_password || '';
  const useSasl = !!(cfg.irc_sasl_enabled && saslAccount && saslPassword);
  ircState.saslCreds   = useSasl ? { account: saslAccount, password: saslPassword } : null;
  ircState.saslPending = useSasl;

  let socket;
  try {
    socket = await openIrcTransport({ server, port, useTls });
  } catch (e) {
    return { ok: false, error: `transport: ${e.message}` };
  }
  ircState.socket = socket;

  return new Promise((resolve) => {
    let resolved = false;
    // SASL must be requested BEFORE NICK/USER so the server holds back 001
    // until CAP END is received. Issue CAP REQ :sasl first when configured.
    if (useSasl) {
      try { socket.write('CAP REQ :sasl\r\n'); } catch {}
    }
    try { socket.write(`NICK ${nick}\r\nUSER ${nick} 0 * :${nick}\r\n`); } catch {}

    socket.on('data', d => {
      ircState.buffer += d.toString('utf8');
      const lines = ircState.buffer.split(/\r\n|\r|\n/);
      ircState.buffer = lines.pop();
      for (const line of lines) ircHandleLine(line);
      if (!resolved && /\s001\s/.test(d.toString('utf8'))) {
        resolved = true;
        safeSend(ircState.sender, 'irc:event', { type: 'connected', nick, server, tls: useTls });
        resolve({ ok: true });
      }
    });
    socket.on('error', (e) => {
      if (!resolved) { resolved = true; resolve({ ok: false, error: e.message }); }
      safeSend(ircState.sender, 'irc:event', { type: 'error', error: e.message });
    });
    socket.on('close', () => {
      ircState.socket = null;
      safeSend(ircState.sender, 'irc:event', { type: 'disconnected' });
    });
    setTimeout(() => {
      if (!resolved) { resolved = true; resolve({ ok: true, warn: 'no welcome reply within 15s' }); }
    }, 15000);
  });
}

function ircDisconnect() {
  if (ircState.socket) {
    try { ircState.socket.write('QUIT :FLUX\r\n'); } catch {}
    try { ircState.socket.destroy(); } catch {}
    ircState.socket = null;
  }
  for (const tr of ircState.transfers.values()) {
    try { tr.socket.destroy(); } catch {}
    try { tr.writeStream.end(); } catch {}
  }
  ircState.transfers.clear();
  return { ok: true };
}

function ircJoin({ channel } = {}) {
  if (!ircState.socket || !channel) return { ok: false, error: 'not connected' };
  try { ircState.socket.write(`JOIN ${channel}\r\n`); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

function ircSend({ target, message } = {}) {
  if (!ircState.socket || !target || !message) return { ok: false, error: 'not connected or empty payload' };
  try { ircState.socket.write(`PRIVMSG ${target} :${message}\r\n`); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

// Raw IRC command — escape hatch for LIST / NAMES / WHOIS / QUOTE etc. that
// don't fit the PRIVMSG mold. The caller composes the full IRC line
// (without trailing CRLF) and this appends it.
function ircRaw({ line } = {}) {
  if (!ircState.socket || !line) return { ok: false, error: 'not connected or empty line' };
  try { ircState.socket.write(`${line}\r\n`); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

module.exports = {
  ircConnect, ircDisconnect, ircJoin, ircSend, ircRaw, ircCancelTransfer,
  socks5Connect, wrapWithTls, openIrcTransport,
  routes: [
    { channel: 'irc:connect',        method: 'POST', path: '/api/irc/connect',
      fn: 'ircConnect', args: (body, sender) => [body, sender] },
    { channel: 'irc:disconnect',     method: 'POST', path: '/api/irc/disconnect',
      fn: 'ircDisconnect', args: () => [] },
    { channel: 'irc:join',           method: 'POST', path: '/api/irc/join',
      fn: 'ircJoin', args: body => [body] },
    { channel: 'irc:send',           method: 'POST', path: '/api/irc/send',
      fn: 'ircSend', args: body => [body] },
    { channel: 'irc:raw',            method: 'POST', path: '/api/irc/raw',
      fn: 'ircRaw', args: body => [body] },
    { channel: 'irc:cancelTransfer', method: 'POST', path: '/api/irc/cancelTransfer',
      fn: 'ircCancelTransfer', args: body => [body.id] },
  ],
};
