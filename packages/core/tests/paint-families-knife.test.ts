import { describe, expect, it } from 'vitest';
import { BRUSH_PRESETS, normalizeBrushSpec, resolveBrush, resolveCategory, resolveFamily, type Brush } from '../src/brushes';
import { brushTakesPaint, BUILTIN_BRUSHES, PAINT_BRUSH_CATEGORIES, PAINT_FAMILIES, PAINT_GROUPINGS, paintBrushGroup } from '../src/paint-editor/brushes';
import { PaintEditorController, STICKER_REACH, type PaintPixelLayer } from '../src/paint-editor';
import { readPixel } from '../src/raster/surface';

const preset = (id: string) => BRUSH_PRESETS.find((b) => b.id === id)!;

describe('paint families', () => {
  it('gives every mark preset a family and no tool one', () => {
    for (const b of BRUSH_PRESETS) {
      const family = resolveFamily(b);
      if (b.kind === 'tool' || b.marks?.kind === 'scraper') expect(family, b.id).toBeUndefined();
      else expect(PAINT_FAMILIES, b.id).toContain(family);
    }
  });

  it('files the behaviour families as declared', () => {
    const want: Record<string, string> = {
      'ghost-wash': 'ethereal',
      'invisible-ink': 'ethereal',
      'uv-marker': 'ethereal',
      antimatter: 'volatile',
      whirlpool: 'volatile',
      'wet-vortex': 'volatile',
      foxfire: 'living',
      'turing-wash': 'living',
      'mutation-ink': 'living',
      'ferro-ink': 'reactive',
      'thermo-ink': 'reactive',
      'metallic-paint': 'metallic',
      'soap-film': 'iridescent',
      'hair-strands': 'strands',
      'smoke-ribbon': 'strands',
      'neon-marker': 'glow',
      'glow-gel': 'glow',
      'sticker-confetti': 'stickers',
      'pencil-hb': 'dry',
      'ink-pen': 'ink',
      'spray-can': 'spray',
      'oil-round': 'wet',
      'paint-tube': 'thick',
    };
    for (const [id, family] of Object.entries(want)) expect(resolveFamily(preset(id)), id).toBe(family);
  });

  it('derives a family from the facets when a brush names none', () => {
    const base: Brush = { id: 'b', name: 'B', kind: 'mark', medium: 'paint', tip: { shape: 'round' } };
    expect(resolveFamily(base)).toBe('wet');
    expect(resolveFamily({ ...base, medium: 'ink' })).toBe('ink');
    expect(resolveFamily({ ...base, medium: 'dry' })).toBe('dry');
    expect(resolveFamily({ ...base, marks: { kind: 'scatter' } })).toBe('spray');
    expect(resolveFamily({ ...base, behaviour: { surface: 'thick' } })).toBe('thick');
    expect(resolveFamily({ ...base, behaviour: { surface: 'thick', thick: { metallic: 0.8 } } })).toBe('metallic');
    expect(resolveFamily({ ...base, marks: { kind: 'particles' } })).toBe('strands');
    expect(resolveFamily({ ...base, marks: { kind: 'objects' }, tip: { shape: 'stamp' } })).toBe('stickers');
    expect(resolveFamily({ ...base, light: { amount: 0.7 } })).toBe('glow');
    expect(resolveFamily({ ...base, marks: { kind: 'antimatter' } })).toBe('volatile');
    expect(resolveFamily({ ...base, behaviour: { surface: 'wet' }, ghost: {} })).toBe('ethereal');
    expect(resolveFamily({ ...base, thermochromic: {} })).toBe('reactive');
    expect(resolveFamily({ ...base, culture: {} })).toBe('living');
    // The brush's own family wins.
    expect(resolveFamily({ ...base, family: 'volatile' })).toBe('volatile');
    expect(resolveBrush({ ...base, family: 'glow' }).family).toBe('glow');
  });

  it('drops a family from a tool, keeps a mark one, and refuses an unknown one', () => {
    const problems: string[] = [];
    const tool = normalizeBrushSpec({ id: 't', name: 'T', kind: 'tool', tool: 'blender', family: 'wet', tip: { shape: 'round' } }, problems);
    expect(tool.family).toBeUndefined();
    expect(problems.join(' ')).toContain('family dropped: tools lay no paint');
    expect(normalizeBrushSpec({ id: 'm', name: 'M', kind: 'mark', family: 'living', tip: { shape: 'round' } }).family).toBe('living');
    const bad: string[] = [];
    expect(normalizeBrushSpec({ id: 'm', name: 'M', kind: 'mark', family: 'weird', tip: { shape: 'round' } }, bad).family).toBeUndefined();
    expect(bad.join(' ')).toContain('family');
  });

  it('groups every built-in brush by medium and by family', () => {
    for (const b of BUILTIN_BRUSHES) {
      expect(paintBrushGroup(PAINT_GROUPINGS.byMedium, b), b.id).toBe(b.category);
      expect(paintBrushGroup(PAINT_GROUPINGS.byFamily, b), b.id).toBe(b.family ?? 'tools');
    }
    expect(PAINT_GROUPINGS.byMedium.map((g) => g.id).sort()).toEqual([...PAINT_BRUSH_CATEGORIES].sort());
    expect(PAINT_GROUPINGS.byFamily.map((g) => g.id)).toEqual([...PAINT_FAMILIES, 'tools']);
  });
});

