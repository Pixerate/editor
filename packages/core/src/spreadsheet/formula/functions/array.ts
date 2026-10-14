import type { FormulaFunctionContext } from '../registry';
import {
  compareValues,
  isBlank,
  isFormulaError,
  normalizeValue,
  rangeGet,
  toBoolean,
  toFormulaRange,
  withRangeShape,
  type FormulaRange,
} from '../values';
import { arg, failed, optional, repeating, type FunctionTable } from './helpers';

/**
 * Dynamic-array functions. They return shaped, column-major arrays (see
 * `withRangeShape`); a cell holding one spills the array into the cells
 * below and to the right. Empty results are #CALC!, as in Excel.
 */

/** Largest array SEQUENCE and RANDARRAY may build. */
const MAX_ARRAY_CELLS = 1_000_000;

/** An argument as a range; a single value is a 1x1 range. */
function rangeArg(ctx: FormulaFunctionContext, index: number): FormulaRange | string {
  const value = ctx.value(index);
  if (Array.isArray(value)) return toFormulaRange(value);
  if (isFormulaError(value)) return value;
  return { rows: 1, cols: 1, values: [value] };
}

/** Builds a shaped column-major array from row-major rows. */
function fromRows(rows: any[][], cols: number): any[] {
  const out: any[] = [];
  for (let c = 0; c < cols; c++) {
    for (const row of rows) out.push(row[c]);
  }
  return withRangeShape(out, rows.length, cols);
}

const rowOf = (range: FormulaRange, r: number): any[] => {
  const row: any[] = [];
  for (let c = 0; c < range.cols; c++) row.push(rangeGet(range, r, c));
  return row;
};

const colOf = (range: FormulaRange, c: number): any[] => {
  const col: any[] = [];
  for (let r = 0; r < range.rows; r++) col.push(rangeGet(range, r, c));
  return col;
};

/** The rows (or, `byCol`, the columns) of a range as lists. */
const linesOf = (range: FormulaRange, byCol: boolean): any[][] =>
  byCol
    ? Array.from({ length: range.cols }, (_, c) => colOf(range, c))
    : Array.from({ length: range.rows }, (_, r) => rowOf(range, r));

/** Rebuilds a range from lines (rows, or columns when `byCol`). */
function fromLines(lines: any[][], byCol: boolean, width: number): any[] {
  if (!byCol) return fromRows(lines, width);
  const out: any[] = [];
  for (const line of lines) for (const v of line) out.push(v);
  return withRangeShape(out, width, lines.length);
}

/** Sort comparison for SORT/SORTBY: numeric text sorts as numbers, blanks last in either order. */
function compareForSort(a: unknown, b: unknown, order: number): number {
  const blankA = isBlank(a);
  const blankB = isBlank(b);
  if (blankA || blankB) return blankA === blankB ? 0 : blankA ? 1 : -1;
  return compareValues(normalizeValue(a), normalizeValue(b)) * order;
}

const sortOrder = (ctx: FormulaFunctionContext, index: number): number | string => {
  const order = ctx.integer(index, 1);
  if (failed(order)) return order;
  return order === 1 || order === -1 ? order : ctx.argError(index, '#VALUE!', 'must be 1 (ascending) or -1 (descending).');
};

/** A value used as a FILTER condition. */
function includeFlag(value: unknown): boolean | string {
  if (isFormulaError(value)) return value;
  const flag = toBoolean(value);
  return isFormulaError(flag) ? '#VALUE!' : flag;
}

