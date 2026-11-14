/**
 * The 3D model: mainland Norway as a closed relief block, with the hydropower plants lighting up
 * on it and the 300 and 420 kV lines drawing themselves over the ridges.
 *
 * createScene(container, options) draws the model only, with no text and no page furniture, and
 * returns { ready, setFrame(frame, { camera }), play(), stop(), frames, pageType, ... }. The page
 * in index.html adds the title, legend, labels and buttons around it.
 *
 * options.config   the parsed layers/scene.json (grid, cameras, timing, look, label points)
 * options.place    { crs, grid, points, urls: { heights, relief, plants, lines } }. Defaults to
 *                  the place in config. The next "Infrastructure" episode passes a new place (a
 *                  new grid in a new projected CRS) and new layers; nothing else changes.
 * options.mode     "page" (the reader holds the camera, exaggeration 9) or "reel" (the camera
 *                  and the exaggeration follow the reel track)
 * options.size     [width, height] in CSS pixels for a fixed-size canvas; default: the container
 * options.pixelRatio, options.interactive, options.preserveDrawingBuffer
 * options.onDraw(), options.onInteract(kind), options.onClick(x, y), options.onEnd()
 * options.initialView()  returns the page's first camera (called once the model is built)
 *
 * Units: one scene unit is one kilometre. x points east, z points south (grid north is -z), y
 * points up. The origin is the centre of the grid at sea level. Heights are drawn
 * `exaggeration` times taller than they are.
 */

import * as THREE from "three";
import { FPS, cameraState, createTimeline } from "./timeline.js";

// The colours in the layers are sRGB values, and every shader here writes them straight to the
// canvas. Turning three.js colour management off keeps them exact: no conversion on the way in
// or out, so the Ink of the background is the Ink of the baked sea.
THREE.ColorManagement.enabled = false;

// The 9:16 frame the reel track's camera is composed for, and the vertical field of view of the perspective
// camera in that frame. A narrow lens keeps the look close to the storyboard's orthographic
// oblique view while still giving depth when the camera tilts.
const FRAME_ASPECT = 1080 / 1920;
const FOV_FRAME_DEG = 25;
// The slab under the relief, in scene km: deep enough to read as a model on the Ink ground.
const BASE_DEPTH_KM = 60;
// Lines float this high above the surface (before exaggeration), so they never sink into it,
// and are cut into pieces of at most this length so they follow the relief between vertices.
const LINE_LIFT_M = 300;
const DENSIFY_KM = 0.5;
// The mesh: at most about 640 x 800 vertices, plenty for a 1 km grid seen as a whole.
const MESH_MAX_VERTICES = [640, 800];
// Mark sizes at the reel track's wide view (storyboard frame 3) on the 1080 px frame.
const LARGEST_PLANT_PX = 30;
const SMALLEST_PLANT_PX = 5;
const MIN_PLANT_PX = 3;
const LINE_CORE_PX = 2.5;
const LINE_GLOW_FACTOR = 4;
const HEAD_KM = 14; // the bright head at the drawing front
const WALL_SHADE = 0.82; // walls 18 % darker than the top
const HAZE_MAX = 0.55;
const MAX_PITCH_DEG = 75;
const HIT_PX = 12; // the click area around a disc or a line
const LOG_WIDTH_RANGE = [Math.log2(30), Math.log2(3000)];

const deg = THREE.MathUtils.degToRad;
const clamp = THREE.MathUtils.clamp;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** "#rrggbb" as sRGB components 0..1. */
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const vec3 = (hex) => new THREE.Vector3(...rgb(hex));

/** The height ramp exactly as prepare.py bakes it into the top texture. */
function makeRamp(look) {
  const stops = look.height_ramp.map(rgb);
  const [lo, hi] = look.height_ramp_domain_m;
  return (heightM) => {
    const h = clamp((heightM - lo) / (hi - lo), 0, 1);
    const pos = 0.18 + 0.82 * h ** 0.7;
    const scaled = pos * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(scaled));
    const t = scaled - i;
    return stops[i].map((c, k) => c * (1 - t) + stops[i + 1][k] * t);
  };
}

/** Load a Terrarium PNG and decode it to heights in metres. */
async function loadHeights(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not load ${url}: ${response.status}`);
  // No colour conversion and no premultiplied alpha: the RGB bytes are data, not colour.
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
    heights[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
  }
  return { heights, width: bitmap.width, height: bitmap.height };
}

async function loadJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not load ${url}: ${response.status}`);
  return response.json();
}

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, resolve, undefined, () => reject(new Error(`could not load ${url}`)));
  });
}

/**
 * Grid coordinates (EPSG metres) to longitude and latitude, for a UTM grid on GRS80, which is
 * what ETRS89 / UTM uses. The inverse transverse Mercator series (Snyder 1987, p. 63) is good to
 * well under a metre across a zone and its neighbours.
 */
export function utmToLonLat(xM, yM, centralMeridianDeg) {
  const a = 6378137;
  const f = 1 / 298.257222101;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const m = yM / k0;
  const mu = m / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu);
  const c1 = ep2 * Math.cos(phi1) ** 2;
  const t1 = Math.tan(phi1) ** 2;
  const n1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2);
  const r1 = (a * (1 - e2)) / (1 - e2 * Math.sin(phi1) ** 2) ** 1.5;
  const d = (xM - 500000) / (n1 * k0);
  const lat =
    phi1 -
    ((n1 * Math.tan(phi1)) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6) / 720);
  const lon =
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5) / 120) /
    Math.cos(phi1);
  return [centralMeridianDeg + THREE.MathUtils.radToDeg(lon), THREE.MathUtils.radToDeg(lat)];
}

// ---------------------------------------------------------------- shaders
// The top: the baked relief texture, a light that only grows with the exaggeration (the baked
// hillshade already shades the flat model), and a haze toward Ink with distance.
const TOP_VERTEX = /* glsl */ `
  uniform float uEx;
  attribute vec2 aGrad;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying float vDist;
  void main() {
    vUv = uv;
    vec3 p = vec3(position.x, position.y * uEx, position.z);
    vNormal = normalize(vec3(-aGrad.x * uEx, 1.0, -aGrad.y * uEx));
    vec4 world = modelMatrix * vec4(p, 1.0);
    vDist = distance(world.xyz, cameraPosition);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const TOP_FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uInk;
  uniform vec3 uLight;
  uniform float uRelief;
  uniform vec3 uHaze;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying float vDist;
  void main() {
    vec3 c = texture2D(uMap, vUv).rgb;
    float lambert = max(dot(normalize(vNormal), uLight), 0.0) / uLight.y;
    c *= clamp(mix(1.0, lambert, uRelief), 0.45, 1.5);
    c = mix(c, uInk, smoothstep(uHaze.x, uHaze.y, vDist) * uHaze.z);
    gl_FragColor = vec4(c, 1.0);
  }
`;
// The walls and the base: the ramp colour of each edge cell, 18 % darker, down to the slab.
const WALL_VERTEX = /* glsl */ `
  uniform float uEx;
  uniform float uBase;
  attribute float aTop;
  varying vec3 vColour;
  varying float vDist;
  void main() {
    vColour = color;
    vec3 p = vec3(position.x, aTop > 0.5 ? position.y * uEx : -uBase, position.z);
    vec4 world = modelMatrix * vec4(p, 1.0);
    vDist = distance(world.xyz, cameraPosition);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const WALL_FRAGMENT = /* glsl */ `
  uniform vec3 uInk;
  uniform vec3 uHaze;
  varying vec3 vColour;
  varying float vDist;
  void main() {
    gl_FragColor = vec4(mix(vColour, uInk, smoothstep(uHaze.x, uHaze.y, vDist) * uHaze.z), 1.0);
  }
