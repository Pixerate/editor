// Portions ported from gridcraft/crates/numfmt/src/lib.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
/**
 * Excel number formats: format codes (`#,##0.00;[Red](#,##0.00)`, dates,
 * fractions, scientific…), the General format and the `TEXT()` worksheet
 * function. en-US only, 1900 date system.
 *
 * Our engine keeps dates as ISO text (`2026-03-04`, `2026-03-04 18:00:00`) and
 * times as day fractions; ISO text is converted to a 1900-system serial number
 * before formatting.
 */
import { parseNumberText, serialFromYmd, daysInMonth, timeFraction } from '../formula/parse-input';
import { FORMULA_ERRORS } from '../formula/values';
import { formatGeneralFit } from './decimal';
import { parseSections, testCond, type NumberFormatColor, type Section } from './parse';
import { Out, renderDate, renderGeneral, renderNumber, renderText } from './render';

export { formatGeneralFit } from './decimal';
export { builtinNumberFormat, builtinNumberFormatId } from './builtin';
export type { NumberFormatColor } from './parse';

/** Width (in characters) of General output, as in a default-width cell. */
const GENERAL_WIDTH = 11;
/** What Excel paints when a date is out of range. */
const OVERFLOW = '########';

/**
 * Longest number format code, in characters, that is parsed (Excel's own
 * limit). A longer code displays its value as General and makes `TEXT`
 * return `#VALUE!`. The cap also bounds work that scales with the code.
 */
export const MAX_NUMBER_FORMAT_CODE_CHARS = 255;

/** Best guess at the ribbon's number-format category. */
export type NumberFormatKind =
  | 'general'
  | 'number'
  | 'currency'
  | 'accounting'
  | 'date'
  | 'time'
  | 'percentage'
  | 'fraction'
  | 'scientific'
  | 'text'
  /** Zip codes, phone numbers, social security numbers. */
  | 'special'
  | 'custom';

/** A value formatted with a number format, ready to paint. */
export interface FormattedNumberValue {
  text: string;
  /** Colour from a `[Red]` / `[ColorN]` tag of the section used. */
  color?: NumberFormatColor;
  /**
   * Repeat-fill character from `*x` and its position (UTF-16 index) in
   * `text`; a renderer may repeat it to fill the cell width.
   */
  fill?: { char: string; index: number };
  /** True for numbers (right-aligned by default); text, booleans and errors are false. */
  numeric: boolean;
}

/** True when `code` is longer than `MAX_NUMBER_FORMAT_CODE_CHARS` characters. */
function tooLong(code: string): boolean {
  // A code of more than 255 UTF-16 units can still be short in characters; count only when needed.
  return code.length > MAX_NUMBER_FORMAT_CODE_CHARS && Array.from(code).length > MAX_NUMBER_FORMAT_CODE_CHARS;
}

const SPECIAL_CODES = ['00000', '00000-0000', '[<=9999999]###-####;(###) ###-####', '000-00-0000'];

/** A parsed number format code. Parsing never fails: malformed parts become literal text. */
export class NumberFormat {
  readonly code: string;
  private readonly general: boolean;
  private readonly sections: Section[];
  /** Sections that apply to numbers (a trailing text section is excluded). */
  private readonly numSections: number;
  /** Index of the section that applies to text, if any. */
  private readonly textSection: number | undefined;

  private constructor(code: string, uncapped: boolean) {
    this.code = code;
    const trimmed = code.trim();
    // `checkbox` marks a checkbox cell: any value displays as General.
    if (trimmed === '' || trimmed.toLowerCase() === 'general' || trimmed === 'checkbox' || (!uncapped && tooLong(code))) {
      this.general = true;
      this.sections = [];
      this.numSections = 0;
      this.textSection = undefined;
      return;
    }
    this.general = false;
    this.sections = parseSections(code);
    const len = this.sections.length;
    const lastIsText = this.sections[len - 1]?.kind === 'text';
    this.textSection = len >= 4 ? 3 : lastIsText ? len - 1 : undefined;
    this.numSections = len >= 4 ? 3 : lastIsText ? len - 1 : len;
  }

  /**
   * Parses a format code. Never throws: unknown or malformed parts degrade to
   * literal text, and a code longer than 255 characters degrades to General.
   */
  static parse(code: string): NumberFormat {
    return new NumberFormat(code, false);
  }

  /** `parse` without the 255-character cap (for tests that reach renderer edge cases). */
  static parseUncapped(code: string): NumberFormat {
    return new NumberFormat(code, true);
  }

  /** Like `parse`, but remembers recently parsed codes (bounded), so formatting many values parses a code once. */
  static parseCached(code: string): NumberFormat {
    if (code.length > CACHE_MAX_CODE_LENGTH) return NumberFormat.parse(code);
    let fmt = parseCache.get(code);
    if (!fmt) {
      fmt = NumberFormat.parse(code);
      if (parseCache.size >= CACHE_CAPACITY) parseCache.clear();
      parseCache.set(code, fmt);
    }
    return fmt;
  }

  static general(): NumberFormat {
    return NumberFormat.parse('General');
  }