export const ARRAY_FUNCTIONS: FunctionTable = [
  {
    name: 'FILTER',
    category: 'lookup',
    description: 'Returns the rows (or columns) of an array whose include value is TRUE. The result spills.',
    args: [
      arg('array', 'The range or array to filter.', 'range'),
      arg('include', 'TRUE/FALSE for each row (a column as tall as array) or each column (a row as wide as array).'),
      optional('if_empty', 'Returned when nothing matches (default #CALC!).'),
    ],
    evaluate: (ctx) => {
      const range = rangeArg(ctx, 0);
      if (failed(range)) return range;
      const include = rangeArg(ctx, 1);
      if (failed(include)) return include;

      let byCol: boolean;
      if (include.cols === 1 && include.rows === range.rows) byCol = false;
      else if (include.rows === 1 && include.cols === range.cols) byCol = true;
      else {
        return ctx.argError(1, '#VALUE!', 'must be a single column as tall as argument 1 (or a single row as wide).');
      }

      const lines = linesOf(range, byCol);
      const kept: any[][] = [];
      for (let i = 0; i < lines.length; i++) {
        const flag = includeFlag(include.values[i]);
        if (typeof flag === 'string') {
          return flag === '#VALUE!' ? ctx.argError(1, '#VALUE!', `has a value that isn't TRUE or FALSE (${include.values[i]}).`) : flag;
        }
        if (flag) kept.push(lines[i]);
      }
      if (kept.length === 0) {
        return ctx.has(2) ? ctx.value(2) : ctx.error('#CALC!', 'FILTER found no matching values.');
      }
      return fromLines(kept, byCol, byCol ? range.rows : range.cols);
    },
  },
  {
    name: 'SORT',
    category: 'lookup',
    description: 'Sorts the rows (or columns) of an array by one of its columns (or rows). The result spills.',
    args: [
      arg('array', 'The range or array to sort.', 'range'),
      optional('sort_index', 'The column (or row, with by_col) to sort by; 1 = first (default).', 'number'),
      optional('sort_order', '1 = ascending (default), -1 = descending.', 'number'),
      optional('by_col', 'TRUE sorts columns by a row; FALSE (default) sorts rows by a column.', 'logical'),
    ],
    evaluate: (ctx) => {
      const range = rangeArg(ctx, 0);
      if (failed(range)) return range;
      const index = ctx.integer(1, 1);
      if (failed(index)) return index;
      const order = sortOrder(ctx, 2);
      if (failed(order)) return order;
      const byCol = ctx.boolean(3, false);
      if (failed(byCol)) return byCol;
      const width = byCol ? range.rows : range.cols;
      if (index < 1 || index > width) {
        return ctx.argError(1, '#VALUE!', `must be between 1 and ${width}.`);
      }
      const lines = linesOf(range, byCol)
        .map((line, position) => ({ line, position }))
        .sort((a, b) => compareForSort(a.line[index - 1], b.line[index - 1], order) || a.position - b.position)
        .map((entry) => entry.line);
      return fromLines(lines, byCol, width);
    },
  },
  {
    name: 'SORTBY',
    category: 'lookup',
    description: 'Sorts an array by the values in other ranges (one value per row or column). The result spills.',
    args: [
      arg('array', 'The range or array to sort.', 'range'),
      arg('by_array', 'A column as tall as array (or a row as wide) to sort by.', 'range'),
      optional('sort_order', '1 = ascending (default), -1 = descending.', 'number'),
      arg('by_array', 'Another range to sort by, for ties.', 'range', { repeating: true, optional: true }),
      arg('sort_order', 'Its order: 1 = ascending (default), -1 = descending.', 'number', { repeating: true, optional: true }),
    ],
    allowTrailingArgument: true,
    evaluate: (ctx) => {
      const range = rangeArg(ctx, 0);
      if (failed(range)) return range;
      const keys: Array<{ values: any[]; order: number }> = [];
      let byCol: boolean | null = null;
      for (let i = 1; i < ctx.args.length; i += 2) {
        const by = rangeArg(ctx, i);
        if (failed(by)) return by;
        let keyByCol: boolean;
        if (by.cols === 1 && by.rows === range.rows) keyByCol = false;
        else if (by.rows === 1 && by.cols === range.cols) keyByCol = true;
        else {
          return ctx.argError(i, '#VALUE!', 'must be a single column as tall as argument 1 (or a single row as wide).');
        }
        if (byCol !== null && byCol !== keyByCol) {
          return ctx.argError(i, '#VALUE!', 'must have the same orientation as the other sort ranges.');
        }
        byCol = keyByCol;
        const order = sortOrder(ctx, i + 1);
        if (failed(order)) return order;
        keys.push({ values: by.values, order });
      }
      const sortByCol = byCol ?? false;
      const lines = linesOf(range, sortByCol)
        .map((line, position) => ({ line, position }))
        .sort((a, b) => {
          for (const key of keys) {
            const result = compareForSort(key.values[a.position], key.values[b.position], key.order);
            if (result !== 0) return result;
          }
          return a.position - b.position;
        })
        .map((entry) => entry.line);
      return fromLines(lines, sortByCol, sortByCol ? range.rows : range.cols);
    },
  },
  {
    name: 'UNIQUE',
    category: 'lookup',
    description: 'Returns the distinct rows (or columns) of an array, in order of first appearance. The result spills.',
    args: [
      arg('array', 'The range or array.', 'range'),
      optional('by_col', 'TRUE compares columns; FALSE (default) compares rows.', 'logical'),
      optional('exactly_once', 'TRUE returns only the rows that appear exactly once (default FALSE).', 'logical'),
    ],
    evaluate: (ctx) => {
      const range = rangeArg(ctx, 0);
      if (failed(range)) return range;
      const byCol = ctx.boolean(1, false);
      if (failed(byCol)) return byCol;
      const exactlyOnce = ctx.boolean(2, false);
      if (failed(exactlyOnce)) return exactlyOnce;

      // Text compares case-insensitively and numeric text equals its number.
      const keyOf = (line: any[]) =>
        JSON.stringify(
          line.map((v) => {
            const n = normalizeValue(v);
            return typeof n === 'string' ? `s:${n.toLowerCase()}` : isBlank(n) ? 'blank' : `${typeof n}:${String(n)}`;
          }),
        );
      const counts = new Map<string, { line: any[]; count: number }>();
      for (const line of linesOf(range, byCol)) {
        const key = keyOf(line);
        const entry = counts.get(key);
        if (entry) entry.count++;
        else counts.set(key, { line, count: 1 });
      }
      const lines = Array.from(counts.values())
        .filter((entry) => !exactlyOnce || entry.count === 1)
        .map((entry) => entry.line);
      if (lines.length === 0) return ctx.error('#CALC!', 'UNIQUE found no values that appear exactly once.');
      return fromLines(lines, byCol, byCol ? range.rows : range.cols);
    },
  },
  {
    name: 'SEQUENCE',
    category: 'math',
    description: 'Returns a grid of sequential numbers, filled row by row. The result spills.',
    args: [
      arg('rows', 'The number of rows.', 'number'),
      optional('columns', 'The number of columns (default 1).', 'number'),
      optional('start', 'The first number (default 1).', 'number'),
      optional('step', 'The increment (default 1).', 'number'),
    ],
    evaluate: (ctx) => {
      const rows = ctx.integer(0);
      if (failed(rows)) return rows;
      const cols = ctx.integer(1, 1);
      if (failed(cols)) return cols;
      const start = ctx.number(2, 1);
      if (failed(start)) return start;
      const step = ctx.number(3, 1);
      if (failed(step)) return step;
      if (rows < 1 || cols < 1) return ctx.error('#CALC!', 'SEQUENCE needs at least one row and one column.');
      if (rows * cols > MAX_ARRAY_CELLS) return ctx.error('#NUM!', `SEQUENCE can return at most ${MAX_ARRAY_CELLS} values.`);
      const out: number[] = [];
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) out.push(start + step * (r * cols + c));
      }
      return rows * cols === 1 ? out[0] : withRangeShape(out, rows, cols);
    },
  },
  {
    name: 'TRANSPOSE',
    category: 'lookup',
    description: 'Swaps the rows and columns of an array. The result spills.',
    args: [arg('array', 'The range or array to transpose.', 'range')],
    evaluate: (ctx) => {
      const range = rangeArg(ctx, 0);
      if (failed(range)) return range;
      if (range.rows * range.cols === 1) return range.values[0];
      const out: any[] = [];
      // Column c of the result is row c of the source.
      for (let r = 0; r < range.rows; r++) {
        for (let c = 0; c < range.cols; c++) out.push(rangeGet(range, r, c));
      }
      return withRangeShape(out, range.cols, range.rows);
    },
  },
  {
    name: 'RANDARRAY',
    category: 'math',
    description: 'Returns a grid of random numbers. Changes on every recalculation. The result spills.',
    args: [
      optional('rows', 'The number of rows (default 1).', 'number'),
      optional('columns', 'The number of columns (default 1).', 'number'),
      optional('min', 'The smallest number (default 0).', 'number'),
      optional('max', 'The largest number (default 1).', 'number'),
      optional('integer', 'TRUE returns whole numbers; FALSE (default) decimals.', 'logical'),
    ],
    volatile: true,
    evaluate: (ctx) => {
      const rows = ctx.integer(0, 1);
      if (failed(rows)) return rows;
      const cols = ctx.integer(1, 1);
      if (failed(cols)) return cols;
      const min = ctx.number(2, 0);
      if (failed(min)) return min;
      const max = ctx.number(3, 1);
      if (failed(max)) return max;
      const integer = ctx.boolean(4, false);
      if (failed(integer)) return integer;
      if (rows < 1 || cols < 1) return ctx.error('#CALC!', 'RANDARRAY needs at least one row and one column.');
      if (rows * cols > MAX_ARRAY_CELLS) return ctx.error('#NUM!', `RANDARRAY can return at most ${MAX_ARRAY_CELLS} values.`);
      if (min > max) return ctx.argError(2, '#VALUE!', "can't be larger than max.");
      if (integer && (!Number.isInteger(min) || !Number.isInteger(max))) {
        return ctx.error('#VALUE!', 'RANDARRAY needs whole min and max values when integer is TRUE.');
      }
      const next = () => (integer ? min + Math.floor(Math.random() * (max - min + 1)) : min + Math.random() * (max - min));
      const out: number[] = [];
      for (let i = 0; i < rows * cols; i++) out.push(next());
      return rows * cols === 1 ? out[0] : withRangeShape(out, rows, cols);
    },
  },
  {
    // Evaluated by the evaluator itself (it defines names); listed here for
    // autocomplete, signatures and argument-count checks.
    name: 'LET',
    category: 'logical',
    description:
      'Names the results of calculations so a formula can reuse them: LET(x, A1*2, x+x). The last argument is the calculation that uses the names.',
    args: [
      repeating('name', 'A name to define (letters, not a cell reference).'),
      repeating('name_value', 'The value of the name.'),
    ],
    allowTrailingArgument: true,
    evaluate: (ctx) => ctx.error('#ERROR!', 'LET must be evaluated by the formula evaluator.'),
  },
];

