import { describe, expect, it } from 'vitest';
import {
  SpreadsheetController,
  colNameToIndex,
  formatCellDisplay,
  formatCellForDisplay,
  getSpreadsheetMenuItems,
  runSpreadsheetMenuItem,
  SPREADSHEET_TABLE_ACTIONS,
  type SpreadsheetDataSource,
} from '../src/spreadsheet';

function sheet(ctrl = new SpreadsheetController()) {
  const ids = (key: string) => {
    const [, col, row] = /^([A-Z]+)(\d+)$/.exec(key)!;
    return [ctrl.document.rows[Number(row) - 1].id, ctrl.document.columns[colNameToIndex(col)].id] as const;
  };
  const at = (key: string) => {
    const [, col, row] = /^([A-Z]+)(\d+)$/.exec(key)!;
    return { row: Number(row) - 1, col: colNameToIndex(col) };
  };
  const range = (from: string, to = from) => {
    const a = at(from);
    const b = at(to);
    return { startRow: a.row, startCol: a.col, endRow: b.row, endCol: b.col };
  };
  return {
    ctrl,
    ids,
    at,
    range,
    set: (key: string, raw: string) => ctrl.setCellValue(...ids(key), raw),
    cell: (key: string) => ctrl.getCell(...ids(key)),
    display: (key: string) => formatCellDisplay(ctrl.getCell(...ids(key))),
    shown: (key: string) => formatCellForDisplay(ctrl.getCell(...ids(key))),
  };
}

describe('formatCellForDisplay', () => {
  it('formats values with the cell number format, colour and alignment', () => {
    expect(formatCellForDisplay({ value: -5, numberFormat: '#,##0.00;[Red](#,##0.00)' })).toEqual({
      text: '(5.00)',
      color: 'red',
      numeric: true,
    });
    expect(formatCellForDisplay({ value: 0.1 + 0.2 })).toEqual({ text: '0.3', numeric: true });
    expect(formatCellForDisplay({ value: 'abc', numberFormat: '0.00' })).toEqual({ text: 'abc', numeric: false });
    expect(formatCellForDisplay({ value: true, numberFormat: '0.00' })).toEqual({ text: 'TRUE', numeric: false });
    expect(formatCellForDisplay({ value: '#DIV/0!', error: '#DIV/0!' })).toEqual({ text: '#DIV/0!', numeric: false });
    expect(formatCellForDisplay({ value: '2026-10-07', numberFormat: 'dddd, mmmm d' })).toEqual({
      text: 'Wednesday, October 7',
      numeric: true,
    });
    // ISO text without a date format stays text (e.g. a TODAY() result).
    expect(formatCellForDisplay({ value: '2026-10-07' })).toEqual({ text: '2026-10-07', numeric: false });
    expect(formatCellForDisplay(null)).toEqual({ text: '', numeric: false });
  });

  it('maps CellFormat kinds to codes for numbers without a code', () => {
    expect(formatCellDisplay({ value: 1234.5, format: 'currency' })).toBe('$1,234.50');
    expect(formatCellDisplay({ value: 0.25, format: 'percentage' })).toBe('25%');
    expect(formatCellDisplay({ value: 46302, format: 'date' })).toBe('10/7/2026');
    expect(formatCellDisplay({ value: 1 / 3, format: 'number' })).toBe('0.333333333333333');
    expect(formatCellDisplay({ value: 5, format: 'text' })).toBe('5');
    // An explicit code wins over the kind.
    expect(formatCellDisplay({ value: 5, format: 'currency', numberFormat: '0.0' })).toBe('5.0');
  });
});

