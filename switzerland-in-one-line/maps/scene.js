/**
 * The 3D model of ONE LINE: a country seen from above with one straight line across it, then the
 * strip of land beside the line raised into a block that is cut open along the line, and turned
 * side on so that the cut face becomes the height profile.
 *
 * createScene(container, options) draws the model only, with no text and no page furniture, and
 * returns { ready, setFrame, play, pause, playFromStart, frames, setExaggeration, ... }. The page
 * in index.html adds the title, scale, labels and buttons around it; the recorder in the private
 * video recorder adds its own text.
 *
 * Series template: nothing in here knows the country. Everything comes from scene.json and the
 * layers maps/prepare.py writes (options.place.line holds the anchors, country, start, end,
 * corridor width and side). The next episode passes a new scene.json and new layers.
 *
 * options.config   the parsed layers/scene.json
 * options.place    defaults to config.place
 * options.urls     { profile, corridor, base, border }
 * options.size     [width, height] in CSS px for a fixed canvas; default: fill the container
 * options.exactFrame  true for the recorder: the 1080 x 1920 frame maps 1:1 onto the canvas
 * options.safeRect()  the free part of the window (CSS px) the model is fitted into
 * options.pixelRatio, options.interactive, options.preserveDrawingBuffer, options.startFrame,
 * options.indicatorLabels  false hides the in-scene place labels and keeps the axes (for a video
 *                 that sets its own names over the scene)
 * options.openOnStartView, options.playEndFrame, options.onPlayChange, options.onEnd,
 * options.onInteract, options.onPointerDown,
 * options.onClick(x, y), options.onDraw()
 *
 * Units: one scene unit is one kilometre. x points east, z points south, y points up, and the
 * origin is the midpoint of the line at sea level. Heights are stored true and drawn `ex` times
 * taller by one scale on the model group.
 */

import gsap from "gsap";
import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { FPS, LAYER_FIELDS, createTimeline, resolveCamera } from "./timeline.js";
import { createIndicators } from "./indicators.js";

// Field of view of the perspective camera over the frame height, and the near-orthographic one
// it narrows to before the true orthographic camera takes over (see placeCamera).
const FOV_WIDE_DEG = 30;
const FOV_NARROW_DEG = 0.3;

// Mark sizes in px of the 1080 px frame. They shrink with the frame on small windows.
const LINE_PX = 5;
const MAP_LINE_PX = 6;
const PULSE_PX = 18;
const CURSOR_LINE_PX = 2;
const DOT_PX = 9; // radius of an Amber dot
const RIM_PX = 3; // its Ink rim
const PULSE_GROWTH_PX = 34;
const MESH_STEP = 2; // the mesh takes every second cell of corridor.png (120 m)
const WALL_SHADE = 0.82; // the walls, 18 % darker than the top under the same light

const srgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/** Load a Terrarium PNG and decode it to heights in metres (NaN where there is no data). */
async function loadHeights(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not load ${url}: ${response.status}`);
  // No colour conversion and no premultiplied alpha: the bytes are data, not colour.
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const heights = new Float32Array(bitmap.width * bitmap.height);
  for (let i = 0; i < heights.length; i += 1) {
    const h = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
    heights[i] = h < -1000 ? NaN : h;
  }
  return { heights, width: bitmap.width, height: bitmap.height };
}

async function loadJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not load ${url}: ${response.status}`);
  return response.json();
}

/** The height ramp of the look: evenly spaced stops on a square-root (or straight) height scale,
 * blended in sRGB. Returns a THREE.Color in the linear working space. */
export function makeRamp(look) {
  const stops = look.height_ramp.map(srgb);
  const [lo, hi] = look.height_ramp_domain_m;
  const sqrt = look.height_ramp_scale === "sqrt";
  const out = new THREE.Color();
  return (heightM) => {
    let f = THREE.MathUtils.clamp((heightM - lo) / (hi - lo), 0, 1);
    if (sqrt) f = Math.sqrt(f);
    const t = f * (stops.length - 1);
    const i = Math.min(Math.floor(t), stops.length - 2);
    const k = t - i;
    const a = stops[i];
    const b = stops[i + 1];
    return out.setRGB(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k, THREE.SRGBColorSpace);
  };
}

/** An Amber dot with an Ink rim and a pulse ring, drawn as one screen-sized point. */
function makeDot(look) {
  const size = 2 * (DOT_PX + RIM_PX + PULSE_GROWTH_PX + 4);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uSize: { value: size },
      uScale: { value: 1 },
      uOpacity: { value: 0 },
      uPhase: { value: 0 },
      uAmber: { value: srgb(look.cursor) },
      uInk: { value: srgb(look.cursor_rim) },
    },
    vertexShader: /* glsl */ `
      uniform float uSize;
      uniform float uScale;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSize * uScale;
      }`,
    // Distances in px of the 1080 px frame, so the dot keeps its size on screen.
    fragmentShader: /* glsl */ `
      uniform float uSize;
      uniform float uOpacity;
      uniform float uPhase;
      uniform vec3 uAmber;
      uniform vec3 uInk;
      void main() {
        float r = length(gl_PointCoord - 0.5) * uSize;
        float dot = 1.0 - smoothstep(${DOT_PX - 0.6}, ${DOT_PX + 0.6}, r);
        float rim = 1.0 - smoothstep(${DOT_PX + RIM_PX - 0.6}, ${DOT_PX + RIM_PX + 0.6}, r);
        float pr = ${DOT_PX + RIM_PX}.0 + ${PULSE_GROWTH_PX}.0 * uPhase;
        float pulse = (1.0 - smoothstep(1.0, 2.2, abs(r - pr))) * (1.0 - uPhase) * step(0.001, uPhase)
                      * step(uPhase, 0.999);
        vec3 col = rim > 0.0 ? mix(uInk, uAmber, dot) : uAmber;
        float a = max(rim, pulse * 0.85);
        gl_FragColor = vec4(col, a * uOpacity);
      }`,
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 30;
  points.frustumCulled = false;
  return points;
}

/**
 * The flatten morph, added to a built-in material: each vertex moves from its own height to the
 * profile height at the same distance along the line (attribute aFlat), and its normal turns up.
 * At 1 the block is the profile pushed straight back, so seen side on its outline is exactly the
 * profile and nothing behind the cut face shows above it.
 */
function addFlatten(material, uniform) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFlatten = uniform;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uFlatten;\nattribute float aFlat;")
      .replace(
        "#include <beginnormal_vertex>",
        "#include <beginnormal_vertex>\nobjectNormal = normalize(mix(objectNormal, vec3(0.0, 1.0, 0.0), uFlatten));",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\ntransformed.y = mix(position.y, aFlat, uFlatten);",
      );
  };
  material.customProgramCacheKey = () => "flatten";
  return material;
}

/**
 * The walls of the block (the cut face included): the same height ramp as the top, by each
 * point's own height, so the colours run on down the cutaway like the strata of a museum model.
 *
 * The colour is worked out per pixel from the height, so a wall needs no extra vertices to show
 * every stop of the ramp. The walls take the light a flat top would take (their normals point
 * up), times `shade`: always 15 to 20 % darker than the top beside them, from any side, never
 * black. With a `chart`, the colour can switch to the flat profile chart colours of the side view
 * (behind and ahead of the cursor), mixed in after the light so they stay exactly those colours.
 */
