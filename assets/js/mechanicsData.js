/**
 * Shared mechanics map-data normalization.
 * Keep migration logic in one place so map loading, imports, the editor, and
 * the runtime interpret legacy saves the same way.
 */
(function (root, factory) {
    'use strict';
    const normalizeParkoreenCodeData = factory();
    root.normalizeParkoreenCodeData = normalizeParkoreenCodeData;
    if (typeof module === 'object' && module.exports) {
        module.exports = normalizeParkoreenCodeData;
    }
})(globalThis, function () {
    'use strict';
    const normalizedData = new WeakSet();

    return function normalizeParkoreenCodeData(codeData) {
        if (!codeData || typeof codeData !== 'object' || Array.isArray(codeData)) {
            return { triggers: [], events: [], variables: [] };
        }
        if (normalizedData.has(codeData)) return codeData;

        const events = [];
        const seenIds = new Set();
        const canonicalUnidentifiedSignatures = new Map();
        const eventSignature = (record) => {
            try {
                const signature = JSON.stringify(record);
                return typeof signature === 'string' ? signature : null;
            } catch (_) {
                return null;
            }
        };
        const normalizeRecords = (records, prefix) => {
            const seenRecordIds = new Set();
            const reservedRecordIds = new Set((Array.isArray(records) ? records : [])
                .filter(record => record && typeof record === 'object' && !Array.isArray(record))
                .map(record => record.id)
                .filter(id => typeof id === 'string' && id.trim()));
            const normalized = [];
            if (!Array.isArray(records)) return normalized;
            for (const [index, record] of records.entries()) {
                if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
                const copy = { ...record };
                if (typeof copy.id !== 'string' || !copy.id.trim() || seenRecordIds.has(copy.id)) {
                    let signature = '';
                    try {
                        const serialized = JSON.stringify(record);
                        if (typeof serialized === 'string') signature = serialized;
                    } catch (_) {}
                    let hash = 2166136261;
                    for (let characterIndex = 0; characterIndex < signature.length; characterIndex++) {
                        hash ^= signature.charCodeAt(characterIndex);
                        hash = Math.imul(hash, 16777619);
                    }
                    const baseId = `${prefix}_${index.toString(36)}_${(hash >>> 0).toString(36)}`;
                    let id = baseId;
                    let suffix = 1;
                    while (seenRecordIds.has(id) || reservedRecordIds.has(id)) id = `${baseId}_${suffix++}`;
                    copy.id = id;
                }
                seenRecordIds.add(copy.id);
                normalized.push(copy);
            }
            return normalized;
        };
        const appendEvents = (records, legacy = false) => {
            if (!Array.isArray(records)) return;
            for (const record of records) {
                if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
                const normalized = record.type === 'action' ? { ...record, type: 'event' } : { ...record };
                const id = typeof normalized.id === 'string' && normalized.id.trim() ? normalized.id : null;
                if (id && seenIds.has(id)) continue;

                if (!id) {
                    const signature = eventSignature(normalized);
                    if (legacy && signature) {
                        const canonicalCopies = canonicalUnidentifiedSignatures.get(signature) || 0;
                        if (canonicalCopies > 0) {
                            canonicalUnidentifiedSignatures.set(signature, canonicalCopies - 1);
                            continue;
                        }
                    } else if (!legacy && signature) {
                        canonicalUnidentifiedSignatures.set(signature,
                            (canonicalUnidentifiedSignatures.get(signature) || 0) + 1);
                    }
                } else {
                    seenIds.add(id);
                }
                events.push(normalized);
            }
        };

        // `events` is canonical. Preserve every distinct canonical record,
        // including identical legacy records without ids; repair their ids
        // below. Merge matching id-less copies from `actions`, and keep any
        // additional legacy records whose ids or signatures are distinct.
        appendEvents(codeData.events);
        appendEvents(codeData.actions, true);

        const normalizedCodeData = {
            ...codeData,
            triggers: normalizeRecords(codeData.triggers, 'trigger'),
            events: normalizeRecords(events, 'event'),
            variables: normalizeRecords(codeData.variables, 'variable')
        };
        delete normalizedCodeData.actions;
        normalizedData.add(normalizedCodeData);
        return normalizedCodeData;
    };
});
