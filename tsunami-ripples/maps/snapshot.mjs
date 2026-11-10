/**
 * A static snapshot of the map for the README.
 *
 * What it does: starts the Vite dev server, opens the map in headless Chromium at 1600 x 1000 with
 * a device scale factor of 2, waits until the map is really drawn, and saves the page as it opens:
 * the Pacific globe with every ring, the land tint, the graticule and the open sheet.
 * Reads:  the map in maps/ and its layers in maps/layers/ (run uv run maps/prepare.py first)
 * Writes: docs/snapshot.png
 * Run:    npm run snapshot   (from the piece folder; Playwright needs its browser once:
 *                             npx playwright install --with-deps chromium)
 *
 * What you learn: how to wait for a WebGL map without guessing. A fixed timeout is either too short
 * on a slow machine or wasted time on a fast one, so I wait on the map's own ready promise instead.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const PIECE_DIR = resolve(HERE, "..");
const OUT_FILE = resolve(PIECE_DIR, "docs", "snapshot.png");
const VIEWPORT = { width: 1600, height: 1000 };
const SCALE = 2;
const TIMEOUT_MS = 120_000;

async function main() {
  // I start my own dev server on a free port and stop it at the end, so the script works whether
  // or not npm run dev is already running.
  const server = await createServer({
    root: PIECE_DIR,
    configFile: resolve(PIECE_DIR, "vite.config.js"),
    server: { port: 0, strictPort: false },
    logLevel: "error",
  });
  await server.listen();
  const url = new URL("maps/", server.resolvedUrls.local[0]).href;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      // With reduced motion the page opens on the finished record, timeline at 2026 with every ring
      // drawn, instead of playing it from 684. That is the opening view as a still.
      reducedMotion: "reduce",
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    await page.goto(url);

    // The page puts the map on window.atlasMap once it has started. I then wait on its ready
    // promise: the rings, the land and the key figures are loaded, the fonts are in and the GPU is
    // up. This map has no terrain, so there are no tiles to wait for. Two animation frames after
    // that, the first full picture is on the canvas.
    await page.waitForFunction(() => window.atlasMap, null, { timeout: TIMEOUT_MS });
    await page.evaluate(async () => {
      await window.atlasMap.ready;
      await document.fonts.ready;
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    });
    if (errors.length) throw new Error(`the map reported errors: ${errors.join(" | ")}`);

    // The hint line is always shown and has no close control, so it stays in the picture. The
    // sheet is open by default, which is what I want: title, lede, key, figures and sources.
    mkdirSync(dirname(OUT_FILE), { recursive: true });
    await page.screenshot({ path: OUT_FILE });
    console.log(`wrote  ${OUT_FILE}`);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
