import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { SPREADSHEET_CLIPBOARD_MIME } from '@pixerate/editor';
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

  const raw = (r: number, c: number) =>
    sheetState.getCell(sheetState.document.rows[r].id, sheetState.document.columns[c].id).raw;
  const td = (r: number, c: number) => target.querySelector<HTMLElement>(`td[data-row="${r}"][data-col="${c}"]`);
  const renderedRows = () =>
    Array.from(target.querySelectorAll('tbody tr[data-row]')).map((tr) => Number(tr.getAttribute('data-row')));
  const dispatch = (el: EventTarget, event: Event) => {
    el.dispatchEvent(event);
    flushSync();
  };
  const grid = target.querySelector<HTMLElement>('[aria-label="Spreadsheet"]')!;
  return { sheetState, target, raw, td, renderedRows, dispatch, grid };
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

describe('Svelte SpreadsheetEditor table rendering', () => {
  it('renders merged cells with spans and skips covered cells', () => {
    const { sheetState, td } = setup([['merged', 'x'], ['y', 'z']]);
    sheetState.mergeCells({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    flushSync();
    expect(td(0, 0)!.getAttribute('rowspan')).toBe('2');
    expect(td(0, 0)!.getAttribute('colspan')).toBe('2');
    expect(td(0, 0)!.textContent?.trim()).toBe('merged');
    expect(td(1, 1)).toBeNull();
  });

  it('hides hidden and filtered rows and columns, and marks filtered columns', () => {
    const { sheetState, target, renderedRows } = setup([['a'], ['b'], ['a'], ['c']]);
    sheetState.hideColumns([1]);
    sheetState.hideRows([3]);
    sheetState.addFilterRule({ colId: sheetState.document.columns[0].id, operator: 'equals', value: 'a' });
    flushSync();
    expect(renderedRows()).toEqual([0, 2]);
    expect(target.querySelector('th[data-col="1"]')).toBeNull();
    expect(target.querySelector('[data-filtered="true"]')).not.toBeNull();
  });

  it('renders frozen rows and columns as sticky', () => {
    const { sheetState, td } = setup([['h1', 'h2'], ['a', 'b']]);
    sheetState.setFrozenRowCount(1);
    sheetState.setFrozenColumnCount(1);
    flushSync();
    expect(td(0, 0)!.style.position).toBe('sticky');
    expect(td(0, 0)!.style.top).toBe('28px');
    expect(td(0, 0)!.style.left).toBe('48px');
    expect(td(0, 1)!.style.top).toBe('28px');
    expect(td(1, 0)!.style.left).toBe('48px');
    expect(td(1, 1)!.style.position).toBe('');
  });

  it('renders category headers with summaries and collapses them', () => {
    const { sheetState, target, renderedRows, dispatch } = setup([['red', '1'], ['blue', '2'], ['red', '3']]);
    sheetState.setFooterRowCount(7);
    sheetState.groupRowsBy(sheetState.document.columns[0].id, [{ colId: sheetState.document.columns[1].id, aggregate: 'sum' }]);
    flushSync();
    const headers = target.querySelectorAll('tr[data-group-key]');
    expect(Array.from(headers).map((h) => h.getAttribute('data-group-key'))).toEqual(['blue', 'red']);
    expect(headers[1].querySelector('[data-summary]')!.textContent).toBe('4');

    dispatch(target.querySelector('button[aria-label="Collapse group red"]')!, new MouseEvent('click', { bubbles: true }));
    expect(renderedRows()[0]).toBe(1);
    expect(renderedRows()).not.toContain(0);
    expect(target.querySelector('button[aria-label="Expand group red"]')).not.toBeNull();
  });
});

describe('Svelte SpreadsheetEditor table interactions', () => {
  it('runs table actions from the context menu', () => {
    const { sheetState, target, raw, td, dispatch } = setup([['b'], ['c'], ['a']]);
    sheetState.setFooterRowCount(7);
    flushSync();
    dispatch(td(0, 0)!, new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    const menu = target.querySelector('[role="menu"]')!;
    expect(menu).not.toBeNull();
    dispatch(menu.querySelector('[data-action="sort-asc"]')!, new MouseEvent('click', { bubbles: true }));
    expect([raw(0, 0), raw(1, 0), raw(2, 0)]).toEqual(['a', 'b', 'c']);
    expect(target.querySelector('[role="menu"]')).toBeNull();
  });

  it('keeps the context menu inside the viewport', () => {
    const { target, td, dispatch } = setup([['a']]);
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const height = this.getAttribute('role') === 'menu' ? 400 : 0;
        return { x: 0, y: 0, top: 0, left: 0, right: 220, bottom: height, width: 220, height, toJSON() {} } as DOMRect;
      });
    try {
      dispatch(
        td(0, 0)!,
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: window.innerWidth - 20, clientY: window.innerHeight - 30 })
      );
      flushSync();
      const menu = target.querySelector<HTMLElement>('[role="menu"]')!;
      // Opened near the bottom-right corner, it flips to the left of and above the pointer.
      expect(menu.style.left).toBe(`${window.innerWidth - 20 - 220}px`);
      expect(menu.style.top).toBe(`${window.innerHeight - 30 - 400}px`);
      expect(menu.style.overflowY).toBe('auto');
    } finally {
      rect.mockRestore();
    }
  });

  it('autofills by dragging the fill handle', () => {
    const { sheetState, target, raw, td, dispatch } = setup([['1'], ['2']]);
    sheetState.selectCell(0, 0);
    sheetState.selectCell(1, 0, true);
    flushSync();
    const handle = target.querySelector('.spreadsheet-fill-handle')!;
    expect(handle.closest('td')!.getAttribute('data-row')).toBe('1');
    dispatch(handle, new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    dispatch(td(4, 0)!, new MouseEvent('mouseover', { bubbles: true }));
    expect(td(3, 0)!.style.outline).toContain('dashed');
    dispatch(window, new MouseEvent('mouseup'));
    expect([raw(2, 0), raw(3, 0), raw(4, 0)]).toEqual(['3', '4', '5']);
    expect(sheetState.selectedRange).toEqual({ startRow: 0, startCol: 0, endRow: 4, endCol: 0 });
  });

  it('copies all clipboard formats and pastes the internal format losslessly', async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { sheetState, raw, dispatch, grid } = setup([['2', '=A1*10']]);
    sheetState.selectCell(0, 0);
    sheetState.selectCell(0, 1, true);
    grid.focus();
    flushSync();

    dispatch(grid, new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
    const copy = clipboardEvent('copy');
    dispatch(grid, copy);
    expect(copy.defaultPrevented).toBe(true);
    expect(copy.clipboardData.data['text/plain']).toBe('2\t20');
    expect(copy.clipboardData.data['text/html']).toContain('<table>');
    expect(copy.clipboardData.data[SPREADSHEET_CLIPBOARD_MIME]).toContain('=A1*10');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeText).not.toHaveBeenCalled();

    sheetState.selectCell(2, 1);
    const paste = clipboardEvent('paste', { ...copy.clipboardData.data });
    dispatch(grid, paste);
    expect(paste.defaultPrevented).toBe(true);
    expect([raw(2, 1), raw(2, 2)]).toEqual(['2', '=B3*10']);
  });

  it('pastes HTML tables and leaves copy/paste in text inputs alone', () => {
    const { sheetState, target, raw, dispatch, grid } = setup([['x']]);
    sheetState.selectCell(1, 0);
    grid.focus();
    flushSync();
    dispatch(grid, clipboardEvent('paste', { 'text/html': '<table><tr><td>h1</td><td>h2</td></tr></table>', 'text/plain': 'ignored' }));
    expect([raw(1, 0), raw(1, 1)]).toEqual(['h1', 'h2']);

    const formulaBar = target.querySelector<HTMLInputElement>('input[aria-label="Formula bar"]')!;
    formulaBar.focus();
    const paste = clipboardEvent('paste', { 'text/plain': 'typed' });
    dispatch(formulaBar, paste);
    expect(paste.defaultPrevented).toBe(false);
  });
});

