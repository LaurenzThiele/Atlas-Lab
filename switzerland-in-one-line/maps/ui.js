// The page around the model: title block, colour scale, labels on the model, scale cues, map
// buttons, map controls line, the height reading and About this scene. The model itself is drawn by
// scene.js, which knows nothing about any of this.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/space-grotesk/latin-700.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import meta from "./layers/meta.json";
import points from "./layers/points.json";
import config from "./layers/scene.json";
import { NBSP, coords, fmt, fmtBefore, longDate } from "./format.js";
import { createScene } from "./scene.js";

const TOOLTIP_DELAY_MS = 400;
const TOOLTIP_GAP_PX = 6;
const EASE_MS = 1000; // the eased moves into frame 0 and back to the default view
const PAGE_END_FRAME = 389; // the page skips the end beat (frames 390 to 434), the video's alone
const RAMP_TICKS_M = [1000, 2000, 3000, 4000];
const START_EX = config.start_view.ex;

// The places the page labels, with the sentence a click on the label opens. The heights are the
// display figures of data/key_figures.json.
const PLACES = {
  basel: { name: "Basel", text: `${fmt(246, "m")}. The line enters Switzerland on the Rhine at Basel.` },
  jura: { name: "Jura", text: `${fmt(1189, "m")}. The highest point of the line in the Jura.` },
  lake_thun: { name: "Lake Thun", text: `${fmt(558, "m")}. The line crosses Lake Thun at Merligen.` },
  bernese_alps: {
    name: "Blüemlisalp",
    text: `${fmt(3633, "m")}. The highest point of the line in the Bernese Alps, just next to the Blüemlisalphorn.`,
  },
  rhone_valley: { name: "Rhône valley", text: `${fmt(634, "m")}. The lowest point of the line in the Alps, near Raron.` },
  dufourspitze: {
    name: "Dufourspitze",
    text: `${fmt(4634, "m")}. The highest point of Switzerland. The line runs over the summit.`,
  },
  monte_rosa: {
    name: "Monte Rosa",
    text: `${fmt(4399, "m")}. The line leaves Switzerland on the Italian border, next to the Parrotspitze.`,
  },
};
// The order labels are placed in: what the piece is about first.
const LABEL_ORDER = ["dufourspitze", "basel", "lake_thun", "bernese_alps", "rhone_valley", "jura", "monte_rosa"];
const SOURCES = { glo30: "Copernicus DEM GLO-30" };

const byId = (id) => document.getElementById(id);
const metres = (m) => fmt(Math.round(m), "m");
const phone = () => window.matchMedia("(max-width: 900px)").matches;

// "?frame=120" opens paused on that frame of the animation; "&clean" hides the furniture and maps
// the 9:16 frame 1:1 onto the window (to compare the page with the recorded video frames).
const params = new URLSearchParams(location.search);
const askedFrame = params.has("frame") ? Number(params.get("frame")) : null;
const clean = params.has("clean");
if (clean) document.documentElement.classList.add("clean");

// ---------------------------------------------------------------- the colour scale
// The bar is the model's own ramp: five stops on a square-root height scale from 200 m to
// 4,600 m, blended in sRGB exactly as scene.js blends them. A straight CSS gradient between the
// five stops would not follow the square root, so I give it 41 stops along the bar.
const look = config.look;
const [loM, hiM] = look.height_ramp_domain_m;
{
  const stops = look.height_ramp.map((c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)));
  const parts = [];
  // 40 even steps plus the exact place of each of the five stops.
  const at = new Set(Array.from({ length: 41 }, (_, k) => k / 40));
  if (look.height_ramp_scale === "sqrt") stops.forEach((_, i) => at.add((i / (stops.length - 1)) ** 2));
  for (const f of [...at].sort((a, b) => a - b)) {
    const t = (look.height_ramp_scale === "sqrt" ? Math.sqrt(f) : f) * (stops.length - 1);
    const i = Math.min(Math.floor(t), stops.length - 2);
    const w = t - i;
    const rgb = stops[i].map((v, c) => Math.round(v + (stops[i + 1][c] - v) * w));
    parts.push(`rgb(${rgb.join(" ")}) ${(f * 100).toFixed(1)}%`);
  }
  document.querySelector(".ramp").style.background = `linear-gradient(to right, ${parts.join(", ")})`;
}
function drawRampTicks() {
  const width = document.querySelector(".ramp").getBoundingClientRect().width;
  const ticks = document.querySelector(".ramp-ticks");
  const labels = document.querySelector(".ramp-labels");
  ticks.innerHTML = "";
  labels.innerHTML = "";
  for (const m of RAMP_TICKS_M) {
    const x = ((m - loM) / (hiM - loM)) * width;
    const tick = document.createElementNS("http://www.w3.org/2000/svg", "line");
    tick.setAttribute("x1", x);
    tick.setAttribute("x2", x);
    tick.setAttribute("y1", 0);
    tick.setAttribute("y2", 5);
    ticks.append(tick);
    const label = document.createElement("span");
    label.innerHTML = `${fmt(m, "")}<span class="unit">${NBSP}m</span>`;
    label.style.left = `${x}px`;
    labels.append(label);
  }
}

