// Smart selection benchmark. Not a CI assertion: it only runs with SELECTION_BENCH=1 and prints
// the timings. Run it with
//
//   SELECTION_BENCH=1 pnpm vitest run packages/core/tests/image-editor-selection.bench.test.ts
//
// Budgets from issue #390 (Phase 5), at 12 MP (4000 × 3000):
// - a Quick Selection stroke: under 50 ms (once the reduced copy of the image exists; making it
//   is a one-off per image, about 100 ms);
// - the Magnetic Lasso: a pointer move well under a frame;
// - Object Selection: no budget in the issue; it should stay under the 1 s set for Select Subject.
import { describe, expect, it } from 'vitest';
import { EdgeMap, liveWire, quickSelectStroke, selectObjectIn, selectionArea } from '../src/image-editor';

const W = 4000;
const H = 3000;

/** A red disc of radius 800 in the middle of a green ground, with noise. */
function photo() {
  const data = new Uint8ClampedArray(W * H * 4);
  let seed = 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const n = ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 13) - 6;
      const c = Math.hypot(x - 2000, y - 1500) < 800 ? [200, 40, 40] : [60, 150, 70];
      data[p] = c[0] + n;
      data[p + 1] = c[1] + n;
      data[p + 2] = c[2] + n;
      data[p + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

const time = (fn: () => void) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe.runIf(process.env.SELECTION_BENCH)('smart selection benchmark', () => {
  it('Quick Selection strokes on a 12 MP image', () => {
    const px = photo();
    const first = time(() => quickSelectStroke(px, [{ x: 1900, y: 1500 }], { size: 100 }));
    const strokes = Array.from({ length: 7 }, (_, i) => time(() => quickSelectStroke(px, [{ x: 1900 + i * 10, y: 1500 }, { x: 2100, y: 1520 }], { size: 100 })));
    let area = 0;
    const whole = time(() => (area = selectionArea(quickSelectStroke(px, [{ x: 200, y: 200 }, { x: 400, y: 250 }], { size: 100 }))));
    console.table({ 'first stroke (makes the reduced copy)': first, 'stroke (median)': median(strokes), 'stroke over most of the image': whole });
    expect(area).toBeGreaterThan(W * H * 0.7);
    expect(median(strokes)).toBeLessThan(50);
  });

  it('Object Selection on a 12 MP image', () => {
    const px = photo();
    quickSelectStroke(px, [{ x: 10, y: 10 }], { size: 10 });
    let boxArea = 0;
    let pointArea = 0;
    const box = time(() => (boxArea = selectionArea(selectObjectIn(px, { rect: { x: 1100, y: 600, width: 1800, height: 1800 } }))));
    const point = time(() => (pointArea = selectionArea(selectObjectIn(px, { point: { x: 2000, y: 1500 } }))));
    console.table({ 'box (reduced copy already made)': box, point });
    const disc = Math.PI * 800 * 800;
    expect(Math.abs(boxArea - disc) / disc).toBeLessThan(0.02);
    expect(Math.abs(pointArea - disc) / disc).toBeLessThan(0.02);
    expect(Math.max(box, point)).toBeLessThan(1000);
  });

  it('Magnetic Lasso on a 12 MP image', () => {
    const px = photo();
    let map!: EdgeMap;
    const setup = time(() => (map = new EdgeMap(px)));
    const moves = Array.from({ length: 30 }, (_, i) => {
      const a = (i / 30) * 0.3;
      return time(() => liveWire(map, { x: 2000 + 800 * Math.cos(a), y: 1500 + 800 * Math.sin(a) }, { x: 2000 + 800 * Math.cos(a + 0.06), y: 1500 + 800 * Math.sin(a + 0.06) }));
    });
    console.table({ 'first click': setup, 'pointer move (median)': median(moves) });
    expect(median(moves)).toBeLessThan(8);
  });
});
