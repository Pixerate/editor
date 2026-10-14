// Several cases re-express the tests in gridcraft's crates/core/src/parse.rs,
// date.rs and value.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors).
// See THIRD_PARTY_NOTICES.md.
import { describe, it, expect } from 'vitest';
import {
  SpreadsheetController,
  compareCellValues,
  matchesFilterRule,
  type FilterRule,
  type SpreadsheetDataSource,
  type SpreadsheetDocument,
} from '../src/spreadsheet';
import {
  FormulaEvaluator,
  colNameToIndex,
  compareNumbers,
  compareValues,
  formatCellDisplay,
  numberToText,
  parseCellInput,
  parseCriteria,
  parseNumberText,
  serialFromYmd,
  sortCompareValues,
} from '../src/spreadsheet/formula';
import { toNumber, toText } from '../src/spreadsheet/formula/values';

const value = (input: string) => parseCellInput(input).value;
const thisYear = new Date().getFullYear();

describe('parseCellInput: numbers', () => {
  it.each([
    ['42', 42, undefined],
    ['-3.5', -3.5, undefined],
    ['1,234', 1234, '#,##0'],
    ['1,234.50', 1234.5, '#,##0.00'],
    ['12%', 0.12, '0%'],
    ['12.5%', 0.125, '0.00%'],
    ['$1,200.50', 1200.5, '"$"#,##0.00'],
    ['$5', 5, '"$"#,##0'],
    ['-$5', -5, '"$"#,##0'],
    ['$-5', -5, '"$"#,##0'],
    ['(100)', -100, undefined],
    ['($1,000)', -1000, '"$"#,##0'],
    ['1e3', 1000, '0.00E+00'],
    ['1 1/2', 1.5, '# ?/?'],
    ['-1 1/2', -1.5, '# ?/?'],
    ['.5', 0.5, undefined],
    ['+7', 7, undefined],
    [' 42 ', 42, undefined],
    ['-0', 0, undefined],
  ])('%s -> %s', (input, expected, format) => {
    const parsed = parseCellInput(input);
    expect(parsed.type).toBe('number');
    expect(parsed.value).toBe(expected);
    expect(parsed.numberFormat).toBe(format);
  });

  it('maps the automatic format onto CellFormat', () => {
    expect(parseCellInput('$5').cellFormat).toBe('currency');
    expect(parseCellInput('10%').cellFormat).toBe('percentage');
    expect(parseCellInput('1,234').cellFormat).toBe('number');
    expect(parseCellInput('3/4/2026').cellFormat).toBe('date');
    expect(parseCellInput('10:30').formatKind).toBe('time');
    expect(parseCellInput('10:30').cellFormat).toBeUndefined();
    expect(parseCellInput('42').cellFormat).toBeUndefined();
  });

  it.each(['1,23', '12,34,567', ',123', '1.2.3.4', 'e', '-', '$', '%', '1e', 'abc', '12abc', '1 1/0'])(
    'keeps %s as text',
    (input) => {
      expect(parseCellInput(input)).toEqual({ value: input, type: 'text' });
    },
  );
});

describe('parseCellInput: text and specials', () => {
  it('reads booleans, error literals and forced text', () => {
    expect(value('hello')).toBe('hello');
    expect(parseCellInput("'123")).toEqual({ value: '123', type: 'text' });
    expect(value("'=A1")).toBe('=A1');
    expect(value('true')).toBe(true);
    expect(value('FALSE')).toBe(false);
    expect(parseCellInput('#N/A')).toEqual({ value: '#N/A', type: 'error' });
    expect(value('#div/0!')).toBe('#DIV/0!');
    expect(parseCellInput('')).toEqual({ value: '', type: 'empty' });
    // Text keeps its spacing.
    expect(value('  two words ')).toBe('  two words ');
  });
});

