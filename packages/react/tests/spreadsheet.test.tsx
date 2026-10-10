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
    expect(writeText).toHaveBeenCalledWith('a\tb\nc\td');
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
