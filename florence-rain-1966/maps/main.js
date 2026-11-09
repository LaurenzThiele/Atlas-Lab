/**
 * The public map: all the rain that drowned Florence.
 *
 * What it does: draws the printed relief atlas of the Arno basin in 3D, and nothing else. The title,
 * key and buttons of the public page live in index.html and ui.js, on top of the API below.
 * Reads:  layers/ (written by prepare.py)
 * Writes: nothing
 * Run:    npm run dev   (or npm run build for the static site in maps/dist/)
 *
 * Why MapLibre GL JS: this map needs real map interaction (rotate, tilt, zoom, click, hover) and a
 * static build that works on GitHub Pages with no API key and no tile server. MapLibre does
 * terrain, hillshade and data-driven styling from local files. Labels are HTML markers so they can
 * use Bodoni Moda Italic from @fontsource, because MapLibre's own text needs glyph PBFs that these
 * fonts do not ship as.
 *
 * What you learn: how to build a whole map style by hand from your own layers.
 *
 * Script your own views. I export a small API, so you can drive this map from your own page:
 *
 *   import { createMap, ready, renderAt, setLayers, setTime, setView } from "./main.js";
 *
 *   createMap("map");                           // build the map in <div id="map">
 *   await ready;                                // wait for the style, the layers and the fonts
 *   setLayers({ terrain: true, hillshade: true, upstream_rivers: true, ponte_vecchio: true });
 *   setView({ center: [11.8, 43.75], zoom: 10, pitch: 60, bearing: -60 });   // over the Casentino
 *   await renderAt(0.5);                        // rivers half gathered, and the picture finished
 */

