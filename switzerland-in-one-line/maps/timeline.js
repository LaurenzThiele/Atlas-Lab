/**
 * The frame-based timeline of the scene: one paused GSAP timeline per beat, nested in one master
 * timeline that is never played, only seeked.
 *
 * Nothing here runs on real time. seek(frame) moves the playhead to frame / 30 s and GSAP writes
 * every animated value into one plain `state` object; scene.js then draws that state. The page's
 * play loop only advances the frame number and the recorder sets it directly, so the same frame
 * number always gives the same picture, whoever asks for it.
 *
 * All timing comes from layers/scene.json, which maps/prepare.py writes: the camera keys of every
 * beat, the cursor keys and a list of simple tweens (one value from A to B between two times,
 * with an easing). The next ONE LINE episode passes its own scene.json; this file stays as it is.
 */

import gsap from "gsap";

export const FPS = 30;

/**
 * Camera fields that are tweened. Angles in degrees; logWidth is log2 of the frame width in km at
 * the target; persp is 1 for perspective and 0 for orthographic; ax, ay is where the target sits
 * on the 1080 x 1920 frame; sx0 to sy1 is the part of the frame a browser window must keep.
 */
export const CAMERA_FIELDS = [
  "tx", "ty", "tz", "logWidth", "pitch", "bearing", "persp", "ax", "ay", "sx0", "sy0", "sx1", "sy1",
];

/** The layer values scene.js draws, with what they mean. Every one is a number. */
export const LAYER_FIELDS = [
  "ex", // drawn vertical exaggeration (0 = flat map)
  "flatten", // 0 = terrain, 1 = the whole block squeezed to the profile (side view)
  "corridor", // opacity of the corridor block
  "base", // opacity of the top-view map
  "base_west", // opacity of the map west of the line (it goes first)
  "map_line", // the Amber line and its end dots on the map
  "pulse", // the soft pulse running along the map line
  "pulse_km", // its position, 0 to 1 of the line
  "cursor", // the cursor dot
  "cursor_km", // its position along the line in km (the Amber line is drawn up to it)
  "profile_mix", // 0 = plain cut face, 1 = profile chart colours on the cut face
  "summit", // the summit dot
  "summit_pulse", // its one pulse, 0 to 1
  "axes", // the side view's height and km axes
]; // and one "ind_<place>" per indicator label, from scene.json

/**
 * Monotone cubic interpolation through three or more keys (Fritsch and Carlson, 1980).
 *
 * The slice camera passes through middle keys on its way down the cut face. Eased tweens from
 * key to key would meet with different speeds and the camera would jolt; one smooth curve
 * through all keys does not, and "monotone" means it never overshoots a key (the pitch never
 * tips past its target, the camera never swings past the line).
 */
