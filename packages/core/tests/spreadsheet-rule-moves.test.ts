import { describe, it, expect } from 'vitest';
import {
  SpreadsheetController,
  mergeRuleRanges,
  sortRuleRanges,
  transposeRuleRanges,
  transposeFormulaReferences,
  formatRuleRanges,
  parseRuleRanges,
  type CellRange
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

const R = (text: string): CellRange[] => parseRuleRanges(text)!;
const RED = { fill: '#ffc7ce' };
const cfRanges = (ctrl: SpreadsheetController, i = 0) => formatRuleRanges(ctrl.getConditionalFormats()[i].ranges);
const dvRanges = (ctrl: SpreadsheetController, i = 0) => formatRuleRanges(ctrl.getDataValidations()[i].ranges);
const sortA = (ctrl: SpreadsheetController, range?: CellRange, direction: 'asc' | 'desc' = 'asc') =>
  ctrl.sortRows([{ colId: ctrl.document.columns[0].id, direction }], { range });
/** Which rows of column `c` have a conditional look. */
const formattedRows = (ctrl: SpreadsheetController, c = 0) =>
  ctrl.document.rows.map((_, r) => r).filter((r) => ctrl.getConditionalFormat(r, c) !== undefined);

describe('rule ranges: helpers', () => {
  it('merges adjacent and overlapping ranges', () => {
    expect(formatRuleRanges(mergeRuleRanges(R('A3, A1, A2, B1:B2, C5')))).toBe('A1:A3, B1:B2, C5');
    expect(formatRuleRanges(mergeRuleRanges(R('A1:B1, A2:B2, C1:C2')))).toBe('A1:C2');
    expect(formatRuleRanges(mergeRuleRanges(R('A1:A4, A3:A6')))).toBe('A1:A6');
  });

  it('keeps the part spanning the sorted rows and moves per-row parts', () => {
    // Sorted block A2:C5, rows 1..4 → new order [4, 1, 3, 2] (old row at each new row).
    const newRowOf = (r: number) => ({ 1: 2, 2: 4, 3: 3, 4: 1 } as Record<number, number>)[r];
    const block = R('A2:C5')[0];
    expect(sortRuleRanges(R('A1:A10'), block, newRowOf)).toBeNull(); // spans every sorted row
    expect(sortRuleRanges(R('E1:E3'), block, newRowOf)).toBeNull(); // outside
    expect(formatRuleRanges(sortRuleRanges(R('B2'), block, newRowOf)!)).toBe('B3');
    expect(formatRuleRanges(sortRuleRanges(R('A2:B3'), block, newRowOf)!)).toBe('A3:B3, A5:B5');
    // Partly outside the block: the outside part stays, the rows inside move.
    expect(formatRuleRanges(sortRuleRanges(R('A1:A2'), block, newRowOf)!)).toBe('A1, A3');
    expect(formatRuleRanges(sortRuleRanges(R('B4:D4'), block, newRowOf)!)).toBe('B4:D4');
    expect(formatRuleRanges(sortRuleRanges(R('B5:D5'), block, newRowOf)!)).toBe('B2:C2, D5');
  });

  it('transposes ranges inside the block and drops what the result covers', () => {
    const s = R('A1:B3')[0];
    const t = R('A1:C2')[0];
    expect(transposeRuleRanges(R('E1:E5'), s, t)).toBeNull();
    const fmt = (x: { inside: CellRange[]; outside: CellRange[] } | null) => x && { inside: formatRuleRanges(x.inside), outside: formatRuleRanges(x.outside) };
    expect(fmt(transposeRuleRanges(R('A1:A3'), s, t))).toEqual({ inside: 'A1:C1', outside: '' });
    expect(fmt(transposeRuleRanges(R('B2'), s, t))).toEqual({ inside: 'B2', outside: '' });
    expect(fmt(transposeRuleRanges(R('A1:A6'), s, t))).toEqual({ inside: 'A1:C1', outside: 'A4:A6' });
    expect(fmt(transposeRuleRanges(R('C1:C2'), s, t))).toEqual({ inside: '', outside: '' });
  });

  it('transposes rule formula references around the block', () => {
    const block = R('A1:B3')[0];
    const at = { row: 0, col: 0 };
    // One column right becomes one row down; `$` parts inside the block follow their cell.
    expect(transposeFormulaReferences('=B1>0', at, block)).toBe('=A2>0');
    expect(transposeFormulaReferences('=$B1>0', at, block)).toBe('=A$2>0');
    expect(transposeFormulaReferences('=$A$3', at, block)).toBe('=$C$1');
    expect(transposeFormulaReferences('=SUM(A1:B1)', at, block)).toBe('=SUM(A1:A2)');
    // `$` parts outside the block, whole columns and other sheets keep their text.
    expect(transposeFormulaReferences('=$Z$1+$Z1+A:A+Data!$A$1', at, block)).toBe('=$Z$1+$Z1+A:A+Data!$A$1');
  });
});

describe('sorting moves conditional formats and validations', () => {
  const data = () => sheet([['3', 'c'], ['1', 'a'], ['2', 'b']], 3, 2);

  it('keeps a rule over the whole sorted column', () => {
    const ctrl = data();
    ctrl.addConditionalFormat({ type: 'cellIs', operator: 'greaterThan', value: '1', style: RED, ranges: R('A1:A3') }, { priority: 'last' });
    expect(formattedRows(ctrl)).toEqual([0, 2]);
    expect(sortA(ctrl)).toBe(true);
    expect(cfRanges(ctrl)).toBe('A1:A3');
    // Values 1, 2, 3: the rule still applies to the column (overlay re-evaluated).
    expect(formattedRows(ctrl)).toEqual([1, 2]);
  });

  it('moves per-row rules with their rows, re-anchoring relative formulas', () => {
    const ctrl = data();
    ctrl.addConditionalFormat({ type: 'noBlanks', style: RED, ranges: R('A1:B1') }, { priority: 'last' }); // the "3" row
    ctrl.addConditionalFormat({ type: 'expression', formula: '=$A2=1', style: RED, ranges: R('B2') }, { priority: 'last' }); // the "1" row
    expect(formattedRows(ctrl, 1)).toEqual([0, 1]);
    sortA(ctrl);
    expect(cfRanges(ctrl, 0)).toBe('A3:B3');
    expect(cfRanges(ctrl, 1)).toBe('B1');
    const expr = ctrl.getConditionalFormats()[1];
    expect(expr.type === 'expression' && expr.formula).toBe('=$A1=1');
    expect(formattedRows(ctrl, 1)).toEqual([0, 2]);
    expect(ctrl.getConditionalFormat(0, 1)).toEqual(RED);
  });

  it('splits rules partly overlapping the sorted rows', () => {
    // Header row 0 is outside the sorted range A2:B4.
    const ctrl = sheet([['h', 'h'], ['3', 'c'], ['1', 'a'], ['2', 'b']], 4, 2);
    ctrl.addConditionalFormat({ type: 'noBlanks', style: RED, ranges: R('A1:A2') }, { priority: 'last' });
    ctrl.addConditionalFormat({ type: 'noBlanks', style: RED, ranges: R('A2:B4') }, { priority: 'last' });
    sortA(ctrl, R('A2:B4')[0]);
    expect(cfRanges(ctrl, 0)).toBe('A1, A4'); // "3" moved to the last row
    expect(cfRanges(ctrl, 1)).toBe('A2:B4');
  });

  it('moves a validation list on a few cells with them', () => {
    const ctrl = data();
    ctrl.addDataValidation({ type: 'list', formula1: 'x,y', ranges: R('B1:B2') }); // rows "3" and "1"
    ctrl.addDataValidation({ type: 'whole', operator: 'greaterThan', formula1: '0', ranges: R('A1:A3') });
    sortA(ctrl, undefined, 'desc'); // 3, 2, 1
    expect(dvRanges(ctrl, 0)).toBe('B1, B3');
    expect(dvRanges(ctrl, 1)).toBe('A1:A3');
    expect(ctrl.getValidationListValues(2, 1)).toEqual(['x', 'y']);
    expect(ctrl.getValidationListValues(1, 1)).toBeNull();
  });

  it('moves rules past the last column when whole rows are sorted', () => {
    const ctrl = data();
    ctrl.addConditionalFormat({ type: 'noBlanks', style: RED, ranges: R('A1:F1') }, { priority: 'last' });
    sortA(ctrl);
    expect(cfRanges(ctrl)).toBe('A3:F3');
  });

  it('is undone with the sort in one step', () => {
    const ctrl = data();
    ctrl.addConditionalFormat({ type: 'expression', formula: '=$A1>2', style: RED, ranges: R('B1') }, { priority: 'last' });
    ctrl.addDataValidation({ type: 'list', formula1: 'x,y', ranges: R('B2') });
    sortA(ctrl);
    expect(cfRanges(ctrl)).toBe('B3');
    expect(dvRanges(ctrl)).toBe('B1');
    ctrl.undo();
    expect(cfRanges(ctrl)).toBe('B1');
    const rule = ctrl.getConditionalFormats()[0];
    expect(rule.type === 'expression' && rule.formula).toBe('=$A1>2');
    expect(dvRanges(ctrl)).toBe('B2');
    expect(ctrl.getConditionalFormat(0, 1)).toEqual(RED);
    ctrl.redo();
    expect(cfRanges(ctrl)).toBe('B3');
    expect(ctrl.getConditionalFormat(2, 1)).toEqual(RED);
  });

  it('keeps the overlay equal to a fresh evaluation after a sort', () => {
    const ctrl = sheet([['5', '=A1*2'], ['1', '=A2*2'], ['4', '=A3*2'], ['2', '=A4*2']], 4, 2);
    ctrl.addConditionalFormat({ type: 'cellIs', operator: 'greaterThan', value: '3', style: RED, ranges: R('A1:A4') }, { priority: 'last' });
    ctrl.addConditionalFormat({ type: 'expression', formula: '=$B2>2', style: { bold: true }, ranges: R('B2') }, { priority: 'last' });
    ctrl.getConditionalFormatOverlay(); // warm the cache
    sortA(ctrl);
    const overlay = [...ctrl.getConditionalFormatOverlay().entries()];
    const fresh = new SpreadsheetController({ document: JSON.parse(JSON.stringify(ctrl.document)) });
    expect(overlay).toEqual([...fresh.getConditionalFormatOverlay().entries()]);
    // The "1" row (B = 2) is now row 0: its rule moved and evaluates FALSE.
    expect(cfRanges(ctrl, 1)).toBe('B1');
    expect(ctrl.getConditionalFormat(0, 1)).toBeUndefined();
  });

  it('only moves the rules of the sorted sheet', () => {
    const ctrl = data();
    const first = ctrl.activeSheetId;
    ctrl.addConditionalFormat({ type: 'noBlanks', style: RED, ranges: R('A1') }, { priority: 'last' });
    ctrl.addSheet({ name: 'Two' });
    ['3', '1', '2'].forEach((v, r) => ctrl.setCellValue(ctrl.document.rows[r].id, ctrl.document.columns[0].id, v));
    ctrl.addConditionalFormat({ type: 'noBlanks', style: RED, ranges: R('A2') }, { priority: 'last' });
    sortA(ctrl, R('A1:A3')[0]);
    expect(cfRanges(ctrl)).toBe('A1'); // the "1" row moved to the top
    ctrl.setActiveSheet(first);
    expect(cfRanges(ctrl)).toBe('A1'); // untouched
    sortA(ctrl);
    expect(cfRanges(ctrl)).toBe('A3');
    ctrl.setActiveSheet('Two');
    expect(cfRanges(ctrl)).toBe('A1');
  });
});

describe('transposing moves conditional formats and validations', () => {
  it('transposes rule ranges and formulas inside the block', () => {
    const ctrl = sheet([['1', '5'], ['2', '0'], ['3', '7']], 3, 3);
    ctrl.addConditionalFormat({ type: 'expression', formula: '=$B1>0', style: RED, ranges: R('A1:A3') }, { priority: 'last' });
    ctrl.addDataValidation({ type: 'list', formula1: 'x,y', ranges: R('B2') });
    expect(formattedRows(ctrl)).toEqual([0, 2]);
    expect(ctrl.transposeRange(R('A1:B3')[0])).toBe(true);
    const rule = ctrl.getConditionalFormats()[0];
    expect(cfRanges(ctrl)).toBe('A1:C1');
    expect(rule.type === 'expression' && rule.formula).toBe('=A$2>0');
    // Row 1 now holds 5, 0, 7: the rule on row 0 checks the cell below.
    expect([0, 1, 2].map((c) => ctrl.getConditionalFormat(0, c) !== undefined)).toEqual([true, false, true]);
    expect(dvRanges(ctrl)).toBe('B2');
    ctrl.undo();
    expect(cfRanges(ctrl)).toBe('A1:A3');
    expect(formattedRows(ctrl)).toEqual([0, 2]);
  });

  it('splits a formula rule partly inside the block and merges a plain one', () => {
    const ctrl = sheet([['1', '1'], ['1', '1'], ['1', '1'], ['1', '1']], 4, 3);
    ctrl.addConditionalFormat({ type: 'expression', formula: '=A1>0', style: RED, ranges: R('A1:A4') }, { priority: 'last' });
    ctrl.addConditionalFormat({ type: 'noBlanks', style: RED, ranges: R('A1:A4') }, { priority: 'last' });
    ctrl.transposeRange(R('A1:A2')[0]); // A1:A2 → A1:B1
    const rules = ctrl.getConditionalFormats();
    expect(rules.map((r) => formatRuleRanges(r.ranges))).toEqual(['A3:A4', 'A1:B1', 'A1:B1, A3:A4']);
    expect(rules[0].id).not.toBe(rules[1].id);
    expect(rules.map((r) => (r.type === 'expression' ? r.formula : r.type))).toEqual(['=A3>0', '=A1>0', 'noBlanks']);
  });

  it('drops rule cells covered by the transposed block', () => {
    const ctrl = sheet([['1'], ['2'], ['3']], 3, 3);
    ctrl.addDataValidation({ type: 'list', formula1: 'x,y', ranges: R('C1') });
    ctrl.transposeRange(R('A1:A3')[0]); // → A1:C1
    expect(ctrl.getDataValidations()).toEqual([]);
  });
});
