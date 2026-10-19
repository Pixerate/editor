import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import {
  IMAGE_ADJUSTMENT_CONTROLS,
  IMAGE_FILTER_PRESETS,
  IMAGE_CROP_PRESETS,
  DEPTH_MASK_CONTROLS,
  extractNormalizedLayerItems,
  ImageEditorController,
  computeHistogram,
} from '@pixerate/editor/image-editor';
import { AdjustmentLayersPanel, Histogram, ImageEditor, createImageHistogram, createReactiveImageEditor } from '../src/image-editor';

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

describe('Svelte Histogram', () => {
  it('draws one path per channel, clipping markers, and an empty state', () => {
    const h = computeHistogram({ data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 128, 64, 32, 255]) });
    component = mount(Histogram, { target, props: { histogram: h } });
    flushSync();
    const svg = target.querySelector('[data-testid="image-editor-histogram"]')!;
    expect(svg.querySelectorAll('path')).toHaveLength(4);
    expect(svg.getAttribute('aria-label')).toBe('Histogram of 3 pixels');
    expect(target.querySelector('[data-testid="histogram-clip-shadows"]')).not.toBeNull();
    unmount(component);
    component = mount(Histogram, { target, props: { histogram: null, channel: 'red' } });
    flushSync();
    expect(target.querySelectorAll('path')).toHaveLength(0);
    expect(target.querySelector('svg')!.getAttribute('aria-label')).toBe('Histogram (no data)');
  });
});

describe('Svelte histogram runes', () => {
  it('follow the controller preview histogram', () => {
    const editor = createReactiveImageEditor();
    const rune = createImageHistogram(editor.controller);
    expect(rune.current).toBeNull();
    expect(editor.histogram).toBeNull();
    const h = computeHistogram({ data: new Uint8ClampedArray([1, 2, 3, 255]) });
    // What a render does once it has the adjusted preview pixels.
    (editor.controller as any).renderer.onPreviewHistogram(h);
    expect(rune.current?.samples).toBe(1);
    expect(editor.histogram?.red[1]).toBe(1);
    rune.destroy();
    editor.destroy();
  });
});