describe('explicit number formats in the controller', () => {
  it('sets a format on a range, keeps it when typing, and undoes in one step', () => {
    const s = sheet();
    s.set('A1', '1234.5');
    s.set('A2', '-2');
    expect(s.ctrl.setCellNumberFormat(s.range('A1', 'A3'), '#,##0.00;[Red](#,##0.00)')).toBe(true);
    expect(s.shown('A1')).toEqual({ text: '1,234.50', numeric: true });
    expect(s.shown('A2')).toEqual({ text: '(2.00)', color: 'red', numeric: true });
    expect(s.cell('A1')).toMatchObject({ numberFormat: '#,##0.00;[Red](#,##0.00)', explicitNumberFormat: true, format: 'number' });
    // A blank cell keeps the format for what is typed later, even typed currency.
    s.set('A3', '$7');
    expect(s.display('A3')).toBe('7.00');
    s.set('A1', '9');
    expect(s.display('A1')).toBe('9.00');
    s.ctrl.undo();
    s.ctrl.undo();
    s.ctrl.undo();
    expect(s.display('A1')).toBe('1234.5');
    expect(s.cell('A3').raw).toBe('');
    s.ctrl.redo();
    expect(s.display('A1')).toBe('1,234.50');
  });

  it('removes explicit formats with null, back to the automatic format', () => {
    const s = sheet();
    s.set('A1', '$5');
    s.ctrl.setCellNumberFormat(s.range('A1', 'B1'), '0.000');
    expect(s.display('A1')).toBe('5.000');
    s.ctrl.setCellNumberFormat(s.range('A1', 'B1'), null);
    expect(s.cell('A1')).toMatchObject({ numberFormat: '"$"#,##0' });
    expect(s.cell('A1').explicitNumberFormat).toBeUndefined();
    expect(s.display('A1')).toBe('$5');
    // The format-only blank cell is gone.
    expect(s.ctrl.document.cells[s.ids('B1')[0]][s.ids('B1')[1]]).toBeUndefined();
  });

  it('shows General when set explicitly, even for typed currency', () => {
    const s = sheet();
    s.set('A1', '$5');
    s.ctrl.setCellNumberFormat(s.range('A1'), 'General');
    expect(s.display('A1')).toBe('5');
    s.set('A1', '$6');
    expect(s.display('A1')).toBe('6');
  });

  it('formats formula results and dates', () => {
    const s = sheet();
    s.set('A1', '=1/3');
    s.ctrl.setCellNumberFormat(s.range('A1'), '# ?/?');
    expect(s.display('A1')).toBe(' 1/3');
    s.set('A2', '3/4/2026');
    s.ctrl.setCellNumberFormat(s.range('A2'), 'dddd, mmmm d, yyyy');
    expect(s.display('A2')).toBe('Wednesday, March 4, 2026');
    s.set('A1', '=2/3');
    expect(s.display('A1')).toBe(' 2/3');
  });

  it('formats spilled cells', () => {
    const s = sheet();
    s.set('A1', '=SEQUENCE(3)/4');
    s.ctrl.setCellNumberFormat(s.range('A1', 'A3'), '0.00');
    expect([s.display('A1'), s.display('A2'), s.display('A3')]).toEqual(['0.25', '0.50', '0.75']);
    // Recalculating keeps the spilled cells' formats.
    s.set('A1', '=SEQUENCE(3)/2');
    expect([s.display('A2'), s.display('A3')]).toEqual(['1.00', '1.50']);
  });

  it('formats bound record values without replacing them', () => {
    const records = [{ id: 't1', points: 1234.5 }];
    const ds: SpreadsheetDataSource = {
      id: 'tasks',
      name: 'Tasks',
      getRecords: () => records,
      getFields: () => [{ key: 'points', label: 'Points', type: 'number' }],
      updateRecord: (id, field, value) => {
        (records.find((r) => r.id === id) as Record<string, unknown>)[field] = value;
      },
    };
    const ctrl = new SpreadsheetController({
      dataSources: [ds],
      primaryDataSourceId: 'tasks',
      document: { columns: [{ id: 'points', key: 'A', title: 'Points', type: 'bound', binding: { dataSource: 'tasks', field: 'points' } }] },
    });
    const row = ctrl.document.rows[0].id;
    ctrl.setCellNumberFormat({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, '"$"#,##0.00');
    expect(ctrl.getCell(row, 'points')).toMatchObject({ value: 1234.5, numberFormat: '"$"#,##0.00' });
    expect(formatCellDisplay(ctrl.getCell(row, 'points'))).toBe('$1,234.50');
    ctrl.setCellValue(row, 'points', '99');
    expect(formatCellDisplay(ctrl.getCell(row, 'points'))).toBe('$99.00');
  });

  it('uses column formats for cells without an explicit format', () => {
    const s = sheet();
    s.set('A1', '0.5');
    s.set('A2', '10%');
    s.ctrl.setCellNumberFormat(s.range('A3'), '0.0');
    s.set('A3', '0.25');
    const colId = s.ctrl.document.columns[0].id;
    s.ctrl.setColumnNumberFormat(colId, '0.00%');
    expect(s.ctrl.document.columns[0].numberFormat).toBe('0.00%');
    expect([s.display('A1'), s.display('A2'), s.display('A3')]).toEqual(['50.00%', '10.00%', '0.3']);
    s.set('A4', '$3');
    expect(s.display('A4')).toBe('300.00%');
    s.ctrl.setColumnNumberFormat(colId, null);
    expect(s.ctrl.document.columns[0].numberFormat).toBeUndefined();
    expect([s.display('A1'), s.display('A2'), s.display('A4')]).toEqual(['0.5', '10%', '$3']);
    s.ctrl.undo();
    expect(s.display('A1')).toBe('50.00%');
    // New columns take a format from their config; loading a document re-applies it.
    s.ctrl.insertColumn(1, { title: 'Money', numberFormat: '"$"#,##0.00' });
    s.set('B1', '4');
    expect(s.display('B1')).toBe('$4.00');
    s.ctrl.loadDocument(JSON.parse(JSON.stringify(s.ctrl.document)));
    expect([s.display('A1'), s.display('B1'), s.display('A3')]).toEqual(['50.00%', '$4.00', '0.3']);
  });

  it('exports formatted values to CSV and the clipboard', () => {
    const s = sheet();
    s.set('A1', '1234.5');
    s.set('B1', '-3');
    s.ctrl.setCellNumberFormat(s.range('A1', 'B1'), '#,##0.00;(#,##0.00)');
    const range = s.range('A1', 'B1');
    expect(s.ctrl.exportToCsv({ range })).toBe('"1,234.50",(3.00)');
    expect(s.ctrl.copyToClipboardData(range)['text/plain']).toBe('1,234.50\t(3.00)');
  });

  it('exposes the number format actions to the framework bindings', () => {
    expect(SPREADSHEET_TABLE_ACTIONS).toContain('setCellNumberFormat');
    expect(SPREADSHEET_TABLE_ACTIONS).toContain('setColumnNumberFormat');
  });
});

describe('Format cells menu', () => {
  it('offers presets that apply to the selection, with the current one checked', () => {
    const s = sheet();
    s.set('A1', '1.5');
    s.set('A2', '2');
    s.ctrl.selectRange(s.range('A1', 'A2'));
    const items = getSpreadsheetMenuItems(s.ctrl, s.at('A1'));
    const formatItems = items.filter((i) => i.id.startsWith('number-format-'));
    expect(formatItems.map((i) => i.id)).toEqual([
      'number-format-general',
      'number-format-number',
      'number-format-currency',
      'number-format-percent',
      'number-format-date',
      'number-format-time',
      'number-format-custom',
    ]);
    expect(formatItems.find((i) => i.checked)?.id).toBe('number-format-general');
    runSpreadsheetMenuItem(formatItems.find((i) => i.id === 'number-format-currency')!);
    expect([s.display('A1'), s.display('A2')]).toEqual(['$1.50', '$2.00']);
    const again = getSpreadsheetMenuItems(s.ctrl, s.at('A1'));
    expect(again.find((i) => i.checked && i.id.startsWith('number-format-'))?.id).toBe('number-format-currency');
  });

  it('asks for a custom code, and does nothing when cancelled', () => {
    const s = sheet();
    s.set('A1', '-4');
    const custom = () => getSpreadsheetMenuItems(s.ctrl, s.at('A1')).find((i) => i.id === 'number-format-custom')!;
    expect(custom().input?.defaultValue).toBe('General');
    expect(runSpreadsheetMenuItem(custom(), () => null)).toBe(false);
    expect(s.display('A1')).toBe('-4');
    const asked: string[] = [];
    expect(
      runSpreadsheetMenuItem(custom(), (label, value) => {
        asked.push(label, value);
        return '0.0;[Blue]-0.0';
      })
    ).toBe(true);
    expect(asked[1]).toBe('General');
    expect(s.shown('A1')).toEqual({ text: '-4.0', color: 'blue', numeric: true });
    expect(custom().checked).toBe(true);
    expect(custom().input?.defaultValue).toBe('0.0;[Blue]-0.0');
    // An empty code removes the explicit format.
    runSpreadsheetMenuItem(custom(), () => '');
    expect(s.display('A1')).toBe('-4');
  });
});
