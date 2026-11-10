/* The map of every Roman road, drawn outward from Rome on a globe, and a small API to drive it.

   What it does: builds the map from the local layers, with the paper texture and the HTML labels,
   and nothing else. The title, key, figures and controls of the public page live in app.js and
   ui.js, on top of the API below.
   Reads:  maps/layers/ (written by maps/prepare.py).
   Run:    npm run dev   (from the piece folder; npm run build writes the static site to maps/dist/)

   What you learn: how to build a map style with no tile server at all, how one number on every
   line (`d`, the network distance from Rome) can drive a whole animation through a filter, and
   how to generate paper texture from a fixed seed so a plate looks the same on every load.

   I use MapLibre GL JS because it renders GeoJSON lines and polygons on a real 3D globe with
   rotate, tilt and zoom, it needs no tile server and no API key, and setFilter and
   setPaintProperty give me exact control of every frame.

   Script your own views. I export a small API, so you can drive this map from your own page:

     import { createMap, ready, renderAt, setLayers, setTime, setView } from "./main.js";

     createMap(document.getElementById("plate"));   // build the map inside this element
     await ready;                                   // style, layers and fonts are all in
     setLayers({ land: true, sea: true, coast_ripples: true, roads_main: true, rome_marker: true });
     setTime(1500);                                 // only roads within 1,500 km of Rome
     setView({ center: [12.5, 41.9], zoom: 5, pitch: 40, bearing: -15 });
     await renderAt();                              // resolves once the picture is finished

   Every call is instant (no animation, no clock), so a page that wants a film calls them once per
   frame with its own easing, and the same frame always comes out the same. */

import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import "maplibre-gl/dist/maplibre-gl.css";
import "@fontsource/cinzel/600.css";
import "@fontsource/cinzel/700.css";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/400-italic.css";
import "@fontsource/source-serif-4/600.css";

/** The six inks of the plate. */
export const PARCHMENT = "#EFE4C8";
export const VERDIGRIS = "#C3CEC4";
export const INK_BLUE = "#4F6E78";
export const RUBRIC = "#9A2F1F";
export const SEPIA = "#8F7348";
export const IRON_GALL = "#2A2118";
const IRON_GALL_RGB = [42, 33, 24];
const SEPIA_RGB = [143, 115, 72];

/* I find the layers from this script's own address, not the page's. The page can be opened at any
   path (a dev server answers /maps/ or /index.html/ with the same page, and then every path
   relative to the page points nowhere), but the script always knows where it lives. In
   development it sits next to layers/; in the build Vite moves it into assets/, one level down.
   Both stay relative, so the build still works in a GitHub Pages subfolder. */
const LAYER_BASE = new URL(
  import.meta.env.DEV ? "./layers/" : "../layers/",
  import.meta.url,
);
/** The address of one file in maps/layers/, for a page that wants to read a layer itself. */
export const layerUrl = (name) => new URL(name, LAYER_BASE).href;

// MapLibre fetches tiles by URL. The pmtiles:// protocol turns a tile request into a byte-range
// request into the one archive file, which GitHub Pages serves like any other file.
maplibregl.addProtocol("pmtiles", new Protocol().tile);

/** The whole plate from above: the view the public page opens on. */
export const FULL_PLATE = {
  center: [17.0, 40.0],
  zoom: 3.3,
  pitch: 0,
  bearing: 0,
};
const TEXTURE_SEED = 1966;
const FOXING_SPOTS = 70;

// Widths are given at the full-plate view and grow with zoom, so the two road types differ by
// weight as well as hue. Someone who cannot tell red from brown can still read the map.
const ROAD_WIDTH_PX = { 1: 1.6, 2: 0.6 };
const ZOOM_GROWTH = 2.4;
const PLATE_ZOOM = 3.3;
const CLOSE_ZOOM = 7;
const CERTAINTY_DASH = { 1: null, 2: [3, 2], 3: [0.5, 1.5] };

async function fetchJson(name) {
  const response = await fetch(layerUrl(name));
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.json();
}

/* ---- road width and filter expressions ---- */

function zoomWidth(widthAtPlate) {
  return [
    "interpolate",
    ["exponential", 1.4],
    ["zoom"],
    PLATE_ZOOM,
    widthAtPlate,
    CLOSE_ZOOM,
    widthAtPlate * ZOOM_GROWTH,
  ];
}

function zoomWidthByType() {
  const byType = (factor) => [
    "case",
    ["==", ["get", "t"], 1],
    ROAD_WIDTH_PX[1] * factor,
    ROAD_WIDTH_PX[2] * factor,
  ];
  return [
    "interpolate",
    ["exponential", 1.4],
    ["zoom"],
    PLATE_ZOOM,
    byType(1),
    CLOSE_ZOOM,
    byType(ZOOM_GROWTH),
  ];
}

