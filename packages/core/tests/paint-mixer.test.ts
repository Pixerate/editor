// Mixer cases re-expressed from photocraft/crates/paint/src/mixer.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  EMPTY_MIXER_LOAD,
  MixerStroke,
  cleanMixer,
  loadMixer,
  normalizeBrush,
  normalizeMixer,
  type MixerLoad,
  type MixerSettings,
  type MixerTarget,
} from '../src/paint';
import { TILE, tileKey } from '../src/raster/surface';
import { ImageEditorController, PaintGesture, createImageEditorToolProvider, handlePaintShortcut, readPixel, type PixelLayer } from '../src/image-editor';

const BLUE = [0, 0, 1] as const;

/** An in-memory RGBA canvas behind the `MixerTarget` interface. */
function canvas(paint?: (x: number, y: number) => [number, number, number, number] | null) {
  const tiles = new Map<string, Uint8ClampedArray>();
  const target: MixerTarget = {
    offset: { x: 0, y: 0 },
    lockTransparency: false,
    selection: null,
    readTile: (tx, ty) => tiles.get(tileKey(tx, ty)) ?? null,
    writeTile: (tx, ty) => {
      const key = tileKey(tx, ty);
      let t = tiles.get(key);
      if (!t) tiles.set(key, (t = new Uint8ClampedArray(TILE * TILE * 4)));
      return t;
    },
  };
  if (paint) {
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 200; x++) {
        const c = paint(x, y);
        if (!c) continue;
        const t = target.writeTile(0, 0);
        t.set(c, (y * TILE + x) * 4);
      }
    }
  }
  const at = (x: number, y: number) => {
    const t = tiles.get(tileKey(Math.floor(x / TILE), Math.floor(y / TILE)));
    if (!t) return [0, 0, 0, 0];
    const i = ((y % TILE) * TILE + (x % TILE)) * 4;
    return [...t.subarray(i, i + 4)];
  };
  return { target, at, tiles };
}

const brush = normalizeBrush({ size: 8, hardness: 1, spacing: 0.25, pressureSize: false });
const line = (y = 10, x0 = 4, x1 = 196) => [{ x: x0, y }, { x: x1, y }];

function stroke(target: MixerTarget, settings: Partial<MixerSettings>, load: MixerLoad, points = line()) {
  const s = new MixerStroke(brush, settings, load, target);
  s.push(points);
  s.finish();
  return s;
}

/** Hue in degrees of an RGB colour (0..255 channels). */
function hue(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  if (d === 0) return Number.NaN;
  const h = mx === r ? (g - b) / d : mx === g ? 2 + (b - r) / d : 4 + (r - g) / d;
  return (h * 60 + 360) % 360;
}

const yellowLeft = (x: number) => (x < 100 ? ([255, 255, 0, 255] as [number, number, number, number]) : ([255, 255, 255, 255] as [number, number, number, number]));