describe('Svelte AdjustmentLayersPanel', () => {
  it('adds, edits, toggles, reorders and removes layers through the controller', () => {
    const controller = new ImageEditorController();
    component = mount(AdjustmentLayersPanel, { target, props: { controller } });
    flushSync();

    setValue(target.querySelector('select[aria-label="New adjustment layer kind"]')!, 'vibrance');
    click(button('Add Layer'));
    const [layer] = controller.getAdjustmentLayers();
    expect(layer.kind).toBe('vibrance');
    expect(target.querySelector('[data-testid="adjustment-layer-editor"]')).not.toBeNull();

    setValue(target.querySelector('input[aria-label="Vibrance"]')!, '35');
    expect(controller.getAdjustmentLayer(layer.id)!.params).toEqual({ vibrance: 35, saturation: 0 });

    setValue(target.querySelector('select[aria-label="Blend mode"]')!, 'soft-light');
    expect(controller.getAdjustmentLayer(layer.id)!.blend).toBe('soft-light');

    setValue(target.querySelector('input[aria-label="Layer opacity"]')!, '0.5');
    expect(controller.getAdjustmentLayer(layer.id)!.opacity).toBe(0.5);

    click(target.querySelector('input[aria-label="Show Vibrance"]'));
    expect(controller.getAdjustmentLayer(layer.id)!.enabled).toBe(false);

    setValue(target.querySelector('select[aria-label="New adjustment layer kind"]')!, 'invert');
    click(button('Add Layer'));
    expect(controller.getAdjustmentLayers().map((l) => l.kind)).toEqual(['vibrance', 'invert']);
    expect(Array.from(target.querySelectorAll('li')).map((li) => li.textContent?.includes('Invert'))).toEqual([true, false]);
    click(target.querySelector('button[aria-label="Move Invert down"]'));
    expect(controller.getAdjustmentLayers().map((l) => l.kind)).toEqual(['invert', 'vibrance']);
    click(target.querySelector('button[aria-label="Remove Invert"]'));
    expect(controller.getAdjustmentLayers().map((l) => l.kind)).toEqual(['vibrance']);
    controller.undo();
    flushSync();
    expect(target.querySelectorAll('li')).toHaveLength(2);
  });

  it('edits curves by dragging points (one undo step per gesture)', () => {
    const controller = new ImageEditorController();
    const id = controller.addAdjustmentLayer('curves');
    component = mount(AdjustmentLayersPanel, { target, props: { controller } });
    flushSync();
    click(button('Curves'));
    const svg = target.querySelector('[data-testid="curves-editor"]') as unknown as SVGSVGElement;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 256, height: 256, right: 256, bottom: 256, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const pointer = (type: string, x: number, y: number) => {
      svg.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
      flushSync();
    };
    pointer('pointerdown', 64, 192);
    pointer('pointermove', 64, 128);
    pointer('pointerup', 64, 128);
    const layer = controller.getAdjustmentLayer(id)!;
    expect(layer.kind === 'curves' && layer.params.master).toEqual([
      { input: 0, output: 0 },
      { input: 64, output: 128 },
      { input: 255, output: 255 },
    ]);
    controller.undo();
    expect((controller.getAdjustmentLayer(id)!.params as any).master).toHaveLength(2);
    flushSync();
    click(button('Red'));
    expect(target.querySelector('svg[aria-label="red curve"]')).not.toBeNull();
  });

  it('shows Levels channels and Hue/Saturation ranges', () => {
    const controller = new ImageEditorController();
    const levels = controller.addAdjustmentLayer('levels');
    const hs = controller.addAdjustmentLayer('hueSaturation');
    component = mount(AdjustmentLayersPanel, { target, props: { controller } });
    flushSync();
    click(button('Levels'));
    expect(target.querySelector('input[aria-label="RGB gamma"]')).not.toBeNull();
    click(button('Green'));
    setValue(target.querySelector('input[aria-label="Green gamma"]')!, '1.5');
    expect((controller.getAdjustmentLayer(levels)!.params as any).green.gamma).toBe(1.5);

    click(button('Hue/Saturation'));
    click(button('Blues'));
    expect(target.querySelector('[data-testid="hue-range-strip"]')).not.toBeNull();
    setValue(target.querySelector('input[aria-label="Blues saturation"]')!, '-40');
    expect((controller.getAdjustmentLayer(hs)!.params as any).ranges[4].saturation).toBe(-40);
  });
});

describe('Svelte ImageEditor adjustments tab', () => {
  it('renders the base sliders from the control table, the histogram and the layers panel', () => {
    const editor = createReactiveImageEditor();
    component = mount(ImageEditor, { target, props: { editor } });
    flushSync();
    click(button('Adjustments'));
    for (const spec of IMAGE_ADJUSTMENT_CONTROLS) {
      expect(target.querySelector(`input[aria-label="${spec.label}"]`), spec.id).not.toBeNull();
    }
    expect(target.querySelector('[data-testid="image-editor-histogram"]')).not.toBeNull();
    expect(target.querySelector('[data-testid="adjustment-layers-panel"]')).not.toBeNull();
    setValue(target.querySelector('input[aria-label="Exposure"]')!, '42');
    expect(editor.state.adjustments.exposure).toBe(42);
    editor.addAdjustmentLayer('threshold');
    flushSync();
    expect(editor.state.adjustments.layers).toHaveLength(1);
    expect(target.querySelectorAll('[data-testid="adjustment-layers-panel"] li')).toHaveLength(1);
    expect(editor.histogram).toBeNull();
    editor.destroy();
  });

  it('exposes filter presets, crop presets, depth mask controls, and normalized layer items', () => {
    expect(IMAGE_FILTER_PRESETS.map((p) => p.id)).toContain('cyberpunk');
    expect(IMAGE_CROP_PRESETS.map((p) => p.label)).toContain('16:9');
    expect(DEPTH_MASK_CONTROLS.map((c) => c.id)).toEqual(['near', 'far']);

    const controller = new ImageEditorController();
    controller.addPixelLayer({ name: 'Overlay' });
    const items = extractNormalizedLayerItems(controller, 'https://example.com/fallback.png');
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.name)).toEqual(['Background', 'Overlay']);
    expect(items[0].width).toBe(1);
    expect(items[0].height).toBe(1);
  });
});

