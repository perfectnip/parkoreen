#!/usr/bin/env node

import { lstat, readFile, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES } from './plugin-package-limits.mjs';

const API_VERSION = 1;
const PLUGIN_ID = /^[a-z0-9][a-z0-9_-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SCRIPT_ROLES = new Set(['skulpt', 'skulptStdlib', 'pythonCompiler', 'globals', 'inject', 'script', 'editor', 'editorUi']);
const CONFIG_TYPES = new Set(['boolean', 'number', 'select', 'string']);
const CORE_MOVEMENT_CONTROLS = new Set(['left', 'right', 'up', 'down', 'jump', 'shift', 'space']);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const registeredPluginsDirectory = path.resolve(scriptDirectory, '../assets/plugins');

const errors = [];
const warnings = [];
const declaredAssets = new Set();
let declaredAssetBytes = 0;
const javascriptScripts = new Map();
const pluginPath = process.argv[2];

if (!pluginPath) {
    process.stderr.write('Usage: node tools/validate-plugin.mjs <plugin-directory>\n');
    process.exit(2);
}

const addError = message => errors.push(message);
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isInside = (root, candidate) => candidate.startsWith(root + path.sep);

let root;
let manifest;
try {
    const suppliedRoot = path.resolve(process.cwd(), pluginPath);
    const directoryStat = await lstat(suppliedRoot);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('path is not a regular directory');
    root = await realpath(suppliedRoot);
    const manifestPath = path.join(root, 'plugin.json');
    const manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('plugin.json must be a regular file');
    if (manifestStat.size > MAX_FILE_BYTES) throw new Error(`plugin.json exceeds the ${MAX_FILE_BYTES} byte per-file limit`);
    declaredAssetBytes = manifestStat.size;
    const resolvedManifestPath = await realpath(manifestPath);
    if (!isInside(root, resolvedManifestPath)) throw new Error('plugin.json resolves outside the plugin folder');
    manifest = JSON.parse(await readFile(resolvedManifestPath, 'utf8'));
} catch (error) {
    process.stderr.write(`Plugin validation failed: ${error.message}\n`);
    process.exit(1);
}

const folderId = path.basename(root);
if (!isPlainObject(manifest)) addError('plugin.json must contain a JSON object');
if (isPlainObject(manifest)) {
    if (Object.hasOwn(manifest, 'permissions')) addError('permissions are unsupported in API v1; declarations are not enforced by the trusted page runtime');
    if (!PLUGIN_ID.test(folderId)) addError(`Plugin folder name "${folderId}" is not a valid lowercase id`);
    if (manifest.id !== folderId) addError(`Manifest id must match the folder name "${folderId}"`);
    if (manifest.apiVersion !== API_VERSION) addError(`apiVersion must be ${API_VERSION}`);
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) addError('name must be a non-empty string');
    if (typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) addError('version must use MAJOR.MINOR.PATCH with an optional prerelease suffix');
    if (typeof manifest.description !== 'string' || !manifest.description.trim()) addError('description must be a non-empty string');
    if (typeof manifest.author !== 'string' || !manifest.author.trim()) addError('author must be a non-empty string');
    if (manifest.color !== undefined && (typeof manifest.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(manifest.color))) {
        addError('color must be a six-digit hexadecimal color such as #667eea');
    }
    if (manifest.icon !== undefined && (typeof manifest.icon !== 'string' || !manifest.icon.trim() || manifest.icon.length > 32)) {
        addError('icon must be a non-empty string up to 32 characters');
    }
    if (manifest.coverHeight !== undefined && (typeof manifest.coverHeight !== 'number' || !Number.isFinite(manifest.coverHeight) || manifest.coverHeight < 1 || manifest.coverHeight > 600)) {
        addError('coverHeight must be a finite number from 1 to 600');
    }
    if (manifest.beta !== undefined && typeof manifest.beta !== 'boolean') addError('beta must be boolean');
    if (manifest.hideInPluginLibrary !== undefined && typeof manifest.hideInPluginLibrary !== 'boolean') addError('hideInPluginLibrary must be boolean');
    if (manifest.features !== undefined) {
        if (!Array.isArray(manifest.features)) {
            addError('features must be an array of feature ids');
        } else {
            const seenFeatures = new Set();
            for (const feature of manifest.features) {
                if (typeof feature !== 'string' || !/^[a-z][A-Za-z0-9_-]{0,63}$/.test(feature)) addError(`Invalid feature id: ${String(feature)}`);
                if (seenFeatures.has(feature)) addError(`Duplicate feature id: ${String(feature)}`);
                seenFeatures.add(feature);
            }
        }
    }

    const dependencies = manifest.dependencies ?? [];
    if (!Array.isArray(dependencies)) {
        addError('dependencies must be an array of plugin ids');
    } else {
        const seen = new Set();
        for (const dependency of dependencies) {
            if (typeof dependency !== 'string' || !PLUGIN_ID.test(dependency)) addError(`Invalid dependency id: ${String(dependency)}`);
            if (dependency === manifest.id) addError('A plugin cannot depend on itself');
            if (seen.has(dependency)) addError(`Duplicate dependency: ${dependency}`);
            seen.add(dependency);
        }
    }

    const scripts = manifest.scripts;
    if (!isPlainObject(scripts) || Object.keys(scripts).length === 0) {
        addError('scripts must be a non-empty object');
    } else {
        for (const [role, assetPath] of Object.entries(scripts)) {
            if (!SCRIPT_ROLES.has(role)) addError(`Unknown script role "${role}"`);
            if (typeof assetPath === 'string' && path.extname(assetPath).toLowerCase() !== '.js') {
                addError(`scripts.${role} must point to a .js file`);
            }
            await checkAsset(assetPath, `scripts.${role}`);
            if (typeof assetPath === 'string' && path.extname(assetPath).toLowerCase() === '.js') {
                const roles = javascriptScripts.get(assetPath) || [];
                roles.push(role);
                javascriptScripts.set(assetPath, roles);
            }
        }
    }

    if (manifest.cover !== undefined) await checkAsset(manifest.cover, 'cover');

    if (manifest.assets !== undefined) {
        if (!isPlainObject(manifest.assets)) {
            addError('assets must be an object of asset names to file paths');
        } else {
            for (const [assetName, assetPath] of Object.entries(manifest.assets)) {
                if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(assetName)) addError(`Invalid asset name "${assetName}"`);
                await checkAsset(assetPath, `assets.${assetName}`);
            }
        }
    }

    if (manifest.sounds !== undefined) {
        if (!isPlainObject(manifest.sounds)) {
            addError('sounds must be an object of sound names to file paths');
        } else {
            for (const [soundName, soundPaths] of Object.entries(manifest.sounds)) {
                if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(soundName)) addError(`Invalid sound name "${soundName}"`);
                const paths = Array.isArray(soundPaths) ? soundPaths : [soundPaths];
                if (paths.length === 0) addError(`sounds.${soundName} must declare at least one file`);
                for (const [index, assetPath] of paths.entries()) {
                    await checkAsset(assetPath, `sounds.${soundName}[${index}]`);
                }
            }
        }
    }

    await validateControls(manifest.controls);
    validateEditorFeatures(manifest.editorFeatures);
    validateWorldObjectGuards(manifest.worldObjectGuards);
    validateConfig(manifest.config);
    if (isPlainObject(manifest.config)) {
        for (const [key, field] of Object.entries(manifest.config)) {
            if (field?.showIf !== undefined && (typeof field.showIf !== 'string' || !Object.hasOwn(manifest.config, field.showIf) || manifest.config[field.showIf]?.type !== 'boolean')) {
                addError(`config.${key}.showIf must name a boolean config field`);
            }
        }
    }
    await validateDependencyGraph(manifest);
}

