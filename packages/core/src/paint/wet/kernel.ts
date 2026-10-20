/**
 * One wet-media step for the 256 × 256 interior of a tile slot, in plain TypeScript: the
 * specification of the model. Every intermediate is rounded to f32 (`F`) in the same order as the
 * WebAssembly SIMD kernel (`assembly/wet.ts`), so the two give identical bits: computing an f32
 * `+ − × ÷ √` in f64 and rounding once is exactly the f32 operation. Keep the two in step; the
 * kernel test compares them bit for bit.
 *
 * A slot is `SLOT_PLANES` planes of 258 × 258 f32 (the tile plus a one-cell halo, filled from the
 * neighbouring slots after each step). The step reads set `parity` (and the single planes) and
 * writes the interior of the other set, the deposit planes in place, and returns the tile's flags.
 *
 * Per cell x:
 *  1. Streaming with partial bounce-back: for each direction i, the source is n = x − eᵢ and the
 *     blocking is b = max(κ(x), κ(n)), κ = blockScale·h. b = 1 off the canvas (h < 0) and where the
 *     front is pinned: one side dry and the other shallower than the pin threshold
 *     (pinT + rough·h)·(1 − paperWater/capacity) of the dry side, so damp paper does not pin.
 *     Off-canvas cells (h < 0, in the halo or past a canvas edge inside a tile) only bounce back.
 *     Symmetric in x and n, so water is conserved: fᵢ(x) = (1 − b)·f*ᵢ(n) + b·f*ₒₚₚ₍ᵢ₎(x).
 *  2. Depth and velocity; tilt plus the flow map shift the velocity (u += τ·g), capped at U_MAX.
 *  3. Absorption into the paper until it holds its capacity, and evaporation (faster in the edge
 *     band); the collided populations are scaled by the depth ratio.
 *  4. BGK collision towards the D2Q9 equilibrium.
 *  5. Pigment (4 channels): upwind flux through the 4 faces with the previous step's velocities,
 *     plus bleed (diffusion) between wet cells; never below 0.
 *  6. Deposition (more in valleys and in the edge band) and pickup (more where water arrives);
 *     where a cell dries, all its suspended pigment settles.
 *  7. The edge field: max(dry neighbours / 4, 0.99 × the mean of the 4 neighbours' edge), at most
 *     1, and 0 where the cell is dry.
 */

import {
  DRY_EPS,
  FLAG_ALIVE,
  FLAG_WET,
  P_D0,
  P_EDGE,
  P_FX,
  P_FY,
  P_H,
  P_P0,
  P_RHO,
  P_SW,
  P_UX,
  P_UY,
  PARAM,
  PLANE,
  SET_PLANES,
  SLOT_SIDE,
  U_MAX,
  edgeBits,
} from './model';

const F = Math.fround;
const S = SLOT_SIDE;
const EPS = F(DRY_EPS);
const UMAX2 = F(U_MAX * U_MAX);
const UMAXF = F(U_MAX);
const W0 = F(4 / 9);
const W1 = F(1 / 9);
const W2 = F(1 / 36);
const TINY = F(1e-9);
/** The edge field's fall-off per cell (an f32 constant, as in the SIMD kernel). */
const DECAY = F(0.99);

/** Neighbour n = x − eₖ as a float offset, k = 1..8 (the order of `EX` / `EY`). */
const NB = [0, -1, -S, 1, S, -S - 1, -S + 1, S + 1, S - 1];
const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];

const fin = new Float32Array(9);
const pNew = new Float32Array(4);

/**
 * Steps one slot. `f` views the whole memory; `base` is the slot's first float; `prm` is the
 * lane's packed parameters (`packWetParams`). Returns the tile's flag bits.
 */
