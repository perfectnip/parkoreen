/**
 * Reference broker for reviewing the API v2 protocol.
 *
 * This module is not loaded by Parkoreen. A production host must provide a
 * reviewed isolation boundary and method dispatcher; the callback here must
 * validate current map/session state and queue gameplay mutations at a tick
 * boundary instead of changing live game objects from a message callback.
 */
import {
    API_V2_METHOD_CAPABILITY,
    validateHostResponse,
    validatePluginRequest,
    validatePluginRequestEnvelope
} from './protocol-guard.mjs';

export const API_V2_BROKER_DEFAULTS = Object.freeze({
    requestsPerSecond: 30,
    burstCapacity: 10,
    maxPendingRequests: 32,
    requestTimeoutMs: 250,
    maxConsecutiveViolations: 3
});

const knownCapabilities = new Set(Object.values(API_V2_METHOD_CAPABILITY));

const errorResponse = (requestId, code, message) => ({
    type: 'response',
    apiVersion: 2,
    responseTo: requestId,
    ok: false,
    error: { code, message: String(message || '').slice(0, 256) }
});

const isPositiveFinite = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Own one isolated plugin instance's protocol lifecycle.
 *
 * dispatch(method, args, context) is a trusted host adapter. It returns the
 * method result value, not a protocol envelope. reply sends an already
 * validated envelope over the instance's private MessagePort. Neither
 * callback is supplied by plugin code.
 */
