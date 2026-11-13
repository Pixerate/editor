/**
 * Pixel expressions as GLSL ES 3.0 (WebGL2): a fragment shader generated from a checked
 * `PixelProgram`, the TypeScript twin of Swift's `PixelMSL.swift`. `pixel-webgl.ts` compiles it
 * and reads the pixels back, for live view frames only (documents, exports and replays stay on the
 * CPU evaluator, the reference).
 *
 * The shader is straight-line code (the language has no loops), so its run time per pixel is
 * bounded by the program's `cost`. Every function has the CPU evaluator's semantics, worked out one
 * component at a time with scalars broadcast explicitly: GLSL `mod`, `sqrt` of a negative is 0,
 * `select` on > 0.5, comparisons give 0 or 1, `min` / `max` keep NaN, `normalize` of 0 is 0, `pow`,
 * `log`, `asin` / `acos` and `atan(y, x)` where GLSL leaves the result undefined, and the same
 * 32-bit `hash`. The output bytes use the same rounding (NaN → 0). The GPU computes in `float`
 * rather than `double`, so pixels match the CPU's within a level or two, not bit for bit.
 *
 * Uniforms: `px_u` is a `vec4` array holding `[width, height, time (s), 0, controls…]` packed four
 * to a vec4, each control's numbers in declaration order (a colour 3, a vec2 2, a number or bool 1;
 * see `controlOffsets`). A program that calls `sample` (a filter) also takes the source's width and
 * height after the controls (`sourceSizeOffset`) and the picture as `px_src`, an RGBA8UI texture
 * (`usampler2D`) row by row from the top; `px_sample` reads it with `pixelSample`'s arithmetic (four
 * `texelFetch` reads, colour weighted by alpha, clamp to edge), not a hardware sampler, so it
 * filters exactly as the CPU does. `pos` is `gl_FragCoord.xy` (pixel centres); framebuffer row `r`
 * holds picture row `r` from the top, so `readPixels` returns rows in the picture's order with no
 * flip. Generated names never collide with GLSL keywords: controls are `c<i>`, lets `l<i>`,
 * temporaries `t<i>` and built-ins `b_<name>`.
 */

import {
  PIXEL_BUILTINS,
  pixelControlNumbers,
  pixelProgramSamples,
  type PixelExpr,
  type PixelProgram,
} from "./pixel-language.js";
import type { EffectValues } from "./types.js";

/** Generated GLSL for a program. */
export interface PixelGLSLSource {
  /** The vertex shader: one triangle that covers the frame (no attributes). */
  vertex: string;
  /** The fragment shader. */
  fragment: string;
  /** Floats in the uniforms (4 + the controls' numbers, + 2 for a filter's source size). */
  uniformCount: number;
  /** Where each control's numbers start in the uniforms, in `program.controls` order. */
  controlOffsets: number[];
  /** For a program that calls `sample`: where the source's width and height are (null otherwise). */
  sourceSizeOffset: number | null;
}

/** The uniform array (`vec4 px_u[…]`). */
export const PIXEL_GLSL_UNIFORMS = "px_u";
/** The source picture of a filter (`usampler2D`). */
export const PIXEL_GLSL_SOURCE = "px_src";

const VERTEX = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const PRELUDE = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

out vec4 px_out;

