import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [globals, editor, runtime] = await Promise.all([
    readFile(new URL('../assets/plugins/code/js/globals.js', import.meta.url), 'utf8'),
    readFile(new URL('../assets/plugins/code/js/editor.js', import.meta.url), 'utf8'),
    readFile(new URL('../assets/plugins/code/js/inject.js', import.meta.url), 'utf8')
]);

const triggerTypesMatch = globals.match(/const CODE_TRIGGER_TYPES\s*=\s*\{([\s\S]*?)\n\};/);
assert.ok(triggerTypesMatch, 'The Mechanics trigger type catalog exists');
const triggerTypes = [...triggerTypesMatch[1].matchAll(/^\s*([A-Z_]+):\s*'([^']+)'/gm)]
    .map(match => ({ key: match[1], id: match[2] }));

const triggerInfoMatch = globals.match(/const CODE_TRIGGER_TYPE_INFO\s*=\s*\[([\s\S]*?)\n\]\s*\.sort/);
assert.ok(triggerInfoMatch, 'The Mechanics trigger label catalog exists');

test('every Mechanics trigger has one label and editor/runtime wiring', () => {
    assert.ok(triggerTypes.length > 0, 'The trigger catalog is not empty');
    assert.equal(new Set(triggerTypes.map(type => type.key)).size, triggerTypes.length,
        'Trigger keys are unique');
    assert.equal(new Set(triggerTypes.map(type => type.id)).size, triggerTypes.length,
        'Trigger ids are unique');

    const labels = [...triggerInfoMatch[1].matchAll(/\{\s*id:\s*CODE_TRIGGER_TYPES\.([A-Z_]+),\s*label:\s*'([^']+)'/g)]
        .map(match => ({ key: match[1], label: match[2] }));
    assert.equal(new Set(labels.map(item => item.key)).size, labels.length,
        'Trigger labels do not duplicate a trigger key');
    assert.equal(new Set(labels.map(item => item.label)).size, labels.length,
        'Trigger labels are unique');

    for (const { key } of triggerTypes) {
        assert.ok(labels.some(item => item.key === key),
            `Trigger "${key}" is missing its editor label`);
        assert.ok(editor.includes(`CODE_TRIGGER_TYPES.${key}`),
            `Trigger "${key}" is missing from editor wiring`);
        assert.ok(runtime.includes(`CODE_TRIGGER_TYPES.${key}`),
            `Trigger "${key}" is missing from runtime wiring`);
    }
});
