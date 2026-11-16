/**
 * Miami's buildings at their real height: the map itself, as a small API.
 *
 * What it does: draws every building from Miami Beach to Brickell as a block raised to its height,
 * on flat land and water, under a dusk sky. It knows nothing about the page around it: the title,
 * the key, the notes and the buttons live in index.html and ui.js, so any script can draw clean
 * views of the same map.
 * Reads:  layers/buildings.pmtiles, layers/base.pmtiles, layers/labels.geojson,
 *         layers/figures.json, layers/meta.json, fonts/outfit-*.woff2
 * Writes: nothing
 * Run:    npm run dev, then open the address it prints (index.html loads ui.js, which loads this)
 *
 * The API:
 *   createMap(container, options)  draws the map; resolves to { map, figures, meta }. Options:
 *                                  view, layers, layersUrl, interactive, preserveDrawingBuffer,
 *                                  and fadeDuration (label fade in ms; 0 shows labels at once)
 *   ready                          resolves once the start view is fully drawn (tiles, fonts, labels)
 *   setView(camera, { duration })  jumps (or eases) to { center, zoom, pitch, bearing }
 *   setLayers(layers)              which layers show, and which place names:
 *                                  { show: ["labels", "buildings", "water", "land"],
 *                                    labelNames: [...] }
 *   setHighlight(fid)              marks one building in marquee yellow (null clears it)
 *   projectPoint(lngLat, heightM)  where a point at a height above the ground is on screen
 *   setTime(step)                  this map has no time steps: resolves at once, kept so every
 *                                  AtlasLab map answers the same calls
 *
 * Why MapLibre's fill-extrusion and vector tiles: fill-extrusion raises each footprint on the GPU,
 * so 187,203 buildings still turn at 60 frames a second, and the PMTiles file holds the city cut
 * into tiles, so the browser fetches only the part on screen, over plain HTTP range requests.
 * No tile server is needed: GitHub Pages serves the one file.
 *
 * What you learn: how little a 3D city needs. No 3D models, no textures: a footprint and one
 * number per building, a colour ramp on that number, a soft light and a hazy sky.
 */

import * as maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre 6 runs its tile parsing in a module worker that it looks for next to its own file. A
// bundler moves that file, so I import the worker as a URL and tell MapLibre where it went.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import outfitRegularUrl from "./fonts/outfit-400.woff2?url";
import outfitSemiBoldUrl from "./fonts/outfit-600.woff2?url";

// The view the page opens on: downtown and Brickell seen from over Biscayne Bay, tilted far
// enough (76°) that the towers stand against the pink horizon.
export const START_VIEW = { center: [-80.182, 25.752], zoom: 14.1, pitch: 76, bearing: -24 };
export const MAX_PITCH = 85;

// The palette of this map: a city at dusk that looks like a game but is all real data.
export const COLOURS = {
  paper: "#1A1430", // dusk violet: background, sky top and the UI paper
  land: "#2A2040", // night asphalt
  water: "#0F2240", // bay blue
  waterEdge: "#2C4C7A", // a lighter bay blue on the shore, so the bay reads against the land
  highlight: "#FFD23F", // marquee yellow: only the clicked building
  ink: "#F6EEF5", // neon white
  waterLabel: "#9FC9E8",
};

// The height ramp, low to high, interpolated in straight lines between these stops (metres).
// Most of Miami is houses under 8 m, so the first steps are close together: the teal carpet of
// the suburbs, then mint, lavender and pink as the towers rise.
export const HEIGHT_RAMP = [
  [0, "#1E5F6B"],
  [8, "#2A9D9A"],
  [25, "#4FD1C1"],
  [60, "#B48BE0"],
  [120, "#FF5FA2"],
  [220, "#FFC1DA"],
];

// The style layers behind each name of setLayers, in drawing order, top first.
const LAYER_IDS = {
  labels: ["labels-place", "labels-water"],
  buildings: ["buildings"],
  water: ["water"],
  land: ["land"],
};
export const LAYER_NAMES = Object.keys(LAYER_IDS);

let map = null;
let resolveReady;
let rejectReady;
export const ready = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});

let state = { show: [...LAYER_NAMES], labelNames: null };
let highlighted = null;
let viewMatrix = null; // the last frame's mercator-to-screen matrix, kept by the probe layer
let skyMatrix = null; // the same frame's world-pixel matrix, which places MapLibre's own horizon

function heightColour() {
  return ["interpolate", ["linear"], ["get", "h"], ...HEIGHT_RAMP.flat()];
}

