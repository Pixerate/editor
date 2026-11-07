import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { readPixel } from '../src/raster/surface';
import { fillRegionMask, findUnfilledRegionsMask } from '../src/raster/fill';
import {
  PaintEditorController,
  PaintGesture,
  createPaintEditorToolProvider,
  serializePaintDocument,
  deserializePaintDocument,
  type PaintPixelLayer,
  type PenPoint,
} from '../src/paint-editor';

const line = (x0: number, y0: number, x1: number, y1: number, n = 24): PenPoint[] =>
  Array.from({ length: n + 1 }, (_, i) => ({
    x: x0 + ((x1 - x0) * i) / n,
    y: y0 + ((y1 - y0) * i) / n,
  }));

const layerOf = (c: PaintEditorController, id = c.document.activeLayerId!) => c.getLayer(id) as PaintPixelLayer;

describe('raster/fill: fillRegionMask & findUnfilledRegionsMask', () => {
  it('fills an enclosed region, detects edge leaks, and closes gaps up to closeGap px', () => {
    const w = 40;
    const h = 40;
    const ref = new Uint8Array(w * h * 4);
    // Draw a 20x20 black box at (10,10)..(30,30) with a 2px gap on the top edge (x=19,20, y=10)
    for (let x = 10; x <= 30; x++) {
      if (x !== 19 && x !== 20) {
        const top = (10 * w + x) * 4;
        ref[top + 3] = 255;
      }
      const bot = (30 * w + x) * 4;
      ref[bot + 3] = 255;
    }
    for (let y = 10; y <= 30; y++) {
      const left = (y * w + 10) * 4;
      ref[left + 3] = 255;
      const right = (y * w + 30) * 4;
      ref[right + 3] = 255;
    }

    // Without gap closing, filling from (20,20) leaks out of the 2px gap to the canvas border
    const leaked = fillRegionMask(ref, w, h, {
      points: [{ x: 20, y: 20 }],
      tolerance: 16,
      closeGap: 0,
      expand: 0,
      antialias: false,
    });
    expect(leaked.leaked).toBe(true);
    expect(leaked.bounds).toEqual({ x: 0, y: 0, width: w, height: h });

    // With closeGap: 3, the 2px gap is bridged and the fill stays inside the box (plus the 2 gap pixels at y=10)
    const closed = fillRegionMask(ref, w, h, {
      points: [{ x: 20, y: 20 }],
      tolerance: 16,
      closeGap: 3,
      expand: 0,
      antialias: false,
    });
    expect(closed.leaked).toBe(false);
    expect(closed.bounds).toEqual({ x: 11, y: 10, width: 19, height: 20 });
    expect(closed.pixelCount).toBe(19 * 19 + 2);

    // Expanding by 1 px bleeds 1 px under the 1px line art (reaching x=10..30)
    const expanded = fillRegionMask(ref, w, h, {
      points: [{ x: 20, y: 20 }],
      tolerance: 16,
      closeGap: 3,
      expand: 1,
      antialias: true,
    });
    expect(expanded.leaked).toBe(false);
    expect(expanded.bounds.x).toBe(10);
    expect(expanded.bounds.width).toBe(21);
    expect(expanded.pixelCount).toBeGreaterThan(closed.pixelCount);

    // findUnfilledRegionsMask finds the enclosed interior when closeGap bridges the 2px gap
    const enclosed = findUnfilledRegionsMask(ref, w, h, {
      tolerance: 16,
      closeGap: 3,
      minArea: 10,
      includeEdge: false,
    });
    expect(enclosed).toHaveLength(1);
    expect(enclosed[0]!.touchesEdge).toBe(false);
    expect(enclosed[0]!.point.x).toBeGreaterThanOrEqual(12);
    expect(enclosed[0]!.point.x).toBeLessThanOrEqual(28);
    expect(enclosed[0]!.point.y).toBeGreaterThanOrEqual(12);
    expect(enclosed[0]!.point.y).toBeLessThanOrEqual(28);
  });
});

