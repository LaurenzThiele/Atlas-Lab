/* The furniture around the plate: title, key, figures, sources, map buttons, timeline, annotation.

   What it does: fills the sheet from the layers and wires every control to the same road state
   the map already uses. app.js starts it on the public page; main.js never does, so a page built
   on the map's API alone gets none of it.
   Reads:  the layers main.js has loaded, totals.json and events.json (both written by prepare.py).

   What you learn: how to set controls like a printed atlas. Key entries are the layer switches, a
   figure is a sentence with a footnote, and the timeline is a ruled axis. The lengths in the key
   come from totals.json, which prepare.py sums from the exact geometry, so each group adds up to
   the headline instead of drifting by a kilometre of rounding. */

import { NO_SEGMENT } from "./main.js";

// The start of the draw is Rome, and 450 km of network per second crosses the empire in 20 s.
const PLAY_KM_PER_S = 450;
const SPEEDS = [
  { label: "½×", factor: 0.5 },
  { label: "1×", factor: 1 },
  { label: "4×", factor: 4 },
];
const STEP_KM = 100; // one press of the left or right arrow
const TICK_EVERY_KM = 2000;
// The 3D button is a plain switch, flat or tilted, so its tooltip can always say what the click does.
const TILT_DEG = 50;
// A tooltip waits this long under the mouse, so passing over the strip does not flash labels.
const TIP_DELAY_MS = 400;
const CAMERA_MS = 800;
const SHOW_ON_MAP_ZOOM = 6.5; // close enough to see the road end, with its region around it
export const PHONE_QUERY = "(max-width: 900px)";
// The phone sheet rests at this share of the screen height: --sheet-closed (30dvh) in style.css.
const SHEET_REST_SHARE = 0.3;
// Half of this moves the plate to the right, which clears the title and lede from Britain. The
// camera target stays the same, so the map itself is drawn exactly as before.
export const TITLE_ROOM_PX = 150;

// Colour is road type and pattern is certainty, on the map and here. A pattern applies to both
// road types, so the certainty samples are drawn in plain ink, as on the printed plate's legend.
// MapLibre measures dashes in line widths, so I multiply them out at the main road's width.
const MAIN_PX = 1.6;
const SECONDARY_PX = 0.6;
const PATTERN_PX = 1.6;
const CERTAINTY = [
  { c: 1, name: "Certain", dash: null },
  { c: 2, name: "Conjectured", dash: [3, 2] },
  { c: 3, name: "Hypothetical", dash: [0.5, 1.5] },
];

// On a phone the whole network is fitted inside the map area, clear of the furniture around it.
const FIT_GAP_PX = 12;
// The title gets a wash of paper only when the map behind it gets too dark for 4.5:1. The grain
// sits on top of the map canvas and darkens it by up to about this share, so I allow for it.
const TITLE_CONTRAST_MIN = 4.5;
const GRAIN_DARKENING = 0.12;
const INK_RGB = [42, 33, 24];
const PAPER_RGB = [239, 228, 200]; // the Parchment page that shows wherever the globe is not
// A single coastline or road through the letters already spoils a word, so I judge by the darkest
// 1 % of the pixels behind the text, not by their average.
const DARKEST_SHARE = 0.01;
// The cartouche stands this far from the middle of its road, on whichever side is clear.
const NOTE_GAP_PX = 44;

const RIVER_LAYERS = ["rivers", "lakes", "lakes_outline", "coast", "coast_ripples"];
const SVG_NS = "http://www.w3.org/2000/svg";
const PLAY_PATH = "M6 4v12l10-6z";
const PAUSE_PATH = "M6 4h3v12H6zM11 4h3v12h-3z";

const byId = (id) => document.getElementById(id);
const km = (value) => Math.round(value).toLocaleString("en-US");
// An ease-out curve: camera moves start at speed and settle, with no bounce.
const easeOut = (t) => 1 - (1 - t) ** 3;

/* ---- readout face ---- */

// One box per digit, so the number stays still as it counts instead of jittering sideways.
function setReadout(element, text) {
  const boxes = [...text].map((character) => {
    const box = document.createElement("span");
    if (/\d/.test(character)) box.className = "digit";
    box.textContent = character;
    return box;
  });
  element.replaceChildren(...boxes);
  element.setAttribute("aria-label", text);
}

/* ---- the key ---- */

function sampleLine(svg, y, color, widthPx, dash) {
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("x1", "0");
  line.setAttribute("x2", "34");
  line.setAttribute("y1", String(y));
  line.setAttribute("y2", String(y));
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", String(widthPx));
  if (dash) {
    line.dataset.dash = dash.map((part) => part * widthPx).join(" ");
    line.setAttribute("stroke-dasharray", line.dataset.dash);
    // The map draws dotted roads with round caps, so the sample does too.
    if (dash[0] < 1) line.setAttribute("stroke-linecap", "round");
  }
  svg.append(line);
}

function sample(lines) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "sample");
  svg.setAttribute("viewBox", "0 0 34 14");
  svg.setAttribute("aria-hidden", "true");
  for (const line of lines) sampleLine(svg, ...line);
  return svg;
}

function keyEntry(holder, { name, value, lines, onToggle }) {
  const entry = document.createElement("button");
  entry.type = "button";
  entry.className = "entry";
  entry.setAttribute("aria-pressed", "true");
  const label = document.createElement("span");
  label.className = "entry-name";
  label.textContent = name;
  const count = document.createElement("span");
  count.className = "entry-count";
  count.textContent = value ?? "";
  entry.count = count;
  entry.append(sample(lines), label, count);
  entry.addEventListener("click", () => {
    const shown = entry.classList.toggle("off") === false;
    entry.setAttribute("aria-pressed", String(shown));
    onToggle(shown);
  });
  holder.append(entry);
  return entry;
}

