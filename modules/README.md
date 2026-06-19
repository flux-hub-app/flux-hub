# FLUX Modules

FLUX is a modular offline-first platform. Each subfolder here is the future home of an independent module.

## Current status — Phase 1 (scaffolding)

The folders are **placeholders**. All module code still lives in the monolithic `main.js` + `renderer.js` + `index.html` at the project root. The `registry.json` here is the single source of truth: it defines which modules exist, which tabs they own, and which vendor binaries they need.

The renderer reads `registry.json` to drive the **Settings → Modules** page. For Phase 1 every module is forced "installed and enabled" — disable toggles will be wired up in Phase 2.

## Phase 2 (planned, v1.1+)

Move each module's code, view, assets, and i18n into its own folder:

```
modules/<id>/
├── main.js           IPC handlers + backend logic for this module
├── renderer.js       UI bindings, event handlers, view-specific state
├── view.html         HTML markup for the module's tabs (loaded into the shell)
├── styles.css        Module-specific styles
├── i18n/             Per-locale JSON files for this module's strings
├── vendor.json       Required vendor binaries (referenced in ../registry.json)
└── README.md         Module-specific docs
```

A loader in the main process reads `registry.json`, walks enabled modules, and dynamically wires up their IPC + UI. Disabling a module hides its tabs and skips its binary fetch on first launch.

## Module list

See [`registry.json`](./registry.json) for the canonical list with descriptions, tabs, and binary requirements.

## Adding a new module

1. Create `modules/<new-id>/` with the standard file layout
2. Add the entry to `registry.json` (id, name, description, tabs, binaries)
3. Add i18n strings under `modules/<new-id>/i18n/`
4. The Settings page picks it up automatically
