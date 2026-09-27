import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
    API_V2_LIMITS,
    API_V2_METHOD_CAPABILITY,
    validateHostResponse,
    validatePluginRequest
} from '../assets/plugins/api-v2-draft/protocol-guard.mjs';
import {
    API_V2_BROKER_DEFAULTS,
    createPluginV2Broker
} from '../assets/plugins/api-v2-draft/broker.mjs';

const schema = JSON.parse(await readFile(new URL('../assets/plugins/api-v2-draft/plugin-protocol.schema.json', import.meta.url), 'utf8'));
const request = (method, args = {}, requestId = '1') => ({
    type: 'request', apiVersion: 2, requestId, method, args
});
const validate = (message, capability, declarations = {}) =>
    validatePluginRequest(message, capability ? [capability] : [], declarations);
const response = (value, responseTo = '1') => ({
    type: 'response', apiVersion: 2, responseTo, ok: true, value
});

test('draft capability map stays aligned with the protocol schema method and capability enums', () => {
    assert.deepEqual(Object.keys(API_V2_METHOD_CAPABILITY).sort(), schema.$defs.pluginMethod.enum.slice().sort());
    assert.deepEqual([...new Set(Object.values(API_V2_METHOD_CAPABILITY))].sort(), schema.$defs.capability.enum.slice().sort());
    assert.deepEqual(API_V2_BROKER_DEFAULTS, {
        requestsPerSecond: 30,
        burstCapacity: 10,
        maxPendingRequests: 32,
        requestTimeoutMs: 250,
        maxConsecutiveViolations: 3
    });
});

test('accepts a bounded map snapshot request only with its read grant', () => {
    const valid = request('map.getSnapshot', { objectOffset: 64, objectLimit: 32 });
    assert.equal(validate(valid, 'map.read').ok, true);
    assert.equal(validate(valid, 'players.read').error.code, 'CAPABILITY_DENIED');
    assert.equal(validate(request('map.getSnapshot', { objectLimit: 65 }), 'map.read').error.code, 'INVALID_ARGUMENTS');
});

test('tilemap cell snapshots use bounded pages and the map read grant', () => {
    const valid = request('tilemap.getSnapshot', { tilemapId: 'tilemap-2', cellOffset: 128, cellLimit: 64 });
    assert.equal(validate(valid, 'map.read').ok, true);
    assert.equal(validate(valid, 'players.read').error.code, 'CAPABILITY_DENIED');
    assert.equal(validate(request('tilemap.getSnapshot', { tilemapId: 'tilemap-2', cellOffset: 100001 }), 'map.read').error.code, 'INVALID_ARGUMENTS');
    assert.equal(validate(request('tilemap.getSnapshot', { tilemapId: 'tilemap-2', cellLimit: 129 }), 'map.read').error.code, 'INVALID_ARGUMENTS');
    assert.equal(validate(request('tilemap.getSnapshot', { tilemapId: 'tilemap-2', extra: true }), 'map.read').error.code, 'INVALID_ARGUMENTS');
});

test('rejects unknown envelope fields, invalid ids, unsupported versions, and methods', () => {
    assert.equal(validate({ ...request('map.getSnapshot'), origin: 'https://untrusted.test' }, 'map.read').error.code, 'INVALID_ENVELOPE');
    assert.equal(validate(request('map.getSnapshot', {}, 'id with spaces'), 'map.read').error.code, 'INVALID_ENVELOPE');
    assert.equal(validate({ ...request('map.getSnapshot'), apiVersion: 1 }, 'map.read').error.code, 'INVALID_ENVELOPE');
    assert.equal(validate(request('map.deleteAll'), 'map.read').error.code, 'UNKNOWN_METHOD');
    const symbolEnvelope = request('map.getSnapshot');
    symbolEnvelope[Symbol('hidden')] = true;
    assert.equal(validate(symbolEnvelope, 'map.read').error.code, 'INVALID_ENVELOPE');
});

test('input subscriptions require unique package-declared controls', () => {
    const declarations = { controlIds: ['interact', 'special'] };
    assert.equal(validate(request('input.subscribe', { controlIds: ['interact'] }), 'input.read', declarations).ok, true);
    assert.equal(validate(request('input.subscribe', { controlIds: ['missing'] }), 'input.read', declarations).error.code, 'INVALID_ARGUMENTS');
    assert.equal(validate(request('input.subscribe', { controlIds: ['interact', 'interact'] }), 'input.read', declarations).error.code, 'INVALID_ARGUMENTS');
});