function buildKey({ map, write, roads, maxKm, totalsReady, figures }) {
  const { state, apply } = roads;
  const rubric = "var(--rubric)";
  const sepia = "var(--sepia)";
  const ink = "var(--iron-gall)";
  const inkBlue = "var(--ink-blue)";
  const flip = (list, value, shown) =>
    shown ? [...list, value].sort() : list.filter((item) => item !== value);

  const roadHolder = byId("key-roads");
  const mainEntry = keyEntry(roadHolder, {
    name: "Main roads",
    lines: [[7.5, rubric, MAIN_PX]],
    onToggle(shown) {
      state.types = flip(state.types, 1, shown);
      apply();
    },
  });
  const secondaryEntry = keyEntry(roadHolder, {
    name: "Secondary roads",
    lines: [[7.5, sepia, SECONDARY_PX]],
    onToggle(shown) {
      state.types = flip(state.types, 2, shown);
      apply();
    },
  });

  const certaintyHolder = byId("key-certainty");
  const certaintyEntries = new Map();
  for (const { c, name, dash } of CERTAINTY) {
    certaintyEntries.set(
      name,
      keyEntry(certaintyHolder, {
        name,
        lines: [[7.5, ink, PATTERN_PX, dash]],
        onToggle(shown) {
          state.classes = flip(state.classes, c, shown);
          apply();
        },
      }),
    );
  }

  // The lengths arrive with totals.json. Each group must add up to the headline figure, or the
  // key would contradict the lede, so I stop loudly if one does not.
  totalsReady.then((totals) => {
    const headline = Math.round(figures.get("total_road_km").value);
    for (const group of ["type_display_km", "certainty_display_km"]) {
      const sum = Object.values(totals[group]).reduce((a, b) => a + b, 0);
      if (sum !== headline) throw new Error(`${group} adds up to ${sum} km, not ${headline} km`);
    }
    mainEntry.count.textContent = `${km(totals.type_display_km["Main Road"])} km`;
    secondaryEntry.count.textContent = `${km(totals.type_display_km["Secondary Road"])} km`;
    for (const [name, entry] of certaintyEntries) {
      entry.count.textContent = `${km(totals.certainty_display_km[name])} km`;
    }
  });

  keyEntry(byId("key-water"), {
    name: "Rivers and coast",
    lines: [[7.5, inkBlue, 0.8]],
    onToggle(shown) {
      for (const layer of RIVER_LAYERS) write.visible(layer, shown);
      map.triggerRepaint();
    },
  });

  /* The public map always draws the line patterns, since they carry the certainty. The plain plate
     view keeps its solid lines. The solid layers stay in place at zero opacity under the patterns,
     because they carry the road ids the annotation reads. */
  function drawAs(pattern) {
    state.patternToKm = pattern ? maxKm : -1;
    state.solidOpacity = pattern ? 0 : 1;
    // The key always shows what the map draws: no dashes in the samples when the lines are solid.
    for (const line of certaintyHolder.querySelectorAll("line")) {
      if (line.dataset.dash) {
        line.setAttribute("stroke-dasharray", pattern ? line.dataset.dash : "none");
      }
    }
    apply();
  }
  return drawAs;
}

/* ---- in numbers ---- */

// A line is plain text: the number in the readout face, then its unit and a few words in the text
// face, so "299,171 km" keeps a normal space. It is never a link.
function figureSentence(holder, value, words) {
  const [, digits, unit] = value.match(/^([\d.,]+)(.*)$/);
  const sentence = document.createElement("p");
  sentence.className = "figure";
  const text = document.createElement("span");
  const number = document.createElement("b");
  number.className = "readout-face";
  setReadout(number, digits);
  text.append(number, `${unit} ${words}`);
  sentence.append(text);
  holder.append(sentence);
  return sentence;
}

// A line with a place on the map ends in one small button, a crosshair, that flies there. The text
// itself stays text, so a reader who selects or taps it never moves the map by accident.
function addShowOnMap(sentence) {
  sentence.classList.add("has-place");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "show-on-map has-tip";
  button.setAttribute("aria-label", "Show on map");
  button.dataset.tipSide = "below";
  button.innerHTML =
    '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="1.3" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/>' +
    '<path d="M7 0.5v3M7 10.5v3M0.5 7h3M10.5 7h3"/></svg>';
  sentence.append(button);
  return button;
}

// I fail loudly if a display text changes shape, instead of cutting it in the wrong place.
function splitDisplay(figure, pattern) {
  const match = figure.display.match(pattern);
  if (!match) throw new Error(`${figure.id}: unexpected display "${figure.display}"`);
  return match.slice(1);
}

function buildFigures(figures) {
  const holder = byId("figures");
  const total = figures.get("total_road_km");
  const around = figures.get("times_around_earth");
  const [totalValue] = splitDisplay(total, /^([\d,]+ km)$/);
  const [timesValue, timesWords] = splitDisplay(around, /^([\d.]+ times) (around the Earth)$/);
  const [farthestValue] = splitDisplay(figures.get("farthest_km"), /^([\d,]+ km)$/);
  byId("lede-total").textContent = totalValue;
  figureSentence(holder, totalValue, "of known Roman road");
  figureSentence(holder, timesValue, timesWords);
  // key_figures.py measures this along the network with prepare.py's own code, and that route
  // has no sea crossing on it. Lines with a place on the map come last.
  const farthest = figureSentence(holder, farthestValue, "by road to the farthest point from Rome");
  return { farthestButton: addShowOnMap(farthest) };
}

// The crosshair flies to the farthest point and opens the note on its road, which marks that road
// as the one highlight. flyTo jumps instead when the reader asks for reduced motion.
function wireShowOnMap({ map, button, targetReady, annotation, sheet }) {
  button.addEventListener("click", async () => {
    const target = await targetReady;
    const lngLat = { lng: target.lon, lat: target.lat };
    sheet.rest();
    annotation.close();
    map.flyTo({
      center: lngLat,
      zoom: Math.max(map.getZoom(), SHOW_ON_MAP_ZOOM),
      duration: CAMERA_MS,
      easing: easeOut,
    });
    // The highlight reads the road pieces on screen, so it waits until the camera has arrived.
    map.once("moveend", () => annotation.openAt(target.s, lngLat));
  });
}

/* ---- the timeline band ---- */

