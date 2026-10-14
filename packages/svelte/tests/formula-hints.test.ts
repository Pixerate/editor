import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import { FormulaBar, FormulaHints, SpreadsheetEditor, createReactiveSpreadsheet } from '../src/spreadsheet';

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
  return {
    sheetState,
    target,
    formulaBar: target.querySelector<HTMLInputElement>('input[aria-label="Formula bar"]')!,
  };
}

function typeInto(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

function key(el: Element, init: KeyboardEventInit) {
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  flushSync();
}

const options = (root: Element) => Array.from(root.querySelectorAll('[role="option"]')).map((el) => el.textContent ?? '');
const activeArg = (root: Element) => root.querySelector('[data-formula-signature] [data-active]')?.textContent;

describe('Svelte FormulaHints in the SpreadsheetEditor', () => {
  it('suggests functions in the formula bar and accepts with Tab', async () => {
    const { sheetState, target, formulaBar } = setup();
    sheetState.selectCell(0, 0);
    flushSync();
    formulaBar.focus();
    flushSync();

    typeInto(formulaBar, '=SUMI');
    expect(options(target)).toHaveLength(2);
    expect(options(target)[0]).toContain('SUMIF(range, criteria, [sum_range])');
    expect(options(target)[0]).toContain('Adds the cells that meet a condition.');
    key(formulaBar, { key: 'ArrowDown' });
    expect(target.querySelector('[aria-selected="true"]')?.textContent).toContain('SUMIFS(');
    key(formulaBar, { key: 'Tab' });
    await tick();
    flushSync();
    expect(sheetState.draftValue).toBe('=SUMIFS(');
    expect(formulaBar.value).toBe('=SUMIFS(');
    expect(formulaBar.selectionStart).toBe(8);
    expect(activeArg(target)).toBe('sum_range');
  });

  it('highlights the active argument while typing a call', () => {
    const { sheetState, target, formulaBar } = setup();
    sheetState.selectCell(0, 0);
    flushSync();
    formulaBar.focus();
    typeInto(formulaBar, '=IF(A1>1, ');
    expect(activeArg(target)).toBe('value_if_true');
    typeInto(formulaBar, '=IF(A1>1, 1, ');
    expect(activeArg(target)).toBe('[value_if_false]');
    expect(target.querySelector('[data-formula-signature]')?.textContent).toContain('value_if_false: The result');
  });

  it('works in the cell editor without the grid stealing keys', async () => {
    const { sheetState, target } = setup();
    sheetState.startEditing(0, 0, '=COUNTI');
    flushSync();
    const cellInput = target.querySelector<HTMLInputElement>('td input')!;
    cellInput.focus();
    flushSync();
    expect(options(target).map((o) => o.slice(0, 8))).toEqual(['COUNTIF(', 'COUNTIFS']);

    key(cellInput, { key: 'Escape' });
    expect(options(target)).toHaveLength(0);
    expect(sheetState.editingCell).not.toBeNull();

    typeInto(cellInput, '=COUNTIF');
    key(cellInput, { key: 'Tab' });
    await tick();
    expect(sheetState.editingCell).not.toBeNull();
    expect(sheetState.draftValue).toBe('=COUNTIF(');
  });

  it('accepts a suggestion on mouse down without blurring the input', async () => {
    const { sheetState, target } = setup();
    sheetState.startEditing(1, 1, '=VLOO');
    flushSync();
    const cellInput = target.querySelector<HTMLInputElement>('td input')!;
    cellInput.focus();
    flushSync();
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    target.querySelector('[role="option"]')!.dispatchEvent(event);
    await tick();
    expect(event.defaultPrevented).toBe(true);
    expect(sheetState.draftValue).toBe('=VLOOKUP(');
    expect(document.activeElement).toBe(cellInput);
  });

  it('shows error messages as a tooltip on error cells', () => {
    const { sheetState, target } = setup();
    sheetState.setCellValue(sheetState.document.rows[0].id, sheetState.document.columns[0].id, '=SUMIF(5, ">1")');
    sheetState.setCellValue(sheetState.document.rows[1].id, sheetState.document.columns[0].id, '=NOPE()');
    flushSync();
    const spans = target.querySelectorAll('tbody tr td:nth-child(2) span');
    expect(spans[0].textContent?.trim()).toBe('#VALUE!');
    expect(spans[0].getAttribute('title')).toBe('Argument 1 of SUMIF must be a range.');
    expect(spans[1].getAttribute('title')).toBe('Unknown function "NOPE".');
  });
});

describe('Svelte FormulaHints standalone', () => {
  it('can be attached to any input', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const input = document.createElement('input');
    input.value = '=TEXTJ';
    target.appendChild(input);
    input.focus();
    const onAccept = vi.fn();
    const component = mount(FormulaHints, { target, props: { input, value: '=TEXTJ', onAccept } });
    flushSync();
    cleanup = () => {
      unmount(component);
      target.remove();
    };
    expect(options(target)).toHaveLength(1);
    expect(options(target)[0]).toContain('TEXTJOIN(delimiter, ignore_empty, text1, [text2, ...])');
    key(input, { key: 'Tab' });
    expect(onAccept).toHaveBeenCalledWith('=TEXTJOIN(');
    input.blur();
    flushSync();
    expect(target.querySelector('[data-formula-hints]')).toBeNull();
  });

  it('is exported alongside the FormulaBar', () => {
    expect(FormulaBar).toBeTypeOf('function');
    expect(FormulaHints).toBeTypeOf('function');
  });
});