describe('Svelte SpreadsheetEditor number formats', () => {
  const span = (cell: HTMLElement | null) => cell!.querySelector<HTMLElement>('span')!;

  it('renders formatted numbers right-aligned with format colours', () => {
    const { sheetState, td } = setup([['-5', 'text', '1234.5']]);
    sheetState.setCellNumberFormat({ startRow: 0, startCol: 0, endRow: 0, endCol: 2 }, '#,##0.00;[Red](#,##0.00)');
    flushSync();
    expect(span(td(0, 0)).textContent?.trim()).toBe('(5.00)');
    expect(span(td(0, 0)).style.color).toBe('rgb(255, 0, 0)');
    expect(span(td(0, 0)).style.textAlign).toBe('right');
    expect(span(td(0, 1)).textContent?.trim()).toBe('text');
    expect(span(td(0, 1)).style.textAlign).toBe('');
    expect(span(td(0, 1)).hasAttribute('data-numeric')).toBe(false);
    expect(span(td(0, 2)).textContent?.trim()).toBe('1,234.50');
    expect(span(td(0, 2)).style.color).toBe('');
  });

  it('applies presets and custom codes from the context menu', () => {
    const { target, td, dispatch } = setup([['1.5']]);
    const openMenu = () => {
      dispatch(td(0, 0)!, new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
      return target.querySelector('[role="menu"]')!;
    };
    let menu = openMenu();
    expect(menu.querySelector('[data-action="number-format-general"]')!.hasAttribute('data-checked')).toBe(true);
    dispatch(menu.querySelector('[data-action="number-format-currency"]')!, new MouseEvent('click', { bubbles: true }));
    expect(span(td(0, 0)).textContent?.trim()).toBe('$1.50');

    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('0.000 "kg"');
    try {
      menu = openMenu();
      expect(menu.querySelector('[data-action="number-format-currency"]')!.hasAttribute('data-checked')).toBe(true);
      dispatch(menu.querySelector('[data-action="number-format-custom"]')!, new MouseEvent('click', { bubbles: true }));
      expect(prompt).toHaveBeenCalledWith(expect.stringContaining('Number format code'), '"$"#,##0.00');
      expect(span(td(0, 0)).textContent?.trim()).toBe('1.500 kg');
      prompt.mockReturnValue(null);
      dispatch(openMenu().querySelector('[data-action="number-format-custom"]')!, new MouseEvent('click', { bubbles: true }));
      expect(span(td(0, 0)).textContent?.trim()).toBe('1.500 kg');
    } finally {
      prompt.mockRestore();
    }
  });
});
