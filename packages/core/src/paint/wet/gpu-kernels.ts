/**
 * WGSL compute kernels of the WebGPU wet-media engine ("Engine B"): a port of the step in
 * `kernel.ts` (the specification), the halo exchange of `WetWorld`, and the display shading of
 * `film.ts`, on the same slot layout as the CPU engine (a slot is `SLOT_PLANES` planes of 258 × 258
 * f32 at a float offset), so CPU state uploads as it is.
 *
 * The GPU does not give the CPU's bits: shader compilers may fuse multiply-adds and use their own
 * `exp` / `pow`, and two browsers on one GPU already differ. It stays within about 1/255 of the CPU
 * in the shaded pixels, which is what a display needs. Nothing saved is computed here.
 */

import { DRY_EPS, P_D0, P_EDGE, P_FX, P_FY, P_H, P_P0, P_RHO, P_SW, P_UX, P_UY, PARAM, PARAM_FLOATS, PLANE, SET_PLANES, SLOT_SIDE, STRIP, U_MAX } from './model';
import { HIDE } from './film';

/** Words per job record: slot base (float offset), lane, the 8 neighbour bases, tile width and height, base tile index. */
export const GPU_JOB_WORDS = 16;
/** `0xffffffff`: no neighbour / no base tile. */
export const GPU_NONE = 0xffffffff;
/** Neighbour order in a job record. */
export const GPU_NB = ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'] as const;

const common = /* wgsl */ `
const S: u32 = ${SLOT_SIDE}u;
const PL: u32 = ${PLANE}u;
const SETP: u32 = ${SET_PLANES}u;
const NONE: u32 = 0xffffffffu;
struct Job {
  base: u32,
  lane: u32,
  nb: array<u32, 8>,
  w: u32,
  h: u32,
  src: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};
struct Uni {
  parity: u32,
  mode: u32,
  paper: u32,
  pad: u32,
};
`;

const NBO = [0, -1, -SLOT_SIDE, 1, SLOT_SIDE, -SLOT_SIDE - 1, -SLOT_SIDE + 1, SLOT_SIDE + 1, SLOT_SIDE - 1];
const OPPK = [0, 3, 4, 1, 2, 7, 8, 5, 6];
const off = (o: number) => (o < 0 ? `c - ${-o}u` : `c + ${o}u`);

/** Streaming, unrolled (dynamic indexing of private arrays is slow on GPUs). */
function stream(): string {
  let out = '';
  for (let k = 1; k <= 8; k++) {
    const n = off(NBO[k]);
    out += `
  let hn${k} = st[hP + ${n}];
  let rn${k} = st[rhoS + ${n}];
  let dampN${k} = max(0.0, 1.0 - st[swS + ${n}] * invCap);
  if (rn${k} < EPS && !(hn${k} < 0.0)) { dryNb = dryNb + dampN${k}; }
  var b${k} = max(kx, blockScale * hn${k});
  if (hn${k} < 0.0 || xWall || (rxDry && rn${k} < pinX) || (rn${k} < EPS && rx < (pinT + rough * hn${k}) * dampN${k})) { b${k} = 1.0; }
  let f${k} = (1.0 - b${k}) * st[src + ${k}u * PL + ${n}] + b${k} * st[src + ${OPPK[k]}u * PL + c];`;
  }
  return out;
}

/** Collision, unrolled. */
function collide(): string {
  const eu = ['', 'ux', 'uy', '-ux', '-uy', '(ux + uy)', '(uy - ux)', '-(ux + uy)', '(ux - uy)'];
  let out = '';
  for (let k = 1; k <= 8; k++) {
    out += `
  { let eu = ${eu[k]}; let feq = ${k < 5 ? 'wr1' : 'wr2'} * (1.0 + 3.0 * eu + 4.5 * eu * eu - usq); st[dst + ${k}u * PL + c] = (f${k} + omega * (feq - f${k})) * scale; }`;
  }
  return out;
}

