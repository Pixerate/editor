// @vitest-environment jsdom
// The DOM must exist before react-dom loads, or range inputs never fire onChange.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AdjustmentLayersPanel, Histogram, ImageEditor, useImageEditor, useImageHistogram } from '../src/image-editor';
import { IMAGE_ADJUSTMENT_CONTROLS, ImageEditorController, computeHistogram } from '@pixerate/editor/image-editor';

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

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof win.HTMLSelectElement ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new win.Event(el instanceof win.HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

function Panel({ controller }: { controller: ImageEditorController }) {
  const [, force] = React.useState(0);
  React.useEffect(() => controller.subscribe(() => force((n) => n + 1)), [controller]);
  return <AdjustmentLayersPanel controller={controller} layers={controller.getState().adjustments.layers} />;
}

describe('React Histogram', () => {
  it('draws one path per channel, clipping markers, and an empty state', async () => {
    const pixels = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 128, 64, 32, 255]);
    const h = computeHistogram({ data: pixels });
    await act(async () => root.render(<Histogram histogram={h} />));
    const svg = container.querySelector('[data-testid="image-editor-histogram"]')!;
    expect(svg.querySelectorAll('path')).toHaveLength(4);
    expect(svg.getAttribute('aria-label')).toBe('Histogram of 3 pixels');
    expect(container.querySelector('[data-testid="histogram-clip-shadows"]')).not.toBeNull();
    await act(async () => root.render(<Histogram histogram={null} channel="red" />));
    expect(container.querySelectorAll('path')).toHaveLength(0);
    expect(container.querySelector('svg')!.getAttribute('aria-label')).toBe('Histogram (no data)');
  });
});

describe('React histogram hooks', () => {
  it('follow the controller preview histogram', async () => {
    const controller = new ImageEditorController();
    let seen: ReturnType<typeof useImageHistogram> = null;
    function Test() {
      seen = useImageHistogram(controller);
      return null;
    }
    await act(async () => root.render(<Test />));
    expect(seen).toBeNull();
    const h = computeHistogram({ data: new Uint8ClampedArray([1, 2, 3, 255]) });
    // What a render does once it has the adjusted preview pixels.
    await act(async () => (controller as any).renderer.onPreviewHistogram(h));
    expect(seen).toBe(h);
  });
});

