import { describe, expect, it } from 'vitest';
import { checkEffectProvider, createFakeEffectProvider, createPixelEffectProvider, effectPaintHintProblems, effectSuitsPaint, type EffectDescription, type EffectProvider } from '../src/effects';
import { PaintEditorController, createPaintEditorToolProvider, createPaintEffectAuthoringToolProvider, createPaintEffectsToolProvider, effectPaintFromHint, paintEffectOffered } from '../src/paint-editor';
import { ToolRegistry } from '../src/tools/registry';

function setup(paintHints = true) {
  const c = new PaintEditorController({ width: 32, height: 16, paper: 'smooth', authoredEffects: 'author' });
  c.setEffectsProvider(createFakeEffectProvider({ paintHints }));
  const reg = new ToolRegistry({ validateArguments: true });
  reg.register(createPaintEditorToolProvider(c));
  reg.register(createPaintEffectsToolProvider(c));
  reg.register(createPaintEffectAuthoringToolProvider(c));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await reg.callTool(name, args);
    if (r.isError) throw new Error((r.content[0] as { text: string }).text);
    return r.structuredContent as Record<string, any>;
  };
  const fail = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await reg.callTool(name, args);
    expect(r.isError, `${name} should fail`).toBe(true);
    return (r.content[0] as { text: string }).text;
  };
  return { c, call, fail };
}

const ids = (effects: { id: string }[]) => effects.map((e) => e.id).sort();

describe('paint hints: the contract', () => {
  it('the fake provider with paint hints passes checkEffectProvider', async () => {
    expect(await checkEffectProvider(createFakeEffectProvider({ paintHints: true }), { render: false })).toEqual([]);
    const caps = createFakeEffectProvider({ paintHints: true }).capabilities;
    expect(caps.paintHints).toBe(true);
    expect(createFakeEffectProvider().capabilities.paintHints).toBeUndefined();
  });

  it('flags hints that name missing or non-colour controls, a path map without a path control, and bad shapes', async () => {
    const gradient = (await createFakeEffectProvider().describe('fake.gradient')) as EffectDescription;
    const at = (paint: unknown) => effectPaintHintProblems({ ...gradient, paint: paint as never });
    expect(at({ map: 'stroke', colors: ['from', 'to'] })).toEqual([]);
    expect(at({ map: 'stroke', colors: ['nope'] })).toEqual(['paint.colors names "nope", which is not a control']);
    expect(at({ map: 'stroke', colors: ['angle'] })).toEqual(['paint.colors names "angle", which does not take a "#rrggbb" colour']);
    expect(at({ map: 'path' })).toEqual(['paint.map is "path", but no control takes a path (format "svg-path"); use "stroke" or "canvas"']);
    expect(at({ map: 'canvas', values: { angle: 999 } })[0]).toMatch(/^paint\.values \/angle: /);
    expect(at({ map: 'sideways', colors: ['a', 'b', 'c'], live: 'yes', repeat: 'loop', size: -1, extra: 1 })).toEqual([
      'paint.extra is not a paint hint field (map, colors, values, live, repeat, size)',
      'paint.map must be "path", "stroke", "canvas"',
      'paint.colors names 3 controls; at most 2 (the main colour, then the second)',
      'paint.live must be true or false',
      'paint.repeat must be "repeat", "mirror", "clamp"',
      'paint.size must be a brush width in px above 0',
    ]);
  });

  it('checkEffectProvider reports a bad hint, a capability that is not a boolean, and summaries without the hint', async () => {
    const base = createFakeEffectProvider({ paintHints: true });
    const broken: EffectProvider = {
      ...base,
      capabilities: { ...base.capabilities, paintHints: 'yes' as never },
      list: async (o) => (await base.list(o)).map(({ paint: _p, ...s }) => s),
      search: async (q, o) => (await base.search(q, o)).map(({ paint: _p, ...s }) => s),
      describe: async (id) => {
        const d = await base.describe(id);
        return id === 'fake.bar' ? { ...d, paint: { map: 'canvas', colors: ['colour'] } } : d;
      },
    };
    const issues = (await checkEffectProvider(broken, { render: false })).map((i) => `${i.effectId ?? ''}: ${i.message}`);
    expect(issues).toContain(': capabilities.paintHints is not a boolean');
    expect(issues).toContain('fake.bar: paint.colors names "colour", which is not a control');
    expect(issues.some((i) => i.startsWith('fake.gradient: list() and describe() give different paint hints'))).toBe(true);
  });

  it('effectSuitsPaint and paintEffectOffered follow the capability; authored effects always suit paint', () => {
    expect(effectSuitsPaint({}, { paintHints: true })).toBe(false);
    expect(effectSuitsPaint({ paint: { map: 'canvas' } }, { paintHints: true })).toBe(true);
    expect(effectSuitsPaint({}, {})).toBe(true);
    const bar = { id: 'fake.bar', kind: 'shader' as const, uses: ['title', 'overlay'] as const };
    expect(paintEffectOffered(bar, 'paint', { paintHints: true })).toBe(false);
    expect(paintEffectOffered(bar, 'layer', { paintHints: true })).toBe(true);
    expect(paintEffectOffered(bar, 'paint', {})).toBe(true);
    expect(paintEffectOffered({ ...bar, id: 'authored.bar' }, 'paint', { paintHints: true })).toBe(true);
  });

  it('effectPaintFromHint maps, colours and live', () => {
    expect(effectPaintFromHint({ map: 'stroke', colors: ['from', 'to'], values: { angle: 0 }, live: true }, { color: '#112233', secondaryColor: '#445566' })).toEqual({
      map: { by: 'stroke', repeat: 'mirror' },
      values: { angle: 0, from: '#112233', to: '#445566' },
      live: true,
    });
    expect(effectPaintFromHint({ map: 'path', colors: ['color'] }, { color: '#112233', secondaryColor: '#445566' })).toEqual({ map: { by: 'path' }, values: { color: '#112233' }, live: false });
  });
});

