// Portions ported from gridcraft/crates/calc/src/eval.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import {
  ASTNode,
  parseFormula,
  type CellRefNode,
  type FunctionCallNode,
  type NameNode,
  type RangeNode,
  type SpillRefNode,
} from './parser';
import {
  FormulaLambda,
  isFormulaLambda,
  lookupEnvironment,
  MAX_LAMBDA_DEPTH,
  type FormulaEnvironment,
} from './lambda';
import {
  checkFormulaArgumentCount,
  getFormulaArgumentSpecIndex,
  getFormulaFunction,
  type FormulaArgument,
  type FormulaFunctionContext,
  type FormulaFunctionDefinition,
} from './registry';
import {
  colNameToIndex,
  isBlank,
  isFormulaError,
  numericValue,
  toBoolean,
  toDate,
  toFormulaRange,
  toNumber,
  toText,
  compareValues,
  withRangeShape,
  parseIsoDate,
  isoDateHasTime,
  dateToSerial,
  serialToDate,
  formatIsoDate,
  formatIsoDateTime,
  cleanFloat,
  rangeGet,
  type FormulaErrorCode,
  type FormulaRange,
} from './values';

export { FORMULA_ERRORS, isFormulaError, colNameToIndex, indexToColName } from './values';
export type { FormulaErrorCode, FormulaRange } from './values';

/** What a defined name refers to, as returned by `EvaluationContext.resolveName`. */
export interface FormulaNameDefinition {
  /** Formula text (`=Sheet1!$A$1:$A$9`, `=0.07`, `=LAMBDA(x, x*2)`) or a parsed formula. */
  formula: string | ASTNode;
  /** Sheet that unqualified references in the formula refer to (a sheet-scoped name's sheet). */
  sheet?: string;
  /** A key identifying the name (for cycle detection), e.g. `Data!RATE`. Defaults to the name. */
  key?: string;
}

export interface EvaluationContext {
  /**
   * Value of a cell. `sheet` is set for sheet-qualified references
   * (`Sheet2!A1`); undefined means the formula's own sheet. Return `#REF!`
   * for a sheet that doesn't exist.
   */
  resolveCell?: (col: string, row: number, sheet?: string) => any;
  /**
   * Values of a rectangular range, column by column (all rows of the first
   * column, then the next column). Lookup functions rely on this order.
   * `sheet` as in `resolveCell`; return an error code for a missing sheet.
   */
  resolveRange?: (startCol: string, startRow: number, endCol: string, endRow: number, sheet?: string) => any[] | string;
  resolveProperty?: (property: string) => any;
  /**
   * The spilled array anchored at a cell, for `A1#` references: its shape and
   * values (column-major, like `resolveRange`), or an error code (e.g.
   * `#REF!` when the cell holds no array).
   */
  resolveSpill?: (col: string, row: number, sheet?: string) => FormulaRange | string;
  /**
   * The sheets of a 3-D reference (`Sheet1:Sheet3!A1`), from `first` to
   * `last` in tab order, or an error code when either sheet is missing.
   */
  resolveSheetSpan?: (first: string, last: string) => string[] | string;
  /**
   * A defined name (`Rate`, `Data!Rate`), or null when none is visible.
   * `sheet` is the qualifying sheet, or the sheet whose names apply (when a
   * sheet-scoped name refers to another name); undefined means the formula's
   * own sheet. Sheet-scoped names come before workbook-scoped ones.
   */
  resolveName?: (name: string, sheet?: string) => FormulaNameDefinition | null;
  /**
   * The cell holding the formula being evaluated, used by the implicit
   * intersection operator (`=@A:A` reads the cell in the formula's row).
   */
  getFormulaCell?: () => { col: string; row: number } | null;
}

/** A human-readable reason for an error value. */
export interface FormulaDiagnostic {
  code: FormulaErrorCode;
  message: string;
}

export interface FormulaEvaluationResult {
  /** The computed value; an error code such as `#VALUE!` when the formula fails. */
  value: any;
  /** The error code when `value` is an error. */
  error?: FormulaErrorCode;
  /** Why the formula failed, e.g. `Argument 2 of SUMIF must be a range.` */
  message?: string;
  /**
   * Set when the formula returned an array of more than one value (a
   * dynamic array). `value` is then its top-left value; a spreadsheet spills
   * the whole array into the cells below and to the right.
   */
  array?: FormulaRange;
}

const DEFAULT_MESSAGES: Record<FormulaErrorCode, string> = {
  '#DIV/0!': 'The formula divides by zero.',
  '#VALUE!': 'A value in the formula has the wrong type.',
  '#REF!': 'The formula refers to a cell or range that was deleted.',
  '#NAME?': 'The formula contains an unknown name.',
  '#N/A': 'A value is not available.',
  '#NUM!': 'The formula produced an invalid number.',
  '#CYCLE!': 'This formula is part of a circular reference.',
  '#ERROR!': 'The formula could not be evaluated.',
  '#SPILL!': "The formula's array result can't spill into the cells it needs.",
  '#CALC!': 'The formula produced an empty array.',
};

/** Generic explanation of an error code, used when no specific reason was recorded. */
export function describeFormulaError(code: string): string {
  return DEFAULT_MESSAGES[code as FormulaErrorCode] ?? 'The formula could not be evaluated.';
}

const quote = (value: unknown) => (typeof value === 'string' ? `"${value}"` : String(value));

/** Largest array a formula may build (SEQUENCE, RANDARRAY, broadcasting). */
export const MAX_FORMULA_ARRAY_SIZE = 1_000_000;

