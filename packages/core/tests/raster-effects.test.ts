import { describe, expect, it } from 'vitest';
import {
  RasterCompositor,
  builtinPattern,
  defaultLayerEffect,
  effectsFingerprint,
  effectsMargin,
  emptySurface,
  fillRect,
  hasActiveEffects,
  LAYER_EFFECT_KINDS,
  LayerEffectError,
  mergeLayerEffect,
  normalizeLayerEffects,
  readRegion,
  renderLayerEffects,
  scaleLayerEffect,
  solidSurface,
  validateLayerEffect,
  PatternTile,
  type LayerEffect,
  type LayerEffectKind,
  type LayerEffects,
  type RasterLayer,
  type RasterSources,
} from '../src/raster';

// A canvas a little over one tile wide and tall, so shapes and their effects cross tile edges.
const W = 300;
const H = 280;
const sources: RasterSources = { width: W, height: H };
const canvas = { x: 0, y: 0, width: W, height: H };

/** A red rectangle crossing the tile boundary at x = 256, with a soft (half-covered) left column. */
function shapeSurface() {
  let s = solidSurface(4, { x: 230, y: 100, width: 50, height: 60 }, 0xd02020ff);
  s = fillRect(s, { x: 229, y: 100, width: 1, height: 60 }, [208, 32, 32, 128]);
  return s;
}

function stack(effects: LayerEffects, extra: Partial<RasterLayer> = {}): RasterLayer[] {
  return [
    { type: 'pixel', id: 'bg', name: 'bg', visible: true, opacity: 1, blend: 'normal', surface: solidSurface(4, canvas, 0xf0f0f0ff), offset: { x: 0, y: 0 } },
    { type: 'pixel', id: 'shape', name: 'shape', visible: true, opacity: 1, blend: 'normal', surface: shapeSurface(), offset: { x: 0, y: 0 }, effects, ...extra } as RasterLayer,
  ];
}

const ctx = { light: { angle: 120, altitude: 30 }, pattern: (id: string) => (builtinPattern(id) ? new PatternTile(builtinPattern(id)!) : null) };

/** The reference: the backdrop and the layer rendered with its effects over the whole canvas at once. */
function reference(effects: LayerEffects, layer: { blend?: string; opacity?: number; fillOpacity?: number } = {}) {
  const backdrop = readRegion(solidSurface(4, canvas, 0xf0f0f0ff), canvas);
  const content = readRegion(shapeSurface(), canvas);
  renderLayerEffects(effects, { content, rect: canvas, blend: (layer.blend ?? 'normal') as never, opacity: layer.opacity ?? 1, fillOpacity: layer.fillOpacity }, backdrop, canvas, ctx);
  return backdrop;
}

function maxDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

const px = (data: Uint8ClampedArray, x: number, y: number) => Array.from(data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));

function fx(kind: LayerEffectKind, changes: Record<string, unknown> = {}): LayerEffect {
  return mergeLayerEffect(defaultLayerEffect(kind, kind), changes);
}

const one = (e: LayerEffect, extra: Partial<LayerEffects> = {}): LayerEffects => ({ enabled: true, items: [e], ...extra });