describe('paint hints: the paint place', () => {
  it('the paint browser list keeps only hinted effects; other places keep every effect they take', async () => {
    const p = createFakeEffectProvider({ paintHints: true });
    const list = await p.list();
    expect(ids(list.filter((e) => paintEffectOffered(e, 'paint', p.capabilities)))).toEqual(['fake.gradient', 'fake.trail']);
    expect(ids(list.filter((e) => paintEffectOffered(e, 'layer', p.capabilities)))).toEqual(['fake.bar', 'fake.gradient', 'fake.trail']);
    const plain = createFakeEffectProvider();
    expect(ids((await plain.list()).filter((e) => paintEffectOffered(e, 'paint', plain.capabilities)))).toEqual(['fake.bar', 'fake.gradient', 'fake.trail']);
  });

  it('search_effects with place paint returns only hinted effects, with their hints', async () => {
    const { call } = setup();
    const r = await call('search_effects', { place: 'paint' });
    expect(ids(r.effects)).toEqual(['fake.gradient', 'fake.trail']);
    expect(r.effects.find((e: { id: string }) => e.id === 'fake.trail').paint).toEqual({ map: 'path', colors: ['color'], values: { width: 4 } });
    expect(ids((await call('search_effects', { place: 'layer' })).effects)).toEqual(['fake.bar', 'fake.gradient', 'fake.trail']);
    expect(ids((await call('search_effects', { place: 'light' })).effects)).toEqual(['fake.invert', 'fake.tint']);
    const plain = setup(false);
    expect(ids((await plain.call('search_effects', { place: 'paint' })).effects)).toEqual(['fake.bar', 'fake.gradient', 'fake.trail']);
  });

  it('set_effect_paint refuses an unhinted effect, saying why and what to use; layers and fills still take it', async () => {
    const { call, fail } = setup();
    expect(await fail('set_effect_paint', { effect: 'fake.bar' })).toBe(
      '"fake.bar" (Lower-third bar) doesn\'t work as paint: its provider marks the effects that do with a paint hint, and this one has none, so painting with it would only reveal a still frame of something meant to be seen whole. Add it as an effect layer (add_effect_layer) or fill a layer with it (fill_layer_with_effect) instead, or paint with an effect from search_effects with place "paint".',
    );
    expect((await call('add_effect_layer', { effect: 'fake.bar' })).effects[0].effect).toBe('fake.bar');
    const plain = setup(false);
    expect((await plain.call('set_effect_paint', { effect: 'fake.bar' })).effectPaint.effect).toBe('fake.bar');
  });
});

