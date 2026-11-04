import Foundation
import PixerateCore

/**
 * Pigment-like colour mixing: blue and yellow make green, red and white make pink, as paint does.
 * The port of `raster/pigment.ts`.
 *
 * Each sRGB colour is lifted to a smooth reflectance spectrum, the spectra are mixed with the
 * Kubelka-Munk two-flux model, and the mixed spectrum is turned back into sRGB. Written from the
 * published literature; no third-party code or data:
 *
 * 1. **Spectral uplift.** A colour's reflectance is a sigmoid of a quadratic in wavelength,
 *    `R(λ) = s(c₀λ² + c₁λ + c₂)` with `s(z) = ½ + z / 2√(1 + z²)` (Jakob & Hanika 2019). The
 *    three coefficients are solved per colour with Newton's method so the spectrum reproduces the
 *    colour. Spectra are precomputed lazily on a 17³ lattice over sRGB and interpolated
 *    trilinearly in *linear* RGB.
 * 2. **Mixing.** Each spectrum becomes `K/S = (1 − R)² / 2R` per band. Colours mix with the
 *    two-constant form `K/S = Σ cᵢSᵢ(K/S)ᵢ / Σ cᵢSᵢ`, where `cᵢ` is the weight times the colour's
 *    tinting strength and `Sᵢ` its scattering, taken from its luminance. Back to reflectance with
 *    `R = 1 + K/S − √((K/S)² + 2·K/S)`.
 * 3. **Back to sRGB.** The spectrum is weighted by the CIE 1931 2° colour-matching functions
 *    (the analytic fit of Wyman, Sloan & Shirley, JCGT 2013) under a 6504 K Planckian
 *    illuminant, converted to linear sRGB and normalised so a perfect white reflector is exactly
 *    white.
 *
 * Colours are straight sRGB triples in 0..1. Spectra are `Float` (the TS `Float32Array`).
 */

/// Number of spectral bands.
public let PIGMENT_BANDS = 36
/// First band's wavelength in nm; bands are 10 nm apart (380..730 nm).
public let PIGMENT_LAMBDA_MIN = 380.0
public let PIGMENT_LAMBDA_STEP = 10.0

/// Band centre wavelengths in nm.
public let PIGMENT_WAVELENGTHS: [Float] = (0..<PIGMENT_BANDS).map { Float(PIGMENT_LAMBDA_MIN + Double($0) * PIGMENT_LAMBDA_STEP) }

private let N = PIGMENT_BANDS
/// Lattice nodes per axis of the spectrum table.
private let LUT_NODES = 17
/// Reflectance floor for K/S, so a black's K/S stays finite (≈ 5000).
private let R_MIN = 1e-4
/// Scattering floor, so a black still counts in a mix.
private let SCATTER_MIN = 0.01

// MARK: - sRGB

private func toLinear(_ v: Double) -> Double {
    v <= 0.04045 ? v / 12.92 : JS.pow((v + 0.055) / 1.055, 2.4)
}

private func toEncoded(_ v: Double) -> Double {
    if !(v > 0) { return 0 }
    if v >= 1 { return 1 }
    return v <= 0.0031308 ? 12.92 * v : 1.055 * JS.pow(v, 1 / 2.4) - 0.055
}

@inline(__always) private func clamp01(_ v: Double) -> Double { v > 0 ? (v < 1 ? v : 1) : 0 }

// MARK: - Reflectance → linear sRGB weights

/// Asymmetric Gaussian lobe of the Wyman et al. fit.
private func lobe(_ l: Double, _ mu: Double, _ s1: Double, _ s2: Double) -> Double {
    let t = (l - mu) / (l < mu ? s1 : s2)
    return JS.exp(-0.5 * t * t)
}

/// Relative spectral power of a black body (Planck's law; the constant factor cancels).
private func planck(_ nm: Double, _ kelvin: Double) -> Double {
    let m = nm * 1e-9
    return 1 / (JS.pow(m, 5) * (JS.exp(1.438776877e-2 / (m * kelvin)) - 1))
}

