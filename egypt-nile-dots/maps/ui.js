/**
 * The furniture of the public map: title, key, options, figures, sources, buttons, hint and notes.
 *
 * What it does: builds the interface in index.html on top of the public API in main.js. The map
 * itself knows nothing about any of this, so a script can draw clean views without it.
 * Reads:  layers/ (through createMap, plus the 1 km squares, the share curve and meta.json)
 * Writes: nothing
 * Run:    npm run dev   (index.html loads this file)
 *
 * Why a separate file: main.js stays a small API that anyone can script. Everything here uses the
 * same calls a reader can use: createMap, setLayers and setView.
 *
 * Not here, on purpose: a timeline. The data is one estimate for one year. The one sequence is
 * the opening, which draws the Population layer square by square, most crowded first, and replays
 * from the button under the hint or with Space.
 *
 * What you learn: how to answer "what is under the mouse?" for 100,000 squares without asking the
 * GPU, by turning the mouse position into a grid column and row, and why a threshold slider is the
 * honest way to show a share: the reader can check that 95% was not picked to flatter the result.
 */

import {
  HEAT_FADE_ZOOM,
  START_VIEW,
  createMap,
  loadSquares,
  pickColumn,
  ready,
  setLayers,
  setHover,
  setSelection,
  shareAtRank,
  squareAt,
} from "./main.js";
import { grainTile } from "./texture.js";
// After main.js, so that my rules come after MapLibre's own stylesheet.
import "./style.css";

const COLUMN_PITCH = 50; // "Draw as columns" tilts a flat map this far, so the heights show
const TILT_PITCH = 50;
const GIZA_FROM_ZOOM = 8.5; // below this, Giza would sit on Cairo's name
const CAMERA_DURATION_MS = 900;
const TAP_TOLERANCE_PX = 6;
const SHEET_CLOSED_SHARE = 0.3; // the bottom sheet's height when closed, as in style.css
const TIP_DELAY_MS = 400;
const TIP_GAP_PX = 6;
// The hover marks: corners around the square, 8 px out, the frame at least 40 px across.
// A click in 2D flies here: the real squares are drawn from zoom 9.5, and at 10.5 one 1 km square
// is about 21 px wide, big enough to see it pop out.
const CLICK_ZOOM = 10.5;
// Hover outlines start here, where the real squares are drawn and a square is about 10 px wide.
const HOVER_ZOOM = HEAT_FADE_ZOOM[1];
const FRAME_PAD_PX = 8;
const FRAME_MIN_PX = 40;
const FRAME_LEG_PX = 11;
const NOTE_GAP_PX = 18;
const NOTE_MARGIN_PX = 8;

// Labels of the public map, most important first: when two would touch, the first one stays.
const WATER_LABELS = ["Nile", "Lake Nasser"];
const LABELS = [
  "Cairo",
  "Alexandria",
  "Luxor",
  "Aswan",
  "Nile",
  "Mediterranean Sea",
  "Red Sea",
  "Western Desert",
  "Eastern Desert",
  "Sinai",
  "Siwa",
  "Kharga",
  "Lake Nasser",
  "Libya",
  "Sudan",
];

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const isPhone = window.matchMedia("(max-width: 900px)");

const $ = (selector) => document.querySelector(selector);

// What the reader has switched on. applyLayers() turns it into names for setLayers. People is
// one layer, drawn three ways: "Draw as" picks the way, the key entry shows or hides it.
const state = {
  drawAs: "heatmap",
  people: true,
  nile: true,
  border: true,
  share: 1, // the slider: draw only the most crowded squares that hold this share; 1 = everyone
};
// 2D is the heatmap (which hands over to the real squares from zoom 9), 3D the columns.
const PEOPLE_LAYER = { heatmap: "heatmap", columns: "columns_1km" };

let map = null;
let figures = null;
let curve = null;
let curveLoading = null;
let egyptRings = null;
let startView = null;
let totalPeople = "";

function applyLayers() {
  const names = ["land_sea"];
  if (state.border) names.push("egypt_border");
  // The water layer is always on: the Nile entry switches only Egypt's own rivers and lakes.
  names.push("nile_lakes");
  if (state.people) names.push(PEOPLE_LAYER[state.drawAs]);
  // The water's own names go with the Nile entry: a label over water that is not drawn names nothing.
  const labels = LABELS.filter((name) => state.nile || !WATER_LABELS.includes(name));
  if (map && map.getZoom() >= GIZA_FROM_ZOOM) labels.splice(1, 0, "Giza");
  names.push(`labels:${labels.join(", ")}`);
  // While the opening runs it leaves out the most crowded squares it has not reached yet.
  setLayers(names, { peopleShare: state.share, peopleFrom: drawFrom, waterInside: state.nile });
}

