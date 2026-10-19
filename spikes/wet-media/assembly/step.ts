// AssemblyScript port of `stepTile` in src/ts-sim.ts, 4 cells per f32x4 lane group.
//
// One tile slot holds 31 planes of 258 x 258 f32 (256 interior + 1-cell halo):
//   set A: f0..f8, rho, ux, uy, p   (planes 0..12)
//   set B: the same                 (planes 13..25)
//   d 26, s 27, h 28 (h = -1 marks off-canvas halo), flow x 29, flow y 30
// The step reads set `parity` and writes the interior of the other set. Halos are filled by
// the workers (src/wasm-layout.ts) after every step.
//
// The f32 operation order follows the TS reference so the two only differ by rounding
// (the reference computes in f64 and stores f32).

const S: i32 = 258;
const PLANE: usize = 258 * 258 * 4;
const SET: usize = 13 * PLANE;
const PARAMS: usize = 1024;
const DRY_EPS: f32 = 1e-3;
const U_MAX: f32 = 0.25;
const STRIP: i32 = 64;

@inline function ld(p: usize): v128 {
  return v128.load(p);
}
@inline function sp(x: f32): v128 {
  return f32x4.splat(x);
}
@inline function sel(a: v128, b: v128, m: v128): v128 {
  return v128.bitselect(a, b, m);
}

