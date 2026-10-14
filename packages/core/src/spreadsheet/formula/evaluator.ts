import { ASTNode, parseFormula, type FunctionCallNode, type RangeNode } from './parser';
import {
  checkFormulaArgumentCount,
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
  type FormulaErrorCode,
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
};

/** Generic explanation of an error code, used when no specific reason was recorded. */
export function describeFormulaError(code: string): string {
  return DEFAULT_MESSAGES[code as FormulaErrorCode] ?? 'The formula could not be evaluated.';
}

const quote = (value: unknown) => (typeof value === 'string' ? `"${value}"` : String(value));

export class FormulaEvaluator {
  private context: EvaluationContext;
  private diagnostics: FormulaDiagnostic[] = [];

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
   * return `#ERROR!` with the parser's message. A result that is a whole range
   * (no dynamic-array spilling) is reduced to its first value.
   */
  public evaluateWithDiagnostics(astOrFormula: ASTNode | string): FormulaEvaluationResult {
    const saved = this.diagnostics;
    this.diagnostics = [];
    try {
      let value = this.evaluate(astOrFormula);
      if (Array.isArray(value)) value = value.length > 0 ? value[0] : '';
      if (isFormulaError(value)) {
        const code = value as FormulaErrorCode;
        const diagnostic = this.diagnostics.find((d) => d.code === code);
        return { value, error: code, message: diagnostic?.message ?? describeFormulaError(code) };
      }
      return { value };
    } catch (err: any) {
      return { value: '#ERROR!', error: '#ERROR!', message: err?.message || 'Formula error' };
    } finally {
      this.diagnostics = saved;
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

      case 'PropertyRef': {
        if (!this.context.resolveProperty) {
          throw new Error(`Cannot resolve property [${node.property}]: no property resolver provided`);
        }
        return this.context.resolveProperty(node.property);
      }

      case 'UnaryOp': {
        const raw = this.evaluateNode(node.argument);
        const val = toNumber(raw);
        if (isFormulaError(val)) {
          return isFormulaError(raw) ? raw : this.fail('#VALUE!', `The ${node.op} operator can't use text (${quote(raw)}).`);
        }
        if (node.op === '-') return -(val as number);
        if (node.op === '+') return val;
        throw new Error(`Unsupported unary operator: ${node.op}`);
      }

      case 'BinaryOp': {
        const left = this.evaluateNode(node.left);
        if (isFormulaError(left)) return left;
        const right = this.evaluateNode(node.right);
        if (isFormulaError(right)) return right;

        if (['+', '-', '*', '/', '^'].includes(node.op)) {
          const a = toNumber(left);
          if (isFormulaError(a)) return this.fail('#VALUE!', `The ${node.op} operator can't use text (${quote(left)}).`);
          const b = toNumber(right);
          if (isFormulaError(b)) return this.fail('#VALUE!', `The ${node.op} operator can't use text (${quote(right)}).`);
          const x = a as number;
          const y = b as number;
          let result: number;
          switch (node.op) {
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

        switch (node.op) {
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
            throw new Error(`Unsupported binary operator: ${node.op}`);
        }
      }

      case 'FunctionCall':
        return this.callFunction(node);

      default:
        throw new Error(`Unknown AST node: ${(node as any).type}`);
    }
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

    const result = def.evaluate(this.createContext(def, node.args));
    if (typeof result === 'number' && !Number.isFinite(result)) {
      return this.fail('#NUM!', `${def.name} produced an invalid number.`);
    }
    return result === undefined || result === null ? '' : result;
  }

  private createContext(def: FormulaFunctionDefinition, nodes: ASTNode[]): FormulaFunctionContext {
    const cache = new Map<number, any>();
    const args: FormulaArgument[] = nodes.map((node, index) => ({
      index,
      node,
      value: () => {
        if (!cache.has(index)) cache.set(index, this.evaluateNode(node));
        return cache.get(index);
      },
    }));

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