test('render and audio requests accept only bounded commands and declared assets', () => {
    const declarations = { assetNames: ['marker'], soundNames: ['hit'] };
    const commands = [{ op: 'rect', x: 0, y: 2, width: 24, height: 16, color: '#12aBef', alpha: 0.5 },
        { op: 'image', assetName: 'marker', x: 0, y: 0, width: 32, height: 32 }];
    assert.equal(validate(request('render.submit', { commands }), 'render.commands', declarations).ok, true);
    assert.equal(validate(request('render.submit', { commands: [{ ...commands[0], color: 'red' }] }), 'render.commands', declarations).error.code, 'INVALID_ARGUMENTS');
    assert.equal(validate(request('render.submit', { commands: [{ ...commands[1], assetName: 'remote-image' }] }), 'render.commands', declarations).error.code, 'INVALID_ARGUMENTS');
    assert.equal(validate(request('audio.play', { soundName: 'hit' }), 'audio.play', declarations).ok, true);
    assert.equal(validate(request('audio.play', { soundName: 'external' }), 'audio.play', declarations).error.code, 'INVALID_ARGUMENTS');
});

test('gameplay request variants are disjoint and range checked', () => {
    assert.equal(validate(request('gameplay.request', {
        action: 'setPlayerVelocity', playerId: 'session-player', vx: -900, vy: 24
    }), 'gameplay.request').ok, true);
    assert.equal(validate(request('gameplay.request', {
        action: 'setPlayerVelocity', playerId: 'session-player', vx: 0, vy: 0, objectId: 'smuggled'
    }), 'gameplay.request').error.code, 'INVALID_ARGUMENTS');
    assert.equal(validate(request('gameplay.request', {
        action: 'setObjectEnabled', objectId: 'door-1', enabled: true, vx: 4
    }), 'gameplay.request').error.code, 'INVALID_ARGUMENTS');
    assert.equal(validate(request('gameplay.request', {
        action: 'setObjectPosition', objectId: 'door-1', x: 10000001, y: 0
    }), 'gameplay.request').error.code, 'INVALID_ARGUMENTS');
});

test('storage values honor JSON depth, collection, and byte bounds', () => {
    const accepted = { nested: [null, true, 3.5, 'ok'] };
    assert.equal(validate(request('storage.set', { key: 'state', value: accepted }), 'storage.local').ok, true);
    assert.equal(validate(request('storage.set', { key: 'state', value: 'x'.repeat(API_V2_LIMITS.storageValueBytes + 1) }), 'storage.local').error.code, 'INVALID_ARGUMENTS');
    assert.equal(validate(request('storage.set', { key: 'state', value: Array(257).fill(0) }), 'storage.local').error.code, 'INVALID_JSON');
    let tooDeep = null;
    for (let index = 0; index <= API_V2_LIMITS.jsonDepth; index++) tooDeep = { child: tooDeep };
    assert.equal(validate(request('storage.set', { key: 'state', value: tooDeep }), 'storage.local').error.code, 'INVALID_JSON');
});

test('rejects cyclic, non-finite, and oversized messages before method dispatch', () => {
    const circular = {};
    circular.self = circular;
    assert.equal(validate(request('storage.set', { key: 'state', value: circular }), 'storage.local').error.code, 'INVALID_JSON');
    assert.equal(validate(request('storage.set', { key: 'state', value: Number.NaN }), 'storage.local').error.code, 'INVALID_JSON');
    let getterCalled = false;
    const accessorValue = {};
    Object.defineProperty(accessorValue, 'secret', { enumerable: true, get() { getterCalled = true; return 'value'; } });
    assert.equal(validate(request('storage.set', { key: 'state', value: accessorValue }), 'storage.local').error.code, 'INVALID_JSON');
    assert.equal(getterCalled, false, 'validation does not execute property accessors');
    const longText = 'x'.repeat(256);
    const oversized = request('render.submit', {
        commands: Array.from({ length: 256 }, () => ({ op: 'text', x: 0, y: 0, text: longText, color: '#ffffff', fontSize: 64 }))
    });
    assert.equal(validate(oversized, 'render.commands').error.code, 'MESSAGE_TOO_LARGE');
});

