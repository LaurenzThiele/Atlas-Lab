/**
 * Every tsunami on record: the interactive globe, and a small API to script your own.
 *
 * What it does: loads the prepared layers and draws every runup as three concentric rings on an
 * indigo globe. createMap() gives you that globe and nothing else: no panel, no button, no text.
 * The public page around it lives in ui.js, and it only ever uses what this file exports.
 * Reads:  layers/rings.json, highlights.json, figures.json, land.json, and ring_of_fire_order.json
 *         only when asked for (createMap with rimSweep: true)
 * Run:    npm run dev (from the piece folder), or npm run build for a static site in maps/dist/.
 *
 * Why deck.gl with its GlobeView: a globe shows the whole Pacific rim as one ring, without the
 * Mercator break at 180 degrees that would cut the ocean in two right down the middle of the map.
 * And deck.gl draws on the GPU, so 29,340 animated rings (three strokes each) stay smooth.
 *
 * The land is one flat tint with no borders, no names and no outline: just enough to see where you
 * are. It stays quieter than any ring, so the bright lines you see along the coasts are still drawn
 * by the tsunamis that hit them. Try map.setLayers({ land: 0 }) to see the rings draw them alone.
 *
 * What you learn: how to animate tens of thousands of points by filling typed arrays yourself and
 * handing them straight to the GPU; how additive blending turns density into light; why a
 * proportional symbol must scale its area, not its radius; and how to separate what a map draws
 * from when it draws it, so the same picture can be explored by hand or stepped through by script.
 *
 * Scripting your own view. Everything goes through five calls on the object createMap() returns:
 *
 *   import { createMap } from "./main.js";
 *   const map = createMap(document.getElementById("map"), { layersUrl: "layers/" });
 *   await map.ready;
 *   map.setView({ longitude: 138, latitude: 36, zoom: 4.2, pitch: 45, bearing: -20 });
 *   map.setLayers({ opacity: { nonJapan: 0.2 }, columns: { exaggeration: 12000, rise: 1 } });
 *   map.setTime(1958);  // every ring up to the end of 1958, the year of the Lituya Bay wave
 *
 * Add map.renderAt() to draw right now. See createMap below for every option.
 */

import { Deck, _GlobeView as GlobeView } from "@deck.gl/core";
import { ColumnLayer, PathLayer, ScatterplotLayer, SolidPolygonLayer } from "@deck.gl/layers";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/shippori-mincho-b1/latin-400.css";
import "@fontsource/shippori-mincho-b1/latin-800.css";

// Palette: these six colours and the ramp between blue and foam are the only colours on the map.
const INDIGO = [15, 27, 45];
const BLUE = [62, 110, 158];
const FOAM = [207, 230, 238];
const RED = [232, 87, 63];
const WASHI = [241, 234, 219];

// Ring size. Area follows height, so the radius follows the square root of height.
const RING_PX = 1.5;
const RING_REFERENCE_ZOOM = 1.1;
const STROKE_SCALES = [1, 0.66, 0.33];
const MIN_RING_PX = 1;
const STROKE_PX = 1;
const INK_BLEED_PX = 2;

// How a ring is born: each stroke grows from 0 to its size in 0.4 s, the next one 0.1 s later.
const GROW_S = 0.4;
const STAGGER_S = 0.1;
export const SETTLE_S = GROW_S + STAGGER_S * (STROKE_SCALES.length - 1);

// How strong one stroke is before the additive blend adds them up. Below 1, so a lone ring on the
// open ocean stays quiet and only a coast with many rings on top of each other starts to glow.
const RING_ALPHA = 0.75;
// The record is wildly uneven: one 2 degree cell of Japan holds thousands of rings, a Pacific island
// holds one. No single strength shows both, so each ring's light shrinks with the number of rings
// around it. Dense coasts still glow far brighter than open ocean, because the light still adds up,
// but they keep their structure. Zooming in pulls the rings apart, so the effect fades out there.
const DENSITY_CELL_DEG = 2;
const DENSITY_EXPONENT = 0.6;
const DENSITY_FULL_ZOOM = 2;
const DENSITY_NONE_ZOOM = 9;
// A very small ring is three strokes on one pixel. Thousands of 1 m gauge readings on one bay would
// burn into a solid blob, so strokes under this radius give proportionally less light.
const FULL_LIGHT_RADIUS_PX = 3;
const MIN_LIGHT_SHARE = 0.2;
const BLEED_STRENGTH = 0.14;
const COLUMN_ALPHA = 0.8;
const COLUMN_RADIUS_PX = 2;

// Colour ramp limits, in metres, on a log scale: heights span more than three orders of magnitude.
export const RAMP_MIN_M = 0.1;
export const RAMP_MAX_M = 100;

const PICK_RADIUS_PX = 6;

