/**
 * The public page around the globe: title, sheet, map buttons, timeline band and annotation.
 *
 * What it does: builds the page layout every Atlas Lab map shares and connects its controls to the
 * map. It draws nothing itself: every picture comes from createMap() in main.js, through the same
 * public calls you could use in your own script.
 * Reads:  the figures and rings createMap() has loaded (map.figures, map.data)
 * Run:    index.html loads this file; there is nothing to run on its own.
 *
 * What you learn: how to scale a time axis by what happened instead of by the calendar. Most
 * tsunami records are recent: the rings from 2004 to 2026 alone fill more than half of the record.
 * On a plain year axis the playhead would crawl through the last millimetres for most of a run.
 * So the axis is stretched by the cumulative number of rings, the year labels sit wherever their
 * year begins, and the playhead moves at an even pace. Also: how to pick the ring a reader means,
 * by distance to its centre, when big rings overlap small ones.
 */

import "@fontsource/ibm-plex-serif/latin-400.css";
import "@fontsource/ibm-plex-serif/latin-600.css";
// The bold of the display face, only for the click note (its name and the year in the seal). The
// browser fetches it the first time a note is drawn, so the start view never waits for it.
import "@fontsource/shippori-mincho-b1/latin-700.css";
import { createMap, RAMP_MAX_M, RAMP_MIN_M, rampColor, ringRadiusPx, SETTLE_S } from "./main.js";

// Timeline: how long the whole record takes to arrive at 1x.
const TIMELINE_RUN_S = 20;
const FIRST_YEAR = 684;
const LAST_YEAR = 2026;
const AXIS_TICKS = [684, 1500, 1900, 1950, 2000, 2026];
// One press of an arrow key moves 1% of the timeline, about 11 tsunamis, not one year: the axis is
// scaled by tsunamis, and a year can hold dozens of them.
const ARROW_STEP = 0.01;

const COLUMN_EXAGGERATION = 2000;
const MAX_HEIGHT_M = 524;
const RAMP_STEPS = 5;
const PICK_RADIUS_PX = 6;
const CLICK_SLOP_PX = 5;
// Two clicks this close in time and space are a double click, which zooms. The second click must
// not also close the note the first one opened.
const DOUBLE_CLICK_MS = 350;
const MAX_ZOOM = 11; // GlobeView swaps to a flat Mercator view above zoom 12, which I never want.
const TILT_DEG = 35;
const FLY_MS = 800;
const ZOOM_STEP = 1;
const FLY_TO_RING_ZOOM = 3;

const PHONE_MAX_WIDTH_PX = 900;
const SHEET_CLOSED_SHARE = 0.3;
const SHEET_OPEN_SHARE = 0.92;
// Map button tooltips: a hover has to rest this long before the label shows, so a mouse that only
// passes over the strip does not flash labels. Keyboard focus shows it at once.
const TOOLTIP_DELAY_MS = 400;
const TOOLTIP_GAP_PX = 6;
// The opening: the start view stands still this long after the map is ready, then the record plays.
const AUTOPLAY_PAUSE_MS = 400;
// One stalled frame (a tab coming back from the background, a busy phone) must not jump the
// timeline ahead. Anything that draws at least two frames a second still plays in real time.
const MAX_STEP_S = 0.5;

const NCEI_EVENT_URL = "https://www.ngdc.noaa.gov/hazel/view/hazards/tsunami/event-more-info/";
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

// The click note is set like a hanko, the red seal stamped on Japanese documents: the record's
// three strokes are stamped over again in shu red, a fine line leads to the note, and the date sits
// in a small square seal beside the name.
// The mark: the same three strokes main.js draws (shares of the outer radius), each a little finer
// than the one outside it. A 1 m gauge reading is a ring of one or two pixels on the whole globe,
// so the mark never shrinks below the 5 px the three red highlight rings keep for the same reason.
const MARK_STROKE_SHARES = [1, 0.66, 0.33];
const MARK_STROKE_PX = [1.6, 1.2, 1];
const MARK_MIN_RADIUS_PX = 5;
const MARK_SEGMENTS = 72;
// A column is 2 px in radius (main.js); its outline sits just outside it, on the top face.
const COLUMN_MARK_RADIUS_PX = 3.5;
// The seal: a 52 px square at the left of a 66 px column (style.css sets the same sizes).
const SEAL_PX = 52;
// Where the note goes: this far beyond the outer stroke, and this far from every edge and control.
const NOTE_GAP_PX = 28;
const NOTE_MARGIN_PX = 8;

// "In numbers", one line each, in the order the reader meets them: the counts first, then the lines
// with a place on the map. A line is a list of parts: plain text, or a number in the readout face
// with its unit in the text face, so "524 m" reads with a normal space instead of a wide monospace
// gap. Every number names the figure it comes from and is checked against key_figures.json when the
// page starts, so these lines can never drift away from the data.
const FIGURE_LINES = [
  {
    parts: [
      { number: "29,340", figure: "ring_count" },
      " records from ",
      { number: "1,124", figure: "tsunami_count" },
      " tsunamis, one for each place a wave was measured",
    ],
  },
  { parts: [{ number: "84", unit: "%", figure: "pacific_share" }, " of the records are in the Pacific"] },
  { parts: [{ number: "40", unit: "%", figure: "japan_share" }, " of all records are in Japan"] },
  { parts: ["First: Atashika, Japan, ", { number: "684", figure: "year_span" }], place: "first" },
  {
    parts: [
      "Tallest: Lituya Bay, Alaska, ",
      { number: "524", unit: " m", figure: "max_runup" },
      " in ",
      { number: "1958", figure: "max_runup" },
    ],
    place: "tallest",
  },
  {
    // The map highlights one record of the 2004 event (NCEI names it after Langi Island). The line
    // names the whole event, as readers know it.
    parts: [
      { number: "227,899", figure: "death_toll" },
      " people died in ",
      { number: "2004", figure: "death_toll" },
      " in the Indian Ocean, the deadliest",
    ],
    place: "deadliest",
  },
];

// The crosshair on a line with a place: the only button in "In numbers".
const CROSSHAIR_SVG =
  '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M7 0.5v3M7 10.5v3M0.5 7h3M10.5 7h3"/></svg>';

