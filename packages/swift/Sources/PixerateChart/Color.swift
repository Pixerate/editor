// Portions ported from gridcraft-main/crates/chart/src/resolve.rs (palette tint cycle) and
// crates/chart/src/render.rs (`on`: label colour from the fill), and designcraft-main/crates/color/src/cms/mod.rs
// (`simulate_cvd`, Machado–Oliveira–Fernandes 2009 matrices) (MIT OR Apache-2.0, © ArtCraft Team and contributors).
// See THIRD_PARTY_NOTICES.md.
import Foundation
import PixerateCore
import PixerateRaster

/// An sRGB colour with channels from 0 to 1.
public typealias ChartRgb = [Double]

private let NAMED: [String: String] = [
    "black": "#000000",
    "white": "#ffffff",
    "red": "#ff0000",
    "green": "#008000",
    "blue": "#0000ff",
    "yellow": "#ffff00",
    "orange": "#ffa500",
    "purple": "#800080",
    "gray": "#808080",
    "grey": "#808080",
    "teal": "#008080",
    "navy": "#000080",
    "maroon": "#800000",
    "olive": "#808000",
    "silver": "#c0c0c0",
    "lime": "#00ff00",
    "aqua": "#00ffff",
    "cyan": "#00ffff",
    "fuchsia": "#ff00ff",
    "magenta": "#ff00ff",
    "pink": "#ffc0cb",
    "brown": "#a52a2a"
]

/// Reads `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()` and a few colour names. Returns
/// `nil` for anything else (CSS variables, `hsl()`, …), so callers can leave such colours alone.
public func parseChartColor(_ color: String) -> ChartRgb? {
    let text = color.jsTrimmed.lowercased()
    let hex = NAMED[text] ?? text
    if let m = matchGroups(#"^#([0-9a-f]{3})$"#, in: hex) {
        let chars = Array(m[1]).map(String.init)
        return chars.map { c in Double(Int(c + c, radix: 16) ?? 0) / 255.0 }
    }
    if let m = matchGroups(#"^#([0-9a-f]{6})([0-9a-f]{2})?$"#, in: hex) {
        let h = Array(m[1]).map(String.init)
        return [0, 2, 4].map { i in
            Double(Int(h[i] + h[i + 1], radix: 16) ?? 0) / 255.0
        }
    }
    if let m = matchGroups(#"^rgba?\(\s*([0-9.]+)%?[\s,]+([0-9.]+)%?[\s,]+([0-9.]+)%?(?:[\s,/]+[0-9.]+%?)?\s*\)$"#, in: text) {
        let pct = text.contains("%")
        let denom = pct ? 100.0 : 255.0
        return [m[1], m[2], m[3]].map { v in
            let n = Double(v) ?? .nan
            return Swift.max(0.0, Swift.min(1.0, n / denom))
        }
    }
    return nil
}

public func chartRgbToHex(_ rgb: ChartRgb) -> String {
    let hexParts = rgb.prefix(3).map { c -> String in
        let clamped = Swift.max(0.0, Swift.min(1.0, c))
        let byte = Int(JS.round(clamped * 255.0))
        let s = String(byte, radix: 16, uppercase: false)
        return s.count < 2 ? "0" + s : s
    }
    return "#" + hexParts.joined()
}

/// A lighter (`amount` > 0, towards white) or darker (`amount` < 0, towards black) shade of
/// `color`. Colours it cannot read (CSS variables) come back unchanged.
public func shadeChartColor(_ color: String, _ amount: Double) -> String {
    guard let rgb = parseChartColor(color), amount != 0, !amount.isNaN else { return color }
    let t = Swift.max(-1.0, Swift.min(1.0, amount))
    return chartRgbToHex(rgb.map { c in t > 0 ? c + (1.0 - c) * t : c * (1.0 + t) })
}

/// Shades used once a palette is used up: the same hues, lighter then darker (GridCraft's cycle).
public let CHART_PALETTE_SHADES: [Double] = [0, 0.4, -0.25, 0.6, -0.5, 0.2]

/// The palette colour for the `index`-th item: the palette in order, then lighter and darker rounds of it.
public func cyclePaletteColor(_ palette: [String], _ index: Int) -> String {
    guard !palette.isEmpty else { return "#4269d0" }
    let base = palette[index % palette.count]
    let round = (index / palette.count) % CHART_PALETTE_SHADES.count
    return shadeChartColor(base, CHART_PALETTE_SHADES[round])
}

private func toLinear(_ c: Double) -> Double {
    c <= 0.04045 ? c / 12.92 : JS.pow((c + 0.055) / 1.055, 2.4)
}

private func srgbToLinearSigned(_ v: Double) -> Double {
    let sign: Double = v < 0 ? -1.0 : (v > 0 ? 1.0 : 0.0)
    let a = abs(v)
    return sign * (a <= 0.04045 ? a / 12.92 : JS.pow((a + 0.055) / 1.055, 2.4))
}