function createTimeline({ map, roads, drawCurve, figures, layerUrl }) {
  const { state, apply } = roads;
  const maxKm = drawCurve.max_draw_km;
  const totalDisplay = figures.get("total_road_km").display;
  const axis = byId("axis");
  const done = byId("axis-done");
  const playhead = byId("playhead");
  const value = byId("readout-value");
  const drawn = byId("readout-drawn");
  const percent = (distanceKm) => `${(distanceKm / maxKm) * 100}%`;
  axis.setAttribute("aria-valuemax", String(maxKm));

  function setDraw(distanceKm) {
    state.drawKm = distanceKm;
    positionKm = distanceKm;
    setReadout(value, `${km(distanceKm)} km`);
    // At the very end I show the display text itself, so the page always matches the key figure.
    const drawnText = distanceKm >= maxKm ? totalDisplay : `${km(drawCurve.km[distanceKm])} km`;
    drawn.textContent = `${drawnText} of ${totalDisplay} drawn`;
    done.style.width = percent(distanceKm);
    playhead.style.left = percent(distanceKm);
    axis.setAttribute("aria-valuenow", String(distanceKm));
    axis.setAttribute(
      "aria-valuetext",
      `${km(distanceKm)} km from Rome, ${drawnText} of ${totalDisplay} drawn`,
    );
    apply();
  }

  /* Play advances by the clock, but only hands the map a new filter when it has finished the last
     one. On a slow machine the drawing skips steps instead of falling behind. */
  let playing = false;
  let lastTime = 0;
  let positionKm = maxKm;
  let exactKm = maxKm;
  let waiting = false;
  let speed = 1;

  function tick(time) {
    if (!playing) return;
    // A frame's timestamp can be a little older than the moment play was pressed, so I never let
    // time run backwards.
    const elapsedMs = Math.max(0, time - lastTime);
    exactKm = Math.min(maxKm, exactKm + (PLAY_KM_PER_S * speed * elapsedMs) / 1000);
    lastTime = time;
    if (!waiting) {
      setDraw(Math.round(exactKm));
      waiting = true;
      map.once("idle", () => {
        waiting = false;
      });
      map.triggerRepaint();
    }
    if (exactKm >= maxKm) {
      setDraw(maxKm);
      setPlaying(false);
      return;
    }
    requestAnimationFrame(tick);
  }

  function setPlaying(next) {
    playing = next;
    byId("play-word").textContent = next ? "Pause" : "Play";
    byId("play-icon").setAttribute("d", next ? PAUSE_PATH : PLAY_PATH);
    byId("play").setAttribute("aria-label", next ? "Pause the draw" : "Play the draw from Rome");
    if (next) {
      if (exactKm >= maxKm) exactKm = 0;
      lastTime = performance.now();
      requestAnimationFrame(tick);
    }
  }

  function seek(distanceKm) {
    setPlaying(false);
    exactKm = Math.max(0, Math.min(maxKm, Math.round(distanceKm)));
    setDraw(exactKm);
  }

  byId("play").addEventListener("click", () => setPlaying(!playing));

  /* The whole axis is the handle, as on a printed scale: there is no thumb to aim for. Several
     pointer moves can land between two frames, so I only apply the newest one per frame. */
  let pendingKm = null;
  function kmAt(clientX) {
    const box = axis.getBoundingClientRect();
    return ((clientX - box.left) / box.width) * maxKm;
  }
  function scrubTo(clientX) {
    const scheduled = pendingKm !== null;
    pendingKm = kmAt(clientX);
    if (scheduled) return;
    requestAnimationFrame(() => {
      seek(pendingKm);
      pendingKm = null;
    });
  }
  axis.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".event")) return;
    axis.setPointerCapture(event.pointerId);
    seek(kmAt(event.clientX));
  });
  axis.addEventListener("pointermove", (event) => {
    if (axis.hasPointerCapture(event.pointerId)) scrubTo(event.clientX);
  });
  axis.addEventListener("keydown", (event) => {
    if (event.key === "Home") seek(0);
    else if (event.key === "End") seek(maxKm);
    else return;
    event.preventDefault();
  });

  const speedHolder = byId("speeds");
  for (const { label, factor } of SPEEDS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-label", `Play at ${factor} times speed`);
    const choose = () => {
      speed = factor;
      for (const other of speedHolder.children) {
        const chosen = other === button;
        other.classList.toggle("chosen", chosen);
        other.setAttribute("aria-pressed", String(chosen));
      }
    };
    button.addEventListener("click", choose);
    speedHolder.append(button);
    if (factor === 1) choose();
  }

  // Ticks at round values plus both ends. The last round tick drops its label if the end needs the room.
  const ticks = byId("ticks");
  const stops = [];
  for (let at = 0; at < maxKm; at += TICK_EVERY_KM) stops.push(at);
  stops.push(maxKm);
  for (const at of stops) {
    const tick_ = document.createElement("span");
    tick_.className = at === 0 || at === maxKm ? "tick end" : "tick";
    tick_.style.left = percent(at);
    const label = document.createElement("span");
    label.className = "tick-label";
    label.textContent = at === 0 ? "0 km" : km(at);
    tick_.append(label);
    ticks.append(tick_);
  }

  const eventHolder = byId("events");
  function layOutAxis() {
    const widthPx = axis.clientWidth;
    if (widthPx === 0) return;
    /* Labels hang to the right of their stems, and a stem runs down through every row below its
       label. So I place them from the right: a name fits in a row if it ends before any stem or
       name already standing in that row. On a narrow phone the places are close, so there are four. */
    const rowStarts = [Infinity, Infinity, Infinity, Infinity];
    for (const element of [...eventHolder.children].reverse()) {
      const leftPx = (Number(element.dataset.km) / maxKm) * widthPx;
      const rightPx = leftPx + element.offsetWidth + 2;
      const free = rowStarts.findIndex((start) => rightPx < start);
      const row = free === -1 ? rowStarts.length - 1 : free;
      for (let below = 0; below <= row; below += 1) {
        rowStarts[below] = Math.min(rowStarts[below], leftPx);
      }
      element.dataset.row = String(row);
    }
    const labels = [...ticks.querySelectorAll(".tick-label")];
    labels.at(-2).style.visibility = "visible";
    const beforeEnd = labels.at(-2).getBoundingClientRect();
    const end = labels.at(-1).getBoundingClientRect();
    labels.at(-2).style.visibility = beforeEnd.right + 6 > end.left ? "hidden" : "visible";
  }
  new ResizeObserver(layOutAxis).observe(axis);

  function placeEvents(events) {
    for (const event of [...events].sort((a, b) => a.km - b.km)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "event";
      button.dataset.km = String(event.km);
      button.style.left = percent(event.km);
      button.textContent = event.name;
      button.setAttribute(
        "aria-label",
        `Draw as far as ${event.name}, ${km(event.km)} km from Rome`,
      );
      button.addEventListener("click", () => seek(event.km));
      eventHolder.append(button);
    }
    layOutAxis();
  }

  // The named stops (Brundisium, Londinium ...) and the farthest point from Rome: prepare.py
  // measures them on the road network once, so the page only reads a small file.
  async function loadEvents() {
    const response = await fetch(layerUrl("events.json"));
    if (!response.ok) throw new Error(`events.json: HTTP ${response.status}`);
    const events = await response.json();
    placeEvents(events.events);
    return events.farthest;
  }

  setDraw(maxKm);
  return {
    togglePlaying: () => setPlaying(!playing),
    step: (direction) => seek(positionKm + direction * STEP_KM),
    loadEvents,
    layOutAxis,
  };
}

