// Portions ported from gridcraft/crates/core/src/value.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
/**
 * Value helpers shared by the formula evaluator and the built-in functions:
 * error values, spreadsheet coercion rules, comparisons, ranges and dates.
 */
import { parseNumberText } from './parse-input';

/** Spreadsheet error values. They propagate through operators and functions. */
export const FORMULA_ERRORS = new Set([
  '#DIV/0!',
  '#VALUE!',
  '#REF!',
  '#NAME?',
  '#N/A',
  '#NUM!',
  '#CYCLE!',
  '#ERROR!',
  '#SPILL!',
  '#CALC!'
]);

export type FormulaErrorCode =
  | '#DIV/0!'
  | '#VALUE!'
  | '#REF!'
  | '#NAME?'
  | '#N/A'
  | '#NUM!'
  | '#CYCLE!'
  | '#ERROR!'
  | '#SPILL!'
  | '#CALC!';

export function isFormulaError(value: unknown): value is string {
  return typeof value === 'string' && FORMULA_ERRORS.has(value);
}

export const isBlank = (value: unknown): boolean => value === '' || value === null || value === undefined;

/**
 * Coerces to a number like arithmetic does: blanks are 0, booleans 1/0,
 * numeric text parses (`"1,000"`, `"50%"`, `"$3"`, `"(5)"`, dates and times
 * as serial numbers), other text is #VALUE!.
 */
export function toNumber(value: unknown): number | string {
  if (isFormulaError(value)) return value;
  if (isBlank(value)) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  return parseNumberText(String(value)) ?? '#VALUE!';
}

/** Coerces to a boolean: numbers are non-zero, "TRUE"/"FALSE" text is parsed, other text is #VALUE!. */
export function toBoolean(value: unknown): boolean | string {
  if (isFormulaError(value)) return value;
  if (isBlank(value)) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const upper = String(value).trim().toUpperCase();
  if (upper === 'TRUE') return true;
  if (upper === 'FALSE') return false;
  return '#VALUE!';
}

/** Coerces to text like `&` does: numbers use up to 15 significant digits (`0.1+0.2` is "0.3"). */
export const toText = (value: unknown): string =>
  isBlank(value)
    ? ''
    : typeof value === 'boolean'
      ? (value ? 'TRUE' : 'FALSE')
      : typeof value === 'number'
        ? numberToText(value)
        : String(value);

/**
 * Number to text as Excel converts it in `&` and General display: up to 15
 * significant digits, scientific for very large or very small magnitudes.
 */
export function numberToText(n: number): string {
  if (n === 0 || !Number.isFinite(n)) return '0';
  const a = Math.abs(n);
  if (((a < 1e-9 || a >= 1e15) && Math.round(a) !== a) || a >= 1e15) return sciText(n, 15);
  let mag = Math.floor(Math.log10(a));
  if (a >= Math.pow(10, mag + 1)) mag++; // log10 can land just below an exact power of ten
  const decimals = Math.min(Math.max(14 - mag, 0), 30);
  return trimDecimal(n.toFixed(decimals));
}

/** Removes trailing zeros (and a trailing point) from a decimal string. */
function trimDecimal(s: string): string {
  if (!s.includes('.')) return s;
  const t = s.replace(/0+$/, '').replace(/\.$/, '');
  return t === '-0' ? '0' : t;
}

