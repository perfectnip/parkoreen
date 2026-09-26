#!/usr/bin/env node

import { deflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import {
    lstat,
    link,
    mkdir,
    readFile,
    realpath,
    rename,
    unlink,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES } from './plugin-package-limits.mjs';
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const validatorPath = path.join(scriptDirectory, 'validate-plugin.mjs');
const argumentsList = process.argv.slice(2);
const force = argumentsList.includes('--force');
const positionalArguments = argumentsList.filter(argument => argument !== '--force');
const suppliedPluginPath = positionalArguments[0];
const suppliedOutputPath = positionalArguments[1];

if (!suppliedPluginPath || suppliedPluginPath === '--help' || suppliedPluginPath === '-h') {
    process.stdout.write('Usage: node tools/package-plugin.mjs <plugin-directory> [output.parkplugin] [--force]\n');
    process.stdout.write('Validates an API v1 plugin and writes a ZIP package of its manifest and declared runtime assets.\n');
    process.stdout.write('The package is not installed, registered, or executed. Default size limits: 64 MiB per file, 128 MiB total.\n');
    process.exit(suppliedPluginPath ? 0 : 2);
}
if (positionalArguments.length > 2) {
    process.stderr.write('Plugin packaging failed: provide one source directory and at most one output path.\n');
    process.exit(2);
}

const suppliedRoot = path.resolve(process.cwd(), suppliedPluginPath);
let root;
let manifest;
let outputPath;
let temporaryPath;

try {
    const rootStat = await lstat(suppliedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('plugin path must be a regular directory');
    root = await realpath(suppliedRoot);

    const validation = spawnSync(process.execPath, [validatorPath, root], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024
    });
    if (validation.error) throw validation.error;
    if (validation.status !== 0) {
        process.stderr.write(validation.stdout || '');
        process.stderr.write(validation.stderr || '');
        throw new Error('plugin preflight failed; package was not created');
    }

    const manifestPath = path.join(root, 'plugin.json');
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const assetPaths = collectDeclaredAssets(manifest);
    if (assetPaths.includes('plugin.json') || assetPaths.includes('plugin-package.json')) {
        throw new Error('plugin.json and plugin-package.json are reserved package files');
    }
    if (assetPaths.length + 2 > MAX_FILES) throw new Error(`package exceeds the ${MAX_FILES}-file limit`);

    const outputName = suppliedOutputPath || `${manifest.id}-${manifest.version}.parkplugin`;
    outputPath = path.resolve(process.cwd(), outputName);
    if (outputPath === root || isInside(root, outputPath)) {
        throw new Error('output package must be outside the plugin source directory');
    }

    const entries = [];
    let totalBytes = 0;
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    if (manifestBytes.length > MAX_FILE_BYTES) throw new Error(`plugin.json exceeds the ${MAX_FILE_BYTES} byte per-file limit`);
    const packageFiles = [{ path: 'plugin.json', data: manifestBytes }];

    for (const assetPath of assetPaths) {
        const data = await readDeclaredFile(root, assetPath);
        if (data.length > MAX_FILE_BYTES) throw new Error(`${assetPath} exceeds the ${MAX_FILE_BYTES} byte per-file limit`);
        totalBytes += data.length;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`package exceeds the ${MAX_TOTAL_BYTES} byte uncompressed size limit`);
        packageFiles.push({ path: assetPath, data });
    }
    for (const file of packageFiles) {
        file.sha256 = createHash('sha256').update(file.data).digest('hex');
        file.bytes = file.data.length;
        entries.push({ name: `${manifest.id}/${file.path}`, data: file.data });
    }
    const packageInfo = {
        $schema: 'https://parkoreen.com/schemas/plugin-package-v1.json',
        formatVersion: 1,
        plugin: { id: manifest.id, version: manifest.version, apiVersion: manifest.apiVersion },
        files: packageFiles.map(({ path: filePath, sha256, bytes }) => ({ path: filePath, bytes, sha256 }))
    };
    const packageInfoBytes = Buffer.from(`${JSON.stringify(packageInfo, null, 2)}\n`);
    entries.push({ name: `${manifest.id}/plugin-package.json`, data: packageInfoBytes });
    totalBytes += manifestBytes.length + packageInfoBytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`package exceeds the ${MAX_TOTAL_BYTES} byte uncompressed size limit`);

    const archive = createZip(entries);
    await mkdir(path.dirname(outputPath), { recursive: true });
    temporaryPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, archive, { flag: 'wx' });
    if (force) {
        const existing = await lstat(outputPath).catch(() => null);
        if (existing) {
            if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('forced output must replace a regular file');
            await unlink(outputPath);
        }
        await rename(temporaryPath, outputPath);
    } else {
        await link(temporaryPath, outputPath);
        await unlink(temporaryPath);
    }
    temporaryPath = null;

    process.stdout.write(`Packaged ${manifest.id}@${manifest.version} to ${path.relative(process.cwd(), outputPath) || path.basename(outputPath)}.\n`);
    process.stdout.write(`${entries.length} files, ${totalBytes} uncompressed bytes. Only declared runtime assets were included.\n`);
    process.stdout.write('This ZIP package is for review and transfer. Parkoreen does not install or execute community packages.\n');
} catch (error) {
    if (temporaryPath) await unlink(temporaryPath).catch(() => {});
    process.stderr.write(`Plugin packaging failed: ${error.message}\n`);
    process.exitCode = 1;
}

