/**
 * The mixing pad: a small canvas beside the painting to put paint on, smear it with a palette
 * knife and pick the mixed colour from. Paint is laid with the Mixer Brush in pigment mode and the
 * knife smears it with pigment mixing, so blue and yellow pushed together make green. It is
 * scratch space: not part of the painting's undo history, but saved with the document, and pads
 * can be kept by name (`MixingPad.toPng` / `fromPng`).
 *
 * `mix` puts measured blobs of paint down (areas in proportion to their parts) and works them
 * together with the knife, the way a painter mixes a pile on the palette.
 */

import { EMPTY_MIXER_LOAD } from '../paint/mixer';
import { mixPigments } from '../paint/pigment';
import { base64ToBytes, decodePng, isPng, parseDataUrl, pngDataUrl } from '../raster/png';
import { emptySurface, readRegion, surfaceFromPixels, writeRegion, type TiledSurface } from '../raster/surface';
import { normalizePaintBrush, type PaintBrush } from './brushes';
import { IDENTITY_COPY, type PenPoint } from './engine';
import { hexToRgb8 } from './paper';
import { brushLoadForStroke, PaintStrokeSession } from './stroke';

export type MixingPadTool = 'paint' | 'knife';

export const MIXING_PAD_WIDTH = 360;
export const MIXING_PAD_HEIGHT = 220;

const PAD_PAINT: PaintBrush = normalizePaintBrush({
  id: 'pad-paint',
  name: 'Pad paint',
  category: 'mixer',
  engine: 'mixer',
  tip: { size: 28, hardness: 0.75, spacing: 0.1, opacity: 1, flow: 0.7, pressureSize: false, pressureOpacity: false },
  mixer: { wet: 0.45, load: 1, mix: 0.4, loadEachStroke: true, cleanEachStroke: true, mixing: 'pigment' },
});

const PAD_KNIFE: PaintBrush = normalizePaintBrush({
  id: 'pad-knife',
  name: 'Palette knife',
  category: 'smudge',
  engine: 'mixer',
  loadsColor: false,
  tip: { size: 34, hardness: 0.9, spacing: 0.08, roundness: 0.35, angle: 90, opacity: 1, flow: 0.85, pressureSize: false, pressureOpacity: false },
  mixer: { wet: 1, load: 0, mix: 1, loadEachStroke: false, cleanEachStroke: true, mixing: 'pigment' },
});

/** A solid round blob of paint (one dab). */
const PAD_BLOB: PaintBrush = normalizePaintBrush({
  id: 'pad-blob',
  name: 'Pad blob',
  category: 'custom',
  engine: 'dab',
  tip: { size: 20, hardness: 1, spacing: 0.1, opacity: 1, flow: 1, pressureSize: false, pressureOpacity: false },
});

/** One paint in a `mix`: a colour and its parts. */
export interface PadMixPart {
  color: string;
  parts: number;
}

export interface PadMixOptions {
  /** Centre of the pile in pad pixels (default the pad's centre). */
  x?: number;
  y?: number;
  /** Radius of the pile in pad pixels, 12..100 (default 40). */
  radius?: number;
  /** Knife passes over the pile, 1..20 (default 3): more passes, finer streaks around the mixed core. */
  passes?: number;
  /** Wipe the pile's area first (default true); false mixes into what is already there. */
  clear?: boolean;
}

export class MixingPad {
  readonly width = MIXING_PAD_WIDTH;
  readonly height = MIXING_PAD_HEIGHT;
  private surface: TiledSurface = emptySurface(4);
  /** Increments on every change (for redrawing). */
  version = 0;