describe('palette knife tool', () => {
  it('is a tool that carries no paint', () => {
    const knife = preset('palette-knife');
    expect(knife).toMatchObject({ kind: 'tool', tool: 'knife' });
    const r = resolveBrush(knife);
    expect(r.engine).toBe('impasto');
    expect(r.impasto.tool).toBe('knife');
    expect(r.loadsColor).toBe(false);
    expect(brushTakesPaint(r)).toBe(false);
    expect(resolveCategory(knife)).toBe('smudge');
    expect(r.family).toBeUndefined();
    expect(brushTakesPaint(resolveBrush(preset('impasto-brush')))).toBe(true);
  });

  it('scrapes thick paint already down and lays none of its own on bare paper', () => {
    const c = new PaintEditorController({ width: 200, height: 120 });
    const line = (y: number) => Array.from({ length: 9 }, (_, i) => ({ x: 20 + i * 20, y, pressure: 0.9 }));
    c.paintStroke({ points: line(60), brushId: 'paint-tube', color: '#f1c40f', seed: 1 });
    const id = c.document.activeLayerId!;
    const along = () => {
      const h = c.document.thick![id].height;
      let s = 0;
      for (let x = 40; x < 160; x++) s += readPixel(h, x, 60)[0];
      return s;
    };
    const before = along();
    c.paintStroke({ points: line(60), brushId: 'palette-knife', color: '#ff0000', seed: 2 });
    expect(along()).toBeLessThan(before * 0.6);
    // Across bare paper the knife adds no colour.
    c.addLayer({ name: 'Bare' });
    const res = c.paintStroke({ points: line(30), brushId: 'palette-knife', color: '#ff0000', seed: 3 });
    expect(res.mixerLoad?.reservoir ?? null).toBeNull();
    const layer = c.getActiveLayer() as PaintPixelLayer;
    for (let x = 30; x < 170; x += 10) expect(readPixel(layer.surface, x, 30)[3], `alpha at ${x}`).toBe(0);
  });
});

describe('sticker brushes at large sizes', () => {
  const wave = Array.from({ length: 25 }, (_, i) => ({ x: 40 + (400 * i) / 24, y: 170 - 110 * Math.sin((i / 24) * Math.PI * 1.5), pressure: 1 }));
  const spray = (size: number) => {
    const c = new PaintEditorController({ width: 480, height: 320 });
    c.addLayer();
    c.setBrush({ id: 'sticker-stars', tip: { size }, sticker: { stamps: ['editor:star'], density: 0.35, scatter: 0.6, sizeJitter: 0, rotationJitter: 0 } });
    c.paintStroke({ points: wave, color: '#e11d48', seed: 21 });
    return c.listStickers();
  };
  const distanceToPath = (x: number, y: number) => {
    let best = Infinity;
    for (let i = 1; i < wave.length; i++) {
      const a = wave[i - 1];
      const b = wave[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, Math.hypot(x - a.x - dx * t, y - a.y - dy * t));
    }
    return best;
  };

  it('keeps spacing and scatter at the reach past it, so 200px stickers trace the path', () => {
    const big = spray(200);
    expect(big.length).toBeGreaterThanOrEqual(10);
    for (const s of big) expect(distanceToPath(s.x, s.y)).toBeLessThanOrEqual(0.6 * STICKER_REACH + 1);
    for (let i = 1; i < big.length; i++) expect(Math.hypot(big[i].x - big[i - 1].x, big[i].y - big[i - 1].y)).toBeLessThan(STICKER_REACH * 2);
  });

  it('starts and ends the stroke with a sticker', () => {
    for (const size of [24, 200]) {
      const list = spray(size);
      const first = list[0];
      const last = list[list.length - 1];
      const reach = 0.6 * Math.min(size, STICKER_REACH) + 1;
      expect(Math.hypot(first.x - wave[0].x, first.y - wave[0].y), `start at ${size}`).toBeLessThanOrEqual(reach);
      expect(Math.hypot(last.x - wave[24].x, last.y - wave[24].y), `end at ${size}`).toBeLessThanOrEqual(reach);
    }
  });
});
