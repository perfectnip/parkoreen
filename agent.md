# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this repository.

## Project Overview

Parkoreen is a multiplayer 2D platformer with a full map editor, real-time multiplayer, plugin-extensible gameplay, and a level progression system.

- **Frontend**: pure static HTML/JS/CSS — no build step. Plain `<canvas>` 2D rendering, ES6 classes, no framework.
- **Backend**: Cloudflare Worker (Workers + KV + Durable Object) for auth, map storage, mail, admin tools, and WebSocket multiplayer.
- **PWA**: service worker uses the `parkoreen-v219` cache. It bypasses cache handling for `/admin` and `/mails` routes.
- **Note**: `agent.md` in the repo root is a duplicate of this file (kept for an external tool). Edit `CLAUDE.md` and re-sync `agent.md` if you change either.
- **Cloudflare dashboard is blocked in the user's home network in China.** Deploy via `wrangler deploy` works (the API at `api.cloudflare.com` is reachable), but `wrangler login` (OAuth to `dash.cloudflare.com`) does not. Plan accordingly if iterating from a blocked network.

The frontend can be opened directly (`index.html`) or served from any static host. For full multiplayer/admin features, deploy the Worker from `cloudflare-worker/`.

## Running Locally

```bash
# Frontend (any static server works; this is just an example)
npx serve .

# Backend
cd cloudflare-worker
wrangler deploy
```

Required KV namespaces: `USERS`, `MAPS`, `SESSIONS`. Optional: `GAME_ROOMS` (Durable Object for WebSocket).

Already-deployed Worker URL and KV namespace IDs live in `cloudflare-worker/README.md` — read it before redeploying to avoid clobbering existing bindings.

There is no linter or build step. Targeted Node tests cover Mechanics map-data normalization and the Cloudflare Worker's Mechanics event routing; run them with `node --test tools/mechanics-data.test.js tools/mechanics-worker.test.mjs`. These tests do not cover browser behavior. Also open the relevant HTML page and observe the changed behavior; for the editor, `host.html` is the all-in-one entry. For backend changes, hit the relevant route with `curl` from the deployed Worker URL.

## Project Structure

```
/                       # Static HTML entry points (no bundler)
host.html                # Editor + game player (all-in-one, ~3k lines)
index.html               # Level selection page (entry point)
dashboard/               # User's map management
login/, signup/          # Auth pages
settings/, mails/, admin/, howtoplay/, join/
wiki/                   # Parkoreen Guide pages (served at the legacy /wiki/ path)
assets/
  js/
    game.js             # Core engine: physics, player, camera, world, objects (~5k lines)
    editor.js           # Map editor UI, tools, panels, undo/redo (~10k lines)
    plugins.js          # Plugin manager + hook system
    spa-router.js       # SPA routing for dashboard/admin/etc.
    exportImport.js     # .pkrn ZIP format
    style.js            # ToastManager, ModalManager, LoadingManager
  plugins/              # Gameplay plugins (hk, hp, cj, code)
  pkrn/levels/          # Built-in level files
  svg/, png/, mp3/, ogg/, ttf/
runtime.js              # Auth, MapManager, MultiplayerManager, Settings (shared across pages)
cloudflare-worker/
  worker.js             # All backend routes + GameRoom Durable Object
  README.md             # Deployed URL + KV namespace IDs + redeploy steps
sw.js                   # Service worker
CHANGELOG.md            # Pointer to wiki/changelog (canonical Guide changelog)
```

## Key Architecture

### Game Engine (`assets/js/game.js`)

