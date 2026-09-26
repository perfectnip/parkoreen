# Parkoreen plugin API migration notes

## Plugin version and API version

The manifest's `version` describes releases of your plugin. Use semantic
versioning for changes to your plugin's behavior, configuration, and assets.
The manifest's `apiVersion` describes the contract the Parkoreen runtime must
provide. The current runtime supports `apiVersion: 1` only.

Keep `apiVersion` at `1` for compatible plugin updates. Do not change the
meaning of a hook payload, API method, or manifest field while keeping the same
API version. If Parkoreen releases a breaking API, wait for a documented API
version and matching runtime support before migrating; never claim compatibility
with an API version that the runtime does not accept.

## Moving a legacy bundled plugin to API v1

1. Put plugin files in `assets/plugins/<id>/` and make `plugin.json` use the
   same lowercase id as its folder.
2. Set `apiVersion` to `1` and a separate plugin `version` such as `1.2.0`.
3. Declare every runtime script and sound with a relative path inside the
   plugin folder. List plugin dependencies explicitly.
4. Move hook registration to `ctx.api.registerHook(name, callback, priority)`.
   The callback receives the documented hook payload; mutate and return that
   payload when you need to change gameplay behavior.
5. Register DOM listeners with `ctx.api.addEventListener(...)`. Register timer
   and resource cleanup with `ctx.api.onCleanup(...)` so disabling the plugin
   or changing maps releases those resources.
6. Read manifest configuration through `ctx.api.getConfig()` and play declared
   sounds with `ctx.api.playSound(name, volume)`.
7. Run `node tools/validate-plugin.mjs assets/plugins/<id>` from the repository
   root, then review and exercise the plugin in a development build.

The starter's `types/plugin-api-v1.d.ts` and the hook reference in the Guide
describe the v1 hook payloads and methods. API v1 cleanup methods improve plugin
lifecycle handling; they do not sandbox bundled scripts.

API v1 does not support a `permissions` manifest field. The runtime and
preflight reject it so authors cannot mistake a declaration for an enforced
restriction. A later API may add capability requests only alongside an
enforcing isolated runtime and a user approval and revocation flow.

## Introducing a future breaking API

Before an API version changes, the Parkoreen runtime needs explicit compatible
version handling, a new type definition and starter, and a migration guide that
maps changed payloads and methods. Keep the v1 contract available while that
migration is supported. Third-party installation also needs reviewed
permissions, isolation, resource limits, and failure recovery; do not load
untrusted plugin code into the current page runtime.
