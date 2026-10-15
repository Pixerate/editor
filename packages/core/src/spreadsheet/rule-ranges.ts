/**
 * Range helpers shared by conditional formatting and data validation: rules
 * apply to a list of rectangular ranges ("applies to") that follow row and
 * column insertions/deletions, and can be cut out of a selection.
 *
 * Portions ported from gridcraft/crates/engine/src/cmd/sheet.rs and
 * gridcraft/crates/engine/src/cmd/data.rs (MIT OR Apache-2.0, © ArtCraft Team
 * and contributors). See THIRD_PARTY_NOTICES.md.
 */
import type { CellRange } from './types';
import type { StructuralChange } from './formula';
import type { ConditionalFormatRule, ConditionalFormatValue } from './conditional-format/types';
import type { DataValidationRule } from './validation/types';
import {
  colNameToIndex,
  indexToColName,
  offsetFormulaReferences,
  shiftFormulaReferences,
  transposeFormulaReferences
} from './formula';
import { normalizeRange, rangesIntersect } from './table';

/**
 * Adjusts one range for an inserted or deleted row/column, the way merges
 * and formula ranges move: ranges after the change shift, ranges across it
 * grow or shrink, and a range whose rows (or columns) are all deleted is
 * gone (null).
 */
export function adjustRangeForStructuralChange(range: CellRange, change: StructuralChange): CellRange | null {
  const r = normalizeRange(range);
  const startKey = change.axis === 'row' ? 'startRow' : 'startCol';
  const endKey = change.axis === 'row' ? 'endRow' : 'endCol';
  if (change.type === 'insert') {
    if (r[startKey] >= change.index) r[startKey]++;
    if (r[endKey] >= change.index) r[endKey]++;
    return r;
  }
  if (r[startKey] === change.index && r[endKey] === change.index) return null;
  if (r[startKey] > change.index) r[startKey]--;
  if (r[endKey] >= change.index) r[endKey]--;
  return r;
}

/** `adjustRangeForStructuralChange` over a list, dropping ranges that are gone. */
export function adjustRangesForStructuralChange(ranges: CellRange[], change: StructuralChange): CellRange[] {
  const out: CellRange[] = [];
  for (const range of ranges) {
    const next = adjustRangeForStructuralChange(range, change);
    if (next) out.push(next);
  }
  return out;
}

/** The parts of `range` outside `cut` (up to four rectangles). */
export function subtractRange(range: CellRange, cut: CellRange): CellRange[] {
  const r = normalizeRange(range);
  const c = normalizeRange(cut);
  if (!rangesIntersect(r, c)) return [r];
  const out: CellRange[] = [];
  const top = Math.max(r.startRow, c.startRow);
  const bottom = Math.min(r.endRow, c.endRow);
  if (r.startRow < c.startRow) out.push({ startRow: r.startRow, startCol: r.startCol, endRow: c.startRow - 1, endCol: r.endCol });
  if (r.endRow > c.endRow) out.push({ startRow: c.endRow + 1, startCol: r.startCol, endRow: r.endRow, endCol: r.endCol });
  if (r.startCol < c.startCol) out.push({ startRow: top, startCol: r.startCol, endRow: bottom, endCol: c.startCol - 1 });
  if (r.endCol > c.endCol) out.push({ startRow: top, startCol: c.endCol + 1, endRow: bottom, endCol: r.endCol });
  return out;
}

/** Removes the cells of `cut` from every range of the list. */
export function subtractRangeFromRanges(ranges: CellRange[], cut: CellRange): CellRange[] {
  return ranges.flatMap((range) => subtractRange(range, cut));
}

/** Whether any range of the list contains (row, col). */
export function rangesContain(ranges: CellRange[], row: number, col: number): boolean {
  for (const r of ranges) {
    const minR = Math.min(r.startRow, r.endRow);
    const maxR = Math.max(r.startRow, r.endRow);
    const minC = Math.min(r.startCol, r.endCol);
    const maxC = Math.max(r.startCol, r.endCol);
    if (row >= minR && row <= maxR && col >= minC && col <= maxC) return true;
  }
  return false;
}

/** The top-left cell of the first range: rule formulas are written for it. */
export function ruleAnchor(ranges: CellRange[]): { row: number; col: number } {
  const first = ranges[0];
  if (!first) return { row: 0, col: 0 };
  return { row: Math.min(first.startRow, first.endRow), col: Math.min(first.startCol, first.endCol) };
}

const withEquals = (formula: string) => (formula.trimStart().startsWith('=') ? formula.trimStart() : `=${formula}`);

/**
 * A rule formula written for `anchor`, as seen from (row, col): relative
 * references shift by the distance, `$` parts stay (Excel's conditional
 * formatting and validation formulas work this way). Returned with a
 * leading `=`.
 */