for (const [assetPath, roles] of javascriptScripts) {
    // Parse only files that passed containment and regular-file validation.
    if (!declaredAssets.has(assetPath)) continue;
    try {
        const source = await readFile(path.join(root, assetPath), 'utf8');
        new Script(source, { filename: path.join(root, assetPath) });
    } catch (error) {
        addError(`JavaScript syntax error in ${assetPath} (scripts.${roles.join(', scripts.')}): ${error.message}`);
    }
}

async function checkAsset(assetPath, field) {
    if (typeof assetPath !== 'string' || !assetPath || !/^[A-Za-z0-9._/-]+$/.test(assetPath) ||
        assetPath.startsWith('/') || assetPath.includes('\\') || assetPath.includes(':')) {
        addError(`${field} must be a relative path inside the plugin folder`);
        return;
    }
    const segments = assetPath.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
        addError(`${field} contains an unsafe path segment`);
        return;
    }

    let candidate = root;
    try {
        for (const segment of segments) {
            candidate = path.join(candidate, segment);
            const stat = await lstat(candidate);
            if (stat.isSymbolicLink()) {
                addError(`${field} must not point through a symbolic link`);
                return;
            }
        }
        const resolved = await realpath(candidate);
        if (!isInside(root, resolved)) {
            addError(`${field} resolves outside the plugin folder`);
            return;
        }
        const stat = await lstat(resolved);
        if (!stat.isFile()) {
            addError(`${field} must point to a regular file`);
            return;
        }
        if (stat.size > MAX_FILE_BYTES) {
            addError(`${field} exceeds the ${MAX_FILE_BYTES} byte per-file limit`);
            return;
        }
        if (!declaredAssets.has(assetPath)) {
            if (declaredAssets.size + 3 > MAX_FILES) {
                addError(`declared files exceed the ${MAX_FILES}-file package limit`);
                return;
            }
            if (declaredAssetBytes + stat.size > MAX_TOTAL_BYTES) {
                addError(`plugin files exceed the ${MAX_TOTAL_BYTES} byte package limit`);
                return;
            }
            declaredAssetBytes += stat.size;
        }
        declaredAssets.add(assetPath);
    } catch {
        addError(`${field} does not exist: ${assetPath}`);
    }
}