/** The (rows, cols) shape of a value: 1x1 for scalars. */
function shapeOf(value: unknown): { rows: number; cols: number } {
  if (!Array.isArray(value)) return { rows: 1, cols: 1 };
  const range = toFormulaRange(value);
  return { rows: range.rows, cols: range.cols };
}

/**
 * Element (row, col) of a value broadcast to a larger shape: scalars and
 * single rows/columns repeat; positions past a smaller array are #N/A.
 */
function broadcastGet(value: unknown, row: number, col: number): any {
  if (!Array.isArray(value)) return value;
  const range = toFormulaRange(value);
  const r = range.rows === 1 ? 0 : row;
  const c = range.cols === 1 ? 0 : col;
  if (r >= range.rows || c >= range.cols) return '#N/A';
  return range.values[c * range.rows + r];
}

/** Builds a shaped, column-major array by calling `fn` for every (row, col). */
function buildArray(rows: number, cols: number, fn: (row: number, col: number) => any): any[] {
  const out: any[] = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) out.push(fn(r, c));
  }
  return withRangeShape(out, rows, cols);
}

/** A multi-value array (one-value arrays behave like scalars). */
const isMultiArray = (value: unknown): value is any[] => Array.isArray(value) && value.length > 1;

const firstValue = (value: any): any => (Array.isArray(value) ? (value.length ? value[0] : '') : value);

/** `Sheet2!` / `Sheet1:Sheet3!` prefix for messages, or ''. */
const sheetLabel = (node: { sheet?: string; sheetEnd?: string }): string =>
  node.sheet === undefined ? '' : `${node.sheetEnd === undefined ? node.sheet : `${node.sheet}:${node.sheetEnd}`}!`;

/**
 * Special forms: evaluated by the evaluator itself (they define variables or
 * take functions), listed in the registry for autocomplete and signatures.
 */
const SPECIAL_FORMS = new Set(['LET', 'LAMBDA', 'ISOMITTED', 'MAP', 'REDUCE', 'SCAN', 'BYROW', 'BYCOL', 'MAKEARRAY']);

/** One element of a LAMBDA helper's result: nested arrays and lambdas are #CALC!. */
function elementValue(value: any): any {
  if (isFormulaLambda(value)) return '#CALC!';
  if (Array.isArray(value)) return value.length === 1 ? elementValue(value[0]) : '#CALC!';
  return value;
}

/** A value as a 2-D range: arrays keep their shape, a single value is 1x1. */
function asRange(value: any): FormulaRange {
  if (Array.isArray(value)) return toFormulaRange(value);
  return { rows: 1, cols: 1, values: [value] };
}

const LITERAL_BLANK: ASTNode = { type: 'Literal', value: '' };

export class FormulaEvaluator {
  private context: EvaluationContext;
  private diagnostics: FormulaDiagnostic[] = [];
  // LET and LAMBDA variables (innermost first, chained to outer scopes).
  private env: FormulaEnvironment | null = null;
  // Sheet that unqualified references refer to while evaluating a
  // sheet-scoped defined name (undefined: the formula's own sheet).
  private defaultSheet: string | undefined = undefined;
  private lambdaDepth = 0;
  // Defined names being evaluated, to stop names that refer to themselves.
  private nameStack: string[] = [];
  private parsedNames = new Map<string, ASTNode>();

  constructor(context: EvaluationContext = {}) {
    this.context = context;
  }

  /**
   * Evaluates a formula. Errors in the formula are returned as error values
   * (`#VALUE!` etc.); malformed formulas and missing resolvers throw.
   */
  public evaluate(astOrFormula: ASTNode | string): any {
    const ast = typeof astOrFormula === 'string' ? parseFormula(astOrFormula) : astOrFormula;
    const value = this.evaluateNode(ast);
    if (isFormulaLambda(value)) {
      return this.fail(
        '#CALC!',
        'The formula returns a LAMBDA function without calling it. Add its arguments in parentheses, e.g. LAMBDA(x, x+1)(2).',
      );
    }
    return value;
  }

  /**
   * Evaluates a formula and explains errors. Never throws: malformed formulas
   * return `#ERROR!` with the parser's message. A result with several values
   * (a range or a dynamic array) is returned in `array`, with its top-left
   * value as `value`; a one-value array is just that value.
   */
  public evaluateWithDiagnostics(astOrFormula: ASTNode | string): FormulaEvaluationResult {
    const saved = this.diagnostics;
    const savedEnv = this.env;
    const savedSheet = this.defaultSheet;
    const savedDepth = this.lambdaDepth;
    const savedNames = this.nameStack;
    this.diagnostics = [];
    this.env = null;
    this.defaultSheet = undefined;
    this.lambdaDepth = 0;
    this.nameStack = [];
    try {
      let value = this.evaluate(astOrFormula);
      let array: FormulaRange | undefined;
      if (Array.isArray(value)) {
        if (value.length > 1) array = toFormulaRange(value);
        value = firstValue(value);
      }
      if (isFormulaError(value)) {
        const code = value as FormulaErrorCode;
        const diagnostic = this.diagnostics.find((d) => d.code === code);
        const result: FormulaEvaluationResult = {
          value,
          error: code,
          message: diagnostic?.message ?? describeFormulaError(code),
        };
        if (array) result.array = array;
        return result;
      }
      return array ? { value, array } : { value };
    } catch (err: any) {
      if (err instanceof RangeError) {
        // The JavaScript stack ran out (very deep LAMBDA recursion).
        return { value: '#NUM!', error: '#NUM!', message: 'The calculation is nested too deeply (recursion limit).' };
      }
      return { value: '#ERROR!', error: '#ERROR!', message: err?.message || 'Formula error' };
    } finally {
      this.diagnostics = saved;
      this.env = savedEnv;
      this.defaultSheet = savedSheet;
      this.lambdaDepth = savedDepth;
      this.nameStack = savedNames;
    }
  }

