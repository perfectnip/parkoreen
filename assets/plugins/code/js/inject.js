/**
 * Code Plugin - Inject Script
 * Handles runtime trigger evaluation and event execution
 */

(function(ctx) {
    'use strict';

    const pluginId = 'code';

    // Get plugin manager
    const getPluginManager = () => {
        if (typeof pluginManager !== 'undefined' && pluginManager) return pluginManager;
        return typeof window !== 'undefined' ? window.PluginManager || null : null;
    };

    // Mechanics system is always enabled (built into base game)
    const isEnabled = () => true;

    // Get world's code data safely
    const getCodeData = (world) => {
        if (!world) return { triggers: [], events: [], variables: [] };
        const normalize = globalThis.normalizeParkoreenCodeData;
        if (typeof normalize === 'function') {
            world.codeData = normalize(world.codeData);
            return world.codeData;
        }
        if (!world.codeData || typeof world.codeData !== 'object' || Array.isArray(world.codeData)) {
            world.codeData = { triggers: [], events: [], variables: [] };
        }
        // Migrate old 'actions' array to 'events' (backward compatibility)
        if (!Array.isArray(world.codeData.triggers)) {
            world.codeData.triggers = [];
        }
        if (!Array.isArray(world.codeData.events)) {
            world.codeData.events = [];
        }
        if (Array.isArray(world.codeData.actions)) {
            const seenIds = new Set(world.codeData.events.map(event => event?.id).filter(id => typeof id === 'string'));
            for (const action of world.codeData.actions) {
                if (!action || typeof action !== 'object' || Array.isArray(action) ||
                    (typeof action.id === 'string' && seenIds.has(action.id))) continue;
                if (typeof action.id === 'string') seenIds.add(action.id);
                world.codeData.events.push(action.type === 'action' ? { ...action, type: 'event' } : action);
            }
            delete world.codeData.actions;
        }
        if (!Array.isArray(world.codeData.variables)) {
            world.codeData.variables = [];
        }
        // Migrate old block type 'action' → 'event'
        for (const block of world.codeData.events) {
            if (block && typeof block === 'object' && !Array.isArray(block) && block.type === 'action') {
                block.type = 'event';
            }
        }
        return world.codeData;
    };

    // Get all zones in the world
    const getZones = (world) => {
        if (!world || !world.objects) return [];
        return world.objects.filter(obj => obj._mechanicsEnabled !== false && obj.appearanceType === 'zone' && obj.zoneName);
    };

    // Find zone by name
    const findZone = (world, zoneName) => {
        if (!zoneName) return null;
        return getZones(world).find(z => z.zoneName === zoneName);
    };

    // Find a mechanics-enabled map object by its stable id.
    const findMapObject = (world, objectId) => {
        if (!world || !objectId) return null;
        const object = world.getObjectById?.(objectId) ||
            world.objects?.find(item => item?.id === objectId);
        if (!object || object._mechanicsEnabled === false || object._collected === true) return null;
        return object;
    };

    const findTouchingMechanicsObject = (world, objectId, player, shape = 'box') => {
        if (!world || !objectId || !player) return null;
        return (world.objects || []).find(object =>
            (object.id === objectId || (object._mechanicsSpawned === true && object._mechanicsSpawnTemplateId === objectId)) &&
            object._mechanicsEnabled !== false && object._collected !== true &&
            (shape === 'circle' ? isPlayerInCircle(player, object)
                : shape === 'capsule' && typeof player.collisionShapeIntersectsBox === 'function'
                    ? player.collisionShapeIntersectsBox({ x: player.x, y: player.y, width: player.width || 24, height: player.height || 24 },
                        { ...object, collisionShape: 'capsule' })
                    : isPlayerInZone(player, object))
        ) || null;
    };

    // Check if player is inside a zone (AABB collision)
    const isPlayerInZone = (player, zone) => {
        if (!player || !zone) return false;

        const playerLeft = player.x;
        const playerRight = player.x + (player.width || 24);
        const playerTop = player.y;
        const playerBottom = player.y + (player.height || 24);

        const zoneLeft = zone.x;
        const zoneRight = zone.x + zone.width;
        const zoneTop = zone.y;
        const zoneBottom = zone.y + zone.height;

        return playerLeft < zoneRight &&
               playerRight > zoneLeft &&
               playerTop < zoneBottom &&
               playerBottom > zoneTop;
    };

    // Circle is an optional trigger overlap shape; it does not change solid physics.
    const isPlayerInCircle = (player, object) => {
        if (!player || !object) return false;
        const width = Number(object.width);
        const height = Number(object.height);
        if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return false;
        const radius = Math.min(width, height) / 2;
        const centerX = object.x + width / 2;
        const centerY = object.y + height / 2;
        const playerLeft = player.x;
        const playerTop = player.y;
        const playerRight = playerLeft + (player.width || 24);
        const playerBottom = playerTop + (player.height || 24);
        const closestX = Math.max(playerLeft, Math.min(centerX, playerRight));
        const closestY = Math.max(playerTop, Math.min(centerY, playerBottom));
        const dx = centerX - closestX;
        const dy = centerY - closestY;
        return dx * dx + dy * dy <= radius * radius;
    };

    const findTouchingTilemapCell = (world, tilemapId, collisionType, player) => {
        if (!world || !player || typeof tilemapId !== 'string' || !world.queryNear ||
            !world.tilemaps?.some(tilemap => tilemap.id === tilemapId)) return null;
        const playerWidth = player.width || 24;
        const playerHeight = player.height || 24;
        const nearby = world.queryNear(player.x, player.y, playerWidth, playerHeight);
        return nearby.find(object => object?._tilemapCell === true && object._tilemapId === tilemapId &&
            window.CODE_TILEMAP_CELL_MATCHES_TRIGGER_FILTER(object, collisionType) &&
            (object.collisionShape === 'polygon' && typeof player.collisionShapeIntersectsBox === 'function'
                ? player.collisionShapeIntersectsBox({ x: player.x, y: player.y, width: playerWidth, height: playerHeight }, object)
                : isPlayerInZone(player, object))) || null;
    };

    const MECHANICS_TILEMAP_CELL_BEHAVIORS = new Set(['solid', 'oneWay', 'rampUpRight', 'rampUpLeft', 'hazard', 'decorative']);
    const getTilemapCellById = (world, id) => {
        if (!world || typeof id !== 'string') return null;
        for (const tilemap of world.tilemaps || []) {
            const prefix = `tile-${tilemap.id}-`;
            if (!id.startsWith(prefix)) continue;
            const match = id.slice(prefix.length).match(/^(-?\d+)-(-?\d+)$/);
            if (!match) continue;
            const x = Number(match[1]);
            const y = Number(match[2]);
            if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) continue;
            const cell = tilemap._cellLookup?.get(`${x},${y}`) ||
                (tilemap.cells || []).find(item => item?.x === x && item?.y === y);
            if (cell && id === `tile-${tilemap.id}-${x}-${y}`) return { tilemap, cell, id };
        }
        return null;
    };

    const getTilemapCellAt = (world, tilemapId, x, y) => {
        if (typeof tilemapId !== 'string' || !Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return null;
        const tilemap = (world?.tilemaps || []).find(item => item?.id === tilemapId);
        if (!tilemap) return null;
        const cell = tilemap._cellLookup?.get(`${x},${y}`) ||
            (tilemap.cells || []).find(item => item?.x === x && item?.y === y);
        return cell ? { tilemap, cell, id: `tile-${tilemap.id}-${x}-${y}` } : null;
    };

    const setMechanicsTilemapCellBehavior = (world, worldState, target, collisionType, authoritative = false) => {
        if (!target?.tilemap || !target?.cell || !MECHANICS_TILEMAP_CELL_BEHAVIORS.has(collisionType)) return false;
        const { tilemap, cell, id } = target;
        const layer = world?.getLayerDefinition?.(tilemap.layer);
        if (collisionType !== 'decorative' && layer && (layer.parallaxX !== 1 || layer.parallaxY !== 1)) return false;
        let original = worldState.tilemapCellOriginals.get(id);
        if (!original) {
            if (cell.collisionType === collisionType) return false;
            original = { ...cell };
            worldState.tilemapCellOriginals.set(id, original);
        }
        const desired = collisionType === original.collisionType ? original : { ...cell, collisionType };
        const changed = world?.setTilemapCell?.(cell.x, cell.y, desired, tilemap.layer) === true;
        if (collisionType === original.collisionType) {
            worldState.tilemapCellOriginals.delete(id);
            worldState.tilemapCellOverrides.delete(id);
        } else {
            worldState.tilemapCellOverrides.set(id, collisionType);
        }
        if (changed && !authoritative) worldState.sharedMechanicsDirty = true;
        return changed;
    };

    const restoreMechanicsTilemapCell = (world, worldState, id, authoritative = false) => {
        const original = worldState.tilemapCellOriginals.get(id);
        const target = getTilemapCellById(world, id);
        let changed = false;
        if (original && target) {
            changed = world?.setTilemapCell?.(target.cell.x, target.cell.y, original, target.tilemap.layer) === true;
        }
        worldState.tilemapCellOriginals.delete(id);
        worldState.tilemapCellOverrides.delete(id);
        if (changed && !authoritative) worldState.sharedMechanicsDirty = true;
        return changed;
    };

    // Track player state for triggers (per-player in multiplayer)
    const createPlayerState = () => ({
        previousZones: new Set(),
        currentZones: new Set(),
        fallStartY: null,
        fallStartTime: null,
        isFalling: false,
        wasJumping: false,
        jumpStartTime: null,
        jumpTimeTriggerFired: false,
        triggerStates: new Map(),
        lastJumpWasGrounded: false,
        justJumped: false // Set by the successful player.jumped hook
    });

    const createWorldState = () => ({
        gameStarted: false,
        triggerStates: new Map(),
        playerStates: new Map(),
        // Keep pause accounting iterable even for the id-less local player in the WeakMap.
        playerStateRecords: new Set(),
        playerStatesByObject: new WeakMap(),
        triggerEnabled: new Map(),
        variables: new Map(),
        playerVariables: new Map(),
        persistedMechanicsKey: null,
        persistedCampaignKey: null,
        lists: new Map(),
        playerLists: new Map(),
        objectHealth: new Map(),
        pendingChoiceRoutes: new Map(),
        persistedMechanics: { map: Object.create(null), player: Object.create(null), objects: Object.create(null), lists: Object.create(null), playerLists: Object.create(null) },
        persistedCampaign: { values: Object.create(null) },
        objectMotions: new Map(),
        tilemapCellOriginals: new Map(),
        tilemapCellOverrides: new Map(),
        timers: new Map(),
        worldPauseTokens: new Set(),
        timerFires: 0,
        runtimeErrors: [],
        runtimeErrorTimes: new Map(),
        lastErrorToastAt: 0,
        sharedMechanicsDirty: false,
        mechanicsClockOffset: 0,
        lastSharedMechanicsState: undefined,
        lastSharedMechanicsRoomCode: null
    });

    // Keep runtime state stable across PluginManager.initFromWorld(), which
    // re-evaluates plugin inject scripts each time a map is loaded.
    const createGlobalState = () => ({
        pressedKeys: new Set(),
        keyJustPressed: new Set(),
        worldStates: new WeakMap(),
        runtimeErrors: [],
        dialogueQueue: [],
        activeDialogue: null,
        listPanels: new Set()
    });
    const globalState = (() => {
        if (typeof window === 'undefined') return createGlobalState();
        if (!window.__parkoreenCodeRuntimeState) {
            window.__parkoreenCodeRuntimeState = createGlobalState();
        }
        return window.__parkoreenCodeRuntimeState;
    })();
    if (globalState.activeWorld === undefined) globalState.activeWorld = null;
    if (!Array.isArray(globalState.dialogueQueue)) globalState.dialogueQueue = [];
    if (globalState.activeDialogue === undefined) globalState.activeDialogue = null;
    if (!(globalState.listPanels instanceof Set)) globalState.listPanels = new Set();
    if (!Array.isArray(globalState.runtimeErrors)) globalState.runtimeErrors = [];

    const EVENT_ACTION_YIELD = Symbol('event-action-yield');
    const EVENT_ACTION_STOP = Symbol('event-action-stop');

    const clearWorldTimer = (world, timerName) => {
        const worldState = world && globalState.worldStates.get(world);
        const timer = worldState?.timers?.get(timerName);
        if (!timer) return false;
        clearTimeout(timer.handle);
        worldState.timers.delete(timerName);
        return true;
    };

    const clearWorldTimers = (world) => {
        const worldState = world && globalState.worldStates.get(world);
        if (!worldState?.timers) return;
        for (const timer of worldState.timers.values()) clearTimeout(timer.handle);
        worldState.timers.clear();
    };

    const pauseWorldTimers = (world, worldState) => {
        for (const timer of worldState?.timers?.values?.() || []) {
            if (timer.handle === null || timer.handle === undefined || timer.executing === true) continue;
            clearTimeout(timer.handle);
            timer.handle = null;
            timer.remainingMs = Math.max(0, (Number.isFinite(timer.dueAt) ? timer.dueAt : Date.now()) - Date.now());
            timer.dueAt = null;
        }
    };

    const resumeWorldTimers = (world, worldState) => {
        if (worldState?.worldPauseTokens?.size) return;
        for (const timer of worldState?.timers?.values?.() || []) {
            if (timer.handle === null || timer.handle === undefined) scheduleWorldTimer(timer);
        }
    };

    const setMechanicsWorldPaused = (world, token, shouldPause) => {
        if (!world || !token) return;
        const engine = window.engine;
        const worldState = getWorldState(world);
        if (shouldPause) {
            if (engine?.world !== world || !['playing', 'testing'].includes(engine?.state) ||
                getMultiplayerManager()?.getRoomCode?.()) return;
            if (worldState.worldPauseTokens.has(token)) return;
            const wasPaused = worldState.worldPauseTokens.size > 0;
            worldState.worldPauseTokens.add(token);
            if (!wasPaused) {
                engine.mechanicsWorldPaused = true;
                engine.mechanicsPauseNeedsRender = true;
                engine.mechanicsPauseStartedAt = Date.now();
                pauseWorldTimers(world, worldState);
            }
            return;
        }
        if (!worldState.worldPauseTokens.delete(token) || worldState.worldPauseTokens.size > 0) return;
        if (engine?.world === world) {
            engine.mechanicsWorldPaused = false;
            engine.mechanicsPauseNeedsRender = false;
            const pausedDuration = Number.isFinite(engine.mechanicsPauseStartedAt)
                ? Math.max(0, Date.now() - engine.mechanicsPauseStartedAt) : 0;
            if (Number.isFinite(engine.mechanicsPauseStartedAt) && Number.isFinite(engine.gameStartTime)) {
                engine.gameStartTime += pausedDuration;
            }
            engine.mechanicsPauseStartedAt = null;
            for (const triggerState of worldState.triggerStates.values()) {
                if (Number.isFinite(triggerState.lastExecutedAt)) triggerState.lastExecutedAt += pausedDuration;
            }
            for (const playerState of worldState.playerStateRecords) {
                if (Number.isFinite(playerState.fallStartTime)) playerState.fallStartTime += pausedDuration;
                if (Number.isFinite(playerState.jumpStartTime)) playerState.jumpStartTime += pausedDuration;
                for (const triggerState of playerState.triggerStates.values()) {
                    if (Number.isFinite(triggerState.lastExecutedAt)) triggerState.lastExecutedAt += pausedDuration;
                    if (Number.isFinite(triggerState.fallStartTime)) triggerState.fallStartTime += pausedDuration;
                    if (Number.isFinite(triggerState.jumpStartTime)) triggerState.jumpStartTime += pausedDuration;
                }
            }
            for (const motion of worldState.objectMotions.values()) {
                if (Number.isFinite(motion.startedAt)) motion.startedAt += pausedDuration;
            }
            for (const object of world.objects || []) {
                const animation = object?._mechanicsSpriteAnimation;
                if (animation && Number.isFinite(animation.startedAt)) animation.startedAt += pausedDuration;
                if (animation && Number.isSafeInteger(animation.startedAtServer)) animation.startedAtServer += pausedDuration;
                if (object?._mechanicsSpawned === true && Number.isFinite(object._mechanicsSpawnExpiresAt)) {
                    object._mechanicsSpawnExpiresAt += pausedDuration;
                }
            }
        }
        resumeWorldTimers(world, worldState);
    };

    const activateWorldRuntime = (world) => {
        if (!world || typeof world !== 'object') return;
        if (globalState.activeWorld && globalState.activeWorld !== world) {
            clearWorldTimers(globalState.activeWorld);
            clearMechanicsListPanels();
        }
        globalState.activeWorld = world;
    };

    // Get or create player state
    const getPlayerState = (player, world) => {
        if (!player || typeof player !== 'object') return createPlayerState();
        if (!world || typeof world !== 'object') return createPlayerState();

        const worldState = getWorldState(world);
        if (!player.id) {
            if (!worldState.playerStatesByObject.has(player)) {
                const playerState = createPlayerState();
                worldState.playerStatesByObject.set(player, playerState);
            }
            const playerState = worldState.playerStatesByObject.get(player);
            worldState.playerStateRecords.add(playerState);
            return playerState;
        }

        if (!worldState.playerStates.has(player.id)) {
            const playerState = createPlayerState();
            worldState.playerStates.set(player.id, playerState);
        }
        const playerState = worldState.playerStates.get(player.id);
        worldState.playerStateRecords.add(playerState);
        return playerState;
    };

    const getTriggerState = (playerState, trigger) => {
        const key = trigger.id ?? trigger;
        if (!playerState.triggerStates.has(key)) {
            playerState.triggerStates.set(key, {});
        }
        return playerState.triggerStates.get(key);
    };

    const getWorldTriggerState = (world, trigger) => {
        if (!world || typeof world !== 'object') return {};
        if (!globalState.worldStates.has(world)) {
            globalState.worldStates.set(world, createWorldState());
        }
        const worldState = globalState.worldStates.get(world);
        const key = trigger.id ?? trigger;
        if (!worldState.triggerStates.has(key)) {
            worldState.triggerStates.set(key, {});
        }
        return worldState.triggerStates.get(key);
    };

    const getWorldState = (world) => {
        if (!world || typeof world !== 'object') return null;
        if (!globalState.worldStates.has(world)) {
            globalState.worldStates.set(world, createWorldState());
        }
        const state = globalState.worldStates.get(world);
        if (!(state.triggerEnabled instanceof Map)) state.triggerEnabled = new Map();
        if (!(state.timers instanceof Map)) state.timers = new Map();
        if (!(state.playerStateRecords instanceof Set)) {
            state.playerStateRecords = new Set(state.playerStates instanceof Map ? state.playerStates.values() : []);
        }
        if (!(state.worldPauseTokens instanceof Set)) state.worldPauseTokens = new Set();
        if (!(state.playerVariables instanceof Map)) state.playerVariables = new Map();
        if (!(state.lists instanceof Map)) state.lists = new Map();
        if (!(state.playerLists instanceof Map)) state.playerLists = new Map();
        if (!(state.objectHealth instanceof Map)) state.objectHealth = new Map();
        if (!(state.pendingChoiceRoutes instanceof Map)) state.pendingChoiceRoutes = new Map();
        if (!(state.objectMotions instanceof Map)) state.objectMotions = new Map();
        if (!(state.tilemapCellOriginals instanceof Map)) state.tilemapCellOriginals = new Map();
        if (!(state.tilemapCellOverrides instanceof Map)) state.tilemapCellOverrides = new Map();
        if (!Array.isArray(state.runtimeErrors)) state.runtimeErrors = [];
        if (!(state.runtimeErrorTimes instanceof Map)) state.runtimeErrorTimes = new Map();
        if (!Number.isFinite(state.lastErrorToastAt)) state.lastErrorToastAt = 0;
        if (typeof state.sharedMechanicsDirty !== 'boolean') state.sharedMechanicsDirty = false;
        ensurePersistentMechanicsLoaded(world, state);
        ensurePersistentCampaignLoaded(state);
        for (const variable of getCodeData(world).variables) {
            if (variable.enabled === false || variable.variableType === 'list' || variable.scope === 'player') continue;
            if (!state.variables.has(variable.id)) {
                const campaignValue = variable.scope === 'campaign' && !getMultiplayerManager()?.getRoomCode?.() &&
                    window.engine?.state !== 'testing'
                    ? getMechanicsCampaignKey(variable) && Object.hasOwn(state.persistedCampaign.values, variable.campaignKey)
                        ? state.persistedCampaign.values[variable.campaignKey] : null
                    : null;
                const savedValue = variable.scope === 'campaign'
                    ? campaignValue?.kind === 'scalar' && campaignValue.valueType === variable.valueType
                        ? campaignValue.value : undefined
                    : variable.persist === true ? state.persistedMechanics.map[variable.id] : undefined;
                const initialValue = isValidVariableValue(variable, savedValue)
                    ? normalizeVariableValue(variable, savedValue)
                    : normalizeVariableValue(variable, variable.defaultValue);
                state.variables.set(variable.id, initialValue);
            }
        }
        for (const variable of getCodeData(world).variables) {
            if (variable.enabled === false || variable.variableType !== 'list' || variable.scope === 'player' || state.lists.has(variable.id)) continue;
            const isHostedRoom = Boolean(getMultiplayerManager()?.getRoomCode?.());
            const isTestRun = window.engine?.state === 'testing';
            const campaignValue = variable.scope === 'campaign' && !isHostedRoom && !isTestRun
                ? getMechanicsCampaignKey(variable) && Object.hasOwn(state.persistedCampaign.values, variable.campaignKey)
                    ? state.persistedCampaign.values[variable.campaignKey] : null
                : null;
            const savedList = variable.scope === 'campaign'
                ? campaignValue?.kind === 'list' && isValidMechanicsList(variable, campaignValue.items)
                    ? campaignValue.items : undefined
                : variable.persist === true && !isHostedRoom && !isTestRun
                    ? state.persistedMechanics.lists[variable.id]
                    : undefined;
            const initialList = isValidMechanicsList(variable, savedList)
                ? normalizeMechanicsList(savedList)
                : getMechanicsListDefaults(world, variable, state);
            state.lists.set(variable.id, initialList);
        }
        return state;
    };

    const reportMechanicsRuntimeError = (world, event, source, error, origin = null) => {
        const state = getWorldState(world);
        if (!state) return;
        const message = String(error?.message || error || 'Unknown mechanics error').slice(0, 240);
        const sourceBlock = event || origin;
        const eventName = String(sourceBlock?.name || 'Unnamed event').slice(0, 80);
        const sourceName = String(source || 'event').slice(0, 48);
        const errorKey = `${sourceBlock?.id || eventName}:${sourceName}:${message}`;
        const now = Date.now();
        const previousErrorAt = state.runtimeErrorTimes.get(errorKey) || 0;
        if (now - previousErrorAt < 5000) return;
        state.runtimeErrorTimes.set(errorKey, now);
        if (state.runtimeErrorTimes.size > 128) {
            state.runtimeErrorTimes.delete(state.runtimeErrorTimes.keys().next().value);
        }
        const entry = {
            timestamp: now,
            eventId: typeof event?.id === 'string' ? event.id : null,
            sourceBlockId: typeof sourceBlock?.id === 'string' ? sourceBlock.id : null,
            sourceBlockType: event ? 'event' : (origin?.type === 'trigger' ? 'trigger' : origin?.type === 'event' ? 'event' : null),
            eventName,
            source: sourceName,
            message
        };
        state.runtimeErrors.push(entry);
        if (state.runtimeErrors.length > 20) state.runtimeErrors.splice(0, state.runtimeErrors.length - 20);
        globalState.runtimeErrors.push({
            ...entry,
            mapId: typeof world.mechanicsSaveId === 'string' ? world.mechanicsSaveId : '',
            mapName: String(world.mapName || 'Untitled Map').slice(0, 80)
        });
        if (globalState.runtimeErrors.length > 100) {
            globalState.runtimeErrors.splice(0, globalState.runtimeErrors.length - 100);
        }
        console.warn(`[Code Plugin] ${eventName} (${entry.source}):`, error);

        // Keep author diagnostics out of player sessions. Multiple failures in
        // one test are collected, while the visible notice is rate-limited.
        if (window.engine?.state !== 'testing' || now - state.lastErrorToastAt < 3500) return;
        state.lastErrorToastAt = now;
        const escapeHtml = value => value.replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[char]);
        window.ToastManager?.show?.(
            `Mechanics error in “${escapeHtml(eventName)}” (${escapeHtml(entry.source)}): ${escapeHtml(message)}`,
            'error', 6000
        );
    };

    const reportMechanicsPersistenceFailure = (world, context, scope, name) => {
        const diagnostic = context?.mechanicsActionDiagnostic;
        if (!diagnostic) return;
        const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : scope;
        reportMechanicsRuntimeError(world, diagnostic.event || null, diagnostic.source || 'persistent value',
            `The ${scope} “${label}” changed for this session, but its browser-local save could not be written.`);
    };

    const reportTriggerTargetError = (world, trigger, message) => {
        const triggerState = getWorldTriggerState(world, trigger);
        if (triggerState.targetError === message) return;
        triggerState.targetError = message;
        reportMechanicsRuntimeError(world, null, 'trigger target', message, {
            type: 'trigger', id: trigger.id, name: trigger.name
        });
    };

    const clearTriggerTargetError = (world, trigger) => {
        const triggerState = getWorldTriggerState(world, trigger);
        delete triggerState.targetError;
    };

    const isMechanicsTriggerEnabled = (world, trigger) => {
        if (!trigger) return false;
        const overrides = getWorldState(world)?.triggerEnabled;
        if (typeof trigger.id === 'string' && overrides?.has(trigger.id)) return overrides.get(trigger.id) === true;
        return trigger.enabled !== false;
    };

    const writeObjectHealth = (worldState, objectId, current, maximum) => {
        if (!worldState || typeof objectId !== 'string' || !objectId ||
            !Number.isSafeInteger(current) || !Number.isSafeInteger(maximum) ||
            maximum < 1 || maximum > 99999 || current < 0 || current > maximum) return false;
        const health = worldState.objectHealth;
        if (!(health instanceof Map)) return false;
        health.delete(objectId);
        while (health.size >= 512) health.delete(health.keys().next().value);
        health.set(objectId, { current, maximum });
        return true;
    };

    const getMechanicsObjectTarget = (world, action, context, allowDisabled = false) => {
        if (!['fixed', 'touched'].includes(action?.targetMode)) return null;
        const objectId = action?.targetMode === 'touched' ? context?.touchedObjectId : action?.objectId;
        if (typeof objectId !== 'string' || !objectId) return null;
        const object = world?.getObjectById?.(objectId);
        return object && (allowDisabled || object._mechanicsEnabled !== false) && object._collected !== true ? object : null;
    };

    const ensurePersistentMechanicsLoaded = (world, worldState) => {
        const saveStore = window.ParkoreenLocalSave;
        const key = saveStore?.getKey?.(world, 'mechanics') || null;
        if (worldState.persistedMechanicsKey === key) {
            if (!worldState.persistedMechanics || typeof worldState.persistedMechanics !== 'object') {
                worldState.persistedMechanics = { map: Object.create(null), player: Object.create(null), objects: Object.create(null), lists: Object.create(null), playerLists: Object.create(null) };
            }
            if (!worldState.persistedMechanics.objects) worldState.persistedMechanics.objects = Object.create(null);
            if (!worldState.persistedMechanics.lists) worldState.persistedMechanics.lists = Object.create(null);
            if (!worldState.persistedMechanics.playerLists) worldState.persistedMechanics.playerLists = Object.create(null);
            return worldState.persistedMechanics;
        }
        if (worldState.variables instanceof Map) worldState.variables.clear();
        if (worldState.playerVariables instanceof Map) worldState.playerVariables.clear();
        if (worldState.lists instanceof Map) worldState.lists.clear();
        if (worldState.playerLists instanceof Map) worldState.playerLists.clear();
        const saved = key ? saveStore?.read?.(world, 'mechanics') : null;
        const map = saved?.map && typeof saved.map === 'object' && !Array.isArray(saved.map)
            ? saved.map : Object.create(null);
        const player = saved?.player && typeof saved.player === 'object' && !Array.isArray(saved.player)
            ? saved.player : Object.create(null);
        const objects = saved?.objects && typeof saved.objects === 'object' && !Array.isArray(saved.objects)
            ? saved.objects : Object.create(null);
        const lists = saved?.lists && typeof saved.lists === 'object' && !Array.isArray(saved.lists)
            ? saved.lists : Object.create(null);
        const playerLists = saved?.playerLists && typeof saved.playerLists === 'object' && !Array.isArray(saved.playerLists)
            ? saved.playerLists : Object.create(null);
        worldState.persistedMechanicsKey = key;
        worldState.persistedMechanics = { map, player, objects, lists, playerLists };
        return worldState.persistedMechanics;
    };

    const ensurePersistentCampaignLoaded = (worldState) => {
        const saveStore = window.ParkoreenLocalSave;
        const key = saveStore?.getProfileKey?.('campaign') || null;
        if (worldState.persistedCampaignKey === key) {
            if (!worldState.persistedCampaign || typeof worldState.persistedCampaign !== 'object') {
                worldState.persistedCampaign = { values: Object.create(null) };
            }
            if (!worldState.persistedCampaign.values || typeof worldState.persistedCampaign.values !== 'object' ||
                Array.isArray(worldState.persistedCampaign.values)) {
                worldState.persistedCampaign.values = Object.create(null);
            }
            return worldState.persistedCampaign;
        }
        const saved = key ? saveStore?.readProfile?.('campaign') : null;
        const values = saved?.values && typeof saved.values === 'object' && !Array.isArray(saved.values)
            ? saved.values : Object.create(null);
        worldState.persistedCampaignKey = key;
        worldState.persistedCampaign = { values };
        return worldState.persistedCampaign;
    };

    const getMechanicsCampaignKey = variable =>
        typeof variable?.campaignKey === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(variable.campaignKey)
            ? variable.campaignKey : '';

    const persistMechanicsCampaignValue = (world, variable, value, context = {}) => {
        if (variable?.scope !== 'campaign' || window.engine?.state === 'testing' ||
            getMultiplayerManager()?.getRoomCode?.()) return false;
        const campaignKey = getMechanicsCampaignKey(variable);
        if (!campaignKey || !world) return false;
        const worldState = getWorldState(world);
        if (!worldState) return false;
        const record = ensurePersistentCampaignLoaded(worldState);
        const values = Object.assign(Object.create(null), record.values);
        const nextValue = variable.variableType === 'list'
            ? isValidMechanicsList(variable, value) ? { kind: 'list', items: normalizeMechanicsList(value) } : null
            : isValidVariableValue(variable, value)
                ? { kind: 'scalar', valueType: variable.valueType, value: normalizeVariableValue(variable, value) }
                : null;
        if (!nextValue) return false;
        const previous = values[campaignKey];
        if (JSON.stringify(previous) === JSON.stringify(nextValue)) return false;
        values[campaignKey] = nextValue;
        while (Object.keys(values).length > 512) {
            const oldestKey = Object.keys(values).find(key => key !== campaignKey);
            if (!oldestKey) break;
            delete values[oldestKey];
        }
        const nextRecord = { values };
        if (!window.ParkoreenLocalSave?.writeProfile?.('campaign', nextRecord)) {
            reportMechanicsPersistenceFailure(world, context, 'Campaign value', variable.name || campaignKey);
            return false;
        }
        worldState.persistedCampaign = nextRecord;
        worldState.persistedCampaignKey = window.ParkoreenLocalSave?.getProfileKey?.('campaign') || null;
        return true;
    };

    const SHARED_MECHANICS_ACTIONS = new Set([
        'setVariable', 'addVariable', 'calculateVariable', 'toggleVariable', 'appendListItem', 'removeListItem', 'clearList', 'setInventoryItemEquipped', 'branchInventoryItemEquipped', 'consumeInventoryItem', 'branchListContains', 'branchPlayerCount', 'branchObjectHealth',
        'setTriggerEnabled', 'setObjectEnabled', 'setObjectHealth', 'damageObject', 'spawnObject', 'removeSpawnedObjects',
        'setObjectPosition', 'setObjectDrawLayer', 'moveObject', 'setObjectSpriteFrame', 'setObjectOpacity', 'playObjectSpriteAnimation', 'setTilemapCellBehavior', 'setLayerVisibility', 'setGravity', 'setJumpForce', 'setPlayerSpeed', 'setMovementControl', 'startTimer', 'stopTimer'
    ]);

    const getMultiplayerManager = () => typeof window !== 'undefined' ? window.MultiplayerManager || null : null;

    const eventUsesSharedMechanics = (world, eventId, visited = new Set()) => {
        if (!eventId || visited.has(eventId)) return false;
        visited.add(eventId);
        const event = getCodeData(world).events.find(item => item?.id === eventId);
        const actions = Array.isArray(event?.actions) ? event.actions : [];
        for (const action of actions) {
            if (SHARED_MECHANICS_ACTIONS.has(action?.type)) return true;
            const nextEvents = action?.type === 'runEvent'
                ? [action.eventId]
                : action?.type === 'damageObject' ? [action.defeatedEventId]
                : action?.type === 'branchVariable' || action?.type === 'branchListContains' || action?.type === 'branchInventoryItemEquipped' || action?.type === 'consumeInventoryItem' || action?.type === 'branchPlayerCount' || action?.type === 'branchObjectHealth'
                    ? [action.trueEventId, action.falseEventId]
                    : action?.type === 'showChoice' || action?.type === 'showMenu'
                        ? [...(Array.isArray(action.choices) ? action.choices.map(choice => choice?.eventId) : []), ...(action.type === 'showMenu' && action.cancelEventId ? [action.cancelEventId] : [])]
                    : [];
            if (nextEvents.some(nextId => eventUsesSharedMechanics(world, nextId, visited))) return true;
        }
        return false;
    };

    const buildSharedMechanicsState = (world) => {
        const worldState = getWorldState(world);
        const triggers = Object.create(null);
        const triggerIds = new Set((getCodeData(world).triggers || []).map(trigger => trigger?.id).filter(id => typeof id === 'string' && id));
        for (const [triggerId, enabled] of worldState.triggerEnabled) {
            if (triggerIds.has(triggerId) && typeof enabled === 'boolean') triggers[triggerId] = enabled;
        }
        const variables = Object.create(null);
        const lists = Object.create(null);
        for (const variable of getCodeData(world).variables) {
            if (variable.enabled === false || variable.scope === 'player') continue;
            if (variable.variableType === 'list') {
                const value = worldState.lists.get(variable.id);
                if (isValidMechanicsList(variable, value)) lists[variable.id] = normalizeMechanicsList(value);
            } else if (worldState.variables.has(variable.id)) {
                variables[variable.id] = worldState.variables.get(variable.id);
            }
        }
        const playerVariables = Object.create(null);
        for (const [playerId, playerValues] of worldState.playerVariables) {
            if (!playerId || playerId === '__local__') continue;
            const cleanValues = Object.create(null);
            for (const variable of getCodeData(world).variables) {
                if (variable.enabled === false || variable.variableType === 'list' || variable.scope !== 'player' || !playerValues.has(variable.id)) continue;
                cleanValues[variable.id] = playerValues.get(variable.id);
            }
            if (Object.keys(cleanValues).length) playerVariables[playerId] = cleanValues;
        }
        const multiplayer = getMultiplayerManager();
        if (multiplayer?.getRoomCode?.()) {
            const livePlayerIds = new Set();
            if (typeof multiplayer.playerId === 'string' && multiplayer.playerId) livePlayerIds.add(multiplayer.playerId);
            for (const [playerId, livePlayer] of multiplayer.players || []) {
                const id = typeof livePlayer?.id === 'string' && livePlayer.id ? livePlayer.id : playerId;
                if (typeof id === 'string' && id) livePlayerIds.add(id);
            }
            for (const playerId of livePlayerIds) {
                const target = { id: playerId };
                for (const variable of getCodeData(world).variables) {
                    if (variable.enabled !== false && variable.variableType === 'list' && variable.scope === 'player') {
                        getMechanicsPlayerListValue(world, variable, target, { targetPlayerId: playerId });
                    }
                }
            }
        }
        const playerLists = Object.create(null);
        for (const [playerId, playerValues] of worldState.playerLists) {
            if (!playerId || playerId === '__local__') continue;
            const cleanLists = Object.create(null);
            for (const variable of getCodeData(world).variables) {
                if (variable.enabled === false || variable.variableType !== 'list' || variable.scope !== 'player') continue;
                const value = playerValues.get(variable.id);
                if (isValidMechanicsList(variable, value)) cleanLists[variable.id] = normalizeMechanicsList(value);
            }
            if (Object.keys(cleanLists).length) playerLists[playerId] = cleanLists;
        }
        const objects = Object.create(null);
        const objectHealth = Object.create(null);
        const positions = Object.create(null);
        const motions = Object.create(null);
        const spawnedObjects = Object.create(null);
        const objectSpriteFrames = Object.create(null);
        const objectSpriteAnimations = Object.create(null);
        const objectOpacities = Object.create(null);
        const objectDrawLayers = Object.create(null);
        const tilemapCells = Object.create(null);
        const layerVisibility = Object.create(null);
        for (const object of world?.objects || []) {
            if (object._mechanicsSpawned === true) {
                if (object.id && typeof object._mechanicsSpawnTemplateId === 'string' &&
                    typeof object._mechanicsSpawnTag === 'string' && Number.isFinite(object.x) && Number.isFinite(object.y)) {
                    spawnedObjects[object.id] = {
                        templateId: object._mechanicsSpawnTemplateId,
                        x: object.x,
                        y: object.y,
                        tag: object._mechanicsSpawnTag
                    };
                }
                continue;
            }
            if (object.id && object._mechanicsEnabled !== undefined) objects[object.id] = object._mechanicsEnabled !== false;
            if (object.id && Number.isSafeInteger(object._mechanicsSpriteFrame) && object._mechanicsSpriteFrame >= 0) {
                objectSpriteFrames[object.id] = object._mechanicsSpriteFrame;
            }
            const animation = object._mechanicsSpriteAnimation;
            if (object.id && animation && Number.isSafeInteger(animation.startFrame) && Number.isSafeInteger(animation.frameCount) &&
                Number.isFinite(animation.fps) && animation.fps >= 1 && animation.fps <= 30 && typeof animation.loop === 'boolean' &&
                Number.isSafeInteger(animation.startedAtServer) && animation.startFrame >= 0 && animation.frameCount >= 1 &&
                animation.startFrame + animation.frameCount <= (object.spriteSheet?.frameCount || 0)) {
                objectSpriteAnimations[object.id] = {
                    startFrame: animation.startFrame,
                    frameCount: animation.frameCount,
                    fps: animation.fps,
                    loop: animation.loop,
                    startedAtServer: animation.startedAtServer,
                    completionEventId: typeof animation.completionEventId === 'string' ? animation.completionEventId : '',
                    completionEventFired: animation.completionEventFired === true
                };
            }
            if (object.id && Number.isFinite(object._mechanicsOpacity) && object._mechanicsOpacity >= 0 && object._mechanicsOpacity <= 1) {
                objectOpacities[object.id] = object._mechanicsOpacity;
            }
            if (object.id && typeof object._mechanicsDrawLayerId === 'string' &&
                (world?.layerDefinitions || []).some(layer => layer.id === object._mechanicsDrawLayerId)) {
                objectDrawLayers[object.id] = object._mechanicsDrawLayerId;
            }
            if (object.id && object._mechanicsPosition === true && Number.isFinite(object.x) && Number.isFinite(object.y)) {
                positions[object.id] = { x: object.x, y: object.y };
            }
        }
        for (const [objectId, motion] of worldState.objectMotions) {
            if (isValidObjectMotion(motion)) motions[objectId] = { ...motion };
        }
        for (const [objectId, health] of worldState.objectHealth) {
            if (world?.getObjectById?.(objectId) && health && Number.isSafeInteger(health.current) &&
                Number.isSafeInteger(health.maximum) && health.maximum >= 1 && health.maximum <= 99999 &&
                health.current >= 0 && health.current <= health.maximum) {
                objectHealth[objectId] = { current: health.current, maximum: health.maximum };
            }
        }
        for (const [cellId, collisionType] of worldState.tilemapCellOverrides) {
            if (MECHANICS_TILEMAP_CELL_BEHAVIORS.has(collisionType)) tilemapCells[cellId] = collisionType;
        }
        for (const [layerId, visible] of world?._mechanicsLayerVisibility || []) {
            if (visible === false && (world.layerDefinitions || []).some(layer => layer.id === layerId)) layerVisibility[layerId] = false;
        }
        return { variables, lists, objects, positions, motions, objectHealth, objectSpriteFrames, objectSpriteAnimations, objectOpacities, objectDrawLayers, playerVariables, playerLists, spawnedObjects, tilemapCells, layerVisibility, triggers,
            gravity: Number.isFinite(world?._mechanicsGravity) ? world._mechanicsGravity : null,
            jumpForce: Number.isFinite(world?._mechanicsJumpForce) ? world._mechanicsJumpForce : null,
            playerSpeed: Number.isFinite(world?._mechanicsPlayerSpeed) ? world._mechanicsPlayerSpeed : null,
            horizontalAcceleration: Number.isFinite(world?._mechanicsHorizontalAcceleration) ? world._mechanicsHorizontalAcceleration : null,
            airControl: Number.isFinite(world?._mechanicsAirControl) ? world._mechanicsAirControl : null,
            terminalFallSpeed: Number.isFinite(world?._mechanicsTerminalFallSpeed) ? world._mechanicsTerminalFallSpeed : null };
    };

    const publishSharedMechanicsState = (world) => {
        const multiplayer = getMultiplayerManager();
        if (!multiplayer?.getRoomCode?.() || !multiplayer.isHost) return false;
        const worldState = getWorldState(world);
        const roomCode = multiplayer.getRoomCode();
        if (!worldState.sharedMechanicsDirty && worldState.lastSharedMechanicsState !== undefined &&
            worldState.lastSharedMechanicsRoomCode === roomCode) return false;
        const snapshot = buildSharedMechanicsState(world);
        const serialized = JSON.stringify(snapshot);
        if (serialized === worldState.lastSharedMechanicsState) return false;
        if (!multiplayer.sendMechanicsState?.(snapshot)) return false;
        worldState.lastSharedMechanicsState = serialized;
        worldState.lastSharedMechanicsRoomCode = roomCode;
        worldState.sharedMechanicsDirty = false;
        return true;
    };

    const applySharedMechanicsState = (world, snapshot, serverTimestamp = null) => {
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
        const worldState = getWorldState(world);
        const triggerStates = snapshot.triggers && typeof snapshot.triggers === 'object' && !Array.isArray(snapshot.triggers)
            ? snapshot.triggers : {};
        const validTriggerIds = new Set((getCodeData(world).triggers || []).map(trigger => trigger?.id).filter(id => typeof id === 'string' && id));
        if (Number.isFinite(snapshot.gravity) && snapshot.gravity >= 0 && snapshot.gravity <= 5) world._mechanicsGravity = snapshot.gravity;
        else delete world._mechanicsGravity;
        if (Number.isFinite(snapshot.jumpForce) && snapshot.jumpForce >= -100 && snapshot.jumpForce <= -0.1) world._mechanicsJumpForce = snapshot.jumpForce;
        else delete world._mechanicsJumpForce;
        if (Number.isFinite(snapshot.playerSpeed) && snapshot.playerSpeed >= 0.1 && snapshot.playerSpeed <= 100) world._mechanicsPlayerSpeed = snapshot.playerSpeed;
        else delete world._mechanicsPlayerSpeed;
        if (Number.isFinite(snapshot.horizontalAcceleration) && snapshot.horizontalAcceleration >= 0 && snapshot.horizontalAcceleration <= 20) world._mechanicsHorizontalAcceleration = snapshot.horizontalAcceleration;
        else delete world._mechanicsHorizontalAcceleration;
        if (Number.isFinite(snapshot.airControl) && snapshot.airControl >= 0 && snapshot.airControl <= 1) world._mechanicsAirControl = snapshot.airControl;
        else delete world._mechanicsAirControl;
        if (Number.isFinite(snapshot.terminalFallSpeed) && snapshot.terminalFallSpeed >= 1 && snapshot.terminalFallSpeed <= 100) world._mechanicsTerminalFallSpeed = snapshot.terminalFallSpeed;
        else delete world._mechanicsTerminalFallSpeed;
        worldState.triggerEnabled.clear();
        for (const [triggerId, enabled] of Object.entries(triggerStates)) {
            if (validTriggerIds.has(triggerId) && typeof enabled === 'boolean') worldState.triggerEnabled.set(triggerId, enabled);
        }
        if (Number.isSafeInteger(serverTimestamp)) worldState.mechanicsClockOffset = serverTimestamp - Date.now();
        const tilemapCells = snapshot.tilemapCells && typeof snapshot.tilemapCells === 'object' && !Array.isArray(snapshot.tilemapCells)
            ? snapshot.tilemapCells : {};
        for (const cellId of [...worldState.tilemapCellOverrides.keys()]) {
            if (!Object.prototype.hasOwnProperty.call(tilemapCells, cellId)) {
                restoreMechanicsTilemapCell(world, worldState, cellId, true);
            }
        }
        for (const [cellId, collisionType] of Object.entries(tilemapCells)) {
            if (!MECHANICS_TILEMAP_CELL_BEHAVIORS.has(collisionType)) continue;
            const target = getTilemapCellById(world, cellId);
            if (target) setMechanicsTilemapCellBehavior(world, worldState, target, collisionType, true);
        }
        const layerVisibility = snapshot.layerVisibility && typeof snapshot.layerVisibility === 'object' && !Array.isArray(snapshot.layerVisibility)
            ? snapshot.layerVisibility : {};
        const validLayerIds = new Set((world?.layerDefinitions || []).map(layer => layer?.id).filter(id => typeof id === 'string' && id));
        world._mechanicsLayerVisibility = new Map(Object.entries(layerVisibility)
            .filter(([layerId, visible]) => validLayerIds.has(layerId) && typeof visible === 'boolean' && visible === false));
        const objectDrawLayers = snapshot.objectDrawLayers && typeof snapshot.objectDrawLayers === 'object' && !Array.isArray(snapshot.objectDrawLayers)
            ? snapshot.objectDrawLayers : {};
        const desiredDrawLayers = new Map(Object.entries(objectDrawLayers)
            .filter(([objectId, layerId]) => {
                const object = world?.getObjectById?.(objectId);
                return object && object._mechanicsSpawned !== true && typeof layerId === 'string' && validLayerIds.has(layerId);
            }));
        for (const object of world?.objects || []) {
            if (object._mechanicsOriginalLayer !== undefined && desiredDrawLayers.get(object.id) !== object._mechanicsDrawLayerId) {
                world?.resetMechanicsObjectDrawLayer?.(object.id);
            }
        }
        for (const [objectId, layerId] of desiredDrawLayers) {
            const object = world?.getObjectById?.(objectId);
            if (!object || object._mechanicsDrawLayerId === layerId) continue;
            world?.setMechanicsObjectDrawLayer?.(objectId, layerId);
        }
        const variables = snapshot.variables && typeof snapshot.variables === 'object' && !Array.isArray(snapshot.variables)
            ? snapshot.variables : {};
        for (const [variableId, value] of Object.entries(variables)) {
            const variable = getVariable(world, variableId);
            if (!variable || variable.variableType === 'list' || variable.scope === 'player' || !isValidVariableValue(variable, value)) continue;
            const normalized = normalizeVariableValue(variable, value);
            if (!Object.is(worldState.variables.get(variableId), normalized)) {
                worldState.variables.set(variableId, normalized);
                persistMechanicsVariableValue(world, variable, normalized);
            }
        }

        const lists = snapshot.lists && typeof snapshot.lists === 'object' && !Array.isArray(snapshot.lists)
            ? snapshot.lists : {};
        if (snapshot.lists && typeof snapshot.lists === 'object' && !Array.isArray(snapshot.lists)) {
            for (const variable of getCodeData(world).variables) {
                if (variable?.enabled !== false && variable?.variableType === 'list' && variable.scope !== 'player') {
                    worldState.lists.set(variable.id, getMechanicsListDefaults(world, variable, worldState));
                }
            }
        }
        for (const [variableId, value] of Object.entries(lists)) {
            const variable = getVariable(world, variableId);
            if (!variable || variable.variableType !== 'list' || variable.scope === 'player' || !isValidMechanicsList(variable, value)) continue;
            worldState.lists.set(variableId, normalizeMechanicsList(value));
        }

        worldState.playerVariables.clear();
        const playerVariables = snapshot.playerVariables && typeof snapshot.playerVariables === 'object' && !Array.isArray(snapshot.playerVariables)
            ? snapshot.playerVariables : {};
        for (const [playerId, values] of Object.entries(playerVariables)) {
            if (!playerId || playerId.length > 128 || !values || typeof values !== 'object' || Array.isArray(values)) continue;
            const cleanValues = new Map();
            for (const [variableId, value] of Object.entries(values)) {
                const variable = getVariable(world, variableId);
                if (!variable || variable.scope !== 'player' || variable.variableType === 'list' || !isValidVariableValue(variable, value)) continue;
                const normalized = normalizeVariableValue(variable, value);
                cleanValues.set(variableId, normalized);
                persistMechanicsVariableValue(world, variable, normalized, null, { targetPlayerId: playerId });
            }
            if (cleanValues.size) worldState.playerVariables.set(playerId, cleanValues);
        }

        worldState.playerLists.clear();
        const playerLists = snapshot.playerLists && typeof snapshot.playerLists === 'object' && !Array.isArray(snapshot.playerLists)
            ? snapshot.playerLists : {};
        for (const [playerId, values] of Object.entries(playerLists)) {
            if (!playerId || playerId.length > 128 || !values || typeof values !== 'object' || Array.isArray(values)) continue;
            const cleanLists = new Map();
            for (const [variableId, value] of Object.entries(values)) {
                const variable = getVariable(world, variableId);
                if (!variable || variable.variableType !== 'list' || variable.scope !== 'player' || !isValidMechanicsList(variable, value)) continue;
                cleanLists.set(variableId, normalizeMechanicsList(value));
            }
            if (cleanLists.size) worldState.playerLists.set(playerId, cleanLists);
        }

        const spawnedObjects = snapshot.spawnedObjects && typeof snapshot.spawnedObjects === 'object' && !Array.isArray(snapshot.spawnedObjects)
            ? snapshot.spawnedObjects : {};
        const existingSpawned = new Map((world?.objects || [])
            .filter(object => object?._mechanicsSpawned === true)
            .map(object => [object.id, object]));
        const desiredSpawnedIds = new Set();
        let spawnedCount = 0;
        for (const [spawnId, record] of Object.entries(spawnedObjects)) {
            if (spawnedCount >= (window.CODE_MAX_MECHANICS_SPAWNED_OBJECTS || 64) ||
                !/^mspawn_[A-Za-z0-9_-]{1,100}$/.test(spawnId) ||
                !record || typeof record !== 'object' || Array.isArray(record) ||
                Object.keys(record).some(key => !['templateId', 'x', 'y', 'tag'].includes(key)) ||
                typeof record.templateId !== 'string' || !Number.isFinite(record.x) || !Number.isFinite(record.y) ||
                Math.abs(record.x) > 10000000 || Math.abs(record.y) > 10000000 ||
                typeof record.tag !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(record.tag)) continue;
            const template = world?.getObjectById?.(record.templateId);
            if (!template || template._mechanicsSpawned || template.type === 'teleportal' || template.appearanceType === 'teleportal' ||
                ['zone', 'button', 'checkpoint', 'spawnpoint', 'endpoint'].includes(template.appearanceType) ||
                ['checkpoint', 'spawnpoint', 'endpoint'].includes(template.actingType)) continue;
            const current = existingSpawned.get(spawnId);
            if (!current && world?.getObjectById?.(spawnId)) continue;
            let spawned = current;
            if (current && current._mechanicsSpawnTemplateId !== record.templateId) {
                world.removeObject?.(spawnId);
                existingSpawned.delete(spawnId);
                spawned = null;
            }
            if (!spawned) {
                const config = template.toJSON?.() || { ...template };
                spawned = new window.WorldObject({ ...config, id: spawnId, x: record.x, y: record.y });
                spawned._mechanicsSpawned = true;
                spawned._mechanicsSpawnTemplateId = record.templateId;
                spawned._mechanicsSpawnTag = record.tag;
                world?.addObject?.(spawned);
            } else {
                spawned._mechanicsSpawnTag = record.tag;
                world?.setMechanicsObjectPosition?.(spawnId, record.x, record.y);
            }
            desiredSpawnedIds.add(spawnId);
            spawnedCount++;
        }
        for (const [spawnId] of existingSpawned) {
            if (desiredSpawnedIds.has(spawnId)) continue;
            world?.removeObject?.(spawnId);
            worldState.objectMotions.delete(spawnId);
        }

        const objects = snapshot.objects && typeof snapshot.objects === 'object' && !Array.isArray(snapshot.objects)
            ? snapshot.objects : {};
        for (const [objectId, enabled] of Object.entries(objects)) {
            if (typeof enabled !== 'boolean') continue;
            const object = world?.getObjectById?.(objectId);
            if (!object || (object._mechanicsEnabled !== false) === enabled) continue;
            executeAction({ type: 'setObjectEnabled', objectId, enabled }, world, null, { authoritativeStateApplication: true });
        }

        const objectSpriteFrames = snapshot.objectSpriteFrames && typeof snapshot.objectSpriteFrames === 'object' && !Array.isArray(snapshot.objectSpriteFrames)
            ? snapshot.objectSpriteFrames : {};
        for (const object of world?.objects || []) {
            if (!Object.prototype.hasOwnProperty.call(objectSpriteFrames, object.id)) delete object._mechanicsSpriteFrame;
        }
        for (const [objectId, frame] of Object.entries(objectSpriteFrames)) {
            const object = world?.getObjectById?.(objectId);
            if (!object?.spriteSheet || !Number.isSafeInteger(frame) || frame < 0 || frame >= object.spriteSheet.frameCount) continue;
            object._mechanicsSpriteFrame = frame;
        }

        const objectSpriteAnimations = snapshot.objectSpriteAnimations && typeof snapshot.objectSpriteAnimations === 'object' && !Array.isArray(snapshot.objectSpriteAnimations)
            ? snapshot.objectSpriteAnimations : {};
        for (const object of world?.objects || []) {
            if (!Object.prototype.hasOwnProperty.call(objectSpriteAnimations, object.id)) delete object._mechanicsSpriteAnimation;
        }
        for (const [objectId, animation] of Object.entries(objectSpriteAnimations)) {
            const object = world?.getObjectById?.(objectId);
            const frameCount = object?.spriteSheet?.frameCount;
            if (!object?.spriteSheet || !animation || typeof animation !== 'object' || Array.isArray(animation) ||
                !Number.isSafeInteger(animation.startFrame) || !Number.isSafeInteger(animation.frameCount) ||
                !Number.isFinite(animation.fps) || animation.fps < 1 || animation.fps > 30 || typeof animation.loop !== 'boolean' ||
                !Number.isSafeInteger(animation.startedAtServer) || animation.startFrame < 0 || animation.frameCount < 1 ||
                animation.startFrame + animation.frameCount > frameCount) continue;
            const completionEventId = typeof animation.completionEventId === 'string' && animation.completionEventId.length <= 128
                ? animation.completionEventId : '';
            const completionEvent = completionEventId
                ? getCodeData(world).events.find(candidate => candidate?.id === completionEventId && candidate.enabled !== false)
                : null;
            if ((completionEventId && (!completionEvent || animation.loop || typeof animation.completionEventFired !== 'boolean')) ||
                (!completionEventId && animation.completionEventFired === true)) continue;
            object._mechanicsSpriteFrame = undefined;
            object._mechanicsSpriteAnimation = {
                startFrame: animation.startFrame,
                frameCount: animation.frameCount,
                fps: animation.fps,
                loop: animation.loop,
                startedAtServer: animation.startedAtServer,
                startedAt: animation.startedAtServer - worldState.mechanicsClockOffset,
                completionEventId,
                completionEventFired: animation.completionEventFired === true
            };
        }

        const objectOpacities = snapshot.objectOpacities && typeof snapshot.objectOpacities === 'object' && !Array.isArray(snapshot.objectOpacities)
            ? snapshot.objectOpacities : {};
        let objectOpacityChanged = false;
        for (const object of world?.objects || []) {
            if (!Object.prototype.hasOwnProperty.call(objectOpacities, object.id) && object._mechanicsOpacity !== undefined) {
                delete object._mechanicsOpacity;
                objectOpacityChanged = true;
            }
        }
        for (const [objectId, opacity] of Object.entries(objectOpacities)) {
            const object = world?.getObjectById?.(objectId);
            if (!object || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) continue;
            if (object._mechanicsOpacity !== opacity) {
                object._mechanicsOpacity = opacity;
                objectOpacityChanged = true;
            }
        }
        if (objectOpacityChanged) world?.invalidateTileCache?.();

        if (snapshot.objectHealth && typeof snapshot.objectHealth === 'object' && !Array.isArray(snapshot.objectHealth)) {
            worldState.objectHealth.clear();
            for (const [objectId, health] of Object.entries(snapshot.objectHealth)) {
                const object = world?.getObjectById?.(objectId);
                if (!object || !health || typeof health !== 'object' || Array.isArray(health) ||
                    !Number.isSafeInteger(health.current) || !Number.isSafeInteger(health.maximum) ||
                    health.maximum < 1 || health.maximum > 99999 || health.current < 0 || health.current > health.maximum) continue;
                writeObjectHealth(worldState, objectId, health.current, health.maximum);
            }
        }

        const positions = snapshot.positions && typeof snapshot.positions === 'object' && !Array.isArray(snapshot.positions)
            ? snapshot.positions : {};
        const motions = snapshot.motions && typeof snapshot.motions === 'object' && !Array.isArray(snapshot.motions)
            ? snapshot.motions : {};
        for (const object of world?.objects || []) {
            if (object._mechanicsPosition !== true || Object.prototype.hasOwnProperty.call(positions, object.id)) continue;
            const original = object._mechanicsOriginalPosition;
            if (original && Number.isFinite(original.x) && Number.isFinite(original.y)) {
                world.setMechanicsObjectPosition?.(object.id, original.x, original.y);
                delete object._mechanicsPosition;
            }
        }
        for (const [objectId, position] of Object.entries(positions)) {
            if (!position || typeof position !== 'object' || Array.isArray(position) ||
                !isFiniteMechanicsNumber(position.x) || !isFiniteMechanicsNumber(position.y)) continue;
            const moving = Object.prototype.hasOwnProperty.call(motions, objectId) && isValidObjectMotion(motions[objectId]);
            world?.setMechanicsObjectPosition?.(objectId, Number(position.x), Number(position.y), {
                moving,
                preserveInside: moving
            });
        }

        for (const objectId of worldState.objectMotions.keys()) {
            if (!Object.prototype.hasOwnProperty.call(motions, objectId)) worldState.objectMotions.delete(objectId);
        }
        for (const [objectId, motion] of Object.entries(motions)) {
            if (!world?.getObjectById?.(objectId) || !isValidObjectMotion(motion)) continue;
            worldState.objectMotions.set(objectId, { ...motion });
        }

        worldState.lastSharedMechanicsState = JSON.stringify(buildSharedMechanicsState(world));
        worldState.lastSharedMechanicsRoomCode = getMultiplayerManager()?.getRoomCode?.() || null;
        worldState.sharedMechanicsDirty = false;
    };

    const getVariable = (world, variableId) =>
        getCodeData(world).variables.find(variable => variable.id === variableId && variable.enabled !== false);

    const isFiniteMechanicsNumber = (value) => {
        if (value === null || value === undefined) return false;
        if (typeof value === 'string' && value.trim() === '') return false;
        if (typeof value !== 'number' && typeof value !== 'string') return false;
        return Number.isFinite(Number(value));
    };

    const isValidObjectMotion = (motion) => {
        const easings = Array.isArray(window.CODE_OBJECT_MOTION_EASINGS)
            ? window.CODE_OBJECT_MOTION_EASINGS.map(item => item.id) : ['linear'];
        return motion && typeof motion === 'object' && !Array.isArray(motion) &&
            typeof motion.motionId === 'string' && motion.motionId.length >= 1 && motion.motionId.length <= 128 &&
            ['fromX', 'fromY', 'toX', 'toY'].every(key => isFiniteMechanicsNumber(motion[key]) && Math.abs(Number(motion[key])) <= 10000000) &&
            Number.isSafeInteger(motion.startedAt) && motion.startedAt > 0 &&
            isFiniteMechanicsNumber(motion.durationMs) && Number(motion.durationMs) >= 10 && Number(motion.durationMs) <= 60000 &&
            easings.includes(motion.easing);
    };

    const updateObjectMotions = (world) => {
        const worldState = getWorldState(world);
        if (!worldState?.objectMotions?.size) return;
        const now = Date.now() + (Number.isFinite(worldState.mechanicsClockOffset) ? worldState.mechanicsClockOffset : 0);
        for (const [objectId, motion] of worldState.objectMotions) {
            const object = world?.getObjectById?.(objectId);
            if (!object || !isValidObjectMotion(motion)) {
                worldState.objectMotions.delete(objectId);
                continue;
            }
            const rawProgress = Math.max(0, Math.min(1, (now - motion.startedAt) / motion.durationMs));
            let progress = rawProgress;
            if (motion.easing === 'easeIn') progress = rawProgress * rawProgress;
            else if (motion.easing === 'easeOut') progress = 1 - ((1 - rawProgress) * (1 - rawProgress));
            else if (motion.easing === 'easeInOut') progress = rawProgress < 0.5
                ? 2 * rawProgress * rawProgress
                : 1 - Math.pow(-2 * rawProgress + 2, 2) / 2;
            const finished = rawProgress >= 1;
            const x = finished ? Number(motion.toX) : Number(motion.fromX) + (Number(motion.toX) - Number(motion.fromX)) * progress;
            const y = finished ? Number(motion.toY) : Number(motion.fromY) + (Number(motion.toY) - Number(motion.fromY)) * progress;
            const horizontalDirection = Math.sign(Number(motion.toX) - Number(motion.fromX));
            if (horizontalDirection) object._mechanicsMotionDirection = horizontalDirection;
            world.setMechanicsObjectPosition?.(objectId, x, y, { moving: !finished, carryPlayer: true });
            if (finished) {
                worldState.objectMotions.delete(objectId);
                worldState.sharedMechanicsDirty = true;
            }
        }
    };

    const cleanupExpiredSpawnedObjects = (world) => {
        const worldState = getWorldState(world);
        if (!worldState) return false;
        const now = Date.now();
        let removed = false;
        for (const object of [...(world?.objects || [])]) {
            if (object?._mechanicsSpawned !== true || !Number.isFinite(object._mechanicsSpawnExpiresAt) ||
                object._mechanicsSpawnExpiresAt > now) continue;
            world.removeObject?.(object.id);
            worldState.objectMotions.delete(object.id);
            removed = true;
        }
        if (removed) worldState.sharedMechanicsDirty = true;
        return removed;
    };

    const isValidVariableValue = (variable, value) => {
        switch (variable?.valueType) {
            case 'integer':
                return isFiniteMechanicsNumber(value) && Number.isSafeInteger(Number(value));
            case 'float':
                return isFiniteMechanicsNumber(value);
            case 'boolean':
                return typeof value === 'boolean' || value === 'true' || value === 'false';
            case 'string':
                return typeof value === 'string' && value.length <= (window.CODE_MAX_VARIABLE_STRING_LENGTH || 512);
            default:
                return false;
        }
    };

    const evaluateVariableCondition = (world, variableId, operator, value, player = null, context = {}) => {
        const variable = getVariable(world, variableId);
        const worldState = getWorldState(world);
        if (!variable || variable.variableType === 'list' || !worldState) return false;
        const actual = getVariableValue(world, variable, player, context);
        const supportedOperators = ['equals', 'notEquals', 'truthy', 'falsy'];
        if (['integer', 'float'].includes(variable.valueType)) supportedOperators.push('greaterThan', 'lessThan');
        if (!supportedOperators.includes(operator || 'equals')) return false;
        if (!['truthy', 'falsy'].includes(operator || 'equals') && !isValidVariableValue(variable, value)) return false;
        const expected = normalizeVariableValue(variable, value);
        switch (operator || 'equals') {
            case 'notEquals': return actual !== expected;
            case 'greaterThan': return Number.isFinite(Number(actual)) && Number(actual) > Number(expected);
            case 'lessThan': return Number.isFinite(Number(actual)) && Number(actual) < Number(expected);
            case 'truthy': return Boolean(actual);
            case 'falsy': return !actual;
            case 'equals':
            default: return actual === expected;
        }
    };

    const normalizeVariableValue = (variable, value) => {
        switch (variable.valueType) {
            case 'integer': {
                const parsed = Number(value);
                return Number.isSafeInteger(parsed) ? parsed : 0;
            }
            case 'float': {
                const parsed = Number(value);
                return Number.isFinite(parsed) ? parsed : 0;
            }
            case 'boolean':
                return value === true || value === 'true';
            case 'string':
            default:
                return String(value ?? '').slice(0, window.CODE_MAX_VARIABLE_STRING_LENGTH || 512);
        }
    };

    const getMechanicsListLimit = () => window.CODE_MAX_LIST_ITEMS || 100;

    const isValidMechanicsList = (variable, value) =>
        variable?.variableType === 'list' && Array.isArray(value) && value.length <= getMechanicsListLimit() &&
        value.every(item => item && typeof item === 'object' && !Array.isArray(item) &&
            ['string', 'integer', 'float', 'boolean'].includes(item.valueType) &&
            isValidVariableValue({ valueType: item.valueType }, item.value));

    const normalizeMechanicsList = (items) => items.slice(0, getMechanicsListLimit()).map(item => ({
        valueType: item.valueType,
        value: normalizeVariableValue({ valueType: item.valueType }, item.value)
    }));

    const getMechanicsListDefaults = (world, variable, worldState) => {
        const sourceItems = Array.isArray(variable.listItems) ? variable.listItems : [];
        const configuredLength = Number.isInteger(variable.listLength) ? variable.listLength : sourceItems.length;
        const count = Math.max(0, Math.min(getMechanicsListLimit(), configuredLength, sourceItems.length));
        const defaults = [];
        for (const item of sourceItems.slice(0, count)) {
            if (!item || typeof item !== 'object') continue;
            let valueType = item.valueType;
            let value = item.value;
            if (valueType === 'variable') {
                const source = getCodeData(world).variables.find(candidate => candidate?.id === item.value && candidate.enabled !== false);
                if (!source || source.scope === 'player' || source.variableType === 'list' ||
                    !['string', 'integer', 'float', 'boolean'].includes(source.valueType)) continue;
                valueType = source.valueType;
                value = worldState.variables.get(source.id);
            }
            if (!['string', 'integer', 'float', 'boolean'].includes(valueType) ||
                !isValidVariableValue({ valueType }, value)) continue;
            defaults.push({ valueType, value: normalizeVariableValue({ valueType }, value) });
        }
        return defaults;
    };

    const getVariablePlayerId = (player, context = {}) => {
        const playerId = player?.id || context.targetPlayerId || context.sourcePlayerId;
        return typeof playerId === 'string' && playerId ? playerId : '__local__';
    };

    const isLocalPlayerTarget = (player, context = {}) => {
        const localPlayer = window.engine?.localPlayer || null;
        if (player && localPlayer === player) return true;
        const multiplayer = getMultiplayerManager();
        const localPlayerId = multiplayer?.playerId || localPlayer?.id;
        const targetPlayerId = getVariablePlayerId(player, context);
        if (localPlayerId) return targetPlayerId === localPlayerId;
        return !multiplayer?.getRoomCode?.() && targetPlayerId === '__local__';
    };

    const getMechanicsPlayerListValue = (world, variable, player = null, context = {}) => {
        if (!variable || variable.variableType !== 'list' || variable.scope !== 'player') return undefined;
        const worldState = getWorldState(world);
        if (!worldState) return undefined;
        const playerId = getVariablePlayerId(player, context);
        let playerValues = worldState.playerLists.get(playerId);
        if (!playerValues) {
            playerValues = new Map();
            worldState.playerLists.set(playerId, playerValues);
        }
        if (!playerValues.has(variable.id)) {
            const isHostedRoom = Boolean(getMultiplayerManager()?.getRoomCode?.());
            const isTestRun = window.engine?.state === 'testing';
            const savedList = variable.persist === true && !isHostedRoom && !isTestRun && isLocalPlayerTarget(player, context)
                ? ensurePersistentMechanicsLoaded(world, worldState).playerLists[variable.id]
                : undefined;
            const initialList = isValidMechanicsList(variable, savedList)
                ? normalizeMechanicsList(savedList)
                : getMechanicsListDefaults(world, variable, worldState);
            playerValues.set(variable.id, initialList);
        }
        return playerValues.get(variable.id);
    };

    const persistMechanicsPlayerListValue = (world, variable, value, player = null, context = {}) => {
        if (variable?.variableType !== 'list' || variable.scope !== 'player' || variable.persist !== true ||
            !isValidMechanicsList(variable, value) || window.engine?.state === 'testing' ||
            getMultiplayerManager()?.getRoomCode?.() || !isLocalPlayerTarget(player, context)) return false;
        const worldState = getWorldState(world);
        if (!worldState) return false;
        const record = ensurePersistentMechanicsLoaded(world, worldState);
        const playerLists = Object.assign(Object.create(null), record.playerLists);
        playerLists[variable.id] = normalizeMechanicsList(value);
        const cleanPlayerLists = Object.create(null);
        for (const definition of getCodeData(world).variables) {
            if (definition?.enabled === false || definition?.variableType !== 'list' || definition?.scope !== 'player' || definition?.persist !== true) continue;
            const savedList = playerLists[definition.id];
            if (isValidMechanicsList(definition, savedList)) cleanPlayerLists[definition.id] = normalizeMechanicsList(savedList);
        }
        const nextRecord = { map: record.map, player: record.player, objects: record.objects, lists: record.lists, playerLists: cleanPlayerLists };
        if (!window.ParkoreenLocalSave?.write?.(world, 'mechanics', nextRecord)) {
            reportMechanicsPersistenceFailure(world, context, 'Player List', variable.name || variable.id);
            return false;
        }
        worldState.persistedMechanics = nextRecord;
        worldState.persistedMechanicsKey = window.ParkoreenLocalSave?.getKey?.(world, 'mechanics') || null;
        return true;
    };

    const persistMechanicsVariableValue = (world, variable, value, player = null, context = {}) => {
        if (variable?.scope === 'campaign') return persistMechanicsCampaignValue(world, variable, value, context);
        if (variable?.persist !== true || variable.variableType === 'list' || !isValidVariableValue(variable, value)) return false;
        if (window.engine?.state === 'testing') return false;
        if (variable.scope === 'player' && !isLocalPlayerTarget(player, context)) return false;
        const worldState = getWorldState(world);
        if (!worldState) return false;
        const record = ensurePersistentMechanicsLoaded(world, worldState);
        const bucketName = variable.scope === 'player' ? 'player' : 'map';
        const bucket = Object.assign(Object.create(null), record[bucketName]);
        const normalizedValue = normalizeVariableValue(variable, value);
        const oldValue = bucket[variable.id];
        if (isValidVariableValue(variable, oldValue) && Object.is(normalizeVariableValue(variable, oldValue), normalizedValue)) return false;
        bucket[variable.id] = normalizedValue;

        const cleanBucket = Object.create(null);
        for (const definition of getCodeData(world).variables) {
            if (definition?.enabled === false || definition?.persist !== true || definition?.variableType === 'list' ||
                (bucketName === 'player') !== (definition?.scope === 'player')) continue;
            const storedValue = bucket[definition.id];
            if (isValidVariableValue(definition, storedValue)) {
                cleanBucket[definition.id] = normalizeVariableValue(definition, storedValue);
            }
        }
        const nextRecord = {
            map: bucketName === 'map' ? cleanBucket : record.map,
            player: bucketName === 'player' ? cleanBucket : record.player,
            objects: record.objects,
            lists: record.lists,
            playerLists: record.playerLists
        };
        if (!window.ParkoreenLocalSave?.write?.(world, 'mechanics', nextRecord)) {
            reportMechanicsPersistenceFailure(world, context,
                bucketName === 'player' ? 'Player variable' : 'Map variable', variable.name || variable.id);
            return false;
        }
        worldState.persistedMechanics = nextRecord;
        worldState.persistedMechanicsKey = window.ParkoreenLocalSave?.getKey?.(world, 'mechanics') || null;
        return true;
    };

    const persistMechanicsListValue = (world, variable, value, context = {}) => {
        if (variable?.scope === 'campaign') return persistMechanicsCampaignValue(world, variable, value, context);
        if (variable?.variableType !== 'list' || variable.persist !== true || !isValidMechanicsList(variable, value) ||
            window.engine?.state === 'testing' || getMultiplayerManager()?.getRoomCode?.()) return false;
        const worldState = getWorldState(world);
        if (!worldState) return false;
        const record = ensurePersistentMechanicsLoaded(world, worldState);
        const normalized = normalizeMechanicsList(value);
        const bucket = Object.assign(Object.create(null), record.lists);
        bucket[variable.id] = normalized;
        const cleanLists = Object.create(null);
        for (const definition of getCodeData(world).variables) {
            if (definition?.enabled === false || definition?.variableType !== 'list' || definition?.scope === 'player' || definition?.persist !== true) continue;
            const savedList = bucket[definition.id];
            if (isValidMechanicsList(definition, savedList)) cleanLists[definition.id] = normalizeMechanicsList(savedList);
        }
        const nextRecord = { map: record.map, player: record.player, objects: record.objects, lists: cleanLists, playerLists: record.playerLists };
        if (!window.ParkoreenLocalSave?.write?.(world, 'mechanics', nextRecord)) {
            reportMechanicsPersistenceFailure(world, context, 'Map List', variable.name || variable.id);
            return false;
        }
        worldState.persistedMechanics = nextRecord;
        worldState.persistedMechanicsKey = window.ParkoreenLocalSave?.getKey?.(world, 'mechanics') || null;
        return true;
    };

    const getMechanicsListActionItem = (action) => {
        const valueType = action?.valueType;
        if (!['string', 'integer', 'float', 'boolean'].includes(valueType) ||
            !isValidVariableValue({ valueType }, action.value)) return null;
        return { valueType, value: normalizeVariableValue({ valueType }, action.value) };
    };

    const setMechanicsListValue = (world, variable, value, context = {}) => {
        if (!variable || variable.variableType !== 'list' || !isValidMechanicsList(variable, value)) return false;
        const worldState = getWorldState(world);
        if (!worldState) return false;
        const normalized = normalizeMechanicsList(value);
        let listValues = worldState.lists;
        if (variable.scope === 'player') {
            const playerId = getVariablePlayerId(context.player || null, context);
            listValues = worldState.playerLists.get(playerId);
            if (!listValues) {
                listValues = new Map();
                worldState.playerLists.set(playerId, listValues);
            }
        }
        const previous = listValues.get(variable.id);
        if (JSON.stringify(previous || []) === JSON.stringify(normalized)) return false;
        listValues.set(variable.id, normalized);
        if (variable.scope === 'player') {
            persistMechanicsPlayerListValue(world, variable, normalized, context.player || null, context);
        } else {
            persistMechanicsListValue(world, variable, normalized, context);
        }
        if (!context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
        return true;
    };

    const getPersistentMechanicsObjectIds = (world) => {
        const ids = new Set();
        for (const event of getCodeData(world).events) {
            for (const action of Array.isArray(event?.actions) ? event.actions : []) {
                if (action?.type === 'setObjectEnabled' && action.persist === true &&
                    typeof action.objectId === 'string' && action.objectId.length <= 128) {
                    ids.add(action.objectId);
                }
            }
        }
        return ids;
    };

    const isMechanicsObjectPersistenceAvailable = (world) =>
        window.engine?.state !== 'testing' && !getMultiplayerManager()?.getRoomCode?.() && !!world;

    const persistMechanicsObjectState = (world, objectId, enabled) => {
        if (typeof objectId !== 'string' || typeof enabled !== 'boolean' ||
            !isMechanicsObjectPersistenceAvailable(world) ||
            !getPersistentMechanicsObjectIds(world).has(objectId)) return false;
        const worldState = getWorldState(world);
        if (!worldState) return false;
        const record = ensurePersistentMechanicsLoaded(world, worldState);
        const bucket = Object.assign(Object.create(null), record.objects);
        if (bucket[objectId] === enabled) return false;
        bucket[objectId] = enabled;
        const validIds = getPersistentMechanicsObjectIds(world);
        const cleanObjects = Object.create(null);
        for (const id of validIds) {
            if (typeof bucket[id] === 'boolean') cleanObjects[id] = bucket[id];
        }
        const nextRecord = { map: record.map, player: record.player, objects: cleanObjects, lists: record.lists, playerLists: record.playerLists };
        if (!window.ParkoreenLocalSave?.write?.(world, 'mechanics', nextRecord)) return false;
        worldState.persistedMechanics = nextRecord;
        worldState.persistedMechanicsKey = window.ParkoreenLocalSave?.getKey?.(world, 'mechanics') || null;
        return true;
    };

    const restorePersistentMechanicsObjectStates = (world) => {
        if (!isMechanicsObjectPersistenceAvailable(world)) return false;
        const worldState = getWorldState(world);
        if (!worldState) return false;
        const record = ensurePersistentMechanicsLoaded(world, worldState);
        const validIds = getPersistentMechanicsObjectIds(world);
        let restored = false;
        for (const objectId of validIds) {
            const enabled = record.objects[objectId];
            const object = world.getObjectById?.(objectId);
            if (typeof enabled !== 'boolean' || !object) continue;
            if (world.setMechanicsObjectEnabled?.(objectId, enabled)) restored = true;
        }
        if (restored && window.engine?.world === world) window.engine.updateCoinCounterUI?.();
        return restored;
    };

    const getVariableValue = (world, variable, player, context = {}) => {
        const worldState = getWorldState(world);
        if (!worldState || !variable) return undefined;
        if (variable.scope !== 'player') return worldState.variables.get(variable.id);
        const playerId = getVariablePlayerId(player, context);
        let values = worldState.playerVariables.get(playerId);
        if (!values) {
            values = new Map();
            worldState.playerVariables.set(playerId, values);
        }
        if (!values.has(variable.id)) {
            const savedValue = variable.persist === true && variable.variableType !== 'list' &&
                isLocalPlayerTarget(player, context)
                ? ensurePersistentMechanicsLoaded(world, worldState).player[variable.id]
                : undefined;
            const initialValue = isValidVariableValue(variable, savedValue)
                ? normalizeVariableValue(variable, savedValue)
                : normalizeVariableValue(variable, variable.defaultValue);
            values.set(variable.id, initialValue);
        }
        return values.get(variable.id);
    };

    const setVariableValue = (world, variable, value, player, context = {}) => {
        const worldState = getWorldState(world);
        if (!worldState || !variable) return false;
        const nextValue = normalizeVariableValue(variable, value);
        let values = worldState.variables;
        if (variable.scope === 'player') {
            const playerId = getVariablePlayerId(player, context);
            values = worldState.playerVariables.get(playerId);
            if (!values) {
                values = new Map();
                worldState.playerVariables.set(playerId, values);
            }
        }
        if (Object.is(values.get(variable.id), nextValue)) return false;
        values.set(variable.id, nextValue);
        persistMechanicsVariableValue(world, variable, nextValue, player, context);
        if (!context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
        return true;
    };

    const getVariableTargetIds = (variable, action, player, context = {}) => {
        if (variable.scope !== 'player') return [null];
        const target = action.playerTarget || 'triggering';
        if (target === 'touched') return context.touchedPlayerId ? [context.touchedPlayerId] : [];
        if (target === 'all') {
            const ids = new Set();
            const multiplayer = getMultiplayerManager();
            if (!multiplayer?.getRoomCode?.()) return [getVariablePlayerId(player, context)];
            if (typeof multiplayer?.playerId === 'string') ids.add(multiplayer.playerId);
            for (const playerId of multiplayer?.players?.keys?.() || []) ids.add(playerId);
            if (player?.id) ids.add(player.id);
            return Array.from(ids);
        }
        return [getVariablePlayerId(player, context)];
    };

    const showMechanicsMessage = (message, durationSeconds = 3) => {
        if (typeof document === 'undefined') return;
        let node = document.getElementById('parkoreen-mechanics-message');
        if (!node) {
            node = document.createElement('div');
            node.id = 'parkoreen-mechanics-message';
            node.setAttribute('role', 'status');
            node.setAttribute('aria-live', 'polite');
            node.style.cssText = 'position:fixed;z-index:100000;top:18px;left:50%;transform:translateX(-50%);max-width:min(90vw,640px);padding:12px 20px;border:1px solid rgba(255,255,255,.22);border-radius:12px;background:rgba(15,18,30,.94);color:#fff;font:600 15px/1.4 system-ui,sans-serif;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.35);opacity:0;transition:opacity .15s ease;pointer-events:none;';
            document.body.appendChild(node);
        }
        clearTimeout(node._hideTimer);
        node.textContent = String(message ?? '');
        node.style.opacity = '1';
        node._hideTimer = setTimeout(() => {
            node.style.opacity = '0';
        }, Math.max(0.5, Number(durationSeconds) || 3) * 1000);
    };

    const closeMechanicsListPanel = (record) => {
        if (!record) return false;
        if (record.keyHandler && typeof document !== 'undefined') document.removeEventListener('keydown', record.keyHandler, true);
        record.element?.remove();
        globalState.listPanels.delete(record);
        if (record.player?._mechanicsListPanel === record) record.player._mechanicsListPanel = null;
        return true;
    };

    const clearMechanicsListPanels = () => {
        for (const record of [...globalState.listPanels]) closeMechanicsListPanel(record);
    };

    const parseMechanicsInventoryItem = (item) => {
        if (item?.valueType !== 'string' || typeof item.value !== 'string' || item.value.length > 512) return null;
        let data;
        try { data = JSON.parse(item.value); } catch { return null; }
        if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.name !== 'string') return null;
        const name = data.name.trim();
        if (!name || name.length > 80) return null;
        if (data.description !== undefined && (typeof data.description !== 'string' || data.description.length > 180)) return null;
        if (data.icon !== undefined && (typeof data.icon !== 'string' || data.icon.length > 8)) return null;
        if (data.equipped !== undefined && typeof data.equipped !== 'boolean') return null;
        const description = typeof data.description === 'string' ? data.description.trim().slice(0, 180) : '';
        const icon = typeof data.icon === 'string' ? data.icon.trim().slice(0, 8) : '';
        if (data.count !== undefined &&
            (!Number.isInteger(data.count) || data.count < 1 || data.count > 9999)) return null;
        const count = data.count === undefined ? null : data.count;
        if (data.slot !== undefined && (typeof data.slot !== 'string' || data.slot.trim().length > 32)) return null;
        const slot = typeof data.slot === 'string' ? data.slot.trim() : 'default';
        return { name, description, icon, count, slot: slot || 'default', equipped: data.equipped === true };
    };

    const renderMechanicsListItem = (item) => {
        const row = document.createElement('li');
        row.style.cssText = 'display:flex;align-items:flex-start;gap:12px;padding:9px 10px;border-radius:8px;background:rgba(255,255,255,.07);';
        const inventoryItem = parseMechanicsInventoryItem(item);
        if (!inventoryItem) {
            const value = document.createElement('span');
            value.style.cssText = 'flex:1;min-width:0;overflow-wrap:anywhere;';
            value.textContent = String(item.value);
            const type = document.createElement('small');
            type.style.cssText = 'flex:none;color:#aebdd2;font-size:11px;text-transform:uppercase;';
            type.textContent = item.valueType;
            row.append(value, type);
            return row;
        }

        if (inventoryItem.icon) {
            const icon = document.createElement('span');
            icon.setAttribute('aria-hidden', 'true');
            icon.style.cssText = 'flex:none;width:28px;text-align:center;font-size:22px;line-height:1.2;';
            icon.textContent = inventoryItem.icon;
            row.appendChild(icon);
        }
        const body = document.createElement('span');
        body.style.cssText = 'flex:1;min-width:0;overflow-wrap:anywhere;';
        const name = document.createElement('strong');
        name.textContent = inventoryItem.name;
        body.appendChild(name);
        if (inventoryItem.description) {
            const description = document.createElement('span');
            description.style.cssText = 'display:block;margin-top:2px;color:#c5cede;font-size:12px;';
            description.textContent = inventoryItem.description;
            body.appendChild(description);
        }
        row.appendChild(body);
        if (inventoryItem.count !== null || inventoryItem.slot !== 'default' || inventoryItem.equipped) {
            const metadata = document.createElement('small');
            metadata.style.cssText = 'flex:none;color:#aebdd2;font-size:11px;text-align:right;';
            metadata.textContent = [inventoryItem.count !== null ? `×${inventoryItem.count}` : '', inventoryItem.slot !== 'default' ? inventoryItem.slot : '', inventoryItem.equipped ? 'Equipped' : ''].filter(Boolean).join(' · ');
            row.appendChild(metadata);
        }
        return row;
    };

    const renderMechanicsListPanel = (record) => {
        if (!record?.element?.isConnected) {
            closeMechanicsListPanel(record);
            return;
        }
        const variable = getVariable(record.world, record.variableId);
        const worldState = record.worldState;
        const isList = variable?.variableType === 'list';
        const items = isList
            ? (variable.scope === 'player'
                ? worldState?.playerLists.get(getVariablePlayerId(record.player))?.get(variable.id)
                : worldState?.lists.get(variable.id))
            : null;
        const scalarValue = variable && !isList ? getVariableValue(record.world, variable, record.player) : undefined;
        record.heading.textContent = record.title || variable?.name || 'List';
        if (!variable || (isList && (!Array.isArray(items) || !isValidMechanicsList(variable, items)))) {
            record.items.replaceChildren();
            const empty = document.createElement('li');
            empty.textContent = isList ? 'This List is unavailable.' : 'This variable is unavailable.';
            record.items.appendChild(empty);
            return;
        }
        const contentSignature = isList ? JSON.stringify(items) : `${typeof scalarValue}:${String(scalarValue)}`;
        if (record.lastContentSignature === contentSignature && record.lastVariableName === variable.name) return;
        record.lastContentSignature = contentSignature;
        record.lastVariableName = variable.name;
        record.items.replaceChildren();
        if (isList && !items.length) {
            const empty = document.createElement('li');
            empty.textContent = 'No items yet.';
            record.items.appendChild(empty);
            return;
        }
        const values = isList ? items : [{ value: scalarValue, valueType: variable.valueType }];
        for (const item of values) record.items.appendChild(renderMechanicsListItem(item));
    };

    const showMechanicsVariablePanel = (world, variableId, title, player, expectedType) => {
        if (typeof document === 'undefined' || !player || window.engine?.localPlayer !== player) return false;
        const variable = getVariable(world, variableId);
        if (!variable || (expectedType === 'list' ? variable.variableType !== 'list' : variable.variableType === 'list')) return false;
        closeMechanicsListPanel(player._mechanicsListPanel);
        const worldState = getWorldState(world);
        if (variable.variableType === 'list' && variable.scope === 'player') getMechanicsPlayerListValue(world, variable, player);
        if (variable.variableType !== 'list') getVariableValue(world, variable, player);

        const panel = document.createElement('section');
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-live', 'polite');
        panel.setAttribute('aria-label', title);
        panel.style.cssText = 'position:fixed;z-index:100000;top:max(12px,env(safe-area-inset-top));right:max(12px,env(safe-area-inset-right));width:min(340px,calc(100vw - 24px));max-height:min(52vh,420px);display:flex;flex-direction:column;box-sizing:border-box;padding:14px;border:1px solid rgba(156,236,255,.5);border-radius:14px;background:rgba(12,18,30,.96);color:#f5f7ff;box-shadow:0 12px 40px rgba(0,0,0,.42);font:500 15px/1.4 system-ui,sans-serif;';

        const header = document.createElement('header');
        header.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:10px;';
        const heading = document.createElement('h2');
        heading.style.cssText = 'margin:0;flex:1;min-width:0;color:#9cecff;font-size:17px;line-height:1.25;overflow-wrap:anywhere;';
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.textContent = 'Close';
        closeButton.setAttribute('aria-label', 'Close status panel');
        closeButton.style.cssText = 'min-height:42px;padding:8px 12px;border:1px solid rgba(255,255,255,.25);border-radius:9px;background:#202b3e;color:#fff;font:700 14px system-ui,sans-serif;cursor:pointer;';
        const list = document.createElement('ul');
        list.style.cssText = 'display:flex;flex-direction:column;gap:7px;margin:0;padding:0 3px 0 0;overflow:auto;list-style:none;';
        header.append(heading, closeButton);
        panel.append(header, list);
        document.body.appendChild(panel);

        const record = { element: panel, heading, items: list, player, world, worldState, variableId, title: title.trim(), lastContentSignature: null, lastVariableName: null, keyHandler: null };
        player._mechanicsListPanel = record;
        globalState.listPanels.add(record);
        closeButton.addEventListener('click', () => closeMechanicsListPanel(record));
        record.keyHandler = (event) => {
            if (event.key !== 'Escape' || !record.element?.isConnected) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            closeMechanicsListPanel(record);
        };
        document.addEventListener('keydown', record.keyHandler, true);
        renderMechanicsListPanel(record);
        closeButton.focus({ preventScroll: true });
        return true;
    };

    const showMechanicsListPanel = (world, variableId, title, player) =>
        showMechanicsVariablePanel(world, variableId, title, player, 'list');

    const showMechanicsScalarPanel = (world, variableId, title, player) =>
        showMechanicsVariablePanel(world, variableId, title, player, 'scalar');

    const releaseDialogueInput = (player) => {
        if (player?.input && typeof player.input === 'object') {
            for (const key of Object.keys(player.input)) player.input[key] = false;
        }
        const engine = typeof window !== 'undefined' ? window.engine : null;
        if (engine?.localPlayer === player && engine.keys) {
            for (const key of Object.keys(engine.keys)) engine.keys[key] = false;
            engine.updatePlayerInput?.();
        }
        globalState.pressedKeys.clear();
        globalState.keyJustPressed.clear();
    };

    const updateMechanicsDialoguePage = (entry) => {
        if (!entry?.pageNode || !entry?.nextButton) return;
        entry.pageNode.textContent = entry.pages[entry.pageIndex];
        entry.nextButton.textContent = entry.pageIndex + 1 < entry.pages.length
            ? `Continue (${entry.pageIndex + 1}/${entry.pages.length})`
            : 'Close';
    };

    const showNextMechanicsDialogue = () => {
        if (globalState.activeDialogue || !globalState.dialogueQueue.length || typeof document === 'undefined') return;
        const entry = globalState.dialogueQueue.shift();
        globalState.activeDialogue = entry;
        entry.player._mechanicsDialogueOpen = true;
        const isMenu = entry.menu === true;
        entry.previousFocus = document.activeElement;
        if (entry.pauseWorld) setMechanicsWorldPaused(entry.world, entry, true);

        const overlay = document.createElement('div');
        overlay.setAttribute('role', 'presentation');
        overlay.style.cssText = isMenu
            ? 'position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;padding:max(20px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));background:rgba(5,8,15,.78);box-sizing:border-box;'
            : 'position:fixed;inset:0;z-index:100001;display:flex;align-items:flex-end;justify-content:center;padding:24px max(16px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));background:linear-gradient(transparent 38%,rgba(5,8,15,.68));box-sizing:border-box;';

        const panel = document.createElement('section');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-label', isMenu ? entry.menuTitle : entry.speaker ? `Dialogue from ${entry.speaker}` : 'Dialogue');
        panel.style.cssText = isMenu
            ? 'width:min(520px,100%);max-height:min(88dvh,760px);overflow:auto;box-sizing:border-box;padding:24px;border:1px solid rgba(188,214,255,.65);border-radius:18px;background:linear-gradient(145deg,rgba(19,27,44,.99),rgba(10,14,25,.99));color:#f5f7ff;box-shadow:0 20px 72px rgba(0,0,0,.62);font:500 16px/1.5 system-ui,sans-serif;'
            : 'width:min(760px,100%);box-sizing:border-box;padding:20px 22px 16px;border:1px solid rgba(188,214,255,.55);border-radius:16px;background:linear-gradient(145deg,rgba(19,27,44,.98),rgba(10,14,25,.98));color:#f5f7ff;box-shadow:0 18px 64px rgba(0,0,0,.5);font:500 17px/1.55 system-ui,sans-serif;';

        const menuTitle = document.createElement('h2');
        menuTitle.textContent = entry.menuTitle || '';
        menuTitle.id = `mechanics-menu-title-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        menuTitle.style.cssText = 'margin:0 0 18px;color:#f5f7ff;font:800 24px/1.2 system-ui,sans-serif;overflow-wrap:anywhere;';
        menuTitle.hidden = !isMenu;
        if (isMenu) panel.setAttribute('aria-labelledby', menuTitle.id);

        const speaker = document.createElement('div');
        speaker.style.cssText = 'min-height:1.3em;margin-bottom:8px;color:#9cecff;font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;';
        speaker.textContent = entry.speaker;
        speaker.hidden = !entry.speaker;

        const page = document.createElement('div');
        page.setAttribute('aria-live', 'polite');
        page.style.cssText = 'min-height:3em;max-height:min(38vh,300px);overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;';
        page.hidden = isMenu;

        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex;justify-content:flex-end;align-items:center;margin-top:14px;';
        const nextButton = document.createElement('button');
        nextButton.type = 'button';
        nextButton.style.cssText = 'min-width:116px;min-height:44px;padding:9px 18px;border:1px solid rgba(156,236,255,.8);border-radius:10px;background:#17364a;color:#fff;font:700 14px system-ui,sans-serif;cursor:pointer;touch-action:manipulation;';
        footer.appendChild(nextButton);
        if (Array.isArray(entry.choices)) {
            const choicesNode = document.createElement('div');
            choicesNode.setAttribute('role', 'group');
            choicesNode.setAttribute('aria-label', isMenu ? `${entry.menuTitle} options` : 'Choices');
            choicesNode.style.cssText = `display:grid;grid-template-columns:${isMenu ? '1fr' : 'repeat(auto-fit,minmax(min(220px,100%),1fr))'};gap:10px;margin-top:${isMenu ? '0' : '18px'};max-height:min(48vh,420px);overflow:auto;overscroll-behavior:contain;padding:2px;`;
            for (const choice of entry.choices) {
                const choiceButton = document.createElement('button');
                choiceButton.type = 'button';
                choiceButton.textContent = choice.label;
                choiceButton.setAttribute('aria-label', choice.label);
                choiceButton.style.cssText = 'min-height:48px;padding:10px 16px;border:1px solid rgba(156,236,255,.7);border-radius:10px;background:#17364a;color:#fff;font:700 15px/1.35 system-ui,sans-serif;cursor:pointer;touch-action:manipulation;text-align:left;';
                choiceButton.addEventListener('click', () => advance(choice.eventId));
                choicesNode.appendChild(choiceButton);
            }
            footer.hidden = true;
            panel.append(menuTitle, speaker, page, choicesNode, footer);
            if (isMenu && entry.cancelable) {
                const cancelButton = document.createElement('button');
                cancelButton.type = 'button';
                cancelButton.textContent = 'Cancel';
                cancelButton.setAttribute('aria-label', 'Cancel menu');
                cancelButton.style.cssText = 'width:100%;min-height:44px;margin-top:10px;padding:9px 16px;border:1px solid rgba(188,214,255,.38);border-radius:10px;background:rgba(255,255,255,.06);color:#e5eaf3;font:700 14px system-ui,sans-serif;cursor:pointer;touch-action:manipulation;';
                cancelButton.addEventListener('click', () => advance(entry.cancelEventId || null));
                panel.appendChild(cancelButton);
            }
        } else {
            panel.append(speaker, page, footer);
        }
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

       entry.overlay = overlay;
       entry.pageNode = page;
       entry.nextButton = nextButton;
       updateMechanicsDialoguePage(entry);
        const initialControl = Array.isArray(entry.choices) ? overlay.querySelector('button') : nextButton;
        initialControl?.focus({ preventScroll: true });

        const advance = (selectedEventId = null) => {
            if (globalState.activeDialogue !== entry) return;
            if (Array.isArray(entry.choices) && selectedEventId !== null &&
                !entry.choices.some(choice => choice.eventId === selectedEventId) && entry.cancelEventId !== selectedEventId) return;
            if (Array.isArray(entry.choices) && selectedEventId === null && !entry.cancelable) return;
            if (entry.pageIndex + 1 < entry.pages.length) {
                entry.pageIndex++;
                updateMechanicsDialoguePage(entry);
                return;
            }

            document.removeEventListener('keydown', entry.keyHandler, true);
            overlay.remove();
            globalState.activeDialogue = null;
            if (entry.pauseWorld) setMechanicsWorldPaused(entry.world, entry, false);
            if (entry.previousFocus?.isConnected && typeof entry.previousFocus.focus === 'function') {
                entry.previousFocus.focus({ preventScroll: true });
            }
            const hasQueuedForPlayer = globalState.dialogueQueue.some(item => item.player === entry.player);
            entry.player._mechanicsDialogueOpen = hasQueuedForPlayer;
            if (!hasQueuedForPlayer) releaseDialogueInput(entry.player);
            let selectedResult = null;
            if (selectedEventId && typeof entry.onChoice === 'function') {
                try { selectedResult = entry.onChoice(selectedEventId); }
                catch (error) { console.warn('[Code Plugin] Choice event failed:', error); }
            }
            if (selectedResult === EVENT_ACTION_STOP) return;
            if (selectedResult?.type === EVENT_ACTION_YIELD && selectedResult.dialogue) {
                selectedResult.dialogue.continuations.push(...(entry.continuations || []));
            } else for (const continuation of entry.continuations || []) {
                try { continuation(); }
                catch (error) { console.warn('[Code Plugin] Dialogue continuation failed:', error); }
            }
            if (globalState.dialogueQueue.length) showNextMechanicsDialogue();
        };
        entry.advance = advance;
        entry.keyHandler = event => {
            if (Array.isArray(entry.choices)) {
                if (entry.menu && event.key === 'Tab') {
                    const controls = Array.from(overlay.querySelectorAll('button:not(:disabled)'));
                    const first = controls[0];
                    const last = controls[controls.length - 1];
                    if (event.shiftKey && document.activeElement === first) {
                        event.preventDefault();
                        last?.focus();
                    } else if (!event.shiftKey && document.activeElement === last) {
                        event.preventDefault();
                        first?.focus();
                    }
                    return;
                }
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    if (entry.menu) advance(entry.cancelEventId || null);
                }
                return;
            }
            if (event.code === 'Enter' || event.code === 'Space' || event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                advance();
            }
        };
        nextButton.addEventListener('click', advance);
        overlay.addEventListener('click', event => {
            if (entry.menu && event.target === overlay) advance(entry.cancelEventId || null);
        });
        document.addEventListener('keydown', entry.keyHandler, true);
    };

    const showMechanicsDialogue = (speaker, rawPages, player, options = {}) => {
        if (typeof document === 'undefined' || !player || player.isLocal === false || typeof rawPages !== 'string' ||
            (speaker !== undefined && typeof speaker !== 'string')) return false;
        clearMechanicsListPanels();
        const maxPageLength = window.CODE_MAX_DIALOGUE_PAGE_LENGTH || 512;
        const maxPages = window.CODE_MAX_DIALOGUE_PAGES || 12;
        const maxQueued = window.CODE_MAX_QUEUED_DIALOGUES || 16;
        const lines = rawPages.split(/\r?\n/);
        const pages = lines.map(line => line.trim()).filter(Boolean);
        const normalizedSpeaker = typeof speaker === 'string' ? speaker.trim() : '';
        if (rawPages.length > maxPages * (maxPageLength + 1) || !pages.length || pages.length > maxPages || pages.some(line => line.length > maxPageLength) ||
            normalizedSpeaker.length > (window.CODE_MAX_DIALOGUE_SPEAKER_LENGTH || 64)) {
            console.warn('[Code Plugin] Dialogue has invalid speaker text or page count/length.');
            return false;
        }
        if (globalState.dialogueQueue.length + (globalState.activeDialogue ? 1 : 0) >= maxQueued) {
            console.warn(`[Code Plugin] A game session can queue at most ${maxQueued} dialogue actions.`);
            return false;
        }

        const entry = {
            speaker: normalizedSpeaker,
            pages,
            pageIndex: 0,
            player,
            choices: Array.isArray(options.choices) ? options.choices : null,
            onChoice: typeof options.onChoice === 'function' ? options.onChoice : null,
            world: options.world || null,
            pauseWorld: options.pauseWorld === true,
            menu: options.menu === true,
            menuTitle: typeof options.menuTitle === 'string' ? options.menuTitle : '',
            cancelEventId: typeof options.cancelEventId === 'string' ? options.cancelEventId : null,
            cancelable: options.menu === true,
            continuations: []
        };
        player._mechanicsDialogueOpen = true;
        if (player.input && typeof player.input === 'object') {
            for (const key of Object.keys(player.input)) player.input[key] = false;
        }
        player.vx = 0;
        player.vy = 0;
        globalState.dialogueQueue.push(entry);
        showNextMechanicsDialogue();
        return entry;
    };

    const showMechanicsChoice = (speaker, prompt, rawChoices, player, world, onChoice) => {
        const maxChoices = window.CODE_MAX_DIALOGUE_CHOICES || 8;
        const maxLabelLength = window.CODE_MAX_DIALOGUE_CHOICE_LABEL_LENGTH || 64;
        const normalizedSpeaker = speaker === undefined ? '' : speaker;
        if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > (window.CODE_MAX_DIALOGUE_PAGE_LENGTH || 512) ||
            prompt.includes('\n') || typeof normalizedSpeaker !== 'string' || typeof onChoice !== 'function' ||
            !Array.isArray(rawChoices) || rawChoices.length < 2 || rawChoices.length > maxChoices) {
            console.warn('[Code Plugin] Choice prompt or choice count is invalid.');
            return false;
        }
        const events = new Map(getCodeData(world).events.map(event => [event?.id, event]));
        const labels = new Set();
        const choices = [];
        for (const choice of rawChoices) {
            const label = typeof choice?.label === 'string' ? choice.label.trim() : '';
            const eventId = typeof choice?.eventId === 'string' ? choice.eventId : '';
            const target = events.get(eventId);
            if (!label || label.length > maxLabelLength || labels.has(label.toLocaleLowerCase()) ||
                !target || target.enabled === false) {
                console.warn('[Code Plugin] A choice needs a unique short label and an enabled event.');
                return false;
            }
            labels.add(label.toLocaleLowerCase());
            choices.push({ label, eventId });
        }
        return showMechanicsDialogue(normalizedSpeaker, prompt, player, { choices, onChoice });
    };

    const showMechanicsMenu = (title, rawChoices, cancelEventId, pauseWorld, player, world, onChoice) => {
        const maxChoices = window.CODE_MAX_DIALOGUE_CHOICES || 8;
        const maxLabelLength = window.CODE_MAX_DIALOGUE_CHOICE_LABEL_LENGTH || 64;
        if (typeof title !== 'string' || !title.trim() || title.length > 64 ||
            (pauseWorld !== undefined && typeof pauseWorld !== 'boolean') || typeof onChoice !== 'function' ||
            !Array.isArray(rawChoices) || rawChoices.length < 1 || rawChoices.length > maxChoices) {
            console.warn('[Code Plugin] Menu title or option count is invalid.');
            return false;
        }
        const events = new Map(getCodeData(world).events.map(event => [event?.id, event]));
        const labels = new Set();
        const choices = [];
        for (const choice of rawChoices) {
            const label = typeof choice?.label === 'string' ? choice.label.trim() : '';
            const eventId = typeof choice?.eventId === 'string' ? choice.eventId : '';
            const target = events.get(eventId);
            if (!label || label.length > maxLabelLength || labels.has(label.toLocaleLowerCase()) ||
                !target || target.enabled === false) {
                console.warn('[Code Plugin] Menu options need unique short labels and enabled Events.');
                return false;
            }
            labels.add(label.toLocaleLowerCase());
            choices.push({ label, eventId });
        }
        let normalizedCancelEventId = null;
        if (cancelEventId !== undefined && cancelEventId !== null && cancelEventId !== '') {
            const cancelEvent = typeof cancelEventId === 'string' ? events.get(cancelEventId) : null;
            if (!cancelEvent || cancelEvent.enabled === false) {
                console.warn('[Code Plugin] A menu cancel route must target an enabled Event.');
                return false;
            }
            normalizedCancelEventId = cancelEventId;
        }
        return showMechanicsDialogue('', title.trim(), player, {
            choices,
            onChoice,
            menu: true,
            menuTitle: title.trim(),
            cancelEventId: normalizedCancelEventId,
            world,
            pauseWorld: pauseWorld === true
        });
    };

    const clearMechanicsDialogues = () => {
        const entries = [...globalState.dialogueQueue];
        if (globalState.activeDialogue) entries.push(globalState.activeDialogue);
        globalState.dialogueQueue.length = 0;
        globalState.activeDialogue = null;
        for (const entry of entries) {
            if (entry.keyHandler && typeof document !== 'undefined') document.removeEventListener('keydown', entry.keyHandler, true);
            entry.overlay?.remove();
            if (entry.pauseWorld) setMechanicsWorldPaused(entry.world, entry, false);
            if (entry.player) {
                entry.player._mechanicsDialogueOpen = false;
                releaseDialogueInput(entry.player);
            }
        }
    };

    const scheduleWorldTimer = (timer) => {
        const initialWorldState = globalState.worldStates.get(timer.world);
        if (initialWorldState?.worldPauseTokens?.size) {
            if (!Number.isFinite(timer.remainingMs)) timer.remainingMs = timer.delayMs;
            timer.handle = null;
            timer.dueAt = null;
            return;
        }
        const delayMs = Number.isFinite(timer.remainingMs) ? Math.max(0, timer.remainingMs) : timer.delayMs;
        timer.remainingMs = null;
        timer.dueAt = Date.now() + delayMs;
        timer.handle = setTimeout(() => {
            const worldState = globalState.worldStates.get(timer.world);
            if (worldState?.timers?.get(timer.name) !== timer) return;
            timer.handle = null;
            timer.dueAt = null;
            if (worldState?.worldPauseTokens?.size) {
                timer.remainingMs = 0;
                return;
            }
            const engine = window.engine;
            const gameState = window.GameState;
            const engineIsActive = !engine || !gameState || [gameState.PLAYING, gameState.TESTING].includes(engine.state);
            if (globalState.activeWorld !== timer.world || (engine && engine.world !== timer.world) || !engineIsActive) {
                clearWorldTimers(timer.world);
                return;
            }
            const maxFires = window.CODE_MAX_TIMER_FIRES || 10000;
            if (worldState.timerFires >= maxFires) {
                clearWorldTimer(timer.world, timer.name);
                console.warn(`[Code Plugin] Timer execution reached the ${maxFires}-fire map-session limit.`);
                return;
            }

            worldState.timerFires++;
            timer.fires++;
            // Shared timers may have been started by a remote player's trigger.
            // Keep that player identity so delayed player-scoped actions do not
            // silently target the host; only local presentation uses host services.
            const player = timer.player || (engine?.world === timer.world ? engine.localPlayer : null);
            timer.executing = true;
            try {
                executeEvent(timer.eventId, timer.world, player, {
                    ...timer.context,
                    timerName: timer.name,
                    timerEvent: true,
                    audioManager: engine?.world === timer.world ? engine.audioManager : timer.context.audioManager
                });
            } finally {
                timer.executing = false;
            }

            if (worldState.timers.get(timer.name) !== timer) return;
            if (timer.fires >= timer.repeatCount) {
                worldState.timers.delete(timer.name);
                return;
            }
            scheduleWorldTimer(timer);
        }, delayMs);
    };

    const startWorldTimer = (action, world, player, context, sourceEvent, sourceAction) => {
        const timerName = typeof action.timerName === 'string' ? action.timerName.trim() : '';
        const delaySeconds = isFiniteMechanicsNumber(action.seconds) ? Number(action.seconds) : NaN;
        if (action.repeat !== undefined && ![true, false, 'true', 'false'].includes(action.repeat)) {
            reportMechanicsRuntimeError(world, sourceEvent, sourceAction,
                'Start Timer repeat must be true or false.');
            return;
        }
        const repeat = action.repeat === true || action.repeat === 'true';
        const repeatCount = repeat ? Number(action.repeatCount) : 1;
        const maxDelay = window.CODE_MAX_TIMER_DELAY_SECONDS || 86400;
        const maxRepeats = window.CODE_MAX_TIMER_REPEAT_COUNT || 1000;
        const maxTimers = window.CODE_MAX_ACTIVE_TIMERS || 128;
        const event = getCodeData(world).events.find(item => item.id === action.eventId && item.enabled !== false);
        if (!timerName || timerName.length > 64) {
            reportMechanicsRuntimeError(world, sourceEvent, sourceAction,
                'Start Timer needs a name containing 1 to 64 characters.');
            return;
        }
        if (!event) {
            reportMechanicsRuntimeError(world, sourceEvent, sourceAction,
                'Start Timer needs an existing enabled Event.');
            return;
        }
        if (!Number.isFinite(delaySeconds) || delaySeconds < 0.01 || delaySeconds > maxDelay) {
            reportMechanicsRuntimeError(world, sourceEvent, sourceAction,
                `Timer delay must be between 0.01 and ${maxDelay} seconds.`);
            return;
        }
        if (repeat && (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > maxRepeats)) {
            reportMechanicsRuntimeError(world, sourceEvent, sourceAction,
                `Repeating timers must fire between 1 and ${maxRepeats} times.`);
            return;
        }

        const worldState = getWorldState(world);
        if (!worldState) {
            reportMechanicsRuntimeError(world, sourceEvent, sourceAction,
                'Start Timer could not initialize Mechanics state for this map.');
            return;
        }
        const existingTimer = worldState.timers.get(timerName);
        if (!existingTimer && worldState.timers.size >= maxTimers) {
            reportMechanicsRuntimeError(world, sourceEvent, sourceAction,
                `A map can have at most ${maxTimers} active timers.`);
            return;
        }
        if (existingTimer) clearWorldTimer(world, timerName);
        activateWorldRuntime(world);
        const timer = {
            name: timerName,
            world,
            player,
            context: { ...context },
            eventId: action.eventId,
            delayMs: delaySeconds * 1000,
            repeatCount: repeat ? repeatCount : 1,
            fires: 0,
            handle: null,
            dueAt: null,
            remainingMs: null,
            executing: false
        };
        worldState.timers.set(timerName, timer);
        scheduleWorldTimer(timer);
    };

    const getPendingChoiceRouteKey = (triggerId, playerId, parentEventId) =>
        JSON.stringify([triggerId, playerId, parentEventId]);

    const rememberSharedChoiceRoutes = (world, action, context, event) => {
        const triggerId = typeof context.triggerId === 'string' ? context.triggerId : '';
        const playerId = typeof context.sourcePlayerId === 'string' ? context.sourcePlayerId : '';
        const parentEventId = typeof event?.id === 'string' ? event.id : '';
        if (!triggerId || !playerId || !parentEventId) return false;
        const eventIds = new Set((Array.isArray(action.choices) ? action.choices : [])
            .map(choice => choice?.eventId)
            .filter(eventId => typeof eventId === 'string' && getCodeData(world).events.some(candidate => candidate?.id === eventId && candidate.enabled !== false)));
        if (action.type === 'showMenu' && typeof action.cancelEventId === 'string' &&
            getCodeData(world).events.some(candidate => candidate?.id === action.cancelEventId && candidate.enabled !== false)) {
            eventIds.add(action.cancelEventId);
        }
        if (!eventIds.size) return false;
        const pending = getWorldState(world)?.pendingChoiceRoutes;
        if (!(pending instanceof Map)) return false;
        const now = Date.now();
        for (const [key, route] of pending) {
            if (!route || route.expiresAt <= now) pending.delete(key);
        }
        while (pending.size >= 256) pending.delete(pending.keys().next().value);
        pending.set(getPendingChoiceRouteKey(triggerId, playerId, parentEventId), {
            eventIds,
            expiresAt: now + 5 * 60 * 1000
        });
        return true;
    };

    const consumeSharedChoiceRoute = (world, triggerId, playerId, parentEventId, selectedEventId) => {
        const pending = getWorldState(world)?.pendingChoiceRoutes;
        if (!(pending instanceof Map)) return false;
        const key = getPendingChoiceRouteKey(triggerId, playerId, parentEventId);
        const route = pending.get(key);
        if (!route) return false;
        if (route.expiresAt <= Date.now()) {
            pending.delete(key);
            return false;
        }
        if (!route.eventIds?.has(selectedEventId)) return false;
        pending.delete(key);
        return true;
    };

    const executeAction = (action, world, player, context = {}, runEvent = null, event = null, actionIndex = -1) => {
        const actionType = typeof action?.type === 'string' ? action.type.slice(0, 64) : 'missing type';
        const actionSource = Number.isInteger(actionIndex) && actionIndex >= 0
            ? `action ${actionIndex + 1} (${actionType})` : `action (${actionType})`;
        const actionPersistenceContext = {
            ...context,
            mechanicsActionDiagnostic: { event, source: actionSource }
        };
        const supportedActions = window.CODE_EVENT_ACTION_TYPES;
        if (!action || typeof action !== 'object' || Array.isArray(action)) {
            reportMechanicsRuntimeError(world, event, actionSource,
                'This Event contains a malformed action record.');
            return;
        }
        if (Array.isArray(supportedActions) && supportedActions.length > 0 &&
            !supportedActions.some(candidate => candidate?.id === action.type)) {
            reportMechanicsRuntimeError(world, event, 'unsupported action',
                `This Event contains an unsupported action type: ${actionType}.`);
            console.warn(`[Code Plugin] Unsupported event action: ${actionType}`);
            return;
        }
        const multiplayer = getMultiplayerManager();
        const inMultiplayerRoom = Boolean(multiplayer?.getRoomCode?.());
        if (context.sharedAuthoritativeReplay && ['showDialogue', 'showChoice', 'showMenu'].includes(action.type)) {
            if (['showChoice', 'showMenu'].includes(action.type) && inMultiplayerRoom && multiplayer.isHost &&
                !rememberSharedChoiceRoutes(world, action, context, event)) {
                reportMechanicsRuntimeError(world, event, actionSource,
                    'The host could not record the enabled routes for this choice.');
            }
            // The host records choice routes before selection. Dialogue and
            // choice actions suspend the local chain, so end authoritative
            // replay here instead of running later shared actions early.
            return EVENT_ACTION_STOP;
        }
        if (context.sharedAuthoritativeReplay &&
            !SHARED_MECHANICS_ACTIONS.has(action.type) && !['branchVariable', 'runEvent'].includes(action.type)) {
            return ['transitionToMap', 'restartScene'].includes(action.type) ? EVENT_ACTION_STOP : undefined;
        }
        if (inMultiplayerRoom && !multiplayer.isHost && !context.authoritativeStateApplication &&
            SHARED_MECHANICS_ACTIONS.has(action.type)) return;
        const worldState = getWorldState(world);
        switch (action.type) {
            case 'setVariable': {
                const variable = getVariable(world, action.variableId);
                if (!variable || variable.variableType === 'list') {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Variable requires an enabled single-value variable.');
                    break;
                }
                if (!isValidVariableValue(variable, action.value)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Variable has a value that does not match the selected variable type.');
                    break;
                }
                if (variable.scope === 'player' && ![undefined, 'triggering', 'touched', 'all'].includes(action.playerTarget)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Variable has an unsupported Player target.');
                    break;
                }
                const nextValue = normalizeVariableValue(variable, action.value);
                for (const playerId of getVariableTargetIds(variable, action, player, context)) {
                    const targetPlayer = playerId ? { id: playerId } : player;
                    setVariableValue(world, variable, nextValue, targetPlayer,
                        { ...actionPersistenceContext, targetPlayerId: playerId || context.targetPlayerId });
                }
                break;
            }
            case 'addVariable': {
                const variable = getVariable(world, action.variableId);
                if (!variable || variable.variableType === 'list' || !['integer', 'float'].includes(variable.valueType)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Add to Number Variable requires an enabled integer or float variable.');
                    break;
                }
                const amount = Number(action.amount);
                if (!isFiniteMechanicsNumber(action.amount) || (variable.valueType === 'integer' && !Number.isSafeInteger(amount))) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Add to Number Variable needs a finite amount matching the variable type.');
                    break;
                }
                if (variable.scope === 'player' && ![undefined, 'triggering', 'touched', 'all'].includes(action.playerTarget)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Add to Number Variable has an unsupported Player target.');
                    break;
                }
                for (const playerId of getVariableTargetIds(variable, action, player, context)) {
                    const targetPlayer = playerId ? { id: playerId } : player;
                    const targetContext = { ...actionPersistenceContext, targetPlayerId: playerId || context.targetPlayerId };
                    const current = Number(getVariableValue(world, variable, targetPlayer, targetContext)) || 0;
                    const nextValue = current + amount;
                    if (Number.isFinite(nextValue) && (variable.valueType !== 'integer' || Number.isSafeInteger(nextValue))) {
                        setVariableValue(world, variable, nextValue, targetPlayer, targetContext);
                    } else {
                        reportMechanicsRuntimeError(world, event, actionSource,
                            'Adding this amount would produce an invalid Number Variable value.');
                    }
                }
                break;
            }
            case 'calculateVariable': {
                const variable = getVariable(world, action.variableId);
                const operation = action.operation;
                const operand = Number(action.operand);
                if (!variable || variable.variableType === 'list' || !['integer', 'float'].includes(variable.valueType)) {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Calculation requires an integer or float variable.');
                    break;
                }
                if (!['add', 'subtract', 'multiply', 'divide'].includes(operation) ||
                    !isFiniteMechanicsNumber(action.operand) ||
                    (variable.valueType === 'integer' && !Number.isSafeInteger(operand))) {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Calculation needs a supported operation and a valid numeric operand.');
                    break;
                }
                if (operation === 'divide' && operand === 0) {
                    reportMechanicsRuntimeError(world, event, actionSource, 'A number variable cannot be divided by zero.');
                    break;
                }
                if (variable.scope === 'player' && ![undefined, 'triggering', 'touched', 'all'].includes(action.playerTarget)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Calculate Number Variable has an unsupported Player target.');
                    break;
                }
                for (const playerId of getVariableTargetIds(variable, action, player, context)) {
                    const targetPlayer = playerId ? { id: playerId } : player;
                    const targetContext = { ...actionPersistenceContext, targetPlayerId: playerId || context.targetPlayerId };
                    const current = Number(getVariableValue(world, variable, targetPlayer, targetContext));
                    const base = Number.isFinite(current) ? current : 0;
                    const nextValue = operation === 'add' ? base + operand
                        : operation === 'subtract' ? base - operand
                            : operation === 'multiply' ? base * operand : base / operand;
                    if (!Number.isFinite(nextValue) ||
                        (variable.valueType === 'integer' && !Number.isSafeInteger(nextValue))) {
                        reportMechanicsRuntimeError(world, event, actionSource,
                            variable.valueType === 'integer'
                                ? 'This calculation would produce a fractional or unsafe whole-number result.'
                                : 'This calculation would produce a non-finite number.');
                        continue;
                    }
                    setVariableValue(world, variable, nextValue, targetPlayer, targetContext);
                }
                break;
            }
            case 'toggleVariable': {
                const variable = getVariable(world, action.variableId);
                if (variable?.valueType !== 'boolean' || variable.variableType === 'list') {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Toggle Boolean Variable requires an enabled boolean variable.');
                    break;
                }
                if (variable.scope === 'player' && ![undefined, 'triggering', 'touched', 'all'].includes(action.playerTarget)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Toggle Boolean Variable has an unsupported Player target.');
                    break;
                }
                for (const playerId of getVariableTargetIds(variable, action, player, context)) {
                    const targetPlayer = playerId ? { id: playerId } : player;
                    const targetContext = { ...actionPersistenceContext, targetPlayerId: playerId || context.targetPlayerId };
                    setVariableValue(world, variable, !getVariableValue(world, variable, targetPlayer, targetContext), targetPlayer, targetContext);
                }
                break;
            }
            case 'appendListItem':
            case 'removeListItem':
            case 'clearList': {
                const variable = getVariable(world, action.variableId);
                const item = action.type === 'clearList' ? null : getMechanicsListActionItem(action);
                if (variable?.variableType !== 'list') {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'This action requires an enabled List variable.');
                    break;
                }
                if (action.type !== 'clearList' && !item) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'This List action needs a valid typed item.');
                    break;
                }
                if (variable.scope === 'player' && ![undefined, 'triggering', 'touched', 'all'].includes(action.playerTarget)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'This Player List action has an unsupported target player.');
                    break;
                }
                for (const playerId of getVariableTargetIds(variable, action, player, context)) {
                    const targetPlayer = playerId ? { id: playerId } : player;
                    const targetContext = { ...actionPersistenceContext, targetPlayerId: playerId || context.targetPlayerId, player: targetPlayer };
                    const items = variable.scope === 'player'
                        ? getMechanicsPlayerListValue(world, variable, targetPlayer, targetContext)
                        : worldState.lists.get(variable.id);
                    if (!Array.isArray(items)) continue;
                    const nextItems = action.type === 'clearList' ? [] : items.slice();
                    if (action.type === 'clearList') {
                        setMechanicsListValue(world, variable, nextItems, targetContext);
                    } else if (action.type === 'appendListItem') {
                        const listLimit = getMechanicsListLimit();
                        if (nextItems.length >= listLimit) {
                            reportMechanicsRuntimeError(world, event, actionSource,
                                `Cannot add an item: List ${variable.name || variable.id} already contains its maximum of ${listLimit} items.`);
                            continue;
                        }
                        nextItems.push(item);
                        setMechanicsListValue(world, variable, nextItems, targetContext);
                    } else if (action.type === 'removeListItem') {
                        const index = nextItems.findIndex(candidate => candidate.valueType === item.valueType && Object.is(candidate.value, item.value));
                        if (index < 0) continue;
                        nextItems.splice(index, 1);
                        setMechanicsListValue(world, variable, nextItems, targetContext);
                    }
                }
                break;
            }
            case 'setInventoryItemEquipped': {
                const variable = getVariable(world, action.variableId);
                const itemName = typeof action.itemName === 'string' ? action.itemName.trim() : '';
                const rawSlot = action.slot === undefined ? 'default' : action.slot;
                if (typeof rawSlot !== 'string' || rawSlot.trim().length > 32) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Inventory Item Equipped needs an equipment slot of at most 32 characters.');
                    break;
                }
                const slot = rawSlot.trim() || 'default';
                if (variable?.variableType !== 'list' || variable.scope !== 'player' || variable.valueType !== 'string' ||
                    !itemName || itemName.length > 80 || typeof action.equipped !== 'boolean') {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Inventory Item Equipped requires an enabled Player-scoped string List, an item name up to 80 characters, and a boolean equipped value.');
                    break;
                }
                if (![undefined, 'triggering', 'touched', 'all'].includes(action.playerTarget)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Inventory Item Equipped has an unsupported Player target.');
                    break;
                }
                for (const playerId of getVariableTargetIds(variable, action, player, context)) {
                    const targetPlayer = { id: playerId };
                    const targetContext = { ...actionPersistenceContext, targetPlayerId: playerId, player: targetPlayer };
                    const items = getMechanicsPlayerListValue(world, variable, targetPlayer, targetContext);
                    if (!Array.isArray(items)) continue;
                    let matched = false;
                    let changed = false;
                    let selectedTarget = false;
                    const nextItems = items.map(candidate => {
                        const parsed = parseMechanicsInventoryItem(candidate);
                        if (!parsed) return candidate;
                        const sameSlot = parsed.slot === slot;
                        const isRequestedItem = sameSlot && parsed.name === itemName;
                        const isTarget = isRequestedItem && (!action.equipped || !selectedTarget);
                        if (isTarget && action.equipped) selectedTarget = true;
                        if (!isTarget && !(action.equipped && sameSlot && parsed.equipped)) return candidate;
                        if (isRequestedItem) matched = true;
                        const nextEquipped = isTarget && action.equipped;
                        if (parsed.equipped === nextEquipped) return candidate;
                        try {
                            const data = JSON.parse(candidate.value);
                            data.equipped = nextEquipped;
                            changed = true;
                            return { valueType: 'string', value: JSON.stringify(data) };
                        } catch {
                            return candidate;
                        }
                    });
                    if (matched && changed) setMechanicsListValue(world, variable, nextItems, targetContext);
                }
                break;
            }
            case 'branchListContains': {
                const variable = getVariable(world, action.variableId);
                const item = getMechanicsListActionItem(action);
                if (variable?.variableType !== 'list') {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'This action requires an enabled List variable.');
                    break;
                }
                if (!item) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'This List condition needs a valid typed item.');
                    break;
                }
                if (variable.scope === 'player' && ![undefined, 'triggering', 'touched'].includes(action.playerTarget)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'This Player List condition has an unsupported target player.');
                    break;
                }
                const playerId = getVariableTargetIds(variable, action, player, context)[0];
                if (variable.scope === 'player' && !playerId) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        action.playerTarget === 'touched'
                            ? 'Branch on List Item needs a touched player.'
                            : 'Branch on List Item needs an active triggering player.');
                    break;
                }
                const targetPlayer = playerId ? { id: playerId } : player;
                const targetContext = { ...context, targetPlayerId: playerId || context.targetPlayerId, player: targetPlayer };
                const items = variable.scope === 'player'
                    ? getMechanicsPlayerListValue(world, variable, targetPlayer, targetContext)
                    : worldState.lists.get(variable.id);
                if (!Array.isArray(items)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Branch on List Item could not read the selected List state.');
                    break;
                }
                const contains = items.some(candidate => candidate.valueType === item.valueType && Object.is(candidate.value, item.value));
                const eventId = contains ? action.trueEventId : action.falseEventId;
                if (eventId && typeof runEvent === 'function') return runEvent(eventId);
                break;
            }
            case 'branchInventoryItemEquipped': {
                const variable = getVariable(world, action.variableId);
                const itemName = typeof action.itemName === 'string' ? action.itemName.trim() : '';
                const rawSlot = action.slot === undefined ? 'default' : action.slot;
                const slot = typeof rawSlot === 'string' ? rawSlot.trim() || 'default' : '';
                if (variable?.variableType !== 'list' || variable.scope !== 'player' || variable.valueType !== 'string' ||
                    !itemName || itemName.length > 80 || typeof rawSlot !== 'string' || rawSlot.trim().length > 32) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Branch on Equipped Item requires an enabled Player-scoped string List, an item name up to 80 characters, and a slot up to 32 characters.');
                    break;
                }
                if (!['triggering', 'touched', undefined].includes(action.playerTarget)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Branch on Equipped Item has an unsupported Player target.');
                    break;
                }
                const playerId = getVariableTargetIds(variable, action, player, context)[0];
                if (!playerId) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        action.playerTarget === 'touched'
                            ? 'Branch on Equipped Item needs a touched player.'
                            : 'Branch on Equipped Item needs an active triggering player.');
                    break;
                }
                const targetPlayer = { id: playerId };
                const targetContext = { ...actionPersistenceContext, targetPlayerId: playerId, player: targetPlayer };
                const items = getMechanicsPlayerListValue(world, variable, targetPlayer, targetContext);
                if (!Array.isArray(items)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Branch on Equipped Item could not read the selected player List.');
                    break;
                }
                const equipped = items.some(candidate => {
                    const parsed = parseMechanicsInventoryItem(candidate);
                    return parsed?.name === itemName && parsed.slot === slot && parsed.equipped;
                });
                const eventId = equipped ? action.trueEventId : action.falseEventId;
                if (eventId && typeof runEvent === 'function') return runEvent(eventId);
                break;
            }
            case 'consumeInventoryItem': {
                const variable = getVariable(world, action.variableId);
                const itemName = typeof action.itemName === 'string' ? action.itemName.trim() : '';
                const rawSlot = action.slot === undefined ? 'default' : action.slot;
                const slot = typeof rawSlot === 'string' ? rawSlot.trim() || 'default' : '';
                const playerTarget = action.playerTarget === undefined ? 'triggering' : action.playerTarget;
                if (variable?.variableType !== 'list' || variable.scope !== 'player' || variable.valueType !== 'string' ||
                    !itemName || itemName.length > 80 || typeof rawSlot !== 'string' || rawSlot.trim().length > 32) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Use Inventory Item requires an enabled Player-scoped string List, an item name up to 80 characters, and a slot up to 32 characters.');
                    break;
                }
                if (!['triggering', 'touched'].includes(playerTarget)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Use Inventory Item has an unsupported Player target.');
                    break;
                }
                if (typeof runEvent !== 'function' || typeof runEvent.getRunError !== 'function') {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Use Inventory Item cannot validate its linked Events.');
                    break;
                }
                const trueRouteError = runEvent.getRunError(action.trueEventId);
                const falseRouteError = action.falseEventId ? runEvent.getRunError(action.falseEventId) : null;
                if (trueRouteError || falseRouteError) {
                    reportMechanicsRuntimeError(
                        world,
                        event,
                        'item use route',
                        trueRouteError || falseRouteError
                    );
                    break;
                }
                const playerId = getVariableTargetIds(variable, { ...action, playerTarget }, player, context)[0];
                if (!playerId) {
                    if (action.falseEventId && typeof runEvent === 'function') return runEvent(action.falseEventId);
                    break;
                }
                const targetPlayer = { id: playerId };
                const targetContext = { ...actionPersistenceContext, targetPlayerId: playerId, player: targetPlayer };
                const items = getMechanicsPlayerListValue(world, variable, targetPlayer, targetContext);
                if (!Array.isArray(items)) break;
                const itemIndex = items.findIndex(candidate => {
                    const parsed = parseMechanicsInventoryItem(candidate);
                    return parsed?.name === itemName && parsed.slot === slot;
                });
                if (itemIndex < 0) {
                    if (action.falseEventId && typeof runEvent === 'function') return runEvent(action.falseEventId);
                    break;
                }
                const nextItems = items.slice();
                const itemData = JSON.parse(nextItems[itemIndex].value);
                const parsedItem = parseMechanicsInventoryItem(nextItems[itemIndex]);
                if (parsedItem?.count !== null && parsedItem?.count > 1) {
                    itemData.count = parsedItem.count - 1;
                    nextItems[itemIndex] = { valueType: 'string', value: JSON.stringify(itemData) };
                } else {
                    nextItems.splice(itemIndex, 1);
                }
                if (!setMechanicsListValue(world, variable, nextItems, targetContext)) break;
                if (typeof runEvent === 'function') return runEvent(action.trueEventId);
                break;
            }
            case 'branchVariable': {
                const variable = getVariable(world, action.variableId);
                if (!variable || variable.variableType === 'list') {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Branch on Variable requires an enabled single-value variable.');
                    break;
                }
                const operator = action.operator || 'equals';
                const allowedOperators = ['equals', 'notEquals', 'truthy', 'falsy'];
                if (['integer', 'float'].includes(variable.valueType)) allowedOperators.push('greaterThan', 'lessThan');
                if (!allowedOperators.includes(operator)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Branch on Variable has an unsupported comparison for this variable type.');
                    break;
                }
                if (!['truthy', 'falsy'].includes(operator) && !isValidVariableValue(variable, action.value)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Branch on Variable has a comparison value that does not match the selected variable type.');
                    break;
                }
                if (variable.scope === 'player' && ![undefined, 'triggering', 'touched'].includes(action.playerTarget)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Branch on Variable has an unsupported Player target.');
                    break;
                }
                let conditionPlayer = player;
                if (variable?.scope === 'player' && action.playerTarget === 'touched') {
                    if (!context.touchedPlayerId) {
                        reportMechanicsRuntimeError(world, event, actionSource,
                            'Branch on Variable targeting the touched player needs a touched player.');
                        break;
                    }
                    conditionPlayer = { id: context.touchedPlayerId };
                }
                const matches = evaluateVariableCondition(world, action.variableId, action.operator, action.value, conditionPlayer, context);
                const eventId = matches ? action.trueEventId : action.falseEventId;
                if (eventId && typeof runEvent === 'function') return runEvent(eventId);
                break;
            }
            case 'branchPlayerCount': {
                const variable = getVariable(world, action.playerVariableId);
                if (!variable || variable.scope !== 'player' || variable.variableType === 'list' ||
                    !['string', 'integer', 'float', 'boolean'].includes(variable.valueType)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Branch on Player Count requires an enabled per-player single-value variable.');
                    break;
                }
                const filterOperator = action.filterOperator || 'equals';
                const allowedFilterOperators = ['equals', 'notEquals', 'truthy', 'falsy'];
                if (['integer', 'float'].includes(variable.valueType)) allowedFilterOperators.push('greaterThan', 'lessThan');
                if (!allowedFilterOperators.includes(filterOperator)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Branch on Player Count has an unsupported player-variable condition.');
                    break;
                }
                if (!['truthy', 'falsy'].includes(filterOperator) && !isValidVariableValue(variable, action.filterValue)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Branch on Player Count has a filter value that does not match the selected variable type.');
                    break;
                }
                const operator = action.operator || 'equals';
                const threshold = Number(action.count);
                if (!['equals', 'greaterThan', 'lessThan'].includes(operator) ||
                    !isFiniteMechanicsNumber(action.count) || !Number.isSafeInteger(threshold) || threshold < 0 || threshold > 100) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Branch on Player Count needs a supported comparison and a whole-number count from 0 to 100.');
                    break;
                }
                const multiplayer = getMultiplayerManager();
                const playerIds = new Set();
                if (multiplayer?.getRoomCode?.()) {
                    if (typeof multiplayer.playerId === 'string' && multiplayer.playerId) playerIds.add(multiplayer.playerId);
                    for (const [playerId, livePlayer] of multiplayer.players || []) {
                        const id = typeof livePlayer?.id === 'string' && livePlayer.id ? livePlayer.id : playerId;
                        if (typeof id === 'string' && id) playerIds.add(id);
                    }
                } else {
                    const localPlayerId = window.engine?.localPlayer?.id;
                    playerIds.add(typeof localPlayerId === 'string' && localPlayerId ? localPlayerId : '__local__');
                }
                let matches = 0;
                for (const playerId of playerIds) {
                    if (evaluateVariableCondition(world, variable.id, filterOperator, action.filterValue,
                        { id: playerId }, { ...context, targetPlayerId: playerId })) matches++;
                }
                const count = operator === 'greaterThan' ? matches > threshold
                    : operator === 'lessThan' ? matches < threshold
                        : matches === threshold;
                const eventId = count ? action.trueEventId : action.falseEventId;
                if (eventId && typeof runEvent === 'function') return runEvent(eventId);
                break;
            }
            case 'branchObjectHealth': {
                const object = getMechanicsObjectTarget(world, action, context, true);
                const health = object ? worldState.objectHealth.get(object.id) : null;
                const value = Number(action.value);
                const comparisons = {
                    equals: (current, expected) => current === expected,
                    notEquals: (current, expected) => current !== expected,
                    lessThan: (current, expected) => current < expected,
                    lessThanOrEqual: (current, expected) => current <= expected,
                    greaterThan: (current, expected) => current > expected,
                    greaterThanOrEqual: (current, expected) => current >= expected
                };
                if (!object) {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Choose an existing object or an object touched by this Event.');
                    break;
                }
                if (!health || !Number.isSafeInteger(health.current) || !Number.isSafeInteger(health.maximum)) {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Set or damage this object’s Mechanics health before branching on it.');
                    break;
                }
                const compare = comparisons[action.operator];
                if (!compare || !isFiniteMechanicsNumber(action.value) || !Number.isSafeInteger(value) || value < 0 || value > 99999) {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Object health comparison needs a supported operator and whole number from 0 to 99,999.');
                    break;
                }
                context.healthObjectId = object.id;
                context.healthObjectName = object.name || object.displayName || object.appearanceType || null;
                context.objectHealth = health.current;
                context.objectMaxHealth = health.maximum;
                context.objectDefeated = health.current === 0;
                const eventId = compare(health.current, value) ? action.trueEventId : action.falseEventId;
                if (eventId && typeof runEvent === 'function') return runEvent(eventId);
                break;
            }
            case 'setObjectEnabled': {
                if (typeof action.enabled !== 'boolean') {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Object Enabled needs an enabled or disabled state.');
                    break;
                }
                const enabled = action.enabled;
                const object = world?.getObjectById?.(action.objectId);
                if (!object) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Object Enabled needs an existing map object.');
                    break;
                }
                const wasEnabled = object?._mechanicsEnabled !== false;
                if (!world?.setMechanicsObjectEnabled?.(object.id, enabled)) break;
                if (enabled && worldState.objectHealth.get(object.id)?.current === 0) worldState.objectHealth.delete(object.id);
                if (action.persist === true && isMechanicsObjectPersistenceAvailable(world)) {
                    const previousSavedState = ensurePersistentMechanicsLoaded(world, worldState).objects[object.id];
                    const persisted = persistMechanicsObjectState(world, object.id, enabled);
                    if (!persisted && previousSavedState !== enabled) {
                        reportMechanicsRuntimeError(world, event, actionSource,
                            'This object changed for the current session, but its browser-local save could not be written.');
                    }
                }
                if (wasEnabled !== enabled && !context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
                const engine = window.engine;
                if (engine?.world === world) {
                    if (!enabled && engine.lastCheckpoint === object) {
                        object.checkpointState = 'default';
                        engine.lastCheckpoint = null;
                        engine._onCheckpointObj = null;
                    }
                    if (!enabled && typeof document !== 'undefined' && document.getElementById('game-button-ui')?.dataset.objectId === object.id) {
                        document.getElementById('game-button-ui')?.remove();
                    }
                    if (object.appearanceType === 'coin') {
                        engine.coinsCollected = world.objects.reduce((total, candidate) =>
                            candidate.appearanceType === 'coin' && candidate._mechanicsEnabled !== false && candidate._collected
                                ? total + (typeof candidate.coinAmount === 'number' ? candidate.coinAmount : 1)
                                : total, 0);
                        engine.updateCoinCounterUI?.();
                    }
                }
                break;
            }
            case 'setObjectHealth': {
                const object = getMechanicsObjectTarget(world, action, context, true);
                if (!object) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Object Health needs an existing fixed or touched object.');
                    break;
                }
                if (!isFiniteMechanicsNumber(action.health) || !isFiniteMechanicsNumber(action.maxHealth)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Object health and maximum health must be finite numbers.');
                    break;
                }
                const health = Number(action.health);
                const maximum = Number(action.maxHealth);
                if (!Number.isSafeInteger(health) || !Number.isSafeInteger(maximum) ||
                    maximum < 1 || maximum > 99999 || health < 0 || health > maximum) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Object health needs whole numbers from 0 to 99,999, with health no greater than maximum health.');
                    break;
                }
                if (!writeObjectHealth(worldState, object.id, health, maximum)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Object health could not be stored for this map object.');
                    break;
                }
                context.healthObjectId = object.id;
                context.healthObjectName = object.name || object.displayName || object.appearanceType || null;
                context.objectHealth = health;
                context.objectMaxHealth = maximum;
                context.objectDefeated = health === 0;
                world.setMechanicsObjectEnabled?.(object.id, health > 0);
                if (!context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
                break;
            }
            case 'damageObject': {
                const object = getMechanicsObjectTarget(world, action, context);
                if (!object) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Damage Object needs an existing enabled fixed or touched object.');
                    break;
                }
                if (!isFiniteMechanicsNumber(action.amount) || !isFiniteMechanicsNumber(action.maxHealth)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Damage amount and maximum health must be finite numbers.');
                    break;
                }
                const amount = Number(action.amount);
                const maximum = Number(action.maxHealth);
                if (!Number.isSafeInteger(amount) || amount < 1 || amount > 99999 ||
                    !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 99999) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Damage Object needs whole-number damage and maximum health from 1 to 99,999.');
                    break;
                }
                let health = worldState.objectHealth.get(object.id);
                if (!health) {
                    if (!writeObjectHealth(worldState, object.id, maximum, maximum)) {
                        reportMechanicsRuntimeError(world, event, actionSource,
                            'Object health could not be initialized for this map object.');
                        break;
                    }
                    health = worldState.objectHealth.get(object.id);
                }
                if (!health || health.current <= 0) break;
                const nextHealth = Math.max(0, health.current - amount);
                if (!writeObjectHealth(worldState, object.id, nextHealth, health.maximum)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Object health could not be updated for this map object.');
                    break;
                }
                context.healthObjectId = object.id;
                context.healthObjectName = object.name || object.displayName || object.appearanceType || null;
                context.objectHealth = nextHealth;
                context.objectMaxHealth = health.maximum;
                context.objectDefeated = nextHealth === 0;
                if (!context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
                if (nextHealth === 0) {
                    world.setMechanicsObjectEnabled?.(object.id, false);
                    if (typeof action.defeatedEventId === 'string' && action.defeatedEventId && typeof runEvent === 'function') {
                        return runEvent(action.defeatedEventId);
                    }
                }
                break;
            }
            case 'setTilemapCellBehavior': {
                if (!MECHANICS_TILEMAP_CELL_BEHAVIORS.has(action.collisionType) || typeof action.tilemapId !== 'string' || !action.tilemapId) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Tilemap Cell Behavior needs a supported behavior and existing tilemap id.');
                    break;
                }
                const gridSize = window.GRID_SIZE || 32;
                const target = action.targetMode === 'touched'
                    ? getTilemapCellById(world, context.touchedObjectId)
                    : action.targetMode === 'fixed' && isFiniteMechanicsNumber(action.x) && isFiniteMechanicsNumber(action.y) &&
                        Number.isSafeInteger(Number(action.x)) && Number.isSafeInteger(Number(action.y)) &&
                        Number(action.x) % gridSize === 0 && Number(action.y) % gridSize === 0 &&
                        Math.abs(Number(action.x)) <= 10000000 && Math.abs(Number(action.y)) <= 10000000
                        ? getTilemapCellAt(world, action.tilemapId, Number(action.x), Number(action.y))
                        : null;
                if (!target || target.tilemap.id !== action.tilemapId) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Tilemap Cell Behavior needs an existing fixed or touched cell in the selected tilemap.');
                    break;
                }
                setMechanicsTilemapCellBehavior(world, worldState, target, action.collisionType, context.authoritativeStateApplication === true);
                break;
            }
            case 'setLayerVisibility': {
                const layerExists = (world?.layerDefinitions || []).some(layer => layer.id === action.layerId);
                if (!layerExists || typeof action.visible !== 'boolean') {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Draw Layer Visibility needs an existing layer and a visible or hidden state.');
                    break;
                }
                if (!(world._mechanicsLayerVisibility instanceof Map)) world._mechanicsLayerVisibility = new Map();
                if (action.visible) world._mechanicsLayerVisibility.delete(action.layerId);
                else world._mechanicsLayerVisibility.set(action.layerId, false);
                if (!context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
                break;
            }
            case 'setCameraFollowMode': {
                if (!['both', 'horizontal', 'vertical'].includes(action.mode)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Camera Follow Mode needs both, horizontal, or vertical mode.');
                    break;
                }
                world._mechanicsCameraFollowMode = action.mode;
                break;
            }
            case 'setCameraBounds': {
                if (action.mode === 'map') {
                    delete world._mechanicsCameraBounds;
                } else if (action.mode === 'unbounded') {
                    world._mechanicsCameraBounds = { enabled: false };
                } else if (action.mode === 'bounds') {
                    if (![action.x, action.y, action.width, action.height].every(isFiniteMechanicsNumber)) {
                        reportMechanicsRuntimeError(world, event, actionSource,
                            'Custom camera bounds need finite X, Y, width, and height values.');
                        break;
                    }
                    const [x, y, width, height] = [action.x, action.y, action.width, action.height].map(Number);
                    if (width > 0 && height > 0 && Math.abs(x) <= 10000000 && Math.abs(y) <= 10000000 &&
                        width <= 20000000 && height <= 20000000 && x + width <= 10000000 && y + height <= 10000000) {
                        world._mechanicsCameraBounds = { enabled: true, x, y, width, height };
                    } else {
                        reportMechanicsRuntimeError(world, event, actionSource,
                            'Camera bounds must have positive dimensions and stay within ±10,000,000 map pixels.');
                    }
                } else {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Camera Bounds needs Map Config, unbounded, or custom bounds mode.');
                }
                break;
            }
            case 'setGravity': {
                if (!['map', 'custom'].includes(action.mode)) {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Set Gravity needs Map Config or custom mode.');
                    break;
                }
                if (action.mode === 'custom' && (!isFiniteMechanicsNumber(action.gravity) || Number(action.gravity) < 0 || Number(action.gravity) > 5)) {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Custom gravity must be between 0 and 5.');
                    break;
                }
                if (action.mode === 'map') delete world._mechanicsGravity;
                else {
                    world._mechanicsGravity = Number(action.gravity);
                }
                if (!context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
                break;
            }
            case 'setJumpForce': {
                if (!['map', 'custom'].includes(action.mode)) {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Set Jump Force needs Map Config or custom mode.');
                    break;
                }
                if (action.mode === 'custom' && (!isFiniteMechanicsNumber(action.jumpForce) || Number(action.jumpForce) < -100 || Number(action.jumpForce) > -0.1)) {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Custom jump force must be between -100 and -0.1.');
                    break;
                }
                if (action.mode === 'map') delete world._mechanicsJumpForce;
                else {
                    world._mechanicsJumpForce = Number(action.jumpForce);
                }
                if (!context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
                break;
            }
            case 'setPlayerSpeed': {
                if (!['map', 'custom'].includes(action.mode)) {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Set Player Speed needs Map Config or custom mode.');
                    break;
                }
                if (action.mode === 'custom' && (!isFiniteMechanicsNumber(action.speed) || Number(action.speed) < 0.1 || Number(action.speed) > 100)) {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Custom player speed must be between 0.1 and 100.');
                    break;
                }
                if (action.mode === 'map') delete world._mechanicsPlayerSpeed;
                else world._mechanicsPlayerSpeed = Number(action.speed);
                if (!context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
                break;
            }
            case 'setMovementControl': {
                const controls = {
                    horizontalAcceleration: { key: '_mechanicsHorizontalAcceleration', min: 0, max: 20 },
                    airControl: { key: '_mechanicsAirControl', min: 0, max: 1 },
                    terminalFallSpeed: { key: '_mechanicsTerminalFallSpeed', min: 1, max: 100 }
                };
                const control = controls[action.property];
                if (!control) {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Set Movement Control needs a supported control property.');
                    break;
                }
                if (!['map', 'custom'].includes(action.mode)) {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Set Movement Control needs Map Config or custom mode.');
                    break;
                }
                if (action.mode === 'custom' && (!isFiniteMechanicsNumber(action.value) || Number(action.value) < control.min || Number(action.value) > control.max)) {
                    reportMechanicsRuntimeError(world, event, actionSource, `Custom ${action.property} must be between ${control.min} and ${control.max}.`);
                    break;
                }
                if (action.mode === 'map') delete world[control.key];
                else world[control.key] = Number(action.value);
                if (!context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
                break;
            }
            case 'spawnObject': {
                if (!player || !world?.addObject || typeof window.WorldObject !== 'function') {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Spawn Object needs an active player and object creation support in this game view.');
                    break;
                }
                const template = world.getObjectById?.(action.objectId);
                const maxTotal = window.CODE_MAX_MECHANICS_SPAWNED_OBJECTS || 64;
                const xOffset = Number(action.xOffset);
                const yOffset = Number(action.yOffset);
                const tag = action.tag;
                const maxInstances = Number(action.maxInstances);
                const lifetime = action.lifetime === undefined ? 0 : Number(action.lifetime);
                if (!template || template._mechanicsSpawned || template.type === 'teleportal' || template.appearanceType === 'teleportal' ||
                    ['zone', 'button', 'checkpoint', 'spawnpoint', 'endpoint'].includes(template.appearanceType) ||
                    ['checkpoint', 'spawnpoint', 'endpoint'].includes(template.actingType)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Spawn Object needs an existing eligible map-object template.');
                    break;
                }
                if (!Number.isFinite(xOffset) || !Number.isFinite(yOffset) ||
                    Math.abs(xOffset) > 10000000 || Math.abs(yOffset) > 10000000 ||
                    typeof tag !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(tag) ||
                    !Number.isInteger(maxInstances) || maxInstances < 1 || maxInstances > maxTotal ||
                    !Number.isFinite(lifetime) || lifetime < 0 || lifetime > (window.CODE_MAX_MECHANICS_SPAWN_LIFETIME_SECONDS || 3600)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Spawn Object needs bounded offsets, a valid 1–64 character tag, a positive instance limit, and a lifetime from 0 to 3,600 seconds.');
                    break;
                }
                const spawned = (world.objects || []).filter(object => object?._mechanicsSpawned === true);
                if (spawned.length >= maxTotal || spawned.filter(object => object._mechanicsSpawnTag === tag).length >= maxInstances) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Spawn Object reached the map-wide or per-tag spawned-object limit.');
                    break;
                }
                const x = player.x + xOffset;
                const y = player.y + yOffset;
                if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 10000000 || Math.abs(y) > 10000000) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'The spawned object position must stay within ±10,000,000 map pixels.');
                    break;
                }
                let id;
                do {
                    id = `mspawn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
                } while (world.getObjectById?.(id));
                const config = template.toJSON?.() || { ...template };
                const instance = new window.WorldObject({ ...config, id, x, y });
                instance._mechanicsSpawned = true;
                instance._mechanicsSpawnTemplateId = template.id;
                instance._mechanicsSpawnTag = tag;
                instance._mechanicsSpawnExpiresAt = lifetime > 0 ? Date.now() + lifetime * 1000 : null;
                world.addObject(instance);
                worldState.sharedMechanicsDirty = true;
                break;
            }
            case 'removeSpawnedObjects': {
                if (typeof action.tag !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(action.tag)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Remove Spawned Objects needs a tag containing 1 to 64 letters, numbers, underscores, or hyphens.');
                    break;
                }
                let removed = false;
                for (const object of [...(world?.objects || [])]) {
                    if (object?._mechanicsSpawned !== true || object._mechanicsSpawnTag !== action.tag) continue;
                    world.removeObject?.(object.id);
                    worldState.objectMotions.delete(object.id);
                    removed = true;
                }
                if (removed) worldState.sharedMechanicsDirty = true;
                break;
            }
            case 'setObjectPosition': {
                if (!isFiniteMechanicsNumber(action.x) || !isFiniteMechanicsNumber(action.y)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Object Position needs finite X and Y coordinates.');
                    break;
                }
                const x = Number(action.x);
                const y = Number(action.y);
                if (Math.abs(x) > 10000000 || Math.abs(y) > 10000000) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Object coordinates must stay within ±10,000,000 map pixels.');
                    break;
                }
                const object = world?.getObjectById?.(action.objectId);
                if (!object) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Object Position needs an existing map object.');
                    break;
                }
                if (typeof world?.setMechanicsObjectPosition !== 'function') {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Object movement is unavailable in this game view.');
                    break;
                }
                if (!world.setMechanicsObjectPosition(object.id, x, y)) break;
                worldState.objectMotions.delete(object.id);
                if (!context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
                break;
            }
            case 'setObjectDrawLayer': {
                const object = world?.getObjectById?.(action.objectId);
                const layer = (world?.layerDefinitions || []).find(item => item.id === action.layerId);
                if (!object || object._mechanicsSpawned === true || !layer) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Object Draw Layer needs an existing map object and draw layer.');
                    break;
                }
                if (object.collision !== false && (layer.parallaxX !== 1 || layer.parallaxY !== 1)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Collidable objects cannot move to parallax layers.');
                    break;
                }
                if (!world?.setMechanicsObjectDrawLayer?.(object.id, layer.id)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'The object could not be moved to that draw layer.');
                    break;
                }
                if (!context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
                break;
            }
            case 'setObjectSpriteFrame': {
                const object = world?.getObjectById?.(action.objectId);
                if (!object?.spriteSheet) {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Set Object Sprite Frame needs an existing object with a sprite sheet.');
                    break;
                }
                if (action.mode === 'automatic') {
                    if (object._mechanicsSpriteFrame !== undefined || object._mechanicsSpriteAnimation !== undefined) {
                        delete object._mechanicsSpriteFrame;
                        delete object._mechanicsSpriteAnimation;
                        if (!context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
                    }
                    break;
                }
                const frame = Number(action.frame);
                if (action.mode !== 'custom') {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Set Object Sprite Frame needs fixed-frame or automatic mode.');
                    break;
                }
                if (!isFiniteMechanicsNumber(action.frame) || !Number.isSafeInteger(frame) || frame < 0 || frame >= object.spriteSheet.frameCount) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        `Sprite frame must be a whole number from 0 to ${Math.max(0, object.spriteSheet.frameCount - 1)}.`);
                    break;
                }
                if (object._mechanicsSpriteFrame !== frame || object._mechanicsSpriteAnimation !== undefined) {
                    object._mechanicsSpriteFrame = frame;
                    delete object._mechanicsSpriteAnimation;
                    if (!context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
                }
                break;
            }
            case 'playObjectSpriteAnimation': {
                const object = world?.getObjectById?.(action.objectId);
                if (!object?.spriteSheet) {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Play Object Sprite Animation needs an existing object with a sprite sheet.');
                    break;
                }
                if (action.mode === 'automatic') {
                    if (object._mechanicsSpriteFrame !== undefined || object._mechanicsSpriteAnimation !== undefined) {
                        delete object._mechanicsSpriteFrame;
                        delete object._mechanicsSpriteAnimation;
                        if (!context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
                    }
                    break;
                }
                const clip = action.mode === 'clip'
                    ? (Array.isArray(object.spriteSheet.animations)
                        ? object.spriteSheet.animations.find(candidate => candidate?.name === action.animationName)
                        : null)
                    : null;
                const playback = action.mode === 'clip' ? clip : action;
                if (!['play', 'clip'].includes(action.mode) || !playback) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        action.mode === 'clip' ? 'Choose an existing named animation clip.' : 'Choose a frame range, named clip, or automatic animation.');
                    break;
                }
                const startFrame = Number(playback.startFrame);
                const frameCount = Number(playback.frameCount);
                const fps = Number(playback.fps);
                const loop = playback.loop;
                if ((!clip && !isFiniteMechanicsNumber(action.startFrame)) || !Number.isSafeInteger(startFrame) || startFrame < 0 ||
                    !Number.isSafeInteger(frameCount) || frameCount < 1 ||
                    startFrame + frameCount > object.spriteSheet.frameCount) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        `Sprite animation frames must fit within the object's ${object.spriteSheet.frameCount}-frame sheet.`);
                    break;
                }
                if ((!clip && !isFiniteMechanicsNumber(action.frameCount)) || (!clip && !isFiniteMechanicsNumber(action.fps)) ||
                    !Number.isFinite(fps) || fps < 1 || fps > 30 || typeof loop !== 'boolean') {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Sprite animation needs a rate from 1 to 30 FPS and a loop setting.');
                    break;
                }
                const completionEventId = typeof action.completionEventId === 'string' ? action.completionEventId.trim() : '';
                const completionEvent = completionEventId
                    ? getCodeData(world).events.find(candidate => candidate?.id === completionEventId && candidate.enabled !== false)
                    : null;
                if (completionEventId && (loop || !completionEvent)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        loop ? 'Animation completion Events require a one-shot animation.' : 'Choose an existing enabled completion Event.');
                    break;
                }
                const startedAtServer = Date.now() + (Number.isFinite(worldState.mechanicsClockOffset) ? worldState.mechanicsClockOffset : 0);
                object._mechanicsSpriteFrame = undefined;
                object._mechanicsSpriteAnimation = {
                    startFrame, frameCount, fps, loop,
                    startedAtServer,
                    startedAt: Date.now(),
                    completionEventId,
                    completionEventFired: false,
                    sourceEventId: typeof event?.id === 'string' ? event.id : '',
                    sourceEventName: typeof event?.name === 'string' ? event.name.slice(0, 80) : ''
                };
                if (!context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
                break;
            }
            case 'setObjectOpacity': {
                const object = world?.getObjectById?.(action.objectId);
                if (!object) {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Set Object Opacity needs an existing map object.');
                    break;
                }
                if (action.mode === 'map') {
                    if (object._mechanicsOpacity !== undefined) {
                        delete object._mechanicsOpacity;
                        world?.invalidateTileCache?.();
                        if (!context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
                    }
                    break;
                }
                if (action.mode !== 'custom') {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Set Object Opacity needs Map Config or custom mode.');
                    break;
                }
                if (!isFiniteMechanicsNumber(action.opacity) || Number(action.opacity) < 0 || Number(action.opacity) > 1) {
                    reportMechanicsRuntimeError(world, event, actionSource, 'Custom opacity must be between 0 and 1.');
                    break;
                }
                const opacity = Number(action.opacity);
                if (object._mechanicsOpacity !== opacity) {
                    object._mechanicsOpacity = opacity;
                    world?.invalidateTileCache?.();
                    if (!context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
                }
                break;
            }
            case 'moveObject': {
                if (!isFiniteMechanicsNumber(action.x) || !isFiniteMechanicsNumber(action.y) ||
                    !isFiniteMechanicsNumber(action.duration) || !Number.isFinite(Number(action.duration)) ||
                    Number(action.duration) < 0.01 || Number(action.duration) > (window.CODE_MAX_OBJECT_MOVE_DURATION_SECONDS || 60) ||
                    !Array.isArray(window.CODE_OBJECT_MOTION_EASINGS) ||
                    !window.CODE_OBJECT_MOTION_EASINGS.some(item => item.id === action.easing)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Move Object needs finite coordinates, a duration from 0.01 to 60 seconds, and a supported easing.');
                    break;
                }
                const x = Number(action.x);
                const y = Number(action.y);
                if (Math.abs(x) > 10000000 || Math.abs(y) > 10000000) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Object coordinates must stay within ±10,000,000 map pixels.');
                    break;
                }
                const object = world?.getObjectById?.(action.objectId);
                if (!object) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Move Object needs an existing map object.');
                    break;
                }
                if (typeof world?.setMechanicsObjectPosition !== 'function') {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Object movement is unavailable in this game view.');
                    break;
                }
                const motion = {
                    motionId: `motion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
                    fromX: object.x,
                    fromY: object.y,
                    toX: x,
                    toY: y,
                    startedAt: Date.now(),
                    durationMs: Math.round(Number(action.duration) * 1000),
                    easing: action.easing
                };
                if (!isValidObjectMotion(motion)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'The requested object movement could not be represented safely.');
                    break;
                }
                world.setMechanicsObjectPosition(object.id, object.x, object.y, { moving: true });
                worldState.objectMotions.set(object.id, motion);
                if (!context.authoritativeStateApplication) worldState.sharedMechanicsDirty = true;
                break;
            }
            case 'setCheckpoint': {
                const engine = window.engine;
                const checkpoint = world?.getObjectById?.(action.objectId);
                const previousCheckpoint = engine?.lastCheckpoint;
                if (engine?.world !== world || !engine.setPlayerCheckpoint?.(player, checkpoint, {
                    playEffects: previousCheckpoint !== checkpoint
                })) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Checkpoint needs an existing checkpoint object during Play or Test.');
                    break;
                }
                if (previousCheckpoint !== checkpoint && engine.state === window.GameState?.PLAYING && world.persistCheckpoints === true) {
                    const savedCheckpoint = window.ParkoreenLocalSave?.read?.(world, 'checkpoint');
                    if (savedCheckpoint?.checkpointId !== checkpoint.id) {
                        reportMechanicsRuntimeError(world, event, actionSource,
                            'The checkpoint changed for this session, but its browser-local save could not be written.');
                    }
                }
                break;
            }
            case 'setTriggerEnabled': {
                const triggerId = typeof action.triggerId === 'string' ? action.triggerId : '';
                const trigger = getCodeData(world).triggers.find(candidate => candidate?.id === triggerId);
                if (!trigger) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Trigger Enabled needs an existing trigger id.');
                    break;
                }
                if (typeof action.enabled !== 'boolean') {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Trigger Enabled needs an enabled or disabled state.');
                    break;
                }
                const previousEnabled = isMechanicsTriggerEnabled(world, trigger);
                worldState.triggerEnabled.set(triggerId, action.enabled);
                if (previousEnabled !== action.enabled && !context.authoritativeStateApplication) {
                    worldState.sharedMechanicsDirty = true;
                }
                break;
            }
            case 'startTimer':
                startWorldTimer(action, world, player, {
                    ...context,
                    sourceEventId: event?.id,
                    sourceEventName: event?.name
                }, event, actionSource);
                break;
            case 'stopTimer': {
                if (typeof action.timerName !== 'string' || !action.timerName.trim() || action.timerName.trim().length > 64) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Stop Timer needs a name containing 1 to 64 characters.');
                    break;
                }
                clearWorldTimer(world, action.timerName.trim());
                break;
            }
            case 'teleportPlayer':
                if (!isFiniteMechanicsNumber(action.x) || !isFiniteMechanicsNumber(action.y) ||
                    Math.abs(Number(action.x)) > (window.CODE_MAX_PLAYER_TELEPORT_COORDINATE || 10000000) ||
                    Math.abs(Number(action.y)) > (window.CODE_MAX_PLAYER_TELEPORT_COORDINATE || 10000000)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Teleport Player needs finite coordinates within ±10,000,000 map pixels.');
                    break;
                }
                if (!player) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Teleport Player needs an active player.');
                    break;
                }
                const x = Number(action.x);
                const y = Number(action.y);
                player.x = x;
                player.y = y;
                player.vx = 0;
                player.vy = 0;
                player.isOnGround = false;
                player.canJump = true;
                player._mechanicsTeleportSerial = (player._mechanicsTeleportSerial || 0) + 1;
                break;
            case 'teleportPlayerToObject': {
                const object = world?.getObjectById?.(action.objectId);
                if (!player) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Teleport Player to Object needs an active player.');
                    break;
                }
                if (!object || object._mechanicsEnabled === false ||
                    !Number.isFinite(object.x) || !Number.isFinite(object.y) ||
                    !Number.isFinite(object.width) || object.width <= 0 ||
                    !Number.isFinite(object.height) || object.height <= 0) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Teleport Player to Object needs an existing enabled object with a valid position and size.');
                    break;
                }
                const x = object.x + (object.width - (Number(player.width) || 24)) / 2;
                const y = object.y - (Number(player.height) || 24);
                const maxCoordinate = window.CODE_MAX_PLAYER_TELEPORT_COORDINATE || 10000000;
                if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > maxCoordinate || Math.abs(y) > maxCoordinate) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'The object destination must stay within ±10,000,000 map pixels.');
                    break;
                }
                player.x = x;
                player.y = y;
                player.vx = 0;
                player.vy = 0;
                player.isOnGround = false;
                player.canJump = true;
                player._mechanicsTeleportSerial = (player._mechanicsTeleportSerial || 0) + 1;
                break;
            }
            case 'transitionToMap': {
                const mapId = typeof action.mapId === 'string' ? action.mapId.trim() : '';
                if (!/^[A-Za-z0-9_-]{1,128}$/.test(mapId)) {
                    showMechanicsMessage('Choose a valid destination map before transitioning.', 5);
                    return EVENT_ACTION_STOP;
                }
                if (inMultiplayerRoom) {
                    showMechanicsMessage('Map transitions are not available in multiplayer rooms yet.', 5);
                    return EVENT_ACTION_STOP;
                }
                if (typeof window.ParkoreenTransitionToMap !== 'function') {
                    showMechanicsMessage('Map transitions are unavailable in this game view.', 5);
                    return EVENT_ACTION_STOP;
                }
                runEvent?.stopEventChain?.();
                Promise.resolve(window.ParkoreenTransitionToMap(mapId)).catch(error => {
                    const detail = typeof error?.message === 'string' ? error.message.slice(0, 160) : 'Unknown error';
                    showMechanicsMessage(`Scene transition failed: ${detail}`, 8);
                    if (globalState.dialogueQueue.length && !globalState.activeDialogue) showNextMechanicsDialogue();
                });
                return EVENT_ACTION_STOP;
            }
            case 'restartScene': {
                if (inMultiplayerRoom) {
                    showMechanicsMessage('Scene restarts are available in solo Play and Test only.', 5);
                    return EVENT_ACTION_STOP;
                }
                const engine = window.engine;
                const activeSceneMapId = window.parkoreenActiveSceneMapId;
                if (activeSceneMapId && typeof window.ParkoreenTransitionToMap === 'function') {
                    runEvent?.stopEventChain?.();
                    Promise.resolve(window.ParkoreenTransitionToMap(activeSceneMapId)).catch(error => {
                        const detail = typeof error?.message === 'string' ? error.message.slice(0, 160) : 'Unknown error';
                        showMechanicsMessage(`Scene restart failed: ${detail}`, 8);
                        if (globalState.dialogueQueue.length && !globalState.activeDialogue) showNextMechanicsDialogue();
                    });
                    return EVENT_ACTION_STOP;
                }
                const activeState = engine?.state === 'ended' ? engine?._endedFromState : engine?.state;
                if (activeState === 'testing' && typeof engine.startTestGame === 'function') {
                    runEvent?.stopEventChain?.();
                    engine.startTestGame();
                    return EVENT_ACTION_STOP;
                }
                if (activeState === 'playing' && typeof engine.startGame === 'function') {
                    runEvent?.stopEventChain?.();
                    engine.startGame(player?.name || 'Player', player?.color || '#4ECDC4');
                    return EVENT_ACTION_STOP;
                }
                showMechanicsMessage('Scene restart is available only during solo Play or Test.', 5);
                return EVENT_ACTION_STOP;
            }
            case 'setVelocity':
                if (!isFiniteMechanicsNumber(action.vx) || !isFiniteMechanicsNumber(action.vy) ||
                    Math.abs(Number(action.vx)) > (window.CODE_MAX_PLAYER_VELOCITY || 10000) ||
                    Math.abs(Number(action.vy)) > (window.CODE_MAX_PLAYER_VELOCITY || 10000)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Player Velocity needs finite speeds within ±10,000 pixels per update.');
                    break;
                }
                if (!player) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Set Player Velocity needs an active player.');
                    break;
                }
                const vx = Number(action.vx);
                const vy = Number(action.vy);
                player.vx = vx;
                player.vy = vy;
                if (player.vy < 0) player.isOnGround = false;
                break;
            case 'damagePlayer': {
                if (!isFiniteMechanicsNumber(action.amount) || Number(action.amount) < 0) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Player damage must be a finite, non-negative number.');
                    break;
                }
                if (!player || player.isDead) break;
                const amount = Math.max(0, Number(action.amount));
                if (amount <= 0) break;
                const damageSource = { actingType: 'mechanics', damageAmount: amount };
                const damageResult = getPluginManager()?.executeHook('player.damage', {
                    player,
                    source: damageSource,
                    world
                }) || {};
                if (damageResult.preventDefault !== true && typeof player.die === 'function') {
                    player.die(world, damageSource);
                }
                break;
            }
            case 'healPlayer': {
                if (!isFiniteMechanicsNumber(action.amount) || Number(action.amount) < 0) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Player healing must be a finite, non-negative number.');
                    break;
                }
                if (!player?.useHPSystem || !Number.isFinite(Number(player.maxHP))) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Heal Player requires an active player with the HP plugin enabled.');
                    break;
                }
                const amount = Math.max(0, Number(action.amount));
                player.hp = Math.min(Number(player.maxHP), Math.max(0, Number(player.hp) || 0) + amount);
                break;
            }
            case 'playSound': {
                const soundName = action.soundName;
                if (!Array.isArray(window.CODE_CORE_SOUND_NAMES) || !window.CODE_CORE_SOUND_NAMES.includes(soundName)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Play Sound needs a supported built-in sound name.');
                    break;
                }
                const audioManager = context.audioManager || window.engine?.audioManager;
                audioManager?.play?.(soundName);
                break;
            }
            case 'playPluginSound': {
                const manager = getPluginManager();
                const pluginId = action.pluginId;
                const plugin = manager?.plugins?.get(pluginId);
                const soundName = action.soundName;
                const volume = action.volume === undefined ? 1 : Number(action.volume);
                if (!plugin || !manager.isEnabled?.(pluginId) || !plugin.sounds ||
                    typeof soundName !== 'string' || !Object.hasOwn(plugin.sounds, soundName)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Play Plugin Sound needs a sound declared by an enabled plugin.');
                    break;
                }
                if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Plugin sound volume must be between 0 and 1.');
                    break;
                }
                manager.playSound(pluginId, soundName, volume);
                break;
            }
            case 'stopPluginSound': {
                const manager = getPluginManager();
                const pluginId = action.pluginId;
                const plugin = manager?.plugins?.get(pluginId);
                const soundName = action.soundName;
                if (!plugin || !manager.isEnabled?.(pluginId) || !plugin.sounds ||
                    typeof soundName !== 'string' || !Object.hasOwn(plugin.sounds, soundName)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Stop Plugin Sound needs a sound declared by an enabled plugin.');
                    break;
                }
                manager.stopSound(pluginId, soundName);
                break;
            }
            case 'runEvent': {
                const target = typeof action.eventId === 'string'
                    ? getCodeData(world).events.find(candidate => candidate?.id === action.eventId)
                    : null;
                if (!target || target.enabled === false) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Run Event needs an existing enabled Event.');
                    break;
                }
                if (typeof runEvent !== 'function') {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Run Event cannot continue from this event context.');
                    break;
                }
                return runEvent(action.eventId);
            }
            case 'showMessage': {
                if (typeof action.text !== 'string' || !action.text.trim()) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Show Message needs non-empty text.');
                    break;
                }
                if (action.duration !== undefined && action.duration !== null &&
                    (!isFiniteMechanicsNumber(action.duration) || Number(action.duration) < 0)) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Message duration must be a finite, non-negative number.');
                    break;
                }
                showMechanicsMessage(action.text, action.duration);
                break;
            }
            case 'showList': {
                const variable = getVariable(world, action.variableId);
                const title = typeof action.title === 'string' ? action.title.trim() : '';
                if (variable?.variableType !== 'list') {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Show List Panel needs an existing enabled List variable.');
                    break;
                }
                if (!title || title.length > 64) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Show List Panel needs a title containing 1 to 64 characters.');
                    break;
                }
                showMechanicsListPanel(world, variable.id, title, player);
                break;
            }
            case 'showVariablePanel': {
                const variable = getVariable(world, action.variableId);
                const title = typeof action.title === 'string' ? action.title.trim() : '';
                if (!variable || variable.variableType === 'list') {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Show Variable Panel needs an existing enabled scalar variable.');
                    break;
                }
                if (!title || title.length > 64) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Show Variable Panel needs a title containing 1 to 64 characters.');
                    break;
                }
                showMechanicsScalarPanel(world, variable.id, title, player);
                break;
            }
            case 'showDialogue': {
                const dialogue = showMechanicsDialogue(action.speaker, action.pages, player);
                if (!dialogue) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Show Dialogue could not open; check its pages, speaker, active player, and dialogue queue limit.');
                    break;
                }
                return { type: EVENT_ACTION_YIELD, dialogue };
            }
            case 'showChoice': {
                const onChoice = typeof runEvent?.forChoice === 'function' ? runEvent.forChoice : runEvent;
                const dialogue = showMechanicsChoice(action.speaker, action.prompt, action.choices, player, world, onChoice);
                if (!dialogue) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Show Choices could not open; check its prompt, unique option labels, enabled Event links, player, and queue limit.');
                    break;
                }
                return { type: EVENT_ACTION_YIELD, dialogue };
            }
            case 'showMenu': {
                const onChoice = typeof runEvent?.forChoice === 'function' ? runEvent.forChoice : runEvent;
                const dialogue = showMechanicsMenu(action.title, action.choices, action.cancelEventId, action.pauseWorld, player, world, onChoice);
                if (!dialogue) {
                    reportMechanicsRuntimeError(world, event, actionSource,
                        'Show Menu could not open; check its title, unique options, enabled Event links, cancel route, player, and queue limit.');
                    break;
                }
                return { type: EVENT_ACTION_YIELD, dialogue };
            }
            default:
                reportMechanicsRuntimeError(world, event, 'unimplemented action',
                    `The action type ${actionType} is listed but not implemented by this runtime.`);
                console.warn(`[Code Plugin] Unimplemented event action: ${actionType}`);
        }
    };

    const createPythonEventContext = (world, event, player, eventContext = {}) => {
        const safeText = (value, maxLength = 128) =>
            typeof value === 'string' ? value.slice(0, maxLength) : '';
        const safeNumber = value =>
            typeof value === 'number' && Number.isFinite(value) ? value : null;
        const playerId = safeText(player?.id || eventContext.targetPlayerId || eventContext.sourcePlayerId);
        const metadata = {
            api_version: 1,
            event_id: safeText(event?.id),
            event_name: safeText(event?.name),
            trigger_id: safeText(eventContext.triggerId),
            trigger_name: safeText(eventContext.trigger || eventContext.triggerName),
            trigger_type: safeText(eventContext.triggerType),
            player_id: playerId,
            player_name: safeText(player?.name || eventContext.playerName),
            player_username: safeText(player?.username || eventContext.playerUsername),
            player_x: safeNumber(player?.x),
            player_y: safeNumber(player?.y),
            player_width: safeNumber(player?.width),
            player_height: safeNumber(player?.height),
            player_vx: safeNumber(player?.vx),
            player_vy: safeNumber(player?.vy),
            player_is_grounded: typeof player?.isOnGround === 'boolean' ? player.isOnGround
                : typeof player?.grounded === 'boolean' ? player.grounded : null,
            player_is_dead: typeof player?.isDead === 'boolean' ? player.isDead : null,
            player_jumps_remaining: Number.isSafeInteger(player?.jumpsRemaining) ? player.jumpsRemaining : null,
            player_hp: safeNumber(player?.hp),
            player_max_hp: safeNumber(player?.maxHP),
            health_before: safeNumber(eventContext.healthBefore),
            health_after: safeNumber(eventContext.healthAfter),
            health_delta: safeNumber(eventContext.healthDelta),
            source_player_id: safeText(eventContext.sourcePlayerId),
            target_player_id: safeText(eventContext.targetPlayerId),
            touched_player_id: safeText(eventContext.touchedPlayerId),
            touched_object_id: safeText(eventContext.touchedObjectId),
            touched_object_name: safeText(eventContext.touchedObjectName),
            health_object_id: safeText(eventContext.healthObjectId),
            health_object_name: safeText(eventContext.healthObjectName),
            attack_direction: safeText(eventContext.attackDirection),
            object_health: safeNumber(eventContext.objectHealth),
            object_max_health: safeNumber(eventContext.objectMaxHealth),
            object_defeated: typeof eventContext.objectDefeated === 'boolean' ? eventContext.objectDefeated : null,
            surface_object_id: safeText(eventContext.surfaceObjectId),
            surface_object_name: safeText(eventContext.surfaceObjectName),
            game_elapsed_ms: safeNumber(eventContext.gameElapsedMs),
            game_was_test_mode: typeof eventContext.wasTestMode === 'boolean' ? eventContext.wasTestMode : null,
            death_source_id: safeText(eventContext.deathSourceId),
            death_source_name: safeText(eventContext.deathSourceName),
            death_source_type: safeText(eventContext.deathSourceType),
            jump_was_grounded: typeof eventContext.jumpWasGrounded === 'boolean' ? eventContext.jumpWasGrounded : null,
            jump_source: safeText(eventContext.jumpSource)
        };

        const resolveVariable = (key, requestedScope = null) => {
            if (typeof key !== 'string' || !key ||
                (requestedScope !== null && !['map', 'campaign', 'player'].includes(requestedScope))) return null;
            const variables = getCodeData(world).variables.filter(variable =>
                variable && variable.enabled !== false && variable.variableType !== 'list' &&
                ['string', 'integer', 'float', 'boolean'].includes(variable.valueType)
            );
            let variable = variables.find(item => item.id === key);
            if (!variable) {
                const matches = variables.filter(item => item.name === key);
                if (matches.length !== 1) return null;
                [variable] = matches;
            }
            if (requestedScope && variable.scope !== requestedScope) return null;
            return variable;
        };

        const resolveLivePlayer = playerId => {
            if (typeof playerId !== 'string' || !playerId || playerId.length > 128) return null;
            const engine = typeof window !== 'undefined' ? window.engine : null;
            const localPlayer = engine?.localPlayer || (player?.isLocal ? player : null);
            if (localPlayer && (localPlayer.id === playerId || (playerId === 'local' && !localPlayer.id))) return localPlayer;
            if (engine?.remotePlayers instanceof Map) {
                for (const remotePlayer of engine.remotePlayers.values()) {
                    if (remotePlayer?.id === playerId) return remotePlayer;
                }
            }
            return null;
        };

        const resolveListVariable = key => {
            if (typeof key !== 'string' || !key) return null;
            const lists = getCodeData(world).variables.filter(variable =>
                variable && variable.enabled !== false && variable.variableType === 'list'
            );
            const byId = lists.find(variable => variable.id === key);
            if (byId) return byId;
            const matches = lists.filter(variable => variable.name === key);
            return matches.length === 1 ? matches[0] : null;
        };

        const normalizePythonListItem = (value, requestedType = null) => {
            const inferredType = typeof value === 'string' ? 'string'
                : typeof value === 'boolean' ? 'boolean'
                    : typeof value === 'number' ? (Number.isSafeInteger(value) ? 'integer' : 'float')
                        : null;
            const valueType = requestedType === null || requestedType === undefined ? inferredType : requestedType;
            if (!['string', 'integer', 'float', 'boolean'].includes(valueType) ||
                !isValidVariableValue({ valueType }, value)) return null;
            return { valueType, value: normalizeVariableValue({ valueType }, value) };
        };

        const getList = key => {
            const variable = resolveListVariable(key);
            if (!variable) return undefined;
            const items = variable.scope === 'player'
                ? getMechanicsPlayerListValue(world, variable, player, eventContext)
                : getWorldState(world)?.lists.get(variable.id);
            if (!isValidMechanicsList(variable, items)) return undefined;
            return items.map(item => ({ value_type: item.valueType, value: item.value }));
        };

        const clearList = key => {
            const variable = resolveListVariable(key);
            if (!variable) return false;
            const multiplayer = getMultiplayerManager();
            if (multiplayer?.getRoomCode?.() && !multiplayer.isHost) return false;
            const context = { ...eventContext, player };
            const items = variable.scope === 'player'
                ? getMechanicsPlayerListValue(world, variable, player, context)
                : getWorldState(world)?.lists.get(variable.id);
            if (!Array.isArray(items) || items.length === 0) return false;
            const changed = setMechanicsListValue(world, variable, [], context);
            if (changed && multiplayer?.getRoomCode?.() && multiplayer.isHost) publishSharedMechanicsState(world);
            return changed;
        };

        const toObjectSnapshot = object => {
            if (!object) return undefined;
            return {
                id: safeText(object.id),
                name: safeText(object.name || object.displayName || object.zoneName || object.appearanceType || object.type),
                x: safeNumber(object.x),
                y: safeNumber(object.y),
                width: safeNumber(object.width),
                height: safeNumber(object.height),
                type: safeText(object.type),
                appearance_type: safeText(object.appearanceType),
                acting_type: safeText(object.actingType),
                enabled: object._mechanicsEnabled !== false,
                collision: object.collision !== false,
                collision_shape: ['circle', 'capsule', 'slopeUpRight', 'slopeUpLeft', 'polygon'].includes(object.collisionShape) ? object.collisionShape : 'box',
                collision_points: object.collisionShape === 'polygon' && Array.isArray(object.collisionPoints)
                    ? object.collisionPoints.map(point => [point[0], point[1]]) : null,
                polygon_one_way: object.collisionShape === 'polygon' ? object.polygonOneWay !== false : null,
                one_way_platform: object.oneWayPlatform === true,
                spawned: object._mechanicsSpawned === true
            };
        };

        const getObject = objectId => {
            if (typeof objectId !== 'string' || !objectId || objectId.length > 128) return undefined;
            const object = world?.getObjectById?.(objectId) ||
                world?.objects?.find(item => item?.id === objectId);
            return toObjectSnapshot(object);
        };

        const getObjects = (offset = 0, limit = 100) => {
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000 ||
                !Number.isSafeInteger(limit) || limit < 1 || limit > 128) return undefined;
            return (Array.isArray(world?.objects) ? world.objects : [])
                .slice(offset, offset + limit)
                .map(toObjectSnapshot);
        };

        const getPlayers = (offset = 0, limit = 32) => {
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 ||
                !Number.isSafeInteger(limit) || limit < 1 || limit > 64) return undefined;
            const engine = typeof window !== 'undefined' ? window.engine : null;
            const localPlayer = engine?.localPlayer || (player?.isLocal ? player : null);
            const candidates = [];
            if (localPlayer) candidates.push(localPlayer);
            if (engine?.remotePlayers instanceof Map) candidates.push(...engine.remotePlayers.values());
            const seenIds = new Set();
            const snapshots = [];
            for (const candidate of candidates) {
                if (!candidate || typeof candidate !== 'object') continue;
                const id = safeText(candidate.id, 128) || (candidate === localPlayer ? 'local' : '');
                if (!id || seenIds.has(id)) continue;
                seenIds.add(id);
                snapshots.push({
                    id,
                    name: safeText(candidate.name, 128),
                    x: safeNumber(candidate.x),
                    y: safeNumber(candidate.y),
                    width: safeNumber(candidate.width),
                    height: safeNumber(candidate.height),
                    vx: safeNumber(candidate.vx),
                    vy: safeNumber(candidate.vy),
                    is_dead: typeof candidate.isDead === 'boolean' ? candidate.isDead : null,
                    is_grounded: typeof candidate.isOnGround === 'boolean' ? candidate.isOnGround
                        : typeof candidate.grounded === 'boolean' ? candidate.grounded : null
                });
            }
            return snapshots.slice(offset, offset + limit);
        };

        const getTilemaps = (offset = 0, limit = 64) => {
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > 64 ||
                !Number.isSafeInteger(limit) || limit < 1 || limit > 64) return undefined;
            return (Array.isArray(world?.tilemaps) ? world.tilemaps : [])
                .slice(offset, offset + limit)
                .map(tilemap => ({
                    id: safeText(tilemap.id),
                    name: safeText(tilemap.name),
                    layer: Number.isSafeInteger(tilemap.layer) ? tilemap.layer : null,
                    cell_count: Array.isArray(tilemap.cells) ? tilemap.cells.length : 0,
                    atlas: tilemap.atlas ? {
                        frame_width: safeNumber(tilemap.atlas.frameWidth),
                        frame_height: safeNumber(tilemap.atlas.frameHeight),
                        columns: Number.isSafeInteger(tilemap.atlas.columns) ? tilemap.atlas.columns : null,
                        rows: Number.isSafeInteger(tilemap.atlas.rows) ? tilemap.atlas.rows : null
                    } : null
                }));
        };

        const getTilemapCells = (tilemapId, offset = 0, limit = 100) => {
            if (typeof tilemapId !== 'string' || !tilemapId || tilemapId.length > 80 ||
                !Number.isSafeInteger(offset) || offset < 0 || offset > 100000 ||
                !Number.isSafeInteger(limit) || limit < 1 || limit > 128) return undefined;
            const tilemap = (Array.isArray(world?.tilemaps) ? world.tilemaps : [])
                .find(candidate => candidate?.id === tilemapId);
            if (!tilemap) return undefined;
            return (Array.isArray(tilemap.cells) ? tilemap.cells : [])
                .slice(offset, offset + limit)
                .map(cell => {
                    const collisionType = typeof cell.collisionType === 'string' ? cell.collisionType : 'solid';
                    const isPolygon = cell.collisionShape === 'polygon' && Array.isArray(cell.collisionPoints);
                    const collisionShape = isPolygon ? 'polygon'
                        : ['rampUpRight', 'rampUpLeft'].includes(collisionType) ? collisionType : 'box';
                    return {
                        id: `tile-${tilemap.id}-${cell.x}-${cell.y}`,
                        tilemap_id: safeText(tilemap.id),
                        x: safeNumber(cell.x),
                        y: safeNumber(cell.y),
                        collision_type: collisionType,
                        collision: collisionType !== 'decorative',
                        collision_shape: collisionShape,
                        collision_points: isPolygon ? cell.collisionPoints.map(point => [point[0], point[1]]) : null,
                        polygon_one_way: isPolygon ? cell.polygonOneWay !== false : null,
                        color: safeText(cell.color),
                        texture: safeText(cell.texture),
                        opacity: safeNumber(cell.opacity),
                        atlas_frame: Number.isSafeInteger(cell.atlasFrame) ? cell.atlasFrame : null,
                        animation: cell.animation ? {
                            textures: Array.isArray(cell.animation.textures) ? [...cell.animation.textures] : null,
                            atlas_frames: Array.isArray(cell.animation.atlasFrames) ? [...cell.animation.atlasFrames] : null,
                            fps: safeNumber(cell.animation.fps)
                        } : null
                    };
                });
        };

        const setTilemapCellBehavior = (tilemapId, x, y, collisionType) => {
            const gridSize = window.GRID_SIZE || 32;
            if (typeof tilemapId !== 'string' || !tilemapId || tilemapId.length > 80 ||
                !Number.isSafeInteger(x) || !Number.isSafeInteger(y) ||
                x % gridSize !== 0 || y % gridSize !== 0 || Math.abs(x) > 10000000 || Math.abs(y) > 10000000 ||
                !MECHANICS_TILEMAP_CELL_BEHAVIORS.has(collisionType)) return false;
            const multiplayer = getMultiplayerManager();
            if (multiplayer?.getRoomCode?.() && !multiplayer.isHost) return false;
            const target = getTilemapCellAt(world, tilemapId, x, y);
            if (!target) return false;
            const changed = setMechanicsTilemapCellBehavior(world, getWorldState(world), target, collisionType);
            if (changed && multiplayer?.getRoomCode?.() && multiplayer.isHost) publishSharedMechanicsState(world);
            return changed;
        };

        const setObjectEnabled = (objectId, enabled) => {
            if (typeof objectId !== 'string' || !objectId || objectId.length > 128 || typeof enabled !== 'boolean') return false;
            const multiplayer = getMultiplayerManager();
            if (multiplayer?.getRoomCode?.() && !multiplayer.isHost) return false;
            const object = world?.getObjectById?.(objectId);
            if (!object) return false;
            executeAction({ type: 'setObjectEnabled', objectId, enabled }, world, player, eventContext);
            return (object._mechanicsEnabled !== false) === enabled;
        };

        const setObjectPosition = (objectId, x, y) => {
            if (typeof objectId !== 'string' || !objectId || objectId.length > 128 ||
                !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 10000000 || Math.abs(y) > 10000000) return false;
            const multiplayer = getMultiplayerManager();
            if (multiplayer?.getRoomCode?.() && !multiplayer.isHost) return false;
            const object = world?.getObjectById?.(objectId);
            if (!object) return false;
            executeAction({ type: 'setObjectPosition', objectId, x, y }, world, player, eventContext);
            return object.x === x && object.y === y;
        };

        const setPlayerVelocity = (vx, vy) => {
            const maxVelocity = Number(window.CODE_MAX_PLAYER_VELOCITY) || 10000;
            if (!player || !Number.isFinite(player.vx) || !Number.isFinite(player.vy) ||
                !Number.isFinite(vx) || !Number.isFinite(vy) ||
                Math.abs(vx) > maxVelocity || Math.abs(vy) > maxVelocity) return false;
            player.vx = vx;
            player.vy = vy;
            if (vy < 0) player.isOnGround = false;
            return true;
        };

        const listContains = (key, value, requestedType = null) => {
            const variable = resolveListVariable(key);
            const item = normalizePythonListItem(value, requestedType);
            if (!variable || !item) return undefined;
            const items = (variable.scope === 'player'
                ? getMechanicsPlayerListValue(world, variable, player, eventContext)
                : getWorldState(world)?.lists.get(variable.id)) || [];
            return items.some(candidate => candidate.valueType === item.valueType && Object.is(candidate.value, item.value));
        };

        const changeList = (key, value, requestedType = null, remove = false) => {
            const variable = resolveListVariable(key);
            const item = normalizePythonListItem(value, requestedType);
            if (!variable || !item) return false;
            const multiplayer = getMultiplayerManager();
            if (multiplayer?.getRoomCode?.() && !multiplayer.isHost) return false;
            const items = variable.scope === 'player'
                ? getMechanicsPlayerListValue(world, variable, player, eventContext)
                : getWorldState(world)?.lists.get(variable.id);
            if (!Array.isArray(items)) return false;
            const nextItems = items.slice();
            if (remove) {
                const index = nextItems.findIndex(candidate => candidate.valueType === item.valueType && Object.is(candidate.value, item.value));
                if (index < 0) return false;
                nextItems.splice(index, 1);
            } else {
                if (nextItems.length >= getMechanicsListLimit()) return false;
                nextItems.push(item);
            }
            const changed = setMechanicsListValue(world, variable, nextItems, { ...eventContext, player });
            if (changed && multiplayer?.getRoomCode?.() && multiplayer.isHost) publishSharedMechanicsState(world);
            return changed;
        };

        const getPlayerList = (key, playerId) => {
            const variable = resolveListVariable(key);
            const targetPlayer = resolveLivePlayer(playerId);
            if (variable?.scope !== 'player' || !targetPlayer) return undefined;
            const context = { ...eventContext, targetPlayerId: targetPlayer.id || '__local__', player: targetPlayer };
            const items = getMechanicsPlayerListValue(world, variable, targetPlayer, context);
            if (!isValidMechanicsList(variable, items)) return undefined;
            return items.map(item => ({ value_type: item.valueType, value: item.value }));
        };

        const playerListContains = (key, playerId, value, requestedType = null) => {
            const variable = resolveListVariable(key);
            const targetPlayer = resolveLivePlayer(playerId);
            const item = normalizePythonListItem(value, requestedType);
            if (variable?.scope !== 'player' || !targetPlayer || !item) return undefined;
            const context = { ...eventContext, targetPlayerId: targetPlayer.id || '__local__', player: targetPlayer };
            const items = getMechanicsPlayerListValue(world, variable, targetPlayer, context);
            if (!Array.isArray(items)) return undefined;
            return items.some(candidate => candidate.valueType === item.valueType && Object.is(candidate.value, item.value));
        };

        const changePlayerList = (key, playerId, value, requestedType = null, remove = false) => {
            const variable = resolveListVariable(key);
            const targetPlayer = resolveLivePlayer(playerId);
            const item = normalizePythonListItem(value, requestedType);
            if (variable?.scope !== 'player' || !targetPlayer || !item) return false;
            const multiplayer = getMultiplayerManager();
            if (multiplayer?.getRoomCode?.() && !multiplayer.isHost) return false;
            const context = { ...eventContext, targetPlayerId: targetPlayer.id || '__local__', player: targetPlayer };
            const items = getMechanicsPlayerListValue(world, variable, targetPlayer, context);
            if (!Array.isArray(items)) return false;
            const nextItems = items.slice();
            if (remove) {
                const index = nextItems.findIndex(candidate => candidate.valueType === item.valueType && Object.is(candidate.value, item.value));
                if (index < 0) return false;
                nextItems.splice(index, 1);
            } else {
                if (nextItems.length >= getMechanicsListLimit()) return false;
                nextItems.push(item);
            }
            const changed = setMechanicsListValue(world, variable, nextItems, context);
            if (changed && multiplayer?.getRoomCode?.() && multiplayer.isHost) publishSharedMechanicsState(world);
            return changed;
        };

        const clearPlayerList = (key, playerId) => {
            const variable = resolveListVariable(key);
            const targetPlayer = resolveLivePlayer(playerId);
            if (variable?.scope !== 'player' || !targetPlayer) return false;
            const multiplayer = getMultiplayerManager();
            if (multiplayer?.getRoomCode?.() && !multiplayer.isHost) return false;
            const context = { ...eventContext, targetPlayerId: targetPlayer.id || '__local__', player: targetPlayer };
            const items = getMechanicsPlayerListValue(world, variable, targetPlayer, context);
            if (!Array.isArray(items) || items.length === 0) return false;
            const changed = setMechanicsListValue(world, variable, [], context);
            if (changed && multiplayer?.getRoomCode?.() && multiplayer.isHost) publishSharedMechanicsState(world);
            return changed;
        };

        return {
            getContext: () => ({ ...metadata }),
            getObject,
            getObjects,
            getPlayers,
            getTilemaps,
            getTilemapCells,
            setTilemapCellBehavior,
            setObjectEnabled,
            setObjectPosition,
            setPlayerVelocity,
            getVariable: (key, requestedScope = null) => {
                const variable = resolveVariable(key, requestedScope);
                return variable ? getVariableValue(world, variable, player, eventContext) : undefined;
            },
            setVariable: (key, value, requestedScope = null) => {
                const variable = resolveVariable(key, requestedScope);
                if (!variable || !isValidVariableValue(variable, value)) return false;
                const multiplayer = getMultiplayerManager();
                if (multiplayer?.getRoomCode?.() && !multiplayer.isHost) return false;
                const changed = setVariableValue(world, variable, value, player, eventContext);
                if (changed) publishSharedMechanicsState(world);
                return true;
            },
            getPlayerVariable: (key, playerId) => {
                const variable = resolveVariable(key, 'player');
                const targetPlayer = resolveLivePlayer(playerId);
                if (!variable || !targetPlayer) return undefined;
                return getVariableValue(world, variable, targetPlayer,
                    { ...eventContext, targetPlayerId: targetPlayer.id || '__local__', player: targetPlayer });
            },
            setPlayerVariable: (key, value, playerId) => {
                const variable = resolveVariable(key, 'player');
                const targetPlayer = resolveLivePlayer(playerId);
                if (!variable || !targetPlayer || !isValidVariableValue(variable, value)) return false;
                const multiplayer = getMultiplayerManager();
                if (multiplayer?.getRoomCode?.() && !multiplayer.isHost) return false;
                const changed = setVariableValue(world, variable, value, targetPlayer,
                    { ...eventContext, targetPlayerId: targetPlayer.id || '__local__', player: targetPlayer });
                if (changed) publishSharedMechanicsState(world);
                return true;
            },
            getList,
            clearList,
            listContains,
            appendListItem: (key, value, requestedType = null) => changeList(key, value, requestedType, false),
            removeListItem: (key, value, requestedType = null) => changeList(key, value, requestedType, true),
            getPlayerList,
            clearPlayerList,
            playerListContains,
            appendPlayerListItem: (key, playerId, value, requestedType = null) =>
                changePlayerList(key, playerId, value, requestedType, false),
            removePlayerListItem: (key, playerId, value, requestedType = null) =>
                changePlayerList(key, playerId, value, requestedType, true),
            showMessage: (message, durationSeconds = 3) => {
                if (typeof message !== 'string') return false;
                const parsedDuration = Number(durationSeconds);
                const duration = Number.isFinite(parsedDuration)
                    ? Math.min(60, Math.max(0.5, parsedDuration))
                    : 3;
                showMechanicsMessage(message.slice(0, 512), duration);
                return true;
            }
        };
    };

    // Execute an event by ID
    const executeEvent = (eventId, world, player, context = {}, executionState = null) => {
        if (!eventId) return;

        const maxDepth = window.CODE_MAX_EVENT_DEPTH || 16;
        const maxChainActions = window.CODE_MAX_EVENT_CHAIN_ACTIONS || 256;
        const state = executionState || { stack: [], totalActions: 0, warnedActionLimit: false };
        if (!(state.suspendedEvents instanceof Set)) state.suspendedEvents = new Set();
        if (typeof state.stopEventChain !== 'boolean') state.stopEventChain = false;
        if (state.stopEventChain) return EVENT_ACTION_STOP;
        const codeData = getCodeData(world);
        const event = codeData.events.find(candidate => candidate?.id === eventId);
        if (!event || event.enabled === false) {
            const source = context.timerEvent ? 'timer Event link' : context.triggerId ? 'trigger Event link' : 'Event link';
            let origin = null;
            if (context.timerEvent && typeof context.sourceEventId === 'string') {
                origin = { id: context.sourceEventId, type: 'event', name: context.sourceEventName };
            } else if (typeof context.triggerId === 'string') {
                origin = { id: context.triggerId, type: 'trigger', name: context.trigger };
            } else if (typeof context.sourceEventId === 'string') {
                origin = { id: context.sourceEventId, type: 'event', name: context.sourceEventName };
            }
            const message = !event
                ? `Linked Event "${String(eventId).slice(0, 80)}" does not exist.`
                : `Linked Event "${String(event.name || eventId).slice(0, 80)}" is disabled.`;
            reportMechanicsRuntimeError(world, event || null, source, message, origin);
            return;
        }
        if (state.stack.includes(eventId) || state.suspendedEvents.has(eventId)) {
            reportMechanicsRuntimeError(world, event, 'event link',
                `Recursive Event call blocked: ${[...state.stack, eventId].join(' → ')}`);
            return;
        }
        if (state.stack.length >= maxDepth) {
            reportMechanicsRuntimeError(world, event, 'event link', `Event nesting exceeds the limit of ${maxDepth}.`);
            return;
        }

        activateWorldRuntime(world);

        const actions = Array.isArray(event.actions) ? event.actions : [];
        const maxActions = window.CODE_MAX_EVENT_ACTIONS || 128;
        if (actions.length > maxActions) {
            reportMechanicsRuntimeError(world, event, 'action limit', `This Event exceeds the ${maxActions}-action limit; extra actions were skipped.`);
        }

        let yieldedAction = null;
        const runLegacyPython = () => {
            if (context.sharedAuthoritativeReplay || !event.code || typeof runPython !== 'function') return;
            try {
                runPython(event.code, {
                    parkoreenContext: createPythonEventContext(world, event, player, context),
                    onError: (err) => {
                        reportMechanicsRuntimeError(world, event, 'Python code', err);
                    }
                });
            } catch (error) {
                reportMechanicsRuntimeError(world, event, 'Python code', error);
            }
        };

        state.stack.push(eventId);
        try {
            const limitedActions = actions.slice(0, maxActions);
            for (let actionIndex = 0; actionIndex < limitedActions.length; actionIndex++) {
                const action = limitedActions[actionIndex];
                    if (state.totalActions >= maxChainActions) {
                    if (!state.warnedActionLimit) {
                        reportMechanicsRuntimeError(world, event, 'action chain', `The ${maxChainActions}-action execution limit was reached.`);
                        state.warnedActionLimit = true;
                    }
                    break;
                }
                state.totalActions++;
                try {
                    const getNestedEventRunError = nestedEventId => {
                        if (typeof nestedEventId !== 'string' || !nestedEventId.trim()) {
                            return 'The linked Event ID is missing or invalid.';
                        }
                        const target = getCodeData(world).events.find(candidate => candidate?.id === nestedEventId);
                        if (!target) return `Linked Event "${nestedEventId}" does not exist.`;
                        if (target.enabled === false) return `Linked Event "${target.name || nestedEventId}" is disabled.`;
                        if (state.stopEventChain) return 'The Event chain has already been stopped.';
                        if (state.stack.includes(nestedEventId) || state.suspendedEvents.has(nestedEventId)) {
                            return `Recursive Event call blocked: ${[...state.stack, nestedEventId].join(' → ')}`;
                        }
                        if (state.stack.length >= maxDepth) return `Event nesting exceeds the limit of ${maxDepth}.`;
                        if (state.totalActions >= maxChainActions) return `The ${maxChainActions}-action execution limit was reached.`;
                        return null;
                    };
                    const runNestedEvent = nestedEventId => {
                        const runError = getNestedEventRunError(nestedEventId);
                        if (runError) {
                            reportMechanicsRuntimeError(world, event, 'event link', runError);
                            return;
                        }
                        return executeEvent(nestedEventId, world, player, context, state);
                    };
                    runNestedEvent.stopEventChain = () => { state.stopEventChain = true; };
                    runNestedEvent.getRunError = getNestedEventRunError;
                    runNestedEvent.canRun = nestedEventId => !getNestedEventRunError(nestedEventId);
                    runNestedEvent.forChoice = nestedEventId => executeEvent(nestedEventId, world, player, {
                        ...context,
                        mechanicsChoiceParentEventId: event.id
                    }, {
                        stack: [],
                        totalActions: state.totalActions,
                        warnedActionLimit: state.warnedActionLimit,
                        suspendedEvents: new Set(state.suspendedEvents),
                        stopEventChain: false,
                        publishOnCompletion: true
                    });
                    const actionResult = executeAction(
                        action,
                        world,
                        player,
                        context,
                        runNestedEvent,
                        event,
                        actionIndex
                    );
                    if (actionResult?.type === EVENT_ACTION_YIELD) {
                        yieldedAction = actionResult;
                        if (actionIndex < limitedActions.length - 1) {
                            reportMechanicsRuntimeError(world, event, 'action order', 'Actions after a dialogue or choice are skipped; move UI actions to the end of the Event.');
                        }
                        state.suspendedEvents.add(eventId);
                        if (!context.sharedAuthoritativeReplay && event.code && typeof runPython === 'function') {
                            actionResult.dialogue.continuations.push(runLegacyPython);
                        }
                        actionResult.dialogue.continuations.push(() => state.suspendedEvents.delete(eventId));
                        break;
                    }
                    if (actionResult === EVENT_ACTION_STOP || state.stopEventChain) {
                        state.stopEventChain = true;
                        break;
                    }
                } catch (error) {
                    reportMechanicsRuntimeError(world, event, `action ${actionIndex + 1}`, error);
                }
            }

            // A dialogue or choice action suspends the event. Legacy Python
            // resumes after dismissal or after the selected event completes.
            if (!yieldedAction && !state.stopEventChain) runLegacyPython();
        } finally {
            state.stack.pop();
            if (!executionState || (state.publishOnCompletion && state.stack.length === 0)) {
                const multiplayer = getMultiplayerManager();
                if (multiplayer?.getRoomCode?.() && !multiplayer.isHost && !context.sharedAuthoritativeReplay &&
                    context.triggerId &&
                    (context.triggerType !== CODE_TRIGGER_TYPES.PLAYER_ACTION_INPUT || context.triggerAction === 'touchOtherPlayer') &&
                    !['gameStarts', 'gameEnds', 'repeat', CODE_TRIGGER_TYPES.PLAYER_DIES, CODE_TRIGGER_TYPES.PLAYER_HEALTH_CHANGED, CODE_TRIGGER_TYPES.PLAYER_JUMPS, CODE_TRIGGER_TYPES.PLAYER_LANDS, CODE_TRIGGER_TYPES.PLAYER_RESPAWNS, CODE_TRIGGER_TYPES.PLAYER_ATTACKS_OBJECT].includes(context.triggerType) &&
                    eventUsesSharedMechanics(world, eventId)) {
                    multiplayer.requestMechanicsEvent?.(context.triggerId, eventId, context.touchedPlayerId, {
                        inputKeys: context.triggerType === CODE_TRIGGER_TYPES.PLAYER_KEY_INPUT && Array.isArray(context.inputKeys)
                            ? context.inputKeys.slice(0, window.CODE_MAX_TRIGGER_KEYS || 16)
                            : null,
                        choiceParentEventId: typeof context.mechanicsChoiceParentEventId === 'string'
                            ? context.mechanicsChoiceParentEventId : null
                    });
                } else {
                    publishSharedMechanicsState(world);
                }
            }
        }
        return state.stopEventChain ? EVENT_ACTION_STOP : yieldedAction || undefined;
    };

    const getPlayerStatValue = (stat, player) => {
        switch (stat) {
            case 'username':
                return player?.username || (player?.isLocal ? window.Auth?.getUser?.()?.username : '') || '';
            case 'displayName':
                return player?.displayName || player?.name || '';
            case 'color':
                return player?.color || '';
            case 'tag':
                return player?.tag || '';
            case 'hostOrGuest': {
                const multiplayer = getMultiplayerManager();
                const isHost = typeof player?.isHost === 'boolean'
                    ? player.isHost
                    : (multiplayer?.getRoomCode?.() ? multiplayer.isHost === true : null);
                return isHost === null ? '' : (isHost ? 'host' : 'guest');
            }
            default:
                return '';
        }
    };

    const areConfiguredTriggerKeysPressed = (keys) => {
        if (!Array.isArray(keys) || keys.length === 0 ||
            keys.length > (window.CODE_MAX_TRIGGER_KEYS || 16) ||
            keys.some(key => typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key) || key === 'other') ||
            new Set(keys).size !== keys.length) return false;
        return keys.every(key => {
            if (key === 'any' || key === 'all') return globalState.pressedKeys.size > 0;
            if (key === 'allAlphabet') {
                return [...globalState.pressedKeys].some(pressed => /^Key[A-Z]$/.test(pressed));
            }
            if (key === 'allNumbers') {
                return [...globalState.pressedKeys].some(pressed => /^Digit[0-9]$/.test(pressed));
            }
            if (key === 'allAlphanumeric') {
                return [...globalState.pressedKeys].some(pressed => /^(Key[A-Z]|Digit[0-9])$/.test(pressed));
            }
            return globalState.pressedKeys.has(key);
        });
    };

    // Check if trigger should fire
    const evaluateTrigger = (trigger, world, player, data) => {
        if (!trigger) return false;

        // Keep edge state current while disabled so re-enabling a trigger does
        // not mistake an existing condition, held key, or contact for a new edge.
        if (!isMechanicsTriggerEnabled(world, trigger)) {
            if ([CODE_TRIGGER_TYPES.PLAYER_TOUCH_OBJECT, CODE_TRIGGER_TYPES.PLAYER_LEAVE_OBJECT].includes(trigger.triggerType)) {
                const state = getTriggerState(getPlayerState(player, world), trigger);
                const touchedObject = findTouchingMechanicsObject(world, trigger.config?.objectId, player, trigger.config?.shape);
                state.wasTouchingObject = Boolean(touchedObject);
                if (touchedObject) state.lastTouchedObjectId = touchedObject.id;
            } else if (trigger.triggerType === CODE_TRIGGER_TYPES.PLAYER_TOUCH_TILEMAP) {
                const state = getTriggerState(getPlayerState(player, world), trigger);
                state.wasTouchingTilemap = Boolean(findTouchingTilemapCell(
                    world, trigger.config?.tilemapId, trigger.config?.collisionType || 'any', player
                ));
            } else if (trigger.triggerType === CODE_TRIGGER_TYPES.PLAYER_HEALTH_CHANGED && Number.isFinite(player?.hp)) {
                getTriggerState(getPlayerState(player, world), trigger).previousHealth = player.hp;
            } else if (trigger.triggerType === CODE_TRIGGER_TYPES.PLAYER_KEY_INPUT) {
                getTriggerState(getPlayerState(player, world), trigger).keysWerePressed =
                    areConfiguredTriggerKeysPressed(trigger.config?.keys);
            } else if (trigger.triggerType === CODE_TRIGGER_TYPES.PLAYER_STATS) {
                const config = trigger.config || {};
                const validStat = CODE_PLAYER_STATS.some(item => item.id === config.stat) &&
                    typeof config.statValue === 'string' && config.statValue.trim() &&
                    config.statValue.length <= (window.CODE_MAX_PLAYER_STAT_VALUE_LENGTH || 128);
                const matches = Boolean(validStat && player &&
                    String(getPlayerStatValue(config.stat, player)).toLowerCase() === String(config.statValue).toLowerCase());
                getTriggerState(getPlayerState(player, world), trigger).wasMatching = matches;
            } else if (trigger.triggerType === CODE_TRIGGER_TYPES.VARIABLE_CONDITION) {
                const variable = getVariable(world, trigger.config?.variableId);
                const conditionState = variable?.scope === 'player'
                    ? getTriggerState(getPlayerState(player, world), trigger)
                    : getWorldTriggerState(world, trigger);
                conditionState.wasMatching = evaluateVariableCondition(
                    world, trigger.config?.variableId, trigger.config?.operator, trigger.config?.value, player
                );
            } else if (trigger.triggerType === CODE_TRIGGER_TYPES.PLAYER_ACTION_INPUT) {
                const action = trigger.config?.action;
                const actionState = getTriggerState(getPlayerState(player, world), trigger);
                if (typeof action === 'string' && action.startsWith('pluginControl:')) {
                    const controlId = action.slice('pluginControl:'.length);
                    actionState.wasPluginControlPressed = player?.input?.[controlId] === true;
                } else if (action === 'die') {
                    actionState.wasDead = data?.died === true || player?.isDead === true;
                } else if (action === 'fall') {
                    const falling = Number(player?.vy) > 0 && !player?.isOnGround && !player?.grounded;
                    actionState.wasFalling = falling;
                } else if (action === 'fallForTime') {
                    actionState.fallStartTime = null;
                    actionState.fallTimeFired = false;
                } else if (action === 'fallForDistance') {
                    actionState.fallStartY = null;
                    actionState.fallDistanceFired = false;
                } else if (action === 'doJumpForTime') {
                    actionState.jumpStartTime = null;
                    actionState.jumpTimeFired = false;
                } else if (action === 'teleport') {
                    actionState.lastTeleportSerial = Number(player?._mechanicsTeleportSerial) || 0;
                    actionState.wasExternalTeleport = data?.teleported === true;
                } else if (action === 'touchOtherPlayer') {
                    actionState.wasTouchingPlayer = data?.touchedPlayer === true;
                }
            }
            return false;
        }

        const config = trigger.config || {};
        const playerState = getPlayerState(player, world);

        try {
            switch (trigger.triggerType) {
                case CODE_TRIGGER_TYPES.GAME_STARTS:
                    // Each start trigger fires once per world session.
                    const gameStartState = getWorldTriggerState(world, trigger);
                    if (getWorldState(world)?.gameStarted && !gameStartState.fired) {
                        gameStartState.fired = true;
                        return true;
                    }
                    return false;

                case CODE_TRIGGER_TYPES.PLAYER_ENTER_ZONE:
                    if (typeof config.zoneName !== 'string' || !config.zoneName.trim()) {
                        reportTriggerTargetError(world, trigger, 'Player Enter Zone needs a named zone.');
                        return false;
                    }
                    const enterZone = findZone(world, config.zoneName);
                    if (!enterZone) {
                        reportTriggerTargetError(world, trigger, `Player Enter Zone cannot find an enabled zone named “${config.zoneName}”.`);
                        return false;
                    }
                    clearTriggerTargetError(world, trigger);
                    return playerState.currentZones.has(config.zoneName) &&
                           !playerState.previousZones.has(config.zoneName);

                case CODE_TRIGGER_TYPES.PLAYER_LEAVE_ZONE:
                    if (typeof config.zoneName !== 'string' || !config.zoneName.trim()) {
                        reportTriggerTargetError(world, trigger, 'Player Leave Zone needs a named zone.');
                        return false;
                    }
                    const leaveZone = findZone(world, config.zoneName);
                    if (!leaveZone) {
                        reportTriggerTargetError(world, trigger, `Player Leave Zone cannot find an enabled zone named “${config.zoneName}”.`);
                        return false;
                    }
                    clearTriggerTargetError(world, trigger);
                    return !playerState.currentZones.has(config.zoneName) &&
                           playerState.previousZones.has(config.zoneName);

                case CODE_TRIGGER_TYPES.PLAYER_TOUCH_OBJECT: {
                    const object = typeof config.objectId === 'string' ? world?.getObjectById?.(config.objectId) : null;
                    if (!object) {
                        reportTriggerTargetError(world, trigger, 'Player Touches Object needs an existing map object.');
                        return false;
                    }
                    clearTriggerTargetError(world, trigger);
                    const touchState = getTriggerState(playerState, trigger);
                    const touchedObject = findTouchingMechanicsObject(world, config.objectId, player, config.shape);
                    const touching = Boolean(touchedObject);
                    const justTouched = touching && !touchState.wasTouchingObject;
                    touchState.wasTouchingObject = touching;
                    if (touchedObject) touchState.lastTouchedObjectId = touchedObject.id;
                    return justTouched;
                }

                case CODE_TRIGGER_TYPES.PLAYER_LEAVE_OBJECT: {
                    const object = typeof config.objectId === 'string' ? world?.getObjectById?.(config.objectId) : null;
                    if (!object) {
                        reportTriggerTargetError(world, trigger, 'Player Leaves Object needs an existing map object.');
                        return false;
                    }
                    clearTriggerTargetError(world, trigger);
                    const touchState = getTriggerState(playerState, trigger);
                    const touchedObject = findTouchingMechanicsObject(world, config.objectId, player, config.shape);
                    const wasTouching = touchState.wasTouchingObject === true;
                    touchState.wasTouchingObject = Boolean(touchedObject);
                    if (touchedObject) touchState.lastTouchedObjectId = touchedObject.id;
                    if (!wasTouching || touchedObject) return false;
                    touchState.leftObjectId = touchState.lastTouchedObjectId || config.objectId;
                    return true;
                }

                case CODE_TRIGGER_TYPES.PLAYER_TOUCH_TILEMAP: {
                    const tilemap = (world?.tilemaps || []).find(candidate => candidate?.id === config.tilemapId);
                    if (!tilemap) {
                        reportTriggerTargetError(world, trigger, 'Player Touches Tilemap needs an existing tilemap layer.');
                        return false;
                    }
                    clearTriggerTargetError(world, trigger);
                    const touchState = getTriggerState(playerState, trigger);
                    const touching = Boolean(findTouchingTilemapCell(
                        world, config.tilemapId, config.collisionType || 'any', player
                    ));
                    const justTouched = touching && !touchState.wasTouchingTilemap;
                    touchState.wasTouchingTilemap = touching;
                    return justTouched;
                }

                case CODE_TRIGGER_TYPES.REPEAT:
                    const interval = config.interval === undefined ? 1 : Number(config.interval);
                    const unit = config.unit || 'seconds';
                    if (!Number.isFinite(interval) || interval < 1 ||
                        !CODE_TIME_UNITS.some(item => item.id === unit)) return false;
                    const now = Date.now();
                    const repeatState = getWorldTriggerState(world, trigger);
                    const lastExec = repeatState.lastExecutedAt || 0;

                    let intervalMs;
                    switch (unit) {
                        case 'ticks':
                            intervalMs = interval * (1000 / 60); // ~16.67ms per tick at 60fps
                            break;
                        case 'minutes':
                            intervalMs = interval * 60000;
                            break;
                        case 'seconds':
                            intervalMs = interval * 1000;
                            break;
                        default:
                            return false;
                    }
                    if (!Number.isFinite(intervalMs) ||
                        intervalMs > (window.CODE_MAX_TIMER_DELAY_SECONDS || 86400) * 1000) return false;

                    // First run after game starts: use a small delay to avoid immediate fire
                    if (lastExec === 0) {
                        repeatState.lastExecutedAt = now;
                        return false;
                    }

                    if (now - lastExec >= intervalMs) {
                        repeatState.lastExecutedAt = now;
                        return true;
                    }
                    return false;

                case CODE_TRIGGER_TYPES.PLAYER_KEY_INPUT:
                    if (!Array.isArray(config.keys) || config.keys.length === 0 ||
                        config.keys.length > (window.CODE_MAX_TRIGGER_KEYS || 16) ||
                        config.keys.some(key => typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key) || key === 'other') ||
                        new Set(config.keys).size !== config.keys.length) return false;
                    const keyTriggerState = getTriggerState(playerState, trigger);
                    const allKeysPressed = areConfiguredTriggerKeysPressed(config.keys);

                    // Fire on the rising edge of the full combination, including
                    // keyboard and mouse buttons, then wait for release to re-arm.
                    const keyComboJustPressed = allKeysPressed && !keyTriggerState.keysWerePressed;
                    keyTriggerState.keysWerePressed = allKeysPressed;
                    return keyComboJustPressed;

                case CODE_TRIGGER_TYPES.PLAYER_ACTION_INPUT:
                    const action = config.action;
                    if (!action) return false;
                    if (action.startsWith('pluginControl:')) {
                        const controlId = action.slice('pluginControl:'.length);
                        const controlExists = getPluginManager()?.getMechanicsActionControls?.()
                            ?.some(control => control.id === controlId) === true;
                        const pluginControlState = getTriggerState(playerState, trigger);
                        const pressed = controlExists && player?.input?.[controlId] === true;
                        const justPressed = pressed && !pluginControlState.wasPluginControlPressed;
                        pluginControlState.wasPluginControlPressed = pressed;
                        return justPressed;
                    }
                    const actionDefinition = CODE_PLAYER_ACTIONS.find(item => item.id === action);
                    if (!actionDefinition) return false;
                    const actionValue = config.actionValue === undefined ? actionDefinition.defaultValue : config.actionValue;
                    if (actionDefinition.hasValue &&
                        (!isFiniteMechanicsNumber(actionValue) || Number(actionValue) <= 0)) return false;
                    const triggerState = getTriggerState(playerState, trigger);

                    switch (action) {
                        case 'jump':
                            return playerState.justJumped === true;
                        case 'groundJump':
                            return playerState.justJumped === true && playerState.lastJumpWasGrounded === true;
                        case 'airJump':
                            return playerState.justJumped === true && playerState.lastJumpWasGrounded === false;
                        case 'die':
                            {
                                const isDead = data?.died === true || player?.isDead === true;
                                const justDied = isDead && !triggerState.wasDead;
                                triggerState.wasDead = isDead;
                                return justDied;
                            }
                        case 'fall':
                            // Fire once when player starts falling
                            if (player?.vy > 0 && !triggerState.wasFalling) {
                                triggerState.wasFalling = true;
                                return true;
                            }
                            if (player?.vy <= 0 || player?.isOnGround || player?.grounded) {
                                triggerState.wasFalling = false;
                            }
                            return false;
                        case 'fallForTime':
                            if (player?.vy > 0 && !player.isOnGround && !player.grounded) {
                                if (triggerState.fallStartTime == null) {
                                    triggerState.fallStartTime = Date.now();
                                    triggerState.fallTimeFired = false;
                                }
                                const fallTime = (Date.now() - triggerState.fallStartTime) / 1000;
                                const targetTime = Number(actionValue);
                                if (!triggerState.fallTimeFired && fallTime >= targetTime) {
                                    triggerState.fallTimeFired = true;
                                    return true;
                                }
                                return false;
                            }
                            triggerState.fallStartTime = null;
                            triggerState.fallTimeFired = false;
                            return false;
                        case 'fallForDistance':
                            if (player?.vy > 0 && !player.isOnGround && !player.grounded) {
                                if (triggerState.fallStartY == null) {
                                    triggerState.fallStartY = player.y;
                                    triggerState.fallDistanceFired = false;
                                }
                                const fallDistance = player.y - triggerState.fallStartY;
                                const targetDistance = Number(actionValue);
                                if (!triggerState.fallDistanceFired && fallDistance >= targetDistance) {
                                    triggerState.fallDistanceFired = true;
                                    return true;
                                }
                                return false;
                            }
                            triggerState.fallStartY = null;
                            triggerState.fallDistanceFired = false;
                            return false;
                        case 'doJumpForTime':
                            if (player?.input?.jump && !player?.isOnGround && !player?.grounded) {
                                if (triggerState.jumpStartTime == null) {
                                    triggerState.jumpStartTime = Date.now();
                                    triggerState.jumpTimeFired = false;
                                }
                                const heldSeconds = (Date.now() - triggerState.jumpStartTime) / 1000;
                                const targetSeconds = Number(actionValue);
                                if (!triggerState.jumpTimeFired && heldSeconds >= targetSeconds) {
                                    triggerState.jumpTimeFired = true;
                                    return true;
                                }
                                return false;
                            }
                            triggerState.jumpStartTime = null;
                            triggerState.jumpTimeFired = false;
                            return false;
                        case 'move':
                            return (player?.vx !== 0 || player?.vy !== 0);
                        case 'moveHorizontally':
                            return player?.vx !== 0;
                        case 'moveLeft':
                            return player?.vx < 0;
                        case 'moveRight':
                            return player?.vx > 0;
                        case 'teleport':
                            {
                                const serial = Number(player?._mechanicsTeleportSerial) || 0;
                                const serialChanged = serial > (triggerState.lastTeleportSerial || 0);
                                triggerState.lastTeleportSerial = serial;
                                const externalSignal = data?.teleported === true && !triggerState.wasExternalTeleport;
                                triggerState.wasExternalTeleport = data?.teleported === true;
                                return serialChanged || externalSignal;
                            }
                        case 'touchOtherPlayer':
                            {
                                const touchingPlayer = data?.touchedPlayer === true;
                                const justTouched = touchingPlayer && !triggerState.wasTouchingPlayer;
                                triggerState.wasTouchingPlayer = touchingPlayer;
                                return justTouched;
                            }
                        default:
                            return false;
                    }

                case CODE_TRIGGER_TYPES.PLAYER_STATS:
                    // These require comparing player properties
                    const stat = config.stat;
                    const statValue = config.statValue;
                    if (!CODE_PLAYER_STATS.some(item => item.id === stat) ||
                        typeof statValue !== 'string' || !statValue.trim() ||
                        statValue.length > (window.CODE_MAX_PLAYER_STAT_VALUE_LENGTH || 128) || !player) return false;
                    if (stat === 'hostOrGuest' && !['host', 'guest'].includes(statValue.toLowerCase())) return false;

                    const statsTriggerState = getTriggerState(playerState, trigger);
                    const statsMatch = String(getPlayerStatValue(stat, player)).toLowerCase() === String(statValue).toLowerCase();
                    const statsJustMatched = statsMatch && !statsTriggerState.wasMatching;
                    statsTriggerState.wasMatching = statsMatch;
                    return statsJustMatched;

                case CODE_TRIGGER_TYPES.PLAYER_HEALTH_CHANGED: {
                    const health = player?.hp;
                    const direction = config.direction || 'any';
                    if (!Number.isFinite(health) || !['any', 'increased', 'decreased'].includes(direction)) return false;
                    const healthTriggerState = getTriggerState(playerState, trigger);
                    const previousHealth = healthTriggerState.previousHealth;
                    healthTriggerState.previousHealth = health;
                    if (!Number.isFinite(previousHealth) || previousHealth === health) return false;
                    const delta = health - previousHealth;
                    healthTriggerState.healthBefore = previousHealth;
                    healthTriggerState.healthAfter = health;
                    healthTriggerState.healthDelta = delta;
                    return direction === 'any' || (direction === 'increased' && delta > 0) || (direction === 'decreased' && delta < 0);
                }

                case CODE_TRIGGER_TYPES.VARIABLE_CONDITION: {
                    const variable = getVariable(world, config.variableId);
                    const conditionState = variable?.scope === 'player'
                        ? getTriggerState(playerState, trigger)
                        : getWorldTriggerState(world, trigger);
                    const matches = evaluateVariableCondition(world, config.variableId, config.operator, config.value, player);
                    const justMatched = matches && !conditionState.wasMatching;
                    conditionState.wasMatching = matches;
                    return justMatched;
                }

                case CODE_TRIGGER_TYPES.PLAYER_PRESS_BUTTON:
                    // Handled directly via button.pressed hook (event-based)
                    return false;

                default:
                    return false;
            }
        } catch (error) {
            console.warn(`[Code Plugin] Error evaluating trigger "${trigger.name}":`, error);
            return false;
        }
    };

    // Reset game state (call when game restarts)
    const resetGameState = (options = {}) => {
        clearMechanicsDialogues();
        clearMechanicsListPanels();
        const world = options?.world && typeof options.world === 'object' ? options.world : globalState.activeWorld;
        const preserveTriggerState = options?.preserveTriggerState === true;
        let preservedTriggerState = null;
        if (world) {
            const gravityChanged = Number.isFinite(world._mechanicsGravity);
            const jumpForceChanged = Number.isFinite(world._mechanicsJumpForce);
            const playerSpeedChanged = Number.isFinite(world._mechanicsPlayerSpeed);
            const movementControlChanged = Number.isFinite(world._mechanicsHorizontalAcceleration) ||
                Number.isFinite(world._mechanicsAirControl) || Number.isFinite(world._mechanicsTerminalFallSpeed);
            const layerVisibilityChanged = world?._mechanicsLayerVisibility instanceof Map && world._mechanicsLayerVisibility.size > 0;
            let objectDrawLayersChanged = false;
            for (const object of world.objects || []) {
                objectDrawLayersChanged = world.resetMechanicsObjectDrawLayer?.(object.id) === true || objectDrawLayersChanged;
            }
            delete world._mechanicsCameraFollowMode;
            delete world._mechanicsCameraBounds;
            delete world._mechanicsGravity;
            delete world._mechanicsJumpForce;
            delete world._mechanicsPlayerSpeed;
            delete world._mechanicsHorizontalAcceleration;
            delete world._mechanicsAirControl;
            delete world._mechanicsTerminalFallSpeed;
            delete world._mechanicsLayerVisibility;
            clearWorldTimers(world);
            const spawned = (world.objects || []).filter(object => object?._mechanicsSpawned === true);
            for (const object of spawned) world.removeObject?.(object.id);
            const state = getWorldState(world);
            const hadTriggerOverrides = state.triggerEnabled.size > 0;
            if (preserveTriggerState && hadTriggerOverrides) {
                preservedTriggerState = new Map(state.triggerEnabled);
            } else if (!preserveTriggerState && hadTriggerOverrides) {
                state.triggerEnabled.clear();
            }
            let tilemapCellsRestored = false;
            for (const cellId of [...state.tilemapCellOriginals.keys()]) {
                tilemapCellsRestored = restoreMechanicsTilemapCell(world, state, cellId, true) || tilemapCellsRestored;
            }
            const triggersChanged = hadTriggerOverrides && !preserveTriggerState;
            if (spawned.length || tilemapCellsRestored || triggersChanged || gravityChanged || jumpForceChanged || playerSpeedChanged || movementControlChanged || layerVisibilityChanged || objectDrawLayersChanged) {
                state.sharedMechanicsDirty = true;
                state.lastSharedMechanicsState = undefined;
                publishSharedMechanicsState(world);
            }
        }
        globalState.activeWorld = null;
        globalState.worldStates = new WeakMap();
        if (preservedTriggerState?.size) {
            const freshState = createWorldState();
            freshState.triggerEnabled = preservedTriggerState;
            globalState.worldStates.set(world, freshState);
        }
        globalState.pressedKeys.clear();
        globalState.keyJustPressed.clear();
    };

    // Register hooks
    const pm = getPluginManager();
    if (pm) {
        // Draw a compact, screen-stable health bar above Mechanics objects.
        // render.player is called once for the local player after scene scaling,
        // which gives us the active camera transform without duplicating bars.
        pm.registerHook('render.player', (data) => {
            const { ctx, player, camera, world } = data || {};
            if (!ctx || !player || !camera || !world || player !== window.engine?.localPlayer) return data;
            const worldState = getWorldState(world);
            if (!worldState?.objectHealth?.size) return data;

            const zoom = Number.isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1;
            const barHeight = 5 / zoom;
            const gap = 7 / zoom;
            const inset = 1 / zoom;
            const cameraRight = camera.width / zoom;
            const cameraBottom = camera.height / zoom;
            ctx.save();
            ctx.lineWidth = 1 / zoom;
            for (const [objectId, health] of worldState.objectHealth) {
                if (!health || health.current <= 0 || health.maximum < 1) continue;
                const object = world.getObjectById?.(objectId);
                if (!object || object._mechanicsEnabled === false || object._collected === true) continue;
                const width = Number.isFinite(object.width) && object.width > 0 ? object.width : 32;
                const height = Number.isFinite(object.height) && object.height > 0 ? object.height : 32;
                const screenWidth = Math.max(28, Math.min(72, width * zoom)) / zoom;
                const left = object.x + width / 2 - screenWidth / 2 - camera.x;
                const top = object.y - camera.y - gap - barHeight;
                if (left + screenWidth < 0 || left > cameraRight || top + barHeight < 0 || top > cameraBottom) continue;

                ctx.fillStyle = 'rgba(8, 12, 20, 0.88)';
                ctx.fillRect(left, top, screenWidth, barHeight);
                ctx.fillStyle = health.current / health.maximum > 0.5 ? '#70e29a' : '#ff6969';
                ctx.fillRect(left + inset, top + inset,
                    Math.max(0, (screenWidth - 2 * inset) * health.current / health.maximum),
                    Math.max(0, barHeight - 2 * inset));
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
                ctx.strokeRect(left, top, screenWidth, barHeight);
            }
            ctx.restore();
            return data;
        });

        // Player update hook - track zones and evaluate triggers
        pm.registerHook('player.update', (data) => {
            if (!isEnabled()) return data;

            const { player, world } = data;
            if (!player || !world) return data;

            activateWorldRuntime(world);
            if (player._mechanicsDialogueOpen) {
                const dialoguePlayerState = getPlayerState(player, world);
                dialoguePlayerState.justJumped = false;
                globalState.keyJustPressed.clear();
                if (player.input && typeof player.input === 'object') {
                    for (const key of Object.keys(player.input)) player.input[key] = false;
                }
                player.vx = 0;
                player.vy = 0;
                data.skipPhysics = true;
                return data;
            }
            const playerState = getPlayerState(player, world);

            // Mark this map session as started on its first player update.
            const worldState = getWorldState(world);
            updateObjectMotions(world);
            cleanupExpiredSpawnedObjects(world);
            const multiplayer = getMultiplayerManager();
            if (!multiplayer?.getRoomCode?.() || multiplayer.isHost) {
                const now = Date.now();
                const completedAnimations = [];
                for (const object of (world.objects || []).slice()) {
                    const animation = object?._mechanicsSpriteAnimation;
                    if (!animation || animation.loop || animation.completionEventFired === true ||
                        typeof animation.completionEventId !== 'string' || !animation.completionEventId ||
                        !Number.isFinite(animation.startedAt) || !Number.isFinite(animation.fps) || !Number.isSafeInteger(animation.frameCount)) continue;
                    const elapsedFrames = Math.floor(Math.max(0, now - animation.startedAt) / 1000 * animation.fps);
                    if (elapsedFrames < animation.frameCount) continue;
                    animation.completionEventFired = true;
                    completedAnimations.push({ object, animation });
                }
                if (completedAnimations.length) worldState.sharedMechanicsDirty = true;
                for (const { object, animation } of completedAnimations) {
                    executeEvent(animation.completionEventId, world, player, {
                        sourceEventId: animation.sourceEventId || '',
                        sourceEventName: animation.sourceEventName || '',
                        animationObjectId: object.id || '',
                        animationObjectName: object.name || object.displayName || object.appearanceType || ''
                    });
                    if (window.engine?.world !== world) break;
                }
            }
            if (worldState && !worldState.gameStarted) {
                worldState.gameStarted = true;
                // The session is live; Game Starts triggers are evaluated below.
            }

            // Store previous zone state
            playerState.previousZones = new Set(playerState.currentZones);
            playerState.currentZones.clear();

            // Check which zones player is currently in
            const zones = getZones(world);
            for (const zone of zones) {
                if (isPlayerInZone(player, zone)) {
                    playerState.currentZones.add(zone.zoneName);
                }
            }

            // Track fall state
            if (player.vy > 0 && !player.isOnGround && !player.grounded) {
                if (!playerState.isFalling) {
                    playerState.isFalling = true;
                    playerState.fallStartY = player.y;
                    playerState.fallStartTime = Date.now();
                }
            } else if (player.isOnGround || player.grounded || player.vy <= 0) {
                playerState.isFalling = false;
                playerState.fallStartY = null;
                playerState.fallStartTime = null;
            }

            // Player-to-player contact is an edge trigger, so touching someone
            // continuously does not run the linked event every frame.
            const engine = typeof window !== 'undefined' ? window.engine : null;
            const otherPlayers = engine?.remotePlayers ? Array.from(engine.remotePlayers.values()) : [];
            const playerRight = player.x + (player.width || 24);
            const playerBottom = player.y + (player.height || 24);
            const touchedPlayer = otherPlayers.find(other =>
                other && !other.isDead &&
                player.x < other.x + (other.width || 24) &&
                playerRight > other.x &&
                player.y < other.y + (other.height || 24) &&
                playerBottom > other.y
            );
            data.touchedPlayer = Boolean(touchedPlayer);
            data.touchedPlayerId = touchedPlayer?.id || null;
            // Evaluate all triggers
            const codeData = getCodeData(world);
            for (const trigger of codeData.triggers || []) {
                try {
                    if (evaluateTrigger(trigger, world, player, data)) {
                        // Execute linked event if any (fall back to old actionId for backward compatibility)
                        const linkedEventId = trigger.config?.eventId || trigger.config?.actionId;
                        if (linkedEventId) {
                            const touchedObject = trigger.triggerType === CODE_TRIGGER_TYPES.PLAYER_TOUCH_OBJECT
                                ? findTouchingMechanicsObject(world, trigger.config?.objectId, player, trigger.config?.shape)
                                : trigger.triggerType === CODE_TRIGGER_TYPES.PLAYER_LEAVE_OBJECT
                                    ? world?.getObjectById?.(getTriggerState(getPlayerState(player, world), trigger).leftObjectId)
                                : trigger.triggerType === CODE_TRIGGER_TYPES.PLAYER_TOUCH_TILEMAP
                                    ? findTouchingTilemapCell(world, trigger.config?.tilemapId, trigger.config?.collisionType || 'any', player)
                                    : null;
                            const healthTriggerState = trigger.triggerType === CODE_TRIGGER_TYPES.PLAYER_HEALTH_CHANGED
                                ? getTriggerState(getPlayerState(player, world), trigger)
                                : null;
                            executeEvent(linkedEventId, world, player, {
                                triggerId: trigger.id,
                                trigger: trigger.name,
                                triggerType: trigger.triggerType,
                                triggerAction: trigger.triggerType === CODE_TRIGGER_TYPES.PLAYER_ACTION_INPUT ? trigger.config?.action : null,
                                audioManager: data.audioManager,
                                touchedPlayerId: data.touchedPlayerId || null,
                                touchedObjectId: touchedObject?.id || null,
                                touchedObjectName: touchedObject?.name || touchedObject?.displayName || touchedObject?.appearanceType || null,
                                inputKeys: trigger.triggerType === CODE_TRIGGER_TYPES.PLAYER_KEY_INPUT
                                    ? Array.from(globalState.pressedKeys).slice(0, window.CODE_MAX_TRIGGER_KEYS || 16)
                                    : null,
                                healthBefore: healthTriggerState?.healthBefore ?? null,
                                healthAfter: healthTriggerState?.healthAfter ?? null,
                                healthDelta: healthTriggerState?.healthDelta ?? null
                            });
                        }
                    }
                } catch (error) {
                    console.warn(`[Code Plugin] Error processing trigger "${trigger.name}":`, error);
                }
            }

            if (player._mechanicsListPanel) renderMechanicsListPanel(player._mechanicsListPanel);

            if (player._mechanicsDialogueOpen) {
                if (player.input && typeof player.input === 'object') {
                    for (const key of Object.keys(player.input)) player.input[key] = false;
                }
                player.vx = 0;
                player.vy = 0;
                data.skipPhysics = true;
            }

            publishSharedMechanicsState(world);

            // Consume jump edges after every trigger has seen this update.
            playerState.justJumped = false;

            // Clear just-pressed keys after processing
            globalState.keyJustPressed.clear();

            return data;
        });

        // Player jump hook - track jump events
        pm.registerHook('player.jumped', (data) => {
            if (!isEnabled()) return data;

            const { player, world } = data;
            if (!player || !world) return data;

            const playerState = getPlayerState(player, world);

            playerState.lastJumpWasGrounded = data.wasGrounded === true;
            playerState.justJumped = true;

            const jumpWasGrounded = data.wasGrounded === true;
            const jumpSource = data.source === 'plugin' ? 'plugin' : 'core';
            const fireJumpTriggers = () => {
                if (globalState.activeWorld !== world) return;
                const triggers = getCodeData(world).triggers.filter(trigger =>
                    trigger?.triggerType === CODE_TRIGGER_TYPES.PLAYER_JUMPS
                );
                for (const trigger of triggers) {
                    if (!isMechanicsTriggerEnabled(world, trigger)) continue;
                    const eventId = trigger.config?.eventId || trigger.config?.actionId;
                    if (!eventId) continue;
                    executeEvent(eventId, world, player, {
                        triggerId: trigger.id,
                        trigger: trigger.name,
                        triggerType: trigger.triggerType,
                        sourcePlayerId: player.id || null,
                        targetPlayerId: player.id || null,
                        jumpWasGrounded,
                        jumpSource
                    });
                }
            };
            if (typeof queueMicrotask === 'function') queueMicrotask(fireJumpTriggers);
            else Promise.resolve().then(fireJumpTriggers);

            return data;
        });

        pm.registerHook('player.attack.hit', (data) => {
            if (!isEnabled()) return data;
            const { player, world, object } = data || {};
            if (!player || !world || !object || object._mechanicsEnabled === false || object._collected === true) return data;
            activateWorldRuntime(world);
            const objectId = object.id;
            for (const trigger of getCodeData(world).triggers) {
                if (!isMechanicsTriggerEnabled(world, trigger) || trigger?.triggerType !== CODE_TRIGGER_TYPES.PLAYER_ATTACKS_OBJECT) continue;
                if (trigger.config?.objectId !== objectId && object._mechanicsSpawnTemplateId !== trigger.config?.objectId) continue;
                const eventId = trigger.config?.eventId || trigger.config?.actionId;
                if (!eventId) continue;
                executeEvent(eventId, world, player, {
                    triggerId: trigger.id,
                    trigger: trigger.name,
                    triggerType: trigger.triggerType,
                    sourcePlayerId: player.id || null,
                    targetPlayerId: player.id || null,
                    touchedObjectId: objectId || null,
                    touchedObjectName: object.name || object.displayName || object.appearanceType || null,
                    attackDirection: ['up', 'down', 'forward'].includes(data.direction) ? data.direction : 'forward'
                });
            }
            return data;
        });

        // Run completion events after cleanup, so an event can open a local
        // result message or dialogue for the completed run.
        pm.registerHook('game.ended', (data) => {
            if (!isEnabled()) return data;
            const { player, world } = data || {};
            if (!player || !world) return data;
            activateWorldRuntime(world);
            for (const trigger of getCodeData(world).triggers) {
                if (!isMechanicsTriggerEnabled(world, trigger) || trigger?.triggerType !== CODE_TRIGGER_TYPES.GAME_ENDS) continue;
                const eventId = trigger.config?.eventId || trigger.config?.actionId;
                if (!eventId) continue;
                executeEvent(eventId, world, player, {
                    triggerId: trigger.id,
                    trigger: trigger.name,
                    triggerType: trigger.triggerType,
                    sourcePlayerId: player.id || null,
                    targetPlayerId: player.id || null,
                    gameElapsedMs: data.elapsedMs,
                    wasTestMode: data.wasTestMode === true
                });
            }
            return data;
        });

        // All fatal gameplay paths converge on Player.die, so this event runs
        // once before the engine moves the player to a respawn point.
        pm.registerHook('player.died', (data) => {
            if (!isEnabled()) return data;
            const { player, world, source } = data || {};
            if (!player || !world) return data;
            const sourceId = typeof source?.id === 'string' ? source.id : null;
            const sourceName = source?.name || source?.displayName || source?.appearanceType || source?.actingType || source?.type || '';
            const sourceType = source?.appearanceType || source?.actingType || source?.type || '';
            for (const trigger of getCodeData(world).triggers) {
                if (!isMechanicsTriggerEnabled(world, trigger) || trigger?.triggerType !== CODE_TRIGGER_TYPES.PLAYER_DIES) continue;
                const eventId = trigger.config?.eventId || trigger.config?.actionId;
                if (!eventId) continue;
                executeEvent(eventId, world, player, {
                    triggerId: trigger.id,
                    trigger: trigger.name,
                    triggerType: trigger.triggerType,
                    sourcePlayerId: player.id || null,
                    targetPlayerId: player.id || null,
                    deathSourceId: sourceId,
                    deathSourceName: sourceName,
                    deathSourceType: sourceType
                });
            }
            return data;
        });

        // Run respawn mechanics after every plugin has restored its player
        // state, so events observe the final checkpoint position and HP/soul.
        pm.registerHook('player.respawn', (data) => {
            const { player, world } = data || {};
            if (!player || !world) return data;
            const fireRespawnTriggers = () => {
                if (globalState.activeWorld !== world) return;
                const currentWorld = world;
                const triggers = getCodeData(currentWorld).triggers.filter(trigger =>
                    trigger?.triggerType === CODE_TRIGGER_TYPES.PLAYER_RESPAWNS
                );
                for (const trigger of triggers) {
                    if (!isMechanicsTriggerEnabled(currentWorld, trigger)) continue;
                    const eventId = trigger.config?.eventId || trigger.config?.actionId;
                    if (!eventId) continue;
                    executeEvent(eventId, currentWorld, player, {
                        triggerId: trigger.id,
                        trigger: trigger.name,
                        triggerType: trigger.triggerType,
                        sourcePlayerId: player.id || null,
                        targetPlayerId: player.id || null
                    });
                }
            };
            if (typeof queueMicrotask === 'function') queueMicrotask(fireRespawnTriggers);
            else Promise.resolve().then(fireRespawnTriggers);
            return data;
        });

        // Run landing mechanics after collision resolution has completed. This
        // avoids changing objects or player velocity inside the physics loop.
        pm.registerHook('player.land', (data) => {
            const { player, world, surface } = data || {};
            if (!player || !world) return data;
            const surfaceObjectId = typeof surface?.id === 'string' ? surface.id : null;
            const surfaceObjectName = surface?.name || surface?.displayName || surface?.appearanceType || surface?.type || null;
            const fireLandingTriggers = () => {
                if (globalState.activeWorld !== world) return;
                const triggers = getCodeData(world).triggers.filter(trigger =>
                    trigger?.triggerType === CODE_TRIGGER_TYPES.PLAYER_LANDS
                );
                for (const trigger of triggers) {
                    if (!isMechanicsTriggerEnabled(world, trigger)) continue;
                    const eventId = trigger.config?.eventId || trigger.config?.actionId;
                    if (!eventId) continue;
                    executeEvent(eventId, world, player, {
                        triggerId: trigger.id,
                        trigger: trigger.name,
                        triggerType: trigger.triggerType,
                        sourcePlayerId: player.id || null,
                        targetPlayerId: player.id || null,
                        surfaceObjectId,
                        surfaceObjectName
                    });
                }
            };
            if (typeof queueMicrotask === 'function') queueMicrotask(fireLandingTriggers);
            else Promise.resolve().then(fireLandingTriggers);
            return data;
        });

        // Button pressed hook - fired when player clicks a button UI
        pm.registerHook('button.pressed', (data) => {
            if (!isEnabled()) return data;

            const { button, player, world } = data;
            if (!button || !player || !world) return data;

            // Evaluate button triggers immediately
            const codeData = getCodeData(world);
            const triggers = (codeData?.triggers || []).filter(t =>
                t.triggerType === CODE_TRIGGER_TYPES.PLAYER_PRESS_BUTTON
            );

            for (const trigger of triggers) {
                if (!isMechanicsTriggerEnabled(world, trigger)) continue;
                if (trigger.config?.buttonName === button.name) {
                    const linkedEventId = trigger.config?.eventId || trigger.config?.actionId;
                    if (linkedEventId) {
                        executeEvent(linkedEventId, world, player, {
                            triggerId: trigger.id,
                            trigger: trigger.name,
                            triggerType: trigger.triggerType,
                            buttonName: button.name
                        });
                    }
                }
            }

            return data;
        });

        const multiplayer = getMultiplayerManager();
        const runtimeApi = ctx?.api;
        if (multiplayer?.on) {
            const fireRoomLifecycleTriggers = (triggerType, member) => {
                if (!multiplayer.isHost || !member?.playerId) return;
                const playerId = String(member.playerId).slice(0, 128);
                const playerName = typeof member.playerName === 'string' ? member.playerName.slice(0, 128) : '';
                const playerUsername = typeof member.playerUsername === 'string' ? member.playerUsername.slice(0, 128) : '';
                const eventPlayer = { id: playerId, name: playerName, username: playerUsername };
                const triggers = getCodeData(world).triggers.filter(trigger => trigger?.triggerType === triggerType);

                for (const trigger of triggers) {
                    if (!isMechanicsTriggerEnabled(world, trigger)) continue;
                    const eventId = trigger.config?.eventId || trigger.config?.actionId;
                    if (!eventId) continue;
                    executeEvent(eventId, world, eventPlayer, {
                        triggerId: trigger.id,
                        trigger: trigger.name,
                        triggerType,
                        playerName,
                        playerUsername,
                        sourcePlayerId: playerId,
                        targetPlayerId: playerId
                    });
                }
            };

            const unsubscribePlayerJoined = multiplayer.on('playerJoined', member => {
                fireRoomLifecycleTriggers(CODE_TRIGGER_TYPES.PLAYER_JOINS_ROOM, member);
            });
            if (typeof unsubscribePlayerJoined === 'function') runtimeApi?.onCleanup?.(unsubscribePlayerJoined);

            const unsubscribeState = multiplayer.on('mechanicsState', message => {
                if (message?.state) applySharedMechanicsState(world, message.state, message.serverTimestamp);
            });
            if (typeof unsubscribeState === 'function') runtimeApi?.onCleanup?.(unsubscribeState);

            const unsubscribeRequests = multiplayer.on('mechanicsEventRequest', request => {
                if (!multiplayer.isHost || !request?.triggerId || !request?.eventId) return;
                const codeData = getCodeData(world);
                const trigger = codeData.triggers.find(item => item?.id === request.triggerId);
                const linkedEventId = trigger?.config?.eventId || trigger?.config?.actionId;
                const choiceParentEventId = typeof request.choiceParentEventId === 'string'
                    ? request.choiceParentEventId : '';
                const isRootEventRequest = linkedEventId === request.eventId && !choiceParentEventId;
                const guestRequestableTypes = [CODE_TRIGGER_TYPES.PLAYER_ENTER_ZONE, CODE_TRIGGER_TYPES.PLAYER_LEAVE_ZONE,
                    CODE_TRIGGER_TYPES.PLAYER_TOUCH_OBJECT, CODE_TRIGGER_TYPES.PLAYER_LEAVE_OBJECT, CODE_TRIGGER_TYPES.PLAYER_PRESS_BUTTON,
                    CODE_TRIGGER_TYPES.PLAYER_TOUCH_TILEMAP, CODE_TRIGGER_TYPES.PLAYER_KEY_INPUT,
                    CODE_TRIGGER_TYPES.PLAYER_ACTION_INPUT, CODE_TRIGGER_TYPES.VARIABLE_CONDITION];
                if (!trigger || !isMechanicsTriggerEnabled(world, trigger) || !guestRequestableTypes.includes(trigger.triggerType) ||
                    (trigger.triggerType === CODE_TRIGGER_TYPES.PLAYER_ACTION_INPUT && trigger.config?.action !== 'touchOtherPlayer') ||
                    (!isRootEventRequest && (!choiceParentEventId || typeof request.playerId !== 'string' || !request.playerId)) ||
                    !eventUsesSharedMechanics(world, request.eventId)) return;
                const requestedTouchObject = world.getObjectById?.(request.touchedObjectId);
                const requestedTilemapCell = world.getTilemapColliderById?.(request.touchedObjectId);
                const touchedObject = [CODE_TRIGGER_TYPES.PLAYER_TOUCH_OBJECT, CODE_TRIGGER_TYPES.PLAYER_LEAVE_OBJECT].includes(trigger.triggerType) &&
                    requestedTouchObject && requestedTouchObject._mechanicsEnabled !== false &&
                    requestedTouchObject._collected !== true && (requestedTouchObject.id === trigger.config?.objectId ||
                        (requestedTouchObject._mechanicsSpawned === true &&
                            requestedTouchObject._mechanicsSpawnTemplateId === trigger.config?.objectId))
                    ? requestedTouchObject
                    : trigger.triggerType === CODE_TRIGGER_TYPES.PLAYER_PRESS_BUTTON &&
                        requestedTouchObject?.appearanceType === 'button' &&
                        requestedTouchObject.actingType === 'button' &&
                        requestedTouchObject._mechanicsEnabled !== false &&
                        requestedTouchObject.name === trigger.config?.buttonName
                        ? requestedTouchObject
                    : trigger.triggerType === CODE_TRIGGER_TYPES.PLAYER_TOUCH_TILEMAP &&
                        requestedTilemapCell?._tilemapId === trigger.config?.tilemapId &&
                        ((trigger.config?.collisionType || 'any') === 'any' ||
                            requestedTilemapCell._tilemapCollisionType === trigger.config?.collisionType)
                        ? requestedTilemapCell : null;
                if ([CODE_TRIGGER_TYPES.PLAYER_TOUCH_OBJECT, CODE_TRIGGER_TYPES.PLAYER_LEAVE_OBJECT, CODE_TRIGGER_TYPES.PLAYER_PRESS_BUTTON,
                    CODE_TRIGGER_TYPES.PLAYER_TOUCH_TILEMAP].includes(trigger.triggerType) && !touchedObject) return;
                if (!isRootEventRequest && !consumeSharedChoiceRoute(
                    world, request.triggerId, request.playerId, choiceParentEventId, request.eventId
                )) return;
                executeEvent(request.eventId, world, { id: request.playerId, name: request.playerName }, {
                    triggerId: request.triggerId,
                    trigger: trigger.name,
                    triggerType: trigger.triggerType,
                    sourcePlayerId: request.playerId,
                    targetPlayerId: request.playerId,
                    touchedPlayerId: request.touchedPlayerId || null,
                    touchedObjectId: touchedObject?.id || null,
                    touchedObjectName: touchedObject?.name || touchedObject?.displayName || touchedObject?.appearanceType || null,
                    buttonName: trigger.triggerType === CODE_TRIGGER_TYPES.PLAYER_PRESS_BUTTON ? trigger.config?.buttonName : null,
                    sharedAuthoritativeReplay: true
                });
            });
            if (typeof unsubscribeRequests === 'function') runtimeApi?.onCleanup?.(unsubscribeRequests);

            const unsubscribeRoomPlayerLeft = multiplayer.on('playerLeft', member => {
                fireRoomLifecycleTriggers(CODE_TRIGGER_TYPES.PLAYER_LEAVES_ROOM, member);
            });
            if (typeof unsubscribeRoomPlayerLeft === 'function') runtimeApi?.onCleanup?.(unsubscribeRoomPlayerLeft);

            const unsubscribePlayerLeft = multiplayer.on('playerLeft', player => {
                if (!player?.playerId) return;
                const state = getWorldState(world);
                const removedVariables = state.playerVariables.delete(player.playerId);
                const removedLists = state.playerLists.delete(player.playerId);
                if (!removedVariables && !removedLists) return;
                if (multiplayer.isHost) {
                    state.sharedMechanicsDirty = true;
                    publishSharedMechanicsState(world);
                }
            });
            if (typeof unsubscribePlayerLeft === 'function') runtimeApi?.onCleanup?.(unsubscribePlayerLeft);

            if (multiplayer.mechanicsState) {
                applySharedMechanicsState(world, multiplayer.mechanicsState, multiplayer.mechanicsServerTimestamp);
            }
        }

        // Track key presses
        if (typeof window !== 'undefined' && !window.__parkoreenCodeInputListenersInstalled) {
            window.__parkoreenCodeInputListenersInstalled = true;
            window.addEventListener('keydown', (e) => {
                if (!globalState.pressedKeys.has(e.code)) {
                    globalState.keyJustPressed.add(e.code);
                }
                globalState.pressedKeys.add(e.code);
            });

            window.addEventListener('keyup', (e) => {
                globalState.pressedKeys.delete(e.code);
            });

            window.addEventListener('mousedown', (e) => {
                const code = `Mouse${e.button}`;
                if (!globalState.pressedKeys.has(code)) globalState.keyJustPressed.add(code);
                globalState.pressedKeys.add(code);
            });

            window.addEventListener('mouseup', (e) => {
                globalState.pressedKeys.delete(`Mouse${e.button}`);
            });

            window.addEventListener('blur', () => {
                globalState.pressedKeys.clear();
                globalState.keyJustPressed.clear();
            });
        }
    }

    // Expose reset function for testing/debugging
    if (typeof window !== 'undefined') {
        window.CodePluginReset = resetGameState;
        window.CodePluginRestoreMechanicsObjectStates = restorePersistentMechanicsObjectStates;
        window.CodePluginGetRuntimeErrors = world => {
            const mapId = typeof world?.mechanicsSaveId === 'string' ? world.mechanicsSaveId : '';
            return globalState.runtimeErrors
                .filter(entry => entry.mapId === mapId)
                .slice(-20)
                .map(entry => ({ ...entry }));
        };
        window.CodePluginClearRuntimeErrors = world => {
            const mapId = typeof world?.mechanicsSaveId === 'string' ? world.mechanicsSaveId : '';
            globalState.runtimeErrors = globalState.runtimeErrors.filter(entry => entry.mapId !== mapId);
        };
    }
})(typeof ctx !== 'undefined' ? ctx : null);
