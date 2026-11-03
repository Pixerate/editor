// Portions ported from photocraft/crates/paint/src/rng.rs (MIT OR Apache-2.0, © ArtCraft Team and
// contributors) by way of packages/core/src/paint/rand.ts. See THIRD_PARTY_NOTICES.md.

import Foundation

/// Counter-based seeded randomness on 32-bit integer hashes, bit-exact with `paint/rand.ts`:
/// every value is a pure function of its inputs, so strokes and papers regenerate identically on
/// every machine and in every language. Integer arguments wrap to 32 bits, as JavaScript's `| 0`
/// does.
public enum PixerateRandom {
    /// A 32-bit finaliser (murmur3's `fmix32`).
    @inlinable
    public static func mix32(_ value: UInt32) -> UInt32 {
        var h = value
        h ^= h >> 16
        h = h &* 0x85EB_CA6B
        h ^= h >> 13
        h = h &* 0xC2B2_AE35
        h ^= h >> 16
        return h
    }

    /// Hash of integer coordinates and a salt to [0, 1).
    @inlinable
    public static func hash2(_ x: Int, _ y: Int, _ salt: Int) -> Double {
        let xi = UInt32(truncatingIfNeeded: x)
        let yi = UInt32(truncatingIfNeeded: y)
        let si = UInt32(truncatingIfNeeded: salt)
        let h = mix32((xi &* 0x27D4_EB2D) ^ mix32(yi &+ (si &* 0x1656_67B1)))
        return Double(h) / 4_294_967_296
    }

    /// Uniform in [0, 1) from a seed, an index and a stream (one stream per random quantity).
    @inlinable
    public static func rand01(_ seed: Int, _ index: Int, _ stream: Int) -> Double {
        hash2(index, stream, seed)
    }

    /// Uniform in [-1, 1).
    @inlinable
    public static func randSigned(_ seed: Int, _ index: Int, _ stream: Int) -> Double {
        rand01(seed, index, stream) * 2 - 1
    }

    /// A seed from a string (FNV-1a over its UTF-16 code units, as `charCodeAt` reads them, then mixed).
    public static func seedFromString(_ text: String) -> UInt32 {
        var h: UInt32 = 0x811C_9DC5
        for unit in text.utf16 {
            h ^= UInt32(unit)
            h = h &* 0x0100_0193
        }
        return mix32(h)
    }
}

/// `Math.round` for the non-negative values it is used on here: halves round up.
@usableFromInline
func jsRound(_ x: Double) -> Double { (x + 0.5).rounded(.down) }

/// A periodic lattice of `px × py` random values (stored as `Float`, as the TS `Float32Array`),
/// sampled with smooth interpolation.
private struct Lattice {
    let px: Int
    let py: Int
    let values: [Float]

    init(_ px: Int, _ py: Int, salt: Int) {
        self.px = px
        self.py = py
        var v = [Float](repeating: 0, count: px * py)
        for j in 0 ..< py { for i in 0 ..< px { v[j * px + i] = Float(PixerateRandom.hash2(i, j, salt)) } }
        values = v
    }

    /// Value noise at (x, y) in lattice cells; wraps every `px` / `py` cells.
    func at(_ x: Double, _ y: Double) -> Double {
        let smooth = { (t: Double) in t * t * (3 - 2 * t) }
        let x0 = x.rounded(.down)
        let y0 = y.rounded(.down)
        let tx = smooth(x - x0)
        let ty = smooth(y - y0)
        let i0 = ((Int(x0) % px) + px) % px
        let j0 = ((Int(y0) % py) + py) % py
        let i1 = (i0 + 1) % px
        let j1 = (j0 + 1) % py
        let v = { (k: Int) in Double(values[k]) }
        let a = v(j0 * px + i0) + (v(j0 * px + i1) - v(j0 * px + i0)) * tx
        let b = v(j1 * px + i0) + (v(j1 * px + i1) - v(j1 * px + i0)) * tx
        return a + (b - a) * ty
    }
}

/// Tileable fractal value noise in 0…1 over a `size`-pixel square: `cellsX × cellsY` lattice cells
/// at the base octave, doubling per octave, so the result repeats exactly every `size` pixels.
public struct TileableNoise {
    public let size: Double
    private let octaves: [Lattice]

    public init(size: Double, cellsX: Double, cellsY: Double, octaves count: Int, salt: Int) {
        self.size = size
        var cx = max(1, Int(jsRound(cellsX)))
        var cy = max(1, Int(jsRound(cellsY)))
        var list: [Lattice] = []
        for o in 0 ..< max(0, count) {
            list.append(Lattice(cx, cy, salt: Int(Int32(truncatingIfNeeded: salt &+ o &* 7919))))
            cx *= 2
            cy *= 2
        }
        octaves = list
    }

    /// Fractal noise at pixel (x, y).
    public func at(_ x: Double, _ y: Double) -> Double {
        var sum = 0.0
        var amp = 1.0
        var norm = 0.0
        let u = x / size
        let v = y / size
        for l in octaves {
            sum += l.at(u * Double(l.px), v * Double(l.py)) * amp
            norm += amp
            amp *= 0.5
        }
        return norm > 0 ? sum / norm : 0.5
    }
}
