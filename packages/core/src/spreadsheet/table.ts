/**
 * Pure helpers behind the controller's table operations: value comparison
 * for sorting, filter matching, group aggregates, autofill series and range
 * arithmetic. Framework packages use these through `SpreadsheetController`.
 */
import type { CellRange, FilterRule, GroupAggregate, SortDirection } from './types';
import type { CellPosition } from './formula';
import { compareValues, isFormulaError, numericValue, parseIsoDate, sortCompareValues } from './formula/values';
import { parseCellInput } from './formula/parse-input';

// --- Ranges ---

/** Returns `range` with start <= end on both axes. */
export function normalizeRange(range: CellRange): CellRange {
  return {
    startRow: Math.min(range.startRow, range.endRow),
    startCol: Math.min(range.startCol, range.endCol),
    endRow: Math.max(range.startRow, range.endRow),
    endCol: Math.max(range.startCol, range.endCol),
  };
}

export function rangeContains(range: CellRange, row: number, col: number): boolean {
  const r = normalizeRange(range);
  return row >= r.startRow && row <= r.endRow && col >= r.startCol && col <= r.endCol;
}

export function rangesIntersect(a: CellRange, b: CellRange): boolean {
  const x = normalizeRange(a);
  const y = normalizeRange(b);
  return x.startRow <= y.endRow && y.startRow <= x.endRow && x.startCol <= y.endCol && y.startCol <= x.endCol;
}

/** True when `inner` lies entirely inside `outer`. */
export function rangeContainsRange(outer: CellRange, inner: CellRange): boolean {
  const o = normalizeRange(outer);
  const i = normalizeRange(inner);
  return i.startRow >= o.startRow && i.endRow <= o.endRow && i.startCol >= o.startCol && i.endCol <= o.endCol;
}

export function isSingleCellRange(range: CellRange): boolean {
  const r = normalizeRange(range);
  return r.startRow === r.endRow && r.startCol === r.endCol;
}

// --- Values ---

