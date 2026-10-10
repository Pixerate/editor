import { ASTNode, parseFormula } from './parser';

export interface EvaluationContext {
  resolveCell?: (col: string, row: number) => any;
  resolveRange?: (startCol: string, startRow: number, endCol: string, endRow: number) => any[];
  resolveProperty?: (property: string) => any;
}

/** Spreadsheet error values. They propagate through operators and functions. */
export const FORMULA_ERRORS = new Set([
  '#DIV/0!',
  '#VALUE!',
  '#REF!',
  '#NAME?',
  '#N/A',
  '#NUM!',
  '#CYCLE!',
  '#ERROR!'
]);

export function isFormulaError(value: unknown): value is string {
  return typeof value === 'string' && FORMULA_ERRORS.has(value);
}

const isBlank = (value: unknown) => value === '' || value === null || value === undefined;

/** Coerces to a number like a spreadsheet: blanks are 0, booleans 1/0, other text is #VALUE!. */
function toNumber(value: unknown): number | string {
  if (isFormulaError(value)) return value;
  if (isBlank(value)) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  const trimmed = String(value).trim();
  const num = trimmed === '' ? NaN : Number(trimmed);
  return isNaN(num) ? '#VALUE!' : num;
}

/** Coerces to a boolean: numbers are non-zero, "TRUE"/"FALSE" text is parsed, other text is #VALUE!. */
function toBoolean(value: unknown): boolean | string {
  if (isFormulaError(value)) return value;
  if (isBlank(value)) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const upper = String(value).trim().toUpperCase();
  if (upper === 'TRUE') return true;
  if (upper === 'FALSE') return false;
  return '#VALUE!';
}

const toText = (value: unknown): string =>
  isBlank(value) ? '' : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);

/** Orders values like spreadsheets: numbers < text < booleans; text is case-insensitive. */
function compareValues(left: unknown, right: unknown): number {
  const rank = (v: unknown) => (typeof v === 'boolean' ? 2 : typeof v === 'string' ? 1 : 0);
  // A blank compares as 0 against numbers/booleans and as "" against text.
  const l = isBlank(left) ? (typeof right === 'string' ? '' : 0) : left;
  const r = isBlank(right) ? (typeof l === 'string' ? '' : 0) : right;
  if (rank(l) !== rank(r)) return rank(l) - rank(r);
  if (typeof l === 'string') {
    const a = l.toLowerCase();
    const b = (r as string).toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return Number(l) - Number(r);
}

/** Rounds half away from zero, compensating for binary floating point (ROUND(1.005, 2) = 1.01). */
function roundHalfAwayFromZero(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  return (Math.sign(value) * Math.round(scaled)) / factor;
}

export function colNameToIndex(col: string): number {
  let index = 0;
  const upper = col.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    index = index * 26 + (upper.charCodeAt(i) - 65 + 1);
  }
  return index - 1;
}

