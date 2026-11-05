import Foundation
import PixerateCore
import PixerateRaster

/**
 * Stamp tips (`paint-editor/stamp-tip.ts`): a dab, a particle dot or a spray droplet shaped like a
 * stamp instead of the round computed tip. An editor stamp (`editor:star`, or a bare `star`) is
 * drawn from its coverage function; an image source (`source:<id>`) from its mask. The mark is
 * laid in the paint colour. Provider stickers (a host's sticker library) have no art in this port.
 *
 * Tip grain (`paint-editor/tip-grain.ts`): texture inside each dab, a built-in grain pattern or an
 * image source, either fixed to the canvas (`texturised`) or rolling with the tip (`moving`).
 */

/// Loaded art a stamp tip or an image grain reads: its alpha, one byte per pixel.
public final class StampArt: @unchecked Sendable {
    public let width: Int
    public let height: Int
    public let alpha: [UInt8]
    public init(width: Int, height: Int, alpha: [UInt8]) {
        self.width = width
        self.height = height
        self.alpha = alpha
    }
}

/// The art of a stamp or grain ref, or nil when there is none.
public typealias StampArtLookup = (String) -> StampArt?

/// Coverage 0..1 of a stamp at (u, v) of its unit square (−1..1, y down); the seed varies shapes with random parts.
typealias StampSampler = (Double, Double, Int) -> Double

/**
 * The sampler of a stamp ref: an editor stamp's coverage, or the alpha of an image source's art
 * (bilinear, centred in the unit square, aspect kept). Nil when there is no art: the caller paints
 * the round tip instead. `hardness` below 1 softens an image source's edges.
 */
func stampSampler(_ ref: String, _ art: StampArtLookup?, _ hardness: Double = 1) -> StampSampler? {
    guard let sampler = baseSampler(ref, art) else { return nil }
    // Image sources take the tip's hardness: below 1 they fade out towards the corners of their square.
    if hardness >= 1 || !isBrushSourceRef(ref) { return sampler }
    let h = Swift.max(0, hardness)
    return { u, v, seed in
        let r = JS.hypot(u, v) / 2.0.squareRoot()
        if r <= h { return sampler(u, v, seed) }
        let t = Swift.min(1, (r - h) / (1 - h))
        return sampler(u, v, seed) * (1 - t * t * (3 - 2 * t))
    }
}

private func baseSampler(_ ref: String, _ art: StampArtLookup?) -> StampSampler? {
    if let kind = editorStampKind(ref) { return { u, v, seed in stampCoverage(kind, u, v, seed) } }
    guard let a = art?(ref), a.width > 0, a.height > 0 else { return nil }
    let w = a.width, h = a.height, data = a.alpha
    // The art's longest side spans the unit square.
    let scale = Double(Swift.max(w, h)) / 2
    @inline(__always) func alpha(_ x: Int, _ y: Int) -> Double { x < 0 || y < 0 || x >= w || y >= h ? 0 : Double(data[y * w + x]) / 255 }
    return { u, v, _ in
        let x = u * scale + Double(w) / 2 - 0.5
        let y = v * scale + Double(h) / 2 - 0.5
        let xf = JS.floor(x), yf = JS.floor(y)
        let fx = x - xf, fy = y - yf
        let x0 = Int(xf), y0 = Int(yf)
        return (alpha(x0, y0) * (1 - fx) + alpha(x0 + 1, y0) * fx) * (1 - fy) + (alpha(x0, y0 + 1) * (1 - fx) + alpha(x0 + 1, y0 + 1) * fx) * fy
    }
}

/// The pixel rectangle a stamp dab can touch.
func stampDabRect(_ d: Dab) -> RasterRect {
    let r = Swift.max(0.5, d.radius) * 2.0.squareRoot() + 1.5
    let x0 = Int(JS.floor(d.x - r))
    let y0 = Int(JS.floor(d.y - r))
    return RasterRect(x: x0, y: y0, width: Int(JS.ceil(d.x + r)) - x0, height: Int(JS.ceil(d.y + r)) - y0)
}

/**
 * Rasterizes one stamp dab over `rect` into `out` (coverage × flow): the stamp's unit square spans
 * the tip's diameter, squashed by roundness and turned by the tip angle as a round tip would be,
 * mirrored by `flip` (bit 1: across x, bit 2: across y). Small dabs are supersampled.
 */