describe('parseCellInput: dates and times', () => {
  it.each([
    ['10/7/2026', '2026-10-07', 'm/d/yyyy'],
    ['2026-10-07', '2026-10-07', 'yyyy-mm-dd'],
    ['2026/10/7', '2026-10-07', 'yyyy-mm-dd'],
    ['7-Oct-2026', '2026-10-07', 'd-mmm-yy'],
    ['Oct 7, 2026', '2026-10-07', 'd-mmm-yy'],
    ['3/4/26', '2026-03-04', 'm/d/yyyy'],
    ['3/4/99', '1999-03-04', 'm/d/yyyy'],
    ['1/1/1900', '1900-01-01', 'm/d/yyyy'],
    ['Mar-2026', '2026-03-01', 'mmm-yy'],
    ['3/2026', '2026-03-01', 'mmm-yy'],
    ['10/7/2026 18:00', '2026-10-07 18:00:00', 'm/d/yyyy h:mm'],
    ['2026-10-07 6:30 PM', '2026-10-07 18:30:00', 'm/d/yyyy h:mm'],
  ])('%s -> %s', (input, iso, format) => {
    const parsed = parseCellInput(input);
    expect(parsed.type).toBe('date');
    expect(parsed.value).toBe(iso);
    expect(parsed.numberFormat).toBe(format);
  });

  it('uses the current year for dates typed without one', () => {
    expect(value('3/4')).toBe(`${thisYear}-03-04`);
    expect(value('4-Mar')).toBe(`${thisYear}-03-04`);
  });

  it('keeps impossible and pre-1900 dates as text', () => {
    for (const input of ['2/30/2026', '7/4/1776', '1776-07-04', '4-Jul-1776', '12/31/1899', '13/1/2026']) {
      expect(parseCellInput(input).type).toBe('text');
    }
  });

  it('reads times as fractions of a day', () => {
    expect(parseCellInput('12:00')).toMatchObject({ value: 0.5, numberFormat: 'h:mm', formatKind: 'time' });
    expect(value('6:00 PM')).toBe(0.75);
    expect(value('12:00 AM')).toBe(0);
    expect(value('6 pm')).toBe(0.75);
    expect(parseCellInput('10:30:15').numberFormat).toBe('h:mm:ss');
    expect(parseCellInput('10:30:15 pm').numberFormat).toBe('h:mm:ss AM/PM');
    expect(value('25:00')).toBeCloseTo(25 / 24, 12);
    expect(parseCellInput('25:00').numberFormat).toBe('[h]:mm:ss');
    expect(parseCellInput('23:59').numberFormat).toBe('h:mm');
    expect(parseCellInput('10:60').type).toBe('text');
    expect(parseCellInput('13:00 PM').type).toBe('text');
  });

  // gridcraft's month_name_short_year cases (serial 46085 is 2026-03-04).
  it('reads month names with two-digit years', () => {
    for (const input of ['Mar 4, 26', 'Mar 4 26', 'March 4 26', '4 March 26', 'Mar 4, 2026']) {
      expect(value(input)).toBe('2026-03-04');
    }
    expect(value('Mar 4, 99')).toBe(value('Mar 4, 1999'));
    expect(value('Mar 4, 1776')).toBe('Mar 4, 1776');
    expect(value('Feb 30, 26')).toBe('Feb 30, 26');
  });

  // gridcraft's fictitious_1900_02_29: Excel's 1900 calendar has a 29 February 1900
  // (serial 60). ISO text can't represent it, so typed it stays text; as numeric text
  // in a formula it is serial 60.
  it('handles the fictitious 1900-02-29', () => {
    expect(value('2/28/1900')).toBe('1900-02-28');
    expect(value('3/1/1900')).toBe('1900-03-01');
    expect(parseCellInput('2/29/1900').type).toBe('text');
    expect(parseCellInput('1900-02-29').type).toBe('text');
    expect(parseNumberText('2/29/1900')).toBe(60);
    expect(parseNumberText('29-Feb-1900')).toBe(60);
    expect(parseNumberText('2/28/1900')).toBe(59);
    expect(parseNumberText('3/1/1900')).toBe(61);
    expect(parseNumberText('2/29/1901')).toBeNull();
    expect(parseNumberText('2/30/1900')).toBeNull();
  });
});

describe('date serials', () => {
  it.each([
    [1900, 1, 1, 1],
    [1900, 2, 28, 59],
    [1900, 2, 29, 60],
    [1900, 3, 1, 61],
    [2000, 1, 1, 36526],
    [2026, 10, 7, 46302],
    [9999, 12, 31, 2958465],
    [1900, 1, 0, 0],
  ])('%i-%i-%i is serial %i', (y, m, d, serial) => {
    expect(serialFromYmd(y, m, d)).toBe(serial);
  });

  it('rolls month and day over like DATE()', () => {
    expect(serialFromYmd(2020, 13, 1)).toBe(serialFromYmd(2021, 1, 1));
    expect(serialFromYmd(2020, 3, 0)).toBe(serialFromYmd(2020, 2, 29));
    expect(serialFromYmd(120, 1, 1)).toBe(serialFromYmd(2020, 1, 1));
    expect(serialFromYmd(1900, 3, 0)).toBe(60);
    expect(serialFromYmd(1900, 1, -1)).toBeNull();
    expect(serialFromYmd(9999, 12, 32)).toBeNull();
    expect(serialFromYmd(2000, Number.MAX_SAFE_INTEGER, 1)).toBeNull();
  });

  it('coerces date and time text to serial numbers', () => {
    expect(parseNumberText('10/7/2026')).toBe(46302);
    expect(parseNumberText('10/7/2026 18:00')).toBe(46302.75);
    expect(parseNumberText('2026-10-07')).toBe(46302);
    expect(parseNumberText('10:00')).toBeCloseTo(10 / 24, 12);
  });
});

