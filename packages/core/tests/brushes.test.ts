import { describe, expect, it } from 'vitest';
import {
  BRUSH_JSON_SCHEMA,
  BRUSH_PRESETS,
  BRUSH_TOOLS,
  migrateBrushV1,
  normalizeBrushSpec,
  resolveBrush,
  resolveCategory,
  resolveEngine,
  type Brush,
} from '../src/brushes';
import { BUILTIN_BRUSHES, normalizePaintBrush, type PaintBrush, type PaintBrushInput } from '../src/paint-editor/brushes';
import { STAMP_KINDS as RENDERER_STAMPS } from '../src/paint-editor/stickers';
import { DEFAULT_PARTICLE as RENDERER_PARTICLE } from '../src/paint-editor/procedural';
import { DEFAULT_PARTICLE, STAMP_KINDS } from '../src/paint-editor/mark-settings';
import { validateJsonSchema } from '../src/tools/schema';

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('brush presets', () => {
  it('has a facet spec for every built-in brush, in the same order', () => {
    expect(BRUSH_PRESETS.map((b) => b.id)).toEqual(BUILTIN_BRUSHES.map((b) => b.id));
    expect(new Set(BRUSH_PRESETS.map((b) => b.id)).size).toBe(BRUSH_PRESETS.length);
  });

  it.each(BUILTIN_BRUSHES.map((b) => [b.id, b] as const))('%s resolves to the built-in brush', (id, old) => {
    const spec = BRUSH_PRESETS.find((b) => b.id === id)!;
    expect(json(resolveBrush(spec, { builtin: true }))).toEqual(json(old));
  });

  it('gives every mark preset a medium or variety, and every tool a tool', () => {
    for (const b of BRUSH_PRESETS) {
      if (b.kind === 'tool') expect(BRUSH_TOOLS).toContain(b.tool);
      else expect(b.variety, b.id).toBeTruthy();
    }
  });

  it('files the highlighter as fluorescent ink with no spill and a palette', () => {
    const h = BRUSH_PRESETS.find((b) => b.id === 'highlighter')!;
    expect(h).toMatchObject({ kind: 'mark', medium: 'ink', variety: 'highlighter', tip: { shape: 'chisel', blend: 'multiply' }, light: { amount: 0.5, spill: { radius: 0 } } });
    expect(h.colour?.default).toBe('#fff200');
    expect(h.colour?.palette).toHaveLength(4);
    expect(resolveBrush(h).category).toBe('light');
  });

  it('validates every preset against the brush schema', () => {
    for (const b of BRUSH_PRESETS) expect(validateJsonSchema(b, BRUSH_JSON_SCHEMA), b.id).toEqual([]);
  });

  it('normalises every preset to itself, with no problems', () => {
    for (const b of BRUSH_PRESETS) {
      const problems: string[] = [];
      expect(normalizeBrushSpec(json(b), problems), b.id).toEqual(b);
      expect(problems, b.id).toEqual([]);
    }
  });
});

describe('resolveEngine', () => {
  const tip = { shape: 'round' as const };
  it.each([
    [{ kind: 'mark', tip }, 'dab'],
    [{ kind: 'mark', tip, behaviour: { surface: 'wet' } }, 'wet'],
    [{ kind: 'mark', tip, behaviour: { surface: 'thick' } }, 'impasto'],
    [{ kind: 'mark', tip, behaviour: { exchange: { reservoir: {} } } }, 'mixer'],
    [{ kind: 'mark', tip, behaviour: { exchange: { pickup: 0.5 } } }, 'dab'],
    [{ kind: 'mark', tip: { shape: 'bristle' } }, 'bristle'],
    [{ kind: 'mark', tip, marks: { kind: 'particles' } }, 'particle'],
    [{ kind: 'mark', tip: { shape: 'stamp' }, marks: { kind: 'objects' } }, 'sticker'],
    [{ kind: 'tool', tool: 'eraser', tip }, 'eraser'],
    [{ kind: 'tool', tool: 'blender', tip }, 'blender'],
    [{ kind: 'tool', tool: 'smudge', tip }, 'smudge'],
    [{ kind: 'tool', tool: 'blot', tip }, 'wet'],
  ] as const)('%j → %s', (brush, engine) => {
    expect(resolveEngine(brush as unknown as Brush)).toBe(engine);
  });
});