func rasterizeStampDab(_ d: Dab, _ flip: Int, _ sample: StampSampler, _ seed: Int, _ rect: RasterRect, _ out: inout [Float]) {
    let w = rect.width
    let h = rect.height
    for k in 0..<(w * h) { out[k] = 0 }
    let r = Swift.max(0.5, d.radius)
    let ro = Swift.min(1, Swift.max(0.05, d.roundness))
    let sn = JS.sin(d.angle)
    let cs = JS.cos(d.angle)
    let ss = r < 6 ? 3 : 1
    let fu: Double = flip & 1 != 0 ? -1 : 1
    let fv: Double = flip & 2 != 0 ? -1 : 1
    for yy in 0..<h {
        for xx in 0..<w {
            var sum = 0.0
            for sy in 0..<ss {
                for sx in 0..<ss {
                    let dx = Double(rect.x + xx) + (Double(sx) + 0.5) / Double(ss) - d.x
                    let dy = Double(rect.y + yy) + (Double(sy) + 0.5) / Double(ss) - d.y
                    // Into the tip's frame (the angle turns counter-clockwise on screen, y down), then the unit square.
                    let u = ((dx * cs - dy * sn) / r) * fu
                    let v = ((dx * sn + dy * cs) / (r * ro)) * fv
                    if u > -1.05 && u < 1.05 && v > -1.05 && v < 1.05 { sum += sample(u, v, seed) }
                }
            }
            let val = sum / Double(ss * ss)
            if val > 0 { out[yy * w + xx] = Float(Swift.min(1, val) * d.alpha) }
        }
    }
}

/// The refs of a brush's marks this port has no art for: provider stickers (editor stamps and image sources draw).
func brushStickerRefs(_ brush: PaintBrush) -> [String] {
    var refs: [String] = []
    if brush.engine == "sticker" { refs = (brush.sticker["stamps"]?.arrayValue ?? []).compactMap(\.stringValue) } else if brush.engine == "particle" { refs = (brush.particle["dotTextures"]?.arrayValue ?? []).compactMap(\.stringValue) } else if brush.engine == "dab", let s = brush.stamp { refs = [s] }
    var out: [String] = []
    for r in refs where r.contains(":") && !r.hasPrefix("editor:") && !isBrushSourceRef(r) && !out.contains(r) { out.append(r) }
    return out
}

// MARK: - Tip grain

/// Texture inside the tip (dab engines): each dab's coverage is multiplied by it.
public struct TipGrainSettings: Equatable, Sendable {
    /// A grain pattern (`rough`, `canvas`…) or an image source `source:<id>`.
    public var source: String
    /// `texturised` (default): fixed to the canvas; `moving`: rolls along with the tip.
    public var mode: String
    /// 0.05..20: 1 the source's own size.
    public var scale: Double
    /// 0..1: how much it takes out of the dab.
    public var depth: Double
    /// 0..3 around the middle.
    public var contrast: Double
    public var invert: Bool

    var json: JSONValue { ["source": .string(source), "mode": .string(mode), "scale": .number(scale), "depth": .number(depth), "contrast": .number(contrast), "invert": .bool(invert)] }
}

public let TIP_GRAIN_MODES = ["moving", "texturised"]
public let DAB_FLIPS = ["none", "x", "y", "xy"]