/* ---- the style: only local sources, no tiles, no glyphs, no sprite ---- */

export function roadLayer(id, color, type) {
  return {
    id,
    type: "line",
    source: "roads",
    "source-layer": "roads",
    filter: ["==", ["get", "t"], type],
    paint: {
      "line-color": color,
      "line-width": zoomWidth(ROAD_WIDTH_PX[type]),
      "line-blur": 0.5, // the slight bleed of ink into paper
    },
  };
}

function certaintyLayer(certainty) {
  const dash = CERTAINTY_DASH[certainty];
  return {
    id: `roads_certainty_${certainty}`,
    type: "line",
    source: "roads",
    "source-layer": "certainty",
    filter: ["==", ["get", "c"], certainty],
    layout: {
      visibility: "none",
      "line-cap": certainty === 3 ? "round" : "butt",
    },
    paint: {
      "line-color": ["case", ["==", ["get", "t"], 1], RUBRIC, SEPIA],
      "line-width": zoomWidthByType(),
      "line-blur": 0.5,
      ...(dash ? { "line-dasharray": dash } : {}),
    },
  };
}

/* MapLibre has no paint property for "only inside this part of the screen", so for the sweeping
   flight I draw the roads a second time between two small custom layers that switch on the GPU's
   scissor test. Whatever falls inside the rectangle gets drawn twice and reads at full strength. */
function scissorLayer(id, getBand) {
  return {
    id,
    type: "custom",
    renderingMode: "2d",
    render(gl) {
      const band = getBand();
      if (!band) {
        gl.disable(gl.SCISSOR_TEST);
        return;
      }
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, band.y, gl.drawingBufferWidth, band.height);
    },
  };
}

function buildStyle() {
  const geojson = (name, options = {}) => ({
    type: "geojson",
    data: layerUrl(name),
    maxzoom: 9, // the piece has no detail worth tiling deeper
    tolerance: 0.3,
    ...options,
  });
  return {
    version: 8,
    projection: { type: "globe" },
    sources: {
      // The plate's land, coast, water lines, lakes and rivers: vector tiles too, in their own
      // archive, so the first frame never waits for the whole of Natural Earth to be indexed.
      plate: { type: "vector", url: `pmtiles://${layerUrl("plate.pmtiles")}` },
      graticule: geojson("graticule.geojson"),
      // The roads as vector tiles in one PMTiles archive: the browser reads only the tiles on
      // screen, with range requests, so the map never waits for all 107,603 road pieces.
      roads: { type: "vector", url: `pmtiles://${layerUrl("roads.pmtiles")}` },
      rome: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },
      hover: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },
    },
    // Instant changes only: a timed fade would make a frame depend on the wall clock.
    transition: { duration: 0, delay: 0 },
    layers: [
      {
        id: "sea",
        type: "background",
        paint: { "background-color": VERDIGRIS },
      },
      {
        id: "land",
        type: "fill",
        source: "plate",
        "source-layer": "land",
        paint: { "fill-color": PARCHMENT },
      },
      {
        id: "coast_ripples",
        type: "line",
        source: "plate",
        "source-layer": "coast_ripples",
        paint: {
          "line-color": INK_BLUE,
          "line-width": zoomWidth(0.5),
          "line-opacity": ["get", "o"],
        },
      },
      {
        id: "coast",
        type: "line",
        source: "plate",
        "source-layer": "coast",
        paint: { "line-color": INK_BLUE, "line-width": zoomWidth(0.8) },
      },
      {
        id: "lakes",
        type: "fill",
        source: "plate",
        "source-layer": "lakes",
        paint: { "fill-color": VERDIGRIS },
      },
      {
        id: "lakes_outline",
        type: "line",
        source: "plate",
        "source-layer": "lakes",
        paint: { "line-color": INK_BLUE, "line-width": zoomWidth(0.5) },
      },
      {
        id: "rivers",
        type: "line",
        source: "plate",
        "source-layer": "rivers",
        paint: { "line-color": INK_BLUE, "line-width": zoomWidth(0.6) },
      },
      {
        id: "graticule",
        type: "line",
        source: "graticule",
        paint: {
          "line-color": IRON_GALL,
          "line-width": 0.4,
          "line-opacity": 0.4,
        },
      },
      roadLayer("roads_secondary", SEPIA, 2),
      roadLayer("roads_main", RUBRIC, 1),
      certaintyLayer(1),
      certaintyLayer(2),
      certaintyLayer(3),
      {
        id: "hover",
        type: "line",
        source: "hover",
        paint: { "line-color": RUBRIC, "line-width": zoomWidth(3.2) },
      },
      {
        id: "rome_marker",
        type: "circle",
        source: "rome",
        paint: {
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": RUBRIC,
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            PLATE_ZOOM,
            5,
            CLOSE_ZOOM,
            10,
          ],
          "circle-stroke-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            PLATE_ZOOM,
            1.6,
            CLOSE_ZOOM,
            2.6,
          ],
        },
      },
    ],
  };
}

