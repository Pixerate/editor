import Foundation
import PixerateCore
#if canImport(Metal)
import Metal
#endif

/**
 * Pixel expressions on the GPU: Metal Shading Language generated from a checked `PixelProgram`,
 * and `PixelMetalRenderer`, which compiles it at run time and reads the pixels back.
 *
 * The kernel is straight-line code (the language has no loops), so its run time per pixel is
 * bounded by the program's `cost`. Every function has the CPU evaluator's semantics (GLSL `mod`,
 * `sqrt` of a negative is 0, `select` on > 0.5, comparisons give 0 or 1, `min` / `max` keep NaN,
 * `normalize` of 0 is 0, the same 32-bit `hash`), worked out one component at a time with scalars
 * broadcast explicitly, and the output bytes use the same rounding (NaN → 0). The GPU computes in
 * `float` rather than `double`, so pixels match the CPU's within a level or two, not bit for bit.
 *
 * Buffers: `buffer(0)` is `constant float*` uniforms `[width, height, time (s), 0, controls…]`,
 * each control's numbers in declaration order (a colour 3, a vec2 2, a number or bool 1; see
 * `PixelMSLSource.controlOffsets`); `buffer(1)` is `device uchar4*`, width × height straight-alpha
 * RGBA8, row by row from the top. Generated names never collide with MSL keywords: controls are
 * `c<i>`, lets `l<i>`, temporaries `t<i>` and built-ins `b_<name>`.
 */

/// Generated MSL for a program.
public struct PixelMSLSource: Sendable, Equatable {
    public var source: String
    /// The kernel's name.
    public var entry: String
    /// Floats in the uniform buffer (4 + the controls' numbers).
    public var uniformCount: Int
    /// Where each control's numbers start in the uniform buffer, in `program.controls` order.
    public var controlOffsets: [Int]
}

public let PIXEL_MSL_ENTRY = "pixel_main"

private let PIXEL_MSL_PRELUDE = """
#include <metal_stdlib>
using namespace metal;

static inline float px_sin(float x) { return precise::sin(x); }
static inline float px_cos(float x) { return precise::cos(x); }
static inline float px_tan(float x) { return precise::tan(x); }
static inline float px_asin(float x) { return precise::asin(x); }
static inline float px_acos(float x) { return precise::acos(x); }
static inline float px_atan(float x) { return precise::atan(x); }
static inline float px_atan2(float y, float x) { return precise::atan2(y, x); }
static inline float px_sqrt(float x) { return x > 0.0f ? precise::sqrt(x) : 0.0f; }
static inline float px_exp(float x) { return precise::exp(x); }
static inline float px_log(float x) { return precise::log(x); }
static inline float px_abs(float x) { return fabs(x); }
static inline float px_sign(float x) { return x > 0.0f ? 1.0f : (x < 0.0f ? -1.0f : 0.0f); }
static inline float px_floor(float x) { return floor(x); }
static inline float px_ceil(float x) { return ceil(x); }
static inline float px_fract(float x) { return x - floor(x); }
static inline float px_pow(float x, float y) { return precise::pow(x, y); }
static inline float px_mod(float x, float y) { return x - y * floor(x / y); }
static inline float px_min(float a, float b) { return (isnan(a) || isnan(b)) ? NAN : (a < b ? a : b); }
static inline float px_max(float a, float b) { return (isnan(a) || isnan(b)) ? NAN : (a > b ? a : b); }
static inline float px_step(float edge, float x) { return x < edge ? 0.0f : 1.0f; }
static inline float px_clamp(float x, float lo, float hi) { return px_min(px_max(x, lo), hi); }
static inline float px_mix(float a, float b, float t) { return a + (b - a) * t; }
static inline float px_smoothstep(float lo, float hi, float x) {
    float t = px_min(px_max((x - lo) / (hi - lo), 0.0f), 1.0f);
    return t * t * (3.0f - 2.0f * t);
}
static inline float px_hash(float x, float y) {
    int ix = isnan(x) ? 0 : int(floor(clamp(x, -1e9f, 1e9f)));
    int iy = isnan(y) ? 0 : int(floor(clamp(y, -1e9f, 1e9f)));
    uint h = (as_type<uint>(ix) * 0x8da6b343u) ^ (as_type<uint>(iy) * 0xd8163841u);
    h = h ^ (h >> 13);
    h = h * 0x5bd1e995u;
    h = h ^ (h >> 15);
    return float(h) * 2.3283064365386963e-10f;
}
static inline float px_noise(float x, float y) {
    float ix = floor(x);
    float iy = floor(y);
    float fx = x - ix;
    float fy = y - iy;
    float ux = fx * fx * (3.0f - 2.0f * fx);
    float uy = fy * fy * (3.0f - 2.0f * fy);
    float a = px_hash(ix, iy);
    float b = px_hash(ix + 1.0f, iy);
    float c = px_hash(ix, iy + 1.0f);
    float d = px_hash(ix + 1.0f, iy + 1.0f);
    float top = a + (b - a) * ux;
    float bottom = c + (d - c) * ux;
    return top + (bottom - top) * uy;
}
static inline uchar px_byte(float v) { return v > 0.0f ? (v < 1.0f ? uchar(floor(v * 255.0f + 0.5f)) : uchar(255)) : uchar(0); }

"""

