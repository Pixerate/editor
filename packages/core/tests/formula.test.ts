import { describe, it, expect } from 'vitest';
import {
  tokenizeFormula,
  parseFormula,
  FormulaEvaluator,
  DependencyGraph
} from '../src/spreadsheet/formula';

describe('Spreadsheet Formula Engine', () => {
  it('tokenizes arithmetic and function formulas', () => {
    const tokens = tokenizeFormula('=SUM(A1:B5) + 42 * C3 - [status]');
    expect(tokens.map((t) => t.type)).toEqual([
      'IDENTIFIER',
      'LPAREN',
      'RANGE',
      'RPAREN',
      'OPERATOR',
      'NUMBER',
      'OPERATOR',
      'CELL_REF',
      'OPERATOR',
      'PROPERTY_REF',
      'EOF'
    ]);
  });

  it('parses formulas into an AST', () => {
    const ast = parseFormula('=10 + 20 * 3');
    expect(ast.type).toBe('BinaryOp');
    if (ast.type === 'BinaryOp') {
      expect(ast.op).toBe('+');
      expect(ast.left).toEqual({ type: 'Literal', value: 10 });
      expect(ast.right.type).toBe('BinaryOp');
    }
  });

  it('evaluates basic math and boolean logic', () => {
    const evaluator = new FormulaEvaluator();
    expect(evaluator.evaluate('=10 + 5 * 2')).toBe(20);
    expect(evaluator.evaluate('=(10 + 5) * 2')).toBe(30);
    expect(evaluator.evaluate('=100 / 4')).toBe(25);
    expect(evaluator.evaluate('=10 / 0')).toBe('#DIV/0!');
    expect(evaluator.evaluate('="Hello" & " " & "World"')).toBe('Hello World');
    expect(evaluator.evaluate('=10 > 5')).toBe(true);
    expect(evaluator.evaluate('=10 = 10')).toBe(true);
  });

  it('evaluates standard functions: SUM, AVERAGE, MIN, MAX, COUNT, IF', () => {
    const evaluator = new FormulaEvaluator();
    expect(evaluator.evaluate('=SUM(1, 2, 3, 4)')).toBe(10);
    expect(evaluator.evaluate('=AVERAGE(10, 20, 30)')).toBe(20);
    expect(evaluator.evaluate('=MIN(5, 2, 9)')).toBe(2);
    expect(evaluator.evaluate('=MAX(5, 2, 9)')).toBe(9);
    expect(evaluator.evaluate('=COUNT(1, "hello", 3, 4)')).toBe(3);
    expect(evaluator.evaluate('=IF(10 > 5, "Yes", "No")')).toBe('Yes');
    expect(evaluator.evaluate('=IF(10 < 5, "Yes", "No")')).toBe('No');
    expect(evaluator.evaluate('=UPPER("operative")')).toBe('OPERATIVE');
    expect(evaluator.evaluate('=LOWER("HELLO")')).toBe('hello');
    expect(evaluator.evaluate('=ROUND(3.14159, 2)')).toBe(3.14);
  });

  it('evaluates cell and range references via context', () => {
    const grid: Record<string, number> = {
      A1: 10,
      A2: 20,
      A3: 30,
      B1: 5
    };

    const evaluator = new FormulaEvaluator({
      resolveCell: (col, row) => grid[`${col}${row}`] ?? 0,
      resolveRange: (sCol, sRow, eCol, eRow) => [grid.A1, grid.A2, grid.A3],
      resolveProperty: (prop) => (prop === 'status' ? 'in_progress' : undefined)
    });

    expect(evaluator.evaluate('=A1 + B1')).toBe(15);
    expect(evaluator.evaluate('=SUM(A1:A3)')).toBe(60);
    expect(evaluator.evaluate('=IF([status] = "in_progress", "Active", "Inactive")')).toBe('Active');
  });

  it('detects cycles in DependencyGraph', () => {
    const graph = new DependencyGraph();
    graph.setCellFormula('A1', '=B1 + 1');
    graph.setCellFormula('B1', '=C1 + 1');
    graph.setCellFormula('C1', '=A1 + 1');

    expect(graph.hasCycle('A1')).toBe(true);
    expect(graph.hasCycle('B1')).toBe(true);

    const { hasCycle } = graph.getEvaluationOrder('A1');
    expect(hasCycle).toBe(true);
  });
});