/** Pigment faces (east, west, south, north), unrolled. */
function faces(): string {
  const nbs = ['c + 1u', 'c - 1u', 'c + S', 'c - S'];
  let out = '';
  nbs.forEach((nb, face) => {
    const outF = face === 0 || face === 2;
    const uf = face < 2 ? `mobility * (uxc + st[uxS + ${nb}])` : `mobility * (uyc + st[uyS + ${nb}])`;
    out += `
  {
    let nb = ${nb};
    let uf = ${uf};
    let pn = vec4<f32>(st[pS + nb], st[pS + PL + nb], st[pS + 2u * PL + nb], st[pS + 3u * PL + nb]);
    let flux = ${outF ? 'select(uf * pn, uf * pc, uf > 0.0)' : 'select(uf * pc, uf * pn, uf > 0.0)'};
    let v = pNew ${outF ? '-' : '+'} flux + bleed * (pn - pc);
    if (rxWet && st[rhoS + nb] >= EPS) { pNew = v; }
  }`;
  });
  return out;
}

/** One step of every job's tile: `dispatchWorkgroups(16, 16, jobs)`. */
export const WGSL_STEP = /* wgsl */ `${common}
@group(0) @binding(0) var<storage, read_write> st: array<f32>;
@group(0) @binding(1) var<storage, read> prm: array<f32>;
@group(0) @binding(2) var<storage, read> jobs: array<Job>;
@group(0) @binding(3) var<storage, read_write> flags: array<atomic<u32>>;
@group(0) @binding(4) var<uniform> u: Uni;
var<workgroup> wflags: atomic<u32>;

const EPS: f32 = ${DRY_EPS};
const UMAX: f32 = ${U_MAX};
const W0: f32 = ${4 / 9};
const W1: f32 = ${1 / 9};
const W2: f32 = ${1 / 36};
const TINY: f32 = 1e-9;
const DECAY: f32 = 0.99;
const STRIP: u32 = ${STRIP}u;

fn P(i: u32, lane: u32) -> f32 { return prm[lane * ${PARAM_FLOATS}u + i]; }

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&wflags, 0u); }
  workgroupBarrier();
  let job = jobs[gid.z];
  let x = gid.x + 1u;
  let y = gid.y + 1u;
  let c = y * S + x;
  let base = job.base;
  let src = base + u.parity * SETP * PL;
  let dst = base + (1u - u.parity) * SETP * PL;
  let hP = base + ${P_H}u * PL;
  let dP = base + ${P_D0}u * PL;
  let rhoS = src + ${P_RHO}u * PL;
  let swS = src + ${P_SW}u * PL;
  let uxS = src + ${P_UX}u * PL;
  let uyS = src + ${P_UY}u * PL;
  let pS = src + ${P_P0}u * PL;
  let eS = src + ${P_EDGE}u * PL;
  let L = job.lane;
  let omega = P(${PARAM.omega}u, L);
  let tau = P(${PARAM.tau}u, L);
  let evap = P(${PARAM.evap}u, L);
  let edgeEvap = P(${PARAM.edgeEvap}u, L);
  let mobility = P(${PARAM.mobility}u, L);
  let depRate = P(${PARAM.depRate}u, L);
  let pickup = P(${PARAM.pickup}u, L);
  let absorption = P(${PARAM.absorption}u, L);
  let invCap = P(${PARAM.invCap}u, L);
  let blockScale = P(${PARAM.blockScale}u, L);
  let rough = P(${PARAM.rough}u, L);
  let pinT = P(${PARAM.pinT}u, L);
  let flowK = P(${PARAM.flowK}u, L);
  let gran = P(${PARAM.granulation}u, L);
  let edgeDep = P(${PARAM.edgeDep}u, L);
  let bloom = P(${PARAM.bloom}u, L);
  let paperEvap = P(${PARAM.paperEvap}u, L);
  let hasFlow = P(${PARAM.hasFlow}u, L) != 0.0;
  let bleed = P(${PARAM.bleed}u, L);

  let hx = st[hP + c];
  let kx = blockScale * hx;
  let rx = st[rhoS + c];
  let sx = st[swS + c];
  let damp = max(0.0, 1.0 - sx * invCap);
  let pinX = (pinT + rough * hx) * damp;
  let rxDry = rx < EPS;
  let xWall = hx < 0.0;

  // 1. streaming with partial bounce-back and pinning (n = x − e_k)
  var dryNb = 0.0;
  let f0 = st[src + c];
${stream()}
  // 2. depth, velocity, forcing
  let rho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
  let mx = f1 - f3 + f5 - f6 - f7 + f8;
  let my = f2 - f4 + f5 + f6 - f7 - f8;
  var gx = P(${PARAM.gx}u, L);
  var gy = P(${PARAM.gy}u, L);
  if (hasFlow) {
    gx = gx + flowK * st[base + ${P_FX}u * PL + c];
    gy = gy + flowK * st[base + ${P_FY}u * PL + c];
  }
  var ux = 0.0;
  var uy = 0.0;
  if (rho > EPS) {
    ux = mx / rho + tau * gx;
    uy = my / rho + tau * gy;
  }
  let sp2 = ux * ux + uy * uy;
  if (sp2 > UMAX * UMAX) {
    let sc = UMAX / sqrt(sp2);
    ux = ux * sc;
    uy = uy * sc;
  }

  // 3. absorption and evaporation
  let absorbed = min(rho, absorption * (1.0 - 0.5 * hx) * rho * damp);
  let ex = st[eS + c];
  var ev = 0.0;
  if (rho > 0.0) { ev = evap * (1.0 + edgeEvap * ex); }
  let rhoNew = max(0.0, rho - absorbed - ev);
  var scale = 0.0;
  if (rho > TINY) { scale = rhoNew / rho; }
  var sEv = 0.0;
  if (sx > 0.0) { sEv = paperEvap; }
  let sNew = max(0.0, sx + absorbed - sEv);
  st[dst + ${P_SW}u * PL + c] = sNew;

  // 4. collision, then scale
  let usq = 1.5 * (ux * ux + uy * uy);
  let wr0 = W0 * rho;
  let wr1 = W1 * rho;
  let wr2 = W2 * rho;
  st[dst + c] = (f0 + omega * (wr0 * (1.0 - usq) - f0)) * scale;
${collide()}

  // 5. pigment: upwind advection with the last step's velocities, plus bleed
  let rxWet = !rxDry;
  let uxc = st[uxS + c];
  let uyc = st[uyS + c];
  var pNew = vec4<f32>(st[pS + c], st[pS + PL + c], st[pS + 2u * PL + c], st[pS + 3u * PL + c]);
  let pc = pNew;
${faces()}

  // 6. deposition and pickup
  let dryNow = rhoNew < EPS;
  let rate = depRate * (1.0 + gran * (1.0 - hx)) * (1.0 + edgeDep * ex);
  var lift = 0.0;
  if (!dryNow) { lift = pickup * min(rhoNew, 1.0) * (1.0 + bloom * max(0.0, rhoNew - rx)); }
  for (var q = 0u; q < 4u; q++) {
    let pq = max(0.0, pNew[q]);
    let dq = st[dP + q * PL + c];
    var dep = min(pq, pq * rate);
    if (dryNow) { dep = pq; }
    let lq = dq * lift;
    st[dst + (${P_P0}u + q) * PL + c] = pq - dep + lq;
    st[dP + q * PL + c] = dq + dep - lq;
  }
  let mean4 = (st[eS + c + 1u] + st[eS + c - 1u] + st[eS + c + S] + st[eS + c - S]) * 0.25;
  let eNew = min(1.0, max(min(1.0, dryNb * 0.25), DECAY * mean4));
  st[dst + ${P_EDGE}u * PL + c] = select(eNew, 0.0, dryNow);
  st[dst + ${P_RHO}u * PL + c] = rhoNew;
  st[dst + ${P_UX}u * PL + c] = select(ux, 0.0, dryNow);
  st[dst + ${P_UY}u * PL + c] = select(uy, 0.0, dryNow);
  var fl = 0u;
  if (rhoNew > 0.0 || sNew > 0.0) {
    fl = 1u;
    let lx = gid.x;
    let ly = gid.y;
    if (lx < STRIP) { fl = fl | 2u; }
    if (lx >= 256u - STRIP) { fl = fl | 4u; }
    if (ly < STRIP) { fl = fl | 8u; }
    if (ly >= 256u - STRIP) { fl = fl | 16u; }
  }
  if (!dryNow) { fl = fl | 32u; }
  if (fl != 0u) { atomicOr(&wflags, fl); }
  workgroupBarrier();
  if (li == 0u) {
    let wf = atomicLoad(&wflags);
    if (wf != 0u) { atomicOr(&flags[gid.z], wf); }
  }
}
`;

