// The page around the model: title block, colour scale, labels on the model, scale cues, map
// buttons, hint line, the depth reading and About this scene. The model itself is drawn by
// scene.js, which knows nothing about any of this.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/space-grotesk/latin-700.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import config from "./layers/scene.json";
import figures from "./layers/figures.json";
import meta from "./layers/meta.json";
import { coord, figureHtml, fmt, keepTogether, longDate } from "./format.js";
import { createScene } from "./scene.js";

const TOOLTIP_DELAY_MS = 400;
const TOOLTIP_GAP_PX = 6;
const START_DELAY_MS = 400;
const EXAGGERATION = config.exaggeration;
const EASE_OUT_MS = 1000; // from the last frame back to the start view
const RAMP_TICKS_M = [2000, 4000, 6000, 8000, 10000];
// Figures from data/key_figures.json and the published depth of Challenger Deep it cites.
const DEEPEST = { lon: 142.2081, lat: 11.3342, depthM: config.deepest_depth_m };
const EVEREST_M = config.peak.height_m;

const byId = (id) => document.getElementById(id);
const metres = (m) => fmt(Math.round(m), "m");
const coords = (lat, lon) => coord(lat, lon);
const phone = () => window.matchMedia("(max-width: 900px)").matches;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// "?frame=120" opens paused on that frame of the animation, to share one moment of it.
const params = new URLSearchParams(location.search);
const askedFrame = params.has("frame") ? Number(params.get("frame")) : null;

// ---------------------------------------------------------------- the colour scale
// The bar is the model's own ramp: the six stops spread evenly from 1,500 m (left, shallow) to
// 10,950 m (right, deep), blended in sRGB exactly as scene.js blends them.
const [deepM, shallowM] = config.look.depth_ramp_domain_m;
const rampStops = [...config.look.depth_ramp].reverse();
document.querySelector(".ramp").style.background = `linear-gradient(to right, ${rampStops
  .map((c, i) => `${c} ${((i / (rampStops.length - 1)) * 100).toFixed(2)}%`)
  .join(", ")})`;
function drawRampTicks() {
  const width = document.querySelector(".ramp").getBoundingClientRect().width;
  const ticks = document.querySelector(".ramp-ticks");
  const labels = document.querySelector(".ramp-labels");
  ticks.innerHTML = "";
  labels.innerHTML = "";
  for (const m of RAMP_TICKS_M) {
    const x = ((m - shallowM) / (deepM - shallowM)) * width;
    const tick = document.createElementNS("http://www.w3.org/2000/svg", "line");
    tick.setAttribute("x1", x);
    tick.setAttribute("x2", x);
    tick.setAttribute("y1", 0);
    tick.setAttribute("y2", 5);
    ticks.append(tick);
    const label = document.createElement("span");
    label.innerHTML = figureHtml(m, "m");
    label.style.left = `${x}px`;
    labels.append(label);
  }
}

// ---------------------------------------------------------------- the model
const playButton = byId("play");
const homeButton = byId("home");
const closeButton = byId("close");
const FADE_MS = 300;
let labelsShown = false;
let inAnimation = false; // from Play until the camera is home again
let reading = null; // the open note: { lon, lat, elevationM, kind }
let hasMoved = false;

const scene = createScene(byId("scene"), {
  config,
  urls: { relief: "layers/relief.png", section: "layers/section.json" },
  startFrame: Number.isFinite(askedFrame) ? askedFrame : 0,
  modelCues: true,
  // The page opens on the default view, interactive; the animation runs only after Play.
  initialCamera: askedFrame === null ? () => scene.startView(safeRect()) : null,
  onEnd: () => leaveAnimation(),
  onInteract: () => {
    fadeHint();
    explore();
  },
  onClick: (x, y) => readAt(x, y),
  onDraw: () => layout(),
});

// A shared frame (?frame=N) shows that frame of the animation exactly, without the page's cues.
if (askedFrame === null) scene.setCues(true);

/** Show the model's labels (the page's cues are drawn by scene.js whenever no frame plays). */
function explore() {
  labelsShown = true;
  layoutSoon();
}

