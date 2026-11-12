/**
 * The public map: where Egypt's people live.
 *
 * What it does: draws a flat printed plate of Egypt and its neighbours and one Population layer in
 * three ways (a heatmap that hands over to the real 1 km squares from zoom 9, 1 km columns in 3D,
 * and, for scripted views, one dot for every 250 people), filtered to the most crowded squares
 * that hold a chosen share of the people. Under the dots, the 95% squares can be a red ochre
 * fill. Nothing else: the title, key and buttons of the public page live in index.html and
 * ui.js, on top of the API below.
 * Reads:  layers/ (written by prepare.py)
 * Writes: nothing
 * Run:    npm run dev   (or npm run build for the static site in maps/dist/)
 *
 * Why MapLibre GL JS with deck.gl: MapLibre draws the flat vector plate from local GeoJSON, with
 * rotate, tilt and zoom, and needs no tile server and no API key. deck.gl, added through
 * MapboxOverlay in interleaved mode (it draws into MapLibre's own canvas), draws the heatmap, the
 * 462,000 dots and the 1 km columns from typed arrays on the GPU. MapLibre's own circle layer would hold every
 * dot as a GeoJSON feature and could not redraw that many smoothly while the reader orbits. The
 * projection is plain Web Mercator, no globe: this is one country, and a flat plate reads best.
 * Place labels are HTML elements placed with map.project(), so Reem Kufi and IBM Plex Sans Arabic
 * show exactly as drawn, with no glyph server.
 *
 * What you learn: how to feed half a million points to the GPU as binary attributes, how to
 * filter and animate them with one number per point instead of rebuilding any array, and how to
 * draw a population grid in its own equal-area projection on top of a Web Mercator map.
 *
 * Script your own views. I export a small API, so you can drive this map from your own page:
 *
 *   import { createMap, ready, setLayers, setTime, setView } from "./main.js";
 *
 *   createMap("map");                             // build the map in <div id="map">
 *   await ready;                                  // plate, heatmap, labels and fonts are drawn
 *   setLayers(["land_sea", "egypt_border", "nile_lakes", "dots_all", "labels:Cairo (highlight)"]);
 *   setView({ center: [31.24, 30.05], zoom: 10, pitch: 30, bearing: 0 });   // Cairo up close
 *   setLayers(["land_sea", "dots_all", "squares_95"], { squaresThreshold: 0.8 });  // 80% of people
 *   setTime(0.5);                                 // the replay, halfway up the valley
 */

// The fonts, cut down to the characters this map shows (fonts.mjs writes them).
import "./fonts/fonts.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./map.css";
import { Map as MapLibreMap } from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PolygonLayer, ScatterplotLayer, SolidPolygonLayer } from "@deck.gl/layers";
import { DataFilterExtension } from "@deck.gl/extensions";
import { HeatmapLayer } from "@deck.gl/aggregation-layers";
import { inverse, squareAt as mollweideSquareAt, squareRing } from "./mollweide.js";

// The palette of this piece, and nothing else.
export const COLORS = {
  sand: "#EADBC0", // Deshret: Egypt's land, the paper
  farSand: "#DDCBAA", // neighbouring land
  haze: "#C9D3CF", // sea
  silt: "#211C17", // Kemet: the dots and the ink
  blue: "#1F4E8C", // Egyptian blue: the Nile and lakes
  ochre: "#983A23", // red ochre: the one highlight
  dune: "#6E5B43", // quiet text and the border
};
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const SILT_RGB = rgb(COLORS.silt);
const OCHRE_RGB = rgb(COLORS.ochre);

// The Population ramp, light to dark: saffron, orange, red, wine. One ramp for the heatmap, the 1 km
// squares and the column tops. It reads by hue as much as by lightness: saffron is close to the
// sand in brightness but nothing like it in colour.
export const RAMP = ["#F2C14E", "#E0763A", "#B8322A", "#6B1220"];
const RAMP_RGB = RAMP.map(rgb);
// The squares and column tops take the ramp in four flat steps of people per km2: under 1,000
// (villages and farmland), to 5,000 (towns), to 20,000 (cities), and the densest city blocks.
export const RAMP_BREAKS_PER_KM2 = [1000, 5000, 20000];
const rampStep = (perKm2) => RAMP_BREAKS_PER_KM2.filter((b) => perKm2 >= b).length;
// The heatmap's steps, on the smoothed surface: nothing under 30 people per km2, so the empty
// desert stays bare sand, then saffron, orange from 300, red from 1,500, wine from 6,000.
export const HEAT_BREAKS_PER_KM2 = [30, 300, 1500, 6000];

/** The opening view: the whole country, top down. ui.js fits the zoom to the window. */
export const START_VIEW = { center: [30.2, 26.9], zoom: 5.6, pitch: 0, bearing: 0 };
const PLATE_BOX = [12, 10, 48, 42]; // the plate cut by prepare.py
const EGYPT_BOX = [24.7, 21.99, 36.9, 31.68]; // Egypt's lon/lat extent, for fitting the view

// Dots: 1.0 px across at zoom 5, 1.4 px at 6.5 and 2.2 px at 10, so the valley turns solid while
// the desert dots stay single. deck.gl takes a radius, half of these.
const DOT_DIAMETER_PX = [
  [5, 1.0],
  [6.5, 1.4],
  [10, 2.2],
];
// The replay: the desert dots fade in over 0.6 s, then the valley fills from south to north
// over 3 s. A dot fades in over the last REVEAL_FADE_DEG behind the wave front.
const REPLAY_SPARSE_S = 0.6;
const REPLAY_WAVE_S = 3;
export const REPLAY_DURATION_S = REPLAY_SPARSE_S + REPLAY_WAVE_S;
export const WAVE_SOUTH_LAT = 22.0;
export const WAVE_NORTH_LAT = 31.7;
const REVEAL_FADE_DEG = 0.37;
// One number per dot drives the filter: a desert dot gets SPARSE_KEY, a valley dot its own
// latitude. Then "desert dots plus valley dots south of the front" is one range, [-1000, front].
const SPARSE_KEY = -100;
const ALL_LOW = -1000;
const DENSE_LOW = -99;

// Columns: 0.25 m of height per person per km2, 1 km for every 4,000 people per km2. Cairo's
// densest square (about 158,000 people per km2) stands about 40 km tall: tall enough to see the
// wall along the valley at zoom 6.5, short enough that it does not hide the delta behind it.
export const COLUMN_M_PER_DENSITY = 0.25;
// Squares under 100 people per km2 would make columns under 25 m: no height to see at any zoom,
// only a flat red top that makes a nearly empty square look like a crowded one. They are 61% of
// the squares but hold 0.7% of the people, so the columns leave them out.
export const COLUMN_MIN_PER_KM2 = 100;
const SQUARES_OPACITY_UNDER_DOTS = 0.35; // the red ochre fill under the dots
const SAND_RGB = rgb(COLORS.sand);
const NILE_FADE_ZOOM = [9.0, 9.5]; // the 1:10m Nile no longer sits on the dots beyond this
const WATER_OUTSIDE_OPACITY = 0.45; // rivers and lakes outside Egypt: context, drawn lighter

