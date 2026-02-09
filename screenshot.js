import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { URL } from 'url';

const NAMED_RESOLUTIONS = {
    'mobile': 375,
    'tablet': 768,
    'desktop': 1366,
    'desktop-xl': 1920
};

async function takeScreenshots() {
    const args = process.argv.slice(2); // Get command-line arguments

    let urls = [];
    let viewportWidths = [1024]; // Default viewport width
    let outputDir = path.join(process.cwd(), 'screenshots'); // Default output directory

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--url' && args[i + 1]) {
            urls.push(args[++i]);
        } else if (arg === '--file' && args[i + 1]) {
            const filePath = args[++i];
            try {
                const fileContent = fs.readFileSync(filePath, 'utf-8');
                urls = urls.concat(fileContent.split('\n').map(s => s.trim()).filter(Boolean));
            } catch (error) {
                console.error(`Error reading URL file ${filePath}: ${error.message}`);
                process.exit(1);
            }
        } else if (arg === '--width' && args[i + 1]) {
            const requestedWidths = args[++i].split(',').map(w => w.trim().toLowerCase());
            const newViewportWidths = new Set();

            for (const reqWidth of requestedWidths) {
                if (reqWidth === 'all') {
                    Object.values(NAMED_RESOLUTIONS).forEach(width => newViewportWidths.add(width));
                } else if (NAMED_RESOLUTIONS[reqWidth]) {
                    newViewportWidths.add(NAMED_RESOLUTIONS[reqWidth]);
                } else {
                    const widthNum = parseInt(reqWidth, 10);
                    if (!isNaN(widthNum) && widthNum > 0) {
                        newViewportWidths.add(widthNum);
                    } else {
                        console.warn(`Invalid width or named resolution ignored: ${reqWidth}`);
                    }
                }
            }

            if (newViewportWidths.size > 0) {
                viewportWidths = Array.from(newViewportWidths).sort((a, b) => a - b);
            } else {
                console.error('No valid widths provided. Using default 1024px.');
            }
        } else if (arg === '--output' && args[i + 1]) {
            outputDir = args[++i];
        } else if (arg.startsWith('--')) {
            console.warn(`Unknown argument: ${arg}`);
        }
    }

    // Default URL if none provided
    if (urls.length === 0) {
        console.log('No URLs provided. Using default URL: https://q30design.com/about/');
        urls.push('https://q30design.com/about/');
    }

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    for (const url of urls) {
        for (const width of viewportWidths) {
            try {
                await page.setViewport({
                    width: width,
                    height: 0, // Height doesn't matter for fullPage screenshot
                });
                await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);

                await page.goto(url, { waitUntil: 'networkidle2' });
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for 2 seconds to ensure animations settle

                const urlObj = new URL(url);
                const baseFilename = `${urlObj.hostname}-${path.basename(urlObj.pathname).replace(/[^a-z0-9]/gi, '_')}`;
                const filename = `${baseFilename}-${width}px.png`;
                const outputPath = path.join(outputDir, filename);

                await page.screenshot({ path: outputPath, fullPage: true });
                console.log(`Screenshot saved for ${url} at ${outputPath} with width ${width}px`);
            } catch (error) {
                console.error(`Failed to take screenshot for ${url} with width ${width}px: ${error}`);
            }
        }
    }

    await browser.close();
}

takeScreenshots();