const GRAIN_TILE_PX = 512;
const GRAIN_SEED = 684;
const DITHER_SEED = 2026;
const GRATICULE_STEP_DEG = 15;
const GRATICULE_ALPHA = 0.08;
const LAND_ALPHA = 0.18;
// The glow around the rim starts at this bearing (just before Chile) and travels counterclockwise.
const RIM_SWEEP_START_DEG = 135;
const GLOBE_RADIUS_COMMON = 256; // deck.gl's globe radius in its own common units

/* ---------------------------------- Colour ---------------------------------- */

const srgbToLinear = (v) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const linearToSrgb = (x) => {
  const clamped = Math.min(1, Math.max(0, x));
  const v = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(v * 255);
};

function toOklab([r8, g8, b8]) {
  const [r, g, b] = [r8, g8, b8].map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const BLUE_LAB = toOklab(BLUE);
const FOAM_LAB = toOklab(FOAM);

/**
 * Colour for a share 0..1 of the ramp. I mix in OKLab because it is built around how we see:
 * equal steps look like equal steps, and the mix does not dip through a muddy middle like sRGB.
 * It is one hue changing only in lightness, which also reads the same under colour blindness.
 */
export function rampColor(share) {
  return fromOklab(BLUE_LAB.map((v, k) => v + (FOAM_LAB[k] - v) * share));
}

function rampShare(runupM) {
  const log = Math.log10(Math.min(RAMP_MAX_M, Math.max(RAMP_MIN_M, runupM)));
  return (log - Math.log10(RAMP_MIN_M)) / (Math.log10(RAMP_MAX_M) - Math.log10(RAMP_MIN_M));
}

/* ---------------------------------- Size ---------------------------------- */

/** radius_px = RING_PX * sqrt(runup_m) * 2 ** (0.5 * (zoom - 1.1)). The legend uses it too. */
export function ringRadiusPx(runupM, zoom) {
  return RING_PX * Math.sqrt(runupM) * 2 ** (0.5 * (zoom - RING_REFERENCE_ZOOM));
}

const easeOutCubic = (x) => 1 - (1 - x) ** 3;

/* ---------------------------------- Layers ---------------------------------- */

/**
 * ScatterplotLayer draws a hard-edged stroke. I replace its stroke profile with a thin core and a
 * soft falloff, the ink bleeding 2 px into the paper. The wider line is what makes room for the
 * falloff inside one draw call, so the bleed costs no extra pass over 29,340 points.
 */
class InkRingLayer extends ScatterplotLayer {
  getShaders() {
    const shaders = super.getShaders();
    const hook = "DECKGL_FILTER_COLOR(fragColor, geometry);";
    if (!shaders.fs.includes(hook)) {
      throw new Error("the ScatterplotLayer shader has changed: check InkRingLayer");
    }
    const profile = /* glsl */ `
      float lineW = (1.0 - innerUnitRadius) * outerRadiusPixels;
      float distToStroke = abs(distToCenter - (outerRadiusPixels - lineW * 0.5));
      float coreHalf = lineW * ${(STROKE_PX / (STROKE_PX + 2 * INK_BLEED_PX) / 2).toFixed(4)};
      float core = 1.0 - smoothstep(coreHalf - 0.5, coreHalf + 0.5, distToStroke);
      float bleed = 1.0 - clamp((distToStroke - coreHalf) / (lineW * 0.5 - coreHalf), 0.0, 1.0);
      fragColor.a *= max(core, ${BLEED_STRENGTH.toFixed(2)} * bleed * bleed);
    `;
    return { ...shaders, fs: shaders.fs.replace(hook, `${profile}\n${hook}`) };
  }
}
InkRingLayer.layerName = "InkRingLayer";

// Additive blending: every ring adds its light to what is already on the canvas, so a coast hit a
// thousand times shines and a lone ring stays faint. Alpha stays untouched and the canvas opaque.
// Depth is tested, so the solid globe hides the far side, but not written, so rings never hide
// each other.
const ADDITIVE = {
  blend: true,
  blendColorOperation: "add",
  blendColorSrcFactor: "src-alpha",
  blendColorDstFactor: "one",
  blendAlphaOperation: "add",
  blendAlphaSrcFactor: "zero",
  blendAlphaDstFactor: "one",
  depthWriteEnabled: false,
  depthCompare: "less-equal",
};

// Plain additive light runs away to white. This keeps the top of the scale at sea foam: a screen
// covering disc drawn with a "min" blend caps every pixel at the foam value, channel by channel.
const CAP_AT_FOAM = {
  blend: true,
  blendColorOperation: "min",
  blendColorSrcFactor: "one",
  blendColorDstFactor: "one",
  blendAlphaOperation: "add",
  blendAlphaSrcFactor: "zero",
  blendAlphaDstFactor: "one",
  depthWriteEnabled: false,
  depthCompare: "always",
  cullMode: "none",
};

const HIGHLIGHT_BLEND = {
  blend: true,
  blendColorSrcFactor: "src-alpha",
  blendColorDstFactor: "one-minus-src-alpha",
  blendAlphaSrcFactor: "zero",
  blendAlphaDstFactor: "one",
  depthWriteEnabled: false,
  depthCompare: "less-equal",
};

function graticulePaths() {
  const paths = [];
  const line = (from, to, point) => {
    const coords = [];
    for (let v = from; v <= to; v += 3) coords.push(point(v));
    paths.push(coords);
  };
  for (let lon = -180; lon < 180; lon += GRATICULE_STEP_DEG) {
    line(-90, 90, (lat) => [lon, lat]);
  }
  for (let lat = -75; lat <= 75; lat += GRATICULE_STEP_DEG) {
    line(-180, 180, (lon) => [lon, lat]);
  }
  return paths;
}
const GRATICULE = graticulePaths();
const GLOBE_POLYGON = [
  [
    [-180, 90],
    [0, 90],
    [180, 90],
    [180, -90],
    [0, -90],
    [-180, -90],
  ],
];

/* ---------------------------------- Data ---------------------------------- */

async function fetchJson(layersUrl, name) {
  const response = await fetch(new URL(`${layersUrl}${name}`, document.baseURI));
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}. Run maps/prepare.py first.`);
  return response.json();
}

/** Great-circle angle between two points, in degrees. */
function angularDistanceDeg(lon1, lat1, lon2, lat2) {
  const toRad = Math.PI / 180;
  const cosine =
    Math.sin(lat1 * toRad) * Math.sin(lat2 * toRad) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lon2 - lon1) * toRad);
  return Math.acos(Math.min(1, Math.max(-1, cosine))) / toRad;
}

/** Natural log of how many rings share each ring's grid cell. */
function localLogDensity(rings) {
  const counts = new Map();
  const cell = (i) =>
    Math.floor(rings.lon[i] / DENSITY_CELL_DEG) * 1000 + Math.floor(rings.lat[i] / DENSITY_CELL_DEG);
  for (let i = 0; i < rings.count; i += 1) counts.set(cell(i), (counts.get(cell(i)) ?? 0) + 1);
  return Float32Array.from({ length: rings.count }, (_, i) => Math.log(counts.get(cell(i))));
}

function buildRingData(rings, highlights, rimOrder) {
  const n = rings.count;
  const colors = new Uint8Array(n * 3);
  const heightsM = new Float32Array(rings.runup_m);
  const sweepDeg = new Float32Array(n).fill(-1);
  const inEvent = new Uint8Array(n);
  const logDensity = localLogDensity(rings);
  const eventArrival = new Float32Array(n);

  for (let i = 0; i < n; i += 1) {
    colors.set(rampColor(rampShare(rings.runup_m[i])), i * 3);
  }
  // Degrees the glow must travel from RIM_SWEEP_START_DEG to reach each Pacific ring. Only a map made
  // with rimSweep: true loads the order; the others leave every ring at -1 (not on the rim).
  rimOrder?.index.forEach((ringIndex, k) => {
    sweepDeg[ringIndex] = (RIM_SWEEP_START_DEG - rimOrder.bearing_deg[k] + 720) % 360;
  });
  // Rings of the deadliest tsunami, ranked by their angular distance from the ring nearest its
  // source. This is geometry, not travel time: it only sets the order in which they light up.
  const source = highlights.deadliest.index;
  const distancesDeg = highlights.deadliest.event_rings.map((i) =>
    angularDistanceDeg(rings.lon[source], rings.lat[source], rings.lon[i], rings.lat[i]),
  );
  const maxDistanceDeg = Math.max(...distancesDeg);
  highlights.deadliest.event_rings.forEach((i, k) => {
    inEvent[i] = 1;
    eventArrival[i] = distancesDeg[k] / maxDistanceDeg;
  });

  return {
    n,
    rings,
    colors,
    logDensity,
    dither: Float32Array.from({ length: n }, mulberry32(DITHER_SEED)),
    heightsM,
    sweepDeg,
    inEvent,
    eventArrival,
    isJapan: Uint8Array.from(rings.country, (c) => (c === "Japan" ? 1 : 0)),
    isPacific: Uint8Array.from(rings.pacific, (p) => (p ? 1 : 0)),
    t: new Float32Array(rings.t),
    highlightKeys: ["first", "tallest", "deadliest"],
    highlights,
  };
}

/* ---------------------------------- The ring engine ---------------------------------- */

/**
 * The buffers I fill for every frame. Only rings on screen go in, so the GPU never draws a hidden
 * ring and a picked index maps straight back to its ring through `ringIndex`.
 */
function makeBuffers(n) {
  return {
    ringIndex: new Uint32Array(n),
    positions: new Float32Array(n * 3),
    heights: new Float32Array(n),
    radii: STROKE_SCALES.map(() => new Float32Array(n)),
    colors: STROKE_SCALES.map(() => new Uint8Array(n * 4)),
    columnColors: new Uint8Array(n * 4),
  };
}

const growth = (ageS, stroke) => {
  const x = (ageS - stroke * STAGGER_S) / GROW_S;
  return x <= 0 ? 0 : x >= 1 ? 1 : easeOutCubic(x);
};

/**
 * Fill the buffers for one frame and return how many rings are in them. This runs up to 60 times
 * a second over all rings, so it stays a plain loop over typed arrays.
 */
function fillRings(data, buffers, view) {
  const {
    zoom,
    pixelScale,
    clockS,
    durationS,
    minHeightM,
    region,
    opacity,
    sweepDeg,
    hasSweep,
    loopBack,
    hideEvent,
    muted = null,
  } = view;
  const zoomScale = RING_PX * 2 ** (0.5 * (zoom - RING_REFERENCE_ZOOM)) * pixelScale;
  const minPx = MIN_RING_PX * pixelScale;
  const fullLightPx = FULL_LIGHT_RADIUS_PX * pixelScale;
  const zoomShare = (zoom - DENSITY_FULL_ZOOM) / (DENSITY_NONE_ZOOM - DENSITY_FULL_ZOOM);
  // While the record is still arriving there is less to compress, so the early rings stay bright
  // and the map stops down gradually as it fills up.
  let exposure = 1;
  if (loopBack) {
    const opening = Math.sqrt(loopBack.clockS / loopBack.durationS);
    exposure = 1 + (opening - 1) * loopBack.progress;
  } else if (clockS !== null) {
    exposure = Math.sqrt(Math.min(1, Math.max(0, clockS) / durationS));
  }
  const densityExponent = DENSITY_EXPONENT * exposure * (1 - Math.min(1, Math.max(0, zoomShare)));
  const { positions, heights, ringIndex, radii, colors, columnColors } = buffers;
  const { rings } = data;
  let count = 0;

  for (let i = 0; i < data.n; i += 1) {
    const heightM = data.heightsM[i];
    if (heightM < minHeightM) continue;
    const isPacific = data.isPacific[i] === 1;
    if (region === "pacific" && !isPacific) continue;
    if (region === "rest" && isPacific) continue;
    if (hideEvent && data.inEvent[i]) continue;

    // Age of this ring in seconds since it appeared on the timeline.
    let ageS = Infinity;
    let alphaScale = opacity.all;
    if (loopBack) {
      // Blending from "all rings" back to an earlier time: rings of that time shrink to their size
      // at that time, every later ring fades away.
      const openingAgeS = loopBack.clockS - data.t[i] * loopBack.durationS;
      if (openingAgeS <= 0) alphaScale *= 1 - loopBack.progress;
      else ageS = SETTLE_S + (openingAgeS - SETTLE_S) * loopBack.progress;
    } else if (clockS !== null) {
      ageS = clockS - data.t[i] * durationS;
    }
    if (ageS <= 0 || alphaScale <= 0) continue;

    if (!isPacific) alphaScale *= opacity.nonPacific;
    if (!data.isJapan[i]) alphaScale *= opacity.nonJapan;

    // The share of the way this ring has moved toward foam, for the wave around the rim.
    let toFoam = 0;
    if (hasSweep && isPacific) {
      const behindDeg = sweepDeg - data.sweepDeg[i];
      if (behindDeg < 0) alphaScale *= 0.45;
      else {
        const crest = Math.exp(-((behindDeg / 18) ** 2));
        alphaScale *= 0.7 + 0.3 * crest;
        toFoam = 0.6 * crest;
      }
    }

    const densityLight = Math.exp(-densityExponent * data.logDensity[i]);
    const alpha8 = 255 * RING_ALPHA * densityLight * Math.min(1, alphaScale);
    // An 8-bit canvas cannot add less than one step of light, so a very faint ring would round to
    // nothing and a dimmed coast would vanish while a lone island stayed lit. Rounding each ring up
    // or down at random, with a fixed seed, keeps the total light of a coast right on average.
    const dither = data.dither[i];
    // A ring drawn in red is not also lit in foam underneath, but it still counts as shown.
    const lit = muted === null || !muted.has(i);

    const r = data.colors[i * 3] + (FOAM[0] - data.colors[i * 3]) * toFoam;
    const g = data.colors[i * 3 + 1] + (FOAM[1] - data.colors[i * 3 + 1]) * toFoam;
    const b = data.colors[i * 3 + 2] + (FOAM[2] - data.colors[i * 3 + 2]) * toFoam;
    const radiusPx = zoomScale * Math.sqrt(heightM);

    for (let stroke = 0; stroke < STROKE_SCALES.length; stroke += 1) {
      const grown = ageS === Infinity ? 1 : growth(ageS, stroke);
      const strokePx = radiusPx * STROKE_SCALES[stroke];
      radii[stroke][count] = Math.max(minPx, strokePx * grown);
      const light = Math.max(MIN_LIGHT_SHARE, Math.min(1, strokePx / fullLightPx));
      const color = colors[stroke];
      color[count * 4] = r;
      color[count * 4 + 1] = g;
      color[count * 4 + 2] = b;
      // A stroke that has not started yet is drawn with no light at all.
      color[count * 4 + 3] = lit && grown > 0 ? Math.floor(alpha8 * light + dither) : 0;
    }
    columnColors[count * 4] = r;
    columnColors[count * 4 + 1] = g;
    columnColors[count * 4 + 2] = b;
    columnColors[count * 4 + 3] = lit
      ? Math.floor(
          255 * COLUMN_ALPHA * Math.min(1, alphaScale) ** 1.5 * Math.exp(-0.2 * data.logDensity[i]) +
            dither,
        )
      : 0;

    positions[count * 3] = rings.lon[i];
    positions[count * 3 + 1] = rings.lat[i];
    positions[count * 3 + 2] = 0;
    heights[count] = heightM;
    ringIndex[count] = i;
    count += 1;
  }
  return count;
}

/** Red rings, always in plain alpha blending so they stay the exact shu red over any glow. */
function redRingLayers(id, items, pixelScale) {
  // items: {lon, lat, radiusPx, alpha, strokes}
  return STROKE_SCALES.map(
    (scale, stroke) =>
      new InkRingLayer({
        id: `${id}-${stroke}`,
        data: items,
        getPosition: (d) => [d.lon, d.lat],
        getRadius: (d) => Math.max(MIN_RING_PX * pixelScale, d.radiiPx[stroke] * scale),
        getLineColor: (d) => [...RED, Math.round(255 * d.alpha * (d.radiiPx[stroke] > 0 ? 1 : 0))],
        radiusUnits: "pixels",
        lineWidthUnits: "pixels",
        getLineWidth: (STROKE_PX + 2 * INK_BLEED_PX) * pixelScale,
        stroked: true,
        filled: false,
        pickable: false,
        parameters: HIGHLIGHT_BLEND,
        updateTriggers: { getRadius: items, getLineColor: items },
      }),
  );
}

function ringLayers(buffers, count, pixelScale, pickable) {
  return STROKE_SCALES.map(
    (_, stroke) =>
      new InkRingLayer({
        id: `rings-${stroke}`,
        // A new subarray each frame is how deck.gl learns that the numbers inside have changed.
        data: {
          length: count,
          attributes: {
            getPosition: { value: buffers.positions.subarray(0, count * 3), size: 3 },
            getRadius: { value: buffers.radii[stroke].subarray(0, count), size: 1 },
            getLineColor: {
              value: buffers.colors[stroke].subarray(0, count * 4),
              size: 4,
              normalized: true,
            },
          },
        },
        radiusUnits: "pixels",
        lineWidthUnits: "pixels",
        getLineWidth: (STROKE_PX + 2 * INK_BLEED_PX) * pixelScale,
        stroked: true,
        filled: false,
        pickable,
        parameters: ADDITIVE,
      }),
  );
}

function columnLayer(buffers, count, elevationScale, pixelScale, pickable) {
  return new ColumnLayer({
    id: "columns",
    data: {
      length: count,
      attributes: {
        getPosition: { value: buffers.positions.subarray(0, count * 3), size: 3 },
        getElevation: { value: buffers.heights.subarray(0, count), size: 1 },
        getFillColor: {
          value: buffers.columnColors.subarray(0, count * 4),
          size: 4,
          normalized: true,
        },
      },
    },
    diskResolution: 6,
    radius: COLUMN_RADIUS_PX * pixelScale,
    radiusUnits: "pixels",
    extruded: true,
    material: false,
    elevationScale,
    pickable,
    parameters: ADDITIVE,
  });
}

function baseLayers(showGraticule, pixelScale, landPolygons, landOpacity) {
  const layers = [
    // The globe itself: the same indigo as the page, and solid, so it hides the far side.
    new SolidPolygonLayer({
      id: "globe",
      data: GLOBE_POLYGON,
      getPolygon: (d) => d,
      getFillColor: INDIGO,
      stroked: false,
    }),
  ];
  if (landOpacity > 0) {
    layers.push(
      new SolidPolygonLayer({
        id: "land",
        data: landPolygons,
        getPolygon: (d) => d,
        getFillColor: [...BLUE, Math.round(255 * LAND_ALPHA)],
        opacity: landOpacity,
        // The land lies on the same sphere as the globe, so a depth test would flicker between
        // them. Back-face culling already hides the far side of a sphere, so I skip the test.
        parameters: { depthWriteEnabled: false, depthCompare: "always", cullMode: "back" },
      }),
    );
  }
  if (showGraticule) {
    layers.push(
      new PathLayer({
        id: "graticule",
        data: GRATICULE,
        getPath: (d) => d,
        getColor: [...BLUE, Math.round(255 * GRATICULE_ALPHA)],
        getWidth: pixelScale,
        widthUnits: "pixels",
        parameters: { depthWriteEnabled: false, depthCompare: "less-equal" },
      }),
    );
  }
  return layers;
}

function capLayer(camera, frameHeightPx) {
  return new ScatterplotLayer({
    id: "cap-at-foam",
    data: [camera],
    getPosition: (d) => [d.longitude, d.latitude],
    getRadius: frameHeightPx * 2,
    getFillColor: FOAM,
    radiusUnits: "pixels",
    billboard: true,
    antialiasing: false,
    pickable: false,
    parameters: CAP_AT_FOAM,
    updateTriggers: { getPosition: camera },
  });
}

/* ---------------------------------- Texture ---------------------------------- */

/** A small seeded random generator: the same grain on every load, on every machine. */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Washi grain made in code, so no texture image is downloaded. The CSS sets it to 6%. */
async function paintGrain(element) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = GRAIN_TILE_PX;
  const context = canvas.getContext("2d");
  const image = context.createImageData(GRAIN_TILE_PX, GRAIN_TILE_PX);
  const random = mulberry32(GRAIN_SEED);
  for (let p = 0; p < image.data.length; p += 4) {
    image.data[p] = WASHI[0];
    image.data[p + 1] = WASHI[1];
    image.data[p + 2] = WASHI[2];
    // Cubed so most pixels stay clean: the grain is seen in its few strong specks (up to 6%), and
    // the indigo underneath stays close to its true value.
    image.data[p + 3] = Math.floor(random() ** 3 * 256);
  }
  context.putImageData(image, 0, 0);
  const url = canvas.toDataURL("image/png");
  const loaded = new Image();
  loaded.src = url;
  await loaded.decode();
  element.style.backgroundImage = `url(${url})`;
}

/* ---------------------------------- The public API ---------------------------------- */

const DEFAULT_LAYERS = {
  land: 1,
  graticule: true,
  rings: true,
  columns: null,
  highlights: [],
  spreadEvent: null,
  opacity: { all: 1, nonPacific: 1, nonJapan: 1 },
  rimSweepDeg: null,
  minHeightM: 0,
  region: "all",
};

/**
 * Create a globe inside `container` and return an object to drive it. I keep drawing and timing
 * apart on purpose: the setters only say what the map should show, and nothing here reads a clock.
 * What you decide about time, you decide yourself, so one set of inputs always gives one picture.
 *
 * Options, all optional:
 *   camera           where to start: { longitude, latitude, zoom, pitch, bearing }
 *   width, height    fixed size in px, instead of filling the container
 *   pixelScale       scales the whole picture: 2 means one zoom level more and every pixel size
 *                    doubled, the same image at twice the resolution
 *   paddingBottomPx  moves the camera's aim point up without moving the camera itself
 *   controller       deck.gl controller settings, so a reader can rotate, tilt and zoom
 *   pickable         let the rings answer to hover and click (see ringFromPick and pickRing)
 *   useDevicePixels  false renders exactly width x height, whatever the screen's pixel ratio
 *   layersUrl        where the prepared layers live, relative to the page ("layers/")
 *   grainElement     an element to paint the washi grain on (style.css sets its 6%)
 *   onViewChange     called with the camera when a reader moves the globe
 *   deckProps        anything else for deck.gl itself, such as onHover or getCursor
 *   rimSweep         true also loads ring_of_fire_order.json, which setLayers({ rimSweepDeg })
 *                    needs. The page never uses the sweep, so it does not download the file.
 *
 * Returned:
 *   ready            a promise: data, fonts, grain and GPU are all there, the map can draw
 *   setView(camera)  move the camera; give only the fields you want to change
 *   setLayers(layers)  what to show; give only the fields you want to change:
 *     land           0 to 1: how strongly the land tint shows; 0 removes it
 *     graticule      true or false
 *     rings          true or false
 *     columns        null, or { exaggeration, rise }; rise 0 to 1 grows the columns from the ground
 *     highlights     red rings: a list of { index, pulse, minRadiusPx, onlyIfShown, column }.
 *                    pulse 0 to 1 swells the ring; column also draws its column in red
 *     spreadEvent    null, or { clockS, durationS }: the rings of the deadliest tsunami arrive in
 *                    red over durationS, nearest its source first
 *     opacity        { all, nonPacific, nonJapan }, each 0 to 1; they multiply
 *     rimSweepDeg    null, or how far in degrees the glow has travelled around the Pacific rim
 *     minHeightM     hide rings below this water height
 *     region         "all", "pacific" or "rest"
 *   setTime(step)    null shows all rings. A year from 684 to 2026 shows every ring up to the end
 *                    of that year, as the timeline would. { clockS, durationS } runs the record
 *                    over durationS seconds and shows clockS seconds of it. Add blendFromAll, 0 to
 *                    1, to fade from all rings down to that moment.
 *   renderAt(step)   optionally set the time, then draw right now, without waiting for the
 *                    browser's animation loop. Use this to step through time deterministically.
 *   shownRings()     the indices of the rings currently shown, in timeline order (by tsunami)
 *   ringFromPick(info), pickRing(x, y)   the ring index under a deck.gl pick or a screen point
 *   project(lon, lat)  screen position of a point, or null if it is on the far side of the globe
 *   camera, data, figures, deck   current camera, loaded data, key figures, the Deck instance
 */
export function createMap(container, options = {}) {
  const {
    camera: startCamera = {},
    width,
    height,
    pixelScale = 1,
    paddingBottomPx = 0,
    controller = false,
    pickable = false,
    useDevicePixels = true,
    layersUrl = "layers/",
    grainElement = null,
    onViewChange = null,
    deckProps = {},
    rimSweep = false,
  } = options;

  // A doubled pixel scale is one zoom level more: the globe doubles in size on screen. Ring sizes
  // keep following the camera's own zoom and are scaled separately, so the picture stays the same.
  const zoomOffset = Math.log2(pixelScale);
  let camera = { longitude: 0, latitude: 0, zoom: 1, pitch: 0, bearing: 0, ...startCamera };
  let layers = { ...DEFAULT_LAYERS, opacity: { ...DEFAULT_LAYERS.opacity } };
  let time = null;
  let data = null;
  let figures = null;
  let landPolygons = null;
  let buffers = null;
  let count = 0;
  let needsFlush = true;
  let flushQueued = false;
  let deckLoaded;
  const deckLoad = new Promise((resolve) => {
    deckLoaded = resolve;
  });

  const deckViewState = () => ({ ...camera, zoom: camera.zoom + zoomOffset });

  const deck = new Deck({
    parent: container,
    ...(width && height ? { width, height } : {}),
    useDevicePixels,
    views: new GlobeView({
      id: "globe",
      ...(paddingBottomPx ? { padding: { bottom: paddingBottomPx } } : {}),
      clear: true,
      clearColor: [...INDIGO, 255],
      resolution: 5,
    }),
    viewState: deckViewState(),
    controller,
    layers: [],
    onLoad: () => deckLoaded(),
    onViewStateChange: ({ viewState }) => {
      camera = { ...camera, ...viewState, zoom: viewState.zoom - zoomOffset };
      deck.setProps({ viewState: deckViewState() });
      onViewChange?.(camera);
    },
    ...deckProps,
  });

  function redItems() {
    const { rings } = data;
    const shown = layers.highlights.some((h) => h.onlyIfShown)
      ? new Set(buffers.ringIndex.subarray(0, count))
      : null;
    const items = [];
    for (const { index, pulse = 0, minRadiusPx = 0, onlyIfShown = false } of layers.highlights) {
      if (onlyIfShown && !shown.has(index)) continue;
      const baseR = ringRadiusPx(rings.runup_m[index], camera.zoom) * pixelScale;
      // At its peak a pulsing ring is 30% bigger and at least 16 px in radius, so a 3 m ring from
      // the year 684 can still be found on a whole-Pacific view.
      const peak = Math.max(baseR * 1.3, 16 * pixelScale);
      const radiusPx = Math.max(minRadiusPx * pixelScale, baseR + (peak - baseR) * pulse);
      items.push({
        lon: rings.lon[index],
        lat: rings.lat[index],
        alpha: 1,
        radiiPx: [radiusPx, radiusPx, radiusPx],
      });
    }
    if (layers.spreadEvent) {
      const { clockS, durationS } = layers.spreadEvent;
      const spreadS = durationS - SETTLE_S;
      for (const index of data.highlights.deadliest.event_rings) {
        const ageS = clockS - data.eventArrival[index] * spreadS;
        if (ageS < 0) continue;
        const baseR = ringRadiusPx(rings.runup_m[index], camera.zoom) * pixelScale;
        items.push({
          lon: rings.lon[index],
          lat: rings.lat[index],
          // 1,991 rings pile up on a few coasts. Thin ink keeps them readable as rings there.
          alpha: Math.max(0.1, Math.exp(-0.5 * data.logDensity[index])),
          radiiPx: STROKE_SCALES.map((_, stroke) => baseR * growth(ageS, stroke)),
        });
      }
    }
    return items;
  }

  function buildLayers() {
    const { rings } = data;
    const built = baseLayers(layers.graticule, pixelScale, landPolygons, layers.land);
    if (layers.rings) built.push(...ringLayers(buffers, count, pixelScale, pickable));
    if (layers.columns) {
      const scale = layers.columns.exaggeration * layers.columns.rise;
      built.push(columnLayer(buffers, count, scale, pixelScale, pickable));
    }
    built.push(capLayer(camera, height ?? window.innerHeight));

    const red = redItems();
    if (red.length > 0) built.push(...redRingLayers("highlights", red, pixelScale));

    if (layers.columns) {
      for (const { index, column } of layers.highlights) {
        if (!column) continue;
        built.push(
          new ColumnLayer({
            id: `highlight-column-${index}`,
            data: [index],
            getPosition: (i) => [rings.lon[i], rings.lat[i]],
            getElevation: (i) => rings.runup_m[i],
            getFillColor: RED,
            diskResolution: 12,
            radius: COLUMN_RADIUS_PX * 2 * pixelScale,
            radiusUnits: "pixels",
            extruded: true,
            material: false,
            elevationScale: layers.columns.exaggeration * layers.columns.rise,
            parameters: HIGHLIGHT_BLEND,
          }),
        );
      }
    }
    return built;
  }

  // The setters can come in any number and order, so the heavy work waits until something needs
  // the result: the end of this task, or a call that reads or draws. A loop over 29,340 rings is
  // then done once per picture, not once per setter.
  function flush() {
    if (!needsFlush || !data) return;
    needsFlush = false;
    const blending = time !== null && time.blendFromAll !== undefined;
    count = fillRings(data, buffers, {
      zoom: camera.zoom,
      pixelScale,
      clockS: time !== null && !blending ? time.clockS : null,
      durationS: time !== null && !blending ? time.durationS : 1,
      minHeightM: layers.minHeightM,
      region: layers.region,
      opacity: layers.opacity,
      sweepDeg: layers.rimSweepDeg ?? -1,
      hasSweep: layers.rimSweepDeg !== null,
      loopBack: blending
        ? { progress: time.blendFromAll, clockS: time.clockS, durationS: time.durationS }
        : null,
      hideEvent: Boolean(layers.spreadEvent),
      // A ring drawn in red is not also lit in foam underneath.
      muted: new Set(layers.highlights.map((h) => h.index)),
    });
    deck.setProps({ viewState: deckViewState(), layers: buildLayers() });
  }

  // A year is turned into a moment on the timeline: the share where the next year's first tsunami
  // starts. Rings before it are shown at full size (their age is far past SETTLE_S, because the run
  // is long), the next year's are not born yet. The brightness follows the share, as on the page.
  const YEAR_RUN_S = 10000;
  function timeAtYearEnd(year) {
    if (!data) throw new Error("setTime(year) needs the data: await map.ready first");
    if (!(year >= 684 && year <= 2026)) throw new RangeError(`year ${year} is not in 684 to 2026`);
    let share = 1 + 1 / data.n;
    for (let i = 0; i < data.n; i += 1) {
      if (data.rings.year[i] > year) {
        share = data.t[i];
        break;
      }
    }
    return { clockS: share * YEAR_RUN_S, durationS: YEAR_RUN_S };
  }

  function requestFlush() {
    needsFlush = true;
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      flush();
    });
  }

  const ready = (async () => {
    const names = ["rings", "highlights", "figures", "land"];
    if (rimSweep) names.push("ring_of_fire_order");
    const [rings, highlights, loadedFigures, land, rimOrder = null] = await Promise.all(
      names.map((name) => fetchJson(layersUrl, `${name}.json`)),
    );
    data = buildRingData(rings, highlights, rimOrder);
    figures = loadedFigures;
    landPolygons = land;
    buffers = makeBuffers(data.n);
    await Promise.all([
      grainElement ? paintGrain(grainElement) : null,
      document.fonts.load('400 14px "Shippori Mincho B1"'),
      document.fonts.load('800 26px "Shippori Mincho B1"'),
      document.fonts.load('400 13px "IBM Plex Mono"'),
      document.fonts.load('500 13px "IBM Plex Mono"'),
      deckLoad,
    ]);
    requestFlush();
  })();

  return {
    ready,
    setView(view) {
      camera = { ...camera, ...view };
      requestFlush();
    },
    setLayers(changes) {
      if (changes.rimSweepDeg != null && !rimSweep) {
        throw new Error("rimSweepDeg needs the rim order: create the map with rimSweep: true");
      }
      layers = { ...layers, ...changes, opacity: { ...layers.opacity, ...changes.opacity } };
      requestFlush();
    },
    setTime(step) {
      time = typeof step === "number" ? timeAtYearEnd(step) : step;
      requestFlush();
    },
    renderAt(step) {
      if (step !== undefined) time = step;
      needsFlush = true;
      flush();
      deck.layerManager.updateLayers();
      deck.redraw("renderAt");
    },
    shownRings() {
      flush();
      return buffers.ringIndex.subarray(0, count);
    },
    ringFromPick(info) {
      if (!info.layer || info.index < 0) return null;
      return buffers.ringIndex[info.index];
    },
    pickRing(x, y) {
      const info = deck.pickObject({ x, y, radius: PICK_RADIUS_PX });
      return info ? this.ringFromPick(info) : null;
    },
    project(lon, lat) {
      const viewport = deck.viewManager ? deck.getViewports()[0] : null;
      if (!viewport) return null;
      // The point is on the near side if its surface normal points toward the camera.
      const lonRad = (lon * Math.PI) / 180;
      const latRad = (lat * Math.PI) / 180;
      const normal = [
        Math.sin(lonRad) * Math.cos(latRad),
        -Math.cos(lonRad) * Math.cos(latRad),
        Math.sin(latRad),
      ];
      const toCamera = viewport.cameraPosition.map((v, k) => v - normal[k] * GLOBE_RADIUS_COMMON);
      if (normal[0] * toCamera[0] + normal[1] * toCamera[1] + normal[2] * toCamera[2] <= 0) {
        return null;
      }
      return viewport.project([lon, lat]);
    },
    get camera() {
      return camera;
    },
    get data() {
      return data;
    },
    get figures() {
      return figures;
    },
    deck,
  };
}