describe('resolveBrush', () => {
  it('fills a bare brush with the plain round dab brush', () => {
    const r = resolveBrush({ id: 'bare', name: 'Bare', kind: 'mark', tip: { shape: 'round' } });
    expect(r).toEqual({ ...normalizePaintBrush({ id: 'bare', name: 'Bare' }), category: 'custom' });
  });

  it('maps each wet tool to its wet engine tool and keeps blenders from loading colour', () => {
    const wet = (tool: Brush['tool']) => resolveBrush({ id: 't', name: 'T', kind: 'tool', tool, tip: { shape: 'round' } });
    expect(wet('water').wet.tool).toBe('water');
    expect(wet('dryer').wet.tool).toBe('dry');
    expect(wet('wet-blend').wet.tool).toBe('blend');
    expect(wet('wet-drag').wet.tool).toBe('smudge');
    expect(wet('blender').loadsColor).toBe(false);
    expect(wet('eraser').loadsColor).toBe(true);
  });

  it('paints the wet medium the variety names unless behaviour.wet.medium says otherwise', () => {
    const base: Brush = { id: 'w', name: 'W', kind: 'mark', medium: 'paint', variety: 'gouache', tip: { shape: 'round' }, behaviour: { surface: 'wet' } };
    expect(resolveBrush(base).wet.medium).toBe('gouache');
    expect(resolveBrush({ ...base, behaviour: { surface: 'wet', wet: { medium: 'oil' } } }).wet.medium).toBe('oil');
    expect(resolveBrush({ ...base, variety: 'ink-wash' }).wet.medium).toBe('watercolor');
    expect(resolveCategory({ ...base, variety: 'oil' })).toBe('oil');
  });

  it('writes the exchange into the Mixer Brush settings and keeps the behaviour in step', () => {
    const r = resolveBrush({ id: 'm', name: 'M', kind: 'mark', tip: { shape: 'round' }, behaviour: { mixing: 'pigment', exchange: { pickup: 0.8, dirty: true, reservoir: { load: 0.3, refill: false, loadsColour: false } } } });
    expect(r.engine).toBe('mixer');
    expect(r.mixer).toEqual({ wet: 0.8, load: 0.3, mix: 0.5, loadEachStroke: false, cleanEachStroke: false, mixing: 'pigment' });
    expect(r.behavior).toMatchObject({ pickup: 0.8, dirty: true, mixing: 'pigment' });
    expect(r.loadsColor).toBe(false);
  });

  it('lays stamps only from stamp tips', () => {
    const particles: Brush = { id: 'p', name: 'P', kind: 'mark', tip: { shape: 'stamp', stamps: ['star', 'ring'] }, marks: { kind: 'particles', render: 'dot', stampOrder: 'random' } };
    expect(resolveBrush(particles).particle).toMatchObject({ dotTextures: ['star', 'ring'], dotTextureOrder: 'random' });
    expect(resolveBrush({ ...particles, tip: { shape: 'round', stamps: ['star'] } }).particle.dotTextures).toEqual([]);
  });

  it('paints a gradient default colour and leaves solid colours to the host', () => {
    const gradient = { type: 'gradient' as const, stops: [{ offset: 0, color: 'paint' }, { offset: 1, color: '#ff0000' }], space: 'pigment' as const, map: { by: 'pressure' as const } };
    const b: Brush = { id: 'g', name: 'G', kind: 'mark', tip: { shape: 'round' }, colour: { default: gradient } };
    expect(resolveBrush(b).paint).toEqual(gradient);
    expect(resolveBrush({ ...b, colour: { default: '#ff0000' } }).paint).toBeNull();
  });

  it('clamps values a brush was never normalised for', () => {
    const r = resolveBrush({ id: 'x', name: 'X', kind: 'mark', tip: { shape: 'round', size: 99999, hardness: -1 }, dynamics: { velocitySize: -5 } });
    expect(r.tip.size).toBe(2500);
    expect(r.tip.hardness).toBe(0);
    expect(r.dynamics.velocitySize).toBe(-1);
  });
});