/** Fade every piece of furniture out (in = false) or back in, over 300 ms. */
function setFurniture(visible) {
  document.body.classList.toggle("animating", !visible);
}

/**
 * Play enters the animation: the furniture fades out, only the X shows, the camera eases over
 * 1 s from wherever the reader left it into frame 0, and the frames run at full pace (30 a second) up to
 * the page's last frame (the last beat, the slow way back to the opening view, is skipped:
 * the page eases home itself).
 */
function enterAnimation() {
  if (inAnimation) return;
  inAnimation = true;
  fadeHint();
  closeNote();
  hideTooltip();
  labelsShown = false;
  scene.setLocked(true);
  setFurniture(false);
  closeButton.hidden = false;
  scene.resetLayers();
  scene.playFromStart({ once: true, glide: true, end: scene.pageEndFrame });
  closeButton.focus({ focusVisible: false });
}

/** The end, the X or Escape: the camera eases home, the cut and Everest go, furniture returns. */
function leaveAnimation() {
  if (!inAnimation) return;
  closeButton.hidden = true;
  hideTooltip();
  scene.stop(scene.startView(safeRect()), reducedMotion ? 0 : EASE_OUT_MS).then(() => {
    inAnimation = false;
    scene.setLocked(false);
    setFurniture(true);
    explore();
    playButton.focus({ focusVisible: false });
  });
}

// ---------------------------------------------------------------- the free area for the model
// The model is fitted into the window minus the furniture, so nothing ever covers it.
function safeRect() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const margin = phone() ? 12 : 24;
  const title = byId("title-block").getBoundingClientRect();
  const legend = byId("legend").getBoundingClientRect();
  const buttons = byId("buttons").getBoundingClientRect();
  const top = title.bottom + margin;
  const bottom = Math.min(legend.top, buttons.top) - margin;
  const left = margin;
  const right = phone() ? w - margin : buttons.left - margin;
  return { left, right, top, bottom: Math.max(bottom, top + 120) };
}

// ---------------------------------------------------------------- labels on the model
const labelLayer = byId("labels");
const leaders = byId("leaders");
let trenchAxis = [];

function makeLabel(id, html, { clickable = false, className = "" } = {}) {
  const el = document.createElement(clickable ? "button" : "div");
  el.className = `model-label ${className}`;
  el.id = id;
  el.innerHTML = html;
  if (clickable) el.type = "button";
  labelLayer.append(el);
  return el;
}

const labels = {
  deep: makeLabel(
    "label-deep",
    `<span class="name">Challenger Deep</span><span class="value">${keepTogether(figures.deepest_depth.display)}</span>`,
    { clickable: true, className: "point" },
  ),
  trench: makeLabel("label-trench", `<span class="name">Mariana Trench</span>`, { className: "area" }),
  pacific: makeLabel("label-pacific", `<span class="name">Pacific Plate</span>`, { className: "area" }),
  philippine: makeLabel("label-philippine", `<span class="name">Philippine Sea Plate</span>`, {
    className: "area",
  }),
};
const depthLabels = [];

/** The trench axis: the deepest grid point on each meridian, followed from west to east. */
function traceTrenchAxis() {
  const { west, east } = config.relief;
  const points = [];
  let lat = DEEPEST.lat;
  for (let lon = west + 0.15; lon <= east - 0.15; lon += 0.05) {
    let best = { lat, m: Infinity };
    for (let l = lat - 0.35; l <= lat + 0.35; l += 0.01) {
      const m = scene.elevationAt(lon, l);
      if (m < best.m) best = { lat: l, m };
    }
    lat = best.lat;
    points.push({ lon, lat: best.lat, m: best.m });
  }
  return points;
}

const boxOf = (el) => el.getBoundingClientRect();
const overlap = (a, b, pad = 4) =>
  a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;

function place(el, x, y, dx, dy) {
  el.style.transform = `translate(${Math.round(x + dx)}px, ${Math.round(y + dy)}px)`;
}

