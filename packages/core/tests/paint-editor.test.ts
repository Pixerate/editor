import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { createDocumentToolProvider } from '../src/persistence';
import { decodePng } from '../src/raster/png';
import { contentBounds, readPixel, readRegion } from '../src/raster/surface';
import { importPsd } from '../src/image-editor/psd/import';
import {
  BUILTIN_BRUSHES,
  DryStroke,
  GRAIN_PATTERNS,
  PAPER_LIBRARY,
  PaintEditorController,
  PaintEditorError,
  PaperGrain,
  PenDabWalker,
  PenSmoother,
  createPaintEditorDocument,
  createPaintEditorToolProvider,
  documentToScreen,
  grainCatch,
  isPalmTouch,
  normalizePaintBrush,
  normalizePaper,
  paperPreset,
  pointerToPenPoint,
  renderBrushThumbnail,
  screenToDocument,
  tiltToOrientation,
  viewPenToDocument,
  type PaintPixelLayer,
  type PenDab,
  type PenPoint,
} from '../src/paint-editor';

const line = (x0: number, y0: number, x1: number, y1: number, n = 24, extra: Partial<PenPoint> = {}): PenPoint[] =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n, ...extra }));

const layerOf = (c: PaintEditorController, id = c.document.activeLayerId!) => c.getLayer(id) as PaintPixelLayer;

function painted(c: PaintEditorController, id?: string): number {
  const l = layerOf(c, id);
  const b = contentBounds(l.surface);
  if (!b) return 0;
  const px = readRegion(l.surface, b);
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
  return n;
}

describe('paper', () => {
  it('ships a generated library in families with the wet-media properties', () => {
    expect(PAPER_LIBRARY.length).toBeGreaterThanOrEqual(10);
    expect(new Set(PAPER_LIBRARY.map((p) => p.family))).toEqual(new Set(['watercolor', 'drawing', 'pastel', 'canvas', 'panel', 'smooth']));
    for (const p of PAPER_LIBRARY) {
      for (const k of ['absorption', 'permeability', 'roughness', 'depth'] as const) expect(p[k]).toBeGreaterThanOrEqual(0);
      expect(normalizePaper(p)).toEqual(p);
    }
    expect(paperPreset('nope')).toBeUndefined();
  });

  it('normalises out-of-range settings and keeps the preset base', () => {
    const p = normalizePaper({ preset: 'cotton-canvas', depth: 4, scale: 0, color: 'red', tiling: 'x' as never });
    expect(p.pattern).toBe('canvas');
    expect(p.depth).toBe(1);
    expect(p.scale).toBe(0.25);
    expect(p.color).toBe('#efe9dc');
    expect(p.tiling).toBe('mirror');
  });

  it('every grain pattern stays in 0..1, varies (except smooth) and tiles seamlessly', () => {
    for (const pattern of GRAIN_PATTERNS) {
      const g = new PaperGrain(normalizePaper({ pattern, tiling: 'repeat' }));
      let lo = 1;
      let hi = 0;
      for (let y = 0; y < 256; y += 3)
        for (let x = 0; x < 256; x += 3) {
          const h = g.at(x + 0.5, y + 0.5);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
          expect(h).toBeGreaterThanOrEqual(0);
          expect(h).toBeLessThanOrEqual(1);
          expect(Math.abs(g.at(x + 256.5, y + 0.5) - h)).toBeLessThan(1e-6);
        }
      if (pattern === 'smooth') expect(hi - lo).toBe(0);
      else expect(hi - lo, pattern).toBeGreaterThan(0.25);
    }
  });

  it('mirror tiling reflects alternate tiles; a new seed is a new sheet', () => {
    const g = new PaperGrain(normalizePaper({ pattern: 'cold-pressed', tiling: 'mirror' }));
    expect(g.at(256 + 10.5, 40.5)).toBeCloseTo(g.at(256 - 10.5, 40.5), 5);
    const a = new PaperGrain(normalizePaper({ pattern: 'cold-pressed', seed: 1 }));
    const b = new PaperGrain(normalizePaper({ pattern: 'cold-pressed', seed: 2 }));
    expect(a.at(50, 50)).not.toBeCloseTo(b.at(50, 50), 4);
  });

  it('dry media catch the peaks: more pressure reaches the valleys, depth 0 ignores the grain', () => {
    expect(grainCatch(0.1, 0, 0)).toBe(1);
    expect(grainCatch(0.95, 1, 0)).toBeGreaterThan(grainCatch(0.3, 1, 0));
    expect(grainCatch(0.3, 1, 1)).toBeGreaterThan(grainCatch(0.3, 1, 0.1));
    for (let h = 0; h <= 1; h += 0.1) expect(grainCatch(h, 0.6, 0.5)).toBeGreaterThanOrEqual(0.4 - 1e-9);
  });

  it('dry tuning: contrast and invert change the height field', () => {
    const base = normalizePaper({ pattern: 'rough' });
    const inv = new PaperGrain(normalizePaper({ ...base, dry: { contrast: 1, invert: true } }));
    const g = new PaperGrain(base);
    expect(inv.at(30.5, 30.5)).toBeCloseTo(1 - g.at(30.5, 30.5), 5);
  });
});

