'use strict';

// engine/config.js — FLUX's persisted settings: defaults + load (with
// migrations) + save. Extracted verbatim from main.js (Phase C, 2026-08-23).
//
// `download_folder` in the defaults depends on engine/paths.js (the
// downloads dir). It's computed INSIDE getDefaultConfig(), not once at
// module load, so this file works correctly no matter when it's required
// relative to enginePaths.configurePaths() — a plain top-level object
// literal would freeze a wrong/empty path if required first.
const fs = require('fs');
const path = require('path');
const enginePaths = require('./paths');
const { log } = require('./log');

function configPath() {
  return path.join(enginePaths.getPaths().userData, 'config.json');
}

function getDefaultConfig() {
  return {
    profile_name:    'Profilo 1',
    download_folder: enginePaths.getPaths().downloadFolder,
    max_results:     5,
    log_enabled:     true,
    tos_accepted:    false,
    lang:            'system',        // resolves to OS locale at first launch
    theme:           'dark',          // 'dark' | 'light' | 'auto' — dark on first launch
    concurrency:     1,               // parallel downloads (1-5)
    retry_count:     2,               // retry attempts on media download fail
    notify_on_done:  true,            // desktop notifications
    // MP4 compatibility mode: when ON (default), all yt-dlp MP4 downloads
    // prefer H.264 video + AAC audio. Trade-off: ~30% larger files than
    // VP9 / AV1 but the result plays natively in QuickTime, iMovie, iPhone
    // Photos, default Windows player, etc. When OFF, yt-dlp picks "best"
    // codec which on YouTube is usually VP9 (sub-optimal Mac compat but
    // smaller files). Defaults ON because cross-device playback matters
    // more than a few MB to most users.
    mp4_compat:      true,
    splash_audio:    true,            // play the boot jingle on the splash screen
    topbar_player_collapsed:  false,  // remember collapsed state of the topbar music card
    topbar_actions_collapsed: false,  // remember collapsed state of the topbar actions card
    history_enabled: true,
    auto_update:     false,           // off by default until GitHub repo is configured
    acoustid_key:    '',              // AcoustID API key — get free at https://acoustid.org/api-key
    sidebar_collapsed: false,         // sidebar UI state — persisted
    sites: {
      // `mirrors` is a per-source list of fallback base URLs tried in order when
      // the primary `api` fails (any source type can use it; editable per-source
      // in the Add/Edit Source popup). YTS needs it because the site keeps
      // hopping domains (yts.mx went NXDOMAIN in Nov 2025).
      YTS:    { enabled: true,  api: 'https://yts.bz/api/v2', max_results: null,
                mirrors: ['https://yts.bz/api/v2', 'https://yts.lt/api/v2', 'https://yts.am/api/v2', 'https://yts.rs/api/v2', 'https://yts.mx/api/v2'] },
      Nyaa:   { enabled: true,  api: 'https://nyaa.si',       max_results: null },
      TPB:    { enabled: true,  api: 'https://apibay.org',    max_results: null }
      // 1337x removed — no stable public API endpoint. Users can add a custom one via "Add Source".
    },
    // Names of built-in sources the user has deleted, so the defaults' sites
    // merge in loadConfig doesn't resurrect them on the next launch.
    deleted_default_sites: [],
    rss_feeds: [],
    // rss_feeds: [{ name, url, auto_download: false, last_fetched, last_guids: [] }]
    subscriptions: [],
    // subscriptions: [{ id, query, keyword, enabled, last_checked, grabbed_ids: [] }]
    // Sonarr/Radarr-style "follow a search" — for titles with no ready-made RSS
    // feed (which is already covered by rss_feeds' auto_download above). Scheduler
    // periodically re-runs `query` against the configured torrent sources and
    // auto-queues new, not-yet-grabbed matches — see engine/autopoll.js, mirrors
    // pollFeed() exactly, same dedup shape.

    // Library Manager — auto-organise audio downloads into subfolders by tag.
    // Disabled by default; user opts in from Settings → Integrations.
    // Pattern tokens: {artist} {albumartist} {album} {year} {genre} {title} {track}
    // Missing tags fall back to "Unknown <field>" so the move never errors.
    library_enabled: false,
    library_pattern: '{artist}/{album}',

    // Media-server trigger — fire a refresh request to Plex / Jellyfin (or a
    // generic webhook) after every successful download so the library shows
    // up immediately instead of waiting for a scheduled scan.
    mediaserver_enabled: false,
    mediaserver_type: 'jellyfin',        // 'plex' | 'jellyfin' | 'webhook'
    mediaserver_url: '',                 // base URL, e.g. http://nas.local:8096
    mediaserver_token: '',               // API token (Plex X-Plex-Token / Jellyfin API key)
    mediaserver_library_id: '',          // optional library/section id (Plex needs it)

    // Send-to-client — forward torrents to an existing qBittorrent or
    // Transmission WebUI instead of downloading inside FLUX.
    sendto_enabled: false,
    sendto_type: 'qbittorrent',          // 'qbittorrent' | 'transmission'
    sendto_url: '',                      // e.g. http://seedbox:8080
    sendto_user: '',
    sendto_pass: '',
    sendto_category: '',                 // qBittorrent only — optional category tag

    // Send-to-Usenet — forward .nzb files to an existing SABnzbd or NZBGet
    // instance. Same shape as the torrent send-to-client, separate keyspace
    // because the two protocols and their auth schemes are different.
    sendnzb_enabled: false,
    sendnzb_type: 'sabnzbd',             // 'sabnzbd' | 'nzbget'
    sendnzb_url: '',
    sendnzb_key: '',                     // SABnzbd API key OR NZBGet username
    sendnzb_pass: '',                    // NZBGet password (SABnzbd ignores this)
    sendnzb_category: '',                // optional SAB category / NZBGet category

    // Remote companion (phone → FLUX) — Telegram bot + LAN mini web server.
    // Pairing codes/PINs themselves are short-lived and kept in memory only
    // (see remote module section), never persisted here.
    remote_bot_token:   '',              // from @BotFather, pasted once in the Remote panel
    remote_whitelist:   [],              // [{ chatId, label, pairedAt }] — Telegram chats allowed to command FLUX
    remote_lan_enabled: false,           // LAN mini web server toggle — never auto-started
    remote_lan_port:    8765,
    remote_lan_devices: [],              // [{ token, label, pairedAt }] — paired LAN devices

    // IRC/XDCC defaults — bound to the new IRC tab. Single saved server keeps
    // the UI simple; a future iteration can add multi-network support.
    irc_server: '',                      // irc.example.net
    irc_port:   6697,                    // default to TLS port (6697) since we ship with irc_tls:true
    irc_tls:    true,                    // TLS by default — modern networks (Libera/OFTC/Rizon) require it
    irc_nick:   'FluxUser',
    irc_channels: '',                    // comma-separated list to auto-join
    irc_xdcc_passive: false,             // not implemented yet — placeholder
    irc_users_w: '20%',                  // width of the user-list column (CSS value)
    irc_main_h: '',                      // height of the IRC main pane (CSS value, '' = default clamp())

    // SASL PLAIN auth for IRC. Account/password are sent during connection
    // BEFORE registration so NickServ doesn't see a plaintext IDENTIFY. Many
    // networks (Libera, Rizon, OFTC) also enable host cloaking once SASL
    // succeeds, hiding the user's IP from other channel members.
    irc_sasl_enabled: false,             // explicit on/off — both this and creds required to attempt SASL
    irc_sasl_account: '',
    irc_sasl_password: '',

    // SOCKS5 proxy — when enabled, all IRC sockets (plain + TLS + DCC) are
    // tunneled through this proxy. Point it at a local Tor daemon
    // (127.0.0.1:9050) or a commercial SOCKS5 endpoint to get a VPN-like
    // effect for IRC traffic without OS-level configuration.
    socks_enabled: false,
    socks_host: '',
    socks_port: 1080,
    socks_user: '',
    socks_pass: '',

    // Modular architecture — per-module on/off state. Keys mirror module ids
    // in modules/registry.json. Defaults: every module enabled (migration
    // safety — pre-modular users keep all features). `core` is intentionally
    // omitted from the toggle UI since it's required, but kept here as true
    // for completeness. The renderer reads this to hide tabs of disabled
    // modules at boot, and the Settings > Modules toggles write back here.
    modules_enabled: {
      core:     true,
      media:    true,
      torrent:  true,
      irc:      true,
      nzb:      true,
      tag:      true,
      identify: true,
      xtract:   true,
      images:   true
    }
  };
}

