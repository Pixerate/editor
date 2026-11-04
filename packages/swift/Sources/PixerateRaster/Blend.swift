// Portions ported from photocraft-main/crates/color/src/blend.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import Foundation

/**
 * Photoshop blend modes on straight (non-premultiplied) 0..1 colours. The port of
 * `raster/blend.ts`.
 *
 * Formulas follow the W3C Compositing / ISO 32000 definitions, with Photoshop's variants where
 * they differ (Soft Light, Vivid / Linear / Pin Light, Hard Mix, Linear Burn / Dodge, Subtract,
 * Divide, Darker / Lighter Color), and the hardened `ClipColor` for the non-separable modes.
 *
 * Plus `pigment`, which is not a `B(Cb, Cs)` mode: it replaces the alpha interpolation
 * `(1 − α)·Cb + α·B` with a Kubelka-Munk paint mix of the two colours (see `lerpPigment`).
 *
 * Plus four painterly modes of our own design, which are ordinary `B(Cb, Cs)` modes:
 * `watercolor` (transparent washes, multiplied per wavelength), `tint` (the source's colour on the
 * backdrop's lightness, gently at the extremes), `highlight` (light added with a soft shoulder)
 * and `shadow` (light taken away, with ambient fill). See the painterly section below.
 */

public enum BlendMode: String, CaseIterable, Sendable, Hashable {
    case normal
    case darken
    case multiply
    case colorBurn = "color-burn"
    case linearBurn = "linear-burn"
    case darkerColor = "darker-color"
    case lighten
    case screen
    case colorDodge = "color-dodge"
    case linearDodge = "linear-dodge"
    case lighterColor = "lighter-color"
    case overlay
    case softLight = "soft-light"
    case hardLight = "hard-light"
    case vividLight = "vivid-light"
    case linearLight = "linear-light"
    case pinLight = "pin-light"
    case hardMix = "hard-mix"
    case difference
    case exclusion
    case subtract
    case divide
    case hue
    case saturation
    case color
    case luminosity
    case pigment
    case watercolor
    case tint
    case highlight
    case shadow
}

public struct BlendModeInfo: Sendable {
    public let id: BlendMode
    public let label: String
    /// Canvas `globalCompositeOperation` with the same maths, when there is one.
    public let canvas: String?
    /// True for the painterly modes (`watercolor`, `tint`, `highlight`, `shadow`), which no other app has.
    public let painterly: Bool
    /// The nearest standard (Photoshop) mode, for formats that lack this one (PSD). Missing: it is standard.
    public let standard: BlendMode?
    /// One sentence on what the mode does (painterly and pigment modes).
    public let description: String?

    init(_ id: BlendMode, _ label: String, _ canvas: String?, painterly: Bool = false, standard: BlendMode? = nil, description: String? = nil) {
        self.id = id
        self.label = label
        self.canvas = canvas
        self.painterly = painterly
        self.standard = standard
        self.description = description
    }
}