  /** Paints (`paint`, with `color`) or smears (`knife`) through `points` in pad pixels. */
  stroke(points: readonly PenPoint[], options: { tool: MixingPadTool; color: string; size?: number }): { bounds: { x: number; y: number; width: number; height: number } | null } {
    if (!points.length) throw new Error('points is empty; give at least one {x, y} in pad pixels.');
    for (const [i, p] of points.entries()) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > this.width || p.y > this.height) {
        throw new Error(`points[${i}] (${p.x}, ${p.y}) is off the ${this.width}×${this.height} mixing pad.`);
      }
    }
    let brush = options.tool === 'knife' ? PAD_KNIFE : PAD_PAINT;
    if (options.size !== undefined) brush = normalizePaintBrush({ tip: { ...brush.tip, size: options.size } }, brush);
    return this.run(brush, points, options.color);
  }

  /** Paints `points` with `brush` in `color` on the pad. */
  private run(brush: PaintBrush, points: readonly PenPoint[], color: string): { bounds: { x: number; y: number; width: number; height: number } | null } {
    const [r, g, b] = hexToRgb8(color);
    let result: TiledSurface | null = null;
    const session = new PaintStrokeSession(
      { update: () => {}, commit: (_s, s) => (result = s) },
      {
        layerId: 'mixing-pad',
        surface: this.surface,
        offset: { x: 0, y: 0 },
        lockTransparency: false,
        brush,
        color: [r, g, b, 255],
        background: [255, 255, 255, 255],
        grain: null,
        paperDepth: 0,
        seed: 1,
        colorHex: color,
        affineCopies: [],
        copies: [IDENTITY_COPY],
        mixerLoad: brushLoadForStroke(brush, EMPTY_MIXER_LOAD, [r / 255, g / 255, b / 255]),
      }
    );
    session.push(points);
    const res = session.end();
    if (result) {
      this.surface = result;
      this.version++;
    }
    return { bounds: res.bounds };
  }

  /** The average colour within `radius` pixels of (x, y), or `null` where the pad is bare. */
  pick(x: number, y: number, radius = 3): string | null {
    if (!(x >= 0 && y >= 0 && x < this.width && y < this.height)) throw new Error(`(${x}, ${y}) is off the ${this.width}×${this.height} mixing pad.`);
    const r = Math.max(0, Math.round(radius));
    const x0 = Math.max(0, Math.floor(x) - r);
    const y0 = Math.max(0, Math.floor(y) - r);
    const x1 = Math.min(this.width, Math.floor(x) + r + 1);
    const y1 = Math.min(this.height, Math.floor(y) + r + 1);
    const px = readRegion(this.surface, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    let R = 0;
    let G = 0;
    let B = 0;
    let A = 0;
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3];
      R += px[i] * a;
      G += px[i + 1] * a;
      B += px[i + 2] * a;
      A += a;
    }
    if (A === 0) return null;
    const hex = (v: number) => Math.round(v / A).toString(16).padStart(2, '0');
    return `#${hex(R)}${hex(G)}${hex(B)}`;
  }

  clear(): void {
    this.surface = emptySurface(4);
    this.version++;
  }

  /**
   * Mixes paints the way a painter does on a palette: blobs whose areas are in proportion to
   * their parts, side by side around (x, y), knife passes across the pile in alternating
   * directions and a stir, and then the centre worked until it is fully mixed: a soft-edged core
   * of the Kubelka-Munk mix of the parts (`mixPigments`), with partly mixed streaks around it.
   * Returns that colour (picked back from the centre) and the pile's bounds.
   *
   * The core is laid, not smeared, because smearing alone drifts: the knife samples in RGB and a
   * mixed colour's scattering is re-estimated from its luminance, so repeated small mixes favour
   * the lighter paint (see GOTCHAS).
   */
  mix(paints: readonly PadMixPart[], options: PadMixOptions = {}): { color: string | null; bounds: { x: number; y: number; width: number; height: number } } {
    if (!paints.length || paints.length > 8) throw new Error(`Give 1 to 8 paints to mix; got ${paints.length}.`);
    const total = paints.reduce((n, p) => n + p.parts, 0);
    paints.forEach((p, i) => {
      if (!(Number.isFinite(p.parts) && p.parts >= 0)) throw new Error(`paints[${i}].parts is ${p.parts}; use a number ≥ 0.`);
    });
    if (!(total > 0)) throw new Error('Every paint has 0 parts; give at least one paint parts above 0.');
    const R = options.radius ?? 40;
    if (!(R >= 12 && R <= 100)) throw new Error(`radius ${R} is out of range; use 12..100 pad px.`);
    const passes = options.passes ?? 3;
    if (!(Number.isInteger(passes) && passes >= 1 && passes <= 20)) throw new Error(`passes ${passes} is out of range; use a whole number 1..20.`);
    const cx = options.x ?? this.width / 2;
    const cy = options.y ?? this.height / 2;
    if (!(cx - R >= 0 && cy - R >= 0 && cx + R <= this.width && cy + R <= this.height)) {
      throw new Error(`A pile of radius ${R} at (${cx}, ${cy}) does not fit on the ${this.width}×${this.height} pad; move it at least ${R} px from every edge or use a smaller radius.`);
    }
    const bounds = { x: Math.floor(cx - R), y: Math.floor(cy - R), width: Math.ceil(2 * R), height: Math.ceil(2 * R) };
    if (options.clear !== false) this.surface = writeRegion(this.surface, bounds, new Uint8ClampedArray(bounds.width * bounds.height * 4));
    // Blobs: equal-area share of a disc of radius 0.7·R per part, placed around the centre.
    const used = paints.filter((p) => p.parts > 0);
    const area = Math.PI * (0.7 * R) ** 2;
    used.forEach((p, i) => {
      const r = Math.sqrt((area * (p.parts / total)) / Math.PI);
      const a = (i / used.length) * Math.PI * 2;
      const off = used.length === 1 ? 0 : 0.45 * R;
      const x = Math.min(cx + R - r, Math.max(cx - R + r, cx + Math.cos(a) * off));
      const y = Math.min(cy + R - r, Math.max(cy - R + r, cy + Math.sin(a) * off));
      const blob = normalizePaintBrush({ tip: { ...PAD_BLOB.tip, size: Math.max(2, 2 * r) } }, PAD_BLOB);
      this.run(blob, [{ x, y }], p.color.toLowerCase());
    });
    // Knife passes: zig-zags across the pile, alternating horizontal and vertical, then a stir.
    const knife = normalizePaintBrush({ tip: { ...PAD_KNIFE.tip, size: Math.max(12, R * 0.6) } }, PAD_KNIFE);
    const step = Math.max(4, R * 0.25);
    for (let k = 0; k < passes; k++) {
      const pts: PenPoint[] = [];
      for (let o = -R * 0.8, row = 0; o <= R * 0.8 + 1e-9; o += step, row++) {
        const a = row % 2 ? R * 0.8 : -R * 0.8;
        const b = -a;
        if (k % 2 === 0) pts.push({ x: cx + a, y: cy + o }, { x: cx + b, y: cy + o });
        else pts.push({ x: cx + o, y: cy + a }, { x: cx + o, y: cy + b });
      }
      this.run(knife, pts, '#000000');
      const stir: PenPoint[] = [];
      for (let t = 0; t <= 24; t++) {
        const a = (t / 24) * Math.PI * 2 + k;
        const rr = R * (0.15 + 0.5 * (t / 24));
        stir.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
      }
      this.run(knife, stir, '#000000');
    }
    const mixed = mixPigments(
      paints.map((p) => hexToRgb8(p.color).map((v) => v / 255) as [number, number, number]),
      paints.map((p) => p.parts)
    );
    const core = normalizePaintBrush({ tip: { ...PAD_BLOB.tip, size: R * 1.1, hardness: 0.55 } }, PAD_BLOB);
    const hex = '#' + mixed.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    this.run(core, [{ x: cx, y: cy }], hex);
    return { color: this.pick(cx, cy, 2), bounds };
  }

  /** The pad's pixels as a PNG data URL (with alpha), for saving. */
  toPng(): string {
    return pngDataUrl(this.width, this.height, readRegion(this.surface, { x: 0, y: 0, width: this.width, height: this.height }));
  }

  /** Replaces the pad with a PNG (data URL or base64) of the pad's size, as `toPng` writes. */
  fromPng(png: string): void {
    const bytes = png.startsWith('data:') ? parseDataUrl(png)?.bytes : base64ToBytes(png);
    if (!bytes || !isPng(bytes)) throw new Error('The pad image is not a PNG data URL or base64 PNG.');
    const img = decodePng(bytes);
    if (img.width !== this.width || img.height !== this.height) throw new Error(`The pad image is ${img.width}×${img.height}; a mixing pad is ${this.width}×${this.height}.`);
    this.surface = surfaceFromPixels({ width: img.width, height: img.height, data: img.data }, 4);
    this.version++;
  }

  /** Whether nothing is on the pad. */
  get empty(): boolean {
    return this.surface.tiles.size === 0;
  }

  /** The pad over white, `width × height` RGBA. */
  pixels(): Uint8ClampedArray {
    const px = readRegion(this.surface, { x: 0, y: 0, width: this.width, height: this.height });
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3] / 255;
      px[i] = Math.round(px[i] * a + 255 * (1 - a));
      px[i + 1] = Math.round(px[i + 1] * a + 255 * (1 - a));
      px[i + 2] = Math.round(px[i + 2] * a + 255 * (1 - a));
      px[i + 3] = 255;
    }
    return px;
  }
}