import "@fontsource/bodoni-moda/400-italic.css";
import "@fontsource/bodoni-moda/700.css";
import "@fontsource/courier-prime/400.css";
import {
  Map as MapLibreMap,
  Marker,
  setMaxParallelImageRequests,
  setWorkerCount,
  setWorkerUrl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";

// MapLibre looks for its worker file next to its own script. Once the bundler has renamed and moved
// that script, the worker is no longer there, so I tell MapLibre where the bundler put it.
setWorkerUrl(workerUrl);

const CARTA = "#EAE3D2";
const INCHIOSTRO = "#2A2723";
const RILIEVO = "#9C8A6E";
const ARNO_BLU = "#2E5A87";
const PIENA = "#1E3550";
const COTTO = "#9E3B26";
// The same inks with no coverage, for the undrawn part of a line that is still being drawn.
const INCHIOSTRO_CLEAR = "rgba(42, 39, 35, 0)";
const ARNO_BLU_CLEAR = "rgba(46, 90, 135, 0)";
const PIENA_CLEAR = "rgba(30, 53, 80, 0)";

const EXTENT = [10.0, 42.7, 12.5, 44.35]; // the work extent of prepare.py
const CITY_TERRAIN_BOX = [11.1, 43.64, 11.4, 43.9]; // the sharper terrain around Florence
const CITY_TILE_BOX = cityTileBox(CITY_TERRAIN_BOX);
const TERRAIN_EXAGGERATION = 1.5; // a museum raised-relief model: hills readable, not caricatured
const DEFAULT_VIEW = { center: [11.62, 43.55], zoom: 8.6, pitch: 55, bearing: -35 };
const PONTE_VECCHIO = [11.2531, 43.768];
const SMOOTH_ARNO_FROM_ZOOM = 11;

const DOT_RADIUS_PX = 3.5; // a 7 px dot
const DOT_RING_PX = 1.5;
const WASH_BAND_KM = 40; // how soft the front of the wash is, in km along the network
const IDLE_TIMEOUT_MS = 180_000;

const RIVER_MIN_AREA_KM2 = 10;
const RIVER_MAX_AREA_KM2 = 4600;
const RIVER_MIN_WIDTH_PX = 0.6;
const RIVER_MAX_WIDTH_PX = 6;
const ARNO_EXTRA_WIDTH_PX = 1;

const SNAP_BOX_PX = 12;

// The layer names of the API and the toggles, and the drawn layers behind each name.
const LAYER_GROUPS = {
  hillshade: ["hillshade"],
  contours: ["contours"],
  basin: ["basin_fill", "basin", "basin_outline"],
  basin_units: ["basin_units_fill", "basin_units"],
  upstream_rivers: ["upstream_rivers"],
  upstream_rivers_faint: ["upstream_rivers_faint"],
  downstream_rivers: ["downstream_rivers"],
  arno_main_stem: ["arno_reaches", "arno_display"],
  ponte_vecchio: ["ponte_vecchio"],
};

// One map per page, so the API can stay this small. createMap() fills these in.
let map = null;
let labels = {};
let layersUrl = "";
let isDeterministic = false;
let maxDistKm = 0;
let maxWashKm = 0;
let riverBaseFilter = null;
// One scale for every px value, so a half-size canvas can show the same picture at half size.
let pxScale = 1;
const px = (value) => value * pxScale;

/** Width grows with the square root of area: the river's width on the ground grows roughly so. */
function riverWidth(extraPx = 0, scale = 1) {
  return [
    "interpolate",
    ["linear"],
    ["sqrt", ["get", "UPLAND_SKM"]],
    Math.sqrt(RIVER_MIN_AREA_KM2),
    px((RIVER_MIN_WIDTH_PX + extraPx) * scale),
    Math.sqrt(RIVER_MAX_AREA_KM2),
    px((RIVER_MAX_WIDTH_PX + extraPx) * scale),
  ];
}

/** Water deepens from Arno blu to Piena as it gathers. */
const RIVER_COLOR = [
  "interpolate",
  ["linear"],
  ["sqrt", ["get", "UPLAND_SKM"]],
  Math.sqrt(RIVER_MIN_AREA_KM2),
  ARNO_BLU,
  Math.sqrt(RIVER_MAX_AREA_KM2),
  PIENA,
];

/**
 * The drawn part of a line, by distance along it. line-progress needs a source with lineMetrics.
 * MapLibre 6 has no line-trim-offset, so a sharp step in the line's gradient does the same work.
 */
function progressGradient(progress, ink, clear) {
  if (progress >= 1) return ["step", ["line-progress"], ink, 1, ink];
  if (progress <= 0) return ["step", ["line-progress"], clear, 1, clear];
  return ["step", ["line-progress"], ink, progress, clear];
}

const outlineGradient = (progress) => progressGradient(progress, INCHIOSTRO, INCHIOSTRO_CLEAR);

const arnoGradient = (progress, color) =>
  color === "arno_blu"
    ? progressGradient(progress, ARNO_BLU, ARNO_BLU_CLEAR)
    : progressGradient(progress, PIENA, PIENA_CLEAR);

const washOpacity = (threshold, peak) => [
  "interpolate",
  ["linear"],
  ["get", "wash_order"],
  threshold,
  0,
  threshold + WASH_BAND_KM,
  peak,
];

async function fetchJson(name) {
  const response = await fetch(`${layersUrl}${name}`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.json();
}

function demSource() {
  return {
    type: "raster-dem",
    tiles: [`${layersUrl}terrain/{z}/{x}/{y}.png`],
    encoding: "terrarium",
    tileSize: 256,
    minzoom: 6,
    maxzoom: 10,
    // With bounds set, MapLibre never asks for a tile that prepare.py did not write.
    bounds: EXTENT,
  };
}

/**
 * The city box widened to whole z11 tiles, as prepare.py writes them: [west, south, east, north].
 * z12 tiles nest four to a z11 tile, so at both zooms the city hillshade covers exactly this.
 */
function cityTileBox([west, south, east, north]) {
  const z = 11;
  const tileX = (lng) => Math.floor(((lng + 180) / 360) * 2 ** z);
  const tileY = (lat) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  };
  const lngOf = (x) => (x / 2 ** z) * 360 - 180;
  const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
  return [lngOf(tileX(west)), latOf(tileY(south) + 1), lngOf(tileX(east) + 1), latOf(tileY(north))];
}

function boxPolygon([west, south, east, north]) {
  const ring = [[west, south], [east, south], [east, north], [west, north], [west, south]];
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
}

function geojsonSource(data, extra = {}) {
  // tolerance is how much MapLibre simplifies per tile. A low value keeps thin lines from kinking.
  return { type: "geojson", data, tolerance: 0.2, maxzoom: 14, ...extra };
}

function firstRingAsLine(basin) {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: basin.features[0].geometry.coordinates[0] },
  };
}

