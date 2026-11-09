/**
 * A static snapshot of the map for the README.
 *
 * What it does: starts the Vite dev server, opens the map in headless Chromium at 1600x1000 with
 * deviceScaleFactor 2 (so the PNG is 3200x2000 and stays sharp on a retina screen), waits until the
 * map, the 3D terrain and every tile have loaded and the map is idle, and saves the picture with the
 * sheet open. The hint line stays: it is always shown and has no close control. Then it stops the
 * server again.
 * Reads:  maps/index.html, maps/main.js, maps/layers/ (run uv run maps/prepare.py first)
 * Writes: docs/snapshot.png
 * Run:    npm run snapshot
 *
 * What you learn: how to tell when a WebGL map is really finished. A fixed timeout is a guess, and
 * window.map existing only means the map object was made. I wait on the map's own ready promise
 * (style, layers and fonts loaded) and then on renderAt(), which waits for MapLibre's idle event:
 * no tile still loading, no camera moving, nothing left to draw.
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PNG = resolve(HERE, "..", "docs", "snapshot.png");
const VIEWPORT = { width: 1600, height: 1000 };
const DEVICE_SCALE = 2;
const LOAD_TIMEOUT_MS = 180_000;

// Headless Chromium has no GPU on many machines (and none in WSL), so I ask for SwiftShader, its
// software WebGL. It is slow, but for a single picture that does not matter, and it runs anywhere.
const BROWSER_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

/** The dev server with the piece's own Vite config, on a free port. */
async function startServer() {
  const server = await createServer({
    configFile: resolve(HERE, "vite.config.js"),
    server: { port: 5180, strictPort: false },
    logLevel: "error",
  });
  await server.listen();
  return server;
}

/**
 * Wait inside the page until the picture is finished. I import the same module the page already
 * runs (same URL, so the same instance), so ready and renderAt belong to the map on screen.
 */
async function waitForMap(page) {
  await page.evaluate(async () => {
    const { ready, renderAt } = await import("/maps/main.js");
    const { map } = await ready;
    if (!map.getTerrain()) throw new Error("the map has no 3D terrain");
    // renderAt(1) shows the whole river network, which is what the map shows on load anyway.
    await renderAt(1);
    await document.fonts.ready;
  });
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({ args: BROWSER_ARGS });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE });
    page.setDefaultTimeout(LOAD_TIMEOUT_MS);
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));

    const url = new URL("maps/", server.resolvedUrls.local[0]).href;
    console.log(`opening ${url}`);
    await page.goto(url);
    await waitForMap(page);

    // The sheet is open by default; I check it rather than trust it, since the snapshot needs it.
    if (!(await page.locator("#sheet").isVisible())) throw new Error("the sheet is not open");
    if (errors.length) throw new Error(`the page logged errors:\n${errors.join("\n")}`);

    await mkdir(dirname(OUT_PNG), { recursive: true });
    await page.screenshot({ path: OUT_PNG });
    console.log(`wrote ${OUT_PNG} (${VIEWPORT.width * DEVICE_SCALE}x${VIEWPORT.height * DEVICE_SCALE})`);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
