/**
 * Figures as text. A number never breaks from its unit: there is always a no-break space
 * (U+00A0) between them, so "4,634 m" can wrap before or after, never inside. Coordinates and
 * dates hold together the same way ("11.33° N", "2 August 2027").
 */

export const NBSP = " ";

/** "10932" -> "10,932" (thousands separator, a fixed number of decimals, default none). */
export function number(value, { decimals = 0 } = {}) {
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** A figure with its unit as plain text: fmt(10932, "m") -> "10,932 m" with a no-break space. */
export function fmt(value, unit, options) {
  return `${number(value, options)}${NBSP}${unit}`;
}

/** The same as HTML, with the unit (and its no-break space) in a span of its own, for when the
 * unit is set in another face than the number. */
export function figureHtml(value, unit, { attrs = 'class="unit"', ...options } = {}) {
  return `${number(value, options)}<span ${attrs}>${NBSP}${unit}</span>`;
}

/** "11.33° N 142.21° E": each degree value held to its hemisphere letter. */
export function coord(lat, lon, decimals = 2) {
  const part = (v, pos, neg) => `${Math.abs(v).toFixed(decimals)}°${NBSP}${v >= 0 ? pos : neg}`;
  return `${part(lat, "N", "S")} ${part(lon, "E", "W")}`;
}

/** "2026-11-11" -> "11 November 2026", the day held to its month. */
export function longDate(iso) {
  const date = new Date(`${iso}T12:00:00Z`);
  const month = date.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  return `${date.getUTCDate()}${NBSP}${month} ${date.getUTCFullYear()}`;
}

const UNITS = "m|km|N|S|E|W|January|February|March|April|May|June|July|August|September|October|November|December";
const FIGURE_SPACE = new RegExp(`(\\d[\\d,.]*°?) (${UNITS})\\b`, "g");

/** For figure text that arrives already written ("10,932 m", "11.33° N 142.21° E" from
 * key_figures.json): swap the space inside each figure for a no-break space. Words and numbers
 * stay exactly as they were. "± 6 m" keeps the sign with its number too. */
export function keepTogether(text) {
  return String(text).replace(FIGURE_SPACE, `$1${NBSP}$2`).replace(/± (\d)/g, `±${NBSP}$1`);
}
