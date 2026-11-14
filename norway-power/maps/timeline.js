/**
 * The frame-based timeline of the scene, for the page and the reel track alike.
 *
 * Nothing here runs on real time. seek(frame) moves the playheads to frame / 30 s and GSAP writes
 * every animated value into plain state objects; scene.js then draws that state. The page's play
 * loop only advances the frame number, so the same frame number always gives the same picture,
 * whoever asks for it.
 *
 * Two tracks:
 * - the data track (always): the plants light up one by one, largest first, then the
 *   lines draw. It is two numbers: `time`, which every plant compares with its own light time
 *   on the GPU, and `draw`, the share of the network drawn so far.
 * - the reel track (only with setFrame's camera option): the camera of every beat, the vertical exaggeration and the
 *   fades, one paused GSAP timeline per beat nested in one master timeline.
 *
 * All timing comes from layers/scene.json (written by prepare.py). A new "Infrastructure" episode
 * changes scene.json, not this file.
 */

import gsap from "gsap";
import { fmt } from "./format.js";

export const FPS = 30;

/** Camera fields that are tweened: the centre on the grid in km, log2 of the frame width in km
 * (so a zoom changes at an even pace, as a web map's zoom does), pitch and bearing in degrees. */
const CAMERA_FIELDS = ["x", "y", "logWidth", "pitch", "bearing"];

/** A camera key from scene.json (centre in EPSG metres, width of the frame in km) in the
 * numbers the timeline tweens. */
export function cameraState(key) {
  return {
    x: key.xy[0] / 1000,
    y: key.xy[1] / 1000,
    logWidth: Math.log2(key.width_km),
    pitch: key.pitch,
    bearing: key.bearing,
  };
}


/**
 * Build the timeline.
 * config: the parsed scene.json.
 * capacities: capacity_mw of every plant in light-up order (largest first).
 * Returns { data, reel, seek(frame), lightTimes, megawattsAt(frame), kilometresAt(frame), ... }.
 */
export function createTimeline(config, { capacities }) {
  const track = config.data_track;
  const n = capacities.length;

  // ---- the data track ----
  // Evenly spaced light times: the largest plant at 4.5 s, the last at 7.8 s.
  const step = n > 1 ? (track.plants_last_s - track.plants_start_s) / (n - 1) : 0;
  const lightTimes = Float32Array.from(capacities, (_, i) => track.plants_start_s + i * step);
  // Running sums for the counter: after plant i lights, the counter shows prefix[i + 1].
  const prefix = new Float64Array(n + 1);
  capacities.forEach((mw, i) => {
    prefix[i + 1] = prefix[i] + mw;
  });

  const data = { time: 0, draw: 0 };
  const dataTimeline = gsap.timeline({ paused: true });
  // The clock the plants compare their light times with, and the share of the lines drawn.
  dataTimeline.fromTo(data, { time: 0 }, { time: config.length_s, duration: config.length_s, ease: "none", immediateRender: false }, 0);
  dataTimeline.fromTo(
    data,
    { draw: 0 },
    { draw: 1, duration: track.lines_end_s - track.lines_start_s, ease: "none", immediateRender: false },
    track.lines_start_s,
  );
  dataTimeline.set({}, {}, config.length_s);

  // ---- the reel track ----
  const reel = { camera: cameraState(config.beats[0].camera.from) };
  // Every value starts at the "from" of its first tween (exaggeration 0, cities hidden, data shown).
  for (const tween of config.camera_tweens) {
    if (!(tween.target in reel)) reel[tween.target] = tween.from;
  }
  const master = gsap.timeline({ paused: true });
  const beatTimelines = config.beats.map((beat) => {
    const tl = gsap.timeline({ paused: true });
    const length = beat.end_s - beat.start_s;
    const from = cameraState(beat.camera.from);
    const to = cameraState(beat.camera.to);
    // The hook's push in is linear; every other beat eases in and out between its cameras.
    tl.fromTo(reel.camera, { ...from }, { ...to, duration: length, ease: beat.ease, immediateRender: false }, 0);
    for (const tween of config.camera_tweens) {
      if (tween.start_s < beat.start_s || tween.start_s >= beat.end_s) continue;
      tl.fromTo(
        reel,
        { [tween.target]: tween.from },
        { [tween.target]: tween.to, duration: tween.end_s - tween.start_s, ease: tween.ease, immediateRender: false },
        tween.start_s - beat.start_s,
      );
    }
    // Pad the beat to its full length so the master lasts exactly length_s.
    tl.set({}, {}, length);
    master.add(tl.paused(false), beat.start_s);
    master.addLabel(beat.id, beat.start_s);
    return tl;
  });

  /** How many plants have lit up at a frame (a plant counts from its light time on). */
  const litAt = (frame) => {
    const t = frame / FPS;
    if (t < track.plants_start_s - 1e-6) return 0;
    return Math.min(n, Math.floor((t - track.plants_start_s) / step + 1e-6) + 1);
  };
  const drawAt = (frame) => {
    const t = frame / FPS;
    return Math.min(1, Math.max(0, (t - track.lines_start_s) / (track.lines_end_s - track.lines_start_s)));
  };

  return {
    data,
    reel,
    beats: beatTimelines,
    frames: config.frames,
    lightTimes,
    popFrames: track.pop_frames,
    duration: master.duration(),
    /** Move both tracks to a frame (fractions allowed for smooth playback above 30 Hz). */
    seek(frame) {
      const t = frame / FPS;
      dataTimeline.seek(t, false);
      master.seek(t, false);
      return { data, reel };
    },
    litAt,
    /** The plant counter: the sum of capacity_mw of the plants lit so far. */
    megawattsAt: (frame) => prefix[litAt(frame)],
    megawattsText: (frame) => fmt(prefix[litAt(frame)], "MW"),
    /** The line counter: the drawn share of the key figure, shown to the nearest 100 km. */
    kilometresAt: (frame) => drawAt(frame) * config.figures.transmission_km,
    kilometresText: (frame) => fmt(Math.round((drawAt(frame) * config.figures.transmission_km) / 100) * 100, "km"),
  };
}
