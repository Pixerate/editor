// Portions ported from photocraft/crates/paint/src/lib.rs, dynamics.rs and render.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors) by way of packages/core/src/paint/brush.ts. See THIRD_PARTY_NOTICES.md.

import Foundation
import PixerateRaster

/**
 * The brush engine (`paint/brush.ts`): a computed round tip with size, hardness, angle, roundness
 * and spacing; pressure to size and opacity; smoothing; and Photoshop's opacity-versus-flow
 * build-up.
 *
 * - Each dab's coverage (`dabCoverage`, photocraft's measured Photoshop profile) builds up in a
 *   stroke coverage map with flow towards the dab's opacity ceiling: `c ← c + v·(ceil − c)`.
 * - The stroke composites once at the stroke opacity over the layer as it was before the stroke,
 *   so overlapping dabs never exceed the opacity.
 *
 * Coverage buffers are `Float` (the TS `Float32Array`s): every store rounds to single precision,
 * every read widens back, so the arithmetic in between is the TS core's `Double` arithmetic.
 */

public struct BrushSettings: Equatable, Sendable {
    /// Diameter in pixels (1..2500, default 20).
    public var size: Double
    /// 0 (soft) .. 1 (hard, default).
    public var hardness: Double
    /// Dab spacing as a fraction of the diameter (0.01..10, default 0.1).
    public var spacing: Double
    /// Tip angle in degrees (default 0).
    public var angle: Double
    /// Tip roundness 0.01..1 (default 1).
    public var roundness: Double
    /// Stroke opacity ceiling 0..1 (default 1).
    public var opacity: Double
    /// Build-up per dab 0..1 (default 1).
    public var flow: Double
    /// Input smoothing 0..0.95 (default 0).
    public var smoothing: Double
    /// Pressure controls size (default true).
    public var pressureSize: Bool
    /// Pressure controls opacity (default false).
    public var pressureOpacity: Bool
    /// How the stroke paints onto the layer (default normal).
    public var blend: BlendMode
}

public let DEFAULT_BRUSH = BrushSettings(size: 20, hardness: 1, spacing: 0.1, angle: 0, roundness: 1, opacity: 1, flow: 1, smoothing: 0, pressureSize: true, pressureOpacity: false, blend: .normal)

public let MAX_BRUSH_SIZE = 2500.0

// MARK: - The round tip (photocraft's measured Photoshop profile)

private let TIP_SHAPE: [(Double, Double)] = [
    (0.0, 0.664), (0.14, 0.58), (0.28, 0.5), (0.4, 0.44), (0.52, 0.36), (0.63, 0.29),
    (0.7, 0.24), (0.78, 0.19), (0.84, 0.15), (0.89, 0.11), (1.0, 0.0),
]
/// The anti-aliased edge: the shoulder never narrows below this many pixels.
private let TIP_EDGE_PX = 1.2
private let SMALL_TIP_RADIUS = 3.0
private let SUBPIXEL = [-0.375, -0.125, 0.125, 0.375]

/// The core radius and shoulder width (pixels) of a round tip of `radius` and `hardness`.
public func tipShape(_ radius: Double, _ hardness: Double) -> (Double, Double) {
    let h = (hardness.isNaN ? 0 : Swift.min(1, Swift.max(0, hardness))) * 10
    let i = Swift.min(9, Int(JS.floor(h)))
    let t = h - Double(i)
    let a = TIP_SHAPE[i]
    let b = TIP_SHAPE[i + 1]
    let r0 = a.0 + (b.0 - a.0) * t
    let s = a.1 + (b.1 - a.1) * t
    let r = radius.isFinite ? Swift.max(0, radius) : 0
    let edge = Swift.max(0.25, Swift.min(TIP_EDGE_PX, 0.3 * r))
    return (Swift.max(0, Swift.min(r0 * r, r - edge)), Swift.max(1e-3, s * r, edge))
}

