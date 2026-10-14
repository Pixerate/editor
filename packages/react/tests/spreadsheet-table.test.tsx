// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SPREADSHEET_CLIPBOARD_MIME } from '@pixerate/editor';
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

const raw = (row: number, col: number) =>
  sheet.getCell(sheet.document.rows[row].id, sheet.document.columns[col].id).raw;
const grid = () => container.querySelector<HTMLElement>('[aria-label="Spreadsheet"]')!;
const td = (row: number, col: number) => container.querySelector<HTMLElement>(`td[data-row="${row}"][data-col="${col}"]`);
const renderedRows = () =>
  Array.from(container.querySelectorAll('tbody tr[data-row]')).map((tr) => Number(tr.getAttribute('data-row')));

async function dispatch(target: EventTarget, event: Event) {
  await act(async () => {
    target.dispatchEvent(event);
  });
}

/** A copy/paste event carrying a fake DataTransfer (jsdom has no ClipboardEvent data). */
function clipboardEvent(type: 'copy' | 'paste', data: Record<string, string> = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const clipboardData = {
    data,
    setData: (format: string, value: string) => {
      data[format] = value;
    },
    getData: (format: string) => data[format] ?? ''
  };
  Object.defineProperty(event, 'clipboardData', { value: clipboardData });
  return event as Event & { clipboardData: typeof clipboardData };
}

describe('SpreadsheetEditor table rendering', () => {
  it('renders merged cells with spans and skips covered cells', async () => {
    await mountSheet([['merged', 'x'], ['y', 'z']]);
    await act(async () => {
      sheet.mergeCells({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    });
    const anchor = td(0, 0)!;
    expect(anchor.getAttribute('rowspan')).toBe('2');
    expect(anchor.getAttribute('colspan')).toBe('2');
    expect(anchor.textContent).toBe('merged');
    expect(td(1, 1)).toBeNull();
  });

  it('hides hidden and filtered rows and columns, and marks filtered columns', async () => {
    await mountSheet([['a'], ['b'], ['a'], ['c']]);
    await act(async () => {
      sheet.hideColumns([1]);
      sheet.hideRows([3]);
      sheet.addFilterRule({ colId: sheet.document.columns[0].id, operator: 'equals', value: 'a' });
    });
    expect(renderedRows()).toEqual([0, 2]);
    expect(container.querySelector('th[data-col="1"]')).toBeNull();
    expect(container.querySelector('[data-filtered="true"]')).not.toBeNull();
  });

  it('renders frozen rows and columns as sticky', async () => {
    await mountSheet([['h1', 'h2'], ['a', 'b']]);
    await act(async () => {
      sheet.setFrozenRowCount(1);
      sheet.setFrozenColumnCount(1);
    });
    expect(td(0, 0)!.style.position).toBe('sticky');
    expect(td(0, 0)!.style.top).toBe('28px');
    expect(td(0, 0)!.style.left).toBe('48px');
    expect(td(0, 1)!.style.top).toBe('28px');
    expect(td(1, 0)!.style.left).toBe('48px');
    expect(td(1, 1)!.style.position).toBe('');
  });

  it('renders category headers with summaries and collapses them', async () => {
    await mountSheet([['red', '1'], ['blue', '2'], ['red', '3']]);
    await act(async () => {
      sheet.setFooterRowCount(7); // only the three data rows are grouped
      sheet.groupRowsBy(sheet.document.columns[0].id, [{ colId: sheet.document.columns[1].id, aggregate: 'sum' }]);
    });
    const headers = container.querySelectorAll('tr[data-group-key]');
    expect(Array.from(headers).map((h) => h.getAttribute('data-group-key'))).toEqual(['blue', 'red']);
    expect(headers[1].querySelector('[data-summary]')!.textContent).toBe('4');

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Collapse group red"]')!;
    await dispatch(toggle, new MouseEvent('click', { bubbles: true }));
    expect(renderedRows().slice(0, 1)).toEqual([1]);
    expect(renderedRows()).not.toContain(0);
    expect(container.querySelector('button[aria-label="Expand group red"]')).not.toBeNull();
  });
});

describe('SpreadsheetEditor table interactions', () => {
  it('runs table actions from the context menu', async () => {
    await mountSheet([['b'], ['c'], ['a']]);
    await act(async () => {
      sheet.setFooterRowCount(7);
    });
    await dispatch(td(0, 0)!, new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    const menu = container.querySelector('[role="menu"]')!;
    expect(menu).not.toBeNull();
    await dispatch(menu.querySelector('[data-action="sort-asc"]')!, new MouseEvent('click', { bubbles: true }));
    expect([raw(0, 0), raw(1, 0), raw(2, 0)]).toEqual(['a', 'b', 'c']);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it('autofills by dragging the fill handle', async () => {
    await mountSheet([['1'], ['2']]);
    await act(async () => {
      sheet.selectCell(0, 0);
      sheet.selectCell(1, 0, true);
    });
    const handle = container.querySelector('.spreadsheet-fill-handle')!;
    expect(handle.closest('td')!.getAttribute('data-row')).toBe('1');
    await dispatch(handle, new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await dispatch(td(4, 0)!, new MouseEvent('mouseover', { bubbles: true }));
    expect(td(3, 0)!.style.outline).toContain('dashed');
    await dispatch(window, new MouseEvent('mouseup'));
    expect([raw(2, 0), raw(3, 0), raw(4, 0)]).toEqual(['3', '4', '5']);
    expect(sheet.selectedRange).toEqual({ startRow: 0, startCol: 0, endRow: 4, endCol: 0 });
  });

  it('copies all clipboard formats and pastes the internal format losslessly', async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mountSheet([['2', '=A1*10']]);
    await act(async () => {
      sheet.selectCell(0, 0);
      sheet.selectCell(0, 1, true);
      grid().focus();
    });

    await dispatch(grid(), new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
    const copy = clipboardEvent('copy');
    await dispatch(grid(), copy);
    expect(copy.defaultPrevented).toBe(true);
    expect(copy.clipboardData.data['text/plain']).toBe('2\t20');
    expect(copy.clipboardData.data['text/html']).toContain('<table>');
    expect(copy.clipboardData.data[SPREADSHEET_CLIPBOARD_MIME]).toContain('=A1*10');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(writeText).not.toHaveBeenCalled(); // the copy event handled it

    await act(async () => sheet.selectCell(2, 1));
    const paste = clipboardEvent('paste', { ...copy.clipboardData.data });
    await dispatch(grid(), paste);
    expect(paste.defaultPrevented).toBe(true);
    expect([raw(2, 1), raw(2, 2)]).toEqual(['2', '=B3*10']);
  });

  it('pastes HTML tables and leaves copy/paste in text inputs alone', async () => {
    await mountSheet([['x']]);
    await act(async () => {
      sheet.selectCell(1, 0);
      grid().focus();
    });
    await dispatch(grid(), clipboardEvent('paste', { 'text/html': '<table><tr><td>h1</td><td>h2</td></tr></table>', 'text/plain': 'ignored' }));
    expect([raw(1, 0), raw(1, 1)]).toEqual(['h1', 'h2']);

    const formulaBar = container.querySelector<HTMLInputElement>('input[aria-label="Formula bar"]')!;
    await act(async () => formulaBar.focus());
    const paste = clipboardEvent('paste', { 'text/plain': 'typed' });
    await dispatch(formulaBar, paste);
    expect(paste.defaultPrevented).toBe(false);
  });
});
