import { describe, expect, it } from 'vitest';
import { pointerPressure, pointerStrokeSample, pointerStrokeSamples, WetWorld, type WetPaperInput } from '../src/paint';
import { samplePressure } from '../src/paint-editor';
import { pointerPressure as imagePointerPressure } from '../src/image-editor';

const toWorld = (cx: number, cy: number) => ({ x: (cx - 10) / 2, y: (cy - 20) / 2 });

describe('pointer → stroke samples', () => {
  it('maps positions, reads pen pressure and tilt, ignores mouse pressure', () => {
    expect(pointerStrokeSample({ clientX: 30, clientY: 40, pointerType: 'mouse', pressure: 0.5, timeStamp: 12 }, toWorld)).toEqual({ x: 10, y: 10, pressure: 1, t: 12 });
    expect(pointerStrokeSample({ clientX: 10, clientY: 20, pointerType: 'pen', pressure: 0.3, tiltX: 20, tiltY: -5 }, toWorld)).toEqual({ x: 0, y: 0, pressure: 0.3, tiltX: 20, tiltY: -5 });
    expect(pointerStrokeSample({ clientX: 10, clientY: 20, pointerType: 'pen', pressure: 0.3, altitudeAngle: 0.8, azimuthAngle: 1 }, toWorld)).toMatchObject({ altitude: 0.8, azimuth: 1 });
    expect(pointerPressure({ pointerType: 'pen', pressure: 0 })).toBe(1);
    // One rule everywhere: the paint and image editors share it.
    expect(samplePressure({ pointerType: 'pen', pressure: 0.4 })).toBe(0.4);
    expect(imagePointerPressure).toBe(pointerPressure);
  });

  it('expands coalesced events in order', () => {
    const coalesced = [10, 12, 14].map((x) => ({ clientX: x, clientY: 20, pointerType: 'pen', pressure: x / 20 }));
    const samples = pointerStrokeSamples({ clientX: 14, clientY: 20, pointerType: 'pen', pressure: 0.7, getCoalescedEvents: () => coalesced }, toWorld);
    expect(samples.map((s) => [s.x, s.pressure])).toEqual([[0, 0.5], [1, 0.6], [2, 0.7]]);
    expect(pointerStrokeSamples({ clientX: 14, clientY: 20, getCoalescedEvents: () => [] }, toWorld)).toHaveLength(1);
  });
});

const paper: WetPaperInput = { absorption: 0.6, permeability: 0.5, roughness: 0, color: [255, 255, 255], heightAt: () => 0.5 };

function disc(cx: number, cy: number, r: number) {
  const x0 = Math.floor(cx - r);
  const y0 = Math.floor(cy - r);
  const w = Math.ceil(2 * r) + 1;
  const cov = new Float32Array(w * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) cov[y * w + x] = (x0 + x + 0.5 - cx) ** 2 + (y0 + y + 0.5 - cy) ** 2 < r * r ? 1 : 0;
  return { rect: { x: x0, y: y0, width: w, height: w }, cov };
}

describe('WetWorld.stepRegion', () => {
  it('steps the live tiles in the region and holds the others still', () => {
    const w = new WetWorld(512, 256, paper, { kernel: 'typescript' });
    w.ensureLane('a');
    const left = disc(128, 128, 20);
    const right = disc(384, 128, 20);
    w.paint('a', left.rect, left.cov, 0.8, null);
    w.paint('a', right.rect, right.cov, 0.8, null);
    const probe = (x: number) => w.waterAt("a", x, 128 + 19);
    const before = { left: probe(128), right: probe(384), rightCentre: w.waterAt('a', 384, 128) };
    // Three steps (odd): held tiles must still read the same state afterwards.
    w.stepRegionSync(3, { x: 0, y: 0, width: 256, height: 256 });
    expect(w.clock).toBe(3);
    expect(probe(128)).not.toBe(before.left);
    expect(probe(384)).toBe(before.right);
    expect(w.waterAt('a', 384, 128)).toBe(before.rightCentre);
    // A normal step moves both again.
    w.stepSync(3);
    expect(probe(384)).not.toBe(before.right);
    w.destroy();
  });

  it('with a region covering every tile, matches plain steps bit for bit', () => {
    const run = (region: boolean) => {
      const w = new WetWorld(512, 256, paper, { kernel: 'typescript' });
      w.ensureLane('a');
      const d = disc(250, 128, 24);
      w.paint('a', d.rect, d.cov, 0.8, null);
      // Each step of the TypeScript kernel costs ~50 ms per tile on CI; three show any difference.
      if (region) w.stepRegionSync(3, { x: -10, y: -10, width: 600, height: 300 });
      else w.stepSync(3);
      const out = [w.waterAt('a', 250, 128), w.waterAt('a', 262, 128), w.waterAt('a', 280, 140)];
      w.destroy();
      return out;
    };
    expect(run(true)).toEqual(run(false));
  });
});
