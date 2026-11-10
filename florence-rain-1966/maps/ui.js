/**
 * The furniture of the public map: title, key, figures, sources, buttons, hint and annotations.
 *
 * What it does: builds the interface in index.html on top of the public API in main.js. The map
 * itself knows nothing about any of this, so a script can draw clean views without it.
 * Reads:  layers/ (through createMap, plus two small counts and the Arno's extent)
 * Writes: nothing
 * Run:    npm run dev   (index.html loads this file)
 *
 * Why a separate file: main.js stays a small API that anyone can script. Everything here uses the
 * same calls a reader can use: createMap, setLayers and setTime.
 *
 * Not here, on purpose: a timeline. The data has no time dimension: it maps where water goes, not
 * when. And no before/after swipe, because there is no flooded-area layer to compare with.
 *
 * What you learn: how a river network's NEXT_DOWN links can answer "where does this drop go?" in the
 * browser, with no server, and how to set a key where each entry is the layer's own switch.
 */

import { createMap, setLayers, setTime } from "./main.js";
// After main.js, so that my rules come after MapLibre's own stylesheet.
import "./style.css";

const COTTO = "#9E3B26";
const PONTE_VECCHIO = [11.2531, 43.768];
const SMOOTH_ARNO_FROM_ZOOM = 11; // the zoom at which the dot stops being "Firenze" and is the bridge
const START_PITCH = 55;
const FULL_WIDTH_MAP_PX = 800; // below this width the start view zooms out, so the basin still fits

const SNAP_BOX_PX = 12;
const TRACE_DURATION_MS = 3000;
const REPLAY_DURATION_MS = 4000;
const REPLAY_UPDATE_MS = 60;
const CAMERA_DURATION_MS = 900;
const TAP_TOLERANCE_PX = 6;
// A click just outside the basin edge still gets an answer, "This rain does not reach Florence."
// Further out the map is only context, so a click there does nothing but close an open note.
const BASIN_CLICK_MARGIN_KM = 10;
const SHEET_CLOSED_SHARE = 0.3; // the bottom sheet's height when closed, as in style.css
// A tooltip waits a moment under the mouse, so sweeping across the strip does not flash four labels.
const TIP_DELAY_MS = 400;
const TIP_GAP_PX = 6;
// Where a note may go, tried in this order: east first, then south-east, then the rest.
const NOTE_DIRECTIONS = [
  [1, 0.3],
  [1, 1],
  [0.3, 1],
  [1, -0.6],
  [-1, 0.3],
  [-1, 1],
  [0, 1],
  [-1, -0.6],
  [0, -1],
];
const NOTE_DISTANCES_PX = [60, 100, 150, 210, 280, 360, 450];
const NOTE_MARGIN_PX = 8;

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const noHover = window.matchMedia("(hover: none)");
const isPhone = window.matchMedia("(max-width: 900px)");

const $ = (selector) => document.querySelector(selector);

/** What is on the map right now, in the form setLayers wants. Anything it does not name goes off. */
const layersOn = {
  terrain: true,
  hillshade: true,
  contours: true,
  basin: true,
  upstream_rivers: true,
  arno_main_stem: true,
  downstream_rivers: true,
  ponte_vecchio: true,
};

let map = null;
let closeUp = false;
let basin = null;

function applyLayers() {
  // Firenze names the city from afar. Close up, the dot is the bridge itself.
  const labels = {
    pisa: { side: "right" },
    casentino: { side: isPhone.matches ? "bottom" : "right" },
    mugello: { side: "right" },
    // On a phone the names run off the right edge, so there the two eastern ones hang below.
    monte_falterona: { side: isPhone.matches ? "bottom" : "right" },
    [closeUp ? "ponte_vecchio" : "firenze"]: { side: "right" },
  };
  setLayers({ ...Object.fromEntries(Object.entries(layersOn).filter(([, on]) => on)), labels });
}

/** Camera moves ease out and never bounce, and jump for readers who asked for less motion. */
function cameraOptions() {
  return {
    duration: reducedMotion.matches ? 0 : CAMERA_DURATION_MS,
    easing: (t) => 1 - (1 - t) ** 3,
  };
}

// ---- River geometry ------------------------------------------------------------------------------

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInBasin(lngLat, basin) {
  const [outer, ...holes] = basin.features[0].geometry.coordinates;
  return (
    pointInRing(lngLat.lng, lngLat.lat, outer) &&
    !holes.some((hole) => pointInRing(lngLat.lng, lngLat.lat, hole))
  );
}

/** A small flat projection around the map: good enough to compare short distances. */
function planarKm([lng, lat]) {
  return [lng * 111.32 * Math.cos((PONTE_VECCHIO[1] * Math.PI) / 180), lat * 110.57];
}

