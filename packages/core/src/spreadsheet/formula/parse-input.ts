// Portions ported from gridcraft/crates/core/src/parse.rs and gridcraft/crates/core/src/date.rs
// (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
/**
 * Parsing what people type into a cell (and numeric text in formulas).
 *
 * Recognises numbers with thousands separators, percentages, currency,
 * scientific notation, fractions (`1 1/2`), dates (`3/4/2026`, `2026-03-04`,
 * `4-Mar-2026`, `Mar 4, 2026`), times (`10:30`, `10:30:15 PM`) and
 * date-times. Locale: en-US (month/day/year).
 *
 * Representation: our engine keeps dates as ISO text (`2026-03-04`, or
 * `2026-03-04 18:00:00` with a time), so a typed date becomes ISO text, not a
 * serial number. A time typed on its own (`12:00`) has no date to anchor ISO
 * text to, so it becomes a fraction of a day (0.5), as in Excel.
 */
import type { CellFormat } from '../types';
import { FORMULA_ERRORS } from './values';

/** Kind of automatic number format chosen for typed input. */
export type CellInputFormatKind = 'number' | 'currency' | 'percentage' | 'date' | 'time';

export interface ParsedCellInput {
  /** The typed value: number, boolean, ISO date text, error code or text. `''` for empty input. */
  value: string | number | boolean;
  type: 'empty' | 'text' | 'number' | 'boolean' | 'error' | 'date';
  /**
   * Number format code Excel would apply automatically (e.g. `"$"#,##0.00`,
   * `0%`, `#,##0`, `m/d/yyyy`, `h:mm`), or undefined for General.
   */
  numberFormat?: string;
  /** What kind of format that is, if any. */
  formatKind?: CellInputFormatKind;
  /** `formatKind` mapped onto `CellFormat` (times have no `CellFormat` and map to undefined). */
  cellFormat?: CellFormat;
}

// --- Date helpers (from date.rs) ---

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if ([4, 6, 9, 11].includes(month)) return 30;
  return month >= 1 && month <= 12 ? 31 : 0;
}

/**
 * Days in a month of Excel's 1900 date system: February 1900 has 29 days
 * (serial 60 is the fictitious 1900-02-29, kept for Lotus 1-2-3 compatibility).
 */
export const daysInMonth1900 = (year: number, month: number): number =>
  year === 1900 && month === 2 ? 29 : daysInMonth(year, month);

const UNIX_1899_12_30 = -25569;
const MAX_SERIAL_1900 = 2_958_465; // 9999-12-31

/**
 * Excel 1900-system serial for a date (1 = 1900-01-01, 60 = the fictitious
 * 1900-02-29). Month and day overflow roll over like `DATE()`; years 0–1899
 * are added to 1900. Null before the epoch or after 9999-12-31.
 */
export function serialFromYmd(year: number, month: number, day: number): number | null {
  if (![year, month, day].every(Number.isSafeInteger)) return null;
  let y = year >= 0 && year < 1900 ? year + 1900 : year;
  const m0 = month - 1;
  y += Math.floor(m0 / 12);
  const m = (((m0 % 12) + 12) % 12) + 1;
  if (y < 1900 || y > 9999) return null;
  // Up to February 1900 the serial is one lower than the day count from 1899-12-30.
  const first = daysFromCivil(y, m, 1) - UNIX_1899_12_30 - (y === 1900 && m <= 2 ? 1 : 0);
  const serial = first + day - 1;
  return serial >= 0 && serial <= MAX_SERIAL_1900 ? serial : null;
}

/** Fraction of a day for a time. */
export const timeFraction = (h: number, m: number, s: number): number => (h * 3600 + m * 60 + s) / 86400;

/** The year used for dates typed without one. */
const currentYear = (): number => new Date().getFullYear();

// --- Parsing (from parse.rs) ---

interface DateParts {
  year: number;
  month: number;
  day: number;
  /** Fraction of a day, when a time was typed. */
  time?: number;
}

type Numeric =
  | { kind: 'number'; value: number; format?: string }
  | { kind: 'date'; date: DateParts; format: string }
  | { kind: 'time'; value: number; format: string };

