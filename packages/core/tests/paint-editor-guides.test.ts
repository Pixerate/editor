import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { encodePng, bytesToBase64 } from '../src/raster/png';
import { readPixel } from '../src/raster/surface';
import { applyAffine } from '../src/paint-editor/strokes';
import {
  MixingPad,
  PaintEditorController,
  PerspectiveSnapper,
  colorHarmony,
  createPaintEditorToolProvider,
  hueToWheel,
  normalizeSymmetry,
  perspectiveGuideLines,
  rgbToHsv,
  hsvToRgb,
  symmetryAxisSegments,
  symmetryCopies,
  wheelToHue,
  defaultGuides,
  type PaintPixelLayer,
  type PenPoint,
} from '../src/paint-editor';

const line = (x0: number, y0: number, x1: number, y1: number, n = 20): PenPoint[] =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n }));
const sym = (mode: Parameters<typeof normalizeSymmetry>[0]['mode'], extra = {}) => normalizeSymmetry({ mode, center: { x: 20, y: 30 }, ...extra }, defaultGuides({ width: 40, height: 60 }).symmetry);
const near = (p: { x: number; y: number }, x: number, y: number) => {
  expect(p.x).toBeCloseTo(x, 6);
  expect(p.y).toBeCloseTo(y, 6);
};

/** A 2 × 2 PNG: red, green / blue, white. */
function quadPng(): string {
  return bytesToBase64(encodePng(2, 2, new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])));
}

describe('symmetry', () => {
  it('reflects about its centre like photocraft (vertical, horizontal, diagonal, dual)', () => {
    near(applyAffine(symmetryCopies(sym('vertical'))[0], 12, 25), 28, 25);
    near(applyAffine(symmetryCopies(sym('horizontal'))[0], 12, 25), 12, 35);
    near(applyAffine(symmetryCopies(sym('diagonal'))[0], 12, 25), 15, 22);
    const dual = symmetryCopies(sym('dual')).map((m) => applyAffine(m, 12, 25));
    expect(dual).toHaveLength(3);
    near(dual[0], 28, 25);
    near(dual[1], 12, 35);
    near(dual[2], 28, 35);
    // A quarter turn of the vertical axis makes it horizontal.
    near(applyAffine(symmetryCopies(sym('vertical', { rotation: 90 }))[0], 12, 25), 12, 35);
    expect(symmetryCopies(sym('off'))).toEqual([]);
  });

  it('kaleidoscope: n − 1 rotations plus n reflections, all keeping the distance to the centre', () => {
    const k = sym('kaleidoscope', { segments: 6 });
    const copies = symmetryCopies(k);
    expect(copies).toHaveLength(5 + 6);
    for (const m of copies) {
      const p = applyAffine(m, 30, 30);
      expect(Math.hypot(p.x - 20, p.y - 30)).toBeCloseTo(10, 6);
    }
    expect(symmetryCopies({ ...k, mirror: false })).toHaveLength(5);
    expect(normalizeSymmetry({ segments: 99 }, k).segments).toBe(32);
  });

  it('clips its axes to the canvas', () => {
    for (const mode of ['vertical', 'horizontal', 'diagonal', 'dual', 'kaleidoscope'] as const) {
      for (const [a, b] of symmetryAxisSegments(sym(mode), { width: 40, height: 60 })) {
        for (const p of [a, b]) {
          expect(p.x).toBeGreaterThanOrEqual(-1e-9);
          expect(p.x).toBeLessThanOrEqual(40 + 1e-9);
          expect(p.y).toBeLessThanOrEqual(60 + 1e-9);
        }
      }
    }
    expect(symmetryAxisSegments(sym('horizontal', { center: { x: 20, y: -5 } }), { width: 40, height: 60 })).toEqual([]);
  });

  it('a mirrored stroke is one undo step with both halves, and is recorded with its copy', () => {
    const c = new PaintEditorController({ width: 100, height: 40, paper: 'smooth' });
    c.setSymmetry({ mode: 'vertical', center: { x: 50, y: 20 } });
    const r = c.paintStroke({ points: line(10, 20, 30, 20), brushId: 'ink-pen', color: '#000000' });
    const l = c.getLayer(r.layerId) as PaintPixelLayer;
    expect(readPixel(l.surface, 20, 20)[3]).toBe(255);
    expect(readPixel(l.surface, 80, 20)[3]).toBe(255);
    expect(c.historyLabels().undo).toHaveLength(1);
    expect(c.getStrokes()[0].copies).toHaveLength(1);
    // Replays keep the recorded copies, whatever the guide is now.
    c.setSymmetry({ mode: 'off' });
    const re = c.replayStrokes({ strokeIds: [r.strokeId!], dy: 10 });
    expect(re.bounds!.width).toBeGreaterThan(60);
  });
});