/* ---- annotation: the cartouche ---- */

/* The note is set like the title cartouche of an engraved atlas plate: a framed card with a double
   rule and a solid square on each corner, tied to its road by one stroke of the pen. Only a click or
   a tap opens it; moving the pointer over the map does nothing at all. */

// The words of the key, so the note and the key never name one thing two ways.
const TYPE_WORDS = { "Main Road": "Main road", "Secondary Road": "Secondary road" };

function lengthText(lengthKm) {
  return lengthKm < 10 ? lengthKm.toFixed(1) : km(lengthKm);
}

function fillNote(note, segment) {
  const frame = document.createElement("div");
  frame.className = "frame";
  for (const corner of ["nw", "ne", "sw", "se"]) {
    const square = document.createElement("span");
    square.className = `corner ${corner}`;
    frame.append(square);
  }
  const name = document.createElement("h2");
  name.textContent = segment.Name?.trim() || "Roman road";
  const sentence = document.createElement("p");
  const type = TYPE_WORDS[segment.Type] ?? segment.Type;
  const number = document.createElement("b");
  number.textContent = lengthText(segment.length_km);
  // A no-break space keeps the number and its unit on one line.
  sentence.append(`${type}, ${segment.Segment_s.toLowerCase()}. `, number, "\u00a0km long.");
  const source = document.createElement("p");
  source.className = "source";
  source.textContent = segment.Bibliograp
    ? `Source: Itiner-e 2025, ${segment.Bibliograp}`
    : "Source: Itiner-e 2025";
  frame.append(name, sentence, source);
  note.replaceChildren(frame);
  // The live region gets the same words as one plain sentence each, with the name in its own case.
  return `${name.textContent}. ${sentence.textContent} ${source.textContent}.`;
}

// Screen-space geometry helpers. Everything below works in map-area pixels.
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function nearestOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy, t };
}

/* An occupancy grid of the selected road, in cells of a few pixels, with a summed-area table on
   top: then "how much of the road lies under this box" is four lookups, cheap enough to test
   hundreds of places for the note on every frame of a drag. */
function roadGrid(width, height, lines, cellPx) {
  const columns = Math.ceil(width / cellPx) + 1;
  const rows = Math.ceil(height / cellPx) + 1;
  const sums = new Float64Array((columns + 1) * (rows + 1));
  const cells = new Uint8Array(columns * rows);
  const mark = (x, y) => {
    const column = Math.floor(x / cellPx);
    const row = Math.floor(y / cellPx);
    if (column >= 0 && row >= 0 && column < columns && row < rows) cells[row * columns + column] = 1;
  };
  for (const points of lines) {
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      if (!a || !b) continue;
      const steps = Math.min(4000, Math.ceil(distance(a, b) / (cellPx / 2)) + 1);
      for (let k = 0; k <= steps; k += 1) {
        mark(a.x + ((b.x - a.x) * k) / steps, a.y + ((b.y - a.y) * k) / steps);
      }
    }
  }
  for (let row = 0; row < rows; row += 1) {
    let rowSum = 0;
    for (let column = 0; column < columns; column += 1) {
      rowSum += cells[row * columns + column];
      sums[(row + 1) * (columns + 1) + column + 1] = sums[row * (columns + 1) + column + 1] + rowSum;
    }
  }
  return (box) => {
    const c0 = Math.max(0, Math.min(columns, Math.floor(box.left / cellPx)));
    const c1 = Math.max(0, Math.min(columns, Math.ceil(box.right / cellPx)));
    const r0 = Math.max(0, Math.min(rows, Math.floor(box.top / cellPx)));
    const r1 = Math.max(0, Math.min(rows, Math.ceil(box.bottom / cellPx)));
    const at = (r, c) => sums[r * (columns + 1) + c];
    return at(r1, c1) - at(r0, c1) - at(r1, c0) + at(r0, c0);
  };
}

const overlapArea = (a, b) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

