// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NameManager, SheetTabs, SpreadsheetEditor, useSpreadsheetEditor } from '../src';

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
  vi.restoreAllMocks();
});

function Harness({ manager = false }: { manager?: boolean }) {
  sheet = useSpreadsheetEditor();
  return (
    <>
      <SpreadsheetEditor state={sheet} showSheetTabs />
      {manager && <NameManager state={sheet} />}
    </>
  );
}

async function mount(manager = false) {
  await act(async () => root.render(<Harness manager={manager} />));
}

const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
const tabNames = () => tabs().map((t) => t.textContent);
const tab = (name: string) => tabs().find((t) => t.textContent === name)!;

async function fire(target: EventTarget, event: Event) {
  await act(async () => {
    target.dispatchEvent(event);
  });
}

async function setInput(el: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

const valueAt = (row: number, col: number) => sheet.getCell(sheet.document.rows[row].id, sheet.document.columns[col].id).value;

describe('SheetTabs', () => {
  it('adds, switches and shows sheets', async () => {
    await mount();
    expect(tabNames()).toEqual(['Sheet 1']);
    expect(tab('Sheet 1').getAttribute('aria-selected')).toBe('true');
    await fire(container.querySelector('[aria-label="Add sheet"]')!, new MouseEvent('click', { bubbles: true }));
    expect(tabNames()).toEqual(['Sheet 1', 'Sheet 2']);
    expect(tab('Sheet 2').getAttribute('aria-selected')).toBe('true');
    expect(sheet.activeSheetId).toBe(sheet.sheets[1].id);
    await act(async () => sheet.setCellValue(sheet.document.rows[0].id, sheet.document.columns[0].id, '21'));
    await fire(tab('Sheet 1'), new MouseEvent('click', { bubbles: true }));
    expect(tab('Sheet 1').getAttribute('aria-selected')).toBe('true');
    await act(async () => sheet.setCellValue(sheet.document.rows[0].id, sheet.document.columns[0].id, "='Sheet 2'!A1*2"));
    expect(valueAt(0, 0)).toBe(42);
    expect(container.querySelector('td[data-row="0"][data-col="0"]')?.textContent).toBe('42');
  });

  it('renames a sheet on double-click and rewrites formulas', async () => {
    await mount();
    await act(async () => {
      sheet.addSheet({ name: 'Data', activate: false });
      sheet.setCellValue(sheet.document.rows[0].id, sheet.document.columns[0].id, '=Data!A1+1');
    });
    await fire(tab('Data'), new MouseEvent('dblclick', { bubbles: true }));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Sheet name"]')!;
    expect(input.value).toBe('Data');
    await setInput(input, 'My Data');
    await fire(input, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(tabNames()).toEqual(['Sheet 1', 'My Data']);
    expect(sheet.getCell(sheet.document.rows[0].id, sheet.document.columns[0].id).raw).toBe("='My Data'!A1+1");

    // An invalid name is reported and the editor stays open.
    await fire(tab('My Data'), new MouseEvent('dblclick', { bubbles: true }));
    const again = container.querySelector<HTMLInputElement>('input[aria-label="Sheet name"]')!;
    await setInput(again, 'sheet 1');
    await fire(again, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/taken/);
    await fire(again, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(container.querySelector('input[aria-label="Sheet name"]')).toBeNull();
    expect(tabNames()).toEqual(['Sheet 1', 'My Data']);
  });

  it('reorders by dragging and deletes from the context menu after confirming', async () => {
    await mount();
    await act(async () => {
      sheet.addSheet({ name: 'B' });
      sheet.addSheet({ name: 'C' });
    });
    const dataTransfer = { setData: vi.fn(), effectAllowed: '' };
    const drag = (type: string, target: Element, clientX = 0) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { dataTransfer, clientX });
      return fire(target, event);
    };
    // Drop C on the left half of Sheet 1 (jsdom rects are 0-wide: clientX 0 is "before").
    await drag('dragstart', tab('C'));
    await drag('dragover', tab('Sheet 1'), -1);
    await drag('drop', tab('Sheet 1'), -1);
    expect(tabNames()).toEqual(['C', 'Sheet 1', 'B']);

    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const openMenu = () => fire(tab('B'), new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await openMenu();
    const menu = container.querySelector('[role="menu"][aria-label="Sheet actions"]')!;
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent)).toEqual([
      'Insert sheet',
      'Rename…',
      'Duplicate',
      'Move left',
      'Move right',
      'Delete',
    ]);
    await fire(menu.querySelector('[data-action="sheet-delete"]')!, new MouseEvent('click', { bubbles: true }));
    expect(tabNames()).toEqual(['C', 'Sheet 1', 'B']);
    await openMenu();
    await fire(container.querySelector('[data-action="sheet-delete"]')!, new MouseEvent('click', { bubbles: true }));
    expect(tabNames()).toEqual(['C', 'Sheet 1']);
    expect(window.confirm).toHaveBeenCalledTimes(2);
  });

  it('renders standalone and read-only without editing controls', async () => {
    function ReadOnly() {
      sheet = useSpreadsheetEditor();
      return <SheetTabs state={sheet} readOnly />;
    }
    await act(async () => root.render(<ReadOnly />));
    expect(tabNames()).toEqual(['Sheet 1']);
    expect(container.querySelector('[aria-label="Add sheet"]')).toBeNull();
    expect(tab('Sheet 1').getAttribute('draggable')).toBe('false');
  });
});