/// Every blend mode, in Photoshop's menu order.
public let BLEND_MODES: [BlendModeInfo] = [
    BlendModeInfo(.normal, "Normal", "source-over"),
    BlendModeInfo(.darken, "Darken", "darken"),
    BlendModeInfo(.multiply, "Multiply", "multiply"),
    BlendModeInfo(.colorBurn, "Color Burn", "color-burn"),
    BlendModeInfo(.linearBurn, "Linear Burn", nil),
    BlendModeInfo(.darkerColor, "Darker Color", nil),
    BlendModeInfo(.lighten, "Lighten", "lighten"),
    BlendModeInfo(.screen, "Screen", "screen"),
    BlendModeInfo(.colorDodge, "Color Dodge", "color-dodge"),
    BlendModeInfo(.linearDodge, "Linear Dodge (Add)", nil),
    BlendModeInfo(.lighterColor, "Lighter Color", nil),
    BlendModeInfo(.overlay, "Overlay", "overlay"),
    // Canvas soft-light is the W3C formula, not Photoshop's: use the scalar path.
    BlendModeInfo(.softLight, "Soft Light", nil),
    BlendModeInfo(.hardLight, "Hard Light", "hard-light"),
    BlendModeInfo(.vividLight, "Vivid Light", nil),
    BlendModeInfo(.linearLight, "Linear Light", nil),
    BlendModeInfo(.pinLight, "Pin Light", nil),
    BlendModeInfo(.hardMix, "Hard Mix", nil),
    BlendModeInfo(.difference, "Difference", "difference"),
    BlendModeInfo(.exclusion, "Exclusion", "exclusion"),
    BlendModeInfo(.subtract, "Subtract", nil),
    BlendModeInfo(.divide, "Divide", nil),
    BlendModeInfo(.hue, "Hue", "hue"),
    BlendModeInfo(.saturation, "Saturation", "saturation"),
    BlendModeInfo(.color, "Color", "color"),
    BlendModeInfo(.luminosity, "Luminosity", "luminosity"),
    // Not in Photoshop: mixes like paint (blue + yellow = green). No canvas or PSD equivalent.
    BlendModeInfo(.pigment, "Pigment", nil, standard: .normal, description: "Mixes the layer into what is below like paint, by its opacity: blue and yellow make green."),
    // Painterly modes (ours). No canvas equivalent; PSD gets `standard`.
    BlendModeInfo(.watercolor, "Watercolor", nil, painterly: true, standard: .multiply, description: "A transparent wash: the colours filter each other wavelength by wavelength, so layers darken like glazes and blue over yellow gives green. White is clear."),
    BlendModeInfo(.tint, "Tint", nil, painterly: true, standard: .color, description: "Tints what is below with the layer's colour and keeps its lightness; mid-tones take the full tint, highlights and darks stay clean."),
    BlendModeInfo(.highlight, "Highlight", nil, painterly: true, standard: .screen, description: "Adds the layer as coloured light that rolls off softly towards white instead of clipping. Black adds nothing."),
    BlendModeInfo(.shadow, "Shadow", nil, painterly: true, standard: .multiply, description: "Shades what is below as if the layer blocked the light, coloured by the layer, with ambient light so it never crushes to black. White does nothing."),
]

private let BLEND_INFO: [BlendMode: BlendModeInfo] = Dictionary(uniqueKeysWithValues: BLEND_MODES.map { ($0.id, $0) })

public func isBlendMode(_ value: String?) -> Bool {
    guard let value else { return false }
    return BlendMode(rawValue: value) != nil
}

/// The painterly modes, in menu order.
public let PAINTERLY_BLEND_MODES: [BlendMode] = BLEND_MODES.filter(\.painterly).map(\.id)

/// Whether a mode is one of the painterly modes (`watercolor`, `tint`, `highlight`, `shadow`).
public func isPainterlyBlendMode(_ mode: String?) -> Bool {
    guard let mode, let m = BlendMode(rawValue: mode) else { return false }
    return BLEND_INFO[m]?.painterly ?? false
}

/**
 * The nearest standard (Photoshop) mode: the mode itself when it is standard, `normal` for
 * `pigment`, and each painterly mode's closest relative. For writing formats that lack our modes.
 */
public func standardBlendMode(_ mode: BlendMode) -> BlendMode {
    BLEND_INFO[mode]?.standard ?? mode
}

/// A stored blend mode, or `normal` for a missing / unknown value.
public func normalizeBlendMode(_ value: String?) -> BlendMode {
    value.flatMap { BlendMode(rawValue: $0) } ?? .normal
}

/// The canvas composite operation that implements `mode` exactly, or `nil` when the canvas has none.
public func canvasCompositeOperation(_ mode: BlendMode?) -> String? {
    BLEND_INFO[mode ?? .normal]?.canvas
}

/**
 * Whether a mode works channel by channel. The non-separable ones work on whole colours (hue,
 * saturation, colour, luminosity, darker / lighter colour, pigment).
 */
public func isSeparableBlendMode(_ mode: BlendMode) -> Bool {
    switch mode {
    case .pigment, .watercolor, .tint, .hue, .saturation, .color, .luminosity, .darkerColor, .lighterColor: return false
    default: return true
    }
}

