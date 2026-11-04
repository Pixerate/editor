// Portions ported from photocraft/crates/paint/src/procedural.rs (MIT OR Apache-2.0, © ArtCraft Team
// and contributors) by way of packages/core/src/paint/grain.ts. See THIRD_PARTY_NOTICES.md.

import Foundation
import PixerateCore
import PixerateRaster

/**
 * Paper grain (`paint/grain.ts`): generated height maps (0 = valley, 1 = peak) that tile across a
 * surface, and how much of a dry dab the grain catches. Everything is generated from a pattern
 * and a seed, so no texture is bundled.
 */

public let GRAIN_PATTERNS = ["smooth", "cold-pressed", "hot-pressed", "rough", "vellum", "laid", "ingres", "sanded", "canvas", "linen", "gesso"]

/// How a height map is tuned for one kind of media.
public struct GrainTuning: Equatable, Sendable {
    /// Height contrast around the middle, 0..3 (default 1).
    public var contrast: Double
    /// Swap peaks and valleys (default false).
    public var invert: Bool

    public init(contrast: Double = 1, invert: Bool = false) {
        self.contrast = contrast
        self.invert = invert
    }

    public var json: JSONValue { ["contrast": .number(contrast), "invert": .bool(invert)] }
}

/// Side of the generated grain tile in pixels (at scale 1).
public let GRAIN_TILE = 256

@inline(__always) private func clamp01(_ v: Double) -> Double { v < 0 ? 0 : v > 1 ? 1 : v }

/// One pattern's raw height (0..1) at pixel (x, y) of a `n`-pixel tile.
private func patternHeights(_ pattern: String, _ n: Int, _ seed: Int) -> [Float] {
    var out = [Float](repeating: 0, count: n * n)
    let salt = Int(Int32(truncatingIfNeeded: Int32(truncatingIfNeeded: seed) &* Int32(bitPattern: 0x9E37_79B1))) + 17
    if pattern == "smooth" { return [Float](repeating: 1, count: n * n) }
    let size = Double(n)
    func noise(_ cx: Double, _ cy: Double, _ oct: Int, _ s: Int = 0) -> TileableNoise { TileableNoise(size: size, cellsX: cx, cellsY: cy, octaves: oct, salt: salt + s) }
    let k = Double(n) / Double(GRAIN_TILE)
    let hash = { (x: Int, y: Int, s: Int) in PixerateRandom.hash2(x, y, s) }
    switch pattern {
    case "cold-pressed":
        let base = noise(20 * k, 20 * k, 4)
        let fine = noise(64 * k, 64 * k, 2, 3)
        for y in 0..<n { for x in 0..<n { out[y * n + x] = Float(clamp01((base.at(Double(x), Double(y)) - 0.5) * 1.8 + 0.5 + (fine.at(Double(x), Double(y)) - 0.5) * 0.5 + (hash(x, y, salt) - 0.5) * 0.12)) } }
    case "hot-pressed":
        let base = noise(40 * k, 40 * k, 3)
        for y in 0..<n { for x in 0..<n { out[y * n + x] = Float(clamp01((base.at(Double(x), Double(y)) - 0.5) * 1.1 + 0.6 + (hash(x, y, salt) - 0.5) * 0.08)) } }
    case "rough":
        let base = noise(10 * k, 10 * k, 5)
        let blot = noise(28 * k, 28 * k, 2, 5)
        for y in 0..<n { for x in 0..<n { out[y * n + x] = Float(clamp01((base.at(Double(x), Double(y)) - 0.5) * 2.4 + 0.5 + (blot.at(Double(x), Double(y)) - 0.5) * 0.7 + (hash(x, y, salt) - 0.5) * 0.15)) } }
    case "vellum":
        let base = noise(40 * k, 40 * k, 3)
        for y in 0..<n { for x in 0..<n { out[y * n + x] = Float(clamp01((base.at(Double(x), Double(y)) - 0.5) * 1.6 + 0.55 + (hash(x, y, salt) - 0.5) * 0.2)) } }
    case "laid":
        // Fine laid lines across, chain lines down every eighth of the tile, a little pulp noise.
        let pulp = noise(32 * k, 32 * k, 3)
        let chain = Double(n) / 8
        for y in 0..<n {
            let laid = 0.5 + 0.5 * JS.cos((2 * Double.pi * Double(y)) / 4)
            for x in 0..<n {
                let c = abs((Double(x) + 0.5).truncatingRemainder(dividingBy: chain) - chain / 2) / (chain / 2)
                let chainLine = c > 0.94 ? -0.35 : 0
                out[y * n + x] = Float(clamp01(0.3 + 0.5 * laid + chainLine + (pulp.at(Double(x), Double(y)) - 0.5) * 0.6))
            }
        }
    case "ingres":
        // Long vertical fibres with grit.
        let fibres = noise(64 * k, 12 * k, 3)
        let base = noise(16 * k, 16 * k, 3, 7)
        for y in 0..<n {
            for x in 0..<n {
                let g = hash(x, y, salt ^ 0x55)
                out[y * n + x] = Float(clamp01((fibres.at(Double(x), Double(y)) - 0.5) * 1.5 + (base.at(Double(x), Double(y)) - 0.5) * 0.7 + 0.55 + (g < 0.1 ? -0.3 : 0)))
            }
        }
    case "sanded":
        // Fine grit: high-frequency noise and sharp single-pixel pits.
        let grit = noise(96 * k, 96 * k, 2)
        for y in 0..<n {
            for x in 0..<n {
                let h = hash(x, y, salt)
                out[y * n + x] = Float(clamp01((grit.at(Double(x), Double(y)) - 0.5) * 2.4 + 0.5 + (h - 0.5) * 0.7))
            }
        }
    case "canvas", "linen":
        // Over / under weave; linen has finer, irregular threads.
        let period = (pattern == "canvas" ? 8.0 : 5.0) * k
        // An even thread count keeps the over / under alternation seamless across the tile edge.
        let threads = Swift.max(2, 2 * JS.round(Double(n) / period / 2))
        let p = Double(n) / threads
        let slub = noise(threads, threads, 2, 11)
        for y in 0..<n {
            for x in 0..<n {
                let fx = (Double(x) + 0.5) / p
                let fy = (Double(y) + 0.5) / p
                let cx = JS.floor(fx)
                let cy = JS.floor(fy)
                let warp = JS.sin(Double.pi * (fx - cx))
                let weft = JS.sin(Double.pi * (fy - cy))
                let top = (cx + cy).truncatingRemainder(dividingBy: 2) == 0 ? warp : weft
                let irregular = pattern == "linen" ? (slub.at(Double(x), Double(y)) - 0.5) * 0.5 : 0
                out[y * n + x] = Float(clamp01(0.2 + 0.7 * top + irregular + (hash(x, y, salt) - 0.5) * 0.15))
            }
        }
    case "gesso":
        // Brushed gesso: soft horizontal streaks over a fine tooth.
        let streaks = noise(2 * k, 28 * k, 3)
        let tooth = noise(64 * k, 64 * k, 2, 13)
        for y in 0..<n { for x in 0..<n { out[y * n + x] = Float(clamp01((streaks.at(Double(x), Double(y)) - 0.5) * 1.8 + (tooth.at(Double(x), Double(y)) - 0.5) * 0.9 + 0.55)) } }
    default:
        break
    }
    return out
}