// ---------------------------------------------------------------- the model
const playButton = byId("play");
const homeButton = byId("home");
let labelsShown = askedFrame === null; // the default view shows its labels; a shared frame does not
let reading = null; // the open note
let playing = false; // from Play until the camera is back on the default view
let exiting = false;
const closeButton = byId("close-animation");

const scene = createScene(byId("scene"), {
  config,
  urls: {
    profile: "layers/profile.json",
    corridor: "layers/corridor.png",
    base: "layers/base.webp",
    border: "layers/border.json",
  },
  startFrame: Number.isFinite(askedFrame) ? askedFrame : 0,
  openOnStartView: askedFrame === null,
  playEndFrame: PAGE_END_FRAME,
  exactFrame: clean,
  safeRect: clean ? undefined : () => safeRect(),
  onEnd: () => exitAnimation(),
  onInteract: () => {
    labelsShown = true;
  },
  onClick: (x, y) => readAt(x, y),
  onDraw: () => layout(),
});
// A handle for checking the page from the browser console.
window.atlasScene = scene;

/** Back to the start view: the finished model with its labels. */
function settle(ms) {
  labelsShown = true;
  return scene.settle(ms, START_EX);
}

/**
 * The explainer's animation. Play fades every piece of furniture out over 300 ms and
 * leaves one X at the top right; the camera eases over 1 s from wherever the reader left it into
 * frame 0 and the timeline plays to frame 389 at the video's pace. At the end, or on the X or
 * Escape, the camera eases over 1 s back to the default view, the side view and its chart
 * colours go, and the furniture fades back in. While it plays nothing else reacts.
 */
function setAnimating(value) {
  playing = value;
  scene.setLocked(value);
  document.body.classList.toggle("animating", value);
  closeButton.hidden = !value;
  hideTooltip();
}

function startAnimation() {
  if (playing) return;
  closeNote();
  labelsShown = false;
  setAnimating(true);
  scene.playFromStart({ once: true, glide: true });
}

async function exitAnimation() {
  if (!playing || exiting) return;
  exiting = true;
  scene.stop();
  closeButton.hidden = true;
  await settle(EASE_MS);
  setAnimating(false);
  exiting = false;
}

// ---------------------------------------------------------------- the free area for the model
// The model is fitted into the window minus the furniture, so nothing ever covers it.
function safeRect() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const margin = phone() ? 10 : 24;
  const title = byId("title-block").getBoundingClientRect();
  const legend = byId("legend").getBoundingClientRect();
  const buttons = byId("buttons").getBoundingClientRect();
  let top = title.bottom + margin;
  let bottom = Math.min(legend.top, buttons.top) - margin;
  return { left: margin, right: w - margin, top, bottom: Math.max(bottom, top + 120) };
}

// ---------------------------------------------------------------- labels on the model
const labelLayer = byId("labels");
const leaders = byId("leaders");
const labels = {};
for (const p of points) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "model-label";
  el.id = `label-${p.id}`;
  el.textContent = PLACES[p.id].name;
  el.setAttribute("aria-label", `${PLACES[p.id].name}: ${PLACES[p.id].text}`);
  el.addEventListener("click", (event) => {
    event.stopPropagation();
    if (playing) return;
    scene.takeCamera("click");
    labelsShown = true;
    openNote({ kind: "place", id: p.id });
  });
  labelLayer.append(el);
  labels[p.id] = el;
}
const pointById = Object.fromEntries(points.map((p) => [p.id, p]));
const tickLabels = [];
function makeTickLabel(i) {
  const el = document.createElement("div");
  el.className = "model-label tick";
  el.setAttribute("aria-hidden", "true");
  labelLayer.append(el);
  tickLabels[i] = el;
  return el;
}