/**
 * Fills each job's halo in set `parity` (the set just written) from its neighbours, as
 * `WetWorld.haloTs` does: `dispatchWorkgroups(17, SET_PLANES, jobs)`. A missing neighbour leaves
 * the halo as it is.
 */
export const WGSL_HALO = /* wgsl */ `${common}
@group(0) @binding(0) var<storage, read_write> st: array<f32>;
@group(0) @binding(2) var<storage, read> jobs: array<Job>;
@group(0) @binding(4) var<uniform> u: Uni;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= 4u * S) { return; }
  let job = jobs[gid.z];
  let side = i / S;
  let j = i % S;
  let off = u.parity * SETP * PL + gid.y * PL;
  var srcSlot = NONE;
  var fc = 0u;
  var tc = 0u;
  if (side == 0u) {
    tc = j;
    if (j == 0u) { srcSlot = job.nb[4]; fc = 256u * S + 256u; }
    else if (j == S - 1u) { srcSlot = job.nb[5]; fc = 256u * S + 1u; }
    else { srcSlot = job.nb[0]; fc = 256u * S + j; }
  } else if (side == 1u) {
    tc = (S - 1u) * S + j;
    if (j == 0u) { srcSlot = job.nb[6]; fc = S + 256u; }
    else if (j == S - 1u) { srcSlot = job.nb[7]; fc = S + 1u; }
    else { srcSlot = job.nb[1]; fc = S + j; }
  } else if (side == 2u) {
    if (j == 0u || j == S - 1u) { return; }
    tc = j * S;
    srcSlot = job.nb[2];
    fc = j * S + 256u;
  } else {
    if (j == 0u || j == S - 1u) { return; }
    tc = j * S + S - 1u;
    srcSlot = job.nb[3];
    fc = j * S + 1u;
  }
  if (srcSlot == NONE) { return; }
  st[job.base + off + tc] = st[srcSlot + off + fc];
}
`;

