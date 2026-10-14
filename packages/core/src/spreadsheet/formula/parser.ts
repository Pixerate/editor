import { FormulaToken, tokenizeFormula, FormulaTokenType } from './lexer';

/** Row number used for the open end of whole-column ranges such as `A:A`. */
export const WHOLE_COLUMN_END_ROW = 1048576;

export type ASTNode =
  | LiteralNode
  | CellRefNode
  | RangeNode
  | SpillRefNode
  | NameNode
  | PropertyRefNode
  | BinaryOpNode
  | UnaryOpNode
  | FunctionCallNode
  | InvokeNode
  | MissingNode;

/**
 * Sheet qualification of a reference: `Sheet2!A1` has `sheet: 'Sheet2'`;
 * a 3-D reference `Sheet1:Sheet3!A1` also has `sheetEnd: 'Sheet3'`. Unset
 * for references to the formula's own sheet.
 */
export interface SheetQualifier {
  sheet?: string;
  sheetEnd?: string;
}

export interface LiteralNode {
  type: 'Literal';
  value: number | string | boolean;
}

export interface CellRefNode extends SheetQualifier {
  type: 'CellRef';
  ref: string;
  col: string;
  row: number;
}

export interface RangeNode extends SheetQualifier {
  type: 'Range';
  raw: string;
  startCol: string;
  startRow: number;
  endCol: string;
  endRow: number;
}

/** `A1#`: the whole spill range of the dynamic array anchored at A1. */
export interface SpillRefNode extends SheetQualifier {
  type: 'SpillRef';
  /** Anchor cell, e.g. `A1`. */
  ref: string;
  col: string;
  row: number;
}

/**
 * A bare name: a LET or LAMBDA variable, a defined name (`Rate`,
 * `Data!Rate` with `sheet`), or `#NAME?` when nothing defines it.
 */
export interface NameNode {
  type: 'Name';
  name: string;
  /** Sheet of a sheet-qualified name (`Data!Rate`). */
  sheet?: string;
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

/**
 * A call of a computed function: `LAMBDA(x, x+1)(2)` or `(f)(2)`. Calls of a
 * named function, defined name or variable (`F(2)`) are `FunctionCall`s.
 */
export interface InvokeNode {
  type: 'Invoke';
  callee: ASTNode;
  args: ASTNode[];
}

/** An argument left empty, as in `IF(A1,,1)` or `LAMBDA(x, y, x)(1,)`. */
export interface MissingNode {
  type: 'Missing';
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
  const [start, end] = rangeStr.replace(/\$/g, '').split(':');
  const raw = rangeStr.toUpperCase();

  // Whole-column range, e.g. A:A or B:D
  if (/^[A-Za-z]+$/.test(start) && /^[A-Za-z]+$/.test(end)) {
    return {
      type: 'Range',
      raw,
      startCol: start.toUpperCase(),
      startRow: 1,
      endCol: end.toUpperCase(),
      endRow: WHOLE_COLUMN_END_ROW
    };
  }

  const startRef = parseCellReference(start);
  const endRef = parseCellReference(end);
  return {
    type: 'Range',
    raw,
    startCol: startRef.col,
    startRow: startRef.row,
    endCol: endRef.col,
    endRow: endRef.row
  };
}

const qualifier = (token: FormulaToken): SheetQualifier =>
  token.sheet === undefined
    ? {}
    : token.sheetEnd === undefined
      ? { sheet: token.sheet }
      : { sheet: token.sheet, sheetEnd: token.sheetEnd };

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
    if (this.matchOperator('-', '+', '@')) {
      const op = this.previous().value;
      const argument = this.unary();
      return { type: 'UnaryOp', op, argument };
    }
    let expr = this.primary();
    // A call of a computed function: LAMBDA(x, x+1)(2), (f)(2), F(1)(2).
    while (this.check('LPAREN') && (expr.type === 'FunctionCall' || expr.type === 'Invoke' || this.previous().type === 'RPAREN')) {
      this.advance();
      expr = { type: 'Invoke', callee: expr, args: this.argumentList() };
    }
    return expr;
  }

  /** Arguments after `(` up to and including `)`. Empty positions are `Missing`. */
  private argumentList(): ASTNode[] {
    const args: ASTNode[] = [];
    if (this.match('RPAREN')) return args;
    do {
      args.push(this.check('COMMA') || this.check('RPAREN') ? { type: 'Missing' } : this.expression());
    } while (this.match('COMMA'));
    this.consume('RPAREN', `Expected ')' after function arguments`);
    return args;
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

    if (token.type === 'ERROR') {
      this.advance();
      return { type: 'Literal', value: token.value };
    }

    if (token.type === 'CELL_REF') {
      this.advance();
      // A function whose name looks like a cell reference (LOG10).
      if (token.sheet === undefined && this.check('LPAREN')) {
        this.advance();
        return { type: 'FunctionCall', name: token.value, args: this.argumentList() };
      }
      const parsed = parseCellReference(token.value);
      return {
        type: 'CellRef',
        ref: token.value,
        col: parsed.col,
        row: parsed.row,
        ...qualifier(token)
      };
    }

    if (token.type === 'RANGE') {
      this.advance();
      return { ...parseRange(token.value), ...qualifier(token) };
    }

    if (token.type === 'SPILL_REF') {
      this.advance();
      const parsed = parseCellReference(token.value);
      return { type: 'SpillRef', ref: token.value, col: parsed.col, row: parsed.row, ...qualifier(token) };
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
        if (token.sheet !== undefined) {
          throw new Error(`Unexpected '(' after ${token.sheet}!${name} at position ${this.peek().position}`);
        }
        this.consume('LPAREN', `Expected '(' after function ${name}`);
        return {
          type: 'FunctionCall',
          name,
          args: this.argumentList()
        };
      }
      if (token.sheetEnd !== undefined) {
        throw new Error(`A 3-D reference can't name ${name} at position ${token.position}`);
      }

      // A bare name: a LET variable or defined name, otherwise #NAME? (as in spreadsheet apps).
      return token.sheet !== undefined ? { type: 'Name', name, sheet: token.sheet } : { type: 'Name', name };
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