  isGeneral(): boolean {
    return this.general;
  }

  private numberSections(): Section[] {
    return this.sections.slice(0, this.numSections);
  }

  /** True when the code contains date or time tokens. */
  isDate(): boolean {
    return this.numberSections().some((s) => s.kind === 'date');
  }

  isPercent(): boolean {
    return this.numberSections().some((s) => s.kind === 'number' && s.percent > 0);
  }

  /** True for a pure text format such as `@`. */
  isText(): boolean {
    return this.numSections === 0 && this.textSection !== undefined;
  }

  /** Best guess at the format category. */
  kind(): NumberFormatKind {
    if (this.general) return 'general';
    if (this.isText()) return 'text';
    if (SPECIAL_CODES.includes(this.code)) return 'special';
    const s = this.sections[0];
    if (!s) return 'custom';
    if (s.kind === 'general') return 'general';
    if (s.kind === 'text') return 'text';
    if (s.kind === 'date') {
      const calendar = s.toks.some((t) => t.t === 'date' && (t.d.k === 'year' || t.d.k === 'month' || t.d.k === 'day'));
      return calendar ? 'date' : 'time';
    }
    if (s.fraction) return 'fraction';
    if (s.exp) return 'scientific';
    if (s.percent > 0) return 'percentage';
    if (s.fill && s.hasDigits) return 'accounting';
    if (s.currency && s.hasDigits) return 'currency';
    if (s.hasDigits) return 'number';
    return 'custom';
  }

  /**
   * Picks the number section for `v`, and whether the minus sign is dropped
   * (a negative section shows the absolute value). Null means General.
   */
  private select(v: number): { sec: Section; dropSign: boolean } | null {
    const secs = this.numberSections();
    const k = secs.length;
    const s0 = secs[0];
    if (!s0) return null;
    const c0 = s0.cond;
    const c1 = secs[1]?.cond;
    if (c0 || c1) {
      let idx: number;
      if (c0 && testCond(c0, v)) idx = 0;
      else if (c1 && testCond(c1, v)) idx = 1;
      else if (c0 && c1) idx = 2;
      else if (!c0) idx = 0;
      else idx = 1;
      // Excel never adds a minus sign in a multi-section conditional format.
      const sec = secs[idx];
      return sec ? { sec, dropSign: k >= 2 } : null;
    }
    if (v < 0 && k >= 2) return { sec: secs[1], dropSign: true };
    if (v === 0 && k >= 3) return { sec: secs[2], dropSign: false };
    return { sec: s0, dropSign: false };
  }

  /**
   * Formats a number. `overflow` is true when the value can't be shown (a
   * date out of range, painted as `########`).
   */
  formatNumber(n: number): FormattedNumberValue & { overflow: boolean } {
    const general = (): FormattedNumberValue & { overflow: boolean } => ({
      text: formatGeneralFit(n, GENERAL_WIDTH) ?? OVERFLOW,
      numeric: true,
      overflow: false,
    });
    if (!Number.isFinite(n)) return { text: '#NUM!', numeric: false, overflow: true };
    if (this.general) return general();
    const picked = this.select(n);
    if (!picked) return general();
    const { sec, dropSign } = picked;
    const minus = n < 0 && !dropSign;
    let out: Out | null;
    switch (sec.kind) {
      case 'text':
        out = renderText(sec, formatGeneralFit(n, GENERAL_WIDTH) ?? '');
        break;
      case 'general':
        out = renderGeneral(sec, Math.abs(n), minus ? GENERAL_WIDTH - 1 : GENERAL_WIDTH);
        break;
      case 'date':
        out = minus ? null : renderDate(sec, Math.abs(n));
        break;
      default:
        out = renderNumber(sec, Math.abs(n));
    }
    if (!out) return withColor({ text: OVERFLOW, numeric: true, overflow: true }, sec.color);
    // Excel drops the minus sign when the section shows a negative number as all zeros.
    if (minus && sec.kind !== 'text' && !out.zero) out.prepend('-');
    return withColor({ text: out.text, numeric: true, overflow: false, ...(out.fill ? { fill: out.fill } : {}) }, sec.color);
  }

  /** Formats text through the text section (`@`), or returns it unchanged. */
  formatText(text: string): FormattedNumberValue {
    const sec = this.textSection === undefined ? undefined : this.sections[this.textSection];
    if (!sec) return { text, numeric: false };
    const out = renderText(sec, text);
    return withColor({ text: out.text, numeric: false, ...(out.fill ? { fill: out.fill } : {}) }, sec.color);
  }

  /**
   * Formats a cell value: numbers through the number sections, ISO date text
   * (`2026-03-04`, `2026-03-04 18:00:00`) and `Date`s as serial numbers, other
   * text through the text section; booleans show TRUE/FALSE and error values
   * themselves.
   */
  format(value: unknown): FormattedNumberValue {
    if (value === '' || value === null || value === undefined) return { text: '', numeric: false };
    if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE', numeric: false };
    if (typeof value === 'number') {
      const { overflow: _overflow, ...rest } = this.formatNumber(value);
      return rest;
    }
    if (typeof value === 'string' && FORMULA_ERRORS.has(value)) return { text: value, numeric: false };
    const serial = dateValueToSerial(value);
    if (serial !== null) {
      const { overflow: _overflow, ...rest } = this.formatNumber(serial);
      return rest;
    }
    return this.formatText(String(value));
  }
}