describe('Mixer Brush model', () => {
  it('normalizes settings and loads and cleans the brush', () => {
    expect(normalizeMixer({ wet: 2, load: -1, mix: Number.NaN, mixing: 'oil' as never })).toEqual({
      wet: 1,
      load: 0,
      mix: 0.5,
      loadEachStroke: true,
      cleanEachStroke: true,
      mixing: 'rgb',
    });
    const loaded = loadMixer({ ...EMPTY_MIXER_LOAD, pickup: [1, 0, 0] }, [0, 0.5, 2]);
    expect(loaded).toEqual({ reservoir: [0, 0.5, 1], amount: 1, pickup: [1, 0, 0] });
    expect(cleanMixer(loaded)).toEqual({ reservoir: [0, 0.5, 1], amount: 1, pickup: null });
  });

  it('runs dry at a low load and keeps painting at a full load', () => {
    for (const [load, dry] of [[0, true], [1, false]] as const) {
      const { target, at } = canvas();
      const s = stroke(target, { wet: 0, load, mix: 0 }, loadMixer(EMPTY_MIXER_LOAD, [1, 0, 0]));
      const start = at(10, 10)[3];
      const end = at(190, 10)[3];
      expect(start).toBeGreaterThan(240);
      expect(at(10, 10).slice(0, 3)).toEqual([255, 0, 0]);
      if (dry) {
        expect(end).toBeLessThan(start * 0.6);
        expect(s.load.amount).toBeLessThan(0.2);
      } else {
        expect(end).toBeGreaterThan(240);
        expect(s.load.amount).toBe(1);
      }
    }
  });

  it('picks up and smears canvas colour with a wet brush', () => {
    const { target, at } = canvas((x) => (x < 100 ? [0, 0, 255, 255] : [255, 255, 255, 255]));
    const s = stroke(target, { wet: 1, load: 0.3, mix: 0.9 }, loadMixer(EMPTY_MIXER_LOAD, [1, 0, 0]));
    // Blue is dragged into the white half.
    const c = at(115, 10);
    expect(c[2]).toBeGreaterThan(c[1] + 12);
    expect(c[1]).toBeLessThan(242);
    // The pickup well holds a canvas-contaminated colour; cleaning empties it.
    expect(s.load.pickup![2]).toBeGreaterThan(0.2);
    expect(cleanMixer(s.load).pickup).toBeNull();
  });

  it('paints nothing with a dry, empty brush, and only smears with a wet, empty one', () => {
    const empty = canvas();
    const s = stroke(empty.target, { wet: 0 }, EMPTY_MIXER_LOAD);
    expect(s.dabCount).toBeGreaterThan(0);
    expect(empty.at(50, 10)[3]).toBe(0);
    const smear = canvas((x) => (x < 100 ? [0, 0, 255, 255] : null));
    stroke(smear.target, { wet: 1, mix: 1, load: 1 }, EMPTY_MIXER_LOAD);
    const c = smear.at(110, 10);
    expect(c[3]).toBeGreaterThan(0);
    expect(c[2]).toBeGreaterThan(200);
  });

  it('makes green from a blue reservoir dragged over yellow in pigment mode, and grey in RGB mode', () => {
    // Half flow keeps some yellow under each dab, as a painter's light touch does.
    const half = normalizeBrush({ ...brush, flow: 0.5 });
    const run = (mixing: 'rgb' | 'pigment') => {
      const c = canvas(yellowLeft);
      const s = new MixerStroke(half, { wet: 1, load: 1, mix: 0.5, mixing }, loadMixer(EMPTY_MIXER_LOAD, BLUE), c.target);
      s.push(line());
      s.finish();
      return c;
    };
    const pigment = run('pigment');
    for (const x of [10, 60, 90]) {
      const [r, g, b] = pigment.at(x, 10);
      const h = hue(r, g, b);
      expect(h, `pigment at ${x}: ${[r, g, b]}`).toBeGreaterThan(90);
      expect(h).toBeLessThan(165);
      expect(g).toBeGreaterThan(Math.max(r, b) + 40);
    }
    const rgb = run('rgb');
    for (const x of [10, 60, 90]) {
      const [r, g] = rgb.at(x, 10);
      // RGB mixes of blue and yellow keep red equal to green: grey, olive or slate, never green.
      expect(Math.abs(g - r), `rgb at ${x}`).toBeLessThanOrEqual(2);
    }
    // Away from the paint the canvas is untouched.
    expect(rgb.at(60, 30)).toEqual([255, 255, 0, 255]);
  });

  // One test per mixing model, so each gets its own timeout (both took 2.6 s on CI).
  it.each(['rgb', 'pigment'] as const)('replays identically with %s mixing, however the points are chunked', (mixing) => {
    const settings = { wet: 0.8, load: 0.4, mix: 0.6, mixing };
    const pts = [{ x: 4, y: 10, pressure: 0.6 }, { x: 60, y: 14 }, { x: 120, y: 8, pressure: 0.3 }, { x: 196, y: 12 }];
    const a = canvas(yellowLeft);
    const sa = stroke(a.target, settings, loadMixer(EMPTY_MIXER_LOAD, BLUE), pts);
    const b = canvas(yellowLeft);
    const sb = new MixerStroke(brush, settings, loadMixer(EMPTY_MIXER_LOAD, BLUE), b.target);
    for (const p of pts) sb.push([p]);
    sb.finish();
    expect(sb.dabCount).toBe(sa.dabCount);
    expect(sb.load).toEqual(sa.load);
    expect(b.tiles.get(tileKey(0, 0))).toEqual(a.tiles.get(tileKey(0, 0)));
  });

  it('respects the selection and locked transparency', () => {
    const sel = new Uint8ClampedArray(200 * 40);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 100; x++) sel[y * 200 + x] = 255;
    const a = canvas();
    a.target.selection = { width: 200, height: 40, data: sel };
    stroke(a.target, { wet: 0, load: 1 }, loadMixer(EMPTY_MIXER_LOAD, [1, 0, 0]));
    expect(a.at(50, 10)[3]).toBe(255);
    expect(a.at(150, 10)[3]).toBe(0);

    const b = canvas((x) => (x < 100 ? [255, 255, 255, 255] : null));
    b.target.lockTransparency = true;
    stroke(b.target, { wet: 0, load: 1 }, loadMixer(EMPTY_MIXER_LOAD, [1, 0, 0]));
    expect(b.at(50, 10)).toEqual([255, 0, 0, 255]);
    expect(b.at(150, 10)).toEqual([0, 0, 0, 0]);
  });
});