// Heatmap: every 1 km square spreads its people over a kernel that reaches HEAT_RADIUS_M on the
// ground. The radius is set in metres and turned into pixels at each zoom, so the smoothing stays
// about 8 km wide; a fixed pixel radius would smear the valley wider the further you zoom out.
const HEAT_RADIUS_M = 8000;
// From zoom 9 the heatmap fades out and the real 1 km squares take over.
export const HEAT_FADE_ZOOM = [9.0, 9.5];
// The colour scale is fixed, so the same crowd gets the same colour in every view. The heatmap
// adds up each square's people times the kernel, a Gaussian that peaks at 3.385 with a standard
// deviation of a sixth of the radius. Over evenly spread people that sum is the density times
// the kernel's area, 0.5908 x radius² = 37.8 km² for 8 km: so 30 people per km2 sum to 1,134.
const KERNEL_KM2 = 0.5908 * (HEAT_RADIUS_M / 1000) ** 2;
const HEAT_TOP_PER_KM2 = 12000; // the end of the colour table; anything denser stays wine
// deck.gl maps the sum linearly onto the colour table, but the steps are about five times apart,
// so I build a long table (4,096 entries) whose entries already carry the step colour of their
// value: transparent under 30, then saffron, orange, red and wine. The lower end of the domain
// only sets where the heatmap is fully opaque (1 person per km2); the table does the cut at 30.
const HEAT_DOMAIN = [KERNEL_KM2 * 1, KERNEL_KM2 * HEAT_TOP_PER_KM2];
const HEAT_TABLE_SIZE = 4096;
const HEAT_COLORS = Array.from({ length: HEAT_TABLE_SIZE }, (_, k) => {
  const perKm2 = ((k + 0.5) / HEAT_TABLE_SIZE) * HEAT_TOP_PER_KM2;
  const step = HEAT_BREAKS_PER_KM2.filter((b) => perKm2 >= b).length;
  // Under 30 the entry is saffron with no alpha, so the edge fades to sand, not to black.
  return step === 0 ? [...RAMP_RGB[0], 0] : [...RAMP_RGB[step - 1], 255];
});

// Blending for the dots: multiply, like ink overprinting on paper, so where dots crowd they merge
// into one solid black land instead of piling up as grey. The shader premultiplies its colour
// (see MultiplyDotLayer), so a half-faded dot darkens the paper halfway and never brightens it.
const MULTIPLY = {
  blend: true,
  blendColorOperation: "add",
  blendColorSrcFactor: "dst",
  blendColorDstFactor: "one-minus-src-alpha",
  blendAlphaOperation: "add",
  blendAlphaSrcFactor: "zero",
  blendAlphaDstFactor: "one",
  depthWriteEnabled: false,
  depthCompare: "always",
};
const FLAT = { depthWriteEnabled: false, depthCompare: "always" };

/** A ScatterplotLayer whose colour leaves the shader premultiplied by its alpha. */
class MultiplyDotLayer extends ScatterplotLayer {
  getShaders() {
    const shaders = super.getShaders();
    const end = shaders.inject?.["fs:#main-end"] ?? "";
    shaders.inject = { ...shaders.inject, "fs:#main-end": `${end}\nfragColor.rgb *= fragColor.a;` };
    return shaders;
  }
}
MultiplyDotLayer.layerName = "MultiplyDotLayer";

/**
 * Extruded squares whose tops and sides both take the square's own colour from the Population ramp,
 * exactly as 2D draws it. material: false alone did not do it: deck.gl still shaded the faces,
 * so a saffron column came out at 70% brightness and every colour drifted off the palette. The
 * vertex shader therefore ends by setting the colour back to the attribute's own value. The
 * heights read from the silhouette against the sand; picking and the highlight keep their colours.
 */
class ColumnSquaresLayer extends SolidPolygonLayer {
  getShaders(type) {
    const shaders = super.getShaders(type);
    const end = shaders.inject?.["vs:#main-end"] ?? "";
    shaders.inject = {
      ...shaders.inject,
      "vs:#main-end": `${end}\nif (!bool(picking.isActive)) vColor = vec4(fillColors.rgb, fillColors.a * layer.opacity);`,
    };
    // The stagger (columnsStagger): each column's height is scaled by its own progress, worked
    // out on the GPU from its density, so no array is rebuilt while the columns rise.
    shaders.modules = [...(shaders.modules ?? []), columnStaggerUniforms];
    shaders.vs = shaders.vs.replace(
      "pos.z += props.elevations * solidPolygon.elevationScale;",
      "pos.z += props.elevations * columnRise(props.elevations) * solidPolygon.elevationScale;",
    );
    shaders.inject["vs:#decl"] = `${shaders.inject["vs:#decl"] ?? ""}\n${COLUMN_RISE_GLSL}`;
    return shaders;
  }

  draw(opts) {
    const progress = this.props.staggerProgress;
    for (const model of this.getModels()) {
      model.shaderInputs.setProps({
        columnStagger: {
          progress: progress ?? 1,
          logMin: Math.log(COLUMN_MIN_PER_KM2),
          logMax: Math.log(this.props.staggerTopPerKm2),
        },
      });
    }
    super.draw(opts);
  }
}
ColumnSquaresLayer.layerName = "ColumnSquaresLayer";
ColumnSquaresLayer.defaultProps = {
  staggerProgress: { type: "number", value: 1 }, // 1: every column at full height
  staggerTopPerKm2: { type: "number", value: 100000 },
};

/*
 * The columns rise densest first: a column's start is set by where its density lies between
 * 100 and the densest square on a log scale, spread over the first STAGGER_SPREAD of the rise,
 * and each one then grows over the rest with an ease-out. Log, because the densities run over
 * three orders of magnitude: on a straight scale every column but Cairo's would start together.
 */
const STAGGER_SPREAD = 0.6;
const COLUMN_STAGGER_BLOCK = `\
layout(std140) uniform columnStaggerUniforms {
  float progress;
  float logMin;
  float logMax;
} columnStagger;
`;
const columnStaggerUniforms = {
  name: "columnStagger",
  vs: COLUMN_STAGGER_BLOCK,
  fs: COLUMN_STAGGER_BLOCK,
  uniformTypes: { progress: "f32", logMin: "f32", logMax: "f32" },
};
const COLUMN_RISE_GLSL = `\
float columnRise(float density) {
  if (columnStagger.progress >= 1.0) return 1.0;
  float rank = clamp((log(max(density, 1.0)) - columnStagger.logMin) / (columnStagger.logMax - columnStagger.logMin), 0.0, 1.0);
  float start = (1.0 - rank) * ${STAGGER_SPREAD.toFixed(2)};
  float x = clamp((columnStagger.progress - start) / ${(1 - STAGGER_SPREAD).toFixed(2)}, 0.0, 1.0);
  return 1.0 - (1.0 - x) * (1.0 - x);
}
`;


// The layer names of the API, top of the key last here.
export const LAYER_NAMES = [
  "land_sea",
  "egypt_border",
  "nile_lakes",
  "heatmap",
  "squares_1km",
  "columns_1km",
  "squares_95",
  "dots_all",
  "dots_sparse",
  "dots_dense_reveal",
];

// Where each label hangs off its point, and the zoom range in which the public map shows it.
// Towns hang to the side facing empty desert, so a name never lies on the crowd it names.
const LABEL_SIDE = {
  Cairo: "left",
  Giza: "left",
  Alexandria: "left",
  Luxor: "right",
  Aswan: "right",
  Siwa: "right",
  Kharga: "right",
  Nile: "east", // beside the river: the name starts at its anchor and runs east, off the valley
  "Eastern Desert": "east", // centred, its first letters would lie on the valley at Qena
};