describe('migrateBrushV1', () => {
  it.each(BUILTIN_BRUSHES.map((b) => [b.id, b] as const))('%s migrates and resolves back unchanged', (_id, old) => {
    const { builtin: _b, ...v1 } = json(old);
    expect(json(resolveBrush(migrateBrushV1(v1 as PaintBrushInput), { builtin: true }))).toEqual(json(old));
  });

  it('migrates every built-in brush to its preset, up to the new medium, variety and hints', () => {
    for (const old of BUILTIN_BRUSHES) {
      const m = migrateBrushV1(old);
      const preset = BRUSH_PRESETS.find((b) => b.id === old.id)!;
      const strip = (b: Brush) => {
        const { medium: _m, variety: _v, light, colour, ...rest } = json(b);
        const l = light ? (({ spill: _s, ...x }) => x)(light) : undefined;
        // Only a gradient default is paint; solid and light / dark defaults are hints the engine form doesn't carry.
        const c = colour?.default && typeof colour.default === 'object' && 'type' in colour.default && colour.default.type === 'gradient' ? { default: colour.default } : undefined;
        return { ...rest, ...(l && Object.keys(l).length ? { light: l } : {}), ...(c ? { colour: c } : {}) };
      };
      expect(strip(m), old.id).toEqual(strip(preset));
    }
  });

  it('stores only what differs from the engine defaults', () => {
    expect(migrateBrushV1({ id: 'plain', name: 'Plain' })).toEqual({ id: 'plain', name: 'Plain', kind: 'mark', tip: { shape: 'round' } });
    expect(migrateBrushV1({ id: 'mx', name: 'Mx', engine: 'mixer' })).toEqual({ id: 'mx', name: 'Mx', kind: 'mark', medium: 'paint', variety: 'mixer', tip: { shape: 'round' }, behaviour: { exchange: { reservoir: {} } } });
  });

  const edgeCases: Array<[string, PaintBrushInput]> = [
    ['a dirty Mixer Brush that only moves paint', { id: 'mx-dry', name: 'Dry mixer', category: 'mixer', engine: 'mixer', loadsColor: false, mixer: { wet: 0.9, load: 0.2, mix: 0.1, loadEachStroke: false, cleanEachStroke: false, mixing: 'pigment' } }],
    ['a dab brush with a dirty pick-up and a random multi-colour', { id: 'dab-mc', name: 'Dab', category: 'paint', behavior: { pickup: 0.3, mix: 0.2, dirty: true, mixing: 'rgb', multicolor: { mode: 'dab', colors: ['#ff0000', '#00ff00'], order: 'random', length: 3 } } }],
    ['a wet oil with every wet setting', { id: 'wet-oil', name: 'Oil', category: 'light', engine: 'wet', wet: { tool: 'paint', medium: 'oil', water: 0.1, pigment: 1, body: 0.9, strength: 0.2, rewet: 0.7, load: 0.5, thinner: 0.4 }, light: { amount: 0.4, pressure: true } }],
    ['a wet blot tool with a strength', { id: 'blot-2', name: 'Blot', category: 'wet-tool', engine: 'wet', wet: { tool: 'blot', strength: 0.95 }, behavior: { pickup: 0.2 } }],
    ['an impasto knife with light', { id: 'knife-2', name: 'Knife', category: 'light', engine: 'impasto', impasto: { tool: 'knife', thickness: 0.1, gloss: 1, metallic: 0.5, load: 0.3, thinner: 0.6, drag: 1, rim: 0.4, clarity: 0.7 }, light: { amount: 0.2 } }],
    ['a particle brush with textured dots and running waves', { id: 'dots', name: 'Dots', category: 'procedural', engine: 'particle', particle: { kind: 'fuzzy', render: 'sequence', count: 64, dotTextures: ['heart', 'heart', 'ring'], dotTextureOrder: 'random', dotRotation: 'follow', waveAmplitude: 0.3, waveSpeed: 0.8, ribbonPairs: 'first-last', gravity: -1 } }],
    ['a sticker brush with one stamp', { id: 'one-stamp', name: 'Rings', category: 'sticker', engine: 'sticker', sticker: { stamps: ['ring'], density: 1, scatter: 2, colorJitter: 0 } }],
    ['a bristle brush on barrel rotation', { id: 'tuft', name: 'Tuft', category: 'bristle', engine: 'bristle', rotation: 'barrel', bristle: { count: 3, stiffness: 1, splay: 0, thickness: 1, load: 1, jitter: 0 } }],
    ['a blender and a smudge with their own mixing', { id: 'blend-rgb', name: 'Blend', category: 'blender', engine: 'blender', loadsColor: false, blender: { strength: 1, distance: 1, mixing: 'rgb' } }],
    ['a smudge with pigment mixing', { id: 'smudge-p', name: 'Smudge', category: 'smudge', engine: 'smudge', loadsColor: false, smudge: { strength: 0.1, length: 1, mixing: 'pigment' } }],
    ['an eraser with jitter and a multiply blend', { id: 'erase-j', name: 'Erase', category: 'eraser', engine: 'eraser', tip: { blend: 'multiply', angle: -45, roundness: 0.2 }, dynamics: { scatter: 4, opacityJitter: 1, velocityOpacity: -1 } }],
  ];

  it.each(edgeCases)('round-trips %s', (_what, raw) => {
    const v1 = normalizePaintBrush(raw);
    const migrated = migrateBrushV1(raw);
    expect(validateJsonSchema(migrated, BRUSH_JSON_SCHEMA)).toEqual([]);
    expect(json(resolveBrush(migrated))).toEqual(json(v1));
  });

  it('drops settings of engine blocks the engine never reads, and derives the category again', () => {
    const raw: PaintBrushInput = { id: 'odd', name: 'Odd', category: 'watercolor', engine: 'dab', mixer: { wet: 0.9 }, impasto: { thickness: 0.1 }, wet: { water: 1 }, particle: { count: 3 } };
    const v1: PaintBrush = normalizePaintBrush(raw);
    const r = resolveBrush(migrateBrushV1(raw));
    const { mixer: _m, impasto: _i, wet: _w, particle: _p, category, ...engineRead } = json(r);
    const { mixer: _m1, impasto: _i1, wet: _w1, particle: _p1, category: _c, ...v1Read } = json(v1);
    expect(engineRead).toEqual(v1Read);
    expect(category).toBe('custom');
    expect(r.mixer.wet).toBe(0.5);
    expect(r.wet.water).toBe(0.5);
  });

  it('reads the chisel, flat and round tip shapes from the ellipse', () => {
    expect(migrateBrushV1({ id: 'a', name: 'A', tip: { angle: 45, roundness: 0.3 } }).tip.shape).toBe('chisel');
    expect(migrateBrushV1({ id: 'a', name: 'A', tip: { angle: -135, roundness: 0.3 } }).tip.shape).toBe('chisel');
    expect(migrateBrushV1({ id: 'a', name: 'A', tip: { angle: 90, roundness: 0.3 } }).tip.shape).toBe('flat');
    expect(migrateBrushV1({ id: 'a', name: 'A', tip: { angle: 90 } }).tip.shape).toBe('round');
  });
});

