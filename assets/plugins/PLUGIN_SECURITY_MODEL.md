# User-authored plugin security model

This document defines the gates for moving from Parkoreen's bundled plugin
workflow to plugins authored and installed by players. It is a design and
release checklist, not a claim that the current runtime is isolated.

## Current trust boundary

- API v1 plugins are bundled code listed in `assets/plugins/manifest.json`.
- Those scripts execute in the game page and can access page state, browser
  APIs, and the network. Lifecycle helpers and syntax preflight do not restrict
  those capabilities.
- The starter creates an unregistered folder. A maintainer must review and
  bundle it before the application loads it.
- `tools/package-plugin.mjs` creates a ZIP for review and transfer from the
  manifest and its declared runtime assets. It does not install, register,
  inspect behavior, or isolate code. Its SHA-256 file list detects transfer
  corruption, but it does not authenticate a publisher or establish safety;
  the metadata format is described by `plugin-package.schema.json`.
- `tools/verify-plugin-package.mjs` checks the ZIP structure, safe paths,
  declared-file membership, CRCs, sizes, and SHA-256 hashes without extracting
  or executing code. It rejects API v1 permission declarations, which the
  runtime cannot enforce. It verifies integrity, not publisher identity or safety.
- API v1 rejects `permissions` declarations because it cannot enforce them.
- Maps may name bundled plugins and configure them, but a map is never an
  authority to download or execute code.

Do not accept community plugins into the current page runtime. A user-authored
plugin remains trusted code until every gate below is implemented and reviewed.

## Required architecture for an installable plugin API

### 1. An isolated execution origin

Run community code outside the game page, on an origin that does not share the
application's cookies or storage. Use a sandboxed frame without same-origin,
top-navigation, popup, form, or download privileges, or another isolation
boundary that passes an equivalent threat review. Never import community code
into the game window or a same-origin worker. Do not treat `eval`, `new
Function`, syntax parsing, a package signature, or an iframe that retains
same-origin access as isolation.

The host communicates with the plugin through a versioned message protocol.
Validate every message's type, fields, size, rate, and request id. The plugin
cannot receive DOM nodes, live game objects, arbitrary callbacks, raw storage,
or unrestricted browser objects. The host rejects unknown messages and checks
each request against the user's current grants.

### 2. A narrow capability broker

An installable manifest may request named capabilities only after the runtime
can enforce them. Start with independent grants such as:

- `map.read`: receive bounded, read-only map snapshots.
- `players.read`: receive bounded pages of client-visible gameplay snapshots
  using opaque session ids; never expose account ids or usernames through this
  capability.
- `map.edit`: request validated edits through host methods.
- `input.read`: receive declared input events, without access to credentials.
- `render.commands`: submit bounded drawing commands or approved assets; never
  receive the game's live canvas context.
- `audio.play`: play declared sounds through the host audio manager.
- `gameplay.request`: request supported player or world changes for validation
  at a defined game-tick boundary.
- `storage.local`: read and write a size-limited namespace for this plugin.
- `network.fetch`: disabled by default; if added, use a host proxy with an
  explicit origin allowlist, request limits, and no ambient cookies.

Ask the player before granting capabilities. Show the plugin identity, each
requested capability, and what it permits. For `players.read`, say that the
plugin can receive display names, position, movement, grounded, and dead state;
a display name can itself identify a person even though account ids and
usernames are excluded. Support denial, per-map grants, and revocation.
Revocation must stop message delivery, terminate the isolated runtime, remove
its render/audio/input registrations, and clear its temporary resources. A
saved map cannot grant permissions on the player's behalf.

### 3. Deterministic gameplay integration

Do not expose API v1's synchronous mutable physics hooks to isolated plugins.
Message-based plugins cannot safely mutate a live player object in the middle
of a physics step. Gameplay extensions must instead submit typed requests that
the host validates and applies at a documented tick boundary, or use a
separately reviewed deterministic extension contract. Render and audio hooks
can be enabled independently from gameplay mutation.

Every API version must specify ordering, request deadlines, stale-state
behavior, failure behavior, and whether an effect is local or host-authoritative
in multiplayer. A missing or timed-out plugin response must not stall the game
loop or leave half-applied physics state.

### 4. Package and map compatibility

Before installation, verify the manifest schema, supported `apiVersion`,
plugin id, dependencies, declared file list, file sizes, and content hashes.
Resolve dependencies without cycles and pin the installed plugin version and
content hash. A package signature can establish publisher provenance; it does
not make code safe and does not replace isolation or permissions.

Maps may record required plugin ids and compatible API ranges, but importing a
map must never install or execute a missing dependency. Explain missing or
incompatible plugins, allow the map to open without them where possible, and
preserve the dependency metadata on re-export.

### 5. Resource limits and failure recovery

Set limits for startup time, message rate and size, storage, declared assets,
render commands, and gameplay requests. Watch for repeated exceptions,
timeouts, and excessive work; disable the faulty plugin, clean up its resources,
and keep the map and game loop usable. Provide a clear error in the plugin
manager and a way to retry after the plugin or map changes.

## API and migration policy

Keep the plugin release `version` separate from runtime `apiVersion`. Continue
to support API v1 only for reviewed bundled plugins. Introduce a new API version
for isolated community plugins rather than silently changing v1's trusted
context or hook meanings. The new SDK must include a message-protocol type file,
a starter, migration notes, and manifest validation that matches runtime
enforcement. Do not add a permission field to v1.

## Release gates

Do not enable community installation until all of these are demonstrated:

1. Adversarial plugins cannot read the game DOM, account credentials, or
   application storage, and cannot navigate or open a privileged browsing
   context.
2. Capability denial and revocation take effect immediately, including for
   outstanding requests and active listeners.
3. Infinite loops, message floods, exceptions, malformed payloads, and oversized
   assets are contained without stalling or corrupting the game.
4. A plugin cannot exceed its granted map, player-read, input, render, audio, network,
   storage, or gameplay methods.
5. Multiplayer host validation and the trusted/untrusted boundary are explicit
   for every gameplay request.
6. Map import, export, missing dependencies, API incompatibility, upgrades,
   and removal have documented behavior that never auto-executes code.

The current validator and starter are useful for reviewed bundled development;
they do not pass these release gates.

The separate [API v2 draft](PLUGIN_API_V2_DRAFT.md) proposes a JSON-only,
capability-checked message contract for an isolated runtime. Its offline
protocol guard and reference broker exercise validation, quotas, correlation,
deadlines, and teardown, but are not integrated with the game or an isolation
boundary. These artifacts are design inputs for review, not implemented
enforcement or a permission to install third-party plugins.

## Local developer preview

The bundled `tools/serve-plugin-dev.mjs` server binds only to `127.0.0.1`, serves
the repository beneath `/parkoreen/`, rejects non-loopback Host headers, avoids
cache reuse, refuses hidden paths, and accepts browser live-reload connections
only from the matching localhost origin. Each server run prints a random
preview token. The explicit `?pluginDev=<id>&pluginDevToken=<token>` query,
unregistered plugin asset requests, and reload stream require that token; this
reduces cross-site navigation from silently initiating a local preview. This
keeps author iteration out of the production registry. The plugin still runs
as trusted same-page code and has the full page's authority; the token and
loopback server are workflow guardrails, not a sandbox or a security boundary
against malicious local code. Never use this mechanism to preview a plugin
from an untrusted source or to enable community installation.