/**
 * Built-in scalar functions applied element by element to arrays (see
 * `FormulaFunctionDefinition.elementwise`). IF, IFERROR and IFNA lift on
 * their first argument only.
 */
export const ELEMENTWISE_BUILTINS: Readonly<Record<string, true | readonly number[]>> = {
  ABS: true,
  ROUND: true,
  ROUNDUP: true,
  ROUNDDOWN: true,
  INT: true,
  MOD: true,
  POWER: true,
  SQRT: true,
  SIGN: true,
  CEILING: true,
  FLOOR: true,
  LEN: true,
  UPPER: true,
  LOWER: true,
  TRIM: true,
  PROPER: true,
  LEFT: true,
  RIGHT: true,
  MID: true,
  FIND: true,
  SEARCH: true,
  SUBSTITUTE: true,
  REPLACE: true,
  REPT: true,
  EXACT: true,
  VALUE: true,
  TEXT: true,
  YEAR: true,
  MONTH: true,
  DAY: true,
  WEEKDAY: true,
  EDATE: true,
  EOMONTH: true,
  DATE: true,
  NOT: true,
  ISBLANK: true,
  ISNUMBER: true,
  ISTEXT: true,
  ISERROR: true,
  ISNA: true,
  IF: [0],
  IFERROR: [0],
  IFNA: [0],
};
