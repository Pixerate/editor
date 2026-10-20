/**
 * The wet-media model: water and pigment on paper, simulated per cell on 256 px tiles.
 *
 * Written from the published literature only (no code, presets or textures from any product):
 *
 * - **Water** is a D2Q9 lattice Boltzmann fluid with BGK collision, τ = 3ν + ½ (any LBM text, e.g.
 *   Krüger et al., *The Lattice Boltzmann Method*, 2017). Streaming uses partial bounce-back with a
 *   blocking factor from the paper fibres, and the wet front is *pinned* until the water behind it
 *   is deep enough: Chu & Tai, "MoXi: Real-Time Ink Dispersion in Absorbent Paper", SIGGRAPH 2005.
 *   Tilt and flow maps are a velocity-shift force, with |u| capped at `U_MAX` cells per step.
 * - **Paper** soaks water up until it holds its capacity, and damp paper stops pinning the front
 *   (wet-in-wet). Water evaporates faster in a band along the wet front (an "edge" field, 1 at the
 *   front and fading over a few cells inwards, as Curtis et al. blur the wet-area mask), so water
 *   flows out to the edge and carries pigment there: edge darkening.
 * - **Pigment** (Curtis et al., "Computer-Generated Watercolor", SIGGRAPH 1997) is suspended in the
 *   water, advected with a first-order upwind finite-volume flux (it conserves pigment and never
 *   goes negative while |u| ≤ ¼), spreads a little between wet cells (bleed), settles into the
 *   paper (more in grain valleys: granulation; more at the wet edge: edge darkening), is lifted
 *   back by water (more where water arrives: blooms), and settles completely where a cell dries.
 * - **Colour** is Kubelka-Munk: each cell carries pigment as absorption `K` per channel (linear
 *   R, G, B) plus one scattering `S`, so mixes are exactly linear (two-constant KM, `K = Σ cᵢKᵢ`,
 *   `S = Σ cᵢSᵢ`) and transparent washes multiply like glazes. A colour becomes `K` and `S` with the
 *   same two-flux formulas as the shipped pigment model (`K/S = (1 − R)² / 2R`).
 *
 * `stepCellsTs` in `kernel.ts` is the specification of one step, in exact f32 arithmetic. The
 * WebAssembly SIMD kernel (`assembly/wet.ts`) is a lane-for-lane port of it and gives the same bits,
 * so the simulation is deterministic across browsers, kernels and worker counts.
 */

/** Tile side in cells (the raster tile size). */
export const WET_TILE = 256;
/** A tile slot's side: the tile plus a one-cell halo on each side. */
export const SLOT_SIDE = 258;
/** Floats per plane of a slot. */
export const PLANE = SLOT_SIDE * SLOT_SIDE;
export const PLANE_BYTES = PLANE * 4;

/** Planes in each ping-ponged set: f0..f8, depth, velocity, paper water, 4 pigment channels, edge. */
export const SET_PLANES = 18;
export const P_RHO = 9;
export const P_UX = 10;
export const P_UY = 11;
/** Water held in the paper. */
export const P_SW = 12;
/** Suspended pigment: K red, K green, K blue, S. */
export const P_P0 = 13;
/** Edge: 1 at the wet front, fading over a few cells into the wet area (0 where dry). */
export const P_EDGE = 17;
/** Single (not ping-ponged) planes, after the two sets. */
export const P_D0 = 2 * SET_PLANES; // 36..39: deposited pigment K r, g, b, S
export const P_H = P_D0 + 4; // 40: paper height (−1 marks the off-canvas halo)
export const P_FX = P_H + 1; // 41: flow map x
export const P_FY = P_H + 2; // 42: flow map y
export const SLOT_PLANES = P_FY + 1; // 43
export const SLOT_BYTES = SLOT_PLANES * PLANE_BYTES;
/** Pigment channels per cell. */
export const PIGMENT_CHANNELS = 4;

/** D2Q9 lattice velocities: 0 rest, 1–4 axis (E, S, W, N in screen space), 5–8 diagonals. */
export const EX = [0, 1, 0, -1, 0, 1, -1, -1, 1] as const;
export const EY = [0, 0, 1, 0, -1, 1, 1, -1, -1] as const;
export const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6] as const;
export const W9 = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36] as const;

