import Foundation
import PixerateCore

/**
 * CSS colour parsing and normalisation (`color/parse.ts`, `color/convert.ts`, `color/gamut.ts`,
 * `color/format.ts` `formatHex` / `normalizeColor`, `color/dual.ts` `parseDualColor` /
 * `normalizeDualColor`): hex, `rgb()`, `hsl()`, `oklab()`, `oklch()`, `color()` (srgb,
 * srgb-linear, display-p3) and the CSS named colours, mapped into sRGB as the TS core maps them.
 * Ported line by line with JavaScript's number parsing (`Number(...)`) and V8's maths (`JS`).
 */

/// Unclamped sRGB channels (0–1 nominally) and alpha (`Rgba`).
public struct CssRgba: Equatable, Sendable {
    public var r: Double
    public var g: Double
    public var b: Double
    public var a: Double
    public init(r: Double, g: Double, b: Double, a: Double) {
        self.r = r
        self.g = g
        self.b = b
        self.a = a
    }
}

/// The 148 CSS named colours plus `transparent` (`NAMED_COLORS`).
let CSS_NAMED_COLORS: [String: String] = [
    "aliceblue": "#f0f8ff", "antiquewhite": "#faebd7", "aqua": "#00ffff", "aquamarine": "#7fffd4", "azure": "#f0ffff",
    "beige": "#f5f5dc", "bisque": "#ffe4c4", "black": "#000000", "blanchedalmond": "#ffebcd", "blue": "#0000ff",
    "blueviolet": "#8a2be2", "brown": "#a52a2a", "burlywood": "#deb887", "cadetblue": "#5f9ea0", "chartreuse": "#7fff00",
    "chocolate": "#d2691e", "coral": "#ff7f50", "cornflowerblue": "#6495ed", "cornsilk": "#fff8dc", "crimson": "#dc143c",
    "cyan": "#00ffff", "darkblue": "#00008b", "darkcyan": "#008b8b", "darkgoldenrod": "#b8860b", "darkgray": "#a9a9a9",
    "darkgreen": "#006400", "darkgrey": "#a9a9a9", "darkkhaki": "#bdb76b", "darkmagenta": "#8b008b", "darkolivegreen": "#556b2f",
    "darkorange": "#ff8c00", "darkorchid": "#9932cc", "darkred": "#8b0000", "darksalmon": "#e9967a", "darkseagreen": "#8fbc8f",
    "darkslateblue": "#483d8b", "darkslategray": "#2f4f4f", "darkslategrey": "#2f4f4f", "darkturquoise": "#00ced1",
    "darkviolet": "#9400d3", "deeppink": "#ff1493", "deepskyblue": "#00bfff", "dimgray": "#696969", "dimgrey": "#696969",
    "dodgerblue": "#1e90ff", "firebrick": "#b22222", "floralwhite": "#fffaf0", "forestgreen": "#228b22", "fuchsia": "#ff00ff",
    "gainsboro": "#dcdcdc", "ghostwhite": "#f8f8ff", "gold": "#ffd700", "goldenrod": "#daa520", "gray": "#808080",
    "green": "#008000", "greenyellow": "#adff2f", "grey": "#808080", "honeydew": "#f0fff0", "hotpink": "#ff69b4",
    "indianred": "#cd5c5c", "indigo": "#4b0082", "ivory": "#fffff0", "khaki": "#f0e68c", "lavender": "#e6e6fa",
    "lavenderblush": "#fff0f5", "lawngreen": "#7cfc00", "lemonchiffon": "#fffacd", "lightblue": "#add8e6",
    "lightcoral": "#f08080", "lightcyan": "#e0ffff", "lightgoldenrodyellow": "#fafad2", "lightgray": "#d3d3d3",
    "lightgreen": "#90ee90", "lightgrey": "#d3d3d3", "lightpink": "#ffb6c1", "lightsalmon": "#ffa07a", "lightseagreen": "#20b2aa",
    "lightskyblue": "#87cefa", "lightslategray": "#778899", "lightslategrey": "#778899", "lightsteelblue": "#b0c4de",
    "lightyellow": "#ffffe0", "lime": "#00ff00", "limegreen": "#32cd32", "linen": "#faf0e6", "magenta": "#ff00ff",
    "maroon": "#800000", "mediumaquamarine": "#66cdaa", "mediumblue": "#0000cd", "mediumorchid": "#ba55d3",
    "mediumpurple": "#9370db", "mediumseagreen": "#3cb371", "mediumslateblue": "#7b68ee", "mediumspringgreen": "#00fa9a",
    "mediumturquoise": "#48d1cc", "mediumvioletred": "#c71585", "midnightblue": "#191970", "mintcream": "#f5fffa",
    "mistyrose": "#ffe4e1", "moccasin": "#ffe4b5", "navajowhite": "#ffdead", "navy": "#000080", "oldlace": "#fdf5e6",
    "olive": "#808000", "olivedrab": "#6b8e23", "orange": "#ffa500", "orangered": "#ff4500", "orchid": "#da70d6",
    "palegoldenrod": "#eee8aa", "palegreen": "#98fb98", "paleturquoise": "#afeeee", "palevioletred": "#db7093",
    "papayawhip": "#ffefd5", "peachpuff": "#ffdab9", "peru": "#cd853f", "pink": "#ffc0cb", "plum": "#dda0dd",
    "powderblue": "#b0e0e6", "purple": "#800080", "rebeccapurple": "#663399", "red": "#ff0000", "rosybrown": "#bc8f8f",
    "royalblue": "#4169e1", "saddlebrown": "#8b4513", "salmon": "#fa8072", "sandybrown": "#f4a460", "seagreen": "#2e8b57",
    "seashell": "#fff5ee", "sienna": "#a0522d", "silver": "#c0c0c0", "skyblue": "#87ceeb", "slateblue": "#6a5acd",
    "slategray": "#708090", "slategrey": "#708090", "snow": "#fffafa", "springgreen": "#00ff7f", "steelblue": "#4682b4",
    "tan": "#d2b48c", "teal": "#008080", "thistle": "#d8bfd8", "tomato": "#ff6347", "transparent": "#00000000",
    "turquoise": "#40e0d0", "violet": "#ee82ee", "wheat": "#f5deb3", "white": "#ffffff", "whitesmoke": "#f5f5f5",
    "yellow": "#ffff00", "yellowgreen": "#9acd32",
]

