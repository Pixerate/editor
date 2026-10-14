import { describe, it, expect, afterEach } from 'vitest';
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
  sheetState.setCellValue(sheetState.document.rows[0].id, sheetState.document.columns[0].id, '=SEQUENCE(3, 2)');
  flushSync();
  const td = (r: number, c: number) => target.querySelector<HTMLElement>(`td[data-row="${r}"][data-col="${c}"]`)!;
  const border = (r: number, c: number) => td(r, c).querySelector<HTMLElement>('.spreadsheet-spill-border');
  const formulaBar = () => target.querySelector<HTMLInputElement>('input[aria-label="Formula bar"]')!;
  const select = (r: number, c: number) => {
    sheetState.selectCell(r, c);
    flushSync();
  };
  return { sheetState, td, border, formulaBar, select };
}

describe('Svelte SpreadsheetEditor dynamic arrays', () => {
  it('renders spilled values', () => {
    const { td } = setup();
    expect(td(2, 1).textContent?.trim()).toBe('6');
    expect(td(1, 0).textContent?.trim()).toBe('3');
  });

  it('draws a border around the spill range when the anchor or a spilled cell is selected', () => {
    const { border, select } = setup();
    expect(border(0, 0)).toBeNull();

    select(2, 1);
    for (let r = 0; r <= 2; r++) {
      for (let c = 0; c <= 1; c++) expect(border(r, c)).not.toBeNull();
    }
    expect(border(3, 0)).toBeNull();
    expect(border(0, 2)).toBeNull();
    expect(border(0, 0)!.getAttribute('style')).toContain('border-top');
    expect(border(0, 0)!.getAttribute('style')).toContain('border-left');
    expect(border(0, 0)!.getAttribute('style')).not.toContain('border-right');
    expect(border(2, 1)!.getAttribute('style')).toContain('border-bottom');
    expect(border(1, 0)!.getAttribute('style')).not.toContain('border-top');

    select(0, 0);
    expect(border(1, 1)).not.toBeNull();

    select(5, 3);
    expect(border(1, 1)).toBeNull();
  });

  it('shows the anchor formula greyed out in the formula bar for spilled cells', () => {
    const { formulaBar, select } = setup();
    select(1, 1);
    expect(formulaBar().value).toBe('=SEQUENCE(3, 2)');
    expect(formulaBar().getAttribute('data-spill-formula')).toBe('true');

    select(0, 0);
    expect(formulaBar().value).toBe('=SEQUENCE(3, 2)');
    expect(formulaBar().getAttribute('data-spill-formula')).toBeNull();

    select(5, 3);
    expect(formulaBar().value).toBe('');
  });

  it('shows #SPILL! on the anchor when a spilled cell is overwritten', () => {
    const { sheetState, td, border, select } = setup();
    sheetState.setCellValue(sheetState.document.rows[1].id, sheetState.document.columns[1].id, 'x');
    flushSync();
    expect(td(0, 0).textContent?.trim()).toBe('#SPILL!');
    select(0, 0);
    expect(border(0, 0)).toBeNull();
  });
});
