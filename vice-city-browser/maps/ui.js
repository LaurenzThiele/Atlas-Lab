/**
 * The furniture of the public map: title, key, figures, sources, buttons, hint and the
 * height ticket.
 *
 * What it does: builds the interface in index.html on top of the public API in main.js. The map
 * itself knows nothing about any of this, so a script can draw clean views without it.
 * Reads:  layers/figures.json and layers/meta.json (through createMap)
 * Writes: nothing
 * Run:    npm run dev   (index.html loads this file)
 *
 * Not here, on purpose: a timeline and a replay. The data is one snapshot of one release, and the
 * map has no sequence to play.
 *
 * What you learn: how to pin a note to a point in the air. A click finds the building under the
 * mouse in 3D (MapLibre tests the extruded block, not only its footprint), and the ticket follows
 * the top of the tower on every frame, because main.js keeps the camera's matrix and can say
 * where a point 265 m above the street is on screen.
 */

import {
  HEIGHT_RAMP,
  START_VIEW,
  createMap,
  projectPoint,
  ready,
  setHighlight,
  setLayers,
} from "./main.js";
// After main.js, so that my rules come after MapLibre's own stylesheet.
import "./fonts/fonts.css";
import "./style.css";

const TILT_PITCH = 60;
const CAMERA_DURATION_MS = 900;
const LOCATOR_DURATION_MS = 1200;
const TAP_TOLERANCE_PX = 6;
const SHEET_CLOSED_SHARE = 0.3; // the bottom sheet's height when closed, as in style.css
const TIP_DELAY_MS = 400;
const TIP_GAP_PX = 6;
const TICKET_GAP_PX = 14; // between the tower and its ticket
const TICKET_MARGIN_PX = 8; // between the ticket and the edge of the map
// A click on a far speck flies in this close: the full tiles start at z13, and at 15.5 a house is
// a few pixels wide even at the top of a tilted view.
const FLY_IN_ZOOM = 15.5;
// The locator: Panorama Tower from the south-east, close and tilted so its 265 m read. On a
// phone a little further out, and the tower set left of centre, so the ticket fits beside it.
// A padding stays on MapLibre's camera once set, so every view that does not want one says so.
const NO_PADDING = { left: 0, right: 0, top: 0, bottom: 0 };
const LOCATOR_VIEW = { zoom: 15.6, pitch: 62, bearing: -30, padding: NO_PADDING };
const LOCATOR_VIEW_PHONE = { zoom: 15.1, pitch: 62, bearing: -30, padding: { left: 0, right: 200, top: 60, bottom: 0 } };

const NBSP = " ";
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const isPhone = window.matchMedia("(max-width: 900px)");
const $ = (selector) => document.querySelector(selector);

// What the reader has switched on.
const state = { labels: true, buildings: true, water: true, land: true };

let map = null;
let meta = null;
let rules = null; // the height rule's two numbers (3.5 m a floor, 4 m default), from figures.json

/** A number and its unit, held together by a no-break space, so a line never breaks between. */
function fmt(value, unit) {
  return `${value}${NBSP}${unit}`;
}

function applyLayers() {
  const show = ["labels", "buildings", "water", "land"].filter((name) => state[name]);
  setLayers({ show });
}

/** Camera moves ease out and never bounce, and jump for readers who asked for less motion. */
function cameraOptions(duration = CAMERA_DURATION_MS) {
  return { duration: reducedMotion.matches ? 0 : duration, easing: (t) => 1 - (1 - t) ** 3 };
}

// ---- Figures -------------------------------------------------------------------------------