const NUMBER_PATTERN = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isBlankValue(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/** The numeric value of a number or numeric string, or null. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (NUMBER_PATTERN.test(trimmed)) return parseFloat(trimmed);
  }
  return null;
}

const collator =
  typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;

function compareText(a: string, b: string): number {
  return collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sort order for cell values, as in Excel: numbers (ascending), then text,
 * booleans and errors; `desc` reverses that order. Numbers compare at 15
 * significant digits and ISO dates chronologically. Text uses a natural,
 * case-insensitive order ("Item 2" before "Item 10"). Blanks always sort
 * last, whatever the direction.
 */
export function compareCellValues(a: unknown, b: unknown, direction: SortDirection = 'asc'): number {
  const aBlank = isBlankValue(a);
  const bBlank = isBlankValue(b);
  if (aBlank || bBlank) return aBlank === bBlank ? 0 : aBlank ? 1 : -1;

  let result: number;
  if (isPlainText(a) && isPlainText(b) && !(parseIsoDate(a) && parseIsoDate(b))) {
    result = compareText(a, b);
  } else {
    result = sortCompareValues(a, b);
  }
  if (result === 0) return 0;
  return direction === 'desc' ? -Math.sign(result) : Math.sign(result);
}

const isPlainText = (value: unknown): value is string => typeof value === 'string' && !isFormulaError(value);

// --- Filters ---

type FilterKind = 'number' | 'text' | 'boolean';

/**
 * A cell value for filtering: numeric text (e.g. from a data source) counts
 * as a number, like criteria in COUNTIF. ISO dates order with numbers
 * (as serial dates).
 */
function filterValue(value: unknown): { value: unknown; kind: FilterKind } | null {
  if (isBlankValue(value) || isFormulaError(value)) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? { value, kind: 'number' } : null;
  if (typeof value === 'boolean') return { value, kind: 'boolean' };
  const num = numericValue(value);
  if (num !== null) return { value: num, kind: 'number' };
  const text = String(value);
  return { value: text, kind: parseIsoDate(text) ? 'number' : 'text' };
}

/** A filter operand, read with the typed-input rules ("1,000", "10%", "3/4/2026", "TRUE"). */
function filterOperand(operand: unknown): { value: unknown; kind: FilterKind } | null {
  if (typeof operand !== 'string') return filterValue(operand);
  if (operand.trim() === '') return null;
  const parsed = parseCellInput(operand.trim());
  if (parsed.type === 'number' || parsed.type === 'date' || parsed.type === 'boolean') return filterValue(parsed.value);
  return { value: operand, kind: 'text' };
}

function compareForFilter(value: unknown, operand: unknown): number | null {
  const a = filterValue(value);
  const b = filterOperand(operand);
  // Numbers (and dates), text and booleans never compare with each other.
  if (!a || !b || a.kind !== b.kind) return null;
  return compareValues(a.value, b.value);
}

function looselyEquals(value: unknown, operand: unknown): boolean {
  const c = compareForFilter(value, operand);
  if (c !== null) return c === 0;
  return String(value ?? '').trim().toLowerCase() === String(operand ?? '').trim().toLowerCase();
}

/** Whether a cell value passes one filter rule. */
export function matchesFilterRule(value: unknown, rule: FilterRule): boolean {
  const text = String(value ?? '').toLowerCase();
  switch (rule.operator) {
    case 'equals':
      return looselyEquals(value, rule.value);
    case 'notEquals':
      return !looselyEquals(value, rule.value);
    case 'contains':
      return text.includes(String(rule.value ?? '').toLowerCase());
    case 'notContains':
      return !text.includes(String(rule.value ?? '').toLowerCase());
    case 'greaterThan': {
      const c = compareForFilter(value, rule.value);
      return c !== null && c > 0;
    }
    case 'greaterThanOrEqual': {
      const c = compareForFilter(value, rule.value);
      return c !== null && c >= 0;
    }
    case 'lessThan': {
      const c = compareForFilter(value, rule.value);
      return c !== null && c < 0;
    }
    case 'lessThanOrEqual': {
      const c = compareForFilter(value, rule.value);
      return c !== null && c <= 0;
    }
    case 'between': {
      const lo = compareForFilter(value, rule.value);
      const hi = compareForFilter(value, rule.value2);
      return lo !== null && hi !== null && lo >= 0 && hi <= 0;
    }
    case 'isBlank':
      return isBlankValue(value);
    case 'isNotBlank':
      return !isBlankValue(value);
    case 'oneOf':
      return (rule.values ?? []).some((candidate) => String(candidate) === String(value ?? ''));
    default:
      return true;
  }
}

// --- Group summaries ---

/**
 * Aggregates values the way category summaries do: `count` counts non-blank
 * values; the other aggregates use numeric values only and return null when
 * there are none.
 */
export function aggregateValues(values: unknown[], aggregate: GroupAggregate): number | null {
  if (aggregate === 'count') return values.filter((v) => !isBlankValue(v)).length;
  const numbers: number[] = [];
  for (const v of values) {
    const n = toNumber(v);
    if (n !== null) numbers.push(n);
  }
  if (numbers.length === 0) return aggregate === 'sum' ? 0 : null;
  switch (aggregate) {
    case 'sum':
      return roundFloat(numbers.reduce((s, n) => s + n, 0));
    case 'average':
      return roundFloat(numbers.reduce((s, n) => s + n, 0) / numbers.length);
    case 'min':
      return numbers.reduce((m, n) => (n < m ? n : m), numbers[0]);
    case 'max':
      return numbers.reduce((m, n) => (n > m ? n : m), numbers[0]);
    default:
      return null;
  }
}

/** Removes binary floating point noise (0.1 + 0.2 -> 0.3). */
export function roundFloat(value: number): number {
  return Number.isInteger(value) ? value : parseFloat(value.toPrecision(12));
}

// --- Autofill ---

type FillValue =
  | { kind: 'blank' }
  | { kind: 'number'; value: number }
  | { kind: 'date'; time: number; year: number; month: number; day: number }
  | { kind: 'textNumber'; prefix: string; value: number; width: number; suffix: string }
  | { kind: 'text'; text: string };

const DAY_MS = 86_400_000;
const TRAILING_NUMBER = /^(.*?)(\d+)(\D*)$/;

function classifyFillValue(raw: string): FillValue {
  if (raw.trim() === '') return { kind: 'blank' };
  const num = toNumber(raw);
  if (num !== null) return { kind: 'number', value: num };
  // Typed dates ("3/4/2026", "Mar 4, 2026") continue as ISO dates.
  const typed = parseCellInput(raw);
  const date = ISO_DATE_PATTERN.exec(typed.type === 'date' ? String(typed.value) : raw.trim());
  if (date) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const time = Date.UTC(year, month - 1, day);
    const check = new Date(time);
    if (check.getUTCMonth() === month - 1 && check.getUTCDate() === day) {
      return { kind: 'date', time, year, month, day };
    }
  }
  const textNumber = TRAILING_NUMBER.exec(raw);
  if (textNumber && textNumber[1] !== '') {
    return {
      kind: 'textNumber',
      prefix: textNumber[1],
      value: parseInt(textNumber[2], 10),
      width: textNumber[2].length,
      suffix: textNumber[3],
    };
  }
  return { kind: 'text', text: raw };
}

const pad = (n: number, width: number) => String(Math.abs(n)).padStart(width, '0');

function formatDate(time: number): string {
  const d = new Date(time);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
}

/** Constant difference between consecutive values, or null. */
function constantStep(values: number[]): number | null {
  const step = values[1] - values[0];
  for (let i = 2; i < values.length; i++) {
    if (Math.abs(values[i] - values[i - 1] - step) > 1e-9) return null;
  }
  return step;
}

/** Least-squares line through (i, values[i]), evaluated at `x`. */
function linearTrend(values: number[], x: number): number {
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  values.forEach((v, i) => {
    num += (i - meanX) * (v - meanY);
    den += (i - meanX) ** 2;
  });
  const slope = den === 0 ? 0 : num / den;
  return meanY + slope * (x - meanX);
}

