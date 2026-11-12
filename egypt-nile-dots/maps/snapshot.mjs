/**
 * The README's picture of the map: docs/snapshot.png.
 *
 * What it does: starts the Vite dev server, opens the map in headless Chromium at 1600 x 1000
 * with twice the pixels, waits until the start view is completely drawn and saves a screenshot.
 * Reads:  the map in maps/ (served by the dev server) and its layers in maps/layers/
 * Writes: docs/snapshot.png
 * Run:    npm run snapshot   (after uv run maps/prepare.py)
 *
 * What you learn: how to wait for a WebGL map honestly. I never wait a fixed number of seconds:
 * I wait on the map API's ready promise, which resolves once the plate, the heatmap, the labels
 * and the fonts are loaded and a full frame has been drawn (this map has no terrain, so there are
 * no terrain tiles to wait for), and on the page saying its own readout is filled in.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "docs", "snapshot.png");
const VIEWPORT = { width: 1600, height: 1000 };
const SCALE = 2; // device pixels per CSS pixel, so the picture stays sharp on a retina screen
const TIMEOUT_MS = 60000;

async function main() {
  // I start the same dev server as npm run dev, on a free port, and stop it at the end.
  const server = await createServer({
    configFile: resolve(HERE, "vite.config.js"),
    server: { port: 4180, strictPort: false },
    logLevel: "error",
  });
  await server.listen();
  const url = `${server.resolvedUrls.local[0]}maps/`;
  // WebGL in headless Chromium: I ask for the GPU and let it fall back to software rendering.
  const browser = await chromium.launch({ args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=gl"] });
  try {
    // Reduced motion skips the opening, where the heatmap draws in square by square, so the
    // picture is the finished start view and not one frame of the animation.
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    // The map API's own promise, from the same module the page uses.
    await page.evaluate(async () => {
      const { ready } = await import("/maps/main.js");
      await ready;
    });
    await page.waitForSelector("body[data-ready=true]", { timeout: TIMEOUT_MS });
    // The hint line has no close control: the page keeps it always shown, so it stays in the
    // picture. The sheet stays open, with the title, the lede and the key.
    await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
    if (errors.length) throw new Error(`the map reported errors: ${errors.join("; ")}`);
    mkdirSync(dirname(OUT), { recursive: true });
    await page.screenshot({ path: OUT });
    console.log(`wrote ${OUT}`);
  } finally {
    await browser.close();
    await server.close();
  }
}

await main();
