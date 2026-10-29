// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ImageEditor, RefineEdgePanel, SelectionOptionsBar, useImageEditor } from '../src/image-editor';
import {
  DEFAULT_SELECTION_TOOL_OPTIONS,
  ImageEditorController,
  type SelectionToolOptions,
  DEFAULT_CANVAS_VIEWPORT,
} from '@pixerate/editor/image-editor';

let container: HTMLDivElement;
let root: any;
const win: any = window;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLCanvasElement.prototype.getContext = (() => null) as any;
});

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  container = document.getElementById('root') as HTMLDivElement;
  root = createRoot(container);
});

const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof win.HTMLSelectElement ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new win.Event(el instanceof win.HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

const fakeImage = (w: number, h: number) =>
  ({ width: w, height: h, naturalWidth: w, naturalHeight: h, src: '' }) as unknown as HTMLImageElement;

function pixels(w: number, h: number, f: (x: number, y: number) => number[]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

/** Left half red, right half blue. */
const halves = (x: number) => (x < 10 ? [220, 30, 30, 255] : [30, 30, 220, 255]);

function Bar({ controller }: { controller: ImageEditorController }) {
  const [options, setOptions] = React.useState<SelectionToolOptions>(DEFAULT_SELECTION_TOOL_OPTIONS);
  const [, force] = React.useState(0);
  React.useEffect(() => controller.subscribe(() => force((n) => n + 1)), [controller]);
  const s = controller.getState();
  return (
    <>
      <span data-testid="opts">{JSON.stringify(options)}</span>
      <SelectionOptionsBar controller={controller} options={options} onOptionsChange={setOptions} selection={s.selection ?? null} quickMask={Boolean(s.quickMask)} />
      <RefineEdgePanel controller={controller} selection={s.selection ?? null} layers={s.adjustments.layers} />
    </>
  );
}

describe('React SelectionOptionsBar', () => {
  it('switches tools and modes, edits tolerance, and runs select commands', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    await act(async () => root.render(<Bar controller={controller} />));
    const opts = () => JSON.parse(container.querySelector('[data-testid="opts"]')!.textContent!);
    expect(container.querySelector('[data-testid="selection-status"]')!.textContent).toBe('No selection');

    await act(async () => button('Add').click());
    expect(opts().mode).toBe('add');
    expect(button('Add').getAttribute('aria-pressed')).toBe('true');
    await act(async () => setValue(container.querySelector('input[aria-label="Tolerance"]')!, '90'));
    expect(opts().tolerance).toBe(90);
    await act(async () => button('Lasso').click());
    expect(opts().tool).toBe('lasso');
    expect(container.querySelector('input[aria-label="Tolerance"]')).toBeNull();

    await act(async () => button('Select All').click());
    expect(controller.getSelection()!.bounds).toEqual({ x: 0, y: 0, width: 20, height: 10 });
    expect(container.querySelector('[data-testid="selection-status"]')!.textContent).toBe('20 × 10 px selected (100% of the image)');
    await act(async () => setValue(container.querySelector('input[aria-label="Modify radius"]')!, '3'));
    await act(async () => button('Inverse').click());
    expect(controller.getSelection()).toBeNull();
    expect(button('Grow').disabled).toBe(true);

    await act(async () => button('Quick Mask').click());
    expect(controller.getState().quickMask).toBe(true);
    expect(button('Quick Mask').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('React SelectionOptionsBar: Select Subject', () => {
  it('shows only with a segmentation provider and selects the described subject', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    await act(async () => root.render(<Bar controller={controller} />));
    expect(container.querySelector('[data-testid="select-subject"]')).toBeNull();

    controller.setSegmentationProvider({ segment: async () => [] });
    const calls: unknown[][] = [];
    controller.selectSubject = (async (...args: unknown[]) => {
      calls.push(args);
      return { segments: [] };
    }) as any;
    await act(async () => root.render(<Bar controller={controller} />));
    const input = container.querySelector('input[aria-label="Subject to select"]') as HTMLInputElement;
    expect(button('Select Subject').disabled).toBe(true);
    await act(async () => setValue(input, 'the dog'));
    await act(async () => {
      button('Select Subject').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls).toEqual([['the dog', { mode: 'replace' }]]);
    expect(container.querySelector('[data-testid="select-subject"] [role="status"]')!.textContent).toContain('Nothing matching');
  });
});

describe('React RefineEdgePanel', () => {
  it('refines with the slider values and manages layer masks', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    controller.setSamplePixels(pixels(20, 10, halves));
    controller.selectRect({ x: 0, y: 0, width: 13, height: 10 }, { antiAlias: false });
    await act(async () => root.render(<Bar controller={controller} />));
    await act(async () => setValue(container.querySelector('input[aria-label="Radius"]')!, '6'));
    await act(async () => setValue(container.querySelector('input[aria-label="Contrast"]')!, '80'));
    await act(async () => {
      button('Refine Edge').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    // The edge moved from x = 13 toward the colour edge at x = 10.
    const row = Array.from(controller.getSelection()!.data.slice(5 * 20, 6 * 20));
    expect(row[12]).toBeLessThan(128);
    expect(row[9]).toBeGreaterThan(128);

    await act(async () => setValue(container.querySelector('select[aria-label="New masked layer kind"]')!, 'invert'));
    await act(async () => button('New Masked Layer').click());
    const layer = controller.getAdjustmentLayers()[0];
    expect(layer.kind).toBe('invert');
    expect(layer.mask).toBeDefined();
    await act(async () => setValue(container.querySelector('input[aria-label="Mask density"]')!, '40'));
    expect(controller.getAdjustmentLayers()[0].mask!.density).toBe(0.4);
    await act(async () => setValue(container.querySelector('input[aria-label="Mask feather"]')!, '2.5'));
    expect(controller.getAdjustmentLayers()[0].mask!.feather).toBe(2.5);
    await act(async () => button('Deselect').click());
    await act(async () => button('Load as Selection').click());
    expect(controller.getSelection()).not.toBeNull();
    await act(async () => button('Remove Mask').click());
    expect(controller.getAdjustmentLayers()[0].mask).toBeUndefined();
  });

  it('reports a refine error when pixels are unavailable', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    controller.selectAll();
    await act(async () => root.render(<RefineEdgePanel controller={controller} />));
    await act(async () => {
      button('Refine Edge').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector('[role="alert"]')!.textContent).toMatch(/pixels/);
  });
});

describe('React ImageEditor Select & Mask tab', () => {
  it('magic-wands on a canvas click and draws a rectangle selection by dragging', async () => {
    let hook: ReturnType<typeof useImageEditor> | null = null;
    const image = fakeImage(20, 10);
    function Host() {
      hook = useImageEditor({ image });
      return <ImageEditor editor={hook} />;
    }
    await act(async () => root.render(<Host />));
    hook!.controller.setSamplePixels(pixels(20, 10, halves));
    await act(async () => button('Select & Mask').click());
    expect(container.querySelector('[data-testid="selection-options-bar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="refine-edge-panel"]')).not.toBeNull();

    const canvas = container.querySelector('canvas')!;
    // jsdom: no layout, so the canvas projects through the fallback viewport and client coordinates
    // map 1:1; the 20×10 image is drawn 1:1 at its centre, so 5 px left of the centre is in the red half.
    const down = (x: number, y: number, extra: Record<string, unknown> = {}) =>
      canvas.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, ...extra }));
    const move = (x: number, y: number) => canvas.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
    const up = (x: number, y: number) => canvas.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
    const cx = DEFAULT_CANVAS_VIEWPORT.width / 2;
    const cy = DEFAULT_CANVAS_VIEWPORT.height / 2;
    await act(async () => {
      down(cx - 5, cy);
      await new Promise((r) => setTimeout(r, 0));
    });
    const wand = hook!.controller.getSelection()!;
    expect(wand.bounds!.x).toBe(0);
    expect(wand.bounds!.width).toBeGreaterThanOrEqual(10);
    expect(wand.bounds!.width).toBeLessThanOrEqual(11);
    expect(container.querySelector('[data-testid="selection-status"]')!.textContent).toMatch(/px selected/);

    // Rectangle tool: drag from the centre to the bottom-right corner area.
    await act(async () => button('Rectangle').click());
    await act(async () => {
      down(cx, cy);
      move(cx + 10, cy + 10);
      up(cx + 20, cy + 20);
    });
    const rect = hook!.controller.getSelection()!;
    expect(rect.bounds!.x).toBe(10);
    expect(rect.bounds!.y).toBe(5);
    // Undo goes back to the wand selection.
    await act(async () => hook!.undo());
    expect(hook!.controller.getSelection()!.bounds).toEqual(wand.bounds);
  });
});
