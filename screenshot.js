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
    assetReadyTimeoutMs: 8_000,
    layoutStabilityTimeoutMs: 5_000,
    layoutStabilityIntervalMs: 250,
    layoutStableSamples: 3,
    maxCaptureAttempts: 2,
    maxLazyScrollSteps: 1_000,
    hideSelectors: [],
    keepSelectors: []
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

function createAssetMonitor(page, pageUrl) {
    const pageOrigin = new URL(pageUrl).origin;
    const failures = [];

    const recordFailure = (request, detail) => {
        const resourceType = request.resourceType();
        const requestUrl = request.url();
        const isSameOrigin = (() => {
            try {
                return new URL(requestUrl).origin === pageOrigin;
            } catch {
                return false;
            }
        })();
        const critical = resourceType === 'stylesheet'
            || resourceType === 'script' && isSameOrigin;

        failures.push({
            url: requestUrl,
            resourceType,
            critical,
            ...detail
        });
    };

    const onRequestFailed = request => {
        recordFailure(request, {
            errorText: request.failure()?.errorText ?? 'Request failed'
        });
    };
    const onResponse = response => {
        if (response.status() >= 400) {
            recordFailure(response.request(), { status: response.status() });
        }
    };

    page.on('requestfailed', onRequestFailed);
    page.on('response', onResponse);

    return {
        failures,
        stop() {
            page.off('requestfailed', onRequestFailed);
            page.off('response', onResponse);
        }
    };
}

export async function waitForPageAssets(
    page,
    timeoutMs = DEFAULT_CAPTURE_OPTIONS.assetReadyTimeoutMs
) {
    return page.evaluate(async timeout => {
        const deadline = Date.now() + timeout;
        const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

        if (document.fonts) {
            await Promise.race([
                document.fonts.ready,
                pause(Math.max(0, deadline - Date.now()))
            ]);
        }

        const stylesheetLinks = [...document.querySelectorAll('link[rel~="stylesheet"][href]')];
        while (
            Date.now() < deadline
            && stylesheetLinks.some(link => !link.disabled && !link.sheet)
        ) {
            await pause(50);
        }

        return {
            fontStatus: document.fonts?.status ?? 'unsupported',
            pendingStylesheets: stylesheetLinks
                .filter(link => !link.disabled && !link.sheet)
                .map(link => link.href)
        };
    }, timeoutMs);
}

async function layoutSignature(page) {
    return page.evaluate(() => {
        const documentElement = document.documentElement;
        const body = document.body;
        const primary = document.querySelector('main, [role="main"], #main, .site-main') ?? body;
        const primaryRectangle = primary?.getBoundingClientRect();

        return {
            height: Math.ceil(Math.max(
                body?.scrollHeight ?? 0,
                body?.offsetHeight ?? 0,
                documentElement.scrollHeight,
                documentElement.offsetHeight
            )),
            width: Math.ceil(Math.max(
                body?.scrollWidth ?? 0,
                body?.offsetWidth ?? 0,
                documentElement.scrollWidth,
                documentElement.offsetWidth
            )),
            primaryWidth: Math.round(primaryRectangle?.width ?? 0),
            primaryHeight: Math.round(primaryRectangle?.height ?? 0),
            elementCount: document.querySelectorAll('body *').length,
            incompleteImages: [...document.images].filter(image => !image.complete).length
        };
    });
}

function signaturesMatch(left, right) {
    return Math.abs(left.height - right.height) <= 2
        && Math.abs(left.width - right.width) <= 2
        && Math.abs(left.primaryWidth - right.primaryWidth) <= 2
        && Math.abs(left.primaryHeight - right.primaryHeight) <= 2
        && left.elementCount === right.elementCount
        && left.incompleteImages === right.incompleteImages;
}

