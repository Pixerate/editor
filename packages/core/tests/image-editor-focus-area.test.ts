import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider, focusArea, imagePlaybackPanel, selectionArea, selectionValueAt } from '../src/image-editor';

const W = 400;
const H = 300;

/** Fine random texture; `blurred(x, y)` areas are box-blurred (out of focus), with optional grain everywhere. */
function photo(blurred: (x: number, y: number) => boolean, grain = 0) {
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 1000) / 1000;
  const tex = new Float32Array(W * H);
  for (let i = 0; i < tex.length; i++) tex[i] = 90 + rnd() * 80;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = tex[y * W + x];
      if (blurred(x, y)) {
        let s = 0;
        let c = 0;
        for (let j = Math.max(0, y - 4); j <= Math.min(H - 1, y + 4); j++) for (let i = Math.max(0, x - 4); i <= Math.min(W - 1, x + 4); i++) {
          s += tex[j * W + i];
          c++;
        }
        v = s / c;
      }
      v += grain ? (rnd() - 0.5) * grain : 0;
      const p = (y * W + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

describe('focus area', () => {
  it('selects the sharp half and leaves the blurred half', () => {
    const { selection } = focusArea(photo((x) => x >= 200));
    expect(selectionValueAt(selection, 100, 150)).toBeGreaterThan(0.9);
    expect(selectionValueAt(selection, 320, 150)).toBeLessThan(0.1);
    expect(Math.abs(selectionArea(selection) - (W * H) / 2) / ((W * H) / 2)).toBeLessThan(0.08);
  });

  it('selects a sharp subject in a blurred background, low-contrast detail included', () => {
    // A sharp disc whose middle has only faint detail (skin in focus), on a blurred ground.
    const inSubject = (x: number, y: number) => Math.hypot(x - 200, y - 150) < 80;
    const px = photo((x, y) => !inSubject(x, y));
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (Math.hypot(x - 200, y - 150) >= 50) continue;
        const p = (y * W + x) * 4;
        px.data.fill(140 + ((x * 7 + y * 13) % 9) - 4, p, p + 3);
      }
    }
    const { selection } = focusArea(px);
    expect(selectionValueAt(selection, 200, 150)).toBeGreaterThan(0.9);
    expect(selectionValueAt(selection, 20, 20)).toBeLessThan(0.1);
    const area = Math.PI * 80 * 80;
    expect(Math.abs(selectionArea(selection) - area) / area).toBeLessThan(0.15);
  });

  it('takes in more with a wider range, and ignores grain with a higher noise level', () => {
    const half = photo((x) => x >= 200);
    const narrow = selectionArea(focusArea(half, { range: 10 }).selection);
    const wide = selectionArea(focusArea(half, { range: 95 }).selection);
    expect(wide).toBeGreaterThan(narrow);
    // Grain everywhere makes the blurred half look detailed until the noise level discounts it.
    const grainy = photo((x) => x >= 200, 30);
    const loose = focusArea(grainy, { noise: 0 });
    const strict = focusArea(grainy, { noise: 60 });
    expect(loose.noiseLevel).toBeGreaterThan(3);
    expect(selectionValueAt(strict.selection, 320, 150)).toBeLessThanOrEqual(selectionValueAt(loose.selection, 320, 150));
    expect(selectionValueAt(strict.selection, 100, 150)).toBeGreaterThan(0.9);
  });
});

describe('select_focus_area', () => {
  it('selects the sharp half by mode in one undo step and reports the noise', async () => {
    const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    c.setSamplePixels(photo((x) => x >= 200));
    const registry = new ToolRegistry();
    registry.register(createImageEditorToolProvider(c));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await registry.callTool(name, args);
      if (res.isError) throw new Error(String((res.content?.[0] as { text?: string })?.text ?? 'tool error'));
      return res.structuredContent as Record<string, any>;
    };
    const out = await call('select_focus_area', { softness: 0 });
    expect(out.noiseLevel).toBeGreaterThanOrEqual(0);
    expect(Math.abs(out.area - (W * H) / 2) / ((W * H) / 2)).toBeLessThan(0.08);
    // A box across the boundary keeps its sharp half.
    await call('select_rect', { x: 100, y: 0, width: 200, height: 300 });
    const both = await call('select_focus_area', { mode: 'intersect' });
    expect(Math.abs(both.area - 100 * 300) / (100 * 300)).toBeLessThan(0.1);
    c.undo();
    expect(selectionArea(c.getSelection())).toBe(200 * 300);
    const bad = await registry.callTool('select_focus_area', { range: 150 });
    expect(bad.isError).toBe(true);
    expect(imagePlaybackPanel('select_focus_area')).toBe('select');
  });
});
