// Build settings for the map. Why Vite: it bundles MapLibre, PMTiles and the fonts into plain
// static files, so the finished site needs no server of its own. The relative base './' lets the
// site work from any GitHub Pages subpath. The map fetches its layers at run time, where the
// bundler cannot see them, so a small plugin copies those layers (and the two files in ai/ that
// the download dialog offers) into the build.
//
// Both commands start from maps/ alone: npm run dev serves the map at the server's root, and
// npm run build writes only the public map to maps/dist/.
import { cpSync, createReadStream, existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { defineConfig } from "vite";

const HERE = import.meta.dirname;
const AI_DIR = resolve(HERE, "..", "ai");

// Only what the public map fetches, plus the downloads it offers. buildings.pmtiles is not in the
// repo (it is too big; uv run maps/prepare.py writes it), but the live map needs it, so it ships.
const PUBLIC_FILES = [
  ["layers/buildings.pmtiles", "layers/buildings.pmtiles"],
  ["layers/base.pmtiles", "layers/base.pmtiles"],
  ["layers/labels.geojson", "layers/labels.geojson"],
  ["layers/figures.json", "layers/figures.json"],
  ["layers/meta.json", "layers/meta.json"],
  ["layers/download/land.geojson.zip", "layers/download/land.geojson.zip"],
  ["layers/download/water.geojson.zip", "layers/download/water.geojson.zip"],
  ["../ai/prompt.txt", "ai/prompt.txt"],
  ["../ai/rules-for-claude.md", "ai/rules-for-claude.md"],
];

function copyLayers() {
  return {
    name: "copy-layers",
    closeBundle() {
      for (const dir of ["layers/download", "ai"]) mkdirSync(resolve(HERE, "dist", dir), { recursive: true });
      for (const [from, to] of PUBLIC_FILES) {
        if (!existsSync(resolve(HERE, from))) throw new Error(`${from} is missing: run uv run maps/prepare.py`);
        cpSync(resolve(HERE, from), resolve(HERE, "dist", to));
      }
    },
  };
}

// The download dialog links ai/prompt.txt and ai/rules-for-claude.md next to the page, as on the
// built site. In development they live one folder up, so the server hands them out from there.
function serveAiFiles() {
  return {
    name: "serve-ai-files",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const match = request.url.match(/^\/ai\/([\w.-]+)$/);
        const file = match && resolve(AI_DIR, basename(match[1]));
        if (!file || !existsSync(file)) return next();
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        createReadStream(file).pipe(response);
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  root: HERE,
  base: "./",
  // maps/public/ holds the tab icons; Vite serves them in development and copies them on build.
  publicDir: "public",
  plugins: command === "build" ? [copyLayers()] : [serveAiFiles()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  optimizeDeps: { include: ["maplibre-gl", "pmtiles"] },
  // The raw data and the Python environment are large and never change while I work here.
  server: { watch: { ignored: ["**/data/raw/**", "**/.venv/**"] } },
}));
