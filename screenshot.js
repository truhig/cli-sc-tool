import crypto from 'node:crypto';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, URL } from 'node:url';

import puppeteer from 'puppeteer';
import sharp from 'sharp';

export const NAMED_RESOLUTIONS = {
    mobile: 375,
    tablet: 768,
    desktop: 1366,
    'desktop-xl': 1920
};

export const DEFAULT_CAPTURE_OPTIONS = {
    viewportHeight: 900,
    longPageHeightThreshold: 28_000,
    safeImageDimension: 30_000,
    safeImageArea: 200_000_000,
    tileOverlap: 100,
    initialSettleDelayMs: 2_000,
    lazyScrollDelayMs: 100,
    tileSettleDelayMs: 250,
    imageLoadTimeoutMs: 8_000,
    maxLazyScrollSteps: 1_000
};

const REDUCED_MOTION_CSS = `
    html { scroll-behavior: auto !important; }
    *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0.001s !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
        transition-delay: 0s !important;
        transition-duration: 0.001s !important;
    }
`;

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function shouldUseTiledCapture(width, height, options = {}) {
    const settings = { ...DEFAULT_CAPTURE_OPTIONS, ...options };
    const estimatedArea = width * height;

    return height > settings.longPageHeightThreshold
        || width >= settings.safeImageDimension
        || height >= settings.safeImageDimension
        || estimatedArea >= settings.safeImageArea;
}

export function buildTilePlan(pageHeight, viewportHeight, overlap) {
    if (!Number.isFinite(pageHeight) || pageHeight <= 0) {
        throw new Error(`Invalid page height: ${pageHeight}`);
    }
    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
        throw new Error(`Invalid viewport height: ${viewportHeight}`);
    }
    if (!Number.isFinite(overlap) || overlap < 0 || overlap >= viewportHeight) {
        throw new Error(`Tile overlap must be between 0 and ${viewportHeight - 1}px.`);
    }

    const maximumScrollY = Math.max(0, pageHeight - viewportHeight);
    const step = viewportHeight - overlap;
    const tiles = [{ y: 0, height: Math.min(viewportHeight, pageHeight) }];

    while (tiles.at(-1).y < maximumScrollY) {
        const y = Math.min(tiles.at(-1).y + step, maximumScrollY);
        if (y === tiles.at(-1).y) {
            break;
        }
        tiles.push({ y, height: Math.min(viewportHeight, pageHeight - y) });
    }

    return tiles;
}

export function outputPathFor(url, width, outputDirectory) {
    const urlObject = new URL(url);
    const baseFilename = `${urlObject.hostname}-${path.basename(urlObject.pathname).replace(/[^a-z0-9]/gi, '_')}`;
    return path.join(outputDirectory, `${baseFilename}-${width}px.png`);
}

export async function measureFullPageHeight(page) {
    return page.evaluate(() => {
        const body = document.body;
        const documentElement = document.documentElement;
        return Math.ceil(Math.max(
            body?.scrollHeight ?? 0,
            body?.offsetHeight ?? 0,
            documentElement?.clientHeight ?? 0,
            documentElement?.scrollHeight ?? 0,
            documentElement?.offsetHeight ?? 0
        ));
    });
}

async function installReducedMotionStyles(page) {
    await page.addStyleTag({ content: REDUCED_MOTION_CSS });
}

async function waitForImages(page, timeoutMs, visibleOnly = false) {
    await page.evaluate(async ({ timeout, onlyVisible }) => {
        const images = [...document.images].filter(image => {
            if (!image.currentSrc && !image.src) {
                return false;
            }
            if (!onlyVisible) {
                return true;
            }
            const rectangle = image.getBoundingClientRect();
            return rectangle.bottom > 0 && rectangle.top < window.innerHeight;
        });

        await Promise.all(images.map(image => {
            if (image.complete) {
                return Promise.resolve();
            }

            return new Promise(resolve => {
                const finish = () => {
                    clearTimeout(timer);
                    image.removeEventListener('load', finish);
                    image.removeEventListener('error', finish);
                    resolve();
                };
                const timer = setTimeout(finish, timeout);
                image.addEventListener('load', finish, { once: true });
                image.addEventListener('error', finish, { once: true });
            });
        }));
    }, { timeout: timeoutMs, onlyVisible: visibleOnly });
}