const CASES: Array<[string, LayerEffect]> = [
  ['drop shadow', fx('drop-shadow', { distance: 12, size: 9, spread: 0.2, useGlobalLight: false, angle: 135 })],
  ['drop shadow with noise and a contour', fx('drop-shadow', { size: 6, noise: 0.3, contour: { name: 'Cone', points: [{ input: 0, output: 0 }, { input: 0.5, output: 1, corner: true }, { input: 1, output: 0 }] } })],
  ['inner shadow', fx('inner-shadow', { distance: 6, size: 8, choke: 0.1 })],
  ['outer glow (softer)', fx('outer-glow', { size: 14, spread: 0.1 })],
  ['outer glow (precise, gradient)', fx('outer-glow', { technique: 'precise', size: 10, fill: { type: 'gradient', gradient: { stops: [{ position: 0, color: '#ffff00' }, { position: 1, color: '#0000ff' }], style: 'linear', angle: 90, scale: 1, reverse: false, align: true, offset: { x: 0, y: 0 } } } })],
  ['inner glow (centre)', fx('inner-glow', { size: 12, source: 'center' })],
  ['bevel (smooth inner)', fx('bevel-emboss', { size: 8, depth: 2 })],
  ['bevel (chisel hard outer)', fx('bevel-emboss', { style: 'outer-bevel', technique: 'chisel-hard', size: 6 })],
  ['emboss (pillow, chisel soft, contour)', fx('bevel-emboss', { style: 'pillow-emboss', technique: 'chisel-soft', size: 10, soften: 2, contourElement: { contour: { name: 'Half', points: [{ input: 0, output: 0 }, { input: 1, output: 0.5 }] }, range: 0.5, antiAlias: false } })],
  ['bevel with texture', fx('bevel-emboss', { size: 6, texture: { patternId: 'dots', scale: 1, depth: 1, invert: false } })],
  ['satin', fx('satin', { distance: 8, size: 10 })],
  ['colour overlay', fx('color-overlay', { color: '#00ff00', blend: 'multiply', opacity: 0.6 })],
  ['gradient overlay', fx('gradient-overlay', { gradient: { stops: [{ position: 0, color: '#ff00ff' }, { position: 1, color: '#00ffff' }], opacityStops: [{ position: 0, opacity: 1 }, { position: 1, opacity: 0.25 }], style: 'radial', angle: 30, scale: 1, reverse: false, align: true, offset: { x: 0, y: 0 } } })],
  ['pattern overlay', fx('pattern-overlay', { patternId: 'stripes', scale: 0.5, angle: 20 })],
  ['stroke outside', fx('stroke', { size: 5, position: 'outside', fill: { type: 'color', color: '#0000ff' } })],
  ['stroke inside (gradient)', fx('stroke', { size: 4, position: 'inside', fill: { type: 'gradient', gradient: { stops: [{ position: 0, color: '#000000' }, { position: 1, color: '#ffffff' }], style: 'linear', angle: 0, scale: 1, reverse: true, align: true, offset: { x: 0, y: 0 } } } })],
  ['stroke centre (pattern, wide)', fx('stroke', { size: 44, position: 'center', fill: { type: 'pattern', patternId: 'checker', scale: 1 } })],
];

