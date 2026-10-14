// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FormulaHints, SpreadsheetEditor, useSpreadsheetEditor } from '../src';

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

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function key(target: Element, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

const options = () => Array.from(container.querySelectorAll('[role="option"]')).map((el) => el.textContent);
const activeArg = () => container.querySelector('[data-formula-signature] [data-active]')?.textContent;
const formulaBar = () => container.querySelector<HTMLInputElement>('input[aria-label="Formula bar"]')!;

describe('FormulaHints in the React SpreadsheetEditor', () => {
  it('suggests functions in the formula bar and accepts with Tab', async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => sheet.selectCell(0, 0));
    const input = formulaBar();
    await act(async () => input.focus());

    await typeInto(input, '=SUMI');
    expect(options()).toHaveLength(2);
    expect(options()[0]).toContain('SUMIF(range, criteria, [sum_range])');
    expect(options()[0]).toContain('Adds the cells that meet a condition.');
    expect(options()[1]).toContain('SUMIFS(');

    await key(input, { key: 'ArrowDown' });
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain('SUMIFS(');
    await key(input, { key: 'Tab' });
    expect(input.value).toBe('=SUMIFS(');
    expect(input.selectionStart).toBe(8);
    expect(options()).toHaveLength(0);
    expect(activeArg()).toBe('sum_range');
  });

  it('highlights the active argument while typing a call', async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => sheet.selectCell(0, 0));
    const input = formulaBar();
    await act(async () => input.focus());

    await typeInto(input, '=SUMIF(A1:A5, ');
    expect(activeArg()).toBe('criteria');
    expect(container.querySelector('[data-formula-signature]')?.textContent).toContain('criteria: The condition');
    await typeInto(input, '=SUMIF(A1:A5, ">3", ');
    expect(activeArg()).toBe('[sum_range]');
    await typeInto(input, 'plain text');
    expect(container.querySelector('[data-formula-hints]')).toBeNull();
  });

  it('works in the cell editor without the grid stealing keys', async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => sheet.startEditing(0, 0, '=COUNTI'));
    const cellInput = container.querySelector<HTMLInputElement>('td input')!;
    expect(document.activeElement).toBe(cellInput);
    expect(options().map((o) => o!.slice(0, 8))).toEqual(['COUNTIF(', 'COUNTIFS']);

    // Escape closes the list but keeps editing; Enter still commits.
    await key(cellInput, { key: 'Escape' });
    expect(options()).toHaveLength(0);
    expect(sheet.editingCell).not.toBeNull();

    await typeInto(cellInput, '=COUNTIF');
    await key(cellInput, { key: 'Tab' });
    expect(sheet.editingCell).not.toBeNull();
    expect(sheet.draftValue).toBe('=COUNTIF(');
  });

  it('accepts a suggestion on mouse down without blurring the input', async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => sheet.startEditing(1, 1, '=VLOO'));
    const cellInput = container.querySelector<HTMLInputElement>('td input')!;
    const option = container.querySelector('[role="option"]')!;
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    await act(async () => option.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(sheet.draftValue).toBe('=VLOOKUP(');
    expect(document.activeElement).toBe(cellInput);
  });

  it('shows error messages as a tooltip on error cells', async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => {
      sheet.setCellValue(sheet.document.rows[0].id, sheet.document.columns[0].id, '=SUMIF(5, ">1")');
      sheet.setCellValue(sheet.document.rows[1].id, sheet.document.columns[0].id, '=NOPE()');
    });
    const spans = container.querySelectorAll('tbody tr td:nth-child(2) span');
    expect(spans[0].textContent).toBe('#VALUE!');
    expect(spans[0].getAttribute('title')).toBe('Argument 1 of SUMIF must be a range.');
    expect(spans[1].getAttribute('title')).toBe('Unknown function "NOPE".');
  });
});

describe('FormulaHints standalone', () => {
  it('can be attached to any input', async () => {
    function Standalone() {
      const ref = useRef<HTMLInputElement>(null);
      const [value, setValue] = useState('=TEXTJ');
      return (
        <>
          <input ref={ref} value={value} onChange={(e) => setValue(e.target.value)} />
          <FormulaHints inputRef={ref} value={value} onAccept={setValue} />
        </>
      );
    }
    await act(async () => root.render(<Standalone />));
    const input = container.querySelector('input')!;
    await act(async () => input.focus());
    expect(options()).toHaveLength(1);
    await key(input, { key: 'Tab' });
    expect(input.value).toBe('=TEXTJOIN(');
    expect(activeArg()).toBe('delimiter');
    await act(async () => input.blur());
    expect(container.querySelector('[data-formula-hints]')).toBeNull();
  });
});
