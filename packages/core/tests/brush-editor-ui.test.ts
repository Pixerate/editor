import { describe, expect, it } from 'vitest';
import {
  BRUSH_PRESETS,
  brushEditorScope,
  brushEditorSections,
  brushLibraryGroups,
  CANVAS_PROFILE,
  checkBrush,
  checkBrushEdit,
  createBrushLibrary,
  createBrushLibraryToolProvider,
  IMAGE_PROFILE,
  newBrushFor,
  PAINT_PROFILE,
  resolveBrush,
  saveBrushEdit,
  setBrushEditorValue,
  VECTOR_PROFILE,
  type Brush,
  type BrushEditorControl,
} from '../src/brushes';
import { ToolRegistry } from '../src/tools';

const preset = (id: string) => BRUSH_PRESETS.find((b) => b.id === id)!;
const control = (brush: Brush, path: string, profile = PAINT_PROFILE): BrushEditorControl | undefined => brushEditorSections(brush, profile).flatMap((s) => s.controls).find((c) => c.path === path);

describe('brushEditorSections', () => {
  it('offers the animated-sticker frame mode on sticker brushes only (perform by default)', () => {
    const c = control(preset('sticker-stars'), 'marks.frameMode');
    expect(c).toMatchObject({ kind: 'choice', label: 'Animated frames', ariaLabel: 'Animated sticker frames', value: 'perform' });
    expect(c?.kind === 'choice' ? c.options.map((o) => o.value) : []).toEqual(['perform', 'random']);
    const random = { ...preset('sticker-stars'), marks: { ...preset('sticker-stars').marks, frameMode: 'random' } } as Brush;
    expect(control(random, 'marks.frameMode')).toMatchObject({ value: 'random' });
    expect(control(preset('highlighter'), 'marks.frameMode')).toBeUndefined();
  });

  it('lists the facets of a brush in order, with values from the brush or its engine defaults', () => {
    const sections = brushEditorSections(preset('highlighter'));
    expect(sections.map((s) => s.id)).toEqual(['medium', 'shape', 'grain', 'marks', 'feel', 'behaviour', 'light', 'colour']);
    expect(control(preset('highlighter'), 'tip.size')).toMatchObject({ kind: 'slider', value: 30, min: 1 });
    expect(control(preset('highlighter'), 'tip.blend')).toMatchObject({ kind: 'choice', value: 'multiply', ariaLabel: 'Brush blend' });
    expect(control(preset('highlighter'), 'light.spill.radius')).toMatchObject({ value: 0 });
    expect(control(preset('highlighter'), 'colour.palette')).toMatchObject({ kind: 'palette', max: 16 });
    // Unset values come from the engine the brush resolves to.
    expect(control(preset('pencil-6b'), 'dynamics.rotation')).toMatchObject({ value: resolveBrush(preset('pencil-6b')).rotation, ariaLabel: 'Brush rotation' });
  });

  it('shows each engine its own controls, at facet paths', () => {
    const paths = (id: string) => brushEditorSections(preset(id)).flatMap((s) => s.controls.map((c) => c.path));
    expect(paths('hair-strands')).toEqual(expect.arrayContaining(['marks.physics', 'marks.render', 'marks.count', 'motion.waveSpeed']));
    expect(paths('bristle-round')).toEqual(expect.arrayContaining(['tip.bristle.count', 'tip.bristle.splay']));
    expect(paths('watercolor-wash')).toEqual(expect.arrayContaining(['behaviour.surface', 'behaviour.wet.medium', 'behaviour.wet.water']));
    expect(paths('mixer-brush')).toEqual(expect.arrayContaining(['behaviour.exchange.pickup', 'behaviour.exchange.reservoir.load', 'behaviour.mixing']));
    expect(paths('blender')).toEqual(expect.arrayContaining(['tool', 'behaviour.strength', 'behaviour.distance']));
    expect(paths('blender')).not.toContain('colour.default');
    expect(brushEditorSections(preset('blender')).find((s) => s.id === 'behaviour')!.title).toBe('Blender');
  });

  it('lists only what the host uses: sections, controls and options', () => {
    const canvas = brushEditorSections(preset('pencil-6b'), CANVAS_PROFILE);
    expect(canvas.map((s) => s.id)).not.toContain('marks');
    expect(canvas.map((s) => s.id)).not.toContain('light');
    expect(control(preset('pencil-6b'), 'behaviour.surface', CANVAS_PROFILE)).toBeUndefined();
    expect(control(preset('pencil-6b'), 'kind', CANVAS_PROFILE)).toBeUndefined();
    // Canvas strokes carry no timing: no velocity control. The image editor paints without grain.
    expect(control(preset('pencil-6b'), 'dynamics.velocitySize', CANVAS_PROFILE)).toBeUndefined();
    expect(control(preset('pencil-6b'), 'dynamics.velocitySize')).toBeDefined();
    expect(control(preset('pencil-6b'), 'dynamics.tiltSize', CANVAS_PROFILE)).toBeDefined();
    expect(control(preset('pencil-6b'), 'behaviour.grain', IMAGE_PROFILE)).toBeUndefined();
    expect(control(preset('pencil-6b'), 'behaviour.grain', CANVAS_PROFILE)).toBeDefined();
    // Enum options: tip shapes and tools the host has.
    expect((control(preset('pencil-6b'), 'tip.shape', CANVAS_PROFILE) as { options: Array<{ value: string }> }).options.map((o) => o.value)).toEqual(['round', 'flat', 'chisel']);
    expect((control(preset('eraser-soft'), 'tool', IMAGE_PROFILE) as { options: Array<{ value: string }> }).options.map((o) => o.value)).toEqual(['eraser']);
    // Light brushes paint as plain colour in vector strokes: no light controls there.
    expect(brushEditorSections(preset('highlighter'), VECTOR_PROFILE).map((s) => s.id)).not.toContain('light');
  });

  it("gives what the host can't use no control, so an edit keeps it", () => {
    const wash = preset('watercolor-wash');
    const paths = brushEditorSections(wash, CANVAS_PROFILE).flatMap((s) => s.controls.map((c) => c.path));
    expect(paths).not.toContain('behaviour.wet.water');
    expect(paths).not.toContain('behaviour.wet.medium');
    expect(paths).toContain('tip.size');
    const bristle = brushEditorSections(preset('bristle-round'), CANVAS_PROFILE).flatMap((s) => s.controls.map((c) => c.path));
    expect(bristle).not.toContain('tip.shape');
    expect(bristle).not.toContain('tip.bristle.count');
    // Changing what is shown leaves the rest as it was.
    const edited = setBrushEditorValue(wash, 'tip.size', 33).brush;
    expect(edited.behaviour).toEqual(wash.behaviour);
  });
});