function loadConfig() {
  const defaults = getDefaultConfig();
  try {
    const cfgPath = configPath();
    if (fs.existsSync(cfgPath)) {
      const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      // Merge sites, then honour the user's deletions of built-in sources so a
      // deleted default (YTS/Nyaa/TPB) doesn't reappear on next launch. New
      // built-ins added in a future version still show up (they're not on the
      // deleted list), preserving the upgrade behaviour.
      const mergedSites = { ...defaults.sites, ...(saved.sites || {}) };
      for (const name of (saved.deleted_default_sites || [])) delete mergedSites[name];
      const merged = {
        ...defaults,
        ...saved,
        sites: mergedSites,
        // modules_enabled needs a shallow merge so a future-added module
        // (not present in the user's saved config) defaults to ON. Without
        // this, the spread above would replace the whole object and any
        // module added in a later version would be implicitly disabled
        // for upgrading users.
        modules_enabled: { ...defaults.modules_enabled, ...(saved.modules_enabled || {}) }
      };
      // Migration: 1337x had no stable endpoint and was removed from defaults.
      // Old saved configs may still carry it — drop it here once.
      for (const k of Object.keys(merged.sites)) {
        if (/^1337x?$/i.test(k)) delete merged.sites[k];
      }
      // Migration: yts.mx went NXDOMAIN (Nov 2025) and never came back. Old
      // saved configs still pin it as the YTS endpoint, which fails on every
      // search. Rewrite the dead domain to the current canonical one so the
      // fallback list isn't the only thing keeping YTS alive.
      for (const k of Object.keys(merged.sites)) {
        if (/^yts$/i.test(k) && /yts\.mx/i.test(merged.sites[k].api || '')) {
          merged.sites[k].api = 'https://yts.bz/api/v2';
        }
      }
      // Migration: seed the YTS fallback mirrors into the source config so they
      // live as an editable setting (visible in the source popup) rather than
      // hardcoded. Existing configs saved YTS without a `mirrors` field.
      if (merged.sites.YTS && !Array.isArray(merged.sites.YTS.mirrors)) {
        merged.sites.YTS.mirrors = [...(defaults.sites.YTS.mirrors || [])];
      }
      // Migration: `core` must always be enabled — it's the shared lifecycle
      // foundation and can't be turned off. Force-on regardless of what's
      // in saved config (defensive against manual edits to config.json).
      merged.modules_enabled.core = true;
      return merged;
    }
  } catch (e) { log('ERROR', `loadConfig: ${e.message}`); }
  return defaults;
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(enginePaths.getPaths().userData, { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (e) { log('ERROR', `saveConfig: ${e.message}`); return false; }
}

function resetTOS() {
  const cfg = loadConfig();
  cfg.tos_accepted = false;
  return saveConfig(cfg);
}

module.exports = {
  getDefaultConfig, loadConfig, saveConfig, resetTOS,
  // Only load/resetTOS declared here — `save` has a real per-caller side
  // effect (both main.js and server.js sync the Telegram bot's polling state
  // right after saving config) that stays hand-written on both sides, see
  // .claude/plans's Fase G Step 1 notes.
  routes: [
    { channel: 'config:load',     method: 'GET',  path: '/api/config',            fn: 'loadConfig', args: () => [] },
    { channel: 'config:resetTOS', method: 'POST', path: '/api/config/resetTOS',   fn: 'resetTOS',    args: () => [] },
  ],
};
