// Seeded, portable noise (#807), ported line for line from packages/core/src/geom/noise.ts: value
// and gradient noise in 2-D and 3-D and fractal sums. Integer hashing (UInt32 wrapping, the bit
// patterns of the TS Math.imul) and plain Double arithmetic in the TS order, so results match the
// TypeScript bit for bit (the shared fixtures in GeometryVectorTests pin it). Within [-1, 1].
import Foundation
import PixerateRaster

public enum NoiseKind: String, Sendable {
    case gradient, value
}

/// A 32-bit hash of integer lattice coordinates and a seed (`hash` in noise.ts).
@inline(__always)
private func noiseHash(_ x: Int32, _ y: Int32, _ z: Int32, _ seed: Int32) -> UInt32 {
    var h = UInt32(bitPattern: seed)
        ^ (UInt32(bitPattern: x) &* 0x27d4_eb2d)
        ^ (UInt32(bitPattern: y) &* 0x1656_67b1)
        ^ (UInt32(bitPattern: z) &* 0x1b87_3593)
    h = (h ^ (h >> 16)) &* 0x85eb_ca6b
    h = (h ^ (h >> 13)) &* 0xc2b2_ae35
    h ^= h >> 16
    return h
}

/// `Math.floor(v) | 0`.
@inline(__always) private func cellOf(_ v: Double) -> Int32 { JS.i32(floor(v)) }
@inline(__always) private func fade(_ t: Double) -> Double { t * t * t * (t * (t * 6 - 15) + 10) }
@inline(__always) private func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }
@inline(__always) private func clamp1(_ v: Double) -> Double { v > 1 ? 1 : v < -1 ? -1 : v }
@inline(__always) private func latticeValue(_ h: UInt32) -> Double { (Double(h) / 4_294_967_295) * 2 - 1 }

private func grad2(_ h: UInt32, _ x: Double, _ y: Double) -> Double {
    switch h & 7 {
    case 0: return x + y
    case 1: return -x + y
    case 2: return x - y
    case 3: return -x - y
    case 4: return x
    case 5: return -x
    case 6: return y
    default: return -y
    }
}

private func grad3(_ h: UInt32, _ x: Double, _ y: Double, _ z: Double) -> Double {
    switch h & 15 {
    case 0, 12: return x + y
    case 1, 13: return -x + y
    case 2: return x - y
    case 3: return -x - y
    case 4: return x + z
    case 5: return -x + z
    case 6: return x - z
    case 7: return -x - z
    case 8: return y + z
    case 9, 14: return -y + z
    case 10: return y - z
    default: return -y - z
    }
}

/// Noise at (x, y), in [-1, 1] (`noise2`).
public func noise2(_ x: Double, _ y: Double, seed: Double = 0, kind: NoiseKind = .gradient) -> Double {
    let s = JS.i32(seed)
    let xi = cellOf(x), yi = cellOf(y)
    let xf = x - floor(x), yf = y - floor(y)
    let u = fade(xf), v = fade(yf)
    if kind == .value {
        let a = latticeValue(noiseHash(xi, yi, 0, s))
        let b = latticeValue(noiseHash(xi &+ 1, yi, 0, s))
        let c = latticeValue(noiseHash(xi, yi &+ 1, 0, s))
        let d = latticeValue(noiseHash(xi &+ 1, yi &+ 1, 0, s))
        return clamp1(lerp(lerp(a, b, u), lerp(c, d, u), v))
    }
    let a = grad2(noiseHash(xi, yi, 0, s), xf, yf)
    let b = grad2(noiseHash(xi &+ 1, yi, 0, s), xf - 1, yf)
    let c = grad2(noiseHash(xi, yi &+ 1, 0, s), xf, yf - 1)
    let d = grad2(noiseHash(xi &+ 1, yi &+ 1, 0, s), xf - 1, yf - 1)
    return clamp1(lerp(lerp(a, b, u), lerp(c, d, u), v))
}

/// Noise at (x, y, z), in [-1, 1] (`noise3`).
public func noise3(_ x: Double, _ y: Double, _ z: Double, seed: Double = 0, kind: NoiseKind = .gradient) -> Double {
    let s = JS.i32(seed)
    let xi = cellOf(x), yi = cellOf(y), zi = cellOf(z)
    let xf = x - floor(x), yf = y - floor(y), zf = z - floor(z)
    let u = fade(xf), v = fade(yf), w = fade(zf)
    func corner(_ dx: Int32, _ dy: Int32, _ dz: Int32) -> Double {
        let h = noiseHash(xi &+ dx, yi &+ dy, zi &+ dz, s)
        return kind == .value ? latticeValue(h) : grad3(h, xf - Double(dx), yf - Double(dy), zf - Double(dz))
    }
    let x00 = lerp(corner(0, 0, 0), corner(1, 0, 0), u)
    let x10 = lerp(corner(0, 1, 0), corner(1, 1, 0), u)
    let x01 = lerp(corner(0, 0, 1), corner(1, 0, 1), u)
    let x11 = lerp(corner(0, 1, 1), corner(1, 1, 1), u)
    return clamp1(lerp(lerp(x00, x10, v), lerp(x01, x11, v), w))
}

private func fbmSum(_ octaves: Int, _ lacunarity: Double, _ gain: Double, _ sample: (Double, Int) -> Double) -> Double {
    var sum = 0.0, norm = 0.0, amplitude = 1.0, frequency = 1.0
    for o in 0..<octaves {
        sum += amplitude * sample(frequency, o)
        norm += amplitude
        amplitude *= gain
        frequency *= lacunarity
    }
    return norm > 0 ? clamp1(sum / norm) : 0
}

@inline(__always) private func octavesOf(_ o: Double?) -> Int { Int(min(12, max(1, floor(o ?? 4)))) }

/// Fractal noise at (x, y) (`fbm2`): octaves of noise, each with its own seed, normalised to [-1, 1].
public func fbm2(_ x: Double, _ y: Double, seed: Double = 0, kind: NoiseKind = .gradient, octaves: Double? = nil, lacunarity: Double = 2, gain: Double = 0.5) -> Double {
    fbmSum(octavesOf(octaves), lacunarity, gain) { f, o in noise2(x * f, y * f, seed: seed + Double(o) * 1013, kind: kind) }
}

/// Fractal noise at (x, y, z) (`fbm3`).
public func fbm3(_ x: Double, _ y: Double, _ z: Double, seed: Double = 0, kind: NoiseKind = .gradient, octaves: Double? = nil, lacunarity: Double = 2, gain: Double = 0.5) -> Double {
    fbmSum(octavesOf(octaves), lacunarity, gain) { f, o in noise3(x * f, y * f, z * f, seed: seed + Double(o) * 1013, kind: kind) }
}