/** The whole style, written out from the visual identity. No default style JSON is involved. */
function buildStyle(data) {
  // Above this zoom the smoothed Arno takes over, so its angular original has to step aside.
  const hideStemWhenSmooth = [
    "any",
    ["<", ["zoom"], SMOOTH_ARNO_FROM_ZOOM],
    ["!", ["to-boolean", ["get", "main_stem"]]],
  ];
  return {
    version: 8,
    // No paint transitions: animation here is always something I set, frame by frame.
    transition: { duration: 0, delay: 0 },
    sources: {
      // MapLibre asks for two DEM sources: terrain wants coarser tiles than a crisp hillshade does.
      dem_terrain: demSource(),
      dem_hillshade: demSource(),
      // Sharper terrain for the city (see prepare.py): z11 and z12 inside a box of whole tiles.
      // It feeds a second hillshade over a paper-coloured mask of the box, for close-ups only.
      dem_city: {
        type: "raster-dem",
        tiles: [`${layersUrl}terrain_city/{z}/{x}/{y}.png`],
        encoding: "terrarium",
        tileSize: 256,
        minzoom: 11,
        maxzoom: 12,
        bounds: CITY_TILE_BOX,
      },
      city_box: { type: "geojson", data: boxPolygon(CITY_TILE_BOX) },
      contours: geojsonSource(`${layersUrl}contours.geojson`),
      basin: geojsonSource(data.basin),
      basin_outline: geojsonSource(firstRingAsLine(data.basin), { lineMetrics: true }),
      basin_units: geojsonSource(data.basinUnits),
      rivers_upstream: geojsonSource(data.riversUpstream),
      rivers_downstream: geojsonSource(`${layersUrl}rivers_downstream.geojson`),
      arno: geojsonSource(`${layersUrl}arno.geojson`),
      arno_display: geojsonSource(`${layersUrl}arno_display.geojson`, { lineMetrics: true }),
      bridge: geojsonSource({
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: PONTE_VECCHIO },
      }),
      trace: geojsonSource({ type: "FeatureCollection", features: [] }),
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": CARTA } },
      {
        id: "hillshade",
        type: "hillshade",
        source: "dem_hillshade",
        paint: {
          "hillshade-shadow-color": RILIEVO,
          "hillshade-accent-color": RILIEVO,
          "hillshade-highlight-color": CARTA,
          "hillshade-illumination-direction": 315,
          // Light fixed to north-west of the ground, so an orbit moves the model and not the sun.
          "hillshade-illumination-anchor": "map",
          "hillshade-exaggeration": 0.8,
        },
      },
      // The city close-up (off unless setLayers asks for it). Hillshade is shading over the paper,
      // not an opaque picture, so a mask in paper colour hides the coarse hillshade first: else the
      // city would be shaded twice and the coarse tile edges would show through. It suits a view
      // that lies inside the box at zoom 10 or more (the tiles are 256 px, so map zoom 10 already
      // draws z11): there the tiles cover exactly the mask. A view across the box edge, or tilted
      // far into the distance, would show the edge of the box.
      {
        id: "hillshade_city_mask",
        type: "fill",
        source: "city_box",
        minzoom: 10,
        layout: { visibility: "none" },
        paint: { "fill-color": CARTA, "fill-antialias": false },
      },
      {
        id: "hillshade_city",
        minzoom: 10,
        layout: { visibility: "none" },
        type: "hillshade",
        source: "dem_city",
        paint: {
          "hillshade-shadow-color": RILIEVO,
          "hillshade-accent-color": RILIEVO,
          "hillshade-highlight-color": CARTA,
          "hillshade-illumination-direction": 315,
          // Light fixed to north-west of the ground, so an orbit moves the model and not the sun.
          "hillshade-illumination-anchor": "map",
          "hillshade-exaggeration": 0.8,
        },
      },
      {
        id: "contours",
        type: "line",
        source: "contours",
        paint: {
          "line-color": INCHIOSTRO,
          "line-opacity": 0.55,
          "line-width": ["case", ["to-boolean", ["get", "index"]], px(0.9), px(0.5)],
        },
      },
      // The units carry the wash, one by one. No antialiasing here, or the seams between units
      // would show as thin pale lines through the fill.
      {
        id: "basin_units_fill",
        type: "fill",
        source: "basin_units",
        layout: { visibility: "none" },
        paint: { "fill-color": PIENA, "fill-opacity": 0.35, "fill-antialias": false },
      },
      {
        id: "basin_units",
        type: "fill",
        source: "basin_units",
        layout: { visibility: "none" },
        paint: { "fill-pattern": "halftone", "fill-antialias": false },
      },
      {
        id: "basin_fill",
        type: "fill",
        source: "basin",
        paint: { "fill-color": PIENA, "fill-opacity": 0.35 },
      },
      { id: "basin", type: "fill", source: "basin", paint: { "fill-pattern": "halftone" } },
      {
        id: "basin_outline",
        type: "line",
        source: "basin_outline",
        layout: { "line-join": "round" },
        paint: { "line-width": px(1.2), "line-gradient": outlineGradient(1) },
      },
      {
        id: "downstream_rivers",
        type: "line",
        source: "rivers_downstream",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ARNO_BLU, "line-opacity": 0.3, "line-width": riverWidth() },
      },
      {
        id: "upstream_rivers_faint",
        type: "line",
        source: "rivers_upstream",
        layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
        paint: { "line-color": RIVER_COLOR, "line-opacity": 0.3, "line-width": riverWidth() },
      },
      {
        id: "upstream_rivers",
        type: "line",
        source: "rivers_upstream",
        filter: hideStemWhenSmooth,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": RIVER_COLOR, "line-width": riverWidth() },
      },
      {
        id: "arno_reaches",
        type: "line",
        source: "arno",
        maxzoom: SMOOTH_ARNO_FROM_ZOOM,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": RIVER_COLOR, "line-width": riverWidth(ARNO_EXTRA_WIDTH_PX) },
      },
      {
        id: "arno_display",
        type: "line",
        source: "arno_display",
        minzoom: SMOOTH_ARNO_FROM_ZOOM,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-width": px(6), "line-gradient": arnoGradient(1, "piena") },
      },
      // An invisible, wider copy that nothing is drawn with. It makes thin rivers easy to hit with
      // the mouse, and it still answers queries if the visible rivers are toggled off.
      {
        id: "upstream_hit",
        type: "line",
        source: "rivers_upstream",
        layout: { "line-cap": "round" },
        paint: { "line-color": ARNO_BLU, "line-opacity": 0, "line-width": SNAP_BOX_PX },
      },
      {
        id: "trace_dot",
        type: "circle",
        source: "trace",
        paint: {
          "circle-radius": 6,
          "circle-color": PIENA,
          "circle-stroke-color": COTTO,
          "circle-stroke-width": 2.5,
        },
      },
      {
        id: "ponte_vecchio",
        type: "circle",
        source: "bridge",
        paint: {
          "circle-radius": px(DOT_RADIUS_PX),
          "circle-color": COTTO,
          "circle-stroke-color": CARTA,
          "circle-stroke-width": px(DOT_RING_PX),
        },
      },
    ],
  };
}

