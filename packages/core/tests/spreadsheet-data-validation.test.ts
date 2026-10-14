import { describe, it, expect } from 'vitest';
import {
  SpreadsheetController,
  validateCellInput,
  findInvalidCells,
  getValidationListValues,
  describeDataValidation,
  getSpreadsheetMenuItems,
  runSpreadsheetMenuItem,
  DEFAULT_DATA_VALIDATION_MESSAGE,
  type CellRange,
  type DataValidationRule,
  type DataValidationSheet
} from '../src/spreadsheet';

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

const col = (startRow: number, endRow: number, c = 0): CellRange => ({ startRow, startCol: c, endRow, endCol: c });
const raw = (ctrl: SpreadsheetController, r: number, c: number) =>
  ctrl.getCell(ctrl.document.rows[r].id, ctrl.document.columns[c].id).raw;

const plain: DataValidationSheet = { rowCount: 10, colCount: 4, getValue: () => '' };
const rules = (r: Omit<DataValidationRule, 'id' | 'ranges'>): DataValidationRule[] => [{ id: 'v', ranges: [col(0, 9)], ...r }];
const ok = (r: Omit<DataValidationRule, 'id' | 'ranges'>, input: string, s: DataValidationSheet = plain) =>
  validateCellInput(s, rules(r), 0, 0, input).valid;

describe('data validation types', () => {
  it('whole numbers and decimals with every operator', () => {
    const whole = { type: 'whole' as const, operator: 'between' as const, formula1: '1', formula2: '10' };
    expect([ok(whole, '5'), ok(whole, '5.5'), ok(whole, '11'), ok(whole, 'abc')]).toEqual([true, false, false, false]);
    const dec = (operator: any, f1: string, f2?: string) => (input: string) => ok({ type: 'decimal', operator, formula1: f1, formula2: f2 }, input);
    expect(dec('notBetween', '1', '10')('0.5')).toBe(true);
    expect(dec('equal', '2.5')('2.5')).toBe(true);
    expect(dec('notEqual', '2.5')('2.5')).toBe(false);
    expect(dec('greaterThan', '2')('2')).toBe(false);
    expect(dec('greaterThanOrEqual', '2')('2')).toBe(true);
    expect(dec('lessThan', '2')('1.99')).toBe(true);
    expect(dec('lessThanOrEqual', '2')('2.01')).toBe(false);
    // Typed input is parsed like a commit: 50% is 0.5.
    expect(dec('lessThan', '1')('50%')).toBe(true);
  });

  it('dates and times', () => {
    const date = { type: 'date' as const, operator: 'between' as const, formula1: '1/1/2026', formula2: '2026-12-31' };
    expect([ok(date, '3/4/2026'), ok(date, '2025-12-31'), ok(date, 'soon')]).toEqual([true, false, false]);
    const time = { type: 'time' as const, operator: 'between' as const, formula1: '9:00', formula2: '17:00' };
    expect([ok(time, '10:30'), ok(time, '18:00'), ok(time, '2026-01-01 12:00')]).toEqual([true, false, true]);
  });

  it('text length counts characters', () => {
    const len = { type: 'textLength' as const, operator: 'lessThanOrEqual' as const, formula1: '3' };
    expect([ok(len, 'abc'), ok(len, 'abcd'), ok(len, '😀😀')]).toEqual([true, false, true]);
  });

  it('lists: literal items (case-insensitive, numbers by value)', () => {
    const list = { type: 'list' as const, formula1: 'Low, Medium,High,10' };
    expect([ok(list, 'low'), ok(list, 'High'), ok(list, 'urgent'), ok(list, '10.0')]).toEqual([true, true, false, true]);
    expect(getValidationListValues(plain, { id: 'x', ranges: [], type: 'list', formula1: '"a,b, c"' })).toEqual(['a', 'b', 'c']);
  });

  it('ignores blanks unless ignoreBlank is false; any-value rules and silenced alerts accept anything', () => {
    expect(ok({ type: 'whole', operator: 'greaterThan', formula1: '0' }, '')).toBe(true);
    expect(ok({ type: 'whole', operator: 'greaterThan', formula1: '0', ignoreBlank: false }, '')).toBe(false);
    expect(ok({ type: 'any' }, 'x')).toBe(true);
    expect(ok({ type: 'whole', operator: 'greaterThan', formula1: '0', showErrorAlert: false }, 'x')).toBe(true);
    expect(validateCellInput(plain, undefined, 0, 0, 'x')).toEqual({ valid: true });
  });

  it('fills in the alert style, title and message', () => {
    const result = validateCellInput(plain, rules({ type: 'whole', operator: 'greaterThan', formula1: '0' }), 0, 0, '-1');
    expect(result).toMatchObject({ valid: false, errorStyle: 'stop', message: DEFAULT_DATA_VALIDATION_MESSAGE });
    const custom = validateCellInput(
      plain,
      rules({ type: 'whole', operator: 'greaterThan', formula1: '0', errorStyle: 'warning', errorTitle: 'Careful', errorMessage: 'Positive only' }),
      0,
      0,
      '-1'
    );
    expect(custom).toMatchObject({ valid: false, errorStyle: 'warning', title: 'Careful', message: 'Positive only' });
  });
});