/* ---- paper: seeded so the plate looks the same on every load ---- */

// mulberry32: a tiny seeded random number generator. Math.random would change on every load.
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function paintGrain(canvas, widthPx, heightPx) {
  canvas.width = widthPx;
  canvas.height = heightPx;
  const context = canvas.getContext("2d");
  const image = context.createImageData(widthPx, heightPx);
  const random = seededRandom(TEXTURE_SEED);
  // Two scales of noise: fine tooth in every pixel, plus a soft fibre blended across a 6 px grid.
  const cellPx = 6;
  const columns = Math.ceil(widthPx / cellPx) + 2;
  const rows = Math.ceil(heightPx / cellPx) + 2;
  const coarse = new Float32Array(columns * rows).map(() => random());
  for (let y = 0; y < heightPx; y += 1) {
    const rowF = y / cellPx;
    const row = Math.floor(rowF);
    const v = rowF - row;
    for (let x = 0; x < widthPx; x += 1) {
      const colF = x / cellPx;
      const col = Math.floor(colF);
      const u = colF - col;
      const top =
        coarse[row * columns + col] * (1 - u) +
        coarse[row * columns + col + 1] * u;
      const below =
        coarse[(row + 1) * columns + col] * (1 - u) +
        coarse[(row + 1) * columns + col + 1] * u;
      const fibre = top * (1 - v) + below * v;
      const alpha = 0.3 * random() + 0.2 * fibre;
      const offset = (y * widthPx + x) * 4;
      image.data[offset] = IRON_GALL_RGB[0];
      image.data[offset + 1] = IRON_GALL_RGB[1];
      image.data[offset + 2] = IRON_GALL_RGB[2];
      image.data[offset + 3] = Math.round(255 * alpha);
    }
  }
  context.putImageData(image, 0, 0);
}

function paintFoxing(canvas, widthPx, heightPx) {
  canvas.width = widthPx;
  canvas.height = heightPx;
  const context = canvas.getContext("2d");
  const random = seededRandom(TEXTURE_SEED + 1);
  const [r, g, b] = SEPIA_RGB;
  const edgeBandPx = Math.min(widthPx, heightPx) * 0.09;
  for (let spot = 0; spot < FOXING_SPOTS; spot += 1) {
    // Foxing starts where damp gets in, so the spots keep to a band along the plate's edge.
    const along = random();
    const across = random() ** 2 * edgeBandPx;
    const side = Math.floor(random() * 4);
    const x =
      side < 2 ? along * widthPx : side === 2 ? across : widthPx - across;
    const y =
      side === 0 ? across : side === 1 ? heightPx - across : along * heightPx;
    const radiusPx = 2 + random() ** 3 * 18;
    const strength = 0.08 + random() * 0.17;
    const blot = context.createRadialGradient(x, y, 0, x, y, radiusPx);
    blot.addColorStop(0, `rgb(${r} ${g} ${b} / ${strength})`);
    blot.addColorStop(1, `rgb(${r} ${g} ${b} / 0)`);
    context.fillStyle = blot;
    context.beginPath();
    context.arc(x, y, radiusPx, 0, Math.PI * 2);
    context.fill();
  }
}

/* ---- labels: HTML elements, so Cinzel and Source Serif 4 render exactly ---- */

const LABEL_ALIGN = {
  ROMA: { ax: 0, ay: -1, dx: 12, dy: -6 },
  "HADRIAN'S WALL": { ax: 0, ay: -1, dx: 8, dy: -4 },
  BRITANNIA: { ax: -1, ay: 0, dx: -8, dy: 0 },
  NILE: { ax: 0, ay: -0.5, dx: 8, dy: 0 },
  AEGYPTUS: { ax: -1, ay: 0, dx: -8, dy: 0 },
};

function createPlaceLabels(places, element) {
  const holder = element.querySelector("#place-labels");
  const labels = new Map();
  for (const place of places.labels) {
    const element = document.createElement("div");
    element.className = `place-label${place.name === "ROMA" ? " roma" : ""}`;
    element.textContent = place.name;
    holder.append(element);
    labels.set(place.name, { ...place, element, ...LABEL_ALIGN[place.name] });
  }
  return labels;
}

