#!/usr/bin/env node

import { createReadStream, watch as watchPath } from 'node:fs';
import { lstat, readFile, realpath, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const previewToken = randomBytes(32).toString('base64url');
const portFlag = process.argv.indexOf('--port');
const requestedPort = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 4173;
if (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535) {
    process.stderr.write('Usage: node tools/serve-plugin-dev.mjs [--port 1024-65535]\n');
    process.exit(2);
}

const contentTypes = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.gif', 'image/gif'],
    ['.html', 'text/html; charset=utf-8'],
    ['.jpeg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.mp3', 'audio/mpeg'],
    ['.ogg', 'audio/ogg'],
    ['.otf', 'font/otf'],
    ['.pkrn', 'application/octet-stream'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
    ['.ttf', 'font/ttf'],
    ['.wasm', 'application/wasm'],
    ['.webmanifest', 'application/manifest+json'],
    ['.webp', 'image/webp'],
    ['.woff', 'font/woff'],
    ['.woff2', 'font/woff2']
]);

const pluginWatchers = new Map();
const pluginWatcherRefreshes = new Map();
const pluginClients = new Map();
const pluginChangeTimers = new Map();
const isInside = (parent, candidate) => candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
const allowedBrowserOrigins = new Set([
    `http://127.0.0.1:${requestedPort}`,
    `http://localhost:${requestedPort}`
]);

async function getLocalPluginDirectory(pluginId) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(pluginId || '')) return null;
    try {
        const pluginsDirectory = await realpath(path.join(repositoryRoot, 'assets', 'plugins'));
        const candidate = path.join(pluginsDirectory, pluginId);
        const entry = await lstat(candidate);
        if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
        const resolved = await realpath(candidate);
        return isInside(pluginsDirectory, resolved) ? resolved : null;
    } catch {
        return null;
    }
}

async function isRegisteredPlugin(pluginId) {
    try {
        const manifestPath = path.join(repositoryRoot, 'assets', 'plugins', 'manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        return Array.isArray(manifest.plugins) && manifest.plugins.includes(pluginId);
    } catch {
        return false;
    }
}

function broadcastPluginChange(pluginId) {
    clearTimeout(pluginChangeTimers.get(pluginId));
    pluginChangeTimers.set(pluginId, setTimeout(() => {
        pluginChangeTimers.delete(pluginId);
        for (const client of pluginClients.get(pluginId) || []) {
            if (!client.destroyed) client.write('event: change\ndata: reload\n\n');
        }
    }, 180));
}

async function refreshPluginWatchers(pluginId) {
    if (pluginWatcherRefreshes.has(pluginId)) return pluginWatcherRefreshes.get(pluginId);
    const refresh = (async () => {
        for (const watcher of pluginWatchers.get(pluginId) || []) watcher.close();
        pluginWatchers.delete(pluginId);
        const pluginRoot = await getLocalPluginDirectory(pluginId);
        if (!pluginRoot) return;

        const watchers = [];
        const visited = new Set();
        const visit = async directory => {
            let resolved;
            try { resolved = await realpath(directory); } catch { return; }
            if (!isInside(pluginRoot, resolved) || visited.has(resolved)) return;
            visited.add(resolved);
            try {
                const watcher = watchPath(resolved, { persistent: true }, (_event, filename) => {
                    broadcastPluginChange(pluginId);
                    if (!filename) return;
                    const changedPath = path.join(resolved, filename.toString());
                    lstat(changedPath).then(entry => {
                        if (entry.isDirectory() && !entry.isSymbolicLink()) {
                            setTimeout(() => refreshPluginWatchers(pluginId), 220);
                        }
                    }).catch(() => {});
                });
                watcher.on('error', () => watcher.close());
                watchers.push(watcher);
            } catch {
                return;
            }
            let entries;
            try { entries = await readdir(resolved, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.')) {
                    await visit(path.join(resolved, entry.name));
                }
            }
        };
        await visit(pluginRoot);
        if (pluginClients.get(pluginId)?.size) pluginWatchers.set(pluginId, watchers);
        else for (const watcher of watchers) watcher.close();
    })();
    pluginWatcherRefreshes.set(pluginId, refresh);
    try { await refresh; } finally { pluginWatcherRefreshes.delete(pluginId); }
}

async function addPluginEventClient(pluginId, response) {
    if (!await getLocalPluginDirectory(pluginId)) return false;
    response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff'
    });
    response.write(': local plugin preview connected\n\n');
    let clients = pluginClients.get(pluginId);
    if (!clients) {
        clients = new Set();
        pluginClients.set(pluginId, clients);
    }
    clients.add(response);
    response.on('close', () => {
        clients.delete(response);
        if (clients.size === 0) {
            pluginClients.delete(pluginId);
            for (const watcher of pluginWatchers.get(pluginId) || []) watcher.close();
            pluginWatchers.delete(pluginId);
        }
    });
    await refreshPluginWatchers(pluginId);
    return true;
}

