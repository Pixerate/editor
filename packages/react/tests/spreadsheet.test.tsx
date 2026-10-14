// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
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

function Harness(props: { onColumnResize?: (id: string, w: number) => void }) {
  sheet = useSpreadsheetEditor();
  return <SpreadsheetEditor state={sheet} {...props} />;
}

async function mountSheet(props: { onColumnResize?: (id: string, w: number) => void } = {}) {
  await act(async () => root.render(<Harness {...props} />));
}

const cellRaw = (row: number, col: number) =>
  sheet.getCell(sheet.document.rows[row].id, sheet.document.columns[col].id).raw;

async function key(target: Element, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const grid = () => container.querySelector('[aria-label="Spreadsheet"]')!;
const formulaBar = () => container.querySelector<HTMLInputElement>('input[aria-label="Formula bar"]')!;

describe('SpreadsheetEditor formula bar', () => {
  it('keeps keystrokes out of the grid and commits typed values on Enter', async () => {
    await mountSheet();
    await act(async () => {
      sheet.setCellValue(sheet.document.rows[0].id, sheet.document.columns[0].id, 'keep');
      sheet.selectCell(0, 0);
    });

    const input = formulaBar();
    await act(async () => input.focus());

    // Backspace and arrows in the formula bar must not edit or move the grid.
    await key(input, { key: 'Backspace' });
    await key(input, { key: 'ArrowDown' });
    expect(cellRaw(0, 0)).toBe('keep');
    expect(sheet.activeCell?.row).toBe(0);

    await typeInto(input, '=1+2');
    expect(input.value).toBe('=1+2');
    await key(input, { key: 'Enter' });

    expect(cellRaw(0, 0)).toBe('=1+2');
    expect(sheet.editingCell).toBeNull();
  });

  it('discards formula bar edits on Escape', async () => {
    await mountSheet();
    await act(async () => sheet.selectCell(1, 1));
    const input = formulaBar();
    await act(async () => input.focus());
    await typeInto(input, 'draft');
    await key(input, { key: 'Escape' });
    expect(cellRaw(1, 1)).toBe('');
    expect(input.value).toBe('');
  });
});

describe('SpreadsheetEditor sticky headers', () => {
  it('gives the sticky header row and row numbers an opaque background', async () => {
    await mountSheet();
    // Cells scroll underneath these, so a translucent `bg-muted/60` shows them through.
    const sticky = Array.from(container.querySelectorAll<HTMLElement>('.sticky'));
    expect(sticky.length).toBeGreaterThan(2);
    for (const el of sticky) {
      expect(el.className).toMatch(/(^|\s)bg-muted(\s|$)/);
      expect(el.className).not.toMatch(/bg-muted\/\d+/);
    }
  });
});

describe('SpreadsheetEditor cell editor', () => {
  const cellInput = () => container.querySelector<HTMLInputElement>('td input')!;

  it('commits text typed into the cell on Enter, Tab and blur', async () => {
    await mountSheet();
    const cell = container.querySelector('td[data-row="0"][data-col="0"]')!;
    await act(async () => {
      cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await typeInto(cellInput(), '=2*21');
    await key(cellInput(), { key: 'Enter' });
    expect(cellRaw(0, 0)).toBe('=2*21');
    expect(sheet.getCell(sheet.document.rows[0].id, sheet.document.columns[0].id).value).toBe(42);
    expect(sheet.activeCell?.row).toBe(1);

    // Typing a character on a selected cell starts editing with it.
    await key(grid(), { key: 'h' });
    await typeInto(cellInput(), 'hello');
    await key(cellInput(), { key: 'Tab' });
    expect(cellRaw(1, 0)).toBe('hello');

    await act(async () => sheet.startEditing(2, 2));
    await typeInto(cellInput(), 'blurred');
    await act(async () => cellInput().dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(cellRaw(2, 2)).toBe('blurred');
  });

  it('starts editing with the typed key once and keeps typing in the grid after Enter', async () => {
    await mountSheet();
    await act(async () => sheet.selectCell(0, 0));
    await act(async () => (grid() as HTMLElement).focus());
    const press = new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true });
    await act(async () => {
      grid().dispatchEvent(press);
    });
    // Prevented, so the browser does not type "1" again into the focused input.
    expect(press.defaultPrevented).toBe(true);
    expect(cellInput().value).toBe('1');
    expect(document.activeElement).toBe(cellInput());

    await key(cellInput(), { key: 'Enter' });
    expect(cellRaw(0, 0)).toBe('1');
    // Focus returns to the grid, so the next key edits the next cell.
    expect(document.activeElement).toBe(grid());
    await key(grid(), { key: '2' });
    await key(cellInput(), { key: 'Enter' });
    expect(cellRaw(1, 0)).toBe('2');
  });

  it('commits a draft set through state.setDraftValue', async () => {
    await mountSheet();
    await act(async () => sheet.startEditing(0, 1));
    await act(async () => sheet.setDraftValue('direct'));
    await act(async () => sheet.commitEditing());
    expect(cellRaw(0, 1)).toBe('direct');
  });
});

describe('SpreadsheetEditor shortcuts', () => {
  it('redoes with Mod+Shift+Z (key "Z") and Ctrl+Y', async () => {
    await mountSheet();
    const rowId = sheet.document.rows[0].id;
    const colId = sheet.document.columns[0].id;
    await act(async () => {
      sheet.selectCell(0, 0);
      sheet.setCellValue(rowId, colId, 'x');
    });

    await key(grid(), { key: 'z', ctrlKey: true });
    expect(cellRaw(0, 0)).toBe('');
    await key(grid(), { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(cellRaw(0, 0)).toBe('x');

    await key(grid(), { key: 'z', metaKey: true });
    expect(cellRaw(0, 0)).toBe('');
    await key(grid(), { key: 'y', ctrlKey: true });
    expect(cellRaw(0, 0)).toBe('x');
  });

  it('copies only the selected range', async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mountSheet();
    const [r0, r1] = sheet.document.rows.map((r) => r.id);
    const [c0, c1] = sheet.document.columns.map((c) => c.id);
    await act(async () => {
      sheet.setCellValue(r0, c0, 'a');
      sheet.setCellValue(r0, c1, 'b');
      sheet.setCellValue(r1, c0, 'c');
      sheet.setCellValue(r1, c1, 'd');
      sheet.selectCell(0, 0);
      sheet.selectCell(1, 1, true);
    });

    await key(grid(), { key: 'c', ctrlKey: true });
    // Without a browser copy event (jsdom), the TSV fallback runs on the next task.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(writeText).toHaveBeenCalledWith('a\tb\nc\td');
  });
});

describe('SpreadsheetEditor copy fallback', () => {
  it('swallows a denied clipboard write instead of leaving an unhandled rejection', async () => {
    await mountSheet();
    let handled: ReturnType<typeof vi.fn> | null = null;
    const writeText = vi.fn(() => {
      const denied = Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
      handled = vi.spyOn(denied, 'catch') as any;
      return denied;
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await act(async () => sheet.selectCell(0, 0));
    await key(grid(), { key: 'c', metaKey: true });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(writeText).toHaveBeenCalled();
    // The rejection is caught (not left unhandled).
    expect(handled).toHaveBeenCalled();
  });
});

describe('SpreadsheetEditor column resize', () => {
  it('reports the final width even when the pointer stops before mouseup', async () => {
    vi.useFakeTimers();
    try {
      const onColumnResize = vi.fn();
      await mountSheet({ onColumnResize });
      const handle = container.querySelector('.col-resize-handle')!;
      const colId = sheet.document.columns[0].id;
      const startWidth = sheet.document.columns[0].width ?? 120;

      await act(async () => {
        handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }));
      });
      await act(async () => {
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 160 }));
      });
      // Let the rAF width update land and React re-render.
      await act(async () => {
        vi.advanceTimersByTime(50);
      });
      await act(async () => {
        window.dispatchEvent(new MouseEvent('mouseup', { clientX: 160 }));
      });

      expect(onColumnResize).toHaveBeenCalledWith(colId, startWidth + 60);
    } finally {
      vi.useRealTimers();
    }
  });
});
