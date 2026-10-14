import { cleanFloat, roundHalfAwayFromZero } from '../values';
import { arg, failed, optional, repeating, unaryMath, type FunctionTable } from './helpers';

const NUMBER = arg('number', 'The number to use.', 'number');
const NUM_DIGITS = optional('num_digits', 'Decimal places to round to; negative values round to the left of the decimal point (default 0).', 'number');

/** Rounds `value` to `digits` places with `mode` (away from or toward zero). */
function roundWith(value: number, digits: number, mode: 'up' | 'down'): number {
  const factor = Math.pow(10, Math.trunc(digits));
  // toPrecision strips float noise so ROUNDUP(0.1*3, 1) stays 0.3.
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  const rounded = mode === 'up' ? Math.ceil(scaled) : Math.floor(scaled);
  return cleanFloat((Math.sign(value) * rounded) / factor);
}

export const MATH_FUNCTIONS: FunctionTable = [
  {
    name: 'SUM',
    category: 'math',
    description: 'Adds numbers and the numbers in ranges. Text and blank cells are ignored.',
    args: [repeating('value', 'A number, cell or range to add.', 'number')],
    evaluate: (ctx) => {
      const nums = ctx.numbers();
      if (failed(nums)) return nums;
      let total = 0;
      for (const num of nums) total += num;
      return total;
    },
  },
  {
    name: 'PRODUCT',
    category: 'math',
    description: 'Multiplies numbers and the numbers in ranges. Text and blank cells are ignored.',
    args: [repeating('value', 'A number, cell or range to multiply.', 'number')],
    evaluate: (ctx) => {
      const nums = ctx.numbers();
      if (failed(nums)) return nums;
      if (nums.length === 0) return 0;
      let product = 1;
      for (const num of nums) product *= num;
      return cleanFloat(product);
    },
  },
  {
    name: 'ROUND',
    category: 'math',
    description: 'Rounds a number to a number of decimal places, halves away from zero.',
    args: [NUMBER, NUM_DIGITS],
    evaluate: (ctx) => {
      const num = ctx.number(0);
      if (failed(num)) return num;
      const decimals = ctx.number(1, 0);
      if (failed(decimals)) return decimals;
      return roundHalfAwayFromZero(num, Math.trunc(decimals));
    },
  },
  {
    name: 'ROUNDUP',
    category: 'math',
    description: 'Rounds a number away from zero to a number of decimal places.',
    args: [NUMBER, NUM_DIGITS],
    evaluate: (ctx) => {
      const num = ctx.number(0);
      if (failed(num)) return num;
      const digits = ctx.number(1, 0);
      if (failed(digits)) return digits;
      return roundWith(num, digits, 'up');
    },
  },
  {
    name: 'ROUNDDOWN',
    category: 'math',
    description: 'Rounds a number toward zero to a number of decimal places.',
    args: [NUMBER, NUM_DIGITS],
    evaluate: (ctx) => {
      const num = ctx.number(0);
      if (failed(num)) return num;
      const digits = ctx.number(1, 0);
      if (failed(digits)) return digits;
      return roundWith(num, digits, 'down');
    },
  },
  {
    name: 'INT',
    category: 'math',
    description: 'Rounds a number down to the nearest integer (INT(-1.5) is -2).',
    args: [NUMBER],
    evaluate: (ctx) => unaryMath(ctx, Math.floor),
  },
  {
    name: 'ABS',
    category: 'math',
    description: 'Returns the absolute value of a number.',
    args: [NUMBER],
    evaluate: (ctx) => unaryMath(ctx, Math.abs),
  },
  {
    name: 'SIGN',
    category: 'math',
    description: 'Returns 1 for positive numbers, -1 for negative numbers and 0 for zero.',
    args: [NUMBER],
    evaluate: (ctx) => unaryMath(ctx, (n) => (n > 0 ? 1 : n < 0 ? -1 : 0)),
  },
  {
    name: 'SQRT',
    category: 'math',
    description: 'Returns the square root of a number.',
    args: [NUMBER],
    evaluate: (ctx) =>
      unaryMath(ctx, (n) =>
        n < 0 ? ctx.argError(0, '#NUM!', "can't be negative.") : Math.sqrt(n),
      ),
  },
  {
    name: 'POWER',
    category: 'math',
    description: 'Raises a number to a power.',
    args: [arg('number', 'The base.', 'number'), arg('power', 'The exponent.', 'number')],
    evaluate: (ctx) => {
      const base = ctx.number(0);
      if (failed(base)) return base;
      const exponent = ctx.number(1);
      if (failed(exponent)) return exponent;
      if (base === 0 && exponent < 0) return ctx.error('#DIV/0!', 'POWER of zero to a negative exponent divides by zero.');
      const result = Math.pow(base, exponent);
      return Number.isFinite(result) ? result : ctx.error('#NUM!', 'POWER produced a number that is out of range.');
    },
  },
  {
    name: 'MOD',
    category: 'math',
    description: 'Returns the remainder after division. The result has the sign of the divisor.',
    args: [arg('number', 'The number to divide.', 'number'), arg('divisor', 'The number to divide by.', 'number')],
    evaluate: (ctx) => {
      const num = ctx.number(0);
      if (failed(num)) return num;
      const divisor = ctx.number(1);
      if (failed(divisor)) return divisor;
      if (divisor === 0) return ctx.argError(1, '#DIV/0!', "can't be zero.");
      return cleanFloat(num - divisor * Math.floor(num / divisor));
    },
  },
  {
    name: 'CEILING',
    category: 'math',
    description: 'Rounds a number up to the nearest multiple of significance.',
    args: [NUMBER, optional('significance', 'The multiple to round to (default 1).', 'number')],
    evaluate: (ctx) => roundToMultiple(ctx.name, ctx.number(0), ctx.number(1, 1), Math.ceil, ctx),
  },
  {
    name: 'FLOOR',
    category: 'math',
    description: 'Rounds a number down to the nearest multiple of significance.',
    args: [NUMBER, optional('significance', 'The multiple to round to (default 1).', 'number')],
    evaluate: (ctx) => roundToMultiple(ctx.name, ctx.number(0), ctx.number(1, 1), Math.floor, ctx),
  },
  {
    name: 'PI',
    category: 'math',
    description: 'Returns the number π (3.14159…).',
    args: [],
    evaluate: () => Math.PI,
  },
  {
    name: 'RAND',
    category: 'math',
    description: 'Returns a random number between 0 (inclusive) and 1 (exclusive). Changes on every recalculation.',
    args: [],
    volatile: true,
    evaluate: () => Math.random(),
  },
  {
    name: 'RANDBETWEEN',
    category: 'math',
    description: 'Returns a random integer between bottom and top, inclusive. Changes on every recalculation.',
    args: [arg('bottom', 'The smallest integer to return.', 'number'), arg('top', 'The largest integer to return.', 'number')],
    volatile: true,
    evaluate: (ctx) => {
      const bottom = ctx.number(0);
      if (failed(bottom)) return bottom;
      const top = ctx.number(1);
      if (failed(top)) return top;
      const lo = Math.ceil(bottom);
      const hi = Math.floor(top);
      if (lo > hi) return ctx.error('#NUM!', 'RANDBETWEEN needs bottom to be less than or equal to top.');
      return lo + Math.floor(Math.random() * (hi - lo + 1));
    },
  },
];

function roundToMultiple(
  name: string,
  number: number | string,
  significance: number | string,
  round: (n: number) => number,
  ctx: { error: (code: '#NUM!' | '#DIV/0!', message?: string) => string },
): number | string {
  if (failed(number)) return number;
  if (failed(significance)) return significance;
  if (number === 0) return 0;
  if (significance === 0) {
    return name === 'FLOOR' ? ctx.error('#DIV/0!', 'FLOOR needs a significance other than zero.') : 0;
  }
  if (number > 0 && significance < 0) {
    return ctx.error('#NUM!', `${name} can't round a positive number to a negative significance.`);
  }
  return cleanFloat(round(cleanFloat(number / significance)) * significance);
}
