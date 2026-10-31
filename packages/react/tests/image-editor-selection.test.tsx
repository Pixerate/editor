// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ChannelsPanel, ImageEditor, PathsPanel, RefineEdgePanel, SelectionOptionsBar, useImageEditor } from '../src/image-editor';
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
    await act(async () => button('Hidden').click());
    expect(controller.getSelectionDisplay()).toBe('none');
    expect(controller.getState().quickMask).toBe(false);
  });

  it('shows the wand distance, feather and the Color Range options and presets', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    controller.setSamplePixels(pixels(20, 10, halves));
    await act(async () => root.render(<Bar controller={controller} />));
    const opts = () => JSON.parse(container.querySelector('[data-testid="opts"]')!.textContent!);
    await act(async () => setValue(container.querySelector('select[aria-label="Colour distance"]')!, 'perceptual'));
    expect(opts().distance).toBe('perceptual');
    await act(async () => setValue(container.querySelector('input[aria-label="Feather"]')!, '4'));
    expect(opts().feather).toBe(4);
    expect(container.querySelector('[data-testid="color-range-options"]')).toBeNull();
    // The Type Mask tools show their text, size and font.
    expect(container.querySelector('[data-testid="type-mask-options"]')).toBeNull();
    await act(async () => button('Vertical Type Mask').click());
    expect(opts().tool).toBe('type-vertical');
    await act(async () => setValue(container.querySelector('input[aria-label="Type mask text"]')!, 'SALE'));
    await act(async () => setValue(container.querySelector('input[aria-label="Type mask size"]')!, '120'));
    await act(async () => setValue(container.querySelector('input[aria-label="Type mask font"]')!, 'Inter'));
    expect(opts()).toMatchObject({ typeText: 'SALE', typeSize: 120, typeFamily: 'Inter' });
    // The Magnetic Lasso shows its width, contrast and frequency.
    await act(async () => button('Magnetic Lasso').click());
    expect(container.querySelector('[data-testid="magnetic-lasso-options"]')).not.toBeNull();
    await act(async () => setValue(container.querySelector('input[aria-label="Magnetic lasso width"]')!, '24'));
    await act(async () => setValue(container.querySelector('input[aria-label="Magnetic lasso contrast"]')!, '30'));
    await act(async () => setValue(container.querySelector('input[aria-label="Magnetic lasso frequency"]')!, '80'));
    expect(opts()).toMatchObject({ tool: 'magnetic', magneticWidth: 24, magneticContrast: 30, magneticFrequency: 80 });
    // Quick Selection shows its size, Sample all layers and Auto-enhance.
    await act(async () => button('Quick Selection').click());
    await act(async () => setValue(container.querySelector('input[aria-label="Quick selection size"]')!, '60'));
    await act(async () => (container.querySelector('[aria-label="Auto-enhance edges"]') as HTMLElement).click());
    await act(async () => (container.querySelector('[aria-label="Sample all layers"]') as HTMLElement).click());
    expect(opts()).toMatchObject({ tool: 'quick', quickSize: 60, quickEnhance: true, quickSampleAll: false });
    // Object Selection shows Sample all layers and Auto-enhance.
    await act(async () => button('Object Selection').click());
    expect(container.querySelector('[data-testid="object-selection-options"]')).not.toBeNull();
    await act(async () => (container.querySelector('[aria-label="Object auto-enhance edges"]') as HTMLElement).click());
    await act(async () => (container.querySelector('[aria-label="Object sample all layers"]') as HTMLElement).click());
    expect(opts()).toMatchObject({ tool: 'object', objectEnhance: true, objectSampleAll: false });
    await act(async () => button('Color Range').click());
    expect(container.querySelector('[data-testid="color-range-options"]')).not.toBeNull();
    await act(async () => setValue(container.querySelector('input[aria-label="Fuzziness"]')!, '10'));
    expect(opts().fuzziness).toBe(10);
    await act(async () => setValue(container.querySelector('input[aria-label="Feather"]')!, '0'));
    await act(async () => setValue(container.querySelector('select[aria-label="Color Range preset"]')!, 'blues'));
    await act(async () => button('Select').click());
    expect(controller.getSelection()!.bounds).toEqual({ x: 10, y: 0, width: 10, height: 10 });
  });

  it('reselects, grows by colour and selects similar colours', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    controller.setSamplePixels(pixels(20, 10, halves));
    await act(async () => root.render(<Bar controller={controller} />));
    expect(button('Reselect').disabled).toBe(true);
    await act(async () => void controller.selectRect({ x: 0, y: 0, width: 2, height: 2 }, { antiAlias: false }));
    await act(async () => button('Similar').click());
    expect(controller.getSelection()!.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    await act(async () => button('Deselect').click());
    expect(button('Reselect').disabled).toBe(false);
    await act(async () => button('Reselect').click());
    expect(controller.getSelection()!.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    // Edit: crop, copy and paste through the options bar.
    await act(async () => button('Crop to Selection').click());
    expect(controller.getState().crop).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    const layers = controller.getLayers().length;
    await act(async () => button('Copy Merged').click());
    await act(async () => button('Paste Into').click());
    expect(controller.getLayers().length).toBe(layers + 1);
    expect(controller.getLayers()[controller.getLayers().length - 1]!.mask).toBeDefined();
    await act(async () => button('Polygonal Lasso').click());
    expect(container.textContent).toContain('double-click, Enter or a click on the first corner closes it');
  });
});

