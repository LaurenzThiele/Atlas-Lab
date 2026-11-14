/**
 * Save docs/snapshot.png: the scene's default view, the picture the README and the landing page
 * card show.
 *
 * What it does: I serve the built page (maps/dist, from `npm run build`) under the same sub path
 * GitHub Pages uses, /Atlas-Lab/switzerland-in-one-line/, so every relative link is tested the way
 * it will run live. Then I open it in Chromium at 1600 x 1000 with a device scale of 2, wait until
 * the scene says it is ready (the html element gets data-ready once the first full frame is drawn
 * and the fonts are in) and the map controls line shows, and take one screenshot. Nothing plays on
 * load: the page opens on the default view, with the title, the bottom-left block and the labels.
 * Reads:  maps/dist/ (run `npm run build` first; this script builds nothing)
 * Writes: docs/snapshot.png
 * Run:    npm run snapshot   (from the piece folder)
 *
 * What you learn: how to test a static site under its real sub path without deploying it, and how
 * to wait on the page's own ready signal instead of a fixed timeout. WebGL runs in software here
 * (SwiftShader), so the script works on any machine, with or without a GPU.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const HERE = import.meta.dirname;
const DIST = path.join(HERE, "dist");
const OUT = path.join(HERE, "..", "docs", "snapshot.png");
const PREFIX = "/Atlas-Lab/switzerland-in-one-line/";
const VIEWPORT = { width: 1600, height: 1000 };
const DEVICE_SCALE = 2;
const READY_TIMEOUT_MS = 120_000; // software WebGL is slow to draw the first frame
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

/** A tiny static server for maps/dist under the GitHub Pages sub path. */
function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (!p.startsWith(PREFIX)) return res.writeHead(404).end();
    p = p.slice(PREFIX.length) || "index.html";
    const file = path.join(DIST, p);
    if (!file.startsWith(DIST) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

async function main() {
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    throw new Error("maps/dist/index.html is missing: run `npm run build` first");
  }
  const server = await serve();
  const url = `http://localhost:${server.address().port}${PREFIX}`;
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(url);
    // The scene's ready signal, then the map controls line (it shows once a click can read).
    await page.waitForSelector("html[data-ready]", { state: "attached", timeout: READY_TIMEOUT_MS });
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById("hint")).visibility === "visible",
      null,
      { timeout: READY_TIMEOUT_MS },
    );
    // Two more animation frames, so the labels are laid out on the frame that is captured.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const playing = await page.evaluate(() => document.body.classList.contains("animating"));
    const noteOpen = await page.isVisible("#note");
    if (playing || noteOpen) throw new Error("the page is not on its quiet default view");
    if (errors.length) throw new Error(`the page reported errors:\n  ${errors.join("\n  ")}`);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    await page.screenshot({ path: OUT });
    const size = fs.statSync(OUT).size;
    console.log(`wrote ${path.relative(path.join(HERE, ".."), OUT)} (${VIEWPORT.width * DEVICE_SCALE} x ${VIEWPORT.height * DEVICE_SCALE} px, ${(size / 1024).toFixed(0)} KB)`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
