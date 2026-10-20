// Retouch cases re-expressed from photocraft/crates/paint/src/retouch.rs, crates/algo/src/retouch.rs and poisson.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  ImageEditorController,
  bestOffset,
  createImageEditorToolProvider,
  dodgeBurn,
  dodgeBurnCurve,
  handlePaintShortcut,
  healPixels,
  membraneFill,
  PaintGesture,
  readPixel,
  saturationOf,
  seamlessClone,
  solveMembrane,
  sponge,
  spotHealPixels,
  type PixelLayer,
} from '../src/image-editor';

const W = 120;
const H = 60;

/** A canvas: left half red, right half blue (or `paint` per pixel). */
function image(paint?: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = paint ? paint(x, y) : x < W / 2 ? [220, 20, 20] : [20, 20, 220];
      data.set([...c, 255], (y * W + x) * 4);
    }
  }
  return { width: W, height: H, data };
}

function setup(paint?: (x: number, y: number) => [number, number, number]) {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  const px = image(paint);
  c.setSamplePixels(px);
  const id = c.addPixelLayer({ name: 'Photo', pixels: px });
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  return { c, id, registry };
}

const pixel = (c: ImageEditorController, id: string, x: number, y: number) => {
  const l = c.getLayer(id) as PixelLayer;
  return readPixel(l.surface, x - l.offset.x, y - l.offset.y);
};
const brush = { size: 10, hardness: 1, pressureSize: false };
const text = (res: { content?: unknown[] }) => String((res.content?.[0] as { text?: string })?.text);

describe('healing maths', () => {
  it('a membrane interpolates linearly between fixed ends', () => {
    const w = 11;
    const v = new Float32Array(w);
    v[0] = 0;
    v[w - 1] = 100;
    const unknown = Array.from({ length: w }, (_, i) => i > 0 && i < w - 1);
    solveMembrane(w, 1, unknown, v);
    for (let i = 0; i < w; i++) expect(v[i]).toBeCloseTo(i * 10, 0);
  });

  it('a large membrane (multigrid) matches the harmonic answer', () => {
    const w = 64;
    const h = 64;
    const v = new Float32Array(w * h);
    const unknown = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
        unknown[y * w + x] = edge ? 0 : 1;
        // x + y is harmonic, so the solve must reproduce it inside.
        if (edge) v[y * w + x] = x + y;
      }
    }
    solveMembrane(w, h, unknown, v);
    expect(v[32 * w + 20]).toBeCloseTo(52, 0);
    expect(v[10 * w + 50]).toBeCloseTo(60, 0);
  });

  it('seamless cloning keeps the texture and takes the surrounding level', () => {
    const w = 24;
    const h = 24;
    const src = new Float32Array(w * h);
    const dst = new Float32Array(w * h).fill(200);
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        src[y * w + x] = 50 + ((x + y) % 2) * 10; // a checker at a different level
        if (x > 2 && y > 2 && x < w - 3 && y < h - 3) mask[y * w + x] = 1;
      }
    }
    const out = seamlessClone(w, h, 1, src, dst, mask);
    const c = 12 * w + 12;
    expect(out[c]).toBeGreaterThan(190);
    expect(out[c]).toBeLessThan(215);
    // The checker survives: neighbours differ by the source's step.
    expect(Math.abs(out[c] - out[c + 1])).toBeCloseTo(10, 0);
    expect(out[0]).toBe(200);
  });

  it('a membrane fill is smooth and stays inside the edge values', () => {
    const w = 16;
    const img = new Float32Array(w * w);
    const hole = new Uint8Array(w * w);
    for (let i = 0; i < w * w; i++) {
      img[i] = (i % w) * 10;
      if (i % w > 4 && i % w < 11 && Math.floor(i / w) > 4 && Math.floor(i / w) < 11) hole[i] = 1;
    }
    const out = membraneFill(w, w, 1, img, hole);
    expect(out[8 * w + 8]).toBeCloseTo(80, 0);
  });

  it('proximity match finds the patch that fits the ring', () => {
    const w = 64;
    const h = 32;
    const img = new Float32Array(w * h * 4);
    // Vertical stripes with period 8: a hole is best filled from a whole number of periods away.
    for (let i = 0; i < w * h; i++) {
      const v = (i % w) % 8 < 4 ? 0 : 255;
      img.set([v, v, v, 255], i * 4);
    }
    const hole = new Uint8Array(w * h);
    for (let y = 12; y < 20; y++) for (let x = 28; x < 36; x++) hole[y * w + x] = 1;
    const off = bestOffset(w, h, 4, img, hole, 3, 24)!;
    expect(off).not.toBeNull();
    expect(((off[0] % 8) + 8) % 8).toBe(0);
    expect(bestOffset(w, h, 4, img, new Uint8Array(w * h), 3, 24)).toBeNull();
  });
});