export async function waitForLayoutStability(page, options = {}) {
    const settings = { ...DEFAULT_CAPTURE_OPTIONS, ...options };
    const deadline = Date.now() + settings.layoutStabilityTimeoutMs;
    let previous = await layoutSignature(page);
    let stableSamples = 1;

    while (Date.now() < deadline) {
        await delay(settings.layoutStabilityIntervalMs);
        const current = await layoutSignature(page);
        stableSamples = signaturesMatch(previous, current) ? stableSamples + 1 : 1;
        previous = current;

        if (stableSamples >= settings.layoutStableSamples) {
            return current;
        }
    }

    throw new Error(
        `Page layout did not stabilize within ${settings.layoutStabilityTimeoutMs}ms.`
    );
}

export async function inspectPageLayout(page, requestedWidth) {
    return page.evaluate(width => {
        function visualState(element) {
            for (let current = element; current; current = current.parentElement) {
                const style = getComputedStyle(current);
                if (
                    style.display === 'none'
                    || style.visibility === 'hidden'
                ) {
                    return 'not-laid-out';
                }
                if (Number.parseFloat(style.opacity) <= 0.01) {
                    return 'transparent';
                }
            }
            return 'visible';
        }

        const documentElement = document.documentElement;
        const body = document.body;
        const primary = document.querySelector('main, [role="main"], #main, .site-main') ?? body;
        const primaryRectangle = primary?.getBoundingClientRect();
        const textEntries = [...(primary?.querySelectorAll('*') ?? [])]
            .map(element => {
                const directText = [...element.childNodes]
                    .filter(node => node.nodeType === Node.TEXT_NODE)
                    .map(node => node.textContent)
                    .join(' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                return {
                    element,
                    length: directText.length,
                    rectangle: element.getBoundingClientRect(),
                    visualState: visualState(element)
                };
            })
            .filter(entry => entry.length >= 20);
        const laidOutTextEntries = textEntries.filter(entry => (
            entry.visualState !== 'not-laid-out'
            && entry.rectangle.width >= 1
            && entry.rectangle.height >= 1
        ));
        const visibleTextEntries = laidOutTextEntries.filter(entry => (
            entry.visualState === 'visible'
            && entry.rectangle.width >= 1
            && entry.rectangle.height >= 1
        ));
        const textWidths = visibleTextEntries
            .map(entry => entry.rectangle.width)
            .sort((left, right) => left - right);
        const widthPercentile = percentile => (
            textWidths.length === 0
                ? 0
                : textWidths[Math.min(
                    textWidths.length - 1,
                    Math.floor((textWidths.length - 1) * percentile)
                )]
        );
        const totalTextLength = laidOutTextEntries.reduce(
            (total, entry) => total + entry.length,
            0
        );
        const visibleTextLength = visibleTextEntries.reduce(
            (total, entry) => total + entry.length,
            0
        );
        const pageScrollWidth = Math.ceil(Math.max(
            body?.scrollWidth ?? 0,
            documentElement.scrollWidth
        ));
        const reasons = [];

        if (pageScrollWidth > width * 1.25) {
            reasons.push(
                `page scroll width ${pageScrollWidth}px exceeds the ${width}px viewport`
            );
        }

        if (
            totalTextLength >= 500
            && visibleTextLength < totalTextLength * 0.35
        ) {
            reasons.push(
                `only ${visibleTextLength} of ${totalTextLength} text characters are visibly rendered`
            );
        }

        const textWidth75 = Math.round(widthPercentile(0.75));
        if (
            width >= 1_000
            && totalTextLength >= 500
            && textWidths.length >= 8
            && textWidth75 < Math.min(240, width * 0.18)
        ) {
            reasons.push(
                `desktop text containers are abnormally narrow (75th percentile ${textWidth75}px)`
            );
        }

        if (
            width >= 1_000
            && totalTextLength >= 500
            && primaryRectangle
            && primaryRectangle.width < width * 0.35
        ) {
            reasons.push(
                `primary content width ${Math.round(primaryRectangle.width)}px is too narrow for the ${width}px viewport`
            );
        }

        return {
            valid: reasons.length === 0,
            reasons,
            metrics: {
                viewportWidth: width,
                pageScrollWidth,
                primaryWidth: Math.round(primaryRectangle?.width ?? 0),
                totalTextLength,
                visibleTextLength,
                meaningfulTextElements: textWidths.length,
                textWidth75
            }
        };
    }, requestedWidth);
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

export async function suppressBlockingOverlays(page, options = {}) {
    const settings = { ...DEFAULT_CAPTURE_OPTIONS, ...options };

    await page.keyboard.press('Escape').catch(() => {});

    return page.evaluate(async ({ hideSelectors, keepSelectors }) => {
        const overlayNamePattern = /(?:^|[-_\s])(modal|popup|popover|overlay|backdrop|lightbox|interstitial|newsletter|subscribe|campaign|optin|lead[-_\s]?capture|wisepops|poptin|privy|klaviyo|hubspot|omnisend|sleeknote|optinmonster)(?:$|[-_\s])/i;
        const closeLabelPattern = /^(?:close|dismiss|no thanks|not now|maybe later|skip|×|✕|x)$/i;
        const hiddenAttribute = 'data-cli-sc-tool-overlay-hidden';

        function collectRoots() {
            const roots = [];
            const queuedDocuments = [document];
            const seenDocuments = new Set();

            while (queuedDocuments.length > 0) {
                const currentDocument = queuedDocuments.shift();
                if (!currentDocument || seenDocuments.has(currentDocument)) {
                    continue;
                }
                seenDocuments.add(currentDocument);
                roots.push(currentDocument);

                for (const element of currentDocument.querySelectorAll('*')) {
                    if (element.shadowRoot) {
                        roots.push(element.shadowRoot);
                    }
                    if (element.tagName === 'IFRAME') {
                        try {
                            if (element.contentDocument) {
                                queuedDocuments.push(element.contentDocument);
                            }
                        } catch {
                            // Cross-origin frames cannot be inspected from the page.
                        }
                    }
                }
            }
            return roots;
        }

        function queryAll(roots, selector) {
            const matches = [];
            for (const root of roots) {
                try {
                    matches.push(...root.querySelectorAll(selector));
                } catch (error) {
                    throw new Error(`Invalid overlay selector "${selector}": ${error.message}`);
                }
            }
            return matches;
        }

        function composedParent(element) {
            return element.parentElement ?? element.getRootNode()?.host ?? null;
        }

        function isRelatedToKeptElement(element, keptElements) {
            for (let current = element; current; current = composedParent(current)) {
                if (keptElements.has(current)) {
                    return true;
                }
            }
            for (const keptElement of keptElements) {
                for (let current = keptElement; current; current = composedParent(current)) {
                    if (current === element) {
                        return true;
                    }
                }
            }
            return false;
        }

        function elementLabel(element) {
            return [
                element.getAttribute('aria-label'),
                element.getAttribute('title'),
                element.getAttribute('value'),
                element.textContent
            ]
                .filter(Boolean)
                .map(value => value.trim())
                .find(Boolean) ?? '';
        }

        function findCloseControls(element) {
            const controls = element.matches('button, [role="button"], a, input[type="button"], input[type="submit"], [data-dismiss], [data-close]')
                ? [element]
                : [];
            controls.push(...element.querySelectorAll(
                'button, [role="button"], a, input[type="button"], input[type="submit"], [data-dismiss], [data-close]'
            ));

            return controls.filter(control => {
                if (control.matches('[data-dismiss], [data-close]')) {
                    return true;
                }
                const label = elementLabel(control);
                if (!closeLabelPattern.test(label)) {
                    return false;
                }
                if (control.tagName !== 'A') {
                    return true;
                }
                const href = control.getAttribute('href');
                return !href || href.startsWith('#') || href.startsWith('javascript:');
            });
        }

        function visibleGeometry(element) {
            const view = element.ownerDocument.defaultView;
            if (!view) {
                return null;
            }
            const style = view.getComputedStyle(element);
            const rectangle = element.getBoundingClientRect();
            const viewportWidth = Math.max(1, view.innerWidth);
            const viewportHeight = Math.max(1, view.innerHeight);
            const visibleWidth = Math.max(
                0,
                Math.min(rectangle.right, viewportWidth) - Math.max(rectangle.left, 0)
            );
            const visibleHeight = Math.max(
                0,
                Math.min(rectangle.bottom, viewportHeight) - Math.max(rectangle.top, 0)
            );
            const coverage = (visibleWidth * visibleHeight) / (viewportWidth * viewportHeight);
            const opacity = Number.parseFloat(style.opacity);

            if (
                style.display === 'none'
                || style.visibility === 'hidden'
                || Number.isFinite(opacity) && opacity <= 0.01
                || visibleWidth < 20
                || visibleHeight < 20
            ) {
                return null;
            }

            const backgroundColor = style.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
            const backgroundAlpha = backgroundColor.length === 4 ? backgroundColor[3] : (
                backgroundColor.length >= 3 && backgroundColor.some(channel => channel > 0) ? 1 : 0
            );

            return {
                style,
                coverage,
                backgroundAlpha,
                zIndex: Number.parseInt(style.zIndex, 10) || 0
            };
        }

        function documentIsScrollLocked(currentDocument) {
            const view = currentDocument.defaultView;
            if (!view) {
                return false;
            }
            return [currentDocument.documentElement, currentDocument.body].filter(Boolean).some(element => {
                const style = view.getComputedStyle(element);
                return style.overflow === 'hidden'
                    || style.overflow === 'clip'
                    || style.overflowY === 'hidden'
                    || style.overflowY === 'clip'
                    || element === currentDocument.body && style.position === 'fixed';
            });
        }

        function findCandidates(roots, keptElements) {
            const candidates = [];
            const geometryByElement = new Map();
            const elements = roots.flatMap(root => [...root.querySelectorAll('*')]);
            const scrollLockedDocuments = new Set(
                roots
                    .map(root => root.ownerDocument ?? root)
                    .filter(currentDocument => currentDocument?.documentElement)
                    .filter(documentIsScrollLocked)
            );

            for (const element of elements) {
                if (
                    element.hasAttribute(hiddenAttribute)
                    || isRelatedToKeptElement(element, keptElements)
                ) {
                    continue;
                }

                const geometry = visibleGeometry(element);
                if (!geometry) {
                    continue;
                }
                geometryByElement.set(element, geometry);

                const role = element.getAttribute('role')?.toLowerCase();
                const isSemanticDialog = element.matches('dialog[open], [aria-modal="true"]')
                    || role === 'dialog'
                    || role === 'alertdialog';
                const identity = [
                    element.id,
                    typeof element.className === 'string' ? element.className : '',
                    element.getAttribute('data-testid'),
                    element.getAttribute('data-component')
                ].filter(Boolean).join(' ');
                const hasModalName = overlayNamePattern.test(identity);
                const hasCloseControl = findCloseControls(element).length > 0;
                const fixed = geometry.style.position === 'fixed';
                const highStackingOrder = geometry.zIndex >= 10;
                const containsSemanticDialog = Boolean(element.querySelector(
                    'dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"]'
                ));

                const isBlocking = (
                    isSemanticDialog
                    && (fixed || geometry.coverage >= 0.04 || highStackingOrder)
                ) || (
                    fixed
                    && geometry.coverage >= 0.45
                    && (hasCloseControl || hasModalName || containsSemanticDialog)
                ) || (
                    fixed
                    && geometry.coverage >= 0.04
                    && highStackingOrder
                    && hasModalName
                ) || (
                    fixed
                    && geometry.coverage >= 0.04
                    && highStackingOrder
                    && hasCloseControl
                );

                if (isBlocking) {
                    candidates.push(element);
                }
            }

            if (candidates.length > 0 || scrollLockedDocuments.size > 0) {
                for (const [element, geometry] of geometryByElement) {
                    if (
                        candidates.includes(element)
                        || geometry.style.position !== 'fixed'
                        || geometry.coverage < 0.75
                        || geometry.zIndex < 10
                        || geometry.backgroundAlpha < 0.1
                        || isRelatedToKeptElement(element, keptElements)
                    ) {
                        continue;
                    }
                    candidates.push(element);
                }
            }

            return { candidates, scrollLockedDocuments };
        }

        function unlockDocument(currentDocument) {
            let changed = false;
            const view = currentDocument.defaultView;
            if (!view) {
                return changed;
            }

            for (const element of [currentDocument.documentElement, currentDocument.body].filter(Boolean)) {
                const style = view.getComputedStyle(element);
                if (
                    style.overflow === 'hidden'
                    || style.overflow === 'clip'
                    || style.overflowY === 'hidden'
                    || style.overflowY === 'clip'
                ) {
                    element.style.setProperty('overflow-y', 'auto', 'important');
                    changed = true;
                }
            }

            const body = currentDocument.body;
            if (body && view.getComputedStyle(body).position === 'fixed') {
                body.style.setProperty('position', 'static', 'important');
                body.style.setProperty('inset', 'auto', 'important');
                body.style.setProperty('width', 'auto', 'important');
                changed = true;
            }
            return changed;
        }

        const rootsBeforeDismissal = collectRoots();
        const keptElementsBeforeDismissal = new Set(
            keepSelectors.flatMap(selector => queryAll(rootsBeforeDismissal, selector))
        );
        const initial = findCandidates(rootsBeforeDismissal, keptElementsBeforeDismissal);
        const clickedControls = new Set();

        for (const candidate of initial.candidates) {
            const closeControl = findCloseControls(candidate).find(control => !clickedControls.has(control));
            if (closeControl) {
                clickedControls.add(closeControl);
                closeControl.click();
            }
        }

        if (clickedControls.size > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const roots = collectRoots();
        const keptElements = new Set(keepSelectors.flatMap(selector => queryAll(roots, selector)));
        const explicitElements = new Set(hideSelectors.flatMap(selector => queryAll(roots, selector)));
        const detected = findCandidates(roots, keptElements);
        const elementsToHide = new Set([...explicitElements, ...detected.candidates]);
        let hidden = 0;

        for (const element of elementsToHide) {
            if (isRelatedToKeptElement(element, keptElements)) {
                continue;
            }
            element.setAttribute(hiddenAttribute, 'true');
            element.style.setProperty('opacity', '0', 'important');
            element.style.setProperty('visibility', 'hidden', 'important');
            element.style.setProperty('pointer-events', 'none', 'important');
            hidden += 1;
        }

        const documentsToUnlock = new Set([
            ...initial.scrollLockedDocuments,
            ...detected.scrollLockedDocuments
        ]);
        const hasSuppressedOverlay = hidden > 0 || clickedControls.size > 0;
        let scrollUnlocked = 0;
        if (hasSuppressedOverlay) {
            for (const currentDocument of documentsToUnlock) {
                if (unlockDocument(currentDocument)) {
                    scrollUnlocked += 1;
                }
            }
        }

        const totalHidden = collectRoots().reduce(
            (total, root) => total + root.querySelectorAll(`[${hiddenAttribute}]`).length,
            0
        );
        return {
            dismissed: clickedControls.size,
            hidden,
            totalHidden,
            scrollUnlocked
        };
    }, {
        hideSelectors: settings.hideSelectors ?? [],
        keepSelectors: settings.keepSelectors ?? []
    });
}

export async function hideFixedAndStickyElements(page, keepSelectors = []) {
    return page.evaluate(selectors => {
        let hidden = 0;
        const elements = [...document.querySelectorAll('body *')];
        const keptElements = new Set();

        for (let index = 0; index < elements.length; index += 1) {
            const element = elements[index];
            if (element.shadowRoot) {
                elements.push(...element.shadowRoot.querySelectorAll('*'));
            }
        }

        for (const selector of selectors) {
            for (const root of [document, ...elements.map(element => element.shadowRoot).filter(Boolean)]) {
                try {
                    root.querySelectorAll(selector).forEach(element => keptElements.add(element));
                } catch (error) {
                    throw new Error(`Invalid keep selector "${selector}": ${error.message}`);
                }
            }
        }

        for (const element of elements) {
            const position = getComputedStyle(element).position;
            if (position !== 'fixed' && position !== 'sticky') {
                continue;
            }
            if ([...keptElements].some(kept => element === kept || element.contains(kept) || kept.contains(element))) {
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
    }, keepSelectors);
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
    overlaysSuppressed = 0,
    options = {}
}) {
    const settings = { ...DEFAULT_CAPTURE_OPTIONS, ...options };
    const tileDirectory = await fsPromises.mkdtemp(
        path.join(outputDirectory, `.${filename}.tiles-`)
    );
    const stitchedCandidate = path.join(tileDirectory, 'stitched.png');

    try {
        const initialOverlayResult = await suppressBlockingOverlays(page, settings);
        overlaysSuppressed += initialOverlayResult.dismissed + initialOverlayResult.hidden;
        await hideFixedAndStickyElements(page, settings.keepSelectors);
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
            const overlayResult = await suppressBlockingOverlays(page, settings);
            overlaysSuppressed += overlayResult.dismissed + overlayResult.hidden;
            await hideFixedAndStickyElements(page, settings.keepSelectors);

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
            tileCount: tiles.length,
            overlaysSuppressed
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
    const assetMonitor = createAssetMonitor(page, url);
    let readiness;
    let layout;

    try {
        await page.setViewport({
            width,
            height: settings.viewportHeight,
            deviceScaleFactor: 1
        });
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
        const navigationResponse = await page.goto(url, { waitUntil: 'networkidle2' });
        if (navigationResponse && navigationResponse.status() >= 400) {
            throw new Error(
                `Page navigation returned HTTP ${navigationResponse.status()} for ${url}.`
            );
        }

        await installReducedMotionStyles(page);
        await delay(settings.initialSettleDelayMs);
        readiness = await waitForPageAssets(page, settings.assetReadyTimeoutMs);

        const initialCriticalFailures = assetMonitor.failures.filter(failure => failure.critical);
        if (readiness.pendingStylesheets.length > 0 || initialCriticalFailures.length > 0) {
            const details = [
                ...initialCriticalFailures.map(failure => (
                    `${failure.resourceType} ${failure.status ?? failure.errorText}: ${failure.url}`
                )),
                ...readiness.pendingStylesheets.map(stylesheet => (
                    `stylesheet did not become ready: ${stylesheet}`
                ))
            ];
            throw new Error(`Critical page assets failed to load: ${details.join('; ')}`);
        }

        const initialOverlayResult = await suppressBlockingOverlays(page, settings);
        await lazyLoadPage(page, settings);
        const finalOverlayResult = await suppressBlockingOverlays(page, settings);
        await waitForImages(page, settings.imageLoadTimeoutMs);
        await waitForLayoutStability(page, settings);

        const finalCriticalFailures = assetMonitor.failures.filter(failure => failure.critical);
        if (finalCriticalFailures.length > 0) {
            const details = finalCriticalFailures.map(failure => (
                `${failure.resourceType} ${failure.status ?? failure.errorText}: ${failure.url}`
            ));
            throw new Error(`Critical page assets failed to load: ${details.join('; ')}`);
        }

        layout = await inspectPageLayout(page, width);
        if (!layout.valid) {
            throw new Error(`Suspicious page layout detected: ${layout.reasons.join('; ')}.`);
        }

        const pageHeight = await measureFullPageHeight(page);
        const outputPath = outputPathFor(url, width, outputDirectory);
        const overlaysSuppressed = initialOverlayResult.dismissed
            + initialOverlayResult.hidden
            + finalOverlayResult.dismissed
            + finalOverlayResult.hidden;
        const diagnostics = {
            readiness,
            layout,
            assetFailures: assetMonitor.failures
        };

        if (!shouldUseTiledCapture(width, pageHeight, settings)) {
            await page.screenshot({ path: outputPath, fullPage: true });
            return {
                mode: 'single',
                outputPath,
                width,
                height: pageHeight,
                tileCount: 1,
                overlaysSuppressed,
                diagnostics
            };
        }

        const result = await captureLongPage(page, {
            outputPath,
            width,
            pageHeight,
            outputDirectory,
            filename: path.basename(outputPath, '.png'),
            overlaysSuppressed,
            options: settings
        });
        return { ...result, diagnostics };
    } catch (error) {
        error.captureDiagnostics = {
            readiness,
            layout,
            assetFailures: assetMonitor.failures
        };
        throw error;
    } finally {
        assetMonitor.stop();
    }
}

export async function captureUrlWithRetry(browser, {
    url,
    width,
    outputDirectory,
    options = {}
}) {
    const settings = { ...DEFAULT_CAPTURE_OPTIONS, ...options };
    const configuredAttempts = Number(settings.maxCaptureAttempts);
    const maximumAttempts = Number.isFinite(configuredAttempts)
        ? Math.max(1, Math.floor(configuredAttempts))
        : DEFAULT_CAPTURE_OPTIONS.maxCaptureAttempts;
    const retryReasons = [];
    let lastError;

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        let context;

        try {
            context = await browser.createBrowserContext();
            const page = await context.newPage();
            const result = await captureUrlAtWidth(page, {
                url,
                width,
                outputDirectory,
                options: settings
            });
            return {
                ...result,
                attempts: attempt,
                retryReasons
            };
        } catch (error) {
            lastError = error;
            retryReasons.push(error.message);
        } finally {
            await context?.close().catch(() => {});
        }
    }

    lastError.message = `${lastError.message} Capture failed after ${maximumAttempts} isolated attempt(s).`;
    lastError.retryReasons = retryReasons;
    throw lastError;
}

export function parseArguments(args, cwd = process.cwd()) {
    const urls = [];
    let viewportWidths = [1024];
    let outputDirectory = path.join(cwd, 'screenshots');
    const hideSelectors = [];
    const keepSelectors = [];

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
        } else if (argument === '--hide-selector' && args[index + 1]) {
            hideSelectors.push(args[index += 1]);
        } else if (argument === '--keep-selector' && args[index + 1]) {
            keepSelectors.push(args[index += 1]);
        } else if (argument.startsWith('--')) {
            console.warn(`Unknown argument: ${argument}`);
        }
    }

    if (urls.length === 0) {
        console.log('No URLs provided. Using default URL: https://q30design.com/about/');
        urls.push('https://q30design.com/about/');
    }

    return {
        urls,
        viewportWidths,
        outputDirectory,
        captureOptions: { hideSelectors, keepSelectors }
    };
}

export async function takeScreenshots(args = process.argv.slice(2), launchOptions = {}) {
    const { urls, viewportWidths, outputDirectory, captureOptions } = parseArguments(args);
    await fsPromises.mkdir(outputDirectory, { recursive: true });

    const browser = await puppeteer.launch(launchOptions);
    const results = [];
    let failed = false;

    try {
        for (const url of urls) {
            for (const width of viewportWidths) {
                try {
                    const result = await captureUrlWithRetry(browser, {
                        url,
                        width,
                        outputDirectory,
                        options: captureOptions
                    });
                    results.push(result);
                    const detail = result.mode === 'tiled' ? ` (${result.tileCount} stitched tiles)` : '';
                    const overlayDetail = result.overlaysSuppressed > 0
                        ? `; suppressed ${result.overlaysSuppressed} blocking overlay element(s)`
                        : '';
                    const retryDetail = result.attempts > 1
                        ? `; succeeded on isolated attempt ${result.attempts}`
                        : '';
                    console.log(
                        `Screenshot saved for ${url} at ${result.outputPath} with width ${width}px${detail}${overlayDetail}${retryDetail}`
                    );
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
