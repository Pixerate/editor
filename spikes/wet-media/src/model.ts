/**
 * Watercolour model shared by the three implementations (TypeScript, wasm SIMD, WebGPU).
 *
 * Written from the published literature only:
 *  - Chu & Tai, "MoXi: Real-Time Ink Dispersion in Absorbent Paper", SIGGRAPH 2005:
 *    D2Q9 lattice Boltzmann water on paper, partial bounce-back streaming with a per-cell
 *    blocking factor from the paper fibres, pinning of the wet front, evaporation strongest
 *    at the boundary, and a separate pigment layer that is advected, deposited and lifted.
 *  - Standard LBM (BGK collision, Qian-d'Humières-Lallemand D2Q9 equilibrium, velocity-shift
 *    forcing for gravity / tilt), as in any LBM textbook (e.g. Succi 2001, Krüger et al. 2017).
 *  - Curtis et al., "Computer-Generated Watercolor", SIGGRAPH 1997: the pigment
 *    deposition / lifting (adsorption / desorption) and granulation ideas, and darkening at
 *    edges from faster evaporation where the wet area meets dry paper.
 *
 * Pigment advection uses a first-order upwind finite-volume scheme instead of
 * semi-Lagrangian back-tracing. It conserves pigment exactly, has no gathers (so it is
 * SIMD-friendly), and with |u| <= U_MAX = 0.25 it is stable and keeps pigment non-negative.
 *
 * Every implementation must follow `stepCell` in ts-sim.ts exactly. That file is the reference.
 */

export const TILE = 256;

/** D2Q9 lattice velocities. 0 = rest, 1-4 axis (E, S, W, N in screen space), 5-8 diagonals. */
export const EX = [0, 1, 0, -1, 0, 1, -1, -1, 1] as const;
export const EY = [0, 0, 1, 0, -1, 1, 1, -1, -1] as const;
export const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6] as const;
export const W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36] as const;

/** Water below this depth counts as dry. */
export const DRY_EPS = 1e-3;
/** Fluid speed cap, in cells per step. Keeps the LBM low-Mach and the pigment upwind scheme CFL-stable. */
export const U_MAX = 0.25;

export interface WetParams {
  /** Kinematic viscosity in lattice units; tau = 3*nu + 0.5. 0.02 (runny) to 0.3 (thick). */
  viscosity: number;
  /** Water removed per step from every wet cell, in depth units. */
  evaporation: number;
  /** Extra evaporation factor at the wet edge, times the fraction of dry neighbours. */
  edgeEvaporation: number;
  /** How heavy the pigment is, 0-1. Heavy pigment moves less and settles sooner. */
  pigmentWeight: number;
  /** Fraction of deposited pigment lifted back into wet water per step. */
  pickupRate: number;
  /** Fraction of suspended pigment that settles into the paper per step. */
  fixtureRate: number;
  /** Fraction of surface water the paper soaks up per step, before it is full. */
  paperAbsorption: number;
  /** Water the paper can hold per cell, in depth units. */
  paperCapacity: number;
  /** 0-1. 1 = water flows freely; lower values let fibres (grain peaks) block streaming. */
  paperPermeability: number;
  /** 0-1. Grain influence on pinning of the wet front and on granulation. */
  paperRoughness: number;
  /** Water depth a dry cell's wet neighbour needs before the front advances into it. */
  pinThreshold: number;
  /** Tilt acceleration, in cells per step², x and y. */
  tiltX: number;
  tiltY: number;
  /** Multiplier on the optional flow map (vec2 per cell, same units as tilt). 0 = off. */
  flowStrength: number;
}

export const defaultParams: WetParams = {
  viscosity: 0.08,
  evaporation: 2e-4,
  edgeEvaporation: 4,
  pigmentWeight: 0.3,
  pickupRate: 0.002,
  fixtureRate: 0.004,
  paperAbsorption: 0.002,
  paperCapacity: 0.2,
  paperPermeability: 0.75,
  paperRoughness: 0.5,
  pinThreshold: 0.05,
  tiltX: 0,
  tiltY: 2e-5,
  flowStrength: 0,
};

/** Brush dab parameters. */
export interface Dab {
  x: number;
  y: number;
  radius: number;
  /** Water added at the dab centre, in depth units. */
  wetness: number;
  /** Pigment added per unit of water. */
  concentration: number;
}