describe('data validation in the controller', () => {
  it('formulas are relative and see the new value', () => {
    // gridcraft tests.rs: validation_formulas_are_relative_and_see_the_new_value
    const ctrl = sheet([
      ['', '1'],
      ['', '100']
    ]);
    ctrl.addDataValidation({ ranges: [col(0, 1)], type: 'custom', formula1: '=A1>10' });
    ctrl.addDataValidation({ ranges: [col(0, 1, 2)], type: 'whole', operator: 'lessThanOrEqual', formula1: '=B1' });
    expect(ctrl.validateCellInput(0, 0, '20').valid).toBe(true);
    expect(ctrl.validateCellInput(1, 0, '5').valid).toBe(false);
    expect(ctrl.validateCellInput(1, 2, '50').valid).toBe(true);
    expect(ctrl.validateCellInput(0, 2, '50').valid).toBe(false);
  });

  it('custom formulas over a range see the entered value (no duplicates)', () => {
    const ctrl = sheet([['a'], ['b'], ['']]);
    ctrl.addDataValidation({ ranges: [col(0, 2)], type: 'custom', formula1: '=COUNTIF($A$1:$A$3,A1)=1' });
    expect(ctrl.validateCellInput(2, 0, 'a').valid).toBe(false);
    expect(ctrl.validateCellInput(2, 0, 'c').valid).toBe(true);
  });

  it('list items can come from a range', () => {
    const ctrl = sheet([
      ['', '', '', 'Red'],
      ['', '', '', 'Green'],
      ['', '', '', ''],
      ['', '', '', 'Blue']
    ]);
    ctrl.addDataValidation({ ranges: [col(0, 3)], type: 'list', formula1: '=$D$1:$D$4' });
    expect(ctrl.getValidationListValues(1, 0)).toEqual(['Red', 'Green', 'Blue']);
    expect(ctrl.validateCellInput(1, 0, 'green').valid).toBe(true);
    expect(ctrl.validateCellInput(1, 0, 'Purple').valid).toBe(false);
    expect(ctrl.getValidationListValues(1, 1)).toBeNull();
    ctrl.updateDataValidation(ctrl.getDataValidations()[0].id, { inCellDropdown: false });
    expect(ctrl.getValidationListValues(1, 0)).toBeNull();
    // A bare reference works too.
    expect(getValidationListValues(
      { rowCount: 4, colCount: 4, getValue: () => '', evaluateFormula: (f) => (f === '=D1:D2' ? ['x', 'y'] : '#REF!') },
      { id: 'b', ranges: [col(0, 0)], type: 'list', formula1: 'D1:D2' }
    )).toEqual(['x', 'y']);
  });

  it('stop alerts reject the commit and keep the editor open', () => {
    const ctrl = sheet([['']]);
    ctrl.addDataValidation({ ranges: [col(0, 0)], type: 'whole', operator: 'between', formula1: '1', formula2: '10' });
    ctrl.startEditing(0, 0, '50');
    const result = ctrl.commitEditing();
    expect(result.status).toBe('rejected');
    expect(ctrl.editingCell).not.toBeNull();
    expect(raw(ctrl, 0, 0)).toBe('');
    expect(ctrl.validationPrompt?.result.errorStyle).toBe('stop');
    // While the alert is open, further commits (e.g. blur) are ignored.
    expect(ctrl.commitEditing().status).toBe('pending');
    // Accept is not allowed for stop: it retries.
    ctrl.resolveValidationPrompt('accept');
    expect(raw(ctrl, 0, 0)).toBe('');
    expect(ctrl.draftValue).toBe('50');
    expect(ctrl.editingCell).not.toBeNull();
    ctrl.draftValue = '5';
    expect(ctrl.commitEditing().status).toBe('committed');
    expect(raw(ctrl, 0, 0)).toBe('5');
    expect(ctrl.editingCell).toBeNull();
  });

  it('stop alerts: cancel discards the edit', () => {
    const ctrl = sheet([['3']]);
    ctrl.addDataValidation({ ranges: [col(0, 0)], type: 'whole', operator: 'between', formula1: '1', formula2: '10' });
    ctrl.startEditing(0, 0, 'x');
    ctrl.commitEditing();
    ctrl.resolveValidationPrompt('cancel');
    expect(ctrl.editingCell).toBeNull();
    expect(ctrl.validationPrompt).toBeNull();
    expect(raw(ctrl, 0, 0)).toBe('3');
  });

  it('warning and information alerts commit when accepted', () => {
    for (const errorStyle of ['warning', 'information'] as const) {
      const ctrl = sheet([['']]);
      ctrl.addDataValidation({ ranges: [col(0, 0)], type: 'list', formula1: 'a,b', errorStyle });
      ctrl.startEditing(0, 0, 'z');
      expect(ctrl.commitEditing().status).toBe('confirm');
      expect(raw(ctrl, 0, 0)).toBe('');
      ctrl.resolveValidationPrompt('accept');
      expect(raw(ctrl, 0, 0)).toBe('z');
      expect(ctrl.editingCell).toBeNull();
      // Retry returns to the editor with the text.
      ctrl.startEditing(0, 0, 'y');
      ctrl.commitEditing();
      ctrl.resolveValidationPrompt('retry');
      expect(ctrl.editingCell).not.toBeNull();
      expect(ctrl.draftValue).toBe('y');
    }
  });

  it('validates formula bar input (commitCellInput) but not setCellValue, paste or unchanged input', () => {
    const ctrl = sheet([['7']]);
    ctrl.addDataValidation({ ranges: [col(0, 0)], type: 'whole', operator: 'lessThan', formula1: '5' });
    expect(ctrl.commitCellInput('r0', 'c0', '9').status).toBe('rejected');
    ctrl.resolveValidationPrompt('retry');
    // Retry opens the editor with the rejected text.
    expect(ctrl.editingCell?.row).toBe(0);
    expect(ctrl.draftValue).toBe('9');
    ctrl.cancelEditing();
    ctrl.setCellValue('r0', 'c0', '9');
    expect(raw(ctrl, 0, 0)).toBe('9');
    // Re-committing the value the cell already holds is not validated.
    ctrl.startEditing(0, 0);
    expect(ctrl.commitEditing().status).toBe('committed');
  });

  it('finds invalid cells for "circle invalid data"', () => {
    const ctrl = sheet([['1'], ['20'], [''], ['abc'], ['=A1*30']]);
    ctrl.addDataValidation({ ranges: [col(0, 4)], type: 'whole', operator: 'between', formula1: '1', formula2: '10' });
    expect(ctrl.findInvalidCells()).toEqual([
      { row: 1, col: 0 },
      { row: 3, col: 0 },
      { row: 4, col: 0 }
    ]);
    expect(ctrl.isInvalidDataCircled(1, 0)).toBe(false);
    ctrl.setInvalidDataCircles(true);
    expect(ctrl.getInvalidDataCircles()).toBe(true);
    expect(ctrl.isInvalidDataCircled(1, 0)).toBe(true);
    ctrl.setCellValue('r1', 'c0', '2');
    expect(ctrl.isInvalidDataCircled(1, 0)).toBe(false);
    expect(findInvalidCells(plain, [])).toEqual([]);
  });

  it('each cell has one rule: adding a rule cuts its cells out of older rules', () => {
    const ctrl = sheet([['']], 5);
    const first = ctrl.addDataValidation({ ranges: [col(0, 4)], type: 'whole', operator: 'greaterThan', formula1: '0' });
    ctrl.addDataValidation({ ranges: [col(2, 2)], type: 'list', formula1: 'a,b' });
    const rules = ctrl.getDataValidations();
    expect(rules).toHaveLength(2);
    expect(rules.find((r) => r.id === first)?.ranges).toEqual([col(0, 1), col(3, 4)]);
    expect(ctrl.getDataValidationAt(2, 0)?.type).toBe('list');
    ctrl.clearDataValidation(col(0, 4));
    expect(ctrl.getDataValidations()).toEqual([]);
    ctrl.undo();
    expect(ctrl.getDataValidations()).toHaveLength(2);
  });

  it('moves rules and their formulas with inserted and deleted rows', () => {
    const ctrl = sheet([['', '5']], 4);
    ctrl.addDataValidation({ ranges: [col(0, 1)], type: 'whole', operator: 'lessThan', formula1: '=$B$1' });
    ctrl.addDataValidation({ ranges: [col(3, 3)], type: 'list', formula1: 'A1,B1' });
    ctrl.insertRow(0);
    const [cap, list] = ctrl.getDataValidations();
    expect(cap.ranges).toEqual([col(1, 2)]);
    expect(cap.formula1).toBe('=$B$2');
    expect('formula2' in cap).toBe(false);
    // Literal list items are not references.
    expect(list.formula1).toBe('A1,B1');
    ctrl.deleteRow(ctrl.document.rows[4].id);
    expect(ctrl.getDataValidations()).toHaveLength(1);
  });

  it('describes rules and offers menu items', () => {
    expect(describeDataValidation({ id: 'a', ranges: [], type: 'whole', operator: 'between', formula1: '1', formula2: '10' })).toBe(
      'Whole number between 1 and 10'
    );
    expect(describeDataValidation({ id: 'a', ranges: [], type: 'list', formula1: 'a,b' })).toBe('List: a,b');
    const ctrl = sheet([['x'], ['y']]);
    ctrl.selectRange(col(0, 1));
    const items = getSpreadsheetMenuItems(ctrl, { row: 0, col: 0 });
    expect(items.find((i) => i.id === 'data-validation-circles')?.disabled).toBe(true);
    runSpreadsheetMenuItem(items.find((i) => i.id === 'data-validation-list')!, () => 'x,z');
    expect(ctrl.getDataValidations()[0]).toMatchObject({ type: 'list', formula1: 'x,z', ranges: [col(0, 1)] });
    const next = getSpreadsheetMenuItems(ctrl, { row: 0, col: 0 });
    runSpreadsheetMenuItem(next.find((i) => i.id === 'data-validation-circles')!);
    expect(ctrl.isInvalidDataCircled(1, 0)).toBe(true);
    expect(getSpreadsheetMenuItems(ctrl, { row: 0, col: 0 }).find((i) => i.id === 'data-validation-circles')?.label).toBe(
      'Clear validation circles'
    );
  });
});