const W = 200;
const H = 40;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  const id = c.addPixelLayer();
  c.fillPixels({ color: '#ffff00', useSelection: false });
  return { c, registry, id };
}

const px = (c: ImageEditorController, id: string, x: number, y: number) => {
  const l = c.getLayer(id) as PixelLayer;
  return readPixel(l.surface, x - l.offset.x, y - l.offset.y);
};
const text = (r: { content?: unknown[] }) => String((r.content?.[0] as { text?: string })?.text);

describe('Mixer Brush in the image editor', () => {
  it('paint_stroke with tool mixer mixes pigment as one undo step', async () => {
    const { c, registry, id } = setup();
    const before = px(c, id, 60, 10);
    const res = await registry.callTool('paint_stroke', {
      tool: 'mixer',
      points: [{ x: 4, y: 10 }, { x: 120, y: 10 }],
      color: '#0000ff',
      brush: { size: 8, spacing: 0.25, flow: 0.5, pressureSize: false },
      mixer: { wet: 1, load: 1, mix: 0.5, mixing: 'pigment' },
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      layerId: id,
      channel: 'pixels',
      bounds: expect.any(Object),
      dabs: expect.any(Number),
      mixerLoad: { reservoir: '#0000ff', amount: 1, pickup: null },
    });
    const g = px(c, id, 60, 10);
    expect(hue(g[0], g[1], g[2])).toBeGreaterThan(90);
    expect(hue(g[0], g[1], g[2])).toBeLessThan(165);
        c.undo();
    expect(px(c, id, 60, 10)).toEqual(before);
    c.redo();
    expect(px(c, id, 60, 10)).toEqual(g);
  });

  it('carries the load between strokes when asked, through the load and clean tools', async () => {
    const { c, registry } = setup();
    const got = await registry.callTool('get_mixer_brush', {});
    expect(got.structuredContent).toEqual({
      settings: { wet: 0.5, load: 0.5, mix: 0.5, loadEachStroke: true, cleanEachStroke: true, mixing: 'rgb' },
      load: { reservoir: null, amount: 0, pickup: null },
    });
    const loaded = await registry.callTool('load_mixer_brush', { color: '#ff0000' });
    expect(loaded.structuredContent).toEqual({ reservoir: '#ff0000', amount: 1, pickup: null });
    const res = await registry.callTool('paint_stroke', {
      tool: 'mixer',
      points: [{ x: 4, y: 10 }, { x: 100, y: 10 }],
      mixer: { loadEachStroke: false, cleanEachStroke: false, load: 0.2 },
    });
    const load = (res.structuredContent as { mixerLoad: { reservoir: string; amount: number; pickup: string } }).mixerLoad;
    expect(load.reservoir).toBe('#ff0000');
    expect(load.amount).toBeLessThan(1);
    expect(load.pickup).toMatch(/^#[0-9a-f]{6}$/);
    expect(c.getState().paint.mixerLoad.pickup).not.toBeNull();
    const cleaned = await registry.callTool('clean_mixer_brush', {});
    expect(cleaned.structuredContent).toMatchObject({ reservoir: '#ff0000', pickup: null });
    const emptied = await registry.callTool('clean_mixer_brush', { emptyReservoir: true });
    expect(emptied.structuredContent).toEqual({ reservoir: null, amount: 0, pickup: null });
  });

  it('refuses bad mixer input with useful errors and changes nothing', async () => {
    const { c, registry, id } = setup();
    c.addLayerMask(id);
    const depth = c.getState();
    for (const [args, pattern] of [
      [{ tool: 'mixer', points: [{ x: 1, y: 1 }], channel: 'mask' }, /not on masks/],
      [{ points: [{ x: 1, y: 1 }], mixer: { wet: 1 } }, /Mixer Brush only/],
      [{ tool: 'mixer', points: [{ x: 1, y: 1 }], mixer: { mixing: 'oil' } }, /Invalid arguments|enum|one of/],
      [{ tool: 'mixer', points: [{ x: 1, y: 1 }], mixer: { wet: 2 } }, /Invalid arguments|maximum/],
      [{ tool: 'mixer', points: [{ x: 1, y: 1 }], mixer: { dirty: true } }, /Invalid arguments|additional/],
      [{ tool: 'smudge', points: [{ x: 1, y: 1 }] }, /Invalid arguments|enum|one of/],
    ] as const) {
      const res = await registry.callTool('paint_stroke', args as never);
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(text(res)).toMatch(pattern);
    }
    expect(c.getState().layers).toBe(depth.layers);
    c.setLayerProperties(id, { locks: { pixels: true } });
    const locked = await registry.callTool('paint_stroke', { tool: 'mixer', points: [{ x: 1, y: 1 }], channel: 'pixels' });
    expect(text(locked)).toMatch(/locked/);
  });

  it('respects the selection', () => {
    const { c, id } = setup();
    c.selectRect({ x: 0, y: 0, width: 50, height: H });
    c.paintStroke({ tool: 'mixer', points: line(10, 4, 150), color: '#0000ff', brush: { size: 8, pressureSize: false }, mixer: { wet: 0, load: 1 } });
    expect(px(c, id, 30, 10)).toEqual([0, 0, 255, 255]);
    expect(px(c, id, 100, 10)).toEqual([255, 255, 0, 255]);
  });

  it('turns a pointer drag with the mixer tool into one undo step, and Shift+B picks it', () => {
    const { c, id } = setup();
    expect(handlePaintShortcut(c, { key: 'B', shiftKey: true })).toBe(true);
    expect(c.getState().activeTool).toBe('mixer');
    c.setPaintOptions({ foreground: '#0000ff', brush: { size: 8, pressureSize: false }, mixer: { mixing: 'pigment', wet: 1, load: 1 } });
    expect(c.getState().paint.mixer.mixing).toBe('pigment');
    const g = new PaintGesture(c);
    expect(g.down({ x: 4, y: 10, pressure: 1 })).toBeNull();
    g.moveTo([{ x: 40, y: 10, pressure: 1 }]);
    g.moveTo([{ x: 120, y: 10, pressure: 1 }]);
    g.up();
    const mixed = px(c, id, 60, 10);
    expect(mixed).not.toEqual([255, 255, 0, 255]);
    c.undo();
    expect(px(c, id, 60, 10)).toEqual([255, 255, 0, 255]);
    expect(handlePaintShortcut(c, { key: 'b' })).toBe(true);
    expect(c.getState().activeTool).toBe('brush');
  });
});
