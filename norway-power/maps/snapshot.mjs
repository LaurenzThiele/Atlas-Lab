/**
 * A static snapshot of the scene for the README.
 *
 * What it does: serves the built page from maps/dist under the same sub path GitHub Pages uses
 * (/Atlas-Lab/norway-power/), opens it in headless Chromium at 1600 x 1000 with a device scale
 * factor of 2, waits until the scene is ready and the plants and lines have finished drawing
 * themselves on, and saves the default view with its title, legend, capacity key and labels.
 * Reads:  maps/dist (run npm run build first; this script builds nothing)
 * Writes: docs/snapshot.png
 * Run:    npm run snapshot   (from the piece folder; Playwright needs its browser once:
 *                             npx playwright install --with-deps chromium)
 *
 * What you learn: how to photograph a WebGL page without guessing. A fixed timeout is either too
 * short on a slow machine or wasted time on a fast one, so I wait on what the page itself says:
 * the ready flag it sets once every layer is drawn, then the legend counters reaching their final
 * values and the labels appearing, which happens only when the drawing is complete.
 */

import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import http from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const PIECE_DIR = resolve(HERE, "..");
const DIST_DIR = resolve(HERE, "dist");
const OUT_FILE = resolve(PIECE_DIR, "docs", "snapshot.png");
const SUB_PATH = "/Atlas-Lab/norway-power/";
const VIEWPORT = { width: 1600, height: 1000 };
const SCALE = 2;
const TIMEOUT_MS = 180_000;
// The legend counters end on the key figures once every plant is lit and every line is drawn.
const FINAL_COUNTERS = { "#count-mw .readout": "30,474", "#count-km .readout": "9,200" };
const LABELS = ["Kvilldal", "Oslo", "Bergen"];
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

/** A tiny static server for maps/dist, mounted under the GitHub Pages sub path. */
function serveDist() {
  const server = http.createServer((request, response) => {
    const path = decodeURIComponent(request.url.split("?")[0]);
    if (!path.startsWith(SUB_PATH)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const relative = path.slice(SUB_PATH.length) || "index.html";
    const file = join(DIST_DIR, relative.endsWith("/") ? `${relative}index.html` : relative);
    if (!file.startsWith(DIST_DIR) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  return new Promise((done) => server.listen(0, () => done(server)));
}

async function main() {
  if (!existsSync(join(DIST_DIR, "index.html"))) {
    throw new Error("maps/dist is missing: run npm run build first");
  }
  const server = await serveDist();
  const url = `http://localhost:${server.address().port}${SUB_PATH}`;
  // Headless Chromium draws WebGL in software (SwiftShader) when it has no GPU, which is slow but
  // gives the same picture; the page caps one slow frame at half a second of drawing.
  const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    await page.goto(url);

    // The page sets data-ready on <html> once the relief, the plants, the lines and the fonts are
    // loaded and the first full frame is drawn. Then the data draws itself on, plants first.
    await page.waitForSelector("html[data-ready]", { state: "attached", timeout: TIMEOUT_MS });
    await page.waitForFunction(
      ({ counters, labels }) => {
        const done = Object.entries(counters).every(([selector, value]) => document.querySelector(selector)?.textContent === value);
        const shown = [...document.querySelectorAll(".model-label:not([hidden]) .name")].map((el) => el.textContent);
        return done && labels.every((name) => shown.includes(name));
      },
      { counters: FINAL_COUNTERS, labels: LABELS },
      { timeout: TIMEOUT_MS },
    );
    // Two animation frames, so the last drawn frame is on the canvas.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    if (errors.length) throw new Error(`the page reported errors: ${errors.join(" | ")}`);

    mkdirSync(dirname(OUT_FILE), { recursive: true });
    await page.screenshot({ path: OUT_FILE });
    console.log(`wrote  ${OUT_FILE}`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
