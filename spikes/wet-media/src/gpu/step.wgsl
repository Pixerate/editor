// WGSL port of `stepTile` in src/ts-sim.ts. One invocation per cell; workgroups of 16x16,
// dispatched as (16, 16, activeTiles) so only wet tiles run. State is dense over the canvas.

struct Params {
  omega: f32, tau: f32, evap: f32, edgeEvap: f32,
  mobility: f32, depRate: f32, pickup: f32, absorption: f32,
  invCap: f32, blockScale: f32, rough: f32, pinT: f32,
  gx: f32, gy: f32, flowK: f32, _pad: f32,
  width: u32, height: u32, tilesX: u32, hasFlow: u32,
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> fs: array<f32>;
@group(0) @binding(2) var<storage, read_write> fd: array<f32>;
@group(0) @binding(3) var<storage, read> ms: array<vec4<f32>>;      // rho, ux, uy, p
@group(0) @binding(4) var<storage, read_write> md: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> ds: array<vec2<f32>>; // deposit, paper water
@group(0) @binding(6) var<storage, read> paper: array<f32>;
@group(0) @binding(7) var<storage, read> flow: array<vec2<f32>>;
@group(0) @binding(8) var<storage, read_write> flags: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read> tiles: array<u32>;

const DRY_EPS: f32 = 1e-3;
const U_MAX: f32 = 0.25;
const STRIP: u32 = 64u;
const EX = array<i32, 9>(0, 1, 0, -1, 0, 1, -1, -1, 1);
const EY = array<i32, 9>(0, 0, 1, 0, -1, 1, 1, -1, -1);
const OPP = array<u32, 9>(0u, 3u, 4u, 1u, 2u, 7u, 8u, 5u, 6u);
const WT = array<f32, 9>(4.0 / 9.0, 1.0 / 9.0, 1.0 / 9.0, 1.0 / 9.0, 1.0 / 9.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0);

var<workgroup> wgFlags: atomic<u32>;

@compute @workgroup_size(16, 16)
fn step(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>,
        @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&wgFlags, 0u); }
  workgroupBarrier();

  let tile = tiles[wid.z];
  let tx = tile % P.tilesX;
  let ty = tile / P.tilesX;
  let lx = wid.x * 16u + lid.x;
  let ly = wid.y * 16u + lid.y;
  let x = i32(tx * 256u + lx);
  let y = i32(ty * 256u + ly);
  let W = i32(P.width);
  let H = i32(P.height);
  let n = u32(W * H);
  let i = u32(y * W + x);

  let hx = paper[i];
  let kx = P.blockScale * hx;
  let mx0 = ms[i];
  let rx = mx0.x;
  let pinX = P.pinT + P.rough * hx;

  // 1. streaming with partial bounce-back and pinning
  var fin: array<f32, 9>;
  fin[0] = fs[i];
  var dryNb = 0.0;
  for (var k = 1u; k < 9u; k++) {
    let nx = x - EX[k];
    let ny = y - EY[k];
    let bounce = fs[OPP[k] * n + i];
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) {
      fin[k] = bounce;
      continue;
    }
    let j = u32(ny * W + nx);
    let hn = paper[j];
    let rn = ms[j].x;
    if (rn < DRY_EPS) { dryNb += 1.0; }
    var b = max(kx, P.blockScale * hn);
    if ((rx < DRY_EPS && rn < pinX) || (rn < DRY_EPS && rx < P.pinT + P.rough * hn)) { b = 1.0; }
    fin[k] = (1.0 - b) * fs[k * n + j] + b * bounce;
  }

  // 2. moments + forcing
  var rho = 0.0;
  var mx = 0.0;
  var my = 0.0;
  for (var k = 0u; k < 9u; k++) {
    rho += fin[k];
    mx += fin[k] * f32(EX[k]);
    my += fin[k] * f32(EY[k]);
  }
  var ux = 0.0;
  var uy = 0.0;
  if (rho > DRY_EPS) {
    var g = vec2<f32>(P.gx, P.gy);
    if (P.hasFlow != 0u) { g += P.flowK * flow[i]; }
    ux = mx / rho + P.tau * g.x;
    uy = my / rho + P.tau * g.y;
    let sp2 = ux * ux + uy * uy;
    if (sp2 > U_MAX * U_MAX) {
      let sc = U_MAX / sqrt(sp2);
      ux *= sc;
      uy *= sc;
    }
  }

  // 4. absorption + evaporation
  let dsx = ds[i];
  let sx = dsx.y;
  let absorbed = min(rho, P.absorption * (1.0 - 0.5 * hx) * rho * max(0.0, 1.0 - sx * P.invCap));
  var ev = 0.0;
  if (rho > 0.0) { ev = P.evap * (1.0 + P.edgeEvap * dryNb * 0.125); }
  let rhoNew = max(0.0, rho - absorbed - ev);
  var scale = 0.0;
  if (rho > 1e-9) { scale = rhoNew / rho; }
  var sEv = 0.0;
  if (sx > 0.0) { sEv = P.evap * 0.5; }
  let sNew = max(0.0, sx + absorbed - sEv);

  // 3. collision, then scale
  let usq = 1.5 * (ux * ux + uy * uy);
  for (var k = 0u; k < 9u; k++) {
    let eu = f32(EX[k]) * ux + f32(EY[k]) * uy;
    let feq = WT[k] * rho * (1.0 + 3.0 * eu + 4.5 * eu * eu - usq);
    fd[k * n + i] = (fin[k] + P.omega * (feq - fin[k])) * scale;
  }

  // 5. pigment upwind advection with last step's velocities
  let pc = mx0.w;
  var pNew = pc;
  if (rx >= DRY_EPS) {
    let m = P.mobility * 0.5;
    if (x + 1 < W) {
      let e = ms[i + 1u];
      if (e.x >= DRY_EPS) { let uf = m * (mx0.y + e.y); pNew -= select(uf * e.w, uf * pc, uf > 0.0); }
    }
    if (x > 0) {
      let w = ms[i - 1u];
      if (w.x >= DRY_EPS) { let uf = m * (w.y + mx0.y); pNew += select(uf * pc, uf * w.w, uf > 0.0); }
    }
    if (y + 1 < H) {
      let s = ms[i + u32(W)];
      if (s.x >= DRY_EPS) { let uf = m * (mx0.z + s.z); pNew -= select(uf * s.w, uf * pc, uf > 0.0); }
    }
    if (y > 0) {
      let t = ms[i - u32(W)];
      if (t.x >= DRY_EPS) { let uf = m * (t.z + mx0.z); pNew += select(uf * pc, uf * t.w, uf > 0.0); }
    }
  }

  // 6. deposition and pickup
  let dx = dsx.x;
  var dep = pNew;
  var lift = 0.0;
  if (rhoNew >= DRY_EPS) {
    dep = min(pNew, pNew * P.depRate * (1.0 + P.rough * (1.0 - hx)));
    lift = dx * P.pickup * min(rhoNew, 1.0);
  }
  let wet = rhoNew >= DRY_EPS;
  md[i] = vec4<f32>(rhoNew, select(0.0, ux, wet), select(0.0, uy, wet), pNew - dep + lift);
  ds[i] = vec2<f32>(dx + dep - lift, sNew);

  if (wet) {
    var bits = 1u;
    if (lx < STRIP) { bits |= 2u; }
    if (lx >= 256u - STRIP) { bits |= 4u; }
    if (ly < STRIP) { bits |= 8u; }
    if (ly >= 256u - STRIP) { bits |= 16u; }
    atomicOr(&wgFlags, bits);
  }
  workgroupBarrier();
  if (li == 0u) {
    let f = atomicLoad(&wgFlags);
    if (f != 0u) { atomicOr(&flags[tile], f); }
  }
}