const DEFAULT_OPTIONS = {
  dots: null, // "sparse" | "dense" | "all"; null takes it from the layer names
  denseRevealLat: null, // the wave front; null shows every valley dot
  dotsOpacity: 1,
  dotsScale: 1, // dot size multiplier, 0 to 1
  squaresOpacity: null, // the red ochre area under the dots; null: 0.35
  peopleShare: 1, // draw only the most crowded squares that hold this share of people (0.5 to 1)
  peopleFrom: 0, // and leave out the most crowded squares that hold this share (0 to 1)
  heatmapOpacity: 1,
  heatmapRevealLat: null, // a front sweeping the heatmap in from the south; null: all drawn
  heatmapDebounceMs: 250, // scripted frames set 0, so the heatmap never waits on the clock
  // deck.gl keeps the heatmap's weight texture from the last view; a scripted frame that must not
  // depend on the frame before it passes a new id, and the heatmap starts from scratch.
  heatmapId: "heatmap",
  squares1kmOpacity: 1, // the 1 km squares when named on their own
  squaresThreshold: 0.95, // a square is in the set when the people in denser squares are fewer
  columnsScale: 1, // column height multiplier, 0 to 1
  columnsStagger: null, // the columns rising densest first, 0 to 1; null: all at full height
  nileOpacity: 1,
  waterInside: true, // the rivers and lakes inside Egypt (the key's Nile entry)
  waterOutside: true, // the rivers and lakes outside Egypt, drawn faint as context
  highlightLabels: [],
  labelOpacity: {}, // name -> 0 to 1, for fades
};

// One map per page, so the API can stay this small. createMap() fills these in.
let map = null;
let overlay = null;
let layersUrl = "";
let dots = null;
let dotsLoading = null;
let squares = null;
let squaresLoading = null;
let started = false;
let heatRadius = 0; // radiusPixels, set when a zoom ends (see createMap)
let labels = [];
let labelLayer = null;
let labelAvoid = () => [];
let selection = null; // the clicked square's index: the pop in 2D, the sand column in 3D
let hover = null; // the square under the mouse: a thin silt outline, in 2D and 3D
let options = { ...DEFAULT_OPTIONS };
const DEFAULT_LAYERS = ["land_sea", "egypt_border", "nile_lakes", "heatmap"];
let layersOn = new Set(DEFAULT_LAYERS);
let labelsOn = new Map(); // name -> highlighted?
let replay = 1;

let resolveReady;
let rejectReady;
/** Resolves once the start view's layers, the fonts and the first full frame are drawn. */
export const ready = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});

async function fetchLayer(name, type = "json") {
  const response = await fetch(`${layersUrl}${name}`);
  if (!response.ok) throw new Error(`layers/${name}: HTTP ${response.status}`);
  return type === "json" ? response.json() : response.arrayBuffer();
}

// ---- Dots ----------------------------------------------------------------------------------

/**
 * dots.bin holds every lon as uint16 (desert dots first, then valley dots, each group south to
 * north), then for each group the number of dots on each of the 65,536 latitude steps
 * (dots.json). I rebuild the latitudes from those counts and turn everything into the two arrays
 * deck.gl reads directly: positions, and one filter key per dot.
 */
export function loadDots() {
  dotsLoading ??= readDots().then((data) => {
    dots = data;
    apply();
    return data;
  });
  return dotsLoading;
}

async function readDots() {
  const [meta, buffer] = await Promise.all([fetchLayer("dots.json"), fetchLayer("dots.bin", "bin")]);
  const n = meta.count;
  const steps = 65536;
  const expected = n * 2 + 2 * steps * 2;
  if (buffer.byteLength !== expected) throw new Error(`dots.bin has ${buffer.byteLength} bytes, not ${expected}`);
  const lon16 = new Uint16Array(buffer, 0, n);
  const [west, south, east, north] = meta.box;
  const positions = new Float32Array(n * 2);
  const keys = new Float32Array(n);
  let i = 0;
  for (const [group, dense] of [
    [0, false],
    [1, true],
  ]) {
    const counts = new Uint16Array(buffer, n * 2 + group * steps * 2, steps);
    for (let step = 0; step < steps; step++) {
      const lat = south + (step / 65535) * (north - south);
      for (let k = counts[step]; k > 0; k--, i++) {
        positions[2 * i] = west + (lon16[i] / 65535) * (east - west);
        positions[2 * i + 1] = lat;
        keys[i] = dense ? lat : SPARSE_KEY;
      }
    }
    const end = group === 0 ? meta.count_sparse : n;
    if (i !== end) throw new Error(`dots.bin: group ${group} ends at dot ${i}, not ${end}`);
  }
  return {
    meta,
    data: {
      length: n,
      attributes: {
        getPosition: { value: positions, size: 2 },
        getFilterValue: { value: keys, size: 1 },
      },
    },
  };
}

function dotDiameterPx(zoom) {
  const stops = DOT_DIAMETER_PX;
  if (zoom <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [z1, d1] = stops[i];
    const [z0, d0] = stops[i - 1];
    if (zoom <= z1) return d0 + ((zoom - z0) / (z1 - z0)) * (d1 - d0);
  }
  return stops[stops.length - 1][1];
}

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

/** Which dots are on, and how far the valley wave has come, from layers, options and replay. */
function dotsState() {
  let sparse = layersOn.has("dots_all") || layersOn.has("dots_sparse");
  let dense = layersOn.has("dots_all") || layersOn.has("dots_dense_reveal");
  if (options.dots === "sparse") dense = false;
  if (options.dots === "dense") sparse = false;
  let front = options.denseRevealLat ?? 90;
  let opacity = options.dotsOpacity;
  if (replay < 1 && (sparse || dense)) {
    const sparseShare = REPLAY_SPARSE_S / REPLAY_DURATION_S;
    if (replay < sparseShare) {
      opacity *= replay / sparseShare;
      front = -90;
    } else {
      const t = easeInOutCubic((replay - sparseShare) / (1 - sparseShare));
      front = Math.min(front, WAVE_SOUTH_LAT + t * (WAVE_NORTH_LAT - WAVE_SOUTH_LAT + REVEAL_FADE_DEG));
    }
  }
  return { sparse, dense, front, opacity };
}

function dotsLayer() {
  const { sparse, dense, front, opacity } = dotsState();
  if ((sparse || dense) && !dots) loadDots();
  if (!dots) return [];
  const low = sparse ? ALL_LOW : DENSE_LOW;
  const high = dense ? front : DENSE_LOW - 0.5;
  const diameterPx = dotDiameterPx(map.getZoom()) * options.dotsScale;
  return new MultiplyDotLayer({
    id: "dots",
    data: dots.data,
    visible: (sparse || dense) && opacity > 0 && diameterPx > 0,
    radiusUnits: "pixels",
    getRadius: 1,
    radiusScale: diameterPx / 2,
    radiusMinPixels: 0,
    getFillColor: [...SILT_RGB, 255],
    opacity,
    parameters: MULTIPLY,
    extensions: [DOT_FILTER],
    filterRange: [low, high],
    filterSoftRange: [low, high - REVEAL_FADE_DEG],
    updateTriggers: {},
  });
}
const DOT_FILTER = new DataFilterExtension({ filterSize: 1 });

// ---- 1 km squares --------------------------------------------------------------------------

/**
 * The 1 km squares: squares.bin holds people and cum_before (float32), then each square's column
 * and row on the 1 km grid (uint16) and its area in hundredths of a km2 (uint8), densest square
 * first (squares.json). I turn column and row into the square's true corners in Mollweide
 * (mollweide.js), five vertices per ring, and its centre into the point the heatmap spreads.
 */
