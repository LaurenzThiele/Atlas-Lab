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

const PIENA = "#1E3550";
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

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
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

/** The point on a line nearest to a click, and the index of the segment it lies on. */
function nearestPointOnLine(point, coordinates) {
  const [px0, py0] = planarKm(point);
  let best = { distance: Infinity, index: 0, coordinates: coordinates[0] };
  for (let i = 1; i < coordinates.length; i++) {
    const [ax, ay] = planarKm(coordinates[i - 1]);
    const [bx, by] = planarKm(coordinates[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t =
      lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px0 - ax) * dx + (py0 - ay) * dy) / lengthSq));
    const distance = Math.hypot(px0 - (ax + t * dx), py0 - (ay + t * dy));
    if (distance < best.distance) {
      // planarKm is linear in longitude and latitude, so t carries back to degrees unchanged.
      const [alng, alat] = coordinates[i - 1];
      const [blng, blat] = coordinates[i];
      const snapped = [alng + (blng - alng) * t, alat + (blat - alat) * t];
      best = { distance, index: i - 1, coordinates: snapped };
    }
  }
  return best;
}

/** Follow NEXT_DOWN from one reach to the bridge. The river network is a graph, not a picture. */
function pathToBridge(start, snapped, reachById) {
  let coordinates = [snapped.coordinates, ...start.geometry.coordinates.slice(snapped.index + 1)];
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

// ---- Annotation: the flood plaque ----------------------------------------------------------------

// On walls all over Florence, small marble plaques mark how high the water stood on 4 November
// 1966. The note takes their form: a framed plaque with a water line across it, hung on a plumb
// line from the point the reader clicked. It opens only on a click, never on hover.
const PLAQUE_SOURCE_REACH = "Source: HydroRIVERS v1.0, WWF, Lehner and Grill (2013)";
const PLAQUE_SOURCE_BASIN = "Source: HydroBASINS level 12 v1c, WWF, Lehner and Grill (2013)";
const PLUMB_MIN_PX = 40;
const PLUMB_MAX_PX = 90;
const PLUMB_STEP_PX = 10;
const TICK_PX = 12;
const MARK_DOT_RADIUS_PX = 6; // the 12 px dot at the snapped point
const MARK_WIDTH_SCALE = 2.5; // the clicked reach, drawn at 2.5 times its own width
const NOTE_MARGIN_PX = 8;

// One note at a time. It stays until the reader closes it.
let openNote = null;
let lastSlot = null;

/** The clicked reach, drawn again in Piena on top of the network. */
function drawSelected(reach) {
  const { UPLAND_SKM, main_stem } = reach?.properties ?? {};
  map.getSource("selected").setData({
    type: "FeatureCollection",
    features: reach
      ? [{ type: "Feature", properties: { UPLAND_SKM, main_stem }, geometry: reach.geometry }]
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

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A figure line in Courier Prime, the typewriter of the 1966 reports. A space in a monospace face
 * is as wide as a letter, so the spaces between number, unit and words are set in the text face.
 */
function plaqueFigure(text) {
  const line = element("p", "plaque-figure");
  text.split(" ").forEach((word, index) => {
    if (index > 0) line.append(element("span", "gap", " "));
    line.append(word);
  });
  return line;
}

/** Set the plaque's text once. placeNote() then moves it with the map without rebuilding it. */
function fillNote(note) {
  const plaque = $("#annotation");
  plaque.textContent = "";
  const inner = element("div", "plaque-inner");
  inner.append(element("h3", "plaque-name", note.name));
  if (note.kind === "reach") {
    inner.append(
      element("span", "waterline"),
      plaqueFigure(note.area),
      element("p", "plaque-words", "of hills drain past here"),
      plaqueFigure(note.distance),
      element("p", "plaque-words", "to Ponte Vecchio"),
    );
  } else {
    inner.append(element("p", "plaque-words single", "This rain does not reach Florence."));
  }
  inner.append(element("p", "plaque-source", note.source));
  plaque.append(inner);
  // The plaque itself is hidden from screen readers: this polite live region says the same words
  // once, as sentences.
  $("#note-live").textContent = note.spoken;
}

/**
 * Screen rectangles a note should not cover, each with its cost. The hint line and the buttons
 * must stay clear. The title and the place names are avoided too, but on a short phone map, where
 * nothing else fits, the plaque may lie over the title rather than over the controls.
 */
function noteObstacles() {
  const obstacles = [];
  for (const text of document.querySelectorAll(".map-label .text")) {
    if (text.style.opacity === "0") continue;
    obstacles.push({ rect: text.getBoundingClientRect(), cost: 30 });
  }
  const panels = [["#title", 30], ["#foot", 100], ["#buttons", 100], ["#sheet-open", 100]];
  for (const [selector, cost] of panels) {
    const node = $(selector);
    if (node && !node.hidden) obstacles.push({ rect: node.getBoundingClientRect(), cost });
  }
  return obstacles.filter(({ rect }) => rect.width > 0 && rect.height > 0);
}

function overlaps(a, b, padPx) {
  return (
    a.left < b.right + padPx &&
    a.right > b.left - padPx &&
    a.top < b.bottom + padPx &&
    a.bottom > b.top - padPx
  );
}

/** The part of the window the note may use: the map, minus the bottom sheet on a phone. */
function noteArea() {
  const box = map.getContainer().getBoundingClientRect();
  const area = { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
  if (isPhone.matches) area.bottom = Math.min(area.bottom, $("#sheet").getBoundingClientRect().top);
  return area;
}

/**
 * Every place the plaque may hang, in the order I prefer them: straight above the point on the
 * shortest plumb line, then longer lines, then below the point (near the top edge). On a phone
 * there may be no room beside the feature, so two more places sit at the foot or the top of the
 * map, with no plumb line.
 */
function noteSlots() {
  const slots = [];
  for (const side of ["above", "below"]) {
    for (let lengthPx = PLUMB_MIN_PX; lengthPx <= PLUMB_MAX_PX; lengthPx += PLUMB_STEP_PX) {
      slots.push({ side, lengthPx });
    }
  }
  if (isPhone.matches) slots.push({ dock: "bottom" }, { dock: "top" });
  return slots;
}

function slotRect(slot, x, y, width, height, area) {
  const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
  const centredLeft = slot.dock ? (area.left + area.right) / 2 - width / 2 : x - width / 2;
  const left = clamp(centredLeft, area.left + NOTE_MARGIN_PX, area.right - NOTE_MARGIN_PX - width);
  let top;
  if (slot.dock === "bottom") {
    const floor = Math.min(
      area.bottom,
      $("#foot").getBoundingClientRect().top,
      $("#buttons").getBoundingClientRect().top,
    );
    top = floor - NOTE_MARGIN_PX - height;
  } else if (slot.dock === "top") {
    top = $("#title").getBoundingClientRect().bottom + NOTE_MARGIN_PX;
  } else {
    top = slot.side === "above" ? y - slot.lengthPx - height : y + slot.lengthPx;
  }
  return { left, top, right: left + width, bottom: top + height, shifted: left !== centredLeft };
}

/** How bad a place would be. Zero means the plaque hangs straight and covers nothing. */
function slotCost(slot, rect, area, obstacles, featurePoints) {
  let cost = 0;
  if (rect.top < area.top + NOTE_MARGIN_PX || rect.bottom > area.bottom - NOTE_MARGIN_PX) {
    cost += 1000;
  }
  for (const obstacle of obstacles) if (overlaps(rect, obstacle.rect, 6)) cost += obstacle.cost;
  // Never over the clicked feature: the dot and the reach it was snapped to.
  for (const [x, y] of featurePoints) {
    if (x > rect.left - 4 && x < rect.right + 4 && y > rect.top - 4 && y < rect.bottom + 4) {
      cost += 200;
      break;
    }
  }
  if (rect.shifted) cost += 2; // slid sideways near an edge: the plumb line meets it off centre
  if (slot.dock) cost += 20;
  if (slot.side === "below") cost += 1;
  if (slot.lengthPx) cost += (slot.lengthPx - PLUMB_MIN_PX) / 100;
  // The last place wins a tie, so the plaque does not jump while the map moves.
  if (lastSlot && slot.side === lastSlot.side && slot.lengthPx === lastSlot.lengthPx &&
      slot.dock === lastSlot.dock) {
    cost -= 0.5;
  }
  return cost;
}

function placeNote() {
  const plaque = $("#annotation");
  const plumb = $("#leader");
  const dot = $("#anchor");
  // The plumb line is an SVG element, which has no hidden property, so I set the attribute itself.
  if (!openNote) {
    plaque.hidden = true;
    plumb.setAttribute("hidden", "");
    dot.hidden = true;
    lastSlot = null;
    return;
  }
  plaque.hidden = false;
  plumb.removeAttribute("hidden");
  // Outside the basin there is no reach to mark: the plumb line and its tick mark the point alone.
  dot.hidden = openNote.kind !== "reach";
  const box = map.getContainer().getBoundingClientRect();
  const point = map.project(openNote.lngLat);
  const x = point.x + box.left;
  const y = point.y + box.top;
  dot.style.left = `${x}px`;
  dot.style.top = `${y}px`;

  const area = noteArea();
  const { width, height } = plaque.getBoundingClientRect();
  const obstacles = noteObstacles();
  const featurePoints = [[x, y]];
  for (const coordinates of openNote.reach?.geometry.coordinates ?? []) {
    const projected = map.project(coordinates);
    featurePoints.push([projected.x + box.left, projected.y + box.top]);
  }
  let best = null;
  for (const slot of noteSlots()) {
    const rect = slotRect(slot, x, y, width, height, area);
    const cost = slotCost(slot, rect, area, obstacles, featurePoints);
    if (!best || cost < best.cost) best = { slot, rect, cost };
  }
  lastSlot = best.slot;
  const { rect, slot } = best;
  // When the reader pans the point near or past the edge, no place fits. The plaque then stays
  // inside the map, against the edge, rather than following the point off screen.
  if (best.cost >= 1000) {
    const top = Math.min(
      Math.max(rect.top, area.top + NOTE_MARGIN_PX),
      area.bottom - NOTE_MARGIN_PX - height,
    );
    rect.bottom += top - rect.top;
    rect.top = top;
  }
  plaque.style.left = `${rect.left}px`;
  plaque.style.top = `${rect.top}px`;

  // The plumb line drops straight from the plaque to the point, and a short level tick crosses it
  // there, like the line cut under a flood plaque. A plaque docked on a phone hangs on nothing.
  const [line, tick] = plumb.querySelectorAll("line");
  const pointInArea = x >= area.left && x <= area.right && y >= area.top && y <= area.bottom;
  line.style.display = slot.dock || !pointInArea ? "none" : "";
  tick.style.display = pointInArea ? "" : "none";
  const startY = openNote.kind === "reach" ? MARK_DOT_RADIUS_PX : 0;
  const above = slot.side === "above";
  line.setAttribute("x1", String(x));
  line.setAttribute("x2", String(x));
  line.setAttribute("y1", String(above ? y - startY : y + startY));
  line.setAttribute("y2", String(above ? rect.bottom : rect.top));
  tick.setAttribute("x1", String(x - TICK_PX / 2));
  tick.setAttribute("x2", String(x + TICK_PX / 2));
  tick.setAttribute("y1", String(y));
  tick.setAttribute("y2", String(y));
}

/** The 150 ms fade, started again on every new note. The stylesheet drops it for reduced motion. */
function fadeIn() {
  for (const node of [$("#annotation"), $("#leader"), $("#anchor")]) {
    node.classList.remove("note-in");
    void node.getBoundingClientRect(); // a layout pass between the two, so the animation restarts
    node.classList.add("note-in");
  }
}

function showNote(note) {
  openNote = note;
  lastSlot = null;
  fillNote(note);
  drawSelected(note.reach ?? null);
  placeNote();
  fadeIn();
}

function reachNote(reach, lngLat) {
  const { UPLAND_SKM, dist_to_florence_km, main_stem, HYRIV_ID, name } = reach.properties;
  // HydroRIVERS has no names. The one river I can name is the main stem, because I traced it.
  const riverName =
    typeof name === "string" && name ? name : main_stem ? "The Arno" : "This stream";
  const area = `${Math.round(UPLAND_SKM).toLocaleString("en-US")} km²`;
  const distanceKm = Math.round(dist_to_florence_km);
  const distance = distanceKm < 1 ? "less than 1 km" : `about ${distanceKm} km`;
  return {
    kind: "reach",
    id: HYRIV_ID,
    name: riverName,
    area,
    distance,
    source: PLAQUE_SOURCE_REACH,
    spoken:
      `${riverName}. ${area} of hills drain past here, ${distance} to Ponte Vecchio. ` +
      `${PLAQUE_SOURCE_REACH}.`,
    lngLat,
    reach,
  };
}

function outsideNote(lngLat) {
  return {
    kind: "outside",
    name: "Outside the basin",
    source: PLAQUE_SOURCE_BASIN,
    spoken: `Outside the basin. This rain does not reach Florence. ${PLAQUE_SOURCE_BASIN}.`,
    lngLat,
  };
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

  function traceDrop(path) {
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

  // A click (a tap on touch) is the only thing that opens a note. A second click on the same reach,
  // or a click far from the basin, closes it again.
  map.on("click", (event) => {
    stopAnimation();
    const point = [event.lngLat.lng, event.lngLat.lat];
    if (!pointInBasin(event.lngLat, data.basin)) {
      setDot(null);
      // Just outside the edge the map answers. Further out the map is only context.
      const far = distanceToBasinKm(point, data.basin) > BASIN_CLICK_MARGIN_KM;
      if (far || openNote?.kind === "outside") closeNote();
      else showNote(outsideNote(event.lngLat));
      return;
    }
    // queryRenderedFeatures returns pieces cut at tile edges, so I look up each whole reach by ID.
    // Far from any river the box is empty, and then the nearest reach of the whole basin decides.
    const candidates = reachesAt(event.point).map((hit) => reachById.get(hit.properties.HYRIV_ID));
    const start = nearestReach(point, candidates.length > 0 ? candidates : reaches);
    if (openNote?.kind === "reach" && openNote.id === start.properties.HYRIV_ID) {
      closeNote();
      return;
    }
    const snapped = nearestPointOnLine(point, start.geometry.coordinates);
    showNote(reachNote(start, { lng: snapped.coordinates[0], lat: snapped.coordinates[1] }));
    traceDrop(pathToBridge(start, snapped, reachById));
  });

  return stopAnimation;
}

let stopTrace = () => {};

function closeNote() {
  stopTrace();
  openNote = null;
  setDot(null);
  drawSelected(null);
  placeNote();
  $("#note-live").textContent = "";
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
    if (openNote) closeNote();
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

  // My own layer for this page only: the clicked reach, drawn again in Piena at 2.5 times its
  // width. I add it here, not in the map's style, so that a view drawn through the API never
  // carries it. The width is the drawn layer's own expression, scaled, so the two never disagree.
  const widthOf = (layer) => ["*", MARK_WIDTH_SCALE, map.getPaintProperty(layer, "line-width")];
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
      paint: {
        "line-color": PIENA,
        "line-width": [
          "case",
          ["to-boolean", ["get", "main_stem"]],
          widthOf("arno_reaches"),
          widthOf("upstream_rivers"),
        ],
      },
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