// Screen-space rectangle a label should stay inside; `scale` makes the offsets work at any size.
// A label may slide this share of its width to stay inside the map. Further than that it would
// no longer sit on its place, so it is hidden instead.
const LABEL_NUDGE_SHARE = 0.4;
const LABEL_EDGE_PX = 8;

export function positionLabel(
  map,
  label,
  { opacity = 1, rise = 0, scale = 1, safe = null, inset = null },
) {
  const { element } = label;
  if (
    opacity <= 0 ||
    map.transform.isLocationOccluded(
      new maplibregl.LngLat(label.lon, label.lat),
    )
  ) {
    element.style.display = "none";
    return;
  }
  const point = map.project([label.lon, label.lat]);
  element.style.display = "block";
  const { offsetWidth: width, offsetHeight: height } = element;
  let x = point.x + label.dx * scale + label.ax * width;
  const y = point.y + label.dy * scale + label.ay * height - rise;
  if (inset !== null) {
    // The public map keeps every name at least `inset` px inside its edges: a name cut off at the
    // edge reads as a mistake. A small slide keeps it near its place; a big one would mislead.
    const mapWidth = map.getContainer().clientWidth;
    const inside = Math.max(inset, Math.min(mapWidth - inset - width, x));
    if (Math.abs(inside - x) > width * LABEL_NUDGE_SHARE) {
      element.style.display = "none";
      return;
    }
    x = inside;
  }
  let edgeFade = 1;
  if (safe) {
    // Fading before the edge means a label never crosses out of the safe box during a flight.
    const room = Math.min(
      x - safe.left,
      safe.right - x - width,
      y - safe.top,
      safe.bottom - y - height,
    );
    edgeFade = Math.max(0, Math.min(1, room / (40 * scale)));
  }
  element.style.opacity = opacity * edgeFade;
  element.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
  element.style.visibility = opacity * edgeFade > 0 ? "visible" : "hidden";
}

/* ---- degree labels: the engraved margin of the plate ----

   An atlas plate prints its degrees in the margin, where each graticule line meets the neatline:
   latitudes down the left side, longitudes along the foot. I do the same, so a figure always sits
   at the end of its own line and never floats on the map or on the curved edge of the globe. */

// A thin space between the degree and the hemisphere, as engravers set it: "25° N".
const THIN_SPACE = " ";
// Nothing within this distance of a corner: there both rows of figures would meet and crowd, and a
// printed plate leaves its corners empty.
const DEGREE_CORNER_PX = 72;
// A line that meets the border at a shallow angle crosses it over a long stretch, so a label put
// "at the crossing" would drift away from the line it names. Below this angle I leave it out.
const DEGREE_MIN_ANGLE = 35;
const DEGREE_MIN_GAP_PX = 56;
const DEGREE_INSET_PX = 6;
// The neatline is a 2 px rule with a thin rule 6 px inside it (#plate-border in style.css). The
// labels hang off the inner rule, the one that frames the map.
const NEATLINE_INNER_PX = 6;
// On a tilted view the lines run almost along the frame and the margin no longer frames a flat
// plate, so the figures go.
const DEGREE_MAX_PITCH = 20;

function degreeText(kind, deg) {
  if (deg === 0) return "0°";
  const letter = kind === "meridian" ? (deg < 0 ? "W" : "E") : "N";
  return `${Math.abs(deg)}°${THIN_SPACE}${letter}`;
}

/* One label per graticule line, placed on the plate border by positionDegreeLabels below. */
function createDegreeLabels(graticule, element) {
  const holder = element.querySelector("#degree-labels");
  return graticule.features.map((feature) => {
    const element = document.createElement("div");
    element.className = "degree-label";
    element.textContent = degreeText(
      feature.properties.kind,
      feature.properties.deg,
    );
    holder.append(element);
    return {
      element,
      kind: feature.properties.kind,
      deg: feature.properties.deg,
      coordinates: feature.geometry.coordinates,
    };
  });
}

/* Where the projected line first crosses the border segment, as a position along that edge, or
   null. `vertical` is the left edge (x = at), otherwise the bottom edge (y = at); [from, to] is the
   edge's extent. Hidden parts of the line (behind the globe) break it, so a line that ends at the
   globe's edge before the border never crosses it. */
