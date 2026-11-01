// @vitest-environment jsdom
// The DOM must exist before react-dom loads, or range inputs never fire onChange.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BrushOptionsBar, ImageEditor, SelectionOptionsBar, ShapeOptionsBar, useImageEditor } from '../src/image-editor';
import { DEFAULT_SELECTION_TOOL_OPTIONS, DEFAULT_SHAPE_TOOL_OPTIONS, ImageEditorController } from '@pixerate/editor/image-editor';

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

const pointer = (type: string, x: number, y: number, altKey = false) => {
  const e = new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, altKey });
  Object.assign(e, { pointerId: 1, pointerType: 'mouse', pressure: 0.5 });
  return e;
};

describe('React paint tools', () => {
  it('BrushOptionsBar turns on gradient paint for the brush and edits it', async () => {
    const c = controller();
    await act(async () => root.render(<BrushOptionsBar controller={c} />));
    await act(async () => button('Brush').click());
    await act(async () => button('Gradient').click());
    expect(c.getState().paint.paint).toMatchObject({ type: 'gradient', stops: [{ color: 'paint' }, { color: 'secondary' }] });
    expect(container.querySelector('[data-testid="paint-gradient-editor"]')).not.toBeNull();
    const follows = container.querySelector('select[aria-label="Gradient follows"]') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value')!.set!.call(follows, 'velocity');
      follows.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
    expect(c.getState().paint.paint).toMatchObject({ map: { by: 'velocity' } });
    await act(async () => button('Gradient').click());
    expect(c.getState().paint.paint.type).toBe('color');
  });

  it('the option bars leave out their tool pickers for a host with its own toolbar', async () => {
    const c = controller();
    await act(async () => root.render(<BrushOptionsBar controller={c} showTools={false} />));
    expect(container.querySelector('[data-testid="brush-options"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Paint tools"]')).toBeNull();
    await act(async () =>
      root.render(<SelectionOptionsBar controller={c} options={DEFAULT_SELECTION_TOOL_OPTIONS} onOptionsChange={() => {}} showTools={false} />),
    );
    expect(container.querySelector('[aria-label="Selection tool"]')).toBeNull();
    await act(async () => root.render(<ShapeOptionsBar controller={c} options={DEFAULT_SHAPE_TOOL_OPTIONS} onChange={() => {}} showTools={false} />));
    expect(container.querySelector('[aria-label="Shape kind"]')).toBeNull();
  });

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
    // A new image starts on its Background, so Fill works at once.
    await act(async () => button('Fill').click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(c.getLayer('background')).not.toHaveProperty('source');
    // With no pixel layer left there is nothing to fill, and the message is for a person.
    await act(async () => c.removeLayer('background'));
    await act(async () => button('Fill').click());
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('Pick a layer to fill on in the Layers panel.');
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

  it('BrushOptionsBar shows each retouching tool with its options', async () => {
    const c = controller();
    await act(async () => root.render(<BrushOptionsBar controller={c} />));
    expect(container.querySelector('[data-testid="retouch-options"]')).toBeNull();
    await act(async () => button('Clone').click());
    expect(c.getState().activeTool).toBe('clone');
    expect(container.querySelector('[data-testid="clone-source"]')!.textContent).toMatch(/Alt-click/);
    await act(async () => button('Current & Below').click());
    expect(c.getState().paint.retouch.sample).toBe('current-below');
    await act(async () => (container.querySelector('input[aria-label="Aligned"]') as HTMLInputElement).click());
    expect(c.getState().paint.retouch.aligned).toBe(false);
    await act(async () => c.setCloneSource({ x: 12, y: 34 }));
    expect(container.querySelector('[data-testid="clone-source"]')!.textContent).toBe('Source 12, 34');
    await act(async () => button('Clear source').click());
    expect(c.getState().paint.cloneSource).toBeNull();
    // The Clone Source panel: scale, angle and flips, and a reset.
    await act(async () => setValue(container.querySelector('input[aria-label="Source W"]')!, '50'));
    await act(async () => setValue(container.querySelector('input[aria-label="Source angle"]')!, '30'));
    await act(async () => button('Flip H').click());
    expect(c.getState().paint.cloneTransform).toEqual({ scaleX: -0.5, scaleY: 1, rotate: 30 });
    await act(async () => button('Reset transform').click());
    expect(c.getState().paint.cloneTransform).toEqual({ scaleX: 1, scaleY: 1, rotate: 0 });
    await act(async () => button('Spot Heal').click());
    await act(async () => button('Content-Aware').click());
    expect(c.getState().paint.retouch.spotType).toBe('content-aware');
    await act(async () => button('Smooth').click());
    expect(c.getState().paint.retouch.spotType).toBe('smooth');
    await act(async () => button('Dodge').click());
    await act(async () => button('Highlights').click());
    await act(async () => setValue(container.querySelector('input[aria-label="Exposure"]')!, '0.2'));
    expect(c.getState().paint.retouch).toMatchObject({ range: 'highlights', exposure: 0.2 });
    await act(async () => button('Blur').click());
    await act(async () => setValue(container.querySelector('input[aria-label="Strength"]')!, '0.3'));
    expect(c.getState().paint.retouch.strength).toBe(0.3);
    await act(async () => button('History').click());
    await act(async () => setValue(container.querySelector('input[aria-label="Steps back"]')!, '2'));
    expect(c.getState().paint.retouch.historySteps).toBe(2);
    await act(async () => button('Sponge').click());
    await act(async () => button('Saturate').click());
    expect(c.getState().paint.retouch.spongeMode).toBe('saturate');
    await act(async () => button('Smudge').click());
    await act(async () => setValue(container.querySelector('input[aria-label="Strength"]')!, '0.9'));
    expect(c.getState().paint.retouch.strength).toBe(0.9);
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
    // Clone Stamp: Alt-click sets the source, a drag clones as one undo step.
    await act(async () => window.dispatchEvent(new win.KeyboardEvent('keydown', { key: 's' })));
    expect(c.getState().activeTool).toBe('clone');
    await act(async () => {
      canvas.dispatchEvent(pointer('pointerdown', 130, 72, true));
      canvas.dispatchEvent(pointer('pointerup', 130, 72, true));
    });
    expect(c.getState().paint.cloneSource).not.toBeNull();
    const undoDepth = c.getState().layers;
    await act(async () => {
      canvas.dispatchEvent(pointer('pointerdown', 40, 30));
      canvas.dispatchEvent(pointer('pointermove', 60, 30));
      canvas.dispatchEvent(pointer('pointerup', 60, 30));
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(c.getState().layers).not.toBe(undoDepth);
  });
});
