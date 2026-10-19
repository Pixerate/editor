import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { FreeTransformTool, ImageEditorController, imageToCanvasPoint } from '@pixerate/editor/image-editor';
import { FreeTransformOptionsBar, ImageEditor, LayersPanel, createReactiveImageEditor } from '../src/image-editor';

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

const button = (text: string) => Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const click = (el: Element | null) => {
  (el as HTMLElement).click();
  flushSync();
};
const pointer = (type: string, x: number, y: number, buttons = 1) => {
  const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons });
  Object.assign(e, { pointerId: 1, pointerType: 'mouse' });
  return e;
};

function setup(c = new ImageEditorController({ image: { width: 200, height: 100, naturalWidth: 200, naturalHeight: 100, src: 'data:fake' } as unknown as HTMLImageElement })) {
  const { width, height } = c.getState().imageDimensions;
  c.setSamplePixels({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) });
  const data = new Uint8ClampedArray(40 * 20 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
  const id = c.addPixelLayer({ name: 'Block', pixels: { width: 40, height: 20, data }, x: 20, y: 20 });
  return { c, id };
}

function typeInto(label: string, value: string) {
  const input = target.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  flushSync();
}

describe('Svelte Free Transform', () => {
  it('FreeTransformOptionsBar types W/H, switches modes and commits', () => {
    const { c, id } = setup();
    const tool = new FreeTransformTool(c);
    tool.begin();
    component = mount(FreeTransformOptionsBar, { target, props: { tool } });
    flushSync();
    expect(target.querySelector('[data-testid="free-transform-options"]')).not.toBeNull();
    click(button('Perspective'));
    expect(tool.mode).toBe('perspective');
    click(target.querySelector('button[aria-label="Reference point top-left"]'));
    typeInto('Width in percent of the original', '50');
    expect(tool.bar()!.scaleY).toBeCloseTo(50, 6);
    click(button('Commit'));
    expect(tool.active).toBe(false);
    expect(target.querySelector('[data-testid="free-transform-options"]')).toBeNull();
    const b = c.getLayerBounds(id)!;
    expect(b.x).toBe(20);
    expect(b.width).toBeLessThanOrEqual(21);
  });

  it('opens from the Layers tab, drags a handle on the canvas and commits with Enter', () => {
    const editor = createReactiveImageEditor();
    const c = editor.controller;
    const { id } = setup(c);
    component = mount(ImageEditor, { target, props: { editor } });
    flushSync();
    click(button('Layers'));
    click(button('Free Transform'));
    expect(target.querySelector('[data-testid="free-transform-options"]')).not.toBeNull();
    expect(c.getFreeTransform()).not.toBeNull();
    const canvas = target.querySelector('[data-testid="image-editor-canvas"]') as HTMLCanvasElement;
    const s = c.getState();
    const before = c.getLayerBounds(id)!;
    const se = imageToCanvasPoint({ x: before.x + before.width, y: before.y + before.height }, s, canvas.width, canvas.height, false);
    const to = imageToCanvasPoint({ x: before.x + before.width * 2, y: before.y + before.height * 2 }, s, canvas.width, canvas.height, false);
    canvas.dispatchEvent(pointer('pointerdown', se.x, se.y));
    canvas.dispatchEvent(pointer('pointermove', to.x, to.y));
    canvas.dispatchEvent(pointer('pointerup', to.x, to.y, 0));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    flushSync();
    expect(c.getFreeTransform()).toBeNull();
    const after = c.getLayerBounds(id)!;
    expect(after.width).toBeGreaterThanOrEqual(before.width * 2 - 1);
    expect(after.height).toBeGreaterThanOrEqual(before.height * 2 - 1);
    expect(c.undo()).toBe(true);
    expect(c.getLayerBounds(id)).toEqual(before);
  });

  it('the layers panel links and unlinks masks', () => {
    const { c, id } = setup();
    c.addLayerMask(id, 'reveal-all');
    component = mount(LayersPanel, { target, props: { controller: c } });
    flushSync();
    const link = target.querySelector('[data-testid="layer-mask-link"]') as HTMLButtonElement;
    expect(link.getAttribute('aria-pressed')).toBe('true');
    click(link);
    expect(c.getLayer(id)!.mask!.linked).toBe(false);
  });
});