/// `Math.sign`.
private func jsSign(_ v: Double) -> Double {
    if v.isNaN { return .nan }
    if v > 0 { return 1 }
    if v < 0 { return -1 }
    return v
}

/// `srgbToLinear`: a gamma-encoded channel to linear, keeping sign.
func cssSrgbToLinear(_ v: Double) -> Double {
    let sign = jsSign(v)
    let a = Swift.abs(v)
    return sign * (a <= 0.04045 ? a / 12.92 : JS.pow((a + 0.055) / 1.055, 2.4))
}

/// `linearToSrgb`: a linear channel to gamma-encoded, keeping sign.
func cssLinearToSrgb(_ v: Double) -> Double {
    let sign = jsSign(v)
    let a = Swift.abs(v)
    return sign * (a <= 0.0031308 ? 12.92 * a : 1.055 * JS.pow(a, 1 / 2.4) - 0.055)
}

/// `hslToRgb` (h in degrees, s and l 0–1).
private func hslToRgb(_ h: Double, _ s: Double, _ l: Double, _ alpha: Double) -> CssRgba {
    let hh = ((h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)) / 60
    let c = (1 - Swift.abs(2 * l - 1)) * s
    let x = c * (1 - Swift.abs(hh.truncatingRemainder(dividingBy: 2) - 1))
    let m = l - c / 2
    var r = 0.0, g = 0.0, b = 0.0
    if hh < 1 { r = c; g = x; b = 0 }
    else if hh < 2 { r = x; g = c; b = 0 }
    else if hh < 3 { r = 0; g = c; b = x }
    else if hh < 4 { r = 0; g = x; b = c }
    else if hh < 5 { r = x; g = 0; b = c }
    else { r = c; g = 0; b = x }
    return CssRgba(r: r + m, g: g + m, b: b + m, a: alpha)
}

