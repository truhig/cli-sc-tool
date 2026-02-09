# CLI Screenshot Tool

This is a Node.js script that uses Puppeteer to capture full-page screenshots of specified web pages. It's configured to run with a reduced motion preference and a short delay to ensure content is fully loaded and animations are settled before taking the screenshot.

## Installation

1.  **Node.js**: Ensure you have Node.js installed. If not, download it from [nodejs.org](https://nodejs.org/).
2.  **Puppeteer**: From the root of the `screenshot-tool` directory, install Puppeteer:
    ```bash
    npm install puppeteer
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