test('host success replies correlate to the pending request and validate method results', () => {
    const mapRequest = request('map.getSnapshot', { objectOffset: 0, objectLimit: 1 });
    const mapValue = {
        mapId: 'map-1', mapName: 'Test Map', gravity: 1, objectCount: 2, objectOffset: 0, nextObjectOffset: 1,
        objects: [{ id: 'floor-1', name: 'Floor', type: 'block', x: 0, y: 64, width: 128, height: 32, enabled: true }]
    };
    assert.equal(validateHostResponse(response(mapValue), mapRequest).ok, true);
    assert.equal(validateHostResponse(response(mapValue, 'another_request'), mapRequest).error.code, 'RESPONSE_MISMATCH');
    assert.equal(validateHostResponse(response({ ...mapValue, nextObjectOffset: null }), mapRequest).error.code, 'INVALID_RESULT');
    assert.equal(validateHostResponse(response({ ...mapValue, ignored: true }), mapRequest).error.code, 'INVALID_RESULT');

    const playerRequest = request('players.getSnapshot');
    const player = id => ({ playerId: id, name: id, x: 0, y: 0, width: 32, height: 48,
        vx: 0, vy: 0, isGrounded: true, isDead: false });
    const playersValue = { playerCount: 2, playerOffset: 0, nextPlayerOffset: null,
        players: [player('a-session'), player('b-session')] };
    assert.equal(validateHostResponse(response(playersValue), playerRequest).ok, true);
    assert.equal(validateHostResponse(response({ ...playersValue, players: [player('b-session'), player('a-session')] }), playerRequest).error.code, 'INVALID_RESULT');

    const tilemapRequest = request('tilemap.getSnapshot', { tilemapId: 'tilemap-1', cellLimit: 2 });
    const tilemapValue = { tilemapId: 'tilemap-1', tilemapName: 'Ground', layer: 1, cellCount: 2,
        cellOffset: 0, nextCellOffset: null, cells: [
            { x: 0, y: 0, collisionType: 'solid', collisionShape: 'box', collisionPoints: null, polygonOneWay: null },
            { x: 32, y: 0, collisionType: 'oneWay', collisionShape: 'box', collisionPoints: null, polygonOneWay: null }
        ] };
    assert.equal(validateHostResponse(response(tilemapValue), tilemapRequest).ok, true);
    assert.equal(validateHostResponse(response({ ...tilemapValue, tilemapId: 'other-map' }), tilemapRequest).error.code, 'INVALID_RESULT');
    assert.equal(validateHostResponse(response({ ...tilemapValue, cells: [tilemapValue.cells[1], tilemapValue.cells[0]] }), tilemapRequest).error.code, 'INVALID_RESULT');
    assert.equal(validateHostResponse(response({ ...tilemapValue, cells: [{ ...tilemapValue.cells[0], x: 16 }, tilemapValue.cells[1]] }), tilemapRequest).error.code, 'INVALID_RESULT');
    assert.equal(validateHostResponse(response({ ...tilemapValue, cells: [{ ...tilemapValue.cells[0], collisionType: 'rampUpRight' }, tilemapValue.cells[1]] }), tilemapRequest).error.code, 'INVALID_RESULT');
    assert.equal(validateHostResponse(response({ ...tilemapValue, cells: [{ x: 0, y: 0, collisionType: 'solid', collisionShape: 'polygon',
        collisionPoints: [[0, 0], [1, 0], [0.5, 1]], polygonOneWay: false }, tilemapValue.cells[1]] }), tilemapRequest).ok, true);
    assert.equal(validateHostResponse(response({ ...tilemapValue, cells: [{ x: 0, y: 0, collisionType: 'solid', collisionShape: 'polygon',
        collisionPoints: [[0, 0], [1, 0], [0.5, 0.5], [1, 1], [0, 1]], polygonOneWay: false }, tilemapValue.cells[1]] }), tilemapRequest).error.code, 'INVALID_RESULT');
});

test('host success result fields stay coupled to accepted request payloads', () => {
    const inputRequest = request('input.subscribe', { controlIds: ['interact', 'dash'] });
    assert.equal(validateHostResponse(response({ subscribedControlIds: ['dash'] }), inputRequest).ok, true);
    assert.equal(validateHostResponse(response({ subscribedControlIds: ['undeclared'] }), inputRequest).error.code, 'INVALID_RESULT');
    const renderRequest = request('render.submit', { commands: [{ op: 'rect', x: 0, y: 0, width: 4, height: 4, color: '#ffffff' }] });
    assert.equal(validateHostResponse(response({ queuedCommands: 1 }), renderRequest).ok, true);
    assert.equal(validateHostResponse(response({ queuedCommands: 2 }), renderRequest).error.code, 'INVALID_RESULT');
});

