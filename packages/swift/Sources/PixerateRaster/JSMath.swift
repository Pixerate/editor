// The elementary functions below are adapted from fdlibm (http://www.netlib.org/fdlibm), as V8
// ships them in src/base/ieee754.cc:
//
// ====================================================
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================

import Foundation

/**
 * JavaScript's number semantics, so the raster code produces the TS core's pixels bit for bit.
 *
 * - `exp`, `log2`, `cbrt`, `sin`, `cos`, `atan`, `atan2` are V8's (fdlibm). The platform's libm
 *   rounds the last bit differently for a few percent of inputs, which then shows in 8-bit pixels
 *   now and then. `pow` and `sqrt` agree with V8 and come from Foundation.
 * - `hypot` is V8's two-argument fast path (`sqrt((a/m)² + (b/m)²)·m`), not libm's.
 * - `round` is `Math.round` (ties toward +∞), not Swift's `.rounded()` (ties away from zero).
 * - Stores into typed arrays: `u8c` is a `Uint8ClampedArray` store (clamp, then round half to
 *   even), `u8`/`u16`/`i32`/`u32` are `Uint8Array` / `Uint16Array` / `| 0` / `>>> 0` (ToInt32-style
 *   wrapping), `f32` is a `Float32Array` store (`Math.fround`).
 */
public enum JS {
    // MARK: Rounding and conversions

    /// `Math.round`: the nearest integer, ties toward +∞.
    @inline(__always) public static func round(_ x: Double) -> Double {
        if !x.isFinite { return x }
        var r = x.rounded(.up)
        if r - 0.5 > x { r -= 1 }
        // Math.round(-0.4) is -0, and so is Math.round(-0).
        if r == 0 && (x < 0 || x.sign == .minus) { return -0.0 }
        return r
    }

    /// `Math.floor`.
    @inline(__always) public static func floor(_ x: Double) -> Double { x.rounded(.down) }
    /// `Math.ceil`.
    @inline(__always) public static func ceil(_ x: Double) -> Double { x.rounded(.up) }

    /// A `Uint8ClampedArray` store: NaN is 0, then clamped to 0..255 and rounded half to even.
    @inline(__always) public static func u8c(_ v: Double) -> UInt8 {
        if !(v > 0) { return 0 }
        if v >= 255 { return 255 }
        return UInt8(v.rounded(.toNearestOrEven))
    }

    /// ToInt32 (`v | 0`).
    @inline(__always) public static func i32(_ v: Double) -> Int32 {
        if !v.isFinite { return 0 }
        let t = v.rounded(.towardZero)
        let m = t.truncatingRemainder(dividingBy: 4294967296)
        let u = m < 0 ? m + 4294967296 : m
        return Int32(bitPattern: UInt32(u))
    }

    /// ToUint32 (`v >>> 0`).
    @inline(__always) public static func u32(_ v: Double) -> UInt32 { UInt32(bitPattern: i32(v)) }

    /// A `Uint8Array` store (ToUint8: wraps modulo 256).
    @inline(__always) public static func u8(_ v: Double) -> UInt8 { UInt8(truncatingIfNeeded: i32(v)) }

    /// A `Uint16Array` store (ToUint16: wraps modulo 65536).
    @inline(__always) public static func u16(_ v: Double) -> UInt16 { UInt16(truncatingIfNeeded: i32(v)) }

    /// A `Float32Array` store (`Math.fround`).
    @inline(__always) public static func f32(_ v: Double) -> Float { Float(v) }

    /// `Math.min` of two numbers (NaN when either is NaN).
    @inline(__always) public static func min(_ a: Double, _ b: Double) -> Double {
        if a.isNaN || b.isNaN { return .nan }
        if a == b { return a.sign == .minus ? a : b }
        return a < b ? a : b
    }

    /// `Math.max` of two numbers (NaN when either is NaN).
    @inline(__always) public static func max(_ a: Double, _ b: Double) -> Double {
        if a.isNaN || b.isNaN { return .nan }
        if a == b { return a.sign == .minus ? b : a }
        return a > b ? a : b
    }

