'use strict';

// engine/profiles.js — named config presets (Settings > "Active Profile").
// Extracted verbatim from main.js's loadProfiles/saveProfiles (Fase C left
// these behind by oversight — pure fs read/write of a JSON, zero Electron,
// same shape as engine/config.js). Moving it here also fixes a real bug:
// `profiles` was in renderer/api-http.js's generic stub, which returns
// `{ok:false, error:'...'}` — a truthy object the renderer's `profiles =
// await window.api.profiles.load() || {}` (renderer.js:230) then iterated as
// if it were the profile map, showing "ok"/"error" as literal profile names
// in the Active Profile dropdown.
const fs = require('fs');
const path = require('path');
const enginePaths = require('./paths');

function profilesPath() {
  return path.join(enginePaths.getPaths().userData, 'profiles.json');
}

function loadProfiles() {
  try {
    if (fs.existsSync(profilesPath())) return JSON.parse(fs.readFileSync(profilesPath(), 'utf8'));
  } catch {}
  return {};
}

function saveProfiles(profiles) {
  try { fs.writeFileSync(profilesPath(), JSON.stringify(profiles, null, 2), 'utf8'); return true; }
  catch { return false; }
}

function saveProfile(name, config) {
  const p = loadProfiles();
  p[name] = { ...config, profile_name: name };
  return saveProfiles(p);
}

function deleteProfile(name) {
  const p = loadProfiles();
  delete p[name];
  return saveProfiles(p);
}

module.exports = {
  loadProfiles, saveProfiles, saveProfile, deleteProfile,
  routes: [
    { channel: 'profiles:load', method: 'GET', path: '/api/profiles',
      fn: 'loadProfiles', args: () => [] },
    { channel: 'profiles:save', method: 'POST', path: '/api/profiles/save',
      fn: 'saveProfile', args: body => [body.name, body.config] },
    { channel: 'profiles:delete', method: 'POST', path: '/api/profiles/delete',
      fn: 'deleteProfile', args: body => [body.name] },
  ],
};
