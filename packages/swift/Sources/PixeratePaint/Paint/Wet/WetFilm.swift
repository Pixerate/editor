import Foundation
import PixerateRaster

/**
 * How wet-layer pigment looks and bakes into 8-bit pixels (`paint/wet/film.ts`): Kubelka-Munk
 * absorption `K` per channel and one scattering `S`, over what is below. Everything goes through
 * the TS core's deterministic maths (`dexp`, `dlog`, tables, + − × ÷ and `sqrt` in f64), never
 * `Math.exp` / `Math.pow`, so the bake is the same bytes as the TypeScript core's.
 */

/// Pigment mass of a full-strength wash of a colour.
public let PIGMENT_UNIT = 0.25
/// Hiding per unit of scattering.
let HIDE = 1.5
/// Scattering of fully opaque paint (`body` 1), per `PIGMENT_UNIT` of mass.
let BODY_SCATTER = 3.0
/// Smallest reflectance a colour maps to.
private let R_MIN = 1e-3
private let LN2 = 0.6931471805599453

/// 2^k for an integer k in −1022..1023.
@inline(__always) private func pow2(_ k: Int) -> Double { Double(bitPattern: UInt64(k + 1023) << 52) }

/// e^x with + − × ÷ only (a degree-11 Taylor polynomial after range reduction).
func dexp(_ x: Double) -> Double {
    if !(x > -700) { return x.isNaN ? x : 0 }
    if x > 700 { return .infinity }
    let k = JS.round(x / LN2)
    let r = x - k * LN2
    var p = 1.0 / 39916800
    p = p * r + 1.0 / 3628800
    p = p * r + 1.0 / 362880
    p = p * r + 1.0 / 40320
    p = p * r + 1.0 / 5040
    p = p * r + 1.0 / 720
    p = p * r + 1.0 / 120
    p = p * r + 1.0 / 24
    p = p * r + 1.0 / 6
    p = p * r + 0.5
    p = p * r + 1
    p = p * r + 1
    return p * pow2(Int(k))
}

/// ln x for x > 0 with + − × ÷ only (x = m·2^e, ln m by the atanh series).
func dlog(_ x: Double) -> Double {
    if !(x > 0) { return x == 0 ? -.infinity : .nan }
    let bits = x.bitPattern
    var e = Int((bits >> 52) & 0x7ff) - 1023
    if e == -1023 { return dlog(x * 18014398509481984) - 54 * LN2 }
    var m = Double(bitPattern: (bits & 0x800F_FFFF_FFFF_FFFF) | (UInt64(1023) << 52))
    if m > 1.4142135623730951 {
        m /= 2
        e += 1
    }
    let s = (m - 1) / (m + 1)
    let s2 = s * s
    var t = s2
    var sum = 1.0
    var i = 3
    while i < 40 {
        sum += t / Double(i)
        t *= s2
        i += 2
    }
    return 2 * s * sum + Double(e) * LN2
}

/// x^y for x ≥ 0, deterministically.
func dpow(_ x: Double, _ y: Double) -> Double {
    if x <= 0 { return 0 }
    return dexp(y * dlog(x))
}

/// sRGB byte → linear.
let SRGB_TO_LINEAR: [Double] = (0..<256).map { i in
    let v = Double(i) / 255
    return v <= 0.04045 ? v / 12.92 : dpow((v + 0.055) / 1.055, 2.4)
}

/// sRGB value 0..255 (not necessarily whole) → linear, interpolating the byte table.
@inline(__always) func srgbByteToLinear(_ v: Double) -> Double {
    if !(v > 0) { return 0 }
    if v >= 255 { return 1 }
    let i = Int(JS.floor(v))
    return SRGB_TO_LINEAR[i] + (SRGB_TO_LINEAR[i + 1] - SRGB_TO_LINEAR[i]) * (v - Double(i))
}

private let ENC_STEPS = 16384.0
private let ENCODE: [UInt8] = (0...16384).map { i in
    let v = Double(i) / ENC_STEPS
    let e = v <= 0.0031308 ? 12.92 * v : 1.055 * dpow(v, 1 / 2.4) - 0.055
    return UInt8(Swift.min(255, Swift.max(0, JS.round(e * 255))))
}

/// Linear 0..1 → sRGB byte (16384-step table).
@inline(__always) func linearToSrgb8(_ v: Double) -> Int {
    if !(v > 0) { return 0 }
    if v >= 1 { return 255 }
    return Int(ENCODE[Int(JS.round(v * ENC_STEPS))])
}

