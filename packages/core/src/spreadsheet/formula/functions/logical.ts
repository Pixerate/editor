import type { FormulaFunctionContext } from '../registry';
import { compareValues, isBlank, isFormulaError, normalizeValue, numericValue, toBoolean } from '../values';
import { arg, failed, optional, repeating, type FunctionTable } from './helpers';

/**
 * Logical values among the arguments, for AND/OR/XOR. In ranges, blanks and
 * non-logical text are skipped; a direct text argument is #VALUE!.
 */
function logicalValues(ctx: FormulaFunctionContext): boolean[] | string {
  const values: boolean[] = [];
  for (let i = 0; i < ctx.args.length; i++) {
    const value = ctx.value(i);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isFormulaError(item)) return item;
        if (isBlank(item)) continue;
        if (typeof item === 'boolean') values.push(item);
        else if (typeof item === 'number') values.push(item !== 0);
        else {
          const num = numericValue(item);
          const bool = num !== null ? num !== 0 : toBoolean(item);
          if (typeof bool === 'boolean') values.push(bool);
        }
      }
      continue;
    }
    const bool = ctx.boolean(i);
    if (failed(bool)) return bool;
    values.push(bool);
  }
  if (values.length === 0) return ctx.error('#VALUE!', `${ctx.name} found no logical values to test.`);
  return values;
}

const LOGICALS = repeating('logical', 'A condition, logical value or range of logical values.', 'logical');

export const LOGICAL_FUNCTIONS: FunctionTable = [
  {
    name: 'IF',
    category: 'logical',
    description: 'Returns one value if a condition is true and another if it is false.',
    args: [
      arg('logical_test', 'The condition to test.', 'logical'),
      arg('value_if_true', 'The result when the condition is TRUE.'),
      optional('value_if_false', 'The result when the condition is FALSE (default FALSE).'),
    ],
    evaluate: (ctx) => {
      const condition = ctx.boolean(0);
      if (failed(condition)) return condition;
      if (condition) return ctx.value(1);
      return ctx.has(2) ? ctx.value(2) : false;
    },
  },
  {
    name: 'IFERROR',
    category: 'logical',
    description: 'Returns a value, or an alternative if the value is an error.',
    args: [arg('value', 'The value to check.'), arg('value_if_error', 'The result when value is an error.')],
    evaluate: (ctx) => {
      const value = ctx.value(0);
      return isFormulaError(value) ? ctx.value(1) : value;
    },
  },
  {
    name: 'IFNA',
    category: 'logical',
    description: 'Returns a value, or an alternative if the value is #N/A.',
    args: [arg('value', 'The value to check.'), arg('value_if_na', 'The result when value is #N/A.')],
    evaluate: (ctx) => {
      const value = ctx.value(0);
      return value === '#N/A' ? ctx.value(1) : value;
    },
  },
  {
    name: 'IFS',
    category: 'logical',
    description: 'Returns the value for the first condition that is TRUE.',
    args: [
      repeating('logical_test', 'A condition to test.', 'logical'),
      repeating('value_if_true', 'The result when this condition is the first TRUE one.'),
    ],
    evaluate: (ctx) => {
      for (let i = 0; i + 1 < ctx.args.length; i += 2) {
        const condition = ctx.boolean(i);
        if (failed(condition)) return condition;
        if (condition) return ctx.value(i + 1);
      }
      return ctx.error('#N/A', 'None of the conditions in IFS were TRUE.');
    },
  },
  {
    name: 'SWITCH',
    category: 'logical',
    description: 'Compares an expression with a list of values and returns the result for the first match. An extra last argument is the default.',
    args: [
      arg('expression', 'The value to compare.'),
      repeating('value', 'A value to compare the expression with.'),
      repeating('result', 'The result when the expression equals this value.'),
    ],
    allowTrailingArgument: true,
    evaluate: (ctx) => {
      const expression = ctx.scalar(0);
      if (isFormulaError(expression)) return expression;
      const target = normalizeValue(expression);
      let i = 1;
      for (; i + 1 < ctx.args.length; i += 2) {
        const candidate = ctx.scalar(i);
        if (isFormulaError(candidate)) return candidate;
        if (compareValues(target, normalizeValue(candidate)) === 0) return ctx.value(i + 1);
      }
      if (i < ctx.args.length) return ctx.value(i);
      return ctx.error('#N/A', 'SWITCH found no matching value and has no default.');
    },
  },
  {
    name: 'AND',
    category: 'logical',
    description: 'Returns TRUE if every argument is TRUE.',
    args: [LOGICALS],
    evaluate: (ctx) => {
      const values = logicalValues(ctx);
      return failed(values) ? values : values.every(Boolean);
    },
  },
  {
    name: 'OR',
    category: 'logical',
    description: 'Returns TRUE if any argument is TRUE.',
    args: [LOGICALS],
    evaluate: (ctx) => {
      const values = logicalValues(ctx);
      return failed(values) ? values : values.some(Boolean);
    },
  },
  {
    name: 'XOR',
    category: 'logical',
    description: 'Returns TRUE if an odd number of arguments are TRUE.',
    args: [LOGICALS],
    evaluate: (ctx) => {
      const values = logicalValues(ctx);
      return failed(values) ? values : values.filter(Boolean).length % 2 === 1;
    },
  },
  {
    name: 'NOT',
    category: 'logical',
    description: 'Reverses a logical value.',
    args: [arg('logical', 'The value to reverse.', 'logical')],
    evaluate: (ctx) => {
      const value = ctx.boolean(0);
      return failed(value) ? value : !value;
    },
  },
];
