import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import {
  DEFAULT_SELECTION_TOOL_OPTIONS,
  ImageEditorController,
  type SelectionToolOptions,
  DEFAULT_CANVAS_VIEWPORT,
} from '@pixerate/editor/image-editor';
import { ImageEditor, RefineEdgePanel, SelectionOptionsBar, createReactiveImageEditor } from '../src/image-editor';

let target: HTMLDivElement;
let component: Record<string, any> | null = null;

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as any;
  target = document.createElement('div');
  document.body.appendChild(target);
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  target.remove();
});

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  flushSync();
}

const button = (text: string) =>
  Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const click = (el: Element | null) => {
  (el as HTMLElement).click();
  flushSync();
};
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await tick();
  flushSync();
};

const fakeImage = (w: number, h: number) =>
  ({ width: w, height: h, naturalWidth: w, naturalHeight: h, src: '' }) as unknown as HTMLImageElement;

function pixels(w: number, h: number, f: (x: number, y: number) => number[]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

/** Left half red, right half blue. */
const halves = (x: number) => (x < 10 ? [220, 30, 30, 255] : [30, 30, 220, 255]);

describe('Svelte SelectionOptionsBar', () => {
  it('switches tools and modes, edits tolerance, and runs select commands', () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    const props = $state({
      controller,
      options: { ...DEFAULT_SELECTION_TOOL_OPTIONS } as SelectionToolOptions,
      onOptionsChange: (next: SelectionToolOptions) => {
        props.options = next;
      },
    });
    component = mount(SelectionOptionsBar, { target, props });
    flushSync();
    expect(target.querySelector('[data-testid="selection-status"]')!.textContent).toBe('No selection');

    click(button('Add'));
    expect(props.options.mode).toBe('add');
    expect(button('Add').getAttribute('aria-pressed')).toBe('true');
    setValue(target.querySelector('input[aria-label="Tolerance"]')!, '90');
    expect(props.options.tolerance).toBe(90);
    click(button('Lasso'));
    expect(props.options.tool).toBe('lasso');
    expect(target.querySelector('input[aria-label="Tolerance"]')).toBeNull();

    click(button('Select All'));
    expect(controller.getSelection()!.bounds).toEqual({ x: 0, y: 0, width: 20, height: 10 });
    expect(target.querySelector('[data-testid="selection-status"]')!.textContent).toBe('20 × 10 px selected (100% of the image)');
    click(button('Inverse'));
    expect(controller.getSelection()).toBeNull();
    expect(button('Grow').disabled).toBe(true);

    click(button('Quick Mask'));
    expect(controller.getState().quickMask).toBe(true);
    expect(button('Quick Mask').getAttribute('aria-pressed')).toBe('true');
    click(button('Hidden'));
    expect(controller.getSelectionDisplay()).toBe('none');
    expect(controller.getState().quickMask).toBe(false);
  });

  it('shows the wand distance, feather and the Color Range options and presets', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    const data = new Uint8ClampedArray(20 * 10 * 4);
    for (let i = 0; i < 200; i++) data.set(i % 20 < 10 ? [220, 30, 30, 255] : [30, 30, 220, 255], i * 4);
    controller.setSamplePixels({ width: 20, height: 10, data });
    const props = $state({
      controller,
      options: { ...DEFAULT_SELECTION_TOOL_OPTIONS } as SelectionToolOptions,
      onOptionsChange: (next: SelectionToolOptions) => {
        props.options = next;
      },
    });
    component = mount(SelectionOptionsBar, { target, props });
    flushSync();
    setValue(target.querySelector('select[aria-label="Colour distance"]')!, 'perceptual');
    expect(props.options.distance).toBe('perceptual');
    setValue(target.querySelector('input[aria-label="Feather"]')!, '4');
    expect(props.options.feather).toBe(4);
    expect(target.querySelector('[data-testid="color-range-options"]')).toBeNull();
    click(button('Color Range'));
    expect(target.querySelector('[data-testid="color-range-options"]')).not.toBeNull();
    setValue(target.querySelector('input[aria-label="Fuzziness"]')!, '10');
    expect(props.options.fuzziness).toBe(10);
    setValue(target.querySelector('input[aria-label="Feather"]')!, '0');
    setValue(target.querySelector('select[aria-label="Color Range preset"]')!, 'blues');
    click(button('Select'));
    await settle();
    expect(controller.getSelection()!.bounds).toEqual({ x: 10, y: 0, width: 10, height: 10 });
  });

  it('reselects, grows by colour and selects similar colours', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    const data = new Uint8ClampedArray(20 * 10 * 4);
    for (let i = 0; i < 200; i++) data.set(i % 20 < 10 ? [220, 30, 30, 255] : [30, 30, 220, 255], i * 4);
    controller.setSamplePixels({ width: 20, height: 10, data });
    const props = $state({
      controller,
      options: { ...DEFAULT_SELECTION_TOOL_OPTIONS } as SelectionToolOptions,
      onOptionsChange: (next: SelectionToolOptions) => {
        props.options = next;
      },
    });
    component = mount(SelectionOptionsBar, { target, props });
    flushSync();
    expect(button('Reselect').disabled).toBe(true);
    controller.selectRect({ x: 0, y: 0, width: 2, height: 2 }, { antiAlias: false });
    flushSync();
    click(button('Similar'));
    await settle();
    expect(controller.getSelection()!.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    click(button('Deselect'));
    expect(button('Reselect').disabled).toBe(false);
    click(button('Reselect'));
    expect(controller.getSelection()!.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    click(button('Crop to Selection'));
    expect(controller.getState().crop).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    const layers = controller.getLayers().length;
    click(button('Copy Merged'));
    click(button('Paste Into'));
    expect(controller.getLayers().length).toBe(layers + 1);
    expect(controller.getLayers()[controller.getLayers().length - 1]!.mask).toBeDefined();
    click(button('Polygonal Lasso'));
    expect(target.textContent).toContain('double-click, Enter or a click on the first corner closes it');
  });
});