/** Lay out the labels, the scale bar and the north arrow for the frame just drawn. */
function layout() {
  updateScaleCues();
  updateNote();
  const all = [labels.deep, labels.trench, labels.pacific, labels.philippine, ...depthLabels];
  leaders.innerHTML = "";
  if (!labelsShown) {
    for (const el of all) el.hidden = true;
    return;
  }
  const w = window.innerWidth;
  const h = window.innerHeight;
  const blockers = [byId("title-block"), byId("legend"), byId("buttons")].map(boxOf);
  if (!byId("hint").classList.contains("gone")) blockers.push(boxOf(byId("hint")));
  if (!byId("note").hidden) blockers.push(boxOf(byId("note")));
  const placed = [];
  const leaderLines = [];

  // A point label sits up and to the right of its point, or up and to the left near the edge,
  // with a thin leader. It is shown only if the point is in sight and nothing is in the way.
  const tryPoint = (el, lon, lat, elevationM, { reserve = 12 } = {}) => {
    el.hidden = false;
    const [x, y, z] = scene.project(lon, lat, elevationM);
    if (z > 1 || x < 0 || x > w || y < 0 || y > h || !scene.isVisible(lon, lat, elevationM)) {
      el.hidden = true;
      return null;
    }
    const pointBox = { left: x - reserve, right: x + reserve, top: y - reserve, bottom: y + reserve };
    const lw = el.offsetWidth;
    const lh = el.offsetHeight;
    const spots = [[22, -lh - 22], [-lw - 22, -lh - 22], [22, 22], [-lw - 22, 22],
      [70, -lh - 60], [-lw - 70, -lh - 60], [70, 60], [-lw - 70, 60]];
    for (const [dx, dy] of spots) {
      place(el, x, y, dx, dy);
      const b = boxOf(el);
      const inside = b.left >= 4 && b.right <= w - 4 && b.top >= 4 && b.bottom <= h - 4;
      if (inside && !blockers.some((o) => overlap(b, o)) && !placed.some((o) => overlap(b, o))) {
        placed.push(b, pointBox);
        const lx = dx > 0 ? b.left : b.right;
        const ly = dy < 0 ? b.bottom : b.top;
        leaderLines.push([x, y, lx, ly]);
        return b;
      }
    }
    el.hidden = true;
    return null;
  };

  // An area label lies on the model at its point, turned along a direction if given. It needs
  // its spot in sight; `liftM` tests a point that far above the seabed (a label over a narrow
  // groove can be read even where the groove floor itself is hidden).
  const tryArea = (el, lon, lat, angleDeg = 0, liftM = 0) => {
    el.hidden = false;
    const elevationM = scene.elevationAt(lon, lat);
    const [x, y, z] = scene.project(lon, lat, elevationM + liftM);
    if (z > 1 || !scene.isVisible(lon, lat, elevationM + liftM)) {
      el.hidden = true;
      return false;
    }
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%) rotate(${angleDeg}deg)`;
    const b = boxOf(el);
    const inside = b.left >= 4 && b.right <= w - 4 && b.top >= 4 && b.bottom <= h - 4;
    if (!inside || blockers.some((o) => overlap(b, o)) || placed.some((o) => overlap(b, o))) {
      el.hidden = true;
      return false;
    }
    placed.push(b);
    return true;
  };

  // In order of importance: what the piece is about first.
  tryPoint(labels.deep, DEEPEST.lon, DEEPEST.lat, -DEEPEST.depthM, { reserve: 14 });
  // The trench name on its axis, turned along the axis on screen. I try a few places along it,
  // east of Challenger Deep first, and keep the first that is in sight and clear.
  for (const share of [0.68, 0.8, 0.3, 0.15]) {
    const k = Math.round((trenchAxis.length - 1) * share);
    const a = trenchAxis[Math.max(0, k - 4)];
    const b = trenchAxis[Math.min(trenchAxis.length - 1, k + 4)];
    const c = trenchAxis[k];
    if (!a || !b || !c) break;
    const pa = scene.project(a.lon, a.lat, a.m);
    const pb = scene.project(b.lon, b.lat, b.m);
    let angle = (Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) * 180) / Math.PI;
    if (angle > 90) angle -= 180;
    if (angle < -90) angle += 180;
    if (tryArea(labels.trench, c.lon, c.lat, angle, 2000)) break;
  }
  // The Pacific Plate dives under the Philippine Sea Plate here: the Pacific lies south-east of
  // the trench, the Philippine Sea Plate north-west of it.
  tryArea(labels.pacific, 143.15, 10.55);
  tryArea(labels.philippine, 141.15, 12.3);

  // Depth ticks on the walls, labelled at the two front corners (nearest the reader).
  const corners = scene
    .wallCorners()
    .map((corner) => {
      const floor = scene.project(corner.lon, corner.lat, -config.rock_floor_m);
      return { ...corner, screenY: floor[1], floor };
    })
    .sort((p, q) => q.screenY - p.screenY)
    .slice(0, 2);
  let n = 0;
  const [cx] = scene.project(DEEPEST.lon, DEEPEST.lat, -config.rock_floor_m / 2);
  for (const corner of corners) {
    for (const depthM of corner.ticks) {
      const el = depthLabels[n] ?? makeLabel(`label-depth-${n}`, "", { className: "depth" });
      depthLabels[n] = el;
      n += 1;
      el.innerHTML = figureHtml(depthM, "m");
      el.hidden = false;
      const [x, y] = scene.project(corner.lon, corner.lat, -depthM);
      const outward = x >= cx ? 1 : -1; // set outside the block, away from its middle
      place(el, x, y, outward > 0 ? 6 : -el.offsetWidth - 6, -el.offsetHeight / 2);
      const box = boxOf(el);
      const inside = box.left >= 4 && box.right <= w - 4 && box.top >= 4 && box.bottom <= h - 4;
      if (!inside || blockers.some((o) => overlap(box, o, 2)) || placed.some((o) => overlap(box, o, 2))) {
        el.hidden = true;
      } else {
        placed.push(box);
      }
    }
  }
  for (let i = n; i < depthLabels.length; i += 1) depthLabels[i].hidden = true;

  leaders.innerHTML = leaderLines
    .map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`)
    .join("");
}

