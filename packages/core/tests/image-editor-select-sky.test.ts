import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider, findSky, imagePlaybackPanel, selectionArea, selectionValueAt } from '../src/image-editor';

const W = 360;
const H = 240;

function scene(colour: (x: number, y: number) => number[]) {
  const data = new Uint8ClampedArray(W * H * 4);
  let seed = 4;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 5) - 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = colour(x, y);
      const p = (y * W + x) * 4;
      data[p] = c[0] + noise();
      data[p + 1] = c[1] + noise();
      data[p + 2] = c[2] + noise();
      data[p + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

/** Wavy hills under a blue sky that lightens towards the horizon. */
const horizon = (x: number) => 140 + 20 * Math.sin(x / 40);
const isSky = (x: number, y: number) => y + 0.5 < horizon(x + 0.5);
const hills = () =>
  scene((x, y) => {
    if (isSky(x, y)) return [70 + y * 0.4, 130 + y * 0.3, 225];
    // Grass with texture.
    const t = ((x * 31 + y * 17) % 23) * 3;
    return [50 + t, 110 + t, 40];
  });

/** Pixels where the selection disagrees with the sky by more than half. */
function wrong(sel: ReturnType<typeof findSky>['selection'], inSky: (x: number, y: number) => boolean) {
  let n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((selectionValueAt(sel, x, y) >= 0.5) !== inSky(x, y)) n++;
  return n;
}

describe('select sky', () => {
  it('selects a blue sky down to a wavy horizon', () => {
    const { selection, reason } = findSky(hills());
    expect(reason).toBeUndefined();
    expect(wrong(selection, isSky)).toBeLessThan(W * H * 0.02);
  });

  it('selects an overcast sky over dark buildings, and sky seen through a gap', () => {
    // Buildings with a window-shaped gap of sky between two towers' bridge.
    const building = (x: number, y: number) => (x < 120 && y > 80) || (x > 220 && y > 60) || (y > 160) || (x >= 120 && x <= 220 && y > 100 && y < 120);
    const inSky = (x: number, y: number) => !building(x, y);
    const px = scene((x, y) => (building(x, y) ? [60 + ((x * 13 + y * 7) % 11) * 4, 55, 50] : [215, 218, 222]));
    const { selection } = findSky(px);
    expect(wrong(selection, inSky)).toBeLessThan(W * H * 0.02);
    // The pocket under the bridge, cut off from the top, is sky too.
    expect(selectionValueAt(selection, 170, 140)).toBeGreaterThan(0.9);
  });

  it('finds no sky in a scene without one', () => {
    const px = scene((x, y) => [120 + ((x * 7 + y * 3) % 17) * 3, 80, 50]);
    const { selection, reason } = findSky(px);
    expect(selection.bounds).toBeNull();
    expect(reason).toMatch(/No sky/);
  });

  it('selects the sky through select_sky by mode in one undo step', async () => {
    const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    c.setSamplePixels(hills());
    const registry = new ToolRegistry();
    registry.register(createImageEditorToolProvider(c));
    const res = await registry.callTool('select_sky', { softness: 0 });
    const out = res.structuredContent as Record<string, any>;
    let area = 0;
    for (let x = 0; x < W; x++) area += Math.min(H, Math.max(0, horizon(x + 0.5)));
    expect(Math.abs(out.area - area) / area).toBeLessThan(0.03);
    expect(out.note).toBeUndefined();
    const inverted = (await registry.callTool('select_sky', { mode: 'subtract', softness: 0 })).structuredContent as Record<string, any>;
    expect(inverted.empty).toBe(true);
    c.undo();
    expect(Math.abs(selectionArea(c.getSelection()) - area) / area).toBeLessThan(0.03);
    expect((await registry.callTool('select_sky', { threshold: 120 })).isError).toBe(true);
    expect(imagePlaybackPanel('select_sky')).toBe('select');
  });
});
