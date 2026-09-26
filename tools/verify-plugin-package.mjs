#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import process from 'node:process';
import { MAX_ARCHIVE_BYTES, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES } from './plugin-package-limits.mjs';
const CRC_TABLE = createCrcTable();
const packagePath = process.argv[2];

if (!packagePath || packagePath === '--help' || packagePath === '-h') {
    process.stdout.write('Usage: node tools/verify-plugin-package.mjs <package.parkplugin>\n');
    process.stdout.write('Checks package structure, paths, declared files, sizes, CRCs, and SHA-256 hashes without extracting or executing code.\n');
    process.exit(packagePath ? 0 : 2);
}

try {
    const stat = await lstat(path.resolve(packagePath));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('package path must be a regular file');
    if (stat.size > MAX_ARCHIVE_BYTES) throw new Error(`archive exceeds the ${MAX_ARCHIVE_BYTES} byte limit`);
    const archive = await readFile(path.resolve(packagePath));
    const entries = readZipEntries(archive);
    if (entries.length > MAX_FILES) throw new Error(`package exceeds the ${MAX_FILES}-file limit`);

    let totalBytes = 0;
    const files = new Map();
    for (const entry of entries) {
        if (files.has(entry.name)) throw new Error(`duplicate ZIP path: ${entry.name}`);
        if (!isSafeArchivePath(entry.name)) throw new Error(`unsafe ZIP path: ${entry.name}`);
        if (entry.uncompressedSize > MAX_FILE_BYTES) throw new Error(`${entry.name} exceeds the ${MAX_FILE_BYTES} byte per-file limit`);
        totalBytes += entry.uncompressedSize;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`package exceeds the ${MAX_TOTAL_BYTES} byte uncompressed size limit`);
        const content = inflateRawSync(entry.compressedData, { maxOutputLength: MAX_FILE_BYTES });
        if (content.length !== entry.uncompressedSize) throw new Error(`uncompressed size mismatch: ${entry.name}`);
        if (crc32(content) !== entry.crc32) throw new Error(`ZIP CRC mismatch: ${entry.name}`);
        files.set(entry.name, content);
    }

    const metadataPaths = [...files.keys()].filter(name => name.endsWith('/plugin-package.json'));
    if (metadataPaths.length !== 1) throw new Error('package must contain exactly one plugin-package.json');
    const metadataPath = metadataPaths[0];
    const packageRoot = metadataPath.slice(0, -'/plugin-package.json'.length);
    const metadata = parseJson(files.get(metadataPath), metadataPath);
    if (metadata.$schema !== 'https://parkoreen.com/schemas/plugin-package-v1.json' || metadata.formatVersion !== 1) {
        throw new Error('unsupported or malformed package metadata format');
    }
    const plugin = metadata.plugin;
    if (!isPlainObject(plugin) || !/^[a-z0-9][a-z0-9_-]*$/.test(plugin.id || '') ||
        plugin.id !== packageRoot || typeof plugin.version !== 'string' ||
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(plugin.version) || plugin.apiVersion !== 1) {
        throw new Error('package metadata has invalid plugin identity or API version');
    }

    const manifestPath = `${packageRoot}/plugin.json`;
    const manifest = parseJson(files.get(manifestPath), manifestPath);
    if (Object.hasOwn(manifest, 'permissions')) {
        throw new Error('API v1 packages cannot declare permissions because the runtime cannot enforce them');
    }
    if (manifest.id !== plugin.id || manifest.version !== plugin.version || manifest.apiVersion !== plugin.apiVersion) {
        throw new Error('plugin.json identity does not match package metadata');
    }

    if (!Array.isArray(metadata.files) || metadata.files.length === 0 || metadata.files.length + 1 !== files.size) {
        throw new Error('package metadata file list does not match archive contents');
    }
    const declared = new Map();
    for (const descriptor of metadata.files) {
        if (!isPlainObject(descriptor) || !isSafeRelativePath(descriptor.path) ||
            !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0 || descriptor.bytes > MAX_FILE_BYTES ||
            !/^[a-f0-9]{64}$/.test(descriptor.sha256 || '')) {
            throw new Error('package metadata contains an invalid file record');
        }
        if (declared.has(descriptor.path)) throw new Error(`duplicate metadata path: ${descriptor.path}`);
        const content = files.get(`${packageRoot}/${descriptor.path}`);
        if (!content) throw new Error(`metadata file is missing from archive: ${descriptor.path}`);
        if (content.length !== descriptor.bytes) throw new Error(`metadata size mismatch: ${descriptor.path}`);
        const digest = createHash('sha256').update(content).digest('hex');
        if (digest !== descriptor.sha256) throw new Error(`SHA-256 mismatch: ${descriptor.path}`);
        declared.set(descriptor.path, true);
    }
    for (const name of files.keys()) {
        if (!name.startsWith(`${packageRoot}/`)) throw new Error(`unexpected file outside package root: ${name}`);
        const relativePath = name.slice(packageRoot.length + 1);
        if (relativePath !== 'plugin-package.json' && !declared.has(relativePath)) {
            throw new Error(`archive includes a file missing from package metadata: ${relativePath}`);
        }
    }

    const expectedAssets = collectDeclaredAssets(manifest);
    const actualAssets = [...declared.keys()].filter(name => name !== 'plugin.json').sort();
    if (!declared.has('plugin.json') || expectedAssets.length !== actualAssets.length ||
        expectedAssets.some((name, index) => name !== actualAssets[index])) {
        throw new Error('archive files do not match the assets declared by plugin.json');
    }

    process.stdout.write(`Verified ${plugin.id}@${plugin.version}: ${files.size} ZIP entries, ${totalBytes} uncompressed bytes, ${declared.size} SHA-256 records.\n`);
    process.stdout.write('This verifies package integrity and structure only; it does not authenticate the publisher or make plugin code safe.\n');
} catch (error) {
    process.stderr.write(`Plugin package verification failed: ${error.message}\n`);
    process.exitCode = 1;
}