function createLabels(points, labelStyle) {
  const created = {};
  const named = points.features.filter((point) => point.properties.kind === "label");
  const bridge = points.features.find((point) => point.properties.id === "ponte_vecchio");
  for (const point of [...named, bridge]) {
    const element = document.createElement("div");
    // The class only names the look. The page's own stylesheet decides what each look is.
    element.className = `map-label map-label-${labelStyle}`;
    element.dataset.side = "right";
    element.dataset.id = point.properties.id; // so a page's stylesheet can style one label
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = point.properties.label;
    text.dataset.text = point.properties.label; // read by the paper knockout behind the text
    element.append(text);
    // subpixelPositioning stops the text from jumping pixel by pixel during a slow camera move.
    // A covered label stays fully visible: names matter more than strict 3D occlusion here.
    const marker = new Marker({
      element,
      anchor: "center",
      subpixelPositioning: true,
      opacityWhenCovered: "1",
    })
      .setLngLat(point.geometry.coordinates)
      .addTo(map);
    created[point.properties.id] = {
      // Opacity sits on the text, because MapLibre writes its own opacity on the marker element.
      setOpacity: (value) => {
        text.style.opacity = String(value);
      },
      setSide: (side) => {
        element.dataset.side = side;
      },
      refresh: () => marker.setLngLat(marker.getLngLat()),
    };
  }
  return created;
}

function mapLoaded() {
  return new Promise((resolve, reject) => {
    map.once("load", resolve);
    map.once("error", (event) => reject(event.error ?? new Error("the map failed to load")));
  });
}

function styleLoaded() {
  return new Promise((resolve) => {
    if (map.isStyleLoaded()) resolve();
    else map.once("style.load", resolve);
  });
}

