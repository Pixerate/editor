import type { ASTNode } from './parser';
import type { FormulaErrorCode, FormulaRange } from './values';
import { BUILTIN_FORMULA_FUNCTIONS } from './functions';

export type FormulaFunctionCategory =
  | 'math'
  | 'statistical'
  | 'logical'
  | 'text'
  | 'lookup'
  | 'date'
  | 'information';

/** What an argument expects. Used for documentation, hints and messages. */
export type FormulaArgumentType =
  | 'any'
  | 'number'
  | 'text'
  | 'logical'
  | 'date'
  | 'range'
  | 'criteria';

export interface FormulaArgumentSpec {
  /** Argument name shown in signatures, e.g. `sum_range`. */
  name: string;
  description: string;
  type?: FormulaArgumentType;
  /** The argument may be left out. */
  optional?: boolean;
  /**
   * The argument repeats. Consecutive repeating arguments form a group that
   * repeats together (`criteria_range, criteria` in SUMIFS). The group must be
   * the last arguments, and is required once unless its first spec is optional.
   */
  repeating?: boolean;
}

/** One argument of a call, evaluated lazily so functions like IF can short-circuit. */
export interface FormulaArgument {
  /** 0-based position in the call. */
  readonly index: number;
  readonly node: ASTNode;
  /** Evaluates the argument (once; later calls return the cached value). Ranges evaluate to arrays. */
  value(): any;
}

/** What a function implementation receives. Coercion helpers report argument-indexed diagnostics. */
export interface FormulaFunctionContext {
  /** Upper-case function name. */
  readonly name: string;
  readonly args: readonly FormulaArgument[];
  /** Returns `code` and records `message` as the reason (shown to the user if the cell ends up with that error). */
  error(code: FormulaErrorCode, message?: string): string;
  /** Like `error`, phrased as `Argument N of NAME <reason>`. */
  argError(index: number, code: FormulaErrorCode, reason: string): string;
  /** Whether argument `index` was supplied. */
  has(index: number): boolean;
  /** Raw (lazily evaluated) value of an argument; ranges are arrays. */
  value(index: number): any;
  /** Single value of an argument: a one-cell range is unwrapped, larger ranges are #VALUE!. */
  scalar(index: number): any;
  /** Argument as a number (or an error string). Text that isn't numeric is #VALUE!. */
  number(index: number, fallback?: number): number | string;
  /** Argument as an integer (truncated toward zero). */
  integer(index: number, fallback?: number): number | string;
  /** Argument as text (or an error string). */
  text(index: number, fallback?: string): string;
  /** Argument as a boolean (or an error string). */
  boolean(index: number, fallback?: boolean): boolean | string;
  /** Argument as a date (or an error string). */
  date(index: number): Date | string;
  /** Argument as a 2D range (or an error string if it is not a range). */
  range(index: number): FormulaRange | string;
  /** Every value of the arguments `from` (default 0) up to `to` (exclusive, default all), ranges flattened. */
  flatValues(from?: number, to?: number): any[];
  /**
   * Numbers among the arguments `from`..`to` (exclusive), as SUM reads them:
   * text, booleans and blanks are skipped; the first error is returned instead.
   */
  numbers(from?: number, to?: number): number[] | string;
}

export interface FormulaFunctionDefinition {
  /** Function name; matched case-insensitively. */
  name: string;
  category: FormulaFunctionCategory;
  description: string;
  args: FormulaArgumentSpec[];
  /** Result changes on every recalculation (RAND, NOW, TODAY). */
  volatile?: boolean;
  /**
   * A repeating group may end with one extra argument (SWITCH's `default`).
   * Otherwise a group must be complete.
   */
  allowTrailingArgument?: boolean;
  evaluate(ctx: FormulaFunctionContext): any;
}

// --- Registry ---

const registry = new Map<string, FormulaFunctionDefinition>();
let builtinsLoaded = false;

function ensureBuiltins(): void {
  if (builtinsLoaded) return;
  builtinsLoaded = true;
  for (const def of BUILTIN_FORMULA_FUNCTIONS) {
    if (!registry.has(def.name)) registry.set(def.name, def);
  }
}

/**
 * Adds (or replaces) a formula function. Replacing a built-in is allowed, so
 * apps can customise behaviour; the change is global.
 */
export function registerFormulaFunction(definition: FormulaFunctionDefinition): void {
  ensureBuiltins();
  const name = definition.name.trim().toUpperCase();
  if (!/^[A-Z_][A-Z0-9_.]*$/.test(name)) {
    throw new Error(`Invalid formula function name "${definition.name}"`);
  }
  registry.set(name, { ...definition, name });
}

/** Removes a formula function. Returns false if it was not registered. */
export function unregisterFormulaFunction(name: string): boolean {
  ensureBuiltins();
  return registry.delete(name.toUpperCase());
}

export function getFormulaFunction(name: string): FormulaFunctionDefinition | undefined {
  ensureBuiltins();
  return registry.get(name.toUpperCase());
}