function wireAnnotation({ map, segments, stage }) {
  const note = byId("annotation");
  const live = byId("annotation-live");
  const leader = byId("leader");
  const stroke = leader.querySelector(".pen");
  const dot = leader.querySelector(".dot");
  const ticks = [...leader.querySelectorAll(".tick")];
  const layers = ["roads_main", "roads_secondary"];
  let shown = null; // the segment index on show, or null
  let anchor = null; // the segment's middle, where the pen stroke starts
  let lines = []; // the segment's lines as [lng, lat] arrays, from the tiles in memory
  let ends = []; // its two ends: { end, inward } as {lng, lat}

  const setMark = (s) => {
    for (const id of ["selected_casing", "selected"]) {
      map.setFilter(id, ["==", ["get", "s"], s ?? NO_SEGMENT]);
    }
  };

  function close() {
    shown = null;
    anchor = null;
    lines = [];
    ends = [];
    note.hidden = true;
    leader.classList.remove("on");
    live.textContent = "";
    setMark(null);
  }

  const visible = (lngLat) => !map.transform.isLocationOccluded(lngLat);
  const toLngLat = ([lng, lat]) => ({ lng, lat });
  function project(lngLat) {
    if (!visible(lngLat)) return null;
    const { x, y } = map.project(lngLat);
    return { x, y };
  }

  /* The road tiles cut a segment into pieces, and every tile repeats the pieces that cross its
     buffer, so I cannot read the two ends straight from the data. A piece end is a real end of the
     road only when no other piece carries on from it: no piece passes through that point, and no
     piece starts there heading the other way. Copies of the same piece from a neighbouring tile
     start there heading the same way, so they do not count. */
  function readGeometry() {
    const features = map.querySourceFeatures("roads", {
      sourceLayer: "roads",
      filter: ["==", ["get", "s"], shown],
    });
    lines = features.flatMap(({ geometry }) =>
      geometry.type === "MultiLineString" ? geometry.coordinates : [geometry.coordinates],
    );
    const screen = lines.map((coordinates) => coordinates.map((c) => project(toLngLat(c))));
    const NEAR_PX = 1.5;
    const found = [];
    screen.forEach((points, index) => {
      for (const atStart of [true, false]) {
        const order = atStart ? points : [...points].reverse();
        const coordinates = atStart ? lines[index] : [...lines[index]].reverse();
        const p = order[0];
        if (!p) continue;
        // The first vertex at least 3 px away gives the road's heading at its end.
        let k = 1;
        while (k < order.length - 1 && (!order[k] || distance(order[k], p) < 3)) k += 1;
        if (!order[k]) continue;
        const heading = { x: order[k].x - p.x, y: order[k].y - p.y };
        const continues = screen.some((other, j) => {
          if (j === index) return false;
          for (let i = 1; i < other.length; i += 1) {
            if (!other[i - 1] || !other[i]) continue;
            const near = nearestOnSegment(p, other[i - 1], other[i]);
            if (distance(near, p) > NEAR_PX) continue;
            const atOtherEnd = (i === 1 && near.t < 0.01) || (i === other.length - 1 && near.t > 0.99);
            if (!atOtherEnd) return true; // it runs straight through
            const from = i === 1 ? other[1] : other[other.length - 2];
            const to = i === 1 ? other[0] : other[other.length - 1];
            const otherHeading = { x: from.x - to.x, y: from.y - to.y };
            if (heading.x * otherHeading.x + heading.y * otherHeading.y < 0) return true;
          }
          return false;
        });
        if (!continues && !found.some((f) => distance(f.p, p) < 4)) {
          found.push({ p, end: toLngLat(coordinates[0]), inward: toLngLat(coordinates[k]) });
        }
      }
    });
    ends = found.map(({ end, inward }) => ({ end, inward }));
    return screen;
  }

  /* The pen stroke starts at the middle of the road. With the whole road on screen that is the
     point halfway between its two ends; with only part of it on screen, the middle of that part, so
     the note always ties to road the reader can see. */
  function findMiddle(screen) {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const inside = (p) => p && p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height;
    const points = screen.flat().filter(inside);
    if (!points.length) return null;
    // Two passes of "farthest point" find the two extremes of the road as drawn.
    const farthest = (from) =>
      points.reduce((best, p) => (distance(p, from) > distance(best, from) ? p : best), points[0]);
    const a = farthest(points[0]);
    const b = farthest(a);
    const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let best = null;
    for (const line of screen) {
      for (let i = 1; i < line.length; i += 1) {
        if (!line[i - 1] || !line[i]) continue;
        const near = nearestOnSegment(middle, line[i - 1], line[i]);
        if (!inside(near)) continue;
        if (!best || distance(near, middle) < distance(best, middle)) best = near;
      }
    }
    return best ? map.unproject([best.x, best.y]) : null;
  }

  // Boxes in map-area pixels, so the note can be tested against everything already on the map.
  function boxOf(element, padPx) {
    const stageBox = stage.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return {
      left: box.left - stageBox.left - padPx,
      top: box.top - stageBox.top - padPx,
      right: box.right - stageBox.left + padPx,
      bottom: box.bottom - stageBox.top + padPx,
    };
  }

  // The note never touches these: the title, the controls, the hint line and the "Map info"
  // button. On a phone the title is a band of its own, and a note under it would lose its name.
  function hardBoxes() {
    return ["title-block", "foot-left", "map-buttons", "top-right"]
      .map(byId)
      .filter((element) => element.offsetParent !== null && element.offsetWidth > 0)
      .map((element) => ({ id: element.id, ...boxOf(element, 6) }));
  }

  // These it avoids where it can: the place labels and the Rome marker.
  function softBoxes() {
    const boxes = [];
    for (const label of document.querySelectorAll("#place-labels .place-label")) {
      const shownLabel = label.style.display !== "none" && label.style.visibility !== "hidden";
      if (shownLabel && Number(label.style.opacity || 1) > 0) boxes.push(boxOf(label, 4));
    }
    for (const marker of map.queryRenderedFeatures({ layers: ["rome_marker"] })) {
      const { x, y } = map.project(marker.geometry.coordinates);
      boxes.push({ left: x - 14, top: y - 14, right: x + 14, bottom: y + 14 });
    }
    return boxes;
  }

  // The middle of the note edge nearest the dot, and which way that edge faces.
  function nearestEdge(box, from) {
    const midX = (box.left + box.right) / 2;
    const midY = (box.top + box.bottom) / 2;
    const edges = [
      { x: box.left, y: midY, horizontal: true },
      { x: box.right, y: midY, horizontal: true },
      { x: midX, y: box.top, horizontal: false },
      { x: midX, y: box.bottom, horizontal: false },
    ];
    return edges.reduce((best, e) => (distance(e, from) < distance(best, from) ? e : best));
  }

  /* I try eight places round the dot, nearest first, and take the first that keeps off the road,
     the controls and the labels. Where none does (a road filling a phone screen, say), I search the
     whole map area on a grid for the place that covers the least road; on a phone that search
     prefers the foot of the map, just above the bottom sheet. A phone map can be too short for any
     place clear of the title, the hint line and the buttons at once: then, and only then, the note
     may cover the hint line, which has done its job once the reader has tapped. Re-running this on
     every move keeps the note beside its road as the globe turns. */
  function place(screen = null) {
    if (shown === null || !anchor) return;
    if (!visible(anchor)) {
      close();
      return;
    }
    const projected = screen ?? lines.map((line) => line.map((c) => project(toLngLat(c))));
    const d = map.project(anchor);
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const w = note.offsetWidth;
    const h = note.offsetHeight;
    const roadUnder = roadGrid(width, height, projected, 6);
    const hard = hardBoxes();
    const soft = softBoxes();
    const MARGIN = 8;
    const allowed = (box, hardSet = hard) =>
      box.left >= MARGIN &&
      box.top >= MARGIN &&
      box.right <= width - MARGIN &&
      box.bottom <= height - MARGIN &&
      hardSet.every((other) => overlapArea(box, other) === 0) &&
      overlapArea(box, { left: d.x - 10, top: d.y - 10, right: d.x + 10, bottom: d.y + 10 }) === 0;
    const covered = (box) => {
      const padded = { left: box.left - 4, top: box.top - 4, right: box.right + 4, bottom: box.bottom + 4 };
      return 2000 * roadUnder(padded) + soft.reduce((sum, other) => sum + overlapArea(box, other), 0);
    };
    const boxAt = (left, top) => ({ left, top, right: left + w, bottom: top + h });
    // The small vertical and sideways offsets bend the pen stroke into a curve, as a hand would.
    const gap = NOTE_GAP_PX;
    const diagonal = gap * 0.7;
    const candidates = [
      boxAt(d.x + gap, d.y - h / 2 - 16),
      boxAt(d.x - gap - w, d.y - h / 2 - 16),
      boxAt(d.x - w / 2 + 28, d.y - gap - h),
      boxAt(d.x - w / 2 + 28, d.y + gap),
      boxAt(d.x + diagonal, d.y - diagonal - h),
      boxAt(d.x - diagonal - w, d.y - diagonal - h),
      boxAt(d.x + diagonal, d.y + diagonal),
      boxAt(d.x - diagonal - w, d.y + diagonal),
    ];
    const phone = matchMedia(PHONE_QUERY).matches;
    function search(hardSet) {
      let found = null;
      let bestScore = Infinity;
      const consider = (box) => {
        if (!allowed(box, hardSet)) return;
        const edge = nearestEdge(box, d);
        const score =
          covered(box) + 0.5 * distance(edge, d) + (phone ? 1.5 * (height - box.bottom) : 0);
        if (score < bestScore) {
          bestScore = score;
          found = box;
        }
      };
      candidates.forEach(consider);
      for (let top = MARGIN; top + h <= height - MARGIN; top += 12) {
        for (let left = MARGIN; left + w <= width - MARGIN; left += 12) consider(boxAt(left, top));
      }
      return found;
    }
    let best = candidates.find((box) => allowed(box) && covered(box) === 0) ?? search(hard);
    if (!best && phone) best = search(hard.filter((box) => box.id !== "foot-left"));
    if (!best) {
      // A map area smaller than the note leaves no good place: it goes in the top left corner.
      best = boxAt(MARGIN, MARGIN);
    }
    note.style.transform = `translate(${best.left.toFixed(1)}px, ${best.top.toFixed(1)}px)`;
    drawPen(d, best);
    drawTicks();
  }

  function drawPen(d, box) {
    const e = nearestEdge(box, d);
    // A cubic that leaves the dot along the road's side and meets the note square to its edge.
    const c1 = e.horizontal ? { x: (d.x + e.x) / 2, y: d.y } : { x: d.x, y: (d.y + e.y) / 2 };
    const c2 = e.horizontal ? { x: (d.x + e.x) / 2, y: e.y } : { x: e.x, y: (d.y + e.y) / 2 };
    const f = (n) => n.toFixed(1);
    stroke.setAttribute(
      "d",
      `M${f(d.x)} ${f(d.y)}C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(e.x)} ${f(e.y)}`,
    );
    dot.setAttribute("cx", f(d.x));
    dot.setAttribute("cy", f(d.y));
  }

  // A tick across each end of the road, square to it, like the stops on an engraved route.
  function drawTicks() {
    const HALF_PX = 8;
    ticks.forEach((tick, index) => {
      const end = ends[index];
      const p = end && project(end.end);
      const q = end && project(end.inward);
      if (!p || !q) {
        tick.setAttribute("visibility", "hidden");
        return;
      }
      const length = distance(p, q) || 1;
      const nx = (-(q.y - p.y) / length) * HALF_PX;
      const ny = ((q.x - p.x) / length) * HALF_PX;
      tick.setAttribute("x1", (p.x + nx).toFixed(1));
      tick.setAttribute("y1", (p.y + ny).toFixed(1));
      tick.setAttribute("x2", (p.x - nx).toFixed(1));
      tick.setAttribute("y2", (p.y - ny).toFixed(1));
      tick.setAttribute("visibility", "visible");
    });
  }

  // Each opening fades in once; restarting the animation needs a style read in between.
  function fadeIn() {
    for (const element of [note, leader]) {
      element.classList.remove("opening");
      void element.offsetWidth;
      element.classList.add("opening");
    }
  }

  function show(s, fallbackLngLat) {
    shown = s;
    setMark(s);
    live.textContent = fillNote(note, segments[s]);
    note.hidden = false;
    leader.classList.add("on");
    const screen = readGeometry();
    anchor = findMiddle(screen) ?? fallbackLngLat;
    fadeIn();
    place(screen);
  }

  // The tiles in memory change as the reader moves, so the ends are read again once the map
  // settles, and the middle too if the old one has left the screen.
  map.on("idle", () => {
    if (shown === null) return;
    const screen = readGeometry();
    const d = anchor && project(anchor);
    const onScreen = d && d.x >= 0 && d.y >= 0 && d.x <= stage.clientWidth && d.y <= stage.clientHeight;
    if (!onScreen) anchor = findMiddle(screen) ?? anchor;
    place(screen);
  });

  // A 10 px box round the click, so a thin secondary road is easy to hit.
  function roadAt(point) {
    const HALF_BOX_PX = 5;
    const near = map.queryRenderedFeatures(
      [
        [point.x - HALF_BOX_PX, point.y - HALF_BOX_PX],
        [point.x + HALF_BOX_PX, point.y + HALF_BOX_PX],
      ],
      { layers },
    );
    return near.length ? near[0].properties.s : null;
  }

  map.on("click", (event) => {
    const s = roadAt(event.point);
    // A click on nothing, or on the road already open, closes the note.
    if (s === null || s === shown) close();
    else show(s, event.lngLat);
  });
  map.on("move", () => place());

  return {
    isOpen: () => shown !== null,
    close,
    openAt: (s, lngLat) => show(s, lngLat),
  };
}