const boxOf = (el) => el.getBoundingClientRect();
const overlap = (a, b, pad = 4) =>
  a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;

/** Lay out the labels, the scale bar, the north arrow and the note for the frame just drawn. */
// The page's own layout runs on every drawn frame while the reader turns the model, so it never
// reads the DOM between writes: label sizes are measured once (their text never changes), the
// furniture boxes once per window size, and everything else is worked out from those numbers.
const sizes = new Map();
const sizeOf = (el) => {
  if (!sizes.has(el)) {
    const was = el.hidden;
    el.hidden = false;
    sizes.set(el, [el.offsetWidth, el.offsetHeight]);
    el.hidden = was;
  }
  return sizes.get(el);
};
let furnitureBoxes = null;
const furniture = () =>
  (furnitureBoxes ??= [byId("title-block"), byId("legend"), byId("buttons")].map(boxOf));
let noteBox = null; // where updateNote put the card
const show = (el, value) => {
  if (el.hidden === value) el.hidden = !value;
};

function layout() {
  if (clean) return;
  updateScaleCues();
  updateNote();
  const all = Object.values(labels);
  if (!labelsShown) {
    for (const el of [...all, ...tickLabels]) show(el, false);
    if (leaders.innerHTML) leaders.innerHTML = "";
    return;
  }
  const w = window.innerWidth;
  const h = window.innerHeight;
  const blockers = [...furniture()];
  if (reading && noteBox) blockers.push(noteBox);
  const layers = scene.viewLayers();
  // The cut face is the subject: no label may sit on it. Its top edge on screen, every km.
  const top = layers.corridor > 0.5 ? scene.cutTop(1) : [];
  const onCutFace = (b) =>
    top.some(([x, y]) => x >= b.left - 2 && x <= b.right + 2 && b.bottom > y - 3);
  const placed = [];
  const lines = [];
  for (const id of LABEL_ORDER) {
    const el = labels[id];
    const p = pointById[id];
    const heightM = layers.corridor > 0.5 || layers.ex > 0.5 ? p.dem_m : 0;
    const [x, y, z] = scene.projectAlong(p.km, heightM);
    if (z > 1 || z < -1 || x < 0 || x > w || y < 0 || y > h) {
      show(el, false);
      continue;
    }
    const [lw, lh] = sizeOf(el);
    // Above the point first, with a short leader; then higher, then to either side.
    const spots = [
      [-lw / 2, -lh - 22],
      [-lw / 2, -lh - 46],
      [-lw / 2, -lh - 74],
      [8, -lh - 34],
      [-lw - 8, -lh - 34],
      [8, -lh - 64],
      [-lw - 8, -lh - 64],
      // A point in a valley between higher peaks needs a longer leader to clear them.
      [-lw / 2, -lh - 120],
      [-lw / 2, -lh - 170],
      [-lw / 2, -lh - 230],
      [-lw / 2, -lh - 300],
    ];
    let done = false;
    for (const [dx, dy] of spots) {
      const b = { left: x + dx, top: y + dy, right: x + dx + lw, bottom: y + dy + lh };
      const inside = b.left >= 4 && b.right <= w - 4 && b.top >= 4 && b.bottom <= h - 4;
      if (!inside || onCutFace(b) || blockers.some((o) => overlap(b, o)) || placed.some((o) => overlap(b, o))) continue;
      el.style.transform = `translate(${Math.round(b.left)}px, ${Math.round(b.top)}px)`;
      show(el, true);
      placed.push(b, { left: x - 6, right: x + 6, top: y - 6, bottom: y + 6 });
      const lx = Math.min(Math.max(x, b.left + 2), b.right - 2);
      lines.push([x, y - 4, lx, b.bottom]);
      done = true;
      break;
    }
    if (!done) show(el, false);
  }
  // The height ticks on the end walls, labelled at the front corner of each wall that faces
  // the reader, outside the block.
  const ticks = scene.wallTicks();
  ticks.forEach((t, i) => {
    const tick = tickLabels[i] ?? makeTickLabel(i);
    if (tick.dataset.value !== String(t.value)) {
      tick.dataset.value = String(t.value);
      tick.innerHTML = `${fmt(t.value, "")}<span class="unit">${NBSP}m</span>`;
      sizes.delete(tick);
    }
    const [tw, th] = sizeOf(tick);
    const b = { left: t.dx > 0 ? t.x + 6 : t.x - 6 - tw, top: t.y - th / 2 };
    b.right = b.left + tw;
    b.bottom = b.top + th;
    const inside = b.left >= 4 && b.right <= w - 4 && b.top >= 4 && b.bottom <= h - 4;
    if (!inside || blockers.some((o) => overlap(b, o, 2)) || placed.some((o) => overlap(b, o, 2))) {
      show(tick, false);
      return;
    }
    tick.style.transform = `translate(${Math.round(b.left)}px, ${Math.round(b.top)}px)`;
    show(tick, true);
    placed.push(b);
  });
  for (let i = ticks.length; i < tickLabels.length; i += 1) show(tickLabels[i], false);
  const html = lines
    .map(([x1, y1, x2, y2]) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" />`)
    .join("");
  if (leaders.innerHTML !== html) leaders.innerHTML = html;
}

// ---------------------------------------------------------------- km bar, north
const NICE_KM = [5, 10, 20, 25, 50, 100];
function updateScaleCues() {
  const { northDeg, pxPerKm } = scene.groundScale();
  byId("north").querySelector("svg").style.transform = `rotate(${northDeg}deg)`;
  // Two equal segments, labelled 0, one step and two steps, the whole bar 70 to 160 px.
  const step = NICE_KM.find((k) => 2 * k * pxPerKm >= 70) ?? NICE_KM.at(-1);
  const seg = step * pxPerKm;
  const bar = byId("km-scale");
  const total = 2 * seg;
  const ok = Number.isFinite(total) && total > 8 && total < 400;
  bar.style.visibility = ok ? "visible" : "hidden";
  if (!ok) return;
  const svg = bar.querySelector("svg");
  svg.setAttribute("width", total + 2);
  svg.setAttribute("height", 8);
  bar.querySelector("path").setAttribute("d", `M1 1v6M${seg + 1} 3v4M${total + 1} 1v6M1 7h${total}`);
  const labelsBox = bar.querySelector(".km-labels");
  labelsBox.style.width = `${total + 2}px`;
  const html =
    `<span style="left:1px">0</span><span style="left:${(seg + 1).toFixed(1)}px">${step}</span>` +
    `<span style="left:${(total + 1).toFixed(1)}px">${fmt(2 * step, "")}<span class="unit">${NBSP}km</span></span>`;
  if (labelsBox.innerHTML !== html) labelsBox.innerHTML = html;
}

// ---------------------------------------------------------------- reading the model
const note = byId("note");
let noteSize = [0, 0];
const noteLive = byId("note-live");

function readAt(x, y) {
  scene.takeCamera("click");
  labelsShown = true;
  const found = scene.pick(x, y);
  if (!found) return closeNote();
  openNote({ kind: "point", ...found });
}

function openNote(r) {
  reading = r;
  if (r.kind === "place") {
    const place = PLACES[r.id];
    note.innerHTML = `<p class="note-name">${place.name}</p><p>${place.text}</p>`;
  } else {
    const along = r.alongKm !== null ? `<p class="along">${fmtBefore("km", r.alongKm, 1)} along the line</p>` : "";
    note.innerHTML =
      `<p class="spot-height"><svg viewBox="0 0 12 11" width="12" height="11" aria-hidden="true"><path d="M6 1l5 9H1z" /></svg>` +
      `<span>${metres(r.heightM)} above sea level</span></p>` +
      `<p class="readout">${coords(r.lat, r.lon)}</p>${along}` +
      `<p class="source">Source: ${SOURCES[r.source]}</p>`;
  }
  noteLive.textContent = note.innerText;
  note.hidden = false;
  noteSize = [note.offsetWidth, note.offsetHeight]; // measured once; the text does not change
  note.classList.remove("open");
  void note.offsetWidth;
  note.classList.add("open");
  ringsFrom = performance.now();
  updateNote();
  scene.redraw();
}

function closeNote() {
  reading = null;
  note.hidden = true;
  marker.innerHTML = "";
  scene.redraw();
}

/**
 * The marker of a reading: level rings, like a contour line drawn at the clicked height, round
 * the piece's own Amber dot. The rings lie in the horizontal plane through the point, so from an
 * oblique view they read as flat ellipses, and they keep their size on screen at any zoom (13, 27
 * and 42 px across the view). They widen once from the dot when the note opens. The box floats
 * beside them; nothing joins the two.
 */
const marker = byId("marker");
const RINGS = [
  { px: 13, width: 1.5, opacity: 0.95 },
  { px: 27, width: 1.2, opacity: 0.65 },
  { px: 42, width: 1, opacity: 0.35 },
];
const DOT_PX = 4.5;
const RIM_PX = 1.5;
const RING_MS = 600;
const BOX_GAP_PX = 24;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let ringsFrom = 0; // when the rings started to widen
let ringsRaf = 0;

/** The point the note is about, in scene units (drawn height). */
function readingPoint() {
  const ex = Math.max(scene.viewLayers().ex, 1e-3);
  if (reading.kind === "place") {
    const p = pointById[reading.id];
    const [x, z] = scene.alongXZ(p.km);
    return { x, y: (p.dem_m / 1000) * ex, z };
  }
  return { x: reading.x, y: (reading.heightM / 1000) * ex, z: reading.z };
}

/** One level ring of `radiusKm` round c, as an SVG path through 48 projected points. */
function ringPath(c, radiusKm) {
  const pts = [];
  for (let k = 0; k < 48; k += 1) {
    const a = (k / 48) * 2 * Math.PI;
    pts.push(scene.projectXZ(c.x + Math.cos(a) * radiusKm, c.y, c.z + Math.sin(a) * radiusKm));
  }
  return pts;
}

/** Draw the marker and float the box beside it; on a phone the box docks above the block. */
function updateNote() {
  if (!reading || note.hidden) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const c = readingPoint();
  const [x, y, z] = scene.projectXZ(c.x, c.y, c.z);
  const visible = z <= 1 && z >= -1;
  // Screen px per km across the view at the point, for rings of a set size on screen.
  const bearing = (scene.groundScale().bearing * Math.PI) / 180;
  const q = scene.projectXZ(c.x + Math.cos(bearing), c.y, c.z + Math.sin(bearing));
  const pxPerKm = Math.max(1e-6, Math.hypot(q[0] - x, q[1] - y));
  const t = reduceMotion ? 1 : Math.min(1, (performance.now() - ringsFrom) / RING_MS);
  const grow = 1 - (1 - t) ** 3; // ease out
  let html = "";
  if (visible) {
    for (const ring of RINGS) {
      const radiusPx = DOT_PX + (ring.px - DOT_PX) * grow;
      const pts = ringPath(c, radiusPx / pxPerKm);
      const d = `M${pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join("L")}Z`;
      html += `<path d="${d}" stroke-width="${ring.width}" stroke-opacity="${ring.opacity}" />`;
    }
    html += `<circle class="dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${DOT_PX}" stroke-width="${RIM_PX}" />`;
  }
  marker.innerHTML = html;
  if (t < 1 && !ringsRaf) {
    ringsRaf = requestAnimationFrame(() => {
      ringsRaf = 0;
      updateNote();
    });
  }

  const [nw, nh] = noteSize;
  if (phone()) {
    const [, legendBox, buttonsBox] = furniture();
    const bottomRow = Math.min(legendBox.top, buttonsBox.top);
    const top = bottomRow - 12 - nh;
    note.style.transform = `translate(${Math.round((w - nw) / 2)}px, ${Math.round(top)}px)`;
    noteBox = { left: (w - nw) / 2, top, right: (w + nw) / 2, bottom: top + nh };
    return;
  }
  // The outer ring at full size, on screen: the box floats 24 px up and to the right of it,
  // and flips to the left or below when it would leave the window.
  const outer = ringPath(c, RINGS.at(-1).px / pxPerKm);
  const ring = {
    left: Math.min(...outer.map((p) => p[0])),
    right: Math.max(...outer.map((p) => p[0])),
    top: Math.min(...outer.map((p) => p[1])),
    bottom: Math.max(...outer.map((p) => p[1])),
  };
  let left = ring.right + BOX_GAP_PX;
  let top = ring.top - BOX_GAP_PX - nh;
  if (left + nw > w - 8) left = ring.left - BOX_GAP_PX - nw;
  if (top < 8) top = ring.bottom + BOX_GAP_PX;
  left = Math.max(8, Math.min(w - nw - 8, left));
  top = Math.max(8, Math.min(h - nh - 8, top));
  noteBox = { left, top, right: left + nw, bottom: top + nh };
  note.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

// ---------------------------------------------------------------- buttons
const tooltip = byId("tooltip");
const strip = byId("buttons");
let tooltipFor = null;
let tooltipTimer = null;

playButton.addEventListener("click", () => startAnimation());
closeButton.addEventListener("click", () => exitAnimation());
homeButton.addEventListener("click", () => {
  if (playing) return;
  closeNote();
  settle(EASE_MS);
});

// Space plays (unless a button or link has focus: Space presses it). Escape closes the
// animation, else the note, else the dialog (the browser closes that). While the animation
// plays, every other key does nothing.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideTooltip();
    if (playing) exitAnimation();
    else if (!byId("about").open && reading) closeNote();
    return;
  }
  if (playing) {
    if (event.key !== "Tab" && event.key !== "Enter") event.preventDefault();
    return;
  }
  if (event.code !== "Space" || event.repeat) return;
  if (event.target.closest?.("button, a, dialog")) return;
  event.preventDefault();
  startAnimation();
});

