import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { encodePng, bytesToBase64 } from '../src/raster/png';
import { PAINT_IMAGE_MAX_PIXELS, PaintEditorController, createPaintEditorToolProvider, type PaintImageResolver } from '../src/paint-editor';

/** 2 × 2 RGBA: red, green / blue, white. */
const QUAD = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
const quadPng = () => bytesToBase64(encodePng(2, 2, QUAD));

const setup = (resolveImage?: PaintImageResolver, extra: { origin?: { x: number; y: number } } = {}) => {
  const c = new PaintEditorController({ width: 120, height: 80, paper: 'smooth' });
  const r = new ToolRegistry();
  r.register(createPaintEditorToolProvider(c, { resolveImage, imageReferences: 'the id of an image node', ...extra }));
  return { c, r };
};
const ok = (res: { isError?: boolean; structuredContent?: unknown; content: unknown[] }) => {
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return res.structuredContent as any;
};
const errorText = (res: { isError?: boolean; content: unknown[] }) => {
  expect(res.isError).toBe(true);
  return JSON.stringify(res.content);
};
const param = (r: ToolRegistry, name: string) => (r.listTools().tools.find((t) => t.name === name || t.name.endsWith(`__${name}`))?.inputSchema as any)?.properties?.png;

describe('paint image references (resolveImage)', () => {
  it('leaves the image tools unchanged without a resolver', async () => {
    const { r } = setup();
    for (const name of ['place_image', 'set_tracing_image', 'add_reference_image']) {
      expect(param(r, name).description).not.toContain('image node');
    }
    expect(errorText(await r.callTool('set_tracing_image', { png: 'node-1' }))).toContain('could not be decoded as a PNG');
  });

  it('describes references on every image tool when a resolver is given', () => {
    const { r } = setup(() => null);
    for (const name of ['place_image', 'set_tracing_image', 'add_reference_image']) {
      expect(param(r, name).description).toContain('the id of an image node');
    }
    expect(param(r, 'list_layers' as never)).toBeUndefined();
  });

  it('loads a reference as pixels for set_tracing_image, add_reference_image and place_image', async () => {
    const resolveImage = vi.fn<PaintImageResolver>(() => ({ image: { width: 2, height: 2, data: Array.from(QUAD) } }));
    const { r } = setup(resolveImage);
    expect(ok(await r.callTool('set_tracing_image', { png: 'node-1', opacity: 0.5 }))).toMatchObject({ width: 2, height: 2, opacity: 0.5 });
    const ref = ok(await r.callTool('add_reference_image', { png: 'node-1', name: 'Ref' }));
    expect(ref).toMatchObject({ width: 2, height: 2, name: 'Ref' });
    expect(ok(await r.callTool('pick_reference_color', { id: ref.id, x: 0, y: 1 }))).toEqual({ color: '#0000ff' });
    expect(ok(await r.callTool('place_image', { png: 'https://example.com/a.png', name: 'Placed' }))).toMatchObject({ name: 'Placed' });
    expect(resolveImage).toHaveBeenCalledWith('node-1', { maxPixels: PAINT_IMAGE_MAX_PIXELS });
    expect(resolveImage).toHaveBeenCalledWith('https://example.com/a.png', { maxPixels: PAINT_IMAGE_MAX_PIXELS });
  });

  it('accepts a PNG back from the resolver, as a data URL or bytes', async () => {
    const { r } = setup(async (ref) => (ref === 'url' ? { png: `data:image/png;base64,${quadPng()}` } : { png: encodePng(2, 2, QUAD) }));
    expect(ok(await r.callTool('set_tracing_image', { png: 'url' }))).toMatchObject({ width: 2 });
    expect(ok(await r.callTool('add_reference_image', { png: 'bytes' }))).toMatchObject({ width: 2 });
  });

  it('decodes inline PNGs itself, synchronously, without calling the resolver', () => {
    const resolveImage = vi.fn<PaintImageResolver>(() => null);
    const { c } = setup(resolveImage);
    const provider = createPaintEditorToolProvider(c, { resolveImage });
    const tools = typeof provider.tools === 'function' ? provider.tools() : provider.tools;
    const trace = tools.find((t) => t.name === 'set_tracing_image')!;
    expect(trace.handler({ png: quadPng() }, {} as never)).not.toBeInstanceOf(Promise);
    expect(trace.handler({ png: `data:image/png;base64,${quadPng()}` }, {} as never)).not.toBeInstanceOf(Promise);
    expect(resolveImage).not.toHaveBeenCalled();
  });

  it('says when a reference names no image or cannot be loaded', async () => {
    const { r } = setup(async (ref) => {
      if (ref === 'broken') throw new Error('the asset is gone');
      return null;
    });
    expect(errorText(await r.callTool('set_tracing_image', { png: 'missing' }))).toContain('There is no image \\"missing\\"');
    expect(errorText(await r.callTool('place_image', { png: 'broken' }))).toContain('could not be loaded: the asset is gone');
  });

  it('keeps host coordinates for a hosted paint layer', async () => {
    const { r } = setup(() => ({ image: { width: 2, height: 2, data: QUAD } }), { origin: { x: 100, y: 50 } });
    const t = ok(await r.callTool('set_tracing_image', { png: 'node-1', rect: { x: 110, y: 60, width: 20, height: 20 } }));
    expect(t.rect).toEqual({ x: 110, y: 60, width: 20, height: 20 });
  });
});
