// The page around the model: title block, the map controls line, legend with its counters, the
// capacity key, km scale and north arrow, labels on the model, map buttons, the note a click on
// a plant or a line opens, and About this scene. The model itself is drawn by scene.js, which
// knows nothing about any of this. The page is about the grid: the relief is only the ground.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/space-grotesk/latin-700.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import config from "./layers/scene.json";
import meta from "./layers/meta.json";
import { NBSP, fmt, fmtDate } from "./format.js";
import { createScene } from "./scene.js";

const TOOLTIP_DELAY_MS = 400;
const TOOLTIP_GAP_PX = 6;
const START_DELAY_MS = 400;
const FLY_MS = 1000;
const [DRAW_FROM, DRAW_TO] = config.page.draw_frames;
const KEY_CAPACITIES_MW = [100, 500, 1000];
const NOTE_OFFSET_PX = 24; // the note floats this far up and to the right of the feature

const byId = (id) => document.getElementById(id);
const phone = () => window.matchMedia("(max-width: 900px)").matches;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const kmOf = (p) => [p.xy[0] / 1000, p.xy[1] / 1000];

// ---------------------------------------------------------------- the model
let drawingDone = false;
let reading = null; // the open note: { kind, xKm, yKm, heightM, radius }
let defaultCamera = null;

const scene = createScene(byId("scene"), {
  config,
  mode: "page",
  initialView: () => (defaultCamera = scene.defaultView(freeRect())),
  onInteract: () => hideTooltip(),
  onClick: (x, y) => readAt(x, y),
  onDraw: () => layout(),
  onEnd: () => {
    drawingDone = true;
    layout();
  },
});

// ---------------------------------------------------------------- the free area for the model
// The model is fitted into the window minus the furniture, so nothing ever covers it. I try the
// band above the bottom-left block and the band right of it, and keep the one where the model
// comes out larger.
function freeRect() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const margin = phone() ? 12 : 28;
  const title = byId("title-block").getBoundingClientRect();
  const legend = byId("legend").getBoundingClientRect();
  const buttons = byId("buttons").getBoundingClientRect();
  const top = title.bottom + margin;
  const above = { left: margin, right: w - margin, top, bottom: Math.min(legend.top, buttons.top) - margin };
  if (phone()) return above;
  const beside = { left: legend.right + margin, right: buttons.left - margin, top, bottom: h - margin };
  const fit = (r) => Math.min((r.right - r.left) / 0.85, r.bottom - r.top); // the model is about 0.85 as wide as tall
  return fit(beside) > fit(above) ? beside : above;
}

// ---------------------------------------------------------------- the capacity key
// Three discs at exactly the size the model draws a plant of that capacity in the default view:
// the same area rule as the scene (diameter grows with the square root of the capacity).
function drawCapacityKey() {
  const row = document.querySelector(".capacity-row");
  if (!defaultCamera) return;
  const sizes = KEY_CAPACITIES_MW.map((mw) => scene.plantDiameter(mw, defaultCamera));
  const box = Math.ceil(Math.max(...sizes) * 2 + 2); // room for the halo, twice the diameter
  row.innerHTML = KEY_CAPACITIES_MW.map((mw, i) => {
    const r = sizes[i] / 2;
    return (
      `<span class="capacity"><svg width="${box}" height="${box}" viewBox="0 0 ${box} ${box}" aria-hidden="true">` +
      `<circle cx="${box / 2}" cy="${box / 2}" r="${(r * 2).toFixed(2)}" fill="#FFB000" fill-opacity="0.15"/>` +
      `<circle cx="${box / 2}" cy="${box / 2}" r="${r.toFixed(2)}" fill="#FFB000"/></svg>` +
      `<span class="capacity-label">${fmt(mw, "MW")}</span></span>`
    );
  }).join("");
}

