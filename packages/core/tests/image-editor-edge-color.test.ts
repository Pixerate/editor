import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider, createSelectionMask, despillEdge } from '../src/image-editor';

const W = 40;
const H = 20;
const F = [200, 40, 40];
const B = [40, 200, 40];
/** Coverage across x: subject at x < 15, a soft band over 15..24, background from 25. */
const alphaAt = (x: number) => Math.min(1, Math.max(0, (25 - x) / 10));

/** A photo of a red subject on green with a soft edge: I = αF + (1 − α)B. */
function photo(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = alphaAt(x);
      data.set([...F.map((f, c) => Math.round(a * f + (1 - a) * B[c])), 255], (y * W + x) * 4);
    }
  }
  return data;
}

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  const id = c.addPixelLayer({ name: 'Cutout', pixels: { width: W, height: H, data: photo() } });
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) m[y * W + x] = Math.round(alphaAt(x) * 255);
  c.setSelection(createSelectionMask(W, H, m));
  c.addLayerMask(id, 'selection');
  c.deselect();
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await registry.callTool(name, args);
    if (res.isError) throw new Error(String((res.content?.[0] as { text?: string })?.text ?? 'tool error'));
    return res.structuredContent as Record<string, any>;
  };
  const fails = async (name: string, args: Record<string, unknown>, pattern: RegExp) => {
    const res = await registry.callTool(name, args);
    expect(res.isError, `${name} should fail`).toBe(true);
    expect(String((res.content?.[0] as { text?: string })?.text)).toMatch(pattern);
  };
  /** The cutout layer's own colour after its edge colour, at (x, y): composited alone. */
  const layerColor = (x: number, y = 10) => {
    const px = c.compositePixels(undefined, { layerIds: [id] });
    const i = (y * W + x) * 4;
    return [px.data[i], px.data[i + 1], px.data[i + 2], px.data[i + 3]];
  };
  return { c, id, call, fails, layerColor };
}

