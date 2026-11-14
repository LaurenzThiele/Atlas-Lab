/**
 * The animation's own indicators, drawn over the scene in one SVG layer: place labels with their
 * values as the cursor reaches them, and on the side view a height axis on the left edge of the
 * profile and a km axis along its foot. They are part of the animation, so the page and the
 * video both get them; createScene owns this layer, the page furniture does not.
 *
 * Everything comes from scene.json ("indicators"): the places (name, value, km, which side of
 * the point the label sits on), the axis ticks, and the safe box on the 1080 x 1920 frame that
 * text must stay inside. When each one shows is a value in the timeline ("ind_<place>", "axes"),
 * so the same frame number always shows the same indicators. Words are set in Inter, numbers in
 * JetBrains Mono; axes in Paper at 75 %, values in Amber; thin 1 px lines, no boxes.
 *
 * Series template: nothing here knows the country; the next episode passes its own scene.json.
 */

import "@fontsource/inter/latin-600.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import { fmt } from "./format.js";

const SVG = "http://www.w3.org/2000/svg";
const LABEL_PX = 24; // place labels, px on the 1080 px frame
const AXIS_PX = 20; // axis labels
const TICK_PX = 7;
const MIN_GAP_PX = 8; // a km label closer than this to its neighbour is dropped (never the ends)
const AXIS_OPACITY = 0.75;
const GRID_OPACITY = 0.15;

const el = (name, attrs = {}, parent = null) => {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.append(node);
  return node;
};
const metres = (m) => fmt(Math.round(m), "m");

