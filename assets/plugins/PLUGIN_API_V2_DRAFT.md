# Isolated plugin API v2 draft

This is a protocol proposal for a future isolated plugin runtime. It is not an
implemented API, install format, or security boundary. Parkoreen continues to
load only reviewed, bundled API v1 plugins as trusted page scripts.

## Transport and envelopes

The host and plugin communicate over a dedicated `MessagePort` created for one
plugin instance. The host must transfer the port only to a sandboxed document on
the reviewed, separate plugin origin. No message may contain a DOM node, live
game object, canvas context, callback, credential, or browser storage handle.
Game data crosses the boundary only as bounded JSON snapshots or typed requests.

Every message is a plain JSON object with an exact, direction-specific shape.
Unknown fields, message kinds, methods, protocol versions, and non-JSON values
are rejected. Plugin request ids are positive decimal sequence strings starting
at `1` and increasing by one; this lets the host enforce uniqueness without
retaining an unbounded per-plugin id set. Responses must name the matching
request id.

```ts
type HostMessage =
  | { type: 'initialize'; requestId: string; apiVersion: 2; pluginId: string;
      grants: Capability[]; config: JsonObject }
  | { type: 'response'; apiVersion: 2; responseTo: string; ok: true; value: JsonValue }
  | { type: 'response'; apiVersion: 2; responseTo: string; ok: false;
      error: { code: string; message: string } }
  | { type: 'event'; apiVersion: 2; sequence: number; name: string; payload: JsonValue };

type PluginMessage =
  | { type: 'ready'; responseTo: string; apiVersion: 2 }
  | { type: 'request'; apiVersion: 2; requestId: string; method: PluginMethod;
      args: JsonObject };

type Capability = 'map.read' | 'players.read' | 'input.read' | 'render.commands' | 'audio.play'
  | 'gameplay.request' | 'storage.local';
type PluginMethod = 'map.getSnapshot' | 'players.getSnapshot' | 'input.subscribe'
  | 'render.submit' | 'audio.play' | 'gameplay.request' | 'storage.get' | 'storage.set';
```

`pluginId` uses Parkoreen's lowercase id syntax (`^[a-z0-9][a-z0-9_-]*$`)
with a 64-character maximum in API v2. The maximum keeps identity fields
bounded for package metadata and broker storage namespaces.

The draft's machine-readable [JSON Schema](api-v2-draft/plugin-protocol.schema.json)
and [TypeScript declarations](api-v2-draft/plugin-protocol.d.ts) define these
envelopes and method-specific request fields. They are reference artifacts only;
the runtime still needs to enforce them, and their method semantics need review.
The offline [`protocol-guard.mjs`](api-v2-draft/protocol-guard.mjs) and
`broker.mjs` are reference artifacts only; the first validates message
contracts, while the second demonstrates capability checks, sequential request
ids, token-bucket rate limiting, bounded pending work, deadlines, response
correlation, violation shutdown, and teardown. CI exercises both draft tools,
but neither is loaded by the game runtime; they do not create an isolation
boundary or permit API v2 installation. `tools/plugin-v2-draft-contract.test.mjs` exercises exact plugin request fields,
capability-to-method checks, package-declared inputs/assets/sounds, JSON depth,
storage size, adversarial payload rejection, request/response correlation, and
method-specific host result shapes. CI runs these draft contract checks, but
neither draft tool is loaded by the game runtime and the checks do not create
an isolation boundary or permit API v2 installation.

The contract is intentionally JSON-only. `JsonValue` is null, boolean, finite
number, string, array, or object composed recursively from those values. The
host rejects values nested beyond 16 levels, arrays longer than 256 entries,
and objects with more than 64 fields; JSON Schema expresses the collection
limits, while the broker must enforce depth iteratively before dispatch. The
map snapshot is separately paged at 64 objects per response so its bounded
records stay within the 64 KiB message budget.

## Initial method-to-capability map

| Method | Capability | Contract |
| --- | --- | --- |
| `map.getSnapshot` | `map.read` | Returns a bounded, immutable map snapshot with stable object ids and no account data. |
| `players.getSnapshot` | `players.read` | Returns a bounded page of live players with opaque, room-session ids and gameplay state; never account identifiers. |
| `input.subscribe` | `input.read` | Registers named input events declared in the package manifest. |
| `render.submit` | `render.commands` | Queues bounded drawing commands for the next render frame; no live canvas is exposed. |
| `audio.play` | `audio.play` | Plays a package-declared sound through the host audio manager. |
| `gameplay.request` | `gameplay.request` | Submits a typed action for validation at a documented game-tick boundary. |
| `storage.get`, `storage.set` | `storage.local` | Accesses a size-limited namespace owned by this plugin id. |