describe('pen input and the dab walk', () => {
  it('converts tilt to altitude and azimuth', () => {
    expect(tiltToOrientation(0, 0)).toEqual({ altitude: Math.PI / 2, azimuth: 0 });
    const right = tiltToOrientation(45, 0);
    expect(right.altitude).toBeCloseTo(Math.PI / 4, 6);
    expect(right.azimuth).toBeCloseTo(0, 6);
    const down = tiltToOrientation(0, 30);
    expect(down.azimuth).toBeCloseTo(Math.PI / 2, 6);
    expect(down.altitude).toBeCloseTo((60 * Math.PI) / 180, 6);
  });

  it('reads pointer samples: mice are full pressure, pens keep tilt and twist, the view turns them', () => {
    expect(pointerToPenPoint({ pointerType: 'mouse', pressure: 0.5, tiltX: 30 }, 1, 2)).toEqual({ x: 1, y: 2, pressure: 1 });
    const p = pointerToPenPoint({ pointerType: 'pen', pressure: 0.3, tiltX: 0, tiltY: 45, twist: 90, timeStamp: 5 }, 0, 0);
    expect(p.pressure).toBe(0.3);
    expect(p.azimuth).toBeCloseTo(Math.PI / 2, 6);
    expect(p.twist).toBe(90);
    expect(p.t).toBe(5);
    const turned = viewPenToDocument({ zoom: 1, pan: { x: 0, y: 0 }, rotation: 90, mirror: false }, { azimuth: Math.PI / 2, twist: 90 });
    expect(turned.azimuth).toBeCloseTo(0, 6);
    expect(turned.twist).toBe(0);
    expect(pointerToPenPoint({ pointerType: 'pen', pressure: 0 }, 0, 0).pressure).toBe(1);
  });

  it('smooths position and pressure separately', () => {
    const s = new PenSmoother(0, 0.9);
    s.push({ x: 0, y: 0, pressure: 0 });
    const q = s.push({ x: 10, y: 0, pressure: 1 });
    expect(q.x).toBe(10);
    expect(q.pressure).toBeCloseTo(0.1, 6);
    const t = new PenSmoother(0.5, 0);
    t.push({ x: 0, y: 0, pressure: 0 });
    const r = t.push({ x: 10, y: 0, pressure: 1 });
    expect(r.x).toBe(5);
    expect(r.pressure).toBe(1);
  });

  it('gives the same dabs however the points are chunked, and the same jitter for the same seed', () => {
    const brush = BUILTIN_BRUSHES.find((b) => b.id === 'charcoal-stick')!;
    const pts = line(0, 0, 200, 80, 40, { pressure: 0.7 });
    const all = (chunks: PenPoint[][], seed: number) => {
      const w = new PenDabWalker(brush, seed);
      const out: PenDab[] = [];
      for (const c of chunks) for (const p of c) w.push(p, out);
      w.finish(out);
      return out;
    };
    const a = all([pts], 3);
    const b = all([pts.slice(0, 7), pts.slice(7, 30), pts.slice(30)], 3);
    expect(b).toEqual(a);
    expect(all([pts], 4)).not.toEqual(a);
  });

  it('rotation modes: fixed, follow the stroke, barrel', () => {
    const base = normalizePaintBrush({ tip: { size: 10, spacing: 0.5, angle: 0, roundness: 0.3 } });
    const walk = (rotation: 'fixed' | 'stroke' | 'barrel', pts: PenPoint[]) => {
      const w = new PenDabWalker({ ...base, rotation });
      const out: PenDab[] = [];
      for (const p of pts) w.push(p, out);
      return out;
    };
    const down = line(0, 0, 0, 100, 10);
    expect(walk('fixed', down)[3].angle).toBeCloseTo(0, 6);
    // Moving down the screen is -90° in the rasterizer's counter-clockwise, y-up angles.
    expect(walk('stroke', down)[3].angle).toBeCloseTo(-Math.PI / 2, 6);
    const twisted = down.map((p) => ({ ...p, twist: 30 }));
    expect(walk('barrel', twisted)[3].angle).toBeCloseTo((-30 * Math.PI) / 180, 6);
  });

  it('tilt widens and flattens, velocity thins an ink pen', () => {
    const pencil = BUILTIN_BRUSHES.find((b) => b.id === 'pencil-hb')!;
    const dab = (p: PenPoint) => {
      const w = new PenDabWalker(pencil);
      const out: PenDab[] = [];
      w.push(p, out);
      w.finish(out);
      return out[0];
    };
    const upright = dab({ x: 0, y: 0, pressure: 1 });
    const flat = dab({ x: 0, y: 0, pressure: 1, altitude: 0.2, azimuth: 0 });
    expect(flat.radius).toBeGreaterThan(upright.radius * 1.5);
    expect(flat.roundness).toBeLessThan(upright.roundness);
    const ink = BUILTIN_BRUSHES.find((b) => b.id === 'ink-pen')!;
    const radii = (dt: number) => {
      const w = new PenDabWalker(ink);
      const out: PenDab[] = [];
      for (const [i, p] of line(0, 0, 300, 0, 30).entries()) w.push({ ...p, t: i * dt }, out);
      return out[out.length - 1].radius;
    };
    expect(radii(40)).toBeGreaterThan(radii(2));
  });

  it('paints symmetric copies into one coverage map', () => {
    const brush = normalizePaintBrush({ tip: { size: 6, hardness: 1 } });
    const mirror = { map: (p: PenPoint) => ({ ...p, x: 100 - p.x }), linear: [-1, 0, 0, 1] as const };
    const s = new DryStroke(brush, { grain: null, paperDepth: 0, copies: [{ map: (p) => p, linear: [1, 0, 0, 1] }, mirror] });
    s.push(line(10, 50, 30, 50, 10));
    s.finish();
    expect(s.coverage.get(20, 50)).toBeGreaterThan(0.9);
    expect(s.coverage.get(80, 50)).toBeGreaterThan(0.9);
    expect(s.coverage.get(50, 50)).toBe(0);
  });

  it('palm rejection by hand', () => {
    expect(isPalmTouch({ x: 150, y: 150 }, { x: 100, y: 100 }, 'right')).toBe(true);
    expect(isPalmTouch({ x: 50, y: 150 }, { x: 100, y: 100 }, 'right')).toBe(false);
    expect(isPalmTouch({ x: 50, y: 150 }, { x: 100, y: 100 }, 'left')).toBe(true);
    expect(isPalmTouch({ x: 150, y: 150 }, null, 'right')).toBe(false);
  });
});

