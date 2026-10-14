import type { FormulaFunctionContext } from '../registry';
import { hasWildcards, wildcardToRegExp } from '../criteria';
import {
  compareValues,
  isBlank,
  isFormulaError,
  normalizeValue,
  rangeGet,
  sliceRange,
  type FormulaRange,
} from '../values';
import { arg, failed, optional, type FunctionTable } from './helpers';

/**
 * Lookup functions return single values. A function that would return a whole
 * row or column (INDEX with row 0, XLOOKUP with a 2D return array) returns an
 * array: other functions can aggregate it (`SUM(INDEX(A1:C3, 0, 2))`), and a
 * cell showing it spills it into the cells below/right (dynamic arrays).
 */

type MatchMode = 'exact' | 'wildcard' | 'next-smaller' | 'next-larger' | 'sorted-asc' | 'sorted-desc';

const sameType = (a: unknown, b: unknown) =>
  (typeof a === 'number') === (typeof b === 'number') && (typeof a === 'boolean') === (typeof b === 'boolean');

/**
 * Finds `target` in `values`; returns its index or -1.
 * - `exact`: equal values (case-insensitive text, numeric text = number);
 * - `wildcard`: like exact, but text targets may use `*`, `?` and `~`;
 * - `next-smaller` / `next-larger`: exact match, else the closest smaller / larger value;
 * - `sorted-asc` / `sorted-desc`: approximate match on sorted data, as MATCH 1 / -1 and
 *   VLOOKUP TRUE: the last value <= target (ascending) or >= target (descending).
 */
export function lookupIndex(values: readonly unknown[], target: unknown, mode: MatchMode, reverse = false): number {
  const wanted = normalizeValue(target);
  const order = values.map((_, i) => i);
  if (reverse) order.reverse();

  if (mode === 'exact' || mode === 'wildcard') {
    const regex = mode === 'wildcard' && typeof wanted === 'string' && hasWildcards(wanted) ? wildcardToRegExp(wanted) : null;
    for (const i of order) {
      const value = normalizeValue(values[i]);
      if (isFormulaError(value) || isBlank(value)) continue;
      if (regex ? typeof value === 'string' && regex.test(value) : sameType(value, wanted) && compareValues(value, wanted) === 0) {
        return i;
      }
    }
    return -1;
  }

  if (mode === 'sorted-asc' || mode === 'sorted-desc') {
    let found = -1;
    for (let i = 0; i < values.length; i++) {
      const value = normalizeValue(values[i]);
      if (isFormulaError(value) || isBlank(value) || !sameType(value, wanted)) continue;
      const cmp = compareValues(value, wanted);
      if (mode === 'sorted-asc' ? cmp <= 0 : cmp >= 0) found = i;
      else break;
    }
    return found;
  }

  let best = -1;
  let bestValue: unknown;
  for (const i of order) {
    const value = normalizeValue(values[i]);
    if (isFormulaError(value) || isBlank(value) || !sameType(value, wanted)) continue;
    const cmp = compareValues(value, wanted);
    if (cmp === 0) return i;
    const candidate = mode === 'next-smaller' ? cmp < 0 : cmp > 0;
    const closer =
      best === -1 || (mode === 'next-smaller' ? compareValues(value, bestValue) > 0 : compareValues(value, bestValue) < 0);
    if (candidate && closer) {
      best = i;
      bestValue = value;
    }
  }
  return best;
}

/** Values of a one-row or one-column range, or an error if the range is 2D. */
function vector(ctx: FormulaFunctionContext, index: number): { range: FormulaRange; values: any[] } | string {
  const range = ctx.range(index);
  if (failed(range)) return range;
  if (range.rows !== 1 && range.cols !== 1) {
    return ctx.argError(index, '#N/A', 'must be a single row or column.');
  }
  return { range, values: range.values };
}

const notFound = (ctx: FormulaFunctionContext, value: unknown) =>
  ctx.error('#N/A', `${ctx.name} couldn't find ${typeof value === 'string' ? `"${value}"` : String(value)}.`);

/** VLOOKUP / HLOOKUP share everything but orientation. */
function tableLookup(ctx: FormulaFunctionContext, vertical: boolean): any {
  const target = ctx.scalar(0);
  if (isFormulaError(target)) return target;
  const table = ctx.range(1);
  if (failed(table)) return table;
  const index = ctx.integer(2);
  if (failed(index)) return index;
  const approximate = ctx.boolean(3, true);
  if (failed(approximate)) return approximate;

  const span = vertical ? table.cols : table.rows;
  if (index < 1) return ctx.argError(2, '#VALUE!', 'must be 1 or more.');
  if (index > span) {
    return ctx.argError(2, '#REF!', `is larger than the number of ${vertical ? 'columns' : 'rows'} in the table (${span}).`);
  }

  const keys = vertical ? sliceRange(table, 0, table.rows, 0, 1) : sliceRange(table, 0, 1, 0, table.cols);
  const position = lookupIndex(keys, target, approximate ? 'sorted-asc' : 'wildcard');
  if (position === -1) return notFound(ctx, target);
  return vertical ? rangeGet(table, position, index - 1) : rangeGet(table, index - 1, position);
}

