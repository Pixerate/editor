import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { indexToColName, type SpreadsheetDocument } from '@pixerate/editor/spreadsheet';
import { SpreadsheetEditor, createReactiveSpreadsheet } from '../src/spreadsheet';

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function bigDocument(rows: number, cols: number): SpreadsheetDocument {
  const columns = Array.from({ length: cols }, (_, c) => {
    const key = indexToColName(c);
    return { id: `c${c}`, key, title: key, width: 100, type: 'freeform' as const };
  });
  const rowList = Array.from({ length: rows }, (_, r) => ({ id: `r${r}`, index: r, height: 32, type: 'freeform' as const }));
  const cells: SpreadsheetDocument['cells'] = {};
  for (let r = 0; r < rows; r++) cells[`r${r}`] = { c0: { raw: String(r + 1), value: r + 1 }, c1: { raw: `=A${r + 1}*2`, value: 0 } };
  return { id: 'big', name: 'Big', columns, rows: rowList, cells, createdAt: 0, updatedAt: 0 };
}

function setup(doc: SpreadsheetDocument, virtualize?: boolean | 'auto') {
  const sheetState = createReactiveSpreadsheet({ document: doc });
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(SpreadsheetEditor, { target, props: { sheetState, ...(virtualize === undefined ? {} : { virtualize }) } });
  flushSync();
  cleanup = () => {
    unmount(component);
    target.remove();
  };
  const td = (r: number, c: number) => target.querySelector<HTMLElement>(`td[data-row="${r}"][data-col="${c}"]`);
  const renderedRows = () =>
    Array.from(target.querySelectorAll('tbody tr[data-row]')).map((tr) => Number(tr.getAttribute('data-row')));
  const spacerHeights = () =>
    Array.from(target.querySelectorAll<HTMLElement>('tbody tr[data-spacer]')).map((tr) => parseFloat(tr.style.height));
  const grid = target.querySelector<HTMLElement>('[aria-label="Spreadsheet"]')!;
  const scroller = target.querySelector('table')!.parentElement!;
  const key = (k: string, times = 1) => {
    for (let i = 0; i < times; i++) {
      grid.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      flushSync();
    }
  };
  const scrollTo = (top: number, left = 0) => {
    scroller.scrollTop = top;
    scroller.scrollLeft = left;
    scroller.dispatchEvent(new Event('scroll'));
    flushSync();
  };
  return { sheetState, target, td, renderedRows, spacerHeights, key, scrollTo, scroller };
}

describe('virtualised Svelte SpreadsheetEditor', () => {
  it('renders only a window of a 10,000-row sheet, with spacers for the rest', () => {
    const { renderedRows, spacerHeights, td } = setup(bigDocument(10_000, 4));
    const rows = renderedRows();
    expect(rows[0]).toBe(0);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.length).toBeLessThan(60);
    expect(spacerHeights()).toEqual([(10_000 - rows.length) * 32]);
    expect(td(5, 1)!.textContent?.trim()).toBe('12');
  });

  it('renders the rows scrolled to', () => {
    const { renderedRows, spacerHeights, td, scrollTo } = setup(bigDocument(10_000, 4));
    scrollTo(3_000 * 32);
    const rows = renderedRows();
    expect(rows).toContain(3_000);
    expect(rows).toContain(3_010);
    expect(rows).not.toContain(0);
    const [top, bottom] = spacerHeights();
    expect(top).toBe(Math.min(...rows) * 32);
    expect(top + bottom + rows.length * 32).toBe(10_000 * 32);
    expect(td(3_000, 1)!.textContent?.trim()).toBe('6002');
  });

  it('keyboard navigation scrolls the active cell into view', () => {
    const { sheetState, td, key, scroller, renderedRows } = setup(bigDocument(10_000, 4));
    sheetState.selectCell(0, 0);
    flushSync();
    key('ArrowDown', 40);
    expect(sheetState.activeCell).toMatchObject({ row: 40, col: 0 });
    expect(td(40, 0)).not.toBeNull();
    expect(scroller.scrollTop).toBeGreaterThan(0);
    sheetState.selectCell(7_500, 1);
    flushSync();
    expect(td(7_500, 1)).not.toBeNull();
    expect(renderedRows()).not.toContain(40);
    key('ArrowUp');
    expect(td(7_499, 1)).not.toBeNull();
  });

  it('keeps frozen rows rendered while scrolled away', () => {
    const { sheetState, renderedRows, td, scrollTo } = setup(bigDocument(10_000, 4));
    sheetState.controller.setFrozenRowCount(2);
    flushSync();
    scrollTo(5_000 * 32);
    const rows = renderedRows();
    expect(rows.slice(0, 2)).toEqual([0, 1]);
    expect(rows).toContain(5_000);
    expect(td(0, 0)!.getAttribute('style')).toContain('position: sticky');
    // Sticky cells in a collapsed-border table let scrolled rows show through
    // the shared row borders, so the grid uses separate borders on the cells.
    const table = td(0, 0)!.closest('table')!;
    expect(table.getAttribute('class')).toContain('border-separate');
    expect(table.getAttribute('class')).not.toContain('border-collapse');
  });

  it('renders a merge crossing the top of the window whole', () => {
    const { sheetState, td, scrollTo } = setup(bigDocument(10_000, 4));
    sheetState.controller.mergeCells({ startRow: 2_950, startCol: 2, endRow: 3_020, endCol: 3 });
    flushSync();
    scrollTo(3_000 * 32);
    const merged = td(2_950, 2)!;
    expect(merged).not.toBeNull();
    expect(merged.getAttribute('rowspan')).toBe('71');
    expect(merged.getAttribute('colspan')).toBe('2');
  });

  it('virtualises columns of a wide sheet, keeping header and body aligned', () => {
    const { target, scrollTo } = setup(bigDocument(50, 120));
    expect(target.querySelectorAll('thead th[data-col]').length).toBeLessThan(30);
    scrollTo(0, 80 * 100);
    expect(target.querySelector('thead th[data-col="80"]')).not.toBeNull();
    expect(target.querySelector('thead th[data-col="0"]')).toBeNull();
    const headerCells = target.querySelectorAll('thead tr > th').length;
    expect(target.querySelector('tbody tr[data-row="3"]')!.children.length).toBe(headerCells);
  });

  it('keeps group rows aligned with the windowed columns', () => {
    const { sheetState, target, scrollTo } = setup(bigDocument(1_000, 100));
    sheetState.controller.groupRowsBy('c0');
    flushSync();
    scrollTo(0, 50 * 100);
    const group = target.querySelector('tbody tr[data-group-key]')!;
    expect(group).not.toBeNull();
    expect(group.children.length).toBe(target.querySelectorAll('thead tr > th').length);
  });

  it('renders every row when virtualisation is off, and small sheets as before', () => {
    const { renderedRows, spacerHeights } = setup(bigDocument(300, 3), false);
    expect(renderedRows()).toHaveLength(300);
    expect(spacerHeights()).toEqual([]);
  });

  it('a small sheet is not virtualised', () => {
    const { renderedRows, target } = setup(bigDocument(150, 3));
    expect(renderedRows()).toHaveLength(150);
    expect(target.querySelectorAll('[data-spacer]')).toHaveLength(0);
  });
});