private func colorBurn(_ cb: Double, _ cs: Double) -> Double {
    if cb >= 1 { return 1 }
    if cs <= 0 { return 0 }
    return 1 - JS.min(1, (1 - cb) / cs)
}

private func colorDodge(_ cb: Double, _ cs: Double) -> Double {
    if cb <= 0 { return 0 }
    if cs >= 1 { return 1 }
    return JS.min(1, cb / (1 - cs))
}

private func hardLight(_ cb: Double, _ cs: Double) -> Double {
    if cs <= 0.5 { return cb * 2 * cs }
    let s = 2 * cs - 1
    return cb + s - cb * s
}

/// Photoshop's Soft Light (differs from W3C in the upper half).
private func softLight(_ cb: Double, _ cs: Double) -> Double {
    cs <= 0.5
        ? 2 * cb * cs + cb * cb * (1 - 2 * cs)
        : 2 * cb * (1 - cs) + JS.max(0, cb).squareRoot() * (2 * cs - 1)
}

private func vividLightHardMix(_ cb: Double, _ cs: Double) -> Double {
    let EDGE = 1e-4
    if cs <= 0.5 {
        if cb >= 1 - EDGE { return 1 }
        if cs <= 0 { return 0 }
        return 1 - JS.min(1, (1 - cb) / (2 * cs))
    }
    if cb <= EDGE { return 0 }
    if cs >= 1 { return 1 }
    return JS.min(1, cb / (2 * (1 - cs)))
}

/// Separable blend function `B(cb, cs)` of one channel. Non-separable modes return `cs`.
public func blendChannel(_ mode: BlendMode, _ cb: Double, _ cs: Double) -> Double {
    switch mode {
    case .normal: return cs
    case .darken: return JS.min(cb, cs)
    case .multiply: return cb * cs
    case .colorBurn: return colorBurn(cb, cs)
    case .linearBurn: return JS.max(0, cb + cs - 1)
    case .lighten: return JS.max(cb, cs)
    case .screen: return cb + cs - cb * cs
    case .colorDodge: return colorDodge(cb, cs)
    case .linearDodge: return JS.min(1, cb + cs)
    case .overlay: return hardLight(cs, cb)
    case .softLight: return softLight(cb, cs)
    case .hardLight: return hardLight(cb, cs)
    case .vividLight:
        if cs <= 0 { return 0 }
        if cs >= 1 { return 1 }
        return cs <= 0.5 ? colorBurn(cb, 2 * cs) : colorDodge(cb, 2 * (cs - 0.5))
    case .linearLight: return JS.min(1, JS.max(0, cb + 2 * cs - 1))
    case .pinLight: return cs <= 0.5 ? JS.min(cb, 2 * cs) : JS.max(cb, 2 * cs - 1)
    case .hardMix: return vividLightHardMix(cb, cs) >= 0.5 - 1e-6 ? 1 : 0
    case .difference: return Swift.abs(cb - cs)
    case .exclusion: return cb + cs - 2 * cb * cs
    case .subtract: return JS.max(0, cb - cs)
    case .divide:
        if cs <= 0 { return cb <= 0 ? 0 : 1 }
        return JS.min(1, cb / cs)
    case .highlight: return highlight(cb, cs)
    case .shadow: return shadow(cb, cs)
    default: return cs
    }
}

/// Luminosity of the non-separable modes (W3C / ISO 32000 weights).
public func blendLum(_ c: [Double]) -> Double {
    0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
}

/**
 * ClipColor, hardened: when the luminosity itself is out of range no colour of that luminosity
 * is in gamut, so the result is its grey (the spec formula turned such colours inside out and,
 * for greys, divided by rounding noise).
 */
