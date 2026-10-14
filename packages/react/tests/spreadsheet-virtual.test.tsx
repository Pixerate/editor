// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { indexToColName, type SpreadsheetDocument } from '@pixerate/editor/spreadsheet';
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

function Harness({ doc, virtualize }: { doc: SpreadsheetDocument; virtualize?: boolean | 'auto' }) {
  sheet = useSpreadsheetEditor({ document: doc });
  return <SpreadsheetEditor state={sheet} virtualize={virtualize} />;
}

async function mount(doc: SpreadsheetDocument, virtualize?: boolean | 'auto') {
  await act(async () => root.render(<Harness doc={doc} virtualize={virtualize} />));
}

const grid = () => container.querySelector<HTMLElement>('[aria-label="Spreadsheet"]')!;
const scroller = () => container.querySelector<HTMLElement>('table')!.parentElement!;
const td = (row: number, col: number) => container.querySelector<HTMLElement>(`td[data-row="${row}"][data-col="${col}"]`);
const renderedRows = () =>
  Array.from(container.querySelectorAll('tbody tr[data-row]')).map((tr) => Number(tr.getAttribute('data-row')));
const spacerHeights = () =>
  Array.from(container.querySelectorAll<HTMLElement>('tbody tr[data-spacer]')).map((tr) => parseFloat(tr.style.height));

async function key(k: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      grid().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    });
  }
}

async function scrollTo(top: number, left = 0) {
  await act(async () => {
    scroller().scrollTop = top;
    scroller().scrollLeft = left;
    scroller().dispatchEvent(new Event('scroll'));
  });
}

describe('virtualised SpreadsheetEditor', () => {
  it('renders only a window of a 10,000-row sheet, with spacers for the rest', async () => {
    await mount(bigDocument(10_000, 4));
    const rows = renderedRows();
    expect(rows[0]).toBe(0);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.length).toBeLessThan(60);
    // The rows left out keep their height, so the scrollbar is right.
    expect(spacerHeights()).toEqual([(10_000 - rows.length) * 32]);
    expect(td(5, 1)!.textContent).toBe('12');
  });

  it('renders the rows scrolled to', async () => {
    await mount(bigDocument(10_000, 4));
    await scrollTo(3_000 * 32);
    const rows = renderedRows();
    expect(rows).toContain(3_000);
    expect(rows).toContain(3_010);
    expect(rows).not.toContain(0);
    expect(Math.min(...rows)).toBeGreaterThan(2_980);
    const [top, bottom] = spacerHeights();
    expect(top).toBe(Math.min(...rows) * 32);
    expect(top + bottom + rows.length * 32).toBe(10_000 * 32);
    expect(td(3_000, 1)!.textContent).toBe('6002');
  });

  it('keyboard navigation scrolls the active cell into view', async () => {
    await mount(bigDocument(10_000, 4));
    await act(async () => sheet.selectCell(0, 0));
    await key('ArrowDown', 40);
    expect(sheet.activeCell).toMatchObject({ row: 40, col: 0 });
    expect(td(40, 0)).not.toBeNull();
    expect(scroller().scrollTop).toBeGreaterThan(0);
    // Jumping far away (e.g. the name box or code) renders the target too.
    await act(async () => sheet.selectCell(7_500, 1));
    expect(td(7_500, 1)).not.toBeNull();
    expect(renderedRows()).not.toContain(40);
    await key('ArrowUp');
    expect(td(7_499, 1)).not.toBeNull();
  });

  it('keeps frozen rows rendered while scrolled away', async () => {
    await mount(bigDocument(10_000, 4));
    await act(async () => sheet.controller.setFrozenRowCount(2));
    await scrollTo(5_000 * 32);
    const rows = renderedRows();
    expect(rows.slice(0, 2)).toEqual([0, 1]);
    expect(rows).toContain(5_000);
    expect(td(0, 0)!.style.position).toBe('sticky');
    // Sticky cells in a collapsed-border table let scrolled rows show through
    // the shared row borders, so the grid uses separate borders on the cells.
    const table = container.querySelector('table')!;
    expect(table.className).toContain('border-separate');
    expect(table.className).not.toContain('border-collapse');
  });

  it('renders a merge crossing the top of the window whole', async () => {
    await mount(bigDocument(10_000, 4));
    await act(async () => {
      sheet.controller.mergeCells({ startRow: 2_950, startCol: 2, endRow: 3_020, endCol: 3 });
    });
    await scrollTo(3_000 * 32);
    const merged = td(2_950, 2)!;
    expect(merged).not.toBeNull();
    expect(merged.getAttribute('rowspan')).toBe('71');
    expect(merged.getAttribute('colspan')).toBe('2');
  });

  it('virtualises columns of a wide sheet, keeping header and body aligned', async () => {
    await mount(bigDocument(50, 120));
    const headers = container.querySelectorAll('thead th[data-col]');
    expect(headers.length).toBeLessThan(30);
    await scrollTo(0, 80 * 100);
    expect(container.querySelector('thead th[data-col="80"]')).not.toBeNull();
    expect(container.querySelector('thead th[data-col="0"]')).toBeNull();
    const headerCells = container.querySelectorAll('thead tr > th').length;
    const bodyCells = container.querySelector('tbody tr[data-row="3"]')!.children.length;
    expect(bodyCells).toBe(headerCells);
  });

  it('keeps group rows aligned with the windowed columns', async () => {
    await mount(bigDocument(1_000, 100));
    await act(async () => sheet.controller.groupRowsBy('c0'));
    await scrollTo(0, 50 * 100);
    const group = container.querySelector('tbody tr[data-group-key]')!;
    expect(group).not.toBeNull();
    expect(group.children.length).toBe(container.querySelectorAll('thead tr > th').length);
  });

  it('renders every row when virtualisation is off, and small sheets as before', async () => {
    await mount(bigDocument(300, 3), false);
    expect(renderedRows()).toHaveLength(300);
    expect(spacerHeights()).toEqual([]);
  });

  it('a small sheet is not virtualised', async () => {
    await mount(bigDocument(150, 3));
    expect(renderedRows()).toHaveLength(150);
    expect(container.querySelectorAll('[data-spacer]')).toHaveLength(0);
  });
});
