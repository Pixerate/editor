/**
 * Pixel expressions on the GPU in TypeScript (#753): the GLSL ES 3.0 generator (`pixel-glsl.ts`),
 * the WebGL2 renderer and its CPU fallbacks (`pixel-webgl.ts`), and live frames in the paint editor.
 *
 * Two checks need tools CI doesn't have, and skip cleanly without them:
 * - `glslangValidator` on the PATH compiles every generated shader as GLSL ES 3.00.
 * - `PIXEL_GPU_PLAYWRIGHT` naming a `playwright` or `playwright-core` module (with its Chromium
 *   installed) draws the shaders with real WebGL2 in headless Chromium and compares them with the
 *   CPU evaluator within 2/255, like Swift's Metal tests:
 *     PIXEL_GPU_PLAYWRIGHT=/path/to/node_modules/playwright pnpm vitest run packages/core/tests/pixel-glsl.test.ts
 *   `PIXEL_GPU_ANGLE` picks Chromium's ANGLE backend (default `swiftshader`; `metal` on a Mac uses the GPU).
 */
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  compilePixelSource,
  createPixelEvaluator,
  glslFloat,
  PIXEL_FUNCTIONS,
  PIXEL_GPU_COMPILE_TIMEOUT_MS,
  PIXEL_TEMPLATES,
  pixelDescription,
  pixelGLSL,
  pixelGLSLUniforms,
  PixelWebGL,
  type EffectPixels,
  type PixelProgram,
} from "../src/effects/index.js";
import { PaintEditorController } from "../src/paint-editor/index.js";

/** Reaches every function and built-in (the same program as Swift's `PixelLanguageTests.everyFunction`). */
const EVERY_FUNCTION = `control tint: color = #3366cc // Tint.
control k: number = 0.7 range 0 1 // Amount.
control on: bool = true // On.
control at: vec2 = vec2(0.3, 0.6) // A point.
let q = uv * 0.9 + 0.05
let a = sin(q.x * 3) * 0.25 + cos(q.y * 2) * 0.25 + tan(q.x * 0.5) * 0.1 + asin(q.y * 0.5) * 0.2 + acos(q.x * 0.5) * 0.1
let b = atan(q.y) * 0.3 + atan(q.y, q.x + 0.1) * 0.1 + sqrt(q.x) * 0.2 + sqrt(-q.x) + exp(-q.y) * 0.2 + log(q.x + 1) * 0.3
let c = abs(q.x - 0.5) + sign(q.y - 0.53) * 0.1 + floor(q.x * 3 + 0.01) * 0.1 + ceil(q.y * 2 + 0.01) * 0.1 + fract(q.x * 2.5 + 0.01) * 0.2
let e = pow(q.x, 2) + pow(-0.5, 2) + mod(q.y * 7 + 0.01, 2) * 0.1 + (q.x * 5 + 0.01) % 1.5 * 0.1 + min(q.x, q.y) + max(q.x, q.y) * 0.5
let f = clamp(q.x * 2 - 0.5, 0, 1) * 0.3 + mix(0.1, 0.9, q.y) * 0.3 + step(0.47, q.x) * 0.1 + smoothstep(0.2, 0.8, q.y) * 0.3
let g = select(q.x > 0.47, 0.2, 0.8) + select(on, 0.1, 0.0) + length(q - at) + distance(q, at) * 0.5 + dot(q, at)
let n = normalize(vec3(q, 0.5)) + normalize(vec3(0)) + vec3(hash(pos * 0.25), noise(uv * 5.3), hash(vec2(3.5, -2.5)))
let cmp = (q.x < 0.47) * 0.1 + (q.x <= 0.47) * 0.1 + (q.y > 0.53) * 0.1 + (q.y >= 0.53) * 0.1 + (on == 1) * 0.1 + (on != 1) * 0.1
let v = vec4(vec2(a, b).yx, vec2(c + e * 0.1, f)) * k + vec4(-g * 0.1 + cmp, n.zyx) * 0.5
out = vec4(tint * 0.2 + v.xyz * 0.8 + size.x * 0 + time * 0 + PI * 0 + TAU * 0, v.w + 0.3)`;

/** A filter (Swift's `PixelSampleTests.filter`). */
const FILTER = `control k: number = 1.5 // Reach in pixels.
let c = sample(uv)
let l = sample(uv - vec2(k, 0.25) / size)
let r = sample(uv + vec2(k * 0.7, -0.5) / size)
let far = sample(uv * 3 - 1)
out = vec4(mix(c.rgb, (l.rgb + r.rgb) * 0.5, 0.6) + far.rgb * 0.1, max(c.a, far.a * 0.5))`;