/**
 * Interprets typed cell input (not formulas). Text that isn't a number,
 * date, time, boolean or error stays text; a leading apostrophe forces text.
 */
export function parseCellInput(input: string): ParsedCellInput {
  if (input === '') return { value: '', type: 'empty' };
  if (input.startsWith("'")) return { value: input.slice(1), type: 'text' };
  const t = input.trim();
  const upper = t.toUpperCase();
  if (upper === 'TRUE') return { value: true, type: 'boolean' };
  if (upper === 'FALSE') return { value: false, type: 'boolean' };
  if (FORMULA_ERRORS.has(upper)) return { value: upper, type: 'error' };
  const numeric = parseNumeric(t);
  if (numeric) {
    if (numeric.kind === 'date') {
      const iso = isoText(numeric.date);
      // ISO text can't hold the fictitious 1900-02-29: it stays text.
      if (iso !== null) {
        return { value: iso, type: 'date', numberFormat: numeric.format, formatKind: 'date', cellFormat: 'date' };
      }
    } else {
      const formatKind = numeric.kind === 'time' ? 'time' : formatKindOf(numeric.format);
      return {
        value: normalizeZero(numeric.value),
        type: 'number',
        ...(numeric.format ? { numberFormat: numeric.format } : {}),
        ...(formatKind ? { formatKind } : {}),
        ...(formatKind && formatKind !== 'time' ? { cellFormat: formatKind } : {}),
      };
    }
  }
  return { value: input, type: 'text' };
}

/**
 * Numeric text as arithmetic coerces it ("1,000", "50%", "$3", "1/2/2020",
 * "10:00"); dates become 1900-system serial numbers. Null when it isn't numeric.
 */
export function parseNumberText(text: string): number | null {
  const numeric = parseNumeric(text.trim());
  if (!numeric) return null;
  if (numeric.kind !== 'date') return normalizeZero(numeric.value);
  const { year, month, day, time = 0 } = numeric.date;
  const serial = serialFromYmd(year, month, day);
  return serial === null ? null : serial + time;
}

const normalizeZero = (n: number) => (n === 0 ? 0 : n);