describe('perspective', () => {
  it('snaps a stroke to the line towards the nearest-direction vanishing point', () => {
    const s = new PerspectiveSnapper({ enabled: true, snap: true, points: [{ x: 1000, y: 100 }, { x: -1000, y: 100 }] });
    expect(s.snap({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    // Under the decide distance it holds at the start.
    expect(s.snap({ x: 2, y: 1 })).toEqual({ x: 0, y: 0 });
    const p = s.snap({ x: 100, y: 30 });
    // On the line from (0, 0) towards (1000, 100).
    expect(p.y / p.x).toBeCloseTo(0.1, 6);
    expect(s.line?.direction.x).toBeGreaterThan(0.99);
  });

  it('two-point keeps verticals, one-point keeps horizontals too', () => {
    const two = new PerspectiveSnapper({ enabled: true, snap: true, points: [{ x: 1000, y: 0 }, { x: -1000, y: 0 }] });
    two.snap({ x: 0, y: 0 });
    near(two.snap({ x: 3, y: 50 }), 0, 50);
    const one = new PerspectiveSnapper({ enabled: true, snap: true, points: [{ x: 0, y: -1000 }] });
    one.snap({ x: 0, y: 0 });
    near(one.snap({ x: 50, y: 3 }), 50, 0);
  });

  it('applies to pen strokes, and to paint_stroke only when asked', () => {
    const c = new PaintEditorController({ width: 200, height: 100, paper: 'smooth' });
    c.setPerspective({ enabled: true, points: [{ x: 1000, y: 50 }] });
    const s = c.beginStroke({ brushId: 'ink-pen' });
    s.push([{ x: 10, y: 50 }, { x: 60, y: 58 }, { x: 120, y: 62 }]);
    s.end();
    expect(c.getStrokes()[0].points.every((p) => Math.abs(p.y - 50) < 2)).toBe(true);
    c.paintStroke({ points: [{ x: 10, y: 10 }, { x: 100, y: 30 }] });
    expect(c.getStrokes()[1].points[1].y).toBe(30);
    c.paintStroke({ points: [{ x: 10, y: 10 }, { x: 100, y: 30 }], snapToPerspective: true });
    expect(Math.abs(c.getStrokes()[2].points[1].y - 10)).toBeLessThan(10);
    expect(() => c.setPerspective({ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] })).toThrow(/one to three/);
    expect(() => c.setPerspective({ enabled: true, points: [] })).toThrow(/at least one vanishing point/);
    expect(perspectiveGuideLines(c.getState().guides.perspective, { width: 200, height: 100 }, 8)).toHaveLength(8);
  });
});

describe('tracing and reference images', () => {
  it('shows a tracing image in the view only, and samples its colours', () => {
    const c = new PaintEditorController({ width: 20, height: 20, paper: 'smooth' });
    c.setTracingImage({ png: quadPng(), opacity: 1, sampleColors: true });
    expect(c.getState().guides.tracing).toMatchObject({ width: 2, height: 2, rect: { x: 0, y: 0, width: 20, height: 20 } });
    let tile: Uint8ClampedArray | null = null;
    c.compositeTiles({ x: 0, y: 0, width: 20, height: 20 }, (_tx, _ty, data) => (tile = data));
    expect(Array.from(tile!.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    // Exports never show it.
    expect(Array.from(c.compositePixels().data.subarray(0, 4))).toEqual([255, 255, 255, 255]);
    expect(c.sampleTracingColor(15, 2)).toBe('#00ff00');
    const r = c.paintStroke({ points: [{ x: 3, y: 15 }], brushId: 'ink-pen' });
    expect(c.getStrokes()[0].color).toBe('#0000ff');
    expect(r.bounds).not.toBeNull();
    c.updateTracing({ visible: false });
    c.compositeTiles({ x: 0, y: 0, width: 20, height: 20 }, (_tx, _ty, data) => (tile = data));
    expect(Array.from(tile!.subarray(0, 4))).toEqual([255, 255, 255, 255]);
    c.clearTracingImage();
    expect(() => c.updateTracing({ opacity: 0.5 })).toThrow(/no tracing image/);
    expect(() => c.setTracingImage({ png: 'nope' })).toThrow(/could not be decoded|not a data URL/);
  });

  it('keeps reference images to pick colours from, and saves guides with the document', () => {
    const c = new PaintEditorController({ width: 30, height: 30 });
    const ref = c.addReferenceImage({ png: quadPng(), name: 'Swatch card' });
    expect(ref).toMatchObject({ id: 'ref1', width: 2, height: 2, name: 'Swatch card' });
    expect(c.pickReferenceColor('ref1', 1, 1)).toBe('#ffffff');
    expect(() => c.pickReferenceColor('ref1', 5, 0)).toThrow(/outside reference/);
    c.updateReferenceImage('ref1', { x: 200, displayWidth: 120 });
    c.setSymmetry({ mode: 'kaleidoscope', segments: 8 });
    c.setTracingImage({ png: quadPng() });
    c.addSwatch('#123456', 'Navy');
    const json = JSON.parse(JSON.stringify(c.toJSON()));
    const d = new PaintEditorController();
    expect(d.loadJSON(json)).toEqual([]);
    const g = d.getState().guides;
    expect(g.symmetry).toMatchObject({ mode: 'kaleidoscope', segments: 8 });
    expect(g.references[0]).toMatchObject({ id: 'ref1', x: 200, displayWidth: 120 });
    expect(g.tracing?.width).toBe(2);
    expect(d.getState().swatches.at(-1)).toEqual({ color: '#123456', name: 'Navy' });
    expect(d.addReferenceImage({ png: quadPng() }).id).toBe('ref2');
    d.removeReferenceImage('ref1');
    expect(() => d.removeReferenceImage('ref1')).toThrow(/Unknown reference image/);
  });
});

describe('colour', () => {
  it('round-trips HSV and maps the RYB wheel', () => {
    for (const rgb of [[255, 0, 0], [12, 200, 99], [80, 80, 80]] as const) {
      const { h, s, v } = rgbToHsv(...rgb);
      expect(hsvToRgb(h, s, v)).toEqual([...rgb]);
    }
    for (const a of [0, 45, 120, 200, 300]) expect(hueToWheel(wheelToHue(a, 'ryb'), 'ryb')).toBeCloseTo(a, 6);
    expect(wheelToHue(120, 'ryb')).toBe(60);
  });

  it('harmonies: red’s complement is green on the painter’s wheel and cyan on the RGB wheel', () => {
    const ryb = colorHarmony('#ff0000', 'complementary');
    expect(ryb[0].color).toBe('#ff0000');
    expect(ryb[1].color).toBe('#00ff00');
    expect(colorHarmony('#ff0000', 'complementary', { wheel: 'rgb' })[1].color).toBe('#00ffff');
    expect(colorHarmony('#3366cc', 'triadic')).toHaveLength(3);
    expect(colorHarmony('#3366cc', 'square')).toHaveLength(4);
    const mono = colorHarmony('#3366cc', 'monochromatic');
    expect(mono).toHaveLength(5);
    expect(new Set(mono.map((m) => m.color)).size).toBe(5);
    expect(() => colorHarmony('blue', 'triadic')).toThrow(/use #rrggbb/);
  });

  it('the mixing pad mixes paint with the knife and picks the mix', () => {
    const pad = new MixingPad();
    pad.stroke(line(40, 100, 120, 100), { tool: 'paint', color: '#0000ff' });
    pad.stroke(line(120, 100, 200, 100), { tool: 'paint', color: '#ffff00' });
    expect(pad.pick(60, 100)).toMatch(/^#/);
    const before = pad.pick(190, 100)!;
    for (let i = 0; i < 4; i++) pad.stroke(line(60, 100 + i, 190, 100 - i, 40), { tool: 'knife', color: '#000000' });
    // The far end, yellow before, now holds blue pushed into it.
    const after = pad.pick(190, 100)!;
    expect(after).not.toBe(before);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(after.slice(i, i + 2), 16));
    // Blue knifed into yellow with pigment mixing: green dominates.
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    expect(pad.pick(5, 5)).toBeNull();
    expect(() => pad.stroke([{ x: 999, y: 0 }], { tool: 'paint', color: '#000000' })).toThrow(/off the 360×220 mixing pad/);
    pad.clear();
    expect(pad.pick(130, 100)).toBeNull();
  });
});

describe('guide and colour agent tools', () => {
  const setup = () => {
    const c = new PaintEditorController({ width: 120, height: 80, paper: 'smooth' });
    const r = new ToolRegistry();
    r.register(createPaintEditorToolProvider(c));
    return { c, r };
  };
  const ok = (res: { isError?: boolean; structuredContent?: unknown; content: unknown[] }) => {
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    return res.structuredContent as any;
  };

  it('sets and reads guides', async () => {
    const { r } = setup();
    expect(ok(await r.callTool('set_symmetry', { mode: 'kaleidoscope', segments: 4 }))).toMatchObject({ mode: 'kaleidoscope', copies: 7 });
    expect(ok(await r.callTool('set_perspective_guide', { enabled: true, points: [{ x: 60, y: -500 }] }))).toMatchObject({ enabled: true, snap: true });
    expect(ok(await r.callTool('set_tracing_image', { png: quadPng(), opacity: 0.5, sampleColors: true }))).toMatchObject({ width: 2, opacity: 0.5, sampleColors: true });
    expect(ok(await r.callTool('update_tracing_image', { visible: false })).visible).toBe(false);
    const ref = ok(await r.callTool('add_reference_image', { png: quadPng(), name: 'Ref' }));
    expect(ref.src).toBeUndefined();
    expect(ok(await r.callTool('list_reference_images', {})).references).toHaveLength(1);
    expect(ok(await r.callTool('update_reference_image', { id: ref.id, visible: false })).visible).toBe(false);
    expect(ok(await r.callTool('pick_reference_color', { id: ref.id, x: 0, y: 1, setColor: true }))).toEqual({ color: '#0000ff' });
    const g = ok(await r.callTool('get_guides', {}));
    expect(g.symmetry.copies).toBe(7);
    expect(g.tracing.visible).toBe(false);
    expect(ok(await r.callTool('get_canvas_info', {})).color).toBe('#0000ff');
    expect(ok(await r.callTool('remove_reference_image', { id: ref.id }))).toEqual({ removed: ref.id });
    expect(ok(await r.callTool('clear_tracing_image', {}))).toEqual({ tracing: null });
    expect((await r.callTool('set_symmetry', { mode: 'spiral' })).isError).toBe(true);
    expect((await r.callTool('pick_reference_color', { id: 'nope', x: 0, y: 0 })).isError).toBe(true);
  });

  it('harmonies, swatches and the mixing pad', async () => {
    const { r } = setup();
    expect(ok(await r.callTool('color_harmony', { kind: 'complementary', color: '#ff0000' })).colors[1].color).toBe('#00ff00');
    const sw = ok(await r.callTool('add_swatch', { color: '#abcdef', name: 'Sky' }));
    expect(sw.swatches.at(-1)).toMatchObject({ color: '#abcdef', name: 'Sky' });
    const n = ok(await r.callTool('list_swatches', {})).swatches.length;
    expect(ok(await r.callTool('remove_swatch', { index: n - 1 })).swatches).toHaveLength(n - 1);
    expect((await r.callTool('remove_swatch', { index: 999 })).isError).toBe(true);
    ok(await r.callTool('mixing_pad_stroke', { points: line(50, 100, 150, 100), color: '#ff0000' }));
    const picked = ok(await r.callTool('pick_mixing_pad_color', { x: 100, y: 100, setColor: true }));
    expect(picked.color).toMatch(/^#/);
    const pad = await r.callTool('render_mixing_pad', {});
    expect(pad.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(ok(await r.callTool('clear_mixing_pad', {}))).toEqual({ cleared: true });
    expect(ok(await r.callTool('pick_mixing_pad_color', { x: 100, y: 100 }))).toEqual({ color: null });
  });
});