describe('tone kernels', () => {
  it('dodge lightens and burn darkens midtones; black and white stay', () => {
    expect(dodgeBurnCurve(0.5, 0.5, 'midtones', false)).toBeGreaterThan(0.55);
    expect(dodgeBurnCurve(0.5, 0.5, 'midtones', true)).toBeLessThan(0.45);
    for (const v of [0, 1]) {
      expect(dodgeBurnCurve(v, 1, 'midtones', false)).toBeCloseTo(v, 6);
      expect(dodgeBurnCurve(v, 1, 'midtones', true)).toBeCloseTo(v, 6);
    }
  });

  it('shadows move the dark end, highlights the light end', () => {
    expect(dodgeBurnCurve(0, 0.5, 'shadows', false)).toBeGreaterThan(0.4);
    expect(dodgeBurnCurve(0.9, 0.5, 'shadows', false) - 0.9).toBeLessThan(0.01);
    expect(dodgeBurnCurve(1, 0.5, 'highlights', true)).toBeLessThan(0.6);
    expect(0.1 - dodgeBurnCurve(0.1, 0.5, 'highlights', true)).toBeLessThan(0.01);
  });

  it('protect tones keeps the hue', () => {
    const c = dodgeBurn([0.6, 0.3, 0.15], 0.6, 'midtones', false, true);
    expect(c[0] / c[1]).toBeCloseTo(2, 1);
    expect(c[1]).toBeGreaterThan(0.3);
    expect(Math.max(...c)).toBeLessThanOrEqual(1);
  });

  it('sponge desaturates and saturates, and vibrance damps', () => {
    const red = [0.8, 0.3, 0.3];
    expect(saturationOf(...(sponge([...red], 0.5, false, false) as [number, number, number]))).toBeLessThan(saturationOf(0.8, 0.3, 0.3));
    expect(saturationOf(...(sponge([...red], 0.5, true, false) as [number, number, number]))).toBeGreaterThan(saturationOf(0.8, 0.3, 0.3));
    const plain = sponge([...red], 0.5, true, false);
    const vib = sponge([...red], 0.5, true, true);
    expect(Math.abs(vib[0] - 0.8)).toBeLessThan(Math.abs(plain[0] - 0.8));
  });

  it('heal and spot heal return pixels inside 0..255', () => {
    const w = 20;
    const src = new Float32Array(w * w * 4).fill(300);
    const dst = new Float32Array(w * w * 4).fill(-10);
    const mask = new Uint8Array(w * w);
    mask[10 * w + 10] = 1;
    const out = healPixels(w, w, src, dst, mask);
    for (let c = 0; c < 4; c++) expect(out[(10 * w + 10) * 4 + c]).toBe(0);
    expect(out[0]).toBe(-10);
    const healed = spotHealPixels(w, w, new Float32Array(w * w * 4).fill(128), mask, 4, 'smooth');
    expect(healed[(10 * w + 10) * 4]).toBeCloseTo(128, 0);
  });
});