function wallMaterial(look, flattenUniform, { shade, chart = null }) {
  const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, transparent: true });
  const [lo, hi] = look.height_ramp_domain_m;
  const uniforms = {
    uFlatten: flattenUniform,
    uStops: { value: look.height_ramp.map(srgb) },
    uDomain: { value: new THREE.Vector2(lo, hi) },
    uSqrt: { value: look.height_ramp_scale === "sqrt" ? 1 : 0 },
    uShade: { value: shade },
    ...(chart ?? {}),
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uFlatten;
        attribute float aFlat;
        varying float vHeightM;
        ${chart ? "attribute float aAlong;\nvarying float vAlong;" : ""}`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        transformed.y = mix(position.y, aFlat, uFlatten);
        vHeightM = transformed.y * 1000.0;
        ${chart ? "vAlong = aAlong;" : ""}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform vec3 uStops[5];
        uniform vec2 uDomain;
        uniform float uSqrt;
        uniform float uShade;
        varying float vHeightM;
        ${chart ? "uniform float uCursor;\nuniform float uMix;\nuniform vec3 uFill;\nuniform vec3 uAhead;\nvarying float vAlong;" : ""}
        vec3 rampSRGB(float h) {
          float f = clamp((h - uDomain.x) / (uDomain.y - uDomain.x), 0.0, 1.0);
          if (uSqrt > 0.5) f = sqrt(f);
          float t = f * 4.0;
          float i = min(floor(t), 3.0);
          float k = t - i;
          vec3 a = uStops[0];
          vec3 b = uStops[1];
          if (i > 0.5) { a = uStops[1]; b = uStops[2]; }
          if (i > 1.5) { a = uStops[2]; b = uStops[3]; }
          if (i > 2.5) { a = uStops[3]; b = uStops[4]; }
          return mix(a, b, k);
        }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        diffuseColor.rgb = sRGBTransferEOTF(vec4(rampSRGB(vHeightM) * uShade, 1.0)).rgb;`,
      )
      // The light of a flat top, from whichever side the wall is seen.
      .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\nnormal = normalize(vNormal);")
      .replace(
        "#include <opaque_fragment>",
        chart
          ? `#include <opaque_fragment>
          vec3 chart = vAlong <= uCursor ? uFill : uAhead;
          gl_FragColor.rgb = mix(gl_FragColor.rgb, sRGBTransferEOTF(vec4(chart, 1.0)).rgb, uMix);`
          : "#include <opaque_fragment>",
      );
  };
  material.customProgramCacheKey = () => (chart ? "wall-chart" : "wall");
  return material;
}

/** Point every normal of a geometry straight up (walls lit like the flat top). */
function upNormals(geometry) {
  const n = geometry.getAttribute("position").count;
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) normals[i * 3 + 1] = 1;
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
}