private func linearToSrgbSigned(_ v: Double) -> Double {
    let sign: Double = v < 0 ? -1.0 : (v > 0 ? 1.0 : 0.0)
    let a = abs(v)
    return sign * (a <= 0.0031308 ? 12.92 * a : 1.055 * JS.pow(a, 1.0 / 2.4) - 0.055)
}

/// WCAG relative luminance (0 black – 1 white).
public func chartLuminance(_ rgb: ChartRgb) -> Double {
    let r = toLinear(rgb[0])
    let g = toLinear(rgb[1])
    let b = toLinear(rgb[2])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// WCAG contrast ratio (1–21) between two colours, or `nil` when either cannot be read.
public func chartContrastRatio(_ a: String, _ b: String) -> Double? {
    guard let ra = parseChartColor(a), let rb = parseChartColor(b) else { return nil }
    let la = chartLuminance(ra)
    let lb = chartLuminance(rb)
    return (Swift.max(la, lb) + 0.05) / (Swift.min(la, lb) + 0.05)
}

/// Dark or white text, whichever reads better on `fill`; `fallback` when the fill cannot be
/// read (a CSS variable).
public func chartTextOn(
    _ fill: String,
    _ fallback: String,
    _ dark: String = "#0f172a",
    _ light: String = "#ffffff"
) -> String {
    guard parseChartColor(fill) != nil,
          let darkRatio = chartContrastRatio(fill, dark),
          let lightRatio = chartContrastRatio(fill, light) else {
        return fallback
    }
    return darkRatio >= lightRatio ? dark : light
}

/// OKLab (Ottosson) from sRGB.
public func chartRgbToOklab(_ rgb: ChartRgb) -> [Double] {
    let lr = srgbToLinearSigned(rgb[0])
    let lg = srgbToLinearSigned(rgb[1])
    let lb = srgbToLinearSigned(rgb[2])
    let l = JS.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
    let m = JS.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
    let s = JS.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
    return [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    ]
}

/// Perceptual distance between two colours (Euclidean in OKLab; ≈0.02 is just noticeable).
public func chartColorDistance(_ a: ChartRgb, _ b: ChartRgb) -> Double {
    let la = chartRgbToOklab(a)
    let lb = chartRgbToOklab(b)
    return JS.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2])
}

public enum ChartVision: String, CaseIterable, Sendable, Equatable {
    case normal
    case protanopia
    case deuteranopia
    case tritanopia
}

private let CVD_PROTAN: [[Double]] = [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998]
]
private let CVD_DEUTAN: [[Double]] = [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881]
]
private let CVD_TRITAN: [[Double]] = [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039]
]

private func clamp01(_ v: Double) -> Double {
    Swift.max(0.0, Swift.min(1.0, v))
}

/// How a colour looks with a colour-vision deficiency (Machado et al. 2009, full severity).
public func simulateChartVision(_ rgb: ChartRgb, _ vision: ChartVision) -> ChartRgb {
    if vision == .normal { return rgb }
    let lr = srgbToLinearSigned(rgb[0])
    let lg = srgbToLinearSigned(rgb[1])
    let lb = srgbToLinearSigned(rgb[2])
    let m: [[Double]]
    switch vision {
    case .normal: return rgb
    case .protanopia: m = CVD_PROTAN
    case .deuteranopia: m = CVD_DEUTAN
    case .tritanopia: m = CVD_TRITAN
    }
    let r = linearToSrgbSigned(clamp01(m[0][0] * lr + m[0][1] * lg + m[0][2] * lb))
    let g = linearToSrgbSigned(clamp01(m[1][0] * lr + m[1][1] * lg + m[1][2] * lb))
    let b = linearToSrgbSigned(clamp01(m[2][0] * lr + m[2][1] * lg + m[2][2] * lb))
    return [r, g, b]
}

public struct ChartColorPair: Sendable, Equatable {
    public var a: Int
    public var b: Int
    public var colors: (String, String)
    public var distance: Double

    public init(a: Int, b: Int, colors: (String, String), distance: Double) {
        self.a = a
        self.b = b
        self.colors = colors
        self.distance = distance
    }

    public static func == (lhs: ChartColorPair, rhs: ChartColorPair) -> Bool {
        lhs.a == rhs.a &&
            lhs.b == rhs.b &&
            lhs.colors.0 == rhs.colors.0 &&
            lhs.colors.1 == rhs.colors.1 &&
            lhs.distance == rhs.distance
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("a", .number(Double(a))),
            ("b", .number(Double(b))),
            ("colors", .array([.string(colors.0), .string(colors.1)])),
            ("distance", .number(distance))
        ]))
    }
}

public struct ChartColorCheck: Sendable, Equatable {
    public var ok: Bool
    public var closest: [(ChartVision, ChartColorPair)]
    public var contrast: [Double?]
    public var issues: [String]
    public var skipped: [String]

    public init(
        ok: Bool,
        closest: [(ChartVision, ChartColorPair)],
        contrast: [Double?],
        issues: [String],
        skipped: [String]
    ) {
        self.ok = ok
        self.closest = closest
        self.contrast = contrast
        self.issues = issues
        self.skipped = skipped
    }