/** How far a point outside the basin lies from its outer edge, in km. */
function distanceToBasinKm(point, basin) {
  const [outer] = basin.features[0].geometry.coordinates;
  let nearestKm = Infinity;
  for (let i = 1; i < outer.length; i += 1) {
    nearestKm = Math.min(nearestKm, distanceToSegmentKm(point, outer[i - 1], outer[i]));
  }
  return nearestKm;
}

function distanceToSegmentKm(point, start, end) {
  const [px0, py0] = planarKm(point);
  const [ax, ay] = planarKm(start);
  const [bx, by] = planarKm(end);
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px0 - ax) * dx + (py0 - ay) * dy) / lengthSq));
  return Math.hypot(px0 - (ax + t * dx), py0 - (ay + t * dy));
}

function distanceToLineKm(point, coordinates) {
  let best = Infinity;
  for (let i = 1; i < coordinates.length; i++) {
    best = Math.min(best, distanceToSegmentKm(point, coordinates[i - 1], coordinates[i]));
  }
  return best;
}

function nearestVertexIndex(point, coordinates) {
  const [x, y] = planarKm(point);
  let bestIndex = 0;
  let best = Infinity;
  coordinates.forEach((vertex, index) => {
    const [vx, vy] = planarKm(vertex);
    const distance = Math.hypot(vx - x, vy - y);
    if (distance < best) {
      best = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function nearestReach(point, reaches) {
  let bestReach = null;
  let best = Infinity;
  for (const reach of reaches) {
    const distance = distanceToLineKm(point, reach.geometry.coordinates);
    if (distance < best) {
      best = distance;
      bestReach = reach;
    }
  }
  return bestReach;
}

/** Follow NEXT_DOWN from one reach to the bridge. The river network is a graph, not a picture. */
function pathToBridge(start, startPoint, reachById) {
  const startCoords = start.geometry.coordinates;
  let coordinates = startCoords.slice(nearestVertexIndex(startPoint, startCoords));
  let reach = start;
  while (reach.properties.dist_to_florence_km > 0) {
    reach = reachById.get(reach.properties.NEXT_DOWN);
    if (!reach) throw new Error("the river path broke before it reached Florence");
    coordinates = coordinates.concat(reach.geometry.coordinates.slice(1));
  }
  // The last reach runs on past the bridge, so I cut the path where it comes closest.
  coordinates = coordinates.slice(0, nearestVertexIndex(PONTE_VECCHIO, coordinates) + 1);
  coordinates.push(PONTE_VECCHIO);
  return coordinates;
}

/** The point at a fraction of a line's length. */
function pointAlong(coordinates, fraction) {
  const lengths = [0];
  for (let i = 1; i < coordinates.length; i++) {
    const [ax, ay] = planarKm(coordinates[i - 1]);
    const [bx, by] = planarKm(coordinates[i]);
    lengths.push(lengths[i - 1] + Math.hypot(bx - ax, by - ay));
  }
  const target = fraction * lengths[lengths.length - 1];
  const index = Math.max(1, lengths.findIndex((length) => length >= target));
  const span = lengths[index] - lengths[index - 1];
  const t = span === 0 ? 0 : (target - lengths[index - 1]) / span;
  const [ax, ay] = coordinates[index - 1];
  const [bx, by] = coordinates[index];
  return [ax + (bx - ax) * t, ay + (by - ay) * t];
}

function reachesAt(point) {
  const half = SNAP_BOX_PX / 2;
  return map.queryRenderedFeatures(
    [
      [point.x - half, point.y - half],
      [point.x + half, point.y + half],
    ],
    { layers: ["upstream_hit"] },
  );
}

// ---- Annotation ----------------------------------------------------------------------------------

// A pinned note (a traced drop) stays until the reader closes it. A hover note lies on top of it for
// as long as the mouse stays on a river.
let pinnedNote = null;
let hoverNote = null;

function currentNote() {
  return hoverNote ?? pinnedNote;
}

function drawSelected(coordinates) {
  map.getSource("selected").setData({
    type: "FeatureCollection",
    features: coordinates
      ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } }]
      : [],
  });
}

function setDot(coordinates) {
  map.getSource("trace").setData({
    type: "FeatureCollection",
    features: coordinates
      ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates } }]
      : [],
  });
}

/** Set the note's text once. placeNote() then moves it with the map, with no need to rebuild it. */
function fillNote(note) {
  const element = $("#annotation");
  element.textContent = "";
  if (note.name) {
    const name = document.createElement("h3");
    name.textContent = note.name;
    element.append(name);
  }
  const body = document.createElement("p");
  for (const part of note.text) {
    if (part.num) {
      const number = document.createElement("span");
      number.className = "num";
      number.textContent = part.num;
      body.append(number);
    } else {
      body.append(part);
    }
  }
  element.append(body);
  if (note.source) {
    const source = document.createElement("p");
    source.className = "source";
    source.textContent = note.source;
    element.append(source);
  }
  document.body.style.setProperty("--leader", note.leader ?? "");
}