export function step(base: usize, parity: i32, hasFlow: i32): i32 {
  const omega = sp(load<f32>(PARAMS + 0));
  const tau = sp(load<f32>(PARAMS + 4));
  const evapS = load<f32>(PARAMS + 8);
  const evap = sp(evapS);
  const edgeEvap = sp(load<f32>(PARAMS + 12) * 0.125);
  const mobility = sp(0.5 * load<f32>(PARAMS + 16));
  const depRate = sp(load<f32>(PARAMS + 20));
  const pickup = sp(load<f32>(PARAMS + 24));
  const absorption = sp(load<f32>(PARAMS + 28));
  const invCap = sp(load<f32>(PARAMS + 32));
  const blockScale = sp(load<f32>(PARAMS + 36));
  const rough = sp(load<f32>(PARAMS + 40));
  const pinT = sp(load<f32>(PARAMS + 44));
  const gx0 = sp(load<f32>(PARAMS + 48));
  const gy0 = sp(load<f32>(PARAMS + 52));
  const flowK = sp(load<f32>(PARAMS + 56));

  const zero = sp(0);
  const one = sp(1);
  const half = sp(0.5);
  const eps = sp(DRY_EPS);
  const w0 = sp(<f32>(4.0 / 9.0));
  const w1 = sp(<f32>(1.0 / 9.0));
  const w2 = sp(<f32>(1.0 / 36.0));
  const three = sp(3);
  const fourHalf = sp(4.5);
  const oneHalf = sp(1.5);

  const src = base + <usize>parity * SET;
  const dst = base + <usize>(1 - parity) * SET;
  const dP = base + 26 * PLANE;
  const sP = base + 27 * PLANE;
  const hP = base + 28 * PLANE;
  const fxP = base + 29 * PLANE;
  const fyP = base + 30 * PLANE;
  const rhoS = src + 9 * PLANE;
  const uxS = src + 10 * PLANE;
  const uyS = src + 11 * PLANE;
  const pS = src + 12 * PLANE;

  // neighbour n = x - e_k, as a byte offset; k order matches EX/EY in src/model.ts
  const o1: isize = -4;               // e=( 1, 0) -> n = x-1
  const o2: isize = -S * 4;           // e=( 0, 1) -> n = y-1
  const o3: isize = 4;                // e=(-1, 0)
  const o4: isize = S * 4;            // e=( 0,-1)
  const o5: isize = -S * 4 - 4;       // e=( 1, 1)
  const o6: isize = -S * 4 + 4;       // e=(-1, 1)
  const o7: isize = S * 4 + 4;        // e=(-1,-1)
  const o8: isize = S * 4 - 4;        // e=( 1,-1)

  let flags: i32 = 0;
  for (let y: i32 = 1; y <= 256; y++) {
    for (let x: i32 = 1; x <= 256; x += 4) {
      const c: usize = <usize>(y * S + x) * 4;
      const hx = ld(hP + c);
      const kx = f32x4.mul(blockScale, hx);
      const rx = ld(rhoS + c);
      const pinX = f32x4.add(pinT, f32x4.mul(rough, hx));
      const rxDry = f32x4.lt(rx, eps);

      // 1. streaming with partial bounce-back and pinning
      const fin0 = ld(src + c);
      let dryNb = zero;
      let fin1: v128, fin2: v128, fin3: v128, fin4: v128, fin5: v128, fin6: v128, fin7: v128, fin8: v128;
      {
        // a macro-like block repeated for k = 1..8 (k, opp, offset)
        let n: usize, hn: v128, rn: v128, b: v128, m: v128, rnDry: v128, wall: v128;
        n = c + o1; hn = ld(hP + n); rn = ld(rhoS + n); wall = f32x4.lt(hn, zero); rnDry = f32x4.lt(rn, eps);
        dryNb = f32x4.add(dryNb, sel(one, zero, v128.andnot(rnDry, wall)));
        b = f32x4.max(kx, f32x4.mul(blockScale, hn));
        m = v128.or(wall, v128.or(v128.and(rxDry, f32x4.lt(rn, pinX)), v128.and(rnDry, f32x4.lt(rx, f32x4.add(pinT, f32x4.mul(rough, hn))))));
        b = sel(one, b, m);
        fin1 = f32x4.add(f32x4.mul(f32x4.sub(one, b), ld(src + 1 * PLANE + n)), f32x4.mul(b, ld(src + 3 * PLANE + c)));

        n = c + o2; hn = ld(hP + n); rn = ld(rhoS + n); wall = f32x4.lt(hn, zero); rnDry = f32x4.lt(rn, eps);
        dryNb = f32x4.add(dryNb, sel(one, zero, v128.andnot(rnDry, wall)));
        b = f32x4.max(kx, f32x4.mul(blockScale, hn));
        m = v128.or(wall, v128.or(v128.and(rxDry, f32x4.lt(rn, pinX)), v128.and(rnDry, f32x4.lt(rx, f32x4.add(pinT, f32x4.mul(rough, hn))))));
        b = sel(one, b, m);
        fin2 = f32x4.add(f32x4.mul(f32x4.sub(one, b), ld(src + 2 * PLANE + n)), f32x4.mul(b, ld(src + 4 * PLANE + c)));

        n = c + o3; hn = ld(hP + n); rn = ld(rhoS + n); wall = f32x4.lt(hn, zero); rnDry = f32x4.lt(rn, eps);
        dryNb = f32x4.add(dryNb, sel(one, zero, v128.andnot(rnDry, wall)));
        b = f32x4.max(kx, f32x4.mul(blockScale, hn));
        m = v128.or(wall, v128.or(v128.and(rxDry, f32x4.lt(rn, pinX)), v128.and(rnDry, f32x4.lt(rx, f32x4.add(pinT, f32x4.mul(rough, hn))))));
        b = sel(one, b, m);
        fin3 = f32x4.add(f32x4.mul(f32x4.sub(one, b), ld(src + 3 * PLANE + n)), f32x4.mul(b, ld(src + 1 * PLANE + c)));

        n = c + o4; hn = ld(hP + n); rn = ld(rhoS + n); wall = f32x4.lt(hn, zero); rnDry = f32x4.lt(rn, eps);
        dryNb = f32x4.add(dryNb, sel(one, zero, v128.andnot(rnDry, wall)));
        b = f32x4.max(kx, f32x4.mul(blockScale, hn));
        m = v128.or(wall, v128.or(v128.and(rxDry, f32x4.lt(rn, pinX)), v128.and(rnDry, f32x4.lt(rx, f32x4.add(pinT, f32x4.mul(rough, hn))))));
        b = sel(one, b, m);
        fin4 = f32x4.add(f32x4.mul(f32x4.sub(one, b), ld(src + 4 * PLANE + n)), f32x4.mul(b, ld(src + 2 * PLANE + c)));

        n = c + o5; hn = ld(hP + n); rn = ld(rhoS + n); wall = f32x4.lt(hn, zero); rnDry = f32x4.lt(rn, eps);
        dryNb = f32x4.add(dryNb, sel(one, zero, v128.andnot(rnDry, wall)));
        b = f32x4.max(kx, f32x4.mul(blockScale, hn));
        m = v128.or(wall, v128.or(v128.and(rxDry, f32x4.lt(rn, pinX)), v128.and(rnDry, f32x4.lt(rx, f32x4.add(pinT, f32x4.mul(rough, hn))))));
        b = sel(one, b, m);
        fin5 = f32x4.add(f32x4.mul(f32x4.sub(one, b), ld(src + 5 * PLANE + n)), f32x4.mul(b, ld(src + 7 * PLANE + c)));

        n = c + o6; hn = ld(hP + n); rn = ld(rhoS + n); wall = f32x4.lt(hn, zero); rnDry = f32x4.lt(rn, eps);
        dryNb = f32x4.add(dryNb, sel(one, zero, v128.andnot(rnDry, wall)));
        b = f32x4.max(kx, f32x4.mul(blockScale, hn));
        m = v128.or(wall, v128.or(v128.and(rxDry, f32x4.lt(rn, pinX)), v128.and(rnDry, f32x4.lt(rx, f32x4.add(pinT, f32x4.mul(rough, hn))))));
        b = sel(one, b, m);
        fin6 = f32x4.add(f32x4.mul(f32x4.sub(one, b), ld(src + 6 * PLANE + n)), f32x4.mul(b, ld(src + 8 * PLANE + c)));

        n = c + o7; hn = ld(hP + n); rn = ld(rhoS + n); wall = f32x4.lt(hn, zero); rnDry = f32x4.lt(rn, eps);
        dryNb = f32x4.add(dryNb, sel(one, zero, v128.andnot(rnDry, wall)));
        b = f32x4.max(kx, f32x4.mul(blockScale, hn));
        m = v128.or(wall, v128.or(v128.and(rxDry, f32x4.lt(rn, pinX)), v128.and(rnDry, f32x4.lt(rx, f32x4.add(pinT, f32x4.mul(rough, hn))))));
        b = sel(one, b, m);
        fin7 = f32x4.add(f32x4.mul(f32x4.sub(one, b), ld(src + 7 * PLANE + n)), f32x4.mul(b, ld(src + 5 * PLANE + c)));

        n = c + o8; hn = ld(hP + n); rn = ld(rhoS + n); wall = f32x4.lt(hn, zero); rnDry = f32x4.lt(rn, eps);
        dryNb = f32x4.add(dryNb, sel(one, zero, v128.andnot(rnDry, wall)));
        b = f32x4.max(kx, f32x4.mul(blockScale, hn));
        m = v128.or(wall, v128.or(v128.and(rxDry, f32x4.lt(rn, pinX)), v128.and(rnDry, f32x4.lt(rx, f32x4.add(pinT, f32x4.mul(rough, hn))))));
        b = sel(one, b, m);
        fin8 = f32x4.add(f32x4.mul(f32x4.sub(one, b), ld(src + 8 * PLANE + n)), f32x4.mul(b, ld(src + 6 * PLANE + c)));
      }

      // 2. moments + forcing
      const rho = f32x4.add(f32x4.add(f32x4.add(f32x4.add(f32x4.add(f32x4.add(f32x4.add(f32x4.add(fin0, fin1), fin2), fin3), fin4), fin5), fin6), fin7), fin8);
      // mx = f1 - f3 + f5 - f6 - f7 + f8 ; my = f2 - f4 + f5 + f6 - f7 - f8 (in k order)
      const mx = f32x4.add(f32x4.sub(f32x4.sub(f32x4.add(f32x4.sub(fin1, fin3), fin5), fin6), fin7), fin8);
      const my = f32x4.sub(f32x4.sub(f32x4.add(f32x4.add(f32x4.sub(fin2, fin4), fin5), fin6), fin7), fin8);
      let gx = gx0, gy = gy0;
      if (hasFlow) {
        gx = f32x4.add(gx, f32x4.mul(flowK, ld(fxP + c)));
        gy = f32x4.add(gy, f32x4.mul(flowK, ld(fyP + c)));
      }
      const moving = f32x4.gt(rho, eps);
      let ux = f32x4.add(f32x4.div(mx, rho), f32x4.mul(tau, gx));
      let uy = f32x4.add(f32x4.div(my, rho), f32x4.mul(tau, gy));
      ux = sel(ux, zero, moving);
      uy = sel(uy, zero, moving);
      const sp2 = f32x4.add(f32x4.mul(ux, ux), f32x4.mul(uy, uy));
      const fast = f32x4.gt(sp2, sp(U_MAX * U_MAX));
      const sc = sel(f32x4.div(sp(U_MAX), f32x4.sqrt(sp2)), one, fast);
      ux = f32x4.mul(ux, sc);
      uy = f32x4.mul(uy, sc);

      // 4. absorption + evaporation
      const sx = ld(sP + c);
      const absorbed = f32x4.min(rho, f32x4.mul(f32x4.mul(f32x4.mul(absorption, f32x4.sub(one, f32x4.mul(half, hx))), rho),
        f32x4.max(zero, f32x4.sub(one, f32x4.mul(sx, invCap)))));
      const ev = sel(f32x4.mul(evap, f32x4.add(one, f32x4.mul(edgeEvap, dryNb))), zero, f32x4.gt(rho, zero));
      const rhoNew = f32x4.max(zero, f32x4.sub(f32x4.sub(rho, absorbed), ev));
      const scale = sel(f32x4.div(rhoNew, rho), zero, f32x4.gt(rho, sp(1e-9)));
      v128.store(sP + c, f32x4.max(zero, f32x4.sub(f32x4.add(sx, absorbed), sel(sp(evapS * 0.5), zero, f32x4.gt(sx, zero)))));

      // 3. collision, then scale
      const usq = f32x4.mul(oneHalf, f32x4.add(f32x4.mul(ux, ux), f32x4.mul(uy, uy)));
      const wr0 = f32x4.mul(w0, rho), wr1 = f32x4.mul(w1, rho), wr2 = f32x4.mul(w2, rho);
      let eu: v128, feq: v128;
      // k=0
      feq = f32x4.mul(wr0, f32x4.sub(one, usq));
      v128.store(dst + c, f32x4.mul(f32x4.add(fin0, f32x4.mul(omega, f32x4.sub(feq, fin0))), scale));
      eu = ux;
      feq = f32x4.mul(wr1, f32x4.sub(f32x4.add(f32x4.add(one, f32x4.mul(three, eu)), f32x4.mul(f32x4.mul(fourHalf, eu), eu)), usq));
      v128.store(dst + 1 * PLANE + c, f32x4.mul(f32x4.add(fin1, f32x4.mul(omega, f32x4.sub(feq, fin1))), scale));
      eu = uy;
      feq = f32x4.mul(wr1, f32x4.sub(f32x4.add(f32x4.add(one, f32x4.mul(three, eu)), f32x4.mul(f32x4.mul(fourHalf, eu), eu)), usq));
      v128.store(dst + 2 * PLANE + c, f32x4.mul(f32x4.add(fin2, f32x4.mul(omega, f32x4.sub(feq, fin2))), scale));
      eu = f32x4.neg(ux);
      feq = f32x4.mul(wr1, f32x4.sub(f32x4.add(f32x4.add(one, f32x4.mul(three, eu)), f32x4.mul(f32x4.mul(fourHalf, eu), eu)), usq));
      v128.store(dst + 3 * PLANE + c, f32x4.mul(f32x4.add(fin3, f32x4.mul(omega, f32x4.sub(feq, fin3))), scale));
      eu = f32x4.neg(uy);
      feq = f32x4.mul(wr1, f32x4.sub(f32x4.add(f32x4.add(one, f32x4.mul(three, eu)), f32x4.mul(f32x4.mul(fourHalf, eu), eu)), usq));
      v128.store(dst + 4 * PLANE + c, f32x4.mul(f32x4.add(fin4, f32x4.mul(omega, f32x4.sub(feq, fin4))), scale));
      eu = f32x4.add(ux, uy);
      feq = f32x4.mul(wr2, f32x4.sub(f32x4.add(f32x4.add(one, f32x4.mul(three, eu)), f32x4.mul(f32x4.mul(fourHalf, eu), eu)), usq));
      v128.store(dst + 5 * PLANE + c, f32x4.mul(f32x4.add(fin5, f32x4.mul(omega, f32x4.sub(feq, fin5))), scale));
      eu = f32x4.sub(uy, ux);
      feq = f32x4.mul(wr2, f32x4.sub(f32x4.add(f32x4.add(one, f32x4.mul(three, eu)), f32x4.mul(f32x4.mul(fourHalf, eu), eu)), usq));
      v128.store(dst + 6 * PLANE + c, f32x4.mul(f32x4.add(fin6, f32x4.mul(omega, f32x4.sub(feq, fin6))), scale));
      eu = f32x4.neg(f32x4.add(ux, uy));
      feq = f32x4.mul(wr2, f32x4.sub(f32x4.add(f32x4.add(one, f32x4.mul(three, eu)), f32x4.mul(f32x4.mul(fourHalf, eu), eu)), usq));
      v128.store(dst + 7 * PLANE + c, f32x4.mul(f32x4.add(fin7, f32x4.mul(omega, f32x4.sub(feq, fin7))), scale));
      eu = f32x4.sub(ux, uy);
      feq = f32x4.mul(wr2, f32x4.sub(f32x4.add(f32x4.add(one, f32x4.mul(three, eu)), f32x4.mul(f32x4.mul(fourHalf, eu), eu)), usq));
      v128.store(dst + 8 * PLANE + c, f32x4.mul(f32x4.add(fin8, f32x4.mul(omega, f32x4.sub(feq, fin8))), scale));

      // 5. pigment upwind advection with last step's velocities
      const pc = ld(pS + c);
      const rxWet = v128.not(rxDry);
      const uxc = ld(uxS + c), uyc = ld(uyS + c);
      let pNew = pc;
      let nb: usize, uf: v128, pn: v128, open: v128, flux: v128;
      nb = c + 4; // east
      open = v128.and(rxWet, f32x4.ge(ld(rhoS + nb), eps));
      uf = f32x4.mul(mobility, f32x4.add(uxc, ld(uxS + nb))); pn = ld(pS + nb);
      flux = sel(f32x4.mul(uf, pc), f32x4.mul(uf, pn), f32x4.gt(uf, zero));
      pNew = f32x4.sub(pNew, sel(flux, zero, open));
      nb = c - 4; // west
      open = v128.and(rxWet, f32x4.ge(ld(rhoS + nb), eps));
      uf = f32x4.mul(mobility, f32x4.add(ld(uxS + nb), uxc)); pn = ld(pS + nb);
      flux = sel(f32x4.mul(uf, pn), f32x4.mul(uf, pc), f32x4.gt(uf, zero));
      pNew = f32x4.add(pNew, sel(flux, zero, open));
      nb = c + <usize>(S * 4); // south (y+1)
      open = v128.and(rxWet, f32x4.ge(ld(rhoS + nb), eps));
      uf = f32x4.mul(mobility, f32x4.add(uyc, ld(uyS + nb))); pn = ld(pS + nb);
      flux = sel(f32x4.mul(uf, pc), f32x4.mul(uf, pn), f32x4.gt(uf, zero));
      pNew = f32x4.sub(pNew, sel(flux, zero, open));
      nb = c - <usize>(S * 4); // north (y-1)
      open = v128.and(rxWet, f32x4.ge(ld(rhoS + nb), eps));
      uf = f32x4.mul(mobility, f32x4.add(ld(uyS + nb), uyc)); pn = ld(pS + nb);
      flux = sel(f32x4.mul(uf, pn), f32x4.mul(uf, pc), f32x4.gt(uf, zero));
      pNew = f32x4.add(pNew, sel(flux, zero, open));

      // 6. deposition and pickup
      const dx = ld(dP + c);
      const dryNow = f32x4.lt(rhoNew, eps);
      const depWet = f32x4.min(pNew, f32x4.mul(f32x4.mul(pNew, depRate), f32x4.add(one, f32x4.mul(rough, f32x4.sub(one, hx)))));
      const dep = sel(pNew, depWet, dryNow);
      const lift = sel(zero, f32x4.mul(f32x4.mul(dx, pickup), f32x4.min(rhoNew, one)), dryNow);
      v128.store(dst + 12 * PLANE + c, f32x4.add(f32x4.sub(pNew, dep), lift));
      v128.store(dP + c, f32x4.sub(f32x4.add(dx, dep), lift));
      v128.store(dst + 9 * PLANE + c, rhoNew);
      v128.store(dst + 10 * PLANE + c, sel(zero, ux, dryNow));
      v128.store(dst + 11 * PLANE + c, sel(zero, uy, dryNow));
      if (v128.any_true(v128.not(dryNow))) {
        const lx = x - 1, ly = y - 1;
        let bits = 1;
        if (lx < STRIP) bits |= 2;
        if (lx >= 256 - STRIP) bits |= 4;
        if (ly < STRIP) bits |= 8;
        if (ly >= 256 - STRIP) bits |= 16;
        flags |= bits;
      }
    }
  }
  return flags;
}