describe('Excel comparison semantics', () => {
  it('orders numbers < text < booleans, text case-insensitively', () => {
    expect(compareValues('abc', 'ABC')).toBe(0);
    expect(compareValues(5, '1')).toBeLessThan(0);
    expect(compareValues('z', false)).toBeLessThan(0);
    expect(compareValues(true, false)).toBeGreaterThan(0);
    expect(compareValues('#N/A', true)).toBeGreaterThan(0);
  });

  it('treats a blank as 0, "" or FALSE', () => {
    expect(compareValues('', 0)).toBe(0);
    expect(compareValues(null, -1)).toBeGreaterThan(0);
    expect(compareValues('', 'a')).toBeLessThan(0);
    expect(compareValues('', false)).toBe(0);
    expect(compareValues(true, undefined)).toBeGreaterThan(0);
    expect(compareValues('', '')).toBe(0);
  });

  it('compares numbers at 15 significant digits', () => {
    expect(compareNumbers(0.1 + 0.2, 0.3)).toBe(0);
    expect(compareNumbers(1.1 * 3, 3.3)).toBe(0);
    expect(compareNumbers(1, 1 + 1e-16)).toBe(0);
    expect(compareNumbers(1, 1.00000000000001)).toBe(-1);
    expect(compareNumbers(1, 2)).toBe(-1);
    expect(compareValues(0.1 + 0.2, 0.3)).toBe(0);
  });

  it('compares ISO dates chronologically and against serial numbers', () => {
    expect(compareValues('2026-1-5', '2026-01-10')).toBeLessThan(0);
    expect(compareValues('2026-03-04', 46085)).toBe(0);
    expect(compareValues(46086, '2026-03-04')).toBeGreaterThan(0);
  });

  it('sorts blanks last', () => {
    expect(sortCompareValues('', 1)).toBeGreaterThan(0);
    expect(sortCompareValues(1, null)).toBeLessThan(0);
    expect(sortCompareValues('#N/A', '#REF!')).toBe(0);
    const values = [true, 'b', '', 10, '#N/A', 'A', 2, false];
    expect([...values].sort(sortCompareValues)).toEqual([2, 10, 'A', 'b', false, true, '#N/A', '']);
  });
});

describe('coercion', () => {
  it('converts numbers to text with 15 significant digits', () => {
    expect(numberToText(1)).toBe('1');
    expect(numberToText(-2.5)).toBe('-2.5');
    expect(numberToText(0.1 + 0.2)).toBe('0.3');
    expect(numberToText(123456789012345)).toBe('123456789012345');
    expect(numberToText(1e15)).toBe('1E+15');
    expect(numberToText(1234567890123456)).toBe('1.23456789012346E+15');
    expect(numberToText(0.0001)).toBe('0.0001');
    expect(numberToText(1e-10)).toBe('1E-10');
    expect(numberToText(1 / 3)).toBe('0.333333333333333');
    expect(numberToText(1000)).toBe('1000');
  });

  it('coerces text to numbers like arithmetic', () => {
    expect(toNumber('12')).toBe(12);
    expect(toNumber(' 1,234.5 ')).toBe(1234.5);
    expect(toNumber('50%')).toBe(0.5);
    expect(toNumber('$3')).toBe(3);
    expect(toNumber('(5)')).toBe(-5);
    expect(toNumber('abc')).toBe('#VALUE!');
    expect(toNumber(true)).toBe(1);
    expect(toText('')).toBe('');
    expect(toText(false)).toBe('FALSE');
  });

  it('applies to formulas', () => {
    const ev = new FormulaEvaluator({ resolveCell: () => '', resolveRange: () => [] });
    expect(ev.evaluate('="1,000"+1')).toBe(1001);
    expect(ev.evaluate('="50%"*2')).toBe(1);
    expect(ev.evaluate('=0.1+0.2=0.3')).toBe(true);
    expect(ev.evaluate('=(0.1+0.2)&""')).toBe('0.3');
    expect(ev.evaluate('="abc"+1')).toBe('#VALUE!');
    expect(ev.evaluate('="1"=1')).toBe(false);
    expect(ev.evaluate('=VALUE("3/4/2026")')).toBe(46085);
    expect(ev.evaluate('=VALUE("€12")')).toBe(12);
  });
});