/**
 * Extends `source` (raw values in fill order: for an upward or leftward fill,
 * nearest-first) by `count` values, the way a fill handle does:
 *
 * - numbers: one value repeats; two or more continue their linear trend
 * - dates (ISO `YYYY-MM-DD`, or typed like `3/4/2026`): one date counts up
 *   by a day; two or more continue their day or month step (as ISO dates)
 * - text ending in a number ("Item 1"): the number counts up (or continues
 *   the step of several values with the same prefix/suffix)
 * - anything else (or a mix) repeats the source cyclically
 *
 * Formulas are not handled here; the controller shifts their references.
 */
export function fillSeries(source: string[], count: number): string[] {
  if (count <= 0) return [];
  if (source.length === 0) return Array(count).fill('');
  const repeat = () => Array.from({ length: count }, (_, i) => source[i % source.length]);

  const parsed = source.map(classifyFillValue);
  const kind = parsed[0].kind;
  if (!parsed.every((p) => p.kind === kind)) return repeat();
  const n = source.length;

  if (kind === 'number') {
    if (n === 1) return repeat();
    const values = parsed.map((p) => (p as { value: number }).value);
    return Array.from({ length: count }, (_, i) => String(roundFloat(linearTrend(values, n + i))));
  }

  if (kind === 'date') {
    const dates = parsed as Array<Extract<FillValue, { kind: 'date' }>>;
    if (n === 1) {
      return Array.from({ length: count }, (_, i) => formatDate(dates[0].time + (i + 1) * DAY_MS));
    }
    // Same day of month, constant month step: step by months (Jan 31 -> Feb 28 clamps).
    const monthIndex = dates.map((d) => d.year * 12 + (d.month - 1));
    const monthStep = constantStep(monthIndex);
    if (monthStep !== null && monthStep !== 0 && dates.every((d) => d.day === dates[0].day)) {
      const last = monthIndex[n - 1];
      return Array.from({ length: count }, (_, i) => {
        const m = last + monthStep * (i + 1);
        const year = Math.floor(m / 12);
        const month = m - year * 12;
        const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
        return formatDate(Date.UTC(year, month, Math.min(dates[0].day, daysInMonth)));
      });
    }
    const dayStep = constantStep(dates.map((d) => Math.round(d.time / DAY_MS)));
    if (dayStep === null) return repeat();
    const lastTime = dates[n - 1].time;
    return Array.from({ length: count }, (_, i) => formatDate(lastTime + dayStep * (i + 1) * DAY_MS));
  }

  if (kind === 'textNumber') {
    const items = parsed as Array<Extract<FillValue, { kind: 'textNumber' }>>;
    const { prefix, suffix } = items[0];
    if (!items.every((t) => t.prefix === prefix && t.suffix === suffix)) return repeat();
    const step = n === 1 ? 1 : constantStep(items.map((t) => t.value));
    if (step === null) return repeat();
    const last = items[n - 1];
    return Array.from({ length: count }, (_, i) => {
      const value = last.value + step * (i + 1);
      const digits = value < 0 ? `-${pad(value, last.width)}` : pad(value, last.width);
      return `${prefix}${digits}${suffix}`;
    });
  }

  return repeat();
}

export type FillDirection = 'down' | 'up' | 'right' | 'left';

/**
 * Works out where a fill handle drag ends. Dragging further vertically than
 * horizontally fills down/up the source's columns; otherwise right/left
 * across its rows. Returns the full target range (source included), or null
 * while the pointer is still inside the source.
 */
export function computeFillTarget(source: CellRange, pointer: CellPosition): CellRange | null {
  const s = normalizeRange(source);
  const rowOverflow = pointer.row > s.endRow ? pointer.row - s.endRow : pointer.row < s.startRow ? s.startRow - pointer.row : 0;
  const colOverflow = pointer.col > s.endCol ? pointer.col - s.endCol : pointer.col < s.startCol ? s.startCol - pointer.col : 0;
  if (rowOverflow === 0 && colOverflow === 0) return null;
  if (rowOverflow >= colOverflow) {
    return pointer.row > s.endRow ? { ...s, endRow: pointer.row } : { ...s, startRow: pointer.row };
  }
  return pointer.col > s.endCol ? { ...s, endCol: pointer.col } : { ...s, startCol: pointer.col };
}

/**
 * The direction of a fill from `source` into `target` (the extended range),
 * or null when `target` does not extend `source` along exactly one edge.
 */
export function getFillDirection(source: CellRange, target: CellRange): FillDirection | null {
  const s = normalizeRange(source);
  const t = normalizeRange(target);
  const sameCols = s.startCol === t.startCol && s.endCol === t.endCol;
  const sameRows = s.startRow === t.startRow && s.endRow === t.endRow;
  if (sameCols && t.startRow === s.startRow && t.endRow > s.endRow) return 'down';
  if (sameCols && t.endRow === s.endRow && t.startRow < s.startRow) return 'up';
  if (sameRows && t.startCol === s.startCol && t.endCol > s.endCol) return 'right';
  if (sameRows && t.endCol === s.endCol && t.startCol < s.startCol) return 'left';
  return null;
}