/** Water shallower than this counts as dry. */
export const DRY_EPS = 1e-3;
/** Fluid speed cap in cells per step: keeps the LBM low-Mach and the pigment flux CFL-stable. */
export const U_MAX = 0.25;
/** A tile's wet cells within this many cells of an edge wake the neighbouring tile. */
export const STRIP = 64;
/** Steps per batch at most: the wake-up strip stays ahead of anything that moves a cell a step. */
export const MAX_BATCH = 32;
/** Dry tiles are baked and freed only on steps that are multiples of this (so it is deterministic). */
export const FREE_INTERVAL = 32;

/** Per-tile flag bits a step returns. */
export const FLAG_ALIVE = 1; // some cell holds water (surface or paper)
export const FLAG_LEFT = 2;
export const FLAG_RIGHT = 4;
export const FLAG_TOP = 8;
export const FLAG_BOTTOM = 16;
export const FLAG_WET = 32; // some cell is wet (surface water at least DRY_EPS deep)

/** f32 parameters per lane (one per wet layer). */
export const PARAM_FLOATS = 32;

/** Index of each packed parameter (the kernels read these offsets). */
export const PARAM = {
  omega: 0,
  tau: 1,
  evap: 2,
  edgeEvap: 3, // times the edge field
  mobility: 4, // half the pigment mobility (the face flux uses the sum of two velocities)
  depRate: 5,
  pickup: 6,
  absorption: 7,
  invCap: 8,
  blockScale: 9,
  rough: 10,
  pinT: 11,
  gx: 12,
  gy: 13,
  flowK: 14,
  granulation: 15,
  edgeDep: 16, // times the edge field
  bloom: 17,
  paperEvap: 18,
  hasFlow: 19,
  bleed: 20,
} as const;

/**
 * A wet layer's settings, each 0..1 unless noted. The paper's absorption, permeability and
 * roughness come from the paper, not from here.
 */
export interface WetParams {
  /** How thick the water is: 0 runny (ink) .. 1 very thick (oil). Default 0.3 (watercolour). */
  viscosity: number;
  /** How fast the water dries: 0 never .. 1 very fast. Default 0.45. */
  evaporation: number;
  /** Darker, crisper edges where a wash dries: 0 none .. 1 strong. Default 0.5. */
  edgeDarkening: number;
  /** How heavy the pigment is: heavy pigment travels less and settles sooner. Default 0.3. */
  pigmentWeight: number;
  /** How much pigment collects in the paper's valleys. Default 0.4. */
  granulation: number;
  /** How readily water lifts settled pigment back up (re-wetting). Default 0.2. */
  pickup: number;
  /** How fast suspended pigment settles into the paper (staining). Default 0.2. */
  fixture: number;
  /** Blooms (backruns): water flowing into a drying wash pushes its pigment out. Default 0.4. */
  bloom: number;
  /** Colour bleed: pigment spreading between touching wet areas. Default 0.3. */
  bleed: number;
}

export const DEFAULT_WET_PARAMS: Readonly<WetParams> = {
  viscosity: 0.3,
  evaporation: 0.45,
  edgeDarkening: 0.5,
  pigmentWeight: 0.3,
  granulation: 0.4,
  pickup: 0.2,
  fixture: 0.2,
  bloom: 0.4,
  bleed: 0.3,
};

export const WET_PARAM_KEYS = Object.keys(DEFAULT_WET_PARAMS) as (keyof WetParams)[];

/** The paper as wet media read it (all 0..1; from the paint editor's paper settings). */
export interface WetPaper {
  absorption: number;
  permeability: number;
  roughness: number;
}

export const DEFAULT_WET_PAPER: Readonly<WetPaper> = { absorption: 0.7, permeability: 0.5, roughness: 0.6 };

/** Canvas tilt (shared by every wet layer): water runs downhill. */
export interface WetTilt {
  /** Degrees from flat, 0 (flat) .. 90 (upright). */
  angle: number;
  /** Which way is downhill, degrees clockwise from canvas down (0 = towards the bottom edge). */
  direction: number;
}

