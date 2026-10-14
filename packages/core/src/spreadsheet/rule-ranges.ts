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
import { colNameToIndex, indexToColName, offsetFormulaReferences, shiftFormulaReferences } from './formula';
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
