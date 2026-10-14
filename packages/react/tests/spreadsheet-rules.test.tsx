// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SpreadsheetEditor, useSpreadsheetEditor } from '../src';

let container: HTMLDivElement;
let root: Root;
let sheet: ReturnType<typeof useSpreadsheetEditor>;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function Harness() {
  sheet = useSpreadsheetEditor();
  return <SpreadsheetEditor state={sheet} />;
}

async function mountSheet(values: string[][] = []) {
  await act(async () => root.render(<Harness />));
  await act(async () => {
    sheet.importFromTsv(values.map((row) => row.join('\t')).join('\n'));
  });
}

const col = (startRow: number, endRow: number, c = 0) => ({ startRow, startCol: c, endRow, endCol: c });
const raw = (row: number, c: number) => sheet.getCell(sheet.document.rows[row].id, sheet.document.columns[c].id).raw;
const grid = () => container.querySelector<HTMLElement>('[aria-label="Spreadsheet"]')!;
const td = (row: number, c: number) => container.querySelector<HTMLElement>(`td[data-row="${row}"][data-col="${c}"]`)!;
const key = async (k: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    grid().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });
const click = async (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

describe('React spreadsheet: conditional formatting', () => {
  it('renders fills, font styles, data bars and icons', async () => {
    await mountSheet([['10'], ['50'], ['100']]);
    await act(async () => {
      sheet.addConditionalFormat({ type: 'cellIs', operator: 'greaterThan', value: '40', style: { fill: '#ffc7ce', color: '#9c0006', bold: true }, ranges: [col(0, 2)] });
      sheet.addConditionalFormat({ type: 'dataBar', ranges: [col(0, 2)], color: '#638ec6' });
      sheet.addConditionalFormat({ type: 'iconSet', set: '3Arrows', ranges: [col(0, 2)] });
    });
    expect(td(0, 0).style.background).toBe('');
    expect(td(1, 0).getAttribute('data-cf-fill')).toBe('#ffc7ce');
    expect(td(1, 0).style.fontWeight).toBe('700');
    expect(td(2, 0).querySelector('.spreadsheet-data-bar')).not.toBeNull();
    expect((td(2, 0).querySelector('.spreadsheet-data-bar') as HTMLElement).style.width).toBe('100%');
    expect(td(2, 0).querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('3Arrows:2');
    expect(td(0, 0).querySelector('[data-icon]')?.getAttribute('aria-label')).toBe('Down arrow');
    expect(td(1, 0).textContent).toContain('50');
  });

  it('updates the overlay after an edit', async () => {
    await mountSheet([['1'], ['2']]);
    await act(async () => {
      sheet.addConditionalFormat({ type: 'cellIs', operator: 'greaterThan', value: '5', style: { fill: '#00ff00' }, ranges: [col(0, 1)] });
    });
    expect(td(0, 0).getAttribute('data-cf-fill')).toBeNull();
    await act(async () => sheet.setCellValue(sheet.document.rows[0].id, sheet.document.columns[0].id, '9'));
    expect(td(0, 0).getAttribute('data-cf-fill')).toBe('#00ff00');
  });

  it('opens the manager from the context menu, adds, reorders and deletes rules', async () => {
    await mountSheet([['1'], ['2']]);
    await act(async () => sheet.selectRange(col(0, 1)));
    await act(async () => {
      td(0, 0).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    });
    await click(container.querySelector('[data-action="conditional-format-manage"]')!);
    const panel = container.querySelector('[aria-label="Conditional formatting rules"]')!;
    expect(panel).not.toBeNull();
    const kind = panel.querySelector<HTMLSelectElement>('select[aria-label="Rule type"]')!;
    await act(async () => {
      kind.value = 'duplicate';
      kind.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const addButton = Array.from(panel.querySelectorAll('button')).find((b) => b.textContent === 'Add rule')!;
    await click(addButton);
    await click(addButton);
    expect(sheet.getConditionalFormats()).toHaveLength(2);
    expect(panel.querySelectorAll('li[data-rule-id]')).toHaveLength(2);
    const [first, second] = sheet.getConditionalFormats().map((r) => r.id);
    await click(panel.querySelector(`li[data-rule-id="${second}"] button[aria-label="Move up"]`)!);
    expect(sheet.getConditionalFormats().map((r) => r.id)).toEqual([second, first]);
    await click(panel.querySelector(`li[data-rule-id="${first}"] button[aria-label="Delete rule"]`)!);
    expect(sheet.getConditionalFormats().map((r) => r.id)).toEqual([second]);
  });
});

describe('React spreadsheet: data validation', () => {
  it('rejects invalid input with a stop alert, then retries', async () => {
    await mountSheet([['']]);
    await act(async () => {
      sheet.addDataValidation({ ranges: [col(0, 0)], type: 'whole', operator: 'between', formula1: '1', formula2: '10', errorMessage: 'Pick 1 to 10' });
      sheet.startEditing(0, 0, '50');
    });
    await key('Enter');
    const dialog = container.querySelector('[role="alertdialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('data-error-style')).toBe('stop');
    expect(dialog.textContent).toContain('Pick 1 to 10');
    expect(raw(0, 0)).toBe('');
    expect(sheet.editingCell).not.toBeNull();
    // The cursor did not move.
    expect(sheet.activeCell?.row).toBe(0);
    await click(dialog.querySelector('[data-action="retry"]')!);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(sheet.editingCell).not.toBeNull();
    await act(async () => sheet.setDraftValue('7'));
    await key('Enter');
    expect(raw(0, 0)).toBe('7');
  });

  it('keeps input after a warning when the user answers Yes', async () => {
    await mountSheet([['']]);
    await act(async () => {
      sheet.addDataValidation({ ranges: [col(0, 0)], type: 'list', formula1: 'a,b', errorStyle: 'warning' });
      sheet.startEditing(0, 0, 'zzz');
    });
    await key('Enter');
    const dialog = container.querySelector('[role="alertdialog"]')!;
    expect(dialog.getAttribute('data-error-style')).toBe('warning');
    await click(dialog.querySelector('[data-action="accept"]')!);
    expect(raw(0, 0)).toBe('zzz');
    expect(sheet.editingCell).toBeNull();
  });

  it('shows a dropdown arrow on list cells and commits the chosen item', async () => {
    await mountSheet([['', '', '', 'Red'], ['', '', '', 'Green']]);
    await act(async () => {
      sheet.addDataValidation({ ranges: [col(0, 1)], type: 'list', formula1: '=$D$1:$D$2', inputTitle: 'Colour', inputMessage: 'Choose a colour' });
      sheet.selectCell(1, 1);
    });
    expect(container.querySelector('.spreadsheet-list-arrow')).toBeNull();
    expect(container.querySelector('[data-validation-input-message]')).toBeNull();
    await act(async () => sheet.selectCell(1, 0));
    const arrow = td(1, 0).querySelector('.spreadsheet-list-arrow')!;
    expect(arrow).not.toBeNull();
    expect(container.querySelector('[data-validation-input-message]')?.textContent).toBe('ColourChoose a colour');
    await click(arrow);
    const options = Array.from(container.querySelectorAll('[role="listbox"] [role="option"]'));
    expect(options.map((o) => o.textContent)).toEqual(['Red', 'Green']);
    await click(options[1]);
    expect(raw(1, 0)).toBe('Green');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('circles invalid data and adds rules from the manager', async () => {
    await mountSheet([['5'], ['50']]);
    await act(async () => sheet.selectRange(col(0, 1)));
    await act(async () => {
      td(0, 0).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    });
    await click(container.querySelector('[data-action="data-validation-manage"]')!);
    const panel = container.querySelector('[aria-label="Data validation rules"]')!;
    const allow = panel.querySelector<HTMLSelectElement>('select[aria-label="Allow"]')!;
    await act(async () => {
      allow.value = 'whole';
      allow.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const operator = panel.querySelector<HTMLSelectElement>('select[aria-label="Operator"]')!;
    await act(async () => {
      operator.value = 'lessThan';
      operator.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Text inputs can't be typed into in jsdom here (see GOTCHAS): set the rule bound directly.
    await click(Array.from(panel.querySelectorAll('button')).find((b) => b.textContent === 'Apply')!);
    const rule = sheet.getDataValidations()[0];
    expect(rule).toMatchObject({ type: 'whole', operator: 'lessThan', ranges: [col(0, 1)] });
    await act(async () => sheet.updateDataValidation(rule.id, { formula1: '10' }));
    await click(Array.from(panel.querySelectorAll('button')).find((b) => b.textContent === 'Circle invalid data')!);
    expect(td(1, 0).querySelector('.spreadsheet-invalid-circle')).not.toBeNull();
    expect(td(0, 0).querySelector('.spreadsheet-invalid-circle')).toBeNull();
  });
});