export const FLAT: Readonly<WetTilt> = { angle: 0, direction: 0 };

const unit = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);

/** Settings with every field in range; missing fields come from `base`. */
export function normalizeWetParams(raw: Partial<WetParams> = {}, base: WetParams = DEFAULT_WET_PARAMS): WetParams {
  const out = {} as WetParams;
  for (const k of WET_PARAM_KEYS) out[k] = unit(raw[k], base[k]);
  return out;
}

export function normalizeTilt(raw: Partial<WetTilt> = {}, base: WetTilt = FLAT): WetTilt {
  const angle = typeof raw.angle === 'number' && Number.isFinite(raw.angle) ? Math.min(90, Math.max(0, raw.angle)) : base.angle;
  let direction = typeof raw.direction === 'number' && Number.isFinite(raw.direction) ? raw.direction : base.direction;
  direction = ((direction % 360) + 360) % 360;
  return { angle, direction };
}

/** Kinematic viscosity (lattice units) for `viscosity` 0..1: 0.02 .. 1.5, exponential. */
export function latticeViscosity(v: number): number {
  return 0.02 * Math.pow(75, v);
}

/** Water a cell of paper holds when saturated, in depth units. */
export const PAPER_CAPACITY = 0.08;

/** Largest tilt acceleration (cells per step²), at 90°. */
export const MAX_TILT_ACCEL = 0.025;

/** Packs a lane's settings into the f32 block the kernels read. `flowStrength` 0 turns the flow map off. */
export function packWetParams(params: WetParams, paper: WetPaper, tilt: WetTilt, flowStrength: number, out = new Float32Array(PARAM_FLOATS)): Float32Array {
  const nu = latticeViscosity(params.viscosity);
  const tau = 3 * nu + 0.5;
  const g = MAX_TILT_ACCEL * Math.sin((tilt.angle * Math.PI) / 180);
  const dir = (tilt.direction * Math.PI) / 180;
  out.fill(0);
  out[PARAM.omega] = 1 / tau;
  out[PARAM.tau] = tau;
  out[PARAM.evap] = 1e-3 * params.evaporation * params.evaporation;
  out[PARAM.edgeEvap] = params.edgeDarkening * 12; // the edge band dries much faster, so water (and pigment) flows out to it
  out[PARAM.mobility] = 0.5 * (1 - 0.5 * params.pigmentWeight);
  out[PARAM.depRate] = 0.019 * params.fixture * (0.5 + params.pigmentWeight);
  out[PARAM.pickup] = 0.01 * params.pickup;
  out[PARAM.absorption] = 0.0015 * paper.absorption;
  out[PARAM.invCap] = 1 / PAPER_CAPACITY;
  out[PARAM.blockScale] = 0.05 * (1 - paper.permeability);
  out[PARAM.rough] = 0.15 * paper.roughness;
  out[PARAM.pinT] = 0.2;
  out[PARAM.gx] = -g * Math.sin(dir);
  out[PARAM.gy] = g * Math.cos(dir);
  out[PARAM.flowK] = flowStrength;
  out[PARAM.granulation] = 1.2 * params.granulation * paper.roughness;
  out[PARAM.edgeDep] = params.edgeDarkening * 3;
  out[PARAM.bloom] = 60 * params.bloom;
  out[PARAM.paperEvap] = 0.5e-3 * params.evaporation * params.evaporation;
  out[PARAM.hasFlow] = flowStrength !== 0 ? 1 : 0;
  out[PARAM.bleed] = 0.05 * params.bleed;
  return out;
}

/** Flag bits for a wet (or alive) cell at tile-local (lx, ly): which neighbours it wakes. */
export function edgeBits(lx: number, ly: number): number {
  let b = 0;
  if (lx < STRIP) b |= FLAG_LEFT;
  if (lx >= WET_TILE - STRIP) b |= FLAG_RIGHT;
  if (ly < STRIP) b |= FLAG_TOP;
  if (ly >= WET_TILE - STRIP) b |= FLAG_BOTTOM;
  return b;
}