float px_nan() { return uintBitsToFloat(0x7fc00000u); }
float px_inf() { return uintBitsToFloat(0x7f800000u); }
bool px_isnan(float x) { return (floatBitsToUint(x) & 0x7fffffffu) > 0x7f800000u; }
bool px_negative(float x) { return (floatBitsToUint(x) >> 31) != 0u; }
float px_sin(float x) { return sin(x); }
float px_cos(float x) { return cos(x); }
float px_tan(float x) { return tan(x); }
float px_asin(float x) { return abs(x) > 1.0 ? px_nan() : asin(x); }
float px_acos(float x) { return abs(x) > 1.0 ? px_nan() : acos(x); }
float px_atan(float x) { return atan(x); }
float px_atan2(float y, float x) {
    if (px_isnan(x) || px_isnan(y)) return px_nan();
    if (x == 0.0 && y == 0.0) return px_negative(x) ? (px_negative(y) ? -3.1415927 : 3.1415927) : y;
    return atan(y, x);
}
float px_sqrt(float x) { return x > 0.0 ? sqrt(x) : 0.0; }
float px_exp(float x) { return exp(x); }
float px_log(float x) { return px_isnan(x) || x < 0.0 ? px_nan() : (x == 0.0 ? -px_inf() : log(x)); }
float px_abs(float x) { return abs(x); }
float px_sign(float x) { return x > 0.0 ? 1.0 : (x < 0.0 ? -1.0 : 0.0); }
float px_floor(float x) { return floor(x); }
float px_ceil(float x) { return ceil(x); }
float px_fract(float x) { return x - floor(x); }
float px_pow(float x, float y) {
    if (y == 0.0) return 1.0;
    if (px_isnan(x) || px_isnan(y)) return px_nan();
    if (x == 0.0) return y > 0.0 ? 0.0 : px_inf();
    float r = exp2(y * log2(abs(x)));
    if (x < 0.0) {
        if (floor(y) != y) return px_nan();
        if (y - 2.0 * floor(y / 2.0) == 1.0) r = -r;
    }
    return r;
}
float px_mod(float x, float y) { return x - y * floor(x / y); }
float px_min(float a, float b) { return (px_isnan(a) || px_isnan(b)) ? px_nan() : (a < b ? a : b); }
float px_max(float a, float b) { return (px_isnan(a) || px_isnan(b)) ? px_nan() : (a > b ? a : b); }
float px_step(float edge, float x) { return x < edge ? 0.0 : 1.0; }
float px_clamp(float x, float lo, float hi) { return px_min(px_max(x, lo), hi); }
float px_mix(float a, float b, float t) { return a + (b - a) * t; }
float px_smoothstep(float lo, float hi, float x) {
    float t = px_min(px_max((x - lo) / (hi - lo), 0.0), 1.0);
    return t * t * (3.0 - 2.0 * t);
}
float px_hash(float x, float y) {
    int ix = px_isnan(x) ? 0 : int(floor(clamp(x, -1e9, 1e9)));
    int iy = px_isnan(y) ? 0 : int(floor(clamp(y, -1e9, 1e9)));
    uint h = (uint(ix) * 0x8da6b343u) ^ (uint(iy) * 0xd8163841u);
    h = h ^ (h >> 13);
    h = h * 0x5bd1e995u;
    h = h ^ (h >> 15);
    return float(h) * 2.3283064365386963e-10;
}
float px_noise(float x, float y) {
    float ix = floor(x);
    float iy = floor(y);
    float fx = x - ix;
    float fy = y - iy;
    float ux = fx * fx * (3.0 - 2.0 * fx);
    float uy = fy * fy * (3.0 - 2.0 * fy);
    float a = px_hash(ix, iy);
    float b = px_hash(ix + 1.0, iy);
    float c = px_hash(ix, iy + 1.0);
    float d = px_hash(ix + 1.0, iy + 1.0);
    float top = a + (b - a) * ux;
    float bottom = c + (d - c) * ux;
    return top + (bottom - top) * uy;
}
float px_byte(float v) { return px_isnan(v) ? 0.0 : (v > 0.0 ? (v < 1.0 ? floor(v * 255.0 + 0.5) : 255.0) : 0.0); }
`;

const SAMPLE = `
uniform usampler2D px_src;
vec4 px_sample(float sw, float sh, float x, float y) {
    if (!(sw >= 1.0) || !(sh >= 1.0)) return vec4(0.0);
    float tx = x * sw - 0.5;
    float ty = y * sh - 0.5;
    if (px_isnan(tx) || !(tx > -1.0)) tx = -1.0; else if (tx > sw) tx = sw;
    if (px_isnan(ty) || !(ty > -1.0)) ty = -1.0; else if (ty > sh) ty = sh;
    float fx0 = floor(tx);
    float fy0 = floor(ty);
    float fx = tx - fx0;
    float fy = ty - fy0;
    int w = int(sw);
    int h = int(sh);
    int ix = int(fx0);
    int iy = int(fy0);
    int x0 = clamp(ix, 0, w - 1);
    int x1 = clamp(ix + 1, 0, w - 1);
    int y0 = clamp(iy, 0, h - 1);
    int y1 = clamp(iy + 1, 0, h - 1);
    vec4 c00 = vec4(texelFetch(px_src, ivec2(x0, y0), 0));
    vec4 c10 = vec4(texelFetch(px_src, ivec2(x1, y0), 0));
    vec4 c01 = vec4(texelFetch(px_src, ivec2(x0, y1), 0));
    vec4 c11 = vec4(texelFetch(px_src, ivec2(x1, y1), 0));
    float w00 = (1.0 - fx) * (1.0 - fy) * c00.w;
    float w10 = fx * (1.0 - fy) * c10.w;
    float w01 = (1.0 - fx) * fy * c01.w;
    float w11 = fx * fy * c11.w;
    float a = w00 + w10 + w01 + w11;
    vec3 rgb = a > 0.0 ? (w00 * c00.xyz + w10 * c10.xyz + w01 * c01.xyz + w11 * c11.xyz) / (a * 255.0) : vec3(0.0);
    return vec4(rgb, a / 255.0);
}
`;

const UNARY: Readonly<Record<string, string>> = {
  sin: "px_sin",
  cos: "px_cos",
  tan: "px_tan",
  asin: "px_asin",
  acos: "px_acos",
  atan: "px_atan",
  sqrt: "px_sqrt",
  exp: "px_exp",
  log: "px_log",
  abs: "px_abs",
  sign: "px_sign",
  floor: "px_floor",
  ceil: "px_ceil",
  fract: "px_fract",
};
const BINARY: Readonly<Record<string, string>> = {
  "%": "px_mod",
  mod: "px_mod",
  pow: "px_pow",
  min: "px_min",
  max: "px_max",
  atan: "px_atan2",
  step: "px_step",
};
const TERNARY: Readonly<Record<string, string>> = {
  clamp: "px_clamp",
  mix: "px_mix",
  smoothstep: "px_smoothstep",
};

/** A float literal for GLSL (the value rounded to `float`, as the GPU holds it). */
export function glslFloat(v: number): string {
  const f = Math.fround(v);
  if (Number.isNaN(f)) return "px_nan()";
  if (!Number.isFinite(f)) return f < 0 ? "(-px_inf())" : "px_inf()";
  let s = String(Math.abs(f));
  if (!/[.e]/.test(s)) s += ".0";
  return f < 0 || Object.is(f, -0) ? `(-${s})` : s;
}

const glslType = (n: number) => (n === 1 ? "float" : `vec${n}`);
const COMPONENTS = ["x", "y", "z", "w"];
/** Element `i` of the uniforms. */
const uniform = (i: number) =>
  `${PIXEL_GLSL_UNIFORMS}[${i >> 2}].${COMPONENTS[i & 3]}`;

class GLSLWriter {
  lines: string[] = [];
  names = new Map<string, string>();
  temps = 0;

  /** Component `i` of a value of `size` numbers (a number broadcasts). */
  comp(x: string, size: number, i: number): string {
    return size === 1 ? x : `${x}.${COMPONENTS[i]}`;
  }
  vec(parts: string[]): string {
    return parts.length === 1
      ? parts[0]
      : `${glslType(parts.length)}(${parts.join(", ")})`;
  }
  temp(n: number, expr: string): string {
    const name = `t${this.temps++}`;
    this.lines.push(`    ${glslType(n)} ${name} = ${expr};`);
    return name;
  }
  range(n: number): number[] {
    return Array.from({ length: n }, (_, i) => i);
  }

  emit(e: PixelExpr): string {
    switch (e.k) {
      case "num":
        return this.temp(1, glslFloat(e.v));
      case "const":
        return this.temp(e.size, this.vec(e.v.map(glslFloat)));
      case "var": {
        const name = this.names.get(e.name);
        if (!name) throw new Error(`no GLSL name for ${e.name}`);
        return name;
      }
      case "neg": {
        const a = this.emit(e.a);
        return this.temp(e.size, `-${a}`);
      }
      case "swizzle": {
        const a = this.emit(e.a);
        return this.temp(
          e.comps.length,
          this.vec(e.comps.map((c) => this.comp(a, e.a.size, c))),
        );
      }
      case "bin": {
        const a = this.emit(e.a);
        const b = this.emit(e.b);
        const parts = this.range(e.size).map((i) => {
          const x = this.comp(a, e.a.size, i);
          const y = this.comp(b, e.b.size, i);
          switch (e.op) {
            case "+":
            case "-":
            case "*":
            case "/":
              return `(${x} ${e.op} ${y})`;
            case "%":
              return `px_mod(${x}, ${y})`;
            default:
              return `((${x} ${e.op} ${y}) ? 1.0 : 0.0)`;
          }
        });
        return this.temp(e.size, this.vec(parts));
      }
      case "call":
        return this.call(e.fn, e.args, e.size);
    }
  }

  call(fn: string, args0: readonly PixelExpr[], n: number): string {
    const args = args0.map((a) => this.emit(a));
    const sizes = args0.map((a) => a.size);
    const each = (f: string) =>
      this.temp(
        n,
        this.vec(
          this.range(n).map(
            (i) =>
              `${f}(${args.map((a, k) => this.comp(a, sizes[k], i)).join(", ")})`,
          ),
        ),
      );
    if (args.length === 1 && Object.hasOwn(UNARY, fn)) return each(UNARY[fn]);
    if (Object.hasOwn(BINARY, fn)) return each(BINARY[fn]);
    if (Object.hasOwn(TERNARY, fn)) return each(TERNARY[fn]);
    switch (fn) {
      case "select": {
        const c = args[0];
        return this.temp(
          n,
          this.vec(
            this.range(n).map(
              (i) =>
                `(${c} > 0.5 ? ${this.comp(args[1], sizes[1], i)} : ${this.comp(args[2], sizes[2], i)})`,
            ),
          ),
        );
      }
      case "length": {
        const sum = this.range(sizes[0])
          .map(
            (i) =>
              `${this.comp(args[0], sizes[0], i)} * ${this.comp(args[0], sizes[0], i)}`,
          )
          .join(" + ");
        return this.temp(1, `sqrt(${sum})`);
      }
      case "dot": {
        const m = Math.max(sizes[0], sizes[1]);
        return this.temp(
          1,
          this.range(m)
            .map(
              (i) =>
                `${this.comp(args[0], sizes[0], i)} * ${this.comp(args[1], sizes[1], i)}`,
            )
            .join(" + "),
        );
      }
      case "distance": {
        const m = Math.max(sizes[0], sizes[1]);
        const ds = this.range(m).map((i) =>
          this.temp(
            1,
            `${this.comp(args[0], sizes[0], i)} - ${this.comp(args[1], sizes[1], i)}`,
          ),
        );
        return this.temp(
          1,
          `sqrt(${ds.map((d) => `${d} * ${d}`).join(" + ")})`,
        );
      }
      case "normalize": {
        const a = args[0];
        const len = this.temp(
          1,
          `sqrt(${this.range(n)
            .map((i) => `${this.comp(a, n, i)} * ${this.comp(a, n, i)}`)
            .join(" + ")})`,
        );
        return this.temp(
          n,
          this.vec(
            this.range(n).map(
              (i) => `(${len} > 0.0 ? ${this.comp(a, n, i)} / ${len} : 0.0)`,
            ),
          ),
        );
      }
      case "hash":
      case "noise":
        return this.temp(1, `px_${fn}(${args[0]}.x, ${args[0]}.y)`);
      case "sample":
        return this.temp(
          4,
          `px_sample(b_srcSize.x, b_srcSize.y, ${args[0]}.x, ${args[0]}.y)`,
        );
      case "vec2":
      case "vec3":
      case "vec4": {
        if (args.length === 1 && sizes[0] === 1)
          return this.temp(n, this.vec(Array(n).fill(args[0])));
        const parts: string[] = [];
        args.forEach((a, k) => {
          for (let i = 0; i < sizes[k]; i++)
            parts.push(this.comp(a, sizes[k], i));
        });
        return this.temp(n, this.vec(parts));
      }
      default:
        throw new Error(`no GLSL for ${fn}`);
    }
  }
}

/** The GLSL ES 3.0 shaders for a checked program (`pixel-glsl.ts`). */
export function pixelGLSL(program: PixelProgram): PixelGLSLSource {
  const w = new GLSLWriter();
  const samples = pixelProgramSamples(program);
  for (const name of Object.keys(PIXEL_BUILTINS))
    w.names.set(name, `b_${name}`);
  const body: string[] = [];
  let offset = 4;
  const controlOffsets: number[] = [];
  const decl: string[] = [];
  program.controls.forEach((c, i) => {
    const id = `c${i}`;
    const size = c.type === "color" ? 3 : c.type === "vec2" ? 2 : 1;
    w.names.set(c.name, id);
    controlOffsets.push(offset);
    decl.push(
      `    ${glslType(size)} ${id} = ${w.vec(Array.from({ length: size }, (_, k) => uniform(offset + k)))}; // ${c.name}`,
    );
    offset += size;
  });
  let sourceSizeOffset: number | null = null;
  if (samples) {
    sourceSizeOffset = offset;
    decl.push(
      `    vec2 b_srcSize = vec2(${uniform(offset)}, ${uniform(offset + 1)});`,
    );
    offset += 2;
  }
  const vec4s = Math.max(1, Math.ceil(offset / 4));
  body.push("void main() {");
  body.push(`    vec2 b_size = vec2(${uniform(0)}, ${uniform(1)});`);
  body.push("    vec2 b_pos = gl_FragCoord.xy;");
  body.push("    vec2 b_uv = b_pos / b_size;");
  body.push(`    float b_time = ${uniform(2)};`);
  body.push(`    float b_PI = ${glslFloat(Math.PI)};`);
  body.push(`    float b_TAU = ${glslFloat(Math.PI * 2)};`);
  body.push(...decl);
  program.lets.forEach((l, i) => {
    const v = w.emit(l.expr);
    w.lines.push(`    ${glslType(l.expr.size)} l${i} = ${v}; // ${l.name}`);
    w.names.set(l.name, `l${i}`);
  });
  const o = w.emit(program.out);
  switch (program.out.size) {
    case 1:
      w.lines.push(`    float g = px_byte(${o});`);
      w.lines.push("    px_out = vec4(g, g, g, 255.0) / 255.0;");
      break;
    case 3:
      w.lines.push(
        `    px_out = vec4(px_byte(${o}.x), px_byte(${o}.y), px_byte(${o}.z), 255.0) / 255.0;`,
      );
      break;
    default:
      w.lines.push(
        `    px_out = vec4(px_byte(${o}.x), px_byte(${o}.y), px_byte(${o}.z), px_byte(${o}.w)) / 255.0;`,
      );
  }
  w.lines.push("}");
  const fragment =
    PRELUDE +
    `\nuniform vec4 ${PIXEL_GLSL_UNIFORMS}[${vec4s}];\n` +
    (samples ? SAMPLE : "") +
    "\n" +
    [...body, ...w.lines].join("\n") +
    "\n";
  return {
    vertex: VERTEX,
    fragment,
    uniformCount: offset,
    controlOffsets,
    sourceSizeOffset,
  };
}

/**
 * The uniforms for one frame, packed as `vec4`s: `[width, height, time (s), 0, controls…]`, then
 * the source's size for a filter.
 */
export function pixelGLSLUniforms(
  program: PixelProgram,
  glsl: PixelGLSLSource,
  frame: {
    width: number;
    height: number;
    timeMs: number;
    values: EffectValues;
    sourceWidth?: number;
    sourceHeight?: number;
  },
): Float32Array {
  const u = new Float32Array(Math.max(1, Math.ceil(glsl.uniformCount / 4)) * 4);
  u[0] = frame.width;
  u[1] = frame.height;
  u[2] = frame.timeMs / 1000;
  program.controls.forEach((c, i) => {
    pixelControlNumbers(c, frame.values[c.name]).forEach((v, k) => {
      u[glsl.controlOffsets[i] + k] = v;
    });
  });
  if (glsl.sourceSizeOffset !== null) {
    u[glsl.sourceSizeOffset] = frame.sourceWidth ?? 0;
    u[glsl.sourceSizeOffset + 1] = frame.sourceHeight ?? 0;
  }
  return u;
}