function waitForIdle() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the map never became idle")), IDLE_TIMEOUT_MS);
    map.once("idle", () => {
      clearTimeout(timer);
      resolve();
    });
    map.triggerRepaint();
  });
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function refreshLabels() {
  // A marker follows the camera, but the terrain under it may have arrived after the camera moved.
  // Setting its position again makes it read the finished surface.
  for (const label of Object.values(labels)) label.refresh();
}

async function addHalftone() {
  // pixelRatio shrinks the pattern along with the canvas, so its dots keep their size in the frame.
  const { data } = await map.loadImage(`${layersUrl}halftone.png`);
  map.addImage("halftone", data, { pixelRatio: 1 / pxScale });
}

// ---------------------------------------------------------------------------------------------
// The API. Everything a script needs to set up its own view of this map.
// ---------------------------------------------------------------------------------------------

let resolveReady;
let rejectReady;

/**
 * Resolves with { map, data } once the style, the layers and the fonts have loaded: the MapLibre
 * map and the layers I fetched. I export a promise and not an event, so a script can await it at
 * any time, even after the map has loaded.
 */
export const ready = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});

async function buildMap(container, options) {
  const { view = DEFAULT_VIEW, scale = 1, deterministic = false, labels: labelStyle = "public" } =
    options;
  if (!["public", "display"].includes(labelStyle)) {
    throw new Error(`labels must be "public" or "display", not ${labelStyle}`);
  }
  pxScale = scale;
  isDeterministic = deterministic;
  layersUrl = options.layersUrl ?? new URL("layers/", document.baseURI).href;

  // Tiles normally race each other, and the order they finish in can leave a faint difference along
  // a tile seam. One at a time is slower, but it gives the same order, and so the same picture, on
  // every run. A reader exploring the map has no need for that, so it is opt-in.
  if (deterministic) {
    setWorkerCount(1);
    setMaxParallelImageRequests(1);
  }

  const [basin, basinUnits, riversUpstream, points, figures] = await Promise.all([
    fetchJson("basin.geojson"),
    fetchJson("basin_units.geojson"),
    fetchJson("rivers_upstream.geojson"),
    fetchJson("points.geojson"),
    fetchJson("key_figures.json"),
    document.fonts.load('italic 400 20px "Bodoni Moda"'),
    document.fonts.load('700 20px "Bodoni Moda"'),
    document.fonts.load('400 20px "Courier Prime"'),
  ]);
  const data = { basin, basinUnits, riversUpstream, points, figures };
  maxDistKm = Math.max(...riversUpstream.features.map((reach) => reach.properties.dist_to_florence_km));
  maxWashKm = Math.max(...basinUnits.features.map((unit) => unit.properties.wash_order));

  map = new MapLibreMap({
    container,
    style: buildStyle(data),
    ...view,
    attributionControl: false,
    // Tile fades would make a picture depend on how long the tiles took to arrive.
    fadeDuration: 0,
    maxPitch: 60,
    minZoom: 6.5,
    maxZoom: 15,
    interactive: options.interactive ?? !deterministic,
    ...(deterministic
      ? {
          // devicePixelRatio 1: one canvas pixel is one output pixel. preserveDrawingBuffer lets a
          // screenshot read the canvas at any moment, not only just after it was drawn.
          pixelRatio: 1,
          minZoom: 0,
          canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
        }
      : {}),
  });
  map.on("error", (event) => console.error(event.error ?? event));
  map.on("sourcedata", (event) => {
    if (event.tile) tilesArrived = true;
  });
  const loaded = mapLoaded();
  await styleLoaded();
  await addHalftone();
  await loaded;

  labels = createLabels(points, labelStyle);
  riverBaseFilter = map.getFilter("upstream_rivers");

  if (deterministic) {
    // No zoom-dependent changes: the camera may sit anywhere, and the caller picks every layer.
    riverBaseFilter = null;
    map.setCenterClampedToGround(false);
    for (const layer of ["arno_reaches", "arno_display"]) map.setLayerZoomRange(layer, 0, 24);
    // No clicks here, so the layers that only serve them can go.
    for (const layer of ["upstream_hit", "trace_dot"]) {
      map.setLayoutProperty(layer, "visibility", "none");
    }
  }
  await document.fonts.ready;
  return { map, data };
}

