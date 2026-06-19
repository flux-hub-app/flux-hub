'use strict';

// ─── HEARTBEAT (verifies preload bridge → main → flux.log path) ──────────────
try { window.api.system.log('INFO', 'renderer.js: parsed and executing'); } catch (e) {
  // If this throws, window.api isn't exposed → contextBridge / preload issue.
  // Will be visible in DevTools console at least.
  console.warn('window.api unavailable at renderer.js parse time:', e?.message);
}

// ─── ERROR CAPTURE → flux.log (renderer runs in main world, listeners work) ─
window.addEventListener('error', e => {
  try { window.api.system.log('ERROR', `Uncaught: ${e.message} at ${e.filename||'?'}:${e.lineno||0}`); } catch {}
});
window.addEventListener('unhandledrejection', e => {
  const reason = e.reason instanceof Error ? `${e.reason.message}\n${e.reason.stack}` : String(e.reason);
  try { window.api.system.log('ERROR', `UnhandledRejection: ${reason}`); } catch {}
});
const _origError = console.error.bind(console);
console.error = (...args) => {
  try {
    const msg = args.map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : (typeof a === 'object' ? JSON.stringify(a) : String(a)))).join(' ');
    window.api.system.log('ERROR', msg);
  } catch {}
  _origError(...args);
};

// ─── FLAG SVGs (inline, CSP-safe, ~250 bytes each) ───────────────────────────
const FLAG_SVG = {
  system: '<svg viewBox="0 0 24 16" width="24" height="16" aria-hidden="true"><rect x="2" y="2" width="20" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="8" y="13" width="8" height="1.5" fill="currentColor"/></svg>',
  en: '<svg viewBox="0 0 24 16" width="24" height="16" aria-hidden="true"><rect width="24" height="16" fill="#012169"/><path d="M0,0 L24,16 M24,0 L0,16" stroke="#fff" stroke-width="3"/><path d="M0,0 L24,16 M24,0 L0,16" stroke="#C8102E" stroke-width="1"/><rect x="10" width="4" height="16" fill="#fff"/><rect y="6" width="24" height="4" fill="#fff"/><rect x="11" width="2" height="16" fill="#C8102E"/><rect y="7" width="24" height="2" fill="#C8102E"/></svg>',
  it: '<svg viewBox="0 0 24 16" width="24" height="16" aria-hidden="true"><rect width="8" height="16" fill="#009246"/><rect x="8" width="8" height="16" fill="#fff"/><rect x="16" width="8" height="16" fill="#ce2b37"/></svg>',
  es: '<svg viewBox="0 0 24 16" width="24" height="16" aria-hidden="true"><rect width="24" height="4" fill="#aa151b"/><rect y="4" width="24" height="8" fill="#f1bf00"/><rect y="12" width="24" height="4" fill="#aa151b"/></svg>',
  fr: '<svg viewBox="0 0 24 16" width="24" height="16" aria-hidden="true"><rect width="8" height="16" fill="#002395"/><rect x="8" width="8" height="16" fill="#fff"/><rect x="16" width="8" height="16" fill="#ed2939"/></svg>',
  de: '<svg viewBox="0 0 24 16" width="24" height="16" aria-hidden="true"><rect width="24" height="5.33" fill="#000"/><rect y="5.33" width="24" height="5.34" fill="#dd0000"/><rect y="10.67" width="24" height="5.33" fill="#ffce00"/></svg>',
  pt: '<svg viewBox="0 0 24 16" width="24" height="16" aria-hidden="true"><rect width="9.6" height="16" fill="#006600"/><rect x="9.6" width="14.4" height="16" fill="#cc0000"/></svg>',
  ja: '<svg viewBox="0 0 24 16" width="24" height="16" aria-hidden="true"><rect width="24" height="16" fill="#fff"/><circle cx="12" cy="8" r="4.8" fill="#bc002d"/></svg>',
  ru: '<svg viewBox="0 0 24 16" width="24" height="16" aria-hidden="true"><rect width="24" height="5.33" fill="#fff"/><rect y="5.33" width="24" height="5.34" fill="#0039a6"/><rect y="10.67" width="24" height="5.33" fill="#d52b1e"/></svg>',
  pl: '<svg viewBox="0 0 24 16" width="24" height="16" aria-hidden="true"><rect width="24" height="8" fill="#fff"/><rect y="8" width="24" height="8" fill="#dc143c"/></svg>',
  'zh-CN': '<svg viewBox="0 0 30 20" width="24" height="16" aria-hidden="true"><rect width="30" height="20" fill="#de2910"/><g fill="#ffde00"><polygon points="5,2 5.95,4.9 9,4.9 6.5,6.7 7.45,9.6 5,7.8 2.55,9.6 3.5,6.7 1,4.9 4.05,4.9"/><polygon points="10,1.5 10.3,2.4 11.2,2.4 10.5,3 10.8,3.9 10,3.3 9.2,3.9 9.5,3 8.8,2.4 9.7,2.4"/><polygon points="12,3.5 12.3,4.4 13.2,4.4 12.5,5 12.8,5.9 12,5.3 11.2,5.9 11.5,5 10.8,4.4 11.7,4.4"/><polygon points="12,6 12.3,6.9 13.2,6.9 12.5,7.5 12.8,8.4 12,7.8 11.2,8.4 11.5,7.5 10.8,6.9 11.7,6.9"/><polygon points="10,8 10.3,8.9 11.2,8.9 10.5,9.5 10.8,10.4 10,9.8 9.2,10.4 9.5,9.5 8.8,8.9 9.7,8.9"/></g></svg>'
};

// ─── LUCIDE-STYLE INLINE SVG ICONS (matches the nav set already in index.html) ─
// Each entry is the inner SVG content; applyLucideIcons() wraps it in an <svg>
// with the standard Lucide attributes. Replacing emoji glyphs gives consistent
// rendering across OS/themes.
const LUCIDE = {
  music:          '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  home:           '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  'download-cloud':'<path d="M12 13v8"/><path d="m8 17 4 4 4-4"/><path d="M20 16.2A4.5 4.5 0 0 0 17.5 8h-1.8A7 7 0 1 0 4 14.9"/>',
  download:       '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  pause:          '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  play:           '<polygon points="6 3 20 12 6 21 6 3"/>',
  square:         '<rect width="14" height="14" x="5" y="5" rx="1.5"/>',
  scissors:       '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
  'folder-plus':  '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><line x1="12" x2="12" y1="10" y2="16"/><line x1="9" x2="15" y1="13" y2="13"/>',
  'folder-open':  '<path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  file:           '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><polyline points="14 2 14 8 20 8"/>',
  link:           '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  'external-link':'<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  'grip-vertical':'<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>',
  'copy-plus':    '<line x1="15" x2="15" y1="12" y2="18"/><line x1="12" x2="18" y1="15" y2="15"/><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  'list-checks':  '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  'skip-back':    '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" x2="5" y1="19" y2="5"/>',
  'skip-forward': '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>',
  'volume-2':     '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  'volume-1':     '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
  'volume-x':     '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/>',
  plus:           '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  minus:          '<line x1="5" y1="12" x2="19" y2="12"/>',
  'maximize-2':   '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  'rotate-cw':    '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  'fade-in':      '<path d="M3 19 C 9 19, 12 19, 14 14 C 16 9, 18 5, 21 5"/>',
  'fade-out':     '<path d="M3 5 C 9 5, 12 5, 14 10 C 16 15, 18 19, 21 19"/>',
  x:              '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  star:           '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  'arrow-left':   '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  search:         '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  check:          '<polyline points="20 6 9 17 4 12"/>',
  folder:         '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  trash:          '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  upload:         '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  settings:       '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  filter:         '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  list:           '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  moon:           '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  zap:            '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  maximize:       '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  minimize:       '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
  film:           '<rect width="20" height="20" x="2" y="2" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>',
  files:          '<path d="M20 7h-3a2 2 0 0 1-2-2V2"/><path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v12a2 2 0 0 1-2 2Z"/><path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8"/>',
  image:          '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  heart:          '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/>',
  rss:            '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
  sun:            '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  monitor:        '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  palette:        '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  'file-text':    '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>',
  type:           '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  save:           '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  scroll:         '<path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M22 17H4a2 2 0 0 0 0 4h14a2 2 0 0 0 2-2v-4z"/><path d="M4 3a2 2 0 0 0-2 2v12"/>',
  'alert-triangle':'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  magnet:         '<path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15"/><path d="m5 8 4 4"/><path d="m12 15 4 4"/>',
  'mic':          '<rect x="9" y="2" width="6" height="11" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" x2="12" y1="19" y2="22"/>',
  globe:          '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  bell:           '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  'help-circle':  '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  // Music-themed icons used by the player badge cycle while .is-playing
  'music-2':      '<circle cx="8" cy="18" r="4"/><path d="M12 18V2l7 4"/>',
  'music-3':      '<circle cx="12" cy="18" r="4"/><path d="M16 18V2"/>',
  'music-4':      '<path d="M9 18V5l12-2v13"/><path d="m9 9 12-2"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  headphones:     '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a1 1 0 0 1-1-1v-6a9 9 0 0 1 18 0v6a1 1 0 0 1-1 1h-2a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  disc:           '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>',
  'audio-lines':  '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>'
};

// Resolve an icon's inner SVG markup from the FULL Lucide set (vendor/lucide.min.js,
// exposed on window.lucide as PascalCase IconNode arrays — e.g. ArrowRight =
// [['path',{d:…}], …]). kebab-case name → PascalCase lookup. Returns null when
// the lib isn't loaded or the icon doesn't exist, so callers fall back to the
// small hand-rolled LUCIDE map below. This is what lets us use ANY Lucide icon
// by name across the whole app without hand-copying each one.
function lucideInnerFromLib(name) {
  const L = (typeof window !== 'undefined') && window.lucide;
  if (!L) return null;
  const pascal = String(name).split(/[-_]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
  const node = L[pascal] || (L.icons && L.icons[pascal]);
  if (!Array.isArray(node)) return null;
  return node.map(([tag, attrs]) => {
    const a = Object.entries(attrs || {}).map(([k, v]) => `${k}="${v}"`).join(' ');
    return `<${tag} ${a}/>`;
  }).join('');
}

function lucideSvg(name, size = 18) {
  const body = lucideInnerFromLib(name) ?? LUCIDE[name];
  if (!body) return '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}

// Render Lucide SVG icons declared via data-lucide-icon="name". Uses a child
// `.lucide-slot` span so the icon coexists with sibling content (text via
// data-i18n on a child, badges, etc.). Idempotent — slot is reused on re-render.
function applyLucideIcons(root = document) {
  root.querySelectorAll('[data-lucide-icon]').forEach(el => {
    const name = el.getAttribute('data-lucide-icon');
    const size = parseInt(el.getAttribute('data-lucide-size'), 10) || 18;
    const svg  = lucideSvg(name, size);
    if (!svg) return;
    let slot = el.querySelector(':scope > .lucide-slot');
    if (!slot) {
      slot = document.createElement('span');
      slot.className = 'lucide-slot';
      el.insertBefore(slot, el.firstChild);
    }
    slot.innerHTML = svg;
  });
}

const LANG_OPTIONS = [
  { value: 'system' },  // label set dynamically via i18n
  { value: 'en',    label: 'English' },
  { value: 'it',    label: 'Italiano' },
  { value: 'es',    label: 'Español' },
  { value: 'fr',    label: 'Français' },
  { value: 'de',    label: 'Deutsch' },
  { value: 'pt',    label: 'Português' },
  { value: 'ja',    label: '日本語' },
  { value: 'ru',    label: 'Русский' },
  { value: 'pl',    label: 'Polski' },
  { value: 'zh-CN', label: '简体中文' }
];

// Detected system language (resolved at init from app.getLocale())
let systemLang = 'en';

// AcoustID app key — only used when the user explicitly selects the AcoustID
// backend in Settings. Default backend is Shazamio (no key needed).
// This placeholder yields "invalid client key" — replace with FLUX's registered
// AcoustID application key before public release.
// FLUX's registered AcoustID application (client) key — free for non-commercial
// use per AcoustID's terms, shared by all installs (the standard model, like
// MusicBrainz Picard). Users can paste their own key to override it. Public by
// design; rotate here + ship a release if it ever gets rate-limited/revoked.
const DEFAULT_ACOUSTID_KEY = 'NrfLl2VKKZ';

// Default torrent sources baked into FLUX. Adding any source whose name doesn't
// match this set triggers the custom-source legal warning modal.
const TRUSTED_TORRENT_SOURCES = new Set(['yts', 'nyaa', 'tpb']);
function isTrustedSourceName(name) {
  return TRUSTED_TORRENT_SOURCES.has(String(name || '').trim().toLowerCase());
}

// Session-scoped flag: legal banner shown once per app run, resets on relaunch.
let legalBannerShownThisSession = false;

// Friendly labels for media format codes (used in queue list display).
const FORMAT_LABEL = {
  video:       'Video best',
  video_1080:  '1080p',
  video_720:   '720p',
  mp4:         'MP4',
  mkv:         'MKV',
  audio:       'MP3',
  audio_flac:  'FLAC',
  audio_m4a:   'M4A',
  audio_opus:  'Opus'
};
function formatLabel(f) { return FORMAT_LABEL[f] || f; }

// ─── STATE ───────────────────────────────────────────────────────────────────
let config         = null;
let profiles       = {};
let schedule       = null;
let torrentResults = [];
let queue          = [];
let history        = [];
let rssFeeds       = [];
let activeFeedIdx  = -1;

let queueIdCounter = 0;
const newId = () => ++queueIdCounter;

// ─── INIT ────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  // Run config + i18n loads in parallel. i18n.js fires off its JSON fetches
  // at script-eval time and exposes window.__i18nReady — we just need to
  // await it before any code calls t() / applyI18n().
  config   = await window.api.config.load();
  profiles = await window.api.profiles.load() || {};
  // Ensure at least one profile exists; the default is "Profilo 1". The active
  // profile name always points at a real saved profile.
  if (!config.profile_name || config.profile_name === 'Default') config.profile_name = 'Profilo 1';
  if (!Object.keys(profiles).length) {
    await window.api.profiles.save(config.profile_name, config);
    profiles = await window.api.profiles.load() || {};
  } else if (!profiles[config.profile_name]) {
    config.profile_name = Object.keys(profiles)[0];
  }
  queue    = await window.api.queue.load()    || [];
  history  = await window.api.history.load()  || [];
  schedule = await window.api.schedule.load() || { enabled: false, window_start: '02:00', window_end: '06:00', rss_poll_min: 60 };
  await window.__i18nReady;

  // Resolve system locale → closest supported lang
  try {
    const loc = (await window.api.system.getLocale() || 'en').toLowerCase();
    // Try exact match first (handles "zh-CN", "pt-BR" → "pt", etc.) then base prefix.
    const base = loc.split('-')[0];
    const supported = window.SUPPORTED_LANGS;
    systemLang = supported.includes(loc) ? loc
               : supported.includes(base) ? base
               : 'en';
  } catch { systemLang = 'en'; }

  // Seed unique ids — avoid collisions with persisted queue items
  queueIdCounter = queue.reduce((m, it) => Math.max(m, +it.id || 0), 0);

  // Apply language and theme. 'system' resolves to detected systemLang.
  const effectiveLang = (config.lang === 'system' || !config.lang) ? systemLang : config.lang;
  window.setLang(effectiveLang);
  applyTheme(config.theme || 'dark');
  applyI18n();
  applyLucideIcons();
  if (config.show_activity_logs) document.body.classList.add('show-activity-logs');
  // OS marker on <body> so CSS can target platform-specific quirks
  // (Mac traffic lights overlapping the sidebar logo, Linux fontmetrics,
  // etc.) without touching JS for every cosmetic adjustment.
  const plat = window.api?.system?.platform;
  if (plat === 'darwin') document.body.classList.add('is-mac');
  else if (plat === 'win32') document.body.classList.add('is-win');
  else if (plat === 'linux') document.body.classList.add('is-linux');

  // Modular visibility — hide sidebar tabs whose module is disabled in
  // config.modules_enabled. Must run BEFORE switchTab fires so the user
  // can't land on a tab of a disabled module. The registry is the source
  // of truth for module → tabs mapping.
  await applyModuleVisibility();
  // Settings icon click → collapses the right-side actions card (see
  // bindTopbarCardCollapse). The old behaviour (jump to Settings tab) is
  // still reachable via the sidebar nav; the topbar shortcut now serves
  // the same purpose as the music badge on the left: a draggable handle
  // for the adjacent card.

  // Topbar one-click toggle for activity logs. Mirrors the Settings flag —
  // changes persist via the config save (don't reset on next launch).
  document.getElementById('topbar-logs-toggle')?.addEventListener('click', async () => {
    const next = !document.body.classList.contains('show-activity-logs');
    document.body.classList.toggle('show-activity-logs', next);
    config.show_activity_logs = next;
    const showLogsEl = document.getElementById('cfg-show-logs');
    if (showLogsEl) showLogsEl.checked = next;
    try { await window.api.config.save(config); } catch {}
  });
  refreshIdentifyButton();

  // Listen for system theme changes (Electron nativeTheme → IPC).
  // Uses the boolean from main directly, no matchMedia dependency.
  window.api.system.onThemeChanged(({ dark }) => {
    if (config.theme === 'auto') {
      document.body.dataset.theme = dark ? 'dark' : 'light';
    }
  });

  // The splash screen's mute toggle changed the audio preference (saved by main).
  // Sync our in-memory config + the Settings checkbox so it reflects the change
  // and a later config:save doesn't clobber it back.
  window.api.system.onSplashAudioPref(v => {
    config.splash_audio = v;
    const cb = document.getElementById('cfg-splash-audio');
    if (cb) cb.checked = v !== false;
  });

  // Re-prompt when the legal text changes: acceptance is tied to a TOS version,
  // so the new Terms + the art.1341 double-flag must be re-approved by everyone.
  if (!config.tos_accepted || config.tos_version !== TOS_VERSION) showTOS();

  rssFeeds = config.rss_feeds || [];

  buildLangDropdown();
  renderSettings();
  renderProfileBar();
  renderQueue();
  renderFeedList();
  renderHistory();
  bindNav();
  bindTorrent();
  bindMedia();
  bindLive();
  bindRadio();
  bindSpotify();
  bindTagEditor();
  bindQueue();
  bindTorrentBatch();
  bindGlobalPlayer();
  bindDownloadsModal();
  renderDownloadsBadge();  // initial: hide badge when empty, keep icon visible
  bindRSS();
  bindNzb();
  bindIrc();
  bindHistory();
  bindSettings();
  bindGlobalKeys();
  bindLegalNotices();
  bindTOS();
  bindSidebarToggle();
  bindFooterVolume();
  bindSettingsVersion();
  bindVideoPreviewModal();
  bindNavAccordion();
  bindXtract();
  bindImageCropInteractions();
  bindImageCropControls();
  bindImageFxControls();
  bindImageResizeControls();
  bindSplitTracksControls();
  bindImageCompareControls();
  bindXtractCapture();
  bindXtractPdfPagePicker();
  bindImageAnnotate();
  bindFiles();
  bindFilesSyncHooks();
  bindVideo();
  bindGlobalDragDrop();
  bindShortcutsCheatsheet();
  bindNotificationsHistory();
  bindTopbarCardCollapse();
  bindPlayerIconCycle();
  // Wire the image-dedup IPC progress channel into the existing dedup-
  // modal status line. Audio dedup has its own channel; we hook a
  // second source so both reuse the same modal UI.
  window.api.images.onDedupProgress(({ line, progress }) => {
    document.getElementById('dedup-status').textContent = line;
    setDedupProgress(progress);
  });
  // Similar-photos modal shares the same progress-line pattern on its own
  // channel + status element.
  window.api.images.onSimilarProgress(({ line, progress }) => {
    const el = document.getElementById('similar-status');
    if (el) el.textContent = line;
    setSimilarProgress(progress);
  });
  document.getElementById('similar-close')?.addEventListener('click', () =>
    document.getElementById('similar-modal').classList.add('hidden'));
  document.getElementById('similar-trash')?.addEventListener('click', () => similarTrashOthers());
  // When the dedup-modal closes, restore audio dedup's mode row that we
  // hid for image-dedup mode. Hooks the existing close button.
  document.getElementById('dedup-close')?.addEventListener('click', restoreDedupModeRow);
  bindSubsSearchModal();
  bindDedupModal();
  bindDonateModal();
  // Open the donations popup on every launch — but only once the TOS is accepted,
  // so it never stacks on top of the first-run Terms overlay.
  if (config.tos_accepted && config.tos_version === TOS_VERSION) {
    setTimeout(() => { try { openDonateModal(); } catch {} }, 500);
  }
  bindImageEditor();
  bindImageSplitter();
  bindImagePreviewModal();
  bindPlaylist();

  // Media: buttons disabled by default until a valid URL is probed
  setMediaButtonsEnabled(false);
  initLogPlaceholders();

  // IPC events
  window.api.torrent.onSiteProgress(({ site }) => markSiteDone(site));
  window.api.media.onProgress(({ line, error }) => handleMediaProgress(line, error));
  // ffmpeg writes ALL its output to stderr (Opening/Input/Duration/Metadata…),
  // so a stderr line is NOT an error — route progress to the log panel without
  // raising a toast for every line. Genuine failures surface via the record
  // result handler (which logs 'error' and toasts once).
  window.api.live.onProgress(({ line, error }) => appendLog('live-log', line, error ? 'warn' : 'log'));
  window.api.queue.onItemStart(({ id }) => markQueueItem(id, 'running'));
  window.api.queue.onItemDone(({ id, ok, error, stopped }) => onQueueItemDone(id, ok, error, stopped));
  window.api.queue.onProgress(({ id, name, line, error }) => {
    const item = queue.find(q => q.id === id);
    const label = (item?.title || name || 'item');
    const shortLabel = label.length > 40 ? label.substring(0, 37) + '…' : label;
    appendLog('queue-log', `[${shortLabel}] ${line}`, error ? 'error' : 'log');
  });
  window.api.schedule.onAutoPoll(({ feedUrl, feedName }) => autoPollFeed(feedUrl, feedName));
  window.api.updater.onAvailable(info => showUpdaterModal('available', info));
  window.api.updater.onDownloaded(info => showUpdaterModal('downloaded', info));

  // Init complete — fade out the inline splash AND signal main process to
  // close the OS-level splash window + reveal the main window. Two-stage so
  // the user sees a smooth handoff even if main reveals slightly before/after
  // the inline fade.
  requestAnimationFrame(() => {
    const splash = document.getElementById('splash');
    if (splash) {
      splash.classList.add('hidden');
      setTimeout(() => splash.remove(), 400);
    }
    // Tell main: close splash window + show main window.
    try { window.api.system.signalReady(); } catch {}
  });
});

// ─── LEGAL NOTICES (footer links + first-download banner) ───────────────────
// ─── DONATIONS ──────────────────────────────────────────────────────────────
// Donation URLs are hardcoded here — each install ships with the same set,
// not per-user. Leave a value empty to hide that row in the donate modal;
// the maintainer fills these in the source before building a release.
const DONATE_URLS = {
  donate_url_github:    'https://github.com/sponsors/flux-hub-app',
  donate_url_kofi:      'https://ko-fi.com/fluxhub',
  donate_url_liberapay: 'https://liberapay.com/flux-hub-app',
  donate_url_paypal:    'https://paypal.me/fluxhubapp'
};

function openDonateModal() {
  const modal = document.getElementById('donate-modal');
  // Populate each option's href from the hardcoded map; empty entries hide
  // the row (no point showing a broken link).
  modal.querySelectorAll('[data-donate-url-key]').forEach(a => {
    const url = (DONATE_URLS[a.dataset.donateUrlKey] || '').trim();
    if (url) {
      a.style.display = '';
      // Route through shell.openExternal — even with href set, native <a>
      // clicks in Electron open in the same window. The click handler below
      // intercepts and uses the system browser instead.
      a.dataset.resolvedUrl = url;
    } else {
      a.style.display = 'none';
    }
  });
  // If every URL is empty (fresh install, maintainer hasn't configured yet),
  // surface a helpful message instead of an empty box.
  const visible = [...modal.querySelectorAll('[data-donate-url-key]')]
    .filter(a => a.style.display !== 'none').length;
  const noUrlsMsg = modal.querySelector('.donate-no-urls');
  if (visible === 0) {
    if (!noUrlsMsg) {
      const p = document.createElement('p');
      p.className = 'donate-no-urls field-help';
      p.style.color = 'var(--warning)';
      p.textContent = t('donate_no_urls');
      modal.querySelector('#donate-options').appendChild(p);
    }
  } else if (noUrlsMsg) {
    noUrlsMsg.remove();
  }
  modal.classList.remove('hidden');
}

function bindDonateModal() {
  const open = () => openDonateModal();
  document.getElementById('footer-donate-link')?.addEventListener('click', open);
  document.getElementById('home-donate-link')?.addEventListener('click', open);
  document.getElementById('donate-close')?.addEventListener('click', () =>
    document.getElementById('donate-modal').classList.add('hidden'));
  // Anchor delegation — every donation row routes through openExternal so
  // the URL opens in the system browser (Electron <a target=_blank> would
  // pop an empty BrowserWindow otherwise).
  document.getElementById('donate-options')?.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-donate-url-key]');
    if (!a) return;
    e.preventDefault();
    const url = a.dataset.resolvedUrl;
    if (url) window.api.shell.openExternal(url);
  });
}

function bindLegalNotices() {
  // Footer "Terms" link → reopen TOS overlay (uses the same showTOS so the checkbox/button listeners stay bound)
  document.getElementById('footer-tos-link')?.addEventListener('click', () => showTOS());
  document.getElementById('home-tos-link')?.addEventListener('click', () => showTOS());
  // Footer credit → opens external GitHub link (URL set when user provides it)
  document.getElementById('footer-credit')?.addEventListener('click', () => {
    const url = 'https://github.com/flux-hub-app';
    window.api.shell.openExternal(url);
  });

  // First-download-of-session soft banner — dismissible
  document.getElementById('legal-banner-dismiss')?.addEventListener('click', () => {
    document.getElementById('legal-banner').classList.add('hidden');
    legalBannerShownThisSession = true;
  });
}

function maybeShowLegalBanner() {
  if (legalBannerShownThisSession) return;
  const banner = document.getElementById('legal-banner');
  if (!banner) return;
  banner.classList.remove('hidden');
  legalBannerShownThisSession = true;
}

// ─── LANGUAGE DROPDOWN (flags + system option) ───────────────────────────────
// Rebuild the <li> items only. Called on init AND after each language
// change so the visible labels (`lang_system`, native names) follow the
// active locale. Listeners on the items use replaceChildren so previous
// closures are dropped along with the elements.
function buildLangDropdown() {
  const menu = document.getElementById('cfg-lang-menu');
  if (!menu) return;
  menu.innerHTML = '';
  LANG_OPTIONS.forEach(opt => {
    const li = document.createElement('li');
    li.dataset.value = opt.value;
    const label = opt.value === 'system' ? `${t('lang_system')} (${systemLang.toUpperCase()})` : opt.label;
    li.innerHTML = `<span class="flag-icon-slot">${FLAG_SVG[opt.value === 'system' ? 'system' : opt.value]}</span><span class="flag-label">${label}</span>`;
    li.addEventListener('click', () => selectLang(opt.value));
    menu.appendChild(li);
  });
  // Bind the button + outside-click handlers ONCE — flag on the menu so
  // re-builds during language change don't stack listeners (the previous
  // bug: each rebuild added another toggle, so clicks cancelled out).
  if (!menu.__fluxBound) {
    menu.__fluxBound = true;
    const button = document.getElementById('cfg-lang-button');
    button.addEventListener('click', e => {
      e.stopPropagation();
      menu.classList.toggle('hidden');
    });
    document.addEventListener('click', e => {
      const wrap = document.getElementById('cfg-lang-wrap');
      if (wrap && !wrap.contains(e.target)) menu.classList.add('hidden');
    });
  }
}

function selectLang(value) {
  document.getElementById('cfg-lang').value = value;
  refreshLangButton(value);
  document.getElementById('cfg-lang-menu').classList.add('hidden');
  // Trigger language change live
  const effective = value === 'system' ? systemLang : value;
  window.setLang(effective);
  applyI18n();
  // Refresh dropdown labels for the new language
  buildLangDropdown();
  refreshLangButton(value);
  // Re-render dynamic content that bakes translated strings into innerHTML at
  // render time (rows, cards, tooltips). applyI18n() only catches elements with
  // data-i18n attrs; everything that goes through `${t(...)}` template
  // interpolation needs an explicit refresh after a language change.
  try { renderQueue(); } catch {}
  try { renderHistory(); } catch {}
  try { renderPlaylistList(); } catch {}
  try { renderPlaylistItems(); } catch {}
  try { renderSpotifyTable(); } catch {}
  try { renderDownloadsList(); } catch {}
  try { renderSettings(); } catch {}      // source cards have hardcoded labels resolved via t()
  try { renderFeedList(); } catch {}      // RSS sidebar
  try { renderProfileBar(); } catch {}
}

function refreshLangButton(value) {
  const opt = LANG_OPTIONS.find(o => o.value === value) || LANG_OPTIONS[0];
  const flagKey = opt.value === 'system' ? 'system' : opt.value;
  const label = opt.value === 'system' ? `${t('lang_system')} (${systemLang.toUpperCase()})` : opt.label;
  document.getElementById('cfg-lang-flag').innerHTML = FLAG_SVG[flagKey];
  document.getElementById('cfg-lang-label').textContent = label;
}

async function applyTheme(theme) {
  if (theme === 'auto') {
    // Source of truth: Electron's nativeTheme (more reliable than matchMedia under Win11)
    let isDark = false;
    try {
      const r = await window.api.system.getTheme();
      isDark = !!r?.dark;
    } catch {
      isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    document.body.dataset.theme = isDark ? 'dark' : 'light';
    document.body.dataset.themePref = 'auto';
  } else {
    document.body.dataset.theme = theme;
    document.body.dataset.themePref = theme;
  }
}

// ─── TOS ─────────────────────────────────────────────────────────────────────
// Stato gating: l'utente deve scorrere il TOS fino in fondo PRIMA di poter
// spuntare il checkbox di accettazione. Solo allora il bottone "Continua"
// si abilita (in combinazione con la spunta). Senza scroll → checkbox
// disabilitato + bottone disabilitato.
let tosScrolledToEnd = false;
// Bump when the legal text materially changes → forces everyone to re-accept
// (incl. the art.1341 double-flag). Stored as config.tos_version on acceptance.
const TOS_VERSION = '2026-06-19-legal-v2';

function bindTOS() {
  const overlay = document.getElementById('tos-overlay');
  const check   = document.getElementById('tos-checkbox');
  const check2  = document.getElementById('tos-checkbox-1341');
  const btn     = document.getElementById('tos-accept-btn');
  // Continue requires BOTH flags (general acceptance + art.1341 specific
  // approval) AND having scrolled to the end of the document.
  const evalBtn = () => { btn.disabled = !(check.checked && check2.checked && tosScrolledToEnd); };
  check.addEventListener('change', evalBtn);
  check2.addEventListener('change', evalBtn);
  btn.addEventListener('click', async () => {
    if (!config.tos_accepted || config.tos_version !== TOS_VERSION) {
      config.tos_accepted = true;
      config.tos_version = TOS_VERSION;
      await window.api.config.save(config);
    }
    overlay.classList.add('hidden');
    // Reset state for next time the overlay is shown via footer link
    check.checked = false; check2.checked = false;
    btn.disabled = true;
    tosScrolledToEnd = false;
    overlay.classList.remove('tos-scrolled');
  });
}

function showTOS() {
  const overlay = document.getElementById('tos-overlay');
  const tosText = document.getElementById('tos-text');
  const check   = document.getElementById('tos-checkbox');
  const check2  = document.getElementById('tos-checkbox-1341');
  const btn     = document.getElementById('tos-accept-btn');
  tosText.innerHTML = window.buildTOSHtml();
  check.checked = false; check2.checked = false;
  btn.disabled = true;
  tosScrolledToEnd = false;
  overlay.classList.remove('tos-scrolled');
  overlay.classList.remove('hidden');
  // Anchor delegation: il body del TOS contiene link http(s) (es. crediti
  // Pixabay). Senza intercettazione, Electron aprirebbe una BrowserWindow
  // figlia. Routiamo invece via shell.openExternal → browser di sistema.
  if (!tosText.__fluxLinkDelegated) {
    tosText.__fluxLinkDelegated = true;
    tosText.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="http"]');
      if (!a) return;
      e.preventDefault();
      window.api.shell.openExternal(a.href);
    });
    // Scroll gating: marca come "scrolled" quando l'utente raggiunge la
    // fine. Tolleranza di 4px per arrotondamenti sub-pixel + zoom.
    tosText.addEventListener('scroll', () => {
      const remaining = tosText.scrollHeight - tosText.clientHeight - tosText.scrollTop;
      if (remaining <= 4 && !tosScrolledToEnd) {
        tosScrolledToEnd = true;
        overlay.classList.add('tos-scrolled');
      }
    });
  }
  // Caso TOS corto (es. zoom enorme o futuro restyling): se non scrolla,
  // sblocca subito. Differito a un tick per attendere il layout post-innerHTML.
  setTimeout(() => {
    if (tosText.scrollHeight <= tosText.clientHeight + 4) {
      tosScrolledToEnd = true;
      overlay.classList.add('tos-scrolled');
    }
  }, 50);
}

// ─── SIDEBAR COLLAPSE ───────────────────────────────────────────────────────
// ─── NAV ACCORDION ───────────────────────────────────────────────────────────
// Each .nav-group has a clickable label that folds the group. Persisted as
// config.nav_groups_collapsed = { fetch: true, load: false, ... } keyed by
// the lowercased group label initial (or by index if labels lack a stable id).
// ─── PLAYLISTS ───────────────────────────────────────────────────────────────
// Lists of local files + streaming URLs the user can play sequentially or
// export as M3U for sync to phone/smartwatch via the phone's music app.
//
// Data shape (persisted in config.playlists):
//   { id, name, created, items: [{ type: 'file'|'url', path?, url?, title }] }

let activePlaylistId = null;
let playlistQueue = [];     // expanded item list when "Play all" is running
let playlistQueueIdx = -1;

function getPlaylists() {
  if (!Array.isArray(config.playlists)) config.playlists = [];
  return config.playlists;
}
function savePlaylists() {
  config.playlists = getPlaylists();
  window.api.config.save(config);
}
function getActivePlaylist() {
  return getPlaylists().find(p => p.id === activePlaylistId);
}

// Build (or refresh) an INTERNAL FLUX playlist from a folder's audio files —
// used by File & Sync's M3U option so a sync also drops a playable playlist
// inside the app. Items point at the SOURCE files (master copies, always
// available regardless of the USB). Re-syncing the same folder updates the
// same playlist (matched by name + the fromSync flag) instead of duplicating.
function buildInternalPlaylistFromAudioPaths(folderName, paths) {
  const AUDIO = /\.(mp3|flac|m4a|opus|ogg|oga|wav|aac|wma|aiff|alac)$/i;
  const items = (paths || [])
    .filter(p => AUDIO.test(p))
    .sort((a, b) => a.localeCompare(b))
    .map(p => ({ type: 'file', path: p, title: p.split(/[\\/]/).pop() }));
  if (!items.length) return 0;
  const lists = getPlaylists();
  let pl = lists.find(p => p.fromSync && p.name === folderName);
  if (pl) { pl.items = items; }
  else {
    pl = { id: 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
           name: folderName, created: new Date().toISOString(), items, fromSync: true };
    lists.push(pl);
  }
  savePlaylists();
  try { renderPlaylistList(); renderPlaylistItems(); } catch {}
  return items.length;
}

function bindPlaylist() {
  const newBtn      = document.getElementById('playlist-new-btn');
  const addFileBtn  = document.getElementById('playlist-add-file-btn');
  const addUrlBtn   = document.getElementById('playlist-add-url-btn');
  const playAllBtn  = document.getElementById('playlist-play-all-btn');
  const exportBtn   = document.getElementById('playlist-export-btn');
  const deleteBtn   = document.getElementById('playlist-delete-btn');
  const nameInput   = document.getElementById('playlist-name-edit');
  if (!newBtn) return;

  newBtn.addEventListener('click', () => {
    const id = 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const playlist = { id, name: t('playlist_default_name') || 'New playlist', created: new Date().toISOString(), items: [] };
    getPlaylists().push(playlist);
    savePlaylists();
    activePlaylistId = id;
    renderPlaylistList();
    renderPlaylistItems();
  });

  addFileBtn.addEventListener('click', async () => {
    if (!activePlaylistId) return;
    // Reuse the audio file picker (Tag Editor already exposes it).
    const paths = await window.api.dialog.pickFiles();
    if (!paths || !paths.length) return;
    const p = getActivePlaylist();
    paths.forEach(fp => p.items.push({ type: 'file', path: fp, title: fp.split(/[\\/]/).pop() }));
    savePlaylists();
    renderPlaylistItems();
  });

  addUrlBtn.addEventListener('click', () => {
    if (!activePlaylistId) return;
    document.getElementById('playlist-url-title').value = '';
    document.getElementById('playlist-url-input').value = '';
    document.getElementById('playlist-url-modal').classList.remove('hidden');
  });
  document.getElementById('playlist-url-cancel').addEventListener('click', () =>
    document.getElementById('playlist-url-modal').classList.add('hidden'));
  document.getElementById('playlist-url-confirm').addEventListener('click', () => {
    const url   = document.getElementById('playlist-url-input').value.trim();
    const title = document.getElementById('playlist-url-title').value.trim() || url;
    if (!url || !activePlaylistId) return;
    getActivePlaylist().items.push({ type: 'url', url, title });
    savePlaylists();
    renderPlaylistItems();
    document.getElementById('playlist-url-modal').classList.add('hidden');
  });

  playAllBtn.addEventListener('click', () => {
    const p = getActivePlaylist();
    if (!p || !p.items.length) return;
    playlistQueue = [...p.items];
    playlistQueueIdx = -1;
    advancePlaylistQueue();
  });

  exportBtn.addEventListener('click', async () => {
    const p = getActivePlaylist();
    if (!p || !p.items.length) return;
    // M3U8 (UTF-8 with BOM-less extended format). Standard music apps + most
    // watch sync tools read it natively. Local files use absolute paths so the
    // file works wherever the user copies the linked audio.
    const lines = ['#EXTM3U'];
    for (const it of p.items) {
      lines.push(`#EXTINF:-1,${(it.title || '').replace(/[\r\n]/g, ' ')}`);
      lines.push(it.type === 'file' ? it.path : it.url);
    }
    const r = await window.api.playlist.exportM3U({ name: p.name, content: lines.join('\n') });
    if (r && r.ok) appendLog('media-log', `✓ Exported playlist to ${r.path}`, 'ok');
    else appendLog('media-log', `✗ Export failed: ${r?.error || 'cancelled'}`, 'error');
  });

  deleteBtn.addEventListener('click', async () => {
    if (!activePlaylistId) return;
    if (!(await showConfirm({
      title: t('playlist_delete_title') || 'Delete playlist',
      body:  t('playlist_delete_confirm'),
      danger: true
    }))) return;
    config.playlists = getPlaylists().filter(p => p.id !== activePlaylistId);
    activePlaylistId = null;
    savePlaylists();
    renderPlaylistList();
    renderPlaylistItems();
  });

  nameInput.addEventListener('change', () => {
    const p = getActivePlaylist();
    if (!p) return;
    p.name = nameInput.value.trim() || p.name;
    savePlaylists();
    renderPlaylistList();
  });

  renderPlaylistList();
  renderPlaylistItems();
}

function renderPlaylistList() {
  const ul = document.getElementById('playlist-list');
  const countEl = document.getElementById('playlist-count');
  const lists = getPlaylists();
  if (countEl) countEl.textContent = lists.length ? `${lists.length} ${t('playlist_count_label')}` : '';
  ul.innerHTML = '';
  if (!lists.length) {
    ul.innerHTML = `<li class="feed-list-empty">${t('playlist_none')}</li>`;
    return;
  }
  lists.forEach(p => {
    const li = document.createElement('li');
    li.className = `feed-item${p.id === activePlaylistId ? ' active' : ''}`;
    li.innerHTML = `
      <div class="feed-item-body">
        <div class="feed-item-name">${esc(p.name)}</div>
        <div class="feed-item-meta">${p.items.length} ${t('playlist_items_label')}</div>
      </div>`;
    li.addEventListener('click', () => {
      activePlaylistId = p.id;
      renderPlaylistList();
      renderPlaylistItems();
    });
    ul.appendChild(li);
  });
}

function renderPlaylistItems() {
  const wrap    = document.getElementById('playlist-items-wrap');
  const empty   = document.getElementById('playlist-empty');
  const tbody   = document.getElementById('playlist-items-tbody');
  const nameInput = document.getElementById('playlist-name-edit');
  const p = getActivePlaylist();

  const enable = (sel, on) => { const el = document.getElementById(sel); if (el) el.disabled = !on; };
  enable('playlist-add-file-btn', !!p);
  enable('playlist-add-url-btn',  !!p);
  enable('playlist-play-all-btn', !!(p && p.items.length));
  enable('playlist-export-btn',   !!(p && p.items.length));

  if (!p) {
    wrap.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  wrap.classList.remove('hidden');
  nameInput.value = p.name;

  tbody.innerHTML = '';
  if (!p.items.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--text-muted);padding:16px;text-align:center">${t('playlist_no_items')}</td></tr>`;
    return;
  }
  p.items.forEach((it, i) => {
    const tr = document.createElement('tr');
    tr.dataset.idx = String(i);
    tr.draggable = true;
    // Display name = custom title (if set) OR fallback to filename / URL.
    // When a custom title is set on a URL item, the raw URL is shown as a
    // small subtitle so the user can still see where the stream comes from.
    const fallback = it.type === 'file' ? (it.path || '').split(/[\\/]/).pop() : it.url;
    const displayTitle = it.title || fallback;
    const hasCustom = !!(it.title && it.type === 'url' && it.url && it.title !== it.url);
    const subUrl = hasCustom ? `<div class="td-name-sub" title="${esc(it.url)}">${esc(it.url.length > 80 ? it.url.substring(0, 77) + '…' : it.url)}</div>` : '';
    const typeIcon = it.type === 'file' ? 'file' : 'link';
    tr.innerHTML = `
      <td class="td-num">
        <span class="playlist-drag-handle" data-lucide-icon="grip-vertical" title="${esc(t('queue_drag_hint') || 'Drag to reorder')}"><span class="lucide-slot"></span></span>
        <span class="playlist-row-num">${i + 1}</span>
      </td>
      <td class="td-dim td-type"><span data-lucide-icon="${typeIcon}" title="${esc(it.type === 'file' ? t('playlist_type_file') : t('playlist_type_url'))}"><span class="lucide-slot"></span></span></td>
      <td class="td-name" title="${esc(it.path || it.url || '')}">
        <div class="td-name-main">${esc(displayTitle.length > 60 ? displayTitle.substring(0, 57) + '…' : displayTitle)}</div>
        ${subUrl}
      </td>
      <td class="td-actions">
        <button class="btn-icon" data-play-idx="${i}" data-lucide-icon="${playlistRowIcon(i)}" title="${esc(t('downloads_play'))}"></button>
        <button class="btn-icon btn-icon-danger" data-remove-idx="${i}" data-lucide-icon="x" title="${esc(t('downloads_remove'))}"></button>
      </td>`;
    tbody.appendChild(tr);
  });
  applyLucideIcons(tbody);

  tbody.querySelectorAll('[data-play-idx]').forEach(b =>
    b.addEventListener('click', () => onPlaylistRowPlayClick(parseInt(b.dataset.playIdx, 10))));
  tbody.querySelectorAll('[data-remove-idx]').forEach(b =>
    b.addEventListener('click', () => {
      const i = parseInt(b.dataset.removeIdx, 10);
      p.items.splice(i, 1);
      savePlaylists();
      renderPlaylistItems();
    }));

  // Drag-and-drop reordering. Pure HTML5 dnd; the grip-vertical at the row
  // number is purely visual — the whole row is draggable. dragover paints a
  // top/bottom border to show the drop edge; drop moves the array entry.
  tbody.querySelectorAll('tr[data-idx]').forEach(tr => {
    tr.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', tr.dataset.idx);
      e.dataTransfer.effectAllowed = 'move';
      tr.classList.add('is-dragging');
    });
    tr.addEventListener('dragend', () => tr.classList.remove('is-dragging'));
    tr.addEventListener('dragover', e => {
      e.preventDefault();
      const r = tr.getBoundingClientRect();
      const after = (e.clientY - r.top) > r.height / 2;
      tbody.querySelectorAll('tr.drop-above, tr.drop-below').forEach(x => x.classList.remove('drop-above', 'drop-below'));
      tr.classList.add(after ? 'drop-below' : 'drop-above');
    });
    tr.addEventListener('dragleave', () => tr.classList.remove('drop-above', 'drop-below'));
    tr.addEventListener('drop', e => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const r = tr.getBoundingClientRect();
      const after = (e.clientY - r.top) > r.height / 2;
      let to = parseInt(tr.dataset.idx, 10) + (after ? 1 : 0);
      if (from < to) to -= 1;
      tbody.querySelectorAll('tr.drop-above, tr.drop-below').forEach(x => x.classList.remove('drop-above', 'drop-below'));
      if (from === to || isNaN(from) || isNaN(to)) return;
      const [moved] = p.items.splice(from, 1);
      p.items.splice(to, 0, moved);
      savePlaylists();
      renderPlaylistItems();
    });
  });
}

function playPlaylistItem(idx) {
  const p = getActivePlaylist();
  if (!p || !p.items[idx]) return;
  // Seed the full playlist as the queue so prev/next buttons in the topbar
  // can step through every track, even when the user picked one specific row.
  playlistQueue = [...p.items];
  playPlaylistQueueAt(idx);
}

// Per-row icon + click logic for the playlist table. Mirrors the radio
// pattern (icon reflects the global player state, not just the user's last
// click): playing-and-this-row → pause; paused-and-this-row → play (resume);
// any other case → play (start this row).
function playlistRowIcon(idx) {
  if (!isPlaylistRowActive(idx)) return 'play';
  const audio = document.getElementById('global-audio');
  return audio && !audio.paused ? 'pause' : 'play';
}
function isPlaylistRowActive(idx) {
  return globalCurrent && globalCurrent.source === 'playlist' && playlistQueueIdx === idx;
}
function onPlaylistRowPlayClick(idx) {
  if (isPlaylistRowActive(idx)) {
    // Same row: toggle pause / resume via the global audio element. The
    // topbar pause btn click handler does the same thing — going via it
    // keeps the icon-update path consistent with everything else.
    document.getElementById('global-player-pause-btn')?.click();
    return;
  }
  playPlaylistItem(idx);
}
// Refresh the playlist icons whenever the global player's play state changes
// — caller invokes this from playInGlobalPlayer, stopGlobalPlayer, and the
// pause-button click handler. Cheap: just a re-render of the visible rows.
function refreshPlaylistRowIcons() {
  document.querySelectorAll('#playlist-items tbody [data-play-idx]').forEach(btn => {
    const idx = parseInt(btn.dataset.playIdx, 10);
    const want = playlistRowIcon(idx);
    if (btn.getAttribute('data-lucide-icon') !== want) {
      btn.setAttribute('data-lucide-icon', want);
      applyLucideIcons(btn.parentElement || document);
    }
  });
}

function advancePlaylistQueue() {
  playlistQueueIdx++;
  if (playlistQueueIdx >= playlistQueue.length) {
    playlistQueue = [];
    playlistQueueIdx = -1;
    updatePlaylistNavButtons();
    return;
  }
  playPlaylistQueueAt(playlistQueueIdx);
}

// Play a specific index in the active playlist queue and rewire the auto-
// advance + nav-button enable state. Shared by advance / prev / next.
function playPlaylistQueueAt(idx) {
  if (!playlistQueue.length || idx < 0 || idx >= playlistQueue.length) return;
  playlistQueueIdx = idx;
  const it = playlistQueue[playlistQueueIdx];
  const url = it.type === 'file'
    ? 'file:///' + String(it.path).replace(/\\/g, '/').replace(/^\/+/, '')
    : it.url;
  playInGlobalPlayer({ url, title: it.title || url, source: 'playlist', id: `pl_q_${playlistQueueIdx}` });
  const audio = document.getElementById('global-audio');
  const onEnded = () => {
    audio.removeEventListener('ended', onEnded);
    advancePlaylistQueue();
  };
  audio.addEventListener('ended', onEnded);
  updatePlaylistNavButtons();
}

// Show prev/next icons in the topbar player only when a playlist is the
// source — radio / one-off file playback hides them. Disable at queue ends.
function updatePlaylistNavButtons() {
  const prev = document.getElementById('global-player-prev-btn');
  const next = document.getElementById('global-player-next-btn');
  if (!prev || !next) return;
  const active = playlistQueue.length > 0 && playlistQueueIdx >= 0;
  prev.classList.toggle('hidden', !active);
  next.classList.toggle('hidden', !active);
  prev.disabled = !active || playlistQueueIdx <= 0;
  next.disabled = !active || playlistQueueIdx >= playlistQueue.length - 1;
}

// ─── XTRACT (Manage tab) ─────────────────────────────────────────────────────
// Audio and Video sub-views maintain independent state: each remembers its own
// loaded file, concat extras, and form-field values. setXtractView() snapshots
// the current view into xtractState before swapping the DOM to the other.
let xtractInput = null;

// Cache "does this file have an audio stream?" by absolute path. Populated
// lazily by probeXtractInputAudio() the first time we see a file; cards
// tagged data-needs-audio are gated on this. Values: true / false / undefined
// (= probe still running or never started).
const xtractAudioPresence = new Map();

// Kick off (or short-circuit) the audio-presence probe for the active
// XTRACT input. Re-runs refreshXtractCards once the answer is known so the
// Split / Extract audio / Normalize cards switch off for silent videos.
async function probeXtractInputAudio(filePath) {
  if (!filePath) return;
  const kind = detectMediaKind(filePath);
  // Audio-typed inputs are trivially "has audio"; image inputs have no
  // audio relevance — neither needs the ffmpeg probe.
  if (kind === 'audio') { xtractAudioPresence.set(filePath, true); return; }
  if (kind === 'image') { xtractAudioPresence.set(filePath, false); return; }
  if (xtractAudioPresence.has(filePath)) {
    // Already resolved — refreshXtractCards already reads it.
    return;
  }
  try {
    const r = await window.api.xtract.hasAudio(filePath);
    if (r?.ok) xtractAudioPresence.set(filePath, !!r.hasAudio);
    else xtractAudioPresence.set(filePath, true);  // fail-open: don't disable cards on probe failure
  } catch {
    xtractAudioPresence.set(filePath, true);
  }
  // Only re-render if the user is still on this file.
  if (xtractInput === filePath) refreshXtractCards();
}

// Show or hide the toolbar Clear button depending on whether a file is
// currently loaded. Called after every xtractInput assignment so the
// toolbar visual matches the actual state.
function updateXtractClearButton() {
  const btn = document.getElementById('xtract-clear-btn');
  if (btn) btn.hidden = !xtractInput;
}

// Drop the currently loaded XTRACT file — clears the editors, info chip,
// concat list, and resets the file picker UI. Used by the Clear button.
function clearXtractInput() {
  xtractInput = null;
  xtractConcatExtras = [];
  // Drop any pending split-track candidates — they were tied to the file
  // that's leaving the editor.
  splitTracks = [];
  const splitList = document.getElementById('xtract-split-list');
  if (splitList) splitList.innerHTML = '';
  const splitSrc = document.getElementById('xtract-split-source');
  if (splitSrc) splitSrc.textContent = '';
  destroyImageEditor();
  destroyTrimEditor();
  // Compare panel keeps its own B-image reference + visible stage. Reset
  // here so the user doesn't see a "ghost" A/B comparison of a no-longer-
  // loaded file. The bind closure exposes no public refresh, so we drop
  // the state + add hidden manually.
  imgComparePathB = null;
  const cmpStage = document.getElementById('img-compare-stage');
  if (cmpStage) cmpStage.classList.add('hidden');
  ['img-compare-reset','img-compare-swap','img-compare-slider'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.classList.add('hidden'); el.disabled = true; }
  });
  const cmpInfo = document.getElementById('img-compare-info');
  if (cmpInfo) cmpInfo.style.display = 'none';
  const info = document.getElementById('xtract-file-info');
  if (info) {
    info.setAttribute('data-i18n', 'xtract_no_file');
    info.textContent = t('xtract_no_file');
  }
  const concatInfo = document.getElementById('xtract-concat-info');
  if (concatInfo) concatInfo.textContent = t('xtract_concat_none');
  refreshXtractCards();
  refreshTrimFormatDropdown(xtractCurrentView);
  refreshGifOptionsVisibility();
  updateXtractClearButton();
}
let xtractConcatExtras = [];
let xtractOpCounter = 0;
let xtractCurrentView = 'audio';

const xtractState = {
  audio: { input: null, concatExtras: [], values: {} },
  video: { input: null, concatExtras: [], values: {} },
  image: { input: null, concatExtras: [], values: {} }
};

const XTRACT_FIELD_IDS = [
  'xtract-audio-format',
  'xtract-trim-start',
  'xtract-trim-end',
  'xtract-trim-format',
  'trim-fadein-dur',
  'trim-fadeout-dur',
  'xtract-frame-at',
  'xtract-frame-format'
];

// Format options for the unified Trim+Convert dropdown. The set shown depends
// on the active sub-view (Audio shows audio codecs; Video shows containers +
// the two lossless audio codecs for video→audio extraction).
const TRIM_FORMAT_OPTIONS = {
  audio: [
    { value: 'mp3',  label: 'MP3'  },
    { value: 'flac', label: 'FLAC' },
    { value: 'm4a',  label: 'M4A'  },
    { value: 'wav',  label: 'WAV'  },
    { value: 'ogg',  label: 'OGG'  },
    { value: 'opus', label: 'Opus' }
  ],
  video: [
    { value: 'mp4',  label: 'MP4'  },
    { value: 'mkv',  label: 'MKV'  },
    { value: 'webm', label: 'WebM' },
    { value: 'gif',  label: 'GIF' },
    { value: 'mp3',  label: '♪ MP3'  },
    { value: 'flac', label: '♪ FLAC' }
  ]
};

// GIFs are treated as video here so Xtract's video cards (trim / convert /
// frame export / metadata) apply. ffmpeg reads .gif natively and can write
// it via the gif muxer — see TRIM_FORMATS below and the xtract:trim handler.
const VIDEO_EXTS = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'flv', 'wmv', 'gif']);
const AUDIO_EXTS = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav']);
const IMAGE_EXTS = new Set(['jpg','jpeg','png','webp','avif','tiff','tif','bmp','heic','heif','svg']);
const VIDEO_PICK_EXTS = ['mp4','mkv','webm','mov','avi','m4v','flv','wmv','gif'];
const AUDIO_PICK_EXTS = ['mp3','flac','m4a','wav','ogg','opus','aac'];
const IMAGE_PICK_EXTS = ['jpg','jpeg','png','webp','avif','tiff','tif','bmp','heic','heif','svg','pdf'];

function detectMediaKind(filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (IMAGE_EXTS.has(ext)) return 'image';
  return 'unknown';
}

function bindXtract() {
  const pickBtn = document.getElementById('xtract-pick-btn');
  if (!pickBtn) return;
  // Sub-view switching is now driven by the sidebar (Xtract > Audio / Video).
  // switchTab() calls setXtractView() based on data-xtract-view on the nav item.

  // ffmpeg availability check on tab init.
  window.api.xtract.checkFfmpeg().then(r => {
    const el = document.getElementById('xtract-ffmpeg-status');
    if (!el) return;
    if (r.ok) {
      el.textContent = '';
    } else {
      el.textContent = t('xtract_ffmpeg_missing');
      el.classList.add('missing');
    }
  });

  // Live progress: ffmpeg sends percentages keyed by opId.
  window.api.xtract.onProgress(({ opId, pct }) => {
    const bar = document.querySelector(`.progress-bar-bg[data-op-id="${opId}"]`);
    if (!bar) return;
    bar.querySelector('.progress-bar').style.width = pct + '%';
    bar.querySelector('.progress-bar-text').textContent = pct + '%';
  });

  // Clear button — unloads the current input and tears down both editors so
  // the toolbar goes back to "No file loaded". Hidden until a file is set
  // (see updateXtractClearButton, called whenever xtractInput changes).
  document.getElementById('xtract-clear-btn')?.addEventListener('click', () => {
    clearXtractInput();
  });

  pickBtn.addEventListener('click', async () => {
    // File picker is scoped to the active view's media kind so Audio and
    // Video workspaces don't bleed into each other. Power users can still
    // override via the "All" filter.
    const view = xtractCurrentView;
    const filterMap = {
      audio: { name: 'Audio', exts: AUDIO_PICK_EXTS },
      video: { name: 'Video', exts: VIDEO_PICK_EXTS },
      image: { name: 'Images', exts: IMAGE_PICK_EXTS }
    };
    const cfg = filterMap[view] || filterMap.audio;
    const r = await window.api.dialog.pickFile({
      filters: [
        { name: cfg.name, extensions: cfg.exts },
        { name: 'All', extensions: ['*'] }
      ]
    });
    if (!r) return;
    // PDF + image view: divert to the page picker. The user chooses which
    // page; we rasterise just that one and continue as if they'd picked a
    // PNG directly. PDFs in audio/video view fall through to the regular
    // "this format is unsupported" path.
    if (view === 'image' && /\.pdf$/i.test(r)) {
      await openXtractPdfPagePicker(r);
      return;
    }
    xtractInput = r;
    xtractConcatExtras = [];
    updateXtractClearButton();
    const info = document.getElementById('xtract-file-info');
    info.textContent = r.split(/[\\/]/).pop();
    document.getElementById('xtract-concat-info').textContent = t('xtract_concat_none');
    refreshXtractCards();
    probeXtractInputAudio(r);  // async; will re-refresh once known if it's a silent video
    refreshTrimFormatDropdown(xtractCurrentView);  // re-filter on file change (GIF strips audio outputs)
    refreshGifOptionsVisibility();
    // Surface the file duration / dimensions so the user can't enter trim/
    // frame values beyond the file length (the common HH:MM:SS slot mixup).
    // For images this path skips silently since xtract:probe is ffmpeg-driven.
    if (view !== 'image') {
      window.api.xtract.probe({ input: r }).then(p => {
        if (xtractInput !== r) return; // user already picked a different file
        if (p?.ok) info.textContent = `${r.split(/[\\/]/).pop()}  ·  ${p.formatted}`;
      }).catch(() => {});
      ensureTrimEditor(r);
      destroyImageEditor();
    } else {
      // Image view: mount the crop canvas. Destroy any open trim editor first.
      destroyTrimEditor();
      ensureImageEditor(r);
    }
  });

  // Concat secondary picker — uses the same per-view filter as the primary.
  document.getElementById('xtract-concat-pick-btn')?.addEventListener('click', async () => {
    if (!xtractInput) return;
    const isVideo = xtractCurrentView === 'video';
    const exts = isVideo ? VIDEO_PICK_EXTS : AUDIO_PICK_EXTS;
    const r = await window.api.dialog.pickFile({
      filters: [{ name: isVideo ? 'Video' : 'Audio', extensions: exts }]
    });
    if (!r) return;
    xtractConcatExtras.push(r);
    document.getElementById('xtract-concat-info').textContent = t('xtract_concat_count', { n: xtractConcatExtras.length });
  });

  // Card Run buttons
  document.getElementById('xtract-audio-btn').addEventListener('click', () => runXtract('audio',   { format: document.getElementById('xtract-audio-format').value }));
  // The unified trim+convert button runs xtract:trim, picking the output
  // format from the inline dropdown. Fades are read from the icon-only
  // toggle buttons (`.fade-toggle-btn.active`) — when off, duration is 0.
  document.getElementById('xtract-trim-btn').addEventListener('click', () => {
    const fadeInOn  = document.getElementById('trim-fadein-toggle')?.classList.contains('active');
    const fadeOutOn = document.getElementById('trim-fadeout-toggle')?.classList.contains('active');
    const fadeIn    = fadeInOn  ? Math.max(0, parseFloat(document.getElementById('trim-fadein-dur').value)  || 0) : 0;
    const fadeOut   = fadeOutOn ? Math.max(0, parseFloat(document.getElementById('trim-fadeout-dur').value) || 0) : 0;
    // Forward GIF tuning knobs only when relevant. Backend ignores `gif`
    // when neither input nor output is gif, so always-sending is safe — but
    // saves bytes/clarity to gate it here. parseInt with NaN-guard so a
    // blank input doesn't poison the payload.
    const fmt = document.getElementById('xtract-trim-format').value;
    const inIsGif = !!xtractInput && xtractInput.toLowerCase().endsWith('.gif');
    let gif = null;
    if (fmt === 'gif' || inIsGif) {
      const fps    = parseInt(document.getElementById('xtract-gif-fps')?.value, 10);
      const width  = parseInt(document.getElementById('xtract-gif-width')?.value, 10);
      const dither = document.getElementById('xtract-gif-dither')?.value || 'bayer';
      gif = {
        fps:    Number.isFinite(fps)   ? Math.max(5, Math.min(30, fps))    : 15,
        width:  Number.isFinite(width) ? width                              : 480,
        dither: ['bayer','sierra2','floyd_steinberg','none'].includes(dither) ? dither : 'bayer'
      };
    }
    runXtract('trim', {
      start: document.getElementById('xtract-trim-start').value.trim(),
      end:   document.getElementById('xtract-trim-end').value.trim(),
      outputFormat: fmt,
      fadeIn, fadeOut,
      gif
    });
  });
  bindTrimEditorControls();
  // Populate the unified trim+convert format dropdown for the initial view.
  refreshTrimFormatDropdown(xtractCurrentView);
  // Hide / show the fade controls whenever the user changes output format.
  document.getElementById('xtract-trim-format')?.addEventListener('change', refreshFadeControlsVisibility);
  document.getElementById('xtract-subs-btn').addEventListener('click',   () => runXtract('subs',     {}));
  document.getElementById('xtract-subs-find-online-btn').addEventListener('click', () => openSubsSearchModal());
  document.getElementById('xtract-frame-btn').addEventListener('click',  () => runXtract('frame',    {
    at:     document.getElementById('xtract-frame-at').value.trim(),
    format: document.getElementById('xtract-frame-format').value
  }));
  document.getElementById('xtract-concat-btn').addEventListener('click', () => runXtract('concat',   { extras: xtractConcatExtras }));
  document.getElementById('xtract-meta-btn').addEventListener('click',   () => runXtract('meta',     {}));
  document.getElementById('xtract-normalize-btn').addEventListener('click', () => runXtract('normalize', {}));
}

// Snapshot the active view's live state (file, extras, form values) into
// xtractState so it can be restored when the user comes back to this view.
function saveXtractViewState() {
  const s = xtractState[xtractCurrentView];
  s.input = xtractInput;
  s.concatExtras = xtractConcatExtras.slice();
  s.values = {};
  for (const id of XTRACT_FIELD_IDS) {
    const el = document.getElementById(id);
    if (el) s.values[id] = el.value;
  }
}

// Apply a view's saved state to the DOM. First entry into a view has empty
// `values`; text inputs are cleared and selects reset to the first option so
// the workspace starts fresh.
function applyXtractViewState(view) {
  const s = xtractState[view];
  xtractInput = s.input;
  updateXtractClearButton();
  if (xtractInput) probeXtractInputAudio(xtractInput);  // gate audio cards (silent-video check)
  xtractConcatExtras = s.concatExtras.slice();
  for (const id of XTRACT_FIELD_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (s.values[id] !== undefined) {
      el.value = s.values[id];
    } else if (el.tagName === 'SELECT') {
      el.selectedIndex = 0;
    } else {
      // Fall back to the HTML default (e.g. value="2.0" on fade duration
      // inputs) instead of clearing — otherwise switching views wipes the
      // sensible defaults set in markup.
      el.value = el.defaultValue || '';
    }
  }
  const info = document.getElementById('xtract-file-info');
  if (info) info.textContent = xtractInput ? xtractInput.split(/[\\/]/).pop() : t('xtract_no_file');
  const cinfo = document.getElementById('xtract-concat-info');
  if (cinfo) {
    cinfo.textContent = xtractConcatExtras.length
      ? t('xtract_concat_count', { n: xtractConcatExtras.length })
      : t('xtract_concat_none');
  }
}

function setXtractView(view) {
  if (view !== 'audio' && view !== 'video' && view !== 'image') return;
  const grid = document.getElementById('xtract-grid');
  if (!grid) return;
  if (view !== xtractCurrentView) {
    saveXtractViewState();
    xtractCurrentView = view;
    applyXtractViewState(view);
  }
  grid.dataset.view = view;
  // Sync the sidebar highlighting — the audio/video nav items both share
  // data-tab="xtract", so we use data-xtract-view to distinguish.
  document.querySelectorAll('.nav-item[data-tab="xtract"]').forEach(n =>
    n.classList.toggle('active', n.dataset.xtractView === view));
  refreshXtractCards();
  refreshTrimFormatDropdown(view);
  refreshGifOptionsVisibility();
  refreshCaptureButton();
  // The "ffmpeg missing" status is irrelevant in the image view (sharp is
  // bundled) — hide it so it never reads as "image tools need ffmpeg".
  const ffStatus = document.getElementById('xtract-ffmpeg-status');
  if (ffStatus) ffStatus.style.display = (view === 'image') ? 'none' : '';
  // Visual editor mount: audio/video → WaveSurfer trim editor; image →
  // crop canvas. Cross-mount destruction keeps the two from competing.
  if (view === 'image') {
    destroyTrimEditor();
    if (xtractInput) ensureImageEditor(xtractInput);
    else destroyImageEditor();
  } else {
    destroyImageEditor();
    if (xtractInput) ensureTrimEditor(xtractInput);
    else destroyTrimEditor();
  }
}

// Populate the unified trim+convert format dropdown based on the active view.
// Tries to preserve the current selection if still valid in the new option set.
function refreshTrimFormatDropdown(view) {
  const sel = document.getElementById('xtract-trim-format');
  if (!sel) return;
  let opts = TRIM_FORMAT_OPTIONS[view] || TRIM_FORMAT_OPTIONS.audio;
  // GIF has no audio track — filter out audio-only output formats so the
  // user can't pick something that would fail at ffmpeg time. Match by
  // value against the shared AUDIO_OUTPUT_FORMATS set (label-text matching
  // would break the moment we rename the visible label).
  const inIsGif = !!xtractInput && xtractInput.toLowerCase().endsWith('.gif');
  if (inIsGif) opts = opts.filter(o => !AUDIO_OUTPUT_FORMATS.has(o.value));
  const prev = sel.value;
  sel.innerHTML = '';
  for (const o of opts) {
    const el = document.createElement('option');
    el.value = o.value;
    el.textContent = o.label;
    sel.appendChild(el);
  }
  if (opts.some(o => o.value === prev)) sel.value = prev;
  // The output format controls whether ffmpeg can apply audio fades — only
  // audio codecs (mp3/flac/m4a/wav/ogg/opus) accept the afade filter chain.
  refreshFadeControlsVisibility();
}

// Show fade buttons + duration inputs only when the chosen output format is
// audio. For video output (mp4/mkv/webm) re-encoding the audio track + video
// with fades is out of scope, so we hide the controls instead of letting the
// user toggle them and then getting "no codec" errors at run time.
const AUDIO_OUTPUT_FORMATS = new Set(['mp3', 'flac', 'm4a', 'aac', 'wav', 'ogg', 'opus']);
function refreshFadeControlsVisibility() {
  const sel = document.getElementById('xtract-trim-format');
  const fmt = sel?.value || 'mp3';
  const isAudio = AUDIO_OUTPUT_FORMATS.has(fmt);
  const ids = ['trim-fadein-toggle', 'trim-fadein-dur', 'trim-fadeout-toggle', 'trim-fadeout-dur'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !isAudio);
  });
  // GIF knobs piggy-back on the format change too: visible whenever the
  // input file is gif OR the output format is gif. Fade-row + GIF-row are
  // logically exclusive (gif has no audio to fade), so they never overlap.
  refreshGifOptionsVisibility();
}

function refreshGifOptionsVisibility() {
  const row = document.getElementById('trim-gif-options');
  if (!row) return;
  const sel = document.getElementById('xtract-trim-format');
  const outIsGif = (sel?.value || '') === 'gif';
  const inIsGif  = !!xtractInput && xtractInput.toLowerCase().endsWith('.gif');
  row.classList.toggle('hidden', !(outIsGif || inIsGif));
}

// Enable only the cards whose `data-applies-to` matches the detected media
// kind. Cards stay at opacity 0.5 + pointer-events:none until enabled.
// No longer auto-switches the sub-view: each view owns its own file, so the
// pick handler keeps the file in the workspace where the user picked it.
function refreshXtractCards() {
  const kind = xtractInput ? detectMediaKind(xtractInput) : null;
  // Audio-presence is cached per filePath; for unprobed files this is
  // undefined → treat as "has audio" (fail-open) so the UI doesn't blink
  // off-then-on while the probe runs. probeXtractInputAudio() re-calls us
  // when the verdict lands.
  const hasAudio = xtractInput ? xtractAudioPresence.get(xtractInput) : undefined;
  const audioPresent = hasAudio !== false;  // undefined or true → enable
  document.querySelectorAll('#xtract-grid .xtract-card').forEach(card => {
    const applies = card.dataset.appliesTo;
    const needsAudio = card.dataset.needsAudio === 'true';
    let enabled = !!kind && (
      applies === 'any' ||
      (applies === 'video' && kind === 'video') ||
      (applies === 'audio' && (kind === 'audio' || kind === 'video')) ||
      (applies === 'image' && kind === 'image')
    );
    // Silent-video gate: cards that perform audio-only operations
    // (Split / Extract audio / Normalize) make no sense on a video with
    // no audio track. The probe sets audioPresent=false in that case.
    if (enabled && needsAudio && !audioPresent) enabled = false;
    card.classList.toggle('is-enabled', enabled);
    card.querySelectorAll('button').forEach(b => { b.disabled = !enabled; });
  });
}

// ─── OPENSUBTITLES — find .srt online for the loaded video ─────────────────
// User picks a video in XTRACT, clicks "Find online". We hash the file
// (OS moviehash algo), POST search to api.opensubtitles.com using the
// user's API key, render results, on row click stream the .srt next to
// the source file. All three IPC calls (hash/search/download) live in
// main.js since the renderer can't open binary files in Node mode.
function guessSubsQueryFromFilename(filePath) {
  if (!filePath) return '';
  let name = filePath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  // Strip release tags that confuse free-text search: resolutions, codecs,
  // release groups, container hints, year-in-brackets, dots-as-spaces.
  name = name.replace(/[._-]+/g, ' ');
  name = name.replace(/\b(1080p|720p|480p|2160p|4k|hdr|bluray|web-?dl|webrip|hdrip|x264|x265|h\.?264|h\.?265|hevc|aac|ac3|dts|10bit)\b/gi, '');
  name = name.replace(/\b\[?[a-z0-9-]{2,}\]?$/i, '');   // trailing release tag
  name = name.replace(/\s{2,}/g, ' ').trim();
  return name;
}

async function openSubsSearchModal() {
  if (!xtractInput) return;
  const modal   = document.getElementById('subs-search-modal');
  const queryEl = document.getElementById('subs-search-query');
  const langEl  = document.getElementById('subs-search-lang');
  const tbody   = document.getElementById('subs-search-tbody');
  const apiKey  = (config.opensubs_key || '').trim();

  modal.classList.remove('hidden');
  queryEl.value = guessSubsQueryFromFilename(xtractInput);
  // Default the search language to the user's current UI lang (works for
  // most cases since the UI lang ≈ the subtitle they want).
  const uiLang = (config.lang === 'system' || !config.lang) ? systemLang : config.lang;
  if ([...langEl.options].some(o => o.value === uiLang)) langEl.value = uiLang;

  if (!apiKey) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted" style="text-align:center;padding:16px">${esc(t('subs_no_api_key'))}</td></tr>`;
    return;
  }
  doSubsSearch();
}

async function doSubsSearch() {
  const tbody   = document.getElementById('subs-search-tbody');
  const btn     = document.getElementById('subs-search-btn');
  const queryEl = document.getElementById('subs-search-query');
  const langEl  = document.getElementById('subs-search-lang');
  const apiKey  = (config.opensubs_key || '').trim();
  if (!apiKey) return;
  btn.classList.add('btn-loading'); btn.disabled = true;
  tbody.innerHTML = `<tr><td colspan="6" class="muted" style="text-align:center;padding:16px">${esc(t('subs_searching'))}</td></tr>`;
  // Hash first — accurate matches win over title search. Fail-soft: if the
  // hash can't be computed (small file, IO error) we still send the query.
  let moviehash = null;
  try {
    const h = await window.api.subs.hash({ filePath: xtractInput });
    if (h.ok) moviehash = h.hash;
  } catch {}

  const r = await window.api.subs.search({
    apiKey,
    query:     queryEl.value.trim() || undefined,
    moviehash: moviehash || undefined,
    languages: langEl.value
  });
  btn.classList.remove('btn-loading'); btn.disabled = false;

  if (!r.ok) {
    const msg = r.error === 'invalid_key'   ? t('subs_err_invalid_key')
              : r.error === 'rate_limited'  ? t('subs_err_rate_limited')
              : r.error === 'no_key'        ? t('subs_no_api_key')
              : `${t('subs_err_generic')}: ${r.error}`;
    tbody.innerHTML = `<tr><td colspan="6" class="muted" style="text-align:center;padding:16px;color:var(--danger)">${esc(msg)}</td></tr>`;
    return;
  }
  if (!r.results.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted" style="text-align:center;padding:16px">${esc(t('subs_no_results'))}</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  r.results.slice(0, 50).forEach((s, i) => {
    const tr = document.createElement('tr');
    const matchBadge = s.fromHash
      ? `<span class="dl-item-status done">${esc(t('subs_match_hash'))}</span>`
      : `<span class="dl-item-status pending">${esc(t('subs_match_title'))}</span>`;
    tr.innerHTML = `
      <td class="td-num">${i + 1}</td>
      <td class="td-name" title="${esc(s.release)}">${esc(s.release.length > 60 ? s.release.substring(0, 57) + '…' : s.release)}</td>
      <td class="td-dim">${esc(s.language)}</td>
      <td class="td-dim">${s.downloads}</td>
      <td>${matchBadge}</td>
      <td class="td-actions">
        <button class="btn-icon" data-dl-id="${s.id}" data-lucide-icon="download" title="${esc(t('subs_download_btn'))}"></button>
      </td>`;
    tbody.appendChild(tr);
  });
  applyLucideIcons(tbody);
  tbody.querySelectorAll('[data-dl-id]').forEach(b =>
    b.addEventListener('click', () => doSubsDownload(parseInt(b.dataset.dlId, 10), b)));
}

async function doSubsDownload(fileId, btn) {
  const apiKey = (config.opensubs_key || '').trim();
  if (!apiKey || !xtractInput) return;
  const dirSlash = xtractInput.replace(/[\\/][^\\/]+$/, '');
  const baseName = xtractInput.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  btn.classList.add('btn-loading'); btn.disabled = true;
  appendLog('xtract-log', t('subs_downloading'), 'info');
  const r = await window.api.subs.download({
    apiKey, fileId, targetDir: dirSlash, baseName
  });
  btn.classList.remove('btn-loading'); btn.disabled = false;
  if (r.ok) {
    appendLog('xtract-log', `✓ ${t('subs_downloaded', { path: r.path })}`, 'ok');
    showToast({ title: t('subs_downloaded_title'), body: r.path, kind: 'ok', ttl: 4000 });
    // Optionally surface the remaining quota — useful since OS free tier
    // is only 200 dl/day. We log it rather than nag the user with toasts.
    if (typeof r.remaining === 'number') {
      appendLog('xtract-log', t('subs_quota_left', { n: r.remaining }), 'log');
    }
    document.getElementById('subs-search-modal').classList.add('hidden');
  } else {
    const msg = r.error === 'invalid_key'    ? t('subs_err_invalid_key')
              : r.error === 'quota_exceeded' ? t('subs_err_quota_exceeded')
              : `${t('subs_err_generic')}: ${r.error}`;
    appendLog('xtract-log', `✗ ${msg}`, 'error');
    showToast({ title: t('subs_err_title'), body: msg, kind: 'err', ttl: 6000 });
  }
}

function bindSubsSearchModal() {
  document.getElementById('subs-search-btn')?.addEventListener('click', () => doSubsSearch());
  document.getElementById('subs-search-close')?.addEventListener('click', () =>
    document.getElementById('subs-search-modal').classList.add('hidden'));
  document.getElementById('subs-search-query')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doSubsSearch();
  });
}

// ─── TRIM VISUAL EDITOR (WaveSurfer-backed) ─────────────────────────────────
// Lazy-loaded on first use. Renders a waveform of the loaded audio file with
// a draggable region (start/end markers), play-selection button, and fade
// controls. Active only on the Audio sub-view; teardown on view switch.
let trimEditor = null;       // { ws, regions, region }
let trimEditorFile = null;
let trimEditorLibs = null;   // cached dynamic-import result

// Two-way sync gate: when the region updates the time inputs (or vice-versa)
// the change event would loop without this.
let trimEditorSyncing = false;

function parseTrimTime(s) {
  if (s == null) return null;
  const str = String(s).trim().replace(',', '.');
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  const parts = str.split(':');
  if (parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(parseFloat);
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  return null;
}

function formatTrimTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ds = Math.floor((sec - Math.floor(sec)) * 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${ds}`;
}

function localFileURL(p) {
  // Windows paths: backslashes → forward, then encodeURI to escape spaces /
  // accents while preserving the drive-letter colon and slashes.
  return 'file:///' + encodeURI(p.replace(/\\/g, '/'));
}

async function loadTrimEditorLibs() {
  if (trimEditorLibs) return trimEditorLibs;
  const [wsMod, rgMod] = await Promise.all([
    import('./vendor/wavesurfer.esm.js'),
    import('./vendor/wavesurfer.regions.esm.js')
  ]);
  trimEditorLibs = { WaveSurfer: wsMod.default, RegionsPlugin: rgMod.default };
  return trimEditorLibs;
}

// Generation counter — each ensureTrimEditor call bumps this. The decode-
// timeout setTimeout captures the value at scheduling time and bails if it
// doesn't match the current generation by the time it fires. Without this,
// a timeout from a previous call would keep showing the "decode timed out"
// toast after the user already loaded another file successfully.
let _trimEditorGen = 0;

async function ensureTrimEditor(filePath) {
  const kind = filePath ? detectMediaKind(filePath) : null;
  if (kind !== 'audio' && kind !== 'video') { destroyTrimEditor(); return; }
  // NB: removed the previous `same path → skip` early-return. The user can
  // re-record into the same path (or the file can be re-saved with new
  // content while keeping the same name), and skipping the reload would
  // leave the trim editor on the OLD audio/video. Re-mounting is cheap.

  destroyTrimEditor();
  const myGen = ++_trimEditorGen;
  trimEditorFile = filePath;
  const editorEl = document.getElementById('trim-editor');
  const waveEl   = document.getElementById('trim-waveform');
  const videoEl  = document.getElementById('xtract-video-preview');
  const gifEl    = document.getElementById('xtract-gif-preview');
  const gifInfo  = document.getElementById('xtract-gif-info');
  if (!editorEl || !waveEl) return;
  editorEl.classList.remove('hidden');
  waveEl.classList.remove('is-ready');

  // GIF needs a different path entirely: <video> can't render animated GIFs
  // and WaveSurfer can't decode audio that isn't there. Show the file via
  // <img> (which auto-loops), probe duration via ffmpeg, and pre-fill the
  // time inputs with [0, fullDuration] so the convert button works without
  // the user having to type anything.
  const ext = filePath.split('.').pop().toLowerCase();
  const isGif = ext === 'gif';
  if (isGif) {
    if (videoEl) { videoEl.classList.add('hidden'); videoEl.removeAttribute('src'); try { videoEl.load(); } catch {} }
    if (gifEl)   { gifEl.classList.remove('hidden'); gifEl.src = localFileURL(filePath); }
    waveEl.style.display = 'none';
    // Probe duration so we can pre-populate the trim end input. Without
    // this, the user has to guess or scrub externally — annoying for a 5-
    // minute 300 MB GIF.
    try {
      const r = await window.api.xtract.probeDuration(filePath);
      const dur = r.ok ? r.duration : 0;
      if (gifInfo) {
        gifInfo.classList.remove('hidden');
        gifInfo.textContent = dur > 0
          ? t('xtract_gif_duration', { dur: formatTrimTime(dur) })
          : t('xtract_gif_no_duration');
      }
      const startEl = document.getElementById('xtract-trim-start');
      const endEl   = document.getElementById('xtract-trim-end');
      if (startEl) startEl.value = '00:00.0';
      if (endEl && dur > 0) endEl.value = formatTrimTime(dur);
      // Disable fade controls — no audio to fade.
      ['trim-fadein-toggle','trim-fadein-dur','trim-fadeout-toggle','trim-fadeout-dur'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = true;
      });
      trimEditor = { ws: null, regions: null, region: null, isGif: true, duration: dur };
    } catch (e) {
      appendLog('xtract-log', `✗ ${e.message}`, 'error');
    }
    return;
  }

  const isVideo = kind === 'video';
  if (videoEl) {
    videoEl.classList.toggle('hidden', !isVideo);
    // Hard reset of the previous source — pause + clear src + load() to
    // flush the decoder/buffer chain. Then set the new src directly.
    // NB: we previously appended a `?v=...` nonce here for cache-busting,
    // but Chromium's file:// loader does NOT strip query strings — it
    // looks for a file literally named "foo.webm?v=xyz" and fails with
    // "Failed to fetch". The ms-precision timestamp in our save paths
    // already prevents stale URL caching, so the nonce is redundant.
    try { videoEl.pause(); } catch {}
    videoEl.removeAttribute('src');
    try { videoEl.load(); } catch {}
    if (isVideo) {
      videoEl.src = localFileURL(filePath);
      try { videoEl.load(); } catch {}
    }
  }
  if (gifEl) gifEl.classList.add('hidden');
  waveEl.style.display = '';

  let libs;
  try { libs = await loadTrimEditorLibs(); }
  catch (e) { appendLog('xtract-log', `✗ Trim editor failed to load: ${e.message}`, 'error'); return; }
  // The user may have already switched away while WaveSurfer was loading.
  if (trimEditorFile !== filePath) return;

  const { WaveSurfer, RegionsPlugin } = libs;
  const regions = RegionsPlugin.create();
  // For video, attach WaveSurfer to the existing <video> via `media:` so
  // scrub/play stays in sync with the visual preview. For audio, ws fetches
  // and decodes the file itself.
  // Brand accent (lime/yellow) for both the waveform fill and the selection
  // region — matches the rest of the FLUX UI. Pulled from the CSS var so a
  // future theme tweak only needs to touch styles.css.
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c8f542';
  const wsOptions = {
    container: waveEl,
    height: 100,
    waveColor:     accent,
    progressColor: accent,
    cursorColor:   '#fff',
    cursorWidth:   2,
    barWidth:      2,
    barGap:        1,
    barRadius:     1,
    normalize:     true,
    plugins:       [regions]
  };
  if (isVideo && videoEl) wsOptions.media = videoEl;
  const ws = WaveSurfer.create(wsOptions);

  let region = null;
  let decodeFired = false;
  ws.on('decode', () => {
    decodeFired = true;
    waveEl.classList.add('is-ready');
    const dur = ws.getDuration();
    region = regions.addRegion({
      start: 0,
      end: dur,
      drag: true,
      resize: true,
      // 22% accent fill so the selection contrasts with the (now transparent)
      // background waveform without occluding it.
      color: 'rgba(200, 245, 66, 0.22)'
    });
    syncTimeInputsFromRegion(region);
    trimEditor.region = region;
    // Now that the region exists, paint the initial fade overlay.
    renderFadeOverlay();
  });

  // Error + timeout safety net. The waveform "stuck on Loading…" symptom
  // had no visible error before — turns out WaveSurfer was hitting a decode
  // failure (or a fetch hang) silently. Now: surface errors to the activity
  // log, and after 8 s of no decode event, fall back to ffmpeg's probe for
  // duration so the user can still trim by typing times even if the
  // waveform never appears.
  ws.on('error', (err) => {
    const msg = err?.message || (typeof err === 'string' ? err : 'unknown decode error');
    // AbortError is benign — happens when a new ws.load() supersedes a
    // pending fetch, or when destroyTrimEditor is called mid-load.
    if (/abort/i.test(msg) || err?.name === 'AbortError') {
      console.warn('[trim-editor] WaveSurfer fetch aborted (benign):', msg);
      return;
    }
    // "Unable to decode audio data" on a video file usually means the video
    // simply has no audio track. Don't toast at the user — just transition
    // the waveform area to the "no audio" empty state and seed the time
    // inputs from ffprobe so trim still works.
    if (/unable to decode audio|no audio|not contain audio/i.test(msg)) {
      console.warn('[trim-editor] No audio track in file — waveform disabled');
      appendLog('xtract-log', '⚠ No audio track — waveform unavailable; trim by typing times', 'warn');
      waveEl.classList.add('is-ready');
      waveEl.classList.add('has-error');
      // Use ffprobe to seed start/end inputs.
      window.api.xtract.probeDuration(filePath).then(r => {
        if (r?.ok && r.duration > 0) {
          const startEl = document.getElementById('xtract-trim-start');
          const endEl   = document.getElementById('xtract-trim-end');
          if (startEl) startEl.value = '00:00.0';
          if (endEl)   endEl.value   = formatTrimTime(r.duration);
          if (trimEditor) trimEditor.duration = r.duration;
        }
      }).catch(() => {});
      return;
    }
    console.error('[trim-editor] WaveSurfer error:', err);
    // Format-specific guidance — WebM with VP9/AV1 video + Opus audio
    // fairly often trips Chromium's MEDIA_ELEMENT_ERROR decoder. The fix
    // for the user is to remux to a known-good container (MP4 H.264 +
    // AAC) via this same Trim & Convert card.
    const isWebmFormatErr = /MEDIA_ELEMENT_ERROR|Format error/i.test(msg) && /\.webm$/i.test(filePath);
    const isFormatErrGeneric = /MEDIA_ELEMENT_ERROR|Format error|unsupported/i.test(msg);
    let toastBody = msg;
    if (isWebmFormatErr) {
      toastBody = 'WebM decoder error — Chromium can\'t decode this container/codec combo. Convert to MP4 via Trim & Convert (Format: MP4) and re-load the result.';
    } else if (isFormatErrGeneric) {
      toastBody = `${msg}\n\nTip: convert to MP4 or MP3 via Trim & Convert and reload the result.`;
    }
    // For format-error cases we KNOW about, log as 'warn' (no auto-toast)
    // so the user gets only the ONE actionable hint toast — not the raw
    // technical error stacked on top. Other (unknown) errors still log
    // as 'error' and get auto-toasted as before.
    if (isWebmFormatErr || isFormatErrGeneric) {
      appendLog('xtract-log', `⚠ Format error — ${msg}`, 'warn');
    } else {
      appendLog('xtract-log', `✗ Waveform error: ${msg}`, 'error');
    }
    showToast({ title: 'Waveform error', body: toastBody, kind: 'warn', ttl: isWebmFormatErr ? 10000 : 7000 });
    waveEl.classList.add('is-ready');
    waveEl.classList.add('has-error');
  });
  // Timeout for the WaveSurfer decode. Bumped from 6 s to 30 s — a 150 MB
  // video on a spinning disk legitimately takes that long to fetch+decode
  // and we were timing out before completion. The fallback path (ffprobe
  // for duration so the time inputs work) is only useful when the decode
  // genuinely fails; for slow disks we want to wait.
  // Generation guard: if a SUBSEQUENT ensureTrimEditor call happened (user
  // loaded another file, or our drop handler re-triggered), our `myGen`
  // captured at scheduling time no longer matches the current generation,
  // and this timeout is for a destroyed editor — bail silently.
  setTimeout(async () => {
    if (myGen !== _trimEditorGen) return;
    if (decodeFired || trimEditorFile !== filePath) return;
    appendLog('xtract-log', `⚠ Waveform timed out — falling back to ffprobe for duration`, 'warn');
    console.warn('[trim-editor] WaveSurfer decode timeout — fallback active');
    showToast({ title: 'Waveform unavailable', body: 'Decode timed out — use the time inputs below to trim.', kind: 'warn', ttl: 8000 });
    waveEl.classList.add('is-ready');
    waveEl.classList.add('has-error');
    try {
      const r = await window.api.xtract.probeDuration(filePath);
      if (r?.ok && r.duration > 0) {
        const startEl = document.getElementById('xtract-trim-start');
        const endEl   = document.getElementById('xtract-trim-end');
        if (startEl) startEl.value = '00:00.0';
        if (endEl)   endEl.value   = formatTrimTime(r.duration);
        if (trimEditor) trimEditor.duration = r.duration;
      }
    } catch (e) {
      appendLog('xtract-log', `✗ ffprobe duration also failed: ${e.message}`, 'error');
    }
  }, 30_000);
  regions.on('region-updated', (r) => {
    if (!trimEditor || r !== trimEditor.region) return;
    syncTimeInputsFromRegion(r);
  });
  // Reflect playback state on the trim editor's play button — icon flips
  // play↔pause so the user has a clear handle to stop the preview.
  // NB: applyLucideIcons selects DESCENDANTS of its root by querySelector, so
  // we pass btn.parentElement (the row) rather than btn itself — the same
  // pattern the global player pause button uses.
  const setTrimPlayBtnIcon = (name) => {
    const btn = document.getElementById('trim-play-btn');
    if (!btn) return;
    btn.setAttribute('data-lucide-icon', name);
    applyLucideIcons(btn.parentElement || document);
  };
  ws.on('play',   () => setTrimPlayBtnIcon('pause'));
  ws.on('pause',  () => setTrimPlayBtnIcon('play'));
  ws.on('finish', () => setTrimPlayBtnIcon('play'));
  // For video, WaveSurfer drives playback via the <video> media element — the
  // ws 'play'/'pause' events DO fire (the v7 player wraps them) but we also
  // listen on the element directly as a belt-and-braces safety net in case
  // a future ws version changes the event propagation.
  if (isVideo && videoEl) {
    videoEl.addEventListener('play',  () => setTrimPlayBtnIcon('pause'));
    videoEl.addEventListener('pause', () => setTrimPlayBtnIcon('play'));
    videoEl.addEventListener('ended', () => setTrimPlayBtnIcon('play'));
  }
  // Always call .load(url) — for audio it fetches + decodes for the waveform;
  // for video it ALSO fetches for the waveform peaks (the attached <video>
  // handles playback, but WaveSurfer needs the URL separately for peaks
  // generation). Previously skipped for video on the assumption that
  // WaveSurfer would auto-pick up media.src, which is unreliable in v7 —
  // result: video waveforms stayed in "loading…" indefinitely.
  // Plain file:// URL — same reasoning as the <video> src: Chromium's
  // file:// loader doesn't strip query strings, so a `?v=...` nonce was
  // breaking the fetch outright with "Failed to fetch".
  // Catch the AbortError that WaveSurfer rethrows when ws.destroy() races
  // with an in-flight fetch — it fires `on('error')` AND rejects the
  // load promise, so we need both handlers to avoid an unhandled-rejection
  // banner in DevTools.
  ws.load(localFileURL(filePath)).catch(err => {
    if (err?.name === 'AbortError' || /abort/i.test(err?.message || '')) return;
    // Real errors are already surfaced by the `on('error')` handler above;
    // we just want to silence the unhandled-rejection noise here.
  });

  trimEditor = { ws, regions, region: null };

  // Live fade preview: while playing, modulate the media element's volume
  // to mirror the visual fade-in / fade-out curves. WaveSurfer drives the
  // media element directly (own MediaElementSource for audio mode; the
  // attached <video> for video mode), and `.volume` is the one property
  // both paths respect uniformly — so we set it from a RAF loop rather
  // than going through Web Audio (which would conflict with WS's source
  // routing).
  ws.on('play', () => {
    startFadePreview();
  });
  ws.on('pause',  stopFadePreview);
  ws.on('finish', () => { stopFadePreview(); resetMediaVolume(); });

  // Re-render the visual overlay whenever the region OR the fade controls
  // change. The handlers are added once per ensureTrimEditor call; on the
  // next destroy/re-create cycle they're discarded along with `regions`.
  regions.on('region-updated', () => renderFadeOverlay());
  ['trim-fadein-toggle','trim-fadeout-toggle','trim-fadein-dur','trim-fadeout-dur']
    .forEach(id => document.getElementById(id)?.addEventListener('input', renderFadeOverlay));
  // Initial draw — region may not exist yet (decode fires later), so the
  // function bails gracefully and is re-invoked from the decode handler
  // above via the region-updated event when the initial region is added.
  renderFadeOverlay();
}

// Read the current fade params from the toolbar — same source of truth the
// ffmpeg "trim & convert" call uses, so what the user sees and hears matches
// what they'll get on save.
function readFadeParams() {
  const fadeInOn  = document.getElementById('trim-fadein-toggle')?.classList.contains('active');
  const fadeOutOn = document.getElementById('trim-fadeout-toggle')?.classList.contains('active');
  const fadeIn    = fadeInOn  ? Math.max(0, parseFloat(document.getElementById('trim-fadein-dur')?.value)  || 0) : 0;
  const fadeOut   = fadeOutOn ? Math.max(0, parseFloat(document.getElementById('trim-fadeout-dur')?.value) || 0) : 0;
  return { fadeIn, fadeOut };
}

function renderFadeOverlay() {
  const overlay = document.getElementById('trim-fade-overlay');
  if (!overlay || !trimEditor || !trimEditor.ws) return;
  const inPath  = document.getElementById('trim-fade-in-path');
  const outPath = document.getElementById('trim-fade-out-path');
  if (!inPath || !outPath) return;
  const region = trimEditor.region;
  const dur = trimEditor.ws.getDuration?.() || 0;
  // Clear when no region yet (initial state before decode).
  if (!region || dur <= 0) {
    inPath.setAttribute('d', '');
    outPath.setAttribute('d', '');
    return;
  }
  const { fadeIn, fadeOut } = readFadeParams();
  // Coordinate system: viewBox 0..100 horizontally for the FULL audio span
  // (preserveAspectRatio="none" stretches to fit the waveform width). Region
  // start/end → x percentages of duration.
  const rs = (region.start / dur) * 100;
  const re = (region.end   / dur) * 100;
  const regionW = Math.max(0.01, re - rs);
  // Fade widths in viewBox units, clamped to the region width.
  const inW  = Math.max(0, Math.min(regionW, (fadeIn  / dur) * 100));
  const outW = Math.max(0, Math.min(regionW, (fadeOut / dur) * 100));
  // Fade-in: triangle with the long edge along the region start (silence
  // at left, rising to full at start+fadeIn). y=0 is top of overlay,
  // y=100 is bottom — we draw from the bottom upward.
  if (inW > 0) {
    inPath.classList.remove('disabled');
    inPath.setAttribute('d', `M ${rs} 100 L ${rs + inW} 100 L ${rs + inW} 0 Z`);
  } else {
    inPath.classList.add('disabled');
    inPath.setAttribute('d', '');
  }
  // Fade-out: mirrored — full at end-fadeOut, silence at end.
  if (outW > 0) {
    outPath.classList.remove('disabled');
    outPath.setAttribute('d', `M ${re - outW} 0 L ${re} 100 L ${re - outW} 100 Z`);
  } else {
    outPath.classList.add('disabled');
    outPath.setAttribute('d', '');
  }
}

// Audible preview: while the trim editor is playing, set media.volume each
// frame so the audio actually fades in/out at the same points the overlay
// shows. The media element is the same one WaveSurfer uses (audio: its
// internal one; video: the <video> tag), so volume changes apply directly
// to what the user hears. Cancels itself when playback stops.
let _fadePreviewRAF = null;
function getTrimMediaElement() {
  if (!trimEditor || !trimEditor.ws) return null;
  // v7: WaveSurfer.getMediaElement() returns the HTMLMediaElement (own audio
  // tag, or the attached <video>). Falls back to the explicit video preview.
  return trimEditor.ws.getMediaElement?.() || document.getElementById('xtract-video-preview');
}
function startFadePreview() {
  stopFadePreview();
  const media = getTrimMediaElement();
  if (!media || !trimEditor?.region) return;
  const region = trimEditor.region;
  const tick = () => {
    if (!trimEditor || !trimEditor.region) return;
    const { fadeIn, fadeOut } = readFadeParams();
    const t = media.currentTime;
    // Hard-stop at region.end: WaveSurfer's RegionsPlugin sometimes lets
    // playback bleed past the region (v7 behaviour varies depending on
    // backend). Mirror the symmetric start-at-region.start behaviour by
    // pausing the moment we cross the end. Tiny epsilon avoids missing
    // the boundary by a fraction of a frame.
    if (t >= region.end - 0.005) {
      try { trimEditor.ws?.pause(); } catch {}
      stopFadePreview();
      resetMediaVolume();
      return;
    }
    let v = 1;
    if (t < region.start) {
      v = 1;
    } else if (fadeIn > 0 && t < region.start + fadeIn) {
      v = Math.max(0, Math.min(1, (t - region.start) / fadeIn));
    } else if (fadeOut > 0 && t > region.end - fadeOut) {
      v = Math.max(0, Math.min(1, (region.end - t) / fadeOut));
    }
    if (Math.abs(media.volume - v) > 0.001) media.volume = v;
    _fadePreviewRAF = requestAnimationFrame(tick);
  };
  _fadePreviewRAF = requestAnimationFrame(tick);
}
function stopFadePreview() {
  if (_fadePreviewRAF) cancelAnimationFrame(_fadePreviewRAF);
  _fadePreviewRAF = null;
}
function resetMediaVolume() {
  const media = getTrimMediaElement();
  if (media) media.volume = 1;
}

function destroyTrimEditorCleanup() {
  // Auxiliary cleanup the trim destroy must do — stop the fade RAF and
  // reset volume so the next file doesn't inherit a faded-low state.
  stopFadePreview();
  resetMediaVolume();
  const inPath  = document.getElementById('trim-fade-in-path');
  const outPath = document.getElementById('trim-fade-out-path');
  if (inPath)  inPath.setAttribute('d', '');
  if (outPath) outPath.setAttribute('d', '');
}

function destroyTrimEditor() {
  // Bump generation so any pending decode-timeout from the editor we're
  // about to tear down bails the moment it fires (instead of showing a
  // misleading "decode timed out" toast for a long-since-destroyed mount).
  _trimEditorGen++;
  destroyTrimEditorCleanup();
  // ── Hot-swap the video element BEFORE destroying ws ──
  // WaveSurfer v7 with `media: videoEl` holds a reference to the original
  // <video> tag. Its fetch + blob-creation pipeline can complete AFTER
  // ws.destroy() (timing dependent — see the user-reported "old video
  // returns after new recording" bug). When it completes late, it sets
  // <stale-videoEl>.src = <stale blob URL>, but ON THE OLD REFERENCE.
  // By cloning the element and swapping it in the DOM right now, the
  // orphaned old video catches any late stale update; the visible (clone)
  // element starts fresh with no src.
  const oldVideo = document.getElementById('xtract-video-preview');
  if (oldVideo) {
    // Revoke any blob URL we held to free the underlying memory.
    const oldSrc = oldVideo.src;
    if (oldSrc && oldSrc.startsWith('blob:')) {
      try { URL.revokeObjectURL(oldSrc); } catch {}
    }
    const newVideo = oldVideo.cloneNode(false);   // shallow — no children, no event listeners
    newVideo.removeAttribute('src');
    oldVideo.parentNode.replaceChild(newVideo, oldVideo);
  }
  if (trimEditor) {
    // GIF mode has no WaveSurfer instance — `ws` is null.
    if (trimEditor.ws) { try { trimEditor.ws.destroy(); } catch {} }
    trimEditor = null;
  }
  trimEditorFile = null;
  const editorEl = document.getElementById('trim-editor');
  const waveEl   = document.getElementById('trim-waveform');
  const videoEl  = document.getElementById('xtract-video-preview');
  const gifEl    = document.getElementById('xtract-gif-preview');
  const gifInfo  = document.getElementById('xtract-gif-info');
  if (editorEl) editorEl.classList.add('hidden');
  if (waveEl) {
    // Selectively remove WaveSurfer's <canvas>/<div> children but keep
    // the persistent <svg> fade overlay — it's static HTML and would be
    // gone forever otherwise (then the next ensureTrimEditor wouldn't find
    // its #trim-fade-in-path / #trim-fade-out-path targets).
    [...waveEl.children].forEach(c => { if (c.tagName.toLowerCase() !== 'svg') c.remove(); });
    waveEl.classList.remove('is-ready');
    waveEl.classList.remove('has-error');
    waveEl.style.display = '';
  }
  if (videoEl) {
    videoEl.classList.add('hidden');
    try { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.load(); } catch {}
  }
  if (gifEl)   { gifEl.classList.add('hidden'); gifEl.removeAttribute('src'); }
  if (gifInfo) { gifInfo.classList.add('hidden'); gifInfo.textContent = ''; }
  // Re-enable fade controls disabled for GIF input.
  ['trim-fadein-toggle','trim-fadein-dur','trim-fadeout-toggle','trim-fadeout-dur'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = false;
  });
}

// ─── IMAGE EDITOR (XTRACT > Image) — single-image crop ──────────────────────
// State is one object; null = not mounted. `rect` is stored in DISPLAY
// pixels (matches the on-screen <img>). Natural pixels are computed at
// apply time from naturalW/displayW ratio so the IPC crop is exact.
let imgCropState = null;

function ensureImageEditor(filePath) {
  if (!filePath || detectMediaKind(filePath) !== 'image') { destroyImageEditor(); return; }
  destroyImageEditor();
  const stage = document.getElementById('img-crop-stage');
  const wrap  = document.getElementById('img-crop-wrap');
  const img   = document.getElementById('img-crop-preview');
  if (!stage || !wrap || !img) return;
  stage.classList.remove('hidden');
  img.src = localFileURL(filePath);
  // Wait for the image to actually layout before we know display dims.
  img.onload = () => {
    if (xtractInput !== filePath) return; // user picked another file already
    const rectW = wrap.clientWidth;
    const naturalW = img.naturalWidth || 1;
    const naturalH = img.naturalHeight || 1;
    // Scale-to-fit happens via CSS (max-width 100% on the img). After
    // layout, the rendered size is in img.clientWidth/Height — that's
    // what the rect coordinates align to.
    const displayW = img.clientWidth  || rectW;
    const displayH = img.clientHeight || Math.round(rectW * naturalH / naturalW);
    imgCropState = {
      filePath, naturalW, naturalH, displayW, displayH,
      aspect: null,  // null = free
      zoom: 1,       // 1 = fit-to-stage default; 0.25..4 via the zoom toolbar
      // Initial crop: 80% centered. Common UX expectation — gives the
      // user a visible rect they can shrink rather than starting at zero.
      rect: {
        x: Math.round(displayW * 0.10),
        y: Math.round(displayH * 0.10),
        w: Math.round(displayW * 0.80),
        h: Math.round(displayH * 0.80)
      },
      drag: null
    };
    setCropZoom(1);  // resets any prior zoom inline styles from previous file
    updateCropVisuals();
    updateCropInputs();
    document.getElementById('img-crop-apply-btn').disabled = false;
    const _recolorBtn = document.getElementById('img-recolor-apply');
    if (_recolorBtn) _recolorBtn.disabled = false;
    refreshImageResizeApplyEnabled();
    refreshSplitButtons();
    // Mount the Annotate (fabric) canvas with this image as background. Lazy
    // — the library import happens on first call, not at app boot.
    mountAnnotateCanvas(filePath).catch(e => console.warn('annotate mount:', e));
    const natInfo = document.getElementById('img-crop-natural-info');
    if (natInfo) natInfo.textContent = `${naturalW}×${naturalH}`;
  };
  img.onerror = () => {
    appendLog('xtract-log', `✗ Could not load image: ${filePath}`, 'error');
    destroyImageEditor();
  };
}

function destroyImageEditor() {
  imgCropState = null;
  const stage = document.getElementById('img-crop-stage');
  const img   = document.getElementById('img-crop-preview');
  const wrap  = document.getElementById('img-crop-wrap');
  if (stage) stage.classList.add('hidden');
  if (img)   {
    img.removeAttribute('src');
    img.onload = img.onerror = null;
    img.style.filter = '';
    // Clear zoom inline styles so the next image starts at fit-to-stage.
    img.style.width = ''; img.style.height = '';
    img.style.maxWidth = ''; img.style.maxHeight = '';
  }
  if (wrap) {
    wrap.style.width = ''; wrap.style.height = '';
    wrap.style.maxWidth = ''; wrap.style.maxHeight = '';
  }
  const zoomLabel = document.getElementById('img-crop-zoom-label');
  if (zoomLabel) zoomLabel.textContent = '100%';
  // Tear down the fabric.js annotation canvas — its background image must
  // be released so the next loaded file doesn't bleed the previous one.
  unmountAnnotateCanvas();
  const apply = document.getElementById('img-crop-apply-btn');
  if (apply) apply.disabled = true;
  refreshImageResizeApplyEnabled();   // disables Resize too when no file loaded
  const natInfo = document.getElementById('img-crop-natural-info');
  if (natInfo) natInfo.textContent = '';
  // Reset all FX controls — fresh file should start from neutral defaults.
  // Done after the DOM controls exist (guarded by querySelector via the
  // helper, which silently no-ops if elements aren't bound yet).
  if (document.getElementById('img-fx-brightness')) resetImageFx();
}

function updateCropVisuals() {
  if (!imgCropState) return;
  const rectEl = document.getElementById('img-crop-rect');
  if (!rectEl) return;
  const { rect, zoom = 1 } = imgCropState;
  // Rect coords are stored in display-px (pre-zoom); the visual position
  // scales linearly with the current zoom so it tracks the image.
  rectEl.style.left   = `${rect.x * zoom}px`;
  rectEl.style.top    = `${rect.y * zoom}px`;
  rectEl.style.width  = `${rect.w * zoom}px`;
  rectEl.style.height = `${rect.h * zoom}px`;
}

// Apply a zoom level (1 = native fit-to-stage). The preview image is sized
// via explicit width/height (max-width: none overrides the fit CSS); the
// inline-block wrap follows. Crop rect coords stay in display-px and are
// scaled visually by updateCropVisuals().
const IMG_ZOOM_MIN = 0.25;
const IMG_ZOOM_MAX = 4;
function setCropZoom(z) {
  if (!imgCropState) return;
  z = Math.max(IMG_ZOOM_MIN, Math.min(IMG_ZOOM_MAX, z));
  imgCropState.zoom = z;
  const img  = document.getElementById('img-crop-preview');
  const wrap = document.getElementById('img-crop-wrap');
  if (img) {
    if (z === 1) {
      img.style.width = ''; img.style.height = '';
      img.style.maxWidth = ''; img.style.maxHeight = '';
    } else {
      img.style.width     = (imgCropState.displayW * z) + 'px';
      img.style.height    = (imgCropState.displayH * z) + 'px';
      img.style.maxWidth  = 'none';
      img.style.maxHeight = 'none';
    }
  }
  // The wrap is inline-block and CSS-capped at max-height: 500px to clip
  // the rect's 9999px box-shadow vignette. Without overriding that cap
  // explicitly here, the wrap stays 500px tall even when the inner img
  // grows to 2000px — scrollbars never appear because the stage sees the
  // wrap's clamped size, not the inner content. Setting explicit dims
  // when zoomed lifts the cap; clearing them when back at 1× restores
  // the natural fit-to-stage behaviour.
  if (wrap) {
    if (z === 1) {
      wrap.style.width     = '';
      wrap.style.height    = '';
      wrap.style.maxWidth  = '';
      wrap.style.maxHeight = '';
    } else {
      wrap.style.width     = (imgCropState.displayW * z) + 'px';
      wrap.style.height    = (imgCropState.displayH * z) + 'px';
      wrap.style.maxWidth  = 'none';
      wrap.style.maxHeight = 'none';
    }
  }
  const label = document.getElementById('img-crop-zoom-label');
  if (label) label.textContent = Math.round(z * 100) + '%';
  updateCropVisuals();
}

function updateCropInputs() {
  if (!imgCropState) return;
  // Inputs hold NATURAL pixel coordinates. Multiply display by ratio.
  const { naturalW, displayW, naturalH, displayH, rect } = imgCropState;
  const rx = naturalW / displayW;
  const ry = naturalH / displayH;
  const xEl = document.getElementById('img-crop-x');
  const yEl = document.getElementById('img-crop-y');
  const wEl = document.getElementById('img-crop-w');
  const hEl = document.getElementById('img-crop-h');
  if (xEl) xEl.value = Math.round(rect.x * rx);
  if (yEl) yEl.value = Math.round(rect.y * ry);
  if (wEl) wEl.value = Math.round(rect.w * rx);
  if (hEl) hEl.value = Math.round(rect.h * ry);
  // Sane bounds on the inputs (max = natural dimensions).
  if (wEl) wEl.max = String(naturalW);
  if (hEl) hEl.max = String(naturalH);
  if (xEl) xEl.max = String(naturalW - 1);
  if (yEl) yEl.max = String(naturalH - 1);
}

function clampCropRect() {
  if (!imgCropState) return;
  const { displayW, displayH, rect, aspect } = imgCropState;
  // Width / height stay positive and within the display box.
  rect.w = Math.max(1, Math.min(rect.w, displayW));
  rect.h = Math.max(1, Math.min(rect.h, displayH));
  // If an aspect ratio is locked, re-derive h from w (or shrink w to fit
  // the display). aspect is stored as w/h.
  if (aspect) {
    rect.h = Math.round(rect.w / aspect);
    if (rect.h > displayH) { rect.h = displayH; rect.w = Math.round(rect.h * aspect); }
  }
  rect.x = Math.max(0, Math.min(rect.x, displayW - rect.w));
  rect.y = Math.max(0, Math.min(rect.y, displayH - rect.h));
}

function bindImageCropInteractions() {
  const wrap   = document.getElementById('img-crop-wrap');
  const rectEl = document.getElementById('img-crop-rect');
  if (!wrap || !rectEl) return;

  // Single mousedown handler at the wrap level — the drag MODE is derived
  // from the target (a handle? the rect itself? empty area?). Pointer
  // events use clientX/Y, converted to wrap-local via getBoundingClientRect.
  wrap.addEventListener('mousedown', (e) => {
    if (!imgCropState) return;
    const box = wrap.getBoundingClientRect();
    // Convert viewport px to image display-px by dividing by the current
    // zoom — getBoundingClientRect already reports scaled dims, so the
    // delta inherits the zoom factor.
    const z   = imgCropState.zoom || 1;
    const px  = (e.clientX - box.left) / z;
    const py  = (e.clientY - box.top)  / z;
    const target = e.target;
    let mode;
    if (target.classList && target.classList.contains('img-crop-handle')) {
      // Handle drag: figure out which corner.
      if      (target.classList.contains('h-tl')) mode = 'resize-tl';
      else if (target.classList.contains('h-tr')) mode = 'resize-tr';
      else if (target.classList.contains('h-bl')) mode = 'resize-bl';
      else if (target.classList.contains('h-br')) mode = 'resize-br';
    } else if (target === rectEl) {
      mode = 'move';
    } else {
      // Click on empty area = start a brand-new rect with an "anchor"
      // dragging mode. The anchor stays at the mousedown point and the
      // opposite corner follows the cursor in ANY quadrant (up/down/
      // left/right), so the user can rough-out a selection from whichever
      // corner is most convenient. The 'draw' mode in mousemove handles
      // the per-quadrant math.
      mode = 'draw';
      imgCropState.rect = { x: px, y: py, w: 1, h: 1 };
    }
    imgCropState.drag = { mode, startX: px, startY: py, anchorX: px, anchorY: py, startRect: { ...imgCropState.rect } };
    e.preventDefault();
  });

  // Window-level mousemove/up so the drag doesn't die when the user
  // leaves the wrap rectangle (common when dragging fast near edges).
  window.addEventListener('mousemove', (e) => {
    if (!imgCropState || !imgCropState.drag) return;
    const box = wrap.getBoundingClientRect();
    const z   = imgCropState.zoom || 1;
    const px  = (e.clientX - box.left) / z;
    const py  = (e.clientY - box.top)  / z;
    const { mode, startX, startY, anchorX, anchorY, startRect } = imgCropState.drag;
    const dx = px - startX;
    const dy = py - startY;
    const r = imgCropState.rect;
    if (mode === 'draw') {
      // Anchor stays put; opposite corner = current cursor. min/max picks
      // the correct quadrant on the fly so dragging up-left works just as
      // well as down-right.
      r.x = Math.min(anchorX, px);
      r.y = Math.min(anchorY, py);
      r.w = Math.max(1, Math.abs(px - anchorX));
      r.h = Math.max(1, Math.abs(py - anchorY));
    } else if (mode === 'move') {
      r.x = startRect.x + dx;
      r.y = startRect.y + dy;
    } else if (mode === 'resize-br') {
      r.w = Math.max(1, startRect.w + dx);
      r.h = Math.max(1, startRect.h + dy);
    } else if (mode === 'resize-tl') {
      r.x = startRect.x + dx;
      r.y = startRect.y + dy;
      r.w = Math.max(1, startRect.w - dx);
      r.h = Math.max(1, startRect.h - dy);
    } else if (mode === 'resize-tr') {
      r.y = startRect.y + dy;
      r.w = Math.max(1, startRect.w + dx);
      r.h = Math.max(1, startRect.h - dy);
    } else if (mode === 'resize-bl') {
      r.x = startRect.x + dx;
      r.w = Math.max(1, startRect.w - dx);
      r.h = Math.max(1, startRect.h + dy);
    }
    clampCropRect();
    updateCropVisuals();
    updateCropInputs();
  });
  window.addEventListener('mouseup', () => {
    if (imgCropState && imgCropState.drag) imgCropState.drag = null;
  });
}

function bindImageCropControls() {
  // Aspect ratio buttons. "Free" = no constraint; other buttons store the
  // aspect as w/h (so 1:1 → 1, 16:9 → 16/9, etc.) and reshape the current
  // rect to match.
  document.querySelectorAll('.img-aspect-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.img-aspect-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (!imgCropState) return;
      const a = btn.dataset.aspect;
      if (a === 'free') {
        imgCropState.aspect = null;
      } else {
        const [w, h] = a.split(':').map(Number);
        imgCropState.aspect = (h > 0) ? (w / h) : null;
        clampCropRect();
        updateCropVisuals();
        updateCropInputs();
      }
    });
  });
  // Number-input → rect sync. Inputs are in natural coordinates, rect in
  // display — divide by the same ratio used in updateCropInputs to convert
  // back.
  const onInputChange = () => {
    if (!imgCropState) return;
    const { naturalW, displayW, naturalH, displayH, rect } = imgCropState;
    const rx = displayW / naturalW;
    const ry = displayH / naturalH;
    rect.x = Math.max(0, (parseInt(document.getElementById('img-crop-x').value, 10) || 0) * rx);
    rect.y = Math.max(0, (parseInt(document.getElementById('img-crop-y').value, 10) || 0) * ry);
    rect.w = Math.max(1, (parseInt(document.getElementById('img-crop-w').value, 10) || 1) * rx);
    rect.h = Math.max(1, (parseInt(document.getElementById('img-crop-h').value, 10) || 1) * ry);
    clampCropRect();
    updateCropVisuals();
  };
  ['img-crop-x','img-crop-y','img-crop-w','img-crop-h'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', onInputChange);
  });
  document.getElementById('img-crop-reset-btn')?.addEventListener('click', () => {
    if (!imgCropState) return;
    // Full reset: clear any locked aspect ratio so the 80%-centred rect
    // isn't immediately reshaped by clampCropRect (the previous behaviour
    // looked broken — Reset appeared to do nothing when a non-Free aspect
    // was active because the rect snapped back to the constrained shape).
    imgCropState.aspect = null;
    document.querySelectorAll('.img-aspect-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.img-aspect-btn[data-aspect="free"]')?.classList.add('active');
    const { displayW, displayH } = imgCropState;
    imgCropState.rect = {
      x: Math.round(displayW * 0.10),
      y: Math.round(displayH * 0.10),
      w: Math.round(displayW * 0.80),
      h: Math.round(displayH * 0.80)
    };
    clampCropRect();
    setCropZoom(1);     // also bring the preview back to 1× — Reset = full reset
    updateCropVisuals();
    updateCropInputs();
  });
  document.getElementById('img-crop-apply-btn')?.addEventListener('click', () => doImageCropApply());

  // Zoom controls — step ×1.25 / ÷1.25 keeps the increment perceptually even
  // across the range, "fit" resets to 1× (the load-time fit-to-stage size).
  document.getElementById('img-crop-zoom-in') ?.addEventListener('click', () => setCropZoom((imgCropState?.zoom || 1) * 1.25));
  document.getElementById('img-crop-zoom-out')?.addEventListener('click', () => setCropZoom((imgCropState?.zoom || 1) / 1.25));
  document.getElementById('img-crop-zoom-fit')?.addEventListener('click', () => setCropZoom(1));
  // Ctrl+wheel on the stage zooms toward/away from the cursor's center. The
  // browser's native page-zoom shortcut is disabled to avoid double-zoom.
  const stage = document.getElementById('img-crop-stage');
  stage?.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !imgCropState) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setCropZoom((imgCropState.zoom || 1) * factor);
  }, { passive: false });
  // Middle-mouse-button drag pans the stage. Left-button drag is reserved for
  // the crop rect, so middle-button is the conflict-free channel that mirrors
  // the convention used in Photoshop / Figma / most image viewers.
  let panState = null;
  stage?.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return;  // middle button only
    panState = { sx: e.clientX, sy: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop };
    stage.style.cursor = 'grabbing';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!panState) return;
    stage.scrollLeft = panState.sl - (e.clientX - panState.sx);
    stage.scrollTop  = panState.st - (e.clientY - panState.sy);
  });
  window.addEventListener('mouseup', () => {
    if (panState) { panState = null; stage.style.cursor = ''; }
  });
}

async function doImageCropApply() {
  if (!imgCropState || !xtractInput) return;
  // Read inputs (they're authoritative — drag updates them, and the user
  // may have typed a value just before clicking Apply).
  const x = parseInt(document.getElementById('img-crop-x').value, 10) || 0;
  const y = parseInt(document.getElementById('img-crop-y').value, 10) || 0;
  const w = parseInt(document.getElementById('img-crop-w').value, 10) || 0;
  const h = parseInt(document.getElementById('img-crop-h').value, 10) || 0;
  if (w <= 0 || h <= 0) {
    appendLog('xtract-log', '✗ Crop width and height must be positive.', 'error');
    return;
  }
  const btn = document.getElementById('img-crop-apply-btn');
  btn.classList.add('btn-loading'); btn.disabled = true;
  appendLog('xtract-log', `Cropping ${w}×${h} from ${imgCropState.filePath}…`, 'info');
  const format = document.getElementById('img-crop-format')?.value || '';
  const r = await window.api.images.crop({ input: xtractInput, x, y, width: w, height: h, format });
  btn.classList.remove('btn-loading'); btn.disabled = false;
  if (r.ok) {
    appendLog('xtract-log', `✓ Saved: ${r.path}`, 'ok');
    showToast({ title: t('xtract_image_crop_done_title') || 'Crop saved', body: r.path, kind: 'ok', ttl: 6000, actions: fileToastActions(r.path) });
  } else {
    appendLog('xtract-log', `✗ ${r.error}`, 'error');
    showToast({ title: t('xtract_image_crop_err_title') || 'Crop failed', body: r.error, kind: 'err', ttl: 6000 });
  }
}

// ─── IMAGE EFFECTS (XTRACT > Image > Effects card) ───────────────────────
// Live preview is pure CSS filters applied to the crop card's <img>.
// Browser-native filter chains run on the GPU — instant feedback even on
// 30-megapixel JPGs. On Apply, the slider values are forwarded to sharp
// which produces the actual file (CSS filters are visual only).
const IMG_FX_DEFAULTS = {
  brightness: 100,  contrast: 100,  saturation: 100,
  hue:        0,    blur:     0,    sharpen:  0,
  grayscale:  false, sepia:   false, invert:   false
};

function readImageFx() {
  return {
    brightness: +document.getElementById('img-fx-brightness').value,
    contrast:   +document.getElementById('img-fx-contrast').value,
    saturation: +document.getElementById('img-fx-saturation').value,
    hue:        +document.getElementById('img-fx-hue').value,
    blur:       +document.getElementById('img-fx-blur').value,
    sharpen:    +document.getElementById('img-fx-sharpen').value,
    grayscale:  document.getElementById('img-fx-grayscale').classList.contains('active'),
    sepia:      document.getElementById('img-fx-sepia').classList.contains('active'),
    invert:     document.getElementById('img-fx-invert').classList.contains('active')
  };
}

function updateImageFxPreview() {
  const fx = readImageFx();
  const img = document.getElementById('img-crop-preview');
  if (!img) return;
  // Build the CSS filter chain. Each filter is no-op at its default value
  // so the string always works; non-defaults compose visually. Sharpen
  // doesn't have a native CSS filter — approximate with a tiny inverse
  // blur trick (not perfect; the real result happens on apply via sharp).
  const filters = [
    `brightness(${fx.brightness / 100})`,
    `contrast(${fx.contrast / 100})`,
    `saturate(${fx.saturation / 100})`,
    `hue-rotate(${fx.hue}deg)`,
    `blur(${fx.blur}px)`,
    fx.grayscale ? 'grayscale(1)' : 'grayscale(0)',
    fx.sepia     ? 'sepia(1)'     : 'sepia(0)',
    fx.invert    ? 'invert(1)'    : 'invert(0)'
  ];
  img.style.filter = filters.join(' ');
  // Sync the value labels next to each slider.
  document.getElementById('img-fx-brightness-v').textContent = `${fx.brightness}%`;
  document.getElementById('img-fx-contrast-v').textContent   = `${fx.contrast}%`;
  document.getElementById('img-fx-saturation-v').textContent = `${fx.saturation}%`;
  document.getElementById('img-fx-hue-v').textContent        = `${fx.hue}°`;
  document.getElementById('img-fx-blur-v').textContent       = fx.blur.toFixed(1);
  document.getElementById('img-fx-sharpen-v').textContent    = fx.sharpen.toFixed(1);
  // Enable Apply only when at least one effect diverges from default.
  const dirty = Object.keys(IMG_FX_DEFAULTS).some(k => fx[k] !== IMG_FX_DEFAULTS[k]);
  document.getElementById('img-fx-apply').disabled = !dirty || !xtractInput;
}

function resetImageFx() {
  document.getElementById('img-fx-brightness').value = '100';
  document.getElementById('img-fx-contrast').value   = '100';
  document.getElementById('img-fx-saturation').value = '100';
  document.getElementById('img-fx-hue').value        = '0';
  document.getElementById('img-fx-blur').value       = '0';
  document.getElementById('img-fx-sharpen').value    = '0';
  ['img-fx-grayscale','img-fx-sepia','img-fx-invert'].forEach(id =>
    document.getElementById(id).classList.remove('active'));
  updateImageFxPreview();
}

async function doImageFxApply() {
  if (!xtractInput) return;
  const fx = readImageFx();
  const btn = document.getElementById('img-fx-apply');
  btn.classList.add('btn-loading'); btn.disabled = true;
  appendLog('xtract-log', `Applying effects to ${xtractInput.split(/[\\/]/).pop()}…`, 'info');
  const r = await window.api.images.applyEffects({ input: xtractInput, ...fx });
  btn.classList.remove('btn-loading'); btn.disabled = false;
  if (r.ok) {
    appendLog('xtract-log', `✓ Saved: ${r.path}`, 'ok');
    showToast({ title: t('xtract_image_fx_done_title') || 'Effects applied', body: r.path, kind: 'ok', ttl: 6000, actions: fileToastActions(r.path) });
    // Reset the preview filter — the saved file already has the effect
    // baked in. Keeping the CSS filter would double-apply visually next
    // time the user looks at the (unchanged) source <img>.
    resetImageFx();
  } else {
    appendLog('xtract-log', `✗ ${r.error}`, 'error');
    showToast({ title: t('xtract_image_fx_err_title') || 'Effects failed', body: r.error, kind: 'err', ttl: 6000 });
  }
}

function bindImageFxControls() {
  // Every slider triggers a preview update on `input` (live drag, not on
  // release) so the user sees the effect while moving the handle.
  ['img-fx-brightness','img-fx-contrast','img-fx-saturation','img-fx-hue','img-fx-blur','img-fx-sharpen']
    .forEach(id => document.getElementById(id)?.addEventListener('input', updateImageFxPreview));
  // Toggle buttons flip an `.active` class — readImageFx checks for it.
  ['img-fx-grayscale','img-fx-sepia','img-fx-invert'].forEach(id =>
    document.getElementById(id)?.addEventListener('click', () => {
      document.getElementById(id).classList.toggle('active');
      updateImageFxPreview();
    }));
  document.getElementById('img-fx-reset')?.addEventListener('click', resetImageFx);
  document.getElementById('img-fx-apply')?.addEventListener('click', doImageFxApply);
  // Replace-colour controls.
  const recolorTol = document.getElementById('img-recolor-tol');
  recolorTol?.addEventListener('input', () => {
    const v = document.getElementById('img-recolor-tol-v');
    if (v) v.textContent = recolorTol.value + '%';
  });
  document.getElementById('img-recolor-apply')?.addEventListener('click', doImageColorReplace);
}

async function doImageColorReplace() {
  if (!xtractInput) return;
  const from = document.getElementById('img-recolor-from')?.value || '#000000';
  const to   = document.getElementById('img-recolor-to')?.value   || '#000000';
  const tolerance = parseInt(document.getElementById('img-recolor-tol')?.value, 10) || 0;
  const btn = document.getElementById('img-recolor-apply');
  btn.classList.add('btn-loading'); btn.disabled = true;
  appendLog('xtract-log', `Replacing ${from} → ${to} (tol ${tolerance}%) in ${xtractInput.split(/[\\/]/).pop()}…`, 'info');
  const r = await window.api.images.replaceColor({ input: xtractInput, from, to, tolerance });
  btn.classList.remove('btn-loading'); btn.disabled = false;
  if (r.ok) {
    appendLog('xtract-log', `✓ Saved: ${r.path}`, 'ok');
    showToast({ title: t('xtract_image_recolor_done_title') || 'Colour replaced', body: r.path, kind: 'ok', ttl: 6000, actions: fileToastActions(r.path) });
  } else {
    appendLog('xtract-log', `✗ ${r.error}`, 'error');
    showToast({ title: t('xtract_image_recolor_err_title') || 'Replace failed', body: r.error, kind: 'err', ttl: 6000 });
  }
}

// ─── XTRACT > Image > Resize ────────────────────────────────────────────────
// Single-file resize. Shares the same `images:resize` IPC the batch USE
// editor uses — main side already supports a 1-file array. Apply button
// is gated on having a loaded file AND at least one parameter set.
function refreshImageResizeApplyEnabled() {
  const wEl   = document.getElementById('img-resize-w');
  const hEl   = document.getElementById('img-resize-h');
  const pctEl = document.getElementById('img-resize-pct');
  const apply = document.getElementById('img-resize-apply');
  if (!apply) return;
  const anyParam = (parseInt(wEl?.value, 10) > 0) || (parseInt(hEl?.value, 10) > 0) || (parseInt(pctEl?.value, 10) > 0);
  apply.disabled = !xtractInput || !anyParam;
}
function bindImageResizeControls() {
  const apply = document.getElementById('img-resize-apply');
  if (!apply) return;
  ['img-resize-w', 'img-resize-h', 'img-resize-pct'].forEach(id =>
    document.getElementById(id)?.addEventListener('input', refreshImageResizeApplyEnabled));
  apply.addEventListener('click', doImageResizeApply);
  refreshImageResizeApplyEnabled();
}

async function doImageResizeApply() {
  if (!xtractInput) return;
  const maxWidth  = parseInt(document.getElementById('img-resize-w')?.value,   10) || 0;
  const maxHeight = parseInt(document.getElementById('img-resize-h')?.value,   10) || 0;
  const scalePct  = parseInt(document.getElementById('img-resize-pct')?.value, 10) || 0;
  if (maxWidth <= 0 && maxHeight <= 0 && scalePct <= 0) return;
  const btn = document.getElementById('img-resize-apply');
  btn.classList.add('btn-loading'); btn.disabled = true;
  appendLog('xtract-log', `Resizing ${xtractInput.split(/[\\/]/).pop()}…`, 'info');
  try {
    const r = await window.api.images.resize({
      files: [{ path: xtractInput }],
      maxWidth, maxHeight, scalePct,
      overwrite: false  // never overwrite the source in single-file mode
    });
    if (r.ok && r.resized?.length) {
      const savedPath = r.resized[0].to;
      appendLog('xtract-log', `✓ Saved: ${savedPath}`, 'ok');
      showToast({
        title: t('xtract_image_resize_done_title') || 'Resize saved',
        body:  savedPath,
        kind:  'ok',
        ttl:   6000,
        actions: fileToastActions(savedPath)
      });
    } else {
      const err = r.error || (r.failed?.[0]?.error) || 'unknown';
      appendLog('xtract-log', `✗ ${err}`, 'error');
      showToast({ title: t('images_op_err_title') || 'Image op failed', body: `resize: ${err}`, kind: 'err', ttl: 6000 });
    }
  } catch (e) {
    appendLog('xtract-log', `✗ ${e.message}`, 'error');
    showToast({ title: t('images_op_err_title') || 'Image op failed', body: `resize: ${e.message}`, kind: 'err', ttl: 6000 });
  } finally {
    btn.classList.remove('btn-loading'); btn.disabled = false;
  }
}

// ─── XTRACT > Split into tracks ──────────────────────────────────────────────
// Detect-then-split pipeline for "full album" audio/video sources. Detect
// fills the editable list from ffprobe chapters or ffmpeg silencedetect;
// the user trims/edits/adds rows; Split executes ffmpeg cuts via IPC.
let splitTracks = [];   // [{ start, end, title }]

function bindSplitTracksControls() {
  const detectBtn = document.getElementById('xtract-split-detect-btn');
  const runBtn    = document.getElementById('xtract-split-run-btn');
  const addBtn    = document.getElementById('xtract-split-add-btn');
  if (!detectBtn || !runBtn) return;
  detectBtn.addEventListener('click', doSplitDetect);
  runBtn.addEventListener('click', doSplitRun);
  addBtn?.addEventListener('click', addSplitRow);
  refreshSplitButtons();
}

function refreshSplitButtons() {
  const detectBtn = document.getElementById('xtract-split-detect-btn');
  const runBtn    = document.getElementById('xtract-split-run-btn');
  const isAudioOrVideo = xtractInput && (detectMediaKind(xtractInput) === 'audio' || detectMediaKind(xtractInput) === 'video');
  if (detectBtn) detectBtn.disabled = !isAudioOrVideo;
  if (runBtn)    runBtn.disabled    = !splitTracks.length;
}

async function doSplitDetect() {
  if (!xtractInput) return;
  if (!(await ensureBinaries(['ffmpeg', 'ffprobe'], t('nav_xtract') || 'Convert'))) return;
  const noiseDb    = parseFloat(document.getElementById('xtract-split-noise')?.value)  || -30;
  const minSilence = parseFloat(document.getElementById('xtract-split-mindur')?.value) || 1.5;
  const btn = document.getElementById('xtract-split-detect-btn');
  btn.classList.add('btn-loading'); btn.disabled = true;
  appendLog('xtract-log', `Detecting tracks in ${xtractInput.split(/[\\/]/).pop()}…`, 'info');
  try {
    const r = await window.api.audio.detectTracks({ input: xtractInput, noiseDb, minSilence });
    if (!r.ok) throw new Error(r.error);
    splitTracks = r.tracks || [];
    const srcEl = document.getElementById('xtract-split-source');
    if (srcEl) {
      const label = r.source === 'chapters'
        ? (t('xtract_split_source_chapters') || 'From embedded chapters')
        : (t('xtract_split_source_silence')  || 'From silence detection');
      srcEl.textContent = `${label} — ${splitTracks.length} segment(s)`;
    }
    appendLog('xtract-log', `✓ ${splitTracks.length} segment(s) (source: ${r.source})`, 'ok');
    renderSplitTracks();
  } catch (e) {
    appendLog('xtract-log', `✗ ${e.message}`, 'error');
    showToast({ title: 'Detect failed', body: e.message, kind: 'err', ttl: 6000 });
  } finally {
    btn.classList.remove('btn-loading');
    refreshSplitButtons();
  }
}

function renderSplitTracks() {
  const list = document.getElementById('xtract-split-list');
  if (!list) return;
  list.innerHTML = '';
  splitTracks.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'split-track-row';
    row.innerHTML = `
      <span class="split-num">${i + 1}</span>
      <input type="number" step="0.1" min="0" value="${t.start.toFixed(2)}" data-field="start" />
      <input type="number" step="0.1" min="0" value="${t.end.toFixed(2)}"   data-field="end" />
      <input type="text"   value="${escapeHtml(t.title || '')}"             data-field="title" placeholder="Title" />
      <button class="btn-icon btn-icon-danger" data-lucide-icon="x" title="Remove"></button>
    `;
    // Field sync on input — keep splitTracks in sync with the DOM.
    row.querySelectorAll('input').forEach(input => {
      input.addEventListener('input', () => {
        const field = input.dataset.field;
        const val = field === 'title' ? input.value : (parseFloat(input.value) || 0);
        splitTracks[i][field] = val;
      });
    });
    row.querySelector('.btn-icon-danger').addEventListener('click', () => {
      splitTracks.splice(i, 1);
      renderSplitTracks();
      refreshSplitButtons();
    });
    list.appendChild(row);
  });
  applyLucideIcons(list);
}

function addSplitRow() {
  const last = splitTracks[splitTracks.length - 1];
  const start = last ? last.end : 0;
  splitTracks.push({ start, end: start + 30, title: '' });
  renderSplitTracks();
  refreshSplitButtons();
}

async function doSplitRun() {
  if (!xtractInput || !splitTracks.length) return;
  // Filter out zero-length or invalid rows so we don't ship them to ffmpeg.
  const valid = splitTracks.filter(t => t.end > t.start && t.end - t.start > 0.1);
  if (!valid.length) {
    showToast({ title: 'No valid tracks', body: 'All segments are empty or invalid.', kind: 'err', ttl: 5000 });
    return;
  }
  if (!(await ensureBinaries(['ffmpeg', 'ffprobe'], t('nav_xtract') || 'Convert'))) return;
  const btn = document.getElementById('xtract-split-run-btn');
  btn.classList.add('btn-loading'); btn.disabled = true;
  appendLog('xtract-log', `Splitting ${xtractInput.split(/[\\/]/).pop()} into ${valid.length} track(s)…`, 'info');
  try {
    const r = await window.api.audio.splitTracks({ input: xtractInput, tracks: valid });
    if (!r.ok) throw new Error(r.error || 'split failed');
    appendLog('xtract-log', `✓ ${r.files.length}/${valid.length} saved to ${r.outDir}`, 'ok');
    showToast({
      title: t('xtract_split_done_title') || 'Split complete',
      body:  `${r.files.length} track(s) saved`,
      kind:  r.failed?.length ? 'warn' : 'ok',
      ttl:   6000,
      actions: [{
        icon: 'folder-open',
        title: t('toast_open_folder') || 'Open folder',
        onClick: (close) => { window.api.shell.openFolder(r.outDir); close(); }
      }]
    });
    if (r.failed?.length) {
      r.failed.forEach(f => appendLog('xtract-log', `  ✗ track ${f.index}: ${f.error}`, 'error'));
    }
  } catch (e) {
    appendLog('xtract-log', `✗ ${e.message}`, 'error');
    showToast({ title: 'Split failed', body: e.message, kind: 'err', ttl: 6000 });
  } finally {
    btn.classList.remove('btn-loading');
    refreshSplitButtons();
  }
}

function syncTimeInputsFromRegion(r) {
  if (trimEditorSyncing) return;
  trimEditorSyncing = true;
  document.getElementById('xtract-trim-start').value = formatTrimTime(r.start);
  document.getElementById('xtract-trim-end').value   = formatTrimTime(r.end);
  trimEditorSyncing = false;
}

function syncRegionFromTimeInputs() {
  if (trimEditorSyncing) return;
  const r = trimEditor?.region;
  if (!r) return;
  const startSec = parseTrimTime(document.getElementById('xtract-trim-start').value);
  const endSec   = parseTrimTime(document.getElementById('xtract-trim-end').value);
  if (startSec === null || endSec === null) return;
  if (startSec >= endSec) return;
  const dur = trimEditor.ws.getDuration() || endSec;
  const s = Math.max(0, Math.min(startSec, dur));
  const e = Math.max(s + 0.05, Math.min(endSec, dur));
  trimEditorSyncing = true;
  try { r.setOptions({ start: s, end: e }); } catch {}
  trimEditorSyncing = false;
}

function bindTrimEditorControls() {
  const startIn = document.getElementById('xtract-trim-start');
  const endIn   = document.getElementById('xtract-trim-end');
  startIn?.addEventListener('change', syncRegionFromTimeInputs);
  endIn?.addEventListener('change',   syncRegionFromTimeInputs);

  // Play/pause toggle for the selected region. WaveSurfer's region.play()
  // plays from region.start to region.end; pausing the underlying ws stops
  // playback at the current position. Button icon flips accordingly.
  document.getElementById('trim-play-btn')?.addEventListener('click', () => {
    const r = trimEditor?.region;
    const ws = trimEditor?.ws;
    if (!r || !ws) return;
    const btn = document.getElementById('trim-play-btn');
    try {
      if (ws.isPlaying && ws.isPlaying()) {
        ws.pause();
      } else {
        r.play();
      }
    } catch (e) {
      appendLog('xtract-log', `Preview failed: ${e.message}`, 'error');
    }
    // Icon updates handled by the ws play/pause listeners below.
    void btn;
  });

  // Fade toggle buttons — icon-only, behave like checkboxes via .active class.
  // Clicking enables/disables the matching duration input (greyed when off).
  for (const [btnId, durId] of [
    ['trim-fadein-toggle',  'trim-fadein-dur'],
    ['trim-fadeout-toggle', 'trim-fadeout-dur']
  ]) {
    const btn = document.getElementById(btnId);
    const dur = document.getElementById(durId);
    btn?.addEventListener('click', () => {
      const on = !btn.classList.contains('active');
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (dur) {
        dur.disabled = !on;
        dur.classList.toggle('is-off', !on);
      }
    });
  }
}

async function runXtract(op, extra) {
  if (!xtractInput) return;
  if (!(await ensureBinaries(['ffmpeg', 'ffprobe'], t('nav_xtract') || 'Convert'))) return;
  const opId = ++xtractOpCounter;
  const card = document.querySelector(`#tab-xtract .progress-bar-bg[data-progress-for="${op}"]`)?.closest('.xtract-card');
  const bar  = document.querySelector(`#tab-xtract .progress-bar-bg[data-progress-for="${op}"]`);
  bar.dataset.opId = opId;
  bar.classList.remove('hidden');
  bar.querySelector('.progress-bar').style.width = '0%';
  bar.querySelector('.progress-bar-text').textContent = '0%';
  if (card) card.classList.add('is-running');

  appendLog('xtract-log', `▶ ${op}: ${xtractInput}`, 'info');
  const trackerEntry = addDownloadEntry({
    title:  xtractInput.split(/[\\/]/).pop(),
    source: 'xtract · ' + op,
    status: 'running'
  });

  try {
    const r = await window.api.xtract[op]({ input: xtractInput, ...extra, opId });
    if (r.ok) {
      appendLog('xtract-log', `✓ Saved: ${r.path}`, 'ok');
      updateDownloadEntry(trackerEntry.id, { status: 'done', path: r.path });
    } else {
      appendLog('xtract-log', `✗ ${r.error}`, 'error');
      updateDownloadEntry(trackerEntry.id, { status: 'error', error: r.error });
    }
  } catch (e) {
    appendLog('xtract-log', `✗ ${e.message}`, 'error');
    updateDownloadEntry(trackerEntry.id, { status: 'error', error: e.message });
  } finally {
    if (card) card.classList.remove('is-running');
    setTimeout(() => bar.classList.add('hidden'), 1500);
  }
}

function bindNavAccordion() {
  const groups = document.querySelectorAll('.nav-scroll .nav-group');
  // First launch — start every group collapsed so the Home tab leads the
  // eye. Once any group has been toggled by the user, their per-group
  // preference is persisted and honoured on subsequent launches.
  if (!config.nav_groups_collapsed) {
    config.nav_groups_collapsed = {};
    groups.forEach((group, idx) => {
      const label = group.querySelector('.nav-group-label');
      if (!label) return;
      const key = (label.dataset.i18n || `group_${idx}`).replace(/^nav_group_/, '');
      config.nav_groups_collapsed[key] = true;
    });
    window.api.config.save(config);
  }
  const collapsed = config.nav_groups_collapsed;
  groups.forEach((group, idx) => {
    const label = group.querySelector('.nav-group-label');
    if (!label) return;
    const key = (label.dataset.i18n || `group_${idx}`).replace(/^nav_group_/, '');
    if (collapsed[key]) group.classList.add('collapsed');
    label.addEventListener('click', () => {
      const opening = group.classList.contains('collapsed'); // collapsed → about to open
      group.classList.toggle('collapsed');
      // Accordion: opening one group closes the others (one F·L·U·X group at a time).
      if (opening) groups.forEach(g => { if (g !== group) g.classList.add('collapsed'); });
      // Persist the resulting state of every group.
      const state = {};
      groups.forEach((g, i) => {
        const l = g.querySelector('.nav-group-label');
        if (!l) return;
        const k = (l.dataset.i18n || `group_${i}`).replace(/^nav_group_/, '');
        state[k] = g.classList.contains('collapsed');
      });
      config.nav_groups_collapsed = state;
      window.api.config.save(config);
    });
  });
}

function bindSidebarToggle() {
  const sidebar = document.querySelector('.sidebar');
  const btn = document.getElementById('sidebar-toggle-btn');
  if (!sidebar || !btn) return;
  // Restore persisted state
  if (config.sidebar_collapsed) sidebar.classList.add('collapsed');
  btn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    config.sidebar_collapsed = sidebar.classList.contains('collapsed');
    window.api.config.save(config);
  });
}

// ─── FOOTER: VOLUME CONTROLLER ──────────────────────────────────────────────
// Controls global <audio> volume independently from mute state, like a
// hardware mixer: muting silences output but the slider position is preserved.
function bindFooterVolume() {
  const audio = document.getElementById('global-audio');
  const wrap  = document.getElementById('footer-volume');
  const btn   = document.getElementById('footer-volume-btn');
  const slider= document.getElementById('footer-volume-slider');
  const valEl = document.getElementById('footer-volume-value');
  if (!audio || !btn || !slider) return;

  // Restore persisted state, falling back to defaults.
  const savedVol  = typeof config.volume === 'number' ? config.volume : 80;
  const savedMute = !!config.muted;
  slider.value    = savedVol;
  valEl.textContent = savedVol;
  audio.volume    = savedVol / 100;
  audio.muted     = savedMute;
  refreshVolumeIcon();

  slider.addEventListener('input', () => {
    const v = parseInt(slider.value, 10);
    audio.volume   = v / 100;
    valEl.textContent = String(v);
    config.volume = v;
    window.api.config.save(config);
    refreshVolumeIcon();
  });

  btn.addEventListener('click', () => {
    audio.muted = !audio.muted;
    config.muted = audio.muted;
    window.api.config.save(config);
    refreshVolumeIcon();
  });

  function refreshVolumeIcon() {
    const v = parseInt(slider.value, 10);
    let iconName;
    if (audio.muted || v === 0) iconName = 'volume-x';
    else if (v < 33)            iconName = 'volume-1';
    else if (v < 66)            iconName = 'volume-2';
    else                        iconName = 'volume-2';
    btn.setAttribute('data-lucide-icon', iconName);
    btn.removeAttribute('data-lucide-rendered');
    btn.classList.toggle('is-muted', audio.muted);
    wrap.classList.toggle('is-muted', audio.muted);
    applyLucideIcons(btn);
  }
}

// ─── SETTINGS: VERSION + CHECK UPDATES ──────────────────────────────────────
function bindSettingsVersion() {
  const verEl = document.getElementById('settings-version-text');
  const btn   = document.getElementById('settings-check-updates');
  const msg   = document.getElementById('settings-update-msg');
  if (!verEl || !btn || !msg) return;

  // Resolve version: prefer window.api.system.getAppVersion if exposed, else
  // fall back to the placeholder text already in the markup.
  if (window.api?.system?.getAppVersion) {
    window.api.system.getAppVersion()
      .then(v => { verEl.textContent = 'v' + v; })
      .catch(() => {});
  }

  btn.addEventListener('click', async () => {
    msg.textContent = t('settings_update_checking');
    msg.className = 'settings-update-msg';
    btn.disabled = true;
    try {
      const r = window.api?.system?.checkForUpdates
        ? await window.api.system.checkForUpdates()
        : { ok: false, error: 'updater unavailable' };
      msg.textContent = '';   // result is shown in the popup, not inline
      if (!r.ok)                showUpdaterModal('error',     { error: r.error });
      else if (r.updateAvailable) showUpdaterModal('available',  { version: r.version, current: r.current });
      else                      showUpdaterModal('uptodate',  { current: r.current });
    } catch (e) {
      msg.textContent = '';
      showUpdaterModal('error', { error: e && e.message });
    } finally {
      btn.disabled = false;
    }
  });
}

// ─── NAV ─────────────────────────────────────────────────────────────────────
function bindNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    // navTo gates entry: if the tab needs libraries that aren't installed yet,
    // it shows the dedicated #tab-download view first, then returns here once
    // they're ready. Tabs with no required libs (radio/rss/...) open directly.
    item.addEventListener('click', () => navTo(item.dataset.tab, item));
  });
  // Sidebar logo acts as the Home link.
  const logoBtn = document.getElementById('sidebar-logo-btn');
  if (logoBtn) {
    logoBtn.addEventListener('click', () => switchTab('home'));
    // Reflect the initial active tab (home on first launch) on the logo.
    logoBtn.classList.toggle('is-home-active',
      document.getElementById('tab-home')?.classList.contains('active'));
  }
}

function switchTab(tabId, navItem = null) {
  // Live preview is for active recording UX → still stops when leaving Live.
  // Global player (radio + tag editor playback) PERSISTS across tabs by design.
  if (tabId !== 'live') stopLivePreview();
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => { t.classList.add('hidden'); t.classList.remove('active'); });
  // Highlight the specific nav item the user clicked (multiple items may share
  // the same data-tab — e.g. Xtract > Audio and Xtract > Video both point to
  // tab-xtract). Fallback to first matching item if called programmatically.
  (navItem || document.querySelector(`.nav-item[data-tab="${tabId}"]`))?.classList.add('active');
  const el = document.getElementById(`tab-${tabId}`);
  if (el) { el.classList.remove('hidden'); el.classList.add('active'); }
  // Sidebar logo doubles as the Home link — flip it to its "active" treatment
  // (accent yellow background, dark text) while the Home tab is selected.
  const logoBtn = document.getElementById('sidebar-logo-btn');
  if (logoBtn) logoBtn.classList.toggle('is-home-active', tabId === 'home');
  if (tabId === 'history') renderHistory();
  // Xtract sub-view (Audio / Video) is encoded as data-xtract-view on the nav item.
  if (tabId === 'xtract' && navItem) {
    const view = navItem.dataset.xtractView;
    if (view && typeof setXtractView === 'function') setXtractView(view);
  }
}

// ─── GLOBAL KEYBOARD ─────────────────────────────────────────────────────────
function bindGlobalKeys() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
    }
    // `?` (without typing in an input) or Ctrl+/ → open the shortcuts cheatsheet.
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (!inField && (e.key === '?' || (e.ctrlKey && e.key === '/'))) {
      e.preventDefault();
      openShortcutsModal();
    }
  });
  // Click outside modal to close
  document.querySelectorAll('.modal[data-dismissible="true"]').forEach(modal => {
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
  });
}

// Module-level hook so other modules' "Sync to…" buttons can preconfigure the
// Files tab (source folder + type filter) and jump to it. Assigned by bindFiles().
let _openFilesSyncFor = null;

// Longest common directory of a set of file paths (= the folder a module loaded).
function commonDirOf(paths) {
  if (!paths || !paths.length) return null;
  const sep = paths[0].includes('\\') ? '\\' : '/';
  const split = p => p.split(/[\\/]/);
  let common = split(paths[0]); common.pop(); // drop filename
  for (const p of paths.slice(1)) {
    const parts = split(p); parts.pop();
    let i = 0; while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
    if (!common.length) return null;
  }
  return common.join(sep);
}

// Is a module enabled? Single source of truth = config.modules_enabled
// (a module is ON unless explicitly set false). Used to gate cross-module
// integrations at runtime, not just visually.
function isModuleEnabled(id) {
  const m = (typeof config !== 'undefined' && config.modules_enabled) || {};
  return m[id] !== false;
}

// Phase C — gated "Sync to…" hooks in Tag + Images. One click pre-loads the
// File & Sync tab with the module's current folder as source + matching type
// filter; the user then picks a destination and previews. Buttons are hidden
// when the File & Sync module is disabled (applyModuleVisibility via
// data-needs-module) AND the click handler re-checks (explicit IF below).
function bindFilesSyncHooks() {
  const wire = (btnId, getPaths, filter) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (!isModuleEnabled('files')) return; // explicit guard — module must be active
      const dir = commonDirOf(getPaths());
      if (!dir) { showToast({ title: t('files_sync_to') || 'Sync to…', body: t('files_no_folder') || 'Load a folder first.', kind: 'warn', ttl: 4000 }); return; }
      if (_openFilesSyncFor) _openFilesSyncFor(dir, filter);
      else switchTab('files');
    });
  };
  wire('tag-sync-btn', () => tagFiles.map(f => f.path), 'audio');
  wire('img-sync-btn', () => imgFiles.map(f => f.path), 'image');
  wire('vid-sync-btn', () => vidFiles.map(f => f.path), 'video');
}

// ─── FILES & SYNC ───────────────────────────────────────────────────────────
// Source folder → destination (USB/drive), with incremental / two-way / mirror
// modes and a FreeFileSync-style preview grid. Backed by the module-agnostic
// fileops engine in main.js. Mirror deletions are always previewed + confirmed.
function bindFiles() {
  const srcBtn = document.getElementById('files-pick-source');
  if (!srcBtn) return;
  const destBtn    = document.getElementById('files-pick-dest');
  const srcPathEl  = document.getElementById('files-source-path');
  const destPathEl = document.getElementById('files-dest-path');
  const modeGroup  = document.getElementById('files-mode-group');
  const filterGroup= document.getElementById('files-filter-group');
  const modeDescEl = document.getElementById('files-mode-desc');
  const previewBtn = document.getElementById('files-preview-btn');
  const runBtn     = document.getElementById('files-run-btn');
  const gridWrap   = document.getElementById('files-grid-wrap');
  const gridEl     = document.getElementById('files-grid');
  const filtersEl  = document.getElementById('files-filters');
  const statsEl    = document.getElementById('files-stats');
  const emptyEl    = document.getElementById('files-empty');
  const progress   = document.getElementById('files-progress');
  const bar        = progress.querySelector('.progress-bar');
  const barText    = progress.querySelector('.progress-bar-text');
  const profileSel = document.getElementById('files-profile');
  const profSave   = document.getElementById('files-profile-save');
  const profDel    = document.getElementById('files-profile-del');
  const transcodeChk = document.getElementById('files-transcode');
  const m3uChk     = document.getElementById('files-m3u');

  // Single-choice icon controls (replace the old <select>s). Read/write the
  // checked radio; fall back to the first value if none is checked.
  const getMode   = () => (modeGroup.querySelector('input:checked')   || {}).value || 'incremental';
  const getFilter = () => (filterGroup.querySelector('input:checked') || {}).value || 'all';
  const setMode   = v => { const el = modeGroup.querySelector(`input[value="${v}"]`);   if (el) { el.checked = true; updateModeDesc(); } };
  const setFilter = v => { const el = filterGroup.querySelector(`input[value="${v}"]`); if (el) el.checked = true; };
  // Fixed one-line description of the chosen mode, shown under the paths.
  function updateModeDesc() {
    const m = getMode();
    const key = m === 'mirror' ? 'files_mode_mirror_desc'
              : m === 'twoway' ? 'files_mode_twoway_desc'
              :                  'files_mode_incremental_desc';
    // Append which file types will be copied, based on the type filter.
    const f = getFilter();
    const fKey = f === 'audio' ? 'files_copy_audio'
               : f === 'video' ? 'files_copy_video'
               : f === 'image' ? 'files_copy_image'
               :                 'files_copy_all';
    const base = (t(key) || '').replace(/[.\s]+$/, '');
    const copy = t(fKey) || '';
    if (modeDescEl) modeDescEl.textContent = base + copy;
  }
  // Same-folder guard: source and destination can't be the same directory.
  // Returns true (and shows an error) when `a` collides with `b`.
  const samePath = (a, b) => !!a && !!b &&
    a.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase() ===
    b.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();

  let source = null, dest = null, rows = [];
  // Display-categories currently shown in the grid (also gates what runs).
  // Equal/ignored hidden by default to keep the view focused on changes.
  const shown = { new: true, update: true, delete: true, ignore: false };

  const EXTS = {
    audio: ['.mp3','.flac','.m4a','.opus','.ogg','.wav','.aac','.wma'],
    video: ['.mp4','.mkv','.avi','.mov','.webm','.m4v','.wmv','.flv','.mpg','.mpeg'],
    image: ['.jpg','.jpeg','.png','.webp','.gif','.bmp','.tiff','.tif','.heic','.avif']
  };
  const fmtSize = b => {
    if (b == null) return '';
    if (!b) return '0 B';
    const u = ['B','KB','MB','GB','TB']; let i = 0, n = b;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  };
  const extsForFilter = () => (getFilter() === 'all' ? null : EXTS[getFilter()]);
  const payload = () => ({ source, dest, mode: getMode(), exts: extsForFilter(), transcodeMp3: transcodeChk.checked });
  // Engine category → display bucket (equal + ignore collapse into "ignore").
  const dispCat = r => (r.category === 'equal' || r.category === 'ignore') ? 'ignore' : r.category;
  const actIconName = r => r.dir === 'toDest' ? 'arrow-right' : r.dir === 'toSrc' ? 'arrow-left' : r.dir === 'del' ? 'trash-2' : 'equal';
  const CAT_ICON = { new: 'file-plus', update: 'file-pen', delete: 'trash-2', ignore: 'equal' };

  function reset() { rows = []; gridWrap.classList.add('hidden'); emptyEl.classList.add('hidden'); runBtn.disabled = true; }

  // Let other modules preconfigure this tab (their "Sync to…" hook).
  _openFilesSyncFor = (folder, filterType) => {
    if (!folder) return;
    source = folder; srcPathEl.textContent = folder; srcPathEl.title = folder;
    if (filterType) setFilter(filterType);
    reset();
    switchTab('files');
    showToast({ title: t('files_title') || 'Files & Sync', body: t('files_src_set') || 'Source set — pick a destination, then Preview.', kind: 'ok', ttl: 4500 });
  };

  // Reject picking the same folder for both sides — clear only the side just
  // chosen (the "last selected") and surface an error.
  const sameFolderError = () => showToast({
    title: t('files_title') || 'File & Sync',
    body:  t('files_same_folder') || "Source and destination can't be the same folder.",
    kind:  'err', ttl: 5000
  });
  srcBtn.addEventListener('click', async () => {
    const p = await window.api.dialog.pickFolder();
    if (!p) return;
    if (samePath(p, dest)) { source = null; srcPathEl.textContent = '—'; srcPathEl.removeAttribute('title'); reset(); sameFolderError(); return; }
    source = p; srcPathEl.textContent = p; srcPathEl.title = p; reset();
  });
  destBtn.addEventListener('click', async () => {
    const p = await window.api.dialog.pickFolder();
    if (!p) return;
    if (samePath(p, source)) { dest = null; destPathEl.textContent = '—'; destPathEl.removeAttribute('title'); reset(); sameFolderError(); return; }
    dest = p; destPathEl.textContent = p; destPathEl.title = p; reset();
  });
  modeGroup.addEventListener('change', () => { updateModeDesc(); reset(); });
  filterGroup.addEventListener('change', () => { updateModeDesc(); reset(); });
  updateModeDesc();
  // Transcoding needs ffmpeg → ticking the box ensures it (routes to the
  // download view if missing). Two-way mode ignores transcode (no "back").
  transcodeChk.addEventListener('change', () => {
    reset();
    if (transcodeChk.checked) ensureBinaries(['ffmpeg', 'ffprobe'], t('files_title') || 'File & Sync');
  });
  // M3U is a post-sync artifact (doesn't change the plan) → don't reset the
  // grid; just re-evaluate the Sync button (allows playlist-only regeneration).
  m3uChk.addEventListener('change', () => { if (rows.length) updateRunBtn(); });

  // ── Sync profiles (saved source/dest/mode/filter → one-click re-run) ──
  const baseName = p => (p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';
  const profiles = () => (config.sync_profiles ||= []);
  function renderProfiles(selectName) {
    const list = profiles();
    profileSel.innerHTML = `<option value="">${esc(t('files_profile_ph') || '— Profiles —')}</option>` +
      list.map((p, i) => `<option value="${i}"${p.name === selectName ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
    profDel.disabled = profileSel.value === '';
  }
  profileSel.addEventListener('change', () => {
    profDel.disabled = profileSel.value === '';
    const p = profiles()[parseInt(profileSel.value, 10)];
    if (!p) return;
    source = p.source; dest = p.dest;
    srcPathEl.textContent = p.source; srcPathEl.title = p.source;
    destPathEl.textContent = p.dest;  destPathEl.title = p.dest;
    setMode(p.mode || 'incremental');
    setFilter(p.filter || 'all');
    previewBtn.click(); // preconfigured → show the comparison immediately
  });
  profSave.addEventListener('click', async () => {
    if (!source || !dest) { showToast({ title: t('files_profile_save') || 'Save profile', body: t('files_need_paths') || 'Pick a source and a destination first.', kind: 'warn', ttl: 4000 }); return; }
    const name = `${baseName(source)} → ${baseName(dest)}`;
    const list = profiles();
    const existing = list.find(p => p.source === source && p.dest === dest);
    const data = { name, source, dest, mode: getMode(), filter: getFilter() };
    if (existing) Object.assign(existing, data); else list.push(data);
    try { await window.api.config.save(config); } catch {}
    renderProfiles(name);
    showToast({ title: t('files_profile_save') || 'Save profile', body: (t('files_profile_saved') || 'Saved: {name}').replace('{name}', name), kind: 'ok', ttl: 3500 });
  });
  profDel.addEventListener('click', async () => {
    const i = parseInt(profileSel.value, 10);
    if (isNaN(i)) return;
    profiles().splice(i, 1);
    try { await window.api.config.save(config); } catch {}
    renderProfiles();
  });
  renderProfiles();

  // ── PREVIEW → build the comparison grid ──
  previewBtn.addEventListener('click', async () => {
    if (!source || !dest) { appendLog('files-log', t('files_need_paths') || 'Pick a source and a destination first.', 'error'); return; }
    previewBtn.classList.add('btn-loading'); previewBtn.disabled = true;
    try {
      const r = await window.api.fileops.plan(payload());
      if (!r.ok) { appendLog('files-log', `✗ ${r.error}`, 'error'); reset(); return; }
      rows = r.rows.map(x => ({ ...x })); // mutable copies (checkboxes toggle .included)
      renderGrid();
    } finally { previewBtn.classList.remove('btn-loading'); previewBtn.disabled = false; }
  });

  function categoryCounts() {
    const c = { new: 0, update: 0, delete: 0, ignore: 0 };
    rows.forEach(r => c[dispCat(r)]++);
    return c;
  }
  function renderFilters(counts) {
    const defs = [
      { cat: 'new',    label: t('files_cat_new')    || 'New' },
      { cat: 'update', label: t('files_cat_update') || 'Update' },
      { cat: 'delete', label: t('files_cat_delete') || 'Delete' },
      { cat: 'ignore', label: t('files_cat_ignore') || 'Unchanged' }
    ];
    filtersEl.innerHTML = defs.map(d => {
      const n = counts[d.cat] || 0;
      const cls = `files-filter-chip files-cat-${d.cat}${shown[d.cat] ? ' is-active' : ''}${n === 0 ? ' is-empty' : ''}`;
      return `<button type="button" class="${cls}" data-cat="${d.cat}"${n === 0 ? ' disabled' : ''}><span class="files-chip-sym" data-lucide-icon="${CAT_ICON[d.cat]}" data-lucide-size="13"></span> ${esc(d.label)} <strong>${n}</strong></button>`;
    }).join('');
  }
  function renderStats() {
    const toDest = rows.filter(r => r.dir === 'toDest').length;
    const toSrc  = rows.filter(r => r.dir === 'toSrc').length;
    const del    = rows.filter(r => r.dir === 'del').length;
    const srcN   = rows.filter(r => r.srcSize  != null).length;
    const dstN   = rows.filter(r => r.destSize != null).length;
    statsEl.innerHTML =
      `<span class="files-stat" data-lucide-icon="arrow-right" data-lucide-size="14"><strong>${toDest}</strong></span>` +
      (toSrc ? `<span class="files-stat" data-lucide-icon="arrow-left" data-lucide-size="14"><strong>${toSrc}</strong></span>` : '') +
      (del   ? `<span class="files-stat is-danger" data-lucide-icon="trash-2" data-lucide-size="14"><strong>${del}</strong></span>` : '') +
      `<span class="files-stat files-stat-sep">${srcN} ⟷ ${dstN} ${t('files_files') || 'files'}</span>`;
  }
  function rowHtml(r, idx) {
    const cat = dispCat(r);
    const check = r.dir
      ? `<input type="checkbox" class="files-row-check" data-idx="${idx}"${r.included ? ' checked' : ''} />`
      : '<span class="files-row-nocheck"></span>';
    const srcCell = r.srcSize != null
      ? `<span class="files-name">${esc(r.srcRel || r.rel)}</span><span class="files-sz">${fmtSize(r.srcSize)}</span>`
      : '<span class="files-name files-absent">—</span>';
    const dstCell = r.destSize != null
      ? `<span class="files-name">${esc(r.destRel || r.rel)}</span><span class="files-sz">${fmtSize(r.destSize)}</span>`
      : `<span class="files-name files-absent">${r.transcode && r.dir === 'toDest' ? esc(r.destRel) : '—'}</span>`;
    return `<div class="files-grow files-cat-${cat}" data-idx="${idx}">
      <div class="files-grow-src">${srcCell}</div>
      <div class="files-grow-act">${check}<span class="files-act" data-lucide-icon="${actIconName(r)}" data-lucide-size="15"></span></div>
      <div class="files-grow-dst">${dstCell}</div>
    </div>`;
  }
  function updateRunBtn() {
    const anyOp = rows.some(r => r.dir && r.included && shown[dispCat(r)]);
    // Allow a run with no file ops when M3U is requested (regenerate the
    // playlist on an already-synced destination).
    runBtn.disabled = !(anyOp || (m3uChk.checked && rows.length));
  }
  function renderGrid() {
    if (!rows.length) {
      gridWrap.classList.add('hidden');
      emptyEl.classList.remove('hidden');
      emptyEl.textContent = t('files_identical') || 'The two folders are already in sync.';
      runBtn.disabled = true;
      return;
    }
    emptyEl.classList.add('hidden');
    gridWrap.classList.remove('hidden');
    renderFilters(categoryCounts());
    const visible = rows.map((r, i) => [r, i]).filter(([r]) => shown[dispCat(r)]);
    gridEl.innerHTML = visible.length
      ? visible.map(([r, i]) => rowHtml(r, i)).join('')
      : `<div class="files-grid-empty">${t('files_no_rows') || 'Nothing in the selected categories.'}</div>`;
    renderStats();
    updateRunBtn();
    applyLucideIcons(gridWrap); // render the Lucide icons in the rows, chips and stats
  }

  // Per-row include checkbox (delegated).
  gridEl.addEventListener('change', e => {
    const cb = e.target.closest('.files-row-check');
    if (!cb) return;
    const r = rows[parseInt(cb.dataset.idx, 10)];
    if (r) { r.included = cb.checked; updateRunBtn(); }
  });
  // Category filter chips (delegated): toggle show/hide → also gates the run.
  filtersEl.addEventListener('click', e => {
    const chip = e.target.closest('.files-filter-chip');
    if (!chip || chip.disabled) return;
    shown[chip.dataset.cat] = !shown[chip.dataset.cat];
    renderGrid();
  });

  // ── SYNC → run only the visible, checked, actionable rows ──
  runBtn.addEventListener('click', async () => {
    const ops = rows
      .filter(r => r.dir && r.included && shown[dispCat(r)])
      .map(r => ({ srcRel: r.srcRel, destRel: r.destRel, dir: r.dir, transcode: r.transcode, bytes: r.bytes }));
    if (!ops.length && !m3uChk.checked) return;
    const delCount = ops.filter(o => o.dir === 'del').length;
    if (delCount > 0) {
      const ok = await showConfirm({
        title:   t('files_confirm_mirror_title') || 'Delete files on destination?',
        body:    (t('files_confirm_mirror_body') || 'This will permanently DELETE {n} file(s) on the destination. Continue?').replace('{n}', delCount),
        okLabel: t('files_confirm_mirror_ok') || 'Sync & delete',
        danger:  true
      });
      if (!ok) return;
    }
    runBtn.disabled = true; previewBtn.disabled = true;
    progress.classList.remove('hidden');
    bar.style.width = '0%'; barText.textContent = '0%';
    appendLog('files-log', `▶ ${getMode()}: ${source} → ${dest} (${ops.length} ops)`, 'info');
    try {
      const r = await window.api.fileops.run({ source, dest, ops, confirmDelete: delCount > 0, playlistM3u: m3uChk.checked });
      if (r.ok) {
        const back = r.copiedBack ? `, ${r.copiedBack} ${(t('files_copied_back') || 'to source')}` : '';
        const tr   = r.transcoded ? `, ${r.transcoded} ${(t('files_transcoded') || 'transcoded')}` : '';
        const pl   = r.playlist ? `, ${(t('files_m3u_done') || 'playlist {n}').replace('{n}', r.playlist)}` : '';
        appendLog('files-log', `✓ copied ${r.copied}${r.transcoded ? `, transcoded ${r.transcoded}` : ''}${r.copiedBack ? `, back ${r.copiedBack}` : ''}, deleted ${r.deleted}${r.playlist ? `, playlist ${r.playlist}` : ''}`, 'ok');
        showToast({ title: t('files_done') || 'Sync complete', body: `${r.copied} ${(t('files_copied') || 'copied')}${tr}${back}${r.deleted ? `, ${r.deleted} ${(t('files_deleted') || 'deleted')}` : ''}${pl}`, kind: 'ok', ttl: 5000 });
        if (config.notify_on_done) { try { window.api.notify.show({ title: 'FLUX', body: `${t('files_title') || 'Files'}: ${r.copied} copied${r.deleted ? `, ${r.deleted} deleted` : ''}` }); } catch {} }
        // M3U also seeds an INTERNAL FLUX playlist from the source folder's audio.
        if (m3uChk.checked && source) {
          const sep = source.includes('\\') ? '\\' : '/';
          const baseSrc = source.replace(/[\\/]+$/, '');
          const paths = rows.filter(r2 => r2.srcRel).map(r2 => baseSrc + sep + r2.srcRel);
          const name = baseSrc.split(/[\\/]/).filter(Boolean).pop() || 'Sync';
          const n = buildInternalPlaylistFromAudioPaths(name, paths);
          if (n) appendLog('files-log', `✓ internal playlist "${name}" (${n})`, 'ok');
        }
      } else {
        appendLog('files-log', `✗ ${r.error || ((r.errors || []).length + ' error(s)')}`, 'error');
        (r.errors || []).slice(0, 5).forEach(er => appendLog('files-log', `  ${er}`, 'error'));
      }
    } catch (e) {
      appendLog('files-log', `✗ ${e.message}`, 'error');
    } finally {
      previewBtn.disabled = false;
      // Re-scan so the grid reflects the post-sync state.
      try { const r2 = await window.api.fileops.plan(payload()); if (r2.ok) { rows = r2.rows.map(x => ({ ...x })); renderGrid(); } } catch {}
    }
  });

  // Progress (single listener for the session).
  window.api.fileops.onProgress(p => {
    let pct = 0;
    if (p.totalBytes > 0) pct = Math.min(100, Math.floor(p.doneBytes / p.totalBytes * 100));
    else if (p.total > 0) pct = Math.floor((p.done || 0) / p.total * 100);
    bar.style.width = pct + '%'; barText.textContent = pct + '%';
    if (p.phase === 'done') { bar.style.width = '100%'; barText.textContent = '100%'; }
  });
}

// ─── VIDEO EDITOR module (bulk video ops — mirrors the Image Editor) ────────
// Load files/folder → file list on the left (bulk-select switches) → operation
// cards on the right (convert / resize / compress / extract audio / rename).
// Ops apply to the SELECTED files, or ALL loaded when none are selected. Convert
// /resize/compress/extract reuse the ffmpeg xtract handlers per file; rename via
// files:rename (absolute paths). No type filter — it's the video editor.
const VID_EXTS = new Set(['.mp4','.mkv','.avi','.mov','.webm','.m4v','.wmv','.flv','.mpg','.mpeg','.ts','.m2ts','.3gp','.ogv']);
let vidFiles = [];        // [{ path, name, ext }]
let vidSel = new Set();   // selected indexes; empty = "all loaded"

function bindVideo() {
  const loadBtn = document.getElementById('vid-load-files-btn');
  if (!loadBtn) return;
  const folderBtn = document.getElementById('vid-folder-btn');
  const recursive = document.getElementById('vid-folder-recursive');
  const selAllBtn = document.getElementById('vid-select-all-btn');
  const clearBtn  = document.getElementById('vid-clear-btn');

  const addPaths = paths => {
    let added = 0;
    for (const p of (paths || [])) {
      const ext = (p.match(/\.[^.\\/]+$/) || [''])[0].toLowerCase();
      if (!VID_EXTS.has(ext)) continue;
      if (vidFiles.some(f => f.path === p)) continue;
      vidFiles.push({ path: p, name: p.split(/[\\/]/).pop(), ext: ext.replace('.', '') });
      added++;
    }
    renderVideoList();
    return added;
  };

  loadBtn.addEventListener('click', async () => {
    const paths = await window.api.dialog.pickFiles();
    if (paths && paths.length) { const n = addPaths(paths); appendLog('video-log', n ? `+${n} file` : 'no video files', n ? 'ok' : 'log'); }
  });
  folderBtn.addEventListener('click', async () => {
    const folder = await window.api.dialog.pickFolder();
    if (!folder) return;
    const r = await window.api.fileops.list({ folder, exts: [...VID_EXTS], recursive: recursive.checked });
    if (!r.ok) { appendLog('video-log', `✗ ${r.error}`, 'error'); return; }
    appendLog('video-log', `+${addPaths(r.files.map(f => f.abs))} file`, 'ok');
  });
  clearBtn.addEventListener('click', () => { vidFiles = []; vidSel.clear(); renderVideoList(); appendLog('video-log', '— cleared —', 'log'); });
  selAllBtn.addEventListener('click', () => {
    if (vidSel.size < vidFiles.length) vidFiles.forEach((_, i) => vidSel.add(i)); else vidSel.clear();
    renderVideoList();
  });

  document.getElementById('vid-convert-btn').addEventListener('click',  () => runVideoOp('convert',  t('video_convert_all')  || 'Convert'));
  document.getElementById('vid-resize-btn').addEventListener('click',   () => runVideoOp('resize',   t('video_resize_all')   || 'Resize'));
  document.getElementById('vid-compress-btn').addEventListener('click', () => runVideoOp('compress', t('video_compress_all') || 'Compress'));
  document.getElementById('vid-audio-btn').addEventListener('click',    () => runVideoOp('audio',    t('video_extract_all')  || 'Extract audio'));
  document.getElementById('vid-rename-btn').addEventListener('click',   () => runVideoRename());

  bindVideoSplitter();
  renderVideoList();
}

function selectedVideoFiles() {
  if (vidSel.size === 0) return vidFiles.slice();
  return [...vidSel].map(i => vidFiles[i]).filter(Boolean);
}

function renderVideoList() {
  const ul = document.getElementById('vid-file-list');
  if (!ul) return;
  const countEl = document.getElementById('vid-file-count');
  const empty = document.getElementById('vid-empty');
  const form  = document.getElementById('vid-form');
  const hasFiles = vidFiles.length > 0;
  if (countEl) countEl.textContent = hasFiles ? `${vidFiles.length} file(s)` : '—';
  ['vid-select-all-btn','vid-clear-btn','vid-sync-btn','vid-convert-btn','vid-resize-btn','vid-compress-btn','vid-audio-btn','vid-rename-btn']
    .forEach(id => { const el = document.getElementById(id); if (el) el.disabled = !hasFiles; });
  if (empty) empty.classList.toggle('hidden', hasFiles);
  if (form)  form.classList.toggle('hidden', !hasFiles);
  ul.innerHTML = '';
  vidFiles.forEach((f, i) => {
    const li = document.createElement('li');
    li.className = 'tag-file-item';
    li.innerHTML = `
      <label class="import-row-switch" title="${esc(t('tag_bulk_select_hint') || 'Select for bulk actions')}">
        <input type="checkbox" class="vid-file-check" data-idx="${i}" ${vidSel.has(i) ? 'checked' : ''} />
        <span class="switch-slider"></span>
      </label>
      <span class="tag-file-ext" data-lucide-icon="film" data-lucide-size="14"></span>
      <span class="tag-file-name" title="${esc(f.path)}">${esc(f.name)}</span>`;
    ul.appendChild(li);
  });
  ul.querySelectorAll('.vid-file-check').forEach(cb =>
    cb.addEventListener('change', e => { const i = parseInt(cb.dataset.idx, 10); if (cb.checked) vidSel.add(i); else vidSel.delete(i); e.stopPropagation(); }));
  applyLucideIcons(ul);
}

// Convert / resize / compress / extract — loop the ffmpeg xtract handler over
// the target files with an N/M progress bar. ffmpeg gated first.
async function runVideoOp(kind, label) {
  const targets = selectedVideoFiles();
  if (!targets.length) return;
  if (!(await ensureBinaries(['ffmpeg', 'ffprobe'], t('video_title') || 'Video Editor'))) return;
  const wrap = document.getElementById('vid-progress-wrap');
  const bar = document.getElementById('vid-progress'), barText = document.getElementById('vid-progress-text');
  const applyBtns = ['vid-convert-btn','vid-resize-btn','vid-compress-btn','vid-audio-btn','vid-rename-btn'].map(id => document.getElementById(id));
  applyBtns.forEach(b => b && (b.disabled = true));
  wrap.classList.remove('hidden'); bar.style.width = '0%'; barText.textContent = `0/${targets.length}`;
  let done = 0, ok = 0; const errs = [];
  appendLog('video-log', `▶ ${label} (${targets.length})`, 'info');
  for (const f of targets) {
    try {
      let r;
      if      (kind === 'convert')  r = await window.api.xtract.convert({ input: f.path, format: document.getElementById('vid-convert-format').value });
      else if (kind === 'audio')    r = await window.api.xtract.audio({ input: f.path, format: document.getElementById('vid-audio-fmt').value });
      else if (kind === 'resize')   r = await window.api.xtract.resize({ input: f.path, height: parseInt(document.getElementById('vid-resize-h').value, 10) });
      else if (kind === 'compress') r = await window.api.xtract.compress({ input: f.path, crf: parseInt(document.getElementById('vid-crf').value, 10) });
      if (r && r.ok) ok++; else errs.push(`${f.name}: ${r && r.error ? r.error : 'failed'}`);
    } catch (e) { errs.push(`${f.name}: ${e.message}`); }
    done++; bar.style.width = Math.floor(done / targets.length * 100) + '%'; barText.textContent = `${done}/${targets.length}`;
  }
  appendLog('video-log', `✓ ${label}: ${ok}/${targets.length}`, ok ? 'ok' : 'error');
  errs.slice(0, 5).forEach(e => appendLog('video-log', `  ${e}`, 'error'));
  showToast({ title: label, body: `${ok}/${targets.length}`, kind: ok === targets.length ? 'ok' : (ok ? 'warn' : 'err'), ttl: 4500 });
  applyBtns.forEach(b => b && (b.disabled = false));
}

// Batch rename the target files in place (absolute paths → files:rename).
async function runVideoRename() {
  const targets = selectedVideoFiles();
  if (!targets.length) return;
  const pattern = document.getElementById('vid-rename-pattern').value || '{name}';
  const start = parseInt(document.getElementById('vid-rename-start').value, 10) || 0;
  const pad = String(start + Math.max(0, targets.length - 1)).length;
  const renames = [];
  targets.forEach((f, i) => {
    const m = f.name.match(/\.[^.]+$/); const ext = m ? m[0] : '';
    const base = ext ? f.name.slice(0, -ext.length) : f.name;
    const num = String(start + i);
    let nb = pattern
      .replace(/\{name\}/g, base)
      .replace(/\{nnn\}/g, num.padStart(3, '0'))
      .replace(/\{nn\}/g, num.padStart(2, '0'))
      .replace(/\{n\}/g, num.padStart(pad, '0'))
      .replace(/\{ext\}/g, ext.replace(/^\./, ''));
    nb = nb.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
    if (!nb) return;
    const newName = /\{ext\}/.test(pattern) ? nb : nb + ext; // don't double the extension
    const dir = f.path.slice(0, f.path.length - f.name.length);
    const to = dir + newName;
    if (to !== f.path) renames.push({ from: f.path, to });
  });
  if (!renames.length) { showToast({ title: t('files_ren_apply') || 'Rename', body: t('files_ren_none') || 'Nothing to rename.', kind: 'warn', ttl: 3500 }); return; }
  const ok = await showConfirm({
    title:   t('files_ren_apply') || 'Rename',
    body:    (t('files_ren_confirm') || 'Rename {n} file(s)? This changes the files on disk.').replace('{n}', renames.length),
    okLabel: t('files_ren_apply') || 'Rename'
  });
  if (!ok) return;
  const r = await window.api.fileops.rename({ renames }); // absolute paths (no `folder`)
  if (r.renamed) {
    appendLog('video-log', `✓ renamed ${r.renamed}`, 'ok');
    showToast({ title: t('files_ren_apply') || 'Rename', body: `${r.renamed} ${t('files_ren_done') || 'renamed'}`, kind: 'ok', ttl: 4000 });
    const map = new Map(renames.map(x => [x.from, x.to]));
    vidFiles.forEach(f => { if (map.has(f.path)) { f.path = map.get(f.path); f.name = f.path.split(/[\\/]/).pop(); } });
    renderVideoList();
  }
  if (!r.ok) { appendLog('video-log', `✗ ${r.error || (r.errors || []).length + ' error(s)'}`, 'error'); (r.errors || []).slice(0, 5).forEach(er => appendLog('video-log', `  ${er}`, 'error')); }
}

// Sidebar splitter (drag the divider between the file list and the cards).
function bindVideoSplitter() {
  const splitter = document.getElementById('vid-splitter');
  const layout = document.querySelector('#tab-video .tag-layout');
  if (!splitter || !layout) return;
  let dragging = false;
  splitter.addEventListener('mousedown', e => { dragging = true; splitter.classList.add('is-dragging'); document.body.classList.add('tag-splitter-active'); e.preventDefault(); });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rct = layout.getBoundingClientRect();
    const w = Math.max(rct.width * 0.15, Math.min(rct.width * 0.70, e.clientX - rct.left));
    layout.style.setProperty('--tag-sidebar-w', (w / rct.width * 100).toFixed(2) + '%');
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; splitter.classList.remove('is-dragging'); document.body.classList.remove('tag-splitter-active');
    config.vid_sidebar_width = layout.style.getPropertyValue('--tag-sidebar-w') || '40%';
    window.api.config.save(config);
  });
}

// ─── WAVE 1: Global drag-and-drop ───────────────────────────────────────────
// Drop any media file on the window → route to the right tab automatically.
// Multi-file image set → USE > Image batch. Multi-file audio set → Tag Editor.
// Text drop (URL / magnet) → Media downloader. Single file → XTRACT.
function bindGlobalDragDrop() {
  let dragCounter = 0;
  document.addEventListener('dragover', e => {
    if (e.dataTransfer?.types && (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/uri-list'))) {
      e.preventDefault();
    }
  });
  document.addEventListener('dragenter', e => {
    if (!e.dataTransfer?.types) return;
    if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/uri-list')) {
      dragCounter++;
      document.body.classList.add('dnd-active');
    }
  });
  document.addEventListener('dragleave', () => {
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) document.body.classList.remove('dnd-active');
  });
  document.addEventListener('drop', e => {
    e.preventDefault();
    dragCounter = 0;
    document.body.classList.remove('dnd-active');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) {
      // Electron 32+ deprecated File.path; use webUtils via preload.
      const paths = files.map(f => window.api.file.pathForDropped(f)).filter(Boolean);
      if (paths.length) handleDroppedFiles(paths);
      return;
    }
    const text = (e.dataTransfer?.getData('text/plain') || e.dataTransfer?.getData('text/uri-list') || '').trim();
    // Skip internal drags — queue reorder, playlist reorder, image list etc.
    // serialize their item-id / index as text/plain (a small integer). Treat
    // pure-integer or single-letter payloads as in-app drags and stay silent
    // (those handlers run alongside and do their own thing).
    if (!text || /^\d+$/.test(text) || text.length < 4) return;
    handleDroppedText(text);
  });
}

async function handleDroppedFiles(paths) {
  if (!paths.length) return;
  const isImg   = p => /\.(jpg|jpeg|png|webp|avif|tiff|tif|gif|bmp|heic|heif|svg|pdf)$/i.test(p);
  const isAudio = p => /\.(mp3|flac|m4a|aac|ogg|oga|opus|wav)$/i.test(p);
  const isVideo = p => /\.(mp4|mkv|webm|mov|avi|m4v|flv|wmv)$/i.test(p);
  // Multi-file routing — batch tabs win when the whole set fits one type.
  if (paths.length > 1 && paths.every(isImg)) {
    switchTab('images');
    ingestImagePaths(paths);
    showToast({ title: t('dnd_loaded_title') || 'Loaded', body: `${paths.length} image(s) into Image Editor`, kind: 'ok', ttl: 3500 });
    return;
  }
  if (paths.length > 1 && paths.every(isAudio)) {
    switchTab('tag');
    addTagFiles(paths);
    showToast({ title: t('dnd_loaded_title') || 'Loaded', body: `${paths.length} audio file(s) into Audio Editor`, kind: 'ok', ttl: 3500 });
    return;
  }
  // Single file (or mixed set — first wins): route by type.
  const p = paths[0];
  if (/\.pdf$/i.test(p)) {
    switchTab('xtract'); setXtractView('image');
    openXtractPdfPagePicker(p);
    return;
  }
  if (/\.torrent$/i.test(p)) {
    showToast({ title: 'Torrent file', body: '.torrent drop-import not implemented yet — open with your torrent client', kind: 'warn', ttl: 5000 });
    return;
  }
  if (isImage(p) || isAudio(p) || isVideo(p)) {
    const view = isImage(p) ? 'image' : isAudio(p) ? 'audio' : 'video';
    // Pre-null xtractInput BEFORE setXtractView — otherwise that function
    // would mount the trim/image editor with the previous file's path,
    // and the subsequent loadCapturedFile mount would race against it
    // (in some scenarios the stale mount wins visually). With null input,
    // setXtractView is a no-op for the editor mount and loadCapturedFile
    // does the only mount.
    xtractInput = null;
    destroyTrimEditor();
    destroyImageEditor();
    switchTab('xtract');
    setXtractView(view);
    // Audio/video need ffmpeg+ffprobe — prompt to fetch them just like the
    // non-drag flow (images use the bundled sharp, so no gate).
    if (view !== 'image' && !(await ensureBinaries(['ffmpeg', 'ffprobe'], t('nav_xtract') || 'Convert'))) return;
    loadCapturedFile(p);  // reuses the existing single-file XTRACT mount path
    return;
  }
  showToast({ title: t('dnd_unsupported') || 'Unsupported file', body: p.split(/[\\/]/).pop(), kind: 'warn', ttl: 4000 });
}

function isImage(p) { return /\.(jpg|jpeg|png|webp|avif|tiff|tif|gif|bmp|heic|heif|svg)$/i.test(p); }

function handleDroppedText(text) {
  // Magnet link → paste directly into the Torrent search input.
  if (/^magnet:/i.test(text)) {
    switchTab('torrent');
    const q = document.getElementById('torrent-query');
    if (q) {
      q.value = text;
      q.dispatchEvent(new Event('input', { bubbles: true }));
    }
    showToast({ title: t('dnd_loaded_title') || 'Loaded', body: 'Magnet pasted into Torrent search', kind: 'ok', ttl: 3500 });
    return;
  }
  // URL → Media downloader. Accept bare hostnames (google.com) by prepending
  // https:// if no protocol is present.
  const looksLikeUrl = /^https?:\/\//i.test(text)
    || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(text);  // bare domain.tld
  if (looksLikeUrl) {
    const fullUrl = /^https?:\/\//i.test(text) ? text : 'https://' + text;
    switchTab('media');
    const urlInput = document.getElementById('media-url');
    if (urlInput) {
      urlInput.value = fullUrl;
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
      showToast({ title: t('dnd_loaded_title') || 'Loaded', body: 'URL pasted into Media downloader', kind: 'ok', ttl: 3500 });
    }
    return;
  }
  showToast({ title: t('dnd_unsupported') || 'Unsupported drop', body: text.slice(0, 80), kind: 'warn', ttl: 4000 });
}

// ─── WAVE 1: Shortcuts cheatsheet ────────────────────────────────────────────
// Shortcut list — sections and labels are looked up via t() at render time
// so language switches refresh the modal contents on next open.
const SHORTCUTS = [
  { sectionKey: 'shortcuts_sec_global', items: [
    { keys: ['?'],          labelKey: 'shortcuts_open_panel' },
    { keys: ['Ctrl','/'],   labelKey: 'shortcuts_open_panel' },
    { keys: ['Esc'],        labelKey: 'shortcuts_close_modal' },
    { keys: ['Ctrl','Shift','I'], labelKey: 'shortcuts_devtools' }
  ]},
  { sectionKey: 'shortcuts_sec_xtract', items: [
    { keys: ['Middle-click','+ drag'], labelKey: 'shortcuts_pan_canvas' },
    { keys: ['Ctrl','Wheel'],          labelKey: 'shortcuts_zoom_preview' },
    { keys: ['Wheel'],                 labelKey: 'shortcuts_scroll_v' },
    { keys: ['Shift','Wheel'],         labelKey: 'shortcuts_scroll_h' }
  ]},
  { sectionKey: 'shortcuts_sec_trim', items: [
    { keys: ['Enter'], labelKey: 'shortcuts_time_enter' }
  ]},
  { sectionKey: 'shortcuts_sec_dnd', items: [
    { keys: ['Drop file'],     labelKey: 'shortcuts_dnd_single' },
    { keys: ['Drop multiple'], labelKey: 'shortcuts_dnd_multi' },
    { keys: ['Drop URL'],      labelKey: 'shortcuts_dnd_url' }
  ]}
];

function bindShortcutsCheatsheet() {
  document.getElementById('topbar-shortcuts')?.addEventListener('click', openShortcutsModal);
  document.getElementById('shortcuts-close')?.addEventListener('click', () =>
    document.getElementById('shortcuts-modal').classList.add('hidden'));
  document.getElementById('shortcuts-search')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#shortcuts-list .shortcut-row').forEach(row => {
      row.classList.toggle('hidden', q && !row.dataset.label.includes(q));
    });
  });
}

function openShortcutsModal() {
  const list = document.getElementById('shortcuts-list');
  if (!list) return;
  list.innerHTML = '';
  for (const sec of SHORTCUTS) {
    const sectionLabel = t(sec.sectionKey) || sec.sectionKey;
    const wrap = document.createElement('div');
    wrap.className = 'shortcut-section';
    wrap.innerHTML = `<div class="shortcut-section-title">${escapeHtml(sectionLabel)}</div>`;
    for (const it of sec.items) {
      const label = t(it.labelKey) || it.labelKey;
      const row = document.createElement('div');
      row.className = 'shortcut-row';
      row.dataset.label = label.toLowerCase();
      const keysHtml = it.keys.map(k => `<span class="shortcut-key">${escapeHtml(k)}</span>`).join('<span>+</span>');
      row.innerHTML = `<span class="shortcut-label">${escapeHtml(label)}</span><span class="shortcut-keys">${keysHtml}</span>`;
      wrap.appendChild(row);
    }
    list.appendChild(wrap);
  }
  document.getElementById('shortcuts-modal').classList.remove('hidden');
}

// ─── WAVE 1: Notifications history ───────────────────────────────────────────
const NOTIF_HISTORY = [];
const NOTIF_HISTORY_MAX = 200;
let _notifUnread = 0;

// Hook every showToast call by wrapping the existing function. We don't
// modify showToast itself so the existing call sites keep working — we just
// observe what passes through. Records title/body/kind/timestamp for the
// modal log.
const _origShowToast = showToast;
showToast = function(opts) {
  try {
    NOTIF_HISTORY.push({
      title: opts?.title || '',
      body:  opts?.body  || '',
      kind:  opts?.kind  || 'ok',
      ts:    Date.now()
    });
    if (NOTIF_HISTORY.length > NOTIF_HISTORY_MAX) NOTIF_HISTORY.shift();
    _notifUnread++;
    updateNotifBadge();
  } catch {}
  return _origShowToast.call(this, opts);
};

function updateNotifBadge() {
  const badge = document.getElementById('notif-history-badge');
  if (!badge) return;
  if (_notifUnread > 0) {
    badge.textContent = String(_notifUnread > 99 ? '99+' : _notifUnread);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

// ─── WAVE 1 (extra): Topbar collapsible cards ────────────────────────────────
// Click the music badge (left cap) → collapses the player card to the right.
// Click the settings badge (right cap) → collapses the actions card to the
// left. Toggle = expand again. State is persisted to config so the user's
// chosen layout survives across restarts.
// Tooltip on the music badge — composes the current playback info so the
// user can read what's playing even when the player card is collapsed and
// only the badge is visible. Format:
//   • Radio with ICY song info  →  "Station Name — Song Title"
//   • Anything else             →  the title text from the player
//   • Nothing playing           →  the "Identify song" tooltip default
function updatePlayerBadgeTooltip() {
  const badge = document.querySelector('.topbar-player-icon');
  if (!badge) return;
  const title  = (document.getElementById('global-player-title')?.textContent || '').trim();
  const source = (document.getElementById('global-player-source')?.textContent || '').trim();
  const icy    = (document.getElementById('global-player-icy-title')?.textContent || '').trim();
  const nothingPlaying = !document.getElementById('global-player-bar')?.classList.contains('is-playing');
  if (nothingPlaying) {
    badge.removeAttribute('title');
    return;
  }
  const radioWithSong = /radio/i.test(source) && icy;
  const tip = radioWithSong ? `${title} — ${icy}` : title;
  if (tip) badge.title = tip;
  else     badge.removeAttribute('title');
}

function bindTopbarCardCollapse() {
  const musicBadge    = document.querySelector('.topbar-player-icon');
  const settingsBadge = document.querySelector('.topbar-settings-icon');
  const playerCard    = document.getElementById('global-player-bar');
  const actionsCard   = document.querySelector('.topbar-actions-card');
  // Apply saved state immediately (no transition flicker — the cards mount
  // already collapsed if that's what the user left behind last session).
  // Disable transitions during the initial paint so we don't see them
  // animate from open → closed on startup.
  if (playerCard && config.topbar_player_collapsed) {
    playerCard.classList.add('collapsed', 'no-anim');
    requestAnimationFrame(() => playerCard.classList.remove('no-anim'));
  }
  if (actionsCard && config.topbar_actions_collapsed) {
    actionsCard.classList.add('collapsed', 'no-anim');
    requestAnimationFrame(() => actionsCard.classList.remove('no-anim'));
  }
  const persist = async () => { try { await window.api.config.save(config); } catch {} };
  if (musicBadge && playerCard) {
    musicBadge.addEventListener('click', () => {
      toggleTopbarCard({ card: playerCard, icon: musicBadge });
      config.topbar_player_collapsed = playerCard.classList.contains('collapsed');
      persist();
    });
  }
  if (settingsBadge && actionsCard) {
    // The right-side card uses a simple horizontal SLIDE/collapse (CSS
    // transition on max-width + opacity, anchored toward the settings icon),
    // NOT the centre player's fade-then-FLIP effect — the straight slide reads
    // more fluid (this is the original behaviour). Toggle .collapsed directly
    // and let CSS animate it.
    settingsBadge.addEventListener('click', () => {
      actionsCard.classList.toggle('collapsed');
      config.topbar_actions_collapsed = actionsCard.classList.contains('collapsed');
      persist();
    });
  }
}

// Two-stage card toggle with FLIP icon animation. The visual flow the user
// asked for is asymmetric — same idea each direction, just reversed order:
//   • COLLAPSE: card fades out first → THEN the icon slides into its
//     "centered drop-tab" position via FLIP (animating the actual layout
//     change rather than a snap-cut).
//   • EXPAND: icon slides BACK to its in-card position first → THEN the
//     card fades back in. The icon's arrival "pulls" the card into view.
function toggleTopbarCard({ card, icon }) {
  const isCollapsing = !card.classList.contains('collapsed');
  if (isCollapsing) {
    // Phase 1: card fade-out (CSS transition on opacity).
    card.classList.add('fading-out');
    const onFaded = (e) => {
      if (e.target !== card || e.propertyName !== 'opacity') return;
      card.removeEventListener('transitionend', onFaded);
      // Phase 2: FLIP-animate the icon into its drop-tab position.
      flipIcon(icon, () => {
        card.classList.remove('fading-out');
        card.classList.add('collapsed');
      });
    };
    card.addEventListener('transitionend', onFaded);
  } else {
    // Phase 1: FLIP-animate the icon back to its in-card position. We must
    // remove .collapsed BEFORE measuring the "last" rect — otherwise the
    // icon is still in drop-tab form and the delta is wrong.
    flipIcon(icon, () => {
      card.classList.remove('collapsed');
    });
    // Phase 2: card opacity is at 0 (.collapsed removed opacity 0); fade
    // it back in. Already in flow now, just needs the opacity transition.
    // A small delay lines the fade-in up with the tail of the icon slide.
    setTimeout(() => {
      card.classList.add('fading-out');   // ensures opacity 0 starting point
      requestAnimationFrame(() => card.classList.remove('fading-out'));
    }, 180);
  }
}

// FLIP technique — animates an element through a layout change that CSS
// transitions can't directly handle (e.g. switching position: static →
// absolute). Three critical phases:
//   1. Capture FIRST bounds.
//   2. Disable ALL transitions on the element, apply the class change.
//      Without this, CSS transitions on top/left/margin/border-radius
//      fight with our FLIP transform → ugly mixed animation.
//   3. Capture LAST bounds with a forced reflow, then invert via transform
//      (icon visually snaps to its old position), re-enable transitions,
//      and clear the transform — letting CSS animate it back to the new
//      position smoothly via the single `transform` channel.
function flipIcon(icon, mutator) {
  const first = icon.getBoundingClientRect();
  // Freeze transitions so the class swap is instant — no competing animations.
  icon.style.transition = 'none';
  icon.style.transform  = '';
  mutator();
  void icon.offsetWidth;            // force layout flush, commits the class change
  const last = icon.getBoundingClientRect();
  const dx = first.left - last.left;
  const dy = first.top  - last.top;
  if (dx === 0 && dy === 0) {
    icon.style.transition = '';
    return;
  }
  // Snap icon back to its first-frame position via inline transform.
  icon.style.transform = `translate(${dx}px, ${dy}px)`;
  void icon.offsetWidth;            // commit the inline transform
  // Next frame: drop the inline overrides → CSS transition on `transform`
  // kicks in and slides the icon from translate(dx,dy) back to none —
  // visually traversing from FIRST to LAST position over 0.35 s.
  requestAnimationFrame(() => {
    icon.style.transition = '';
    icon.style.transform  = '';
  });
}

// ─── WAVE 1 (extra): Music icon cycle during playback ────────────────────────
// While the global player is playing (body class .is-playing on the player
// card), the music badge cycles through music-themed icons every 2 s with a
// short crossfade. Stops + resets to the default `music` icon on pause/stop.
// Driven by a MutationObserver so we don't have to thread cycle start/stop
// through every play / stop / switch code path.
const PLAYER_ICON_CYCLE = ['music', 'music-2', 'music-3', 'music-4', 'audio-lines', 'headphones', 'disc'];
let _iconCycleTimer = null;
let _iconCycleIdx = 0;

function bindPlayerIconCycle() {
  const playerCard = document.getElementById('global-player-bar');
  if (!playerCard) return;
  const observer = new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'attributes' && m.attributeName === 'class') {
        if (playerCard.classList.contains('is-playing')) startPlayerIconCycle();
        else stopPlayerIconCycle();
      }
    }
  });
  observer.observe(playerCard, { attributes: true, attributeFilter: ['class'] });
}

function startPlayerIconCycle() {
  stopPlayerIconCycle();
  const icon = document.querySelector('.topbar-player-icon');
  if (!icon) return;
  _iconCycleIdx = 0;
  _iconCycleTimer = setInterval(() => {
    icon.classList.add('fading');
    // Wait the CSS fade-out (matches `transition: opacity 0.35s` on .lucide-slot)
    setTimeout(() => {
      _iconCycleIdx = (_iconCycleIdx + 1) % PLAYER_ICON_CYCLE.length;
      icon.setAttribute('data-lucide-icon', PLAYER_ICON_CYCLE[_iconCycleIdx]);
      applyLucideIcons(icon.parentElement || document);
      icon.classList.remove('fading');
    }, 350);
  }, 2000);
}

function stopPlayerIconCycle() {
  if (_iconCycleTimer) clearInterval(_iconCycleTimer);
  _iconCycleTimer = null;
  const icon = document.querySelector('.topbar-player-icon');
  if (!icon) return;
  icon.classList.remove('fading');
  icon.setAttribute('data-lucide-icon', 'music');
  applyLucideIcons(icon.parentElement || document);
}

function bindNotificationsHistory() {
  document.getElementById('topbar-notif-history')?.addEventListener('click', () => {
    renderNotifHistory();
    _notifUnread = 0;
    updateNotifBadge();
    document.getElementById('notif-history-modal').classList.remove('hidden');
  });
  document.getElementById('notif-history-close')?.addEventListener('click', () =>
    document.getElementById('notif-history-modal').classList.add('hidden'));
  document.getElementById('notif-history-clear')?.addEventListener('click', () => {
    NOTIF_HISTORY.length = 0;
    _notifUnread = 0;
    updateNotifBadge();
    renderNotifHistory();
  });
}

function renderNotifHistory() {
  const list = document.getElementById('notif-history-list');
  if (!list) return;
  list.innerHTML = '';
  if (!NOTIF_HISTORY.length) {
    list.innerHTML = `<p class="muted">${escapeHtml(t('notif_history_empty') || 'No notifications yet in this session.')}</p>`;
    return;
  }
  // Newest first.
  [...NOTIF_HISTORY].reverse().forEach(n => {
    const div = document.createElement('div');
    div.className = `notif-history-entry notif-${n.kind}`;
    const time = new Date(n.ts).toLocaleTimeString();
    div.innerHTML = `
      ${n.title ? `<span class="notif-history-title">${escapeHtml(n.title)}</span>` : ''}
      ${n.body  ? `<span class="notif-history-body">${escapeHtml(n.body)}</span>`   : ''}
      <span class="notif-history-time">${escapeHtml(time)}</span>
    `;
    list.appendChild(div);
  });
}

// History full-text search was already implemented via #history-filter (see
// the renderHistory binding) — nothing more to do here.

// ─── TORRENT ─────────────────────────────────────────────────────────────────
function bindTorrent() {
  const qInput = document.getElementById('torrent-query');
  document.getElementById('torrent-search-btn').addEventListener('click', doTorrentSearch);
  qInput.addEventListener('keydown', e => { if (e.key === 'Enter') doTorrentSearch(); });
}

async function doTorrentSearch() {
  const query = document.getElementById('torrent-query').value.trim();
  if (!query) return;
  torrentResults = [];
  document.getElementById('torrent-results-wrap').classList.add('hidden');
  clearLog('torrent-log');
  appendLog('torrent-log', t('torrent_searching', { q: query }), 'info');

  const activeSites = Object.keys(config.sites).filter(s => config.sites[s].enabled);
  if (!activeSites.length) { appendLog('torrent-log', t('torrent_no_sources'), 'error'); return; }
  buildSiteChips(activeSites);
  document.getElementById('torrent-search-btn').disabled = true;

  try {
    const { results, errors } = await window.api.torrent.search(query, config);
    errors.forEach(e => appendLog('torrent-log', e, 'error'));
    torrentResults = results;
    renderTorrentResults(results);
    appendLog('torrent-log', t('torrent_found', { n: results.length }), results.length > 0 ? 'ok' : 'log');
  } catch(e) {
    appendLog('torrent-log', `✗ ${e.message}`, 'error');
  } finally {
    document.getElementById('torrent-search-btn').disabled = false;
  }
}

function buildSiteChips(sites) {
  const row = document.getElementById('site-status-row');
  row.innerHTML = '';
  sites.forEach(site => {
    const c = document.createElement('span');
    c.className = 'site-chip searching'; c.id = `chip-${site}`; c.textContent = site;
    row.appendChild(c);
  });
}

function markSiteDone(site) {
  const c = document.getElementById(`chip-${site}`);
  if (c) c.classList.replace('searching', 'done');
}

// Jump to Settings → Integrations → "Send torrents to client" and nudge the
// user to enable+configure it. Used when a send-to-client action is clicked
// while the integration is off.
function openSendtoSettings() {
  switchTab('settings');
  if (typeof renderSettings === 'function') renderSettings();
  const titleEl = document.querySelector('#settings-panels .settings-section-title[data-i18n="settings_sendto"]');
  const sec = titleEl && titleEl.closest('.settings-section');
  if (sec) selectSettingsPanel(sec.id);
  showToast({
    title: t('queue_send_setup') || 'Enable send-to-client first',
    body:  t('queue_send_setup_body') || 'Turn on “Send torrents to client”, fill in your client (e.g. qBittorrent) and save.',
    kind:  'warn',
    ttl:   6500
  });
}

function renderTorrentResults(results) {
  const wrap  = document.getElementById('torrent-results-wrap');
  const tbody = document.getElementById('torrent-tbody');
  tbody.innerHTML = '';
  if (!results.length) { wrap.classList.add('hidden'); return; }
  document.getElementById('results-count').textContent = `${results.length} result${results.length !== 1 ? 's' : ''}`;
  results.forEach((r, i) => {
    const sc  = r.seeds > 50 ? 'seeds-high' : r.seeds > 10 ? 'seeds-medium' : 'seeds-low';
    const nm  = r.name.length > 58 ? r.name.substring(0,55)+'…' : r.name;
    const tr  = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-num">${i+1}</td>
      <td class="td-name"><span class="td-name-inner" title="${esc(r.name)}">${esc(nm)}</span></td>
      <td class="${sc}">${r.seeds}</td>
      <td class="td-dim">${r.leeches}</td>
      <td class="td-dim">${r.size}</td>
      <td class="td-site">${r.site}</td>
      <td class="td-actions">
        ${(r.magnet||r.url) ? `<button class="btn-save-row${config.sendto_enabled ? '' : ' is-inactive'}" data-send="${i}" data-lucide-icon="send" title="${esc(t('queue_send_client') || 'Send to client')}"></button>` : ''}
        ${r.url    ? `<button class="btn-save-row btn-torrent" data-idx="${i}" data-mode="torrent" data-lucide-icon="save" title=".torrent"></button>` : ''}
        ${(r.magnet||r.url) ? `<button class="btn-save-row btn-copy" data-idx="${i}" data-mode="copy" data-lucide-icon="magnet" title="${esc(t('torrent_copy_magnet'))}"></button>` : ''}
        <button class="btn-save-row btn-queue" data-queue="${i}" data-lucide-icon="download" title="${esc(t('torrent_queued_short'))}"></button>
      </td>`;
    tbody.appendChild(tr);
  });
  applyLucideIcons(tbody);
  tbody.querySelectorAll('[data-idx]').forEach(b =>
    b.addEventListener('click', () => doTorrentAction(torrentResults[+b.dataset.idx], b.dataset.mode)));
  tbody.querySelectorAll('[data-queue]').forEach(b =>
    b.addEventListener('click', () => addTorrentToQueue(torrentResults[+b.dataset.queue])));
  tbody.querySelectorAll('[data-send]').forEach(b =>
    b.addEventListener('click', async () => {
      const it = torrentResults[+b.dataset.send];
      if (!it) return;
      if (!config.sendto_enabled) { openSendtoSettings(); return; }
      const magnet = it.magnet || (/^magnet:/i.test(it.url || '') ? it.url : null);
      b.disabled = true;
      const r = await window.api.sendto.torrent({ magnet, url: it.url || null, name: it.name });
      b.disabled = false;
      if (r.ok) showToast({ title: t('queue_sent_client') || 'Sent to client', body: `${it.name}${r.sentTo ? ' (' + r.sentTo + ')' : ''}`, kind: 'ok', ttl: 3000 });
      else showToast({ title: t('queue_send_fail') || 'Send to client failed', body: r.error || '', kind: 'err', ttl: 7000 });
    }));
  wrap.classList.remove('hidden');
}

async function doTorrentAction(item, mode) {
  if (!item) return;
  const resolvedMode = mode === 'auto' ? (item.url ? 'torrent' : 'magnet') : mode;

  if (resolvedMode === 'copy') {
    const magnet = item.magnet;
    if (!magnet) {
      // Surface "no magnet" via toast — the log alone is invisible when
      // activity logs are collapsed (default), so the user-facing impression
      // was "button does nothing" even though we returned cleanly.
      appendLog('torrent-log', '✗ No magnet link available.', 'error');
      showToast({ title: t('torrent_no_magnet_title') || 'No magnet', body: item.name, kind: 'warn', ttl: 3500 });
      return;
    }
    await window.api.clipboard.write(magnet);
    appendLog('torrent-log', `✓ Magnet copied: ${item.name}`, 'ok');
    showToast({ title: t('torrent_magnet_copied_title') || 'Magnet copied', body: item.name, kind: 'ok', ttl: 3000 });
    return;
  }
  if (resolvedMode === 'torrent' && !item.url) {
    appendLog('torrent-log', '✗ No .torrent file — try magnet.', 'error'); return;
  }
  if (resolvedMode === 'magnet' && !item.magnet && !item.url) {
    appendLog('torrent-log', '✗ No magnet available.', 'error'); return;
  }

  const itemToSave = resolvedMode === 'torrent'
    ? { ...item, type: 'torrent' }
    : { ...item, type: 'magnet', url: null };

  // Send-to-client takeover: when the user has wired up qBittorrent /
  // Transmission in Settings, FLUX hands the magnet to the external client
  // instead of downloading locally. The local .torrent save path is
  // bypassed entirely so we don't double-download.
  if (config.sendto_enabled && (item.magnet || itemToSave.url)) {
    const linkToSend = item.magnet || itemToSave.url;
    const r = await window.api.sendto.torrent({ magnet: item.magnet || null, url: itemToSave.url || null, name: item.name });
    if (r.ok) {
      const where = r.sentTo ? ` (${r.sentTo})` : '';
      appendLog('torrent-log', `✓ Sent to external client${where}: ${item.name}`, 'ok');
      if (config.history_enabled !== false) {
        await window.api.history.append({ kind: 'torrent', name: item.name, ok: true, source: `${item.site} → ${r.sentTo || 'remote'}` });
      }
    } else {
      appendLog('torrent-log', `✗ Send-to-client failed: ${r.error}`, 'error');
    }
    return;
  }

  const r = await window.api.torrent.save({ item: itemToSave, downloadFolder: config.download_folder });
  if (r.ok) {
    appendLog('torrent-log', `✓ Saved [${resolvedMode}]: ${r.path}`, 'ok');
    if (config.history_enabled !== false) {
      await window.api.history.append({ kind: 'torrent', name: item.name, ok: true, path: r.path, source: item.site });
    }
    notifyMediaServer({ kind: 'torrent', path: r.path, logId: 'torrent-log' });
  } else {
    appendLog('torrent-log', `✗ ${r.error}`, 'error');
  }
}

function addTorrentToQueue(item) {
  queue.push({ id: newId(), type: 'torrent', name: item.name, torrentItem: item, status: 'pending', origin: 'torrent' });
  window.api.queue.save(queue);
  renderQueue();
  appendLog('torrent-log', t('torrent_queued', { name: item.name }), 'info');
  // Toast feedback — the log line alone is invisible when the activity log
  // panel is collapsed (default state), so users perceived the button as
  // "non-responsive" even though the queue was updating correctly.
  showToast({
    title: t('torrent_queued_title') || 'Queued for download',
    body:  item.name,
    kind:  'ok',
    ttl:   3000,
    actions: [{ label: t('torrent_open_queue') || 'Open Queue', onClick: () => switchTab('queue') }]
  });
}

// ─── MEDIA ───────────────────────────────────────────────────────────────────
function bindMedia() {
  document.getElementById('media-download-btn').addEventListener('click', async () => {
    const url    = document.getElementById('media-url').value.trim();
    const format = document.querySelector('input[name="media-format"]:checked').value;
    if (!url) { appendLog('media-log', t('media_no_url'), 'error'); return; }
    // Lazy binaries: fetch yt-dlp/ffmpeg/ffprobe (with confirm) if not present.
    if (!(await ensureBinaries(['yt-dlp', 'ffmpeg', 'ffprobe'], t('nav_media') || 'Media'))) return;
    stopGlobalPlayer(); // halt any active preview before consuming bandwidth on the download
    clearLog('media-log');
    document.getElementById('media-download-btn').disabled = true;
    document.getElementById('media-stop-btn').classList.remove('hidden');
    appendLog('media-log', t('media_starting', { url }), 'info');
    // Surface this immediate download in the global tracker so the topbar icon
    // reflects it (single hub for all in-flight downloads, regardless of source).
    const trackerEntry = addDownloadEntry({
      title:  currentMediaTitle || url,
      source: 'media · ' + (FORMAT_LABEL[format] || format),
      status: 'running'
    });
    // Auto-open the Downloads popup so the user sees their download
    // progressing without having to click the 📥 icon themselves. The
    // inline progress bar in the Media tab is gone — progress lives only
    // in the popup now.
    document.getElementById('downloads-modal').classList.remove('hidden');
    const r = await window.api.media.download({ url, format, downloadFolder: config.download_folder, retry: config.retry_count });
    document.getElementById('media-download-btn').disabled = false;
    document.getElementById('media-stop-btn').classList.add('hidden');
    if (r.stopped) {
      appendLog('media-log', '⏹ Stopped by user', 'info');
      updateDownloadEntry(trackerEntry.id, { status: 'error', error: 'stopped by user' });
      return;
    }
    if (r.ok) {
      appendLog('media-log', t('media_done'), 'ok');
      updateDownloadEntry(trackerEntry.id, { status: 'done', path: r.path });
      if (config.notify_on_done) window.api.notify.show({ title: 'FLUX', body: t('media_done') });
      if (config.history_enabled !== false) {
        await window.api.history.append({ kind: 'media', name: url, ok: true, path: r.path, source: 'yt-dlp' });
      }
      // Audio: route through autoTagAfterDownload so library-organize +
      //        media-server notify both fire after any tags-from-file step.
      //        We pass no MusicBrainz hint — the file already has yt-dlp's
      //        metadata baked in, so auto-tag will no-op cleanly.
      // Video: no auto-tag pipeline — notify directly.
      const isAudio = /\.(mp3|flac|m4a|opus|ogg|wav|aac)$/i.test(r.path || '');
      if (isAudio) autoTagAfterDownload(r.path, null, 'media-log', null, trackerEntry.id);
      else       { notifyMediaServer({ kind: 'media', path: r.path, logId: 'media-log' });
                   autoOrganizeImage(r.path, 'media-log', trackerEntry.id); }
    } else {
      appendLog('media-log', `✗ ${r.error || 'unknown error'}`, 'error');
      updateDownloadEntry(trackerEntry.id, { status: 'error', error: r.error || 'unknown error' });
      if (config.history_enabled !== false) {
        await window.api.history.append({ kind: 'media', name: url, ok: false, error: r.error });
      }
    }
  });

  document.getElementById('media-stop-btn').addEventListener('click', async () => {
    await window.api.media.stop({ downloadFolder: config.download_folder });
  });

  // Preview button — fetches stream URL via yt-dlp -g and plays in global
  // topbar player (audio) or video modal. Video URLs can take a few seconds
  // to resolve; the btn-loading spinner gives the user a clear "wait" signal.
  document.getElementById('media-preview-btn').addEventListener('click', async () => {
    const url = document.getElementById('media-url').value.trim();
    if (!url) return;
    const btn = document.getElementById('media-preview-btn');
    btn.classList.add('btn-loading');
    btn.disabled = true;
    try {
      await previewMediaUrl(url, currentMediaTitle || url, '🔍 MEDIA PREVIEW');
    } finally {
      btn.classList.remove('btn-loading');
      btn.disabled = false;
    }
  });

  document.getElementById('media-queue-btn').addEventListener('click', () => {
    const url    = document.getElementById('media-url').value.trim();
    const format = document.querySelector('input[name="media-format"]:checked').value;
    if (!url) { appendLog('media-log', t('media_no_url'), 'error'); return; }
    // Allow same URL with multiple formats — only dedupe identical (url, format) pairs.
    const existing = queue.find(q => q.type === 'media' && q.url === url && q.format === format && q.status === 'pending');
    if (existing) { appendLog('media-log', `· already queued: ${url} [${format}]`, 'log'); return; }
    const displayName = currentMediaTitle || url;
    queue.push({ id: newId(), type: 'media', name: displayName, title: currentMediaTitle, url, format, status: 'pending', origin: 'media' });
    window.api.queue.save(queue);
    renderQueue();
    appendLog('media-log', `+ Queue: ${displayName} [${format}]`, 'info');
    // NB: do NOT clear the URL field — user may want to add the same URL with another format
  });

  // URL → title probe (debounced)
  const urlInput = document.getElementById('media-url');
  let probeTimer = null;
  urlInput.addEventListener('input', () => {
    clearTimeout(probeTimer);
    const url = urlInput.value.trim();
    if (!/^https?:\/\//i.test(url)) { hideMediaTitlePreview(); return; }
    probeTimer = setTimeout(() => probeUrlAndShow(url), 600);
  });
  urlInput.addEventListener('paste', () => {
    clearTimeout(probeTimer);
    setTimeout(() => {
      const url = urlInput.value.trim();
      if (/^https?:\/\//i.test(url)) probeUrlAndShow(url);
    }, 50);
  });
}

let currentMediaTitle = null;
let probeToken = 0; // race-condition guard for stale probes

function setMediaButtonsEnabled(enabled) {
  document.getElementById('media-download-btn').disabled = !enabled;
  document.getElementById('media-queue-btn').disabled    = !enabled;
  const previewBtn = document.getElementById('media-preview-btn');
  if (previewBtn) previewBtn.disabled = !enabled;
}

// Dim format radios that can't be satisfied by the probed source. Reads the
// max video height returned by yt-dlp's probe and disables higher-tier
// presets. Audio-only formats are always available (any video has audio,
// and audio-only sources don't expose a height anyway). Called from
// probeUrlAndShow on success; reset when the URL is cleared.
function applyAvailableFormatHints(maxHeight) {
  // Format-radio definitions: button value → minimum height required.
  // Audio formats (mp3/flac/m4a/opus) always pass; video presets need
  // their nominal height available.
  const heightFor = { video_1080: 1080, video_720: 720 };
  document.querySelectorAll('input[name="media-format"]').forEach(radio => {
    const need = heightFor[radio.value];
    if (need && maxHeight && need > maxHeight) {
      radio.disabled = true;
      radio.closest('label')?.classList.add('media-format-unavailable');
    } else {
      radio.disabled = false;
      radio.closest('label')?.classList.remove('media-format-unavailable');
    }
  });
}

// Preview an arbitrary URL — routes audio formats to the topbar global player
// and video formats to a video modal so the user can actually SEE the stream.
// Format is read from the Media tab radio buttons; callers can override via
// the `wantVideo` flag (queue items pass it explicitly).
async function previewMediaUrl(url, displayTitle, sourceLabel = '🔍 PREVIEW', wantVideo = null) {
  if (!url) return;
  appendLog('media-log', `🔍 Preview: resolving ${url}…`, 'info');
  const r = await window.api.media.getStreamUrl(url);
  if (!r.ok || !r.url) {
    const reason = r.error || 'no stream URL';
    appendLog('media-log', `✗ Preview: ${reason}`, 'error');
    showToast({
      title: t('preview_toast_error_title'),
      body:  reason,
      kind:  'err',
      ttl:   6000
    });
    return;
  }
  // Decide video vs audio: explicit override > Media tab selection.
  const formatRadio = document.querySelector('input[name="media-format"]:checked');
  const fmt = formatRadio ? formatRadio.value : '';
  const isVideoFormat = wantVideo !== null
    ? wantVideo
    : /^(video|mp4|mkv)/.test(fmt);
  if (isVideoFormat) {
    openVideoPreview({ streamUrl: r.url, originalUrl: url, title: displayTitle || url });
  } else {
    playInGlobalPlayer({
      url: r.url,
      title: displayTitle || url,
      source: sourceLabel,
      id: url,
      isHls: /\.m3u8(\?|$)/i.test(r.url)
    });
  }
}

// ─── VIDEO PREVIEW MODAL ────────────────────────────────────────────────────
// HLS streams use hls.js attached to <video>; everything else goes straight
// to the element's src. Closes pause/cleanup the resources on close.
let videoPreviewHls = null;

function openVideoPreview({ streamUrl, originalUrl, title }) {
  // Stop the audio player while a video preview is on — same bandwidth budget.
  stopGlobalPlayer({ silent: true });
  const modal = document.getElementById('video-preview-modal');
  const video = document.getElementById('video-preview-element');
  const titleEl = document.getElementById('video-preview-title');
  const metaEl  = document.getElementById('video-preview-meta');
  if (!modal || !video) return;

  if (videoPreviewHls) { try { videoPreviewHls.destroy(); } catch {} videoPreviewHls = null; }
  try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}

  titleEl.textContent = title;
  metaEl.textContent  = originalUrl;
  // Remember the original URL for the Download button click.
  modal.dataset.originalUrl = originalUrl;
  modal.dataset.title       = title;

  const isHls = /\.m3u8(\?|$)/i.test(streamUrl);
  if (isHls && window.Hls && window.Hls.isSupported()) {
    videoPreviewHls = new window.Hls();
    videoPreviewHls.loadSource(streamUrl);
    videoPreviewHls.attachMedia(video);
    videoPreviewHls.on(window.Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
  } else {
    video.src = streamUrl;
    video.play().catch(() => {});
  }
  modal.classList.remove('hidden');
}

function closeVideoPreview() {
  const modal = document.getElementById('video-preview-modal');
  const video = document.getElementById('video-preview-element');
  if (!modal) return;
  if (videoPreviewHls) { try { videoPreviewHls.destroy(); } catch {} videoPreviewHls = null; }
  try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}
  modal.classList.add('hidden');
}

function bindVideoPreviewModal() {
  const modal = document.getElementById('video-preview-modal');
  if (!modal) return;
  document.getElementById('video-preview-close')?.addEventListener('click', closeVideoPreview);
  document.getElementById('video-preview-download')?.addEventListener('click', () => {
    const orig = modal.dataset.originalUrl;
    if (!orig) return;
    const urlInput = document.getElementById('media-url');
    if (urlInput) urlInput.value = orig;
    closeVideoPreview();
    switchTab('media');
    if (urlInput) urlInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Fullscreen toggle — uses the standard browser Fullscreen API on the
  // <video> element. Esc exits as usual. We swap the icon (maximize <->
  // minimize) and the title via the fullscreenchange event.
  const video  = document.getElementById('video-preview-element');
  const fsBtn  = document.getElementById('video-preview-fs-btn');
  fsBtn?.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (video?.requestFullscreen) {
      video.requestFullscreen().catch(() => {});
    }
  });
  document.addEventListener('fullscreenchange', () => {
    if (!fsBtn) return;
    const inFs = !!document.fullscreenElement;
    fsBtn.setAttribute('data-lucide-icon', inFs ? 'minimize' : 'maximize');
    fsBtn.removeAttribute('data-lucide-rendered');  // force re-render
    // Drop the existing slot so applyLucideIcons creates it fresh.
    fsBtn.querySelector(':scope > .lucide-slot')?.remove();
    applyLucideIcons(fsBtn);
  });
  // Click-outside-to-close (but only if the click is on the BACKDROP, not on
  // the resized modal-box).
  modal.addEventListener('click', e => { if (e.target === modal) closeVideoPreview(); });
}

async function probeUrlAndShow(url) {
  const wrap    = document.getElementById('media-title-preview');
  const titleEl = document.getElementById('media-title-text');
  const metaEl  = document.getElementById('media-title-meta');
  wrap.classList.remove('hidden');
  wrap.classList.remove('preview-invalid', 'preview-valid');
  wrap.classList.add('preview-probing');
  titleEl.textContent = 'Checking URL…';
  metaEl.textContent  = url;
  setMediaButtonsEnabled(false);

  const myToken = ++probeToken;
  const r = await window.api.media.probe(url);
  if (myToken !== probeToken) return; // stale — newer probe in flight

  if (r.ok && r.title) {
    currentMediaTitle = r.title;
    wrap.classList.remove('preview-probing', 'preview-invalid');
    wrap.classList.add('preview-valid');
    titleEl.textContent = r.title;
    const bits = [];
    if (r.uploader) bits.push(r.uploader);
    if (r.duration) bits.push(r.duration);
    // Format hint: resolution + audio bitrate. Helps the user pick the
    // right format button (1080p vs 720p vs MP3) before clicking download.
    const fmtBits = [];
    if (r.resolution) fmtBits.push(`📹 ${r.resolution}`);
    else if (r.height) fmtBits.push(`📹 ${r.height}p`);
    if (r.abr) fmtBits.push(`🔊 ${Math.round(r.abr)}kbps`);
    if (fmtBits.length) bits.push(fmtBits.join(' · '));
    bits.push(url);
    metaEl.textContent = bits.join(' · ');
    // Disable format buttons that this source can't satisfy: e.g. if the
    // best stream is 720p we grey out the "MP4 1080p" button.
    setMediaButtonsEnabled(true);
    applyAvailableFormatHints(r.height);
    maybeShowLegalBanner(); // banner appears the first time the user lands on a valid URL
  } else {
    currentMediaTitle = null;
    wrap.classList.remove('preview-probing', 'preview-valid');
    wrap.classList.add('preview-invalid');
    // DRM-blocked hosts get a dedicated message + toast so the user knows
    // this is a deliberate policy, not a "FLUX bug" they should report.
    if (r.drm) {
      titleEl.textContent = t('media_drm_blocked_title') || '⛔ DRM-protected platform — not supported';
      metaEl.textContent  = t('media_drm_blocked_body') || 'Netflix, Prime Video, Disney+, HBO Max and similar use DRM that FLUX cannot (and will not) bypass. Use the official app for these contents.';
      showToast({ title: t('media_drm_blocked_title') || 'DRM-protected', body: t('media_drm_blocked_body') || 'FLUX does not support DRM-protected streaming platforms.', kind: 'warn', ttl: 7000 });
    } else {
      titleEl.textContent = '✗ URL not supported or unreachable';
      metaEl.textContent  = r.error ? `${r.error} — ${url}` : url;
    }
    setMediaButtonsEnabled(false);
  }
}

function hideMediaTitlePreview() {
  currentMediaTitle = null;
  probeToken++;
  document.getElementById('media-title-preview').classList.add('hidden');
  setMediaButtonsEnabled(false); // empty URL → buttons disabled by default
  applyAvailableFormatHints(null);  // re-enable all format radios
}

function handleMediaProgress(line, error) {
  // yt-dlp con format `bestvideo+bestaudio` scarica DUE stream separati
  // (video.fXXX + audio.fYYY), ognuno con la sua linea `[download] N%`
  // che va 0→100. Senza aggregazione la barra "ritorna a zero" tra i due.
  // Strategia: parsare `Downloading N format(s)` per sapere quanti stream
  // sono attesi, contare le linee `Destination:` per sapere quale è in
  // corso, e mappare la % grezza su `((idx-1) + pct/100) / total * 100`.
  if (line) {
    const running = recentDownloads.find(d => d.status === 'running');
    if (running) {
      const mFmt = line.match(/Downloading\s+(\d+)\s+format\(s\)/i);
      if (mFmt) {
        running.totalStreams = parseInt(mFmt[1], 10) || 1;
        running.streamIdx = 0;
      }
      // Una linea "Destination:" segnala l'inizio di un nuovo stream.
      // Anche "has already been downloaded" (--continue su file completo)
      // conta come stream consumato, altrimenti l'idx resta indietro.
      if (/^\[download\]\s+Destination:/.test(line) ||
          /^\[download\].+has already been downloaded/.test(line)) {
        running.streamIdx = (running.streamIdx || 0) + 1;
      }
      const matches = [...line.matchAll(/\[download\]\s+([0-9.]+)%/g)];
      if (matches.length) {
        const rawPct = parseFloat(matches[matches.length - 1][1]);
        const total = running.totalStreams || 1;
        const idx   = Math.max(1, running.streamIdx || 1);
        const aggregate = total > 1
          ? Math.min(100, ((idx - 1) + rawPct / 100) / total * 100)
          : rawPct;
        running.progress = aggregate;
        updateDlEntryProgress(running.id, aggregate);
        // Refresh the topbar aggregate strip so the average reflects the
        // freshest per-entry value. Cheap (no full re-render of the list).
        renderDownloadsBadge();
      }
    }
  }
  appendLog('media-log', line, error ? 'error' : 'log');
}

function setMediaProgress(pct, visible) {
  const wrap = document.getElementById('media-progress-wrap');
  const bar  = document.getElementById('media-progress-bar');
  const txt  = document.getElementById('media-progress-text');
  if (!wrap) return;
  if (visible) wrap.classList.remove('hidden'); else wrap.classList.add('hidden');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (txt) txt.textContent = `${pct.toFixed(1)}%`;
}

// ─── LIVE & STREAMING ────────────────────────────────────────────────────────
let hlsInstance = null; // global so we can destroy on tab switch / app close

function stopLivePreview() {
  if (hlsInstance) { try { hlsInstance.destroy(); } catch {} hlsInstance = null; }
  const video = document.getElementById('live-player');
  if (video) { try { video.pause(); } catch {} video.removeAttribute('src'); video.load(); }
  document.getElementById('live-player-wrap')?.classList.add('hidden');
  document.getElementById('live-preview-stop-btn')?.classList.add('hidden');
  document.getElementById('live-preview-btn')?.classList.remove('hidden');
}

function bindLive() {
  const urlInput = document.getElementById('live-url');
  const recordBtn = document.getElementById('live-record-btn');
  const stopBtn   = document.getElementById('live-stop-btn');
  const previewBtn     = document.getElementById('live-preview-btn');
  const previewStopBtn = document.getElementById('live-preview-stop-btn');
  const fromStartRow = document.getElementById('live-from-start-row');
  let probeTimer = null;
  let liveIsLive = false;

  function setLiveRecordEnabled(enabled) {
    recordBtn.disabled = !enabled;
    previewBtn.disabled = !enabled;
  }
  setLiveRecordEnabled(false);

  async function probeLiveUrl(url) {
    const wrap    = document.getElementById('live-title-preview');
    const titleEl = document.getElementById('live-title-text');
    const metaEl  = document.getElementById('live-title-meta');
    wrap.classList.remove('hidden', 'preview-valid', 'preview-invalid');
    wrap.classList.add('preview-probing');
    titleEl.textContent = 'Checking stream…';
    metaEl.textContent  = url;
    setLiveRecordEnabled(false);
    fromStartRow.style.display = 'none';

    const r = await window.api.media.probe(url);
    if (r.ok && r.title) {
      wrap.classList.remove('preview-probing', 'preview-invalid');
      wrap.classList.add('preview-valid');
      liveIsLive = !!r.is_live;
      let badge = '';
      if (r.is_live)        badge = `<span class="live-badge live-badge-live">${t('live_badge_live')}</span>`;
      else if (r.was_live)  badge = `<span class="live-badge live-badge-past">${t('live_badge_past')}</span>`;
      else                  badge = `<span class="live-badge live-badge-vod">${t('live_badge_vod')}</span>`;
      titleEl.innerHTML = `${badge} ${esc(r.title)}`;
      const bits = [];
      if (r.uploader) bits.push(r.uploader);
      if (r.duration && !r.is_live) bits.push(r.duration);
      bits.push(url);
      metaEl.textContent = bits.join(' · ');
      setLiveRecordEnabled(true);
      // Show "capture from start" only when stream is currently live AND yt-dlp can rewind
      fromStartRow.style.display = r.is_live ? '' : 'none';
      maybeShowLegalBanner();
    } else {
      wrap.classList.remove('preview-probing', 'preview-valid');
      wrap.classList.add('preview-invalid');
      if (r.drm) {
        titleEl.textContent = t('media_drm_blocked_title') || '⛔ DRM-protected platform — not supported';
        metaEl.textContent  = t('media_drm_blocked_body') || 'FLUX does not support DRM-protected streaming platforms.';
        showToast({ title: t('media_drm_blocked_title') || 'DRM-protected', body: t('media_drm_blocked_body') || 'Use the official app for these contents.', kind: 'warn', ttl: 7000 });
      } else {
        titleEl.textContent = '✗ URL not supported or unreachable';
        metaEl.textContent  = r.error ? `${r.error} — ${url}` : url;
      }
      setLiveRecordEnabled(false);
    }
  }

  urlInput.addEventListener('input', () => {
    clearTimeout(probeTimer);
    const url = urlInput.value.trim();
    stopLivePreview(); // any URL edit kills the running preview
    if (!/^https?:\/\//i.test(url)) {
      document.getElementById('live-title-preview').classList.add('hidden');
      setLiveRecordEnabled(false);
      fromStartRow.style.display = 'none';
      return;
    }
    probeTimer = setTimeout(() => probeLiveUrl(url), 600);
  });
  urlInput.addEventListener('paste', () => {
    clearTimeout(probeTimer);
    setTimeout(() => {
      const url = urlInput.value.trim();
      if (/^https?:\/\//i.test(url)) probeLiveUrl(url);
    }, 50);
  });

  previewBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    // Preview opens in the SHARED video popup (same as the Media tab), not an
    // inline player under the buttons.
    previewBtn.classList.add('btn-loading');
    previewBtn.disabled = true;
    appendLog('live-log', '🔍 Resolving stream URL…', 'info');
    try {
      const r = await window.api.media.getStreamUrl(url);
      if (!r.ok || !r.url) {
        appendLog('live-log', `✗ Preview: ${r.error || 'no stream URL'}`, 'error');
        return;
      }
      openVideoPreview({ streamUrl: r.url, originalUrl: url, title: url });
    } finally {
      previewBtn.classList.remove('btn-loading');
      previewBtn.disabled = false;
    }
  });

  previewStopBtn.addEventListener('click', () => stopLivePreview());

  recordBtn.addEventListener('click', async () => {
    const url    = urlInput.value.trim();
    const format = document.querySelector('input[name="live-format"]:checked').value;
    const fromStart = document.getElementById('live-from-start').checked;
    if (!url) return;
    if (!(await ensureBinaries(['yt-dlp', 'ffmpeg', 'ffprobe'], t('nav_live') || 'Live'))) return;
    stopLivePreview(); // recording starts → kill preview to free bandwidth
    clearLog('live-log');
    recordBtn.disabled = true;
    stopBtn.classList.remove('hidden');
    appendLog('live-log', `⏺ Recording: ${url} [${format}${fromStart ? ' from-start' : ''}]`, 'info');
    const trackerEntry = addDownloadEntry({
      title:  url,
      source: 'live · ' + (FORMAT_LABEL[format] || format),
      status: 'running'
    });
    const r = await window.api.live.record({ url, format, fromStart, downloadFolder: config.download_folder });
    recordBtn.disabled = false;
    stopBtn.classList.add('hidden');
    if (r.stopped) {
      appendLog('live-log', `⏹ Recording stopped. ${r.path ? `Saved: ${r.path}` : ''}`, 'ok');
      updateDownloadEntry(trackerEntry.id, { status: 'done', path: r.path });
    } else if (r.ok) {
      appendLog('live-log', `✓ Stream ended. ${r.path ? `Saved: ${r.path}` : ''}`, 'ok');
      updateDownloadEntry(trackerEntry.id, { status: 'done', path: r.path });
      if (config.notify_on_done) window.api.notify.show({ title: 'FLUX', body: 'Live recording finished' });
    } else {
      appendLog('live-log', `✗ ${r.error || 'unknown error'}`, 'error');
      updateDownloadEntry(trackerEntry.id, { status: 'error', error: r.error || 'unknown error' });
    }
    if (r.path && config.history_enabled !== false) {
      window.api.history.append({ kind: 'live', name: r.path, ok: !!r.ok || !!r.stopped, path: r.path, source: 'yt-dlp' });
      if (r.ok || r.stopped) notifyMediaServer({ kind: 'live', path: r.path, logId: 'live-log' });
    }
  });

  stopBtn.addEventListener('click', async () => {
    await window.api.media.stop({ downloadFolder: config.download_folder });
    appendLog('live-log', '⏹ Stopping…', 'info');
  });
}

// ─── GLOBAL PLAYER (persistent across tabs — used by Radio + Tag Editor) ─────
let globalHls = null;
let globalCurrent = null; // { source, id, title }
let currentIcyTitle = null;   // last ICY StreamTitle (Artist - Title) for the playing radio

// Some radio stations (R101 / Mediaset / RDS) cram a structured metadata blob
// into the ICY StreamTitle field with `~` separators, instead of plain
// "Artist - Title". Example payload:
//   Happier~Marshmello ft. Bastille~~2018~USUG11801651~210~2026-05-22T12:22:03~
//   2026-05-22T12:25:25~R101 Enjoy The Music~202.21~<uuid>
// Fields (positional): title, artist, _, year, isrc, duration, start, end,
// station, streamOffset, uuid. We keep only title + artist and rebuild a
// clean "Artist - Title". Passes plain "Artist - Title" through unchanged.
function normalizeIcyTitle(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  if (raw.indexOf('~') < 0) return raw.trim();
  const parts = raw.split('~').map(s => s.trim());
  const title  = parts[0] || '';
  const artist = parts[1] || '';
  if (title && artist) return `${artist} - ${title}`;
  if (title) return title;
  return raw.trim();
}

function showPlaybackError(url, detail) {
  showToast({ title: t('player_playback_failed') || 'Playback failed', body: `${detail}\n\n${url}`, kind: 'err', ttl: 8000 });
  appendLog('radio-log', `✗ Playback failed for ${url}: ${detail}`, 'error');
}

// Quick heuristic: looks like a direct media file. Used to skip the yt-dlp
// resolver round-trip for URLs that the browser can play natively.
function isDirectMediaUrl(url) {
  return /\.(mp3|aac|m4a|ogg|opus|wav|flac|mpga|mpeg|m3u8|mpd|ts|webm|mp4|mov)(\?|#|$)/i.test(url);
}

// Resolve a page URL (YouTube watch, podcast portal, etc.) to a direct
// streamable URL via yt-dlp -g. Returns the resolved URL, or null on error.
async function resolveStreamableUrl(url, kind = 'audio') {
  try {
    const r = await window.api.media.resolveStreamUrl({ url, kind });
    if (r?.ok && r.url) return r.url;
    appendLog('radio-log', `✗ Cannot resolve stream from ${url}: ${r?.error || 'unknown'}`, 'error');
    return null;
  } catch (e) {
    appendLog('radio-log', `✗ Cannot resolve stream from ${url}: ${e?.message || e}`, 'error');
    return null;
  }
}

function playInGlobalPlayer({ url, title, source, id, isHls }) {
  stopGlobalPlayer({ silent: true });
  const audio = document.getElementById('global-audio');
  const bar   = document.getElementById('global-player-bar');
  const isM3u8 = isHls ?? (/\.m3u8(\?|$)/i.test(url) || /\/m3u/i.test(url));

  // Native <audio> covers MP3/AAC/Ogg/Opus/WAV directly. Falls through to
  // hls.js for HLS playlists (m3u8). When the URL is a podcast/article page
  // we can't play it directly — surface a friendlier toast instead of the
  // browser's "no supported source" error.
  const tryHls = () => {
    if (!window.Hls || !window.Hls.isSupported()) return false;
    globalHls = new window.Hls();
    globalHls.loadSource(url);
    globalHls.attachMedia(audio);
    globalHls.on(window.Hls.Events.MANIFEST_PARSED, () => audio.play().catch(() => {}));
    globalHls.on(window.Hls.Events.ERROR, (_, data) => {
      if (!data?.fatal) return;
      try { globalHls.destroy(); } catch {} globalHls = null;
      showPlaybackError(url, `HLS: ${data.details || 'fatal'}`);
      stopGlobalPlayer();
    });
    return true;
  };
  if (isM3u8) {
    if (!tryHls()) showPlaybackError(url, 'HLS not supported in this build');
  } else if (isDirectMediaUrl(url)) {
    // Direct file extension we trust — play natively.
    audio.src = url;
    audio.play().catch(err => {
      if (tryHls()) return;
      showPlaybackError(url, err?.message || 'unknown');
      stopGlobalPlayer();
    });
  } else if (source === 'radio') {
    // Radio streams (RadioBrowser) are direct icecast/shoutcast URLs — they
    // have no file extension but play fine in <audio>. Play natively so radio
    // works with NO binaries installed (yt-dlp is NOT a radio dependency).
    // HLS fallback for m3u-playlist stations. Only if both fail AND yt-dlp is
    // actually present do we try to resolve (rare station that's a page URL) —
    // this avoids the misleading "yt-dlp not available" toast on every play.
    audio.src = url;
    audio.play().catch(async err => {
      if (tryHls()) return;
      if (!(await missingOf(['yt-dlp'])).length) {
        const resolved = await resolveStreamableUrl(url, 'audio');
        if (resolved) {
          audio.src = resolved;
          audio.play().catch(e2 => { showPlaybackError(url, e2?.message || 'unknown'); stopGlobalPlayer(); });
          return;
        }
      }
      showPlaybackError(url, err?.message || 'unknown');
      stopGlobalPlayer();
    });
  } else {
    // No direct-media signal in the URL → ask yt-dlp to resolve a playable
    // stream URL (handles YouTube watch pages, podcast portals, etc.). If
    // resolving fails we fall back to native + HLS to give a final chance.
    appendLog('radio-log', `… Resolving stream URL via yt-dlp: ${url}`, 'info');
    resolveStreamableUrl(url, source === 'video' || (source || '').includes('video') ? 'video' : 'audio').then(resolved => {
      const playUrl = resolved || url;
      if (resolved) {
        appendLog('radio-log', `✓ Resolved stream URL`, 'ok');
        // Keep the original URL in globalCurrent so the download button still
        // hands the right thing to yt-dlp instead of the ephemeral resolved CDN URL.
      }
      audio.src = playUrl;
      audio.play().catch(err => {
        if (tryHls()) return;
        showPlaybackError(url, err?.message || 'unknown');
        stopGlobalPlayer();
      });
    });
  }
  globalCurrent = { source, id, title, url };
  document.getElementById('global-player-title').textContent  = title || '—';
  document.getElementById('global-player-source').textContent = source || '';
  updatePlayerBadgeTooltip();
  const pauseBtn = document.getElementById('global-player-pause-btn');
  const stopBtn  = document.getElementById('global-player-stop-btn');
  pauseBtn.setAttribute('data-lucide-icon', 'pause');
  pauseBtn.removeAttribute('data-lucide-rendered');
  pauseBtn.disabled = false;
  stopBtn.disabled  = false;
  applyLucideIcons(bar);
  refreshPlaylistRowIcons();
  // Reset ICY state from any previous stream.
  currentIcyTitle = null;
  document.getElementById('global-player-icy').classList.add('hidden');
  // Download button is HIDDEN by default. It surfaces only when a track is
  // actually identified — either via ICY metadata from a radio stream
  // (onIcyMeta handler) or via the song-identify button result.
  document.getElementById('global-player-download-icy').classList.add('hidden');
  // Identify button is always visible — context-aware. Radio mode uses the
  // stream URL fingerprint, otherwise it falls back to a 10s microphone
  // capture. AcoustID lookup uses the user's key if set, else the embedded
  // default. (No more conditional `hidden` toggling.)
  bar.classList.add('is-playing');
  // Refresh radio table so the playing row shows ⏹
  if (globalCurrent?.source === 'radio' && radioLastResults.length) renderRadioResults(radioLastResults);
}

function stopGlobalPlayer(opts = {}) {
  const audio = document.getElementById('global-audio');
  if (globalHls) { try { globalHls.destroy(); } catch {} globalHls = null; }
  try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch {}
  globalCurrent = null;
  // Reset radio state only on a real, user-initiated stop. Silent stops are
  // emitted by playInGlobalPlayer when switching streams; the caller will set
  // the new radioCurrentUuid right after and we don't want to wipe it here.
  if (!opts.silent) {
    if (radioCurrentUuid) { try { window.api.radio.stopIcyWatch(radioCurrentUuid); } catch {} }
    radioCurrentUuid = null;
    radioCurrentStation = null;
    const bar = document.getElementById('global-player-bar');
    bar.classList.remove('is-playing');
    document.getElementById('global-player-title').textContent = t('player_nothing');
    document.getElementById('global-player-source').textContent = '';
    document.getElementById('global-player-pause-btn').disabled = true;
    updatePlayerBadgeTooltip();
    refreshPlaylistRowIcons();
    document.getElementById('global-player-stop-btn').disabled = true;
    // Identify button stays visible (mic mode works without any audio source).
    document.getElementById('global-player-download-icy').classList.add('hidden');
    if (radioLastResults.length) renderRadioResults(radioLastResults);
    // User-initiated stop also abandons any active playlist queue, so the
    // prev/next buttons disappear next time updatePlaylistNavButtons runs.
    playlistQueue = [];
    playlistQueueIdx = -1;
    updatePlaylistNavButtons();
  }
}

// ─── DOWNLOADS TRACKER (session-scoped, surfaced via topbar 📥 button) ───────
const recentDownloads = [];

function addDownloadEntry({ title, source, status = 'pending', path = null }) {
  const entry = {
    id: 'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    title, source, status, path,
    ts: Date.now()
  };
  recentDownloads.unshift(entry);
  renderDownloadsBadge();
  renderDownloadsList();
  return entry;
}

function updateDownloadEntry(id, patch) {
  const e = recentDownloads.find(x => x.id === id);
  if (!e) return;
  Object.assign(e, patch);
  renderDownloadsBadge();
  renderDownloadsList();
}

function renderDownloadsBadge() {
  const btn   = document.getElementById('topbar-download-btn');
  const badge = document.getElementById('topbar-download-badge');
  if (!btn || !badge) return;
  btn.classList.remove('hidden');
  // Running set drives the colour: amber while in-flight, green once
  // everything has finished. has-downloads still highlights the icon while
  // anything is in motion.
  const running = recentDownloads.filter(d => d.status === 'running');
  const anyRunning = running.length > 0;
  btn.classList.toggle('has-downloads', anyRunning);
  badge.textContent = String(recentDownloads.length);
  badge.classList.toggle('hidden', recentDownloads.length === 0);
  badge.classList.toggle('all-done', recentDownloads.length > 0 && !anyRunning);
  // Aggregate progress strip — driven by the ::after pseudo-element on
  // the button itself. We just set the CSS variable to the average %.
  // When no downloads are running we set it to 0 (collapses the bar) and
  // mark the button as "all-downloads-done" so the colour switches to
  // green if there are completed entries left in the list.
  if (anyRunning) {
    const total = running.reduce((s, d) => s + (Number.isFinite(d.progress) ? d.progress : 0), 0);
    const avg = total / running.length;
    btn.style.setProperty('--dl-progress', `${Math.max(0, Math.min(100, avg))}%`);
    btn.classList.remove('all-downloads-done');
  } else {
    btn.style.setProperty('--dl-progress', '0%');
    btn.classList.toggle('all-downloads-done', recentDownloads.length > 0);
  }
}

function renderDownloadsList() {
  const list = document.getElementById('downloads-list');
  if (!list) return;
  if (recentDownloads.length === 0) {
    list.innerHTML = `<p class="muted">${t('downloads_empty')}</p>`;
    return;
  }
  list.innerHTML = '';
  for (const d of recentDownloads) {
    const item = document.createElement('div');
    item.className = 'dl-item';
    item.dataset.dlId = d.id;
    const ts = new Date(d.ts).toLocaleTimeString();
    const statusLabel = t('downloads_status_' + d.status) || d.status;
    // Once done, the path is redundant with the title (and visually noisy).
    // Keep it for running/error states where the user might want to see
    // where partials live.
    const showPath = d.path && d.status !== 'done';
    const progressVisible = d.status === 'running';
    const pct = Number.isFinite(d.progress) ? d.progress : 0;
    item.innerHTML = `
      <div class="dl-item-info">
        <div class="dl-item-title" title="${escapeHtml(d.title)}">${escapeHtml(d.title)}</div>
        <div class="dl-item-meta">
          <span class="dl-item-status ${d.status}">${escapeHtml(statusLabel)}</span>
          · ${escapeHtml(d.source)} · ${ts}${showPath ? ' · ' + escapeHtml(shortenPath(d.path)) : ''}
        </div>
        <div class="dl-item-progress${progressVisible ? '' : ' hidden'}">
          <div class="dl-item-progress-bar"><div class="dl-item-progress-fill" style="width:${pct}%"></div></div>
          <span class="dl-item-progress-text">${pct.toFixed(1)}%</span>
        </div>
      </div>
      <div class="dl-item-actions">
        ${d.path && d.status === 'done' ? `<button class="btn-icon" data-action="play" data-id="${d.id}" data-lucide-icon="play" title="${t('downloads_play')}"></button>` : ''}
        ${d.path && d.status === 'done' ? `<button class="btn-icon" data-action="folder" data-id="${d.id}" data-lucide-icon="folder-open" title="${t('downloads_open_folder')}"></button>` : ''}
        <button class="btn-icon" data-action="remove" data-id="${d.id}" data-lucide-icon="x" title="${t('downloads_remove')}"></button>
      </div>
    `;
    list.appendChild(item);
  }
  list.querySelectorAll('[data-action]').forEach(b => {
    b.addEventListener('click', () => onDownloadAction(b.dataset.action, b.dataset.id));
  });
  applyLucideIcons(list);
}

// In-place progress update — avoids re-rendering the whole list at 10Hz.
// Called from handleMediaProgress with the percentage parsed off yt-dlp's
// "[download] X%" line, applied to whichever entry is currently 'running'.
function updateDlEntryProgress(id, pct) {
  const item = document.querySelector(`.dl-item[data-dl-id="${id}"]`);
  if (!item) return;
  const wrap = item.querySelector('.dl-item-progress');
  const fill = item.querySelector('.dl-item-progress-fill');
  const text = item.querySelector('.dl-item-progress-text');
  if (wrap) wrap.classList.remove('hidden');
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (text) text.textContent = `${pct.toFixed(1)}%`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function shortenPath(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  return parts.slice(-2).join('/');
}

async function onDownloadAction(action, id) {
  const e = recentDownloads.find(x => x.id === id);
  if (!e) {
    console.warn('onDownloadAction: no entry for id', id);
    return;
  }
  if (action === 'remove') {
    const i = recentDownloads.indexOf(e);
    if (i >= 0) recentDownloads.splice(i, 1);
    renderDownloadsBadge();
    renderDownloadsList();
    return;
  }
  if (action === 'folder') {
    if (!e.path) {
      showToast({ title: t('downloads_no_path_title') || 'File not available', body: t('downloads_no_path_body') || 'No file path saved for this entry.', kind: 'err', ttl: 5000 });
      return;
    }
    try {
      // revealInFolder swallows errors silently when the path doesn't exist —
      // check first so we can show a toast instead of going dark.
      const exists = await window.api.fs.exists(e.path);
      if (!exists) {
        showToast({ title: t('downloads_file_missing_title') || 'File not found', body: e.path, kind: 'err', ttl: 6000 });
        return;
      }
      await window.api.shell.revealInFolder(e.path);
    } catch (err) {
      showToast({ title: 'Open folder failed', body: err?.message || String(err), kind: 'err', ttl: 5000 });
    }
    return;
  }
  if (action === 'play') {
    if (!e.path) {
      showToast({ title: t('downloads_no_path_title') || 'File not available', body: t('downloads_no_path_body') || 'No file path saved for this entry.', kind: 'err', ttl: 5000 });
      return;
    }
    // Image files (especially .gif) often get associated with the system
    // media player on Windows, which is the wrong UX. Route them through
    // an in-app preview modal that uses <img> — animated GIFs loop, static
    // images display correctly. The modal exposes an "Open with system
    // default" escape hatch for users who want the OS behaviour.
    const ext = e.path.split('.').pop().toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      openImagePreviewModal(e.path);
      return;
    }
    try {
      // shell.openPath returns an empty string on success; non-empty = error
      // msg (most commonly "ENOENT" when the file got moved by Library
      // Manager or removed externally). Surface as a toast so the user
      // sees WHY the click looks like nothing happened.
      const r = await window.api.shell.openPath(e.path);
      if (r) {
        showToast({ title: t('downloads_play_failed_title') || 'Cannot play file', body: `${e.path}\n${r}`, kind: 'err', ttl: 6000 });
      } else {
        document.getElementById('downloads-modal').classList.add('hidden');
      }
    } catch (err) {
      showToast({ title: 'Play failed', body: err?.message || String(err), kind: 'err', ttl: 5000 });
    }
    return;
  }
  console.warn('onDownloadAction: unknown action', action);
}

// ─── IMAGE PREVIEW MODAL (replaces shell.openPath for image files) ──────────
// On most Windows installs .gif is associated with a media player or the
// browser, neither of which is the right viewer. This modal renders the
// image inline (animated GIFs loop natively in <img>) and offers explicit
// "Open folder" + "Open with system default" escape hatches.
let imagePreviewCurrentPath = null;

function openImagePreviewModal(filePath) {
  imagePreviewCurrentPath = filePath;
  const modal = document.getElementById('image-preview-modal');
  const img   = document.getElementById('image-preview-element');
  const title = document.getElementById('image-preview-title');
  const meta  = document.getElementById('image-preview-meta');
  if (!modal || !img) return;
  img.onload = () => {
    if (meta) meta.textContent = `${img.naturalWidth}×${img.naturalHeight} · ${filePath}`;
  };
  img.onerror = () => {
    if (meta) meta.textContent = t('downloads_play_failed_title') + ' — ' + filePath;
  };
  img.src = localFileURL(filePath);
  if (title) title.textContent = filePath.split(/[\\/]/).pop();
  modal.classList.remove('hidden');
}

function bindImagePreviewModal() {
  document.getElementById('image-preview-close')?.addEventListener('click', () => {
    document.getElementById('image-preview-modal').classList.add('hidden');
    // Drop the src so the GIF stops decoding in the background when the
    // modal is hidden (image decoding can be surprisingly CPU-hungry).
    const img = document.getElementById('image-preview-element');
    if (img) img.removeAttribute('src');
  });
  document.getElementById('image-preview-folder')?.addEventListener('click', () => {
    if (imagePreviewCurrentPath) window.api.shell.revealInFolder(imagePreviewCurrentPath);
  });
  document.getElementById('image-preview-open-default')?.addEventListener('click', async () => {
    if (!imagePreviewCurrentPath) return;
    // Escape hatch — the user explicitly chose to use the OS default.
    // If WMP fires, that's now their conscious choice, not a surprise.
    await window.api.shell.openPath(imagePreviewCurrentPath);
  });
}

function bindDownloadsModal() {
  const open  = document.getElementById('topbar-download-btn');
  const close = document.getElementById('downloads-close-btn');
  const clear = document.getElementById('downloads-clear-btn');
  const modal = document.getElementById('downloads-modal');
  if (!open || !close || !modal) return;
  open.addEventListener('click', () => {
    renderDownloadsList();
    modal.classList.remove('hidden');
  });
  close.addEventListener('click', () => modal.classList.add('hidden'));
  clear.addEventListener('click', () => {
    recentDownloads.length = 0;
    renderDownloadsBadge();
    renderDownloadsList();
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });
}

function bindGlobalPlayer() {
  document.getElementById('global-player-stop-btn').addEventListener('click', () => stopGlobalPlayer());
  document.getElementById('global-player-prev-btn').addEventListener('click', () => {
    if (playlistQueueIdx > 0) playPlaylistQueueAt(playlistQueueIdx - 1);
  });
  document.getElementById('global-player-next-btn').addEventListener('click', () => {
    if (playlistQueueIdx < playlistQueue.length - 1) playPlaylistQueueAt(playlistQueueIdx + 1);
  });
  document.getElementById('global-player-pause-btn').addEventListener('click', () => {
    const audio = document.getElementById('global-audio');
    const btn   = document.getElementById('global-player-pause-btn');
    const wantPlay = audio.paused;
    if (wantPlay) audio.play().catch(() => {});
    else          audio.pause();
    btn.setAttribute('data-lucide-icon', wantPlay ? 'pause' : 'play');
    btn.removeAttribute('data-lucide-rendered');
    applyLucideIcons(btn.parentElement);
    refreshPlaylistRowIcons();
  });

  // Topbar timer — updates current time + total duration as audio plays. The
  // <audio> element is shared by every source (radio HLS, podcast direct,
  // playlist queue, etc.), so a single listener covers all of them.
  const audio = document.getElementById('global-audio');
  const fmt = sec => {
    if (!isFinite(sec) || sec < 0) return '--:--';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  };
  audio.addEventListener('timeupdate', () => {
    document.getElementById('global-player-time-cur').textContent = fmt(audio.currentTime);
  });
  audio.addEventListener('loadedmetadata', () => {
    document.getElementById('global-player-time-tot').textContent = fmt(audio.duration);
  });
  audio.addEventListener('emptied', () => {
    document.getElementById('global-player-time-cur').textContent = '00:00';
    document.getElementById('global-player-time-tot').textContent = '--:--';
  });

  // ICY metadata events from main → just surface the download button (no song
  // title rendered in the player widget; the title is held in currentIcyTitle
  // and used by the ⬇ click handler / identify result).
  window.api.radio.onIcyMeta(({ uuid, streamTitle }) => {
    if (!globalCurrent || globalCurrent.source !== 'radio' || globalCurrent.id !== uuid) return;
    currentIcyTitle = normalizeIcyTitle(streamTitle);
    document.getElementById('global-player-icy-title').textContent = currentIcyTitle;
    updatePlayerBadgeTooltip();
    const dl = document.getElementById('global-player-download-icy');
    dl.classList.remove('hidden');
    // Reflect the actual track title in the tooltip so the user sees what
    // they're about to download before clicking.
    dl.title = `${t('downloads_download_label') || 'Download'}: ${streamTitle}`;
  });

  // Download the current player content. Dispatch by source:
  //   - radio: use ICY title -> YouTube search -> yt-dlp audio
  //   - Media/Queue preview: download the original URL (stored in globalCurrent.id)
  //     directly via the media queue (so user gets format choice from Media tab)
  document.getElementById('global-player-download-icy').addEventListener('click', async () => {
    if (!globalCurrent) return;
    const isRadio = globalCurrent.source === 'radio';
    if (isRadio) {
      if (!currentIcyTitle) return;
      // Recording a radio track = YouTube search + yt-dlp audio → needs binaries.
      if (!(await ensureBinaries(['yt-dlp', 'ffmpeg', 'ffprobe'], t('nav_radio') || 'Radio'))) return;
      const title = currentIcyTitle;
      appendLog('radio-log', `⬇ Searching YouTube for: ${title}`, 'info');
      const entry = addDownloadEntry({ title, source: 'radio', status: 'running' });
      try {
        const r = await window.api.youtube.searchAndDownload({
          query: title, format: 'audio', downloadFolder: config.download_folder
        });
        appendLog('radio-log', r.ok ? `✓ Downloaded: ${r.path || title}` : `✗ ${r.error}`, r.ok ? 'ok' : 'error');
        updateDownloadEntry(entry.id, r.ok ? { status: 'done', path: r.path } : { status: 'error', error: r.error });
        if (r.ok && config.notify_on_done) window.api.notify.show({ title: 'FLUX', body: `✓ ${title}` });
        // Fire-and-forget MusicBrainz auto-tag pass — we have a clean
        // "Artist - Title" from the normalized ICY metadata. Doesn't block the
        // UI; failures are logged but don't surface as a user error.
        if (r.ok && r.path) autoTagAfterDownload(r.path, title, 'radio-log', null, entry.id);
      } catch (e) {
        updateDownloadEntry(entry.id, { status: 'error', error: String(e?.message || e) });
      }
      return;
    }
    // Media/Queue preview: original URL is stored in globalCurrent.id
    const originalUrl = globalCurrent.id;
    const title = globalCurrent.title || originalUrl;
    if (!originalUrl) return;
    appendLog('media-log', `⬇ Sending to download queue: ${title}`, 'info');
    // Pre-fill the Media tab URL and click Download (reuses format selection + queue).
    const urlInput = document.getElementById('media-url');
    if (urlInput) urlInput.value = originalUrl;
    // Switch to Media tab so user sees what's happening, then trigger probe+download.
    switchTab('media');
    if (document.getElementById('media-download-btn') && urlInput) {
      // Probe re-fires on URL change; user clicks Download (or auto-trigger).
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  // AcoustID identify — capture stream + fpcalc + AcoustID lookup
  document.getElementById('global-player-identify-btn').addEventListener('click', onIdentifyClick);
}

// Top-right toast notifications — non-modal feedback. Variants: 'ok', 'warn',
// 'err'. Auto-dismisses after `ttl` ms (default 5s). Optional `action` button
// receives the click and the close fn ({label, onClick}). Returns the element.
// In-app confirm dialog. Returns a Promise<boolean> so callers can:
//   if (!(await showConfirm({title, body}))) return;
// Pattern mirrors window.confirm but styled like every other FLUX modal.
function showConfirm({ title, body, okLabel, cancelLabel, danger = false } = {}) {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal');
    if (!modal) return resolve(window.confirm(`${title || ''}\n\n${body || ''}`.trim()));
    document.getElementById('confirm-modal-title').textContent = title || t('confirm_title') || 'Confirm';
    document.getElementById('confirm-modal-body').textContent  = body || '';
    const okBtn     = document.getElementById('confirm-modal-ok');
    const cancelBtn = document.getElementById('confirm-modal-cancel');
    okBtn.textContent     = okLabel     || t('confirm_ok')     || 'OK';
    cancelBtn.textContent = cancelLabel || t('rss_cancel')     || 'Cancel';
    okBtn.classList.toggle('btn-danger-sm', !!danger);
    okBtn.classList.toggle('btn-primary',   !danger);
    const close = (val) => {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      resolve(val);
    };
    const onOk     = () => close(true);
    const onCancel = () => close(false);
    const onBackdrop = (e) => { if (e.target === modal) close(false); };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    modal.classList.remove('hidden');
  });
}

function showToast({ title, body, kind = 'ok', ttl = 5000, action = null, actions = null } = {}) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return null;
  const div = document.createElement('div');
  div.className = `toast toast-${kind}`;
  // `action` (single text button) and `actions` (icon-only buttons row) are
  // both supported. Image-save success toasts use the icon row to surface
  // Open file / Open folder shortcuts compactly.
  const actionsHtml = (actions && actions.length)
    ? `<div class="toast-actions">${actions.map((a, i) =>
        `<button class="toast-action-icon" data-action-idx="${i}" data-lucide-icon="${escapeHtml(a.icon || 'chevron-right')}" title="${escapeHtml(a.title || '')}" aria-label="${escapeHtml(a.title || '')}"></button>`
      ).join('')}</div>`
    : '';
  div.innerHTML = `
    <button class="toast-close" aria-label="Close">${'✕'}</button>
    ${title ? `<div class="toast-title">${escapeHtml(title)}</div>` : ''}
    ${body  ? `<div class="toast-body">${escapeHtml(body)}</div>`   : ''}
    ${action ? `<button class="toast-action btn btn-primary btn-sm">${escapeHtml(action.label)}</button>` : ''}
    ${actionsHtml}
  `;
  stack.appendChild(div);
  if (actionsHtml) applyLucideIcons(div);
  requestAnimationFrame(() => div.classList.add('show'));
  const close = () => {
    div.classList.remove('show');
    setTimeout(() => div.remove(), 200);
  };
  div.querySelector('.toast-close').addEventListener('click', close);
  if (action) {
    div.querySelector('.toast-action').addEventListener('click', () => {
      try { action.onClick(close); } catch (e) { console.error(e); }
    });
  }
  if (actions && actions.length) {
    div.querySelectorAll('.toast-action-icon').forEach(btn => {
      const idx = parseInt(btn.dataset.actionIdx, 10);
      btn.addEventListener('click', () => {
        try { actions[idx]?.onClick?.(close); } catch (e) { console.error(e); }
      });
    });
  }
  if (ttl > 0) setTimeout(close, ttl);
  return div;
}

// Build the standard "Open file / Open folder" action pair for save-success
// toasts. Both routes through the existing IPC bridge — openPath launches
// the OS default app, revealInFolder highlights the file in Explorer/Finder.
function fileToastActions(filePath) {
  if (!filePath) return null;
  return [
    { icon: 'external-link', title: t('toast_open_file')   || 'Open file',
      onClick: (close) => { window.api.shell.openPath(filePath);       close(); } },
    { icon: 'folder-open',   title: t('toast_open_folder') || 'Open folder',
      onClick: (close) => { window.api.shell.revealInFolder(filePath); close(); } }
  ];
}

// Identify button is always visible — the recognition backend is chosen in
// Settings (Shazamio by default, no key; or AcoustID with a personal key).
function refreshIdentifyButton() {
  const btn = document.getElementById('global-player-identify-btn');
  if (!btn) return;
  btn.classList.remove('hidden');
}

// Show/hide the AcoustID key input + its help line based on backend choice.
function toggleAcoustIdKeyVisibility(backend) {
  const key  = document.getElementById('cfg-acoustid-key');
  const help = document.getElementById('cfg-acoustid-key-help');
  const show = (backend === 'acoustid');
  if (key)  key.style.display  = show ? '' : 'none';
  if (help) help.style.display = show ? '' : 'none';
}

// Context-aware identify: radio stream fingerprint when a radio is playing,
// microphone capture otherwise. Backend chosen from Settings:
//   shazamio (default): no key, uses Shazam's public API via node-shazam
//   acoustid: requires user's own AcoustID API key
async function onIdentifyClick() {
  const btn = document.getElementById('global-player-identify-btn');
  // The identify module is tab-less (triggered here), so its lazy binary
  // fetch (fpcalc + ffmpeg/ffprobe to decode the mic/stream) is gated on the
  // first click rather than on a tab switch.
  if (!(await ensureModuleBinaries('identify'))) return;
  const backend = (config?.recognition_backend || 'shazamio').toLowerCase();
  const logTarget = globalCurrent?.source === 'radio' ? 'radio-log' : 'media-log';

  btn.classList.add('btn-loading');
  // Show a "listening" toast that we'll replace with the result.
  const listeningToast = showToast({
    title: t('identify_toast_listening_title'),
    body:  t('identify_listening'),
    kind:  'ok',
    ttl:   0       // keep open until we close it
  });
  try {
    let r;
    if (backend === 'acoustid' && globalCurrent && globalCurrent.source === 'radio') {
      const apiKey = (config?.acoustid_key || '').trim() || DEFAULT_ACOUSTID_KEY;
      appendLog(logTarget, t('radio_identifying'), 'info');
      r = await window.api.acoustid.identify({ streamUrl: globalCurrent.url, apiKey });
    } else {
      appendLog(logTarget, t('identify_listening'), 'info');
      const buf = await recordMicrophoneSeconds(10);
      if (!buf) {
        appendLog(logTarget, t('identify_no_mic'), 'error');
        listeningToast?.querySelector('.toast-close')?.click();
        showToast({ title: t('identify_toast_no_mic_title'), body: t('identify_no_mic'), kind: 'err' });
        return;
      }
      if (backend === 'acoustid') {
        const apiKey = (config?.acoustid_key || '').trim() || DEFAULT_ACOUSTID_KEY;
        r = await window.api.acoustid.identifyFromBuffer({ buffer: buf, apiKey });
      } else {
        r = await window.api.shazam.identifyFromBuffer({ buffer: buf });
      }
    }
    listeningToast?.querySelector('.toast-close')?.click();
    if (!r.ok) {
      appendLog(logTarget, `${'X'} ${r.error}`, 'error');
      showToast({
        title: t('identify_toast_error_title'),
        body:  r.error || 'Unknown error',
        kind:  'err',
        ttl:   7000
      });
    } else if (!r.title) {
      appendLog(logTarget, t('radio_identify_no_match'), 'log');
      showToast({
        title: t('identify_toast_nomatch_title'),
        body:  t('radio_identify_no_match'),
        kind:  'warn'
      });
    } else {
      const matched = `${r.artist || ''} - ${r.title}`.trim();
      const scoreMsg = `(score ${Math.round((r.score||0)*100)}/100)`;
      appendLog(logTarget, `${'v'} ${matched} ${scoreMsg}`, 'ok');
      showToast({
        title: t('identify_toast_match_title'),
        body:  matched + '  ' + scoreMsg,
        kind:  'ok',
        ttl:   12000, // longer so user has time to click Download
        action: {
          label: t('identify_toast_download'),
          onClick: (close) => {
            downloadIdentifiedTrack(matched);
            close();
          }
        }
      });
      currentIcyTitle = matched;
      document.getElementById('global-player-icy-title').textContent = currentIcyTitle;
      const dl = document.getElementById('global-player-download-icy');
      dl.classList.remove('hidden');
      dl.title = `${t('downloads_download_label') || 'Download'}: ${currentIcyTitle}`;
    }
  } catch (e) {
    listeningToast?.querySelector('.toast-close')?.click();
    showToast({ title: t('identify_toast_error_title'), body: String(e?.message || e), kind: 'err', ttl: 7000 });
  } finally {
    btn.classList.remove('btn-loading');
  }
}

// Fire-and-forget MusicBrainz auto-tag after a successful audio download.
// `hint` is a "Artist - Title" string; `explicit` overrides parsing with an
// explicit { artist, title } pair (used by Spotify where we already have both).
// Failures are quiet (logged to the activity log only) — the file is fine
// without tags, no need to surface a toast.
// Pipeline that runs after every audio download:
//   1. auto-tag via MusicBrainz (if hint or explicit artist/title present)
//   2. library organize — move into <root>/<pattern>/ based on the now-final
//      tags (no-op when disabled in Settings)
//   3. media-server notify — POST Plex/Jellyfin so the library refreshes
// Step 2 must run AFTER step 1 (tags need to be written first); step 3 runs
// last so the server scans the file at its FINAL path. Steps are independent
// — failures in one don't block the rest. All errors stay in the activity
// log, no toasts, since the file itself is fine regardless.
async function autoTagAfterDownload(filePath, hint, logId, explicit, trackerEntryId) {
  if (!filePath) return;
  // Step 1 — auto-tag
  try {
    const payload = explicit
      ? { filePath, artist: explicit.artist, title: explicit.title }
      : { filePath, hint };
    const r = await window.api.tag.autoTag(payload);
    if (r.ok) {
      appendLog(logId, `🏷️ Auto-tagged: ${r.tags.artist} — ${r.tags.title}${r.cover ? ' (+cover)' : ''} (score=${r.score})`, 'ok');
    } else {
      appendLog(logId, `🏷️ Auto-tag skipped: ${r.error}`, 'info');
    }
  } catch (e) {
    appendLog(logId, `🏷️ Auto-tag error: ${e?.message || e}`, 'info');
  }
  // Step 2 — library organize (only fires if user enabled it in Settings)
  let finalPath = filePath;
  try {
    const r = await window.api.library.organize({ filePath });
    if (r?.moved && r.path) {
      finalPath = r.path;
      appendLog(logId, `📁 Library: moved to ${r.path}`, 'ok');
      // Sync the downloads-tracker entry so its Play / Open-folder buttons
      // point at the FINAL location instead of the now-deleted original.
      // Without this the buttons appear to do nothing (openPath fails
      // silently on a non-existent path).
      if (trackerEntryId) updateDownloadEntry(trackerEntryId, { path: finalPath });
    }
  } catch (e) {
    appendLog(logId, `📁 Library organize error: ${e?.message || e}`, 'info');
  }
  // Step 3 — media-server notify (Plex/Jellyfin/webhook)
  notifyMediaServer({ kind: 'audio', path: finalPath, logId });
}

// Fire-and-forget Plex/Jellyfin/webhook notification. Called from every
// download-completion path (audio runs it via autoTagAfterDownload; video,
// live, torrent call it directly). No-op when integration is disabled.
function notifyMediaServer({ kind, path: filePath, logId } = {}) {
  if (!filePath) return;
  window.api.mediaserver.notify({ kind, path: filePath }).then(r => {
    if (r?.skipped === 'disabled') return;
    if (r?.ok) {
      if (logId) appendLog(logId, `📡 Media server refresh: OK`, 'ok');
    } else if (r?.error) {
      if (logId) appendLog(logId, `📡 Media server refresh failed: ${r.error}`, 'info');
    }
  }).catch(() => {});
}

// Send an identified track ("Artist - Title") through the same YouTube-search
// + yt-dlp audio pipeline the radio ICY download uses. Surfaces progress in
// the global tracker so the user sees the running download.
async function downloadIdentifiedTrack(query) {
  if (!query) return;
  if (!(await ensureBinaries(['yt-dlp', 'ffmpeg', 'ffprobe'], t('nav_media') || 'Download'))) return;
  const entry = addDownloadEntry({ title: query, source: 'identify', status: 'running' });
  // Show a quick toast acknowledging the click
  showToast({
    title: t('identify_toast_dlstart_title'),
    body:  query,
    kind:  'ok',
    ttl:   3000
  });
  try {
    const r = await window.api.youtube.searchAndDownload({
      query, format: 'audio', downloadFolder: config.download_folder
    });
    if (r.ok) {
      updateDownloadEntry(entry.id, { status: 'done', path: r.path });
      showToast({
        title: t('identify_toast_dldone_title'),
        body:  query,
        kind:  'ok',
        ttl:   5000
      });
      if (config.notify_on_done) window.api.notify.show({ title: 'FLUX', body: `✓ ${query}` });
      autoTagAfterDownload(r.path, query, 'radio-log', null, entry.id);
    } else {
      updateDownloadEntry(entry.id, { status: 'error', error: r.error });
      showToast({
        title: t('identify_toast_dlerror_title'),
        body:  r.error || 'Unknown error',
        kind:  'err',
        ttl:   7000
      });
    }
  } catch (e) {
    updateDownloadEntry(entry.id, { status: 'error', error: String(e?.message || e) });
    showToast({
      title: t('identify_toast_dlerror_title'),
      body:  String(e?.message || e),
      kind:  'err',
      ttl:   7000
    });
  }
}

// Record `seconds` of microphone audio and return it as an ArrayBuffer (WebM/
// Opus, what MediaRecorder gives us). Returns null on getUserMedia failure.
async function recordMicrophoneSeconds(seconds) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    console.error('Microphone access denied:', e);
    return null;
  }
  return new Promise((resolve) => {
    const chunks = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = ev => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      resolve(await blob.arrayBuffer());
    };
    rec.start();
    setTimeout(() => { try { rec.stop(); } catch {} }, seconds * 1000);
  });
}

// ─── RADIO (uses global player) ──────────────────────────────────────────────
let radioCurrentStation = null;
let radioCurrentUuid = null;       // uuid currently playing (for play/stop button swap)
let radioLastResults = [];         // last search results, kept to re-render on play state change
let radioViewMode = 'search';      // 'search' | 'favorites'

function bindRadio() {
  const searchBtn   = document.getElementById('radio-search-btn');
  const favViewBtn  = document.getElementById('radio-fav-view-btn');
  const backBtn     = document.getElementById('radio-back-btn');
  const searchInput = document.getElementById('radio-search');

  // Lazy-load metadata dropdowns on first tab visit
  let metaLoaded = false;
  async function ensureMetaLoaded() {
    if (metaLoaded) return;
    metaLoaded = true;
    try {
      const [countries, tags, langs] = await Promise.all([
        window.api.radio.countries(), window.api.radio.tags(), window.api.radio.languages()
      ]);
      populateRadioSelect('radio-country',  countries.items || [], 'name');
      populateRadioSelect('radio-tag',      tags.items      || [], 'name');
      populateRadioSelect('radio-language', langs.items     || [], 'name', { flags: true });
    } catch (e) {
      appendLog('radio-log', `✗ Metadata load failed: ${e.message}`, 'error');
    }
  }

  document.querySelector('.nav-item[data-tab="radio"]').addEventListener('click', ensureMetaLoaded);

  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchBtn.click(); });
  searchBtn.addEventListener('click', () => {
    radioViewMode = 'search';
    favViewBtn.classList.remove('hidden');
    backBtn.classList.add('hidden');
    doRadioSearch();
  });
  favViewBtn.addEventListener('click', () => {
    radioViewMode = 'favorites';
    favViewBtn.classList.add('hidden');
    backBtn.classList.remove('hidden');
    renderRadioFavorites();
  });
  backBtn.addEventListener('click', () => {
    radioViewMode = 'search';
    favViewBtn.classList.remove('hidden');
    backBtn.classList.add('hidden');
    // If we have last search results, restore them; otherwise leave empty for user to search
    if (radioLastSearchResults.length) renderRadioResults(radioLastSearchResults);
    else document.getElementById('radio-tbody').innerHTML = '';
  });
}

let radioLastSearchResults = []; // preserved when switching to favorites view

function capitalizeWords(s) {
  return String(s || '').split(/\s+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

// Map RadioBrowser language names → flag emoji. Names are English-lowercased
// as returned by /languages. Coverage is approximate — unknown languages render
// without a flag.
const LANGUAGE_FLAGS = {
  english: '🇬🇧', italian: '🇮🇹', spanish: '🇪🇸', french: '🇫🇷', german: '🇩🇪',
  portuguese: '🇵🇹', russian: '🇷🇺', japanese: '🇯🇵', chinese: '🇨🇳', korean: '🇰🇷',
  arabic: '🇸🇦', turkish: '🇹🇷', polish: '🇵🇱', dutch: '🇳🇱', greek: '🇬🇷',
  swedish: '🇸🇪', norwegian: '🇳🇴', danish: '🇩🇰', finnish: '🇫🇮', czech: '🇨🇿',
  hungarian: '🇭🇺', romanian: '🇷🇴', bulgarian: '🇧🇬', serbian: '🇷🇸', croatian: '🇭🇷',
  slovenian: '🇸🇮', slovak: '🇸🇰', ukrainian: '🇺🇦', hebrew: '🇮🇱', hindi: '🇮🇳',
  thai: '🇹🇭', vietnamese: '🇻🇳', indonesian: '🇮🇩', malay: '🇲🇾', persian: '🇮🇷',
  catalan: '🏴', basque: '🏴', galician: '🏴', irish: '🇮🇪', welsh: '🏴󠁧󠁢󠁷󠁬󠁳󠁿',
  brazilian: '🇧🇷', mexican: '🇲🇽', argentinian: '🇦🇷', albanian: '🇦🇱', macedonian: '🇲🇰'
};

function populateRadioSelect(id, items, labelKey, opts = {}) {
  const sel = document.getElementById(id);
  if (!sel) return;
  // Preserve the first "All" option
  const first = sel.firstElementChild;
  sel.innerHTML = '';
  if (first) sel.appendChild(first);
  for (const it of items.slice(0, 200)) {
    const opt = document.createElement('option');
    const raw = it[labelKey] || it.name || '';
    opt.value = raw; // keep raw value for API query (lowercase)
    const display = capitalizeWords(raw);
    const flag = opts.flags ? (LANGUAGE_FLAGS[String(raw).toLowerCase()] || '') : '';
    // iso_639 code (e.g. "it", "en") shown uppercased as a 2-letter prefix.
    // On Windows the flag emoji renders as plain letters anyway, so the iso
    // prefix is what users actually see; on Mac/Linux they get both.
    const iso = opts.flags && it.iso_639 ? String(it.iso_639).toUpperCase() : '';
    const tag = [flag, iso].filter(Boolean).join(' ');
    const prefix = tag ? `${tag} · ` : '';
    opt.textContent = `${prefix}${display}${it.stationcount ? ` (${it.stationcount})` : ''}`;
    sel.appendChild(opt);
  }
}

async function doRadioSearch() {
  const name     = document.getElementById('radio-search').value.trim();
  const country  = document.getElementById('radio-country').value;
  const tag      = document.getElementById('radio-tag').value;
  const language = document.getElementById('radio-language').value;
  if (!name && !country && !tag && !language) {
    appendLog('radio-log', 'Specify at least one filter (name/country/genre/language)', 'log');
    return;
  }
  appendLog('radio-log', `Searching stations…`, 'info');
  const r = await window.api.radio.search({ name, country, tag, language, limit: 50 });
  if (!r.ok) { appendLog('radio-log', `✗ ${r.error}`, 'error'); return; }
  radioLastSearchResults = r.results || [];
  renderRadioResults(radioLastSearchResults);
}

function renderRadioResults(stations) {
  radioLastResults = stations;
  const wrap  = document.getElementById('radio-table-wrap');
  const tbody = document.getElementById('radio-tbody');
  tbody.innerHTML = '';
  // Reveal the table once we have something to show — search hits OR a "no
  // results" message. Hide it completely on a fresh tab visit.
  if (wrap) wrap.classList.remove('hidden');
  if (!stations.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--text-muted);padding:16px;text-align:center">${t('radio_no_results')}</td></tr>`;
    return;
  }
  const favorites = new Set((config.radio_favorites || []).map(f => f.uuid));
  stations.forEach((s, i) => {
    const isFav = favorites.has(s.uuid);
    const isPlaying = s.uuid === radioCurrentUuid;
    const tr = document.createElement('tr');
    const nm = s.name.length > 50 ? s.name.substring(0, 47) + '…' : s.name;
    const tagText = (s.tags || '').split(',').slice(0, 3).map(t => esc(t.trim())).filter(Boolean).join(', ');
    // Play button morphs into Stop (orange) when this station is playing.
    const playBtn = isPlaying
      ? `<button class="btn-save-row btn-copy btn-radio-stop" data-action="toggle" data-uuid="${esc(s.uuid)}" data-lucide-icon="square" title="${esc(t('player_stop'))}"></button>`
      : `<button class="btn-save-row btn-torrent btn-radio-play" data-action="toggle" data-uuid="${esc(s.uuid)}" data-lucide-icon="play" title="${esc(t('downloads_play'))}"></button>`;
    tr.innerHTML = `
      <td class="td-num">${i+1}</td>
      <td class="td-name" title="${esc(s.name)}">${esc(nm)}</td>
      <td class="td-site">${esc(s.country || '—')}</td>
      <td class="td-dim">${esc(s.codec || '—')}</td>
      <td class="td-dim">${s.bitrate || 0}</td>
      <td class="td-dim" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${tagText}</td>
      <td class="td-actions">
        ${playBtn}
        <button class="btn-row-fav ${isFav?'is-fav':''}" data-action="fav" data-uuid="${esc(s.uuid)}" data-lucide-icon="star" title="${isFav?'Remove from favorites':'Add to favorites'}"></button>
      </td>`;
    tbody.appendChild(tr);
  });
  applyLucideIcons(tbody);
  tbody.querySelectorAll('[data-action="toggle"]').forEach(b =>
    b.addEventListener('click', () => {
      const st = stations.find(s => s.uuid === b.dataset.uuid);
      if (st && st.uuid === radioCurrentUuid) stopRadioPlayback();
      else playRadioStation(st);
    }));
  tbody.querySelectorAll('[data-action="fav"]').forEach(b =>
    b.addEventListener('click', () => toggleRadioFavorite(stations.find(s => s.uuid === b.dataset.uuid))));
}

function renderRadioFavorites() {
  const favs = config.radio_favorites || [];
  if (!favs.length) {
    document.getElementById('radio-tbody').innerHTML =
      `<tr><td colspan="7" style="color:var(--text-muted);padding:16px;text-align:center">${t('radio_no_favorites')}</td></tr>`;
    return;
  }
  renderRadioResults(favs);
}

function toggleRadioFavorite(station) {
  if (!station) return;
  if (!config.radio_favorites) config.radio_favorites = [];
  const idx = config.radio_favorites.findIndex(f => f.uuid === station.uuid);
  if (idx >= 0) config.radio_favorites.splice(idx, 1);
  else          config.radio_favorites.push(station);
  window.api.config.save(config);
  doRadioSearch(); // refresh row state
}

async function playRadioStation(station) {
  if (!station || !station.url) return;
  // Stop any previous ICY watch
  if (radioCurrentUuid) { try { await window.api.radio.stopIcyWatch(radioCurrentUuid); } catch {} }
  radioCurrentStation = station;
  radioCurrentUuid = station.uuid;
  const subtitle = `📻 RADIO${station.country?` · ${station.country}`:''}${station.codec?` · ${station.codec}`:''}${station.bitrate?` · ${station.bitrate} kbps`:''}`;
  playInGlobalPlayer({
    url: station.url,
    title: station.name,
    source: 'radio',
    id: station.uuid,
    subtitle
  });
  document.getElementById('global-player-source').textContent = subtitle;
  // Start ICY metadata watcher (best-effort; silently no-op for non-Shoutcast streams)
  try { await window.api.radio.startIcyWatch({ uuid: station.uuid, url: station.url }); } catch {}
  appendLog('radio-log', `▶ ${station.name}`, 'ok');
}

function stopRadioPlayback() {
  if (radioCurrentUuid) { try { window.api.radio.stopIcyWatch(radioCurrentUuid); } catch {} }
  radioCurrentStation = null;
  radioCurrentUuid = null;
  stopGlobalPlayer();
}

// ─── SPOTIFY → YOUTUBE ──────────────────────────────────────────────────────
let spotifyResolved = null; // { type, id, name, tracks: [{title, artist, album, durationMs, status, path}] }

function bindSpotify() {
  const url = document.getElementById('spotify-url');
  const resolveBtn = document.getElementById('spotify-resolve-btn');
  const allBtn = document.getElementById('spotify-download-all-btn');
  if (!url || !resolveBtn) return;

  resolveBtn.addEventListener('click', () => doSpotifyResolve());
  url.addEventListener('keydown', e => { if (e.key === 'Enter') doSpotifyResolve(); });
  allBtn.addEventListener('click', () => downloadAllSpotifyTracks());
}

async function doSpotifyResolve() {
  const input = document.getElementById('spotify-url').value.trim();
  const log   = 'spotify-log';
  const wrap     = document.getElementById('spotify-title-preview');
  const titleEl  = document.getElementById('spotify-title-text');
  const metaEl   = document.getElementById('spotify-title-meta');
  const allBtn = document.getElementById('spotify-download-all-btn');
  const resolveBtn = document.getElementById('spotify-resolve-btn');
  const setPreview = (state, title, meta) => {
    wrap.classList.remove('hidden', 'preview-probing', 'preview-valid', 'preview-invalid');
    if (state) wrap.classList.add(`preview-${state}`);
    titleEl.textContent = title || '';
    metaEl.textContent  = meta  || '';
  };
  if (!input) {
    showToast({ title: t('spotify_toast_empty_title'), body: t('spotify_toast_empty_body'), kind: 'warn' });
    return;
  }

  appendLog(log, t('spotify_resolving'), 'info');
  setPreview('probing', t('spotify_resolving'), input);
  allBtn.disabled = true;
  resolveBtn?.classList.add('btn-loading');
  resolveBtn && (resolveBtn.disabled = true);

  try {
    const r = await window.api.spotify.resolve(input);
    if (!r.ok) {
      const isInvalid = /invalid/i.test(r.error || '');
      const reason = isInvalid ? t('spotify_err_invalid') : (r.error || t('spotify_err_fetch'));
      appendLog(log, '✗ ' + reason, 'error');
      setPreview('invalid', reason, input);
      // Surface the error visibly — the activity log is hidden by default.
      showToast({
        title: t('spotify_toast_error_title'),
        body:  reason,
        kind:  'err',
        ttl:   7000
      });
      return;
    }

    if (!r.tracks || !r.tracks.length) {
      // Edge case: resolve "succeeded" but Spotify returned no tracks (deleted
      // playlist, region-restricted, etc.).
      showToast({
        title: t('spotify_toast_error_title'),
        body:  t('spotify_toast_no_tracks'),
        kind:  'warn'
      });
      setPreview('invalid', t('spotify_toast_no_tracks'), input);
      return;
    }

    spotifyResolved = {
      type: r.type, id: r.id, name: r.name,
      tracks: r.tracks.map(tr => ({ ...tr, status: 'pending', path: null, error: null }))
    };
    appendLog(log, t('spotify_resolved', { n: r.tracks.length, kind: r.type }), 'ok');
    appendLog(log, t('spotify_legal_note'), 'log');
    setPreview('valid', r.name, `${r.tracks.length} ${r.type === 'track' ? 'track' : 'tracks'} · ${input}`);
    allBtn.disabled = false;
    renderSpotifyTable();
    showToast({
      title: t('spotify_toast_resolved_title'),
      body:  t('spotify_resolved', { n: r.tracks.length, kind: r.type }),
      kind:  'ok',
      ttl:   4000
    });
  } catch (e) {
    showToast({ title: t('spotify_toast_error_title'), body: String(e?.message || e), kind: 'err', ttl: 7000 });
  } finally {
    resolveBtn?.classList.remove('btn-loading');
    resolveBtn && (resolveBtn.disabled = false);
  }
}

function renderSpotifyTable() {
  const wrap  = document.getElementById('spotify-table-wrap');
  const tbody = document.getElementById('spotify-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!spotifyResolved || !spotifyResolved.tracks.length) {
    if (wrap) wrap.classList.add('hidden');
    return;
  }
  if (wrap) wrap.classList.remove('hidden');

  spotifyResolved.tracks.forEach((tr, i) => {
    const row = document.createElement('tr');
    const statusKey = 'downloads_status_' + tr.status;
    const statusLabel = t(statusKey) || tr.status;
    const canDownload = tr.status === 'pending' || tr.status === 'error';
    const canPlayLocal = tr.status === 'done' && tr.path;
    // Spotify supplies a 30s preview MP3 for most tracks (some markets/labels
    // opt-out). When present, surface a play-preview button BEFORE download.
    const canPreview = !canPlayLocal && !!tr.previewUrl;
    row.innerHTML = `
      <td class="td-num">${i + 1}</td>
      <td class="td-name" title="${esc(tr.title)}">${esc(tr.title)}</td>
      <td class="td-dim">${esc(tr.artist || '—')}</td>
      <td class="td-dim">${esc(tr.album || '—')}</td>
      <td class="td-dim"><span class="dl-item-status ${tr.status}">${esc(statusLabel)}</span></td>
      <td class="td-actions">
        ${canPreview  ? `<button class="btn-icon" data-action="preview" data-idx="${i}" data-lucide-icon="play" title="${esc(t('spotify_preview_title'))}"></button>` : ''}
        ${canDownload ? `<button class="btn-icon" data-action="dl"      data-idx="${i}" data-lucide-icon="download" title="${esc(t('radio_download_song'))}"></button>` : ''}
        ${canPlayLocal? `<button class="btn-icon" data-action="play"    data-idx="${i}" data-lucide-icon="play" title="${esc(t('downloads_play'))}"></button>` : ''}
      </td>`;
    tbody.appendChild(row);
  });
  applyLucideIcons(tbody);

  tbody.querySelectorAll('[data-action="dl"]').forEach(b =>
    b.addEventListener('click', () => downloadSpotifyTrack(parseInt(b.dataset.idx, 10))));
  tbody.querySelectorAll('[data-action="preview"]').forEach(b =>
    b.addEventListener('click', () => {
      const tr = spotifyResolved.tracks[parseInt(b.dataset.idx, 10)];
      if (!tr?.previewUrl) return;
      // Spotify's 30s preview URL is public scdn.co MP3 — play directly in the
      // global topbar audio player. Source label "🎧 SPOTIFY PREVIEW" so the
      // player widget shows it's a preview, not a full download.
      playInGlobalPlayer({
        url:    tr.previewUrl,
        title:  `${tr.artist} - ${tr.title}  (${t('spotify_preview_short')})`,
        source: '🎧 SPOTIFY PREVIEW',
        id:     'sp_prev_' + b.dataset.idx
      });
    }));
  tbody.querySelectorAll('[data-action="play"]').forEach(b =>
    b.addEventListener('click', () => {
      const tr = spotifyResolved.tracks[parseInt(b.dataset.idx, 10)];
      if (!tr?.path) return;
      const fileUrl = 'file:///' + String(tr.path).replace(/\\/g, '/').replace(/^\/+/, '');
      playInGlobalPlayer({ url: fileUrl, title: `${tr.artist} - ${tr.title}`, source: 'download', id: 'sp_' + b.dataset.idx });
    }));
}

async function downloadSpotifyTrack(idx) {
  if (!spotifyResolved) return;
  const tr = spotifyResolved.tracks[idx];
  if (!tr) return;
  // Spotify "download" = YouTube search + yt-dlp audio. Serialized ensure means
  // a "download all" burst prompts/fetches once, not per track.
  if (!(await ensureBinaries(['yt-dlp', 'ffmpeg', 'ffprobe'], 'Spotify'))) return;
  const query = [tr.artist, tr.title].filter(Boolean).join(' ');
  tr.status = 'running';
  tr.error  = null;
  renderSpotifyTable();
  const entry = addDownloadEntry({ title: query, source: 'spotify', status: 'running' });
  appendLog('spotify-log', `⬇ Searching YouTube for: ${query}`, 'info');
  try {
    const r = await window.api.youtube.searchAndDownload({
      query, format: 'audio', downloadFolder: config.download_folder
    });
    if (r.ok) {
      tr.status = 'done';
      tr.path = r.path || null;
      updateDownloadEntry(entry.id, { status: 'done', path: r.path });
      appendLog('spotify-log', `✓ ${query}`, 'ok');
      // Spotify gives us clean artist+title — pass both directly (no parsing).
      if (r.path) autoTagAfterDownload(r.path, null, 'spotify-log', { artist: tr.artist, title: tr.title }, entry.id);
    } else {
      tr.status = 'error';
      tr.error  = r.error || 'unknown';
      updateDownloadEntry(entry.id, { status: 'error', error: r.error });
      appendLog('spotify-log', `✗ ${query} — ${r.error}`, 'error');
    }
  } catch (e) {
    tr.status = 'error';
    tr.error  = String(e?.message || e);
    updateDownloadEntry(entry.id, { status: 'error', error: tr.error });
    appendLog('spotify-log', `✗ ${query} — ${tr.error}`, 'error');
  }
  renderSpotifyTable();
}

async function downloadAllSpotifyTracks() {
  if (!spotifyResolved) return;
  const pending = spotifyResolved.tracks
    .map((tr, i) => ({ tr, i }))
    .filter(({ tr }) => tr.status === 'pending' || tr.status === 'error');
  // Serial: respect yt-dlp concurrency from config externally; here keep it simple
  for (const { i } of pending) {
    await downloadSpotifyTrack(i);
  }
  appendLog('spotify-log', `✓ Batch complete (${pending.length} tracks)`, 'ok');
  if (config.notify_on_done) {
    window.api.notify.show({ title: 'FLUX', body: `Spotify batch complete (${pending.length})` });
  }
}

// ─── TAG EDITOR ──────────────────────────────────────────────────────────────
let tagFiles = [];          // [{ path, name, tags, format, cover, ... }]
let tagSelectedIdx = -1;
let tagBulkSelected = new Set();   // indices into tagFiles for bulk-apply
// Snapshot of form values taken at selectTagFile time. Bulk-apply diffs the
// current form against this baseline so only fields the user actually
// EDITED are propagated to the other selected files — not every visible
// (pre-populated) tag from the active file.
let tagFormBaseline = null;

function bindTagEditor() {
  // Drag-drop still works on the whole tag tab (no visible drop zone now)
  const tabEl = document.getElementById('tab-tag');
  tabEl.addEventListener('dragover',  e => { e.preventDefault(); tabEl.classList.add('drag-over'); });
  tabEl.addEventListener('dragleave', () => tabEl.classList.remove('drag-over'));
  tabEl.addEventListener('drop', e => {
    e.preventDefault();
    tabEl.classList.remove('drag-over');
    const paths = [];
    for (const f of e.dataTransfer.files) if (f.path) paths.push(f.path);
    if (paths.length) addTagFiles(paths);
  });

  document.getElementById('tag-load-files-btn').addEventListener('click', async () => {
    const files = await window.api.dialog.pickFiles();
    if (files && files.length) addTagFiles(files);
  });

  document.getElementById('tag-folder-btn').addEventListener('click', async () => {
    const recursive = document.getElementById('tag-folder-recursive').checked;
    appendLog('tag-log', `📁 Scanning folder${recursive ? ' (recursive)' : ''}…`, 'info');
    const r = await window.api.dialog.pickAudioFolder({ recursive });
    if (!r.ok && !r.files?.length) { if (r.error) appendLog('tag-log', `✗ ${r.error}`, 'error'); return; }
    if (!r.files.length) { appendLog('tag-log', 'No audio files found in folder', 'log'); return; }
    appendLog('tag-log', `Found ${r.files.length} file(s) in ${r.folder}`, 'info');
    await addTagFiles(r.files);
  });

  document.getElementById('tag-clear-btn').addEventListener('click', () => {
    tagFiles = []; tagSelectedIdx = -1; tagBulkSelected.clear(); tagFormBaseline = null;
    renderTagFileList(); document.getElementById('tag-form').classList.add('hidden');
    document.getElementById('tag-empty').classList.remove('hidden');
    // Disable file-action buttons since no file is selected anymore
    document.getElementById('tag-file-play-btn').disabled   = true;
    document.getElementById('tag-file-folder-btn').disabled = true;
    document.getElementById('tag-file-lrc-btn').classList.add('hidden');
  });

  document.getElementById('tag-save-btn').addEventListener('click', saveCurrentTag);
  document.getElementById('tag-save-all-btn').addEventListener('click', saveAllTags);
  document.getElementById('tag-apply-bulk-btn').addEventListener('click', applyTagsToSelected);
  document.getElementById('tag-apply-bulk-icon-btn').addEventListener('click', applyTagsToSelected);
  document.getElementById('tag-select-all-btn').addEventListener('click', toggleSelectAllTagFiles);
  // Live-highlight edited fields. One handler per input is fine — 8 inputs,
  // no listener-explosion concern, and it dodges focus/blur edge cases that
  // a single document-level delegate would have to handle.
  for (const k of TAG_FORM_FIELDS) {
    const el = document.getElementById(`tag-${k}`);
    if (el) el.addEventListener('input', markEditedFields);
  }
  document.getElementById('tag-mb-btn').addEventListener('click', lookupMusicBrainz);
  document.getElementById('tag-cover-btn').addEventListener('click', fetchCurrentCover);
  document.getElementById('tag-lrc-btn').addEventListener('click', fetchCurrentLyrics);
  document.getElementById('tag-from-filename-btn').addEventListener('click', tagFromFilename);
  document.getElementById('tag-to-filename-btn').addEventListener('click', renameFromTags);

  // (Tag layout: the user resizes columns via the draggable splitter — see
  // bindTagSplitter — instead of the old "expand table" toggle.)
  bindTagSplitter();
  // Restore the previously-saved sidebar width on tab init.
  const savedW = config.tag_sidebar_width;
  if (typeof savedW === 'string' && /%$|px$/.test(savedW)) {
    document.querySelector('.tag-layout')?.style.setProperty('--tag-sidebar-w', savedW);
  }

  // File-info action buttons (next to cover / path)
  document.getElementById('tag-file-play-btn').addEventListener('click', () => {
    const f = currentTagFile();
    if (!f) return;
    // Play in the global top-bar player (file:// URL, CSP allows it)
    const fileUrl = 'file:///' + f.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const displayTitle = f.tags.title
      ? (f.tags.artist ? `${f.tags.artist} — ${f.tags.title}` : f.tags.title)
      : f.name;
    playInGlobalPlayer({
      url: fileUrl,
      title: displayTitle,
      source: '🏷️ TAG EDITOR · ' + (f.format || ''),
      id: f.path,
      isHls: false
    });
  });
  document.getElementById('tag-file-folder-btn').addEventListener('click', () => {
    const f = currentTagFile();
    if (f) window.api.shell.revealInFolder(f.path);
  });
  document.getElementById('tag-file-lrc-btn').addEventListener('click', async () => {
    const f = currentTagFile();
    if (!f) return;
    const lrcInfo = await window.api.lrc.exists(f.path);
    if (lrcInfo.exists) window.api.shell.openPath(lrcInfo.path);
  });
  document.getElementById('tag-dedup-btn').addEventListener('click', () => openDedupModal());
}

// ─── DEDUP MODAL — fingerprint-based duplicate finder ─────────────────────
// Sends the currently-loaded tag-editor files to main, which runs fpcalc on
// each and groups by Hamming-distance similarity. Renders each group with
// per-file checkbox (default: keep largest, trash rest) + bulk delete.
let dedupGroups = [];

function openDedupModal() {
  const modal = document.getElementById('dedup-modal');
  modal.classList.remove('hidden');
  dedupGroups = [];
  document.getElementById('dedup-results').innerHTML = '';
  document.getElementById('dedup-delete-selected').classList.add('hidden');
  document.getElementById('dedup-status').textContent = t('dedup_idle');
  setDedupProgress(0);
}

function setDedupProgress(pct) {
  const wrap = document.getElementById('dedup-progress-bar');
  const bar  = wrap.querySelector('.progress-bar');
  const txt  = wrap.querySelector('.progress-bar-text');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct * 100))}%`;
  if (txt) txt.textContent = `${Math.round(pct * 100)}%`;
}

async function runDedupScan() {
  if (tagFiles.length < 2) return;
  const scanBtn = document.getElementById('dedup-scan');
  const delBtn  = document.getElementById('dedup-delete-selected');
  const mode = document.querySelector('input[name="dedup-mode"]:checked')?.value || 'name';
  scanBtn.disabled = true;
  delBtn.classList.add('hidden');
  document.getElementById('dedup-results').innerHTML = '';
  document.getElementById('dedup-status').textContent = mode === 'name'
    ? t('dedup_scanning_name')
    : t('dedup_scanning');
  // For name mode we skip the fingerprint pass entirely — the IPC handler
  // returns synchronously after a normalised-string bucket pass. For
  // fingerprint mode we await the slower fpcalc-driven pipeline.
  const paths = tagFiles.map(f => f.path);
  // Fingerprint dedup needs fpcalc; name-based dedup needs nothing.
  if (mode !== 'name' && !(await ensureBinaries(['fpcalc'], t('dedup_title') || 'Audio dedup'))) {
    scanBtn.disabled = false;
    document.getElementById('dedup-status').textContent = '';
    return;
  }
  const r = mode === 'name'
    ? await window.api.audio.dedupByName({ paths })
    : await window.api.audio.dedup({ paths, threshold: 0.85 });
  scanBtn.disabled = false;
  if (!r.ok) {
    document.getElementById('dedup-status').textContent = `${t('dedup_err_generic')}: ${r.error}`;
    return;
  }
  dedupGroups = r.groups;
  if (!dedupGroups.length) {
    document.getElementById('dedup-status').textContent = t('dedup_no_dupes', { n: r.scanned });
    setDedupProgress(1);
    return;
  }
  document.getElementById('dedup-status').textContent = t('dedup_found', {
    groups: dedupGroups.length,
    files:  dedupGroups.reduce((s, g) => s + g.length, 0)
  });
  delBtn.classList.remove('hidden');
  applyLucideIcons(delBtn);
  renderDedupGroups();
}

function renderDedupGroups() {
  const host = document.getElementById('dedup-results');
  host.innerHTML = '';
  dedupGroups.forEach((group, gi) => {
    const box = document.createElement('div');
    box.className = 'dedup-group';
    box.innerHTML = `<div class="dedup-group-title">${esc(t('dedup_group_label', { n: gi + 1, count: group.length }))}</div>`;
    group.forEach((f, fi) => {
      const row = document.createElement('label');
      row.className = 'dedup-row';
      // First row in each group is the "best" (largest size) — pre-checked
      // means KEEP, others pre-checked means DELETE.
      const isKeep = fi === 0;
      const sizeKB = (f.size / 1024).toFixed(0);
      row.innerHTML = `
        <input type="checkbox" class="dedup-check" data-group="${gi}" data-idx="${fi}" ${isKeep ? '' : 'checked'} />
        <span class="dedup-row-label ${isKeep ? 'dedup-keep' : 'dedup-trash'}">${isKeep ? esc(t('dedup_action_keep')) : esc(t('dedup_action_trash'))}</span>
        <span class="dedup-row-size">${sizeKB} KB</span>
        <span class="dedup-row-path" title="${esc(f.path)}">${esc(f.path)}</span>
      `;
      box.appendChild(row);
    });
    host.appendChild(box);
  });
  // Update keep/trash label when user toggles checkboxes.
  host.querySelectorAll('.dedup-check').forEach(chk => chk.addEventListener('change', () => {
    const lbl = chk.parentElement.querySelector('.dedup-row-label');
    if (chk.checked) {
      lbl.textContent = t('dedup_action_trash');
      lbl.classList.remove('dedup-keep'); lbl.classList.add('dedup-trash');
    } else {
      lbl.textContent = t('dedup_action_keep');
      lbl.classList.remove('dedup-trash'); lbl.classList.add('dedup-keep');
    }
  }));
}

async function dedupDeleteSelected() {
  const checks = document.querySelectorAll('#dedup-results .dedup-check:checked');
  if (!checks.length) return;
  const toTrash = [];
  checks.forEach(c => {
    const g = +c.dataset.group, i = +c.dataset.idx;
    toTrash.push(dedupGroups[g][i].path);
  });
  if (!(await showConfirm({
    title: t('dedup_confirm_title'),
    body:  t('dedup_confirm_body', { n: toTrash.length }),
    danger: true
  }))) return;

  const r = await window.api.audio.trashFiles({ paths: toTrash });
  if (!r.ok) {
    showToast({ title: t('dedup_err_title'), body: r.error, kind: 'err' });
    return;
  }
  // Drop trashed files from the tag editor list + reset selected/preview.
  const trashedSet = new Set(r.trashed);
  tagFiles = tagFiles.filter(f => !trashedSet.has(f.path));
  if (tagSelectedIdx >= tagFiles.length) tagSelectedIdx = -1;
  renderTagFileList();
  if (tagFiles.length === 0) {
    document.getElementById('tag-form').classList.add('hidden');
    document.getElementById('tag-empty').classList.remove('hidden');
  }
  showToast({
    title: t('dedup_done_title'),
    body:  t('dedup_done_body', { trashed: r.trashed.length, failed: r.failed.length }),
    kind:  r.failed.length ? 'warn' : 'ok',
    ttl:   5000
  });
  document.getElementById('dedup-modal').classList.add('hidden');
}

function bindDedupModal() {
  document.getElementById('dedup-scan')?.addEventListener('click', () => runDedupScan());
  document.getElementById('dedup-close')?.addEventListener('click', () =>
    document.getElementById('dedup-modal').classList.add('hidden'));
  document.getElementById('dedup-delete-selected')?.addEventListener('click', () => dedupDeleteSelected());
  // Swap the descriptive help line when the user picks a different scan
  // mode. Both <p>s live in the DOM; only the active one is visible.
  document.querySelectorAll('input[name="dedup-mode"]').forEach(r =>
    r.addEventListener('change', () => {
      const mode = r.value;
      document.getElementById('dedup-help-name').classList.toggle('hidden', mode !== 'name');
      document.getElementById('dedup-help-fingerprint').classList.toggle('hidden', mode !== 'fingerprint');
    }));
  // Progress events from fpcalc batch (only fires in fingerprint mode).
  window.api.audio.onDedupProgress(({ line, progress }) => {
    document.getElementById('dedup-status').textContent = line;
    setDedupProgress(progress);
  });
}

// ─── IMAGE EDITOR (USE tab) ──────────────────────────────────────────────────
// Bulk image operations: rename, convert format, resize, EXIF strip,
// auto-rotate, HEIC→JPG. Mirrors the Tag Editor layout (sidebar list +
// main content) but the main content is a stack of operation cards rather
// than a single per-file form, since image edits are bulk by nature.
let imgFiles = [];
let imgBulkSelected = new Set();  // index set; empty = "apply to all loaded"

// Image Editor sidebar splitter — drag the divider between the file list
// and the operation cards. Independent from the Tag Editor splitter so
// the two tabs can have different layouts (image editor benefits from a
// narrower file list since thumbnails are small + ops cards are wider).
function bindImageSplitter() {
  const splitter = document.getElementById('img-splitter');
  // The two layouts (tag + image) both use class .tag-layout; scope to
  // the image tab specifically so we resize the right one.
  const layout = document.querySelector('#tab-images .tag-layout');
  if (!splitter || !layout) return;
  let dragging = false;
  splitter.addEventListener('mousedown', e => {
    dragging = true;
    splitter.classList.add('is-dragging');
    document.body.classList.add('tag-splitter-active');
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const r = layout.getBoundingClientRect();
    const px = e.clientX - r.left;
    const min = r.width * 0.15;
    const max = r.width * 0.70;
    const w = Math.max(min, Math.min(max, px));
    layout.style.setProperty('--tag-sidebar-w', (w / r.width * 100).toFixed(2) + '%');
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('is-dragging');
    document.body.classList.remove('tag-splitter-active');
    config.img_sidebar_width = layout.style.getPropertyValue('--tag-sidebar-w') || '40%';
    window.api.config.save(config);
  });
}

function bindImageEditor() {
  const loadBtn   = document.getElementById('img-load-files-btn');
  const folderBtn = document.getElementById('img-folder-btn');
  if (!loadBtn) return;
  loadBtn.addEventListener('click', () => pickImageFiles());
  folderBtn.addEventListener('click', () => pickImageFolder());
  document.getElementById('img-clear-btn').addEventListener('click', () => {
    imgFiles = []; imgBulkSelected.clear();
    renderImageList();
    appendLog('img-log', '— cleared —', 'log');
  });
  document.getElementById('img-select-all-btn').addEventListener('click', () => {
    if (imgBulkSelected.size < imgFiles.length) {
      imgFiles.forEach((_, i) => imgBulkSelected.add(i));
    } else {
      imgBulkSelected.clear();
    }
    renderImageList();
  });
  document.getElementById('img-rename-btn').addEventListener('click', () => runImageOp('rename'));
  document.getElementById('img-convert-btn').addEventListener('click', () => runImageOp('convert'));
  document.getElementById('img-resize-btn').addEventListener('click', () => runImageOp('resize'));
  document.getElementById('img-exif-strip-btn').addEventListener('click', () => runImageOp('stripExif'));
  document.getElementById('img-exif-rotate-btn').addEventListener('click', () => runImageOp('autoRotate'));
  document.getElementById('img-heic-btn').addEventListener('click', () => runImageOp('heicToJpg'));
  document.getElementById('img-wm-btn').addEventListener('click', () => runImageOp('watermark'));
  // 9-cell position grid — single click = set active. The active button's
  // data-pos becomes the position value at apply time. Replaces the old
  // <select> dropdown with a visual 3×3 control mirroring image anchors.
  document.querySelectorAll('#img-wm-pos-grid button').forEach(b =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#img-wm-pos-grid button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    }));
  // Output card — Overwrite toggle hides the path picker (it's irrelevant
  // when files write back to their source). Use-system toggle swaps
  // between the Settings download folder and the loaded-images folder
  // for the editable path input.
  document.getElementById('img-overwrite')?.addEventListener('change', refreshImageOutputUI);
  document.getElementById('img-use-system-folder')?.addEventListener('change', refreshImageOutputUI);
  // Browse button — opens the OS folder picker, stuffs the chosen path
  // into the input + flips off "use system folder" so the user's pick
  // sticks. Disabled while system-folder mode is on or overwrite is on
  // (in those modes the input value is computed, not user-driven).
  document.getElementById('img-output-browse')?.addEventListener('click', async () => {
    const folder = await window.api.dialog.pickFolder();
    if (!folder) return;
    const useSysEl = document.getElementById('img-use-system-folder');
    const folderEl = document.getElementById('img-output-folder');
    if (useSysEl) useSysEl.checked = false;
    if (folderEl) {
      // Append /new only if the user picked a folder that doesn't
      // already end with it — avoid double-nesting on repeat picks.
      const sep = folder.includes('\\') ? '\\' : '/';
      folderEl.value = /[\\/]new\/?$/i.test(folder) ? folder : `${folder}${sep}new`;
    }
    refreshImageOutputUI();
  });
  refreshImageOutputUI();
  document.getElementById('img-compress-btn').addEventListener('click', () => runImageOp('compressToSize'));
  document.getElementById('img-dedup-btn').addEventListener('click', () => runImageDedup());
  document.getElementById('img-similar-btn').addEventListener('click', () => runImageSimilar());
  document.getElementById('img-organize-btn').addEventListener('click', () => runImageOrganize());
  // Prefill the organize card from the saved Settings defaults.
  const orgPat = document.getElementById('img-organize-pattern');
  if (orgPat) orgPat.value = config.image_library_pattern || '{year}/{month}';
  document.getElementById('img-organize-browse').addEventListener('click', async () => {
    const p = await window.api.dialog.pickFolder();
    if (p) document.getElementById('img-organize-root').value = p;
  });
  document.getElementById('img-timelapse-btn').addEventListener('click', () => runImageTimelapse());
  document.getElementById('img-pdf-btn').addEventListener('click', () => runImageToPdf());
}

async function pickImageFiles() {
  const paths = await window.api.dialog.pickImages();
  if (!paths || !paths.length) return;
  await ingestImagePaths(paths);
}
async function pickImageFolder() {
  // pickFolder returns a path string (or null), matching the existing tag
  // editor's "Load folder" flow. We ask main to walk it (recursive optional).
  const folder = await window.api.dialog.pickFolder();
  if (!folder) return;
  const recursive = document.getElementById('img-folder-recursive')?.checked !== false;
  appendLog('img-log', `Loading folder${recursive ? ' (recursive)' : ''}…`, 'info');
  const lr = await window.api.images.load({ folder, recursive });
  if (!lr.ok) { appendLog('img-log', `✗ ${lr.error}`, 'error'); return; }
  for (const f of lr.files) {
    if (imgFiles.find(x => x.path === f.path)) continue;
    imgFiles.push(f);
  }
  appendLog('img-log', `Loaded ${lr.files.length} image(s) from folder`, 'ok');
  renderImageList();
}
async function ingestImagePaths(paths) {
  // Split out PDFs — they're rasterised to PNG pages first, then the
  // resulting PNG paths flow back through the normal images.load() path.
  const pdfs   = paths.filter(p => /\.pdf$/i.test(p));
  const direct = paths.filter(p => !/\.pdf$/i.test(p));
  let allPaths = [...direct];
  for (const pdfPath of pdfs) {
    appendLog('img-log', `Rasterising PDF ${pdfPath.split(/[\\/]/).pop()}…`, 'info');
    try {
      const pages = await rasterizePdfToPngPaths(pdfPath);
      allPaths.push(...pages);
      appendLog('img-log', `✓ ${pages.length} page(s) extracted`, 'ok');
    } catch (e) {
      appendLog('img-log', `✗ PDF rasterise failed: ${e.message}`, 'error');
      showToast({ title: t('images_op_err_title') || 'Image op failed', body: `PDF: ${e.message}`, kind: 'err', ttl: 6000 });
    }
  }
  if (!allPaths.length) return;
  const lr = await window.api.images.load({ paths: allPaths });
  if (!lr.ok) { appendLog('img-log', `✗ ${lr.error}`, 'error'); return; }
  for (const f of lr.files) {
    if (imgFiles.find(x => x.path === f.path)) continue;
    imgFiles.push(f);
  }
  appendLog('img-log', `Loaded ${lr.files.length} image(s)`, 'ok');
  renderImageList();
}

// Lazy-load pdf.js once on first PDF ingest. Vendored in renderer/vendor/
// to keep the app fully offline. The worker is fetched relative to the same
// folder — Electron resolves both via file:// in the renderer.
let _pdfjsLib = null;
async function ensurePdfJs() {
  if (_pdfjsLib) return _pdfjsLib;
  const mod = await import('./vendor/pdf.min.mjs');
  // pdf.js needs an explicit worker URL — the renderer is loaded from
  // renderer/index.html so a relative path resolves against that origin.
  mod.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.mjs';
  _pdfjsLib = mod;
  return mod;
}

// XTRACT > Image PDF flow: pdf.js loads the doc, modal lets the user pick a
// page (with live thumbnail preview), then we rasterise that single page at
// full quality and feed it to ensureImageEditor as if it were a regular PNG.
let _xtractPdfState = null;  // { doc, baseName, srcPath }

async function openXtractPdfPagePicker(pdfPath) {
  const modal       = document.getElementById('xtract-pdf-page-modal');
  const numInput    = document.getElementById('xtract-pdf-page-num');
  const totalSpan   = document.getElementById('xtract-pdf-page-total');
  const infoP       = document.getElementById('xtract-pdf-pick-info');
  const previewImg  = document.getElementById('xtract-pdf-preview-img');
  const okBtn       = document.getElementById('xtract-pdf-page-ok');
  okBtn.disabled = true;
  previewImg.src = '';
  infoP.textContent = pdfPath.split(/[\\/]/).pop();
  modal.classList.remove('hidden');
  try {
    const pdfjs = await ensurePdfJs();
    const baseName = pdfPath.split(/[\\/]/).pop().replace(/\.pdf$/i, '');
    const doc = await pdfjs.getDocument({ url: localFileURL(pdfPath), useSystemFonts: true }).promise;
    _xtractPdfState = { doc, baseName, srcPath: pdfPath };
    numInput.min = 1;
    numInput.max = doc.numPages;
    numInput.value = 1;
    totalSpan.textContent = `/ ${doc.numPages}`;
    okBtn.disabled = false;
    await renderXtractPdfPreview(1);
  } catch (e) {
    showToast({ title: t('images_op_err_title') || 'Image op failed', body: `PDF: ${e.message}`, kind: 'err', ttl: 6000 });
    modal.classList.add('hidden');
  }
}

async function renderXtractPdfPreview(pageNum) {
  if (!_xtractPdfState) return;
  const previewImg = document.getElementById('xtract-pdf-preview-img');
  try {
    const page = await _xtractPdfState.doc.getPage(pageNum);
    // Low-res for the preview — saves time and the modal box is small anyway.
    // The actual rasterisation on OK uses 2× scale.
    const viewport = page.getViewport({ scale: 0.5 });
    const canvas = document.createElement('canvas');
    canvas.width  = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    previewImg.src = canvas.toDataURL('image/png');
    canvas.width = canvas.height = 0;
  } catch (e) {
    console.error('PDF preview failed:', e);
  }
}

function bindXtractPdfPagePicker() {
  const numInput = document.getElementById('xtract-pdf-page-num');
  const okBtn    = document.getElementById('xtract-pdf-page-ok');
  const cancel   = document.getElementById('xtract-pdf-page-cancel');
  const modal    = document.getElementById('xtract-pdf-page-modal');
  if (!numInput || !okBtn) return;
  let previewTimer = null;
  numInput.addEventListener('input', () => {
    if (!_xtractPdfState) return;
    const n = Math.max(1, Math.min(_xtractPdfState.doc.numPages, parseInt(numInput.value, 10) || 1));
    if (parseInt(numInput.value, 10) !== n) numInput.value = n;
    // Debounce — keystroke-fast input would otherwise queue dozens of renders.
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => renderXtractPdfPreview(n), 150);
  });
  cancel.addEventListener('click', () => {
    modal.classList.add('hidden');
    _xtractPdfState = null;
  });
  okBtn.addEventListener('click', async () => {
    if (!_xtractPdfState) return;
    const n = Math.max(1, Math.min(_xtractPdfState.doc.numPages, parseInt(numInput.value, 10) || 1));
    okBtn.classList.add('btn-loading');
    okBtn.disabled = true;
    try {
      const page = await _xtractPdfState.doc.getPage(n);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width  = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const dataUrl = canvas.toDataURL('image/png');
      canvas.width = canvas.height = 0;
      const sr = await window.api.convert.savePdfPage({ dataUrl, baseName: _xtractPdfState.baseName, pageNum: n });
      if (!sr.ok) throw new Error(sr.error);
      // Feed the saved PNG through the normal "user picked a file" path so
      // the crop / fx / compare cards mount as usual.
      modal.classList.add('hidden');
      _xtractPdfState = null;
      xtractInput = sr.path;
      xtractConcatExtras = [];
      updateXtractClearButton();
      const info = document.getElementById('xtract-file-info');
      info.textContent = sr.path.split(/[\\/]/).pop();
      document.getElementById('xtract-concat-info').textContent = t('xtract_concat_none');
      refreshXtractCards();
      probeXtractInputAudio(sr.path);
      destroyTrimEditor();
      ensureImageEditor(sr.path);
    } catch (e) {
      showToast({ title: t('images_op_err_title') || 'Image op failed', body: `PDF page: ${e.message}`, kind: 'err', ttl: 6000 });
    } finally {
      okBtn.classList.remove('btn-loading');
      okBtn.disabled = false;
    }
  });
}

// Render each page of a PDF to a PNG file on disk, return the file paths.
// Pages are rasterised at 2× scale for legibility on HiDPI displays — a
// reasonable middle ground between file size and quality (a 100-page deck
// at 2× ends up ~30-50 MB which is still tractable for the rest of the
// pipeline). Higher scale would smooth screenshots more but blow up disk.
async function rasterizePdfToPngPaths(pdfPath) {
  const pdfjs = await ensurePdfJs();
  const baseName = pdfPath.split(/[\\/]/).pop().replace(/\.pdf$/i, '');
  // pdf.js accepts a URL string — file:// works in Electron's renderer.
  const url = localFileURL(pdfPath);
  const loadingTask = pdfjs.getDocument({ url, useSystemFonts: true });
  const pdf = await loadingTask.promise;
  const paths = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width  = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const dataUrl = canvas.toDataURL('image/png');
    const r = await window.api.convert.savePdfPage({ dataUrl, baseName, pageNum: n });
    if (!r.ok) throw new Error(r.error || `Failed to save page ${n}`);
    paths.push(r.path);
    // Free the canvas memory between pages — big PDFs would otherwise pile
    // up several hundred MB of pixel buffers in the renderer heap.
    canvas.width = canvas.height = 0;
  }
  return paths;
}

function renderImageList() {
  const ul = document.getElementById('img-file-list');
  const countEl = document.getElementById('img-file-count');
  const empty = document.getElementById('img-empty');
  const form  = document.getElementById('img-form');
  if (!ul) return;
  if (countEl) countEl.textContent = imgFiles.length ? `${imgFiles.length} file(s)` : '—';
  const hasFiles = imgFiles.length > 0;
  ['img-select-all-btn','img-clear-btn','img-rename-btn','img-convert-btn','img-resize-btn',
   'img-exif-strip-btn','img-exif-rotate-btn','img-heic-btn','img-wm-btn','img-compress-btn',
   'img-dedup-btn','img-similar-btn','img-organize-btn','img-timelapse-btn','img-pdf-btn','img-sync-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !hasFiles;
  });
  // Output card path defaults follow the loaded files — refresh whenever
  // the list changes so the "first image's folder + /new" stays current.
  refreshImageOutputUI();
  if (empty) empty.classList.toggle('hidden', hasFiles);
  if (form)  form.classList.toggle('hidden', !hasFiles);
  ul.innerHTML = '';
  imgFiles.forEach((f, i) => {
    const li = document.createElement('li');
    li.className = 'tag-file-item';
    const chk = imgBulkSelected.has(i) ? 'checked' : '';
    const dim = (f.width && f.height) ? `${f.width}×${f.height}` : '';
    li.innerHTML = `
      <label class="import-row-switch" title="${esc(t('tag_bulk_select_hint'))}">
        <input type="checkbox" class="img-file-check" data-idx="${i}" ${chk} />
        <span class="switch-slider"></span>
      </label>
      <img class="img-file-thumb" data-idx="${i}" alt="" />
      <span class="tag-file-ext">${esc(f.ext)}</span>
      <span class="tag-file-name" title="${esc(f.path)}">${esc(f.name)}</span>
      <span class="tag-file-meta-dim">${esc(dim)}</span>`;
    ul.appendChild(li);
    // Lazy-load thumbnail asynchronously so a 200-file folder doesn't block.
    const thumbImg = li.querySelector('.img-file-thumb');
    window.api.images.thumbnail({ input: f.path, maxSize: 48 }).then(r => {
      if (r.ok && thumbImg) thumbImg.src = r.dataUri;
    }).catch(() => {});
  });
  ul.querySelectorAll('.img-file-check').forEach(cb =>
    cb.addEventListener('change', (e) => {
      const i = parseInt(cb.dataset.idx, 10);
      if (cb.checked) imgBulkSelected.add(i); else imgBulkSelected.delete(i);
      e.stopPropagation();
    }));
}

function selectedImageFiles() {
  if (imgBulkSelected.size === 0) return imgFiles.slice();
  return [...imgBulkSelected].map(i => imgFiles[i]).filter(Boolean);
}

// Output card state machine. Three modes derived from two checkboxes:
//   - overwrite=true                  → write in place (path UI hidden)
//   - overwrite=false, useSys=true    → ${config.download_folder}/new (input disabled)
//   - overwrite=false, useSys=false   → ${first-image-folder}/new      (input editable)
// Called on: overwrite toggle, useSys toggle, image load, image clear.
function refreshImageOutputUI() {
  const overwriteEl = document.getElementById('img-overwrite');
  const useSysEl    = document.getElementById('img-use-system-folder');
  const folderEl    = document.getElementById('img-output-folder');
  const customRow   = document.getElementById('img-output-custom-row');
  const browseBtn   = document.getElementById('img-output-browse');
  if (!overwriteEl || !useSysEl || !folderEl || !customRow) return;
  // When overwrite is on, hide the path picker entirely — output goes
  // back to each file's own location, so a "destination folder" makes
  // no sense.
  customRow.style.display = overwriteEl.checked ? 'none' : '';
  if (overwriteEl.checked) return;
  // Browse button mirrors the input — enabled only when the user can
  // actually choose a folder (system-folder OFF means free choice; ON
  // means the path is computed from settings, picker would be confusing).
  if (browseBtn) browseBtn.disabled = useSysEl.checked;
  // Path resolution. Both modes append "/new" so the output sits in a
  // subfolder, never co-mingling with the source files (which could be
  // confusing or accidentally overwrite when extensions match).
  if (useSysEl.checked) {
    const dl = (config.download_folder || '').replace(/[/\\]+$/, '');
    folderEl.value = dl ? `${dl}${dl.includes('\\') ? '\\' : '/'}new` : '';
    folderEl.disabled = true;
  } else {
    // Editable: default to the first loaded image's folder + "/new".
    // If no images yet, leave whatever was there (initial empty string
    // or whatever the user typed previously — don't clobber).
    folderEl.disabled = false;
    if (imgFiles.length > 0) {
      const first = imgFiles[0].path;
      const sep = first.includes('\\') ? '\\' : '/';
      const folder = first.substring(0, first.lastIndexOf(sep));
      folderEl.value = folder ? `${folder}${sep}new` : 'new';
    }
  }
}

async function runImageOp(op) {
  const files = selectedImageFiles();
  if (!files.length) return;
  const overwrite = !!document.getElementById('img-overwrite')?.checked;
  // Output folder is forwarded only when NOT overwriting. Trim trailing
  // whitespace so the user typing extra spaces doesn't break path joins
  // downstream. Empty string = backend falls back to legacy "suffix
  // next to source" behaviour.
  const outputFolder = overwrite
    ? null
    : ((document.getElementById('img-output-folder')?.value || '').trim() || null);
  let r;
  appendLog('img-log', `${op}: ${files.length} file(s)…`, 'info');
  try {
    if (op === 'rename') {
      const pattern = document.getElementById('img-rename-pattern').value.trim() || '{name}-{nn}.{ext}';
      const start   = parseInt(document.getElementById('img-rename-start').value, 10) || 1;
      r = await window.api.images.rename({ files, pattern, start });
    } else if (op === 'convert') {
      const format  = document.getElementById('img-convert-format').value;
      const quality = parseInt(document.getElementById('img-convert-quality').value, 10) || 85;
      r = await window.api.images.convert({ files, format, quality, overwrite, outputFolder });
    } else if (op === 'resize') {
      const maxWidth  = parseInt(document.getElementById('img-resize-max-w').value, 10) || 0;
      const maxHeight = parseInt(document.getElementById('img-resize-max-h').value, 10) || 0;
      const scalePct  = parseInt(document.getElementById('img-resize-scale').value, 10) || 0;
      if (maxWidth <= 0 && maxHeight <= 0 && scalePct <= 0) {
        const msg = 'resize: set at least one of max W / max H / scale %';
        appendLog('img-log', `✗ ${msg}`, 'error');
        showToast({ title: t('images_op_err_title') || 'Image op failed', body: msg, kind: 'err', ttl: 5000 });
        return;
      }
      r = await window.api.images.resize({ files, maxWidth, maxHeight, scalePct, overwrite, outputFolder });
    } else if (op === 'stripExif') {
      r = await window.api.images.stripExif({ files, overwrite, outputFolder });
    } else if (op === 'autoRotate') {
      r = await window.api.images.autoRotate({ files, overwrite, outputFolder });
    } else if (op === 'heicToJpg') {
      const quality = parseInt(document.getElementById('img-heic-quality').value, 10) || 92;
      r = await window.api.images.heicToJpg({ files, quality, outputFolder });
    } else if (op === 'watermark') {
      const text = document.getElementById('img-wm-text').value.trim();
      if (!text) {
        const msg = 'watermark: text required';
        appendLog('img-log', `✗ ${msg}`, 'error');
        showToast({ title: t('images_op_err_title') || 'Image op failed', body: msg, kind: 'err', ttl: 5000 });
        return;
      }
      // Read position from the 9-cell grid (replaces the old <select>).
      const activePos = document.querySelector('#img-wm-pos-grid button.active');
      const wmPosition = (activePos?.dataset.pos) || 'br';
      r = await window.api.images.watermark({
        files,
        text,
        fontSize: parseInt(document.getElementById('img-wm-size').value, 10) || 48,
        color:    document.getElementById('img-wm-color').value || '#ffffff',
        opacity:  (parseInt(document.getElementById('img-wm-opacity').value, 10) || 70) / 100,
        position: wmPosition,
        shadow:   !!document.getElementById('img-wm-shadow').checked,
        overwrite, outputFolder
      });
    } else if (op === 'compressToSize') {
      const targetKb = parseInt(document.getElementById('img-compress-target').value, 10) || 0;
      if (targetKb <= 0) {
        const msg = '✗ compress: target size required';
        appendLog('img-log', msg, 'error');
        showToast({ title: t('images_op_err_title') || 'Image op failed', body: msg, kind: 'err', ttl: 5000 });
        return;
      }
      r = await window.api.images.compressToSize({
        files, targetKb,
        format: document.getElementById('img-compress-format').value || 'jpg',
        overwrite, outputFolder
      });
    }
  } catch (e) {
    appendLog('img-log', `✗ ${op}: ${e.message}`, 'error');
    showToast({ title: t('images_op_err_title') || 'Image op failed', body: `${op}: ${e.message}`, kind: 'err', ttl: 6000 });
    return;
  }
  if (!r || !r.ok) {
    const errMsg = r?.error || 'unknown error';
    appendLog('img-log', `✗ ${op}: ${errMsg}`, 'error');
    showToast({ title: t('images_op_err_title') || 'Image op failed', body: `${op}: ${errMsg}`, kind: 'err', ttl: 6000 });
    return;
  }
  // r has different "success" keys per op (renamed / converted / resized /…).
  // Counting "the first array that's not 'failed'" keeps the log uniform.
  const successKeys = ['renamed','converted','resized','stripped','rotated','watermarked','compressed'];
  const succArr = successKeys.map(k => r[k]).find(Array.isArray) || [];
  const failArr = r.failed || [];
  appendLog('img-log', `✓ ${op}: ${succArr.length} ok, ${failArr.length} failed`, failArr.length ? 'warn' : 'ok');
  for (const f of failArr.slice(0, 10)) appendLog('img-log', `  ✗ ${f.path}: ${f.error}`, 'error');
  // Surface failures as a toast so the user notices without having to
  // open the activity-log panel. Success-only ops stay quiet (log only)
  // since the user can see the file count in the log header.
  if (failArr.length > 0) {
    const firstFails = failArr.slice(0, 3).map(f => `${f.path.split(/[\\/]/).pop()}: ${f.error}`).join('\n');
    const more = failArr.length > 3 ? `\n+${failArr.length - 3} more — see activity log` : '';
    showToast({
      title:  t('images_op_partial_title') || `${op}: ${failArr.length} file(s) failed`,
      body:   firstFails + more,
      kind:   succArr.length > 0 ? 'warn' : 'err',
      ttl:    7000
    });
  } else if (succArr.length > 0) {
    // Brief success toast — confirms the action without forcing the user
    // to inspect the activity-log for a count.
    showToast({
      title:  t('images_op_ok_title') || `${op} complete`,
      body:   `${succArr.length} file(s) processed`,
      kind:   'ok',
      ttl:    5000,
      // Multi-file batch — picking just one "Open file" target would be
      // arbitrary, so we offer only Open folder. revealInFolder on the
      // first saved path opens the destination directory in the OS file
      // manager. Each entry is `{ from, to }` (the main-side IPC returns
      // objects, not bare paths) — pass `.to` (the SAVED file) so the
      // OS opens the destination folder, not the source folder.
      actions: succArr[0] ? [{
        icon: 'folder-open',
        title: t('toast_open_folder') || 'Open folder',
        onClick: (close) => { window.api.shell.revealInFolder(succArr[0].to || succArr[0]); close(); }
      }] : null
    });
  }
  // Refresh the list: rename changed paths; others may have created new files
  // adjacent — reload metadata so dimensions reflect the new state.
  if (op === 'rename') {
    const map = new Map((r.renamed || []).map(x => [x.from, x.to]));
    imgFiles = imgFiles.map(f => {
      const newPath = map.get(f.path);
      return newPath ? { ...f, path: newPath, name: newPath.split(/[\\/]/).pop() } : f;
    });
    renderImageList();
  }
}

// Image perceptual-hash dedup — reuses the existing #dedup-modal that
// audio dedup uses (same UI grammar: groups with checkboxes, bulk trash).
// We swap in image-specific i18n at modal-open time so the help text and
// labels match the image context.
let imageDedupGroups = null;

async function runImageDedup() {
  if (imgFiles.length < 2) return;
  const modal = document.getElementById('dedup-modal');
  const status = document.getElementById('dedup-status');
  const results = document.getElementById('dedup-results');
  const delBtn  = document.getElementById('dedup-delete-selected');
  const helpEl  = document.getElementById('dedup-help-fingerprint');
  // Hide mode toggle while in image mode (only one algorithm here).
  document.querySelectorAll('input[name="dedup-mode"]').forEach(r => {
    r.closest('.radio-card').style.display = 'none';
  });
  if (helpEl) {
    helpEl.classList.remove('hidden');
    helpEl.textContent = t('images_dedup_help');
  }
  document.getElementById('dedup-help-name')?.classList.add('hidden');
  modal.classList.remove('hidden');
  results.innerHTML = '';
  delBtn.classList.add('hidden');
  status.textContent = t('images_dedup_scanning') || 'Hashing images…';
  setDedupProgress(0);
  const paths = imgFiles.map(f => f.path);
  const threshold = parseInt(document.getElementById('img-dedup-threshold').value, 10);
  const r = await window.api.images.dedup({ paths, threshold });
  if (!r.ok) {
    status.textContent = `${t('dedup_err_generic')}: ${r.error}`;
    showToast({ title: t('images_op_err_title') || 'Image op failed', body: `dedup: ${r.error}`, kind: 'err', ttl: 6000 });
    return;
  }
  imageDedupGroups = r.groups;
  dedupGroups = r.groups;   // share with the existing dedup-modal render
  if (!dedupGroups.length) {
    status.textContent = t('dedup_no_dupes', { n: r.scanned });
    setDedupProgress(1);
    return;
  }
  status.textContent = t('dedup_found', {
    groups: dedupGroups.length,
    files:  dedupGroups.reduce((s, g) => s + g.length, 0)
  });
  delBtn.classList.remove('hidden');
  applyLucideIcons(delBtn);
  renderDedupGroups();
  // After trashing, also remove from imgFiles so the Image Editor list updates.
  // We hook into the existing delete flow by listening for modal close (cheap).
}

// Restore the dedup-mode radio row when the modal is closed (in case the
// user opens audio dedup next).
function restoreDedupModeRow() {
  document.querySelectorAll('input[name="dedup-mode"]').forEach(r => {
    r.closest('.radio-card').style.display = '';
  });
}

// ─── Similar photos · pick the best ─────────────────────────────────────────
// Groups visually-similar shots (perceptual hash) and shows each group as a
// thumbnail gallery with the sharpest/highest-res shot suggested as keeper.
// The user picks one keeper per group (radio); trashing moves all non-keepers
// to the OS trash. Backed by images:groupSimilar in main.js.
let similarGroups = [];

function setSimilarProgress(pct) {
  const wrap = document.getElementById('similar-progress-bar');
  if (!wrap) return;
  const bar = wrap.querySelector('.progress-bar');
  const txt = wrap.querySelector('.progress-bar-text');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct * 100))}%`;
  if (txt) txt.textContent = `${Math.round(pct * 100)}%`;
}

async function runImageSimilar() {
  if (imgFiles.length < 2) {
    showToast({ title: t('images_op_err_title') || 'Image op failed', body: t('similar_need_two') || 'Load at least 2 images.', kind: 'err', ttl: 4000 });
    return;
  }
  const modal   = document.getElementById('similar-modal');
  const results = document.getElementById('similar-results');
  const status  = document.getElementById('similar-status');
  const trashBtn = document.getElementById('similar-trash');
  modal.classList.remove('hidden');
  results.innerHTML = '';
  trashBtn.classList.add('hidden');
  status.textContent = t('similar_scanning') || 'Analyzing images…';
  setSimilarProgress(0);
  const paths = imgFiles.map(f => f.path);
  const threshold = parseInt(document.getElementById('img-similar-sens').value, 10);
  const r = await window.api.images.groupSimilar({ paths, threshold });
  if (!r.ok) {
    status.textContent = `${t('dedup_err_generic') || 'Error'}: ${r.error}`;
    showToast({ title: t('images_op_err_title') || 'Image op failed', body: `similar: ${r.error}`, kind: 'err', ttl: 6000 });
    return;
  }
  similarGroups = r.groups;
  if (!similarGroups.length) {
    status.textContent = t('similar_none', { n: r.scanned }) || 'No similar photos found.';
    setSimilarProgress(1);
    return;
  }
  status.textContent = t('similar_found', {
    groups: similarGroups.length,
    files:  similarGroups.reduce((s, g) => s + g.length, 0)
  });
  trashBtn.classList.remove('hidden');
  applyLucideIcons(trashBtn);
  renderSimilarGroups();
  setSimilarProgress(1);
}

function renderSimilarGroups() {
  const host = document.getElementById('similar-results');
  host.innerHTML = '';
  similarGroups.forEach((group, gi) => {
    const box = document.createElement('div');
    box.className = 'similar-group';
    const title = document.createElement('div');
    title.className = 'similar-group-title';
    title.textContent = t('similar_group_label', { n: gi + 1, count: group.length }) || `Group ${gi + 1} · ${group.length}`;
    box.appendChild(title);
    const grid = document.createElement('div');
    grid.className = 'similar-grid';
    group.forEach((f, fi) => {
      const card = document.createElement('div');
      card.className = 'similar-card' + (f.best ? ' is-keep' : '');
      card.dataset.group = gi; card.dataset.idx = fi;
      const dim = (f.width && f.height) ? `${f.width}×${f.height}` : '';
      const mp  = f.megapixels ? `${f.megapixels.toFixed(1)} MP` : '';
      const sharpPct = Math.round((f.sharpRel || 0) * 100);
      card.innerHTML = `
        <div class="similar-thumb-wrap">
          <img class="similar-thumb" alt="" />
          <span class="similar-badge${f.best ? '' : ' hidden'}" title="${esc(t('similar_best_hint') || 'Sharpest / highest resolution — suggested keeper')}" data-lucide-icon="star" data-lucide-size="13"></span>
        </div>
        <div class="similar-meta"><span>${esc(dim)}</span><span>${esc(mp)}</span></div>
        <div class="similar-sharp" title="${esc(t('similar_sharpness') || 'Sharpness')}">
          <span class="similar-sharp-bar"><span class="similar-sharp-fill" style="width:${sharpPct}%"></span></span>
        </div>
        <label class="similar-keep"><input type="radio" name="keep-${gi}" ${f.best ? 'checked' : ''} /> <span>${esc(t('similar_keep') || 'Keep')}</span></label>
        <span class="similar-name" title="${esc(f.path)}">${esc(f.path.split(/[\\/]/).pop())}</span>`;
      grid.appendChild(card);
      const img = card.querySelector('.similar-thumb');
      window.api.images.thumbnail({ input: f.path, maxSize: 220 }).then(rr => { if (rr.ok && img) img.src = rr.dataUri; }).catch(() => {});
      card.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        const radio = card.querySelector('input[type=radio]');
        radio.checked = true;
        syncSimilarKeepUI(gi);
      });
      card.querySelector('input[type=radio]').addEventListener('change', () => syncSimilarKeepUI(gi));
    });
    box.appendChild(grid);
    host.appendChild(box);
  });
  applyLucideIcons(host);
}

// Reflect the chosen keeper (the green border) per group as the radio changes.
function syncSimilarKeepUI(gi) {
  document.querySelectorAll(`.similar-card[data-group="${gi}"]`).forEach(card => {
    const keep = card.querySelector('input[type=radio]').checked;
    card.classList.toggle('is-keep', keep);
  });
}

async function similarTrashOthers() {
  const toTrash = [];
  similarGroups.forEach((group, gi) => {
    document.querySelectorAll(`.similar-card[data-group="${gi}"]`).forEach(card => {
      const keep = card.querySelector('input[type=radio]').checked;
      if (!keep) toTrash.push(similarGroups[gi][+card.dataset.idx].path);
    });
  });
  if (!toTrash.length) {
    showToast({ title: t('similar_title') || 'Similar photos', body: t('similar_nothing') || 'Nothing to trash — every group keeps everything.', kind: 'warn', ttl: 4000 });
    return;
  }
  if (!(await showConfirm({
    title: t('similar_confirm_title') || 'Move to trash',
    body:  t('similar_confirm_body', { n: toTrash.length }) || `Move ${toTrash.length} non-kept photo(s) to the trash?`,
    danger: true
  }))) return;
  const r = await window.api.audio.trashFiles({ paths: toTrash });
  if (!r.ok) {
    showToast({ title: t('dedup_err_title') || 'Failed', body: r.error, kind: 'err' });
    return;
  }
  const trashedSet = new Set(r.trashed);
  imgFiles = imgFiles.filter(f => !trashedSet.has(f.path));
  imgBulkSelected.clear();
  renderImageList();
  showToast({
    title: t('similar_done_title') || 'Done',
    body:  t('similar_done_body', { trashed: r.trashed.length, failed: r.failed.length }) || `${r.trashed.length} trashed`,
    kind:  r.failed.length ? 'warn' : 'ok',
    ttl:   5000
  });
  document.getElementById('similar-modal').classList.add('hidden');
}

// Move loaded/selected photos into dated subfolders (EXIF capture date, with
// file date as fallback) under a destination root, following a {year}/{month}
// pattern. Files are MOVED, so confirm first and drop them from the list after.
async function runImageOrganize() {
  const files = selectedImageFiles();
  if (!files.length) return;
  const pattern = (document.getElementById('img-organize-pattern').value || '{year}/{month}').trim();
  const rootInput = (document.getElementById('img-organize-root').value || '').trim();
  const root = rootInput || config.download_folder;
  if (!root) {
    showToast({ title: t('images_op_err_title') || 'Image op failed', body: t('images_organize_no_root') || 'Set a destination root (or a download folder in Settings).', kind: 'err', ttl: 5000 });
    return;
  }
  const ok = await showConfirm({
    title:   t('images_organize_btn') || 'Organize into folders',
    body:    (t('images_organize_confirm') || 'Move {n} photo(s) into "{pattern}" under {root}?')
               .replace('{n}', files.length).replace('{pattern}', pattern).replace('{root}', root),
    okLabel: t('images_organize_btn') || 'Organize'
  });
  if (!ok) return;
  const btn = document.getElementById('img-organize-btn');
  btn.classList.add('btn-loading'); btn.disabled = true;
  appendLog('img-log', `Organizing ${files.length} photo(s) → ${root} / ${pattern}…`, 'info');
  try {
    const r = await window.api.images.organize({ files: files.map(f => f.path), root, pattern, copy: false });
    if (!r.ok) {
      appendLog('img-log', `✗ ${r.error}`, 'error');
      showToast({ title: t('images_op_err_title') || 'Image op failed', body: `organize: ${r.error}`, kind: 'err', ttl: 6000 });
      return;
    }
    // Persist pattern/root as the defaults for next time.
    config.image_library_pattern = pattern;
    if (rootInput) config.image_library_root = root;
    window.api.config.save(config);
    // Moved files no longer live at their old paths — drop them from the list.
    const movedFrom = new Set((r.results || []).map(x => x.from));
    imgFiles = imgFiles.filter(f => !movedFrom.has(f.path));
    imgBulkSelected.clear();
    renderImageList();
    (r.errors || []).slice(0, 5).forEach(e => appendLog('img-log', `  ${e}`, 'error'));
    appendLog('img-log', `✓ moved ${r.moved}/${files.length}`, r.moved ? 'ok' : 'error');
    showToast({
      title: t('images_organize_done_title') || 'Photos organized',
      body:  (t('images_organize_done_body') || '{n} photo(s) moved.').replace('{n}', r.moved),
      kind:  (r.errors && r.errors.length) ? 'warn' : 'ok', ttl: 5000,
      // Files land across {year}/{month} subfolders, so reveal the destination
      // ROOT — from there the user can browse the organized tree.
      actions: r.moved ? [{
        icon: 'folder-open', title: t('toast_open_folder') || 'Open folder',
        onClick: (close) => { window.api.shell.openPath(root); close(); }
      }] : null
    });
  } catch (e) {
    appendLog('img-log', `✗ ${e.message}`, 'error');
    showToast({ title: t('images_op_err_title') || 'Image op failed', body: `organize: ${e.message}`, kind: 'err', ttl: 6000 });
  } finally {
    btn.classList.remove('btn-loading'); btn.disabled = false;
  }
}

// Automatic image organize after a download lands an image. Gated by
// config.image_library_enabled (re-checked main-side); no-op for non-images.
function autoOrganizeImage(filePath, logId, trackerEntryId) {
  if (!filePath || !config.image_library_enabled || !isImage(filePath)) return;
  window.api.images.organizeAuto({ filePath }).then(r => {
    if (r?.moved && r.path) {
      if (logId) appendLog(logId, `📁 Image organized → ${r.path}`, 'ok');
      if (trackerEntryId) updateDownloadEntry(trackerEntryId, { path: r.path });
    }
  }).catch(() => {});
}

async function runImageTimelapse() {
  if (imgFiles.length < 2) {
    const msg = 'timelapse: need at least 2 images';
    appendLog('img-log', `✗ ${msg}`, 'error');
    showToast({ title: t('images_op_err_title') || 'Image op failed', body: msg, kind: 'err', ttl: 5000 });
    return;
  }
  const fps = parseInt(document.getElementById('img-timelapse-fps').value, 10) || 24;
  const format = document.getElementById('img-timelapse-format').value || 'mp4';
  const files = selectedImageFiles();
  appendLog('img-log', `Building ${format} timelapse at ${fps} fps from ${files.length} image(s)…`, 'info');
  const btn = document.getElementById('img-timelapse-btn');
  btn.classList.add('btn-loading'); btn.disabled = true;
  try {
    const r = await window.api.images.toVideo({ files, fps, format });
    if (r.ok) {
      appendLog('img-log', `✓ ${r.path}`, 'ok');
      showToast({ title: t('images_timelapse_done_title') || 'Timelapse saved', body: r.path, kind: 'ok', ttl: 6000, actions: fileToastActions(r.path) });
    } else {
      appendLog('img-log', `✗ ${r.error}`, 'error');
      showToast({ title: t('images_op_err_title') || 'Image op failed', body: `timelapse: ${r.error}`, kind: 'err', ttl: 6000 });
    }
  } catch (e) {
    appendLog('img-log', `✗ ${e.message}`, 'error');
    showToast({ title: t('images_op_err_title') || 'Image op failed', body: `timelapse: ${e.message}`, kind: 'err', ttl: 6000 });
  } finally {
    btn.classList.remove('btn-loading'); btn.disabled = false;
  }
}

// Combine all loaded (or selected) images into a single PDF, one image per
// page. Output lands in the download folder as `images-N-<timestamp>.pdf`.
// Implemented in main via offscreen Chromium printToPDF — no extra deps.
async function runImageToPdf() {
  if (!imgFiles.length) return;
  const files = selectedImageFiles();
  if (!files.length) {
    showToast({ title: t('images_op_err_title') || 'Image op failed', body: 'No images selected', kind: 'err', ttl: 4000 });
    return;
  }
  appendLog('img-log', `Building PDF from ${files.length} image(s)…`, 'info');
  const btn = document.getElementById('img-pdf-btn');
  btn.classList.add('btn-loading'); btn.disabled = true;
  try {
    // selectedImageFiles() returns the imgFiles entries (objects with .path
    // / .name / etc.). The main-side handler expects bare path strings.
    const r = await window.api.convert.imagesToPdf({ files: files.map(f => f.path || f) });
    if (r.ok) {
      appendLog('img-log', `✓ ${r.path}`, 'ok');
      showToast({ title: t('images_pdf_done_title') || 'PDF saved', body: r.path, kind: 'ok', ttl: 6000, actions: fileToastActions(r.path) });
    } else {
      appendLog('img-log', `✗ ${r.error}`, 'error');
      showToast({ title: t('images_op_err_title') || 'Image op failed', body: `pdf: ${r.error}`, kind: 'err', ttl: 6000 });
    }
  } catch (e) {
    appendLog('img-log', `✗ ${e.message}`, 'error');
    showToast({ title: t('images_op_err_title') || 'Image op failed', body: `pdf: ${e.message}`, kind: 'err', ttl: 6000 });
  } finally {
    btn.classList.remove('btn-loading'); btn.disabled = false;
  }
}

// ─── XTRACT > Image > Annotate (Fabric.js) ──────────────────────────────────
// Canvas-based overlay editor. Mounts on top of the loaded XTRACT image,
// lets the user add rectangles, text, free-draw strokes; an eyedropper
// samples colours straight off the underlying image. Save flattens the
// canvas (image + objects) into a single PNG via convert:saveAnnotated.
//
// Lazy-imports fabric.min.mjs on first use — ~290 KB cost only when the
// feature is actually opened, not on every renderer boot.

let _fabricLib = null;
let annotateState = null;   // { canvas, tool, bgImage, filePath, baseName }

async function ensureFabric() {
  if (_fabricLib) return _fabricLib;
  const mod = await import('./vendor/fabric.min.mjs');
  _fabricLib = mod;
  return mod;
}

function bindImageAnnotate() {
  const toolbar = document.getElementById('annotate-toolbar');
  if (!toolbar) return;
  toolbar.querySelectorAll('.annotate-tool-btn').forEach(btn => {
    btn.addEventListener('click', () => setAnnotateTool(btn.dataset.tool));
  });
  document.getElementById('annotate-color')?.addEventListener('input', applyAnnotateStyleToSelection);
  document.getElementById('annotate-size')?.addEventListener('input', applyAnnotateStyleToSelection);
  document.getElementById('annotate-delete')?.addEventListener('click', deleteAnnotateSelection);
  document.getElementById('annotate-clear')?.addEventListener('click', clearAnnotateCanvas);
  document.getElementById('annotate-save')?.addEventListener('click', saveAnnotateCanvas);
}

// Called from ensureImageEditor after a file is loaded. Mounts/replaces the
// fabric canvas with the new image as background. Async because we lazy-load
// the library on first call.
async function mountAnnotateCanvas(filePath) {
  const stage    = document.getElementById('annotate-stage');
  const canvasEl = document.getElementById('annotate-canvas');
  if (!stage || !canvasEl) return;
  // Discard any previous fabric instance — we rebuild from scratch per file
  // to avoid background-image state from a previous load leaking through.
  if (annotateState?.canvas) {
    try { annotateState.canvas.dispose(); } catch {}
    annotateState = null;
  }
  let fabric;
  try { fabric = await ensureFabric(); }
  catch (e) {
    appendLog('xtract-log', `✗ Annotate library failed to load: ${e.message}`, 'error');
    return;
  }
  // Load the image off-DOM to get natural dims, then size the fabric canvas
  // to fit a comfortable max (1200×800) while preserving aspect ratio.
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload  = () => resolve(i);
    i.onerror = () => reject(new Error('image load failed'));
    i.src = localFileURL(filePath);
  }).catch(() => null);
  if (!img) return;
  const MAX_W = 1200, MAX_H = 800;
  const scale = Math.min(1, MAX_W / img.naturalWidth, MAX_H / img.naturalHeight);
  const w = Math.round(img.naturalWidth  * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = new fabric.Canvas(canvasEl, {
    width: w, height: h,
    backgroundColor: '#1a1a1a',
    selection: true
  });
  // v6+: the free-draw brush has to be instantiated explicitly. Without
  // this, setting isDrawingMode=true has no effect because there's no
  // brush to actually render the strokes.
  canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
  canvas.freeDrawingBrush.color = document.getElementById('annotate-color')?.value || '#ffffff';
  canvas.freeDrawingBrush.width = Math.max(1, parseInt(document.getElementById('annotate-size')?.value, 10) / 4) || 4;
  // Set the image as backgroundImage (non-editable, no controls). fabric v6
  // wants a fabric.FabricImage instance and the canvas.set('backgroundImage')
  // setter — older snippets using setBackgroundImage are deprecated.
  const fImg = new fabric.FabricImage(img, {
    selectable: false, evented: false,
    originX: 'left', originY: 'top',
    scaleX: scale, scaleY: scale
  });
  canvas.backgroundImage = fImg;
  canvas.requestRenderAll();
  const baseName = filePath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  annotateState = { canvas, tool: 'select', bgImage: fImg, filePath, baseName };
  // Selection events drive the delete button + property-panel sync.
  canvas.on('selection:created', updateAnnotateSelectionUI);
  canvas.on('selection:updated', updateAnnotateSelectionUI);
  canvas.on('selection:cleared', updateAnnotateSelectionUI);
  canvas.on('mouse:down', onAnnotateMouseDown);
  setAnnotateTool('select');
  document.getElementById('annotate-save').disabled  = false;
  document.getElementById('annotate-clear').disabled = false;
}

function unmountAnnotateCanvas() {
  if (annotateState?.canvas) {
    try { annotateState.canvas.dispose(); } catch {}
  }
  annotateState = null;
  document.body.classList.remove('annotate-pipette-active');
  // fabric.dispose() removes the upper-canvas wrapper but leaves the bare
  // <canvas> at its previous width/height — the annotate-stage with
  // overflow:auto would then keep a ghost scrollable region the size of
  // the last image. Reset to 0×0 so the stage collapses to nothing.
  const canvasEl = document.getElementById('annotate-canvas');
  if (canvasEl) {
    try {
      const ctx = canvasEl.getContext('2d');
      ctx?.clearRect(0, 0, canvasEl.width, canvasEl.height);
    } catch {}
    canvasEl.width  = 0;
    canvasEl.height = 0;
    canvasEl.removeAttribute('style');  // fabric writes inline styles we must shed too
  }
  const saveBtn = document.getElementById('annotate-save');
  const clearBtn = document.getElementById('annotate-clear');
  const delBtn = document.getElementById('annotate-delete');
  if (saveBtn)  saveBtn.disabled  = true;
  if (clearBtn) clearBtn.disabled = true;
  if (delBtn)   delBtn.disabled   = true;
}

function setAnnotateTool(tool) {
  if (!annotateState) return;
  annotateState.tool = tool;
  document.querySelectorAll('.annotate-tool-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === tool));
  const c = annotateState.canvas;
  c.isDrawingMode = (tool === 'draw');
  if (c.isDrawingMode && c.freeDrawingBrush) {
    c.freeDrawingBrush.color = document.getElementById('annotate-color').value;
    c.freeDrawingBrush.width = parseInt(document.getElementById('annotate-size').value, 10) || 4;
  }
  // Pipette toggles a body class for the crosshair cursor. The single-shot
  // sample fires on the next mouse:down (see onAnnotateMouseDown).
  document.body.classList.toggle('annotate-pipette-active', tool === 'pipette');
  // Selection enabled only in select tool — otherwise click-drag would
  // accidentally select a previously-placed object instead of drawing.
  c.selection = (tool === 'select');
  c.skipTargetFind = (tool !== 'select' && tool !== 'pipette');
}

async function onAnnotateMouseDown(opt) {
  if (!annotateState) return;
  const fabric = _fabricLib;
  const c = annotateState.canvas;
  const tool = annotateState.tool;
  const pt = c.getViewportPoint ? c.getViewportPoint(opt.e) : c.getPointer(opt.e);
  const color = document.getElementById('annotate-color').value;
  const size  = parseInt(document.getElementById('annotate-size').value, 10) || 20;
  if (tool === 'rect') {
    const rect = new fabric.Rect({
      left: pt.x, top: pt.y, width: 1, height: 1,
      fill: color, strokeWidth: 0
    });
    c.add(rect);
    // Start a "drag-to-size" gesture for the new rect.
    c.setActiveObject(rect);
    const startX = pt.x, startY = pt.y;
    const onMove = (ev) => {
      const p = c.getViewportPoint ? c.getViewportPoint(ev.e) : c.getPointer(ev.e);
      rect.set({
        left: Math.min(startX, p.x),
        top:  Math.min(startY, p.y),
        width:  Math.max(1, Math.abs(p.x - startX)),
        height: Math.max(1, Math.abs(p.y - startY))
      });
      c.requestRenderAll();
    };
    const onUp = () => {
      c.off('mouse:move', onMove);
      c.off('mouse:up', onUp);
      setAnnotateTool('select');
    };
    c.on('mouse:move', onMove);
    c.on('mouse:up', onUp);
  } else if (tool === 'text') {
    const text = new fabric.IText('Text', {
      left: pt.x, top: pt.y,
      fontSize: size,
      fill: color,
      fontFamily: 'Roboto, sans-serif'
    });
    c.add(text);
    c.setActiveObject(text);
    text.enterEditing();
    text.selectAll();
    setAnnotateTool('select');
  } else if (tool === 'pipette') {
    // Sample the pixel under the cursor from the underlying canvas. We grab
    // it off the fabric lowerCanvas directly via getImageData.
    const lc = c.lowerCanvasEl;
    const rect = lc.getBoundingClientRect();
    const x = Math.round((opt.e.clientX - rect.left) * (lc.width  / rect.width));
    const y = Math.round((opt.e.clientY - rect.top)  * (lc.height / rect.height));
    try {
      const px = lc.getContext('2d').getImageData(x, y, 1, 1).data;
      const hex = '#' + [px[0], px[1], px[2]].map(v => v.toString(16).padStart(2, '0')).join('');
      document.getElementById('annotate-color').value = hex;
    } catch (e) {
      console.warn('pipette failed', e);
    }
    setAnnotateTool('select');
  }
}

function updateAnnotateSelectionUI() {
  if (!annotateState) return;
  const obj = annotateState.canvas.getActiveObject();
  const delBtn = document.getElementById('annotate-delete');
  if (delBtn) delBtn.disabled = !obj;
  // Sync color + size inputs from the selected object so changing them
  // re-applies live (see applyAnnotateStyleToSelection).
  if (obj) {
    const color = obj.fill || obj.stroke;
    if (color && typeof color === 'string' && /^#/.test(color)) {
      document.getElementById('annotate-color').value = color;
    }
    if (obj.fontSize) {
      document.getElementById('annotate-size').value = obj.fontSize;
    }
  }
}

function applyAnnotateStyleToSelection() {
  if (!annotateState) return;
  const c = annotateState.canvas;
  const color = document.getElementById('annotate-color').value;
  const size  = parseInt(document.getElementById('annotate-size').value, 10) || 20;
  // Keep the free-draw brush in sync even when no object is selected.
  if (c.freeDrawingBrush) {
    c.freeDrawingBrush.color = color;
    c.freeDrawingBrush.width = Math.max(1, Math.min(60, size / 4));
  }
  const obj = c.getActiveObject();
  if (!obj) return;
  if (obj.type === 'i-text' || obj.type === 'text') {
    obj.set({ fill: color, fontSize: size });
  } else if (obj.type === 'rect') {
    obj.set({ fill: color });
  } else if (obj.type === 'path') {
    obj.set({ stroke: color, strokeWidth: size });
  } else {
    obj.set({ fill: color });
  }
  c.requestRenderAll();
}

function deleteAnnotateSelection() {
  if (!annotateState) return;
  const c = annotateState.canvas;
  const active = c.getActiveObjects();
  active.forEach(o => c.remove(o));
  c.discardActiveObject();
  c.requestRenderAll();
}

function clearAnnotateCanvas() {
  if (!annotateState) return;
  const c = annotateState.canvas;
  // Remove all overlay objects but keep the background image.
  c.getObjects().slice().forEach(o => c.remove(o));
  c.discardActiveObject();
  c.requestRenderAll();
}

async function saveAnnotateCanvas() {
  if (!annotateState) return;
  const btn = document.getElementById('annotate-save');
  btn.classList.add('btn-loading'); btn.disabled = true;
  try {
    const c = annotateState.canvas;
    // Render at 1× canvas scale — fabric internally renders the background
    // image at the scaled-down preview size, so this matches what the user
    // sees. (Saving at the original image's natural resolution would require
    // a re-render at scale 1/scale which fabric supports via multiplier, but
    // text sizes set in canvas pixels would then look wrong.)
    const dataUrl = c.toDataURL({ format: 'png', multiplier: 1 });
    const r = await window.api.convert.saveAnnotated({ dataUrl, baseName: annotateState.baseName });
    if (!r.ok) throw new Error(r.error);
    showToast({ title: t('xtract_image_annotate_done_title') || 'Annotated image saved', body: r.path, kind: 'ok', ttl: 6000, actions: fileToastActions(r.path) });
    appendLog('xtract-log', `✓ Saved: ${r.path}`, 'ok');
  } catch (e) {
    showToast({ title: t('images_op_err_title') || 'Image op failed', body: `annotate: ${e.message}`, kind: 'err', ttl: 6000 });
    appendLog('xtract-log', `✗ Annotate save: ${e.message}`, 'error');
  } finally {
    btn.classList.remove('btn-loading'); btn.disabled = false;
  }
}

// Side-by-side compare (XTRACT > Image). Pure visual — picks a second
// image, lets user drag the divider/slider to reveal "A" or "B".
let imgComparePathB = null;

function bindImageCompareControls() {
  const pick   = document.getElementById('img-compare-pick');
  const reset  = document.getElementById('img-compare-reset');
  const swap   = document.getElementById('img-compare-swap');
  const slider = document.getElementById('img-compare-slider');
  const stage  = document.getElementById('img-compare-stage');
  const imgA   = document.getElementById('img-compare-a');
  const imgB   = document.getElementById('img-compare-b');
  const info   = document.getElementById('img-compare-info');
  if (!pick || !slider) return;

  const refresh = () => {
    if (!xtractInput || !imgComparePathB) {
      stage.classList.add('hidden');
      reset.classList.add('hidden'); swap.classList.add('hidden'); slider.classList.add('hidden');
      reset.disabled = true; swap.disabled = true; slider.disabled = true;
      info.style.display = 'none';
      return;
    }
    imgA.src = localFileURL(xtractInput);
    imgB.src = localFileURL(imgComparePathB);
    // Reset label text to canonical A/B (user may have swapped before
    // picking a new B — the label state would otherwise carry over).
    const labelA = document.querySelector('.img-compare-label-a');
    const labelB = document.querySelector('.img-compare-label-b');
    if (labelA) labelA.textContent = 'A';
    if (labelB) labelB.textContent = 'B';
    stage.classList.remove('hidden');
    reset.classList.remove('hidden'); swap.classList.remove('hidden'); slider.classList.remove('hidden');
    reset.disabled = false; swap.disabled = false; slider.disabled = false;
    info.style.display = '';
    info.textContent = imgComparePathB.split(/[\\/]/).pop();
    // Apply current slider value to the clip + divider position.
    const pct = parseFloat(slider.value);
    stage.style.setProperty('--split', pct + '%');
  };
  refresh();

  pick.addEventListener('click', async () => {
    const r = await window.api.dialog.pickFile({
      filters: [
        { name: 'Images', extensions: IMAGE_PICK_EXTS },
        { name: 'All', extensions: ['*'] }
      ]
    });
    if (!r) return;
    imgComparePathB = r;
    refresh();
  });
  reset.addEventListener('click', () => { imgComparePathB = null; refresh(); });
  swap.addEventListener('click', () => {
    // Swap A/B visually by exchanging both <img> sources AND the textual
    // labels so the user sees consistent A/B markers — what's on the left
    // half of the slider should always be labelled the same as the bigger
    // visible portion. xtractInput stays put (it's shared with the crop
    // card upstream); only the compare layer assignments swap.
    if (!imgComparePathB || !xtractInput) return;
    const tmp = imgA.src;
    imgA.src = imgB.src;
    imgB.src = tmp;
    const labelA = document.querySelector('.img-compare-label-a');
    const labelB = document.querySelector('.img-compare-label-b');
    if (labelA && labelB) {
      const aText = labelA.textContent;
      labelA.textContent = labelB.textContent;
      labelB.textContent = aText;
    }
  });
  slider.addEventListener('input', () => {
    stage.style.setProperty('--split', slider.value + '%');
  });
}

// ─── XTRACT CAPTURE / RECORD ────────────────────────────────────────────────
// Screenshot (image view), microphone recording (audio view), screen recording
// (video view). Triggered from #xtract-capture-btn. All paths converge on
// `loadCapturedFile(path)` which seeds xtractInput and mounts the right editor
// — same code path as picking a file from disk.

let captureState = {
  mode: null,           // 'screenshot' | 'audio' | 'screen'
  sourceId: null,       // chrome desktop source id (screen/window)
  stream: null,         // active MediaStream (mic / screen)
  recorder: null,       // active MediaRecorder
  chunks: [],           // recorded blobs
  timerInterval: null,  // setInterval id for the clock
  startedAt: 0,
  // Pause tracking — MediaRecorder.pause() freezes the data stream, we also
  // freeze the on-screen timer. pausedAt holds the timestamp when the current
  // pause began (0 if not paused); pausedDuration accumulates total ms paused
  // across multiple pause/resume cycles so the timer reads true recorded time.
  pausedAt: 0,
  pausedDuration: 0
};

// Format presets per capture mode. Drives the "Save as" dropdown — values map
// 1:1 to the ffmpeg convert path on the main side.
const CAPTURE_FORMATS = {
  screenshot: [['png', 'PNG'], ['jpg', 'JPG']],
  audio:      [['mp3', 'MP3'], ['m4a', 'M4A (AAC)'], ['webm', 'WebM (raw)']],
  screen:     [['mp4', 'MP4 (H.264)'], ['webm', 'WebM (raw)']]
};

function bindXtractCapture() {
  const btn = document.getElementById('xtract-capture-btn');
  if (!btn) return;
  btn.addEventListener('click', () => openCaptureModal(xtractCurrentView));
  document.getElementById('capture-cancel-btn')?.addEventListener('click', closeCaptureModal);
  document.getElementById('capture-save-btn')?.addEventListener('click', () => saveCapture());
  document.getElementById('capture-rec-btn')?.addEventListener('click', toggleCaptureRecording);
  document.getElementById('capture-pause-btn')?.addEventListener('click', toggleCapturePause);
  document.getElementById('capture-url-go')?.addEventListener('click', captureFromUrl);
  document.getElementById('capture-url-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') captureFromUrl();
  });
  // Live mic toggle — mid-recording the user can flip the switch and the
  // mic stream is added/removed on the fly. MediaRecorder can DROP tracks
  // mid-flight (track removal stops being captured immediately) but NOT
  // pick up newly-added tracks — Chromium quirk. So toggling OFF works
  // perfectly; toggling ON only takes effect on the next take, and we
  // warn the user once via toast when that happens.
  document.getElementById('capture-mic-toggle')?.addEventListener('change', onMicToggleChange);
  // Esc + outside-click already handled by bindGlobalKeys.
  document.getElementById('xtract-capture-modal')?.addEventListener('click', e => {
    // If the modal is dismissed while a recording is active, tear down the
    // stream to avoid the OS keeping the screen/mic indicator on.
    if (e.target.id === 'xtract-capture-modal') stopCaptureStream();
  });
}

// Update the capture button's label + icon to match the active sub-view. Call
// this from setXtractView() so the affordance always matches what the button
// will actually do.
function refreshCaptureButton() {
  const btn   = document.getElementById('xtract-capture-btn');
  const label = document.getElementById('xtract-capture-label');
  if (!btn || !label) return;
  const map = {
    audio: { icon: 'mic',     i18n: 'xtract_capture_record_audio',  fallback: 'Record audio' },
    video: { icon: 'monitor', i18n: 'xtract_capture_record_screen', fallback: 'Record screen' },
    image: { icon: 'camera',  i18n: 'xtract_capture_screenshot',    fallback: 'Screenshot' }
  };
  const cfg = map[xtractCurrentView] || map.image;
  btn.setAttribute('data-lucide-icon', cfg.icon);
  btn.setAttribute('data-i18n-title', cfg.i18n);
  btn.title = t(cfg.i18n) || cfg.fallback;
  label.setAttribute('data-i18n', cfg.i18n);
  label.textContent = t(cfg.i18n) || cfg.fallback;
  applyLucideIcons(btn);
}

// Map raw browser getUserMedia errors to user-actionable hints. The browser
// strings ("NotReadableError: Could not start audio source") aren't wrong
// but tell the user nothing about WHY or what to fix.
function micErrorHint(err) {
  const name = err?.name || '';
  const msg  = err?.message || '';
  if (name === 'NotAllowedError' || /permission/i.test(msg)) {
    return 'Microphone permission denied. macOS: System Settings → Privacy & Security → Microphone. Windows: Settings → Privacy → Microphone → "Let desktop apps access".';
  }
  if (name === 'NotFoundError' || /no audio source|requested device/i.test(msg)) {
    return 'No microphone found. Plug one in or pick a default in your OS sound settings.';
  }
  if (name === 'NotReadableError' || /could not start|hardware|in use/i.test(msg)) {
    return 'Microphone is busy or unreachable. Close other apps that may be using it (Teams, Discord, OBS, browser tabs), then try again.';
  }
  if (name === 'OverconstrainedError') {
    return 'The default microphone does not meet the requested constraints. Try a different input device.';
  }
  return msg || 'Microphone unavailable.';
}

async function openCaptureModal(view) {
  const modal = document.getElementById('xtract-capture-modal');
  if (!modal) return;
  // Reset internal state from any previous session.
  stopCaptureStream();
  captureState.chunks = [];
  captureState.sourceId = null;
  // Decide mode + which stage shows first.
  const mode = view === 'image' ? 'screenshot' : view === 'audio' ? 'audio' : 'screen';
  captureState.mode = mode;
  // Title + format dropdown
  const title = document.getElementById('xtract-capture-title');
  const titleKey = mode === 'screenshot' ? 'xtract_capture_title_screenshot'
                 : mode === 'audio'      ? 'xtract_capture_title_audio'
                 :                         'xtract_capture_title_screen';
  title.setAttribute('data-i18n', titleKey);
  title.textContent = t(titleKey) || (mode === 'screenshot' ? 'Take screenshot' : mode === 'audio' ? 'Record audio' : 'Record screen');
  const fmt = document.getElementById('capture-format');
  fmt.innerHTML = '';
  for (const [val, lbl] of CAPTURE_FORMATS[mode]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = lbl;
    fmt.appendChild(opt);
  }
  // Toggle stages. Screenshot + screen-record start at source picker; audio
  // skips it (no source, just the mic).
  const stageSources = document.getElementById('capture-stage-sources');
  const stageRecord  = document.getElementById('capture-stage-record');
  const micRow       = document.getElementById('capture-mic-row');
  const preview      = document.getElementById('capture-preview');
  const recBtn       = document.getElementById('capture-rec-btn');
  const recLabel     = document.getElementById('capture-rec-label');
  const saveBtn      = document.getElementById('capture-save-btn');
  recBtn.classList.remove('recording');
  recLabel.textContent = t('xtract_capture_rec') || 'Start';
  recBtn.disabled = false;
  saveBtn.disabled = true;
  document.getElementById('capture-timer').textContent = '00:00';
  // Reset Pause button: hidden until a take starts; icon back to "pause".
  const pauseBtn = document.getElementById('capture-pause-btn');
  pauseBtn.classList.add('hidden');
  pauseBtn.setAttribute('data-lucide-icon', 'pause');
  document.getElementById('capture-pause-label').textContent = t('xtract_capture_pause') || 'Pause';
  applyLucideIcons(pauseBtn);
  if (mode === 'audio') {
    stageSources.classList.add('hidden');
    stageRecord.classList.remove('hidden');
    preview.classList.add('hidden');
    micRow.hidden = true;  // audio recording IS the mic — no toggle needed
  } else {
    stageSources.classList.remove('hidden');
    stageRecord.classList.add('hidden');
    preview.classList.remove('hidden');
    micRow.hidden = (mode === 'screenshot');  // mic only relevant for screen-record
  }
  // URL capture is image-mode only — recording a live webpage as a video
  // would be a different feature (and getUserMedia already covers screen
  // recording via a Chromium tab anyway, if the user really wants it).
  const urlRow = document.getElementById('capture-url-row');
  if (urlRow) urlRow.classList.toggle('hidden', mode !== 'screenshot');
  modal.classList.remove('hidden');
  applyLucideIcons(modal);
  // For audio mode, request mic immediately so the user just hits Start.
  if (mode === 'audio') {
    try {
      captureState.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      // Wrap the raw browser error with actionable advice — the bare
      // "NotReadableError: Could not start audio source" tells the user
      // nothing about how to fix it.
      const hint = micErrorHint(e);
      showToast({ title: t('xtract_capture_err_title') || 'Capture failed', body: hint, kind: 'err', ttl: 9000 });
      closeCaptureModal();
    }
    return;
  }
  // For screenshot / screen-record, enumerate sources.
  await populateCaptureSources(mode === 'screenshot' ? ['screen', 'window'] : ['screen', 'window']);
}

// Capture a URL via offscreen Chromium → PNG / JPG / PDF in the download
// folder, then jump straight to the post-save flow (open in Image Editor for
// raster outputs; PDFs just toast the path with the standard open-file /
// open-folder actions).
async function captureFromUrl() {
  const urlEl  = document.getElementById('capture-url-input');
  const fmtEl  = document.getElementById('capture-url-format');
  const goBtn  = document.getElementById('capture-url-go');
  const url    = (urlEl?.value || '').trim();
  if (!url) {
    showToast({ title: t('xtract_capture_err_title') || 'Capture failed', body: 'Enter a URL', kind: 'err', ttl: 4000 });
    return;
  }
  const format = fmtEl?.value || 'png';
  goBtn.classList.add('btn-loading');
  goBtn.disabled = true;
  try {
    const r = await window.api.convert.fromUrl({ url, format });
    if (!r.ok) throw new Error(r.error);
    showToast({ title: t('xtract_capture_ok_title') || 'Capture saved', body: r.path, kind: 'ok', ttl: 6000, actions: fileToastActions(r.path) });
    closeCaptureModal();
    // Raster outputs go straight into the Image Editor; PDFs aren't editable
    // in the crop/fx pipeline so they're just announced via the toast above.
    if (format !== 'pdf') await loadCapturedFile(r.path);
  } catch (e) {
    showToast({ title: t('xtract_capture_err_title') || 'Capture failed', body: e.message, kind: 'err', ttl: 6000 });
  } finally {
    goBtn.classList.remove('btn-loading');
    goBtn.disabled = false;
  }
}

async function populateCaptureSources(types) {
  const grid  = document.getElementById('capture-source-grid');
  const empty = document.getElementById('capture-sources-empty');
  grid.innerHTML = '';
  empty.classList.remove('hidden');
  empty.textContent = t('xtract_capture_loading') || 'Loading sources…';
  const r = await window.api.capture.listSources({ types });
  if (!r.ok || !r.sources?.length) {
    empty.textContent = r.error || (t('xtract_capture_no_sources') || 'No sources available');
    return;
  }
  empty.classList.add('hidden');
  for (const s of r.sources) {
    const card = document.createElement('div');
    card.className = 'capture-source-card';
    card.dataset.id = s.id;
    card.innerHTML = `<img alt="" /><span class="capture-source-name"></span>`;
    card.querySelector('img').src = s.thumbnail || '';
    card.querySelector('.capture-source-name').textContent = s.name;
    card.addEventListener('click', () => selectCaptureSource(s.id, card));
    grid.appendChild(card);
  }
}

async function selectCaptureSource(sourceId, cardEl) {
  document.querySelectorAll('.capture-source-card').forEach(c => c.classList.remove('active'));
  cardEl?.classList.add('active');
  captureState.sourceId = sourceId;
  // Open the live stream so we can preview + (for screenshot) snap the frame.
  try {
    stopCaptureStream();  // drop any previous stream first
    const constraints = {
      audio: false,  // screen-record audio is added later via getUserMedia({ audio: true })
      video: {
        mandatory: {
          chromeMediaSource:    'desktop',
          chromeMediaSourceId:  sourceId,
          maxWidth:  1920,
          maxHeight: 1080
        }
      }
    };
    captureState.stream = await navigator.mediaDevices.getUserMedia(constraints);
    const preview = document.getElementById('capture-preview');
    preview.srcObject = captureState.stream;
    await preview.play().catch(() => {});
    // Move to recorder stage. For screenshot mode the "Save" button is enabled
    // immediately since one frame is all we need.
    document.getElementById('capture-stage-sources').classList.add('hidden');
    document.getElementById('capture-stage-record').classList.remove('hidden');
    if (captureState.mode === 'screenshot') {
      // Hide the REC button — screenshot doesn't need a duration.
      document.getElementById('capture-rec-btn').classList.add('hidden');
      document.getElementById('capture-timer').classList.add('hidden');
      document.getElementById('capture-mic-row').hidden = true;
      document.getElementById('capture-save-btn').disabled = false;
    } else {
      document.getElementById('capture-rec-btn').classList.remove('hidden');
      document.getElementById('capture-timer').classList.remove('hidden');
    }
  } catch (e) {
    showToast({ title: t('xtract_capture_err_title') || 'Capture failed', body: e.message, kind: 'err', ttl: 6000 });
  }
}

// The mic toggle is HIDDEN while a recording is in flight (see
// toggleCaptureRecording's start/stop branches). Mid-recording track
// surgery (remove audio tracks) ended up tearing down the whole
// MediaRecorder in Chromium edge cases — safer to lock the UI choice
// for the duration of the take and re-enable on stop. No-op handler
// kept as a safety net in case the toggle is ever re-shown.
async function onMicToggleChange() { /* hidden during recording — see toggleCaptureRecording */ }

async function toggleCaptureRecording() {
  // Audio + screen recorder use the same MediaRecorder pipeline; only the
  // input stream differs. The screen path optionally mixes in the microphone.
  // Stop must trigger from BOTH 'recording' AND 'paused' states — the only
  // state where Start should fire instead is 'inactive'. Previously this
  // checked === 'recording' and clicking Stop while paused fell through to
  // the "start a new take" path, restarting the timer from zero.
  if (captureState.recorder && captureState.recorder.state !== 'inactive') {
    captureState.recorder.stop();
    return;
  }
  let stream = captureState.stream;
  if (!stream) {
    showToast({ title: t('xtract_capture_err_title') || 'Capture failed', body: 'No active stream', kind: 'err', ttl: 5000 });
    return;
  }
  // For screen recording: first strip ANY audio tracks left over from a prior
  // take (the stream is reused across REC start/stop cycles, so a mic track
  // added on take #1 would otherwise persist into take #2 even if the user
  // unchecks "Include microphone" in between). Audio mode is untouched —
  // there the only audio source IS the mic, kept across takes intentionally.
  if (captureState.mode === 'screen') {
    const micChecked = !!document.getElementById('capture-mic-toggle')?.checked;
    const preCount = stream.getAudioTracks().length;
    stream.getAudioTracks().forEach(track => {
      stream.removeTrack(track);
      try { track.stop(); } catch {}
    });
    if (preCount) appendLog('xtract-log', `Screen rec: stripped ${preCount} pre-existing audio track(s)`, 'info');
    if (micChecked) {
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStream.getAudioTracks().forEach(track => stream.addTrack(track));
        appendLog('xtract-log', `Screen rec: mic ON — added ${micStream.getAudioTracks().length} mic track(s)`, 'info');
      } catch (e) {
        // Soft-fail: continue without mic rather than aborting the whole take.
        showToast({ title: t('xtract_capture_err_title') || 'Capture failed', body: 'Mic unavailable, recording without it', kind: 'warn', ttl: 4000 });
      }
    } else {
      appendLog('xtract-log', `Screen rec: mic OFF — recording video only`, 'info');
    }
    // Diagnostic: log + toast the final track shape — if the recorded file
    // still contains audio when the user expected silence, this line tells us
    // exactly what the MediaRecorder saw. Visible without needing activity
    // logs enabled.
    const vCount = stream.getVideoTracks().length;
    const aCount = stream.getAudioTracks().length;
    appendLog('xtract-log', `Screen rec stream: ${vCount}v + ${aCount}a track(s)`, 'info');
    showToast({
      title: 'Recording',
      body: `${vCount} video + ${aCount} audio track(s) — mic ${micChecked ? 'ON' : 'OFF'}`,
      kind: aCount > 0 && !micChecked ? 'warn' : 'ok',
      ttl: 4000
    });
  }
  captureState.chunks = [];
  captureState.pausedAt = 0;
  captureState.pausedDuration = 0;
  // Prefer codecs the player can handle: WebM/Opus for audio, WebM/VP9+Opus for screen.
  const mime = captureState.mode === 'audio'
    ? (MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm')
    : (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm');
  const rec = new MediaRecorder(stream, { mimeType: mime });
  rec.ondataavailable = e => { if (e.data && e.data.size > 0) captureState.chunks.push(e.data); };
  rec.onstop = () => {
    stopCaptureTimer();
    document.getElementById('capture-rec-btn').classList.remove('recording');
    document.getElementById('capture-rec-label').textContent = t('xtract_capture_rec') || 'Start';
    document.getElementById('capture-save-btn').disabled = captureState.chunks.length === 0;
    // Restore the mic toggle now that the take is done — only for screen
    // mode (audio mode keeps it hidden by design).
    const micRow = document.getElementById('capture-mic-row');
    if (micRow && captureState.mode === 'screen') micRow.hidden = false;
    // Hide pause once recording ends — there's nothing left to pause.
    const pauseBtn = document.getElementById('capture-pause-btn');
    if (pauseBtn) {
      pauseBtn.classList.add('hidden');
      pauseBtn.setAttribute('data-lucide-icon', 'pause');
      document.getElementById('capture-pause-label').textContent = t('xtract_capture_pause') || 'Pause';
      applyLucideIcons(pauseBtn);
    }
  };
  captureState.recorder = rec;
  rec.start(250);  // emit chunks every 250ms so a sudden stop doesn't lose tail audio
  captureState.startedAt = Date.now();
  startCaptureTimer();
  document.getElementById('capture-rec-btn').classList.add('recording');
  document.getElementById('capture-rec-label').textContent = t('xtract_capture_stop') || 'Stop';
  document.getElementById('capture-save-btn').disabled = true;
  // Show the Pause button now that a take is in progress.
  document.getElementById('capture-pause-btn')?.classList.remove('hidden');
  // Hide the mic toggle for the duration of the take — mid-recording track
  // surgery had edge cases (whole MediaRecorder tearing down). Restored on
  // rec.onstop below.
  const micRow = document.getElementById('capture-mic-row');
  if (micRow) micRow.hidden = true;
}

function startCaptureTimer() {
  stopCaptureTimer();
  const el = document.getElementById('capture-timer');
  captureState.timerInterval = setInterval(() => {
    // When paused, freeze at the pause moment instead of advancing.
    const now = captureState.pausedAt || Date.now();
    const s = Math.floor((now - captureState.startedAt - captureState.pausedDuration) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    el.textContent = `${mm}:${ss}`;
  }, 200);
}
function stopCaptureTimer() {
  if (captureState.timerInterval) clearInterval(captureState.timerInterval);
  captureState.timerInterval = null;
}

// Pause / Resume the MediaRecorder + freeze the timer in sync. Wraps
// MediaRecorder.pause()/resume() — both are no-ops if not in 'recording' state,
// which is what we want for double-clicks. The pause button is hidden when not
// recording so this should only ever fire mid-take, but the state guards keep
// us safe either way.
function toggleCapturePause() {
  const rec = captureState.recorder;
  if (!rec) return;
  const btn   = document.getElementById('capture-pause-btn');
  const label = document.getElementById('capture-pause-label');
  if (rec.state === 'recording') {
    rec.pause();
    captureState.pausedAt = Date.now();
    btn.setAttribute('data-lucide-icon', 'play');
    label.setAttribute('data-i18n', 'xtract_capture_resume');
    label.textContent = t('xtract_capture_resume') || 'Resume';
    applyLucideIcons(btn);
  } else if (rec.state === 'paused') {
    captureState.pausedDuration += Date.now() - captureState.pausedAt;
    captureState.pausedAt = 0;
    rec.resume();
    btn.setAttribute('data-lucide-icon', 'pause');
    label.setAttribute('data-i18n', 'xtract_capture_pause');
    label.textContent = t('xtract_capture_pause') || 'Pause';
    applyLucideIcons(btn);
  }
}

async function saveCapture() {
  const saveBtn = document.getElementById('capture-save-btn');
  saveBtn.disabled = true;
  saveBtn.classList.add('btn-loading');
  const format = document.getElementById('capture-format').value;
  try {
    if (captureState.mode === 'screenshot') {
      // Snap a single frame from the preview <video> to a canvas and save.
      const video = document.getElementById('capture-preview');
      if (!video.videoWidth || !video.videoHeight) throw new Error('Stream not ready');
      const canvas = document.createElement('canvas');
      canvas.width  = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
      const dataUrl = canvas.toDataURL(mime, 0.92);
      const r = await window.api.capture.saveImage({ dataUrl, format });
      if (!r.ok) throw new Error(r.error);
      showToast({ title: t('xtract_capture_ok_title') || 'Capture saved', body: r.path, kind: 'ok', ttl: 6000, actions: fileToastActions(r.path) });
      closeCaptureModal();
      await loadCapturedFile(r.path);
    } else {
      if (!captureState.chunks.length) throw new Error('Nothing recorded');
      const blob = new Blob(captureState.chunks, { type: captureState.chunks[0].type || 'application/octet-stream' });
      const buf = await blob.arrayBuffer();
      const r = await window.api.capture.saveRecording({
        buffer: buf,
        kind:   captureState.mode === 'audio' ? 'audio' : 'video',
        convert: format
      });
      if (!r.ok) throw new Error(r.error);
      showToast({ title: t('xtract_capture_ok_title') || 'Capture saved', body: r.path, kind: 'ok', ttl: 6000, actions: fileToastActions(r.path) });
      closeCaptureModal();
      await loadCapturedFile(r.path);
    }
  } catch (e) {
    showToast({ title: t('xtract_capture_err_title') || 'Capture failed', body: e.message, kind: 'err', ttl: 6000 });
    saveBtn.disabled = false;
  } finally {
    saveBtn.classList.remove('btn-loading');
  }
}

// Push the freshly-captured file through the same path as picking a file:
// seed xtractInput, mount the appropriate editor, refresh the cards.
async function loadCapturedFile(filePath) {
  // Hard reset of any previous editor state BEFORE setting xtractInput.
  // This is the bulletproof version after a series of "new file loads
  // the previous one" bug reports — a previous editor instance lingering
  // through the swap can paint stale content because Chromium caches
  // file:// resources at multiple layers (video element decode cache,
  // WaveSurfer peaks fetch). Killing both editors synchronously means
  // the new mount always starts from a clean slate.
  destroyTrimEditor();
  destroyImageEditor();
  xtractInput = filePath;
  xtractConcatExtras = [];
  updateXtractClearButton();
  const info = document.getElementById('xtract-file-info');
  info.textContent = filePath.split(/[\\/]/).pop();
  document.getElementById('xtract-concat-info').textContent = t('xtract_concat_none');
  refreshXtractCards();
  probeXtractInputAudio(filePath);  // silent-video gate for the Split / Extract audio / Normalize cards
  refreshTrimFormatDropdown(xtractCurrentView);
  refreshGifOptionsVisibility();
  if (xtractCurrentView !== 'image') {
    window.api.xtract.probe({ input: filePath }).then(p => {
      if (xtractInput !== filePath) return;
      if (p?.ok) info.textContent = `${filePath.split(/[\\/]/).pop()}  ·  ${p.formatted}`;
    }).catch(() => {});
    ensureTrimEditor(filePath);
    destroyImageEditor();
  } else {
    destroyTrimEditor();
    ensureImageEditor(filePath);
  }
}

function stopCaptureStream() {
  if (captureState.recorder && captureState.recorder.state === 'recording') {
    try { captureState.recorder.stop(); } catch {}
  }
  captureState.recorder = null;
  if (captureState.stream) {
    captureState.stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
    captureState.stream = null;
  }
  const preview = document.getElementById('capture-preview');
  if (preview) preview.srcObject = null;
  stopCaptureTimer();
}

function closeCaptureModal() {
  stopCaptureStream();
  document.getElementById('xtract-capture-modal')?.classList.add('hidden');
  // Reset the "screenshot mode hides rec button" tweak — next open might be a recorder.
  document.getElementById('capture-rec-btn')?.classList.remove('hidden');
  document.getElementById('capture-timer')?.classList.remove('hidden');
}

async function saveAllTags() {
  if (!tagFiles.length) return;
  // Sync currently-edited form into its file's .tags before bulk save
  const cur = currentTagFile();
  if (cur) cur.tags = readFormTags();

  const writable = tagFiles.filter(f => /\.mp3$/i.test(f.path));
  if (!writable.length) {
    appendLog('tag-log', '✗ No MP3 files in list (write currently supported for MP3 only)', 'error');
    return;
  }
  appendLog('tag-log', t('tag_save_all_running', { n: writable.length }), 'info');

  let ok = 0;
  for (const f of writable) {
    const payload = { filePath: f.path, tags: f.tags };
    if (f.cover) { payload.coverBase64 = f.cover.dataBase64; payload.coverMime = f.cover.mime; }
    const r = await window.api.tag.write(payload);
    if (r.ok) ok++;
    else appendLog('tag-log', `✗ ${f.name}: ${r.error}`, 'error');
  }
  appendLog('tag-log', t('tag_save_all_done', { ok, total: writable.length }), ok === writable.length ? 'ok' : 'log');
}

function currentPattern() {
  const custom = document.getElementById('tag-pattern-custom').value.trim();
  return custom || document.getElementById('tag-pattern-preset').value;
}

// Compile an mp3tag-style pattern (%artist% - %title%) into a RegExp.
// Variables become non-greedy capture groups; the last one is greedy to soak up the tail.
function compileFilenamePattern(pattern) {
  const vars = [];
  let rx = '^';
  let lastEnd = 0;
  const re = /%(\w+)%/g;
  let m;
  while ((m = re.exec(pattern)) !== null) {
    if (m.index > lastEnd) {
      rx += pattern.slice(lastEnd, m.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    vars.push(m[1]);
    rx += '(.+?)';
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < pattern.length) {
    rx += pattern.slice(lastEnd).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  rx += '$';
  // Make the LAST capture greedy so it eats the rest
  rx = rx.replace(/\(\.\+\?\)\$$/, '(.+)$');
  return { regex: new RegExp(rx), vars };
}

function parseFilenameWithPattern(filenameNoExt, pattern) {
  const { regex, vars } = compileFilenamePattern(pattern);
  const m = filenameNoExt.match(regex);
  if (!m) return null;
  const out = {};
  vars.forEach((v, i) => { out[v] = m[i + 1].trim(); });
  return out;
}

function tagFromFilename() {
  const f = currentTagFile();
  if (!f) return;
  const noExt = f.name.replace(/\.[^.]+$/, '');
  const parsed = parseFilenameWithPattern(noExt, currentPattern());
  if (!parsed) { appendLog('tag-log', t('tag_parse_failed'), 'error'); return; }
  const fields = ['title','artist','album','albumartist','year','track','genre'];
  for (const fld of fields) {
    if (parsed[fld] != null) {
      const el = document.getElementById(`tag-${fld}`);
      if (el) el.value = parsed[fld];
    }
  }
  appendLog('tag-log', `📥 Tags populated from filename (${Object.keys(parsed).join(', ')})`, 'ok');
}

// Build a new filename from the form values + pattern. Sanitize fs-illegal chars.
function buildFilenameFromPattern(tags, pattern, ext) {
  const FS_ILLEGAL = /[\\/:*?"<>|]/g;
  let out = pattern.replace(/%(\w+)%/g, (_, name) => String(tags[name] || '').replace(FS_ILLEGAL, '_'));
  // Collapse double spaces, trim
  out = out.replace(/\s+/g, ' ').trim();
  return out + ext;
}

async function renameFromTags() {
  const f = currentTagFile();
  if (!f) return;
  const tags = readFormTags();
  const ext = (f.path.match(/\.[^.]+$/) || [''])[0];
  const dir = f.path.replace(/[/\\][^/\\]+$/, '');
  const newName = buildFilenameFromPattern(tags, currentPattern(), ext);
  // Refuse if any required placeholder produced empty
  if (/^\s*[-.\s]*$/.test(newName.replace(ext, ''))) {
    appendLog('tag-log', '✗ Pattern resolved to empty name — fill the relevant tags first', 'error');
    return;
  }
  const sep = f.path.includes('\\') ? '\\' : '/';
  const newPath = `${dir}${sep}${newName}`;
  if (newPath === f.path) { appendLog('tag-log', '(Filename already matches pattern)', 'log'); return; }
  const r = await window.api.file.rename({ oldPath: f.path, newPath });
  if (!r.ok) { appendLog('tag-log', `✗ ${r.error}`, 'error'); return; }
  f.path = r.path; f.name = newName;
  renderTagFileList();
  appendLog('tag-log', t('tag_renamed', { name: newName }), 'ok');
}

async function addTagFiles(paths) {
  const countEl = document.getElementById('tag-file-count');
  if (paths.length > 0 && countEl) countEl.classList.add('loading');
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    if (countEl) countEl.textContent = `⟳ ${t('tag_loading_files', { n: i + 1, total: paths.length })}`;
    if (tagFiles.find(f => f.path === p)) continue;
    const r = await window.api.tag.read(p);
    if (!r.ok) { appendLog('tag-log', `✗ ${p}: ${r.error}`, 'error'); continue; }
    tagFiles.push({ path: p, name: p.replace(/^.*[/\\]/, ''), ...r, mbid: null });
    if ((i & 31) === 0) renderTagFileList(); // periodic refresh during large batches
  }
  if (countEl) countEl.classList.remove('loading');
  renderTagFileList(); // final render with definitive count
  if (tagSelectedIdx < 0 && tagFiles.length) selectTagFile(0);
}

function renderTagFileList() {
  const ul = document.getElementById('tag-file-list');
  const countEl = document.getElementById('tag-file-count');
  const clearBtn = document.getElementById('tag-clear-btn');
  const saveAllBtn = document.getElementById('tag-save-all-btn');
  if (countEl && !countEl.classList.contains('loading')) {
    countEl.textContent = tagFiles.length ? `${tagFiles.length} file(s)` : '—';
  }
  if (clearBtn) clearBtn.disabled = tagFiles.length === 0;
  const syncBtn = document.getElementById('tag-sync-btn');
  if (syncBtn) syncBtn.disabled = tagFiles.length === 0;
  const dedupBtn = document.getElementById('tag-dedup-btn');
  // Dedup needs ≥2 files (it's pairwise). Enable when at least 2 loaded.
  if (dedupBtn) dedupBtn.disabled = tagFiles.length < 2;
  const hasMp3 = tagFiles.some(x => /\.mp3$/i.test(x.path));
  if (saveAllBtn) saveAllBtn.disabled = !hasMp3;
  const selectAllBtn = document.getElementById('tag-select-all-btn');
  if (selectAllBtn) selectAllBtn.disabled = !hasMp3;
  ul.innerHTML = '';
  tagFiles.forEach((f, i) => {
    const li = document.createElement('li');
    li.className = `tag-file-item${i === tagSelectedIdx ? ' active' : ''}`;
    const ext = (f.format || '').toLowerCase();
    const isMp3 = /\.mp3$/i.test(f.path);
    // Bulk-select switch — only MP3s are writable today, so non-MP3 rows
    // get a disabled switch so the column width stays uniform.
    const chk = tagBulkSelected.has(i) ? 'checked' : '';
    const disAttr = isMp3 ? '' : 'disabled';
    const hint = esc(t('tag_bulk_select_hint') || 'Select for bulk apply');
    li.innerHTML = `<label class="import-row-switch${isMp3 ? '' : ' is-disabled'}" title="${hint}">
                      <input type="checkbox" class="tag-file-check" data-idx="${i}" ${chk} ${disAttr} />
                      <span class="switch-slider"></span>
                    </label>
                    <span class="tag-file-ext">${esc(ext.substring(0, 4))}</span>
                    <span class="tag-file-name" title="${esc(f.path)}">${esc(f.name)}</span>`;
    // Click on the row (anywhere except the checkbox) selects the file for
    // single-file editing. The checkbox handler stops propagation so toggling
    // selection doesn't also switch the active file.
    li.addEventListener('click', () => selectTagFile(i));
    // Stop click propagation on the entire switch widget (label + slider +
    // input) so toggling bulk-select doesn't also flip the active file.
    const sw = li.querySelector('.import-row-switch');
    if (sw) sw.addEventListener('click', e => e.stopPropagation());
    const cb = li.querySelector('.tag-file-check');
    if (cb) {
      cb.addEventListener('change', () => {
        if (cb.checked) tagBulkSelected.add(i);
        else            tagBulkSelected.delete(i);
        updateBulkApplyButton();
      });
    }
    ul.appendChild(li);
  });
  updateBulkApplyButton();
}

// Refresh the "Apply to selected (N)" button label + disabled state.
// Disabled when 0 selected, OR when the form has no non-empty fields to
// propagate. Kept as a separate helper so the count updates immediately on
// checkbox toggle without a full list re-render.
// Tag form input IDs in the same order the form lays them out. Used by the
// edited-field highlighter to walk the inputs and by readFormTags to keep
// keys aligned.
const TAG_FORM_FIELDS = [
  'title', 'artist', 'album', 'albumartist',
  'year', 'track', 'genre', 'comment'
];

// Toggle .tag-input-edited on each form input based on whether its current
// value differs from the baseline snapshot. The class draws the yellow
// "this field will be replicated by bulk-apply" border. Cheap to call on
// every keystroke — 8 inputs, string compare each.
function markEditedFields() {
  for (const k of TAG_FORM_FIELDS) {
    const el = document.getElementById(`tag-${k}`);
    if (!el) continue;
    const before = (tagFormBaseline?.[k] || '');
    const after  = (el.value || '').trim();
    el.classList.toggle('tag-input-edited', tagFormBaseline != null && before !== after);
  }
}

// Toolbar select-all toggle. Operates only on writable (MP3) files since
// non-MP3 rows have a disabled switch and can't be bulk-applied. If every
// writable file is already selected, this deselects everything; otherwise
// it selects everything writable. Mixed → "select all" (the more useful
// default after partial manual selection).
function toggleSelectAllTagFiles() {
  const writable = tagFiles
    .map((f, i) => ({ f, i }))
    .filter(x => /\.mp3$/i.test(x.f.path));
  if (!writable.length) return;
  const allSelected = writable.every(x => tagBulkSelected.has(x.i));
  if (allSelected) tagBulkSelected.clear();
  else             writable.forEach(x => tagBulkSelected.add(x.i));
  renderTagFileList();
}

function updateBulkApplyButton() {
  // Drop indices that don't exist anymore (e.g. after Clear or after a
  // re-load). Keep the Set tidy so the count is always accurate.
  for (const idx of [...tagBulkSelected]) {
    if (!tagFiles[idx]) tagBulkSelected.delete(idx);
  }
  const n = tagBulkSelected.size;
  const btn = document.getElementById('tag-apply-bulk-btn');
  if (btn) {
    const tpl = t('tag_apply_bulk_n');
    const label = (tpl && tpl !== 'tag_apply_bulk_n') ? tpl.replace('{n}', n) : `Apply to selected (${n})`;
    btn.textContent = label;
    btn.disabled = n === 0;
  }
  // Sync the toolbar icon button — same enable rule, label lives in title.
  const iconBtn = document.getElementById('tag-apply-bulk-icon-btn');
  if (iconBtn) {
    iconBtn.disabled = n === 0;
    const tpl = t('tag_apply_bulk_icon_count');
    iconBtn.title = (tpl && tpl !== 'tag_apply_bulk_icon_count')
      ? tpl.replace('{n}', n)
      : `Apply form fields to ${n} selected file(s)`;
  }
}

async function selectTagFile(i) {
  tagSelectedIdx = i;
  renderTagFileList();
  const f = tagFiles[i];
  document.getElementById('tag-empty').classList.add('hidden');
  document.getElementById('tag-form').classList.remove('hidden');
  document.getElementById('tag-title').value       = f.tags.title || '';
  document.getElementById('tag-artist').value      = f.tags.artist || '';
  document.getElementById('tag-album').value       = f.tags.album || '';
  document.getElementById('tag-albumartist').value = f.tags.albumartist || '';
  document.getElementById('tag-year').value        = f.tags.year || '';
  document.getElementById('tag-track').value       = f.tags.track || '';
  document.getElementById('tag-genre').value       = f.tags.genre || '';
  document.getElementById('tag-comment').value     = f.tags.comment || '';
  // Snapshot the just-populated form so bulk-apply can diff edits against
  // it. Re-read from the inputs rather than f.tags so the comparison uses
  // the same normalisation (trim, empty-string handling) as readFormTags.
  tagFormBaseline = readFormTags();
  // Form just repopulated from disk — by definition no edits yet, so wipe
  // any leftover yellow borders from the previously-selected file.
  markEditedFields();
  // Cover: hide img element when missing (don't blank src — that triggers ERR_INVALID_URL)
  const cover = document.getElementById('tag-cover-img');
  if (f.cover && f.cover.dataBase64) {
    cover.src = `data:${f.cover.mime};base64,${f.cover.dataBase64}`;
    cover.classList.remove('hidden');
  } else {
    cover.removeAttribute('src');
    cover.classList.add('hidden');
  }
  const dur = f.duration ? `${Math.floor(f.duration/60)}:${String(f.duration%60).padStart(2,'0')}` : '—';
  document.getElementById('tag-file-meta').innerHTML =
    `<div><b>${esc(f.format || '')}</b> · ${dur} · ${f.bitrate||'?'} kbps · ${f.sampleRate||'?'} Hz</div>`;
  // Path lives in its own full-width row beneath the cover so it wraps
  // cleanly even when the file list column is narrow.
  document.getElementById('tag-file-path').textContent = f.path;
  // Disable save for non-MP3
  const saveBtn = document.getElementById('tag-save-btn');
  const isMp3 = /\.mp3$/i.test(f.path);
  saveBtn.disabled = !isMp3;
  saveBtn.title = isMp3 ? '' : t('tag_save_unsupported');
  document.getElementById('tag-save-all-btn').disabled = !tagFiles.some(x => /\.mp3$/i.test(x.path));
  // Enable file-action toolbar buttons now that a file is selected
  document.getElementById('tag-file-play-btn').disabled   = false;
  document.getElementById('tag-file-folder-btn').disabled = false;

  // Check for sidecar .lrc file → show "Open lyrics" button if exists
  const lrcBtn = document.getElementById('tag-file-lrc-btn');
  try {
    const info = await window.api.lrc.exists(f.path);
    if (info.exists) lrcBtn.classList.remove('hidden');
    else             lrcBtn.classList.add('hidden');
  } catch { lrcBtn.classList.add('hidden'); }
}

function currentTagFile() { return tagFiles[tagSelectedIdx] || null; }

function readFormTags() {
  return {
    title:       document.getElementById('tag-title').value.trim(),
    artist:      document.getElementById('tag-artist').value.trim(),
    album:       document.getElementById('tag-album').value.trim(),
    albumartist: document.getElementById('tag-albumartist').value.trim(),
    year:        document.getElementById('tag-year').value.trim(),
    track:       document.getElementById('tag-track').value.trim(),
    genre:       document.getElementById('tag-genre').value.trim(),
    comment:     document.getElementById('tag-comment').value.trim()
  };
}

// Drag the central splitter to resize the tag editor's two columns. Width is
// stored as a percentage of the layout's total width so resizing the window
// doesn't snap-collapse one side. Persisted to config.tag_sidebar_width.
function bindTagSplitter() {
  const splitter = document.getElementById('tag-splitter');
  const layout   = document.querySelector('.tag-layout');
  if (!splitter || !layout) return;
  let dragging = false;
  splitter.addEventListener('mousedown', e => {
    dragging = true;
    splitter.classList.add('is-dragging');
    document.body.classList.add('tag-splitter-active');
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const r = layout.getBoundingClientRect();
    const px = e.clientX - r.left;
    // Clamp 15% .. 70% so neither column collapses or eats the whole row.
    const min = r.width * 0.15;
    const max = r.width * 0.70;
    const w = Math.max(min, Math.min(max, px));
    const pct = (w / r.width * 100).toFixed(2) + '%';
    layout.style.setProperty('--tag-sidebar-w', pct);
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('is-dragging');
    document.body.classList.remove('tag-splitter-active');
    config.tag_sidebar_width = layout.style.getPropertyValue('--tag-sidebar-w') || '40%';
    window.api.config.save(config);
  });
}

async function saveCurrentTag() {
  const f = currentTagFile();
  if (!f) return;
  const tags = readFormTags();
  const payload = { filePath: f.path, tags };
  if (f.cover) { payload.coverBase64 = f.cover.dataBase64; payload.coverMime = f.cover.mime; }
  const r = await window.api.tag.write(payload);
  if (r.ok) {
    appendLog('tag-log', `${t('tag_saved')}: ${f.name}`, 'ok');
    f.tags = tags;
  } else {
    appendLog('tag-log', `✗ ${r.error}`, 'error');
  }
}

// Bulk-apply: propagate ONLY the fields the user has actually EDITED on the
// active file's form to every checkbox-selected file. The baseline taken
// at selectTagFile time is the reference — any field whose current form
// value differs from baseline counts as edited. This way "change just the
// album then apply to all" doesn't also broadcast the active file's title /
// artist / track number to every selected target.
// Cover art is intentionally NOT propagated — that's per-file by nature
// (different songs, different covers). A separate flow can handle that
// later if needed.
async function applyTagsToSelected() {
  if (tagBulkSelected.size === 0) return;
  if (!tagFormBaseline) {
    appendLog('tag-log', t('tag_bulk_no_baseline') || 'Select a file first, then edit fields, then apply.', 'error');
    return;
  }
  const formTags = readFormTags();
  // Diff against baseline: a field is "edited" when its current value
  // differs from the baseline. Clearing a previously-filled field counts
  // as an edit (user wants to wipe it on every target).
  const overrides = {};
  for (const [k, v] of Object.entries(formTags)) {
    const before = (tagFormBaseline[k] || '');
    const after  = (v || '');
    if (before !== after) overrides[k] = after;
  }
  if (Object.keys(overrides).length === 0) {
    appendLog('tag-log', t('tag_bulk_no_edits') || 'No edits to propagate — change a field on the form first, then apply.', 'error');
    return;
  }
  const targets = [...tagBulkSelected]
    .map(idx => tagFiles[idx])
    .filter(f => f && /\.mp3$/i.test(f.path));
  if (!targets.length) {
    appendLog('tag-log', t('tag_bulk_no_mp3') || 'Selected files are not writable (MP3 only).', 'error');
    return;
  }
  if (!(await showConfirm({
    title: t('tag_bulk_confirm_title') || 'Apply tags to selected',
    body:  (t('tag_bulk_confirm_body') || 'Apply {fields} to {count} file(s)?')
            .replace('{fields}', Object.keys(overrides).join(', '))
            .replace('{count}',  String(targets.length))
  }))) return;
  let ok = 0, fail = 0;
  for (const f of targets) {
    // Merge the edited fields on top of each target's existing tags. The
    // target keeps every field NOT in `overrides`, so its title/track/etc.
    // are preserved.
    const merged = { ...f.tags, ...overrides };
    const payload = { filePath: f.path, tags: merged };
    // Cover deliberately omitted — per-file artwork is preserved.
    const r = await window.api.tag.write(payload);
    if (r.ok) { f.tags = merged; ok++; }
    else      { fail++; appendLog('tag-log', `✗ ${f.name}: ${r.error}`, 'error'); }
  }
  appendLog('tag-log', (t('tag_bulk_done') || 'Bulk apply: {ok} ok, {fail} failed')
                          .replace('{ok}', ok).replace('{fail}', fail),
            fail ? 'error' : 'ok');
  // After applying, reset the baseline to the now-active form so the
  // next round of edits is again diffed against a clean slate, and clear
  // the yellow edit indicators since "edited" no longer applies.
  tagFormBaseline = { ...formTags };
  markEditedFields();
  // If the currently-active file was in the selection, refresh the form so
  // the user sees the merged values reflected in the inputs.
  const curIdx = tagSelectedIdx;
  if (curIdx >= 0 && tagBulkSelected.has(curIdx)) selectTagFile(curIdx);
}

// Ensure title/artist are populated, parsing from filename as fallback. Returns true on success.
function ensureTitleArtistFromFilename() {
  const f = currentTagFile();
  if (!f) return false;
  const tags = readFormTags();
  if (tags.title || tags.artist) return true;
  // Try to auto-parse with current pattern
  const noExt = f.name.replace(/\.[^.]+$/, '');
  const parsed = parseFilenameWithPattern(noExt, currentPattern());
  if (!parsed || (!parsed.title && !parsed.artist)) {
    appendLog('tag-log', t('tag_need_query'), 'error');
    return false;
  }
  if (parsed.title)  document.getElementById('tag-title').value  = parsed.title;
  if (parsed.artist) document.getElementById('tag-artist').value = parsed.artist;
  if (parsed.album)  document.getElementById('tag-album').value  = parsed.album;
  if (parsed.year)   document.getElementById('tag-year').value   = parsed.year;
  if (parsed.track)  document.getElementById('tag-track').value  = parsed.track;
  appendLog('tag-log', `📥 Auto-filled from filename (${Object.keys(parsed).join(', ')})`, 'info');
  return true;
}

async function withLoading(btnId, fn) {
  const btn = document.getElementById(btnId);
  if (!btn) return fn();
  btn.classList.add('btn-loading');
  try { return await fn(); }
  finally { btn.classList.remove('btn-loading'); }
}

async function lookupMusicBrainz() {
  return withLoading('tag-mb-btn', async () => {
  const f = currentTagFile();
  if (!f) return;
  if (!ensureTitleArtistFromFilename()) return;
  const tags = readFormTags();
  appendLog('tag-log', `🔍 Searching MusicBrainz for "${tags.title}" by "${tags.artist}"…`, 'info');
  const r = await window.api.mb.search({ title: tags.title, artist: tags.artist, album: tags.album });
  if (!r.ok) { appendLog('tag-log', `✗ ${r.error}`, 'error'); return; }
  if (!r.results.length) { appendLog('tag-log', t('tag_no_match'), 'log'); return; }
  const best = r.results[0];
  document.getElementById('tag-title').value  = best.title || tags.title;
  document.getElementById('tag-artist').value = best.artist || tags.artist;
  document.getElementById('tag-album').value  = best.album || tags.album;
  document.getElementById('tag-year').value   = best.year || tags.year;
  f.mbid = best.release_mbid;
  appendLog('tag-log', `${t('tag_match_found')} (score ${best.score}/100)`, 'ok');
  }); // withLoading
}

async function fetchCurrentCover() {
  return withLoading('tag-cover-btn', async () => {
  const f = currentTagFile();
  if (!f) return;
  if (!ensureTitleArtistFromFilename()) return;
  // If we don't have an MBID from a previous MusicBrainz lookup, try one now
  if (!f.mbid) {
    appendLog('tag-log', 'Looking up MusicBrainz to find release MBID first…', 'log');
    await lookupMusicBrainz();
    if (!f.mbid) return;
  }
  appendLog('tag-log', `🎨 Fetching cover from Cover Art Archive…`, 'info');
  const r = await window.api.cover.fetch(f.mbid);
  if (!r.ok) { appendLog('tag-log', `✗ ${r.error}`, 'error'); return; }
  f.cover = { mime: r.mime, dataBase64: r.dataBase64 };
  const img = document.getElementById('tag-cover-img');
  img.src = `data:${r.mime};base64,${r.dataBase64}`;
  img.classList.remove('hidden');
  appendLog('tag-log', t('tag_cover_loaded'), 'ok');
  }); // withLoading
}

async function fetchCurrentLyrics() {
  return withLoading('tag-lrc-btn', async () => {
  const f = currentTagFile();
  if (!f) return;
  if (!ensureTitleArtistFromFilename()) return;
  const tags = readFormTags();
  appendLog('tag-log', `📝 Fetching lyrics from LRCLIB…`, 'info');
  const r = await window.api.lrc.fetch({
    title: tags.title, artist: tags.artist, album: tags.album, duration: f.duration
  });
  if (!r.ok) { appendLog('tag-log', `✗ ${r.error}`, 'error'); return; }
  if (!r.plain && !r.synced) { appendLog('tag-log', t('tag_no_match'), 'log'); return; }
  // Save lyrics to a sidecar .lrc file. Prefer synced (LRC format) — fall back to plain.
  const lyrics = r.synced || r.plain;
  const saveResult = await window.api.lrc.save({ audioPath: f.path, lyrics });
  if (!saveResult.ok) { appendLog('tag-log', `✗ Lyrics save failed: ${saveResult.error}`, 'error'); return; }
  appendLog('tag-log', t('tag_lrc_saved', { path: saveResult.path }), 'ok');
  // Reveal the "Open lyrics" button since the .lrc now exists
  document.getElementById('tag-file-lrc-btn').classList.remove('hidden');
  }); // withLoading
}


// ─── QUEUE ───────────────────────────────────────────────────────────────────
function bindQueue() {
  document.getElementById('queue-run-btn').addEventListener('click', async () => {
    if (!config) { appendLog('queue-log', 'Config not loaded yet.', 'error'); return; }
    const pending = queue.filter(i => i.status === 'pending');
    if (!pending.length) { appendLog('queue-log', t('queue_no_pending'), 'log'); return; }
    // Media items go through yt-dlp/ffmpeg → make sure those binaries are present
    // (lazy-fetch on first use). Torrent items only save a .torrent/.magnet, no
    // binary needed, so skip the gate when the queue is torrent-only.
    if (pending.some(i => i.type === 'media') &&
        !(await ensureBinaries(['yt-dlp', 'ffmpeg', 'ffprobe'], t('nav_queue') || 'Queue'))) return;
    stopGlobalPlayer(); // halt any preview before starting downloads
    const runBtn  = document.getElementById('queue-run-btn');
    const stopBtn = document.getElementById('queue-stop-btn');
    runBtn.disabled = true;
    stopBtn.classList.remove('hidden');
    appendLog('queue-log', t('queue_running', { n: pending.length }), 'info');
    try {
      const r = await window.api.queue.run(pending, config);
      if (r?.stopped) appendLog('queue-log', t('queue_stopped_by_user'), 'info');
      else            appendLog('queue-log', t('queue_done'), 'ok');
      if (config.notify_on_done && !r?.stopped) window.api.notify.show({ title: 'FLUX', body: t('queue_done') });
    } catch(e) {
      appendLog('queue-log', `✗ ${e.message}`, 'error');
    } finally {
      runBtn.disabled = false;
      stopBtn.classList.add('hidden');
    }
  });

  document.getElementById('queue-stop-btn').addEventListener('click', async () => {
    await window.api.media.stop({ downloadFolder: config.download_folder });
    appendLog('queue-log', '⏹ Stopping…', 'info');
  });

  document.getElementById('queue-clear-btn').addEventListener('click', async () => {
    if (!queue.length) return;
    if (!(await showConfirm({
      title: t('queue_clear_title') || 'Clear queue',
      body:  t('queue_clear_confirm'),
      danger: true
    }))) return;
    queue = [];
    window.api.queue.clear();
    renderQueue();
  });

  // Import CSV / TXT — picks file via native dialog, parses on the main side,
  // shows a small modal asking for the default download format, then appends
  // every row as a queue item. URLs go in as-is; bare titles become
  // ytsearch1:<title> so the existing media pipeline can resolve them.
  let pendingImportRows = null;
  let pendingImportSource = null;
  // Cooperative-stop flag for the URL-check worker pool. The FERMA button
  // flips this; workers re-check after every await so we abort cleanly
  // without leaving rows in a half-checked state.
  let importCheckStopped = false;

  // Normaliser used for both name and URL dedup against the existing queue.
  // Lower-cased + trimmed; URLs also lose trailing slashes so 'foo/' and 'foo'
  // match. Cheap O(n) loop is fine — the queue is bounded by user attention.
  const normForDedup = (s) => (s || '').toString().trim().toLowerCase().replace(/\/+$/, '');
  function isDuplicateName(name) {
    const n = normForDedup(name);
    if (!n) return false;
    return (queue || []).some(it => normForDedup(it.name) === n || normForDedup(it.title) === n);
  }
  function isDuplicateUrl(url) {
    const u = normForDedup(url);
    if (!u) return false;
    return (queue || []).some(it => normForDedup(it.url) === u);
  }

  // Compute one of: 'duplicate' | 'stopped' | 'ready' | 'fail' | 'checking'.
  // Precedence matters — duplicate beats stopped beats checkOk so a row that
  // started checking, got the stop, then resolved late as duplicate ends up
  // labelled correctly.
  function importRowState(row) {
    if (row.duplicate) return 'duplicate';
    if (row.stopped)   return 'stopped';
    if (row.checkOk === true)  return 'ready';
    if (row.checkOk === false) return 'fail';
    return 'checking';
  }

  // Render the parsed rows into the modal's scrollable review list. Per-row
  // sub-text follows the check state: "in elaborazione…" while pending,
  // "corrispondenza con: <matched title>" when ready, "già presente in coda"
  // when duplicate, nothing (title wraps to 2 lines) when failed/stopped.
  function renderImportReview() {
    const list = document.getElementById('queue-import-list');
    if (!list || !pendingImportRows) return;
    let ready = 0, fail = 0, checking = 0, selected = 0, duplicate = 0, stopped = 0;
    list.innerHTML = pendingImportRows.map((row, i) => {
      const state = importRowState(row);
      if (state === 'ready')          ready++;
      else if (state === 'fail')      fail++;
      else if (state === 'duplicate') duplicate++;
      else if (state === 'stopped')   stopped++;
      else                            checking++;
      if (state === 'ready' && row.selected) selected++;

      let subHtml = '';
      if (state === 'checking') {
        subHtml = `<div class="import-row-sub">${esc(t('queue_import_checking_row') || 'in elaborazione…')}</div>`;
      } else if (state === 'ready') {
        const matched = row.matchedTitle || row.title || row.url || '';
        subHtml = `<div class="import-row-sub" title="${esc(matched)}">${esc(t('queue_import_match_with', { title: matched }) || `corrispondenza con: ${matched}`)}</div>`;
      } else if (state === 'duplicate') {
        subHtml = `<div class="import-row-sub">${esc(t('queue_import_duplicate') || 'già presente in coda')}</div>`;
      }
      // fail / stopped: no sub, title gets the 2 lines for context

      // Per-row toggle switch:
      //   ready     → enabled, checked by default (user can opt-out)
      //   checking  → disabled placeholder so the column width is stable
      //   fail/dup/stopped → invisible placeholder; row isn't queueable
      let switchHtml = '';
      if (state === 'ready') {
        const chk = row.selected ? 'checked' : '';
        switchHtml = `<label class="import-row-switch"><input type="checkbox" class="import-row-check" data-idx="${i}" ${chk} /><span class="switch-slider"></span></label>`;
      } else if (state === 'checking') {
        switchHtml = `<label class="import-row-switch is-disabled"><input type="checkbox" class="import-row-check" disabled /><span class="switch-slider"></span></label>`;
      } else {
        switchHtml = `<span class="import-row-check-placeholder" aria-hidden="true"></span>`;
      }

      const stateClass = state;  // CSS hooks: .import-row.fail, .import-row.ready, .import-row.duplicate, .import-row.stopped
      const tooltip = row.checkError ? esc(row.checkError) : '';
      return `<div class="import-row ${stateClass}" data-idx="${i}">
        ${switchHtml}
        <span class="dot dot-${state}" title="${tooltip}"></span>
        <div class="import-row-info">
          <span class="import-row-title" title="${esc(row.title || row.url || '')}">${esc(row.title || row.url || '')}</span>
          ${subHtml}
        </div>
      </div>`;
    }).join('');

    // Switch toggles → row.selected. Re-render to refresh button label/state.
    list.querySelectorAll('.import-row-check[data-idx]').forEach(cb => {
      cb.addEventListener('change', (ev) => {
        const idx = Number(ev.target.dataset.idx);
        if (!Number.isFinite(idx) || !pendingImportRows[idx]) return;
        pendingImportRows[idx].selected = ev.target.checked;
        renderImportReview();
      });
    });

    // Legend = two halves. Left: progress "elaborati X / totali Y" so the
    // user can track the work without having to count pills. Right: the
    // colour-coded pills (ready/duplicate/fail, plus 'stopped' once the
    // user has actually pressed the stop button). Total pill dropped — it
    // was just the sum of the others and now lives in the progress line.
    //
    // "elaborati" counts only rows that produced an actual outcome
    // (ready/fail/duplicate). Stopped rows are explicitly excluded — they
    // were interrupted before the URL probe finished, so calling them
    // "elaborati" would be misleading. After STOP, the counter therefore
    // freezes at the number of rows the worker had a chance to resolve.
    const total = pendingImportRows.length;
    const done = ready + fail + duplicate;
    const statsEl = document.querySelector('.import-review-status');
    if (statsEl) {
      const progressTpl = t('queue_import_stat_progress');
      const progressTxt = (progressTpl && progressTpl !== 'queue_import_stat_progress')
        ? progressTpl.replace('{done}', String(done)).replace('{total}', String(total))
        : `elaborati ${done} / totali ${total}`;
      const pills = [
        `<span class="status-pill"><span class="dot dot-ready"></span>${esc(t('queue_import_stat_ready') || 'trovati')} ${ready}</span>`,
        `<span class="status-pill"><span class="dot dot-duplicate"></span>${esc(t('queue_import_stat_duplicate') || 'già in coda')} ${duplicate}</span>`,
        `<span class="status-pill"><span class="dot dot-fail"></span>${esc(t('queue_import_stat_fail') || 'scartati')} ${fail}</span>`,
      ];
      if (stopped > 0) {
        pills.push(`<span class="status-pill"><span class="dot dot-stopped"></span>${esc(t('queue_import_stat_stopped') || 'fermati')} ${stopped}</span>`);
      }
      statsEl.innerHTML = `
        <span class="import-review-progress">${esc(progressTxt)}</span>
        <span class="import-review-pills">${pills.join('')}</span>
      `;
    }

    // FERMA button: only meaningful while at least one row is still checking.
    // Hidden otherwise so the actions row stays tidy. We use the .hidden
    // CSS class (display:none !important) rather than the HTML5 `hidden`
    // attribute because `.btn { display: inline-flex }` overrides it.
    const stopBtn = document.getElementById('queue-import-stop');
    if (stopBtn) stopBtn.classList.toggle('hidden', checking === 0);

    // Confirm button:
    //   - disabled while any row is still checking (gate on URL verification)
    //   - disabled if zero rows are selected (nothing to add)
    //   - label reflects the live count of selected rows
    const confirmBtn = document.getElementById('queue-import-confirm');
    if (confirmBtn) {
      const allDone = checking === 0;
      confirmBtn.disabled = !allDone || selected === 0;
      if (!allDone) {
        confirmBtn.title = t('queue_import_wait_check') || 'Attendi che tutte le URL siano verificate prima di aggiungerle alla coda.';
      } else {
        confirmBtn.title = '';
      }
      const labelTpl = t('queue_import_add_n');
      const fallback = `Aggiungi ${selected} voci alla coda`;
      confirmBtn.textContent = (labelTpl && labelTpl !== 'queue_import_add_n')
        ? labelTpl.replace('{n}', String(selected))
        : fallback;
    }
  }

  // Probe every row in parallel (cap concurrency at 4 to balance speed vs
  // load on yt-dlp + remote servers). URL rows use a fast HEAD/GET probe;
  // search queries are resolved via yt-dlp so the matched title is what we
  // surface in "corrispondenza con: …". Two dedup passes:
  //   pre  — row name/title vs existing queue (skip URL probe if already in)
  //   post — resolved URL vs existing queue (catches different titles for the
  //          same source)
  // Cooperative cancel via importCheckStopped: workers bail before starting
  // a new row and any rows still pending at stop time get marked 'stopped'.
  async function runImportUrlCheck() {
    if (!pendingImportRows) return;
    let cursor = 0;
    const CONCURRENCY = 4;
    const all = pendingImportRows;
    const worker = async () => {
      while (cursor < all.length) {
        if (importCheckStopped) return;
        const row = all[cursor++];

        // Pre-check: don't probe a URL we're going to discard anyway.
        const candidateName = row.title || row.url || '';
        if (isDuplicateName(candidateName)) {
          row.duplicate = true;
          renderImportReview();
          continue;
        }

        try {
          if (row.isSearchQuery) {
            const r = await window.api.media.resolveStreamUrl({ url: `ytsearch1:${row.title}`, kind: 'audio' });
            if (importCheckStopped) return;
            row.checkOk      = !!r?.ok;
            row.checkError   = r?.error || '';
            row.matchedTitle = r?.title || null;
            if (row.checkOk) row.selected = true;
          } else if (row.url && /^https?:\/\//i.test(row.url)) {
            const r = await window.api.queue.checkUrl(row.url);
            if (importCheckStopped) return;
            row.checkOk    = !!r.ok;
            row.checkError = r.error || '';
            if (r.ok) {
              try {
                const u = new URL(row.url);
                const tail = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.host);
                row.matchedTitle = tail || row.url;
              } catch { row.matchedTitle = row.url; }
              row.selected = true;
            }
          } else {
            row.checkOk = false;
            row.checkError = 'No URL or query';
          }
        } catch (e) {
          if (importCheckStopped) return;
          row.checkOk = false;
          row.checkError = e?.message || 'check failed';
        }

        // Post-check: URL dedup. If the resolved URL is already in the queue
        // we promote the row to 'duplicate' (overrides 'ready' — duplicates
        // never get a switch even if the probe succeeded). Match the URL the
        // confirm handler would actually push: search queries become
        // ytsearch1:<title>, direct URLs go as-is.
        if (row.checkOk === true) {
          const finalUrl = row.isSearchQuery ? `ytsearch1:${row.title}` : row.url;
          if (isDuplicateUrl(finalUrl)) {
            row.duplicate = true;
            row.selected = false;
          }
        }

        renderImportReview();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, all.length || 1) }, worker));
  }
  // "Search music from list": both the pasted text and a loaded file produce the
  // same `rows`, which flow into the existing import-review modal.
  function proceedImport(r) {
    if (!r || r.cancelled) return;
    if (!r.ok) {
      showToast({ title: t('queue_import_fail') || 'Import failed', body: r.error || 'unknown error', kind: 'err', ttl: 8000 });
      return;
    }
    if (!r.rows.length) {
      showToast({ title: t('queue_import_empty') || 'No items found', body: t('musiclist_empty') || 'No usable entries found.', kind: 'err', ttl: 6000 });
      return;
    }
    pendingImportRows = r.rows;
    importCheckStopped = false;            // fresh session: clear any leftover stop flag
    const baseName = (r.filePath || '').split(/[\\/]/).pop();
    pendingImportSource = baseName ? `file:${baseName}` : 'musiclist';
    document.getElementById('queue-import-confirm').disabled = true;
    document.getElementById('music-list-modal')?.classList.add('hidden');
    renderImportReview();
    document.getElementById('queue-import-modal').classList.remove('hidden');
    runImportUrlCheck();                   // background URL probe; UI updates as results arrive
  }
  document.getElementById('queue-import-btn').addEventListener('click', () => {
    const ta = document.getElementById('music-list-input');
    if (ta) ta.value = '';
    document.getElementById('music-list-modal').classList.remove('hidden');
    setTimeout(() => ta?.focus(), 50);
  });
  document.getElementById('music-list-cancel')?.addEventListener('click', () =>
    document.getElementById('music-list-modal').classList.add('hidden'));
  document.getElementById('music-list-load')?.addEventListener('click', async () => {
    proceedImport(await window.api.queue.importList());   // no text → file picker
  });
  document.getElementById('music-list-continue')?.addEventListener('click', async () => {
    const text = (document.getElementById('music-list-input')?.value || '').trim();
    if (!text) {
      showToast({ title: t('musiclist_title') || 'Search music from list', body: t('musiclist_empty') || 'Paste at least one line, or load a file.', kind: 'warn', ttl: 4000 });
      return;
    }
    proceedImport(await window.api.queue.importList(text));
  });
  document.getElementById('queue-import-cancel').addEventListener('click', () => {
    importCheckStopped = true;  // stop any in-flight workers
    pendingImportRows = null;
    pendingImportSource = null;
    document.getElementById('queue-import-modal').classList.add('hidden');
  });
  document.getElementById('queue-import-stop').addEventListener('click', () => {
    // Flip the cooperative-cancel flag and mark every row that hasn't yet
    // resolved as 'stopped'. The worker loop will bail before starting any
    // new row; in-flight awaits also re-check the flag after each await and
    // return early, so late results don't overwrite 'stopped' rows.
    importCheckStopped = true;
    if (!pendingImportRows) return;
    for (const row of pendingImportRows) {
      if (importRowState(row) === 'checking') row.stopped = true;
    }
    renderImportReview();
  });
  // Catch-all cleanup: any path that hides the import modal (Esc, click-
  // outside, future buttons) must abort the worker and clear pending state
  // so a half-checked list doesn't leak into the next session.
  {
    const importModal = document.getElementById('queue-import-modal');
    new MutationObserver(() => {
      if (importModal.classList.contains('hidden')) {
        importCheckStopped = true;
        pendingImportRows = null;
        pendingImportSource = null;
      }
    }).observe(importModal, { attributes: true, attributeFilter: ['class'] });
  }
  document.getElementById('queue-import-confirm').addEventListener('click', () => {
    if (!pendingImportRows) return;
    const defaultFormat = document.getElementById('queue-import-format').value;
    const origin = pendingImportSource || 'import';
    let added = 0;
    for (const row of pendingImportRows) {
      // Only push rows the user explicitly selected (ready + switch on).
      // Failed/duplicate/stopped rows are filtered out earlier (no switch
      // rendered) but we belt-and-brace here in case state races slip one
      // through.
      if (row.checkOk !== true) continue;
      if (row.selected !== true) continue;
      if (row.duplicate || row.stopped) continue;
      const url  = row.isSearchQuery ? `ytsearch1:${row.title}` : row.url;
      const name = row.title || row.url || '(unnamed)';
      const format = row.format || defaultFormat;
      queue.push({
        id: newId(),
        type: 'media',
        name,
        title: row.title || null,
        url,
        format,
        status: 'pending',
        origin
      });
      added++;
    }
    pendingImportRows = null;
    pendingImportSource = null;
    window.api.queue.save(queue);
    renderQueue();
    document.getElementById('queue-import-modal').classList.add('hidden');
    showToast({
      title: t('queue_import_done_title') || 'Imported',
      body:  t('queue_import_done_body', { count: added }) || `${added} item(s) added to the queue.`,
      kind:  'ok',
      ttl:   5000
    });
  });
}

// Convert an `origin` tag stored on a queue item into the human label shown in
// the queue table — i18n'd "imported from <source>". CSV/TXT imports embed the
// file basename as "file:<name>"; all other sources use a bare tag ('rss',
// 'podcast', 'media', 'torrent', 'playlist'). Legacy items (saved before this
// schema, no `origin`) are filtered out by the call-site `if (item.origin)`.
// Legacy "import:" / "import" tags written by older builds map back to file.
function formatQueueOrigin(origin) {
  if (!origin) return '';
  const from = t('queue_origin_from') || 'imported from';
  const fileLabel = () => t('queue_origin_file') || 'file';
  // file:<basename> → "imported from file: <basename>"
  if (origin.startsWith('file:')) {
    const name = origin.slice('file:'.length).trim();
    return name ? `${from} ${fileLabel()}: ${name}` : `${from} ${fileLabel()}`;
  }
  // Legacy schema: "import: <name>" (older CSV/TXT imports) — same shape, just
  // a different prefix. Treat as a file import.
  if (origin.startsWith('import:')) {
    const name = origin.slice('import:'.length).trim();
    return name ? `${from} ${fileLabel()}: ${name}` : `${from} ${fileLabel()}`;
  }
  // Legacy bare "import" (no filename) → just "imported from file".
  if (origin === 'import') return `${from} ${fileLabel()}`;
  const key = `queue_origin_${origin}`;
  const tag = t(key);
  // t() typically echoes the key back when missing, so detect that and fall
  // back to the raw origin tag rather than leaking "queue_origin_xxx" into UI.
  const safe = (tag && tag !== key) ? tag : origin;
  return `${from} ${safe}`;
}

// ─── Batch torrent search (queue) ───────────────────────────────────────────
// Paste/load a list of search terms → search every enabled torrent site for
// each line → pre-select the most-seeded hit per query (auto) → review and
// tweak (manual) → enqueue the chosen ones as torrent items. Reuses
// torrent.search + the same queue torrent-item shape as the Torrent tab.
let tbatchGroups = []; // [{ query, results:[...sortedBySeeds], checked:Set<idx> }]

function bindTorrentBatch() {
  const modal   = document.getElementById('torrent-batch-modal');
  const openBtn = document.getElementById('queue-torrent-batch-btn');
  if (!openBtn || !modal) return;
  const input    = document.getElementById('tbatch-input');
  const resultsEl = document.getElementById('tbatch-results');
  const addBtn   = document.getElementById('tbatch-add');
  const progress = document.getElementById('tbatch-progress');
  const statusEl = document.getElementById('tbatch-status');
  const setProg = (pct) => {
    const bar = document.getElementById('tbatch-bar');
    bar.querySelector('.progress-bar').style.width = `${Math.round(pct * 100)}%`;
    bar.querySelector('.progress-bar-text').textContent = `${Math.round(pct * 100)}%`;
  };

  openBtn.addEventListener('click', () => {
    tbatchGroups = [];
    resultsEl.innerHTML = '';
    addBtn.classList.add('hidden');
    progress.classList.add('hidden');
    updateTbatchSel();
    modal.classList.remove('hidden');
    input.focus();
  });
  document.getElementById('tbatch-cancel').addEventListener('click', () => modal.classList.add('hidden'));

  // Load file → fill the textarea (one search per line). Reuses the same
  // CSV/TXT parser the queue import uses; we only take the title column.
  document.getElementById('tbatch-load').addEventListener('click', async () => {
    const r = await window.api.queue.importList();
    if (!r || !r.ok) return;
    const lines = (r.rows || []).map(x => x.title).filter(Boolean);
    if (lines.length) input.value = (input.value.trim() ? input.value.trim() + '\n' : '') + lines.join('\n');
  });

  document.getElementById('tbatch-search').addEventListener('click', async () => {
    const queries = [...new Set(input.value.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')))];
    if (!queries.length) { showToast({ title: t('tbatch_title') || 'Batch torrent search', body: t('tbatch_no_queries') || 'Add at least one search line.', kind: 'warn', ttl: 4000 }); return; }
    const activeSites = Object.keys(config.sites || {}).filter(s => config.sites[s].enabled);
    if (!activeSites.length) { showToast({ title: t('tbatch_title') || 'Batch torrent search', body: t('torrent_no_sources') || 'No torrent sources enabled.', kind: 'err', ttl: 5000 }); return; }
    const minSeeds = Math.max(0, parseInt(document.getElementById('tbatch-minseeds').value, 10) || 0);
    const searchBtn = document.getElementById('tbatch-search');
    searchBtn.disabled = true; addBtn.classList.add('hidden'); resultsEl.innerHTML = '';
    progress.classList.remove('hidden'); setProg(0);
    tbatchGroups = [];
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      statusEl.textContent = t('tbatch_searching', { q, i: i + 1, n: queries.length }) || `Searching "${q}" (${i + 1}/${queries.length})`;
      let res = [];
      try {
        const r = await window.api.torrent.search(q, config);
        res = (r.results || []).filter(x => (x.seeds || 0) >= minSeeds).sort((a, b) => (b.seeds || 0) - (a.seeds || 0));
      } catch { /* skip a failed query, keep going */ }
      tbatchGroups.push({ query: q, results: res, checked: new Set(res.length ? [0] : []) }); // best (idx 0) pre-checked
      setProg((i + 1) / queries.length);
      renderTbatch();
    }
    const totalFound = tbatchGroups.reduce((s, g) => s + g.results.length, 0);
    statusEl.textContent = t('tbatch_done', { found: totalFound, n: queries.length }) || `${totalFound} results across ${queries.length} searches`;
    searchBtn.disabled = false;
    addBtn.classList.toggle('hidden', totalFound === 0);
    updateTbatchSel();
  });

  addBtn.addEventListener('click', () => {
    let added = 0;
    tbatchGroups.forEach(g => [...g.checked].forEach(idx => {
      const it = g.results[idx];
      if (!it) return;
      queue.push({ id: newId(), type: 'torrent', name: it.name, torrentItem: it, status: 'pending', origin: 'torrentlist' });
      added++;
    }));
    if (!added) return;
    window.api.queue.save(queue);
    renderQueue();
    modal.classList.add('hidden');
    appendLog('queue-log', t('tbatch_added', { n: added }) || `+${added} torrent(s) queued`, 'ok');
    showToast({ title: t('queue_title') || 'Queue', body: t('tbatch_added', { n: added }) || `${added} added`, kind: 'ok', ttl: 4000 });
  });
}

// Selection counter + Add-button enabled state.
function updateTbatchSel() {
  const selCount = document.getElementById('tbatch-selcount');
  const addBtn   = document.getElementById('tbatch-add');
  const n = tbatchGroups.reduce((s, g) => s + g.checked.size, 0);
  if (selCount) selCount.textContent = n ? (t('tbatch_selected', { n }) || `${n} selected`) : '';
  if (addBtn) addBtn.disabled = n === 0;
}

// Render the per-query result groups (top 8 each), best-seeded pre-checked.
function renderTbatch() {
  const host = document.getElementById('tbatch-results');
  if (!host) return;
  host.innerHTML = '';
  tbatchGroups.forEach((g, gi) => {
    const box = document.createElement('div');
    box.className = 'tbatch-group';
    const head = document.createElement('div');
    head.className = 'tbatch-group-title';
    head.textContent = g.results.length
      ? (t('tbatch_group', { q: g.query, n: g.results.length }) || `${g.query} · ${g.results.length}`)
      : (t('tbatch_group_none', { q: g.query }) || `${g.query} · no results`);
    if (!g.results.length) head.classList.add('is-empty');
    box.appendChild(head);
    g.results.slice(0, 8).forEach((r, ri) => {
      const row = document.createElement('label');
      row.className = 'tbatch-row';
      const sc = r.seeds > 50 ? 'seeds-high' : r.seeds > 10 ? 'seeds-medium' : 'seeds-low';
      row.innerHTML = `
        <span class="toggle"><input type="checkbox" class="tbatch-check" data-g="${gi}" data-r="${ri}" ${g.checked.has(ri) ? 'checked' : ''} /><span class="toggle-track"></span></span>
        ${ri === 0 ? `<span class="tbatch-best" title="${esc(t('tbatch_best') || 'Most seeded')}" data-lucide-icon="star" data-lucide-size="13"></span>` : '<span class="tbatch-best-spacer"></span>'}
        <span class="tbatch-name" title="${esc(r.name)}">${esc(r.name)}</span>
        <span class="tbatch-seeds ${sc}">${r.seeds || 0}</span>
        <span class="tbatch-size">${esc(r.size || '')}</span>
        <span class="tbatch-site">${esc(r.site || '')}</span>`;
      box.appendChild(row);
    });
    host.appendChild(box);
  });
  host.querySelectorAll('.tbatch-check').forEach(cb => cb.addEventListener('change', () => {
    const g = tbatchGroups[+cb.dataset.g]; const ri = +cb.dataset.r;
    if (cb.checked) g.checked.add(ri); else g.checked.delete(ri);
    updateTbatchSel();
  }));
  applyLucideIcons(host);
  updateTbatchSel();
}

function renderQueue() {
  const list = document.getElementById('queue-list');
  document.getElementById('queue-count').textContent = queue.length ? `${queue.length} ${t('queue_items_label')}` : '';
  if (!queue.length) {
    list.innerHTML = `<div class="queue-empty">${t('queue_empty')}</div>`;
    return;
  }
  // Render as a proper table — same visual grammar as History/Radio/Spotify.
  const rows = queue.map(item => {
    const status = item.status || 'pending';
    const tooltip =
      status === 'done'    ? t('queue_status_done') :
      status === 'failed'  ? `${t('queue_status_failed')}${item.error || 'Error'}` :
      status === 'running' ? t('queue_status_running') :
                             t('queue_status_pending');
    const fmtLabel = item.format ? formatLabel(item.format) : '';
    const isPlayableUrl = item.url && /^(https?|file):/i.test(item.url);
    const canPreview = item.type === 'media' && isPlayableUrl && status !== 'running' && status !== 'done';
    const canDownload = (item.type === 'media' || item.type === 'torrent') && status !== 'running' && status !== 'done';
    // Torrent queue items expose a copy-magnet action when a magnet is known.
    const torrentMagnet = item.type === 'torrent'
      ? (item.torrentItem?.magnet || (/^magnet:/i.test(item.torrentItem?.url || '') ? item.torrentItem.url : ''))
      : '';
    const originLabel = item.origin ? `<div class="td-name-sub">${esc(formatQueueOrigin(item.origin))}</div>` : '';
    // Format pill (e.g. "MP3", "MP4 1080") replaces the redundant "media"
    // word; type is implied by everything in this table being a download.
    const fmtPill = fmtLabel
      ? `<span class="queue-fmt-tag" title="${esc(item.type)}">${esc(fmtLabel)}</span>`
      : `<span class="queue-fmt-tag">${esc(item.type)}</span>`;
    // Running rows are NOT draggable — moving an in-flight item would
    // misalign progress UI and confuse retry logic. They get a placeholder
    // grip span so the column width stays uniform.
    const dragAttrs = status === 'running' ? '' : 'draggable="true"';
    const gripCell = status === 'running'
      ? `<td class="td-grip"><span class="grip-placeholder" aria-hidden="true"></span></td>`
      : `<td class="td-grip" data-lucide-icon="grip-vertical" title="${esc(t('queue_drag_hint') || 'Drag to reorder')}"></td>`;
    return `
      <tr id="qi-${item.id}" class="status-${esc(status)}" data-qid="${item.id}" ${dragAttrs}>
        ${gripCell}
        <td class="td-name" title="${esc(item.name)}">
          <div class="td-name-main">${esc(item.name.length>80?item.name.substring(0,77)+'…':item.name)}</div>
          ${originLabel}
        </td>
        <td class="td-fmt">${fmtPill}</td>
        <td class="td-status" title="${esc(tooltip)}"><span class="dot dot-${esc(status)}"></span></td>
        <td class="td-actions">
          ${canDownload ? `<button class="btn-icon" data-run-one="${item.id}" data-lucide-icon="download" title="${esc(t('queue_run_one') || 'Download this')}"></button>` : ''}
          ${canPreview  ? `<button class="btn-icon" data-preview="${item.id}" data-lucide-icon="play" title="${esc(t('live_preview'))}"></button>` : ''}
          ${(item.type === 'torrent') ? `<button class="btn-icon${config.sendto_enabled ? '' : ' is-inactive'}" data-send-client="${item.id}" data-lucide-icon="send" title="${esc(t('queue_send_client') || 'Send to client')}"></button>` : ''}
          ${torrentMagnet ? `<button class="btn-icon" data-copy-magnet="${item.id}" data-lucide-icon="link" title="${esc(t('rss_copy') || 'Copy magnet')}"></button>` : ''}
          <button class="btn-icon btn-icon-danger" data-remove="${item.id}" data-lucide-icon="x" title="${esc(t('downloads_remove'))}"></button>
        </td>
      </tr>`;
  }).join('');
  list.innerHTML = `
    <div class="results-table-wrap">
      <table class="results-table queue-table">
        <thead><tr>
          <th class="th-grip" aria-hidden="true"></th>
          <th data-i18n="radio_th_name">Name</th>
          <th class="th-fmt"     data-i18n="queue_th_format">Format</th>
          <th class="th-status"  data-i18n="spotify_th_status">Status</th>
          <th data-i18n="radio_th_actions">Actions</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  applyI18n();          // translate the freshly-rendered <th> labels
  applyLucideIcons(list);
  list.querySelectorAll('[data-remove]').forEach(b =>
    b.addEventListener('click', () => {
      queue = queue.filter(i => i.id !== +b.dataset.remove);
      window.api.queue.save(queue);
      renderQueue();
    }));
  list.querySelectorAll('[data-preview]').forEach(b =>
    b.addEventListener('click', () => {
      const it = queue.find(q => q.id === +b.dataset.preview);
      if (!it) return;
      const wantVideo = /^(video|mp4|mkv)/.test(it.format || '');
      previewMediaUrl(it.url, it.title || it.name, '🔍 QUEUE PREVIEW', wantVideo);
    }));
  // Single-item download — runs just this row through the same queue
  // pipeline as Run Queue, so progress + history all stay consistent.
  list.querySelectorAll('[data-run-one]').forEach(b =>
    b.addEventListener('click', async () => {
      const id = +b.dataset.runOne;
      const it = queue.find(q => q.id === id);
      if (!it) return;
      if (it.type === 'media' && !(await ensureBinaries(['yt-dlp', 'ffmpeg', 'ffprobe'], t('nav_queue') || 'Queue'))) return;
      appendLog('queue-log', t('queue_running_one', { name: it.name }) || `▶ ${it.name}`, 'info');
      try {
        await window.api.queue.run([it], config);
      } catch (e) {
        appendLog('queue-log', `✗ ${e.message}`, 'error');
      }
    }));
  // Copy-magnet — for torrent queue items that carry a magnet link.
  list.querySelectorAll('[data-copy-magnet]').forEach(b =>
    b.addEventListener('click', () => {
      const it = queue.find(q => q.id === +b.dataset.copyMagnet);
      const mag = it?.torrentItem?.magnet || (/^magnet:/i.test(it?.torrentItem?.url || '') ? it.torrentItem.url : '');
      if (!mag) return;
      window.api.clipboard.write(mag);
      showToast({ title: t('rss_copy') || 'Copied', body: it.name || '', kind: 'ok', ttl: 2500 });
    }));
  // Send a queued torrent straight to the configured client (qBittorrent / Transmission).
  list.querySelectorAll('[data-send-client]').forEach(b =>
    b.addEventListener('click', async () => {
      const it = queue.find(q => q.id === +b.dataset.sendClient);
      if (!it) return;
      if (!config.sendto_enabled) { openSendtoSettings(); return; }
      const magnet = it.torrentItem?.magnet || (/^magnet:/i.test(it.torrentItem?.url || '') ? it.torrentItem.url : null);
      const url = it.torrentItem?.url || null;
      b.disabled = true;
      const r = await window.api.sendto.torrent({ magnet, url, name: it.name });
      b.disabled = false;
      if (r.ok) showToast({ title: t('queue_sent_client') || 'Sent to client', body: `${it.name}${r.sentTo ? ' (' + r.sentTo + ')' : ''}`, kind: 'ok', ttl: 3000 });
      else showToast({ title: t('queue_send_fail') || 'Send to client failed', body: r.error || '', kind: 'err', ttl: 7000 });
    }));

  // Drag-drop reorder. Native HTML5 DnD is sufficient here — small list,
  // single-item drag, no cross-tab/cross-window targets. Event delegation
  // on the tbody so a re-render doesn't strand listeners on orphaned <tr>s.
  const tbody = list.querySelector('tbody');
  if (tbody) {
    let dragSrcId = null;
    tbody.addEventListener('dragstart', (e) => {
      const tr = e.target.closest('tr[draggable="true"]');
      if (!tr) return;
      dragSrcId = +tr.dataset.qid;
      tr.classList.add('drag-source');
      // setData is required for Firefox; the actual content is ignored.
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(dragSrcId)); } catch {}
      }
    });
    tbody.addEventListener('dragend', () => {
      tbody.querySelectorAll('.drag-source, .drag-over-top, .drag-over-bottom')
           .forEach(el => el.classList.remove('drag-source', 'drag-over-top', 'drag-over-bottom'));
      dragSrcId = null;
    });
    tbody.addEventListener('dragover', (e) => {
      const tr = e.target.closest('tr[data-qid]');
      if (!tr || dragSrcId == null || +tr.dataset.qid === dragSrcId) return;
      e.preventDefault();   // allow drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      // Mark above/below based on cursor position within the target row.
      const rect = tr.getBoundingClientRect();
      const above = (e.clientY - rect.top) < rect.height / 2;
      tbody.querySelectorAll('.drag-over-top, .drag-over-bottom')
           .forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom'));
      tr.classList.add(above ? 'drag-over-top' : 'drag-over-bottom');
    });
    tbody.addEventListener('drop', (e) => {
      const tr = e.target.closest('tr[data-qid]');
      if (!tr || dragSrcId == null) return;
      e.preventDefault();
      const targetId = +tr.dataset.qid;
      if (targetId === dragSrcId) return;
      const fromIdx = queue.findIndex(it => it.id === dragSrcId);
      const toIdx   = queue.findIndex(it => it.id === targetId);
      if (fromIdx < 0 || toIdx < 0) return;
      const rect = tr.getBoundingClientRect();
      const above = (e.clientY - rect.top) < rect.height / 2;
      const [moved] = queue.splice(fromIdx, 1);
      // After splice, target index may have shifted by 1 if it was after src.
      const adjustedTo = toIdx > fromIdx ? toIdx - 1 : toIdx;
      const insertAt = above ? adjustedTo : adjustedTo + 1;
      queue.splice(insertAt, 0, moved);
      window.api.queue.save(queue);
      renderQueue();
    });
  }
}

function markQueueItem(id, status, error) {
  const item = queue.find(i => i.id === id);
  if (item) {
    item.status = status;
    if (error) item.error = error;
    window.api.queue.save(queue);
  }
  renderQueue();
}

function onQueueItemDone(id, ok, error, stopped) {
  if (stopped) {
    // User pressed Stop — revert to pending so user can re-run later.
    const item = queue.find(i => i.id === id);
    if (item) { item.status = 'pending'; delete item.error; window.api.queue.save(queue); }
    renderQueue();
  } else {
    markQueueItem(id, ok ? 'done' : 'failed', error);
    history = null; // invalidate cache
  }
}

// ─── RSS ─────────────────────────────────────────────────────────────────────
function bindRSS() {
  document.getElementById('rss-add-btn').addEventListener('click', () => {
    document.getElementById('rss-add-modal').classList.remove('hidden');
  });
  document.getElementById('rss-add-cancel').addEventListener('click', () => {
    document.getElementById('rss-add-modal').classList.add('hidden');
  });
  document.getElementById('rss-add-confirm').addEventListener('click', async () => {
    const name = document.getElementById('rss-feed-name').value.trim();
    const raw  = document.getElementById('rss-feed-url').value.trim();
    if (!name || !raw) return;
    const btn = document.getElementById('rss-add-confirm');
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = '…';
    try {
      // Try to resolve a feed URL from the pasted URL. If the user already
      // pasted a real .xml/.rss feed, rss.discover returns it unchanged.
      // If they pasted a podcast/article page, it looks for the autodiscovery
      // <link rel="alternate" type="application/rss+xml"> and uses that.
      const d = await window.api.rss.discover(raw);
      if (!d.ok) {
        showToast({
          title: t('rss_discover_fail_title'),
          // d.error is the technical reason (e.g. "HTTP 404"); we surface our
          // own friendly guidance and tuck the original into the activity log.
          body:  t('rss_discover_fail_body'),
          kind:  'err',
          ttl:   8000
        });
        appendLog('rss-log', `✗ RSS discover failed for ${raw}: ${d.error}`, 'error');
        return;
      }
      const url = d.feedUrl;
      // Auto-update on by default so the user gets new episodes without
      // manually refreshing each feed.
      rssFeeds.push({ name, url, auto_download: true, last_fetched: null, last_guids: [] });
      config.rss_feeds = rssFeeds;
      window.api.config.save(config);
      renderFeedList();
      document.getElementById('rss-add-modal').classList.add('hidden');
      document.getElementById('rss-feed-name').value = '';
      document.getElementById('rss-feed-url').value  = '';
      if (d.allFeeds && d.allFeeds.length > 1) {
        showToast({
          title: t('rss_discover_multi_title'),
          body:  t('rss_discover_multi_body', { feed: url, extra: d.allFeeds.length - 1 }),
          kind:  'ok',
          ttl:   6000
        });
      }
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });
  document.getElementById('rss-refresh-btn').addEventListener('click', () => {
    if (activeFeedIdx >= 0) loadFeedItems(activeFeedIdx);
  });
  const filterInput = document.getElementById('rss-feed-filter');
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      rssFeedFilterText = filterInput.value || '';
      renderFeedList();
    });
  }
  document.getElementById('rss-feed-auto').addEventListener('change', function() {
    if (activeFeedIdx < 0) return;
    rssFeeds[activeFeedIdx].auto_download = this.checked;
    config.rss_feeds = rssFeeds;
    window.api.config.save(config);
  });
  // Editable feed name — saves on blur (same UX as playlist name).
  document.getElementById('rss-feed-name-edit')?.addEventListener('change', function() {
    if (activeFeedIdx < 0) return;
    const v = this.value.trim();
    if (!v) { this.value = rssFeeds[activeFeedIdx].name; return; }
    rssFeeds[activeFeedIdx].name = v;
    config.rss_feeds = rssFeeds;
    window.api.config.save(config);
    renderFeedList(); // refresh sidebar label
  });
  // Delete current feed from the main view.
  document.getElementById('rss-feed-delete-btn')?.addEventListener('click', async () => {
    if (activeFeedIdx < 0) return;
    const name = rssFeeds[activeFeedIdx].name;
    if (!(await showConfirm({
      title: t('rss_delete_feed') || 'Delete feed',
      body:  t('rss_delete_feed_confirm', { name }) || `Delete feed "${name}"? This cannot be undone.`,
      danger: true
    }))) return;
    rssFeeds.splice(activeFeedIdx, 1);
    activeFeedIdx = -1;
    config.rss_feeds = rssFeeds;
    window.api.config.save(config);
    renderFeedList();
    showRSSEmpty();
  });
}

function relativeTime(iso) {
  if (!iso) return t('rss_never') || 'never';
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return '';
  const diff = Math.max(0, Date.now() - d);
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h';
  const dd = Math.floor(h / 24);
  return dd + 'd';
}

function feedHost(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; }
}

let rssFeedFilterText = '';

function renderFeedList() {
  const ul = document.getElementById('feed-list');
  const countEl = document.getElementById('rss-feed-count');
  if (countEl) countEl.textContent = rssFeeds.length ? `${rssFeeds.length} feed(s)` : '';
  ul.innerHTML = '';
  if (!rssFeeds.length) {
    ul.innerHTML = `<li class="feed-list-empty">${t('rss_no_feeds')}</li>`;
    return;
  }
  const q = rssFeedFilterText.toLowerCase().trim();
  const filtered = q
    ? rssFeeds.map((f, i) => ({ f, i })).filter(({ f }) =>
        (f.name || '').toLowerCase().includes(q) ||
        (f.url || '').toLowerCase().includes(q))
    : rssFeeds.map((f, i) => ({ f, i }));

  if (!filtered.length) {
    ul.innerHTML = `<li class="feed-list-empty">${t('rss_no_match') || 'No matching feeds'}</li>`;
    return;
  }

  filtered.forEach(({ f: feed, i }) => {
    const li = document.createElement('li');
    li.className = `feed-item${activeFeedIdx === i ? ' active' : ''}`;
    const host = feedHost(feed.url);
    const fetched = feed.last_fetched ? relativeTime(feed.last_fetched) : '—';
    // Delete from the sidebar was removed by request — the row deletion is
    // now only available from the main view's trash button. The accent dot
    // in the top-right marks feeds with auto-update enabled.
    const autoDot = feed.auto_download
      ? `<span class="feed-item-auto-dot" data-lucide-icon="rotate-cw" title="${esc(t('rss_auto_update'))}"><span class="lucide-slot"></span></span>`
      : '';
    li.innerHTML = `
      <div class="feed-item-body">
        <div class="feed-item-name" title="${esc(feed.url)}">${esc(feed.name)}</div>
        <div class="feed-item-meta">
          <span class="feed-item-host">${esc(host)}</span>
          <span class="feed-item-sep">·</span>
          <span class="feed-item-fetched" title="${esc(feed.last_fetched || '')}">${esc(fetched)}</span>
        </div>
      </div>
      ${autoDot}
    `;
    li.addEventListener('click', () => {
      activeFeedIdx = i;
      renderFeedList();
      loadFeedItems(i);
    });
    if (feed.auto_download) applyLucideIcons(li);
    ul.appendChild(li);
  });
}

function showRSSEmpty() {
  document.getElementById('rss-empty').classList.remove('hidden');
  document.getElementById('rss-items-wrap').classList.add('hidden');
  activeFeedIdx = -1;
}

async function loadFeedItems(idx) {
  const feed = rssFeeds[idx];
  document.getElementById('rss-empty').classList.add('hidden');
  document.getElementById('rss-items-wrap').classList.remove('hidden');
  const nameInput = document.getElementById('rss-feed-name-edit');
  if (nameInput) nameInput.value = feed.name || '';
  document.getElementById('rss-feed-auto').checked = !!feed.auto_download;
  document.getElementById('rss-items-list').innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:10px">${t('rss_loading')}</div>`;

  const r = await window.api.rss.fetch(feed.url);
  if (!r.ok) {
    document.getElementById('rss-items-list').innerHTML = `<div style="color:var(--danger);font-size:12px;padding:10px">Error: ${esc(r.error)}</div>`;
    return;
  }
  feed.last_fetched = new Date().toISOString();
  config.rss_feeds  = rssFeeds;
  window.api.config.save(config);
  renderRSSItems(r.items);
}

function getRSSItemType(item) {
  const url  = item.enclosureUrl || '';
  const type = item.enclosureType || '';
  if (item.magnet) return 'torrent';
  if (/\.torrent($|\?)/i.test(url) || /bittorrent/i.test(type)) return 'torrent';
  if (/\.(mp3|m4a|ogg|opus|flac|wav|aac)($|\?)/i.test(url) || /^audio\//i.test(type)) return 'audio';
  if (/\.(mp4|m4v|mkv|webm|avi|mov)($|\?)/i.test(url) || /^video\//i.test(type)) return 'video';
  return 'link';
}

function renderRSSItems(items) {
  const list = document.getElementById('rss-items-list');
  if (!items.length) {
    list.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:16px">${t('rss_no_items')}</div>`;
    return;
  }
  list.innerHTML = '';
  items.forEach(item => {
    const div  = document.createElement('div');
    div.className = 'rss-item';
    const date = item.pubDate ? formatDate(item.pubDate) : '';
    const type = getRSSItemType(item);

    // Helper: render a Lucide-icon action button with i18n label.
    const actBtn = (action, icon, i18nKey, extraClass = '') =>
      `<button class="btn-rss-action ${extraClass}" data-action="${action}" data-lucide-icon="${icon}"><span class="lucide-slot"></span>${esc(t(i18nKey))}</button>`;

    let typeBadge = '', actions = '';
    if (type === 'torrent') {
      typeBadge = '<span class="rss-type-badge rss-type-torrent">torrent</span>';
      actions =
        actBtn('save',  'download',  'rss_save',  'btn-torrent') +
        (item.magnet ? actBtn('copy', 'link', 'rss_copy', 'btn-copy') : '') +
        actBtn('queue', 'plus',      'rss_queue', 'btn-queue');
    } else if (type === 'audio' || type === 'video') {
      typeBadge = `<span class="rss-type-badge rss-type-media">${type}</span>`;
      actions =
        actBtn('media-play',  'play',     'rss_play',     'btn-play') +
        actBtn('media-dl',    'download', 'rss_download', 'btn-torrent') +
        actBtn('media-queue', 'plus',     'rss_queue',    'btn-queue');
    } else {
      typeBadge = '<span class="rss-type-badge rss-type-link">article</span>';
      actions = item.link
        ? actBtn('open', 'external-link', 'rss_open')
        : '';
    }

    // Layout: title on the left; the right column stacks date (small + bold)
    // above the type tag, plus the optional duration. Action buttons sit at
    // the bottom, all rendered through .btn-rss-action so sizes match.
    const dateBlock = `
      <div class="rss-item-side">
        <span class="rss-item-date">${esc(date)}</span>
        ${item.duration ? `<span class="rss-item-duration">${esc(item.duration)}</span>` : ''}
        ${typeBadge}
      </div>`;
    div.innerHTML = `
      <div class="rss-item-header">
        <span class="rss-item-title">${esc(item.title)}</span>
        ${dateBlock}
      </div>
      ${item.author ? `<div class="rss-item-author">— ${esc(item.author)}</div>` : ''}
      ${item.description ? `<div class="rss-item-desc">${esc(item.description)}</div>` : ''}
      <div class="rss-item-actions">${actions}</div>`;

    div.querySelector('[data-action="save"]')?.addEventListener('click',       () => saveRSSItem(item, type));
    div.querySelector('[data-action="copy"]')?.addEventListener('click',       () => copyRSSMagnet(item));
    div.querySelector('[data-action="queue"]')?.addEventListener('click',      () => queueRSSItem(item));
    div.querySelector('[data-action="media-play"]')?.addEventListener('click', () => {
      if (!item.enclosureUrl) return;
      const podTitle = item.title || item.enclosureUrl;
      playInGlobalPlayer({
        url: item.enclosureUrl,
        title: podTitle,
        source: type === 'video' ? '📺 podcast' : '🎙️ podcast',
        id: item.guid || item.enclosureUrl
      });
    });
    div.querySelector('[data-action="media-dl"]')?.addEventListener('click',   () => downloadRSSMedia(item, type));
    div.querySelector('[data-action="media-queue"]')?.addEventListener('click',() => queueRSSMedia(item, type));
    div.querySelector('[data-action="open"]')?.addEventListener('click',       () => window.api.shell.openExternal(item.link));
    list.appendChild(div);
  });
}

function formatDate(s) {
  try { const d = new Date(s); return isNaN(d) ? s : d.toLocaleDateString(); }
  catch { return s; }
}

async function copyRSSMagnet(item) {
  if (!item.magnet) { alert('No magnet link available.'); return; }
  await window.api.clipboard.write(item.magnet);
}

async function downloadRSSMedia(item, type) {
  if (!item.enclosureUrl) { alert('No media URL available.'); return; }
  switchTab('media');
  const urlInput = document.getElementById('media-url');
  urlInput.value = item.enclosureUrl;
  const fmt = type === 'audio' ? 'audio' : 'video';
  const fmtRadio = document.querySelector(`input[name="media-format"][value="${fmt}"]`);
  if (fmtRadio) fmtRadio.checked = true;
  // Fire the URL "check" (probe → title preview, and it re-enables the action
  // buttons), then make sure the download button is clickable before starting.
  // Setting .value programmatically doesn't dispatch 'input', so the probe
  // never ran and the (disabled) button ignored the click → nothing happened.
  urlInput.dispatchEvent(new Event('input', { bubbles: true }));
  setMediaButtonsEnabled(true);
  document.getElementById('media-download-btn').click();
}

function queueRSSMedia(item, type) {
  if (!item.enclosureUrl) return;
  const fmt = type === 'audio' ? 'audio' : 'video';
  queue.push({ id: newId(), type: 'media', name: item.title, url: item.enclosureUrl, format: fmt, status: 'pending', origin: type === 'audio' ? 'podcast' : 'rss' });
  window.api.queue.save(queue);
  renderQueue();
}

async function saveRSSItem(item) {
  // Mirror the Torrent-tab logic: if send-to-client is enabled, forward the
  // magnet / .torrent URL to the external client instead of saving locally.
  if (config.sendto_enabled && (item.magnet || item.enclosureUrl)) {
    const r = await window.api.sendto.torrent({ magnet: item.magnet || null, url: item.enclosureUrl || null, name: item.title });
    if (r.ok) appendLog('torrent-log', `✓ Sent to ${r.sentTo || 'client'}: ${item.title}`, 'ok');
    else      appendLog('torrent-log', `✗ Send-to-client failed: ${r.error}`, 'error');
    return;
  }
  if (item.magnet) {
    const r = await window.api.torrent.save({ item: { name: item.title, type: 'magnet', magnet: item.magnet, url: null }, downloadFolder: config.download_folder });
    if (r.ok) appendLog('torrent-log', `✓ Saved: ${r.path}`, 'ok');
  } else if (item.enclosureUrl) {
    const r = await window.api.torrent.save({ item: { name: item.title, type: 'torrent', url: item.enclosureUrl, magnet: null }, downloadFolder: config.download_folder });
    if (r.ok) appendLog('torrent-log', `✓ Saved: ${r.path}`, 'ok');
  }
}

function queueRSSItem(item) {
  const torrentItem = { name: item.title, type: item.magnet ? 'magnet' : 'torrent', magnet: item.magnet || null, url: item.enclosureUrl || null };
  queue.push({ id: newId(), type: 'torrent', name: item.title, torrentItem, status: 'pending', origin: 'rss' });
  window.api.queue.save(queue);
  renderQueue();
}

// ─── RSS AUTO-POLL (scheduler-driven) ────────────────────────────────────────
async function autoPollFeed(feedUrl, feedName) {
  const feedIdx = rssFeeds.findIndex(f => f.url === feedUrl);
  if (feedIdx < 0) return;
  const feed = rssFeeds[feedIdx];

  const r = await window.api.rss.fetch(feedUrl);
  if (!r.ok) return;

  const knownGuids = new Set(feed.last_guids || []);
  const newItems = r.items.filter(it => {
    const id = it.guid || it.link || it.title;
    return id && !knownGuids.has(id);
  });

  for (const item of newItems) {
    const type = getRSSItemType(item);
    if (type === 'audio' || type === 'video') {
      queueRSSMedia(item, type);
    } else if (type === 'torrent') {
      queueRSSItem(item);
    }
  }

  // Update last_guids with the latest 100 ids
  feed.last_guids   = r.items.slice(0, 100).map(it => it.guid || it.link || it.title).filter(Boolean);
  feed.last_fetched = new Date().toISOString();
  config.rss_feeds  = rssFeeds;
  await window.api.config.save(config);

  if (newItems.length && config.notify_on_done) {
    window.api.notify.show({ title: `FLUX — ${feedName}`, body: `${newItems.length} new item(s) added to queue` });
  }
}

// ─── NZB TAB ─────────────────────────────────────────────────────────────────
// Minimal NZB forwarder: pick a local .nzb file, ship it off to the
// configured SABnzbd / NZBGet over HTTP. The Settings → Integrations panel
// owns the actual config; this tab is just the trigger.
function bindNzb() {
  const pickBtn   = document.getElementById('nzb-pick-btn');
  const targetLbl = document.getElementById('nzb-target-label');
  // Surface where the file will land so the user has feedback even when
  // they haven't configured anything yet.
  function refreshTargetLabel() {
    if (!config.sendnzb_enabled || !config.sendnzb_url) {
      targetLbl.textContent = t('nzb_target_unconfigured') || 'NZB forwarding not configured — see Settings → Integrations';
      targetLbl.classList.add('nzb-target-warn');
    } else {
      targetLbl.textContent = `→ ${config.sendnzb_type === 'sabnzbd' ? 'SABnzbd' : 'NZBGet'} @ ${config.sendnzb_url}`;
      targetLbl.classList.remove('nzb-target-warn');
    }
  }
  pickBtn.addEventListener('click', async () => {
    refreshTargetLabel();
    if (!config.sendnzb_enabled || !config.sendnzb_url) {
      appendLog('nzb-log', `✗ ${t('nzb_target_unconfigured') || 'NZB forwarding not configured.'}`, 'error');
      return;
    }
    const r = await window.api.dialog.pickFile({
      title: t('nzb_pick_title') || 'Pick NZB file',
      filters: [{ name: 'NZB', extensions: ['nzb'] }]
    });
    if (!r || !r.path) return;
    appendLog('nzb-log', `↑ Sending: ${r.path}`, 'info');
    const res = await window.api.sendnzb.fromFile({ filePath: r.path });
    if (res.ok) {
      appendLog('nzb-log', `✓ Sent to ${res.sentTo}${res.id ? ` (id=${res.id})` : ''}`, 'ok');
      if (config.history_enabled !== false) {
        await window.api.history.append({ kind: 'nzb', name: r.path, ok: true, path: r.path, source: res.sentTo });
      }
      showToast({ title: t('nzb_sent_title') || 'NZB sent', body: r.path, kind: 'ok', ttl: 4000 });
    } else {
      appendLog('nzb-log', `✗ ${res.error}`, 'error');
    }
  });
  refreshTargetLabel();
  // Re-evaluate the target label after every Settings save so the user
  // sees the new config straight away without a tab switch.
  document.getElementById('cfg-save-btn')?.addEventListener('click', () => setTimeout(refreshTargetLabel, 100));
}

// ─── IRC / XDCC TAB ──────────────────────────────────────────────────────────
// Classic multi-channel IRC client. Each joined channel and each opened PM
// gets its own tab; a special Server tab holds MOTD/numerics/notices that
// don't belong to a specific room. Sending a message routes to the active
// tab. Double-clicking a user opens (or focuses) a PM tab for them.
//
// State layout:
//   tabs      : Map<key, { type:'server'|'channel'|'pm', name, messages:[], users:Set, unread:number }>
//                key = ':server' for the server tab, channel name for channels,
//                bare nick for PMs.
//   activeTab : current key shown in the chat pane.
//   transfers : id → row DOM for DCC progress (unchanged).
//   channelList / channelListLoading: state for the /LIST modal.
const IRC_SERVER_KEY = ':server';
const ircSessionState = {
  connected: false,
  transfers: new Map(),
  channelList: [],
  channelListLoading: false,
  tabs: new Map(),
  activeTab: null
};

function bindIrc() {
  const $ = id => document.getElementById(id);
  const connectBtn  = $('irc-connect-btn');
  const disconnect  = $('irc-disconnect-btn');
  const joinBtn     = $('irc-join-btn');
  const listBtn     = $('irc-list-btn');
  const statusEl    = $('irc-status');
  const transfersEl = $('irc-transfers');
  const tabsEl      = $('irc-tabs');
  const chatLogEl   = $('irc-chat-log');
  const msgInput    = $('irc-msg-input');
  const msgSendBtn  = $('irc-msg-send');
  const usersPanel  = $('irc-users-panel');
  const usersList   = $('irc-users-list');
  const usersFilter = $('irc-users-filter');

  // ── Tab management ──────────────────────────────────────────────────────
  // Tabs live in ircSessionState.tabs (Map). The server tab is the default
  // home for messages without a channel context (MOTD, errors, notices).
  function ensureTab(key, type, displayName) {
    let tab = ircSessionState.tabs.get(key);
    if (!tab) {
      tab = { type, name: displayName || key, messages: [], users: new Set(), unread: 0 };
      ircSessionState.tabs.set(key, tab);
      renderTabs();
    }
    return tab;
  }
  function getTab(key) { return ircSessionState.tabs.get(key); }

  // Append a log line to a tab. If the tab is active, push to DOM too.
  // Otherwise increment unread and refresh the tab strip only.
  function addLine(key, text, kind = 'system') {
    const tab = getTab(key);
    if (!tab) return;
    const entry = { text, kind, ts: Date.now() };
    tab.messages.push(entry);
    // Cap per-tab buffer so a chatty channel doesn't eat memory.
    if (tab.messages.length > 2000) tab.messages.splice(0, tab.messages.length - 2000);
    if (ircSessionState.activeTab === key) {
      appendLineToDom(entry);
    } else {
      tab.unread++;
      renderTabs();
    }
  }
  function appendLineToDom(entry) {
    const wasAtBottom = (chatLogEl.scrollHeight - chatLogEl.scrollTop - chatLogEl.clientHeight) < 40;
    const line = document.createElement('div');
    line.className = `log-line log-${entry.kind || 'system'}`;
    line.textContent = entry.text;
    chatLogEl.appendChild(line);
    if (wasAtBottom) chatLogEl.scrollTop = chatLogEl.scrollHeight;
  }
  function repaintChatLog() {
    const tab = getTab(ircSessionState.activeTab);
    chatLogEl.innerHTML = '';
    if (!tab) return;
    for (const m of tab.messages) {
      const line = document.createElement('div');
      line.className = `log-line log-${m.kind || 'system'}`;
      line.textContent = m.text;
      chatLogEl.appendChild(line);
    }
    chatLogEl.scrollTop = chatLogEl.scrollHeight;
  }

  function renderTabs() {
    const entries = [...ircSessionState.tabs.entries()];
    tabsEl.innerHTML = entries.map(([key, tab]) => {
      const active = key === ircSessionState.activeTab;
      const label = tab.type === 'pm' ? `@${tab.name}` : tab.name;
      const unread = tab.unread > 0 ? `<span class="irc-tab-unread">${tab.unread}</span>` : '';
      const closable = tab.type !== 'server';
      const closeBtn = closable
        ? `<span class="irc-tab-close" data-close="${esc(key)}" title="${esc(t('rss_close'))}">×</span>`
        : '';
      // Channel tab tooltip carries the user count — replaces the header
      // strip we removed from the user panel.
      const tooltip = tab.type === 'channel' && tab.users.size
        ? ` title="${tab.users.size} users"`
        : '';
      return `<div class="irc-tab ${active?'active':''}" data-tab="${esc(key)}"${tooltip}>
        <span class="irc-tab-label">${esc(label)}</span>${unread}${closeBtn}
      </div>`;
    }).join('');
  }

  function setActiveTab(key) {
    const tab = getTab(key);
    if (!tab) return;
    ircSessionState.activeTab = key;
    tab.unread = 0;
    renderTabs();
    repaintChatLog();
    // Users panel only makes sense for channels. PM / Server tabs hide it.
    if (tab.type === 'channel') {
      usersPanel.classList.remove('hidden');
      renderUserList();
    } else {
      usersPanel.classList.add('hidden');
    }
    // Update input state — server tab can't accept PRIVMSG.
    const canType = ircSessionState.connected && tab.type !== 'server';
    msgInput.disabled    = !canType;
    msgSendBtn.disabled  = !canType;
    msgInput.placeholder = tab.type === 'server'
      ? (t('irc_server_tab_hint') || 'Server tab — pick a channel/PM tab to chat')
      : (t('irc_msg_ph') || 'Type a message and press Enter…');
    if (canType) msgInput.focus();
  }

  function closeTab(key) {
    const tab = getTab(key);
    if (!tab || tab.type === 'server') return;   // never close server
    if (tab.type === 'channel' && ircSessionState.connected) {
      window.api.irc.raw({ line: `PART ${tab.name}` });
    }
    ircSessionState.tabs.delete(key);
    if (ircSessionState.activeTab === key) {
      // Switch to whichever tab is next in insertion order (Server is always
      // first, so this falls back to it when no other tabs exist).
      const next = [...ircSessionState.tabs.keys()][0];
      if (next) setActiveTab(next);
      else      ircSessionState.activeTab = null;
    } else {
      renderTabs();
    }
  }

  tabsEl.addEventListener('click', e => {
    const closeBtn = e.target.closest('.irc-tab-close');
    if (closeBtn) { e.stopPropagation(); closeTab(closeBtn.dataset.close); return; }
    const tab = e.target.closest('.irc-tab');
    if (tab) setActiveTab(tab.dataset.tab);
  });

  // ── Vertical splitter (resize main area height) ────────────────────────
  // Drag the horizontal bar below the IRC pane to resize how tall the
  // chat + user-list block is. Persisted to config.irc_main_h.
  {
    const vsplit = $('irc-vsplitter');
    const main   = $('irc-main');
    let dragging = false, startY = 0, startH = 0;
    if (config.irc_main_h) main.style.setProperty('--irc-main-h', config.irc_main_h);
    vsplit.addEventListener('mousedown', e => {
      dragging = true;
      startY = e.clientY;
      startH = main.getBoundingClientRect().height;
      vsplit.classList.add('is-dragging');
      document.body.classList.add('irc-vsplitter-active');
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      // Clamp 240..viewport-200 so neither end is unusable.
      const h = Math.max(240, Math.min(window.innerHeight - 200, startH + (e.clientY - startY)));
      main.style.setProperty('--irc-main-h', `${Math.round(h)}px`);
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      vsplit.classList.remove('is-dragging');
      document.body.classList.remove('irc-vsplitter-active');
      config.irc_main_h = main.style.getPropertyValue('--irc-main-h') || '';
      window.api.config.save(config);
    });
  }

  // ── User-panel splitter ─────────────────────────────────────────────────
  // Drag the 4px vertical bar between chat pane and user panel to resize
  // the user column. Width is stored on the .irc-main element's
  // --irc-users-w custom property; values clamp to a sane range so neither
  // side can collapse entirely. Persisted to config.irc_users_w.
  {
    const splitter = $('irc-splitter');
    const main     = $('irc-main');
    let dragging = false;
    // Restore previous width if the user resized last session.
    if (config.irc_users_w) main.style.setProperty('--irc-users-w', config.irc_users_w);
    splitter.addEventListener('mousedown', e => {
      dragging = true;
      splitter.classList.add('is-dragging');
      document.body.classList.add('irc-splitter-active');
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const r = main.getBoundingClientRect();
      // 4px splitter, leave at least 200px for chat and 120px for users.
      const minRight = 120;
      const maxRight = Math.max(minRight, r.width - 200 - 4);
      const w = Math.max(minRight, Math.min(maxRight, r.right - e.clientX));
      main.style.setProperty('--irc-users-w', `${Math.round(w)}px`);
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove('is-dragging');
      document.body.classList.remove('irc-splitter-active');
      config.irc_users_w = main.style.getPropertyValue('--irc-users-w') || '20%';
      window.api.config.save(config);
    });
  }

  // ── Connection UI ──────────────────────────────────────────────────────
  // Only ONE of Connect/Disconnect is visible at a time — toggled via
  // .hidden. The status dot communicates the live state separately.
  function setConnectedUI(on, label) {
    ircSessionState.connected = on;
    connectBtn.classList.toggle('hidden', on);
    disconnect.classList.toggle('hidden', !on);
    // Whole channels row appears only when connected — hides Join / List
    // entirely when offline instead of just disabling them.
    document.getElementById('irc-channel-row')?.classList.toggle('hidden', !on);
    joinBtn.disabled    = !on;
    listBtn.disabled    = !on;
    const tab = getTab(ircSessionState.activeTab);
    const canType = on && tab && tab.type !== 'server';
    msgInput.disabled   = !canType;
    msgSendBtn.disabled = !canType;
    statusEl.title = label || (on ? 'Connected' : 'Disconnected');
    statusEl.classList.remove('connected', 'connecting');
    if (label === '… connecting' || (typeof label === 'string' && label.startsWith('…'))) {
      statusEl.classList.add('connecting');
    } else if (on) {
      statusEl.classList.add('connected');
    }
  }
  setConnectedUI(false);

  // ── Channel list modal (LIST → 322/323) ─────────────────────────────────
  // Renders the filtered list in 100-row pages. "Load more" reveals the
  // next 100 until the buffered list runs out. Bigger networks return
  // thousands of channels — pagination keeps the DOM small and the modal
  // responsive even with 3k+ entries in memory.
  const channelsModal     = $('irc-channels-modal');
  const channelsTbody     = $('irc-channels-tbody');
  const channelsFilter    = $('irc-channels-filter');
  const channelsStatus    = $('irc-channels-status');
  const channelsMoreBtn   = $('irc-channels-more');
  const channelsMoreInfo  = $('irc-channels-more-info');
  const IRC_LIST_PAGE = 100;
  let ircListShown = IRC_LIST_PAGE;

  function getFilteredChannels() {
    const q = channelsFilter.value.trim().toLowerCase();
    return ircSessionState.channelList
      .filter(c => !q || c.channel.toLowerCase().includes(q) || (c.topic || '').toLowerCase().includes(q))
      .sort((a, b) => b.users - a.users);
  }
  function renderChannelList() {
    const all = getFilteredChannels();
    const rows = all.slice(0, ircListShown);
    // Inline plus-icon SVG so we don't depend on Lucide rendering after the
    // innerHTML rewrite. 14×14 viewbox matches other btn-icon-join SVGs.
    const joinIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    channelsTbody.innerHTML = rows.map(c => `
      <tr data-channel="${esc(c.channel)}">
        <td class="irc-ch-join">
          <button type="button" class="btn-icon-join" data-join="${esc(c.channel)}" title="${esc(t('irc_join'))} ${esc(c.channel)}">${joinIcon}</button>
        </td>
        <td class="irc-ch-name" title="${esc(c.channel)}"><strong>${esc(c.channel)}</strong></td>
        <td>${c.users}</td>
        <td class="td-name" title="${esc(c.topic || '')}">${esc(c.topic || '')}</td>
      </tr>`).join('');
    const total = ircSessionState.channelList.length;
    channelsStatus.textContent = ircSessionState.channelListLoading
      ? `${total} loaded…`
      : `${total}`;
    const remaining = all.length - rows.length;
    if (remaining > 0) {
      channelsMoreBtn.disabled = false;
      channelsMoreBtn.classList.remove('hidden');
      channelsMoreBtn.textContent = (t('irc_load_more_n') || 'Load {n} more').replace('{n}', Math.min(IRC_LIST_PAGE, remaining));
      channelsMoreInfo.textContent = `${rows.length} / ${all.length}`;
    } else {
      channelsMoreBtn.classList.add('hidden');
      channelsMoreInfo.textContent = all.length ? `${rows.length}` : '';
    }
  }
  channelsMoreBtn.addEventListener('click', () => {
    ircListShown += IRC_LIST_PAGE;
    renderChannelList();
  });
  // Click on join-icon OR double-click anywhere on the row both join the
  // channel and close the modal.
  channelsTbody.addEventListener('click', (e) => {
    const joinBtn = e.target.closest('[data-join]');
    if (!joinBtn) return;
    window.api.irc.join({ channel: joinBtn.dataset.join });
    channelsModal.classList.add('hidden');
  });
  channelsTbody.addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr[data-channel]');
    if (!tr) return;
    window.api.irc.join({ channel: tr.dataset.channel });
    channelsModal.classList.add('hidden');
  });
  channelsFilter.addEventListener('input', () => {
    ircListShown = IRC_LIST_PAGE;     // reset paging on filter change
    renderChannelList();
  });
  $('irc-channels-close').addEventListener('click', () => channelsModal.classList.add('hidden'));
  listBtn.addEventListener('click', async () => {
    ircSessionState.channelList = [];
    ircSessionState.channelListLoading = true;
    ircListShown = IRC_LIST_PAGE;
    channelsFilter.value = '';
    renderChannelList();
    channelsModal.classList.remove('hidden');
    addLine(IRC_SERVER_KEY, '→ LIST', 'system');
    await window.api.irc.raw({ line: 'LIST' });
  });

  // ── User list panel (NAMES → 353/366) ───────────────────────────────────
  function renderUserList() {
    const key = ircSessionState.activeTab;
    const tab = getTab(key);
    if (!tab || tab.type !== 'channel') return;
    const users = [...tab.users];
    const q = usersFilter.value.trim().toLowerCase();
    const stripPrefix = u => u.replace(/^[~&@%+]/, '');
    const filtered = users
      .filter(u => !q || stripPrefix(u).toLowerCase().includes(q))
      .sort((a, b) => stripPrefix(a).localeCompare(stripPrefix(b), undefined, { sensitivity: 'base' }));
    usersList.innerHTML = filtered.map(u => {
      const bare = stripPrefix(u);
      const prefix = u.charAt(0) !== bare.charAt(0) ? u.charAt(0) : '';
      return `<li class="irc-user-item" data-nick="${esc(bare)}">
        <span class="irc-user-prefix">${esc(prefix)}</span>
        <span class="irc-user-nick">${esc(bare)}</span>
      </li>`;
    }).join('');
    // Channel tabs also surface a tooltip with the current user count.
    renderTabs();
  }
  usersFilter.addEventListener('input', renderUserList);

  // ── WHOIS popup ─────────────────────────────────────────────────────────
  // Single-click on a user fires a WHOIS query and opens this popup. The
  // numeric replies (311/312/317/319/330/671/301) accumulate into the
  // `whoisState` object and the popup refreshes whenever a new piece
  // arrives. 318 (end-of-WHOIS) marks the data complete. Double-click on
  // a user still opens a PM tab (faster than clicking "Send PM" in popup).
  const whoisModal = $('irc-whois-modal');
  let whoisState = null;   // { nick, user, host, realname, server, signon, idleSec, account, secure, away, channels[] }
  function fmtRelative(secAgo) {
    if (!Number.isFinite(secAgo) || secAgo < 0) return '—';
    if (secAgo < 60)   return `${secAgo}s`;
    if (secAgo < 3600) return `${Math.floor(secAgo / 60)}m ${secAgo % 60}s`;
    if (secAgo < 86400) return `${Math.floor(secAgo / 3600)}h ${Math.floor((secAgo % 3600) / 60)}m`;
    return `${Math.floor(secAgo / 86400)}d ${Math.floor((secAgo % 86400) / 3600)}h`;
  }
  function fmtTimestamp(epochSec) {
    if (!Number.isFinite(epochSec) || epochSec <= 0) return '—';
    const d = new Date(epochSec * 1000);
    return d.toLocaleString();
  }
  function renderWhoisModal() {
    if (!whoisState) return;
    $('irc-whois-nick').textContent = whoisState.nick;
    const isAway = whoisState.away != null;
    const isLoading = !whoisState.complete;
    const statusEl = $('irc-whois-status');
    if (isLoading) {
      statusEl.textContent = t('irc_whois_loading') || 'loading…';
      statusEl.className = 'irc-whois-status loading';
    } else if (isAway) {
      statusEl.textContent = t('irc_whois_status_away') || 'away';
      statusEl.className = 'irc-whois-status away';
    } else {
      statusEl.textContent = t('irc_whois_status_online') || 'online';
      statusEl.className = 'irc-whois-status';
    }
    $('irc-whois-realname').textContent = whoisState.realname || '—';
    $('irc-whois-account').textContent  = whoisState.account  || '—';
    $('irc-whois-host').textContent     = (whoisState.user || whoisState.host)
        ? `${whoisState.user || '?'}@${whoisState.host || '?'}` : '—';
    $('irc-whois-server').textContent   = whoisState.server   || '—';
    $('irc-whois-signon').textContent   = fmtTimestamp(whoisState.signon);
    $('irc-whois-idle').textContent     = whoisState.idleSec != null ? fmtRelative(whoisState.idleSec) : '—';
    $('irc-whois-away').textContent     = whoisState.away    || '—';
    // SSL row removed from UI per design — flag still tracked in state in
    // case we expose it elsewhere later.
    const chBox = $('irc-whois-channels');
    if (whoisState.channels && whoisState.channels.length) {
      chBox.innerHTML = whoisState.channels.map(c => {
        // Channel entries may carry mode-prefix (@, +) — keep visible but
        // strip when joining/displaying chip text.
        const bare = c.replace(/^[~&@%+]/, '');
        return `<span class="irc-whois-channel-chip" data-channel="${esc(bare)}">${esc(c)}</span>`;
      }).join('');
    } else {
      chBox.textContent = '—';
    }
  }
  // Click a channel chip in the WHOIS popup → JOIN that channel.
  $('irc-whois-channels').addEventListener('click', e => {
    const chip = e.target.closest('[data-channel]');
    if (!chip) return;
    window.api.irc.join({ channel: chip.dataset.channel });
    whoisModal.classList.add('hidden');
  });
  $('irc-whois-close').addEventListener('click', () => whoisModal.classList.add('hidden'));
  $('irc-whois-pm').addEventListener('click', () => {
    if (!whoisState) return;
    ensureTab(whoisState.nick, 'pm', whoisState.nick);
    setActiveTab(whoisState.nick);
    whoisModal.classList.add('hidden');
  });
  function openWhois(nick) {
    whoisState = { nick, channels: [], complete: false };
    renderWhoisModal();
    whoisModal.classList.remove('hidden');
    window.api.irc.raw({ line: `WHOIS ${nick}` });
  }

  // Single-click on a user → open WHOIS popup. Double-click → PM tab.
  usersList.addEventListener('click', e => {
    const li = e.target.closest('.irc-user-item');
    if (!li) return;
    openWhois(li.dataset.nick);
  });
  usersList.addEventListener('dblclick', e => {
    const li = e.target.closest('.irc-user-item');
    if (!li) return;
    const nick = li.dataset.nick;
    ensureTab(nick, 'pm', nick);
    setActiveTab(nick);
  });

  // ── Server / nick defaults + randomised nick + TLS + SASL ──────────────
  $('irc-server').value = config.irc_server ? `${config.irc_server}:${config.irc_port || 6667}` : '';
  function randomNick() { return `FluxUser-${Math.floor(Math.random() * 90000) + 10000}`; }
  if (!config.irc_nick || config.irc_nick === 'FluxUser') {
    config.irc_nick = randomNick();
    window.api.config.save(config);
  }
  $('irc-nick').value             = config.irc_nick;
  $('irc-tls').checked            = !!config.irc_tls;
  $('irc-sasl-enabled').checked   = !!config.irc_sasl_enabled;
  $('irc-sasl-account').value     = config.irc_sasl_account || '';
  $('irc-sasl-password').value    = config.irc_sasl_password || '';

  // SASL fields follow the SASL switch — off → inputs grayed and ignored.
  function syncSaslFields() {
    const on = $('irc-sasl-enabled').checked;
    $('irc-sasl-account').disabled  = !on;
    $('irc-sasl-password').disabled = !on;
  }
  $('irc-sasl-enabled').addEventListener('change', syncSaslFields);
  syncSaslFields();

  // "Advanced" toggle — collapses the security row (TLS + SASL). Always
  // starts hidden, even when TLS/SASL are configured: the saved settings
  // still apply on connect; the user explicitly opens the row only when
  // they want to inspect or change them.
  const advRow = $('irc-advanced-row');
  $('irc-advanced-toggle').addEventListener('click', () => {
    advRow.classList.toggle('hidden');
  });

  // When the user flips TLS, swap the default port: 6697 (TLS) ↔ 6667 (plain).
  // Only auto-swap if the current input is the previous default — don't
  // overwrite a custom port the user typed.
  $('irc-tls').addEventListener('change', () => {
    const checked = $('irc-tls').checked;
    const cur = $('irc-server').value.trim();
    const m = cur.match(/^(.+?):(\d+)$/);
    if (m && (m[2] === '6667' || m[2] === '6697')) {
      $('irc-server').value = `${m[1]}:${checked ? 6697 : 6667}`;
    }
  });

  // ── Connect / disconnect / join ────────────────────────────────────────
  connectBtn.addEventListener('click', async () => {
    const raw = $('irc-server').value.trim();
    const nick = ($('irc-nick').value || 'FluxUser').trim();
    if (!raw) { addLine(IRC_SERVER_KEY, 'Set a server first (host or host:port).', 'error'); return; }
    const [host, portStr] = raw.split(':');
    const useTls = $('irc-tls').checked;
    const port = parseInt(portStr, 10) || (useTls ? 6697 : 6667);
    // Persist all the new fields. SASL creds live in config and are read by
    // main.js at connect time — they never travel over the IPC payload, so
    // they don't show up in any renderer-side logs / dev-tools traces.
    config.irc_server         = host;
    config.irc_port           = port;
    config.irc_nick           = nick;
    config.irc_tls            = useTls;
    config.irc_sasl_enabled   = $('irc-sasl-enabled').checked;
    config.irc_sasl_account   = $('irc-sasl-account').value.trim();
    config.irc_sasl_password  = $('irc-sasl-password').value;
    window.api.config.save(config);
    ensureTab(IRC_SERVER_KEY, 'server', t('irc_server_tab') || 'Server');
    if (!ircSessionState.activeTab) setActiveTab(IRC_SERVER_KEY);
    const xfer = useTls ? 'TLS' : 'plain';
    const sasl = (config.irc_sasl_enabled && config.irc_sasl_account) ? ', SASL' : '';
    const proxy = config.socks_enabled && config.socks_host ? `, via SOCKS5 ${config.socks_host}:${config.socks_port}` : '';
    addLine(IRC_SERVER_KEY, `→ Connecting ${host}:${port} as ${nick} (${xfer}${sasl}${proxy})…`, 'system');
    setConnectedUI(false, '… connecting');
    const r = await window.api.irc.connect({ server: host, port, nick, tls: useTls });
    if (!r.ok) { addLine(IRC_SERVER_KEY, `✗ ${r.error}`, 'error'); setConnectedUI(false); return; }
    if (r.warn) addLine(IRC_SERVER_KEY, `! ${r.warn}`, 'system');
  });

  disconnect.addEventListener('click', async () => {
    await window.api.irc.disconnect();
    setConnectedUI(false);
  });

  joinBtn.addEventListener('click', async () => {
    let ch = $('irc-channel').value.trim();
    if (!ch) return;
    if (!ch.startsWith('#') && !ch.startsWith('&')) ch = '#' + ch;
    const r = await window.api.irc.join({ channel: ch });
    if (!r.ok) addLine(IRC_SERVER_KEY, `✗ join failed: ${r.error}`, 'error');
  });

  // ── Send a message to the active tab ────────────────────────────────────
  const doSend = async () => {
    const text = msgInput.value.trim();
    if (!text) return;
    const tab = getTab(ircSessionState.activeTab);
    if (!tab || tab.type === 'server') return;
    const target = tab.name;
    const r = await window.api.irc.send({ target, message: text });
    if (!r.ok) { addLine(ircSessionState.activeTab, `✗ send failed: ${r.error}`, 'error'); return; }
    addLine(ircSessionState.activeTab, `<${config.irc_nick}> ${text}`, 'self');
    msgInput.value = '';
  };
  msgSendBtn.addEventListener('click', doSend);
  msgInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSend(); });

  // ── DCC transfer rows (unchanged from previous impl) ────────────────────
  function renderTransferRow(id, { filename, size, received, status, error, path, speed, etaSec, resumed }) {
    let row = ircSessionState.transfers.get(id)?.row;
    if (!row) {
      row = document.createElement('div');
      row.className = 'irc-transfer-row';
      row.innerHTML = `
        <div class="irc-transfer-name"></div>
        <div class="irc-transfer-bar"><div class="irc-transfer-bar-fill"></div></div>
        <div class="irc-transfer-meta"></div>
        <button class="btn-icon btn-icon-danger irc-transfer-cancel" data-i18n-title="downloads_cancel" title="Cancel" data-lucide-icon="x"></button>`;
      transfersEl.appendChild(row);
      ircSessionState.transfers.set(id, { row, filename, size });
      // Cancel button → IPC. Partial file stays on disk so the next XDCC
      // request from the same bot can RESUME from where we stopped.
      row.querySelector('.irc-transfer-cancel')?.addEventListener('click', async () => {
        await window.api.irc.cancelTransfer(id);
      });
      applyLucideIcons(row);
    }
    if (filename) row.querySelector('.irc-transfer-name').textContent =
      (resumed ? '↻ ' : '↓ ') + filename;
    const fill = row.querySelector('.irc-transfer-bar-fill');
    const meta = row.querySelector('.irc-transfer-meta');
    if (size > 0 && received != null) {
      const pct = Math.min(100, Math.round((received / size) * 100));
      fill.style.width = pct + '%';
      // Compose: "X / Y (pct%) · speed · ETA". Speed + ETA omitted when
      // we don't have them yet (first 250 ms or status update events).
      let line = `${fmtBytes(received)} / ${fmtBytes(size)} (${pct}%)`;
      if (typeof speed === 'number' && speed > 0) line += ` · ${fmtBytes(speed)}/s`;
      if (typeof etaSec === 'number' && etaSec > 0 && Number.isFinite(etaSec)) {
        line += ` · ETA ${fmtDuration(etaSec)}`;
      }
      meta.textContent = line;
    } else if (received != null) {
      meta.textContent = fmtBytes(received);
    }
    const cancelBtn = row.querySelector('.irc-transfer-cancel');
    if (status === 'done')      { row.classList.add('done');      meta.textContent = `✓ ${path || filename}`; if (cancelBtn) cancelBtn.style.display = 'none'; }
    if (status === 'error')     { row.classList.add('error');     meta.textContent = `✗ ${error || 'failed'}`; if (cancelBtn) cancelBtn.style.display = 'none'; }
    if (status === 'cancelled') { row.classList.add('cancelled'); meta.textContent = `⊘ Cancelled at ${fmtBytes(received || 0)} — partial kept for resume`; if (cancelBtn) cancelBtn.style.display = 'none'; }
  }

  // Format a duration in seconds → "MMm SSs" or "HHh MMm" for long ones.
  function fmtDuration(sec) {
    sec = Math.round(sec);
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  }

  // ── Event stream from main.js ──────────────────────────────────────────
  window.api.irc.onEvent(ev => {
    const me = config.irc_nick || '';
    switch (ev.type) {
      case 'connected':
        ensureTab(IRC_SERVER_KEY, 'server', t('irc_server_tab') || 'Server');
        if (!ircSessionState.activeTab) setActiveTab(IRC_SERVER_KEY);
        setConnectedUI(true, `● ${ev.nick}@${ev.server}`);
        addLine(IRC_SERVER_KEY, `✓ Connected as ${ev.nick}`, 'system');
        break;
      case 'disconnected':
        setConnectedUI(false);
        addLine(IRC_SERVER_KEY, '○ Disconnected', 'system');
        break;
      case 'sasl':
        addLine(IRC_SERVER_KEY, ev.ok ? '✓ SASL authentication successful' : `✗ SASL failed: ${ev.error}`, ev.ok ? 'system' : 'error');
        break;
      case 'error':
        addLine(IRC_SERVER_KEY, `✗ ${ev.error}`, 'error');
        break;
      case 'message': {
        // PRIVMSG. If addressed to me → it's a PM, route to (and auto-open)
        // a tab keyed by the sender. Otherwise route to the channel tab.
        if (ev.target === me) {
          ensureTab(ev.from, 'pm', ev.from);
          addLine(ev.from, `<${ev.from}> ${ev.text}`, 'other');
        } else {
          ensureTab(ev.target, 'channel', ev.target);
          addLine(ev.target, `<${ev.from}> ${ev.text}`, 'other');
        }
        break;
      }
      case 'notice':
        // Notices that target a channel land there; otherwise Server tab.
        if (ev.target && (ev.target.startsWith('#') || ev.target.startsWith('&'))) {
          ensureTab(ev.target, 'channel', ev.target);
          addLine(ev.target, `-${ev.from}- ${ev.text}`, 'notice');
        } else {
          addLine(IRC_SERVER_KEY, `-${ev.from}- ${ev.text}`, 'notice');
        }
        break;
      case 'join': {
        // Self-join: create the channel tab + focus it. NAMES (353) arrives
        // right after and populates the user list.
        if (ev.from === me) {
          const tab = ensureTab(ev.channel, 'channel', ev.channel);
          tab.users = new Set();
          setActiveTab(ev.channel);
        } else {
          const tab = getTab(ev.channel);
          if (tab) {
            tab.users.add(ev.from);
            addLine(ev.channel, `→ ${ev.from} joined`, 'system');
            if (ircSessionState.activeTab === ev.channel) renderUserList();
          }
        }
        break;
      }
      case 'part': {
        const tab = getTab(ev.channel);
        if (!tab) break;
        if (ev.from === me) {
          // Server forced us off; remove the tab.
          ircSessionState.tabs.delete(ev.channel);
          if (ircSessionState.activeTab === ev.channel) {
            const next = [...ircSessionState.tabs.keys()][0];
            if (next) setActiveTab(next);
            else      ircSessionState.activeTab = null;
          }
          renderTabs();
        } else {
          for (const u of [...tab.users]) {
            if (u.replace(/^[~&@%+]/, '') === ev.from) tab.users.delete(u);
          }
          addLine(ev.channel, `← ${ev.from} left`, 'system');
          if (ircSessionState.activeTab === ev.channel) renderUserList();
        }
        break;
      }
      case 'quit':
        for (const [key, tab] of ircSessionState.tabs.entries()) {
          if (tab.type !== 'channel') continue;
          let found = false;
          for (const u of [...tab.users]) {
            if (u.replace(/^[~&@%+]/, '') === ev.from) { tab.users.delete(u); found = true; }
          }
          if (found) {
            addLine(key, `← ${ev.from} quit${ev.reason ? ` (${ev.reason})` : ''}`, 'system');
            if (ircSessionState.activeTab === key) renderUserList();
          }
        }
        break;
      case 'nick-change':
        for (const [key, tab] of ircSessionState.tabs.entries()) {
          if (tab.type !== 'channel') continue;
          for (const u of [...tab.users]) {
            const prefix = u.match(/^[~&@%+]/)?.[0] || '';
            const bare = u.slice(prefix.length);
            if (bare === ev.from) { tab.users.delete(u); tab.users.add(prefix + ev.to); }
          }
          if (ircSessionState.activeTab === key) renderUserList();
        }
        break;
      case 'numeric': {
        const code = ev.code;
        const p = ev.params || [];
        if (code === '322') {
          ircSessionState.channelList.push({
            channel: p[1] || '', users: parseInt(p[2], 10) || 0, topic: p[3] || ''
          });
          if (ircSessionState.channelList.length % 100 === 0) renderChannelList();
        } else if (code === '323') {
          ircSessionState.channelListLoading = false;
          renderChannelList();
          addLine(IRC_SERVER_KEY, `✓ LIST: ${ircSessionState.channelList.length} channels`, 'system');
        } else if (code === '353') {
          // params: [myNick, "=", channel, "nick1 nick2 …"]
          const channel = p[2] || '';
          const tab = ensureTab(channel, 'channel', channel);
          for (const n of (p[3] || '').split(/\s+/).filter(Boolean)) tab.users.add(n);
          if (ircSessionState.activeTab === channel) renderUserList();
        } else if (code === '366') {
          if (ircSessionState.activeTab === (p[1] || '')) renderUserList();
        } else if (code === '311' && whoisState?.nick === p[1]) {
          // RPL_WHOISUSER: [myNick, nick, user, host, "*", :realname]
          whoisState.user = p[2]; whoisState.host = p[3]; whoisState.realname = p[5] || '';
          renderWhoisModal();
        } else if (code === '312' && whoisState?.nick === p[1]) {
          // RPL_WHOISSERVER: [myNick, nick, server, :serverInfo]
          whoisState.server = p[2];
          renderWhoisModal();
        } else if (code === '317' && whoisState?.nick === p[1]) {
          // RPL_WHOISIDLE: [myNick, nick, idleSeconds, signonTimestamp, :text]
          whoisState.idleSec = parseInt(p[2], 10);
          whoisState.signon  = parseInt(p[3], 10);
          renderWhoisModal();
        } else if (code === '319' && whoisState?.nick === p[1]) {
          // RPL_WHOISCHANNELS: [myNick, nick, :@#chan1 +#chan2 …]
          const list = (p[2] || '').split(/\s+/).filter(Boolean);
          // Concatenate across multiple 319 replies (servers may split long lists).
          whoisState.channels = (whoisState.channels || []).concat(list);
          renderWhoisModal();
        } else if (code === '330' && whoisState?.nick === p[1]) {
          // RPL_WHOISACCOUNT: [myNick, nick, account, :is logged in as]
          whoisState.account = p[2];
          renderWhoisModal();
        } else if (code === '671' && whoisState?.nick === p[1]) {
          // RPL_WHOISSECURE: [myNick, nick, :is using a secure connection]
          whoisState.secure = true;
          renderWhoisModal();
        } else if (code === '301' && whoisState?.nick === p[1]) {
          // RPL_AWAY: [myNick, nick, :away message]
          whoisState.away = p[2] || '(away)';
          renderWhoisModal();
        } else if (code === '318') {
          // RPL_ENDOFWHOIS — terminator. Lock in the popup as "complete"
          // (so the status badge swaps from "loading…" to online/away).
          if (whoisState?.nick === p[1]) { whoisState.complete = true; renderWhoisModal(); }
        } else if (['372', '375', '376', '001', '002', '003', '004', '433'].includes(code)) {
          addLine(IRC_SERVER_KEY, `[${code}] ${ev.text || p.join(' ')}`, 'system');
        }
        break;
      }
      case 'transfer-start': {
        const tag = ev.resumed ? `↻ XDCC RESUME` : `↓ XDCC SEND`;
        const fromAt = ev.resumed && ev.resumeFrom ? ` (resuming from ${fmtBytes(ev.resumeFrom)})` : '';
        addLine(IRC_SERVER_KEY, `${tag} from ${ev.from}: ${ev.filename} (${fmtBytes(ev.size)})${fromAt}`, 'system');
        renderTransferRow(ev.id, { filename: ev.filename, size: ev.size, received: ev.resumeFrom || 0, resumed: !!ev.resumed });
        break;
      }
      case 'transfer-progress':
        renderTransferRow(ev.id, {
          received: ev.received, size: ev.size,
          speed: ev.speed, etaSec: ev.etaSec
        });
        break;
      case 'transfer-done': {
        renderTransferRow(ev.id, { status: 'done', path: ev.path });
        const prefix = ev.alreadyHad ? '◇ Already complete' : '✓ DCC saved';
        addLine(IRC_SERVER_KEY, `${prefix}: ${ev.path}`, 'system');
        if (!ev.alreadyHad && config.history_enabled !== false) {
          window.api.history.append({ kind: 'irc', name: ev.path, ok: true, path: ev.path, source: 'xdcc' });
        }
        const isAudio = /\.(mp3|flac|m4a|opus|ogg|wav|aac)$/i.test(ev.path);
        if (!ev.alreadyHad && isAudio) autoTagAfterDownload(ev.path, null, 'irc-log');
        else if (!ev.alreadyHad)      { notifyMediaServer({ kind: 'irc', path: ev.path });
                                        autoOrganizeImage(ev.path, 'irc-log'); }
        break;
      }
      case 'transfer-error':
        renderTransferRow(ev.id, { status: 'error', error: ev.error });
        addLine(IRC_SERVER_KEY, `✗ DCC failed: ${ev.error}`, 'error');
        break;
      case 'transfer-cancelled':
        renderTransferRow(ev.id, { status: 'cancelled', received: ev.received });
        addLine(IRC_SERVER_KEY, `⊘ DCC cancelled at ${fmtBytes(ev.received)} — partial kept for resume`, 'warn');
        break;
    }
  });
}

// ─── HISTORY ─────────────────────────────────────────────────────────────────
function bindHistory() {
  document.getElementById('history-clear-btn').addEventListener('click', async () => {
    if (!(await showConfirm({
      title: t('history_clear_title') || 'Clear history',
      body:  t('history_clear_confirm'),
      danger: true
    }))) return;
    await window.api.history.clear();
    history = [];
    renderHistory();
  });
  // Live filter: re-render on every keystroke. The list is bounded by what
  // the user has actually downloaded, so the substring match stays cheap
  // even without debouncing.
  document.getElementById('history-filter').addEventListener('input', () => {
    renderHistory();
  });
}

// Format bytes as a human-readable string. Used by the History stats bar.
function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 ? n.toFixed(2) : n.toFixed(1)} ${units[i]}`;
}

async function renderHistoryStats() {
  const host = document.getElementById('history-stats');
  if (!host) return;
  let s;
  try { s = await window.api.history.stats(); }
  catch { return; }
  if (!s || !s.total) { host.innerHTML = ''; return; }
  // Top-3 sources keep the chip row from getting crowded on long histories.
  const topSources = Object.entries(s.bySource || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([src, n]) => `<span class="history-stat-chip">${esc(src)} <strong>${n}</strong></span>`)
    .join('');
  host.innerHTML = `
    <div class="history-stat">
      <span class="history-stat-label">${esc(t('history_stat_total') || 'Total')}</span>
      <span class="history-stat-value">${s.total}</span>
    </div>
    <div class="history-stat">
      <span class="history-stat-label">${esc(t('history_stat_ok') || 'Completed')}</span>
      <span class="history-stat-value">${s.ok}</span>
    </div>
    <div class="history-stat">
      <span class="history-stat-label">${esc(t('history_stat_fail') || 'Failed')}</span>
      <span class="history-stat-value">${s.fail}</span>
    </div>
    <div class="history-stat">
      <span class="history-stat-label">${esc(t('history_stat_bytes') || 'Downloaded')}</span>
      <span class="history-stat-value">${esc(fmtBytes(s.totalBytes || 0))}</span>
    </div>
    ${topSources ? `<div class="history-stat history-stat-sources"><span class="history-stat-label">${esc(t('history_stat_sources') || 'Top sources')}</span>${topSources}</div>` : ''}
  `;
}

async function renderHistory() {
  // Refresh from disk if cache invalidated
  if (history === null) history = await window.api.history.load() || [];
  // Refresh stats alongside the table — same trigger, no extra hook needed.
  renderHistoryStats();

  const tbody = document.getElementById('history-tbody');
  if (!tbody) return;

  // Filename helper — strip the directory prefix so the Name column shows only
  // the file name, not the full path. h.name is sometimes a URL (Media tab
  // stores the source URL there) so we leave that alone.
  const baseName = (p) => {
    if (!p) return '—';
    if (/^https?:\/\//i.test(p)) return p;            // keep URLs as-is
    const parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1] || p;
  };

  // Apply the user's filter against the visible fields (name, source, kind,
  // and the path/URL since long paths can include site domains the user types
  // to find a download). Case-insensitive substring match — no regex parsing
  // so users don't have to think about special chars.
  const rawQ = (document.getElementById('history-filter')?.value || '').trim().toLowerCase();
  const filtered = !rawQ ? history : history.filter(h => {
    const hay = [
      baseName(h.path), h.name, h.source, h.kind, h.path
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(rawQ);
  });

  // (X voci counter removed — the totals chips in the toolbar carry the
  // count now and the "X / Y" filtered marker was duplicate information.)

  tbody.innerHTML = '';
  if (!filtered.length) {
    const msg = rawQ ? (t('history_no_match') || 'No entries match the filter') : t('history_empty');
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--text-muted);padding:16px;text-align:center">${msg}</td></tr>`;
    return;
  }

  filtered.forEach(h => {
    const tr = document.createElement('tr');
    const d  = new Date(h.ts);
    const date = isNaN(d) ? h.ts : d.toLocaleString();
    // Status pill (same vocabulary as Queue/Downloads tracker): "done" or "error".
    // Replaces the previous ✓/✗ glyphs for visual consistency across tabs.
    const statusKey = h.ok ? 'done' : 'error';
    const statusLabel = t('downloads_status_' + statusKey) || statusKey;
    const statusCell = `<span class="dl-item-status ${statusKey}" title="${esc(h.error || '')}">${esc(statusLabel)}</span>`;
    const rawName = h.path ? baseName(h.path) : baseName(h.name);
    const nm = rawName.length > 60 ? rawName.substring(0, 57) + '…' : rawName;
    const actions = h.path && h.ok
      ? `<button class="btn-icon" data-play="${esc(h.path)}" data-lucide-icon="play" title="${esc(t('downloads_play'))}"></button>
         <button class="btn-icon" data-folder="${esc(h.path)}" data-lucide-icon="folder" title="${esc(t('downloads_open_folder'))}"></button>`
      : '';
    tr.innerHTML = `
      <td class="td-dim">${date}</td>
      <td class="td-site">${esc(h.kind || '')}</td>
      <td class="td-name" title="${esc(h.path || h.name || '')}">${esc(nm)}</td>
      <td class="td-site">${esc(h.source || '—')}</td>
      <td>${statusCell}</td>
      <td class="td-actions">${actions}</td>`;
    tbody.appendChild(tr);
  });
  applyLucideIcons(tbody);
  // Event delegation: a single listener on tbody survives the re-renders that
  // happen on every tab switch. Direct per-button bindings were getting
  // clobbered when the tab re-mounted between user clicks.
  if (!tbody.dataset.delegated) {
    tbody.dataset.delegated = '1';
    tbody.addEventListener('click', e => {
      const playBtn = e.target.closest('[data-play]');
      if (playBtn) {
        const p = playBtn.dataset.play;
        if (!p) return;
        window.api.shell.openPath(p).then(r => {
          if (r) console.error('openPath failed:', r);
        });
        return;
      }
      const folderBtn = e.target.closest('[data-folder]');
      if (folderBtn) {
        const p = folderBtn.dataset.folder;
        if (!p) return;
        window.api.shell.revealInFolder(p);
      }
    });
  }
}

// ─── SETTINGS ────────────────────────────────────────────────────────────────
// Settings sub-menu: show one panel at a time with a left sub-nav built from
// the section titles. Built once; buttons carry the section's data-i18n key so
// applyI18n keeps the labels translated. Active panel persists across renders.
function selectSettingsPanel(id) {
  const panels = document.getElementById('settings-panels');
  const nav = document.getElementById('settings-subnav');
  if (!panels || !nav) return;
  panels.querySelectorAll(':scope > .settings-section').forEach(s => s.classList.toggle('active', s.id === id));
  nav.querySelectorAll('.settings-subnav-item').forEach(b => b.classList.toggle('active', b.dataset.target === id));
  // If the active panel is inside a collapsed group, expand that group.
  const activeBtn = nav.querySelector('.settings-subnav-item.active');
  const wrap = activeBtn && activeBtn.closest('.settings-subnav-children');
  if (wrap && wrap.classList.contains('collapsed')) {
    wrap.classList.remove('collapsed');
    wrap.previousElementSibling?.classList.add('open');
  }
}

// Labels for collapsible groups in the settings sub-nav (data-group on sections).
const SETTINGS_GROUP_LABEL = { integrations: 'settings_integrations' };

function buildSettingsSubnav() {
  const nav = document.getElementById('settings-subnav');
  const panels = document.getElementById('settings-panels');
  if (!nav || !panels || nav.dataset.built) return;
  const sections = [...panels.querySelectorAll(':scope > .settings-section')];
  if (!sections.length) return;
  const makeItem = (sec, i, isChild) => {
    if (!sec.id) sec.id = `settings-panel-${i}`;
    const titleEl = sec.querySelector('.settings-section-title');
    const key = titleEl && titleEl.getAttribute('data-i18n');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-subnav-item' + (isChild ? ' settings-subnav-child' : '');
    btn.dataset.target = sec.id;
    if (key) btn.setAttribute('data-i18n', key);
    btn.textContent = titleEl ? titleEl.textContent.trim() : `Section ${i + 1}`;
    btn.addEventListener('click', () => selectSettingsPanel(sec.id));
    return btn;
  };
  nav.innerHTML = '';
  let group = null; // { key, wrap }
  sections.forEach((sec, i) => {
    const g = sec.dataset.group;
    if (g) {
      if (!group || group.key !== g) {
        const lblKey = SETTINGS_GROUP_LABEL[g] || g;
        const header = document.createElement('button');
        header.type = 'button';
        header.className = 'settings-subnav-item settings-subnav-group';
        header.innerHTML = `<span class="subnav-caret" data-lucide-icon="chevron-right" data-lucide-size="13"></span><span class="subnav-group-label"${lblKey ? ` data-i18n="${lblKey}"` : ''}>${escapeHtml(t(lblKey) || g)}</span>`;
        const wrap = document.createElement('div');
        wrap.className = 'settings-subnav-children collapsed';
        header.addEventListener('click', () => header.classList.toggle('open', wrap.classList.toggle('collapsed') === false));
        nav.appendChild(header);
        nav.appendChild(wrap);
        group = { key: g, wrap };
      }
      group.wrap.appendChild(makeItem(sec, i, true));
    } else {
      group = null;
      nav.appendChild(makeItem(sec, i, false));
    }
  });
  applyLucideIcons(nav);
  nav.dataset.built = '1';
  selectSettingsPanel(sections[0].id);
}

function renderSettings() {
  buildSettingsSubnav();
  document.getElementById('cfg-folder').value        = config.download_folder || '';
  document.getElementById('cfg-max-results').value   = config.max_results     || 5;
  document.getElementById('cfg-log-enabled').checked = !!config.log_enabled;
  document.getElementById('cfg-concurrency').value   = config.concurrency     || 1;
  document.getElementById('cfg-retry').value         = config.retry_count ?? 2;
  document.getElementById('cfg-speed-limit').value   = config.speed_limit_kbs ?? 0;
  // Integrations — Library Manager + Plex/Jellyfin + Send-to-client.
  document.getElementById('cfg-library-enabled').checked    = !!config.library_enabled;
  document.getElementById('cfg-library-pattern').value      = config.library_pattern || '{artist}/{album}';
  document.getElementById('cfg-image-library-enabled').checked = !!config.image_library_enabled;
  document.getElementById('cfg-image-library-pattern').value   = config.image_library_pattern || '{year}/{month}';
  document.getElementById('cfg-image-library-root').value      = config.image_library_root || '';
  document.getElementById('cfg-mediaserver-enabled').checked= !!config.mediaserver_enabled;
  document.getElementById('cfg-mediaserver-type').value     = config.mediaserver_type || 'jellyfin';
  document.getElementById('cfg-mediaserver-url').value      = config.mediaserver_url || '';
  document.getElementById('cfg-mediaserver-token').value    = config.mediaserver_token || '';
  document.getElementById('cfg-mediaserver-libid').value    = config.mediaserver_library_id || '';
  document.getElementById('cfg-sendto-enabled').checked     = !!config.sendto_enabled;
  document.getElementById('cfg-sendto-type').value          = config.sendto_type || 'qbittorrent';
  document.getElementById('cfg-sendto-url').value           = config.sendto_url || '';
  document.getElementById('cfg-sendto-user').value          = config.sendto_user || '';
  document.getElementById('cfg-sendto-pass').value          = config.sendto_pass || '';
  document.getElementById('cfg-sendto-category').value      = config.sendto_category || '';
  document.getElementById('cfg-sendnzb-enabled').checked    = !!config.sendnzb_enabled;
  document.getElementById('cfg-sendnzb-type').value         = config.sendnzb_type || 'sabnzbd';
  document.getElementById('cfg-sendnzb-url').value          = config.sendnzb_url || '';
  document.getElementById('cfg-sendnzb-key').value          = config.sendnzb_key || '';
  document.getElementById('cfg-sendnzb-pass').value         = config.sendnzb_pass || '';
  document.getElementById('cfg-sendnzb-category').value     = config.sendnzb_category || '';
  document.getElementById('cfg-socks-enabled').checked      = !!config.socks_enabled;
  document.getElementById('cfg-socks-host').value           = config.socks_host || '';
  document.getElementById('cfg-socks-port').value           = config.socks_port || 1080;
  document.getElementById('cfg-socks-user').value           = config.socks_user || '';
  document.getElementById('cfg-socks-pass').value           = config.socks_pass || '';
  document.getElementById('cfg-notify').checked      = !!config.notify_on_done;
  document.getElementById('cfg-mp4-compat').checked  = config.mp4_compat !== false;
  document.getElementById('cfg-history').checked     = config.history_enabled !== false;
  document.getElementById('cfg-splash-audio').checked = config.splash_audio !== false;
  document.getElementById('cfg-autoupdate').checked  = config.auto_update !== false;
  document.getElementById('cfg-acoustid-key').value  = config.acoustid_key || '';
  const opensubsEl = document.getElementById('cfg-opensubs-key');
  if (opensubsEl) opensubsEl.value = config.opensubs_key || '';
  const backend = config.recognition_backend || 'shazamio';
  const backendRadio = document.querySelector(`input[name="cfg-recognition"][value="${backend}"]`);
  if (backendRadio) backendRadio.checked = true;
  toggleAcoustIdKeyVisibility(backend);
  const showLogsEl = document.getElementById('cfg-show-logs');
  if (showLogsEl) showLogsEl.checked = !!config.show_activity_logs;

  // Update fpcalc status indicator. When the binary is missing, offer a direct
  // download here (same lazy fetch as the views) instead of "recompile FLUX".
  window.api.acoustid.status().then(s => {
    const el = document.getElementById('cfg-fpcalc-status');
    if (!el) return;
    if (s.fpcalcAvailable) {
      el.textContent = t('settings_fpcalc_ok');
      el.style.color = 'var(--accent2)';
      return;
    }
    el.style.color = 'var(--danger)';
    el.innerHTML = `<span>${escapeHtml(t('settings_fpcalc_missing') || 'fpcalc not installed')}</span> <button class="module-bin-fetch-all-btn" id="cfg-fpcalc-fetch" type="button"><span data-lucide-icon="download-cloud" data-lucide-size="12"></span><span class="mbf-all-label">${escapeHtml(t('settings_modules_fetch_all') || 'Get dependencies')}</span></button>`;
    applyLucideIcons(el);
    document.getElementById('cfg-fpcalc-fetch')?.addEventListener('click', async function () {
      if (this.disabled || _dlActive) return;
      const label = this.querySelector('.mbf-all-label');
      this.disabled = true; this.classList.add('is-fetching'); _dlActive = true;
      setBinaryProgressHandler(p => {
        if (!label) return;
        if (p.phase === 'downloading' && typeof p.pct === 'number') label.textContent = `${p.id} ${p.pct}%`;
        else label.textContent = `${p.id}…`;
      });
      try {
        for (const bid of ['fpcalc', 'ffmpeg', 'ffprobe']) {
          const st = await window.api.modules.binaryStatus();
          if (st[bid]) continue;
          const r = await window.api.binary.fetch(bid);
          if (!r.ok) throw new Error(r.error || 'failed');
        }
        _dlActive = false; setBinaryProgressHandler(null);
        renderSettings();   // re-check → flips to "fpcalc ready"
      } catch (e) {
        _dlActive = false; setBinaryProgressHandler(null);
        if (label) label.textContent = t('binfetch_failed_short') || 'failed';
        this.classList.add('is-error'); this.disabled = false;
      }
    });
  }).catch(() => {});

  // Render the Modules list (Settings > Modules). Reads modules/registry.json
  // + the actual vendor/ presence so the user sees the real install state.
  renderModulesList().catch(e => console.warn('modules list:', e));

  // Schedule
  document.getElementById('cfg-schedule-enabled').checked = !!schedule.enabled;
  document.getElementById('cfg-window-start').value       = schedule.window_start || '02:00';
  document.getElementById('cfg-window-end').value         = schedule.window_end   || '06:00';
  document.getElementById('cfg-rss-poll').value           = schedule.rss_poll_min || 60;

  if (config.lang) {
    const hidden = document.getElementById('cfg-lang');
    if (hidden) hidden.value = config.lang;
    refreshLangButton(config.lang);
  }
  if (config.theme) {
    const radio = document.querySelector(`input[name="cfg-theme"][value="${config.theme}"]`);
    if (radio) radio.checked = true;
  }

  const list = document.getElementById('sites-config-list');
  list.innerHTML = '';
  Object.keys(config.sites).forEach(site => {
    const s = config.sites[site];
    const card = document.createElement('div');
    card.className = `site-cfg-card${s.enabled ? '' : ' disabled'}`;
    card.dataset.site = site;
    const noteHtml = s.note ? `<div class="site-cfg-note"><span data-lucide-icon="alert-triangle" data-lucide-size="14"></span> ${esc(s.note)}</div>` : '';
    card.innerHTML = `
      <div class="site-cfg-card-header">
        <span class="site-cfg-name">${esc(site)}</span>
        <label class="toggle"><input type="checkbox" class="site-enabled-toggle" data-site="${esc(site)}" ${s.enabled?'checked':''}/>
          <span class="toggle-track"></span></label>
        <button class="btn-icon btn-icon-danger site-cfg-delete" type="button" data-site="${esc(site)}" data-lucide-icon="trash" title="${esc(t('settings_delete_source') || 'Delete source')}"></button>
      </div>
      <div class="site-cfg-fields">
        <div class="site-cfg-field"><label>${esc(t('settings_api'))}</label>
          <input type="text" class="site-api-input" data-site="${esc(site)}" value="${esc(s.api || '')}" /></div>
        <div class="site-cfg-field"><label>${esc(t('settings_max_site'))}</label>
          <input type="number" class="site-max-input" data-site="${esc(site)}" value="${s.max_results ?? ''}" min="1" max="50" style="width:80px"/></div>
        ${noteHtml}
      </div>`;
    card.querySelector('.site-enabled-toggle').addEventListener('change', async function() {
      card.classList.toggle('disabled', !this.checked);
      // Auto-persist the enable/disable flip so a toggle change takes
      // effect on the NEXT search without the user having to scroll back
      // up to the Save button. (Bug: previously a user would untick YTS,
      // run a search, and still see YTS results because config wasn't
      // re-saved until Save was clicked.)
      if (config.sites[site]) {
        config.sites[site].enabled = this.checked;
        try { await window.api.config.save(config); } catch {}
      }
    });
    card.querySelector('.site-cfg-delete').addEventListener('click', async () => {
      if (!(await showConfirm({
        title: t('settings_delete_source') || 'Delete source',
        body:  t('settings_delete_source_confirm', { name: site }) || `Delete source "${site}"? This cannot be undone.`,
        danger: true
      }))) return;
      delete config.sites[site];
      window.api.config.save(config);
      renderSitesConfig();
    });
    list.appendChild(card);
  });
  applyLucideIcons(list);
}
// Re-render the sources list after a delete. Cheapest path is to re-run
// renderSettings (which re-populates everything from config).
function renderSitesConfig() { renderSettings(); }

// Boot-time visibility pass. Reads modules/registry.json + config and hides
// every sidebar tab whose owning module is disabled. Idempotent — safe to
// call multiple times (e.g. if a future feature re-applies after a config
// change). Tabs of the `core` module are NEVER touched (it's required).
// ─── MODULE REGISTRY CACHE + LAZY BINARY FETCH (Phase 2b) ────────────────────
// The registry (modules/registry.json) is immutable at runtime, so load it
// once and reuse for tab→module mapping + the Settings list.
let _moduleRegistry = null;
async function getModuleRegistry() {
  if (_moduleRegistry) return _moduleRegistry;
  try { _moduleRegistry = await window.api.modules.registry(); }
  catch (e) { console.warn('module registry load failed', e); _moduleRegistry = { modules: [], binaries: {} }; }
  return _moduleRegistry;
}

// Binaries a specific TAB needs (registry.tabBinaries). Finer than the
// module's full set — radio/rss/spotify need nothing to open even though
// their `media` module bundles yt-dlp/ffmpeg for downloading.
function tabBinariesFor(reg, tabId) {
  return (reg.tabBinaries && reg.tabBinaries[tabId]) || [];
}

// Build clean archive "groups" from a list of missing binary ids. ffmpeg and
// ffprobe ship in ONE archive, so they collapse into a single entry (fixes the
// old double-count). `key` is the id we actually fetch (its archive yields both).
function archiveGroups(ids, binMeta) {
  const groups = [];
  for (const id of ids) {
    if (id === 'ffmpeg' || id === 'ffprobe') continue;
    groups.push({ key: id, label: id, mb: binMeta[id]?.approx_mb || 0 });
  }
  const ff = ids.filter(i => i === 'ffmpeg' || i === 'ffprobe');
  if (ff.length) {
    groups.push({ key: 'ffmpeg', label: ff.join(' + '), mb: binMeta['ffmpeg']?.approx_mb || binMeta['ffprobe']?.approx_mb || 0 });
  }
  return groups;
}

// Refine each group's size in-place with the PRECISE byte count (best-effort,
// ≤5s total; falls back to the registry estimate on timeout/failure).
async function probeGroupSizes(groups) {
  try {
    await Promise.race([
      Promise.all(groups.map(async g => {
        const bytes = await window.api.binary.probeSize(g.key);
        if (bytes > 0) g.mb = Math.round(bytes / 1048576 * 10) / 10;
      })),
      new Promise(res => setTimeout(res, 5000))
    ]);
  } catch { /* keep registry approx */ }
}

// Which of `ids` are not yet installed (empty list if we can't probe — never block).
async function missingOf(ids) {
  if (!ids || !ids.length) return [];
  let status;
  try { status = await window.api.modules.binaryStatus(); }
  catch { return []; }
  return ids.filter(b => !status[b]);
}

// Single shared subscription to the 'binary:progress' IPC channel (preload's
// onProgress has no unsubscribe handle, so we register once and route to the
// currently-active handler).
let _binaryProgressHandler = null;
let _binaryProgressBridged = false;
function setBinaryProgressHandler(fn) {
  if (!_binaryProgressBridged) {
    window.api.binary.onProgress(p => { if (_binaryProgressHandler) { try { _binaryProgressHandler(p); } catch {} } });
    _binaryProgressBridged = true;
  }
  _binaryProgressHandler = fn;
}

// ─── UNIFIED DOWNLOAD VIEW (Phase 2b) ────────────────────────────────────────
// ONE place handles every on-demand binary download. When a view (or an action)
// needs libraries that aren't installed, FLUX shows the #tab-download view with
// exactly those libraries + a Download button; on success it navigates to the
// originally-requested view. No nav arrows, no modals, no half-broken views.
let _dlViewState = null; // { groups, target, targetNav }
let _dlActive = false;   // a fetch is in flight → keep it persistent across nav

function ensureDownloadViewEl() {
  let el = document.getElementById('tab-download');
  if (el) return el;
  el = document.createElement('section');
  el.id = 'tab-download';
  el.className = 'tab hidden';
  el.innerHTML = `
    <div class="tab-header">
      <h1 data-i18n="dlview_title">Additional components needed</h1>
      <p class="tab-sub" data-i18n="dlview_sub">This section needs a few open-source tools before it can run. They download once.</p>
    </div>
    <div class="dlview-card">
      <ul class="binfetch-list" id="dlview-list"></ul>
      <div class="progress-bar-bg hidden" id="dlview-progress"><div class="progress-bar"></div><span class="progress-bar-text">0%</span></div>
      <div class="binfetch-error hidden" id="dlview-error"></div>
      <div class="dlview-actions">
        <button class="btn btn-primary" id="dlview-download" type="button"></button>
        <button class="btn btn-ghost" id="dlview-cancel" type="button" data-i18n="dlview_back">Go back</button>
      </div>
    </div>`;
  document.querySelector('main.content').appendChild(el);
  el.querySelector('#dlview-cancel').addEventListener('click', () => switchTab('home'));
  el.querySelector('#dlview-download').addEventListener('click', onDownloadViewConfirm);
  try { applyI18n(); } catch {}
  return el;
}

// Render the download view for `groups` (already size-probed) and switch to it.
// target/targetNav = where to go once everything is installed.
function showDownloadView(groups, { target, targetNav } = {}) {
  const el = ensureDownloadViewEl();
  _dlViewState = { groups, target: target || 'home', targetNav: targetNav || null };
  const totalMb = Math.round(groups.reduce((s, g) => s + g.mb, 0) * 10) / 10;
  el.querySelector('#dlview-list').innerHTML = groups.map(g => `
    <li class="binfetch-item" data-key="${esc(g.key)}">
      <span class="binfetch-item-state" aria-hidden="true"></span>
      <span class="binfetch-item-name">${esc(g.label)}</span>
      <span class="binfetch-item-size">~${g.mb} MB</span>
    </li>`).join('');
  const dlBtn = el.querySelector('#dlview-download');
  dlBtn.disabled = false;
  dlBtn.textContent = (t('dlview_download') || 'Download (~{size} MB)').replace('{size}', totalMb || '?');
  el.querySelector('#dlview-cancel').disabled = false;
  el.querySelector('#dlview-progress').classList.add('hidden');
  el.querySelector('#dlview-error').classList.add('hidden');
  switchTab('download');
}

// Download button → fetch all groups, show progress inline, then navigate to
// the original target view.
async function onDownloadViewConfirm() {
  const el = document.getElementById('tab-download');
  if (!el || !_dlViewState || _dlActive) return; // ignore double-clicks / re-entry
  const { groups, target, targetNav } = _dlViewState;
  const dlBtn     = el.querySelector('#dlview-download');
  const cancelBtn = el.querySelector('#dlview-cancel');
  const errBox    = el.querySelector('#dlview-error');
  const progress  = el.querySelector('#dlview-progress');
  const bar       = progress.querySelector('.progress-bar');
  const barText   = progress.querySelector('.progress-bar-text');
  const listEl    = el.querySelector('#dlview-list');

  dlBtn.disabled = true; cancelBtn.disabled = true;
  errBox.classList.add('hidden');
  progress.classList.remove('hidden');
  bar.style.width = '0%'; barText.textContent = '0%'; bar.classList.remove('is-indeterminate');

  _dlActive = true;
  const ok = await runFetch(groups, makeProgressSink({ listEl, bar, barText, errBox }));
  _dlActive = false;
  cancelBtn.disabled = false;
  if (!ok) { dlBtn.disabled = false; return; }
  if (document.getElementById('modules-list')?.children.length) renderModulesList().catch(() => {});
  // Only auto-navigate if the user is still on the download view.
  if (document.getElementById('tab-download')?.classList.contains('active')) {
    const navItem = targetNav || document.querySelector(`.nav-item[data-tab="${target}"]`);
    switchTab(target, navItem || null);
  }
}

// Progress sink that paints a binfetch checklist + bar (• → ▸ → ✓) with live
// "X / Y MB" sizes from the download's Content-Length.
function makeProgressSink({ listEl, bar, barText, errBox }) {
  const fmtMb = b => (b / 1048576).toFixed(1);
  const phaseText = ph => ({ resolving: t('binfetch_resolving') || 'Resolving…', extracting: t('binfetch_extracting') || 'Extracting…' }[ph] || '');
  const setActive = key => {
    let passed = false;
    listEl.querySelectorAll('.binfetch-item').forEach(li => {
      if (li.dataset.key === key) { passed = true; li.classList.add('is-active'); li.classList.remove('is-done'); }
      else if (!passed) { li.classList.add('is-done'); li.classList.remove('is-active'); }
      else li.classList.remove('is-active');
    });
  };
  return {
    onProgress(p) {
      const li = listEl.querySelector(`.binfetch-item[data-key="${p.id}"]`);
      if (li) {
        setActive(p.id);
        const sizeEl = li.querySelector('.binfetch-item-size');
        if (p.phase === 'downloading' && p.total) sizeEl.textContent = `${fmtMb(p.received)} / ${fmtMb(p.total)} MB`;
        else if (p.phase === 'resolving' || p.phase === 'extracting') sizeEl.textContent = phaseText(p.phase);
        else if (p.phase === 'done') { li.classList.add('is-done'); li.classList.remove('is-active'); }
      }
      if (p.phase === 'downloading' && typeof p.pct === 'number') { bar.classList.remove('is-indeterminate'); bar.style.width = p.pct + '%'; barText.textContent = p.pct + '%'; }
      else if (p.phase === 'extracting' || p.phase === 'resolving') { bar.classList.add('is-indeterminate'); barText.textContent = ''; }
      else if (p.phase === 'done') { bar.classList.remove('is-indeterminate'); bar.style.width = '100%'; barText.textContent = '100%'; }
    },
    fail(msg, label) {
      bar.classList.remove('is-indeterminate');
      if (errBox) {
        errBox.classList.remove('hidden');
        errBox.textContent = (t('binfetch_failed') || 'Download failed: {err}')
          .replace('{err}', `${label ? label + ' — ' : ''}${msg}`);
      }
    }
  };
}

// Fetch all groups sequentially, routing progress to `sink`. True on full success.
async function runFetch(groups, sink) {
  setBinaryProgressHandler(p => sink.onProgress(p));
  try {
    for (const g of groups) {
      const r = await window.api.binary.fetch(g.key);
      if (!r.ok) { sink.fail(r.error || 'download failed', g.label); return false; }
    }
    return true;
  } catch (e) { sink.fail(e.message); return false; }
  finally { setBinaryProgressHandler(null); }
}

// Build size-probed groups for `missing` ids and route to the download view.
// Re-entrancy guard: a burst of action guards (e.g. Spotify "download all" with
// libs missing) must not stack N parallel size-probes / re-renders.
let _dlRouting = false;
async function routeToDownload(missing, opts) {
  // A download is already running → just show it live (don't render a fresh
  // view or start a second fetch). This is what makes the download PERSIST
  // across view changes: navigating to another lib-needing view returns the
  // user to the in-progress download instead of a blank "start again" screen.
  if (_dlActive) { switchTab('download'); return; }
  if (_dlRouting || document.getElementById('tab-download')?.classList.contains('active')) return;
  _dlRouting = true;
  try {
    const reg = await getModuleRegistry();
    const groups = archiveGroups(missing, reg.binaries || {});
    await probeGroupSizes(groups);
    showDownloadView(groups, opts);
  } finally { _dlRouting = false; }
}

// Nav entry gate: open `tab`, unless it needs libraries that aren't installed —
// then show the download view (returning to `tab` afterwards). Replaces the
// old nav arrow + blocking modal.
async function navTo(tabId, navItem) {
  // Xtract's Image sub-view uses the bundled sharp (no ffmpeg) — open it
  // directly, never via the "components needed" gate. Audio/video still gate.
  if (tabId === 'xtract' && navItem?.dataset?.xtractView === 'image') {
    switchTab(tabId, navItem);
    return;
  }
  const reg = await getModuleRegistry();
  const missing = await missingOf(tabBinariesFor(reg, tabId));
  if (!missing.length) { switchTab(tabId, navItem); return; }
  await routeToDownload(missing, { target: tabId, targetNav: navItem });
}

// Action guard: ensure `ids` are present before an in-view action runs. If some
// are missing, routes to the download view (returning to the CURRENT view after)
// and returns false so the caller aborts; the user re-triggers once installed.
async function ensureBinaries(ids, _label) {
  const missing = await missingOf(ids);
  if (!missing.length) return true;
  const cur = document.querySelector('.tab.active')?.id?.replace(/^tab-/, '') || 'home';
  await routeToDownload(missing, { target: cur });
  return false;
}

// Identify (tab-less) → ensure its module's binaries via the same flow.
async function ensureModuleBinaries(moduleId) {
  const reg = await getModuleRegistry();
  const mod = (reg.modules || []).find(m => m.id === moduleId);
  if (!mod || mod.id === 'core' || !(mod.binaries || []).length) return true;
  return ensureBinaries(mod.binaries, mod.name);
}

async function applyModuleVisibility() {
  const enabled = config.modules_enabled || {};
  const reg = await getModuleRegistry();
  if (!reg.modules) { console.warn('applyModuleVisibility: empty registry'); return; }
  for (const m of reg.modules || []) {
    if (m.id === 'core' || enabled[m.id] !== false) continue;
    for (const tab of m.tabs || []) {
      document.querySelectorAll(`.nav-item[data-tab="${tab}"]`).forEach(el => {
        el.classList.add('hidden');
      });
    }
  }
  // Cross-module hook elements (e.g. the "Sync to…" buttons in Tag/Images that
  // target the Files module): hide when their target module is disabled.
  document.querySelectorAll('[data-needs-module]').forEach(el => {
    const mod = el.getAttribute('data-needs-module');
    el.classList.toggle('hidden', enabled[mod] === false);
  });
}

// Settings > Modules. Reads modules/registry.json via IPC and renders one
// card per module. Phase 2a: shows a real on/off toggle bound to
// config.modules_enabled[id]. Core stays a static "Required" badge (can't
// be disabled — it's the shared lifecycle/persistence/proxy/notify base).
// Changing a toggle auto-saves the config; certain transitions also flip
// the "restart needed" banner since tabs/IPC handlers are wired at boot.
async function renderModulesList() {
  const host = document.getElementById('modules-list');
  if (!host) return;
  host.innerHTML = '';
  const [reg, binStatus] = await Promise.all([
    window.api.modules.registry(),
    window.api.modules.binaryStatus()
  ]);
  const binMeta = reg.binaries || {};
  const enabledMap = config.modules_enabled || {};
  for (const m of reg.modules || []) {
    const card = document.createElement('div');
    card.className = 'module-card';
    card.dataset.moduleId = m.id;
    if (enabledMap[m.id] === false) card.classList.add('is-disabled');
    const binChips = (m.binaries || []).map(bid => {
      const present = !!binStatus[bid];
      const size = binMeta[bid]?.approx_mb;
      const sizeStr = size ? ` ~${size}MB` : '';
      const purpose = esc(binMeta[bid]?.purpose || '');
      // Present → static chip with a check. Missing → actionable download
      // button (Phase 2b: fetch on demand instead of bundling).
      if (present) {
        return `<span class="module-bin-chip is-present" title="${purpose}"><span data-lucide-icon="check" data-lucide-size="12"></span>${esc(bid)}${sizeStr}</span>`;
      }
      return `<button class="module-bin-fetch-btn" type="button" data-bin-id="${esc(bid)}" title="${purpose}"><span data-lucide-icon="download" data-lucide-size="12"></span><span class="mbf-label">${esc(bid)}${sizeStr}</span></button>`;
    }).join('');
    // "Get all dependencies" button — fetches every still-missing binary the
    // module needs, in one click. Shown only when something is missing.
    const missingBins = (m.binaries || []).filter(bid => !binStatus[bid]);
    const fetchAllBtn = missingBins.length
      ? `<button class="module-bin-fetch-all-btn" type="button" data-module-id="${esc(m.id)}" title="${esc(t('settings_modules_fetch_all_help') || 'Download all dependencies this module needs')}"><span data-lucide-icon="download-cloud" data-lucide-size="12"></span><span class="mbf-all-label">${esc(t('settings_modules_fetch_all') || 'Get dependencies')}</span></button>`
      : '';
    // Required modules (core) render as a static badge — no toggle. All
    // others render as the standard toggle switch.
    const control = m.required
      ? `<span class="module-status-badge is-required">${esc(t('settings_modules_status_required') || 'Required')}</span>`
      : `<label class="toggle module-toggle" title="${esc(t('settings_modules_toggle_help') || 'Enable or disable this module')}">
           <input type="checkbox" class="module-enabled-input" data-module-id="${esc(m.id)}" ${enabledMap[m.id] !== false ? 'checked' : ''} />
           <span class="toggle-track"></span>
         </label>`;
    card.innerHTML = `
      <div class="module-card-head">
        <span>${esc(m.name)}</span>
        <span class="module-card-id">${esc(m.id)}</span>
      </div>
      ${control}
      <div class="module-card-desc">${esc(m.description)}</div>
      ${binChips ? `<div class="module-card-meta">${binChips}${fetchAllBtn}</div>` : ''}`;
    host.appendChild(card);
  }
  applyLucideIcons(host);
  // Single delegated listener set — guarded so repeated renderModulesList()
  // calls (renderSettings re-runs it) don't stack duplicate handlers.
  if (!host.dataset.listenersBound) {
    host.addEventListener('change', onModuleToggleChange);
    host.addEventListener('click', onModuleBinFetchClick);
    host.addEventListener('click', onModuleFetchAllClick);
    host.dataset.listenersBound = '1';
  }
}

// Settings > Modules: click a missing-binary button → fetch it on demand,
// showing live progress on the button label. One archive can satisfy two
// binaries (ffmpeg → ffmpeg+ffprobe), so we re-render from fresh status
// rather than flipping a single chip.
async function onModuleBinFetchClick(e) {
  const btn = e.target.closest('.module-bin-fetch-btn');
  if (!btn || btn.disabled || _dlActive) return; // don't race a view download
  const id = btn.dataset.binId;
  const label = btn.querySelector('.mbf-label');
  btn.disabled = true;
  btn.classList.remove('is-error');
  btn.classList.add('is-fetching');
  setBinaryProgressHandler(p => {
    if (p.id !== id || !btn.isConnected) return;
    if (p.phase === 'downloading' && typeof p.pct === 'number') label.textContent = `${id} ${p.pct}%`;
    else if (p.phase === 'extracting') label.textContent = `${id} ${t('binfetch_extracting') || 'extracting…'}`;
    else if (p.phase === 'resolving')  label.textContent = `${id} …`;
  });
  _dlActive = true; // share the lock so a view download can't start concurrently
  try {
    const r = await window.api.binary.fetch(id);
    if (!r.ok) throw new Error(r.error || 'failed');
    await renderModulesList();           // re-reads binaryStatus → chips flip to present
  } catch (err) {
    label.textContent = `${id} — ${t('binfetch_failed_short') || 'failed'}`;
    btn.classList.add('is-error');
    btn.classList.remove('is-fetching');
    btn.disabled = false;
  } finally {
    _dlActive = false;
    setBinaryProgressHandler(null);
  }
}

// Settings > Modules: "Get dependencies" — fetch every still-missing binary the
// module needs, sequentially, with live progress on the button label.
async function onModuleFetchAllClick(e) {
  const btn = e.target.closest('.module-bin-fetch-all-btn');
  if (!btn || btn.disabled || _dlActive) return;
  const moduleId = btn.dataset.moduleId;
  const reg = await window.api.modules.registry();
  const mod = (reg.modules || []).find(m => m.id === moduleId);
  if (!mod) return;
  const label = btn.querySelector('.mbf-all-label');
  btn.disabled = true;
  btn.classList.remove('is-error');
  btn.classList.add('is-fetching');
  _dlActive = true;
  setBinaryProgressHandler(p => {
    if (!btn.isConnected || !label) return;
    if (p.phase === 'downloading' && typeof p.pct === 'number') label.textContent = `${p.id} ${p.pct}%`;
    else if (p.phase === 'extracting') label.textContent = `${p.id} ${t('binfetch_extracting') || 'extracting…'}`;
    else if (p.phase === 'resolving')  label.textContent = `${p.id} …`;
  });
  try {
    for (const bid of (mod.binaries || [])) {
      // One archive can satisfy two ids (ffmpeg → ffmpeg+ffprobe) — re-check
      // before each fetch so we never re-download what's already present.
      const st = await window.api.modules.binaryStatus();
      if (st[bid]) continue;
      const r = await window.api.binary.fetch(bid);
      if (!r.ok) throw new Error(r.error || 'failed');
    }
    _dlActive = false;
    setBinaryProgressHandler(null);
    await renderModulesList();
  } catch (err) {
    _dlActive = false;
    setBinaryProgressHandler(null);
    if (label) label.textContent = t('binfetch_failed_short') || 'failed';
    btn.classList.add('is-error');
    btn.classList.remove('is-fetching');
    btn.disabled = false;
  }
}

// Persist the toggle change, mark restart-needed, refresh the visual
// disabled state of the card. Tab visibility itself only kicks in at next
// boot (tabs are wired up in DOMContentLoaded so changing them mid-session
// would require disposing every binding from the disabled module — much
// more invasive than a restart). We surface that with the banner.
let _modulesRestartNeeded = false;
async function onModuleToggleChange(e) {
  const input = e.target.closest('.module-enabled-input');
  if (!input) return;
  const id = input.dataset.moduleId;
  const enabled = input.checked;
  config.modules_enabled = config.modules_enabled || {};
  // Defensive: never let `core` flip off via any path (UI doesn't render
  // a toggle for it, but a future bug could).
  if (id === 'core') { input.checked = true; config.modules_enabled.core = true; return; }
  config.modules_enabled[id] = enabled;
  try { await window.api.config.save(config); } catch {}
  // Visual: dim the card immediately so the user sees their toggle took.
  const card = input.closest('.module-card');
  if (card) card.classList.toggle('is-disabled', !enabled);
  // Restart banner — tab wiring + IPC handlers are bound at boot, so
  // toggling a module's state only takes full effect after restart.
  _modulesRestartNeeded = true;
  showModulesRestartBanner();
}

// Inject (or show) a banner above the module list prompting for restart.
// Idempotent — calling twice doesn't dupe the banner. The Restart button
// invokes window.api.system.relaunch which main.js handles via app.relaunch.
function showModulesRestartBanner() {
  const section = document.querySelector('#modules-list')?.parentElement;
  if (!section) return;
  let banner = section.querySelector('.modules-restart-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'modules-restart-banner';
    banner.innerHTML = `
      <span class="modules-restart-msg">${esc(t('settings_modules_restart_msg') || 'Module changes take effect after restart.')}</span>
      <button class="btn btn-primary modules-restart-btn">${esc(t('settings_modules_restart_btn') || 'Restart now')}</button>`;
    // Insert ABOVE the list so it's seen first on scroll
    const list = section.querySelector('#modules-list');
    section.insertBefore(banner, list);
    banner.querySelector('.modules-restart-btn').addEventListener('click', async () => {
      try { await window.api.system.relaunch(); } catch (e) { console.error('relaunch:', e); }
    });
  }
  banner.classList.add('is-visible');
}

function readSettingsFromUI() {
  config.download_folder = document.getElementById('cfg-folder').value;
  config.max_results     = parseInt(document.getElementById('cfg-max-results').value) || 5;
  config.log_enabled     = document.getElementById('cfg-log-enabled').checked;
  config.concurrency     = parseInt(document.getElementById('cfg-concurrency').value) || 1;
  config.retry_count     = parseInt(document.getElementById('cfg-retry').value) || 0;
  config.speed_limit_kbs = Math.max(0, parseInt(document.getElementById('cfg-speed-limit').value) || 0);
  config.library_enabled       = document.getElementById('cfg-library-enabled').checked;
  config.library_pattern       = document.getElementById('cfg-library-pattern').value.trim() || '{artist}/{album}';
  config.image_library_enabled = document.getElementById('cfg-image-library-enabled').checked;
  config.image_library_pattern = document.getElementById('cfg-image-library-pattern').value.trim() || '{year}/{month}';
  config.image_library_root    = document.getElementById('cfg-image-library-root').value.trim();
  config.mediaserver_enabled   = document.getElementById('cfg-mediaserver-enabled').checked;
  config.mediaserver_type      = document.getElementById('cfg-mediaserver-type').value;
  config.mediaserver_url       = document.getElementById('cfg-mediaserver-url').value.trim();
  config.mediaserver_token     = document.getElementById('cfg-mediaserver-token').value.trim();
  config.mediaserver_library_id= document.getElementById('cfg-mediaserver-libid').value.trim();
  config.sendto_enabled        = document.getElementById('cfg-sendto-enabled').checked;
  config.sendto_type           = document.getElementById('cfg-sendto-type').value;
  config.sendto_url            = document.getElementById('cfg-sendto-url').value.trim();
  config.sendto_user           = document.getElementById('cfg-sendto-user').value.trim();
  config.sendto_pass           = document.getElementById('cfg-sendto-pass').value;
  config.sendto_category       = document.getElementById('cfg-sendto-category').value.trim();
  config.sendnzb_enabled       = document.getElementById('cfg-sendnzb-enabled').checked;
  config.sendnzb_type          = document.getElementById('cfg-sendnzb-type').value;
  config.sendnzb_url           = document.getElementById('cfg-sendnzb-url').value.trim();
  config.sendnzb_key           = document.getElementById('cfg-sendnzb-key').value.trim();
  config.sendnzb_pass          = document.getElementById('cfg-sendnzb-pass').value;
  config.sendnzb_category      = document.getElementById('cfg-sendnzb-category').value.trim();
  config.socks_enabled         = document.getElementById('cfg-socks-enabled').checked;
  config.socks_host            = document.getElementById('cfg-socks-host').value.trim();
  config.socks_port            = parseInt(document.getElementById('cfg-socks-port').value, 10) || 1080;
  config.socks_user            = document.getElementById('cfg-socks-user').value.trim();
  config.socks_pass            = document.getElementById('cfg-socks-pass').value;
  config.notify_on_done  = document.getElementById('cfg-notify').checked;
  config.mp4_compat      = document.getElementById('cfg-mp4-compat').checked;
  config.history_enabled = document.getElementById('cfg-history').checked;
  config.splash_audio    = document.getElementById('cfg-splash-audio').checked;
  config.auto_update     = document.getElementById('cfg-autoupdate').checked;
  config.acoustid_key       = document.getElementById('cfg-acoustid-key').value.trim();
  config.opensubs_key       = (document.getElementById('cfg-opensubs-key')?.value || '').trim();
  const backendRadio = document.querySelector('input[name="cfg-recognition"]:checked');
  config.recognition_backend = backendRadio ? backendRadio.value : 'shazamio';
  refreshIdentifyButton();
  config.show_activity_logs = document.getElementById('cfg-show-logs')?.checked || false;
  document.body.classList.toggle('show-activity-logs', config.show_activity_logs);

  const langVal = document.getElementById('cfg-lang').value || 'en';
  config.lang = langVal;
  window.setLang(langVal === 'system' ? systemLang : langVal);
  applyI18n();

  const themeRadio = document.querySelector('input[name="cfg-theme"]:checked');
  if (themeRadio)  { config.theme = themeRadio.value; applyTheme(themeRadio.value); }

  document.querySelectorAll('.site-cfg-card').forEach(card => {
    const site = card.dataset.site;
    if (!config.sites[site]) return;
    config.sites[site].enabled     = card.querySelector('.site-enabled-toggle').checked;
    config.sites[site].api         = card.querySelector('.site-api-input').value.trim();
    const mx                       = card.querySelector('.site-max-input').value.trim();
    config.sites[site].max_results = mx === '' ? null : parseInt(mx);
  });

  // Schedule
  schedule.enabled       = document.getElementById('cfg-schedule-enabled').checked;
  schedule.window_start  = document.getElementById('cfg-window-start').value || '02:00';
  schedule.window_end    = document.getElementById('cfg-window-end').value   || '06:00';
  schedule.rss_poll_min  = parseInt(document.getElementById('cfg-rss-poll').value) || 60;
}

function bindSettings() {
  document.getElementById('cfg-folder-btn').addEventListener('click', async () => {
    const f = await window.api.dialog.pickFolder();
    if (f) document.getElementById('cfg-folder').value = f;
  });
  document.getElementById('cfg-folder-open').addEventListener('click', () => {
    window.api.shell.openFolder(document.getElementById('cfg-folder').value);
  });

  // Test buttons for the integrations. We persist the current form values
  // BEFORE hitting the test endpoint so the user doesn't have to "Save"
  // first — they fill in URL/token, click Test, and get an instant verdict.
  async function persistAndTest(testFn, msgEl) {
    msgEl.textContent = t('settings_test_running') || 'Testing…';
    msgEl.className   = 'settings-test-msg';
    try {
      readSettingsFromUI();
      await window.api.config.save(config);
      const r = await testFn();
      if (r?.ok) {
        msgEl.innerHTML = `<span data-lucide-icon="check" data-lucide-size="14"></span> ${escapeHtml(t('settings_test_ok') || 'Connection OK')}`;
        msgEl.className   = 'settings-test-msg ok';
      } else {
        msgEl.innerHTML = `<span data-lucide-icon="x" data-lucide-size="14"></span> ${escapeHtml(r?.error || (t('settings_test_fail') || 'Failed'))}`;
        msgEl.className   = 'settings-test-msg fail';
      }
    } catch (e) {
      msgEl.innerHTML = `<span data-lucide-icon="x" data-lucide-size="14"></span> ${escapeHtml(e?.message || 'error')}`;
      msgEl.className   = 'settings-test-msg fail';
    }
    applyLucideIcons(msgEl);
  }
  document.getElementById('cfg-mediaserver-test').addEventListener('click', () =>
    persistAndTest(() => window.api.mediaserver.test({}), document.getElementById('cfg-mediaserver-msg'))
  );
  document.getElementById('cfg-sendto-test').addEventListener('click', () =>
    persistAndTest(() => window.api.sendto.test(), document.getElementById('cfg-sendto-msg'))
  );
  document.getElementById('cfg-sendnzb-test').addEventListener('click', () =>
    persistAndTest(() => window.api.sendnzb.test(), document.getElementById('cfg-sendnzb-msg'))
  );
  // Live-toggle the AcoustID key visibility when the user flips the radio.
  document.querySelectorAll('input[name="cfg-recognition"]').forEach(r => {
    r.addEventListener('change', e => toggleAcoustIdKeyVisibility(e.target.value));
  });

  // Open the AcoustID applications page in the default browser. Hidden help
  // CTA so the user can find the right page (NOT /api-key, which gives a
  // submission key — they need /applications for the client key).
  document.getElementById('cfg-acoustid-open')?.addEventListener('click', () => {
    window.api.shell.openExternal('https://acoustid.org/applications');
  });
  document.getElementById('cfg-opensubs-open')?.addEventListener('click', () => {
    window.api.shell.openExternal('https://www.opensubtitles.com/consumers');
  });

  document.getElementById('cfg-save-btn').addEventListener('click', async () => {
    const saveBtn = document.getElementById('cfg-save-btn');
    saveBtn.classList.add('btn-loading');
    saveBtn.disabled = true;
    try {
      readSettingsFromUI();
      // Verify the configured download folder actually exists and we can write
      // to it. Without this, downloads can silently fail to materialise where
      // the user expects them (e.g. typo'd path, removable drive disconnected).
      const folderCheck = await window.api.fs.checkPathWritable(config.download_folder);
      if (!folderCheck.ok) {
        showToast({
          title: t('settings_folder_unwritable_title') || 'Download folder unusable',
          body:  t('settings_folder_unwritable_body', { path: config.download_folder, err: folderCheck.error })
                  || `Cannot write to "${config.download_folder}": ${folderCheck.error}. Pick a different folder.`,
          kind:  'err',
          ttl:   9000
        });
        return; // abort save
      }
      // If AcoustID is the active backend and the key is missing OR rejected,
      // surface a toast and ABORT the save — the user stays on Settings with
      // their current input intact, so they can fix it and retry.
      // AcoustID backend: only a USER-PROVIDED key is validated. An empty field
      // is fine — identify falls back to the embedded DEFAULT_ACOUSTID_KEY.
      if (config.recognition_backend === 'acoustid') {
        const key = (config.acoustid_key || '').trim();
        if (key) {
          const v = await window.api.acoustid.validateKey({ apiKey: key });
          if (!v.ok) {
            showToast({
              title: t('settings_acoustid_invalid_title'),
              body:  t('settings_acoustid_invalid_body', { reason: v.error || 'invalid key' }),
              kind:  'err',
              ttl:   8000
            });
            return; // don't save an invalid key
          }
        }
      }
      await window.api.config.save(config);
      await window.api.schedule.save(schedule);
      // Keep the active profile's snapshot in sync with the saved settings.
      if (config.profile_name) {
        await window.api.profiles.save(config.profile_name, config);
        profiles = await window.api.profiles.load();
        renderProfileBar();
      }
      showToast({ title: t('settings_saved_toast') || 'Settings updated', kind: 'ok', ttl: 2500 });
    } finally {
      saveBtn.classList.remove('btn-loading');
      saveBtn.disabled = false;
    }
  });

  // Profile bar — new / rename / delete / switch.
  const confirmOverwrite = async (name) => showConfirm({
    title:   t('profile_overwrite_title') || 'Overwrite profile?',
    body:    t('profile_overwrite_body', { name }) || `A profile named "${name}" already exists and will be overwritten.`,
    okLabel: t('profile_overwrite_ok') || 'Overwrite', danger: true
  });
  document.getElementById('profile-new-btn')?.addEventListener('click', async () => {
    const name = await showPrompt({ title: t('settings_profile_new') || 'New profile', value: nextProfileName() });
    if (!name) return;
    if (profiles[name] && !(await confirmOverwrite(name))) return;
    readSettingsFromUI();
    config.profile_name = name;
    await window.api.profiles.save(name, config);
    await window.api.config.save(config);
    profiles = await window.api.profiles.load();
    renderProfileBar();
  });
  document.getElementById('profile-rename-btn')?.addEventListener('click', async () => {
    const old = config.profile_name;
    const name = await showPrompt({ title: t('settings_profile_rename') || 'Rename profile', value: old });
    if (!name || name === old) return;
    if (profiles[name] && !(await confirmOverwrite(name))) return;
    readSettingsFromUI();
    config.profile_name = name;
    await window.api.profiles.save(name, config);
    if (old && profiles[old]) await window.api.profiles.delete(old);
    await window.api.config.save(config);
    profiles = await window.api.profiles.load();
    renderProfileBar();
  });
  document.getElementById('profile-delete-btn').addEventListener('click', async () => {
    const sel = document.getElementById('profile-select').value;
    if (!sel) return;
    if (Object.keys(profiles).length <= 1) {
      showToast({ title: t('settings_profile_delete_title') || 'Delete profile', body: t('profile_delete_last') || "You can't delete the only profile.", kind: 'warn', ttl: 4000 });
      return;
    }
    if (!(await showConfirm({
      title: t('settings_profile_delete_title') || 'Delete profile',
      body:  t('settings_profile_delete_confirm', { name: sel }),
      danger: true
    }))) return;
    await window.api.profiles.delete(sel);
    profiles = await window.api.profiles.load();
    if (config.profile_name === sel) {
      const first = Object.keys(profiles)[0];
      if (first) {
        config = { ...config, ...profiles[first], profile_name: first, tos_accepted: config.tos_accepted, tos_version: config.tos_version };
        await window.api.config.save(config);
        renderSettings(); applyTheme(config.theme || 'dark');
        if (config.lang) { window.setLang(config.lang); applyI18n(); }
      }
    }
    renderProfileBar();
  });
  document.getElementById('profile-select').addEventListener('change', async function() {
    const name = this.value;
    if (profiles[name]) {
      config = { ...config, ...profiles[name], profile_name: name, tos_accepted: config.tos_accepted, tos_version: config.tos_version };
      await window.api.config.save(config);
      renderSettings();
      applyTheme(config.theme || 'dark');
      if (config.lang) { window.setLang(config.lang); applyI18n(); }
    }
  });

  // Live theme switching (lang handled by selectLang())
  document.querySelectorAll('input[name="cfg-theme"]').forEach(radio => {
    radio.addEventListener('change', function() { applyTheme(this.value); });
  });

  // (Show TOS again removed from Settings — link is in the bottom app footer)

  // Add source modal
  document.getElementById('add-source-btn').addEventListener('click', () =>
    document.getElementById('add-source-modal').classList.remove('hidden'));
  document.getElementById('add-source-cancel').addEventListener('click', () =>
    document.getElementById('add-source-modal').classList.add('hidden'));
  document.getElementById('add-source-confirm').addEventListener('click', () => {
    const name = document.getElementById('new-source-name').value.trim();
    const api  = document.getElementById('new-source-api').value.trim();
    if (!name || !api) return;
    // Show legal warning when adding a NON-default source
    if (!isTrustedSourceName(name)) {
      document.getElementById('custom-source-name-display').textContent = `${name} → ${api}`;
      document.getElementById('add-source-modal').classList.add('hidden');
      document.getElementById('custom-source-warning-modal').classList.remove('hidden');
      return;
    }
    finalizeAddSource(name, api);
  });

  document.getElementById('custom-source-warning-cancel').addEventListener('click', () => {
    document.getElementById('custom-source-warning-modal').classList.add('hidden');
  });
  document.getElementById('custom-source-warning-confirm').addEventListener('click', () => {
    const name = document.getElementById('new-source-name').value.trim();
    const api  = document.getElementById('new-source-api').value.trim();
    document.getElementById('custom-source-warning-modal').classList.add('hidden');
    if (name && api) finalizeAddSource(name, api);
  });

  function finalizeAddSource(name, api) {
    config.sites[name] = { enabled: true, api, max_results: null };
    renderSettings();
    document.getElementById('new-source-name').value = '';
    document.getElementById('new-source-api').value  = '';
  }

  // Export / Import
  // Export-mode segmented buttons (Shareable / Backup) — replaces the radios.
  document.querySelectorAll('.export-mode-btn').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.export-mode-btn').forEach(x => x.classList.toggle('active', x === b));
  }));
  document.getElementById('flux-export-btn')?.addEventListener('click', async () => {
    const mode = document.querySelector('.export-mode-btn.active')?.dataset.mode || 'shareable';
    if (mode === 'backup') {
      const ok = await showConfirm({
        title:   t('export_full_title') || 'Export full backup?',
        body:    t('export_full_body') || 'A full backup includes EVERYTHING in your configuration — local folder paths, sync profiles, playlists, and all credentials (qBittorrent / SABnzbd / IRC SASL / SOCKS proxy passwords, API keys, server tokens).\n\nKeep this file private — it is meant for your own backup or for moving FLUX to another computer. Do NOT share it. To share your settings, use "Shareable" instead.',
        okLabel: t('export_full_ok') || 'Export full backup',
        danger:  true
      });
      if (!ok) return;
      readSettingsFromUI();
      const r = await window.api.flux.export(config, 'full');
      if (r.ok) alert(`${t('export_full_done') || 'Full backup exported (keep it private):'}\n${r.path}`);
    } else {
      readSettingsFromUI();
      const r = await window.api.flux.export(config, 'shareable');
      if (r.ok) alert(`${t('export_share_done') || 'Shareable profile exported (credentials & paths excluded):'}\n${r.path}`);
    }
  });
  document.getElementById('flux-import-btn').addEventListener('click', async () => {
    const r = await window.api.flux.import();
    if (!r.ok) return;
    const original = (r.config.profile_name || '').trim() || nextProfileName();
    // Ask whether to rename the imported profile (prefilled with its name) or keep
    // it (Cancel keeps the original). Then warn on a name collision.
    const entered = await showPrompt({ title: t('import_name_title') || 'Imported profile name', value: original });
    const finalName = (entered && entered.trim()) ? entered.trim() : original;
    if (profiles[finalName] && !(await showConfirm({
      title:   t('profile_overwrite_title') || 'Overwrite profile?',
      body:    t('profile_overwrite_body', { name: finalName }) || `A profile named "${finalName}" already exists and will be overwritten.`,
      okLabel: t('profile_overwrite_ok') || 'Overwrite', danger: true
    }))) return;
    config = { ...config, ...r.config, profile_name: finalName, tos_accepted: config.tos_accepted, tos_version: config.tos_version };
    await window.api.profiles.save(finalName, config);
    await window.api.config.save(config);
    profiles = await window.api.profiles.load();
    renderSettings();
    renderProfileBar();
    applyTheme(config.theme || 'dark');
    if (config.lang) { window.setLang(config.lang); applyI18n(); }
  });
}

// First free "Profilo N" name (counter cascades as profiles are created).
function nextProfileName() {
  let i = 1;
  while (profiles[`Profilo ${i}`]) i++;
  return `Profilo ${i}`;
}

// Small text-input modal — Electron blocks window.prompt(). Resolves to the
// entered string, or null on cancel / empty.
function showPrompt({ title, value = '', placeholder = '' } = {}) {
  return new Promise(resolve => {
    const modal = document.getElementById('name-prompt-modal');
    const input = document.getElementById('name-prompt-input');
    const titleEl = document.getElementById('name-prompt-title');
    const okBtn = document.getElementById('name-prompt-ok');
    const cancelBtn = document.getElementById('name-prompt-cancel');
    if (!modal || !input) { resolve(null); return; }
    titleEl.textContent = title || '';
    input.value = value; input.placeholder = placeholder || '';
    modal.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 50);
    const cleanup = () => {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
    };
    const onOk = () => { const v = input.value.trim(); cleanup(); resolve(v || null); };
    const onCancel = () => { cleanup(); resolve(null); };
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); onOk(); } else if (e.key === 'Escape') onCancel(); };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

function renderProfileBar() {
  const sel = document.getElementById('profile-select');
  if (!sel) return;
  sel.innerHTML = '';
  const names = Object.keys(profiles || {});
  if (!names.length) {
    const opt = document.createElement('option');
    opt.value = config.profile_name || 'Profilo 1';
    opt.textContent = opt.value; opt.selected = true;
    sel.appendChild(opt);
    return;
  }
  names.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    if (name === config.profile_name) opt.selected = true;
    sel.appendChild(opt);
  });
}

// ─── UPDATER POPUP ───────────────────────────────────────────────────────────
// Shown on a found update (startup auto-check) or after a manual "Check now".
// states: 'available' | 'downloading' | 'downloaded' | 'uptodate' | 'error'.
let _updaterModalBound = false;
function showUpdaterModal(state, info = {}) {
  const modal = document.getElementById('updater-modal');
  if (!modal) return;
  const msg   = document.getElementById('updater-modal-msg');
  const dlBtn = document.getElementById('updater-modal-download');
  const inBtn = document.getElementById('updater-modal-install');
  if (!_updaterModalBound) {
    _updaterModalBound = true;
    document.getElementById('updater-modal-close')?.addEventListener('click', () => modal.classList.add('hidden'));
    document.getElementById('updater-modal-releases')?.addEventListener('click',
      () => window.api.shell.openExternal('https://github.com/flux-hub-app/flux-hub/releases'));
    dlBtn?.addEventListener('click', () => { window.api.updater.download(); showUpdaterModal('downloading', {}); });
    inBtn?.addEventListener('click', () => window.api.updater.install());
  }
  dlBtn.classList.add('hidden');
  inBtn.classList.add('hidden');
  if (state === 'available') {
    msg.textContent = t('updater_available', { version: info.version || '?' }) || `Version ${info.version} is available.`;
    dlBtn.classList.remove('hidden');
  } else if (state === 'downloading') {
    msg.textContent = t('updater_downloading') || 'Downloading update…';
  } else if (state === 'downloaded') {
    msg.textContent = t('updater_downloaded') || 'Update downloaded. Restart to install.';
    inBtn.classList.remove('hidden');
  } else if (state === 'uptodate') {
    msg.textContent = t('updater_uptodate', { ver: info.current || '' }) || 'You are on the latest version.';
  } else { // 'error'
    msg.textContent = (t('updater_check_failed') || 'Could not check for updates.') + (info.error ? ` (${info.error})` : '');
  }
  modal.classList.remove('hidden');
}

// ─── UPDATER BANNER (legacy, unused — superseded by the popup above) ──────────
function showUpdaterBanner(state, info) {
  const banner = document.getElementById('updater-banner');
  const text   = document.getElementById('updater-banner-text');
  const dlBtn  = document.getElementById('updater-download-btn');
  const inBtn  = document.getElementById('updater-install-btn');
  if (!banner) return;

  if (state === 'available') {
    text.textContent = t('updater_available', { version: info?.version || '' });
    dlBtn.classList.remove('hidden');
    inBtn.classList.add('hidden');
  } else if (state === 'downloaded') {
    text.textContent = t('updater_downloaded');
    dlBtn.classList.add('hidden');
    inBtn.classList.remove('hidden');
  }
  banner.classList.remove('hidden');

  dlBtn.onclick = () => window.api.updater.download();
  inBtn.onclick = () => window.api.updater.install();
  document.getElementById('updater-dismiss-btn').onclick = () => banner.classList.add('hidden');
}

// ─── I18N ────────────────────────────────────────────────────────────────────
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  // applyI18n wipes textContent, which removes any inserted .lucide-slot
  // children on buttons that have data-i18n directly on them. Re-render the
  // icons so the SVG comes back prepended in front of the new label.
  if (typeof applyLucideIcons === 'function') applyLucideIcons();
  // Re-render TOS if visible
  const tosText = document.getElementById('tos-text');
  if (tosText && !document.getElementById('tos-overlay').classList.contains('hidden')) {
    tosText.innerHTML = window.buildTOSHtml();
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
// Map activity-log ID → human title for the auto-toast (when type='error').
const LOG_TOAST_TITLES = {
  'media-log':   'Media',
  'live-log':    'Live & Streaming',
  'radio-log':   'Radio',
  'torrent-log': 'Torrent search',
  'queue-log':   'Queue',
  'tag-log':     'Audio Editor',
  'spotify-log': 'Spotify',
  'xtract-log':  'Manage'
};
// Debounce identical toasts so retries / multi-error operations don't spam.
const _toastDedup = new Map(); // key=text+id → last fired timestamp

function appendLog(id, text, type = 'log') {
  const log = document.getElementById(id);
  if (log) {
    log.querySelector('.log-placeholder')?.remove();
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    // Strip any leading status glyph the caller wrote; the icon now comes from a
    // lucide glyph chosen by `type`, so the activity logs match the rest of the UI.
    const clean = String(text).replace(/^[✓✗✘✔▶⏹⏺⏸⬇↑↓🔍•]\s+/u, '');
    const LOG_ICON = { ok: 'check', error: 'x', warn: 'triangle-alert', info: 'info' };
    const icon = LOG_ICON[type];
    if (icon) {
      line.innerHTML = `<span class="log-line-icon" data-lucide-icon="${icon}" data-lucide-size="13"></span><span class="log-line-text">${escapeHtml(clean)}</span>`;
      applyLucideIcons(line);
    } else {
      line.textContent = clean;
    }
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }
  // Auto-surface every error log as a visible toast so the user gets feedback
  // even when activity logs are hidden (default). Dedupe within 3s.
  if (type === 'error') {
    const key  = id + '|' + text;
    const now  = Date.now();
    const last = _toastDedup.get(key) || 0;
    if (now - last > 3000) {
      _toastDedup.set(key, now);
      // Strip leading status glyph if the caller wrote one (`X ` or `✗ `)
      const body  = String(text).replace(/^[xX×✗✘]\s+/, '').trim();
      const title = LOG_TOAST_TITLES[id] || t('toast_generic_error_title') || 'Error';
      showToast({ title, body, kind: 'err', ttl: 6000 });
    }
  }
}

function clearLog(id) {
  const log = document.getElementById(id);
  if (!log) return;
  log.innerHTML = `<div class="log-placeholder" data-i18n="log_empty">${t('log_empty')}</div>`;
}

function initLogPlaceholders() {
  document.querySelectorAll('.activity-log').forEach(el => {
    if (!el.children.length) {
      el.innerHTML = `<div class="log-placeholder" data-i18n="log_empty">${t('log_empty')}</div>`;
    }
  });
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
