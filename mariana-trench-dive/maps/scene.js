/**
 * The 3D model: the seabed of the southern Mariana Trench as a heightfield block, cut open along a
 * line through the deepest point, with Everest set into the cut at the same scale.
 *
 * createScene(container, options) draws the model only, with no text and no page furniture, and
 * returns { ready, setFrame, play, playFromStart, pause, isPlaying, frames, setExaggeration, ... }.
 * The page in index.html adds the title, scale, labels and buttons around it.
 *
 * options.config  the parsed layers/scene.json (camera path, timing, look)
 * options.place   bbox, deepest point, section line and peak; defaults to config.place plus
 *                 config.peak. The next Deep Dive episode passes a new place and new layers.
 * options.urls    { relief, section }: the Terrarium PNG and the section profile
 * options.size    [width, height] in CSS pixels for a fixed-size canvas; default: fill container
 * options.pixelRatio, options.interactive, options.onPlayChange(playing)
 * options.modelCues  true on the public page: the cutaway walls with the depth ramp on their top
 *                 edge, a base, depth ticks, a fixed Challenger Deep marker, Everest for scale
 *                 and the ping that marks a reading. Off by default, so recorded frames stay
 *                 exactly as they were.
 * options.onDraw(), options.onEnd(), options.onInteract(kind), options.onClick(x, y)
 * options.indicatorSafe  { left, right, top, bottom } in CSS px: the box the animation's own
 *                 labels must stay in (a recorder passes its safe box); default: the window
 *                 minus a margin
 * options.indicatorOmit  ids of indicator texts a host already prints next to the same tick
 *                 (for example "SEA LEVEL" and "EVEREST" set by a recorder); the ticks stay
 *
 * Units: one scene unit is one kilometre. x points east, z points south, y points up, and the
 * origin is the deepest point at sea level. Heights are drawn `exaggeration` times taller.
 */

import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import gsap from "gsap";
import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { figureHtml, number } from "./format.js";
import { FPS, createTimeline } from "./timeline.js";

// A mean Earth radius sphere: across a 3 degree box the error against the ellipsoid stays far
// below a pixel. Longitude degrees shrink with the cosine of the latitude.
const KM_PER_DEG = (Math.PI * 6371) / 180;

// Zoom in the MapLibre sense, so the camera keys read like a web map: zoom 10.1 shows about
// 147 km across the 1080 px frame, and each step of 1 halves the width.
const ZOOM_REF = 10.1;
const ZOOM_REF_WIDTH_KM = 147;

// The frame the scene is composed for (9:16). Other windows show at least this much.
const FRAME_ASPECT = 1080 / 1920;

// Field of view of the perspective camera in the composed frame, and the near-orthographic one
// it narrows to before it hands over to the true orthographic camera (see placeCamera).
const FOV_WIDE_DEG = 30;
const FOV_NARROW_DEG = 0.3;

const SEA_LINE_PX = 3;
const MARKER_DOT_PX = 8; // radius of the Amber dot
const MARKER_RING_PX = 4; // the Ink ring round it
const PULSE_GROWTH_PX = 30;

/** Turn "#rrggbb" into a THREE.Color in the linear working space. */
const colour = (hex) => new THREE.Color(hex);

