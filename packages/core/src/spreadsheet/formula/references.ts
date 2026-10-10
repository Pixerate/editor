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

    result += formula.slice(cursor, token.position) + rewriteReference(original, change);
    cursor = end;
  }
  return result + formula.slice(cursor);
}
