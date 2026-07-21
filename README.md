# CLI Screenshot Tool

This is a Node.js script that uses Puppeteer to capture full-page screenshots of specified web pages. It uses reduced-motion mode, scrolls through the page to trigger lazy-loaded assets, and waits for images before capture.

## Capture behavior

Pages up to 28,000px tall use Puppeteer's existing one-shot `fullPage` capture, preserving the established URL-and-width filename format. Taller pages, or pages whose estimated image size approaches browser rendering limits, are captured in overlapping viewport tiles and stitched into one PNG.

Before every tile, the page is locked to the exact scroll offset and allowed to settle. Fixed and sticky UI is suppressed—including widgets rendered through zero-size hosts or open shadow DOM—so headers, modals, and accessibility launchers do not repeat at tile joins. The stitched result is validated before it replaces the final output file.

## Installation

1.  **Node.js**: Install Node.js 22.12.0 or newer. If needed, download it from [nodejs.org](https://nodejs.org/).
2.  **Dependencies**: From the root of the `cli-sc-tool` directory, install Puppeteer and Sharp:
    ```bash
    npm install
    ```

## Usage

The script can be run with command-line arguments to specify URLs, viewport width(s), and the output directory.

**Run the script with arguments**:

*   **Single URL and single width**:
    ```bash
    node screenshot.js --url https://example.com --width 1280 --output ./my-screenshots
    ```
*   **Single URL and multiple numeric widths**:
    ```bash
    node screenshot.js --url https://example.com --width 800,1280,1920 --output ./my-screenshots
    ```
*   **Single URL and named breakpoints**:
    ```bash
    node screenshot.js --url https://example.com --width mobile,desktop --output ./my-screenshots
    ```
*   **Single URL and all named breakpoints**:
    ```bash
    node screenshot.js --url https://example.com --width all --output ./my-screenshots
    ```
*   **Multiple URLs from a text file with mixed widths (numeric and named)**:
    Create a text file (e.g., `urls.txt`) with one URL per line in the same directory as `screenshot.js`:
    ```
    https://url1.com
    https://url2.com
    ```
    Then run:
    ```bash
    node screenshot.js --file urls.txt --width mobile,1440,desktop-xl --output ./output-screenshots
    ```
*   **Defaults**: If no arguments are provided, the script will default to:
    *   **URL**: `https://q30design.com/about/`
    *   **Viewport Width**: `1024px`
    *   **Output Directory**: A folder named `screenshots` in the current working directory where the script is executed.

**Available Arguments:**
*   `--url <url>`: Specifies a single URL to screenshot. Can be used multiple times.
*   `--file <path_to_file.txt>`: Specifies a path to a text file containing one URL per line. This file should be relative to where you execute the script.
*   `--width <number | named_breakpoint | all | comma-separated-list>`: Sets one or more viewport widths.
    *   **Numeric values**: e.g., `1280`, `800,1920`.
    *   **Named breakpoints**: `mobile` (375px), `tablet` (768px), `desktop` (1366px), `desktop-xl` (1920px).
    *   **'all'**: Captures screenshots for all defined named breakpoints.
    *   Can be a comma-separated list of any combination (e.g., `mobile,1024,desktop-xl`).
*   `--output <path>`: Sets the output directory for saving screenshots. This path can be absolute or relative to where you execute the script.

## Long-page failure handling

Tiled captures are checked for the requested width, a height close to the measured page height, page-height changes during capture, and repeated tile hashes. A failed tiled capture is not moved to the final filename. Its tiles and a `failure.json` file remain in a hidden per-page folder inside the output directory for troubleshooting. Temporary tiles are deleted after a successful stitch.

## Tests

The browser tests cover the normal one-shot path, a long page reaching its true footer, lazy-loaded content, fixed and shadow-DOM overlays, successful temporary-file cleanup, and retained diagnostics for repeated-tile failures:

```bash
npm test
```