/** Screen rectangles a note must not cover: place names, the title, the foot, the buttons. */
function noteObstacles() {
  const rects = [];
  for (const text of document.querySelectorAll(".map-label .text")) {
    if (text.style.opacity === "0") continue;
    rects.push(text.getBoundingClientRect());
  }
  for (const selector of ["#title", "#foot", "#buttons", "#sheet-open"]) {
    const element = $(selector);
    if (element && !element.hidden) rects.push(element.getBoundingClientRect());
  }
  return rects.filter((rect) => rect.width > 0 && rect.height > 0);
}

function overlaps(a, b, padPx) {
  return (
    a.left < b.right + padPx &&
    a.right > b.left - padPx &&
    a.top < b.bottom + padPx &&
    a.bottom > b.top - padPx
  );
}

/**
 * How bad a place for the note would be. Zero means open paper: inside the map, outside the basin,
 * and clear of every name, of the panels and of the river the note is about.
 */
function slotCost(rect, area, obstacles, pathPoints, anchorX, anchorY) {
  let cost = 0;
  if (
    rect.left < area.left + NOTE_MARGIN_PX ||
    rect.right > area.right - NOTE_MARGIN_PX ||
    rect.top < area.top + NOTE_MARGIN_PX ||
    rect.bottom > area.bottom - NOTE_MARGIN_PX
  ) {
    cost += 1000;
  }
  for (const obstacle of obstacles) if (overlaps(rect, obstacle, 6)) cost += 100;
  // The feature itself stays in view, with room for the leader.
  if (overlaps(rect, { left: anchorX, right: anchorX, top: anchorY, bottom: anchorY }, 16)) {
    cost += 200;
  }
  for (const [x, y] of pathPoints) {
    if (x > rect.left - 6 && x < rect.right + 6 && y > rect.top - 6 && y < rect.bottom + 6) {
      cost += 50;
      break;
    }
  }
  // Nine sample points across the note, each asked whether it lies on the basin.
  for (const fx of [0, 0.5, 1]) {
    for (const fy of [0, 0.5, 1]) {
      const x = rect.left + fx * (rect.right - rect.left) - area.left;
      const y = rect.top + fy * (rect.bottom - rect.top) - area.top;
      if (pointInBasin(map.unproject([x, y]), basin)) cost += 10;
    }
  }
  return cost;
}

/**
 * The note's rectangle for one direction and distance from the feature. It is slid back inside the
 * map when it would stick out, which on a narrow phone is what most places would otherwise do.
 */
function slotRect(x, y, direction, distancePx, width, height, area) {
  const wantedLeft =
    direction[0] >= 0 ? x + direction[0] * distancePx : x + direction[0] * distancePx - width;
  const wantedTop = y + direction[1] * distancePx - height / 2;
  const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
  const left = clamp(wantedLeft, area.left + NOTE_MARGIN_PX, area.right - NOTE_MARGIN_PX - width);
  const top = clamp(wantedTop, area.top + NOTE_MARGIN_PX, area.bottom - NOTE_MARGIN_PX - height);
  // The rule goes on the side of the note that faces the feature.
  const ruleRight = left + width / 2 < x;
  return { left, top, right: left + width, bottom: top + height, ruleRight };
}

let lastSlot = null;

function placeNote() {
  const note = currentNote();
  const element = $("#annotation");
  const leader = $("#leader");
  const anchor = $("#anchor");
  // The leader is an SVG element, which has no hidden property, so I set the attribute itself.
  if (!note) {
    element.hidden = true;
    leader.setAttribute("hidden", "");
    anchor.hidden = true;
    lastSlot = null;
    return;
  }
  element.hidden = false;
  leader.removeAttribute("hidden");
  anchor.hidden = false;
  const area = map.getContainer().getBoundingClientRect();
  const point = map.project(note.lngLat);
  const x = point.x + area.left;
  const y = point.y + area.top;
  const { width, height } = element.getBoundingClientRect();

  // I set the note on open paper beside the basin, never over it, so it needs no wash behind it.
  // The last good place is tried first, so the note does not jump while the map moves.
  const obstacles = noteObstacles();
  const pathPoints = (note.path ?? [])
    .filter((_, index, all) => index % 3 === 0 || index === all.length - 1)
    .map((coordinates) => {
      const projected = map.project(coordinates);
      return [projected.x + area.left, projected.y + area.top];
    });
  const slots = [];
  if (lastSlot) slots.push(lastSlot);
  for (const distancePx of NOTE_DISTANCES_PX) {
    for (const direction of NOTE_DIRECTIONS) slots.push({ direction, distancePx });
  }
  let best = null;
  for (const slot of slots) {
    const rect = slotRect(x, y, slot.direction, slot.distancePx, width, height, area);
    const cost = slotCost(rect, area, obstacles, pathPoints, x, y);
    if (!best || cost < best.cost) best = { slot, rect, cost };
    if (cost === 0) break;
  }
  lastSlot = best.slot;
  const { rect } = best;
  element.classList.toggle("flip", rect.ruleRight);
  element.style.left = `${rect.left}px`;
  element.style.top = `${rect.top}px`;
  anchor.style.left = `${x}px`;
  anchor.style.top = `${y}px`;

  // The leader runs from the feature to the rule on the side of the note that faces it.
  const line = leader.querySelector("line");
  line.setAttribute("x1", String(x));
  line.setAttribute("y1", String(y));
  line.setAttribute("x2", String(rect.ruleRight ? rect.right : rect.left));
  line.setAttribute("y2", String(Math.min(rect.bottom - 4, Math.max(rect.top + 4, y))));
}