/// The pigment (K r, g, b, S per unit of mass) of an sRGB colour (0..1) at `body` 0 (transparent) .. 1 (opaque).
func pigmentOf(_ rgb: [Double], _ body: Double) -> [Double] {
    var out = [0.0, 0.0, 0.0, 0.0]
    let b = Swift.min(1, Swift.max(0, body))
    let s = (b * BODY_SCATTER) / PIGMENT_UNIT
    for c in 0..<3 {
        let v = Int(Swift.min(255, Swift.max(0, JS.round(rgb[c] * 255))))
        let r = Swift.max(R_MIN, SRGB_TO_LINEAR[v])
        let kt = -dlog(r) / 2 / PIGMENT_UNIT
        let ko = ((1 - r) * (1 - r)) / (2 * r) * s
        out[c] = (1 - b) * kt + b * ko
    }
    out[3] = s
    return out
}

private let EXP_RES = 256.0
private let EXP_MAX = 24.0
private let EXP_TABLE: [Double] = (0..<(24 * 256 + 2)).map { dexp(-Double($0) / EXP_RES) }

@inline(__always) private func interp(_ t: Double) -> Double {
    let i = Int(JS.floor(t))
    return EXP_TABLE[i] + (EXP_TABLE[i + 1] - EXP_TABLE[i]) * (t - Double(i))
}

/// e^(−x) for x ≥ 0 (deterministic: a table built with `dexp`, interpolated).
@inline(__always) func expNeg(_ x: Double) -> Double {
    if !(x > 0) { return 1 }
    if x >= EXP_MAX { return 0 }
    return interp(x * EXP_RES)
}

/// Kubelka-Munk reflectance of an infinitely thick layer with absorption over scattering `ks`.
@inline(__always) private func rinf(_ ks: Double) -> Double { 1 + ks - (ks * ks + 2 * ks).squareRoot() }

/// Linear reflectance of a film of pigment `k` (3) and `s` over `below` (linear).
func filmReflectance(_ k0: Double, _ k1: Double, _ k2: Double, _ s: Double, _ b0: Double, _ b1: Double, _ b2: Double) -> [Double] {
    let hide = s > 0 ? 1 - expNeg(HIDE * s) : 0
    let keep = 1 - hide
    let inv = s > 1e-9 ? 1 / s : 0
    return [
        (hide > 0 ? hide * rinf(k0 * inv) : 0) + keep * expNeg(2 * k0) * b0,
        (hide > 0 ? hide * rinf(k1 * inv) : 0) + keep * expNeg(2 * k1) * b1,
        (hide > 0 ? hide * rinf(k2 * inv) : 0) + keep * expNeg(2 * k2) * b2,
    ]
}

/// The sRGB colour (0..1) of pigment `k`, `s` over white: what a brush picking it up sees.
func pigmentColor(_ k0: Double, _ k1: Double, _ k2: Double, _ s: Double) -> [Double] {
    let lin = filmReflectance(k0, k1, k2, s, 1, 1, 1)
    return lin.map { Double(linearToSrgb8($0)) / 255 }
}

/// The alpha an encoded film value `e` needs over paper value `p` (bytes), at least `alpha`.
@inline(__always) private func needAlpha(_ e: Int, _ p: Int, _ alpha: Double) -> Double {
    if e < p { return Swift.max(alpha, 1 - Double(e) / Double(p)) }
    if e > p { return Swift.max(alpha, Double(e - p) / Double(255 - p)) }
    return alpha
}

/// Bakes one pixel (`filmPixel`): pigment over layer pixel `px[i..i+3]` on paper `paper`, into `out[o..o+3]`.
func filmPixel(_ k0: Double, _ k1: Double, _ k2: Double, _ s: Double, _ px: [UInt8], _ i: Int, _ paper: [Int], _ wet: Double, _ out: inout [UInt8], _ o: Int) {
    let pa = Int(px[i + 3])
    if !(k0 > 1e-7 || k1 > 1e-7 || k2 > 1e-7 || s > 1e-7) && wet <= 0 {
        out[o] = px[i]
        out[o + 1] = px[i + 1]
        out[o + 2] = px[i + 2]
        out[o + 3] = px[i + 3]
        return
    }
    let a = Double(pa) / 255
    let p0 = paper[0], p1 = paper[1], p2 = paper[2]
    let b0 = srgbByteToLinear(a * Double(px[i]) + (1 - a) * Double(p0))
    let b1 = srgbByteToLinear(a * Double(px[i + 1]) + (1 - a) * Double(p1))
    let b2 = srgbByteToLinear(a * Double(px[i + 2]) + (1 - a) * Double(p2))
    let r = filmReflectance(k0, k1, k2, s, b0, b1, b2)
    let dark = 1 - 0.07 * wet
    let e0 = linearToSrgb8(r[0] * dark)
    let e1 = linearToSrgb8(r[1] * dark)
    let e2 = linearToSrgb8(r[2] * dark)
    var alpha = needAlpha(e2, p2, needAlpha(e1, p1, needAlpha(e0, p0, 0)))
    if s > 0 && alpha < 1 { alpha += (1 - expNeg(HIDE * s)) * (1 - alpha) }
    if a > alpha { alpha = a }
    if alpha <= 0 {
        out[o] = px[i]
        out[o + 1] = px[i + 1]
        out[o + 2] = px[i + 2]
        out[o + 3] = 0
        return
    }
    let a8 = Swift.max(JS.round(Swift.min(1, alpha) * 255), Double(pa))
    let al = a8 / 255
    let inv = 1 / al
    let k = 1 - al
    out[o] = JS.u8c(JS.round(Swift.min(255, Swift.max(0, (Double(e0) - k * Double(p0)) * inv))))
    out[o + 1] = JS.u8c(JS.round(Swift.min(255, Swift.max(0, (Double(e1) - k * Double(p1)) * inv))))
    out[o + 2] = JS.u8c(JS.round(Swift.min(255, Swift.max(0, (Double(e2) - k * Double(p2)) * inv))))
    out[o + 3] = JS.u8c(a8)
}