/// `exp(-u)` as `(1 − u/64)^64` by six squarings: exactly 0 from u = 64.
@inline(__always) private func softExp(_ u: Double) -> Double {
    var g = Swift.min(1, Swift.max(0, 1 - u / 64))
    for _ in 0..<6 { g *= g }
    return g
}

/// Opacity of a round tip at distance `d` from its centre.
public func tipFalloff(_ d: Double, _ radius: Double, _ hardness: Double) -> Double {
    let (r0, s) = tipShape(radius, hardness)
    if d <= r0 { return 1 }
    let x = (d - r0) / s
    return softExp(x * x)
}

/// How far from its centre a round tip still paints.
public func tipReach(_ radius: Double, _ hardness: Double) -> Double {
    let (r0, s) = tipShape(radius, hardness)
    return r0 + 2.6 * s
}

/// Coverage of a round dab at distance `d` from its centre.
public func dabCoverage(_ d: Double, _ radius: Double, _ hardness: Double) -> Double {
    if d.isNaN || d >= tipReach(radius, hardness) + 0.5 { return 0 }
    return tipFalloff(d, radius, hardness)
}

// MARK: - Dabs

public struct Dab {
    public var x: Double
    public var y: Double
    public var radius: Double
    /// Flow (per-dab build-up).
    public var alpha: Double
    /// Opacity ceiling this dab builds up to.
    public var opacity: Double
    /// Radians.
    public var angle: Double
    public var roundness: Double
}

/// The pixel rectangle a dab can touch.
public func dabRect(_ d: Dab, _ hardness: Double) -> RasterRect {
    let ro = Swift.min(1, Swift.max(0.5 / d.radius, d.roundness))
    let rm = Swift.max(0.5, d.radius * ro)
    let r = Swift.max(rm, tipReach(rm, hardness)) / ro + 1.5
    let x0 = Int(JS.floor(d.x - r))
    let y0 = Int(JS.floor(d.y - r))
    return RasterRect(x: x0, y: y0, width: Int(JS.ceil(d.x + r)) - x0, height: Int(JS.ceil(d.y + r)) - y0)
}

/**
 * Rasterizes one dab over `rect` into `out` (rect.width × rect.height values, coverage × flow).
 * Small tips (radius below 3 px) take each pixel's covered area from a 4×4 grid.
 */
public func rasterizeDab(_ d: Dab, _ hardness: Double, _ rect: RasterRect, _ out: inout [Float]) {
    let w = rect.width
    let h = rect.height
    for k in 0..<(w * h) { out[k] = 0 }
    let r = d.radius
    let ro = Swift.min(1, Swift.max(0.5 / r, d.roundness))
    let rm = Swift.max(0.5, r * ro)
    let reach = Swift.max(rm, tipReach(rm, hardness))
    let sn = JS.sin(d.angle)
    let cs = JS.cos(d.angle)
    let small = rm < SMALL_TIP_RADIUS
    let reachPad = reach + (small ? 0.75 : 0.5)
    let reach2 = reachPad * reachPad
    let (r0, s) = tipShape(rm, hardness)
    let cutoff = r0 + 2.6 * s + 0.5
    @inline(__always) func falloff(_ dist: Double) -> Double {
        if dist <= r0 { return 1 }
        let x = (dist - r0) / s
        return softExp(x * x)
    }
    for yy in 0..<h {
        let dy = Double(rect.y + yy) + 0.5 - d.y
        for xx in 0..<w {
            let dx = Double(rect.x + xx) + 0.5 - d.x
            let ux = dx, uy = -dy
            let u = ux * cs + uy * sn
            let v = -ux * sn + uy * cs
            let uro = u * ro
            let d2 = uro * uro + v * v
            if d2 >= reach2 { continue }
            var val: Double
            if small {
                var sum = 0.0
                for sy in SUBPIXEL {
                    for sx in SUBPIXEL {
                        let sux = dx + sx, suy = -(dy + sy)
                        let su = sux * cs + suy * sn
                        let sv = -sux * sn + suy * cs
                        let suro = su * ro
                        sum += falloff((suro * suro + sv * sv).squareRoot())
                    }
                }
                val = sum / 16
            } else {
                let dist = d2.squareRoot()
                val = dist.isNaN || dist >= cutoff ? 0 : falloff(dist)
            }
            if val > 0 { out[yy * w + xx] = Float(val * d.alpha) }
        }
    }
}