/** Scientific text like `1.23456789012346E+15` with up to `sig` significant digits. */
function sciText(n: number, sig: number): string {
  const [mantissa, exp] = n.toExponential(Math.max(sig - 1, 0)).split('e');
  const e = Number(exp);
  return `${trimDecimal(mantissa)}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
}

/**
 * Number held by a value, or null. Typed cell values are stored as text, so
 * numeric text ("120") counts as a number here; booleans and blanks do not.
 */
export function numericValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || FORMULA_ERRORS.has(value)) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

/** Normalizes a cell value for lookups and criteria: numeric text becomes a number. */
export function normalizeValue(value: unknown): unknown {
  const num = typeof value === 'string' ? numericValue(value) : null;
  return num === null ? value : num;
}

/** `ERROR.TYPE`-style order of error values, used when two errors are compared. */
const ERROR_ORDER = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#SPILL!', '#CALC!', '#CYCLE!', '#ERROR!'];

/** Type rank for comparison and sorting: numbers < text < booleans < errors; blanks rank last. */
function valueRank(value: unknown): number {
  if (isBlank(value)) return 4;
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return 2;
  if (typeof value === 'string' && FORMULA_ERRORS.has(value)) return 3;
  return 1;
}

/**
 * Compares numbers the way Excel does: both are rounded to 15 significant
 * digits first, so binary noise such as `0.1+0.2` versus `0.3` counts as equal.
 */
export function compareNumbers(a: number, b: number): number {
  if (a === b) return 0;
  // Numbers further apart than the 15th digit can't round together, and
  // rounding keeps their order: skip the rounding on the sort hot path.
  if (Math.abs(a - b) > Math.max(Math.abs(a), Math.abs(b)) * 1e-13) return a < b ? -1 : 1;
  const round15 = (x: number) => (!Number.isFinite(x) || x === 0 ? x : Number(x.toExponential(14)));
  const x = round15(a);
  const y = round15(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Case-insensitive text order. */
export function compareText(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Excel's comparison for the `=`, `<>`, `<`… operators: numbers < text <
 * booleans < errors, numbers compared at 15 significant digits, text
 * case-insensitively. A blank acts as 0, "" or FALSE depending on the other
 * side. Dates are ISO text: two ISO dates compare chronologically
 * ("2026-1-5" is before "2026-01-10"), and an ISO date against a number
 * compares as its serial number.
 */
export function compareValues(left: unknown, right: unknown): number {
  const lRank = valueRank(left);
  const rRank = valueRank(right);
  if (lRank === 4 || rRank === 4) {
    if (lRank === rRank) return 0;
    // A blank against a number, text or boolean takes that type's empty value.
    const blankFirst = lRank === 4;
    const other = blankFirst ? right : left;
    const otherRank = blankFirst ? rRank : lRank;
    let cmp: number;
    if (otherRank === 0) cmp = compareNumbers(0, other as number);
    else if (otherRank === 1) cmp = String(other) === '' ? 0 : -1;
    else if (otherRank === 2) cmp = other ? -1 : 0;
    else return lRank - rRank;
    return blankFirst ? cmp : -cmp;
  }
  if (lRank === 1 && rRank === 1) {
    const a = String(left);
    const b = String(right);
    const ta = isoDateTime(a);
    const tb = ta === null ? null : isoDateTime(b);
    if (ta !== null && tb !== null) return Math.sign(ta - tb);
    return compareText(a, b);
  }
  if ((lRank === 0 && rRank === 1) || (lRank === 1 && rRank === 0)) {
    const date = parseIsoDate(lRank === 1 ? left : right);
    if (date) {
      const serial = dateToSerial(date);
      return lRank === 0 ? compareNumbers(left as number, serial) : compareNumbers(serial, right as number);
    }
  }
  if (lRank !== rRank) return lRank - rRank;
  if (lRank === 0) return compareNumbers(left as number, right as number);
  if (lRank === 2) return Number(left) - Number(right);
  return Math.sign(ERROR_ORDER.indexOf(left as string) - ERROR_ORDER.indexOf(right as string));
}

/**
 * Sort order (ascending): numbers, text, booleans, errors, then blanks last.
 * Errors are equal to each other, so sorting keeps their order.
 */
export function sortCompareValues(left: unknown, right: unknown): number {
  const lBlank = isBlank(left);
  const rBlank = isBlank(right);
  if (lBlank || rBlank) return lBlank === rBlank ? 0 : lBlank ? 1 : -1;
  if (isFormulaError(left) && isFormulaError(right)) return 0;
  return compareValues(left, right);
}

/** Rounds half away from zero, compensating for binary floating point (ROUND(1.005, 2) = 1.01). */
export function roundHalfAwayFromZero(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  return (Math.sign(value) * Math.round(scaled)) / factor;
}

/** Strips binary floating point noise (0.1 * 3 = 0.30000000000000004 -> 0.3). */
export const cleanFloat = (value: number): number => Number(value.toPrecision(15));

export function colNameToIndex(col: string): number {
  let index = 0;
  const upper = col.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    index = index * 26 + (upper.charCodeAt(i) - 65 + 1);
  }
  return index - 1;
}

export function indexToColName(index: number): string {
  let num = index + 1;
  let name = '';
  while (num > 0) {
    const mod = (num - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    num = Math.floor((num - mod) / 26);
  }
  return name;
}

// --- Ranges ---

/**
 * A rectangular block of values. `values` is column-major (the order in which
 * `EvaluationContext.resolveRange` returns cells): `values[col * rows + row]`.
 */
export interface FormulaRange {
  rows: number;
  cols: number;
  values: any[];
}

/** Shapes of the arrays produced by range references and range-returning functions. */
const rangeShapes = new WeakMap<any[], { rows: number; cols: number }>();

/** Records the shape of a column-major array so functions can treat it as a 2D range. */
export function withRangeShape<T extends any[]>(values: T, rows: number, cols: number): T {
  rangeShapes.set(values, { rows, cols });
  return values;
}

/** Views an array as a range. Arrays without a known shape are a single column. */
export function toFormulaRange(values: any[]): FormulaRange {
  const shape = rangeShapes.get(values);
  if (shape && shape.rows * shape.cols === values.length) return { ...shape, values };
  return { rows: values.length, cols: 1, values };
}

export const rangeGet = (range: FormulaRange, row: number, col: number): any =>
  row < range.rows && col < range.cols ? range.values[col * range.rows + row] : '';

/** Builds a column-major array (with its shape recorded) from a sub-block of a range. */
export function sliceRange(
  range: FormulaRange,
  rowStart: number,
  rowCount: number,
  colStart: number,
  colCount: number,
): any[] {
  const out: any[] = [];
  for (let c = colStart; c < colStart + colCount; c++) {
    for (let r = rowStart; r < rowStart + rowCount; r++) out.push(rangeGet(range, r, c));
  }
  return withRangeShape(out, rowCount, colCount);
}

// --- Dates ---
//
// Dates are ISO text ("2026-01-31", or "2026-01-31 13:45:00" with a time), as
// returned by TODAY(). Numbers are read as spreadsheet serial dates (days since
// 1899-12-30), so values pasted from Excel or Numbers still work.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Parses a date value (ISO text, serial number or Date) into a local Date, or null. */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return serialToDate(value);
  if (typeof value !== 'string' || FORMULA_ERRORS.has(value)) return null;
  const text = value.trim();
  if (text === '') return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (iso) {
    const [, y, m, d, hh = '0', mm = '0', ss = '0'] = iso;
    const date = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
    // Reject impossible dates such as 2026-02-30 instead of rolling them over.
    return date.getMonth() === Number(m) - 1 ? date : null;
  }
  const serial = numericValue(text);
  if (serial !== null) return serialToDate(serial);
  // Other textual dates ("Jan 5, 2026", "1/5/2026") use the platform parser.
  if (/[a-z/]/i.test(text)) {
    const parsed = Date.parse(text);
    return isNaN(parsed) ? null : new Date(parsed);
  }
  return null;
}

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Parses ISO date text ("2026-01-31" or "2026-01-31 13:45[:00]") into a
 * local Date, or null. Only ISO text counts: date arithmetic and date
 * comparisons never reinterpret other text or numbers as dates.
 */
export function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length < 8 || value.length > 19) return null;
  const iso = ISO_DATE.exec(value.trim());
  if (!iso) return null;
  const [, y, m, d, hh = '0', mm = '0', ss = '0'] = iso;
  const date = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  return date.getMonth() === Number(m) - 1 && date.getDate() === Number(d) ? date : null;
}

/** Whether ISO date text includes a time of day. */
export const isoDateHasTime = (value: string): boolean => /[ T]\d/.test(value.trim());

function isoDateTime(value: string): number | null {
  // Cheap pre-check: ISO dates start with four digits and a dash.
  if (value.length < 8 || value.charCodeAt(4) !== 45 /* - */) return null;
  return parseIsoDate(value)?.getTime() ?? null;
}

/** Spreadsheet serial number (days since 1899-12-30, fraction = time of day). */
export function dateToSerial(date: Date): number {
  const utc = Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  );
  return cleanFloat((utc - Date.UTC(1899, 11, 30)) / MS_PER_DAY);
}

export function serialToDate(serial: number): Date | null {
  if (!Number.isFinite(serial)) return null;
  const utc = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * MS_PER_DAY));
  return new Date(
    utc.getUTCFullYear(),
    utc.getUTCMonth(),
    utc.getUTCDate(),
    utc.getUTCHours(),
    utc.getUTCMinutes(),
    utc.getUTCSeconds(),
  );
}

/** Formats a local date as "YYYY-MM-DD" (the format TODAY() returns). */
export const formatIsoDate = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** Formats a local date and time as "YYYY-MM-DD HH:MM:SS" (the format NOW() returns). */
export const formatIsoDateTime = (date: Date): string =>
  `${formatIsoDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

/** Whole days from `start` to `end`, ignoring time of day and DST shifts. */
export const daysBetween = (start: Date, end: Date): number =>
  Math.round(
    (Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) -
      Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) /
      MS_PER_DAY,
  );
