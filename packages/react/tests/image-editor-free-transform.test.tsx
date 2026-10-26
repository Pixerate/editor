// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { FreeTransformOptionsBar, ImageEditor, LayersPanel, useImageEditor } from '../src/image-editor';
import { DEFAULT_CANVAS_VIEWPORT, FreeTransformTool, ImageEditorController, imageToCanvasPoint } from '@pixerate/editor/image-editor';

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

const button = (text: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

function setup(c = new ImageEditorController({ image: { width: 200, height: 100, naturalWidth: 200, naturalHeight: 100, src: 'data:fake' } as unknown as HTMLImageElement })) {
  const { width, height } = c.getState().imageDimensions;
  c.setSamplePixels({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) });
  const data = new Uint8ClampedArray(40 * 20 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
  const id = c.addPixelLayer({ name: 'Block', pixels: { width: 40, height: 20, data }, x: 20, y: 20 });
  return { c, id };
}

const pointer = (type: string, x: number, y: number, buttons = 1) => {
  const e = new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons });
  Object.assign(e, { pointerId: 1, pointerType: 'mouse' });
  return e;
};

function typeInto(label: string, value: string) {
  const input = container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

describe('React Free Transform', () => {
  it('FreeTransformOptionsBar types W/H, switches modes and commits', async () => {
    const { c, id } = setup();
    const tool = new FreeTransformTool(c);
    tool.begin();
    await act(async () => root.render(<FreeTransformOptionsBar tool={tool} />));
    expect(container.querySelector('[data-testid="free-transform-options"]')).not.toBeNull();
    await act(async () => button('Perspective').click());
    expect(tool.mode).toBe('perspective');
    await act(async () => (container.querySelector('button[aria-label="Reference point top-left"]') as HTMLButtonElement).click());
    await act(async () => typeInto('Width in percent of the original', '50'));
    expect(tool.bar()!.scaleY).toBeCloseTo(50, 6);
    await act(async () => (container.querySelector('select[aria-label="Interpolation"]') as HTMLSelectElement).dispatchEvent(new win.Event('change', { bubbles: true })));
    await act(async () => button('Commit').click());
    expect(tool.active).toBe(false);
    expect(container.querySelector('[data-testid="free-transform-options"]')).toBeNull();
    const b = c.getLayerBounds(id)!;
    expect(b.x).toBe(20);
    expect(b.width).toBeLessThanOrEqual(21);
  });

  it('FreeTransformOptionsBar shows Warp: style, bend, grid, and commits the warp', async () => {
    const { c, id } = setup();
    const tool = new FreeTransformTool(c);
    tool.begin();
    await act(async () => root.render(<FreeTransformOptionsBar tool={tool} />));
    await act(async () => button('Warp').click());
    expect(tool.mode).toBe('warp');
    expect(container.querySelector('input[aria-label="Width in percent of the original"]')).toBeNull();
    const style = container.querySelector('select[aria-label="Warp style"]') as HTMLSelectElement;
    await act(async () => {
      style.value = 'arc';
      style.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
    expect(tool.warpBar().style).toBe('arc');
    await act(async () => typeInto('Warp bend in percent', '-40'));
    expect(tool.warpBar().bend).toBe(-40);
    const grid = container.querySelector('select[aria-label="Warp grid"]') as HTMLSelectElement;
    await act(async () => {
      grid.value = '3x3';
      grid.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
    expect(tool.overlay()!.warp!.anchors).toHaveLength(16);
    await act(async () => button('Commit').click());
    expect(c.getLayerBounds(id)).not.toEqual({ x: 20, y: 20, width: 40, height: 20 });
  });

  it('opens from the Layers tab, drags a handle on the canvas and commits with Enter', async () => {
    let c!: ImageEditorController;
    let id!: string;
    function Host() {
      const editor = useImageEditor();
      c = editor.controller;
      return <ImageEditor editor={editor} />;
    }
    await act(async () => root.render(<Host />));
    await act(async () => {
      id = setup(c).id;
    });
    await act(async () => button('Layers').click());
    await act(async () => button('Free Transform').click());
    expect(container.querySelector('[data-testid="free-transform-options"]')).not.toBeNull();
    expect(c.getFreeTransform()).not.toBeNull();
    const canvas = container.querySelector('[data-testid="image-editor-canvas"]') as HTMLCanvasElement;
    const s = c.getState();
    const before = c.getLayerBounds(id)!;
    // jsdom has no layout: the canvas projects through the fallback viewport and maps client pixels 1:1.
    const se = imageToCanvasPoint({ x: before.x + before.width, y: before.y + before.height }, s, DEFAULT_CANVAS_VIEWPORT.width, DEFAULT_CANVAS_VIEWPORT.height, false);
    const to = imageToCanvasPoint({ x: before.x + before.width * 2, y: before.y + before.height * 2 }, s, DEFAULT_CANVAS_VIEWPORT.width, DEFAULT_CANVAS_VIEWPORT.height, false);
    await act(async () => {
      canvas.dispatchEvent(pointer('pointerdown', se.x, se.y));
      canvas.dispatchEvent(pointer('pointermove', to.x, to.y));
      canvas.dispatchEvent(pointer('pointerup', to.x, to.y, 0));
    });
    await act(async () => window.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter' })));
    expect(c.getFreeTransform()).toBeNull();
    const after = c.getLayerBounds(id)!;
    expect(after.width).toBeGreaterThanOrEqual(before.width * 2 - 1);
    expect(after.height).toBeGreaterThanOrEqual(before.height * 2 - 1);
    expect(c.undo()).toBe(true);
    expect(c.getLayerBounds(id)).toEqual(before);
  });

  it('Escape cancels, and the layers panel links and unlinks masks', async () => {
    const { c, id } = setup();
    c.addLayerMask(id, 'reveal-all');
    await act(async () => root.render(<LayersPanel controller={c} />));
    const link = container.querySelector('[data-testid="layer-mask-link"]') as HTMLButtonElement;
    expect(link.getAttribute('aria-pressed')).toBe('true');
    await act(async () => link.click());
    expect(c.getLayer(id)!.mask!.linked).toBe(false);
    const tool = new FreeTransformTool(c);
    tool.begin({ channel: 'pixels' });
    tool.setField('rotate', 30);
    expect(tool.key({ key: 'Escape' })).toBe(true);
    expect(c.getLayerBounds(id)).toEqual({ x: 20, y: 20, width: 40, height: 20 });
  });
});
