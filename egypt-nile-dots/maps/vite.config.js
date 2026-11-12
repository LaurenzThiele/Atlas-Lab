// Build settings for the map. Why Vite: it bundles MapLibre, deck.gl and the fonts into plain
// static files, so the finished site needs no server of its own. The relative base './' lets the
// site work from any GitHub Pages subpath. I fetch the layers at run time, where the bundler
// cannot see them, so a small plugin copies the layers the map uses into the build.
//
// The two commands use different roots on purpose. The dev server serves the whole piece folder,
// so that a page written next to maps/ can import the map's API from ../maps/main.js. The build
// starts from maps/ alone, so only the public map ends up in maps/dist/.
import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const HERE = import.meta.dirname;
const PIECE_DIR = resolve(HERE, "..");

// Only what the public map fetches, plus the downloads it offers. The dots are not here: the public
// page does not draw them, and pages that script their own views on them run on the dev server.
const PUBLIC_LAYERS = [
  "squares.bin",
  "squares.json",
  "share_curve.json",
  "land.json",
  "egypt_border.json",
  "nile_lakes.json",
  "labels.json",
  "key_figures.json",
  "meta.json",
  "download/egypt_population_1km.csv",
  "download/land.geojson",
  "download/egypt_border.geojson",
  "download/nile_lakes.geojson",
];

function copyLayers() {
  return {
    name: "copy-layers",
    closeBundle() {
      mkdirSync(resolve(HERE, "dist/layers/download"), { recursive: true });
      for (const name of PUBLIC_LAYERS) {
        cpSync(resolve(HERE, "layers", name), resolve(HERE, "dist/layers", name));
      }
    },
  };
}

const ICONS = ["/maps/favicon.svg", "/maps/favicon-32.png", "/maps/apple-touch-icon.png"];

// With the piece folder as root, the map lives at /maps/. A visit to / should still find it. The
// tab icons sit in maps/public/ but the page asks for them next to itself, as on the built site.
function redirectRootToMap() {
  return {
    name: "redirect-root-to-map",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (ICONS.includes(request.url)) request.url = request.url.replace("/maps/", "/maps/public/");
        if (request.url !== "/") return next();
        response.writeHead(302, { Location: "/maps/" });
        response.end();
      });
    },
  };
}

export default defineConfig(({ command }) =>
  command === "build"
    ? {
        root: HERE,
        base: "./",
        // maps/public/ holds the tab icons. Vite copies them to the top of maps/dist/ untouched.
        publicDir: "public",
        plugins: [copyLayers()],
        build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
      }
    : {
        root: PIECE_DIR,
        publicDir: false,
        plugins: [redirectRootToMap()],
        // Telling Vite about the big libraries up front spares a reload on the very first visit.
        optimizeDeps: {
          entries: ["maps/index.html"],
          include: ["maplibre-gl", "@deck.gl/core", "@deck.gl/layers", "@deck.gl/extensions", "@deck.gl/mapbox"],
        },
        // The raw data and the Python environment are large and never change while I work here.
        server: { watch: { ignored: ["**/data/raw/**", "**/.venv/**"] } },
      },
);