/** Camera moves ease out and never bounce, and jump for readers who asked for less motion. */
function cameraOptions() {
  return {
    duration: reducedMotion.matches ? 0 : CAMERA_DURATION_MS,
    easing: (t) => 1 - (1 - t) ** 3,
  };
}

async function fetchLayer(name) {
  const response = await fetch(new URL(`layers/${name}`, document.baseURI));
  if (!response.ok) throw new Error(`layers/${name}: HTTP ${response.status}`);
  return response.json();
}

// ---- Figures -------------------------------------------------------------------------------

/** One figure from the method line of key_figures.json, so no number is ever typed in twice. */
function fromMethod(id, pattern) {
  const figure = figures.find((f) => f.id === id);
  const match = figure?.method.match(pattern);
  if (!match) throw new Error(`key_figures.json: ${id} method has no ${pattern}`);
  return match[1];
}

function readFigures() {
  const byId = Object.fromEntries(figures.map((f) => [f.id, f]));
  return {
    people: byId.share_people_pct.display, // "95%"
    land: byId.share_land_pct.display, // "2.2%"
    landExact: byId.share_land_pct.value, // 2.2
    total: `${fromMethod("share_people_pct", /is ([\d.]+ million)/)}`, // "115.5 million"
    landKm2: fromMethod("share_land_pct", /holding 95% of people \(([\d,]+) km2\)/), // "22,090"
    egyptKm2: fromMethod("share_land_pct", /Egypt's area \(([\d,]+) km2\)/), // "1,005,130"
    share100m: fromMethod("share_land_pct", /On 100 m cells it is ([\d.]+%)/), // "0.9%"
    density: byId.inhabited_density.display, // "4,970"
    egyptDensity: byId.egypt_density.display, // "115"
    ratio: byId.density_ratio.display, // "43"
  };
}

/** Text with numbers: plain strings, and {num} parts set in the readout face. */
function appendParts(element, parts) {
  for (const part of parts) {
    if (typeof part === "string") {
      element.append(part);
    } else {
      const number = document.createElement("span");
      number.className = "num";
      number.textContent = part.num;
      element.append(number);
    }
  }
}

/** One line of In numbers: the number first, then a few plain words. The text is never a link. */
function figureLine(parts) {
  const line = document.createElement("p");
  line.className = "fig";
  const text = document.createElement("span");
  text.className = "fig-text";
  appendParts(text, parts);
  line.append(text);
  return line;
}

function renderFigures(f, meta) {
  const nbsp = "\u00a0";
  // The order reads as one line of thought: how many, how little land, how crowded that land is.
  $("#numbers").append(
    figureLine([{ num: f.total }, " people live in Egypt (2025 estimate)"]),
    figureLine([{ num: f.people }, " of them live on ", { num: `${f.landExact}%` }, " of the land"]),
    // One grid and one border for both densities, so the two numbers compare like with like.
    figureLine([
      "Along the Nile a population density of ",
      { num: f.density },
      ` per${nbsp}km² is `,
      { num: f.ratio },
      " times Egypt's average of ",
      { num: f.egyptDensity },
      ` per${nbsp}km²`,
    ]),
  );
  $("#lede-people").textContent = f.people;
  // The lede says 2.2%, as the slider readout does.
  $("#lede-land").textContent = `${f.landExact}%`;
  $("#count-people").textContent = f.total; // the entry's name already says "Population"
  $("#count-nile").textContent = `${meta.nile_km.toLocaleString("en-US")}\u00a0km`;
  $("#count-egypt").textContent = `${f.egyptKm2}\u00a0km²`;
  // The About text is written out in index.html; it must say what the data says.
  const about = $("#about").textContent.replace(/\s+/g, " ");
  const mainStem = `${meta.nile_km.toLocaleString("en-US")} km`;
  for (const needle of [`${f.landKm2} km²`, `${f.egyptKm2} km²`, `on ${f.share100m} of the`, mainStem]) {
    if (!about.includes(needle)) throw new Error(`About this map no longer matches the data: ${needle}`);
  }
  totalPeople = f.total;
  // The 100% line needs the curve too: everyone still lives on only a tenth of the land.
  return loadCurve().then((data) => {
    const entry = data.find((e) => e.people_pct === 100);
    if (!entry) throw new Error("share_curve.json has no entry for 100%");
    if (Number($("#share").value) === 100) setReadout(100, entry);
  });
}

/**
 * The slider's readout: "95% of people live on 2.2% of the land", from share_curve.json,
 * or "Everyone, 115.5 million people, lives on 10.2% of the land" at 100%.
 */
function setReadout(peoplePct, entry) {
  const readout = $("#readout");
  readout.textContent = "";
  $("#share-value").textContent = `${peoplePct}%`;
  if (peoplePct >= 100) {
    appendParts(readout, [
      "Everyone, ",
      { num: totalPeople },
      " people, lives on ",
      { num: `${entry.land_pct.toFixed(1)}%` },
      " of the land",
    ]);
    return;
  }
  appendParts(readout, [
    { num: `${peoplePct}%` },
    " of people live on ",
    { num: `${entry.land_pct.toFixed(1)}%` },
    " of the land",
  ]);
}

function renderFetched(meta) {
  // Calendar days with no time: formatted in UTC, so a time zone behind UTC does not shift them.
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

// ---- Squares on demand ---------------------------------------------------------------------

/** The 1 km squares and the share curve load on first use, never before the first draw. */
function loadCurve() {
  curveLoading ??= fetchLayer("share_curve.json").then((data) => {
    curve = data;
    return data;
  });
  return curveLoading;
}

let egyptLoading = null;
function loadEgypt() {
  egyptLoading ??= fetchLayer("land.json").then((land) => {
    const egypt = land.features.filter((feature) => feature.properties.egypt);
    egyptRings = egypt.flatMap((feature) =>
      feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates,
    );
  });
  return egyptLoading;
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inEgypt(point) {
  return (egyptRings ?? []).some(
    ([outer, ...holes]) => pointInRing(point, outer) && !holes.some((hole) => pointInRing(point, hole)),
  );
}

// ---- Annotation ----------------------------------------------------------------------------

// The note opened by a click stays until the reader clicks elsewhere or presses Escape. There is
// no hover note on this map, so hoverNote stays empty.
let pinnedNote = null;
let hoverNote = null;

const currentNote = () => hoverNote ?? pinnedNote;

/** People rounded to 10, so the note does not pretend the estimate counts single people. */
function roundTen(value) {
  return (Math.round(value / 10) * 10).toLocaleString("en-US");
}

/**
 * Where the square stands among all of Egypt's squares with people in them: "Among Egypt's 3%
 * most crowded squares", or from the other end for the emptier half. I round the share up, so
 * the densest square of all reads 0.1%, never 0%.
 */
function rankLine(square) {
  const fromTop = (square.rank / square.of) * 100;
  const fromBottom = ((square.of - square.rank + 1) / square.of) * 100;
  const up = (value) => (value < 1 ? Math.max(0.1, Math.ceil(value * 10) / 10) : Math.ceil(value));
  return fromTop <= 50
    ? ["Among Egypt's ", { num: `${up(fromTop)}%` }, " most crowded squares"]
    : ["Among Egypt's ", { num: `${up(fromBottom)}%` }, " least crowded squares with people"];
}

function squareNote(square, lngLat) {
  const pct = Math.round(state.share * 100);
  const nbsp = "\u00a0";
  // The square is 1 km², so its people are its density: one number says both, and it is the title.
  let title;
  if (square.index === null) title = [`No one lives on this${nbsp}km²`];
  else if (square.people < 5) title = ["Fewer than ", { num: "10" }, ` people live on this${nbsp}km²`];
  else title = [{ num: roundTen(square.people) }, ` people live on this${nbsp}km²`];
  return {
    key: square.ring[0].join(","),
    lngLat: [lngLat.lng, lngLat.lat],
    ring: square.ring,
    index: square.index,
    title,
    values: square.index === null ? null : rankLine(square),
    // Only while the slider filters: every square still drawn is one of the kept ones.
    status: pct < 100 ? `One of the most crowded squares that hold ${pct}% of people` : null,
  };
}

function fillNote(note) {
  const element = $("#annotation");
  element.textContent = "";
  const name = document.createElement("h3");
  appendParts(name, note.title);
  element.append(name);
  if (note.values) {
    const body = document.createElement("p");
    appendParts(body, note.values);
    element.append(body);
  }
  if (note.status) {
    const status = document.createElement("p");
    status.textContent = note.status;
    element.append(status);
  }
  const source = document.createElement("p");
  source.className = "source";
  source.textContent = "Source: GHS-POP 2025, European Commission JRC";
  element.append(source);
}

function overlaps(a, b, padPx) {
  return a.left < b.right + padPx && a.right > b.left - padPx && a.top < b.bottom + padPx && a.bottom > b.top - padPx;
}

/**
 * The frame around a square on screen: its four corners projected, plus 8 px, and never under
 * 40 px, so a square only a few pixels wide still gets marks the eye can find. In 3D the ring is
 * the column's foot on the ground, so the marks sit around its base.
 */
function frameFor(ring) {
  const area = map.getContainer().getBoundingClientRect();
  const points = ring.slice(0, 4).map((corner) => map.project(corner));
  let left = Math.min(...points.map((p) => p.x)) - FRAME_PAD_PX;
  let right = Math.max(...points.map((p) => p.x)) + FRAME_PAD_PX;
  let top = Math.min(...points.map((p) => p.y)) - FRAME_PAD_PX;
  let bottom = Math.max(...points.map((p) => p.y)) + FRAME_PAD_PX;
  const grow = (low, high) => {
    const missing = Math.max(0, FRAME_MIN_PX - (high - low)) / 2;
    return [low - missing, high + missing];
  };
  [left, right] = grow(left, right);
  [top, bottom] = grow(top, bottom);
  return { left: left + area.left, right: right + area.left, top: top + area.top, bottom: bottom + area.top };
}

/** Four L-shaped corners round the frame, each on a sand casing. The square itself pops out (main.js). */
function drawFrame(frame, ring) {
  const svg = $("#frame");
  const { left: l, right: r, top: t, bottom: b } = frame;
  const leg = FRAME_LEG_PX;
  // Each corner is its own group, so the opening motion can slide it in from its own side.
  const corners = {
    tl: `M${l} ${t + leg}V${t}H${l + leg}`,
    tr: `M${r - leg} ${t}H${r}V${t + leg}`,
    br: `M${r} ${b - leg}V${b}H${r - leg}`,
    bl: `M${l + leg} ${b}H${l}V${b - leg}`,
  };
  for (const [corner, d] of Object.entries(corners)) {
    for (const path of svg.querySelectorAll(`.c-${corner} path`)) path.setAttribute("d", d);
  }

}

/** Screen boxes the note must stay clear of: the hint line, the map buttons, the title. */
function noteObstacles() {
  return ["#hint", "#buttons", "#title h1", "#title p", "#sheet-open"]
    .map((selector) => $(selector))
    .filter((element) => element && !element.hidden)
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
}

/**
 * The note beside the frame, with no rule and no box: 18 px to its right, its first line level
 * with the frame's top. If that does not fit (an edge, the hint, the buttons), it tries the left
 * side, then below and above the frame; on a phone with no room beside the square it sits at the
 * foot of the map, just above the bottom sheet. It never covers the clicked square.
 */
function placeNote() {
  const note = currentNote();
  const element = $("#annotation");
  const svg = $("#frame");
  if (!note) {
    element.hidden = true;
    svg.setAttribute("hidden", "");
    for (const label of document.querySelectorAll(".map-label.under-note")) label.classList.remove("under-note");
    return;
  }
  element.hidden = false;
  svg.removeAttribute("hidden");
  const frame = frameFor(note.ring);
  drawFrame(frame, note.ring);
  const area = map.getContainer().getBoundingClientRect();
  const { width, height } = element.getBoundingClientRect();
  const m = NOTE_MARGIN_PX;
  const gap = NOTE_GAP_PX;
  // Beside the frame first; then, when there is no room beside it (a phone), across the map just
  // above the hint line or just under the title, wherever it does not cover the square.
  // Set from the map's left edge, so it stays clear of the map buttons on the right.
  const across = area.left + m;
  const hint = $("#hint").getBoundingClientRect();
  const title = $("#title p").getBoundingClientRect();
  const candidates = [
    [frame.right + gap, frame.top],
    [frame.left - gap - width, frame.top],
    [frame.left, frame.bottom + gap],
    [frame.left, frame.top - gap - height],
    [across, hint.top - gap - height],
    [across, title.bottom + gap],
  ];
  const obstacles = noteObstacles();
  const fits = ([left, top]) => {
    const rect = { left, top, right: left + width, bottom: top + height };
    const inside = left >= area.left + m && top >= area.top + m && rect.right <= area.right - m && rect.bottom <= area.bottom - m;
    return inside && !overlaps(rect, frame, 0) && !obstacles.some((o) => overlaps(rect, o, 6));
  };
  let spot = candidates.find(fits);
  if (!spot) {
    // Nowhere free: at the foot of the map, just above the bottom sheet on a phone, clear of the
    // frame if it can be, else at the top.
    const footTop = area.bottom - m - height;
    const left = Math.min(Math.max(frame.left, area.left + m), area.right - m - width);
    const footRect = { left, top: footTop, right: left + width, bottom: footTop + height };
    spot = overlaps(footRect, frame, 0) ? [left, area.top + m] : [left, footTop];
  }
  const [left, top] = spot;
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
  // A place name under the note or the frame steps aside while they are open: two things printed
  // on top of each other read as neither.
  const rect = { left, top, right: left + width, bottom: top + height };
  for (const label of document.querySelectorAll(".map-label")) {
    const text = label.querySelector(".text").getBoundingClientRect();
    label.classList.toggle("under-note", overlaps(rect, text, 4) || overlaps(frame, text, 4));
  }
}

/** The opening motion (style.css): the corners slide in 6 px and the note fades in, 180 ms. */
function playOpening() {
  if (reducedMotion.matches) return;
  for (const element of [$("#frame"), $("#annotation")]) {
    element.classList.remove("opening");
    void element.getBoundingClientRect(); // restart the animation on a new square
    element.classList.add("opening");
  }
}

function showCurrentNote() {
  const note = currentNote();
  if (note) {
    fillNote(note);
    playOpening();
  }
  setSelection(note?.index ?? null); // in 3D the hovered or pinned column turns wine
  placeNote();
}

function closeNote() {
  pinnedNote = null;
  hoverNote = null;
  showCurrentNote();
}

/** The square under a mouse or finger, as a note, or null where there is nothing to say. */
function noteAt(event) {
  const { lngLat, point } = event;
  if (state.drawAs === "columns" && state.people) {
    const column = pickColumn(point.x, point.y);
    if (column) return squareNote(column, { lng: column.lon, lat: column.lat });
  }
  const square = squareAt(lngLat.lng, lngLat.lat);
  if (!square) return null;
  // While the slider filters, only the squares still drawn can be clicked.
  if (state.share < 1 && (square.index === null || square.cumBefore >= state.share)) return null;
  if (square.index === null && !inEgypt([lngLat.lng, lngLat.lat])) return null;
  return squareNote(square, lngLat);
}

function setupNotes() {
  // The note opens on a click (a tap on touch). Hover never opens a note; close enough to see
  // single squares it outlines the square under the mouse and shows a pointer (setupHover).
  // A click on another square moves the note there; a click on the same square,
  // outside Egypt's squares, or Escape closes it. The squares load on the first click.
  const loadAll = () => Promise.all([loadSquares(), loadEgypt()]);
  map.on("click", async (event) => {
    await loadAll();
    const note = noteAt(event);
    if (!note || (pinnedNote && note.key === pinnedNote.key)) {
      closeNote();
      return;
    }
    hoverNote = null;
    // In 2D a click flies in to where the real 1 km squares are drawn, so the reader sees the
    // square itself pop out, then opens the note. Closer than that the map stays where it is.
    // In 3D the camera stays: the clicked column turns wine where it stands.
    const ring = note.ring;
    const centre = [(ring[0][0] + ring[2][0]) / 2, (ring[0][1] + ring[2][1]) / 2];
    if (state.drawAs === "heatmap" && map.getZoom() < CLICK_ZOOM) {
      pinnedNote = null;
      showCurrentNote();
      map.easeTo({ center: centre, zoom: CLICK_ZOOM, ...cameraOptions() });
      map.once("moveend", () => {
        pinnedNote = note;
        showCurrentNote();
      });
      return;
    }
    pinnedNote = note;
    showCurrentNote();
  });
  map.on("move", placeNote);
  // The note belongs to a square the reader can see. In 2D, once the reader zooms back out to
  // the smoothed surface (below zoom 9, where the real squares have faded out), it closes.
  map.on("zoom", () => {
    if (pinnedNote && state.drawAs === "heatmap" && map.getZoom() < HEAT_FADE_ZOOM[0]) closeNote();
  });
}

/**
 * Hover, from HOVER_ZOOM in 2D and 3D: the square or column under the mouse gets a thin silt
 * outline and the cursor turns to a pointer, so the reader sees what a click would pick. Further
 * out a square is a few pixels wide and an outline would only flicker, so nothing happens there.
 * Touch has no hover; a tap opens the note as before.
 */
function setupHover() {
  const clear = () => setHover(null);
  let last = null;
  let frame = null;
  const look = () => {
    frame = null;
    if (!state.people || map.getZoom() < HOVER_ZOOM) return clear();
    const square =
      state.drawAs === "columns"
        ? pickColumn(last.point.x, last.point.y)
        : squareAt(last.lngLat.lng, last.lngLat.lat);
    // Only squares with people that the slider still draws.
    if (!square || square.index === null || square.cumBefore >= state.share) return clear();
    setHover(square.index); // main.js turns the cursor into a pointer with it
  };
  map.on("mousemove", (event) => {
    last = event;
    // One lookup per frame at most: the GPU pick in 3D is not free.
    frame ??= requestAnimationFrame(look);
  });
  map.getCanvas().addEventListener("mouseleave", clear);
  map.on("movestart", clear);
}

// ---- Sheet ---------------------------------------------------------------------------------

function showKeyState() {
  const pressed = {
    people: state.people,
    nile: state.nile,
    border: state.border,
  };
  for (const entry of document.querySelectorAll(".k")) {
    entry.setAttribute("aria-pressed", String(pressed[entry.dataset.layer]));
  }
  for (const button of document.querySelectorAll("[data-draw]")) {
    button.setAttribute("aria-pressed", String(button.dataset.draw === state.drawAs));
  }
  document.body.dataset.draw = state.drawAs;
}

function setDrawAs(drawAs) {
  state.drawAs = drawAs;
  state.people = true;
  // 3D needs a tilt to show the heights, so a flat map tilts to 50 degrees; 2D is a flat surface,
  // so a tilted map eases back to flat.
  if (drawAs === "columns" && map.getPitch() < 5) map.easeTo({ pitch: COLUMN_PITCH, ...cameraOptions() });
  if (drawAs === "heatmap" && map.getPitch() > 0) map.easeTo({ pitch: 0, ...cameraOptions() });
  showKeyState();
  applyLayers();
}

function setupKey() {
  // The key is also the layer switch: click an entry, and its sample and its layer go together.
  for (const entry of document.querySelectorAll(".k")) {
    entry.addEventListener("click", () => {
      const layer = entry.dataset.layer;
      state[layer] = !state[layer];
      showKeyState();
      applyLayers();
    });
  }
  for (const button of document.querySelectorAll("[data-draw]")) {
    button.addEventListener("click", () => setDrawAs(button.dataset.draw));
  }
}

function setupSlider() {
  // The share filters the Population layer: the 1 km squares and columns on the GPU, the heatmap by
  // drawing only its first k squares (main.js). Input can come many times a frame, so the map is
  // updated at most once per animation frame. The readout comes from share_curve.json, the key
  // figures' own sums, loaded on the first move.
  const input = $("#share");
  let frame = null;
  input.addEventListener("input", async () => {
    const pct = Number(input.value);
    state.share = pct / 100;
    $("#share-value").textContent = `${pct}%`;
    if (frame === null) {
      frame = requestAnimationFrame(() => {
        frame = null;
        applyLayers();
        refreshNote();
      });
    }
    const data = await loadCurve();
    const entry = data.find((e) => e.people_pct === pct);
    if (!entry) throw new Error(`share_curve.json has no entry for ${pct}%`);
    if (Number(input.value) === pct) setReadout(pct, entry);
  });
}

/** The open note follows the slider: its third line changes, and it closes if its square goes. */
function refreshNote() {
  const note = currentNote();
  if (!note) return;
  const square = squareAt(note.lngLat[0], note.lngLat[1]);
  if (!square || (state.share < 1 && (square.index === null || square.cumBefore >= state.share))) {
    closeNote();
    return;
  }
  pinnedNote = squareNote(square, { lng: note.lngLat[0], lat: note.lngLat[1] });
  hoverNote = null;
  fillNote(pinnedNote);
  placeNote();
}

function setupInfoTip(button, tip) {
  // A how-to-read note: on hover and focus, and on touch a tap toggles it.
  const place = () => {
    const box = button.getBoundingClientRect();
    tip.hidden = false;
    const left = Math.min(box.left, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${box.bottom + TIP_GAP_PX}px`;
  };
  const hide = () => {
    tip.hidden = true;
  };
  button.addEventListener("pointerenter", (event) => event.pointerType === "mouse" && place());
  button.addEventListener("pointerleave", (event) => event.pointerType === "mouse" && hide());
  button.addEventListener("focus", () => button.matches(":focus-visible") && place());
  button.addEventListener("blur", hide);
  button.addEventListener("click", (event) => {
    if (event.pointerType === "mouse") return;
    if (tip.hidden) place();
    else hide();
  });
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && !tip.hidden) {
        hide();
        event.stopImmediatePropagation();
      }
    },
    { capture: true },
  );
  return hide;
}

function setupFold() {
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
  grab.addEventListener("pointerup", () => {
    if (dragStartY === null) return;
    dragStartY = null;
    if (moved) setOpen(sheet.getBoundingClientRect().height > window.innerHeight * 0.6);
    else setOpen(!document.body.classList.contains("sheet-open"));
  });
  // After a touch the browser sends a click to whatever is under the finger by then, which would
  // be the map once the sheet has changed height. Cancelling touchend on the grab line stops it.
  grab.addEventListener("touchend", (event) => event.preventDefault(), { passive: false });
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

// ---- Map buttons, tooltips, dialogs --------------------------------------------------------

function setupButtons() {
  $("#zoom-in").addEventListener("click", () => map.zoomIn(cameraOptions()));
  $("#zoom-out").addEventListener("click", () => map.zoomOut(cameraOptions()));
  $("#north").addEventListener("click", () => map.easeTo({ bearing: 0, pitch: 0, ...cameraOptions() }));
  $("#tilt").addEventListener("click", () =>
    map.easeTo({ pitch: map.getPitch() > 1 ? 0 : TILT_PITCH, ...cameraOptions() }),
  );
  $("#start-view").addEventListener("click", () => map.easeTo({ ...startView, ...cameraOptions() }));
  // The 3D button says what a click will do, so its name changes with the tilt; "on" is only a
  // heavier drawing, not a filled button.
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
  // A small label beside the map buttons, the dialogs' close
  // buttons. Its text is the button's aria-label, so what a screen reader says and what the eye
  // reads never drift apart. No title attribute: the browser's own tooltip comes late and never
  // shows on focus.
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
    button.addEventListener("focus", () => {
      if (button.matches(":focus-visible")) show();
    });
    button.addEventListener("blur", () => {
      if (tip.shownFor === button) hide(tip);
    });
    button.addEventListener("click", () => hide(tip));
  };
  for (const button of strip.querySelectorAll("button")) attach(button, pageTip, () => strip.getBoundingClientRect());
  // A modal dialog sits in the browser's top layer, so each dialog carries its own label element.
  for (const dialog of document.querySelectorAll("dialog")) {
    const tip = dialog.querySelector(".tip");
    tips.push(tip);
    attach(dialog.querySelector("form.close button"), tip);
    dialog.addEventListener("close", () => hide(tip));
  }
  // The 3D button renames itself once the camera has tilted, so the label watches the name.
  new MutationObserver(() => {
    if (pageTip.shownFor) place(pageTip, pageTip.shownFor, pageTip.besideBox);
  }).observe(strip, { attributes: true, attributeFilter: ["aria-label"], subtree: true });
  // Esc hides a tooltip first, before it closes the note or folds the sheet.
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

function setupDialogs() {
  // Native <dialog> with showModal(): the browser keeps focus inside, makes the page behind inert
  // and closes it on Esc. I add a click on the backdrop to close it, and focus on the dialog
  // itself when it opens, then back on the opener.
  for (const name of ["about", "download"]) {
    const dialog = $(`#${name}`);
    const opener = $(`#${name}-open`);
    opener.addEventListener("click", () => {
      dialog.showModal();
      dialog.scrollTop = 0;
      dialog.focus();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      const inside =
        event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (!inside) dialog.close();
    });
    dialog.addEventListener("close", () => opener.focus());
  }
}

// ---- Opening and replay --------------------------------------------------------------------

/*
 * The opening draws the Population layer square by square, from the emptiest up to the most crowded:
 * the oases and villages first, then the valley, and the cities last, so the colour builds from
 * saffron to wine as the crowds arrive. It runs on the squares' rank, not on the share of people:
 * by people, the thin fringe would be over in a blink and Cairo would take half the time. The rank
 * eases out (1 - (1 - t)³): four fifths of the squares hold only a tenth of the people and barely
 * show on the smoothed surface, so they pass quickly, and the valley and the cities take the
 * last two thirds of the time.
 */
const OPENING_MS = 3200;
const OPENING_DELAY_MS = 400; // counted on animation frames once the map is ready
const MAX_STEP_MS = 500; // one slow frame never jumps the opening ahead by more than this
let drawFrom = 0; // the share of people, in the most crowded squares, not drawn yet; 0 when done
let opening = null; // the running opening's animation frame, or null

/** Draw the emptiest fraction of the squares (0 to 1). */
function drawPeople(fraction) {
  drawFrom = fraction >= 1 ? 0 : shareAtRank(1 - fraction);
  applyLayers();
}

/** Any drag, zoom or click on the map stops the opening at once and shows the whole layer. */
function stopOpening() {
  if (opening === null) return;
  cancelAnimationFrame(opening);
  opening = null;
  drawFrom = 0;
  applyLayers();
}

function playOpeningDraw(delayMs = 0) {
  if (opening !== null) cancelAnimationFrame(opening);
  closeNote();
  if (!state.people) {
    state.people = true;
    showKeyState();
  }
  drawPeople(0);
  let elapsed = -delayMs;
  let last = null;
  const step = (now) => {
    if (last !== null) elapsed += Math.min(MAX_STEP_MS, now - last);
    last = now;
    const t = Math.min(1, Math.max(0, elapsed / OPENING_MS));
    if (t < 1) {
      drawPeople(1 - (1 - t) ** 3);
      opening = requestAnimationFrame(step);
    } else {
      opening = null;
      drawFrom = 0;
      applyLayers();
    }
  };
  opening = requestAnimationFrame(step);
}

function setupReplay() {
  $("#replay").addEventListener("click", () => playOpeningDraw());
  // Space replays, unless the focus is on something where Space already means something.
  window.addEventListener("keydown", (event) => {
    if (event.key !== " " || event.repeat || document.querySelector("dialog[open]")) return;
    if (event.target.closest?.("input, button, textarea, select, [contenteditable]")) return;
    event.preventDefault();
    playOpeningDraw();
  });
  const canvas = map.getCanvas();
  for (const type of ["pointerdown", "wheel", "touchstart"]) {
    canvas.addEventListener(type, stopOpening, { capture: true, passive: true });
  }
}

// ---- Start ---------------------------------------------------------------------------------

/** The page's print texture: sand grain and vignette, above the map, under the sheet. */
function drawTexture() {
  $("#grain").style.backgroundImage = `url(${grainTile()})`;
}

/**
 * The title needs no box over the sea or the empty desert. Once the reader moves Egypt under it,
 * dots may lie behind the letters, and only then a soft sand wash keeps them at 4.5:1 or better.
 */
function setupTitleWash() {
  const title = $("#title");
  const update = () => {
    // MapLibre already holds Egypt's outline: I ask it whether any of Egypt is drawn under the
    // title's text, which is exact where a bounding box would also catch the sea above the coast.
    const area = map.getContainer().getBoundingClientRect();
    const boxes = ["#title h1", "#title p"].map((s) => $(s).getBoundingClientRect());
    const left = Math.min(...boxes.map((b) => b.left)) - area.left;
    const right = Math.max(...boxes.map((b) => b.right)) - area.left;
    const top = Math.min(...boxes.map((b) => b.top)) - area.top;
    const bottom = Math.max(...boxes.map((b) => b.bottom)) - area.top;
    const under = map.queryRenderedFeatures(
      [
        [Math.max(0, left), Math.max(0, top)],
        [Math.max(0, right), Math.max(0, bottom)],
      ],
      { layers: ["land"], filter: ["==", ["get", "egypt"], true] },
    );
    title.classList.toggle("washed", under.length > 0);
  };
  map.on("moveend", update);
  map.on("move", update);
  update();
}

function fitPadding() {
  // Room for the title at the top and the hint at the foot, so all of Egypt is clear.
  return isPhone.matches
    ? { top: 96, bottom: 70, left: 12, right: 12 }
    : { top: 120, bottom: 110, left: 40, right: 80 };
}

async function start() {
  drawTexture();
  const autoplay = !reducedMotion.matches;
  if (autoplay) drawFrom = 1;
  const created = await createMap("map", {
    view: { ...START_VIEW },
    fitPadding: fitPadding(),
    // Names stay clear of the title, the lede and the hint, which lie over the map.
    labelAvoid: () =>
      ["#title h1", "#title p", "#hint", "#replay", "#buttons"].map((s) => $(s).getBoundingClientRect()),
    layers: ["land_sea", "egypt_border", "nile_lakes", "heatmap", `labels:${LABELS.join(", ")}`],
    // The opening starts from an empty Population layer, so the frame ready waits for is its first
    // step. Readers who asked for less motion get the whole layer at once.
    layerOptions: { peopleFrom: autoplay ? 1 : 0 },
  });
  map = created.map;
  figures = created.figures;
  startView = { center: map.getCenter(), zoom: map.getZoom(), pitch: 0, bearing: 0 };
  const meta = await fetchLayer("meta.json");
  renderFetched(meta);
  const readoutShown = renderFigures(readFigures(), meta);
  applyLayers();

  let gizaShown = map.getZoom() >= 8.5;
  map.on("zoom", () => {
    const now = map.getZoom() >= GIZA_FROM_ZOOM;
    if (now !== gizaShown) {
      gizaShown = now;
      applyLayers();
    }
  });

  setupKey();
  setupSlider();
  setupInfoTip($("#info"), $("#info-tip"));
  setupInfoTip($("#share-info"), $("#share-tip"));
  showKeyState();
  setupButtons();
  setupDialogs();
  setupTooltips();
  setupNotes();
  setupHover();
  setupReplay();
  setupTitleWash();
  setupKeyboard(setupFold(), setupBottomSheet());
  // Handy in the browser console: the live MapLibre map.
  window.map = map;
  // The start view counts as drawn only with the slider's readout filled in, too.
  await Promise.all([ready, readoutShown]);
  document.body.dataset.ready = "true";
  if (autoplay) playOpeningDraw(OPENING_DELAY_MS);
}

start().catch((error) => {
  console.error(error);
  const note = document.createElement("p");
  note.id = "load-error";
  note.textContent = `The map could not load: ${error.message}`;
  document.body.append(note);
});