describe('normalizeBrushSpec', () => {
  it('clamps out-of-range values and reports each fix', () => {
    const problems: string[] = [];
    const b = normalizeBrushSpec(
      {
        id: 'clamp',
        name: '  Clamp  ',
        kind: 'mark',
        tip: { shape: 'bristle', size: 0, spacing: 50, roundness: 0, bristle: { count: 500.4, load: 2 } },
        dynamics: { velocitySize: 3, scatter: -1, smoothing: 1 },
        behaviour: { grain: 1.5 },
        light: { amount: -0.2, spill: { radius: 9999, strength: 3 } },
        motion: { fps: 0.2 },
      },
      problems,
    );
    expect(b.name).toBe('Clamp');
    expect(b.tip).toEqual({ shape: 'bristle', size: 1, spacing: 10, roundness: 0.01, bristle: { count: 128, load: 1 } });
    expect(b.dynamics).toEqual({ velocitySize: 1, scatter: 0, smoothing: 0.95 });
    expect(b.behaviour).toEqual({ grain: 1 });
    expect(b.light).toEqual({ amount: 0, spill: { radius: 512, strength: 2 } });
    expect(b.motion).toEqual({ fps: 1 });
    expect(problems.some((p) => p.includes('brush.tip.size 0 is out of range (1..2500); set to 1'))).toBe(true);
    expect(problems.some((p) => p.includes('brush.tip.bristle.count 500.4 is out of range (3..128, whole); set to 128'))).toBe(true);
    expect(problems).toHaveLength(13);
  });

  it('drops unknown fields, bad enums and invalid colours', () => {
    const problems: string[] = [];
    const b = normalizeBrushSpec(
      {
        id: 'drops',
        name: 'Drops',
        kind: 'mark',
        medium: 'clay',
        engine: 'dab',
        tip: { shape: 'round', blend: 'glow' },
        marks: { kind: 'particles', physics: 'wobble', count: 5, colour: 1 },
        colour: { default: 'red', palette: ['#ff0000', { light: '#ffffff', dark: '#000000' }, 'rgba(0, 0, 0, 0.5)', { type: 'gradient', stops: [] }, '#FF00FF80'] },
      },
      problems,
    );
    expect(b).toEqual({
      id: 'drops',
      name: 'Drops',
      kind: 'mark',
      tip: { shape: 'round' },
      marks: { kind: 'particles', count: 5 },
      colour: { palette: ['#ff0000', { light: '#ffffff', dark: '#000000' }, 'rgba(0, 0, 0, 0.5)', '#ff00ff80'] },
    });
    expect(problems.join('\n')).toMatch(/medium "clay" is not valid; use one of paint, ink, dry, spray/);
    expect(problems.join('\n')).toMatch(/brush\.engine is not a brush field/);
    expect(problems.join('\n')).toMatch(/colour\.default is not a colour/);
    expect(problems.join('\n')).toMatch(/palette\[3\] is not a colour/);
  });

  it('drops facets the brush does not use', () => {
    const problems: string[] = [];
    const b = normalizeBrushSpec(
      {
        id: 'unused',
        name: 'Unused',
        kind: 'tool',
        tool: 'eraser',
        medium: 'ink',
        tip: { shape: 'round', stamps: ['star'], bristle: { count: 4 } },
        marks: { kind: 'continuous' },
        behaviour: { surface: 'wet', wet: { water: 1 }, thick: { gloss: 1 }, strength: 0.5, distance: 0.2, length: 0.4, exchange: { pickup: 1 } },
      },
      problems,
    );
    expect(b).toEqual({ id: 'unused', name: 'Unused', kind: 'tool', tool: 'eraser', tip: { shape: 'round' }, behaviour: {} });
    expect(problems).toHaveLength(11);
  });

  it('turns an objects brush to a stamp tip and keeps wet settings on wet tools', () => {
    const problems: string[] = [];
    expect(normalizeBrushSpec({ id: 's', name: 'S', kind: 'mark', tip: { shape: 'round' }, marks: { kind: 'objects' } }, problems).tip.shape).toBe('stamp');
    expect(normalizeBrushSpec({ id: 'w', name: 'W', tool: 'water', tip: { shape: 'round' }, behaviour: { wet: { water: 0.6 }, strength: 0.4, exchange: { pickup: 0.1 } } }).behaviour).toEqual({ wet: { water: 0.6 }, strength: 0.4, exchange: { pickup: 0.1 } });
  });

  it('reads stamps as sticker refs for objects, particles and continuous stamp tips', () => {
    const problems: string[] = [];
    const objects = normalizeBrushSpec({ id: 'o', name: 'O', kind: 'mark', tip: { shape: 'stamp', stamps: ['star', 'host:cat'] }, marks: { kind: 'objects' } }, problems);
    expect(objects.tip.stamps).toEqual(['editor:star', 'host:cat']);
    expect(resolveBrush(objects).sticker.stamps).toEqual(['editor:star', 'host:cat']);
    // Textured particle dots take library stickers too: the editor's bare in the engine, others as refs.
    const particles = normalizeBrushSpec({ id: 'p', name: 'P', kind: 'mark', tip: { shape: 'stamp', stamps: ['ring', 'host:cat'] }, marks: { kind: 'particles' } }, problems);
    expect(particles.tip.stamps).toEqual(['editor:ring', 'host:cat']);
    expect(resolveBrush(particles).particle.dotTextures).toEqual(['ring', 'host:cat']);
    // A continuous stamp tip lays its first stamp as every dab.
    const tip = normalizeBrushSpec({ id: 't', name: 'T', kind: 'mark', tip: { shape: 'stamp', stamps: ['host:cat', 'editor:star'] } }, problems);
    expect(resolveBrush(tip)).toMatchObject({ engine: 'dab', stamp: 'host:cat' });
    expect(migrateBrushV1(resolveBrush(tip))).toMatchObject({ tip: { shape: 'stamp', stamps: ['host:cat'] } });
    expect(problems).toEqual([]);
  });

  it('sprays droplets with scatter marks, and round trips them through the engine form', () => {
    const spray = normalizeBrushSpec({ id: 's', name: 'S', kind: 'mark', medium: 'spray', tip: { shape: 'round', size: 40 }, marks: { kind: 'scatter', density: 0.8, size: 0.05 } });
    const r = resolveBrush(spray);
    expect(r).toMatchObject({ engine: 'dab', spray: { density: 0.8, size: 0.05 } });
    expect(migrateBrushV1(r)).toMatchObject({ marks: { kind: 'scatter', density: 0.8, size: 0.05 } });
    expect(resolveBrush(normalizeBrushSpec({ id: 'd', name: 'D', kind: 'mark', tip: { shape: 'round' }, marks: { kind: 'scatter' } })).spray).toEqual({ density: 0.5, size: 0.12 });
    const problems: string[] = [];
    expect(normalizeBrushSpec({ id: 'w', name: 'W', kind: 'mark', tip: { shape: 'round' }, marks: { kind: 'scatter' }, behaviour: { surface: 'wet' } }, problems).marks).toBeUndefined();
    expect(problems.join(' ')).toMatch(/wet paint is not sprayed/);
  });

  it('infers the kind from the tool and fills a missing tip', () => {
    const problems: string[] = [];
    expect(normalizeBrushSpec({ id: 'e', name: 'E', tool: 'eraser' }, problems)).toEqual({ id: 'e', name: 'E', kind: 'tool', tool: 'eraser', tip: { shape: 'round' } });
    expect(problems).toEqual(['tip is missing; a round tip is used.']);
  });

  it('refuses a brush it cannot identify, saying what to fix', () => {
    expect(() => normalizeBrushSpec(null)).toThrow(/must be an object/);
    expect(() => normalizeBrushSpec({ id: 'Bad Id', name: 'X' })).toThrow(/lowercase letters, digits and dashes/);
    expect(() => normalizeBrushSpec({ id: 'x', name: '  ' })).toThrow(/needs a name/);
    expect(() => normalizeBrushSpec({ id: 'x', name: 'X', kind: 'brush' })).toThrow(/use mark .* or tool/);
    expect(() => normalizeBrushSpec({ id: 'x', name: 'X', kind: 'tool', tip: { shape: 'round' } })).toThrow(/needs tool: one of eraser, blender/);
  });

  it('normalises what every migrated brush is, so they validate', () => {
    for (const old of BUILTIN_BRUSHES) {
      const m = migrateBrushV1(old);
      const problems: string[] = [];
      expect(normalizeBrushSpec(json(m), problems), old.id).toEqual(m);
      expect(problems, old.id).toEqual([]);
    }
  });
});

