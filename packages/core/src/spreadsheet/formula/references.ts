import { tokenizeFormula } from './lexer';
import { colNameToIndex, indexToColName } from './evaluator';

/**
 * A row or column insertion/deletion. `index` is the 0-based position of the
 * inserted or deleted row/column.
 */
export interface StructuralChange {
  axis: 'row' | 'col';
  index: number;
  type: 'insert' | 'delete';
}

const CELL_PART = /^(\$?)([A-Za-z]+)(\$?)(\d+)$/;
const COLUMN_PART = /^(\$?)([A-Za-z]+)$/;
const REF_CHAR = /[A-Za-z0-9_$.:]/;

interface RefPart {
  colAbs: string;
  col: number; // 0-based column index
  rowAbs: string;
  row: number | null; // 0-based row index; null for whole-column parts (A:A)
}

function parsePart(text: string): RefPart | null {
  const cell = CELL_PART.exec(text);
  if (cell) {
    return {
      colAbs: cell[1],
      col: colNameToIndex(cell[2]),
      rowAbs: cell[3],
      row: parseInt(cell[4], 10) - 1,
    };
  }
  const column = COLUMN_PART.exec(text);
  if (column) {
    return { colAbs: column[1], col: colNameToIndex(column[2]), rowAbs: '', row: null };
  }
  return null;
}

function formatPart(part: RefPart): string {
  const col = `${part.colAbs}${indexToColName(part.col)}`;
  return part.row === null ? col : `${col}${part.rowAbs}${part.row + 1}`;
}

/** Shifts one coordinate; returns null when it points at a deleted row/column. */
function shiftCoordinate(value: number, change: StructuralChange): number | null {
  if (change.type === 'insert') {
    return value >= change.index ? value + 1 : value;
  }
  if (value === change.index) return null;
  return value > change.index ? value - 1 : value;
}

/** Shifts a range's [lo, hi] bounds; returns null when the whole span is deleted. */
function shiftSpan(lo: number, hi: number, change: StructuralChange): [number, number] | null {
  if (change.type === 'insert') {
    return [lo >= change.index ? lo + 1 : lo, hi >= change.index ? hi + 1 : hi];
  }
  if (lo === change.index && hi === change.index) return null;
  // Deleting inside or at the edge of a range shrinks it, like spreadsheets do.
  return [lo > change.index ? lo - 1 : lo, hi >= change.index ? hi - 1 : hi];
}

function rewriteReference(text: string, change: StructuralChange): string {
  const [startText, endText] = text.split(':');
  const start = parsePart(startText);
  if (!start) return text;

  const key = change.axis === 'row' ? 'row' : 'col';

  if (endText === undefined) {
    if (start[key] === null) return text;
    const shifted = shiftCoordinate(start[key] as number, change);
    if (shifted === null) return '#REF!';
    return formatPart({ ...start, [key]: shifted });
  }

  const end = parsePart(endText);
  if (!end) return text;
  if (start[key] === null || end[key] === null) return text; // e.g. rows of A:A

  const startValue = start[key] as number;
  const endValue = end[key] as number;
  const span = shiftSpan(Math.min(startValue, endValue), Math.max(startValue, endValue), change);
  if (span === null) return '#REF!';
  const [lo, hi] = span;
  const newStart = { ...start, [key]: startValue <= endValue ? lo : hi };
  const newEnd = { ...end, [key]: startValue <= endValue ? hi : lo };
  return `${formatPart(newStart)}:${formatPart(newEnd)}`;
}

/**
 * Rewrites the cell and range references in `formula` after a row or column
 * is inserted or deleted, the way spreadsheet apps do: references after the
 * change shift, ranges grow or shrink, and references to a deleted row/column
 * become `#REF!`. Absolute (`$`) markers are kept. String literals, property
 * references and function names are left untouched.
 */
export function shiftFormulaReferences(formula: string, change: StructuralChange): string {
  return mapFormulaReferences(formula, (text) => rewriteReference(text, change));
}

/**
 * Calls `rewrite` with the source text of every cell or range reference in
 * `formula` (e.g. `"$A1"`, `"B2:C10"`, `"A:A"`) and splices in its result.
 * String literals, property references and function names (e.g. `LOG10(`)
 * are skipped. Formulas that fail to tokenize are returned unchanged.
 */
