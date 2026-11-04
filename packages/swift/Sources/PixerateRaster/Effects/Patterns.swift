// Portions ported from photocraft-main/crates/compose/src/pattern.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import Foundation

/**
 * Pattern paint for pattern overlays, pattern strokes and bevel textures: a tile repeated over
 * the plane from an origin (the layer's top-left when linked, else the canvas origin, plus the
 * phase), scaled and rotated about it. Samples are bilinear and wrap around, on premultiplied
 * colour, so whole-pixel placements at 100 % reproduce the tile exactly. The port of
 * `raster/effects/patterns.ts`.
 *
 * Patterns come from the document (PSD pattern resources) or from the built-in set below, so a
 * pattern effect always has something to paint even in a document without patterns.
 */

/// A pattern tile: straight-alpha RGBA.
public final class EffectPattern: @unchecked Sendable {
    public let id: String
    public let name: String
    public let width: Int
    public let height: Int
    public let data: [UInt8]
    public init(id: String, name: String, width: Int, height: Int, data: [UInt8]) {
        self.id = id
        self.name = name
        self.width = width
        self.height = height
        self.data = data
    }
}

/// A pattern converted once for sampling (premultiplied 0..1).
public final class PatternTile: @unchecked Sendable {
    public let w: Int
    public let h: Int
    private let px: [Float]

    public init(width: Int, height: Int, data: [UInt8]) {
        w = Swift.max(1, width)
        h = Swift.max(1, height)
        let n = w * h
        var px = [Float](repeating: 0, count: n * 4)
        let at = { (i: Int) -> Double in i < data.count ? Double(data[i]) : 0 }
        for i in 0..<n {
            let a = at(i * 4 + 3) / 255
            px[i * 4] = Float((at(i * 4) / 255) * a)
            px[i * 4 + 1] = Float((at(i * 4 + 1) / 255) * a)
            px[i * 4 + 2] = Float((at(i * 4 + 2) / 255) * a)
            px[i * 4 + 3] = Float(a)
        }
        self.px = px
    }

    public convenience init(_ p: EffectPattern) {
        self.init(width: p.width, height: p.height, data: p.data)
    }

    /// Bilinear wrapping sample at tile coordinates (pixel centres at `i + 0.5`), straight alpha into `out`.
    public func sample(_ uIn: Double, _ vIn: Double, _ out: inout [Double]) {
        let u = uIn - 0.5
        let v = vIn - 0.5
        let x0 = JS.floor(u)
        let y0 = JS.floor(v)
        let fx = u - x0
        let fy = v - y0
        var r = 0.0, g = 0.0, b = 0.0, a = 0.0
        for dy in 0..<2 {
            let wy = dy != 0 ? fy : 1 - fy
            if wy == 0 { continue }
            let yi = Int(jsMod(jsMod(y0 + Double(dy), Double(h)) + Double(h), Double(h)))
            for dx in 0..<2 {
                let wx = dx != 0 ? fx : 1 - fx
                if wx == 0 { continue }
                let xi = Int(jsMod(jsMod(x0 + Double(dx), Double(w)) + Double(w), Double(w)))
                let k = wx * wy
                let i = (yi * w + xi) * 4
                r += Double(px[i]) * k
                g += Double(px[i + 1]) * k
                b += Double(px[i + 2]) * k
                a += Double(px[i + 3]) * k
            }
        }
        if a <= 0 {
            out[0] = 0
            out[1] = 0
            out[2] = 0
            out[3] = 0
            return
        }
        out[0] = r / a
        out[1] = g / a
        out[2] = b / a
        out[3] = JS.min(1, a)
    }
}

/// JavaScript's `%` on numbers (the sign follows the dividend).
@inline(__always) func jsMod(_ a: Double, _ b: Double) -> Double { a.truncatingRemainder(dividingBy: b) }

/// Where a pattern sits: maps a document point to tile coordinates.
public struct PatternPlacement: Sendable {
    private let ox: Double
    private let oy: Double
    private let c: Double
    private let s: Double
    private let inv: Double