/* ---- map buttons ---- */

function wireButtons(map, startView) {
  const moved = { duration: CAMERA_MS, easing: easeOut };
  // easeTo already jumps instead of flying when the reader asks for reduced motion.
  byId("zoom-in").addEventListener("click", () => map.zoomIn(moved));
  byId("zoom-out").addEventListener("click", () => map.zoomOut(moved));
  byId("compass").addEventListener("click", () => map.easeTo({ bearing: 0, pitch: 0, ...moved }));
  byId("tilt").addEventListener("click", () => {
    map.easeTo({ pitch: map.getPitch() > 1 ? 0 : TILT_DEG, ...moved });
  });
  byId("home").addEventListener("click", () => map.easeTo({ ...startView.current, ...moved }));

  const needle = document.querySelector("#compass svg");
  const tiltButton = byId("tilt");
  const tip = wireButtonTips();
  const follow = () => {
    const squash = Math.cos((map.getPitch() * Math.PI) / 180);
    needle.style.transform = `rotate(${-map.getBearing()}deg) scaleY(${squash})`;
    const tilted = map.getPitch() > 1;
    tiltButton.setAttribute("aria-pressed", String(tilted));
    const words = tilted ? "Back to flat" : "Tilt to 3D";
    if (tiltButton.getAttribute("aria-label") !== words) {
      tiltButton.setAttribute("aria-label", words);
      tip.refresh(tiltButton);
    }
  };
  map.on("move", follow);
  follow();
  return tip;
}

