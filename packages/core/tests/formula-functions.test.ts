import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  FormulaEvaluator,
  colNameToIndex,
  indexToColName,
  listFormulaFunctions,
  parseCriteria,
  wildcardToRegExp,
  formatValueWithCode,
} from '../src/spreadsheet/formula';

/** Evaluator over a sparse grid; ranges are resolved column-major, like the controller. */
function evaluator(cells: Record<string, any> = {}) {
  return new FormulaEvaluator({
    resolveCell: (col, row) => cells[`${col}${row}`] ?? '',
    resolveRange: (sc, sr, ec, er) => {
      const out: any[] = [];
      for (let c = colNameToIndex(sc); c <= colNameToIndex(ec); c++) {
        for (let r = sr; r <= er; r++) out.push(cells[`${indexToColName(c)}${r}`] ?? '');
      }
      return out;
    },
  });
}

const run = (formula: string, cells: Record<string, any> = {}) => evaluator(cells).evaluate(formula);
const diagnose = (formula: string, cells: Record<string, any> = {}) => evaluator(cells).evaluateWithDiagnostics(formula);

/** A small sales table in A1:D6 (header row 1). Typed cell values are text, as in the controller. */
const SALES: Record<string, any> = {
  A1: 'Region', B1: 'Rep', C1: 'Units', D1: 'Date',
  A2: 'East', B2: 'Ann', C2: '10', D2: '2026-01-05',
  A3: 'West', B3: 'Bob', C3: '25', D3: '2026-01-12',
  A4: 'East', B4: 'Cid', C4: '7', D4: '2026-02-01',
  A5: 'North', B5: 'Dee', C5: '', D5: '2026-02-14',
  A6: 'east', B6: 'Eve', C6: 30, D6: '2026-03-01',
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('criteria matching', () => {
  it('matches numbers, numeric text and comparison operators', () => {
    expect(parseCriteria(5)(5)).toBe(true);
    expect(parseCriteria(5)('5')).toBe(true);
    expect(parseCriteria('>5')(6)).toBe(true);
    expect(parseCriteria('>5')('6')).toBe(true);
    expect(parseCriteria('>5')(5)).toBe(false);
    expect(parseCriteria('>=5')(5)).toBe(true);
    expect(parseCriteria('<5')('abc')).toBe(false);
    expect(parseCriteria('<=0')('')).toBe(false);
    expect(parseCriteria('<>5')(4)).toBe(true);
    expect(parseCriteria('<>5')(5)).toBe(false);
    expect(parseCriteria('=5')('5')).toBe(true);
  });

  it('matches text case-insensitively with wildcards', () => {
    expect(parseCriteria('east')('East')).toBe(true);
    expect(parseCriteria('=a')('A')).toBe(true);
    expect(parseCriteria('<>x')('y')).toBe(true);
    expect(parseCriteria('<>x')('X')).toBe(false);
    expect(parseCriteria('<>x')('')).toBe(true);
    expect(parseCriteria('a*')('apple')).toBe(true);
    expect(parseCriteria('a*')('banana')).toBe(false);
    expect(parseCriteria('?ob')('Bob')).toBe(true);
    expect(parseCriteria('?ob')('Boob')).toBe(false);
    expect(parseCriteria('<>a*')('apple')).toBe(false);
    expect(parseCriteria('~*')('*')).toBe(true);
    expect(parseCriteria('~*')('x')).toBe(false);
    expect(parseCriteria('>m')('zebra')).toBe(true);
    expect(parseCriteria('>m')('apple')).toBe(false);
  });

  it('matches blanks and non-blanks', () => {
    expect(parseCriteria('')('')).toBe(true);
    expect(parseCriteria('')('x')).toBe(false);
    expect(parseCriteria('=')('')).toBe(true);
    expect(parseCriteria('<>')('x')).toBe(true);
    expect(parseCriteria('<>')('')).toBe(false);
  });

  it('matches booleans and never matches errors', () => {
    expect(parseCriteria(true)(true)).toBe(true);
    expect(parseCriteria('TRUE')(true)).toBe(true);
    expect(parseCriteria('<>1')('#DIV/0!')).toBe(false);
    expect(parseCriteria('*')('#N/A')).toBe(false);
    expect(parseCriteria('#N/A')('#N/A')).toBe(true);
  });

  it('builds anchored wildcard regular expressions', () => {
    expect(wildcardToRegExp('a.b*').test('A.Bcd')).toBe(true);
    expect(wildcardToRegExp('a.b*').test('axb')).toBe(false);
  });
});

describe('conditional aggregates', () => {
  it('SUMIF / COUNTIF / AVERAGEIF with and without a separate range', () => {
    expect(run('=SUMIF(A2:A6, "east", C2:C6)', SALES)).toBe(47);
    expect(run('=SUMIF(C2:C6, ">8")', SALES)).toBe(65);
    expect(run('=COUNTIF(A2:A6, "East")', SALES)).toBe(3);
    expect(run('=COUNTIF(B2:B6, "?ob")', SALES)).toBe(1);
    expect(run('=COUNTIF(C2:C6, "")', SALES)).toBe(1);
    expect(run('=COUNTIF(C2:C6, "<>")', SALES)).toBe(4);
    expect(run('=AVERAGEIF(A2:A6, "East", C2:C6)', SALES)).toBeCloseTo(47 / 3);
    expect(run('=AVERAGEIF(A2:A6, "South", C2:C6)', SALES)).toBe('#DIV/0!');
  });

  it('SUMIFS / COUNTIFS / AVERAGEIFS / MAXIFS / MINIFS combine criteria', () => {
    expect(run('=SUMIFS(C2:C6, A2:A6, "east", D2:D6, "<2026-02-15")', SALES)).toBe(17);
    expect(run('=COUNTIFS(A2:A6, "east", C2:C6, ">=10")', SALES)).toBe(2);
    expect(run('=AVERAGEIFS(C2:C6, A2:A6, "east")', SALES)).toBeCloseTo(47 / 3);
    expect(run('=MAXIFS(C2:C6, A2:A6, "east")', SALES)).toBe(30);
    expect(run('=MINIFS(C2:C6, A2:A6, "east")', SALES)).toBe(7);
    expect(run('=MAXIFS(C2:C6, A2:A6, "south")', SALES)).toBe(0);
  });

  it('uses cell values as criteria', () => {
    expect(run('=COUNTIF(A2:A6, A2)', SALES)).toBe(3);
    expect(run('=SUMIF(A2:A6, "<>"&A2, C2:C6)', SALES)).toBe(25);
  });

  it('rejects mismatched range sizes and non-range arguments', () => {
    const size = diagnose('=SUMIFS(C2:C6, A2:A5, "east")', SALES);
    expect(size.value).toBe('#VALUE!');
    expect(size.message).toBe('Argument 2 of SUMIFS must be the same size as argument 1 (5×1).');
    const notRange = diagnose('=SUMIF(5, ">1")');
    expect(notRange.value).toBe('#VALUE!');
    expect(notRange.message).toBe('Argument 1 of SUMIF must be a range.');
  });

  it('propagates errors from matched cells', () => {
    expect(run('=SUMIF(A1:A2, "x", B1:B2)', { A1: 'x', B1: '#DIV/0!', A2: 'y', B2: 1 })).toBe('#DIV/0!');
    expect(run('=SUMIF(A1:A2, "y", B1:B2)', { A1: 'x', B1: '#DIV/0!', A2: 'y', B2: 1 })).toBe(1);
  });
});

describe('logical functions', () => {
  it('IFERROR / IFNA', () => {
    expect(run('=IFERROR(1/0, "oops")')).toBe('oops');
    expect(run('=IFERROR(5, "oops")')).toBe(5);
    expect(run('=IFNA(MATCH("zz", A1:A3, 0), "none")', { A1: 'a' })).toBe('none');
    expect(run('=IFNA(1/0, "none")')).toBe('#DIV/0!');
  });

  it('IFERROR does not evaluate the fallback when not needed', () => {
    const e = new FormulaEvaluator({ resolveCell: vi.fn(() => 1) });
    e.evaluate('=IFERROR(1, A1)');
    expect(e['context'].resolveCell).not.toHaveBeenCalled();
  });

  it('AND / OR / XOR / NOT', () => {
    expect(run('=AND(TRUE, 1, "TRUE")')).toBe(true);
    expect(run('=AND(TRUE, 0)')).toBe(false);
    expect(run('=OR(FALSE, 0, 1>0)')).toBe(true);
    expect(run('=XOR(TRUE, TRUE, TRUE)')).toBe(true);
    expect(run('=XOR(TRUE, TRUE)')).toBe(false);
    expect(run('=NOT(1=1)')).toBe(false);
    // Ranges skip blanks and text; direct text is an error.
    expect(run('=AND(A1:A3)', { A1: true, A2: 'note', A3: '' })).toBe(true);
    expect(run('=AND("maybe")')).toBe('#VALUE!');
    expect(run('=OR(A1:A2)', {})).toBe('#VALUE!');
  });

  it('IFS / SWITCH', () => {
    expect(run('=IFS(A1>90, "A", A1>80, "B", TRUE, "C")', { A1: 85 })).toBe('B');
    expect(run('=IFS(A1>90, "A")', { A1: 5 })).toBe('#N/A');
    expect(run('=SWITCH(A1, 1, "one", 2, "two", "many")', { A1: '2' })).toBe('two');
    expect(run('=SWITCH(A1, 1, "one", 2, "two", "many")', { A1: 7 })).toBe('many');
    expect(run('=SWITCH("b", "A", 1, "B", 2)')).toBe(2);
    expect(run('=SWITCH(3, 1, "one")')).toBe('#N/A');
  });

  it('keeps IF semantics', () => {
    expect(run('=IF(1>2, "yes")')).toBe(false);
    expect(run('=IF(1<2, "yes", 1/0)')).toBe('yes');
  });
});

describe('lookup functions', () => {
  it('VLOOKUP exact, approximate and wildcard', () => {
    expect(run('=VLOOKUP("Bob", B2:D6, 2, FALSE)', SALES)).toBe('25');
    expect(run('=VLOOKUP("b*", B2:D6, 3, FALSE)', SALES)).toBe('2026-01-12');
    expect(run('=VLOOKUP("Zed", B2:D6, 2, FALSE)', SALES)).toBe('#N/A');
    const grades = { A1: 0, B1: 'F', A2: 60, B2: 'D', A3: 70, B3: 'C', A4: 80, B4: 'B', A5: 90, B5: 'A' };
    expect(run('=VLOOKUP(85, A1:B5, 2)', grades)).toBe('B');
    expect(run('=VLOOKUP(90, A1:B5, 2, TRUE)', grades)).toBe('A');
    expect(run('=VLOOKUP(-1, A1:B5, 2)', grades)).toBe('#N/A');
  });

  it('VLOOKUP column index errors', () => {
    const tooBig = diagnose('=VLOOKUP("Bob", B2:D6, 4, FALSE)', SALES);
    expect(tooBig.value).toBe('#REF!');
    expect(tooBig.message).toBe('Argument 3 of VLOOKUP is larger than the number of columns in the table (3).');
    expect(run('=VLOOKUP("Bob", B2:D6, 0, FALSE)', SALES)).toBe('#VALUE!');
  });

  it('HLOOKUP', () => {
    expect(run('=HLOOKUP("Units", A1:D3, 3, FALSE)', SALES)).toBe('25');
    expect(run('=HLOOKUP("Nope", A1:D3, 2, FALSE)', SALES)).toBe('#N/A');
  });

  it('MATCH with every match type', () => {
    expect(run('=MATCH("Cid", B1:B6, 0)', SALES)).toBe(4);
    expect(run('=MATCH("c*", B1:B6, 0)', SALES)).toBe(4);
    expect(run('=MATCH(25, C2:C4, 0)', SALES)).toBe(2);
    const asc = { A1: 1, A2: 3, A3: 5, A4: 7 };
    expect(run('=MATCH(6, A1:A4)', asc)).toBe(3);
    expect(run('=MATCH(0, A1:A4, 1)', asc)).toBe('#N/A');
    const desc = { A1: 7, A2: 5, A3: 3, A4: 1 };
    expect(run('=MATCH(4, A1:A4, -1)', desc)).toBe(2);
    expect(run('=MATCH(1, A1:B2, 0)', asc)).toBe('#N/A');
    expect(diagnose('=MATCH(1, A1:B2, 0)', asc).message).toBe('Argument 2 of MATCH must be a single row or column.');
  });

  it('INDEX by row/column, vectors, whole rows/columns and bounds', () => {
    expect(run('=INDEX(A1:D6, 3, 2)', SALES)).toBe('Bob');
    expect(run('=INDEX(B1:B6, 4)', SALES)).toBe('Cid');
    expect(run('=INDEX(A1:D1, 3)', SALES)).toBe('Units');
    expect(run('=SUM(INDEX(A2:C6, 0, 3))', SALES)).toBe(72);
    expect(run('=CONCAT(INDEX(A2:C3, 2, 0))', SALES)).toBe('WestBob25');
    expect(run('=INDEX(A1:B2, 3, 1)', SALES)).toBe('#REF!');
    expect(diagnose('=INDEX(A1:B2, 1, 5)', SALES).message).toBe('Argument 3 of INDEX is outside the range (1 to 2).');
    expect(run('=INDEX(B2:B6, MATCH("Dee", B2:B6, 0))', SALES)).toBe('Dee');
  });

  it('XLOOKUP match modes, search modes and if_not_found', () => {
    expect(run('=XLOOKUP("Dee", B2:B6, A2:A6)', SALES)).toBe('North');
    expect(run('=XLOOKUP("Zed", B2:B6, A2:A6, "missing")', SALES)).toBe('missing');
    expect(run('=XLOOKUP("Zed", B2:B6, A2:A6)', SALES)).toBe('#N/A');
    expect(run('=XLOOKUP("east", A2:A6, B2:B6, , 0, -1)'.replace(', ,', ', "", '), SALES)).toBe('Eve');
    expect(run('=XLOOKUP("e*", A2:A6, B2:B6, "", 2)', SALES)).toBe('Ann');
    const prices = { A1: 10, A2: 20, A3: 30, B1: 'S', B2: 'M', B3: 'L' };
    expect(run('=XLOOKUP(25, A1:A3, B1:B3, "", -1)', prices)).toBe('M');
    expect(run('=XLOOKUP(25, A1:A3, B1:B3, "", 1)', prices)).toBe('L');
    expect(run('=XLOOKUP(25, A1:A3, B1:B3)', prices)).toBe('#N/A');
    // Horizontal lookup and a 2D return array (whole row, shown as first value).
    expect(run('=XLOOKUP("Rep", A1:D1, A2:D2)', SALES)).toBe('Ann');
    expect(run('=CONCAT(XLOOKUP("Bob", B2:B6, A2:D6))', SALES)).toBe('WestBob252026-01-12');
    expect(diagnose('=XLOOKUP("Bob", B2:B6, A2:A4)', SALES).message).toBe(
      'Argument 3 of XLOOKUP must be the same height (or width) as argument 2.',
    );
  });
});

describe('text functions', () => {
  it('LEFT / RIGHT / MID', () => {
    expect(run('=LEFT("Spreadsheet", 6)')).toBe('Spread');
    expect(run('=LEFT("abc")')).toBe('a');
    expect(run('=RIGHT("Spreadsheet", 5)')).toBe('sheet');
    expect(run('=RIGHT("abc", 0)')).toBe('');
    expect(run('=MID("Spreadsheet", 7, 3)')).toBe('she');
    expect(run('=MID("abc", 5, 2)')).toBe('');
    expect(run('=LEFT("abc", -1)')).toBe('#VALUE!');
    expect(run('=MID("abc", 0, 1)')).toBe('#VALUE!');
  });

  it('FIND is case-sensitive; SEARCH is not and supports wildcards', () => {
    expect(run('=FIND("s", "Spreadsheets")')).toBe(7);
    expect(run('=FIND("S", "Spreadsheets")')).toBe(1);
    expect(run('=FIND("s", "Spreadsheets", 8)')).toBe(12);
    expect(run('=FIND("z", "abc")')).toBe('#VALUE!');
    expect(run('=SEARCH("s", "Spreadsheets")')).toBe(1);
    expect(run('=SEARCH("d?h", "Spreadsheets")')).toBe(6);
    expect(run('=SEARCH("e*t", "Spreadsheets")')).toBe(4);
  });

  it('SUBSTITUTE / REPLACE / REPT', () => {
    expect(run('=SUBSTITUTE("a-b-c", "-", "+")')).toBe('a+b+c');
    expect(run('=SUBSTITUTE("a-b-c", "-", "+", 2)')).toBe('a-b+c');
    expect(run('=SUBSTITUTE("a-b-c", "-", "+", 5)')).toBe('a-b-c');
    expect(run('=REPLACE("abcdef", 2, 3, "XY")')).toBe('aXYef');
    expect(run('=REPT("ab", 3)')).toBe('ababab');
    expect(run('=REPT("ab", 0)')).toBe('');
  });

  it('TEXTJOIN / CONCAT / PROPER / EXACT', () => {
    expect(run('=TEXTJOIN(", ", TRUE, A1:A3, "x")', { A1: 'a', A3: 'c' })).toBe('a, c, x');
    expect(run('=TEXTJOIN("-", FALSE, A1:A3)', { A1: 'a', A3: 'c' })).toBe('a--c');
    expect(run('=CONCAT("a", 1, TRUE)')).toBe('a1TRUE');
    expect(run('=PROPER("hello wORLD-wide")')).toBe('Hello World-Wide');
    expect(run('=EXACT("abc", "abc")')).toBe(true);
    expect(run('=EXACT("abc", "ABC")')).toBe(false);
  });

  it('keeps UPPER / LOWER / TRIM / LEN behaviour', () => {
    expect(run('=UPPER("abc")')).toBe('ABC');
    expect(run('=LOWER("ABC")')).toBe('abc');
    expect(run('=TRIM("  a b  ")')).toBe('a b');
    expect(run('=LEN(A1)', { A1: 'four' })).toBe(4);
  });

  it('VALUE parses numeric text', () => {
    expect(run('=VALUE("1,234.5")')).toBe(1234.5);
    expect(run('=VALUE("50%")')).toBe(0.5);
    expect(run('=VALUE("$12")')).toBe(12);
    expect(run('=VALUE("(3)")')).toBe(-3);
    expect(run('=VALUE("2026-01-01")')).toBe(46023);
    expect(run('=VALUE(A1)', { A1: '' })).toBe(0);
    const bad = diagnose('=VALUE("abc")');
    expect(bad.value).toBe('#VALUE!');
    expect(bad.message).toBe('Argument 1 of VALUE ("abc") can\'t be converted to a number.');
  });

  it('TEXT formats numbers', () => {
    expect(run('=TEXT(1234.567, "0.00")')).toBe('1234.57');
    expect(run('=TEXT(1234.567, "#,##0")')).toBe('1,235');
    expect(run('=TEXT(1234.5, "#,##0.00")')).toBe('1,234.50');
    expect(run('=TEXT(0.256, "0%")')).toBe('26%');
    expect(run('=TEXT(0.256, "0.0%")')).toBe('25.6%');
    expect(run('=TEXT(1234.5, "$#,##0.00")')).toBe('$1,234.50');
    expect(run('=TEXT(-5, "0.0")')).toBe('-5.0');
    expect(run('=TEXT(-5, "0;(0)")')).toBe('(5)');
    expect(run('=TEXT(7, "000")')).toBe('007');
    expect(run('=TEXT(0.5, "#.##")')).toBe('.5');
    expect(run('=TEXT(12345, "0.00E+00")')).toBe('1.23E+04');
    expect(run('=TEXT(3, "0 \\"kg\\"")')).toBe('3 kg');
    expect(run('=TEXT("abc", "0.00")')).toBe('abc');
  });

  it('TEXT formats dates', () => {
    expect(run('=TEXT("2026-03-05", "yyyy-mm-dd")')).toBe('2026-03-05');
    expect(run('=TEXT("2026-03-05", "dd/mm/yy")')).toBe('05/03/26');
    expect(run('=TEXT("2026-03-05", "mmm d, yyyy")')).toBe('Mar 5, 2026');
    expect(run('=TEXT("2026-03-05", "dddd")')).toBe('Thursday');
    expect(run('=TEXT("2026-03-05", "mmmm")')).toBe('March');
    expect(run('=TEXT("2026-03-05 14:07:09", "hh:mm:ss")')).toBe('14:07:09');
    expect(run('=TEXT("2026-03-05 14:07:09", "h:mm AM/PM")')).toBe('2:07 PM');
    expect(run('=TEXT(46023, "yyyy-mm-dd")')).toBe('2026-01-01');
    // Like Excel, text that isn't a number or date passes through unchanged.
    expect(run('=TEXT("nope", "yyyy")')).toBe('nope');
    expect(run('=TEXT(-1, "yyyy")')).toBe('#VALUE!');
    expect(run('=TEXT(1.5, "# ?/?")')).toBe('1 1/2');
    expect(run('=TEXT(-5, "#,##0.00;[Red](#,##0.00)")')).toBe('(5.00)');
    expect(run('=TEXT(2.675, "0.00")')).toBe('2.68');
  });

  it('formatValueWithCode is exported for reuse', () => {
    expect(formatValueWithCode(1.5, '0.00')).toBe('1.50');
  });
});

describe('math functions', () => {
  it('rounding family', () => {
    expect(run('=ROUNDUP(3.141, 2)')).toBe(3.15);
    expect(run('=ROUNDUP(-3.141, 1)')).toBe(-3.2);
    expect(run('=ROUNDUP(0.1*3, 1)')).toBe(0.3);
    expect(run('=ROUNDDOWN(3.149, 2)')).toBe(3.14);
    expect(run('=ROUNDDOWN(-3.19, 1)')).toBe(-3.1);
    expect(run('=ROUNDUP(1234, -2)')).toBe(1300);
    expect(run('=INT(-1.5)')).toBe(-2);
    expect(run('=INT(1.9)')).toBe(1);
    expect(run('=CEILING(2.1)')).toBe(3);
    expect(run('=CEILING(2.1, 0.5)')).toBe(2.5);
    expect(run('=CEILING(-2.5, 2)')).toBe(-2);
    expect(run('=CEILING(-2.5, -2)')).toBe(-4);
    expect(run('=CEILING(2.5, -1)')).toBe('#NUM!');
    expect(run('=FLOOR(2.9)')).toBe(2);
    expect(run('=FLOOR(7, 5)')).toBe(5);
    expect(run('=FLOOR(-2.5, 2)')).toBe(-4);
    expect(run('=FLOOR(3, 0)')).toBe('#DIV/0!');
  });

  it('MOD / POWER / SQRT / SIGN / PRODUCT / PI', () => {
    expect(run('=MOD(10, 3)')).toBe(1);
    expect(run('=MOD(-3, 2)')).toBe(1);
    expect(run('=MOD(3, -2)')).toBe(-1);
    expect(run('=MOD(5.5, 1)')).toBe(0.5);
    expect(run('=MOD(1, 0)')).toBe('#DIV/0!');
    expect(run('=POWER(2, 10)')).toBe(1024);
    expect(run('=POWER(0, -1)')).toBe('#DIV/0!');
    expect(run('=POWER(-8, 0.5)')).toBe('#NUM!');
    expect(run('=SQRT(16)')).toBe(4);
    expect(run('=SQRT(-1)')).toBe('#NUM!');
    expect(run('=SIGN(-3)')).toBe(-1);
    expect(run('=SIGN(0)')).toBe(0);
    expect(run('=PRODUCT(A1:A3, 2)', { A1: '2', A2: 'x', A3: 3 })).toBe(12);
    expect(run('=PRODUCT(A1:A2)', {})).toBe(0);
    expect(run('=PI()')).toBeCloseTo(3.14159265);
  });

  it('RAND / RANDBETWEEN', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(run('=RAND()')).toBe(0.999);
    expect(run('=RANDBETWEEN(1, 6)')).toBe(6);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(run('=RANDBETWEEN(1, 6)')).toBe(1);
    expect(run('=RANDBETWEEN(6, 1)')).toBe('#NUM!');
  });

  it('keeps SUM / ROUND / ABS behaviour', () => {
    expect(run('=SUM(A1:A3, "x", 4)', { A1: '1', A2: 'text', A3: 2 })).toBe(7);
    expect(run('=ROUND(2.5)')).toBe(3);
    expect(run('=ABS(-4)')).toBe(4);
  });
});

