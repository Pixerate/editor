import { describe, it, expect, afterEach } from 'vitest';
import {
  FormulaEvaluator,
  applyFormulaSuggestion,
  checkFormulaArgumentCount,
  describeFormulaError,
  getFormulaArgumentSpecIndex,
  getFormulaCaretContext,
  getFormulaFunction,
  getFormulaHints,
  getFormulaSignature,
  getFormulaSignatureParts,
  listFormulaFunctions,
  registerFormulaFunction,
  searchFormulaFunctions,
  unregisterFormulaFunction,
} from '../src/spreadsheet/formula';
import { SpreadsheetController } from '../src/spreadsheet';

const diagnose = (formula: string, cells: Record<string, any> = {}) =>
  new FormulaEvaluator({
    resolveCell: (col, row) => cells[`${col}${row}`] ?? '',
    resolveRange: (sc, sr, ec, er) => {
      const out: any[] = [];
      for (let r = sr; r <= er; r++) out.push(cells[`${sc}${r}`] ?? '');
      return out;
    },
  }).evaluateWithDiagnostics(formula);

describe('formula function registry', () => {
  afterEach(() => {
    unregisterFormulaFunction('DOUBLE');
    unregisterFormulaFunction('MY.FN');
  });

  it('looks functions up case-insensitively with metadata', () => {
    const sumif = getFormulaFunction('sumif')!;
    expect(sumif.name).toBe('SUMIF');
    expect(sumif.category).toBe('math');
    expect(sumif.args.map((a) => a.name)).toEqual(['range', 'criteria', 'sum_range']);
    expect(sumif.args[2].optional).toBe(true);
    expect(getFormulaFunction('NOPE')).toBeUndefined();
  });

  it('lists functions by category, sorted', () => {
    const lookup = listFormulaFunctions('lookup').map((d) => d.name);
    expect(lookup).toEqual(['FILTER', 'HLOOKUP', 'INDEX', 'MATCH', 'SORT', 'SORTBY', 'TRANSPOSE', 'UNIQUE', 'VLOOKUP', 'XLOOKUP']);
    const all = listFormulaFunctions().map((d) => d.name);
    expect(all).toEqual([...all].sort());
    expect(all.length).toBeGreaterThanOrEqual(85);
  });

  it('searches prefix matches before substring matches', () => {
    const names = searchFormulaFunctions('count').map((d) => d.name);
    expect(names.slice(0, 5)).toEqual(['COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTIF', 'COUNTIFS']);
    expect(searchFormulaFunctions('IFS').map((d) => d.name)).toEqual(
      expect.arrayContaining(['IFS', 'SUMIFS', 'COUNTIFS', 'MAXIFS']),
    );
    expect(searchFormulaFunctions('IFS')[0].name).toBe('IFS');
    expect(searchFormulaFunctions('s', { limit: 3 })).toHaveLength(3);
    expect(searchFormulaFunctions('', { category: 'information' })).toHaveLength(5);
  });

  it('renders signatures with optional and repeating arguments', () => {
    expect(getFormulaSignature('SUMIF')).toBe('SUMIF(range, criteria, [sum_range])');
    expect(getFormulaSignature('SUM')).toBe('SUM(value1, [value2, ...])');
    expect(getFormulaSignature('SUMIFS')).toBe(
      'SUMIFS(sum_range, criteria_range1, criteria1, [criteria_range2, criteria2, ...])',
    );
    expect(getFormulaSignature('TEXTJOIN')).toBe('TEXTJOIN(delimiter, ignore_empty, text1, [text2, ...])');
    expect(getFormulaSignature('PI')).toBe('PI()');
    expect(getFormulaSignature('NOPE')).toBe('');
  });

  it('marks the active argument in signature parts', () => {
    const active = (name: string, index: number) =>
      getFormulaSignatureParts(name, index).find((p) => p.active)?.text;
    expect(active('SUMIF', 0)).toBe('range');
    expect(active('SUMIF', 2)).toBe('[sum_range]');
    expect(active('SUM', 0)).toBe('value1');
    expect(active('SUM', 5)).toBe('[value2');
    expect(active('SUMIFS', 2)).toBe('criteria1');
    expect(active('SUMIFS', 3)).toBe('[criteria_range2');
    expect(active('SUMIFS', 6)).toBe('criteria2');
    expect(active('ROUND', 4)).toBeUndefined();
    expect(getFormulaSignatureParts('IF').some((p) => p.active)).toBe(false);
  });

  it('maps call positions to argument specs', () => {
    const sumifs = getFormulaFunction('SUMIFS')!;
    expect(getFormulaArgumentSpecIndex(sumifs, 0)).toBe(0);
    expect(getFormulaArgumentSpecIndex(sumifs, 3)).toBe(1);
    expect(getFormulaArgumentSpecIndex(sumifs, 4)).toBe(2);
    expect(getFormulaArgumentSpecIndex(getFormulaFunction('ABS')!, 1)).toBe(-1);
  });

  it('validates argument counts', () => {
    expect(checkFormulaArgumentCount(getFormulaFunction('SUMIF')!, 1)).toBe(
      'SUMIF needs at least 2 arguments, but 1 was given.',
    );
    expect(checkFormulaArgumentCount(getFormulaFunction('ABS')!, 2)).toBe('ABS takes 1 argument, but 2 were given.');
    expect(checkFormulaArgumentCount(getFormulaFunction('PI')!, 1)).toBe('PI takes no arguments, but 1 was given.');
    expect(checkFormulaArgumentCount(getFormulaFunction('ROUND')!, 3)).toBe(
      'ROUND takes at most 2 arguments, but 3 were given.',
    );
    expect(checkFormulaArgumentCount(getFormulaFunction('SUMIFS')!, 4)).toMatch(/complete groups/);
    expect(checkFormulaArgumentCount(getFormulaFunction('SWITCH')!, 4)).toBeNull();
    expect(checkFormulaArgumentCount(getFormulaFunction('SUM')!, 0)).toBe('SUM needs at least 1 argument, but 0 were given.');
  });

  it('registers custom functions that use the context helpers', () => {
    registerFormulaFunction({
      name: 'double',
      category: 'math',
      description: 'Doubles a number.',
      args: [{ name: 'number', description: 'The number.', type: 'number' }],
      evaluate: (ctx) => {
        const n = ctx.number(0);
        return typeof n === 'number' ? n * 2 : n;
      },
    });
    expect(getFormulaFunction('DOUBLE')?.name).toBe('DOUBLE');
    expect(new FormulaEvaluator().evaluate('=DOUBLE(21)')).toBe(42);
    const result = new FormulaEvaluator().evaluateWithDiagnostics('=DOUBLE("x")');
    expect(result).toEqual({ value: '#VALUE!', error: '#VALUE!', message: 'Argument 1 of DOUBLE can\'t be text ("x").' });
    expect(searchFormulaFunctions('DOU').map((d) => d.name)).toContain('DOUBLE');

    expect(unregisterFormulaFunction('DOUBLE')).toBe(true);
    expect(new FormulaEvaluator().evaluate('=DOUBLE(21)')).toBe('#NAME?');
  });

  it('allows dotted names and rejects invalid ones', () => {
    registerFormulaFunction({ name: 'MY.FN', category: 'text', description: 'x', args: [], evaluate: () => 'ok' });
    expect(new FormulaEvaluator().evaluate('=MY.FN()')).toBe('ok');
    expect(() =>
      registerFormulaFunction({ name: '1BAD', category: 'text', description: 'x', args: [], evaluate: () => 1 }),
    ).toThrow(/Invalid formula function name/);
  });
});

