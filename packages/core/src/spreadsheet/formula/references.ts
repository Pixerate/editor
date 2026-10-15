// Portions ported from gridcraft/crates/formula/src/adjust.rs and
// gridcraft/crates/engine/src/cmd/formulas.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { tokenizeFormula, type FormulaToken } from './lexer';
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
export function shiftFormulaReferences(
  formula: string,
  change: StructuralChange,
  options: FormulaReferenceFilter = {},
): string {
  return mapFormulaReferences(formula, (text, info) =>
    !options.appliesTo || options.appliesTo(info.sheet, info.sheetEnd) ? rewriteReference(text, change) : text,
  );
}

/**
 * Limits a rewrite to some references, e.g. only those pointing at the sheet
 * that changed: `appliesTo(sheet)` gets the reference's sheet (undefined for
 * the formula's own sheet) and, for 3-D references, the last sheet.
 */
export interface FormulaReferenceFilter {
  appliesTo?: (sheet: string | undefined, sheetEnd: string | undefined) => boolean;
}

/** Where a reference passed to a `mapFormulaReferences` callback points. */
export interface FormulaReferenceInfo {
  /** Sheet of a qualified reference (`Sheet2!A1`), unquoted; undefined for the formula's own sheet. */
  sheet?: string;
  /** Last sheet of a 3-D reference. */
  sheetEnd?: string;
}

/**
 * Calls `rewrite` with the source text of every cell or range reference in
 * `formula` (e.g. `"$A1"`, `"B2:C10"`, `"A:A"`) and splices in its result.
 * For a spill reference (`A1#`) it receives the anchor (`"A1"`) and the `#`
 * is kept, unless the rewrite returns `#REF!`. A sheet prefix (`Sheet2!`,
 * `'My Sheet'!`) is not part of the text: `info` says which sheet the
 * reference points at, and the prefix is kept unless the rewrite returns
 * `#REF!`. String literals, property references and function names (e.g.
 * `LOG10(`) are skipped. Formulas that fail to tokenize are returned unchanged.
 */
