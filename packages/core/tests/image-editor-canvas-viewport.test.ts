// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CANVAS_VIEWPORT,
  ImageEditorController,
  MAX_CANVAS_BACKING_SIDE,
  canvasToImagePoint,
  imageToCanvasPoint,
  measureCanvasViewport,
  sameCanvasViewport,
  watchCanvasViewport,
} from '../src/image-editor';

/** An element laid out at `w` × `h` CSS pixels and shown `scale` times larger by a CSS transform. */
const box = (w: number, h: number, scale = 1) => ({
  clientWidth: w,
  clientHeight: h,
  offsetWidth: w,
  offsetHeight: h,
  getBoundingClientRect: () => ({ left: 10, top: 20, width: w * scale, height: h * scale }),
});

describe('measureCanvasViewport', () => {
  it('keeps the layout size and multiplies the device pixel ratio by the CSS transform scale', () => {
    // Pixerate's expanded studio: a 220px node scaled to ~500px.
    const v = measureCanvasViewport(box(220, 160, 500 / 220), 2);
    expect(v.width).toBe(220);
    expect(v.height).toBe(160);
    expect(v.pixelRatio).toBeCloseTo((500 / 220) * 2, 6);
  });

  it('uses the device pixel ratio alone without a transform, and 1 for a bad ratio', () => {
    expect(measureCanvasViewport(box(400, 300), 3).pixelRatio).toBe(3);
    expect(measureCanvasViewport(box(400, 300), 0).pixelRatio).toBe(1);
    expect(measureCanvasViewport(box(400, 300), Number.NaN).pixelRatio).toBe(1);
  });

  it('keeps a non-uniform scale sharp on both axes', () => {
    const el = { ...box(200, 100), getBoundingClientRect: () => ({ width: 400, height: 300 }) };
    expect(measureCanvasViewport(el, 1).pixelRatio).toBe(3);
  });

  it('caps the backing store side', () => {
    const v = measureCanvasViewport(box(4000, 1000, 2), 2);
    expect(v.pixelRatio * v.width).toBeCloseTo(MAX_CANVAS_BACKING_SIDE, 6);
  });

  it('falls back for an element without layout', () => {
    const v = measureCanvasViewport({ clientWidth: 0, clientHeight: 0, getBoundingClientRect: () => ({ width: 0, height: 0 }) }, 2);
    expect(v).toEqual({ ...DEFAULT_CANVAS_VIEWPORT, pixelRatio: 2 });
  });

  it('compares measurements', () => {
    expect(sameCanvasViewport({ width: 1, height: 2, pixelRatio: 2 }, { width: 1, height: 2, pixelRatio: 2.0001 })).toBe(true);
    expect(sameCanvasViewport({ width: 1, height: 2, pixelRatio: 2 }, { width: 1, height: 2, pixelRatio: 2.5 })).toBe(false);
  });

  it('maps a pointer under a CSS transform to the same document point (CSS-pixel projection)', () => {
    const state = new ImageEditorController({ image: { width: 300, height: 150, naturalWidth: 300, naturalHeight: 150 } as unknown as HTMLImageElement }).getState();
    const el = box(220, 110, 500 / 220);
    const view = measureCanvasViewport(el, 2);
    const rect = el.getBoundingClientRect();
    // Where the canvas draws document point (150, 75), in CSS pixels, then on screen.
    const css = imageToCanvasPoint({ x: 150, y: 75 }, state, view.width, view.height, false);
    const client = { x: rect.left + (css.x * rect.width) / view.width, y: rect.top + (css.y * rect.height) / view.height };
    // The canvases' mapping: client → CSS pixels by the on-screen box → document.
    const back = canvasToImagePoint({ x: ((client.x - rect.left) * view.width) / rect.width, y: ((client.y - rect.top) * view.height) / rect.height }, state, view.width, view.height, false);
    expect(back.x).toBeCloseTo(150, 6);
    expect(back.y).toBeCloseTo(75, 6);
  });
});

describe('watchCanvasViewport', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports a changed transform scale after a transition ends, and nothing when unchanged', () => {
    let scale = 1;
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 220 });
    Object.defineProperty(el, 'clientHeight', { value: 160 });
    Object.defineProperty(el, 'offsetWidth', { value: 220 });
    Object.defineProperty(el, 'offsetHeight', { value: 160 });
    el.getBoundingClientRect = () => ({ width: 220 * scale, height: 160 * scale }) as DOMRect;
    const seen: number[] = [];
    const stop = watchCanvasViewport(el, (v) => seen.push(v.pixelRatio));
    window.dispatchEvent(new Event('transitionend'));
    expect(seen).toEqual([]);
    scale = 2;
    document.body.dispatchEvent(new Event('transitionend', { bubbles: true }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeCloseTo(2 * (window.devicePixelRatio || 1), 6);
    scale = 3;
    window.dispatchEvent(new Event('resize'));
    expect(seen).toHaveLength(2);
    stop();
    scale = 4;
    window.dispatchEvent(new Event('resize'));
    expect(seen).toHaveLength(2);
  });
});
