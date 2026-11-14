/**
 * One way to write a figure with its unit, everywhere the page and the scene draw one.
 *
 * The thousands separator is the comma, and the unit follows a no-break space (U+00A0), so a
 * line never breaks between "2,445" and "m". Coordinates and dates are held together the same way.
 */

export const NBSP = " ";

/** "2,445 m", "30,474 MW", "9,200 km": a figure, rounded to `decimals`, and its unit. */
export function fmt(value, unit = "", { decimals = 0 } = {}) {
  const number = Number(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return unit ? `${number}${NBSP}${unit}` : number;
}

/** "61.43° N 8.31° E", each degree value held to its hemisphere letter. */
export function fmtCoords(lon, lat, decimals = 2) {
  const part = (v, pos, neg) => `${Math.abs(v).toFixed(decimals)}°${NBSP}${v >= 0 ? pos : neg}`;
  return `${part(lat, "N", "S")} ${part(lon, "E", "W")}`;
}

/** "12 November 2026", the day held to its month. */
export function fmtDate(iso) {
  const date = new Date(`${iso}T12:00:00Z`);
  const month = date.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  return `${date.getUTCDate()}${NBSP}${month} ${date.getUTCFullYear()}`;
}
