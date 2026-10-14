import type { FormulaFunctionContext } from '../registry';
import { isBlank, isFormulaError, numericValue } from '../values';
import { arg, type FunctionTable } from './helpers';

const VALUE = arg('value', 'The value or cell to check.');

/** IS* functions look at a single value without propagating errors. */
const check = (test: (value: unknown) => boolean) => (ctx: FormulaFunctionContext) => test(ctx.scalar(0));

export const INFORMATION_FUNCTIONS: FunctionTable = [
  {
    name: 'ISBLANK',
    category: 'information',
    description: 'Returns TRUE if the value is empty.',
    args: [VALUE],
    evaluate: check(isBlank),
  },
  {
    name: 'ISNUMBER',
    category: 'information',
    description: 'Returns TRUE if the value is a number (typed cell values that look like numbers count).',
    args: [VALUE],
    evaluate: check((value) => numericValue(value) !== null),
  },
  {
    name: 'ISTEXT',
    category: 'information',
    description: 'Returns TRUE if the value is text that is not a number.',
    args: [VALUE],
    evaluate: check(
      (value) => typeof value === 'string' && !isBlank(value) && !isFormulaError(value) && numericValue(value) === null,
    ),
  },
  {
    name: 'ISERROR',
    category: 'information',
    description: 'Returns TRUE if the value is any error.',
    args: [VALUE],
    evaluate: check(isFormulaError),
  },
  {
    name: 'ISNA',
    category: 'information',
    description: 'Returns TRUE if the value is the #N/A error.',
    args: [VALUE],
    evaluate: check((value) => value === '#N/A'),
  },
];