// ---------------------------------------------------------------- labels on the model
const labelLayer = byId("labels");
const leaders = byId("leaders");
function makeLabel(html) {
  const el = document.createElement("div");
  el.className = "model-label";
  el.innerHTML = html;
  el.hidden = true;
  labelLayer.append(el);
  return el;
}
const LABELS = [
  { el: makeLabel(`<span class="name">Kvilldal</span><span class="value">Largest plant</span>`), point: config.points.kvilldal, reserve: 0, plant: 0 },
  { el: makeLabel(`<span class="name">Oslo</span>`), point: config.points.oslo, reserve: 6 },
  { el: makeLabel(`<span class="name">Bergen</span>`), point: config.points.bergen, reserve: 6 },
];

const boxOf = (el) => el.getBoundingClientRect();
const overlap = (a, b, pad = 4) => a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;

/** Lay out the note, the labels, the scale cues and the counters for the frame just drawn. */
function layout() {
  updateCounters();
  updateScaleCues();
  // The note goes first, so the labels can keep clear of it.
  if (reading) placeNote();
  const w = window.innerWidth;
  const h = window.innerHeight;
  const blockers = [byId("title-block"), byId("legend"), byId("buttons")].map(boxOf);
  if (!byId("note").hidden) blockers.push(boxOf(byId("note")));
  const placed = [];
  const leaderLines = [];
  // Plants the labels must not cover: the largest ones, where they are drawn now.
  const plantBoxes = drawingDone
    ? scene.plants.slice(0, 40).map((p) => {
        const [x, y] = scene.project(p.xKm, p.yKm, scene.meshHeightAt(p.xKm, p.yKm));
        const r = scene.plantDiameter(p.capacity_mw) / 2;
        return { left: x - r, right: x + r, top: y - r, bottom: y + r };
      })
    : [];

  for (const label of LABELS) {
    const el = label.el;
    if (!drawingDone) {
      el.hidden = true;
      continue;
    }
    el.hidden = false;
    const [xKm, yKm] = kmOf(label.point);
    const [x, y, z] = scene.project(xKm, yKm, scene.meshHeightAt(xKm, yKm));
    let reserve = label.reserve;
    if (label.plant !== undefined) reserve = plantBoxes[label.plant].right - x + 2;
    const pointBox = { left: x - reserve, right: x + reserve, top: y - reserve, bottom: y + reserve };
    if (z > 1 || x < 0 || x > w || y < 0 || y > h) {
      el.hidden = true;
      continue;
    }
    const lw = el.offsetWidth;
    const lh = el.offsetHeight;
    const gap = reserve + 14;
    const spots = [
      [gap, -lh - gap], [-lw - gap, -lh - gap], [gap, gap], [-lw - gap, gap],
      [gap + 40, -lh - gap - 30], [-lw - gap - 40, -lh - gap - 30], [gap + 40, gap + 30], [-lw - gap - 40, gap + 30],
    ];
    let done = false;
    for (const [dx, dy] of spots) {
      el.style.transform = `translate(${Math.round(x + dx)}px, ${Math.round(y + dy)}px)`;
      const b = boxOf(el);
      const inside = b.left >= 4 && b.right <= w - 4 && b.top >= 4 && b.bottom <= h - 4;
      const clear = !blockers.some((o) => overlap(b, o)) && !placed.some((o) => overlap(b, o)) && !plantBoxes.some((o) => overlap(b, o, 1));
      if (inside && clear) {
        placed.push(b, pointBox);
        leaderLines.push([x, y, dx > 0 ? b.left : b.right, dy < 0 ? b.bottom : b.top, reserve]);
        done = true;
        break;
      }
    }
    if (!done) el.hidden = true;
  }
  leaders.innerHTML = leaderLines
    .map(([x1, y1, x2, y2, r]) => {
      // Start the leader at the rim of the mark, not its centre.
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const sx = x1 + ((x2 - x1) / len) * r;
      const sy = y1 + ((y2 - y1) / len) * r;
      return `<line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" />`;
    })
    .join("");
}

// ---------------------------------------------------------------- counters, km scale, north
function updateCounters() {
  const timeline = scene.timeline();
  if (!timeline) return;
  const [mw] = timeline.megawattsText(scene.frame).split(NBSP);
  const [km] = timeline.kilometresText(scene.frame).split(NBSP);
  byId("count-mw").querySelector(".readout").textContent = mw;
  byId("count-km").querySelector(".readout").textContent = km;
}

