import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workerSource = await readFile(new URL('../cloudflare-worker/worker.js', import.meta.url), 'utf8');
const workerModule = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`);
const { GameRoom } = workerModule;

const makeRoom = (codeData, objects = [], tilemaps = []) => {
    const messages = [];
    const storedMechanics = new Map();
    const guest = { id: 'guest-session', roomCode: 'ROOM1', isHost: false, user: { name: 'Guest' } };
    const host = { id: 'host-session', roomCode: 'ROOM1', isHost: true, userId: 'host-user' };
    const room = new GameRoom({ storage: {
        get: async key => key === 'room:ROOM1'
            ? JSON.stringify({ hostUserId: 'host-user', mapData: { codeData, objects, tilemaps } })
            : storedMechanics.get(key) || null,
        put: async (key, value) => storedMechanics.set(key, value)
    } }, {});
    room.getPlayersInRoom = () => [host, guest];
    room.send = (session, message) => messages.push({ session, message });
    room.broadcastToRoom = () => {};
    room.sessions.set(host.id, host);
    room.sessions.set(guest.id, guest);
    return { room, guest, host, messages, storedMechanics };
};

test('room worker forwards a legacy event when other canonical events exist', async () => {
    const { room, guest, host, messages, storedMechanics } = makeRoom({
        triggers: [{ id: 'trigger-1', triggerType: 'playerKeyInput', enabled: true,
            config: { eventId: 'legacy-event', keys: ['KeyA'] } }],
        events: [{ id: 'current-event', enabled: true }],
        actions: [{ id: 'legacy-event', enabled: true }]
    });

    await room.handleMechanicsEventRequest(guest, {
        triggerId: 'trigger-1', eventId: 'legacy-event', inputKeys: ['KeyA']
    });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].session, host);
    assert.equal(messages[0].message.eventId, 'legacy-event');
});

test('room worker prefers canonical records when legacy IDs collide', async () => {
    const { room, guest, messages } = makeRoom({
        triggers: [{ id: 'trigger-1', enabled: true, config: { eventId: 'event-1' } }],
        events: [{ id: 'event-1', enabled: false }],
        actions: [{ id: 'event-1', enabled: true }]
    });

    await room.handleMechanicsEventRequest(guest, { triggerId: 'trigger-1', eventId: 'event-1' });

    assert.equal(messages.length, 0);
});

test('room worker checks zone entry against recent previous and current positions', async () => {
    const zone = { id: 'zone-1', appearanceType: 'zone', zoneName: 'Hideout', x: 100, y: 100, width: 100, height: 100 };
    const { room, guest, host, messages } = makeRoom({
        triggers: [{ id: 'enter-trigger', triggerType: 'playerEnterZone', enabled: true,
            config: { zoneName: 'Hideout', eventId: 'enter-event' } }],
        events: [{ id: 'enter-event', enabled: true }]
    }, [zone]);
    guest.previousPosition = { x: 0, y: 0 };
    guest.previousPositionAt = Date.now() - 40;
    guest.x = 110;
    guest.y = 110;
    guest.lastPositionAt = Date.now();

    await room.handleMechanicsEventRequest(guest, { triggerId: 'enter-trigger', eventId: 'enter-event' });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].session, host);
});

test('room worker validates and rearms Player Leaves Object contact edges', async () => {
    const object = { id: 'leave-door', x: 80, y: 80, width: 32, height: 32 };
    const { room, guest, host, messages } = makeRoom({
        triggers: [{ id: 'leave-trigger', triggerType: 'playerLeaveObject', enabled: true,
            config: { objectId: object.id, eventId: 'leave-event' } }],
        events: [{ id: 'leave-event', enabled: true }]
    }, [object]);

    guest.previousPosition = { x: 85, y: 85 };
    guest.previousPositionAt = Date.now() - 40;
    guest.x = 200;
    guest.y = 200;
    guest.lastPositionAt = Date.now();
    const eventRequests = () => messages.filter(item => item.message.type === 'mechanics_event_request');
    await room.handleMechanicsEventRequest(guest, { triggerId: 'leave-trigger', eventId: 'leave-event' });

    assert.equal(eventRequests().length, 1);
    assert.equal(eventRequests()[0].session, host);
    assert.equal(eventRequests()[0].message.touchedObjectId, object.id);

    await room.handleMechanicsEventRequest(guest, { triggerId: 'leave-trigger', eventId: 'leave-event' });
    assert.equal(eventRequests().length, 1, 'staying outside cannot repeat the edge');

    room.handlePosition(guest, { x: 85, y: 85 });
    room.handlePosition(guest, { x: 200, y: 200 });
    await room.handleMechanicsEventRequest(guest, { triggerId: 'leave-trigger', eventId: 'leave-event' });
    assert.equal(eventRequests().length, 2, 're-entering and leaving rearms the trigger');

    const originalGet = room.state.storage.get.bind(room.state.storage);
    room.state.storage.get = async key => key === 'mechanics:ROOM1'
        ? JSON.stringify({ state: { positions: { [object.id]: { x: 500, y: 500 } }, spawnedObjects: {} } })
        : originalGet(key);
    room.mechanicsObjectPositions = { [object.id]: { x: 500, y: 500 } };
    room.handlePosition(guest, { x: 510, y: 510 });
    room.handlePosition(guest, { x: 600, y: 600 });
    await room.handleMechanicsEventRequest(guest, { triggerId: 'leave-trigger', eventId: 'leave-event' });
    assert.equal(eventRequests().length, 3, 'object movement updates the contact latch bounds');
});

test('room worker validates and rearms Player Leaves Tilemap edges across matching cells', async () => {
    const cells = [
        { x: 0, y: 0, collisionType: 'solid' },
        { x: 64, y: 0, collisionType: 'solid' },
        { x: 128, y: 0, collisionType: 'hazard' }
    ];
    const { room, guest, host, messages } = makeRoom({
        triggers: [{ id: 'leave-trigger', triggerType: 'playerLeaveTilemap', enabled: true,
            config: { tilemapId: 'ground', collisionType: 'solid', eventId: 'leave-event' } }],
        events: [{ id: 'leave-event', enabled: true }]
    }, [], [{ id: 'ground', layer: 0, cells }]);
    guest.x = 8;
    guest.y = 8;
    guest.previousPosition = { x: 8, y: 8 };
    guest.previousPositionAt = Date.now() - 40;
    guest.lastPositionAt = Date.now();

    // The 32 px player body reaches the next matching cell across a gap.
    guest.x = 40;
    await room.handleMechanicsEventRequest(guest, {
        triggerId: 'leave-trigger', eventId: 'leave-event', touchedObjectId: 'tile-ground-0-0'
    });
    assert.equal(messages.length, 0, 'remaining on another matching cell is not a leave edge');

    room.handlePosition(guest, { x: 200, y: 200 });
    await room.handleMechanicsEventRequest(guest, {
        triggerId: 'leave-trigger', eventId: 'leave-event', touchedObjectId: 'tile-ground-64-0'
    });
    const eventRequests = () => messages.filter(item => item.message.type === 'mechanics_event_request');
    assert.equal(eventRequests().length, 1);
    assert.equal(eventRequests()[0].session, host);
    assert.equal(eventRequests()[0].message.touchedObjectId, 'tile-ground-64-0', 'Worker derives the last matching cell');

    await room.handleMechanicsEventRequest(guest, {
        triggerId: 'leave-trigger', eventId: 'leave-event', touchedObjectId: 'tile-ground-64-0'
    });
    assert.equal(eventRequests().length, 1, 'staying outside cannot repeat the edge');

    room.handlePosition(guest, { x: 40, y: 8 });
    room.handlePosition(guest, { x: 200, y: 200 });
    await room.handleMechanicsEventRequest(guest, {
        triggerId: 'leave-trigger', eventId: 'leave-event', touchedObjectId: 'forged-cell'
    });
    assert.equal(eventRequests().length, 2, 're-entering any matching cell rearms the exit edge');
    assert.equal(eventRequests()[1].message.touchedObjectId, 'tile-ground-64-0', 'forged touched-cell ids are ignored');

    room.handlePosition(guest, { x: 120, y: 8 });
    room.handlePosition(guest, { x: 200, y: 200 });
    await room.handleMechanicsEventRequest(guest, { triggerId: 'leave-trigger', eventId: 'leave-event' });
    assert.equal(eventRequests().length, 2, 'a hazard cell does not match the configured solid filter');
});

test('room worker excludes runtime-disabled tilemap cells from contact checks', () => {
    const room = new GameRoom({ storage: {} }, {});
    const mapData = {
        tilemaps: [{ id: 'ground', layer: 0, cells: [{ x: 64, y: 64, collisionType: 'solid' }] }]
    };
    const player = { x: 64, y: 64 };
    const disabledCell = { tilemapCellEnabled: { 'tile-ground-64-64': false } };

    assert.equal(room.findMechanicsTilemapContact(mapData, 'ground', 'solid', player, disabledCell), null);
    assert.equal(room.findMechanicsTilemapContact(mapData, 'ground', 'solid', player, {})?.id, 'tile-ground-64-64');
});

test('room worker matches ramp tilemap contact to the triangle collider', () => {
    const room = new GameRoom({ storage: {} }, {});
    const mapData = {
        tilemaps: [{ id: 'ground', layer: 0, cells: [{ x: 64, y: 64, collisionType: 'rampUpRight' }] }]
    };

    assert.equal(room.findMechanicsTilemapContact(mapData, 'ground', 'oneWay', { x: 40, y: 40 }), null,
        'the empty upper-left half of the ramp must not count as contact');
    assert.equal(room.findMechanicsTilemapContact(mapData, 'ground', 'oneWay', { x: 64, y: 64 })?.id,
        'tile-ground-64-64', 'the sloped solid area still counts as contact');
});

test('room worker validates a tilemap exit caused by a host-disabled cell', async () => {
    const { room, guest, host, messages, storedMechanics } = makeRoom({
        triggers: [{ id: 'leave-trigger', triggerType: 'playerLeaveTilemap', enabled: true,
            config: { tilemapId: 'ground', collisionType: 'solid', eventId: 'leave-event' } }],
        events: [{ id: 'leave-event', enabled: true }]
    }, [], [{ id: 'ground', layer: 0, cells: [{ x: 0, y: 0, collisionType: 'solid' }] }]);
    let removalEdgeCalls = 0;
    const recordRemovalEdges = room.recordMechanicsTilemapRemovalExits.bind(room);
    room.recordMechanicsTilemapRemovalExits = (...args) => {
        removalEdgeCalls++;
        return recordRemovalEdges(...args);
    };
    guest.x = 8;
    guest.y = 8;
    guest.lastPositionAt = Date.now();

    await room.handleMechanicsState(host, {
        state: { tilemapCellEnabled: { 'tile-ground-0-0': false } }
    });
    assert.equal(messages.some(item => item.message.type === 'error'), false, JSON.stringify(messages));
    assert.equal(JSON.parse(storedMechanics.get('mechanics:ROOM1'))?.state?.tilemapCellEnabled['tile-ground-0-0'], false);
    assert.equal(removalEdgeCalls, 1);
    assert.equal(guest.mechanicsContactLatches.get('leave-trigger')?.kind, 'tilemap-pending-exit');

    await room.handleMechanicsEventRequest(guest, { triggerId: 'leave-trigger', eventId: 'leave-event' });
    let requests = messages.filter(item => item.message.type === 'mechanics_event_request');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].session, host);
    assert.equal(requests[0].message.touchedObjectId, 'tile-ground-0-0');

    await room.handleMechanicsState(host, { state: {} });
    assert.equal(guest.mechanicsContactLatches.has('leave-trigger'), false,
        'restoring a matching cell rearms the trigger');
    await room.handleMechanicsState(host, {
        state: { tilemapCellEnabled: { 'tile-ground-0-0': false } }
    });
    await room.handleMechanicsEventRequest(guest, { triggerId: 'leave-trigger', eventId: 'leave-event' });
    requests = messages.filter(item => item.message.type === 'mechanics_event_request');
    assert.equal(requests.length, 2, 'restoring a matching cell rearms the exit');
    assert.equal(requests[1].message.touchedObjectId, 'tile-ground-0-0');
});

test('room worker validates draw-layer visibility against saved map layers', () => {
    const room = new GameRoom({ storage: {} }, {});
    const mapData = { layerDefinitions: [{ id: 'hidden-layer', depth: 3 }], codeData: {} };
    const valid = room.sanitizeMechanicsState(mapData, { layerVisibility: { 'hidden-layer': false } });
    assert.equal(valid?.layerVisibility['hidden-layer'], false);
    assert.equal(room.sanitizeMechanicsState(mapData, { layerVisibility: { 'not-on-map': false } }), null);
    assert.equal(room.sanitizeMechanicsState(mapData, { layerVisibility: { 'hidden-layer': 'false' } }), null);
    const legacyMap = { codeData: {} };
    assert.equal(room.sanitizeMechanicsState(legacyMap, { layerVisibility: { 'behind-player': false } })?.layerVisibility['behind-player'], false);
    assert.equal(room.sanitizeMechanicsState(legacyMap, { layerVisibility: { 'invented-layer': false } }), null);
});

test('room worker validates object draw-layer overrides against map objects and parallax collision rules', () => {
    const room = new GameRoom({ storage: {} }, {});
    const mapData = {
        objects: [{ id: 'crate', collision: true }, { id: 'backdrop', collision: false }],
        layerDefinitions: [
            { id: 'foreground', parallaxX: 1, parallaxY: 1 },
            { id: 'parallax', parallaxX: 0.5, parallaxY: 1 }
        ],
        codeData: {}
    };
    const valid = room.sanitizeMechanicsState(mapData, { objectDrawLayers: { crate: 'foreground' } });
    assert.equal(valid?.objectDrawLayers.crate, 'foreground');
    assert.equal(room.sanitizeMechanicsState(mapData, { objectDrawLayers: { missing: 'foreground' } }), null);
    assert.equal(room.sanitizeMechanicsState(mapData, { objectDrawLayers: { crate: 'parallax' } }), null);
    assert.equal(room.sanitizeMechanicsState(mapData, { objectDrawLayers: { backdrop: 'parallax' } })?.objectDrawLayers.backdrop, 'parallax');
});

test('room worker validates object collision overrides against saved map objects', () => {
    const room = new GameRoom({ storage: {} }, {});
    const mapData = { objects: [{ id: 'phase-platform', collision: true }], codeData: {} };
    const valid = room.sanitizeMechanicsState(mapData, { objectCollisions: { 'phase-platform': false } });
    assert.equal(valid?.objectCollisions['phase-platform'], false);
    assert.equal(room.sanitizeMechanicsState(mapData, { objectCollisions: { missing: false } }), null);
    assert.equal(room.sanitizeMechanicsState(mapData, { objectCollisions: { 'phase-platform': 'false' } }), null);
});

test('room worker validates tilemap atlas-frame overrides against saved cells and atlas bounds', () => {
    const room = new GameRoom({ storage: {} }, {});
    const mapData = {
        objects: [],
        tilemaps: [{ id: 'ground', layer: 1, atlas: {
            data: 'data:image/png;base64,AAAA', frameWidth: 32, frameHeight: 32, columns: 2, rows: 1
        }, cells: [
            { x: 0, y: 32, collisionType: 'solid' },
            { x: 32, y: 32, collisionType: 'solid', animation: { atlasFrames: [0, 1], fps: 4 } }
        ] }],
        codeData: {}
    };
    const cellId = 'tile-ground-0-32';
    const animatedCellId = 'tile-ground-32-32';
    const valid = room.sanitizeMechanicsState(mapData, { tilemapCellFrames: { [cellId]: 1 } });
    assert.equal(valid?.tilemapCellFrames[cellId], 1);
    assert.equal(room.sanitizeMechanicsState(mapData, { tilemapCellFrames: { [cellId]: 2 } }), null);
    assert.equal(room.sanitizeMechanicsState(mapData, { tilemapCellFrames: { [cellId]: -1 } }), null);
    assert.equal(room.sanitizeMechanicsState(mapData, { tilemapCellFrames: { missing: 0 } }), null);
    assert.equal(room.sanitizeMechanicsState(mapData, { tilemapCellFrames: { [animatedCellId]: 0 } }), null);
    const atlaslessRoom = new GameRoom({ storage: {} }, {});
    assert.equal(atlaslessRoom.sanitizeMechanicsState({ ...mapData, tilemaps: [{ ...mapData.tilemaps[0], atlas: undefined }] }, {
        tilemapCellFrames: { [cellId]: 0 }
    }), null);
    const invalidDimensionRoom = new GameRoom({ storage: {} }, {});
    const invalidDimensionMap = { ...mapData, tilemaps: [{ ...mapData.tilemaps[0], atlas: {
        ...mapData.tilemaps[0].atlas, columns: 129
    } }] };
    assert.equal(invalidDimensionRoom.sanitizeMechanicsState(invalidDimensionMap, {
        tilemapCellFrames: { [cellId]: 0 }
    }), null);
});

test('room worker accepts only bounded disabled-cell overrides for authored tilemap cells', () => {
    const room = new GameRoom({ storage: {} }, {});
    const mapData = {
        objects: [],
        tilemaps: [{ id: 'ground', layer: 1, cells: [
            { x: 0, y: 32, collisionType: 'solid' },
            { x: 32, y: 32, collisionType: 'decorative' }
        ] }],
        codeData: {}
    };
    const cellId = 'tile-ground-0-32';
    const valid = room.sanitizeMechanicsState(mapData, { tilemapCellEnabled: { [cellId]: false } });
    assert.equal(valid?.tilemapCellEnabled[cellId], false);
    assert.equal(room.sanitizeMechanicsState(mapData, { tilemapCellEnabled: { [cellId]: true } }), null);
    assert.equal(room.sanitizeMechanicsState(mapData, { tilemapCellEnabled: { missing: false } }), null);
    assert.equal(room.sanitizeMechanicsState(mapData, { tilemapCellEnabled: { [cellId]: 'false' } }), null);
});

test('room worker validates sprite frame and animation state for spawned objects through their template', () => {
    const room = new GameRoom({ storage: {} }, {});
    const mapData = {
        objects: [{ id: 'enemy-template', spriteSheet: { frameCount: 4 } }],
        codeData: { events: [{ id: 'animation-done', enabled: true }] }
    };
    const startedAtServer = Date.now();
    const state = {
        spawnedObjects: { mspawn_enemy1: { templateId: 'enemy-template', x: 50, y: 60, tag: 'enemy' } },
        objectSpriteFrames: { mspawn_enemy1: 2 },
        objectSpriteAnimations: { mspawn_enemy1: {
            startFrame: 0, frameCount: 3, fps: 8, loop: false, startedAtServer,
            completionEventId: 'animation-done', completionEventFired: false
        } }
    };

    const valid = room.sanitizeMechanicsState(mapData, state);
    assert.equal(valid?.objectSpriteFrames.mspawn_enemy1, 2);
    assert.equal(valid?.objectSpriteAnimations.mspawn_enemy1.frameCount, 3);

    assert.equal(room.sanitizeMechanicsState(mapData, {
        ...state, objectSpriteFrames: { mspawn_enemy1: 4 }
    }), null, 'spawned frame must fit the template sheet');
    assert.equal(room.sanitizeMechanicsState(mapData, {
        ...state, objectSpriteAnimations: { mspawn_enemy1: {
            ...state.objectSpriteAnimations.mspawn_enemy1, startFrame: 2, frameCount: 3
        } }
    }), null, 'spawned animation range must fit the template sheet');
    assert.equal(room.sanitizeMechanicsState(mapData, {
        ...state, objectSpriteFrames: { unknown: 1 }
    }), null, 'unknown spawned IDs must remain invalid');
});

test('room worker rejects zone entry requests without an outside-to-inside transition', async () => {
    const zone = { id: 'zone-1', appearanceType: 'zone', zoneName: 'Hideout', x: 100, y: 100, width: 100, height: 100 };
    const { room, guest, messages } = makeRoom({
        triggers: [{ id: 'enter-trigger', triggerType: 'playerEnterZone', enabled: true,
            config: { zoneName: 'Hideout', eventId: 'enter-event' } }],
        events: [{ id: 'enter-event', enabled: true }]
    }, [zone]);
    guest.previousPosition = { x: 105, y: 105 };
    guest.previousPositionAt = Date.now() - 40;
    guest.x = 110;
    guest.y = 110;
    guest.lastPositionAt = Date.now();

    await room.handleMechanicsEventRequest(guest, { triggerId: 'enter-trigger', eventId: 'enter-event' });

    assert.equal(messages.length, 0);
});

test('room worker verifies object contact and ignores a forged touched-player id', async () => {
    const object = { id: 'door-button', x: 80, y: 80, width: 32, height: 32 };
    const { room, guest, host, messages } = makeRoom({
        triggers: [{ id: 'touch-trigger', triggerType: 'playerTouchObject', enabled: true,
            config: { objectId: object.id, eventId: 'touch-event' } }],
        events: [{ id: 'touch-event', enabled: true }]
    }, [object]);
    guest.x = 200;
    guest.y = 200;
    guest.lastPositionAt = Date.now();
    host.x = 100;
    host.y = 90;
    host.lastPositionAt = Date.now();

    await room.handleMechanicsEventRequest(guest, {
        triggerId: 'touch-trigger', eventId: 'touch-event', touchedPlayerId: 'fake-player'
    });
    assert.equal(messages.length, 0);

    guest.x = 85;
    guest.y = 85;
    guest.lastPositionAt = Date.now();
    await room.handleMechanicsEventRequest(guest, {
        triggerId: 'touch-trigger', eventId: 'touch-event', touchedPlayerId: 'fake-player'
    });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].session, host);
    assert.equal(messages[0].message.touchedPlayerId, null);

    await room.handleMechanicsEventRequest(guest, {
        triggerId: 'touch-trigger', eventId: 'touch-event'
    });
    assert.equal(messages.filter(item => item.message.type === 'mechanics_event_request').length, 1);

    room.handlePosition(guest, { x: 200, y: 200 });
    room.handlePosition(guest, { x: 85, y: 85 });
    await room.handleMechanicsEventRequest(guest, {
        triggerId: 'touch-trigger', eventId: 'touch-event'
    });
    assert.equal(messages.filter(item => item.message.type === 'mechanics_event_request').length, 2);
});

test('room worker derives contact target from actual player overlap', async () => {
    const { room, guest, host, messages } = makeRoom({
        triggers: [{ id: 'tag-trigger', triggerType: 'playerActionInput', enabled: true,
            config: { action: 'touchOtherPlayer', eventId: 'tag-event' } }],
        events: [{ id: 'tag-event', enabled: true }]
    });
    guest.x = 100;
    guest.y = 100;
    guest.lastPositionAt = Date.now();
    host.x = 110;
    host.y = 100;
    host.lastPositionAt = Date.now();

    await room.handleMechanicsEventRequest(guest, { triggerId: 'tag-trigger', eventId: 'tag-event' });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].message.touchedPlayerId, host.id);
});