describe('brushEditorScope', () => {
  it("names the facets the host can't use", () => {
    const lit: Brush = { ...preset('ink-pen'), id: 'lit-ink', name: 'Lit ink', light: { amount: 0.6 }, behaviour: { surface: 'wet' }, dynamics: { velocitySize: 0 } };
    expect(brushEditorScope(lit, CANVAS_PROFILE)).toEqual({
      hidden: [
        { facet: 'behaviour.surface', label: 'wet behaviour' },
        { facet: 'light', label: 'light' },
      ],
      note: "Also has wet behaviour and light, which Canvas can't use.",
    });
    expect(brushEditorScope(preset('ink-pen'), CANVAS_PROFILE).note).toBe("Also has velocity dynamics, which Canvas can't use.");
    expect(brushEditorScope(lit, PAINT_PROFILE)).toEqual({ hidden: [], note: null });
    expect(brushEditorScope(preset('bristle-round'), IMAGE_PROFILE).note).toMatch(/a bristle tip/);
  });
});

describe('editing a brush in a limited host', () => {
  const lit: Brush = { ...preset('ink-pen'), id: 'lit-ink', name: 'Lit ink', light: { amount: 0.6, glow: true } };

  it('keeps facets the original had, and refuses ones the edit adds', () => {
    const smaller = setBrushEditorValue(lit, 'tip.size', 4).brush;
    expect(checkBrushEdit(lit, smaller, CANVAS_PROFILE)).toMatchObject({ ok: true, kept: [{ facet: 'light' }] });
    expect(checkBrushEdit(null, smaller, CANVAS_PROFILE).ok).toBe(false);
    const wet = { ...smaller, behaviour: { surface: 'wet' as const } };
    expect(checkBrushEdit(lit, wet, CANVAS_PROFILE)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ facet: 'behaviour.surface', severity: 'error' })]) });
  });

  it('saves to the shared library: a saved brush in place, keeping its light', async () => {
    const library = createBrushLibrary();
    await library.save(lit);
    const r = await saveBrushEdit(library, { original: lit, brush: setBrushEditorValue(lit, 'tip.size', 4).brush, profile: CANVAS_PROFILE });
    expect(r.kept.map((i) => i.facet)).toEqual(['light']);
    expect((await library.get('lit-ink'))!.brush).toMatchObject({ tip: { size: 4 }, light: { amount: 0.6, glow: true } });
  });

  it('saves a copy of a built-in, and "save as" under a new name', async () => {
    const library = createBrushLibrary();
    const pencil = preset('pencil-hb');
    const copy = await saveBrushEdit(library, { original: pencil, brush: setBrushEditorValue(pencil, 'tip.size', 7).brush, profile: IMAGE_PROFILE });
    expect(copy.brush).toMatchObject({ id: 'hb-pencil-copy', name: 'HB pencil copy', tip: { size: 7 } });
    expect(library.isBuiltin('pencil-hb')).toBe(true);
    const again = await saveBrushEdit(library, { original: pencil, brush: pencil, profile: IMAGE_PROFILE });
    expect(again.brush.id).toBe('hb-pencil-copy-2');
    const named = await saveBrushEdit(library, { original: copy.brush, brush: copy.brush, profile: IMAGE_PROFILE, name: 'Sketch pencil' });
    expect(named.brush).toMatchObject({ id: 'sketch-pencil', name: 'Sketch pencil' });
  });

  it('makes a new brush of only what the host uses, which passes its check', async () => {
    const fresh = newBrushFor(CANVAS_PROFILE, { ...preset('watercolor-wash'), dynamics: { velocitySize: 0.4 } });
    expect(fresh).toMatchObject({ id: 'new-brush', name: 'New brush', kind: 'mark' });
    expect(checkBrush(fresh, CANVAS_PROFILE)).toEqual({ ok: true, issues: [] });
    expect(fresh.behaviour?.surface).toBeUndefined();
    expect(checkBrush(newBrushFor(VECTOR_PROFILE, preset('highlighter')), VECTOR_PROFILE).issues).toEqual([]);
    expect(newBrushFor(CANVAS_PROFILE, preset('smudge'))).toMatchObject({ kind: 'mark', tip: { shape: 'round' } });
    const library = createBrushLibrary();
    await expect(saveBrushEdit(library, { original: null, brush: { ...fresh, light: { amount: 1 } }, profile: CANVAS_PROFILE })).rejects.toThrow(/Canvas can't use this brush: light/);
    expect((await saveBrushEdit(library, { original: null, brush: fresh, profile: CANVAS_PROFILE })).brush.id).toBe('new-brush');
  });

  it('agents follow the same rule through update_brush and create_brush', async () => {
    const library = createBrushLibrary();
    await library.save(lit);
    const tools = new ToolRegistry();
    tools.register(createBrushLibraryToolProvider(library, { profile: CANVAS_PROFILE, id: 'canvasbrushes' }));
    const ok = await tools.callTool('canvasbrushes__update_brush', { id: 'lit-ink', tip: { size: 5 } });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ changed: ['tip.size'], kept: [{ facet: 'light', severity: 'error' }] });
    expect((await library.get('lit-ink'))!.brush.light).toEqual({ amount: 0.6, glow: true });
    const adds = await tools.callTool('canvasbrushes__update_brush', { id: 'lit-ink', behaviour: { surface: 'wet' } });
    expect(adds.isError).toBe(true);
    expect((adds.content[0] as { text: string }).text).toMatch(/Canvas can't use this brush: behaviour\.surface: Canvas has no wet surface/);
    expect((await library.get('lit-ink'))!.brush.behaviour?.surface).toBeUndefined();
    const created = await tools.callTool('canvasbrushes__create_brush', { id: 'new-lit', name: 'New lit', basedOn: 'lit-ink' });
    expect(created.isError).toBe(true);
    expect((created.content[0] as { text: string }).text).toMatch(/light: Canvas can't paint light paint/);
  });
});