function validateConfig(config) {
    if (!isPlainObject(config)) {
        addError('config must be an object');
        return;
    }
    for (const [key, field] of Object.entries(config)) {
        if (!isPlainObject(field)) {
            addError(`config.${key} must be an object`);
            continue;
        }
        if (!CONFIG_TYPES.has(field.type)) addError(`config.${key}.type must be boolean, number, select, or string`);
        if (!Object.hasOwn(field, 'default')) addError(`config.${key} must define a default`);
        if (field.type === 'boolean' && typeof field.default !== 'boolean') addError(`config.${key}.default must be boolean`);
        if (field.type === 'number') {
            if (typeof field.default !== 'number' || !Number.isFinite(field.default)) addError(`config.${key}.default must be a finite number`);
            if (field.min !== undefined && (typeof field.min !== 'number' || !Number.isFinite(field.min))) addError(`config.${key}.min must be a finite number`);
            if (field.max !== undefined && (typeof field.max !== 'number' || !Number.isFinite(field.max))) addError(`config.${key}.max must be a finite number`);
            if (typeof field.min === 'number' && typeof field.max === 'number' && field.min > field.max) addError(`config.${key}.min cannot exceed max`);
            if (typeof field.default === 'number' && typeof field.min === 'number' && field.default < field.min) addError(`config.${key}.default is below min`);
            if (typeof field.default === 'number' && typeof field.max === 'number' && field.default > field.max) addError(`config.${key}.default is above max`);
        }
        if (field.type === 'string' && typeof field.default !== 'string') addError(`config.${key}.default must be a string`);
        if (field.description !== undefined && typeof field.description !== 'string') addError(`config.${key}.description must be a string`);
        if (field.type === 'select') {
            if (!Array.isArray(field.options) || field.options.length === 0) {
                addError(`config.${key}.options must contain at least one choice`);
            } else {
                const values = new Set();
                for (const option of field.options) {
                    if (!isPlainObject(option) || !Object.hasOwn(option, 'value') || typeof option.label !== 'string' || !option.label.trim()) {
                        addError(`config.${key}.options entries need a value and non-empty label`);
                        continue;
                    }
                    if (!['string', 'number', 'boolean'].includes(typeof option.value) || (typeof option.value === 'number' && !Number.isFinite(option.value))) {
                        addError(`config.${key}.options values must be strings, finite numbers, or booleans`);
                    }
                    const valueKey = `${typeof option.value}:${String(option.value)}`;
                    if (values.has(valueKey)) addError(`config.${key}.options contains a duplicate value`);
                    values.add(valueKey);
                }
                if (!values.has(`${typeof field.default}:${String(field.default)}`)) addError(`config.${key}.default must match an option value`);
            }
        }
        if (field.label !== undefined && (typeof field.label !== 'string' || !field.label.trim())) addError(`config.${key}.label must be a non-empty string`);
    }
}

