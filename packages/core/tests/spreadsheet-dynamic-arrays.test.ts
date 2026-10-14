import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpreadsheetController } from '../src/spreadsheet';
import {
  FormulaEvaluator,
  DependencyGraph,
  colNameToIndex,
  indexToColName,
  tokenizeFormula,
  parseFormula,
  shiftFormulaReferences,
  offsetFormulaReferences,
  remapFormulaReferences,
  getFormulaFunction,
} from '../src/spreadsheet/formula';
import { rebaseClipboardRows, readSpreadsheetClipboard, SPREADSHEET_CLIPBOARD_MIME } from '../src/spreadsheet/clipboard';

/** Helper addressing cells as A1-style keys. */
function sheet(ctrl = new SpreadsheetController()) {
  const pos = (key: string) => {
    const [, col, row] = /^([A-Z]+)(\d+)$/.exec(key)!;
    return { row: Number(row) - 1, col: colNameToIndex(col) };
  };
  const ids = (key: string) => {
    const { row, col } = pos(key);
    return [ctrl.document.rows[row].id, ctrl.document.columns[col].id] as const;
  };
  const cell = (key: string) => ctrl.getCell(...ids(key));
  return {
    ctrl,
    pos,
    set: (key: string, raw: string) => ctrl.setCellValue(...ids(key), raw),
    cell,
    value: (key: string) => cell(key).value,
    raw: (key: string) => cell(key).raw,
    error: (key: string) => cell(key).error,
    /** Values of a block as rows, e.g. block('A1:B2'). */
    block: (range: string) => {
      const [a, b] = range.split(':').map(pos);
      const out: any[][] = [];
      for (let r = a.row; r <= b.row; r++) {
        const line: any[] = [];
        for (let c = a.col; c <= b.col; c++) line.push(cell(`${indexToColName(c)}${r + 1}`).value);
        out.push(line);
      }
      return out;
    },
    spill: (key: string) => {
      const { row, col } = pos(key);
      return ctrl.getSpillAt(row, col);
    },
  };
}

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
const diagnose = (formula: string, cells: Record<string, any> = {}) => evaluator(cells).evaluateWithDiagnostics(formula);
/** Rows of a formula's array result (or [[value]] for a single value). */
function rowsOf(formula: string, cells: Record<string, any> = {}): any[][] {
  const result = diagnose(formula, cells);
  if (!result.array) return [[result.value]];
  const { rows, cols, values } = result.array;
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => values[c * rows + r]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dynamic arrays: spilling', () => {
  it('spills an array below and to the right of the anchor', () => {
    const s = sheet();
    s.set('A1', '=SEQUENCE(3, 2)');
    expect(s.block('A1:B3')).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(s.raw('A1')).toBe('=SEQUENCE(3, 2)');
    expect(s.raw('B2')).toBe('');
    expect(s.cell('B2').spillAnchor).toBe('A1');
    expect(s.cell('A1').spillAnchor).toBeUndefined();
    // Spilled values are not stored in the document.
    const [rowId, colId] = [s.ctrl.document.rows[1].id, s.ctrl.document.columns[1].id];
    expect(s.ctrl.document.cells[rowId]?.[colId]).toBeUndefined();
    expect(s.spill('B3')).toEqual({
      key: 'A1',
      anchor: { row: 0, col: 0 },
      range: { startRow: 0, startCol: 0, endRow: 2, endCol: 1 },
      formula: '=SEQUENCE(3, 2)',
    });
    expect(s.spill('C1')).toBeNull();
    expect(s.ctrl.getSpills()).toHaveLength(1);
  });

  it('spills a bare range reference and array arithmetic', () => {
    const s = sheet();
    s.set('A1', '1');
    s.set('A2', '2');
    s.set('A3', '3');
    s.set('B1', '=A1:A3');
    s.set('C1', '=A1:A3*2');
    expect(s.block('B1:C3')).toEqual([
      ['1', 2],
      ['2', 4],
      ['3', 6],
    ]);
  });

  it('grows and shrinks the spill as the array size changes, clearing old cells', () => {
    const s = sheet();
    s.set('B1', '2');
    s.set('A1', '=SEQUENCE(B1)');
    expect(s.block('A1:A4').flat()).toEqual([1, 2, '', '']);
    s.set('B1', '4');
    expect(s.block('A1:A4').flat()).toEqual([1, 2, 3, 4]);
    s.set('B1', '1');
    expect(s.block('A1:A4').flat()).toEqual([1, '', '', '']);
    expect(s.spill('A1')).toBeNull();
    expect(s.cell('A2').spillAnchor).toBeUndefined();
  });

  it('shows #SPILL! naming the blocking cell, and spills again once it is cleared', () => {
    const s = sheet();
    s.set('A3', 'x');
    s.set('A1', '=SEQUENCE(3)');
    expect(s.value('A1')).toBe('#SPILL!');
    expect(s.error('A1')).toBe('#SPILL!');
    expect(s.cell('A1').errorMessage).toBe("The result needs A1:A3, but A3 isn't empty.");
    expect(s.value('A2')).toBe('');
    s.set('A3', '');
    expect(s.value('A1')).toBe(1);
    expect(s.error('A1')).toBeUndefined();
    expect(s.block('A1:A3').flat()).toEqual([1, 2, 3]);
  });

  it('typing into a spilled cell blocks the array (#SPILL!) and deleting it restores the spill', () => {
    const s = sheet();
    s.set('A1', '=SEQUENCE(3)');
    s.set('A2', 'typed');
    expect(s.value('A1')).toBe('#SPILL!');
    expect(s.value('A2')).toBe('typed');
    expect(s.value('A3')).toBe('');
    s.set('A2', '');
    expect(s.block('A1:A3').flat()).toEqual([1, 2, 3]);
  });

  it('does not grow the grid: arrays past the edge of the sheet are #SPILL!', () => {
    const s = sheet();
    const rows = s.ctrl.document.rows.length;
    s.set('A9', '=SEQUENCE(5)');
    expect(s.value('A9')).toBe('#SPILL!');
    expect(s.cell('A9').errorMessage).toMatch(/past the edge of the sheet/);
    expect(s.ctrl.document.rows.length).toBe(rows);
  });

  it('refuses to spill into merged cells', () => {
    const s = sheet();
    s.ctrl.mergeCells({ startRow: 2, startCol: 0, endRow: 2, endCol: 1 });
    s.set('A1', '=SEQUENCE(4)');
    expect(s.value('A1')).toBe('#SPILL!');
    expect(s.cell('A1').errorMessage).toMatch(/merged cells/);
    s.ctrl.unmergeCells({ startRow: 2, startCol: 0, endRow: 2, endCol: 1 });
    expect(s.block('A1:A4').flat()).toEqual([1, 2, 3, 4]);
  });

  it('blocks an array that would overlap another spill', () => {
    const s = sheet();
    s.set('B1', '=SEQUENCE(3)');
    s.set('A2', '=SEQUENCE(1, 3)');
    expect(s.value('A2')).toBe('#SPILL!');
    expect(s.cell('A2').errorMessage).toBe('The result needs A2:C2, but B2 already holds values spilled from B1.');
    // Shrinking the first array frees the cell.
    s.set('B1', '=SEQUENCE(1)');
    expect(s.block('A2:C2').flat()).toEqual([1, 2, 3]);
  });

  it('recalculates dependents of spilled cells, including the first time the array spills', () => {
    const s = sheet();
    // C1 is evaluated before A1 spills (no dependency edge exists yet).
    s.ctrl.loadDocument({
      ...s.ctrl.document,
      cells: {
        [s.ctrl.document.rows[0].id]: {
          [s.ctrl.document.columns[2].id]: { raw: '=A2*10', value: '' },
          [s.ctrl.document.columns[0].id]: { raw: '=SEQUENCE(3)', value: '' },
        },
        [s.ctrl.document.rows[4].id]: { [s.ctrl.document.columns[2].id]: { raw: '=SUM(A1:A3)', value: '' } },
      },
    });
    expect(s.value('C1')).toBe(20);
    expect(s.value('C5')).toBe(6);
    s.set('A1', '=SEQUENCE(3, 1, 10)');
    expect(s.value('C1')).toBe(110);
    expect(s.value('C5')).toBe(33);
    // A dependent of a cell that stops being spilled sees a blank.
    s.set('A1', '=SEQUENCE(1)');
    expect(s.value('C1')).toBe(0);
  });

  it('feeds whole-column ranges and column formulas', () => {
    const s = sheet();
    s.set('B1', '=SUM(A:A)');
    s.set('A1', '=SEQUENCE(4)');
    expect(s.value('B1')).toBe(10);
    s.set('A1', '=SEQUENCE(2)');
    expect(s.value('B1')).toBe(3);
    // A formula column's cells are not empty: they block a spill.
    s.ctrl.insertColumn(3, { type: 'formula', formula: '=1' });
    s.set('C1', '=SEQUENCE(1, 2)');
    expect(s.value('C1')).toBe('#SPILL!');
  });

  it('recalculates the whole chain when an anchor input changes', () => {
    const s = sheet();
    s.set('B1', '5');
    s.set('A1', '=SEQUENCE(3, 1, B1)');
    s.set('C3', '=A3+1');
    s.set('D1', '=C3*2');
    expect(s.value('D1')).toBe(16);
    s.set('B1', '100');
    expect(s.value('C3')).toBe(103);
    expect(s.value('D1')).toBe(206);
  });

  it('detects cycles through a spill range', () => {
    const s = sheet();
    s.set('A1', '=SEQUENCE(2) + A2');
    expect(s.value('A1')).toBe('#CYCLE!');
    expect(s.cell('A1').errorMessage).toMatch(/A2, which holds its own spilled results/);
    expect(s.value('A2')).toBe('');
    // Fixing the formula restores the spill.
    s.set('A1', '=SEQUENCE(2) + B1');
    expect(s.block('A1:A2').flat()).toEqual([1, 2]);
  });

  it('clears the spill when the anchor is cleared or becomes a single value', () => {
    const s = sheet();
    s.set('A1', '=SEQUENCE(3)');
    s.set('A1', '=1+1');
    expect(s.block('A1:A3').flat()).toEqual([2, '', '']);
    s.set('A1', '=SEQUENCE(3)');
    s.set('A1', '');
    expect(s.block('A1:A3').flat()).toEqual(['', '', '']);
    expect(s.ctrl.getSpills()).toEqual([]);
  });

  it('keeps the top-left value on the anchor and shows error elements in spilled cells', () => {
    const s = sheet();
    s.set('B1', '0');
    s.set('B2', '2');
    s.set('A1', '=1/B1:B2');
    expect(s.value('A1')).toBe('#DIV/0!');
    expect(s.error('A1')).toBe('#DIV/0!');
    expect(s.value('A2')).toBe(0.5);
    s.set('B1', '4');
    s.set('B2', '0');
    expect(s.value('A1')).toBe(0.25);
    expect(s.value('A2')).toBe('#DIV/0!');
    expect(s.error('A2')).toBe('#DIV/0!');
  });

  it('spills INDEX with row/column 0 and XLOOKUP with a 2D return array', () => {
    const s = sheet();
    s.ctrl.importRows([
      ['Ann', '1', '2'],
      ['Bob', '3', '4'],
    ]);
    s.set('A5', '=INDEX(A1:C2, 0, 2)');
    expect(s.block('A5:A6').flat()).toEqual(['1', '3']);
    s.set('B5', '=XLOOKUP("Bob", A1:A2, B1:C2)');
    expect(s.block('B5:C5').flat()).toEqual(['3', '4']);
  });

  it('survives undo/redo', () => {
    const s = sheet();
    s.set('A1', '=SEQUENCE(2)');
    s.set('A1', '=SEQUENCE(3)');
    expect(s.block('A1:A3').flat()).toEqual([1, 2, 3]);
    s.ctrl.undo();
    expect(s.block('A1:A3').flat()).toEqual([1, 2, '']);
    s.ctrl.undo();
    expect(s.block('A1:A3').flat()).toEqual(['', '', '']);
    s.ctrl.redo();
    s.ctrl.redo();
    expect(s.block('A1:A3').flat()).toEqual([1, 2, 3]);
  });

  it('moves with structural edits, and # references follow the anchor', () => {
    const s = sheet();
    s.set('B1', '=SEQUENCE(3)');
    s.set('D1', '=SUM(B1#)');
    s.ctrl.insertColumn(0);
    expect(s.raw('C1')).toBe('=SEQUENCE(3)');
    expect(s.raw('E1')).toBe('=SUM(C1#)');
    expect(s.block('C1:C3').flat()).toEqual([1, 2, 3]);
    expect(s.value('E1')).toBe(6);
    s.ctrl.insertRow(0);
    expect(s.raw('E2')).toBe('=SUM(C2#)');
    expect(s.block('C2:C4').flat()).toEqual([1, 2, 3]);
    s.ctrl.deleteColumn(s.ctrl.document.columns[2].id);
    expect(s.raw('D2')).toBe('=SUM(#REF!)');
  });
});

