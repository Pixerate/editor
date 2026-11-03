import { describe, expect, it } from 'vitest';
import { BRUSH_PRESETS, brushEditorSections, brushLibraryGroups, CANVAS_PROFILE, IMAGE_PROFILE, PAINT_PROFILE, resolveBrush, setBrushEditorValue, type Brush, type BrushEditorControl } from '../src/brushes';

const preset = (id: string) => BRUSH_PRESETS.find((b) => b.id === id)!;
const control = (brush: Brush, path: string, profile = PAINT_PROFILE): BrushEditorControl | undefined => brushEditorSections(brush, profile).flatMap((s) => s.controls).find((c) => c.path === path);

describe('brushEditorSections', () => {
  it('lists the facets of a brush in order, with values from the brush or its engine defaults', () => {
    const sections = brushEditorSections(preset('highlighter'));
    expect(sections.map((s) => s.id)).toEqual(['medium', 'shape', 'marks', 'feel', 'behaviour', 'light', 'colour']);
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

  it("leaves out what the host refuses and notes what it paints without", () => {
    const canvas = brushEditorSections(preset('pencil-6b'), CANVAS_PROFILE);
    expect(canvas.map((s) => s.id)).not.toContain('marks');
    expect(canvas.map((s) => s.id)).not.toContain('light');
    expect(control(preset('pencil-6b'), 'behaviour.surface', CANVAS_PROFILE)).toBeUndefined();
    expect(control(preset('pencil-6b'), 'kind', CANVAS_PROFILE)).toBeUndefined();
    const image = brushEditorSections(preset('pencil-6b'), IMAGE_PROFILE);
    expect(image.find((s) => s.id === 'behaviour')!.controls.find((c) => c.path === 'behaviour.grain')!.note).toBeTruthy();
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