private let UNARY_MSL: [String: String] = [
    "sin": "px_sin", "cos": "px_cos", "tan": "px_tan", "asin": "px_asin", "acos": "px_acos", "atan": "px_atan", "sqrt": "px_sqrt", "exp": "px_exp",
    "log": "px_log", "abs": "px_abs", "sign": "px_sign", "floor": "px_floor", "ceil": "px_ceil", "fract": "px_fract",
]
private let BINARY_MSL: [String: String] = [
    "%": "px_mod", "mod": "px_mod", "pow": "px_pow", "min": "px_min", "max": "px_max", "atan": "px_atan2", "step": "px_step",
]
private let TERNARY_MSL: [String: String] = ["clamp": "px_clamp", "mix": "px_mix", "smoothstep": "px_smoothstep"]

/// A float literal for MSL.
private func mslFloat(_ v: Double) -> String {
    let f = Float(v)
    if f.isNaN { return "NAN" }
    if f.isInfinite { return f < 0 ? "(-INFINITY)" : "INFINITY" }
    let s = "\(f)f"
    return f < 0 || (f == 0 && f.sign == .minus) ? "(\(s))" : s
}

private func mslType(_ n: Int) -> String { n == 1 ? "float" : "float\(n)" }
private let COMPONENTS = ["x", "y", "z", "w"]

private final class MSLWriter {
    var lines: [String] = []
    var names: [String: String] = [:]
    var temps = 0

    /// Component `i` of a value of `size` numbers (a number broadcasts).
    func comp(_ x: String, _ size: Int, _ i: Int) -> String { size == 1 ? x : "\(x).\(COMPONENTS[i])" }
    func vec(_ parts: [String]) -> String { parts.count == 1 ? parts[0] : "\(mslType(parts.count))(\(parts.joined(separator: ", ")))" }
    func temp(_ n: Int, _ expr: String) -> String {
        let name = "t\(temps)"
        temps += 1
        lines.append("    const \(mslType(n)) \(name) = \(expr);")
        return name
    }

