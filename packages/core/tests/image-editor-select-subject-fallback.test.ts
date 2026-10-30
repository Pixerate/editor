import { describe, expect, it } from 'vitest';
import { findSubject, otsuThreshold, selectionValueAt, slicSuperpixels, workImage } from '../src/image-editor';

const W = 320;
const H = 240;

type Scene = { width: number; height: number; data: Uint8ClampedArray };

/** A scene: `inside(x, y)` gets the subject's colours, the rest a background, both with noise. */
function scene(inside: (x: number, y: number) => boolean, subject: (x: number, y: number) => number[], ground: (x: number, y: number) => number[]): Scene {
  const data = new Uint8ClampedArray(W * H * 4);
  let seed = 9;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 11) - 5;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = inside(x + 0.5, y + 0.5) ? subject(x, y) : ground(x, y);
      const p = (y * W + x) * 4;
      data[p] = c[0] + noise();
      data[p + 1] = c[1] + noise();
      data[p + 2] = c[2] + noise();
      data[p + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

/** Intersection over union of the selection (≥ half) with the subject. */
function iou(sel: ReturnType<typeof findSubject>['selection'], inside: (x: number, y: number) => boolean) {
  let both = 0;
  let either = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = selectionValueAt(sel, x, y) >= 0.5;
      const b = inside(x + 0.5, y + 0.5);
      if (a && b) both++;
      if (a || b) either++;
    }
  }
  return either ? both / either : 1;
}

describe('select subject without a model', () => {
  it('splits superpixels and finds an Otsu threshold', () => {
    const px = scene((x) => x < 160, () => [200, 50, 50], () => [50, 50, 200]);
    const sp = slicSuperpixels(workImage(px), 100);
    expect(sp.count).toBeGreaterThan(60);
    // No superpixel straddles the colour boundary.
    for (let y = 0; y < H; y += 7) {
      expect(sp.label[y * W + 150]).not.toBe(sp.label[y * W + 170]);
    }
    expect(otsuThreshold([0.1, 0.12, 0.15, 0.8, 0.85], [1, 1, 1, 1, 1])).toBeGreaterThan(0.15);
    expect(otsuThreshold([0.1, 0.12, 0.15, 0.8, 0.85], [1, 1, 1, 1, 1])).toBeLessThanOrEqual(0.8);
  });

  it('finds a two-coloured subject on a two-toned background', () => {
    const inside = (x: number, y: number) => ((x - 165) / 70) ** 2 + ((y - 125) / 85) ** 2 < 1;
    const px = scene(
      inside,
      (x, y) => (y < 110 ? [235, 190, 150] : [150, 40, 50]),
      (x, y) => (y < 150 ? [120 + y / 4, 160 + y / 6, 220] : [90, 130, 70])
    );
    const { selection, reason } = findSubject(px);
    expect(reason).toBeUndefined();
    expect(iou(selection, inside)).toBeGreaterThan(0.85);
  });

  it('finds a subject that reaches the bottom edge', () => {
    // A figure standing on the bottom of the frame.
    const inside = (x: number, y: number) => (y > 90 && Math.abs(x - 160) < 55) || Math.hypot(x - 160, y - 65) < 35;
    const px = scene(inside, () => [60, 50, 45], (x) => [200 - x / 8, 210, 225]);
    expect(iou(findSubject(px).selection, inside)).toBeGreaterThan(0.85);
  });

  it('selects nothing on a plain image, and says why', () => {
    const px = scene(() => false, () => [0, 0, 0], () => [128, 128, 128]);
    const { selection, reason } = findSubject(px);
    expect(selection.bounds).toBeNull();
    expect(reason).toMatch(/stands out/);
  });
});
