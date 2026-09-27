import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workerSource = await readFile(new URL('../cloudflare-worker/worker.js', import.meta.url), 'utf8');
const workerModule = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`);
const { GameRoom } = workerModule;

const makeRoom = (codeData, objects = []) => {
    const messages = [];
    const guest = { id: 'guest-session', roomCode: 'ROOM1', isHost: false, user: { name: 'Guest' } };
    const host = { id: 'host-session', roomCode: 'ROOM1', isHost: true, userId: 'host-user' };
    const room = new GameRoom({ storage: {
        get: async key => key === 'room:ROOM1'
            ? JSON.stringify({ hostUserId: 'host-user', mapData: { codeData, objects } })
            : null
    } }, {});
    room.getPlayersInRoom = () => [host, guest];
    room.send = (session, message) => messages.push({ session, message });
    room.broadcastToRoom = () => {};
    room.sessions.set(host.id, host);
    room.sessions.set(guest.id, guest);
    return { room, guest, host, messages };
};

test('room worker forwards a legacy event when other canonical events exist', async () => {
    const { room, guest, host, messages } = makeRoom({
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