export function ruleFormulaAt(formula: string, anchor: { row: number; col: number }, row: number, col: number): string {
  return offsetFormulaReferences(withEquals(formula), row - anchor.row, col - anchor.col);
}

/**
 * Rewrites a rule formula after a row/column insertion or deletion so it
 * keeps pointing at the same cells. Keeps the caller's leading `=` (or its
 * absence).
 */
export function shiftRuleFormula(formula: string, change: StructuralChange): string {
  const hadEquals = formula.trimStart().startsWith('=');
  const shifted = shiftFormulaReferences(withEquals(formula), change);
  return hadEquals ? shifted : shifted.slice(1);
}

/** Every cell of a list of ranges, clamped to the sheet, each once, in row-major order per range. */
export function forEachRangeCell(
  ranges: CellRange[],
  rowCount: number,
  colCount: number,
  fn: (row: number, col: number) => void
): void {
  const seen = ranges.length > 1 ? new Set<number>() : null;
  for (const range of ranges) {
    const r = normalizeRange(range);
    const endRow = Math.min(r.endRow, rowCount - 1);
    const endCol = Math.min(r.endCol, colCount - 1);
    for (let row = Math.max(0, r.startRow); row <= endRow; row++) {
      for (let col = Math.max(0, r.startCol); col <= endCol; col++) {
        if (seen) {
          const key = row * (colCount + 1) + col;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        fn(row, col);
      }
    }
  }
}

/** A1 text of a list of ranges: `A1:B5, D2`. */
export function formatRuleRanges(ranges: CellRange[]): string {
  return ranges
    .map((range) => {
      const r = normalizeRange(range);
      const start = `${indexToColName(r.startCol)}${r.startRow + 1}`;
      const end = `${indexToColName(r.endCol)}${r.endRow + 1}`;
      return start === end ? start : `${start}:${end}`;
    })
    .join(', ');
}

const A1_RANGE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?$/;

/** Parses `A1:B5, D2` (commas, semicolons or spaces between ranges; `$` ignored). Null when any part is not a cell or range. */
export function parseRuleRanges(text: string): CellRange[] | null {
  const parts = text.split(/[,;\s]+/).filter((p) => p !== '');
  if (parts.length === 0) return null;
  const out: CellRange[] = [];
  for (const part of parts) {
    const m = A1_RANGE.exec(part);
    if (!m) return null;
    const startRow = Number(m[2]) - 1;
    const startCol = colNameToIndex(m[1]);
    const endRow = m[4] ? Number(m[4]) - 1 : startRow;
    const endCol = m[3] ? colNameToIndex(m[3]) : startCol;
    if (startRow < 0 || endRow < 0 || startCol < 0 || endCol < 0) return null;
    out.push(normalizeRange({ startRow, startCol, endRow, endCol }));
  }
  return out;
}

// --- Moving rules with sorted / transposed cells ---

/**
 * Joins ranges that touch or overlap into fewer rectangles: ranges with the
 * same columns and adjacent rows, then ranges with the same rows and
 * adjacent columns. The result is sorted by row, then column.
 */
export function mergeRuleRanges(ranges: CellRange[]): CellRange[] {
  const join = (list: CellRange[], across: 'row' | 'col'): CellRange[] => {
    const [lo, hi, fixedLo, fixedHi] =
      across === 'row'
        ? (['startRow', 'endRow', 'startCol', 'endCol'] as const)
        : (['startCol', 'endCol', 'startRow', 'endRow'] as const);
    const sorted = list
      .map(normalizeRange)
      .sort((a, b) => a[fixedLo] - b[fixedLo] || a[fixedHi] - b[fixedHi] || a[lo] - b[lo]);
    const out: CellRange[] = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last && last[fixedLo] === r[fixedLo] && last[fixedHi] === r[fixedHi] && r[lo] <= last[hi] + 1) {
        last[hi] = Math.max(last[hi], r[hi]);
      } else {
        out.push({ ...r });
      }
    }
    return out;
  };
  return join(join(ranges, 'row'), 'col').sort((a, b) => a.startRow - b.startRow || a.startCol - b.startCol);
}

/**
 * Rule ranges after sorting the rows of `block` (`newRowOf(oldRow)` gives a
 * sorted row's new index), following Excel: the part of a range that spans
 * every sorted row applies to the column and stays; the cells of a range
 * covering only some of the sorted rows move with their rows. Returns null
 * when no range changes.
 */