function borderCrossing(map, coordinates, vertical, at, from, to) {
  let previous = null;
  for (const lonLat of coordinates) {
    if (
      map.transform.isLocationOccluded(
        new maplibregl.LngLat(lonLat[0], lonLat[1]),
      )
    ) {
      previous = null;
      continue;
    }
    const point = map.project(lonLat);
    if (previous) {
      const [a, b] = vertical ? [previous.x, point.x] : [previous.y, point.y];
      if ((a - at) * (b - at) <= 0 && a !== b) {
        const t = (at - a) / (b - a);
        const along = vertical
          ? previous.y + t * (point.y - previous.y)
          : previous.x + t * (point.x - previous.x);
        const dx = Math.abs(point.x - previous.x);
        const dy = Math.abs(point.y - previous.y);
        // The angle between the line and the border it crosses.
        const angle =
          (Math.atan2(vertical ? dx : dy, vertical ? dy : dx) * 180) / Math.PI;
        if (along >= from && along <= to)
          return angle >= DEGREE_MIN_ANGLE ? along : null;
      }
    }
    previous = point;
  }
  return null;
}

const overlaps = (a, b, gap = 2) =>
  a.left < b.right + gap &&
  b.left < a.right + gap &&
  a.top < b.bottom + gap &&
  b.top < a.bottom + gap;

/** The box of an element relative to the map area, or null when it is not shown. */
function boxIn(stage, element) {
  if (!element || element.offsetParent === null) return null;
  if (getComputedStyle(element).visibility === "hidden") return null;
  const r = element.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  const s = stage.getBoundingClientRect();
  return {
    left: r.left - s.left,
    right: r.right - s.left,
    top: r.top - s.top,
    bottom: r.bottom - s.top,
  };
}

/**
 * Place the degree labels in the plate's margin. `opacity` scales them (0 hides them); `obstacles`
 * are elements whose boxes a label may never cover (the title, the buttons, the credit line). The
 * map's own place names count as obstacles too. Call it after every camera change.
 */
export function positionDegreeLabels(
  map,
  degreeLabels,
  opacity,
  { obstacles = [] } = {},
) {
  const holder = degreeLabels[0]?.element.parentElement;
  if (!holder) return;
  const stage = map.getContainer().parentElement;
  const visible = opacity > 0 && map.getPitch() <= DEGREE_MAX_PITCH;
  // Opacity, not display: the public page fades it (style.css); a page can also set it at once.
  holder.style.opacity = visible ? String(opacity) : "0";
  if (!visible) return;

  const neatline = boxIn(stage, stage.querySelector("#plate-border"));
  if (!neatline) return;
  const border = {
    left: neatline.left + NEATLINE_INNER_PX,
    right: neatline.right - NEATLINE_INNER_PX,
    top: neatline.top + NEATLINE_INNER_PX,
    bottom: neatline.bottom - NEATLINE_INNER_PX,
  };
  const blocked = [
    ...obstacles.map((element) => boxIn(stage, element)),
    ...[...stage.querySelectorAll(".place-label")].map((element) =>
      boxIn(stage, element),
    ),
  ].filter(Boolean);

  // Every crossing outside the corner zones, per edge.
  const edges = { left: [], bottom: [] };
  for (const label of degreeLabels) {
    label.element.style.visibility = "hidden";
    const onLeft = label.kind === "parallel";
    const along = onLeft
      ? borderCrossing(
          map,
          label.coordinates,
          true,
          border.left,
          border.top + DEGREE_CORNER_PX,
          border.bottom - DEGREE_CORNER_PX,
        )
      : borderCrossing(
          map,
          label.coordinates,
          false,
          border.bottom,
          border.left + DEGREE_CORNER_PX,
          border.right - DEGREE_CORNER_PX,
        );
    if (along !== null)
      edges[onLeft ? "left" : "bottom"].push({ label, along });
  }

  const placed = [];
  for (const [edge, crossings] of Object.entries(edges)) {
    crossings.sort((a, b) => a.along - b.along);
    // Labels closer than 56 px read as one smudge. If any pair is that close I keep every second
    // line (10 degrees instead of 5), and then every fourth, until they have room.
    let step = 5;
    let kept = crossings;
    const crowded = (list) =>
      list.some(
        (c, i) => i > 0 && c.along - list[i - 1].along < DEGREE_MIN_GAP_PX,
      );
    while (crowded(kept) && step < 40) {
      step *= 2;
      kept = crossings.filter((c) => Math.abs(c.label.deg) % step === 0);
    }
    for (const { label, along } of kept) {
      const width = label.element.offsetWidth;
      const height = label.element.offsetHeight;
      const left =
        edge === "left" ? border.left + DEGREE_INSET_PX : along - width / 2;
      const top =
        edge === "left"
          ? along - height / 2
          : border.bottom - DEGREE_INSET_PX - height;
      const box = { left, right: left + width, top, bottom: top + height };
      // The first label to claim a spot keeps it; a later one that would touch it, a place name or
      // the furniture is left out.
      if (
        blocked.some((b) => overlaps(box, b)) ||
        placed.some((b) => overlaps(box, b))
      )
        continue;
      placed.push(box);
      label.element.style.transform = `translate(${left.toFixed(2)}px, ${top.toFixed(2)}px)`;
      label.element.style.visibility = "visible";
    }
  }
}