async function scrollToExactOffset(page, targetY, settleDelayMs, imageLoadTimeoutMs) {
    const scrollPosition = async () => page.evaluate(y => {
        document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
        document.body?.style.setProperty('scroll-behavior', 'auto', 'important');
        window.scrollTo(0, y);
        return window.scrollY;
    }, targetY);

    await scrollPosition();
    await delay(Math.max(0, Math.floor(settleDelayMs / 2)));
    const actualY = await scrollPosition();
    await waitForImages(page, imageLoadTimeoutMs, true);
    await delay(Math.max(0, Math.ceil(settleDelayMs / 2)));

    const lockedY = await page.evaluate(() => window.scrollY);
    if (Math.abs(lockedY - targetY) > 1 || Math.abs(actualY - targetY) > 1) {
        throw new Error(`Page would not remain at tile offset ${targetY}px (actual ${lockedY}px).`);
    }
}

export async function lazyLoadPage(page, options = {}) {
    const settings = { ...DEFAULT_CAPTURE_OPTIONS, ...options };
    let steps = 0;
    let previousHeight = 0;

    while (steps < settings.maxLazyScrollSteps) {
        const dimensions = await page.evaluate(() => ({
            height: Math.ceil(Math.max(
                document.body?.scrollHeight ?? 0,
                document.documentElement.scrollHeight,
                document.documentElement.offsetHeight
            )),
            viewportHeight: window.innerHeight,
            y: window.scrollY
        }));
        const bottomY = Math.max(0, dimensions.height - dimensions.viewportHeight);

        if (dimensions.y >= bottomY) {
            await delay(settings.lazyScrollDelayMs);
            const settledHeight = await measureFullPageHeight(page);
            if (settledHeight <= dimensions.height && settledHeight === previousHeight) {
                break;
            }
            previousHeight = settledHeight;
        }

        const nextY = Math.min(
            bottomY,
            dimensions.y + Math.max(1, Math.floor(dimensions.viewportHeight * 0.8))
        );
        await page.evaluate(y => window.scrollTo(0, y), nextY);
        await delay(settings.lazyScrollDelayMs);
        steps += 1;
    }

    if (steps >= settings.maxLazyScrollSteps) {
        throw new Error(`Lazy-load scrolling exceeded ${settings.maxLazyScrollSteps} steps.`);
    }

    await waitForImages(page, settings.imageLoadTimeoutMs);
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(settings.tileSettleDelayMs);
}

export async function hideFixedAndStickyElements(page) {
    return page.evaluate(() => {
        let hidden = 0;
        const elements = [...document.querySelectorAll('body *')];

        for (let index = 0; index < elements.length; index += 1) {
            const element = elements[index];
            if (element.shadowRoot) {
                elements.push(...element.shadowRoot.querySelectorAll('*'));
            }

            const position = getComputedStyle(element).position;
            if (position !== 'fixed' && position !== 'sticky') {
                continue;
            }

            element.setAttribute('data-cli-sc-tool-hidden', position);
            // Opacity applies to the whole rendered subtree, including overflowing
            // shadow content whose fixed host can report a 0x0 bounding box.
            element.style.setProperty('opacity', '0', 'important');
            element.style.setProperty('pointer-events', 'none', 'important');
            hidden += 1;
        }
        return hidden;
    });
}

async function hashFile(filePath) {
    const contents = await fsPromises.readFile(filePath);
    return crypto.createHash('sha256').update(contents).digest('hex');
}

function assertUniqueTileHashes(tiles) {
    const seen = new Map();
    for (const tile of tiles) {
        const duplicate = seen.get(tile.hash);
        if (duplicate) {
            throw new Error(
                `Repeated tile content detected at ${duplicate.y}px and ${tile.y}px (SHA-256 ${tile.hash}).`
            );
        }
        seen.set(tile.hash, tile);
    }
}

export async function stitchTiles(tiles, outputPath, width, height) {
    let coveredThrough = 0;
    const layers = [];

    for (const tile of tiles) {
        const cropTop = Math.max(0, coveredThrough - tile.y);
        const bottom = Math.min(height, tile.y + tile.height);
        const usableHeight = bottom - tile.y - cropTop;

        if (tile.y > coveredThrough) {
            throw new Error(`Gap detected before tile at ${tile.y}px; content is covered only through ${coveredThrough}px.`);
        }
        if (usableHeight <= 0) {
            continue;
        }

        const input = await sharp(tile.path)
            .extract({ left: 0, top: cropTop, width, height: usableHeight })
            .png()
            .toBuffer();
        layers.push({ input, left: 0, top: tile.y + cropTop });
        coveredThrough = Math.max(coveredThrough, bottom);
    }

    if (coveredThrough !== height) {
        throw new Error(`Tiles cover ${coveredThrough}px, but the measured page height is ${height}px.`);
    }

    await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: '#ffffff'
        }
    })
        .composite(layers)
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toFile(outputPath);
}