describe('React SelectionOptionsBar: Select Subject', () => {
  it('selects the subject that stands out without a model, and the described one with a model', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    // A dark square on a light ground.
    controller.setSamplePixels(pixels(20, 10, (x, y) => (x >= 8 && x < 12 && y >= 3 && y < 7 ? [30, 30, 30, 255] : [230, 230, 230, 255])));
    await act(async () => root.render(<Bar controller={controller} />));
    expect(container.querySelector('input[aria-label="Subject to select"]')).toBeNull();
    await act(async () => {
      button('Select Subject').click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(controller.getSelection()!.bounds).toEqual({ x: 8, y: 3, width: 4, height: 4 });

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
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('the dog');
    expect(calls[0][1]).toMatchObject({ mode: 'replace' });
    expect(container.querySelector('[data-testid="select-subject"] [role="status"]')!.textContent).toContain('Nothing matching');
  });
});

describe('React SelectionOptionsBar: Select Sky', () => {
  it('selects the sky with the options bar mode and shows why when there is none', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    const calls: unknown[] = [];
    controller.selectSky = (async (opts: unknown) => {
      calls.push(opts);
      return { selection: null, note: 'No sky was found along the top of the image.' };
    }) as any;
    await act(async () => root.render(<Bar controller={controller} />));
    await act(async () => {
      button('Select Sky').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls[0]).toMatchObject({ mode: 'replace' });
    expect(container.querySelector('[data-testid="select-sky"] [role="status"]')!.textContent).toContain('No sky');
  });
});

describe('React SelectionOptionsBar: progress', () => {
  it('shows a long selection\'s progress and cancels it', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    controller.selectSky = ((opts: { signal: AbortSignal; onProgress: (f: number, s: string) => void }) =>
      new Promise((_, reject) => {
        opts.onProgress(0.4, 'Growing the sky');
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })));
      })) as any;
    await act(async () => root.render(<Bar controller={controller} />));
    await act(async () => button('Select Sky').click());
    const bar = container.querySelector('[data-testid="selection-progress"] [role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
    expect(container.textContent).toContain('Growing the sky');
    await act(async () => {
      container.querySelector('[data-testid="selection-progress"] button')!.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector('[data-testid="selection-progress"]')).toBeNull();
    expect(container.querySelector('[data-testid="select-sky"] [role="status"]')!.textContent).toBe('Cancelled.');
  });
});

describe('React SelectionOptionsBar: Focus Area', () => {
  it('selects the focus area with the range, noise and softness from the options', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    const calls: unknown[] = [];
    controller.selectFocusArea = (async (opts: unknown) => {
      calls.push(opts);
      return { selection: null, noiseLevel: 0 };
    }) as any;
    await act(async () => root.render(<Bar controller={controller} />));
    await act(async () => setValue(container.querySelector('input[aria-label="In-focus range"]')!, '70'));
    await act(async () => setValue(container.querySelector('input[aria-label="Image noise level"]')!, '20'));
    await act(async () => setValue(container.querySelector('input[aria-label="Focus soften edge"]')!, '0'));
    await act(async () => {
      button('Select Focus Area').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls[0]).toMatchObject({ range: 70, noise: 20, softness: 0, mode: 'replace' });
    expect(container.querySelector('[data-testid="focus-area"] [role="status"]')!.textContent).toContain('No part');
  });
});