describe('Clone Stamp', () => {
  it('copies from the source at the stroke offset, as one undo step', () => {
    const { c, id } = setup();
    c.setCloneSource({ x: 20, y: 30 });
    const res = c.paintStroke({ tool: 'clone', points: [{ x: 90, y: 30 }, { x: 100, y: 30 }], brush });
    expect(res.clone).toEqual({ offset: { x: -70, y: 0 }, source: { x: 20, y: 30 }, aligned: true });
    expect(pixel(c, id, 95, 30)).toEqual([220, 20, 20, 255]);
    expect(pixel(c, id, 95, 50)).toEqual([20, 20, 220, 255]);
    expect(c.getState().paint.cloneSource!.offset).toEqual({ x: -70, y: 0 });
    c.undo();
    expect(pixel(c, id, 95, 30)).toEqual([20, 20, 220, 255]);
  });

  it('aligned keeps the offset; non-aligned restarts at the source', () => {
    const { c } = setup((x) => [x * 2, 0, 0]);
    c.setCloneSource({ x: 10, y: 20 });
    c.paintStroke({ tool: 'clone', points: [{ x: 80, y: 20 }], brush });
    const second = c.paintStroke({ tool: 'clone', points: [{ x: 90, y: 40 }], brush });
    expect(second.clone!.offset).toEqual({ x: -70, y: 0 });
    const third = c.paintStroke({ tool: 'clone', points: [{ x: 100, y: 40 }], brush, retouch: { aligned: false } });
    expect(third.clone!.offset).toEqual({ x: -90, y: -20 });
    expect(third.clone!.source).toEqual({ x: 10, y: 20 });
  });

  it('never re-samples what the stroke itself painted', () => {
    const { c, id } = setup((x) => [x < 10 ? 255 : 0, 0, 0]);
    // A stroke running over its own source would copy red endlessly if it read live pixels.
    c.setCloneSource({ x: 5, y: 30 });
    c.paintStroke({ tool: 'clone', points: [{ x: 15, y: 30 }, { x: 60, y: 30 }], brush });
    expect(pixel(c, id, 18, 30)[0]).toBe(255);
    expect(pixel(c, id, 40, 30)[0]).toBe(0);
  });

  it('samples the layers below onto an empty layer, and respects the selection and locks', () => {
    const { c, id } = setup();
    const empty = c.addPixelLayer({ name: 'Retouch' });
    c.setCloneSource({ x: 20, y: 30 });
    expect(() => c.paintStroke({ tool: 'clone', points: [{ x: 90, y: 30 }], brush })).not.toThrow();
    expect(pixel(c, empty, 90, 30)[3]).toBe(0);
    c.paintStroke({ tool: 'clone', points: [{ x: 90, y: 30 }], brush, retouch: { sample: 'current-below' } });
    expect(pixel(c, empty, 90, 30)).toEqual([220, 20, 20, 255]);
    expect(pixel(c, id, 90, 30)).toEqual([20, 20, 220, 255]);
    c.selectRect({ x: 0, y: 0, width: 95, height: H });
    c.paintStroke({ tool: 'clone', layerId: id, points: [{ x: 93, y: 10 }, { x: 98, y: 10 }], brush, retouch: { sample: 'current', aligned: false } });
    expect(pixel(c, id, 92, 10)[0]).toBe(220);
    expect(pixel(c, id, 97, 10)[0]).toBe(20);
    c.setSelection(null);
    c.setLayerProperties(id, { locks: { pixels: true } });
    expect(() => c.paintStroke({ tool: 'clone', layerId: id, points: [{ x: 90, y: 30 }], brush })).toThrow(/locked/);
  });

  it('clones a mask from itself', () => {
    const { c, id } = setup();
    c.addLayerMask(id, 'reveal-all');
    c.paintStroke({ tool: 'brush', channel: 'mask', points: [{ x: 20, y: 20 }], color: '#000000', brush: { size: 12, pressureSize: false } });
    c.paintStroke({ tool: 'clone', channel: 'mask', points: [{ x: 80, y: 20 }], brush, source: { x: 20, y: 20 } });
    const mask = (c.getLayer(id) as PixelLayer).mask!.surface;
    expect(readPixel(mask, 80, 20)[0]).toBe(0);
    expect(readPixel(mask, 80, 40)[0]).toBe(255);
  });

  it('refuses without a source point', () => {
    const { c } = setup();
    expect(() => c.paintStroke({ tool: 'clone', points: [{ x: 1, y: 1 }] })).toThrow(/needs a source point/);
  });
});

