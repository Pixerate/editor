import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, PathEditGesture, createImageEditorToolProvider, effectiveLayerMask, hybridVectorMaskCoverage, componentsCoverage } from '../src/image-editor';

const W = 96;
const H = 64;
/** The subject: a red square (20..60 × 12..52) with thin strands reaching 10 px past its right side. */
const SQ = { x: 20, y: 12, width: 40, height: 40 };
const RED = [210, 40, 40, 255];
const BLUE = [30, 60, 200, 255];
const isStrand = (x: number, y: number) => x >= 60 && x < 70 && y >= 16 && y < 48 && y % 4 === 0;

function photo(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inSquare = x >= SQ.x && x < SQ.x + SQ.width && y >= SQ.y && y < SQ.y + SQ.height;
      data.set(inSquare || isStrand(x, y) ? RED : BLUE, (y * W + x) * 4);
    }
  }
  return data;
}

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  const id = c.addPixelLayer({ name: 'Subject', pixels: { width: W, height: H, data: photo() } });
  c.addVectorMask(id, 'path', { shape: { kind: 'rect', ...SQ } });
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
  /** The layer's mask coverage (0..255) over the canvas, vector mask included. */
  const coverage = () => {
    const m = effectiveLayerMask(c.getLayer(id)!, W, H)!;
    const out: number[] = [];
    // readRegion through the mask surface: layer offset is 0.
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out.push(maskAt(m, x, y));
    return (x: number, y: number) => out[y * W + x];
  };
  /** Which segment of the rectangle runs along a side. */
  const segmentOf = (side: 'top' | 'right' | 'bottom' | 'left') => {
    const vm = c.getVectorMask(id)!;
    const a = vm.components[0].subpaths[0].anchors;
    for (let k = 0; k < a.length; k++) {
      const p = a[k];
      const q = a[(k + 1) % a.length];
      const ok =
        side === 'top' ? p.y === SQ.y && q.y === SQ.y : side === 'bottom' ? p.y === SQ.y + SQ.height && q.y === SQ.y + SQ.height : side === 'left' ? p.x === SQ.x && q.x === SQ.x : p.x === SQ.x + SQ.width && q.x === SQ.x + SQ.width;
      if (ok) return k;
    }
    throw new Error(`no ${side} segment`);
  };
  return { c, id, call, fails, coverage, segmentOf };
}

function maskAt(m: { surface: { getTile(tx: number, ty: number): { data: Uint8Array | Uint8ClampedArray } | null | undefined; defaultValue: number } }, x: number, y: number): number {
  const t = m.surface.getTile(Math.floor(x / 256), Math.floor(y / 256));
  return t ? t.data[(y % 256) * 256 + (x % 256)] : m.surface.defaultValue;
}

