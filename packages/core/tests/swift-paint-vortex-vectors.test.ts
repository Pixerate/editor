import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { integrateVelocityFieldFrames, type DisplacementField, type VelocityGridField } from '../src/paint/displacement';
import { readRegion } from '../src/raster/surface';
import { PaintEditorController, VORTEX_KEYFRAMES, vortexWindingField } from '../src/paint-editor';

/**
 * Vortex winding animation vectors (#733): the keyframes of `integrateVelocityFieldFrames`, a
 * blended winding field, and a controller's mid-animation frame. `PaintVortexAnimationTests` in
 * `packages/swift/Tests/PixeratePaintTests` reads this fixture and must reproduce it. Run with
 * UPDATE_SWIFT_VECTORS=1 to rewrite it after an intended change.
 */
const FILE = join(__dirname, 'fixtures/swift-vortex-vectors.json');

function rigidSpin(): VelocityGridField {
  const step = 4;
  const cols = 11;
  const rows = 11;
  const R = Math.hypot(20, 20);
  const vx = new Float32Array(cols * rows);
  const vy = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      vx[r * cols + c] = -(r * step - 20) / R;
      vy[r * cols + c] = (c * step - 20) / R;
    }
  return { rect: { x: 0, y: 0, width: 40, height: 40 }, step, cols, rows, vx, vy, maxSpeed: 1 };
}

/** A Float32 grid as little-endian bytes in base64 (exact, and small). */
const f32 = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
// maxDisplacement goes through Math.hypot, which can differ between V8 builds in the last bit: rounded so x64 CI writes the same file.
const fieldJson = (f: DisplacementField) => ({ dx: f32(f.dx), dy: f32(f.dy), maxDisplacement: Math.round(f.maxDisplacement * 1e4) / 1e4 });

function frameVectors() {
  const vel = rigidSpin();
  const travel = 2 * Math.hypot(20, 20);
  const { field, frames } = integrateVelocityFieldFrames(vel, travel, VORTEX_KEYFRAMES);
  return {
    travel,
    keyframes: VORTEX_KEYFRAMES,
    frames: frames.map(fieldJson),
    field: fieldJson(field),
    winding: [0.04, 0.37, 0.5, 0.93].map((t) => ({ t, ...fieldJson(vortexWindingField(frames, t)!) })),
  };
}

function controllerVectors() {
  const c = new PaintEditorController({ width: 64, height: 64 });
  c.paintStroke({ brushId: 'ink-pen', brush: { tip: { size: 16, opacity: 1 } }, color: '#dc2626', points: [{ x: 14, y: 32 }, { x: 50, y: 32 }], seed: 3 });
  const layerId = c.document.activeLayerId!;
  c.paintStroke({
    brushId: 'vortex',
    brush: { marks: { kind: 'vortex', duration: 1, turns: 1.5, reach: 2 } },
    points: [{ x: 32, y: 32, pressure: 1 }],
    seed: 5,
  });
  const rect = { x: 0, y: 0, width: 64, height: 64 };
  const committed = Buffer.from(readRegion(c.layerSurface(layerId)!, rect)).toString('base64');
  c.stepVortexAnimations(1000);
  c.stepVortexAnimations(1400);
  const mid = Buffer.from(readRegion(c.layerSurface(layerId)!, rect)).toString('base64');
  return { width: 64, height: 64, elapsedMs: 400, committed, mid };
}

describe('Swift vortex winding vectors', () => {
  it('match the committed fixture (the Swift tests read it)', () => {
    const now = JSON.stringify({ frames: frameVectors(), controller: controllerVectors() }) + '\n';
    if (process.env.UPDATE_SWIFT_VECTORS) writeFileSync(FILE, now);
    expect(readFileSync(FILE, 'utf8')).toBe(now);
  });
});