/** NaN, infinities and the edges GLSL leaves undefined, written out by the CPU's rules. */
const EDGES = `let z = uv.x * 0
out = vec4(log(z - 1) + 0.5, sqrt(z - 1) + max(z / z, 0.25), pow(-2, 3) * -0.1 + atan(z, z) + asin(2 + z) + 0.2, clamp(1 / z, 0, 1) * 0.5 + min(log(z - 1), 1))`;

function program(source: string): PixelProgram {
  const r = compilePixelSource(source);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.program;
}

/** A picture with soft alpha edges (Swift's `picture(w, h)`). */
function picture(w: number, h: number): EffectPixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = (i * 53) % 256;
    data[i * 4 + 1] = (i * 97 + 31) % 256;
    data[i * 4 + 2] = (i * 151 + 7) % 256;
    data[i * 4 + 3] = i % 5 === 3 ? 0 : (i * 67 + 40) % 256;
  }
  return { width: w, height: h, data };
}

const SOURCES: Record<string, string> = {
  ...Object.fromEntries(PIXEL_TEMPLATES.map((t) => [t.id, t.source])),
  "every-function": EVERY_FUNCTION,
  filter: FILTER,
  edges: EDGES,
};

describe("pixel expressions as GLSL ES 3.0", () => {
  it("generates straight-line shaders with the uniform layout of the MSL kernel", () => {
    const g = pixelGLSL(program(PIXEL_TEMPLATES[1].source));
    expect(g.fragment.startsWith("#version 300 es\n")).toBe(true);
    expect(g.vertex.startsWith("#version 300 es\n")).toBe(true);
    // No loops or branches of the program's own: the body is one assignment per step.
    expect(g.fragment).not.toMatch(/\b(for|while|do)\b/);
    // pixel.rings: ink (3), count (1), center (2) after [width, height, time, 0].
    expect(g.controlOffsets).toEqual([4, 7, 8]);
    expect(g.uniformCount).toBe(10);
    expect(g.sourceSizeOffset).toBeNull();
    expect(g.fragment).toContain("uniform vec4 px_u[3];");
    expect(g.fragment).toContain("vec3 c0 = vec3(px_u[1].x, px_u[1].y, px_u[1].z); // ink");
    expect(g.fragment).toContain("float c1 = px_u[1].w; // count");
    expect(g.fragment).toContain("vec2 c2 = vec2(px_u[2].x, px_u[2].y); // center");
    expect(g.fragment).toContain("vec2 b_pos = gl_FragCoord.xy;");
    expect(g.fragment).not.toContain("px_sample(");
    expect(g.fragment.split("void main() {")[1]).toMatchSnapshot();
  });

  it("gives a filter its source as an integer texture and its size after the controls", () => {
    const g = pixelGLSL(program(FILTER));
    expect(g.controlOffsets).toEqual([4]);
    expect(g.sourceSizeOffset).toBe(5);
    expect(g.uniformCount).toBe(7);
    expect(g.fragment).toContain("uniform usampler2D px_src;");
    expect(g.fragment).toContain("vec2 b_srcSize = vec2(px_u[1].y, px_u[1].z);");
    expect(g.fragment.match(/px_sample\(b_srcSize\.x, b_srcSize\.y,/g)).toHaveLength(4);
    // Four reads with texelFetch, never a hardware sampler.
    expect(g.fragment.match(/texelFetch\(/g)).toHaveLength(4);
    expect(g.fragment).not.toMatch(/\btexture\(/);
  });

  it("maps every function to a helper with the CPU's semantics", () => {
    const body = pixelGLSL(program(EVERY_FUNCTION)).fragment.split("void main() {")[1];
    for (const f of ["sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sqrt", "exp", "log", "abs", "sign", "floor", "ceil", "fract", "pow", "mod", "min", "max", "clamp", "mix", "step", "smoothstep", "hash", "noise"])
      expect(body, f).toContain(`px_${f}(`);
    // Every function the language has generates (sample in a filter).
    const vectorArg = new Set(["hash", "noise", "length", "normalize", "sample"]);
    for (const [fn, f] of Object.entries(PIXEL_FUNCTIONS)) {
      const args = Array.from({ length: f.min }, () => (vectorArg.has(fn) ? "uv" : "uv.x")).join(", ");
      const call = fn === "normalize" || fn === "sample" || fn.startsWith("vec") ? `${fn}(${args}).x` : `${fn}(${args})`;
      const r = compilePixelSource(`out = vec3(${call})`);
      expect(r.ok, `${fn}: ${JSON.stringify(r.issues)}`).toBe(true);
      if (r.ok) expect(() => pixelGLSL(r.program), fn).not.toThrow();
    }
    // Helpers the body calls are all defined in the prelude.
    const g = pixelGLSL(program(FILTER)).fragment + pixelGLSL(program(EVERY_FUNCTION)).fragment;
    for (const [, name] of g.matchAll(/\b(px_\w+)\(/g)) expect(g, name).toMatch(new RegExp(`(float|vec4|bool) ${name}\\(`));
  });

  it("writes float literals as GLSL holds them", () => {
    expect(glslFloat(1)).toBe("1.0");
    expect(glslFloat(0.5)).toBe("0.5");
    expect(glslFloat(-2)).toBe("(-2.0)");
    expect(glslFloat(-0)).toBe("(-0.0)");
    expect(glslFloat(0.1)).toBe(String(Math.fround(0.1)));
    expect(glslFloat(1e30)).toBe(String(Math.fround(1e30)));
    expect(glslFloat(1e-30)).toMatch(/^\d\.\d+e-30$/);
    expect(glslFloat(NaN)).toBe("px_nan()");
    expect(glslFloat(Infinity)).toBe("px_inf()");
    expect(glslFloat(-1e300)).toBe("(-px_inf())");
  });

  it("packs a frame's uniforms four to a vec4", () => {
    const p = program(FILTER);
    const g = pixelGLSL(p);
    const u = pixelGLSLUniforms(p, g, { width: 37, height: 23, timeMs: 1500, values: { k: 2.25 }, sourceWidth: 9, sourceHeight: 7 });
    expect([...u]).toEqual([37, 23, 1.5, 0, 2.25, 9, 7, 0]);
    const rings = program(PIXEL_TEMPLATES[1].source);
    const ur = pixelGLSLUniforms(rings, pixelGLSL(rings), { width: 2, height: 3, timeMs: 0, values: { ink: "#ff0000", center: [0.25, 0.75] } });
    expect([...ur]).toEqual([2, 3, 0, 0, 1, 0, 0, 12, 0.25, 0.75, 0, 0]);
  });

  const validator = (() => {
    try {
      execFileSync("glslangValidator", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  it.skipIf(!validator)("compiles as GLSL ES 3.00 (glslangValidator)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pixel-glsl-"));
    try {
      for (const [id, source] of Object.entries(SOURCES)) {
        const g = pixelGLSL(program(source));
        for (const [stage, text] of [["frag", g.fragment], ["vert", g.vertex]] as const) {
          const file = path.join(dir, `${id}.${stage}`);
          writeFileSync(file, text);
          let log = "";
          try {
            execFileSync("glslangValidator", [file], { encoding: "utf8" });
          } catch (e) {
            log = String((e as { stdout?: string }).stdout ?? e);
          }
          expect(log, `${id}.${stage}\n${text}`).toBe("");
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fallbacks: a stand-in WebGL2 context records what the renderer asks of it.
// ---------------------------------------------------------------------------

interface FakeGL {
  gl: WebGL2RenderingContext;
  calls: string[];
  lose(): void;
}

function fakeGL(options: { link?: boolean; log?: string; fill?: number[] } = {}): FakeGL {
  const calls: string[] = [];
  let lost = false;
  const listeners: (() => void)[] = [];
  const C = { LINK_STATUS: 0x8b82, FRAMEBUFFER_COMPLETE: 0x8cd5, NO_ERROR: 0, MAX_RENDERBUFFER_SIZE: 0x84e8, MAX_VIEWPORT_DIMS: 0x0d3a, MAX_TEXTURE_SIZE: 0x0d33 };
  const target: Record<string, unknown> = {
    ...C,
    canvas: { addEventListener: (_t: string, f: () => void) => listeners.push(f) },
    isContextLost: () => lost,
    getExtension: () => null,
    getProgramParameter: (_p: unknown, k: number) => (k === C.LINK_STATUS ? options.link !== false : true),
    getParameter: (k: number) => (k === C.MAX_VIEWPORT_DIMS ? new Int32Array([4096, 4096]) : 4096),
    checkFramebufferStatus: () => C.FRAMEBUFFER_COMPLETE,
    getError: () => 0,
    readPixels: (_x: number, _y: number, w: number, h: number, _f: number, _t: number, out: Uint8Array) => {
      calls.push("readPixels");
      const fill = options.fill ?? [255, 0, 255, 255];
      for (let i = 0; i < w * h * 4; i++) out[i] = fill[i % 4];
    },
    // The log belongs to the fragment shader.
    createShader: (type: number) => ({ type }),
    getShaderInfoLog: (s: { type: number }) => (s.type === (gl as unknown as Record<string, number>).FRAGMENT_SHADER ? (options.log ?? "") : ""),
    getProgramInfoLog: () => "",
    getUniformLocation: () => ({}),
    compileShader: () => calls.push("compileShader"),
  };
  let next = 0x9000;
  const gl = new Proxy(target, {
    get: (t, k) => {
      if (k in t) return t[k as string];
      if (typeof k === "string" && /^[A-Z][A-Z0-9_]*$/.test(k)) return (t[k] = next++);
      return () => ({});
    },
  }) as unknown as WebGL2RenderingContext;
  return {
    gl,
    calls,
    lose: () => {
      lost = true;
      for (const f of listeners) f();
    },
  };
}

const describeOf = (p: PixelProgram) => pixelDescription(p, { id: "test", name: "Test" });

describe("PixelWebGL", () => {
  it("has no WebGL2 in Node, and says so instead of drawing", async () => {
    const gpu = new PixelWebGL();
    expect(gpu.available).toBe(false);
    expect(gpu.reason).toMatch(/no WebGL2/);
    const p = program(PIXEL_TEMPLATES[0].source);
    await expect(gpu.createRenderer(p, describeOf(p), { width: 2, height: 2 })).rejects.toMatchObject({
      code: "unsupported",
      message: expect.stringMatching(/^Pixel expressions render on the CPU: this environment has no WebGL2/),
    });
  });

  it("draws a frame with the context it is given and reads it back", async () => {
    const f = fakeGL({ fill: [1, 2, 3, 4] });
    const gpu = new PixelWebGL({ context: () => f.gl });
    expect(gpu.available).toBe(true);
    expect(gpu.reason).toBeNull();
    const p = program(PIXEL_TEMPLATES[0].source);
    const r = await gpu.createRenderer(p, describeOf(p), { width: 2, height: 1 });
    expect([...r.renderSync!({ time: 0 }).data]).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
    // Values are checked as on the CPU.
    expect(() => r.renderSync!({ time: 0, values: { top: 3 } })).toThrow(/Invalid values/);
    // A second renderer for the same source reuses the compiled program.
    await gpu.createRenderer(p, describeOf(p), { width: 3, height: 3 });
    expect(f.calls.filter((c) => c === "compileShader")).toHaveLength(2);
    r.dispose();
    expect(() => r.renderSync!({ time: 0 })).toThrow(/disposed/);
  });

  it("refuses a shader that doesn't compile with the log, and doesn't try it again", async () => {
    const f = fakeGL({ link: false, log: "ERROR: 0:12: 'px_bad' : no matching overloaded function found" });
    const gpu = new PixelWebGL({ context: () => f.gl });
    const p = program(PIXEL_TEMPLATES[0].source);
    const fail = /^The pixel expression shader did not compile for the GPU \(ERROR: 0:12: 'px_bad' : no matching overloaded function found\); it renders on the CPU\.$/;
    await expect(gpu.createRenderer(p, describeOf(p), { width: 2, height: 2 })).rejects.toThrow(fail);
    await expect(gpu.createRenderer(p, describeOf(p), { width: 2, height: 2 })).rejects.toThrow(fail);
    expect(f.calls.filter((c) => c === "compileShader")).toHaveLength(2);
  });

  it("has a compile budget (2 s by default)", async () => {
    expect(PIXEL_GPU_COMPILE_TIMEOUT_MS).toBe(2000);
    let t = 0;
    const gpu = new PixelWebGL({ context: () => fakeGL().gl, now: () => (t += 1500) });
    const p = program(PIXEL_TEMPLATES[0].source);
    await expect(gpu.createRenderer(p, describeOf(p), { width: 2, height: 2 })).resolves.toBeTruthy();
    const q = program(PIXEL_TEMPLATES[1].source);
    await expect(gpu.createRenderer(q, describeOf(q), { width: 2, height: 2, compileTimeoutMs: 1000 })).rejects.toThrow(
      /^The pixel expression shader took longer than 1000 ms to compile for the GPU; it renders on the CPU/,
    );
  });

  it("falls back after context loss, and makes a new context on the next request", async () => {
    const made: FakeGL[] = [];
    const gpu = new PixelWebGL({ context: () => (made.push(fakeGL()), made.at(-1)!.gl) });
    const p = program(PIXEL_TEMPLATES[0].source);
    const r = await gpu.createRenderer(p, describeOf(p), { width: 2, height: 2 });
    made[0].lose();
    expect(() => r.renderSync!({ time: 0 })).toThrow(/^The GPU could not draw "test" \(the WebGL2 context was lost\); it renders on the CPU\.$/);
    // The next request gets a fresh context.
    expect(gpu.available).toBe(true);
    expect(made).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Live frames in the paint editor
// ---------------------------------------------------------------------------

const HARD = { tip: { size: 8, hardness: 1, opacity: 1, flow: 1, spacing: 0.05, pressureOpacity: false, pressureSize: false, smoothing: 0 }, grain: 0 };

async function livePainting(options: ConstructorParameters<typeof PaintEditorController>[0]) {
  const c = new PaintEditorController({ width: 32, height: 16, paper: "smooth", authoredEffects: "author", ...options });
  const session = await c.openEffectAuthoring("pixel.blank");
  await session.setSource!("out = vec3(fract(time), 0, 0)");
  const saved = await c.saveAuthoredEffect({ name: "Pulse" });
  c.addLayer({ type: "strokes" });
  await c.setEffectPaint({ effect: saved.id, live: true });
  c.paintStroke({ brushId: "ink-pen", brush: HARD, points: [{ x: 2, y: 8 }, { x: 30, y: 8 }] });
  return c;
}

const red = (c: PaintEditorController) => c.compositePixels().data[(8 * 32 + 16) * 4];

describe("live frames of authored effects on the GPU", () => {
  it("render on the CPU without WebGL2, with the reason", async () => {
    const c = await livePainting({});
    expect(c.authoredEffectsGPU).toBe(true);
    expect(c.authoredEffectsGPUStatus).toEqual({ gpu: true, renderer: null, reason: null });
    await c.showEffectTime(500);
    expect(c.authoredEffectsGPUStatus).toEqual({ gpu: true, renderer: "cpu", reason: expect.stringMatching(/no WebGL2/) });
    // The same frame as with the GPU off.
    const off = await livePainting({ authoredEffectsGPU: false });
    await off.showEffectTime(500);
    expect(off.authoredEffectsGPUStatus).toEqual({ gpu: false, renderer: "cpu", reason: "authoredEffectsGPU is off" });
    expect(Buffer.from(c.compositePixels().data).equals(Buffer.from(off.compositePixels().data))).toBe(true);
    expect(red(c)).toBeGreaterThan(100);
  });

  it("are drawn by WebGL2 for the view only: the frame is dropped once shown", async () => {
    // A stand-in GPU that draws pure green, so its frames are easy to tell from the CPU's red.
    const c = await livePainting({ authoredEffectsGPU: new PixelWebGL({ context: () => fakeGL({ fill: [0, 255, 0, 255] }).gl }) });
    await c.showEffectTime(500);
    expect(c.authoredEffectsGPUStatus).toEqual({ gpu: true, renderer: "webgl2", reason: null });
    const shown = c.compositePixels().data;
    const at = (8 * 32 + 16) * 4;
    expect([shown[at], shown[at + 1]]).toEqual([0, 255]);
    // An export at the same moment renders on the CPU (the GPU frame is not in the cache).
    const frame = await c.renderAnimationFrame(500);
    expect(frame.data[at]).toBeGreaterThan(100);
    expect(frame.data[at + 1]).toBeLessThan(50);
    // Turned off, live frames render on the CPU again.
    c.authoredEffectsGPU = false;
    await c.showEffectTime(600);
    expect(c.authoredEffectsGPUStatus.renderer).toBe("cpu");
    expect(c.compositePixels().data[at + 1]).toBeLessThan(50);
  });

  it("fall back to the CPU, with the reason, when the shader doesn't compile", async () => {
    const c = await livePainting({ authoredEffectsGPU: new PixelWebGL({ context: () => fakeGL({ link: false, log: "ERROR: too many uniforms" }).gl }) });
    await c.showEffectTime(500);
    expect(c.authoredEffectsGPUStatus).toEqual({
      gpu: true,
      renderer: "cpu",
      reason: "The pixel expression shader did not compile for the GPU (ERROR: too many uniforms); it renders on the CPU.",
    });
    expect(red(c)).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// Real WebGL2 (opt in): GPU frames within 2/255 of the CPU
// ---------------------------------------------------------------------------

const playwrightPath = process.env.PIXEL_GPU_PLAYWRIGHT;

/** `pixel-webgl.ts` and what it imports as one script (with the bundler vitest already has). */
async function bundle(): Promise<string> {
  const fromVitest = createRequire(createRequire(import.meta.url).resolve("vitest/package.json"));
  const fromVite = createRequire(fromVitest.resolve("vite/package.json"));
  const { rolldown } = (await import(fromVite.resolve("rolldown"))) as typeof import("rolldown");
  const b = await rolldown({ input: path.resolve(__dirname, "../src/effects/pixel-webgl.ts"), resolve: { extensionAlias: { ".js": [".ts", ".js"] } } });
  const out = await b.generate({ format: "iife", name: "PixelGPU" });
  return out.output[0].code;
}

describe.skipIf(!playwrightPath)("pixel expressions on real WebGL2 (PIXEL_GPU_PLAYWRIGHT)", () => {
  it("matches the CPU within 2/255", { timeout: 300_000 }, async () => {
    const { chromium } = (await import(playwrightPath!)) as typeof import("playwright-core");
    const angle = process.env.PIXEL_GPU_ANGLE ?? "swiftshader";
    const browser = await chromium.launch({ args: [`--use-angle=${angle}`, "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
    try {
      const page = await browser.newPage();
      await page.addScriptTag({ content: await bundle() });
      const info = await page.evaluate(() => {
        const gl = new OffscreenCanvas(1, 1).getContext("webgl2");
        const ext = gl?.getExtension("WEBGL_debug_renderer_info");
        return gl ? String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null;
      });
      expect(info, "this Chromium has no WebGL2").not.toBeNull();
      console.info(`pixel-glsl: WebGL2 renderer ${info}`);
      const W = 37;
      const H = 23;
      const cases: { id: string; source: string; time: number; values?: Record<string, unknown>; input?: EffectPixels | null }[] = [
        ...PIXEL_TEMPLATES.map((t) => ({ id: t.id, source: t.source, time: 1234 })),
        { id: "every-function", source: EVERY_FUNCTION, time: 1234 },
        { id: "edges", source: EDGES, time: 0 },
        ...[picture(53, 31), picture(9, 7), picture(5, 4), null].map((input) => ({ id: `filter ${input ? `${input.width}×${input.height}` : "none"}`, source: FILTER, time: 0, values: { k: 2.25 }, input })),
      ];
      for (const k of cases) {
        const p = program(k.source);
        const d = pixelDescription(p, { id: k.id, name: k.id });
        const cpu = new Uint8ClampedArray(W * H * 4);
        createPixelEvaluator(p).render(W, H, k.time, { ...d.defaults, ...(k.values ?? {}) }, cpu, k.input ?? null);
        const gpu = await page.evaluate(
          async ({ p, d, W, H, time, values, input }) => {
            const g = new (globalThis as any).PixelGPU.PixelWebGL();
            const r = await g.createRenderer(p, d, { width: W, height: H, compileTimeoutMs: 120_000 });
            const source = input ? { width: input.width, height: input.height, data: new Uint8ClampedArray(input.data) } : undefined;
            const out = r.renderSync({ time, values, ...(source ? { inputs: { source } } : {}) });
            return Array.from(out.data as Uint8ClampedArray);
          },
          { p, d, W, H, time: k.time, values: k.values ?? {}, input: k.input ? { width: k.input.width, height: k.input.height, data: Array.from(k.input.data) } : null },
        );
        let worst = 0;
        let at = -1;
        for (let i = 0; i < cpu.length; i++) {
          const diff = Math.abs(cpu[i] - gpu[i]);
          if (diff > worst) [worst, at] = [diff, i];
        }
        expect(worst, `${k.id}: channel ${at} is ${gpu[at]} on the GPU, ${cpu[at]} on the CPU`).toBeLessThanOrEqual(2);
      }
    } finally {
      await browser.close();
    }
  });
});