describe('hybrid vector masks', () => {
  it('without soft edges renders exactly as before', () => {
    const hard = componentsCoverage([{ op: 'combine', subpaths: [{ anchors: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }], closed: true }] }], { x: 0, y: 0, width: 40, height: 40 });
    expect(hybridVectorMaskCoverage({ components: [], edges: [] }, hard, 40, 40, null)).toBe(hard);
    const { coverage } = setup();
    const cov = coverage();
    expect(cov(40, 30)).toBe(255);
    expect(cov(10, 30)).toBe(0);
    expect(cov(59, 30)).toBe(255);
    expect(cov(61, 30)).toBe(0);
  });

  it('feathers one segment and keeps the others sharp', async () => {
    const { id, call, coverage, segmentOf } = setup();
    const r = await call('set_vector_mask_edge', { layerId: id, component: 0, subpath: 0, segment: segmentOf('top'), mode: 'feather', radius: 3 });
    expect(r.vectorMask.edges).toEqual([{ component: 0, subpath: 0, segment: segmentOf('top'), mode: 'feather', radius: 3 }]);
    const cov = coverage();
    // Across the top edge (mid-width): a soft ramp over several px.
    const ramp = [8, 10, 12, 14, 16].map((y) => cov(40, y));
    expect(ramp.filter((v) => v > 20 && v < 235).length).toBeGreaterThanOrEqual(3);
    // Across the bottom edge: still a one-pixel step.
    expect(cov(40, 50)).toBe(255);
    expect(cov(40, 53)).toBe(0);
  });

  it('solves a matte corridor from the colours: strands kept, background dropped', async () => {
    const { id, call, coverage, segmentOf } = setup();
    await call('set_vector_mask_edge', { layerId: id, component: 0, subpath: 0, segment: segmentOf('right'), mode: 'matte', inner: 3, outer: 12 });
    const cov = coverage();
    let strand = 0;
    let strandN = 0;
    let gap = 0;
    let gapN = 0;
    for (let y = 18; y < 46; y++) {
      for (let x = 62; x < 68; x++) {
        if (isStrand(x, y)) {
          strand += cov(x, y);
          strandN++;
        } else if (!isStrand(x, y - 1) && !isStrand(x, y + 1)) {
          gap += cov(x, y);
          gapN++;
        }
      }
    }
    expect(strand / strandN).toBeGreaterThan(gap / gapN + 60);
    // Far outside the corridor nothing is revealed; inside the square everything is.
    expect(cov(85, 30)).toBe(0);
    expect(cov(40, 30)).toBe(255);
  });

  it('blends modes where they meet, with no seam at the corner', async () => {
    const { id, call, coverage, segmentOf } = setup();
    await call('set_vector_mask_edge', { layerId: id, component: 0, subpath: 0, segment: segmentOf('top'), mode: 'feather', radius: 4 });
    const cov = coverage();
    // One px above the feathered top edge, walking right past the corner where the hard right side
    // takes over: the coverage fades out with no jump where the modes meet.
    let worst = 0;
    for (let x = 40; x < 72; x++) worst = Math.max(worst, Math.abs(cov(x + 1, SQ.y - 1) - cov(x, SQ.y - 1)));
    expect(cov(40, SQ.y - 1)).toBeGreaterThan(40);
    expect(worst).toBeLessThan(40);
  });

  it('is kept in documents, follows path edits, shows in inspect_mask_edge and bakes into PSD', async () => {
    const { c, id, call, segmentOf } = setup();
    const before = (await call('inspect_mask_edge', { target: 'vector-mask', layerId: id })).softFraction;
    await call('set_vector_mask_edge', { layerId: id, component: 0, subpath: 0, segment: segmentOf('left'), mode: 'feather', radius: 5 });
    expect((await call('inspect_mask_edge', { target: 'vector-mask', layerId: id })).softFraction).toBeGreaterThan(before);
    const d = new ImageEditorController({ image: { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement });
    await d.loadJSON(c.toJSON());
    expect(d.getVectorMask(id)!.edges).toEqual(c.getVectorMask(id)!.edges);
    const { warnings } = await c.toPsd();
    expect(warnings.some((w) => w.startsWith('Hybrid vector masks (soft edge segments) were baked into pixel masks'))).toBe(true);
    expect(c.getVectorMask(id)!.edges).toHaveLength(1);
    // A new path with one segment fewer keeps only the edges it still has.
    await call('set_vector_mask_path', { layerId: id, subpaths: [{ anchors: [{ x: 20, y: 12 }, { x: 60, y: 12 }, { x: 40, y: 52 }], closed: true }] });
    expect(c.getVectorMask(id)!.edges.every((e: { segment: number }) => e.segment < 3)).toBe(true);
    // hard removes an edge; one undo step each.
    c.undo();
    await call('set_vector_mask_edge', { layerId: id, component: 0, subpath: 0, segment: segmentOf('left'), mode: 'hard' });
    expect(c.getVectorMask(id)!.edges).toEqual([]);
    c.undo();
    expect(c.getVectorMask(id)!.edges).toHaveLength(1);
  });

  it('cycles a segment hard → feather → matte → hard with Alt+Shift-click in Direct Selection', () => {
    const { c, id, segmentOf } = setup();
    const g = new PathEditGesture(c);
    g.setView(1);
    c.setActiveLayer(id);
    const right = segmentOf('right');
    const modeOfRight = () => c.getVectorMask(id)!.edges.find((e) => e.segment === right)?.mode ?? 'hard';
    const click = () => {
      g.down({ x: SQ.x + SQ.width, y: 30 }, 'direct-select', { alt: true, shift: true });
      g.up();
    };
    click();
    expect(modeOfRight()).toBe('feather');
    click();
    expect(modeOfRight()).toBe('matte');
    expect(g.overlay('direct-select')!.curveModes![right]).toBe('matte');
    click();
    expect(modeOfRight()).toBe('hard');
    expect(g.overlay('direct-select')!.curveModes).toBeUndefined();
  });

  it('fails usefully', async () => {
    const { c, id, fails } = setup();
    await fails('set_vector_mask_edge', { layerId: id, component: 0, subpath: 0, segment: 9, mode: 'feather' }, /no segment 0\/0\/9; it has component 0 subpath 0: segments 0\.\.3/);
    await fails('set_vector_mask_edge', { layerId: id, component: 0, subpath: 0, segment: 0, mode: 'matte', radius: 3 }, /radius is for feather edges/);
    await fails('set_vector_mask_edge', { layerId: id, component: 0, subpath: 0, segment: 0, mode: 'feather', outer: 3 }, /inner and outer are for matte edges/);
    await fails('set_vector_mask_edge', { layerId: id, component: 0, subpath: 0, segment: 0, mode: 'blur' }, /mode|enum/);
    const plain = c.addPixelLayer({ name: 'Plain' });
    await fails('set_vector_mask_edge', { layerId: plain, component: 0, subpath: 0, segment: 0, mode: 'feather' }, /no vector mask/);
  });
});