`;
// The plants: one instanced quad each, sized in screen pixels, lit up by comparing the
// instance's light time with one clock uniform. The whole light-up is one number per frame.
const PLANT_VERTEX = /* glsl */ `
  uniform float uEx;
  uniform float uTime;
  uniform float uPopFrames;
  uniform float uScale;
  uniform float uPulse;
  uniform vec2 uPxToNdc;
  attribute vec3 aCentre;
  attribute float aSize;
  attribute float aLight;
  varying vec2 vLocal;
  varying float vCore;
  varying float vHalo;
  varying float vPulse;
  void main() {
    // Frames since this plant's light time: hidden before, then 0 to 1.15 to 1 over 6 frames.
    float p = (uTime - aLight) * ${FPS.toFixed(1)};
    float rise = uPopFrames * 2.0 / 3.0;
    float s = p < 0.0 ? 0.0
      : p < rise ? 1.15 * (1.0 - pow(1.0 - p / rise, 2.0))
      : p < uPopFrames ? mix(1.15, 1.0, (p - rise) / (uPopFrames - rise))
      : 1.0;
    vPulse = sin(3.14159265 * uPulse);
    float core = max(aSize * uScale, ${MIN_PLANT_PX.toFixed(1)}) * s;
    float halo = core * 2.0 * (1.0 + 0.3 * vPulse);
    float quad = halo * 0.5 + 1.5;
    vec4 clip = projectionMatrix * viewMatrix * vec4(aCentre.x, aCentre.y * uEx, aCentre.z, 1.0);
    clip.xy += position.xy * quad * uPxToNdc * clip.w;
    vLocal = position.xy * quad;
    vCore = core * 0.5;
    vHalo = halo * 0.5;
    gl_Position = s > 0.0 ? clip : vec4(2.0, 2.0, 2.0, 1.0);
  }
`;
const PLANT_FRAGMENT = /* glsl */ `
  uniform vec3 uColour;
  uniform float uOpacity;
  varying vec2 vLocal;
  varying float vCore;
  varying float vHalo;
  varying float vPulse;
  void main() {
    float r = length(vLocal);
    float core = 1.0 - smoothstep(vCore - 0.6, vCore + 0.6, r);
    float halo = (0.15 + 0.1 * vPulse) * (1.0 - smoothstep(vHalo * 0.6, vHalo, r));
    float a = max(core, halo) * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColour, a);
  }
`;
// The lines: ribbons a fixed number of pixels wide, built in screen space from each vertex and
// its neighbours. aDist is the length drawn before this vertex, over all lines in draw order,
// so one uniform (uDrawKm) shows the network up to the drawing front.
const LINE_VERTEX = /* glsl */ `
  uniform float uEx;
  uniform vec2 uViewport;
  uniform float uHalfWidth;
  attribute vec3 aPrev;
  attribute vec3 aNext;
  attribute float aSide;
  attribute float aDist;
  varying float vAcross;
  varying float vDist;
  vec4 toClip(vec3 p) {
    return projectionMatrix * viewMatrix * vec4(p.x, p.y * uEx, p.z, 1.0);
  }
  void main() {
    vec4 c = toClip(position);
    vec2 halfVp = uViewport * 0.5;
    vec2 sc = c.xy / c.w * halfVp;
    vec2 sa = toClip(aPrev).xy / toClip(aPrev).w * halfVp;
    vec2 sb = toClip(aNext).xy / toClip(aNext).w * halfVp;
    vec2 d1 = sc - sa;
    vec2 d2 = sb - sc;
    vec2 t1 = length(d1) > 1e-4 ? normalize(d1) : normalize(d2 + 1e-6);
    vec2 t2 = length(d2) > 1e-4 ? normalize(d2) : t1;
    vec2 tangent = normalize(t1 + t2 + 1e-6);
    vec2 normal = vec2(-tangent.y, tangent.x);
    // A mitre join, limited so a sharp turn never throws out a spike.
    float mitre = 1.0 / max(dot(normal, vec2(-t1.y, t1.x)), 0.6);
    c.xy += normal * aSide * uHalfWidth * mitre / halfVp * c.w;
    c.z -= 0.0006 * c.w;
    vAcross = aSide;
    vDist = aDist;
    gl_Position = c;
  }
`;
const LINE_FRAGMENT = /* glsl */ `
  uniform vec3 uColour;
  uniform float uOpacity;
  uniform float uDrawKm;
  uniform float uHeadKm;
  uniform float uHeadOn;
  uniform float uHalfWidth;
  uniform float uCoreHalf;
  varying float vAcross;
  varying float vDist;
  void main() {
    // Nothing drawn yet means nothing at all, not even the first vertex at length 0.
    if (vDist > uDrawKm || uDrawKm <= 0.0) discard;
    float d = abs(vAcross) * uHalfWidth;
    float head = uHeadOn * (1.0 - smoothstep(0.0, uHeadKm, uDrawKm - vDist));
    float core = 1.0 - smoothstep(uCoreHalf - 0.5, uCoreHalf + 0.5, d);
    float glow = 1.0 - smoothstep(uCoreHalf, uHalfWidth, d);
    float a = max(core * 0.95, glow * glow * (0.12 + 0.45 * head)) * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColour, a);
  }
`;
// The two cities: small Paper dots with an Ink rim.
const MARKER_VERTEX = /* glsl */ `
  uniform float uEx;
  uniform vec2 uPxToNdc;
  attribute vec3 aCentre;
  varying vec2 vLocal;
  void main() {
    float quad = 7.0;
    vec4 clip = projectionMatrix * viewMatrix * vec4(aCentre.x, aCentre.y * uEx, aCentre.z, 1.0);
    clip.xy += position.xy * quad * uPxToNdc * clip.w;
    vLocal = position.xy * quad;
    gl_Position = clip;
  }
`;
const MARKER_FRAGMENT = /* glsl */ `
  uniform vec3 uPaper;
  uniform vec3 uInk;
  uniform float uCities;
  varying vec2 vLocal;
  void main() {
    float r = length(vLocal);
    float inDot = 1.0 - smoothstep(2.9, 4.1, r);
    float inRim = 1.0 - smoothstep(4.4, 5.6, r);
    float a = inRim * uCities;
    if (a < 0.004) discard;
    gl_FragColor = vec4(mix(uInk, uPaper, inDot), a);
  }