describe('formula diagnostics', () => {
  it('explains unknown functions and names', () => {
    expect(diagnose('=FOO(1)')).toEqual({ value: '#NAME?', error: '#NAME?', message: 'Unknown function "FOO".' });
    expect(diagnose('=SUMM + 1').message).toBe('This formula contains an unknown name.');
  });

  it('explains wrong argument counts without throwing', () => {
    expect(diagnose('=IF(TRUE)')).toEqual({
      value: '#ERROR!',
      error: '#ERROR!',
      message: 'IF needs at least 2 arguments, but 1 was given.',
    });
    expect(diagnose('=TODAY(1)').message).toBe('TODAY takes no arguments, but 1 was given.');
  });

  it('gives argument-indexed type messages', () => {
    expect(diagnose('=ABS("x")').message).toBe('Argument 1 of ABS can\'t be text ("x").');
    expect(diagnose('=IF("maybe", 1, 2)').message).toBe('Argument 1 of IF must be TRUE or FALSE, not text ("maybe").');
    expect(diagnose('=COUNTIF(A1, 1)').message).toBe('Argument 1 of COUNTIF must be a range.');
    expect(diagnose('=YEAR("soon")').message).toBe('Argument 1 of YEAR ("soon") isn\'t a valid date.');
    expect(diagnose('=MOD(1, 0)').message).toBe("Argument 2 of MOD can't be zero.");
    expect(diagnose('=RANDBETWEEN(A1:A2, 5)', { A1: 1, A2: 2 }).message).toBe(
      'Argument 1 of RANDBETWEEN must be a single value, not a range.',
    );
  });

  it('explains operator errors and propagated errors', () => {
    expect(diagnose('=1/0').message).toBe('The formula divides by zero.');
    expect(diagnose('="x"*2').message).toBe('The * operator can\'t use text ("x").');
    expect(diagnose('=A1+1', { A1: '#DIV/0!' }).message).toBe('Cell A1 contains an error (#DIV/0!).');
    expect(diagnose('=SUM(A1:A2)', { A2: '#N/A' }).message).toBe('The range A1:A2 contains an error (#N/A).');
    expect(diagnose('=#REF!*10').message).toBe('This formula refers to a cell or range that was deleted.');
  });

  it('reports the reason for the error that reaches the result', () => {
    // The first error is caught by IFERROR; the reported reason belongs to the second.
    expect(diagnose('=IFERROR(1/0, 0) + FOO()').message).toBe('Unknown function "FOO".');
    expect(diagnose('=IFERROR(1/0, 0)')).toEqual({ value: 0 });
  });

  it('turns malformed formulas into #ERROR! with the parser message', () => {
    const result = diagnose('=SUM(1');
    expect(result.value).toBe('#ERROR!');
    expect(result.message).toMatch(/Expected '\)'/);
  });

  it('returns a range result as an array, with its first value as the value', () => {
    expect(diagnose('=A1:A2', { A1: 'first', A2: 'second' })).toEqual({
      value: 'first',
      array: { rows: 2, cols: 1, values: ['first', 'second'] },
    });
    expect(diagnose('=A1:A1', { A1: 'only' })).toEqual({ value: 'only' });
  });

  it('has a generic description for every error code', () => {
    expect(describeFormulaError('#DIV/0!')).toBe('The formula divides by zero.');
    expect(describeFormulaError('#WHAT')).toBe('The formula could not be evaluated.');
  });
});

