import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { SpreadsheetEditor, createReactiveSpreadsheet } from '../src/spreadsheet';

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function setup(values: string[][] = []) {
  const sheetState = createReactiveSpreadsheet();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(SpreadsheetEditor, { target, props: { sheetState } });
  flushSync();
  cleanup = () => {
    unmount(component);
    target.remove();
  };
  if (values.length) sheetState.importFromTsv(values.map((row) => row.join('\t')).join('\n'));
  flushSync();
  const raw = (r: number, c: number) => sheetState.getCell(sheetState.document.rows[r].id, sheetState.document.columns[c].id).raw;
  const td = (r: number, c: number) => target.querySelector<HTMLElement>(`td[data-row="${r}"][data-col="${c}"]`)!;
  const grid = target.querySelector<HTMLElement>('[aria-label="Spreadsheet"]')!;
  const key = (k: string) => {
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    flushSync();
  };
  const click = (el: Element) => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
  };
  const choose = (select: HTMLSelectElement, value: string) => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
  };
  return { sheetState, target, raw, td, key, click, choose };
}

const col = (startRow: number, endRow: number, c = 0) => ({ startRow, startCol: c, endRow, endCol: c });

describe('Svelte spreadsheet: conditional formatting', () => {
  it('renders fills, font styles, data bars and icons', () => {
    const { sheetState, td } = setup([['10'], ['50'], ['100']]);
    sheetState.addConditionalFormat({ type: 'cellIs', operator: 'greaterThan', value: '40', style: { fill: '#ffc7ce', color: '#9c0006', bold: true }, ranges: [col(0, 2)] });
    sheetState.addConditionalFormat({ type: 'dataBar', ranges: [col(0, 2)], color: '#638ec6' });
    sheetState.addConditionalFormat({ type: 'iconSet', set: '3Arrows', ranges: [col(0, 2)] });
    flushSync();
    expect(td(0, 0).getAttribute('data-cf-fill')).toBeNull();
    expect(td(1, 0).getAttribute('data-cf-fill')).toBe('#ffc7ce');
    expect(td(1, 0).style.fontWeight).toBe('700');
    expect((td(2, 0).querySelector('.spreadsheet-data-bar') as HTMLElement).style.width).toBe('100%');
    expect(td(2, 0).querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('3Arrows:2');
    expect(td(0, 0).querySelector('[data-icon]')?.getAttribute('aria-label')).toBe('Down arrow');
    expect(td(1, 0).textContent).toContain('50');
  });

  it('updates the overlay after an edit', () => {
    const { sheetState, td } = setup([['1'], ['2']]);
    sheetState.addConditionalFormat({ type: 'cellIs', operator: 'greaterThan', value: '5', style: { fill: '#00ff00' }, ranges: [col(0, 1)] });
    flushSync();
    expect(td(0, 0).getAttribute('data-cf-fill')).toBeNull();
    sheetState.setCellValue(sheetState.document.rows[0].id, sheetState.document.columns[0].id, '9');
    flushSync();
    expect(td(0, 0).getAttribute('data-cf-fill')).toBe('#00ff00');
  });

  it('opens the manager from the context menu, adds, reorders and deletes rules', () => {
    const { sheetState, target, td, click, choose } = setup([['1'], ['2']]);
    sheetState.selectRange(col(0, 1));
    td(0, 0).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    flushSync();
    click(target.querySelector('[data-action="conditional-format-manage"]')!);
    const panel = target.querySelector('[aria-label="Conditional formatting rules"]')!;
    expect(panel).not.toBeNull();
    choose(panel.querySelector<HTMLSelectElement>('select[aria-label="Rule type"]')!, 'duplicate');
    const addButton = Array.from(panel.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Add rule')!;
    click(addButton);
    click(addButton);
    expect(sheetState.getConditionalFormats()).toHaveLength(2);
    expect(sheetState.getConditionalFormats()[0]).toMatchObject({ type: 'duplicate', ranges: [col(0, 1)] });
    expect(panel.querySelectorAll('li[data-rule-id]')).toHaveLength(2);
    const [first, second] = sheetState.getConditionalFormats().map((r) => r.id);
    click(panel.querySelector(`li[data-rule-id="${second}"] button[aria-label="Move up"]`)!);
    expect(sheetState.getConditionalFormats().map((r) => r.id)).toEqual([second, first]);
    click(panel.querySelector(`li[data-rule-id="${first}"] button[aria-label="Delete rule"]`)!);
    expect(sheetState.getConditionalFormats().map((r) => r.id)).toEqual([second]);
  });
});

describe('Svelte spreadsheet: data validation', () => {
  it('rejects invalid input with a stop alert, then retries', () => {
    const { sheetState, target, raw, key, click } = setup([['']]);
    sheetState.addDataValidation({ ranges: [col(0, 0)], type: 'whole', operator: 'between', formula1: '1', formula2: '10', errorMessage: 'Pick 1 to 10' });
    sheetState.startEditing(0, 0, '50');
    flushSync();
    key('Enter');
    const dialog = target.querySelector('[role="alertdialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('data-error-style')).toBe('stop');
    expect(dialog.textContent).toContain('Pick 1 to 10');
    expect(raw(0, 0)).toBe('');
    expect(sheetState.editingCell).not.toBeNull();
    expect(sheetState.activeCell?.row).toBe(0);
    click(dialog.querySelector('[data-action="retry"]')!);
    expect(target.querySelector('[role="alertdialog"]')).toBeNull();
    expect(sheetState.editingCell).not.toBeNull();
    sheetState.draftValue = '7';
    flushSync();
    key('Enter');
    expect(raw(0, 0)).toBe('7');
  });

  it('keeps input after a warning when the user answers Yes', () => {
    const { sheetState, target, raw, key, click } = setup([['']]);
    sheetState.addDataValidation({ ranges: [col(0, 0)], type: 'list', formula1: 'a,b', errorStyle: 'warning' });
    sheetState.startEditing(0, 0, 'zzz');
    flushSync();
    key('Enter');
    const dialog = target.querySelector('[role="alertdialog"]')!;
    expect(dialog.getAttribute('data-error-style')).toBe('warning');
    click(dialog.querySelector('[data-action="accept"]')!);
    expect(raw(0, 0)).toBe('zzz');
    expect(sheetState.editingCell).toBeNull();
  });

  it('shows a dropdown arrow on list cells and commits the chosen item', () => {
    const { sheetState, target, raw, td, click } = setup([['', '', '', 'Red'], ['', '', '', 'Green']]);
    sheetState.addDataValidation({ ranges: [col(0, 1)], type: 'list', formula1: '=$D$1:$D$2', inputTitle: 'Colour', inputMessage: 'Choose a colour' });
    sheetState.selectCell(1, 1);
    flushSync();
    expect(target.querySelector('.spreadsheet-list-arrow')).toBeNull();
    expect(target.querySelector('[data-validation-input-message]')).toBeNull();
    sheetState.selectCell(1, 0);
    flushSync();
    const arrow = td(1, 0).querySelector('.spreadsheet-list-arrow')!;
    expect(arrow).not.toBeNull();
    expect(target.querySelector('[data-validation-input-message]')?.textContent?.trim()).toBe('ColourChoose a colour');
    click(arrow);
    const options = Array.from(target.querySelectorAll('[role="listbox"] [role="option"]'));
    expect(options.map((o) => o.textContent)).toEqual(['Red', 'Green']);
    click(options[1]);
    expect(raw(1, 0)).toBe('Green');
    expect(target.querySelector('[role="listbox"]')).toBeNull();
  });

  it('circles invalid data and adds rules from the manager', () => {
    const { sheetState, target, td, click, choose } = setup([['5'], ['50']]);
    sheetState.selectRange(col(0, 1));
    td(0, 0).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    flushSync();
    click(target.querySelector('[data-action="data-validation-manage"]')!);
    const panel = target.querySelector('[aria-label="Data validation rules"]')!;
    choose(panel.querySelector<HTMLSelectElement>('select[aria-label="Allow"]')!, 'whole');
    choose(panel.querySelector<HTMLSelectElement>('select[aria-label="Operator"]')!, 'lessThan');
    const value = panel.querySelector<HTMLInputElement>('input[aria-label="Value"]')!;
    value.value = '10';
    value.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    click(Array.from(panel.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Apply')!);
    expect(sheetState.getDataValidations()[0]).toMatchObject({ type: 'whole', operator: 'lessThan', formula1: '10', ranges: [col(0, 1)] });
    click(Array.from(panel.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Circle invalid data')!);
    expect(td(1, 0).querySelector('.spreadsheet-invalid-circle')).not.toBeNull();
    expect(td(0, 0).querySelector('.spreadsheet-invalid-circle')).toBeNull();
  });
});