    /// `Math.hypot(a, b)` (V8's two-argument path).
    public static func hypot(_ x: Double, _ y: Double) -> Double {
        let a = Swift.abs(x)
        let b = Swift.abs(y)
        if a == .infinity || b == .infinity { return .infinity }
        if a.isNaN || b.isNaN { return .nan }
        let m = a > b ? a : b
        if m == 0 { return 0 }
        return ((a / m) * (a / m) + (b / m) * (b / m)).squareRoot() * m
    }

    /// `Math.hypot(a, b, c)`: V8's builtin normalises by the largest and sums the squares with Kahan summation.
    public static func hypot(_ x: Double, _ y: Double, _ z: Double) -> Double {
        let v = [Swift.abs(x), Swift.abs(y), Swift.abs(z)]
        var m = 0.0
        var nan = false
        for a in v {
            if a.isNaN { nan = true } else if a > m { m = a }
        }
        if m == .infinity { return .infinity }
        if nan { return .nan }
        if m == 0 { return 0 }
        var sum = 0.0
        var compensation = 0.0
        for a in v {
            let n = a / m
            let summand = n * n - compensation
            let preliminary = sum + summand
            compensation = (preliminary - sum) - summand
            sum = preliminary
        }
        return sum.squareRoot() * m
    }

    /// `Math.pow` / `**`.
    @inline(__always) public static func pow(_ x: Double, _ y: Double) -> Double { Foundation.pow(x, y) }

    /// `Math.sqrt`.
    @inline(__always) public static func sqrt(_ x: Double) -> Double { x.squareRoot() }

    // MARK: Bits

    /// `a·b + c` rounded once: V8's C++ is compiled with FP contraction, so every `a * b + c` inside one
    /// fdlibm expression is a fused multiply-add on arm64 (and the ports below fuse the same ones).
    @inline(__always) private static func fma(_ a: Double, _ b: Double, _ c: Double) -> Double { c.addingProduct(a, b) }

    @inline(__always) private static func hi(_ d: Double) -> Int32 { Int32(bitPattern: UInt32(truncatingIfNeeded: d.bitPattern >> 32)) }
    @inline(__always) private static func lo(_ d: Double) -> UInt32 { UInt32(truncatingIfNeeded: d.bitPattern) }
    @inline(__always) private static func words(_ h: Int32, _ l: UInt32) -> Double {
        Double(bitPattern: (UInt64(UInt32(bitPattern: h)) << 32) | UInt64(l))
    }
    @inline(__always) private static func withHigh(_ d: Double, _ h: Int32) -> Double { words(h, lo(d)) }
    @inline(__always) private static func withLow(_ d: Double, _ l: UInt32) -> Double { words(hi(d), l) }

    // MARK: exp