export function indexToColName(index: number): string {
  let num = index + 1;
  let name = '';
  while (num > 0) {
    const mod = (num - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    num = Math.floor((num - mod) / 26);
  }
  return name;
}

export class FormulaEvaluator {
  private context: EvaluationContext;

  constructor(context: EvaluationContext = {}) {
    this.context = context;
  }

  public evaluate(astOrFormula: ASTNode | string): any {
    const ast = typeof astOrFormula === 'string' ? parseFormula(astOrFormula) : astOrFormula;
    return this.evaluateNode(ast);
  }

  private evaluateNode(node: ASTNode): any {
    switch (node.type) {
      case 'Literal':
        return node.value;

      case 'CellRef': {
        if (!this.context.resolveCell) {
          throw new Error(`Cannot resolve cell reference ${node.ref}: no cell resolver provided`);
        }
        return this.context.resolveCell(node.col, node.row);
      }

      case 'Range': {
        if (!this.context.resolveRange) {
          throw new Error(`Cannot resolve range ${node.raw}: no range resolver provided`);
        }
        return this.context.resolveRange(node.startCol, node.startRow, node.endCol, node.endRow);
      }

      case 'PropertyRef': {
        if (!this.context.resolveProperty) {
          throw new Error(`Cannot resolve property [${node.property}]: no property resolver provided`);
        }
        return this.context.resolveProperty(node.property);
      }

      case 'UnaryOp': {
        const val = toNumber(this.evaluateNode(node.argument));
        if (isFormulaError(val)) return val;
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
          if (isFormulaError(a)) return a;
          const b = toNumber(right);
          if (isFormulaError(b)) return b;
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
              if (y === 0) return '#DIV/0!';
              result = x / y;
              break;
            default:
              result = Math.pow(x, y);
          }
          return Number.isFinite(result) ? result : '#NUM!';
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

      case 'FunctionCall': {
        return this.callFunction(node.name, node.args);
      }

      default:
        throw new Error(`Unknown AST node: ${(node as any).type}`);
    }
  }

  private callFunction(name: string, args: ASTNode[]): any {
    const fnName = name.toUpperCase();

    // Flatten helper for range/array args
    const evaluateAndFlatten = (): any[] => {
      const items: any[] = [];
      for (const arg of args) {
        const val = this.evaluateNode(arg);
        if (Array.isArray(val)) {
          // No spread: push(...val) overflows the stack for large ranges.
          for (const item of val) items.push(item);
        } else {
          items.push(val);
        }
      }
      return items;
    };

    // Numbers among the arguments (text and blanks are skipped, as in SUM);
    // the first error found is returned instead.
    const numericArgs = (): number[] | string => {
      const nums: number[] = [];
      for (const item of evaluateAndFlatten()) {
        if (isFormulaError(item)) return item;
        if (isBlank(item) || typeof item === 'boolean') continue;
        const num = typeof item === 'number' ? item : Number(String(item).trim());
        if (String(item).trim() !== '' && !isNaN(num)) nums.push(num);
      }
      return nums;
    };
    const evaluateArg = (index: number) => this.evaluateNode(args[index]);

    switch (fnName) {
      case 'SUM': {
        const nums = numericArgs();
        if (typeof nums === 'string') return nums;
        let total = 0;
        for (const num of nums) total += num;
        return total;
      }

      case 'AVERAGE': {
        const items = evaluateAndFlatten();
        const error = items.find(isFormulaError);
        if (error) return error;
        let total = 0;
        let count = 0;
        for (const item of items) {
          const num = Number(item);
          if (!isNaN(num) && item !== '' && item !== null && item !== undefined) {
            total += num;
            count++;
          }
        }
        return count === 0 ? 0 : total / count;
      }

      case 'COUNT': {
        const items = evaluateAndFlatten();
        let count = 0;
        for (const item of items) {
          const num = Number(item);
          if (!isNaN(num) && item !== '' && item !== null && item !== undefined) {
            count++;
          }
        }
        return count;
      }

      case 'COUNTA': {
        const items = evaluateAndFlatten();
        let count = 0;
        for (const item of items) {
          if (item !== '' && item !== null && item !== undefined) {
            count++;
          }
        }
        return count;
      }

      case 'MIN':
      case 'MAX': {
        const nums = numericArgs();
        if (typeof nums === 'string') return nums;
        if (nums.length === 0) return 0;
        // Loop instead of Math.min(...nums), which overflows the stack on large ranges.
        let result = nums[0];
        for (const num of nums) {
          result = fnName === 'MIN' ? Math.min(result, num) : Math.max(result, num);
        }
        return result;
      }

      case 'IF': {
        if (args.length < 2) throw new Error('IF requires at least 2 arguments');
        const condition = toBoolean(evaluateArg(0));
        if (isFormulaError(condition)) return condition;
        if (condition) {
          return this.evaluateNode(args[1]);
        } else {
          return args.length > 2 ? this.evaluateNode(args[2]) : false;
        }
      }

      case 'CONCAT': {
        const items = evaluateAndFlatten();
        const error = items.find(isFormulaError);
        if (error) return error;
        return items.map(toText).join('');
      }

      case 'UPPER': {
        if (args.length !== 1) throw new Error('UPPER requires 1 argument');
        const val = evaluateArg(0);
        if (isFormulaError(val)) return val;
        return toText(val).toUpperCase();
      }

      case 'LOWER': {
        if (args.length !== 1) throw new Error('LOWER requires 1 argument');
        const val = evaluateArg(0);
        if (isFormulaError(val)) return val;
        return toText(val).toLowerCase();
      }

      case 'TRIM': {
        if (args.length !== 1) throw new Error('TRIM requires 1 argument');
        const val = evaluateArg(0);
        if (isFormulaError(val)) return val;
        return toText(val).trim();
      }

      case 'LEN': {
        if (args.length !== 1) throw new Error('LEN requires 1 argument');
        const val = evaluateArg(0);
        if (isFormulaError(val)) return val;
        return toText(val).length;
      }

      case 'ROUND': {
        if (args.length < 1) throw new Error('ROUND requires at least 1 argument');
        const num = toNumber(evaluateArg(0));
        if (isFormulaError(num)) return num;
        const decimals = args.length > 1 ? toNumber(evaluateArg(1)) : 0;
        if (isFormulaError(decimals)) return decimals;
        return roundHalfAwayFromZero(num as number, Math.trunc(decimals as number));
      }

      case 'ABS': {
        if (args.length !== 1) throw new Error('ABS requires 1 argument');
        const num = toNumber(evaluateArg(0));
        return isFormulaError(num) ? num : Math.abs(num as number);
      }

      case 'TODAY': {
        // Local calendar date (toISOString would give the UTC date).
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      }

      case 'DAYS': {
        if (args.length !== 2) throw new Error('DAYS requires 2 arguments (end_date, start_date)');
        const d1 = new Date(this.evaluateNode(args[0]));
        const d2 = new Date(this.evaluateNode(args[1]));
        const diffTime = d1.getTime() - d2.getTime();
        return Math.round(diffTime / (1000 * 60 * 60 * 24));
      }

      default:
        return '#NAME?';
    }
  }
}