export function mapFormulaReferences(formula: string, rewrite: (reference: string) => string): string {
  if (!formula.startsWith('=')) return formula;

  let tokens;
  try {
    tokens = tokenizeFormula(formula);
  } catch {
    return formula;
  }

  let result = '';
  let cursor = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'CELL_REF' && token.type !== 'RANGE') continue;
    // Function names that look like cell references (e.g. LOG10) are calls.
    if (tokens[i + 1]?.type === 'LPAREN') continue;

    let end = token.position;
    while (end < formula.length && REF_CHAR.test(formula[end])) end++;
    const original = formula.slice(token.position, end);

    result += formula.slice(cursor, token.position) + rewrite(original);
    cursor = end;
  }
  return result + formula.slice(cursor);
}

/**
 * Moves a formula by (`rowOffset`, `colOffset`), as copy/paste and autofill
 * do: relative row/column parts shift, `$`-absolute parts stay. A reference
 * pushed above row 1 or left of column A becomes `#REF!`.
 */
export function offsetFormulaReferences(formula: string, rowOffset: number, colOffset: number): string {
  if (rowOffset === 0 && colOffset === 0) return formula;
  return mapFormulaReferences(formula, (text) => {
    const parts = text.split(':').map(parsePart);
    if (parts.some((p) => p === null)) return text;
    const moved: RefPart[] = [];
    for (const part of parts as RefPart[]) {
      const col = part.colAbs ? part.col : part.col + colOffset;
      const row = part.row === null || part.rowAbs ? part.row : part.row + rowOffset;
      if (col < 0 || (row !== null && row < 0)) return '#REF!';
      moved.push({ ...part, col, row });
    }
    return moved.map(formatPart).join(':');
  });
}

/** A 0-based cell position. */
export interface CellPosition {
  row: number;
  col: number;
}

// Ranges larger than this are never remapped cell by cell.
const MAX_REMAP_RANGE_CELLS = 100_000;

/**
 * Rewrites references when cells *move* (sort, transpose): references follow
 * the cell they point at, whether relative or absolute. `moveCell` returns a
 * cell's new position, or null when it did not move. A range is remapped only
 * when its cells moved together as a rectangle of the same size (e.g. a
 * one-row range inside a sorted row, or a range inside a transposed block);
 * otherwise it is kept, since it still covers the same rows and columns.
 */
export function remapFormulaReferences(
  formula: string,
  moveCell: (position: CellPosition) => CellPosition | null,
): string {
  return mapFormulaReferences(formula, (text) => {
    const parts = text.split(':').map(parsePart);
    if (parts.some((p) => p === null)) return text;
    const [start, end] = parts as RefPart[];
    if (start.row === null || (end && end.row === null)) return text; // whole columns

    if (!end) {
      const target = moveCell({ row: start.row, col: start.col });
      return target ? formatPart({ ...start, row: target.row, col: target.col }) : text;
    }

    const lo = { row: Math.min(start.row, end.row!), col: Math.min(start.col, end.col) };
    const hi = { row: Math.max(start.row, end.row!), col: Math.max(start.col, end.col) };
    const area = (hi.row - lo.row + 1) * (hi.col - lo.col + 1);
    if (area > MAX_REMAP_RANGE_CELLS) return text;

    let minR = Infinity;
    let maxR = -Infinity;
    let minC = Infinity;
    let maxC = -Infinity;
    let movedAny = false;
    const targets = new Set<string>();
    for (let r = lo.row; r <= hi.row; r++) {
      for (let c = lo.col; c <= hi.col; c++) {
        const moved = moveCell({ row: r, col: c });
        if (moved) movedAny = true;
        const t = moved ?? { row: r, col: c };
        targets.add(`${t.row}:${t.col}`);
        minR = Math.min(minR, t.row);
        maxR = Math.max(maxR, t.row);
        minC = Math.min(minC, t.col);
        maxC = Math.max(maxC, t.col);
      }
    }
    // The cells must still form a filled rectangle of the same area.
    if (!movedAny || targets.size !== area || (maxR - minR + 1) * (maxC - minC + 1) !== area) {
      return text;
    }
    return `${formatPart({ ...start, row: minR, col: minC })}:${formatPart({ ...end, row: maxR, col: maxC })}`;
  });
}