const NICE_KM = [10, 20, 25, 50, 100, 200, 250, 500];
function updateScaleCues() {
  const { northDeg, pxPerKm } = scene.groundScale();
  byId("north").querySelector("svg").style.transform = `rotate(${northDeg}deg)`;
  const km = NICE_KM.find((k) => k * pxPerKm >= 48) ?? NICE_KM.at(-1);
  const length = Math.max(8, Math.min(160, km * pxPerKm));
  const bar = byId("km-scale");
  bar.querySelector("svg").setAttribute("width", length + 2);
  bar.querySelector("path").setAttribute("d", `M1 2v6M${length + 1} 2v6M1 8h${length}`);
  bar.querySelector(".km-label").innerHTML = `${fmt(km)}<span class="unit">${NBSP}km</span>`;
}

// ---------------------------------------------------------------- reading the grid
// A click reads the grid only: a plant or a line. Anywhere else it closes an open note.
const note = byId("note");
const noteLive = byId("note-live");
const GPPD = "Global Power Plant Database v1.3.0, 2021";

function readAt(x, y) {
  const hit = scene.plantAt(x, y);
  if (hit) {
    const p = hit.plant;
    const body =
      hit.index === 0
        ? `<p>Norway’s largest hydro plant</p>`
        : `<p>Hydropower plant</p><p>Capacity in the WRI database: <span class="readout">${fmt(p.capacity_mw)}</span>${NBSP}MW</p>`;
    return openNote(
      { kind: "plant", index: hit.index, xKm: p.xKm, yKm: p.yKm, heightM: scene.meshHeightAt(p.xKm, p.yKm), radius: scene.plantDiameter(p.capacity_mw) / 2 },
      `<p class="note-name">${p.name}</p>${body}<p class="source">${GPPD}</p>`,
    );
  }
  const found = scene.lineAt(x, y);
  if (found) {
    return openNote(
      { kind: "line", ...found, heightM: scene.meshHeightAt(found.xKm, found.yKm) + 300, radius: 6 },
      `<p class="note-name keep-case">${fmt(found.line.kv, "kV")} power line</p><p class="source">© OpenStreetMap contributors</p>`,
    );
  }
  closeNote();
}

function openNote(r, html) {
  if (reading && reading.kind === r.kind && Math.hypot(reading.xKm - r.xKm, reading.yKm - r.yKm) < 0.5) {
    // A click on the same feature again closes its note.
    closeNote();
    return;
  }
  reading = r;
  note.innerHTML = html;
  noteLive.textContent = note.innerText;
  note.hidden = false;
  note.classList.remove("open");
  void note.offsetWidth;
  note.classList.add("open");
  scene.setHighlight(r.kind === "plant" ? { kind: "plant", index: r.index } : { kind: "line", line: r.line, segment: r.segment, t: r.t });
  layout();
}

function closeNote() {
  reading = null;
  note.hidden = true;
  scene.setHighlight(null);
  layout();
}

/**
 * The note floats beside the feature, 24 px up and to the right, with nothing joining them.
 * Near the right or top edge it flips to the left or below, so it never covers the point and
 * never leaves the window. On phones it docks above the bottom-left block.
 */
function placeNote() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const nw = note.offsetWidth;
  const nh = note.offsetHeight;
  if (phone()) {
    const block = byId("legend").getBoundingClientRect();
    note.style.transform = `translate(${Math.round(block.left)}px, ${Math.round(block.top - 12 - nh)}px)`;
    note.dataset.side = "docked";
    return;
  }
  const [x, y] = scene.project(reading.xKm, reading.yKm, reading.heightM);
  const gap = reading.radius + NOTE_OFFSET_PX;
  const right = x + gap + nw <= w - 8;
  const up = y - gap - nh >= 8;
  const left = right ? x + gap : x - gap - nw;
  const top = up ? y - gap - nh : y + gap;
  note.style.transform = `translate(${Math.round(Math.max(8, left))}px, ${Math.round(Math.min(h - nh - 8, top))}px)`;
  note.dataset.side = `${up ? "up" : "down"}-${right ? "right" : "left"}`;
}