// MARK: - Stroke coverage

private let COVERAGE_TILE_PIXELS = TILE * TILE

@inline(__always) func floorTile(_ v: Int) -> Int { v >> TILE_SHIFT }

/// A float tile of a coverage map (a reference, so it is written in place).
final class FloatTile {
    var data: [Float]
    init(count: Int) { data = [Float](repeating: 0, count: count) }
}

/// A stroke's accumulated coverage, in 256 px tiles over document space.
public final class CoverageMap {
    var tiles: [TileKey: FloatTile] = [:]
    /**
     * Gradient paint: the colour laid at each pixel (sRGB 0..1, 3 per pixel), when dabs carry their
     * own colours. Each dab blends its colour in by the share of coverage it adds.
     */
    var colors: [TileKey: FloatTile] = [:]
    public private(set) var bounds: RasterRect?

    public init() {}

    /// The colour at a pixel (gradient paint), or nil when the stroke has one colour there.
    func colorAt(_ x: Int, _ y: Int, _ out: inout [Double]) -> Bool {
        let tx = floorTile(x), ty = floorTile(y)
        guard let t = colors[tileKey(tx, ty)] else { return false }
        let i = ((y - ty * TILE) * TILE + (x - tx * TILE)) * 3
        out[0] = Double(t.data[i])
        out[1] = Double(t.data[i + 1])
        out[2] = Double(t.data[i + 2])
        return true
    }

    public func get(_ x: Int, _ y: Int) -> Double {
        let tx = floorTile(x), ty = floorTile(y)
        guard let t = tiles[tileKey(tx, ty)] else { return 0 }
        return Double(t.data[(y - ty * TILE) * TILE + (x - tx * TILE)])
    }

    /**
     * Builds up `vals` (over `rect`) with flow towards `ceil`: `c ← c + v·(ceil − c)`. With `color`
     * (one sRGB colour for the dab) or `field` (sRGB per pixel of `rect`, 3 each), the pixels' colours
     * move towards it by the share of coverage this dab adds (gradient paint).
     */
    /// `limits`, when given, caps each pixel at `ceil × limits[i]` (effect paint's alpha, `sampleEffectField`).
    public func accumulate(_ rect: RasterRect, _ vals: [Float], _ ceil: Double, color: [Double]? = nil, field: [Float]? = nil, limits: [Float]? = nil) {
        if rect.width <= 0 || rect.height <= 0 { return }
        let w = rect.width
        let tx0 = floorTile(rect.x), ty0 = floorTile(rect.y)
        let tx1 = floorTile(rect.x + rect.width - 1), ty1 = floorTile(rect.y + rect.height - 1)
        var touched = false
        for ty in ty0...ty1 {
            for tx in tx0...tx1 {
                let x0 = Swift.max(rect.x, tx * TILE)
                let y0 = Swift.max(rect.y, ty * TILE)
                let x1 = Swift.min(rect.x + rect.width, tx * TILE + TILE)
                let y1 = Swift.min(rect.y + rect.height, ty * TILE + TILE)
                var tile: FloatTile?
                let key = tileKey(tx, ty)
                if y0 >= y1 || x0 >= x1 { continue }
                for y in y0..<y1 {
                    let row = (y - rect.y) * w
                    let trow = (y - ty * TILE) * TILE
                    for x in x0..<x1 {
                        let v = Double(vals[row + (x - rect.x)])
                        if v <= 0 { continue }
                        if tile == nil {
                            if let t = tiles[key] { tile = t } else {
                                let t = FloatTile(count: COVERAGE_TILE_PIXELS)
                                tiles[key] = t
                                tile = t
                            }
                            touched = true
                        }
                        let ti = trow + (x - tx * TILE)
                        let c = Double(tile!.data[ti])
                        let cap = limits.map { ceil * Double($0[row + (x - rect.x)]) } ?? ceil
                        if cap > c {
                            let next = c + v * (cap - c)
                            tile!.data[ti] = Float(next)
                            if color != nil || field != nil {
                                let ct: FloatTile
                                if let t = colors[key] { ct = t } else {
                                    ct = FloatTile(count: COVERAGE_TILE_PIXELS * 3)
                                    colors[key] = ct
                                }
                                let wgt = c > 0 ? (next - c) / next : 1
                                let fi = (row + (x - rect.x)) * 3
                                let ci = ti * 3
                                for ch in 0..<3 {
                                    let col = field != nil ? Double(field![fi + ch]) : color![ch]
                                    let cur = Double(ct.data[ci + ch])
                                    ct.data[ci + ch] = Float(cur + (col - cur) * wgt)
                                }
                            }
                        }
                    }
                }
            }
        }
        if touched { bounds = unionRect(bounds, rect) }
    }
}