async function validateControls(controls) {
    if (controls === undefined) return;
    if (!isPlainObject(controls)) {
        addError('controls must be an object of control ids to definitions');
        return;
    }
    for (const [id, control] of Object.entries(controls)) {
        if (!/^[a-z][A-Za-z0-9_-]{0,63}$/.test(id)) addError(`Invalid control id "${id}"`);
        if (CORE_MOVEMENT_CONTROLS.has(id)) addError(`controls.${id} is reserved for Parkoreen movement input; choose a plugin-specific id`);
        if (!isPlainObject(control)) {
            addError(`controls.${id} must be an object`);
            continue;
        }
        if (typeof control.key !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(control.key)) addError(`controls.${id}.key must be a keyboard code such as KeyX or ArrowUp`);
        if (typeof control.label !== 'string' || !control.label.trim() || control.label.length > 64) addError(`controls.${id}.label must be a non-empty string up to 64 characters`);
        if (control.description !== undefined && (typeof control.description !== 'string' || control.description.length > 256)) addError(`controls.${id}.description must be a string up to 256 characters`);
        for (const property of Object.keys(control)) {
            if (!['key', 'label', 'description'].includes(property)) addError(`Unknown control field controls.${id}.${property}`);
        }
    }
    await checkRegisteredControlIds(controls);
}

async function checkRegisteredControlIds(controls) {
    let registeredIds = [];
    try {
        const registryPath = path.join(registeredPluginsDirectory, 'manifest.json');
        const registryStat = await lstat(registryPath);
        if (!registryStat.isFile() || registryStat.isSymbolicLink()) return;
        const registry = JSON.parse(await readFile(registryPath, 'utf8'));
        registeredIds = Array.isArray(registry.plugins) ? registry.plugins : [];
    } catch {
        return;
    }

    for (const pluginId of registeredIds) {
        if (typeof pluginId !== 'string' || !PLUGIN_ID.test(pluginId) || pluginId === folderId) continue;
        try {
            const pluginDirectory = path.join(registeredPluginsDirectory, pluginId);
            const directoryStat = await lstat(pluginDirectory);
            if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) continue;
            const manifestPath = path.join(pluginDirectory, 'plugin.json');
            const manifestStat = await lstat(manifestPath);
            if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) continue;
            const registered = JSON.parse(await readFile(manifestPath, 'utf8'));
            const overlap = Object.keys(controls).find(controlId => Object.hasOwn(registered?.controls || {}, controlId));
            if (overlap) addError(`controls.${overlap} is already declared by registered plugin "${pluginId}"; choose a unique control id`);
        } catch {
            // A malformed unrelated bundled manifest should not prevent validating this plugin.
        }
    }
}