function readZipEntries(archive) {
    const endOffset = archive.length - 22;
    if (endOffset < 0 || archive.readUInt32LE(endOffset) !== 0x06054b50) throw new Error('invalid ZIP end record');
    const diskNumber = archive.readUInt16LE(endOffset + 4);
    const centralDisk = archive.readUInt16LE(endOffset + 6);
    const entriesOnDisk = archive.readUInt16LE(endOffset + 8);
    const entryCount = archive.readUInt16LE(endOffset + 10);
    const centralSize = archive.readUInt32LE(endOffset + 12);
    const centralOffset = archive.readUInt32LE(endOffset + 16);
    const commentLength = archive.readUInt16LE(endOffset + 20);
    if (diskNumber || centralDisk || entriesOnDisk !== entryCount || commentLength ||
        entryCount > MAX_FILES || centralOffset + centralSize !== endOffset) {
        throw new Error('unsupported or malformed ZIP directory');
    }

    const entries = [];
    let cursor = centralOffset;
    for (let index = 0; index < entryCount; index++) {
        if (cursor + 46 > endOffset || archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('invalid ZIP central directory entry');
        const flags = archive.readUInt16LE(cursor + 8);
        const method = archive.readUInt16LE(cursor + 10);
        const crc = archive.readUInt32LE(cursor + 16);
        const compressedSize = archive.readUInt32LE(cursor + 20);
        const uncompressedSize = archive.readUInt32LE(cursor + 24);
        const nameLength = archive.readUInt16LE(cursor + 28);
        const extraLength = archive.readUInt16LE(cursor + 30);
        const fileCommentLength = archive.readUInt16LE(cursor + 32);
        const startDisk = archive.readUInt16LE(cursor + 34);
        const externalAttributes = archive.readUInt32LE(cursor + 38);
        const localOffset = archive.readUInt32LE(cursor + 42);
        const recordEnd = cursor + 46 + nameLength + extraLength + fileCommentLength;
        if (recordEnd > endOffset || flags !== 0x0800 || method !== 8 || extraLength || fileCommentLength ||
            startDisk || externalAttributes || uncompressedSize > MAX_FILE_BYTES || localOffset >= centralOffset) {
            throw new Error('unsupported or unsafe ZIP entry metadata');
        }
        const name = decodeUtf8(archive.subarray(cursor + 46, cursor + 46 + nameLength));
        if (localOffset + 30 > centralOffset || archive.readUInt32LE(localOffset) !== 0x04034b50) {
            throw new Error(`invalid local ZIP header: ${name}`);
        }
        const localFlags = archive.readUInt16LE(localOffset + 6);
        const localMethod = archive.readUInt16LE(localOffset + 8);
        const localCrc = archive.readUInt32LE(localOffset + 14);
        const localCompressedSize = archive.readUInt32LE(localOffset + 18);
        const localUncompressedSize = archive.readUInt32LE(localOffset + 22);
        const localNameLength = archive.readUInt16LE(localOffset + 26);
        const localExtraLength = archive.readUInt16LE(localOffset + 28);
        const localNameStart = localOffset + 30;
        const dataStart = localNameStart + localNameLength + localExtraLength;
        const dataEnd = dataStart + compressedSize;
        if (localFlags !== flags || localMethod !== method || localCrc !== crc ||
            localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize ||
            localNameLength !== nameLength || localExtraLength || dataEnd > centralOffset ||
            !archive.subarray(localNameStart, localNameStart + localNameLength).equals(archive.subarray(cursor + 46, cursor + 46 + nameLength))) {
            throw new Error(`local and central ZIP records disagree: ${name}`);
        }
        entries.push({ name, crc32: crc, uncompressedSize, localOffset, recordEnd: dataEnd, compressedData: archive.subarray(dataStart, dataEnd) });
        cursor = recordEnd;
    }
    if (cursor !== endOffset) throw new Error('ZIP central directory has trailing or missing data');

    const localEntries = [...entries].sort((a, b) => a.localOffset - b.localOffset);
    let expectedOffset = 0;
    for (const entry of localEntries) {
        if (entry.localOffset !== expectedOffset) throw new Error('ZIP local records are overlapping or non-contiguous');
        expectedOffset = entry.recordEnd;
    }
    if (expectedOffset !== centralOffset) throw new Error('unexpected data between ZIP entries and central directory');
    return entries;
}

function decodeUtf8(bytes) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new Error('ZIP entry name is not valid UTF-8');
    }
}