describe('controller diagnostics', () => {
  function sheet() {
    const ctrl = new SpreadsheetController();
    const ids = (key: string) => {
      const [, col, row] = /^([A-Z]+)(\d+)$/.exec(key)!;
      const c = ctrl.document.columns.find((x) => x.key === col)!;
      const r = ctrl.document.rows[Number(row) - 1];
      return [r.id, c.id] as const;
    };
    return {
      ctrl,
      set: (key: string, raw: string) => ctrl.setCellValue(...ids(key), raw),
      cell: (key: string) => ctrl.getCell(...ids(key)),
    };
  }

  it('stores error codes and messages on cells and clears them when fixed', () => {
    const s = sheet();
    s.set('A1', '=SUMIF(5, ">1")');
    expect(s.cell('A1')).toMatchObject({
      value: '#VALUE!',
      error: '#VALUE!',
      errorMessage: 'Argument 1 of SUMIF must be a range.',
    });
    s.set('A1', '=1+1');
    expect(s.cell('A1').value).toBe(2);
    expect(s.cell('A1').error).toBeUndefined();
    expect(s.cell('A1').errorMessage).toBeUndefined();
  });

  it('keeps the message in `error` for #ERROR! cells, as before', () => {
    const s = sheet();
    s.set('A1', '=ROUND()');
    expect(s.cell('A1').value).toBe('#ERROR!');
    expect(s.cell('A1').error).toBe('ROUND needs at least 1 argument, but 0 were given.');
    expect(s.cell('A1').errorMessage).toBe(s.cell('A1').error);
  });

  it('explains self references and circular references', () => {
    const s = sheet();
    s.set('A1', '=A1+1');
    expect(s.cell('A1').errorMessage).toBe("This formula can't reference its own cell.");
    s.set('B1', '=SUM(B:B)');
    expect(s.cell('B1').errorMessage).toBe("This formula can't reference its own cell.");
    s.set('C1', '=D1');
    s.set('D1', '=C1');
    expect(s.cell('C1').errorMessage).toMatch(/circular reference/);
    expect(s.cell('D1').errorMessage).toMatch(/circular reference/);
    s.set('C2', '=C1*2');
    expect(s.cell('C2')).toMatchObject({ value: '#CYCLE!', errorMessage: 'Cell C1 is part of a circular reference.' });
    s.set('D1', '5');
    expect(s.cell('C1').value).toBe(5);
    expect(s.cell('C1').errorMessage).toBeUndefined();
  });

  it('evaluates lookups over typed cell values', () => {
    const s = sheet();
    s.set('A1', 'apple');
    s.set('B1', '3');
    s.set('A2', 'pear');
    s.set('B2', '5');
    s.set('C1', '=VLOOKUP("pear", A1:B2, 2, FALSE)');
    s.set('C2', '=XLOOKUP(5, B1:B2, A1:A2)');
    s.set('C3', '=SUMIF(A1:A2, "p*", B1:B2)');
    expect(s.cell('C1').value).toBe(5);
    expect(s.cell('C2').value).toBe('pear');
    expect(s.cell('C3').value).toBe(5);
  });
});

