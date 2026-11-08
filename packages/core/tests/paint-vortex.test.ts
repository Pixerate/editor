import { describe, expect, it } from 'vitest';
import {
  composeDisplacementFields,
  createDisplacementField,
  integrateVelocityField,
  sampleDisplacement,
  sampleRgbaPremultiplied,
  warpTiledSurfaceChannel,
  warpTiledSurfaceNearest,
  warpTiledSurfaceRgba,
  type VelocityGridField,
} from '../src/paint/displacement';
import {
  emptySurface,
  readPixel,
  readRegion,
  surfaceFromPixels,
  writeRegion,
} from '../src/raster/surface';
import {
  classifyVortexShape,
  guideOverlay,
  liveStrokeRefusal,
  PaintEditorController,
  renderBrushThumbnail,
  type PenPoint,
} from '../src/paint-editor';

function circleLoopPoints(
  cx: number,
  cy: number,
  r: number,
  steps = 24,
  clockwise = true
): PenPoint[] {
  const pts: PenPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2 * (clockwise ? 1 : -1);
    pts.push({ x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r, pressure: 0.8 });
  }
  return pts;
}

function figureEightPoints(cx: number, cy: number, r: number, steps = 40): PenPoint[] {
  const pts: PenPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    pts.push({
      x: cx + Math.sin(t) * r,
      y: cy + Math.sin(2 * t) * r * 0.6,
      pressure: 0.8,
    });
  }
  return pts;
}

describe('paint/displacement', () => {
  it('creates, bilinearly samples, integrates, and composes displacement fields', () => {
    const field = createDisplacementField({ x: 10, y: 20, width: 20, height: 20 }, 2);
    expect(field.step).toBe(2);
    expect(sampleDisplacement(field, 0, 0)).toEqual({ dx: 0, dy: 0 });

    // Pure rotational velocity field around (32, 32)
    const rect = { x: 0, y: 0, width: 64, height: 64 };
    const step = 2;
    const cols = 33;
    const rows = 33;
    const vx = new Float32Array(cols * rows);
    const vy = new Float32Array(cols * rows);
    let maxSpeed = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const dx = c * step - 32;
        const dy = r * step - 32;
        const dist = Math.hypot(dx, dy);
        if (dist > 0 && dist < 24) {
          const w = 1 - dist / 24;
          const u = (-dy / dist) * w;
          const v = (dx / dist) * w;
          vx[r * cols + c] = u;
          vy[r * cols + c] = v;
          maxSpeed = Math.max(maxSpeed, Math.hypot(u, v));
        }
      }
    }
    const vel: VelocityGridField = { rect, step, cols, rows, vx, vy, maxSpeed };
    const disp = integrateVelocityField(vel, 18);
    expect(disp.maxDisplacement).toBeGreaterThan(4);

    // Sample near (42, 32) -> should displace upstream (in -y for CW spin)
    const s = sampleDisplacement(disp, 42, 32);
    expect(Math.hypot(s.dx, s.dy)).toBeGreaterThan(2);
    expect(s.dy).toBeLessThan(0);

    // Composing two half-integrations approximates a full integration
    const half = integrateVelocityField(vel, 9);
    const composed = composeDisplacementFields(half, half);
    const sc = sampleDisplacement(composed, 42, 32);
    expect(sc.dy).toBeLessThan(half.dy[16 * cols + 21]!);
  });

  it('resamples RGBA with premultiplied bilinear filtering without dark fringes', () => {
    const buf = new Uint8ClampedArray(2 * 2 * 4);
    // (0,0) is bright yellow opaque; other 3 pixels are transparent zero (0,0,0,0)
    buf[0] = 250;
    buf[1] = 220;
    buf[2] = 40;
    buf[3] = 255;
    const out: [number, number, number, number] = [0, 0, 0, 0];
    sampleRgbaPremultiplied(buf, 0, 0, 2, 2, 0.5, 0.5, out);
    // Straight RGB must stay pure yellow (250, 220, 40), never darkened by transparent black!
    expect(out[0]).toBe(250);
    expect(out[1]).toBe(220);
    expect(out[2]).toBe(40);
    expect(out[3]).toBeCloseTo(64, 0);
  });

  it('warps RGBA, single-channel, and nearest-sampled packed surfaces', () => {
    const rgbaPixels = new Uint8ClampedArray(32 * 32 * 4);
    const heightPixels = new Uint8ClampedArray(32 * 32);
    const matPixels = new Uint8ClampedArray(32 * 32 * 4);
    for (let y = 8; y < 24; y++) {
      for (let x = 8; x < 16; x++) {
        const i = y * 32 + x;
        rgbaPixels[i * 4] = 220;
        rgbaPixels[i * 4 + 1] = 40;
        rgbaPixels[i * 4 + 2] = 60;
        rgbaPixels[i * 4 + 3] = 255;
        heightPixels[i] = 180;
        matPixels[i * 4] = 90;
        matPixels[i * 4 + 3] = 255;
      }
    }
    const surfRgba = surfaceFromPixels({ width: 32, height: 32, data: rgbaPixels }, 4);
    const surfH = surfaceFromPixels({ width: 32, height: 32, data: heightPixels }, 1);
    const surfMat = surfaceFromPixels({ width: 32, height: 32, data: matPixels }, 4);

    // Uniform shift field dx = -4 (moves content +4 px to the right)
    const field = createDisplacementField({ x: 0, y: 0, width: 32, height: 32 }, 2);
    field.dx.fill(-4);
    const shiftField = { ...field, maxDisplacement: 4 };

    const wRgba = warpTiledSurfaceRgba(surfRgba, shiftField);
    expect(wRgba.changedPixels).toBeGreaterThan(0);
    expect(readPixel(wRgba.surface, 18, 12)[0]).toBe(220);

    const wH = warpTiledSurfaceChannel(surfH, shiftField);
    expect(readRegion(wH.surface, { x: 18, y: 12, width: 1, height: 1 })[0]).toBe(180);

    const wMat = warpTiledSurfaceNearest(surfMat, shiftField);
    const matPx = readPixel(wMat.surface, 18, 12);
    expect(matPx[0]).toBe(90);
    expect(matPx[3]).toBe(255);
  });
});

