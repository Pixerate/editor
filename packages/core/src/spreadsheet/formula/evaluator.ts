import { ASTNode, parseFormula } from './parser';

export interface EvaluationContext {
  resolveCell?: (col: string, row: number) => any;
  resolveRange?: (startCol: string, startRow: number, endCol: string, endRow: number) => any[];
  resolveProperty?: (property: string) => any;
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
        const val = this.evaluateNode(node.argument);
        if (node.op === '-') return -Number(val);
        if (node.op === '+') return +Number(val);
        throw new Error(`Unsupported unary operator: ${node.op}`);
      }

      case 'BinaryOp': {
        const left = this.evaluateNode(node.left);
        const right = this.evaluateNode(node.right);

        switch (node.op) {
          case '+':
            return Number(left) + Number(right);
          case '-':
            return Number(left) - Number(right);
          case '*':
            return Number(left) * Number(right);
          case '/': {
            const denom = Number(right);
            if (denom === 0) return '#DIV/0!';
            return Number(left) / denom;
          }
          case '^':
            return Math.pow(Number(left), Number(right));
          case '&':
            return `${left ?? ''}${right ?? ''}`;
          case '=':
            // Relaxed equality
            return String(left).toLowerCase() === String(right).toLowerCase();
          case '<>':
            return String(left).toLowerCase() !== String(right).toLowerCase();
          case '<':
            return Number(left) < Number(right);
          case '<=':
            return Number(left) <= Number(right);
          case '>':
            return Number(left) > Number(right);
          case '>=':
            return Number(left) >= Number(right);
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
          items.push(...val);
        } else {
          items.push(val);
        }
      }
      return items;
    };

    switch (fnName) {
      case 'SUM': {
        const items = evaluateAndFlatten();
        let total = 0;
        for (const item of items) {
          const num = Number(item);
          if (!isNaN(num)) total += num;
        }
        return total;
      }

      case 'AVERAGE': {
        const items = evaluateAndFlatten();
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

      case 'MIN': {
        const items = evaluateAndFlatten().map(Number).filter((n) => !isNaN(n));
        return items.length === 0 ? 0 : Math.min(...items);
      }

      case 'MAX': {
        const items = evaluateAndFlatten().map(Number).filter((n) => !isNaN(n));
        return items.length === 0 ? 0 : Math.max(...items);
      }

      case 'IF': {
        if (args.length < 2) throw new Error('IF requires at least 2 arguments');
        const condition = Boolean(this.evaluateNode(args[0]));
        if (condition) {
          return this.evaluateNode(args[1]);
        } else {
          return args.length > 2 ? this.evaluateNode(args[2]) : false;
        }
      }

      case 'CONCAT': {
        const items = evaluateAndFlatten();
        return items.map((i) => (i === null || i === undefined ? '' : String(i))).join('');
      }

      case 'UPPER': {
        if (args.length !== 1) throw new Error('UPPER requires 1 argument');
        const val = this.evaluateNode(args[0]);
        return String(val ?? '').toUpperCase();
      }

      case 'LOWER': {
        if (args.length !== 1) throw new Error('LOWER requires 1 argument');
        const val = this.evaluateNode(args[0]);
        return String(val ?? '').toLowerCase();
      }

      case 'TRIM': {
        if (args.length !== 1) throw new Error('TRIM requires 1 argument');
        const val = this.evaluateNode(args[0]);
        return String(val ?? '').trim();
      }

      case 'LEN': {
        if (args.length !== 1) throw new Error('LEN requires 1 argument');
        const val = this.evaluateNode(args[0]);
        return String(val ?? '').length;
      }

      case 'ROUND': {
        if (args.length < 1) throw new Error('ROUND requires at least 1 argument');
        const num = Number(this.evaluateNode(args[0]));
        const decimals = args.length > 1 ? Number(this.evaluateNode(args[1])) : 0;
        const factor = Math.pow(10, decimals);
        return Math.round(num * factor) / factor;
      }

      case 'ABS': {
        if (args.length !== 1) throw new Error('ABS requires 1 argument');
        return Math.abs(Number(this.evaluateNode(args[0])));
      }

      case 'TODAY': {
        return new Date().toISOString().split('T')[0];
      }

      case 'DAYS': {
        if (args.length !== 2) throw new Error('DAYS requires 2 arguments (end_date, start_date)');
        const d1 = new Date(this.evaluateNode(args[0]));
        const d2 = new Date(this.evaluateNode(args[1]));
        const diffTime = d1.getTime() - d2.getTime();
        return Math.round(diffTime / (1000 * 60 * 60 * 24));
      }

      default:
        throw new Error(`Unknown function: ${fnName}`);
    }
  }
}