/** The building colour: the height ramp, or marquee yellow for the marked building. */
function buildingColour() {
  return ["case", ["boolean", ["feature-state", "selected"], false], COLOURS.highlight, heightColour()];
}

/** The label filter: one kind (land or water), and only the named places if a list is given. */
function labelFilter(kind, names) {
  const byName = names ? ["in", ["get", "name"], ["literal", names]] : true;
  return ["all", ["==", ["get", "kind"], kind], byName];
}

function absolute(url) {
  return new URL(url, document.baseURI).href;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

function buildStyle(layersUrl, labels) {
  const visibility = (name) => (state.show.includes(name) ? "visible" : "none");
  const at = (name) => new URL(name, layersUrl).href;
  return {
    version: 8,
    // No glyphs URL: the labels are drawn in the browser from the same Outfit files the page
    // uses, declared in font-faces. The file carries its own weight, so "SemiBold" in the name
    // is only a name.
    "font-faces": {
      "Outfit SemiBold": [{ url: absolute(outfitSemiBoldUrl) }],
      "Outfit Regular": [{ url: absolute(outfitRegularUrl) }],
    },
    sources: {
      buildings: {
        type: "vector",
        url: `pmtiles://${at("buildings.pmtiles")}`,
        // Feature state (the marked building) needs an id: fid, written by prepare.py.
        promoteId: "fid",
      },
      base: { type: "vector", url: `pmtiles://${at("base.pmtiles")}` },
      // The five names come in as data, fetched with the other small files: a GeoJSON source
      // given a URL is fetched inside MapLibre's worker, and on GitHub Pages that fetch failed now
      // and then ("Failed to fetch") for reasons I could not see from the page.
      labels: { type: "geojson", data: labels },
    },
    // The sky above the horizon. Its fog settings only act on terrain, and this map has none:
    // 187,203 extruded buildings on even a flat terrain ran at under 1 frame a second here (the
    // GPU redraws every block against the terrain mesh), against 30 without it. The haze where
    // the ground meets the sky is drawn instead by the band below (addHaze), in the fog colour.
    sky: {
      "sky-color": "#2A1B48",
      "horizon-color": "#FF8FB8",
      "fog-color": "#6B3E73",
      "sky-horizon-blend": 0.6,
      "horizon-fog-blend": 0.7,
      "fog-ground-blend": 0.4,
    },
    // A soft white light from the viewer's side. The colour lives in the ramp: a pink light
    // would turn the teal houses brown.
    light: { anchor: "viewport", color: "#FFF6FA", intensity: 0.25 },
    layers: [
      { id: "background", type: "background", paint: { "background-color": COLOURS.paper } },
      {
        id: "land",
        type: "fill",
        source: "base",
        "source-layer": "land",
        layout: { visibility: visibility("land") },
        paint: { "fill-color": COLOURS.land },
      },
      {
        id: "water",
        type: "fill",
        source: "base",
        "source-layer": "water",
        layout: { visibility: visibility("water") },
        paint: { "fill-color": COLOURS.water, "fill-outline-color": COLOURS.waterEdge },
      },
      {
        id: "buildings",
        type: "fill-extrusion",
        source: "buildings",
        "source-layer": "buildings",
        layout: { visibility: visibility("buildings") },
        paint: {
          "fill-extrusion-color": buildingColour(),
          "fill-extrusion-height": ["get", "h"],
          // Overture's min_height is empty for every building here, so all stand on the ground.
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 1,
          // Darker at the foot, lighter at the roof: it gives the blocks depth without texture.
          "fill-extrusion-vertical-gradient": true,
        },
      },
      {
        id: "labels-water",
        type: "symbol",
        source: "labels",
        filter: labelFilter("water", state.labelNames),
        layout: {
          visibility: visibility("labels"),
          "text-field": ["get", "name"],
          "text-font": ["Outfit Regular"],
          "text-size": 14,
          "text-transform": "uppercase",
          "text-letter-spacing": 0.12,
          "text-pitch-alignment": "viewport",
          "text-rotation-alignment": "viewport",
        },
        paint: { "text-color": COLOURS.waterLabel, "text-halo-color": COLOURS.paper, "text-halo-width": 2 },
      },
      {
        id: "labels-place",
        type: "symbol",
        source: "labels",
        filter: labelFilter("land", state.labelNames),
        layout: {
          visibility: visibility("labels"),
          "text-field": ["get", "name"],
          "text-font": ["Outfit SemiBold"],
          "text-size": 14,
          "text-transform": "uppercase",
          "text-letter-spacing": 0.04,
          "text-pitch-alignment": "viewport",
          "text-rotation-alignment": "viewport",
        },
        paint: { "text-color": COLOURS.ink, "text-halo-color": COLOURS.paper, "text-halo-width": 2 },
      },
    ],
  };
}

/**
 * A layer that draws nothing. MapLibre hands every custom layer the matrix that turns a point
 * in the world into a point on screen; I keep it, so projectPoint() can place things at a height
 * (the roof of a tower), which map.project() cannot: it only knows the ground.
 */
const probeLayer = {
  id: "probe",
  type: "custom",
  renderingMode: "2d",
  render(_gl, args) {
    // mainMatrix takes mercator coordinates (0 to 1 across the world, z in the same units), the
    // ones MercatorCoordinate.fromLngLat gives; modelViewProjectionMatrix works in world pixels.
    viewMatrix = Float64Array.from(args.defaultProjectionData.mainMatrix);
    skyMatrix = Float64Array.from(args.modelViewProjectionMatrix);
  },
};

/**
 * Where [lng, lat] at heightM metres above the ground is on screen, in CSS pixels of the map
 * container, or null if it lies behind the camera. Uses the last drawn frame.
 */
export function projectPoint(lngLat, heightM = 0) {
  if (!map || !viewMatrix) return null;
  const { x, y, z } = maplibregl.MercatorCoordinate.fromLngLat(lngLat, heightM);
  const m = viewMatrix; // column-major, as WebGL stores it
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (cw <= 0) return null;
  const canvas = map.getCanvas();
  return {
    x: ((cx / cw + 1) / 2) * canvas.clientWidth,
    y: ((1 - cy / cw) / 2) * canvas.clientHeight,
  };
}

// The haze band: fog colour, strongest on the horizon, fading up into the sky and down over
// the far ground, as MapLibre's fog would with horizon-fog-blend 0.7 and fog-ground-blend 0.4.
const HAZE_COLOUR = "107 62 115"; // #6B3E73, the sky's fog-color
const HAZE_ABOVE = 0.05; // share of the map height the band reaches up into the sky
const HAZE_BELOW = 0.4; // share of the ground between horizon and bottom edge it fades over

/**
 * Where the horizon is on screen, as y in CSS pixels from the top of the map, or null when the
 * camera looks too steeply down to see it. A flat ground's horizon is its vanishing line: the
 * screen position of the forward direction itself, a point infinitely far away (w = 0). I take
 * it through MapLibre's world-pixel matrix, whose horizon is the line where MapLibre stops
 * drawing ground and starts its sky (a little below a pinhole camera's), so the haze sits on
 * the seam the reader sees. Checked at pitch 60, 76 and 85.
 */
export function horizonY() {
  if (!map || !skyMatrix) return null;
  const bearing = (map.getBearing() * Math.PI) / 180;
  const dx = Math.sin(bearing);
  const dy = -Math.cos(bearing); // mercator y grows to the south
  const m = skyMatrix;
  const cy = m[1] * dx + m[5] * dy;
  const cw = m[3] * dx + m[7] * dy;
  if (cw <= 1e-9) return null;
  return ((1 - cy / cw) / 2) * map.getCanvas().clientHeight;
}

function addHaze(container) {
  const haze = document.createElement("div");
  haze.className = "map-haze";
  haze.setAttribute("aria-hidden", "true");
  Object.assign(haze.style, { position: "absolute", left: "0", right: "0", pointerEvents: "none", zIndex: "1" });
  container.append(haze);
  const place = () => {
    const height = map.getCanvas().clientHeight;
    const y = horizonY();
    if (y === null || y > height) {
      haze.style.display = "none";
      return;
    }
    const top = y - HAZE_ABOVE * height;
    const bottom = y + HAZE_BELOW * (height - y);
    const at = (100 * (y - top)) / (bottom - top);
    haze.style.display = "block";
    haze.style.top = `${top}px`;
    haze.style.height = `${bottom - top}px`;
    haze.style.background =
      `linear-gradient(to bottom, rgb(${HAZE_COLOUR} / 0) 0%, rgb(${HAZE_COLOUR} / 0.55) ${at}%, ` +
      `rgb(${HAZE_COLOUR} / 0.3) ${at + (100 - at) * 0.3}%, rgb(${HAZE_COLOUR} / 0) 100%)`;
  };
  map.on("render", place);
  map.on("resize", place);
}

/** Which layers show. Accepts a list of names, or { show, labelNames }. */
export function setLayers(layers) {
  const next = Array.isArray(layers) ? { show: layers } : layers;
  state = { ...state, ...next };
  for (const name of state.show) {
    if (!LAYER_IDS[name]) throw new Error(`setLayers: unknown layer ${name}`);
  }
  if (!map) return;
  // Layers are updated in place, never removed and added again, so no tile loads twice.
  for (const [name, ids] of Object.entries(LAYER_IDS)) {
    for (const id of ids) map.setLayoutProperty(id, "visibility", state.show.includes(name) ? "visible" : "none");
  }
  // MapLibre skips a filter or paint value equal to the current one; a changed one makes it lay
  // out that source's tiles again, so the style starts with exactly these values (buildStyle).
  map.setFilter("labels-place", labelFilter("land", state.labelNames));
  map.setFilter("labels-water", labelFilter("water", state.labelNames));
}

/** Mark one building (by fid) in the highlight colour, or none with null. */
export function setHighlight(fid) {
  if (!map) return;
  const target = { source: "buildings", sourceLayer: "buildings" };
  if (highlighted !== null) map.setFeatureState({ ...target, id: highlighted }, { selected: false });
  highlighted = fid ?? null;
  if (highlighted !== null) map.setFeatureState({ ...target, id: highlighted }, { selected: true });
}

/** Jump to a camera, or ease there over duration ms. Resolves when the camera has arrived. */
export function setView(camera, { duration = 0 } = {}) {
  if (!map) throw new Error("setView before createMap");
  return new Promise((resolve) => {
    map.once("moveend", () => resolve());
    if (duration > 0) map.easeTo({ ...camera, duration, easing: (t) => 1 - (1 - t) ** 3 });
    else map.jumpTo(camera);
  });
}

/** This map is one moment in time; kept so every AtlasLab map answers the same calls. */
export function setTime(_step) {
  return Promise.resolve();
}

/** Resolves on the next idle event that comes after every tile of the view is in. */
export function whenIdle() {
  return new Promise((resolve) => {
    const check = () => {
      if (map.areTilesLoaded() && map.loaded()) resolve();
      else map.once("idle", check);
    };
    map.once("idle", check);
    map.triggerRepaint();
  });
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Draw the map into container (an element or its id).
 * options: view (camera), layers (as setLayers), layersUrl (where layers/ is, default next to the
 * page), fadeDuration (label fade in ms; 0 for recording), interactive, preserveDrawingBuffer.
 */
export async function createMap(container, options = {}) {
  // PMTiles speaks plain HTTP range requests; the protocol turns a pmtiles:// URL into tiles.
  maplibregl.setWorkerUrl(absolute(workerUrl));
  const protocol = new Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);

  const layersUrl = absolute(options.layersUrl ?? "layers/");
  if (options.layers) setLayers(options.layers);
  const view = { ...START_VIEW, ...options.view };
  try {
    const [figures, meta, labels] = await Promise.all([
      fetchJson(new URL("figures.json", layersUrl).href),
      fetchJson(new URL("meta.json", layersUrl).href),
      fetchJson(new URL("labels.geojson", layersUrl).href),
    ]);
    map = new maplibregl.Map({
      container,
      style: buildStyle(layersUrl, labels),
      ...view,
      maxPitch: MAX_PITCH,
      // Sharp on high-density screens, but never more than twice the pixels: a phone at 3x
      // would draw 2.25 times as many for no visible gain.
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      fadeDuration: options.fadeDuration ?? 300,
      interactive: options.interactive ?? true,
      attributionControl: false, // the sources are credited in the sheet and About this map
      canvasContextAttributes: { preserveDrawingBuffer: options.preserveDrawingBuffer ?? false },
    });
    await new Promise((resolve, reject) => {
      map.once("load", resolve);
      // Only a broken style stops the map. A tile that fails to arrive is reported by MapLibre
      // in the console and the rest of the map carries on, as it would after the first draw.
      const onError = (event) => {
        if (event.sourceId || event.tile) return;
        map.off("error", onError);
        reject(event.error ?? new Error("map error"));
      };
      map.on("error", onError);
      map.once("load", () => map.off("error", onError));
    });
    map.addLayer(probeLayer);
    addHaze(map.getCanvasContainer());
    setLayers(state);
    // Ready only when the start view is complete: every tile in, the labels' font drawn, the
    // page's fonts loaded, then two more frames so the finished frame is really on screen.
    whenIdle()
      .then(() => document.fonts.ready)
      .then(nextFrame)
      .then(nextFrame)
      .then(() => resolveReady(map), rejectReady);
    return { map, figures, meta };
  } catch (error) {
    rejectReady(error);
    throw error;
  }
}

export function getMap() {
  return map;
}