// About this scene: a native modal dialog. Focus goes to the dialog itself, and back to the
// info button when it closes (Escape, the close button or a click on the backdrop).
const about = byId("about");
const infoButton = byId("info");
infoButton.addEventListener("click", () => {
  hideTooltip();
  about.showModal();
  about.focus();
});
byId("about-close").addEventListener("click", () => about.close());
about.addEventListener("click", (event) => {
  if (event.target === about) about.close();
});
about.addEventListener("close", () => {
  hideTooltip();
  infoButton.focus({ focusVisible: false });
});

const dates = [...new Set(meta.sources.map((s) => s.downloaded))];
byId("fetched").textContent =
  dates.length === 1
    ? `Data fetched ${longDate(dates[0])}.`
    : meta.sources.map((s) => `${s.name}: fetched ${longDate(s.downloaded)}.`).join(" ");

// Tooltips: a small label to the left of the strip, level with the button, in the button's own
// aria-label words. Hover waits 400 ms; keyboard focus shows it at once; touch shows none.
function showTooltip(button) {
  clearTimeout(tooltipTimer);
  tooltipFor = button;
  const host = button.closest("dialog") ?? document.body;
  if (tooltip.parentElement !== host) host.append(tooltip);
  tooltip.textContent = button.getAttribute("aria-label");
  tooltip.hidden = false;
  const anchor = (strip.contains(button) ? strip : button).getBoundingClientRect();
  const box = button.getBoundingClientRect();
  tooltip.style.right = `${window.innerWidth - anchor.left + TOOLTIP_GAP_PX}px`;
  tooltip.style.top = `${box.top + (box.height - tooltip.offsetHeight) / 2}px`;
}
function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltipFor = null;
  tooltip.hidden = true;
}
for (const button of [...strip.querySelectorAll("button"), byId("about-close"), closeButton]) {
  button.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "mouse") return;
    clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(() => showTooltip(button), TOOLTIP_DELAY_MS);
  });
  button.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "mouse" || button.matches(":focus-visible")) return;
    hideTooltip();
  });
  button.addEventListener("focus", () => {
    if (button.matches(":focus-visible")) showTooltip(button);
  });
  button.addEventListener("blur", hideTooltip);
}

// Touch screens get the touch words.
if (window.matchMedia("(pointer: coarse)").matches) {
  byId("hint").innerHTML =
    '<span class="verb">Tap</span> the model to read the height. <span class="verb">Drag</span> to tilt and turn, <span class="verb">two fingers</span> to move, <span class="verb">pinch</span> to zoom.';
}

/** The window or the fonts changed: measure the furniture and the labels again. */
function remeasure() {
  furnitureBoxes = null;
  sizes.clear();
  if (reading && !note.hidden) noteSize = [note.offsetWidth, note.offsetHeight];
}

window.addEventListener("resize", () => {
  drawRampTicks();
  remeasure();
  scene.redraw();
});

// ---------------------------------------------------------------- start
drawRampTicks();
scene.ready.then(() => {
  document.documentElement.dataset.ready = "true";
  if (askedFrame !== null) return; // one moment of the animation: stay on it, paused
  remeasure();
  scene.redraw();
  // The page opens on the default view, interactive, nothing playing (with or without reduced
  // motion). The corridor heights a reading needs are loaded before the scene is ready, so the
  // map controls line shows now and the first click reads at once.
  byId("hint").classList.remove("gone");
});
