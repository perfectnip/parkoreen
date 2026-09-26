# Parkoreen plugin starter (API v1)

This folder is a source template, not an installable player plugin. For a fresh
starter, run `node tools/create-plugin.mjs <your-id>` from the repository root.
The command creates `assets/plugins/<your-id>/`, updates the manifest id and
name, and leaves the plugin out of the app's registered plugin list.

You can also copy this folder manually. Change the manifest id to match the
folder, update its metadata, and add the id to `assets/plugins/manifest.json`
only after reviewing the code.

For a local preview before registering the plugin, run
`node tools/serve-plugin-dev.mjs` from the repository root, then open
`http://127.0.0.1:4173/parkoreen/host.html?pluginDev=<your-id>&pluginDevToken=<token>`.
Copy the per-server token from the terminal output. The plugin appears in the
editor's plugin library so you can enable it on a development map. To preview
up to eight related local plugins together, list their ids separated by commas,
for example `?pluginDev=<your-id>,<dependency-id>&pluginDevToken=<token>`.
Each selected folder is watched, and a change reloads the preview. Save map edits
before changing plugin files. The random token prevents an unrelated website
from silently starting a local preview and is required for unregistered plugin
files and the reload stream. This mode still executes trusted page code; use it
only with your own plugin files. It is a development convenience, not a sandbox
or a player install path.

The starter `plugin.json` references the local manifest schema for JSON editor
completion and validation. Keep the reference when you create a plugin from the
scaffolder.

The starter demonstrates both an image and a three-frame sprite sheet declared
in its manifest. Through the `render.player` hook it loads them with
`ctx.api.getAssetUrl(...)`, draws a sprite-sheet frame with `drawImage`, and
falls back to the static marker while the sheet loads. The `animateMarker`
setting toggles the animation. Holding Q or tapping the mobile touch button
demonstrates the manifest-declared `markerPulse` control, which the runtime
exposes as `player.input.markerPulse`. The `showPlayerMarker` setting
demonstrates how manifest config reaches a plugin through
`ctx.api.getConfig()`. Change the drawing or add hooks to explore the API. Use
`ctx.api.addEventListener(...)` for browser listeners and
`ctx.api.onCleanup(...)` for timers or other resources so Parkoreen can release
them when a map changes or the plugin is disabled. See the
[API v1 hook reference](../../../wiki/current/plugins/#plugin-hooks) for event
payloads and which hooks can change game behavior. The bundled
`types/plugin-api-v1.d.ts` file provides editor completions for API methods and
hook payloads while you edit the starter. See [MIGRATION.md](MIGRATION.md) for
the API version policy and legacy plugin migration steps.

The same control can start a normal Mechanics Event: enable the plugin on the
map, add a **Player Action Input** trigger, and choose **Plugin: Marker pulse**.
Control ids share the `player.input` namespace, so choose an id unique across
all registered plugins; the runtime skips duplicate declarations and the
validator reports conflicts. Core movement ids (`left`, `right`, `up`, `down`,
`jump`, `shift`, and `space`) cannot be declared by plugins. `attack`, `heal`,
`dash`, and `superDash` are reserved for supported built-in plugin actions.
It fires once when the control changes from released to pressed, including
when pressed from its touch button. Custom-control triggers run locally in
hosted rooms; use a host-supported contact or input trigger for shared
authoritative changes.

Declare plugin-owned images, sprite sheets, JSON, and other files in
`plugin.json` so preflight and `.parkplugin` packaging include them:

```json
"assets": {
  "heroAtlas": "assets/hero-atlas.png",
  "levelData": "data/level.json"
}
```

Resolve a declared name with `ctx.api.getAssetUrl('heroAtlas')`; it returns a
versioned URL or `null` when the name is not declared. Assign the URL to an
`Image` before drawing it. Keep these files inside the plugin folder; the
validator rejects paths that escape it.

Before submitting a bundled plugin, run the metadata and path preflight from the
repository root:

```sh
node tools/validate-plugin.mjs assets/plugins/example
```

Replace `example` with the plugin folder id before running the command.

The validator enforces the package's 256-entry, 64 MiB per-file, and 128 MiB
combined manifest-and-assets limits before parsing declared JavaScript. It
checks the API v1 manifest fields, configuration defaults and
`showIf` references, dependencies, controls, editor feature flags, world-object
guards, that every declared asset exists as a regular file inside the plugin
directory, and the JavaScript syntax of declared `.js` script files. It also
checks dependency chains against bundled plugins and sibling plugin folders,
rejects known cycles, and warns when a dependency is unavailable for local
preview. It parses JavaScript without running it. The contract is also described by
[`plugin-manifest.schema.json`](../plugin-manifest.schema.json). It does not
review JavaScript behavior or make code safe to run.

To create a ZIP for code review or transfer, run:

```sh
node tools/package-plugin.mjs assets/plugins/example
```

The packager validates first and includes only `plugin.json` and its declared
runtime files. It limits files to 64 MiB each and 128 MiB total. The package is
not installable by Parkoreen and does not sandbox or certify the code. Its
`plugin-package.json` records SHA-256 hashes and sizes to detect transfer
corruption; hashes do not prove who published the package or whether its code
is safe. The metadata contract is documented in
[`plugin-package.schema.json`](../plugin-package.schema.json).
Verify a received archive with
`node tools/verify-plugin-package.mjs <file.parkplugin>`; the verifier checks
paths, ZIP integrity, declared files, sizes, and hashes without extracting or
executing the plugin. It also rejects API v1 manifests that declare permissions,
which the current runtime cannot enforce.

Plugins listed in the application manifest execute as trusted page scripts and
can access the page. API v1 cleanup helpers improve lifecycle management; they
are not a security sandbox. API v1 rejects a `permissions` manifest field
because the current runtime cannot enforce permission requests. Do not add
untrusted or player-installed code.