export const LOOKUP_FUNCTIONS: FunctionTable = [
  {
    name: 'VLOOKUP',
    category: 'lookup',
    description: 'Looks for a value in the first column of a table and returns the value in the same row of another column.',
    args: [
      arg('lookup_value', 'The value to find in the first column.'),
      arg('table_array', 'The table to search.', 'range'),
      arg('col_index_num', 'Which column to return (1 = first column).', 'number'),
      optional('range_lookup', 'FALSE for an exact match; TRUE or omitted for the closest match in a sorted first column.', 'logical'),
    ],
    evaluate: (ctx) => tableLookup(ctx, true),
  },
  {
    name: 'HLOOKUP',
    category: 'lookup',
    description: 'Looks for a value in the first row of a table and returns the value in the same column of another row.',
    args: [
      arg('lookup_value', 'The value to find in the first row.'),
      arg('table_array', 'The table to search.', 'range'),
      arg('row_index_num', 'Which row to return (1 = first row).', 'number'),
      optional('range_lookup', 'FALSE for an exact match; TRUE or omitted for the closest match in a sorted first row.', 'logical'),
    ],
    evaluate: (ctx) => tableLookup(ctx, false),
  },
  {
    name: 'MATCH',
    category: 'lookup',
    description: 'Returns the position of a value in a row or column.',
    args: [
      arg('lookup_value', 'The value to find.'),
      arg('lookup_array', 'A single row or column to search.', 'range'),
      optional('match_type', '0 = exact; 1 (default) = largest value <= lookup_value in ascending data; -1 = smallest value >= lookup_value in descending data.', 'number'),
    ],
    evaluate: (ctx) => {
      const target = ctx.scalar(0);
      if (isFormulaError(target)) return target;
      const list = vector(ctx, 1);
      if (failed(list)) return list;
      const type = ctx.number(2, 1);
      if (failed(type)) return type;
      const mode: MatchMode = type === 0 ? 'wildcard' : type > 0 ? 'sorted-asc' : 'sorted-desc';
      const position = lookupIndex(list.values, target, mode);
      return position === -1 ? notFound(ctx, target) : position + 1;
    },
  },
  {
    name: 'INDEX',
    category: 'lookup',
    description: 'Returns the value at a row and column of a range. Row or column 0 returns the whole column or row.',
    args: [
      arg('array', 'The range to read from.', 'range'),
      arg('row_num', 'The row (1 = first row; 0 = every row).', 'number'),
      optional('column_num', 'The column (1 = first column; 0 = every column).', 'number'),
    ],
    evaluate: (ctx) => {
      const range = ctx.range(0);
      if (failed(range)) return range;
      let row = ctx.integer(1);
      if (failed(row)) return row;
      let col = ctx.integer(2, ctx.has(2) ? undefined : 1);
      if (failed(col)) return col;
      // INDEX(single_row, n) picks the n-th column.
      if (!ctx.has(2) && range.rows === 1 && range.cols > 1) {
        col = row;
        row = 1;
      }
      if (row < 0 || row > range.rows) {
        return ctx.argError(1, '#REF!', `is outside the range (1 to ${range.rows}).`);
      }
      if (col < 0 || col > range.cols) {
        return ctx.argError(2, '#REF!', `is outside the range (1 to ${range.cols}).`);
      }
      if (row === 0 && col === 0) return range.values;
      if (row === 0) return sliceRange(range, 0, range.rows, col - 1, 1);
      if (col === 0) return sliceRange(range, row - 1, 1, 0, range.cols);
      return rangeGet(range, row - 1, col - 1);
    },
  },
  {
    name: 'XLOOKUP',
    category: 'lookup',
    description: 'Finds a value in one range and returns the value at the same position in another range.',
    args: [
      arg('lookup_value', 'The value to find.'),
      arg('lookup_array', 'A single row or column to search.', 'range'),
      arg('return_array', 'The range to return a value from; same height (or width) as lookup_array.', 'range'),
      optional('if_not_found', 'Returned when nothing matches (default #N/A).'),
      optional('match_mode', '0 (default) = exact; -1 = exact or next smaller; 1 = exact or next larger; 2 = wildcard match.', 'number'),
      optional('search_mode', '1 (default) = first to last; -1 = last to first.', 'number'),
    ],
    evaluate: (ctx) => {
      const target = ctx.scalar(0);
      if (isFormulaError(target)) return target;
      const list = vector(ctx, 1);
      if (failed(list)) return list;
      const result = ctx.range(2);
      if (failed(result)) return result;
      const matchMode = ctx.integer(4, 0);
      if (failed(matchMode)) return matchMode;
      const searchMode = ctx.integer(5, 1);
      if (failed(searchMode)) return searchMode;

      const vertical = list.range.cols === 1 && list.range.rows > 1;
      const length = list.values.length;
      if ((vertical ? result.rows : result.cols) !== length && !(length === 1 && (result.rows === 1 || result.cols === 1))) {
        return ctx.argError(2, '#VALUE!', 'must be the same height (or width) as argument 2.');
      }
      const modes: Record<number, MatchMode> = { 0: 'exact', [-1]: 'next-smaller', 1: 'next-larger', 2: 'wildcard' };
      const mode = modes[matchMode];
      if (!mode) return ctx.argError(4, '#VALUE!', 'must be 0, -1, 1 or 2.');
      if (![1, -1, 2, -2].includes(searchMode)) return ctx.argError(5, '#VALUE!', 'must be 1, -1, 2 or -2.');

      const position = lookupIndex(list.values, target, mode, searchMode < 0);
      if (position === -1) return ctx.has(3) ? ctx.value(3) : notFound(ctx, target);
      if (vertical) {
        return result.cols === 1 ? rangeGet(result, position, 0) : sliceRange(result, position, 1, 0, result.cols);
      }
      return result.rows === 1 ? rangeGet(result, 0, position) : sliceRange(result, 0, result.rows, position, 1);
    },
  },
];
