import { describe, it, expect } from 'vitest';
import {
  SpreadsheetController,
  SPREADSHEET_CLIPBOARD_MIME,
  createSpreadsheetClipboardData,
  parseCsv,
  parseHtmlTable,
  parseTsv,
  readSpreadsheetClipboard,
  rebaseClipboardRows,
  serializeCsv,
  serializeHtmlTable,
  serializeTsv
} from '../src/spreadsheet';

const raw = (ctrl: SpreadsheetController, r: number, c: number) =>
  ctrl.getCell(ctrl.document.rows[r].id, ctrl.document.columns[c].id).raw;

describe('CSV parser', () => {
  it('parses quoted fields, escaped quotes, embedded delimiters and newlines', () => {
    expect(parseCsv('a,"b,c","say ""hi""",d\r\n"line1\nline2",x,,\r\n')).toEqual([
      ['a', 'b,c', 'say "hi"', 'd'],
      ['line1\nline2', 'x', '', '']
    ]);
  });

  it('handles CR, LF and CRLF record ends, empty lines and missing final newline', () => {
    expect(parseCsv('a\rb\nc\r\nd')).toEqual([['a'], ['b'], ['c'], ['d']]);
    expect(parseCsv('a\n\nb\n')).toEqual([['a'], [''], ['b']]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('""')).toEqual([['']]);
  });

  it('strips a UTF-8 BOM and supports custom delimiters', () => {
    expect(parseCsv('﻿name;age\nAnn;3', { delimiter: ';' })).toEqual([['name', 'age'], ['Ann', '3']]);
    expect(() => parseCsv('a', { delimiter: '"' })).toThrow();
  });

  it('is lenient with stray quotes like spreadsheet apps', () => {
    expect(parseCsv('ab"c,d')).toEqual([['ab"c', 'd']]);
    expect(parseCsv('"ab"c,d')).toEqual([['abc', 'd']]);
    expect(parseCsv('"unterminated,x\ny')).toEqual([['unterminated,x\ny']]);
  });

  it('serializes with minimal quoting, BOM and custom line endings', () => {
    const rows = [['a', 'b,c', 'q"q', 'l1\nl2'], [1, null, undefined, '']];
    const csv = serializeCsv(rows);
    expect(csv).toBe('a,"b,c","q""q","l1\nl2"\r\n1,,,');
    expect(parseCsv(csv)).toEqual([['a', 'b,c', 'q"q', 'l1\nl2'], ['1', '', '', '']]);
    expect(serializeCsv([['a', 'b']], { bom: true, delimiter: '\t', lineEnding: '\n' })).toBe('﻿a\tb');
    expect(serializeCsv([['a']], { quoteAll: true })).toBe('"a"');
  });
});

describe('TSV clipboard text', () => {
  it('round-trips cells with tabs, newlines and leading quotes', () => {
    const rows = [['a\tb', 'multi\nline'], ['"quoted', 'plain']];
    expect(parseTsv(serializeTsv(rows))).toEqual(rows);
  });

  it('keeps plain text that merely starts with a quote', () => {
    expect(parseTsv('"hello world\tx\n')).toEqual([['"hello world', 'x']]);
    expect(parseTsv('a\t\tb\r\nc')).toEqual([['a', '', 'b'], ['c']]);
  });
});

describe('controller CSV import/export', () => {
  it('imports at a position, growing the grid, as one undo step', () => {
    const ctrl = new SpreadsheetController();
    ctrl.importFromCsv('x,"y,z"\n1,=A2+1\n"multi\nline",', { startRow: 9, startCol: 3 });
    expect(ctrl.document.rows.length).toBe(12);
    expect(ctrl.document.columns.length).toBe(5);
    expect(raw(ctrl, 9, 4)).toBe('y,z');
    expect(raw(ctrl, 11, 3)).toBe('multi\nline');
    ctrl.undo();
    expect(ctrl.document.rows.length).toBe(10);
  });

  it('exports values or formulas, for a range, with options', () => {
    const ctrl = new SpreadsheetController();
    ctrl.importFromCsv('1,2,=A1+B1\n"a,b",x,');
    expect(ctrl.exportToCsv({ range: { startRow: 0, startCol: 0, endRow: 1, endCol: 2 } })).toBe('1,2,3\r\n"a,b",x,');
    expect(ctrl.exportToCsv({ range: { startRow: 0, startCol: 2, endRow: 0, endCol: 2 }, formulas: true })).toBe('=A1+B1');
    expect(ctrl.exportToCsv({ range: { startRow: 0, startCol: 0, endRow: 0, endCol: 1 }, delimiter: ';', bom: true })).toBe('﻿1;2');
    expect(ctrl.exportToCsv().split('\r\n').length).toBe(ctrl.document.rows.length);
  });

  it('keeps importFromTsv working', () => {
    const ctrl = new SpreadsheetController();
    ctrl.importFromTsv('a\tb\n\tc\n');
    expect([raw(ctrl, 0, 0), raw(ctrl, 0, 1), raw(ctrl, 1, 0), raw(ctrl, 1, 1)]).toEqual(['a', 'b', '', 'c']);
  });
});

