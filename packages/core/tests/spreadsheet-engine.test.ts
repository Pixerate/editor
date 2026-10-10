import { describe, it, expect, vi } from 'vitest';
import { SpreadsheetController, type SpreadsheetDataSource } from '../src/spreadsheet';
import { FormulaEvaluator, shiftFormulaReferences, tokenizeFormula } from '../src/spreadsheet/formula';

/** Helper addressing cells as A1-style keys. */
function sheet(ctrl = new SpreadsheetController()) {
  const ids = (key: string) => {
    const [, col, row] = /^([A-Z]+)(\d+)$/.exec(key)!;
    const c = ctrl.document.columns.find((x) => x.key === col)!;
    const r = ctrl.document.rows[Number(row) - 1];
    return [r.id, c.id] as const;
  };
  return {
    ctrl,
    set: (key: string, raw: string) => ctrl.setCellValue(...ids(key), raw),
    value: (key: string) => ctrl.getCell(...ids(key)).value,
    raw: (key: string) => ctrl.getCell(...ids(key)).raw,
  };
}

describe('Spreadsheet engine: recalculation order and cycles', () => {
  it('evaluates loaded documents in dependency order', () => {
    const s = sheet();
    s.ctrl.loadDocument({
      ...s.ctrl.document,
      cells: {
        [s.ctrl.document.rows[0].id]: { [s.ctrl.document.columns[0].id]: { raw: '=A2*2', value: '' } },
        [s.ctrl.document.rows[1].id]: { [s.ctrl.document.columns[0].id]: { raw: '=3+1', value: '' } },
      },
    });
    expect(s.value('A1')).toBe(8);
  });

  it('marks every cell in a cycle and keeps them marked across recalculations', () => {
    const s = sheet();
    s.set('A1', '=B1+1');
    s.set('B1', '=A1+1');
    expect(s.value('A1')).toBe('#CYCLE!');
    expect(s.value('B1')).toBe('#CYCLE!');

    s.ctrl.insertColumn(3);
    expect(s.value('A1')).toBe('#CYCLE!');
    expect(s.value('B1')).toBe('#CYCLE!');
    s.ctrl.undo();
    expect(s.value('A1')).toBe('#CYCLE!');

    // Breaking the cycle recalculates the other member.
    s.set('B1', '5');
    expect(s.value('A1')).toBe(6);
  });

  it('propagates through cells that depend on a cycle', () => {
    const s = sheet();
    s.set('A1', '=A1');
    s.set('C1', '=A1*2');
    expect(s.value('A1')).toBe('#CYCLE!');
    expect(s.value('C1')).toBe('#CYCLE!');
  });

  it('recalculates long dependency chains without overflowing the stack', () => {
    const ctrl = new SpreadsheetController();
    const s = sheet(ctrl);
    ctrl.importFromTsv(
      ['1', ...Array.from({ length: 2999 }, (_, i) => `=A${i + 1}+1`)].join('\n'),
    );
    expect(s.value('A3000')).toBe(3000);
    s.set('A1', '10');
    expect(s.value('A3000')).toBe(3009);
  });
});

describe('Spreadsheet engine: structural edits rewrite references', () => {
  it('shifts references when a row is inserted above them', () => {
    const s = sheet();
    s.set('A2', '10');
    s.set('B1', '=A2*2');
    s.ctrl.insertRow(0);
    expect(s.raw('B2')).toBe('=A3*2');
    expect(s.value('B2')).toBe(20);
    s.set('A3', '7');
    expect(s.value('B2')).toBe(14);
  });

  it('turns references to deleted rows into #REF! and shrinks ranges', () => {
    const s = sheet();
    s.set('A1', '1');
    s.set('A2', '2');
    s.set('A3', '3');
    s.set('B1', '=A2*10');
    s.set('C1', '=SUM(A1:A3)');
    s.ctrl.deleteRow(s.ctrl.document.rows[1].id);
    expect(s.raw('B1')).toBe('=#REF!*10');
    expect(s.value('B1')).toBe('#REF!');
    expect(s.raw('C1')).toBe('=SUM(A1:A2)');
    expect(s.value('C1')).toBe(4);
  });

  it('shifts column references and keeps absolute markers', () => {
    const s = sheet();
    s.set('B1', '5');
    s.set('C1', '=$B$1+B1');
    s.ctrl.insertColumn(0);
    expect(s.raw('D1')).toBe('=$C$1+C1');
    expect(s.value('D1')).toBe(10);
    s.ctrl.deleteColumn(s.ctrl.document.columns[2].id);
    expect(s.raw('C1')).toBe('=#REF!+#REF!');
  });

  it('leaves strings, properties and function names alone', () => {
    const change = { axis: 'row' as const, index: 0, type: 'insert' as const };
    expect(shiftFormulaReferences('=CONCAT("A1", [A1], B2)', change)).toBe('=CONCAT("A1", [A1], B3)');
    expect(shiftFormulaReferences('=LOG10(A1)', change)).toBe('=LOG10(A2)');
    expect(shiftFormulaReferences('=SUM(A:A)', change)).toBe('=SUM(A:A)');
    expect(shiftFormulaReferences('plain A1', change)).toBe('plain A1');
  });
});