  /** Records why an error happened and returns the error code. */
  private fail(code: FormulaErrorCode, message: string): string {
    this.diagnostics.push({ code, message });
    return code;
  }

  private evaluateNode(node: ASTNode): any {
    switch (node.type) {
      case 'Literal':
        if (node.value === '#REF!') return this.fail('#REF!', 'This formula refers to a cell or range that was deleted.');
        if (node.value === '#NAME?') return this.fail('#NAME?', 'This formula contains an unknown name.');
        return node.value;

      case 'CellRef': {
        if (!this.context.resolveCell) {
          throw new Error(`Cannot resolve cell reference ${node.ref}: no cell resolver provided`);
        }
        if (node.sheetEnd !== undefined) return this.evaluate3d(node);
        const value = this.context.resolveCell(node.col, node.row, node.sheet ?? this.defaultSheet);
        if (isFormulaError(value)) {
          const label = `${sheetLabel(node)}${node.ref}`;
          if (value === '#REF!' && node.sheet !== undefined) {
            return this.fail('#REF!', `${label} refers to a sheet that doesn't exist.`);
          }
          this.fail(
            value as FormulaErrorCode,
            value === '#CYCLE!'
              ? `Cell ${label} is part of a circular reference.`
              : `Cell ${label} contains an error (${value}).`,
          );
        }
        return value;
      }

      case 'Range':
        return this.evaluateRange(node);

      case 'SpillRef':
        return this.evaluateSpillRef(node);

      case 'Name':
        return this.evaluateName(node);

      case 'Missing':
        return '';

      case 'Invoke': {
        const callee = this.evaluateNode(node.callee);
        if (isFormulaLambda(callee)) return this.invokeLambda(callee, node.args);
        if (isFormulaError(callee)) return callee;
        return this.fail('#VALUE!', 'Only a LAMBDA function can be called with arguments in parentheses.');
      }

      case 'PropertyRef': {
        if (!this.context.resolveProperty) {
          throw new Error(`Cannot resolve property [${node.property}]: no property resolver provided`);
        }
        return this.context.resolveProperty(node.property);
      }

      case 'UnaryOp': {
        if (node.op === '@') return this.implicitIntersection(node.argument);
        const raw = this.evaluateNode(node.argument);
        if (isMultiArray(raw)) {
          const { rows, cols } = shapeOf(raw);
          return buildArray(rows, cols, (r, c) => this.unary(node.op, broadcastGet(raw, r, c)));
        }
        return this.unary(node.op, firstValue(raw));
      }

      case 'BinaryOp': {
        const left = this.evaluateNode(node.left);
        if (isFormulaError(left)) return left;
        const right = this.evaluateNode(node.right);
        if (isFormulaError(right)) return right;
        if (isFormulaLambda(left) || isFormulaLambda(right)) {
          return this.fail('#VALUE!', `The ${node.op} operator can't use a LAMBDA function; call it with arguments first.`);
        }
        if (isMultiArray(left) || isMultiArray(right)) {
          // Array arithmetic: operate element by element (=A1:A3*2).
          const a = shapeOf(left);
          const b = shapeOf(right);
          const rows = Math.max(a.rows, b.rows);
          const cols = Math.max(a.cols, b.cols);
          if (rows * cols > MAX_FORMULA_ARRAY_SIZE) return this.fail('#NUM!', 'The array result is too large.');
          return buildArray(rows, cols, (r, c) => {
            const l = broadcastGet(left, r, c);
            if (isFormulaError(l)) return l;
            const rv = broadcastGet(right, r, c);
            if (isFormulaError(rv)) return rv;
            return this.binary(node.op, l, rv);
          });
        }
        const l = firstValue(left);
        if (isFormulaError(l)) return l;
        const r = firstValue(right);
        if (isFormulaError(r)) return r;
        return this.binary(node.op, l, r);
      }

      case 'FunctionCall':
        return this.callFunction(node);

      default:
        throw new Error(`Unknown AST node: ${(node as any).type}`);
    }
  }

  private unary(op: string, raw: any): any {
    if (isFormulaLambda(raw)) return this.fail('#VALUE!', `The ${op} operator can't use a LAMBDA function.`);
    const val = toNumber(raw);
    if (isFormulaError(val)) {
      return isFormulaError(raw) ? raw : this.fail('#VALUE!', `The ${op} operator can't use text (${quote(raw)}).`);
    }
    if (op === '-') return -(val as number);
    if (op === '+') return val;
    throw new Error(`Unsupported unary operator: ${op}`);
  }

