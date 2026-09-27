import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

test('scaffold, preflight, package, and verify a plugin without registering or executing it', async () => {
    const pluginId = `workflow-${randomUUID().replaceAll('-', '')}`;
    const pluginDirectory = path.join(repositoryRoot, 'assets', 'plugins', pluginId);
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'parkoreen-plugin-workflow-'));
    let scaffolded = false;

    try {
        const scaffoldOutput = execFileSync(node, ['tools/create-plugin.mjs', pluginId], {
            cwd: repositoryRoot,
            encoding: 'utf8'
        });
        scaffolded = true;
        assert.match(scaffoldOutput, /not registered or loaded/i);

        const manifest = JSON.parse(await readFile(path.join(pluginDirectory, 'plugin.json'), 'utf8'));
        assert.equal(manifest.id, pluginId);
        assert.equal(manifest.apiVersion, 1);
        assert.equal((await readFile(path.join(repositoryRoot, 'assets/plugins/manifest.json'), 'utf8')).includes(pluginId), false);

        const validationOutput = execFileSync(node, ['tools/validate-plugin.mjs', `assets/plugins/${pluginId}`], {
            cwd: repositoryRoot,
            encoding: 'utf8'
        });
        assert.match(validationOutput, new RegExp(`Plugin \\"?${pluginId}\\"? is valid`));

        const packagePath = path.join(tempDirectory, `${pluginId}.parkplugin`);
        const packagingOutput = execFileSync(node, [
            'tools/package-plugin.mjs', `assets/plugins/${pluginId}`, packagePath
        ], { cwd: repositoryRoot, encoding: 'utf8' });
        assert.match(packagingOutput, /does not install or execute community packages/i);
        assert.ok((await stat(packagePath)).size > 0);

        const verificationOutput = execFileSync(node, ['tools/verify-plugin-package.mjs', packagePath], {
            cwd: repositoryRoot,
            encoding: 'utf8'
        });
        assert.match(verificationOutput, new RegExp(`Verified ${pluginId}@${manifest.version}:`));
        assert.match(verificationOutput, /does not authenticate the publisher or make plugin code safe/i);
    } finally {
        if (scaffolded) await rm(pluginDirectory, { recursive: true, force: true });
        await rm(tempDirectory, { recursive: true, force: true });
    }
});