/**
 * Row-major 3 × N matrix taking a reflectance spectrum to linear sRGB. Each row sums to 1, so a
 * flat reflectance `r` gives the grey `(r, r, r)`.
 */
private let rgbWeights: [Double] = {
    var w = [Double](repeating: 0, count: 3 * N)
    // XYZ (D65 white) → linear sRGB, IEC 61966-2-1.
    let m = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252]
    for b in 0..<N {
        let l = PIGMENT_LAMBDA_MIN + Double(b) * PIGMENT_LAMBDA_STEP
        let e = planck(l, 6504)
        let x = e * (1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2))
        let y = e * (0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1))
        let z = e * (1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8))
        for c in 0..<3 { w[c * N + b] = m[c * 3] * x + m[c * 3 + 1] * y + m[c * 3 + 2] * z }
    }
    for c in 0..<3 {
        var sum = 0.0
        for b in 0..<N { sum += w[c * N + b] }
        for b in 0..<N { w[c * N + b] /= sum }
    }
    return w
}()

// MARK: - Sigmoid-polynomial uplift

/**
 * Solves the sigmoid-polynomial coefficients whose spectrum has the linear sRGB colour
 * `(r, g, b)`, starting from `coeffs` (updated in place). Wavelength is normalised to 0..1 over
 * the bands. Damped Newton: a step is halved until the residual drops.
 */
private func fitCoefficients(_ r: Double, _ g: Double, _ b: Double, _ coeffs: inout [Double]) -> Double {
    let w = rgbWeights
    let target = [r, g, b]
    var res = [0.0, 0.0, 0.0]
    var jac = [Double](repeating: 0, count: 9)
    var trial = [0.0, 0.0, 0.0]
    var err = residual(coeffs, target, w, &res, &jac, true)
    var it = 0
    while it < 60 && err > 1e-10 {
        defer { it += 1 }
        guard let step = solve3(jac, res) else { break }
        var scale = 1.0
        var next = Double.infinity
        for _ in 0..<12 {
            for i in 0..<3 { trial[i] = coeffs[i] - scale * step[i] }
            next = residual(trial, target, w, &res, &jac, false)
            if next < err { break }
            scale *= 0.5
        }
        if !(next < err) { break }
        coeffs = trial
        err = residual(coeffs, target, w, &res, &jac, true)
    }
    return err
}

/// Squared colour error of a coefficient set; fills the residual and Jacobian when `fill`.
private func residual(_ c: [Double], _ target: [Double], _ w: [Double], _ res: inout [Double], _ jac: inout [Double], _ fill: Bool) -> Double {
    var r0 = -target[0]
    var r1 = -target[1]
    var r2 = -target[2]
    if fill { for i in 0..<9 { jac[i] = 0 } }
    for b in 0..<N {
        let x = Double(b) / Double(N - 1)
        let z = (c[0] * x + c[1]) * x + c[2]
        let q = 1 + z * z
        let sq = q.squareRoot()
        let s = 0.5 + z / (2 * sq)
        r0 += w[b] * s
        r1 += w[N + b] * s
        r2 += w[2 * N + b] * s
        if fill {
            let ds = 1 / (2 * q * sq)
            for k in 0..<3 {
                let wd = w[k * N + b] * ds
                jac[k * 3] += wd * x * x
                jac[k * 3 + 1] += wd * x
                jac[k * 3 + 2] += wd
            }
        }
    }
    if fill {
        res[0] = r0
        res[1] = r1
        res[2] = r2
    }
    return r0 * r0 + r1 * r1 + r2 * r2
}