describe('colour controls', () => {
  it('shows a light / dark default and palette pairs, and a gradient default as such', () => {
    expect(control(preset('chalk'), 'colour.default')).toMatchObject({ kind: 'colour', value: '#475569', dark: '#f8fafc', gradient: false });
    expect(control(preset('chalk'), 'colour.palette')).toMatchObject({ value: [{ light: '#475569', dark: '#f8fafc' }, '#fca5a5', '#fde68a', '#93c5fd'] });
    expect(control(preset('highlighter'), 'colour.default')).toMatchObject({ value: '#fff200', dark: null });
    expect(control(preset('gradient-round'), 'colour.default')).toMatchObject({ value: null, gradient: true });
    const pairs = setBrushEditorValue(preset('ballpoint'), 'colour.default', { light: '#1e3a8a', dark: '#93c5fd' }).brush;
    expect(pairs.colour!.default).toEqual({ light: '#1e3a8a', dark: '#93c5fd' });
  });
});

describe('setBrushEditorValue', () => {
  it('sets a value and normalises the brush', () => {
    const r = setBrushEditorValue(preset('highlighter'), 'tip.size', 12);
    expect(r).toMatchObject({ problems: [], brush: { tip: { size: 12 }, variety: 'highlighter' } });
    expect(setBrushEditorValue(preset('highlighter'), 'tip.size', 99999).brush.tip.size).toBe(2500);
    expect(setBrushEditorValue(preset('highlighter'), 'colour.palette', ['#ff6ec7']).brush.colour!.palette).toEqual(['#ff6ec7']);
    expect(setBrushEditorValue(preset('highlighter'), 'variety', '').brush.variety).toBeUndefined();
  });

  it('starts the marks, the kind and the tip shape afresh when they change', () => {
    const toParticles = setBrushEditorValue(preset('ink-pen'), 'marks.kind', 'particles').brush;
    expect(resolveBrush(toParticles).engine).toBe('particle');
    expect(resolveBrush(setBrushEditorValue(toParticles, 'marks.kind', 'continuous').brush).engine).toBe('dab');
    const tool = setBrushEditorValue(preset('ink-pen'), 'kind', 'tool').brush;
    expect(tool).toMatchObject({ kind: 'tool', tool: 'eraser' });
    expect(tool.medium).toBeUndefined();
    expect(setBrushEditorValue(preset('bristle-round'), 'tip.shape', 'round').brush.tip.bristle).toBeUndefined();
  });
});

