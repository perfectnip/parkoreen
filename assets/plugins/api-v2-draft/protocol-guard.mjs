/**
 * Offline conformance guard for the proposed API v2 plugin request contract.
 * This is tooling for draft review only; the game runtime does not import it.
 * It does not provide isolation, permissions UI, rate limiting, or installation.
 */

export const API_V2_LIMITS = Object.freeze({
    messageBytes: 64 * 1024,
    jsonDepth: 16,
    arrayItems: 256,
    objectFields: 64,
    storageValueBytes: 32 * 1024
});

export const API_V2_METHOD_CAPABILITY = Object.freeze({
    'map.getSnapshot': 'map.read',
    'players.getSnapshot': 'players.read',
    'input.subscribe': 'input.read',
    'render.submit': 'render.commands',
    'audio.play': 'audio.play',
    'gameplay.request': 'gameplay.request',
    'storage.get': 'storage.local',
    'storage.set': 'storage.local'
});

const knownCapabilities = new Set(Object.values(API_V2_METHOD_CAPABILITY));
const requestIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const controlIdPattern = /^[a-z][a-zA-Z0-9_-]{0,47}$/;
const assetNamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const soundNamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const colorPattern = /^#[0-9A-Fa-f]{6}$/;

const fail = (code, message) => ({ ok: false, error: { code, message } });

const isPlainObject = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
};

const hasOnlyKeys = (value, allowed, required = []) =>
    isPlainObject(value) && Reflect.ownKeys(value).every(key =>
        typeof key === 'string' && allowed.includes(key) &&
        Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) || {}, 'value')) &&
    required.every(key => Object.hasOwn(value, key));

const isFiniteInRange = (value, minimum, maximum) =>
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;

const isIntegerInRange = (value, minimum, maximum) =>
    Number.isSafeInteger(value) && value >= minimum && value <= maximum;

const isString = (value, minimumLength, maximumLength, pattern = null) =>
    typeof value === 'string' && value.length >= minimumLength && value.length <= maximumLength &&
    (!pattern || pattern.test(value));

function inspectJsonValue(root) {
    const stack = [{ value: root, depth: 0, leaving: false }];
    const active = new Set();

    while (stack.length) {
        const entry = stack.pop();
        const value = entry.value;
        if (entry.leaving) {
            active.delete(value);
            continue;
        }
        if (value === null || typeof value === 'boolean') continue;
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) return false;
            continue;
        }
        if (typeof value === 'string') continue;
        if (typeof value !== 'object' || active.has(value) || entry.depth >= API_V2_LIMITS.jsonDepth) return false;

        if (Array.isArray(value)) {
            const keys = Reflect.ownKeys(value);
            if (value.length > API_V2_LIMITS.arrayItems || keys.length !== value.length + 1 ||
                keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)))) return false;
            active.add(value);
            stack.push({ value, depth: entry.depth, leaving: true });
            for (let index = value.length - 1; index >= 0; index--) {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
                stack.push({ value: descriptor.value, depth: entry.depth + 1, leaving: false });
            }
            continue;
        }

        if (!isPlainObject(value)) return false;
        const keys = Reflect.ownKeys(value);
        if (keys.length > API_V2_LIMITS.objectFields || keys.some(key => typeof key !== 'string')) return false;
        active.add(value);
        stack.push({ value, depth: entry.depth, leaving: true });
        for (let index = keys.length - 1; index >= 0; index--) {
            const key = keys[index];
            if (key === '__proto__' || key === 'prototype' || key === 'constructor') return false;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
            stack.push({ value: descriptor.value, depth: entry.depth + 1, leaving: false });
        }
    }
    return true;
}

