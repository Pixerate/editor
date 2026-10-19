// Display kernel for the WebGPU path: same shading as shade() in src/model.ts.

struct View {
  x0: u32, y0: u32, width: u32, height: u32,
};
@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var<storage, read> mv: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> dsv: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read> paperv: array<f32>;
@group(0) @binding(4) var out: texture_storage_2d<rgba8unorm, write>;

const K = vec3<f32>(2.2, 1.4, 0.35);

@compute @workgroup_size(16, 16)
fn display(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = V.x0 + gid.x;
  let y = V.y0 + gid.y;
  if (x >= V.width || y >= V.height) { return; }
  let i = y * V.width + x;
  let s = mv[i];
  let h = paperv[i];
  let paperTone = 0.93 + 0.07 * h;
  let wet = 1.0 - 0.06 * min(s.x * 4.0, 1.0);
  let c = dsv[i].x + s.w;
  let rgb = paperTone * wet * exp(-K * c);
  textureStore(out, vec2<u32>(x, y), vec4<f32>(rgb, 1.0));
}