function formatKindOf(format: string | undefined): CellInputFormatKind | undefined {
  if (!format) return undefined;
  if (format.includes('$')) return 'currency';
  if (format.includes('%')) return 'percentage';
  return 'number';
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** ISO text for parsed date parts, or null for the fictitious 1900-02-29. */
function isoText({ year, month, day, time }: DateParts): string | null {
  if (day > daysInMonth(year, month)) return null;
  const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  if (time === undefined) return date;
  let seconds = Math.round(time * 86400);
  if (seconds >= 86400) seconds = 86399; // never roll a typed time into the next day
  return `${date} ${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

function parseNumeric(t: string): Numeric | null {
  if (t === '') return null;
  // Parenthesised negatives: (100) = -100.
  if (t.startsWith('(') && t.endsWith(')') && t.length >= 2) {
    const inner = parseNumeric(t.slice(1, -1).trim());
    if (!inner || inner.kind === 'date') return null;
    return { ...inner, value: -inner.value };
  }
  const plain = parsePlain(t);
  if (plain) return plain;
  const fraction = parseFraction(t);
  if (fraction !== null) return { kind: 'number', value: fraction, format: '# ?/?' };
  return parseDateTime(t);
}

const startsWithDigitOrDot = (s: string) => /^[0-9.]/.test(s);

/** Signs, currency, thousands separators, percent, exponent. */
function parsePlain(t: string): Numeric | null {
  let s = t;
  let neg = false;
  let currency = false;
  let percent = false;
  if (s.startsWith('-')) {
    neg = true;
    s = s.slice(1).trimStart();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trimStart();
  }
  if (s.startsWith('$')) {
    currency = true;
    s = s.slice(1).trimStart();
    if (!neg && s.startsWith('-')) {
      neg = true;
      s = s.slice(1);
    }
  }
  if (s.endsWith('%')) {
    percent = true;
    s = s.slice(0, -1).trimEnd();
  }
  if (s === '') return null;
  const hasSep = s.includes(',');
  let digits: string;
  if (hasSep) {
    // Thousands separators must be in groups of three before the decimal point.
    const dot = s.indexOf('.');
    const int = dot === -1 ? s : s.slice(0, dot);
    const frac = dot === -1 ? null : s.slice(dot + 1);
    const groups = int.split(',');
    const first = groups[0];
    if (first === '' || first.length > 3 || groups.slice(1).some((g) => g.length !== 3)) return null;
    digits = groups.join('') + (frac !== null ? `.${frac}` : '');
  } else {
    digits = s;
  }
  if (!/^[0-9.eE+-]+$/.test(digits) || !startsWithDigitOrDot(digits)) return null;
  // Rust's f64 parser accepts exactly decimal literals; JS `Number` is looser
  // ("1." and "1e" differ), so check the shape too.
  if (!/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(digits)) return null;
  let n = Number(digits);
  if (!Number.isFinite(n)) return null;
  const sci = /[eE]/.test(digits);
  if (percent) n /= 100;
  if (neg) n = -n;
  const hasDot = digits.includes('.');
  const format = currency
    ? hasDot ? '"$"#,##0.00' : '"$"#,##0'
    : percent
      ? hasDot ? '0.00%' : '0%'
      : sci
        ? '0.00E+00'
        : hasSep
          ? hasDot ? '#,##0.00' : '#,##0'
          : undefined;
  return { kind: 'number', value: n, ...(format ? { format } : {}) };
}

const parseDecimal = (s: string): number | null =>
  /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number(s) : null;

/** `1 1/2`, `0 3/4` (a bare `1/2` is a date). */
function parseFraction(t: string): number | null {
  const space = t.indexOf(' ');
  if (space === -1) return null;
  const whole = t.slice(0, space);
  const frac = t.slice(space + 1).trim();
  const neg = whole.startsWith('-');
  const w = parseDecimal(whole.replace(/^-+/, ''));
  const slash = frac.indexOf('/');
  if (w === null || slash === -1) return null;
  const a = parseDecimal(frac.slice(0, slash));
  const b = parseDecimal(frac.slice(slash + 1));
  if (a === null || b === null || b === 0 || !Number.isFinite(w)) return null;
  const v = w + a / b;
  return neg ? -v : v;
}

function monthFromName(s: string): number | null {
  const l = s.toLowerCase();
  if (l.length < 3) return null;
  const index = MONTH_NAMES.findIndex((m) => m.toLowerCase().startsWith(l));
  return index === -1 ? null : index + 1;
}

/** `h:mm`, `h:mm:ss`, `h:mm:ss.000`, `h AM`, with optional AM/PM. */
function parseTime(input: string): { fraction: number; seconds: boolean; ampm: boolean } | null {
  const lower = input.trim().toLowerCase();
  let body = lower;
  let pm: boolean | null = null;
  for (const [suffix, isPm] of [['am', false], ['a', false], ['pm', true], ['p', true]] as const) {
    if (lower.endsWith(suffix)) {
      body = lower.slice(0, -suffix.length).trim();
      pm = isPm;
      break;
    }
  }
  const parts = body.split(':');
  if (parts.length === 1 && pm === null) return null;
  if (parts.length > 3 || parts.some((p) => p === '')) return null;
  const num = (p: string | undefined) => (p === undefined ? 0 : parseDecimal(p));
  let h = num(parts[0]);
  const m = num(parts[1]);
  const s = num(parts[2]);
  if (h === null || m === null || s === null) return null;
  if (m >= 60 || s >= 60 || h < 0 || m < 0 || s < 0) return null;
  if (pm !== null) {
    if (h > 12) return null;
    if (h === 12) h = 0;
    if (pm) h += 12;
  } else if (h >= 10000) {
    return null;
  }
  return { fraction: timeFraction(h, m, s), seconds: parts.length === 3, ampm: pm !== null };
}

const expandYear = (text: string, y: number) => (text.length <= 2 ? (y < 30 ? 2000 + y : 1900 + y) : y);

function validYmd(year: number, month: number, day: number): DateParts | null {
  // Dates before 1900 stay text (`DATE()` would add 1900 to such a year).
  if (month < 1 || month > 12 || day < 1 || year < 1900 || year > 9999) return null;
  if (day > daysInMonth1900(year, month)) return null;
  return { year, month, day };
}

function parseDate(input: string): { date: DateParts; format: string } | null {
  const t = input.trim().replace(/,+$/, '');
  const num = (s: string) => (/^[+-]?\d+$/.test(s.trim()) ? Number(s.trim()) : null);
  const withFormat = (date: DateParts | null, format: string) => (date ? { date, format } : null);
  const parts = t.split(/[/.-]/);
  if (parts.length === 3) {
    const [a, b, c] = parts.map((p) => p.trim());
    // ISO yyyy-mm-dd or yyyy/mm/dd
    if (a.length === 4) {
      const [y, m, d] = [num(a), num(b), num(c)];
      if (y !== null && m !== null && d !== null) return withFormat(validYmd(y, m, d), 'yyyy-mm-dd');
    }
    {
      const [m, d, y] = [num(a), num(b), num(c)];
      if (m !== null && d !== null && y !== null) return withFormat(validYmd(expandYear(c, y), m, d), 'm/d/yyyy');
    }
    // 4-Mar-2026
    const [d, m, y] = [num(a), monthFromName(b), num(c)];
    if (d !== null && m !== null && y !== null) return withFormat(validYmd(expandYear(c, y), m, d), 'd-mmm-yy');
  }
  if (parts.length === 2) {
    const [a, b] = parts.map((p) => p.trim());
    const [x, y] = [num(a), num(b)];
    if (x !== null && y !== null) {
      // m/d in the current year
      if (x >= 1 && x <= 12 && y >= 1 && y <= 31) return withFormat(validYmd(currentYear(), x, y), 'd-mmm');
      // m/yyyy
      if (x >= 1 && x <= 12 && b.length === 4) return withFormat(validYmd(y, x, 1), 'mmm-yy');
    }
    const dayA = num(a);
    const monthB = monthFromName(b);
    if (dayA !== null && monthB !== null) return withFormat(validYmd(currentYear(), monthB, dayA), 'd-mmm');
    const monthA = monthFromName(a);
    const yearB = num(b);
    if (monthA !== null && yearB !== null) return withFormat(validYmd(expandYear(b, yearB), monthA, 1), 'mmm-yy');
  }
  // "Mar 4, 2026" / "March 4 2026" / "4 March 2026"
  const words = t.split(/[ ,]/).filter((w) => w !== '');
  if (words.length === 3) {
    const [w0, w1, w2] = words;
    let [m, d, y] = [monthFromName(w0), num(w1), num(w2)];
    if (m !== null && d !== null && y !== null) return withFormat(validYmd(expandYear(w2, y), m, d), 'd-mmm-yy');
    [d, m, y] = [num(w0), monthFromName(w1), num(w2)];
    if (d !== null && m !== null && y !== null) return withFormat(validYmd(expandYear(w2, y), m, d), 'd-mmm-yy');
  }
  return null;
}

function parseDateTime(t: string): Numeric | null {
  const time = parseTime(t);
  if (time) {
    const format =
      time.fraction >= 1
        ? '[h]:mm:ss' // 24 hours or more: elapsed hours
        : time.seconds
          ? time.ampm ? 'h:mm:ss AM/PM' : 'h:mm:ss'
          : time.ampm ? 'h:mm AM/PM' : 'h:mm';
    return { kind: 'time', value: time.fraction, format };
  }
  const date = parseDate(t);
  if (date) return { kind: 'date', date: date.date, format: date.format };
  // date + time: split at a space before a time-looking tail.
  for (let i = t.indexOf(' '); i !== -1; i = t.indexOf(' ', i + 1)) {
    const d = parseDate(t.slice(0, i));
    const tm = d ? parseTime(t.slice(i + 1)) : null;
    // A date-time's time of day must stay within the day.
    if (d && tm && tm.fraction < 1) {
      return { kind: 'date', date: { ...d.date, time: tm.fraction }, format: 'm/d/yyyy h:mm' };
    }
  }
  return null;
}
