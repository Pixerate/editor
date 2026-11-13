/**
 * Pixel expressions on the GPU in TypeScript: `PixelWebGL` holds one WebGL2 context, compiles the
 * GLSL that `pixelGLSL` generates (once per source, within a compile budget) and hands out
 * renderers that draw a frame and read it back. The twin of Swift's `PixelMetalRenderer`.
 *
 * It is for live view frames only. The CPU evaluator (`createPixelRenderer`) stays the reference:
 * documents, exports, replays, saved pixels and conformance never use this, so recorded pixels
 * don't change. Frames match the CPU's within a level or two (the GPU computes in `float`).
 *
 * Without WebGL2 (Node, a worker without `OffscreenCanvas`, jsdom, a browser that refuses the
 * context), after context loss, or when a shader fails to compile or link or takes longer than
 * the budget, `createRenderer` throws `EffectUnsupportedError` with the reason and the caller
 * renders on the CPU. No DOM import: the globals are looked up at run time.
 */

import { EffectDisposedError, EffectUnsupportedError } from "./errors.js";
import { createEffectPixels, resolveEffectValues } from "./helpers.js";
import {
  PIXEL_GLSL_SOURCE,
  PIXEL_GLSL_UNIFORMS,
  pixelGLSL,
  pixelGLSLUniforms,
  type PixelGLSLSource,
} from "./pixel-glsl.js";
import type { PixelProgram } from "./pixel-language.js";
import type {
  EffectDescription,
  EffectPixels,
  EffectRenderer,
  EffectRendererOptions,
  EffectRenderRequest,
} from "./types.js";

/** How long compiling a shader may take by default (ms), as in Swift (`PixelGPU.defaultCompileTimeoutMs`). */
export const PIXEL_GPU_COMPILE_TIMEOUT_MS = 2000;

const ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
};

/** The WebGL2 context of an `OffscreenCanvas`, else of a canvas element; null without either (or in jsdom). */
export function defaultPixelWebGLContext(): WebGL2RenderingContext | null {
  const g = globalThis as {
    OffscreenCanvas?: new (w: number, h: number) => OffscreenCanvas;
    document?: Document;
    navigator?: Navigator;
  };
  // jsdom has a document but no WebGL, and logs "not implemented" for every getContext.
  if (g.navigator && /jsdom/i.test(g.navigator.userAgent ?? "")) return null;
  try {
    if (typeof g.OffscreenCanvas === "function") {
      const gl = new g.OffscreenCanvas(1, 1).getContext(
        "webgl2",
        ATTRIBUTES,
      ) as WebGL2RenderingContext | null;
      if (gl) return gl;
    }
    if (g.document && typeof g.document.createElement === "function") {
      const canvas = g.document.createElement("canvas");
      return canvas.getContext?.(
        "webgl2",
        ATTRIBUTES,
      ) as WebGL2RenderingContext | null;
    }
  } catch {
    // A browser that throws for a context it won't make: no GPU here.
  }
  return null;
}

export interface PixelWebGLOptions {
  /** Makes the WebGL2 context (default `defaultPixelWebGLContext`). Return null when there is none. */
  context?: () => WebGL2RenderingContext | null;
  /** The clock for the compile budget, in ms (default `performance.now`). */
  now?: () => number;
  /** Waits between checks of a shader compiling in parallel (`KHR_parallel_shader_compile`; default a 1 ms timeout). */
  wait?: () => Promise<void>;
}

interface Compiled {
  /** The context it was made in (a program from a lost context draws nothing). */
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  uniforms: WebGLUniformLocation | null;
  source: WebGLUniformLocation | null;
}

interface Frame {
  framebuffer: WebGLFramebuffer;
  renderbuffer: WebGLRenderbuffer;
  width: number;
  height: number;
}

const now = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/**
 * One WebGL2 context for pixel expression renderers, with compiled programs kept by source (a
 * failure is kept too, so a shader that doesn't compile is not tried again every frame). Make one
 * per host, or use `PixelWebGL.shared()`; browsers keep only about sixteen contexts alive.
 */
export class PixelWebGL {
  private static sharedInstance: PixelWebGL | null = null;

  /** The context every editor shares by default. */
  static shared(): PixelWebGL {
    return (PixelWebGL.sharedInstance ??= new PixelWebGL());
  }

  private readonly makeContext: () => WebGL2RenderingContext | null;
  private readonly now: () => number;
  private readonly wait: () => Promise<void>;
  private gl: WebGL2RenderingContext | null = null;
  private tried = false;
  private why: string | null = null;
  private programs = new Map<string, Compiled | { error: string }>();
  private frame: Frame | null = null;
  private texture: WebGLTexture | null = null;
  private disposed = false;

  constructor(options: PixelWebGLOptions = {}) {
    this.makeContext = options.context ?? defaultPixelWebGLContext;
    this.now = options.now ?? now;
    this.wait = options.wait ?? (() => new Promise((r) => setTimeout(r, 1)));
  }

