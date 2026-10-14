// Portions ported from gridcraft/crates/calc/src/eval.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
/**
 * LAMBDA values and the lexical environments of LET and LAMBDA variables.
 */
import type { ASTNode } from './parser';

/**
 * Variables of one LET or LAMBDA call. Environments form a chain: a lambda
 * keeps the environment it was created in (a closure), so its body sees the
 * LET variables around its definition, not those of its caller.
 */
export interface FormulaEnvironment {
  /** Upper-case variable name → value. */
  readonly vars: Map<string, any>;
  /** LAMBDA parameters whose argument was left out (for ISOMITTED). */
  readonly omitted?: Set<string>;
  readonly parent: FormulaEnvironment | null;
}

/**
 * A function value created by `LAMBDA(params…, body)`, or a built-in function
 * passed by name (`BYROW(A1:C3, SUM)`). Lambdas can be stored in LET
 * variables and defined names and passed to MAP, REDUCE, SCAN, BYROW, BYCOL
 * and MAKEARRAY; a cell whose result is an uncalled lambda shows `#CALC!`.
 */
export class FormulaLambda {
  constructor(
    /** Upper-case parameter names. */
    readonly params: readonly string[],
    /** The calculation; null for a native (built-in) function. */
    readonly body: ASTNode | null,
    /** The environment the lambda was created in. */
    readonly env: FormulaEnvironment | null,
    /** The sheet unqualified references in the body refer to (a sheet-scoped name's sheet). */
    readonly sheet?: string,
    /** Implementation of a built-in function passed by name. */
    readonly native?: (args: any[]) => any,
    /** Display name, e.g. `SUM` or `LAMBDA`. */
    readonly label = 'LAMBDA',
  ) {}

  toString(): string {
    return `[${this.label}]`;
  }
}

export const isFormulaLambda = (value: unknown): value is FormulaLambda => value instanceof FormulaLambda;

/**
 * Deepest nesting of LAMBDA calls (recursion through named lambdas). Deeper
 * calls return `#NUM!`, as in Excel. The JavaScript stack may run out first
 * on small stacks; that is reported as `#NUM!` too.
 */
export const MAX_LAMBDA_DEPTH = 1000;

/** Finds the innermost environment defining `name`. */
export function lookupEnvironment(env: FormulaEnvironment | null, name: string): FormulaEnvironment | null {
  for (let e = env; e; e = e.parent) {
    if (e.vars.has(name)) return e;
  }
  return null;
}