/// Solves the 3 × 3 system `a·x = v` (Cramer's rule), or nil when singular.
private func solve3(_ a: [Double], _ v: [Double]) -> [Double]? {
    let a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], a4 = a[4], a5 = a[5], a6 = a[6], a7 = a[7], a8 = a[8]
    let c0 = a4 * a8 - a5 * a7
    let c1 = a5 * a6 - a3 * a8
    let c2 = a3 * a7 - a4 * a6
    let det = a0 * c0 + a1 * c1 + a2 * c2
    if !(Swift.abs(det) > 1e-300) { return nil }
    let v0 = v[0], v1 = v[1], v2 = v[2]
    return [
        (v0 * c0 + a1 * (a5 * v2 - v1 * a8) + a2 * (v1 * a7 - a4 * v2)) / det,
        (a0 * (v1 * a8 - a5 * v2) + v0 * c1 + a2 * (a3 * v2 - v1 * a6)) / det,
        (a0 * (a4 * v2 - v1 * a7) + a1 * (v1 * a6 - a3 * v2) + v0 * c2) / det,
    ]
}

/**
 * Fits a lattice node, starting from `coeffs` (its neighbour's solution). Where that stalls, as it
 * can next to very saturated or very dark nodes, it also tries a flat grey start and a dimming
 * continuation (solve the colour brighter, then dim it in small steps, each starting from the last,
 * as Jakob & Hanika do along their brightness axis), and keeps the closest fit.
 */
private func fitNode(_ r: Double, _ g: Double, _ b: Double, _ coeffs: inout [Double], _ candidate: inout [Double]) {
    var best = fitCoefficients(r, g, b, &coeffs)
    if best <= 1e-12 { return }
    candidate = [0, 0, 0]
    var err = fitCoefficients(r, g, b, &candidate)
    if err < best {
        best = err
        coeffs = candidate
    }
    if best <= 1e-12 { return }
    let mx = JS.max(r, JS.max(g, b))
    if !(mx > 0) || mx >= 0.5 { return }
    candidate = [0, 0, 0]
    let steps = 32
    for i in 0...steps {
        let scale = (0.5 * JS.pow(mx / 0.5, Double(i) / Double(steps))) / mx
        err = fitCoefficients(r * scale, g * scale, b * scale, &candidate)
    }
    if err < best { coeffs = candidate }
}

private func sigmoidSpectrum(_ c: [Double], _ out: inout [Float], _ offset: Int) {
    for b in 0..<N {
        let x = Double(b) / Double(N - 1)
        let z = (c[0] * x + c[1]) * x + c[2]
        out[offset + b] = Float(0.5 + z / (2 * (1 + z * z).squareRoot()))
    }
}

// MARK: - Spectrum table

/// Linear value of each lattice node: evenly spaced in encoded sRGB, so darks get more nodes.
private let NODES: [Double] = (0..<LUT_NODES).map { toLinear(Double($0) / Double(LUT_NODES - 1)) }

/**
 * The spectrum of every lattice node, `[(r·n + g)·n + b]·N`, solved on first use. Each node starts
 * from its neighbour's solution, so Newton converges in a few steps.
 */
private let spectrumTable: [Float] = {
    let n = LUT_NODES
    var t = [Float](repeating: 0, count: n * n * n * N)
    var row = [0.0, 0.0, 0.0]
    var coeffs = [0.0, 0.0, 0.0]
    var candidate = [0.0, 0.0, 0.0]
    for r in 0..<n {
        for g in 0..<n {
            // Warm start each row from the first node of the previous row.
            coeffs = row
            for b in 0..<n {
                fitNode(NODES[r], NODES[g], NODES[b], &coeffs, &candidate)
                if b == 0 { row = coeffs }
                sigmoidSpectrum(coeffs, &t, ((r * n + g) * n + b) * N)
            }
        }
    }
    return t
}()

/// An encoded channel's lattice cell, fraction (linear in linear RGB) and linear value.
private func locate(_ encoded: Double) -> (cell: Int, frac: Double, linear: Double) {
    let v = clamp01(encoded)
    let i = Swift.min(LUT_NODES - 2, Int((v * Double(LUT_NODES - 1)).rounded(.down)))
    let lo = NODES[i]
    let lin = toLinear(v)
    let f = (lin - lo) / (NODES[i + 1] - lo)
    return (i, f < 0 ? 0 : f > 1 ? 1 : f, lin)
}