/** sRGB components 0..1 of a hex colour, for shaders that write straight to the canvas. */
const srgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/** Load the Terrarium PNG and decode it to heights in metres. */
async function loadHeights(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not load ${url}: ${response.status}`);
  // No colour conversion and no premultiplied alpha: the RGB bytes are data, not colour, and a
  // browser that "corrects" them would change the heights.
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

/** A depth colour ramp: evenly spaced stops from deepest to shallowest, blended in sRGB. */
function makeRamp(stops, [deepM, shallowM]) {
  const rgb = stops.map(srgb);
  const out = new THREE.Color();
  return (depthM) => {
    const t = THREE.MathUtils.clamp((deepM - depthM) / (deepM - shallowM), 0, 1) * (rgb.length - 1);
    const i = Math.min(Math.floor(t), rgb.length - 2);
    const f = t - i;
    const a = rgb[i];
    const b = rgb[i + 1];
    return out.setRGB(
      a.x + (b.x - a.x) * f,
      a.y + (b.y - a.y) * f,
      a.z + (b.z - a.z) * f,
      THREE.SRGBColorSpace,
    );
  };
}

/** The Amber marker: a dot with an Ink ring and a pulse ring, drawn as one screen-sized point. */
function makeMarker(look) {
  const size = 2 * (MARKER_DOT_PX + MARKER_RING_PX + PULSE_GROWTH_PX + 4);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uSize: { value: size },
      uScale: { value: 1 },
      uOpacity: { value: 0 },
      uPhase: { value: 0 },
      uAmber: { value: srgb(look.marker) },
      uInk: { value: srgb(look.marker_ring) },
    },
    vertexShader: /* glsl */ `
      uniform float uSize;
      uniform float uScale;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSize * uScale;
      }`,
    // Distances are in CSS pixels of the composed frame, so the marker keeps its size.
    fragmentShader: /* glsl */ `
      uniform float uSize;
      uniform float uOpacity;
      uniform float uPhase;
      uniform vec3 uAmber;
      uniform vec3 uInk;
      void main() {
        float r = length(gl_PointCoord - 0.5) * uSize;
        float dot = 1.0 - smoothstep(${MARKER_DOT_PX - 0.5}, ${MARKER_DOT_PX + 0.5}, r);
        float ring = 1.0 - smoothstep(${MARKER_DOT_PX + MARKER_RING_PX - 0.5},
                                      ${MARKER_DOT_PX + MARKER_RING_PX + 0.5}, r);
        float pr = ${MARKER_DOT_PX + MARKER_RING_PX}.0 + ${PULSE_GROWTH_PX}.0 * uPhase;
        float pulse = (1.0 - smoothstep(1.0, 2.0, abs(r - pr))) * (1.0 - uPhase)
                      * step(0.001, uPhase);
        vec3 col = mix(uInk, uAmber, dot);
        float a = max(ring, pulse * 0.9);
        col = ring > 0.0 ? col : uAmber;
        gl_FragColor = vec4(col, a * uOpacity);
      }`,
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 20;
  points.frustumCulled = false;
  return points;
}

/** A flat strip in the plane x = xOffset, under a polyline of [z, y] points (for fills). */
function stripGeometry(top, bottom, xOffset) {
  const positions = [];
  const index = [];
  for (let i = 0; i < top.length; i += 1) {
    positions.push(xOffset, top[i][1], top[i][0], xOffset, bottom[i][1], bottom[i][0]);
    if (i > 0) {
      const a = (i - 1) * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  return geometry;
}

/** A screen-width line (Line2) through [z, y] points in the plane x = xOffset. */
function lineInCut(points, xOffset, material) {
  const geometry = new LineGeometry();
  geometry.setPositions(points.flatMap(([z, y]) => [xOffset, y, z]));
  const line = new Line2(geometry, material);
  line.computeLineDistances();
  line.renderOrder = 10;
  line.frustumCulled = false;
  return line;
}

export function createScene(container, options) {
  const config = options.config;
  const place = options.place ?? { ...config.place, peak: config.peak };
  const look = config.look;
  const ex = config.exaggeration;
  const [lon0, lat0] = place.deepest_point;
  const kmPerDegLon = KM_PER_DEG * Math.cos(THREE.MathUtils.degToRad(lat0));
  const toX = (lon) => (lon - lon0) * kmPerDegLon;
  const toZ = (lat) => -(lat - lat0) * KM_PER_DEG;
  const toY = (elevationM) => (elevationM / 1000) * ex;
  const yDeep = toY(-config.deepest_depth_m);
  const yFloor = toY(-config.rock_floor_m);
  const peakHeight = toY(place.peak.height_m);

  // ---- renderer, scene, cameras ----
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
    preserveDrawingBuffer: Boolean(options.preserveDrawingBuffer),
  });
  renderer.setClearColor(colour(look.background));
  renderer.localClippingEnabled = true;
  const pixelRatio = options.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // Everything that has a height lives in one group, so the vertical exaggeration is one scale
  // on y. three.js turns the normals with the inverse transpose of that scale, so the hillshade
  // stays right at x1 as well as at x6.
  const model = new THREE.Group();
  scene.add(model);
  const exState = { scale: 1 }; // drawn exaggeration / config exaggeration
  const perspective = new THREE.PerspectiveCamera(FOV_WIDE_DEG, FRAME_ASPECT, 1, 2000);
  const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 4000);
  let activeCamera = perspective;

  // One directional light for the hillshade, from the north-west at 40 degrees, and a soft fill
  // so slopes facing away from it stay readable instead of going black. Three.js uses physical
  // light units: an intensity of pi makes a surface facing the light show its full colour.
  const az = THREE.MathUtils.degToRad(look.light.azimuth_deg);
  const alt = THREE.MathUtils.degToRad(look.light.altitude_deg);
  const sun = new THREE.DirectionalLight(0xffffff, Math.PI * 0.95);
  sun.position.set(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
  scene.add(sun, sun.target);
  const ambient = new THREE.AmbientLight(0xffffff, Math.PI * 0.4);
  scene.add(ambient);
  // A soft fill from behind and above the camera, faded in by the timeline only while the camera
  // is down in the trench, so the walls in front of it never go black.
  const fill = new THREE.DirectionalLight(0xffffff, 0);
  scene.add(fill, fill.target);

  // ---- clipping planes ----
  // The cut removes the box west of the section line, between its north end and a front that
  // sweeps south. With clipIntersection, three.js drops a fragment only when it lies on the
  // clipped side of all three planes, so the planes together cut out exactly that box.
  const section = place.section_line;
  const zNorth = toZ(section.lat_from);
  const zSouth = toZ(section.lat_to);
  const cutWest = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0); // clips x < 0
  const cutNorth = new THREE.Plane(new THREE.Vector3(0, 0, -1), zNorth); // clips z > zNorth
  const cutFront = new THREE.Plane(new THREE.Vector3(0, 0, 1), -zNorth); // clips z < front
  const cutPlanes = [cutWest, cutNorth, cutFront];
  // The cut face and its lines show only where the cut has already passed (z < front).
  const reveal = new THREE.Plane(new THREE.Vector3(0, 0, -1), zNorth);
  // The summit line draws from north (left) to south (right).
  const summitReveal = new THREE.Plane(new THREE.Vector3(0, 0, -1), zNorth);
  // As the camera turns into the side view, the whole scene is trimmed to the ends of the
  // section, so a wide window shows the slice alone and not the uncut relief beyond its ends.
  const trimNorth = new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e4); // clips z < trim line
  const trimSouth = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e4); // clips z > trim line
  renderer.clippingPlanes = [trimNorth, trimSouth];
  // Everest rises out of the floor: nothing of it shows below the deepest point.
  const peakFloor = new THREE.Plane(new THREE.Vector3(0, 1, 0), -yDeep);

  let heights = null;
  let grid = null;
  const layers = {};
  const lineMaterials = [];
  const cues = {}; // the page-only parts, built when options.modelCues is set

  /** Bilinear height in scene units at a lon/lat, from the decoded relief. */
  function heightAt(lon, lat) {
    const { west, east, north, south, width, height } = grid;
    const fx = THREE.MathUtils.clamp(((lon - west) / (east - west)) * (width - 1), 0, width - 1);
    const fy = THREE.MathUtils.clamp(((north - lat) / (north - south)) * (height - 1), 0, height - 1);
    const x0 = Math.min(Math.floor(fx), width - 2);
    const y0 = Math.min(Math.floor(fy), height - 2);
    const tx = fx - x0;
    const ty = fy - y0;
    const h = (x, y) => heights[y * width + x];
    const top = h(x0, y0) * (1 - tx) + h(x0 + 1, y0) * tx;
    const bottom = h(x0, y0 + 1) * (1 - tx) + h(x0 + 1, y0 + 1) * tx;
    return toY(top * (1 - ty) + bottom * ty);
  }

  /** The seabed as one indexed mesh: one vertex per pixel of the relief PNG. */
  function buildRelief() {
    const { west, east, north, south, width, height } = grid;
    const ramp = makeRamp(look.depth_ramp, look.depth_ramp_domain_m);
    const count = width * height;
    const positions = new Float32Array(count * 3);
    const colours = new Float32Array(count * 3);
    for (let j = 0; j < height; j += 1) {
      const z = toZ(north - (j / (height - 1)) * (north - south));
      for (let i = 0; i < width; i += 1) {
        const k = j * width + i;
        positions[k * 3] = toX(west + (i / (width - 1)) * (east - west));
        positions[k * 3 + 1] = toY(heights[k]);
        positions[k * 3 + 2] = z;
        const c = ramp(-heights[k]);
        colours[k * 3] = c.r;
        colours[k * 3 + 1] = c.g;
        colours[k * 3 + 2] = c.b;
      }
    }
    const index = new Uint32Array((width - 1) * (height - 1) * 6);
    let n = 0;
    for (let j = 0; j < height - 1; j += 1) {
      for (let i = 0; i < width - 1; i += 1) {
        const a = j * width + i;
        const b = a + 1;
        const c = a + width;
        const d = c + 1;
        index.set([a, c, b, b, c, d], n);
        n += 6;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    // Normals from the exaggerated surface: this is what turns the light into a hillshade.
    geometry.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      clippingPlanes: cutPlanes,
      clipIntersection: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    model.add(mesh);
    layers.relief = mesh;

    // Walls round the edge of the box, down to the rock floor, so the oblique view reads as a
    // solid block of seabed rather than a sheet floating in space.
    const edge = [];
    for (let i = 0; i < width; i += 1) edge.push(i); // north edge, west to east
    for (let j = 1; j < height; j += 1) edge.push(j * width + width - 1); // east edge
    for (let i = width - 2; i >= 0; i -= 1) edge.push((height - 1) * width + i); // south edge
    for (let j = height - 2; j >= 0; j -= 1) edge.push(j * width); // west edge
    const wall = [];
    const wallIndex = [];
    edge.forEach((k, e) => {
      const x = positions[k * 3];
      const z = positions[k * 3 + 2];
      wall.push(x, positions[k * 3 + 1], z, x, yFloor, z);
      if (e > 0) {
        const a = (e - 1) * 2;
        wallIndex.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    });
    const wallGeometry = new THREE.BufferGeometry();
    wallGeometry.setAttribute("position", new THREE.Float32BufferAttribute(wall, 3));
    wallGeometry.setIndex(wallIndex);
    wallGeometry.computeVertexNormals();
    const walls = new THREE.Mesh(
      wallGeometry,
      new THREE.MeshLambertMaterial({
        color: colour(look.rock_fill),
        side: THREE.DoubleSide,
        clippingPlanes: cutPlanes,
        clipIntersection: true,
      }),
    );
    model.add(walls);
    layers.walls = walls;
  }

  /** The cut face from the full-resolution section: water above the seabed, rock below. */
  function buildCut(profile) {
    const seabed = profile.points.map(([distanceKm, depthM]) => [
      zNorth + distanceKm,
      toY(-depthM),
    ]);
    const sea = seabed.map(([z]) => [z, 0]);
    const floor = seabed.map(([z]) => [z, yFloor]);
    // A hair west of the cut plane, so the face never fights the relief edge for the same depth.
    const water = new THREE.Mesh(
      stripGeometry(sea, seabed, -0.02),
      new THREE.MeshBasicMaterial({
        color: colour(look.water_fill),
        side: THREE.DoubleSide,
        clippingPlanes: [reveal],
      }),
    );
    const rock = new THREE.Mesh(
      stripGeometry(seabed, floor, -0.02),
      new THREE.MeshBasicMaterial({
        color: colour(look.rock_fill),
        side: THREE.DoubleSide,
        clippingPlanes: [reveal],
      }),
    );
    model.add(water, rock);
    layers.water = water;
    layers.rock = rock;

    const skyLine = () => {
      const material = new LineMaterial({
        color: colour(look.lines),
        linewidth: SEA_LINE_PX,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        clippingPlanes: [reveal],
      });
      lineMaterials.push(material);
      return material;
    };
    layers.seaLine = lineInCut([sea[0], sea[sea.length - 1]], -0.05, skyLine());
    layers.profileLine = lineInCut(seabed, -0.05, skyLine());
    model.add(layers.seaLine, layers.profileLine);

    // The gap between Everest's summit and the surface, brightened with Sky.
    const ySummit = yDeep + peakHeight;
    const gap = new THREE.Mesh(
      stripGeometry(sea, sea.map(([z]) => [z, ySummit]), -0.04),
      new THREE.MeshBasicMaterial({
        color: colour(look.gap_highlight.colour),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        clippingPlanes: [reveal],
      }),
    );
    gap.renderOrder = 5;
    model.add(gap);
    layers.gap = gap;

    // Amber dashed line at the summit's height, inset from the ends of the section. Dash and gap
    // lengths are in km, about 24 and 22 px in the side view.
    const inset = 11;
    const summitMaterial = new LineMaterial({
      color: colour(look.summit_line),
      linewidth: SEA_LINE_PX + 1,
      dashed: true,
      dashSize: 3.15,
      gapSize: 2.9,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      clippingPlanes: [summitReveal],
    });
    lineMaterials.push(summitMaterial);
    layers.summitLine = lineInCut(
      [
        [zNorth + inset, ySummit],
        [zSouth - inset, ySummit],
      ],
      -0.06,
      summitMaterial,
    );
    layers.summitLine.userData.span = [zNorth + inset, zSouth - inset];
    model.add(layers.summitLine);
  }

  /** Everest as a Paper cone, true height times the same exaggeration, base on the deepest point. */
  function buildPeak() {
    const geometry = new THREE.ConeGeometry(place.peak.base_half_width_km, peakHeight, 160, 1, true);
    geometry.translate(0, peakHeight / 2, 0); // base at y = 0 of the object
    const material = new THREE.MeshLambertMaterial({
      // Mostly self-lit, so the face toward the side view shows Paper itself and the light
      // only adds a gentle turn of shade round the cone instead of burning it to white.
      color: colour(look.everest).multiplyScalar(0.2),
      emissive: colour(look.everest).multiplyScalar(0.77),
      side: THREE.DoubleSide,
      clippingPlanes: [peakFloor],
    });
    const cone = new THREE.Mesh(geometry, material);
    cone.renderOrder = 2;
    model.add(cone);
    layers.peak = cone;
  }

  // ---- camera ----
  /** A camera key from scene.json (centre, zoom, pitch, bearing, projection) as numbers. */
  function resolveCamera(key) {
    const [lon, lat] = key.centre;
    const ortho = key.projection === "orthographic";
    const widthKm = ortho ? key.view_width_km : ZOOM_REF_WIDTH_KM * 2 ** (ZOOM_REF - key.zoom);
    const [ax, ay] = key.anchor_px ?? [config.frame_px[0] / 2, config.frame_px[1] / 2];
    return {
      tx: toX(lon),
      // A perspective view looks at the seabed under its centre, as a web map with terrain does;
      // the side view looks at a set depth so that sea level sits where the frame wants it.
      ty: ortho ? toY(-config.side_view_target_depth_m) : heightAt(lon, lat),
      tz: toZ(lat),
      logWidth: Math.log2(widthKm),
      pitch: key.pitch,
      bearing: key.bearing,
      persp: key.persp ?? (ortho ? 0 : 1),
      fov: key.fov ?? FOV_WIDE_DEG,
      shiftX: (2 * ax) / config.frame_px[0] - 1,
      shiftY: 1 - (2 * ay) / config.frame_px[1],
    };
  }

  const target = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const up = new THREE.Vector3();
  const viewSize = { width: 1, height: 1 };

  /**
   * Place the camera for a numeric camera state.
   *
   * The view width is the width of the composed 9:16 frame at the target. On any other window I
   * keep that whole frame in view: a wider window shows more on the sides, a taller one more
   * above and below, never less. Perspective and orthographic hand over without a jump: on its
   * way to the side view the perspective camera narrows its field of view (in log steps) while
   * backing off, so the target plane keeps its size and the picture flattens. At 0.3 degrees it
   * is indistinguishable from the orthographic camera that takes over when `persp` reaches 0.
   */
  function placeCamera(cam) {
    const aspect = viewSize.width / viewSize.height;
    const frameWidth = 2 ** cam.logWidth;
    const frameHeight = frameWidth / FRAME_ASPECT;
    const visibleWidth = Math.max(frameWidth, frameHeight * aspect);
    const visibleHeight = visibleWidth / aspect;
    const pitch = THREE.MathUtils.degToRad(cam.pitch);
    const bearing = THREE.MathUtils.degToRad(cam.bearing);
    target.set(cam.tx, cam.ty * exState.scale, cam.tz);
    // Bearing as on a map: the direction the camera faces, clockwise from north (-z).
    forward.set(Math.sin(bearing), 0, -Math.cos(bearing));
    // Up on screen: the horizon direction when level, the facing direction when looking down.
    up.set(0, Math.sin(pitch), 0).addScaledVector(forward, Math.cos(pitch));

    let camera;
    if (cam.persp > 1e-4) {
      const fovWide = cam.fov ?? FOV_WIDE_DEG;
      const fovFrame = Math.exp(
        Math.log(FOV_NARROW_DEG) + (Math.log(fovWide) - Math.log(FOV_NARROW_DEG)) * cam.persp,
      );
      const distance = frameHeight / 2 / Math.tan(THREE.MathUtils.degToRad(fovFrame) / 2);
      camera = perspective;
      camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(visibleHeight / 2 / distance));
      camera.aspect = aspect;
      // A camera low in the trench sees the floor a few km away: keep the near plane close.
      camera.near = Math.max(0.5, distance - 700);
      camera.far = distance + 700;
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
    // Lens shift: move the target off the centre of the frame without turning the camera, so
    // the deepest point can sit at y 1012 instead of 960 and stay there during the push-in.
    const scaleX = Math.min(1, frameWidth / visibleWidth);
    const scaleY = Math.min(1, frameHeight / visibleHeight);
    const m = camera.projectionMatrix.elements;
    if (camera === perspective) {
      m[8] -= cam.shiftX * scaleX;
      m[9] -= cam.shiftY * scaleY;
    } else {
      m[12] += cam.shiftX * scaleX;
      m[13] += cam.shiftY * scaleY;
    }
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    camera.updateMatrixWorld();
    activeCamera = camera;
  }

  // ---- state ----
  let timeline = null;
  let frame = 0;
  let playing = false;
  let playOnce = false; // the page plays the animation once, then stops at its end
  let endFrame = config.frames;
  // Easing the layers (cut, Everest, indicators) back to the opening state while the camera
  // returns: { from: values, start, duration }.
  let release = null;
  let userCamera = null; // set while the reader has the camera
  let resumeBlend = null; // { from, start, duration, hold } for an eased move onto the timeline
  let flight = null; // { from, to, start, duration } for an eased move to a reader view
  let raf = 0;
  let lastTime = 0;
  let uiScale = 1;
  let lastDrawnCamera = null;
  let locked = false;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2); // power2.inOut

  function blendCameras(a, b, t) {
    const out = {};
    for (const k of Object.keys(b)) out[k] = a[k] + (b[k] - a[k]) * t;
    // Bearing the short way round.
    const db = ((((b.bearing - a.bearing) % 360) + 540) % 360) - 180;
    out.bearing = a.bearing + db * t;
    return out;
  }

  /** The camera actually drawn: the timeline's, the reader's, or an eased move between them. */
  function currentCamera(now) {
    const timelineCamera = timeline.state.camera;
    if (flight) {
      const t = Math.min(1, (now - flight.start) / flight.duration);
      if (t >= 1) {
        userCamera = { ...flight.to };
        const done = flight.done;
        flight = null;
        done?.();
      } else {
        return blendCameras(flight.from, flight.to, easeInOut(t));
      }
    }
    if (userCamera) return userCamera;
    if (resumeBlend) {
      const t = Math.min(1, (now - resumeBlend.start) / resumeBlend.duration);
      if (t >= 1) {
        resumeBlend = null;
        return { ...timelineCamera };
      }
      return blendCameras(resumeBlend.from, timelineCamera, easeInOut(t));
    }
    return { ...timelineCamera };
  }

  const LAYER_KEYS = config.tweens.map((t) => t.target).filter((k, i, all) => all.indexOf(k) === i);
  /** The layer values drawn now: the timeline's, or a blend back to them after stop(). */
  function layerValues(now) {
    const s = timeline.state;
    const out = {};
    for (const k of LAYER_KEYS) out[k] = s[k];
    if (release) {
      const t = Math.min(1, (now - release.start) / release.duration);
      const e = easeInOut(t);
      for (const k of LAYER_KEYS) out[k] = release.from[k] + (s[k] - release.from[k]) * e;
      if (t >= 1) release = null;
    }
    return out;
  }

  /** Push the timeline state into the scene objects, then draw. */
  function draw(now = performance.now()) {
    const s = layerValues(now);
    model.scale.y = exState.scale;
    peakFloor.constant = -yDeep * exState.scale;
    const drawnCamera = currentCamera(now);
    placeCamera(drawnCamera);
    lastDrawnCamera = drawnCamera;

    const f = s.fill ?? 0;
    // Nearly level from behind the camera: it lights the walls facing the camera, and barely
    // the flat floor, so the plate in front does not wash out.
    fill.intensity = Math.PI * 0.3 * f;
    ambient.intensity = Math.PI * (0.4 + 0.08 * f);
    if (f > 0) {
      fill.position.copy(activeCamera.position);
      fill.target.position.copy(target);
      fill.position.y += activeCamera.position.distanceTo(target) * 0.15;
    }

    const marker = layers.marker;
    marker.visible = s.marker > 0;
    marker.material.uniforms.uOpacity.value = s.marker;
    marker.material.uniforms.uPhase.value = s.marker_pulse % 1;
    marker.material.uniforms.uScale.value = uiScale * pixelRatio;

    // The trim follows the drawn camera from the box edges (no effect) to the section ends.
    const side = 1 - Math.min(1, Math.max(0, drawnCamera.persp));
    const zBoxNorth = toZ(grid.north) - 1;
    const zBoxSouth = toZ(grid.south) + 1;
    trimNorth.constant = -(zBoxNorth + (zNorth - zBoxNorth) * side);
    trimSouth.constant = zBoxSouth + (zSouth - zBoxSouth) * side;

    const front = zNorth + (zSouth - zNorth) * s.cut;
    cutFront.constant = -front;
    reveal.constant = front;
    const cutOpen = s.cut > 0;
    for (const key of ["water", "rock", "seaLine", "profileLine"]) layers[key].visible = cutOpen;

    layers.peak.visible = s.peak > 0;
    layers.peak.position.y = yDeep - (1 - s.peak) * peakHeight;

    const [z0, z1] = layers.summitLine.userData.span;
    summitReveal.constant = z0 + (z1 - z0) * s.summit_line;
    layers.summitLine.visible = s.summit_line > 0;

    layers.gap.visible = s.gap > 0;
    layers.gap.material.opacity = look.gap_highlight.opacity * s.gap;

    updateIndicators(s);
    if (options.modelCues) {
      // The page's own parts show whenever no frame of the animation is playing: during the
      // eased moves in and out too, and they swap at frame 0 and 435, the top view, where the
      // walls cannot be seen.
      const holding = resumeBlend?.hold && now - resumeBlend.start < resumeBlend.duration;
      const show = cuesWanted && !(playing && !holding);
      if (show !== cuesVisible) setCuesVisible(show);
      updateCues();
    }
    renderer.render(scene, activeCamera);
    options.onDraw?.();
  }

  function resize() {
    const [w, h] = options.size ?? [container.clientWidth, container.clientHeight];
    viewSize.width = Math.max(1, w);
    viewSize.height = Math.max(1, h);
    renderer.setSize(viewSize.width, viewSize.height);
    // Marks and lines are sized for the 1080 px frame; on smaller windows they shrink with the
    // frame, but never below 60 %, so they stay readable on a phone.
    const frameWidthPx = Math.min(viewSize.width, viewSize.height * FRAME_ASPECT);
    uiScale = THREE.MathUtils.clamp(frameWidthPx / 1080, 0.6, 1);
    for (const material of lineMaterials) {
      material.resolution.set(viewSize.width, viewSize.height);
      material.linewidth = (material.dashed ? SEA_LINE_PX + 1 : SEA_LINE_PX) * uiScale;
    }
  }

  // ---- render loop ----
  // It runs only while something moves: while playing, during an eased camera move, or for one
  // frame after the reader moved the camera. Idle, nothing is drawn.
  function requestDraw() {
    if (!timeline) return; // nothing to draw before the model is built (ready draws it)
    if (!raf && document.visibilityState === "visible") raf = requestAnimationFrame(tick);
  }

  function tick(now) {
    raf = 0;
    // While the camera glides onto the first frame, the animation holds still.
    const holding = resumeBlend?.hold && now - resumeBlend.start < resumeBlend.duration;
    if (playing && !holding) {
      // One slow frame never moves the animation more than half a second.
      const elapsedS = Math.min((now - lastTime) / 1000, 0.5);
      frame += elapsedS * FPS;
      if (playOnce && frame >= endFrame) {
        frame = endFrame;
        timeline.seek(frame);
        setPlaying(false);
        playOnce = false;
        draw(now);
        options.onEnd?.();
        lastTime = now;
        if (flight || resumeBlend) requestDraw();
        return;
      }
      frame %= config.frames;
      timeline.seek(frame);
    }
    lastTime = now;
    draw(now);
    if (playing || resumeBlend || flight || release || exTween?.isActive() || pingTween?.isActive()) {
      requestDraw();
    }
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

  // ---- reader control ----
  // A plain drag tilts and turns about the point under the screen centre; Ctrl + drag or a
  // right-drag (two fingers on touch) moves the model with the grabbed spot glued to the cursor;
  // the wheel or a pinch zooms toward the cursor. No double-click zoom: a click reads the model.
  function takeCamera(kind) {
    if (!userCamera) userCamera = currentCamera(performance.now());
    flight = null;
    resumeBlend = null;
    playOnce = false;
    setPlaying(false);
    options.onInteract?.(kind);
  }

  // Pitch runs past 90 degrees, so the walls and the cut show side-on, but not much of the
  // underside: this block is made to be seen from the side (100 degrees).
  const MAX_PITCH_DEG = options.modelCues ? 100 : 90;
  const DEG_PER_PX = 0.3;
  const LOG_WIDTH_RANGE = [4.5, 10]; // about 22 to 1,024 km across the frame
  const MIN_MODEL_IN_VIEW_PX = 80;
  const yAxis = new THREE.Vector3(0, 1, 0);
  const seaLevel = new THREE.Plane(yAxis, 0);

  /** The view ray through a screen point (CSS px), for the reader's camera as it is now. */
  function rayThrough(clientX, clientY) {
    placeCamera(userCamera);
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, activeCamera);
    return raycaster.ray.clone();
  }

  /** The point of the model under a screen point: where its ray meets the block, or the block's
   * top plane (sea level) where it misses; failing both, the plane through the target. */
  function pointUnder(clientX, clientY) {
    const ray = rayThrough(clientX, clientY);
    const found = march(ray);
    if (found) return found.point;
    const atSea = ray.intersectPlane(seaLevel, new THREE.Vector3());
    if (atSea) return atSea;
    const target3 = new THREE.Vector3(userCamera.tx, userCamera.ty * exState.scale, userCamera.tz);
    const facing = new THREE.Plane().setFromNormalAndCoplanarPoint(activeCamera.getWorldDirection(new THREE.Vector3()), target3);
    return ray.intersectPlane(facing, new THREE.Vector3()) ?? target3;
  }

  /**
   * Shift the camera (and its target) so the world point lies under the screen point again.
   * The new ray through that pixel meets the plane through the point that faces the camera at Q;
   * moving the camera by point minus Q puts the point exactly on that ray, at any tilt.
   */
  function keepUnder(point, clientX, clientY) {
    const ray = rayThrough(clientX, clientY);
    const facing = new THREE.Plane().setFromNormalAndCoplanarPoint(activeCamera.getWorldDirection(new THREE.Vector3()), point);
    const q = ray.intersectPlane(facing, new THREE.Vector3());
    if (!q) return;
    userCamera.tx += point.x - q.x;
    userCamera.ty += (point.y - q.y) / exState.scale;
    userCamera.tz += point.z - q.z;
  }

  /** Screen position (CSS px) of a world point for the reader's camera. */
  function screenPoint(point) {
    placeCamera(userCamera);
    const q = point.clone().project(activeCamera);
    return [((q.x + 1) / 2) * viewSize.width, ((1 - q.y) / 2) * viewSize.height];
  }

  /** How much of the block is in the window, in px: the smaller side of its on-screen box cut
   * to the window. A corner behind the camera means the reader is close in: plenty in view. */
  function modelInViewPx() {
    placeCamera(userCamera);
    const { west, east, north, south } = grid;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const x of [toX(west), toX(east)]) {
      for (const y of [yFloor * exState.scale, 0]) {
        for (const z of [toZ(north), toZ(south)]) {
          const q = new THREE.Vector3(x, y, z).project(activeCamera);
          if (q.z > 1) return Infinity;
          const sx = ((q.x + 1) / 2) * viewSize.width;
          const sy = ((1 - q.y) / 2) * viewSize.height;
          x0 = Math.min(x0, sx);
          x1 = Math.max(x1, sx);
          y0 = Math.min(y0, sy);
          y1 = Math.max(y1, sy);
        }
      }
    }
    const w = Math.min(x1, viewSize.width) - Math.max(x0, 0);
    const h = Math.min(y1, viewSize.height) - Math.max(y0, 0);
    return Math.min(w, h);
  }

  /** Turn by dBearing and tilt by dPitch degrees about the pivot, then correct the camera so
   * the pivot is back exactly where it was on screen. */
  function turnAndTilt(pivot, pivotScreen, dBearing, dPitch) {
    const cam = userCamera;
    const t = new THREE.Vector3(cam.tx, cam.ty * exState.scale, cam.tz).sub(pivot);
    // Turn: bearing is clockwise from above, a negative turn about +y in three.js terms.
    t.applyAxisAngle(yAxis, -THREE.MathUtils.degToRad(dBearing));
    cam.bearing += dBearing;
    // Tilt: about the camera's horizontal right axis, within the tilt limits.
    const pitch = THREE.MathUtils.clamp(cam.pitch + dPitch, 0, MAX_PITCH_DEG);
    const b = THREE.MathUtils.degToRad(cam.bearing);
    t.applyAxisAngle(new THREE.Vector3(Math.cos(b), 0, Math.sin(b)), THREE.MathUtils.degToRad(pitch - cam.pitch));
    cam.pitch = pitch;
    t.add(pivot);
    cam.tx = t.x;
    cam.ty = t.y / exState.scale;
    cam.tz = t.z;
    keepUnder(pivot, pivotScreen[0], pivotScreen[1]);
  }

  /** Move: the grabbed point follows the cursor, unless that would leave under 80 px of the
   * block in view, in which case the move stops where it is. */
  function moveTo(grabbed, clientX, clientY) {
    const before = { ...userCamera };
    keepUnder(grabbed, clientX, clientY);
    if (modelInViewPx() < MIN_MODEL_IN_VIEW_PX) Object.assign(userCamera, before);
  }

  /** Zoom by steps (log2 of the frame width) toward a screen point: the spot under it stays. */
  function zoomToward(steps, clientX, clientY) {
    takeCamera("zoom");
    const spot = pointUnder(clientX, clientY);
    userCamera.logWidth = THREE.MathUtils.clamp(userCamera.logWidth + steps, ...LOG_WIDTH_RANGE);
    keepUnder(spot, clientX, clientY);
    requestDraw();
  }

  if (options.interactive !== false) {
    const canvas = renderer.domElement;
    const pointers = new Map();
    let pinchStart = 0;
    let centroid = null;
    let dragging = false;
    let downAt = null;
    let pivot = null; // { point, screen } for a turn
    let grabbed = null; // the world point a move holds under the cursor
    let moveMode = false;
    let pendingClick = null; // a click waits a moment, so a double click opens nothing
    const CLICK_SLOP_PX = 4;
    const DOUBLE_CLICK_MS = 250;
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("pointerdown", (event) => {
      if (locked) return;
      // The left button tilts and turns (or moves with Ctrl), the right button moves; the middle
      // button does nothing.
      if (event.pointerType === "mouse" && event.button !== 0 && event.button !== 2) return;
      canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, button: event.button });
      dragging = false;
      pivot = null;
      grabbed = null;
      moveMode = event.button === 2 || event.ctrlKey;
      downAt = pointers.size === 1 ? { x: event.clientX, y: event.clientY } : null;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
        centroid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        takeCamera("move");
        grabbed = pointUnder(centroid.x, centroid.y);
      }
    });
    canvas.addEventListener("pointermove", (event) => {
      const last = pointers.get(event.pointerId);
      if (!last) return;
      if (pointers.size === 2) {
        // Two fingers: the spot between them stays under their midpoint as it moves, and the
        // gap between them zooms toward it.
        last.x = event.clientX;
        last.y = event.clientY;
        dragging = true;
        const [a, b] = [...pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        takeCamera("move");
        grabbed ??= pointUnder(mid.x, mid.y);
        if (pinchStart > 0 && distance > 0) {
          userCamera.logWidth = THREE.MathUtils.clamp(
            userCamera.logWidth - Math.log2(distance / pinchStart), ...LOG_WIDTH_RANGE);
        }
        moveTo(grabbed, mid.x, mid.y);
        pinchStart = distance;
        centroid = mid;
        requestDraw();
        return;
      }
      // Up to 4 px from the press is still a click; past that it is a drag and never a click.
      if (!dragging && Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) <= CLICK_SLOP_PX) return;
      if (!dragging) {
        dragging = true;
        // The drag starts from the press, so the first step carries the whole movement so far.
        if (moveMode || event.ctrlKey) {
          takeCamera("move");
          grabbed = pointUnder(downAt.x, downAt.y);
        } else {
          takeCamera("turn");
          placeCamera(userCamera);
          const centre = [viewSize.width / 2, viewSize.height / 2];
          const rect = canvas.getBoundingClientRect();
          const point = pointUnder(rect.left + centre[0], rect.top + centre[1]);
          pivot = { point, screen: [rect.left + centre[0], rect.top + centre[1]] };
        }
        last.x = downAt.x;
        last.y = downAt.y;
      }
      const stepX = event.clientX - last.x;
      const stepY = event.clientY - last.y;
      last.x = event.clientX;
      last.y = event.clientY;
      if (grabbed) {
        moveTo(grabbed, event.clientX, event.clientY);
      } else if (pivot) {
        // Left and right turn, up and down tilt, both at once on a diagonal.
        turnAndTilt(pivot.point, pivot.screen, -stepX * DEG_PER_PX, -stepY * DEG_PER_PX);
      }
      requestDraw();
    });
    const release = (event) => {
      const wasClick = !dragging && pointers.size === 1 && downAt && event.type === "pointerup";
      pointers.delete(event.pointerId);
      if (pointers.size < 2) {
        pinchStart = 0;
        centroid = null;
        if (pointers.size === 1) grabbed = null;
      }
      if (pointers.size === 0) dragging = false;
      if (!(wasClick && event.button === 0)) return;
      // A second click soon after, close by, makes it a double click: neither click reads the
      // model, and nothing zooms.
      const here = { x: event.clientX, y: event.clientY, t: performance.now() };
      if (pendingClick && here.t - pendingClick.t < DOUBLE_CLICK_MS && Math.hypot(here.x - pendingClick.x, here.y - pendingClick.y) < 10) {
        clearTimeout(pendingClick.timer);
        pendingClick = null;
        return;
      }
      if (pendingClick) clearTimeout(pendingClick.timer);
      here.timer = setTimeout(() => {
        pendingClick = null;
        if (!locked) options.onClick?.(here.x, here.y);
      }, DOUBLE_CLICK_MS);
      pendingClick = here;
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener("dblclick", (event) => event.preventDefault());
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        if (locked) return;
        const lines = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
        zoomToward(lines * 0.0015, event.clientX, event.clientY);
      },
      { passive: false },
    );
  }

  // ---- the page-only parts (options.modelCues) ----
  const TICK_STEP_M = 2000;
  const TICK_LENGTH_KM = 7;
  let exTween = null;


  /**
   * The block as a finished model. The walls carry the same depth ramp as the seabed, every
   * vertex coloured by its own depth, so the ramp runs on down the cutaway,
   * shaded 16 to 20 % darker than the top so the box edges read. The base is the darkest ramp
   * colour. Then the depth ticks.
   */
  function buildCues() {
    const { west, east, north, south, width, height } = grid;
    const [deepM, shallowM] = look.depth_ramp_domain_m;
    const stops = look.depth_ramp.length;
    const rampSrgb = (depthM) => {
      const rgb = look.depth_ramp.map(srgb);
      const t = THREE.MathUtils.clamp((deepM - depthM) / (deepM - shallowM), 0, 1) * (stops - 1);
      const i = Math.min(Math.floor(t), stops - 2);
      const f = t - i;
      return rgb[i].clone().lerp(rgb[i + 1], f);
    };
    // Rows down each wall: the seabed, one row at each depth where the ramp has a stop (so the
    // straight blend between rows is the ramp itself), and the floor. A stop shallower than the
    // seabed at that point collapses onto the seabed row.
    const stopDepthsM = look.depth_ramp.map((_, k) => deepM - (k * (deepM - shallowM)) / (stops - 1));
    const rowDepths = (surfaceM) => [
      surfaceM,
      ...stopDepthsM
        .slice()
        .sort((a, b) => a - b)
        .map((d) => Math.max(d, surfaceM)),
      config.rock_floor_m,
    ];
    const rows = stops + 2;
    const L = sun.position.clone().normalize();
    const walls = [
      { normal: [0, 0, -1], cells: Array.from({ length: width }, (_, i) => [i, 0]) },
      { normal: [1, 0, 0], cells: Array.from({ length: height }, (_, j) => [width - 1, j]) },
      { normal: [0, 0, 1], cells: Array.from({ length: width }, (_, i) => [width - 1 - i, height - 1]) },
      { normal: [-1, 0, 0], cells: Array.from({ length: height }, (_, j) => [0, height - 1 - j]) },
    ];
    const positions = [];
    const colours = [];
    const index = [];
    const out = new THREE.Color();
    for (const wall of walls) {
      // Darker than the top by 16 to 20 %: the faces turned to the light keep a little more.
      const facing = Math.max(0, wall.normal[0] * L.x + wall.normal[2] * L.z);
      const shade = 0.8 + 0.04 * (facing / Math.hypot(L.x, L.z));
      const first = positions.length / 3;
      wall.cells.forEach(([i, j], c) => {
        const lon = west + (i / (width - 1)) * (east - west);
        const lat = north - (j / (height - 1)) * (north - south);
        const x = toX(lon);
        const z = toZ(lat);
        const surfaceM = -heights[j * width + i];
        for (const depthM of rowDepths(surfaceM)) {
          positions.push(x, toY(-depthM), z);
          const v = rampSrgb(depthM).multiplyScalar(shade);
          out.setRGB(v.x, v.y, v.z, THREE.SRGBColorSpace);
          colours.push(out.r, out.g, out.b);
        }
        if (c > 0) {
          const a = first + (c - 1) * rows;
          const b = first + c * rows;
          for (let r = 0; r < rows - 1; r += 1) {
            index.push(a + r, a + r + 1, b + r, a + r + 1, b + r + 1, b + r);
          }
        }
      });
    }
    // The base: one face under the whole block in the darkest ramp colour.
    const base = positions.length / 3;
    const [x0, x1, z0, z1] = [toX(west), toX(east), toZ(north), toZ(south)];
    positions.push(x0, yFloor, z0, x1, yFloor, z0, x1, yFloor, z1, x0, yFloor, z1);
    const darkest = colour(look.depth_ramp[0]);
    for (let k = 0; k < 4; k += 1) colours.push(darkest.r, darkest.g, darkest.b);
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
    geometry.setIndex(index);
    // Unlit: the shade is set per wall above, so the walls hold one steady tone like a print.
    cues.walls = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        clippingPlanes: cutPlanes,
        clipIntersection: true,
      }),
    );
    model.add(cues.walls);

    // Depth ticks every 2,000 m at the four corners, along both walls, plus the corner edges:
    // the scale a museum cutaway carries.
    const corners = [
      { name: "NW", lon: west, lat: north, along: [[1, 0], [0, 1]] },
      { name: "NE", lon: east, lat: north, along: [[-1, 0], [0, 1]] },
      { name: "SE", lon: east, lat: south, along: [[-1, 0], [0, -1]] },
      { name: "SW", lon: west, lat: south, along: [[1, 0], [0, -1]] },
    ];
    const tickPoints = [];
    cues.corners = corners.map((corner) => {
      const x = toX(corner.lon);
      const z = toZ(corner.lat);
      const surfaceM = (heightAt(corner.lon, corner.lat) / ex) * 1000;
      tickPoints.push(x, toY(surfaceM), z, x, yFloor, z);
      const ticks = [];
      for (let depthM = TICK_STEP_M; depthM <= config.rock_floor_m; depthM += TICK_STEP_M) {
        if (-depthM > surfaceM) continue; // above the seabed here: no wall to mark
        ticks.push(depthM);
        for (const [ax, az] of corner.along) {
          tickPoints.push(x, toY(-depthM), z, x + ax * TICK_LENGTH_KM, toY(-depthM), z + az * TICK_LENGTH_KM);
        }
      }
      return { ...corner, surfaceM, ticks };
    });
    const tickGeometry = new THREE.BufferGeometry();
    tickGeometry.setAttribute("position", new THREE.Float32BufferAttribute(tickPoints, 3));
    // Paper at 60 % on the rock fill: about 5:1, clear but quieter than the data.
    cues.ticks = new THREE.LineSegments(
      tickGeometry,
      new THREE.LineBasicMaterial({ color: colour(look.everest), transparent: true, opacity: 0.6 }),
    );
    model.add(cues.ticks);

    // The fixed Challenger Deep marker for the explorable model (the animation has its own).
    cues.marker = makeMarker(look);
    // Drawn whole, on top, but only while the point is in sight (checked in updateCues).
    cues.marker.material = cues.marker.material.clone();
    cues.marker.material.uniforms.uOpacity.value = 1;
    cues.marker.position.set(0, yDeep + 0.3, 0);
    model.add(cues.marker);

    // The marker of a reading: a sonar ping lying flat on the seabed at the clicked point.
    cues.ping = makePing(look);
    scene.add(cues.ping);
    setCuesVisible(false);
  }

  let cuesVisible = false;
  let cuesWanted = false;
  function setCuesVisible(visible) {
    cuesVisible = visible;
    cues.walls.visible = visible;
    cues.ticks.visible = visible;
    cues.marker.visible = visible;
    layers.walls.visible = !visible;
  }

  /** Keep the page-only parts in step with the camera and the exaggeration. */
  function updateCues() {
    const sy = exState.scale;
    cues.marker.material.uniforms.uScale.value = pixelRatio * 0.75;
    cues.marker.visible = cuesVisible && isVisible(lon0, lat0, -config.deepest_depth_m + 30);
    cues.ping.visible = Boolean(cuesVisible && ping);
    if (cues.ping.visible) placePing(sy);
  }

  // ---- the reading marker: a sonar ping ----
  // Three Sky rings in the plane of the seabed at the clicked point: a filled centre with an Ink
  // rim, a middle ring at 75 % and an outer ring at 40 %. They lie flat, so the camera's
  // perspective turns them into ellipses, and they are resized on every frame so they keep their
  // screen size (8, 21 and 34 px) at any zoom. Drawn on top, so they never sink into the seabed.
  const PING_RADII_PX = [8, 21, 34];
  const PING_HALF_PX = PING_RADII_PX[2] + 3;
  const pingState = { grow: 1 };
  let pingTween = null;
  let ping = null; // { lon, lat, elevationM }
  const pingNormal = new THREE.Vector3();
  const pingCentre = new THREE.Vector3();
  const zAxis = new THREE.Vector3(0, 0, 1);

  function makePing(lk) {
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uHalf: { value: PING_HALF_PX },
        uGrow: { value: 1 },
        uSky: { value: srgb(lk.lines) },
        uInk: { value: srgb(lk.background) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      // Distances in screen pixels of the plane, so ring widths stay 1 and 1.5 px.
      fragmentShader: /* glsl */ `
        uniform float uHalf;
        uniform float uGrow;
        uniform vec3 uSky;
        uniform vec3 uInk;
        varying vec2 vUv;
        float band(float r, float centre, float halfWidth, float aa) {
          return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, abs(r - centre));
        }
        void main() {
          float r = length(vUv * 2.0 - 1.0) * uHalf;
          float aa = max(fwidth(r) * 0.5, 0.35);
          float r0 = ${PING_RADII_PX[0]}.0 * uGrow;
          float r1 = ${PING_RADII_PX[1]}.0 * uGrow;
          float r2 = ${PING_RADII_PX[2]}.0 * uGrow;
          vec4 col = vec4(uSky, 0.4 * band(r, r2, 0.5, aa));
          float mid = 0.75 * band(r, r1, 0.75, aa);
          col = vec4(uSky, max(col.a, mid));
          float rim = 1.0 - smoothstep(r0 + 1.0 - aa, r0 + 1.0 + aa, r);
          float fill = 1.0 - smoothstep(r0 - aa, r0 + aa, r);
          if (rim > 0.0) col = vec4(mix(uInk, uSky, fill), max(col.a, rim));
          if (col.a <= 0.002) discard;
          gl_FragColor = col;
        }`,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.renderOrder = 30;
    mesh.frustumCulled = false;
    mesh.visible = false;
    return mesh;
  }

  /** Lay the ping in the seabed's own plane at its point, at a constant size on screen. */
  function placePing(sy) {
    const x = toX(ping.lon);
    const z = toZ(ping.lat);
    const d = 0.5; // km either side, for the slope of the seabed
    const dLon = d / kmPerDegLon;
    const dLat = d / KM_PER_DEG;
    const hx = (heightAt(ping.lon + dLon, ping.lat) - heightAt(ping.lon - dLon, ping.lat)) * sy;
    const hz = (heightAt(ping.lon, ping.lat - dLat) - heightAt(ping.lon, ping.lat + dLat)) * sy;
    pingNormal.set(-hx / (2 * d), 1, -hz / (2 * d)).normalize();
    pingCentre.set(x, toY(ping.elevationM) * sy, z).addScaledVector(pingNormal, 0.05);
    // Kilometres per screen pixel at the point, measured along the screen's horizontal.
    const right3 = new THREE.Vector3().setFromMatrixColumn(activeCamera.matrixWorld, 0);
    const toPx = (v) => {
      const q = v.clone().project(activeCamera);
      return new THREE.Vector2(((q.x + 1) / 2) * viewSize.width, ((1 - q.y) / 2) * viewSize.height);
    };
    const pxPerKm = toPx(pingCentre).distanceTo(toPx(pingCentre.clone().add(right3)));
    const size = (2 * PING_HALF_PX) / Math.max(pxPerKm, 1e-6);
    cues.ping.position.copy(pingCentre);
    cues.ping.quaternion.setFromUnitVectors(zAxis, pingNormal);
    cues.ping.scale.set(size, size, 1);
    cues.ping.material.uniforms.uGrow.value = pingState.grow;
  }

  /** Screen box of the ping's outer ring, so the note can float clear of it. */
  function pingBox() {
    if (!ping || !cues.ping?.visible) return null;
    const r = (PING_RADII_PX[2] / (2 * PING_HALF_PX)) * cues.ping.scale.x;
    const u = new THREE.Vector3(1, 0, 0).applyQuaternion(cues.ping.quaternion);
    const v = new THREE.Vector3(0, 1, 0).applyQuaternion(cues.ping.quaternion);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 16; k += 1) {
      const a = (k / 16) * Math.PI * 2;
      const p = pingCentre.clone().addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r);
      const q = p.project(activeCamera);
      const sx = ((q.x + 1) / 2) * viewSize.width;
      const sy2 = ((1 - q.y) / 2) * viewSize.height;
      x0 = Math.min(x0, sx);
      x1 = Math.max(x1, sx);
      y0 = Math.min(y0, sy2);
      y1 = Math.max(y1, sy2);
    }
    const c = pingCentre.clone().project(activeCamera);
    return {
      left: x0, right: x1, top: y0, bottom: y1,
      x: ((c.x + 1) / 2) * viewSize.width, y: ((1 - c.y) / 2) * viewSize.height,
    };
  }

  // ---- the animation's own indicators ----
  // Drawn as part of the scene, for the page and any recording alike: the Challenger Deep label in
  // the dive, the depth and km axes of the slice, Everest's summit tick and the bracket of water
  // above it. HTML over the canvas, placed by projecting their points on every frame, so the
  // text stays crisp at any size and the recorder captures it with the frame.
  const IND = config.indicators;
  const omit = new Set(options.indicatorOmit ?? []);
  // Figures in the indicators: the number, then its unit in the text face, never broken apart.
  const fig = (value, unit) =>
    figureHtml(Math.round(value), unit, { attrs: 'style="font-family:Inter,sans-serif"' });
  const ind = {};
  const svgNS = "http://www.w3.org/2000/svg";
  function buildIndicators() {
    const layer = document.createElement("div");
    layer.className = "scene-indicators";
    layer.setAttribute("aria-hidden", "true");
    layer.style.cssText =
      "position:absolute;inset:0;pointer-events:none;overflow:hidden;font-variant-ligatures:none;";
    container.append(layer);
    ind.layer = layer;
    const svg = document.createElementNS(svgNS, "svg");
    svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;overflow:visible;";
    layer.append(svg);
    ind.svg = svg;
    const halo = `0 0 3px ${look.background}, 0 0 3px ${look.background}, 0 0 1px ${look.background}`;
    ind.text = (html, { mono = false, colour: c = look.everest, weight = 400 } = {}) => {
      const el = document.createElement("div");
      el.innerHTML = html;
      el.style.cssText = `position:absolute;left:0;top:0;white-space:nowrap;color:${c};font-family:${
        mono ? '"JetBrains Mono", monospace' : '"Inter", sans-serif'
      };font-weight:${weight};text-shadow:${halo};font-variant-numeric:tabular-nums;`;
      layer.append(el);
      return el;
    };
    ind.path = (stroke, width) => {
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", stroke);
      path.setAttribute("stroke-width", width);
      svg.append(path);
      return path;
    };
    // Dive: the Challenger Deep label with its depth.
    ind.deep = ind.text(
      `<div style="font-weight:600;letter-spacing:0.08em;text-transform:uppercase">Challenger Deep</div>` +
        `<div style="font-family:'JetBrains Mono',monospace;color:${look.marker}">${fig(
          config.deepest_depth_m - 0.5,
          "m",
        )}</div>`,
    );
    ind.deepLeader = ind.path(look.everest, 1.5);
    // Side view: depth axis, km axis, Everest tick, gap bracket.
    ind.axis = ind.path(look.everest, 1.5);
    ind.seaLabel = ind.text("Sea level");
    ind.depthLabels = IND.depth_ticks_m.map((m) => ind.text(fig(m, "m")));
    ind.kmAxis = ind.path(look.everest, 1.5);
    ind.kmLabels = [];
    ind.everestTick = ind.path(look.everest, 1.5);
    ind.everestLabel = ind.text(`Everest ${fig(place.peak.height_m, "m")}`);
    ind.bracket = ind.path(look.lines, 2);
    ind.gapLabel = ind.text(
      fig(config.deepest_depth_m - 0.5 - Math.round(place.peak.height_m), "m"),
      { mono: true, colour: look.lines },
    );
  }

  const screenOf = (x, y, z) => {
    const v = new THREE.Vector3(x, y * exState.scale, z).project(activeCamera);
    return [((v.x + 1) / 2) * viewSize.width, ((1 - v.y) / 2) * viewSize.height, v.z];
  };
  const showEl = (el, opacity) => {
    el.style.display = opacity > 0 ? "" : "none";
    el.style.opacity = opacity;
  };
  const placeEl = (el, x, y) => {
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };
  /** Keep a text box inside the safe box; hide it if it cannot fit. */
  const fits = (x, y, w, h, safe) => x >= safe.left && x + w <= safe.right && y >= safe.top && y + h <= safe.bottom;

  function updateIndicators(s) {
    const scale = uiScale;
    const font = Math.round(24 * scale);
    ind.layer.style.fontSize = `${font}px`;
    const safe = options.indicatorSafe ?? {
      left: 16,
      right: viewSize.width - 16,
      top: 16,
      bottom: viewSize.height - 16,
    };
    const lw = Math.max(1, 1.5 * scale);

    // -- dive label --
    const deepOn = s.ind_deep ?? 0;
    let deepShown = false;
    if (deepOn > 0) {
      const [x, y, z] = screenOf(0, yDeep, 0);
      if (z < 1 && isVisible(lon0, lat0, -config.deepest_depth_m + 30)) {
        const el = ind.deep;
        el.style.display = "";
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const gap = 36 * scale;
        for (const [dx, dy] of [[gap, -h - gap], [-w - gap, -h - gap], [gap, gap], [-w - gap, gap]]) {
          if (fits(x + dx, y + dy, w, h, safe)) {
            placeEl(el, x + dx, y + dy);
            showEl(el, deepOn);
            const lx = dx > 0 ? x + dx : x + dx + w;
            const ly = dy < 0 ? y + dy + h : y + dy;
            ind.deepLeader.setAttribute("d", `M${x} ${y}L${lx} ${ly}`);
            ind.deepLeader.setAttribute("stroke-width", lw);
            ind.deepLeader.style.opacity = deepOn;
            deepShown = true;
            break;
          }
        }
      }
    }
    if (!deepShown) {
      showEl(ind.deep, 0);
      ind.deepLeader.setAttribute("d", "");
    }

    // -- side view axes --
    const axesOn = s.ind_axes ?? 0;
    const xPlane = -0.06;
    const zEnd = zSouth;
    const yTop = 0;
    if (axesOn > 0) {
      const [nx, seaY] = screenOf(xPlane, yTop, zNorth);
      const ax = Math.max(nx, safe.left);
      const [, floorY] = screenOf(xPlane, yFloor, zNorth);
      const tick = 10 * scale;
      ind.axis.setAttribute("d", `M${ax} ${seaY}V${floorY}`);
      ind.axis.setAttribute("stroke-width", lw);
      ind.axis.style.opacity = axesOn;
      let d = "";
      const labelAt = (el, y, show = true) => {
        const h = el.offsetHeight || font * 1.2;
        el.style.display = "";
        const w = el.offsetWidth;
        const ok = show && fits(ax + tick + 6, y - h / 2, w, h, safe);
        placeEl(el, ax + tick + 6, y - h / 2);
        showEl(el, ok ? axesOn : 0);
      };
      // A depth label that would sit on Everest's summit tick gives way to it.
      const [, summitY] = screenOf(xPlane, yDeep + peakHeight, zNorth);
      const evNow = s.ind_everest ?? 0;
      IND.depth_ticks_m.forEach((m, k) => {
        const [, y] = screenOf(xPlane, toY(-m), zNorth);
        d += `M${ax} ${y}h${tick}`;
        labelAt(ind.depthLabels[k], y);
        if (evNow > 0 && Math.abs(y - summitY) < font * 1.3) {
          ind.depthLabels[k].style.opacity = axesOn * (1 - evNow);
          if (evNow >= 1) ind.depthLabels[k].style.display = "none";
        }
      });
      d += `M${ax} ${seaY}h${tick}`;
      labelAt(ind.seaLabel, seaY + font * 0.75, !omit.has("sea_level"));
      // km along the foot of the slice, every km_step km from its north end.
      const lengthKm = zEnd - zNorth;
      const [x0f] = screenOf(xPlane, yFloor, zNorth);
      const [x1f] = screenOf(xPlane, yFloor, zEnd);
      const fx0 = Math.max(x0f, safe.left);
      const fx1 = Math.min(x1f, safe.right);
      let kd = `M${fx0} ${floorY}H${fx1}`;
      let k = 0;
      for (let km = 0; km <= lengthKm + 1e-6; km += IND.km_step) {
        const [x] = screenOf(xPlane, yFloor, zNorth + km);
        if (x < fx0 - 0.5 || x > fx1 + 0.5) continue;
        kd += `M${x} ${floorY}v${tick}`;
        const el = ind.kmLabels[k] ?? ind.text("");
        ind.kmLabels[k] = el;
        k += 1;
        el.innerHTML = fig(km, "km");
        el.style.display = "";
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const lx = x - w / 2;
        const ly = floorY + tick + 4;
        placeEl(el, lx, ly);
        showEl(el, fits(lx, ly, w, h, safe) ? axesOn : 0);
      }
      for (let i = k; i < ind.kmLabels.length; i += 1) showEl(ind.kmLabels[i], 0);
      ind.kmAxis.setAttribute("d", kd + d);
      ind.kmAxis.setAttribute("stroke-width", lw);
      ind.kmAxis.style.opacity = axesOn;
    } else {
      ind.axis.setAttribute("d", "");
      ind.kmAxis.setAttribute("d", "");
      for (const el of [ind.seaLabel, ...ind.depthLabels, ...ind.kmLabels]) showEl(el, 0);
    }

    // -- Everest: summit tick on the depth axis, and the bracket of water above it --
    const evOn = Math.min(s.ind_everest ?? 0, axesOn > 0 ? 1 : 0);
    const ySummit = yDeep + peakHeight;
    if (evOn > 0) {
      const [nx, y] = screenOf(xPlane, ySummit, zNorth);
      const ax = Math.max(nx, safe.left);
      const tick = 16 * scale;
      ind.everestTick.setAttribute("d", `M${ax} ${y}h${tick}`);
      ind.everestTick.setAttribute("stroke-width", lw * 1.4);
      ind.everestTick.style.opacity = evOn;
      // The label sits by Everest itself, just under the summit line and clear of the cone's
      // flank, not on the depth axis, where "Sea level" and the depth labels already are.
      const el = ind.everestLabel;
      el.style.display = "";
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const [apexX, apexY] = screenOf(0, ySummit, 0);
      const [baseX, baseY] = screenOf(0, yDeep, place.peak.base_half_width_km);
      const slope = Math.abs((baseY - apexY) / (baseX - apexX || 1)); // px down per px across
      const ly = apexY + 8 * scale;
      const lx = apexX + (ly + h + 4 * scale - apexY) / slope + 8 * scale;
      placeEl(el, lx, ly);
      showEl(el, omit.has("everest") || !fits(lx, ly, w, h, safe) ? 0 : evOn);
    } else {
      ind.everestTick.setAttribute("d", "");
      showEl(ind.everestLabel, 0);
    }
    const gapOn = Math.min(s.ind_gap ?? 0, axesOn > 0 ? 1 : 0);
    if (gapOn > 0) {
      const [sx, seaY] = screenOf(xPlane, 0, zSouth);
      const [, y] = screenOf(xPlane, ySummit, zSouth);
      const bx = Math.min(sx, safe.right) - 28 * scale;
      const arm = 12 * scale;
      ind.bracket.setAttribute("d", `M${bx - arm} ${seaY}H${bx}V${y}H${bx - arm}`);
      ind.bracket.setAttribute("stroke-width", Math.max(1.5, 2 * scale));
      ind.bracket.style.opacity = gapOn;
      const el = ind.gapLabel;
      el.style.display = "";
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      placeEl(el, bx - arm - 8 - w, (seaY + y) / 2 - h / 2);
      showEl(el, gapOn);
    } else {
      ind.bracket.setAttribute("d", "");
      showEl(ind.gapLabel, 0);
    }
  }

  // ---- reading the model ----
  const lonOf = (x) => lon0 + x / kmPerDegLon;
  const latOf = (z) => lat0 - z / KM_PER_DEG;
  /** Elevation in metres from the grid (bilinear between grid cells), never from the mesh. */
  const gridElevation = (lon, lat) => (heightAt(lon, lat) / ex) * 1000;

  /** True where a world point lies inside the solid block as it is drawn right now. */
  function insideModel(point) {
    const { west, east, north, south } = grid;
    const lon = lonOf(point.x);
    const lat = latOf(point.z);
    if (lon < west || lon > east || lat < south || lat > north) return false;
    const y = point.y / exState.scale;
    if (y < yFloor || y > heightAt(lon, lat)) return false;
    const s = timeline.state;
    const front = zNorth + (zSouth - zNorth) * s.cut;
    if (s.cut > 0 && point.x < 0 && point.z > zNorth && point.z < front) return false; // cut away
    if (point.z < -trimNorth.constant || point.z > trimSouth.constant) return false; // trimmed
    return true;
  }

  const raycaster = new THREE.Raycaster();
  const box = new THREE.Box3();
  const hit = new THREE.Vector3();
  const step = new THREE.Vector3();
  /** March along a ray through the block and return the first point inside it, refined. */
  function march(ray, maxT = Infinity) {
    const { west, east, north, south } = grid;
    box.min.set(toX(west), yFloor * exState.scale, toZ(north));
    box.max.set(toX(east), 0, toZ(south));
    const entry = ray.intersectBox(box, new THREE.Vector3());
    if (!entry) return null;
    const t0 = ray.origin.distanceTo(entry);
    // Exit: march until the ray leaves the box again (at most the box diagonal).
    const length = Math.min(box.min.distanceTo(box.max), maxT - t0);
    const stepKm = 0.15;
    let previous = t0;
    for (let t = t0; t <= t0 + length; t += stepKm) {
      ray.at(t, hit);
      if (insideModel(hit)) {
        // Bisection between the last outside and the first inside sample.
        let lo = previous;
        let hi = t;
        for (let k = 0; k < 14; k += 1) {
          const mid = (lo + hi) / 2;
          ray.at(mid, step);
          if (insideModel(step)) hi = mid;
          else lo = mid;
        }
        ray.at(hi, hit);
        return { point: hit.clone(), t: hi };
      }
      previous = t;
    }
    return null;
  }

  /** What lies under a click: lon, lat, the grid elevation there and where on the block. */
  function pick(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, activeCamera);
    const found = march(raycaster.ray);
    if (!found) return null;
    const lon = lonOf(found.point.x);
    const lat = latOf(found.point.z);
    const elevationM = gridElevation(lon, lat);
    const surfaceY = toY(elevationM) * exState.scale;
    const onTop = found.point.y > surfaceY - 0.5 * exState.scale;
    // pointElevationM is where the ray met the block (a wall point lies below the seabed there).
    const pointElevationM = (found.point.y / exState.scale / ex) * 1000;
    return { lon, lat, elevationM, pointElevationM, part: onTop ? "seabed" : "wall" };
  }

  /** False when the block hides a point (lon, lat, elevation in metres) from the camera. */
  function isVisible(lon, lat, elevationM) {
    const point = new THREE.Vector3(toX(lon), toY(elevationM) * exState.scale, toZ(lat));
    const origin =
      activeCamera === perspective
        ? activeCamera.position.clone()
        : point.clone().addScaledVector(activeCamera.getWorldDirection(new THREE.Vector3()), -1500);
    const direction = point.clone().sub(origin);
    const distance = direction.length();
    const ray = new THREE.Ray(origin, direction.normalize());
    // Stop a little short of the point itself, which lies on the surface.
    const found = march(ray, distance * 0.985);
    return !found;
  }

  /** The 3/4 view of the whole block that fits a screen rectangle (CSS px). */
  function startView(rect, { bearing = 32, pitch = 55 } = {}) {
    const { west, east, north, south } = grid;
    const xs = [toX(west), toX(east)];
    const zs = [toZ(north), toZ(south)];
    const ys = [yFloor * exState.scale, 0];
    const corners = [];
    for (const x of xs) for (const y of ys) for (const z of zs) corners.push(new THREE.Vector3(x, y, z));
    const cx = (xs[0] + xs[1]) / 2;
    const cz = (zs[0] + zs[1]) / 2;
    const cam = {
      tx: cx,
      ty: yFloor * 0.5,
      tz: cz,
      logWidth: 8,
      pitch,
      bearing,
      persp: 1,
      fov: FOV_WIDE_DEG,
      shiftX: 0,
      shiftY: 0,
    };
    const measure = (c) => {
      placeCamera(c);
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const v of corners) {
        const q = v.clone().project(activeCamera);
        x0 = Math.min(x0, q.x);
        x1 = Math.max(x1, q.x);
        y0 = Math.min(y0, q.y);
        y1 = Math.max(y1, q.y);
      }
      return { x0, x1, y0, y1 };
    };
    // Safe rectangle in NDC.
    const W = viewSize.width;
    const H = viewSize.height;
    const sx0 = (rect.left / W) * 2 - 1;
    const sx1 = (rect.right / W) * 2 - 1;
    const sy1 = 1 - (rect.top / H) * 2;
    const sy0 = 1 - (rect.bottom / H) * 2;
    let lo = 4;
    let hi = 11;
    for (let k = 0; k < 30; k += 1) {
      cam.logWidth = (lo + hi) / 2;
      const m = measure({ ...cam, shiftX: 0, shiftY: 0 });
      const fits = m.x1 - m.x0 <= sx1 - sx0 && m.y1 - m.y0 <= sy1 - sy0;
      if (fits) hi = cam.logWidth;
      else lo = cam.logWidth;
    }
    cam.logWidth = hi;
    // Lens shift centres the block in the rectangle. The shift is scaled the way placeCamera
    // scales it, so undo that scale here.
    const m = measure({ ...cam, shiftX: 0, shiftY: 0 });
    const aspect = W / H;
    const frameWidth = 2 ** cam.logWidth;
    const frameHeight = frameWidth / FRAME_ASPECT;
    const visibleWidth = Math.max(frameWidth, frameHeight * aspect);
    const visibleHeight = visibleWidth / aspect;
    const scaleX = Math.min(1, frameWidth / visibleWidth);
    const scaleY = Math.min(1, frameHeight / visibleHeight);
    cam.shiftX = ((sx0 + sx1) / 2 - (m.x0 + m.x1) / 2) / scaleX;
    cam.shiftY = ((sy0 + sy1) / 2 - (m.y0 + m.y1) / 2) / scaleY;
    // Leave the drawn camera where it was.
    if (lastDrawnCamera) placeCamera(lastDrawnCamera);
    return cam;
  }

  // ---- build ----
  const ready = (async () => {
    const [relief, profile] = await Promise.all([
      loadHeights(options.urls.relief),
      fetch(options.urls.section).then((r) => {
        if (!r.ok) throw new Error(`could not load ${options.urls.section}: ${r.status}`);
        return r.json();
      }),
    ]);
    heights = relief.heights;
    grid = { ...config.relief, width: relief.width, height: relief.height };
    buildRelief();
    buildCut(profile);
    buildPeak();
    layers.marker = makeMarker(look);
    layers.marker.position.set(0, yDeep, 0);
    model.add(layers.marker);
    if (options.modelCues) buildCues();
    buildIndicators();

    timeline = createTimeline(config, { resolveCamera });
    frame = options.startFrame ?? 0;
    timeline.seek(frame);
    resize();
    // The page may open on its own view (the start view) instead of the frame's camera.
    if (options.initialCamera) userCamera = options.initialCamera();
    if (!options.size) new ResizeObserver(() => (resize(), draw())).observe(container);
    // Compile every shader before the first frame, so the first moving frame does not stall.
    renderer.compile(scene, perspective);
    // The indicators' faces load before ready, so no frame is ever drawn in a fallback font.
    await Promise.all([
      document.fonts.load('400 24px "Inter"'),
      document.fonts.load('600 24px "Inter"'),
      document.fonts.load('500 24px "JetBrains Mono"'),
    ]);
    draw();
    await document.fonts.ready;
    // Ready only once the first full frame is on screen: two animation frames after drawing it.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })();

  return {
    ready,
    frames: config.frames,
    hero: config.hero_frame,
    /** The page type: "explainer" (Play runs the animation) or "data-draw". */
    pageType: config.page_type,
    /** The frame the page's animation ends on (a recording goes on to frames). */
    pageEndFrame: Math.round(config.page_end_s * FPS),
    reducedMotion,
    /** Jump to a frame and draw it at once (the recorder uses it). */
    setFrame(value) {
      frame = value;
      userCamera = null;
      resumeBlend = null;
      flight = null;
      timeline.seek(frame);
      draw();
    },
    frame: () => frame,
    /** Screen position in CSS pixels of a point given as lon, lat and elevation in metres. */
    project(lon, lat, elevationM) {
      const v = new THREE.Vector3(toX(lon), toY(elevationM) * exState.scale, toZ(lat)).project(
        activeCamera,
      );
      return [((v.x + 1) / 2) * viewSize.width, ((1 - v.y) / 2) * viewSize.height, v.z];
    },
    /** The seabed elevation in metres under a lon/lat, from the grid. */
    elevationAt: gridElevation,
    isPlaying: () => playing,
    /** Play on from the current frame; if the reader moved the camera, glide back over 1 s. */
    play() {
      if (userCamera) {
        resumeBlend = reducedMotion
          ? null
          : { from: userCamera, start: performance.now(), duration: 1000 };
        userCamera = null;
      }
      flight = null;
      lastTime = performance.now();
      setPlaying(true);
      requestDraw();
    },
    /** Play from frame 0, after a 1 s eased move onto the first frame. once: stop at the end. */
    playFromStart({ once = false, glide = true, end = config.frames } = {}) {
      release = null;
      endFrame = end;
      const from = currentCamera(performance.now());
      frame = 0;
      timeline.seek(0);
      userCamera = null;
      flight = null;
      resumeBlend =
        reducedMotion || !glide
          ? null
          : { from, start: performance.now(), duration: 1000, hold: true };
      playOnce = once;
      lastTime = performance.now();
      setPlaying(true);
      requestDraw();
    },
    pause() {
      setPlaying(false);
    },
    /**
     * Leave the animation: stop at once, ease the camera to `view` over ms, and ease the cut,
     * Everest and the indicators away at the same time. Resolves when the camera has arrived.
     */
    stop(view, ms = 1000) {
      const from = layerValues(performance.now());
      playOnce = false;
      setPlaying(false);
      resumeBlend = null;
      frame = 0;
      timeline.seek(0);
      release = reducedMotion || ms <= 0 ? null : { from, start: performance.now(), duration: ms };
      return this.flyTo(view, ms);
    },
    /** Put the cut, Everest and the marker back to the opening state, keeping the camera. */
    resetLayers() {
      if (!userCamera && !flight) userCamera = currentCamera(performance.now());
      playOnce = false;
      setPlaying(false);
      frame = 0;
      timeline.seek(0);
      requestDraw();
    },
    /** Hand the camera to the reader without moving it (stops the animation). */
    takeCamera: (kind = "click") => takeCamera(kind),
    /** Ease the camera to a view (from startView or cameraState) over ms. */
    flyTo(cam, ms = 1000) {
      const from = currentCamera(performance.now());
      resumeBlend = null;
      playOnce = false;
      setPlaying(false);
      return new Promise((resolve) => {
        if (reducedMotion || ms <= 0) {
          flight = null;
          userCamera = { ...cam };
          requestDraw();
          resolve();
        } else {
          userCamera = null;
          flight = { from, to: { ...cam }, start: performance.now(), duration: ms, done: resolve };
          requestDraw();
        }
      });
    },
    startView,
    cameraState: () => ({ ...(lastDrawnCamera ?? timeline.state.camera) }),
    /** Vertical exaggeration as drawn: n = 6 as in the animation, 1 is true height. */
    setExaggeration(n, ms = 0) {
      exTween?.kill();
      const scale = n / ex;
      if (reducedMotion || ms <= 0) {
        exState.scale = scale;
      } else {
        exTween = gsap.to(exState, { scale, duration: ms / 1000, ease: "power2.inOut" });
      }
      requestDraw();
    },
    exaggeration: () => exState.scale * ex,
    setCues(visible) {
      cuesWanted = visible;
      requestDraw();
    },
    /** While locked the reader's drag, zoom and click do nothing (the page locks it while the
     * animation plays). */
    setLocked(value) {
      locked = value;
    },
    /** Mark a reading ({ lon, lat, elevationM }) with the ping, pulsing out once; null clears. */
    setPing(reading) {
      ping = reading;
      pingTween?.kill();
      pingState.grow = 1;
      if (reading && !reducedMotion) {
        pingState.grow = 0;
        pingTween = gsap.to(pingState, { grow: 1, duration: 0.6, ease: "power2.out" });
      }
      requestDraw();
    },
    pick,
    isVisible,
    /** Ground direction on screen: where north points and how many px one km covers there. */
    groundScale(lon, lat) {
      const a = new THREE.Vector3(toX(lon), toY(gridElevation(lon, lat)) * exState.scale, toZ(lat));
      const toScreen = (v) => {
        const q = v.clone().project(activeCamera);
        return [((q.x + 1) / 2) * viewSize.width, ((1 - q.y) / 2) * viewSize.height];
      };
      const p0 = toScreen(a);
      const pn = toScreen(a.clone().add(new THREE.Vector3(0, 0, -10)));
      const r = new THREE.Vector3().setFromMatrixColumn(activeCamera.matrixWorld, 0).setY(0);
      if (r.lengthSq() < 1e-6) r.set(1, 0, 0);
      const pr = toScreen(a.clone().addScaledVector(r.normalize(), 10));
      return {
        northDeg: (Math.atan2(pn[0] - p0[0], -(pn[1] - p0[1])) * 180) / Math.PI,
        pxPerKm: Math.hypot(pr[0] - p0[0], pr[1] - p0[1]) / 10,
      };
    },
    wallCorners: () => cues.corners ?? [],
    pingBox,
    /** Height of the camera above the seabed under it (km, as drawn), or null outside the
     * block or above a part the cut has removed. For checking that a camera path never dives
     * into the rock. */
    cameraClearance(value) {
      timeline.seek(value);
      userCamera = null;
      flight = null;
      resumeBlend = null;
      placeCamera(currentCamera(performance.now()));
      const pos = activeCamera.position;
      if (activeCamera !== perspective) return null;
      const lon = lonOf(pos.x);
      const lat = latOf(pos.z);
      const { west, east, north, south } = grid;
      if (lon < west || lon > east || lat < south || lat > north) return null;
      const s = timeline.state;
      const front = zNorth + (zSouth - zNorth) * s.cut;
      if (s.cut > 0 && pos.x < 0 && pos.z > zNorth && pos.z < front) return null;
      return pos.y - heightAt(lon, lat) * exState.scale;
    },
    /** The numbers that decide the picture at a frame, to spot frames identical to the last. */
    stateKey(value) {
      const s = timeline.seek(value);
      return JSON.stringify(s, (k, v) =>
        k === "_gsap" ? undefined : typeof v === "number" ? Math.round(v * 1e5) / 1e5 : v,
      );
    },
  };
}