- `GameEngine` drives a fixed 60 FPS timestep loop with `requestAnimationFrame`. States: `EDITOR`, `TESTING`, `PLAYING`, `ENDED`.
- `Player` (32×32): physics with gravity, jumping, **coyote time (250ms grace)**, direction-change tracking for checkpoint jump-reset, fly mode, dead/respawn.
- `World` manages objects with a `SpatialHash` (128px cells, integer-stamp dedup — avoids `Set` allocation in hot loops). Per-frame `queryNear(x, y, w, h)` returns nearby objects.
- `WorldObject` is universal — every block, spike, teleport, coin, etc. is one. Carries `type`, `appearanceType`, `actingType`, color/opacity/layer/rotation/flip, plus per-type fields. Most SVG-based types cache pre-rendered offscreen canvases (tinted via `globalCompositeOperation: 'source-in'`) for performance.
- `Camera` smooth-follow with separate X/Y lerp, configurable. Zoom 0.5x–4x in editor/test, locked in play. `Ctrl+Scroll` zooms around player.
- **Collision uses two touchboxes**: `groundTouchbox` (lower portion for grounding) and `hurtTouchbox` (inset for damage). See spike modes below.
- **Tile cache**: Play/Test indexes static render objects by 512px chunk, rasterizes a chunk when the camera needs it, and bounds cached bitmaps with an LRU. The editor greedily meshes only the camera's 512px chunk region and reuses it until the view crosses a chunk or the map changes. Dynamic objects (zones, buttons, coins, checkpoints, spinners, text) stay out of merged ground meshes. Map data and collision indexes still load eagerly.

### Spike touchbox modes

`full`, `normal` (default), `tip`, `ground`, `flag`, `air`, `all-spike`. Plus per-spike `dropHurtOnly` (only damages when player moves toward tip). See `Player.checkHurtCollisions`.

### Editor (`host.html` + `assets/js/editor.js`)

- `Editor` wraps `GameEngine` with tool state, placement modes, undo/redo.
- **Tools**: `fly` (G), `move` (M), `duplicate` (C), `rotate` (R), `select` (V), `erase` (Q), grid toggle (H).
- **Undo** via `world.toJSON` snapshots, max 60. `Editor` wraps `world.addObject`/`removeObject` to snapshot before mutation. Supports transactions (brush strokes, multi-select moves) via `_undoTxnDepth`.
- **Selection modes**: `QUOT` (rectangle drag), `MULTI`, `MOUSE`.
- **Placement modes**: `BLOCK`, `OBSTACLE`, `KOREEN` (covers checkpoint/spawn/endpoint/zone/bouncer/coin), `SPAWN_END`, `TEXT`, `TELEPORTAL`, `BUTTON`.
- **Teleportal connections**: valid only when A's `sendTo` contains B **and** B's `receiveFrom` contains A. Editor highlights valid pairs green, invalid one-way entries red.

### Plugin System (`assets/js/plugins.js`)

- `PluginManager` loads plugins from `/assets/plugins/{id}/plugin.json`.
- Each plugin can declare `dependencies`, `scripts` (globals/inject/script + optional library scripts as `<script>` tags + editor script), `sounds`, `config`, `editorFeatures`, `worldObjectGuards`.
- Lifecycle per plugin: load declared libraries as script tags, then evaluate the plugin's globals, inject, and script in the page. Inject receives `{ api, pluginManager, pluginId, world, hooks, sounds }`. The v1 API adds hooks, listeners, config, asset URLs, sound playback, and cleanup registration.
- **Hooks** run in priority order on the game thread. Mutate the passed `data` object; returned fields are merged in. Current hook names: `player.init`, `player.update`, `player.damage`, `player.died`, `player.respawn`, `player.jump`, `player.jumped`, `player.land`, `player.checkpoint`, `player.attack.hit`, `game.ended`, `game.sceneLoaded`, `button.pressed`, `input.keydown`, `input.keyup`, `input.update`, `render.camera`, `render.hud`, `render.player`, `render.soulStatue`.
- **Plugin trust model**: current API v1 plugins are trusted page scripts. They can access the page and are not sandboxed; cleanup helpers manage lifecycle but are not a security boundary. Do not load untrusted plugin code. See the API v2 draft and Guide plugin documentation before changing this architecture.
- Plugins in repo: **HK** (Hollow Knight — HP/attacks/wall-cling/dash/super-dash/soul statue), **HP** (generic HP), **CJ** (movement abilities), **Code** (in-map Skulpt scripting, BETA).

### Multiplayer (`runtime.js` + `GameRoom` Durable Object)