describe('React MaskEdgeCheck', () => {
  it('checks the selection edge in the Refine Edge panel and clears with a new selection', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    controller.setSamplePixels(pixels(20, 10, halves));
    controller.selectRect({ x: 0, y: 0, width: 13, height: 10 }, { antiAlias: false });
    await act(async () => root.render(<Bar controller={controller} />));
    await act(async () => button('Check Edge').click());
    const check = container.querySelector('[data-testid="mask-edge-check"]')!;
    expect(check.textContent).toContain('Halo');
    expect(container.querySelector('[data-testid="mask-edge-issues"]')!.textContent).toMatch(/^Halo/);
    await act(async () => controller.selectRect({ x: 0, y: 0, width: 10, height: 10 }, { antiAlias: false }));
    expect(container.querySelector('[data-testid="mask-edge-issues"]')).toBeNull();
    await act(async () => button('Check Edge').click());
    expect(check.textContent).toContain('The edge looks clean.');
  });
});

describe('React RefineEdgePanel uncertain areas', () => {
  it('refines only the uncertain areas, and says when there are none', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    controller.setSamplePixels(pixels(20, 10, halves));
    controller.selectRect({ x: 0, y: 0, width: 10, height: 10 }, { antiAlias: false });
    await act(async () => root.render(<RefineEdgePanel controller={controller} />));
    await act(async () => (container.querySelector('input[aria-label="Only uncertain areas"]') as HTMLInputElement).click());
    await act(async () => {
      button('Refine Edge').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector('[data-testid="refine-edge-panel"] [role="alert"]')!.textContent).toMatch(/No uncertain areas/);
    // An edge in the flat red half is uncertain: refining there moves it.
    controller.selectRect({ x: 0, y: 0, width: 6, height: 10 }, { antiAlias: false });
    const before = controller.getSelection();
    await act(async () => {
      button('Refine Edge').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector('[data-testid="refine-edge-panel"] [role="alert"]')).toBeNull();
    expect(controller.getSelection()).not.toBe(before);
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

  it('outputs to the chosen place, with decontamination only for new layers', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    controller.setSamplePixels(pixels(20, 10, halves));
    controller.selectRect({ x: 0, y: 0, width: 10, height: 10 });
    await act(async () => root.render(<RefineEdgePanel controller={controller} />));
    const amount = container.querySelector('input[aria-label="Decontaminate amount"]') as HTMLInputElement;
    expect(amount.disabled).toBe(true);
    await act(async () => setValue(container.querySelector('select[aria-label="Refine output"]')!, 'new-layer'));
    expect(amount.disabled).toBe(false);
    await act(async () => setValue(amount, '60'));
    await act(async () => {
      button('Refine Edge').click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(controller.getLayers()).toHaveLength(2);
    expect(controller.getLayer('background')!.visible).toBe(false);
    expect(controller.getSelection()).toBeNull();
  });

  it('lists the new document outputs only when the host can open documents', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    await act(async () => root.render(<RefineEdgePanel controller={controller} />));
    const count = () => container.querySelectorAll('select[aria-label="Refine output"] option').length;
    expect(count()).toBe(4);
    controller.setDocumentOpener(() => undefined);
    await act(async () => root.render(<RefineEdgePanel controller={controller} />));
    expect(count()).toBe(6);
  });

  it('offers object aware refinement only with a segmentation model', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    controller.selectRect({ x: 0, y: 0, width: 10, height: 10 });
    await act(async () => root.render(<RefineEdgePanel controller={controller} />));
    expect(container.querySelector('input[aria-label="Object aware"]')).toBeNull();
    controller.setSegmentationProvider({ segment: async () => [] });
    const calls: unknown[][] = [];
    controller.refineSelectionTo = (async (...args: unknown[]) => {
      calls.push(args);
      return { output: 'selection', refineMode: 'object' };
    }) as any;
    await act(async () => root.render(<RefineEdgePanel controller={controller} />));
    await act(async () => (container.querySelector('input[aria-label="Object aware"]') as HTMLInputElement).click());
    await act(async () => {
      button('Refine Edge').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls[0][2]).toMatchObject({ refineMode: 'object' });
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

describe('React ChannelsPanel', () => {
  it('saves, loads, shows, duplicates and deletes channels, and toggles Quick Mask', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    await act(async () => root.render(<ChannelsPanel controller={controller} />));
    expect(container.textContent).toContain('No channels');
    expect(button('Save Selection').disabled).toBe(true);
    await act(async () => void controller.selectRect({ x: 0, y: 0, width: 5, height: 10 }, { antiAlias: false }));
    await act(async () => button('Save Selection').click());
    const rows = () => container.querySelectorAll('[data-testid="channel-row"]');
    expect(rows().length).toBe(1);
    expect(rows()[0]!.textContent).toContain('Alpha 1');
    await act(async () => void controller.deselect());
    await act(async () => (rows()[0] as HTMLElement).click());
    expect(controller.getSelection()!.bounds).toEqual({ x: 0, y: 0, width: 5, height: 10 });
    await act(async () => (container.querySelector('button[aria-label="Show Alpha 1"]') as HTMLButtonElement).click());
    expect(controller.getChannels()[0]!.visible).toBe(true);
    await act(async () => button('Duplicate').click());
    expect(controller.getChannels().map((c) => c.name)).toEqual(['Alpha 1', 'Alpha 1 copy']);
    await act(async () => button('Delete').click());
    expect(controller.getChannels().map((c) => c.name)).toEqual(['Alpha 1']);
    await act(async () => button('Quick Mask').click());
    expect(controller.quickMaskEditing).toBe(true);
    expect(button('Quick Mask').getAttribute('aria-pressed')).toBe('true');
  });

  it('imports a mask image into a channel and exports the channel or selection as a PNG', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    await act(async () => root.render(<ChannelsPanel controller={controller} />));
    expect(button('Export PNG').disabled).toBe(true);
    const downloads: { href: string; download: string }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ href: this.href, download: this.download });
    });
    await act(async () => void controller.selectRect({ x: 0, y: 0, width: 5, height: 10 }, { antiAlias: false }));
    await act(async () => button('Export PNG').click());
    expect(downloads[0]).toMatchObject({ download: 'selection.png' });
    expect(downloads[0]!.href).toMatch(/^data:image\/png;base64,/);

    const load = vi.spyOn(controller, 'loadChannelFromImage');
    const input = container.querySelector('[data-testid="channel-import-input"]') as HTMLInputElement;
    expect(input.accept).toContain('image/png');
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([new Uint8Array([1, 2, 3])], 'Sky matte.png', { type: 'image/png' })] });
    load.mockImplementation(async () => controller.saveSelection({ name: 'Sky matte' }));
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // FileReader is asynchronous; wait for the load rather than a fixed time.
      await vi.waitFor(() => expect(load).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(load).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/), { name: 'Sky matte' });
    expect(container.querySelector('[data-testid="channel-row"][aria-current="true"]')!.textContent).toContain('Sky matte');
    await act(async () => button('Export PNG').click());
    expect(downloads[1]).toMatchObject({ download: 'Sky matte.png' });
    click.mockRestore();
  });
});

