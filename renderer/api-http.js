'use strict';

// renderer/api-http.js — the web equivalent of preload.js: builds window.api
// with the SAME shape (namespace.method(...) → Promise, namespace.onX(cb) →
// listener registration) but backed by fetch()+EventSource against
// server.js's REST+SSE API instead of Electron's contextBridge+ipcRenderer.
// Loaded by index.html IN PLACE of a direct <script src="renderer.js"> tag
// when served by server.js (Phase D, 2026-08-23) — this file is also
// responsible for loading renderer.js itself, once (a) the visitor is
// authenticated and (b) window.api exists, mirroring the ordering guarantee
// Electron gave for free via webPreferences.preload (renderer.js never runs
// before window.api is ready).
//
// Namespace coverage matches server.js's SERVER_MODULE_IDS (derived from
// modules/registry.json's `server: true` flag, Fase G — see
// design/flux-patterns.md §11): config, modules, binary, history, schedule,
// queue, torrent, media, sendto, sendnzb, rss, profiles, radio, live, irc,
// tag/mb/cover/lrc, acoustid/shazam (identify — mic-capture buffer via
// POSTBIN/G-bin, same call shape as IPC), fileops/file (rename/importUrl —
// saveDroppedBuffer still stubbed, needs a binary route), xtract/images/ai
// (Fase G, Step 3 — the ffmpeg/sharp/whisper pipelines, all Electron-free;
// capture.saveImage/saveRecording and convert.saveAnnotated/savePdfPage too,
// same step, same reasoning — see engine/xtract.js's header comment for
// what's genuinely desktop-only in that panel), shell/clipboard/notify (Fase
// G, Step 4 — real standard browser APIs, no server round-trip; only the 3
// shell.* methods that need to open a native file manager on the SERVER's
// filesystem stay honest fails, see their own comment below), a minimal
// system, and `dialog` (a real server-side file-picker modal, not a stub —
// see ensureFilePicker() below). Everything else (youtube/spotify/playlist/
// updater/subs/audio/mediaserver/library/flux, plus capture.listSources and
// convert.fromUrl/imagesToPdf — genuinely need a real Chromium window/
// desktopCapturer) is not yet exposed server-side — stubbed here as a safety
// net (warns + resolves { ok:false }, or a no-op for onX listeners) so a
// stray call never throws "cannot read property of undefined", it just does
// nothing useful.