    public static func == (lhs: ChartColorCheck, rhs: ChartColorCheck) -> Bool {
        guard lhs.ok == rhs.ok,
              lhs.contrast == rhs.contrast,
              lhs.issues == rhs.issues,
              lhs.skipped == rhs.skipped,
              lhs.closest.count == rhs.closest.count else {
            return false
        }
        for (l, r) in zip(lhs.closest, rhs.closest) {
            if l.0 != r.0 || l.1 != r.1 { return false }
        }
        return true
    }

    public func toJSON() -> JSONValue {
        var closestObj = JSONObject()
        for (vision, pair) in closest {
            closestObj[vision.rawValue] = pair.toJSON()
        }
        return .object(JSONObject([
            ("ok", .bool(ok)),
            ("closest", .object(closestObj)),
            ("contrast", .array(contrast.map { $0.map(JSONValue.number) ?? .null })),
            ("issues", .array(issues.map(JSONValue.string))),
            ("skipped", .array(skipped.map(JSONValue.string)))
        ]))
    }
}

public struct ChartColorCheckOptions: Sendable, Equatable {
    public var surface: String?
    public var minDistance: Double?
    public var minContrast: Double?
    public var visions: [ChartVision]?

    public init(
        surface: String? = nil,
        minDistance: Double? = nil,
        minContrast: Double? = nil,
        visions: [ChartVision]? = nil
    ) {
        self.surface = surface
        self.minDistance = minDistance
        self.minContrast = minContrast
        self.visions = visions
    }
}

/// Checks that series colours can be told apart, with normal vision and the three
/// colour-vision deficiencies, and stand out from the surface. Returns the closest pair per
/// vision and problems as sentences.
public func checkChartColors(
    _ colors: [String],
    _ options: ChartColorCheckOptions = ChartColorCheckOptions()
) -> ChartColorCheck {
    let surface = options.surface ?? "#ffffff"
    let minDistance = options.minDistance ?? 0.08
    let minContrast = options.minContrast ?? 1.5
    let visions = options.visions ?? [.normal, .protanopia, .deuteranopia, .tritanopia]
    let parsed = colors.map(parseChartColor)
    let skipped = colors.enumerated().compactMap { i, c in parsed[i] == nil ? c : nil }
    var issues: [String] = []
    var closest: [(ChartVision, ChartColorPair)] = []
    for vision in visions {
        let seen: [ChartRgb?] = parsed.map { c in c.map { simulateChartVision($0, vision) } }
        var best: ChartColorPair?
        for a in 0..<seen.count {
            if a + 1 < seen.count {
                for b in (a + 1)..<seen.count {
                    guard let sa = seen[a], let sb = seen[b] else { continue }
                    let distance = chartColorDistance(sa, sb)
                    if best == nil || distance < best!.distance {
                        best = ChartColorPair(
                            a: a,
                            b: b,
                            colors: (colors[a], colors[b]),
                            distance: JS.round(distance * 1000.0) / 1000.0
                        )
                    }
                }
            }
        }
        if let best {
            closest.append((vision, best))
            if best.distance < minDistance {
                let who = vision == .normal ? "" : " with \(vision.rawValue)"
                issues.append(
                    "Colours \(best.a + 1) (\(best.colors.0)) and \(best.b + 1) (\(best.colors.1)) are hard to tell apart\(who) (distance \(JSONValue.jsString(best.distance)), want at least \(JSONValue.jsString(minDistance)))."
                )
            }
        }
    }
    let contrast: [Double?] = colors.map { c in
        guard let ratio = chartContrastRatio(c, surface) else { return nil }
        return JS.round(ratio * 100.0) / 100.0
    }
    for (i, ratio) in contrast.enumerated() {
        if let ratio, ratio < minContrast {
            issues.append(
                "Colour \(i + 1) (\(colors[i])) barely stands out from the background \(surface) (contrast \(JSONValue.jsString(ratio)):1, want at least \(JSONValue.jsString(minContrast)):1)."
            )
        }
    }
    return ChartColorCheck(
        ok: issues.isEmpty,
        closest: closest,
        contrast: contrast,
        issues: issues,
        skipped: skipped
    )
}

public func checkChartColors(_ colors: [String], surface: String) -> ChartColorCheck {
    checkChartColors(colors, ChartColorCheckOptions(surface: surface))
}

private func matchGroups(_ pattern: String, in text: String) -> [String]? {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else { return nil }
    let nsRange = NSRange(text.startIndex..<text.endIndex, in: text)
    guard let match = regex.firstMatch(in: text, options: [], range: nsRange) else { return nil }
    var out: [String] = []
    for i in 0..<match.numberOfRanges {
        let r = match.range(at: i)
        if let swiftRange = Range(r, in: text) {
            out.append(String(text[swiftRange]))
        } else {
            out.append("")
        }
    }
    return out
}