describe('NameManager', () => {
  it('adds, edits (renaming formulas) and deletes names', async () => {
    await mount(true);
    await act(async () => {
      sheet.setCellValue(sheet.document.rows[0].id, sheet.document.columns[0].id, '10');
      sheet.setCellValue(sheet.document.rows[0].id, sheet.document.columns[1].id, '=Price*2');
    });
    expect(valueAt(0, 1)).toBe('#NAME?');
    const field = (label: string) => container.querySelector<HTMLInputElement>(`[data-name-manager] #pixerate-name-manager-${label}`)!;
    await setInput(field('name'), 'Price');
    await setInput(field('refers'), "='Sheet 1'!$A$1");
    await fire(container.querySelector('[data-name-manager] form')!, new Event('submit', { bubbles: true, cancelable: true }));
    expect(valueAt(0, 1)).toBe(20);
    const row = () => container.querySelector('[data-name-manager] tr[data-name]')!;
    expect(row().textContent).toContain('Price');
    expect(row().textContent).toContain('10');
    expect(row().textContent).toContain('Workbook');

    await fire(container.querySelector('[aria-label="Edit Price"]')!, new MouseEvent('click', { bubbles: true }));
    expect(field('name').value).toBe('Price');
    await setInput(field('name'), 'Cost');
    await fire(container.querySelector('[data-name-manager] form')!, new Event('submit', { bubbles: true, cancelable: true }));
    expect(sheet.getCell(sheet.document.rows[0].id, sheet.document.columns[1].id).raw).toBe('=Cost*2');
    expect(valueAt(0, 1)).toBe(20);

    // Invalid names are reported, not saved.
    await setInput(field('name'), 'A1');
    await setInput(field('refers'), '=1');
    await fire(container.querySelector('[data-name-manager] form')!, new Event('submit', { bubbles: true, cancelable: true }));
    expect(container.querySelector('[data-name-manager] [role="alert"]')?.textContent).toMatch(/cell reference/);

    await fire(container.querySelector('[aria-label="Delete Cost"]')!, new MouseEvent('click', { bubbles: true }));
    expect(container.querySelector('[data-name-manager] tr[data-name]')).toBeNull();
    expect(valueAt(0, 1)).toBe('#NAME?');
  });

  it('suggests defined names in the formula bar autocomplete', async () => {
    await mount();
    await act(async () => sheet.defineName('Revenue', '=100'));
    await act(async () => sheet.selectCell(0, 0));
    const bar = container.querySelector<HTMLInputElement>('input[aria-label="Formula bar"]')!;
    await act(async () => bar.focus());
    await setInput(bar, '=Rev');
    await act(async () => {
      bar.setSelectionRange(4, 4);
      bar.dispatchEvent(new Event('keyup', { bubbles: true }));
    });
    const option = container.querySelector('[role="option"]');
    expect(option?.textContent).toContain('Revenue');
  });
});