describe('layer effects model', () => {
  it('gives every kind valid Photoshop defaults', () => {
    for (const kind of LAYER_EFFECT_KINDS) expect(() => validateLayerEffect(defaultLayerEffect(kind))).not.toThrow();
    expect(defaultLayerEffect('drop-shadow')).toMatchObject({ blend: 'multiply', opacity: 0.75, distance: 5, size: 5, angle: 120 });
  });

  it('rejects bad fields with the field named and the allowed range', () => {
    expect(() => mergeLayerEffect(defaultLayerEffect('stroke', 's'), { size: 900 })).toThrow(/effect\.size: 900 is out of range \(0 to 250\)/);
    expect(() => mergeLayerEffect(defaultLayerEffect('satin', 's'), { color: 'red' })).toThrow(LayerEffectError);
    expect(() => mergeLayerEffect(defaultLayerEffect('satin', 's'), { kind: 'stroke' })).toThrow(/kind cannot change/);
    expect(() => mergeLayerEffect(defaultLayerEffect('stroke', 's'), { fill: { type: 'pattern' } })).toThrow(/patternId/);
    expect(() => mergeLayerEffect(defaultLayerEffect('outer-glow', 'g'), { fill: { type: 'pattern', patternId: 'dots', scale: 1 } })).toThrow(/color or gradient/);
  });

  it('merges changes and removes optional parts with null', () => {
    const withContour = mergeLayerEffect(defaultLayerEffect('drop-shadow', 'd'), { contour: { name: 'Ring', points: [{ input: 0, output: 1 }, { input: 1, output: 0 }] } });
    expect((withContour as { contour?: unknown }).contour).toBeTruthy();
    expect((mergeLayerEffect(withContour, { contour: null }) as { contour?: unknown }).contour).toBeUndefined();
  });

  it('reads JSON leniently: fills defaults, drops broken effects and duplicate ids', () => {
    const fx = normalizeLayerEffects({ enabled: false, scale: 2, items: [{ kind: 'stroke', id: 'a', size: 9 }, { kind: 'nope' }, { kind: 'satin', id: 'a', size: -4 }, { kind: 'satin', id: 'a' }] });
    expect(fx!.enabled).toBe(false);
    expect(fx!.scale).toBe(2);
    expect(fx!.items.map((e) => e.kind)).toEqual(['stroke', 'satin']);
    expect(fx!.items[1].id).not.toBe('a');
    expect((fx!.items[0] as { size: number }).size).toBe(9);
  });

  it('measures the reach of the enabled effects, scaled', () => {
    const shadow = fx('drop-shadow', { distance: 10, size: 6 });
    expect(effectsMargin(one(shadow))).toBe(18);
    expect(effectsMargin(one(shadow, { scale: 2 }))).toBe(34);
    expect(effectsMargin(one(shadow, { enabled: false }))).toBe(0);
    expect(effectsMargin(one(mergeLayerEffect(shadow, { enabled: false })))).toBe(0);
    expect(hasActiveEffects(one(fx('color-overlay')))).toBe(true);
    expect(scaleLayerEffect(fx('stroke', { size: 3 }), 2)).toMatchObject({ size: 6 });
  });

  it('fingerprints what renders, not ids or key order', () => {
    const a = one(fx('satin'));
    const b = one({ ...fx('satin'), id: 'other' });
    expect(effectsFingerprint(a)).toBe(effectsFingerprint(b));
    expect(effectsFingerprint(a)).not.toBe(effectsFingerprint(one(fx('satin', { size: 3 }))));
  });
});

