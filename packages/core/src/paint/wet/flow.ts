/**
 * Flow maps: a push on the water at every cell (cells per step², like tilt), from a few generated
 * patterns. Every pattern is computed with + − × ÷ only, so it is the same in every engine.
 */

import type { WetFlowField } from './world';

export type WetFlowKind = 'none' | 'linear' | 'swirl' | 'radial' | 'turbulent';

export const WET_FLOW_KINDS: readonly WetFlowKind[] = ['none', 'linear', 'swirl', 'radial', 'turbulent'];

/** A flow map as settings (saved with the document). */
export interface WetFlowSpec {
  kind: WetFlowKind;
  /** 0..1: how hard it pushes (1 is about as strong as a 25° tilt). */
  strength: number;
  /** `linear`: direction in degrees clockwise from canvas down. */
  angle: number;
  /** `swirl` / `radial`: centre in document pixels (default the canvas centre). */
  center?: { x: number; y: number };
  /** `swirl`: true turns clockwise. */
  clockwise: boolean;
  /** `turbulent`: eddy size in pixels (8..1024). */
  scale: number;
  seed: number;
}

export const DEFAULT_FLOW: Readonly<WetFlowSpec> = { kind: 'none', strength: 0.5, angle: 0, clockwise: true, scale: 120, seed: 1 };

/** Acceleration of a flow map at strength 1, cells per step². */
const FLOW_ACCEL = 0.01;

/** sin and cos of an angle in radians, by range reduction and Taylor series (deterministic). */
export function dsincos(a: number): [number, number] {
  const twoPi = 6.283185307179586;
  let x = a - Math.round(a / twoPi) * twoPi;
  // reduce to [−π/4, π/4] by quadrant
  const q = Math.round(x / (twoPi / 4));
  x -= q * (twoPi / 4);
  const x2 = x * x;
  let s = x;
  let c = 1;
  let ts = x;
  let tc = 1;
  for (let i = 1; i < 12; i++) {
    ts *= -x2 / ((2 * i) * (2 * i + 1));
    tc *= -x2 / ((2 * i - 1) * (2 * i));
    s += ts;
    c += tc;
  }
  switch (((q % 4) + 4) % 4) {
    case 0:
      return [s, c];
    case 1:
      return [c, -s];
    case 2:
      return [-s, -c];
    default:
      return [-c, s];
  }
}

function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, seed);
  const b = hash(x0 + 1, y0, seed);
  const c = hash(x0, y0 + 1, seed);
  const d = hash(x0 + 1, y0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Settings with every field in range. */
export function normalizeFlow(raw: Partial<WetFlowSpec> = {}, base: WetFlowSpec = DEFAULT_FLOW): WetFlowSpec {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const kind = WET_FLOW_KINDS.includes(raw.kind as WetFlowKind) ? (raw.kind as WetFlowKind) : base.kind;
  const center = raw.center && Number.isFinite(raw.center.x) && Number.isFinite(raw.center.y) ? { x: raw.center.x, y: raw.center.y } : base.center;
  return {
    kind,
    strength: Math.min(1, Math.max(0, num(raw.strength, base.strength))),
    angle: ((num(raw.angle, base.angle) % 360) + 360) % 360,
    ...(center ? { center } : {}),
    clockwise: typeof raw.clockwise === 'boolean' ? raw.clockwise : base.clockwise,
    scale: Math.min(1024, Math.max(8, num(raw.scale, base.scale))),
    seed: Math.abs(Math.round(num(raw.seed, base.seed))) % 2147483647,
  };
}

/** The flow field of a spec on a canvas, or `null` for `none` (strength is applied by the world). */
export function flowField(spec: WetFlowSpec, width: number, height: number): WetFlowField | null {
  const k = FLOW_ACCEL;
  const cx = spec.center?.x ?? width / 2;
  const cy = spec.center?.y ?? height / 2;
  const r0 = Math.max(width, height) / 2;
  switch (spec.kind) {
    case 'none':
      return null;
    case 'linear': {
      const [s, c] = dsincos((spec.angle * Math.PI) / 180);
      const v = [-s * k, c * k] as const;
      return () => v;
    }
    case 'swirl': {
      const sign = spec.clockwise ? 1 : -1;
      return (x, y) => [(-(y - cy) / r0) * k * sign, ((x - cx) / r0) * k * sign];
    }
    case 'radial':
      return (x, y) => [((x - cx) / r0) * k, ((y - cy) / r0) * k];
    case 'turbulent': {
      // The curl of value noise: divergence-free eddies.
      const sc = spec.scale;
      const e = 0.5;
      return (x, y) => {
        const u = x / sc;
        const v = y / sc;
        const dndy = (valueNoise(u, v + e / sc, spec.seed) - valueNoise(u, v - e / sc, spec.seed)) * sc;
        const dndx = (valueNoise(u + e / sc, v, spec.seed) - valueNoise(u - e / sc, v, spec.seed)) * sc;
        return [dndy * k * 0.5, -dndx * k * 0.5];
      };
    }
  }
}
