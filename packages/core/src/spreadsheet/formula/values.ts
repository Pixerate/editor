/**
 * Value helpers shared by the formula evaluator and the built-in functions:
 * error values, spreadsheet coercion rules, comparisons, ranges and dates.
 */

/** Spreadsheet error values. They propagate through operators and functions. */
export const FORMULA_ERRORS = new Set([
  '#DIV/0!',
  '#VALUE!',
  '#REF!',
  '#NAME?',
  '#N/A',
  '#NUM!',
  '#CYCLE!',
  '#ERROR!'
]);

export type FormulaErrorCode =
  | '#DIV/0!'
  | '#VALUE!'
  | '#REF!'
  | '#NAME?'
  | '#N/A'
  | '#NUM!'
  | '#CYCLE!'
  | '#ERROR!';

export function isFormulaError(value: unknown): value is string {
  return typeof value === 'string' && FORMULA_ERRORS.has(value);
}

export const isBlank = (value: unknown): boolean => value === '' || value === null || value === undefined;

/** Coerces to a number like a spreadsheet: blanks are 0, booleans 1/0, other text is #VALUE!. */
export function toNumber(value: unknown): number | string {
  if (isFormulaError(value)) return value;
  if (isBlank(value)) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  const trimmed = String(value).trim();
  const num = trimmed === '' ? NaN : Number(trimmed);
  return isNaN(num) ? '#VALUE!' : num;
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

export const toText = (value: unknown): string =>
  isBlank(value) ? '' : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);

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

/** Orders values like spreadsheets: numbers < text < booleans; text is case-insensitive. */
export function compareValues(left: unknown, right: unknown): number {
  const rank = (v: unknown) => (typeof v === 'boolean' ? 2 : typeof v === 'string' ? 1 : 0);
  // A blank compares as 0 against numbers/booleans and as "" against text.
  const l = isBlank(left) ? (typeof right === 'string' ? '' : 0) : left;
  const r = isBlank(right) ? (typeof l === 'string' ? '' : 0) : right;
  if (rank(l) !== rank(r)) return rank(l) - rank(r);
  if (typeof l === 'string') {
    const a = l.toLowerCase();
    const b = (r as string).toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return Number(l) - Number(r);
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