private func clipColor(_ c: [Double]) -> [Double] {
    let l = blendLum(c)
    let n = JS.min(c[0], JS.min(c[1], c[2]))
    let x = JS.max(c[0], JS.max(c[1], c[2]))
    var out = [c[0], c[1], c[2]]
    if n < 0 {
        let d = l - n
        out = out.map { v in l > 0 && d > 0 ? l + ((v - l) * l) / d : l }
    }
    if x > 1 {
        let d = x - l
        out = out.map { v in l < 1 && d > 0 ? l + ((v - l) * (1 - l)) / d : l }
    }
    return out
}

/// `c` with its luminosity moved to `l`, clipped back into gamut towards grey (SetLum + ClipColor).
public func setLum(_ c: [Double], _ l: Double) -> [Double] {
    let d = l - blendLum(c)
    return clipColor([c[0] + d, c[1] + d, c[2] + d])
}

private func sat(_ c: [Double]) -> Double {
    JS.max(c[0], JS.max(c[1], c[2])) - JS.min(c[0], JS.min(c[1], c[2]))
}

private func setSat(_ c: [Double], _ s: Double) -> [Double] {
    // [0, 1, 2] sorted by value; the sort is stable, so ties keep index order.
    var idx = [0, 1, 2]
    for i in 1..<3 {
        var j = i
        while j > 0 && c[idx[j - 1]] - c[idx[j]] > 0 {
            idx.swapAt(j - 1, j)
            j -= 1
        }
    }
    let imin = idx[0], imid = idx[1], imax = idx[2]
    var out = [0.0, 0.0, 0.0]
    if c[imax] > c[imin] {
        out[imid] = ((c[imid] - c[imin]) * s) / (c[imax] - c[imin])
        out[imax] = s
    }
    out[imin] = 0
    return out
}

/**
 * `B(Cb, Cs)` of a whole colour, including the non-separable modes. `pigment` has no `B` and
 * returns `Cs`; composite it with `blendPixel` or `mixPigmentRgb`.
 */
public func blendRgb(_ mode: BlendMode, _ cb: [Double], _ cs: [Double]) -> [Double] {
    switch mode {
    case .hue: return setLum(setSat(cs, sat(cb)), blendLum(cb))
    case .saturation: return setLum(setSat(cb, sat(cs)), blendLum(cb))
    case .color: return setLum(cs, blendLum(cb))
    case .luminosity: return setLum(cb, blendLum(cs))
    case .darkerColor: return blendLum(cs) < blendLum(cb) ? [cs[0], cs[1], cs[2]] : [cb[0], cb[1], cb[2]]
    case .lighterColor: return blendLum(cs) > blendLum(cb) ? [cs[0], cs[1], cs[2]] : [cb[0], cb[1], cb[2]]
    case .watercolor: return watercolor(cb, cs)
    case .tint: return tint(cb, cs)
    default: return [blendChannel(mode, cb[0], cs[0]), blendChannel(mode, cb[1], cs[1]), blendChannel(mode, cb[2], cs[2])]
    }
}

// MARK: - Painterly modes
//
// Our own designs, written from how each effect should look. All four are true `B(Cb, Cs)`
// functions (colours 0..1, gamma-encoded), so the W3C general formula composites them like any
// other mode, opacity and alpha included. Light is added or removed in *linear* light, where it
// adds up physically; `lin` / `enc` are the sRGB transfer functions.
//
// - watercolor: R(λ) = Rb(λ)·Rs(λ) over the pigment model's reflectance spectra (non-separable).
// - tint:       Oklab: L = Lb, ab = ab_s·√(4·Lb·(1 − Lb)), chroma cut to the gamut.
// - highlight:  per channel, x = lb + (1 − lb)·(1 − e^(−ls / (1 − lb))) (separable).
// - shadow:     per channel, x = lb·(A + (1 − A)·ls), with ambient A = 0.2 (separable).

@inline(__always) private func clamp01(_ v: Double) -> Double { v > 0 ? (v < 1 ? v : 1) : 0 }

private func lin(_ v: Double) -> Double {
    let c = clamp01(v)
    return c <= 0.04045 ? c / 12.92 : JS.pow((c + 0.055) / 1.055, 2.4)
}