export function createScene(container, options) {
  const config = options.config;
  const place = options.place ?? config.place;
  const look = config.look;
  const line = place.line;
  const framePx = config.frame_px;
  const [frameW, frameH] = framePx;
  const L = line.length_km;
  const S = new THREE.Vector2(...line.start_xz);
  const U = new THREE.Vector2(...line.along_xz);
  const N = new THREE.Vector2(...line.corridor_normal_xz);
  const corridorKm = place.corridor_km;
  const sDotU = S.dot(U);
  /** Scene x, z of a point `alongKm` along the line and `acrossKm` towards the corridor side. */
  const at = (alongKm, acrossKm = 0) =>
    new THREE.Vector2(S.x + U.x * alongKm + N.x * acrossKm, S.y + U.y * alongKm + N.y * acrossKm);

  // ---- renderer, scene, cameras ----
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
    preserveDrawingBuffer: Boolean(options.preserveDrawingBuffer),
  });
  renderer.setClearColor(new THREE.Color(look.background));
  renderer.localClippingEnabled = true;
  const pixelRatio = options.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // Everything with a height lives in one group, so the exaggeration is one scale on y. three.js
  // turns the normals with the inverse transpose of that scale, so the light stays right at any
  // exaggeration.
  const model = new THREE.Group();
  const corridorGroup = new THREE.Group();
  model.add(corridorGroup);
  scene.add(model);
  const perspective = new THREE.PerspectiveCamera(FOV_WIDE_DEG, frameW / frameH, 1, 1000);
  const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 4000);
  let activeCamera = perspective;

  // One soft directional light for the hillshade, from the north-west at 40 degrees, and an even
  // fill so slopes facing away stay readable. No shadows, no fog, no glow.
  const az = THREE.MathUtils.degToRad(look.light.azimuth_deg);
  const alt = THREE.MathUtils.degToRad(look.light.altitude_deg);
  const sun = new THREE.DirectionalLight(0xffffff, Math.PI * 1.05);
  sun.position.set(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
  scene.add(sun, sun.target);
  scene.add(new THREE.AmbientLight(0xffffff, Math.PI * 0.5));

  // ---- shared uniforms and clipping planes ----
  const flattenUniform = { value: 0 };
  // The cut face's switch to the chart colours of the side view, and where the cursor is.
  const cutUniforms = {
    uCursor: { value: 0 },
    uMix: { value: 0 },
    uFill: { value: srgb(look.profile_fill) },
    uAhead: { value: srgb(look.profile_ahead) },
  };
  // The Amber line shows behind the cursor only; the Slate line ahead of it only.
  const behindPlane = new THREE.Plane(new THREE.Vector3(-U.x, 0, -U.y), sDotU);
  const aheadPlane = new THREE.Plane(new THREE.Vector3(U.x, 0, U.y), -sDotU);

  const layers = {};
  const lineMaterials = []; // [material, width in frame px]
  let profile = null; // { km: Float32Array, h: Float32Array }
  let corridor = null; // { heights, width, height }

  /** Profile height in metres at a distance along the line, linear between samples. */
  function profileHeight(km) {
    const { km: ks, h } = profile;
    if (km <= 0) return h[0];
    if (km >= ks[ks.length - 1]) return h[h.length - 1];
    let lo = 0;
    let hi = ks.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ks[mid] <= km) lo = mid;
      else hi = mid;
    }
    const f = (km - ks[lo]) / (ks[hi] - ks[lo]);
    return h[lo] + (h[hi] - h[lo]) * f;
  }

  /** Corridor height in metres at (along, across) km, bilinear from corridor.png. */
  function corridorHeight(alongKm, acrossKm) {
    const { heights, width, height } = corridor;
    const fx = THREE.MathUtils.clamp((alongKm / L) * (width - 1), 0, width - 1);
    const fy = THREE.MathUtils.clamp((acrossKm / corridorKm) * (height - 1), 0, height - 1);
    const x0 = Math.min(Math.floor(fx), width - 2);
    const y0 = Math.min(Math.floor(fy), height - 2);
    const tx = fx - x0;
    const ty = fy - y0;
    const g = (x, y) => heights[y * width + x];
    const top = g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx;
    const bottom = g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bottom * ty;
  }

  /** Longitude and latitude of scene x, z, from the polynomial prepare.py fitted. */
  function toLonLat(x, z) {
    const { powers, lon, lat } = config.geo;
    let a = 0;
    let b = 0;
    powers.forEach(([i, j], k) => {
      const term = x ** i * z ** j;
      a += lon[k] * term;
      b += lat[k] * term;
    });
    return [a, b];
  }

  const screenLine = (hex, widthPx, extra = {}) => {
    const material = new LineMaterial({
      color: new THREE.Color(hex),
      linewidth: widthPx,
      transparent: true,
      depthWrite: false,
      ...extra,
    });
    lineMaterials.push([material, widthPx]);
    return material;
  };
  const makeLine2 = (positions, material, order = 10) => {
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    const l = new Line2(geometry, material);
    l.computeLineDistances();
    l.renderOrder = order;
    l.frustumCulled = false;
    return l;
  };

  // ---- the top-view map ----
  function buildBase(texture) {
    const b = config.base;
    const [ox, oz] = config.origin_m;
    const x0 = (b.west_m - ox) / 1000;
    const x1 = (b.east_m - ox) / 1000;
    const zN = -(b.north_m - oz) / 1000;
    const zS = -(b.south_m - oz) / 1000;
    const geometry = new THREE.PlaneGeometry(x1 - x0, zS - zN);
    geometry.rotateX(-Math.PI / 2); // image top (v = 1) to the north (negative z)
    geometry.translate((x0 + x1) / 2, -0.02, (zN + zS) / 2);
    // The map's hillshade is baked into the image, so it is drawn unlit. The bytes are written
    // straight to the canvas (no colour conversion), and the land west of the line can fade on
    // its own: the first thing the slice beat does.
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uMap: { value: texture },
        uOpacity: { value: 1 },
        uWest: { value: 1 },
        uS: { value: S },
        uN: { value: N },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec2 vXZ;
        void main() {
          vUv = uv;
          vec4 world = modelMatrix * vec4(position, 1.0);
          vXZ = world.xz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform float uOpacity;
        uniform float uWest;
        uniform vec2 uS;
        uniform vec2 uN;
        varying vec2 vUv;
        varying vec2 vXZ;
        void main() {
          float across = dot(vXZ - uS, uN);
          float side = mix(uWest, 1.0, smoothstep(-3.0, 1.0, across));
          gl_FragColor = vec4(texture2D(uMap, vUv).rgb, uOpacity * side);
        }`,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = -2;
    scene.add(mesh);
    layers.base = mesh;
  }

  function buildBorder(border) {
    const [ox, oz] = config.origin_m;
    const positions = [];
    for (const ring of border.rings) {
      for (let i = 0; i < ring.length - 1; i += 1) {
        const [e0, n0] = ring[i];
        const [e1, n1] = ring[i + 1];
        positions.push((e0 - ox) / 1000, 0, -(n0 - oz) / 1000, (e1 - ox) / 1000, 0, -(n1 - oz) / 1000);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color: new THREE.Color(look.border),
      transparent: true,
      opacity: look.border_opacity,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.renderOrder = -1;
    lines.frustumCulled = false;
    scene.add(lines);
    layers.border = lines;
  }

  function buildMapLine() {
    const a = at(0);
    const b = at(L);
    const y = 0.02;
    layers.mapLine = makeLine2([a.x, y, a.y, b.x, y, b.y], screenLine(look.line, MAP_LINE_PX), 12);
    layers.pulse = makeLine2([a.x, y, a.y, b.x, y, b.y], screenLine(look.line, PULSE_PX), 11);
    layers.startDot = makeDot(look);
    layers.startDot.position.set(a.x, y, a.y);
    layers.endDot = makeDot(look);
    layers.endDot.position.set(b.x, y, b.y);
    scene.add(layers.mapLine, layers.pulse, layers.startDot, layers.endDot);
  }

  // ---- the corridor block ----
  function buildCorridor() {
    const { heights, width, height } = corridor;
    const ramp = makeRamp(look);
    const cols = Math.floor((width - 1) / MESH_STEP) + 1;
    const rows = Math.floor((height - 1) / MESH_STEP) + 1;
    const colIndex = (i) => Math.min(i * MESH_STEP, width - 1);
    const rowIndex = (j) => Math.min(j * MESH_STEP, height - 1);
    const count = cols * rows;
    const positions = new Float32Array(count * 3);
    const colours = new Float32Array(count * 3);
    const flat = new Float32Array(count);
    const alongOf = (i) => (colIndex(i) / (width - 1)) * L;
    const acrossOf = (j) => (rowIndex(j) / (height - 1)) * corridorKm;
    for (let j = 0; j < rows; j += 1) {
      for (let i = 0; i < cols; i += 1) {
        const k = j * cols + i;
        const hM = heights[rowIndex(j) * width + colIndex(i)];
        const p = at(alongOf(i), acrossOf(j));
        positions[k * 3] = p.x;
        positions[k * 3 + 1] = hM / 1000;
        positions[k * 3 + 2] = p.y;
        flat[k] = heights[colIndex(i)] / 1000; // row 0 is the line: the profile
        const c = ramp(hM);
        colours[k * 3] = c.r;
        colours[k * 3 + 1] = c.g;
        colours[k * 3 + 2] = c.b;
      }
    }
    const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
    let n = 0;
    for (let j = 0; j < rows - 1; j += 1) {
      for (let i = 0; i < cols - 1; i += 1) {
        const a = j * cols + i;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        index.set([a, b, c, b, d, c], n);
        n += 6;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    geometry.setAttribute("aFlat", new THREE.BufferAttribute(flat, 1));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    // Normals from the true surface; the exaggeration scale turns them, which is the hillshade.
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const material = addFlatten(
      new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true }),
      flattenUniform,
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    corridorGroup.add(mesh);
    layers.terrain = mesh;

    // The box round it: the east wall follows the terrain along the far edge, the two end walls
    // follow it across, and a base closes it. All carry the height ramp (see wallMaterial).
    const wall = [];
    const wallFlat = [];
    const wallIndex = [];
    const strip = (tops) => {
      // tops: [x, hKm, z, flatKm] from one end to the other; a vertical strip down to y 0.
      const base = wall.length / 3;
      tops.forEach(([x, h, z, f], e) => {
        wall.push(x, h, z, x, 0, z);
        wallFlat.push(f, 0);
        if (e > 0) {
          const a = base + (e - 1) * 2;
          wallIndex.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      });
    };
    const vertexTop = (i, j) => {
      const k = j * cols + i;
      return [positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2], flat[k]];
    };
    const eastTop = [];
    for (let i = 0; i < cols; i += 1) eastTop.push(vertexTop(i, rows - 1));
    const startTop = [];
    const endTop = [];
    for (let j = 0; j < rows; j += 1) {
      startTop.push(vertexTop(0, j));
      endTop.push(vertexTop(cols - 1, j));
    }
    strip(eastTop);
    strip(startTop);
    strip(endTop);
    const corners = [at(0, 0), at(L, 0), at(L, corridorKm), at(0, corridorKm)];
    const wallGeometry = new THREE.BufferGeometry();
    wallGeometry.setAttribute("position", new THREE.Float32BufferAttribute(wall, 3));
    wallGeometry.setAttribute("aFlat", new THREE.Float32BufferAttribute(wallFlat, 1));
    wallGeometry.setIndex(wallIndex);
    upNormals(wallGeometry);
    const walls = new THREE.Mesh(wallGeometry, wallMaterial(look, flattenUniform, { shade: WALL_SHADE }));
    walls.frustumCulled = false;
    corridorGroup.add(walls);
    layers.walls = walls;

    // The base, at y 0: the darkest colour of the ramp, exactly.
    const baseGeometry = new THREE.BufferGeometry();
    baseGeometry.setAttribute("position", new THREE.Float32BufferAttribute(corners.flatMap((c) => [c.x, 0, c.y]), 3));
    baseGeometry.setIndex([0, 1, 2, 0, 2, 3]);
    const plinth = new THREE.Mesh(
      baseGeometry,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(look.height_ramp[0]), side: THREE.DoubleSide, transparent: true }),
    );
    plinth.frustumCulled = false;
    corridorGroup.add(plinth);
    layers.plinth = plinth;

    // The 1 px lighter edge round the box: the top edges, the four corners and the base.
    const edge = [];
    const edgeFlat = [];
    const polyline = (tops) => {
      for (let e = 1; e < tops.length; e += 1) {
        const [x0, h0, z0, f0] = tops[e - 1];
        const [x1, h1, z1, f1] = tops[e];
        edge.push(x0, h0, z0, x1, h1, z1);
        edgeFlat.push(f0, f1);
      }
    };
    polyline(eastTop);
    polyline(startTop);
    polyline(endTop);
    const westTop = [];
    for (let k = 0; k < profile.km.length; k += 1) {
      const p = at(profile.km[k], -0.004);
      westTop.push([p.x, profile.h[k] / 1000, p.y, profile.h[k] / 1000]);
    }
    polyline(westTop);
    for (const c of corners) {
      const top = c === corners[0] ? startTop[0] : c === corners[1] ? endTop[0] : c === corners[2] ? endTop.at(-1) : startTop.at(-1);
      edge.push(c.x, 0, c.y, c.x, top[1], c.y);
      edgeFlat.push(0, top[3]);
    }
    for (let i = 0; i < 4; i += 1) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      edge.push(a.x, 0, a.y, b.x, 0, b.y);
      edgeFlat.push(0, 0);
    }
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(edge, 3));
    edgeGeometry.setAttribute("aFlat", new THREE.Float32BufferAttribute(edgeFlat, 1));
    const edges = new THREE.LineSegments(
      edgeGeometry,
      addFlatten(
        new THREE.LineBasicMaterial({ color: new THREE.Color(look.wall_edge), transparent: true }),
        flattenUniform,
      ),
    );
    edges.frustumCulled = false;
    edges.renderOrder = 2;
    corridorGroup.add(edges);
    layers.edges = edges;

    // Height ticks on the end walls every 1,000 m, like the levels on a museum cutaway: a thin
    // Paper line across the wall wherever the wall reaches that height.
    const ticks = [];
    const tickWall = (tops, outward) => {
      for (const hM of look.ticks_m) {
        const hKm = hM / 1000;
        for (let e = 1; e < tops.length; e += 1) {
          const [x0, h0, z0] = tops[e - 1];
          const [x1, h1, z1] = tops[e];
          if (h0 < hKm && h1 < hKm) continue;
          let a = 0;
          let b = 1;
          if (h0 < hKm) a = (hKm - h0) / (h1 - h0);
          if (h1 < hKm) b = (hKm - h0) / (h1 - h0);
          const ox = U.x * outward * 0.02;
          const oz = U.y * outward * 0.02;
          ticks.push(
            x0 + (x1 - x0) * a + ox, hKm, z0 + (z1 - z0) * a + oz,
            x0 + (x1 - x0) * b + ox, hKm, z0 + (z1 - z0) * b + oz,
          );
        }
      }
    };
    tickWall(startTop, -1);
    tickWall(endTop, 1);
    const tickGeometry = new THREE.BufferGeometry();
    tickGeometry.setAttribute("position", new THREE.Float32BufferAttribute(ticks, 3));
    const tickLines = new THREE.LineSegments(
      tickGeometry,
      new THREE.LineBasicMaterial({ color: new THREE.Color(look.paper), transparent: true, opacity: look.tick_opacity }),
    );
    tickLines.frustumCulled = false;
    tickLines.renderOrder = 3;
    corridorGroup.add(tickLines);
    layers.ticks = tickLines;
    layers.endTops = { start: startTop, end: endTop };
  }

  /** The cut face: a curtain from the full 30 m profile down to the base, a hair outside the
   * block so it never fights the terrain edge for the same pixels. In 3D it carries the height
   * ramp like the other walls; in the side view it becomes the chart (fill behind the cursor,
   * faint ahead of it). */
  function buildCut() {
    const { km, h } = profile;
    const positions = new Float32Array(km.length * 6);
    const along = new Float32Array(km.length * 2);
    const index = [];
    for (let k = 0; k < km.length; k += 1) {
      const p = at(km[k], -0.004);
      positions.set([p.x, h[k] / 1000, p.y, p.x, 0, p.y], k * 6);
      along[k * 2] = km[k];
      along[k * 2 + 1] = km[k];
      if (k > 0) {
        const a = (k - 1) * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aAlong", new THREE.BufferAttribute(along, 1));
    // The cut face is the profile itself: flattening leaves it where it is.
    geometry.setAttribute("aFlat", new THREE.BufferAttribute(Float32Array.from(positions.filter((_, i) => i % 3 === 1)), 1));
    geometry.setIndex(index);
    upNormals(geometry);
    const material = wallMaterial(look, flattenUniform, { shade: WALL_SHADE, chart: cutUniforms });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    corridorGroup.add(mesh);
    layers.cut = mesh;

    // The Amber line along the top of the cut, drawn up to the cursor; Slate ahead of it in the
    // side view. Both are clipped by a plane across the line at the cursor.
    const top = [];
    for (let k = 0; k < km.length; k += 1) {
      const p = at(km[k], -0.006);
      top.push(p.x, h[k] / 1000, p.y);
    }
    layers.profileLine = makeLine2(top, screenLine(look.line, LINE_PX, { clippingPlanes: [behindPlane] }), 20);
    layers.aheadLine = makeLine2(
      top,
      screenLine(look.slate, 2, { clippingPlanes: [aheadPlane], opacity: 0.5 }),
      19,
    );
    layers.cursorStem = makeLine2([0, 0, 0, 0, 1, 0], screenLine(look.line, CURSOR_LINE_PX), 21);
    corridorGroup.add(layers.profileLine, layers.aheadLine, layers.cursorStem);
    layers.cursorDot = makeDot(look);
    layers.summitDot = makeDot(look);
    scene.add(layers.cursorDot, layers.summitDot);
  }

  // ---- camera ----
  const target = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const up = new THREE.Vector3();
  const viewSize = { width: 1, height: 1 };
  let uiScale = 1;

  /** The free part of the window, in CSS px. */
  const freeRect = () =>
    options.safeRect?.() ?? { left: 0, top: 0, right: viewSize.width, bottom: viewSize.height };

  /**
   * Place the camera for a numeric camera state.
   *
   * The camera keys describe the 1080 x 1920 frame: its width in km at the target, where the
   * target sits on it (ax, ay) and which part of it holds the subject (sx0..sy1). The recorder
   * maps the frame 1:1 onto its canvas. The page instead scales the frame so the subject part
   * fills the free part of the window: on a phone that is nearly the 9:16 framing, on a
   * wide window the view widens so the whole model stays in view, never cropped and never under
   * the furniture.
   *
   * Perspective and orthographic hand over without a jump: on its way to the side view the
   * perspective camera narrows its field of view (in log steps) while backing off, so the target
   * plane keeps its size and the picture flattens. At 0.3 degrees it cannot be told from the
   * orthographic camera that takes over when persp reaches 0.
   */
  function placeCamera(cam, exact = options.exactFrame) {
    const W = viewSize.width;
    const H = viewSize.height;
    let k;
    let px;
    let py;
    if (exact) {
      k = Math.min(W / frameW, H / frameH);
      px = (W - frameW * k) / 2 + cam.ax * k;
      py = (H - frameH * k) / 2 + cam.ay * k;
    } else {
      const R = freeRect();
      k = Math.min((R.right - R.left) / (cam.sx1 - cam.sx0), (R.bottom - R.top) / (cam.sy1 - cam.sy0));
      px = (R.left + R.right) / 2 + (cam.ax - (cam.sx0 + cam.sx1) / 2) * k;
      py = (R.top + R.bottom) / 2 + (cam.ay - (cam.sy0 + cam.sy1) / 2) * k;
    }
    uiScale = THREE.MathUtils.clamp(k, 0.6, 1);
    const frameWidth = 2 ** cam.logWidth;
    const frameHeight = (frameWidth * frameH) / frameW;
    const kmPerPx = frameWidth / frameW / k;
    const visibleWidth = W * kmPerPx;
    const visibleHeight = H * kmPerPx;
    const pitch = THREE.MathUtils.degToRad(cam.pitch);
    const bearing = THREE.MathUtils.degToRad(cam.bearing);
    target.set(cam.tx, cam.ty, cam.tz);
    // Bearing as on a map: the direction the camera faces, clockwise from north (-z).
    forward.set(Math.sin(bearing), 0, -Math.cos(bearing));
    up.set(0, Math.sin(pitch), 0).addScaledVector(forward, Math.cos(pitch));

    let camera;
    if (cam.persp > 1e-4) {
      const fovFrame = Math.exp(
        Math.log(FOV_NARROW_DEG) + (Math.log(FOV_WIDE_DEG) - Math.log(FOV_NARROW_DEG)) * cam.persp,
      );
      const distance = frameHeight / 2 / Math.tan(THREE.MathUtils.degToRad(fovFrame) / 2);
      camera = perspective;
      camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(visibleHeight / 2 / distance));
      camera.aspect = W / H;
      camera.near = Math.max(0.5, distance - 900);
      camera.far = distance + 900;
      camera.position
        .copy(target)
        .addScaledVector(forward, -distance * Math.sin(pitch))
        .add(new THREE.Vector3(0, distance * Math.cos(pitch), 0));
    } else {
      camera = orthographic;
      camera.left = -visibleWidth / 2;
      camera.right = visibleWidth / 2;
      camera.top = visibleHeight / 2;
      camera.bottom = -visibleHeight / 2;
      const distance = 1500;
      camera.near = 1;
      camera.far = 3000;
      camera.position
        .copy(target)
        .addScaledVector(forward, -distance * Math.sin(pitch))
        .add(new THREE.Vector3(0, distance * Math.cos(pitch), 0));
    }
    camera.up.copy(up);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    // Lens shift: move the target to (px, py) without turning the camera.
    const shiftX = (2 * px) / W - 1;
    const shiftY = 1 - (2 * py) / H;
    const m = camera.projectionMatrix.elements;
    if (camera === perspective) {
      m[8] -= shiftX;
      m[9] -= shiftY;
    } else {
      m[12] += shiftX;
      m[13] += shiftY;
    }
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    camera.updateMatrixWorld();
    activeCamera = camera;
    return { k, px, py, ax: cam.ax, ay: cam.ay };
  }

  // ---- views: the timeline's, the reader's, or an eased move between two ----
  let timeline = null;
  let indicators = null; // the animation's labels and axes (indicators.js)
  let frameMap = { k: 1, px: 0, py: 0, ax: 0, ay: 0 }; // frame px to screen px, last drawn
  let fields = LAYER_FIELDS; // every layer value, indicators included, once the timeline exists
  let frame = 0;
  let playing = false;
  let playOnce = false;
  let locked = false; // while the page plays the animation, the reader cannot move the model
  let user = null; // { camera, layers } while the reader has the model
  let blend = null; // { from, to (view or null = timeline), start, duration, hold }
  let exTween = null;
  let raf = 0;
  let lastTime = 0;
  let lastView = null;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2); // power2.inOut

  const pickLayers = (s) => Object.fromEntries(fields.map((k) => [k, s[k]]));
  const timelineView = () => ({ camera: { ...timeline.state.camera }, layers: pickLayers(timeline.state) });
  const copyView = (v) => ({ camera: { ...v.camera }, layers: { ...v.layers } });

  function mixViews(a, b, t) {
    const camera = {};
    for (const k of Object.keys(b.camera)) camera[k] = a.camera[k] + (b.camera[k] - a.camera[k]) * t;
    const db = ((((b.camera.bearing - a.camera.bearing) % 360) + 540) % 360) - 180;
    camera.bearing = a.camera.bearing + db * t;
    const layersOut = {};
    for (const k of fields) layersOut[k] = a.layers[k] + (b.layers[k] - a.layers[k]) * t;
    return { camera, layers: layersOut };
  }

  function currentView(now) {
    if (blend) {
      const t = Math.min(1, (now - blend.start) / blend.duration);
      const to = blend.to ?? timelineView();
      if (t >= 1) {
        if (blend.to) user = copyView(blend.to);
        const done = blend.done;
        blend = null;
        done?.();
        return to;
      }
      return mixViews(blend.from, to, easeInOut(t));
    }
    return user ?? timelineView();
  }

  /** Push a view into the scene objects, then draw. */
  function draw(now = performance.now()) {
    const view = currentView(now);
    lastView = view;
    const s = view.layers;
    frameMap = placeCamera(view.camera);
    const ex = Math.max(s.ex, 1e-3);
    model.scale.y = ex;
    flattenUniform.value = s.flatten;

    for (const [material, width] of lineMaterials) material.linewidth = width * uiScale;

    // The map, its border, the line on it.
    const base = layers.base;
    base.visible = s.base > 0.001;
    base.material.uniforms.uOpacity.value = s.base;
    base.material.uniforms.uWest.value = s.base_west;
    layers.border.visible = base.visible;
    layers.border.material.opacity = look.border_opacity * s.base * s.base_west;
    const mapOn = s.map_line > 0.001;
    for (const key of ["mapLine", "startDot", "endDot"]) layers[key].visible = mapOn;
    layers.mapLine.material.opacity = s.map_line;
    for (const dot of [layers.startDot, layers.endDot]) {
      dot.material.uniforms.uOpacity.value = s.map_line;
      dot.material.uniforms.uScale.value = uiScale * pixelRatio;
    }
    layers.pulse.visible = s.pulse > 0.001;
    if (layers.pulse.visible) {
      const c = s.pulse_km * L;
      const a = at(Math.max(0, c - 9));
      const b = at(Math.min(L, c + 9));
      layers.pulse.geometry.setPositions([a.x, 0.02, a.y, b.x, 0.02, b.y]);
      layers.pulse.material.opacity = 0.32 * s.pulse;
    }

    // The block.
    const co = s.corridor;
    corridorGroup.visible = co > 0.001;
    layers.terrain.material.opacity = co;
    layers.walls.material.opacity = co;
    layers.plinth.material.opacity = co;
    layers.edges.material.opacity = co * 0.9;
    layers.ticks.material.opacity = co * look.tick_opacity * (1 - s.flatten);
    cutUniforms.uCursor.value = s.cursor_km;
    cutUniforms.uMix.value = s.profile_mix;
    layers.cut.material.opacity = co;
    behindPlane.constant = sDotU + s.cursor_km;
    aheadPlane.constant = -(sDotU + s.cursor_km);
    layers.profileLine.material.opacity = co;
    layers.profileLine.visible = s.cursor_km > 0.001;
    layers.aheadLine.visible = s.profile_mix > 0.001;
    layers.aheadLine.material.opacity = 0.5 * s.profile_mix * co;
    // Seen from the cut side, the Amber line and its dot are always drawn on top of the block;
    // from the far side the block hides them, as a solid model would.
    const fromCutSide = forward.x * N.x + forward.z * N.y > -0.05;
    layers.profileLine.material.depthTest = !fromCutSide;
    layers.aheadLine.material.depthTest = !fromCutSide;

    const cursorP = at(s.cursor_km, -0.006);
    const cursorY = (profileHeight(s.cursor_km) / 1000) * ex;
    const stem = layers.cursorStem;
    stem.visible = s.profile_mix > 0.001 && s.cursor > 0.001 && co > 0.001;
    if (stem.visible) {
      stem.geometry.setPositions([cursorP.x, cursorY / ex, cursorP.y, cursorP.x, 0, cursorP.y]);
      stem.material.opacity = s.profile_mix * s.cursor * co;
    }
    const dot = layers.cursorDot;
    dot.visible = s.cursor > 0.001 && co > 0.001;
    dot.position.set(cursorP.x, cursorY, cursorP.y);
    dot.material.uniforms.uOpacity.value = s.cursor * co;
    dot.material.uniforms.uScale.value = uiScale * pixelRatio;
    dot.material.depthTest = !fromCutSide;
    const summitKm = place.points_km.dufourspitze ?? L;
    const sp = at(summitKm, -0.006);
    const summit = layers.summitDot;
    summit.visible = s.summit > 0.001 && co > 0.001;
    summit.position.set(sp.x, (profileHeight(summitKm) / 1000) * ex, sp.y);
    summit.material.uniforms.uOpacity.value = s.summit * co;
    summit.material.uniforms.uPhase.value = s.summit_pulse;
    summit.material.uniforms.uScale.value = uiScale * pixelRatio;

    indicators?.update(s, {
      view: viewSize,
      project: (km, heightM) => {
        const p = at(km);
        return toScreen(new THREE.Vector3(p.x, (heightM / 1000) * ex, p.y));
      },
      frame: (fx, fy) => [frameMap.px + (fx - frameMap.ax) * frameMap.k, frameMap.py + (fy - frameMap.ay) * frameMap.k],
      scale: frameMap.k,
      video: Boolean(options.exactFrame),
    });
    renderer.render(scene, activeCamera);
    options.onDraw?.();
  }

  function resize() {
    const [w, h] = options.size ?? [container.clientWidth, container.clientHeight];
    viewSize.width = Math.max(1, w);
    viewSize.height = Math.max(1, h);
    renderer.setSize(viewSize.width, viewSize.height);
    for (const [material] of lineMaterials) material.resolution.set(viewSize.width, viewSize.height);
  }

  // ---- render loop: only while something moves; nothing is drawn while idle or hidden ----
  function requestDraw() {
    if (!raf && document.visibilityState === "visible") raf = requestAnimationFrame(tick);
  }

  function tick(now) {
    raf = 0;
    const holding = blend?.hold && now - blend.start < blend.duration;
    if (playing && !holding) {
      // One slow frame never moves the animation more than half a second.
      const elapsedS = Math.min((now - lastTime) / 1000, 0.5);
      frame += elapsedS * FPS;
      const end = playOnce ? (options.playEndFrame ?? config.frames) : config.frames;
      if (playOnce && frame >= end) {
        frame = end;
        timeline.seek(frame);
        setPlaying(false);
        playOnce = false;
        draw(now);
        lastTime = now;
        options.onEnd?.();
        requestDraw();
        return;
      }
      frame %= config.frames;
      timeline.seek(frame);
    }
    lastTime = now;
    draw(now);
    if (playing || blend || exTween?.isActive()) requestDraw();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      cancelAnimationFrame(raf);
      raf = 0;
    } else {
      lastTime = performance.now();
      requestDraw();
    }
  });

  function setPlaying(value) {
    if (playing === value) return;
    playing = value;
    options.onPlayChange?.(playing);
  }

  // ---- reader control (the same feel on every animation piece) ----
  // A plain drag turns (left and right, round the point of the model under the screen centre)
  // and tilts (up and down); Ctrl + drag, a right-drag or two fingers move the model with the
  // grabbed spot glued to the pointer; the wheel or a pinch zooms toward the pointer. There is
  // no double-click zoom: a press and release within 4 px is a click and reads the model.
  //
  // All three keep one point of the model at one spot on the screen. After each step I slide the
  // camera's target across the screen plane until that point projects back onto its spot: two or
  // three Newton steps on the projection, which is exact at any tilt and in both cameras.
  function takeCamera(kind) {
    if (!user) user = copyView(currentView(performance.now()));
    blend = null;
    playOnce = false;
    setPlaying(false);
    options.onInteract?.(kind);
  }
  const MAX_PITCH = 100; // a block meant to be seen side-on: the walls show, little of the base
  const LOG_WIDTH = [3.5, 9.6]; // about 11 to 776 km across the frame
  const MIN_IN_VIEW_PX = 80; // a move stops before less than this much of the block shows
  // Dragging down tilts toward the side view (up to the limit), dragging up toward the top view.
  const tiltBy = (dy) => {
    user.camera.pitch = THREE.MathUtils.clamp(user.camera.pitch + dy * 0.3, 0, MAX_PITCH);
  };

  /** The block's outline in the scene: its top and base edges every km on both long sides. */
  function outlinePoints(ex) {
    const out = [];
    for (let km = 0; km <= L; km += 1) {
      for (const b of [0, corridorKm]) {
        const p = at(km, b);
        const hM = b === 0 ? profileHeight(km) : corridorHeight(km, b);
        out.push(new THREE.Vector3(p.x, (hM / 1000) * ex, p.y), new THREE.Vector3(p.x, 0, p.y));
      }
    }
    return out;
  }

  /** Screen position (CSS px) of a world point, seen by camera state cam. */
  function screenOf(cam, p) {
    placeCamera(cam);
    return toScreen(p);
  }

  /**
   * The point of the model under a screen position: on the block (its top, cut face or walls).
   * Where the ray misses the block, a turn takes the horizontal plane at the top of the model
   * (offBlock "top"), while a move or a zoom takes the plane through the camera's target, facing
   * the camera (offBlock "facing"): there is no spot of the model to hold there, and a point at
   * the target's depth moves with the pointer the way the model's middle does.
   */
  const gestureRay = new THREE.Raycaster();
  const gestureNdc = new THREE.Vector2();
  function modelPointAt(cam, sx, sy, offBlock = "top") {
    placeCamera(cam);
    gestureNdc.set((sx / viewSize.width) * 2 - 1, 1 - (sy / viewSize.height) * 2);
    gestureRay.setFromCamera(gestureNdc, activeCamera);
    const layersNow = user?.layers ?? lastView.layers;
    if (layersNow.corridor > 0.5) {
      const parts = layersNow.flatten < 0.5 ? [layers.terrain, layers.cut, layers.walls] : [layers.cut];
      const hit = gestureRay.intersectObjects(parts, false)[0];
      if (hit) return hit.point.clone();
    }
    // Off the block: the plane at the top of the model, unless that point lies far out toward
    // the horizon (where a tiny turn of the camera moves it a long way). Then the plane through
    // the camera's target, facing the camera, which always gives a steady point to hold.
    const ex = Math.max(layersNow.ex, 1e-3);
    const topY = ((config.model_top_m ?? 5000) / 1000) * ex;
    const centre = new THREE.Vector3(cam.tx, cam.ty, cam.tz);
    const reach = 2 * 2 ** cam.logWidth;
    const onTop = offBlock === "top" ? gestureRay.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -topY), new THREE.Vector3()) : null;
    if (onTop && onTop.distanceTo(centre) <= reach) return onTop;
    const facing = new THREE.Vector3();
    activeCamera.getWorldDirection(facing);
    return gestureRay.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(facing, centre), new THREE.Vector3());
  }

  /** Slide cam's target across the screen plane until world point p projects onto (sx, sy). */
  function glue(cam, p, sx, sy) {
    const b = THREE.MathUtils.degToRad(cam.bearing);
    const t = THREE.MathUtils.degToRad(cam.pitch);
    const right = [Math.cos(b), 0, Math.sin(b)];
    const upScreen = [Math.sin(b) * Math.cos(t), Math.sin(t), -Math.cos(b) * Math.cos(t)];
    const shift = (c, a, u) => ({
      ...c,
      tx: c.tx + right[0] * a + upScreen[0] * u,
      ty: c.ty + right[1] * a + upScreen[1] * u,
      tz: c.tz + right[2] * a + upScreen[2] * u,
    });
    let c = cam;
    for (let i = 0; i < 4; i += 1) {
      const [x, y] = screenOf(c, p);
      const ex = sx - x;
      const ey = sy - y;
      if (Math.hypot(ex, ey) < 0.05) break;
      // How the point moves on screen for 1 km of target shift along each direction.
      const step = 2 ** c.logWidth / 400;
      const [xr, yr] = screenOf(shift(c, step, 0), p);
      const [xu, yu] = screenOf(shift(c, 0, step), p);
      const j = [(xr - x) / step, (yr - y) / step, (xu - x) / step, (yu - y) / step];
      const det = j[0] * j[3] - j[2] * j[1];
      if (Math.abs(det) < 1e-9) break;
      c = shift(c, (ex * j[3] - ey * j[2]) / det, (ey * j[0] - ex * j[1]) / det);
    }
    const [x, y] = screenOf(c, p);
    // Only a solution that really puts the point on its spot is used.
    if (Math.hypot(sx - x, sy - y) > 0.5) return false;
    Object.assign(cam, { tx: c.tx, ty: c.ty, tz: c.tz });
    return true;
  }

  /**
   * How much of the block a camera state shows: the points of its outline that fall inside the
   * window (the same points blockOutline() gives), and how far they reach along the longer side.
   * A long, thin block on a phone counts as in view when 80 px of its length show.
   */
  function blockInView(cam) {
    placeCamera(cam);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const v of outlinePoints(Math.max(user.layers.ex, 1e-3))) {
      const [x, y, z] = toScreen(v);
      if (z < -1 || z > 1 || x < 0 || y < 0 || x > viewSize.width || y > viewSize.height) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    return x1 >= x0 ? Math.max(x1 - x0, y1 - y0) : 0;
  }

  /**
   * Move: put the grabbed point under (sx, sy), unless that would leave less than 80 px of the
   * block in view. A move that brings back more of the block always goes through, so a view that
   * already shows little (a steep tilt, a close zoom) can still be moved back.
   */
  function moveTo(grab, sx, sy) {
    const next = { ...user.camera };
    if (!glue(next, grab, sx, sy)) return;
    const after = blockInView(next);
    if (after >= MIN_IN_VIEW_PX || after > blockInView(user.camera)) Object.assign(user.camera, next);
  }

  /** Zoom by `steps` (log2 of the width) toward the screen position (sx, sy). */
  let zoomGrab = null; // { x, y, p, at }: reused while the wheel keeps turning at one spot
  function zoomAt(steps, sx, sy) {
    takeCamera("zoom");
    const now = performance.now();
    if (!zoomGrab || Math.hypot(zoomGrab.x - sx, zoomGrab.y - sy) > 2 || now - zoomGrab.at > 400) {
      const p = modelPointAt(user.camera, sx, sy, "facing");
      zoomGrab = p ? { x: sx, y: sy, p, at: now } : null;
    }
    user.camera.logWidth = THREE.MathUtils.clamp(user.camera.logWidth + steps, ...LOG_WIDTH);
    if (zoomGrab) {
      glue(user.camera, zoomGrab.p, sx, sy);
      zoomGrab.at = now;
    }
    requestDraw();
  }

  if (options.interactive !== false) {
    const canvas = renderer.domElement;
    const pointers = new Map();
    let pinchStart = 0;
    let dragging = false;
    let downAt = null;
    let pivot = null; // { p, x, y }: the point under the screen centre a turn keeps in place
    let grab = null; // the point a move or a two-finger gesture holds under the pointer
    const local = (event) => {
      const r = canvas.getBoundingClientRect();
      return [event.clientX - r.left, event.clientY - r.top];
    };
    const midpoint = () => {
      const [a, b] = [...pointers.values()];
      return [(a.lx + b.lx) / 2, (a.ly + b.ly) / 2];
    };
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("pointerdown", (event) => {
      options.onPointerDown?.();
      if (locked) return;
      // The main button (or a finger) turns and tilts and clicks; the right button, or the main
      // button with Ctrl, moves. The middle button does nothing.
      if (event.pointerType === "mouse" && event.button !== 0 && event.button !== 2) return;
      canvas.setPointerCapture(event.pointerId);
      const pan = event.pointerType === "mouse" && (event.button === 2 || event.ctrlKey);
      const [lx, ly] = local(event);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, lx, ly, button: event.button, pan });
      dragging = false;
      downAt = pointers.size === 1 ? { x: event.clientX, y: event.clientY } : null;
      pivot = null;
      grab = null;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    canvas.addEventListener("pointermove", (event) => {
      const last = pointers.get(event.pointerId);
      if (!last || locked) return;
      const dx = event.clientX - last.x;
      const dy = event.clientY - last.y;
      if (pointers.size === 2) {
        // Two fingers: the spot under their midpoint stays under it while they move and pinch.
        // The fingers report one at a time, so the spot is taken where the midpoint was before.
        const [mx0, my0] = midpoint();
        last.x = event.clientX;
        last.y = event.clientY;
        [last.lx, last.ly] = local(event);
        dragging = true;
        takeCamera("move");
        const [mx, my] = midpoint();
        grab ??= modelPointAt(user.camera, mx0, my0, "facing");
        const [a, b] = [...pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchStart > 0 && distance > 0) {
          user.camera.logWidth = THREE.MathUtils.clamp(user.camera.logWidth - Math.log2(distance / pinchStart), ...LOG_WIDTH);
        }
        pinchStart = distance;
        if (grab) moveTo(grab, mx, my);
        requestDraw();
        return;
      }
      if (!dragging && downAt && Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) < 4) return; // a click is not a drag
      dragging = true;
      last.x = event.clientX;
      last.y = event.clientY;
      [last.lx, last.ly] = local(event);
      if (last.pan || event.ctrlKey) {
        takeCamera("move");
        // The spot first grabbed stays glued to the cursor.
        grab ??= modelPointAt(user.camera, last.lx - dx, last.ly - dy, "facing");
        if (grab) moveTo(grab, last.lx, last.ly);
      } else {
        takeCamera("turn");
        // The point under the screen centre stays where it is on screen.
        if (!pivot) {
          const cx = viewSize.width / 2;
          const cy = viewSize.height / 2;
          const p = modelPointAt(user.camera, cx, cy);
          if (p) {
            const [x, y] = screenOf(user.camera, p);
            pivot = { p, x, y };
          }
        }
        user.camera.bearing -= dx * 0.3;
        tiltBy(dy);
        if (pivot) glue(user.camera, pivot.p, pivot.x, pivot.y);
      }
      requestDraw();
    });
    const release = (event) => {
      const down = pointers.get(event.pointerId);
      const wasClick = !locked && !dragging && pointers.size === 1 && downAt && event.type === "pointerup" && !down?.pan;
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinchStart = 0;
      if (pointers.size === 1) grab = null; // one finger left: a new gesture starts with it
      if (wasClick && event.button === 0) options.onClick?.(event.clientX, event.clientY);
      if (pointers.size === 0) {
        dragging = false;
        pivot = null;
        grab = null;
      }
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        if (locked) return;
        const px = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
        const [lx, ly] = local(event);
        zoomAt(px * 0.0015, lx, ly);
      },
      { passive: false },
    );
  }

  // ---- reading a height ----
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  /**
   * What lies under a click (CSS px). Only the block reads: its top, its cut face and its side
   * walls, all from the 30 m corridor heights loaded with the scene. The flat map round the
   * block does not read; a click there finds nothing.
   */
  function pick(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, 1 - ((clientY - rect.top) / rect.height) * 2);
    placeCamera(lastView.camera);
    raycaster.setFromCamera(ndc, activeCamera);
    const s = lastView.layers;
    const ex = Math.max(s.ex, 1e-3);
    const hits = [];
    if (s.corridor > 0.5) {
      if (s.flatten < 0.5) {
        const h = raycaster.intersectObject(layers.terrain, false)[0];
        if (h) hits.push({ distance: h.distance, kind: "corridor", point: h.point });
      }
      const c = raycaster.intersectObject(layers.cut, false)[0];
      if (c) hits.push({ distance: c.distance, kind: "cut", point: c.point });
      if (s.flatten < 0.5) {
        // The east wall and the two end walls: a wall reads the ground height on its top edge.
        const w = raycaster.intersectObject(layers.walls, false)[0];
        if (w) hits.push({ distance: w.distance, kind: "wall", point: w.point });
      }
    }
    hits.sort((a, b) => a.distance - b.distance);
    const hit = hits[0];
    if (!hit) return null;
    const rel = new THREE.Vector2(hit.point.x, hit.point.z).sub(S);
    const alongKm = rel.dot(U);
    const acrossKm = rel.dot(N);
    let heightM;
    let x = hit.point.x;
    let z = hit.point.z;
    if (hit.kind === "cut") {
      heightM = profileHeight(alongKm);
      const p = at(alongKm);
      x = p.x;
      z = p.y;
    } else {
      // The top or a side wall: the corridor height there (on a wall, at its top edge).
      heightM = corridorHeight(THREE.MathUtils.clamp(alongKm, 0, L), THREE.MathUtils.clamp(acrossKm, 0, corridorKm));
    }
    // Distance to the line itself (the segment, not its extension).
    const clamped = THREE.MathUtils.clamp(alongKm, 0, L);
    const offKm = Math.hypot(alongKm - clamped, hit.kind === "cut" ? 0 : acrossKm);
    const [lon, lat] = toLonLat(x, z);
    return {
      kind: hit.kind,
      x,
      z,
      heightM,
      yDrawn: (heightM / 1000) * ex,
      lon,
      lat,
      alongKm: offKm <= 0.5 ? clamped : null,
      source: "glo30",
    };
  }

  // ---- projection helpers for the page and the recorder ----
  const tmp = new THREE.Vector3();
  function toScreen(v) {
    tmp.copy(v).project(activeCamera);
    return [((tmp.x + 1) / 2) * viewSize.width, ((1 - tmp.y) / 2) * viewSize.height, tmp.z];
  }
  const drawnEx = () => Math.max(lastView?.layers.ex ?? 0, 1e-3);

  /** The start view: the whole block in the free rectangle, seen from the cut side. */
  function startViewCamera(sv = config.start_view) {
    const ex = sv.ex;
    const c = at(sv.along_km, corridorKm / 2);
    // The bearing faces the cut face; the target is the middle of the block.
    const cam = {
      tx: c.x,
      ty: 1.2 * ex,
      tz: c.y,
      logWidth: 8,
      pitch: sv.pitch,
      bearing: sv.bearing,
      persp: 1,
      ax: frameW / 2,
      ay: frameH / 2,
      sx0: 0,
      sy0: 0,
      sx1: frameW,
      sy1: frameH,
    };
    // Points that outline the block: its base corners and its top edges.
    const pts = [];
    for (const a of [0, L]) for (const b of [0, corridorKm]) {
      const p = at(a, b);
      pts.push(new THREE.Vector3(p.x, 0, p.y));
    }
    for (let k = 0; k < profile.km.length; k += 40) {
      const p = at(profile.km[k]);
      pts.push(new THREE.Vector3(p.x, (profile.h[k] / 1000) * ex, p.y));
      const q = at(profile.km[k], corridorKm);
      pts.push(new THREE.Vector3(q.x, (corridorHeight(profile.km[k], corridorKm) / 1000) * ex, q.y));
    }
    // Measure the outline on the 1080 x 1920 frame, then make it the subject part of the frame:
    // placeCamera fits that into the free rectangle of the window.
    const saved = { ...viewSize };
    viewSize.width = frameW;
    viewSize.height = frameH;
    placeCamera(cam, true);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of pts) {
      const [x, y] = toScreen(p);
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    Object.assign(viewSize, saved);
    const pad = 0.03 * (x1 - x0);
    Object.assign(cam, { sx0: x0 - pad, sx1: x1 + pad, sy0: y0 - pad, sy1: y1 + pad });
    if (lastView) placeCamera(lastView.camera);
    return cam;
  }

  function startLayers() {
    const s = Object.fromEntries(fields.map((k) => [k, 0]));
    // The map is dimmed under the finished model, so the block stands out from its floor.
    const base = config.start_view.base ?? 1;
    return { ...s, ex: config.start_view.ex, corridor: 1, base, base_west: 1, cursor_km: L };
  }

  // ---- build ----
  const ready = (async () => {
    const urls = options.urls;
    const [prof, corr, border, texture] = await Promise.all([
      loadJson(urls.profile),
      loadHeights(urls.corridor),
      loadJson(urls.border),
      new THREE.TextureLoader().loadAsync(urls.base),
    ]);
    profile = {
      km: Float32Array.from(prof.points, (p) => p[0]),
      h: Float32Array.from(prof.points, (p) => p[1]),
    };
    corridor = corr;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    buildBase(texture);
    buildBorder(border);
    buildMapLine();
    buildCorridor();
    buildCut();
    indicators = createIndicators(container, config, { labels: options.indicatorLabels !== false });

    timeline = createTimeline(config);
    fields = timeline.layerFields;
    frame = options.startFrame ?? 0;
    timeline.seek(frame);
    resize();
    if (!options.size) new ResizeObserver(() => (resize(), draw())).observe(container);
    // The page opens on the start view; the recorder on its frame.
    if (options.openOnStartView) user = { camera: startViewCamera(), layers: startLayers() };
    // Compile every shader before the first frame, so the first moving frame does not stall.
    corridorGroup.visible = true;
    renderer.compile(scene, perspective);
    draw();
    await indicators.fontsReady;
    draw();
    await document.fonts.ready;
    // Ready once the first full frame is on screen: two animation frames after drawing it.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })();

  return {
    ready,
    frames: config.frames,
    /** "explainer" (Play starts a guided animation) or "data-draw" (the data draws on load). */
    pageType: config.page_type,
    reducedMotion,
    /** Jump to a frame and draw it at once (the recorder uses this). */
    setFrame(value) {
      frame = value;
      user = null;
      blend = null;
      timeline.seek(frame);
      draw();
    },
    frame: () => frame,
    isPlaying: () => playing,
    /** Play on from the current frame; if the reader had the camera, glide back over 1 s. */
    play() {
      if (user) {
        blend = reducedMotion ? null : { from: user, to: null, start: performance.now(), duration: 1000 };
        user = null;
      }
      lastTime = performance.now();
      setPlaying(true);
      requestDraw();
    },
    /** Play from frame 0, after a 1 s eased move onto it. once: stop at options.playEndFrame. */
    playFromStart({ once = false, glide = true } = {}) {
      const from = copyView(currentView(performance.now()));
      exTween?.kill();
      frame = 0;
      timeline.seek(0);
      user = null;
      blend = reducedMotion || !glide ? null : { from, to: null, start: performance.now(), duration: 1000, hold: true };
      playOnce = once;
      lastTime = performance.now();
      setPlaying(true);
      requestDraw();
    },
    /** Stop the animation where it is (the page then eases back to the default view). */
    stop() {
      playOnce = false;
      setPlaying(false);
    },
    pause() {
      setPlaying(false);
    },
    /** Hand the model to the reader without moving it (stops the animation). */
    takeCamera: (kind = "click") => {
      takeCamera(kind);
      requestDraw();
    },
    /** Ease to the start view (camera and layers) over ms. */
    settle(ms = 1500, ex = config.start_view.ex) {
      const from = copyView(currentView(performance.now()));
      const to = { camera: startViewCamera(), layers: { ...startLayers(), ex } };
      playOnce = false;
      setPlaying(false);
      exTween?.kill();
      return new Promise((resolve) => {
        if (reducedMotion || ms <= 0) {
          blend = null;
          user = to;
          requestDraw();
          resolve();
        } else {
          user = null;
          blend = { from, to, start: performance.now(), duration: ms, done: resolve };
          requestDraw();
        }
      });
    },
    /** While locked, drag, zoom and click do nothing (the page plays the animation). */
    setLocked(value) {
      locked = value;
    },
    /** Start loading the map's height grid now, so the first click on the map reads at once. */
    /** Vertical exaggeration as drawn: 9 as in the slice, 1 is true height. */
    setExaggeration(n, ms = 800) {
      takeCamera("control");
      exTween?.kill();
      if (reducedMotion || ms <= 0) user.layers.ex = n;
      else exTween = gsap.to(user.layers, { ex: n, duration: ms / 1000, ease: "power2.inOut", onUpdate: requestDraw });
      requestDraw();
    },
    /** The layer values as last drawn (the page's scale reads the exaggeration from here). */
    viewLayers: () => ({ ...(lastView?.layers ?? timeline.state) }),
    inUserMode: () => Boolean(user || blend?.to),
    pick,
    /** Screen position (CSS px) of a point `km` along the line at `heightM` true metres. */
    projectAlong(km, heightM, acrossKm = 0) {
      const p = at(km, acrossKm);
      return toScreen(new THREE.Vector3(p.x, (heightM / 1000) * drawnEx(), p.y));
    },
    /** Frame position (1080 x 1920 px) of a point `km` along the line at `heightM` true metres,
     * seen by any numeric camera at exaggeration ex. Used to fit camera keys to a storyboard. */
    projectOnFrame(cam, km, heightM, ex, acrossKm = 0) {
      const saved = { ...viewSize };
      viewSize.width = frameW;
      viewSize.height = frameH;
      placeCamera(cam, true);
      const p = at(km, acrossKm);
      const out = toScreen(new THREE.Vector3(p.x, (heightM / 1000) * ex, p.y));
      Object.assign(viewSize, saved);
      if (lastView) placeCamera(lastView.camera);
      return out;
    },
    /** Scene x, z of a point along the line, and lon/lat of scene x, z. */
    alongXZ: (km, acrossKm = 0) => at(km, acrossKm).toArray(),
    toLonLat,
    /** Screen position of scene x, z at a drawn height in km. */
    projectXZ: (x, yDrawn, z) => toScreen(new THREE.Vector3(x, yDrawn, z)),
    profileHeight: (km) => profileHeight(km),
    profileSamples: () => profile,
    length: L,
    /** The top edge of the cut face on screen, sampled every `stepKm`. */
    cutTop(stepKm = 1) {
      const out = [];
      const ex = drawnEx();
      for (let km = 0; km <= L; km += stepKm) {
        const p = at(km);
        out.push(toScreen(new THREE.Vector3(p.x, (profileHeight(km) / 1000) * ex, p.y)));
      }
      return out;
    },
    /** The outline of the block on screen: base corners, the cut face top and the far top edge. */
    blockOutline() {
      return outlinePoints(drawnEx()).map((v) => toScreen(v));
    },
    /**
     * The end walls' height ticks at their front corners (the ends of the cut face), on screen,
     * for the walls that face the camera: { value, x, y, dx } with dx the screen direction away
     * from the block, so a label can sit outside it.
     */
    wallTicks() {
      const ex = drawnEx();
      const out = [];
      for (const [km, outward] of [[0, -1], [L, 1]]) {
        const facing = -(forward.x * U.x + forward.z * U.y) * outward;
        if (facing < 0.2) continue;
        const cornerM = profileHeight(km);
        const p = at(km);
        for (const hM of look.ticks_m) {
          if (hM > cornerM) continue;
          const a = toScreen(new THREE.Vector3(p.x, (hM / 1000) * ex, p.y));
          const q = at(km + outward * 3);
          const b = toScreen(new THREE.Vector3(q.x, (hM / 1000) * ex, q.y));
          out.push({ value: hM, x: a[0], y: a[1], dx: Math.sign(b[0] - a[0]) || outward });
        }
      }
      return out;
    },
    /** The point of the model under a screen position (CSS px) in the view as drawn, as
     * [x, y, z] in scene units, or null: what a turn, a move or a zoom holds in place there. */
    pointAt(sx, sy, gesture = "move") {
      const cam = user?.camera ?? lastView.camera;
      const p = modelPointAt({ ...cam }, sx, sy, gesture === "turn" ? "top" : "facing");
      placeCamera(lastView.camera);
      return p ? [p.x, p.y, p.z] : null;
    },
    /** Where north points on screen and how many px one km covers at the middle of the line. */
    groundScale() {
      const m = at(L / 2, corridorKm / 2);
      const a = new THREE.Vector3(m.x, 0, m.y);
      const p0 = toScreen(a);
      const pn = toScreen(a.clone().add(new THREE.Vector3(0, 0, -10)));
      // Measure the km scale across the screen at that point, whatever the camera turn.
      const right = new THREE.Vector3(Math.cos(THREE.MathUtils.degToRad(lastView.camera.bearing)), 0,
        Math.sin(THREE.MathUtils.degToRad(lastView.camera.bearing)));
      const pr = toScreen(a.clone().addScaledVector(right, 10));
      return {
        northDeg: (Math.atan2(pn[0] - p0[0], -(pn[1] - p0[1])) * 180) / Math.PI,
        pxPerKm: Math.hypot(pr[0] - p0[0], pr[1] - p0[1]) / 10,
        // A top view or a level side view: a km bar is true. A steep oblique view is not.
        pitch: lastView.camera.pitch,
        bearing: lastView.camera.bearing,
        target: { tx: lastView.camera.tx, ty: lastView.camera.ty, tz: lastView.camera.tz },
        persp: lastView.camera.persp,
      };
    },
    /** Request a redraw (after the page changed something the scene reads, like the window). */
    redraw: () => requestDraw(),
    /** The numbers that decide the picture at a frame, to spot frames identical to the last. */
    stateKey(value) {
      const s = timeline.seek(value);
      return JSON.stringify(s, (k, v) => (k === "_gsap" ? undefined : typeof v === "number" ? Math.round(v * 1e5) / 1e5 : v));
    },
  };
}
