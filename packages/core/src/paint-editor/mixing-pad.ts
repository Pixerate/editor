/**
 * The mixing pad: a small canvas beside the painting to put paint on, smear it with a palette
 * knife and pick the mixed colour from. Paint is laid with the Mixer Brush in pigment mode and the
 * knife is a pigment smudge, so blue and yellow pushed together make green. It is scratch space:
 * not part of the painting and not in its undo history.
 */

import { EMPTY_MIXER_LOAD } from '../paint/mixer';
import { emptySurface, readRegion, type TiledSurface } from '../raster/surface';
import { normalizePaintBrush, type PaintBrush } from './brushes';
import { IDENTITY_COPY, type PenPoint } from './engine';
import { hexToRgb8 } from './paper';
import { mixerLoadForStroke, PaintStrokeSession } from './stroke';

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
    const [r, g, b] = hexToRgb8(options.color);
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
        colorHex: options.color,
        affineCopies: [],
        copies: [IDENTITY_COPY],
        mixerLoad: mixerLoadForStroke(brush, EMPTY_MIXER_LOAD, [r / 255, g / 255, b / 255]),
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