describe('criteria use typed-input operands', () => {
  it('reads numeric, percentage, currency and date operands', () => {
    expect(parseCriteria('>1,000')(1500)).toBe(true);
    expect(parseCriteria('>1,000')(999)).toBe(false);
    expect(parseCriteria('<50%')(0.4)).toBe(true);
    expect(parseCriteria('=$5')(5)).toBe(true);
    expect(parseCriteria('>=3/1/2026')('2026-03-04')).toBe(true);
    expect(parseCriteria('>=3/1/2026')('2026-02-28')).toBe(false);
    expect(parseCriteria('3/4/2026')('2026-03-04')).toBe(true);
    expect(parseCriteria('<2026-03-01')('2026-02-01')).toBe(true);
    expect(parseCriteria('<2026-03-01')('text')).toBe(false);
  });
});

/** A controller addressed with A1-style keys. */
function sheet(ctrl = new SpreadsheetController()) {
  const ids = (key: string) => {
    const [, col, row] = /^([A-Z]+)(\d+)$/.exec(key)!;
    return [ctrl.document.rows[Number(row) - 1].id, ctrl.document.columns[colNameToIndex(col)].id] as const;
  };
  return {
    ctrl,
    set: (key: string, raw: string) => ctrl.setCellValue(...ids(key), raw),
    cell: (key: string) => ctrl.getCell(...ids(key)),
    value: (key: string) => ctrl.getCell(...ids(key)).value,
    display: (key: string) => formatCellDisplay(ctrl.getCell(...ids(key))),
  };
}

