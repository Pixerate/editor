// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
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

function Harness() {
  sheet = useSpreadsheetEditor();
  return <SpreadsheetEditor state={sheet} />;
}

async function mountWithSpill() {
  await act(async () => root.render(<Harness />));
  await act(async () => {
    sheet.setCellValue(sheet.document.rows[0].id, sheet.document.columns[0].id, '=SEQUENCE(3, 2)');
  });
}

const td = (row: number, col: number) => container.querySelector<HTMLElement>(`td[data-row="${row}"][data-col="${col}"]`)!;
const border = (row: number, col: number) => td(row, col).querySelector<HTMLElement>('.spreadsheet-spill-border');
const formulaBar = () => container.querySelector<HTMLInputElement>('input[aria-label="Formula bar"]')!;

describe('SpreadsheetEditor dynamic arrays', () => {
  it('renders spilled values', async () => {
    await mountWithSpill();
    expect(td(2, 1).textContent).toBe('6');
    expect(td(1, 0).textContent).toBe('3');
  });

  it('draws a border around the spill range when the anchor or a spilled cell is selected', async () => {
    await mountWithSpill();
    expect(border(0, 0)).toBeNull();

    await act(async () => sheet.selectCell(2, 1));
    for (let r = 0; r <= 2; r++) {
      for (let c = 0; c <= 1; c++) expect(border(r, c)).not.toBeNull();
    }
    expect(border(3, 0)).toBeNull();
    expect(border(0, 2)).toBeNull();
    // Only the outer edges are drawn.
    expect(border(0, 0)!.style.borderTop).toContain('solid');
    expect(border(0, 0)!.style.borderLeft).toContain('solid');
    expect(border(0, 0)!.style.borderRight).toBe('');
    expect(border(2, 1)!.style.borderBottom).toContain('solid');
    expect(border(1, 0)!.style.borderTop).toBe('');

    await act(async () => sheet.selectCell(0, 0));
    expect(border(1, 1)).not.toBeNull();

    await act(async () => sheet.selectCell(5, 3));
    expect(border(1, 1)).toBeNull();
  });

  it('shows the anchor formula greyed out in the formula bar for spilled cells', async () => {
    await mountWithSpill();
    await act(async () => sheet.selectCell(1, 1));
    expect(formulaBar().value).toBe('=SEQUENCE(3, 2)');
    expect(formulaBar().getAttribute('data-spill-formula')).toBe('true');

    await act(async () => sheet.selectCell(0, 0));
    expect(formulaBar().value).toBe('=SEQUENCE(3, 2)');
    expect(formulaBar().getAttribute('data-spill-formula')).toBeNull();

    await act(async () => sheet.selectCell(5, 3));
    expect(formulaBar().value).toBe('');
  });

  it('shows #SPILL! on the anchor when a spilled cell is overwritten', async () => {
    await mountWithSpill();
    await act(async () => {
      sheet.setCellValue(sheet.document.rows[1].id, sheet.document.columns[1].id, 'x');
    });
    expect(td(0, 0).textContent).toBe('#SPILL!');
    expect(td(0, 0).querySelector('span')!.getAttribute('title')).toBe("The result needs A1:B3, but B2 isn't empty.");
    await act(async () => sheet.selectCell(0, 0));
    expect(border(0, 0)).toBeNull();
  });
});