private let rawCache = Locked(OrderedMap<String, [Float]>())

/// The raw height map of a pattern (`GRAIN_TILE` square, 0..1), generated once per pattern and seed.
public func grainHeights(_ pattern: String, _ seed: Int, _ size: Int = GRAIN_TILE) -> [Float] {
    let key = "\(pattern):\(seed):\(size)"
    if let h = rawCache.with({ $0.get(key) }) { return h }
    let h = patternHeights(pattern, size, seed)
    rawCache.with { cache in
        if cache.count > 32, let first = cache.first { _ = cache.delete(first.key) }
        cache.set(key, h)
    }
    return h
}

/// What a `PaperGrain` reads from a paper.
public protocol PaperGrainSettings {
    var pattern: String { get }
    var seed: Int { get }
    var scale: Double { get }
    var tiling: String { get }
    var dry: GrainTuning { get }
    var wet: GrainTuning { get }
    var offset: LayerOffset? { get }
}

/**
 * A paper's height field over the canvas (document pixels), tuned for one kind of media. Read it
 * with `at(x, y)`: bilinear, tiled by `paper.tiling`, at `paper.scale`.
 */
public final class PaperGrain: @unchecked Sendable {
    public let size = GRAIN_TILE
    private let heights: [Float]
    private let scale: Double
    private let mirror: Bool
    private let ox: Double
    private let oy: Double
    public let flat: Bool

    public init(_ paper: some PaperGrainSettings, media: String = "dry") {
        let raw = grainHeights(paper.pattern, paper.seed)
        let t = media == "wet" ? paper.wet : paper.dry
        flat = paper.pattern == "smooth"
        if t.contrast == 1 && !t.invert {
            heights = raw
        } else {
            heights = raw.map { r in
                let v = clamp01((Double(r) - 0.5) * t.contrast + 0.5)
                return Float(t.invert ? 1 - v : v)
            }
        }
        scale = paper.scale
        mirror = paper.tiling == "mirror"
        ox = Double(paper.offset?.x ?? 0)
        oy = Double(paper.offset?.y ?? 0)
    }

    /// Tile cell index for a coordinate in grain pixels (mirrored on odd tiles when mirroring).
    @inline(__always) private func wrap(_ v: Int) -> Int {
        let n = size
        if !mirror { return ((v % n) + n) % n }
        let p = ((v % (2 * n)) + 2 * n) % (2 * n)
        return p < n ? p : 2 * n - 1 - p
    }

    /// Height 0..1 at document position (x, y).
    public func at(_ x: Double, _ y: Double) -> Double {
        let u = (x - ox) / scale - 0.5
        let v = (y - oy) / scale - 0.5
        let x0 = JS.floor(u)
        let y0 = JS.floor(v)
        let fx = u - x0
        let fy = v - y0
        let n = size
        let ix = Int(x0), iy = Int(y0)
        let a = wrap(ix)
        let b = wrap(ix + 1)
        let c = wrap(iy) * n
        let d = wrap(iy + 1) * n
        let h = heights
        let top = Double(h[c + a]) + (Double(h[c + b]) - Double(h[c + a])) * fx
        let bot = Double(h[d + a]) + (Double(h[d + b]) - Double(h[d + a])) * fx
        return top + (bot - top) * fy
    }
}

/**
 * How much of a dry dab lands at grain height `h` (0..1): the media catches the peaks first, and
 * pressure pushes it into the valleys. `depth` is the paper's grain depth times the brush's grain
 * response; at 0 everything lands (1).
 */
public func grainCatch(_ h: Double, _ depth: Double, _ pressure: Double) -> Double {
    if depth <= 0 { return 1 }
    let t = depth * (0.75 - 0.65 * Swift.min(1, Swift.max(0, pressure)))
    let u = clamp01((h - t + 0.18) / 0.36)
    return 1 - depth + depth * u * u * (3 - 2 * u)
}