/// The reflectance spectrum of an sRGB colour and each channel's linear value.
private func reflectanceAndLinear(_ r: Double, _ g: Double, _ b: Double) -> (spectrum: [Float], linear: (Double, Double, Double)) {
    let t = spectrumTable
    let n = LUT_NODES
    let lr = locate(r)
    let lg = locate(g)
    let lb = locate(b)
    var out = [Float](repeating: 0, count: N)
    for corner in 0..<8 {
        let dr = corner >> 2
        let dg = (corner >> 1) & 1
        let db = corner & 1
        let weight = (dr != 0 ? lr.frac : 1 - lr.frac) * (dg != 0 ? lg.frac : 1 - lg.frac) * (db != 0 ? lb.frac : 1 - lb.frac)
        if weight == 0 { continue }
        let base = (((lr.cell + dr) * n + lg.cell + dg) * n + lb.cell + db) * N
        for k in 0..<N { out[k] = Float(Double(out[k]) + weight * Double(t[base + k])) }
    }
    return (out, (lr.linear, lg.linear, lb.linear))
}

/**
 * The smooth reflectance spectrum (0..1 per band, `PIGMENT_BANDS` bands from 380 nm in 10 nm
 * steps) of an sRGB colour. `reflectanceToRgb` of the result gives the colour back.
 */
public func rgbToReflectance(_ r: Double, _ g: Double, _ b: Double) -> [Float] {
    reflectanceAndLinear(r, g, b).spectrum
}

/// The sRGB colour (0..1, clipped to the gamut) of a reflectance spectrum.
public func reflectanceToRgb(_ reflectance: [Float]) -> [Double] {
    let w = rgbWeights
    var r = 0.0, g = 0.0, b = 0.0
    for k in 0..<N {
        let v = Double(reflectance[k])
        r += w[k] * v
        g += w[N + k] * v
        b += w[2 * N + k] * v
    }
    return [toEncoded(r), toEncoded(g), toEncoded(b)]
}

// MARK: - Pigments and mixing

/**
 * A colour prepared for mixing: its K/S spectrum and its weight in a mix. Make one per brush or
 * palette colour with `createPigment` and reuse it (`setPigmentColor`) on hot paths.
 */
public final class Pigment: @unchecked Sendable {
    /// The sRGB colour it was made from (0..1).
    public internal(set) var rgb: [Double] = [0, 0, 0]
    /// Tinting strength (default 1): how strongly it colours a mix, relative to its weight.
    public var strength: Double = 1
    /// K/S per band.
    public internal(set) var ks: [Float] = [Float](repeating: 0, count: N)
    /// Scattering from the colour's luminance (floored), before strength.
    public var scatter: Double = 1
    init() {}
}

public struct PigmentOptions {
    /**
     * Tinting strength, > 0 (default 1). A strength of 4 counts each part as four, so a little of
     * a strong dark pigment tints a lot of white. A colour mixed only with itself is unchanged
     * whatever its strength.
     */
    public var strength: Double?
    public init(strength: Double? = nil) { self.strength = strength }
}

/// Prepares a colour for mixing.
public func createPigment(_ color: [Double], _ options: PigmentOptions = PigmentOptions()) -> Pigment {
    setPigmentColor(Pigment(), color[0], color[1], color[2], options.strength)
}

/// Re-targets a pigment to another colour (the per-pixel fast path).
@discardableResult
public func setPigmentColor(_ pigment: Pigment, _ r: Double, _ g: Double, _ b: Double, _ strength: Double? = nil) -> Pigment {
    let strength = strength ?? pigment.strength
    let (R, linear) = reflectanceAndLinear(r, g, b)
    for k in 0..<N {
        let v = Double(R[k]) > R_MIN ? Double(R[k]) : R_MIN
        pigment.ks[k] = Float(((1 - v) * (1 - v)) / (2 * v))
    }
    pigment.rgb[0] = clamp01(r)
    pigment.rgb[1] = clamp01(g)
    pigment.rgb[2] = clamp01(b)
    pigment.strength = strength.isFinite && strength > 0 ? strength : 1
    let y = 0.2126 * linear.0 + 0.7152 * linear.1 + 0.0722 * linear.2
    pigment.scatter = y > SCATTER_MIN ? y : SCATTER_MIN
    return pigment
}