function isSafeArchivePath(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith('/')) return false;
    const segments = value.split('/');
    return segments.length >= 2 && segments.every(segment => segment && segment !== '.' && segment !== '..');
}

function isSafeRelativePath(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith('/')) return false;
    const segments = value.split('/');
    return segments.length > 0 && segments.every(segment => segment && segment !== '.' && segment !== '..');
}

function collectDeclaredAssets(manifest) {
    if (!isPlainObject(manifest) || !isPlainObject(manifest.scripts)) throw new Error('plugin.json has no valid scripts object');
    const assets = new Set(Object.values(manifest.scripts));
    if (manifest.cover) assets.add(manifest.cover);
    if (manifest.assets !== undefined) {
        if (!isPlainObject(manifest.assets)) throw new Error('plugin.json assets field is malformed');
        for (const asset of Object.values(manifest.assets)) assets.add(asset);
    }
    if (manifest.sounds !== undefined) {
        if (!isPlainObject(manifest.sounds)) throw new Error('plugin.json sounds field is malformed');
        for (const soundPaths of Object.values(manifest.sounds)) {
            for (const asset of Array.isArray(soundPaths) ? soundPaths : [soundPaths]) assets.add(asset);
        }
    }
    return [...assets].sort();
}

function parseJson(buffer, label) {
    if (!buffer) throw new Error(`missing ${label}`);
    try {
        return JSON.parse(buffer.toString('utf8'));
    } catch {
        throw new Error(`invalid JSON: ${label}`);
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
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