describe('HTML tables', () => {
  it('serializes escaped values and parses them back', () => {
    const html = serializeHtmlTable([['<b>&', 'two\nlines'], [3, null]]);
    expect(html).toBe('<table><tbody><tr><td>&lt;b&gt;&amp;</td><td>two<br>lines</td></tr><tr><td>3</td><td></td></tr></tbody></table>');
    expect(parseHtmlTable(html)).toEqual([['<b>&', 'two\nlines'], ['3', '']]);
  });

  it('parses tables from other apps: attributes, whitespace, entities, colspan and rowspan', () => {
    const html = `<html><body><!--StartFragment--><table style="x">
      <tr><th colspan="2">Head&nbsp;er</th><td rowspan=2><p>p1</p><p>p2</p></td></tr>
      <tr>
        <td><span style="font-weight:bold">a &#38; b</span></td>
        <td>c&#x27;d</td>
      </tr></table></body></html>`;
    expect(parseHtmlTable(html)).toEqual([
      ['Head er', '', 'p1\np2'],
      ['a & b', "c'd", '']
    ]);
    expect(parseHtmlTable('<p>no table</p>')).toBeNull();
  });
});

describe('spreadsheet clipboard', () => {
  it('writes TSV, HTML and the custom JSON format', () => {
    const data = createSpreadsheetClipboardData(
      [[{ raw: '=A1', value: 3 }, { raw: 'x', value: 'x' }]],
      { row: 1, col: 1 }
    );
    expect(data['text/plain']).toBe('3\tx');
    expect(data['text/html']).toContain('<td>3</td>');
    expect(JSON.parse(data[SPREADSHEET_CLIPBOARD_MIME])).toMatchObject({ origin: { row: 1, col: 1 } });
  });

  it('prefers the custom format, then HTML, then TSV', () => {
    const full = createSpreadsheetClipboardData([[{ raw: '=B2', value: 1 }]], { row: 0, col: 0 });
    expect(readSpreadsheetClipboard(full)).toEqual({ format: 'internal', rows: [['=B2']], origin: { row: 0, col: 0 } });
    expect(readSpreadsheetClipboard({ 'text/html': full['text/html'], 'text/plain': 'ignored' })).toEqual({
      format: 'html',
      rows: [['1']]
    });
    // A DataTransfer-like source with broken JSON falls back.
    const transfer = { getData: (type: string) => ({ 'text/plain': 'a\tb', [SPREADSHEET_CLIPBOARD_MIME]: '{bad' } as Record<string, string>)[type] ?? '' };
    expect(readSpreadsheetClipboard(transfer)).toEqual({ format: 'text', rows: [['a', 'b']] });
    expect(readSpreadsheetClipboard({})).toBeNull();
  });

  it('re-bases formulas to the paste target', () => {
    expect(rebaseClipboardRows([['=A1+$B$1', 'text']], { row: 0, col: 0 }, { row: 2, col: 1 })).toEqual([
      ['=B3+$B$1', 'text']
    ]);
  });

  it('copies and pastes losslessly between controllers, as one undo step', () => {
    const source = new SpreadsheetController();
    source.importFromTsv('1\t=A1*2\n2\t=A2*2');
    source.selectRange({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    const data = source.copyToClipboardData();
    expect(data['text/plain']).toBe('1\t2\n2\t4');

    const target = new SpreadsheetController();
    expect(target.pasteClipboardData(data, { row: 3, col: 2 })).toBe(true);
    expect(raw(target, 3, 3)).toBe('=C4*2');
    expect(target.getCell(target.document.rows[4].id, target.document.columns[3].id).value).toBe(4);
    expect(target.selectedRange).toEqual({ startRow: 3, startCol: 2, endRow: 4, endCol: 3 });
    target.undo();
    expect(raw(target, 3, 3)).toBe('');

    // Without the custom format, values (not formulas) are pasted.
    target.selectCell(0, 0);
    target.pasteClipboardData({ 'text/plain': data['text/plain'] });
    expect(raw(target, 0, 1)).toBe('2');
    expect(target.pasteClipboardData({ 'text/plain': '' })).toBe(false);
  });
});