// ---------------------------------------------------------------- km scale bar and north arrow
const NICE_KM = [5, 10, 20, 25, 50, 100, 200];
function updateScaleCues() {
  const { northDeg, pxPerKm } = scene.groundScale(DEEPEST.lon, DEEPEST.lat);
  byId("north").querySelector("svg").style.transform = `rotate(${northDeg}deg)`;
  const km = NICE_KM.find((k) => k * pxPerKm >= 48) ?? NICE_KM.at(-1);
  const length = Math.max(8, Math.min(140, km * pxPerKm));
  const bar = byId("km-scale");
  bar.querySelector("svg").setAttribute("width", length + 2);
  bar.querySelector("path").setAttribute("d", `M1 2v6M${length + 1} 2v6M1 8h${length}`);
  bar.querySelector(".km-label").innerHTML = figureHtml(km, "km");
}

// ---------------------------------------------------------------- reading the model
const note = byId("note");
const noteLive = byId("note-live");

function readAt(x, y) {
  if (inAnimation) return;
  fadeHint();
  scene.takeCamera("click");
  explore();
  const found = scene.pick(x, y);
  if (!found) return closeNote();
  openNote({ ...found, kind: "point" });
}

function openNote(r) {
  reading = r;
  if (r.kind === "deep") {
    note.innerHTML =
      `<p class="note-name">Challenger Deep</p>` +
      `<p>${keepTogether(`${figures.deepest_depth.display} below sea level. The published depth is 10,935 m ± 6 m.`)}</p>` +
      `<p class="readout">${keepTogether(figures.deepest_location.display)}</p>` +
      `<p class="source">Source: GMRT, CC BY 4.0; Greenaway et al. 2021</p>`;
  } else {
    note.innerHTML =
      `<p class="note-depth"><span class="readout big">${figureHtml(Math.round(-r.elevationM), "m", { attrs: 'class="unit-text"' })}</span> below sea level</p>` +
      `<p class="readout">${coords(r.lat, r.lon)}</p>` +
      `<p class="source">Source: GMRT, CC BY 4.0</p>`;
  }
  noteLive.textContent = note.innerText;
  note.hidden = false;
  note.classList.remove("open");
  void note.offsetWidth;
  note.classList.add("open");
  scene.setPing({ lon: r.lon, lat: r.lat, elevationM: r.elevationM });
}

