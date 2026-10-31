import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider } from '../src/image-editor';

const W = 96;
const H = 72;
const CX = 48;
const CY = 36;
const R = 14;
const SUBJECT = [200, 30, 40];

/** A red disc on a striped green and yellow background. */
function photo(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = Math.hypot(x + 0.5 - CX, y + 0.5 - CY) <= R;
      data.set(inside ? [...SUBJECT, 255] : Math.floor(x / 4) % 2 ? [60, 160, 70, 255] : [220, 200, 80, 255], (y * W + x) * 4);
    }
  }
  return data;
}

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  const id = c.addPixelLayer({ name: 'Photo', pixels: { width: W, height: H, data: photo() } });
  c.selectEllipse({ x: CX - R, y: CY - R, width: 2 * R, height: 2 * R });
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
  /** A layer's pixels over the canvas. */
  const pixelsOf = (layerId: string) => c.compositePixels(undefined, { layerIds: [layerId] }).data;
  return { c, id, call, fails, pixelsOf };
}

const isSubject = (d: ArrayLike<number>, i: number) => Math.abs(d[i * 4] - SUBJECT[0]) < 30 && Math.abs(d[i * 4 + 1] - SUBJECT[1]) < 30 && Math.abs(d[i * 4 + 2] - SUBJECT[2]) < 30;

describe('separate_subject', () => {
  it('splits the subject onto a masked layer over a filled plate, as one undo step', async () => {
    const { c, id, call, pixelsOf } = setup();
    const layersBefore = c.getLayers().length;
    const r = await call('separate_subject', { layerId: id, seed: 3 });
    expect(r).toMatchObject({ sourceLayerId: id, dilate: 8, fill: 'content-aware' });
    // Top to bottom: subject, plate, the hidden source.
    const order = c.getLayers().map((l) => l.id);
    expect(order.slice(-3)).toEqual([id, r.plateLayerId, r.foregroundLayerId]);
    expect(c.getLayer(id)!.visible).toBe(false);
    expect(c.getState().activeLayerId).toBe(r.foregroundLayerId);
    expect(c.getLayer(r.foregroundLayerId)!.name).toBe('Photo subject');
    expect(c.getLayer(r.plateLayerId)!.name).toBe('Photo plate');
    // The subject layer shows only the disc.
    const fg = pixelsOf(r.foregroundLayerId);
    expect(fg[(CY * W + CX) * 4 + 3]).toBe(255);
    expect(fg[(5 * W + 5) * 4 + 3]).toBe(0);
    // The plate has no subject left anywhere, and is unchanged outside the hole.
    const plate = pixelsOf(r.plateLayerId);
    const original = photo();
    let subjectLeft = 0;
    for (let i = 0; i < W * H; i++) if (isSubject(plate, i)) subjectLeft++;
    expect(subjectLeft).toBe(0);
    expect(Array.from(plate.slice(0, 4))).toEqual(Array.from(original.slice(0, 4)));
    // No gap: the hole covers the subject's whole soft edge, and the plate is opaque under it.
    const b = r.filledBounds;
    expect(b.x).toBeLessThanOrEqual(CX - R - 8);
    expect(b.x + b.width).toBeGreaterThanOrEqual(CX + R + 8);
    for (let i = 0; i < W * H; i++) expect(plate[i * 4 + 3]).toBe(255);
    // The fill area is a channel to select again.
    const ch = c.getState().channels!.find((x) => x.id === r.fillChannelId)!;
    expect(ch.name).toBe('Photo fill area');
    expect(ch.mask.bounds).toEqual(b);
    // One undo step takes all of it back.
    c.undo();
    expect(c.getLayers()).toHaveLength(layersBefore);
    expect(c.getLayer(id)!.visible).toBe(true);
    expect(c.getState().channels?.some((x) => x.id === r.fillChannelId) ?? false).toBe(false);
  });

  it('fills the same for the same seed', async () => {
    const { c, id, call, pixelsOf } = setup();
    const first = await call('separate_subject', { layerId: id, seed: 7 });
    const a = pixelsOf(first.plateLayerId).slice();
    c.undo();
    c.selectEllipse({ x: CX - R, y: CY - R, width: 2 * R, height: 2 * R });
    const second = await call('separate_subject', { layerId: id, seed: 7 });
    expect(pixelsOf(second.plateLayerId)).toEqual(a);
  });

  it('leaves the hole transparent with fill none, grown by dilate', async () => {
    const { id, call, pixelsOf } = setup();
    const r = await call('separate_subject', { layerId: id, fill: 'none', dilate: 2 });
    const plate = pixelsOf(r.plateLayerId);
    expect(plate[(CY * W + CX) * 4 + 3]).toBe(0);
    expect(plate[(CY * W + CX + R + 1) * 4 + 3]).toBe(0);
    expect(plate[(CY * W + CX + R + 6) * 4 + 3]).toBe(255);
    expect(r.filledBounds.width).toBeLessThanOrEqual(2 * R + 6);
  });

  it('changes nothing when cancelled', async () => {
    const { c, id } = setup();
    const before = c.getLayers().length;
    const abort = new AbortController();
    abort.abort();
    await expect(c.separateSubject({ layerId: id, signal: abort.signal })).rejects.toThrow();
    expect(c.getLayers()).toHaveLength(before);
    expect(c.getLayer(id)!.visible).toBe(true);
    expect(c.getState().channels ?? []).toHaveLength(0);
  });

  it('fails usefully', async () => {
    const { c, id, fails } = setup();
    await fails('separate_subject', { layerId: id, dilate: 500 }, /dilate|maximum/);
    await fails('separate_subject', { layerId: id, fill: 'blur' }, /fill|enum/);
    await fails('separate_subject', { layerId: 'nope' }, /nope/);
    c.setLayerProperties(id, { visible: false });
    await fails('separate_subject', { layerId: id }, /hidden/);
    c.deselect();
    c.setLayerProperties(id, { visible: true });
    await fails('separate_subject', { layerId: id }, /Nothing is selected/);
  });
});

describe('Content-Aware Fill progress', () => {
  it('reports rising progress while it fills', async () => {
    const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
    const id = c.addPixelLayer({ name: 'Photo', pixels: { width: W, height: H, data: photo() } });
    c.selectEllipse({ x: CX - R, y: CY - R, width: 2 * R, height: 2 * R });
    const seen: number[] = [];
    await c.separateSubject({ layerId: id, onProgress: (f) => seen.push(f) });
    const middle = seen.filter((f) => f > 0 && f < 1);
    expect(middle.length).toBeGreaterThan(2);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });
});