export function loadSquares() {
  if (squaresLoading) return squaresLoading;
  squaresLoading = (async () => {
    const [meta, buffer] = await Promise.all([
      fetchLayer("squares.json"),
      fetchLayer("squares.bin", "bin"),
    ]);
    const n = meta.count;
    if (buffer.byteLength !== n * 13) throw new Error(`squares.bin has ${buffer.byteLength} bytes, not ${n * 13}`);
    const people = new Float32Array(buffer, 0, n);
    const cumBefore = new Float32Array(buffer, n * 4, n);
    const colGrid = new Uint16Array(buffer, n * 8, n);
    const rowGrid = new Uint16Array(buffer, n * 10, n);
    const area = new Uint8Array(buffer, n * 12, n);
    const squareM = meta.square_m;
    // Grid column and row to Mollweide square indices: x grows east from x0, rows count south
    // from y0, and a Mollweide index names the square by its lower-left corner.
    const col0 = Math.round(meta.grid.x0_m / squareM);
    const row0 = Math.round(meta.grid.y0_m / squareM) - 1;
    const lon = new Float32Array(n);
    const lat = new Float32Array(n);
    const perKm2 = new Float32Array(n);
    const centres = new Float32Array(n * 3); // lon, lat, and cum_before for the heatmap's filter
    const ring2 = new Float32Array(n * 10);
    const vertexCum = new Float32Array(n * 5);
    const vertexDensity = new Float32Array(n * 5);
    const vertexColumnFilter = new Float32Array(n * 10); // density, cum_before
    const vertexColor = new Uint8Array(n * 20);
    const startIndices = new Uint32Array(n);
    const index = new Map();
    for (let i = 0; i < n; i++) {
      const col = col0 + colGrid[i];
      const row = row0 - rowGrid[i];
      index.set(col * 100000 + row, i);
      [lon[i], lat[i]] = inverse((col + 0.5) * squareM, (row + 0.5) * squareM);
      centres[3 * i] = lon[i];
      centres[3 * i + 1] = lat[i];
      centres[3 * i + 2] = cumBefore[i];
      perKm2[i] = people[i] / (area[i] / 100);
      const color = RAMP_RGB[rampStep(perKm2[i])];
      const ring = squareRing(col, row, squareM);
      for (let v = 0; v < 5; v++) {
        ring2[i * 10 + v * 2] = ring[v][0];
        ring2[i * 10 + v * 2 + 1] = ring[v][1];
        vertexCum[i * 5 + v] = cumBefore[i];
        vertexDensity[i * 5 + v] = perKm2[i];
        vertexColumnFilter[(i * 5 + v) * 2] = perKm2[i];
        vertexColumnFilter[(i * 5 + v) * 2 + 1] = cumBefore[i];
        vertexColor.set([...color, 255], (i * 5 + v) * 4);
      }
      startIndices[i] = i * 5;
    }
    const polygons = { getPolygon: { value: ring2, size: 2 } };
    const colors = { getFillColor: { value: vertexColor, size: 4, normalized: true } };
    squares = {
      meta,
      lon,
      lat,
      people,
      perKm2,
      cumBefore,
      index,
      heat: {
        length: n,
        attributes: {
          getPosition: { value: centres, size: 3 },
          getWeight: { value: people, size: 1 },
        },
      },
      flat: {
        length: n,
        startIndices,
        attributes: { ...polygons, getFilterValue: { value: vertexCum, size: 1 } },
      },
      ramp: {
        length: n,
        startIndices,
        attributes: { ...polygons, ...colors, getFilterValue: { value: vertexCum, size: 1 } },
      },
      columns: {
        length: n,
        startIndices,
        attributes: {
          ...polygons,
          ...colors,
          getElevation: { value: vertexDensity, size: 1 },
          getFilterValue: { value: vertexColumnFilter, size: 2 },
        },
      },
    };
    apply();
    return squares;
  })();
  return squaresLoading;
}

/** The largest float32 below x: the filter range is inclusive, the set needs "under". */
function float32Below(x) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, x);
  view.setInt32(0, view.getInt32(0) - (Math.fround(x) >= x ? 1 : 0));
  return view.getFloat32(0);
}

/**
 * A HeatmapLayer with a fixed colour scale. deck.gl either rescales the colours to the densest
 * spot in view (so the same crowd would change colour as you pan) or rescales a given domain by
 * the pixel size, which assumes a radius fixed in pixels. My radius is fixed on the ground, so the
 * kernel sums are the same at every zoom, and I hand the shader the domain as it is.
 */
class FixedHeatmapLayer extends HeatmapLayer {
  /**
   * The People filter, on the GPU. HeatmapLayer runs its own weight shader, which
   * DataFilterExtension cannot reach, so I add the test myself: each square's cum_before rides in
   * the z of its position (the weight shader only uses x and y), and a square above the slider's
   * share, or below the opening's lower bound, adds no weight. Moving the slider only reruns the weight pass; the data never changes.
   */
  getShaders(shaders) {
    const result = super.getShaders(shaders);
    if (shaders.vs?.includes("out vec4 weightsTexture")) {
      result.modules = [...result.modules, heatFilterUniforms];
      const end = result.inject?.["vs:#main-end"] ?? "";
      result.inject = {
        ...result.inject,
        "vs:#main-end": `${end}\nweightsTexture *= clamp((heatFilter.north - positions.y) / heatFilter.fade, 0.0, 1.0);\nif (positions.z > heatFilter.below || positions.z < heatFilter.above || positions.y > heatFilter.north) { weightsTexture = vec4(0.0); gl_PointSize = 0.0; }`,
      };
    }
    return result;
  }

  updateState(params) {
    super.updateState(params);
    const { share, shareFrom, revealLat } = params.props;
    const old = params.oldProps;
    const changed = share !== old.share || shareFrom !== old.shareFrom || revealLat !== old.revealLat;
    if (changed && this.state.weightsTransform) this._updateWeightmap();
  }

  // deck.gl finds the densest pixel after every weight pass, by drawing the whole 2048 x 2048
  // weight texture into one pixel. With a fixed colour scale that maximum is never read, and it
  // cost two frames per slider step, so it is skipped.
  _updateMaxWeightValue() {}

  _updateWeightmap() {
    this.state.weightsTransform?.model.shaderInputs.setProps({
      heatFilter: {
        below: this.props.share,
        above: this.props.shareFrom,
        north: this.props.revealLat,
        fade: REVEAL_FADE_DEG,
      },
    });
    super._updateWeightmap();
    const scale = this.state.weightsScale ?? 1;
    this.state.colorDomain = this.props.fixedDomain.map((value) => value * scale);
  }
}
FixedHeatmapLayer.layerName = "FixedHeatmapLayer";
FixedHeatmapLayer.defaultProps = {
  fixedDomain: { type: "array", value: HEAT_DOMAIN },
  share: 1, // the largest kept cum_before (as float32): squares above it add no weight
  shareFrom: -1, // the smallest kept cum_before: squares below it add no weight
  revealLat: 1000, // a front: squares north of it add no weight, those just south of it fade in
};

// luma.gl checks the block against uniformTypes and reads one field per line.
const HEAT_FILTER_BLOCK = `\
layout(std140) uniform heatFilterUniforms {
  float below;
  float above;
  float north;
  float fade;
} heatFilter;
`;
const heatFilterUniforms = {
  name: "heatFilter",
  vs: HEAT_FILTER_BLOCK,
  fs: HEAT_FILTER_BLOCK,
  uniformTypes: { below: "f32", above: "f32", north: "f32", fade: "f32" },
};

/** Pixels per HEAT_RADIUS_M at a zoom and latitude (Web Mercator, 512 px tiles), 1 to 100. */
export function heatRadiusPx(zoom, latitude = 27) {
  const metresPerPx = (40075016.686 * Math.cos((latitude * Math.PI) / 180)) / (512 * 2 ** zoom);
  // Not rounded: the radius may be fractional, which keeps the kernel at 8 km at every zoom.
  return Math.min(100, Math.max(1, HEAT_RADIUS_M / metresPerPx));
}

/** 1 over the heatmap's zoom range, fading to 0 between zoom 9.0 and 9.5. */
function heatFade(zoom) {
  const [start, end] = HEAT_FADE_ZOOM;
  return Math.min(1, Math.max(0, (end - zoom) / (end - start)));
}

function dotsShown() {
  const { sparse, dense } = dotsState();
  return sparse || dense;
}