/* ---- small helper that only touches MapLibre when a value really changes ---- */

/* A filter change makes the worker re-cut every visible tile, so repeating one for no reason is
   the most expensive no-op on this page. Remembering the last value avoids it. */
function createLayerWriter(map) {
  const seen = new Map();
  const changed = (key, value) => {
    const text = JSON.stringify(value);
    if (seen.get(key) === text) return false;
    seen.set(key, text);
    return true;
  };
  return {
    filter(layer, filter) {
      if (changed(`f:${layer}`, filter)) map.setFilter(layer, filter);
    },
    paint(layer, property, value) {
      if (changed(`p:${layer}:${property}`, value))
        map.setPaintProperty(layer, property, value);
    },
    visible(layer, isVisible) {
      const value = isVisible ? "visible" : "none";
      if (changed(`v:${layer}`, value))
        map.setLayoutProperty(layer, "visibility", value);
    },
  };
}

/* ---- the road state: the controls and any page using the API write to it ---- */

function createRoads(map, write) {
  const state = {
    drawKm: 0,
    types: [1, 2],
    classes: [1, 2, 3],
    solidOpacity: 1, // the two solid layers
    solidAfterKm: -1, // hide solid roads closer than this (the certainty ripple has passed them)
    patternToKm: -1, // show patterned roads up to this distance, -1 for none
    patternOpacity: 1,
    farOpacity: 1, // opacity of roads over nearKm from Rome
    nearKm: 100,
    focus: false,
    focusBaseOpacity: 1,
  };

  const opacity = (base) => {
    if (state.farOpacity >= 1) return base;
    return [
      "case",
      ["<=", ["get", "d"], state.nearKm],
      base,
      base * state.farOpacity,
    ];
  };

  function solidFilter(type) {
    const clauses = [
      ["==", ["get", "t"], type],
      ["<=", ["get", "d"], state.drawKm],
      ["in", ["get", "c"], ["literal", state.classes]],
    ];
    if (state.solidAfterKm >= 0)
      clauses.push([">", ["get", "d"], state.solidAfterKm]);
    return ["all", ...clauses];
  }

  function apply() {
    for (const [layer, type] of [
      ["roads_main", 1],
      ["roads_secondary", 2],
    ]) {
      const filter = solidFilter(type);
      write.filter(layer, filter);
      write.visible(layer, state.types.includes(type));
      write.paint(
        layer,
        "line-opacity",
        opacity(state.solidOpacity * state.focusBaseOpacity),
      );
      if (map.getLayer(`${layer}_focus`)) {
        write.visible(
          `${layer}_focus`,
          state.focus && state.types.includes(type),
        );
        if (state.focus) write.filter(`${layer}_focus`, filter);
      }
    }
    for (const certainty of [1, 2, 3]) {
      const layer = `roads_certainty_${certainty}`;
      const shown = state.patternToKm >= 0 && state.classes.includes(certainty);
      write.visible(layer, shown);
      if (shown) {
        write.filter(layer, [
          "all",
          ["==", ["get", "c"], certainty],
          ["<=", ["get", "d"], Math.min(state.patternToKm, state.drawKm)],
          ["in", ["get", "t"], ["literal", state.types]],
        ]);
        write.paint(layer, "line-opacity", opacity(state.patternOpacity));
      }
    }
  }

  return { state, apply };
}

/* The focus layers are copies of the solid roads held between the two scissor layers. */
function addFocusLayers(map, getBand) {
  const before = "roads_certainty_1";
  map.addLayer(scissorLayer("scissor_on", getBand), before);
  for (const [id, color, type] of [
    ["roads_secondary_focus", SEPIA, 2],
    ["roads_main_focus", RUBRIC, 1],
  ]) {
    map.addLayer(
      { ...roadLayer(id, color, type), layout: { visibility: "none" } },
      before,
    );
  }
  map.addLayer(
    scissorLayer("scissor_off", () => null),
    before,
  );
}

/* ---- start up ---- */

async function loadFonts() {
  await Promise.all(
    [
      "600 20px Cinzel",
      "700 20px Cinzel",
      '400 20px "Source Serif 4"',
      'italic 400 20px "Source Serif 4"',
      '600 20px "Source Serif 4"',
    ].map((font) => document.fonts.load(font, "ROMA 0123456789")),
  );
  await document.fonts.ready;
}

