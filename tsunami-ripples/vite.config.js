// Vite settings for the public map.
// npm run build: the site is maps/ alone and goes to maps/dist/. base "./" makes every URL relative,
// which is what GitHub Pages needs for a project page: the site is served from /<repo>/, not from
// the domain root.
// npm run dev: the root is the whole piece folder, so the dev server can serve any page in it. The
// map is at /maps/, and / redirects there.
import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const ROOT_DIR = import.meta.dirname;
const MAPS_DIR = resolve(ROOT_DIR, "maps");

// The map fetches its layers at run time, so Vite cannot see them. I copy them next to the build.
function copyLayers() {
  return {
    name: "copy-layers",
    closeBundle() {
      cpSync(resolve(MAPS_DIR, "layers"), resolve(MAPS_DIR, "dist/layers"), { recursive: true });
    },
  };
}

function redirectRootToMap() {
  return {
    name: "redirect-root-to-map",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/") return next();
        res.writeHead(302, { Location: "/maps/" });
        res.end();
      });
    },
  };
}

// maps/public/ holds the tab icons. The build copies them to the top of maps/dist/, next to
// index.html, so the relative links in the page find them. In dev the page lives at /maps/, so I
// point /maps/<file> at maps/public/<file> to keep the same links working there.
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
        build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
        plugins: [copyLayers()],
      }
    : {
        root: ROOT_DIR,
        publicDir: false,
        optimizeDeps: { entries: ["maps/index.html"] },
        server: { watch: { ignored: ["**/.venv/**", "**/data/raw/**", "**/maps/dist/**"] } },
        plugins: [redirectRootToMap(), servePublicUnderMaps()],
      },
);