describe('layer effects in the tiled compositor', () => {
  it.each(CASES)('%s matches a whole-image reference render', (_name, effect) => {
    const effects = one(effect);
    const out = new RasterCompositor().composite(stack(effects), canvas, sources);
    expect(maxDiff(out, reference(effects))).toBe(0);
  });

  it('renders effects with blend, opacity and fill: a fill-0 layer keeps its stroke and overlay', () => {
    const effects: LayerEffects = { enabled: true, items: [fx('stroke', { size: 3 }), fx('color-overlay', { color: '#0000ff', opacity: 0.5 })] };
    const layer = { blend: 'multiply', opacity: 0.8, fillOpacity: 0 } as const;
    const out = new RasterCompositor().composite(stack(effects, layer), canvas, sources);
    expect(maxDiff(out, reference(effects, layer))).toBe(0);
    // Inside the shape only the overlay shows (fill is 0), multiplied over the grey backdrop.
    const inside = px(out, 260, 130);
    expect(inside[2]).toBeGreaterThan(inside[0]);
    // The outside stroke is black at 80 %.
    expect(px(out, 281, 130)[0]).toBeLessThan(80);
  });

  it('casts a drop shadow into a tile the layer has no pixels in', () => {
    const effects = one(fx('drop-shadow', { distance: 0, size: 10, opacity: 1, blend: 'normal' }));
    const layers = stack(effects);
    // Only the left tile holds pixels: the shape at 200..250, its shadow reaches past x = 256.
    (layers[1] as { surface: unknown }).surface = solidSurface(4, { x: 200, y: 100, width: 50, height: 60 }, 0xd02020ff);
    const out = new RasterCompositor().composite(layers, canvas, sources);
    expect(px(out, 258, 130)[0]).toBeLessThan(0xf0);
  });

  it('turns everything off with the master switch and caches nothing stale', () => {
    const c = new RasterCompositor();
    const on = stack(one(fx('stroke', { size: 6 })));
    const a = c.composite(on, canvas, sources);
    const off = stack({ ...one(fx('stroke', { size: 6 })), enabled: false });
    const b = c.composite(off, canvas, sources);
    const plain = new RasterCompositor().composite(stack({ enabled: true, items: [] }), canvas, sources);
    expect(maxDiff(b, plain)).toBe(0);
    expect(maxDiff(a, plain)).toBeGreaterThan(0);
  });

  it('grows dirty rectangles by the effects reach: an edit next to the tile edge redraws the shadow across it', () => {
    const c = new RasterCompositor();
    const effects = one(fx('drop-shadow', { distance: 0, size: 12, opacity: 1, blend: 'normal' }));
    const before = stack(effects);
    c.composite(before, canvas, sources);
    // Paint a 4 px dot just left of the tile edge (x = 256); its shadow spreads into the next tile.
    const layer = before[1] as Extract<RasterLayer, { type: 'pixel' }>;
    const surface = fillRect(layer.surface, { x: 248, y: 200, width: 4, height: 4 }, [0, 0, 0, 255]);
    const after = [before[0], { ...layer, surface }];
    const incremental = c.composite(after, canvas, sources, { dirty: [{ x: 248, y: 200, width: 4, height: 4 }] });
    const fresh = new RasterCompositor().composite(after, canvas, sources);
    expect(maxDiff(incremental, fresh)).toBe(0);
    expect(px(fresh, 258, 202)[0]).toBeLessThan(0xf0);
  });

  it('keeps tiles beyond the effects reach cached while a local stack changes elsewhere', () => {
    const c = new RasterCompositor();
    const effects = one(fx('drop-shadow', { distance: 2, size: 4 }));
    const wide = { x: 0, y: 0, width: 600, height: 280 };
    const src: RasterSources = { width: 600, height: 280 };
    const base = (surface: ReturnType<typeof solidSurface>): RasterLayer[] => [
      { type: 'pixel', id: 'shape', name: 'shape', visible: true, opacity: 1, blend: 'normal', surface, offset: { x: 0, y: 0 }, effects },
    ];
    let s = solidSurface(4, { x: 20, y: 20, width: 40, height: 40 }, 0xff0000ff);
    c.composite(base(s), wide, src);
    const firstTile = c.tile(base(s), 0, 0, src);
    s = fillRect(s, { x: 560, y: 20, width: 10, height: 10 }, [0, 255, 0, 255]);
    expect(c.tile(base(s), 0, 0, src)).toBe(firstTile);
  });

  it('applies effects to groups (their composite is the shape) and to clipped layers', () => {
    const effects = one(fx('stroke', { size: 4, fill: { type: 'color', color: '#00ff00' } }));
    const shape = stack({ enabled: true, items: [] })[1];
    const layers: RasterLayer[] = [stack({ enabled: true, items: [] })[0], { type: 'group', id: 'g', name: 'g', visible: true, opacity: 1, blend: 'pass-through', children: [shape], effects }];
    const grouped = new RasterCompositor().composite(layers, canvas, sources);
    const direct = new RasterCompositor().composite(stack(effects), canvas, sources);
    expect(maxDiff(grouped, direct)).toBe(0);
    // A clipped layer's colour overlay stays inside the base.
    const clippedLayers: RasterLayer[] = [
      ...stack({ enabled: true, items: [] }),
      { type: 'pixel', id: 'top', name: 'top', visible: true, opacity: 1, blend: 'normal', clipped: true, surface: solidSurface(4, canvas, 0x000000ff), offset: { x: 0, y: 0 }, effects: one(fx('color-overlay', { color: '#0000ff' })) },
    ];
    const out = new RasterCompositor().composite(clippedLayers, canvas, sources);
    expect(px(out, 260, 130)).toEqual([0, 0, 255, 255]);
    expect(px(out, 10, 10)).toEqual([0xf0, 0xf0, 0xf0, 255]);
  });

  it('uses the global light from the sources for effects that follow it', () => {
    const effects = one(fx('drop-shadow', { distance: 10, size: 0, opacity: 1, blend: 'normal' }));
    const fromLeft = new RasterCompositor().composite(stack(effects), canvas, { ...sources, globalLight: { angle: 180, altitude: 30 } });
    // Light from the left (180°): the shadow falls to the right of the shape.
    expect(px(fromLeft, 285, 130)[0]).toBeLessThan(10);
    expect(px(fromLeft, 222, 130)[0]).toBe(0xf0);
  });

  it('paints a document pattern from the sources, and nothing for a missing one', () => {
    const effects = one(fx('pattern-overlay', { patternId: 'doc-1' }));
    const pattern = { id: 'doc-1', name: 'Blue', width: 2, height: 2, data: new Uint8ClampedArray(16).map((_, i) => (i % 4 === 2 || i % 4 === 3 ? 255 : 0)) };
    const out = new RasterCompositor().composite(stack(effects), canvas, { ...sources, pattern: (id) => (id === 'doc-1' ? pattern : null) });
    expect(px(out, 260, 130)).toEqual([0, 0, 255, 255]);
    const missing = new RasterCompositor().composite(stack(effects), canvas, sources);
    expect(px(missing, 260, 130)).toEqual([0xd0, 0x20, 0x20, 255]);
  });

  it('handles an empty layer with effects', () => {
    const layers = stack(one(fx('drop-shadow')));
    (layers[1] as { surface: unknown }).surface = emptySurface(4);
    const out = new RasterCompositor().composite(layers, canvas, sources);
    expect(px(out, 260, 130)).toEqual([0xf0, 0xf0, 0xf0, 255]);
  });

  it('composites a pigment-blended layer with effects like paint, and refuses pigment on an effect', () => {
    const effects = one(fx('stroke', { size: 3 }));
    const out = new RasterCompositor().composite(stack(effects, { blend: 'pigment' } as never), canvas, sources);
    const plain = new RasterCompositor().composite(stack({ enabled: true, items: [] }, { blend: 'pigment' } as never), canvas, sources);
    // Inside the shape the layer mixes as it does without effects.
    expect(px(out, 260, 130)).toEqual(px(plain, 260, 130));
    expect(() => mergeLayerEffect(defaultLayerEffect('satin', 's'), { blend: 'pigment' })).toThrow(/layer blend mode only/);
  });

  describe('incremental effect maps while painting', () => {
    // Effects are built over the layer's bounds, so the scene stays small: 900 × 700 took over
    // 5 s per stack on CI. It still spans 3 × 2 tiles.
    const BIG = { x: 0, y: 0, width: 600, height: 460 };
    const big: RasterSources = { width: 600, height: 460 };
    type Pixel = Extract<RasterLayer, { type: 'pixel' }>;

    /** A round dab with a half-covered rim, as rows of rectangles. */
    function dab(s: Pixel['surface'], cx: number, cy: number, r: number, rgba: number[]) {
      for (let y = -r; y <= r; y++) {
        const half = Math.floor(Math.sqrt(r * r - y * y));
        s = fillRect(s, { x: cx - half - 1, y: cy + y, width: 1, height: 1 }, [...rgba.slice(0, 3), Math.round(rgba[3] / 2)]);
        s = fillRect(s, { x: cx - half, y: cy + y, width: 2 * half + 1, height: 1 }, rgba);
        s = fillRect(s, { x: cx + half + 1, y: cy + y, width: 1, height: 1 }, [...rgba.slice(0, 3), Math.round(rgba[3] / 2)]);
      }
      return s;
    }

    /** Strokes of dabs: across a tile edge, growing the layer's bounds, at the canvas edge, erasing. */
    const STROKES: Array<{ points: Array<[number, number]>; r: number; rgba: number[]; dirty: boolean }> = [
      { points: [[230, 200], [250, 205], [270, 210], [290, 215]], r: 12, rgba: [20, 40, 200, 255], dirty: true },
      { points: [[420, 300], [470, 330], [520, 360]], r: 16, rgba: [200, 200, 20, 180], dirty: true },
      { points: [[530, 380], [550, 405], [570, 430]], r: 10, rgba: [0, 0, 0, 255], dirty: true },
      { points: [[585, 450], [596, 456]], r: 8, rgba: [0, 120, 0, 255], dirty: true },
      { points: [[180, 180], [200, 190]], r: 14, rgba: [0, 0, 0, 0], dirty: true },
      { points: [[300, 120], [320, 125]], r: 6, rgba: [90, 10, 10, 255], dirty: false },
    ];

    const STACKS: Array<[string, LayerEffects]> = [
      // Every local kind, in stacks small enough that none runs near the 5 s timeout on CI ('a drop
      // shadow, a stroke and a bevel' took 3.2 s there as one stack).
      ['a drop shadow and a stroke', { enabled: true, items: [fx('drop-shadow', { distance: 8, size: 10, spread: 0.1 }), fx('stroke', { size: 4, fill: { type: 'color', color: '#0000ff' } })] }],
      ['a bevel', { enabled: true, items: [fx('bevel-emboss', { size: 6, depth: 2 })] }],
      [
        'an inner shadow, an outer and an inner glow',
        {
          enabled: true,
          items: [
            fx('inner-shadow', { distance: 5, size: 7, choke: 0.1 }),
            fx('outer-glow', { technique: 'precise', size: 9 }),
            fx('inner-glow', { size: 8, source: 'center' }),
          ],
        },
      ],
      ['satin', { enabled: true, items: [fx('satin', { distance: 6, size: 8 })] }],
      ['a hard chisel bevel', { enabled: true, items: [fx('bevel-emboss', { technique: 'chisel-hard', size: 7, soften: 1 })] }],
      ['a pillow emboss', { enabled: true, items: [fx('bevel-emboss', { style: 'pillow-emboss', technique: 'chisel-soft', size: 8, soften: 2 })] }],
      [
        'outside and inside strokes',
        {
          enabled: true,
          items: [
            fx('stroke', { size: 22, position: 'outside', fill: { type: 'color', color: '#00ff00' } }),
            fx('stroke', { size: 3, position: 'inside', fill: { type: 'color', color: '#ff00ff' } }),
          ],
        },
      ],
    ];

    it.each(STACKS)('matches a fresh compositor after every stroke with %s', (_name, effects) => {
      let surface = dab(solidSurface(4, { x: 150, y: 150, width: 160, height: 120 }, 0xd02020ff), 330, 160, 20, [200, 30, 30, 255]);
      const layers = (): RasterLayer[] => [
        { type: 'pixel', id: 'bg', name: 'bg', visible: true, opacity: 1, blend: 'normal', surface: solidSurface(4, BIG, 0xf0f0f0ff), offset: { x: 0, y: 0 } },
        { type: 'pixel', id: 'paint', name: 'paint', visible: true, opacity: 1, blend: 'normal', surface, offset: { x: 0, y: 0 }, effects },
      ];
      const c = new RasterCompositor();
      c.composite(layers(), BIG, big, { checkpointLayerId: 'paint' });
      for (const stroke of STROKES) {
        let incremental = new Uint8ClampedArray(0);
        for (const [x, y] of stroke.points) {
          surface = dab(surface, x, y, stroke.r, stroke.rgba);
          const dirty = [{ x: x - stroke.r - 1, y: y - stroke.r, width: 2 * stroke.r + 3, height: 2 * stroke.r + 1 }];
          incremental = c.composite(layers(), BIG, big, { checkpointLayerId: 'paint', dirty: stroke.dirty ? dirty : undefined });
          expect(c.lastStats.effectsPatched).toBe(1);
          expect(c.lastStats.effectsBuilt).toBe(0);
        }
        const fresh = new RasterCompositor().composite(layers(), BIG, big);
        expect(maxDiff(incremental, fresh)).toBe(0);
      }
    });

    it('keeps a neighbouring tile that only reads the change through the margin', () => {
      const c = new RasterCompositor();
      const wide = { x: 0, y: 0, width: 600, height: 280 };
      const src: RasterSources = { width: 600, height: 280 };
      const effects = one(fx('drop-shadow', { distance: 2, size: 6 }));
      // The shape spans both tiles, so tile 1 has pixels of its own.
      let surface = solidSurface(4, { x: 100, y: 100, width: 300, height: 80 }, 0xd02020ff);
      const layers = (): RasterLayer[] => [{ type: 'pixel', id: 'paint', name: 'paint', visible: true, opacity: 1, blend: 'normal', surface, offset: { x: 0, y: 0 }, effects }];
      const tiles = new Map<string, Uint8ClampedArray>();
      c.compositeTiles(layers(), wide, src, (tx, ty, data) => tiles.set(`${tx},${ty}`, data));
      // A dab well inside tile 0: tile 1 reads tile 0 within the margin, but nothing in it changes.
      surface = dab(surface, 150, 140, 6, [0, 0, 0, 255]);
      const changed: string[] = [];
      c.compositeTiles(layers(), wide, src, (tx, ty, data, isNew) => isNew && changed.push(`${tx},${ty}`), { dirty: [{ x: 143, y: 134, width: 15, height: 13 }] });
      expect(changed).toEqual(['0,0']);
      expect(c.lastStats.effectsPatched).toBe(1);
      const out = c.composite(layers(), wide, src);
      expect(maxDiff(out, new RasterCompositor().composite(layers(), wide, src))).toBe(0);
    });

    it('redraws tiles far from the dirty rectangles when an effect is laid out over the layer bounds', () => {
      const c = new RasterCompositor();
      const wide = { x: 0, y: 0, width: 600, height: 280 };
      const src: RasterSources = { width: 600, height: 280 };
      const gradient = { stops: [{ position: 0, color: '#000000' }, { position: 1, color: '#ffffff' }], style: 'linear', angle: 0, scale: 1, reverse: false, align: true, offset: { x: 0, y: 0 } };
      const effects = one(fx('gradient-overlay', { gradient }));
      let surface = solidSurface(4, { x: 20, y: 20, width: 400, height: 200 }, 0xd02020ff);
      const layers = (): RasterLayer[] => [{ type: 'pixel', id: 'paint', name: 'paint', visible: true, opacity: 1, blend: 'normal', surface, offset: { x: 0, y: 0 }, effects }];
      c.composite(layers(), wide, src);
      // Growing the bounds to the right stretches the gradient over tile 0 as well.
      surface = dab(surface, 560, 120, 10, [0, 0, 0, 255]);
      const out = c.composite(layers(), wide, src, { dirty: [{ x: 549, y: 110, width: 23, height: 21 }] });
      expect(maxDiff(out, new RasterCompositor().composite(layers(), wide, src))).toBe(0);
    });

    it('rebuilds the whole region when the effects are not local or the change is large', () => {
      const c = new RasterCompositor();
      let surface = solidSurface(4, { x: 100, y: 100, width: 300, height: 200 }, 0xd02020ff);
      const layers = (effects: LayerEffects): RasterLayer[] => [{ type: 'pixel', id: 'paint', name: 'paint', visible: true, opacity: 1, blend: 'normal', surface, offset: { x: 0, y: 0 }, effects }];
      const noisy = one(fx('drop-shadow', { size: 6, noise: 0.2 }));
      c.composite(layers(noisy), BIG, big);
      surface = dab(surface, 200, 150, 8, [0, 0, 0, 255]);
      const out = c.composite(layers(noisy), BIG, big);
      expect(c.lastStats).toMatchObject({ effectsBuilt: 1, effectsPatched: 0 });
      expect(maxDiff(out, new RasterCompositor().composite(layers(noisy), BIG, big))).toBe(0);
      const shadow = one(fx('drop-shadow', { size: 6 }));
      c.composite(layers(shadow), BIG, big);
      surface = fillRect(surface, { x: 50, y: 50, width: 700, height: 500 }, [10, 10, 10, 255]);
      const large = c.composite(layers(shadow), BIG, big);
      expect(c.lastStats).toMatchObject({ effectsBuilt: 1, effectsPatched: 0 });
      expect(maxDiff(large, new RasterCompositor().composite(layers(shadow), BIG, big))).toBe(0);
    });
  });
});