    /// `anchor`: the layer's top-left (used when `link`); `phase` in px; `scale` a fraction; `angle` degrees counter-clockwise.
    public init(anchor: EffectPoint, link: Bool, phase: EffectPoint, scale: Double, angle: Double) {
        let bx = link ? anchor.x : 0
        let by = link ? anchor.y : 0
        ox = bx + phase.x
        oy = by + phase.y
        inv = scale.isFinite && scale > 1e-3 ? 1 / scale : 1
        let a = ((angle.isFinite ? angle : 0) * Double.pi) / 180
        c = JS.cos(a)
        s = JS.sin(a)
    }

    /// Tile coordinates of the document point `(x, y)` into `out[0..1]`.
    public func map(_ x: Double, _ y: Double, _ out: inout [Double]) {
        let dx = x - ox
        let dy = y - oy
        // Undo a counter-clockwise rotation (y points down).
        out[0] = (dx * c - dy * s) * inv
        out[1] = (dx * s + dy * c) * inv
    }
}

// MARK: - Built-in patterns

private struct Builtin: Sendable {
    let id: String
    let name: String
    let size: Int
    let paint: @Sendable (Int, Int) -> [UInt8]
}

private let BUILTINS: [Builtin] = [
    Builtin(id: "checker", name: "Checker", size: 16) { x, y in (x < 8) != (y < 8) ? [204, 204, 204, 255] : [255, 255, 255, 255] },
    Builtin(id: "stripes", name: "Diagonal Stripes", size: 16) { x, y in (x + y) % 16 < 8 ? [40, 40, 40, 255] : [235, 235, 235, 255] },
    Builtin(id: "dots", name: "Dots", size: 12) { x, y in
        let d = JS.hypot(Double(x) + 0.5 - 6, Double(y) + 0.5 - 6)
        let a = JS.max(0, JS.min(1, 3.5 - d))
        let v = JS.u8c(JS.round(255 - a * 215))
        return [v, v, v, 255]
    },
    Builtin(id: "grid", name: "Grid", size: 16) { x, y in x == 0 || y == 0 ? [90, 90, 90, 255] : [250, 250, 250, 255] },
    Builtin(id: "noise", name: "Noise", size: 64) { x, y in
        let v = JS.u8c(JS.round(hashNoise(Double(x), Double(y)) * 255))
        return [v, v, v, 255]
    },
]

/// Ids of the built-in patterns (`checker`, `stripes`, `dots`, `grid`, `noise`).
public func builtinPatternIds() -> [String] { BUILTINS.map(\.id) }

private let builtinCache = Locked([String: EffectPattern]())

/// A built-in pattern by id, or `nil`.
public func builtinPattern(_ id: String) -> EffectPattern? {
    guard let def = BUILTINS.first(where: { $0.id == id }) else { return nil }
    return builtinCache.with { cache in
        if let p = cache[id] { return p }
        var data = [UInt8](repeating: 0, count: def.size * def.size * 4)
        for y in 0..<def.size {
            for x in 0..<def.size {
                let px = def.paint(x, y)
                for c in 0..<4 { data[(y * def.size + x) * 4 + c] = px[c] }
            }
        }
        let p = EffectPattern(id: id, name: def.name, width: def.size, height: def.size, data: data)
        cache[id] = p
        return p
    }
}

/**
 * Deterministic per-pixel value in 0..1 hashed from document coordinates, so effect noise is
 * stable across renders and tiles (photocraft's `hash_noise`).
 */
public func hashNoise(_ x: Double, _ y: Double) -> Double {
    var h = UInt32(bitPattern: JS.i32(x)) &* 0x8DA6_B343 ^ UInt32(bitPattern: JS.i32(y)) &* 0xD816_3841 ^ 0x9E37_79B9
    h ^= h >> 15
    h = h &* 0x2C1B_3C6D
    h ^= h >> 12
    return Double(h & 0xFFFF) / 65536
}