// One label to the left of a button, level with it. It reads the button's aria-label (or data-tip,
// where the visible words already name the button), so what a screen reader hears and what the eye
// sees cannot drift apart. I skip the native title attribute: it waits about a second, cannot be
// styled, and never shows on focus.
function wireButtonTips() {
  const tip = byId("button-tip");
  const home = tip.parentElement;
  let shownFor = null;
  let timer = null;

  function show(button) {
    clearTimeout(timer);
    shownFor = button;
    // An open modal dialog sits in the browser's top layer, above everything else on the page, so a
    // tooltip for a button inside it has to live inside the dialog too.
    const layer = button.closest("dialog") ?? home;
    if (tip.parentElement !== layer) layer.append(tip);
    tip.textContent = button.dataset.tip ?? button.getAttribute("aria-label");
    const box = button.getBoundingClientRect();
    // In the sheet a label to the left would cover the line the button ends. Lines with a place
    // come last, so the space under the button is free: the label goes there, flush right.
    const below = button.dataset.tipSide === "below";
    tip.classList.toggle("below", below);
    tip.style.top = below ? `${box.bottom + 2}px` : `${box.top + box.height / 2}px`;
    tip.style.right = `${window.innerWidth - (below ? box.right : box.left - 6)}px`;
    tip.classList.add("on");
  }
  function hide() {
    clearTimeout(timer);
    shownFor = null;
    tip.classList.remove("on");
  }

  for (const button of document.querySelectorAll("button.has-tip")) {
    // Touch has no hover, and a label left behind after a tap would cover the map, so only a mouse
    // or a pen gets the delayed tooltip.
    button.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "touch") return;
      clearTimeout(timer);
      timer = setTimeout(() => show(button), TIP_DELAY_MS);
    });
    button.addEventListener("pointerleave", hide);
    // A keyboard reader gets it at once. A click also focuses the button, but :focus-visible stays
    // off for a mouse or a finger, so this only fires for the keyboard.
    button.addEventListener("focus", () => {
      if (button.matches(":focus-visible")) show(button);
    });
    button.addEventListener("blur", hide);
  }

  return {
    isOpen: () => shownFor !== null,
    hide,
    refresh(button) {
      if (shownFor === button) show(button);
    },
  };
}

/* ---- the sheet: folds away on a wide screen, a bottom sheet on a phone ---- */

function wireSheet(timeline, tip) {
  const phone = matchMedia(PHONE_QUERY);
  const sheet = byId("sheet");
  const grab = byId("grab");
  const unfold = byId("unfold");

  function setOpen(open) {
    document.body.classList.toggle("sheet-open", open);
    grab.setAttribute("aria-expanded", String(open));
    sheet.style.removeProperty("height");
  }
  function setFolded(folded) {
    document.body.classList.toggle("folded", folded);
    requestAnimationFrame(timeline.layOutAxis);
  }

  byId("fold").addEventListener("click", () => {
    tip.hide();
    setFolded(true);
    unfold.focus();
  });
  unfold.addEventListener("click", () => {
    tip.hide();
    setFolded(false);
    byId("fold").focus();
  });

  // The grab line follows a drag and snaps open or closed on release. A tap just toggles it.
  let dragStartY = null;
  let dragged = false;
  grab.addEventListener("pointerdown", (event) => {
    grab.setPointerCapture(event.pointerId);
    dragStartY = event.clientY;
    dragged = false;
  });
  grab.addEventListener("pointermove", (event) => {
    if (dragStartY === null || Math.abs(event.clientY - dragStartY) < 6) return;
    dragged = true;
    // It never goes lower than its resting height, where the Layers heading still shows.
    const restPx = window.innerHeight * SHEET_REST_SHARE;
    sheet.style.height = `${Math.max(restPx, window.innerHeight - event.clientY)}px`;
  });
  grab.addEventListener("pointerup", (event) => {
    if (dragStartY === null) return;
    dragStartY = null;
    if (dragged) setOpen(event.clientY < window.innerHeight * 0.5);
  });
  grab.addEventListener("pointercancel", () => {
    dragStartY = null;
    sheet.style.removeProperty("height");
  });
  grab.addEventListener("click", () => {
    if (!dragged) setOpen(!document.body.classList.contains("sheet-open"));
    dragged = false;
  });

  return {
    // On a phone the open sheet covers the map, so a "Show on map" lowers it to its resting height.
    rest() {
      if (phone.matches) setOpen(false);
    },
    closeOne() {
      if (phone.matches) {
        if (!document.body.classList.contains("sheet-open")) return;
        setOpen(false);
        grab.focus();
      } else if (!document.body.classList.contains("folded")) {
        setFolded(true);
        unfold.focus();
      }
    },
  };
}

/* ---- keyboard ---- */

function wireKeyboard(timeline, annotation, sheet, tip) {
  // The capture phase runs before MapLibre's own keys. Left and right belong to the timeline here,
  // and the up and down arrows still move the map.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      // While the About dialog is open its own keys apply: Escape closes it natively.
      if (byId("about").open || byId("downloads").open) return;
      const onControl = event.target.closest?.("button, a");
      if (event.code === "Space" && !onControl) {
        event.preventDefault();
        event.stopPropagation();
        timeline.togglePlaying();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        timeline.step(event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.key === "Escape") {
        // A tooltip goes first, so a reader can clear it without the sheet folding as well.
        if (tip.isOpen()) tip.hide();
        else if (annotation.isOpen()) annotation.close();
        else sheet.closeOne();
      }
    },
    { capture: true },
  );
}

/* ---- small pieces ---- */

// "Data fetched 5 November 2026." as the dialog's last line, from the download dates in meta.json.
// When the files arrived on different days, each source gets its own line.
async function fillFetched(layerUrl) {
  const response = await fetch(layerUrl("meta.json"));
  if (!response.ok) throw new Error(`meta.json: HTTP ${response.status}`);
  const { sources } = await response.json();
  // Read as a calendar day in UTC, so a reader west of Greenwich never sees the day before.
  const day = (iso) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  const days = [...new Set(sources.map((source) => source.downloaded))];
  const lines =
    days.length === 1
      ? [`Data fetched ${day(days[0])}.`]
      : sources.map((source) => `${source.name} fetched ${day(source.downloaded)}.`);
  byId("fetched").replaceChildren(
    ...lines.map((line) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = line;
      return paragraph;
    }),
  );
}

