// Dab / wash kernel for the WebGPU path.

struct Edit {
  x0: i32, y0: i32, x1: i32, y1: i32,   // inclusive cell rect
  cx: f32, cy: f32, radius: f32, wetness: f32,
  concentration: f32, mode: u32, width: u32, height: u32, // mode 0 = dab, 1 = wash
};

@group(0) @binding(0) var<uniform> E: Edit;
@group(0) @binding(1) var<storage, read_write> f: array<f32>;
@group(0) @binding(2) var<storage, read_write> m: array<vec4<f32>>;

const WT = array<f32, 9>(4.0 / 9.0, 1.0 / 9.0, 1.0 / 9.0, 1.0 / 9.0, 1.0 / 9.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0);

@compute @workgroup_size(16, 16)
fn edit(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = E.x0 + i32(gid.x);
  let y = E.y0 + i32(gid.y);
  if (x > E.x1 || y > E.y1 || x < 0 || y < 0 || x >= i32(E.width) || y >= i32(E.height)) { return; }
  var a = 1.0;
  if (E.mode == 0u) {
    let dx = f32(x) + 0.5 - E.cx;
    let dy = f32(y) + 0.5 - E.cy;
    let q = (dx * dx + dy * dy) / (E.radius * E.radius);
    if (q >= 1.0) { return; }
    a = (1.0 - q) * (1.0 - q);
  }
  let n = E.width * E.height;
  let i = u32(y) * E.width + u32(x);
  let dw = E.wetness * a;
  for (var k = 0u; k < 9u; k++) { f[k * n + i] += WT[k] * dw; }
  var v = m[i];
  v.x += dw;
  v.w += E.concentration * dw;
  m[i] = v;
}