/** Number of f32 values packed into the uniform / param block, in this order. */
export function packParams(p: WetParams): Float32Array {
  const tau = 3 * p.viscosity + 0.5;
  return new Float32Array([
    1 / tau, // 0 omega
    tau, // 1
    p.evaporation, // 2
    p.edgeEvaporation, // 3
    1 - 0.5 * p.pigmentWeight, // 4 pigment mobility
    p.fixtureRate * (0.5 + p.pigmentWeight), // 5 deposit rate
    p.pickupRate, // 6
    p.paperAbsorption, // 7
    1 / p.paperCapacity, // 8
    1 - p.paperPermeability, // 9 blocking scale
    p.paperRoughness, // 10
    p.pinThreshold, // 11
    p.tiltX, // 12
    p.tiltY, // 13
    p.flowStrength, // 14
    0, // 15 padding
  ]);
}

/** Integer hash -> [0, 1). Deterministic, so every implementation gets the same paper. */
function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, cell: number, seed: number): number {
  const gx = x / cell;
  const gy = y / cell;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Paper grain height map in [0, 1]: fibres (fine) over cockle (coarse). */
export function makePaper(width: number, height: number, seed = 7): Float32Array {
  const h = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v =
        0.5 * valueNoise(x, y, 2, seed) +
        0.3 * valueNoise(x, y, 6, seed + 1) +
        0.2 * valueNoise(x, y, 40, seed + 2);
      h[y * width + x] = v;
    }
  }
  return h;
}

/** A swirl flow map (vec2 per cell, interleaved), for testing the flow-map path. */
export function makeFlowMap(width: number, height: number): Float32Array {
  const f = new Float32Array(width * height * 2);
  const cx = width / 2;
  const cy = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / width;
      const dy = (y - cy) / height;
      f[(y * width + x) * 2] = -dy * 1e-4;
      f[(y * width + x) * 2 + 1] = dx * 1e-4;
    }
  }
  return f;
}

/** Dab falloff: 1 at the centre, 0 at the radius, smooth. Returns 0 outside. */
export function dabFalloff(dab: Dab, x: number, y: number): number {
  const dx = x + 0.5 - dab.x;
  const dy = y + 0.5 - dab.y;
  const q = (dx * dx + dy * dy) / (dab.radius * dab.radius);
  if (q >= 1) return 0;
  const a = 1 - q;
  return a * a;
}

/** Pigment absorption per channel (an ultramarine-like blue) for display. */
export const PIGMENT_K = [2.2, 1.4, 0.35] as const;

/**
 * Display transform shared by all implementations (applied on the CPU for CPU paths and in
 * WGSL for the GPU): paper tone from the grain, Beer-Lambert pigment, slight wet darkening.
 */
export function shade(h: number, rho: number, p: number, d: number, out: Uint8ClampedArray, o: number): void {
  const paper = 0.93 + 0.07 * h;
  const wet = 1 - 0.06 * Math.min(rho * 4, 1);
  const c = d + p;
  out[o] = 255 * paper * wet * Math.exp(-PIGMENT_K[0] * c) + 0.5;
  out[o + 1] = 255 * paper * wet * Math.exp(-PIGMENT_K[1] * c) + 0.5;
  out[o + 2] = 255 * paper * wet * Math.exp(-PIGMENT_K[2] * c) + 0.5;
  out[o + 3] = 255;
}

/** Dense snapshot of the observable state, for divergence checks and drying. */
export interface WetSnapshot {
  width: number;
  height: number;
  rho: Float32Array;
  p: Float32Array;
  d: Float32Array;
}

/** Common interface every implementation provides to the benchmark page. */
export interface WetSim {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Add water and pigment. Marks the dab's tiles (plus one ring) active. */
  dab(d: Dab): void;
  /** Uniform wash over a rectangle (benchmark setup). */
  wash(x0: number, y0: number, x1: number, y1: number, wetness: number, concentration: number): void;
  /** Advance n steps. Resolves when the work is complete (GPU: queue drained). */
  step(n: number): Promise<void>;
  /** Number of tiles currently dispatched per step. */
  activeTiles(): number;
  /** Render the given tile rect to the visible canvas; resolves when the pixels are committed. */
  present(tx0: number, ty0: number, tx1: number, ty1: number): Promise<void>;
  snapshot(): Promise<WetSnapshot>;
  /** Bytes held for simulation state (analytic), by category. */
  memory(): Record<string, number>;
  destroy(): void;
}

/** Bake a snapshot to RGBA8 the way "dry on save" would: all suspended pigment deposits, water goes. */
export function dryToRgba8(s: WetSnapshot, paper: Float32Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(s.width * s.height * 4);
  for (let i = 0; i < s.width * s.height; i++) {
    // Math.fround so the bake is the same function of the f32 state everywhere.
    shade(paper[i], 0, 0, Math.fround(s.d[i] + s.p[i]), out, i * 4);
  }
  return out;
}

export function wetToRgba8(s: WetSnapshot, paper: Float32Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(s.width * s.height * 4);
  for (let i = 0; i < s.width * s.height; i++) shade(paper[i], s.rho[i], s.p[i], s.d[i], out, i * 4);
  return out;
}