/* The map area holds the map, its HTML labels and the paper above them, in this order. A page can
   write these elements itself (index.html does, so its CSS can place them); createMap adds any
   that are missing. */
const LAYERS_OF_THE_STAGE = [
  ["div", "map"],
  ["div", "degree-labels"],
  ["div", "place-labels"],
  ["canvas", "grain", "texture"],
  ["canvas", "foxing", "texture"],
  ["div", "vignette", "texture"],
  ["div", "plate-mark", "texture"],
  ["div", "plate-border", "texture"],
];

function ensureStage(container) {
  for (const [tag, id, className] of LAYERS_OF_THE_STAGE) {
    if (container.querySelector(`#${id}`)) continue;
    const element = document.createElement(tag);
    element.id = id;
    if (className) element.className = className;
    if (id !== "map") element.setAttribute("aria-hidden", "true");
    container.append(element);
  }
}

/* After any change the globe keeps repainting for 0.7 s of clock time. On a software GPU a repaint
   call returns long before its pixels are done, so dozens of full renders would pile up behind
   each frame. Reading one pixel makes every repaint finish before the next one starts. */
function finishEveryRepaint(map) {
  const canvas = map.getCanvas();
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const onePixel = new Uint8Array(4);
  map.on("render", () =>
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, onePixel),
  );
}

async function build(container, options) {
  const element =
    typeof container === "string"
      ? document.getElementById(container)
      : container;
  if (!element) throw new Error("createMap needs an element to draw in");
  ensureStage(element);

  const [drawCurve, segments, places, graticule, figureList] =
    await Promise.all([
      fetchJson("draw_curve.json"),
      fetchJson("segments.json"),
      fetchJson("places.json"),
      fetchJson("graticule.geojson"),
      fetchJson("key_figures.json"),
    ]);
  const figures = new Map(figureList.map((figure) => [figure.id, figure]));
  await loadFonts();

  // The paper covers the map area only, painted at its size in pixels.
  const paintPaper = (
    width = element.clientWidth,
    height = element.clientHeight,
  ) => {
    paintGrain(element.querySelector("#grain"), width, height);
    paintFoxing(element.querySelector("#foxing"), width, height);
  };
  paintPaper();

  // The map stays out of sight until it is fully drawn: a visitor on a slow line sees the plate's
  // paper and frame, then the finished map in one step, never land and roads arriving tile by
  // tile. The canvas keeps rendering while hidden, so this costs no time.
  const mapElement = element.querySelector("#map");
  mapElement.style.visibility = "hidden";
  const map = new maplibregl.Map({
    container: mapElement,
    style: buildStyle(),
    ...(options.view ?? FULL_PLATE),
    ...(options.padding ? { padding: options.padding } : {}),
    attributionControl: false, // the page around the map credits the data
    fadeDuration: 0,
    interactive: options.interactive ?? true,
    // A phone screen at 3x would draw nine pixels for every CSS pixel. Two is as sharp as these
    // hairlines get, at less than half the work.
    pixelRatio: Math.min(2, window.devicePixelRatio || 1),
    // preserveDrawingBuffer lets a screenshot read the canvas between frames.
    canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
  });
  await new Promise((resolve, reject) => {
    map.once("load", () => resolve());
    map.once("error", (event) =>
      reject(event.error ?? new Error("the map failed to load")),
    );
  });
  if (options.deterministic) finishEveryRepaint(map);

  map.getSource("rome").setData({
    type: "FeatureCollection",
    features: places.labels
      .filter((place) => place.name === "ROMA")
      .map((place) => ({
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [place.lon, place.lat] },
      })),
  });

  const write = createLayerWriter(map);
  const roads = createRoads(map, write);
  roads.state.drawKm = drawCurve.max_draw_km;
  // A page that draws the roads with their certainty pattern from the start says so here, so the
  // first picture is already the final one and the tiles are never cut twice.
  if (options.roads === "pattern") {
    roads.state.patternToKm = drawCurve.max_draw_km;
    roads.state.solidOpacity = 0;
  }
  roads.apply();
  // Ready means drawn, not merely loaded: every start-view layer and its tiles are in and painted
  // (the map's idle event), two more animation frames have passed so that frame is on screen, and
  // every web font has arrived. Anything that animates waits for this, so nothing ever starts
  // moving over a half-drawn map.
  await new Promise((resolve) => {
    map.once("idle", () => resolve());
    map.triggerRepaint();
  });
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
  await document.fonts.ready;
  mapElement.style.visibility = "";
  const focusBand = { current: null };
  return {
    map,
    element,
    data: { drawCurve, segments, places, graticule, figures },
    write,
    roads,
    placeLabels: createPlaceLabels(places, element),
    degreeLabels: createDegreeLabels(graticule, element),
    paintPaper,
    // Draws the solid roads a second time inside a horizontal band of the frame, at full strength
    // over the rest: { y, height } in canvas pixels, or null for no band. See scissorLayer.
    setFocusBand(band) {
      if (!map.getLayer("scissor_on"))
        addFocusLayers(map, () => focusBand.current);
      focusBand.current = band;
      roads.state.focus = band !== null;
    },
  };
}