function closeNote() {
  reading = null;
  note.hidden = true;
  scene.setPing(null);
}

/**
 * The note floats beside the ping that marks the reading: 24 px up and to the right of its outer
 * ring, flipped to the left near the right edge and below it near the top, never over the ping.
 * Nothing joins the two. It follows the ping as the reader turns or zooms.
 */
const NOTE_GAP_PX = 24;
function updateNote() {
  if (!reading || note.hidden) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const ping = scene.pingBox();
  if (!ping) {
    note.style.visibility = "hidden";
    return;
  }
  note.style.visibility = "";
  const nw = note.offsetWidth;
  const nh = note.offsetHeight;
  if (phone()) {
    // No room beside the point on a phone: the note sits in the free band above the bottom-left
    // block, centred, and the ping still marks the point on the model.
    const bottomRow = Math.min(byId("legend").getBoundingClientRect().top, byId("buttons").getBoundingClientRect().top);
    note.style.transform = `translate(${Math.round((w - nw) / 2)}px, ${Math.round(bottomRow - 12 - nh)}px)`;
    return;
  }
  let left = ping.right + NOTE_GAP_PX;
  if (left + nw > w - 8) left = ping.left - NOTE_GAP_PX - nw; // flip left
  let top = ping.top - NOTE_GAP_PX - nh;
  if (top < 8) top = ping.bottom + NOTE_GAP_PX; // flip down
  left = Math.max(8, Math.min(w - nw - 8, left));
  top = Math.max(8, Math.min(h - nh - 8, top));
  note.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

labels.deep.addEventListener("click", () => {
  if (inAnimation) return;
  fadeHint();
  scene.takeCamera("click");
  explore();
  openNote({ kind: "deep", lon: DEEPEST.lon, lat: DEEPEST.lat, elevationM: -DEEPEST.depthM });
});
// ---------------------------------------------------------------- buttons
const tooltip = byId("tooltip");
const strip = byId("buttons");
let tooltipFor = null;
let tooltipTimer = null;

playButton.addEventListener("click", () => enterAnimation());
closeButton.addEventListener("click", () => leaveAnimation());
homeButton.addEventListener("click", () => {
  fadeHint();
  closeNote();
  scene.resetLayers();
  scene.flyTo(scene.startView(safeRect()), 1000);
});

function layoutSoon() {
  requestAnimationFrame(() => layout());
}

// Space plays and pauses, unless a button or link has focus (Space already presses it).
// Keys: Space plays; Escape closes the animation, else the note (the dialog closes itself).
// While the animation runs, Escape is the only key that does anything.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideTooltip();
    if (byId("about").open) return;
    if (inAnimation) leaveAnimation();
    else if (reading) closeNote();
    return;
  }
  if (inAnimation) {
    if (event.target !== closeButton || event.code !== "Enter") event.preventDefault();
    return;
  }
  if (event.code !== "Space" || event.repeat) return;
  if (event.target.closest?.("button, a, dialog")) return;
  event.preventDefault();
  enterAnimation();
});

// The map controls line never fades; this only records that the reader
// has started exploring.
function fadeHint() {
  hasMoved = true;
}

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
    '<span class="verb">Tap</span> the model to read the depth. <span class="verb">Drag</span> to tilt and turn, <span class="verb">two fingers</span> to move, <span class="verb">pinch</span> to zoom.';
}

window.addEventListener("resize", () => {
  drawRampTicks();
  layoutSoon();
});

// ---------------------------------------------------------------- start
drawRampTicks();
scene.ready.then(() => {
  trenchAxis = traceTrenchAxis();
  document.documentElement.dataset.ready = "true";
  if (askedFrame !== null) return; // a shared moment: stay on it
  // The grid the readings need is decoded by now, so the controls line can promise a reading.
  byId("hint").classList.remove("gone");
  explore();
});
