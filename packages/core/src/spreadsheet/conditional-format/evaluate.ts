/**
 * Conditional formatting evaluation: which fill, font colour, emphasis, data
 * bar or icon each cell gets.
 *
 * Portions ported from gridcraft/crates/engine/src/cf.rs (MIT OR Apache-2.0,
 * © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
 */
import { compareValues, numberToText, parseCellInput, serialFromYmd } from '../formula';
import { isFormulaError, serialToDate, toBoolean } from '../formula/values';
import { forEachRangeCell, rangesContain, ruleAnchor, ruleFormulaAt } from '../rule-ranges';
import { rangesIntersect } from '../table';
import { conditionalFormatIconCount } from './icons';
import type {
  ConditionalCellFormat,
  ConditionalFormatOverlay,
  ConditionalFormatRule,
  ConditionalFormatSheet,
  ConditionalFormatStyle,
  ConditionalFormatValue,
} from './types';

const DEFAULT_BAR_COLOR = '#638ec6';

interface RuleStats {
  sorted: number[];
  avg: number;
  std: number;
  /** Lower-cased text of each non-blank value -> occurrences. */
  counts: Map<string, number>;
}

const isBlank = (v: unknown) => v === '' || v === null || v === undefined;

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * The number a value counts as for scales, bars, icons, top/bottom and
 * averages: numbers, and dates (ISO text) as their serial number. Text,
 * booleans, blanks and errors are not numbers.
 */
export function conditionalFormatNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length < 8 || value.length > 19) return null;
  const m = ISO_DATE.exec(value);
  if (!m) return null;
  const serial = serialFromYmd(Number(m[1]), Number(m[2]), Number(m[3]));
  if (serial === null) return null;
  const time = m[4] ? (Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6] ?? 0)) / 86400 : 0;
  return serial + time;
}

/** A value as text, for text rules and duplicates. */
function valueText(value: unknown): string {
  if (isBlank(value)) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return numberToText(value);
  return String(value);
}

