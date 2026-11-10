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

function formatDate(rings, i) {
  const month = rings.month[i];
  const day = rings.day[i];
  if (month !== null && day !== null) return `On ${day} ${MONTHS[month - 1]} ${rings.year[i]}`;
  if (month !== null) return `In ${MONTHS[month - 1]} ${rings.year[i]}`;
  return `In ${rings.year[i]}`;
}

/** Names in the database are upper case, so title case turns AK into Ak and USA into Usa. */
function placeName(rings, i) {
  const place = rings.locationName[i].replace(/, ([A-Z][a-z])$/, (_, code) => `, ${code.toUpperCase()}`);
  const country = rings.country[i]?.replace(/^Usa\b/, "USA").replace(/^Uk\b/, "UK");
  return [place, country].filter(Boolean).join(", ");
}

function annotationSentence(rings, i) {
  const deaths = rings.deaths[i];
  const start = `${formatDate(rings, i)} the water reached ${rings.runup_m[i]} m`;
  if (!deaths) return `${start}.`;
  const people = deaths === 1 ? "1 person" : `${deaths.toLocaleString("en-US")} people`;
  return `${start}, and ${people} died here.`;
}

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
    pinned: false,
  };
  const runS = () => TIMELINE_RUN_S / ui.speed;
  let draw = () => {};
  let flight = null;
  // The button the tooltip names, if any. draw() reads it, so it lives up here with the other state.
  let tooltipFor = null;
  let tooltipTimer = null;

  const annotation = byId("annotation");
  const leader = byId("leader");
  const dot = byId("feature-dot");

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
    deckProps: {
      pickingRadius: PICK_RADIUS_PX,
      onHover: (info) => {
        // A finger has no hover: on touch the note opens with a tap.
        if (ui.pinned || !map.data || !window.matchMedia("(hover: hover)").matches) return;
        const index = info.x >= 0 ? nearestRing(info.x, info.y) : null;
        if (index === null) closeAnnotation();
        else if (index !== ui.annotated) openAnnotation(index, false);
      },
      getCursor: ({ isDragging, isHovering }) =>
        isDragging ? "grabbing" : isHovering ? "pointer" : "grab",
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

  /* ---------- Annotation ---------- */

  function closeAnnotation() {
    ui.annotated = null;
    ui.pinned = false;
    annotation.hidden = true;
    leader.hidden = true;
    dot.hidden = true;
    annotation.classList.remove("pinned");
  }

  function openAnnotation(index, pinned) {
    ui.annotated = index;
    ui.pinned = pinned;
    annotation.replaceChildren();
    const name = document.createElement("h3");
    name.textContent = placeName(rings, index);
    const sentence = document.createElement("p");
    sentence.textContent = annotationSentence(rings, index);
    const source = document.createElement("p");
    source.className = "annotation-source";
    source.append("Source: NOAA NCEI. ");
    const link = document.createElement("a");
    link.href = `${NCEI_EVENT_URL}${rings.tsunamiEventId[index]}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = `NCEI event ${rings.tsunamiEventId[index]}`;
    source.append(link);
    annotation.append(name, sentence, source);
    annotation.classList.toggle("pinned", pinned);
    placeAnnotation();
  }

  /** The note follows its ring when the globe moves, and hides when the ring goes round the back. */
  function placeAnnotation() {
    if (ui.annotated === null) return;
    const point = map.project(rings.lon[ui.annotated], rings.lat[ui.annotated]);
    const area = byId("map").getBoundingClientRect();
    const visible =
      point && point[0] >= 0 && point[1] >= 0 && point[0] <= area.width && point[1] <= area.height;
    annotation.hidden = !visible;
    leader.hidden = !visible;
    dot.hidden = !visible;
    if (!visible) return;
    const [x, y] = point;
    const { offsetWidth: noteW, offsetHeight: noteH } = annotation;
    const side = x + 44 + noteW + 12 > area.width ? -1 : 1;
    const noteX = side > 0 ? x + 44 : x - 44 - noteW;
    const noteY = Math.max(8, Math.min(area.height - noteH - 8, y - noteH - 28));
    annotation.style.transform = `translate(${Math.max(8, noteX)}px, ${noteY}px)`;
    dot.style.transform = `translate(${x}px, ${y}px)`;
    // The line ends at the foot of the thin rule on the note's left side.
    const endX = Math.max(8, noteX);
    const dx = endX - x;
    const dy = noteY + noteH - y;
    leader.style.width = `${Math.hypot(dx, dy)}px`;
    leader.style.transform = `translate(${x}px, ${y}px) rotate(${Math.atan2(dy, dx)}rad)`;
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
    candidates.sort((a, b) => a[0] - b[0]);
    const nearest = candidates.find(
      ([, index]) => map.project(rings.lon[index], rings.lat[index]) !== null,
    );
    return nearest ? nearest[1] : null;
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
      if (!shownNow.has(index)) continue;
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
      closeAnnotation();
      // Columns stand on the surface, so seen straight from above they have no height to show.
      if (ui.mark === "columns" && map.camera.pitch < 20) flyTo({ pitch: TILT_DEG });
      draw();
    });
  }
  const toggleKey = (button, field) => {
    button.addEventListener("click", () => {
      ui[field] = !ui[field];
      button.setAttribute("aria-pressed", String(ui[field]));
      closeAnnotation();
      draw();
    });
  };
  toggleKey(byId("key-runups"), "showRunups");
  toggleKey(byId("key-highlights"), "showHighlights");

  const setMinHeight = (heightM) => {
    ui.minHeightM = heightM;
    byId("min-height-value").textContent = heightM === 0 ? "0 m" : metres(heightM);
    closeAnnotation();
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
    openAnnotation(index, true);
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
  // A tap pins the note so its link can be clicked. A click also arrives after a drag, so I compare
  // it with where the press began. Grabbing the globe cancels any flight in progress.
  const pressAt = { x: 0, y: 0 };
  mapElement.addEventListener("pointerdown", (event) => {
    flight = null;
    pressAt.x = event.clientX;
    pressAt.y = event.clientY;
  });
  mapElement.addEventListener("click", (event) => {
    if (Math.hypot(event.clientX - pressAt.x, event.clientY - pressAt.y) > CLICK_SLOP_PX) return;
    const box = mapElement.getBoundingClientRect();
    const index = nearestRing(event.clientX - box.left, event.clientY - box.top);
    if (index === null) closeAnnotation();
    else openAnnotation(index, true);
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