function monotoneCubic(times, values) {
  const n = times.length;
  const h = [];
  const delta = [];
  for (let i = 0; i < n - 1; i += 1) {
    h.push(times[i + 1] - times[i]);
    delta.push((values[i + 1] - values[i]) / h[i]);
  }
  const slope = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i += 1) {
    if (delta[i - 1] * delta[i] > 0) {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      slope[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }
  return (t) => {
    if (t <= times[0]) return values[0];
    if (t >= times[n - 1]) return values[n - 1];
    let i = 0;
    while (t > times[i + 1]) i += 1;
    const s = (t - times[i]) / h[i];
    const s2 = s * s;
    const s3 = s2 * s;
    return (
      (2 * s3 - 3 * s2 + 1) * values[i] +
      (s3 - 2 * s2 + s) * h[i] * slope[i] +
      (-2 * s3 + 3 * s2) * values[i + 1] +
      (s3 - s2) * h[i] * slope[i + 1]
    );
  };
}

/** A camera key from scene.json as the numeric camera fields. */
export function resolveCamera(key, framePx = [1080, 1920]) {
  const [sx0, sy0, sx1, sy1] = key.subject_px ?? [0, 0, framePx[0], framePx[1]];
  const [ax, ay] = key.anchor_px ?? [framePx[0] / 2, framePx[1] / 2];
  return {
    tx: key.xz[0],
    tz: key.xz[1],
    ty: (key.target_m ?? 0) / 1000,
    logWidth: Math.log2(key.view_width_km),
    pitch: key.pitch,
    bearing: key.bearing,
    persp: key.projection === "orthographic" ? 0 : 1,
    ax,
    ay,
    sx0,
    sy0,
    sx1,
    sy1,
  };
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;
const pickCamera = (c) => Object.fromEntries(CAMERA_FIELDS.map((k) => [k, round6(c[k])]));
const sameCamera = (a, b) => CAMERA_FIELDS.every((k) => Math.abs(a[k] - b[k]) < 1e-9);

/**
 * Build the timeline from the parsed scene.json.
 * Returns { state, seek(frame), frames, duration, initial }.
 */
export function createTimeline(config) {
  const fps = config.fps ?? FPS;
  const length = config.length_s;
  const state = { camera: {} };

  // Every layer value starts at the first "from" it is given in time order; the cursor at its
  // first key. Values no tween touches stay 0.
  for (const k of LAYER_FIELDS) state[k] = 0;
  const tweens = [...config.tweens];
  const keys = config.cursor_keys;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const [t0, v0] = keys[i];
    const [t1, v1] = keys[i + 1];
    if (v0 !== v1) {
      tweens.push({ target: "cursor_km", from: v0, to: v1, start_s: t0, end_s: t1, ease: "none" });
    }
  }
  tweens.sort((a, b) => a.start_s - b.start_s);
  // The layer values: the fixed ones above, plus any value scene.json tweens (the indicators).
  const layerFields = [...new Set([...LAYER_FIELDS, ...tweens.map((t) => t.target)])];
  for (const k of layerFields) state[k] ??= 0;
  const initial = {};
  for (const t of tweens) if (!(t.target in initial)) initial[t.target] = t.from;
  initial.cursor_km = keys[0][1];
  Object.assign(state, initial);

  // The loop: on the last frame every layer value is back at its opening value. Values that end
  // somewhere else while invisible (the cursor at the summit, a finished pulse) are put back by
  // a zero-length set just before the end.
  const lastValue = {};
  for (const t of tweens) lastValue[t.target] = t.to;
  const resetAt = (config.frames - 1) / fps;
  for (const [k, v] of Object.entries(initial)) {
    if (lastValue[k] !== undefined && lastValue[k] !== v) {
      tweens.push({ target: k, from: lastValue[k], to: v, start_s: resetAt, end_s: resetAt, ease: "none" });
    }
  }

  const master = gsap.timeline({ paused: true });
  config.beats.forEach((beat) => {
    const tl = gsap.timeline({ paused: true });
    const from = pickCamera(resolveCamera(beat.camera.from, config.frame_px));
    const to = pickCamera(resolveCamera(beat.camera.to, config.frame_px));
    const t0 = (beat.camera.from.at_s ?? beat.start_s) - beat.start_s;
    const t1 = (beat.camera.to.at_s ?? beat.end_s) - beat.start_s;

    if (beat.camera.via) {
      // One curve through from, the via keys and to, driven by a linear tween of a proxy value.
      // The callback reads only the proxy, so seeking either way gives the same camera.
      const vias = [beat.camera.via].flat();
      const keysCam = [from, ...vias.map((v) => pickCamera(resolveCamera(v, config.frame_px))), to];
      const times = [t0, ...vias.map((v) => v.at_s - beat.start_s), t1];
      const curves = Object.fromEntries(
        CAMERA_FIELDS.map((k) => [k, monotoneCubic(times, keysCam.map((c) => c[k]))]),
      );
      const proxy = { t: t0 };
      tl.fromTo(
        proxy,
        { t: t0 },
        {
          t: t1,
          duration: t1 - t0,
          ease: "none",
          immediateRender: false,
          onUpdate: () => {
            for (const k of CAMERA_FIELDS) state.camera[k] = curves[k](proxy.t);
          },
        },
        t0,
      );
    } else if (!sameCamera(from, to)) {
      tl.fromTo(
        state.camera,
        { ...from },
        { ...to, duration: t1 - t0, ease: beat.ease, immediateRender: false },
        t0,
      );
    } else {
      tl.fromTo(state.camera, { ...from }, { ...to, duration: 0, immediateRender: false }, 0);
    }

    // Layer tweens that start inside this beat (the last beat also takes those at its very end).
    const isLast = beat === config.beats.at(-1);
    for (const tw of tweens) {
      const inside = tw.start_s >= beat.start_s && (tw.start_s < beat.end_s || (isLast && tw.start_s <= beat.end_s));
      if (!inside) continue;
      tl.fromTo(
        state,
        { [tw.target]: tw.from },
        {
          [tw.target]: tw.to,
          duration: tw.end_s - tw.start_s,
          ease: tw.ease,
          immediateRender: false,
        },
        tw.start_s - beat.start_s,
      );
    }
    // Pad the beat to its full length so the master lasts exactly length_s.
    tl.set({}, {}, beat.end_s - beat.start_s);
    master.add(tl.paused(false), beat.start_s);
    master.addLabel(beat.id, beat.start_s);
  });

  Object.assign(state.camera, pickCamera(resolveCamera(config.beats[0].camera.from, config.frame_px)));
  const initialCamera = { ...state.camera };

  return {
    state,
    frames: config.frames,
    duration: master.duration(),
    initial: { camera: initialCamera, ...initial },
    layerFields,
    /** Move to a frame (fractions allowed, for smooth playback on screens faster than 30 Hz). */
    seek(frame) {
      master.seek(Math.min(Math.max(frame, 0), config.frames) / fps, false);
      return state;
    },
    length,
  };
}
