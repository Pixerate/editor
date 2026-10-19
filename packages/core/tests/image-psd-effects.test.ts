import { describe, expect, it } from 'vitest';
import {
  ImageEditorController,
  defaultLayerEffect,
  effectsFingerprint,
  mergeLayerEffect,
  type LayerEffect,
  type LayerEffectKind,
  type LayerEffects,
} from '../src/image-editor';
import { PsdWriter } from '../src/image-editor/psd/binary';
import { descriptor, parseVersionedDescriptor, versionedDescriptorBytes, type DescValue } from '../src/image-editor/psd/descriptor';
import { parseLfx2, parseLrfx, writeLfx2 } from '../src/image-editor/psd/effects';
import { layerBlock, readPsd, writePsd } from '../src/image-editor/psd/file';
import { parsePatternBlock, psdPatternToEffectPattern, writePatternBlock } from '../src/image-editor/psd/patterns';
import { encodeLegacyName } from '../src/image-editor/psd/binary';

const W = 48;
const H = 32;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(230) });
  const id = c.addPixelLayer({ name: 'Shape' });
  c.selectRect({ x: 12, y: 8, width: 20, height: 14 });
  c.fillPixels({ color: '#c03020' });
  c.deselect();
  return { c, id };
}

const fx = (kind: LayerEffectKind, changes: Record<string, unknown> = {}): LayerEffect => mergeLayerEffect(defaultLayerEffect(kind, kind), changes);

const GRADIENT = {
  stops: [
    { position: 0, color: '#ff0000' },
    { position: 1, color: '#0000ff' },
  ],
  opacityStops: [
    { position: 0, opacity: 1 },
    { position: 1, opacity: 0.5 },
  ],
  style: 'reflected',
  angle: 30,
  scale: 0.8,
  reverse: true,
  align: false,
  offset: { x: 0.1, y: -0.2 },
};

/** One configuration per effect kind, away from Photoshop's defaults. */
const PER_KIND: LayerEffect[] = [
  fx('drop-shadow', { color: '#102030', distance: 9, spread: 0.25, size: 7, angle: 45, useGlobalLight: false, noise: 0.1, antiAlias: true, knocksOut: false, contour: { name: 'Cone', points: [{ input: 0, output: 0 }, { input: 0.5, output: 1, corner: true }, { input: 1, output: 0 }] } }),
  fx('inner-shadow', { choke: 0.3, blend: 'overlay', opacity: 0.4 }),
  fx('outer-glow', { technique: 'precise', spread: 0.1, size: 8, range: 0.7, fill: { type: 'color', color: '#ffff00' } }),
  fx('inner-glow', { source: 'center', choke: 0.2, fill: { type: 'gradient', gradient: GRADIENT } }),
  fx('bevel-emboss', {
    style: 'emboss',
    technique: 'chisel-soft',
    depth: 1.5,
    direction: 'down',
    size: 7,
    soften: 2,
    angle: 45,
    altitude: 40,
    useGlobalLight: false,
    highlightBlend: 'linear-dodge',
    shadowOpacity: 0.6,
    contourElement: { contour: { name: 'Half', points: [{ input: 0, output: 0 }, { input: 1, output: 0.5 }] }, range: 0.7, antiAlias: true },
    texture: { patternId: 'dots', name: 'Dots', scale: 0.5, depth: -2, invert: true, link: false, phase: { x: 3, y: 1 } },
  }),
  fx('satin', { distance: 6, size: 9, invert: false, color: '#334455' }),
  fx('color-overlay', { color: '#00ff80', blend: 'color', opacity: 0.5 }),
  fx('gradient-overlay', { gradient: GRADIENT, dither: true }),
  fx('pattern-overlay', { patternId: 'stripes', name: 'Diagonal Stripes', scale: 2, angle: 15, link: false, phase: { x: 4, y: 2 } }),
  fx('stroke', { size: 4, position: 'center', blend: 'multiply', opacity: 0.7, fill: { type: 'pattern', patternId: 'checker', name: 'Checker', scale: 1.5 } }),
];

const effectsOf = (items: LayerEffect[], extra: Partial<LayerEffects> = {}): LayerEffects => ({ enabled: true, items, ...extra });