describe('Vortex paint (#683)', () => {
  it('1. classifies point, open, and closed shapes (and treats figure-of-eight as open)', () => {
    const tap = classifyVortexShape([{ x: 50, y: 50 }, { x: 51, y: 50.5 }], 20);
    expect(tap.shape).toBe('point');

    const line = classifyVortexShape(
      [
        { x: 20, y: 50 },
        { x: 60, y: 50 },
        { x: 100, y: 50 },
      ],
      20
    );
    expect(line.shape).toBe('open');

    const loop = classifyVortexShape(circleLoopPoints(80, 80, 30, 24, true), 20);
    expect(loop.shape).toBe('closed');
    expect(loop.signedArea).toBeGreaterThan(0);

    const ccwLoop = classifyVortexShape(circleLoopPoints(80, 80, 30, 24, false), 20);
    expect(ccwLoop.shape).toBe('closed');
    expect(ccwLoop.signedArea).toBeLessThan(0);

    // A self-crossing figure-of-eight that ends at its start is classified as 'open', not 'closed'
    const fig8 = classifyVortexShape(figureEightPoints(80, 80, 36, 48), 16);
    expect(fig8.shape).toBe('open');
  });

  it('2. winds paint inside and around a closed loop in the drawn direction (follow / cw / ccw)', () => {
    const paintSplitAndLoop = (clockwise: boolean, direction: 'follow' | 'cw' | 'ccw' = 'follow') => {
      const c = new PaintEditorController({ width: 128, height: 128 });
      // Top half red, bottom half blue
      c.setBrush({ id: 'ink-pen', tip: { size: 40, opacity: 1 } });
      c.setColor('#ef4444');
      c.paintStroke({ points: [{ x: 24, y: 46 }, { x: 104, y: 46 }] });
      c.setColor('#3b82f6');
      c.paintStroke({ points: [{ x: 24, y: 82 }, { x: 104, y: 82 }] });

      const res = c.paintStroke({
        brushId: 'vortex',
        brush: { tip: { size: 18 }, marks: { kind: 'vortex', reach: 3, turns: 0.5, pull: 0.1, direction, duration: 0 } },
        points: circleLoopPoints(64, 64, 22, 28, clockwise),
      });
      expect(res.vortex?.shape).toBe('closed');
      expect(res.vortex?.maxDisplacement).toBeGreaterThan(5);
      return c;
    };

    const cwCtrl = paintSplitAndLoop(true, 'follow');
    const ccwCtrl = paintSplitAndLoop(false, 'follow');
    // At the right side of the loop (x=82, y=64): CW brings red from top; CCW brings blue from bottom
    const cwRight = cwCtrl.pickColor(82, 64, { layerId: cwCtrl.document.activeLayerId! });
    const ccwRight = ccwCtrl.pickColor(82, 64, { layerId: ccwCtrl.document.activeLayerId! });
    expect(cwRight.color).not.toBe(ccwRight.color);
  });
  it('3. wraps paint around an open line or squiggle like a racetrack', () => {
    const c = new PaintEditorController({ width: 128, height: 128 });
    c.setBrush({ id: 'ink-pen', tip: { size: 32, opacity: 1 } });
    c.setColor('#10b981');
    c.paintStroke({ points: [{ x: 64, y: 20 }, { x: 64, y: 108 }] });

    const res = c.paintStroke({
      brushId: 'vortex',
      brush: { tip: { size: 20 }, marks: { kind: 'vortex', reach: 3, turns: 1.5, pull: 0.3, duration: 0 } },
      points: [
        { x: 28, y: 64, pressure: 0.9 },
        { x: 64, y: 64, pressure: 0.9 },
        { x: 100, y: 64, pressure: 0.9 },
      ],
    });
    expect(res.vortex?.shape).toBe('open');
    expect(res.vortex?.maxDisplacement).toBeGreaterThan(5);
    expect(res.bounds).not.toBeNull();
  });

  it('4. forms a round whirlpool from a single tap', () => {
    const c = new PaintEditorController({ width: 128, height: 128 });
    c.setBrush({ id: 'ink-pen', tip: { size: 36, opacity: 1 } });
    c.setColor('#f59e0b');
    c.paintStroke({ points: [{ x: 32, y: 64 }, { x: 96, y: 64 }] });

    const res = c.paintStroke({
      brushId: 'whirlpool',
      brush: { marks: { kind: 'vortex', duration: 0 } },
      points: [{ x: 64, y: 64, pressure: 1 }],
    });
    expect(res.vortex?.shape).toBe('point');
    expect(res.vortex?.maxDisplacement).toBeGreaterThan(5);
    expect(res.strokeId).not.toBeNull();
  });

  it('5. moves nothing while the pen is down, shows guide + reach outline, and commits on pen-up', () => {
    const c = new PaintEditorController({ width: 128, height: 128 });
    c.setBrush({ id: 'ink-pen', tip: { size: 30, opacity: 1 } });
    c.setColor('#ec4899');
    c.paintStroke({ points: [{ x: 30, y: 64 }, { x: 98, y: 64 }] });
    const layerId = c.document.activeLayerId!;
    const beforeSurface = c.layerSurface(layerId);

    c.setBrush({ id: 'vortex', marks: { kind: 'vortex', reach: 3, duration: 0 } });
    const session = c.beginStroke();
    session.push([
      { x: 44, y: 44, pressure: 0.8 },
      { x: 84, y: 44, pressure: 0.8 },
      { x: 84, y: 84, pressure: 0.8 },
    ]);

    // Nothing has moved on the layer while the pen is still down
    expect(c.layerSurface(layerId)).toBe(beforeSurface);

    // Guide overlay contains both stroke ('vortex') and reach ('vortex-reach') segments
    const guides = guideOverlay(c);
    expect(guides.some((g) => g.kind === 'vortex')).toBe(true);
    expect(guides.some((g) => g.kind === 'vortex-reach')).toBe(true);

    const res = session.end();
    expect(res.bounds).not.toBeNull();
    expect(c.layerSurface(layerId)).not.toBe(beforeSurface);
    expect(guideOverlay(c).some((g) => g.kind === 'vortex')).toBe(false);
  });

  it('6 & 7. returns strokeId: null and maxDisplacement: 0 on bare canvas with ink: 0, and lays + winds colour when ink > 0', () => {
    const c = new PaintEditorController({ width: 128, height: 128 });
    const bare = c.paintStroke({
      brushId: 'vortex',
      points: circleLoopPoints(64, 64, 20),
    });
    expect(bare.bounds).toBeNull();
    expect(bare.strokeId).toBeNull();
    expect(bare.vortex).toEqual({ shape: 'closed', maxDisplacement: 0 });
    expect(c.getState().canUndo).toBe(false);

    // With ink > 0 ('ink-vortex'), lays paint and winds it on bare canvas in one undo step
    c.setColor('#8b5cf6');
    const inked = c.paintStroke({
      brushId: 'ink-vortex',
      brush: { marks: { kind: 'vortex', ink: 0.8, turns: 1.5, reach: 3, duration: 0 } },
      points: circleLoopPoints(64, 64, 20),
    });
    expect(inked.bounds).not.toBeNull();
    expect(inked.strokeId).not.toBeNull();
    expect(inked.vortex?.shape).toBe('closed');
    expect(inked.vortex?.maxDisplacement).toBeGreaterThan(5);
    expect(c.getState().canUndo).toBe(true);
  });

  it('8 & 9. commits immediately for exportPng/pickColor while winding view frames over duration > 0', () => {
    const c = new PaintEditorController({ width: 128, height: 128 });
    c.setBrush({ id: 'ink-pen', tip: { size: 32, opacity: 1 } });
    c.setColor('#dc2626');
    c.paintStroke({ points: [{ x: 30, y: 64 }, { x: 98, y: 64 }] });
    const layerId = c.document.activeLayerId!;
    const preStrokeSurface = c.layerSurface(layerId)!;

    let nowMs = 1000;
    const frames: Array<() => void> = [];
    const player = c.playEffects({
      now: () => nowMs,
      frame: (cb) => {
        frames.push(cb);
        return () => {};
      },
    });

    c.paintStroke({
      brushId: 'vortex',
      brush: { marks: { kind: 'vortex', duration: 1.0, turns: 2, reach: 3 } },
      points: [{ x: 64, y: 64, pressure: 1 }],
    });

    // Committed state (pickColor / compositePixels) is already at final state
    const committedSurface = (c.document.layers[0] as { surface: typeof preStrokeSurface }).surface;
    expect(committedSurface).not.toBe(preStrokeSurface);
    expect(c.hasActiveVortexAnimations()).toBe(true);

    // At t = 0 (before stepping), view surface is pre-ink surface
    expect(c.layerSurface(layerId)).toBe(preStrokeSurface);

    // Step halfway (500ms)
    nowMs = 1500;
    const midStepped = c.stepVortexAnimations(nowMs);
    expect(midStepped).toBe(true);
    const midSurface = c.layerSurface(layerId)!;
    expect(midSurface).not.toBe(preStrokeSurface);
    expect(midSurface).not.toBe(committedSurface);

    // Step to completion (2000ms)
    nowMs = 2000;
    c.stepVortexAnimations(nowMs);
    expect(c.hasActiveVortexAnimations()).toBe(false);
    expect(c.layerSurface(layerId)).toBe(committedSurface);
    player.stop();
  });

  it('10. spins fluid on a wet layer via WetWorld.swirl instead of drying it first', () => {
    const c = new PaintEditorController({ width: 128, height: 128 });
    c.setColor('#2563eb');
    c.paintStroke({
      brushId: 'watercolor-round',
      points: [
        { x: 40, y: 64, pressure: 0.9 },
        { x: 88, y: 64, pressure: 0.9 },
      ],
    });
    const layerId = c.document.activeLayerId!;
    expect(c.getState().wet.wet).toBe(true);

    // Using dry 'vortex' preset on a wet layer routes to wet swirl without drying the layer!
    const res = c.paintStroke({
      brushId: 'vortex',
      points: circleLoopPoints(64, 64, 18, 20, true),
    });
    expect(res.wet).toBe(true);
    expect(res.vortex?.shape).toBe('closed');
    expect(res.vortex?.maxDisplacement).toBeGreaterThan(2);

    // Check WetWorld velocity field is non-zero around the loop
    const vel = c.wet.world?.velocityAt(layerId, 82, 64) ?? [0, 0];
    expect(Math.hypot(vel[0], vel[1])).toBeGreaterThan(0.001);
  });

  it('11. winds light paint and thick impasto relief (height + nearest-sampled material)', () => {
    const c = new PaintEditorController({ width: 128, height: 128 });
    c.setColor('#38bdf8');
    c.paintStroke({
      brushId: 'glow-gel',
      points: [{ x: 36, y: 64 }, { x: 92, y: 64 }],
    });
    const layerId = c.document.activeLayerId!;
    const lightBefore = c.document.light?.[layerId];
    expect(lightBefore).toBeDefined();

    // Also lay thick metallic impasto
    c.setColor('#eab308');
    c.paintStroke({
      brushId: 'metallic-paint',
      points: [{ x: 36, y: 64 }, { x: 92, y: 64 }],
    });
    const thickBefore = c.document.thick?.[layerId];
    expect(thickBefore).toBeDefined();

    const res = c.paintStroke({
      brushId: 'vortex',
      brush: { marks: { kind: 'vortex', reach: 3.5, turns: 2, duration: 0 } },
      points: [{ x: 64, y: 64, pressure: 1 }],
    });
    expect(res.bounds).not.toBeNull();
    expect(c.document.light?.[layerId]).not.toBe(lightBefore);
    expect(c.document.thick?.[layerId]?.height).not.toBe(thickBefore?.height);
    expect(c.document.thick?.[layerId]?.material).not.toBe(thickBefore?.material);
  });

  it('12, 13 & 14. handles symmetry copies, replay_strokes flipX/scale, locks, stroke-layer refusal, and undo/redo', () => {
    const c = new PaintEditorController({ width: 128, height: 128 });
    c.setBrush({ id: 'ink-pen', tip: { size: 24, opacity: 1 } });
    c.setColor('#f43f5e');
    c.paintStroke({ points: [{ x: 20, y: 64 }, { x: 108, y: 64 }] });

    // Enable vertical mirror symmetry
    c.setSymmetry({ enabled: true, mode: 'vertical', centerX: 64, centerY: 64 });
    const symStroke = c.paintStroke({
      brushId: 'vortex',
      brush: { marks: { kind: 'vortex', duration: 0 } },
      points: [{ x: 36, y: 64, pressure: 1 }],
    });
    expect(symStroke.bounds).not.toBeNull();
    // Both left (x=36) and mirrored right (x=92) were warped
    expect(symStroke.bounds!.x).toBeLessThan(36);
    expect(symStroke.bounds!.x + symStroke.bounds!.width).toBeGreaterThan(92);

    // Undo restores pre-vortex state; redo re-applies
    const afterVortex = c.compositePixels();
    c.undo();
    const afterUndo = c.compositePixels();
    expect(afterUndo.data).not.toEqual(afterVortex.data);
    c.redo();
    expect(c.compositePixels().data).toEqual(afterVortex.data);

    // replay_strokes with flipX and scale
    c.setSymmetry({ enabled: false });
    const replayed = c.replayStrokes({
      strokeIds: [symStroke.strokeId!],
      flipX: true,
      scale: 1.2,
    });
    expect(replayed.strokeIds.length).toBe(1);

    // Transparency lock preserves original alpha
    const layerId = c.document.activeLayerId!;
    c.updateLayer(layerId, { locks: { transparency: true } });
    const emptyBefore = c.pickColor(10, 10, { layerId });
    expect(emptyBefore.alpha).toBe(0);
    c.paintStroke({
      brushId: 'ink-vortex',
      brush: { marks: { kind: 'vortex', ink: 1, duration: 0 } },
      points: [{ x: 10, y: 10 }, { x: 50, y: 50 }],
    });
    expect(c.pickColor(10, 10, { layerId }).alpha).toBe(0);

    // Stroke layers refuse vortex brushes
    expect(liveStrokeRefusal(c.getBrush('vortex')!)).toContain('Vortex');

    // Brush thumbnails render cleanly for all 4 presets
    for (const id of ['vortex', 'ink-vortex', 'whirlpool', 'wet-vortex']) {
      const thumb = renderBrushThumbnail(c.getBrush(id)!, { width: 96, height: 32, color: '#2563eb', paper: c.document.paper });
      expect(thumb.data.some((v) => v > 0)).toBe(true);
    }
  });
});