describe('typed cell values in the controller', () => {
  it('stores typed values and keeps raw as typed', () => {
    const s = sheet();
    s.set('A1', '7');
    s.set('A2', '$1,200.50');
    s.set('A3', '3/4/2026');
    s.set('A4', "'42");
    s.set('A5', 'true');
    s.set('A6', '10:30 PM');
    expect(s.cell('A1')).toMatchObject({ raw: '7', value: 7 });
    expect(s.cell('A2')).toMatchObject({ raw: '$1,200.50', value: 1200.5, numberFormat: '"$"#,##0.00', format: 'currency' });
    expect(s.cell('A3')).toMatchObject({ raw: '3/4/2026', value: '2026-03-04', format: 'date' });
    expect(s.cell('A4')).toMatchObject({ raw: "'42", value: '42' });
    expect(s.value('A5')).toBe(true);
    expect(s.value('A6')).toBeCloseTo(22.5 / 24, 12);
  });

  it('displays typed values with their automatic format', () => {
    const s = sheet();
    const inputs = ['1,234', '$5', '10%', '3/4/2026', '10:30', '25:00', '1 1/2', "'007", 'TRUE', '1.50'];
    inputs.forEach((raw, i) => s.set(`A${i + 1}`, raw));
    expect(inputs.map((_, i) => s.display(`A${i + 1}`))).toEqual([
      '1,234', '$5', '10%', '3/4/2026', '10:30', '25:00:00', '1 1/2', '007', 'TRUE', '1.5',
    ]);
    s.set('B1', '=0.1+0.2');
    expect(s.display('B1')).toBe('0.3');
  });

  it('keeps an explicit column format', () => {
    const ctrl = new SpreadsheetController({
      document: {
        columns: [{ id: 'c0', key: 'A', title: 'A', type: 'freeform', format: 'number' }],
        rows: [{ id: 'r0', index: 0, type: 'freeform' }],
      },
    });
    ctrl.setCellValue('r0', 'c0', '$5');
    expect(ctrl.getCell('r0', 'c0')).toMatchObject({ value: 5, format: 'number', numberFormat: '"$"#,##0' });
  });

  it('compares a typed 7 as a number (=B1>8 is FALSE)', () => {
    const s = sheet();
    s.set('B1', '7');
    s.set('C1', '=B1>8');
    s.set('C2', '=B1<8');
    s.set('C3', '=B1=7');
    expect([s.value('C1'), s.value('C2'), s.value('C3')]).toEqual([false, true, true]);
    s.set('B1', "'7");
    expect(s.value('C1')).toBe(true); // text ranks above numbers
  });

  it('filters typed numbers with FILTER', () => {
    const s = sheet();
    ['5', '12', 'n/a', '9', '1,000'].forEach((raw, i) => s.set(`A${i + 1}`, raw));
    s.set('B1', '=FILTER(A1:A5, A1:A5>8)');
    expect([s.value('B1'), s.value('B2'), s.value('B3'), s.value('B4')]).toEqual([12, 'n/a', 9, 1000]);
    s.set('C1', '=SUMIF(A1:A5, ">8")');
    expect(s.value('C1')).toBe(1021);
  });

  it('sorts typed numbers before text, blanks last', () => {
    const ctrl = new SpreadsheetController({
      document: {
        columns: [{ id: 'c0', key: 'A', title: 'A', type: 'freeform' }],
        rows: Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, index: i, type: 'freeform' as const })),
      },
    });
    ['banana', '10', '', '9', 'Apple', '$2'].forEach((raw, i) => raw && ctrl.setCellValue(`r${i}`, 'c0', raw));
    ctrl.sortRows([{ colId: 'c0', direction: 'asc' }]);
    expect(ctrl.document.rows.map((r) => ctrl.getCell(r.id, 'c0').raw)).toEqual(['$2', '9', '10', 'Apple', 'banana', '']);
    ctrl.sortRows([{ colId: 'c0', direction: 'desc' }]);
    expect(ctrl.document.rows.map((r) => ctrl.getCell(r.id, 'c0').raw)).toEqual(['banana', 'Apple', '10', '9', '$2', '']);
  });

  it('imports CSV values as typed values', () => {
    const s = sheet();
    s.ctrl.importFromCsv('"1,234",$5,10%,3/4/2026,text\n');
    expect([s.value('A1'), s.value('B1'), s.value('C1'), s.value('D1'), s.value('E1')]).toEqual([
      1234, 5, 0.1, '2026-03-04', 'text',
    ]);
    expect(s.cell('A1').raw).toBe('1,234');
    expect(s.ctrl.exportToCsv({ range: { startRow: 0, startCol: 0, endRow: 0, endCol: 4 } })).toBe(
      '"1,234",$5,10%,3/4/2026,text',
    );
    s.set('A2', '=SUM(A1:C1)');
    expect(s.value('A2')).toBe(1239.1);
  });

  it('parses TSV paste, clipboard paste, importRows and autofill', () => {
    const s = sheet();
    s.ctrl.importFromTsv('1\t2%');
    s.ctrl.importRows([['$3']], { startRow: 1 });
    s.ctrl.pasteClipboardData({ 'text/plain': '4,000' }, { row: 2, col: 0 });
    expect([s.value('A1'), s.value('B1'), s.value('A2'), s.value('A3')]).toEqual([1, 0.02, 3, 4000]);
    s.set('D1', '3/4/2026');
    s.ctrl.autofill({ startRow: 0, startCol: 3, endRow: 0, endCol: 3 }, { startRow: 0, startCol: 3, endRow: 2, endCol: 3 });
    expect([s.value('D2'), s.value('D3')]).toEqual(['2026-03-05', '2026-03-06']);
  });

  it('copies typed values with their display text', () => {
    const s = sheet();
    s.set('A1', '10%');
    s.set('B1', '$5');
    const data = s.ctrl.copyToClipboardData({ startRow: 0, startCol: 0, endRow: 0, endCol: 1 });
    expect(data['text/plain']).toBe('10%\t$5');
    expect(JSON.parse(data['application/x.pixerate.spreadsheet+json']).cells).toEqual([
      [
        { raw: '10%', value: 0.1 },
        { raw: '$5', value: 5 },
      ],
    ]);
  });

  it('re-derives values of documents saved with numeric-string values', () => {
    const doc: SpreadsheetDocument = {
      id: 'old',
      name: 'Old',
      columns: [
        { id: 'a', key: 'A', title: 'A', type: 'freeform', format: 'text' },
        { id: 'b', key: 'B', title: 'B', type: 'freeform' },
      ],
      rows: [0, 1, 2].map((i) => ({ id: `r${i}`, index: i, type: 'freeform' as const })),
      cells: {
        r0: { a: { raw: '7', value: '7' }, b: { raw: '=A1>8', value: true } },
        r1: { a: { raw: '1,000', value: '1,000' }, b: { raw: '=A2+1', value: '#VALUE!' } },
        r2: { a: { raw: 'TRUE', value: 'TRUE' }, b: { raw: "'5", value: "'5" } },
      },
    };
    const ctrl = new SpreadsheetController();
    ctrl.loadDocument(doc);
    expect(ctrl.getCell('r0', 'a').value).toBe(7);
    expect(ctrl.getCell('r0', 'b').value).toBe(false);
    expect(ctrl.getCell('r1', 'a')).toMatchObject({ value: 1000, numberFormat: '#,##0', format: 'number' });
    expect(ctrl.getCell('r1', 'b').value).toBe(1001);
    expect(ctrl.getCell('r2', 'a').value).toBe(true);
    expect(ctrl.getCell('r2', 'b').value).toBe('5');
    // The constructor path re-derives too.
    const fromOptions = new SpreadsheetController({ document: JSON.parse(JSON.stringify(doc)) });
    expect(fromOptions.getCell('r0', 'b').value).toBe(false);
  });

  it('does not re-parse data-source values, and coerces writes by field type', () => {
    const records = [{ id: 't1', title: '0042', points: 3, done: false }];
    const writes: unknown[][] = [];
    const ds: SpreadsheetDataSource = {
      id: 'tasks',
      name: 'Tasks',
      getRecords: () => records,
      getFields: () => [
        { key: 'title', label: 'Title', type: 'string' },
        { key: 'points', label: 'Points', type: 'number' },
        { key: 'done', label: 'Done', type: 'boolean' },
      ],
      updateRecord: (id, field, value) => {
        writes.push([id, field, value]);
      },
    };
    const ctrl = new SpreadsheetController({
      dataSources: [ds],
      primaryDataSourceId: 'tasks',
      document: {
        columns: [
          { id: 'title', key: 'A', title: 'Title', type: 'bound', binding: { dataSource: 'tasks', field: 'title' } },
          { id: 'points', key: 'B', title: 'Points', type: 'bound', binding: { dataSource: 'tasks', field: 'points' } },
          { id: 'done', key: 'C', title: 'Done', type: 'bound', binding: { dataSource: 'tasks', field: 'done' } },
        ],
      },
    });
    const row = ctrl.document.rows[0].id;
    expect(ctrl.getCell(row, 'title').value).toBe('0042');
    ctrl.setCellValue(row, 'title', '0043');
    ctrl.setCellValue(row, 'points', '1,500');
    ctrl.setCellValue(row, 'done', 'true');
    ctrl.setCellValue(row, 'points', 'lots');
    expect(writes).toEqual([
      ['t1', 'title', '0043'],
      ['t1', 'points', 1500],
      ['t1', 'done', true],
      ['t1', 'points', 'lots'],
    ]);
    expect(ctrl.getCell(row, 'title').value).toBe('0043');
    // Reloading keeps stored bound values as they are.
    ctrl.loadDocument(ctrl.document);
    expect(ctrl.getCell(row, 'title').value).toBe('0043');
  });
});