function showCurrentNote() {
  const note = currentNote();
  if (note) fillNote(note);
  drawSelected(note?.path ?? null);
  placeNote();
}

function reachNote(reach, lngLat, reachById) {
  const { UPLAND_SKM, dist_to_florence_km, main_stem, HYRIV_ID } = reach.properties;
  const areaKm2 = Math.round(UPLAND_SKM).toLocaleString("en-US");
  const distanceKm = Math.round(dist_to_florence_km);
  const distanceText = distanceKm < 1 ? "Less than 1 km" : `${distanceKm} km`;
  return {
    id: HYRIV_ID,
    // HydroRIVERS has no names. The one river I can name is the main stem, because I traced it.
    name: main_stem ? "Arno" : null,
    text: [`The rain on ${areaKm2} km² flows to this reach. ${distanceText} to Florence.`],
    source: "Source: HydroSHEDS",
    lngLat,
    path: reachById.get(HYRIV_ID).geometry.coordinates,
  };
}

function setupHover(reachById) {
  if (noHover.matches) return;
  map.on("mousemove", (event) => {
    const hits = reachesAt(event.point);
    map.getCanvas().style.cursor = hits.length > 0 ? "pointer" : "";
    if (hits.length === 0) {
      if (hoverNote) {
        hoverNote = null;
        showCurrentNote();
      }
      return;
    }
    const point = [event.lngLat.lng, event.lngLat.lat];
    const reach = nearestReach(point, hits);
    const sameReach = hoverNote?.id === reach.properties.HYRIV_ID;
    hoverNote = reachNote(reach, event.lngLat, reachById);
    if (sameReach) placeNote();
    else showCurrentNote();
  });
  map.getCanvas().addEventListener("mouseleave", () => {
    hoverNote = null;
    showCurrentNote();
  });
}

// ---- Trace a drop --------------------------------------------------------------------------------

function setupTrace(data, reachById) {
  // The reader proves the insight to themselves. Anywhere in the basin, the path ends at the same
  // bridge. Outside it, the map says so.
  const reaches = data.riversUpstream.features;
  let animation = null;

  function stopAnimation() {
    if (animation !== null) cancelAnimationFrame(animation);
    animation = null;
  }

  function traceFrom(event) {
    const point = [event.lngLat.lng, event.lngLat.lat];
    if (!pointInBasin(event.lngLat, data.basin)) {
      setDot(null);
      if (distanceToBasinKm(point, data.basin) > BASIN_CLICK_MARGIN_KM) {
        pinnedNote = null;
        showCurrentNote();
        return;
      }
      pinnedNote = {
        text: ["This rain does not reach Florence."],
        lngLat: event.lngLat,
        leader: COTTO,
      };
      showCurrentNote();
      return;
    }
    // queryRenderedFeatures returns pieces cut at tile edges, so I look up each whole reach by ID.
    // Far from any river the box is empty, and then the nearest reach of the whole basin decides.
    const candidates = reachesAt(event.point).map((hit) => reachById.get(hit.properties.HYRIV_ID));
    const start = nearestReach(point, candidates.length > 0 ? candidates : reaches);
    const path = pathToBridge(start, point, reachById);
    const distanceKm = Math.round(start.properties.dist_to_florence_km);
    pinnedNote = {
      text:
        distanceKm < 1
          ? ["This drop travels less than ", { num: "1" }, "\u00a0km to Ponte Vecchio."]
          : ["This drop travels ", { num: String(distanceKm) }, "\u00a0km to Ponte Vecchio."],
      source: "Source: HydroSHEDS",
      lngLat: event.lngLat,
      leader: COTTO,
      path,
    };
    hoverNote = null;
    showCurrentNote();

    if (reducedMotion.matches) {
      setDot(PONTE_VECCHIO);
      return;
    }
    const startedMs = performance.now();
    const step = (nowMs) => {
      const t = Math.min(1, (nowMs - startedMs) / TRACE_DURATION_MS);
      // Eased at both ends: a slow start, a slow arrival.
      const eased = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
      setDot(pointAlong(path, eased));
      animation = t < 1 ? requestAnimationFrame(step) : null;
    };
    animation = requestAnimationFrame(step);
  }

  map.on("click", (event) => {
    stopAnimation();
    // On a touch screen there is no hover. A tap on a river names it, a tap elsewhere in the basin
    // traces a drop, and a tap while a note is open only closes that note.
    if (noHover.matches) {
      if (currentNote()) {
        closeNote();
        return;
      }
      const hits = reachesAt(event.point);
      if (hits.length > 0) {
        const point = [event.lngLat.lng, event.lngLat.lat];
        pinnedNote = reachNote(nearestReach(point, hits), event.lngLat, reachById);
        showCurrentNote();
        return;
      }
    }
    traceFrom(event);
  });

  return stopAnimation;
}