/// `rgbToOklab`: (l, a, b) of sRGB channels, unclamped.
private func rgbToOklab(_ c: CssRgba) -> (l: Double, a: Double, b: Double) {
    let lr = cssSrgbToLinear(c.r)
    let lg = cssSrgbToLinear(c.g)
    let lb = cssSrgbToLinear(c.b)
    let l = JS.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
    let m = JS.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
    let s = JS.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
    let ol = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
    let oa = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
    let ob = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    return (ol, oa, ob)
}

/// `oklabToRgb`: sRGB channels of an OKLab colour, unclamped.
private func oklabToRgb(_ L: Double, _ A: Double, _ B: Double, _ alpha: Double) -> CssRgba {
    let l_ = L + 0.3963377774 * A + 0.2158037573 * B
    let m_ = L - 0.1055613458 * A - 0.0638541728 * B
    let s_ = L - 0.0894841775 * A - 1.291485548 * B
    let l = JS.pow(l_, 3)
    let m = JS.pow(m_, 3)
    let s = JS.pow(s_, 3)
    let r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    let b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
    return CssRgba(r: cssLinearToSrgb(r), g: cssLinearToSrgb(g), b: cssLinearToSrgb(b), a: alpha)
}

/// `oklabToOklch`: (l, c, h) with h in degrees 0–360 (0 when c < 1e-6).
private func oklabToOklch(_ lab: (l: Double, a: Double, b: Double)) -> (l: Double, c: Double, h: Double) {
    let c = JS.hypot(lab.a, lab.b)
    var h = 0.0
    if c >= 1e-6 {
        h = (JS.atan2(lab.b, lab.a) * 180) / Double.pi
        if h < 0 { h += 360 }
        if h >= 360 { h -= 360 }
    }
    return (lab.l, c, h)
}

/// `rgbToOklab` (`color/convert.ts`): (l, a, b) of sRGB channels, unclamped.
public func cssRgbToOklab(_ c: CssRgba) -> (l: Double, a: Double, b: Double) { rgbToOklab(c) }

/// `oklabToOklch` (`color/convert.ts`): (l, c, h) with h in degrees.
public func cssOklabToOklch(_ lab: (l: Double, a: Double, b: Double)) -> (l: Double, c: Double, h: Double) { oklabToOklch(lab) }

/// `relativeLuminance` (`color/contrast.ts`): WCAG 2 relative luminance, 0 for black, 1 for white.
public func cssRelativeLuminance(_ c: CssRgba) -> Double {
    0.2126 * cssSrgbToLinear(c.r) + 0.7152 * cssSrgbToLinear(c.g) + 0.0722 * cssSrgbToLinear(c.b)
}

private func cssComposite(_ fg: CssRgba, _ bg: CssRgba) -> CssRgba {
    let a = fg.a + bg.a * (1 - fg.a)
    if a == 0 { return CssRgba(r: 0, g: 0, b: 0, a: 0) }
    return CssRgba(
        r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
        g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
        b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
        a: a
    )
}

/// `contrastRatio` (`color/contrast.ts`): the WCAG 2 ratio, 1 to 21. A translucent background is
/// judged over white, a translucent foreground over the background.
public func cssContrastRatio(_ foreground: CssRgba, _ background: CssRgba) -> Double {
    var bg = background
    if bg.a < 1 { bg = cssComposite(bg, CssRgba(r: 1, g: 1, b: 1, a: 1)) }
    var fg = foreground
    if fg.a < 1 { fg = cssComposite(fg, bg) }
    let l1 = cssRelativeLuminance(fg)
    let l2 = cssRelativeLuminance(bg)
    return (JS.max(l1, l2) + 0.05) / (JS.min(l1, l2) + 0.05)
}

/// `contrast` (`color/ink.ts`) for CSS text: the ratio, or `nil` when either cannot be read.
public func cssContrast(_ a: String, _ b: String) -> Double? {
    guard let fg = parseCssColor(a), let bg = parseCssColor(b) else { return nil }
    return cssContrastRatio(fg, bg)
}