/// Tip grain settings in range, nil to clear, or `base` when `raw` is missing or has no usable source.
func readTipGrain(_ raw: JSONValue?, _ base: TipGrainSettings?) -> TipGrainSettings? {
    guard let raw else { return base }
    if raw == .null { return nil }
    guard let r = raw.objectValue else { return base }
    let given = r["source"]?.stringValue.flatMap { $0.range(of: #"^\S{1,200}$"#, options: .regularExpression) != nil ? $0 : nil }
    guard let source = given ?? base?.source else { return base }
    let b = base ?? TipGrainSettings(source: source, mode: "texturised", scale: 1, depth: 0.6, contrast: 1, invert: false)
    return TipGrainSettings(
        source: source,
        mode: r["mode"]?.stringValue.flatMap { TIP_GRAIN_MODES.contains($0) ? $0 : nil } ?? b.mode,
        scale: rangeValue(r["scale"], 0.05, 20, b.scale),
        depth: unitValue(r["depth"], b.depth),
        contrast: rangeValue(r["contrast"], 0, 3, b.contrast),
        invert: boolValue(r["invert"], b.invert)
    )
}

private struct GrainPatternSettings: PaperGrainSettings {
    var pattern: String
    var seed: Int
    var scale: Double
    var tiling: String
    var dry: GrainTuning
    var wet: GrainTuning
    var offset: LayerOffset?
}

/// A tiled image texture: heights 0..1 with contrast and invert applied.
private final class ImageGrain {
    private let w: Int
    private let h: Int
    private let scale: Double
    private let heights: [Float]

    init(_ art: StampArt, _ contrast: Double, _ invert: Bool, _ scale: Double) {
        w = art.width
        h = art.height
        self.scale = scale
        heights = art.alpha.map { a in
            let v = Swift.min(1, Swift.max(0, (Double(a) / 255 - 0.5) * contrast + 0.5))
            return Float(invert ? 1 - v : v)
        }
    }

    func at(_ x: Double, _ y: Double) -> Double {
        let u = x / scale - 0.5
        let v = y / scale - 0.5
        let xf = JS.floor(u), yf = JS.floor(v)
        let fx = u - xf, fy = v - yf
        let x0 = Int(xf), y0 = Int(yf)
        let xa = ((x0 % w) + w) % w
        let ya = ((y0 % h) + h) % h
        let xb = (xa + 1) % w
        let yb = (ya + 1) % h
        let hs = heights
        return (Double(hs[ya * w + xa]) * (1 - fx) + Double(hs[ya * w + xb]) * fx) * (1 - fy) + (Double(hs[yb * w + xa]) * (1 - fx) + Double(hs[yb * w + xb]) * fx) * fy
    }
}

/// A brush's tip grain, ready to apply to dabs.
final class TipGrain {
    private let field: (Double, Double) -> Double
    private let settings: TipGrainSettings

    private init(_ field: @escaping (Double, Double) -> Double, _ settings: TipGrainSettings) {
        self.field = field
        self.settings = settings
    }

    /// The grain for `settings`, or nil when there is none to apply: no depth, or an image source without art.
    static func create(_ settings: TipGrainSettings?, _ art: StampArtLookup?) -> TipGrain? {
        guard let settings, settings.depth > 0 else { return nil }
        if GRAIN_PATTERNS.contains(settings.source) {
            if settings.source == "smooth" { return nil }
            let tuning = GrainTuning(contrast: settings.contrast, invert: settings.invert)
            let paper = PaperGrain(GrainPatternSettings(pattern: settings.source, seed: 0, scale: settings.scale, tiling: "repeat", dry: tuning, wet: tuning, offset: nil))
            return TipGrain(paper.at, settings)
        }
        guard let a = art?(settings.source), a.width > 0, a.height > 0 else { return nil }
        return TipGrain(ImageGrain(a, settings.contrast, settings.invert, settings.scale).at, settings)
    }

    /// Multiplies the dab's coverage `vals` (over `rect`) by the grain; `angle` and `travel` place moving grain.
    func apply(_ vals: inout [Float], _ rect: RasterRect, x: Double, y: Double, angle: Double, travel: Double) {
        let depth = settings.depth
        let moving = settings.mode == "moving"
        let cs = JS.cos(angle)
        let sn = JS.sin(angle)
        var k = 0
        for yy in 0..<rect.height {
            let py = Double(rect.y + yy) + 0.5
            for xx in 0..<rect.width {
                defer { k += 1 }
                if !(vals[k] > 0) { continue }
                let px = Double(rect.x + xx) + 0.5
                var gx = px, gy = py
                if moving {
                    // Into the tip's frame (as the stamp rasterizer turns it), rolled along by the travel.
                    let dx = px - x
                    let dy = py - y
                    gx = dx * cs - dy * sn + travel
                    gy = dx * sn + dy * cs
                }
                vals[k] = Float(Double(vals[k]) * (1 - depth * (1 - field(gx, gy))))
            }
        }
    }
}