export function mapFormulaReferences(
  formula: string,
  rewrite: (reference: string, info: FormulaReferenceInfo) => string,
): string {
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
    if (token.type !== 'CELL_REF' && token.type !== 'RANGE' && token.type !== 'SPILL_REF') continue;
    // Function names that look like cell references (e.g. LOG10) are calls.
    if (tokens[i + 1]?.type === 'LPAREN') continue;

    const refStart = token.refStart ?? token.position;
    let end = refStart;
    while (end < formula.length && REF_CHAR.test(formula[end])) end++;
    const original = formula.slice(refStart, end);
    const info: FormulaReferenceInfo =
      token.sheet === undefined ? {} : token.sheetEnd === undefined ? { sheet: token.sheet } : { sheet: token.sheet, sheetEnd: token.sheetEnd };
    const prefix = formula.slice(token.position, refStart);

    if (token.type === 'SPILL_REF') {
      // A1#: the anchor is rewritten like a cell reference; `#` stays.
      const rewritten = rewrite(original, info);
      result += formula.slice(cursor, token.position) + (rewritten === '#REF!' ? rewritten : `${prefix}${rewritten}#`);
      cursor = end + 1;
      continue;
    }

    const rewritten = rewrite(original, info);
    result += formula.slice(cursor, token.position) + (rewritten === '#REF!' ? rewritten : prefix + rewritten);
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
  options: FormulaReferenceFilter = {},
): string {
  return mapFormulaReferences(formula, (text, info) => {
    if (options.appliesTo && !options.appliesTo(info.sheet, info.sheetEnd)) return text;
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

/**
 * Transposes a formula that is written relative to `anchor` (a rule formula:
 * conditional formatting or data validation) for a block transposed in
 * place around its top-left cell (`block.startRow`, `block.startCol`). The
 * result is written for the transposed anchor. Relative offsets swap axes
 * (a reference one column to the right becomes one row below) and `$`
 * parts inside the block follow the cell they point at, so the `$` flags
 * swap axes too (`$B2` → `C$2`). References with a `$` part outside the
 * block (or on another sheet), whole columns and other sheets' absolute
 * references keep their text.
 */
export function transposeFormulaReferences(
  formula: string,
  anchor: CellPosition,
  block: { startRow: number; startCol: number; endRow: number; endCol: number },
): string {
  const t = { row: block.startRow + (anchor.col - block.startCol), col: block.startCol + (anchor.row - block.startRow) };
  return mapFormulaReferences(formula, (text, info) => {
    const parts = text.split(':').map(parsePart);
    if (parts.some((p) => p === null || p.row === null)) return text;
    const moved: RefPart[] = [];
    for (const part of parts as RefPart[]) {
      const row = part.row as number;
      const colAbs = !!part.colAbs;
      const rowAbs = !!part.rowAbs;
      if ((colAbs || rowAbs) && info.sheet !== undefined) return text;
      if (colAbs && (part.col < block.startCol || part.col > block.endCol)) return text;
      if (rowAbs && (row < block.startRow || row > block.endRow)) return text;
      const newRow = colAbs ? block.startRow + (part.col - block.startCol) : t.row + (part.col - anchor.col);
      const newCol = rowAbs ? block.startCol + (row - block.startRow) : t.col + (row - anchor.row);
      if (newRow < 0 || newCol < 0) return '#REF!';
      moved.push({ colAbs: part.rowAbs, col: newCol, rowAbs: part.colAbs, row: newRow });
    }
    return moved.map(formatPart).join(':');
  });
}

// --- Sheets and defined names ---

// A1-style reference within Excel's grid (columns up to XFD).
const CELL_LIKE = /^[A-Za-z]{1,3}\d{1,7}$/;
const isCellLike = (name: string) => {
  if (!CELL_LIKE.test(name)) return false;
  const letters = name.match(/^[A-Za-z]+/)![0].toUpperCase();
  const col = Array.from(letters).reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const row = Number(name.slice(letters.length));
  return col <= 16384 && row >= 1 && row <= 1048576;
};
const R1C1_LIKE = /^[Rr]\d*(?:[Cc]\d*)?$|^[Cc]\d*$/;

/**
 * Whether a sheet name must be quoted in a formula (`'My Sheet'!A1`): names
 * with spaces or punctuation, starting with a digit, or that look like a
 * cell reference (`A1`, `R1C1`) or a boolean.
 */
export function sheetNameNeedsQuotes(name: string): boolean {
  if (!/^[A-Za-z_\p{L}][\p{L}\p{N}_.]*$/u.test(name)) return true;
  const upper = name.toUpperCase();
  return isCellLike(name) || R1C1_LIKE.test(name) || upper === 'TRUE' || upper === 'FALSE';
}

/** A sheet name as written in formulas: `Data`, `'My Sheet'`, `'Bob''s'`. */
export function quoteSheetName(name: string): string {
  return sheetNameNeedsQuotes(name) ? `'${name.replace(/'/g, "''")}'` : name;
}

/** The prefix of a reference to `sheet` (or the 3-D span `sheet:sheetEnd`), with `!`. */
export function formatSheetPrefix(sheet: string, sheetEnd?: string): string {
  if (sheetEnd === undefined) return `${quoteSheetName(sheet)}!`;
  const quoted = sheetNameNeedsQuotes(sheet) || sheetNameNeedsQuotes(sheetEnd);
  return quoted ? `'${`${sheet}:${sheetEnd}`.replace(/'/g, "''")}'!` : `${sheet}:${sheetEnd}!`;
}

function tokensOf(formula: string): FormulaToken[] | null {
  if (!formula.startsWith('=')) return null;
  try {
    return tokenizeFormula(formula);
  } catch {
    return null;
  }
}

/** Replaces token spans: `edit` returns the new text for a token, or null to keep it. */
function rewriteTokens(formula: string, edit: (token: FormulaToken) => { from: number; to: number; text: string } | null): string {
  const tokens = tokensOf(formula);
  if (!tokens) return formula;
  let result = '';
  let cursor = 0;
  for (const token of tokens) {
    const change = edit(token);
    if (!change) continue;
    result += formula.slice(cursor, change.from) + change.text;
    cursor = change.to;
  }
  return cursor === 0 ? formula : result + formula.slice(cursor);
}

const sameName = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();

/**
 * Rewrites references to the sheet `oldName` (cell, range, spill and 3-D
 * references, and sheet-qualified names such as `Old!Rate`) after it is
 * renamed to `newName`, quoting the new name when needed.
 */
export function renameSheetInFormula(formula: string, oldName: string, newName: string): string {
  return rewriteTokens(formula, (token) => {
    if (token.sheet === undefined || token.refStart === undefined) return null;
    const first = sameName(token.sheet, oldName);
    const last = token.sheetEnd !== undefined && sameName(token.sheetEnd, oldName);
    if (!first && !last) return null;
    const sheet = first ? newName : token.sheet;
    const sheetEnd = token.sheetEnd === undefined ? undefined : last ? newName : token.sheetEnd;
    return { from: token.position, to: token.refStart, text: formatSheetPrefix(sheet, sheetEnd) };
  });
}

/**
 * Rewrites a formula after the sheet `name` is deleted: references to it
 * become `#REF!`. `order` lists the sheet names before the deletion, in tab
 * order: a 3-D reference losing an end sheet shrinks to the neighbouring
 * sheet, as in Excel (`Sheet1:Sheet3!A1` without Sheet1 is `Sheet2:Sheet3!A1`).
 */
export function deleteSheetInFormula(formula: string, name: string, order: readonly string[] = []): string {
  const position = (sheet: string) => order.findIndex((s) => sameName(s, sheet));
  return rewriteTokens(formula, (token) => {
    if (token.sheet === undefined || token.refStart === undefined) return null;
    const end = token.end ?? token.refStart;
    if (token.sheetEnd === undefined) {
      return sameName(token.sheet, name) ? { from: token.position, to: end, text: '#REF!' } : null;
    }
    const first = sameName(token.sheet, name);
    const last = sameName(token.sheetEnd, name);
    if (!first && !last) return null;
    const a = position(token.sheet);
    const b = position(token.sheetEnd);
    if (a < 0 || b < 0 || a === b) return { from: token.position, to: end, text: '#REF!' };
    // The deleted end moves one sheet towards the other end.
    const inward = (from: number, to: number) => order[from < to ? from + 1 : from - 1];
    const newFirst = first ? inward(a, b) : token.sheet;
    const newLast = last ? inward(b, a) : token.sheetEnd;
    const prefix = sameName(newFirst, newLast) ? formatSheetPrefix(newFirst) : formatSheetPrefix(newFirst, newLast);
    return { from: token.position, to: token.refStart, text: prefix };
  });
}

/**
 * Renames uses of the defined name `oldName` (`Rate`, `Rate*2`, `Double(4)`,
 * `Data!Rate`) to `newName`. `appliesTo(sheet)` decides, for a
 * sheet-qualified use, whether that sheet's name is the renamed one; unset,
 * every use is renamed. With `qualifiedOnly`, unqualified uses are kept (the
 * formula is on a sheet where the name means something else).
 */
export function renameNameInFormula(
  formula: string,
  oldName: string,
  newName: string,
  options: { appliesTo?: (sheet: string) => boolean; qualifiedOnly?: boolean } = {},
): string {
  return rewriteTokens(formula, (token) => {
    if (token.type !== 'IDENTIFIER' || !sameName(token.value, oldName)) return null;
    if (token.sheet !== undefined ? options.appliesTo && !options.appliesTo(token.sheet) : options.qualifiedOnly) return null;
    const from = token.refStart ?? token.position;
    return { from, to: token.end ?? from + oldName.length, text: newName };
  });
}

/** Upper-case names used in a formula (bare names, calls and sheet-qualified names). */
export function formulaIdentifiers(formula: string): Array<{ name: string; sheet?: string; call: boolean }> {
  const tokens = tokensOf(formula);
  if (!tokens) return [];
  const out: Array<{ name: string; sheet?: string; call: boolean }> = [];
  tokens.forEach((token, i) => {
    if (token.type !== 'IDENTIFIER') return;
    const call = tokens[i + 1]?.type === 'LPAREN';
    out.push(token.sheet === undefined ? { name: token.value, call } : { name: token.value, sheet: token.sheet, call });
  });
  return out;
}
