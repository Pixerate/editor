import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { ImageEditorController } from '@pixerate/editor/image-editor';
import { BrushOptionsBar, ImageEditor, createReactiveImageEditor } from '../src/image-editor';

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

function setValue(el: HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}
const button = (text: string) =>
  Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const click = (el: Element | null) => {
  (el as HTMLElement).click();
  flushSync();
};
const pointer = (type: string, x: number, y: number, altKey = false) => {
  const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, altKey });
  Object.assign(e, { pointerId: 1, pointerType: 'mouse', pressure: 0.5 });
  return e;
};

function controller() {
  const fake = { width: 300, height: 150, naturalWidth: 300, naturalHeight: 150, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: 300, height: 150, data: new Uint8ClampedArray(300 * 150 * 4).fill(255) });
  return c;
}

describe('Svelte paint tools', () => {
  it('BrushOptionsBar turns on gradient paint for the brush and edits it', () => {
    const c = controller();
    component = mount(BrushOptionsBar, { target, props: { controller: c } });
    flushSync();
    click(button('Brush'));
    click(button('Gradient'));
    expect(c.getState().paint.paint).toMatchObject({ type: 'gradient', stops: [{ color: 'paint' }, { color: 'secondary' }] });
    expect(target.querySelector('[data-testid="paint-gradient-editor"]')).not.toBeNull();
    const follows = target.querySelector('select[aria-label="Gradient follows"]') as HTMLSelectElement;
    follows.value = 'velocity';
    follows.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(c.getState().paint.paint).toMatchObject({ map: { by: 'velocity' } });
    click(button('Gradient'));
    expect(c.getState().paint.paint.type).toBe('color');
  });

  it('BrushOptionsBar sets tools, brush settings, colours and fills', () => {
    const c = controller();
    component = mount(BrushOptionsBar, { target, props: { controller: c } });
    flushSync();
    click(button('Eraser'));
    expect(c.getState().activeTool).toBe('eraser');
    setValue(target.querySelector('input[aria-label="Size"]')!, '42');
    expect(c.getState().paint.brush.size).toBe(42);
    setValue(target.querySelector('input[aria-label="Hardness"]')!, '0.3');
    expect(c.getState().paint.brush.hardness).toBe(0.3);
    click(target.querySelector('input[aria-label="Pressure controls opacity"]'));
    expect(c.getState().paint.brush.pressureOpacity).toBe(true);
    c.setPaintOptions({ foreground: '#112233' });
    flushSync();
    click(button('Swap'));
    expect(c.getState().paint.background).toBe('#112233');
    click(button('Fill'));
    expect(target.querySelector('[role="alert"]')!.textContent).toMatch(/none is active/);
    c.addPixelLayer();
    flushSync();
    click(button('Fill'));
    expect(c.getLayerBounds(c.getState().activeLayerId!)).toEqual({ x: 0, y: 0, width: 300, height: 150 });
  });

  it('BrushOptionsBar shows the Mixer Brush with its options and RGB / Pigment toggle', () => {
    const c = controller();
    component = mount(BrushOptionsBar, { target, props: { controller: c } });
    flushSync();
    expect(target.querySelector('[data-testid="mixer-options"]')).toBeNull();
    click(button('Mixer'));
    expect(c.getState().activeTool).toBe('mixer');
    expect(target.querySelector('[data-testid="mixer-options"]')).not.toBeNull();
    click(button('Pigment'));
    expect(c.getState().paint.mixer.mixing).toBe('pigment');
    expect(button('Pigment').getAttribute('aria-pressed')).toBe('true');
    expect(button('RGB').getAttribute('aria-pressed')).toBe('false');
    setValue(target.querySelector('input[aria-label="Wet"]')!, '0.8');
    setValue(target.querySelector('input[aria-label="Load"]')!, '0.25');
    setValue(target.querySelector('input[aria-label="Mix"]')!, '0.7');
    expect(c.getState().paint.mixer).toMatchObject({ wet: 0.8, load: 0.25, mix: 0.7 });
    click(target.querySelector('input[aria-label="Clean the brush after each stroke"]'));
    click(target.querySelector('input[aria-label="Load the brush after each stroke"]'));
    expect(c.getState().paint.mixer).toMatchObject({ cleanEachStroke: false, loadEachStroke: false });
    c.setPaintOptions({ foreground: '#0000ff' });
    flushSync();
    click(button('Load brush'));
    expect(c.getState().paint.mixerLoad).toMatchObject({ reservoir: [0, 0, 1], amount: 1 });
    expect((target.querySelector('[aria-label="Brush load"]') as HTMLElement).title).toMatch(/#0000ff, 100% left/);
    click(button('Clean brush'));
    expect(c.getState().paint.mixerLoad.pickup).toBeNull();
    click(button('RGB'));
    expect(c.getState().paint.mixer.mixing).toBe('rgb');
  });

  it('BrushOptionsBar shows each retouching tool with its options', () => {
    const c = controller();
    component = mount(BrushOptionsBar, { target, props: { controller: c } });
    flushSync();
    expect(target.querySelector('[data-testid="retouch-options"]')).toBeNull();
    click(button('Clone'));
    expect(c.getState().activeTool).toBe('clone');
    expect(target.querySelector('[data-testid="clone-source"]')!.textContent).toMatch(/Alt-click/);
    click(button('Current & Below'));
    expect(c.getState().paint.retouch.sample).toBe('current-below');
    click(target.querySelector('input[aria-label="Aligned"]'));
    expect(c.getState().paint.retouch.aligned).toBe(false);
    c.setCloneSource({ x: 12, y: 34 });
    flushSync();
    expect(target.querySelector('[data-testid="clone-source"]')!.textContent).toBe('Source 12, 34');
    click(button('Clear source'));
    expect(c.getState().paint.cloneSource).toBeNull();
    click(button('Spot Heal'));
    click(button('Content-Aware'));
    expect(c.getState().paint.retouch.spotType).toBe('content-aware');
    click(button('Smooth'));
    expect(c.getState().paint.retouch.spotType).toBe('smooth');
    click(button('Dodge'));
    click(button('Highlights'));
    setValue(target.querySelector('input[aria-label="Exposure"]')!, '0.2');
    expect(c.getState().paint.retouch).toMatchObject({ range: 'highlights', exposure: 0.2 });
    click(button('Sponge'));
    click(button('Saturate'));
    expect(c.getState().paint.retouch.spongeMode).toBe('saturate');
    click(button('Smudge'));
    setValue(target.querySelector('input[aria-label="Strength"]')!, '0.9');
    expect(c.getState().paint.retouch.strength).toBe(0.9);
  });

  it('paints on the canvas in the Paint tab and handles shortcuts', () => {
    const editor = createReactiveImageEditor();
    const c = editor.controller;
    const { width, height } = c.getState().imageDimensions;
    c.setSamplePixels({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) });
    const id = c.addPixelLayer();
    component = mount(ImageEditor, { target, props: { editor } });
    flushSync();
    click(button('Paint'));
    expect(c.getState().activeTool).toBe('brush');
    expect(target.querySelector('[data-testid="brush-options"]')).not.toBeNull();
    const canvas = target.querySelector('[data-testid="image-editor-canvas"]') as HTMLCanvasElement;
    canvas.dispatchEvent(pointer('pointerdown', 120, 70));
    canvas.dispatchEvent(pointer('pointermove', 150, 75));
    canvas.dispatchEvent(pointer('pointerup', 150, 75));
    flushSync();
    expect(c.getLayerBounds(id)).not.toBeNull();
    // The Mixer Brush smears what is there as one undo step.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'B', shiftKey: true }));
    expect(c.getState().activeTool).toBe('mixer');
    const before = c.getLayer(id);
    canvas.dispatchEvent(pointer('pointerdown', 110, 70));
    canvas.dispatchEvent(pointer('pointermove', 160, 72));
    canvas.dispatchEvent(pointer('pointerup', 160, 72));
    flushSync();
    expect(c.getLayer(id)).not.toBe(before);
    c.undo();
    expect(c.getLayer(id)).toEqual(before);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ']' }));
    expect(c.getState().paint.brush.size).toBe(25);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v' }));
    expect(c.getState().activeTool).toBe('move');
    // Clone Stamp: Alt-click sets the source, a drag clones as one undo step.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));
    expect(c.getState().activeTool).toBe('clone');
    canvas.dispatchEvent(pointer('pointerdown', 130, 72, true));
    canvas.dispatchEvent(pointer('pointerup', 130, 72, true));
    expect(c.getState().paint.cloneSource).not.toBeNull();
    const layers = c.getState().layers;
    canvas.dispatchEvent(pointer('pointerdown', 40, 30));
    canvas.dispatchEvent(pointer('pointermove', 60, 30));
    canvas.dispatchEvent(pointer('pointerup', 60, 30));
    flushSync();
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(c.getState().layers).not.toBe(layers);
  });
});
