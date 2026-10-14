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

describe('Svelte SpreadsheetEditor sticky headers', () => {
  it('gives the sticky header row and row numbers an opaque background', () => {
    const { grid } = setup();
    // Cells scroll underneath these, so a translucent `bg-muted/60` shows them through.
    const sticky = Array.from(grid.querySelectorAll<HTMLElement>('.sticky'));
    expect(sticky.length).toBeGreaterThan(2);
    for (const el of sticky) {
      expect(el.className).toMatch(/(^|\s)bg-muted(\s|$)/);
      expect(el.className).not.toMatch(/bg-muted\/\d+/);
    }
  });
});

describe('Svelte SpreadsheetEditor cell editor', () => {
  it('focuses the cell editor, starts it with the typed key once and refocuses the grid', () => {
    const { sheetState, raw, key, grid } = setup();
    sheetState.selectCell(0, 0);
    flushSync();
    (grid as HTMLElement).focus();
    const press = new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true });
    grid.dispatchEvent(press);
    flushSync();
    expect(press.defaultPrevented).toBe(true);
    const input = grid.querySelector<HTMLInputElement>('td input')!;
    expect(input.value).toBe('1');
    expect(document.activeElement).toBe(input);

    key(input, { key: 'Enter' });
    expect(raw(0, 0)).toBe('1');
    expect(document.activeElement).toBe(grid);
    key(grid, { key: '2' });
    key(grid.querySelector('td input')!, { key: 'Enter' });
    expect(raw(1, 0)).toBe('2');
  });

  it('commits text typed into the cell on Enter', () => {
    const { sheetState, raw, key, grid } = setup();
    sheetState.startEditing(0, 0);
    flushSync();
    const input = grid.querySelector<HTMLInputElement>('td input')!;
    input.value = '=2*21';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    key(input, { key: 'Enter' });
    expect(raw(0, 0)).toBe('=2*21');
    expect(sheetState.getCell(sheetState.document.rows[0].id, sheetState.document.columns[0].id).value).toBe(42);
  });
});

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

  it('redoes with Mod+Shift+Z (key "Z") and Ctrl+Y, and copies only the selection', async () => {
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
    // Without a browser copy event (jsdom), the TSV fallback runs on the next task.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeText).toHaveBeenCalledWith('x\tb\nc\td');
  });
});

describe('Svelte SpreadsheetEditor copy fallback', () => {
  it('swallows a denied clipboard write instead of leaving an unhandled rejection', async () => {
    const { sheetState, key, grid } = setup();
    let handled: ReturnType<typeof vi.fn> | null = null;
    const writeText = vi.fn(() => {
      const denied = Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
      handled = vi.spyOn(denied, 'catch') as any;
      return denied;
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    sheetState.selectCell(0, 0);
    flushSync();
    key(grid, { key: 'c', metaKey: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writeText).toHaveBeenCalled();
    // The rejection is caught (not left unhandled).
    expect(handled).toHaveBeenCalled();
  });
});