describe('brushLibraryGroups', () => {
  const entries = BRUSH_PRESETS.map((brush) => ({ brush, builtin: true }));
  it('groups marks by medium then variety, tools apart, in a stable order', () => {
    const groups = brushLibraryGroups(entries);
    expect(groups.map((g) => g.id)).toEqual(['dry', 'ink', 'paint', 'spray', 'other', 'tools']);
    expect(groups.flatMap((g) => g.varieties.flatMap((v) => v.entries))).toHaveLength(entries.length);
    expect(groups.find((g) => g.id === 'ink')!.varieties.find((v) => v.variety === 'highlighter')!.entries.map((e) => e.brush.id)).toEqual(['highlighter']);
    expect(groups.at(-1)!.varieties[0].entries.every((e) => e.brush.kind === 'tool')).toBe(true);
  });

  it('filters by words, source and host', () => {
    expect(brushLibraryGroups(entries, { text: 'high' }).flatMap((g) => g.varieties.flatMap((v) => v.entries.map((e) => e.brush.id)))).toEqual(['highlighter']);
    expect(brushLibraryGroups(entries, { source: 'user' })).toEqual([]);
    const canvas = brushLibraryGroups(entries, { profile: CANVAS_PROFILE }).flatMap((g) => g.varieties.flatMap((v) => v.entries));
    expect(canvas.every((e) => e.brush.kind === 'mark' && e.brush.marks === undefined)).toBe(true);
  });
});
