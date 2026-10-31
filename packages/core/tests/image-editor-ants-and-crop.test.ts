import { describe, expect, it } from 'vitest';
import { ImageEditorController, createSelectionMask, selectionOutline, selectionOutlinePaths } from '../src/image-editor';

/** Every segment of the outline, as a set of unit steps "x0,y0-x1,y1" (direction-free). */
function unitSteps(coords: ArrayLike<number>[], joined: boolean): Set<string> {
  const out = new Set<string>();
  const add = (ax: number, ay: number, bx: number, by: number) => {
    const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
    for (let k = 0; k < n; k++) {
      const x0 = ax + ((bx - ax) * k) / n;
      const y0 = ay + ((by - ay) * k) / n;
      const x1 = ax + ((bx - ax) * (k + 1)) / n;
      const y1 = ay + ((by - ay) * (k + 1)) / n;
      out.add([`${x0},${y0}`, `${x1},${y1}`].sort().join('-'));
    }
  };
  for (const c of coords) {
    if (joined) for (let i = 2; i < c.length; i += 2) add(c[i - 2], c[i - 1], c[i], c[i + 1]);
    else for (let i = 0; i < c.length; i += 4) add(c[i], c[i + 1], c[i + 2], c[i + 3]);
  }
  return out;
}

describe('marching ants outline paths', () => {
  it('joins a staircase edge into one closed path, so the dash runs along it', () => {
    // A right triangle: its hypotenuse is a staircase of one-pixel steps.
    const W = 20;
    const data = new Uint8Array(W * W);
    for (let y = 0; y < W; y++) for (let x = 0; x <= y; x++) data[y * W + x] = 255;
    const mask = createSelectionMask(W, W, data);
    const paths = selectionOutlinePaths(mask);
    expect(paths).toHaveLength(1);
    const p = paths[0];
    // Closed: ends where it starts, with many points along the staircase.
    expect([p[p.length - 2], p[p.length - 1]]).toEqual([p[0], p[1]]);
    expect(p.length / 2).toBeGreaterThan(2 * W);
    // Each step joins the last point to the next (no jumps).
    for (let i = 2; i < p.length; i += 2) expect(Math.abs(p[i] - p[i - 2]) + Math.abs(p[i + 1] - p[i - 1])).toBeGreaterThan(0);
    // The same edges as the segment outline.
    expect(unitSteps(paths, true)).toEqual(unitSteps([selectionOutline(mask)], false));
  });

  it('gives one path per separate piece and covers corner-touching pixels', () => {
    const W = 12;
    const data = new Uint8Array(W * W);
    data[1 * W + 1] = 255;
    data[2 * W + 2] = 255; // touches the first only at a corner
    for (let y = 6; y < 9; y++) for (let x = 6; x < 10; x++) data[y * W + x] = 255;
    const mask = createSelectionMask(W, W, data);
    const paths = selectionOutlinePaths(mask);
    expect(paths.length).toBeGreaterThanOrEqual(2);
    expect(unitSteps(paths, true)).toEqual(unitSteps([selectionOutline(mask)], false));
    expect(selectionOutlinePaths(createSelectionMask(W, W))).toEqual([]);
  });
});

describe('crop when the image loads', () => {
  const image = (w: number, h: number) => ({ width: w, height: h, naturalWidth: w, naturalHeight: h }) as unknown as HTMLImageElement;

  it('keeps a whole-image crop the whole image when the real size arrives', async () => {
    const c = new ImageEditorController();
    expect(c.getState().imageDimensions).toEqual({ width: 800, height: 600 });
    c.setTool('crop'); // the crop tool starts with the whole (placeholder) image
    expect(c.getState().crop).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    await c.loadImage(image(1200, 1800));
    expect(c.getState().crop).toEqual({ x: 0, y: 0, width: 1200, height: 1800 });
  });

  it('keeps a real crop as it is', async () => {
    const c = new ImageEditorController();
    c.setCrop({ x: 10, y: 20, width: 300, height: 200 }, true);
    await c.loadImage(image(1200, 1800));
    expect(c.getState().crop).toEqual({ x: 10, y: 20, width: 300, height: 200 });
  });
});