let stopTrace = () => {};

function closeNote() {
  stopTrace();
  pinnedNote = null;
  hoverNote = null;
  setDot(null);
  showCurrentNote();
}

// ---- Sheet ---------------------------------------------------------------------------------------

function setupKey() {
  // The key is also the layer switch: click an entry, and its sample and its layer go together.
  for (const entry of document.querySelectorAll(".k")) {
    entry.addEventListener("click", () => {
      const layer = entry.dataset.layer;
      layersOn[layer] = !layersOn[layer];
      entry.setAttribute("aria-pressed", String(layersOn[layer]));
      applyLayers();
    });
  }
}

function showLayerOn(layer) {
  layersOn[layer] = true;
  $(`.k[data-layer="${layer}"]`).setAttribute("aria-pressed", "true");
  applyLayers();
}

async function fetchLayer(name) {
  const response = await fetch(new URL(`layers/${name}`, document.baseURI));
  if (!response.ok) throw new Error(`layers/${name}: HTTP ${response.status}`);
  return response.json();
}

/**
 * Split a display text such as "4,600 km²" into its number and the rest. The number is set in the
 * typewriter face, the unit in the text face after an ordinary-width space that never breaks.
 */
function splitDisplay(display) {
  const match = display.match(/^([\d.,]+)(?: (.*))?$/);
  if (!match) throw new Error(`no number at the start of: ${display}`);
  return [{ num: match[1] }, match[2] ? `\u00a0${match[2]}` : ""];
}

const CROSSHAIR_SVG =
  '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" ' +
  'stroke-width="1.3"><circle cx="7" cy="7" r="4.5"/>' +
  '<path d="M7 0.5v3M7 10.5v3M0.5 7h3M10.5 7h3"/></svg>';

/**
 * One line of In numbers: the number first, then a few plain words. The text itself is never a
 * link. A line with a place on the map gets one small button at its end, a crosshair that flies
 * there, so what can be clicked is plain to see and the sentence stays easy to read.
 */
function figureLine(parts, onShow) {
  const line = document.createElement("p");
  line.className = "fig";
  const text = document.createElement("span");
  text.className = "fig-text";
  for (const part of parts) {
    if (part.num) {
      const number = document.createElement("span");
      number.className = "num";
      number.textContent = part.num;
      text.append(number);
    } else {
      text.append(part);
    }
  }
  line.append(text);
  if (onShow) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "show-on-map";
    button.setAttribute("aria-label", "Show on map");
    button.innerHTML = CROSSHAIR_SVG;
    button.addEventListener("click", onShow);
    line.classList.add("has-place");
    line.append(button);
  }
  return line;
}

function renderNumbers(figures, onBasin, onArno) {
  const byId = Object.fromEntries(figures.map((figure) => [figure.id, figure]));
  for (const id of ["death_toll", "basin_area", "times_florence", "arno_length"]) {
    if (!byId[id]) throw new Error(`key figure ${id} is missing from layers/key_figures.json`);
  }
  // The display text in key_figures.json is the only copy of each number. I never retype one.
  const times = byId.times_florence.display.match(/^(\d+) times the size of Florence$/);
  if (!times) throw new Error(`unexpected display: ${byId.times_florence.display}`);
  const [area, areaUnit] = splitDisplay(byId.basin_area.display);
  const [length, lengthUnit] = splitDisplay(byId.arno_length.display);
  const [toll] = splitDisplay(byId.death_toll.display);

  // Lines with a place on the map come last, so the crosshairs line up at the foot of the list.
  // The basin and its size against the city belong together, so they share one line.
  $("#numbers").append(
    figureLine([toll, " people in the region died in the flood"]),
    figureLine(
      [
        area,
        `${areaUnit} of hills whose rain flows to Florence, `,
        { num: times[1] },
        " times the size of the city",
      ],
      onBasin,
    ),
    figureLine([length, `${lengthUnit} of Arno, from Monte Falterona to the sea`], onArno),
  );
  $("#lede-area").textContent = byId.basin_area.display.replace(" ", "\u00a0");
  $("#count-arno").textContent = byId.arno_length.display;
  $("#count-basin").textContent = byId.basin_area.display;
}