`;

/** A quad from (-1, -1) to (1, 1) for instanced screen-space marks. */
function instancedQuad(count) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.instanceCount = count;
  return geometry;
}

export function createScene(container, options = {}) {
  const config = options.config;
  const place = options.place ?? {
    crs: config.crs,
    centralMeridian: config.central_meridian,
    grid: config.grid,
    points: config.points,
    urls: {
      heights: "layers/heights.png",
      relief: "layers/relief.webp",
      plants: "layers/plants.json",
      lines: "layers/lines.json",
    },
  };
  const look = config.look;
  const mode = options.mode ?? "page";
  const pageEx = config.page.default_view.exaggeration;
  const ramp = makeRamp(look);
  const ink = rgb(look.background);

  // ---- the grid in scene km ----
  const grid = place.grid;
  const gx = grid.x_m.map((v) => v / 1000);
  const gy = grid.y_m.map((v) => v / 1000);
  const centre = [(gx[0] + gx[1]) / 2, (gy[0] + gy[1]) / 2];
  const toSceneX = (xKm) => xKm - centre[0];
  const toSceneZ = (yKm) => -(yKm - centre[1]);
  const fromScene = (X, Z) => [X + centre[0], centre[1] - Z];

  // ---- renderer ----
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pixelRatio = options.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2);
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
    preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
  });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // the values are sRGB already
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(new THREE.Color(...ink), 1);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV_FRAME_DEG, FRAME_ASPECT, 1, 10000);
  const view = { width: 1, height: 1 };

  // Light from the azimuth and altitude in scene.json, in scene axes (north is -z).
  const az = deg(look.light.azimuth_deg);
  const alt = deg(look.light.altitude_deg);
  const lightDir = new THREE.Vector3(Math.cos(alt) * Math.sin(az), Math.sin(alt), -Math.cos(alt) * Math.cos(az));
  const hazeUniform = { value: new THREE.Vector3(1e9, 2e9, 0) };
  const inkUniform = { value: new THREE.Vector3(...ink) };
  const exUniform = { value: 0 };
  const pxToNdc = { value: new THREE.Vector2(1, 1) };
  const viewportUniform = { value: new THREE.Vector2(1, 1) };

  // ---- state filled in by ready ----
  let fine = null; // the 1 km heights, for readings
  let mesh = null; // { heights, cols, rows, step, x0, y1 } the downsampled mesh grid
  let plants = [];
  let lines = [];
  let totalLineKm = 1;
  let landSamples = [];
  let timeline = null;
  let topMaterial = null;
  let wallMaterial = null;
  let plantMaterial = null;
  let lineMaterial = null;
  let markerMaterial = null;

  /** Bilinear height in metres from the 1 km grid at grid km (cell centres), 0 outside. */
  function heightAt(xKm, yKm) {
    if (!fine) return 0;
    const cell = grid.height_cell_m / 1000;
    const c = (xKm - gx[0]) / cell - 0.5;
    const r = (gy[1] - yKm) / cell - 0.5;
    return bilinear(fine.heights, fine.width, fine.height, c, r);
  }
  /** Bilinear height in metres on the mesh's own grid: what the reader sees at that point. */
  function meshHeightAt(xKm, yKm) {
    if (!mesh) return 0;
    const c = (xKm - mesh.x0) / mesh.step;
    const r = (mesh.y1 - yKm) / mesh.step;
    return bilinear(mesh.heights, mesh.cols, mesh.rows, c, r);
  }
  function bilinear(values, w, h, c, r) {
    if (c < 0 || r < 0 || c > w - 1 || r > h - 1) return 0;
    const c0 = Math.min(w - 2, Math.floor(c));
    const r0 = Math.min(h - 2, Math.floor(r));
    const tc = c - c0;
    const tr = r - r0;
    const v = (cc, rr) => values[rr * w + cc];
    return (
      (v(c0, r0) * (1 - tc) + v(c0 + 1, r0) * tc) * (1 - tr) +
      (v(c0, r0 + 1) * (1 - tc) + v(c0 + 1, r0 + 1) * tc) * tr
    );
  }

  // ---------------------------------------------------------------- building the model
  /** Average the 1 km heights down to the mesh grid (blocks of step x step cells). */
  function downsample(source) {
    const f = Math.max(
      1,
      Math.ceil(source.width / MESH_MAX_VERTICES[0]),
      Math.ceil(source.height / MESH_MAX_VERTICES[1]),
    );
    const cols = Math.floor(source.width / f);
    const rows = Math.floor(source.height / f);
    const heights = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        let sum = 0;
        for (let dr = 0; dr < f; dr += 1) {
          for (let dc = 0; dc < f; dc += 1) sum += source.heights[(r * f + dr) * source.width + c * f + dc];
        }
        heights[r * cols + c] = sum / (f * f);
      }
    }
    const cell = (grid.height_cell_m / 1000) * f;
    // Each mesh vertex sits at the centre of its block.
    return { heights, cols, rows, step: cell, x0: gx[0] + cell / 2, y1: gy[1] - cell / 2 };
  }

  function buildTop(texture) {
    const { cols, rows, heights, step, x0, y1 } = mesh;
    const positions = new Float32Array(cols * rows * 3);
    const uvs = new Float32Array(cols * rows * 2);
    const grads = new Float32Array(cols * rows * 2);
    const h = (c, r) => heights[clamp(r, 0, rows - 1) * cols + clamp(c, 0, cols - 1)] / 1000;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const i = r * cols + c;
        const xKm = x0 + c * step;
        const yKm = y1 - r * step;
        positions[i * 3] = toSceneX(xKm);
        positions[i * 3 + 1] = h(c, r);
        positions[i * 3 + 2] = toSceneZ(yKm);
        uvs[i * 2] = (xKm - gx[0]) / (gx[1] - gx[0]);
        uvs[i * 2 + 1] = (yKm - gy[0]) / (gy[1] - gy[0]);
        // Slopes in km per km along +x (east) and +z (south, the way the rows run).
        grads[i * 2] = (h(c + 1, r) - h(c - 1, r)) / (2 * step);
        grads[i * 2 + 1] = (h(c, r + 1) - h(c, r - 1)) / (2 * step);
      }
    }
    const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
    let k = 0;
    for (let r = 0; r < rows - 1; r += 1) {
      for (let c = 0; c < cols - 1; c += 1) {
        const a = r * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        index.set([a, d, b, b, d, e], k);
        k += 6;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute("aGrad", new THREE.BufferAttribute(grads, 2));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    texture.colorSpace = THREE.NoColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    topMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uEx: exUniform,
        uInk: inkUniform,
        uLight: { value: lightDir },
        uRelief: { value: 0 },
        uHaze: hazeUniform,
      },
      vertexShader: TOP_VERTEX,
      fragmentShader: TOP_FRAGMENT,
    });
    const top = new THREE.Mesh(geometry, topMaterial);
    top.frustumCulled = false;
    top.renderOrder = 0;
    scene.add(top);
  }

  function buildWalls() {
    const { cols, rows, heights, step, x0, y1 } = mesh;
    const positions = [];
    const colours = [];
    const tops = [];
    const indices = [];
    const bottomColour = rgb(look.height_ramp[0]).map((v) => v * WALL_SHADE * 0.9);
    const addWall = (cells) => {
      const start = positions.length / 3;
      for (const [c, r] of cells) {
        const hM = heights[r * cols + c];
        const X = toSceneX(x0 + c * step);
        const Z = toSceneZ(y1 - r * step);
        positions.push(X, hM / 1000, Z, X, 0, Z);
        // Sea and neighbours at 0 m take the darkest ramp stop, so the walls stay close to Ink
        // there and only lift where land reaches the edge of the grid.
        const edge = hM < 1 ? rgb(look.height_ramp[0]) : ramp(hM);
        colours.push(...edge.map((v) => v * WALL_SHADE), ...bottomColour);
        tops.push(1, 0);
      }
      for (let i = 0; i < cells.length - 1; i += 1) {
        const a = start + i * 2;
        indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
    };
    const range = (n) => Array.from({ length: n }, (_, i) => i);
    addWall(range(cols).map((c) => [c, 0])); // north
    addWall(range(cols).map((c) => [c, rows - 1])); // south
    addWall(range(rows).map((r) => [0, r])); // west
    addWall(range(rows).map((r) => [cols - 1, r])); // east
    // The base: one dark quad under the slab.
    const start = positions.length / 3;
    const corners = [[0, 0], [cols - 1, 0], [cols - 1, rows - 1], [0, rows - 1]];
    for (const [c, r] of corners) {
      positions.push(toSceneX(x0 + c * step), 0, toSceneZ(y1 - r * step));
      colours.push(...bottomColour.map((v) => v * 0.85));
      tops.push(0);
    }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
    geometry.setAttribute("aTop", new THREE.Float32BufferAttribute(tops, 1));
    geometry.setIndex(indices);
    wallMaterial = new THREE.ShaderMaterial({
      uniforms: { uEx: exUniform, uBase: { value: BASE_DEPTH_KM }, uInk: inkUniform, uHaze: hazeUniform },
      vertexShader: WALL_VERTEX,
      fragmentShader: WALL_FRAGMENT,
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    const walls = new THREE.Mesh(geometry, wallMaterial);
    walls.frustumCulled = false;
    walls.renderOrder = 1;
    scene.add(walls);
  }

  function buildPlants() {
    const geometry = instancedQuad(plants.length);
    const largest = plants[0].capacity_mw;
    const centres = new Float32Array(plants.length * 3);
    const sizes = new Float32Array(plants.length);
    plants.forEach((p, i) => {
      const xKm = p.x / 1000;
      const yKm = p.y / 1000;
      p.xKm = xKm;
      p.yKm = yKm;
      centres.set([toSceneX(xKm), meshHeightAt(xKm, yKm) / 1000, toSceneZ(yKm)], i * 3);
      // Area by capacity: the diameter grows with the square root.
      sizes[i] = Math.max(SMALLEST_PLANT_PX, LARGEST_PLANT_PX * Math.sqrt(p.capacity_mw / largest));
    });
    geometry.setAttribute("aCentre", new THREE.InstancedBufferAttribute(centres, 3));
    geometry.setAttribute("aSize", new THREE.InstancedBufferAttribute(sizes, 1));
    geometry.setAttribute("aLight", new THREE.InstancedBufferAttribute(timeline.lightTimes, 1));
    plantMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uEx: exUniform,
        uTime: { value: 0 },
        uPopFrames: { value: timeline.popFrames },
        uScale: { value: 1 },
        uPulse: { value: 0 },
        uPxToNdc: pxToNdc,
        uColour: { value: vec3(look.plants) },
        uOpacity: { value: 1 },
      },
      vertexShader: PLANT_VERTEX,
      fragmentShader: PLANT_FRAGMENT,
      transparent: true,
      depthTest: false, // drawn on top: a ridge never hides a plant
      depthWrite: false,
    });
    const mark = new THREE.Mesh(geometry, plantMaterial);
    mark.frustumCulled = false;
    mark.renderOrder = 2;
    scene.add(mark);
  }

  function buildLines(data) {
    const positions = [];
    const prevs = [];
    const nexts = [];
    const sides = [];
    const dists = [];
    const indices = [];
    let drawn = 0;
    lines = [];
    for (const line of data.lines) {
      // Densify: cut every segment into pieces of at most 0.5 km, so the ribbon follows the
      // relief between the simplified vertices instead of cutting through hills.
      const pts = [];
      const coords = line.coords.map(([x, y]) => [x / 1000, y / 1000]);
      for (let i = 0; i < coords.length - 1; i += 1) {
        const [ax, ay] = coords[i];
        const [bx, by] = coords[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / DENSIFY_KM));
        for (let k = 0; k < n; k += 1) pts.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
      }
      pts.push(coords.at(-1));
      const start = positions.length / 3;
      const startKm = drawn;
      const scenePts = pts.map(([x, y]) => [toSceneX(x), (meshHeightAt(x, y) + LINE_LIFT_M) / 1000, toSceneZ(y)]);
      scenePts.forEach((p, i) => {
        if (i > 0) drawn += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        const prev = scenePts[Math.max(0, i - 1)];
        const next = scenePts[Math.min(scenePts.length - 1, i + 1)];
        for (const side of [-1, 1]) {
          positions.push(...p);
          prevs.push(...prev);
          nexts.push(...next);
          sides.push(side);
          dists.push(drawn);
        }
        if (i < scenePts.length - 1) {
          const a = start + i * 2;
          indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      });
      lines.push({ kv: line.kv, coords, startKm, endKm: drawn });
    }
    totalLineKm = drawn;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("aPrev", new THREE.Float32BufferAttribute(prevs, 3));
    geometry.setAttribute("aNext", new THREE.Float32BufferAttribute(nexts, 3));
    geometry.setAttribute("aSide", new THREE.Float32BufferAttribute(sides, 1));
    geometry.setAttribute("aDist", new THREE.Float32BufferAttribute(dists, 1));
    geometry.setIndex(indices);
    lineMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uEx: exUniform,
        uViewport: viewportUniform,
        uHalfWidth: { value: (LINE_CORE_PX * LINE_GLOW_FACTOR) / 2 },
        uCoreHalf: { value: LINE_CORE_PX / 2 },
        uColour: { value: vec3(look.lines) },
        uOpacity: { value: 1 },
        uDrawKm: { value: 0 },
        uHeadKm: { value: HEAD_KM },
        uHeadOn: { value: 1 },
      },
      vertexShader: LINE_VERTEX,
      fragmentShader: LINE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      // The ribbon's winding depends on which way the line runs on screen: draw both faces.
      side: THREE.DoubleSide,
    });
    const ribbons = new THREE.Mesh(geometry, lineMaterial);
    ribbons.frustumCulled = false;
    ribbons.renderOrder = 3;
    scene.add(ribbons);
  }

  function buildMarkers() {
    const points = [place.points.oslo, place.points.bergen];
    const geometry = instancedQuad(points.length);
    const centres = new Float32Array(points.length * 3);
    points.forEach((p, i) => {
      const xKm = p.xy[0] / 1000;
      const yKm = p.xy[1] / 1000;
      centres.set([toSceneX(xKm), meshHeightAt(xKm, yKm) / 1000, toSceneZ(yKm)], i * 3);
    });
    geometry.setAttribute("aCentre", new THREE.InstancedBufferAttribute(centres, 3));
    markerMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uEx: exUniform,
        uPxToNdc: pxToNdc,
        uCities: { value: 0 },
        uPaper: { value: vec3(look.cities) },
        uInk: inkUniform,
      },
      vertexShader: MARKER_VERTEX,
      fragmentShader: MARKER_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const marks = new THREE.Mesh(geometry, markerMaterial);
    marks.frustumCulled = false;
    marks.renderOrder = 4;
    scene.add(marks);
  }

  /** Land points every 10 km (with their height), to fit the whole mainland into a view. */
  function sampleLand() {
    const out = [];
    const every = Math.max(1, Math.round(10 / mesh.step));
    for (let r = 0; r < mesh.rows; r += every) {
      for (let c = 0; c < mesh.cols; c += every) {
        const hM = mesh.heights[r * mesh.cols + c];
        if (hM > 1) out.push([mesh.x0 + c * mesh.step, mesh.y1 - r * mesh.step, hM]);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- the camera
  const target = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const up = new THREE.Vector3();
  let ex = mode === "reel" ? 0 : pageEx;
  let kmPerPx = 1;

  /**
   * Place the camera for a camera state { x, y, logWidth, pitch, bearing, shiftX, shiftY }.
   *
   * The width is the width of the composed 9:16 frame at the centre point, as a web map's zoom
   * gives it. On any other window I keep that whole frame in view: a wider window shows more on
   * the sides, a taller one more above and below. The camera looks at sea level under the
   * centre; shiftX and shiftY move the picture on screen without turning the camera (a lens
   * shift), so the page can centre the model in the space the furniture leaves free.
   */
  function placeCamera(cam) {
    const aspect = view.width / view.height;
    const frameWidth = 2 ** cam.logWidth;
    const frameHeight = frameWidth / FRAME_ASPECT;
    const visibleWidth = Math.max(frameWidth, frameHeight * aspect);
    const visibleHeight = visibleWidth / aspect;
    const distance = frameHeight / 2 / Math.tan(deg(FOV_FRAME_DEG) / 2);
    const pitch = deg(cam.pitch);
    const bearing = deg(cam.bearing);
    target.set(toSceneX(cam.x), 0, toSceneZ(cam.y));
    // Bearing as on a map: the direction the camera faces, clockwise from grid north (-z).
    forward.set(Math.sin(bearing), 0, -Math.cos(bearing));
    up.set(0, Math.sin(pitch), 0).addScaledVector(forward, Math.cos(pitch));
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(visibleHeight / 2 / distance));
    camera.aspect = aspect;
    camera.near = Math.max(1, distance - 2500);
    camera.far = distance + 3000;
    camera.position
      .copy(target)
      .addScaledVector(forward, -distance * Math.sin(pitch))
      .add(new THREE.Vector3(0, distance * Math.cos(pitch), 0));
    camera.up.copy(up);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    const m = camera.projectionMatrix.elements;
    m[8] -= cam.shiftX ?? 0;
    m[9] -= cam.shiftY ?? 0;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    camera.updateMatrixWorld();
    kmPerPx = visibleHeight / view.height;
    // The haze grows as the camera tilts: none from straight above, up to 55 % at the far edge.
    hazeUniform.value.set(distance * 0.97, distance * 1.5, HAZE_MAX * smoothstep(8, 50, cam.pitch));
    return { distance };
  }

  // ---- what is drawn ----
  let frame = 0;
  let reelCamera = mode === "reel";
  let userCamera = null; // the page's camera
  let flight = null; // { from, to, start, duration, done }
  let playing = false;
  let playEnd = 0;
  let lastTime = 0;
  let raf = 0;
  const refKmPerPx = config.page.default_view.width_km / config.frame_px[0];

  const easeOut = (t) => 1 - (1 - t) ** 3;
  function blendCameras(a, b, t) {
    const out = {};
    for (const k of Object.keys(b)) out[k] = (a[k] ?? 0) + (b[k] - (a[k] ?? 0)) * t;
    const db = ((((b.bearing - a.bearing) % 360) + 540) % 360) - 180;
    out.bearing = a.bearing + db * t;
    return out;
  }

  function currentCamera(now) {
    if (reelCamera) return { ...timeline.reel.camera, shiftX: 0, shiftY: 0 };
    if (flight) {
      const t = Math.min(1, (now - flight.start) / flight.duration);
      const cam = blendCameras(flight.from, flight.to, easeOut(t));
      if (t >= 1) {
        // The move ends exactly on its target, not on the last blended value.
        userCamera = { ...flight.to };
        const done = flight.done;
        flight = null;
        done?.();
        return { ...userCamera };
      }
      return cam;
    }
    return userCamera ?? { ...cameraState(config.page.default_view), shiftX: 0, shiftY: 0 };
  }

  function draw(now = performance.now()) {
    if (!timeline) return;
    const { data, reel } = timeline;
    const cam = currentCamera(now);
    ex = reelCamera ? reel.exaggeration : pageEx;
    exUniform.value = ex;
    placeCamera(cam);
    // Marks grow a little when the reader zooms in and shrink when the view is wider than the
    // reel track's wide view, so they keep their weight against the land.
    const scale = clamp(Math.sqrt(refKmPerPx / kmPerPx), 0.55, 2.2);
    topMaterial.uniforms.uRelief.value = 0.4 * clamp(ex / 9, 0, 1);
    plantMaterial.uniforms.uTime.value = data.time;
    plantMaterial.uniforms.uScale.value = scale;
    const dataOpacity = reelCamera ? reel.data_opacity : 1;
    plantMaterial.uniforms.uOpacity.value = dataOpacity;
    plantMaterial.uniforms.uPulse.value = reelCamera ? reel.plant_pulse : 0;
    lineMaterial.uniforms.uDrawKm.value = data.draw * totalLineKm;
    lineMaterial.uniforms.uHeadOn.value = data.draw < 1 ? 1 : 0;
    lineMaterial.uniforms.uOpacity.value = dataOpacity;
    const lineScale = clamp(scale, 0.75, 1.4);
    lineMaterial.uniforms.uHalfWidth.value = (LINE_CORE_PX * LINE_GLOW_FACTOR * lineScale) / 2;
    lineMaterial.uniforms.uCoreHalf.value = (LINE_CORE_PX * lineScale) / 2;
    // On the page the cities appear with the labels, when the drawing is done.
    const pageCues = clamp((data.time - config.data_track.lines_end_s) / 0.2, 0, 1);
    markerMaterial.uniforms.uCities.value = reelCamera ? reel.cities : pageCues;
    renderer.render(scene, camera);
    drawHighlight(now);
    lastCamera = cam;
    options.onDraw?.();
  }
  let lastCamera = null;

  function resize() {
    const [w, h] = options.size ?? [container.clientWidth, container.clientHeight];
    view.width = Math.max(1, w);
    view.height = Math.max(1, h);
    renderer.setSize(view.width, view.height);
    pxToNdc.value.set(2 / view.width, 2 / view.height);
    viewportUniform.value.set(view.width, view.height);
  }

  // ---- render loop: only while something moves ----
  function requestDraw() {
    if (!timeline) return;
    if (!raf && document.visibilityState === "visible") raf = requestAnimationFrame(tick);
  }
  function tick(now) {
    raf = 0;
    if (playing) {
      // One slow frame never moves the drawing on by more than half a second.
      const elapsedS = Math.min((now - lastTime) / 1000, 0.5);
      frame = Math.min(playEnd, frame + elapsedS * FPS);
      timeline.seek(frame);
      if (frame >= playEnd) {
        playing = false;
        options.onEnd?.();
      }
    }
    lastTime = now;
    draw(now);
    if (playing || flight || pulsing(now)) requestDraw();
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

  // ---------------------------------------------------------------- reading the model
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function rayAt(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray;
  }
  const insideGrid = (xKm, yKm) => xKm >= mesh.x0 && xKm <= mesh.x0 + (mesh.cols - 1) * mesh.step && yKm <= mesh.y1 && yKm >= mesh.y1 - (mesh.rows - 1) * mesh.step;

  /** Grid km of the sea-level point under a screen position (for zooming toward the cursor). */
  function groundAt(clientX, clientY) {
    const ray = rayAt(clientX, clientY);
    if (ray.direction.y >= -1e-6) return null;
    const s = -ray.origin.y / ray.direction.y;
    const p = ray.at(s, new THREE.Vector3());
    return fromScene(p.x, p.z);
  }

  const projected = new THREE.Vector3();
  /** Screen position (CSS px) and NDC depth of a point at grid km and a height in metres. */
  function project(xKm, yKm, heightM) {
    projected.set(toSceneX(xKm), (heightM / 1000) * ex, toSceneZ(yKm)).project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return [
      rect.left + ((projected.x + 1) / 2) * rect.width,
      rect.top + ((1 - projected.y) / 2) * rect.height,
      projected.z,
    ];
  }

  /** Diameter in CSS px of a plant's disc at a mark scale: area by capacity, as the shader. */
  const discPx = (capacityMw, scale) =>
    Math.max(MIN_PLANT_PX, Math.max(SMALLEST_PLANT_PX, LARGEST_PLANT_PX * Math.sqrt(capacityMw / plants[0].capacity_mw)) * scale);
  const markScale = () => clamp(Math.sqrt(refKmPerPx / kmPerPx), 0.55, 2.2);

  /** The plant drawn under a screen position, if any: within about 12 px of its disc. */
  function plantAt(clientX, clientY) {
    const scale = markScale();
    const lit = timeline.litAt(frame);
    let best = null;
    for (let i = 0; i < Math.min(lit, plants.length); i += 1) {
      const p = plants[i];
      const [sx, sy] = project(p.xKm, p.yKm, meshHeightAt(p.xKm, p.yKm));
      const d = Math.hypot(sx - clientX, sy - clientY);
      // Discs overlap where plants sit close together: the one whose centre is nearest wins.
      if (d <= discPx(p.capacity_mw, scale) / 2 + HIT_PX && (!best || d < best.d)) best = { index: i, plant: p, d };
    }
    return best;
  }

  /** The line drawn under a screen position, if any (within about 12 px of its centre), and
   * the point on it nearest the click, as a segment index and a share along that segment. */
  function lineAt(clientX, clientY) {
    const drawnKm = timeline.data.draw * totalLineKm;
    let best = null;
    let bestD = HIT_PX;
    for (const line of lines) {
      if (line.startKm >= drawnKm) continue;
      let prev = null;
      line.coords.forEach(([x, y], i) => {
        const s = project(x, y, meshHeightAt(x, y) + LINE_LIFT_M);
        if (prev) {
          const [d, t] = distanceToSegment(clientX, clientY, prev, s);
          if (d < bestD) {
            bestD = d;
            const [ax, ay] = line.coords[i - 1];
            best = { line, segment: i - 1, t, xKm: ax + (x - ax) * t, yKm: ay + (y - ay) * t };
          }
        }
        prev = s;
      });
    }
    return best;
  }
  function distanceToSegment(px, py, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = clamp(((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    return [Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)), t];
  }

  /** Pixels per km on the top surface at the screen centre, and the screen angle of north. */
  function groundScale() {
    const rect = renderer.domElement.getBoundingClientRect();
    const g = groundAt(rect.left + rect.width / 2, rect.top + rect.height / 2) ?? [lastCamera.x, lastCamera.y];
    const a = project(g[0], g[1], 0);
    const east = project(g[0] + 10, g[1], 0);
    const north = project(g[0], g[1] + 10, 0);
    const pxPerKm = Math.hypot(east[0] - a[0], east[1] - a[1]) / 10;
    const northDeg = THREE.MathUtils.radToDeg(Math.atan2(north[0] - a[0], -(north[1] - a[1])));
    return { pxPerKm, northDeg };
  }

  /**
   * The page's default view fitted into a screen rectangle: the camera angles of the default
   * view, with its width and a lens shift chosen so the whole mainland fills the rectangle.
   */
  function defaultView(rect) {
    const cam = { ...cameraState(config.page.default_view), shiftX: 0, shiftY: 0 };
    const saved = ex;
    ex = pageEx;
    for (let k = 0; k < 8; k += 1) {
      placeCamera(cam);
      let [l, r, t, b] = [Infinity, -Infinity, Infinity, -Infinity];
      for (const [x, y, hM] of landSamples) {
        projected.set(toSceneX(x), (hM / 1000) * ex, toSceneZ(y)).project(camera);
        const sx = ((projected.x + 1) / 2) * view.width;
        const sy = ((1 - projected.y) / 2) * view.height;
        l = Math.min(l, sx);
        r = Math.max(r, sx);
        t = Math.min(t, sy);
        b = Math.max(b, sy);
      }
      const s = Math.max((r - l) / (rect.right - rect.left), (b - t) / (rect.bottom - rect.top));
      cam.logWidth += Math.log2(s);
      cam.shiftX += (((rect.left + rect.right) / 2 - (l + r) / 2) / view.width) * 2;
      cam.shiftY -= (((rect.top + rect.bottom) / 2 - (t + b) / 2) / view.height) * 2;
    }
    ex = saved;
    // Put the camera back where it was drawn, so readings and labels stay true until the next draw.
    if (lastCamera) placeCamera(lastCamera);
    return cam;
  }

  // ---------------------------------------------------------------- the marker on a clicked feature
  // Drawn in screen pixels over the model, flat and hairline like the marks of the other pieces
  // (no glow, no shadow, no icon): on a plant three Amber rings that widen once from the disc's
  // edge and settle; on a line a short bright Paper stretch, about 20 px each way from the
  // clicked point. It follows the model as the reader turns it, and goes when the note closes.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const highlightLayer = document.createElementNS(SVG_NS, "svg");
  highlightLayer.setAttribute("aria-hidden", "true");
  highlightLayer.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:visible";
  container.append(highlightLayer);
  let highlight = null;
  const RINGS_MS = 600;
  const RING_GAPS_PX = [4, 8, 12]; // where the three rings settle, outside the disc's edge
  const pulsing = (now) => highlight?.kind === "plant" && !reducedMotion && now - highlight.start < RINGS_MS;

  function drawHighlight(now) {
    if (!highlight) {
      if (highlightLayer.firstChild) highlightLayer.innerHTML = "";
      return;
    }
    const rect = renderer.domElement.getBoundingClientRect();
    const local = ([x, y]) => [x - rect.left, y - rect.top];
    let svg = "";
    if (highlight.kind === "plant") {
      const p = plants[highlight.index];
      const [x, y] = local(project(p.xKm, p.yKm, meshHeightAt(p.xKm, p.yKm)));
      const edge = discPx(p.capacity_mw, markScale()) / 2;
      const t = pulsing(now) ? (now - highlight.start) / RINGS_MS : 1;
      const grow = 1 - (1 - t) ** 3; // widen fast, settle softly
      for (const gap of RING_GAPS_PX) {
        svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(edge + gap * grow).toFixed(2)}" fill="none" stroke="${look.plants}" stroke-width="1.25"/>`;
      }
    } else {
      const { line, segment, t } = highlight;
      const pts = line.coords.map(([x, y]) => local(project(x, y, meshHeightAt(x, y) + LINE_LIFT_M)));
      const a = pts[segment];
      const b = pts[segment + 1];
      const start = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      // Walk 20 px along the line on screen in each direction from the clicked point.
      const walk = (from, index, step) => {
        const out = [];
        let left = 20;
        let cur = from;
        for (let i = index; i >= 0 && i < pts.length && left > 0; i += step) {
          const next = pts[i];
          const d = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
          if (d >= left) {
            out.push([cur[0] + ((next[0] - cur[0]) * left) / d, cur[1] + ((next[1] - cur[1]) * left) / d]);
            break;
          }
          out.push(next);
          left -= d;
          cur = next;
        }
        return out;
      };
      const stretch = [...walk(start, segment, -1).reverse(), start, ...walk(start, segment + 1, 1)];
      const d = stretch.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
      svg += `<path d="${d}" fill="none" stroke="${look.lines}" stroke-width="3" stroke-linecap="butt" stroke-linejoin="round"/>`;
    }
    highlightLayer.innerHTML = svg;
  }

  // ---------------------------------------------------------------- the reader's camera
  function takeCamera(kind) {
    if (reelCamera) return;
    if (flight) {
      userCamera = currentCamera(performance.now());
      flight = null;
    }
    if (!userCamera) userCamera = currentCamera(performance.now());
    options.onInteract?.(kind);
  }

  /**
   * The turn and the tilt orbit around the point of the model under the screen centre, not
   * around the camera's target: the page's default view moves the picture with a lens shift,
   * so the target can sit far from the middle of the screen, and turning around it would swing
   * the model sideways out of view instead of turning it on the spot.
   */
  let pivot = null;
  function screenCentreGround() {
    const rect = renderer.domElement.getBoundingClientRect();
    return groundAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }
  function keepPivot() {
    if (!pivot) return;
    for (let k = 0; k < 4; k += 1) {
      placeCamera(userCamera);
      const now = screenCentreGround();
      if (!now) return;
      userCamera.x += pivot[0] - now[0];
      userCamera.y += pivot[1] - now[1];
    }
  }

  /**
   * Move the model in the screen plane: the sea-level point under (x0, y0) goes to (x1, y1). A
   * move that would carry the model (nearly) out of the window is not made, so it never leaves.
   */
  function moveBy(x0, y0, x1, y1) {
    takeCamera("move");
    const before = groundAt(x0, y0);
    const after = groundAt(x1, y1);
    if (!before || !after) return;
    const saved = { x: userCamera.x, y: userCamera.y };
    userCamera.x += before[0] - after[0];
    userCamera.y += before[1] - after[1];
    placeCamera(userCamera);
    const rect = renderer.domElement.getBoundingClientRect();
    let [l, r, t, b] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const [x, y, hM] of landSamples) {
      const [sx, sy] = project(x, y, hM);
      l = Math.min(l, sx);
      r = Math.max(r, sx);
      t = Math.min(t, sy);
      b = Math.max(b, sy);
    }
    const keep = 80; // at least this much of the model stays inside the window
    if (r < rect.left + keep || l > rect.right - keep || b < rect.top + keep || t > rect.bottom - keep) {
      Object.assign(userCamera, saved);
      placeCamera(userCamera);
    }
  }

  function zoomAt(steps, clientX, clientY) {
    takeCamera("zoom");
    const before = groundAt(clientX, clientY);
    userCamera.logWidth = clamp(userCamera.logWidth + steps, ...LOG_WIDTH_RANGE);
    placeCamera(userCamera);
    const after = groundAt(clientX, clientY);
    // Keep the point under the cursor where it is: the model zooms toward the cursor.
    if (before && after) {
      userCamera.x += before[0] - after[0];
      userCamera.y += before[1] - after[1];
    }
    // No clamp to the grid here: on a tilted view the camera's target can lie well outside it
    // while the model is in view, and the spot under the cursor never moves, so the model
    // cannot be zoomed away.
    requestDraw();
  }

  if (options.interactive !== false) {
    const canvas = renderer.domElement;
    const pointers = new Map();
    // Two fingers hold on to the ground spot under their midpoint when the second one lands, and
    // the zoom and width they started with. Every move puts that spot back under the midpoint
    // and sets the zoom from the spread, absolutely, so a move the browser holds back (its
    // touch slop) can never leave the model behind the fingers.
    let twoFingers = null; // { spot, spread, logWidth }
    let dragging = false;
    let downAt = null;
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("pointerdown", (event) => {
      // The main button (or a finger) turns and tilts; the right button moves the model.
      if (event.button !== 0 && event.button !== 2) return;
      // Capture only real pointers: a synthetic event has no active pointer to capture.
      if (event.isTrusted) canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, button: event.button });
      dragging = false;
      downAt = pointers.size === 1 ? { x: event.clientX, y: event.clientY } : null;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        takeCamera("move");
        placeCamera(userCamera);
        twoFingers = {
          spot: groundAt((a.x + b.x) / 2, (a.y + b.y) / 2),
          spread: Math.hypot(a.x - b.x, a.y - b.y),
          logWidth: userCamera.logWidth,
        };
      }
    });
    canvas.addEventListener("pointermove", (event) => {
      const last = pointers.get(event.pointerId);
      if (!last) return; // hover does nothing
      const dx = event.clientX - last.x;
      const dy = event.clientY - last.y;
      if (pointers.size === 2) {
        last.x = event.clientX;
        last.y = event.clientY;
        dragging = true;
        const [a, b] = [...pointers.values()];
        const spread = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
        if (twoFingers?.spot && spread > 0) {
          // The pinch first: the zoom the spread asks for since the fingers landed.
          takeCamera("move");
          userCamera.logWidth = clamp(twoFingers.logWidth - Math.log2(spread / twoFingers.spread), ...LOG_WIDTH_RANGE);
          placeCamera(userCamera);
          // Then the move: the held spot goes back under the midpoint.
          const [sx, sy] = project(twoFingers.spot[0], twoFingers.spot[1], 0);
          moveBy(sx, sy, mid[0], mid[1]);
        }
        requestDraw();
        return;
      }
      if (!dragging && Math.hypot(dx, dy) < 4) return; // a click is not a drag
      dragging = true;
      const from = [last.x, last.y];
      last.x = event.clientX;
      last.y = event.clientY;
      // Right-drag or Ctrl + drag moves the model: the point under the cursor follows it.
      if (last.button === 2 || event.ctrlKey) {
        moveBy(from[0], from[1], event.clientX, event.clientY);
        requestDraw();
        return;
      }
      // A plain drag does both: left and right turns the model, up and down tilts it within
      // the pitch limits, a diagonal drag does both at once.
      takeCamera("turn");
      if (!pivot) {
        // Read the pivot from the reader's own camera: the last camera placed may be another
        // one (the default view's fit or the capacity key measure place cameras too).
        placeCamera(userCamera);
        pivot = screenCentreGround();
      }
      userCamera.bearing -= dx * 0.3;
      userCamera.pitch = clamp(userCamera.pitch - dy * 0.3, 0, MAX_PITCH_DEG);
      keepPivot();
      requestDraw();
    });
    const release = (event) => {
      pivot = null;
      const wasClick = !dragging && pointers.size === 1 && downAt && event.type === "pointerup";
      pointers.delete(event.pointerId);
      if (pointers.size < 2) twoFingers = null;
      if (wasClick && event.button === 0) options.onClick?.(event.clientX, event.clientY);
      if (pointers.size === 0) dragging = false;
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
        zoomAt(pixels * 0.0015, event.clientX, event.clientY);
      },
      { passive: false },
    );
  }

  const observer = new ResizeObserver(() => {
    resize();
    requestDraw();
  });
  if (!options.size) observer.observe(container);
  resize();

  // ---------------------------------------------------------------- ready
  const ready = (async () => {
    const [heightsData, texture, plantData, lineData] = await Promise.all([
      loadHeights(place.urls.heights),
      loadTexture(place.urls.relief),
      loadJson(place.urls.plants),
      loadJson(place.urls.lines),
    ]);
    fine = heightsData;
    mesh = downsample(fine);
    plants = plantData;
    timeline = createTimeline(config, { capacities: plants.map((p) => p.capacity_mw) });
    landSamples = sampleLand();
    // The page fits its default view to the space its furniture leaves, before the first draw.
    if (options.initialView) userCamera = options.initialView();
    buildTop(texture);
    buildWalls();
    buildPlants();
    buildLines(lineData);
    buildMarkers();
    timeline.seek(frame);
    // Compile every shader and upload the textures now, so the first drawn frame is complete.
    renderer.compile(scene, camera);
    draw();
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    draw();
  })();

  return {
    ready,
    frames: config.frames,
    pageType: config.page_type ?? "data-draw",
    get frame() {
      return frame;
    },
    get exaggeration() {
      return ex;
    },
    get totalLineKm() {
      return totalLineKm;
    },
    get plants() {
      return plants;
    },
    timeline: () => timeline,
    renderer,
    /**
     * Show one frame. { camera: true } turns the reel track on: the camera, the exaggeration and the fades
     * follow the reel track. Without it the page keeps its own camera at exaggeration 9 and only
     * the data track moves. Draws at once, so a recorder can take the picture right after.
     */
    setFrame(f, { camera = false } = {}) {
      playing = false;
      reelCamera = camera;
      frame = f;
      timeline.seek(frame);
      draw();
    },
    /** Play the data track from one frame to another at 30 frames per second. */
    play({ from = frame, to = config.frames } = {}) {
      reelCamera = false;
      frame = from;
      playEnd = to;
      timeline.seek(frame);
      if (reducedMotion) {
        frame = to;
        timeline.seek(frame);
        draw();
        options.onEnd?.();
        return;
      }
      playing = true;
      lastTime = performance.now();
      requestDraw();
    },
    stop() {
      playing = false;
    },
    isPlaying: () => playing,
    requestDraw,
    project,
    plantAt,
    lineAt,
    groundScale,
    defaultView,
    heightAt,
    meshHeightAt,
    toLonLat: (xKm, yKm) => utmToLonLat(xKm * 1000, yKm * 1000, place.centralMeridian),
    getCamera: () => ({ ...(lastCamera ?? currentCamera(performance.now())) }),
    setCamera(cam) {
      flight = null;
      userCamera = { ...cam };
      lastCamera = { ...cam };
      placeCamera(userCamera);
      requestDraw();
    },
    /** Ease the page camera to a view over `ms` (a jump under reduced motion). */
    flyTo(cam, ms = 1000) {
      takeCamera("fly");
      if (reducedMotion || ms <= 0) {
        userCamera = { ...cam };
        flight = null;
        requestDraw();
        return;
      }
      flight = { from: { ...userCamera }, to: { ...cam }, start: performance.now(), duration: ms };
      requestDraw();
    },
    /** Screen position of a vertex part way along a line (in draw order), for automated checks. */
    lineMidpoint(i, share = 0.5) {
      const line = lines[i];
      const [x, y] = line.coords[Math.min(line.coords.length - 1, Math.floor(line.coords.length * share))];
      return project(x, y, meshHeightAt(x, y) + LINE_LIFT_M);
    },
    lineCount: () => lines.length,
    /** Grid km of the sea-level point under a screen position, for automated checks. */
    groundAt(clientX, clientY) {
      placeCamera(lastCamera ?? currentCamera(performance.now()));
      return groundAt(clientX, clientY);
    },
    /** Mark a clicked feature: { kind: "plant", index } or { kind: "line", line, segment, t },
     * or null to clear it. */
    setHighlight(h) {
      highlight = h ? { ...h, start: performance.now() } : null;
      requestDraw();
    },
    /** Diameter in CSS px of a plant of this capacity, at the current view or at a given camera
     * (the capacity key uses the default view). */
    plantDiameter(capacityMw, cam = null) {
      if (!cam) return discPx(capacityMw, markScale());
      placeCamera(cam);
      const size = discPx(capacityMw, markScale());
      placeCamera(lastCamera ?? cam);
      return size;
    },
    pxPerKm: () => 1 / kmPerPx,
    /** The screen box (CSS px) of the land as drawn now, from the 10 km land samples. */
    modelScreenBox() {
      let [left, right, top, bottom] = [Infinity, -Infinity, Infinity, -Infinity];
      for (const [x, y, hM] of landSamples) {
        const [sx, sy] = project(x, y, hM);
        left = Math.min(left, sx);
        right = Math.max(right, sx);
        top = Math.min(top, sy);
        bottom = Math.max(bottom, sy);
      }
      return { left, right, top, bottom };
    },
    gridToScreenScale: () => clamp(Math.sqrt(refKmPerPx / kmPerPx), 0.55, 2.2),
  };
}
