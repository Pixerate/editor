import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { DEFAULT_CANVAS_VIEWPORT, FreeTransformTool, ImageEditorController, imageToCanvasPoint } from '@pixerate/editor/image-editor';
import { FreeTransformOptionsBar, ImageEditor, ImageEditorCanvas, LayersPanel, createReactiveImageEditor } from '../src/image-editor';

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

  it('FreeTransformOptionsBar shows Warp: style, bend, grid, and commits the warp', () => {
    const { c, id } = setup();
    const tool = new FreeTransformTool(c);
    tool.begin();
    component = mount(FreeTransformOptionsBar, { target, props: { tool } });
    flushSync();
    click(button('Warp'));
    expect(tool.mode).toBe('warp');
    expect(target.querySelector('input[aria-label="Width in percent of the original"]')).toBeNull();
    const style = target.querySelector('select[aria-label="Warp style"]') as HTMLSelectElement;
    style.value = 'arc';
    style.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(tool.warpBar().style).toBe('arc');
    typeInto('Warp bend in percent', '-40');
    expect(tool.warpBar().bend).toBe(-40);
    const grid = target.querySelector('select[aria-label="Warp grid"]') as HTMLSelectElement;
    grid.value = '3x3';
    grid.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(tool.overlay()!.warp!.anchors).toHaveLength(16);
    click(button('Commit'));
    expect(c.getLayerBounds(id)).not.toEqual({ x: 20, y: 20, width: 40, height: 20 });
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
    // jsdom has no layout: the canvas projects through the fallback viewport and maps client pixels 1:1.
    const se = imageToCanvasPoint({ x: before.x + before.width, y: before.y + before.height }, s, DEFAULT_CANVAS_VIEWPORT.width, DEFAULT_CANVAS_VIEWPORT.height, false);
    const to = imageToCanvasPoint({ x: before.x + before.width * 2, y: before.y + before.height * 2 }, s, DEFAULT_CANVAS_VIEWPORT.width, DEFAULT_CANVAS_VIEWPORT.height, false);
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

  it('transform mode: drags the active layer by its frame, one undo step per drag, and picks layers by clicking', () => {
    const editor = createReactiveImageEditor();
    const c = editor.controller;
    const { id } = setup(c);
    const tool = new FreeTransformTool(c);
    component = mount(ImageEditorCanvas, { target, props: { editor, mode: 'transform', transformTool: tool } });
    flushSync();
    const canvas = target.querySelector('[data-testid="image-editor-canvas"]') as HTMLCanvasElement;
    // jsdom has no layout: the canvas projects through the fallback viewport and maps client pixels 1:1.
    const at = (x: number, y: number) => imageToCanvasPoint({ x, y }, c.getState(), DEFAULT_CANVAS_VIEWPORT.width, DEFAULT_CANVAS_VIEWPORT.height, false);
    const steps = () => (c as unknown as { undoStack: unknown[] }).undoStack.length;
    expect(c.getState().activeLayerId).toBe(id);
    const before = steps();
    // Dragging inside the frame moves the layer; the transform closes on release as one step.
    const from = at(30, 25);
    const to = at(40, 35);
    canvas.dispatchEvent(pointer('pointerdown', from.x, from.y));
    expect(tool.active).toBe(true);
    canvas.dispatchEvent(pointer('pointermove', to.x, to.y));
    canvas.dispatchEvent(pointer('pointerup', to.x, to.y, 0));
    flushSync();
    expect(tool.active).toBe(false);
    expect(steps()).toBe(before + 1);
    expect(c.getLayerBounds(id)).toEqual({ x: 30, y: 30, width: 40, height: 20 });
    // A click without a move leaves no step.
    const inside = at(40, 35);
    canvas.dispatchEvent(pointer('pointerdown', inside.x, inside.y));
    canvas.dispatchEvent(pointer('pointerup', inside.x, inside.y, 0));
    expect(steps()).toBe(before + 1);
    // With no transform open, other edits go through.
    const other = c.addPixelLayer({ name: 'Other', pixels: { width: 10, height: 10, data: new Uint8ClampedArray(400).fill(255) }, x: 150, y: 70 });
    expect(c.getLayer(other)).toBeTruthy();
    // Clicking the first layer, far from the active frame, picks it; clicking empty canvas picks none.
    const first = at(50, 40);
    canvas.dispatchEvent(pointer('pointerdown', first.x, first.y));
    canvas.dispatchEvent(pointer('pointerup', first.x, first.y, 0));
    expect(c.getState().activeLayerId).toBe(id);
    c.setLayerProperties('background', { visible: false });
    const empty = at(5, 95);
    canvas.dispatchEvent(pointer('pointerdown', empty.x, empty.y));
    canvas.dispatchEvent(pointer('pointerup', empty.x, empty.y, 0));
    expect(c.getState().activeLayerId).toBeNull();
  });

  it('transform mode: a shape layer gets a frame and moves by it', () => {
    const editor = createReactiveImageEditor();
    const c = editor.controller;
    setup(c);
    const shape = c.addShapeLayer({ shape: { kind: 'rect', x: 120, y: 40, width: 30, height: 20 }, fill: '#00ff00' });
    const tool = new FreeTransformTool(c);
    component = mount(ImageEditorCanvas, { target, props: { editor, mode: 'transform', transformTool: tool } });
    flushSync();
    const canvas = target.querySelector('[data-testid="image-editor-canvas"]') as HTMLCanvasElement;
    const at = (x: number, y: number) => imageToCanvasPoint({ x, y }, c.getState(), DEFAULT_CANVAS_VIEWPORT.width, DEFAULT_CANVAS_VIEWPORT.height, false);
    expect(c.getState().activeLayerId).toBe(shape);
    const from = at(135, 50);
    const to = at(145, 60);
    canvas.dispatchEvent(pointer('pointerdown', from.x, from.y));
    expect(tool.active).toBe(true);
    canvas.dispatchEvent(pointer('pointermove', to.x, to.y));
    canvas.dispatchEvent(pointer('pointerup', to.x, to.y, 0));
    flushSync();
    expect(tool.active).toBe(false);
    expect(c.getLayerFrame(shape)![0]).toEqual({ x: 130, y: 50 });
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