test('host error envelopes remain bounded and exact', () => {
    const pending = request('audio.play', { soundName: 'hit' });
    const validError = { type: 'response', apiVersion: 2, responseTo: '1', ok: false,
        error: { code: 'NOT_DECLARED', message: 'The sound is not part of this package.' } };
    assert.equal(validateHostResponse(validError, pending).ok, true);
    assert.equal(validateHostResponse({ ...validError, extra: true }, pending).error.code, 'INVALID_RESPONSE');
    assert.equal(validateHostResponse({ ...validError, error: { code: 'bad code', message: '' } }, pending).error.code, 'INVALID_RESPONSE');
    let getterCalled = false;
    const accessorResponse = { apiVersion: 2, responseTo: '1', ok: false, error: validError.error };
    Object.defineProperty(accessorResponse, 'type', { enumerable: true, get() { getterCalled = true; return 'response'; } });
    assert.equal(validateHostResponse(accessorResponse, pending).error.code, 'INVALID_RESPONSE');
    assert.equal(getterCalled, false, 'response validation does not execute property accessors');
});

const emptyMapSnapshot = {
    mapId: 'map-1', mapName: 'Test Map', gravity: 1, objectCount: 0,
    objectOffset: 0, nextObjectOffset: null, objects: []
};

test('draft broker dispatches only granted methods and validates host results', async () => {
    const grants = ['map.read'];
    const replies = [];
    const dispatched = [];
    const broker = createPluginV2Broker({
        pluginId: 'sample-plugin',
        grants,
        dispatch: async (method, args, context) => {
            dispatched.push({ method, args, context });
            return emptyMapSnapshot;
        },
        reply: message => replies.push(message)
    });

    assert.equal(broker.handleMessage(request('map.getSnapshot')).ok, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(replies[0], response(emptyMapSnapshot));
    assert.equal(dispatched[0].context.capability, 'map.read');
    assert.deepEqual(dispatched[0].context.grants, ['map.read']);

    grants.push('storage.local');
    const denied = broker.handleMessage(request('storage.set', { key: 'state', value: 1 }, '2'));
    assert.equal(denied.error.code, 'CAPABILITY_DENIED');
    assert.equal(dispatched.length, 1);
    assert.equal(replies[1]?.error?.code, 'CAPABILITY_DENIED');
    assert.equal(broker.handleMessage(request('map.getSnapshot', {}, '3')).ok, true,
        'a denied request consumes its sequence id so the next request can proceed');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(dispatched.length, 2);
    broker.close();
});

test('draft broker requires bounded sequential request ids and correlates duplicate rejection', async () => {
    const replies = [];
    const broker = createPluginV2Broker({
        pluginId: 'sample-plugin', grants: ['map.read'],
        dispatch: async () => emptyMapSnapshot,
        reply: message => replies.push(message)
    });
    assert.equal(broker.handleMessage(request('map.getSnapshot', {}, '1')).ok, true);
    await new Promise(resolve => setImmediate(resolve));
    const duplicate = broker.handleMessage(request('map.getSnapshot', {}, '1'));
    assert.equal(duplicate.error.code, 'INVALID_REQUEST_SEQUENCE');
    assert.equal(replies.length, 1, 'a duplicate id does not get a second response with ambiguous correlation');
    assert.equal(validate(request('map.getSnapshot', {}, 'request_1'), 'map.read').error.code, 'INVALID_ENVELOPE');
    broker.close();
});

test('draft broker applies token-bucket limits and closes a repeatedly flooding instance', () => {
    let portClosed = 0;
    const broker = createPluginV2Broker({
        pluginId: 'sample-plugin', grants: ['map.read'],
        dispatch: () => new Promise(() => {}),
        reply() {},
        closePort: () => { portClosed++; },
        limits: { requestsPerSecond: 0.001, burstCapacity: 1 }
    });
    assert.equal(broker.handleMessage(request('map.getSnapshot')).ok, true);
    assert.equal(broker.handleMessage(request('map.getSnapshot', {}, '2')).error.code, 'RATE_LIMITED');
    assert.equal(broker.handleMessage(request('map.getSnapshot', {}, '2')).error.code, 'RATE_LIMITED');
    assert.equal(broker.handleMessage(request('map.getSnapshot', {}, '2')).state, 'closed');
    assert.equal(broker.pendingCount, 0);
    assert.equal(portClosed, 1);
});

test('draft broker deadlines and teardown clear pending work', async () => {
    const replies = [];
    const broker = createPluginV2Broker({
        pluginId: 'sample-plugin', grants: ['map.read'],
        dispatch: () => new Promise(() => {}),
        reply: message => replies.push(message),
        limits: { requestTimeoutMs: 5 }
    });
    broker.handleMessage(request('map.getSnapshot'));
    assert.equal(broker.pendingCount, 1);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(replies[0]?.error?.code, 'REQUEST_TIMEOUT');
    assert.equal(broker.pendingCount, 0);
    assert.equal(broker.state, 'active');
    broker.close('revoked');
    assert.equal(broker.state, 'closed');
    assert.equal(broker.closeReason, 'revoked');
});