function squaresLayers() {
  const showHeat = layersOn.has("heatmap");
  const showRamp = layersOn.has("squares_1km");
  const showSquares = layersOn.has("squares_95");
  const showColumns = layersOn.has("columns_1km");
  if ((showHeat || showRamp || showSquares || showColumns) && !squares) loadSquares();
  if (!squares) return { below: [], columns: [] };
  const zoom = map.getZoom();
  const fade = heatFade(zoom);
  const heatOpacity = showHeat ? fade * options.heatmapOpacity : 0;
  // The squares take over where the heatmap fades; named on their own, they show at every zoom.
  const rampOpacity = showRamp ? options.squares1kmOpacity : showHeat ? (1 - fade) * options.heatmapOpacity : 0;
  const threshold = float32Below(options.squaresThreshold);
  // The People filter: only the most crowded squares that hold this share of people are drawn.
  // At 1 (the default) cum_before < 1 holds for every square, so nothing is left out.
  const share = Math.min(1, options.peopleShare);
  // peopleFrom does the opposite from the other end: it leaves out the most crowded squares that
  // hold that share, so the opening can draw the layer from the emptiest squares up.
  const peopleRange = [options.peopleFrom > 0 ? options.peopleFrom : -1, float32Below(share)];
  // With the dots, the area where 95% of people live can be a red ochre fill under them. The
  // public page does not use it: its slider filters the Population layer instead.
  const redFill = showSquares && dotsShown();
  const squaresOpacity = options.squaresOpacity ?? SQUARES_OPACITY_UNDER_DOTS;
  // These lie under the rivers, the border and the labels: deck.gl puts them before MapLibre's
  // border layer in the drawing order.
  const underPlate = { beforeId: "egypt_border" };
  const below = [
    new FixedHeatmapLayer({
      id: options.heatmapId,
      ...underPlate,
      data: squares.heat,
      share: peopleRange[1],
      shareFrom: peopleRange[0],
      visible: heatOpacity > 0,
      opacity: heatOpacity,
      radiusPixels: heatRadius,
      colorRange: HEAT_COLORS,
      aggregation: "SUM",
      // deck.gl keeps the weight map in world coordinates, so while a zoom runs it scales with the
      // map, and the radius only needs to be recomputed when the zoom ends.
      debounceTimeout: options.heatmapDebounceMs,
      revealLat: options.heatmapRevealLat ?? 1000,
      parameters: FLAT,
    }),
    new SolidPolygonLayer({
      id: "squares_1km",
      ...underPlate,
      data: squares.ramp,
      visible: rampOpacity > 0,
      opacity: rampOpacity,
      _normalize: false,
      _windingOrder: "CCW",
      parameters: FLAT,
      extensions: [SQUARE_FILTER],
      filterRange: peopleRange,
    }),
    new SolidPolygonLayer({
      id: "squares",
      data: squares.flat,
      visible: redFill && squaresOpacity > 0,
      _normalize: false,
      _windingOrder: "CCW",
      getFillColor: [...OCHRE_RGB, 255],
      opacity: squaresOpacity,
      parameters: FLAT,
      extensions: [SQUARE_FILTER],
      filterRange: [-1, threshold],
    }),
  ];
  const columnLayer = (id, cumRange, opacity) =>
    new ColumnSquaresLayer({
      id,
      data: squares.columns,
      visible: showColumns && options.columnsScale > 0,
      _normalize: false,
      _windingOrder: "CCW",
      extruded: true,
      material: false,
      elevationScale: COLUMN_M_PER_DENSITY * options.columnsScale,
      staggerProgress: options.columnsStagger ?? 1,
      staggerTopPerKm2: squares.perKm2[0],
      pickable: true,
      opacity,
      parameters: { depthWriteEnabled: opacity === 1, depthCompare: "less-equal" },
      extensions: [COLUMN_FILTER],
      filterRange: [
        [COLUMN_MIN_PER_KM2, 1e9],
        cumRange,
      ],
    });
  // Only the columns of the kept squares stand, filtered on the GPU like the flat squares.
  const columns = [
    columnLayer("columns", peopleRange, 1),
    hoverColumnLayer(showColumns),
    selectedColumnLayer(showColumns),
  ];
  return { below, columns };
}
/**
 * The clicked column, drawn again in Deshret sand with Kemet silt edges. Wine, the first choice,
 * vanished among the wine columns of the cities; a pale column with dark edges stands out against
 * every step of the ramp. It is 6% wider than the column it marks, so it encloses it, and it is
 * drawn over the columns in front of it. A square too sparse for a column gets a low block.
 */
function selectedColumnLayer(showColumns) {
  let data = [];
  if (showColumns && selection !== null && squares) {
    const i = selection;
    const [col, row] = mollweideSquareAt(squares.lon[i], squares.lat[i], squares.meta.square_m);
    const ring = squareRing(col, row, squares.meta.square_m);
    const cx = (ring[0][0] + ring[2][0]) / 2;
    const cy = (ring[0][1] + ring[2][1]) / 2;
    const grow = 1.06;
    const heightM = Math.max(squares.perKm2[i], COLUMN_MIN_PER_KM2) * COLUMN_M_PER_DENSITY * 1.01;
    data = [{ polygon: ring.map(([x, y]) => [cx + (x - cx) * grow, cy + (y - cy) * grow]), heightM }];
  }
  return new SolidPolygonLayer({
    id: "selected-column",
    data,
    visible: data.length > 0,
    extruded: true,
    wireframe: true,
    material: false,
    getPolygon: (d) => d.polygon,
    getElevation: (d) => d.heightM,
    elevationScale: options.columnsScale,
    getFillColor: [...SAND_RGB, 255],
    getLineColor: [...SILT_RGB, 255],
    // Drawn over the columns in front of it, so it shows even where the valley's wall hides it.
    parameters: { depthWriteEnabled: false, depthCompare: "always" },
  });
}

/** The ring of square i, grown around its centre by a factor. */
function grownRing(i, grow) {
  const [col, row] = mollweideSquareAt(squares.lon[i], squares.lat[i], squares.meta.square_m);
  const ring = squareRing(col, row, squares.meta.square_m);
  const cx = (ring[0][0] + ring[2][0]) / 2;
  const cy = (ring[0][1] + ring[2][1]) / 2;
  return ring.map(([x, y]) => [cx + (x - cx) * grow, cy + (y - cy) * grow]);
}

/**
 * The hovered column: Kemet silt edges over a faint Deshret sand tint, a little wider than the
 * column and drawn through the columns in front of it. Lighter than the clicked column (solid
 * sand) on purpose: hover says "this one can be clicked", the click says "this one is chosen".
 */
function hoverColumnLayer(showColumns) {
  const on = showColumns && hover !== null && hover !== selection && squares;
  const data = on
    ? [
        {
          polygon: grownRing(hover, 1.06),
          heightM: Math.max(squares.perKm2[hover], COLUMN_MIN_PER_KM2) * COLUMN_M_PER_DENSITY * 1.01,
        },
      ]
    : [];
  return new SolidPolygonLayer({
    id: "hover-column",
    data,
    visible: data.length > 0,
    extruded: true,
    wireframe: true,
    material: false,
    getPolygon: (d) => d.polygon,
    getElevation: (d) => d.heightM,
    elevationScale: options.columnsScale,
    getFillColor: [...SAND_RGB, 50],
    getLineColor: [...SILT_RGB, 255],
    parameters: { depthWriteEnabled: false, depthCompare: "always" },
  });
}

/**
 * The hovered flat square: a 1.5 px silt outline on a 4 px sand casing, no fill, so its own colour
 * still shows. Silt alone sank into the wine squares, sand alone into the saffron ones; the pair
 * reads on every step of the ramp, like the labels' sand halo.
 */