function setupFold() {
  // Folding gives the map the whole window. Esc does the same once no note is open.
  const fold = (folded) => {
    document.body.classList.toggle("sheet-folded", folded);
    $("#sheet-open").hidden = !folded;
    map.resize();
    placeNote();
    (folded ? $("#sheet-open") : $("#sheet-fold")).focus({ preventScroll: true });
  };
  $("#sheet-fold").addEventListener("click", () => fold(true));
  $("#sheet-open").addEventListener("click", () => fold(false));
  return fold;
}

function setupBottomSheet() {
  // On a phone the same three parts sit in a bottom sheet. A tap opens or closes it, a drag follows
  // the thumb and then snaps to the nearer of the two heights. No animated panels, on purpose.
  const sheet = $("#sheet");
  const grab = $("#grab");
  const setOpen = (open) => {
    document.body.classList.toggle("sheet-open", open);
    grab.setAttribute("aria-expanded", String(open));
    sheet.style.height = "";
    if (!open) sheet.scrollTop = 0;
  };
  let dragStartY = null;
  let startHeight = 0;
  let moved = false;
  grab.addEventListener("pointerdown", (event) => {
    dragStartY = event.clientY;
    startHeight = sheet.getBoundingClientRect().height;
    moved = false;
    grab.setPointerCapture(event.pointerId);
  });
  grab.addEventListener("pointermove", (event) => {
    if (dragStartY === null) return;
    const deltaPx = dragStartY - event.clientY;
    if (Math.abs(deltaPx) > TAP_TOLERANCE_PX) moved = true;
    // The sheet never goes lower than its closed height, so the Layers heading always shows.
    const closedPx = window.innerHeight * SHEET_CLOSED_SHARE;
    if (moved) sheet.style.height = `${Math.max(closedPx, startHeight + deltaPx)}px`;
  });
  // The pointer decides here, a drag by where it ends and a tap by toggling. I do not wait for the
  // click: after a touch drag the browser may send none for the next tap, and the tap would be lost.
  grab.addEventListener("pointerup", () => {
    if (dragStartY === null) return;
    dragStartY = null;
    if (moved) setOpen(sheet.getBoundingClientRect().height > window.innerHeight * 0.6);
    else setOpen(!document.body.classList.contains("sheet-open"));
  });
  // After a touch, the browser sends a click to whatever is under the finger by then. The sheet has
  // just changed height, so that would be the map, and it would take the tap as its own. Cancelling
  // touchend on the grab line stops that stray click.
  grab.addEventListener("touchend", (event) => event.preventDefault(), { passive: false });
  // The click is left to the keyboard (Enter or Space), which reports no pointer: detail is 0.
  grab.addEventListener("click", (event) => {
    if (event.detail === 0) setOpen(!document.body.classList.contains("sheet-open"));
  });
  return setOpen;
}

function setupKeyboard(fold, setOpen) {
  // Esc takes back one thing at a time: first the note, then the sheet.
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
    if (currentNote()) closeNote();
    else if (isPhone.matches) setOpen(false);
    else if (!document.body.classList.contains("sheet-folded")) fold(true);
  });
}

// ---- Map buttons, replay -------------------------------------------------------------------------

function setupButtons(startView) {
  $("#zoom-in").addEventListener("click", () => map.zoomIn(cameraOptions()));
  $("#zoom-out").addEventListener("click", () => map.zoomOut(cameraOptions()));
  $("#north").addEventListener("click", () =>
    map.easeTo({ bearing: 0, pitch: 0, ...cameraOptions() }),
  );
  $("#tilt").addEventListener("click", () =>
    map.easeTo({ pitch: map.getPitch() > 1 ? 0 : START_PITCH, ...cameraOptions() }),
  );
  $("#start-view").addEventListener("click", () => map.easeTo({ ...startView, ...cameraOptions() }));

  // Rotate, tilt and zoom: elevation is what matters here, and tilting shows the ring of hills
  // around the valleys. The buttons always show the state of the camera, however it got there.
  // The 3D button says what a click will do, so its name changes with the tilt. A name that flips
  // and a pressed state would say the same thing twice, so "on" is only a heavier drawing here.
  const showCameraState = () => {
    $("#north svg").style.transform = `rotate(${-map.getBearing()}deg)`;
    const tilted = map.getPitch() > 1;
    $("#tilt").dataset.on = String(tilted);
    $("#tilt").setAttribute("aria-label", tilted ? "Back to flat" : "Tilt to 3D");
  };
  map.on("move", showCameraState);
  showCameraState();
}