/// Mixed K/S → reflectance → sRGB, written to `out[offset..offset + 2]`.
private func ksToRgb(_ ks: [Double], _ out: inout [Double], _ offset: Int) {
    let w = rgbWeights
    var r = 0.0, g = 0.0, b = 0.0
    for k in 0..<N {
        let q = ks[k]
        let v = 1 + q - (q * q + 2 * q).squareRoot()
        r += w[k] * v
        g += w[N + k] * v
        b += w[2 * N + k] * v
    }
    out[offset] = toEncoded(r)
    out[offset + 1] = toEncoded(g)
    out[offset + 2] = toEncoded(b)
}

/// A colour to mix: an sRGB triple (0..1) or a prepared pigment (which carries a tinting strength).
public enum PigmentColor {
    case rgb(Double, Double, Double)
    case pigment(Pigment)
}

public struct PigmentError: Error, CustomStringConvertible {
    public let message: String
    public var description: String { message }
}

/**
 * Mixes colours like paint. `weights` are parts by amount (any non-negative scale; at least one
 * positive). Returns the mixed sRGB colour (0..1).
 */
public func mixPigments(_ colors: [PigmentColor], _ weights: [Double]) throws -> [Double] {
    if colors.isEmpty { throw PigmentError(message: "mixPigments needs at least one colour.") }
    if weights.count != colors.count { throw PigmentError(message: "mixPigments got \(colors.count) colours but \(weights.count) weights; pass one weight per colour.") }
    let pigments: [Pigment] = colors.map {
        switch $0 {
        case .pigment(let p): return p
        case .rgb(let r, let g, let b): return createPigment([r, g, b])
        }
    }
    var total = 0.0
    for i in 0..<pigments.count {
        let w = weights[i]
        if !(w.isFinite && w >= 0) { throw PigmentError(message: "Weight \(i) is \(formatNumber(w)); weights must be finite and ≥ 0.") }
        total += w * pigments[i].strength * pigments[i].scatter
    }
    if !(total > 0) { throw PigmentError(message: "mixPigments needs at least one positive weight.") }
    var mix = [Double](repeating: 0, count: N)
    for i in 0..<pigments.count {
        let p = pigments[i]
        let c = (weights[i] * p.strength * p.scatter) / total
        if c == 0 { continue }
        for k in 0..<N { mix[k] += c * Double(p.ks[k]) }
    }
    var out = [0.0, 0.0, 0.0]
    ksToRgb(mix, &out, 0)
    return out
}

/// Mixes `a` towards `b` like paint: `t = 0` is `a`, `t = 1` is `b`.
public func lerpPigment(_ a: PigmentColor, _ b: PigmentColor, _ t: Double) throws -> [Double] {
    let u = clamp01(t)
    return try mixPigments([a, b], [1 - u, u])
}

/**
 * The per-dab fast path: mixes two prepared pigments (`t` of `b` into `a`) and writes the sRGB
 * result to `out[offset..offset + 2]`. Pair it with `setPigmentColor` for the colour under the brush.
 */
public func lerpPigmentInto(_ a: Pigment, _ b: Pigment, _ t: Double, _ out: inout [Double], _ offset: Int = 0) {
    let u = t > 0 ? (t < 1 ? t : 1) : 0
    let wa = (1 - u) * a.strength * a.scatter
    let wb = u * b.strength * b.scatter
    let ca = wa / (wa + wb)
    let cb = 1 - ca
    var mix = [Double](repeating: 0, count: N)
    for k in 0..<N { mix[k] = ca * Double(a.ks[k]) + cb * Double(b.ks[k]) }
    ksToRgb(mix, &out, offset)
}

/// A number as JavaScript prints it in a template string.
func formatNumber(_ v: Double) -> String {
    if v.isNaN { return "NaN" }
    if v == .infinity { return "Infinity" }
    if v == -.infinity { return "-Infinity" }
    return JSONValue.number(v).stringified()
}