/// `inkSide` (`color/ink.ts`) by contrast: `dark` when `dark` contrasts at least as much with
/// `fill` as `light` does, else `light`; `nil` when a colour cannot be read.
public func cssInkSide(_ fill: String, dark: String = "#111111", light: String = "#ffffff") -> String? {
    guard let f = parseCssColor(fill), let d = parseCssColor(dark), let l = parseCssColor(light) else { return nil }
    return cssContrastRatio(d, f) >= cssContrastRatio(l, f) ? "dark" : "light"
}

/// `oklchToOklab` then `oklabToRgb`.
private func oklchToRgb(_ l: Double, _ c: Double, _ h: Double, _ alpha: Double) -> CssRgba {
    let rad = (h * Double.pi) / 180
    return oklabToRgb(l, c * JS.cos(rad), c * JS.sin(rad), alpha)
}

// MARK: Display P3 (`cms/math.ts`)

private typealias Mat3 = [[Double]]

private func mul(_ a: Mat3, _ b: Mat3) -> Mat3 {
    var o: Mat3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    for i in 0 ..< 3 { for j in 0 ..< 3 { o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j] } }
    return o
}

private func apply(_ m: Mat3, _ v: [Double]) -> [Double] {
    let x = m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2]
    let y = m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2]
    let z = m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]
    return [x, y, z]
}

