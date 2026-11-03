import { describe, expect, it } from 'vitest';
import { addPolygonArea, createPaintEditorToolProvider, toggleDotTexture, DEFAULT_PARTICLE, normalizeParticle, PaintEditorController, replayPainting, type PaintPixelLayer } from '../src/paint-editor';
import { readPixel } from '../src/raster/surface';
import { ToolRegistry } from '../src/tools/registry';

const W = 240;
const H = 140;
const editor = () => new PaintEditorController({ width: W, height: H, paper: 'smooth' });
/** A gentle S along the canvas, with times (`t`, ms: waves run by time). */
const path = (n = 120) =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: 20 + (i / n) * 200, y: 70 + Math.sin((i / n) * Math.PI * 2) * 20, pressure: 0.8, t: i * 12 }));
const pixels = (c: PaintEditorController) => Buffer.from(c.compositePixels().data);
const alphaBounds = (c: PaintEditorController) => {
  const s = (c.getActiveLayer() as PaintPixelLayer).surface;
  let y0 = H;
  let y1 = -1;
  let area = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (readPixel(s, x, y)[3] > 8) {
        area++;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return { y0, y1, area };
};
const paint = (particle: Record<string, unknown>, extra: Record<string, unknown> = {}, seed = 5) => {
  const c = editor();
  c.paintStroke({ brushId: 'spring-ink', brush: { tip: { size: 40, pressureSize: false }, particle, ...extra }, points: path(), color: '#0f766e', seed });
  return c;
};

describe('particle brushes: ribbons, waves, elastic and fuzzy kinds, textured dots', () => {
  it('addPolygonArea: polygons sharing an edge add up to exactly the area they cover, with no seam', () => {
    const rect = { x: 0, y: 0, width: 12, height: 12 };
    const out = new Float32Array(144);
    // Two quads sharing a slanted edge tile the square 1..11.
    addPolygonArea([1, 1, 6.3, 1, 4.7, 11, 1, 11], rect, out);
    addPolygonArea([6.3, 1, 11, 1, 11, 11, 4.7, 11], rect, out);
    for (let y = 1; y < 11; y++) for (let x = 1; x < 11; x++) expect(out[y * 12 + x]).toBeCloseTo(1, 5);
    expect(out[0]).toBe(0);
    // Half a pixel of a triangle's edge counts as half; a weight scales it.
    const tri = new Float32Array(144);
    addPolygonArea([0, 0, 12, 0, 0, 12], rect, tri, 0.5);
    expect(tri[0]).toBeCloseTo(0.5, 5);
    expect(tri[5 * 12 + 6]).toBeCloseTo(0.25, 1);
  });

  it('ribbon fills the band between the paths, evenly and without seams, at ribbonFill of the opacity', () => {
    const c = editor();
    // Two springs a tip apart, joined into one band (first-last), stiff so they follow the pen.
    c.paintStroke({
      brushId: 'spring-ink',
      brush: { tip: { size: 40, pressureSize: false, opacity: 1, hardness: 1 }, grain: 0, particle: { kind: 'spring', render: 'ribbon', count: 2, size: 0.02, spread: 1, stiffness: 1, damping: 1, ribbonFill: 0.5, ribbonPairs: 'first-last' } },
      points: [
        { x: 20, y: 70 },
        { x: 220, y: 70 },
      ],
      color: '#000000',
      seed: 2,
    });
    const s = (c.getActiveLayer() as PaintPixelLayer).surface;
    // Inside the band, away from its edges, every pixel has the same coverage: half the opacity.
    const col = (x: number) => Array.from({ length: H }, (_, y) => readPixel(s, x, y)[3]);
    const inner = col(120).filter((a) => a > 0);
    expect(inner.length).toBeGreaterThan(4);
    const filled = col(120).filter((a) => a > 100 && a < 150);
    expect(filled.length).toBeGreaterThan(3);
    for (let x = 60; x < 180; x += 7) for (let y = 0; y < H; y++) if (col(120)[y] > 100 && col(120)[y] < 150) expect(Math.abs(readPixel(s, x, y)[3] - col(120)[y]), `x ${x} y ${y}`).toBeLessThanOrEqual(1);
    // ribbonFill 0 leaves only the edges.
    const edges = paint({ kind: 'spring', render: 'ribbon', count: 2, ribbonFill: 0, ribbonPairs: 'first-last' });
    const full = paint({ kind: 'spring', render: 'ribbon', count: 2, ribbonFill: 1, ribbonPairs: 'first-last' });
    expect(alphaBounds(full).area).toBeGreaterThan(alphaBounds(edges).area * 2);
  });

  it('is deterministic: the same seed paints the same pixels, another seed differs, and replays are exact', async () => {
    const settings = { kind: 'fuzzy', render: 'ribbon', count: 6, waveAmplitude: 0.2, waveSpeed: 0.7, wavePhaseJitter: 1 };
    expect(pixels(paint(settings)).equals(pixels(paint(settings)))).toBe(true);
    expect(pixels(paint(settings)).equals(pixels(paint(settings, {}, 6)))).toBe(false);
    for (const particle of [settings, { kind: 'flow', render: 'ribbon', count: 4, life: 0.3 }, { kind: 'spring', render: 'sequence', count: 3, dotTextures: ['star', 'ring'], dotTextureOrder: 'random' }]) {
      const c = paint(particle);
      const before = pixels(c);
      const t = c.createReplayTarget(1);
      await replayPainting(c.document, t);
      expect(pixels(t).equals(before), JSON.stringify(particle)).toBe(true);
      t.dispose();
    }
  });

  it('waves move the marks sideways by waveAmplitude of the tip, by wavelength along the path', () => {
    const flat = alphaBounds(paint({ kind: 'spring', render: 'line', count: 1, spread: 0, stiffness: 1, damping: 1 }));
    const wavy = alphaBounds(paint({ kind: 'spring', render: 'line', count: 1, spread: 0, stiffness: 1, damping: 1, waveAmplitude: 0.5, waveLength: 40 }));
    // ±0.5 of a 40 px tip: about 20 px further each way.
    expect(flat.y0 - wavy.y0).toBeGreaterThan(12);
    expect(wavy.y1 - flat.y1).toBeGreaterThan(12);
    // A long wavelength barely waves over a short stroke; speed and phase jitter change the marks.
    const long = paint({ kind: 'spring', render: 'line', count: 3, waveAmplitude: 0.5, waveLength: 2000 });
    const short = paint({ kind: 'spring', render: 'line', count: 3, waveAmplitude: 0.5, waveLength: 30 });
    expect(pixels(long).equals(pixels(short))).toBe(false);
    const base = { kind: 'spring', render: 'line', count: 3, waveAmplitude: 0.3 };
    expect(pixels(paint(base)).equals(pixels(paint({ ...base, waveSpeed: 1 })))).toBe(false);
    expect(pixels(paint(base)).equals(pixels(paint({ ...base, wavePhaseJitter: 1 })))).toBe(false);
    // Waves run by stroke time: the same path drawn slower waves differently, but only with waveSpeed.
    const slow = (particle: Record<string, unknown>) => {
      const c = editor();
      c.paintStroke({ brushId: 'spring-ink', brush: { tip: { size: 40, pressureSize: false }, particle }, points: path().map((p) => ({ ...p, t: p.t * 4 })), color: '#0f766e', seed: 5 });
      return pixels(c);
    };
    expect(slow(base).equals(pixels(paint(base)))).toBe(true);
    expect(slow({ ...base, waveSpeed: 1 }).equals(pixels(paint({ ...base, waveSpeed: 1 })))).toBe(false);
    // The toggle the panels use adds up to MAX_DOT_TEXTURES stamps and removes every copy.
    expect(toggleDotTexture(['star', 'ring', 'dot', 'heart'], 'leaf')).toEqual(['star', 'ring', 'dot', 'heart']);
    expect(toggleDotTexture(['star', 'ring', 'star'], 'star')).toEqual(['ring']);
    expect(toggleDotTexture([], 'sparkle')).toEqual(['sparkle']);
  });

  it('elastic strands stay near the pen and stretch with it; fuzzy strands wind by themselves', () => {
    for (const kind of ['elastic', 'fuzzy']) {
      const c = paint({ kind, render: 'line', count: 5, stiffness: 0.5 });
      const b = alphaBounds(c);
      expect(b.area, kind).toBeGreaterThan(200);
      // Stable: nothing flies off far from the 40 px band the pen sweeps.
      expect(b.y0, kind).toBeGreaterThan(70 - 20 - 50);
      expect(b.y1, kind).toBeLessThan(70 + 20 + 50);
    }
    // Fuzzy waves even with waveAmplitude 0; a plain string does not.
    expect(pixels(paint({ kind: 'fuzzy', count: 4 })).equals(pixels(paint({ kind: 'string', count: 4 })))).toBe(false);
  });

  it('textured dots stamp the chosen stamps in turn or at random, turned by motion, at random or to the tip', () => {
    const round = paint({ kind: 'spring', render: 'dot', count: 2, size: 0.4 });
    const star = paint({ kind: 'spring', render: 'dot', count: 2, size: 0.4, dotTextures: ['star'] });
    expect(pixels(round).equals(pixels(star))).toBe(false);
    const variants = [
      { dotTextures: ['star', 'heart'], dotTextureOrder: 'sequence' },
      { dotTextures: ['star', 'heart'], dotTextureOrder: 'random' },
      { dotTextures: ['star'], dotRotation: 'follow' },
      { dotTextures: ['star'], dotRotation: 'fixed' },
    ];
    const seen = variants.map((v) => pixels(paint({ kind: 'spring', render: 'sequence', count: 2, size: 0.4, interval: 0.5, ...v })).toString('base64'));
    expect(new Set(seen).size).toBe(variants.length);
  });

  it('normalises the new settings with clear limits', () => {
    const p = normalizeParticle({
      render: 'ribbon',
      ribbonFill: 3,
      ribbonPairs: 'nope' as never,
      waveAmplitude: -1,
      waveLength: 1,
      waveSpeed: 2,
      wavePhaseJitter: Number.NaN,
      dotTextures: ['star', 'bogus', 'ring', 'dot', 'heart', 'leaf'] as never,
      dotTextureOrder: 'x' as never,
      dotRotation: 'follow',
    });
    expect(p).toMatchObject({ render: 'ribbon', ribbonFill: 1, ribbonPairs: 'adjacent', waveAmplitude: 0, waveLength: 4, waveSpeed: 1, wavePhaseJitter: 0, dotTextures: ['star', 'ring', 'dot', 'heart'], dotTextureOrder: 'sequence', dotRotation: 'follow' });
    expect(normalizeParticle({ waveLength: 1e6 }).waveLength).toBe(2000);
    // Settings saved before these existed come back with the defaults.
    const old = { kind: 'string', render: 'line', count: 3, size: 0.1, spread: 0.5, stiffness: 0.4, damping: 0.25, speed: 0.5, gravity: 0, life: 0.5, interval: 0.3 } as never;
    expect(normalizeParticle({}, old)).toMatchObject({ ribbonFill: DEFAULT_PARTICLE.ribbonFill, waveAmplitude: 0, waveLength: 60, dotTextures: [], dotRotation: 'random' });
  });

  describe('agent path', () => {
    const setup = () => {
      const c = editor();
      const r = new ToolRegistry();
      r.register(createPaintEditorToolProvider(c));
      return { c, r };
    };
    const ok = (res: { isError?: boolean; structuredContent?: unknown; content: unknown[] }) => {
      expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
      return res.structuredContent as any;
    };
    const text = (res: { content: unknown[] }) => (res.content[0] as { text: string }).text;

    it('set_brush and get_brush take and return the new particle settings', async () => {
      const { c, r } = setup();
      ok(await r.callTool('set_brush', { id: 'spring-ink', particle: { kind: 'elastic', render: 'ribbon', ribbonFill: 0.3, ribbonPairs: 'first-last', waveAmplitude: 0.2, waveLength: 80, waveSpeed: 0.5, wavePhaseJitter: 0.4, dotTextures: ['sparkle', 'star'], dotTextureOrder: 'random', dotRotation: 'follow' } }));
      const got = ok(await r.callTool('get_brush', {}));
      expect(JSON.stringify(got)).toContain('"ribbonPairs":"first-last"');
      expect(c.getState().brush.particle).toMatchObject({ kind: 'elastic', render: 'ribbon', ribbonFill: 0.3, waveLength: 80, dotTextures: ['sparkle', 'star'], dotRotation: 'follow' });
      const bad = [
        { kind: 'wobbly' },
        { render: 'mesh' },
        { dotTextures: ['star', 'star', 'star', 'star', 'star'] },
        { dotTextures: ['teapot'] },
        { waveLength: 2 },
        { ribbonFill: 1.5 },
        { ribbon: 1 },
      ];
      for (const particle of bad) {
        const res = await r.callTool('set_brush', { particle });
        expect(res.isError, JSON.stringify(particle)).toBe(true);
        expect(text(res).length).toBeGreaterThan(10);
      }
      // A failed call changes nothing.
      expect(c.getState().brush.particle.kind).toBe('elastic');
    });

    it('every Light preset paints light and has a thumbnail', async () => {
      const { r } = setup();
      for (const id of ['light-ribbon', 'flame-ribbon', 'neon-strand', 'smoke-ribbon', 'bokeh-dots', 'twinkle-sparks']) {
        const thumb = await r.callTool('render_brush_thumbnail', { id });
        expect(thumb.isError, id).toBeFalsy();
        expect(thumb.content[0], id).toMatchObject({ type: 'image' });
        const c = editor();
        c.setPaper({ color: '#0b1020' });
        c.paintStroke({ brushId: id, points: path(), color: '#22d3ee', seed: 1 });
        expect(c.document.light?.[c.getActiveLayer()!.id], id).toBeDefined();
      }
    });
  });
});