export function sortRuleRanges(ranges: CellRange[], block: CellRange, newRowOf: (row: number) => number): CellRange[] | null {
  const b = normalizeRange(block);
  let changed = false;
  const pieces: CellRange[] = [];
  // Moved cells: column span → their new rows.
  const moved = new Map<string, { startCol: number; endCol: number; rows: number[] }>();
  for (const range of ranges) {
    const r = normalizeRange(range);
    const top = Math.max(r.startRow, b.startRow);
    const bottom = Math.min(r.endRow, b.endRow);
    const left = Math.max(r.startCol, b.startCol);
    const right = Math.min(r.endCol, b.endCol);
    if (top > bottom || left > right || (top === b.startRow && bottom === b.endRow)) {
      pieces.push(r);
      continue;
    }
    changed = true;
    pieces.push(...subtractRange(r, b));
    const key = `${left}:${right}`;
    let entry = moved.get(key);
    if (!entry) moved.set(key, (entry = { startCol: left, endCol: right, rows: [] }));
    for (let row = top; row <= bottom; row++) entry.rows.push(newRowOf(row));
  }
  if (!changed) return null;
  for (const { startCol, endCol, rows } of moved.values()) {
    rows.sort((x, y) => x - y);
    let start = rows[0];
    for (let i = 1; i <= rows.length; i++) {
      if (i < rows.length && rows[i] <= rows[i - 1] + 1) continue;
      pieces.push({ startRow: start, startCol, endRow: rows[i - 1], endCol });
      start = rows[i];
    }
  }
  return mergeRuleRanges(pieces);
}

/**
 * Rule ranges after transposing `block` in place around its top-left cell
 * (the transposed block is `target`): the cells inside the block move to
 * their transposed positions (`inside`), cells elsewhere stay (`outside`),
 * except those under the transposed block, which it replaces. Null when
 * the rule touches neither.
 */
export function transposeRuleRanges(
  ranges: CellRange[],
  block: CellRange,
  target: CellRange
): { inside: CellRange[]; outside: CellRange[] } | null {
  const s = normalizeRange(block);
  const t = normalizeRange(target);
  if (!ranges.some((r) => rangesIntersect(r, s) || rangesIntersect(r, t))) return null;
  const inside: CellRange[] = [];
  for (const range of ranges) {
    const r = normalizeRange(range);
    if (!rangesIntersect(r, s)) continue;
    const top = Math.max(r.startRow, s.startRow);
    const bottom = Math.min(r.endRow, s.endRow);
    const left = Math.max(r.startCol, s.startCol);
    const right = Math.min(r.endCol, s.endCol);
    inside.push({
      startRow: s.startRow + (left - s.startCol),
      endRow: s.startRow + (right - s.startCol),
      startCol: s.startCol + (top - s.startRow),
      endCol: s.startCol + (bottom - s.startRow)
    });
  }
  const outside = subtractRangeFromRanges(subtractRangeFromRanges(ranges, s), t);
  return { inside: mergeRuleRanges(inside), outside: mergeRuleRanges(outside) };
}

/**
 * Rewrites a rule formula written for `from` so it means the same when
 * written for `to` (rules are written for their first range's top-left
 * cell, which can change when ranges move). Keeps the caller's leading `=`
 * (or its absence).
 */
export function reanchorRuleFormula(formula: string, from: { row: number; col: number }, to: { row: number; col: number }): string {
  if (from.row === to.row && from.col === to.col) return formula;
  const hadEquals = formula.trimStart().startsWith('=');
  const moved = ruleFormulaAt(formula, from, to.row, to.col);
  return hadEquals ? moved : moved.slice(1);
}

/**
 * Transposes a rule formula written for `anchor` (a cell of `block`): see
 * `transposeFormulaReferences`. The result is written for the transposed
 * anchor. Keeps the caller's leading `=` (or its absence).
 */
export function transposeRuleFormula(formula: string, anchor: { row: number; col: number }, block: CellRange): string {
  const hadEquals = formula.trimStart().startsWith('=');
  const out = transposeFormulaReferences(withEquals(formula), anchor, normalizeRange(block));
  return hadEquals ? out : out.slice(1);
}

const isFormulaText = (text: string | undefined): text is string => text !== undefined && text.trimStart().startsWith('=');

/** Applies `fn` to every formula of a conditional format (expression, `=` values, formula anchors). */
export function mapConditionalFormatFormulas(rule: ConditionalFormatRule, fn: (formula: string) => string): ConditionalFormatRule {
  const anchor = (value: ConditionalFormatValue): ConditionalFormatValue =>
    value.type === 'formula' ? { ...value, formula: fn(value.formula) } : value;
  const next = { ...rule } as ConditionalFormatRule;
  if (next.type === 'expression') next.formula = fn(next.formula);
  if (next.type === 'cellIs') {
    if (isFormulaText(next.value)) next.value = fn(next.value);
    if (isFormulaText(next.value2)) next.value2 = fn(next.value2);
  }
  if (next.type === 'colorScale') next.stops = next.stops.map((s) => ({ ...s, value: anchor(s.value) }));
  if (next.type === 'dataBar') {
    if (next.min) next.min = anchor(next.min);
    if (next.max) next.max = anchor(next.max);
  }
  if (next.type === 'iconSet' && next.thresholds) next.thresholds = next.thresholds.map(anchor);
  return next;
}

