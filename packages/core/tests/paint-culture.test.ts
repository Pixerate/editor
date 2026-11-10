import { describe, expect, it } from 'vitest';
import {
  BRUSH_JSON_SCHEMA,
  BRUSH_PRESETS,
  migrateBrushV1,
  normalizeBrushSpec,
  resolveBrush,
} from '../src/brushes';
import { validateJsonSchema } from '../src/tools/schema';
import {
  PaintEditorController,
  PaintEditorError,
  createPaintEditorToolProvider,
  renderBrushThumbnail,
} from '../src/paint-editor';
import { ToolRegistry } from '../src/tools/registry';
import { readPixel } from '../src/raster/surface';
import { isqrt } from '../src/paint';
import { replayPainting, type PaintPixelLayer } from '../src/paint-editor';

describe('Biopaint mycelial ink (#684)', () => {
  it('1. validates culture facet & presets (mycelial-ink, rot, foxfire), round-trips PaintBrush, and unsets via null', async () => {
    for (const id of ['mycelial-ink', 'rot', 'foxfire'] as const) {
      const preset = BRUSH_PRESETS.find((b) => b.id === id);
      expect(preset, `preset ${id}`).toBeDefined();
      expect(preset!.culture).toBeDefined();
      const errs = validateJsonSchema(BRUSH_JSON_SCHEMA, preset);
      expect(errs).toEqual([]);

      const resolved = resolveBrush(preset!);
      expect(resolved.culture).toBeDefined();
      const roundTripped = migrateBrushV1(resolved);
      expect(roundTripped.culture).toEqual(normalizeBrushSpec(preset!).culture);
    }

    const c = new PaintEditorController({ width: 120, height: 120 });
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));

    await reg.callTool('paint-editor__set_brush', { id: 'mycelial-ink' });
    expect(c.getState().brush.culture).toBeDefined();

    const cleared = await reg.callTool('paint-editor__set_brush', {
      culture: null,
    });
    expect(cleared.isError).toBeFalsy();
    expect(c.getState().brush.culture).toBeUndefined();
  });

  it('2. seeds spores along a mycelial-ink stroke and grows threads outward beyond initial stroke bounds', () => {
    const c = new PaintEditorController({ width: 160, height: 160 });
    const strokeRes = c.paintStroke({
      brushId: 'mycelial-ink',
      seed: 7,
      points: [
        { x: 60, y: 80 },
        { x: 100, y: 80 },
      ],
    });
    expect(strokeRes.culture).toBeDefined();
    expect(strokeRes.culture!.seeds).toBeGreaterThan(0);
    const strokeBounds = strokeRes.bounds!;
    expect(strokeBounds).not.toBeNull();

    const beforeLayer = c.compositePixels({ paper: false });
    const countOutside = (data: Uint8ClampedArray) => {
      let count = 0;
      for (let y = 0; y < 160; y++) {
        for (let x = 0; x < 160; x++) {
          const inside =
            x >= strokeBounds.x &&
            x < strokeBounds.x + strokeBounds.width &&
            y >= strokeBounds.y &&
            y < strokeBounds.y + strokeBounds.height;
          if (!inside && data[(y * 160 + x) * 4 + 3]! > 0) count++;
        }
      }
      return count;
    };
    expect(countOutside(beforeLayer.data)).toBe(0);

    const grown = c.growCultures({ steps: 60 });
    expect(grown.segmentsAdded).toBeGreaterThan(50);
    expect(grown.bounds).not.toBeNull();
    const spanBefore = Math.max(strokeBounds.width, strokeBounds.height);
    const spanAfter = Math.max(grown.bounds!.width, grown.bounds!.height);
    expect(spanAfter - spanBefore).toBeGreaterThanOrEqual(15);

    const afterLayer = c.compositePixels({ paper: false });
    expect(countOutside(afterLayer.data)).toBeGreaterThan(25);
  });

  it('3 & 4. steers toward existing paint (appetite), digests and fades what it eats, and carries its colour along the network', () => {
    const setupColony = (appetite: number, digest: number) => {
      const c = new PaintEditorController({ width: 200, height: 200 });
      // Paint a solid #e11d48 circle of radius 24 at (110, 100) using a round hard brush
      c.paintStroke({
        brushId: 'ink-pen',
        color: '#e11d48',
        brush: { tip: { size: 48, hardness: 1, opacity: 1, flow: 1 } },
        points: [{ x: 110, y: 100 }],
      });
      const foodCheck = c.compositePixels({ paper: false }).data;
      const foodMask = new Uint8Array(200 * 200);
      let initialFoodAlpha = 0;
      for (let i = 0; i < 200 * 200; i++) {
        const a = foodCheck[i * 4 + 3]!;
        if (a > 0) {
          foodMask[i] = 1;
          initialFoodAlpha += a;
        }
      }

      // Seed mycelial-ink at (40, 100)
      c.paintStroke({
        brushId: 'mycelial-ink',
        color: '#1a1917',
        seed: 11,
        brush: {
          culture: {
            appetite,
            digest,
          },
        },
        points: [
          { x: 40, y: 92 },
          { x: 40, y: 108 },
        ],
      });
      const beforeGrow = new Uint8ClampedArray(c.compositePixels({ paper: false }).data);
      c.growCultures({ steps: 120 });
      const afterGrow = c.compositePixels({ paper: false }).data;

      let rightHalfNewPixels = 0;
      let afterFoodAlpha = 0;
      let exitRedSum = 0;
      let exitGreenSum = 0;
      let exitCount = 0;

      for (let y = 0; y < 200; y++) {
        for (let x = 0; x < 200; x++) {
          const idx = y * 200 + x;
          const p = idx * 4;
          const aBefore = beforeGrow[p + 3]!;
          const aAfter = afterGrow[p + 3]!;
          const rChanged = afterGrow[p] !== beforeGrow[p] || afterGrow[p + 1] !== beforeGrow[p + 1] || afterGrow[p + 2] !== beforeGrow[p + 2];
          if (foodMask[idx]) {
            afterFoodAlpha += aAfter;
            if (x >= 75 && rChanged) rightHalfNewPixels++;
          } else if (x >= 75 && aBefore === 0 && aAfter > 0) {
            rightHalfNewPixels++;
          }
          if (x > 134 && !foodMask[idx] && aAfter > 0) {
            exitRedSum += afterGrow[p]!;
            exitGreenSum += afterGrow[p + 1]!;
            exitCount++;
          }
        }
      }

      return {
        rightHalfNewPixels,
        initialFoodAlpha,
        afterFoodAlpha,
        exitMeanR: exitCount > 0 ? exitRedSum / exitCount : 0,
        exitMeanG: exitCount > 0 ? exitGreenSum / exitCount : 0,
        exitCount,
      };
    };

    const hungry = setupColony(0.9, 0.6);
    const blind = setupColony(0, 0.6);
    const nonDigest = setupColony(0.9, 0);

    // Criterion 3: chemotaxis places strictly more new mycelium pixels in x >= 75 with appetite 0.9 than appetite 0
    expect(hungry.rightHalfNewPixels).toBeGreaterThan(blind.rightHalfNewPixels);

    // Criterion 4: digestion reduces total alpha inside the circle mask when digest: 0.6, and not when digest: 0
    expect(hungry.afterFoodAlpha).toBeLessThan(hungry.initialFoodAlpha);
    expect(nonDigest.afterFoodAlpha).toBeGreaterThanOrEqual(nonDigest.initialFoodAlpha);

    // Criterion 4: threads exiting the circle (x > 134) carry the red colour (mean R > G + 40)
    expect(hungry.exitCount).toBeGreaterThan(0);
    expect(hungry.exitMeanR).toBeGreaterThan(hungry.exitMeanG + 40);
  });

  it('5. fuses meeting threads (anastomosis) across parallel strokes and stops fused tips cleanly', () => {
    const runParallel = (fuse: number) => {
      const c = new PaintEditorController({ width: 160, height: 160 });
      c.paintStroke({
        brushId: 'mycelial-ink',
        seed: 3,
        brush: { culture: { fuse, reach: 20 } },
        points: [
          { x: 40, y: 68 },
          { x: 120, y: 68 },
        ],
      });
      c.paintStroke({
        brushId: 'mycelial-ink',
        seed: 3,
        brush: { culture: { fuse, reach: 20 } },
        points: [
          { x: 40, y: 92 },
          { x: 120, y: 92 },
        ],
      });
      const res = c.growCultures({ steps: 80 });
      const px = c.compositePixels({ paper: false }).data;
      let midStripPixels = 0;
      for (let y = 78; y <= 82; y++) {
        for (let x = 40; x <= 120; x++) {
          if (px[(y * 160 + x) * 4 + 3]! > 0) midStripPixels++;
        }
      }
      return { midStripPixels, tipsAlive: res.tipsAlive };
    };

    const fused = runParallel(0.9);
    const unfused = runParallel(0);
    expect(fused.midStripPixels).toBeGreaterThan(0);
    expect(fused.tipsAlive).toBeLessThan(unfused.tipsAlive);
  });
  it('6. respects mask stencil walls and layer lockTransparency', () => {
    // Stencil mask covering x < 80 allowed (invert: false rect { x: 0, y: 0, width: 80, height: 140 })
    const c1 = new PaintEditorController({ width: 140, height: 140 });
    c1.addStencil({
      kind: 'shape',
      shape: 'rectangle',
      mode: 'mask',
      rect: { x: 0, y: 0, width: 80, height: 140 },
    });
    c1.paintStroke({
      brushId: 'mycelial-ink',
      seed: 19,
      points: [
        { x: 65, y: 50 },
        { x: 65, y: 90 },
      ],
    });
    c1.growCultures({ steps: 80 });
    const px1 = c1.compositePixels({ paper: false }).data;
    let outsideMask = 0;
    for (let y = 0; y < 140; y++) {
      for (let x = 80; x < 140; x++) {
        if (px1[(y * 140 + x) * 4 + 3]! > 0) outsideMask++;
      }
    }
    expect(outsideMask).toBe(0);

    // lockTransparency: true restricts growth to existing non-zero alpha pixels
    const c2 = new PaintEditorController({ width: 140, height: 140 });
    const layerId = c2.document.activeLayerId!;
    c2.paintStroke({
      brushId: 'ink-pen',
      color: '#f59e0b',
      brush: { tip: { size: 48, hardness: 1, opacity: 1, flow: 1 } },
      points: [{ x: 70, y: 70 }],
    });
    const beforeLock = new Uint8ClampedArray(c2.compositePixels({ paper: false }).data);
    c2.updateLayer(layerId, { locks: { transparency: true } });
    c2.paintStroke({
      brushId: 'mycelial-ink',
      seed: 23,
      points: [
        { x: 65, y: 70 },
        { x: 75, y: 70 },
      ],
    });
    c2.growCultures({ steps: 80 });
    const afterLock = c2.compositePixels({ paper: false }).data;
    let leakedOutsideShape = 0;
    for (let i = 0; i < 140 * 140; i++) {
      if (beforeLock[i * 4 + 3] === 0 && afterLock[i * 4 + 3]! > 0) {
        leakedOutsideShape++;
      }
    }
    expect(leakedOutsideShape).toBe(0);
  });

  it('7. foxfire writes bioluminescence to doc.light and brightens dark paper', () => {
    const runFoxfire = (glow: number) => {
      const c = new PaintEditorController({ width: 140, height: 140 });
      c.setPaper({ color: '#0e0e12' });
      c.paintStroke({
        brushId: 'foxfire',
        seed: 29,
        brush: { culture: { glow } },
        points: [
          { x: 50, y: 70 },
          { x: 90, y: 70 },
        ],
      });
      c.growCultures({ steps: 60 });
      return c;
    };

    const glowing = runFoxfire(0.65);
    const dim = runFoxfire(0);

    const lightInfo = glowing.lightOf();
    expect(lightInfo.hasLight).toBe(true);
    expect(dim.lightOf().hasLight).toBe(false);

    const glowPx = glowing.compositePixels({ paper: true }).data;
    const dimPx = dim.compositePixels({ paper: true }).data;
    let glowLuma = 0;
    let dimLuma = 0;
    for (let i = 0; i < 140 * 140 * 4; i += 4) {
      glowLuma += glowPx[i]! + glowPx[i + 1]! + glowPx[i + 2]!;
      dimLuma += dimPx[i]! + dimPx[i + 1]! + dimPx[i + 2]!;
    }
    expect(glowLuma).toBeGreaterThan(dimLuma + 5000);
  });

  it('8. is bit-exact deterministic: growing 100 steps once equals growing 50 steps twice', () => {
    const makeDoc = () => {
      const c = new PaintEditorController({ width: 160, height: 160 });
      c.paintStroke({
        brushId: 'ink-pen',
        color: '#2563eb',
        brush: { size: 36, hardness: 1 },
        points: [{ x: 100, y: 80 }],
      });
      c.paintStroke({
        brushId: 'mycelial-ink',
        seed: 42,
        points: [
          { x: 55, y: 75 },
          { x: 75, y: 85 },
        ],
      });
      return c;
    };

    const a = makeDoc();
    const initialJson = a.toJSON();
    const b = new PaintEditorController({ width: 160, height: 160 });
    b.loadJSON(initialJson);

    a.growCultures({ steps: 100 });
    b.growCultures({ steps: 50 });
    b.growCultures({ steps: 50 });

    const pxA = a.compositePixels({ paper: true }).data;
    const pxB = b.compositePixels({ paper: true }).data;
    expect(Buffer.from(pxA).equals(Buffer.from(pxB))).toBe(true);
    expect(a.getCultures(0)).toEqual(b.getCultures(0));
  });

  it('9. supports single-step undo of grow_cultures and remove_cultures (keeping drawn threads)', () => {
    const c = new PaintEditorController({ width: 140, height: 140 });
    c.paintStroke({
      brushId: 'mycelial-ink',
      seed: 13,
      points: [
        { x: 50, y: 70 },
        { x: 90, y: 70 },
      ],
    });
    const beforeGrowPx = new Uint8ClampedArray(c.compositePixels().data);
    const beforeGrowCultures = c.getCultures(0);

    c.growCultures({ steps: 50 });
    const afterGrowPx = new Uint8ClampedArray(c.compositePixels().data);
    expect(Buffer.from(afterGrowPx).equals(Buffer.from(beforeGrowPx))).toBe(false);

    // Undo restores exact pre-growth pixels and tip state (and pauses live growth until next stroke/grow)
    expect(c.undo()).toBe('Grow culture');
    expect(Buffer.from(c.compositePixels().data).equals(Buffer.from(beforeGrowPx))).toBe(true);
    expect(c.getCultures(0).layers).toEqual(beforeGrowCultures.layers);
    expect(c.getCultures(0).paused).toBe(true);

    // Redo brings back grown state
    c.redo();
    expect(Buffer.from(c.compositePixels().data).equals(Buffer.from(afterGrowPx))).toBe(true);

    // remove_cultures kills living tips while keeping drawn threads
    const killed = c.removeCultures();
    expect(killed.removedTips).toBeGreaterThan(0);
    expect(killed.status).toBe('extinct');
    expect(c.getCultures(0).layers[0]!.tips).toBe(0);
    expect(Buffer.from(c.compositePixels().data).equals(Buffer.from(afterGrowPx))).toBe(true);

    // Undo of remove_cultures revives tips
    expect(c.undo()).toBe('Kill culture');
    expect(c.getCultures(0).layers[0]!.tips).toBe(killed.removedTips);
  });

  it('10. round-trips living tips through toJSON / loadJSON and catches up growWhileClosed on reopen', () => {
    const c1 = new PaintEditorController({ width: 140, height: 140 });
    c1.paintStroke({
      brushId: 'mycelial-ink',
      seed: 51,
      points: [
        { x: 50, y: 70 },
        { x: 90, y: 70 },
      ],
    });
    c1.growCultures({ steps: 20 });

    const saved = c1.toJSON();
    const c2 = new PaintEditorController({ width: 64, height: 64 });
    expect(c2.loadJSON(saved)).toEqual([]);

    c1.growCultures({ steps: 40 });
    c2.growCultures({ steps: 40 });
    expect(Buffer.from(c2.compositePixels().data).equals(Buffer.from(c1.compositePixels().data))).toBe(true);

    // growWhileClosed + catchUpCultures
    const c3 = new PaintEditorController({ width: 140, height: 140 });
    c3.setCultureOptions({ growWhileClosed: true });
    c3.paintStroke({
      brushId: 'mycelial-ink',
      seed: 61,
      points: [
        { x: 50, y: 70 },
        { x: 90, y: 70 },
      ],
    });
    const savedClosed = c3.toJSON();
    const savedAt = (savedClosed.cultures as { lastGrownAt?: number }).lastGrownAt!;
    expect(typeof savedAt).toBe('number');

    const c4 = new PaintEditorController({ width: 64, height: 64 });
    c4.loadJSON(savedClosed);
    // adopt() stays pure: no undo step yet, and pendingCatchUpTicks > 0 10s later
    const tenSecondsLater = savedAt + 10_000;
    const beforeCatchUp = c4.getCultures(tenSecondsLater);
    expect(beforeCatchUp.growWhileClosed).toBe(true);
    expect(beforeCatchUp.pendingCatchUpTicks).toBeGreaterThan(0);

    const catchUpRes = c4.catchUpCultures(tenSecondsLater);
    expect(catchUpRes).not.toBeNull();
    expect(catchUpRes!.segmentsAdded).toBeGreaterThan(0);
    expect(c4.getState().undoLabel).toBe('Growth while closed');
    expect(c4.undo()).toBe('Growth while closed');
  });

  it('11. replays culture growth at 2x resolution via renderHighRes without re-simulating', async () => {
    const c = new PaintEditorController({ width: 120, height: 120 });
    c.paintStroke({
      brushId: 'mycelial-ink',
      seed: 77,
      points: [
        { x: 45, y: 60 },
        { x: 75, y: 60 },
      ],
    });
    const strokeBounds = c.getStrokes()[0]!.points;
    void strokeBounds;
    const grown = c.growCultures({ steps: 50 });
    expect(grown.segmentsAdded).toBeGreaterThan(30);

    const hi = await c.renderHighRes({ scale: 2, paper: false });
    expect(hi.width).toBe(240);
    expect(hi.height).toBe(240);

    // Count painted pixels at 2x outside the 2x stroke strip (y < 108 or y > 132)
    let hiGrownPixels = 0;
    for (let y = 0; y < 240; y++) {
      if (y >= 108 && y <= 132) continue;
      for (let x = 0; x < 240; x++) {
        if (hi.data[(y * 240 + x) * 4 + 3]! > 0) hiGrownPixels++;
      }
    }
    expect(hiGrownPixels).toBeGreaterThan(60);
  });

  it('12 & 13. handles layer lifecycle (duplicate, mergeDown, clear, remove), thumbnails, and refusals', async () => {
    const c = new PaintEditorController({ width: 120, height: 120, wet: { kernel: 'wasm', threads: 0 } });
    const baseId = c.document.activeLayerId!;
    c.paintStroke({
      brushId: 'mycelial-ink',
      seed: 9,
      points: [
        { x: 40, y: 60 },
        { x: 80, y: 60 },
      ],
    });
    expect(c.getCultures().layers).toHaveLength(1);

    // Duplicate layer copies the colony
    const dup = c.duplicateLayer(baseId);
    expect(c.getCultures().layers.map((l) => l.layerId)).toEqual([baseId, dup.id]);

    // Merge down combines both colonies onto baseId without orphan entries
    c.mergeDown(dup.id);
    expect(c.getCultures().layers.map((l) => l.layerId)).toEqual([baseId]);
    expect(c.document.cultures?.[dup.id]).toBeUndefined();

    // Clear layer removes the colony
    c.clearLayer(baseId);
    expect(c.document.cultures?.[baseId]).toBeUndefined();

    // Brush thumbnail runs a short fixed growth run for culture brushes
    const preset = c.getBrush('mycelial-ink')!;
    const thumbWithCulture = renderBrushThumbnail(preset, { paper: c.document.paper, color: '#1a1917', width: 96, height: 36 });
    const thumbWithoutCulture = renderBrushThumbnail({ ...preset, culture: undefined }, { paper: c.document.paper, color: '#1a1917', width: 96, height: 36 });
    expect(Buffer.from(thumbWithCulture.data).equals(Buffer.from(thumbWithoutCulture.data))).toBe(false);

    // Refusals: stroke layer, effect layer, wet layer with wet paint, and invalid steps
    const strokeLayer = c.addLayer({ name: 'Live strokes', type: 'strokes' });
    expect(() =>
      c.paintStroke({
        layerId: strokeLayer.id,
        brushId: 'mycelial-ink',
        points: [
          { x: 20, y: 20 },
          { x: 40, y: 20 },
        ],
      })
    ).toThrow(PaintEditorError);
    expect(() => c.growCultures({ layerId: strokeLayer.id, steps: 10 })).toThrow(/stroke layer/i);

    expect(() => c.growCultures({ steps: 0 })).toThrow(PaintEditorError);
    expect(() => c.growCultures({ steps: 2001 })).toThrow(PaintEditorError);

    c.setActiveLayer(baseId);
    c.paintStroke({
      brushId: 'watercolor-round',
      points: [
        { x: 30, y: 30 },
        { x: 60, y: 30 },
      ],
    });
    await c.wetIdle();
    expect(() => c.growCultures({ layerId: baseId, steps: 10 })).toThrow(/dry_paint/i);
  });

  it('14. drives live growth via playCultures(clock), seeds symmetry copies, and exposes tools via ToolRegistry', async () => {
    const c = new PaintEditorController({ width: 140, height: 140 });
    c.setSymmetry({ mode: 'vertical', center: { x: 70, y: 70 } });
    const single = new PaintEditorController({ width: 140, height: 140 });
    const s1 = single.paintStroke({
      brushId: 'mycelial-ink',
      seed: 12,
      points: [
        { x: 30, y: 50 },
        { x: 30, y: 90 },
      ],
    });
    const s2 = c.paintStroke({
      brushId: 'mycelial-ink',
      seed: 12,
      points: [
        { x: 30, y: 50 },
        { x: 30, y: 90 },
      ],
    });
    expect(s2.culture!.seeds).toBeGreaterThan(s1.culture!.seeds);

    // Live clock playback
    let nowMs = 1000;
    let frameCb: (() => void) | null = null;
    const player = c.playCultures({
      now: () => nowMs,
      frame: (cb) => {
        frameCb = cb;
        return () => {
          if (frameCb === cb) frameCb = null;
        };
      },
    });
    for (let i = 0; i < 6; i++) {
      nowMs += 100;
      frameCb?.();
    }
    expect(c.getCultures().layers[0]!.tick).toBeGreaterThan(0);
    // Undo flushes the live preview as a single undo step and then undoes it + pauses live growth
    expect(c.undo()).toBe('Culture growth');
    expect(c.getCultures().paused).toBe(true);
    player.stop();

    // Agent ToolRegistry calls
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));
    const grownRes = await reg.callTool('grow_cultures', { steps: 15 });
    expect(grownRes.isError).toBeFalsy();
    const badRes = await reg.callTool('grow_cultures', { steps: -1 });
    expect(badRes.isError).toBe(true);
    const optRes = await reg.callTool('set_culture_options', { growWhileClosed: true });
    expect(optRes.isError).toBeFalsy();
    const readRes = await reg.callTool('get_cultures', {});
    expect(readRes.isError).toBeFalsy();
    const killRes = await reg.callTool('remove_cultures', {});
    expect(killRes.isError).toBeFalsy();
  });

  it('15. isqrt stays exact past int32 (long seed segments seed like Swift)', () => {
    for (const px of [181, 182, 300, 500, 4000]) {
      const fp = px * 256;
      expect(isqrt(fp * fp), `${px}px`).toBe(fp);
      expect(isqrt(fp * fp + 1)).toBe(fp);
      expect(isqrt(fp * fp - 1)).toBe(fp - 1);
    }
    // Two points 500 px apart: the gap is seeded along its length, not as one station.
    const c = new PaintEditorController({ width: 600, height: 120 });
    const r = c.paintStroke({ brushId: 'mycelial-ink', seed: 3, points: [{ x: 50, y: 60 }, { x: 550, y: 60 }] });
    expect(r.culture!.seeds).toBeGreaterThan(8);
  });

  it('16. a command during live growth keeps the growth as its own undo step, with its replay events', () => {
    const c = new PaintEditorController({ width: 140, height: 140 });
    c.paintStroke({ brushId: 'mycelial-ink', seed: 5, points: [{ x: 30, y: 50 }, { x: 30, y: 90 }] });
    let nowMs = 1000;
    let frameCb: (() => void) | null = null;
    const player = c.playCultures({ now: () => nowMs, frame: (cb) => { frameCb = cb; return () => { if (frameCb === cb) frameCb = null; }; } });
    for (let i = 0; i < 6; i++) {
      nowMs += 100;
      frameCb?.();
    }
    c.addLayer({ name: 'Over' });
    player.stop();
    const events = JSON.stringify(c.toJSON().paintEvents ?? []);
    expect(events).toContain('culture-grow');
    expect(c.undo()).not.toBe('Culture growth');
    expect(c.undo()).toBe('Culture growth');
  });

  it('17. an antimatter stroke over a growing culture keeps the growth, frees the threads it burns as food, and replays to the same pixels', async () => {
    const c = new PaintEditorController({ width: 96, height: 96 });
    const layerId = c.getState().document.activeLayerId!;
    c.paintStroke({ brushId: 'mycelial-ink', brush: { culture: { digest: 0 } }, seed: 5, points: [{ x: 30, y: 48 }, { x: 66, y: 48 }] });
    let nowMs = 1000;
    let frameCb: (() => void) | null = null;
    const player = c.playCultures({ now: () => nowMs, frame: (cb) => { frameCb = cb; return () => { if (frameCb === cb) frameCb = null; }; } });
    for (let i = 0; i < 6; i++) {
      nowMs += 100;
      frameCb?.();
    }
    // Live: the antimatter stroke starts while the culture preview is showing.
    const live = c.beginStroke({ brushId: 'antimatter', brush: { antimatter: { duration: 0 } }, seed: 9 });
    live.push([{ x: 48, y: 48, pressure: 1 }]);
    live.end();
    // From data, after more growth.
    for (let i = 0; i < 4; i++) {
      nowMs += 100;
      frameCb?.();
    }
    player.stop();
    const threads = () => {
      let n = 0;
      for (const t of c.document.cultures![layerId]!.occupancy.tiles.values()) for (const v of t.data) if (v >= 2) n++;
      return n;
    };
    const threadsBefore = threads();
    const res = c.paintStroke({ brushId: 'antimatter', brush: { antimatter: { duration: 0 } }, seed: 11, points: [{ x: 36, y: 48, pressure: 1 }] });
    // The threads the blast inverted or scorched are foreign paint now (food), as after any other stroke.
    expect(threads()).toBeLessThan(threadsBefore);
    expect(res.antimatter!.blasts).toBeGreaterThan(0);
    expect(res.antimatter!.layers).toEqual([layerId]);
    const doc = c.document;
    const grows = (doc.paintEvents ?? []).filter((e) => e.kind === 'culture-grow');
    expect(grows.length).toBeGreaterThanOrEqual(2);
    // Each growth run lands before the antimatter stroke that followed it.
    expect(grows[0]!.at).toBe(1);
    expect(doc.strokes.map((s) => s.brush.engine)).toEqual(['dab', 'antimatter', 'antimatter']);
    // The culture keeps living on the burnt layer.
    expect(c.getCultures().layers.some((x) => x.layerId === layerId)).toBe(true);
    c.growCultures({ steps: 5 });
    const target = c.createReplayTarget(1);
    await replayPainting(c.document, target, { scale: 1 });
    const a = (c.getLayer(layerId) as PaintPixelLayer).surface;
    const b = (target.getLayer(layerId) as PaintPixelLayer).surface;
    let diff = 0;
    for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
      const u = readPixel(a, x, y);
      const v = readPixel(b, x, y);
      for (let k = 0; k < 4; k++) diff = Math.max(diff, Math.abs(u[k]! - v[k]!));
    }
    expect(diff).toBeLessThanOrEqual(1);
    // Undo walks back the stroke, then the growth run before it, as separate steps.
    expect(c.undo()).toBe('Grow culture');
    expect(c.undo()).toBe('Antimatter stroke');
    expect(c.undo()).toBe('Culture growth');
    expect(c.undo()).toBe('Antimatter stroke');
    expect(c.undo()).toBe('Culture growth');
  });

  it('18. a stroke frees only the threads it paints over, so a stroke elsewhere leaves the culture and its replay alone', async () => {
    const c = new PaintEditorController({ width: 96, height: 96 });
    const layerId = c.getState().document.activeLayerId!;
    c.paintStroke({ brushId: 'mycelial-ink', seed: 5, points: [{ x: 30, y: 48 }, { x: 66, y: 48 }] });
    c.growCultures({ steps: 6 });
    const threads = () => {
      let n = 0;
      for (const t of c.document.cultures![layerId]!.occupancy.tiles.values()) for (const v of t.data) if (v >= 2) n++;
      return n;
    };
    const before = threads();
    expect(before).toBeGreaterThan(0);
    c.paintStroke({ brushId: 'pencil-hb', seed: 11, points: [{ x: 85, y: 5 }, { x: 90, y: 8 }] });
    expect(threads()).toBe(before);
    c.growCultures({ steps: 6 });
    // Nothing was freed, so the culture found no foreign paint to digest: the replay matches exactly.
    const grows = (c.document.paintEvents ?? []).filter((e) => e.kind === 'culture-grow');
    expect((grows[1]!.data as { fades: unknown[] }).fades).toEqual([]);
    const target = c.createReplayTarget(1);
    await replayPainting(c.document, target, { scale: 1 });
    const a = (c.getLayer(layerId) as PaintPixelLayer).surface;
    const b = (target.getLayer(layerId) as PaintPixelLayer).surface;
    let diff = 0;
    for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
      const u = readPixel(a, x, y);
      const v = readPixel(b, x, y);
      for (let k = 0; k < 4; k++) diff = Math.max(diff, Math.abs(u[k]! - v[k]!));
    }
    expect(diff).toBe(0);
    const n = threads();
    c.paintStroke({ brushId: 'pencil-hb', seed: 12, points: [{ x: 30, y: 40 }, { x: 66, y: 56 }] });
    expect(threads()).toBeLessThan(n);
  });
});
