/**
 * The wet layer as a `PaintMedium`: the canvas side of the shared pick-up / mix exchange
 * (`PaintExchange`), so wet brushes pick up and mix paint the same way the Mixer Brush and the
 * phase 2 dab brushes do.
 *
 * - `sample` sees only wet paint (pigment still suspended in surface water): what a brush can
 *   lift. Its colour is the suspended pigment's hue at full strength; contact is how much of the
 *   footprint is wet with pigment in it.
 * - `deposit` lays water and pigment: the colour becomes Kubelka-Munk pigment (`pigmentOf` at the
 *   brush's body), at `mass` per unit of coverage, with `water` depth.
 */

import type { PaintMedium, PaintSample, RgbTriple } from '../exchange';
import type { Pigment } from '../pigment';
import type { RasterRect } from '../../raster/surface';
import { pigmentColor, pigmentOf } from './film';
import type { WetWorld } from './world';

export interface WetMediumOptions {
  /** Water depth laid per unit of coverage (at deposit weight 1). */
  water: number;
  /** Pigment mass laid per unit of coverage (at deposit weight 1). */
  mass: number;
  /** 0 transparent watercolour .. 1 opaque gouache. */
  body: number;
}

/** The strongest absorption (K) a sampled colour is scaled to: its hue at full strength. */
const SAMPLE_K = 3;

export class WetMedium implements PaintMedium {
  private readonly pig = new Float64Array(4);

  constructor(
    readonly world: WetWorld,
    readonly laneId: string,
    public options: WetMediumOptions
  ) {}

  sample(rect: RasterRect, cov: ArrayLike<number>): PaintSample | null {
    const s = this.world.sample(this.laneId, rect, cov);
    if (!(s.wet > 0) || !(s.weight > 0)) return null;
    const k = s.pigment;
    const kmax = Math.max(k[0], k[1], k[2]);
    if (!(kmax > 1e-9)) return null;
    const f = SAMPLE_K / kmax;
    const rgb = pigmentColor(k[0] * f, k[1] * f, k[2] * f, k[3] * f) as RgbTriple;
    // Mass per wet cell, against a moderate wash (0.02 of K per cell).
    const density = Math.min(1, (k[0] + k[1] + k[2]) / s.wet / 0.06);
    return { rgb, contact: (s.wet / s.weight) * density };
  }

  deposit(rect: RasterRect, cov: ArrayLike<number>, dep: number, paint: Readonly<RgbTriple>, _pigment: Pigment | null, field: Float32Array | null = null): void {
    const { water, mass, body } = this.options;
    if (field) {
      const n = rect.width * rect.height;
      const out = new Float32Array(n * 4);
      const one = this.pig;
      for (let p = 0; p < n; p++) {
        pigmentOf([field[p * 3], field[p * 3 + 1], field[p * 3 + 2]], body, one);
        for (let q = 0; q < 4; q++) out[p * 4 + q] = one[q] * mass * dep;
      }
      this.world.paint(this.laneId, rect, cov, water * dep, null, out);
      return;
    }
    pigmentOf(paint, body, this.pig);
    const pig = [0, 1, 2, 3].map((q) => this.pig[q] * mass * dep);
    this.world.paint(this.laneId, rect, cov, water * dep, mass > 0 ? pig : null);
  }
}