  /** The context, made on first use (null without WebGL2, or after it was lost until a new one is made). */
  private context(): WebGL2RenderingContext | null {
    if (this.disposed) return null;
    if (this.gl && this.gl.isContextLost()) this.lost();
    if (this.gl || this.tried) return this.gl;
    this.tried = true;
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = this.makeContext();
    } catch (e) {
      this.why = `WebGL2 could not start (${e instanceof Error ? e.message : String(e)})`;
      return null;
    }
    if (!gl) {
      this.why =
        "this environment has no WebGL2 (no OffscreenCanvas or canvas with a webgl2 context)";
      return null;
    }
    this.gl = gl;
    this.why = null;
    const canvas = gl.canvas as
      | (EventTarget & Partial<Pick<HTMLCanvasElement, "addEventListener">>)
      | undefined;
    canvas?.addEventListener?.("webglcontextlost", () => {
      if (this.gl === gl) this.lost();
    });
    return gl;
  }

  /** Drops a lost context and everything made with it; the next request makes a new one. */
  private lost(): void {
    this.gl = null;
    this.programs = new Map();
    this.frame = null;
    this.texture = null;
    this.tried = false;
    this.why = "the WebGL2 context was lost";
  }

  /** Whether a WebGL2 context is available (makes it on first call). */
  get available(): boolean {
    return this.context() !== null;
  }

  /** Why the GPU is not used (no WebGL2, context lost), or null while it is available. */
  get reason(): string | null {
    return this.context() ? null : (this.why ?? "this PixelWebGL was disposed");
  }

  private async compile(
    glsl: PixelGLSLSource,
    timeoutMs: number,
    effectId: string,
  ): Promise<Compiled> {
    const key = glsl.fragment;
    const have = this.programs.get(key);
    if (have && "error" in have)
      throw new EffectUnsupportedError(have.error, effectId);
    if (have) return have;
    const gl = this.context();
    if (!gl)
      throw new EffectUnsupportedError(
        `Pixel expressions render on the CPU: ${this.reason}.`,
        effectId,
      );
    const fail = (message: string): never => {
      this.programs.set(key, { error: message });
      throw new EffectUnsupportedError(message, effectId);
    };
    const t0 = this.now();
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      return s;
    };
    const vs = shader(gl.VERTEX_SHADER, glsl.vertex);
    const fs = shader(gl.FRAGMENT_SHADER, glsl.fragment);
    const program = gl.createProgram();
    if (!vs || !fs || !program) {
      if (gl.isContextLost()) this.lost();
      throw new EffectUnsupportedError(
        "The GPU could not make a shader; the effect renders on the CPU.",
        effectId,
      );
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    const cleanup = () => {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
    const parallel = gl.getExtension("KHR_parallel_shader_compile") as {
      COMPLETION_STATUS_KHR: number;
    } | null;
    if (parallel) {
      while (
        !gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR) &&
        this.now() - t0 <= timeoutMs &&
        !gl.isContextLost()
      )
        await this.wait();
    }
    if (gl.isContextLost()) {
      this.lost();
      throw new EffectUnsupportedError(
        "The WebGL2 context was lost; the effect renders on the CPU.",
        effectId,
      );
    }
    // Without the parallel extension, asking for the link status is what waits for the compiler.
    const linked = gl.getProgramParameter(program, gl.LINK_STATUS) as boolean;
    if (this.now() - t0 > timeoutMs) {
      cleanup();
      gl.deleteProgram(program);
      fail(
        `The pixel expression shader took longer than ${timeoutMs} ms to compile for the GPU; it renders on the CPU (simplify it to draw live frames on the GPU).`,
      );
    }
    if (!linked) {
      const log = [
        gl.getShaderInfoLog(fs),
        gl.getShaderInfoLog(vs),
        gl.getProgramInfoLog(program),
      ]
        .map((x) => (x ?? "").trim())
        .filter(Boolean)
        .join(" ");
      cleanup();
      gl.deleteProgram(program);
      fail(
        `The pixel expression shader did not compile for the GPU (${log || "no log"}); it renders on the CPU.`,
      );
    }
    cleanup();
    const compiled: Compiled = {
      gl,
      program,
      uniforms: gl.getUniformLocation(program, PIXEL_GLSL_UNIFORMS),
      source:
        glsl.sourceSizeOffset !== null
          ? gl.getUniformLocation(program, PIXEL_GLSL_SOURCE)
          : null,
    };
    this.programs.set(key, compiled);
    return compiled;
  }

  /** The framebuffer, sized for this frame (made again when the size changes). */
  private target(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
  ): Frame {
    const f = this.frame;
    if (f && f.width === width && f.height === height) return f;
    if (f) {
      gl.deleteFramebuffer(f.framebuffer);
      gl.deleteRenderbuffer(f.renderbuffer);
    }
    const framebuffer = gl.createFramebuffer();
    const renderbuffer = gl.createRenderbuffer();
    if (!framebuffer || !renderbuffer)
      throw new Error("the GPU could not make a framebuffer");
    gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.RENDERBUFFER,
      renderbuffer,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error(`the GPU could not make a ${width}×${height} frame`);
    this.frame = { framebuffer, renderbuffer, width, height };
    return this.frame;
  }

  /** Draws one frame and reads it back. */
  private draw(
    compiled: Compiled,
    uniforms: Float32Array,
    width: number,
    height: number,
    source: EffectPixels | null,
  ): Uint8Array {
    const gl = this.context();
    if (!gl) throw new Error(this.reason ?? "no WebGL2");
    if (compiled.gl !== gl) throw new Error("the WebGL2 context was lost");
    const max = Math.min(
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      ...(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array),
    );
    if (width > max || height > max)
      throw new Error(
        `a ${width}×${height} frame is larger than the GPU's ${max} px`,
      );
    const frame = this.target(gl, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, frame.framebuffer);
    gl.viewport(0, 0, width, height);
    for (const cap of [
      gl.BLEND,
      gl.DITHER,
      gl.SCISSOR_TEST,
      gl.DEPTH_TEST,
      gl.STENCIL_TEST,
      gl.CULL_FACE,
      gl.RASTERIZER_DISCARD,
    ])
      gl.disable(cap);
    gl.colorMask(true, true, true, true);
    gl.useProgram(compiled.program);
    if (compiled.uniforms) gl.uniform4fv(compiled.uniforms, uniforms);
    if (compiled.source) {
      const sw = source ? source.width : 1;
      const sh = source ? source.height : 1;
      const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      if (sw > maxTexture || sh > maxTexture)
        throw new Error(
          `a ${sw}×${sh} source is larger than the GPU's ${maxTexture} px textures`,
        );
      this.texture ??= gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      const data = source
        ? new Uint8Array(
            source.data.buffer,
            source.data.byteOffset,
            sw * sh * 4,
          )
        : new Uint8Array(4);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8UI,
        sw,
        sh,
        0,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_BYTE,
        data,
      );
      gl.uniform1i(compiled.source, 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const out = new Uint8Array(width * height * 4);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    const error = gl.getError();
    if (gl.isContextLost()) {
      this.lost();
      throw new Error("the WebGL2 context was lost");
    }
    if (error !== gl.NO_ERROR)
      throw new Error(`WebGL error 0x${error.toString(16)}`);
    return out;
  }

  /**
   * A renderer for a checked program on the GPU. Throws `EffectUnsupportedError` (render on the
   * CPU instead) without WebGL2, when the shader doesn't compile, or when compiling takes longer
   * than `compileTimeoutMs` (default 2000).
   */
  async createRenderer(
    program: PixelProgram,
    description: EffectDescription,
    options: EffectRendererOptions & { compileTimeoutMs?: number },
  ): Promise<EffectRenderer> {
    const glsl = pixelGLSL(program);
    const compiled = await this.compile(
      glsl,
      options.compileTimeoutMs ?? PIXEL_GPU_COMPILE_TIMEOUT_MS,
      description.id,
    );
    const { width, height } = options;
    let disposed = false;
    const renderSync = (req: EffectRenderRequest): EffectPixels => {
      if (disposed) throw new EffectDisposedError(description.id);
      const values = resolveEffectValues(description, req.values ?? {});
      let src = (req.inputs?.source ?? null) as EffectPixels | null;
      if (src && !src.data)
        throw new EffectUnsupportedError(
          `"${description.id}" takes its source as EffectPixels ({ width, height, data }), not a host image (supportsHostImages is false).`,
          description.id,
        );
      if (
        src &&
        (!(src.width >= 1) ||
          !(src.height >= 1) ||
          src.data.length < src.width * src.height * 4)
      )
        src = null;
      const out = createEffectPixels(width, height);
      if (width <= 0 || height <= 0) return out;
      const uniforms = pixelGLSLUniforms(program, glsl, {
        width,
        height,
        timeMs: req.time ?? 0,
        values,
        sourceWidth: src?.width ?? 0,
        sourceHeight: src?.height ?? 0,
      });
      let pixels: Uint8Array;
      try {
        pixels = this.draw(compiled, uniforms, width, height, src);
      } catch (e) {
        throw new EffectUnsupportedError(
          `The GPU could not draw "${description.id}" (${e instanceof Error ? e.message : String(e)}); it renders on the CPU.`,
          description.id,
        );
      }
      out.data.set(pixels);
      return out;
    };
    return {
      effectId: description.id,
      width,
      height,
      depth: 8,
      render: async (req) => renderSync(req),
      renderSync,
      dispose: () => {
        disposed = true;
      },
    };
  }

  /** Frees the programs and the context's buffers (the context itself goes with its canvas). */
  dispose(): void {
    const gl = this.gl;
    if (gl && !gl.isContextLost()) {
      for (const p of this.programs.values())
        if ("program" in p) gl.deleteProgram(p.program);
      if (this.frame) {
        gl.deleteFramebuffer(this.frame.framebuffer);
        gl.deleteRenderbuffer(this.frame.renderbuffer);
      }
      if (this.texture) gl.deleteTexture(this.texture);
    }
    this.programs = new Map();
    this.frame = null;
    this.texture = null;
    this.gl = null;
    this.disposed = true;
    if (PixelWebGL.sharedInstance === this) PixelWebGL.sharedInstance = null;
  }
}
