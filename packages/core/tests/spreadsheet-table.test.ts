import { describe, it, expect } from 'vitest';
import {
  SpreadsheetController,
  compareCellValues,
  computeFillTarget,
  fillSeries,
  getSpreadsheetMenuItems,
  clampMenuPosition,
  matchesFilterRule,
  offsetFormulaReferences,
  remapFormulaReferences,
  aggregateValues,
  type FilterRule
} from '../src/spreadsheet';

/** A controller whose cells are filled from `grid` (row-major raw inputs). */
function sheet(grid: string[][], rows = Math.max(grid.length, 1), cols = 4) {
  const ctrl = new SpreadsheetController({
    document: {
      columns: Array.from({ length: cols }, (_, i) => ({
        id: `c${i}`,
        key: String.fromCharCode(65 + i),
        title: String.fromCharCode(65 + i),
        type: 'freeform' as const
      })),
      rows: Array.from({ length: rows }, (_, i) => ({ id: `r${i}`, index: i, type: 'freeform' as const }))
    }
  });
  grid.forEach((line, r) => line.forEach((raw, c) => raw !== '' && ctrl.setCellValue(`r${r}`, `c${c}`, raw)));
  return ctrl;
}

const raw = (ctrl: SpreadsheetController, r: number, c: number) =>
  ctrl.getCell(ctrl.document.rows[r].id, ctrl.document.columns[c].id).raw;
const value = (ctrl: SpreadsheetController, r: number, c: number) =>
  ctrl.getCell(ctrl.document.rows[r].id, ctrl.document.columns[c].id).value;
const column = (ctrl: SpreadsheetController, c: number) =>
  ctrl.document.rows.map((_, r) => raw(ctrl, r, c));
const visibleRows = (ctrl: SpreadsheetController) => ctrl.getViewModel().rowOrder;

describe('formula reference helpers', () => {
  it('offsets relative parts and keeps $-absolute parts', () => {
    expect(offsetFormulaReferences('=A1+$B$2+C$3+$D4', 2, 1)).toBe('=B3+$B$2+D$3+$D6');
    expect(offsetFormulaReferences('=SUM(A1:B2)', 1, 0)).toBe('=SUM(A2:B3)');
    expect(offsetFormulaReferences('=SUM(A:A)', 5, 1)).toBe('=SUM(B:B)');
    expect(offsetFormulaReferences('=A1', -1, 0)).toBe('=#REF!');
    // Strings and function names are untouched.
    expect(offsetFormulaReferences('="A1"&LOG10(A1)', 1, 0)).toBe('="A1"&LOG10(A2)');
  });

  it('remaps references to moved cells, and ranges only when they move as a block', () => {
    const swapRows = ({ row, col }: { row: number; col: number }) =>
      row === 0 ? { row: 1, col } : row === 1 ? { row: 0, col } : null;
    expect(remapFormulaReferences('=A1+$B$2', swapRows)).toBe('=A2+$B$1');
    // A one-row range inside a moved row follows it.
    expect(remapFormulaReferences('=SUM(A1:C1)', swapRows)).toBe('=SUM(A2:C2)');
    // A range over both swapped rows still covers the same cells.
    expect(remapFormulaReferences('=SUM(A1:A2)', swapRows)).toBe('=SUM(A1:A2)');
    expect(remapFormulaReferences('=SUM(A1:A3)', swapRows)).toBe('=SUM(A1:A3)');
  });
});

