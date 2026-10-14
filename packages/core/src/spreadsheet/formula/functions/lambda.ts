// Portions ported from gridcraft/crates/calc/src/eval.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { arg, repeating, type FunctionTable } from './helpers';

/**
 * LAMBDA and its helper functions. They are evaluated by the formula
 * evaluator itself (they create functions or call them); these entries give
 * autocomplete, signatures and argument-count checks.
 */
const special = (name: string) => (ctx: { error(code: '#ERROR!', message?: string): string }) =>
  ctx.error('#ERROR!', `${name} must be evaluated by the formula evaluator.`);

const LAMBDA_ARG = arg('lambda', 'A LAMBDA function, e.g. LAMBDA(x, x*2), or a function name such as SUM.');

export const LAMBDA_FUNCTIONS: FunctionTable = [
  {
    name: 'LAMBDA',
    category: 'logical',
    description:
      'Creates a reusable function: LAMBDA(x, y, x+y). Call it directly, LAMBDA(x, x+1)(2), store it in LET or a defined name, or pass it to MAP, REDUCE, SCAN, BYROW, BYCOL or MAKEARRAY.',
    args: [
      repeating(
        'parameter_or_calculation',
        'Parameter names, then the calculation that uses them (always the last argument).',
      ),
    ],
    evaluate: special('LAMBDA'),
  },
  {
    name: 'ISOMITTED',
    category: 'logical',
    description: 'Checks whether a LAMBDA parameter was left out of the call, e.g. LAMBDA(x, y, IF(ISOMITTED(y), x, x+y))(1,).',
    args: [arg('argument', 'A LAMBDA parameter name.')],
    evaluate: special('ISOMITTED'),
  },
  {
    name: 'MAP',
    category: 'logical',
    description: 'Applies a LAMBDA to each value of one or more arrays: MAP(A1:A3, LAMBDA(v, v*2)).',
    args: [
      arg('array1', 'An array to map.'),
      repeating('array_or_lambda', 'More arrays, then the LAMBDA taking one parameter per array.'),
    ],
    evaluate: special('MAP'),
  },
  {
    name: 'REDUCE',
    category: 'logical',
    description: 'Reduces an array to one value by applying LAMBDA(accumulator, value) to each value, row by row.',
    args: [
      arg('initial_value', 'The starting accumulator (may be left empty).'),
      arg('array', 'The array to reduce.'),
      LAMBDA_ARG,
    ],
    evaluate: special('REDUCE'),
  },
  {
    name: 'SCAN',
    category: 'logical',
    description: 'Like REDUCE, but returns every intermediate accumulator value (running totals).',
    args: [
      arg('initial_value', 'The starting accumulator (may be left empty).'),
      arg('array', 'The array to scan.'),
      LAMBDA_ARG,
    ],
    evaluate: special('SCAN'),
  },
  {
    name: 'BYROW',
    category: 'logical',
    description: 'Applies a LAMBDA to each row of an array and returns one value per row: BYROW(A1:C3, LAMBDA(r, SUM(r))).',
    args: [arg('array', 'The array whose rows are passed to the LAMBDA.'), LAMBDA_ARG],
    evaluate: special('BYROW'),
  },
  {
    name: 'BYCOL',
    category: 'logical',
    description: 'Applies a LAMBDA to each column of an array and returns one value per column.',
    args: [arg('array', 'The array whose columns are passed to the LAMBDA.'), LAMBDA_ARG],
    evaluate: special('BYCOL'),
  },
  {
    name: 'MAKEARRAY',
    category: 'logical',
    description: 'Builds an array of the given size from LAMBDA(row, column): MAKEARRAY(3, 3, LAMBDA(r, c, r*c)).',
    args: [
      arg('rows', 'Number of rows.', 'number'),
      arg('columns', 'Number of columns.', 'number'),
      LAMBDA_ARG,
    ],
    evaluate: special('MAKEARRAY'),
  },
];
