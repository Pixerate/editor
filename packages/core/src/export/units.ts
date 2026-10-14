// Portions ported from wordcraft/crates/docx/src/units.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/** Base font size (points) that `em` / `rem` / `%` lengths are relative to: Word's default 11 pt. */
export const DOCX_BASE_FONT_PT = 11;
/** Largest length accepted, in points (22 inches, Word's page limit). */
const MAX_LEN_PT = 1584;

const UNIT_PT: Record<string, number> = {
  pt: 1,
  px: 0.75,
  in: 72,
  cm: 72 / 2.54,
  mm: 72 / 25.4,
  pc: 12,
};

/**
 * Converts a CSS length (`12pt`, `16px`, `1.5em`, `120%`, `0.5in`) to points.
 * Unit-less numbers are pixels. Returns `undefined` for anything else
 * (`calc()`, `var()`, keywords) and clamps to ±1584 pt.
 */
export function cssLengthToPt(value: unknown, basePt = DOCX_BASE_FONT_PT): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? clampPt(value * UNIT_PT.px) : undefined;
  if (typeof value !== "string") return undefined;
  const match = /^\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*([a-z%]*)\s*$/i.exec(value);
  if (!match) return undefined;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase() || "px";
  let pt: number | undefined;
  if (unit === "em" || unit === "rem") pt = n * basePt;
  else if (unit === "%") pt = (n / 100) * basePt;
  else if (unit in UNIT_PT) pt = n * UNIT_PT[unit];
  return pt === undefined || !Number.isFinite(pt) ? undefined : clampPt(pt);
}

function clampPt(pt: number): number {
  return Math.max(-MAX_LEN_PT, Math.min(MAX_LEN_PT, pt));
}

/** Points → twentieths of a point (twips), as an integer. */
export const ptToTwips = (pt: number): number => Math.round(pt * 20);
/** Points → half-points (`w:sz`), at least 1. */
export const ptToHalfPoints = (pt: number): number => Math.max(1, Math.min(3276, Math.round(pt * 2)));
/** CSS pixels (96 dpi) → English Metric Units (images). */
export const pxToEmu = (px: number): number => Math.round(px * 9525);
/** CSS pixels (96 dpi) → twips. */
export const pxToTwips = (px: number): number => Math.round(px * 15);

/** Formats points for CSS, e.g. `12pt` or `10.5pt`. */
export function ptToCss(pt: number): string {
  return `${Math.round(pt * 100) / 100}pt`;
}

const NAMED_COLORS: Record<string, string> = {
  black: "000000",
  white: "FFFFFF",
  red: "FF0000",
  green: "008000",
  lime: "00FF00",
  blue: "0000FF",
  yellow: "FFFF00",
  cyan: "00FFFF",
  aqua: "00FFFF",
  magenta: "FF00FF",
  fuchsia: "FF00FF",
  gray: "808080",
  grey: "808080",
  silver: "C0C0C0",
  maroon: "800000",
  navy: "000080",
  olive: "808000",
  purple: "800080",
  teal: "008080",
  orange: "FFA500",
  pink: "FFC0CB",
};

/**
 * A CSS colour (`#abc`, `#aabbcc`, `#aabbccdd`, `rgb()` / `rgba()`, a few
 * names) as six upper-case hex digits, or `undefined`.
 */
export function cssColorToHex(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const color = value.trim().toLowerCase();
  if (color in NAMED_COLORS) return NAMED_COLORS[color];
  let match = /^#([0-9a-f]{3,4})$/.exec(color);
  if (match) return match[1].slice(0, 3).split("").map((c) => c + c).join("").toUpperCase();
  match = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(color);
  if (match) return match[1].toUpperCase();
  match = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(color);
  if (match) {
    return match
      .slice(1, 4)
      .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  }
  return undefined;
}

/** Word's highlight colours (`w:highlight`), by their RGB value. */
export const WORD_HIGHLIGHTS: Record<string, string> = {
  FFFF00: "yellow",
  "00FF00": "green",
  "00FFFF": "cyan",
  FF00FF: "magenta",
  "0000FF": "blue",
  FF0000: "red",
  "000080": "darkBlue",
  "008080": "darkCyan",
  "008000": "darkGreen",
  "800080": "darkMagenta",
  "800000": "darkRed",
  "808000": "darkYellow",
  "808080": "darkGray",
  C0C0C0: "lightGray",
  "000000": "black",
  FFFFFF: "white",
};
