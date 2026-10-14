import { cleanFloat, isBlank, isFormulaError } from '../values';
import type { FormulaFunctionContext } from '../registry';
import { arg, failed, optional, repeating, type FunctionTable } from './helpers';

const VALUES = repeating('value', 'A number, cell or range.', 'number');

/** Numbers of argument 0 plus a positive integer k from argument 1, for LARGE/SMALL. */
function kth(ctx: FormulaFunctionContext, pick: (sorted: number[], k: number) => number): number | string {
  const nums = ctx.numbers(0, 1);
  if (failed(nums)) return nums;
  const k = ctx.number(1);
  if (failed(k)) return k;
  const index = Math.ceil(k);
  if (index < 1 || index > nums.length) {
    return ctx.argError(1, '#NUM!', `must be between 1 and the number of values (${nums.length}).`);
  }
  return pick([...nums].sort((a, b) => a - b), index);
}

function variance(ctx: FormulaFunctionContext): number | string {
  const nums = ctx.numbers();
  if (failed(nums)) return nums;
  if (nums.length < 2) return ctx.error('#DIV/0!', `${ctx.name} needs at least two numbers.`);
  let mean = 0;
  for (const num of nums) mean += num;
  mean /= nums.length;
  let squares = 0;
  for (const num of nums) squares += (num - mean) ** 2;
  return squares / (nums.length - 1);
}

export const STATISTICAL_FUNCTIONS: FunctionTable = [
  {
    name: 'AVERAGE',
    category: 'statistical',
    description: 'Returns the arithmetic mean of numbers. Blank cells and text are ignored.',
    args: [VALUES],
    evaluate: (ctx) => {
      const items = ctx.flatValues();
      const error = items.find(isFormulaError);
      if (error) return error;
      let total = 0;
      let count = 0;
      for (const item of items) {
        const num = Number(item);
        if (!isNaN(num) && !isBlank(item)) {
          total += num;
          count++;
        }
      }
      return count === 0 ? 0 : total / count;
    },
  },
  {
    name: 'COUNT',
    category: 'statistical',
    description: 'Counts the values that are numbers.',
    args: [repeating('value', 'A value, cell or range to count.')],
    evaluate: (ctx) => {
      let count = 0;
      for (const item of ctx.flatValues()) {
        if (!isNaN(Number(item)) && !isBlank(item)) count++;
      }
      return count;
    },
  },
  {
    name: 'COUNTA',
    category: 'statistical',
    description: 'Counts the values that are not blank.',
    args: [repeating('value', 'A value, cell or range to count.')],
    evaluate: (ctx) => ctx.flatValues().filter((item) => !isBlank(item)).length,
  },
  {
    name: 'COUNTBLANK',
    category: 'statistical',
    description: 'Counts the blank cells in a range.',
    args: [arg('range', 'The range to check.', 'range')],
    evaluate: (ctx) => {
      const range = ctx.range(0);
      if (failed(range)) return range;
      return range.values.filter(isBlank).length;
    },
  },
  {
    name: 'MIN',
    category: 'statistical',
    description: 'Returns the smallest number. Text and blank cells are ignored.',
    args: [VALUES],
    evaluate: (ctx) => {
      const nums = ctx.numbers();
      if (failed(nums)) return nums;
      if (nums.length === 0) return 0;
      // Loop instead of Math.min(...nums), which overflows the stack on large ranges.
      let result = nums[0];
      for (const num of nums) result = Math.min(result, num);
      return result;
    },
  },
  {
    name: 'MAX',
    category: 'statistical',
    description: 'Returns the largest number. Text and blank cells are ignored.',
    args: [VALUES],
    evaluate: (ctx) => {
      const nums = ctx.numbers();
      if (failed(nums)) return nums;
      if (nums.length === 0) return 0;
      let result = nums[0];
      for (const num of nums) result = Math.max(result, num);
      return result;
    },
  },
  {
    name: 'MEDIAN',
    category: 'statistical',
    description: 'Returns the middle number of a set of numbers.',
    args: [VALUES],
    evaluate: (ctx) => {
      const nums = ctx.numbers();
      if (failed(nums)) return nums;
      if (nums.length === 0) return ctx.error('#NUM!', 'MEDIAN needs at least one number.');
      const sorted = [...nums].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    },
  },
  {
    name: 'MODE',
    category: 'statistical',
    description: 'Returns the most frequently occurring number. Ties go to the number that appears first.',
    args: [VALUES],
    evaluate: (ctx) => {
      const nums = ctx.numbers();
      if (failed(nums)) return nums;
      const counts = new Map<number, number>();
      let best: number | null = null;
      let bestCount = 1;
      for (const num of nums) {
        const count = (counts.get(num) ?? 0) + 1;
        counts.set(num, count);
        if (count > bestCount) {
          best = num;
          bestCount = count;
        }
      }
      // A later number that ties the best count must not replace an earlier one.
      if (best !== null) {
        for (const num of nums) {
          if (counts.get(num) === bestCount) return num;
        }
      }
      return ctx.error('#N/A', 'MODE found no number that appears more than once.');
    },
  },
  {
    name: 'STDEV',
    category: 'statistical',
    description: 'Estimates the standard deviation of a sample.',
    args: [VALUES],
    evaluate: (ctx) => {
      const v = variance(ctx);
      return failed(v) ? v : cleanFloat(Math.sqrt(v));
    },
  },
  {
    name: 'VAR',
    category: 'statistical',
    description: 'Estimates the variance of a sample.',
    args: [VALUES],
    evaluate: (ctx) => {
      const v = variance(ctx);
      return failed(v) ? v : cleanFloat(v);
    },
  },
  {
    name: 'LARGE',
    category: 'statistical',
    description: 'Returns the k-th largest number (LARGE(range, 1) is the maximum).',
    args: [arg('array', 'The numbers to look through.', 'range'), arg('k', 'Position from the largest (1 = largest).', 'number')],
    evaluate: (ctx) => kth(ctx, (sorted, k) => sorted[sorted.length - k]),
  },
  {
    name: 'SMALL',
    category: 'statistical',
    description: 'Returns the k-th smallest number (SMALL(range, 1) is the minimum).',
    args: [arg('array', 'The numbers to look through.', 'range'), arg('k', 'Position from the smallest (1 = smallest).', 'number')],
    evaluate: (ctx) => kth(ctx, (sorted, k) => sorted[k - 1]),
  },
  {
    name: 'RANK',
    category: 'statistical',
    description: 'Returns the rank of a number in a list. Equal numbers share a rank.',
    args: [
      arg('number', 'The number to rank.', 'number'),
      arg('ref', 'The list of numbers to rank against.', 'range'),
      optional('order', '0 or omitted ranks the largest as 1; any other value ranks the smallest as 1.', 'number'),
    ],
    evaluate: (ctx) => {
      const num = ctx.number(0);
      if (failed(num)) return num;
      const nums = ctx.numbers(1, 2);
      if (failed(nums)) return nums;
      const order = ctx.number(2, 0);
      if (failed(order)) return order;
      if (!nums.includes(num)) return ctx.argError(0, '#N/A', `(${num}) must be one of the numbers in argument 2.`);
      let rank = 1;
      for (const other of nums) {
        if (order === 0 ? other > num : other < num) rank++;
      }
      return rank;
    },
  },
];