describe('React Select and Mask workspace', () => {
  const pointer = (el: Element, type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
    el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1, ...extra }));

  it('opens from the options bar, paints a brush stroke, changes the view, and applies with OK', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    controller.setSamplePixels(pixels(20, 10, halves));
    await act(async () => root.render(<Bar controller={controller} />));
    await act(async () => button('Select and Mask…').click());
    const dialog = container.querySelector('[data-testid="select-and-mask-workspace"]')!;
    expect(dialog).not.toBeNull();
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    // The view, by its select and by its key.
    await act(async () => setValue(dialog.querySelector('select[aria-label="View"]')!, 'on-black'));
    expect((dialog.querySelector('select[aria-label="View"]') as HTMLSelectElement).value).toBe('on-black');
    await act(async () => window.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'k' })));
    expect((dialog.querySelector('select[aria-label="View"]') as HTMLSelectElement).value).toBe('black-white');
    // Paint the left half with the brush (preview canvas mapped to the 20 × 10 image).
    await act(async () => button('Brush').click());
    await act(async () => setValue(dialog.querySelector('input[aria-label="Brush size"]')!, '6'));
    await act(async () => setValue(dialog.querySelector('input[aria-label="Workspace Radius"]')!, '0'));
    const canvas = dialog.querySelector('[data-testid="select-and-mask-preview"]')!;
    (canvas as HTMLElement).getBoundingClientRect = () => ({ left: 0, top: 0, width: 20, height: 10, right: 20, bottom: 10, x: 0, y: 0, toJSON() {} }) as DOMRect;
    await act(async () => {
      pointer(canvas, 'pointerdown', 3, 5);
      pointer(canvas, 'pointermove', 7, 5);
      pointer(canvas, 'pointerup', 7, 5);
    });
    expect(dialog.textContent).toContain('1 strokes');
    expect(controller.getSelection()).toBeNull();
    await act(async () => {
      button('OK').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector('[data-testid="select-and-mask-workspace"]')).toBeNull();
    expect(controller.getSelection()!.bounds!.x).toBe(0);
  });

  it('cancels with Escape and leaves the document as it was', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    controller.setSamplePixels(pixels(20, 10, halves));
    await act(async () => root.render(<Bar controller={controller} />));
    await act(async () => button('Select and Mask…').click());
    await act(async () => window.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' })));
    expect(container.querySelector('[data-testid="select-and-mask-workspace"]')).toBeNull();
    expect(controller.getSelection()).toBeNull();
  });
});