// A native <dialog> opened with showModal() traps focus, makes the page behind it inert and closes
// on Escape by itself, so I only add the close button and the backdrop click.
function wireDialog(toggleId, dialogId, closeId) {
  const toggle = byId(toggleId);
  const dialog = byId(dialogId);
  toggle.addEventListener("click", () => {
    dialog.showModal();
    // showModal() would focus the first link. Focusing the dialog itself lets a screen reader start
    // at the heading, and nothing gets a focus ring the reader did not ask for.
    dialog.focus();
  });
  byId(closeId).addEventListener("click", () => dialog.close());
  // A click on the backdrop lands on the dialog element too, so I tell the two apart by position:
  // only a click outside the dialog's own box closes it.
  dialog.addEventListener("click", (event) => {
    const box = dialog.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;
    if (!inside) dialog.close();
  });
  dialog.addEventListener("close", () => toggle.focus());
}

// About this map and Download the data: the same native modal dialog.
function wireAbout() {
  wireDialog("about-toggle", "about", "about-close");
  wireDialog("downloads-toggle", "downloads", "downloads-close");
}

/* ---- title wash: only where the map behind the title gets too dark ---- */

function luminance([r, g, b]) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/* After each move I read the map pixels behind the title and the lede and work out the contrast
   of the ink on the darkest of them. Under 4.5:1 the title gets its wash of paper; over it,
   the title stands straight on the map like a printed one. */
function watchTitleContrast(map, stage) {
  const block = byId("title-block");
  const scratch = document.createElement("canvas");
  const context = scratch.getContext("2d", { willReadFrequently: true });
  const inkLuminance = luminance(INK_RGB);

  function darkestRatio(part) {
    const canvas = map.getCanvas();
    const scale = canvas.width / canvas.clientWidth;
    const stageBox = stage.getBoundingClientRect();
    const box = part.getBoundingClientRect();
    const sx = Math.max(0, Math.floor((box.left - stageBox.left) * scale));
    const sy = Math.max(0, Math.floor((box.top - stageBox.top) * scale));
    const sw = Math.min(canvas.width - sx, Math.ceil(box.width * scale));
    const sh = Math.min(canvas.height - sy, Math.ceil(box.height * scale));
    if (sw <= 0 || sh <= 0) return Infinity;
    scratch.width = sw;
    scratch.height = sh;
    context.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    const { data } = context.getImageData(0, 0, sw, sh);
    const values = [];
    for (let i = 0; i < data.length; i += 4) {
      // Outside the globe the canvas is transparent and the paper behind it shows, so I blend
      // each pixel over the paper the way the browser does on screen.
      const alpha = data[i + 3] / 255;
      const rgb = [0, 1, 2].map((c) => data[i + c] * alpha + PAPER_RGB[c] * (1 - alpha));
      values.push(luminance(rgb));
    }
    values.sort((a, b) => a - b);
    const background = values[Math.floor(values.length * DARKEST_SHARE)] * (1 - GRAIN_DARKENING);
    return (background + 0.05) / (inkLuminance + 0.05);
  }

  function check() {
    if (matchMedia(PHONE_QUERY).matches) return; // on a phone the wash is always there
    const worst = Math.min(...[...block.querySelectorAll("h1, p")].map(darkestRatio));
    block.dataset.mapContrast = worst.toFixed(2);
    block.classList.toggle("washed", worst < TITLE_CONTRAST_MIN);
  }
  map.on("idle", check);
  check();
}

/* ---- phone: fit the whole network into the map area ---- */

function fitNetwork(map, stage, bounds) {
  const title = byId("title-block");
  const foot = byId("foot-left");
  const buttons = byId("map-buttons");
  const padding = {
    top: title.offsetTop + title.offsetHeight + FIT_GAP_PX,
    bottom: stage.clientHeight - foot.offsetTop + FIT_GAP_PX,
    left: FIT_GAP_PX,
    right: stage.clientWidth - buttons.offsetLeft + FIT_GAP_PX,
  };
  const [west, south, east, north] = bounds;
  const camera = map.cameraForBounds(
    [
      [west, south],
      [east, north],
    ],
    { padding },
  );
  if (!camera) throw new Error("the network does not fit the map area");
  const view = { center: camera.center, zoom: camera.zoom, pitch: 0, bearing: 0 };
  map.jumpTo(view);
  return view;
}

/* ---- start ---- */

export function startUi({
  map,
  write,
  roads,
  drawCurve,
  segments,
  figures,
  stage,
  startView,
  layerUrl,
}) {
  const maxKm = drawCurve.max_draw_km;
  // The plain plate view has no title to clear and no key to explain, so it stays as it was printed.
  const isPlate = document.body.classList.contains("bare");
  const isPhone = matchMedia(PHONE_QUERY).matches;
  if (!isPlate && !isPhone) map.setPadding({ left: TITLE_ROOM_PX });
  const totalsReady = fetch(layerUrl("totals.json")).then((response) => {
    if (!response.ok) throw new Error(`totals.json: HTTP ${response.status}`);
    return response.json();
  });
  // The start view the button returns to. A phone replaces it with the fitted network below.
  const start = { current: startView };
  const { farthestButton } = buildFigures(figures);
  let resolveFarthest;
  const farthestReady = new Promise((resolve) => {
    resolveFarthest = resolve;
  });
  const drawAs = buildKey({ map, write, roads, maxKm, totalsReady, figures });
  const timeline = createTimeline({ map, roads, drawCurve, figures, layerUrl });
  // The key explains line patterns, so the public map always draws them.
  drawAs(!isPlate);
  const annotation = wireAnnotation({ map, segments, stage });
  const tip = wireButtons(map, start);
  const sheet = wireSheet(timeline, tip);
  wireShowOnMap({ map, button: farthestButton, targetReady: farthestReady, annotation, sheet });
  wireKeyboard(timeline, annotation, sheet, tip);
  wireAbout();
  const fetchedReady = fillFetched(layerUrl);
  if (isPlate) {
    // Without a timeline on screen, the plain plate view has no reason to read the 25 MB road file.
    return { loadEvents: async () => {}, annotation };
  }
  watchTitleContrast(map, stage);
  async function finish() {
    const totals = await totalsReady;
    if (isPhone) start.current = fitNetwork(map, stage, totals.network_bounds_lonlat);
    resolveFarthest(await timeline.loadEvents());
    await fetchedReady;
    // The page counts as ready once the map has drawn the final view.
    await new Promise((resolve) => {
      if (map.loaded() && !map.isMoving()) resolve();
      else map.once("idle", resolve);
    });
  }
  return { loadEvents: finish, annotation };
}