export function createPluginV2Broker({
    pluginId,
    grants,
    declarations = {},
    dispatch,
    reply,
    closePort = () => {},
    onViolation = () => {},
    onClose = () => {},
    limits = {},
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout
} = {}) {
    if (typeof pluginId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(pluginId)) {
        throw new TypeError('A valid API v2 plugin id is required.');
    }
    if (!Array.isArray(grants) || grants.some(grant => !knownCapabilities.has(grant)) ||
        new Set(grants).size !== grants.length) {
        throw new TypeError('The API v2 grant set is invalid.');
    }
    if (typeof dispatch !== 'function' || typeof reply !== 'function') {
        throw new TypeError('Trusted dispatch and reply callbacks are required.');
    }
    const approvedGrants = Object.freeze(grants.slice());
    const approvedDeclarations = Object.freeze({
        controlIds: Object.freeze(Array.isArray(declarations.controlIds) ? declarations.controlIds.slice() : []),
        soundNames: Object.freeze(Array.isArray(declarations.soundNames) ? declarations.soundNames.slice() : []),
        assetNames: Object.freeze(Array.isArray(declarations.assetNames) ? declarations.assetNames.slice() : [])
    });

    const config = { ...API_V2_BROKER_DEFAULTS, ...limits };
    if (!isPositiveFinite(config.requestsPerSecond) ||
        !isPositiveFinite(config.burstCapacity) ||
        !Number.isSafeInteger(config.maxPendingRequests) || config.maxPendingRequests < 1 ||
        !isPositiveFinite(config.requestTimeoutMs) ||
        !Number.isSafeInteger(config.maxConsecutiveViolations) || config.maxConsecutiveViolations < 1) {
        throw new TypeError('API v2 broker limits are invalid.');
    }

    let state = 'active';
    let tokens = config.burstCapacity;
    let lastRefillAt = now();
    let violationStreak = 0;
    let closeReason = null;
    const pending = new Map();
    let lastRequestSequence = 0;

    const reportViolation = (code, message, requestId = null, { replyToPlugin = false } = {}) => {
        violationStreak++;
        try { onViolation({ pluginId, code, message, violationStreak }); } catch {}
        if (replyToPlugin && typeof requestId === 'string') {
            try { reply(errorResponse(requestId, code, message)); } catch {}
        }
        if (violationStreak >= config.maxConsecutiveViolations) {
            close('Disabled after repeated protocol violations.');
        }
        return { ok: false, error: { code, message }, state };
    };

    const consumeRequestToken = () => {
        const currentTime = now();
        if (!Number.isFinite(currentTime)) return false;
        if (currentTime > lastRefillAt) {
            tokens = Math.min(config.burstCapacity,
                tokens + ((currentTime - lastRefillAt) * config.requestsPerSecond / 1000));
            lastRefillAt = currentTime;
        }
        if (tokens < 1) return false;
        tokens -= 1;
        return true;
    };

    const sendResponse = response => {
        try {
            reply(response);
            return true;
        } catch {
            close('The host could not deliver a broker response.');
            return false;
        }
    };

    const settle = (requestId, response, { violation = null } = {}) => {
        const entry = pending.get(requestId);
        if (!entry || state !== 'active') return false;
        pending.delete(requestId);
        clearTimer(entry.timer);
        if (violation) {
            violationStreak++;
            try {
                onViolation({ pluginId, requestId, ...violation, violationStreak });
            } catch {}
        } else if (response.ok) {
            violationStreak = 0;
        }
        sendResponse(response);
        if (violationStreak >= config.maxConsecutiveViolations && state === 'active') {
            close('Disabled after repeated protocol violations.');
        }
        return true;
    };

    function close(reason = 'Plugin instance closed.') {
        if (state !== 'active') return false;
        state = 'closed';
        closeReason = String(reason).slice(0, 256);
        for (const entry of pending.values()) clearTimer(entry.timer);
        pending.clear();
        try { closePort(); } catch {}
        try { onClose({ pluginId, reason: closeReason }); } catch {}
        return true;
    }

    const handleMessage = message => {
        if (state !== 'active') return { ok: false, error: { code: 'PLUGIN_CLOSED', message: closeReason || 'Plugin instance is closed.' }, state };
        // Charge malformed messages too, so validation cannot become a free flood.
        if (!consumeRequestToken()) return reportViolation('RATE_LIMITED', 'The plugin exceeded its request rate.');

        const envelope = validatePluginRequestEnvelope(message);
        if (!envelope.ok) return reportViolation(envelope.error.code, envelope.error.message);
        const requestId = envelope.requestId;
        const requestSequence = Number(requestId);
        if (!Number.isSafeInteger(requestSequence) || requestSequence !== lastRequestSequence + 1) {
            return reportViolation('INVALID_REQUEST_SEQUENCE',
                'Request ids must be consecutive positive decimal numbers starting at 1.');
        }
        lastRequestSequence = requestSequence;

        const checked = validatePluginRequest(message, approvedGrants, approvedDeclarations);
        if (!checked.ok) {
            return reportViolation(checked.error.code, checked.error.message, requestId, { replyToPlugin: true });
        }
        const request = checked.request;
        if (pending.size >= config.maxPendingRequests) {
            return reportViolation('TOO_MANY_PENDING', 'The plugin has too many requests awaiting host replies.', requestId, { replyToPlugin: true });
        }

        const timer = setTimer(() => {
            settle(requestId, errorResponse(requestId, 'REQUEST_TIMEOUT', 'The host did not answer before the request deadline.'), {
                violation: { code: 'REQUEST_TIMEOUT', message: 'The host did not answer before the request deadline.' }
            });
        }, config.requestTimeoutMs);
        pending.set(requestId, { request, timer });

        Promise.resolve().then(() => dispatch(request.method, request.args, {
            pluginId,
            capability: checked.capability,
            grants: approvedGrants,
            requestId
        })).then(value => {
            const entry = pending.get(requestId);
            if (!entry || state !== 'active') return;
            const candidate = { type: 'response', apiVersion: 2, responseTo: requestId, ok: true, value };
            const response = validateHostResponse(candidate, entry.request);
            if (!response.ok) {
                settle(requestId, errorResponse(requestId, 'INVALID_HOST_RESULT',
                    'The host rejected an invalid method result.'), {
                    violation: { code: 'INVALID_HOST_RESULT', message: response.error.message }
                });
                return;
            }
            settle(requestId, response.response);
        }).catch(() => {
            settle(requestId, errorResponse(requestId, 'HOST_ERROR', 'The host could not complete this request.'));
        });

        return { ok: true, requestId, state };
    };

    return Object.freeze({
        handleMessage,
        close,
        get state() { return state; },
        get closeReason() { return closeReason; },
        get pendingCount() { return pending.size; },
        get consecutiveViolations() { return violationStreak; }
    });
}
