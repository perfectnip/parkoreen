import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
    API_V2_LIMITS,
    API_V2_METHOD_CAPABILITY,
    validatePluginRequest
} from '../assets/plugins/api-v2-draft/protocol-guard.mjs';

const schema = JSON.parse(await readFile(new URL('../assets/plugins/api-v2-draft/plugin-protocol.schema.json', import.meta.url), 'utf8'));
const request = (method, args = {}, requestId = 'request_1') => ({
    type: 'request', apiVersion: 2, requestId, method, args
});
const validate = (message, capability, declarations = {}) =>
    validatePluginRequest(message, capability ? [capability] : [], declarations);

test('draft capability map stays aligned with the protocol schema method and capability enums', () => {
    assert.deepEqual(Object.keys(API_V2_METHOD_CAPABILITY).sort(), schema.$defs.pluginMethod.enum.slice().sort());
    assert.deepEqual([...new Set(Object.values(API_V2_METHOD_CAPABILITY))].sort(), schema.$defs.capability.enum.slice().sort());
});

test('accepts a bounded map snapshot request only with its read grant', () => {
    const valid = request('map.getSnapshot', { objectOffset: 64, objectLimit: 32 });
    assert.equal(validate(valid, 'map.read').ok, true);
    assert.equal(validate(valid, 'players.read').error.code, 'CAPABILITY_DENIED');
    assert.equal(validate(request('map.getSnapshot', { objectLimit: 65 }), 'map.read').error.code, 'INVALID_ARGUMENTS');
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