describe('table sort and filter helpers', () => {
  const rule = (operator: FilterRule['operator'], extra: Partial<FilterRule> = {}): FilterRule => ({
    id: 'r',
    colId: 'c',
    operator,
    ...extra,
  });

  it('sorts mixed values like Excel', () => {
    const values = ['b', 10, '', true, 'Item 10', 2, 'Item 2', '#N/A', null];
    expect([...values].sort((a, b) => compareCellValues(a, b))).toEqual([
      2, 10, 'b', 'Item 2', 'Item 10', true, '#N/A', '', null,
    ]);
    expect(compareCellValues(0.1 + 0.2, 0.3)).toBe(0);
    expect(compareCellValues('2026-1-5', '2026-01-10')).toBeLessThan(0);
  });

  it('reads filter operands with typed-input rules', () => {
    expect(matchesFilterRule(1500, rule('greaterThan', { value: '1,000' }))).toBe(true);
    expect(matchesFilterRule(0.1, rule('equals', { value: '10%' }))).toBe(true);
    expect(matchesFilterRule('2026-03-04', rule('greaterThan', { value: '3/1/2026' }))).toBe(true);
    expect(matchesFilterRule('2026-02-04', rule('between', { value: '1/1/2026', value2: '3/1/2026' }))).toBe(true);
    expect(matchesFilterRule('apple', rule('greaterThan', { value: '5' }))).toBe(false);
    expect(matchesFilterRule(true, rule('equals', { value: 'TRUE' }))).toBe(true);
    expect(matchesFilterRule(0.1 + 0.2, rule('equals', { value: 0.3 }))).toBe(true);
  });
});