function firstValue(value: unknown): unknown {
  return Array.isArray(value) ? (value.length ? value[0] : '') : value;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (Math.min(Math.max(p, 0), 100) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (rank - lo);
}

/** Parses `#rgb` / `#rrggbb` (with or without `#`). */
function parseHexColor(color: string | undefined): [number, number, number] | null {
  if (!color) return null;
  let hex = color.trim().replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

const toHex = (rgb: [number, number, number]) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;

/** Blends two colours: `t` 0 is `a`, 1 is `b`. */
export function blendConditionalFormatColors(a: string, b: string, t: number): string {
  const ca = parseHexColor(a) ?? [255, 255, 255];
  const cb = parseHexColor(b) ?? [255, 255, 255];
  const k = Math.min(Math.max(Number.isFinite(t) ? t : 0, 0), 1);
  return toHex([0, 1, 2].map((i) => Math.round(ca[i] + (cb[i] - ca[i]) * k)) as [number, number, number]);
}

/** Excel's default icon thresholds: percent 0, 33, 67 for three icons. */
export function defaultIconThresholds(set: string): ConditionalFormatValue[] {
  const k = conditionalFormatIconCount(set);
  return Array.from({ length: k }, (_, i) => ({ type: 'percent' as const, value: Math.round((i * 100) / k) }));
}

const usesStats = (rule: ConditionalFormatRule): boolean =>
  rule.type === 'colorScale' ||
  rule.type === 'dataBar' ||
  rule.type === 'iconSet' ||
  rule.type === 'top10' ||
  rule.type === 'aboveAverage' ||
  rule.type === 'duplicate' ||
  rule.type === 'unique';

const isFormulaText = (text: string | undefined) => !!text && text.trimStart().startsWith('=');

/** Whether a rule reads cells through formulas (so any edit may change it). */
function usesFormulas(rule: ConditionalFormatRule): boolean {
  switch (rule.type) {
    case 'expression':
      return true;
    case 'cellIs':
      return isFormulaText(rule.value) || isFormulaText(rule.value2);
    case 'colorScale':
      return rule.stops.some((s) => s.value.type === 'formula');
    case 'dataBar':
      return rule.min?.type === 'formula' || rule.max?.type === 'formula';
    case 'iconSet':
      return !!rule.thresholds?.some((t) => t.type === 'formula');
    default:
      return false;
  }
}

/** Adds the parts of `style` that `out` leaves unset (higher-priority rules come first). */
function layerStyle(out: ConditionalCellFormat, style: ConditionalFormatStyle): void {
  if (out.fill === undefined && style.fill) out.fill = style.fill;
  if (out.color === undefined && style.color) out.color = style.color;
  if (style.bold) out.bold = true;
  if (style.italic) out.italic = true;
  if (style.underline) out.underline = true;
  if (style.strikethrough) out.strikethrough = true;
}

// Numeric cell keys (much faster than strings in large maps); columns stay below 2^20.
const COL_SPAN = 1048576;
const cellKey = (row: number, col: number) => row * COL_SPAN + col;

class Overlay implements ConditionalFormatOverlay {
  constructor(private readonly cells: Map<number, ConditionalCellFormat>) {}
  get(row: number, col: number): ConditionalCellFormat | undefined {
    return this.cells.size === 0 ? undefined : this.cells.get(cellKey(row, col));
  }
  get size(): number {
    return this.cells.size;
  }
  *entries(): IterableIterator<[{ row: number; col: number }, ConditionalCellFormat]> {
    for (const [key, format] of this.cells) {
      const row = Math.floor(key / COL_SPAN);
      const col = key - row * COL_SPAN;
      yield [{ row, col }, format];
    }
  }
}

/** An overlay with no formatted cells. */
export const EMPTY_CONDITIONAL_FORMAT_OVERLAY: ConditionalFormatOverlay = new Overlay(new Map());

/**
 * Evaluates conditional formats and keeps what it needs to re-evaluate only
 * the affected cells after an edit (`update`). Rules are applied in order
 * (the first has the highest priority): every matching rule adds the parts
 * of its style that higher-priority rules left unset, and a matching rule
 * with `stopIfTrue` hides lower-priority rules. Colour scales, data bars and
 * icon sets apply to numbers only and never stop other rules.
 */
export class ConditionalFormatEngine {
  private cells = new Map<number, ConditionalCellFormat>();
  private stats = new Map<string, RuleStats>();
  private rulesKey: string | null = null;
  private current: ConditionalFormatOverlay = EMPTY_CONDITIONAL_FORMAT_OVERLAY;

  constructor(private sheet: ConditionalFormatSheet) {}

  /** Replaces the sheet accessor (e.g. after rows or columns were added). */
  setSheet(sheet: ConditionalFormatSheet): void {
    this.sheet = sheet;
  }

  /** The last evaluated overlay. */
  get overlay(): ConditionalFormatOverlay {
    return this.current;
  }

  /** Evaluates every rule over every cell it applies to. */
  evaluate(rules: ConditionalFormatRule[]): ConditionalFormatOverlay {
    this.rulesKey = JSON.stringify(rules);
    this.stats.clear();
    this.cells = new Map();
    const { rowCount, colCount } = this.sheet;
    const done = new Set<number>();
    for (const rule of rules) {
      forEachRangeCell(rule.ranges, rowCount, colCount, (row, col) => {
        const key = cellKey(row, col);
        if (done.has(key)) return;
        done.add(key);
        const look = this.computeLook(rules, row, col);
        if (look) this.cells.set(key, look);
      });
    }
    this.current = new Overlay(this.cells);
    return this.current;
  }

  /**
   * Re-evaluates after the values of `changed` cells changed (the edited
   * cells and the formulas that depend on them). Rules that look at the whole
   * range (scales, bars, icons, top/bottom, average, duplicates) are
   * re-evaluated over their range when a changed cell is inside it; formula
   * rules always are, since their formulas may read any cell; other rules
   * only at the changed cells. Falls back to `evaluate` when the rules
   * changed.
   */
  update(rules: ConditionalFormatRule[], changed: Iterable<{ row: number; col: number }>): ConditionalFormatOverlay {
    const key = JSON.stringify(rules);
    if (key !== this.rulesKey) return this.evaluate(rules);
    if (rules.length === 0) return this.current;
    const changedCells = Array.from(changed);
    const { rowCount, colCount } = this.sheet;
    const affected = new Map<number, { row: number; col: number }>();
    const addCell = (row: number, col: number) => affected.set(cellKey(row, col), { row, col });
    for (const rule of rules) {
      const wholeRange = usesFormulas(rule);
      const touched = changedCells.some((c) => rangesContain(rule.ranges, c.row, c.col));
      if (usesStats(rule) && touched) this.stats.delete(rule.id);
      if (wholeRange || (usesStats(rule) && touched)) {
        forEachRangeCell(rule.ranges, rowCount, colCount, addCell);
      } else if (touched) {
        for (const c of changedCells) {
          if (c.row < rowCount && c.col < colCount && rangesContain(rule.ranges, c.row, c.col)) addCell(c.row, c.col);
        }
      }
    }
    if (affected.size === 0) return this.current;
    const next = new Map(this.cells);
    for (const [k, { row, col }] of affected) {
      const look = this.computeLook(rules, row, col);
      if (look) next.set(k, look);
      else next.delete(k);
    }
    this.cells = next;
    this.current = new Overlay(next);
    return this.current;
  }

  private statsFor(rule: ConditionalFormatRule): RuleStats {
    let st = this.stats.get(rule.id);
    if (st) return st;
    const sorted: number[] = [];
    const counts = new Map<string, number>();
    forEachRangeCell(rule.ranges, this.sheet.rowCount, this.sheet.colCount, (row, col) => {
      const v = this.sheet.getValue(row, col);
      const n = conditionalFormatNumber(v);
      if (n !== null) sorted.push(n);
      if (!isBlank(v)) {
        const text = valueText(v).toLowerCase();
        counts.set(text, (counts.get(text) ?? 0) + 1);
      }
    });
    sorted.sort((a, b) => a - b);
    const n = Math.max(sorted.length, 1);
    let sum = 0;
    for (const x of sorted) sum += x;
    const avg = sum / n;
    let sq = 0;
    for (const x of sorted) sq += (x - avg) * (x - avg);
    st = { sorted, avg, std: Math.sqrt(sq / n), counts };
    this.stats.set(rule.id, st);
    return st;
  }

  private evalFormula(formula: string, rule: ConditionalFormatRule, row: number, col: number): unknown {
    if (!this.sheet.evaluateFormula) return '#NAME?';
    try {
      return firstValue(this.sheet.evaluateFormula(ruleFormulaAt(formula, ruleAnchor(rule.ranges), row, col), row, col));
    } catch {
      return '#ERROR!';
    }
  }

  private threshold(rule: ConditionalFormatRule, st: RuleStats, k: ConditionalFormatValue, row: number, col: number): number {
    const min = st.sorted[0] ?? 0;
    const max = st.sorted[st.sorted.length - 1] ?? 0;
    switch (k.type) {
      case 'min':
        return min;
      case 'max':
        return max;
      case 'number':
        return k.value;
      case 'percent':
        return min + ((max - min) * k.value) / 100;
      case 'percentile':
        return percentile(st.sorted, k.value);
      case 'formula': {
        const n = conditionalFormatNumber(this.evalFormula(k.formula, rule, row, col));
        return n ?? 0;
      }
    }
  }

  /** The operand of a `cellIs` rule: a formula result, or typed input. */
  private operand(text: string | undefined, rule: ConditionalFormatRule, row: number, col: number): unknown {
    if (text === undefined) return '';
    if (isFormulaText(text)) return this.evalFormula(text, rule, row, col);
    return parseCellInput(text).value;
  }

  /** Combines every rule that applies to (row, col). */
  computeLook(rules: ConditionalFormatRule[], row: number, col: number): ConditionalCellFormat | undefined {
    const out: ConditionalCellFormat = {};
    let any = false;
    let v: unknown;
    let loaded = false;
    const value = () => {
      if (!loaded) {
        v = this.sheet.getValue(row, col);
        loaded = true;
      }
      return v;
    };
    for (const rule of rules) {
      if (!rangesContain(rule.ranges, row, col)) continue;
      const matched = this.matchRule(rule, value(), row, col, out);
      if (matched === 'look') any = true;
      if (matched && matched !== 'look') {
        any = true;
        layerStyle(out, matched);
        if (rule.stopIfTrue) break;
      }
    }
    return any ? out : undefined;
  }

  /**
   * Checks one rule: returns its style when it matches, 'look' when it set a
   * scale fill, bar or icon on `out`, or null.
   */
  private matchRule(
    rule: ConditionalFormatRule,
    v: unknown,
    row: number,
    col: number,
    out: ConditionalCellFormat
  ): ConditionalFormatStyle | 'look' | null {
    const error = isFormulaError(v);
    switch (rule.type) {
      case 'cellIs': {
        if (error) return null;
        const a = this.operand(rule.value, rule, row, col);
        let ok: boolean;
        if (rule.operator === 'between' || rule.operator === 'notBetween') {
          const b = this.operand(rule.value2, rule, row, col);
          const [lo, hi] = compareValues(a, b) > 0 ? [b, a] : [a, b];
          const inside = compareValues(v, lo) >= 0 && compareValues(v, hi) <= 0;
          ok = rule.operator === 'between' ? inside : !inside;
        } else {
          if (isFormulaError(a)) return null;
          const cmp = compareValues(v, a);
          ok =
            rule.operator === 'equal'
              ? cmp === 0
              : rule.operator === 'notEqual'
                ? cmp !== 0
                : rule.operator === 'greaterThan'
                  ? cmp > 0
                  : rule.operator === 'lessThan'
                    ? cmp < 0
                    : rule.operator === 'greaterThanOrEqual'
                      ? cmp >= 0
                      : cmp <= 0;
        }
        return ok ? rule.style : null;
      }
      case 'expression': {
        const result = toBoolean(this.evalFormula(rule.formula, rule, row, col));
        return result === true ? rule.style : null;
      }
      case 'containsText':
      case 'notContainsText':
      case 'beginsWith':
      case 'endsWith': {
        const text = valueText(v).toLowerCase();
        const t = rule.text.toLowerCase();
        const ok =
          rule.type === 'containsText'
            ? text.includes(t)
            : rule.type === 'notContainsText'
              ? !text.includes(t)
              : rule.type === 'beginsWith'
                ? text.startsWith(t)
                : text.endsWith(t);
        return ok ? rule.style : null;
      }
      case 'blanks':
        return isBlank(v) || valueText(v).trim() === '' ? rule.style : null;
      case 'noBlanks':
        return !isBlank(v) && valueText(v).trim() !== '' ? rule.style : null;
      case 'errors':
        return error ? rule.style : null;
      case 'noErrors':
        return !error ? rule.style : null;
      case 'duplicate':
      case 'unique': {
        if (isBlank(v)) return null;
        const count = this.statsFor(rule).counts.get(valueText(v).toLowerCase()) ?? 0;
        return (rule.type === 'duplicate' ? count > 1 : count === 1) ? rule.style : null;
      }
      case 'top10': {
        const n = conditionalFormatNumber(v);
        const st = this.statsFor(rule);
        if (n === null || st.sorted.length === 0) return null;
        const rank = Math.max(1, Math.floor(rule.rank || 1));
        let k = rule.percent ? Math.max(1, Math.floor((st.sorted.length * rank) / 100)) : rank;
        k = Math.min(Math.max(k, 1), st.sorted.length);
        const ok = rule.bottom ? n <= st.sorted[k - 1] : n >= st.sorted[st.sorted.length - k];
        return ok ? rule.style : null;
      }
      case 'aboveAverage': {
        const n = conditionalFormatNumber(v);
        if (n === null) return null;
        const st = this.statsFor(rule);
        const thr = st.avg + (rule.below ? -1 : 1) * st.std * (rule.stdDev ?? 0);
        const ok = rule.below ? n < thr || (!!rule.equal && n === thr) : n > thr || (!!rule.equal && n === thr);
        return ok ? rule.style : null;
      }
      case 'timePeriod': {
        const n = conditionalFormatNumber(v);
        if (n === null) return null;
        return matchesTimePeriod(rule.period, Math.floor(n), this.sheet.today?.() ?? new Date()) ? rule.style : null;
      }
      case 'colorScale': {
        const n = conditionalFormatNumber(v);
        if (n === null || out.fill !== undefined) return null;
        const st = this.statsFor(rule);
        const pts = rule.stops.map((s) => ({ at: this.threshold(rule, st, s.value, row, col), color: s.color }));
        let fill: string | undefined;
        if (pts.length === 2) {
          const [a, b] = pts;
          fill = blendConditionalFormatColors(a.color, b.color, b.at > a.at ? (n - a.at) / (b.at - a.at) : 0);
        } else if (pts.length >= 3) {
          const [a, m, b] = pts;
          fill =
            n <= m.at
              ? blendConditionalFormatColors(a.color, m.color, m.at > a.at ? (n - a.at) / (m.at - a.at) : 0)
              : blendConditionalFormatColors(m.color, b.color, b.at > m.at ? (n - m.at) / (b.at - m.at) : 1);
        }
        if (!fill) return null;
        out.fill = fill;
        return 'look';
      }
      case 'dataBar': {
        const n = conditionalFormatNumber(v);
        if (n === null || out.dataBar) return null;
        const st = this.statsFor(rule);
        let lo = this.threshold(rule, st, rule.min ?? { type: 'min' }, row, col);
        const hi = this.threshold(rule, st, rule.max ?? { type: 'max' }, row, col);
        // Bars of positive numbers start at zero.
        if (lo > 0) lo = 0;
        const frac = hi > lo ? Math.min(Math.max((n - lo) / (hi - lo), 0), 1) : 1;
        out.dataBar = {
          // A minimum length keeps small positive values visible.
          fraction: frac * 0.9 + (frac > 0 ? 0.1 : 0),
          color: rule.color ?? DEFAULT_BAR_COLOR,
          gradient: rule.gradient ?? true,
        };
        if (rule.showValue === false) out.hideValue = true;
        return 'look';
      }
      case 'iconSet': {
        const n = conditionalFormatNumber(v);
        if (n === null || out.icon) return null;
        const set = rule.set ?? '3TrafficLights1';
        const k = conditionalFormatIconCount(set);
        const thresholds = rule.thresholds ?? [];
        // One threshold per icon (the first is the lower bound), or one fewer.
        const lower =
          thresholds.length === k
            ? thresholds.slice(1)
            : thresholds.length + 1 === k
              ? thresholds
              : defaultIconThresholds(set).slice(1);
        const st = this.statsFor(rule);
        let idx = 0;
        for (const t of lower) if (n >= this.threshold(rule, st, t, row, col)) idx++;
        if (rule.reverse) idx = k - 1 - Math.min(idx, k - 1);
        idx = Math.min(idx, k - 1);
        out.icon = { set, index: idx, id: `${set}:${idx}` };
        if (rule.showValue === false) out.hideValue = true;
        return 'look';
      }
    }
    return null;
  }
}

/** Whether serial day `d` falls in `period` relative to `today`. */
export function matchesTimePeriod(period: string, d: number, today: Date): boolean {
  const t = serialFromYmd(today.getFullYear(), today.getMonth() + 1, today.getDate());
  if (t === null) return false;
  const weekStart = t - today.getDay();
  const date = serialToDate(d);
  const monthOffset = (k: number) => {
    if (!date) return false;
    const m = today.getMonth() + k;
    const y = today.getFullYear() + Math.floor(m / 12);
    const mm = ((m % 12) + 12) % 12;
    return date.getFullYear() === y && date.getMonth() === mm;
  };
  switch (period) {
    case 'yesterday':
      return d === t - 1;
    case 'today':
      return d === t;
    case 'tomorrow':
      return d === t + 1;
    case 'last7Days':
      return d > t - 7 && d <= t;
    case 'lastWeek':
      return d >= weekStart - 7 && d < weekStart;
    case 'thisWeek':
      return d >= weekStart && d < weekStart + 7;
    case 'nextWeek':
      return d >= weekStart + 7 && d < weekStart + 14;
    case 'lastMonth':
      return monthOffset(-1);
    case 'thisMonth':
      return monthOffset(0);
    case 'nextMonth':
      return monthOffset(1);
    default:
      return false;
  }
}

/** Evaluates `rules` over a sheet: the conditional look of every formatted cell. */
export function evaluateConditionalFormats(sheet: ConditionalFormatSheet, rules: ConditionalFormatRule[]): ConditionalFormatOverlay {
  return new ConditionalFormatEngine(sheet).evaluate(rules);
}

/** Whether a rule's ranges intersect `range` (for "clear rules from selection"). */
export function conditionalFormatTouchesRange(
  rule: { ranges: { startRow: number; startCol: number; endRow: number; endCol: number }[] },
  range: { startRow: number; startCol: number; endRow: number; endCol: number }
): boolean {
  return rule.ranges.some((r) => rangesIntersect(r, range));
}
