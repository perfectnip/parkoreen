import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { resolvesThroughHiddenPath } from './plugin-dev-paths.mjs';

test('plugin preview rejects hidden targets reached through visible paths', () => {
    const root = path.resolve('/repo');
    assert.equal(resolvesThroughHiddenPath(root, path.join(root, '.git', 'config')), true);
    assert.equal(resolvesThroughHiddenPath(root, path.join(root, 'assets', '.private', 'plugin.json')), true);
    assert.equal(resolvesThroughHiddenPath(root, path.join(root, 'assets', 'plugins', 'example', 'plugin.json')), false);
});