private func det(_ m: Mat3) -> Double {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

private func invert(_ m: Mat3) -> Mat3 {
    let k = 1 / det(m)
    return [
        [(m[1][1] * m[2][2] - m[1][2] * m[2][1]) * k, (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * k, (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * k],
        [(m[1][2] * m[2][0] - m[1][0] * m[2][2]) * k, (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * k, (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * k],
        [(m[1][0] * m[2][1] - m[1][1] * m[2][0]) * k, (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * k, (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * k],
    ]
}

private func xyToXyz(_ x: Double, _ y: Double) -> [Double] { [x / y, 1, (1 - x - y) / y] }

private func rgbToXyzMatrix(_ r: (Double, Double), _ g: (Double, Double), _ b: (Double, Double), _ white: [Double]) -> Mat3 {
    let xr = xyToXyz(r.0, r.1)
    let xg = xyToXyz(g.0, g.1)
    let xb = xyToXyz(b.0, b.1)
    let m: Mat3 = [[xr[0], xg[0], xb[0]], [xr[1], xg[1], xb[1]], [xr[2], xg[2], xb[2]]]
    let s = apply(invert(m), white)
    return [
        [m[0][0] * s[0], m[0][1] * s[1], m[0][2] * s[2]],
        [m[1][0] * s[0], m[1][1] * s[1], m[1][2] * s[2]],
        [m[2][0] * s[0], m[2][1] * s[1], m[2][2] * s[2]],
    ]
}

/// `P3_TO_SRGB_MAT` of `convert.ts`, built the same way.
private let P3_TO_SRGB_MAT: Mat3 = {
    let white = xyToXyz(0.3127, 0.329)
    let srgbToXyz = rgbToXyzMatrix((0.64, 0.33), (0.30, 0.60), (0.15, 0.06), white)
    let p3ToXyz = rgbToXyzMatrix((0.680, 0.320), (0.265, 0.690), (0.150, 0.060), white)
    return mul(invert(srgbToXyz), p3ToXyz)
}()

// MARK: Parsing (`parse.ts`)

/// `Number(text)` after a `%` is taken off.
private func numberOf(_ text: String, dropping suffix: Int) -> Double { String(text.dropLast(suffix)).jsToNumber }

/// `parsePercentOrNumber`.
private func parsePercentOrNumber(_ v: String, _ scale: Double) -> Double? {
    let text = v.jsTrimmed
    let isPct = text.hasSuffix("%")
    let num = numberOf(text, dropping: isPct ? 1 : 0)
    if !num.isFinite { return nil }
    return isPct ? num / 100 : num / scale
}

/// `parseAlpha` (a missing or blank alpha is 1).
private func parseAlpha(_ v: String?) -> Double? {
    guard let v, !v.jsTrimmed.isEmpty else { return 1 }
    let text = v.jsTrimmed
    let isPct = text.hasSuffix("%")
    let num = numberOf(text, dropping: isPct ? 1 : 0)
    if !num.isFinite { return nil }
    return isPct ? num / 100 : num
}

/// `parseAngle`: degrees from `deg`, `turn`, `rad` or a bare number.
private func parseAngle(_ v: String) -> Double? {
    let text = v.jsTrimmed.jsLowercased
    if text.hasSuffix("deg") {
        let num = numberOf(text, dropping: 3)
        return num.isFinite ? num : nil
    }
    if text.hasSuffix("turn") {
        let num = numberOf(text, dropping: 4)
        return num.isFinite ? num * 360 : nil
    }
    if text.hasSuffix("rad") {
        let num = numberOf(text, dropping: 3)
        return num.isFinite ? (num * 180) / Double.pi : nil
    }
    let num = text.jsToNumber
    return num.isFinite ? num : nil
}

/// `splitParts`: the parts before the first `/` (split on white space and commas) and the rest.
private func splitParts(_ inner: String) -> (parts: [String], alphaPart: String?) {
    var main = inner
    var alphaPart: String?
    if let slash = inner.firstIndex(of: "/") {
        main = String(inner[..<slash])
        alphaPart = String(inner[inner.index(after: slash)...])
    }
    var parts: [String] = []
    var cur = String.UnicodeScalarView()
    for s in main.jsTrimmed.unicodeScalars {
        if isJSWhitespace(s) || s == "," {
            if !cur.isEmpty {
                parts.append(String(cur))
                cur = String.UnicodeScalarView()
            }
        } else {
            cur.append(s)
        }
    }
    if !cur.isEmpty { parts.append(String(cur)) }
    return (parts, alphaPart)
}

/// `inner` of `name(inner)` when `text` is that call with no parentheses inside (`RGB_RE` and friends, case-insensitive).
private func functionInner(_ text: String, _ names: [String]) -> String? {
    guard text.hasSuffix(")") else { return nil }
    let lower = text.lowercased()
    for name in names where lower.hasPrefix(name + "(") {
        let inner = text.dropFirst(name.count + 1).dropLast()
        if inner.contains("(") || inner.contains(")") { return nil }
        return String(inner)
    }
    return nil
}

/// The parts and alpha of a three-channel function (four parts and no `/`: the last is alpha).
private func channelsAndAlpha(_ inner: String) -> (parts: [String], alpha: Double?) {
    var (parts, alphaPart) = splitParts(inner)
    var alpha: Double? = 1
    if let alphaPart { alpha = parseAlpha(alphaPart) } else if parts.count == 4 { alpha = parseAlpha(parts.removeLast()) }
    return (parts, alpha)
}

private func isHexDigit(_ c: Character) -> Bool { c.isASCII && c.isHexDigit }

/// `parseHex`.
private func parseHex(_ hex: String) -> CssRgba? {
    var raw = hex.jsTrimmed
    if raw.hasPrefix("#") { raw = String(raw.dropFirst()) }
    if raw.count == 3 || raw.count == 4 { raw = raw.map { "\($0)\($0)" }.joined() }
    guard raw.count == 6 || raw.count == 8 else { return nil }
    let chars = Array(raw)
    func byte(_ i: Int) -> Double { Double(Int(String(chars[i ..< i + 2]), radix: 16) ?? 0) / 255 }
    return CssRgba(r: byte(0), g: byte(2), b: byte(4), a: chars.count == 8 ? byte(6) : 1)
}

/// `parseColor` for strings: unclamped channels, or nil for anything it does not read.
public func parseCssColor(_ input: String) -> CssRgba? {
    let text = input.jsTrimmed
    if text.isEmpty || text.utf16.count > 200 { return nil }
    let lower = text.jsLowercased
    if let named = CSS_NAMED_COLORS[lower] { return parseHex(named) }
    if text.hasPrefix("#") {
        let digits = text.dropFirst()
        if [3, 4, 6, 8].contains(digits.count), digits.allSatisfy(isHexDigit) { return parseHex(text) }
    }
    if let inner = functionInner(text, ["rgba", "rgb"]) {
        let (parts, alpha) = channelsAndAlpha(inner)
        guard parts.count == 3, let alpha else { return nil }
        guard let r = parsePercentOrNumber(parts[0], 255), let g = parsePercentOrNumber(parts[1], 255), let b = parsePercentOrNumber(parts[2], 255) else { return nil }
        return CssRgba(r: r, g: g, b: b, a: alpha)
    }
    if let inner = functionInner(text, ["hsla", "hsl"]) {
        let (parts, alpha) = channelsAndAlpha(inner)
        guard parts.count == 3, let alpha else { return nil }
        guard let h = parseAngle(parts[0]), let s = parsePercentOrNumber(parts[1], 100), let l = parsePercentOrNumber(parts[2], 100) else { return nil }
        return hslToRgb(h, s, l, alpha)
    }
    if let inner = functionInner(text, ["oklab"]) {
        let (parts, alpha) = channelsAndAlpha(inner)
        guard parts.count == 3, let alpha else { return nil }
        guard let l = parsePercentOrNumber(parts[0], 1), let a = parsePercentOrNumber(parts[1], 1), let b = parsePercentOrNumber(parts[2], 1) else { return nil }
        return oklabToRgb(l, a, b, alpha)
    }
    if let inner = functionInner(text, ["oklch"]) {
        let (parts, alpha) = channelsAndAlpha(inner)
        guard parts.count == 3, let alpha else { return nil }
        guard let l = parsePercentOrNumber(parts[0], 1), let c = parsePercentOrNumber(parts[1], 1), let h = parseAngle(parts[2]) else { return nil }
        return oklchToRgb(l, c, h, alpha)
    }
    if let inner = functionInner(text, ["color"]) {
        var (parts, alphaPart) = splitParts(inner)
        if parts.count < 4 { return nil }
        let space = parts[0].jsLowercased
        var alpha: Double? = 1
        if let alphaPart { alpha = parseAlpha(alphaPart) } else if parts.count == 5 { alpha = parseAlpha(parts.removeLast()) }
        guard parts.count == 4, let alpha else { return nil }
        guard let c1 = parsePercentOrNumber(parts[1], 1), let c2 = parsePercentOrNumber(parts[2], 1), let c3 = parsePercentOrNumber(parts[3], 1) else { return nil }
        switch space {
        case "srgb": return CssRgba(r: c1, g: c2, b: c3, a: alpha)
        case "srgb-linear": return CssRgba(r: cssLinearToSrgb(c1), g: cssLinearToSrgb(c2), b: cssLinearToSrgb(c3), a: alpha)
        case "display-p3":
            let lin = apply(P3_TO_SRGB_MAT, [cssSrgbToLinear(c1), cssSrgbToLinear(c2), cssSrgbToLinear(c3)])
            return CssRgba(r: cssLinearToSrgb(lin[0]), g: cssLinearToSrgb(lin[1]), b: cssLinearToSrgb(lin[2]), a: alpha)
        default: return nil
        }
    }
    return nil
}

// MARK: Gamut mapping and hex (`gamut.ts`, `format.ts`)

private func clamp01(_ v: Double) -> Double { JS.min(1, JS.max(0, v)) }

private func inSrgbGamut(_ c: CssRgba, _ epsilon: Double = 1e-5) -> Bool {
    c.r >= -epsilon && c.r <= 1 + epsilon && c.g >= -epsilon && c.g <= 1 + epsilon && c.b >= -epsilon && c.b <= 1 + epsilon
}

private func deltaEOK(_ a: CssRgba, _ b: CssRgba) -> Double {
    let la = rgbToOklab(a)
    let lb = rgbToOklab(b)
    return JS.hypot(la.l - lb.l, la.a - lb.a, la.b - lb.b)
}

/// `toSrgbGamut`: CSS Color 4 gamut mapping (binary search on OKLCH chroma).
public func cssToSrgbGamut(_ c: CssRgba) -> CssRgba {
    let lch = oklabToOklch(rgbToOklab(c))
    if lch.l >= 1 { return CssRgba(r: 1, g: 1, b: 1, a: c.a) }
    if lch.l <= 0 { return CssRgba(r: 0, g: 0, b: 0, a: c.a) }
    if inSrgbGamut(c) { return CssRgba(r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b), a: c.a) }
    var low = 0.0
    var high = lch.c
    var clippedCandidate = CssRgba(r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b), a: c.a)
    let JND = 0.02
    let EPS = 0.0001
    for _ in 0 ..< 30 {
        let mid = (low + high) / 2
        let candidate = oklchToRgb(lch.l, mid, lch.h, c.a)
        let clipped = CssRgba(r: clamp01(candidate.r), g: clamp01(candidate.g), b: clamp01(candidate.b), a: c.a)
        clippedCandidate = clipped
        let dE = deltaEOK(candidate, clipped)
        if dE < JND {
            if JND - dE < EPS { return clipped }
            low = mid
        } else {
            high = mid
        }
        if high - low < 1e-4 { break }
    }
    return clippedCandidate
}

/// `formatHex`: gamut-mapped lowercase `#rrggbb`, or `#rrggbbaa` when alpha is below 1.
public func cssFormatHex(_ c: CssRgba) -> String {
    let mapped = cssToSrgbGamut(c)
    func byte(_ v: Double) -> Int { Int(JS.round(clamp01(v) * 255)) }
    func hex2(_ n: Int) -> String { (n < 16 ? "0" : "") + String(n, radix: 16) }
    let head = "#\(hex2(byte(mapped.r)))\(hex2(byte(mapped.g)))\(hex2(byte(mapped.b)))"
    let alpha = byte(mapped.a)
    return alpha == 255 ? head : head + hex2(alpha)
}

/// `normalizeColor` for strings: the colour as lowercase hex, or nil.
public func normalizeCssColor(_ input: String) -> String? { parseCssColor(input).map(cssFormatHex) }

/// `parseDualColor`: `{ light, dark }` (both strings), `light-dark(a, b)` or one colour for both, as written; nil otherwise.
public func parseCssDualColor(_ input: JSONValue?) -> (light: String, dark: String)? {
    if let o = input?.objectValue, case .string(let light)? = o["light"], case .string(let dark)? = o["dark"] {
        guard parseCssColor(light) != nil, parseCssColor(dark) != nil else { return nil }
        return (light, dark)
    }
    guard case .string(let s)? = input else { return nil }
    let trimmed = s.jsTrimmed
    if trimmed.jsLowercased.hasPrefix("light-dark("), trimmed.hasSuffix(")") {
        let inner = Array(String(trimmed.dropFirst("light-dark(".count).dropLast()).jsTrimmed)
        if String(inner).jsLowercased.contains("light-dark(") { return nil }
        var depth = 0
        var comma = -1
        for (i, ch) in inner.enumerated() {
            if ch == "(" {
                depth += 1
            } else if ch == ")" {
                depth -= 1
                if depth < 0 { return nil }
            } else if ch == ",", depth == 0 {
                if comma != -1 { return nil }
                comma = i
            }
        }
        if depth != 0 || comma == -1 { return nil }
        let light = String(inner[..<comma]).jsTrimmed
        let dark = String(inner[(comma + 1)...]).jsTrimmed
        if light.isEmpty || dark.isEmpty { return nil }
        guard parseCssColor(light) != nil, parseCssColor(dark) != nil else { return nil }
        return (light, dark)
    }
    if parseCssColor(trimmed) != nil { return (trimmed, trimmed) }
    return nil
}

/// `normalizeDualColor`: both sides as lowercase hex, or nil.
public func normalizeCssDualColor(_ input: JSONValue?) -> (light: String, dark: String)? {
    guard let parsed = parseCssDualColor(input), let light = normalizeCssColor(parsed.light), let dark = normalizeCssColor(parsed.dark) else { return nil }
    return (light, dark)
}
