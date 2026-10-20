// The wet-media step in AssemblyScript, compiled to WebAssembly SIMD (`pnpm build:wasm` in
// packages/core writes src/paint/wet/kernel-wasm.ts). It is a lane-for-lane port of `stepSlotTs`
// in src/paint/wet/kernel.ts, 4 cells per f32x4, with the same f32 operations in the same order,
// so both give identical bits. Change them together; tests/paint-wet-kernel.test.ts compares them.
//
// A slot is 43 planes of 258 × 258 f32 (see src/paint/wet/model.ts):
//   set A: f0..f8, rho, ux, uy, paper water, pigment K r/g/b, S, edge   (planes 0..17)
//   set B: the same                                                      (planes 18..35)
//   deposit K r/g/b, S 36..39, paper height 40 (−1 off the canvas), flow x 41, flow y 42
// `step` reads set `parity` and writes the interior of the other set; `halo` copies the edges of
// a slot's neighbours (same lane) into its one-cell border.

const S: i32 = 258;
const PLANE: usize = 258 * 258 * 4;
const SETP: usize = 18 * PLANE;
const P_RHO: usize = 9;
const P_UX: usize = 10;
const P_UY: usize = 11;
const P_SW: usize = 12;
const P_P0: usize = 13;
const P_EDGE: usize = 17;
const P_D0: usize = 36;
const P_H: usize = 40;
const P_FX: usize = 41;
const P_FY: usize = 42;
const SLOT_BYTES: usize = 43 * PLANE;
const DRY_EPS: f32 = 1e-3;
const U_MAX: f32 = 0.25;
const STRIP: i32 = 64;

@inline function ld(p: usize): v128 {
  return v128.load(p);
}
@inline function sp(x: f32): v128 {
  return f32x4.splat(x);
}
/** a where m, else b. */
@inline function sel(a: v128, b: v128, m: v128): v128 {
  return v128.bitselect(a, b, m);
}

// Shared by the streaming helper (each worker has its own instance, so its own globals).
let gDryNb: v128 = f32x4.splat(0);
let gBlock: v128 = f32x4.splat(0);
let gPinT: v128 = f32x4.splat(0);
let gRough: v128 = f32x4.splat(0);
let gInvCap: v128 = f32x4.splat(0);
let gXWall: v128 = f32x4.splat(0);

/** Streaming of direction k into cell c from n = c − eₖ, with partial bounce-back and pinning. */
@inline function stream(c: usize, n: usize, fK: usize, fOpp: usize, hP: usize, rhoS: usize, swS: usize, kx: v128, rx: v128, rxDry: v128, pinX: v128): v128 {
  const zero = sp(0);
  const one = sp(1);
  const eps = sp(DRY_EPS);
  const hn = ld(hP + n);
  const rn = ld(rhoS + n);
  const sn = ld(swS + n);
  const wall = f32x4.lt(hn, zero);
  const rnDry = f32x4.lt(rn, eps);
  // dry neighbours count for the edge as far as their paper is dry too (damp paper is no edge)
  const dampN = f32x4.max(zero, f32x4.sub(one, f32x4.mul(sn, gInvCap)));
  gDryNb = f32x4.add(gDryNb, sel(dampN, zero, v128.andnot(rnDry, wall)));
  let b = f32x4.max(kx, f32x4.mul(gBlock, hn));
  const pinN = f32x4.mul(f32x4.add(gPinT, f32x4.mul(gRough, hn)), dampN);
  const m = v128.or(v128.or(wall, gXWall), v128.or(v128.and(rxDry, f32x4.lt(rn, pinX)), v128.and(rnDry, f32x4.lt(rx, pinN))));
  b = sel(one, b, m);
  return f32x4.add(f32x4.mul(f32x4.sub(one, b), ld(fK + n)), f32x4.mul(b, ld(fOpp + c)));
}

/** The equilibrium-relaxed, scaled population for one direction. */
@inline function collide(fin: v128, wr: v128, eu: v128, usq: v128, omega: v128, scale: v128): v128 {
  const one = sp(1);
  const feq = f32x4.mul(wr, f32x4.sub(f32x4.add(f32x4.add(one, f32x4.mul(sp(3), eu)), f32x4.mul(f32x4.mul(sp(4.5), eu), eu)), usq));
  return f32x4.mul(f32x4.add(fin, f32x4.mul(omega, f32x4.sub(feq, fin))), scale);
}

