export interface ParkoreenPluginPlayer {
    id?: string | null;
    name?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    vx: number;
    vy: number;
    input?: Record<string, boolean>;
    isDead?: boolean;
    isOnGround?: boolean;
    die?(world?: ParkoreenWorld, source?: ParkoreenMapObject | Record<string, unknown> | null): boolean;
    collisionShapeIntersectsBox?(box: ParkoreenBounds, object: ParkoreenMapObject): boolean;
    getCircleVerticalContact?(object: ParkoreenMapObject, box: ParkoreenBounds, direction: -1 | 1): number | null;
    getCapsuleVerticalContact?(object: ParkoreenMapObject, box: ParkoreenBounds, direction: -1 | 1): number | null;
    getCapsuleHorizontalContact?(object: ParkoreenMapObject, box: ParkoreenBounds, direction: -1 | 1): number | null;
    getSlopeSurfaceY?(object: ParkoreenMapObject, x: number): number | null;
    getCollisionPolygonPoints?(object: ParkoreenMapObject): ParkoreenPoint[] | null;
    [key: string]: unknown;
}

export interface ParkoreenBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ParkoreenPoint {
    x: number;
    y: number;
}

export interface ParkoreenMapObject {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    type?: string;
    appearanceType?: string;
    actingType?: string;
    collision?: boolean;
    collisionShape?: 'box' | 'circle' | 'capsule' | 'slopeUpRight' | 'slopeUpLeft' | 'polygon';
    collisionPoints?: Array<[number, number]>;
    polygonOneWay?: boolean;
    [key: string]: unknown;
}

export interface ParkoreenWorld {
    objects: ParkoreenMapObject[];
    plugins?: Record<string, unknown>;
    getObjectById?(id: string): ParkoreenMapObject | undefined;
    /**
     * Broadphase candidates near a world-space rectangle. The runtime may
     * reuse this result array on the next query; copy it with `.slice()`
     * before querying again or invoking code that can query the world.
     */
    queryNear?(x: number, y: number, width: number, height: number): ParkoreenMapObject[];
    [key: string]: unknown;
}

export interface ParkoreenAudioManager {
    play(name: string, volume?: number): void;
    [key: string]: unknown;
}

export interface ParkoreenHookPayloadMap {
    'game.ended': { player: ParkoreenPluginPlayer; world: ParkoreenWorld; elapsedMs: number; wasTestMode: boolean };
    'game.sceneLoaded': { player: ParkoreenPluginPlayer; world: ParkoreenWorld; mapId: string; previousMapName: string; mapName: string };
    'player.init': { player: ParkoreenPluginPlayer; world: ParkoreenWorld };
    'player.update': { player: ParkoreenPluginPlayer; world: ParkoreenWorld; audioManager?: ParkoreenAudioManager; deltaTime: number; skipPhysics: boolean };
    'player.jump': { player: ParkoreenPluginPlayer; canJump: boolean; didJump?: boolean };
    'player.jumped': { player: ParkoreenPluginPlayer; world: ParkoreenWorld; wasGrounded: boolean; source: 'core' | 'plugin' };
    'player.land': { player: ParkoreenPluginPlayer; world: ParkoreenWorld; surface: ParkoreenMapObject };
    'player.attack.hit': { player: ParkoreenPluginPlayer; world: ParkoreenWorld; object: ParkoreenMapObject; direction: 'up' | 'down' | 'forward'; pogoable: boolean };
    'player.damage': { player: ParkoreenPluginPlayer; source: Record<string, unknown>; world: ParkoreenWorld; preventDefault?: boolean };
    'player.died': { player: ParkoreenPluginPlayer; world: ParkoreenWorld; source: ParkoreenMapObject | Record<string, unknown> | null };
    'player.checkpoint': { player: ParkoreenPluginPlayer; world: ParkoreenWorld; checkpoint: ParkoreenMapObject };
    'player.respawn': { player: ParkoreenPluginPlayer; world: ParkoreenWorld };
    'input.keydown': { key: string; player: ParkoreenPluginPlayer };
    'input.keyup': { key: string; player: ParkoreenPluginPlayer };
    'input.update': { player: ParkoreenPluginPlayer; keys: Record<string, boolean>; layout: string };
    'button.pressed': { button: ParkoreenMapObject; player: ParkoreenPluginPlayer; world: ParkoreenWorld };
    'render.camera': { camera: Readonly<{ x: number; y: number; width: number; height: number; zoom: number }>; player: ParkoreenPluginPlayer | null; world: ParkoreenWorld; offsetX: number; offsetY: number };
    'render.player': { ctx: CanvasRenderingContext2D; player: ParkoreenPluginPlayer; camera: { x: number; y: number; width: number; height: number; zoom: number }; world: ParkoreenWorld };
    'render.hud': { ctx: CanvasRenderingContext2D; canvas: HTMLCanvasElement; player: ParkoreenPluginPlayer; world: ParkoreenWorld; xOffset: number; yOffset: number };
    'render.soulStatue': { ctx: CanvasRenderingContext2D; screenX: number; screenY: number; width: number; height: number; obj: ParkoreenMapObject; handled: boolean };
}

export type ParkoreenPluginHookName = keyof ParkoreenHookPayloadMap;

export interface ParkoreenPluginAPI {
    readonly apiVersion: 1;
    readonly pluginId: string;
    registerHook<K extends ParkoreenPluginHookName>(hookName: K, callback: (data: ParkoreenHookPayloadMap[K]) => void | Partial<ParkoreenHookPayloadMap[K]>, priority?: number): () => void;
    addEventListener(target: EventTarget, eventName: string, listener: EventListener, options?: boolean | AddEventListenerOptions): () => void;
    onCleanup(cleanup: () => void): () => void;
    getConfig<T extends Record<string, unknown> = Record<string, unknown>>(): T;
    getAssetUrl(name: string): string | null;
    playSound(soundName: string, volume?: number): void;
}

export interface ParkoreenPluginContext {
    api: ParkoreenPluginAPI;
    pluginId: string;
    world: ParkoreenWorld;
    pluginManager: unknown;
    hooks: Record<string, unknown>;
    sounds: Record<string, HTMLAudioElement | HTMLAudioElement[]>;
}
