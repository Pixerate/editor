import { FormulaToken, tokenizeFormula, FormulaTokenType } from './lexer';

export type ASTNode =
  | LiteralNode
  | CellRefNode
  | RangeNode
  | PropertyRefNode
  | BinaryOpNode
  | UnaryOpNode
  | FunctionCallNode;

export interface LiteralNode {
  type: 'Literal';
  value: number | string | boolean;
}

export interface CellRefNode {
  type: 'CellRef';
  ref: string;
  col: string;
  row: number;
}

export interface RangeNode {
  type: 'Range';
  raw: string;
  startCol: string;
  startRow: number;
  endCol: string;
  endRow: number;
}

export interface PropertyRefNode {
  type: 'PropertyRef';
  property: string;
}

export interface BinaryOpNode {
  type: 'BinaryOp';
  op: string;
  left: ASTNode;
  right: ASTNode;
}

export interface UnaryOpNode {
  type: 'UnaryOp';
  op: string;
  argument: ASTNode;
}

export interface FunctionCallNode {
  type: 'FunctionCall';
  name: string;
  args: ASTNode[];
}

export function parseCellReference(ref: string): { col: string; row: number } {
  const match = ref.match(/^([A-Za-z]+)(\d+)$/);
  if (!match) {
    throw new Error(`Invalid cell reference: ${ref}`);
  }
  return {
    col: match[1].toUpperCase(),
    row: parseInt(match[2], 10)
  };
}

export function parseRange(rangeStr: string): RangeNode {
  const [start, end] = rangeStr.split(':');
  const startRef = parseCellReference(start);
  const endRef = parseCellReference(end);
  return {
    type: 'Range',
    raw: rangeStr.toUpperCase(),
    startCol: startRef.col,
    startRow: startRef.row,
    endCol: endRef.col,
    endRow: endRef.row
  };
}

export class FormulaParser {
  private tokens: FormulaToken[] = [];
  private current = 0;

  constructor(tokens: FormulaToken[]) {
    this.tokens = tokens;
  }

  public parse(): ASTNode {
    if (this.peek().type === 'EOF') {
      return { type: 'Literal', value: '' };
    }
    const expr = this.expression();
    if (this.peek().type !== 'EOF') {
      throw new Error(`Unexpected token at position ${this.peek().position}: ${this.peek().value}`);
    }
    return expr;
  }

  private expression(): ASTNode {
    return this.comparison();
  }

  private comparison(): ASTNode {
    let expr = this.concatenation();

    while (
      this.matchOperator('=', '<>', '<', '>', '<=', '>=')
    ) {
      const op = this.previous().value;
      const right = this.concatenation();
      expr = { type: 'BinaryOp', op, left: expr, right };
    }

    return expr;
  }

  private concatenation(): ASTNode {
    let expr = this.addition();

    while (this.matchOperator('&')) {
      const op = this.previous().value;
      const right = this.addition();
      expr = { type: 'BinaryOp', op, left: expr, right };
    }

    return expr;
  }

  private addition(): ASTNode {
    let expr = this.multiplication();

    while (this.matchOperator('+', '-')) {
      const op = this.previous().value;
      const right = this.multiplication();
      expr = { type: 'BinaryOp', op, left: expr, right };
    }

    return expr;
  }

  private multiplication(): ASTNode {
    let expr = this.exponentiation();

    while (this.matchOperator('*', '/')) {
      const op = this.previous().value;
      const right = this.exponentiation();
      expr = { type: 'BinaryOp', op, left: expr, right };
    }

    return expr;
  }

  private exponentiation(): ASTNode {
    let expr = this.unary();

    while (this.matchOperator('^')) {
      const op = this.previous().value;
      const right = this.unary();
      expr = { type: 'BinaryOp', op, left: expr, right };
    }

    return expr;
  }

  private unary(): ASTNode {
    if (this.matchOperator('-', '+')) {
      const op = this.previous().value;
      const argument = this.unary();
      return { type: 'UnaryOp', op, argument };
    }
    return this.primary();
  }

  private primary(): ASTNode {
    const token = this.peek();

    if (token.type === 'NUMBER') {
      this.advance();
      return { type: 'Literal', value: parseFloat(token.value) };
    }

    if (token.type === 'STRING') {
      this.advance();
      return { type: 'Literal', value: token.value };
    }

    if (token.type === 'BOOLEAN') {
      this.advance();
      return { type: 'Literal', value: token.value === 'TRUE' };
    }

    if (token.type === 'CELL_REF') {
      this.advance();
      const parsed = parseCellReference(token.value);
      return {
        type: 'CellRef',
        ref: token.value,
        col: parsed.col,
        row: parsed.row
      };
    }

    if (token.type === 'RANGE') {
      this.advance();
      return parseRange(token.value);
    }

    if (token.type === 'PROPERTY_REF') {
      this.advance();
      return {
        type: 'PropertyRef',
        property: token.value
      };
    }

    // Function call e.g. SUM(...)
    if (token.type === 'IDENTIFIER') {
      const name = token.value;
      this.advance();

      if (this.check('LPAREN')) {
        this.consume('LPAREN', `Expected '(' after function ${name}`);
        const args: ASTNode[] = [];
        if (!this.check('RPAREN')) {
          do {
            args.push(this.expression());
          } while (this.match('COMMA'));
        }
        this.consume('RPAREN', `Expected ')' after function arguments`);
        return {
          type: 'FunctionCall',
          name,
          args
        };
      }

      // Standalone identifier treated as string literal or reference
      return { type: 'Literal', value: name };
    }

    if (this.match('LPAREN')) {
      const expr = this.expression();
      this.consume('RPAREN', `Expected ')' after expression`);
      return expr;
    }

    throw new Error(`Unexpected token at position ${token.position}: ${token.value || token.type}`);
  }

  private match(...types: string[]): boolean {
    for (const type of types) {
      if (this.check(type)) {
        this.advance();
        return true;
      }
    }
    return false;
  }

  private matchOperator(...ops: string[]): boolean {
    if (this.check('OPERATOR') && ops.includes(this.peek().value)) {
      this.advance();
      return true;
    }
    return false;
  }

  private check(type: string): boolean {
    if (this.isAtEnd()) return false;
    return this.peek().type === type;
  }

  private advance(): FormulaToken {
    if (!this.isAtEnd()) this.current++;
    return this.previous();
  }

  private isAtEnd(): boolean {
    return this.peek().type === 'EOF';
  }

  private peek(): FormulaToken {
    return this.tokens[this.current];
  }

  private previous(): FormulaToken {
    return this.tokens[this.current - 1];
  }

  private consume(type: string, message: string): FormulaToken {
    if (this.check(type)) return this.advance();
    throw new Error(message);
  }
}

export function parseFormula(formula: string): ASTNode {
  const tokens = tokenizeFormula(formula);
  const parser = new FormulaParser(tokens);
  return parser.parse();
}