/**
 * Build the map inside a container (an element or its id). Returns the same promise as `ready`.
 *
 * options:
 *   view           the first camera: { center, zoom, pitch, bearing }. Default: the whole basin.
 *   scale          multiplies every pixel size (lines, dots, halftone). Use 0.5 on a half-size
 *                  canvas and you get the same picture at half size.
 *   deterministic  true for the same picture on every run: tiles load one at a time, no zoom limits
 *                  or camera following the ground, and the canvas can be read by a screenshot.
 *   layersUrl      where layers/ lives, if your page is somewhere else. Ends in a slash.
 *   interactive    whether the mouse moves the map. Default: true, unless deterministic.
 *   labels         "public" (default) or "display": which look the place names get. Each label
 *                  carries the class map-label-public or map-label-display, and the stylesheet of
 *                  your page sets the look. I keep the two apart so that one can change without
 *                  touching the other.
 *
 * main.js loads no stylesheet for the page around the map. Bring your own: index.html gets
 * style.css through ui.js.
 */
export function createMap(container, options = {}) {
  buildMap(container, options).then(resolveReady, rejectReady);
  return ready;
}

/**
 * Move the camera at once to { center, zoom, pitch, bearing }. Any of them can be left out.
 *
 * I use jumpTo and no animation: if you want a move, call this once per step with your own easing,
 * and the path stays entirely yours.
 */
export function setView(camera) {
  // elevation 0 keeps a deterministic camera on one plane. If it followed the ground under the map
  // centre, every ridge the centre passes would make the whole picture bob up and down.
  map.jumpTo(isDeterministic ? { ...camera, elevation: 0 } : camera);
}

// Only touch the map when a value really changes. Setting a paint property or a filter is cheap in
// code, but it can send a whole tile back to the worker.
const applied = new Map();

function once(key, value, setter) {
  const text = JSON.stringify(value);
  if (applied.get(key) === text) return;
  applied.set(key, text);
  setter();
}

function setPaint(layer, property, value) {
  once(`${layer}/${property}`, value, () => map.setPaintProperty(layer, property, value));
}

function setVisible(layer, visible) {
  once(`${layer}/visibility`, visible, () =>
    map.setLayoutProperty(layer, "visibility", visible ? "visible" : "none"),
  );
}

function setTerrainOn(isOn) {
  once("terrain", isOn, () =>
    map.setTerrain(isOn ? { source: "dem_terrain", exaggeration: TERRAIN_EXAGGERATION } : null),
  );
}

/**
 * Say which layers are on. Anything you do not name goes off.
 *
 * Each value is true, for the layer's normal look, or an object with some of these settings:
 *   terrain, contours, downstream_rivers    just true
 *   hillshade              true, or { city: true } for a close-up inside the city box at zoom 10
 *                          or more: the sharper z12 terrain there. Not for views across its edge.
 *   basin                  { fillOpacity, opacity, outline, wash }. outline and wash run from 0 to
 *                          1: how much of the outline is drawn, and how far the fill has washed in
 *                          from the headwaters to Florence.
 *   upstream_rivers        { opacity, widthScale }
 *   upstream_rivers_faint  { opacity }
 *   arno_main_stem         { line, color, widthPx, drawn }. line is "reaches" (each with its own
 *                          width), "display" (one smoothed line, the only one that can be partly
 *                          drawn) or "auto" (by zoom). color is "piena" or "arno_blu". drawn runs
 *                          from 0 at the spring to 1 at the sea.
 *   ponte_vecchio          { scale }
 *   labels                 true for all, or { id: { opacity, side } } per label. Ids are in
 *                          layers/points.geojson. side is right, left, top, top-left or bottom.
 */