/// The pigment a layer pixel holds over the paper, as a transparent film: K r, g, b, S.
func pixelPigment(_ px: [UInt8], _ i: Int, _ paper: [Int]) -> [Double] {
    var out = [0.0, 0.0, 0.0, 0.0]
    let a = Double(px[i + 3]) / 255
    for c in 0..<3 {
        let p = Swift.max(R_MIN, SRGB_TO_LINEAR[paper[c]])
        let below = Swift.max(R_MIN, srgbByteToLinear(a * Double(px[i + c]) + (1 - a) * Double(paper[c])))
        out[c] = below < p ? -dlog(below / p) / 2 : 0
    }
    return out
}

@inline(__always) private func expT(_ x: Double) -> Double {
    if !(x > 0) { return 1 }
    if x >= EXP_MAX { return 0 }
    return interp(x * EXP_RES)
}

@inline(__always) private func encode(_ v: Double) -> Int {
    if !(v > 0) { return 0 }
    if v >= 1 { return 255 }
    return Int(ENCODE[Int(JS.round(v * ENC_STEPS))])
}

/**
 * `filmPixel` over a whole tile (`shadeTile`): settled pigment at plane offset `d` of the slot `f`,
 * suspended at `p` (or −1), surface and paper water at `rho` / `sw` (or −1: no wet darkening),
 * settled and suspended light at `dl` / `pl` (or −1). `src` is the base tile (or nil); writes `out`
 * (a copy of `src` where nothing changes). Returns whether any pixel was shaded.
 */