describe('React PathsPanel', () => {
  it('makes a work path, saves it, loads it as a selection, fills it and deletes it', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    controller.setSamplePixels(pixels(20, 10, halves));
    await act(async () => root.render(<PathsPanel controller={controller} />));
    expect(container.textContent).toContain('No paths');
    expect(button('Make Work Path').disabled).toBe(true);
    await act(async () => controller.selectRect({ x: 2, y: 2, width: 6, height: 5 }));
    await act(async () => button('Make Work Path').click());
    const row = () => container.querySelector('[data-testid="path-row"]') as HTMLElement;
    expect(row().textContent).toBe('Work Path');
    expect(row().getAttribute('aria-current')).toBe('true');
    await act(async () => button('Save Path').click());
    const input = container.querySelector('input[aria-label="Path name"]') as HTMLInputElement;
    input.value = 'Box';
    await act(async () => input.dispatchEvent(new win.FocusEvent('blur', { bubbles: true })));
    await act(async () => input.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true })));
    expect(controller.getPaths()[0]).toMatchObject({ name: 'Box' });
    expect(controller.getPaths()[0].work).toBeUndefined();
    await act(async () => controller.deselect());
    await act(async () => button('Load as Selection').click());
    expect(controller.getSelection()!.bounds).toEqual({ x: 2, y: 2, width: 6, height: 5 });
    await act(async () => controller.deselect());
    await act(async () => button('Fill Path').click());
    expect(controller.getSelection()).toBeNull();
    await act(async () => button('Delete').click());
    expect(controller.getPaths()).toHaveLength(0);
  });
});

describe('React Content-Aware Fill workspace', () => {
  const pointer = (el: Element, type: string, x: number, y: number) =>
    el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 }));

  it('opens on a selection, paints the sampling area, fills with OK, and cancels with Escape', async () => {
    const controller = new ImageEditorController({ image: fakeImage(20, 10) });
    controller.setSamplePixels(pixels(20, 10, halves));
    controller.selectRect({ x: 8, y: 3, width: 4, height: 4 });
    await act(async () => root.render(<Bar controller={controller} />));
    await act(async () => {
      button('Content-Aware Fill…').click();
      await new Promise((r) => setTimeout(r, 20));
    });
    const dialog = container.querySelector('[data-testid="content-aware-fill-workspace"]')!;
    expect(dialog).not.toBeNull();
    // The small image shows whole (no Expand View); the outputs include Duplicate Layer.
    expect(button('Expand View')).toBeUndefined();
    expect(Array.from(dialog.querySelectorAll('select[aria-label="Fill output"] option')).map((o) => (o as HTMLOptionElement).value)).toContain('duplicate-layer');
    // Paint the right half out of the sampling area (the source view is the whole 20 × 10 image here).
    await act(async () => button('Subtract').click());
    await act(async () => setValue(dialog.querySelector('input[aria-label="Sampling brush size"]')!, '6'));
    const source = dialog.querySelector('[data-testid="content-aware-fill-source"]') as HTMLElement;
    source.getBoundingClientRect = () => ({ left: 0, top: 0, width: 20, height: 10, right: 20, bottom: 10, x: 0, y: 0, toJSON() {} }) as DOMRect;
    await act(async () => {
      pointer(source, 'pointerdown', 17, 0);
      pointer(source, 'pointermove', 17, 10);
      pointer(source, 'pointerup', 17, 10);
    });
    expect((Array.from(dialog.querySelectorAll('[aria-label="Sampling area"] button')).find((b) => b.textContent === 'Custom') as HTMLElement).getAttribute('aria-pressed')).toBe('true');
    const layers = controller.getLayers().length;
    await act(async () => {
      button('OK').click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.querySelector('[data-testid="content-aware-fill-workspace"]')).toBeNull();
    expect(controller.getLayers()).toHaveLength(layers + 1);
    await act(async () => {
      button('Content-Aware Fill…').click();
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => window.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' })));
    expect(container.querySelector('[data-testid="content-aware-fill-workspace"]')).toBeNull();
    expect(controller.getLayers()).toHaveLength(layers + 1);
  });
});
