import type {
  FormulaArgumentSpec,
  FormulaArgumentType,
  FormulaFunctionContext,
  FormulaFunctionDefinition,
} from '../registry';
import { isFormulaError } from '../values';

/** Shorthand for an argument spec. */
export const arg = (
  name: string,
  description: string,
  type: FormulaArgumentType = 'any',
  extra: Partial<FormulaArgumentSpec> = {},
): FormulaArgumentSpec => ({ name, description, type, ...extra });

export const optional = (
  name: string,
  description: string,
  type: FormulaArgumentType = 'any',
): FormulaArgumentSpec => arg(name, description, type, { optional: true });

export const repeating = (
  name: string,
  description: string,
  type: FormulaArgumentType = 'any',
): FormulaArgumentSpec => arg(name, description, type, { repeating: true });

export type FunctionTable = FormulaFunctionDefinition[];

/**
 * True for error strings. Narrows `number | string` (etc.) results of the
 * context helpers; plain `string` results (ctx.text) are not narrowed, since
 * text and error codes are both strings.
 */
export function failed(value: string): boolean;
export function failed<T>(value: T): value is Extract<T, string>;
export function failed(value: unknown): boolean {
  return isFormulaError(value);
}

/**
 * Applies `fn` to a numeric argument (`number`), propagating errors and
 * turning non-finite results into #NUM!.
 */
export function unaryMath(
  ctx: FormulaFunctionContext,
  fn: (value: number) => number | string,
): number | string {
  const value = ctx.number(0);
  if (failed(value)) return value;
  const result = fn(value);
  if (typeof result === 'number' && !Number.isFinite(result)) {
    return ctx.error('#NUM!', `${ctx.name} produced a number that is out of range.`);
  }
  return result;
}