function hoverSquareLayer(visible) {
  const on = visible && hover !== null && hover !== selection && squares;
  const data = on ? [{ polygon: grownRing(hover, 1) }] : [];
  const outline = (id, rgb, widthPx) =>
    new PolygonLayer({
      id,
      data,
      visible: Boolean(on),
      getPolygon: (d) => d.polygon,
      getLineColor: [...rgb, 255],
      getLineWidth: widthPx,
      lineWidthUnits: "pixels",
      stroked: true,
      filled: false,
      parameters: FLAT,
    });
  return [outline("hover-square-casing", SAND_RGB, 4), outline("hover-square", SILT_RGB, 1.5)];
}

/** The cursor: a closed hand while dragging, a pointer over a square that can be clicked. */
function cursorFor({ isDragging }) {
  if (isDragging) return "grabbing";
  return hover === null ? "grab" : "pointer";
}

/**
 * The share of people in the most crowded fraction of the squares (0 to 1), for a peopleShare
 * that draws the Population layer square by square, densest first. The squares are stored in that
 * order, so this is one lookup. Needs the squares loaded (ready has loaded them for the heatmap).
 */
export function shareAtRank(fraction) {
  if (!squares) return 1;
  const n = squares.meta.count;
  const i = Math.floor(Math.min(1, Math.max(0, fraction)) * n);
  return i >= n ? 1 : squares.cumBefore[i];
}

/** Mark the square under the mouse (an index from squareAt or pickColumn), or null. */
export function setHover(index) {
  if ((index ?? null) === hover) return;
  hover = index ?? null;
  // deck.gl only asks cursorFor again on its own events, so I set the new cursor right away.
  if (map) map.getCanvas().style.cursor = cursorFor({ isDragging: false });
  apply();
}

const SQUARE_FILTER = new DataFilterExtension({ filterSize: 1 });
const COLUMN_FILTER = new DataFilterExtension({ filterSize: 2 });

/**
 * The 1 km square under a point, or null outside the squares with people. The square is found
 * by arithmetic, not by searching: Mollweide metres divided by 1,000 give its column and row.
 */
export function squareAt(lon, lat) {
  if (!squares) return null;
  const [col, row] = mollweideSquareAt(lon, lat, squares.meta.square_m);
  const i = squares.index.get(col * 100000 + row);
  const ring = squareRing(col, row, squares.meta.square_m);
  if (i === undefined) return { index: null, people: 0, perKm2: 0, cumBefore: 1, ring };
  return {
    index: i,
    lon: squares.lon[i],
    lat: squares.lat[i],
    people: squares.people[i],
    perKm2: squares.perKm2[i],
    cumBefore: squares.cumBefore[i],
    // The squares are stored densest first, so the index is the square's rank among all squares
    // with people in them.
    rank: i + 1,
    of: squares.meta.count,
    ring,
  };
}

/** The square under a screen point among the drawn columns, picked on the GPU, or null. */
export function pickColumn(x, y) {
  if (!squares || !layersOn.has("columns_1km")) return null;
  const picked = overlay.pickObject({ x, y, layerIds: ["columns"], radius: 2 });
  if (!picked || picked.index < 0) return null;
  const i = picked.index;
  return squareAt(squares.lon[i], squares.lat[i]);
}

/**
 * Mark one square as clicked (its index from squareAt or pickColumn), or null. In 3D its column
 * is drawn again in sand with silt edges; in 2D the page draws its own marks around it, so the map adds nothing.
 */