  /** A binary operator on two single values. */
  private binary(op: string, left: any, right: any): any {
    if (['+', '-', '*', '/', '^'].includes(op)) {
      if (op === '+' || op === '-') {
        const leftDate = parseIsoDate(left);
        const rightDate = parseIsoDate(right);
        if (leftDate || rightDate) return this.dateArithmetic(op, left, right, leftDate, rightDate);
      }
      const a = toNumber(left);
      if (isFormulaError(a)) return this.fail('#VALUE!', `The ${op} operator can't use text (${quote(left)}).`);
      const b = toNumber(right);
      if (isFormulaError(b)) return this.fail('#VALUE!', `The ${op} operator can't use text (${quote(right)}).`);
      const x = a as number;
      const y = b as number;
      let result: number;
      switch (op) {
        case '+':
          result = x + y;
          break;
        case '-':
          result = x - y;
          break;
        case '*':
          result = x * y;
          break;
        case '/':
          if (y === 0) return this.fail('#DIV/0!', 'The formula divides by zero.');
          result = x / y;
          break;
        default:
          result = Math.pow(x, y);
      }
      return Number.isFinite(result) ? result : this.fail('#NUM!', 'The result is too large or not a number.');
    }

    switch (op) {
      case '&':
        return toText(left) + toText(right);
      case '=':
        return compareValues(left, right) === 0;
      case '<>':
        return compareValues(left, right) !== 0;
      case '<':
        return compareValues(left, right) < 0;
      case '<=':
        return compareValues(left, right) <= 0;
      case '>':
        return compareValues(left, right) > 0;
      case '>=':
        return compareValues(left, right) >= 0;
      default:
        throw new Error(`Unsupported binary operator: ${op}`);
    }
  }

  /**
   * Dates are ISO text: date +/- days is a date, date - date is a number of
   * days (fractional when times are involved).
   */
  private dateArithmetic(op: '+' | '-', left: any, right: any, leftDate: Date | null, rightDate: Date | null): any {
    if (leftDate && rightDate) {
      if (op === '+') return this.fail('#VALUE!', "Two dates can't be added; subtract them to count the days between.");
      return cleanFloat(dateToSerial(leftDate) - dateToSerial(rightDate));
    }
    if (!leftDate && op === '-') {
      return this.fail('#VALUE!', `A date (${quote(right)}) can't be subtracted from a number.`);
    }
    const date = (leftDate ?? rightDate)!;
    const dateText = String(leftDate ? left : right);
    const other = leftDate ? right : left;
    const days = toNumber(other);
    if (isFormulaError(days)) return this.fail('#VALUE!', `The ${op} operator can't use text (${quote(other)}).`);
    const n = days as number;
    const result = serialToDate(dateToSerial(date) + (op === '+' ? n : -n));
    if (!result || result.getFullYear() < 1 || result.getFullYear() > 9999) {
      return this.fail('#NUM!', 'The resulting date is out of range.');
    }
    return isoDateHasTime(dateText) || !Number.isInteger(n) ? formatIsoDateTime(result) : formatIsoDate(result);
  }

  /**
   * `@` (implicit intersection): a range reference reads the cell in the
   * formula's row (one column) or column (one row); arrays give their
   * top-left value.
   */
  private implicitIntersection(argument: ASTNode): any {
    const value = this.evaluateNode(argument);
    if (!Array.isArray(value)) return value;
    if (value.length <= 1) return firstValue(value);
    const cell = this.context.getFormulaCell?.();
    if (argument.type === 'Range' && cell) {
      const range = toFormulaRange(value);
      const top = Math.min(argument.startRow, argument.endRow);
      const left = Math.min(colNameToIndex(argument.startCol), colNameToIndex(argument.endCol));
      if (range.cols === 1) {
        const r = cell.row - top;
        if (r >= 0 && r < range.rows) return range.values[r];
      } else if (range.rows === 1) {
        const c = colNameToIndex(cell.col) - left;
        if (c >= 0 && c < range.cols) return range.values[c];
      }
      return this.fail('#VALUE!', `The @ operator found no cell of ${argument.raw} in the formula's row or column.`);
    }
    return value[0];
  }

  private evaluateSpillRef(node: SpillRefNode): any {
    if (!this.context.resolveSpill) {
      throw new Error(`Cannot resolve spill range ${node.ref}#: no spill resolver provided`);
    }
    if (node.sheetEnd !== undefined) {
      return this.fail('#REF!', `A 3-D reference can't use the spill operator (${sheetLabel(node)}${node.ref}#).`);
    }
    const spill = this.context.resolveSpill(node.col, node.row, node.sheet ?? this.defaultSheet);
    if (typeof spill === 'string' || !spill) {
      const code = (isFormulaError(spill) ? spill : '#REF!') as FormulaErrorCode;
      return this.fail(
        code,
        code === '#REF!'
          ? `${node.ref}# refers to ${node.ref}, which doesn't hold a spilled array.`
          : `The spill range ${node.ref}# isn't available (${code}).`,
      );
    }
    const values = withRangeShape(spill.values.slice(), spill.rows, spill.cols);
    const error = values.find(isFormulaError);
    if (error) this.fail(error as FormulaErrorCode, `The spill range ${node.ref}# contains an error (${error}).`);
    return values;
  }

  private evaluateRange(node: RangeNode): any {
    if (!this.context.resolveRange) {
      throw new Error(`Cannot resolve range ${node.raw}: no range resolver provided`);
    }
    if (node.sheetEnd !== undefined) return this.evaluate3d(node);
    const values = this.context.resolveRange(node.startCol, node.startRow, node.endCol, node.endRow, node.sheet ?? this.defaultSheet);
    if (!Array.isArray(values)) {
      if (values === '#REF!' && node.sheet !== undefined) {
        return this.fail('#REF!', `${sheetLabel(node)}${node.raw} refers to a sheet that doesn't exist.`);
      }
      return values;
    }
    // Record the 2D shape so lookups can address rows and columns.
    const cols = Math.abs(colNameToIndex(node.endCol) - colNameToIndex(node.startCol)) + 1;
    if (values.length % cols === 0) withRangeShape(values, values.length / cols, cols);
    const error = values.find(isFormulaError);
    if (error) this.fail(error as FormulaErrorCode, `The range ${node.raw} contains an error (${error}).`);
    return values;
  }