function withColor<T extends FormattedNumberValue>(value: T, color: NumberFormatColor | undefined): T {
  if (color) value.color = color;
  return value;
}

// --- Parse cache ---

/** Most codes kept. A full cache is emptied, so memory stays bounded. */
const CACHE_CAPACITY = 64;
/** Longer codes are parsed every time and never stored. */
const CACHE_MAX_CODE_LENGTH = 256;
const parseCache = new Map<string, NumberFormat>();

/** Empties the parse cache used by `NumberFormat.parseCached` (mainly for tests). */
export function clearNumberFormatCache(): void {
  parseCache.clear();
}

// --- Dates ---

const ISO_DATE_TIME = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?$/;

/**
 * 1900-system serial number of a date value: ISO date text (with an optional
 * time) or a `Date` (its local date and time). Null for anything else.
 */
export function dateValueToSerial(value: unknown): number | null {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    const serial = serialFromYmd(value.getFullYear(), value.getMonth() + 1, value.getDate());
    return serial === null ? null : serial + timeFraction(value.getHours(), value.getMinutes(), value.getSeconds() + value.getMilliseconds() / 1000);
  }
  if (typeof value !== 'string' || value.length < 8 || value.length > 30) return null;
  const m = ISO_DATE_TIME.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  const serial = serialFromYmd(y, mo, d);
  if (serial === null) return null;
  if (m[4] === undefined) return serial;
  const [hh, mm, ss] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (hh > 23 || mm > 59 || ss >= 60) return null;
  return serial + timeFraction(hh, mm, ss);
}

// --- Public helpers ---

/** Formats a cell value with a format code (see `NumberFormat.format`). */
export function formatNumberFormatValue(value: unknown, code: string): FormattedNumberValue {
  return NumberFormat.parseCached(code).format(value);
}

/**
 * The `TEXT()` worksheet function: formats a value with a format code.
 * Blanks count as 0; numeric and date text (`"5"`, `"3/4/2026"`,
 * `"2026-03-04"`) is converted to a number first; other text and booleans
 * (as TRUE/FALSE) go through the text section, or are returned as is.
 * Errors: the value's own error, `#VALUE!` for a code over 255 characters or
 * a date out of range, `#NUM!` for a non-finite number.
 */
export function formatTextFunction(value: unknown, code: string): { text: string } | { error: string } {
  if (typeof value === 'string' && FORMULA_ERRORS.has(value)) return { error: value };
  if (code === '') return { text: '' };
  if (tooLong(code)) return { error: '#VALUE!' };
  const fmt = NumberFormat.parseCached(code);
  let n: number;
  if (value === '' || value === null || value === undefined) n = 0;
  else if (typeof value === 'number') n = value;
  else if (typeof value === 'boolean') return { text: fmt.formatText(value ? 'TRUE' : 'FALSE').text };
  else {
    const serial = dateValueToSerial(value);
    const parsed = serial ?? (typeof value === 'string' ? parseNumberText(value) : null);
    if (parsed === null) return { text: fmt.formatText(String(value)).text };
    n = parsed;
  }
  if (!Number.isFinite(n)) return { error: '#NUM!' };
  const f = fmt.formatNumber(n);
  return f.overflow ? { error: '#VALUE!' } : { text: f.text };
}

/** Excel's default 56-colour palette, for `[Color1]`…`[Color56]`. */
const INDEXED_COLORS = [
  '#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF',
  '#800000', '#008000', '#000080', '#808000', '#800080', '#008080', '#C0C0C0', '#808080',
  '#9999FF', '#993366', '#FFFFCC', '#CCFFFF', '#660066', '#FF8080', '#0066CC', '#CCCCFF',
  '#000080', '#FF00FF', '#FFFF00', '#00FFFF', '#800080', '#800000', '#008080', '#0000FF',
  '#00CCFF', '#CCFFFF', '#CCFFCC', '#FFFF99', '#99CCFF', '#FF99CC', '#CC99FF', '#FFCC99',
  '#3366FF', '#33CCCC', '#99CC00', '#FFCC00', '#FF9900', '#FF6600', '#666699', '#969696',
  '#003366', '#339966', '#003300', '#333300', '#993300', '#993366', '#333399', '#333333',
];

const NAMED_CSS: Record<string, string> = {
  black: '#000000',
  blue: '#0000FF',
  cyan: '#00FFFF',
  green: '#00FF00',
  magenta: '#FF00FF',
  red: '#FF0000',
  white: '#FFFFFF',
  yellow: '#FFFF00',
};

/** CSS colour for a format colour (`red` → `#FF0000`, `color10` → `#008000`). */
export function numberFormatColorToCss(color: NumberFormatColor): string {
  const named = NAMED_CSS[color];
  if (named) return named;
  return INDEXED_COLORS[Number(color.slice(5)) - 1] ?? '#000000';
}