function setupTooltips() {
  // A small label beside the map buttons, the crosshairs in In numbers and the dialog's close
  // button. Its text is the button's
  // aria-label, so what a screen reader says and what the eye reads can never drift apart. The sheet
  // icons get none: the sheet itself shows what they do.
  // No title attribute: the browser's own tooltip comes late, looks foreign, never shows on focus.
  const pageTip = $("#tip");
  const strip = $("#buttons");
  const tips = [pageTip];
  let timer = null;
  const place = (tip, button, besideBox) => {
    tip.textContent = button.getAttribute("aria-label");
    tip.hidden = false;
    const box = button.getBoundingClientRect();
    tip.style.right = `${window.innerWidth - besideBox().left + TIP_GAP_PX}px`;
    tip.style.top = `${box.top + box.height / 2 - tip.offsetHeight / 2}px`;
  };
  const hide = (tip) => {
    clearTimeout(timer);
    tip.shownFor = null;
    tip.hidden = true;
  };
  const attach = (button, tip, besideBox = () => button.getBoundingClientRect()) => {
    const show = () => {
      clearTimeout(timer);
      tip.shownFor = button;
      tip.besideBox = besideBox;
      place(tip, button, besideBox);
    };
    // Touch screens get no tooltips: a tap would show the label and act in the same moment.
    button.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse") return;
      clearTimeout(timer);
      timer = setTimeout(show, TIP_DELAY_MS);
    });
    button.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse") hide(tip);
    });
    // :focus-visible is true for the keyboard and false after a mouse click, which is the split
    // I want: Tab shows the label at once, a click does not leave one hanging.
    button.addEventListener("focus", () => {
      if (button.matches(":focus-visible")) show();
    });
    button.addEventListener("blur", () => {
      if (tip.shownFor === button) hide(tip);
    });
    // A click can move the button away from under the pointer, so it takes its tip along.
    button.addEventListener("click", () => hide(tip));
  };

  // The map buttons line their labels up just left of the strip, not of each button.
  for (const button of strip.querySelectorAll("button")) {
    attach(button, pageTip, () => strip.getBoundingClientRect());
  }
  for (const button of document.querySelectorAll(".show-on-map")) attach(button, pageTip);
  // A modal dialog sits in the browser's top layer, above everything on the page, so each dialog
  // carries its own label element: the page's one would be hidden behind it.
  for (const dialog of document.querySelectorAll("dialog")) {
    const tip = dialog.querySelector(".tip");
    tips.push(tip);
    attach(dialog.querySelector("form.close button"), tip);
    dialog.addEventListener("close", () => hide(tip));
  }

  // The 3D button renames itself once the camera has tilted, which can be a second after the click,
  // so the label watches the name rather than the click.
  new MutationObserver(() => {
    if (pageTip.shownFor) place(pageTip, pageTip.shownFor, pageTip.besideBox);
  }).observe(strip, { attributes: true, attributeFilter: ["aria-label"], subtree: true });

  // Esc takes back one thing at a time, and a tooltip is the first. The capture phase runs this
  // before the listener that would close the note or fold the sheet. In a dialog, Esc closes the
  // dialog as well, which is what a reader pressing it there expects.
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      const shown = tips.filter((tip) => !tip.hidden);
      if (shown.length === 0) return;
      for (const tip of shown) hide(tip);
      if (!document.querySelector("dialog[open]")) event.stopImmediatePropagation();
    },
    { capture: true },
  );
}

function setupReplay() {
  // Far reaches appear first and the network grows towards the bridge, through the API's setTime.
  let animation = null;
  $("#replay").addEventListener("click", () => {
    if (animation !== null) cancelAnimationFrame(animation);
    showLayerOn("upstream_rivers");
    if (reducedMotion.matches) {
      setTime(1);
      return;
    }
    const startedMs = performance.now();
    let lastUpdateMs = -Infinity;
    const step = (nowMs) => {
      const t = Math.min(1, (nowMs - startedMs) / REPLAY_DURATION_MS);
      if (t >= 1) {
        setTime(1);
        animation = null;
        return;
      }
      if (nowMs - lastUpdateMs >= REPLAY_UPDATE_MS) {
        setTime(t);
        lastUpdateMs = nowMs;
      }
      animation = requestAnimationFrame(step);
    };
    animation = requestAnimationFrame(step);
  });

  // Space replays, like Space plays a timeline on the other maps. Not while the reader types, not
  // under an open dialog, and not when a button has focus: there Space presses that button.
  window.addEventListener("keydown", (event) => {
    if (event.key !== " " || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
    if (document.querySelector("dialog[open]")) return;
    const target = event.target;
    if (target.closest?.("input, textarea, select, button, a, [contenteditable=''], [contenteditable=true]")) {
      return;
    }
    event.preventDefault(); // Space would otherwise scroll the page
    $("#replay").click();
  });
}

/** Last line of About this map: when the data was fetched, from layers/meta.json. */
function renderFetched(meta) {
  // The dates are calendar days with no time, so I format them in UTC: in a time zone behind UTC,
  // midnight of the 5th would otherwise print as the 4th.
  const format = (iso) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  const days = new Set(meta.sources.map((source) => source.downloaded));
  $("#fetched").textContent =
    days.size === 1
      ? `Data fetched ${format([...days][0])}.`
      : meta.sources.map((source) => `${source.name} fetched ${format(source.downloaded)}.`).join("\n");
}

function setupDialogs() {
  // Native <dialog> with showModal(): the browser keeps focus inside, makes the page behind inert
  // and closes it on Esc. I add the two things it leaves out: a click on the backdrop closes it,
  // and focus starts on the dialog itself, not on its first link, then returns to the opener.
  for (const name of ["about", "download"]) {
    const dialog = $(`#${name}`);
    const opener = $(`#${name}-open`);
    opener.addEventListener("click", () => {
      dialog.showModal();
      dialog.scrollTop = 0;
      dialog.focus();
    });
    // The backdrop belongs to the dialog element, so a click there has the dialog as its target,
    // just like a click on its padding. Only the position tells them apart.
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      const inside =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom;
      if (!inside) dialog.close();
    });
    dialog.addEventListener("close", () => opener.focus());
  }
}