export function stepSlotTs(f: Float32Array, base: number, parity: number, prm: Float32Array): number {
  const src = base + parity * SET_PLANES * PLANE;
  const dst = base + (1 - parity) * SET_PLANES * PLANE;
  const hP = base + P_H * PLANE;
  const dP = base + P_D0 * PLANE;
  const rhoS = src + P_RHO * PLANE;
  const uxS = src + P_UX * PLANE;
  const uyS = src + P_UY * PLANE;
  const swS = src + P_SW * PLANE;
  const pS = src + P_P0 * PLANE;
  const eS = src + P_EDGE * PLANE;

  const omega = prm[PARAM.omega];
  const tau = prm[PARAM.tau];
  const evap = prm[PARAM.evap];
  const edgeEvap = prm[PARAM.edgeEvap];
  const mobility = prm[PARAM.mobility];
  const depRate = prm[PARAM.depRate];
  const pickup = prm[PARAM.pickup];
  const absorption = prm[PARAM.absorption];
  const invCap = prm[PARAM.invCap];
  const blockScale = prm[PARAM.blockScale];
  const rough = prm[PARAM.rough];
  const pinT = prm[PARAM.pinT];
  const gx0 = prm[PARAM.gx];
  const gy0 = prm[PARAM.gy];
  const flowK = prm[PARAM.flowK];
  const gran = prm[PARAM.granulation];
  const edgeDep = prm[PARAM.edgeDep];
  const bloom = prm[PARAM.bloom];
  const paperEvap = prm[PARAM.paperEvap];
  const hasFlow = prm[PARAM.hasFlow] !== 0;
  const bleed = prm[PARAM.bleed];

  let flags = 0;
  for (let y = 1; y <= 256; y++) {
    for (let x = 1; x <= 256; x++) {
      const c = y * S + x;
      const hx = f[hP + c];
      const kx = F(blockScale * hx);
      const rx = f[rhoS + c];
      const sx = f[swS + c];
      const damp = Math.max(0, F(1 - F(sx * invCap)));
      const pinX = F(F(pinT + F(rough * hx)) * damp);
      const rxDry = rx < EPS;
      const xWall = hx < 0;

      // 1. streaming with partial bounce-back and pinning
      fin[0] = f[src + c];
      let dryNb = 0;
      for (let k = 1; k <= 8; k++) {
        const n = c + NB[k];
        const hn = f[hP + n];
        const rn = f[rhoS + n];
        const sn = f[swS + n];
        const wall = hn < 0;
        const rnDry = rn < EPS;
        // dry neighbours count for the edge as far as their paper is dry too (damp paper is no edge)
        const dampN = Math.max(0, F(1 - F(sn * invCap)));
        if (rnDry && !wall) dryNb = F(dryNb + dampN);
        let b = Math.max(kx, F(blockScale * hn));
        const pinN = F(F(pinT + F(rough * hn)) * dampN);
        if (wall || xWall || (rxDry && rn < pinX) || (rnDry && rx < pinN)) b = 1;
        fin[k] = F(F(F(1 - b) * f[src + k * PLANE + n]) + F(b * f[src + OPP[k] * PLANE + c]));
      }

      // 2. depth, velocity, forcing
      const rho = F(F(F(F(F(F(F(F(fin[0] + fin[1]) + fin[2]) + fin[3]) + fin[4]) + fin[5]) + fin[6]) + fin[7]) + fin[8]);
      const mx = F(F(F(F(F(fin[1] - fin[3]) + fin[5]) - fin[6]) - fin[7]) + fin[8]);
      const my = F(F(F(F(F(fin[2] - fin[4]) + fin[5]) + fin[6]) - fin[7]) - fin[8]);
      let gx = gx0;
      let gy = gy0;
      if (hasFlow) {
        gx = F(gx + F(flowK * f[base + P_FX * PLANE + c]));
        gy = F(gy + F(flowK * f[base + P_FY * PLANE + c]));
      }
      let ux = 0;
      let uy = 0;
      if (rho > EPS) {
        ux = F(F(mx / rho) + F(tau * gx));
        uy = F(F(my / rho) + F(tau * gy));
      }
      const sp2 = F(F(ux * ux) + F(uy * uy));
      if (sp2 > UMAX2) {
        const sc = F(UMAXF / F(Math.sqrt(sp2)));
        ux = F(ux * sc);
        uy = F(uy * sc);
      }

      // 3. absorption and evaporation
      const absorbed = Math.min(rho, F(F(F(absorption * F(1 - F(0.5 * hx))) * rho) * damp));
      const ex = f[eS + c];
      const ev = rho > 0 ? F(evap * F(1 + F(edgeEvap * ex))) : 0;
      const rhoNew = Math.max(0, F(F(rho - absorbed) - ev));
      const scale = rho > TINY ? F(rhoNew / rho) : 0;
      const sNew = Math.max(0, F(F(sx + absorbed) - (sx > 0 ? paperEvap : 0)));
      f[dst + P_SW * PLANE + c] = sNew;

      // 4. collision, then scale
      const usq = F(1.5 * F(F(ux * ux) + F(uy * uy)));
      const wr0 = F(W0 * rho);
      const wr1 = F(W1 * rho);
      const wr2 = F(W2 * rho);
      let feq = F(wr0 * F(1 - usq));
      f[dst + c] = F(F(fin[0] + F(omega * F(feq - fin[0]))) * scale);
      for (let k = 1; k <= 8; k++) {
        let eu: number;
        let wr = wr1;
        switch (k) {
          case 1: eu = ux; break;
          case 2: eu = uy; break;
          case 3: eu = -ux; break;
          case 4: eu = -uy; break;
          case 5: eu = F(ux + uy); wr = wr2; break;
          case 6: eu = F(uy - ux); wr = wr2; break;
          case 7: eu = -F(ux + uy); wr = wr2; break;
          default: eu = F(ux - uy); wr = wr2; break;
        }
        feq = F(wr * F(F(F(1 + F(3 * eu)) + F(F(4.5 * eu) * eu)) - usq));
        f[dst + k * PLANE + c] = F(F(fin[k] + F(omega * F(feq - fin[k]))) * scale);
      }

      // 5. pigment: upwind advection with the last step's velocities, plus bleed
      const rxWet = !rxDry;
      const uxc = f[uxS + c];
      const uyc = f[uyS + c];
      for (let q = 0; q < 4; q++) pNew[q] = f[pS + q * PLANE + c];
      // east, west, south (y + 1), north (y − 1)
      for (let face = 0; face < 4; face++) {
        const nb = c + (face === 0 ? 1 : face === 1 ? -1 : face === 2 ? S : -S);
        const open = rxWet && f[rhoS + nb] >= EPS;
        const uf = face === 0 ? F(mobility * F(uxc + f[uxS + nb])) : face === 1 ? F(mobility * F(f[uxS + nb] + uxc)) : face === 2 ? F(mobility * F(uyc + f[uyS + nb])) : F(mobility * F(f[uyS + nb] + uyc));
        const out = face === 0 || face === 2;
        for (let q = 0; q < 4; q++) {
          const pc = f[pS + q * PLANE + c];
          const pn = f[pS + q * PLANE + nb];
          // outgoing faces (east, south): flux = uf > 0 ? uf·pc : uf·pn, subtracted;
          // incoming faces (west, north): flux = uf > 0 ? uf·pn : uf·pc, added.
          const flux = out ? (uf > 0 ? F(uf * pc) : F(uf * pn)) : uf > 0 ? F(uf * pn) : F(uf * pc);
          const diff = F(bleed * F(pn - pc));
          const v = out ? F(F(pNew[q] - flux) + diff) : F(F(pNew[q] + flux) + diff);
          pNew[q] = open ? v : pNew[q];
        }
      }

      // 6. deposition and pickup
      const dryNow = rhoNew < EPS;
      const rate = F(F(depRate * F(1 + F(gran * F(1 - hx)))) * F(1 + F(edgeDep * ex)));
      const lift = dryNow ? 0 : F(F(pickup * Math.min(rhoNew, 1)) * F(1 + F(bloom * Math.max(0, F(rhoNew - rx)))));
      for (let q = 0; q < 4; q++) {
        const pq = Math.max(0, pNew[q]);
        const dq = f[dP + q * PLANE + c];
        const dep = dryNow ? pq : Math.min(pq, F(pq * rate));
        const lq = F(dq * lift);
        f[dst + (P_P0 + q) * PLANE + c] = F(F(pq - dep) + lq);
        f[dP + q * PLANE + c] = F(F(dq + dep) - lq);
      }
      // the edge field: 1 next to dry paper, spreading inwards at 0.99 per cell; 0 where dry
      const mean4 = F(F(F(F(f[eS + c + 1] + f[eS + c - 1]) + f[eS + c + S]) + f[eS + c - S]) * 0.25);
      const eNew = Math.min(1, Math.max(Math.min(1, F(dryNb * 0.25)), F(DECAY * mean4)));
      f[dst + P_EDGE * PLANE + c] = dryNow ? 0 : eNew;
      f[dst + P_RHO * PLANE + c] = rhoNew;
      f[dst + P_UX * PLANE + c] = dryNow ? 0 : ux;
      f[dst + P_UY * PLANE + c] = dryNow ? 0 : uy;
      const alive = rhoNew > 0 || sNew > 0;
      if (alive) flags |= FLAG_ALIVE | edgeBits(x - 1, y - 1);
      if (!dryNow) flags |= FLAG_WET;
    }
  }
  return flags;
}
