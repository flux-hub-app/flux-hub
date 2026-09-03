'use strict';

// Each supported language lives in renderer/languages/<code>/ as several flat
// { key: 'translation', ... } category files (one per feature area — xtract,
// media, settings, etc. — see LANG_CATEGORIES) instead of one giant JSON, so
// touching one module's strings only means editing/reading one small file.
// All categories get merged into one flat lookup table at load time (see
// loadLanguages()) — t(key) doesn't know or care which category a key came
// from. Adding a new language = drop a matching set of category files in a
// new folder and append the code to SUPPORTED_LANGS. Missing keys gracefully
// fall back to the English value.
const SUPPORTED_LANGS = ['en', 'it', 'es', 'fr', 'de', 'pt', 'ja', 'ru', 'pl', 'zh-CN'];
const LANG_CATEGORIES = ['core', 'xtract', 'images', 'settings', 'files', 'queue', 'tag', 'irc', 'remote', 'legal', 'video', 'media', 'torrent', 'ai'];

// In-memory cache populated by loadLanguages(). Empty until the boot Promise
// resolves — callers should await window.__i18nReady before calling t().
const TRANSLATIONS = {};

// Section order for the TOS overlay. Same key list across all languages —
// each language file MUST provide every `tos_section_N_t` and `_b` listed
// here, otherwise that section renders with the English fallback.
const TOS_SECTIONS = [
  ['tos_section_1_t',  'tos_section_1_b'],
  ['tos_section_2_t',  'tos_section_2_b'],
  ['tos_section_3_t',  'tos_section_3_b'],
  ['tos_section_4_t',  'tos_section_4_b'],
  ['tos_section_5_t',  'tos_section_5_b'],
  ['tos_section_6_t',  'tos_section_6_b'],
  ['tos_section_7_t',  'tos_section_7_b'],
  ['tos_section_8_t',  'tos_section_8_b'],
  ['tos_section_9_t',  'tos_section_9_b'],
  ['tos_section_10_t', 'tos_section_10_b'],
  ['tos_section_11_t', 'tos_section_11_b'],
  ['tos_section_12_t', 'tos_section_12_b']
];

// Validate a language table: must be a flat object of string→string. Logs
// warnings for offenders but does not reject the table — silent degradation
// keeps a partially-broken contribution from killing the UI.
function validateLangTable(lang, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`[i18n] ${lang}.json must be a JSON object, got ${Array.isArray(data) ? 'array' : typeof data}`);
  }
  const keys = Object.keys(data);
  if (keys.length === 0) {
    console.warn(`[i18n] ${lang}.json is empty`);
  }
  let nonString = 0;
  for (const k of keys) {
    if (typeof data[k] !== 'string') {
      nonString++;
      if (nonString <= 5) console.warn(`[i18n] ${lang}.json: key "${k}" is not a string (got ${typeof data[k]}), skipping`);
      delete data[k];
    }
  }
  if (nonString > 5) console.warn(`[i18n] ${lang}.json: ${nonString} non-string values total were skipped`);
  return data;
}

// Fetches every category file for one language and merges them into a single
// flat table. A category that 404s/fails to parse just logs and is skipped
// (its keys fall back to English via t()) rather than failing the whole
// language — same "degrade, don't crash" philosophy as validateLangTable.
async function loadOneLanguage(lang) {
  const parts = await Promise.all(LANG_CATEGORIES.map(async cat => {
    const path = `languages/${lang}/${cat}.json`;
    let res;
    try { res = await fetch(path, { cache: 'no-cache' }); }
    catch (e) { console.error(`[i18n] fetch failed for ${path}:`, e.message); return null; }
    if (!res.ok) { console.error(`[i18n] ${path}: HTTP ${res.status}`); return null; }
    let data;
    try { data = await res.json(); }
    catch (e) { console.error(`[i18n] ${path} is not valid JSON:`, e.message); return null; }
    try { validateLangTable(`${lang}/${cat}`, data); }
    catch (e) { console.error(`[i18n] ${path} failed validation:`, e.message); return null; }
    return data;
  }));
  const merged = {};
  for (const part of parts) if (part) Object.assign(merged, part);
  return merged;
}

// Async loader — fires off all language fetches in parallel. The resulting
// Promise is exposed via window.__i18nReady so renderer.js can await it
// before kicking off the first applyI18n() pass.
async function loadLanguages() {
  const results = await Promise.all(SUPPORTED_LANGS.map(async lang => [lang, await loadOneLanguage(lang)]));
  for (const [lang, data] of results) {
    if (data && Object.keys(data).length) TRANSLATIONS[lang] = data;
  }
  // English is the universal fallback — without it every key would return
  // the raw key string. Hard-fail if it's missing.
  if (!TRANSLATIONS.en) {
    throw new Error('[i18n] CRITICAL: en.json failed to load — UI text would render as raw keys');
  }
  // Sanity report — count keys present in each non-EN language vs EN, useful
  // for spotting drift when contributors add new keys to EN.
  const enKeys = new Set(Object.keys(TRANSLATIONS.en));
  for (const lang of SUPPORTED_LANGS) {
    if (lang === 'en' || !TRANSLATIONS[lang]) continue;
    const langKeys = new Set(Object.keys(TRANSLATIONS[lang]));
    const missing = [...enKeys].filter(k => !langKeys.has(k)).length;
    if (missing > 0) {
      console.log(`[i18n] ${lang}: ${langKeys.size}/${enKeys.size} keys (${missing} missing, fall back to EN)`);
    }
  }
  return TRANSLATIONS;
}

// Lookup function — exposed as window.t. Resolution order:
//   1. current language table → key
//   2. English table → key
//   3. the raw key string (so missing keys are visible in dev)
// Then runs simple {var} interpolation from the second argument.
function t(key, vars = {}) {
  const lang = window.__fluxLang || 'en';
  const table  = TRANSLATIONS[lang] || {};
  const enTbl  = TRANSLATIONS.en   || {};
  let str = (table[key] != null ? table[key] : enTbl[key]) || key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  return str;
}

// Build the full HTML of the TOS overlay. The legally-binding document is the
// Italian version (window.TOS_DOC.it, in legal-content.js); every other UI
// language shows the English COURTESY translation, prefixed with a non-binding
// banner. Falls back to the old per-section keys only if TOS_DOC is missing.
function buildTOSHtml() {
  const doc = (typeof window !== 'undefined') ? window.TOS_DOC : null;
  if (doc && doc.it && doc.en) {
    const lang = window.__fluxLang || 'en';
    if (lang === 'it') return doc.it;
    const banner = `<div class="tos-courtesy-banner">${t('tos_courtesy_note')}</div>`;
    return banner + doc.en;
  }
  return TOS_SECTIONS
    .map(([titleKey, bodyKey]) => `<h3>${t(titleKey)}</h3><div class="tos-section-body">${t(bodyKey)}</div>`)
    .join('');
}

window.__fluxLang = 'en';
window.t = t;
window.setLang = function(lang) { window.__fluxLang = lang; };
window.buildTOSHtml = buildTOSHtml;
window.SUPPORTED_LANGS = SUPPORTED_LANGS;
window.__i18nReady = loadLanguages();