/**
 * Shades each job's tile for display over its base tile (or transparent), as `film.ts`'s
 * `shadeTile` does in 'display' mode (mode 0) or 'bake-all' (mode 1, a preview of drying):
 * `dispatchWorkgroups(16, 16, jobs)`. Writes RGBA8 (packed little-endian u32) per pixel.
 */
export const WGSL_SHADE = /* wgsl */ `${common}
@group(0) @binding(0) var<storage, read> st: array<f32>;
@group(0) @binding(1) var<storage, read> srcTiles: array<u32>;
@group(0) @binding(2) var<storage, read> jobs: array<Job>;
@group(0) @binding(3) var<storage, read_write> outTiles: array<u32>;
@group(0) @binding(4) var<uniform> u: Uni;

const HIDE: f32 = ${HIDE};

fn toLinear(v: f32) -> f32 {
  let x = clamp(v / 255.0, 0.0, 1.0);
  return select(pow((x + 0.055) / 1.055, 2.4), x / 12.92, x <= 0.04045);
}
fn toByte(v: f32) -> f32 {
  let x = clamp(v, 0.0, 1.0);
  let e = select(1.055 * pow(x, 1.0 / 2.4) - 0.055, 12.92 * x, x <= 0.0031308);
  return clamp(round(e * 255.0), 0.0, 255.0);
}
fn rinf(ks: f32) -> f32 { return 1.0 + ks - sqrt(ks * ks + 2.0 * ks); }
fn needAlpha(e: f32, p: f32, a: f32) -> f32 {
  if (e < p) { return max(a, 1.0 - e / p); }
  if (e > p) { return max(a, (e - p) / (255.0 - p)); }
  return a;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let job = jobs[gid.z];
  let x = gid.x;
  let y = gid.y;
  let o = gid.z * 65536u + y * 256u + x;
  var px = 0u;
  if (job.src != NONE) { px = srcTiles[job.src * 65536u + y * 256u + x]; }
  if (x >= job.w || y >= job.h) { outTiles[o] = px; return; }
  let c = (y + 1u) * S + x + 1u;
  let cur = job.base + u.parity * SETP * PL;
  let d = job.base + ${P_D0}u * PL;
  let p = cur + ${P_P0}u * PL;
  var k = vec4<f32>(st[d + c], st[d + PL + c], st[d + 2u * PL + c], st[d + 3u * PL + c]);
  k = k + vec4<f32>(st[p + c], st[p + PL + c], st[p + 2u * PL + c], st[p + 3u * PL + c]);
  var wet = 0.0;
  if (u.mode == 0u) { wet = min(1.0, st[cur + ${P_RHO}u * PL + c] * 4.0 + st[cur + ${P_SW}u * PL + c]); }
  if (!(k.x > 1e-7 || k.y > 1e-7 || k.z > 1e-7 || k.w > 1e-7) && wet <= 0.0) { outTiles[o] = px; return; }
  let paper = vec3<f32>(f32(u.paper & 255u), f32((u.paper >> 8u) & 255u), f32((u.paper >> 16u) & 255u));
  let pr = vec4<f32>(f32(px & 255u), f32((px >> 8u) & 255u), f32((px >> 16u) & 255u), f32(px >> 24u));
  let a = pr.w / 255.0;
  let below = vec3<f32>(toLinear(a * pr.x + (1.0 - a) * paper.x), toLinear(a * pr.y + (1.0 - a) * paper.y), toLinear(a * pr.z + (1.0 - a) * paper.z));
  let s = k.w;
  var hide = 0.0;
  if (s > 0.0) { hide = 1.0 - exp(-HIDE * s); }
  let keep = 1.0 - hide;
  var inv = 0.0;
  if (s > 1e-9) { inv = 1.0 / s; }
  var film = keep * exp(-2.0 * k.xyz) * below;
  if (hide > 0.0) { film = film + hide * vec3<f32>(rinf(k.x * inv), rinf(k.y * inv), rinf(k.z * inv)); }
  let dark = 1.0 - 0.07 * wet;
  let e = vec3<f32>(toByte(film.x * dark), toByte(film.y * dark), toByte(film.z * dark));
  var alpha = a;
  alpha = needAlpha(e.x, paper.x, alpha);
  alpha = needAlpha(e.y, paper.y, alpha);
  alpha = needAlpha(e.z, paper.z, alpha);
  if (alpha <= 0.0) { outTiles[o] = px & 0x00ffffffu; return; }
  let a8 = max(round(min(1.0, alpha) * 255.0), pr.w);
  let al = a8 / 255.0;
  let kk = 1.0 - al;
  let rgb = clamp(round((e - kk * paper) / al), vec3<f32>(0.0), vec3<f32>(255.0));
  outTiles[o] = u32(rgb.x) | (u32(rgb.y) << 8u) | (u32(rgb.z) << 16u) | (u32(a8) << 24u);
}
`;