describe('statistical functions', () => {
  const data = { A1: 2, A2: 4, A3: '4', A4: 4, A5: 5, A6: 5, A7: 7, A8: 9, A9: 'x', A10: '' };

  it('MEDIAN / MODE / STDEV / VAR', () => {
    expect(run('=MEDIAN(A1:A10)', data)).toBe(4.5);
    expect(run('=MEDIAN(1, 3, 2)')).toBe(2);
    expect(run('=MEDIAN(A9:A10)', data)).toBe('#NUM!');
    expect(run('=MODE(A1:A10)', data)).toBe(4);
    expect(run('=MODE(1, 2, 2, 1)')).toBe(1);
    expect(run('=MODE(1, 2, 3)')).toBe('#N/A');
    expect(run('=VAR(A1:A10)', data)).toBeCloseTo(32 / 7);
    expect(run('=STDEV(A1:A10)', data)).toBeCloseTo(Math.sqrt(32 / 7));
    expect(run('=STDEV(1)')).toBe('#DIV/0!');
  });

  it('LARGE / SMALL / RANK', () => {
    expect(run('=LARGE(A1:A10, 1)', data)).toBe(9);
    expect(run('=LARGE(A1:A10, 2)', data)).toBe(7);
    expect(run('=SMALL(A1:A10, 2)', data)).toBe(4);
    expect(run('=SMALL(A1:A10, 9)', data)).toBe('#NUM!');
    expect(run('=RANK(7, A1:A10)', data)).toBe(2);
    expect(run('=RANK(4, A1:A10)', data)).toBe(5);
    expect(run('=RANK(4, A1:A10, 1)', data)).toBe(2);
    expect(run('=RANK(3, A1:A10)', data)).toBe('#N/A');
  });

  it('COUNTBLANK and the original aggregates', () => {
    expect(run('=COUNTBLANK(A1:A12)', data)).toBe(3);
    expect(run('=COUNT(A1:A10)', data)).toBe(8);
    expect(run('=COUNTA(A1:A10)', data)).toBe(9);
    expect(run('=AVERAGE(1, 2, 3)')).toBe(2);
    expect(run('=MIN(A1:A10)', data)).toBe(2);
    expect(run('=MAX(A1:A10)', data)).toBe(9);
  });
});

