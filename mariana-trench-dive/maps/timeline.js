/**
 * The frame-based timeline of the scene: one paused GSAP timeline per beat, nested in one master
 * timeline that is never played, only seeked.
 *
 * Nothing here runs on real time. seek(frame) moves the playhead to frame / 30 s and GSAP writes
 * every animated value into one plain `state` object; scene.js then draws that state. The page's
 * play loop only advances the frame number, so the same frame number always gives the same
 * picture, whoever asks for it.
 *
 * All timing comes from layers/scene.json (written by prepare.py): the camera of every beat and a
 * list of simple tweens (one value from A to B between two times, with an easing). A new episode
 * of the series changes scene.json, not this file.
 */

import gsap from "gsap";

export const FPS = 30;

/** Camera fields that are tweened. Angles in degrees, logWidth = log2 of the view width in km,
 * fov the vertical field of view of the perspective camera in the composed frame. */
const CAMERA_FIELDS = [
  "tx", "ty", "tz", "logWidth", "pitch", "bearing", "persp", "fov", "shiftX", "shiftY",
];

/**
 * Monotone cubic interpolation through three or more keys (Fritsch and Carlson, 1980).
 *
 * I use it for the dive, which passes through a middle key at 4.2 s. Two separate eased tweens
 * would meet there with different speeds and the camera would visibly jolt; one smooth curve
 * through all keys does not. "Monotone" means it never overshoots a key: the pitch never tips
 * past 60 degrees on its way there. The camera starts and ends at rest (slope 0 at both ends).
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
      // Weighted harmonic mean of the neighbouring secants keeps the curve monotone.
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

/** Copy only the tweened camera fields, rounded to 6 decimals as GSAP rounds what it renders,
 * so a value that was never tweened and the same value after a tween are the same number. */
const pickCamera = (camera) =>
  Object.fromEntries(CAMERA_FIELDS.map((k) => [k, Math.round(camera[k] * 1e6) / 1e6]));

const sameCamera = (a, b) => CAMERA_FIELDS.every((k) => Math.abs(a[k] - b[k]) < 1e-9);

/**
 * Build the timeline.
 * config: the parsed scene.json.
 * resolveCamera(key): turns a camera key from scene.json (centre, zoom, pitch, ...) into the
 *   numeric camera fields above. scene.js owns it because it needs the relief heights.
 * Returns { state, seek(frame), frames, duration }.
 */
export function createTimeline(config, { resolveCamera }) {
  const state = { camera: {} };
  for (const tween of config.tweens) state[tween.target] = 0;

  const master = gsap.timeline({ paused: true });
  const beatTimelines = config.beats.map((beat) => {
    const tl = gsap.timeline({ paused: true });
    const length = beat.end_s - beat.start_s;
    const from = pickCamera(resolveCamera(beat.camera.from));
    const to = pickCamera(resolveCamera(beat.camera.to));
    const endS = (beat.camera.to.at_s ?? beat.end_s) - beat.start_s;

    if (beat.camera.via) {
      // One smooth curve through from, every via key and to, driven by a linear tween of a proxy
      // value. The callback only reads the proxy's progress, so seeking forwards or backwards
      // gives the same camera for the same time.
      const vias = [beat.camera.via].flat();
      const keys = [from, ...vias.map((v) => pickCamera(resolveCamera(v))), to];
      const times = [0, ...vias.map((v) => v.at_s - beat.start_s), endS];
      const curves = Object.fromEntries(
        CAMERA_FIELDS.map((k) => [k, monotoneCubic(times, keys.map((key) => key[k]))]),
      );
      const proxy = { t: 0 };
      tl.fromTo(
        proxy,
        { t: 0 },
        {
          t: endS,
          duration: endS,
          ease: "none",
          immediateRender: false,
          onUpdate: () => {
            for (const k of CAMERA_FIELDS) state.camera[k] = curves[k](proxy.t);
          },
        },
        0,
      );
    } else if (!sameCamera(from, to)) {
      tl.fromTo(
        state.camera,
        { ...from },
        { ...to, duration: endS, ease: beat.ease, immediateRender: false },
        0,
      );
    }

    // Layer tweens that start inside this beat.
    for (const tween of config.tweens) {
      if (tween.start_s < beat.start_s || tween.start_s >= beat.end_s) continue;
      tl.fromTo(
        state,
        { [tween.target]: tween.from },
        {
          [tween.target]: tween.to,
          duration: tween.end_s - tween.start_s,
          ease: tween.ease,
          immediateRender: false,
        },
        tween.start_s - beat.start_s,
      );
    }
    // Pad the beat to its full length so the master timeline lasts exactly length_s.
    tl.set({}, {}, length);
    master.add(tl.paused(false), beat.start_s);
    master.addLabel(beat.id, beat.start_s);
    return tl;
  });

  // The opening state, before anything is seeked.
  Object.assign(state.camera, pickCamera(resolveCamera(config.beats[0].camera.from)));

  return {
    state,
    beats: beatTimelines,
    frames: config.frames,
    duration: master.duration(),
    /** Move to a frame (fractions allowed for smooth playback on screens faster than 30 Hz). */
    seek(frame) {
      // Events are not suppressed, so the dive's curve callback runs on every seek.
      master.seek(frame / FPS, false);
      return state;
    },
  };
}