let current = null;
let resolveReady;
let rejectReady;

/**
 * Resolves with the map's handle once the start view is fully drawn: the style, every layer and
 * its tiles loaded and painted (the idle event), two animation frames later, and the fonts in:
 * { map, element, data, write, roads, placeLabels, degreeLabels, paintPaper, setFocusBand }.
 * `map` is the MapLibre map, `data` the small layers I fetched (draw curve, segments, places,
 * graticule, key figures). It is a promise, not an event, so a script can await it at any time.
 */
export const ready = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});

/**
 * Build the map inside a container (an element or its id). Returns the same promise as `ready`.
 *
 * options:
 *   view           the first camera: { center, zoom, pitch, bearing }. Default: FULL_PLATE.
 *   padding        room kept free on the map's edges, in px, for example { left: 150 }.
 *   roads          "solid" (default) or "pattern": draw the roads with their certainty pattern.
 *   interactive    whether the mouse moves the map. Default: true.
 *   deterministic  true when every frame must be finished before the next one is asked for (a
 *                  recorder taking screenshots, especially on a software GPU).
 *
 * main.js loads no stylesheet for the page around the map: bring your own (index.html gets
 * style.css, which also places the paper and the labels).
 */
export function createMap(container, options = {}) {
  build(container, options).then(
    (handle) => {
      current = handle;
      resolveReady(handle);
    },
    (error) => rejectReady(error),
  );
  return ready;
}

function needMap() {
  if (!current) throw new Error("call createMap and await ready first");
  return current;
}

/** Move the camera at once to { center, zoom, pitch, bearing }. Any of them can be left out. */
export function setView(camera) {
  needMap().map.jumpTo(camera);
}

/* The layer names a page can switch, and the style layers behind each of them. */
const LAYER_GROUPS = {
  sea: [],
  land: ["land"],
  coast_ripples: ["coast_ripples", "coast"],
  lakes: ["lakes", "lakes_outline"],
  rivers: ["rivers"],
  graticule: ["graticule"],
  rome_marker: ["rome_marker"],
};

/**
 * Say which layers are on. Anything you do not name goes off. Names: sea, land, coast_ripples (the
 * coast with its water lines), lakes, rivers, graticule, roads_main, roads_secondary,
 * roads_certainty (the roads drawn with their certainty pattern) and rome_marker.
 * Each value is true, or for graticule an object { opacity } (0 to 1).
 */
export function setLayers(layers) {
  const { map, write, roads } = needMap();
  for (const [name, styleLayers] of Object.entries(LAYER_GROUPS)) {
    for (const layer of styleLayers)
      write.visible(layer, Boolean(layers[name]));
  }
  // The sea is the map's background colour. Without it the paper behind the globe shows instead.
  write.paint("sea", "background-opacity", layers.sea ? 1 : 0);
  const graticuleOpacity = layers.graticule?.opacity ?? 1;
  write.paint("graticule", "line-opacity", 0.4 * graticuleOpacity);
  // Solid roads by type, or both types drawn with their certainty pattern instead.
  const solid = [layers.roads_main && 1, layers.roads_secondary && 2].filter(
    Boolean,
  );
  const pattern = Boolean(layers.roads_certainty);
  roads.state.types = solid.length ? solid : pattern ? [1, 2] : [];
  roads.state.solidOpacity = solid.length ? 1 : 0;
  roads.state.patternToKm = pattern ? Number.MAX_VALUE : -1;
  roads.apply();
  map.triggerRepaint();
}

/**
 * Draw the roads out to this network distance from Rome, in km: 0 is Rome alone, and
 * data.drawCurve.max_draw_km (8,871) is every road. This is the public map's "draw from Rome".
 */
export function setTime(km) {
  const { roads } = needMap();
  roads.state.drawKm = km;
  roads.apply();
}

/** Resolves when the map has finished drawing the current state: every tile cut and painted. */
export function renderAt() {
  const { map } = needMap();
  return new Promise((resolve) => {
    map.once("idle", () => resolve());
    map.triggerRepaint();
  });
}
