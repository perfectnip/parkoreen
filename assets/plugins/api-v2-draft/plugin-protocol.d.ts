/** Draft only: no current Parkoreen runtime accepts API v2 messages. */
export type ParkoreenJsonValue =
    | null
    | boolean
    | number
    | string
    | ParkoreenJsonValue[]
    | { [key: string]: ParkoreenJsonValue };

export type ParkoreenJsonObject = { [key: string]: ParkoreenJsonValue };

export type ParkoreenPluginCapabilityV2 =
    | 'map.read'
    | 'players.read'
    | 'input.read'
    | 'render.commands'
    | 'audio.play'
    | 'gameplay.request'
    | 'storage.local';

/** Lowercase API v2 id syntax; the broker enforces the 64-character limit. */
export type ParkoreenPluginIdV2 = string;

export type ParkoreenPluginMethodV2 =
    | 'map.getSnapshot'
    | 'players.getSnapshot'
    | 'input.subscribe'
    | 'render.submit'
    | 'audio.play'
    | 'gameplay.request'
    | 'storage.get'
    | 'storage.set';

export interface ParkoreenPluginInitializeV2 {
    type: 'initialize';
    requestId: string;
    apiVersion: 2;
    pluginId: ParkoreenPluginIdV2;
    grants: ParkoreenPluginCapabilityV2[];
    config: ParkoreenJsonObject;
}

export interface ParkoreenPluginSuccessV2 {
    type: 'response';
    apiVersion: 2;
    responseTo: string;
    ok: true;
    value: ParkoreenPluginResultV2;
}

export interface ParkoreenPluginErrorV2 {
    type: 'response';
    apiVersion: 2;
    responseTo: string;
    ok: false;
    error: { code: string; message: string };
}

export interface ParkoreenPluginEventV2 {
    type: 'event';
    apiVersion: 2;
    sequence: number;
    name: string;
    payload: ParkoreenJsonValue;
}

export interface ParkoreenPluginReadyV2 {
    type: 'ready';
    responseTo: string;
    apiVersion: 2;
}

export interface ParkoreenMapObjectSnapshotV2 {
    id: string;
    name: string;
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
    enabled: boolean;
    collisionShape?: 'box' | 'circle' | 'capsule' | 'slopeUpRight' | 'slopeUpLeft' | 'polygon';
}

export interface ParkoreenMapSnapshotResultV2 {
    mapId: string | null;
    mapName: string;
    gravity: number;
    objectCount: number;
    objectOffset: number;
    nextObjectOffset: number | null;
    /** At most 64 map objects. Use nextObjectOffset to request another page. */
    objects: ParkoreenMapObjectSnapshotV2[];
}

export interface ParkoreenPlayerSnapshotV2 {
    /** Opaque, room-session-scoped id; never an account id. */
    playerId: string;
    /** Display name; it may itself identify a person. */
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    vx: number;
    vy: number;
    isGrounded: boolean | null;
    isDead: boolean | null;
}

export interface ParkoreenPlayersSnapshotResultV2 {
    playerCount: number;
    playerOffset: number;
    nextPlayerOffset: number | null;
    /** At most 32 unique client-visible players, sorted by playerId; re-read when current state matters. */
    players: ParkoreenPlayerSnapshotV2[];
}

export type ParkoreenStorageGetResultV2 =
    | { found: true; /** JSON-encoded UTF-8 size is at most 32 KiB. */ value: ParkoreenJsonValue }
    | { found: false };

export type ParkoreenPluginResultV2 =
    | ParkoreenMapSnapshotResultV2
    | ParkoreenPlayersSnapshotResultV2
    | { subscribedControlIds: string[] }
    | { queuedCommands: number }
    | { played: boolean }
    | { queuedForTick: number }
    | ParkoreenStorageGetResultV2
    | { stored: boolean };

interface ParkoreenPluginRequestEnvelopeV2<Method extends ParkoreenPluginMethodV2, Args extends object> {
    type: 'request';
    apiVersion: 2;
    requestId: string;
    method: Method;
    args: Args;
}

export type ParkoreenRenderCommandV2 =
    | { op: 'rect'; x: number; y: number; width: number; height: number; color: string; alpha?: number }
    | { op: 'circle'; x: number; y: number; radius: number; color: string; alpha?: number }
    | { op: 'text'; x: number; y: number; text: string; color: string; fontSize: number }
    | { op: 'image'; assetName: string; x: number; y: number; width: number; height: number; alpha?: number };

export type ParkoreenGameplayRequestV2 =
    | {
        action: 'setPlayerVelocity'; playerId: string; vx: number; vy: number;
        objectId?: never; enabled?: never; x?: never; y?: never;
    }
    | {
        action: 'setObjectEnabled'; objectId: string; enabled: boolean;
        playerId?: never; vx?: never; vy?: never; x?: never; y?: never;
    }
    | {
        action: 'setObjectPosition'; objectId: string; x: number; y: number;
        playerId?: never; vx?: never; vy?: never; enabled?: never;
    };

export type ParkoreenPluginRequestV2 =
    | ParkoreenPluginRequestEnvelopeV2<'map.getSnapshot', { objectOffset?: number; objectLimit?: number }>
    | ParkoreenPluginRequestEnvelopeV2<'players.getSnapshot', { playerOffset?: number; playerLimit?: number }>
    | ParkoreenPluginRequestEnvelopeV2<'input.subscribe', { controlIds: string[] }>
    | ParkoreenPluginRequestEnvelopeV2<'render.submit', { commands: ParkoreenRenderCommandV2[] }>
    | ParkoreenPluginRequestEnvelopeV2<'audio.play', { soundName: string; volume?: number }>
    | ParkoreenPluginRequestEnvelopeV2<'gameplay.request', ParkoreenGameplayRequestV2>
    | ParkoreenPluginRequestEnvelopeV2<'storage.get', { key: string }>
    | ParkoreenPluginRequestEnvelopeV2<'storage.set', { key: string; /** JSON-encoded UTF-8 size is at most 32 KiB. */ value: ParkoreenJsonValue }>;

export type ParkoreenHostMessageV2 = ParkoreenPluginInitializeV2
    | ParkoreenPluginSuccessV2
    | ParkoreenPluginErrorV2
    | ParkoreenPluginEventV2;

export type ParkoreenGuestMessageV2 = ParkoreenPluginReadyV2 | ParkoreenPluginRequestV2;