export function createIndicators(container, config, { labels = true } = {}) {
  const look = config.look;
  const spec = config.indicators;
  const L = config.place.line.length_km;
  const svg = el("svg", { "aria-hidden": "true" });
  svg.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;overflow:visible";
  container.append(svg);
  const halo = { stroke: look.background, "stroke-linejoin": "round", "paint-order": "stroke" };

  // Place labels: a leader from the point and one line of text, name then value.
  const places = spec.places.map((p) => {
    const g = el("g", { display: "none" }, svg);
    const leader = el("line", { stroke: look.paper, "stroke-opacity": AXIS_OPACITY, "stroke-width": 1 }, g);
    const text = el("text", { ...halo }, g);
    const name = el("tspan", { "font-family": "Inter, sans-serif", "font-weight": 600, fill: look.paper }, text);
    name.textContent = `${p.name} `;
    const value = el("tspan", { "font-family": '"JetBrains Mono", monospace', "font-weight": 500, fill: look.line }, text);
    value.textContent = metres(p.value_m);
    return { ...p, g, leader, text };
  });

  // The axes, built once and moved on every frame they show.
  const axes = el("g", { display: "none" }, svg);
  const heights = [0, ...spec.axes.heights_m].map((h) => ({
    h,
    line: el("line", {
      stroke: look.paper,
      "stroke-width": 1,
      "stroke-opacity": h === 0 ? AXIS_OPACITY : GRID_OPACITY,
    }, axes),
    label: Object.assign(el("text", {
      ...halo,
      fill: look.paper,
      "fill-opacity": AXIS_OPACITY,
      "font-family": h === 0 ? "Inter, sans-serif" : '"JetBrains Mono", monospace',
      "font-weight": h === 0 ? 600 : 500,
    }, axes), { textContent: h === 0 ? "Sea level" : metres(h) }),
  }));
  const kms = [];
  for (let km = 0; km < L - 1e-6; km += spec.axes.km_step) kms.push(km);
  kms.push(L);
  const kmTicks = kms.map((km) => ({
    km,
    tick: el("line", { stroke: look.paper, "stroke-opacity": AXIS_OPACITY, "stroke-width": 1 }, axes),
    label: Object.assign(el("text", {
      ...halo,
      fill: look.paper,
      "fill-opacity": AXIS_OPACITY,
      "font-family": '"JetBrains Mono", monospace',
      "font-weight": 500,
      "text-anchor": "middle",
    }, axes), { textContent: fmt(Math.round(km), "km") }),
  }));

  const set = (node, attrs) => {
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, typeof v === "number" ? v.toFixed(1) : v);
  };

  /**
   * Draw the indicators for one frame.
   * layers: the timeline values; view: { width, height }; project(km, heightM) gives screen px;
   * frame(fx, fy) turns a point of the 1080 x 1920 frame into screen px, and scale is screen px
   * per frame px (text and offsets shrink with it, but not below 55 %). video: true when the
   * frame is the video's (the recorder), so text keeps inside its safe box.
   */
  function update(layers, { view, project, frame, scale, video }) {
    svg.setAttribute("width", view.width);
    svg.setAttribute("height", view.height);
    const f = Math.min(1, Math.max(0.55, scale));
    // The video keeps its text inside its safe box; the page only inside the window.
    let [sx0, sy0] = frame(spec.safe_box_px[0], spec.safe_box_px[1]);
    let [sx1] = frame(spec.safe_box_px[2], spec.safe_box_px[3]);
    if (!video) [sx0, sy0, sx1] = [8, 8, view.width - 8];
    halo["stroke-width"] = 3 * f;

    for (const p of places) {
      // The video sets its own names over the scene, so it can hide these and keep the axes.
      const o = labels ? (layers[p.target] ?? 0) : 0;
      if (o <= 0.001) {
        p.g.setAttribute("display", "none");
        continue;
      }
      const [x, y, z] = project(p.km, p.dem_m);
      if (z > 1 || z < -1) {
        p.g.setAttribute("display", "none");
        continue;
      }
      p.g.setAttribute("display", "");
      p.g.setAttribute("opacity", o);
      set(p.text, { "font-size": LABEL_PX * f, "stroke-width": 3 * f, "text-anchor": p.align });
      let tx = x + p.dx * f;
      const ty = y + p.dy * f;
      // Keep the text inside the safe box.
      const w = p.text.getComputedTextLength();
      const left = p.align === "end" ? tx - w : tx;
      if (left < sx0) tx += sx0 - left;
      if (left + w > sx1) tx -= left + w - sx1;
      set(p.text, { x: tx, y: Math.max(ty, sy0 + LABEL_PX * f) });
      // The leader runs from the point to the near end of the text.
      const ex = p.align === "end" ? tx + 4 * f : tx - 4 * f;
      const ey = ty - LABEL_PX * f * 0.35;
      const d = Math.hypot(ex - x, ey - y) || 1;
      set(p.leader, { x1: x + ((ex - x) / d) * 6 * f, y1: y + ((ey - y) / d) * 6 * f, x2: ex, y2: ey });
    }

    const a = layers.axes ?? 0;
    if (a <= 0.001) {
      axes.setAttribute("display", "none");
      return;
    }
    axes.setAttribute("display", "");
    axes.setAttribute("opacity", a);
    // Heights: a line across the profile at each round height (the sea level line in full,
    // the others faint), labelled at the left edge, inside the safe box.
    for (const { h, line, label } of heights) {
      const [x0, y0] = project(0, h);
      const [x1, y1] = project(L, h);
      set(line, { x1: x0, y1: y0, x2: x1, y2: y1 });
      set(label, { x: Math.max(x0, sx0) + 4 * f, y: y0 - 5 * f, "font-size": AXIS_PX * f, "stroke-width": 3 * f });
    }
    // km along the foot: every label sits centred under its own tick, from the same km scale as
    // the tick and the profile line, and is never moved off it. In the video only the ticks whose
    // label fits inside the safe box are drawn, each with its label; on the page every tick is
    // drawn, and a label within 8 px of a kept neighbour goes, with its tick (never the two ends).
    const boxes = [];
    const order = video
      ? kmTicks.map((_, i) => i)
      : [0, kmTicks.length - 1, ...kmTicks.map((_, i) => i).slice(1, -1)];
    for (const i of order) {
      const t = kmTicks[i];
      const [x, y] = project(t.km, 0);
      set(t.tick, { x1: x, y1: y, x2: x, y2: y + TICK_PX * f });
      set(t.label, { "font-size": AXIS_PX * f, "stroke-width": 3 * f, x, y: y + TICK_PX * f + (AXIS_PX + 4) * f });
      // A hidden label measures 0 px, so it is shown before it is measured.
      t.label.setAttribute("display", "");
      const w = t.label.getComputedTextLength();
      const box = [x - w / 2, x + w / 2];
      const end = i === 0 || i === kmTicks.length - 1;
      const keep = video
        ? box[0] >= sx0 && box[1] <= sx1
        : end || !boxes.some(([l, r]) => box[0] < r + MIN_GAP_PX * f && box[1] > l - MIN_GAP_PX * f);
      t.label.setAttribute("display", keep ? "" : "none");
      t.tick.setAttribute("display", keep ? "" : "none");
      if (keep) boxes.push(box);
    }
  }

  /** Resolves once the two faces are loaded, so every frame measures the text the same way. */
  const fontsReady = Promise.all([
    document.fonts.load(`600 ${LABEL_PX}px Inter`),
    document.fonts.load(`500 ${LABEL_PX}px "JetBrains Mono"`),
  ]);

  return { update, element: svg, fontsReady };
}