const byId = (id) => document.getElementById(id);
/** "2026-11-05" -> "5 November 2026". Read as UTC, so no time zone can shift the day. */
function longDate(isoDay) {
  const [year, month, day] = isoDay.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

const isPhone = () => window.innerWidth <= PHONE_MAX_WIDTH_PX;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const easeOut = (x) => 1 - (1 - x) ** 3;
const metres = (m) => `${m < 10 ? Number(m.toFixed(1)) : Math.round(m)} m`;


function shortRampHeight(m) {
  if (m >= RAMP_MAX_M) return `${RAMP_MAX_M} m+`;
  return m < 1 ? `${Number(m.toFixed(1))}` : `${Math.round(m)}`;
}

/** The ramp on the map is continuous, so these five steps are even samples of it on its log scale. */
function renderRamp() {
  const holder = byId("ramp");
  const logMin = Math.log10(RAMP_MIN_M);
  const logMax = Math.log10(RAMP_MAX_M);
  const shares = Array.from({ length: RAMP_STEPS }, (_, k) => k / (RAMP_STEPS - 1));
  const heights = shares.map((share) => 10 ** (logMin + (logMax - logMin) * share));
  for (const share of shares) {
    const step = document.createElement("i");
    step.style.background = `rgb(${rampColor(share).join(" ")})`;
    holder.append(step);
  }
  for (const heightM of heights) {
    const label = document.createElement("span");
    label.textContent = shortRampHeight(heightM);
    holder.append(label);
  }
  holder.setAttribute(
    "aria-label",
    `Colour ramp from ${shortRampHeight(heights[0])} m to ${shortRampHeight(heights.at(-1))}`,
  );
}

const overlaps = (a, b) => a.left < b.right + 6 && b.left < a.right + 6;

const LABEL_GAP_PX = 6;
const ROW_PX = 14;
// Tick labels: one row under the axis line, and a label closer than this to its neighbour is dropped.
const LABEL_TOP_PX = 52;
const TICK_LABEL_GAP_PX = 8;

/**
 * Ticks at round years, each placed where that year's first ring sits on the timeline. Very few
 * records predate 1900, so 684, 1500 and 1900 crowd into the first millimetres. Every label is
 * centred on its own tick, as on a printed chart, all in one row; a label that would crowd its
 * neighbour is left out together with its tick. The two ends, 684 and 2026, always stay.
 * The note on the scale goes on its own line, right-aligned with the last year label.
 */
function renderAxis(axis, yearStartShare) {
  const add = (className, leftShare, text = "") => {
    const element = document.createElement("span");
    element.className = className;
    element.style.left = `${leftShare * 100}%`;
    element.textContent = text;
    axis.append(element);
    return element;
  };
  const note = axis.querySelector(".axis-note");
  const placeTicks = () => {
    for (const old of axis.querySelectorAll(".axis-tick, .axis-label")) old.remove();
    const widthPx = axis.clientWidth;
    // Every label sits on the same count scale as its tick: yearStartShare() gives both, and each
    // label is centred on its tick, the two ends included. On a count scale the early centuries
    // share a few pixels, so a label that would crowd its neighbour is left out, and its tick with
    // it: a tick without a year only looks like a mistake. The two ends always stay.
    const labels = AXIS_TICKS.map((year, k) => {
      const atStart = k === 0;
      const atEnd = k === AXIS_TICKS.length - 1;
      const share = atStart ? 0 : atEnd ? 1 : yearStartShare(year);
      const element = add("axis-label", 0, `${year}`);
      const width = element.getBoundingClientRect().width;
      const left = share * widthPx - width / 2;
      return { element, share, left, right: left + width, end: atStart || atEnd, keep: atStart || atEnd };
    });
    const last = labels.at(-1);
    let previous = labels[0];
    for (const label of labels.slice(1, -1)) {
      const crowded =
        label.left < previous.right + TICK_LABEL_GAP_PX || label.right > last.left - TICK_LABEL_GAP_PX;
      if (crowded) continue;
      label.keep = true;
      previous = label;
    }
    for (const { element, share, left, end, keep } of labels) {
      if (!keep) {
        element.remove();
        continue;
      }
      add(`axis-tick${end ? " end" : ""}`, share);
      element.style.left = `${left}px`;
      element.style.top = `${LABEL_TOP_PX}px`;
    }
    // The note on the scale gets a line of its own under the labels, its right edge on the right
    // edge of the "2026" label above it, so the two read as one column.
    note.style.left = `${last.right - note.getBoundingClientRect().width}px`;
    note.style.top = `${LABEL_TOP_PX + ROW_PX}px`;
    axis.style.height = `${LABEL_TOP_PX + 2 * ROW_PX}px`;
  };
  return { add, placeTicks };
}

/**
 * The named events, above the axis, each starting at its tick. When two would touch, the earlier
 * one moves up a line: its leader runs up its own left edge, so it never crosses the later label.
 */
function renderEvents(axis, add, events) {
  for (const old of axis.querySelectorAll(".axis-event, .axis-event-line")) old.remove();
  const placed = events.map(({ share, text }) => ({
    line: add("axis-event-line row-1", share),
    label: add("axis-event row-1", share, text),
  }));
  for (let k = placed.length - 1; k > 0; k -= 1) {
    const later = placed[k].label.getBoundingClientRect();
    const earlier = placed[k - 1].label.getBoundingClientRect();
    if (earlier.right + LABEL_GAP_PX > later.left) {
      placed[k - 1].label.classList.replace("row-1", "row-2");
      placed[k - 1].line.classList.replace("row-1", "row-2");
    }
  }
}

/** Fail loudly if a sentence no longer agrees with data/key_figures.json. */
function checkFigures(figures) {
  const byFigure = Object.fromEntries(figures.map((figure) => [figure.id, figure]));
  for (const { parts } of FIGURE_LINES) {
    for (const { number, unit = "", figure } of parts.filter((part) => typeof part !== "string")) {
      if (!byFigure[figure]?.display.includes(`${number}${unit}`)) {
        throw new Error(`"${number}${unit}" is not in the ${figure} figure: ${byFigure[figure]?.display}`);
      }
    }
  }
}

/** The second line of the seal: "11 Mar", or "Mar" alone, or nothing when only the year is known. */
function sealDay(rings, i) {
  const month = rings.month[i];
  if (month === null) return "";
  return rings.day[i] === null ? MONTHS[month - 1] : `${rings.day[i]} ${MONTHS[month - 1]}`;
}

/** Names in the database are upper case, so title case turns AK into Ak and USA into Usa. */
function placeName(rings, i) {
  const place = rings.locationName[i].replace(/, ([A-Z][a-z])$/, (_, code) => `, ${code.toUpperCase()}`);
  const country = rings.country[i]?.replace(/^Usa\b/, "USA").replace(/^Uk\b/, "UK");
  return [place, country].filter(Boolean).join(", ");
}

/**
 * The values of the note as sentences, each a list of parts like FIGURE_LINES: plain text, or a
 * number in the readout face with its unit in the text face. The deaths field counts the dead at
 * this place, not for the whole tsunami (Nagapattinam lost 6,051 people in 2004, the whole event
 * 227,899), so the sentence says "here". Death tolls from old records are estimates, so from a
 * hundred up I round to three figures and say "about"; a small count is given as it is.
 */
function noteSentences(rings, i) {
  // Tide gauges read to the centimetre, so a height under a metre keeps two decimals (0.14 m).
  const runupM = rings.runup_m[i];
  const heightM = Number(runupM.toFixed(runupM < 1 ? 2 : 1)).toLocaleString("en-US");
  const sentences = [["Water reached ", { number: heightM, unit: " m" }, " above the sea."]];
  const deaths = rings.deaths[i];
  if (deaths) {
    const rounded = deaths >= 100 ? Number(deaths.toPrecision(3)) : deaths;
    const people = rounded.toLocaleString("en-US");
    sentences.push([
      `The tsunami killed ${deaths >= 100 ? "about " : ""}`,
      { number: people },
      deaths === 1 ? " person here." : " people here.",
    ]);
  }
  return sentences;
}

/** Append text parts to an element: strings as text, numbers in the readout face. */
function appendParts(element, parts) {
  for (const part of parts) {
    if (typeof part === "string") {
      element.append(part);
      continue;
    }
    const number = document.createElement("b");
    number.textContent = part.number;
    element.append(number, part.unit ?? "");
  }
}

const partsText = (parts) =>
  parts.map((part) => (typeof part === "string" ? part : `${part.number}${part.unit ?? ""}`)).join("");

/** Rectangles as { left, top, right, bottom }, and whether two of them touch. */
const grow = (box, px) => ({
  left: box.left - px,
  top: box.top - px,
  right: box.right + px,
  bottom: box.bottom + px,
});
const touches = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function startFit() {
  // The radius of the globe is 256 * 2^zoom / (pi cos lat) px on this view. I leave room around it
  // for the title at the top left of the map area.
  const area = byId("map").getBoundingClientRect();
  const radiusPx = Math.min(area.width, area.height) * (isPhone() ? 0.34 : 0.36);
  return Math.log2((radiusPx * Math.PI * Math.cos((15 * Math.PI) / 180)) / 256);
}

async function startPage() {
  const startCamera = { longitude: -170, latitude: 15, zoom: startFit(), pitch: 0, bearing: 0 };
  const ui = {
    clockS: 0,
    speed: 1,
    // Nothing plays until the map is ready (see the tick at the end). With reduced motion the
    // record is shown whole and never plays by itself.
    playing: false,
    autoplay: !reducedMotion(),
    autoplayAtMs: null,
    // The page around the map is shown with the first tick, so the pause starts counting only once
    // that frame and one more have been drawn: on a slow device the first paint alone can take
    // longer than the pause.
    framesBeforePause: 2,
    settled: reducedMotion(),
    minHeightM: 0,
    mark: "rings",
    showRunups: true,
    showHighlights: true,
    annotated: null,
  };
  const runS = () => TIMELINE_RUN_S / ui.speed;
  let draw = () => {};
  let flight = null;
  // The button the tooltip names, if any. draw() reads it, so it lives up here with the other state.
  let tooltipFor = null;
  let tooltipTimer = null;

  const annotation = byId("annotation");
  const annotationLive = byId("annotation-live");
  const noteMark = byId("note-mark");
  const markRings = [...noteMark.querySelectorAll(".mark-ring")];
  const markColumn = byId("mark-column");
  const noteLeader = byId("note-leader");

  const map = createMap(byId("map"), {
    camera: startCamera,
    controller: {
      dragRotate: true,
      touchRotate: true,
      // deck.gl times a double click by itself, and a slow pick can make it miss. See dblclick below.
      doubleClickZoom: false,
      inertia: false,
      // My own keys step the timeline (see the keydown handler), so deck.gl must not also pan.
      keyboard: false,
      minZoom: 0,
      maxZoom: MAX_ZOOM,
      maxPitch: 60,
    },
    pickable: true,
    // A phone at 3x would draw 2.25 times the pixels of 2x for a difference nobody sees on a globe.
    useDevicePixels: Math.min(window.devicePixelRatio, 2),
    grainElement: byId("texture"),
    onViewChange: () => {
      flight = null;
      draw();
    },
    // The map answers a click (a tap on touch) and nothing else: no hover note, no highlight, no
    // cursor change under the pointer. deck.gl only sends a click when the pointer did not drag.
    deckProps: {
      pickingRadius: PICK_RADIUS_PX,
      onClick: (info) => onMapClick(info),
    },
  });
  // The frame ready waits for is the first step of the timeline (or the whole record with reduced
  // motion), so the globe that appears is exactly the one the opening starts from.
  map.setTime(reducedMotion() ? null : { clockS: 0, durationS: runS() });
  await Promise.all([
    map.ready,
    document.fonts.load('400 14px "IBM Plex Serif"'),
    document.fonts.load('600 14px "IBM Plex Serif"'),
  ]);

  const { rings, highlights, highlightKeys, n } = map.data;
  checkFigures(map.figures);
  // Where each year begins on the timeline. The timeline runs on each ring's t, the rank of its
  // tsunami (prepare.py), and the rings come in that order, so a year's first ring has its lowest t.
  const yearStart = new Map();
  for (let i = 0; i < n; i += 1) {
    if (!yearStart.has(rings.year[i])) yearStart.set(rings.year[i], rings.t[i]);
  }
  const yearStartShare = (year) => {
    for (let y = year; y <= LAST_YEAR; y += 1) {
      if (yearStart.has(y)) return yearStart.get(y);
    }
    return 1;
  };
  // The last ring the timeline has reached at a given share: a binary search, since t only grows.
  const lastRingAt = (share) => {
    let low = 0;
    let high = n - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (rings.t[middle] <= share) low = middle;
      else high = middle - 1;
    }
    return low;
  };

  /* ---------- Text from the data ---------- */

  const count = map.figures.find((figure) => figure.id === "ring_count").value;
  const countText = count.toLocaleString("en-US");
  const tsunamiTotal = map.figures
    .find((figure) => figure.id === "tsunami_count")
    .value.toLocaleString("en-US");
  // The first year comes from key_figures.json too, so every claim in the lede has a source.
  const firstYear = map.figures.find((figure) => figure.id === "year_span").value[0];
  byId("lede").innerHTML =
    `<b>${countText}</b> tsunami records since the year ${firstYear}, sized by wave height.`;
  byId("key-runups-count").textContent = countText;
  byId("read-note").textContent =
    `Size and colour show the wave height. In 3D, column height is wave height x ${COLUMN_EXAGGERATION.toLocaleString("en-US")}.`;
  renderRamp();
  // The axis labels are measured to find collisions, so the page has to be visible first, and they
  // are placed again whenever the window changes width.
  document.getElementById("ui").hidden = false;
  const axisParts = renderAxis(byId("axis"), yearStartShare);
  // The events name the record, the same words as the key's "First, tallest, deadliest" and the
  // In numbers lines, so the three red marks read the same way everywhere.
  const events = [
    ["first", "first"],
    ["tallest", "tallest"],
    ["deadliest", "deadliest"],
  ].map(([key, name]) => {
    const { index } = highlights[key];
    return { share: rings.t[index], text: `${rings.year[index]} ${name}` };
  });
  const placeAxis = () => {
    axisParts.placeTicks();
    renderEvents(byId("axis"), axisParts.add, events);
  };
  placeAxis();
  window.addEventListener("resize", placeAxis);

  const numbers = byId("numbers");
  FIGURE_LINES.forEach(({ parts, place }, lineIndex) => {
    const line = document.createElement("p");
    line.className = "figure";
    const text = document.createElement("span");
    text.id = `figure-${lineIndex}`;
    for (const part of parts) {
      if (typeof part === "string") {
        text.append(part);
        continue;
      }
      const number = document.createElement("b");
      number.textContent = part.number;
      text.append(number, part.unit ?? "");
    }
    line.append(text);
    if (place) {
      // The text stays plain text. Only the crosshair flies to the place, and its name plus the line
      // it belongs to tell a screen reader where it goes.
      const button = document.createElement("button");
      button.type = "button";
      button.className = "show-on-map";
      button.setAttribute("aria-label", "Show on map");
      button.setAttribute("aria-describedby", text.id);
      button.innerHTML = CROSSHAIR_SVG;
      button.addEventListener("click", () => showHighlight(place));
      line.append(button);
    }
    numbers.append(line);
  });

  /* ---------- Annotation: the seal stamp ---------- */

  const hasHighlight = new Set(highlightKeys.map((key) => highlights[key].index));
  // Shippori Mincho B1 Bold is only needed by the note. I ask for it once the start view stands,
  // so the first note a reader opens is already set in it.
  document.fonts.load('700 21px "Shippori Mincho B1"');

  /** Close the note. draw() passes redraw false, since it is already drawing. */
  function closeAnnotation(redraw = true) {
    if (ui.annotated === null) return;
    ui.annotated = null;
    annotation.hidden = true;
    noteMark.toggleAttribute("hidden", true);
    document.body.classList.remove("note-over-hint");
    annotationLive.textContent = "";
    // The label of a red record comes back once its note is closed.
    if (redraw) draw();
  }

  function openAnnotation(index) {
    ui.annotated = index;
    annotation.replaceChildren();

    const seal = document.createElement("div");
    seal.className = "seal";
    const year = document.createElement("span");
    year.className = "seal-year";
    year.textContent = rings.year[index];
    seal.append(year);
    const day = sealDay(rings, index);
    if (day) {
      const dayLine = document.createElement("span");
      dayLine.className = "seal-day";
      dayLine.textContent = day;
      seal.append(dayLine);
    }

    const body = document.createElement("div");
    body.className = "note-body";
    const name = document.createElement("h3");
    name.textContent = placeName(rings, index);
    body.append(name);
    const sentences = noteSentences(rings, index);
    const values = document.createElement("p");
    values.className = "note-values";
    sentences.forEach((parts, k) => {
      if (k > 0) values.append(" ");
      appendParts(values, parts);
    });
    body.append(values);
    const source = document.createElement("p");
    source.className = "note-source";
    const eventId = rings.tsunamiEventId[index];
    source.append("Source: NOAA NCEI, event ");
    const link = document.createElement("a");
    link.href = `${NCEI_EVENT_URL}${eventId}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = eventId;
    source.append(link);
    body.append(source);
    annotation.append(seal, body);

    // The same words for a screen reader, in one polite announcement: the date is in the seal, so
    // it is spelled out here.
    const date = [sealDay(rings, index), rings.year[index]].filter(Boolean).join(" ");
    annotationLive.textContent = [
      `${name.textContent}, ${date}.`,
      ...sentences.map(partsText),
      `Source: NOAA NCEI, event ${eventId}.`,
    ].join(" ");

    // The note fades in over 150 ms (style.css); restarting the animation fades every new note.
    for (const element of [annotation, noteMark]) {
      element.classList.remove("opening");
      void element.offsetWidth;
      element.classList.add("opening");
    }
    // draw() puts the labels away for this record and then places the note.
    draw();
  }

  /** Is the record on the map right now? Filters and the timeline can take it away. */
  function recordShown(index, shown) {
    if (!ui.showRunups && !(ui.showHighlights && hasHighlight.has(index))) return false;
    return shown.includes(index);
  }

  /**
   * Screen points of a circle lying flat on the globe. The rings are drawn on the surface, not
   * turned to face the camera, so near the rim of the globe or on a tilted view a ring is an
   * ellipse. deck.gl turns a radius in pixels into its own units by dividing by the view's scale and
   * lays it out on the plane that touches the globe at the ring's centre. I do the same here, in
   * JavaScript, so the red strokes land exactly on the ones the GPU drew.
   */
  function flatCircle(viewport, lon, lat, elevationM, radiusPx, segments) {
    const centre = viewport.projectPosition([lon, lat, elevationM]);
    const length = Math.hypot(...centre);
    const up = centre.map((v) => v / length);
    // East is at right angles to up and to the globe's axis; north completes the plane.
    const eastRaw = [-up[1], up[0], 0];
    const eastLength = Math.hypot(...eastRaw) || 1;
    const east = eastRaw.map((v) => v / eastLength);
    const north = [
      up[1] * east[2] - up[2] * east[1],
      up[2] * east[0] - up[0] * east[2],
      up[0] * east[1] - up[1] * east[0],
    ];
    const radius = radiusPx / viewport.scale;
    const m = viewport.pixelProjectionMatrix;
    const points = [];
    for (let k = 0; k < segments; k += 1) {
      const angle = (2 * Math.PI * k) / segments;
      const c = Math.cos(angle) * radius;
      const s = Math.sin(angle) * radius;
      const x = centre[0] + east[0] * c + north[0] * s;
      const y = centre[1] + east[1] * c + north[1] * s;
      const z = centre[2] + east[2] * c + north[2] * s;
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      points.push([(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w]);
    }
    return points;
  }

  const pathOf = (points) => `M${points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L")}Z`;
  const boxOf = (points) => ({
    left: Math.min(...points.map((p) => p[0])),
    top: Math.min(...points.map((p) => p[1])),
    right: Math.max(...points.map((p) => p[0])),
    bottom: Math.max(...points.map((p) => p[1])),
  });

  /** Where the note may not go: the controls on the map, read from the page as it is laid out. */
  function noteObstacles() {
    const ids = ["title", "hint", "map-buttons", "sheet-open"];
    const elements = ids
      .map((id) => byId(id))
      // checkVisibility, not offsetParent: these controls are position: fixed, and a fixed element
      // never has an offsetParent.
      .filter((element) => element?.checkVisibility());
    // The names of the other red records, so the note never lies across them.
    elements.push(...labelHolder.children);
    return elements.map((element) => grow(element.getBoundingClientRect(), NOTE_MARGIN_PX));
  }

  /**
   * Draw the mark and the leader, and place the note beside the record: to its right, or to its
   * left near the right edge, with the name level with the record. If neither side has room
   * (always the case on a phone), the note goes to the foot of the map, just above the bottom
   * sheet and the controls, or under the title when the record itself lies down there.
   */
  function placeAnnotation() {
    if (ui.annotated === null) return;
    const index = ui.annotated;
    const viewport = map.deck.getViewports()[0];
    const onNearSide = viewport && map.project(rings.lon[index], rings.lat[index]) !== null;
    annotation.hidden = !onNearSide;
    // SVG elements have no hidden property, so the attribute is set directly.
    noteMark.toggleAttribute("hidden", !onNearSide);
    if (!onNearSide) {
      document.body.classList.remove("note-over-hint");
      return;
    }

    // The mark, and the box around everything the note must leave uncovered.
    const lon = rings.lon[index];
    const lat = rings.lat[index];
    // The three red records keep their red ring in 3D and have no column, so they keep the
    // ring mark there too.
    const columns = ui.mark === "columns" && !(ui.showHighlights && hasHighlight.has(index));
    let outer;
    let featureBox;
    if (columns) {
      const topM = rings.runup_m[index] * COLUMN_EXAGGERATION;
      outer = flatCircle(viewport, lon, lat, topM, COLUMN_MARK_RADIUS_PX, 6);
      markColumn.setAttribute("d", pathOf(outer));
      const base = flatCircle(viewport, lon, lat, 0, COLUMN_MARK_RADIUS_PX, 6);
      featureBox = boxOf([...outer, ...base]);
    } else {
      const radiusPx = Math.max(ringRadiusPx(rings.runup_m[index], map.camera.zoom), MARK_MIN_RADIUS_PX);
      const strokes = MARK_STROKE_SHARES.map((share) =>
        flatCircle(viewport, lon, lat, 0, radiusPx * share, MARK_SEGMENTS),
      );
      strokes.forEach((points, k) => markRings[k].setAttribute("d", pathOf(points)));
      outer = strokes[0];
      featureBox = boxOf(outer);
    }
    markColumn.toggleAttribute("hidden", !columns);
    for (const ring of markRings) ring.toggleAttribute("hidden", columns);
    // The note lines up with the mark (for a column, its top), not with the middle of the column.
    const outerBox = boxOf(outer);
    const centre = [(outerBox.left + outerBox.right) / 2, (outerBox.top + outerBox.bottom) / 2];

    // The note, measured as it is set, and the spot of its name.
    const area = grow(byId("map").getBoundingClientRect(), -NOTE_MARGIN_PX);
    const noteW = annotation.offsetWidth;
    const noteH = annotation.offsetHeight;
    const name = annotation.querySelector("h3");
    const nameY = name.offsetTop + Math.min(name.offsetHeight, 26) / 2;
    const feature = grow(featureBox, NOTE_MARGIN_PX);
    // The heart of the record (its centre and inner strokes, or a column's top) is never covered,
    // so a second click on it always reaches it.
    const coreR = columns ? COLUMN_MARK_RADIUS_PX + NOTE_MARGIN_PX : Math.max(10, 0.66 * (outerBox.right - outerBox.left) / 2);
    const core = { left: centre[0] - coreR, top: centre[1] - coreR, right: centre[0] + coreR, bottom: centre[1] + coreR };
    const hintBox = grow(byId("hint").getBoundingClientRect(), NOTE_MARGIN_PX);
    const obstacles = noteObstacles();
    const clampX = (x) => Math.max(area.left, Math.min(area.right - noteW - WASH_RIGHT_PX, x));
    const clampY = (y) => Math.max(area.top + WASH_Y_PX, Math.min(area.bottom - noteH - WASH_Y_PX, y));
    // The note's footprint includes the soft wash behind its words, which reaches past the 280 px
    // (style.css: 12 px above and below, 16 px to the right).
    const WASH_Y_PX = 12;
    const WASH_RIGHT_PX = 16;
    const boxAt = ({ x, y }) => ({
      left: x,
      top: y - WASH_Y_PX,
      right: x + noteW + WASH_RIGHT_PX,
      bottom: y + noteH + WASH_Y_PX,
    });
    const overlapPx2 = (a, b) =>
      Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    // How badly a spot would cover something: nothing at all for a spot that fits. On a phone a
    // big ring can leave no free spot at all, since the map there is barely 450 px high. Then the
    // note may lie across the outer stroke, and as a last resort across the hint line (which steps
    // aside, see below), but never across the heart of the record, the title or the map buttons.
    const cost = (spot) => {
      const box = boxAt(spot);
      const outside =
        Math.max(0, area.left - box.left) + Math.max(0, box.right - area.right) +
        Math.max(0, area.top - box.top) + Math.max(0, box.bottom - area.bottom);
      const controls = obstacles.reduce((sum, other) => sum + overlapPx2(box, other), 0);
      const hint = overlapPx2(box, hintBox);
      return outside * 1e6 + 1000 * overlapPx2(box, core) + overlapPx2(box, feature) + 3 * (controls - hint) + 2 * hint;
    };
    const levelY = clampY(centre[1] - nameY);
    // Heights to try beside the record: level with it, then just under the title, then just above
    // the hint line, so a record in a corner still gets its note beside it.
    const title = byId("title").getBoundingClientRect();
    const foot = Math.min(area.bottom, hintBox.top);
    const below = (edge) => edge + WASH_Y_PX;
    const above = (edge) => edge - WASH_Y_PX - noteH;
    const heights = [levelY, clampY(below(title.bottom + NOTE_MARGIN_PX)), clampY(above(foot))];
    const right = featureBox.right + NOTE_GAP_PX;
    const left = featureBox.left - NOTE_GAP_PX - noteW;
    // Above or below the record, the seal goes straight over or under it first, so the leader
    // drops to the seal without crossing the words.
    // The seal sits at the left of its column, so its centre is half a seal in from the edge.
    const sealCentreX = SEAL_PX / 2;
    const besideY = (y) =>
      [clampX(centre[0] - sealCentreX), clampX(centre[0] - noteW / 2), clampX(area.left), clampX(area.right)].map((x) => ({
        x,
        y: clampY(y),
        side: y > centre[1] ? "below" : "above",
      }));
    const candidates = [
      ...heights.map((y) => ({ x: right, y, side: "right" })),
      ...heights.map((y) => ({ x: left, y, side: "left" })),
      // No room beside it: above the bottom sheet and the hint line, or under the title, or just
      // below or above the record, or just clear of its heart.
      ...besideY(above(foot)),
      ...besideY(below(title.bottom + NOTE_MARGIN_PX)),
      ...besideY(below(feature.bottom)),
      ...besideY(above(feature.top)),
      ...besideY(below(core.bottom)),
      ...besideY(above(core.top)),
    ];
    // The first spot that fits; if none does, the one that covers least, kept inside the map.
    const chosen =
      candidates.find((spot) => cost(spot) === 0) ??
      candidates
        .map((spot) => ({ ...spot, x: clampX(spot.x), y: clampY(spot.y) }))
        .reduce((best, spot) => (cost(spot) < cost(best) ? spot : best));
    // Words on words are unreadable, so if the note had to lie across the hint line, the hint
    // steps aside while this note is open. The reader has just clicked; they know how.
    document.body.classList.toggle("note-over-hint", touches(boxAt(chosen), hintBox));
    annotation.style.transform = `translate(${Math.round(chosen.x)}px, ${Math.round(chosen.y)}px)`;

    // The leader runs to the side of the note that faces the record, level with the name: to the
    // seal on the note's left, or to the end of the name on its right. A note above or below the
    // record gets it on the seal's lower or upper edge when the seal stands over the record, and
    // otherwise on the edge that faces the record, so the line never runs under the words.
    const range = document.createRange();
    range.selectNodeContents(name);
    const firstLine = range.getClientRects()[0] ?? name.getBoundingClientRect();
    const nameRight = chosen.x + (firstLine.right - annotation.getBoundingClientRect().left);
    const nameLevel = chosen.y + nameY;
    const seal = annotation.querySelector(".seal");
    const sealLeft = chosen.x + seal.offsetLeft;
    const sealTop = chosen.y + seal.offsetTop;
    let end;
    if (chosen.side === "right") end = [chosen.x, nameLevel];
    else if (chosen.side === "left") {
      // Level with the name, the line stops at the end of the name; on a slant it stops at the
      // note's edge, clear of the longer lines under the name.
      const level = Math.abs(nameLevel - centre[1]) < 4;
      end = [level ? nameRight + NOTE_MARGIN_PX : chosen.x + noteW, nameLevel];
    } else {
      // Above or below: the seal's near edge, or either side level with the name, whichever line
      // is shortest without crossing the words or the seal.
      // The words: the name's first line as far as it reaches, then the full column under it.
      const body = annotation.querySelector(".note-body");
      const wordsLeft = chosen.x + body.offsetLeft - 4;
      const firstLineBottom = chosen.y + body.offsetTop + firstLine.height;
      const nameLine = { left: wordsLeft, top: chosen.y + body.offsetTop, right: nameRight + 4, bottom: firstLineBottom };
      const rest = { left: wordsLeft, top: firstLineBottom, right: chosen.x + noteW, bottom: chosen.y + noteH };
      const stamp = { left: sealLeft + 1, top: sealTop + 1, right: sealLeft + SEAL_PX - 1, bottom: sealTop + SEAL_PX - 1 };
      const sealEdgeY = chosen.side === "above" ? sealTop + SEAL_PX : sealTop;
      // The right-hand end sits just past the name, never in the empty space beyond it.
      const ends = [
        [sealLeft + SEAL_PX / 2, sealEdgeY],
        [chosen.x, nameLevel],
        [nameRight + NOTE_MARGIN_PX, nameLevel],
      ];
      const inside = (x, y, box) => x > box.left && x < box.right && y > box.top && y < box.bottom;
      const crossing = ([x, y]) => {
        let hits = 0;
        for (let k = 1; k < 64; k += 1) {
          const px = centre[0] + ((x - centre[0]) * k) / 64;
          const py = centre[1] + ((y - centre[1]) * k) / 64;
          if (inside(px, py, nameLine) || inside(px, py, rest) || inside(px, py, stamp)) hits += 1;
        }
        return hits;
      };
      end = ends.reduce((best, candidate) => {
        const score = (e) => crossing(e) * 1e4 + Math.hypot(e[0] - centre[0], e[1] - centre[1]);
        return score(candidate) < score(best) ? candidate : best;
      });
    }
    // It starts on the outer stroke, at the point that faces the end of the line.
    const heading = Math.atan2(end[1] - centre[1], end[0] - centre[0]);
    const start = outer.reduce((best, point) => {
      const angle = Math.atan2(point[1] - centre[1], point[0] - centre[0]);
      const off = Math.abs(Math.atan2(Math.sin(angle - heading), Math.cos(angle - heading)));
      return off < best.off ? { point, off } : best;
    }, { point: outer[0], off: Infinity }).point;
    noteLeader.setAttribute("x1", start[0].toFixed(1));
    noteLeader.setAttribute("y1", start[1].toFixed(1));
    noteLeader.setAttribute("x2", end[0].toFixed(1));
    noteLeader.setAttribute("y2", end[1].toFixed(1));
  }

  /**
   * A click on the globe: open the note of the record under it, close it on a second click on the
   * same record or a click on empty globe. In 3D a column is found by deck.gl's own pick, since its
   * top stands far from the spot where it meets the ground; rings by the nearest centre.
   */
  let lastClick = { atMs: -Infinity, x: 0, y: 0 };
  function onMapClick(info) {
    if (!map.data) return;
    const nowMs = performance.now();
    const second =
      nowMs - lastClick.atMs < DOUBLE_CLICK_MS && Math.hypot(info.x - lastClick.x, info.y - lastClick.y) < CLICK_SLOP_PX;
    lastClick = { atMs: nowMs, x: info.x, y: info.y };
    if (second) return;
    const index = (ui.mark === "columns" ? redRingAt(info.x, info.y) : null)
      ?? (info.layer?.id === "columns" ? map.ringFromPick(info) : null)
      ?? nearestRing(info.x, info.y);
    if (index === null || index === ui.annotated) closeAnnotation();
    else openAnnotation(index);
  }

  /* ---------- Picking ---------- */

  /**
   * The ring a reader means. Big rings overlap small ones, so the stroke under the pointer often
   * belongs to a neighbour: clicking the centre of Lituya Bay would land on the ring of Tracy Arm,
   * 70 km away. So I take every shown ring whose drawn circle reaches the pointer and keep the one
   * whose centre is nearest. On the far side of the globe a ring is never a candidate.
   */
  function nearestRing(x, y) {
    if (!ui.showRunups && !ui.showHighlights) return null;
    const viewport = map.deck.getViewports()[0];
    if (!viewport) return null;
    const { zoom } = map.camera;
    const candidates = [];
    const consider = (index) => {
      const [px, py] = viewport.project([rings.lon[index], rings.lat[index]]);
      const distancePx = Math.hypot(px - x, py - y);
      const reachPx = Math.max(ringRadiusPx(rings.runup_m[index], zoom), 4) + PICK_RADIUS_PX;
      if (distancePx <= reachPx) candidates.push([distancePx, index]);
    };
    if (ui.showRunups) for (const index of map.shownRings()) consider(index);
    else for (const { index } of highlightLayer) consider(index);
    // Several records can share one spot (Lituya Bay has three, from 1853, 1936 and 1958). Among
    // centres within a pixel of the nearest, the red one wins, since it is drawn on top, and
    // otherwise the tallest, whose ring is the one a reader sees there.
    const onNearSide = candidates.filter(
      ([, index]) => map.project(rings.lon[index], rings.lat[index]) !== null,
    );
    if (onNearSide.length === 0) return null;
    const nearestPx = Math.min(...onNearSide.map(([distancePx]) => distancePx));
    const tied = onNearSide.filter(([distancePx]) => distancePx <= nearestPx + 1);
    const rank = (index) =>
      (ui.showHighlights && hasHighlight.has(index) ? 1e6 : 0) + rings.runup_m[index];
    return tied.reduce((best, [, index]) => (rank(index) > rank(best) ? index : best), tied[0][1]);
  }

  /**
   * In 3D the three red records are rings on the ground, drawn over the columns. A click inside one
   * of them means that record, even where another record's column stands on the same spot.
   */
  function redRingAt(x, y) {
    if (!ui.showHighlights) return null;
    const shown = map.shownRings();
    let best = null;
    for (const { index } of highlightLayer) {
      const point = map.project(rings.lon[index], rings.lat[index]);
      if (!point || !shown.includes(index)) continue;
      const reachPx =
        Math.max(ringRadiusPx(rings.runup_m[index], map.camera.zoom), MARK_MIN_RADIUS_PX) + PICK_RADIUS_PX;
      const distancePx = Math.hypot(point[0] - x, point[1] - y);
      if (distancePx <= reachPx && (best === null || distancePx < best.distancePx)) {
        best = { index, distancePx };
      }
    }
    return best?.index ?? null;
  }

  /* ---------- Camera ---------- */

  /** Ease out over a fixed time and never overshoot. With reduced motion, jump straight there. */
  function flyTo(target) {
    if (reducedMotion()) {
      map.setView(target);
      draw();
      return;
    }
    const from = { ...map.camera };
    // The short way round: from 170 to -170 is 20 degrees, not 340.
    const deltaLon = target.longitude === undefined
      ? 0
      : ((target.longitude - from.longitude + 540) % 360) - 180;
    const startMs = performance.now();
    const id = {};
    flight = id;
    const step = (nowMs) => {
      if (flight !== id) return;
      const x = easeOut(Math.min(1, (nowMs - startMs) / FLY_MS));
      const view = { longitude: ((from.longitude + deltaLon * x + 540) % 360) - 180 };
      for (const name of ["latitude", "zoom", "pitch", "bearing"]) {
        view[name] = from[name] + ((target[name] ?? from[name]) - from[name]) * x;
      }
      map.setView(view);
      draw();
      if (x < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const zoomBy = (delta) =>
    flyTo({ zoom: Math.max(0, Math.min(MAX_ZOOM, map.camera.zoom + delta)) });

  /* ---------- Timeline ---------- */

  const timelineShare = () => {
    if (ui.settled) return 1;
    return Math.max(0, Math.min(1, ui.clockS / runS()));
  };

  function setTimeline(share) {
    ui.autoplay = false;
    ui.clockS = share * runS();
    ui.settled = share >= 1;
    ui.playing = false;
    draw();
  }

  function togglePlay() {
    ui.autoplay = false;
    if (!ui.playing && ui.settled) {
      ui.clockS = 0;
      ui.settled = false;
    }
    ui.playing = !ui.playing;
    draw();
  }

  /** The axis is scaled by rings, so a point on it is directly a position on the timeline. */
  function setTimelineFromAxis(clientX) {
    const box = byId("axis").getBoundingClientRect();
    setTimeline(Math.max(0, Math.min(1, (clientX - box.left) / box.width)));
  }

  /* ---------- Drawing the page ---------- */

  const labelHolder = byId("labels");
  const placeLabels = (shown) => {
    labelHolder.replaceChildren();
    // On a phone the globe is small and these names would lie across the brightest coasts. There
    // the three rings stay red, and a tap opens their note like any other ring.
    if (!ui.showHighlights || isPhone()) return;
    const shownNow = new Set(shown);
    for (const key of highlightKeys) {
      const { index, label: text } = highlights[key];
      // While its note is open, the note names the record, and its label would sit where the
      // note goes.
      if (!shownNow.has(index) || index === ui.annotated) continue;
      const point = map.project(rings.lon[index], rings.lat[index]);
      if (!point) continue;
      const radiusPx = Math.max(ringRadiusPx(rings.runup_m[index], map.camera.zoom), 5);
      const label = document.createElement("span");
      label.textContent = text;
      labelHolder.append(label);
      // Near the right edge the label goes on the ring's left side, so it is never cut off.
      const room = labelHolder.clientWidth - point[0] - radiusPx - 6;
      const x = label.offsetWidth < room
        ? point[0] + radiusPx + 6
        : point[0] - radiusPx - 6 - label.offsetWidth;
      label.style.transform = `translate(${x}px, ${point[1]}px) translateY(-50%)`;
    }
  };

  // The three red rings obey the same filters as all others: a filter that hid everything except
  // the highlights would quietly change what a reader thinks is on the map.
  const highlightLayer = highlightKeys.map((key) => ({
    index: highlights[key].index,
    minRadiusPx: 5,
    onlyIfShown: true,
  }));

  draw = () => {
    const durationS = runS();
    const done = ui.settled || ui.clockS >= durationS + SETTLE_S;
    map.setTime(done ? null : { clockS: ui.clockS, durationS });
    map.setLayers({
      rings: ui.showRunups && ui.mark === "rings",
      columns:
        ui.showRunups && ui.mark === "columns"
          ? { exaggeration: COLUMN_EXAGGERATION, rise: 1 }
          : null,
      highlights: ui.showHighlights ? highlightLayer : [],
      minHeightM: ui.minHeightM,
    });

    const shown = map.shownRings();
    // The mark follows its record through the timeline and the filters, and the note closes once
    // the record is no longer on the map (filtered out, or not reached yet).
    if (ui.annotated !== null && !recordShown(ui.annotated, shown)) closeAnnotation(false);
    placeLabels(shown);

    // The current year is the year of the latest ring on the map. If a filter hides every ring so
    // far, the axis still needs a position, so I fall back on the timeline itself.
    const share = done ? 1 : timelineShare();
    const latestYear = shown.length > 0
      ? rings.year[shown[shown.length - 1]]
      : rings.year[lastRingAt(share)];
    byId("year").textContent = latestYear;
    // Under the year: how many of the tsunamis are on the map so far. One tsunami leaves many
    // records, so I count the distinct NCEI event ids among the rings shown, not the rings.
    const shownTsunamis = new Set();
    for (const index of shown) shownTsunamis.add(rings.tsunamiEventId[index]);
    byId("readout-count").textContent =
      `${shownTsunamis.size.toLocaleString("en-US")} of ${tsunamiTotal} tsunamis`;
    const axisShare = share * 100;
    byId("axis-done").style.width = `${axisShare}%`;
    byId("axis-head").style.left = `${axisShare}%`;
    const axis = byId("axis");
    axis.setAttribute("aria-valuenow", latestYear);

    byId("play-word").textContent = ui.playing ? "Pause" : "Play";
    byId("play-icon").innerHTML = ui.playing
      ? '<path d="M6 4h3v12H6zM11 4h3v12h-3z" />'
      : '<path d="M6 4v12l10-6z" />';

    const tilted = map.camera.pitch > 1;
    const tilt = byId("tilt");
    tilt.setAttribute("aria-pressed", String(tilted));
    // The label says what the next click does, so it flips with the tilt. The tooltip reads it.
    const tiltWords = tilted ? "Back to flat" : "Tilt to 3D";
    if (tilt.getAttribute("aria-label") !== tiltWords) {
      tilt.setAttribute("aria-label", tiltWords);
      if (tooltipFor === tilt) showTooltip(tilt);
    }
    byId("north-arrow").style.transform = `rotate(${-map.camera.bearing}deg)`;
    placeAnnotation();
  };

  /* ---------- Controls ---------- */

  const pressWord = (selector, button) => {
    for (const other of document.querySelectorAll(selector)) {
      other.setAttribute("aria-pressed", String(other === button));
    }
  };

  byId("play").addEventListener("click", togglePlay);
  for (const button of document.querySelectorAll("[data-speed]")) {
    button.addEventListener("click", () => {
      // Keep the position on the timeline when the speed changes.
      const share = ui.clockS / runS();
      ui.speed = Number(button.dataset.speed);
      ui.clockS = share * runS();
      pressWord("[data-speed]", button);
      draw();
    });
  }
  for (const button of document.querySelectorAll("[data-mark]")) {
    button.addEventListener("click", () => {
      ui.mark = button.dataset.mark;
      pressWord("[data-mark]", button);
      // Columns stand on the surface, so seen straight from above they have no height to show.
      if (ui.mark === "columns" && map.camera.pitch < 20) flyTo({ pitch: TILT_DEG });
      draw();
    });
  }
  const toggleKey = (button, field) => {
    button.addEventListener("click", () => {
      ui[field] = !ui[field];
      button.setAttribute("aria-pressed", String(ui[field]));
      draw();
    });
  };
  toggleKey(byId("key-runups"), "showRunups");
  toggleKey(byId("key-highlights"), "showHighlights");

  const setMinHeight = (heightM) => {
    ui.minHeightM = heightM;
    byId("min-height-value").textContent = heightM === 0 ? "0 m" : metres(heightM);
    draw();
  };
  byId("min-height").addEventListener("input", (event) => {
    // A square-root slider: most runups are under 10 m and a linear slider could not reach them.
    setMinHeight(MAX_HEIGHT_M * (Number(event.target.value) / 1000) ** 2);
  });

  /** Bring a highlighted ring into view, clearing whatever would hide it, and open its note. */
  function showHighlight(key) {
    const { index } = highlights[key];
    ui.autoplay = false;
    ui.settled = true;
    ui.playing = false;
    ui.showHighlights = true;
    byId("key-highlights").setAttribute("aria-pressed", "true");
    if (!map.shownRings().includes(index) || ui.minHeightM > rings.runup_m[index]) {
      byId("min-height").value = 0;
      setMinHeight(0);
    }
    draw();
    openAnnotation(index);
    flyTo({
      longitude: rings.lon[index],
      latitude: rings.lat[index],
      zoom: Math.max(map.camera.zoom, FLY_TO_RING_ZOOM),
    });
    if (isPhone()) setSheet(false);
  }

  byId("zoom-in").addEventListener("click", () => zoomBy(ZOOM_STEP));
  byId("zoom-out").addEventListener("click", () => zoomBy(-ZOOM_STEP));
  byId("north").addEventListener("click", () => flyTo({ pitch: 0, bearing: 0 }));
  byId("tilt").addEventListener("click", () =>
    flyTo({ pitch: map.camera.pitch > 1 ? 0 : TILT_DEG }),
  );
  byId("home").addEventListener("click", () => flyTo(startCamera));

  // Tooltips: one label to the left of the button, level with it, in the button's own aria-label
  // words. The map buttons line theirs up beside the whole strip. I do not use the title attribute: the
  // browser shows it late, in its own style, and never on keyboard focus. Touch screens get no
  // tooltip, since a tap already does the thing.
  const tooltip = byId("tooltip");
  const strip = byId("map-buttons");
  function showTooltip(button) {
    clearTimeout(tooltipTimer);
    tooltipFor = button;
    // A modal dialog sits in the browser's top layer, above everything else, so a tooltip for a
    // button inside it has to live inside it too.
    const host = button.closest("dialog") ?? byId("ui");
    if (tooltip.parentElement !== host) host.append(tooltip);
    tooltip.textContent = button.getAttribute("aria-label");
    tooltip.hidden = false;
    const anchorBox = (strip.contains(button) ? strip : button).getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    tooltip.style.right = `${window.innerWidth - anchorBox.left + TOOLTIP_GAP_PX}px`;
    tooltip.style.top = `${buttonBox.top + (buttonBox.height - tooltip.offsetHeight) / 2}px`;
  }
  function hideTooltip() {
    clearTimeout(tooltipTimer);
    tooltipFor = null;
    tooltip.hidden = true;
  }
  const withTooltip = [...strip.querySelectorAll("button"), ...numbers.querySelectorAll(".show-on-map")];
  withTooltip.push(byId("about-close"), byId("download-close"));
  for (const button of withTooltip) {
    button.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse") return;
      clearTimeout(tooltipTimer);
      tooltipTimer = setTimeout(() => showTooltip(button), TOOLTIP_DELAY_MS);
    });
    button.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "mouse") return;
      // Leaving a button the keyboard is still on keeps its label, since focus still points at it.
      if (button.matches(":focus-visible")) return;
      hideTooltip();
    });
    // :focus-visible is true for keyboard focus only, so a mouse click or a tap shows nothing here.
    button.addEventListener("focus", () => {
      if (button.matches(":focus-visible")) showTooltip(button);
    });
    button.addEventListener("blur", hideTooltip);
  }

  const axis = byId("axis");
  axis.addEventListener("pointerdown", (event) => {
    axis.setPointerCapture(event.pointerId);
    setTimelineFromAxis(event.clientX);
  });
  axis.addEventListener("pointermove", (event) => {
    if (axis.hasPointerCapture(event.pointerId)) setTimelineFromAxis(event.clientX);
  });

  const mapElement = byId("map");
  mapElement.addEventListener("contextmenu", (event) => event.preventDefault());
  // Grabbing the globe cancels any flight in progress. Clicks on the globe go to onMapClick.
  mapElement.addEventListener("pointerdown", () => {
    flight = null;
  });

  mapElement.addEventListener("dblclick", () => zoomBy(ZOOM_STEP));

  /* ---------- Sheet, hint, keyboard ---------- */

  // The sheet is open on every load and I never store a folded state: the Sources list in it is
  // the map's credit, so a reader always starts with it in view.
  let sheetOpen = false;
  const setFolded = (folded) => {
    document.body.classList.toggle("sheet-folded", folded);
    byId("sheet-open").hidden = !folded;
    // The button that had the tooltip is about to disappear, so its label goes with it.
    hideTooltip();
    draw();
  };
  // The button that was pressed disappears, so focus has to go somewhere: to the button that brings
  // the sheet back, or the one that folds it again. I only move it for the keyboard (a click with
  // detail 0): after a mouse click there is nothing to hand focus on to, and a ring would only
  // draw a second outline around the Map info button.
  byId("sheet-fold").addEventListener("click", (event) => {
    setFolded(true);
    if (event.detail === 0) byId("sheet-open").focus();
  });
  byId("sheet-open").addEventListener("click", (event) => {
    setFolded(false);
    if (event.detail === 0) byId("sheet-fold").focus();
  });

  // How to read the map: a note in a wide tooltip on the small i after "Draw as". The mouse shows it
  // on hover and the keyboard on focus, like the map buttons. A finger has no hover, so a tap
  // toggles it, and a tap anywhere else puts it away.
  const readInfo = byId("read-info");
  const readNote = byId("read-note");
  let readTimer = null;
  let lastPointer = "mouse";
  function showReadNote() {
    clearTimeout(readTimer);
    readNote.hidden = false;
    const icon = readInfo.getBoundingClientRect();
    const left = Math.min(icon.left, window.innerWidth - readNote.offsetWidth - TOOLTIP_GAP_PX);
    readNote.style.left = `${Math.max(TOOLTIP_GAP_PX, left)}px`;
    readNote.style.top = `${icon.bottom + TOOLTIP_GAP_PX}px`;
  }
  function hideReadNote() {
    clearTimeout(readTimer);
    readNote.hidden = true;
  }
  readInfo.addEventListener("pointerdown", (event) => {
    lastPointer = event.pointerType;
  });
  readInfo.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "mouse") return;
    clearTimeout(readTimer);
    readTimer = setTimeout(showReadNote, TOOLTIP_DELAY_MS);
  });
  readInfo.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse" && !readInfo.matches(":focus-visible")) hideReadNote();
  });
  readInfo.addEventListener("focus", () => {
    if (readInfo.matches(":focus-visible")) showReadNote();
  });
  readInfo.addEventListener("blur", () => {
    if (lastPointer === "mouse") hideReadNote();
  });
  readInfo.addEventListener("click", () => {
    if (lastPointer === "mouse") return;
    if (readNote.hidden) showReadNote();
    else hideReadNote();
    lastPointer = "mouse";
  });
  document.addEventListener("pointerdown", (event) => {
    if (event.target.closest?.("#read-info") === null) hideReadNote();
  });
  // The sheet scrolls under a fixed note, so the note goes when the sheet moves.
  byId("sheet").addEventListener("scroll", hideReadNote);

  // The bottom sheet on a phone: tap the grab line to open or close it, or drag it to any height
  // between its two stops. It never goes below the closed stop, where the Layers heading still shows.
  const sheet = byId("sheet");
  const grab = byId("sheet-grab");
  function setSheet(open) {
    sheetOpen = open;
    grab.setAttribute("aria-expanded", String(open));
    sheet.style.setProperty("--sheet-height", `${(open ? SHEET_OPEN_SHARE : SHEET_CLOSED_SHARE) * 100}vh`);
    if (!open) sheet.scrollTop = 0;
  }
  let grabStart = null;
  grab.addEventListener("pointerdown", (event) => {
    grab.setPointerCapture(event.pointerId);
    grabStart = { y: event.clientY, height: sheet.offsetHeight, moved: false };
    swallowClick = false;
  });
  grab.addEventListener("pointermove", (event) => {
    if (!grabStart) return;
    const dy = grabStart.y - event.clientY;
    if (Math.abs(dy) > CLICK_SLOP_PX) grabStart.moved = true;
    if (!grabStart.moved) return;
    const minPx = SHEET_CLOSED_SHARE * window.innerHeight;
    const maxPx = SHEET_OPEN_SHARE * window.innerHeight;
    const heightPx = Math.min(maxPx, Math.max(minPx, grabStart.height + dy));
    sheet.style.setProperty("--sheet-height", `${heightPx}px`);
  });
  // A mouse drag on the grab line ends with a click as well. This flag swallows that one click and
  // is cleared by the next press, so a real tap after a drag always counts.
  let swallowClick = false;
  grab.addEventListener("pointerup", (event) => {
    if (!grabStart) return;
    const { moved, y } = grabStart;
    grabStart = null;
    // A drag settles on whichever end it moved toward. A plain tap waits for the click below: if
    // the sheet moved here, the browser would aim the tap's click at whatever slid under the
    // finger, such as a link in "In numbers".
    if (moved) {
      setSheet(y > event.clientY);
      swallowClick = true;
    }
  });
  grab.addEventListener("click", (event) => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    setSheet(!sheetOpen);
  });

  // The last line of About this map: when the data was fetched. prepare.py copies the download
  // dates from data/raw/sources.json into layers/meta.json. One date for all sources gives one line;
  // sources fetched on different days get a line each, so a reader can tell how fresh each one is.
  fetch(new URL("layers/meta.json", document.baseURI))
    .then((response) => {
      if (!response.ok) throw new Error(`layers/meta.json: HTTP ${response.status}`);
      return response.json();
    })
    .then(({ sources }) => {
      const days = [...new Set(sources.map((source) => source.downloaded))];
      const lines = days.length === 1
        ? [`Data fetched ${longDate(days[0])}.`]
        : sources.map((source) => `${source.label} fetched ${longDate(source.downloaded)}.`);
      byId("data-fetched").replaceChildren(
        ...lines.map((text) => Object.assign(document.createElement("p"), { textContent: text })),
      );
    });

  // About this map: a native modal dialog, so the browser keeps focus inside it and Escape closes
  // it. Focus goes to the dialog itself, not its first control, so the notes read from the top;
  // on close it goes back to the link that opened them.
  // "Download the data" works the same way.
  const dialogs = ["about", "download"].map((name) => {
    const dialog = byId(name);
    const opener = byId(`${name}-open`);
    opener.addEventListener("click", () => {
      closeAnnotation();
      dialog.showModal();
      dialog.scrollTop = 0;
      dialog.focus();
    });
    byId(`${name}-close`).addEventListener("click", () => dialog.close());
    // The padding lives on the inner div, so only a click on the backdrop has the dialog as target.
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      hideTooltip();
      opener.focus();
    });
    return dialog;
  });

  window.addEventListener("keydown", (event) => {
    // While the notes are open the map is behind a modal: the dialog handles its own Escape, and
    // Space or the arrows must not play the timeline underneath.
    if (dialogs.some((dialog) => dialog.open)) return;
    if (event.key === "Escape" && (tooltipFor !== null || !readNote.hidden)) {
      hideTooltip();
      hideReadNote();
      return;
    }
    const target = event.target;
    const onControl = target.closest?.("button, a, input");
    if (event.key === " ") {
      // Space on a button presses that button; everywhere else it plays the timeline.
      if (onControl && target.id !== "min-height") return;
      event.preventDefault();
      togglePlay();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (target.id === "min-height") return;
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      setTimeline(Math.max(0, Math.min(1, timelineShare() + direction * ARROW_STEP)));
    } else if (event.key === "Escape") {
      if (ui.annotated !== null) closeAnnotation();
      else if (isPhone()) setSheet(false);
      else setFolded(true);
    }
  });

  let lastMs = null;
  const tick = (nowMs) => {
    // The opening starts here and only here: the first tick runs after map.ready, which means the
    // start view is fully drawn. Once the page around it is on screen too, it stands still for
    // AUTOPLAY_PAUSE_MS, counted on animation frames, and plays from the first step. Any timeline
    // control used before that cancels it.
    if (ui.autoplay && ui.framesBeforePause > 0) {
      ui.framesBeforePause -= 1;
    } else if (ui.autoplay) {
      ui.autoplayAtMs ??= nowMs + AUTOPLAY_PAUSE_MS;
      if (nowMs >= ui.autoplayAtMs) {
        ui.autoplay = false;
        ui.playing = true;
        lastMs = nowMs;
        draw();
      }
    }
    if (ui.playing) {
      ui.clockS += lastMs === null ? 0 : Math.min(MAX_STEP_S, (nowMs - lastMs) / 1000);
      if (ui.clockS >= runS() + SETTLE_S) {
        ui.playing = false;
        ui.settled = true;
      }
      draw();
    }
    lastMs = nowMs;
    requestAnimationFrame(tick);
  };

  window.addEventListener("resize", draw);
  draw();
  requestAnimationFrame(tick);
  // Open the browser console and try it: atlasMap.setView({ longitude: 138, latitude: 36, zoom: 4 })
  window.atlasMap = map;
}

startPage();