func unionRect(_ a: RasterRect?, _ b: RasterRect) -> RasterRect {
    guard let a else { return b }
    let x = Swift.min(a.x, b.x)
    let y = Swift.min(a.y, b.y)
    return RasterRect(x: x, y: y, width: Swift.max(a.x + a.width, b.x + b.width) - x, height: Swift.max(a.y + a.height, b.y + b.height) - y)
}

func unionRectOpt(_ a: RasterRect?, _ b: RasterRect?) -> RasterRect? {
    guard let b else { return a }
    return unionRect(a, b)
}

/// Colours across the tip of an `across-tip` gradient.
public let TIP_GRADIENT_STEPS = 32

/// Selection coverage (document space, canvas-sized).
public struct PaintSelection {
    public var width: Int
    public var height: Int
    public var data: [UInt8]
    public init(width: Int, height: Int, data: [UInt8]) {
        self.width = width
        self.height = height
        self.data = data
    }
}

/// How a stroke changes pixels.
public struct StrokeApply {
    public enum Mode { case paint, erase }
    /// `paint` puts colour down; `erase` removes alpha (or, with transparency locked, paints `background`).
    public var mode: Mode
    /// RGBA 0..255 (paint colour, or the mask grey in `r`).
    public var color: [Int]
    /// RGBA 0..255 the eraser paints on a transparency-locked layer (and on masks).
    public var background: [Int]
    public var opacity: Double
    public var blend: BlendMode
    public var lockTransparency: Bool
    /// Selection coverage (document space, canvas-sized), or nil.
    public var selection: PaintSelection?
    /// Layer offset (target pixels are in layer space).
    public var offset: LayerOffset
}

/**
 * Composites the stroke's coverage over `tileData` (the target's tile (tx, ty) as it was before
 * the stroke, in layer space; RGBA or one byte for masks) and returns the new tile data. With
 * `into` (the tile's previous result) and `region` (document space), only `region` is recomputed
 * and the rest of `into` is kept.
 */