export function setLayers(layers) {
  const settings = (id) => (typeof layers[id] === "object" ? layers[id] : {});
  setTerrainOn(Boolean(layers.terrain));

  // I work out every layer's visibility first and apply it once, at the end of this function.
  // Otherwise a layer that a later step overrules would flip off and on again on every call.
  const visible = new Map();
  for (const [group, drawn] of Object.entries(LAYER_GROUPS)) {
    for (const layer of drawn) visible.set(layer, Boolean(layers[group]));
  }

  // The basin. During the wash, the separate units carry the fill, then the dissolved polygon
  // takes over, so the wash ends on exactly the same picture as the full fill.
  const city = Boolean(layers.hillshade) && settings("hillshade").city === true;
  visible.set("hillshade_city_mask", city);
  visible.set("hillshade_city", city);

  const basinOn = Boolean(layers.basin);
  const { fillOpacity = 0.35, opacity = 1, outline = 1, wash = 1 } = settings("basin");
  const washing = basinOn && wash < 1;
  visible.set("basin_fill", basinOn && !washing);
  visible.set("basin", basinOn && !washing);
  visible.set("basin_units_fill", washing && wash > 0);
  visible.set("basin_units", washing && wash > 0);
  visible.set("basin_outline", basinOn && outline > 0);
  if (basinOn) {
    setPaint("basin_fill", "fill-opacity", fillOpacity * opacity);
    setPaint("basin", "fill-opacity", opacity);
    setPaint("basin_outline", "line-opacity", opacity);
    setPaint("basin_outline", "line-gradient", outlineGradient(outline));
  }
  if (washing && wash > 0) {
    // A falling threshold along wash_order: units above it are on, with a soft front.
    const threshold = maxWashKm - wash * (maxWashKm + WASH_BAND_KM);
    setPaint("basin_units_fill", "fill-opacity", washOpacity(threshold, fillOpacity));
    setPaint("basin_units", "fill-opacity", washOpacity(threshold, 1));
  }

  if (layers.upstream_rivers) {
    const { opacity: riverOpacity = 1, widthScale = 1 } = settings("upstream_rivers");
    setPaint("upstream_rivers", "line-opacity", riverOpacity);
    setPaint("upstream_rivers", "line-width", riverWidth(0, widthScale));
  }
  if (layers.upstream_rivers_faint) {
    const { opacity: faintOpacity = 0.3 } = settings("upstream_rivers_faint");
    setPaint("upstream_rivers_faint", "line-opacity", faintOpacity);
  }

  // The Arno comes in two forms: reaches with a width each, or one smoothed line for close-ups and
  // for drawing from spring to sea, which needs a single line to measure progress along.
  if (layers.arno_main_stem) {
    const arno = settings("arno_main_stem");
    const { line = "auto", color = "piena", widthPx = 6, drawn = 1 } = arno;
    visible.set("arno_display", line !== "reaches");
    visible.set("arno_reaches", line !== "display");
    if (line !== "reaches") {
      setPaint("arno_display", "line-width", px(widthPx));
      setPaint("arno_display", "line-gradient", arnoGradient(drawn, color));
    }
  }

  if (layers.ponte_vecchio) {
    const { scale = 1 } = settings("ponte_vecchio");
    setPaint("ponte_vecchio", "circle-radius", px(DOT_RADIUS_PX * scale));
  }

  for (const [layer, isVisible] of visible) setVisible(layer, isVisible);

  for (const [id, label] of Object.entries(labels)) {
    const named = layers.labels === true ? {} : layers.labels?.[id];
    if (named?.side) label.setSide(named.side);
    label.setOpacity(named ? (named.opacity ?? 1) : 0);
  }
  refreshLabels();
}

/**
 * Show how far the water has gathered: 0 is no rivers, 1 is the whole network.
 *
 * The data has no clock, so this "time" is only a position along the network. A filter on the
 * distance to the bridge falls from the furthest reach to zero, so far reaches appear first.
 */
export function setTime(step) {
  if (map.getLayoutProperty("upstream_rivers", "visibility") === "none") return;
  const gathered = [">=", ["get", "dist_to_florence_km"], (maxDistKm + 0.1) * (1 - step)];
  let filter = gathered;
  if (riverBaseFilter) filter = step >= 1 ? riverBaseFilter : ["all", riverBaseFilter, gathered];
  once("upstream_rivers/filter", filter, () => map.setFilter("upstream_rivers", filter));
}

// MapLibre caches the picture it drapes over the terrain, per tile. A hillshade tile reads its
// border pixels from its neighbours, and when a neighbour loads later, that edge changes without
// the cached picture noticing. So whenever tiles arrived, I wait for them all, then force the cache
// to redraw: any style change clears it, and this one is undone in the same tick.
let tilesArrived = true;

function redrawDrapedLayers() {
  map.setPaintProperty("background", "background-opacity", 0.999);
  map.setPaintProperty("background", "background-opacity", 1);
}

/**
 * Set the time for the current view and resolve once the picture is completely finished.
 *
 * This is how you make a browser map deterministic: no clock is involved, every tile has arrived,
 * and the canvas is ready for a screenshot. Call setView and setLayers first, then await this.
 */
export async function renderAt(time = 1) {
  setTime(time);
  await waitForIdle();
  if (tilesArrived && map.getTerrain()) {
    redrawDrapedLayers();
    await waitForIdle();
  }
  tilesArrived = false;
  refreshLabels();
  await nextPaint();
}