describe('view', () => {
  it('maps document to screen and back through zoom, rotation and mirroring', () => {
    const canvas = { width: 400, height: 300 };
    const viewport = { width: 800, height: 600 };
    const view = { zoom: 2, pan: { x: 10, y: -5 }, rotation: 30, mirror: true };
    const s = documentToScreen(view, canvas, viewport, 50, 70);
    const d = screenToDocument(view, canvas, viewport, s.x, s.y);
    expect(d.x).toBeCloseTo(50, 6);
    expect(d.y).toBeCloseTo(70, 6);
    expect(documentToScreen({ zoom: 1, pan: { x: 0, y: 0 }, rotation: 0, mirror: false }, canvas, viewport, 200, 150)).toEqual({ x: 400, y: 300 });
    // A quarter turn clockwise: the canvas's right goes down.
    const q = documentToScreen({ zoom: 1, pan: { x: 0, y: 0 }, rotation: 90, mirror: false }, canvas, viewport, 210, 150);
    expect(q.x).toBeCloseTo(400, 6);
    expect(q.y).toBeCloseTo(310, 6);
  });
});

describe('PaintEditorController', () => {
  it('starts with one layer over cold-pressed paper and validates the canvas', () => {
    const c = new PaintEditorController({ width: 64, height: 32 });
    expect(c.document.canvas).toEqual({ width: 64, height: 32, dpi: 300 });
    expect(c.document.paper.preset).toBe('cold-pressed');
    expect(c.listLayers()).toHaveLength(1);
    expect(() => new PaintEditorController({ width: 0, height: 10 })).toThrow(/width 0 is out of range/);
    expect(() => new PaintEditorController({ paper: 'nope' })).toThrow(/Unknown paper "nope"/);
  });

  it('a stroke is one undo step and is recorded', () => {
    const c = new PaintEditorController({ width: 128, height: 64, paper: 'smooth' });
    const r = c.paintStroke({ points: line(10, 32, 110, 32), brushId: 'ink-pen', color: '#ff0000' });
    expect(r.bounds).not.toBeNull();
    expect(r.strokeId).toBe('s1');
    expect(c.getStrokes()).toHaveLength(1);
    expect(readPixel(layerOf(c).surface, 60, 32)).toEqual([255, 0, 0, 255]);
    expect(c.getState().undoLabel).toBe('Ink pen stroke');
    c.undo();
    expect(contentBounds(layerOf(c).surface)).toBeNull();
    expect(c.getStrokes()).toHaveLength(0);
    c.redo();
    expect(painted(c)).toBeGreaterThan(0);
  });

  it('a live stroke shows while painting and commits once', () => {
    const c = new PaintEditorController({ width: 128, height: 64, paper: 'smooth' });
    const s = c.beginStroke({ brushId: 'ink-pen' });
    expect(c.getState().stroking).toBe(true);
    expect(() => c.undo()).toThrow(/stroke is in progress/);
    s.push(line(10, 10, 60, 10, 10));
    const mid = c.compositePixels({ paper: false });
    expect(mid.data[(10 * 128 + 30) * 4 + 3]).toBeGreaterThan(0);
    expect(c.getState().canUndo).toBe(false);
    s.push(line(60, 10, 100, 40, 10));
    s.end();
    expect(c.getState().canUndo).toBe(true);
    expect(c.historyLabels().undo).toEqual(['Ink pen stroke']);
    const s2 = c.beginStroke();
    s2.push(line(0, 50, 100, 50));
    s2.cancel();
    expect(c.historyLabels().undo).toHaveLength(1);
    expect(c.takeDirty()).toBe('all');
  });

  it('grain-responsive brushes catch the peaks: light pressure marks less of a rough paper than firm pressure', () => {
    const run = (paper: string, pressure: number) => {
      const c = new PaintEditorController({ width: 200, height: 60, paper });
      c.setPaper({ depth: 1 });
      c.paintStroke({ points: line(10, 30, 190, 30, 60, { pressure }), brushId: 'soft-pastel', brush: { tip: { size: 30, pressureOpacity: false } } });
      return painted(c);
    };
    const light = run('rough-watercolor', 0.15);
    const firm = run('rough-watercolor', 1);
    expect(firm).toBeGreaterThan(light * 1.2);
    // On smooth paper pressure no longer gates the grain.
    expect(run('smooth', 0.15)).toBeGreaterThan(light);
  });

  it('refuses locked, hidden and group targets with useful messages', () => {
    const c = new PaintEditorController({ width: 32, height: 32 });
    const id = c.document.activeLayerId!;
    c.updateLayer(id, { locks: { pixels: true } });
    expect(() => c.paintStroke({ points: [{ x: 1, y: 1 }] })).toThrow(/pixels locked; unlock it/);
    c.updateLayer(id, { locks: { pixels: false }, visible: false });
    expect(() => c.paintStroke({ points: [{ x: 1, y: 1 }] })).toThrow(/hidden; show it/);
    const g = c.addLayer({ type: 'group' });
    expect(() => c.paintStroke({ points: [{ x: 1, y: 1 }], layerId: g.id })).toThrow(/is a group/);
    expect(() => c.paintStroke({ points: [], layerId: id })).toThrow(/points is empty/);
    expect(() => c.paintStroke({ points: [{ x: 1, y: 1, pressure: 3 }], layerId: id })).toThrow(PaintEditorError);
    expect(() => c.paintStroke({ points: [{ x: 1, y: 1 }], layerId: 'zz' })).toThrow(/Unknown layer "zz"/);
  });

  it('transparency lock paints only where the layer has paint', () => {
    const c = new PaintEditorController({ width: 64, height: 32, paper: 'smooth' });
    c.paintStroke({ points: line(0, 10, 63, 10), brushId: 'ink-pen', brush: { tip: { size: 6 } }, color: '#000000' });
    c.updateLayer(c.document.activeLayerId!, { locks: { transparency: true } });
    c.paintStroke({ points: line(32, 0, 32, 31), brushId: 'ink-pen', brush: { tip: { size: 6 } }, color: '#00ff00' });
    expect(readPixel(layerOf(c).surface, 32, 10)).toEqual([0, 255, 0, 255]);
    expect(readPixel(layerOf(c).surface, 32, 25)[3]).toBe(0);
  });

  it('layers: add, rename, reorder, group, duplicate, merge down, remove', () => {
    const c = new PaintEditorController({ width: 32, height: 32, paper: 'smooth' });
    const bottom = c.document.activeLayerId!;
    c.fillLayer({ color: '#0000ff' });
    const top = c.addLayer({ name: 'Ink' });
    expect(c.listLayers().map((l) => l.name)).toEqual(['Ink', 'Layer 1']);
    c.paintStroke({ points: line(0, 16, 31, 16), brushId: 'ink-pen', color: '#ff0000', brush: { tip: { size: 4 } } });
    c.updateLayer(top.id, { opacity: 0.5, name: 'Red' });
    const dup = c.duplicateLayer(top.id);
    expect(c.listLayers()[0].name).toBe('Red copy');
    c.moveLayer(dup.id, 0);
    expect(c.listLayers().map((l) => l.id)).toEqual([top.id, bottom, dup.id]);
    c.removeLayer(dup.id);
    const merged = c.mergeDown(top.id);
    expect(merged.id).toBe(bottom);
    expect(c.listLayers()).toHaveLength(1);
    const px = readPixel(layerOf(c, bottom).surface, 10, 16);
    expect(px[0]).toBeGreaterThan(100);
    expect(px[2]).toBeGreaterThan(100);
    const g = c.addLayer({ type: 'group', name: 'G' });
    const inside = c.addLayer({ parentId: g.id, name: 'Inside' });
    expect(c.listLayers().find((l) => l.id === inside.id)?.parentId).toBe(g.id);
    expect(() => c.moveLayer(g.id, 0, inside.id)).toThrow(/not a group/);
    expect(() => c.updateLayer(bottom, { blend: 'bogus' as never })).toThrow(/Unknown blend mode/);
    expect(() => c.updateLayer(bottom, { opacity: 2 })).toThrow(/out of range/);
  });

  it('fills flat or along the paper grain, and clears', () => {
    const c = new PaintEditorController({ width: 128, height: 128, paper: 'rough-watercolor' });
    c.fillLayer({ color: '#336699' });
    expect(painted(c)).toBe(128 * 128);
    c.clearLayer();
    expect(painted(c)).toBe(0);
    c.setPaper({ depth: 1 });
    c.fillLayer({ color: '#336699', grain: 1, pressure: 0 });
    const l = layerOf(c);
    let full = 0;
    let partial = 0;
    for (let y = 0; y < 128; y += 2)
      for (let x = 0; x < 128; x += 2) {
        const a = readPixel(l.surface, x, y)[3];
        if (a === 255) full++;
        else partial++;
      }
    expect(full).toBeGreaterThan(0);
    expect(partial).toBeGreaterThan(full);
  });

  it('paper changes are undo steps; presets and custom settings', () => {
    const c = new PaintEditorController({ width: 16, height: 16 });
    const p = c.setPaper({ preset: 'gesso' });
    expect(p.pattern).toBe('gesso');
    c.setPaper({ color: '#202020', depth: 0.9 });
    expect(c.document.paper.color).toBe('#202020');
    expect(c.document.paper.pattern).toBe('gesso');
    expect(() => c.setPaper({ color: 'blue' })).toThrow(/use #rrggbb/);
    expect(() => c.setPaper({ preset: 'nope' })).toThrow(/Unknown paper/);
    c.undo();
    expect(c.document.paper.color).toBe('#f6f4ef');
    const px = c.compositePixels().data;
    expect(px[3]).toBe(255);
  });

  it('smudge moves paint and the Mixer Brush mixes like pigment', () => {
    const c = new PaintEditorController({ width: 120, height: 40, paper: 'smooth' });
    c.fillLayer({ color: '#ffff00' });
    c.paintStroke({ points: line(10, 20, 40, 20), brushId: 'ink-pen', brush: { tip: { size: 16 } }, color: '#0000ff' });
    const before = readPixel(layerOf(c).surface, 70, 20);
    c.paintStroke({ points: line(25, 20, 110, 20, 40), brushId: 'smudge' });
    const after = readPixel(layerOf(c).surface, 70, 20);
    expect(after).not.toEqual(before);
    expect(after[2]).toBeGreaterThan(before[2]);
    const r = c.paintStroke({ points: line(10, 30, 110, 30, 40), brushId: 'mixer-brush', color: '#0000ff', brush: { mixer: { wet: 1, mix: 1, load: 1 } } });
    expect(r.mixerLoad?.reservoir).not.toBeNull();
    const [red, green, blue] = readPixel(layerOf(c).surface, 100, 30);
    // Blue dragged through yellow with pigment mixing reads green, not grey.
    expect(green).toBeGreaterThan(red);
    expect(green).toBeGreaterThan(blue - 40);
  });

  it('replays strokes exactly, and varied', () => {
    const c = new PaintEditorController({ width: 200, height: 100, paper: 'cold-pressed' });
    const first = c.paintStroke({ points: line(10, 20, 90, 60, 30, { pressure: 0.6 }), brushId: 'charcoal-stick' });
    const original = layerOf(c).surface;
    const other = c.addLayer({ name: 'Copy' });
    const res = c.replayStrokes({ strokeIds: [first.strokeId!], layerId: other.id });
    expect(res.strokeIds).toEqual(['s2']);
    const a = readRegion(original, { x: 0, y: 0, width: 200, height: 100 });
    const b = readRegion(layerOf(c, other.id).surface, { x: 0, y: 0, width: 200, height: 100 });
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
    c.undo();
    const moved = c.replayStrokes({ strokeIds: [first.strokeId!], layerId: other.id, dx: 100, repeat: 1, color: '#ff0000' });
    expect(moved.bounds!.x).toBeGreaterThan(60);
    const fan = c.replayStrokes({ strokeIds: ['s1'], rotate: 30, repeat: 3, origin: { x: 10, y: 20 } });
    expect(fan.strokeIds).toHaveLength(3);
    expect(c.historyLabels().undo.at(-1)).toBe('Replay strokes');
    expect(() => c.replayStrokes({ strokeIds: ['nope'] })).toThrow(/Unknown stroke "nope"/);
    expect(() => c.replayStrokes({ strokeIds: ['s1'], repeat: 0 })).toThrow(/repeat 0/);
  });

  it('saves and loads JSON with PNG assets, strokes and unknown fields', () => {
    const c = new PaintEditorController({ width: 96, height: 64, dpi: 150, paper: 'laid' });
    c.paintStroke({ points: line(5, 5, 90, 60), brushId: 'pencil-6b', color: '#123456' });
    const g = c.addLayer({ type: 'group', name: 'Group' });
    c.addLayer({ parentId: g.id, name: 'Child' });
    c.fillLayer({ color: '#ff00ff', opacity: 0.25 });
    const json = c.toJSON();
    expect(json.format).toBe('pixerate-paint');
    expect(json.version).toBe(1);
    expect(Object.keys(json.assets).length).toBe(2);
    const text = JSON.stringify({ ...json, futureField: { future: true } });
    const d = new PaintEditorController();
    expect(d.loadJSON(JSON.parse(text))).toEqual([]);
    expect(d.document.canvas).toEqual({ width: 96, height: 64, dpi: 150 });
    expect(d.document.paper.preset).toBe('laid');
    expect(d.listLayers().map((l) => l.name)).toEqual(c.listLayers().map((l) => l.name));
    expect(d.getStrokes()).toHaveLength(1);
    expect(Buffer.from(d.compositePixels().data).equals(Buffer.from(c.compositePixels().data))).toBe(true);
    expect((d.toJSON() as Record<string, unknown>).futureField).toEqual({ future: true });
    expect(d.toJSON({ strokes: false }).strokes).toBeUndefined();
    // Strokes keep counting after a load.
    expect(d.paintStroke({ points: [{ x: 3, y: 3 }] }).strokeId).toBe('s2');
    expect(() => d.loadJSON({ format: 'other' })).toThrow(/Not a paint document/);
    expect(() => d.loadJSON({ format: 'pixerate-paint', version: 9, width: 1, height: 1 })).toThrow(/newer than this editor/);
  });

  it('exports PNG (pure), refuses JPEG without a canvas, and writes PSD with the paper as a layer', async () => {
    const c = new PaintEditorController({ width: 40, height: 30, paper: 'smooth' });
    c.paintStroke({ points: line(0, 15, 39, 15), brushId: 'ink-pen', color: '#ff0000' });
    const png = decodePng(c.exportPng());
    expect([png.width, png.height]).toEqual([40, 30]);
    expect(decodePng(c.exportPng({ scale: 0.5 })).width).toBe(20);
    const clear = decodePng(c.exportPng({ paper: false }));
    expect(clear.data[3]).toBe(0);
    await expect(c.exportImage({ format: 'image/jpeg' })).rejects.toThrow(/needs a canvas/);
    const withEncoder = new PaintEditorController({ width: 8, height: 8, encodeImage: async (img, format) => new Uint8Array([img.width, format.length]) });
    expect(Array.from(await withEncoder.exportImage({ format: 'image/webp' }))).toEqual([8, 10]);
    const psd = c.exportPsd();
    const back = importPsd(psd.bytes);
    expect(back.width).toBe(40);
    expect(back.layers.map((l) => l.name)).toEqual(['Paper', 'Layer 1']);
    c.updateLayer(c.document.activeLayerId!, { blend: 'pigment' });
    expect(c.exportPsd().warnings.join(' ')).toMatch(/Pigment blending has no PSD equivalent/);
  });

  it('writes painterly blend modes to PSD as their nearest standard mode, in groups too, with a warning', () => {
    const c = new PaintEditorController({ width: 24, height: 16, paper: 'smooth' });
    const base = c.document.activeLayerId!;
    c.fillLayer({ color: '#f2c84b' });
    const wash = c.addLayer({ name: 'Wash' });
    c.fillLayer({ layerId: wash.id, color: '#2a4b8d' });
    c.updateLayer(wash.id, { blend: 'watercolor', opacity: 0.7 });
    const group = c.addLayer({ name: 'Light', type: 'group' });
    const glow = c.addLayer({ name: 'Glow', parentId: group.id });
    c.fillLayer({ layerId: glow.id, color: '#ffd080' });
    c.updateLayer(glow.id, { blend: 'highlight', opacity: 0.3 });
    const merged = c.compositePixels({ paper: true }).data;
    const psd = c.exportPsd();
    const back = importPsd(psd.bytes);
    const flat = (ls: readonly any[]): any[] => ls.flatMap((l) => [l, ...(l.children ? flat(l.children) : [])]);
    const byName = new Map(flat(back.layers).map((l) => [l.name, l]));
    expect(byName.get('Wash')!.blend).toBe('multiply');
    expect(byName.get('Glow')!.blend).toBe('screen');
    expect(byName.get('Layer 1')!.blend).toBe('normal');
    const text = psd.warnings.join(' ');
    expect(text).toMatch(/Watercolor blending has no PSD equivalent; "Wash" was written as Multiply/);
    expect(text).toMatch(/Highlight blending has no PSD equivalent; "Glow" was written as Screen/);
    // The document itself is untouched, and the composite (the PSD's merged image) is the real one.
    expect(c.getLayer(wash.id)!.blend).toBe('watercolor');
    expect(Array.from(c.compositePixels({ paper: true }).data)).toEqual(Array.from(merged));
    expect(c.getLayer(base)!.blend).toBe('normal');
  });

  it('renders previews within maxSide and picks colours', () => {
    const c = new PaintEditorController({ width: 400, height: 200, paper: 'smooth' });
    c.fillLayer({ color: '#00ff00', opacity: 1 });
    const p = c.renderPreview({ maxSide: 100 });
    expect([p.width, p.height]).toEqual([100, 50]);
    expect(c.pickColor(10, 10)).toEqual({ color: '#00ff00', alpha: 1 });
    expect(c.pickColor(10, 10, { layerId: c.document.activeLayerId! })).toEqual({ color: '#00ff00', alpha: 1 });
    expect(() => c.pickColor(500, 10)).toThrow(/outside the 400×200 canvas/);
  });

  it('picks and composites without the paper when paper is false', () => {
    const c = new PaintEditorController({ width: 512, height: 256, paper: 'smooth' });
    expect(c.pickColor(10, 10).alpha).toBe(1);
    expect(c.pickColor(10, 10, { paper: false })).toEqual({ color: '#000000', alpha: 0 });

    const withPaper: Uint8ClampedArray[] = [];
    c.compositeTiles({ x: 0, y: 0, width: 512, height: 256 }, (_tx, _ty, data) => withPaper.push(data));
    expect(withPaper.length).toBe(2);
    expect(withPaper[0][3]).toBe(255);

    const bare: Uint8ClampedArray[] = [];
    c.compositeTiles({ x: 0, y: 0, width: 512, height: 256 }, (_tx, _ty, data) => bare.push(data), { paper: false, dirty: 'all' });
    expect(bare.length).toBe(2);
    expect(bare.every((d) => d.every((v, i) => i % 4 !== 3 || v === 0))).toBe(true);

    c.fillLayer({ color: '#00ff00', opacity: 1 });
    expect(c.pickColor(10, 10, { paper: false })).toEqual({ color: '#00ff00', alpha: 1 });
    const painted: Uint8ClampedArray[] = [];
    c.compositeTiles({ x: 0, y: 0, width: 512, height: 256 }, (_tx, _ty, data) => painted.push(data), { paper: false, dirty: 'all' });
    expect(Array.from(painted[0].slice(0, 4))).toEqual([0, 255, 0, 255]);
  });

  it('brush library: set, save, import, export, thumbnails', () => {
    const c = new PaintEditorController({ width: 16, height: 16 });
    const b = c.setBrush({ id: 'soft-pastel', tip: { size: 50 } });
    expect(b.tip.size).toBe(50);
    expect(b.builtin).toBeUndefined();
    expect(c.setBrush({ id: 'airbrush' }).builtin).toBe(true);
    c.setBrush({ id: 'soft-pastel', grain: 0.2 });
    const saved = c.saveBrush({ id: 'my-pastel', name: 'My pastel' });
    expect(saved.grain).toBe(0.2);
    expect(() => c.saveBrush({ id: 'airbrush' })).toThrow(/built-in/);
    expect(() => c.saveBrush({ id: 'Bad Id' })).toThrow(/invalid/);
    const file = c.exportBrushes();
    expect(file.brushes.map((x) => x.id)).toEqual(['my-pastel']);
    const d = new PaintEditorController();
    expect(d.importBrushes(JSON.parse(JSON.stringify(file)))).toEqual({ added: ['my-pastel'], skipped: [], problems: [] });
    expect(d.importBrushes(file).skipped).toEqual(['my-pastel']);
    expect(d.importBrushes({ brushes: [{ id: 'airbrush', name: 'x' }, { name: 'no id' }] }).problems).toHaveLength(2);
    expect(() => d.importBrushes('nonsense')).toThrow(/Not a brush library/);
    d.removeBrush('my-pastel');
    expect(() => d.removeBrush('pencil-hb')).toThrow(/cannot be removed/);
    // Every built-in brush's thumbnail is checked in paint-blending.test.ts; here, the controller's.
    const thumb = c.brushThumbnail('my-pastel', { color: '#202020' });
    expect([thumb.width, thumb.height, thumb.data.length]).toEqual([160, 48, 160 * 48 * 4]);
    const key = (t: { data: Uint8ClampedArray }) => Buffer.from(t.data).toString('base64');
    expect(key(thumb)).toBe(key(renderBrushThumbnail(saved, { paper: c.document.paper, color: '#202020' })));
    expect(key(c.brushThumbnail('airbrush', { color: '#202020' }))).not.toBe(key(thumb));
  });

  it('view and hand are editor state, not undo steps', () => {
    const c = new PaintEditorController({ width: 16, height: 16 });
    c.setView({ rotation: 370, mirror: true, zoom: 999 });
    expect(c.getState().view).toMatchObject({ rotation: 10, mirror: true, zoom: 64 });
    c.setHand('left');
    expect(c.getState().hand).toBe('left');
    expect(c.getState().canUndo).toBe(false);
    expect(() => c.setHand('both' as never)).toThrow(/use "left" or "right"/);
  });
});

describe('paint editor agent tools', () => {
  const setup = () => {
    const c = new PaintEditorController({ width: 128, height: 96, paper: 'cold-pressed' });
    const r = new ToolRegistry();
    r.register(createPaintEditorToolProvider(c));
    return { c, r };
  };
  const ok = (res: { isError?: boolean; structuredContent?: unknown; content: unknown[] }) => {
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    return res.structuredContent as any;
  };

  it('describes the canvas, papers and brushes', async () => {
    const { r } = setup();
    const info = ok(await r.callTool('get_canvas_info', {}));
    expect(info).toMatchObject({ width: 128, height: 96, dpi: 300, brushId: 'pencil-6b' });
    expect(info.blendModes).toContain('pigment');
    expect(info.blendModes).toEqual(expect.arrayContaining(['watercolor', 'tint', 'highlight', 'shadow']));
    const modes = ok(await r.callTool('list_blend_modes', {}));
    const wc = modes.modes.find((m: { id: string }) => m.id === 'watercolor');
    expect(wc).toMatchObject({ label: 'Watercolor', group: 'painterly', psd: 'multiply' });
    expect(wc.description).toMatch(/wash/);
    expect(modes.modes.find((m: { id: string }) => m.id === 'multiply')).toEqual({ id: 'multiply', label: 'Multiply', group: 'standard', psd: 'multiply' });
    expect(modes.modes.find((m: { id: string }) => m.id === 'pigment')).toMatchObject({ group: 'pigment', psd: 'normal' });
    const layerId = info.activeLayerId;
    const set = ok(await r.callTool('update_layer', { layerId, blend: 'shadow' }));
    expect(set.blend).toBe('shadow');
    expect((await r.callTool('update_layer', { layerId, blend: 'watercolour' })).isError).toBe(true);
    const papers = ok(await r.callTool('list_papers', {}));
    expect(papers.papers.map((p: { id: string }) => p.id)).toContain('sanded-pastel');
    const brushes = ok(await r.callTool('list_brushes', {}));
    expect(brushes.brushes.map((b: { category: string }) => b.category)).toEqual(expect.arrayContaining(['pencil', 'pastel', 'charcoal', 'airbrush', 'marker', 'ink', 'eraser', 'blender', 'smudge', 'mixer']));
    const brush = ok(await r.callTool('get_brush', { id: 'airbrush' }));
    expect(brush.tip.hardness).toBe(0);
    const bad = await r.callTool('get_brush', { id: 'nope' });
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toMatch(/Unknown brush "nope"/);
  });

  it('paints, replays and undoes through tools; each write returns what changed', async () => {
    const { c, r } = setup();
    const stroke = ok(await r.callTool('paint_stroke', { points: line(10, 10, 100, 80, 20, { pressure: 0.8 }), brushId: 'soft-pastel', color: '#aa3300' }));
    expect(stroke).toMatchObject({ strokeId: 's1', layerId: c.document.activeLayerId });
    expect(stroke.bounds.width).toBeGreaterThan(50);
    const listed = ok(await r.callTool('list_strokes', {}));
    expect(listed.strokes[0]).toMatchObject({ id: 's1', brushId: 'soft-pastel', color: '#aa3300', points: 21 });
    const withPoints = ok(await r.callTool('list_strokes', { ids: ['s1'] }));
    expect(withPoints.strokes[0].points).toHaveLength(21);
    const replay = ok(await r.callTool('replay_strokes', { strokeIds: ['s1'], dx: 10, repeat: 2 }));
    expect(replay.strokeIds).toEqual(['s2', 's3']);
    const undone = ok(await r.callTool('undo_paint', {}));
    expect(undone.undone).toBe('Replay strokes');
    expect(ok(await r.callTool('redo_paint', {})).redone).toBe('Replay strokes');
    const invalid = await r.callTool('paint_stroke', { points: [{ x: 1 }] });
    expect(invalid.isError).toBe(true);
    const extra = await r.callTool('paint_stroke', { points: [{ x: 1, y: 1 }], size: 4 });
    expect(extra.isError).toBe(true);
  });

  it('sets the brush and paper, fills, manages layers and the Mixer Brush', async () => {
    const { c, r } = setup();
    const b = ok(await r.callTool('set_brush', { id: 'charcoal-stick', tip: { size: 40 }, rotation: 'fixed' }));
    expect(b).toMatchObject({ id: 'charcoal-stick', rotation: 'fixed' });
    expect(b.tip.size).toBe(40);
    const saved = ok(await r.callTool('save_brush', { id: 'broad-charcoal', name: 'Broad charcoal' }));
    expect(saved.id).toBe('broad-charcoal');
    const lib = ok(await r.callTool('export_brushes', {}));
    expect(ok(await r.callTool('remove_brush', { id: 'broad-charcoal' }))).toEqual({ removed: 'broad-charcoal' });
    expect(ok(await r.callTool('import_brushes', { library: lib })).added).toEqual(['broad-charcoal']);
    const paper = ok(await r.callTool('set_paper', { preset: 'sanded-pastel', depth: 0.9 }));
    expect(paper).toMatchObject({ preset: 'sanded-pastel', depth: 0.9 });
    expect(ok(await r.callTool('get_paper', {})).pattern).toBe('sanded');
    const layer = ok(await r.callTool('add_layer', { name: 'Ground' }));
    const fill = ok(await r.callTool('fill_layer', { layerId: layer.id, color: '#c08040', grain: 1, pressure: 0.3 }));
    expect(fill).toEqual({ layerId: layer.id, bounds: { x: 0, y: 0, width: 128, height: 96 } });
    expect(ok(await r.callTool('update_layer', { layerId: layer.id, opacity: 0.5, blend: 'multiply' }))).toMatchObject({ opacity: 0.5, blend: 'multiply' });
    expect(ok(await r.callTool('list_layers', {})).layers).toHaveLength(2);
    const moved = ok(await r.callTool('move_layer', { layerId: layer.id, index: 0 }));
    expect(moved.id).toBe(layer.id);
    expect(ok(await r.callTool('duplicate_layer', { layerId: layer.id })).name).toBe('Ground copy');
    expect(ok(await r.callTool('set_active_layer', { layerId: layer.id })).active).toBe(true);
    expect(ok(await r.callTool('clear_layer', { layerId: layer.id })).bounds).not.toBeNull();
    const removed = ok(await r.callTool('remove_layer', { layerId: layer.id }));
    expect(removed.removed).toBe(layer.id);
    const merge = await r.callTool('merge_layer_down', { layerId: c.listLayers().at(-1)!.id });
    expect(merge.isError).toBe(true);
    expect(ok(await r.callTool('load_mixer_brush', { color: '#ff0000' }))).toEqual({ reservoir: '#ff0000', amount: 1, pickup: null });
    expect(ok(await r.callTool('get_mixer_brush', {})).reservoir).toBe('#ff0000');
    expect(ok(await r.callTool('clean_mixer_brush', { emptyReservoir: true })).reservoir).toBeNull();
    expect(ok(await r.callTool('set_color', { color: '#112233' }))).toEqual({ color: '#112233', secondaryColor: '#ffffff' });
    expect(ok(await r.callTool('pick_color', { x: 1, y: 1 })).alpha).toBe(1);
    expect(ok(await r.callTool('mix_colors', { colors: [{ color: '#0000ff', weight: 1 }, { color: '#ffff00', weight: 1 }] })).model).toBe('kubelka-munk');
  });

  it('renders previews, thumbnails and exports; saves and opens documents', async () => {
    const { c, r } = setup();
    await r.callTool('paint_stroke', { points: line(5, 5, 120, 90), brushId: 'marker' });
    const prev = await r.callTool('render_preview', { maxSide: 64 });
    expect(prev.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect((prev.content[1] as { text: string }).text).toBe('Preview 64×48');
    expect((await r.callTool('render_preview', { layerIds: ['zz'] })).isError).toBe(true);
    const thumb = await r.callTool('render_brush_thumbnail', { id: 'pencil-hb' });
    expect(thumb.content[0]).toMatchObject({ type: 'image' });
    const png = ok(await r.callTool('export_image', {}));
    expect(png.mimeType).toBe('image/png');
    const jpeg = await r.callTool('export_image', { format: 'image/jpeg' });
    expect(jpeg.isError).toBe(true);
    const psd = ok(await r.callTool('export_psd', {}));
    expect(psd.psb).toBe(false);
    // The deprecated save_document / open_document aliases are gone: the shared document tools replace them.
    expect(r.hasTool('save_document')).toBe(false);
    expect(r.hasTool('open_document')).toBe(false);
    expect((await r.callTool('save_document', {})).isError).toBe(true);
    r.register(createDocumentToolProvider(createPaintEditorDocument(c), { namespace: '', history: false }));
    const saved = ok(await r.callTool('get_paint_document', {}));
    expect(saved).toMatchObject({ kind: 'paint' });
    await r.callTool('new_canvas', { width: 10, height: 10, paper: 'gesso' });
    expect(ok(await r.callTool('get_canvas_info', {})).width).toBe(10);
    ok(await r.callTool('load_paint_document', { document: saved.document }));
    expect(ok(await r.callTool('get_canvas_info', {}))).toMatchObject({ width: 128, height: 96 });
    expect(ok(await r.callTool('set_view', { rotation: -90, mirror: true }))).toMatchObject({ rotation: -90, mirror: true });
    expect(ok(await r.callTool('set_hand', { hand: 'left' }))).toEqual({ hand: 'left' });
    expect(ok(await r.callTool('set_canvas', { width: 200 }))).toMatchObject({ width: 200, height: 96 });
  });
});

describe('paint-editor module isolation', () => {
  it('imports no framework or DOM module and no browser globals outside encode.ts', () => {
    const dir = join(__dirname, '../src/paint-editor');
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const m of src.matchAll(/from '([^']+)'/g)) expect(m[1], f).toMatch(/^\.\.?\//);
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (f !== 'encode.ts') expect(/(?<![\w.])(window\.|document\.(createElement|body|querySelector)|HTMLCanvasElement|new OffscreenCanvas|ImageData\()/.test(code), f).toBe(false);
    }
  });
});
