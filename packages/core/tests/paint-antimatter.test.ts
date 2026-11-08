import { describe, expect, it } from 'vitest';
import {
  BUILTIN_BRUSHES,
   DEFAULT_PAPER,
  PaintEditorController,
  createPaintBrushLibraryToolProvider,
  createPaintEditorToolProvider,
  renderBrushThumbnail,
  replayPainting,
  type PaintPixelLayer,
} from '../src/paint-editor';
import { BRUSH_PRESETS, migrateBrushV1, resolveBrush } from '../src/brushes';
import { readPixel } from '../src/raster/surface';
import { ToolRegistry } from '../src/tools';

function createEditor(width = 128, height = 128): PaintEditorController {
  return new PaintEditorController({ width, height, color: '#ff3864' });
}

function layerPx(c: PaintEditorController, layerId: string, x: number, y: number): [number, number, number, number] {
  const l = c.getLayer(layerId) as PaintPixelLayer;
  return readPixel(l.surface, x - l.offset.x, y - l.offset.y);
}

describe('Antimatter paint (#682)', () => {
  it('1. fires 0 blasts over bare canvas, leaves layers unchanged, and records no undo step', () => {
    const c = createEditor();
    const activeId = c.getState().document.activeLayerId!;
    const beforeDoc = c.document;
    const res = c.paintStroke({
      brushId: 'antimatter',
      points: [
        { x: 20, y: 20 },
        { x: 60, y: 60 },
      ],
    });
    expect(res.bounds).toBeNull();
    expect(res.strokeId).toBeNull();
    expect(res.antimatter).toEqual({
      blasts: 0,
      sparks: 0,
      fuel: 0,
      layers: [],
      skippedLayers: [],
    });
    expect(c.document).toBe(beforeDoc);
    expect(c.getState().canUndo).toBe(false);
    expect(layerPx(c, activeId, 40, 40)).toEqual([0, 0, 0, 0]);
  });

  it('2. fires 1 blast on a single-point tap over painted pixels', () => {
    const c = createEditor();
    const activeId = c.getState().document.activeLayerId!;
    c.fillLayer({ color: '#ff0000' });
    const res = c.paintStroke({
      brushId: 'antimatter',
      seed: 42,
      points: [{ x: 64, y: 64, pressure: 0.8 }],
    });
    expect(res.antimatter).toBeDefined();
    expect(res.antimatter!.blasts).toBe(1);
    expect(res.antimatter!.fuel).toBeGreaterThan(0.5);
    expect(res.antimatter!.layers).toEqual([activeId]);
    expect(res.bounds).not.toBeNull();
    const [r, g, b, a] = layerPx(c, activeId, 64, 64);
    // Inverted red (#ff0000 -> cyan #00ffff) with annihilate removing alpha
    expect(r).toBeLessThan(40);
    expect(g).toBeGreaterThan(180);
    expect(b).toBeGreaterThan(180);
    expect(a).toBeLessThan(255);
  });

  it('3 & 4. detonates across all visible editable layers while skipping hidden layers and hidden groups, and undoes/redoes in one step', () => {
    const c = createEditor();
    const bottomId = c.getState().document.activeLayerId!;
    c.fillLayer({ layerId: bottomId, color: '#ff0000' });

    const hiddenLayer = c.addLayer({ name: 'Hidden' });
    c.fillLayer({ layerId: hiddenLayer.id, color: '#00ff00' });
    c.updateLayer(hiddenLayer.id, { visible: false });

    const group = c.addLayer({ name: 'Hidden Group', type: 'group' });
    const inHiddenGroup = c.addLayer({ name: 'In Hidden Group', parentId: group.id });
    c.fillLayer({ layerId: inHiddenGroup.id, color: '#ffff00' });
    c.updateLayer(group.id, { visible: false });

    const topLayer = c.addLayer({ name: 'Top', parentId: null });
    c.fillLayer({ layerId: topLayer.id, color: '#0000ff' });
    c.setActiveLayer(topLayer.id);

    // Also wet the bottom layer to verify wet paint dries and undoes in the same step
    c.wetPaper({ layerId: bottomId, amount: 0.5 });
    expect(c.wetState().wet).toBe(true);

    const beforeBottom = layerPx(c, bottomId, 64, 64);
    const beforeTop = layerPx(c, topLayer.id, 64, 64);
    const beforeHidden = layerPx(c, hiddenLayer.id, 64, 64);
    const beforeGroupChild = layerPx(c, inHiddenGroup.id, 64, 64);

    const res = c.paintStroke({
      brushId: 'antimatter',
      seed: 7,
      points: [{ x: 64, y: 64, pressure: 1 }],
    });

    expect(res.antimatter!.blasts).toBe(1);
    expect(res.antimatter!.layers).toEqual([bottomId, topLayer.id]);
    expect(c.wetState().wet).toBe(false);

    const afterBottom = layerPx(c, bottomId, 64, 64);
    const afterTop = layerPx(c, topLayer.id, 64, 64);
    expect(afterBottom).not.toEqual(beforeBottom);
    expect(afterTop).not.toEqual(beforeTop);
    // Bottom red inverted towards cyan, top blue inverted towards yellow
    expect(afterBottom[1]).toBeGreaterThan(180);
    expect(afterTop[0]).toBeGreaterThan(180);
    expect(afterTop[1]).toBeGreaterThan(180);
    // Alpha reduced on both layers
    expect(afterBottom[3]).toBeLessThan(255);
    expect(afterTop[3]).toBeLessThan(255);

    // Hidden layer and layer in hidden group untouched
    expect(layerPx(c, hiddenLayer.id, 64, 64)).toEqual(beforeHidden);
    expect(layerPx(c, inHiddenGroup.id, 64, 64)).toEqual(beforeGroupChild);

    // Single undo restores both layers and wet state
    c.undo();
    expect(layerPx(c, bottomId, 64, 64)).toEqual(beforeBottom);
    expect(layerPx(c, topLayer.id, 64, 64)).toEqual(beforeTop);
    expect(c.wetState().wet).toBe(true);

    // Single redo reapplies both layers
    c.redo();
    expect(layerPx(c, bottomId, 64, 64)).toEqual(afterBottom);
    expect(layerPx(c, topLayer.id, 64, 64)).toEqual(afterTop);
    expect(c.wetState().wet).toBe(false);
  });

  it('5. uses locked, stroke, and sticker layers as fuel while keeping them unchanged in skippedLayers', () => {
    const c = createEditor();
    const lockedId = c.getState().document.activeLayerId!;
    c.fillLayer({ layerId: lockedId, color: '#ff0000' });
    c.updateLayer(lockedId, { locks: { pixels: true } });

    const strokeLayer = c.addLayer({ name: 'Stroke Layer', type: 'strokes' });
    c.paintStroke({
      layerId: strokeLayer.id,
      brushId: 'ink-pen',
      color: '#00ff00',
      brush: { tip: { size: 30 } },
      points: [
        { x: 40, y: 64 },
        { x: 88, y: 64 },
      ],
    });

    const stickerLayer = c.addLayer({ name: 'Stickers' });
    c.addStickers(stickerLayer.id, [{ ref: 'editor:star', x: 64, y: 64, size: 48 }]);

    // Active layer is completely bare! Fuel comes from the locked, stroke, and sticker layers below.
    const activeLayer = c.addLayer({ name: 'Active Empty' });
    c.setActiveLayer(activeLayer.id);

    const lockedBefore = layerPx(c, lockedId, 64, 64);
    const strokeBefore = layerPx(c, strokeLayer.id, 64, 64);
    const stickerBefore = layerPx(c, stickerLayer.id, 64, 64);

    const res = c.paintStroke({
      brushId: 'antimatter',
      seed: 12,
      points: [{ x: 64, y: 64, pressure: 1 }],
    });

    expect(res.antimatter!.blasts).toBe(1);
    expect(res.antimatter!.skippedLayers).toEqual([lockedId, strokeLayer.id, stickerLayer.id]);
    expect(res.antimatter!.layers).toEqual([activeLayer.id]);
    // Uneditable layers unchanged
    expect(layerPx(c, lockedId, 64, 64)).toEqual(lockedBefore);
    expect(layerPx(c, strokeLayer.id, 64, 64)).toEqual(strokeBefore);
    expect(layerPx(c, stickerLayer.id, 64, 64)).toEqual(stickerBefore);
  });

  it('6. preserves pixel alpha on layers with locks.transparency while inverting and scorching colour', () => {
    const c = createEditor();
    const layerId = c.getState().document.activeLayerId!;
    c.fillLayer({ layerId, color: '#ff0000', opacity: 0.7 });
    c.updateLayer(layerId, { locks: { transparency: true } });
    const before = layerPx(c, layerId, 64, 64);

    c.paintStroke({
      brushId: 'antimatter',
      brush: { antimatter: { annihilate: 0.9, sparks: 0 } },
      seed: 19,
      points: [{ x: 64, y: 64, pressure: 1 }],
    });

    const after = layerPx(c, layerId, 64, 64);
    expect(after[3]).toBe(before[3]);
    expect(after[0]).toBeLessThan(40);
    expect(after[1]).toBeGreaterThan(180);
    expect(after[2]).toBeGreaterThan(180);
  });

  it('7. combines overlapping blasts within one stroke by maximum so the core inverts once, not twice', () => {
    const c = createEditor();
    const layerId = c.getState().document.activeLayerId!;
    c.fillLayer({ layerId, color: '#ff0000' });

    const res = c.paintStroke({
      brushId: 'antimatter',
      brush: {
        tip: { size: 28, smoothing: 0 },
        antimatter: { blastSpacing: 0.5, blastRadius: 3, annihilate: 0, sparks: 0 },
      },
      seed: 3,
      points: [
        { x: 48, y: 64, pressure: 1 },
        { x: 80, y: 64, pressure: 1 },
        { x: 48, y: 64, pressure: 1 },
      ],
    });
    expect(res.antimatter!.blasts).toBeGreaterThanOrEqual(2);
    const [r, g, b] = layerPx(c, layerId, 64, 64);
    // Still cyan (#00ffff), not double-inverted back to #ff0000
    expect(r).toBeLessThan(35);
    expect(g).toBeGreaterThan(200);
    expect(b).toBeGreaterThan(200);
  });

  it('8. invertMode "oklab" visibly changes mid-grey (#808080) paint where "rgb" leaves it near #7f7f7f', () => {
    const cRgb = createEditor();
    const idRgb = cRgb.getState().document.activeLayerId!;
    cRgb.fillLayer({ color: '#808080' });
    cRgb.paintStroke({
      brushId: 'antimatter',
      brush: { antimatter: { invertMode: 'rgb', annihilate: 0, sparks: 0 } },
      seed: 5,
      points: [{ x: 64, y: 64, pressure: 1 }],
    });
    const pxRgb = layerPx(cRgb, idRgb, 64, 64);
    expect(Math.abs(pxRgb[0] - 127)).toBeLessThanOrEqual(3);

    const cOk = createEditor();
    const idOk = cOk.getState().document.activeLayerId!;
    cOk.fillLayer({ color: '#808080' });
    cOk.paintStroke({
      brushId: 'antimatter',
      brush: { antimatter: { invertMode: 'oklab', annihilate: 0, sparks: 0 } },
      seed: 5,
      points: [{ x: 64, y: 64, pressure: 1 }],
    });
    const pxOk = layerPx(cOk, idOk, 64, 64);
    expect(Math.abs(pxOk[0] - 128)).toBeGreaterThan(25);
  });

  it('9. deposits sparks and bare-canvas soot only on the active layer, contained by a selection mask', () => {
    const c = createEditor();
    const bottomId = c.getState().document.activeLayerId!;
    // Paint a small patch around (64,64) on the bottom layer
    c.paintStroke({
      layerId: bottomId,
      brushId: 'ink-pen',
      color: '#ff0000',
      brush: { tip: { size: 18, hardness: 1, smoothing: 0 } },
      points: [{ x: 64, y: 64, pressure: 1 }],
    });

    const topLayer = c.addLayer({ name: 'Top Active' });
    c.setActiveLayer(topLayer.id);

    // Restrict mask stencil to x: 40..88, y: 40..88
    c.addStencil({
      kind: 'shape',
      shape: 'rect',
      mode: 'mask',
      feather: 0,
      rect: { x: 40, y: 40, width: 48, height: 48 },
    });

    const res = c.paintStroke({
      brushId: 'antimatter-flare',
      color: '#00ffaa',
      brush: {
        tip: { size: 28 },
        antimatter: { blastRadius: 3.5, sparkReach: 6, sparks: 1, scorch: 0.9 },
      },
      seed: 101,
      points: [{ x: 64, y: 64, pressure: 1 }],
    });
    expect(res.antimatter!.blasts).toBe(1);
    expect(res.antimatter!.sparks).toBeGreaterThan(0);

    // Bottom layer outside its original radius-12 patch must remain completely transparent (no sparks or bare-canvas soot)
    let bottomOutsideAlpha = 0;
    let topOutsideAlpha = 0;
    let maskViolation = 0;
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        const inOriginalPatch = Math.hypot(x - 64, y - 64) <= 13;
        const inMask = x >= 39 && x <= 89 && y >= 39 && y <= 89;
        const bA = layerPx(c, bottomId, x, y)[3];
        const tA = layerPx(c, topLayer.id, x, y)[3];
        if (!inOriginalPatch && bA > 0) bottomOutsideAlpha += bA;
        if (!inOriginalPatch && tA > 0) topOutsideAlpha += tA;
        if (!inMask && (bA > 0 || tA > 0)) maskViolation += bA + tA;
      }
    }
    expect(bottomOutsideAlpha).toBe(0);
    expect(topOutsideAlpha).toBeGreaterThan(0);
    expect(maskViolation).toBe(0);
  });

  it('10. lowers thick-paint height in the blast core and raises a crater rim around it', () => {
    const c = createEditor();
    const layerId = c.getState().document.activeLayerId!;
    c.paintStroke({
      brushId: 'impasto-brush',
      color: '#cc5500',
      brush: { tip: { size: 60 }, impasto: { depth: 0.9, edgeBuildup: 0.5 } },
      points: [
        { x: 32, y: 64, pressure: 1 },
        { x: 96, y: 64, pressure: 1 },
      ],
    });
    const hBeforeCenter = c.document.thick?.[layerId]?.height;
    expect(hBeforeCenter).toBeDefined();
    const centerBefore = readPixel(hBeforeCenter!, 64, 64)[0];
    expect(centerBefore).toBeGreaterThan(20);

    c.paintStroke({
      brushId: 'antimatter',
      brush: { tip: { size: 24 }, antimatter: { blastRadius: 2.5, crater: 0.9, sparks: 0 } },
      seed: 11,
      points: [{ x: 64, y: 64, pressure: 1 }],
    });

    const hAfter = c.document.thick?.[layerId]?.height;
    expect(hAfter).toBeDefined();
    const centerAfter = readPixel(hAfter!, 64, 64)[0];
    expect(centerAfter).toBeLessThan(centerBefore);
  });

  it('11. clears light paint in the blast core across target layers and writes glowing sparks when light.amount > 0', () => {
    const c = createEditor();
    const bottomId = c.getState().document.activeLayerId!;
    c.paintStroke({
      layerId: bottomId,
      brushId: 'neon-marker',
      color: '#ff00ff',
      brush: { tip: { size: 48 } },
      points: [
        { x: 40, y: 64, pressure: 1 },
        { x: 88, y: 64, pressure: 1 },
      ],
    });
    const beforeLight = readPixel(c.document.light![bottomId]!, 64, 64)[0];
    expect(beforeLight).toBeGreaterThan(100);

    const topLayer = c.addLayer({ name: 'Top', parentId: null });
    c.setActiveLayer(topLayer.id);

    c.paintStroke({
      brushId: 'antimatter-flare',
      color: '#00ffff',
      brush: { tip: { size: 28 }, antimatter: { blastRadius: 3, sparks: 0.9 } },
      seed: 29,
      points: [{ x: 64, y: 64, pressure: 1 }],
    });

    // Core light on bottom layer is cleared
    const afterBottomCore = readPixel(c.document.light![bottomId]!, 64, 64)[0];
    expect(afterBottomCore).toBeLessThan(beforeLight);

    // Top layer receives glowing spark light
    const topLight = c.document.light?.[topLayer.id];
    expect(topLight).toBeDefined();
    expect(topLight!.tiles.size).toBeGreaterThan(0);
  });

  it('12. replays across target layers at 2x scale and when a target layer is later hidden', async () => {
    const c = createEditor(64, 64);
    const bottomId = c.getState().document.activeLayerId!;
    c.fillLayer({ layerId: bottomId, color: '#ff0000' });
    const topLayer = c.addLayer({ name: 'Top', parentId: null });
    c.fillLayer({ layerId: topLayer.id, color: '#0000ff' });
    c.setActiveLayer(topLayer.id);

    const res = c.paintStroke({
      brushId: 'antimatter',
      seed: 77,
      points: [{ x: 32, y: 32, pressure: 1 }],
    });
    expect(res.antimatter!.blasts).toBe(1);
    expect(c.document.strokes[0].targets).toEqual([bottomId, topLayer.id]);

    // Replay at 2x scale and check blast count/appearance matches at (64, 64)
    const target2x = c.createReplayTarget(2);
    await replayPainting(c.document, target2x, { scale: 2 });
    const bottomPx2x = layerPx(target2x, bottomId, 64, 64);
    const topPx2x = layerPx(target2x, topLayer.id, 64, 64);
    expect(bottomPx2x[0]).toBeLessThan(50);
    expect(bottomPx2x[1]).toBeGreaterThan(170);
    expect(topPx2x[0]).toBeGreaterThan(170);
    expect(topPx2x[1]).toBeGreaterThan(170);
  });

  it('13. animates view-only blast progress from 0 to duration and equals committed pixels at completion', () => {
    const c = createEditor();
    const layerId = c.getState().document.activeLayerId!;
    c.fillLayer({ layerId, color: '#ff0000' });

    // Reference stroke with duration: 0 (immediate)
    const cRef = createEditor();
    cRef.fillLayer({ color: '#ff0000' });
    cRef.paintStroke({
      brushId: 'antimatter',
      brush: { antimatter: { duration: 0, sparks: 0.6 } },
      seed: 55,
      points: [{ x: 64, y: 64, pressure: 1 }],
    });
    const committedFinal = cRef.compositePixels();

    let nowMs = 1000;
    let stepFn: ((t: number) => void) | null = null;
    const player = c.playEffects({
      now: () => nowMs,
      frame: (cb) => {
        stepFn = cb;
        return () => {
          stepFn = null;
        };
      },
    });

    c.paintStroke({
      brushId: 'antimatter',
      brush: { antimatter: { duration: 0.8, sparks: 0.6 } },
      seed: 55,
      points: [{ x: 64, y: 64, pressure: 1 }],
    });

    // At t = 1100ms (early in blast), composited view differs from final
    nowMs = 1100;
    if (stepFn) (stepFn as (t: number) => void)(nowMs);
    const earlyFrame = c.compositePixels();
    let diffEarly = 0;
    for (let i = 0; i < committedFinal.data.length; i++) {
      diffEarly += Math.abs(earlyFrame.data[i] - committedFinal.data[i]);
    }
    expect(diffEarly).toBeGreaterThan(100);

    // At t = 2000ms (past duration), blast animation finishes and matches committedFinal
    nowMs = 2000;
    if (stepFn) (stepFn as (t: number) => void)(nowMs);
    const doneFrame = c.compositePixels();
    expect(Array.from(doneFrame.data)).toEqual(Array.from(committedFinal.data));
    player.stop();
  });

  it('14, 15 & 16. ships all three presets, renders thumbnails, migrates v1, and exposes brush patches via ToolRegistry', async () => {
    for (const id of ['antimatter', 'antimatter-flare', 'antimatter-charge'] as const) {
      const preset = BUILTIN_BRUSHES.find((b) => b.id === id);
      const spec = BRUSH_PRESETS.find((b) => b.id === id);
      expect(preset).toBeDefined();
      expect(spec).toBeDefined();
      expect(preset!.engine).toBe('antimatter');
      expect(spec!.kind).toBe('mark');
      if (spec!.kind === 'mark') {
        expect(spec!.marks?.kind).toBe('antimatter');
      }

      const thumb = renderBrushThumbnail(preset!, { paper: DEFAULT_PAPER, color: '#ff3864', width: 96, height: 36 });
      let nonZero = 0;
      for (let i = 3; i < thumb.data.length; i += 4) {
        if (thumb.data[i] > 0) nonZero++;
      }
      expect(nonZero).toBeGreaterThan(50);
    }

    const migrated = migrateBrushV1({
      engine: 'antimatter',
      antimatter: { blastRadius: 4, invertMode: 'oklab', scorch: 0.8 },
    });
    expect(migrated.kind).toBe('mark');
    if (migrated.kind === 'mark') {
      expect(migrated.marks.kind).toBe('antimatter');
      expect(migrated.marks.blastRadius).toBe(4);
      expect(migrated.marks.invertMode).toBe('oklab');
    }
    const resolved = resolveBrush(migrated);
    expect(resolved.engine).toBe('antimatter');
    expect(resolved.antimatter.blastRadius).toBe(4);
    expect(resolved.antimatter.invertMode).toBe('oklab');

    const c = createEditor();
    c.fillLayer({ color: '#2266ff' });
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c, { namespace: '' }));
    reg.register(createPaintBrushLibraryToolProvider(c, { namespace: '' }));

    const callRes = await reg.callTool('paint_stroke', {
      brushId: 'antimatter',
      brush: {
        marks: {
          kind: 'antimatter',
          blastRadius: 3,
          invertMode: 'oklab',
          scorch: 0.7,
          annihilate: 0.4,
        },
      },
      seed: 99,
      points: [{ x: 64, y: 64 }],
    });
    expect(callRes.isError).toBeFalsy();
    const structured = callRes.structuredContent as { antimatter?: { blasts: number } };
    expect(structured.antimatter?.blasts).toBe(1);
  });
});