    func emit(_ e: PixelExpr) -> String {
        switch e {
        case .num(let v, _):
            return temp(1, mslFloat(v))
        case .const(let v, _):
            return temp(v.count, vec(v.map(mslFloat)))
        case .variable(let name, _, _):
            return names[name]!
        case .neg(let a0, _):
            let a = emit(a0)
            return temp(e.size, "-\(a)")
        case .swizzle(let a0, let comps, _):
            let a = emit(a0)
            return temp(comps.count, vec(comps.map { comp(a, a0.size, $0) }))
        case .bin(let op, let a0, let b0, let n, _):
            let a = emit(a0)
            let b = emit(b0)
            let parts = (0..<n).map { i -> String in
                let x = comp(a, a0.size, i), y = comp(b, b0.size, i)
                switch op {
                case "+", "-", "*", "/": return "(\(x) \(op) \(y))"
                case "%": return "px_mod(\(x), \(y))"
                default: return "((\(x) \(op) \(y)) ? 1.0f : 0.0f)"
                }
            }
            return temp(n, vec(parts))
        case .call(let fn, let args0, let n, _):
            let args = args0.map(emit)
            let sizes = args0.map(\.size)
            func each(_ f: String) -> String {
                temp(n, vec((0..<n).map { i in "\(f)(\(zip(args, sizes).map { comp($0, $1, i) }.joined(separator: ", ")))" }))
            }
            if args.count == 1, let f = UNARY_MSL[fn] { return each(f) }
            if let f = BINARY_MSL[fn] { return each(f) }
            if let f = TERNARY_MSL[fn] { return each(f) }
            switch fn {
            case "select":
                let c = args[0]
                return temp(n, vec((0..<n).map { i in "(\(c) > 0.5f ? \(comp(args[1], sizes[1], i)) : \(comp(args[2], sizes[2], i)))" }))
            case "length":
                let sum = (0..<sizes[0]).map { i in "\(comp(args[0], sizes[0], i)) * \(comp(args[0], sizes[0], i))" }.joined(separator: " + ")
                return temp(1, "precise::sqrt(\(sum))")
            case "distance", "dot":
                let m = Swift.max(sizes[0], sizes[1])
                if fn == "dot" {
                    return temp(1, (0..<m).map { i in "\(comp(args[0], sizes[0], i)) * \(comp(args[1], sizes[1], i))" }.joined(separator: " + "))
                }
                let ds = (0..<m).map { i in temp(1, "\(comp(args[0], sizes[0], i)) - \(comp(args[1], sizes[1], i))") }
                return temp(1, "precise::sqrt(\(ds.map { "\($0) * \($0)" }.joined(separator: " + ")))")
            case "normalize":
                let a = args[0]
                let len = temp(1, "precise::sqrt(\((0..<n).map { i in "\(comp(a, n, i)) * \(comp(a, n, i))" }.joined(separator: " + ")))")
                return temp(n, vec((0..<n).map { i in "(\(len) > 0.0f ? \(comp(a, n, i)) / \(len) : 0.0f)" }))
            case "hash", "noise":
                return temp(1, "px_\(fn)(\(args[0]).x, \(args[0]).y)")
            case "vec2", "vec3", "vec4":
                if args.count == 1 && sizes[0] == 1 { return temp(n, vec(Array(repeating: args[0], count: n))) }
                var parts: [String] = []
                for (a, s) in zip(args, sizes) { for i in 0..<s { parts.append(comp(a, s, i)) } }
                return temp(n, vec(parts))
            default:
                fatalError("no MSL for \(fn)")
            }
        }
    }
}