const server = createServer(async (request, response) => {
    const allowedHosts = new Set([`127.0.0.1:${requestedPort}`, `localhost:${requestedPort}`, `127.0.0.1`, 'localhost']);
    if (!allowedHosts.has(request.headers.host || '')) {
        response.writeHead(421, { 'Cache-Control': 'no-store' });
        response.end('This development server accepts loopback Host headers only');
        return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
        response.end('Method not allowed');
        return;
    }

    let requestUrl;
    let pathname;
    try {
        requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
        pathname = decodeURIComponent(requestUrl.pathname);
    } catch {
        response.writeHead(400, { 'Cache-Control': 'no-store' });
        response.end('Bad request');
        return;
    }

    if (pathname === '/__plugin_dev__/events') {
        if (request.method !== 'GET') {
            response.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
            response.end('Method not allowed');
            return;
        }
        const origin = request.headers.origin;
        if (origin && !allowedBrowserOrigins.has(origin)) {
            response.writeHead(403, { 'Cache-Control': 'no-store', 'Vary': 'Origin' });
            response.end('Cross-origin plugin preview requests are not allowed');
            return;
        }
        if (requestUrl.searchParams.get('token') !== previewToken) {
            response.writeHead(403, { 'Cache-Control': 'no-store' });
            response.end('A valid local plugin preview token is required');
            return;
        }
        const pluginId = requestUrl.searchParams.get('id');
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(pluginId || '')) {
            response.writeHead(400, { 'Cache-Control': 'no-store' });
            response.end('Invalid plugin id');
            return;
        }
        if (!await addPluginEventClient(pluginId, response)) {
            response.writeHead(404, { 'Cache-Control': 'no-store' });
            response.end('Plugin folder not found');
        }
        return;
    }

    if (pathname === '/') {
        response.writeHead(302, { Location: '/parkoreen/', 'Cache-Control': 'no-store' });
        response.end();
        return;
    }
    if (pathname === '/parkoreen') pathname = '/parkoreen/';
    if (!pathname.startsWith('/parkoreen/')) {
        response.writeHead(404, { 'Cache-Control': 'no-store' });
        response.end('Not found');
        return;
    }

    let relativePath = pathname.slice('/parkoreen/'.length);
    if (!relativePath || relativePath.endsWith('/')) relativePath += 'index.html';
    if (relativePath.split(/[\\/]/).some(segment => segment.startsWith('.'))) {
        response.writeHead(404, { 'Cache-Control': 'no-store' });
        response.end('Not found');
        return;
    }
    const pluginAssetMatch = pathname.match(/^\/parkoreen\/assets\/plugins\/([a-z0-9][a-z0-9_-]*)\//);
    if (pluginAssetMatch && !await isRegisteredPlugin(pluginAssetMatch[1]) &&
        requestUrl.searchParams.get('devToken') !== previewToken) {
        response.writeHead(403, { 'Cache-Control': 'no-store' });
        response.end('A valid local plugin preview token is required');
        return;
    }
    const filePath = path.resolve(repositoryRoot, relativePath);
    if (filePath !== repositoryRoot && !filePath.startsWith(`${repositoryRoot}${path.sep}`)) {
        response.writeHead(403, { 'Cache-Control': 'no-store' });
        response.end('Forbidden');
        return;
    }

    try {
        const resolvedFilePath = await realpath(filePath);
        if (resolvedFilePath !== repositoryRoot && !resolvedFilePath.startsWith(`${repositoryRoot}${path.sep}`)) {
            response.writeHead(403, { 'Cache-Control': 'no-store' });
            response.end('Forbidden');
            return;
        }
        const fileStats = await stat(resolvedFilePath);
        if (!fileStats.isFile()) throw new Error('Not a file');
        response.writeHead(200, {
            'Cache-Control': 'no-store',
            'Content-Length': fileStats.size,
            'Content-Type': contentTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff'
        });
        if (request.method === 'HEAD') response.end();
        else createReadStream(resolvedFilePath).pipe(response);
    } catch {
        response.writeHead(404, { 'Cache-Control': 'no-store' });
        response.end('Not found');
    }
});

server.listen(requestedPort, '127.0.0.1', () => {
    process.stdout.write(`Parkoreen local plugin development server: http://127.0.0.1:${requestedPort}/parkoreen/\n`);
    process.stdout.write(`Local plugin preview token: ${previewToken}\n`);
    process.stdout.write(`Example preview: http://127.0.0.1:${requestedPort}/parkoreen/host.html?pluginDev=example&pluginDevToken=${previewToken}\n`);
    process.stdout.write('This server listens only on loopback and sends files with no-store caching.\n');
});