/** All registered functions sorted by name, optionally limited to one category. */
export function listFormulaFunctions(category?: FormulaFunctionCategory): FormulaFunctionDefinition[] {
  ensureBuiltins();
  return Array.from(registry.values())
    .filter((def) => !category || def.category === category)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Functions matching `query`, for autocomplete: names starting with the query
 * first, then names containing it. An empty query lists every function.
 */
export function searchFormulaFunctions(
  query: string,
  options: { limit?: number; category?: FormulaFunctionCategory } = {},
): FormulaFunctionDefinition[] {
  const q = query.trim().toUpperCase();
  const all = listFormulaFunctions(options.category);
  const prefix = all.filter((def) => def.name.startsWith(q));
  const contains = q ? all.filter((def) => !def.name.startsWith(q) && def.name.includes(q)) : [];
  const results = [...prefix, ...contains];
  return options.limit !== undefined ? results.slice(0, options.limit) : results;
}

// --- Argument layout and signatures ---

interface ArgumentLayout {
  fixed: FormulaArgumentSpec[];
  group: FormulaArgumentSpec[];
  groupStart: number;
}

function layoutOf(def: FormulaFunctionDefinition): ArgumentLayout {
  const groupStart = def.args.findIndex((arg) => arg.repeating);
  if (groupStart === -1) return { fixed: def.args, group: [], groupStart: def.args.length };
  return { fixed: def.args.slice(0, groupStart), group: def.args.slice(groupStart), groupStart };
}

/**
 * Index into `def.args` of the spec describing the call argument at
 * `argIndex`, or -1 if the function takes no argument there.
 */
export function getFormulaArgumentSpecIndex(def: FormulaFunctionDefinition, argIndex: number): number {
  const { fixed, group, groupStart } = layoutOf(def);
  if (argIndex < fixed.length) return argIndex;
  if (group.length === 0) return -1;
  return groupStart + ((argIndex - groupStart) % group.length);
}

/**
 * Checks the number of arguments of a call. Returns a message such as
 * `SUMIF needs at least 2 arguments, but 1 was given.`, or null when valid.
 */
export function checkFormulaArgumentCount(def: FormulaFunctionDefinition, count: number): string | null {
  const { fixed, group } = layoutOf(def);
  const requiredFixed = fixed.filter((arg) => !arg.optional).length;
  const groupRequired = group.length > 0 && !group[0].optional;
  const min = requiredFixed + (groupRequired ? group.length : 0);
  const max = group.length > 0 ? Infinity : fixed.length;
  const given = `${count} ${count === 1 ? 'was' : 'were'} given`;
  const plural = (n: number) => `${n} argument${n === 1 ? '' : 's'}`;

  if (count < min) {
    const expected = min === max ? plural(min) : `at least ${plural(min)}`;
    return `${def.name} needs ${expected}, but ${given}.`;
  }
  if (count > max) {
    const expected = min === max ? plural(max) : `at most ${plural(max)}`;
    return max === 0 ? `${def.name} takes no arguments, but ${given}.` : `${def.name} takes ${expected}, but ${given}.`;
  }
  if (group.length > 1 && count > fixed.length) {
    const extra = (count - fixed.length) % group.length;
    if (extra !== 0 && !(def.allowTrailingArgument && extra === 1)) {
      const names = group.map((arg) => arg.name).join(', ');
      return `${def.name} expects its repeating arguments (${names}) in complete groups.`;
    }
  }
  return null;
}

/** A piece of a rendered signature; `specIndex` is set on argument names. */
export interface FormulaSignaturePart {
  text: string;
  specIndex: number | null;
  active: boolean;
}

/**
 * Renders a signature as parts, e.g. `SUMIFS(` `sum_range` `, ` ... `)`, with
 * the argument at call position `activeArgIndex` (if any) marked active. A
 * repeating group is shown twice (`value1, [value2, ...]`); arguments past
 * the first repetition highlight the second one.
 */
export function getFormulaSignatureParts(
  nameOrDef: string | FormulaFunctionDefinition,
  activeArgIndex?: number | null,
): FormulaSignaturePart[] {
  const def = typeof nameOrDef === 'string' ? getFormulaFunction(nameOrDef) : nameOrDef;
  if (!def) return [];
  const { fixed, group, groupStart } = layoutOf(def);

  let activeSpec = -1;
  let activeRepeat = 0;
  if (activeArgIndex !== undefined && activeArgIndex !== null && activeArgIndex >= 0) {
    activeSpec = getFormulaArgumentSpecIndex(def, activeArgIndex);
    if (activeSpec >= groupStart && group.length > 0) {
      activeRepeat = Math.floor((activeArgIndex - groupStart) / group.length) > 0 ? 1 : 0;
    }
  }

  const parts: FormulaSignaturePart[] = [{ text: `${def.name}(`, specIndex: null, active: false }];
  const pushArg = (text: string, specIndex: number, repeat = 0) => {
    if (parts.length > 1) parts.push({ text: ', ', specIndex: null, active: false });
    parts.push({ text, specIndex, active: specIndex === activeSpec && repeat === activeRepeat });
  };

  fixed.forEach((arg, i) => pushArg(arg.optional ? `[${arg.name}]` : arg.name, i));

  if (group.length > 0) {
    const groupOptional = !!group[0].optional;
    group.forEach((arg, i) => {
      const open = groupOptional && i === 0 ? '[' : '';
      pushArg(`${open}${arg.name}1`, groupStart + i, 0);
    });
    group.forEach((arg, i) => {
      const open = !groupOptional && i === 0 ? '[' : '';
      pushArg(`${open}${arg.name}2`, groupStart + i, 1);
    });
    parts.push({ text: ', ...]', specIndex: null, active: false });
  }

  parts.push({ text: ')', specIndex: null, active: false });
  return parts;
}

/** Signature string such as `SUMIF(range, criteria, [sum_range])`. */
export function getFormulaSignature(nameOrDef: string | FormulaFunctionDefinition): string {
  return getFormulaSignatureParts(nameOrDef)
    .map((part) => part.text)
    .join('');
}