describe('sort', () => {
  it('compares numbers before text, blanks last in both directions', () => {
    const values = ['b', '', '10', 'A', '2', null];
    expect([...values].sort((a, b) => compareCellValues(a, b, 'asc'))).toEqual(['2', '10', 'A', 'b', '', null]);
    expect([...values].sort((a, b) => compareCellValues(a, b, 'desc'))).toEqual(['b', 'A', '10', '2', '', null]);
  });

  it('sorts whole rows stably, keeps header/footer rows, and is undoable', () => {
    const ctrl = sheet([['Name', 'Score'], ['b', '2'], ['a', '1'], ['c', '1'], ['', '9'], ['Total', '=SUM(B2:B5)']]);
    ctrl.setHeaderRowCount(1);
    ctrl.setFooterRowCount(1);
    const ids = ctrl.document.rows.map((r) => r.id);

    expect(ctrl.sortRows([{ colId: 'c1' }])).toBe(true);
    expect(column(ctrl, 0)).toEqual(['Name', 'a', 'c', 'b', '', 'Total']);
    expect(ctrl.document.rows[0].id).toBe(ids[0]);
    expect(ctrl.document.rows[5].id).toBe(ids[5]);
    expect(value(ctrl, 5, 1)).toBe(13);

    ctrl.undo();
    expect(column(ctrl, 0)).toEqual(['Name', 'b', 'a', 'c', '', 'Total']);
    ctrl.redo();
    expect(column(ctrl, 0)).toEqual(['Name', 'a', 'c', 'b', '', 'Total']);
  });

  it('sorts by several keys and descending', () => {
    const ctrl = sheet([['x', '1'], ['y', '2'], ['x', '3'], ['y', '1']]);
    ctrl.sortRows([{ colId: 'c0', direction: 'desc' }, { colId: 'c1', direction: 'asc' }]);
    expect(ctrl.document.rows.map((_, r) => `${raw(ctrl, r, 0)}${raw(ctrl, r, 1)}`)).toEqual(['y1', 'y2', 'x1', 'x3']);
  });

  it('keeps formula references pointing at the cells that moved', () => {
    const ctrl = sheet([['3', '=A1*10', ''], ['1', '=A2*10', ''], ['2', '=A3*10', '=B1']]);
    ctrl.sortRows([{ colId: 'c0' }]);
    expect(column(ctrl, 0)).toEqual(['1', '2', '3']);
    expect(column(ctrl, 1)).toEqual(['=A1*10', '=A2*10', '=A3*10']);
    // C3's reference to B1 (row "3") follows that row to row 3; C3 itself moved to row 2.
    expect(raw(ctrl, 1, 2)).toBe('=B3');
    expect(value(ctrl, 1, 2)).toBe(30);
  });

  it('sorts only the cells inside a range', () => {
    const ctrl = sheet([['3', 'c', 'keep1'], ['1', 'a', 'keep2'], ['2', 'b', 'keep3']]);
    ctrl.sortRows([{ colId: 'c0' }], { range: { startRow: 0, startCol: 0, endRow: 2, endCol: 1 } });
    expect(column(ctrl, 1)).toEqual(['a', 'b', 'c']);
    expect(column(ctrl, 2)).toEqual(['keep1', 'keep2', 'keep3']);
  });

  it('rejects keys outside the range and sorts across merged cells', () => {
    const ctrl = sheet([['3', 'c'], ['1', 'a']]);
    expect(ctrl.sortRows([{ colId: 'c1' }], { range: { startRow: 0, startCol: 0, endRow: 1, endCol: 0 } })).toBe(false);
    ctrl.mergeCells({ startRow: 0, startCol: 2, endRow: 1, endCol: 2 });
    expect(ctrl.sortRows([{ colId: 'c0' }])).toBe(false);
  });
});