export async function validateStitchedImage({
    imagePath,
    expectedWidth,
    expectedHeight,
    currentPageHeight,
    tiles
}) {
    assertUniqueTileHashes(tiles);

    const metadata = await sharp(imagePath).metadata();
    if (metadata.width !== expectedWidth) {
        throw new Error(`Stitched image width is ${metadata.width}px; expected ${expectedWidth}px.`);
    }

    const imageHeightTolerance = Math.max(2, Math.round(expectedHeight * 0.005));
    if (!metadata.height || Math.abs(metadata.height - expectedHeight) > imageHeightTolerance) {
        throw new Error(
            `Stitched image height is ${metadata.height}px; expected approximately ${expectedHeight}px.`
        );
    }

    const pageHeightTolerance = Math.max(200, Math.round(expectedHeight * 0.01));
    if (Math.abs(currentPageHeight - expectedHeight) > pageHeightTolerance) {
        throw new Error(
            `Page height changed from ${expectedHeight}px to ${currentPageHeight}px during tiled capture.`
        );
    }

    return metadata;
}

export async function captureLongPage(page, {
    outputPath,
    width,
    pageHeight,
    outputDirectory,
    filename,
    options = {}
}) {
    const settings = { ...DEFAULT_CAPTURE_OPTIONS, ...options };
    const tileDirectory = await fsPromises.mkdtemp(
        path.join(outputDirectory, `.${filename}.tiles-`)
    );
    const stitchedCandidate = path.join(tileDirectory, 'stitched.png');

    try {
        await hideFixedAndStickyElements(page);
        const plan = buildTilePlan(pageHeight, settings.viewportHeight, settings.tileOverlap);
        const tiles = [];

        for (const [index, segment] of plan.entries()) {
            await scrollToExactOffset(
                page,
                segment.y,
                settings.tileSettleDelayMs,
                settings.imageLoadTimeoutMs
            );
            // Widgets can be inserted or restyled while the page scrolls. Reapply
            // suppression immediately before every tile capture.
            await hideFixedAndStickyElements(page);

            const tilePath = path.join(tileDirectory, `tile-${String(index).padStart(4, '0')}-${segment.y}px.png`);
            await page.screenshot({
                path: tilePath,
                fullPage: false,
                captureBeyondViewport: false
            });

            const metadata = await sharp(tilePath).metadata();
            if (metadata.width !== width) {
                throw new Error(`Tile ${index} width is ${metadata.width}px; expected ${width}px.`);
            }
            if (!metadata.height || metadata.height < segment.height) {
                throw new Error(
                    `Tile ${index} height is ${metadata.height}px; expected at least ${segment.height}px.`
                );
            }

            tiles.push({
                ...segment,
                path: tilePath,
                height: Math.min(segment.height, metadata.height),
                hash: await hashFile(tilePath)
            });
        }

        assertUniqueTileHashes(tiles);
        await stitchTiles(tiles, stitchedCandidate, width, pageHeight);
        const currentPageHeight = await measureFullPageHeight(page);
        const metadata = await validateStitchedImage({
            imagePath: stitchedCandidate,
            expectedWidth: width,
            expectedHeight: pageHeight,
            currentPageHeight,
            tiles
        });

        await fsPromises.rename(stitchedCandidate, outputPath);
        await fsPromises.rm(tileDirectory, { recursive: true, force: true });

        return {
            mode: 'tiled',
            outputPath,
            width: metadata.width,
            height: metadata.height,
            tileCount: tiles.length
        };
    } catch (error) {
        const failureDetails = {
            message: error.message,
            expectedWidth: width,
            expectedHeight: pageHeight,
            outputPath,
            tileDirectory
        };
        await fsPromises.writeFile(
            path.join(tileDirectory, 'failure.json'),
            `${JSON.stringify(failureDetails, null, 2)}\n`,
            'utf8'
        ).catch(() => {});
        error.message = `${error.message} Temporary tiles retained at ${tileDirectory}`;
        error.tileDirectory = tileDirectory;
        throw error;
    }
}