function collectDeclaredAssets(pluginManifest) {
    const files = new Set();
    for (const assetPath of Object.values(pluginManifest.scripts || {})) files.add(assetPath);
    if (pluginManifest.cover) files.add(pluginManifest.cover);
    for (const assetPath of Object.values(pluginManifest.assets || {})) files.add(assetPath);
    for (const soundPaths of Object.values(pluginManifest.sounds || {})) {
        for (const assetPath of Array.isArray(soundPaths) ? soundPaths : [soundPaths]) files.add(assetPath);
    }
    return [...files].sort();
}

async function readDeclaredFile(pluginRoot, assetPath) {
    if (typeof assetPath !== 'string' || !assetPath || assetPath.includes('\\') || path.isAbsolute(assetPath)) {
        throw new Error(`unsafe declared asset path: ${String(assetPath)}`);
    }
    const segments = assetPath.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
        throw new Error(`unsafe declared asset path: ${assetPath}`);
    }

    let candidate = pluginRoot;
    for (const segment of segments) {
        candidate = path.join(candidate, segment);
        const stat = await lstat(candidate);
        if (stat.isSymbolicLink()) throw new Error(`${assetPath} must not pass through a symbolic link`);
    }
    const resolved = await realpath(candidate);
    if (!isInside(pluginRoot, resolved)) throw new Error(`${assetPath} resolves outside the plugin directory`);
    const stat = await lstat(resolved);
    if (!stat.isFile()) throw new Error(`${assetPath} must be a regular file`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`${assetPath} exceeds the ${MAX_FILE_BYTES} byte per-file limit`);
    return readFile(resolved);
}

function isInside(rootPath, candidatePath) {
    return candidatePath.startsWith(rootPath + path.sep);
}

function createZip(entries) {
    if (entries.length > 0xffff) throw new Error('ZIP32 supports at most 65,535 files');
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    const crcTable = createCrcTable();

    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const compressed = deflateRawSync(entry.data, { level: 9 });
        const crc = crc32(entry.data, crcTable);
        if (name.length > 0xffff || localOffset + compressed.length > 0xffffffff) {
            throw new Error('package exceeds ZIP32 size limits');
        }

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(0x0800, 6);
        localHeader.writeUInt16LE(8, 8);
        localHeader.writeUInt16LE(0, 10);
        localHeader.writeUInt16LE(0x0021, 12);
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(compressed.length, 18);
        localHeader.writeUInt32LE(entry.data.length, 22);
        localHeader.writeUInt16LE(name.length, 26);
        localHeader.writeUInt16LE(0, 28);
        localParts.push(localHeader, name, compressed);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0);
        centralHeader.writeUInt16LE(20, 4);
        centralHeader.writeUInt16LE(20, 6);
        centralHeader.writeUInt16LE(0x0800, 8);
        centralHeader.writeUInt16LE(8, 10);
        centralHeader.writeUInt16LE(0, 12);
        centralHeader.writeUInt16LE(0x0021, 14);
        centralHeader.writeUInt32LE(crc, 16);
        centralHeader.writeUInt32LE(compressed.length, 20);
        centralHeader.writeUInt32LE(entry.data.length, 24);
        centralHeader.writeUInt16LE(name.length, 28);
        centralHeader.writeUInt16LE(0, 30);
        centralHeader.writeUInt16LE(0, 32);
        centralHeader.writeUInt16LE(0, 34);
        centralHeader.writeUInt16LE(0, 36);
        centralHeader.writeUInt32LE(0, 38);
        centralHeader.writeUInt32LE(localOffset, 42);
        centralParts.push(centralHeader, name);

        localOffset += localHeader.length + name.length + compressed.length;
    }

    const centralDirectory = Buffer.concat(centralParts);
    const endRecord = Buffer.alloc(22);
    endRecord.writeUInt32LE(0x06054b50, 0);
    endRecord.writeUInt16LE(0, 4);
    endRecord.writeUInt16LE(0, 6);
    endRecord.writeUInt16LE(entries.length, 8);
    endRecord.writeUInt16LE(entries.length, 10);
    endRecord.writeUInt32LE(centralDirectory.length, 12);
    endRecord.writeUInt32LE(localOffset, 16);
    endRecord.writeUInt16LE(0, 20);
    return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

function createCrcTable() {
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        table[index] = value >>> 0;
    }
    return table;
}

function crc32(data, table) {
    let crc = 0xffffffff;
    for (const byte of data) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}
