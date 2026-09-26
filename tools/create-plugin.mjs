#!/usr/bin/env node

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = /^[a-z0-9][a-z0-9_-]*$/;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginsDirectory = path.resolve(scriptDirectory, '../assets/plugins');
const templateDirectory = path.join(pluginsDirectory, 'plugin-template');
const id = process.argv[2];

if (!id || id === '--help' || id === '-h') {
    process.stdout.write('Usage: node tools/create-plugin.mjs <plugin-id>\n');
    process.stdout.write('Creates an unregistered plugin starter at assets/plugins/<plugin-id>.\n');
    process.exit(id ? 0 : 2);
}

if (!PLUGIN_ID.test(id) || id === 'plugin-template') {
    process.stderr.write('Plugin id must use lowercase letters, numbers, underscores, or hyphens and cannot be "plugin-template".\n');
    process.exit(2);
}

const destination = path.join(pluginsDirectory, id);
const displayName = id.split(/[-_]+/).map(part => part ? `${part[0].toUpperCase()}${part.slice(1)}` : '').join(' ');
let createdDirectory = false;

try {
    await mkdir(destination);
    createdDirectory = true;
    const templateEntries = await readdir(templateDirectory);
    for (const entry of templateEntries) {
        await cp(path.join(templateDirectory, entry), path.join(destination, entry), {
            recursive: true,
            force: false,
            errorOnExist: true
        });
    }

    const manifestPath = path.join(destination, 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.id = id;
    manifest.name = displayName;
    manifest.description = `A Parkoreen plugin created from the API v${manifest.apiVersion} starter.`;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const readme = `# ${displayName} plugin\n\n` +
        `Plugin id: \`${id}\`  \nAPI version: \`${manifest.apiVersion}\`  \nPlugin version: \`${manifest.version}\`\n\n` +
        `This starter is not registered with Parkoreen and will not load in the game. Review the code before adding \`${id}\` to ` +
        '`assets/plugins/manifest.json`; bundled plugins execute as trusted page scripts and are not sandboxed.\n\n' +
        'The example draws a configurable marker with the `render.player` hook and loads its declared SVG through `ctx.api.getAssetUrl()`. `types/plugin-api-v1.d.ts` provides editor completions for API methods and hook payloads. `showPlayerMarker` in `plugin.json` demonstrates plugin config. The starter also declares a `markerPulse` control; choose a control id unique across all registered plugins because control ids share `player.input`. The runtime skips duplicate declarations and the validator reports conflicts. Core movement ids (`left`, `right`, `up`, `down`, `jump`, `shift`, and `space`) are rejected; `attack`, `heal`, `dash`, and `superDash` are reserved for supported built-in plugin actions. Enable the plugin on a map, then add a Mechanics `Player Action Input` trigger and choose `Plugin: Marker pulse` to run an Event on each press, including its touch button. Custom-control Events run locally in hosted rooms and do not request host-authoritative changes. See [MIGRATION.md](MIGRATION.md) for API versioning and legacy plugin upgrades.\n\n' +
        'For a local preview before registering the plugin, run `node tools/serve-plugin-dev.mjs` from the repository root, copy its one-time token, and open `http://127.0.0.1:4173/parkoreen/host.html?pluginDev=' + id + '&pluginDevToken=<token>`. To preview up to eight related local plugins together, use comma-separated ids such as `?pluginDev=' + id + ',helper&pluginDevToken=<token>`; this lets local plugins resolve dependencies without editing the shared registry. The selected plugins appear in the editor plugin library; enable them on a development map. Changes in any selected folder reload the page. The token prevents another website from silently initiating a preview, but this mode still executes trusted page code. Use only your own files; it is not a sandbox or a player install path.\n\n' +
        'Run the preflight from the repository root:\n\n' +
        '```sh\nnode tools/validate-plugin.mjs assets/plugins/' + id + '\n```\n\n' +
        'To create a ZIP for code review or transfer, run `node tools/package-plugin.mjs assets/plugins/' + id + '`, then verify it with `node tools/verify-plugin-package.mjs ' + id + '-' + manifest.version + '.parkplugin`. The packager validates first, includes only declared runtime files, and adds SHA-256 file metadata; the verifier checks structure and hashes without extraction. Hashes detect corruption but do not authenticate authors. The archive does not install or sandbox code. The validator parses declared JavaScript for syntax errors without running it. These tools do not review behavior or make code safe. See ' +
        '[the manifest schema](../plugin-manifest.schema.json) and the [plugin authoring guide](../../../wiki/current/plugins/).\n';
    await writeFile(path.join(destination, 'README.md'), readme, 'utf8');

    process.stdout.write(`Created ${path.relative(process.cwd(), destination)}. It is not registered or loaded by Parkoreen.\n`);
    process.stdout.write(`Next: edit plugin.json and js/inject.js, then run node tools/validate-plugin.mjs assets/plugins/${id}.\n`);
} catch (error) {
    if (createdDirectory) await rm(destination, { recursive: true, force: true });
    process.stderr.write(`Plugin scaffold failed: ${error.message}\n`);
    process.exit(1);
}
