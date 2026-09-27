# Parkoreen

**A multiplayer 2D parkour game where you build maps and race friends.**

Build parkour courses in the editor, test them locally, then host a real-time multiplayer game and share the room code with anyone.

![License](https://img.shields.io/badge/license-Proprietary-red)

---

## Table of Contents

- [Features](#features)
- [Pages & Navigation](#pages--navigation)
- [Code Structure](#code-structure)
- [Editor Guide](#editor-guide)
- [Game Objects](#game-objects)
- [Map Config](#map-config)
- [Playing the Game](#playing-the-game)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Multiplayer](#multiplayer)
- [Plugins](#plugins)
- [File Format](#file-format)
- [Cloudflare Worker](#cloudflare-worker)
- [Resources](#resources)
- [License](#license)

---

## Features

- **2D platformer physics** — smooth movement, jumping, variable gravity, and box, circle, capsule, ramp, or polygon ground-block colliders
- **Full map editor** — place, move, rotate, resize, multi-select, undo/redo
- **Real-time multiplayer** — live position sync across all players in a room
- **Map and campaign mechanics** — visual triggers and ordered events with map, cross-map campaign, and per-player variables/Lists, timers, moving objects, and bounded temporary object spawning
- **Cloud map storage** — maps saved to the server; download as `.pkrn` files
- **Export / Import** — `.pkrn` files are ZIP archives (JSON or compressed binary)
- **Plugin system** — Hollow Knight–style ability plugins (HP bar, attacks, wall-cling, etc.)
- **Device-aware controls** — mobile devices get a virtual joystick and touch buttons; computers use keyboard controls
- **Admin tools** — drag players, quick kill, maps/rooms/users management panel

---

## Pages & Navigation

| Path | Purpose |
|------|---------|
| `/` → redirects to `/dashboard/` | Entry point |
| `/dashboard/` | Map list, create/edit/host maps |
| `/login/` `/signup/` | Authentication |
| `/settings/` | Volume, font size, keyboard layout |
| `/join/` | Join a room by code |
| `/mails/` | In-app mail / notifications |
| `/admin/` | Admin panel (role-gated) |
| `/wiki/` | Parkoreen Guide (offline-first HTML reference) |
| `/wiki/changelog/` | Version history |
| `/howtoplay/` | New-player tutorial |
| `host.html` | Host game runtime (opened by editor) |

The active engine and mechanics roadmap is in [`ROADMAP.md`](ROADMAP.md).

The **Dashboard hamburger menu** links to Mails, Settings, the Guide, Changelog, and Admin (role-gated).

## Code Structure

The browser app is organized around the map editor, the game runtime, and plugins. The main files to start with are:

| Path | Responsibility |
|---|---|
| `assets/js/editor.js` | Map editing UI, tools, object placement, and map configuration. |
| `assets/js/game.js` | `World` and `WorldObject`, player physics and collision, tilemaps, rendering, and play/test loops. |
| `assets/js/exportImport.js` | Map JSON and `.pkrn` serialization, import, and export. |
| `assets/js/mechanicsData.js` | Shared migration and normalization for Mechanics triggers, Events, and variables. Load this before code that deserializes map mechanics. |
| `assets/js/plugins.js` | Plugin discovery, manifest handling, lifecycle, and hook dispatch. |
| `assets/plugins/code/` | Mechanics editor and runtime: trigger/event authoring, action execution, variables, timers, UI actions, and Python event support. |
| `assets/plugins/hk/`, `assets/plugins/hp/`, `assets/plugins/cj/` | Bundled Hollow Knight, health, and controllable-jump plugins. Each plugin has a manifest and its own scripts/assets. |
| `cloudflare-worker/worker.js` | Room coordination and host-validated multiplayer Mechanics messages. Client movement and physics are still simulated by clients. |
| `wiki/current/` | Current player Guide pages. The `/wiki/` path remains for existing links. |
| `tools/` | Local plugin development, validation, packaging, and package inspection commands. |

### Map and Mechanics flow

The editor changes a `World`; `exportImport.js` serializes its map settings, objects, tilemaps, plugin configuration, and `codeData`. On load, `World.fromJSON` restores that data and the shared Mechanics normalizer migrates legacy `actions` records into canonical Events without losing distinct records. The Code plugin reads the normalized triggers, Events, and variables, validates links, then executes the ordered actions selected by runtime triggers. In a hosted room, supported shared changes are checked and synchronized through the Worker; other behavior may be local to each client, and unsupported guest trigger requests are rejected.

For plugin work, start with `assets/plugins/plugin-template/README.md` and `wiki/current/plugins/`. The API v1 workflow is for bundled or trusted localhost development code; the security model and API v2 draft describe the gates required before player-installed plugins can run.

---

## Editor Guide

### Opening the editor

From the Dashboard, click **Edit** on any map card, or click **New Map** to create one.

### Toolbar (bottom of screen)

| Button / Key | Action |
|---|---|
| **Fly** · `G` | Pan the camera freely; hold to fly the test player |
| **Move** · `M` | Click an object to drag it |
| **Duplicate** · `C` | Click an object to clone it |
| **Rotate** · `R` | Click an object to rotate it 90° clockwise |
| **Select** · `V` | Drag a box to multi-select; then move/rotate/delete the selection |
| **Erase** · `Q` | Click to delete objects (modes: All, Top Layer, Bottom Layer) |
| **Grid** · `H` | Toggle snap-to-grid overlay |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Escape` | Cancel current action / close open panel |

### Zoom

| Action | Method |
|---|---|
| Zoom in | `Ctrl/Cmd + Scroll Up` or `+` button |
| Zoom out | `Ctrl/Cmd + Scroll Down` or `−` button |

### Adding objects

Click **Add** to open the placement menu. Select a category, configure options, then click on the canvas to place. Most objects snap to the grid.

### Editing objects

Click any object with no tool active to open its **Edit Popup**:

- **Name** — custom label
- **Color** — color picker (hex + presets)
- **Opacity** — 0–100%
- **Rotation** — left / right buttons
- **Flip Horizontal** — mirror sprite
- **Collision** — toggle solid collision
- **Layer** — draw-order integer

Type-specific options (spikes, teleportals, bouncers, buttons, text, zones) appear in their own sections of the popup.

### Adjusting saw-blade size

In the object inspector, click **Adjust Size** to enter resize mode. Eight handles (corners + edges) appear in orange — drag them on the grid. Press `Escape` or **Stop Adjusting** to exit.

---

## Game Objects

### Block

Solid platform. Options:

- **Appearance** — Ground, Spike, Decorator
- **Acting type** — Ground, Spike, Checkpoint, Spawn, End, Text, Zone
- **Texture** — None, Brick, etc.
- **Collision** — on/off
- **Fill mode** — Add / Replace / Overlap

### Spike

Damage-dealing obstacle. Per-object options:

| Option | Description |
|---|---|
| **Touchbox preset** | Full, Normal (tip + sides), Tip Only, Ground, Flag, Air |
| **All Spike** | Flat base is also lethal — no safe standing zone |
| **Drop Hurt Only** | Only damages when the player is moving *toward* the tip |
| **Damage amount** | How much damage each hit deals |

### Saw Blade (Spinner)

Rotating circular obstacle. Options:

- **Size** — drag-handle resize in editor
- **Spin direction** — clockwise / counter-clockwise
- **Spin speed**
- **Damage amount**

### Teleportal

Linked portal pair. Teleports the player on contact.

- Each portal has a **Teleportal Name** (must be unique)
- **Send To** list — portal names this portal sends the player to
- **Receive From** list — portal names allowed to send players here
- A connection is active **only when both sides are set**: A's Send To must contain B _and_ B's Receive From must contain A
- Editor highlights valid connections in green, incomplete (one-way) entries in red
- **Particle Opacity** — 0–100% slider controlling the opacity of the portal's particle effects (default 100%)

### Bouncer

Spring pad that launches the player on contact.

- **Direction** — up / right / down / left (arrow picker in edit popup)
- **Match Appearance** — links launch direction and visual orientation together
- **Bounce strength** — 5–50 (default 20; normal jump is ~13)
- Bouncer works in both test mode and editor fly mode
- Spring animation plays on trigger; amplitude ramps up on rapid re-trigger (max ×3.5×)

### Button

Interactive trigger.

| Mode | Behavior |
|---|---|
| **Click** | Player enters zone → popup appears → click to confirm |
| **Collide** | Triggers immediately and silently when the player steps on it |

- **One-Time Trigger** — fires only once per session
- **Face Color** / **Base Color** — two independent color pickers
- Fires the `button.pressed` plugin hook when triggered

### Coin

Collectible item.

- Floats with a gentle up/down animation; disappears when collected; plays `coin.ogg`
- **Amount** — value added to the coin counter (default 1)
- **Activity Scope** — `Global` (all players see the change) or `Player` (only the collector)
- Coin counter shown above the toolbar during test/host mode; hidden if the map has no coins; controlled by **Show Coin Counter** in map config

### Zone

Named rectangular region used by plugins or game logic.

- Drag to place; drag handles to resize
- Each zone has a **Name** and **Color**

### Text

Floating text label.

- **Font** — Parkoreen Game and others
- **Font size** — 8–200 px
- **Alignment** — horizontal + vertical
- **Letter / line spacing**

### Checkpoint, Spawn Point, End Point

Placed via the **Game Item** entry in the Add menu.

---

## Map Config

Access via the **Config** button (top-left in the editor).

### General

| Setting | Description |
|---|---|
| Map Name | Display name |
| Background | Sky, Galaxy, or Custom (image / GIF / video) |
| Die Line Y | Y coordinate below which the player dies |
| Show Coin Counter | Show/hide the coin counter HUD |

### Physics

| Setting | Default |
|---|---|
| Player speed | 5 |
| Jump force | −14 |
| Gravity | 0.8 |

### Player

| Setting | Description |
|---|---|
| Jumps | Number of jumps allowed (or infinite) |
| Additional airjump | All jumps available in air |
| Collide with each other | Player–player collision in multiplayer |

### Default Colors

| Object | Default |
|---|---|
| Block | `#787878` |
| Spike | `#c45a3f` |
| Portal | `#9b59b6` |
| Bouncer | `#f59e0b` |

New objects are seeded from these world defaults.

### Checkpoint Colors

| State | Default |
|---|---|
| Default (untouched) | `#808080` |
| Active (current) | `#4CAF50` |
| Touched (past) | `#2196F3` |

### Spike Behavior (global defaults)

- **Touchbox preset** — Full / Normal / Tip / Ground / Flag / Air
- **Drop Hurt Only** — spikes only damage when the player moves toward the tip
- **Damage amount** — default damage per hit

### Music

Built-in tracks or upload custom audio; volume + loop controls.

### Data Type

`.json` (human-readable) or `.dat` (compressed binary) for the inner map data file.

---

## Playing the Game

### Controls

| Action | Keyboard | Touch |
|---|---|---|
| Move left/right | `A` / `D` or `←` / `→` | Joystick |
| Jump | `W`, `↑`, or `Space` | Jump button |
| Fly up/down | `W`/`S` or `↑`/`↓` (fly mode) | Joystick |

> **Keyboard layouts:** JimmyQrg (default) and Hollow Knight Original are selectable in Settings — attack, heal, dash, and super-dash keys differ between layouts.

### Tester mode (in editor)

| Key / Button | Action |
|---|---|
| Tester button | Start/stop test |
| `G` | Toggle fly |
| Respawn button | Respawn at last checkpoint / spawn point |
| Invincibility button | Toggle god mode |
| Touchboxes button | Show/hide hitbox overlays |
| `Escape` | Exit test and return to editor |

---

## Keyboard Shortcuts

### Editor

| Key | Action |
|---|---|
| `G` | Fly tool (also active in tester) |
| `M` | Move tool |
| `C` | Duplicate tool |
| `R` | Rotate tool |
| `V` | Select tool (multi-select) |
| `Q` | Erase tool |
| `H` | Toggle grid |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Escape` | Cancel / close |

### Admin (in-game)

| Key | Action |
|---|---|
| `G` | Toggle fly |
| `M` | Toggle Quick Drag Player |
| `K` | Quick Kill |

---

## Multiplayer

### Hosting

1. Open a map in the editor → **Config** → **Host Game**
2. Set max players and optional password → **Host Game**
3. Share the 6-character room code

The map is auto-saved when the tab is closed or reloaded (keepalive fetch).

### Joining

1. Dashboard → **Join** (or `/join/`)
2. Enter room code and password (if required) → **Join**

### Player colors

Each player gets a distinct color calculated to be maximally different from all current players in the room.

---

## Plugins

Plugins extend gameplay with custom mechanics loaded from `/assets/plugins/`.

| Plugin | Description |
|---|---|
| **HK** (Hollow Knight) | HP bar, attacks, wall-cling, dash, soul statue, pogo |
| **HP** | Generic HP system without HK abilities |
| **Code** | In-map JavaScript scripting (BETA) |
| **CJ** | Additional movement abilities |

Plugins expose hooks (`player.damage`, `player.respawn`, `button.pressed`, etc.) for inter-plugin communication. Gravity, jump height, and keyboard layout are individually configurable per plugin.

For bundled plugin development, create an unregistered API v1 starter with `node tools/create-plugin.mjs my-plugin`, preflight it with `node tools/validate-plugin.mjs assets/plugins/my-plugin`, create a review/transfer archive with `node tools/package-plugin.mjs assets/plugins/my-plugin`, and verify that archive with `node tools/verify-plugin-package.mjs my-plugin-0.1.0.parkplugin`. The starter demonstrates a declared image and a three-frame sprite-sheet animation, and includes JSDoc-linked type definitions for editor completions; preflight rejects plugin files over 64 MiB and combined manifest/assets over 128 MiB before parsing declared JavaScript, checks known dependency chains for cycles, and warns when dependencies cannot be resolved from bundled or sibling plugin folders. The packager includes only manifest-declared runtime files with SHA-256 hashes and sizes described by the [package metadata schema](assets/plugins/plugin-package.schema.json). The verifier checks ZIP paths, CRCs, file membership, sizes, and hashes without extracting or executing code. The `.parkplugin` ZIP is not installable and does not make its contents safe; hashes detect corruption but do not authenticate publishers. See the [Plugin authoring guide](wiki/current/plugins/) for hook payloads and the current trusted-code limits. Generated plugins are not loaded until reviewed and added to the bundled manifest; plugin scripts currently run as trusted page code and are not sandboxed. API v1 rejects a `permissions` field because it cannot enforce permissions yet. The [plugin security model](assets/plugins/PLUGIN_SECURITY_MODEL.md) defines the gates for future community installation.

---

## File Format

Parkoreen maps use the `.pkrn` extension. A `.pkrn` file is a ZIP archive:

```
my_map.pkrn  (ZIP)
├── data.json            ← map data (or data.dat for compressed)
├── uploaded_img_1.png   ← custom background (optional)
├── uploaded_sound_1.mp3 ← custom music (optional)
└── ...
```

### Map data structure (excerpt)

```json
{
  "version": "2.0",
  "metadata": { "name": "My Map", "objectCount": 42 },
  "settings": {
    "background": "sky",
    "playerSpeed": 5,
    "jumpForce": -14,
    "gravity": 0.8,
    "defaultPortalColor": "#9b59b6",
    "defaultBouncerColor": "#f59e0b",
    "showCoinCounter": true
  },
  "objects": [...]
}
```

Old v1.x `.pkrn` files (JSON-only) are automatically upgraded on import.

---

## Cloudflare Worker

The `cloudflare-worker/` directory contains the backend API (Cloudflare Workers + KV / D1).
See [`cloudflare-worker/README.md`](cloudflare-worker/README.md) for setup and deployment.

---

## Resources

- **Parkoreen Guide** — `/wiki/` — per-object, per-version, and plugin documentation
- **Changelog** — `/wiki/changelog/` — full version history
- **How to Play** — `/howtoplay/` — new-player guide

---

## License

**PROPRIETARY SOFTWARE — ALL RIGHTS RESERVED**

Copyright © 2026 JimmyQrg

No permission is granted to use, copy, modify, distribute, or create derivative works from this software. See [LICENSE](LICENSE) for full terms.
