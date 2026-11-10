/* Take the static snapshot of the map for the README.

   What it does: builds the map (npm run build), serves maps/dist/ on a local port, opens it in
   headless Chromium at 1600 x 1000 with deviceScaleFactor 2, waits until the map is fully drawn
   and saves docs/snapshot.png. It stops the server it started.
   Reads:  maps/dist/ (written by the build)
   Writes: docs/snapshot.png
   Run:    npm run snapshot   (from the piece folder)

   What you learn: how to wait for a WebGL map honestly. A fixed timeout either wastes time or
   catches the map half drawn. The page marks itself ready (body[data-map="ready"]) only after the
   map API's ready promise has resolved: every layer and its tiles loaded and painted, the fonts in,
   and two animation frames later. This map has no terrain, so there are no elevation tiles to
   wait for; its roads and plate come from two PMTiles archives read with range requests, which
   is why the little server below answers range requests too. */

import { spawnSync } from "node:child_process";
import { createReadStream, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "dist");
const OUT = resolve(HERE, "..", "docs", "snapshot.png");
const VIEWPORT = { width: 1600, height: 1000 };
const SCALE = 2;
const READY_TIMEOUT_MS = 180_000;
// Headless Chromium has no GPU here; SwiftShader draws WebGL in software, slowly but exactly.
const GL_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".geojson": "application/geo+json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function build() {
  const result = spawnSync("npm", ["run", "build"], { cwd: resolve(HERE, ".."), stdio: "inherit" });
  if (result.status !== 0) throw new Error("npm run build failed");
}

/** A static server for maps/dist/ that also answers range requests, as GitHub Pages does. */
function serve() {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url.split("?")[0]);
    const file = join(DIST, path === "/" ? "index.html" : path);
    const stat = statSync(file, { throwIfNoEntry: false });
    if (!file.startsWith(DIST) || !stat || stat.isDirectory()) return response.writeHead(404).end();
    const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/);
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : stat.size - 1;
      response.writeHead(206, {
        "content-range": `bytes ${start}-${end}/${stat.size}`,
        "content-length": end - start + 1,
      });
      return createReadStream(file, { start, end }).pipe(response);
    }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  return new Promise((done) => server.listen(0, () => done(server)));
}

async function main() {
  build();
  const server = await serve();
  const browser = await chromium.launch({ args: GL_ARGS });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://localhost:${server.address().port}/`);
    await page.waitForFunction(() => document.body.dataset.map, null, { timeout: READY_TIMEOUT_MS });
    if ((await page.evaluate(() => document.body.dataset.map)) !== "ready" || errors.length) {
      throw new Error(`the map did not draw: ${errors.join("; ")}`);
    }
    // The hint line stays: the map rules keep it always shown, with no close control. The sheet
    // with the title, key and sources stays open, as a reader first sees it.
    mkdirSync(dirname(OUT), { recursive: true });
    await page.screenshot({ path: OUT, timeout: READY_TIMEOUT_MS });
    console.log(`saved ${OUT}`);
  } finally {
    await browser.close();
    server.close();
  }
}

await main();