describe('paint hints: picking a hinted effect starts from its hint', () => {
  it('applies the hint map, repeat, values, the two colours and live', async () => {
    const { call } = setup();
    await call('set_color', { color: '#ff0000', secondaryColor: '#0000ff' });
    const p = (await call('set_effect_paint', { effect: 'fake.gradient' })).effectPaint;
    expect(p).toMatchObject({ map: { by: 'stroke', length: 300, repeat: 'mirror' }, live: true, values: { from: '#ff0000', to: '#0000ff', angle: 0, spin: 0, opacity: 1 } });
    const trail = (await call('set_effect_paint', { effect: 'fake.trail' })).effectPaint;
    expect(trail).toMatchObject({ map: { by: 'path' }, values: { color: '#ff0000', width: 4, path: '' } });
    expect(trail.live).toBeUndefined();
  });

  it('explicit map, values and live win, control by control', async () => {
    const { call } = setup();
    await call('set_color', { color: '#ff0000', secondaryColor: '#0000ff' });
    const p = (await call('set_effect_paint', { effect: 'fake.gradient', map: { by: 'canvas' }, values: { to: '#00ff00', angle: 45 }, live: false })).effectPaint;
    expect(p.map).toBeUndefined();
    expect(p.live).toBeUndefined();
    expect(p.values).toMatchObject({ from: '#ff0000', to: '#00ff00', angle: 45 });
  });

  it('update_effect on the paint keeps its map and live instead of going back to the hint', async () => {
    const { call } = setup();
    await call('set_effect_paint', { effect: 'fake.gradient', map: { by: 'canvas' }, live: false });
    const r = await call('update_effect', { target: 'paint', effect: 'paint', values: { angle: 30 } });
    expect(r.effect.map).toBeUndefined();
    expect(r.effect.live).toBeUndefined();
    expect(r.effect.values.angle).toBe(30);
  });
});

describe('paint hints: authored effects', () => {
  it('pixel templates carry a hint, and a saved authored effect keeps it and paints from it', async () => {
    expect((await createPixelEffectProvider().describe('pixel.rings')).paint).toEqual({ map: 'canvas', colors: ['ink'], live: true });
    const { call } = setup();
    await call('open_effect_authoring', { effect: 'pixel.blank' });
    expect((await call('effect_authoring_describe')).paint).toEqual({ map: 'stroke', colors: ['top', 'bottom'], repeat: 'mirror' });
    const saved = await call('save_authored_effect', { name: 'Wash' });
    expect((await call('describe_effect', { effect: saved.id })).paint).toEqual({ map: 'stroke', colors: ['top', 'bottom'], repeat: 'mirror' });
    await call('set_color', { color: '#ff0000', secondaryColor: '#0000ff' });
    const p = (await call('set_effect_paint', { effect: saved.id })).effectPaint;
    expect(p).toMatchObject({ map: { by: 'stroke', repeat: 'mirror' }, values: { top: '#ff0000', bottom: '#0000ff' } });
  });

  it('effect_authoring_set_paint_hint sets, refuses and removes the hint (one undo step each)', async () => {
    const { call, fail } = setup();
    await call('open_effect_authoring', { effect: 'pixel.clouds' });
    expect(await fail('effect_authoring_set_paint_hint', { paint: { map: 'canvas', colors: ['ink'] } })).toBe('paint.colors names "ink", which is not a control');
    expect(await fail('effect_authoring_set_paint_hint', { paint: { map: 'path' } })).toBe('paint.map is "path", but no control takes a path (format "svg-path"); use "stroke" or "canvas"');
    expect(await call('effect_authoring_set_paint_hint', { paint: { map: 'stroke', colors: ['sky'], repeat: 'clamp' } })).toEqual({ paint: { map: 'stroke', colors: ['sky'], repeat: 'clamp' } });
    await call('effect_authoring_undo');
    expect((await call('effect_authoring_describe')).paint).toEqual({ map: 'canvas', colors: ['cloud', 'sky'], live: true });
    expect(await call('effect_authoring_set_paint_hint', { paint: null })).toEqual({ paint: null });
    const saved = await call('save_authored_effect', { name: 'Plain clouds' });
    expect((await call('describe_effect', { effect: saved.id })).paint).toBeUndefined();
  });

  it('a source edit keeps the hint while its controls are still there', async () => {
    const { call } = setup();
    await call('open_effect_authoring', { effect: 'pixel.rings' });
    await call('effect_authoring_set_source', { source: 'control ink: color = #ff0000 // Ink.\nout = vec4(ink, uv.x)' });
    expect((await call('effect_authoring_describe')).paint).toEqual({ map: 'canvas', colors: ['ink'], live: true });
    await call('effect_authoring_set_source', { source: 'control tone: color = #ff0000 // Tone.\nout = tone' });
    expect((await call('effect_authoring_describe')).paint).toBeNull();
  });

  it('a document with a bad hint is refused when opened', async () => {
    const p = createPixelEffectProvider();
    const s = await p.openAuthoring!({ effectId: 'pixel.blank' });
    const doc = s.exportDocument();
    expect(doc.paint).toEqual({ map: 'stroke', colors: ['top', 'bottom'], repeat: 'mirror' });
    await expect(Promise.resolve(p.openAuthoring!({ document: { ...doc, paint: { map: 'stroke', colors: ['nope'] } } }))).rejects.toThrow(/\/paint: colors names "nope", which is not a control/);
    const reopened = await p.openAuthoring!({ document: { ...doc, paint: undefined } });
    expect(reopened.getState().description.paint).toBeUndefined();
  });
});
