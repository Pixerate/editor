import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { SpreadsheetEditor, createReactiveSpreadsheet } from '../src/spreadsheet';

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function setup() {
  const sheetState = createReactiveSpreadsheet();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(SpreadsheetEditor, { target, props: { sheetState } });
  flushSync();
  cleanup = () => {
    unmount(component);
    target.remove();
  };
  const raw = (r: number, c: number) =>
    sheetState.getCell(sheetState.document.rows[r].id, sheetState.document.columns[c].id).raw;
  const key = (el: Element, init: KeyboardEventInit) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    flushSync();
  };
  return {
    sheetState,
    raw,
    key,
    grid: target.querySelector('[aria-label="Spreadsheet"]')!,
    formulaBar: target.querySelector<HTMLInputElement>('input[aria-label="Formula bar"]')!,
  };
}

describe('Svelte SpreadsheetEditor', () => {
  it('does not let formula bar keys reach the grid', () => {
    const { sheetState, raw, key, formulaBar } = setup();
    sheetState.setCellValue(sheetState.document.rows[0].id, sheetState.document.columns[0].id, 'keep');
    sheetState.selectCell(0, 0);
    flushSync();

    key(formulaBar, { key: 'Backspace' });
    key(formulaBar, { key: 'ArrowDown' });
    expect(raw(0, 0)).toBe('keep');
    expect(sheetState.activeCell?.row).toBe(0);

    // Enter commits from the formula bar without the grid re-opening the editor.
    key(formulaBar, { key: 'Enter' });
    expect(sheetState.editingCell).toBeNull();
  });

  it('redoes with Mod+Shift+Z (key "Z") and Ctrl+Y, and copies only the selection', () => {
    const { sheetState, raw, key, grid } = setup();
    const [r0, r1] = sheetState.document.rows.map((r) => r.id);
    const [c0, c1] = sheetState.document.columns.map((c) => c.id);
    sheetState.selectCell(0, 0);
    sheetState.setCellValue(r0, c0, 'x');
    flushSync();

    key(grid, { key: 'z', ctrlKey: true });
    expect(raw(0, 0)).toBe('');
    key(grid, { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(raw(0, 0)).toBe('x');
    key(grid, { key: 'z', ctrlKey: true });
    key(grid, { key: 'y', ctrlKey: true });
    expect(raw(0, 0)).toBe('x');

    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    sheetState.setCellValue(r0, c1, 'b');
    sheetState.setCellValue(r1, c0, 'c');
    sheetState.setCellValue(r1, c1, 'd');
    sheetState.selectCell(0, 0);
    sheetState.selectCell(1, 1, true);
    flushSync();
    key(grid, { key: 'c', ctrlKey: true });
    expect(writeText).toHaveBeenCalledWith('x\tb\nc\td');
  });
});