  private callFunction(node: FunctionCallNode): any {
    // A LET or LAMBDA variable holding a lambda: LET(f, LAMBDA(x, x*2), f(3)).
    const variables = lookupEnvironment(this.env, node.name);
    if (variables) {
      const bound = variables.vars.get(node.name);
      if (isFormulaLambda(bound)) return this.invokeLambda(bound, node.args);
    }

    const def = getFormulaFunction(node.name);
    if (!def) {
      // A defined name holding a lambda: =Double(4).
      const named = this.lookupDefinedName(node.name);
      if (named) {
        const value = this.evaluateDefinedName(named, node.name);
        if (isFormulaLambda(value)) return this.invokeLambda(value, node.args);
        if (isFormulaError(value)) return value;
        return this.fail('#VALUE!', `The name ${node.name} doesn't refer to a LAMBDA function, so it can't be called.`);
      }
      if (variables) {
        return this.fail('#VALUE!', `The variable ${node.name} doesn't hold a LAMBDA function, so it can't be called.`);
      }
      return this.fail('#NAME?', `Unknown function "${node.name.toUpperCase()}".`);
    }

    const countError = checkFormulaArgumentCount(def, node.args.length);
    if (countError) return this.fail('#ERROR!', countError);

    if (SPECIAL_FORMS.has(def.name)) return this.evaluateSpecialForm(def.name, node);

    const args = this.lazyArguments(node.args);
    if (def.elementwise) {
      const lifted = this.liftOverArrays(def, args);
      if (lifted !== undefined) return lifted;
    }
    return this.finishCall(def, def.evaluate(this.createContext(def, args)));
  }

  private finishCall(def: FormulaFunctionDefinition, result: any): any {
    if (typeof result === 'number' && !Number.isFinite(result)) {
      return this.fail('#NUM!', `${def.name} produced an invalid number.`);
    }
    return result === undefined || result === null ? '' : result;
  }

  private lazyArguments(nodes: ASTNode[]): FormulaArgument[] {
    const cache = new Map<number, any>();
    return nodes.map((node, index) => ({
      index,
      node,
      value: () => {
        if (!cache.has(index)) cache.set(index, this.evaluateNode(node));
        return cache.get(index);
      },
    }));
  }

  /**
   * Applies a scalar function element by element when it receives arrays
   * (`=LEN(A1:A3)`, `=IF(A1:A3>1, "y", "n")`). Arguments typed `range` are
   * passed whole. Returns undefined when no trigger argument is a
   * multi-value array.
   */
  private liftOverArrays(def: FormulaFunctionDefinition, args: FormulaArgument[]): any {
    const liftable = (index: number) => def.args[getFormulaArgumentSpecIndex(def, index)]?.type !== 'range';
    const triggers = def.elementwise === true ? args.map((a) => a.index) : (def.elementwise as readonly number[]);
    if (!triggers.some((i) => i < args.length && liftable(i) && isMultiArray(args[i].value()))) return undefined;

    let rows = 1;
    let cols = 1;
    for (const a of args) {
      if (!liftable(a.index)) continue;
      const shape = shapeOf(a.value());
      rows = Math.max(rows, shape.rows);
      cols = Math.max(cols, shape.cols);
    }
    if (rows * cols > MAX_FORMULA_ARRAY_SIZE) return this.fail('#NUM!', 'The array result is too large.');
    return buildArray(rows, cols, (r, c) => {
      const elementArgs: FormulaArgument[] = args.map((a) => {
        if (!liftable(a.index)) return a;
        const element = broadcastGet(a.value(), r, c);
        return { index: a.index, node: a.node, value: () => element };
      });
      return firstValue(this.finishCall(def, def.evaluate(this.createContext(def, elementArgs))));
    });
  }

  // --- Names, LET and LAMBDA ---

  /** A bare name: a variable, a defined name, or #NAME?. */
  private evaluateName(node: NameNode): any {
    if (node.sheet === undefined) {
      const variables = lookupEnvironment(this.env, node.name);
      if (variables) return variables.vars.get(node.name);
    }
    const named = this.lookupDefinedName(node.name, node.sheet);
    if (named) return this.evaluateDefinedName(named, `${sheetLabel(node)}${node.name}`);
    if (node.sheet !== undefined) {
      return this.fail('#NAME?', `There is no name ${node.name} on sheet ${node.sheet}.`);
    }
    return this.fail('#NAME?', `This formula contains an unknown name.`);
  }

  private lookupDefinedName(name: string, sheet?: string): FormulaNameDefinition | null {
    return this.context.resolveName?.(name, sheet ?? this.defaultSheet) ?? null;
  }

  /**
   * Evaluates a defined name's formula, outside any LET/LAMBDA variables, with
   * unqualified references pointing at the name's sheet (for sheet-scoped
   * names).
   */
  private evaluateDefinedName(def: FormulaNameDefinition, label: string): any {
    const key = (def.key ?? label).toUpperCase();
    if (this.nameStack.includes(key)) {
      return this.fail('#CYCLE!', `The name ${label} refers to itself.`);
    }
    let ast: ASTNode;
    if (typeof def.formula === 'string') {
      const text = def.formula.startsWith('=') ? def.formula : `=${def.formula}`;
      let cached = this.parsedNames.get(text);
      if (!cached) {
        try {
          cached = parseFormula(text);
        } catch {
          return this.fail('#NAME?', `The name ${label} has a formula that can't be read.`);
        }
        if (this.parsedNames.size > 500) this.parsedNames.clear();
        this.parsedNames.set(text, cached);
      }
      ast = cached;
    } else {
      ast = def.formula;
    }
    const savedEnv = this.env;
    const savedSheet = this.defaultSheet;
    this.nameStack.push(key);
    this.env = null;
    if (def.sheet !== undefined) this.defaultSheet = def.sheet;
    try {
      return this.evaluateNode(ast);
    } finally {
      this.env = savedEnv;
      this.defaultSheet = savedSheet;
      this.nameStack.pop();
    }
  }