async function validateDependencyGraph(targetManifest) {
    if (!isPlainObject(targetManifest) || !PLUGIN_ID.test(folderId)) return;
    const manifests = new Map([[folderId, targetManifest]]);
    const candidateDirectories = new Set();
    for (const parent of new Set([path.dirname(root), registeredPluginsDirectory])) {
        try {
            for (const entry of (await readdir(parent, { withFileTypes: true })).slice(0, 256)) {
                if (entry.isDirectory() && PLUGIN_ID.test(entry.name)) {
                    candidateDirectories.add(path.join(parent, entry.name));
                }
            }
        } catch {
            // Missing or inaccessible optional plugin directories do not block preflight.
        }
    }

    for (const directory of candidateDirectories) {
        try {
            const directoryStat = await lstat(directory);
            if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) continue;
            const manifestPath = path.join(directory, 'plugin.json');
            const manifestStat = await lstat(manifestPath);
            if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) continue;
            const resolved = await realpath(manifestPath);
            if (!isInside(path.dirname(await realpath(directory)), resolved)) continue;
            const candidate = JSON.parse(await readFile(resolved, 'utf8'));
            if (!isPlainObject(candidate) || candidate.id !== path.basename(directory) || !PLUGIN_ID.test(candidate.id)) continue;
            manifests.set(candidate.id, candidate);
        } catch {
            // An unrelated malformed plugin should not prevent author preflight.
        }
    }
    // A supplied source directory is the validation target even if its id
    // matches a registered plugin id in the same repository.
    manifests.set(folderId, targetManifest);

    const visiting = [];
    const visited = new Set();
    const unresolved = new Set();
    let reportedCycle = false;
    const visit = id => {
        if (visited.has(id)) return;
        const cycleIndex = visiting.indexOf(id);
        if (cycleIndex !== -1) {
            if (!reportedCycle) {
                addError(`Plugin dependency cycle: ${[...visiting.slice(cycleIndex), id].join(' -> ')}`);
                reportedCycle = true;
            }
            return;
        }
        const current = manifests.get(id);
        if (!current) {
            unresolved.add(id);
            return;
        }
        visiting.push(id);
        for (const dependency of Array.isArray(current.dependencies) ? current.dependencies : []) {
            if (typeof dependency === 'string' && PLUGIN_ID.test(dependency)) visit(dependency);
        }
        visiting.pop();
        visited.add(id);
    };
    visit(folderId);
    if (unresolved.size) {
        warnings.push(`Unresolved dependency ids: ${[...unresolved].sort().join(', ')}. They are not present in the bundled registry or alongside this plugin, so preview/runtime compatibility cannot be checked locally.`);
    }
}

function validateEditorFeatures(features) {
    if (features === undefined) return;
    if (!isPlainObject(features)) {
        addError('editorFeatures must be an object of feature ids to booleans');
        return;
    }
    for (const [id, enabled] of Object.entries(features)) {
        if (!/^[a-z][A-Za-z0-9_-]{0,63}$/.test(id)) addError(`Invalid editor feature id "${id}"`);
        if (typeof enabled !== 'boolean') addError(`editorFeatures.${id} must be boolean`);
    }
}

function validateWorldObjectGuards(guards) {
    if (guards === undefined) return;
    if (!Array.isArray(guards) || guards.length > 128) {
        addError('worldObjectGuards must be an array with at most 128 rules');
        return;
    }
    for (const [index, guard] of guards.entries()) {
        const field = `worldObjectGuards[${index}]`;
        if (!isPlainObject(guard)) {
            addError(`${field} must be an object`);
            continue;
        }
        if (!['type', 'actingType', 'appearanceType'].some(key => typeof guard[key] === 'string' && guard[key].trim())) {
            addError(`${field} must match at least one of type, actingType, or appearanceType`);
        }
        for (const key of ['type', 'actingType', 'appearanceType']) {
            if (guard[key] !== undefined && (typeof guard[key] !== 'string' || !guard[key].trim() || guard[key].length > 128)) addError(`${field}.${key} must be a non-empty string up to 128 characters`);
        }
        for (const key of ['section', 'name']) {
            const limit = key === 'section' ? 64 : 128;
            if (guard[key] !== undefined && (typeof guard[key] !== 'string' || !guard[key].trim() || guard[key].length > limit)) addError(`${field}.${key} must be a non-empty string up to ${limit} characters`);
        }
        for (const key of Object.keys(guard)) {
            if (!['type', 'actingType', 'appearanceType', 'section', 'name'].includes(key)) addError(`Unknown field ${field}.${key}`);
        }
    }
}

if (errors.length) {
    process.stderr.write(`Plugin validation failed for ${folderId}:\n${errors.map(error => `- ${error}`).join('\n')}\n`);
    if (warnings.length) process.stderr.write(`Warnings:\n${warnings.map(warning => `- ${warning}`).join('\n')}\n`);
    process.exitCode = 1;
} else {
    process.stdout.write(`Plugin "${manifest.id}" is valid (API v${API_VERSION}; ${declaredAssets.size} declared files found; ${javascriptScripts.size} JavaScript syntax checks passed).\n`);
    if (warnings.length) process.stdout.write(`Dependency warnings:\n${warnings.map(warning => `- ${warning}`).join('\n')}\n`);
    process.stdout.write('JavaScript is parsed but never run. This does not review behavior, restrict capabilities, or sandbox plugin code.\n');
}