function validRenderCommand(command, declaredAssets) {
    if (!isPlainObject(command) || typeof command.op !== 'string') return false;
    switch (command.op) {
        case 'rect':
            return hasOnlyKeys(command, ['op', 'x', 'y', 'width', 'height', 'color', 'alpha'], ['op', 'x', 'y', 'width', 'height', 'color']) &&
                isFiniteInRange(command.x, -10000, 10000) && isFiniteInRange(command.y, -10000, 10000) &&
                isFiniteInRange(command.width, Number.MIN_VALUE, 4096) && isFiniteInRange(command.height, Number.MIN_VALUE, 4096) &&
                isString(command.color, 7, 7, colorPattern) &&
                (command.alpha === undefined || isFiniteInRange(command.alpha, 0, 1));
        case 'circle':
            return hasOnlyKeys(command, ['op', 'x', 'y', 'radius', 'color', 'alpha'], ['op', 'x', 'y', 'radius', 'color']) &&
                isFiniteInRange(command.x, -10000, 10000) && isFiniteInRange(command.y, -10000, 10000) &&
                isFiniteInRange(command.radius, Number.MIN_VALUE, 2048) && isString(command.color, 7, 7, colorPattern) &&
                (command.alpha === undefined || isFiniteInRange(command.alpha, 0, 1));
        case 'text':
            return hasOnlyKeys(command, ['op', 'x', 'y', 'text', 'color', 'fontSize'], ['op', 'x', 'y', 'text', 'color', 'fontSize']) &&
                isFiniteInRange(command.x, -10000, 10000) && isFiniteInRange(command.y, -10000, 10000) &&
                isString(command.text, 0, 256) && isString(command.color, 7, 7, colorPattern) &&
                isIntegerInRange(command.fontSize, 8, 64);
        case 'image':
            return hasOnlyKeys(command, ['op', 'assetName', 'x', 'y', 'width', 'height', 'alpha'], ['op', 'assetName', 'x', 'y', 'width', 'height']) &&
                isString(command.assetName, 1, 64, assetNamePattern) && declaredAssets.has(command.assetName) &&
                isFiniteInRange(command.x, -10000, 10000) && isFiniteInRange(command.y, -10000, 10000) &&
                isFiniteInRange(command.width, Number.MIN_VALUE, 4096) && isFiniteInRange(command.height, Number.MIN_VALUE, 4096) &&
                (command.alpha === undefined || isFiniteInRange(command.alpha, 0, 1));
        default:
            return false;
    }
}

function validateMethodArguments(method, args, declarations) {
    switch (method) {
        case 'map.getSnapshot':
            return hasOnlyKeys(args, ['objectOffset', 'objectLimit']) &&
                (args.objectOffset === undefined || isIntegerInRange(args.objectOffset, 0, 1000000)) &&
                (args.objectLimit === undefined || isIntegerInRange(args.objectLimit, 1, 64));
        case 'players.getSnapshot':
            return hasOnlyKeys(args, ['playerOffset', 'playerLimit']) &&
                (args.playerOffset === undefined || isIntegerInRange(args.playerOffset, 0, 1024)) &&
                (args.playerLimit === undefined || isIntegerInRange(args.playerLimit, 1, 32));
        case 'input.subscribe':
            return hasOnlyKeys(args, ['controlIds'], ['controlIds']) && Array.isArray(args.controlIds) &&
                args.controlIds.length >= 1 && args.controlIds.length <= 32 &&
                new Set(args.controlIds).size === args.controlIds.length &&
                args.controlIds.every(id => isString(id, 1, 48, controlIdPattern) && declarations.controlIds.has(id));
        case 'render.submit':
            return hasOnlyKeys(args, ['commands'], ['commands']) && Array.isArray(args.commands) &&
                args.commands.length <= 256 && args.commands.every(command => validRenderCommand(command, declarations.assetNames));
        case 'audio.play':
            return hasOnlyKeys(args, ['soundName', 'volume'], ['soundName']) &&
                isString(args.soundName, 1, 64, soundNamePattern) && declarations.soundNames.has(args.soundName) &&
                (args.volume === undefined || isFiniteInRange(args.volume, 0, 1));
        case 'gameplay.request':
            if (!isPlainObject(args) || typeof args.action !== 'string') return false;
            if (args.action === 'setPlayerVelocity') {
                return hasOnlyKeys(args, ['action', 'playerId', 'vx', 'vy'], ['action', 'playerId', 'vx', 'vy']) &&
                    isString(args.playerId, 1, 128) && isFiniteInRange(args.vx, -10000, 10000) && isFiniteInRange(args.vy, -10000, 10000);
            }
            if (args.action === 'setObjectEnabled') {
                return hasOnlyKeys(args, ['action', 'objectId', 'enabled'], ['action', 'objectId', 'enabled']) &&
                    isString(args.objectId, 1, 128) && typeof args.enabled === 'boolean';
            }
            if (args.action === 'setObjectPosition') {
                return hasOnlyKeys(args, ['action', 'objectId', 'x', 'y'], ['action', 'objectId', 'x', 'y']) &&
                    isString(args.objectId, 1, 128) && isFiniteInRange(args.x, -10000000, 10000000) &&
                    isFiniteInRange(args.y, -10000000, 10000000);
            }
            return false;
        case 'storage.get':
            return hasOnlyKeys(args, ['key'], ['key']) && isString(args.key, 1, 128);
        case 'storage.set':
            if (!hasOnlyKeys(args, ['key', 'value'], ['key', 'value']) || !isString(args.key, 1, 128)) return false;
            return inspectJsonValue(args.value) && new TextEncoder().encode(JSON.stringify(args.value)).byteLength <= API_V2_LIMITS.storageValueBytes;
        default:
            return false;
    }
}