private func enc(_ v: Double) -> Double {
    if !(v > 0) { return 0 }
    if v >= 1 { return 1 }
    return v <= 0.0031308 ? 12.92 * v : 1.055 * JS.pow(v, 1 / 2.4) - 0.055
}

/**
 * Highlight: the source is coloured light added to the backdrop in linear light. Plain addition
 * (linear dodge) clips to flat white; here the added light `ls` fills the headroom `1 − lb`
 * exponentially, `x = lb + (1 − lb)·(1 − e^(−ls / (1 − lb)))`.
 */
private func highlight(_ cb: Double, _ cs: Double) -> Double {
    let lb = lin(cb)
    let ls = lin(cs)
    if ls <= 0 { return clamp01(cb) }
    let room = 1 - lb
    if room <= 1e-9 { return 1 }
    return enc(lb + room * (1 - JS.exp(-ls / room)))
}

/// Shadow's ambient light: the share of light that still reaches a fully shaded area.
public let SHADOW_AMBIENT = 0.2

/**
 * Shadow: the source says how much light still reaches each channel (white: all of it, black:
 * none), in linear light, plus ambient light `A` that fills every shadow: `x = lb·(A + (1 − A)·ls)`.
 */
private func shadow(_ cb: Double, _ cs: Double) -> Double {
    if cs >= 1 { return clamp01(cb) }
    return enc(lin(cb) * (SHADOW_AMBIENT + (1 - SHADOW_AMBIENT) * lin(cs)))
}

/// Reflectance spectra of 8-bit colours (key `r << 16 | g << 8 | b`), for `watercolor`.
private let spectrumCache = Locked([Int: [Float]]())
/// About 2.4 MB of spectra; the cache starts over when it fills.
private let SPECTRUM_CACHE_MAX = 16384

private func spectrum8(_ r: Int, _ g: Int, _ b: Int) -> [Float] {
    let key = (r << 16) | (g << 8) | b
    if let s = spectrumCache.with({ $0[key] }) { return s }
    let s = rgbToReflectance(Double(r) / 255, Double(g) / 255, Double(b) / 255)
    spectrumCache.with { cache in
        if cache.count >= SPECTRUM_CACHE_MAX { cache.removeAll() }
        cache[key] = s
    }
    return s
}

/**
 * Watercolor: the source is a transparent wash over the backdrop. The reflectances multiply band
 * by band, `R(λ) = Rb(λ)·Rs(λ)`, using each colour's smooth reflectance spectrum from the pigment
 * model, then back to sRGB. White is clear (exactly: it returns the backdrop). Colours are
 * quantised to 8 bits and their spectra cached.
 */
private func watercolor(_ cb: [Double], _ cs: [Double]) -> [Double] {
    let q = { (v: Double) in Int(JS.round(clamp01(v) * 255)) }
    let b0 = q(cb[0]), b1 = q(cb[1]), b2 = q(cb[2])
    let s0 = q(cs[0]), s1 = q(cs[1]), s2 = q(cs[2])
    if s0 == 255 && s1 == 255 && s2 == 255 { return [clamp01(cb[0]), clamp01(cb[1]), clamp01(cb[2])] }
    if b0 == 255 && b1 == 255 && b2 == 255 { return [clamp01(cs[0]), clamp01(cs[1]), clamp01(cs[2])] }
    if (b0 | b1 | b2) == 0 || (s0 | s1 | s2) == 0 { return [0, 0, 0] }
    let rb = spectrum8(b0, b1, b2)
    let rs = spectrum8(s0, s1, s2)
    var wash = [Float](repeating: 0, count: rb.count)
    for k in 0..<rb.count { wash[k] = Float(Double(rb[k]) * Double(rs[k])) }
    return reflectanceToRgb(wash)
}

/// Linear sRGB → Oklab (Björn Ottosson, 2020).
private func toOklab(_ r: Double, _ g: Double, _ b: Double) -> [Double] {
    let l = JS.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    let m = JS.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    let s = JS.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ]
}