describe('lfx2 mapping', () => {
  it.each(PER_KIND.map((e) => [e.kind, e] as const))('round-trips %s exactly', (_kind, effect) => {
    const effects = effectsOf([effect]);
    const back = parseLfx2(writeLfx2(effects).data)!;
    expect(back.notes).toEqual([]);
    expect(effectsFingerprint(back.effects)).toBe(effectsFingerprint(effects));
  });

  it('keeps several instances of a kind in its multi key, the master switch and Scale Effects', () => {
    const effects = effectsOf([fx('drop-shadow', { distance: 3 }), fx('drop-shadow', { distance: 12 }), fx('stroke', { size: 2 }), fx('stroke', { size: 6 }), fx('color-overlay')], { enabled: false, scale: 1.5 });
    const { data, dropped } = writeLfx2(effects);
    expect(dropped).toBe(0);
    expect(data.length % 2).toBe(0);
    const d = parseVersionedDescriptor(data.subarray(4));
    const keys = d.items.map(([k]) => k);
    expect(keys).toEqual(expect.arrayContaining(['dropShadowMulti', 'frameFXMulti', 'SoFi', 'masterFXSwitch']));
    const back = parseLfx2(data)!;
    expect(back.effects.enabled).toBe(false);
    // Scale Effects is baked into the sizes; `Scl ` is not read back as a multiplier.
    expect(back.effects.scale).toBeUndefined();
    // Canonical kind order: shadows first, strokes last; instances keep their order.
    expect(back.effects.items.map((e) => [e.kind, (e as { distance?: number }).distance ?? (e as { size?: number }).size ?? null])).toEqual([
      ['drop-shadow', 4.5],
      ['drop-shadow', 18],
      ['color-overlay', null],
      ['stroke', 3],
      ['stroke', 9],
    ]);
  });

  it('keeps only the first instance of kinds without a multi key, and says how many were dropped', () => {
    expect(writeLfx2(effectsOf([fx('satin'), fx('satin', { size: 3 })])).dropped).toBe(1);
  });

  it('skips absent effects, keeps disabled ones, and reads long blend ids and other colour models', () => {
    const color = (classId: string, items: Array<[string, number]>): DescValue => ({ type: 'Objc', value: descriptor(classId, items.map(([k, v]) => [k, { type: 'doub', value: v }])) });
    const d = descriptor('null', [
      // 150 ppi: Photoshop records 208.33 % here, but the sizes are pixels already.
      ['Scl ', { type: 'UntF', unit: '#Prc', value: 208.33 }],
      ['masterFXSwitch', { type: 'bool', value: true }],
      ['DrSh', { type: 'Objc', value: descriptor('DrSh', [['present', { type: 'bool', value: false }]]) }],
      ['SoFi', { type: 'Objc', value: descriptor('SoFi', [['enab', { type: 'bool', value: false }], ['Md  ', { type: 'enum', typeId: 'BlnM', value: 'linearBurn' }], ['Clr ', color('Grsc', [['Gry ', 100]])]]) }],
      ['ChFX', { type: 'Objc', value: descriptor('ChFX', [['Md  ', { type: 'enum', typeId: 'BlnM', value: 'colorDodge' }], ['Clr ', color('CMYC', [['Cyn ', 0], ['Mgnt', 0], ['Ylw ', 0], ['Blck', 0]])]]) }],
    ]);
    const w = new PsdWriter();
    w.u32(0);
    w.bytes(versionedDescriptorBytes(d));
    const back = parseLfx2(w.result())!;
    expect(back.effects.items.map((e) => e.kind)).toEqual(['satin', 'color-overlay']);
    expect(back.effects.scale).toBeUndefined();
    expect(back.effects.items[1]).toMatchObject({ enabled: false, blend: 'linear-burn', color: '#000000' });
    expect(back.effects.items[0]).toMatchObject({ blend: 'color-dodge', color: '#ffffff' });
  });

  it('notes what it approximates: midpoints, smoothness, noise gradients, dissolve, jitter', () => {
    const stop = (pos: number, mid: number, r: number): DescValue => ({
      type: 'Objc',
      value: descriptor('Clrt', [
        ['Clr ', { type: 'Objc', value: descriptor('RGBC', [['Rd  ', { type: 'doub', value: r }], ['Grn ', { type: 'doub', value: 0 }], ['Bl  ', { type: 'doub', value: 0 }]]) }],
        ['Lctn', { type: 'long', value: pos }],
        ['Mdpn', { type: 'long', value: mid }],
      ]),
    });
    const grad = descriptor('Grdn', [['Intr', { type: 'doub', value: 4096 }], ['Clrs', { type: 'VlLs', items: [stop(0, 50, 0), stop(4096, 25, 255)] }]]);
    const d = descriptor('null', [
      ['GrFl', { type: 'Objc', value: descriptor('GrFl', [['Grad', { type: 'Objc', value: grad }]]) }],
      ['OrGl', { type: 'Objc', value: descriptor('OrGl', [['Md  ', { type: 'enum', typeId: 'BlnM', value: 'Dslv' }], ['ShdN', { type: 'UntF', unit: '#Prc', value: 20 }]]) }],
    ]);
    const w = new PsdWriter();
    w.u32(0);
    w.bytes(versionedDescriptorBytes(d));
    const back = parseLfx2(w.result())!;
    expect(back.notes).toEqual(expect.arrayContaining(['gradient midpoints are drawn as straight segments', 'gradient smoothness is drawn as straight segments', 'Dissolve became Normal', 'glow jitter is not drawn']));
    const g = back.effects.items.find((e) => e.kind === 'gradient-overlay') as Extract<LayerEffect, { kind: 'gradient-overlay' }>;
    // The 25 % midpoint became a half-way stop a quarter of the way along.
    expect(g.gradient.stops.map((s) => s.position)).toEqual([0, 0.25, 1]);
    expect(g.gradient.stops[1].color).toBe('#800000');
  });

  it('returns null for data that is not a descriptor', () => {
    expect(parseLfx2(new Uint8Array([0, 0, 0, 0, 1, 2]))).toBeNull();
  });

  it('reads a legacy lrFX drop shadow', () => {
    const w = new PsdWriter();
    w.u16(0);
    w.u16(1);
    w.ascii('8BIM');
    w.ascii('dsdw');
    const rec = new PsdWriter();
    rec.u32(2);
    rec.u32(7 << 16);
    rec.u32(0);
    rec.u32(90 << 16);
    rec.u32(4 << 16);
    rec.bytes([0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0]);
    rec.ascii('8BIM');
    rec.ascii('mul ');
    rec.bytes([1, 1, 128]);
    rec.bytes(new Uint8Array(10));
    const r = rec.result();
    w.u32(r.length);
    w.bytes(r);
    const back = parseLrfx(w.result())!;
    expect(back.effects.items[0]).toMatchObject({ kind: 'drop-shadow', size: 7, distance: 4, angle: 90, blend: 'multiply', color: '#ff0000', useGlobalLight: true });
    expect((back.effects.items[0] as { opacity: number }).opacity).toBeCloseTo(128 / 255);
  });
});

