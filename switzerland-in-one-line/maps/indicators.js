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
 * On the side view the labels know where the profile line is on screen: no label crosses it.
 * The highest place (the summit) always sits above the profile, right-aligned to its dot; the
 * other places keep their spot if it is clear and otherwise move above or below the line, or to
 * the other side of their point, whichever moves them least. The height labels and "Sea level"
 * sit in a column left of where the profile starts, each level with its own line.
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
const EDGE_PX = 8; // page labels keep this far inside the window
const ABOVE_PX = 12; // a label above the profile: its baseline this far above the highest point under it
const CLEAR_PX = 4; // any other label keeps this far from the profile line and from other labels
const DOT_GAP_PX = 8; // the summit label ends this far left of the summit dot
const SEA_GAP_PX = 6; // "Sea level" ends this far left of where the profile starts
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

  // The highest place is the summit: on the side view its label always sits above the profile.
  const summitId = spec.places.reduce((a, b) => (b.value_m > a.value_m ? b : a)).id;

  /** A text's font box at x = 0 on the baseline: width, and how far it reaches up and down. */
  function measure(text) {
    text.setAttribute("x", 0);
    text.setAttribute("y", 0);
    const b = text.getBBox();
    return { w: b.width, asc: -b.y, desc: b.y + b.height };
  }

  /**
   * The profile line on screen, for the side view: x and y of every sample. under(l, r) gives the
   * highest point (smallest y) and the lowest point of the line between x = l and x = r, with the
   * line interpolated at both ends, so a label can be checked against exactly what lies under it.
   */
  function screenProfile(profile, project) {
    const n = profile.km.length;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    for (let i = 0; i < n; i += 1) [xs[i], ys[i]] = project(profile.km[i], profile.h[i]);
    const rising = xs[n - 1] > xs[0];
    const yAt = (i, x) => (xs[i] === xs[i - 1] ? Math.min(ys[i], ys[i - 1]) : ys[i - 1] + ((x - xs[i - 1]) / (xs[i] - xs[i - 1])) * (ys[i] - ys[i - 1]));
    function under(l, r) {
      let top = Infinity;
      let low = -Infinity;
      // Seen side on the line runs left to right, so a binary search finds where to start.
      let i = 1;
      if (rising) {
        let [lo, hi] = [0, n - 1];
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (xs[mid] < l) lo = mid + 1;
          else hi = mid;
        }
        i = Math.max(1, lo);
      }
      for (; i < n; i += 1) {
        const [a, b] = [Math.min(xs[i - 1], xs[i]), Math.max(xs[i - 1], xs[i])];
        if (rising && a > r) break;
        const x0 = Math.max(l, a);
        const x1 = Math.min(r, b);
        if (x0 > x1) continue;
        for (const x of [x0, x1]) {
          const y = yAt(i, x);
          top = Math.min(top, y);
          low = Math.max(low, y);
        }
      }
      return { top, low };
    }
    return { start: [xs[0], ys[0]], under };
  }

  /**
   * Draw the indicators for one frame.
   * layers: the timeline values; view: { width, height }; project(km, heightM) gives screen px;
   * frame(fx, fy) turns a point of the 1080 x 1920 frame into screen px, and scale is screen px
   * per frame px (text and offsets shrink with it, but not below 55 %). video: true when the
   * frame is the video's (the recorder), so text keeps inside its safe box. profile: the samples
   * { km, h } and dotPx: the radius of an Amber dot on screen, both for the page's side view.
   */
  function update(layers, { view, project, frame, scale, video, profile = null, dotPx = 12 }) {
    svg.setAttribute("width", view.width);
    svg.setAttribute("height", view.height);
    const f = Math.min(1, Math.max(0.55, scale));
    // The video keeps its text inside its safe box; the page only inside the window.
    let [sx0, sy0] = frame(spec.safe_box_px[0], spec.safe_box_px[1]);
    let [sx1] = frame(spec.safe_box_px[2], spec.safe_box_px[3]);
    let sy1 = view.height - EDGE_PX;
    if (!video) [sx0, sy0, sx1] = [EDGE_PX, EDGE_PX, view.width - EDGE_PX];
    halo["stroke-width"] = 3 * f;
    const hw = 1.5 * f; // the halo reaches half its width past the glyphs

    const a = layers.axes ?? 0;
    // The page's side view (the axes show only there) knows where the profile line is on screen.
    const side = !video && a > 0.001 && profile;
    const line = side ? screenProfile(profile, project) : null;
    const taken = []; // boxes of the labels already placed on the side view
    const boxOf = (l, w, base, m) => ({ l: l - hw, r: l + w + hw, t: base - m.asc - hw, b: base + m.desc + hw });
    const hits = (b, pad = CLEAR_PX) => taken.some((o) => b.l < o.r + pad && b.r > o.l - pad && b.t < o.b + pad && b.b > o.t - pad);
    const crosses = (b) => {
      const u = line.under(b.l - CLEAR_PX, b.r + CLEAR_PX);
      return u.top < b.b + CLEAR_PX && u.low > b.t - CLEAR_PX;
    };
    const inside = (b) => b.l >= sx0 && b.r <= sx1 && b.t >= sy0 && b.b <= sy1;

    if (a <= 0.001) axes.setAttribute("display", "none");
    else {
      axes.setAttribute("display", "");
      axes.setAttribute("opacity", a);
      // km along the foot: every label sits centred under its own tick, from the same km scale
      // as the tick and the profile line, and is never moved off it. In the video only the ticks
      // whose label fits inside the safe box are drawn, each with its label; on the page every
      // tick is drawn, and a label within 8 px of a kept neighbour goes, with its tick (never the
      // two ends).
      const boxes = [];
      const order = video
        ? kmTicks.map((_, i) => i)
        : [0, kmTicks.length - 1, ...kmTicks.map((_, i) => i).slice(1, -1)];
      for (const i of order) {
        const t = kmTicks[i];
        const [x, y] = project(t.km, 0);
        set(t.tick, { x1: x, y1: y, x2: x, y2: y + TICK_PX * f });
        const ky = y + TICK_PX * f + (AXIS_PX + 4) * f;
        set(t.label, { "font-size": AXIS_PX * f, "stroke-width": 3 * f, x, y: ky });
        // A hidden label measures 0 px, so it is shown before it is measured.
        t.label.setAttribute("display", "");
        const w = t.label.getComputedTextLength();
        const box = [x - w / 2, x + w / 2];
        const end = i === 0 || i === kmTicks.length - 1;
        const keep = video
          ? box[0] >= sx0 && box[1] <= sx1
          : end || !boxes.some(([l, r]) => box[0] < r + MIN_GAP_PX && box[1] > l - MIN_GAP_PX); // 8 px on screen
        t.label.setAttribute("display", keep ? "" : "none");
        t.tick.setAttribute("display", keep ? "" : "none");
        if (keep) boxes.push(box);
        if (keep && side) {
          const b = t.label.getBBox();
          taken.push({ l: b.x - hw, r: b.x + b.width + hw, t: b.y - hw, b: b.y + b.height + hw });
        }
      }
      // Heights: a line across the profile at each round height (the sea level line in full,
      // the others faint), labelled at the left edge, inside the safe box.
      const [zx, zy] = project(0, 0);
      // On the page's side view every height label, "Sea level" included and in the same face,
      // sits in a column left of where the profile starts: right-aligned 6 px from it, centred on
      // its own line. Only if the window leaves no room for that column does each label go
      // inside: "Sea level" just above the 0 m line on the left, clear of the profile and its
      // fill, and the others on their line, sliding right until the profile is clear of them.
      if (side) set(heights[0].label, { "font-family": '"JetBrains Mono", monospace', "font-weight": 500 });
      const right = side ? line.start[0] - SEA_GAP_PX : 0;
      let column = Boolean(side);
      for (const { label } of heights) {
        set(label, { "font-size": AXIS_PX * f, "stroke-width": 3 * f, "text-anchor": "start" });
        if (column && right - measure(label).w - hw < sx0) column = false;
      }
      for (const { h, line: rule, label } of heights) {
        const [x0, y0] = project(0, h);
        const [x1, y1] = project(L, h);
        set(rule, { x1: x0, y1: y0, x2: x1, y2: y1 });
        if (!side) {
          // The video keeps its axis labels exactly as they were.
          set(label, { x: Math.max(x0, sx0) + 4 * f, y: y0 - 5 * f });
          continue;
        }
        const m = measure(label);
        if (column) {
          const bx = right - m.w;
          let base = y0 + (m.asc - m.desc) / 2;
          // Centred on the line, unless that would touch the "0 km" label under the line's
          // start: then only as far up as it takes to clear it.
          for (let up = 0; up < 12 && hits(boxOf(bx, m.w, base, m), 2); up += 1) base -= 1;
          set(label, { x: bx, y: base });
          taken.push(boxOf(bx, m.w, base, m));
          continue;
        }
        if (h === 0) {
          const bx = sx0 + hw;
          const u = line.under(bx - hw - CLEAR_PX, bx + m.w + hw + CLEAR_PX);
          const base = Math.min(zy, u.top) - CLEAR_PX - m.desc - hw;
          set(label, { x: bx, y: base });
          taken.push(boxOf(bx, m.w, base, m));
          continue;
        }
        const base = y0 - 5 * f;
        const from = Math.max(x0, sx0) + 4 * f;
        let bx = from;
        for (let x = from; x + m.w + hw <= Math.min(x1, sx1); x += 2) {
          const b = boxOf(x, m.w, base, m);
          if (!crosses(b) && !hits(b)) {
            bx = x;
            break;
          }
        }
        set(label, { x: bx, y: base });
        taken.push(boxOf(bx, m.w, base, m));
      }
      if (!side) {
        // Back to the video's face for the sea level label, should the page have switched it.
        set(heights[0].label, { "font-family": "Inter, sans-serif", "font-weight": 600 });
        set(heights[0].label, { x: Math.max(zx, sx0) + 4 * f, y: zy - 5 * f });
      }
    }

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
      set(p.text, { "font-size": LABEL_PX * f, "stroke-width": 3 * f, "text-anchor": "start" });
      const m = side ? measure(p.text) : null;
      let align = p.align;
      let left;
      let base;
      let gap = 6 * f; // the leader starts this far from the point
      if (side && p.id === summitId) {
        // The summit: right-aligned to its dot, ending 8 px left of it, the baseline 12 px above
        // the highest point of the profile under the whole label.
        align = "end";
        gap = dotPx + 2;
        left = Math.max(sx0 + hw, x - dotPx - DOT_GAP_PX - m.w);
        base = Math.max(sy0 + m.asc + hw, line.under(left - hw, left + m.w + hw).top - ABOVE_PX);
      } else if (side) {
        // Any other place keeps its spot if the profile and the other labels are clear of it;
        // otherwise it moves above the line or below it (into the fill), or to the other side
        // of its point, whichever moves it least. Each spot is checked against the profile under
        // the label's whole width.
        let best = null;
        for (const flip of [false, true]) {
          const al = flip === (p.align === "end") ? "start" : "end";
          const dx = (flip ? -p.dx : p.dx) * f;
          let l = al === "end" ? x + dx - m.w : x + dx;
          l = Math.min(Math.max(l, sx0 + hw), sx1 - hw - m.w);
          const want = y + p.dy * f;
          const u = line.under(l - hw - CLEAR_PX, l + m.w + hw + CLEAR_PX);
          for (const b0 of [want, u.top - ABOVE_PX, u.low + CLEAR_PX + m.asc + hw]) {
            const b = boxOf(l, m.w, b0, m);
            if (crosses(b) || hits(b) || !inside(b)) continue;
            const cost = Math.abs(b0 - want) + (flip ? 24 * f : 0);
            if (!best || cost < best.cost) best = { cost, l, b0, al };
          }
        }
        if (!best) {
          const l = Math.min(Math.max(p.align === "end" ? x + p.dx * f - m.w : x + p.dx * f, sx0 + hw), sx1 - hw - m.w);
          best = { l, b0: line.under(l - hw, l + m.w + hw).top - ABOVE_PX, al: p.align };
        }
        ({ l: left, b0: base, al: align } = best);
      } else {
        let tx = x + p.dx * f;
        const w = p.text.getComputedTextLength();
        left = p.align === "end" ? tx - w : tx;
        // Keep the text inside the safe box.
        if (left < sx0) left = sx0;
        if (left + w > sx1) left = sx1 - w;
        base = Math.max(y + p.dy * f, sy0 + LABEL_PX * f);
        // The video keeps the leader's old end point: the label's wanted height, not the clamped one.
        tx = p.align === "end" ? left + w : left;
        set(p.text, { x: tx, y: base, "text-anchor": p.align });
        const ex = p.align === "end" ? tx + 4 * f : tx - 4 * f;
        const ey = y + p.dy * f - LABEL_PX * f * 0.35;
        const d = Math.hypot(ex - x, ey - y) || 1;
        set(p.leader, { x1: x + ((ex - x) / d) * 6 * f, y1: y + ((ey - y) / d) * 6 * f, x2: ex, y2: ey });
        p.leader.setAttribute("display", "");
        continue;
      }
      const tx = align === "end" ? left + m.w : left;
      set(p.text, { x: tx, y: base, "text-anchor": align });
      taken.push(boxOf(left, m.w, base, m));
      // A thin leader from the point to the near end of the text, at the text's middle height;
      // none when the text sits right next to the point.
      const ex = align === "end" ? tx + 4 * f : tx - 4 * f;
      const ey = base - (m.asc - m.desc) / 2;
      const d = Math.hypot(ex - x, ey - y) || 1;
      const next = d - gap <= 12; // a leader shorter than this would be a stub
      p.leader.setAttribute("display", next ? "none" : "");
      if (!next) set(p.leader, { x1: x + ((ex - x) / d) * gap, y1: y + ((ey - y) / d) * gap, x2: ex, y2: ey });
    }
  }

  /** Resolves once the two faces are loaded, so every frame measures the text the same way. */
  const fontsReady = Promise.all([
    document.fonts.load(`600 ${LABEL_PX}px Inter`),
    document.fonts.load(`500 ${LABEL_PX}px "JetBrains Mono"`),
  ]);

  return { update, element: svg, fontsReady };
}