`map.edit` and `network.fetch` are not in the initial method set. Network access
must stay unavailable until a separate proxy design defines destination
allowlists, request budgets, and credential-free behavior. A map cannot grant a
capability. The player grants capabilities to a plugin installation, with
optional per-map restrictions; denial or revocation closes the port and
terminates the plugin instance.

The host validates every method's exact argument schema, capability, request
size, rate, and current map/session before doing work. The reference broker
validates protocol data and lifecycle limits but delegates current map/session
authorization and game-specific method semantics to the trusted host adapter.
The plugin receives only
the response fields documented for that method. Since the response envelope
contains only `responseTo`, the broker must retain the pending request's method
and validate `value` against that method's result schema before replying; a
generic valid JSON value is not sufficient. Gameplay requests are queued;
they never mutate physics synchronously from a message handler. Multiplayer
requests go through the same host-authoritative validation as built-in actions.
Each gameplay action has its own closed payload shape: a velocity request
cannot also carry object fields, and object requests cannot smuggle player or
velocity fields. The draft schema and TypeScript union both describe these
disjoint variants; a future broker must enforce the schema at runtime.

## Proposed successful results

| Method | Result `value` | Bound and behavior |
| --- | --- | --- |
| `map.getSnapshot` | `{ mapId, mapName, gravity, objectCount, objectOffset, nextObjectOffset, objects }` | Request `objectOffset` defaults to 0 and `objectLimit` defaults to 64 (maximum 64); invalid ranges return an error. An unsaved map has `mapId: null`; object ids are stable for the map. Each page reflects current map state, so plugins should re-read objects they need after gameplay changes. `nextObjectOffset: null` means the last page. |
| `players.getSnapshot` | `{ playerCount, playerOffset, nextPlayerOffset, players }` | Request `playerOffset` defaults to 0 and `playerLimit` defaults to 32 (maximum 32); invalid ranges return an error. Each record contains an opaque session-scoped `playerId`, display `name`, position, size, velocity, and nullable grounded/dead flags. A display name can itself identify a person, so the separate `players.read` grant must describe those fields. The host sorts by `playerId` before paging. The snapshot omits usernames and account ids, reflects current client-visible players, and may change between pages; it is not proof of authoritative position or gameplay state. `nextPlayerOffset: null` means the last page. |
| `input.subscribe` | `{ subscribedControlIds }` | Echoes only the validated controls accepted for this plugin; at most 32 unique ids. |
| `render.submit` | `{ queuedCommands }` | Counts commands accepted for the next frame, from 0 to 256. |
| `audio.play` | `{ played }` | Indicates whether the declared sound was accepted by the host audio manager. |
| `gameplay.request` | `{ queuedForTick }` | Acknowledges a validated request queued for that game tick; it does not claim the action has already succeeded. Rejections use the error envelope. |
| `storage.get` | `{ found: false }` or `{ found: true, value }` | A stored JSON `null` is distinct from a missing key. |
| `storage.set` | `{ stored }` | `false` means the bounded storage write was not committed; quota or validation failures may instead use the error envelope. |

The [JSON Schema](api-v2-draft/plugin-protocol.schema.json) and TypeScript
declarations describe these result shapes. The request id to method association
and per-method result check remain broker responsibilities.

## Proposed initial limits

- 64 KiB maximum encoded message size in either direction.
- 30 plugin requests per second, with a short burst capacity of 10.
- 250 ms request deadline; expiration returns a timeout response and never
  stalls a game or render tick.
- 2 MiB storage per plugin id, with 32 KiB maximum for one stored value.
- 256 render commands per frame, with a bounded allowlist of shapes, colors,
  transforms, and declared image assets.
- 128 gameplay requests queued per tick; excess requests are rejected and
  reported to the plugin manager.

These are starting limits for implementation review, not guarantees. Benchmarks
and adversarial tests must validate or revise them before API v2 is released.
The 32 KiB storage value limit counts the UTF-8 bytes of its JSON encoding and
leaves room for the success response envelope inside the 64 KiB message cap.
Repeated malformed messages, timeouts, or limit violations disable the plugin,
close its port, and release its host-owned registrations. The game loop never
waits for plugin readiness or a request response.

## Release requirements

Before implementation is considered installable, the host still needs a
separate-origin sandbox, capability prompt and revocation UI, method-specific
runtime enforcement of these schemas, resource cleanup, package
identity/version pinning, dependency resolution, and adversarial tests for
script escape attempts, message floods, malformed payloads, and infinite loops.
The offline request guard is contract tooling only and does not satisfy any
release gate in [the security model](PLUGIN_SECURITY_MODEL.md).