describe('brush schema', () => {
  it('refuses out-of-range values, unknown fields and a missing tip shape', () => {
    const errors = validateJsonSchema({ id: 'x', name: 'X', kind: 'mark', tip: { size: 0 }, engine: 'dab' }, BRUSH_JSON_SCHEMA).map((e) => `${e.path} ${e.message}`);
    expect(errors.join('\n')).toMatch(/\/tip/);
    expect(errors.join('\n')).toMatch(/engine/);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it('describes every field', () => {
    const missing: string[] = [];
    const walk = (s: Record<string, unknown>, path: string) => {
      if (!s || typeof s !== 'object') return;
      if (typeof s.description !== 'string' && !path.endsWith('/items')) missing.push(path);
      for (const [k, v] of Object.entries((s.properties as Record<string, Record<string, unknown>>) ?? {})) walk(v, `${path}/${k}`);
      for (const v of (s.oneOf as Record<string, unknown>[]) ?? []) walk(v, `${path}/oneOf`);
      if (s.items) walk(s.items as Record<string, unknown>, `${path}/items`);
      if (s.type === 'object' && s.properties) expect(s.additionalProperties, path).toBe(false);
    };
    walk(BRUSH_JSON_SCHEMA as Record<string, unknown>, '');
    expect(missing).toEqual([]);
  });
});

describe('mark settings split', () => {
  it('re-exports the settings from the renderer modules', () => {
    expect(RENDERER_STAMPS).toBe(STAMP_KINDS);
    expect(RENDERER_PARTICLE).toBe(DEFAULT_PARTICLE);
  });
});
