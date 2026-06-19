'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// NB: under contextIsolation, listeners/wrappers installed here run in the
// isolated world and DO NOT see errors/console calls from renderer.js (main
// world). Console capture is delegated to main.js via:
//   * webContents.on('console-message') — automatic capture from main world
//   * window.api.system.log(level, msg) — explicit calls from renderer.js
//     for uncaught errors and unhandled rejections.

contextBridge.exposeInMainWorld('api', {
  config: {
    load:     ()    => ipcRenderer.invoke('config:load'),
    save:     cfg   => ipcRenderer.invoke('config:save', cfg),
    resetTOS: ()    => ipcRenderer.invoke('config:resetTOS')
  },
  modules: {
    registry:     ()  => ipcRenderer.invoke('modules:registry'),
    binaryStatus: ()  => ipcRenderer.invoke('modules:binaryStatus')
  },
  binary: {
    // Phase 2b lazy fetch. fetch(id) downloads one binary; ensureForModule(id)
    // downloads every missing binary a module needs. Progress arrives on the
    // shared 'binary:progress' channel: { id, phase, pct?, moduleId? }.
    fetch:           id    => ipcRenderer.invoke('binary:fetch', id),
    ensureForModule: modId => ipcRenderer.invoke('binary:ensureForModule', modId),
    probeSize:       id    => ipcRenderer.invoke('binary:probeSize', id),
    onProgress:      cb    => ipcRenderer.on('binary:progress', (_, d) => cb(d))
  },
  profiles: {
    load:   ()          => ipcRenderer.invoke('profiles:load'),
    save:   (name, cfg) => ipcRenderer.invoke('profiles:save', name, cfg),
    delete: name        => ipcRenderer.invoke('profiles:delete', name)
  },
  flux: {
    export: (cfg, mode) => ipcRenderer.invoke('flux:export', cfg, mode),
    import: ()  => ipcRenderer.invoke('flux:import')
  },
  dialog: {
    pickFolder:      ()       => ipcRenderer.invoke('dialog:pickFolder'),
    pickFile:        opts     => ipcRenderer.invoke('dialog:pickFile', opts || {}),
    pickFiles:       ()       => ipcRenderer.invoke('dialog:pickFiles'),
    pickImages:      ()       => ipcRenderer.invoke('dialog:pickImages'),
    pickAudioFolder: opts     => ipcRenderer.invoke('dialog:pickAudioFolder', opts || {})
  },
  file: {
    rename: payload => ipcRenderer.invoke('file:rename', payload),
    // Electron 32+ deprecated File.path; webUtils.getPathForFile is the
    // supported replacement for getting the OS path from a drag-dropped
    // File handle. Exposed here so the renderer can call it without a
    // direct dependency on electron in the browser context.
    pathForDropped: file => { try { return webUtils.getPathForFile(file); } catch { return null; } }
  },
  shell: {
    openFolder:      p => ipcRenderer.invoke('shell:openFolder',     p),
    openExternal:    u => ipcRenderer.invoke('shell:openExternal',   u),
    openPath:        p => ipcRenderer.invoke('shell:openPath',       p),
    revealInFolder:  p => ipcRenderer.invoke('shell:revealInFolder', p)
  },
  fs: {
    checkPathWritable: p => ipcRenderer.invoke('app:checkPathWritable', p),
    exists:            p => ipcRenderer.invoke('fs:exists', p)
  },
  clipboard: {
    write: text => ipcRenderer.invoke('clipboard:write', text)
  },
  notify: {
    show: ({ title, body }) => ipcRenderer.invoke('notify:show', { title, body })
  },
  history: {
    load:   ()    => ipcRenderer.invoke('history:load'),
    clear:  ()    => ipcRenderer.invoke('history:clear'),
    append: entry => ipcRenderer.invoke('history:append', entry),
    stats:  ()    => ipcRenderer.invoke('history:stats')
  },
  library: {
    organize: payload => ipcRenderer.invoke('library:organize', payload)
  },
  fileops: {
    plan:       payload => ipcRenderer.invoke('fileops:plan', payload),
    run:        payload => ipcRenderer.invoke('fileops:run', payload),
    drives:     ()      => ipcRenderer.invoke('fileops:drives'),
    list:       payload => ipcRenderer.invoke('files:list', payload),
    rename:     payload => ipcRenderer.invoke('files:rename', payload),
    onProgress: cb      => ipcRenderer.on('fileops:progress', (_, d) => cb(d))
  },
  mediaserver: {
    notify: payload => ipcRenderer.invoke('mediaserver:notify', payload),
    test:   payload => ipcRenderer.invoke('mediaserver:test',   payload)
  },
  sendto: {
    torrent: payload => ipcRenderer.invoke('sendto:torrent', payload),
    test:    ()      => ipcRenderer.invoke('sendto:test')
  },
  sendnzb: {
    fromFile: payload => ipcRenderer.invoke('sendnzb:fromFile', payload),
    test:     ()      => ipcRenderer.invoke('sendnzb:test')
  },
  subs: {
    hash:     payload => ipcRenderer.invoke('subs:hash',     payload),
    search:   payload => ipcRenderer.invoke('subs:search',   payload),
    download: payload => ipcRenderer.invoke('subs:download', payload)
  },
  audio: {
    dedup:          payload => ipcRenderer.invoke('audio:dedup', payload),
    dedupByName:    payload => ipcRenderer.invoke('audio:dedupByName', payload),
    trashFiles:     payload => ipcRenderer.invoke('audio:trashFiles', payload),
    detectTracks:   payload => ipcRenderer.invoke('audio:detectTracks', payload),
    splitTracks:    payload => ipcRenderer.invoke('audio:splitTracks', payload),
    onDedupProgress: cb => ipcRenderer.on('audio:dedupProgress', (_, data) => cb(data))
  },
  images: {
    load:        payload => ipcRenderer.invoke('images:load',        payload),
    thumbnail:   payload => ipcRenderer.invoke('images:thumbnail',   payload),
    rename:      payload => ipcRenderer.invoke('images:rename',      payload),
    convert:     payload => ipcRenderer.invoke('images:convert',     payload),
    resize:      payload => ipcRenderer.invoke('images:resize',      payload),
    stripExif:   payload => ipcRenderer.invoke('images:stripExif',   payload),
    autoRotate:  payload => ipcRenderer.invoke('images:autoRotate',  payload),
    heicToJpg:   payload => ipcRenderer.invoke('images:heicToJpg',   payload),
    crop:           payload => ipcRenderer.invoke('images:crop',         payload),
    replaceColor:   payload => ipcRenderer.invoke('images:replaceColor', payload),
    applyEffects:   payload => ipcRenderer.invoke('images:applyEffects', payload),
    watermark:      payload => ipcRenderer.invoke('images:watermark',    payload),
    compressToSize: payload => ipcRenderer.invoke('images:compressToSize', payload),
    dedup:          payload => ipcRenderer.invoke('images:dedup',        payload),
    groupSimilar:   payload => ipcRenderer.invoke('images:groupSimilar', payload),
    organize:       payload => ipcRenderer.invoke('images:organize',     payload),
    organizeAuto:   payload => ipcRenderer.invoke('images:organizeAuto', payload),
    toVideo:        payload => ipcRenderer.invoke('images:toVideo',      payload),
    onDedupProgress:    cb => ipcRenderer.on('images:dedupProgress',    (_, data) => cb(data)),
    onSimilarProgress:  cb => ipcRenderer.on('images:similarProgress',  (_, data) => cb(data)),
    onOrganizeProgress: cb => ipcRenderer.on('images:organizeProgress', (_, data) => cb(data))
  },
  irc: {
    connect:        opts => ipcRenderer.invoke('irc:connect', opts),
    disconnect:     ()   => ipcRenderer.invoke('irc:disconnect'),
    join:           opts => ipcRenderer.invoke('irc:join', opts),
    send:           opts => ipcRenderer.invoke('irc:send', opts),
    raw:            opts => ipcRenderer.invoke('irc:raw', opts),
    cancelTransfer: id   => ipcRenderer.invoke('irc:cancelTransfer', { id }),
    onEvent:        cb   => ipcRenderer.on('irc:event', (_, ev) => cb(ev))
  },
  schedule: {
    load: ()  => ipcRenderer.invoke('schedule:load'),
    save: s   => ipcRenderer.invoke('schedule:save', s),
    onAutoPoll: cb => ipcRenderer.on('scheduler:autoPoll', (_, d) => cb(d))
  },
  queue: {
    load:       ()       => ipcRenderer.invoke('queue:load'),
    save:       q        => ipcRenderer.invoke('queue:save', q),
    clear:      ()       => ipcRenderer.invoke('queue:clear'),
    run:        (q, cfg) => ipcRenderer.invoke('queue:run', { queue: q, config: cfg }),
    importList: (text)   => ipcRenderer.invoke('queue:importList', text),
    checkUrl:   url      => ipcRenderer.invoke('queue:checkUrl', url),
    onItemStart: cb => ipcRenderer.on('queue:itemStart', (_, d) => cb(d)),
    onItemDone:  cb => ipcRenderer.on('queue:itemDone',  (_, d) => cb(d)),
    onProgress:  cb => ipcRenderer.on('queue:progress',  (_, d) => cb(d))
  },
  torrent: {
    search:         (q, cfg) => ipcRenderer.invoke('torrent:search', { query: q, config: cfg }),
    save:           payload  => ipcRenderer.invoke('torrent:save', payload),
    onSiteProgress: cb       => ipcRenderer.on('torrent:siteProgress', (_, d) => cb(d))
  },
  media: {
    download:         payload => ipcRenderer.invoke('media:download', payload),
    probe:            url     => ipcRenderer.invoke('media:probe', url),
    getStreamUrl:     url     => ipcRenderer.invoke('media:getStreamUrl', url),
    resolveStreamUrl: payload => ipcRenderer.invoke('media:resolveStreamUrl', payload),
    stop:             payload => ipcRenderer.invoke('media:stop', payload),
    onProgress:       cb      => ipcRenderer.on('media:progress', (_, d) => cb(d))
  },
  live: {
    record:     payload => ipcRenderer.invoke('live:record', payload),
    onProgress: cb      => ipcRenderer.on('live:progress', (_, d) => cb(d))
    // probe reuses media.probe; stop reuses media.stop
  },
  tag: {
    read:    filePath => ipcRenderer.invoke('tag:read', filePath),
    write:   payload  => ipcRenderer.invoke('tag:write', payload),
    autoTag: payload  => ipcRenderer.invoke('tag:autoTag', payload)
  },
  mb: {
    search: q => ipcRenderer.invoke('mb:search', q)
  },
  cover: {
    fetch: mbid => ipcRenderer.invoke('cover:fetch', mbid)
  },
  lrc: {
    fetch:  q       => ipcRenderer.invoke('lrc:fetch', q),
    save:   payload => ipcRenderer.invoke('lrc:save', payload),
    exists: path    => ipcRenderer.invoke('lrc:exists', path),
    read:   path    => ipcRenderer.invoke('lrc:read', path)
  },
  radio: {
    search:        params       => ipcRenderer.invoke('radio:search', params),
    countries:     ()           => ipcRenderer.invoke('radio:countries'),
    tags:          ()           => ipcRenderer.invoke('radio:tags'),
    languages:     ()           => ipcRenderer.invoke('radio:languages'),
    startIcyWatch: payload      => ipcRenderer.invoke('radio:startIcyWatch', payload),
    stopIcyWatch:  uuid         => ipcRenderer.invoke('radio:stopIcyWatch', uuid),
    onIcyMeta:     cb           => ipcRenderer.on('radio:icyMeta', (_, d) => cb(d))
  },
  acoustid: {
    identify:           payload => ipcRenderer.invoke('acoustid:identify', payload),
    identifyFromBuffer: payload => ipcRenderer.invoke('acoustid:identifyFromBuffer', payload),
    validateKey:        payload => ipcRenderer.invoke('acoustid:validateKey', payload),
    status:             ()      => ipcRenderer.invoke('acoustid:status')
  },
  shazam: {
    identifyFromBuffer: payload => ipcRenderer.invoke('shazam:identifyFromBuffer', payload)
  },
  youtube: {
    searchAndDownload: payload => ipcRenderer.invoke('youtube:searchAndDownload', payload)
  },
  spotify: {
    resolve: url => ipcRenderer.invoke('spotify:resolve', url)
  },
  playlist: {
    exportM3U: payload => ipcRenderer.invoke('playlist:exportM3U', payload)
  },
  xtract: {
    checkFfmpeg: ()         => ipcRenderer.invoke('xtract:checkFfmpeg'),
    probe:       payload    => ipcRenderer.invoke('xtract:probe',     payload),
    probeDuration: input    => ipcRenderer.invoke('xtract:probeDuration', input),
    hasAudio:    input      => ipcRenderer.invoke('xtract:hasAudio',  input),
    audio:       payload    => ipcRenderer.invoke('xtract:audio',     payload),
    convert:     payload    => ipcRenderer.invoke('xtract:convert',   payload),
    resize:      payload    => ipcRenderer.invoke('xtract:resize',    payload),
    compress:    payload    => ipcRenderer.invoke('xtract:compress',  payload),
    trim:        payload    => ipcRenderer.invoke('xtract:trim',      payload),
    subs:        payload    => ipcRenderer.invoke('xtract:subs',      payload),
    frame:       payload    => ipcRenderer.invoke('xtract:frame',     payload),
    concat:      payload    => ipcRenderer.invoke('xtract:concat',    payload),
    meta:        payload    => ipcRenderer.invoke('xtract:meta',      payload),
    normalize:   payload    => ipcRenderer.invoke('xtract:normalize', payload),
    onProgress:  cb         => ipcRenderer.on('xtract:progress', (_, d) => cb(d))
  },
  system: {
    platform:         process.platform,                    // 'win32' | 'darwin' | 'linux' — used by renderer to apply OS-specific styling (e.g. left padding on macOS for traffic-light avoidance)
    getLocale:        ()        => ipcRenderer.invoke('app:getLocale'),
    getTheme:         ()        => ipcRenderer.invoke('theme:getSystem'),
    onThemeChanged:   cb        => ipcRenderer.on('theme:systemChanged', (_, d) => cb(d)),
    log:              (lvl,msg) => ipcRenderer.send('renderer:log', { level: lvl, msg }),
    getAppVersion:    ()        => ipcRenderer.invoke('app:getVersion'),
    checkForUpdates:  ()        => ipcRenderer.invoke('updater:check'),
    signalReady:      ()        => ipcRenderer.invoke('app:ready'),
    relaunch:         ()        => ipcRenderer.invoke('system:relaunch'),
    onSplashAudioPref: cb       => ipcRenderer.on('config:splashAudioPref', (_, v) => cb(v))
  },
  rss: {
    fetch:    url => ipcRenderer.invoke('rss:fetch', url),
    discover: url => ipcRenderer.invoke('rss:discover', url)
  },
  capture: {
    listSources:    opts    => ipcRenderer.invoke('capture:listSources', opts || {}),
    saveImage:      payload => ipcRenderer.invoke('capture:saveImage', payload),
    saveRecording:  payload => ipcRenderer.invoke('capture:saveRecording', payload)
  },
  convert: {
    fromUrl:        payload => ipcRenderer.invoke('convert:fromUrl', payload),
    imagesToPdf:    payload => ipcRenderer.invoke('convert:imagesToPdf', payload),
    savePdfPage:    payload => ipcRenderer.invoke('convert:savePdfPage', payload),
    saveAnnotated:  payload => ipcRenderer.invoke('convert:saveAnnotated', payload)
  },
  updater: {
    download:       ()  => ipcRenderer.invoke('updater:download'),
    install:        ()  => ipcRenderer.invoke('updater:install'),
    onAvailable:    cb  => ipcRenderer.on('updater:available',  (_, d) => cb(d)),
    onDownloaded:   cb  => ipcRenderer.on('updater:downloaded', (_, d) => cb(d))
  }
});