describe('filters', () => {
  const rule = (operator: FilterRule['operator'], extra: Partial<FilterRule> = {}): FilterRule => ({
    id: 'f',
    colId: 'c0',
    operator,
    ...extra
  });

  it('matches every operator', () => {
    expect(matchesFilterRule('Apple', rule('equals', { value: 'apple' }))).toBe(true);
    expect(matchesFilterRule('10', rule('equals', { value: 10 }))).toBe(true);
    expect(matchesFilterRule('Apple', rule('notEquals', { value: 'pear' }))).toBe(true);
    expect(matchesFilterRule('Pineapple', rule('contains', { value: 'APP' }))).toBe(true);
    expect(matchesFilterRule('Pear', rule('notContains', { value: 'app' }))).toBe(true);
    expect(matchesFilterRule('10', rule('greaterThan', { value: 9 }))).toBe(true);
    expect(matchesFilterRule('9', rule('greaterThan', { value: '10' }))).toBe(false); // numeric, not text
    expect(matchesFilterRule('9', rule('lessThanOrEqual', { value: 9 }))).toBe(true);
    expect(matchesFilterRule('', rule('lessThan', { value: 9 }))).toBe(false);
    expect(matchesFilterRule('5', rule('between', { value: 1, value2: 5 }))).toBe(true);
    expect(matchesFilterRule('6', rule('between', { value: 1, value2: 5 }))).toBe(false);
    expect(matchesFilterRule(' ', rule('isBlank'))).toBe(true);
    expect(matchesFilterRule('x', rule('isNotBlank'))).toBe(true);
    expect(matchesFilterRule('b', rule('oneOf', { values: ['a', 'b'] }))).toBe(true);
    expect(matchesFilterRule('c', rule('oneOf', { values: ['a', 'b'] }))).toBe(false);
  });

  it('hides filtered rows in the view only, combines rules with AND, and toggles', () => {
    const ctrl = sheet([['Fruit', 'Qty'], ['apple', '5'], ['pear', '20'], ['apricot', '30']]);
    ctrl.setHeaderRowCount(1);
    ctrl.addFilterRule({ colId: 'c0', operator: 'contains', value: 'ap' });
    expect(visibleRows(ctrl)).toEqual([0, 1, 3]);
    ctrl.addFilterRule({ colId: 'c1', operator: 'greaterThan', value: 10 });
    expect(visibleRows(ctrl)).toEqual([0, 3]);
    expect(ctrl.getViewModel().filteredOutCount).toBe(2);
    expect(ctrl.document.rows.length).toBe(4);

    ctrl.toggleFilters();
    expect(visibleRows(ctrl)).toEqual([0, 1, 2, 3]);
    ctrl.toggleFilters();
    expect(visibleRows(ctrl)).toEqual([0, 3]);

    ctrl.undo(); // toggle on
    ctrl.undo(); // toggle off
    ctrl.undo(); // second rule
    expect(visibleRows(ctrl)).toEqual([0, 1, 3]);
    ctrl.clearFilters();
    expect(visibleRows(ctrl)).toEqual([0, 1, 2, 3]);
  });

  it('updates and removes rules', () => {
    const ctrl = sheet([['a'], ['b']]);
    const id = ctrl.addFilterRule({ colId: 'c0', operator: 'equals', value: 'a' });
    expect(visibleRows(ctrl)).toEqual([0]);
    ctrl.updateFilterRule(id, { value: 'b' });
    expect(visibleRows(ctrl)).toEqual([1]);
    ctrl.removeFilterRule(id);
    expect(visibleRows(ctrl)).toEqual([0, 1]);
  });

  it('skips filtered rows when navigating', () => {
    const ctrl = sheet([['a'], ['b'], ['a']]);
    ctrl.addFilterRule({ colId: 'c0', operator: 'equals', value: 'a' });
    ctrl.selectCell(0, 0);
    ctrl.moveCursor('down');
    expect(ctrl.activeCell?.row).toBe(2);
  });
});

describe('freeze, header and footer rows', () => {
  it('stores counts as undoable document state and computes sticky offsets', () => {
    const ctrl = sheet([['a', 'b']], 3);
    ctrl.setFrozenRowCount(2);
    ctrl.setFrozenColumnCount(1);
    ctrl.setHeaderColumnCount(1);
    expect(ctrl.document.table).toMatchObject({ frozenRowCount: 2, frozenColumnCount: 1, headerColumnCount: 1 });

    const view = ctrl.getViewModel();
    const rows = view.rows.filter((r) => r.kind === 'row');
    expect(rows.slice(0, 3).map((r) => r.kind === 'row' && [r.frozen, r.stickyTop])).toEqual([
      [true, 0],
      [true, 32],
      [false, 0]
    ]);
    expect(view.columns[0]).toMatchObject({ frozen: true, header: true, stickyLeft: 0 });
    expect(view.columns[1].frozen).toBe(false);

    ctrl.undo();
    ctrl.undo();
    expect(ctrl.document.table?.frozenColumnCount ?? 0).toBe(0);
    expect(ctrl.document.table?.frozenRowCount).toBe(2);
  });

  it('clamps counts to the grid', () => {
    const ctrl = sheet([['a']], 3);
    ctrl.setHeaderRowCount(10);
    expect(ctrl.document.table?.headerRowCount).toBe(3);
    ctrl.setFooterRowCount(-2);
    expect(ctrl.document.table?.footerRowCount ?? 0).toBe(0);
  });
});