- `MultiplayerManager` in `runtime.js` wraps a WebSocket to `/ws`.
- The Durable Object holds room state in `state.storage` keyed by `room:{code}` (6-char code, excludes visually-similar chars) and tracks sessions in a `Map`.
- **Player colors** computed server-side via `generateOptimalPlayerColor` — tries 72 candidate hues (every 5°), picks the one farthest from existing players' hues; if hue distance < 25°, also adjusts saturation/lightness.
- **Position sync**: client sends `{x, y, vx, vy, jumps}` every 100ms; server broadcasts to others; remote clients run prediction (`predictedX = serverX + vx * timeSinceUpdate`) with lerp smoothing (`0.2`). Host receives `position_ack` for reconciliation.
- Reconnect via `rejoin_room` restores the room and player list.

### `.pkrn` file format

ZIP archive (JSZip) containing:
- `data.json` or `data.dat` (RLE-compressed binary)
- `uploaded_img_1.png` (custom background), `uploaded_sound_1.mp3` (custom music)

RLE encoding: `0xFF, count, byte` for runs ≥4 identical bytes; `0xFF, 0x00` to escape literal `0xFF`. Short field names in serialization (`x`, `y`, `w`, `h`, `t`, `at`, `act`, `col`, `c`, `o`, `l`, `r`, `fh`, `n`, `tex`).

### Backend (`cloudflare-worker/worker.js`)

- **Auth**: SHA-256 of `password + JWT_SECRET`, base64 token `{userId, exp, iat}`. Sessions in KV `SESSIONS` with 7-day TTL.
- **Reserved display names**: `jimmyqrg`, `parkoreen`, `jimmyqrg160`, `jimmyqrgschool` may only be used by those exact usernames. Server auto-renames unauthorized users to "Change Me" on login.
- **Admin**: defaults `jimmyqrg`, `parkoreen` plus `ADMIN_USERNAMES` env var. Required for `/admin/*` routes and the editor's "impersonate edit any map" mode (`?admin=1&map=ID`).
- Routes: `/auth/{signup,login,profile,password}`, `/level-progress`, `/flag/{name}`, `/maps`, `/maps/{id}`, `/mail`, `/mail/unread`, `/mail/{id}`, `/ws`, `/settings`, `/editor/recent-fonts`, `/admin/{users,rooms,maps,global-bans,...}`.
- The Wrangler config (`wrangler.toml` or `wrangler.jsonc`) and binding IDs are tracked in `cloudflare-worker/`. KV namespace IDs are listed in `cloudflare-worker/README.md`.
- **Per-account state (post-`/settings` migration)**: game data is account-bound, not device-bound. KV keys owned per-user:
  - `settings:{userId}` — JSON blob with `{volume, fontSize, keyboardLayout, roleMode, testerShowTouchboxes, theme}`. Whitelisted server-side.
  - `recent_fonts:{userId}` — JSON array (capped at 20 server-side).
  - `global_bans` — single shared JSON blob (admin-only via `resolveAdminUser`).
  - Plus the pre-existing `level_progress:{userId}`, `flag:{userId}:{name}`, and `user:{userId}`.
- **Frontend sync pattern** (`runtime.js`): `SettingsManager.syncWithServer()` and `EditorPrefs.syncWithServer()` run on module load (no-op if logged out) and again after `Auth.login()`. On first login they do a **one-time migration**: if the server has nothing for this user but the local cache does, push local → server. After that, the server is authoritative and the local cache is purely a fallback for offline use. All mutations do a fire-and-forget `fetch(...PUT...)` while keeping the local cache in sync synchronously.

### Level Progression

- Built-in levels in `assets/pkrn/levels/` named `{group}_{level}[_{suffix}].pkrn` (e.g., `0_1`, `1_x_challenge_level`).
- Stored per-user in KV (`level_progress:{userId}`); falls back to `localStorage` for guests.
- Regular levels unlock when the previous one is completed. Challenge levels unlock when **all non-challenge levels in the group** are completed.
- Group 0 (levels `0_1`, `0_2`, `0_3`) is required before the "Map Editor" button appears on the dashboard.
- Special case: completing `0_3` scrolls to group 2 on the levels page on return.

## Conventions & Patterns