describe('Svelte SelectionOptionsBar: Select Subject', () => {
  it('shows only with a segmentation provider and selects the described subject', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    const props = $state({
      controller,
      options: { ...DEFAULT_SELECTION_TOOL_OPTIONS } as SelectionToolOptions,
      onOptionsChange: (next: SelectionToolOptions) => {
        props.options = next;
      },
    });
    component = mount(SelectionOptionsBar, { target, props });
    flushSync();
    expect(target.querySelector('[data-testid="select-subject"]')).toBeNull();

    const calls: unknown[][] = [];
    controller.selectSubject = (async (...args: unknown[]) => {
      calls.push(args);
      return { segments: [] };
    }) as any;
    controller.setSegmentationProvider({ segment: async () => [] });
    flushSync();
    expect(button('Select Subject').disabled).toBe(true);
    setValue(target.querySelector('input[aria-label="Subject to select"]')!, 'the dog');
    click(button('Select Subject'));
    await settle();
    expect(calls).toEqual([['the dog', { mode: 'replace' }]]);
    expect(target.querySelector('[data-testid="select-subject"] [role="status"]')!.textContent).toContain('Nothing matching');
  });
});

describe('Svelte RefineEdgePanel', () => {
  it('refines with the slider values and manages layer masks', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    controller.setSamplePixels(pixels(20, 10, halves));
    controller.selectRect({ x: 0, y: 0, width: 13, height: 10 }, { antiAlias: false });
    component = mount(RefineEdgePanel, { target, props: { controller } });
    flushSync();
    setValue(target.querySelector('input[aria-label="Radius"]')!, '6');
    setValue(target.querySelector('input[aria-label="Contrast"]')!, '80');
    click(button('Refine Edge'));
    await settle();
    const row = Array.from(controller.getSelection()!.data.slice(5 * 20, 6 * 20));
    expect(row[12]).toBeLessThan(128);
    expect(row[9]).toBeGreaterThan(128);

    setValue(target.querySelector('select[aria-label="New masked layer kind"]')!, 'invert');
    click(button('New Masked Layer'));
    const layer = controller.getAdjustmentLayers()[0];
    expect(layer.kind).toBe('invert');
    expect(layer.mask).toBeDefined();
    setValue(target.querySelector('input[aria-label="Mask density"]')!, '40');
    expect(controller.getAdjustmentLayers()[0].mask!.density).toBe(0.4);
    setValue(target.querySelector('input[aria-label="Mask feather"]')!, '2.5');
    expect(controller.getAdjustmentLayers()[0].mask!.feather).toBe(2.5);
    controller.deselect();
    flushSync();
    click(button('Load as Selection'));
    expect(controller.getSelection()).not.toBeNull();
    click(button('Remove Mask'));
    expect(controller.getAdjustmentLayers()[0].mask).toBeUndefined();
  });

  it('reports a refine error when pixels are unavailable', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    controller.selectAll();
    component = mount(RefineEdgePanel, { target, props: { controller } });
    flushSync();
    click(button('Refine Edge'));
    await settle();
    expect(target.querySelector('[role="alert"]')!.textContent).toMatch(/pixels/);
  });
});

describe('Svelte ImageEditor Select & Mask tab', () => {
  it('magic-wands on a canvas click and draws a rectangle selection by dragging', async () => {
    const editor = createReactiveImageEditor({ image: fakeImage(20, 10) });
    editor.controller.setSamplePixels(pixels(20, 10, halves));
    component = mount(ImageEditor, { target, props: { editor } });
    flushSync();
    click(button('Select & Mask'));
    expect(target.querySelector('[data-testid="selection-options-bar"]')).not.toBeNull();
    expect(target.querySelector('[data-testid="refine-edge-panel"]')).not.toBeNull();

    const canvas = target.querySelector('canvas')!;
    const fire = (type: string, x: number, y: number) =>
      canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
    // jsdom: no layout, so the canvas projects through the fallback viewport and client coordinates
    // map 1:1; the 20×10 image is drawn 1:1 at its centre, so 5 px left of the centre is in the red half.
    const cx = DEFAULT_CANVAS_VIEWPORT.width / 2;
    const cy = DEFAULT_CANVAS_VIEWPORT.height / 2;
    fire('mousedown', cx - 5, cy);
    await settle();
    const wand = editor.controller.getSelection()!;
    expect(wand.bounds!.x).toBe(0);
    expect(wand.bounds!.width).toBeGreaterThanOrEqual(10);
    expect(wand.bounds!.width).toBeLessThanOrEqual(11);
    expect(target.querySelector('[data-testid="selection-status"]')!.textContent).toMatch(/px selected/);

    click(button('Rectangle'));
    fire('mousedown', cx, cy);
    fire('mousemove', cx + 10, cy + 10);
    fire('mouseup', cx + 20, cy + 20);
    flushSync();
    const rect = editor.controller.getSelection()!;
    expect(rect.bounds!.x).toBe(10);
    expect(rect.bounds!.y).toBe(5);
    editor.controller.undo();
    expect(editor.controller.getSelection()!.bounds).toEqual(wand.bounds);
    editor.destroy();
  });
});
