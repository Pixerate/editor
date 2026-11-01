import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, MARGIN_FIT_MIN_GUTTER, createImageEditorToolProvider, getViewportProjection } from '../src/image-editor';

const W = 40;
const H = 20;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  const call = (name: string, args: Record<string, unknown> = {}) => registry.callTool(name, args);
  const parse = (r: { content: Array<{ text?: string }>; structuredContent?: unknown }) => (r.structuredContent ?? JSON.parse(r.content[0].text!)) as Record<string, any>;
  return { c, call, parse };
}

describe('the Eyedropper', () => {
  it('samples the composite and makes it the foreground when asked', () => {
    const { c } = setup();
    c.addPixelLayer({ color: '#336699' });
    expect(c.sampleColor({ x: 5, y: 5 })).toBe('#336699');
    expect(c.getState().paint.foreground).toBe('#000000');
    expect(c.sampleColor({ x: 5.7, y: 5.2 }, { size: 3, setForeground: true })).toBe('#336699');
    expect(c.getState().paint.foreground).toBe('#336699');
  });

  it('reads the Background under empty layers, and null outside the canvas or on transparent pixels', () => {
    const { c } = setup();
    c.addPixelLayer();
    expect(c.sampleColor({ x: 5, y: 5 })).toBe('#ffffff');
    expect(c.sampleColor({ x: -1, y: 5 })).toBeNull();
    expect(c.sampleColor({ x: W, y: 5 })).toBeNull();
    c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4) });
    expect(c.sampleColor({ x: 5, y: 5 })).toBeNull();
  });

  it('is an agent tool that sets the foreground by default and fails usefully', async () => {
    const { c, call, parse } = setup();
    c.addPixelLayer({ color: '#ff8800' });
    const ok = await call('sample_color', { x: 3, y: 3 });
    expect(ok.isError).toBeFalsy();
    expect(parse(ok)).toEqual({ color: '#ff8800', foreground: '#ff8800' });
    c.setPaintOptions({ foreground: '#000000' });
    expect(parse(await call('sample_color', { x: 3, y: 3, setForeground: false })).foreground).toBe('#000000');
    const out = await call('sample_color', { x: 500, y: 3 });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/get_image_info/);
    expect((await call('sample_color', { x: 3 })).isError).toBe(true);
  });
});

describe('the margin fit', () => {
  it('leaves room for the rotate handle in a small view and 7.5 % in a large one', () => {
    const { c } = setup();
    const state = { ...c.getState(), imageDimensions: { width: 1000, height: 1000 }, fit: 'margin' as const };
    expect(getViewportProjection(state, 300, 300).scale).toBeCloseTo((300 - 2 * MARGIN_FIT_MIN_GUTTER) / 1000);
    expect(getViewportProjection(state, 900, 900).scale).toBeCloseTo((900 * 0.85) / 1000);
    // Too small for the gutter: the plain 85 %.
    expect(getViewportProjection(state, 100, 100).scale).toBeCloseTo(0.085);
  });
});
