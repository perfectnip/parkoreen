import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [globals, editor, runtime] = await Promise.all([
    readFile(new URL('../assets/plugins/code/js/globals.js', import.meta.url), 'utf8'),
    readFile(new URL('../assets/plugins/code/js/editor.js', import.meta.url), 'utf8'),
    readFile(new URL('../assets/plugins/code/js/inject.js', import.meta.url), 'utf8')
]);

const sliceBetween = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
    return source.slice(start, end);
};

const switchCaseIds = source => [...source.matchAll(/^\s*case\s+'([^']+)'\s*:/gm)].map(match => match[1]);

const catalogMatch = globals.match(/const CODE_EVENT_ACTION_TYPES\s*=\s*\[([\s\S]*?)\n\];/);
assert.ok(catalogMatch, 'The declarative Event action catalog exists');
const actionIds = [...catalogMatch[1].matchAll(/\bid:\s*'([^']+)'/g)].map(match => match[1]);

const surfaces = [
    {
        label: 'default factory',
        source: sliceBetween(editor, '    const createEventAction =', '    const renderEventActionConfig =')
    },
    {
        label: 'editor configuration form',
        source: sliceBetween(editor, '    const renderEventActionConfig =', '    const readEventActionRow =')
    },
    {
        label: 'runtime dispatcher',
        source: sliceBetween(runtime, '    const executeAction =', '    const createPythonEventContext =')
    }
];

test('every declared Mechanics Event action has one editor default, one config form, and one runtime case', () => {
    assert.ok(actionIds.length > 0, 'The action catalog is not empty');
    assert.equal(new Set(actionIds).size, actionIds.length, 'Action ids are unique in the catalog');

    for (const surface of surfaces) {
        const caseIds = switchCaseIds(surface.source);
        assert.equal(new Set(caseIds).size, caseIds.length, `${surface.label} has no duplicate action cases`);
        for (const id of actionIds) {
            assert.ok(caseIds.includes(id), `Action "${id}" is missing from the ${surface.label}`);
        }
    }
});
