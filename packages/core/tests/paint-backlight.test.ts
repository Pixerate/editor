import { describe, expect, it } from 'vitest';
import { PaintEditorController, createPaintEditorToolProvider } from '../src/paint-editor';
import { ToolRegistry } from '../src/tools/registry';

const W = 200;
const H = 120;
const editor = (paper = 'smooth') => new PaintEditorController({ width: W, height: H, paper, wet: { kernel: 'wasm', threads: 0, gpu: 'off' } });
const at = (c: PaintEditorController, x: number, y: number) => {
  const { data } = c.compositePixels();
  const i = (y * W + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
};
const sum = (p: number[]) => p[0] + p[1] + p[2];
const HARD = { tip: { size: 24, hardness: 1, opacity: 1, flow: 1, spacing: 0.05, pressureSize: false, pressureOpacity: false, smoothing: 0 }, grain: 0 };

/** A dark paper so the added light shows. */
const dim = (c: PaintEditorController) => c.setPaper({ color: '#3a3a3a' } as never);

describe('backlit paper', () => {
  it('with backlight 0 every pixel is as before, and turning it on and off never repaints', async () => {
    const c = editor();
    c.paintStroke({ brushId: 'watercolor-round', points: [{ x: 30, y: 60 }, { x: 170, y: 60 }], color: '#2563eb', seed: 2 });
    c.dryPaint();
    const before = Buffer.from(c.compositePixels().data);
    const layer = c.getActiveLayer() as { surface: unknown };
    c.setPaper({ backlight: 0.8 } as never);
    expect(Buffer.from(c.compositePixels().data).equals(before)).toBe(false);
    expect((c.getActiveLayer() as { surface: unknown }).surface).toBe(layer.surface);
    c.setPaper({ backlight: 0 } as never);
    expect(c.document.paper.backlight).toBeUndefined();
    expect(Buffer.from(c.compositePixels().data).equals(before)).toBe(true);
  });

  it('a transparent glaze glows in its own colour; gouache of the same colour lets less through', async () => {
    // On grey paper, so the added light never clips at white.
    const glaze = editor('stained-glass');
    dim(glaze);
    glaze.paintStroke({ brushId: 'watercolor-round', brush: { tip: { size: 40 } }, points: [{ x: 30, y: 60 }, { x: 170, y: 60 }], color: '#2563eb', seed: 2 });
    glaze.dryPaint();
    const gouache = editor('stained-glass');
    dim(gouache);
    gouache.paintStroke({ brushId: 'gouache', brush: { tip: { size: 40 } }, points: [{ x: 30, y: 60 }, { x: 170, y: 60 }], color: '#2563eb', seed: 2 });
    gouache.dryPaint();
    const unlit = (c: PaintEditorController) => {
      c.setPaper({ backlight: 0 } as never);
      const v = at(c, 100, 60);
      c.setPaper({ backlight: 0.8 } as never);
      return v;
    };
    const gain = (c: PaintEditorController) => {
      const off = unlit(c);
      const on = at(c, 100, 60);
      return [on[0] - off[0], on[1] - off[1], on[2] - off[2]];
    };
    const g = gain(glaze);
    const o = gain(gouache);
    // The glaze passes blue light more than red.
    expect(g[2]).toBeGreaterThan(g[0] + 10);
    expect(sum(g)).toBeGreaterThan(sum(o) + 30);
  });

  it('opaque dry paint and thick paint block the light; bare paper glows', () => {
    const c = editor('stained-glass');
    dim(c);
    c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: [{ x: 20, y: 30 }, { x: 80, y: 30 }], color: '#ffffff' });
    c.paintStroke({ brushId: 'impasto-brush', brush: { tip: { size: 24 } }, points: [{ x: 20, y: 90 }, { x: 80, y: 90 }], color: '#ffffff' });
    const lit = { ink: at(c, 50, 30), thick: at(c, 50, 90), paper: at(c, 150, 60) };
    c.setPaper({ backlight: 0 } as never);
    const off = { ink: at(c, 50, 30), thick: at(c, 50, 90), paper: at(c, 150, 60) };
    expect(sum(lit.paper) - sum(off.paper)).toBeGreaterThan(200);
    expect(sum(lit.ink) - sum(off.ink)).toBeLessThan(15);
    expect(sum(lit.thick) - sum(off.thick)).toBeLessThan(sum(lit.paper) - sum(off.paper) - 150);
  });

  it('light through a glaze spills onto the paper around it, in the glaze colour', async () => {
    const glass = { ...HARD, tip: { ...HARD.tip, opacity: 0.6 } };
    // Mid-grey paper, so the red glaze filters the light (darker than the paper in green and blue).
    const grey = (c: PaintEditorController) => c.setPaper({ color: '#808080', backlight: 0.25 } as never);
    const bare = editor('stained-glass');
    grey(bare);
    const c = editor('stained-glass');
    grey(c);
    c.paintStroke({ brushId: 'ink-pen', brush: glass, points: [{ x: 40, y: 60 }, { x: 160, y: 60 }], color: '#c00000' });
    // 16 px outside the stroke's edge: no paint there, but red light from the glaze.
    const [r, g] = at(c, 100, 88);
    const [r0, g0] = at(bare, 100, 88);
    expect((c.getActiveLayer() as { surface: { tiles: Map<number, unknown> } }).surface.tiles.size).toBeGreaterThan(0);
    expect(r - r0).toBeGreaterThan(3);
    expect(r - r0).toBeGreaterThan(g - g0 + 2);
  });

  it('writes a Backlight Linear Dodge layer to PSD and says so', () => {
    const c = editor('stained-glass');
    c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: [{ x: 20, y: 60 }, { x: 180, y: 60 }], color: '#16a34a' });
    const r = c.exportPsd();
    expect(r.warnings.some((w) => /Backlit paper is written as pixels/.test(w))).toBe(true);
    const text = Buffer.from(r.bytes).toString('latin1');
    expect(text).toContain('Backlight');
    expect(text).toContain('lddg');
  });

  it('set_paper takes backlight and backlightColor, get_paper returns them, and bad values are refused', async () => {
    const c = editor();
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await reg.callTool(name, args);
      return { error: r.isError ? (r.content[0] as { text: string }).text : null, data: r.structuredContent as any };
    };
    let r = await call('set_paper', { backlight: 0.6, backlightColor: '#ffe0b0' });
    expect(r.error).toBeNull();
    r = await call('get_paper');
    expect(r.data).toMatchObject({ backlight: 0.6, backlightColor: '#ffe0b0' });
    expect((await call('set_paper', { backlight: 1.5 })).error).toMatch(/backlight/);
    expect((await call('set_paper', { backlightColor: 'orange' })).error).toMatch(/backlightColor/);
    r = await call('set_paper', { preset: 'stained-glass' });
    expect(r.error).toBeNull();
    expect((await call('get_paper')).data).toMatchObject({ preset: 'stained-glass', backlight: 0.8 });
  });
});
