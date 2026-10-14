// Cases re-expressed from gridcraft/crates/calc/src/tests.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import {
  FormulaEvaluator,
  MAX_LAMBDA_DEPTH,
  getFormulaFunction,
  parseFormula,
  type EvaluationContext,
  type FormulaNameDefinition,
} from '../src/spreadsheet/formula';

/** An evaluator over a small sheet of cells (`A1` → value) and defined names. */
function evaluator(cells: Record<string, any> = {}, names: Record<string, string> = {}): FormulaEvaluator {
  const context: EvaluationContext = {
    resolveCell: (col, row) => cells[`${col}${row}`] ?? '',
    resolveRange: (sc, sr, ec, er) => {
      const out: any[] = [];
      for (let c = sc.charCodeAt(0); c <= ec.charCodeAt(0); c++) {
        for (let r = sr; r <= er; r++) out.push(cells[`${String.fromCharCode(c)}${r}`] ?? '');
      }
      return out;
    },
    resolveName: (name): FormulaNameDefinition | null => {
      const key = Object.keys(names).find((n) => n.toUpperCase() === name.toUpperCase());
      return key ? { formula: names[key], key } : null;
    },
  };
  return new FormulaEvaluator(context);
}

const run = (formula: string, cells?: Record<string, any>, names?: Record<string, string>) =>
  evaluator(cells, names).evaluateWithDiagnostics(formula);
const value = (formula: string, cells?: Record<string, any>, names?: Record<string, string>) =>
  run(formula, cells, names).value;
const array = (formula: string, cells?: Record<string, any>, names?: Record<string, string>) =>
  run(formula, cells, names).array;

describe('LET and LAMBDA', () => {
  it('evaluates LET, inline LAMBDA calls and LAMBDA helpers (gridcraft let_lambda)', () => {
    expect(value('=LET(x,2,y,3,x*y)')).toBe(6);
    expect(value('=LAMBDA(a,b,a+b)(2,3)')).toBe(5);
    expect(value('=REDUCE(0,A1:A3,LAMBDA(acc,v,acc+v))', { A1: 1, A2: 2, A3: 3 })).toBe(6);
    expect(value('=SUM(MAP(A1:A3,LAMBDA(v,v*v)))', { A1: 1, A2: 2, A3: 3 })).toBe(14);
  });

  it('parses calls of computed functions', () => {
    expect(parseFormula('=LAMBDA(x,x+1)(2)')).toMatchObject({ type: 'Invoke', callee: { type: 'FunctionCall', name: 'LAMBDA' } });
    expect(value('=(LAMBDA(x,x*10))(4)')).toBe(40);
    // Curried: a lambda returning a lambda.
    expect(value('=LAMBDA(a,LAMBDA(b,a-b))(10)(3)')).toBe(7);
  });

  it('binds lambdas in LET and calls them by name', () => {
    expect(value('=LET(f,LAMBDA(x,x*2),f(3)+f(4))')).toBe(14);
    expect(value('=LET(double,LAMBDA(x,x*2),quad,LAMBDA(x,double(double(x))),quad(5))')).toBe(20);
  });

  it('scopes lambdas lexically (closures capture their definition, not their caller)', () => {
    expect(value('=LET(k,10,f,LAMBDA(x,x+k),LET(k,1000,f(1)))')).toBe(11);
    // Parameters shadow outer variables.
    expect(value('=LET(x,5,LAMBDA(x,x*2)(1))')).toBe(2);
    // LET values see earlier names; inner LET shadows outer.
    expect(value('=LET(a,1,b,a+1,LET(a,10,a+b))')).toBe(12);
    // Variables don't leak out of a LET.
    expect(value('=LET(x,1,x)+x')).toBe('#NAME?');
  });

  it('checks argument counts and omitted arguments (gridcraft lambda_argument_count)', () => {
    const omit = 'LAMBDA(x,y,IF(ISOMITTED(y),"Missing",x+y))';
    expect(value('=LAMBDA(a,b,a+b)(2)')).toBe('#VALUE!');
    expect(value('=LAMBDA(a,b,a+b)(2,3,4)')).toBe('#VALUE!');
    expect(value(`=${omit}(1,)`)).toBe('Missing');
    expect(value(`=${omit}(1)`)).toBe('#VALUE!');
    expect(value(`=${omit}(1,2)`)).toBe(3);
    expect(value('=LAMBDA(7)()')).toBe(7);
    expect(value('=LAMBDA(x,ISOMITTED(x))()')).toBe(true);
    // A blank cell passed explicitly is not omitted.
    expect(value('=LAMBDA(x,ISOMITTED(x))(A9)')).toBe(false);
    const names = { AddPair: '=LAMBDA(a,b,a+b)' };
    expect(value('=AddPair(2)', {}, names)).toBe('#VALUE!');
    expect(value('=AddPair(2,3)', {}, names)).toBe(5);
  });

  it('shows #CALC! for an uncalled lambda and #VALUE! for misuse', () => {
    const result = run('=LAMBDA(x,x+1)');
    expect(result.value).toBe('#CALC!');
    expect(result.message).toMatch(/without calling it/);
    expect(value('=LAMBDA(x,x)+1')).toBe('#VALUE!');
    expect(value('=LAMBDA(A1,A1)(1)')).toBe('#VALUE!');
    expect(value('=LAMBDA(x,x,x)(1,2)')).toBe('#VALUE!');
    expect(value('=LET(x,5,x(1))')).toBe('#VALUE!');
    expect(value('=(1+2)(3)')).toBe('#VALUE!');
  });

  it('recurses through named lambdas, capped with #NUM!', () => {
    const names = {
      Fact: '=LAMBDA(n,IF(n<=1,1,n*Fact(n-1)))',
      Loop: '=LAMBDA(n,Loop(n+1))',
      Fib: '=LAMBDA(n,IF(n<2,n,Fib(n-1)+Fib(n-2)))',
    };
    expect(value('=Fact(10)', {}, names)).toBe(3628800);
    expect(value('=Fib(15)', {}, names)).toBe(610);
    expect(value('=Fact(50)', {}, names)).toBeCloseTo(3.0414093201713376e64, -50);
    const loop = run('=Loop(1)', {}, names);
    expect(loop.value).toBe('#NUM!');
    expect(MAX_LAMBDA_DEPTH).toBeGreaterThanOrEqual(100);
  });

  it('reports a name that refers to itself', () => {
    expect(value('=Self', {}, { Self: '=Self+1' })).toBe('#CYCLE!');
  });
});