describe('Healing', () => {
  const textured = (x: number, y: number): [number, number, number] => {
    // A light area on the right, a darker textured patch on the left.
    const t = ((x + y) % 4) * 6;
    return x < 40 ? [60 + t, 60 + t, 60 + t] : [180, 180, 180];
  };

  it('the Healing Brush matches the surrounding tone and keeps the texture', () => {
    const { c, id } = setup(textured);
    c.setCloneSource({ x: 20, y: 30 });
    const res = c.paintStroke({ tool: 'heal', points: [{ x: 85, y: 30 }, { x: 95, y: 30 }], brush: { size: 14, hardness: 1, pressureSize: false } });
    expect(res.bounds).not.toBeNull();
    const centre = pixel(c, id, 90, 30)[0];
    expect(centre).toBeGreaterThan(150);
    expect(centre).toBeLessThan(215);
    const row = [88, 89, 90, 91].map((x) => pixel(c, id, x, 30)[0]);
    expect(Math.max(...row) - Math.min(...row)).toBeGreaterThan(6);
    c.undo();
    expect(pixel(c, id, 90, 30)[0]).toBe(180);
  });

  it('Spot Healing removes a spot from a flat area', () => {
    const { c, id } = setup((x, y) => (Math.hypot(x - 60, y - 30) < 3 ? [10, 10, 10] : [200, 190, 180]));
    const res = c.paintStroke({ tool: 'spot-heal', points: [{ x: 60, y: 30 }], brush: { size: 12, hardness: 0.8, pressureSize: false } });
    expect(res.spotHeal).toBeDefined();
    const p = pixel(c, id, 60, 30);
    expect(Math.abs(p[0] - 200)).toBeLessThan(10);
    expect(Math.abs(p[2] - 180)).toBeLessThan(10);
    const smooth = c.paintStroke({ tool: 'spot-heal', points: [{ x: 60, y: 30 }], brush: { size: 12, pressureSize: false }, retouch: { spotType: 'smooth' } });
    expect(smooth.spotHeal).toEqual({ offset: null });
  });
});

describe('Smudge, Dodge, Burn and Sponge', () => {
  it('the Smudge drags colour along the stroke, fading with distance', () => {
    const { c, id } = setup((x) => (x < 30 ? [255, 0, 0] : [255, 255, 255]));
    c.paintStroke({ tool: 'smudge', points: [{ x: 20, y: 30 }, { x: 70, y: 30 }], brush: { size: 12, pressureSize: false }, retouch: { strength: 0.8 } });
    const g = (x: number) => pixel(c, id, x, 30)[1];
    expect(g(35)).toBeLessThan(200);
    expect(g(35)).toBeLessThan(g(60));
    expect(pixel(c, id, 35, 50)[1]).toBe(255);
  });

  it('a dodge stroke never compounds over itself; a second stroke builds on it', () => {
    const { c, id } = setup(() => [100, 100, 100]);
    const back = [{ x: 30, y: 30 }, { x: 60, y: 30 }, { x: 30, y: 30 }, { x: 60, y: 30 }];
    c.paintStroke({ tool: 'dodge', points: [{ x: 30, y: 30 }, { x: 60, y: 30 }], brush });
    const once = pixel(c, id, 45, 30)[0];
    c.undo();
    c.paintStroke({ tool: 'dodge', points: back, brush });
    expect(pixel(c, id, 45, 30)[0]).toBe(once);
    expect(once).toBeGreaterThan(100);
    c.paintStroke({ tool: 'dodge', points: [{ x: 30, y: 30 }, { x: 60, y: 30 }], brush });
    expect(pixel(c, id, 45, 30)[0]).toBeGreaterThan(once);
    expect(pixel(c, id, 45, 50)[0]).toBe(100);
  });

  it('burn darkens by range; alpha is kept', () => {
    const { c, id } = setup(() => [200, 200, 200]);
    c.paintStroke({ tool: 'burn', points: [{ x: 30, y: 30 }], brush, retouch: { range: 'highlights', exposure: 0.8 } });
    const p = pixel(c, id, 30, 30);
    expect(p[0]).toBeLessThan(170);
    expect(p[3]).toBe(255);
  });

  it('the Sponge desaturates, compounding over passes, and refuses masks', () => {
    const { c, id } = setup(() => [200, 60, 60]);
    c.paintStroke({ tool: 'sponge', points: [{ x: 30, y: 30 }, { x: 50, y: 30 }], brush });
    const p = pixel(c, id, 40, 30);
    expect(p[0] - p[1]).toBeLessThan(140);
    c.addLayerMask(id);
    expect(() => c.paintStroke({ tool: 'sponge', channel: 'mask', points: [{ x: 30, y: 30 }] })).toThrow(/mask has none/);
  });

  it('the Smudge works on a mask', () => {
    const { c, id } = setup();
    c.addLayerMask(id, 'hide-all');
    c.paintStroke({ tool: 'brush', channel: 'mask', points: [{ x: 10, y: 30 }, { x: 30, y: 30 }], color: '#ffffff', brush: { size: 14, pressureSize: false } });
    c.paintStroke({ tool: 'smudge', channel: 'mask', points: [{ x: 25, y: 30 }, { x: 60, y: 30 }], brush: { size: 12, pressureSize: false }, retouch: { strength: 0.8 } });
    const mask = (c.getLayer(id) as PixelLayer).mask!.surface;
    expect(readPixel(mask, 40, 30)[0]).toBeGreaterThan(40);
    expect(readPixel(mask, 40, 50)[0]).toBe(0);
  });
});

