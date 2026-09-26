const assert = require('node:assert/strict');
const test = require('node:test');
const normalizeCodeData = require('../assets/js/mechanicsData.js');

test('merges legacy action records into a non-empty canonical event list', () => {
    const input = {
        triggers: [{ id: 'trigger-1' }],
        events: [{ id: 'event-1', type: 'event', name: 'Current', actions: [] }],
        actions: [
            { id: 'event-2', type: 'action', name: 'Legacy', actions: [] },
            { id: 'event-1', type: 'action', name: 'Stale duplicate', actions: [] }
        ],
        variables: [{ id: 'variable-1' }],
        extensionData: { preserved: true }
    };

    const result = normalizeCodeData(input);
    assert.deepEqual(result.events, [
        { id: 'event-1', type: 'event', name: 'Current', actions: [] },
        { id: 'event-2', type: 'event', name: 'Legacy', actions: [] }
    ]);
    assert.deepEqual(result.triggers, input.triggers);
    assert.deepEqual(result.variables, input.variables);
    assert.deepEqual(result.extensionData, input.extensionData);
    assert.equal(Object.hasOwn(result, 'actions'), false);
    assert.equal(input.events[0].type, 'event');
    assert.equal(input.actions[0].type, 'action');
});

test('deduplicates identical id-less records without merging distinct records', () => {
    const result = normalizeCodeData({
        events: [{ type: 'action', name: 'Legacy unnamed', actions: [] }],
        actions: [
            { type: 'event', name: 'Legacy unnamed', actions: [] },
            { type: 'action', name: 'Another event', actions: [] }
        ]
    });

    assert.deepEqual(result.events, [
        { type: 'event', name: 'Legacy unnamed', actions: [] },
        { type: 'event', name: 'Another event', actions: [] }
    ]);
});

test('returns safe empty mechanics data for invalid input', () => {
    assert.deepEqual(normalizeCodeData(null), { triggers: [], events: [], variables: [] });
    assert.deepEqual(normalizeCodeData([]), { triggers: [], events: [], variables: [] });
});

test('reuses normalized records during repeated runtime reads', () => {
    const once = normalizeCodeData({ events: [{ id: 'event-1', type: 'event', actions: [] }] });
    assert.equal(normalizeCodeData(once), once);
});