/// The Metal Shading Language kernel for a checked program (`PixelMSL`).
public func pixelMSL(_ program: PixelProgram) -> PixelMSLSource {
    let w = MSLWriter()
    w.lines.append("kernel void \(PIXEL_MSL_ENTRY)(constant float* u [[buffer(0)]], device uchar4* out [[buffer(1)]], uint2 gid [[thread_position_in_grid]]) {")
    w.lines.append("    const uint W = uint(u[0]);")
    w.lines.append("    const uint H = uint(u[1]);")
    w.lines.append("    if (gid.x >= W || gid.y >= H) return;")
    w.lines.append("    const float2 b_size = float2(u[0], u[1]);")
    w.lines.append("    const float2 b_pos = float2(gid) + 0.5f;")
    w.lines.append("    const float2 b_uv = b_pos / b_size;")
    w.lines.append("    const float b_time = u[2];")
    w.lines.append("    const float b_PI = \(mslFloat(Double.pi));")
    w.lines.append("    const float b_TAU = \(mslFloat(Double.pi * 2));")
    for b in PIXEL_BUILTINS { w.names[b.name] = "b_\(b.name)" }
    var offset = 4
    var offsets: [Int] = []
    for (i, c) in program.controls.enumerated() {
        let id = "c\(i)"
        w.names[c.name] = id
        offsets.append(offset)
        w.lines.append("    const \(mslType(c.size)) \(id) = \(w.vec((0..<c.size).map { "u[\(offset + $0)]" })); // \(c.name)")
        offset += c.size
    }
    for (i, l) in program.lets.enumerated() {
        let v = w.emit(l.expr)
        let id = "l\(i)"
        w.lines.append("    const \(mslType(l.expr.size)) \(id) = \(v); // \(l.name)")
        w.names[l.name] = id
    }
    let o = w.emit(program.out)
    switch program.out.size {
    case 1: w.lines.append("    const uchar g = px_byte(\(o));\n    out[gid.y * W + gid.x] = uchar4(g, g, g, uchar(255));")
    case 3: w.lines.append("    out[gid.y * W + gid.x] = uchar4(px_byte(\(o).x), px_byte(\(o).y), px_byte(\(o).z), uchar(255));")
    default: w.lines.append("    out[gid.y * W + gid.x] = uchar4(px_byte(\(o).x), px_byte(\(o).y), px_byte(\(o).z), px_byte(\(o).w));")
    }
    w.lines.append("}")
    return PixelMSLSource(source: PIXEL_MSL_PRELUDE + w.lines.joined(separator: "\n") + "\n", entry: PIXEL_MSL_ENTRY, uniformCount: offset, controlOffsets: offsets)
}

/// The uniforms for one frame: `[width, height, time (s), 0, controls…]`.
func pixelMSLUniforms(_ program: PixelProgram, _ msl: PixelMSLSource, width: Int, height: Int, timeMs: Double, values: JSONObject) -> [Float] {
    var u = [Float](repeating: 0, count: msl.uniformCount)
    u[0] = Float(width)
    u[1] = Float(height)
    u[2] = Float(timeMs / 1000)
    for (i, c) in program.controls.enumerated() {
        for (k, v) in pixelControlNumbers(c, values[c.name]).enumerated() { u[msl.controlOffsets[i] + k] = Float(v) }
    }
    return u
}

/// Pixel expressions on the GPU.
public enum PixelGPU {
    /// Whether this device has a Metal GPU for `PixelMetalRenderer`.
    public static var isAvailable: Bool {
        #if canImport(Metal)
        return PixelMetalContext.shared != nil
        #else
        return false
        #endif
    }

    /// How long compiling a kernel may take by default (ms).
    public static let defaultCompileTimeoutMs: Double = 2000
}

#if canImport(Metal)

/// The device and queue renderers share, and compiled pipelines by source.
final class PixelMetalContext: @unchecked Sendable {
    let device: MTLDevice
    let queue: MTLCommandQueue
    private let lock = NSLock()
    private var pipelines: [String: MTLComputePipelineState] = [:]

    private init?(_ device: MTLDevice?) {
        guard let device, let queue = device.makeCommandQueue() else { return nil }
        self.device = device
        self.queue = queue
    }

    static let shared: PixelMetalContext? = PixelMetalContext(MTLCreateSystemDefaultDevice())

    private final class CompileBox: @unchecked Sendable {
        var library: MTLLibrary?
        var error: Error?
    }

    /// The pipeline for `msl` (compiled once per source), within `timeoutMs`.
    func pipeline(_ msl: PixelMSLSource, timeoutMs: Double, effectId: String) throws -> MTLComputePipelineState {
        if let p = lock.withLock({ pipelines[msl.source] }) { return p }
        let options = MTLCompileOptions()
        if #available(macOS 15.0, iOS 18.0, *) {
            options.mathMode = .safe
        } else {
            options.fastMathEnabled = false
        }
        let box = CompileBox()
        let done = DispatchSemaphore(value: 0)
        device.makeLibrary(source: msl.source, options: options) { library, error in
            box.library = library
            box.error = error
            done.signal()
        }
        if done.wait(timeout: .now() + .milliseconds(Swift.max(0, Int(timeoutMs)))) == .timedOut {
            throw EffectError.unsupported("The pixel expression shader took longer than \(jsText(timeoutMs)) ms to compile for the GPU; render it on the CPU (PixelCPURenderer) or simplify it.", effectId)
        }
        guard let library = box.library, let fn = library.makeFunction(name: msl.entry) else {
            throw EffectError.unsupported("The pixel expression shader did not compile for the GPU (\(box.error?.localizedDescription ?? "no kernel")); render it on the CPU (PixelCPURenderer).", effectId)
        }
        let pipeline = try device.makeComputePipelineState(function: fn)
        lock.withLock { pipelines[msl.source] = pipeline }
        return pipeline
    }
}