describe('retouch UI model', () => {
  it('Alt-click sets the clone source; shortcuts pick the tools', () => {
    const { c, id } = setup();
    const g = new PaintGesture(c);
    c.setTool('clone');
    expect(g.down({ x: 20, y: 30, pressure: 1, altKey: true })).toBeNull();
    expect(g.active).toBe(false);
    expect(c.getState().paint.cloneSource).toMatchObject({ x: 20, y: 30 });
    g.down({ x: 90, y: 30, pressure: 1 });
    g.up();
    expect(pixel(c, id, 90, 30)[0]).toBe(220);
    handlePaintShortcut(c, { key: 'j' });
    expect(c.getState().activeTool).toBe('spot-heal');
    handlePaintShortcut(c, { key: 'J', shiftKey: true });
    expect(c.getState().activeTool).toBe('heal');
    handlePaintShortcut(c, { key: 'o' });
    expect(c.getState().activeTool).toBe('dodge');
    handlePaintShortcut(c, { key: 'O', shiftKey: true });
    expect(c.getState().activeTool).toBe('burn');
    handlePaintShortcut(c, { key: 'O', shiftKey: true });
    expect(c.getState().activeTool).toBe('sponge');
    handlePaintShortcut(c, { key: 's' });
    expect(c.getState().activeTool).toBe('clone');
  });
});

describe('retouch agent tools', () => {
  it('stroke tools retouch and report what changed', async () => {
    const { c, id, registry } = setup();
    const src = await registry.callTool('set_clone_source', { x: 20, y: 30 });
    expect(src.structuredContent).toEqual({ x: 20, y: 30, offset: null });
    const clone = await registry.callTool('clone_stamp', { points: [{ x: 90, y: 30 }], brush: { size: 8 } });
    expect(clone.isError).toBeFalsy();
    expect(clone.structuredContent).toMatchObject({ layerId: id, channel: 'pixels', bounds: expect.any(Object), dabs: 1, clone: { offset: { x: -70, y: 0 }, aligned: true } });
    const heal = await registry.callTool('heal_brush', { points: [{ x: 100, y: 10 }], source: { x: 110, y: 50 } });
    expect(heal.structuredContent).toMatchObject({ clone: { offset: { x: 10, y: 40 } } });
    for (const [name, args] of [
      ['spot_heal', { points: [{ x: 60, y: 30 }], type: 'smooth' }],
      ['smudge', { points: [{ x: 50, y: 30 }, { x: 70, y: 30 }], strength: 0.6 }],
      ['dodge', { points: [{ x: 50, y: 30 }], range: 'shadows', exposure: 0.3 }],
      ['burn', { points: [{ x: 50, y: 30 }], protectTones: false }],
      ['sponge', { points: [{ x: 50, y: 30 }], mode: 'saturate' }],
    ] as const) {
      const res = await registry.callTool(name, args as never);
      expect(res.isError, name).toBeFalsy();
      expect(res.structuredContent, name).toMatchObject({ layerId: id, channel: 'pixels', dabs: expect.any(Number) });
    }
    expect(c.getState().paint.retouch.range).toBe('midtones');
  });

  it('options read and write; bad input fails usefully', async () => {
    const { registry } = setup();
    const set = await registry.callTool('set_retouch_options', { sample: 'all', exposure: 0.25 });
    expect(set.structuredContent).toMatchObject({ sample: 'all', exposure: 0.25 });
    const get = await registry.callTool('get_retouch_options', {});
    expect(get.structuredContent).toMatchObject({ options: { sample: 'all', exposure: 0.25 }, cloneSource: null });
    for (const [name, args, pattern] of [
      ['clone_stamp', { points: [{ x: 5, y: 5 }] }, /needs a source point/],
      ['clone_stamp', { points: [{ x: 5, y: 5 }], source: { x: 500, y: 5 } }, /outside the 120 × 60 canvas/],
      ['heal_brush', { points: [] }, /Invalid arguments|fewer/],
      ['dodge', { points: [{ x: 5, y: 5 }], range: 'everything' }, /Invalid arguments|enum/],
      ['sponge', { points: [{ x: 5, y: 5 }], channel: 'mask' }, /Invalid arguments|additional/],
      ['smudge', { points: [{ x: 5, y: 5 }], layerId: 'nope' }, /Unknown layer "nope"/],
      ['set_clone_source', {}, /Pass x and y/],
      ['set_clone_source', { x: 1, y: 1, clear: true }, /not both/],
    ] as const) {
      const res = await registry.callTool(name, args as never);
      expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(text(res)).toMatch(pattern);
    }
    const cleared = await registry.callTool('set_clone_source', { clear: true });
    expect(cleared.isError).toBeFalsy();
  });
});