- **Performance**: the engine aggressively caches — `SpatialHash` uses integer stamps instead of `Set`, `WorldObject` caches pre-tinted offscreen canvases for SVG sprites, particle rendering batches by color/alpha into single `fill()` calls.
- **Device-specific UI** is selected by `ParkoreenDevice` in `runtime.js`; mobile/tablet devices show virtual controls, while computers use keyboard and pointer UI. `GameEngine` synthesizes touch events into mouse events, and touch controls are not an account preference.
- **Save/load safety**: `host.html` tracks `mapLoadedSuccessfully` and refuses to auto-save corrupt maps (shows a "Save Corrupted" popup with "Force Enter" option to override).
- **Auto-save**: 30s interval + 2s debounce on editor change + `beforeunload` keepalive fetch (so saves survive tab close/reload).
- **Keyboard layouts**: two supported — `JimmyQrg` (default) and `hk` (Hollow Knight — `Z` jump, `X` attack, `A` heal, `C` dash, `S` super-dash). Selected in Settings.
- **Color name `defaultBlockColor`, `defaultSpikeColor`, `defaultPortalColor`, `defaultBouncerColor`** on `World` are the colors new objects seed from when placed.
- **Editor undo/redo transactions** use `beginUndoTransaction()` / `endUndoTransaction()` to group multiple mutations into one undo step. Brush strokes and multi-select moves use this.
- **Cache-busting**: `runtime.js` and `style.js` are loaded with a hardcoded `?v=N` query string in every HTML page that uses them. When you change either file, bump the version in all references. Pages also reference these via different relative paths (`runtime.js?v=N`, `/parkoreen/runtime.js?v=N`, `../runtime.js?v=N`) — `grep` first to find them all.
- **Adding new server-backed state**: follow the `SettingsManager` / `EditorPrefs` pattern. Server-side: write `handleGet*` / `handleUpdate*` functions with input sanitization (whitelist allowed keys, type-check), route them in the auth-gated dispatch block, and use a `{userId}`-scoped KV key. Client-side: extend the relevant `*Manager` with `syncWithServer()` (try server → fall back to local → migrate local up on first login) and a `save()` that does a fire-and-forget PUT while keeping local state synchronous. See `runtime.js:SettingsManager` and `runtime.js:EditorPrefs` as templates.

## Known Pitfalls

- **Spike collision + rotation**: when changing spike `rotation`, the danger zone rotates with it. The collision code probes for adjacent solid blocks before allowing flat-base collision.
- **Editor vs play zoom limits**: `camera.setZoomLimits('editor')` allows 0.5x–4x; `'play'` and `'test'` lock to default. Set this when switching modes (see `GameEngine.startGame` / `startTestGame` / `stopGame`).
- **Mismatched braces in async functions crash hosting**: there was a recent bug where mismatched braces inside `initializePlayMode` closed the function early, breaking hosting with `await is only valid in async functions`. Watch for this pattern when refactoring async flows.
- **Coins are dynamic (not tile-cached)** so collected coins disappear immediately during gameplay.
- **`action` → `event` rename** in code plugin data: legacy maps with `codeData.actions` are auto-migrated to `codeData.events` on `World.fromJSON`. New code should use `events`.
- **`parkoreen_` prefix** is used for all `localStorage` keys (volume, user, token, level progress, recent fonts, etc.). Use this prefix for any new localStorage entries.
- **`API_URL`** in `runtime.js` is hardcoded to `https://parkoreen.ikunbeautiful.workers.dev`. Don't introduce new URLs without coordinating with deployment.
- **Service worker cache name must bump on frontend changes**: `CACHE_NAME` in `sw.js` is the cache key for the PWA. Bump the suffix (`parkoreen-vN` → `parkoreen-v{N+1}`) whenever frontend or plugin assets change, otherwise users on stale installs may not see the update. Keep the version reported above synchronized.
- **`activate-minimax.sh` at the repo root contains a hardcoded API token** (committed to git history). If you find yourself editing or referencing it, do not paste the token anywhere. Suggest to the user that they rotate it and either gitignore the file or move the token to an env var.