describe('dynamic arrays: spill references (A1#)', () => {
  it('tokenizes and parses A1# without confusing it with error literals', () => {
    expect(tokenizeFormula('=SUM($A$1#)').map((t) => [t.type, t.value])).toEqual([
      ['IDENTIFIER', 'SUM'],
      ['LPAREN', '('],
      ['SPILL_REF', 'A1'],
      ['RPAREN', ')'],
      ['EOF', ''],
    ]);
    expect(parseFormula('=B2#')).toEqual({ type: 'SpillRef', ref: 'B2', col: 'B', row: 2 });
    expect(tokenizeFormula('=#SPILL!')[0]).toMatchObject({ type: 'ERROR', value: '#SPILL!' });
    expect(tokenizeFormula('=#CALC!')[0]).toMatchObject({ type: 'ERROR', value: '#CALC!' });
  });

  it('reads the whole spill range and follows its size', () => {
    const s = sheet();
    s.set('B1', '3');
    s.set('A1', '=SEQUENCE(B1)');
    s.set('C1', '=SUM(A1#)');
    s.set('D1', '=COUNT(A1#)');
    expect(s.value('C1')).toBe(6);
    expect(s.value('D1')).toBe(3);
    s.set('B1', '5');
    expect(s.value('C1')).toBe(15);
    expect(s.value('D1')).toBe(5);
  });

  it('spills a spill reference and array math on it', () => {
    const s = sheet();
    s.set('A1', '=SEQUENCE(2, 2)');
    s.set('C1', '=A1#*10');
    expect(s.block('C1:D2')).toEqual([
      [10, 20],
      [30, 40],
    ]);
  });

  it('is #REF! when the cell holds no array, and the anchor error when blocked', () => {
    const s = sheet();
    s.set('A1', '5');
    s.set('C1', '=SUM(A1#)');
    expect(s.value('C1')).toBe('#REF!');
    expect(s.cell('C1').errorMessage).toBe("A1# refers to A1, which doesn't hold a spilled array.");
    s.set('B2', 'x');
    s.set('B1', '=SEQUENCE(2)');
    s.set('C2', '=SUM(B1#)');
    expect(s.value('C2')).toBe('#SPILL!');
  });

  it('depends on the anchor in the dependency graph', () => {
    const graph = new DependencyGraph();
    graph.setCellFormula('C1', '=SUM(A1#)');
    expect(graph.getDependencies('C1')).toEqual(['A1']);
    graph.setSpillEdges('A1', ['A2', 'A3']);
    expect(graph.getDependents('A1').sort()).toEqual(['A2', 'A3', 'C1']);
    expect(graph.getDependencies('A2')).toEqual(['A1']);
    graph.setSpillEdges('A1', [], ['A2']);
    expect(graph.getDependencies('A1')).toEqual(['A2']);
    expect(graph.getDependencies('A2')).toEqual([]);
    graph.setSpillEdges('A1', []);
    expect(graph.getDependencies('A1')).toEqual([]);
  });

  it('rewrites spill references on insert/delete, offset and remap', () => {
    expect(shiftFormulaReferences('=SUM(B2#)+B2', { axis: 'row', index: 0, type: 'insert' })).toBe('=SUM(B3#)+B3');
    expect(shiftFormulaReferences('=SUM($B$2#)', { axis: 'col', index: 0, type: 'insert' })).toBe('=SUM($C$2#)');
    expect(shiftFormulaReferences('=SUM(B2#)', { axis: 'row', index: 1, type: 'delete' })).toBe('=SUM(#REF!)');
    expect(offsetFormulaReferences('=A1#*2', 2, 1)).toBe('=B3#*2');
    expect(offsetFormulaReferences('=$A$1#', 2, 1)).toBe('=$A$1#');
    expect(remapFormulaReferences('=A1#', ({ row, col }) => (row === 0 && col === 0 ? { row: 4, col: 2 } : null))).toBe(
      '=C5#',
    );
  });

  it('rebases # references in the clipboard JSON', () => {
    const s = sheet();
    s.set('A1', '=SEQUENCE(2)');
    s.set('B1', '=SUM(A1#)');
    const data = s.ctrl.copyToClipboardData({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    const parsed = readSpreadsheetClipboard(data)!;
    expect(parsed.rows).toEqual([
      ['=SEQUENCE(2)', '=SUM(A1#)'],
      ['', ''],
    ]);
    expect(rebaseClipboardRows(parsed.rows, parsed.origin!, { row: 3, col: 2 })[0]).toEqual(['=SEQUENCE(2)', '=SUM(C4#)']);
    s.ctrl.pasteClipboardData(data, { row: 3, col: 2 });
    expect(s.raw('D4')).toBe('=SUM(C4#)');
    expect(s.value('D4')).toBe(3);
    expect(s.block('C4:C5').flat()).toEqual([1, 2]);
  });
});

describe('dynamic arrays: table operations', () => {
  it('exports spilled values to CSV and TSV', () => {
    const s = sheet();
    s.set('A1', '=SEQUENCE(2, 2)');
    const range = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
    expect(s.ctrl.exportToCsv({ range })).toBe('1,2\r\n3,4');
    expect(s.ctrl.exportToCsv({ range, formulas: true })).toBe('"=SEQUENCE(2, 2)",\r\n,');
    expect(s.ctrl.exportToTsv(range)).toBe('1\t2\n3\t4');
  });

  it('copies spilled values as constants when the anchor is not copied', () => {
    const s = sheet();
    s.set('A1', '=SEQUENCE(3)');
    const data = s.ctrl.copyToClipboardData({ startRow: 1, startCol: 0, endRow: 2, endCol: 0 });
    const payload = JSON.parse(data[SPREADSHEET_CLIPBOARD_MIME]);
    expect(payload.cells).toEqual([[{ raw: '2', value: 2 }], [{ raw: '3', value: 3 }]]);
  });

  it('refuses to sort, merge or transpose ranges containing spills', () => {
    const s = sheet();
    s.set('B1', '9');
    s.set('B2', '1');
    s.set('A1', '=SEQUENCE(2)');
    const before = JSON.stringify(s.ctrl.document.cells);
    expect(s.ctrl.sortRows([{ colId: s.ctrl.document.columns[1].id }])).toBe(false);
    expect(s.ctrl.mergeCells({ startRow: 1, startCol: 0, endRow: 1, endCol: 1 })).toBe(false);
    expect(s.ctrl.transposeRange({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 })).toBe(false);
    expect(JSON.stringify(s.ctrl.document.cells)).toBe(before);
    // Ranges away from the spill still work.
    expect(s.ctrl.sortRows([{ colId: s.ctrl.document.columns[2].id }], { range: { startRow: 0, startCol: 2, endRow: 3, endCol: 3 } })).toBe(true);
  });

  it('does not autofill spilled values as constants', () => {
    const s = sheet();
    s.set('A1', '=SEQUENCE(1, 2)');
    s.ctrl.autofill({ startRow: 0, startCol: 1, endRow: 0, endCol: 1 }, { startRow: 0, startCol: 1, endRow: 2, endCol: 1 });
    expect(s.raw('B2')).toBe('');
    expect(s.raw('B3')).toBe('');
    expect(s.value('B1')).toBe(2);
  });

  it('filters and groups by spilled values (view model reads displayed values)', () => {
    const s = sheet();
    s.set('A1', '=SEQUENCE(4)');
    s.ctrl.addFilterRule({ colId: s.ctrl.document.columns[0].id, operator: 'greaterThan', value: 2 });
    const visible = s.ctrl.getViewModel().rowOrder;
    expect(visible.slice(0, 2)).toEqual([2, 3]);
  });
});

describe('dynamic array functions', () => {
  const DATA = {
    A1: 'Cid', B1: 7, C1: 'East',
    A2: 'Ann', B2: 10, C2: 'West',
    A3: 'Bob', B3: 25, C3: 'East',
    A4: 'ann', B4: '', C4: 'West',
  };

  it('FILTER rows, columns, if_empty and #CALC!', () => {
    expect(rowsOf('=FILTER(A1:B4, C1:C4="East")', DATA)).toEqual([
      ['Cid', 7],
      ['Bob', 25],
    ]);
    expect(rowsOf('=FILTER(A1:C1, A5:C5<>"x")', { ...DATA, B5: 'x' })).toEqual([['Cid', 'East']]);
    expect(rowsOf('=FILTER(A1:A4, B1:B4>8)', DATA)).toEqual([['Ann'], ['Bob']]);
    expect(diagnose('=FILTER(A1:A4, B1:B4>100, "none")', DATA).value).toBe('none');
    expect(diagnose('=FILTER(A1:A4, B1:B4>100)', DATA)).toMatchObject({
      value: '#CALC!',
      message: 'FILTER found no matching values.',
    });
    expect(diagnose('=FILTER(A1:A4, B1:B2>1)', DATA).message).toBe(
      'Argument 2 of FILTER must be a single column as tall as argument 1 (or a single row as wide).',
    );
  });

  it('SORT by column, descending, and by columns', () => {
    expect(rowsOf('=SORT(A1:A4)', DATA).flat()).toEqual(['Ann', 'ann', 'Bob', 'Cid']);
    expect(rowsOf('=SORT(A1:B4, 2, -1)', DATA)).toEqual([
      ['Bob', 25],
      ['Ann', 10],
      ['Cid', 7],
      ['ann', ''],
    ]);
    expect(rowsOf('=SORT(A1:C1, 1, 1, TRUE)', { A1: 3, B1: 1, C1: 2 })).toEqual([[1, 2, 3]]);
    expect(diagnose('=SORT(A1:B4, 3)', DATA).message).toBe('Argument 2 of SORT must be between 1 and 2.');
    expect(diagnose('=SORT(A1:B4, 1, 0)', DATA).message).toBe('Argument 3 of SORT must be 1 (ascending) or -1 (descending).');
  });

  it('SORTBY with several keys', () => {
    expect(rowsOf('=SORTBY(A1:A4, C1:C4, 1, B1:B4, -1)', DATA).flat()).toEqual(['Bob', 'Cid', 'Ann', 'ann']);
    expect(rowsOf('=SORTBY(A1:A4, B1:B4)', DATA).flat()).toEqual(['Cid', 'Ann', 'Bob', 'ann']);
    expect(diagnose('=SORTBY(A1:A4, B1:B2)', DATA).error).toBe('#VALUE!');
  });

  it('UNIQUE rows, case-insensitively, and exactly_once', () => {
    expect(rowsOf('=UNIQUE(C1:C4)', DATA).flat()).toEqual(['East', 'West']);
    expect(rowsOf('=UNIQUE(A1:A4)', DATA).flat()).toEqual(['Cid', 'Ann', 'Bob']);
    expect(rowsOf('=UNIQUE(A1:A4, FALSE, TRUE)', DATA).flat()).toEqual(['Cid', 'Bob']);
    expect(rowsOf('=UNIQUE(A1:C1, TRUE)', { A1: 1, B1: '1', C1: 2 })).toEqual([[1, 2]]);
    expect(diagnose('=UNIQUE(C1:C4, FALSE, TRUE)', DATA).error).toBe('#CALC!');
  });

  it('SEQUENCE', () => {
    expect(rowsOf('=SEQUENCE(2, 3)')).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(rowsOf('=SEQUENCE(3, 1, 10, -5)').flat()).toEqual([10, 5, 0]);
    expect(diagnose('=SEQUENCE(1)').value).toBe(1);
    expect(diagnose('=SEQUENCE(0)').error).toBe('#CALC!');
    expect(diagnose('=SEQUENCE(2000, 1000)').error).toBe('#NUM!');
  });

  it('TRANSPOSE', () => {
    expect(rowsOf('=TRANSPOSE(A1:B2)', { A1: 1, B1: 2, A2: 3, B2: 4 })).toEqual([
      [1, 3],
      [2, 4],
    ]);
    expect(rowsOf('=TRANSPOSE(SEQUENCE(3))')).toEqual([[1, 2, 3]]);
    expect(diagnose('=TRANSPOSE(5)').value).toBe(5);
  });

  it('RANDARRAY', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(rowsOf('=RANDARRAY(2, 2)')).toEqual([
      [0.5, 0.5],
      [0.5, 0.5],
    ]);
    expect(rowsOf('=RANDARRAY(1, 2, 1, 10, TRUE)')).toEqual([[6, 6]]);
    expect(diagnose('=RANDARRAY(1, 1, 5, 1)').error).toBe('#VALUE!');
    expect(getFormulaFunction('RANDARRAY')?.volatile).toBe(true);
  });

  it('array arithmetic broadcasts scalars, rows against columns, and pads with #N/A', () => {
    const cells = { A1: 1, A2: 2, B1: 10, C1: 20 };
    expect(rowsOf('=A1:A2+B1:C1', cells)).toEqual([
      [11, 21],
      [12, 22],
    ]);
    expect(rowsOf('=-A1:A2', cells).flat()).toEqual([-1, -2]);
    expect(rowsOf('=A1:A2>1', cells).flat()).toEqual([false, true]);
    expect(rowsOf('=A1:A2&"x"', cells).flat()).toEqual(['1x', '2x']);
    expect(rowsOf('=A1:A2+A1:A3', cells).flat()).toEqual([2, 4, '#N/A']);
    expect(rowsOf('=SEQUENCE(3)+SEQUENCE(2)').flat()).toEqual([2, 4, '#N/A']);
    expect(diagnose('=SUM(A1:A2*2)', cells).value).toBe(6);
  });

  it('lifts scalar functions over arrays (IF, LEN, IFERROR)', () => {
    const cells = { A1: 1, A2: 5, A3: 'abc' };
    expect(rowsOf('=IF(A1:A2>2, "big", "small")', cells).flat()).toEqual(['small', 'big']);
    expect(rowsOf('=LEN(A1:A3)', cells).flat()).toEqual([1, 1, 3]);
    expect(rowsOf('=IFERROR(1/(A1:A2-1), "x")', cells).flat()).toEqual(['x', 0.25]);
    expect(rowsOf('=ROUND(A1:A2/3, 1)', cells).flat()).toEqual([0.3, 1.7]);
    // Range arguments are not lifted: INDEX still reads the whole range.
    expect(diagnose('=INDEX(A1:A3, 2)', cells).value).toBe(5);
    // IF lifts on its condition only.
    expect(diagnose('=IF(TRUE, 1, A1:A2)', cells).value).toBe(1);
  });

  it('implicit intersection (@)', () => {
    const ev = new FormulaEvaluator({
      resolveCell: () => '',
      resolveRange: () => [10, 20, 30],
      getFormulaCell: () => ({ col: 'C', row: 2 }),
    });
    expect(ev.evaluate('=@A1:A3')).toBe(20);
    expect(ev.evaluate('=@A5:A7')).toBe('#VALUE!');
    expect(diagnose('=@SEQUENCE(3)').value).toBe(1);
    expect(diagnose('=@A1', { A1: 4 }).value).toBe(4);
  });

  it('LET names values', () => {
    expect(diagnose('=LET(x, 2, y, x*3, x+y)').value).toBe(8);
    expect(diagnose('=LET(x, A1, x*x)', { A1: 4 }).value).toBe(16);
    expect(rowsOf('=LET(s, SEQUENCE(3), s*s)').flat()).toEqual([1, 4, 9]);
    expect(diagnose('=LET(x, 1, LET(x, 2, x) + x)').value).toBe(3);
    expect(diagnose('=LET(x, 1, y)')).toMatchObject({ error: '#NAME?' });
    expect(diagnose('=LET(A1, 1, 2)').message).toBe("Argument 1 of LET must be a name (names can't look like cell references).");
    expect(diagnose('=LET(x, 1)').error).toBe('#ERROR!');
    expect(diagnose('=SUMM').value).toBe('#NAME?');
  });
});

describe('date arithmetic', () => {
  it('adds and subtracts days, keeping ISO text', () => {
    expect(diagnose('=DATE(2026, 1, 31) + 1').value).toBe('2026-02-01');
    expect(diagnose('=1 + DATE(2026, 1, 31)').value).toBe('2026-02-01');
    expect(diagnose('=A1 - 31', { A1: '2026-03-01' }).value).toBe('2026-01-29');
    expect(diagnose('=A1 + 1', { A1: '2026-03-01 09:30' }).value).toBe('2026-03-02 09:30:00');
    expect(diagnose('=A1 + 0.5', { A1: '2026-03-01' }).value).toBe('2026-03-01 12:00:00');
    // Crosses a DST change and a leap day.
    expect(diagnose('=A1 + 365', { A1: '2028-01-01' }).value).toBe('2028-12-31');
  });

  it('subtracts dates to count days', () => {
    expect(diagnose('=DATE(2026, 3, 1) - DATE(2026, 1, 1)').value).toBe(59);
    expect(diagnose('=A2 - A1', { A1: '2026-01-01', A2: '2026-01-02 12:00' }).value).toBe(1.5);
    expect(diagnose('=A1 + A1', { A1: '2026-01-01' }).error).toBe('#VALUE!');
    expect(diagnose('=5 - A1', { A1: '2026-01-01' }).error).toBe('#VALUE!');
    expect(diagnose('=A1 + "x"', { A1: '2026-01-01' }).error).toBe('#VALUE!');
  });

  it('leaves non-date text and other operators alone', () => {
    expect(diagnose('="2026-13-01" + 1').error).toBe('#VALUE!');
    expect(diagnose('="2026-01-01" * 2').error).toBe('#VALUE!');
    expect(diagnose('=DATE(2026, 1, 31)').value).toBe('2026-01-31');
  });

  it('compares dates chronologically', () => {
    expect(diagnose('=A1 < A2', { A1: '2026-1-5', A2: '2026-01-10' }).value).toBe(true);
    expect(diagnose('=A1 = A2', { A1: '2026-1-5', A2: '2026-01-05' }).value).toBe(true);
    expect(diagnose('=DATE(2026, 2, 1) > DATE(2026, 1, 31) + 0').value).toBe(true);
    expect(diagnose('=MAX(DAYS(A2, A1), 0)', { A1: '2026-01-01', A2: '2026-01-10' }).value).toBe(9);
  });

  it('works in the controller with spilled date arrays', () => {
    const s = sheet();
    s.set('A1', '2026-01-30');
    s.set('B1', '=A1 + SEQUENCE(3)');
    expect(s.block('B1:B3').flat()).toEqual(['2026-01-31', '2026-02-01', '2026-02-02']);
  });
});

describe('TRIM', () => {
  it('collapses inner runs of spaces like Excel', () => {
    expect(diagnose('=TRIM("  a    b  c ")').value).toBe('a b c');
    expect(diagnose('=TRIM(A1)', { A1: 'x\t\ty' }).value).toBe('x\t\ty');
  });
});
