import type { FormulaFunctionContext } from '../registry';
import { parseCriteria } from '../criteria';
import { isFormulaError, numericValue, rangeGet, type FormulaRange } from '../values';
import { arg, failed, optional, repeating, type FunctionTable } from './helpers';

const CRITERIA_DESCRIPTION =
  'The condition, e.g. 5, ">5", "<>done", "a*" (wildcards * and ?), or "" for blank cells.';

/**
 * Evaluates (criteria_range, criteria) argument pairs starting at `firstPair`
 * against cells of `base`'s shape. Returns one flag per cell (column-major),
 * or an error string.
 */
function matchMask(
  ctx: FormulaFunctionContext,
  base: FormulaRange,
  baseIndex: number,
  firstPair: number,
): boolean[] | string {
  const mask = new Array<boolean>(base.rows * base.cols).fill(true);
  for (let i = firstPair; i + 1 < ctx.args.length; i += 2) {
    const range = ctx.range(i);
    if (failed(range)) return range;
    if (i !== baseIndex && (range.rows !== base.rows || range.cols !== base.cols)) {
      return ctx.argError(i, '#VALUE!', `must be the same size as argument ${baseIndex + 1} (${base.rows}×${base.cols}).`);
    }
    const criterion = ctx.scalar(i + 1);
    if (isFormulaError(criterion)) return criterion;
    const matches = parseCriteria(criterion);
    for (let k = 0; k < mask.length; k++) {
      if (mask[k] && !matches(range.values[k])) mask[k] = false;
    }
  }
  return mask;
}

/** Numbers of `target` (resized to `base`'s shape) at matching positions. */
function matchedNumbers(target: FormulaRange, base: FormulaRange, mask: boolean[]): number[] | string {
  const nums: number[] = [];
  for (let c = 0; c < base.cols; c++) {
    for (let r = 0; r < base.rows; r++) {
      if (!mask[c * base.rows + r]) continue;
      const value = rangeGet(target, r, c);
      if (isFormulaError(value)) return value;
      const num = numericValue(value);
      if (num !== null) nums.push(num);
    }
  }
  return nums;
}

type Aggregate = (nums: number[], ctx: FormulaFunctionContext) => number | string;

const sum: Aggregate = (nums) => {
  let total = 0;
  for (const num of nums) total += num;
  return total;
};
const average: Aggregate = (nums, ctx) =>
  nums.length === 0
    ? ctx.error('#DIV/0!', `${ctx.name} found no matching numbers to average.`)
    : (sum(nums, ctx) as number) / nums.length;
const max: Aggregate = (nums) => nums.reduce((a, b) => Math.max(a, b), nums.length ? -Infinity : 0);
const min: Aggregate = (nums) => nums.reduce((a, b) => Math.min(a, b), nums.length ? Infinity : 0);

/** SUMIF / AVERAGEIF: (range, criteria, [target_range]). */
function singleCriterion(aggregate: Aggregate) {
  return (ctx: FormulaFunctionContext) => {
    const base = ctx.range(0);
    if (failed(base)) return base;
    const mask = matchMask(ctx, base, 0, 0);
    if (failed(mask)) return mask;
    let target = base;
    if (ctx.has(2)) {
      const range = ctx.range(2);
      if (failed(range)) return range;
      target = range;
    }
    const nums = matchedNumbers(target, base, mask);
    return failed(nums) ? nums : aggregate(nums, ctx);
  };
}

/** SUMIFS / AVERAGEIFS / MAXIFS / MINIFS: (target_range, criteria_range1, criteria1, ...). */
function multipleCriteria(aggregate: Aggregate) {
  return (ctx: FormulaFunctionContext) => {
    const target = ctx.range(0);
    if (failed(target)) return target;
    const mask = matchMask(ctx, target, 0, 1);
    if (failed(mask)) return mask;
    const nums = matchedNumbers(target, target, mask);
    return failed(nums) ? nums : aggregate(nums, ctx);
  };
}

const criteriaPair = [
  repeating('criteria_range', 'A range to test. Must be the same size as the other ranges.', 'range'),
  repeating('criteria', CRITERIA_DESCRIPTION, 'criteria'),
];

export const CONDITIONAL_FUNCTIONS: FunctionTable = [
  {
    name: 'SUMIF',
    category: 'math',
    description: 'Adds the cells that meet a condition.',
    args: [
      arg('range', 'The range to test.', 'range'),
      arg('criteria', CRITERIA_DESCRIPTION, 'criteria'),
      optional('sum_range', 'The cells to add (default: range itself).', 'range'),
    ],
    evaluate: singleCriterion(sum),
  },
  {
    name: 'SUMIFS',
    category: 'math',
    description: 'Adds the cells that meet every condition.',
    args: [arg('sum_range', 'The cells to add.', 'range'), ...criteriaPair],
    evaluate: multipleCriteria(sum),
  },
  {
    name: 'COUNTIF',
    category: 'statistical',
    description: 'Counts the cells that meet a condition.',
    args: [arg('range', 'The range to test.', 'range'), arg('criteria', CRITERIA_DESCRIPTION, 'criteria')],
    evaluate: (ctx) => {
      const base = ctx.range(0);
      if (failed(base)) return base;
      const mask = matchMask(ctx, base, 0, 0);
      return failed(mask) ? mask : mask.filter(Boolean).length;
    },
  },
  {
    name: 'COUNTIFS',
    category: 'statistical',
    description: 'Counts the cells that meet every condition.',
    args: criteriaPair,
    evaluate: (ctx) => {
      const base = ctx.range(0);
      if (failed(base)) return base;
      const mask = matchMask(ctx, base, 0, 0);
      return failed(mask) ? mask : mask.filter(Boolean).length;
    },
  },
  {
    name: 'AVERAGEIF',
    category: 'statistical',
    description: 'Averages the cells that meet a condition.',
    args: [
      arg('range', 'The range to test.', 'range'),
      arg('criteria', CRITERIA_DESCRIPTION, 'criteria'),
      optional('average_range', 'The cells to average (default: range itself).', 'range'),
    ],
    evaluate: singleCriterion(average),
  },
  {
    name: 'AVERAGEIFS',
    category: 'statistical',
    description: 'Averages the cells that meet every condition.',
    args: [arg('average_range', 'The cells to average.', 'range'), ...criteriaPair],
    evaluate: multipleCriteria(average),
  },
  {
    name: 'MAXIFS',
    category: 'statistical',
    description: 'Returns the largest number among the cells that meet every condition (0 if none match).',
    args: [arg('max_range', 'The cells to take the maximum of.', 'range'), ...criteriaPair],
    evaluate: multipleCriteria(max),
  },
  {
    name: 'MINIFS',
    category: 'statistical',
    description: 'Returns the smallest number among the cells that meet every condition (0 if none match).',
    args: [arg('min_range', 'The cells to take the minimum of.', 'range'), ...criteriaPair],
    evaluate: multipleCriteria(min),
  },
];