export async function captureUrlAtWidth(page, {
    url,
    width,
    outputDirectory,
    options = {}
}) {
    const settings = { ...DEFAULT_CAPTURE_OPTIONS, ...options };
    await page.setViewport({
        width,
        height: settings.viewportHeight,
        deviceScaleFactor: 1
    });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.goto(url, { waitUntil: 'networkidle2' });
    await installReducedMotionStyles(page);
    await delay(settings.initialSettleDelayMs);
    await lazyLoadPage(page, settings);

    const pageHeight = await measureFullPageHeight(page);
    const outputPath = outputPathFor(url, width, outputDirectory);

    if (!shouldUseTiledCapture(width, pageHeight, settings)) {
        await page.screenshot({ path: outputPath, fullPage: true });
        return { mode: 'single', outputPath, width, height: pageHeight, tileCount: 1 };
    }

    return captureLongPage(page, {
        outputPath,
        width,
        pageHeight,
        outputDirectory,
        filename: path.basename(outputPath, '.png'),
        options: settings
    });
}

export function parseArguments(args, cwd = process.cwd()) {
    const urls = [];
    let viewportWidths = [1024];
    let outputDirectory = path.join(cwd, 'screenshots');

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--url' && args[index + 1]) {
            urls.push(args[index += 1]);
        } else if (argument === '--file' && args[index + 1]) {
            const filePath = args[index += 1];
            try {
                const fileContent = fs.readFileSync(filePath, 'utf8');
                urls.push(...fileContent.split('\n').map(value => value.trim()).filter(Boolean));
            } catch (error) {
                throw new Error(`Error reading URL file ${filePath}: ${error.message}`);
            }
        } else if (argument === '--width' && args[index + 1]) {
            const requestedWidths = args[index += 1].split(',').map(value => value.trim().toLowerCase());
            const widths = new Set();

            for (const requestedWidth of requestedWidths) {
                if (requestedWidth === 'all') {
                    Object.values(NAMED_RESOLUTIONS).forEach(width => widths.add(width));
                } else if (NAMED_RESOLUTIONS[requestedWidth]) {
                    widths.add(NAMED_RESOLUTIONS[requestedWidth]);
                } else {
                    const width = Number.parseInt(requestedWidth, 10);
                    if (Number.isFinite(width) && width > 0) {
                        widths.add(width);
                    } else {
                        console.warn(`Invalid width or named resolution ignored: ${requestedWidth}`);
                    }
                }
            }

            if (widths.size > 0) {
                viewportWidths = [...widths].sort((left, right) => left - right);
            } else {
                console.error('No valid widths provided. Using default 1024px.');
            }
        } else if (argument === '--output' && args[index + 1]) {
            outputDirectory = args[index += 1];
        } else if (argument.startsWith('--')) {
            console.warn(`Unknown argument: ${argument}`);
        }
    }

    if (urls.length === 0) {
        console.log('No URLs provided. Using default URL: https://q30design.com/about/');
        urls.push('https://q30design.com/about/');
    }

    return { urls, viewportWidths, outputDirectory };
}

export async function takeScreenshots(args = process.argv.slice(2), launchOptions = {}) {
    const { urls, viewportWidths, outputDirectory } = parseArguments(args);
    await fsPromises.mkdir(outputDirectory, { recursive: true });

    const browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    const results = [];
    let failed = false;

    try {
        for (const url of urls) {
            for (const width of viewportWidths) {
                try {
                    const result = await captureUrlAtWidth(page, {
                        url,
                        width,
                        outputDirectory
                    });
                    results.push(result);
                    const detail = result.mode === 'tiled' ? ` (${result.tileCount} stitched tiles)` : '';
                    console.log(`Screenshot saved for ${url} at ${result.outputPath} with width ${width}px${detail}`);
                } catch (error) {
                    failed = true;
                    console.error(`Failed to take screenshot for ${url} with width ${width}px: ${error.message}`);
                }
            }
        }
    } finally {
        await browser.close();
    }

    if (failed) {
        process.exitCode = 1;
    }
    return results;
}

const isMainModule = process.argv[1]
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
    takeScreenshots().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