describe('React AdjustmentLayersPanel', () => {
  it('adds, edits, toggles, reorders and removes layers through the controller', async () => {
    const controller = new ImageEditorController();
    await act(async () => root.render(<Panel controller={controller} />));

    await act(async () => setValue(container.querySelector('select[aria-label="New adjustment layer kind"]')!, 'vibrance'));
    await act(async () => button('Add Layer').click());
    const [layer] = controller.getAdjustmentLayers();
    expect(layer.kind).toBe('vibrance');
    expect(container.querySelector('[data-testid="adjustment-layer-editor"]')).not.toBeNull();

    await act(async () => setValue(container.querySelector('input[aria-label="Vibrance"]')!, '35'));
    expect(controller.getAdjustmentLayer(layer.id)!.params).toEqual({ vibrance: 35, saturation: 0 });

    await act(async () => setValue(container.querySelector('select[aria-label="Blend mode"]')!, 'soft-light'));
    expect(controller.getAdjustmentLayer(layer.id)!.blend).toBe('soft-light');

    await act(async () => setValue(container.querySelector('input[aria-label="Layer opacity"]')!, '0.5'));
    expect(controller.getAdjustmentLayer(layer.id)!.opacity).toBe(0.5);

    await act(async () => (container.querySelector('input[aria-label="Show Vibrance"]') as HTMLInputElement).click());
    expect(controller.getAdjustmentLayer(layer.id)!.enabled).toBe(false);

    await act(async () => setValue(container.querySelector('select[aria-label="New adjustment layer kind"]')!, 'invert'));
    await act(async () => button('Add Layer').click());
    expect(controller.getAdjustmentLayers().map((l) => l.kind)).toEqual(['vibrance', 'invert']);
    // Listed top first.
    expect(Array.from(container.querySelectorAll('li')).map((li) => li.textContent?.includes('Invert'))).toEqual([true, false]);
    await act(async () => (container.querySelector('button[aria-label="Move Invert down"]') as HTMLButtonElement).click());
    expect(controller.getAdjustmentLayers().map((l) => l.kind)).toEqual(['invert', 'vibrance']);
    await act(async () => (container.querySelector('button[aria-label="Remove Invert"]') as HTMLButtonElement).click());
    expect(controller.getAdjustmentLayers().map((l) => l.kind)).toEqual(['vibrance']);
    await act(async () => {
      controller.undo();
    });
    expect(controller.getAdjustmentLayers()).toHaveLength(2);
  });

  it('edits curves by dragging points (one undo step per gesture)', async () => {
    const controller = new ImageEditorController();
    const id = controller.addAdjustmentLayer('curves');
    await act(async () => root.render(<Panel controller={controller} />));
    await act(async () => button('Curves').click());
    const svg = container.querySelector('[data-testid="curves-editor"]') as unknown as SVGSVGElement;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 256, height: 256, right: 256, bottom: 256, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const pointer = (type: string, x: number, y: number) =>
      svg.dispatchEvent(new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
    await act(async () => pointer('pointerdown', 64, 192));
    await act(async () => pointer('pointermove', 64, 128));
    await act(async () => pointer('pointerup', 64, 128));
    const layer = controller.getAdjustmentLayer(id)!;
    expect(layer.kind === 'curves' && layer.params.master).toEqual([
      { input: 0, output: 0 },
      { input: 64, output: 128 },
      { input: 255, output: 255 },
    ]);
    await act(async () => {
      controller.undo();
    });
    expect((controller.getAdjustmentLayer(id)!.params as any).master).toHaveLength(2);

    await act(async () => button('Red').click());
    expect(container.querySelector('svg[aria-label="red curve"]')).not.toBeNull();
  });

  it('shows Levels channels and Hue/Saturation ranges', async () => {
    const controller = new ImageEditorController();
    const levels = controller.addAdjustmentLayer('levels');
    const hs = controller.addAdjustmentLayer('hueSaturation');
    await act(async () => root.render(<Panel controller={controller} />));
    await act(async () => button('Levels').click());
    expect(container.querySelector('input[aria-label="RGB gamma"]')).not.toBeNull();
    await act(async () => button('Green').click());
    await act(async () => setValue(container.querySelector('input[aria-label="Green gamma"]')!, '1.5'));
    expect((controller.getAdjustmentLayer(levels)!.params as any).green.gamma).toBe(1.5);

    await act(async () => button('Hue/Saturation').click());
    await act(async () => button('Blues').click());
    expect(container.querySelector('[data-testid="hue-range-strip"]')).not.toBeNull();
    await act(async () => setValue(container.querySelector('input[aria-label="Blues saturation"]')!, '-40'));
    expect((controller.getAdjustmentLayer(hs)!.params as any).ranges[4].saturation).toBe(-40);
  });
});

describe('React ImageEditor adjustments tab', () => {
  it('renders the base sliders from the control table, the histogram and the layers panel', async () => {
    let hook: ReturnType<typeof useImageEditor> | null = null;
    function Test() {
      hook = useImageEditor();
      return <ImageEditor editor={hook} />;
    }
    await act(async () => root.render(<Test />));
    await act(async () => button('Adjustments').click());
    for (const spec of IMAGE_ADJUSTMENT_CONTROLS) {
      expect(container.querySelector(`input[aria-label="${spec.label}"]`), spec.id).not.toBeNull();
    }
    expect(container.querySelector('[data-testid="image-editor-histogram"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="adjustment-layers-panel"]')).not.toBeNull();
    await act(async () => setValue(container.querySelector('input[aria-label="Exposure"]')!, '42'));
    expect(hook!.state.adjustments.exposure).toBe(42);
    await act(async () => {
      hook!.addAdjustmentLayer('threshold');
    });
    expect(hook!.state.adjustments.layers).toHaveLength(1);
    expect(hook!.histogram).toBeNull();
  });
});