describe('date functions', () => {
  it('DATE / YEAR / MONTH / DAY', () => {
    expect(run('=DATE(2026, 1, 31)')).toBe('2026-01-31');
    expect(run('=DATE(2026, 13, 1)')).toBe('2027-01-01');
    expect(run('=DATE(2026, 3, 0)')).toBe('2026-02-28');
    expect(run('=DATE(99, 1, 1)')).toBe('1999-01-01');
    expect(run('=YEAR("2026-07-04")')).toBe(2026);
    expect(run('=MONTH(A1)', { A1: '2026-07-04' })).toBe(7);
    expect(run('=DAY(DATE(2026, 2, 29))')).toBe(1);
    expect(run('=YEAR(46023)')).toBe(2026);
    expect(run('=YEAR("not a date")')).toBe('#VALUE!');
    expect(run('=YEAR("2026-02-30")')).toBe('#VALUE!');
  });

  it('WEEKDAY', () => {
    // 2026-03-01 is a Sunday.
    expect(run('=WEEKDAY("2026-03-01")')).toBe(1);
    expect(run('=WEEKDAY("2026-03-01", 2)')).toBe(7);
    expect(run('=WEEKDAY("2026-03-02", 2)')).toBe(1);
    expect(run('=WEEKDAY("2026-03-02", 3)')).toBe(0);
    expect(run('=WEEKDAY("2026-03-02", 9)')).toBe('#NUM!');
  });

  it('EDATE / EOMONTH', () => {
    expect(run('=EDATE("2026-01-31", 1)')).toBe('2026-02-28');
    expect(run('=EDATE("2026-03-15", -3)')).toBe('2025-12-15');
    expect(run('=EOMONTH("2026-01-15", 0)')).toBe('2026-01-31');
    expect(run('=EOMONTH("2024-01-15", 1)')).toBe('2024-02-29');
    expect(run('=EOMONTH("2026-01-15", -1)')).toBe('2025-12-31');
  });

  it('NETWORKDAYS', () => {
    // Mon 2026-03-02 .. Fri 2026-03-13 = 10 working days.
    expect(run('=NETWORKDAYS("2026-03-02", "2026-03-13")')).toBe(10);
    expect(run('=NETWORKDAYS("2026-03-13", "2026-03-02")')).toBe(-10);
    expect(run('=NETWORKDAYS("2026-03-02", "2026-03-13", A1:A2)', { A1: '2026-03-04', A2: '2026-03-07' })).toBe(9);
    expect(run('=NETWORKDAYS("2026-03-07", "2026-03-08")')).toBe(0);
  });

  it('DATEDIF and DAYS', () => {
    expect(run('=DATEDIF("2020-05-15", "2026-03-10", "Y")')).toBe(5);
    expect(run('=DATEDIF("2020-05-15", "2026-03-10", "M")')).toBe(69);
    expect(run('=DATEDIF("2026-01-01", "2026-03-01", "D")')).toBe(59);
    expect(run('=DATEDIF("2020-05-15", "2026-03-10", "YM")')).toBe(9);
    expect(run('=DATEDIF("2020-05-15", "2026-03-10", "MD")')).toBe(23);
    expect(run('=DATEDIF("2020-05-15", "2026-03-10", "YD")')).toBe(299);
    expect(run('=DATEDIF("2026-03-10", "2020-05-15", "Y")')).toBe('#NUM!');
    expect(run('=DATEDIF("2020-05-15", "2026-03-10", "Q")')).toBe('#NUM!');
    expect(run('=DAYS("2026-03-01", "2026-01-01")')).toBe(59);
  });

  it('NOW and TODAY use the local clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 6, 7, 8, 9));
    expect(run('=NOW()')).toBe('2026-05-06 07:08:09');
    expect(run('=TODAY()')).toBe('2026-05-06');
    expect(run('=YEAR(NOW())')).toBe(2026);
  });
});