describe('Blur, Sharpen and History Brush', () => {
  it('blur_stroke softens an edge where it passes, as one undo step', async () => {
    const { c, id, registry } = setup();
    const before = pixel(c, id, 60, 30);
    const res = await registry.callTool('blur_stroke', { layerId: id, points: [{ x: 60, y: 20 }, { x: 60, y: 40 }], strength: 1, brush: { size: 16, hardness: 1 } });
    expect(res.isError).toBeFalsy();
    const at = pixel(c, id, 60, 30);
    // x = 60 is the first blue pixel: the red | blue edge mixes into it; far away nothing changes.
    expect(at[0]).toBeGreaterThan(before[0]);
    expect(at[2]).toBeLessThan(before[2]);
    expect(pixel(c, id, 20, 30)).toEqual([220, 20, 20, 255]);
    c.undo();
    expect(pixel(c, id, 60, 30)).toEqual(before);
  });

  it('sharpen_stroke steepens a soft ramp', async () => {
    const { c, id, registry } = setup((x) => {
      const v = 60 + 4 * Math.max(0, Math.min(30, x - 50));
      return [v, v, v];
    });
    expect(pixel(c, id, 50, 30)[0]).toBe(60);
    await registry.callTool('sharpen_stroke', { layerId: id, points: [{ x: 65, y: 30 }], strength: 1, brush: { size: 40, hardness: 1 } });
    // At the ramp's foot and shoulder the unsharp mask overshoots: darker below, lighter above.
    expect(pixel(c, id, 50, 30)[0]).toBeLessThan(60);
    expect(pixel(c, id, 80, 30)[0]).toBeGreaterThan(180);
  });

  it('history_brush paints the layer back from an earlier state', async () => {
    const { c, id, registry } = setup();
    // The layer was just added: the oldest state has no such layer.
    const none = await registry.callTool('history_brush', { layerId: id, points: [{ x: 20, y: 30 }] });
    expect(none.isError).toBe(true);
    expect(String((none.content?.[0] as { text?: string }).text)).toMatch(/did not exist/);
    c.fillPixels({ layerId: id, color: '#00ff00', useSelection: false });
    expect(pixel(c, id, 20, 30)).toEqual([0, 255, 0, 255]);
    const res = await registry.callTool('history_brush', { layerId: id, historySteps: 1, points: [{ x: 20, y: 30 }], brush: { size: 10, hardness: 1 } });
    expect(res.isError).toBeFalsy();
    // Back to the red it was before the fill, only under the brush.
    expect(pixel(c, id, 20, 30)).toEqual([220, 20, 20, 255]);
    expect(pixel(c, id, 40, 30)).toEqual([0, 255, 0, 255]);
    c.undo();
    expect(pixel(c, id, 20, 30)).toEqual([0, 255, 0, 255]);
    const bad = await registry.callTool('history_brush', { layerId: id, historySteps: -1, points: [{ x: 1, y: 1 }] });
    expect(bad.isError).toBe(true);
  });
});