/**
 * Validate one plugin-to-host request against the v2 draft before any dispatch.
 * `declarations` contains package-declared control ids, sound names, and asset names.
 */
export function validatePluginRequest(message, grants, declarations = {}) {
    if (!isPlainObject(message) || !hasOnlyKeys(message, ['type', 'apiVersion', 'requestId', 'method', 'args'],
        ['type', 'apiVersion', 'requestId', 'method', 'args'])) {
        return fail('INVALID_ENVELOPE', 'Request must contain only the documented envelope fields.');
    }
    if (message.type !== 'request' || message.apiVersion !== 2 || !isString(message.requestId, 1, 64, requestIdPattern)) {
        return fail('INVALID_ENVELOPE', 'Request type, protocol version, or request id is invalid.');
    }
    if (!Object.hasOwn(API_V2_METHOD_CAPABILITY, message.method)) return fail('UNKNOWN_METHOD', 'The requested method is not supported.');
    if (!Array.isArray(grants) || grants.some(grant => !knownCapabilities.has(grant))) {
        return fail('INVALID_GRANTS', 'The grant set contains an unknown capability.');
    }
    const capability = API_V2_METHOD_CAPABILITY[message.method];
    if (!grants.includes(capability)) return fail('CAPABILITY_DENIED', `The ${capability} capability was not granted.`);
    if (!isPlainObject(message.args) || !inspectJsonValue(message.args)) {
        return fail('INVALID_JSON', 'Arguments must be bounded plain JSON data.');
    }
    let encoded;
    try {
        encoded = new TextEncoder().encode(JSON.stringify(message)).byteLength;
    } catch {
        return fail('INVALID_JSON', 'The request cannot be encoded as JSON.');
    }
    if (encoded > API_V2_LIMITS.messageBytes) return fail('MESSAGE_TOO_LARGE', 'The encoded request exceeds 64 KiB.');

    const normalizedDeclarations = {
        controlIds: new Set(Array.isArray(declarations.controlIds) ? declarations.controlIds : []),
        soundNames: new Set(Array.isArray(declarations.soundNames) ? declarations.soundNames : []),
        assetNames: new Set(Array.isArray(declarations.assetNames) ? declarations.assetNames : [])
    };
    if (!validateMethodArguments(message.method, message.args, normalizedDeclarations)) {
        return fail('INVALID_ARGUMENTS', 'Arguments do not match the method contract or package declarations.');
    }
    return { ok: true, capability, request: JSON.parse(JSON.stringify(message)) };
}
