// @vitest-environment jsdom
// The DOM must exist before react-dom loads, or range inputs never fire onChange.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BrushOptionsBar, ImageEditor, useImageEditor } from '../src/image-editor';
import { ImageEditorController } from '@pixerate/editor/image-editor';

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

function setValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new win.Event(el.type === 'checkbox' ? 'click' : 'input', { bubbles: true }));
}
const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

function controller() {
  const fake = { width: 300, height: 150, naturalWidth: 300, naturalHeight: 150, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: 300, height: 150, data: new Uint8ClampedArray(300 * 150 * 4).fill(255) });
  return c;
}

const pointer = (type: string, x: number, y: number) => {
  const e = new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.assign(e, { pointerId: 1, pointerType: 'mouse', pressure: 0.5 });
  return e;
};

describe('React paint tools', () => {
  it('BrushOptionsBar sets tools, brush settings, colours and fills', async () => {
    const c = controller();
    await act(async () => root.render(<BrushOptionsBar controller={c} />));
    await act(async () => button('Eraser').click());
    expect(c.getState().activeTool).toBe('eraser');
    await act(async () => setValue(container.querySelector('input[aria-label="Size"]')!, '42'));
    expect(c.getState().paint.brush.size).toBe(42);
    await act(async () => setValue(container.querySelector('input[aria-label="Hardness"]')!, '0.3'));
    expect(c.getState().paint.brush.hardness).toBe(0.3);
    await act(async () => (container.querySelector('input[aria-label="Pressure controls opacity"]') as HTMLInputElement).click());
    expect(c.getState().paint.brush.pressureOpacity).toBe(true);
    c.setPaintOptions({ foreground: '#112233' });
    await act(async () => button('Swap').click());
    expect(c.getState().paint.background).toBe('#112233');
    await act(async () => button('Fill').click());
    expect(container.querySelector('[role="alert"]')!.textContent).toMatch(/none is active/);
    c.addPixelLayer();
    await act(async () => button('Fill').click());
    expect(c.getLayerBounds(c.getState().activeLayerId!)).toEqual({ x: 0, y: 0, width: 300, height: 150 });
  });

  it('BrushOptionsBar shows the Mixer Brush with its options and RGB / Pigment toggle', async () => {
    const c = controller();
    await act(async () => root.render(<BrushOptionsBar controller={c} />));
    expect(container.querySelector('[data-testid="mixer-options"]')).toBeNull();
    await act(async () => button('Mixer').click());
    expect(c.getState().activeTool).toBe('mixer');
    expect(container.querySelector('[data-testid="mixer-options"]')).not.toBeNull();
    await act(async () => button('Pigment').click());
    expect(c.getState().paint.mixer.mixing).toBe('pigment');
    expect(button('Pigment').getAttribute('aria-pressed')).toBe('true');
    expect(button('RGB').getAttribute('aria-pressed')).toBe('false');
    await act(async () => setValue(container.querySelector('input[aria-label="Wet"]')!, '0.8'));
    await act(async () => setValue(container.querySelector('input[aria-label="Load"]')!, '0.25'));
    await act(async () => setValue(container.querySelector('input[aria-label="Mix"]')!, '0.7'));
    expect(c.getState().paint.mixer).toMatchObject({ wet: 0.8, load: 0.25, mix: 0.7 });
    await act(async () => (container.querySelector('input[aria-label="Clean the brush after each stroke"]') as HTMLInputElement).click());
    await act(async () => (container.querySelector('input[aria-label="Load the brush after each stroke"]') as HTMLInputElement).click());
    expect(c.getState().paint.mixer).toMatchObject({ cleanEachStroke: false, loadEachStroke: false });
    c.setPaintOptions({ foreground: '#0000ff' });
    await act(async () => button('Load brush').click());
    expect(c.getState().paint.mixerLoad).toMatchObject({ reservoir: [0, 0, 1], amount: 1 });
    expect((container.querySelector('[aria-label="Brush load"]') as HTMLElement).title).toMatch(/#0000ff, 100% left/);
    await act(async () => button('Clean brush').click());
    expect(c.getState().paint.mixerLoad.pickup).toBeNull();
    await act(async () => button('RGB').click());
    expect(c.getState().paint.mixer.mixing).toBe('rgb');
  });

  it('paints on the canvas in the Paint tab and handles shortcuts', async () => {
    let c!: ImageEditorController;
    function Host() {
      const editor = useImageEditor();
      c = editor.controller;
      return <ImageEditor editor={editor} />;
    }
    await act(async () => root.render(<Host />));
    const { width, height } = c.getState().imageDimensions;
    c.setSamplePixels({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) });
    let id!: string;
    await act(async () => {
      id = c.addPixelLayer();
    });
    await act(async () => button('Paint').click());
    expect(c.getState().activeTool).toBe('brush');
    expect(container.querySelector('[data-testid="brush-options"]')).not.toBeNull();
    const canvas = container.querySelector('[data-testid="image-editor-canvas"]') as HTMLCanvasElement;
    await act(async () => {
      canvas.dispatchEvent(pointer('pointerdown', 120, 70));
      canvas.dispatchEvent(pointer('pointermove', 150, 75));
      canvas.dispatchEvent(pointer('pointerup', 150, 75));
    });
    expect(c.getLayerBounds(id)).not.toBeNull();
    // The Mixer Brush smears what is there as one undo step.
    await act(async () => window.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'B', shiftKey: true })));
    expect(c.getState().activeTool).toBe('mixer');
    const before = c.getLayer(id);
    await act(async () => {
      canvas.dispatchEvent(pointer('pointerdown', 110, 70));
      canvas.dispatchEvent(pointer('pointermove', 160, 72));
      canvas.dispatchEvent(pointer('pointerup', 160, 72));
    });
    expect(c.getLayer(id)).not.toBe(before);
    await act(async () => c.undo());
    expect(c.getLayer(id)).toEqual(before);
    await act(async () => window.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'b' })));
    await act(async () => window.dispatchEvent(new win.KeyboardEvent('keydown', { key: ']' })));
    expect(c.getState().paint.brush.size).toBe(25);
    await act(async () => window.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'v' })));
    expect(c.getState().activeTool).toBe('move');
  });
});