/// Oklab → linear sRGB (unclipped).
private func fromOklab(_ L: Double, _ a: Double, _ b: Double) -> [Double] {
    let l = JS.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3)
    let m = JS.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3)
    let s = JS.pow(L - 0.0894841775 * a - 1.291485548 * b, 3)
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ]
}

private func inGamut(_ c: [Double]) -> Bool {
    c[0] >= -1e-6 && c[0] <= 1 + 1e-6 && c[1] >= -1e-6 && c[1] <= 1 + 1e-6 && c[2] >= -1e-6 && c[2] <= 1 + 1e-6
}

/**
 * Tint: the backdrop takes the source's colour and keeps its own lightness, in Oklab:
 * `L = Lb` and `ab = ab_s·w` with `w = √(4·Lb·(1 − Lb))`. Out-of-gamut results lose chroma
 * (bisection at constant L and hue), not lightness. A grey source neutralises.
 */
private func tint(_ cb: [Double], _ cs: [Double]) -> [Double] {
    let labB = toOklab(lin(cb[0]), lin(cb[1]), lin(cb[2]))
    let labS = toOklab(lin(cs[0]), lin(cs[1]), lin(cs[2]))
    let L = labB[0]
    let w = JS.min(1, JS.max(0, 4 * L * (1 - L))).squareRoot()
    let a = labS[1] * w
    let b = labS[2] * w
    var rgb = fromOklab(L, a, b)
    if !inGamut(rgb) {
        var lo = 0.0
        var hi = 1.0
        for _ in 0..<14 {
            let mid = (lo + hi) / 2
            rgb = fromOklab(L, a * mid, b * mid)
            if inGamut(rgb) { lo = mid } else { hi = mid }
        }
        rgb = fromOklab(L, a * lo, b * lo)
    }
    return [enc(rgb[0]), enc(rgb[1]), enc(rgb[2])]
}

// MARK: - Pigment

/**
 * The `pigment` mode's colour: `t` of `cs` mixed into `cb` like paint (`lerpPigment`). `t ≥ 1`
 * (or equal colours) is `cs` exactly. Colours are 0..1.
 */
public func mixPigmentRgb(_ cb: [Double], _ cs: [Double], _ t: Double) -> [Double] {
    if t >= 1 || (cb[0] == cs[0] && cb[1] == cs[1] && cb[2] == cs[2]) { return [cs[0], cs[1], cs[2]] }
    if !(t > 0) { return [cb[0], cb[1], cb[2]] }
    let a = createPigment([0, 0, 0])
    let b = createPigment([0, 0, 0])
    setPigmentColor(a, cb[0], cb[1], cb[2], 1)
    setPigmentColor(b, cs[0], cs[1], cs[2], 1)
    var out = [0.0, 0.0, 0.0]
    lerpPigmentInto(a, b, t, &out, 0)
    return out
}

/// K/S of 8-bit colours (key `r << 16 | g << 8 | b`), shared by every 8-bit pigment composite.
private let pigmentCache = Locked([Int: Pigment]())
/// About 3 MB of spectra; the cache starts over when it fills.
private let PIGMENT_CACHE_MAX = 16384

/**
 * The prepared pigment (K/S spectrum) of an 8-bit colour, from the cache every 8-bit pigment
 * composite shares. Read-only: do not retarget it with `setPigmentColor`.
 */
public func pigment8(_ r: Int, _ g: Int, _ b: Int) -> Pigment {
    cachedPigment(r, g, b)
}

private func cachedPigment(_ r: Int, _ g: Int, _ b: Int) -> Pigment {
    let key = (r << 16) | (g << 8) | b
    if let p = pigmentCache.with({ $0[key] }) { return p }
    let p = createPigment([Double(r) / 255, Double(g) / 255, Double(b) / 255])
    pigmentCache.with { cache in
        if cache.count >= PIGMENT_CACHE_MAX { cache.removeAll() }
        cache[key] = p
    }
    return p
}

/**
 * `mixPigmentRgb` on 8-bit channels, with each colour's spectrum cached: writes the 0..1 result to
 * `out[0..2]`. The compositor's and `blendImageData`'s per-pixel path.
 */