describe('formula caret context', () => {
  it('finds the function-name prefix at the caret', () => {
    expect(getFormulaCaretContext('=SU').prefix).toEqual({ text: 'SU', start: 1, end: 3 });
    expect(getFormulaCaretContext('=A1+co').prefix?.text).toBe('co');
    expect(getFormulaCaretContext('=SUM(A1:B').prefix).toBeNull();
    expect(getFormulaCaretContext('=$A').prefix).toBeNull();
    expect(getFormulaCaretContext('=1E5').prefix).toBeNull();
    expect(getFormulaCaretContext('="SU').prefix).toBeNull();
    expect(getFormulaCaretContext('SU').prefix).toBeNull();
    expect(getFormulaCaretContext('=SUM(1) ', 4).prefix).toEqual({ text: 'SUM', start: 1, end: 4 });
  });

  it('finds the innermost call and argument index', () => {
    expect(getFormulaCaretContext('=SUMIF(A1:A5, ').call).toEqual({ name: 'SUMIF', argIndex: 1, openParen: 6 });
    expect(getFormulaCaretContext('=IF(A1>0, SUM(1, 2').call).toMatchObject({ name: 'SUM', argIndex: 1 });
    expect(getFormulaCaretContext('=IF(A1>0, SUM(1, 2), ').call).toMatchObject({ name: 'IF', argIndex: 2 });
    // Grouping parentheses defer to the enclosing call.
    expect(getFormulaCaretContext('=ROUND((1+2').call).toMatchObject({ name: 'ROUND', argIndex: 0 });
    // Commas inside strings don't count; the call hint stays while typing a string.
    expect(getFormulaCaretContext('=TEXTJOIN(", ", TRUE, "a,b').call).toMatchObject({ name: 'TEXTJOIN', argIndex: 2 });
    expect(getFormulaCaretContext('=SUM(1)').call).toBeNull();
    expect(getFormulaCaretContext('=SUM(1)', 5).call).toMatchObject({ name: 'SUM', argIndex: 0 });
    expect(getFormulaCaretContext('=A1(').call).toBeNull();
  });

  it('builds hints: suggestions for a prefix and the active signature', () => {
    const hints = getFormulaHints('=SUMI');
    expect(hints.suggestions.map((s) => s.name)).toEqual(['SUMIF', 'SUMIFS']);
    expect(hints.suggestions[0]).toMatchObject({
      signature: 'SUMIF(range, criteria, [sum_range])',
      description: expect.any(String),
      category: 'math',
    });
    expect(hints.activeCall).toBeNull();

    const inCall = getFormulaHints('=SUMIF(A1:A5, ">3", ');
    expect(inCall.suggestions).toEqual([]);
    expect(inCall.activeCall).toMatchObject({ name: 'SUMIF', argIndex: 2, argument: { name: 'sum_range' } });
    expect(inCall.activeCall!.parts.find((p) => p.active)?.text).toBe('[sum_range]');

    // Typing a nested function shows both suggestions and the outer call.
    const nested = getFormulaHints('=IF(ISB');
    expect(nested.suggestions.map((s) => s.name)).toEqual(['ISBLANK']);
    expect(nested.activeCall?.name).toBe('IF');

    expect(getFormulaHints('=FOO(1, ').activeCall).toBeNull();
    expect(getFormulaHints('=S', 2, { limit: 2 }).suggestions).toHaveLength(2);
    expect(getFormulaHints('=SUM(', 4).suggestions).toEqual([]);
    expect(getFormulaHints('plain text').suggestions).toEqual([]);
  });

  it('applies a suggestion at the caret', () => {
    expect(applyFormulaSuggestion('=SU', 3, 'SUMIF')).toEqual({ value: '=SUMIF(', caret: 7 });
    expect(applyFormulaSuggestion('=A1+co*2', 6, 'COUNT')).toEqual({ value: '=A1+COUNT(*2', caret: 10 });
    expect(applyFormulaSuggestion('=SU(A1)', 3, 'SUM')).toEqual({ value: '=SUM(A1)', caret: 5 });
  });
});