describe('PaintEditorController: fillRegion & findUnfilledRegions', () => {
  function makeInkedController() {
    const c = new PaintEditorController({ width: 64, height: 64 });
    const flatsId = c.document.layers[0]!.id;
    c.updateLayer(flatsId, { name: 'Flats' });
    const ink = c.addLayer({ name: 'Ink' });
    c.setBrush({ id: 'ink-pen', tip: { size: 3 } });
    // Closed box on the left: (8,12)..(28,48) with a tiny gap on the right wall at y=29..31
    c.paintStroke({ points: line(8, 12, 28, 12), layerId: ink.id, color: '#111111' });
    c.paintStroke({ points: line(28, 12, 28, 27), layerId: ink.id, color: '#111111' });
    c.paintStroke({ points: line(28, 33, 28, 48), layerId: ink.id, color: '#111111' });
    c.paintStroke({ points: line(28, 48, 8, 48), layerId: ink.id, color: '#111111' });
    c.paintStroke({ points: line(8, 48, 8, 12), layerId: ink.id, color: '#111111' });

    // Fully closed box on the right: (36,12)..(56,48)
    c.paintStroke({
      points: [
        ...line(36, 12, 56, 12, 12),
        ...line(56, 12, 56, 48, 12),
        ...line(56, 48, 36, 48, 12),
        ...line(36, 48, 36, 12, 12),
      ],
      layerId: ink.id,
      color: '#111111',
    });
    return { c, flatsId, inkId: ink.id };
  }

  it('finds enclosed regions from a reference ink layer and excludes already-filled shapes', () => {
    const { c, flatsId, inkId } = makeInkedController();

    // With closeGap: 6, both boxes are found as enclosed regions
    const before = c.findUnfilledRegions({
      layerId: flatsId,
      reference: inkId,
      closeGap: 6,
      minArea: 20,
    }).regions;
    expect(before.length).toBe(2);
    expect(before.every((r) => !r.touchesEdge)).toBe(true);

    // Fill the first region on the Flats layer referencing the Ink layer
    const first = before[0]!;
    const res = c.fillRegion({
      x: first.point.x,
      y: first.point.y,
      layerId: flatsId,
      reference: inkId,
      color: '#e07a5f',
      closeGap: 6,
      expand: 1,
    });
    expect(res.leaked).toBe(false);
    expect(res.pixelCount).toBeGreaterThan(200);
    expect(readPixel(layerOf(c, flatsId).surface, first.point.x, first.point.y)[3]).toBe(255);
    // Ink layer was not modified inside the box
    expect(readPixel(layerOf(c, inkId).surface, first.point.x, first.point.y)[3]).toBe(0);

    // Re-running findUnfilledRegions skips the region that is now filled on Flats
    const after = c.findUnfilledRegions({
      layerId: flatsId,
      reference: inkId,
      closeGap: 6,
      minArea: 20,
    }).regions;
    expect(after.length).toBe(1);
  });

  it('supports multi-point batch fill in one undo step, reference: "all", and paper grain modulation', () => {
    const { c, flatsId, inkId } = makeInkedController();
    const { regions } = c.findUnfilledRegions({
      layerId: flatsId,
      reference: inkId,
      closeGap: 6,
      minArea: 20,
    });
    expect(regions).toHaveLength(2);

    const res = c.fillRegion({
      points: regions.map((r) => r.point),
      layerId: flatsId,
      reference: 'all',
      color: '#3d5a80',
      closeGap: 6,
      expand: 1,
      grain: 0.5,
      pressure: 0.4,
    });
    expect(res.leaked).toBe(false);
    expect(res.regions.length).toBe(2);
    for (const r of regions) {
      expect(readPixel(layerOf(c, flatsId).surface, r.point.x, r.point.y)[3]).toBeGreaterThan(0);
    }

    // Single undo step reverts both regions
    c.undo();
    for (const r of regions) {
      expect(readPixel(layerOf(c, flatsId).surface, r.point.x, r.point.y)[3]).toBe(0);
    }
    c.redo();
    for (const r of regions) {
      expect(readPixel(layerOf(c, flatsId).surface, r.point.x, r.point.y)[3]).toBeGreaterThan(0);
    }
  });

  it('supports wet: true to pour a watercolour wash into the region on the wet layer', () => {
    const { c, flatsId, inkId } = makeInkedController();
    const { regions } = c.findUnfilledRegions({
      layerId: flatsId,
      reference: inkId,
      closeGap: 6,
      minArea: 20,
    });
    const pt = regions[0]!.point;
    const res = c.fillRegion({
      x: pt.x,
      y: pt.y,
      layerId: flatsId,
      reference: inkId,
      color: '#457b9d',
      closeGap: 6,
      wet: true,
    });
    expect(res.wet).toBe(true);
    expect(res.pixelCount).toBeGreaterThan(200);
    expect(c.wetState().wet).toBe(true);

    // Dry the wet layer into Flats
    const dried = c.dryPaint({ layerId: flatsId });
    expect(dried.dried.length).toBeGreaterThan(0);
    expect(readPixel(layerOf(c, flatsId).surface, pt.x, pt.y)[3]).toBeGreaterThan(0);
    c.dispose();
  });

  it('records fill-region events that serialize, shift on extendCanvas, and replay at 1x and 2x', async () => {
    const { c, flatsId, inkId } = makeInkedController();
    const { regions } = c.findUnfilledRegions({
      layerId: flatsId,
      reference: inkId,
      closeGap: 6,
      minArea: 20,
    });
    const pt = regions[0]!.point;
    c.fillRegion({
      x: pt.x,
      y: pt.y,
      layerId: flatsId,
      reference: inkId,
      color: '#f4a261',
      closeGap: 6,
      expand: 1,
    });

    // Serialize & deserialize preserves the fill-region event
    const json = serializePaintDocument(c.document);
    const roundtripped = deserializePaintDocument(json);
    expect(roundtripped.state.paintEvents?.some((e) => e.kind === 'fill-region')).toBe(true);

    // Replay at 1x and 2x
    const hi1 = await c.renderHighRes({ scale: 1 });
    const hi2 = await c.renderHighRes({ scale: 2 });
    expect(hi1.width).toBe(64);
    expect(hi2.width).toBe(128);
    const p1 = (pt.y * 64 + pt.x) * 4;
    const p2 = (pt.y * 2 * 128 + pt.x * 2) * 4;
    expect(hi1.data[p1]!).toBeGreaterThan(200);
    expect(hi2.data[p2]!).toBeGreaterThan(200);

    // Extending canvas on left/top shifts the fill-region seed coordinates
    c.extendCanvas({ left: 10, top: 8 });
    const fillEvent = c.document.paintEvents?.find((e) => e.kind === 'fill-region');
    const pts = fillEvent?.data?.points as Array<{ x: number; y: number }> | undefined;
    expect(pts?.[0]).toEqual({ x: pt.x + 10, y: pt.y + 8 });
  });

  it('PaintGesture fill tool fills on click and adjusts tolerance when dragged horizontally', () => {
    const c = new PaintEditorController({ width: 32, height: 32 });
    const layerId = c.document.layers[0]!.id;
    // Paint a soft barrier across x=16 so low tolerance stops at x=16 and high tolerance crosses it
    c.setBrush({ id: 'ink-pen', tip: { size: 3 } });
    c.paintStroke({ points: line(16, 0, 16, 32, 32), layerId, color: '#888888', opacity: 0.35 });

    const gesture = new PaintGesture(c, () => ({ left: 0, top: 0, width: 32, height: 32 }));
    gesture.tool = 'fill';
    gesture.fillOptions = { reference: 'layer', tolerance: 10, closeGap: 0, expand: 0 };

    gesture.down({ pointerId: 1, clientX: 6, clientY: 16, button: 0 });
    expect(readPixel(layerOf(c, layerId).surface, 6, 16)[3]).toBe(255);
    expect(readPixel(layerOf(c, layerId).surface, 26, 16)[3]).toBe(0);

    // Dragging right increases tolerance across the barrier as a single undo step
    gesture.move({ pointerId: 1, clientX: 506, clientY: 16 });
    gesture.up({ pointerId: 1, clientX: 506, clientY: 16 });
    expect(readPixel(layerOf(c, layerId).surface, 26, 16)[3]).toBe(255);

    // One undo reverts the whole interactive fill
    c.undo();
    expect(readPixel(layerOf(c, layerId).surface, 6, 16)[3]).toBe(0);
    expect(readPixel(layerOf(c, layerId).surface, 26, 16)[3]).toBe(0);
  });

  it('PaintGesture fill tool never undoes an earlier edit when its fill made no undo step', () => {
    const { c, flatsId, inkId } = makeInkedController();
    const inkAt = () => readPixel(layerOf(c, inkId).surface, 36, 30)[3];
    expect(inkAt()).toBeGreaterThan(0);
    const strokes = c.getStrokes().length;

    const gesture = new PaintGesture(c, () => ({ left: 0, top: 0, width: 64, height: 64 }));
    gesture.tool = 'fill';
    // Contracting by 16 px empties the 20 px wide box, so the fill commits nothing.
    gesture.fillOptions = { layerId: flatsId, reference: inkId, tolerance: 32, closeGap: 0, expand: -16 };

    expect(gesture.down({ pointerId: 1, clientX: 46, clientY: 30, button: 0 })).toBe(true);
    gesture.move({ pointerId: 1, clientX: 86, clientY: 30 });
    gesture.move({ pointerId: 1, clientX: 126, clientY: 30 });
    gesture.cancel();

    expect(c.getStrokes().length).toBe(strokes);
    expect(inkAt()).toBeGreaterThan(0);
    expect(readPixel(layerOf(c, flatsId).surface, 46, 30)[3]).toBe(0);
  });

  it('exposes fill_region and find_unfilled_regions through ToolRegistry with validation', async () => {
    const { c, flatsId, inkId } = makeInkedController();
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));

    const found = await reg.callTool('find_unfilled_regions', {
      layerId: flatsId,
      reference: inkId,
      closeGap: 6,
      minArea: 20,
    });
    expect(found.isError).toBeFalsy();
    const regions = (found.structuredContent as { regions: Array<{ point: { x: number; y: number } }> }).regions;
    expect(regions.length).toBe(2);

    const filled = await reg.callTool('fill_region', {
      points: regions.map((r) => r.point),
      layerId: flatsId,
      reference: inkId,
      color: '#81b29a',
      closeGap: 6,
      expand: 1,
    });
    expect(filled.isError).toBeFalsy();
    expect((filled.structuredContent as { leaked: boolean; pixelCount: number }).leaked).toBe(false);
    expect((filled.structuredContent as { pixelCount: number }).pixelCount).toBeGreaterThan(400);

    // Invalid calls fail usefully
    const missingSeed = await reg.callTool('fill_region', {
      layerId: flatsId,
      color: '#000000',
    });
    expect(missingSeed.isError).toBe(true);

    const outOfBounds = await reg.callTool('fill_region', {
      x: 999,
      y: 10,
      layerId: flatsId,
    });
    expect(outOfBounds.isError).toBe(true);

    const badRef = await reg.callTool('find_unfilled_regions', {
      layerId: flatsId,
      reference: 'no-such-layer',
    });
    expect(badRef.isError).toBe(true);
  });
});