(function () {
  // ─── SSE, multiplexed over one connection ──────────────────────────────
  // Every onX(cb) in preload.js maps to ipcRenderer.on(channel, ...); here
  // every channel is a named SSE event type on the SAME EventSource
  // connection (server.js: one bus sink per browser tab, all channels
  // fanned out over it) — opened lazily on first subscription.
  let es = null;
  const listeners = new Map(); // channel -> Set<cb>
  function ensureSSE() {
    if (es) return;
    es = new EventSource('/events');
    es.onerror = () => { /* browser auto-reconnects; nothing to do here */ };
  }
  function on(channel, cb) {
    ensureSSE();
    if (!listeners.has(channel)) {
      listeners.set(channel, new Set());
      es.addEventListener(channel, evt => {
        let data = null;
        try { data = JSON.parse(evt.data); } catch {}
        for (const fn of listeners.get(channel)) { try { fn(data); } catch (e) { console.error('[api-http] listener error', e); } }
      });
    }
    listeners.get(channel).add(cb);
  }

  // ─── fetch helpers ──────────────────────────────────────────────────────
  // Same-origin requests (this script is served BY the API's own origin), so
  // the browser attaches the flux_session cookie automatically — no manual
  // Authorization header needed.
  async function req(method, url, body) {
    const opts = { method };
    if (body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (res.status === 401) { showLoginOverlay(); throw new Error('unauthorized'); }
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok && !(data && typeof data === 'object' && 'ok' in data)) {
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    return data;
  }
  const GET = url => req('GET', url);
  const POST = (url, body) => req('POST', url, body === undefined ? {} : body);
  const PUT = (url, body) => req('PUT', url, body === undefined ? {} : body);
  const DEL = (url, body) => req('DELETE', url, body);
  function qs(params) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v != null) usp.set(k, v);
    const s = usp.toString();
    return s ? `?${s}` : '';
  }
  // POST a raw binary body (ArrayBuffer/Blob) — the browser-side half of
  // engine/wire-rest.js's `route.binary` (Fase G, Step 2). Metadata (apiKey,
  // etc.) travels in the query string since the body is bytes, not JSON —
  // server.js merges it back into one object before calling the engine
  // function, same shape an IPC call would send.
  async function POSTBIN(url, data, params) {
    const res = await fetch(url + qs(params), { method: 'POST', body: data });
    if (res.status === 401) { showLoginOverlay(); throw new Error('unauthorized'); }
    let out = null;
    try { out = await res.json(); } catch {}
    if (!res.ok && !(out && typeof out === 'object' && 'ok' in out)) {
      throw new Error((out && out.error) || `HTTP ${res.status}`);
    }
    return out;
  }

  // ─── stub for out-of-scope namespaces ───────────────────────────────────
  function stubNamespace(name) {
    return new Proxy({}, {
      get(_, prop) {
        const key = String(prop);
        if (key.startsWith('on')) return () => {}; // listener registration — safe no-op
        return (...args) => {
          console.warn(`[api-http] ${name}.${key}() — not available in server mode`);
          return Promise.resolve({ ok: false, error: 'not available in server mode' });
        };
      }
    });
  }
  const STUB_NAMESPACES = [
    'flux',
    'library', 'mediaserver', 'subs', 'audio',
    'youtube', 'spotify', 'playlist', 'updater',
  ];
  // ─── server file picker (Fase G, Step 2) ────────────────────────────────
  // A browser can't open a native OS picker on the machine running
  // server.js (an <input type=file> only sees the CLIENT's disk) — this
  // replaces it with a modal that browses the SERVER's filesystem via
  // GET /api/browse, one directory level at a time. Every dialog.* call
  // site in renderer.js is untouched: it still awaits `string|null`
  // (pickFile/pickFolder) or `string[]` (pickFiles/pickImages) exactly as
  // on desktop — only what's behind that Promise changed.
  let pickerState = null; // { mode, multi, resolve, cwd }
  function ensureFilePickerDom() {
    if (document.getElementById('flux-filepicker')) return;
    const wrap = document.createElement('div');
    wrap.id = 'flux-filepicker';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:99998;font-family:system-ui,sans-serif;';
    wrap.innerHTML = `
      <div style="background:#1c1c1e;color:#eee;width:min(640px,92vw);max-height:80vh;border-radius:10px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.5);">
        <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;align-items:center;gap:8px;">
          <button id="fp-up" style="background:#333;color:#eee;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;">↑</button>
          <div id="fp-path" style="flex:1;font-size:13px;opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></div>
        </div>
        <div id="fp-list" style="flex:1;overflow:auto;padding:6px;min-height:200px;"></div>
        <div id="fp-error" style="padding:0 16px;color:#f66;font-size:13px;display:none;"></div>
        <div style="padding:12px 16px;border-top:1px solid #333;display:flex;justify-content:flex-end;gap:8px;">
          <button id="fp-cancel" style="background:#333;color:#eee;border:none;border-radius:6px;padding:8px 14px;cursor:pointer;">Cancel</button>
          <button id="fp-select" style="background:#0a84ff;color:#fff;border:none;border-radius:6px;padding:8px 14px;cursor:pointer;">Select</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('#fp-cancel').addEventListener('click', () => closeFilePicker(pickerState?.mode === 'files' || pickerState?.mode === 'images' ? [] : null));
    wrap.querySelector('#fp-select').addEventListener('click', onPickerSelect);
    wrap.querySelector('#fp-up').addEventListener('click', () => { if (pickerState?.parent) browseTo(pickerState.parent); });
    wrap.addEventListener('click', e => { if (e.target === wrap) closeFilePicker(pickerState?.mode === 'files' || pickerState?.mode === 'images' ? [] : null); });
  }
  function closeFilePicker(result) {
    const wrap = document.getElementById('flux-filepicker');
    if (wrap) wrap.style.display = 'none';
    const resolve = pickerState?.resolve;
    pickerState = null;
    if (resolve) resolve(result);
  }
  function onPickerSelect() {
    if (!pickerState) return;
    if (pickerState.mode === 'folder') { closeFilePicker(pickerState.cwd); return; }
    const checked = [...document.querySelectorAll('#fp-list input[type=checkbox]:checked')].map(c => c.dataset.path);
    if (pickerState.mode === 'files' || pickerState.mode === 'images') closeFilePicker(checked);
    else closeFilePicker(checked[0] || null); // 'file' — single select
  }
  async function browseTo(dirPath) {
    const wrap = document.getElementById('flux-filepicker');
    const errEl = wrap.querySelector('#fp-error');
    errEl.style.display = 'none';
    let data;
    try { data = await GET(`/api/browse${qs({ path: dirPath })}`); }
    catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; return; }
    if (!data.ok) { errEl.textContent = data.error || 'Cannot open this folder'; errEl.style.display = 'block'; return; }
    pickerState.cwd = data.path;
    pickerState.parent = data.parent;
    wrap.querySelector('#fp-path').textContent = data.path;
    const list = wrap.querySelector('#fp-list');
    list.innerHTML = '';
    const rowStyle = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;';
    for (const d of data.dirs) {
      const row = document.createElement('div');
      row.style.cssText = rowStyle;
      row.innerHTML = `<span>📁</span><span>${d.name}</span>`;
      row.addEventListener('click', () => browseTo(d.path));
      row.addEventListener('mouseenter', () => row.style.background = '#2a2a2c');
      row.addEventListener('mouseleave', () => row.style.background = '');
      list.appendChild(row);
    }
    if (pickerState.mode !== 'folder') {
      const multi = pickerState.mode === 'files' || pickerState.mode === 'images';
      for (const f of data.files) {
        const row = document.createElement('div');
        row.style.cssText = rowStyle;
        row.innerHTML = multi
          ? `<input type="checkbox" data-path="${f.path.replace(/"/g, '&quot;')}"><span>📄</span><span>${f.name}</span>`
          : `<span>📄</span><span>${f.name}</span>`;
        if (!multi) row.addEventListener('click', () => closeFilePicker(f.path));
        list.appendChild(row);
      }
    }
  }
  function openPicker(mode) {
    ensureFilePickerDom();
    return new Promise(resolve => {
      pickerState = { mode, resolve, cwd: null, parent: null };
      const wrap = document.getElementById('flux-filepicker');
      wrap.style.display = 'flex';
      wrap.querySelector('#fp-select').textContent = mode === 'folder' ? 'Select this folder' : 'Select';
      browseTo(null); // null path → server.js defaults to FLUX_DOWNLOAD_DIR
    });
  }
  const DIALOG_STUB = {
    pickFolder:      () => openPicker('folder'),
    pickFile:        () => openPicker('file'),
    pickFiles:       () => openPicker('files'),
    pickImages:      () => openPicker('images'),
    pickAudioFolder: async ({ recursive = false } = {}) => {
      const folder = await openPicker('folder');
      if (!folder) return { ok: false, files: [] };
      const r = await GET(`/api/files/list${qs({ folder, recursive, exts: ['mp3','flac','m4a','aac','ogg','oga','opus','wav'] })}`);
      if (!r.ok) return { ok: false, error: r.error, files: [] };
      return { ok: true, folder, files: r.files.map(f => f.abs) };
    },
  };

  // ─── real, server-backed namespaces ─────────────────────────────────────
  const realApi = {
    config: {
      load: () => GET('/api/config'),
      save: cfg => PUT('/api/config', cfg),
      resetTOS: () => POST('/api/config/resetTOS'),
    },
    modules: {
      registry:     () => GET('/api/modules').then(r => ({ version: 1, binaries: r.binaries, modules: r.modules, serverModuleIds: r.serverModuleIds })),
      binaryStatus: () => GET('/api/modules').then(r => r.binaryStatus),
    },
    binary: {
      fetch:           id    => POST(`/api/binary/fetch/${encodeURIComponent(id)}`),
      ensureForModule: modId => POST(`/api/binary/ensureForModule/${encodeURIComponent(modId)}`),
      probeSize:       id    => GET(`/api/binary/probeSize/${encodeURIComponent(id)}`).then(r => r.size),
      onProgress:      cb    => on('binary:progress', cb),
    },
    history: {
      load:   () => GET('/api/history'),
      clear:  () => DEL('/api/history'),
      append: entry => POST('/api/history/append', entry),
      stats:  () => GET('/api/history/stats'),
    },
    schedule: {
      load: () => GET('/api/schedule'),
      save: s => PUT('/api/schedule', s),
      onPollComplete: cb => on('scheduler:pollComplete', cb),
    },
    queue: {
      load:       () => GET('/api/queue'),
      save:       q  => PUT('/api/queue', q),
      clear:      () => DEL('/api/queue'),
      run:        (q, cfg) => POST('/api/queue/run', { queue: q, config: cfg }),
      importList: text => POST('/api/queue/importList', { text }),
      checkUrl:   url  => GET(`/api/queue/checkUrl${qs({ url })}`),
      onItemStart: cb => on('queue:itemStart', cb),
      onItemDone:  cb => on('queue:itemDone', cb),
      onProgress:  cb => on('queue:progress', cb),
    },
    torrent: {
      search:         (query, cfg) => POST('/api/torrent/search', { query, config: cfg }),
      save:           payload => POST('/api/torrent/save', payload),
      onSiteProgress: cb => on('torrent:siteProgress', cb),
      onSearchPlan:   cb => on('torrent:searchPlan', cb),
      listIndexers:   payload => POST('/api/torrent/listIndexers', payload),
      detect:         () => GET('/api/torznab/detect'),
    },
    media: {
      download:         payload => POST('/api/media/download', payload),
      probe:            url     => POST('/api/media/probe', { url }),
      getStreamUrl:     url     => POST('/api/media/getStreamUrl', { url }),
      // Not implemented server-side (related-media providers + resolveStreamUrl
      // are a separate, not-yet-extracted feature — see tracking #26) — stubbed
      // individually rather than left undefined, since media.* is otherwise real.
      resolveStreamUrl: payload => { console.warn('[api-http] media.resolveStreamUrl — not available in server mode'); return Promise.resolve({ ok: false, error: 'not available in server mode' }); },
      getRelated:       payload => { console.warn('[api-http] media.getRelated — not available in server mode'); return Promise.resolve({ ok: false, error: 'not available in server mode', items: [] }); },
      stop:             payload => POST('/api/media/stop', payload),
      onProgress:       cb => on('media:progress', cb),
    },
    sendto: {
      torrent: payload => POST('/api/sendto/torrent', payload),
      test:    ()      => POST('/api/sendto/test'),
    },
    sendnzb: {
      fromFile: payload => POST('/api/sendnzb/fromFile', payload),
      test:     ()      => POST('/api/sendnzb/test'),
    },
    rss: {
      fetch:    url => GET(`/api/rss/parse${qs({ url })}`),
      discover: url => GET(`/api/rss/discover${qs({ url })}`),
    },
    profiles: {
      load:   () => GET('/api/profiles'),
      save:   (name, cfg) => POST('/api/profiles/save', { name, config: cfg }),
      delete: name => POST('/api/profiles/delete', { name }),
    },
    radio: {
      search:        params => GET(`/api/radio/search${qs(params)}`),
      countries:     () => GET('/api/radio/countries'),
      tags:          () => GET('/api/radio/tags'),
      languages:     () => GET('/api/radio/languages'),
      startIcyWatch: payload => POST('/api/radio/startIcyWatch', payload),
      stopIcyWatch:  uuid => POST('/api/radio/stopIcyWatch', { uuid }),
      onIcyMeta:     cb => on('radio:icyMeta', cb),
    },
    live: {
      record:     payload => POST('/api/live/record', payload),
      onProgress: cb => on('live:progress', cb),
    },
    irc: {
      connect:        opts => POST('/api/irc/connect', opts),
      disconnect:     () => POST('/api/irc/disconnect'),
      join:           opts => POST('/api/irc/join', opts),
      send:           opts => POST('/api/irc/send', opts),
      raw:            opts => POST('/api/irc/raw', opts),
      cancelTransfer: id => POST('/api/irc/cancelTransfer', { id }),
      onEvent:        cb => on('irc:event', cb),
    },
    tag: {
      read:    filePath => GET(`/api/tag/read${qs({ filePath })}`),
      write:   payload  => POST('/api/tag/write', payload),
      autoTag: payload  => POST('/api/tag/autoTag', payload),
    },
    mb: {
      search: q => GET(`/api/mb/search${qs(q)}`),
    },
    cover: {
      fetch: mbid => GET(`/api/cover/fetch${qs({ mbid })}`),
    },
    lrc: {
      fetch:  q       => GET(`/api/lrc/fetch${qs(q)}`),
      save:   payload => POST('/api/lrc/save', payload),
      exists: path    => GET(`/api/lrc/exists${qs({ audioPath: path })}`),
      read:   path    => GET(`/api/lrc/read${qs({ audioPath: path })}`),
    },
    acoustid: {
      identify:           payload => POST('/api/identify/acoustid', payload),
      identifyFromBuffer: payload => POSTBIN('/api/identify/acoustidBuffer', payload.buffer, { apiKey: payload.apiKey }),
      validateKey:        payload => POST('/api/identify/validateKey', payload),
      status:             () => GET('/api/identify/status'),
    },
    shazam: {
      identifyFromBuffer: payload => POSTBIN('/api/identify/shazamBuffer', payload.buffer),
    },
    fileops: {
      plan:       payload => POST('/api/fileops/plan', payload),
      run:        payload => POST('/api/fileops/run', payload),
      drives:     () => GET('/api/fileops/drives'),
      list:       payload => GET(`/api/files/list${qs(payload)}`),
      rename:     payload => POST('/api/files/rename', payload),
      onProgress: cb => on('fileops:progress', cb),
    },
    file: {
      rename:    payload => POST('/api/file/rename', payload),
      importUrl: url => POST('/api/file/importUrl', { url }),
      // Cross-app drag&drop (buffer upload) and getPathForFile are genuinely
      // client-side/desktop concepts with no REST equivalent yet — POSTBIN
      // (used below by capture.saveRecording) covers the binary-upload
      // transport gap, but there's no server-side "dropped from the OS"
      // source to receive it from here.
      saveDroppedBuffer: () => Promise.resolve({ ok: false, error: 'not available in server mode' }),
      pathForDropped:    () => null,
    },
    xtract: {
      checkFfmpeg:    () => GET('/api/xtract/checkFfmpeg'),
      probe:          payload => POST('/api/xtract/probe', payload),
      probeDuration:  input => GET(`/api/xtract/probeDuration${qs({ input })}`),
      hasAudio:       input => GET(`/api/xtract/hasAudio${qs({ input })}`),
      audio:          payload => POST('/api/xtract/audio', payload),
      convert:        payload => POST('/api/xtract/convert', payload),
      resize:         payload => POST('/api/xtract/resize', payload),
      compress:       payload => POST('/api/xtract/compress', payload),
      trim:           payload => POST('/api/xtract/trim', payload),
      subs:           payload => POST('/api/xtract/subs', payload),
      frame:          payload => POST('/api/xtract/frame', payload),
      concat:         payload => POST('/api/xtract/concat', payload),
      audiotrack:     payload => POST('/api/xtract/audiotrack', payload),
      meta:           payload => POST('/api/xtract/meta', payload),
      normalize:      payload => POST('/api/xtract/normalize', payload),
      applyPipeline:  payload => POST('/api/xtract/applyPipeline', payload),
      onProgress:     cb => on('xtract:progress', cb),
    },
    images: {
      load:            payload => POST('/api/images/load', payload),
      thumbnail:       payload => POST('/api/images/thumbnail', payload),
      rename:          payload => POST('/api/images/rename', payload),
      convert:         payload => POST('/api/images/convert', payload),
      resize:          payload => POST('/api/images/resize', payload),
      stripExif:       payload => POST('/api/images/stripExif', payload),
      autoRotate:      payload => POST('/api/images/autoRotate', payload),
      heicToJpg:       payload => POST('/api/images/heicToJpg', payload),
      crop:            payload => POST('/api/images/crop', payload),
      replaceColor:    payload => POST('/api/images/replaceColor', payload),
      removeBgColor:   payload => POST('/api/images/removeBgColor', payload),
      applyPipeline:   payload => POST('/api/images/applyPipeline', payload),
      applyEffects:    payload => POST('/api/images/applyEffects', payload),
      watermark:       payload => POST('/api/images/watermark', payload),
      compressToSize:  payload => POST('/api/images/compressToSize', payload),
      dedup:           payload => POST('/api/images/dedup', payload),
      groupSimilar:    payload => POST('/api/images/groupSimilar', payload),
      organize:        payload => POST('/api/images/organize', payload),
      organizeAuto:    payload => POST('/api/images/organizeAuto', payload),
      toVideo:         payload => POST('/api/images/toVideo', payload),
      onDedupProgress:    cb => on('images:dedupProgress', cb),
      onSimilarProgress:  cb => on('images:similarProgress', cb),
      onOrganizeProgress: cb => on('images:organizeProgress', cb),
    },
    ai: {
      transcribe: payload => POST('/api/ai/transcribe', payload),
      onProgress: cb => on('ai:progress', cb),
    },
    capture: {
      // listSources needs Electron's desktopCapturer (screen/window
      // enumeration) — no browser equivalent, stays desktop-only.
      listSources: () => { console.warn('[api-http] capture.listSources — not available in server mode'); return Promise.resolve({ ok: false, error: 'not available in server mode', sources: [] }); },
      saveImage:     payload => POST('/api/capture/saveImage', payload),
      saveRecording: payload => POSTBIN('/api/capture/saveRecording', payload.buffer, { kind: payload.kind, convert: payload.convert }),
    },
    convert: {
      // fromUrl/imagesToPdf need a real Chromium window (printToPDF/
      // capturePage) — no browser equivalent, stay desktop-only.
      fromUrl:     () => { console.warn('[api-http] convert.fromUrl — not available in server mode'); return Promise.resolve({ ok: false, error: 'not available in server mode' }); },
      imagesToPdf: () => { console.warn('[api-http] convert.imagesToPdf — not available in server mode'); return Promise.resolve({ ok: false, error: 'not available in server mode' }); },
      savePdfPage:   payload => POST('/api/convert/savePdfPage', payload),
      saveAnnotated: payload => POST('/api/convert/saveAnnotated', payload),
    },
    remote: {
      // Telegram bot only — server.js has no LAN mini-server transport (its
      // job is superseded by this very web UI), see engine/telegram.js's
      // header comment. generateLanPin/removeLanDevice fail loud instead of
      // silently no-op'ing so the Remote panel can tell the two apart.
      getStatus:           () => GET('/api/remote/status'),
      generatePairingCode: () => POST('/api/remote/generatePairingCode'),
      generateLanPin:      () => Promise.resolve({ ok: false, error: 'LAN transport not available in server mode — use this web UI instead' }),
      removeWhitelistChat: chatId => POST('/api/remote/removeWhitelistChat', { chatId }),
      removeLanDevice:     () => Promise.resolve({ ok: false, error: 'LAN transport not available in server mode' }),
      onPaired:            cb => on('remote:paired', cb),
      onActionDone:        cb => on('remote:actionDone', cb),
    },
    system: {
      // No Electron process here — 'web' lets any `platform === 'darwin'`
      // OS-specific-styling check in renderer.js fall through to the
      // non-mac default harmlessly instead of matching the wrong branch.
      platform: 'web',
      getLocale:        () => Promise.resolve(navigator.language || 'en'),
      getTheme:         () => Promise.resolve(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
      onThemeChanged:   cb => matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => cb({ dark: e.matches })),
      log:              (level, msg) => { POST('/api/log', { level, msg }).catch(() => {}); },
      getAppVersion:    () => GET('/api/health').then(r => r.version),
      checkForUpdates:  () => Promise.resolve({ ok: false, error: 'not available in server mode' }), // auto-update is a desktop-only concept
      signalReady:      () => Promise.resolve(true),
      onOpenFiles:      cb => {}, // OS "open with" file associations — desktop-only, never fires here
      relaunch:         () => location.reload(),
      onSplashAudioPref: cb => {}, // boot splash is desktop-only — web has none
    },
    // ─── shell/clipboard/notify (Fase G, Step 4) ────────────────────────────
    // Real, standard browser APIs — no server round-trip, these run entirely
    // client-side same as on desktop (Electron's shell/clipboard/Notification
    // wrap the OS; here the browser IS the "desktop" surface). Only the 3
    // shell.* methods that need to reach into the SERVER's filesystem from a
    // native OS window (open/reveal a local path in Explorer/Finder) have no
    // browser equivalent — no API lets a page open a file manager on an
    // arbitrary machine for security reasons — and stay honest fails, same
    // shape as engine/host-server.js's own no-ops for the same reason.
    shell: {
      openExternal: url => {
        try { window.open(url, '_blank', 'noopener,noreferrer'); return Promise.resolve(''); }
        catch (e) { return Promise.resolve(e.message); }
      },
      // shell.openPath's Electron contract: resolves to an empty string on
      // success, an error message on failure — callers (renderer.js) already
      // treat a truthy resolution as the error to show, so this message IS
      // the "no" answer, not an exception.
      openPath:       () => Promise.resolve('Opening a local path is not available in server mode — the file lives on the server, not this browser\'s machine.'),
      openFolder:     () => Promise.resolve('Opening a folder is not available in server mode — the folder lives on the server, not this browser\'s machine.'),
      revealInFolder: () => { console.warn('[api-http] shell.revealInFolder — not available in server mode (no browser API opens a remote file manager)'); return Promise.resolve(false); },
    },
    clipboard: {
      write: async text => {
        try { await navigator.clipboard.writeText(String(text ?? '')); return true; }
        catch (e) { console.warn('[api-http] clipboard.write failed:', e.message); return false; }
      },
    },
    notify: {
      show: async ({ title, body } = {}) => {
        try {
          if (!('Notification' in window)) return false;
          let perm = Notification.permission;
          if (perm === 'default') perm = await Notification.requestPermission();
          if (perm !== 'granted') return false;
          new Notification(String(title || 'FLUX'), { body: String(body || '') });
          return true;
        } catch (e) { console.warn('[api-http] notify.show failed:', e.message); return false; }
      },
    },
    dialog: DIALOG_STUB,
    // Real, server-side: a "path" in this deployment always means a path on
    // the machine running server.js, never the browser's — checking it here
    // is meaningful, unlike dialog/clipboard/shell above which have no
    // server equivalent at all.
    fs: {
      checkPathWritable: p => POST('/api/fs/checkPathWritable', { path: p }),
      exists:            p => GET(`/api/fs/exists${qs({ path: p })}`).then(r => r.exists),
    },
  };

  const api = { ...realApi };
  for (const name of STUB_NAMESPACES) api[name] = stubNamespace(name);
  window.api = api;

  // ─── auth gate ───────────────────────────────────────────────────────────
  // Blocks renderer.js from loading until a valid session exists. Plain DOM,
  // no dependency on FLUX's own CSS/i18n (neither is guaranteed ready yet).
  let overlayShown = false;
  function showLoginOverlay() {
    if (overlayShown) return;
    overlayShown = true;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;z-index:99999;';
    wrap.innerHTML = `
      <form style="background:#1c1c1c;padding:32px;border-radius:12px;min-width:280px;box-shadow:0 8px 32px rgba(0,0,0,.5);">
        <h1 style="font-size:18px;margin:0 0 16px;">FLUX server</h1>
        <input type="password" autofocus placeholder="Password" style="width:100%;box-sizing:border-box;padding:10px;border-radius:6px;border:1px solid #444;background:#111;color:#eee;font-size:14px;">
        <div class="err" style="color:#f66;font-size:12px;min-height:16px;margin-top:8px;"></div>
        <button type="submit" style="width:100%;margin-top:8px;padding:10px;border-radius:6px;border:none;background:#4a7dff;color:#fff;font-size:14px;cursor:pointer;">Sign in</button>
      </form>`;
    document.body.appendChild(wrap);
    const form = wrap.querySelector('form');
    const input = wrap.querySelector('input');
    const err = wrap.querySelector('.err');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      err.textContent = '';
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: input.value }),
        });
        if (!res.ok) { err.textContent = 'Wrong password'; input.value = ''; input.focus(); return; }
        wrap.remove();
        overlayShown = false;
        boot();
      } catch (e2) { err.textContent = e2.message; }
    });
  }

  // ─── bootstrap: confirm auth, then load renderer.js exactly once ────────
  let rendererLoaded = false;
  function loadRenderer() {
    if (rendererLoaded) return;
    rendererLoaded = true;
    const s = document.createElement('script');
    s.src = 'renderer.js';
    // renderer.js's own boot sequence is wrapped in
    // `window.addEventListener('DOMContentLoaded', async () => {...})` — the
    // real DOMContentLoaded already fired long before this script even
    // existed (it's injected after an async auth round-trip), so that
    // listener would otherwise NEVER run: no splash hide, no tab/menu click
    // binding, page looks "half loaded" with dead buttons. Once the script
    // has finished executing (`onload`, so the listener is guaranteed
    // attached), dispatch a synthetic DOMContentLoaded — native DOM events of
    // this type bubble (spec: bubbles=true), so a `document.dispatchEvent`
    // reaches a `window.addEventListener('DOMContentLoaded', ...)` listener
    // exactly like the real one would have.
    s.onload = () => {
      document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: false }));
    };
    document.body.appendChild(s);
  }
  async function boot() {
    try {
      await GET('/api/config'); // cheap authed probe — 401 triggers the login overlay via req()
      loadRenderer();
    } catch (e) {
      // showLoginOverlay() already ran inside req() on a 401; any other
      // error (network down, server not up yet) is worth surfacing loudly
      // since there's no renderer.js UI yet to show it in.
      if (e.message !== 'unauthorized') console.error('[api-http] boot failed:', e);
    }
  }
  boot();
})();
