/**
 * How every figure is written, so a number never breaks from its unit at the end of a line.
 *
 * A figure and its unit are joined by a no-break space (U+00A0): "4,634 m" can wrap before or
 * after, never between the number and the "m". Coordinates and dates keep their parts together
 * the same way. Everything the page and the scene draw goes through these helpers, so no string
 * has to remember it by hand.
 */

export const NBSP = " ";

/** A figure with its unit: thousands separators, then a no-break space, then the unit. */
export function fmt(value, unit, digits = 0) {
  const number = Number(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return unit ? `${number}${NBSP}${unit}` : number;
}

/** A unit written before its figure, as in "km 121.6 along the line". */
export const fmtBefore = (unit, value, digits = 0) => `${unit}${NBSP}${fmt(value, "", digits)}`;

/** Coordinates: each degree stays with its N, S, E or W ("46.55° N 7.80° E"). */
export function coords(lat, lon, digits = 2) {
  const part = (v, pos, neg) => `${Math.abs(v).toFixed(digits)}°${NBSP}${v >= 0 ? pos : neg}`;
  return `${part(lat, "N", "S")} ${part(lon, "E", "W")}`;
}

/** A date from an ISO day, with the day kept on the month ("12 November 2026"). */
export function longDate(iso) {
  const text = new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return text.replace(" ", NBSP);
}

/**
 * Join the figures inside a text that arrives already written (for example "1,189 m" from a
 * data file): the space between a number and a following unit becomes a no-break space.
 */
export const keepFigures = (text) => text.replace(/(\d)[ ](m|km)\b/g, `$1${NBSP}$2`);