describe('LAMBDA helper functions', () => {
  const grid = { A1: 1, A2: 2, A3: 3, B1: 10, B2: 20, B3: 30 };

  it('MAP maps one or more arrays element by element', () => {
    expect(array('=MAP(A1:A3,LAMBDA(v,v*2))', grid)).toEqual({ rows: 3, cols: 1, values: [2, 4, 6] });
    expect(array('=MAP(A1:A3,B1:B3,LAMBDA(a,b,a+b))', grid)?.values).toEqual([11, 22, 33]);
    expect(value('=MAP(A1:A3,LAMBDA(a,b,a+b))', grid)).toBe('#VALUE!');
    // A lambda returning an array for one element is #CALC! there.
    expect(array('=MAP(A1:A2,LAMBDA(v,A1:A3))', grid)?.values).toEqual(['#CALC!', '#CALC!']);
  });

  it('REDUCE and SCAN fold row by row', () => {
    expect(value('=REDUCE(,A1:B3,LAMBDA(a,v,a+v))', grid)).toBe(66);
    // Row-major order: 1,10,2,20,3,30.
    expect(value('=REDUCE("",A1:B3,LAMBDA(a,v,a&v&","))', grid)).toBe('1,10,2,20,3,30,');
    expect(array('=SCAN(0,A1:A3,LAMBDA(a,v,a+v))', grid)?.values).toEqual([1, 3, 6]);
    expect(array('=SCAN(0,A1:B2,LAMBDA(a,v,a+v))', grid)).toEqual({ rows: 2, cols: 2, values: [1, 13, 11, 33] });
    expect(value('=REDUCE(0,A1:A3,LAMBDA(a,a))', grid)).toBe('#VALUE!');
  });

  it('BYROW and BYCOL pass whole rows and columns', () => {
    expect(array('=BYROW(A1:B3,LAMBDA(r,SUM(r)))', grid)).toEqual({ rows: 3, cols: 1, values: [11, 22, 33] });
    expect(array('=BYCOL(A1:B3,LAMBDA(c,MAX(c)))', grid)).toEqual({ rows: 1, cols: 2, values: [3, 30] });
    expect(array('=BYROW(A1:B2,LAMBDA(r,r*2))', grid)?.values).toEqual(['#CALC!', '#CALC!']);
  });

  it('accepts built-in functions by name (gridcraft functions_given_by_name)', () => {
    const cells = { B1: 1, B2: -2, B3: 3 };
    expect(array('=BYROW(B1:B3,SUM)', cells)?.values).toEqual([1, -2, 3]);
    expect(array('=MAP(B1:B3,ABS)', cells)?.values).toEqual([1, 2, 3]);
    expect(value('=REDUCE(0,B1:B3,SUM)', cells)).toBe(2);
    // A LET variable of that name is still the variable.
    expect(value('=LET(ABS,LAMBDA(x,x*10),SUM(MAP(B1:B3,ABS)))', cells)).toBe(20);
  });

  it('MAKEARRAY builds arrays from row and column numbers', () => {
    expect(array('=MAKEARRAY(2,3,LAMBDA(r,c,r*10+c))')).toEqual({ rows: 2, cols: 3, values: [11, 21, 12, 22, 13, 23] });
    expect(value('=MAKEARRAY(0,3,LAMBDA(r,c,1))')).toBe('#VALUE!');
    expect(value('=MAKEARRAY(2,2,LAMBDA(r,r))')).toBe('#VALUE!');
    expect(value('=MAKEARRAY(1,1,LAMBDA(r,c,r+c))')).toBe(2);
  });

  it('are listed with signatures for autocomplete', () => {
    for (const name of ['LAMBDA', 'MAP', 'REDUCE', 'SCAN', 'BYROW', 'BYCOL', 'MAKEARRAY', 'ISOMITTED', 'LET']) {
      expect(getFormulaFunction(name)?.category).toBe('logical');
    }
  });
});