/** Every number on the page comes from figures.json; the rules (3.5 m, 4 m) from its method lines. */
function readFigures(list) {
  const byId = Object.fromEntries(list.map((f) => [f.id, f]));
  const need = (id) => {
    if (!byId[id]) throw new Error(`figures.json has no ${id}`);
    return byId[id];
  };
  const fromMethod = (id, pattern) => {
    const match = need(id).method.match(pattern);
    if (!match) throw new Error(`figures.json: ${id} method has no ${pattern}`);
    return match[1];
  };
  const tallest = need("tallest").display.match(/^([\d,.]+) m \((.+)\)$/);
  if (!tallest) throw new Error("figures.json: tallest display is not '<n> m (<name>)'");
  return {
    buildings: need("buildings").display,
    realHeight: need("real_height").display,
    fromFloors: need("height_from_floors").display,
    defaults: need("height_default").display,
    towers: need("towers_100m").display,
    tallestM: tallest[1],
    tallestName: tallest[2],
    floorM: fromMethod("height_from_floors", /floors x ([\d.]+) m/),
    defaultM: fromMethod("height_default", /given ([\d.]+) m/),
    towerM: fromMethod("towers_100m", /Buildings ([\d.]+) m or taller/),
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

function figureLine(parts, locator) {
  const line = document.createElement("p");
  line.className = "fig";
  const text = document.createElement("span");
  appendParts(text, parts);
  line.append(text);
  if (locator) line.append(locator);
  return line;
}

function locatorButton(onClick) {
  // Only the crosshair is a button, never the whole line.
  const button = document.createElement("button");
  button.type = "button";
  button.className = "locator";
  button.setAttribute("aria-label", "Show on map");
  button.innerHTML =
    '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">' +
    '<circle cx="7" cy="7" r="4.5"/><path d="M7 0.5v3M7 10.5v3M0.5 7h3M10.5 7h3"/></svg>';
  button.addEventListener("click", onClick);
  return button;
}

function renderFigures(f) {
  for (const element of document.querySelectorAll('[data-figure="real_height"]')) element.textContent = f.realHeight;
  // Plain lines first, the line with a place last.
  $("#numbers").append(
    figureLine([{ num: f.realHeight }, " with a real height"]),
    figureLine([{ num: f.fromFloors }, " get their height from floors"]),
    figureLine([{ num: f.defaults }, ` have neither, so they get ${fmt(f.defaultM, "m")}`]),
    figureLine([{ num: f.towers }, ` buildings ${fmt(f.towerM, "m")} or taller in the open data`]),
    // The unit sits in the text face after the number, with a normal space, so "265 m" never shows a wide gap.
    figureLine([`Tallest: ${f.tallestName}, `, { num: f.tallestM }, `${NBSP}m`], locatorButton(flyToTallest)),
  );
  $("#info-tip").textContent =
    `Heights come from the data's height field. ${f.fromFloors} buildings only list floors, so I use ` +
    `floors x ${fmt(f.floorM, "m")}; ${f.defaults} list neither and get ${fmt(f.defaultM, "m")}.`;
  $("#count-buildings").textContent = `${f.buildings} buildings`;
  // The About text is written out in index.html; it must say what the data says.
  const about = $("#about").textContent.replace(/\s+/g, " ");
  for (const needle of [`floors x ${f.floorM} m`, `neither, ${f.defaultM} m`]) {
    if (!about.includes(needle)) throw new Error(`About this map no longer matches the data: ${needle}`);
  }
}

function renderKey(m) {
  $("#count-labels").textContent = "5 places";
  $("#count-water").textContent = fmt(m.areas.water_km2.toLocaleString("en-US"), "km²");
  $("#count-land").textContent = fmt(m.areas.land_km2.toLocaleString("en-US"), "km²");
  // The ramp steps are the ramp's own stops, so the key cannot drift from the map.
  const steps = document.querySelectorAll(".ramp-steps");
  for (const row of steps) {
    row.querySelectorAll("i").forEach((cell, index) => {
      cell.style.background = HEIGHT_RAMP[index][1];
    });
  }
  const values = $("#ramp-values");
  HEIGHT_RAMP.forEach(([metres], index) => {
    const value = document.createElement("span");
    value.textContent = index === HEIGHT_RAMP.length - 1 ? fmt(metres, "m") : String(metres);
    values.append(value);
  });
}

function renderFetched(m) {
  // Calendar days with no time: formatted in UTC, so a time zone behind UTC does not shift them.
  const format = (iso) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  const days = new Set(m.sources.map((source) => source.downloaded));
  $("#fetched").textContent =
    days.size === 1
      ? `Data fetched ${format([...days][0]).replace(/ /g, NBSP)}.`
      : m.sources.map((source) => `${source.name} fetched ${format(source.downloaded)}.`).join("\n");
}

// ---- The height ticket ---------------------------------------------------------------------

// The open ticket: the building's fid, its properties and its footprint ring.
let note = null;

/**
 * Heights under 10 m keep their one decimal (a house of 4.3 m) unless it is a whole number (the
 * 4 m default reads "4 m", as the sentence under it says); taller ones are whole metres.
 */
function heightText(h) {
  if (h < 0.05) return { num: "under 0.1", unit: "m" };
  if (h < 10 && !Number.isInteger(h)) return { num: h.toFixed(1), unit: "m" };
  return { num: Math.round(h).toLocaleString("en-US"), unit: "m" };
}

function ticketSentence(p) {
  const floors = Number.isFinite(p.floors) ? p.floors : null;
  const parts = [];
  if (p.src === "height") parts.push("A real height from the data.");
  else if (p.src === "floors") parts.push(`From ${floors} floors x ${fmt(rules.floorM, "m")}.`);
  else parts.push(`No height in the data, shown at ${fmt(rules.defaultM, "m")}.`);
  if (floors !== null && p.src !== "floors") parts.push(`${floors} ${floors === 1 ? "floor" : "floors"}.`);
  if (p.by) parts.push(`Footprint mapped in ${p.by}.`);
  return parts.join(" ");
}

function fillTicket(p) {
  const ticket = $("#ticket");
  ticket.querySelector(".name").textContent = p.name || "Unnamed building";
  const height = ticket.querySelector(".height");
  const { num, unit } = heightText(p.h);
  height.innerHTML = "";
  const number = document.createElement("span");
  number.className = "num";
  number.textContent = num;
  height.append(number, `${NBSP}${unit}`);
  ticket.querySelector(".sentence").textContent = ticketSentence(p);
  // The same words for a screen reader, once.
  $("#note-live").textContent =
    `${p.name || "Unnamed building"}, ${num} ${unit === "m" ? "metres" : unit}. ${ticketSentence(p)} ` +
    "Source: Overture Maps buildings 2026-10-21.0";
}

function overlaps(a, b, padPx) {
  return a.left < b.right + padPx && a.right > b.left - padPx && a.top < b.bottom + padPx && a.bottom > b.top - padPx;
}

/**
 * The tower on screen: its footprint projected at the ground and at the roof, as one box in page
 * pixels, and the roof's highest point. The ticket must never cover this box.
 */
function towerBox(ring, heightM) {
  const area = map.getContainer().getBoundingClientRect();
  const points = [];
  for (const corner of ring) {
    for (const z of [0, heightM]) {
      const p = projectPoint(corner, z);
      if (p) points.push(p);
    }
  }
  if (points.length === 0) return null;
  const xs = points.map((p) => p.x + area.left);
  const ys = points.map((p) => p.y + area.top);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

function ticketObstacles() {
  return ["#hint", "#buttons", "#title h1", "#title p", "#sheet-open"]
    .map((selector) => $(selector))
    .filter((element) => element && !element.hidden)
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
}

/**
 * The ticket hangs beside the tower at roof height: to its right, its stub level with the roof.
 * Near the right edge it flips to the left; if neither side fits (a phone, a wide tower) it sits
 * above or below the tower, and last at the foot of the map, just above the bottom sheet. Clamped
 * up and down inside the map, it never covers the tower, the title, the hint or the buttons.
 */
function placeTicket() {
  const ticket = $("#ticket");
  if (!note) {
    ticket.hidden = true;
    return;
  }
  const tower = towerBox(note.ring, note.props.h);
  if (!tower) return;
  ticket.hidden = false;
  const area = map.getContainer().getBoundingClientRect();
  const { width, height } = ticket.getBoundingClientRect();
  const m = TICKET_MARGIN_PX;
  const gap = TICKET_GAP_PX;
  const clampTop = (top) => Math.min(Math.max(top, area.top + m), area.bottom - m - height);
  const roofTop = clampTop(tower.top - 12);
  const candidates = [
    [tower.right + gap, roofTop],
    [tower.left - gap - width, roofTop],
    [Math.min(Math.max(tower.left, area.left + m), area.right - m - width), tower.top - gap - height],
    [Math.min(Math.max(tower.left, area.left + m), area.right - m - width), tower.bottom + gap],
  ];
  // When there is no room beside the tower or above and below it (a phone), the ticket goes
  // across the map: just above the hint line, then just under the title, wherever it stays
  // clear of the tower. Set from the map's left edge, away from the map buttons on the right.
  const across = area.left + m;
  const hint = $("#hint").getBoundingClientRect();
  const title = $("#title").getBoundingClientRect();
  candidates.push([across, hint.top - gap - height], [across, title.bottom + gap]);
  const obstacles = ticketObstacles();
  const fits = ([left, top]) => {
    const rect = { left, top, right: left + width, bottom: top + height };
    const inside =
      left >= area.left + m && top >= area.top + m && rect.right <= area.right - m && rect.bottom <= area.bottom - m;
    return inside && !overlaps(rect, tower, 2) && !obstacles.some((o) => overlaps(rect, o, 6));
  };
  // Last resort, a tower filling the screen: above the hint line, over part of the tower but
  // never over the text of the page.
  const spot = candidates.find(fits) ?? [across, Math.max(area.top + m, hint.top - gap - height)];
  ticket.style.left = `${spot[0]}px`;
  ticket.style.top = `${spot[1]}px`;
}

/** The ticket slides up 8 px and fades in, 150 ms (style.css); not under reduced motion. */
function playOpening() {
  const ticket = $("#ticket");
  ticket.classList.remove("opening");
  if (reducedMotion.matches) return;
  void ticket.getBoundingClientRect(); // restart the animation on a new building
  ticket.classList.add("opening");
}

function openNote(next) {
  note = next;
  setHighlight(note.fid);
  fillTicket(note.props);
  ticket().hidden = false;
  placeTicket();
  playOpening();
}

const ticket = () => $("#ticket");

function closeNote() {
  if (!note) return;
  note = null;
  setHighlight(null);
  ticket().hidden = true;
  $("#note-live").textContent = "";
}

/** The outer ring of a clicked feature, as [lng, lat] pairs. */
function outerRing(geometry) {
  if (geometry.type === "Polygon") return geometry.coordinates[0];
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flatMap((polygon) => polygon[0]);
  throw new Error(`Unexpected geometry ${geometry.type}`);
}

function setupNotes() {
  // A click opens the ticket; a click on the same building, on no building, or Escape closes it.
  // Hover does nothing on this map: no note, no highlight, no cursor change.
  map.on("click", (event) => {
    if (!state.buildings) return closeNote();
    // queryRenderedFeatures tests the extruded blocks in 3D, so a click on the side of a tower
    // finds the tower, not the house on the street behind it.
    const [hit] = map.queryRenderedFeatures(event.point, { layers: ["buildings"] });
    if (!hit || (note && hit.id === note.fid)) return closeNote();
    if (hit.properties.lo) return flyInAndOpen(event.lngLat);
    openNote({ fid: hit.id, props: hit.properties, ring: outerRing(hit.geometry) });
  });
  // The ticket follows the roof on every drawn frame (the matrix is the one just drawn).
  map.on("render", placeTicket);
}

/**
 * Far from the camera the map draws from coarse tiles, where a house is a one-pixel speck with
 * no name and no footprint. A click there first flies in to where the full tiles take over, then
 * opens the ticket of the building that is really at that spot, if there is one.
 */
function flyInAndOpen(lngLat) {
  closeNote();
  map.easeTo({ center: lngLat, zoom: Math.max(map.getZoom(), FLY_IN_ZOOM), ...cameraOptions() });
  map.once("idle", () => {
    const point = map.project(lngLat);
    const [hit] = map.queryRenderedFeatures([point.x, point.y], { layers: ["buildings"] });
    if (hit && !hit.properties.lo) openNote({ fid: hit.id, props: hit.properties, ring: outerRing(hit.geometry) });
  });
}

function flyToTallest() {
  const tallest = meta.tallest;
  closeNote();
  const view = isPhone.matches ? LOCATOR_VIEW_PHONE : LOCATOR_VIEW;
  map.flyTo({ center: [tallest.lon, tallest.lat], ...view, ...cameraOptions(LOCATOR_DURATION_MS) });
  map.once("moveend", () => {
    // The footprint comes from the tiles now on screen; the values from meta.json, which holds
    // the same properties prepare.py wrote into the tiles.
    const [feature] = map.querySourceFeatures("buildings", {
      sourceLayer: "buildings",
      filter: ["==", ["get", "fid"], tallest.fid],
    });
    const ring = feature
      ? outerRing(feature.geometry)
      : [[tallest.lon, tallest.lat]]; // the centroid alone, if the tile is not parsed yet
    if (!state.buildings) {
      state.buildings = true;
      showKeyState();
      applyLayers();
    }
    openNote({ fid: tallest.fid, props: tallest, ring });
  });
}

// ---- Sheet ---------------------------------------------------------------------------------

function showKeyState() {
  for (const entry of document.querySelectorAll(".k")) {
    entry.setAttribute("aria-pressed", String(state[entry.dataset.layer]));
  }
}

function setupKey() {
  // The key is also the layer switch: click an entry, and its sample and its layer go together.
  for (const entry of document.querySelectorAll(".k")) {
    entry.addEventListener("click", () => {
      const layer = entry.dataset.layer;
      state[layer] = !state[layer];
      if (layer === "buildings" && !state.buildings) closeNote();
      showKeyState();
      applyLayers();
    });
  }
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
}

function setupFold() {
  const fold = (folded) => {
    document.body.classList.toggle("sheet-folded", folded);
    $("#sheet-open").hidden = !folded;
    map.resize();
    placeTicket();
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
  // Esc takes back one thing at a time: first the ticket, then the sheet.
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
    if (note) closeNote();
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
  $("#start-view").addEventListener("click", () =>
    map.easeTo({ ...START_VIEW, padding: NO_PADDING, ...cameraOptions() }),
  );
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
  // A small label beside the map buttons and the dialogs' close buttons. Its text is the button's
  // aria-label, so what a screen reader says and what the eye reads never drift apart. No title
  // attribute: the browser's own tooltip comes late and never shows on focus.
  const pageTip = $("#tip");
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
  const strip = $("#buttons");
  for (const button of strip.querySelectorAll("button")) attach(button, pageTip, () => strip.getBoundingClientRect());
  // The locator in In numbers gets the same label, to its left.
  for (const button of document.querySelectorAll(".locator")) attach(button, pageTip);
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
  // Esc hides a tooltip first, before it closes the ticket or folds the sheet.
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

// ---- Start ---------------------------------------------------------------------------------

async function start() {
  const created = await createMap("map", { view: { ...START_VIEW } });
  map = created.map;
  meta = created.meta;
  const figures = readFigures(created.figures);
  rules = { floorM: figures.floorM, defaultM: figures.defaultM };
  renderFigures(figures);
  renderKey(meta);
  renderFetched(meta);
  setupKey();
  setupInfoTip($("#info"), $("#info-tip"));
  showKeyState();
  applyLayers();
  setupButtons();
  setupDialogs();
  setupTooltips();
  setupNotes();
  setupKeyboard(setupFold(), setupBottomSheet());
  // Handy in the browser console: the live MapLibre map.
  window.map = map;
  await ready;
  document.body.dataset.ready = "true";
}

start().catch((error) => {
  console.error(error);
  const message = document.createElement("p");
  message.id = "load-error";
  message.textContent = `The map could not load: ${error.message}`;
  document.body.append(message);
});