/** Applies `fn` to the `=` formulas of a data validation rule. */
export function mapDataValidationFormulas(rule: DataValidationRule, fn: (formula: string) => string): DataValidationRule {
  const next = { ...rule };
  if (isFormulaText(next.formula1)) next.formula1 = fn(next.formula1);
  if (isFormulaText(next.formula2)) next.formula2 = fn(next.formula2);
  return next;
}

type RuleFormulaMapper<R> = (rule: R, fn: (formula: string) => string) => R;

function hasRuleFormulas<R>(rule: R, mapFormulas: RuleFormulaMapper<R>): boolean {
  let found = false;
  mapFormulas(rule, (f) => {
    found = true;
    return f;
  });
  return found;
}

const sameCell = (a: { row: number; col: number }, b: { row: number; col: number }) => a.row === b.row && a.col === b.col;

/**
 * Conditional formats or validations after a sort of `block` (see
 * `sortRuleRanges`). Rules whose first cell changes get their formulas
 * re-anchored, so relative references keep meaning "this row". Returns the
 * same array when nothing changes.
 */
export function sortRules<R extends { ranges: CellRange[] }>(
  rules: R[],
  block: CellRange,
  newRowOf: (row: number) => number,
  mapFormulas: RuleFormulaMapper<R>
): R[] {
  let changed = false;
  const out = rules.map((rule) => {
    const ranges = sortRuleRanges(rule.ranges, block, newRowOf);
    if (!ranges) return rule;
    changed = true;
    const from = ruleAnchor(rule.ranges);
    const to = ruleAnchor(ranges);
    const next = { ...rule, ranges };
    return sameCell(from, to) ? next : mapFormulas(next, (f) => reanchorRuleFormula(f, from, to));
  });
  return changed ? out : rules;
}

/**
 * Conditional formats or validations after transposing `block` in place
 * (see `transposeRuleRanges`). Formulas of the moved part are transposed
 * (`transposeRuleFormula`). A rule with formulas that is only partly inside
 * the block is split, since one formula can't serve both layouts: the moved
 * part becomes a new rule (id from `newId`) right after it. Rules left
 * without ranges are dropped. Returns the same array when nothing changes.
 */
export function transposeRules<R extends { id: string; ranges: CellRange[] }>(
  rules: R[],
  block: CellRange,
  target: CellRange,
  mapFormulas: RuleFormulaMapper<R>,
  newId: () => string
): R[] {
  const s = normalizeRange(block);
  let changed = false;
  const out: R[] = [];
  for (const rule of rules) {
    const moved = transposeRuleRanges(rule.ranges, s, target);
    if (!moved) {
      out.push(rule);
      continue;
    }
    changed = true;
    const { inside, outside } = moved;
    const from = ruleAnchor(rule.ranges);
    const withFormulas = hasRuleFormulas(rule, mapFormulas);
    const stayed = (): R => {
      const to = ruleAnchor(outside);
      const next = { ...rule, ranges: outside };
      return withFormulas && !sameCell(from, to) ? mapFormulas(next, (f) => reanchorRuleFormula(f, from, to)) : next;
    };
    const transposed = (): R => {
      const next = { ...rule, ranges: inside };
      if (!withFormulas) return next;
      // Re-anchor on a cell of the block first, then transpose around it.
      const first = rule.ranges.map(normalizeRange).find((r) => rangesIntersect(r, s))!;
      const at = { row: Math.max(first.startRow, s.startRow), col: Math.max(first.startCol, s.startCol) };
      const atT = { row: s.startRow + (at.col - s.startCol), col: s.startCol + (at.row - s.startRow) };
      const to = ruleAnchor(inside);
      return mapFormulas(next, (f) => reanchorRuleFormula(transposeRuleFormula(reanchorRuleFormula(f, from, at), at, s), atT, to));
    };
    if (inside.length === 0) {
      if (outside.length > 0) out.push(stayed());
    } else if (outside.length === 0) {
      out.push(transposed());
    } else if (!withFormulas) {
      out.push({ ...rule, ranges: mergeRuleRanges([...outside, ...inside]) });
    } else {
      out.push(stayed(), { ...transposed(), id: newId() });
    }
  }
  return changed ? out : rules;
}