// ---------------------------------------------------------------- buttons and keys
const tooltip = byId("tooltip");
const strip = byId("buttons");
let tooltipTimer = null;

function replay() {
  closeNote();
  drawingDone = false;
  // Clear the plants and lines and draw them again from wherever the reader is.
  scene.play({ from: DRAW_FROM, to: DRAW_TO });
  layout();
}
byId("replay").addEventListener("click", replay);
byId("home").addEventListener("click", () => {
  // Bearing, tilt and zoom ease back together over 1 s.
  defaultCamera = scene.defaultView(freeRect());
  scene.flyTo(defaultCamera, FLY_MS);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideTooltip();
    if (byId("about").open) return; // the dialog closes itself
    if (reading) closeNote();
    return;
  }
  if (event.code !== "Space" || event.repeat) return;
  if (event.target.closest?.("button, a, dialog")) return;
  event.preventDefault();
  replay();
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
    ? `Data fetched ${fmtDate(dates[0])}.`
    : meta.sources.map((s) => `${s.name}: fetched ${fmtDate(s.downloaded)}.`).join(" ");

// Tooltips: a small label to the left of the strip, level with the button, in the button's own
// aria-label words. Hover waits 400 ms; keyboard focus shows it at once; touch shows none.
function showTooltip(button) {
  clearTimeout(tooltipTimer);
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
  tooltip.hidden = true;
}
for (const button of [...strip.querySelectorAll("button"), byId("about-close")]) {
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
  byId("controls").innerHTML =
    '<span class="verb">Tap</span> a plant or a line to read it. <span class="verb">Drag</span> to tilt and turn, <span class="verb">two fingers</span> to move, <span class="verb">pinch</span> to zoom.';
}

window.addEventListener("resize", () => {
  requestAnimationFrame(() => {
    defaultCamera = scene.defaultView(freeRect());
    drawCapacityKey();
    layout();
  });
});

// For automated checks of the page: where a named point is on screen now, the camera, the
// model's screen box, and where a plant is drawn.
window.__scenePoint = (name) => {
  const [xKm, yKm] = kmOf(config.points[name]);
  return scene.project(xKm, yKm, scene.meshHeightAt(xKm, yKm));
};
window.__plantPoint = (index) => {
  const p = scene.plants[index];
  return scene.project(p.xKm, p.yKm, scene.meshHeightAt(p.xKm, p.yKm));
};
window.__linePoint = (i, share) => scene.lineMidpoint(i, share);
window.__lineCount = () => scene.lineCount();
window.__modelBox = () => scene.modelScreenBox();
window.__camera = () => scene.getCamera();
window.__setCamera = (cam) => scene.setCamera(cam);
window.__groundAt = (x, y) => scene.groundAt(x, y);
window.__project = (xKm, yKm, heightM) => scene.project(xKm, yKm, heightM);

// ---------------------------------------------------------------- start
scene.ready.then(() => {
  document.documentElement.dataset.ready = "true";
  drawCapacityKey();
  // Everything a click needs is loaded by now, so the controls line can promise a reading. It
  // stays from here on: it never fades.
  byId("controls").classList.remove("waiting");
  layout();
  if (reducedMotion) {
    scene.setFrame(DRAW_TO);
    drawingDone = true;
    layout();
    return;
  }
  // The pause is counted on animation frames from the moment the page is on screen, then the
  // data track runs once: plants first, then the lines (frames 135 to 345, 7 s).
  let waited = 0;
  let last = performance.now();
  const wait = (now) => {
    waited += Math.min(now - last, 100);
    last = now;
    if (waited < START_DELAY_MS) requestAnimationFrame(wait);
    else scene.play({ from: DRAW_FROM, to: DRAW_TO });
  };
  requestAnimationFrame(wait);
});
