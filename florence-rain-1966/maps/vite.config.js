// Build settings for the map. Why Vite: it bundles MapLibre and the fonts into plain static files,
// so the finished site needs no server of its own. The relative base './' lets the site work from
// any GitHub Pages subpath. I fetch the layers at run time, where the bundler cannot see them, so a
// small plugin copies maps/layers/ into the build.
//
// The two commands use different roots on purpose. The dev server serves the whole piece folder, so
// that any page you write next to maps/ can import the map's API from ../maps/main.js. The build
// starts from maps/ alone, so only the public map ends up in maps/dist/.
import { cpSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const HERE = import.meta.dirname;
const PIECE_DIR = resolve(HERE, "..");

function copyLayers() {
  return {
    name: "copy-layers",
    closeBundle() {
      cpSync(resolve(HERE, "layers"), resolve(HERE, "dist/layers"), { recursive: true });
    },
  };
}

const ICONS = ["/maps/favicon.svg", "/maps/favicon-32.png", "/maps/apple-touch-icon.png"];

// With the piece folder as root, the map lives at /maps/. A visit to / should still find it. The tab
// icons sit in maps/public/ but the page asks for them next to itself, as on the built site.
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
        // Telling Vite about MapLibre up front spares a reload on the very first visit.
        optimizeDeps: { entries: ["maps/index.html"], include: ["maplibre-gl"] },
        // The raw data and the Python environment are large and never change while I work here.
        server: { watch: { ignored: ["**/data/raw/**", "**/.venv/**"] } },
      },
);
