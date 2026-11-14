// Vite settings for the public scene.
// npm run build: the site is maps/ alone and goes to maps/dist/. base "./" makes every URL
// relative, which GitHub Pages needs for a project page served from /<repo>/<piece>/.
// npm run dev: the root is the whole piece folder, so the dev server can serve any page in it.
// The scene is at /maps/, and / redirects there.
import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const ROOT_DIR = import.meta.dirname;
const MAPS_DIR = resolve(ROOT_DIR, "maps");

// The scene fetches relief.png and section.json at run time, under their own names, so the
// "Download the data" links stay readable. Vite cannot see those fetches, so I copy the layers
// next to the build.
function copyLayers() {
  return {
    name: "copy-layers",
    closeBundle() {
      cpSync(resolve(MAPS_DIR, "layers"), resolve(MAPS_DIR, "dist/layers"), { recursive: true });
    },
  };
}

function redirectRootToScene() {
  return {
    name: "redirect-root-to-scene",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/") return next();
        res.writeHead(302, { Location: "/maps/" });
        res.end();
      });
    },
  };
}

// maps/public/ holds the tab icons. The build copies them next to index.html, so the relative
// links in the page find them. In dev the page lives at /maps/, so I point /maps/<file> at
// maps/public/<file> to keep the same links working there.
function servePublicUnderMaps() {
  return {
    name: "serve-public-under-maps",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = req.url?.match(/^\/maps\/([\w.-]+)$/);
        if (match && existsSync(resolve(MAPS_DIR, "public", match[1]))) {
          req.url = `/maps/public/${match[1]}`;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ command }) =>
  command === "build"
    ? {
        root: MAPS_DIR,
        base: "./",
        publicDir: "public",
        build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1000 },
        plugins: [copyLayers()],
      }
    : {
        root: ROOT_DIR,
        publicDir: false,
        optimizeDeps: { entries: ["maps/index.html"] },
        server: { watch: { ignored: ["**/.venv/**", "**/data/raw/**", "**/maps/dist/**"] } },
        plugins: [redirectRootToScene(), servePublicUnderMaps()],
      },
);
