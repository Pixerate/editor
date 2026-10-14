import type { FormulaFunctionDefinition } from '../registry';
import { MATH_FUNCTIONS } from './math';
import { STATISTICAL_FUNCTIONS } from './statistical';
import { CONDITIONAL_FUNCTIONS } from './conditional';
import { LOGICAL_FUNCTIONS } from './logical';
import { TEXT_FUNCTIONS } from './text';
import { LOOKUP_FUNCTIONS } from './lookup';
import { DATE_FUNCTIONS } from './date';
import { INFORMATION_FUNCTIONS } from './information';
import { ARRAY_FUNCTIONS, ELEMENTWISE_BUILTINS } from './array';
import { LAMBDA_FUNCTIONS } from './lambda';

/** Every built-in formula function. The registry is seeded from this list. */
export const BUILTIN_FORMULA_FUNCTIONS: readonly FormulaFunctionDefinition[] = [
  ...MATH_FUNCTIONS,
  ...STATISTICAL_FUNCTIONS,
  ...CONDITIONAL_FUNCTIONS,
  ...LOGICAL_FUNCTIONS,
  ...TEXT_FUNCTIONS,
  ...LOOKUP_FUNCTIONS,
  ...DATE_FUNCTIONS,
  ...INFORMATION_FUNCTIONS,
  ...ARRAY_FUNCTIONS,
  ...LAMBDA_FUNCTIONS,
].map((def) => {
  // Scalar built-ins that apply element by element to arrays.
  const elementwise = ELEMENTWISE_BUILTINS[def.name];
  return elementwise && def.elementwise === undefined ? { ...def, elementwise } : def;
});