func shadeTile(_ f: UnsafeMutablePointer<Float>, _ d: Int, _ p: Int, _ rho: Int, _ sw: Int, _ src: [UInt8]?, _ out: inout [UInt8], _ w: Int, _ h: Int, _ paper: [Int], _ dl: Int = -1, _ pl: Int = -1) -> Bool {
    let plane = WET_PLANE
    let side = SLOT_SIDE
    let p0 = paper[0], p1 = paper[1], p2 = paper[2]
    let lp0 = SRGB_TO_LINEAR[p0], lp1 = SRGB_TO_LINEAR[p1], lp2 = SRGB_TO_LINEAR[p2]
    var any = false
    for y in 0..<h {
        for x in 0..<w {
            let c = (y + 1) * side + x + 1
            var k0 = Double(f[d + c])
            var k1 = Double(f[d + plane + c])
            var k2 = Double(f[d + 2 * plane + c])
            var s = Double(f[d + 3 * plane + c])
            if p >= 0 {
                k0 += Double(f[p + c])
                k1 += Double(f[p + plane + c])
                k2 += Double(f[p + 2 * plane + c])
                s += Double(f[p + 3 * plane + c])
            }
            var wet = 0.0
            if rho >= 0 {
                wet = Double(f[rho + c]) * 4 + Double(f[sw + c])
                if wet > 1 { wet = 1 }
            }
            if !(k0 > 1e-7 || k1 > 1e-7 || k2 > 1e-7 || s > 1e-7) && wet <= 0 { continue }
            any = true
            let i = (y * 256 + x) * 4
            let pa = src.map { Int($0[i + 3]) } ?? 0
            let a = Double(pa) / 255
            let na = 1 - a
            let b0 = src != nil ? srgbByteToLinear(a * Double(src![i]) + na * Double(p0)) : lp0
            let b1 = src != nil ? srgbByteToLinear(a * Double(src![i + 1]) + na * Double(p1)) : lp1
            let b2 = src != nil ? srgbByteToLinear(a * Double(src![i + 2]) + na * Double(p2)) : lp2
            var hide = 0.0
            if s > 0 {
                let x0 = HIDE * s
                hide = 1 - (x0 >= EXP_MAX ? 0 : interp(x0 * EXP_RES))
            }
            let keep = 1 - hide
            let inv = s > 1e-9 ? 1 / s : 0
            var r0 = keep * expT(2 * k0) * b0
            var r1 = keep * expT(2 * k1) * b1
            var r2 = keep * expT(2 * k2) * b2
            if hide > 0 {
                r0 += hide * rinf(k0 * inv)
                r1 += hide * rinf(k1 * inv)
                r2 += hide * rinf(k2 * inv)
            }
            if dl >= 0 {
                var l = Double(f[dl + c])
                if pl >= 0 { l += Double(f[pl + c]) }
                if l > 1e-7 {
                    if l > 1 { l = 1 }
                    var w0 = keep * expT(2 * k0)
                    var w1 = keep * expT(2 * k1)
                    var w2 = keep * expT(2 * k2)
                    if hide > 0 {
                        w0 += hide * rinf(k0 * inv)
                        w1 += hide * rinf(k1 * inv)
                        w2 += hide * rinf(k2 * inv)
                    }
                    r0 += l * (w0 - r0)
                    r1 += l * (w1 - r1)
                    r2 += l * (w2 - r2)
                }
            }
            let dark = 1 - 0.07 * wet
            let e0 = encode(r0 * dark)
            let e1 = encode(r1 * dark)
            let e2 = encode(r2 * dark)
            var alpha = needAlpha(e2, p2, needAlpha(e1, p1, needAlpha(e0, p0, 0)))
            if hide > 0 && alpha < 1 { alpha += hide * (1 - alpha) }
            if a > alpha { alpha = a }
            if alpha <= 0 {
                out[i + 3] = 0
                continue
            }
            let a8 = Swift.max(JS.round(Swift.min(1, alpha) * 255), Double(pa))
            let al = a8 / 255
            let ia = 1 / al
            let k = 1 - al
            out[i] = JS.u8c(JS.round(Swift.min(255, Swift.max(0, (Double(e0) - k * Double(p0)) * ia))))
            out[i + 1] = JS.u8c(JS.round(Swift.min(255, Swift.max(0, (Double(e1) - k * Double(p1)) * ia))))
            out[i + 2] = JS.u8c(JS.round(Swift.min(255, Swift.max(0, (Double(e2) - k * Double(p2)) * ia))))
            out[i + 3] = JS.u8c(a8)
        }
    }
    return any
}

/**
 * Light paint in a wet layer as an 8-bit light tile (`shadeLightTile`): light mass (settled at `dl`,
 * plus suspended at `pl` unless −1) shows as `min(1, L)`; the light already in the layer (`src`)
 * shows through the film over it by its transmission. Returns whether any pixel changed.
 */
func shadeLightTile(_ f: UnsafeMutablePointer<Float>, _ d: Int, _ p: Int, _ dl: Int, _ pl: Int, _ src: [UInt8]?, _ out: inout [UInt8], _ w: Int, _ h: Int) -> Bool {
    let plane = WET_PLANE
    let side = SLOT_SIDE
    var any = false
    for y in 0..<h {
        for x in 0..<w {
            let c = (y + 1) * side + x + 1
            var l = Double(f[dl + c])
            if pl >= 0 { l += Double(f[pl + c]) }
            let i = y * 256 + x
            let old = src.map { Int($0[i]) } ?? 0
            if !(l > 1e-7) && old == 0 { continue }
            var keep = 1.0
            if old > 0 {
                var k0 = Double(f[d + c])
                var k1 = Double(f[d + plane + c])
                var k2 = Double(f[d + 2 * plane + c])
                var s = Double(f[d + 3 * plane + c])
                if p >= 0 {
                    k0 += Double(f[p + c])
                    k1 += Double(f[p + plane + c])
                    k2 += Double(f[p + 2 * plane + c])
                    s += Double(f[p + 3 * plane + c])
                }
                if k0 > 1e-7 || k1 > 1e-7 || k2 > 1e-7 || s > 1e-7 {
                    let hide = s > 0 ? 1 - expT(HIDE * s) : 0
                    keep = ((1 - hide) * (expT(2 * k0) + expT(2 * k1) + expT(2 * k2))) / 3
                }
            }
            let v = Int(JS.round(Swift.min(255, 255 * Swift.min(1, l > 0 ? l : 0) + Double(old) * keep)))
            if v == old { continue }
            out[i] = UInt8(v)
            any = true
        }
    }
    return any
}