  /** A 3-D reference (`Sheet1:Sheet3!A1`, `Sheet1:Sheet3!A1:B2`): every sheet's values, in tab order. */
  private evaluate3d(node: CellRefNode | RangeNode): any {
    const label = node.type === 'CellRef' ? `${sheetLabel(node)}${node.ref}` : `${sheetLabel(node)}${node.raw}`;
    const sheets = this.context.resolveSheetSpan?.(node.sheet!, node.sheetEnd!);
    if (!Array.isArray(sheets)) {
      return this.fail('#REF!', `${label} refers to a sheet that doesn't exist.`);
    }
    const values: any[] = [];
    for (const sheet of sheets) {
      const part =
        node.type === 'CellRef'
          ? [this.context.resolveCell!(node.col, node.row, sheet)]
          : this.context.resolveRange!(node.startCol, node.startRow, node.endCol, node.endRow, sheet);
      if (!Array.isArray(part)) return this.fail('#REF!', `${label} refers to a sheet that doesn't exist.`);
      for (const value of part) values.push(value ?? '');
    }
    const error = values.find(isFormulaError);
    if (error) this.fail(error as FormulaErrorCode, `The 3-D reference ${label} contains an error (${error}).`);
    return withRangeShape(values, values.length, 1);
  }

  /** Calls a lambda with argument expressions, evaluated in the caller's scope. */
  private invokeLambda(lambda: FormulaLambda, argNodes: ASTNode[]): any {
    const params = lambda.params;
    // `f()` with one parameter passes it as omitted.
    const positionsOk = argNodes.length === params.length || (argNodes.length === 0 && params.length === 1);
    if (!positionsOk) {
      return this.fail(
        '#VALUE!',
        `${lambda.label} expects ${params.length} argument${params.length === 1 ? '' : 's'}, but ${argNodes.length} ${argNodes.length === 1 ? 'was' : 'were'} given.`,
      );
    }
    const values: any[] = [];
    const omitted = new Set<number>();
    for (let i = 0; i < params.length; i++) {
      const node = argNodes[i];
      if (!node || node.type === 'Missing') {
        omitted.add(i);
        values.push('');
      } else {
        values.push(this.evaluateNode(node));
      }
    }
    return this.invokeWithValues(lambda, values, omitted);
  }

  /** Calls a lambda with argument values (`omitted`: positions left out, for ISOMITTED). */
  private invokeWithValues(lambda: FormulaLambda, values: any[], omitted?: Set<number>): any {
    if (this.lambdaDepth >= MAX_LAMBDA_DEPTH) {
      return this.fail('#NUM!', `LAMBDA calls are nested more than ${MAX_LAMBDA_DEPTH} deep (runaway recursion?).`);
    }
    if (lambda.native) return lambda.native(values);
    const vars = new Map<string, any>();
    let omittedNames: Set<string> | undefined;
    lambda.params.forEach((param, i) => {
      vars.set(param, values[i] ?? '');
      if (omitted?.has(i)) (omittedNames ??= new Set()).add(param);
    });
    const savedEnv = this.env;
    const savedSheet = this.defaultSheet;
    this.env = { vars, omitted: omittedNames, parent: lambda.env };
    this.defaultSheet = lambda.sheet;
    this.lambdaDepth++;
    try {
      return this.evaluateNode(lambda.body!);
    } finally {
      this.lambdaDepth--;
      this.env = savedEnv;
      this.defaultSheet = savedSheet;
    }
  }

  private evaluateSpecialForm(name: string, node: FunctionCallNode): any {
    switch (name) {
      case 'LET':
        return this.evaluateLet(node);
      case 'LAMBDA':
        return this.evaluateLambda(node);
      case 'ISOMITTED': {
        const arg = node.args[0];
        if (arg?.type !== 'Name' || arg.sheet !== undefined) return false;
        const variables = lookupEnvironment(this.env, arg.name);
        return !!variables?.omitted?.has(arg.name);
      }
      case 'MAP':
        return this.evaluateMap(node);
      case 'REDUCE':
      case 'SCAN':
        return this.evaluateReduce(node, name === 'SCAN');
      case 'BYROW':
      case 'BYCOL':
        return this.evaluateByLine(node, name === 'BYROW');
      default:
        return this.evaluateMakeArray(node);
    }
  }

  /** LET(name1, value1, [name2, value2, ...], calculation). */
  private evaluateLet(node: FunctionCallNode): any {
    if (node.args.length % 2 === 0) {
      return this.fail('#ERROR!', 'LET needs name/value pairs followed by a calculation.');
    }
    const vars = new Map<string, any>();
    const savedEnv = this.env;
    // Each value sees the names defined before it.
    this.env = { vars, parent: savedEnv };
    try {
      for (let i = 0; i < node.args.length - 1; i += 2) {
        const nameNode = node.args[i];
        if (nameNode.type !== 'Name' || nameNode.sheet !== undefined) {
          return this.fail('#ERROR!', `Argument ${i + 1} of LET must be a name (names can't look like cell references).`);
        }
        vars.set(nameNode.name, this.evaluateNode(node.args[i + 1]));
      }
      return this.evaluateNode(node.args[node.args.length - 1]);
    } finally {
      this.env = savedEnv;
    }
  }