describe('patterns', () => {
  it('round-trips pattern blocks, with and without transparency', () => {
    const solid = { id: 'a-1', name: 'Solid', width: 3, height: 2, data: new Uint8ClampedArray(24).map((_, i) => (i % 4 === 3 ? 255 : i * 9)) };
    const clear = { id: 'b-2', name: 'Clear', width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 9, 9, 9, 255]) };
    const back = parsePatternBlock(writePatternBlock([solid, clear])).map(psdPatternToEffectPattern);
    expect(back.map((p) => [p.id, p.name, p.width, p.height])).toEqual([
      ['a-1', 'Solid', 3, 2],
      ['b-2', 'Clear', 2, 2],
    ]);
    expect(Array.from(back[0].data)).toEqual(Array.from(solid.data));
    expect(Array.from(back[1].data.filter((_, i) => i % 4 === 3))).toEqual([255, 128, 0, 255]);
  });
});

describe('PSD files with layer effects', () => {
  it('round-trips every kind of effect through a PSD and renders the same', async () => {
    const { c, id } = setup();
    c.setLayerEffects(id, effectsOf(PER_KIND.filter((e) => e.kind !== 'gradient-overlay')));
    c.setGlobalLight({ angle: 60, altitude: 45 });
    const before = Buffer.from(c.compositePixels().data);
    const { bytes, warnings } = await c.toPsd();
    expect(warnings).toEqual([]);
    const file = readPsd(bytes);
    // The built-in patterns the effects use are embedded.
    const patt = file.globalBlocks.find((b) => b.key === 'Patt')!;
    expect(parsePatternBlock(patt.data).map((p) => p.id).sort()).toEqual(['checker', 'dots', 'stripes']);
    const d = new ImageEditorController({});
    const opened = d.loadPsd(bytes);
    expect(opened.warnings).toEqual([]);
    expect(opened.summary.find((s) => s.name === 'Shape')).toMatchObject({ status: 'mapped' });
    const layer = d.getLayers().find((l) => l.name === 'Shape')!;
    expect(effectsFingerprint(layer.effects)).toBe(effectsFingerprint(c.getLayer(id)!.effects));
    expect(d.getGlobalLight()).toEqual({ angle: 60, altitude: 45 });
    expect(d.getDocumentPatterns().map((p) => p.id).sort()).toEqual(['checker', 'dots', 'stripes']);
    expect(Buffer.from(d.compositePixels().data).equals(before)).toBe(true);
  });

  it('writes group effects as lfxs', async () => {
    const { c, id } = setup();
    const g = c.groupLayers([id], 'Group');
    c.setLayerEffects(g, effectsOf([fx('stroke', { size: 2 })]));
    const file = readPsd((await c.toPsd()).bytes);
    expect(file.layers.some((r) => layerBlock(r, 'lfxs'))).toBe(true);
    const d = new ImageEditorController({});
    d.loadPsd((await c.toPsd()).bytes);
    expect(d.getLayers().find((l) => l.name === 'Group')!.effects!.items[0]).toMatchObject({ kind: 'stroke', size: 2 });
  });

  it('writes the effects block it read back verbatim while the effects are unchanged, and regenerates it after an edit', async () => {
    const { c, id } = setup();
    c.setLayerEffects(id, effectsOf([fx('drop-shadow')]));
    // A block with a key we do not model (as newer Photoshop versions add), which must survive.
    const original = parseVersionedDescriptor(writeLfx2(c.getLayerEffects(id)).data.subarray(4));
    original.items.push(['futureKey', { type: 'long', value: 42 }]);
    const w = new PsdWriter();
    w.u32(0);
    w.bytes(versionedDescriptorBytes(original));
    if (w.length % 2) w.u8(0);
    const raw = w.result();
    const file = readPsd((await c.toPsd()).bytes);
    const rec = file.layers.find((r) => layerBlock(r, 'lfx2'))!;
    rec.blocks = rec.blocks.map((b) => (b.key === 'lfx2' ? { key: 'lfx2', data: raw } : b));
    const bytes = writePsd(file, encodeLegacyName);

    const d = new ImageEditorController({});
    d.loadPsd(bytes);
    const shape = d.getLayers().find((l) => l.name === 'Shape')!;
    expect(shape.effects!.psd!.key).toBe('lfx2');
    const again = readPsd((await d.toPsd()).bytes);
    expect(Buffer.from(layerBlock(again.layers.find((r) => layerBlock(r, 'lfx2'))!, 'lfx2')!).equals(Buffer.from(raw))).toBe(true);

    d.updateLayerEffect(shape.id, shape.effects!.items[0].id, { distance: 20 });
    const edited = readPsd((await d.toPsd()).bytes);
    const block = layerBlock(edited.layers.find((r) => layerBlock(r, 'lfx2'))!, 'lfx2')!;
    const desc = parseVersionedDescriptor(block.subarray(4));
    expect(desc.items.some(([k]) => k === 'futureKey')).toBe(false);
    expect(parseLfx2(block)!.effects.items[0]).toMatchObject({ distance: 20 });
  });

  it('keeps an unreadable effects block, warns once, and writes it back', async () => {
    const { c } = setup();
    const file = readPsd((await c.toPsd()).bytes);
    const junk = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 99, 1, 2]);
    file.layers[file.layers.length - 1].blocks.push({ key: 'lfx2', data: junk });
    const d = new ImageEditorController({});
    const opened = d.loadPsd(writePsd(file, encodeLegacyName));
    expect(opened.warnings.join(' ')).toMatch(/Layer effects could not be read; they are kept for export but not drawn/);
    const again = readPsd((await d.toPsd()).bytes);
    expect(Array.from(layerBlock(again.layers[again.layers.length - 1], 'lfx2')!)).toEqual(Array.from(junk));
  });

  it('warns when a pattern effect uses a pattern the file does not contain', async () => {
    const { c, id } = setup();
    c.setLayerEffects(id, effectsOf([fx('pattern-overlay', { patternId: 'not-embedded' })]));
    const { bytes, warnings } = await c.toPsd();
    expect(warnings.join(' ')).toMatch(/Pattern "not-embedded" is not in the document/);
    const opened = new ImageEditorController({}).loadPsd(bytes);
    expect(opened.warnings.join(' ')).toMatch(/uses a pattern the file does not contain/);
    expect(opened.summary.find((s) => s.name === 'Shape')).toMatchObject({ status: 'approximated' });
  });

  it('saves document patterns in JSON and restores them on undo', async () => {
    const { c, id } = setup();
    c.setLayerEffects(id, effectsOf([fx('pattern-overlay', { patternId: 'checker' })]));
    const bytes = (await c.toPsd()).bytes;
    const d = new ImageEditorController({});
    d.loadPsd(bytes);
    const json = d.toJSON() as unknown as { patterns: Array<{ id: string; png: string }> };
    expect(json.patterns.map((p) => p.id)).toEqual(['checker']);
    expect(json.patterns[0].png).toMatch(/^data:image\/png;base64,/);
    const e = new ImageEditorController({});
    e.loadJSON(json as never);
    expect(e.getDocumentPatterns()[0]).toMatchObject({ id: 'checker', width: 16, height: 16 });
    d.undo();
    expect(d.getDocumentPatterns()).toEqual([]);
  });
});
