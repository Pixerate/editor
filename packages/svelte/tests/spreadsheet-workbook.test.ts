import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { NameManager, SheetTabs, SpreadsheetEditor, createReactiveSpreadsheet } from '../src/spreadsheet';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
  vi.restoreAllMocks();
});

function render(component: any, props: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(component, { target, props });
  flushSync();
  cleanups.push(() => {
    unmount(instance);
    target.remove();
  });
  return target;
}

function setup(options: { manager?: boolean } = {}) {
  const sheetState = createReactiveSpreadsheet();
  const target = render(SpreadsheetEditor, { sheetState, showSheetTabs: true });
  const manager = options.manager ? render(NameManager, { sheetState }) : null;
  const tabs = () => Array.from(target.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const tabNames = () => tabs().map((t) => t.textContent?.trim());
  const tab = (name: string) => tabs().find((t) => t.textContent?.trim() === name)!;
  const fire = (el: EventTarget, event: Event) => {
    el.dispatchEvent(event);
    flushSync();
  };
  const setInput = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
    el.value = value;
    fire(el, new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  };
  const valueAt = (row: number, col: number) =>
    sheetState.getCell(sheetState.document.rows[row].id, sheetState.document.columns[col].id).value;
  return { sheetState, target, manager, tabs, tabNames, tab, fire, setInput, valueAt };
}

describe('Svelte SheetTabs', () => {
  it('adds, switches and shows sheets', () => {
    const { sheetState, target, tabNames, tab, fire, valueAt } = setup();
    expect(tabNames()).toEqual(['Sheet 1']);
    expect(tab('Sheet 1').getAttribute('aria-selected')).toBe('true');
    fire(target.querySelector('[aria-label="Add sheet"]')!, new MouseEvent('click', { bubbles: true }));
    expect(tabNames()).toEqual(['Sheet 1', 'Sheet 2']);
    expect(tab('Sheet 2').getAttribute('aria-selected')).toBe('true');
    expect(sheetState.activeSheetId).toBe(sheetState.sheets[1].id);
    sheetState.setCellValue(sheetState.document.rows[0].id, sheetState.document.columns[0].id, '21');
    fire(tab('Sheet 1'), new MouseEvent('click', { bubbles: true }));
    expect(tab('Sheet 1').getAttribute('aria-selected')).toBe('true');
    sheetState.setCellValue(sheetState.document.rows[0].id, sheetState.document.columns[0].id, "='Sheet 2'!A1*2");
    flushSync();
    expect(valueAt(0, 0)).toBe(42);
    expect(target.querySelector('td[data-row="0"][data-col="0"]')?.textContent?.trim()).toBe('42');
  });

  it('renames a sheet on double-click and rewrites formulas', () => {
    const { sheetState, target, tabNames, tab, fire, setInput } = setup();
    sheetState.addSheet({ name: 'Data', activate: false });
    sheetState.setCellValue(sheetState.document.rows[0].id, sheetState.document.columns[0].id, '=Data!A1+1');
    flushSync();
    fire(tab('Data'), new MouseEvent('dblclick', { bubbles: true }));
    const input = target.querySelector<HTMLInputElement>('input[aria-label="Sheet name"]')!;
    expect(input.value).toBe('Data');
    setInput(input, 'My Data');
    fire(input, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(tabNames()).toEqual(['Sheet 1', 'My Data']);
    expect(sheetState.getCell(sheetState.document.rows[0].id, sheetState.document.columns[0].id).raw).toBe("='My Data'!A1+1");

    fire(tab('My Data'), new MouseEvent('dblclick', { bubbles: true }));
    const again = target.querySelector<HTMLInputElement>('input[aria-label="Sheet name"]')!;
    setInput(again, 'sheet 1');
    fire(again, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(target.querySelector('[role="alert"]')?.textContent).toMatch(/taken/);
    fire(again, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(target.querySelector('input[aria-label="Sheet name"]')).toBeNull();
  });

  it('reorders by dragging and deletes from the context menu after confirming', () => {
    const { sheetState, target, tabNames, tab, fire } = setup();
    sheetState.addSheet({ name: 'B' });
    sheetState.addSheet({ name: 'C' });
    flushSync();
    const dataTransfer = { setData: vi.fn(), effectAllowed: '' };
    const drag = (type: string, el: Element, clientX = 0) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { dataTransfer, clientX });
      fire(el, event);
    };
    drag('dragstart', tab('C'));
    drag('dragover', tab('Sheet 1'), -1);
    drag('drop', tab('Sheet 1'), -1);
    expect(tabNames()).toEqual(['C', 'Sheet 1', 'B']);

    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const openMenu = () => fire(tab('B'), new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    openMenu();
    const menu = target.querySelector('[role="menu"][aria-label="Sheet actions"]')!;
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent?.trim())).toEqual([
      'Insert sheet',
      'Rename…',
      'Duplicate',
      'Move left',
      'Move right',
      'Delete',
    ]);
    fire(menu.querySelector('[data-action="sheet-delete"]')!, new MouseEvent('click', { bubbles: true }));
    expect(tabNames()).toEqual(['C', 'Sheet 1', 'B']);
    openMenu();
    fire(target.querySelector('[data-action="sheet-delete"]')!, new MouseEvent('click', { bubbles: true }));
    expect(tabNames()).toEqual(['C', 'Sheet 1']);
  });

  it('renders standalone and read-only without editing controls', () => {
    const sheetState = createReactiveSpreadsheet();
    const target = render(SheetTabs, { sheetState, readOnly: true });
    expect(Array.from(target.querySelectorAll('[role="tab"]')).map((t) => t.textContent?.trim())).toEqual(['Sheet 1']);
    expect(target.querySelector('[aria-label="Add sheet"]')).toBeNull();
    expect(target.querySelector('[role="tab"]')!.getAttribute('draggable')).toBe('false');
  });
});

describe('Svelte NameManager', () => {
  it('adds, edits (renaming formulas) and deletes names', () => {
    const { sheetState, manager, fire, setInput, valueAt } = setup({ manager: true });
    sheetState.setCellValue(sheetState.document.rows[0].id, sheetState.document.columns[0].id, '10');
    sheetState.setCellValue(sheetState.document.rows[0].id, sheetState.document.columns[1].id, '=Price*2');
    flushSync();
    expect(valueAt(0, 1)).toBe('#NAME?');
    const field = (label: string) => manager!.querySelector<HTMLInputElement>(`#pixerate-name-manager-${label}`)!;
    const submit = () => fire(manager!.querySelector('form')!, new Event('submit', { bubbles: true, cancelable: true }));
    setInput(field('name'), 'Price');
    setInput(field('refers'), "='Sheet 1'!$A$1");
    submit();
    expect(valueAt(0, 1)).toBe(20);
    const row = () => manager!.querySelector('tr[data-name]')!;
    expect(row().textContent).toContain('Price');
    expect(row().textContent).toContain('10');
    expect(row().textContent).toContain('Workbook');

    fire(manager!.querySelector('[aria-label="Edit Price"]')!, new MouseEvent('click', { bubbles: true }));
    expect(field('name').value).toBe('Price');
    setInput(field('name'), 'Cost');
    submit();
    expect(sheetState.getCell(sheetState.document.rows[0].id, sheetState.document.columns[1].id).raw).toBe('=Cost*2');
    expect(valueAt(0, 1)).toBe(20);

    setInput(field('name'), 'A1');
    setInput(field('refers'), '=1');
    submit();
    expect(manager!.querySelector('[role="alert"]')?.textContent).toMatch(/cell reference/);

    fire(manager!.querySelector('[aria-label="Delete Cost"]')!, new MouseEvent('click', { bubbles: true }));
    expect(manager!.querySelector('tr[data-name]')).toBeNull();
    expect(valueAt(0, 1)).toBe('#NAME?');
  });

  it('suggests defined names in the formula bar autocomplete', () => {
    const { sheetState, target, fire, setInput } = setup();
    sheetState.defineName('Revenue', '=100');
    sheetState.selectCell(0, 0);
    flushSync();
    const bar = target.querySelector<HTMLInputElement>('input[aria-label="Formula bar"]')!;
    bar.focus();
    flushSync();
    setInput(bar, '=Rev');
    bar.setSelectionRange(4, 4);
    fire(bar, new Event('keyup', { bubbles: true }));
    expect(target.querySelector('[role="option"]')?.textContent).toContain('Revenue');
  });
});

describe('createReactiveSpreadsheet: defined names in the saved document', () => {
  it('saves names through onDocumentChange and restores them from `document`', () => {
    let saved: any = null;
    const sheetState = createReactiveSpreadsheet({ onDocumentChange: (doc) => (saved = JSON.parse(JSON.stringify(doc))) });
    sheetState.defineName('Rate', '=0.5');
    sheetState.defineName('Twice', '=LAMBDA(x, x*2)');
    sheetState.defineName('Local', '=4', { sheet: sheetState.activeSheetId });
    sheetState.setCellValue(sheetState.document.rows[0].id, sheetState.document.columns[0].id, '=Twice(Local)*Rate');
    expect(saved.names.map((n: any) => n.name)).toEqual(['Rate', 'Twice', 'Local']);
    expect(sheetState.document.names?.map((n) => n.name)).toEqual(['Rate', 'Twice', 'Local']);
    sheetState.deleteName('Rate');
    expect(saved.names.map((n: any) => n.name)).toEqual(['Twice', 'Local']);
    expect(sheetState.document.names?.map((n) => n.name)).toEqual(['Twice', 'Local']);
    sheetState.undo();
    expect(saved.names.map((n: any) => n.name)).toEqual(['Rate', 'Twice', 'Local']);

    const reloaded = createReactiveSpreadsheet({ document: saved });
    expect(reloaded.names.map((n) => n.name)).toEqual(['Rate', 'Twice', 'Local']);
    expect(reloaded.names.find((n) => n.name === 'Local')?.sheetId).toBe(reloaded.activeSheetId);
    expect(reloaded.getCell(reloaded.document.rows[0].id, reloaded.document.columns[0].id).value).toBe(4);
  });
});