describe('edge colour', () => {
  it('decontamination recovers the subject colour in the soft band, without baking', async () => {
    const { c, id, call, layerColor } = setup();
    const before = layerColor(18);
    expect(before[1]).toBeGreaterThan(80); // green fringe
    const pixelsBefore = c.getLayerPixels(id)!.data.slice();
    expect(await call('set_edge_decontamination', { layerId: id, amount: 100 })).toEqual({ layerId: id, decontaminate: 100, despill: 0, ambient: 0, ambientSource: 'auto' });
    for (const x of [15, 17, 19]) {
      const [r, g, b] = layerColor(x);
      expect(Math.abs(r - F[0])).toBeLessThanOrEqual(8);
      expect(Math.abs(g - F[1])).toBeLessThanOrEqual(8);
      expect(Math.abs(b - F[2])).toBeLessThanOrEqual(8);
    }
    // Inside the subject nothing changes, and the layer's pixels are untouched.
    expect(layerColor(5).slice(0, 3)).toEqual(F);
    expect(c.getLayerPixels(id)!.data).toEqual(pixelsBefore);
    // Undo turns it off; 0 also turns it off.
    c.undo();
    expect(layerColor(18)).toEqual(before);
    await call('set_edge_decontamination', { layerId: id, amount: 100 });
    await call('set_edge_decontamination', { layerId: id, amount: 0 });
    expect(c.getLayer(id)!.edge).toBeUndefined();
  });

  it('despill takes out the background hue at the edge and never changes fully covered pixels', async () => {
    const { id, call, layerColor } = setup();
    const before = layerColor(20);
    await call('set_edge_despill', { layerId: id, amount: 100 });
    const after = layerColor(20);
    expect(after[1]).toBeLessThan(before[1] - 10);
    expect(layerColor(5).slice(0, 3)).toEqual(F);
    expect(layerColor(14).slice(0, 3)).toEqual(F);
  });

  it('despillEdge alone leaves α = 1 and α = 0 pixels as they are', () => {
    const data = photo();
    const cov = new Uint8Array(W * H);
    for (let i = 0; i < cov.length; i++) cov[i] = Math.round(alphaAt(i % W) * 255);
    const copy = data.slice();
    despillEdge(data, cov, W, H, 1);
    for (let i = 0; i < cov.length; i++) {
      if (cov[i] === 255 || cov[i] === 0) expect(Array.from(data.slice(i * 4, i * 4 + 4))).toEqual(Array.from(copy.slice(i * 4, i * 4 + 4)));
    }
  });

  it('casts what is behind the layer onto its edge, live, and 0 equals no cast', async () => {
    const { c, id, call } = setup();
    // A blue backdrop below the cutout.
    const backdrop = c.addPixelLayer({ name: 'Backdrop', color: '#0000ff' });
    c.moveLayer(backdrop, { belowId: id });
    const at = (x: number) => {
      const px = c.compositePixels();
      const i = (10 * W + x) * 4;
      return [px.data[i], px.data[i + 1], px.data[i + 2]];
    };
    const plain = at(20);
    await call('set_edge_ambient', { layerId: id, amount: 0 });
    expect(at(20)).toEqual(plain);
    await call('set_edge_ambient', { layerId: id, amount: 100 });
    // At 100% the edge colour becomes the backdrop's in proportion to 1 − α: the reference composite.
    const a = Math.round(alphaAt(20) * 255) / 255;
    const ref = [0, 1, 2].map((ch) => {
      const L = photo()[(10 * W + 20) * 4 + ch];
      const bd = ch === 2 ? 255 : 0;
      const cast = L + (1 - a) * (bd - L);
      return a * cast + (1 - a) * bd;
    });
    at(20).forEach((v, ch) => expect(Math.abs(v - ref[ch])).toBeLessThanOrEqual(3));
    expect(at(20)[2]).toBeGreaterThan(plain[2]);
    expect(at(5)).toEqual(F);
    // A fixed colour instead of the live backdrop.
    expect((await call('set_edge_ambient', { layerId: id, amount: 50, source: '#ffffff' })).ambientSource).toBe('#ffffff');
    expect(at(20)[1]).toBeGreaterThan(plain[1]);
  });

  it('composites the same at 16 bits', async () => {
    const { c, id, call } = setup();
    const backdrop = c.addPixelLayer({ name: 'Backdrop', color: '#0000ff' });
    c.moveLayer(backdrop, { belowId: id });
    await call('set_edge_decontamination', { layerId: id, amount: 100 });
    await call('set_edge_ambient', { layerId: id, amount: 60 });
    const eight = c.compositePixels().data;
    c.setBitDepth(16);
    const deep = c.compositeDeepPixels();
    for (const x of [5, 16, 20, 23, 30]) {
      for (let ch = 0; ch < 3; ch++) {
        const i = (10 * W + x) * 4 + ch;
        expect(Math.abs(deep.data[i] / 257 - eight[i]), `x ${x} channel ${ch}`).toBeLessThanOrEqual(3);
      }
    }
  });

  it('keeps edge colour in documents and across duplicates', async () => {
    const { c, id, call } = setup();
    await call('set_edge_decontamination', { layerId: id, amount: 80 });
    await call('set_edge_ambient', { layerId: id, amount: 30, source: '#102030' });
    const json = c.toJSON();
    const d = new ImageEditorController({ image: { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement });
    await d.loadJSON(json);
    expect(d.getEdgeColor(id)).toEqual({ layerId: id, decontaminate: 80, despill: 0, ambient: 30, ambientSource: '#102030' });
    const copy = await call('duplicate_layer', { layerId: id });
    expect(c.getEdgeColor(copy.layer?.id ?? copy.id ?? copy.layerId).decontaminate).toBe(80);
  });

  it('bakes decontamination into PSD pixels and notes the live cast it cannot write', async () => {
    const { c, id, call } = setup();
    await call('set_edge_decontamination', { layerId: id, amount: 100 });
    await call('set_edge_ambient', { layerId: id, amount: 40 });
    const { warnings } = await c.toPsd();
    expect(warnings.some((w) => w.startsWith('Edge decontamination and despill were baked into the pixels'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('The live edge cast'))).toBe(true);
    // The document keeps its live settings.
    expect(c.getEdgeColor(id).ambient).toBe(40);
  });

  it('fails usefully and changes nothing on bad input', async () => {
    const { c, id, call, fails } = setup();
    await fails('set_edge_decontamination', { layerId: 'nope', amount: 50 }, /no layer "nope"/);
    await fails('set_edge_decontamination', { layerId: id, amount: 150 }, /amount|maximum|100/);
    await fails('set_edge_ambient', { layerId: id, amount: 20, source: 'blue' }, /source|pattern/);
    // A hard-edged mask has no soft band.
    const hard = c.addPixelLayer({ name: 'Hard', color: '#ff0000' });
    c.selectRect({ x: 5, y: 5, width: 10, height: 10 }, { antiAlias: false });
    c.addLayerMask(hard, 'selection');
    c.deselect();
    await fails('set_edge_despill', { layerId: hard, amount: 50 }, /no mask with a soft edge/);
    await fails('set_edge_ambient', { layerId: hard, amount: 50 }, /no soft edge/);
    const adj = c.addAdjustmentLayer({ kind: 'invert' });
    await fails('get_edge_color', { layerId: adj }, /adjustment layer/);
    expect(c.getLayer(hard)!.edge).toBeUndefined();
    expect((await call('get_edge_color', { layerId: id })).decontaminate).toBe(0);
  });
});