  /** LAMBDA([parameter1, ...], calculation): a function value closing over the current variables. */
  private evaluateLambda(node: FunctionCallNode): any {
    const params: string[] = [];
    for (let i = 0; i < node.args.length - 1; i++) {
      const param = node.args[i];
      if (param.type !== 'Name' || param.sheet !== undefined) {
        return this.fail('#VALUE!', `Parameter ${i + 1} of LAMBDA must be a name (names can't look like cell references).`);
      }
      if (params.includes(param.name)) {
        return this.fail('#VALUE!', `LAMBDA parameter ${param.name} is listed twice.`);
      }
      params.push(param.name);
    }
    const body = node.args[node.args.length - 1];
    if (body.type === 'Missing') return this.fail('#VALUE!', 'LAMBDA needs a calculation as its last argument.');
    return new FormulaLambda(params, body, this.env, this.defaultSheet);
  }

  /**
   * The function argument of a LAMBDA helper: a lambda, or a built-in
   * function given by name (`BYROW(A1:C3, SUM)`) unless a variable or defined
   * name has that name. Returns an error string when it is neither.
   */
  private lambdaArgument(fn: string, node: ASTNode | undefined, index: number): FormulaLambda | string {
    if (!node) return this.fail('#VALUE!', `${fn} needs a LAMBDA function.`);
    if (node.type === 'Name' && node.sheet === undefined && !lookupEnvironment(this.env, node.name) && !this.lookupDefinedName(node.name)) {
      const def = getFormulaFunction(node.name);
      if (def && !SPECIAL_FORMS.has(def.name)) {
        return new FormulaLambda([], null, null, undefined, (values) => this.callBuiltinWithValues(def, values), def.name);
      }
    }
    const value = this.evaluateNode(node);
    if (isFormulaLambda(value)) return value;
    if (isFormulaError(value)) return value;
    return this.fail('#VALUE!', `Argument ${index + 1} of ${fn} must be a LAMBDA function.`);
  }

  /** Calls a built-in function with already evaluated arguments. */
  private callBuiltinWithValues(def: FormulaFunctionDefinition, values: any[]): any {
    const countError = checkFormulaArgumentCount(def, values.length);
    if (countError) return this.fail('#VALUE!', countError);
    const args: FormulaArgument[] = values.map((value, index) => ({ index, node: LITERAL_BLANK, value: () => value }));
    if (def.elementwise) {
      const lifted = this.liftOverArrays(def, args);
      if (lifted !== undefined) return lifted;
    }
    return this.finishCall(def, def.evaluate(this.createContext(def, args)));
  }

  /** Checks a lambda takes `count` parameters (native functions take any count). */
  private checkArity(fn: string, lambda: FormulaLambda, count: number): string | null {
    if (lambda.native || lambda.params.length === count) return null;
    return this.fail(
      '#VALUE!',
      `The LAMBDA passed to ${fn} must take ${count} parameter${count === 1 ? '' : 's'}, but it takes ${lambda.params.length}.`,
    );
  }

  /** MAP(array1, [array2, ...], lambda): calls the lambda with each element. */
  private evaluateMap(node: FunctionCallNode): any {
    const lambda = this.lambdaArgument('MAP', node.args[node.args.length - 1], node.args.length - 1);
    if (typeof lambda === 'string') return lambda;
    const arrays: any[] = [];
    for (let i = 0; i < node.args.length - 1; i++) {
      const value = this.evaluateNode(node.args[i]);
      if (isFormulaError(value)) return value;
      arrays.push(value);
    }
    const arity = this.checkArity('MAP', lambda, arrays.length);
    if (arity) return arity;
    let rows = 1;
    let cols = 1;
    for (const array of arrays) {
      const shape = shapeOf(array);
      rows = Math.max(rows, shape.rows);
      cols = Math.max(cols, shape.cols);
    }
    if (rows * cols > MAX_FORMULA_ARRAY_SIZE) return this.fail('#NUM!', 'The array result is too large.');
    return buildArray(rows, cols, (r, c) =>
      elementValue(this.invokeWithValues(lambda, arrays.map((array) => broadcastGet(array, r, c)))),
    );
  }

  /**
   * REDUCE([initial_value], array, lambda) / SCAN(...): folds the array row
   * by row with lambda(accumulator, value). SCAN returns every intermediate
   * value, in the array's shape.
   */
  private evaluateReduce(node: FunctionCallNode, scan: boolean): any {
    const fn = scan ? 'SCAN' : 'REDUCE';
    let acc: any = this.evaluateNode(node.args[0]);
    const arrayValue = this.evaluateNode(node.args[1]);
    if (isFormulaError(arrayValue)) return arrayValue;
    const lambda = this.lambdaArgument(fn, node.args[2], 2);
    if (typeof lambda === 'string') return lambda;
    const arity = this.checkArity(fn, lambda, 2);
    if (arity) return arity;
    const range = asRange(arrayValue);
    const results: any[] = scan ? new Array(range.rows * range.cols) : [];
    // Excel goes row by row; ranges are stored column by column.
    for (let r = 0; r < range.rows; r++) {
      for (let c = 0; c < range.cols; c++) {
        acc = this.invokeWithValues(lambda, [acc, rangeGet(range, r, c)]);
        if (scan) results[c * range.rows + r] = elementValue(acc);
      }
    }
    if (scan) return withRangeShape(results, range.rows, range.cols);
    return acc;
  }

