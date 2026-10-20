import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { readRegion, TILE } from '../src/raster/surface';
import {
  DEFAULT_BLENDER,
  EMPTY_MIXER_LOAD,
  MIXER_DRAIN,
  MIXER_PICKUP_RATE,
  PaintExchange,
  SmudgeTip,
  TileMedium,
  blenderDab,
  createBlenderScratch,
  exchangeRates,
  mixPigments,
  mixerRates,
  normalizeMixer,
  rasterizeDab,
  dabRect,
  type PaintTileTarget,
} from '../src/paint';
import {
  BUILTIN_BRUSHES,
  PaintEditorController,
  createPaintEditorToolProvider,
  multiColorForDab,
  multiColorGradient,
  normalizePaintBrush,
  renderBrushThumbnail,
  usesPaintExchange,
  type PaintPixelLayer,
  type PenPoint,
} from '../src/paint-editor';

const line = (x0: number, y0: number, x1: number, y1: number, n = 24, extra: Partial<PenPoint> = {}): PenPoint[] =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n, ...extra }));

const rgbOf = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const hue = (hex: string) => {
  const [r, g, b] = rgbOf(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return NaN;
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const sat = (hex: string) => {
  const c = rgbOf(hex);
  return (Math.max(...c) - Math.min(...c)) / 255;
};

/** A single-tile target over a TILE × TILE RGBA buffer. */
function tileTarget(fill: (x: number, y: number) => [number, number, number, number] | null, lock = false): { target: PaintTileTarget; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(TILE * TILE * 4);
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const c = fill(x, y);
    if (c) data.set(c, (y * TILE + x) * 4);
  }
  const target: PaintTileTarget = {
    offset: { x: 0, y: 0 },
    lockTransparency: lock,
    selection: null,
    readTile: (tx, ty) => (tx === 0 && ty === 0 ? data : null),
    writeTile: (tx, ty) => {
      if (tx !== 0 || ty !== 0) throw new Error('outside the test tile');
      return data;
    },
  };
  return { target, data };
}

const px = (data: Uint8ClampedArray, x: number, y: number) => Array.from(data.slice((y * TILE + x) * 4, (y * TILE + x) * 4 + 4));
const hexAt = (data: Uint8ClampedArray, x: number, y: number) => '#' + px(data, x, y).slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');

const BLUE: [number, number, number, number] = [30, 64, 175, 255];
const YELLOW: [number, number, number, number] = [250, 204, 21, 255];

describe('the shared pick-up / mix exchange', () => {
  it('turns pick-up and mix ratios into per-dab rates exactly as the Mixer Brush does', () => {
    expect(exchangeRates(0.8, 0.5, 0.25, 'rgb')).toEqual({ pickup: MIXER_PICKUP_RATE * 0.8, mix: 0.5 * 0.8, drain: MIXER_DRAIN * 0.75, mixing: 'rgb' });
    const m = normalizeMixer({ wet: 0.6, mix: 0.3, load: 0.9, mixing: 'pigment' });
    expect(mixerRates(m)).toEqual(exchangeRates(0.6, 0.3, 0.9, 'pigment'));
  });

  it('picks up, mixes the reservoir with the well, and drains', () => {
    const ex = new PaintExchange(exchangeRates(1, 0.5, 0, 'rgb'), { reservoir: [1, 0, 0], amount: 1, pickup: null });
    const out: [number, number, number] = [0, 0, 0];
    // Clean brush: paints the reservoir.
    expect(ex.paint(out)).toBeCloseTo(0.5, 12);
    expect(out).toEqual([1, 0, 0]);
    // First contact fills the well; later contact moves it by rate × contact.
    ex.pickUp({ rgb: [0, 0, 1], contact: 1 });
    expect(ex.pickup).toEqual([0, 0, 1]);
    ex.pickUp({ rgb: [0, 1, 0], contact: 0.5 });
    expect(ex.pickup![1]).toBeCloseTo(MIXER_PICKUP_RATE * 0.5, 12);
    const total = ex.paint(out);
    expect(total).toBeCloseTo(0.5 + 0.5, 12);
    expect(out[0]).toBeCloseTo(0.5, 12);
    ex.drain();
    expect(ex.load.amount).toBeCloseTo(1 - MIXER_DRAIN, 12);
    // A dry exchange lifts nothing.
    const dry = new PaintExchange(exchangeRates(0, 0.5, 1, 'rgb'), { reservoir: [1, 0, 0], amount: 1, pickup: null });
    dry.pickUp({ rgb: [0, 0, 1], contact: 1 });
    expect(dry.pickup).toBeNull();
    // A multi-coloured brush recolours the reservoir without refilling it.
    ex.setReservoirColor(0, 1, 0);
    expect(ex.load.reservoir).toEqual([0, 1, 0]);
    expect(ex.load.amount).toBeCloseTo(1 - MIXER_DRAIN, 12);
  });

  it('a pigment exchange mixes blue picked up into yellow paint towards green', () => {
    const ex = new PaintExchange(exchangeRates(1, 0.5, 1, 'pigment'), { reservoir: [0.98, 0.8, 0.08], amount: 1, pickup: null });
    ex.pickUp({ rgb: [0.12, 0.25, 0.69], contact: 1 });
    const out: [number, number, number] = [0, 0, 0];
    ex.paint(out);
    expect(out[1]).toBeGreaterThan(out[0]);
    expect(out[1]).toBeGreaterThan(out[2]);
  });

  it('TileMedium samples by paint and deposits with any blend mode', () => {
    const { target, data } = tileTarget((x) => (x < 8 ? [200, 100, 50, 255] : null));
    const medium = new TileMedium(target, { blend: 'multiply' });
    const rect = { x: 4, y: 0, width: 8, height: 1 };
    const cov = new Float32Array(8).fill(1);
    const s = medium.sample(rect, cov)!;
    expect(s.contact).toBeCloseTo(0.5, 9);
    expect(s.rgb.map((v) => Math.round(v * 255))).toEqual([200, 100, 50]);
    medium.deposit(rect, cov, 1, [0.5, 0.5, 0.5], null);
    expect(px(data, 5, 0)).toEqual([100, 50, 25, 255]);
    // Over transparent pixels multiply lays the colour itself.
    expect(px(data, 9, 0)).toEqual([128, 128, 128, 255]);
    expect(new TileMedium(tileTarget(() => null).target).sample(rect, cov)).toBeNull();
  });
});

describe('blender', () => {
  const setup = (mixing: 'pigment' | 'rgb', lock = false) => {
    const { target, data } = tileTarget((x, y) => (y < 40 ? (x < 20 ? BLUE : YELLOW) : null), lock);
    const medium = new TileMedium(target);
    const d = { x: 20, y: 20, radius: 10, alpha: 1, opacity: 1, angle: 0, roundness: 1 };
    const rect = dabRect(d, 1);
    const cov = new Float32Array(rect.width * rect.height);
    rasterizeDab(d, 1, rect, cov);
    return { data, medium, d, rect, cov, settings: { ...DEFAULT_BLENDER, strength: 1, distance: 0.4, mixing } };
  };

  it('mixes the colours either side of an edge through the pigment model: blue and yellow make green', () => {
    const { data, medium, d, rect, cov, settings } = setup('pigment');
    blenderDab(medium, rect, cov, 1, d.radius, settings, createBlenderScratch());
    const mid = hexAt(data, 20, 20);
    expect(hue(mid)).toBeGreaterThan(70);
    expect(hue(mid)).toBeLessThan(170);
    // Outside the tip nothing changes.
    expect(px(data, 2, 2)).toEqual(BLUE);
    expect(px(data, 40, 2)).toEqual(YELLOW);
  });

  it('rgb mixing blends the same edge towards grey instead', () => {
    const pig = setup('pigment');
    blenderDab(pig.medium, pig.rect, pig.cov, 1, pig.d.radius, pig.settings, createBlenderScratch());
    const rgb = setup('rgb');
    blenderDab(rgb.medium, rgb.rect, rgb.cov, 1, rgb.d.radius, rgb.settings, createBlenderScratch());
    expect(sat(hexAt(rgb.data, 20, 20))).toBeLessThan(sat(hexAt(pig.data, 20, 20)));
  });

  it('softens an edge into bare canvas, unless transparency is locked', () => {
    const bare = tileTarget((x, y) => (y < 20 ? BLUE : null));
    const d = { x: 20, y: 20, radius: 8, alpha: 1, opacity: 1, angle: 0, roundness: 1 };
    const rect = dabRect(d, 1);
    const cov = new Float32Array(rect.width * rect.height);
    rasterizeDab(d, 1, rect, cov);
    blenderDab(new TileMedium(bare.target), rect, cov, 1, d.radius, { strength: 1, distance: 0.5, mixing: 'pigment' }, createBlenderScratch());
    expect(px(bare.data, 20, 18)[3]).toBeLessThan(255);
    expect(px(bare.data, 20, 22)[3]).toBeGreaterThan(0);
    const locked = tileTarget((x, y) => (y < 20 ? BLUE : null), true);
    blenderDab(new TileMedium(locked.target), rect, cov, 1, d.radius, { strength: 1, distance: 0.5, mixing: 'pigment' }, createBlenderScratch());
    expect(px(locked.data, 20, 18)[3]).toBe(255);
    expect(px(locked.data, 20, 22)[3]).toBe(0);
  });
});

describe('smudge', () => {
  it('drags paint along the stroke, further with a longer length', () => {
    const reach = (length: number) => {
      const { target, data } = tileTarget((x) => (x < 20 ? [200, 30, 30, 255] : [255, 255, 255, 255]));
      const medium = new TileMedium(target);
      const tip = new SmudgeTip({ strength: 0.9, length, mixing: 'rgb' }, 12);
      for (let x = 14; x <= 70; x += 1.5) {
        const d = { x, y: 30, radius: 6, alpha: 1, opacity: 1, angle: 0, roundness: 1 };
        const rect = dabRect(d, 0.8);
        const cov = new Float32Array(rect.width * rect.height);
        rasterizeDab(d, 0.8, rect, cov);
        tip.dab(medium, { x: d.x, y: d.y, radius: d.radius, opacity: 1 }, rect, cov);
      }
      let far = 0;
      for (let x = 20; x < 80; x++) if (px(data, x, 30)[1] < 200) far = x;
      return far;
    };
    const short = reach(0.3);
    const long = reach(0.95);
    expect(short).toBeGreaterThan(20);
    expect(long).toBeGreaterThan(short + 10);
  });

  it('pigment smudging smears blue into yellow as green', () => {
    const run = (mixing: 'rgb' | 'pigment') => {
      const { target, data } = tileTarget((x) => (x < 20 ? BLUE : YELLOW));
      const medium = new TileMedium(target);
      const tip = new SmudgeTip({ strength: 0.5, length: 0.8, mixing }, 12);
      for (let x = 12; x <= 40; x += 1.5) {
        const d = { x, y: 30, radius: 6, alpha: 1, opacity: 1, angle: 0, roundness: 1 };
        const rect = dabRect(d, 0.8);
        const cov = new Float32Array(rect.width * rect.height);
        rasterizeDab(d, 0.8, rect, cov);
        tip.dab(medium, { x: d.x, y: d.y, radius: d.radius, opacity: 1 }, rect, cov);
      }
      return Array.from({ length: 30 }, (_, i) => hexAt(data, 18 + i, 30));
    };
    const pig = run('pigment');
    const rgb = run('rgb');
    const greens = (row: string[]) => row.filter((h) => hue(h) > 80 && hue(h) < 160 && sat(h) > 0.25).length;
    expect(greens(pig)).toBeGreaterThan(3);
    expect(greens(pig)).toBeGreaterThan(greens(rgb));
  });
});

function canvas() {
  const c = new PaintEditorController({ width: 96, height: 48, paper: 'smooth' });
  c.fillLayer({ color: '#facc15' });
  // Blue on the left half, hard edged.
  c.paintStroke({ points: line(10, -10, 10, 60, 8), brush: { tip: { size: 60, hardness: 1, opacity: 1, flow: 1, pressureSize: false, spacing: 0.05, smoothing: 0 }, grain: 0 }, brushId: 'ink-pen', color: '#1e40af' });
  return c;
}

describe('paint editor brushes', () => {
  it('ships blender and smudge engines, pigment smudge and behaviour presets', () => {
    const by = new Map(BUILTIN_BRUSHES.map((b) => [b.id, b]));
    expect(by.get('blender')!.engine).toBe('blender');
    expect(by.get('blender')!.blender.mixing).toBe('pigment');
    expect(by.get('smudge')!.engine).toBe('smudge');
    expect(by.get('wet-smudge')!.smudge.mixing).toBe('pigment');
    expect(by.get('dirty-round')!.behavior).toMatchObject({ dirty: true, mixing: 'pigment' });
    expect(by.get('dirty-round')!.behavior.pickup).toBeGreaterThan(0);
    expect(by.get('multicolor-flat')!.behavior.multicolor.mode).toBe('tip');
    expect(by.get('palette-dabber')!.behavior.multicolor.mode).toBe('dab');
    expect(usesPaintExchange(by.get('dirty-round')!)).toBe(true);
    expect(usesPaintExchange(by.get('pencil-hb')!)).toBe(false);
    for (const b of BUILTIN_BRUSHES) expect(normalizePaintBrush(b, b)).toEqual({ ...b, builtin: undefined, ...(b.builtin ? { builtin: true } : {}) });
  });

  it("keeps a Mixer Brush's behaviour and mixer settings in sync, either way round", () => {
    const mixer = BUILTIN_BRUSHES.find((b) => b.id === 'mixer-brush')!;
    const a = normalizePaintBrush({ behavior: { pickup: 0.9, mix: 0.2, dirty: true, mixing: 'rgb' } }, mixer);
    expect(a.mixer).toMatchObject({ wet: 0.9, mix: 0.2, cleanEachStroke: false, mixing: 'rgb' });
    const b = normalizePaintBrush({ mixer: { wet: 0.1, mix: 0.7 } }, mixer);
    expect(b.behavior).toMatchObject({ pickup: 0.1, mix: 0.7 });
    // Dab brushes keep their own behaviour; the mixer block is left alone.
    const d = normalizePaintBrush({ behavior: { pickup: 0.4 } });
    expect(d.behavior.pickup).toBe(0.4);
    expect(d.mixer.wet).toBe(0.5);
    // Out-of-range and unknown values are clamped or ignored.
    const e = normalizePaintBrush({ behavior: { pickup: 3, multicolor: { mode: 'stripes' as never, colors: ['#ff0000', 'red', '#00FF00'], length: 0 } } });
    expect(e.behavior.pickup).toBe(1);
    // An unknown multi-colour mode turns nothing on (multi-colour is gradient paint now: `brush.paint`).
    expect(e.paint).toBeNull();
    expect(e.behavior.multicolor.mode).toBe('off');
  });

  it('a pick-up brush drags the colour it crosses, and a dirty brush carries it into the next stroke', () => {
    const c = canvas();
    const s1 = c.paintStroke({ points: line(4, 24, 90, 24, 40), brushId: 'dirty-round', color: '#ffffff' });
    expect(s1.mixerLoad?.pickup).toBeTruthy();
    // White paint pulled through blue keeps some blue on the yellow side.
    const after = rgbOf(c.pickColor(60, 24, { layerId: c.document.activeLayerId! }).color);
    expect(after[2]).toBeGreaterThan(after[0] - 80);
    const load = c.getState().mixerLoad;
    expect(load.pickup).toEqual(s1.mixerLoad!.pickup);
    // The next stroke starts dirty: on a fresh layer it still lays the carried colour in.
    const id = c.addLayer({ name: 'Clean' }).id;
    c.paintStroke({ points: line(10, 40, 30, 40, 10), brushId: 'dirty-round', color: '#ffffff', layerId: id });
    const dirty = c.pickColor(12, 40, { layerId: id }).color;
    expect(dirty).not.toBe('#ffffff');
    c.cleanMixerBrush();
    expect(c.getState().mixerLoad.pickup).toBeNull();
  });

  it('a pick-up brush on bare canvas matches the dry engine, opacity ceiling included', () => {
    const paint = (pickup: number) => {
      const c = new PaintEditorController({ width: 64, height: 32, paper: 'smooth' });
      c.paintStroke({ points: [...line(4, 16, 60, 16, 20), ...line(60, 16, 4, 18, 20)], color: '#2a4b8d', brushId: 'pencil-6b', brush: { tip: { opacity: 0.6, flow: 0.5 }, grain: 0, behavior: { pickup, mix: 0 } }, seed: 3 });
      return readRegion((c.getLayer(c.document.activeLayerId!) as PaintPixelLayer).surface, { x: 0, y: 0, width: 64, height: 32 });
    };
    const dry = paint(0);
    // A tiny pick-up ratio switches to the dab-by-dab engine but lifts nothing from bare canvas.
    const wet = paint(1e-6);
    let worst = 0;
    for (let i = 0; i < dry.length; i++) worst = Math.max(worst, Math.abs(dry[i] - wet[i]));
    expect(worst).toBeLessThanOrEqual(3);
  });

  it('a multi-colour tip lays its colours side by side across the stroke', () => {
    const c = new PaintEditorController({ width: 96, height: 48, paper: 'smooth' });
    const brush = { tip: { size: 30, roundness: 1, hardness: 1, opacity: 1, flow: 1, pressureSize: false }, behavior: { pickup: 0, multicolor: { mode: 'tip' as const, colors: ['#ff0000', '#0000ff'], softness: 0 } }, grain: 0 };
    c.paintStroke({ points: line(10, 24, 86, 24, 30), brushId: 'multicolor-flat', brush });
    const id = c.document.activeLayerId!;
    const top = rgbOf(c.pickColor(48, 14, { layerId: id }).color);
    const bottom = rgbOf(c.pickColor(48, 34, { layerId: id }).color);
    expect(top[0]).toBeGreaterThan(200);
    expect(top[2]).toBeLessThan(60);
    expect(bottom[2]).toBeGreaterThan(200);
    expect(bottom[0]).toBeLessThan(60);
  });

  it('a multi-colour dab brush walks through its palette (sequence) or picks per run (random, seeded)', () => {
    const palette: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const mc = { mode: 'dab' as const, colors: [], order: 'sequence' as const, length: 4, softness: 0 };
    expect(multiColorForDab(mc, palette, 0, 1, 'rgb')).toEqual([1, 0, 0]);
    expect(multiColorForDab(mc, palette, 4, 1, 'rgb')).toEqual([0, 1, 0]);
    expect(multiColorForDab(mc, palette, 12, 1, 'rgb')).toEqual([1, 0, 0]);
    const random = { ...mc, order: 'random' as const };
    const picks = Array.from({ length: 40 }, (_, i) => multiColorForDab(random, palette, i, 9, 'rgb').join());
    expect(picks).toEqual(Array.from({ length: 40 }, (_, i) => multiColorForDab(random, palette, i, 9, 'rgb').join()));
    expect(new Set(picks).size).toBeGreaterThan(1);
    // Each run of `length` dabs keeps one colour.
    for (let i = 0; i < 40; i += 4) expect(new Set(picks.slice(i, i + 4)).size).toBe(1);
    const g = multiColorGradient([[1, 0, 0], [0, 0, 1]], 1, 'rgb');
    expect(g[0]).toEqual([1, 0, 0]);
    expect(g[g.length - 1]).toEqual([0, 0, 1]);

    const c = new PaintEditorController({ width: 120, height: 32, paper: 'smooth' });
    c.paintStroke({ points: line(8, 16, 112, 16, 40), brushId: 'palette-dabber', brush: { behavior: { multicolor: { colors: ['#ff0000', '#00ff00'], length: 3 } }, dynamics: { scatter: 0, sizeJitter: 0 } } });
    const seen = new Set<string>();
    for (let x = 8; x < 112; x += 2) {
      const p = c.pickColor(x, 16, { layerId: c.document.activeLayerId! });
      if (p.alpha > 0.9) seen.add(rgbOf(p.color)[0] > rgbOf(p.color)[1] ? 'red' : 'green');
    }
    expect([...seen].sort()).toEqual(['green', 'red']);
  });

  it('the blender and smudge engines blend in the editor, with full pen input, one undo step each', async () => {
    const c = canvas();
    const id = c.document.activeLayerId!;
    const before = c.pickColor(30, 24, { layerId: id }).color;
    const undoBefore = c.historyLabels().undo.length;
    const r = c.paintStroke({ points: line(30, 4, 30, 44, 16, { pressure: 0.8 }), brushId: 'blender' });
    expect(r.mixerLoad).toBeUndefined();
    expect(c.historyLabels().undo.length).toBe(undoBefore + 1);
    const blended = c.pickColor(30, 24, { layerId: id }).color;
    expect(blended).not.toBe(before);
    expect(hue(blended)).toBeGreaterThan(60);
    expect(hue(blended)).toBeLessThan(180);

    const c2 = canvas();
    c2.paintStroke({ points: line(20, 24, 70, 24, 30), brushId: 'wet-smudge' });
    const smeared = c2.pickColor(45, 24, { layerId: c2.document.activeLayerId! }).color;
    expect(smeared).not.toBe('#facc15');
  });

  it('records the starting load, so a dirty stroke replays to the same pixels after the brush is cleaned', () => {
    const c = canvas();
    // Dirty the brush first.
    c.paintStroke({ points: line(4, 10, 40, 10, 12), brushId: 'dirty-round', color: '#ffffff' });
    const target = c.document.activeLayerId!;
    const copy = c.duplicateLayer(target).id;
    const s = c.paintStroke({ points: line(4, 30, 90, 30, 30), brushId: 'dirty-round', color: '#ffffff', layerId: target, seed: 5 });
    const stroke = c.getStrokes().find((x) => x.id === s.strokeId)!;
    expect(stroke.load?.pickup).toBeTruthy();
    c.cleanMixerBrush(true);
    c.replayStrokes({ strokeIds: [s.strokeId!], layerId: copy });
    const a = readRegion((c.getLayer(target) as PaintPixelLayer).surface, { x: 0, y: 0, width: 96, height: 48 });
    const b = readRegion((c.getLayer(copy) as PaintPixelLayer).surface, { x: 0, y: 0, width: 96, height: 48 });
    expect(Array.from(b)).toEqual(Array.from(a));
    // The load round-trips through the saved document.
    const back = new PaintEditorController();
    back.loadJSON(JSON.parse(JSON.stringify(c.toJSON())));
    expect(back.getStrokes().find((x) => x.id === s.strokeId)!.load).toEqual(stroke.load);
  });

  // One test per brush, so all ~55 thumbnails (several seconds on a CI runner) don't share one timeout.
  describe('renders a distinct thumbnail for every built-in brush, quickly', () => {
    const paper = new PaintEditorController().document.paper;
    const keys = new Map<string, string>();
    it.each(BUILTIN_BRUSHES.map((b) => [b.id, b] as const))('%s', (_id, b) => {
      // Best of up to three, so one GC pause or descheduling on a loaded runner doesn't count.
      let best = Infinity;
      let t!: ReturnType<typeof renderBrushThumbnail>;
      for (let i = 0; i < 3 && best >= 1500; i++) {
        const t0 = performance.now();
        t = renderBrushThumbnail(b, { paper, width: 112, height: 32, color: '#26324a' });
        best = Math.min(best, performance.now() - t0);
      }
      expect(t.data.length).toBe(112 * 32 * 4);
      expect(best, b.id).toBeLessThan(1500);
      keys.set(b.id, Buffer.from(t.data).toString('base64'));
    });
    it('no two thumbnails are the same', () => {
      expect(keys.size).toBe(BUILTIN_BRUSHES.length);
      expect(new Set(keys.values()).size).toBe(keys.size);
    });
  });

  it('keeps the library list stable while the active brush changes, so panels do not redraw thumbnails', () => {
    const c = new PaintEditorController();
    const list = c.getState().brushes;
    c.setBrush({ id: 'blender', blender: { strength: 0.9 } });
    c.setColor('#123456');
    expect(c.getState().brushes).toBe(list);
    c.saveBrush({ id: 'mine', name: 'Mine' });
    expect(c.getState().brushes).not.toBe(list);
    expect(c.getState().brushes.map((b) => b.id)).toContain('mine');
  });
});

describe('mixing pad', () => {
  it('mixes measured parts to the Kubelka-Munk mix and can make it the paint colour', () => {
    const c = new PaintEditorController();
    const r = c.mixOnPad([{ color: '#1e40af', parts: 1 }, { color: '#facc15', parts: 1 }], { setColor: true });
    const want = mixPigments([[0x1e / 255, 0x40 / 255, 0xaf / 255], [0xfa / 255, 0xcc / 255, 0x15 / 255]], [1, 1]).map((v) => Math.round(v * 255));
    const got = rgbOf(r.color);
    for (let k = 0; k < 3; k++) expect(Math.abs(got[k] - want[k])).toBeLessThanOrEqual(2);
    expect(c.getState().color).toBe(r.color);
    expect(r.bounds).toEqual({ x: 140, y: 70, width: 80, height: 80 });
    expect(() => c.mixOnPad([])).toThrow(/1 to 8 paints/);
    expect(() => c.mixOnPad([{ color: '#ff0000', parts: 1 }], { x: 10 })).toThrow(/does not fit/);
    expect(() => c.mixOnPad([{ color: '#ff0000', parts: 0 }])).toThrow(/0 parts/);
    expect(() => c.mixOnPad([{ color: 'red', parts: 1 }])).toThrow(/paints\[0\]\.color/);
  });

  it('keeps pads by name, loads them back and saves them with the document', () => {
    const c = new PaintEditorController();
    expect(() => c.saveMixingPad('Empty')).toThrow(/empty/);
    c.mixOnPad([{ color: '#b91c1c', parts: 1 }, { color: '#ffffff', parts: 2 }]);
    const saved = c.saveMixingPad('Pinks');
    expect(saved).toEqual({ id: 'pad1', name: 'Pinks' });
    const png = c.mixingPadPng();
    c.clearMixingPad();
    expect(c.mixingPad.pick(180, 110)).toBeNull();
    c.loadMixingPad('pad1');
    expect(c.mixingPadPng()).toBe(png);
    expect(c.getState().savedMixingPads).toEqual([{ id: 'pad1', name: 'Pinks' }]);
    const back = new PaintEditorController();
    back.loadJSON(JSON.parse(JSON.stringify(c.toJSON())));
    expect(back.listMixingPads()).toEqual([{ id: 'pad1', name: 'Pinks' }]);
    expect(back.mixingPadPng()).toBe(png);
    expect(back.saveMixingPad().id).toBe('pad2');
    expect(c.removeMixingPad('pad1')).toEqual(saved);
    expect(() => c.loadMixingPad('pad1')).toThrow(/Unknown mixing pad "pad1"/);
    expect(() => c.setMixingPadPng('nope')).toThrow(/not a PNG/);
  });
});

describe('agent tools for blending and behaviours', () => {
  const setup = () => {
    const c = canvas();
    const r = new ToolRegistry();
    r.register(createPaintEditorToolProvider(c));
    return { c, r };
  };
  const ok = (res: { isError?: boolean; structuredContent?: unknown; content: unknown[] }) => {
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    return res.structuredContent as any;
  };
  const text = (res: { content: unknown[] }) => (res.content[0] as { text: string }).text;

  it('set_brush validates and applies the new blocks', async () => {
    const { c, r } = setup();
    expect((await r.callTool('set_brush', { id: 'nope' })).isError).toBe(true);
    const brush = ok(await r.callTool('set_brush', { id: 'pencil-6b', behavior: { pickup: 0.5, mix: 0.6, dirty: true, multicolor: { mode: 'dab', colors: ['#ff0000', '#00ff00'], order: 'random', length: 5 } } }));
    expect(brush.behavior).toMatchObject({ pickup: 0.5, mix: 0.6, dirty: true, multicolor: { mode: 'dab', order: 'random', length: 5, colors: ['#ff0000', '#00ff00'] } });
    expect(c.getState().brush.behavior.pickup).toBe(0.5);
    const blender = ok(await r.callTool('set_brush', { id: 'blender', blender: { strength: 0.8, distance: 0.2, mixing: 'rgb' } }));
    expect(blender.blender).toEqual({ strength: 0.8, distance: 0.2, mixing: 'rgb' });
    const smudge = ok(await r.callTool('set_brush', { id: 'smudge', smudge: { mixing: 'pigment', length: 0.95 } }));
    expect(smudge.smudge).toMatchObject({ mixing: 'pigment', length: 0.95 });
    const mixer = ok(await r.callTool('set_brush', { id: 'mixer-brush', behavior: { pickup: 0.2 } }));
    expect(mixer.mixer.wet).toBe(0.2);
    for (const bad of [{ behavior: { pickup: 2 } }, { behavior: { multicolor: { mode: 'stripes' } } }, { behavior: { multicolor: { colors: ['red'] } } }, { blender: { distance: -1 } }, { smudge: { mixing: 'oil' } }, { behavior: { wet: 1 } }]) {
      const res = await r.callTool('set_brush', bad);
      expect(res.isError, JSON.stringify(bad)).toBe(true);
    }
    const list = ok(await r.callTool('list_brushes', {}));
    const dirty = list.brushes.find((x: { id: string }) => x.id === 'dirty-round');
    expect(dirty).toMatchObject({ engine: 'dab', category: 'paint', wetCapable: true, dirty: true, multicolor: 'off' });
    expect(list.brushes.find((x: { id: string }) => x.id === 'blender').wetCapable).toBe(false);
  });

  it('paint_stroke with a dirty brush returns what it carries; get and clean the load', async () => {
    const { r } = setup();
    const res = ok(await r.callTool('paint_stroke', { points: line(4, 24, 90, 24, 30), brushId: 'dirty-round', color: '#ffffff' }));
    expect(res.mixerLoad.pickup).toMatch(/^#[0-9a-f]{6}$/);
    expect(ok(await r.callTool('get_mixer_brush', {})).pickup).toBe(res.mixerLoad.pickup);
    expect(ok(await r.callTool('clean_mixer_brush', {})).pickup).toBeNull();
    const blend = ok(await r.callTool('paint_stroke', { points: line(30, 4, 30, 44, 12), brushId: 'blender' }));
    expect(blend.mixerLoad).toBeUndefined();
    expect(blend.bounds).toBeTruthy();
  });

  it('mix_colors mixes as pigment by default and as RGB on request', async () => {
    const { r } = setup();
    const colors = [{ color: '#1e40af', weight: 1 }, { color: '#facc15', weight: 1 }];
    const pig = ok(await r.callTool('mix_colors', { colors }));
    expect(pig.model).toBe('kubelka-munk');
    expect(pig.mixed).toBe(pig.pigment);
    const rgb = ok(await r.callTool('mix_colors', { colors, model: 'rgb' }));
    expect(rgb.model).toBe('rgb');
    expect(rgb.mixed).toBe(rgb.rgbLerp);
    expect(rgb.pigment).toBe(pig.pigment);
    expect((await r.callTool('mix_colors', { colors, model: 'ryb' })).isError).toBe(true);
  });

  it('mix_on_pad, save, list, load and remove mixing pads, with useful errors', async () => {
    const { c, r } = setup();
    const mixed = ok(await r.callTool('mix_on_pad', { paints: [{ color: '#1e40af', parts: 1 }, { color: '#ffffff', parts: 3 }], setColor: true }));
    expect(mixed.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(c.getState().color).toBe(mixed.color);
    const pick = ok(await r.callTool('pick_mixing_pad_color', { x: 180, y: 110, radius: 1 }));
    expect(pick.color).toBe(mixed.color);
    const saved = ok(await r.callTool('save_mixing_pad', { name: 'Sky' }));
    expect(saved).toEqual({ id: 'pad1', name: 'Sky' });
    expect(ok(await r.callTool('list_mixing_pads', {})).pads).toEqual([saved]);
    ok(await r.callTool('clear_mixing_pad', {}));
    expect(ok(await r.callTool('load_mixing_pad', { id: 'pad1' }))).toEqual(saved);
    expect(ok(await r.callTool('remove_mixing_pad', { id: 'pad1' }))).toEqual(saved);
    const missing = await r.callTool('load_mixing_pad', { id: 'pad1' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/list_mixing_pads/);
    const tooBig = await r.callTool('mix_on_pad', { paints: [{ color: '#ff0000', parts: 1 }], x: 20, y: 20, radius: 60 });
    expect(tooBig.isError).toBe(true);
    expect(text(tooBig)).toMatch(/does not fit/);
    expect((await r.callTool('mix_on_pad', { paints: [] })).isError).toBe(true);
    c.clearMixingPad();
    const empty = await r.callTool('save_mixing_pad', {});
    expect(empty.isError).toBe(true);
    expect(text(empty)).toMatch(/empty/);
  });

  it('starts from the empty load', () => {
    expect(EMPTY_MIXER_LOAD).toEqual({ reservoir: null, amount: 0, pickup: null });
  });
});