function extentOf(features) {
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const feature of features) {
    for (const [lng, lat] of feature.geometry.coordinates) {
      west = Math.min(west, lng);
      south = Math.min(south, lat);
      east = Math.max(east, lng);
      north = Math.max(north, lat);
    }
  }
  return [
    [west, south],
    [east, north],
  ];
}

async function start() {
  const { map: created, data } = await createMap("map");
  map = created;
  basin = data.basin;

  // A narrow window gets a lower zoom, so that the whole basin still fits in the start view.
  const widthPx = map.getContainer().clientWidth;
  if (widthPx < FULL_WIDTH_MAP_PX) {
    map.jumpTo({ zoom: map.getZoom() + Math.log2(widthPx / FULL_WIDTH_MAP_PX) });
  }
  const startView = {
    center: map.getCenter(),
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };

  // My own two layers for this page only: the selected river or path in the highlight colour. I add
  // them here, not in the map's style, so that a view drawn through the API never carries them.
  map.addSource("selected", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer(
    {
      id: "selected",
      type: "line",
      source: "selected",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": COTTO, "line-width": 2.5 },
    },
    "trace_dot",
  );

  closeUp = map.getZoom() >= SMOOTH_ARNO_FROM_ZOOM;
  applyLayers();
  map.on("zoom", () => {
    const nowCloseUp = map.getZoom() >= SMOOTH_ARNO_FROM_ZOOM;
    if (nowCloseUp === closeUp) return;
    closeUp = nowCloseUp;
    applyLayers();
  });
  map.on("move", placeNote);
  isPhone.addEventListener("change", applyLayers);

  const reachById = new Map(
    data.riversUpstream.features.map((reach) => [reach.properties.HYRIV_ID, reach]),
  );
  // The map has already loaded the Arno and the downstream rivers; only meta.json is new here.
  const { arno, riversDownstream: downstream } = data;
  const meta = await fetchLayer("meta.json");
  renderFetched(meta);

  // Every count comes from the layers themselves, never typed in.
  // The river networks by length, like the Arno beside them. prepare.py measures them in UTM; I
  // round to 10 km, because a 15 arc-second river model is no finer than that summed over hundreds
  // of reaches.
  const networkKm = (km) => `${(Math.round(km / 10) * 10).toLocaleString("en-US")} km`;
  $("#count-upstream").textContent = networkKm(meta.network_km.upstream_rivers);
  $("#count-downstream").textContent = networkKm(meta.network_km.downstream_rivers);

  const onBasin = () => {
    showLayerOn("basin");
    map.easeTo({ ...startView, ...cameraOptions() });
  };
  const onArno = () => {
    showLayerOn("arno_main_stem");
    map.fitBounds(extentOf(arno.features), {
      padding: 60,
      pitch: 0,
      bearing: 0,
      ...cameraOptions(),
    });
  };
  renderNumbers(data.figures, onBasin, onArno);

  setupKey();
  setupButtons(startView);
  setupReplay();
  setupDialogs();
  setupTooltips();
  setupHover(reachById);
  stopTrace = setupTrace(data, reachById);
  setupKeyboard(setupFold(), setupBottomSheet());

  await new Promise((resolve) => {
    map.once("idle", resolve);
    map.triggerRepaint();
  });
  // Handy in the browser console: the live MapLibre map, to try the API's calls by hand.
  window.map = map;
}

start().catch((error) => {
  console.error(error);
  const note = document.createElement("p");
  note.id = "load-error";
  note.textContent = `The map could not load: ${error.message}`;
  document.body.append(note);
});
