/**
 * Tip grain: texture inside each dab (Procreate's grain source), separate from the paper's grain.
 * The texture is a built-in grain pattern or an image source (`source:<id>`, light parts are
 * peaks), tiled. `texturised` grain stays put on the canvas; `moving` grain is read in the tip's
 * own frame, offset by the distance travelled, so it rolls along the stroke and turns with the tip.
 *
 * A dab's coverage is multiplied by `1 − depth × (1 − height)`. Everything is a function of the
 * dab (position, angle, travel), so replays and repaints at another scale lay the same grain.
 */

import { GRAIN_PATTERNS, PaperGrain, type GrainPattern } from '../paint/grain';
import type { RasterRect } from '../raster/surface';
import type { TipGrainSettings } from './brush-model';
import type { StickerArtLookup } from './sticker-art';

/** What the grain needs of a dab. */
export interface TipGrainDab {
  x: number;
  y: number;
  /** Radians, counter-clockwise with y up. */
  angle: number;
  /** Path length travelled to the dab (px). */
  travel: number;
}

/** A tiled image texture: heights 0..1 with contrast and invert applied. */
class ImageGrain {
  private readonly heights: Float32Array;

  constructor(
    private readonly w: number,
    private readonly h: number,
    alpha: Uint8ClampedArray,
    contrast: number,
    invert: boolean,
    private readonly scale: number,
  ) {
    this.heights = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const v = Math.min(1, Math.max(0, (alpha[i * 4 + 3] / 255 - 0.5) * contrast + 0.5));
      this.heights[i] = invert ? 1 - v : v;
    }
  }

  at(x: number, y: number): number {
    const { w, h } = this;
    const u = x / this.scale - 0.5;
    const v = y / this.scale - 0.5;
    const x0 = Math.floor(u);
    const y0 = Math.floor(v);
    const fx = u - x0;
    const fy = v - y0;
    const xa = ((x0 % w) + w) % w;
    const ya = ((y0 % h) + h) % h;
    const xb = (xa + 1) % w;
    const yb = (ya + 1) % h;
    const hs = this.heights;
    return (hs[ya * w + xa] * (1 - fx) + hs[ya * w + xb] * fx) * (1 - fy) + (hs[yb * w + xa] * (1 - fx) + hs[yb * w + xb] * fx) * fy;
  }
}

/** A brush's tip grain, ready to apply to dabs. */
export class TipGrain {
  private constructor(
    private readonly field: { at(x: number, y: number): number },
    private readonly settings: TipGrainSettings,
  ) {}

  /**
   * The grain for `settings`, or `null` when there is none to apply: no depth, or an image source
   * whose art is not loaded (the dabs then paint without it).
   */
  static create(settings: TipGrainSettings | undefined, art?: StickerArtLookup): TipGrain | null {
    if (!settings || settings.depth <= 0) return null;
    if ((GRAIN_PATTERNS as readonly string[]).includes(settings.source)) {
      if (settings.source === 'smooth') return null;
      const tuning = { contrast: settings.contrast, invert: settings.invert };
      const paper = new PaperGrain({ pattern: settings.source as GrainPattern, seed: 0, scale: settings.scale, tiling: 'repeat', dry: tuning, wet: tuning });
      return new TipGrain(paper, settings);
    }
    const a = art?.(settings.source);
    if (!a || !(a.width > 0 && a.height > 0)) return null;
    return new TipGrain(new ImageGrain(a.width, a.height, a.data, settings.contrast, settings.invert, settings.scale), settings);
  }

  /** Multiplies the dab's coverage `vals` (over `rect`) by the grain. */
  apply(vals: Float32Array, rect: RasterRect, d: TipGrainDab): void {
    const depth = this.settings.depth;
    const moving = this.settings.mode === 'moving';
    const cs = Math.cos(d.angle);
    const sn = Math.sin(d.angle);
    for (let yy = 0, k = 0; yy < rect.height; yy++) {
      const py = rect.y + yy + 0.5;
      for (let xx = 0; xx < rect.width; xx++, k++) {
        if (!(vals[k] > 0)) continue;
        const px = rect.x + xx + 0.5;
        let gx = px;
        let gy = py;
        if (moving) {
          // Into the tip's frame (as the stamp rasterizer turns it), rolled along by the travel.
          const dx = px - d.x;
          const dy = py - d.y;
          gx = dx * cs - dy * sn + d.travel;
          gy = dx * sn + dy * cs;
        }
        vals[k] *= 1 - depth * (1 - this.field.at(gx, gy));
      }
    }
  }
}