public func applyStrokeToTile(_ coverage: CoverageMap, _ tileData: [UInt8], _ channels: Int, _ tx: Int, _ ty: Int, _ s: StrokeApply, into: [UInt8]? = nil, region: RasterRect? = nil) -> [UInt8] {
    var out = into ?? tileData
    let ox = tx * TILE + s.offset.x
    let oy = ty * TILE + s.offset.y
    var x0 = 0, y0 = 0, x1 = TILE, y1 = TILE
    if let r = region {
        x0 = Swift.max(0, r.x - ox)
        y0 = Swift.max(0, r.y - oy)
        x1 = Swift.min(TILE, r.x + r.width - ox)
        y1 = Swift.min(TILE, r.y + r.height - oy)
        if x1 <= x0 || y1 <= y0 { return out }
        // Start the region from the pre-stroke pixels: coverage is cumulative.
        if into != nil {
            for y in y0..<y1 {
                let a = (y * TILE + x0) * channels, b = (y * TILE + x1) * channels
                for k in a..<b { out[k] = tileData[k] }
            }
        }
    }
    let sel = s.selection
    var cb = [0.0, 0.0, 0.0, 0.0]
    let cs = [Double(s.color[0]) / 255, Double(s.color[1]) / 255, Double(s.color[2]) / 255, Double(s.color[3]) / 255]
    let bg = [Double(s.background[0]) / 255, Double(s.background[1]) / 255, Double(s.background[2]) / 255, Double(s.background[3]) / 255]
    // With a tile-aligned offset the layer tile is one coverage tile: read it directly.
    let aligned = s.offset.x % TILE == 0 && s.offset.y % TILE == 0
    let covTile = aligned ? coverage.tiles[tileKey(floorTile(ox), floorTile(oy))] : nil
    if aligned && covTile == nil { return out }
    // Gradient paint: each pixel's own colour (alpha stays the stroke's).
    let colored = s.mode == .paint && !coverage.colors.isEmpty
    var own = [0, 0, 0, cs[3]]
    var ownBytes = [0, 0, 0, s.color[3]]
    var mix = [0.0, 0.0, 0.0]
    for y in y0..<y1 {
        let dy = oy + y
        for x in x0..<x1 {
            let dx = ox + x
            let c = covTile != nil ? Double(covTile!.data[y * TILE + x]) : coverage.get(dx, dy)
            if c <= 0 { continue }
            let pixelColor = colored ? coverage.colorAt(dx, dy, &own) : false
            if pixelColor { for ch in 0..<3 { ownBytes[ch] = Int(JS.round(Swift.min(1, Swift.max(0, own[ch])) * 255)) } }
            var k = c * s.opacity
            if let sel {
                if dx < 0 || dy < 0 || dx >= sel.width || dy >= sel.height { continue }
                k *= Double(sel.data[dy * sel.width + dx]) / 255
            }
            if k > 1 { k = 1 }
            if k <= 0 { continue }
            let p = y * TILE + x
            if channels == 1 {
                let target = s.mode == .erase ? Double(s.background[0]) : pixelColor ? JS.round(0.299 * Double(ownBytes[0]) + 0.587 * Double(ownBytes[1]) + 0.114 * Double(ownBytes[2])) : Double(s.color[0])
                let cur = Double(out[p])
                out[p] = JS.u8c(JS.round(cur + (target - cur) * k))
                continue
            }
            let i = p * 4
            if s.mode == .erase && !s.lockTransparency {
                out[i + 3] = JS.u8c(JS.round(Double(out[i + 3]) * (1 - k)))
                continue
            }
            if s.lockTransparency && out[i + 3] == 0 { continue }
            let src = s.mode == .erase ? bg : pixelColor ? own : cs
            if s.blend == .pigment {
                // `blendPixel`'s paint mix on the 8-bit colours, with their spectra cached.
                let bytes = s.mode == .erase ? s.background : pixelColor ? ownBytes : s.color
                let as_ = src[3] * k
                if !(as_ > 0) { continue }
                let ao = as_ + (Double(out[i + 3]) / 255) * (1 - as_)
                mixPigment8(Int(out[i]), Int(out[i + 1]), Int(out[i + 2]), bytes[0], bytes[1], bytes[2], as_ / ao, &mix)
                out[i] = JS.u8c(JS.round(mix[0] * 255))
                out[i + 1] = JS.u8c(JS.round(mix[1] * 255))
                out[i + 2] = JS.u8c(JS.round(mix[2] * 255))
                if !s.lockTransparency { out[i + 3] = JS.u8c(JS.round(ao * 255)) }
                continue
            }
            for ch in 0..<4 { cb[ch] = Double(out[i + ch]) / 255 }
            let o = blendPixel(s.blend, cb, src, k)
            out[i] = JS.u8c(JS.round(o[0] * 255))
            out[i + 1] = JS.u8c(JS.round(o[1] * 255))
            out[i + 2] = JS.u8c(JS.round(o[2] * 255))
            if !s.lockTransparency { out[i + 3] = JS.u8c(JS.round(o[3] * 255)) }
        }
    }
    return out
}
