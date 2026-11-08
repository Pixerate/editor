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
