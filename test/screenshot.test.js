import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import puppeteer from 'puppeteer';
import sharp from 'sharp';

import {
    buildTilePlan,
    captureUrlAtWidth,
    outputPathFor,
    shouldUseTiledCapture
} from '../screenshot.js';

const TEST_CAPTURE_OPTIONS = {
    viewportHeight: 600,
    longPageHeightThreshold: 2_000,
    tileOverlap: 80,
    initialSettleDelayMs: 10,
    lazyScrollDelayMs: 10,
    tileSettleDelayMs: 20,
    imageLoadTimeoutMs: 500
};

let browser;
let server;
let baseUrl;
let outputDirectory;

function pageHtml(body, styles = '', script = '') {
    return `<!doctype html>
        <html>
            <head>
                <meta charset="utf-8">
                <style>
                    html, body { margin: 0; padding: 0; }
                    ${styles}
                </style>
            </head>
            <body>
                ${body}
                ${script ? `<script>${script}</script>` : ''}
            </body>
        </html>`;
}

function fixtureFor(pathname) {
    if (pathname === '/normal') {
        return pageHtml(
            '<main></main><footer></footer>',
            'main { height: 1200px; background: #2864dc; } footer { height: 200px; background: #00a050; }'
        );
    }

    if (pathname === '/practice-areas/personal-injury-lawyers/') {
        const colors = ['#2447a8', '#3274c8', '#3696ad', '#32a071', '#a5a832', '#c77e32', '#a34574'];
        const sections = colors
            .map((color, index) => `<section style="background:${color}">section ${index + 1}</section>`)
            .join('');
        return pageHtml(
            `<main>${sections}</main><footer>TRUE FOOTER</footer>`,
            'section { box-sizing: border-box; height: 500px; padding: 30px; color: white; } footer { box-sizing: border-box; height: 200px; padding: 30px; color: white; background: #00a050; }'
        );
    }

    if (pathname === '/lazy-fixed') {
        const colors = ['#335cba', '#287f9e', '#2e936a', '#8a9130', '#a76d35', '#8d4b8f'];
        const sections = colors
            .map((color, index) => `<section class="lazy" data-color="${color}">lazy section ${index + 1}</section>`)
            .join('');
        return pageHtml(
            `<header>FIXED HEADER</header><aside>FIXED MODAL</aside><div id="shadow-widget"></div><main>${sections}</main><footer>LAZY FOOTER</footer>`,
            `
                header { position: fixed; inset: 0 0 auto; z-index: 10; height: 55px; background: #ff0000; }
                aside { position: fixed; z-index: 11; right: 20px; bottom: 20px; width: 120px; height: 120px; background: #ff0000; }
                section { box-sizing: border-box; height: 600px; padding: 30px; color: white; background: white; }
                footer { box-sizing: border-box; height: 200px; padding: 30px; color: white; background: #00a050; }
            `,
            `
                const widgetHost = document.querySelector('#shadow-widget');
                widgetHost.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;overflow:visible;z-index:20';
                const shadowRoot = widgetHost.attachShadow({ mode: 'open' });
                shadowRoot.innerHTML = '<button style="position:fixed;right:15px;bottom:15px;width:70px;height:70px;border:0;background:#ff0000">widget</button>';

                const observer = new IntersectionObserver(entries => {
                    for (const entry of entries) {
                        if (entry.isIntersecting) {
                            entry.target.style.background = entry.target.dataset.color;
                            observer.unobserve(entry.target);
                        }
                    }
                }, { rootMargin: '100px' });
                document.querySelectorAll('.lazy').forEach(section => observer.observe(section));
            `
        );
    }

    if (pathname === '/repeated') {
        return pageHtml(
            '<main></main>',
            'body::-webkit-scrollbar { display: none; } main { height: 3200px; background: white; }'
        );
    }

    return pageHtml('<main>not found</main>');
}