describe('Spreadsheet engine: [property] references', () => {
  it('resolves against the row being evaluated, not the active cell', () => {
    const records = [
      { id: 'r1', hours: 2 },
      { id: 'r2', hours: 5 },
    ];
    const ds: SpreadsheetDataSource = {
      id: 'tasks',
      name: 'Tasks',
      getRecords: () => records,
      getFields: () => [{ key: 'hours', label: 'Hours', type: 'number' }],
      updateRecord: () => {},
    };
    const ctrl = new SpreadsheetController({
      dataSources: [ds],
      primaryDataSourceId: 'tasks',
      document: {
        columns: [{ id: 'cost', key: 'A', title: 'Cost', type: 'formula', formula: '=[hours]*10' }],
      },
    });
    ctrl.selectCell(1, 0);
    ctrl.recalculateAll();
    const values = ctrl.document.rows.map((r) => ctrl.getCell(r.id, 'cost').value);
    expect(values).toEqual([20, 50]);
  });
});

describe('Spreadsheet engine: formula semantics', () => {
  const evaluate = (formula: string, cells: Record<string, any> = {}) =>
    new FormulaEvaluator({
      resolveCell: (col, row) => cells[`${col}${row}`] ?? '',
      resolveRange: (sc, sr, ec, er) => {
        const out: any[] = [];
        for (let r = sr; r <= Math.min(er, 20); r++) {
          for (const c of [sc, ec].filter((v, i, a) => a.indexOf(v) === i)) out.push(cells[`${c}${r}`] ?? '');
        }
        return out;
      },
    }).evaluate(formula);

  it('propagates errors through operators and functions', () => {
    expect(evaluate('=1/0+1')).toBe('#DIV/0!');
    expect(evaluate('=SUM(A1, 2)', { A1: '#REF!' })).toBe('#REF!');
    expect(evaluate('="x"*2')).toBe('#VALUE!');
  });

  it('returns #NAME? for unknown names and functions', () => {
    expect(evaluate('=SUMM')).toBe('#NAME?');
    expect(evaluate('=NOPE(1)')).toBe('#NAME?');
  });

  it('rejects malformed formulas instead of guessing', () => {
    expect(() => tokenizeFormula('="unterminated')).toThrow(/Unterminated string/);
    expect(() => tokenizeFormula('=1 ~ 2')).toThrow(/Unexpected character/);
  });

  it('supports absolute ranges and whole-column ranges in the controller', () => {
    const s = sheet();
    s.set('A1', '1');
    s.set('A2', '2');
    s.set('B1', '3');
    s.set('B2', '4');
    s.set('C1', '=SUM($A$1:$B$2)');
    s.set('D1', '=SUM(A:A)');
    expect(s.value('C1')).toBe(10);
    expect(s.value('D1')).toBe(3);
    s.set('A5', '10');
    expect(s.value('D1')).toBe(13);
  });

  it('detects whole-column self references as cycles', () => {
    const s = sheet();
    s.set('A1', '=SUM(A:A)');
    expect(s.value('A1')).toBe('#CYCLE!');
  });

  it('handles large MIN/MAX ranges without overflowing the stack', () => {
    const big = Array.from({ length: 200000 }, (_, i) => i);
    const evaluator = new FormulaEvaluator({ resolveRange: () => big });
    expect(evaluator.evaluate('=MAX(A1:A200000)')).toBe(199999);
    expect(evaluator.evaluate('=MIN(A1:A200000)')).toBe(0);
  });

  it('rounds half away from zero without floating point drift', () => {
    expect(evaluate('=ROUND(-2.5)')).toBe(-3);
    expect(evaluate('=ROUND(2.5)')).toBe(3);
    expect(evaluate('=ROUND(1.005, 2)')).toBe(1.01);
    expect(evaluate('=ROUND(1234, -2)')).toBe(1200);
  });

  it('uses spreadsheet truthiness and typed comparisons', () => {
    expect(evaluate('=IF("FALSE", 1, 2)')).toBe(2);
    expect(evaluate('=IF("yes", 1, 2)')).toBe('#VALUE!');
    expect(evaluate('="1"=1')).toBe(false);
    expect(evaluate('="abc"="ABC"')).toBe(true);
    expect(evaluate('=A1=0', {})).toBe(true);
  });

  it('treats blank cells as empty text in concatenation and 0 in arithmetic', () => {
    expect(evaluate('=""&A1')).toBe('');
    expect(evaluate('=A1+5')).toBe(5);
  });

  it('returns the local date from TODAY', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 1, 0, 30)); // local midnight + 30min
      expect(evaluate('=TODAY()')).toBe('2026-01-01');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Spreadsheet engine: TSV import', () => {
  it('imports as a single undo step, keeps leading empty cells, and reports commits', () => {
    const onCellCommit = vi.fn();
    const s = sheet(new SpreadsheetController({ onCellCommit }));
    s.set('A1', 'before');
    onCellCommit.mockClear();

    s.ctrl.importFromTsv('\tB\r\n=B1&"!"\t2\n');
    expect(s.value('A1')).toBe('');
    expect(s.value('B1')).toBe('B');
    expect(s.value('A2')).toBe('B!');
    expect(onCellCommit).toHaveBeenCalledWith(expect.any(String), expect.any(String), '=B1&"!"', 'B!');

    s.ctrl.undo();
    expect(s.value('A1')).toBe('before');
    expect(s.value('B1')).toBe('');
  });
});
