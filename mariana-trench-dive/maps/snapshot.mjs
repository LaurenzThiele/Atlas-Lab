// Save docs/snapshot.png: the scene's default view, for the README and the landing page card.
//
//   npm run build      (once, so maps/dist exists)
//   npm run snapshot
//
// It builds nothing. I serve maps/dist under a sub path, the way GitHub Pages serves this piece
// (/Atlas-Lab/mariana-trench-dive/), so the snapshot also proves the built page works there.
// Then I open it at 1600 x 1000 with device scale 2, wait for the scene's ready signal, and save
// the default view with the title block, colour scale and labels. This piece is an explainer:
// nothing plays on load, so the default view is exactly what a reader sees first.
//
// Chromium runs headless with software WebGL (SwiftShader), so this works on any machine,
// with or without a graphics card. It is slower than a GPU but needs only one frame.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const HERE = import.meta.dirname;
const DIST = path.join(HERE, "dist");
const OUT = path.join(HERE, "..", "docs", "snapshot.png");
const PREFIX = "/Atlas-Lab/mariana-trench-dive/";
const VIEWPORT = { width: 1600, height: 1000 };
const SCALE = 2;
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("maps/dist is missing: run npm run build first.");
  process.exit(1);
}

/** A tiny static server for maps/dist under the GitHub Pages sub path. */
function serve() {
  const server = http.createServer((req, res) => {
    let file = decodeURIComponent(req.url.split("?")[0]);
    if (!file.startsWith(PREFIX)) return res.writeHead(404).end();
    file = path.join(DIST, file.slice(PREFIX.length) || "index.html");
    if (!file.startsWith(DIST) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

const server = await serve();
const url = `http://localhost:${server.address().port}${PREFIX}`;
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
try {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  // The page sets data-ready once the model, its fonts and its first frame are drawn.
  await page.waitForSelector("html[data-ready]", { state: "attached", timeout: 120000 });
  // Labels are laid out on the frame after ready; give them two frames.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT });
  console.log(`wrote ${path.relative(path.join(HERE, ".."), OUT)} (${VIEWPORT.width} x ${VIEWPORT.height} at scale ${SCALE})`);
} finally {
  await browser.close();
  server.close();
}