    /// `Math.exp` (fdlibm `e_exp.c`).
    public static func exp(_ xIn: Double) -> Double {
        var x = xIn
        let halF: [Double] = [0.5, -0.5]
        let oThreshold = 7.09782712893383973096e+02
        let uThreshold = -7.45133219101941108420e+02
        let ln2HI: [Double] = [6.93147180369123816490e-01, -6.93147180369123816490e-01]
        let ln2LO: [Double] = [1.90821492927058770002e-10, -1.90821492927058770002e-10]
        let invln2 = 1.44269504088896338700e+00
        let P1 = 1.66666666666666019037e-01
        let P2 = -2.77777777770155933842e-03
        let P3 = 6.61375632143793436117e-05
        let P4 = -1.65339022054652515390e-06
        let P5 = 4.13813679705723846039e-08
        let E = 2.718281828459045
        let huge = 1.0e+300
        let twom1000 = 9.33263618503218878990e-302
        let two1023 = 8.988465674311579539e307

        var hi = 0.0, lo = 0.0
        var k: Int32 = 0
        var hx = UInt32(bitPattern: Self.hi(x))
        let xsb = Int((hx >> 31) & 1)
        hx &= 0x7FFF_FFFF
        if hx >= 0x4086_2E42 {
            if hx >= 0x7FF0_0000 {
                if ((hx & 0xFFFFF) | Self.lo(x)) != 0 { return x + x }
                return xsb == 0 ? x : 0.0
            }
            if x > oThreshold { return huge * huge }
            if x < uThreshold { return twom1000 * twom1000 }
        }
        if hx > 0x3FD6_2E42 {
            if hx < 0x3FF0_A2B2 {
                if x == 1.0 { return E }
                hi = x - ln2HI[xsb]
                lo = ln2LO[xsb]
                k = Int32(1 - xsb - xsb)
            } else {
                k = Int32(fma(invln2, x, halF[xsb]).rounded(.towardZero))
                let t = Double(k)
                hi = fma(-t, ln2HI[0], x)
                lo = t * ln2LO[0]
            }
            x = hi - lo
        } else if hx < 0x3E30_0000 {
            if huge + x > 1.0 { return 1.0 + x }
        } else {
            k = 0
        }
        let t = x * x
        let twopk: Double
        if k >= -1021 {
            twopk = words(Int32(bitPattern: 0x3FF0_0000 &+ (UInt32(bitPattern: k) << 20)), 0)
        } else {
            twopk = words(Int32(bitPattern: 0x3FF0_0000 &+ (UInt32(bitPattern: k + 1000) << 20)), 0)
        }
        let c = fma(-t, fma(t, fma(t, fma(t, fma(t, P5, P4), P3), P2), P1), x)
        if k == 0 { return 1.0 - ((x * c) / (c - 2.0) - x) }
        let y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi)
        if k >= -1021 {
            if k == 1024 { return y * 2.0 * two1023 }
            return y * twopk
        }
        return y * twopk * twom1000
    }

    // MARK: log2

    /// `Math.log2` (FreeBSD `e_log2.c`).
    public static func log2(_ xIn: Double) -> Double {
        var x = xIn
        let two54 = 1.80143985094819840000e+16
        let ivln2hi = 1.44269504072144627571e+00
        let ivln2lo = 1.67517131648865118353e-10
        var hx = hi(x)
        let lx = lo(x)
        var k: Int32 = 0
        if hx < 0x0010_0000 {
            if ((hx & 0x7FFF_FFFF) | Int32(bitPattern: lx)) == 0 { return -.infinity }
            if hx < 0 { return .nan }
            k -= 54
            x *= two54
            hx = hi(x)
        }
        if hx >= 0x7FF0_0000 { return x + x }
        if hx == 0x3FF0_0000 && lx == 0 { return 0.0 }
        k += (hx >> 20) - 1023
        hx &= 0x000F_FFFF
        let i = (hx &+ 0x95F64) & 0x10_0000
        x = withHigh(x, hx | (i ^ 0x3FF0_0000))
        k += i >> 20
        let y = Double(k)
        let f = x - 1.0
        let hfsq = 0.5 * f * f
        let r = kLog1p(f)
        var h = f - hfsq
        h = withLow(h, 0)
        let l = (f - h) - hfsq + r
        var valHi = h * ivln2hi
        var valLo = fma(l + h, ivln2lo, l * ivln2hi)
        let w = y + valHi
        valLo += (y - w) + valHi
        valHi = w
        return valLo + valHi
    }

    private static func kLog1p(_ f: Double) -> Double {
        let Lg1 = 6.666666666666735130e-01
        let Lg2 = 3.999999999940941908e-01
        let Lg3 = 2.857142874366239149e-01
        let Lg4 = 2.222219843214978396e-01
        let Lg5 = 1.818357216161805012e-01
        let Lg6 = 1.531383769920937332e-01
        let Lg7 = 1.479819860511658591e-01
        let s = f / (2.0 + f)
        let z = s * s
        let w = z * z
        let t1 = w * fma(w, fma(w, Lg6, Lg4), Lg2)
        let t2 = z * fma(w, fma(w, fma(w, Lg7, Lg5), Lg3), Lg1)
        let R = t2 + t1
        let hfsq = 0.5 * f * f
        return s * (hfsq + R)
    }

    // MARK: cbrt

    /// `Math.cbrt` (FreeBSD `s_cbrt.c`).
    public static func cbrt(_ x: Double) -> Double {
        let B1: UInt32 = 715_094_163
        let B2: UInt32 = 696_219_795
        let P0 = 1.87595182427177009643
        let P1 = -1.88497979543377169875
        let P2 = 1.621429720105354466140
        let P3 = -0.758397934778766047437
        let P4 = 0.145996192886612446982
        var hx = UInt32(bitPattern: hi(x))
        let low = lo(x)
        let sign = hx & 0x8000_0000
        hx ^= sign
        if hx >= 0x7FF0_0000 { return x + x }
        var t = 0.0
        if hx < 0x0010_0000 {
            if (hx | low) == 0 { return x }
            t = withHigh(t, 0x4350_0000)
            t *= x
            let high = UInt32(bitPattern: hi(t))
            t = words(Int32(bitPattern: sign | ((high & 0x7FFF_FFFF) / 3 + B2)), 0)
        } else {
            t = words(Int32(bitPattern: sign | (hx / 3 + B1)), 0)
        }
        var r = (t * t) * (t / x)
        t = t * fma((r * r) * r, fma(r, P4, P3), fma(r, fma(r, P2, P1), P0))
        t = Double(bitPattern: (t.bitPattern &+ 0x8000_0000) & 0xFFFF_FFFF_C000_0000)
        let s = t * t
        r = x / s
        let w = t + t
        r = (r - t) / (w + r)
        t = fma(t, r, t)
        return t
    }

    // MARK: atan, atan2

    private static let atanhi: [Double] = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00]
    private static let atanlo: [Double] = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17]
    private static let aT: [Double] = [
        3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01,
        9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02,
        4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02,
    ]

    /// `Math.atan` (fdlibm `s_atan.c`).
    public static func atan(_ xIn: Double) -> Double {
        var x = xIn
        let hx = hi(x)
        let ix = hx & 0x7FFF_FFFF
        var id: Int
        if ix >= 0x4410_0000 {
            if ix > 0x7FF0_0000 || (ix == 0x7FF0_0000 && lo(x) != 0) { return x + x }
            return hx > 0 ? atanhi[3] + atanlo[3] : -atanhi[3] - atanlo[3]
        }
        if ix < 0x3FDC_0000 {
            if ix < 0x3E40_0000 { return x }
            id = -1
        } else {
            x = Swift.abs(x)
            if ix < 0x3FF3_0000 {
                if ix < 0x3FE6_0000 {
                    id = 0
                    x = fma(2.0, x, -1.0) / (2.0 + x)
                } else {
                    id = 1
                    x = (x - 1.0) / (x + 1.0)
                }
            } else if ix < 0x4003_8000 {
                id = 2
                x = (x - 1.5) / fma(1.5, x, 1.0)
            } else {
                id = 3
                x = -1.0 / x
            }
        }
        var z = x * x
        let w = z * z
        let s1 = z * fma(w, fma(w, fma(w, fma(w, fma(w, aT[10], aT[8]), aT[6]), aT[4]), aT[2]), aT[0])
        let s2 = w * fma(w, fma(w, fma(w, fma(w, aT[9], aT[7]), aT[5]), aT[3]), aT[1])
        if id < 0 { return fma(-x, s1 + s2, x) }
        z = atanhi[id] - (fma(x, s1 + s2, -atanlo[id]) - x)
        return hx < 0 ? -z : z
    }

    // MARK: acos

    private static let pS: [Double] = [
        1.66666666666666657415e-01, -3.25565818622400915405e-01, 2.01212532134862925881e-01, -4.00555345006794114027e-02, 7.91534994289814532176e-04,
        3.47933107596021167570e-05,
    ]
    private static let qS: [Double] = [0, -2.40339491173441421878e+00, 2.02094576023350569471e+00, -6.88283971605453293030e-01, 7.70381505559019352791e-02]

    /// `Math.acos` (fdlibm `e_acos.c`).
    public static func acos(_ x: Double) -> Double {
        let pi = 3.14159265358979311600e+00
        let pio2Hi = 1.57079632679489655800e+00
        let pio2Lo = 6.12323399573676603587e-17
        let hx = hi(x)
        let ix = hx & 0x7FFF_FFFF
        if ix >= 0x3FF0_0000 {
            if ((ix - 0x3FF0_0000) | Int32(bitPattern: lo(x))) == 0 { return hx > 0 ? 0.0 : fma(2.0, pio2Lo, pi) }
            return .nan
        }
        func pq(_ z: Double) -> Double {
            let p = z * fma(z, fma(z, fma(z, fma(z, fma(z, pS[5], pS[4]), pS[3]), pS[2]), pS[1]), pS[0])
            let q = fma(z, fma(z, fma(z, fma(z, qS[4], qS[3]), qS[2]), qS[1]), 1.0)
            return p / q
        }
        if ix < 0x3FE0_0000 {
            if ix <= 0x3C60_0000 { return pio2Hi + pio2Lo }
            let r = pq(x * x)
            return pio2Hi - (x - fma(-x, r, pio2Lo))
        } else if hx < 0 {
            let z = (1.0 + x) * 0.5
            let s = z.squareRoot()
            let r = pq(z)
            let w = fma(r, s, -pio2Lo)
            return fma(-2.0, s + w, pi)
        } else {
            let z = (1.0 - x) * 0.5
            let s = z.squareRoot()
            let df = withLow(s, 0)
            let c = fma(-df, df, z) / (s + df)
            let r = pq(z)
            let w = fma(r, s, c)
            return 2.0 * (df + w)
        }
    }

    /// `Math.atan2` (fdlibm `e_atan2.c`).
    public static func atan2(_ y: Double, _ x: Double) -> Double {
        let tiny = 1.0e-300
        let piO4 = 7.8539816339744827900e-01
        let piO2 = 1.5707963267948965580e+00
        let pi = 3.1415926535897931160e+00
        let piLo = 1.2246467991473531772e-16
        if x.isNaN || y.isNaN { return x + y }
        let hx = hi(x), lx = lo(x)
        let ix = hx & 0x7FFF_FFFF
        let hy = hi(y), ly = lo(y)
        let iy = hy & 0x7FFF_FFFF
        if (hx &- 0x3FF0_0000) | Int32(bitPattern: lx) == 0 { return atan(y) }
        var m = Int((hy >> 31) & 1) | Int((hx >> 30) & 2)
        if (iy | Int32(bitPattern: ly)) == 0 {
            switch m {
            case 0, 1: return y
            case 2: return pi + tiny
            default: return -pi - tiny
            }
        }
        if (ix | Int32(bitPattern: lx)) == 0 { return hy < 0 ? -piO2 - tiny : piO2 + tiny }
        if ix == 0x7FF0_0000 {
            if iy == 0x7FF0_0000 {
                switch m {
                case 0: return piO4 + tiny
                case 1: return -piO4 - tiny
                case 2: return 3.0 * piO4 + tiny
                default: return -3.0 * piO4 - tiny
                }
            } else {
                switch m {
                case 0: return 0.0
                case 1: return -0.0
                case 2: return pi + tiny
                default: return -pi - tiny
                }
            }
        }
        if iy == 0x7FF0_0000 { return hy < 0 ? -piO2 - tiny : piO2 + tiny }
        let k = (iy - ix) >> 20
        var z: Double
        if k > 60 {
            z = piO2 + 0.5 * piLo
            m &= 1
        } else if hx < 0 && k < -60 {
            z = 0.0
        } else {
            z = atan(Swift.abs(y / x))
        }
        switch m {
        case 0: return z
        case 1: return -z
        case 2: return pi - (z - piLo)
        default: return (z - piLo) - pi
        }
    }

    // MARK: sin, cos

    /// `Math.sin` (fdlibm `s_sin.c`).
    public static func sin(_ x: Double) -> Double {
        let ix = hi(x) & 0x7FFF_FFFF
        if ix <= 0x3FE9_21FB { return kernelSin(x, 0, 0) }
        if ix >= 0x7FF0_0000 { return x - x }
        var y0 = 0.0, y1 = 0.0
        let n = remPio2(x, &y0, &y1)
        switch n & 3 {
        case 0: return kernelSin(y0, y1, 1)
        case 1: return kernelCos(y0, y1)
        case 2: return -kernelSin(y0, y1, 1)
        default: return -kernelCos(y0, y1)
        }
    }

    /// `Math.cos` (fdlibm `s_cos.c`).
    public static func cos(_ x: Double) -> Double {
        let ix = hi(x) & 0x7FFF_FFFF
        if ix <= 0x3FE9_21FB { return kernelCos(x, 0) }
        if ix >= 0x7FF0_0000 { return x - x }
        var y0 = 0.0, y1 = 0.0
        let n = remPio2(x, &y0, &y1)
        switch n & 3 {
        case 0: return kernelCos(y0, y1)
        case 1: return -kernelSin(y0, y1, 1)
        case 2: return -kernelCos(y0, y1)
        default: return kernelSin(y0, y1, 1)
        }
    }

    /// `Math.tan` (fdlibm `s_tan.c` as V8 ports it; the platform's `tan` differs in the last bit).
    public static func tan(_ x: Double) -> Double {
        let ix = hi(x) & 0x7FFF_FFFF
        if ix <= 0x3FE9_21FB { return kernelTan(x, 0, 1) }
        if ix >= 0x7FF0_0000 { return x - x }
        var y0 = 0.0, y1 = 0.0
        let n = remPio2(x, &y0, &y1)
        return kernelTan(y0, y1, 1 - Int((n & 1) << 1))
    }

    private static let tanT: [Double] = [
        3.33333333333334091986e-01, 1.33333333333201242699e-01, 5.39682539762260521377e-02, 2.18694882948595424599e-02,
        8.86323982359930005737e-03, 3.59207910759131235356e-03, 1.45620945432529025516e-03, 5.88041240820264096874e-04,
        2.46463134818469906812e-04, 7.81794442939557092300e-05, 7.14072491382608190305e-05, -1.85586374855275456654e-05,
        2.59073051863633712884e-05,
    ]

    /// fdlibm `__kernel_tan`: tan(x + y) for |x| ≤ π/4, or -1/tan(x + y) when `iy` is -1.
    private static func kernelTan(_ xIn: Double, _ yIn: Double, _ iy: Int) -> Double {
        let pio4 = 7.85398163397448278999e-01
        let pio4lo = 3.06161699786838301793e-17
        let T = tanT
        var x = xIn
        var y = yIn
        let hx = hi(x)
        let ix = hx & 0x7FFF_FFFF
        if ix < 0x3E30_0000 && Int(x.rounded(.towardZero)) == 0 {
            if (UInt32(bitPattern: ix) | lo(x)) == 0 && iy == -1 { return 1 / Swift.abs(x) }
            if iy == 1 { return x }
            let w = x + y
            let z = withLow(w, 0)
            let v = y - (z - x)
            let a = -1 / w
            let t = withLow(a, 0)
            let s = fma(t, z, 1)
            return fma(a, fma(t, v, s), t)
        }
        if ix >= 0x3FE5_9428 {
            if hx < 0 {
                x = -x
                y = -y
            }
            let z = pio4 - x
            let w = pio4lo - y
            x = z + w
            y = 0
        }
        let z = x * x
        let w = z * z
        var r = fma(w, fma(w, fma(w, fma(w, fma(w, T[11], T[9]), T[7]), T[5]), T[3]), T[1])
        let v0 = z * fma(w, fma(w, fma(w, fma(w, fma(w, T[12], T[10]), T[8]), T[6]), T[4]), T[2])
        let s = z * x
        r = fma(z, fma(s, r + v0, y), y)
        r = fma(T[0], s, r)
        let sum = x + r
        if ix >= 0x3FE5_9428 {
            let v = Double(iy)
            let sign = Double(1 - ((hx >> 30) & 2))
            let q: Double = sum * sum / (sum + v) - r
            return sign * (v - 2.0 * (x - q))
        }
        if iy == 1 { return sum }
        let zz = withLow(sum, 0)
        let v = r - (zz - x)
        let a = -1.0 / sum
        let t = withLow(a, 0)
        let s2 = fma(t, zz, 1.0)
        return fma(a, fma(t, v, s2), t)
    }

    private static func kernelSin(_ x: Double, _ y: Double, _ iy: Int) -> Double {
        let half = 5.00000000000000000000e-01
        let S1 = -1.66666666666666324348e-01
        let S2 = 8.33333333332248946124e-03
        let S3 = -1.98412698298579493134e-04
        let S4 = 2.75573137070700676789e-06
        let S5 = -2.50507602534068634195e-08
        let S6 = 1.58969099521155010221e-10
        let ix = hi(x) & 0x7FFF_FFFF
        if ix < 0x3E40_0000 && Int(x.rounded(.towardZero)) == 0 { return x }
        let z = x * x
        let v = z * x
        let r = fma(z, fma(z, fma(z, fma(z, S6, S5), S4), S3), S2)
        if iy == 0 { return fma(v, fma(z, r, S1), x) }
        return x - fma(-v, S1, fma(z, fma(half, y, -(v * r)), -y))
    }

    private static func kernelCos(_ x: Double, _ y: Double) -> Double {
        let C1 = 4.16666666666666019037e-02
        let C2 = -1.38888888888741095749e-03
        let C3 = 2.48015872894767294178e-05
        let C4 = -2.75573143513906633035e-07
        let C5 = 2.08757232129817482790e-09
        let C6 = -1.13596475577881948265e-11
        let ix = hi(x) & 0x7FFF_FFFF
        if ix < 0x3E40_0000 && Int(x.rounded(.towardZero)) == 0 { return 1.0 }
        let z = x * x
        let r = z * fma(z, fma(z, fma(z, fma(z, fma(z, C6, C5), C4), C3), C2), C1)
        if ix < 0x3FD3_3333 { return 1.0 - fma(0.5, z, -fma(z, r, -(x * y))) }
        let qx: Double = ix > 0x3FE9_0000 ? 0.28125 : words(ix - 0x0020_0000, 0)
        let iz = fma(0.5, z, -qx)
        let a = 1.0 - qx
        return a - (iz - fma(z, r, -(x * y)))
    }

    private static let npio2hw: [Int32] = [
        0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB, 0x402921FB,
        0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C, 0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB,
        0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C,
        0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB,
    ]

    /// Argument reduction of `__ieee754_rem_pio2` for |x| up to 2¹⁹·π/2. Larger arguments (never
    /// reached by the raster code, whose angles are degrees in ±360 and radians) fall back to the
    /// platform's reduction, which is exact.
    private static func remPio2(_ x: Double, _ y0: inout Double, _ y1: inout Double) -> Int32 {
        let invpio2 = 6.36619772367581382433e-01
        let pio2_1 = 1.57079632673412561417e+00
        let pio2_1t = 6.07710050650619224932e-11
        let pio2_2 = 6.07710050630396597660e-11
        let pio2_2t = 2.02226624879595063154e-21
        let pio2_3 = 2.02226624871116645580e-21
        let pio2_3t = 8.47842766036889956997e-32
        let hx = hi(x)
        let ix = hx & 0x7FFF_FFFF
        if ix <= 0x3FE9_21FB {
            y0 = x
            y1 = 0
            return 0
        }
        if ix < 0x4002_D97C {
            if hx > 0 {
                var z = x - pio2_1
                if ix != 0x3FF9_21FB {
                    y0 = z - pio2_1t
                    y1 = (z - y0) - pio2_1t
                } else {
                    z -= pio2_2
                    y0 = z - pio2_2t
                    y1 = (z - y0) - pio2_2t
                }
                return 1
            } else {
                var z = x + pio2_1
                if ix != 0x3FF9_21FB {
                    y0 = z + pio2_1t
                    y1 = (z - y0) + pio2_1t
                } else {
                    z += pio2_2
                    y0 = z + pio2_2t
                    y1 = (z - y0) + pio2_2t
                }
                return -1
            }
        }
        if ix <= 0x4139_21FB {
            var t = Swift.abs(x)
            let n = Int32(fma(t, invpio2, 0.5).rounded(.towardZero))
            let fn = Double(n)
            var r = fma(-fn, pio2_1, t)
            var w = fn * pio2_1t
            if n < 32 && ix != npio2hw[Int(n) - 1] {
                y0 = r - w
            } else {
                let j = ix >> 20
                y0 = r - w
                var high = UInt32(bitPattern: hi(y0))
                var i = j - Int32((high >> 20) & 0x7FF)
                if i > 16 {
                    t = r
                    w = fn * pio2_2
                    r = t - w
                    w = fma(fn, pio2_2t, -((t - r) - w))
                    y0 = r - w
                    high = UInt32(bitPattern: hi(y0))
                    i = j - Int32((high >> 20) & 0x7FF)
                    if i > 49 {
                        t = r
                        w = fn * pio2_3
                        r = t - w
                        w = fma(fn, pio2_3t, -((t - r) - w))
                        y0 = r - w
                    }
                }
            }
            y1 = (r - y0) - w
            if hx < 0 {
                y0 = -y0
                y1 = -y1
                return -n
            }
            return n
        }
        // Huge arguments: reduce with the platform (sin and cos of the reduced pair agree).
        let n = (x / (Double.pi / 2)).rounded()
        y0 = x - n * (Double.pi / 2)
        y1 = 0
        return Int32(truncatingIfNeeded: Int64(n.truncatingRemainder(dividingBy: 4)))
    }
}