describe('hide and unhide', () => {
  it('hides rows and columns in the view, skips them in navigation, and unhides all', () => {
    const ctrl = sheet([['a', 'b', 'c']], 3);
    ctrl.hideRows([1]);
    ctrl.hideColumns([1]);
    expect(visibleRows(ctrl)).toEqual([0, 2]);
    expect(ctrl.getViewModel().columnOrder).toEqual([0, 2, 3]);

    ctrl.selectCell(0, 0);
    ctrl.moveCursor('right');
    expect(ctrl.activeCell?.col).toBe(2);
    ctrl.moveCursor('down');
    expect(ctrl.activeCell?.row).toBe(2);

    ctrl.unhideRows([1]);
    expect(visibleRows(ctrl)).toEqual([0, 1, 2]);
    ctrl.hideRows([0, 2]);
    ctrl.unhideAll();
    expect(visibleRows(ctrl)).toEqual([0, 1, 2]);
    expect(ctrl.getViewModel().columnOrder).toEqual([0, 1, 2, 3]);
    ctrl.undo();
    expect(visibleRows(ctrl)).toEqual([1]);
  });

  it('keeps hidden record rows hidden across data source syncs', () => {
    const records = [{ id: 't1' }, { id: 't2' }];
    const ctrl = new SpreadsheetController({
      dataSources: [{ id: 'ds', name: 'ds', getRecords: () => records, getFields: () => [], updateRecord: () => {} }],
      primaryDataSourceId: 'ds'
    });
    ctrl.hideRows([0]);
    ctrl.syncWithDataSource();
    expect(ctrl.document.rows[0].hidden).toBe(true);
  });
});