describe('information functions', () => {
  it('IS* functions', () => {
    expect(run('=ISBLANK(A1)')).toBe(true);
    expect(run('=ISBLANK(A1)', { A1: 'x' })).toBe(false);
    expect(run('=ISNUMBER(A1)', { A1: '12' })).toBe(true);
    expect(run('=ISNUMBER(A1)', { A1: 'twelve' })).toBe(false);
    expect(run('=ISTEXT(A1)', { A1: 'twelve' })).toBe(true);
    expect(run('=ISTEXT(5)')).toBe(false);
    expect(run('=ISERROR(1/0)')).toBe(true);
    expect(run('=ISERROR(1)')).toBe(false);
    expect(run('=ISNA(MATCH(9, A1:A2, 0))')).toBe(true);
    expect(run('=ISNA(1/0)')).toBe(false);
  });
});

describe('function coverage', () => {
  it('registers every required function with metadata', () => {
    const required =
      'ABS AVERAGE CONCAT COUNT COUNTA DAYS IF LEN LOWER MAX MIN ROUND SUM TODAY TRIM UPPER IFERROR IFNA AND OR NOT XOR IFS SWITCH SUMIF SUMIFS COUNTIF COUNTIFS AVERAGEIF AVERAGEIFS MAXIFS MINIFS COUNTBLANK INDEX MATCH XLOOKUP VLOOKUP HLOOKUP LEFT RIGHT MID FIND SEARCH SUBSTITUTE REPLACE REPT TEXTJOIN PROPER EXACT VALUE TEXT ROUNDUP ROUNDDOWN INT MOD POWER SQRT PRODUCT MEDIAN MODE STDEV VAR LARGE SMALL RANK CEILING FLOOR SIGN PI RAND RANDBETWEEN NOW DATE YEAR MONTH DAY WEEKDAY EDATE EOMONTH NETWORKDAYS DATEDIF ISBLANK ISNUMBER ISTEXT ISERROR ISNA'.split(' ');
    const names = new Set(listFormulaFunctions().map((def) => def.name));
    for (const name of required) expect(names, name).toContain(name);
    for (const def of listFormulaFunctions()) {
      expect(def.description, def.name).not.toBe('');
      for (const a of def.args) expect(a.description, `${def.name}.${a.name}`).not.toBe('');
    }
  });
});