/** One step of the slot at `base`; `prm` is the lane's 32 packed f32 parameters. Returns flags. */
export function step(base: usize, parity: i32, prm: usize): i32 {
  const omega = sp(load<f32>(prm + 0));
  const tau = sp(load<f32>(prm + 4));
  const evap = sp(load<f32>(prm + 8));
  const edgeEvap = sp(load<f32>(prm + 12));
  const mobility = sp(load<f32>(prm + 16));
  const depRate = sp(load<f32>(prm + 20));
  const pickup = sp(load<f32>(prm + 24));
  const absorption = sp(load<f32>(prm + 28));
  gInvCap = sp(load<f32>(prm + 32));
  gBlock = sp(load<f32>(prm + 36));
  gRough = sp(load<f32>(prm + 40));
  gPinT = sp(load<f32>(prm + 44));
  const gx0 = sp(load<f32>(prm + 48));
  const gy0 = sp(load<f32>(prm + 52));
  const flowK = sp(load<f32>(prm + 56));
  const gran = sp(load<f32>(prm + 60));
  const edgeDep = sp(load<f32>(prm + 64));
  const bloom = sp(load<f32>(prm + 68));
  const paperEvap = sp(load<f32>(prm + 72));
  const hasFlow = load<f32>(prm + 76) != 0;
  const bleed = sp(load<f32>(prm + 80));
  const invCap = gInvCap;
  const blockScale = gBlock;
  const rough = gRough;
  const pinT = gPinT;

  const zero = sp(0);
  const one = sp(1);
  const half = sp(0.5);
  const eps = sp(DRY_EPS);
  const tiny = sp(1e-9);
  const w0 = sp(<f32>(4.0 / 9.0));
  const w1 = sp(<f32>(1.0 / 9.0));
  const w2 = sp(<f32>(1.0 / 36.0));
  const oneHalf = sp(1.5);
  const umax = sp(U_MAX);
  const umax2 = sp(U_MAX * U_MAX);

  const src = base + <usize>parity * SETP;
  const dst = base + <usize>(1 - parity) * SETP;
  const hP = base + P_H * PLANE;
  const dP = base + P_D0 * PLANE;
  const fxP = base + P_FX * PLANE;
  const fyP = base + P_FY * PLANE;
  const rhoS = src + P_RHO * PLANE;
  const uxS = src + P_UX * PLANE;
  const uyS = src + P_UY * PLANE;
  const swS = src + P_SW * PLANE;
  const pS = src + P_P0 * PLANE;
  const eS = src + P_EDGE * PLANE;
  const quarter = sp(0.25);
  const decay = sp(0.99);
  const row: usize = <usize>S * 4;

  let flags: i32 = 0;
  for (let y: i32 = 1; y <= 256; y++) {
    for (let x: i32 = 1; x <= 256; x += 4) {
      const c: usize = <usize>(y * S + x) * 4;
      const hx = ld(hP + c);
      const kx = f32x4.mul(blockScale, hx);
      const rx = ld(rhoS + c);
      const sx = ld(swS + c);
      const damp = f32x4.max(zero, f32x4.sub(one, f32x4.mul(sx, invCap)));
      const pinX = f32x4.mul(f32x4.add(pinT, f32x4.mul(rough, hx)), damp);
      const rxDry = f32x4.lt(rx, eps);
      gXWall = f32x4.lt(hx, zero);

      // 1. streaming (n = c − eₖ; k order of EX / EY)
      gDryNb = zero;
      const fin0 = ld(src + c);
      const fin1 = stream(c, c - 4, src + 1 * PLANE, src + 3 * PLANE, hP, rhoS, swS, kx, rx, rxDry, pinX);
      const fin2 = stream(c, c - row, src + 2 * PLANE, src + 4 * PLANE, hP, rhoS, swS, kx, rx, rxDry, pinX);
      const fin3 = stream(c, c + 4, src + 3 * PLANE, src + 1 * PLANE, hP, rhoS, swS, kx, rx, rxDry, pinX);
      const fin4 = stream(c, c + row, src + 4 * PLANE, src + 2 * PLANE, hP, rhoS, swS, kx, rx, rxDry, pinX);
      const fin5 = stream(c, c - row - 4, src + 5 * PLANE, src + 7 * PLANE, hP, rhoS, swS, kx, rx, rxDry, pinX);
      const fin6 = stream(c, c - row + 4, src + 6 * PLANE, src + 8 * PLANE, hP, rhoS, swS, kx, rx, rxDry, pinX);
      const fin7 = stream(c, c + row + 4, src + 7 * PLANE, src + 5 * PLANE, hP, rhoS, swS, kx, rx, rxDry, pinX);
      const fin8 = stream(c, c + row - 4, src + 8 * PLANE, src + 6 * PLANE, hP, rhoS, swS, kx, rx, rxDry, pinX);
      const dryNb = gDryNb;

      // 2. depth, velocity, forcing
      const rho = f32x4.add(f32x4.add(f32x4.add(f32x4.add(f32x4.add(f32x4.add(f32x4.add(f32x4.add(fin0, fin1), fin2), fin3), fin4), fin5), fin6), fin7), fin8);
      const mx = f32x4.add(f32x4.sub(f32x4.sub(f32x4.add(f32x4.sub(fin1, fin3), fin5), fin6), fin7), fin8);
      const my = f32x4.sub(f32x4.sub(f32x4.add(f32x4.add(f32x4.sub(fin2, fin4), fin5), fin6), fin7), fin8);
      let gx = gx0;
      let gy = gy0;
      if (hasFlow) {
        gx = f32x4.add(gx, f32x4.mul(flowK, ld(fxP + c)));
        gy = f32x4.add(gy, f32x4.mul(flowK, ld(fyP + c)));
      }
      const moving = f32x4.gt(rho, eps);
      let ux = sel(f32x4.add(f32x4.div(mx, rho), f32x4.mul(tau, gx)), zero, moving);
      let uy = sel(f32x4.add(f32x4.div(my, rho), f32x4.mul(tau, gy)), zero, moving);
      const sp2 = f32x4.add(f32x4.mul(ux, ux), f32x4.mul(uy, uy));
      const fast = f32x4.gt(sp2, umax2);
      const sc = f32x4.div(umax, f32x4.sqrt(sp2));
      ux = sel(f32x4.mul(ux, sc), ux, fast);
      uy = sel(f32x4.mul(uy, sc), uy, fast);

      // 3. absorption and evaporation
      const absorbed = f32x4.min(rho, f32x4.mul(f32x4.mul(f32x4.mul(absorption, f32x4.sub(one, f32x4.mul(half, hx))), rho), damp));
      const ex = ld(eS + c);
      const ev = sel(f32x4.mul(evap, f32x4.add(one, f32x4.mul(edgeEvap, ex))), zero, f32x4.gt(rho, zero));
      const rhoNew = f32x4.max(zero, f32x4.sub(f32x4.sub(rho, absorbed), ev));
      const scale = sel(f32x4.div(rhoNew, rho), zero, f32x4.gt(rho, tiny));
      const sNew = f32x4.max(zero, f32x4.sub(f32x4.add(sx, absorbed), sel(paperEvap, zero, f32x4.gt(sx, zero))));
      v128.store(dst + P_SW * PLANE + c, sNew);

      // 4. collision, then scale
      const usq = f32x4.mul(oneHalf, f32x4.add(f32x4.mul(ux, ux), f32x4.mul(uy, uy)));
      const wr0 = f32x4.mul(w0, rho);
      const wr1 = f32x4.mul(w1, rho);
      const wr2 = f32x4.mul(w2, rho);
      const feq0 = f32x4.mul(wr0, f32x4.sub(one, usq));
      v128.store(dst + c, f32x4.mul(f32x4.add(fin0, f32x4.mul(omega, f32x4.sub(feq0, fin0))), scale));
      v128.store(dst + 1 * PLANE + c, collide(fin1, wr1, ux, usq, omega, scale));
      v128.store(dst + 2 * PLANE + c, collide(fin2, wr1, uy, usq, omega, scale));
      v128.store(dst + 3 * PLANE + c, collide(fin3, wr1, f32x4.neg(ux), usq, omega, scale));
      v128.store(dst + 4 * PLANE + c, collide(fin4, wr1, f32x4.neg(uy), usq, omega, scale));
      v128.store(dst + 5 * PLANE + c, collide(fin5, wr2, f32x4.add(ux, uy), usq, omega, scale));
      v128.store(dst + 6 * PLANE + c, collide(fin6, wr2, f32x4.sub(uy, ux), usq, omega, scale));
      v128.store(dst + 7 * PLANE + c, collide(fin7, wr2, f32x4.neg(f32x4.add(ux, uy)), usq, omega, scale));
      v128.store(dst + 8 * PLANE + c, collide(fin8, wr2, f32x4.sub(ux, uy), usq, omega, scale));

      // 5. pigment: upwind advection with the last step's velocities, plus bleed
      const rxWet = v128.not(rxDry);
      const uxc = ld(uxS + c);
      const uyc = ld(uyS + c);
      const pc0 = ld(pS + c);
      const pc1 = ld(pS + PLANE + c);
      const pc2 = ld(pS + 2 * PLANE + c);
      const pc3 = ld(pS + 3 * PLANE + c);
      let p0 = pc0;
      let p1 = pc1;
      let p2 = pc2;
      let p3 = pc3;
      let nb: usize;
      let open: v128;
      let uf: v128;
      let pos: v128;
      let pn: v128;
      // east (outgoing): p − (uf > 0 ? uf·pc : uf·pn) + bleed·(pn − pc)
      nb = c + 4;
      open = v128.and(rxWet, f32x4.ge(ld(rhoS + nb), eps));
      uf = f32x4.mul(mobility, f32x4.add(uxc, ld(uxS + nb)));
      pos = f32x4.gt(uf, zero);
      pn = ld(pS + nb); p0 = sel(f32x4.add(f32x4.sub(p0, sel(f32x4.mul(uf, pc0), f32x4.mul(uf, pn), pos)), f32x4.mul(bleed, f32x4.sub(pn, pc0))), p0, open);
      pn = ld(pS + PLANE + nb); p1 = sel(f32x4.add(f32x4.sub(p1, sel(f32x4.mul(uf, pc1), f32x4.mul(uf, pn), pos)), f32x4.mul(bleed, f32x4.sub(pn, pc1))), p1, open);
      pn = ld(pS + 2 * PLANE + nb); p2 = sel(f32x4.add(f32x4.sub(p2, sel(f32x4.mul(uf, pc2), f32x4.mul(uf, pn), pos)), f32x4.mul(bleed, f32x4.sub(pn, pc2))), p2, open);
      pn = ld(pS + 3 * PLANE + nb); p3 = sel(f32x4.add(f32x4.sub(p3, sel(f32x4.mul(uf, pc3), f32x4.mul(uf, pn), pos)), f32x4.mul(bleed, f32x4.sub(pn, pc3))), p3, open);
      // west (incoming): p + (uf > 0 ? uf·pn : uf·pc) + bleed·(pn − pc)
      nb = c - 4;
      open = v128.and(rxWet, f32x4.ge(ld(rhoS + nb), eps));
      uf = f32x4.mul(mobility, f32x4.add(ld(uxS + nb), uxc));
      pos = f32x4.gt(uf, zero);
      pn = ld(pS + nb); p0 = sel(f32x4.add(f32x4.add(p0, sel(f32x4.mul(uf, pn), f32x4.mul(uf, pc0), pos)), f32x4.mul(bleed, f32x4.sub(pn, pc0))), p0, open);
      pn = ld(pS + PLANE + nb); p1 = sel(f32x4.add(f32x4.add(p1, sel(f32x4.mul(uf, pn), f32x4.mul(uf, pc1), pos)), f32x4.mul(bleed, f32x4.sub(pn, pc1))), p1, open);
      pn = ld(pS + 2 * PLANE + nb); p2 = sel(f32x4.add(f32x4.add(p2, sel(f32x4.mul(uf, pn), f32x4.mul(uf, pc2), pos)), f32x4.mul(bleed, f32x4.sub(pn, pc2))), p2, open);
      pn = ld(pS + 3 * PLANE + nb); p3 = sel(f32x4.add(f32x4.add(p3, sel(f32x4.mul(uf, pn), f32x4.mul(uf, pc3), pos)), f32x4.mul(bleed, f32x4.sub(pn, pc3))), p3, open);
      // south (y + 1, outgoing)
      nb = c + row;
      open = v128.and(rxWet, f32x4.ge(ld(rhoS + nb), eps));
      uf = f32x4.mul(mobility, f32x4.add(uyc, ld(uyS + nb)));
      pos = f32x4.gt(uf, zero);
      pn = ld(pS + nb); p0 = sel(f32x4.add(f32x4.sub(p0, sel(f32x4.mul(uf, pc0), f32x4.mul(uf, pn), pos)), f32x4.mul(bleed, f32x4.sub(pn, pc0))), p0, open);
      pn = ld(pS + PLANE + nb); p1 = sel(f32x4.add(f32x4.sub(p1, sel(f32x4.mul(uf, pc1), f32x4.mul(uf, pn), pos)), f32x4.mul(bleed, f32x4.sub(pn, pc1))), p1, open);
      pn = ld(pS + 2 * PLANE + nb); p2 = sel(f32x4.add(f32x4.sub(p2, sel(f32x4.mul(uf, pc2), f32x4.mul(uf, pn), pos)), f32x4.mul(bleed, f32x4.sub(pn, pc2))), p2, open);
      pn = ld(pS + 3 * PLANE + nb); p3 = sel(f32x4.add(f32x4.sub(p3, sel(f32x4.mul(uf, pc3), f32x4.mul(uf, pn), pos)), f32x4.mul(bleed, f32x4.sub(pn, pc3))), p3, open);
      // north (y − 1, incoming)
      nb = c - row;
      open = v128.and(rxWet, f32x4.ge(ld(rhoS + nb), eps));
      uf = f32x4.mul(mobility, f32x4.add(ld(uyS + nb), uyc));
      pos = f32x4.gt(uf, zero);
      pn = ld(pS + nb); p0 = sel(f32x4.add(f32x4.add(p0, sel(f32x4.mul(uf, pn), f32x4.mul(uf, pc0), pos)), f32x4.mul(bleed, f32x4.sub(pn, pc0))), p0, open);
      pn = ld(pS + PLANE + nb); p1 = sel(f32x4.add(f32x4.add(p1, sel(f32x4.mul(uf, pn), f32x4.mul(uf, pc1), pos)), f32x4.mul(bleed, f32x4.sub(pn, pc1))), p1, open);
      pn = ld(pS + 2 * PLANE + nb); p2 = sel(f32x4.add(f32x4.add(p2, sel(f32x4.mul(uf, pn), f32x4.mul(uf, pc2), pos)), f32x4.mul(bleed, f32x4.sub(pn, pc2))), p2, open);
      pn = ld(pS + 3 * PLANE + nb); p3 = sel(f32x4.add(f32x4.add(p3, sel(f32x4.mul(uf, pn), f32x4.mul(uf, pc3), pos)), f32x4.mul(bleed, f32x4.sub(pn, pc3))), p3, open);

      // 6. deposition and pickup
      const dryNow = f32x4.lt(rhoNew, eps);
      const rate = f32x4.mul(f32x4.mul(depRate, f32x4.add(one, f32x4.mul(gran, f32x4.sub(one, hx)))), f32x4.add(one, f32x4.mul(edgeDep, ex)));
      const liftWet = f32x4.mul(f32x4.mul(pickup, f32x4.min(rhoNew, one)), f32x4.add(one, f32x4.mul(bloom, f32x4.max(zero, f32x4.sub(rhoNew, rx)))));
      const lift = sel(zero, liftWet, dryNow);
      settle(dst + P_P0 * PLANE + c, dP + c, f32x4.max(zero, p0), rate, lift, dryNow);
      settle(dst + (P_P0 + 1) * PLANE + c, dP + PLANE + c, f32x4.max(zero, p1), rate, lift, dryNow);
      settle(dst + (P_P0 + 2) * PLANE + c, dP + 2 * PLANE + c, f32x4.max(zero, p2), rate, lift, dryNow);
      settle(dst + (P_P0 + 3) * PLANE + c, dP + 3 * PLANE + c, f32x4.max(zero, p3), rate, lift, dryNow);
      const mean4 = f32x4.mul(f32x4.add(f32x4.add(f32x4.add(ld(eS + c + 4), ld(eS + c - 4)), ld(eS + c + row)), ld(eS + c - row)), quarter);
      const eNew = f32x4.min(one, f32x4.max(f32x4.min(one, f32x4.mul(dryNb, quarter)), f32x4.mul(decay, mean4)));
      v128.store(dst + P_EDGE * PLANE + c, sel(zero, eNew, dryNow));
      v128.store(dst + P_RHO * PLANE + c, rhoNew);
      v128.store(dst + P_UX * PLANE + c, sel(zero, ux, dryNow));
      v128.store(dst + P_UY * PLANE + c, sel(zero, uy, dryNow));
      const alive = v128.or(f32x4.gt(rhoNew, zero), f32x4.gt(sNew, zero));
      if (v128.any_true(alive)) {
        const lx = x - 1;
        const ly = y - 1;
        let bits = 1;
        if (lx < STRIP) bits |= 2;
        if (lx >= 256 - STRIP) bits |= 4;
        if (ly < STRIP) bits |= 8;
        if (ly >= 256 - STRIP) bits |= 16;
        flags |= bits;
      }
      if (v128.any_true(v128.not(dryNow))) flags |= 32;
    }
  }
  return flags;
}