async function captureFixture(pathname, options = TEST_CAPTURE_OPTIONS) {
    const page = await browser.newPage();
    try {
        return await captureUrlAtWidth(page, {
            url: `${baseUrl}${pathname}`,
            width: 400,
            outputDirectory,
            options
        });
    } finally {
        await page.close();
    }
}

async function pixelAt(imagePath, left, top) {
    const { data } = await sharp(imagePath)
        .extract({ left, top, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return [...data];
}

test.before(async () => {
    outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'cli-sc-tool-test-'));
    server = http.createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(fixtureFor(new URL(request.url, 'http://localhost').pathname));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
    await browser?.close();
    await new Promise(resolve => server?.close(resolve));
    await rm(outputDirectory, { recursive: true, force: true });
});

test('uses a bounded overlapping tile plan that ends at the true page bottom', () => {
    assert.deepEqual(buildTilePlan(1_500, 600, 80), [
        { y: 0, height: 600 },
        { y: 520, height: 600 },
        { y: 900, height: 600 }
    ]);
    assert.equal(shouldUseTiledCapture(1_024, 28_000), false);
    assert.equal(shouldUseTiledCapture(1_024, 28_001), true);
    assert.equal(shouldUseTiledCapture(10_000, 21_000), true);
});

test('keeps the one-shot fullPage path and filename for a normal page', async () => {
    const result = await captureFixture('/normal');
    const metadata = await sharp(result.outputPath).metadata();

    assert.equal(result.mode, 'single');
    assert.equal(result.outputPath, outputPathFor(`${baseUrl}/normal`, 400, outputDirectory));
    assert.equal(metadata.width, 400);
    assert.equal(metadata.height, 1_400);
});

test('stitches a long page through its true footer without keeping temporary tiles', async () => {
    const result = await captureFixture('/practice-areas/personal-injury-lawyers/');
    const metadata = await sharp(result.outputPath).metadata();
    const bottomPixel = await pixelAt(result.outputPath, 200, metadata.height - 10);
    const files = await readdir(outputDirectory);

    assert.equal(result.mode, 'tiled');
    assert.ok(result.tileCount > 1);
    assert.equal(metadata.width, 400);
    assert.equal(metadata.height, 3_700);
    assert.deepEqual(bottomPixel, [0, 160, 80]);
    assert.equal(files.some(file => file.includes('.tiles-')), false);
});

test('loads lazy sections and removes fixed UI from every tile', async () => {
    const result = await captureFixture('/lazy-fixed');
    const { data, info } = await sharp(result.outputPath)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    let redPixels = 0;
    for (let offset = 0; offset < data.length; offset += info.channels) {
        if (data[offset] > 245 && data[offset + 1] < 20 && data[offset + 2] < 20) {
            redPixels += 1;
        }
    }

    assert.equal(result.mode, 'tiled');
    assert.equal(info.width, 400);
    assert.equal(info.height, 3_800);
    assert.equal(redPixels, 0);

    for (const y of [300, 900, 1_500, 2_100, 2_700, 3_300]) {
        const pixel = await pixelAt(result.outputPath, 200, y);
        assert.notDeepEqual(pixel, [255, 255, 255], `lazy section at ${y}px remained blank`);
    }
});

test('rejects repeated tiles and retains diagnostics instead of saving the image', async () => {
    let failure;
    try {
        await captureFixture('/repeated');
    } catch (error) {
        failure = error;
    }

    assert.ok(failure, 'expected repeated tiles to fail validation');
    assert.match(failure.message, /Repeated tile content detected/);

    const files = await readdir(outputDirectory);
    const retainedDirectory = files.find(file => file.includes('.127.0.0.1-repeated-400px.tiles-'));
    assert.ok(retainedDirectory, 'expected failed tiles to be retained');
    assert.ok((await readdir(path.join(outputDirectory, retainedDirectory))).includes('failure.json'));
    assert.equal(files.includes(path.basename(outputPathFor(`${baseUrl}/repeated`, 400, outputDirectory))), false);
});
