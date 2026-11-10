import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { decodePng } from '../src/raster/png';
import { contentBounds, readPixel } from '../src/raster/surface';
import {
  DEFAULT_AGE,
  PaintEditorController,
  agePixel,
  craquelureAt,
  createPaintEditorToolProvider,
  type PaintPixelLayer,
  type PenPoint,
} from '../src/paint-editor';
import { fadeSusceptibilityAtHue } from '../src/paint-editor/age';

const line = (x0: number, y0: number, x1: number, y1: number, n = 12, extra: Partial<PenPoint> = {}): PenPoint[] =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n, ...extra }));

function setup(width = 160, height = 120) {
  const c = new PaintEditorController({ width, height, paperPreset: 'smooth-bristol' });
  const reg = new ToolRegistry();
  reg.register(createPaintEditorToolProvider(c));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await reg.callTool(name, args);
    const textPart = r.content.find((p): p is { type: 'text'; text: string } => p.type === 'text');
    const text = textPart?.text ?? '';
    let parsed: unknown = null;
    if (!r.structuredContent && text.startsWith('{')) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    const data = r.structuredContent ?? parsed ?? text;
    return { isError: Boolean(r.isError), data: data as Record<string, unknown>, text };
  };
  return { c, reg, call };
}

describe('painting time machine: ageing, X-ray view & scraper brush', () => {
  it('sets and gets non-destructive ageing preview without creating an undo step, and persists in JSON', async () => {
    const { c, call } = setup();
    c.paintStroke({ brushId: 'impasto-brush', color: '#d62828', points: line(24, 60, 136, 60, 10, { pressure: 0.9 }) });
    const undoBefore = c.getState().undoLabel;

    const g0 = await call('get_age');
    expect(g0.isError).toBe(false);
    expect(g0.data.age).toEqual(DEFAULT_AGE);

    const s1 = await call('set_age', {
      years: 300,
      varnish: 0.7,
      cracks: 0.65,
      fading: 0.6,
      dust: 0.35,
      seed: 19,
    });
    expect(s1.isError).toBe(false);
    expect(s1.data.age).toEqual({
      years: 300,
      varnish: 0.7,
      cracks: 0.65,
      fading: 0.6,
      dust: 0.35,
      seed: 19,
    });
    expect(c.getState().undoLabel).toBe(undoBefore);

    // Refuses invalid arguments
    expect((await call('set_age', { years: 900 })).isError).toBe(true);
    expect((await call('set_age', { varnish: -0.1 })).isError).toBe(true);
    expect((await call('set_age', { cracks: 1.5 })).isError).toBe(true);
    expect((await call('set_age', { fading: 2 })).isError).toBe(true);
    expect((await call('set_age', { dust: -1 })).isError).toBe(true);
    expect((await call('set_age', { seed: -5 })).isError).toBe(true);

    // Export is unaged by default and aged when opt-in (`age: true`)
    const unagedExport = c.compositePixels({ paper: true });
    const agedExport = c.compositePixels({ paper: true, age: true });
    let diff = 0;
    for (let i = 0; i < unagedExport.data.length; i += 4) {
      diff += Math.abs(unagedExport.data[i]! - agedExport.data[i]!);
    }
    expect(diff).toBeGreaterThan(1000);

    // Persisted in document JSON and restored on loadJSON
    const saved = c.toJSON();
    expect(saved.age).toEqual({
      years: 300,
      varnish: 0.7,
      cracks: 0.65,
      fading: 0.6,
      dust: 0.35,
      seed: 19,
    });
    const c2 = new PaintEditorController({ width: 64, height: 64 });
    c2.loadJSON(saved);
    expect(c2.getAge()).toEqual(c.getAge());
  });

  it('fades fugitive reds/violets faster than mineral blues and scales craquelure with layer count and impasto height', () => {
    // Fugitive reds (~0 deg) and violets (~300 deg) have higher fade susceptibility than blues (~210 deg)
    expect(fadeSusceptibilityAtHue(0)).toBeGreaterThan(fadeSusceptibilityAtHue(210));
    expect(fadeSusceptibilityAtHue(305)).toBeGreaterThan(fadeSusceptibilityAtHue(180));
    const agedRed = agePixel(220 / 255, 30 / 255, 30 / 255, 20, 20, { ...DEFAULT_AGE, years: 300, varnish: 0, cracks: 0, dust: 0, fading: 1 }, 1, 0);
    const agedBlue = agePixel(30 / 255, 80 / 255, 220 / 255, 20, 20, { ...DEFAULT_AGE, years: 300, varnish: 0, cracks: 0, dust: 0, fading: 1 }, 1, 0);
    expect(Math.abs(agedRed[0] - 220 / 255)).toBeGreaterThan(Math.abs(agedBlue[2] - 220 / 255));

    // Craquelure stress increases with layer count and thick height
    let thinSum = 0;
    let thickSum = 0;
    for (let y = 0; y < 80; y += 2) {
      for (let x = 0; x < 80; x += 2) {
        thinSum += craquelureAt(x, y, 7, 1, 0);
        thickSum += craquelureAt(x, y, 7, 4, 240 / 255);
      }
    }
    expect(thickSum).toBeGreaterThan(thinSum);
  });

  it('bakes ageing into a new top layer as one undo step and resets preview years to 0', async () => {
    const { c, call } = setup();
    c.paintStroke({ brushId: 'ink-pen', color: '#b91c1c', points: line(20, 40, 140, 80, 10, { pressure: 0.85 }) });

    // Refused when years == 0
    const refused = await call('bake_age', {});
    expect(refused.isError).toBe(true);

    await call('set_age', { years: 300, varnish: 0.65, cracks: 0.5, fading: 0.5, dust: 0.25, seed: 11 });
    const baked = await call('bake_age', { name: 'Museum patina' });
    expect(baked.isError).toBe(false);
    expect((baked.data.layer as { name: string }).name).toBe('Museum patina');
    expect(c.getAge().years).toBe(0);
    expect(c.listLayers()[0]?.name).toBe('Museum patina');

    // Undo restores previous layers and previous preview years
    c.undo();
    expect(c.getAge().years).toBe(300);
    expect(c.listLayers().some((l) => l.name === 'Museum patina')).toBe(false);
  });

  it('ages the composite once: a Multiply layer is not yellowed twice, and bake_age commits that composite', async () => {
    const { c, call } = setup(64, 48);
    const ground = c.getActiveLayer()!.id;
    expect((await call('fill_layer', { layerId: ground, color: '#d8c090' })).isError).toBe(false);
    const glaze = (await call('add_layer', { name: 'Glaze' })).data as { id: string };
    expect((await call('fill_layer', { layerId: glaze.id, color: '#6090d0' })).isError).toBe(false);
    expect((await call('update_layer', { layerId: glaze.id, blend: 'multiply' })).isError).toBe(false);
    const age = { years: 300, varnish: 0.8, cracks: 0, fading: 0.6, dust: 0.4, seed: 5 };
    expect((await call('set_age', age)).isError).toBe(false);

    const plain = c.compositePixels({ paper: true });
    const aged = c.compositePixels({ paper: true, age: true });
    const full = { ...DEFAULT_AGE, ...age };
    for (const [x, y] of [[3, 4], [31, 20], [60, 44]]) {
      const i = (y * 64 + x) * 4;
      // Ageing is a function of the composite pixel (two painted layers here, no impasto).
      const want = agePixel(plain.data[i] / 255, plain.data[i + 1] / 255, plain.data[i + 2] / 255, x, y, full, 2, 0).map((v) => Math.round(v * 255));
      for (let k = 0; k < 3; k++) expect(Math.abs(aged.data[i + k] - want[k])).toBeLessThanOrEqual(1);
      // Ageing each layer and then multiplying absorbs the varnish's blue twice.
      const bottom = agePixel(0xd8 / 255, 0xc0 / 255, 0x90 / 255, x, y, full, 2, 0);
      const top = agePixel(0x60 / 255, 0x90 / 255, 0xd0 / 255, x, y, full, 2, 0);
      expect(aged.data[i + 2]).toBeGreaterThan(Math.round(bottom[2] * top[2] * 255) + 8);
    }

    const baked = await call('bake_age', {});
    expect(baked.isError).toBe(false);
    // With years back at 0, the painting with the baked layer on top is the aged preview.
    const after = c.compositePixels({ paper: true });
    for (const [x, y] of [[3, 4], [31, 20], [60, 44]]) {
      const i = (y * 64 + x) * 4;
      for (let k = 0; k < 3; k++) expect(Math.abs(after.data[i + k] - aged.data[i + k])).toBeLessThanOrEqual(1);
    }
  });

  it('bake_age over the paper: a translucent wash and a Multiply glaze bake to what the preview showed', async () => {
    const { c, call } = setup(64, 48);
    const wash = c.getActiveLayer()!.id;
    expect((await call('fill_layer', { layerId: wash, color: '#c03020', opacity: 0.4 })).isError).toBe(false);
    const glaze = (await call('add_layer', { name: 'Glaze' })).data as { id: string };
    expect((await call('update_layer', { layerId: glaze.id, blend: 'multiply' })).isError).toBe(false);
    const hard = { tip: { size: 14, hardness: 1, opacity: 1, flow: 1, spacing: 0.05, pressureSize: false, pressureOpacity: false, smoothing: 0 }, grain: 0 };
    c.paintStroke({ brushId: 'ink-pen', brush: hard, points: line(6, 24, 58, 24, 12), color: '#2050c0' });
    expect((await call('set_age', { years: 350, varnish: 0.9, cracks: 0.6, fading: 0.7, dust: 0.5, seed: 9 })).isError).toBe(false);
    const preview = c.compositePixels({ paper: true, age: true });
    const baked = await call('bake_age', {});
    expect(baked.isError).toBe(false);
    const layer = c.getLayer((baked.data.layer as { id: string }).id) as PaintPixelLayer;
    const after = c.compositePixels({ paper: true });
    let worst = 0;
    let glazed = 0;
    let translucent = 0;
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4;
        const a = readPixel(layer.surface, x, y)[3];
        // The wash covers the canvas: the baked layer keeps the paint's alpha, not the paper's.
        if (y < 10) expect(a).toBeGreaterThanOrEqual(101);
        if (a === 0) continue;
        if (a === 255) glazed++;
        else translucent++;
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(after.data[i + k] - preview.data[i + k]));
      }
    }
    expect(glazed).toBeGreaterThan(0);
    // Most of the wash stays a translucent layer (the paper shows through it, not baked in).
    expect(translucent).toBeGreaterThan(64 * 48 * 0.5);
    // Solved over the paper (rounding aside), not the wash's colour on its own laid Normal on top.
    expect(worst).toBeLessThanOrEqual(2);
  });

  it('ages only the paint that is drawn: hidden groups and unpicked layers do not mark the paper as painted', async () => {
    const { c, call } = setup(96, 64);
    const hard = { tip: { size: 10, hardness: 1, opacity: 1, flow: 1, spacing: 0.05, pressureSize: false, pressureOpacity: false, smoothing: 0 }, grain: 0 };
    const shown = c.getActiveLayer()!.id;
    c.paintStroke({ brushId: 'ink-pen', brush: hard, points: line(8, 12, 88, 12, 12), color: '#203040' });
    const group = (await call('add_layer', { type: 'group', name: 'Hidden' })).data as { id: string };
    const inner = (await call('add_layer', { name: 'Under', parentId: group.id })).data as { id: string };
    expect((await call('fill_layer', { layerId: inner.id, color: '#806040' })).isError).toBe(false);
    expect((await call('update_layer', { layerId: group.id, visible: false })).isError).toBe(false);
    const age = { years: 450, varnish: 0.6, cracks: 1, fading: 0.4, dust: 0.3, seed: 4 };
    expect((await call('set_age', age)).isError).toBe(false);
    const full = { ...DEFAULT_AGE, ...age };
    const plain = c.compositePixels({ paper: true });
    const aged = c.compositePixels({ paper: true, age: true });
    // Bare paper (below the stroke) ages as paper, not as paint of the hidden group.
    let diff = 0;
    for (let y = 30; y < 64; y++) {
      for (let x = 0; x < 96; x++) {
        const i = (y * 96 + x) * 4;
        const want = agePixel(plain.data[i] / 255, plain.data[i + 1] / 255, plain.data[i + 2] / 255, x, y, full, 1, 0).map((v) => Math.round(v * 255));
        for (let k = 0; k < 3; k++) diff = Math.max(diff, Math.abs(aged.data[i + k] - want[k]));
      }
    }
    expect(diff).toBeLessThanOrEqual(1);

    // Picking one layer: a visible layer left out does not mark the paper under it as painted.
    expect((await call('update_layer', { layerId: group.id, visible: true })).isError).toBe(false);
    const picked = c.compositePixels({ paper: true, layerIds: [shown] });
    const pickedAged = c.compositePixels({ paper: true, layerIds: [shown], age: true });
    let pickedDiff = 0;
    for (let y = 30; y < 64; y++) {
      for (let x = 0; x < 96; x++) {
        const i = (y * 96 + x) * 4;
        const want = agePixel(picked.data[i] / 255, picked.data[i + 1] / 255, picked.data[i + 2] / 255, x, y, full, 1, 0).map((v) => Math.round(v * 255));
        for (let k = 0; k < 3; k++) pickedDiff = Math.max(pickedDiff, Math.abs(pickedAged.data[i + k] - want[k]));
      }
    }
    expect(pickedDiff).toBeLessThanOrEqual(1);
  });

  it('ages light spill with the composite: an Add layer takes no dust or bleach of its own', async () => {
    const { c, call } = setup(160, 100);
    c.setPaper({ color: '#111111' } as never);
    const hard = { tip: { size: 12, hardness: 1, opacity: 1, flow: 1, spacing: 0.05, pressureSize: false, pressureOpacity: false, smoothing: 0 }, grain: 0 };
    c.paintStroke({ brushId: 'neon-marker', brush: hard, points: [{ x: 20, y: 50 }, { x: 140, y: 50 }], color: '#3b82f6' });
    const age = { years: 400, varnish: 0.5, cracks: 0, fading: 0.7, dust: 0.6, seed: 3 };
    expect((await call('set_age', age)).isError).toBe(false);
    const full = { ...DEFAULT_AGE, ...age };
    const plain = c.compositePixels({ paper: true });
    const aged = c.compositePixels({ paper: true, age: true });
    // (80, 62) is bare paper lit only by the spill; (80, 98) is beyond its reach.
    const spillAt = 62 * 160 + 80;
    expect(plain.data[spillAt * 4 + 2]).toBeGreaterThan(0x11 + 5);
    for (const [x, y] of [[80, 62], [80, 98], [80, 50]]) {
      const i = (y * 160 + x) * 4;
      const painted = y === 50;
      const want = agePixel(plain.data[i] / 255, plain.data[i + 1] / 255, plain.data[i + 2] / 255, x, y, full, 1, 0).map((v) => Math.round(v * 255));
      for (let k = 0; k < 3; k++) expect(Math.abs(aged.data[i + k] - want[k]), `(${x}, ${y}) channel ${k}${painted ? ' (painted)' : ''}`).toBeLessThanOrEqual(1);
    }
  });

  it('renders X-ray radiographs revealing hidden underpainting and historical stroke counts', async () => {
    const { c, call } = setup();
    const bottomId = c.document.activeLayerId!;
    // Hidden bright white impasto underpainting
    c.paintStroke({
      layerId: bottomId,
      brushId: 'impasto-brush',
      color: '#f8fafc',
      points: line(30, 60, 130, 60, 12, { pressure: 0.95 }),
    });
    // Hide the bottom layer
    c.updateLayer(bottomId, { visible: false });

    // Add top layer with dark thin paint over it
    const top = c.addLayer({ name: 'Overpaint' });
    c.paintStroke({
      layerId: top.id,
      brushId: 'ink-pen',
      color: '#1e293b',
      points: line(80, 20, 80, 100, 12, { pressure: 0.8 }),
    });

    const xFull = await call('render_xray', { maxSide: 160 });
    expect(xFull.isError).toBe(false);
    expect(xFull.data.layerCount).toBe(2);
    expect(xFull.data.hiddenLayerCount).toBe(1);
    expect(xFull.data.strokes).toBe(2);
    expect(xFull.data.totalStrokes).toBe(2);

    // Check that the hidden white impasto stroke at (45, 60) shows bright in the radiograph
    const fullCall = await regCallRaw(c, 2);
    const idxHidden = (60 * fullCall.width + 45) * 4;
    const idxEmpty = (10 * fullCall.width + 10) * 4;
    expect(fullCall.data[idxHidden]!).toBeGreaterThan(fullCall.data[idxEmpty]! + 40);

    // Historical X-ray after 1 stroke (before the overpaint stroke)
    const x1 = await call('render_xray', { strokes: 1, maxSide: 160 });
    expect(x1.isError).toBe(false);
    expect(x1.data.strokes).toBe(1);
    expect(x1.data.totalStrokes).toBe(2);

    // Toggle viewport X-ray view
    const vOn = await call('set_xray_view', { on: true });
    expect(vOn.isError).toBe(false);
    expect(vOn.data.xrayView).toBe(true);
    expect(c.getXrayView()).toBe(true);

    const vOff = await call('set_xray_view', { on: false });
    expect(vOff.isError).toBe(false);
    expect(vOff.data.xrayView).toBe(false);

    // Invalid arguments refused
    expect((await call('render_xray', { strokes: 99 })).isError).toBe(true);
    expect((await call('render_xray', { maxSide: 4 })).isError).toBe(true);
  });

  it('scrapes down through the paint stack layer by layer, stopping at locked layers or paper, and refuses wet layers', async () => {
    const { c, call } = setup();
    const bottomId = c.document.activeLayerId!;
    c.fillLayer({ layerId: bottomId, color: '#eab308', opacity: 1 });

    const mid = c.addLayer({ name: 'Middle' });
    c.fillLayer({ layerId: mid.id, color: '#2563eb', opacity: 1 });

    const top = c.addLayer({ name: 'Top' });
    c.fillLayer({ layerId: top.id, color: '#dc2626', opacity: 1 });

    // Lock the bottom layer so the scraper cannot cut into it
    c.updateLayer(bottomId, { locks: { pixels: true } });

    // Select paint-scraper with high depth so a single pass cuts through Top and into Middle
    await call('set_brush', {
      id: 'paint-scraper',
      marks: { kind: 'scraper', depth: 0.85, sharpness: 0.9 },
      tip: { size: 36, spacing: 0.08, opacity: 1, flow: 1 },
    });
    const res = await call('paint_stroke', {
      points: line(30, 60, 130, 60, 16, { pressure: 1 }),
    });
    expect(res.isError).toBe(false);

    const topAfter = readPixel((c.getLayer(top.id) as PaintPixelLayer).surface, 80, 60);
    const midAfter = readPixel((c.getLayer(mid.id) as PaintPixelLayer).surface, 80, 60);
    const botAfter = readPixel((c.getLayer(bottomId) as PaintPixelLayer).surface, 80, 60);
    // Top layer was scraped completely through at the centreline
    expect(topAfter[3]).toBeLessThan(30);
    // Carryover depth scraped into Middle layer too
    expect(midAfter[3]).toBeLessThan(240);
    // Locked bottom layer is untouched
    expect(botAfter[3]).toBe(255);

    // One undo step restores both Top and Middle layers
    c.undo();
    expect(readPixel((c.getLayer(top.id) as PaintPixelLayer).surface, 80, 60)[3]).toBe(255);
    expect(readPixel((c.getLayer(mid.id) as PaintPixelLayer).surface, 80, 60)[3]).toBe(255);

    // Refuses scraping when a layer holds wet paint
    c.paintStroke({
      layerId: top.id,
      brushId: 'watercolor-round',
      color: '#16a34a',
      points: line(40, 60, 120, 60, 8, { pressure: 0.8 }),
    });
    const wetRefusal = await call('paint_stroke', {
      brushId: 'paint-scraper',
      points: line(40, 60, 120, 60, 8, { pressure: 0.9 }),
    });
    expect(wetRefusal.isError).toBe(true);
    expect(wetRefusal.text).toContain('dry_paint');

    // Refuses scraping on a live stroke layer
    await call('dry_paint', {});
    const strokeLayer = c.addLayer({ name: 'Vector Strokes', type: 'strokes' });
    c.setActiveLayer(strokeLayer.id);
    const liveRefusal = await call('paint_stroke', {
      brushId: 'paint-scraper',
      points: line(40, 60, 120, 60, 8, { pressure: 0.9 }),
    });
    expect(liveRefusal.isError).toBe(true);
    expect( contentBounds((c.getLayer(top.id) as PaintPixelLayer).surface)).not.toBeNull();
  });

  it('keeps the current age through undo and redo of other steps (set_age is not an undo step), and saves it', async () => {
    const { c, call } = setup();
    c.paintStroke({ brushId: 'impasto-brush', color: '#d62828', points: line(24, 60, 136, 60, 10, { pressure: 0.9 }) });
    expect((await call('set_age', { years: 300, seed: 4 })).isError).toBe(false);
    expect((await call('undo_paint')).isError).toBe(false);
    const g = await call('get_age');
    expect((g.data.age as { years: number }).years).toBe(300);
    expect(c.document.age?.years).toBe(300);
    expect(c.toJSON().age?.years).toBe(300);
    expect((await call('redo_paint')).isError).toBe(false);
    expect(c.getAge().years).toBe(300);
    expect(c.document.age?.seed).toBe(4);

    // bake_age is an undo step that changes the age: undo brings the preview years back.
    await call('bake_age');
    expect(c.getAge().years).toBe(0);
    c.undo();
    expect(c.getAge().years).toBe(300);
    c.redo();
    expect(c.getAge().years).toBe(0);
  });

  it('replays scraper strokes on the layers they cut, so a historical X-ray of every stroke matches the live one', async () => {
    const { c, call } = setup();
    const bottomId = c.document.activeLayerId!;
    c.fillLayer({ layerId: bottomId, color: '#f8fafc', opacity: 1 });
    const hidden = c.addLayer({ name: 'Hidden underpainting' });
    c.paintStroke({ layerId: hidden.id, brushId: 'impasto-brush', color: '#ffffff', points: line(20, 60, 140, 60, 12, { pressure: 1 }) });
    c.updateLayer(hidden.id, { visible: false });
    const top = c.addLayer({ name: 'Top' });
    c.fillLayer({ layerId: top.id, color: '#dc2626', opacity: 1 });
    c.updateLayer(bottomId, { locks: { pixels: true } });

    await call('set_brush', { id: 'paint-scraper', marks: { kind: 'scraper', depth: 1, sharpness: 0.9 }, tip: { size: 36, spacing: 0.08, opacity: 1, flow: 1 } });
    expect((await call('paint_stroke', { layerId: top.id, points: line(30, 60, 130, 60, 16, { pressure: 1 }) })).isError).toBe(false);
    const stroke = c.document.strokes[c.document.strokes.length - 1]!;
    expect(stroke.scrapeLayerIds).toEqual([top.id]);
    // The hidden layer was not cut by the live stroke.
    expect(readPixel((c.getLayer(hidden.id) as PaintPixelLayer).surface, 80, 60)[3]).toBe(255);
    // Saved and loaded, the stroke keeps the layers it cut.
    const loaded = new PaintEditorController({ width: 160, height: 120 });
    loaded.loadJSON(c.toJSON());
    expect(loaded.document.strokes[loaded.document.strokes.length - 1]!.scrapeLayerIds).toEqual([top.id]);

    const total = c.document.strokes.length;
    const live = await c.renderXray({ maxSide: 160 });
    const replayed = await c.renderXray({ strokes: total, maxSide: 160 });
    expect(replayed.meanDensity).toBe(live.meanDensity);
    expect(replayed.maxDensity).toBe(live.maxDensity);
    expect(Array.from(replayed.data)).toEqual(Array.from(live.data));
  });
});

async function regCallRaw(c: PaintEditorController, strokes: number) {
  const r = await c.renderXray({ strokes, maxSide: 160 });
  const png = decodePng(
    // ensure round-trip decode matches dimensions
    await c.exportPng({ age: false })
  );
  expect(png.width).toBe(r.width);
  return r;
}
