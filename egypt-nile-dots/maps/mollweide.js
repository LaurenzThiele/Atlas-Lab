/**
 * World Mollweide (ESRI:54009), the grid of GHS-POP, in a few lines.
 *
 * What it does: converts lon/lat to Mollweide metres and back, and gives the four corners of a
 * 1 km grid square in lon/lat.
 * Reads:  nothing
 * Writes: nothing
 * Run:    imported by main.js and ui.js
 *
 * Why: the population grid is counted in 1 km squares of an equal-area projection, so on the
 * Web Mercator map a square is a slightly slanted four-sided shape, not an upright square. I
 * draw it with its true corners, so neighbouring squares meet without gaps or overlaps, and I
 * find the square under the mouse by projecting the mouse to Mollweide and rounding down.
 *
 * What you learn: Mollweide keeps areas true by squeezing the meridians into ellipses. Its
 * forward formula has no closed form for the auxiliary angle theta (2θ + sin 2θ = π sin φ), so
 * I solve it with a few steps of Newton's method; the inverse needs no iteration at all.
 */

// PROJ draws Mollweide on a sphere with the radius of the WGS84 semi-major axis.
const R_M = 6378137;
const SQRT2 = Math.SQRT2;
const DEG = Math.PI / 180;

/** lon/lat in degrees to Mollweide x/y in metres. */
export function forward(lon, lat) {
  const phi = lat * DEG;
  const k = Math.PI * Math.sin(phi);
  let theta = phi;
  for (let i = 0; i < 12; i++) {
    const step = (2 * theta + Math.sin(2 * theta) - k) / (2 + 2 * Math.cos(2 * theta));
    theta -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  return [
    ((2 * SQRT2) / Math.PI) * R_M * lon * DEG * Math.cos(theta),
    SQRT2 * R_M * Math.sin(theta),
  ];
}

/** Mollweide x/y in metres to lon/lat in degrees. */
export function inverse(x, y) {
  const theta = Math.asin(y / (SQRT2 * R_M));
  const lat = Math.asin((2 * theta + Math.sin(2 * theta)) / Math.PI);
  const lon = (Math.PI * x) / (2 * SQRT2 * R_M * Math.cos(theta));
  return [lon / DEG, lat / DEG];
}

/**
 * The 1 km square (column, row on the GHSL grid) that holds a point. GHSL's grid starts at
 * x = -18,041,000 m, y = 9,000,000 m, both whole kilometres, so whole kilometres line up.
 */
export function squareAt(lon, lat, squareM = 1000) {
  const [x, y] = forward(lon, lat);
  return [Math.floor(x / squareM), Math.floor(y / squareM)];
}

/** Closed ring (5 points, counter-clockwise) of the square whose lower-left corner is col, row. */
export function squareRing(col, row, squareM = 1000) {
  const x0 = col * squareM;
  const y0 = row * squareM;
  return [
    inverse(x0, y0),
    inverse(x0 + squareM, y0),
    inverse(x0 + squareM, y0 + squareM),
    inverse(x0, y0 + squareM),
    inverse(x0, y0),
  ];
}
