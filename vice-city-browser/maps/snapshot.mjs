/**
 * Save a still of the map for the README: docs/snapshot.png.
 *
 * What it does: I start the map's Vite dev server, open the map in headless Chromium at
 * 1600 x 1000 with deviceScaleFactor 2 (so the still is sharp on high-density screens), wait until
 * the start view is completely drawn, save the picture and stop the server again.
 * Reads:  maps/ (through the dev server) and maps/layers/
 * Writes: docs/snapshot.png
 * Run:    npm run snapshot   (from the piece folder, after uv run maps/prepare.py)
 *
 * What you learn: waiting for "the map exists" is not enough for a still. I wait on the map API's
 * ready promise, which resolves only when the buildings, land and water tiles are in, the labels
 * and the page fonts are drawn and a full frame has rendered. This map has no terrain, so there
 * are no elevation tiles to wait for. The sheet stays open, as a reader first sees it, and the
 * hint line stays too: the map always shows it and it has no close control.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const HERE = import.meta.dirname;
const OUT = resolve(HERE, "..", "docs", "snapshot.png");
const PORT = 5190;
const VIEWPORT = { width: 1600, height: 1000 };
const SCALE = 2;
const TIMEOUT_MS = 240_000; // headless Chromium draws on the CPU here, which takes a while at 2x

async function main() {
  const server = await createServer({
    configFile: resolve(HERE, "vite.config.js"),
    logLevel: "warn",
    server: { port: PORT, strictPort: true },
  });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    await page.goto(`http://localhost:${PORT}/`);
    // ui.js sets data-ready only after `await ready` from main.js: the start view is fully drawn.
    await page.waitForSelector("body[data-ready=true]", { timeout: TIMEOUT_MS });
    if (errors.length) throw new Error(`console errors:\n${errors.join("\n")}`);
    mkdirSync(resolve(OUT, ".."), { recursive: true });
    await page.screenshot({ path: OUT });
    console.log(`wrote ${OUT} (${VIEWPORT.width * SCALE} x ${VIEWPORT.height * SCALE} px)`);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
