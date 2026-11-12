/**
 * The print texture: a fine sand grain over the whole frame, drawn in the browser.
 *
 * What it does: draws a small tile of seeded noise in Kemet silt, which the page repeats over
 * the map at 5% (style.css), so the flat plate reads as printed paper, not a screen fill.
 * Reads:  nothing
 * Writes: nothing (returns a data URL)
 * Run:    imported by ui.js
 *
 * Why procedural, with a fixed seed: a texture image would be one more download, and a random
 * one would differ on every load. A tiny generator with a fixed seed gives the same grain on
 * every visit, in every browser, for a few hundred bytes of code.
 *
 * What you learn: Mulberry32, a four-line pseudo-random generator: the same seed always gives
 * the same sequence, which is what makes a "random" texture reproducible.
 */

const SEED = 7;
const TILE_PX = 256;
const SILT_RGB = [33, 28, 23];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A TILE_PX square of silt specks with random strength, as a PNG data URL. */
export function grainTile(seed = SEED, sizePx = TILE_PX) {
  const random = mulberry32(seed);
  const canvas = document.createElement("canvas");
  canvas.width = sizePx;
  canvas.height = sizePx;
  const context = canvas.getContext("2d");
  const image = context.createImageData(sizePx, sizePx);
  for (let i = 0; i < sizePx * sizePx; i++) {
    // Squaring the noise leaves most grains faint and a few dark, like real sand.
    const strength = random() ** 2;
    image.data.set([...SILT_RGB, Math.round(strength * 255)], i * 4);
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}