/**
 * Renders a compiled program on the GPU (Metal). `init` throws `unsupported` when there is no
 * Metal device, the kernel doesn't compile, or compiling takes longer than `compileTimeoutMs`
 * (default 2000); fall back to `PixelCPURenderer` then. Pixels are within a level or two of the
 * CPU renderer's.
 */
public final class PixelMetalRenderer: SyncEffectRenderer {
    public let description: EffectDescription
    public let program: PixelProgram
    public let width: Int
    public let height: Int
    public let msl: PixelMSLSource
    public var effectId: String { description.id }
    private let context: PixelMetalContext
    private let pipeline: MTLComputePipelineState
    private var disposed = false

    public init(program: PixelProgram, description: EffectDescription, width: Int, height: Int, compileTimeoutMs: Double = PixelGPU.defaultCompileTimeoutMs) throws {
        guard let context = PixelMetalContext.shared else { throw EffectError.unsupported("This device has no Metal GPU; render pixel expressions on the CPU (PixelCPURenderer).", description.id) }
        self.program = program
        self.description = description
        self.width = width
        self.height = height
        self.context = context
        msl = pixelMSL(program)
        pipeline = try context.pipeline(msl, timeoutMs: compileTimeoutMs, effectId: description.id)
    }

    public func renderSync(_ request: EffectRenderRequest) throws -> EffectPixels {
        if disposed { throw EffectError("disposed", "The renderer for \"\(effectId)\" was disposed. Create a new renderer.", effectId: effectId) }
        let values = try resolveEffectValues(description, request.values ?? [:])
        var out = EffectPixels(width: width, height: height)
        if width <= 0 || height <= 0 { return out }
        let uniforms = pixelMSLUniforms(program, msl, width: width, height: height, timeMs: request.time, values: values)
        let device = context.device
        guard let ub = uniforms.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }),
              let ob = device.makeBuffer(length: width * height * 4, options: .storageModeShared),
              let cmd = context.queue.makeCommandBuffer(),
              let enc = cmd.makeComputeCommandEncoder()
        else { throw EffectError.unsupported("The GPU could not allocate a \(width)×\(height) frame; render it on the CPU (PixelCPURenderer).", effectId) }
        enc.setComputePipelineState(pipeline)
        enc.setBuffer(ub, offset: 0, index: 0)
        enc.setBuffer(ob, offset: 0, index: 1)
        let tw = Swift.max(1, pipeline.threadExecutionWidth)
        let th = Swift.max(1, pipeline.maxTotalThreadsPerThreadgroup / tw)
        enc.dispatchThreadgroups(MTLSize(width: (width + tw - 1) / tw, height: (height + th - 1) / th, depth: 1), threadsPerThreadgroup: MTLSize(width: tw, height: th, depth: 1))
        enc.endEncoding()
        cmd.commit()
        cmd.waitUntilCompleted()
        if let error = cmd.error { throw EffectError.unsupported("The GPU failed to render \"\(effectId)\" (\(error.localizedDescription)); render it on the CPU (PixelCPURenderer).", effectId) }
        let src = ob.contents().assumingMemoryBound(to: UInt8.self)
        out.data.withUnsafeMutableBufferPointer { dst in dst.baseAddress!.update(from: src, count: width * height * 4) }
        return out
    }

    public func render(_ request: EffectRenderRequest) async throws -> EffectPixels { try renderSync(request) }

    public func dispose() { disposed = true }
}

#endif
