#!/usr/bin/env node

import { createReadStream, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeChecks = [
    { route: '/tools/hk-pogo-runtime-check.html', description: 'Hollow Knight pogo' },
    { route: '/tools/mechanics-roundtrip-runtime-check.html', description: 'Mechanics save/load' },
    {
        route: '/tools/device-ui-runtime-check.html',
        description: 'Device-specific UI and hybrid input',
        pageOptions: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    },
    { route: '/tools/tile-cache-runtime-check.html', description: 'Tile cache and regional editor mesh' }
];

const contentTypes = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.webp', 'image/webp'],
    ['.mp3', 'audio/mpeg'],
    ['.ogg', 'audio/ogg'],
    ['.ttf', 'font/ttf']
]);

const server = createServer((request, response) => {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    } catch {
        response.writeHead(400).end('Bad request');
        return;
    }

    const filePath = path.resolve(repositoryRoot, `.${pathname}`);
    if (!filePath.startsWith(`${repositoryRoot}${path.sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
    }

    try {
        if (!statSync(filePath).isFile()) throw new Error('not a file');
    } catch {
        response.writeHead(404).end('Not found');
        return;
    }

    response.writeHead(200, {
        'Content-Type': contentTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    createReadStream(filePath).pipe(response);
});

let browser;
const summaryLines = ['## Browser runtime checks', ''];
try {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    browser = await chromium.launch({ headless: true });

    let failures = 0;
    for (const check of runtimeChecks) {
        const page = await browser.newPage(check.pageOptions || {});
        try {
            await page.goto(`http://127.0.0.1:${address.port}${check.route}`, { waitUntil: 'load' });
            await page.waitForFunction(() => {
                const text = document.querySelector('#results')?.textContent?.trim();
                if (!text || text.startsWith('Loading')) return false;
                try {
                    const report = JSON.parse(text);
                    return Number.isInteger(report.total) && Number.isInteger(report.passed);
                } catch {
                    return true;
                }
            }, null, { timeout: 90000 });

            const report = await page.locator('#results').evaluate(node => {
                try {
                    return JSON.parse(node.textContent);
                } catch {
                    const text = node.textContent.trim();
                    const summary = text.match(/^(PASS|FAIL) \((\d+)\/(\d+)\)/);
                    if (!summary) return { error: text };
                    const checks = text.split('\n').slice(1)
                        .filter(line => /^(PASS|FAIL) /.test(line))
                        .map(line => ({ passed: line.startsWith('PASS '), label: line }));
                    return {
                        total: Number(summary[3]),
                        passed: Number(summary[2]),
                        checks
                    };
                }
            });
            const passed = Number.isInteger(report.passed) ? report.passed : 0;
            const total = Number.isInteger(report.total) ? report.total : 0;
            const failedCases = (report.results || report.checks || []).filter(result => !result.passed);
            if (report.error || total === 0 || passed !== total || failedCases.length) {
                failures++;
                process.stderr.write(`FAIL ${check.description}: ${passed}/${total} passed\n`);
                summaryLines.push(`- **FAIL** ${check.description}: ${passed}/${total} passed`);
                for (const failed of failedCases) {
                    process.stderr.write(`  ${failed.label || 'unnamed check'}\n`);
                    summaryLines.push(`  - ${failed.label || 'unnamed check'}`);
                    if (failed.details !== undefined) {
                        const details = JSON.stringify(failed.details);
                        process.stderr.write(`    details: ${details}\n`);
                        summaryLines.push(`    - Details: \`${details.slice(0, 1000)}\``);
                    }
                }
                if (report.error) process.stderr.write(`  ${report.error}\n`);
                if (report.error) summaryLines.push(`  - ${report.error.slice(0, 500)}`);
            } else {
                process.stdout.write(`PASS ${check.description}: ${passed}/${total}\n`);
                summaryLines.push(`- **PASS** ${check.description}: ${passed}/${total}`);
            }
        } catch (error) {
            failures++;
            process.stderr.write(`FAIL ${check.description}: ${error.message}\n`);
            summaryLines.push(`- **FAIL** ${check.description}: ${error.message.slice(0, 500)}`);
        } finally {
            await page.close();
        }
    }

    if (failures) process.exitCode = 1;
} finally {
    await browser?.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summaryLines.join('\n')}\n`);
    }
}