public func mixPigment8(_ b0: Int, _ b1: Int, _ b2: Int, _ s0: Int, _ s1: Int, _ s2: Int, _ t: Double, _ out: inout [Double]) {
    if t >= 1 || (b0 == s0 && b1 == s1 && b2 == s2) {
        out[0] = Double(s0) / 255
        out[1] = Double(s1) / 255
        out[2] = Double(s2) / 255
        return
    }
    lerpPigmentInto(cachedPigment(b0, b1, b2), cachedPigment(s0, s1, s2), t, &out, 0)
}

/**
 * Composites a straight-alpha `source` over a straight-alpha `backdrop` (both RGBA in 0..1; alpha
 * missing = 1) with a blend mode and an extra `alpha` (opacity), using the W3C general formula:
 * `αo = αs + αb(1 − αs)`, `αo·Co = (1 − αs)·αb·Cb + (1 − αb)·αs·Cs + αs·αb·B(Cb, Cs)`.
 *
 * `pigment` mixes the colours like paint instead, by amount: `Co = lerpPigment(Cb, Cs, αs / αo)`.
 */
public func blendPixel(_ mode: BlendMode, _ backdrop: [Double], _ source: [Double], _ alpha: Double = 1) -> [Double] {
    let ab = backdrop.count > 3 ? backdrop[3] : 1
    let as_ = (source.count > 3 ? source[3] : 1) * alpha
    if !(as_ > 0) { return [backdrop[0], backdrop[1], backdrop[2], ab] }
    let ao = as_ + ab * (1 - as_)
    if ao <= 0 { return [0, 0, 0, 0] }
    if mode == .pigment {
        let m = mixPigmentRgb(backdrop, source, as_ / ao)
        return [m[0], m[1], m[2], ao]
    }
    let b = blendRgb(mode, backdrop, source)
    var out = [0.0, 0.0, 0.0, ao]
    for i in 0..<3 {
        out[i] = ((1 - as_) * ab * backdrop[i] + (1 - ab) * as_ * source[i] + as_ * ab * b[i]) / ao
    }
    return out
}

/**
 * Blends `source` into `backdrop` in place (8-bit straight RGBA of the same size) with
 * `blendPixel`. The scalar fallback for modes the canvas cannot composite.
 */
public func blendImageData(_ d: inout [UInt8], _ s: [UInt8], _ mode: BlendMode, _ alpha: Double = 1) {
    let len = Swift.min(d.count, s.count)
    var cb = [0.0, 0.0, 0.0, 0.0]
    var cs = [0.0, 0.0, 0.0, 0.0]
    let pigment = mode == .pigment
    var i = 0
    while i < len {
        defer { i += 4 }
        if s[i + 3] == 0 { continue }
        if pigment {
            let as_ = (Double(s[i + 3]) / 255) * alpha
            if !(as_ > 0) { continue }
            let ao = as_ + (Double(d[i + 3]) / 255) * (1 - as_)
            mixPigment8(Int(d[i]), Int(d[i + 1]), Int(d[i + 2]), Int(s[i]), Int(s[i + 1]), Int(s[i + 2]), as_ / ao, &cb)
            d[i] = JS.u8c(JS.round(cb[0] * 255))
            d[i + 1] = JS.u8c(JS.round(cb[1] * 255))
            d[i + 2] = JS.u8c(JS.round(cb[2] * 255))
            d[i + 3] = JS.u8c(JS.round(ao * 255))
            continue
        }
        for k in 0..<4 {
            cb[k] = Double(d[i + k]) / 255
            cs[k] = Double(s[i + k]) / 255
        }
        let o = blendPixel(mode, cb, cs, alpha)
        d[i] = JS.u8c(JS.round(o[0] * 255))
        d[i + 1] = JS.u8c(JS.round(o[1] * 255))
        d[i + 2] = JS.u8c(JS.round(o[2] * 255))
        d[i + 3] = JS.u8c(JS.round(o[3] * 255))
    }
}