describe('merged cells', () => {
  it('merges onto the top-left cell, clears the rest, and spans in the view', () => {
    const ctrl = sheet([['keep', 'drop'], ['drop', 'drop']]);
    expect(ctrl.mergeCells({ startRow: 1, startCol: 1, endRow: 0, endCol: 0 })).toBe(true);
    expect(ctrl.getMerges()).toEqual([{ startRow: 0, startCol: 0, endRow: 1, endCol: 1 }]);
    expect(raw(ctrl, 0, 0)).toBe('keep');
    expect(raw(ctrl, 0, 1)).toBe('');
    const view = ctrl.getViewModel();
    expect(view.getCellSpan(0, 0)).toMatchObject({ rowSpan: 2, colSpan: 2 });
    expect(view.getCellSpan(1, 1)).toBeNull();
    expect(view.getCellSpan(2, 2)).toMatchObject({ rowSpan: 1, colSpan: 1 });

    ctrl.undo();
    expect(raw(ctrl, 1, 1)).toBe('drop');
    expect(ctrl.getMerges()).toEqual([]);
  });

  it('rejects single cells and partial overlaps, absorbs contained merges', () => {
    const ctrl = sheet([['a']], 4);
    expect(ctrl.mergeCells({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 })).toBe(false);
    ctrl.mergeCells({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    expect(ctrl.mergeCells({ startRow: 1, startCol: 1, endRow: 2, endCol: 2 })).toBe(false);
    expect(ctrl.mergeCells({ startRow: 0, startCol: 0, endRow: 2, endCol: 2 })).toBe(true);
    expect(ctrl.getMerges()).toEqual([{ startRow: 0, startCol: 0, endRow: 2, endCol: 2 }]);
    expect(ctrl.unmergeCells({ startRow: 1, startCol: 1, endRow: 1, endCol: 1 })).toBe(true);
    expect(ctrl.getMerges()).toEqual([]);
  });

  it('selects, edits and navigates merges as one cell', () => {
    const ctrl = sheet([['m', '', 'x']], 4);
    ctrl.mergeCells({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    ctrl.selectCell(1, 1);
    expect(ctrl.activeCell).toMatchObject({ row: 0, col: 0 });
    expect(ctrl.selectedRange).toEqual({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });

    ctrl.moveCursor('right');
    expect(ctrl.activeCell).toMatchObject({ row: 0, col: 2 });
    ctrl.moveCursor('left');
    expect(ctrl.activeCell).toMatchObject({ row: 0, col: 0 });
    ctrl.moveCursor('down');
    expect(ctrl.activeCell).toMatchObject({ row: 2, col: 0 });
    ctrl.moveCursor('up');
    expect(ctrl.activeCell).toMatchObject({ row: 0, col: 0 });

    ctrl.startEditing(1, 1);
    expect(ctrl.editingCell).toMatchObject({ row: 0, col: 0 });
    expect(ctrl.draftValue).toBe('m');

    // Extending a selection into a merge covers the whole merge.
    ctrl.selectCell(2, 1);
    ctrl.selectCell(1, 1, true);
    expect(ctrl.selectedRange).toEqual({ startRow: 2, startCol: 0, endRow: 0, endCol: 1 });
  });

  it('moves merges with row/column inserts and deletes', () => {
    const ctrl = sheet([['a']], 5);
    ctrl.mergeCells({ startRow: 1, startCol: 1, endRow: 2, endCol: 2 });
    ctrl.insertRow(0);
    expect(ctrl.getMerges()).toEqual([{ startRow: 2, startCol: 1, endRow: 3, endCol: 2 }]);
    ctrl.insertColumn(2);
    expect(ctrl.getMerges()).toEqual([{ startRow: 2, startCol: 1, endRow: 3, endCol: 3 }]);
    ctrl.deleteRow(ctrl.document.rows[3].id);
    ctrl.deleteColumn(ctrl.document.columns[1].id);
    ctrl.deleteColumn(ctrl.document.columns[1].id);
    expect(ctrl.getMerges()).toEqual([]); // reduced to one cell
  });
});

describe('autofill', () => {
  it('generates series from source values', () => {
    expect(fillSeries(['1', '3'], 3)).toEqual(['5', '7', '9']);
    expect(fillSeries(['5'], 2)).toEqual(['5', '5']);
    expect(fillSeries(['0.1', '0.2'], 2)).toEqual(['0.3', '0.4']);
    expect(fillSeries(['Item 1'], 2)).toEqual(['Item 2', 'Item 3']);
    expect(fillSeries(['Q01 x', 'Q03 x'], 1)).toEqual(['Q05 x']);
    expect(fillSeries(['a', 'b'], 3)).toEqual(['a', 'b', 'a']);
    expect(fillSeries(['1', 'a'], 2)).toEqual(['1', 'a']);
    expect(fillSeries(['2024-01-30'], 2)).toEqual(['2024-01-31', '2024-02-01']);
    expect(fillSeries(['2024-01-01', '2024-01-08'], 1)).toEqual(['2024-01-15']);
    expect(fillSeries(['2024-01-31', '2024-02-29'], 0)).toEqual([]);
    expect(fillSeries(['2024-01-15', '2024-02-15'], 2)).toEqual(['2024-03-15', '2024-04-15']);
    expect(fillSeries(['2023-11-30', '2023-12-30'], 2)).toEqual(['2024-01-30', '2024-02-29']);
  });

  it('works out the fill target from the dragged pointer', () => {
    const source = { startRow: 1, startCol: 1, endRow: 2, endCol: 1 };
    expect(computeFillTarget(source, { row: 2, col: 1 })).toBeNull();
    expect(computeFillTarget(source, { row: 5, col: 2 })).toEqual({ startRow: 1, startCol: 1, endRow: 5, endCol: 1 });
    expect(computeFillTarget(source, { row: 0, col: 1 })).toEqual({ startRow: 0, startCol: 1, endRow: 2, endCol: 1 });
    expect(computeFillTarget(source, { row: 2, col: 4 })).toEqual({ startRow: 1, startCol: 1, endRow: 2, endCol: 4 });
  });

  it('fills down, up, right and left as one undo step', () => {
    const ctrl = sheet([['', '1'], ['', '2']], 6);
    expect(ctrl.autofill({ startRow: 0, startCol: 1, endRow: 1, endCol: 1 }, { startRow: 0, startCol: 1, endRow: 4, endCol: 1 })).toBe(true);
    expect(column(ctrl, 1).slice(0, 5)).toEqual(['1', '2', '3', '4', '5']);
    ctrl.undo();
    expect(column(ctrl, 1).slice(0, 3)).toEqual(['1', '2', '']);

    const up = sheet([[''], [''], ['10'], ['20']]);
    up.autofill({ startRow: 2, startCol: 0, endRow: 3, endCol: 0 }, { startRow: 0, startCol: 0, endRow: 3, endCol: 0 });
    expect(column(up, 0)).toEqual(['-10', '0', '10', '20']);

    const right = sheet([['Item 1', '', '']]);
    right.autofill({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, { startRow: 0, startCol: 0, endRow: 0, endCol: 2 });
    expect([raw(right, 0, 1), raw(right, 0, 2)]).toEqual(['Item 2', 'Item 3']);

    const left = sheet([['', '', 'x', 'y']]);
    left.autofill({ startRow: 0, startCol: 2, endRow: 0, endCol: 3 }, { startRow: 0, startCol: 0, endRow: 0, endCol: 3 });
    expect([raw(left, 0, 0), raw(left, 0, 1)]).toEqual(['x', 'y']);
  });

  it('shifts relative formula references, keeps absolute ones, and grows the grid', () => {
    const ctrl = sheet([['1', '=A1*$A$1'], ['2', ''], ['3', '']], 3);
    ctrl.autofill({ startRow: 0, startCol: 1, endRow: 0, endCol: 1 }, { startRow: 0, startCol: 1, endRow: 3, endCol: 1 });
    expect(column(ctrl, 1)).toEqual(['=A1*$A$1', '=A2*$A$1', '=A3*$A$1', '=A4*$A$1']);
    expect(ctrl.document.rows.length).toBe(4);
    expect(value(ctrl, 2, 1)).toBe(3);
  });

  it('rejects targets that do not extend the source along one edge', () => {
    const ctrl = sheet([['1']]);
    expect(ctrl.autofill({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, { startRow: 0, startCol: 0, endRow: 1, endCol: 1 })).toBe(false);
  });
});

describe('categories (row groups)', () => {
  const data = [['Team', 'Points'], ['red', '3'], ['blue', '4'], ['red', '5'], ['', '1'], ['Total', '=SUM(B2:B5)']];

  it('groups body rows with summaries, keeping header and footer rows outside', () => {
    expect(aggregateValues(['1', '2', '', 'x'], 'count')).toBe(3);
    expect(aggregateValues(['1', '2'], 'average')).toBe(1.5);
    expect(aggregateValues(['x'], 'average')).toBeNull();

    const ctrl = sheet(data);
    ctrl.setHeaderRowCount(1);
    ctrl.setFooterRowCount(1);
    ctrl.groupRowsBy('c0', [{ colId: 'c1', aggregate: 'sum' }]);
    const groups = ctrl.getGroups();
    expect(groups.map((g) => [g.label, g.rowIndices, g.summaries.c1])).toEqual([
      ['blue', [2], 4],
      ['red', [1, 3], 8],
      ['(blank)', [4], 1]
    ]);

    const view = ctrl.getViewModel();
    expect(view.rows.map((r) => (r.kind === 'group' ? `[${r.group.key}]` : r.index))).toEqual([
      0, '[blue]', 2, '[red]', 1, 3, '[]', 4, 5
    ]);
    expect(view.rowOrder).toEqual([0, 2, 1, 3, 4, 5]);

    ctrl.setGroupSummary('c1', 'average');
    expect(ctrl.getGroups()[1].summaries.c1).toBe(4);
    ctrl.setGroupSummary('c1', null);
    expect(ctrl.getGroups()[1].summaries).toEqual({});
  });

  it('collapses groups (undoably) and navigates in display order', () => {
    const ctrl = sheet(data);
    ctrl.setHeaderRowCount(1);
    ctrl.setFooterRowCount(1);
    ctrl.groupRowsBy('c0');
    ctrl.toggleGroupCollapsed('red');
    expect(ctrl.getViewModel().rowOrder).toEqual([0, 2, 4, 5]);

    ctrl.selectCell(2, 0);
    ctrl.moveCursor('down');
    expect(ctrl.activeCell?.row).toBe(4);

    ctrl.undo();
    expect(ctrl.getViewModel().rowOrder).toEqual([0, 2, 1, 3, 4, 5]);
    ctrl.ungroupRows();
    expect(ctrl.getViewModel().rowOrder).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('groups only rows that pass the filters', () => {
    const ctrl = sheet(data);
    ctrl.setFooterRowCount(1);
    ctrl.setHeaderRowCount(1);
    ctrl.groupRowsBy('c0', [{ colId: 'c1', aggregate: 'count' }]);
    ctrl.addFilterRule({ colId: 'c1', operator: 'greaterThan', value: 3 });
    expect(ctrl.getGroups().map((g) => [g.key, g.summaries.c1])).toEqual([
      ['blue', 1],
      ['red', 1]
    ]);
  });
});

describe('transpose', () => {
  it('turns rows into columns, clears uncovered cells, and remaps references', () => {
    const ctrl = sheet([['1', '2', '3'], ['4', '5', '6'], ['=C1', '', '']], 3);
    expect(ctrl.transposeRange({ startRow: 0, startCol: 0, endRow: 1, endCol: 2 })).toBe(true);
    expect(column(ctrl, 0)).toEqual(['1', '2', '3']);
    expect(column(ctrl, 1)).toEqual(['4', '5', '6']);
    expect(raw(ctrl, 0, 2)).toBe('');
    // A3 (outside the source, inside the target) was overwritten by C1's value.
    expect(ctrl.selectedRange).toEqual({ startRow: 0, startCol: 0, endRow: 2, endCol: 1 });

    ctrl.undo();
    expect(column(ctrl, 0)).toEqual(['1', '4', '=C1']);
  });

  it('keeps formulas pointing at moved cells', () => {
    const ctrl = sheet([['1', '2', ''], ['', '', ''], ['', '', '=B1*10']], 3);
    ctrl.transposeRange({ startRow: 0, startCol: 0, endRow: 0, endCol: 1 });
    expect(column(ctrl, 0)).toEqual(['1', '2', '']);
    expect(raw(ctrl, 2, 2)).toBe('=A2*10');
    expect(value(ctrl, 2, 2)).toBe(20);
  });

  it('grows the grid and rejects single cells and merges', () => {
    const ctrl = sheet([['a', 'b', 'c', 'd']], 1);
    ctrl.transposeRange({ startRow: 0, startCol: 0, endRow: 0, endCol: 3 });
    expect(ctrl.document.rows.length).toBe(4);
    expect(column(ctrl, 0)).toEqual(['a', 'b', 'c', 'd']);
    expect(ctrl.transposeRange({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 })).toBe(false);
    ctrl.mergeCells({ startRow: 0, startCol: 1, endRow: 0, endCol: 2 });
    expect(ctrl.transposeRange({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 })).toBe(false);
  });
});

describe('context menu items', () => {
  it('runs table actions against the controller', () => {
    const ctrl = sheet([['b'], ['a']]);
    const items = getSpreadsheetMenuItems(ctrl, { row: 0, col: 0 });
    const byId = (id: string) => items.find((i) => i.id === id)!;
    expect(byId('merge').disabled).toBe(true);
    expect(byId('unhide-all').disabled).toBe(true);

    byId('sort-asc').run();
    expect(column(ctrl, 0).slice(0, 2)).toEqual(['a', 'b']);

    ctrl.selectCell(0, 0);
    ctrl.selectCell(1, 1, true);
    const rangeItems = getSpreadsheetMenuItems(ctrl, { row: 1, col: 1 });
    expect(rangeItems.find((i) => i.id === 'merge')!.disabled).toBe(false);
    rangeItems.find((i) => i.id === 'hide-rows')!.run();
    expect(ctrl.document.rows.slice(0, 2).every((r) => r.hidden)).toBe(true);

    getSpreadsheetMenuItems(ctrl, { row: 1, col: 0 }).find((i) => i.id === 'group-by')!.run();
    expect(ctrl.document.table?.grouping?.colId).toBe('c0');
    expect(getSpreadsheetMenuItems(ctrl, { row: 1, col: 0 }).some((i) => i.id === 'summary-sum')).toBe(true);
  });
});

describe('clampMenuPosition', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 200, height: 400 };

  it('keeps the pointer position when the menu fits', () => {
    expect(clampMenuPosition({ x: 100, y: 100 }, size, viewport)).toEqual({ x: 100, y: 100 });
  });

  it('flips left / up when the menu would overflow the right / bottom edge', () => {
    expect(clampMenuPosition({ x: 900, y: 600 }, size, viewport)).toEqual({ x: 700, y: 200 });
  });

  it('slides a menu that fits neither way back inside the viewport', () => {
    // Flipping up from y=300 would put the top at -400: slide up just enough instead.
    expect(clampMenuPosition({ x: 10, y: 300 }, { width: 200, height: 700 }, viewport, 8)).toEqual({ x: 10, y: 92 });
    // Taller than the viewport: pinned to the top margin (the menu scrolls).
    expect(clampMenuPosition({ x: 10, y: 500 }, { width: 200, height: 900 }, viewport, 4).y).toBe(4);
  });
});