  /** BYROW(array, lambda) / BYCOL(array, lambda): one result per row (a column) or per column (a row). */
  private evaluateByLine(node: FunctionCallNode, byRow: boolean): any {
    const fn = byRow ? 'BYROW' : 'BYCOL';
    const arrayValue = this.evaluateNode(node.args[0]);
    if (isFormulaError(arrayValue)) return arrayValue;
    const lambda = this.lambdaArgument(fn, node.args[1], 1);
    if (typeof lambda === 'string') return lambda;
    const arity = this.checkArity(fn, lambda, 1);
    if (arity) return arity;
    const range = asRange(arrayValue);
    const count = byRow ? range.rows : range.cols;
    const out: any[] = [];
    for (let i = 0; i < count; i++) {
      const line: any[] = [];
      const length = byRow ? range.cols : range.rows;
      for (let j = 0; j < length; j++) line.push(byRow ? rangeGet(range, i, j) : rangeGet(range, j, i));
      const slice = byRow ? withRangeShape(line, 1, length) : withRangeShape(line, length, 1);
      out.push(elementValue(this.invokeWithValues(lambda, [slice])));
    }
    return byRow ? withRangeShape(out, count, 1) : withRangeShape(out, 1, count);
  }

  /** MAKEARRAY(rows, columns, lambda): lambda(row, column) for every 1-based position. */
  private evaluateMakeArray(node: FunctionCallNode): any {
    const size = (index: number): number | string => {
      const value = firstValue(this.evaluateNode(node.args[index]));
      if (isFormulaError(value)) return value;
      const num = toNumber(value);
      if (isFormulaError(num)) return this.fail('#VALUE!', `Argument ${index + 1} of MAKEARRAY must be a number.`);
      return Math.trunc(num as number);
    };
    const rows = size(0);
    if (typeof rows === 'string') return rows;
    const cols = size(1);
    if (typeof cols === 'string') return cols;
    if (rows < 1 || cols < 1) return this.fail('#VALUE!', 'MAKEARRAY needs at least one row and one column.');
    if (rows * cols > MAX_FORMULA_ARRAY_SIZE) return this.fail('#NUM!', 'The array result is too large.');
    const lambda = this.lambdaArgument('MAKEARRAY', node.args[2], 2);
    if (typeof lambda === 'string') return lambda;
    const arity = this.checkArity('MAKEARRAY', lambda, 2);
    if (arity) return arity;
    return buildArray(rows, cols, (r, c) => elementValue(this.invokeWithValues(lambda, [r + 1, c + 1])));
  }

  private createContext(def: FormulaFunctionDefinition, args: FormulaArgument[]): FormulaFunctionContext {

    const has = (index: number) => index >= 0 && index < args.length;
    const value = (index: number) => (has(index) ? args[index].value() : '');
    const argError = (index: number, code: FormulaErrorCode, reason: string) =>
      this.fail(code, `Argument ${index + 1} of ${def.name} ${reason}`);

    const scalar = (index: number) => {
      const v = value(index);
      if (!Array.isArray(v)) return v;
      if (v.length <= 1) return v.length === 1 ? v[0] : '';
      return argError(index, '#VALUE!', 'must be a single value, not a range.');
    };

    const number = (index: number, fallback?: number): number | string => {
      if (!has(index) && fallback !== undefined) return fallback;
      const v = scalar(index);
      if (isFormulaError(v)) return v;
      const num = toNumber(v);
      return isFormulaError(num) ? argError(index, '#VALUE!', `can't be text (${quote(v)}).`) : num;
    };

    const flatValues = (from = 0, to = args.length): any[] => {
      const items: any[] = [];
      for (let i = from; i < Math.min(to, args.length); i++) {
        const v = args[i].value();
        if (Array.isArray(v)) {
          // No spread: push(...v) overflows the stack for large ranges.
          for (const item of v) items.push(item);
        } else {
          items.push(v);
        }
      }
      return items;
    };

    return {
      name: def.name,
      args,
      error: (code, message) => this.fail(code, message ?? describeFormulaError(code)),
      argError,
      has,
      value,
      scalar,
      number,
      integer: (index, fallback) => {
        const num = number(index, fallback);
        return isFormulaError(num) ? num : Math.trunc(num as number);
      },
      text: (index, fallback) => {
        if (!has(index) && fallback !== undefined) return fallback;
        const v = scalar(index);
        return isFormulaError(v) ? v : toText(v);
      },
      boolean: (index, fallback) => {
        if (!has(index) && fallback !== undefined) return fallback;
        const v = scalar(index);
        if (isFormulaError(v)) return v;
        const bool = toBoolean(v);
        return isFormulaError(bool) ? argError(index, '#VALUE!', `must be TRUE or FALSE, not text (${quote(v)}).`) : bool;
      },
      date: (index) => {
        const v = scalar(index);
        if (isFormulaError(v)) return v;
        if (isBlank(v)) return argError(index, '#VALUE!', 'is empty, but a date is needed.');
        return toDate(v) ?? argError(index, '#VALUE!', `(${quote(v)}) isn't a valid date.`);
      },
      range: (index) => {
        const v = value(index);
        if (Array.isArray(v)) return toFormulaRange(v);
        if (isFormulaError(v)) return v;
        return argError(index, '#VALUE!', 'must be a range.');
      },
      flatValues,
      numbers: (from, to) => {
        // Numbers among the arguments (text and blanks are skipped, as in SUM);
        // the first error found is returned instead.
        const nums: number[] = [];
        for (const item of flatValues(from, to)) {
          if (isFormulaError(item)) return item;
          if (isBlank(item) || typeof item === 'boolean') continue;
          const num = typeof item === 'number' ? item : numericValue(item);
          if (num !== null) nums.push(num);
        }
        return nums;
      },
    };
  }
}
