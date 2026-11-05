import { describe, expect, it } from 'vitest';
import {
  brushEditorSections,
  brushSourceIds,
  CANVAS_PROFILE,
  checkBrush,
  createBrushLibrary,
  createBrushLibraryToolProvider,
  decodeBrushSource,
  degrade,
  IMAGE_PROFILE,
  makeBrushSource,
  MAX_BRUSH_SOURCE_SIZE,
  migrateBrushV1,
  normalizeBrushSpec,
  PAINT_PROFILE,
  readBrushSource,
  resolveBrush,
  setBrushEditorValue,
  type Brush,
} from '../src/brushes';
import { BrushSourceArtCache, DryStroke, PaintEditorController, PenDabWalker, replayPainting, TipGrain, type PenDab } from '../src/paint-editor';
import { normalizePaintBrush } from '../src/paint-editor/brushes';
import { rasterizeStampDab, stampDabRect, stampSampler } from '../src/paint-editor/stamp-tip';
import { pngDataUrl } from '../src/raster/png';
import { ToolRegistry } from '../src/tools';
import { createMemoryStorage } from '../src/persistence/storage';

/** An RGBA PNG data URL drawn by `px(x, y)` → [r, g, b, a]. */
const png = (w: number, h: number, px: (x: number, y: number) => [number, number, number, number]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(px(x, y), (y * w + x) * 4);
  return pngDataUrl(w, h, data);
};
/** Ink in the left half only, on a transparent background: an asymmetric tip. */
const LEFT_HALF = png(16, 16, (x) => (x < 8 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
/** Dark marks on white paper (a scan): a dark disc. */
const SCAN = png(20, 20, (x, y) => (Math.hypot(x - 9.5, y - 9.5) < 7 ? [30, 30, 30, 255] : [255, 255, 255, 255]));
/** Vertical stripes 4 px apart, light and dark: a grain texture. */
const STRIPES = png(8, 8, (x) => (x % 8 < 4 ? [255, 255, 255, 255] : [0, 0, 0, 255]));

const line = (n = 20, y = 40) => Array.from({ length: n }, (_, i) => ({ x: 20 + i * 8, y, pressure: 0.6 + (i % 3) * 0.1, t: i * 16 }));

describe('brush sources', () => {
  it('reads marks from the transparency, the dark parts or the light parts, and inverts them', () => {
    const p: string[] = [];
    const alpha = makeBrushSource({ name: 'Left half', image: LEFT_HALF }, p);
    expect(alpha).toMatchObject({ id: 'left-half', name: 'Left half', width: 16, height: 16 });
    expect(p.join(' ')).toMatch(/transparency/);
    const m = decodeBrushSource(alpha).mask;
    expect(m[0]).toBe(255);
    expect(m[15]).toBe(0);
    const scan = makeBrushSource({ name: 'Scan', image: SCAN });
    const sm = decodeBrushSource(scan).mask;
    expect(sm[10 * 20 + 10]).toBeGreaterThan(200);
    expect(sm[0]).toBe(0);
    const light = decodeBrushSource(makeBrushSource({ name: 'Light', image: SCAN, channel: 'lightness' })).mask;
    expect(light[0]).toBe(255);
    const inverted = decodeBrushSource(makeBrushSource({ name: 'Inverted', image: SCAN, invert: true })).mask;
    expect(inverted[0]).toBe(255);
  });

  it('scales large images down, and refuses empty, unreadable and invalid ones with the fix', () => {
    const big = png(1200, 600, (x) => (x < 600 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
    const p: string[] = [];
    const s = makeBrushSource({ name: 'Big', image: big }, p);
    expect([s.width, s.height]).toEqual([MAX_BRUSH_SOURCE_SIZE, 256]);
    expect(p.join(' ')).toMatch(/scaled from 1200×600 to 512×256/);
    expect(() => makeBrushSource({ name: 'Empty', image: png(4, 4, () => [0, 0, 0, 0]) })).toThrow(/no marks.*channel/);
    expect(() => makeBrushSource({ name: 'Text', image: 'data:text/plain,hello' })).toThrow(/PNG/);
    expect(() => makeBrushSource({ name: 'x', id: 'Bad Id', image: LEFT_HALF })).toThrow(/not valid/);
  });

  it('reads stored sources back defensively', () => {
    const s = makeBrushSource({ name: 'Left', image: LEFT_HALF, licence: 'CC0', origin: 'test' });
    const p: string[] = [];
    expect(readBrushSource(JSON.parse(JSON.stringify(s)), 'sources[0]', p)).toEqual(s);
    expect(readBrushSource({ ...s, width: 99999 }, 'sources[1]', p)).toBeNull();
    expect(readBrushSource({ ...s, image: 'javascript:alert(1)' }, 'sources[2]', p)).toBeNull();
    expect(readBrushSource('nope', 'sources[3]', p)).toBeNull();
    expect(p).toHaveLength(3);
  });
});

describe('the facets', () => {
  const base: Brush = { id: 'img', name: 'Image tip', kind: 'mark', medium: 'dry', tip: { shape: 'stamp', size: 30, stamps: ['source:charcoal'], grain: { source: 'rough', mode: 'moving', scale: 2, depth: 0.8 } }, dynamics: { count: 3, flip: 'xy', angleJitter: 0.5 } };

  it('keeps image stamps, tip grain, count and flip, and resolves them for the dab engine', () => {
    const p: string[] = [];
    const b = normalizeBrushSpec(base, p);
    expect(p).toEqual([]);
    expect(b.tip.grain).toEqual({ source: 'rough', mode: 'moving', scale: 2, depth: 0.8 });
    const r = resolveBrush(b);
    expect(r.engine).toBe('dab');
    expect(r.stamp).toBe('source:charcoal');
    expect(r.tipGrain).toEqual({ source: 'rough', mode: 'moving', scale: 2, depth: 0.8, contrast: 1, invert: false });
    expect(r.dynamics).toMatchObject({ count: 3, flip: 'xy' });
    expect(brushSourceIds(b)).toEqual(['charcoal']);
  });

  it('round-trips through the engine form (recorded strokes keep the source ref)', () => {
    const r = resolveBrush(normalizeBrushSpec(base));
    expect(resolveBrush(migrateBrushV1(r))).toEqual(r);
  });

  it('leaves the engine form of brushes without them unchanged', () => {
    const plain = resolveBrush({ id: 'p', name: 'P', kind: 'mark', tip: { shape: 'round' } });
    expect(plain).not.toHaveProperty('tipGrain');
    expect(plain.dynamics).not.toHaveProperty('count');
    expect(plain.dynamics).not.toHaveProperty('flip');
    expect(normalizePaintBrush({ dynamics: { count: 1, flip: 'none' } }).dynamics).not.toHaveProperty('count');
  });

  it('drops grain where no dabs are laid, and image sources from object marks', () => {
    const p: string[] = [];
    const bristle = normalizeBrushSpec({ ...base, tip: { shape: 'bristle', grain: { source: 'rough' } } }, p);
    expect(bristle.tip.grain).toBeUndefined();
    expect(p.join(' ')).toMatch(/tip.grain dropped: bristle/);
    const wet = normalizeBrushSpec({ ...base, behaviour: { surface: 'wet' } });
    expect(wet.tip.grain).toBeUndefined();
    const q: string[] = [];
    const objects = normalizeBrushSpec({ ...base, tip: { shape: 'stamp', stamps: ['source:charcoal', 'editor:star'] }, marks: { kind: 'objects' } }, q);
    expect(objects.tip.stamps).toEqual(['editor:star']);
    expect(q.join(' ')).toMatch(/objects marks lay stickers/);
    const noSource = normalizeBrushSpec({ ...base, tip: { shape: 'round', grain: { depth: 0.5 } as never } });
    expect(noSource.tip.grain).toBeUndefined();
  });
});

describe('host profiles', () => {
  const grainy: Brush = { id: 'g', name: 'Grainy', kind: 'mark', tip: { shape: 'round', grain: { source: 'canvas' } }, dynamics: { count: 2 } };
  const image: Brush = { id: 'i', name: 'Image', kind: 'mark', tip: { shape: 'stamp', stamps: ['source:leaf'] } };

  it('paints tip grain and counts in paint, and warns that other hosts paint without them', () => {
    expect(checkBrush(grainy, PAINT_PROFILE)).toEqual({ ok: true, issues: [] });
    for (const profile of [CANVAS_PROFILE, IMAGE_PROFILE]) {
      const c = checkBrush(grainy, profile);
      expect(c.ok).toBe(true);
      expect(c.issues.map((i) => [i.facet, i.severity])).toEqual([
        ['tip.grain', 'warning'],
        ['dynamics.count', 'warning'],
      ]);
    }
    expect(degrade(grainy, CANVAS_PROFILE, { ignored: true }).brush).toEqual({ id: 'g', name: 'Grainy', kind: 'mark', tip: { shape: 'round' }, dynamics: {} });
  });

  it('refuses image tips where stamp tips are refused, saying so', () => {
    const c = checkBrush(image, CANVAS_PROFILE);
    expect(c.ok).toBe(false);
    expect(c.issues[0]).toMatchObject({ facet: 'tip.shape', severity: 'error' });
    expect(c.issues[0].reason).toMatch(/image tips are stamps/);
  });
});

describe('the dab engine', () => {
  const walk = (brush: ReturnType<typeof normalizePaintBrush>, seed = 3) => {
    const w = new PenDabWalker(brush, seed);
    const out: PenDab[] = [];
    for (const p of line(10)) w.push(p, out);
    w.finish(out);
    return out;
  };

  it('lays count dabs per spacing step, each with its own jitter', () => {
    const one = walk(normalizePaintBrush({ tip: { spacing: 0.5 }, dynamics: { scatter: 1 } }));
    const three = walk(normalizePaintBrush({ tip: { spacing: 0.5 }, dynamics: { scatter: 1, count: 3 } }));
    expect(three.length).toBe(one.length * 3);
    expect(new Set(three.slice(0, 3).map((d) => `${d.x.toFixed(3)},${d.y.toFixed(3)}`)).size).toBe(3);
    expect(walk(normalizePaintBrush({ dynamics: { scatter: 1, count: 3 } }))).toEqual(walk(normalizePaintBrush({ dynamics: { scatter: 1, count: 3 } })));
  });

  it('flips dabs at random on the axes asked, the same for the same seed', () => {
    const flips = (flip: 'x' | 'y' | 'xy', seed = 3) => walk(normalizePaintBrush({ tip: { spacing: 0.3 }, dynamics: { flip } }), seed).map((d) => d.flip ?? 0);
    expect(new Set(flips('x'))).toEqual(new Set([0, 1]));
    expect(new Set(flips('y'))).toEqual(new Set([0, 2]));
    expect(new Set(flips('xy'))).toEqual(new Set([0, 1, 2, 3]));
    expect(flips('xy')).toEqual(flips('xy'));
    expect(flips('xy', 4)).not.toEqual(flips('xy', 3));
  });

  it('places an image tip where its marks are, mirrored by a flip, softened by hardness', () => {
    const cache = new BrushSourceArtCache();
    cache.set([makeBrushSource({ id: 'left', name: 'Left', image: LEFT_HALF })]);
    const sample = stampSampler('source:left', cache.get)!;
    const dab = { x: 50, y: 50, radius: 10, roundness: 1, angle: 0, alpha: 1 };
    const rect = stampDabRect(dab);
    const at = (out: Float32Array, x: number, y: number) => out[(y - rect.y) * rect.width + (x - rect.x)];
    const plain = new Float32Array(rect.width * rect.height);
    rasterizeStampDab(dab, sample, 0, rect, plain);
    expect(at(plain, 45, 50)).toBeCloseTo(1, 2);
    expect(at(plain, 55, 50)).toBe(0);
    const flipped = new Float32Array(rect.width * rect.height);
    rasterizeStampDab({ ...dab, flip: 1 }, sample, 0, rect, flipped);
    expect(at(flipped, 45, 50)).toBe(0);
    expect(at(flipped, 55, 50)).toBeCloseTo(1, 2);
    const soft = new Float32Array(rect.width * rect.height);
    rasterizeStampDab(dab, stampSampler('source:left', cache.get, 0.2)!, 0, rect, soft);
    expect(at(soft, 41, 41)).toBeLessThan(at(plain, 41, 41));
    expect(at(soft, 49, 50)).toBeCloseTo(at(plain, 49, 50), 2);
    // An unknown source paints round, as an unloaded sticker does.
    expect(stampSampler('source:missing', cache.get)).toBeNull();
  });

  it('textures each dab with tip grain: texturised stays put on the canvas, moving rolls with the travel', () => {
    const cache = new BrushSourceArtCache();
    cache.set([makeBrushSource({ id: 'stripes', name: 'Stripes', image: STRIPES, channel: 'lightness' })]);
    const settings = (mode: 'moving' | 'texturised') => normalizePaintBrush({ tipGrain: { source: 'source:stripes', mode, depth: 1 } }).tipGrain!;
    const rect = { x: 0, y: 0, width: 16, height: 1 };
    const apply = (mode: 'moving' | 'texturised', d: { x: number; travel: number }) => {
      const vals = new Float32Array(16).fill(1);
      TipGrain.create(settings(mode), cache.get)!.apply(vals, rect, { x: d.x, y: 0, angle: 0, travel: d.travel });
      return [...vals].map((v) => Math.round(v));
    };
    const stripes = [1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0];
    expect(apply('texturised', { x: 3, travel: 0 })).toEqual(stripes);
    expect(apply('texturised', { x: 7, travel: 40 })).toEqual(stripes);
    // Moving: read from the dab's centre plus the travel, so it shifts with them.
    expect(apply('moving', { x: 0, travel: 0 })).toEqual(stripes);
    expect(apply('moving', { x: 0, travel: 4 })).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1]);
    // A built-in pattern needs no source; no depth, no grain.
    expect(TipGrain.create(normalizePaintBrush({ tipGrain: { source: 'rough' } }).tipGrain)).not.toBeNull();
    expect(TipGrain.create(normalizePaintBrush({ tipGrain: { source: 'rough', depth: 0 } }).tipGrain)).toBeNull();
  });

  it('paints the same coverage for the same seed (dry strokes replay exactly)', () => {
    const cache = new BrushSourceArtCache();
    cache.set([makeBrushSource({ id: 'left', name: 'Left', image: LEFT_HALF })]);
    const brush = resolveBrush(normalizeBrushSpec({ id: 'b', name: 'B', kind: 'mark', tip: { shape: 'stamp', size: 18, stamps: ['source:left'], grain: { source: 'sanded', mode: 'moving' } }, dynamics: { count: 2, flip: 'xy', angleJitter: 0.4, scatter: 0.5 } }));
    const run = (seed: number) => {
      const s = new DryStroke(brush, { grain: null, paperDepth: 0, seed, stampArt: cache.get });
      s.push(line());
      s.finish();
      return s;
    };
    const a = run(9);
    const b = run(9);
    expect(a.dabCount).toBeGreaterThan(20);
    const tiles = (s: DryStroke) => [...s.coverage.tiles.entries()].map(([k, t]) => [k, Buffer.from(t.buffer).toString('base64')]);
    expect(a.coverage.bounds).toEqual(b.coverage.bounds);
    expect(tiles(a)).toEqual(tiles(b));
    expect(tiles(run(10))).not.toEqual(tiles(a));
  });
});

describe('the paint editor', () => {
  const editor = () => new PaintEditorController({ width: 240, height: 80, paper: 'smooth' });

  it('paints an image tip with grain from the library, saves the source with the painting, and replays it exactly', async () => {
    const c = editor();
    await c.brushLibrary.addSource({ id: 'scan', name: 'Scan', image: SCAN, licence: 'Made for this test' });
    await c.whenBrushesLoaded();
    c.setBrushFacets({ tip: { shape: 'stamp', size: 24, spacing: 0.4, stamps: ['source:scan'], grain: { source: 'canvas', depth: 0.7 } }, dynamics: { flip: 'x', angleJitter: 0.3 } }, 'ink-pen');
    c.paintStroke({ points: line(), color: '#202020', seed: 4 });
    const pixels = Buffer.from(c.compositePixels().data);

    const saved = c.toJSON();
    expect(saved.brushSources).toEqual([expect.objectContaining({ id: 'scan', licence: 'Made for this test' })]);
    expect(JSON.stringify(saved.strokes)).toContain('source:scan');

    // A fresh editor with an empty library replays it from the document alone.
    const d = editor();
    d.loadJSON(JSON.parse(JSON.stringify(saved)));
    const t = d.createReplayTarget(1);
    await replayPainting(d.document, t);
    expect(Buffer.from(t.compositePixels().data).equals(pixels)).toBe(true);
    t.dispose();
    // It paints differently from the round tip.
    const round = editor();
    round.setBrushFacets({ tip: { shape: 'round', size: 24, spacing: 0.4 } }, 'ink-pen');
    round.paintStroke({ points: line(), color: '#202020', seed: 4 });
    expect(Buffer.from(round.compositePixels().data).equals(pixels)).toBe(false);
  });
});

describe('the library', () => {
  it('keeps sources in storage and carries them in exported files', async () => {
    const storage = createMemoryStorage();
    const lib = createBrushLibrary({ storage });
    const added = await lib.addSource({ name: 'Leaf', image: LEFT_HALF, origin: 'leaf.png' });
    expect(added).toMatchObject({ source: { id: 'leaf', origin: 'leaf.png' }, replaced: false });
    expect((await lib.addSource({ name: 'Leaf', image: SCAN })).source.id).toBe('leaf-2');
    await expect(lib.addSource({ id: 'leaf', name: 'Leaf', image: SCAN })).rejects.toThrow(/exists already/);
    await lib.save({ id: 'leafy', name: 'Leafy', kind: 'mark', tip: { shape: 'stamp', stamps: ['source:leaf'] } });
    expect((await createBrushLibrary({ storage }).listSources()).map((s) => s.id)).toEqual(['leaf', 'leaf-2']);

    const file = await lib.exportFile(['leafy']);
    expect(file.sources?.map((s) => s.id)).toEqual(['leaf']);
    const other = createBrushLibrary();
    const r = await other.importFile(JSON.parse(JSON.stringify(file)));
    expect(r).toMatchObject({ added: ['leafy'], sources: ['leaf'] });
    expect(await other.getSource('leaf')).toEqual(added.source);
    // Brushes without sources export as before.
    await lib.save({ id: 'plain', name: 'Plain', kind: 'mark', tip: { shape: 'round' } });
    expect(await lib.exportFile(['plain'])).not.toHaveProperty('sources');
  });
});

describe('the agent tools', () => {
  const setup = () => {
    const library = createBrushLibrary();
    const registry = new ToolRegistry();
    registry.register(createBrushLibraryToolProvider(library));
    const call = async (name: string, args: Record<string, unknown>) => registry.callTool(`brushes__${name}`, args);
    return { library, call };
  };

  it('adds a source, lists it, and makes an image brush with grain from it', async () => {
    const { call } = setup();
    const add = await call('add_brush_source', { name: 'Charcoal scan', image: SCAN, licence: 'CC0' });
    expect(add.isError).toBeFalsy();
    expect(add.structuredContent).toMatchObject({ id: 'charcoal-scan', ref: 'source:charcoal-scan', width: 20, height: 20, replaced: false });
    const created = await call('create_brush', { id: 'charcoal-tip', name: 'Charcoal tip', kind: 'mark', medium: 'dry', tip: { shape: 'stamp', stamps: ['source:charcoal-scan'], grain: { source: 'source:charcoal-scan', mode: 'texturised' } }, dynamics: { count: 2, flip: 'x' } });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent).toMatchObject({ id: 'charcoal-tip', engine: 'dab', problems: [] });
    const list = await call('list_brush_sources', {});
    expect(list.structuredContent).toEqual({ total: 1, sources: [{ id: 'charcoal-scan', name: 'Charcoal scan', width: 20, height: 20, licence: 'CC0', ref: 'source:charcoal-scan', usedBy: ['charcoal-tip'] }] });
    expect((await call('list_brush_sources', { text: 'pencil' })).structuredContent).toEqual({ total: 0, sources: [] });
  });

  it('refuses unknown sources, bad images and bad arguments, saving nothing', async () => {
    const { call, library } = setup();
    await call('add_brush_source', { name: 'Leaf', image: LEFT_HALF });
    const unknown = await call('create_brush', { id: 'x', name: 'X', kind: 'mark', tip: { shape: 'stamp', stamps: ['source:leaf-2'] } });
    expect(unknown.isError).toBe(true);
    expect((unknown.content as Array<{ text: string }>)[0].text).toMatch(/no image source "leaf-2" in the brush library\. Closest: leaf\. Add it with add_brush_source/);
    const grain = await call('create_brush', { id: 'y', name: 'Y', kind: 'mark', tip: { shape: 'round', grain: { source: 'source:nope' } } });
    expect(grain.isError).toBe(true);
    expect(await library.get('x')).toBeNull();
    const empty = await call('add_brush_source', { name: 'Empty', image: png(4, 4, () => [0, 0, 0, 0]) });
    expect(empty.isError).toBe(true);
    expect(JSON.stringify(empty.content)).toMatch(/no marks/);
    expect((await call('add_brush_source', { name: 'Leaf', image: 'https://example.com/a.png' })).isError).toBe(true);
    expect((await call('add_brush_source', { name: 'Leaf', image: LEFT_HALF, colour: 'red' })).isError).toBe(true);
    expect((await call('add_brush_source', { id: 'leaf', name: 'Leaf', image: SCAN })).isError).toBe(true);
    const replaced = await call('add_brush_source', { id: 'leaf', name: 'Leaf', image: SCAN, overwrite: true });
    expect(replaced.structuredContent).toMatchObject({ replaced: true });
    expect((await library.listSources()).length).toBe(1);
  });

  it('checks tip grain against other hosts', async () => {
    const { call } = setup();
    const r = await call('check_brush', { brush: { id: 'g', name: 'G', kind: 'mark', tip: { shape: 'round', grain: { source: 'rough' } } }, host: 'canvas' });
    expect(r.structuredContent).toMatchObject({ ok: true, issues: [{ facet: 'tip.grain', severity: 'warning' }] });
  });
});

describe('the brush editor', () => {
  const brush: Brush = { id: 'b', name: 'B', kind: 'mark', tip: { shape: 'stamp', stamps: ['source:leaf'] } };
  const ids = (b: Brush, profile = PAINT_PROFILE) => brushEditorSections(b, profile, { sources: [{ id: 'leaf', name: 'Leaf' }] });

  it('offers sources as stamps and grain, and grain and variation controls only where the host paints them', () => {
    const sections = ids(brush);
    const stamps = sections.find((s) => s.id === 'shape')!.controls.find((c) => c.kind === 'stamps')!;
    expect(stamps.kind === 'stamps' && stamps.options.at(-1)).toEqual({ value: 'source:leaf', label: 'Leaf' });
    const grain = sections.find((s) => s.id === 'grain')!;
    expect(grain.controls.map((c) => c.path)).toEqual(['tip.grain.source']);
    const source = grain.controls[0];
    expect(source.kind === 'choice' && source.options.map((o) => o.value)).toEqual(expect.arrayContaining(['', 'rough', 'canvas', 'source:leaf']));
    expect(sections.find((s) => s.id === 'feel')!.controls.map((c) => c.path)).toEqual(expect.arrayContaining(['dynamics.count', 'dynamics.scatter', 'dynamics.angleJitter', 'dynamics.sizeJitter', 'dynamics.flip']));
    const withGrain = setBrushEditorValue(brush, 'tip.grain.source', 'canvas').brush;
    expect(ids(withGrain).find((s) => s.id === 'grain')!.controls.map((c) => c.path)).toEqual(['tip.grain.source', 'tip.grain.mode', 'tip.grain.scale', 'tip.grain.depth', 'tip.grain.contrast', 'tip.grain.invert']);
    expect(setBrushEditorValue(withGrain, 'tip.grain.source', '').brush.tip.grain).toBeUndefined();
    // Canvas paints without tip grain: no Grain section, and no count.
    const round: Brush = { id: 'r', name: 'R', kind: 'mark', tip: { shape: 'round' } };
    expect(brushEditorSections(round, CANVAS_PROFILE).some((s) => s.id === 'grain')).toBe(false);
    expect(brushEditorSections(round, PAINT_PROFILE).some((s) => s.id === 'grain')).toBe(true);
    expect(brushEditorSections({ ...round, tip: { shape: 'bristle' } }, PAINT_PROFILE).some((s) => s.id === 'grain')).toBe(false);
  });
});
