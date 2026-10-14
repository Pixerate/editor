import { ASTNode, parseFormula, type FunctionCallNode, type RangeNode, type SpillRefNode } from './parser';
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
  type FormulaErrorCode,
  type FormulaRange,
} from './values';

export { FORMULA_ERRORS, isFormulaError, colNameToIndex, indexToColName } from './values';
export type { FormulaErrorCode, FormulaRange } from './values';

export interface EvaluationContext {
  resolveCell?: (col: string, row: number) => any;
  /**
   * Values of a rectangular range, column by column (all rows of the first
   * column, then the next column). Lookup functions rely on this order.
   */
  resolveRange?: (startCol: string, startRow: number, endCol: string, endRow: number) => any[];
  resolveProperty?: (property: string) => any;
  /**
   * The spilled array anchored at a cell, for `A1#` references: its shape and
   * values (column-major, like `resolveRange`), or an error code (e.g.
   * `#REF!` when the cell holds no array).
   */
  resolveSpill?: (col: string, row: number) => FormulaRange | string;
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

export class FormulaEvaluator {
  private context: EvaluationContext;
  private diagnostics: FormulaDiagnostic[] = [];
  // LET variables, innermost scope last.
  private scopes: Array<Map<string, any>> = [];

  constructor(context: EvaluationContext = {}) {
    this.context = context;
  }

  /**
   * Evaluates a formula. Errors in the formula are returned as error values
   * (`#VALUE!` etc.); malformed formulas and missing resolvers throw.
   */
  public evaluate(astOrFormula: ASTNode | string): any {
    const ast = typeof astOrFormula === 'string' ? parseFormula(astOrFormula) : astOrFormula;
    return this.evaluateNode(ast);
  }

  /**
   * Evaluates a formula and explains errors. Never throws: malformed formulas
   * return `#ERROR!` with the parser's message. A result with several values
   * (a range or a dynamic array) is returned in `array`, with its top-left
   * value as `value`; a one-value array is just that value.
   */
  public evaluateWithDiagnostics(astOrFormula: ASTNode | string): FormulaEvaluationResult {
    const saved = this.diagnostics;
    const savedScopes = this.scopes;
    this.diagnostics = [];
    this.scopes = [];
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
      return { value: '#ERROR!', error: '#ERROR!', message: err?.message || 'Formula error' };
    } finally {
      this.diagnostics = saved;
      this.scopes = savedScopes;
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
        const value = this.context.resolveCell(node.col, node.row);
        if (isFormulaError(value)) {
          this.fail(
            value as FormulaErrorCode,
            value === '#CYCLE!'
              ? `Cell ${node.ref} is part of a circular reference.`
              : `Cell ${node.ref} contains an error (${value}).`,
          );
        }
        return value;
      }

      case 'Range':
        return this.evaluateRange(node);

      case 'SpillRef':
        return this.evaluateSpillRef(node);

      case 'Name': {
        for (let i = this.scopes.length - 1; i >= 0; i--) {
          if (this.scopes[i].has(node.name)) return this.scopes[i].get(node.name);
        }
        return this.fail('#NAME?', 'This formula contains an unknown name.');
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
    const spill = this.context.resolveSpill(node.col, node.row);
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

  private evaluateRange(node: RangeNode): any[] {
    if (!this.context.resolveRange) {
      throw new Error(`Cannot resolve range ${node.raw}: no range resolver provided`);
    }
    const values = this.context.resolveRange(node.startCol, node.startRow, node.endCol, node.endRow);
    if (!Array.isArray(values)) return values;
    // Record the 2D shape so lookups can address rows and columns.
    const cols = Math.abs(colNameToIndex(node.endCol) - colNameToIndex(node.startCol)) + 1;
    if (values.length % cols === 0) withRangeShape(values, values.length / cols, cols);
    const error = values.find(isFormulaError);
    if (error) this.fail(error as FormulaErrorCode, `The range ${node.raw} contains an error (${error}).`);
    return values;
  }

  private callFunction(node: FunctionCallNode): any {
    const def = getFormulaFunction(node.name);
    if (!def) return this.fail('#NAME?', `Unknown function "${node.name.toUpperCase()}".`);

    const countError = checkFormulaArgumentCount(def, node.args.length);
    if (countError) return this.fail('#ERROR!', countError);

    if (def.name === 'LET') return this.evaluateLet(node);

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

  /** LET(name1, value1, [name2, value2, ...], calculation). */
  private evaluateLet(node: FunctionCallNode): any {
    if (node.args.length % 2 === 0) {
      return this.fail('#ERROR!', 'LET needs name/value pairs followed by a calculation.');
    }
    const scope = new Map<string, any>();
    this.scopes.push(scope);
    try {
      for (let i = 0; i < node.args.length - 1; i += 2) {
        const nameNode = node.args[i];
        if (nameNode.type !== 'Name') {
          return this.fail('#ERROR!', `Argument ${i + 1} of LET must be a name (names can't look like cell references).`);
        }
        scope.set(nameNode.name, this.evaluateNode(node.args[i + 1]));
      }
      return this.evaluateNode(node.args[node.args.length - 1]);
    } finally {
      this.scopes.pop();
    }
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