export function setSelection(index) {
  selection = index ?? null;
  popStart = performance.now();
  apply();
  // The pop: the clicked square grows from 1x to POP_SCALE in POP_MS, one apply per frame.
  if (selection === null || reduceMotion.matches) return;
  const step = () => {
    apply();
    if (performance.now() - popStart < POP_MS) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const POP_SCALE = 1.15;
const POP_MS = 180;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let popStart = 0;

/**
 * The clicked square pops out of the 1 km squares: drawn again on top, in its own ramp colour,
 * with a 1.5 px silt outline, grown around its centre from 1x to 1.15x (ease out). Only where the
 * real squares are drawn (2D, from zoom 9); in 3D the clicked column turns wine instead.
 */
function popLayer(visible) {
  let data = [];
  if (visible && selection !== null && squares) {
    const i = selection;
    const [col, row] = mollweideSquareAt(squares.lon[i], squares.lat[i], squares.meta.square_m);
    const ring = squareRing(col, row, squares.meta.square_m);
    const t = reduceMotion.matches ? 1 : Math.min(1, (performance.now() - popStart) / POP_MS);
    const scale = 1 + (POP_SCALE - 1) * (1 - (1 - t) ** 3);
    const cx = (ring[0][0] + ring[2][0]) / 2;
    const cy = (ring[0][1] + ring[2][1]) / 2;
    data = [
      {
        polygon: ring.map(([x, y]) => [cx + (x - cx) * scale, cy + (y - cy) * scale]),
        color: RAMP_RGB[rampStep(squares.perKm2[i])],
      },
    ];
  }
  return new PolygonLayer({
    id: "pop",
    data,
    visible: data.length > 0,
    getPolygon: (d) => d.polygon,
    getFillColor: (d) => [...d.color, 255],
    getLineColor: [...SILT_RGB, 255],
    getLineWidth: 1.5,
    lineWidthUnits: "pixels",
    stroked: true,
    filled: true,
    updateTriggers: { getPolygon: [popStart, performance.now()] },
    parameters: FLAT,
  });
}

// ---- Plate ---------------------------------------------------------------------------------

/**
 * Water fades out between zoom 9.0 and 9.5: up close, the 1:10m line no longer fits the dots.
 * Outside Egypt it is drawn at 45%, as context; prepare.py tags each piece inside true or false.
 */
function waterOpacity(peak, inside = true, outside = true) {
  const byPlace = ["case", ["get", "inside"], inside ? peak : 0, outside ? peak * WATER_OUTSIDE_OPACITY : 0];
  return ["interpolate", ["linear"], ["zoom"], NILE_FADE_ZOOM[0], byPlace, NILE_FADE_ZOOM[1], 0];
}

function buildStyle() {
  const geojson = (name) => ({ type: "geojson", data: `${layersUrl}${name}`, tolerance: 0.2 });
  return {
    version: 8,
    sources: {
      // GeoJSON in .json files: GitHub Pages sends .json gzipped, a third of the size.
      land: geojson("land.json"),
      border: geojson("egypt_border.json"),
      water: geojson("nile_lakes.json"),
    },
    layers: [
      { id: "sea", type: "background", paint: { "background-color": COLORS.haze } },
      {
        id: "land",
        type: "fill",
        source: "land",
        paint: { "fill-color": ["case", ["get", "egypt"], COLORS.sand, COLORS.farSand] },
      },
      {
        id: "egypt_border",
        type: "line",
        source: "border",
        layout: { "line-join": "round" },
        paint: { "line-color": COLORS.dune, "line-width": 1 },
      },
      {
        id: "lakes",
        type: "fill",
        source: "water",
        filter: ["==", ["get", "kind"], "lake"],
        paint: { "fill-color": COLORS.blue, "fill-opacity": waterOpacity(1) },
      },
      {
        id: "rivers",
        type: "line",
        source: "water",
        filter: ["==", ["get", "kind"], "river"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": COLORS.blue,
          "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1.1, 6.5, 1.6, 9, 2.2],
          "line-opacity": waterOpacity(1),
        },
      },
    ],
  };
}

function applyPlate() {
  const show = (id, on) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  show("land", layersOn.has("land_sea"));
  show("egypt_border", layersOn.has("egypt_border"));
  const { nileOpacity, waterInside, waterOutside } = options;
  const water = layersOn.has("nile_lakes") && nileOpacity > 0 && (waterInside || waterOutside);
  show("lakes", water);
  show("rivers", water);
  if (water) {
    // The key's Nile entry switches only Egypt's own water; the rivers and lakes of the
    // neighbours stay as the plate's context, so they are switched apart.
    const opacity = waterOpacity(nileOpacity, waterInside, waterOutside);
    map.setPaintProperty("lakes", "fill-opacity", opacity);
    map.setPaintProperty("rivers", "line-opacity", opacity);
  }
}

// ---- Labels --------------------------------------------------------------------------------

function buildLabels(container, list) {
  labelLayer = document.createElement("div");
  labelLayer.className = "map-labels";
  labelLayer.setAttribute("aria-hidden", "true");
  container.append(labelLayer);
  return list.map((label) => {
    const element = document.createElement("div");
    element.className = "map-label";
    element.dataset.kind = label.kind;
    element.dataset.side = LABEL_SIDE[label.name] ?? "center";
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = label.name;
    element.append(text);
    labelLayer.append(element);
    return { ...label, element, text, box: null };
  });
}

/**
 * Place the labels that are on, in the order they were asked for. A label whose text would
 * touch one already placed, or leave the map, stays hidden: names never print over each other.
 */
function placeLabels() {
  if (!labelLayer) return;
  const width = map.getContainer().clientWidth;
  const height = map.getContainer().clientHeight;
  // Whatever the page lays over the map (a title, a hint) counts as already placed.
  const area = map.getContainer().getBoundingClientRect();
  const placed = labelAvoid().map((r) => ({
    left: r.left - area.left,
    top: r.top - area.top,
    right: r.right - area.left,
    bottom: r.bottom - area.top,
  }));
  const order = [...labelsOn.keys()];
  for (const label of labels) {
    const on = labelsOn.has(label.name);
    const opacity = options.labelOpacity[label.name] ?? 1;
    label.element.classList.toggle("hl", Boolean(labelsOn.get(label.name)));
    if (!on || opacity <= 0) {
      label.element.style.display = "none";
      continue;
    }
    label.element.style.display = "";
    const p = map.project([label.lon, label.lat]);
    label.element.style.transform = `translate(${p.x}px, ${p.y}px)`;
    label.element.style.opacity = String(opacity);
    label.priority = order.indexOf(label.name);
  }
  // Highest priority first: the order of the names passed to setLayers.
  const visible = labels
    .filter((label) => label.element.style.display !== "none")
    .sort((a, b) => a.priority - b.priority);
  for (const label of visible) {
    // The text's box around its anchor is measured once, then moved with the anchor: reading
    // layout on every frame of an orbit would stall the page.
    if (!label.box) {
      const r = label.text.getBoundingClientRect();
      const a = label.element.getBoundingClientRect();
      label.box = { left: r.left - a.left, top: r.top - a.top, right: r.right - a.left, bottom: r.bottom - a.top };
    }
    const p = map.project([label.lon, label.lat]);
    const box = {
      left: p.x + label.box.left,
      top: p.y + label.box.top,
      right: p.x + label.box.right,
      bottom: p.y + label.box.bottom,
    };
    // Behind the horizon of a steep tilt, project() still returns a point; it is no place to print.
    const outside =
      box.left < 0 || box.top < 0 || box.right > width || box.bottom > height || !Number.isFinite(p.y);
    const clash = placed.some(
      (o) => box.left < o.right + 6 && box.right > o.left - 6 && box.top < o.bottom + 4 && box.bottom > o.top - 4,
    );
    if (outside || clash) {
      label.element.style.visibility = "hidden";
    } else {
      label.element.style.visibility = "";
      placed.push(box);
    }
  }
}

// ---- Public API ----------------------------------------------------------------------------

/**
 * The drawing order, bottom up: heatmap and 1 km squares (both under the rivers and the border),
 * the red ochre area under the dots, columns, dots.
 */
function deckLayers() {
  const { below, columns } = squaresLayers();
  // The pop shows only where the real squares are drawn: 2D (no columns) from zoom 9.
  const squaresShown =
    !layersOn.has("columns_1km") &&
    (layersOn.has("squares_1km") || (layersOn.has("heatmap") && map.getZoom() > HEAT_FADE_ZOOM[0]));
  return [...below, ...columns, dotsLayer(), hoverSquareLayer(squaresShown), popLayer(squaresShown)].flat();
}

function apply() {
  if (!started) return;
  applyPlate();
  overlay.setProps({ layers: deckLayers() });
  placeLabels();
}

/**
 * Parse layer names: "dots_all", "squares_95 (35%)" (a note in brackets is
 * ignored), "labels:Nile (highlight), Aswan, Luxor" (the bracket marks a highlighted label).
 */
function parseLayers(names) {
  const on = new Set();
  const labelMap = new Map();
  for (const raw of names) {
    if (raw.startsWith("labels:")) {
      for (const part of raw.slice(7).split(",")) {
        const name = part.replace(/\(.*\)/, "").trim();
        if (!labels.some((label) => label.name === name)) throw new Error(`no label named ${name}`);
        labelMap.set(name, /\(highlight\)/.test(part));
      }
      continue;
    }
    const name = raw.replace(/\s*\(.*\)$/, "").trim();
    if (!LAYER_NAMES.includes(name)) throw new Error(`unknown layer ${raw}`);
    on.add(name);
  }
  return { on, labelMap };
}

/**
 * Say which layers are drawn: an array of layer names (LAYER_NAMES). Any layer not named
 * goes off. Options not given go back to their defaults, so every call describes the whole view.
 *
 * @param {string[]} names e.g. ["land_sea", "egypt_border", "dots_all", "labels:Cairo (highlight)"]
 * @param {object} [opts]
 * @param {"sparse"|"dense"|"all"} [opts.dots] which dots, over what the names say
 * @param {number} [opts.denseRevealLat] wave front: valley dots south of it are drawn
 * @param {number} [opts.dotsOpacity] 0 to 1
 * @param {number} [opts.dotsScale] dot size, 0 to 1
 * @param {number} [opts.squaresOpacity] the red ochre area under the dots, 0 to 1, default 0.35
 * @param {number} [opts.peopleShare] share of people whose squares the Population layer draws, 0.5 to 1
 * @param {number} [opts.heatmapRevealLat] the heatmap drawn only south of this latitude (a front)
 * @param {number} [opts.heatmapDebounceMs] how long the heatmap waits after a move, default 250
 * @param {number} [opts.squares1kmOpacity] opacity of squares_1km named on its own, default 1
 * @param {number} [opts.columnsStagger] the columns rising densest first, 0 to 1 (null: all up)
 * @param {number} [opts.peopleFrom] share of people in the most crowded squares left out, 0 to 1
 * @param {number} [opts.heatmapOpacity] 0 to 1, for the heatmap and the squares that replace it
 * @param {number} [opts.squaresThreshold] share of people, 0 to 1, default 0.95
 * @param {number} [opts.columnsScale] column height, 0 to 1
 * @param {number} [opts.nileOpacity] 0 to 1
 * @param {boolean} [opts.waterInside] draw the rivers and lakes inside Egypt, default true
 * @param {boolean} [opts.waterOutside] draw the rivers and lakes outside Egypt, default true
 * @param {string[]} [opts.highlightLabels] label names drawn in red ochre
 * @param {Object<string, number>} [opts.labelOpacity] label name to opacity, for fades
 */
export function setLayers(names, opts = {}) {
  const { on, labelMap } = parseLayers(names);
  for (const name of opts.highlightLabels ?? []) if (labelMap.has(name)) labelMap.set(name, true);
  layersOn = on;
  labelsOn = labelMap;
  options = { ...DEFAULT_OPTIONS, ...opts };
  apply();
}

/**
 * The replay, from 0 (no dots) to 1 (every dot). This map has no time axis: its one sequence
 * is the replay, desert dots first, then the valley from south to north.
 * @param {number} step 0 to 1
 */
export function setTime(step) {
  replay = Math.min(1, Math.max(0, step));
  apply();
}

/**
 * Move the camera. With a duration it eases there (ease-out cubic), without one it jumps.
 * @param {{center: [number, number], zoom: number, pitch?: number, bearing?: number, duration?: number}} camera
 */
export function setView({ duration = 0, ...camera }) {
  if (duration > 0) map.easeTo({ ...camera, duration, easing: (t) => 1 - (1 - t) ** 3 });
  else map.jumpTo(camera);
}

/**
 * The zoom at which all of Egypt fits a map of this size around a fixed centre, keeping the given
 * padding (in px) clear on each side. Worked out in Web Mercator's unit square: at zoom z the
 * world is 512 x 2^z pixels wide, so each side of Egypt gives one largest zoom, and the smallest wins.
 */
export function fitZoom(center = START_VIEW.center, padding = { top: 40, bottom: 40, left: 40, right: 40 }) {
  const { clientWidth: width, clientHeight: height } = map.getContainer();
  const mercX = (lon) => (lon + 180) / 360;
  const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
  const [cx, cy] = [mercX(center[0]), mercY(center[1])];
  const sides = [
    [width / 2 - padding.left, cx - mercX(EGYPT_BOX[0])],
    [width / 2 - padding.right, mercX(EGYPT_BOX[2]) - cx],
    [height / 2 - padding.top, cy - mercY(EGYPT_BOX[3])],
    [height / 2 - padding.bottom, mercY(EGYPT_BOX[1]) - cy],
  ];
  return Math.min(...sides.map(([px, span]) => Math.log2(Math.max(px, 40) / (span * 512))));
}

/** Resolves when the map has drawn everything it was asked to and is still. */
export function rendered() {
  return new Promise((resolve) => {
    map.once("idle", () => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    map.triggerRepaint();
  });
}

/** The MapLibre map and the deck.gl overlay, for scripts that need more than this API. */
export function getMap() {
  return { map, overlay };
}

/**
 * Build the map in a container (an element or its id). Draws no interface: no buttons, no key.
 *
 * @param {HTMLElement|string} container
 * @param {object} [opts]
 * @param {object} [opts.view] the first camera, default START_VIEW
 * @param {string[]} [opts.layers] the first layers, as for setLayers
 * @param {object} [opts.layerOptions] the first options, as for setLayers
 * @param {number} [opts.replay] the first replay step (0 = no dots yet), default 1
 * @param {boolean} [opts.interactive] default true
 * @param {number} [opts.pixelRatio] default the screen's, capped at 2
 * @param {string} [opts.layersUrl] where layers/ is, default next to this page
 * @param {function(): DOMRect[]} [opts.labelAvoid] screen boxes no label may touch (a title)
 * @param {{top: number, bottom: number, left: number, right: number}} [opts.fitPadding] fit the
 *   zoom so all of Egypt shows inside this padding (px), around the view's centre
 * @returns {Promise<{map: object, overlay: object, figures: object[], labels: object[]}>}
 */
export async function createMap(container, opts = {}) {
  try {
    const element = typeof container === "string" ? document.getElementById(container) : container;
    layersUrl = opts.layersUrl ?? new URL("layers/", document.baseURI).href;
    replay = opts.replay ?? 1;
    labelAvoid = opts.labelAvoid ?? (() => []);
    const figuresPromise = fetchLayer("key_figures.json");
    const labelsPromise = fetchLayer("labels.json");
    const view = { ...START_VIEW, ...opts.view };
    map = new MapLibreMap({
      container: element,
      style: buildStyle(),
      ...view,
      minZoom: 3.5,
      maxZoom: 11,
      maxPitch: 60,
      maxBounds: [
        [PLATE_BOX[0], PLATE_BOX[1]],
        [PLATE_BOX[2], PLATE_BOX[3]],
      ],
      renderWorldCopies: false,
      interactive: opts.interactive ?? true,
      attributionControl: false,
      fadeDuration: 0,
      // A dot is 1.4 px. Beyond 2 device pixels per CSS pixel nobody sees a difference, and every
      // extra pixel costs fill rate on half a million dots.
      pixelRatio: opts.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2),
      canvasContextAttributes: { antialias: true, preserveDrawingBuffer: Boolean(opts.preserveDrawingBuffer) },
    });
    overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    // deck.gl writes its cursor straight onto the map canvas, which overrules any cursor set on
    // the elements around it, so the pointer over a hovered square has to come from deck.gl too.
    // MapLibre's closed hand while dragging comes from a stylesheet rule that the canvas's own
    // cursor overrules as well, so I set it here for the length of the drag.
    let dragging = false;
    map.on("dragstart", () => {
      dragging = true;
      map.getCanvas().style.cursor = "grabbing";
    });
    map.on("dragend", () => {
      dragging = false;
      map.getCanvas().style.cursor = cursorFor({ isDragging: false });
    });
    overlay.setProps({ getCursor: (state) => cursorFor({ isDragging: state.isDragging || dragging }) });
    const loaded = new Promise((resolve) => map.once("load", resolve));
    // Only the data the first view draws is part of ready: the squares for the heatmap, the 95%
    // squares and the columns, the dots for the dots. The rest loads on first use.
    const firstLayers = (opts.layers ?? DEFAULT_LAYERS).join(" ");
    const needed = [];
    if (/heatmap|squares|columns/.test(firstLayers)) needed.push(loadSquares());
    if (/dots_/.test(firstLayers)) needed.push(loadDots());
    const [figures, labelList] = await Promise.all([figuresPromise, labelsPromise, loaded, ...needed]);
    checkFigures(figures);
    // The page asks for Egypt to fill its map area: set the zoom now, so the frame that ready
    // waits for is the start view itself.
    if (opts.fitPadding) map.jumpTo({ zoom: fitZoom(view.center, opts.fitPadding) });
    map.addControl(overlay);
    labels = buildLabels(element, labelList);
    // Fonts before labels are measured: a label measured in a fallback face would collide wrongly.
    await Promise.all([
      document.fonts.load('500 16px "Reem Kufi"'),
      document.fonts.load('700 16px "Reem Kufi"'),
      document.fonts.load('400 16px "IBM Plex Sans Arabic"'),
      document.fonts.load('600 16px "IBM Plex Sans Arabic"'),
    ]);
    await document.fonts.ready;
    heatRadius = heatRadiusPx(map.getZoom(), map.getCenter().lat);
    // A new radius makes deck.gl rebuild the heatmap's weights, too slow for every frame of a
    // zoom; at the end of each zoom is enough.
    map.on("zoomend", () => {
      const radius = heatRadiusPx(map.getZoom(), map.getCenter().lat);
      if (radius === heatRadius) return;
      heatRadius = radius;
      overlay.setProps({ layers: deckLayers() });
    });
    started = true;
    setLayers(opts.layers ?? DEFAULT_LAYERS, opts.layerOptions);
    // Dot size, heatmap radius and the heatmap-to-squares hand-over all follow the zoom.
    map.on("zoom", () => overlay.setProps({ layers: deckLayers() }));
    map.on("render", placeLabels);
    map.on("resize", () => {
      // A phone turning round can change the label size in the stylesheet: measure again.
      for (const label of labels) label.box = null;
      placeLabels();
    });
    await rendered();
    const result = { map, overlay, figures, labels: labelList };
    resolveReady(result);
    return result;
  } catch (error) {
    rejectReady(error);
    throw error;
  }
}

/** The map shows two key figures, exactly as key_figures.json displays them. Anything else is a bug. */
function checkFigures(figures) {
  const expected = { share_people_pct: "95%", share_land_pct: "2.2%" };
  for (const [id, display] of Object.entries(expected)) {
    const figure = figures.find((f) => f.id === id);
    if (!figure || figure.display !== display) {
      throw new Error(`key_figures.json: ${id} should display ${display}, found ${figure?.display}`);
    }
  }
}