/** Deposition and pickup of one pigment channel. */
@inline function settle(pOut: usize, dAt: usize, pq: v128, rate: v128, lift: v128, dryNow: v128): void {
  const dq = ld(dAt);
  const dep = sel(pq, f32x4.min(pq, f32x4.mul(pq, rate)), dryNow);
  const lq = f32x4.mul(dq, lift);
  v128.store(pOut, f32x4.add(f32x4.sub(pq, dep), lq));
  v128.store(dAt, f32x4.sub(f32x4.add(dq, dep), lq));
}

/** The slot of tile (tx, ty) in a lane, or −1 (inactive or off the canvas). */
@inline function slotOf(table: usize, laneBase: i32, tilesX: i32, tilesY: i32, tx: i32, ty: i32): i32 {
  if (tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY) return -1;
  return load<i32>(table + (<usize>(laneBase + ty * tilesX + tx) << 2));
}

/**
 * Fills the one-cell border of the slot holding `key` (lane·tilesPerLane + tile) in set `set` from
 * the interiors of its 8 neighbours in the same lane. Inactive neighbours leave zeros there.
 */
export function halo(table: usize, slots: usize, key: i32, tilesPerLane: i32, tilesX: i32, tilesY: i32, set: i32): void {
  const lane = key / tilesPerLane;
  const laneBase = lane * tilesPerLane;
  const tile = key - laneBase;
  const tx = tile % tilesX;
  const ty = tile / tilesX;
  const me = slots + <usize>load<i32>(table + (<usize>key << 2)) * SLOT_BYTES + <usize>set * SETP;
  const n = slotOf(table, laneBase, tilesX, tilesY, tx, ty - 1);
  const s = slotOf(table, laneBase, tilesX, tilesY, tx, ty + 1);
  const w = slotOf(table, laneBase, tilesX, tilesY, tx - 1, ty);
  const e = slotOf(table, laneBase, tilesX, tilesY, tx + 1, ty);
  const nw = slotOf(table, laneBase, tilesX, tilesY, tx - 1, ty - 1);
  const ne = slotOf(table, laneBase, tilesX, tilesY, tx + 1, ty - 1);
  const sw = slotOf(table, laneBase, tilesX, tilesY, tx - 1, ty + 1);
  const se = slotOf(table, laneBase, tilesX, tilesY, tx + 1, ty + 1);
  const row: usize = <usize>S * 4;
  const setOff: usize = <usize>set * SETP;
  for (let k: usize = 0; k < 18; k++) {
    const mp = me + k * PLANE;
    const off = setOff + k * PLANE;
    if (n >= 0) memory.copy(mp + 4, slots + <usize>n * SLOT_BYTES + off + 256 * row + 4, 1024);
    if (s >= 0) memory.copy(mp + 257 * row + 4, slots + <usize>s * SLOT_BYTES + off + row + 4, 1024);
    if (w >= 0) {
      const o = slots + <usize>w * SLOT_BYTES + off + 256 * 4;
      for (let y: usize = 1; y <= 256; y++) store<f32>(mp + y * row, load<f32>(o + y * row));
    }
    if (e >= 0) {
      const o = slots + <usize>e * SLOT_BYTES + off + 4;
      for (let y: usize = 1; y <= 256; y++) store<f32>(mp + y * row + 257 * 4, load<f32>(o + y * row));
    }
    if (nw >= 0) store<f32>(mp, load<f32>(slots + <usize>nw * SLOT_BYTES + off + 256 * row + 256 * 4));
    if (ne >= 0) store<f32>(mp + 257 * 4, load<f32>(slots + <usize>ne * SLOT_BYTES + off + 256 * row + 4));
    if (sw >= 0) store<f32>(mp + 257 * row, load<f32>(slots + <usize>sw * SLOT_BYTES + off + row + 256 * 4));
    if (se >= 0) store<f32>(mp + 257 * row + 257 * 4, load<f32>(slots + <usize>se * SLOT_BYTES + off + row + 4));
  }
}
