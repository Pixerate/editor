import Foundation
import PixerateCore
import PixerateRaster

// Preview colours for brushes (`brushes/preview.ts`): what a preview is drawn on and the colour
// that reads on it. Previews only: it never sets anyone's paint colour.

/// The paper behind brushes that give off light, so their glow reads.
public let BRUSH_PREVIEW_DARK_PAPER = "#141414"

/// The contrast a preview colour keeps against its background (WCAG large-text / graphics).
public let BRUSH_PREVIEW_MIN_CONTRAST = 3.0

/// Preview colours for brushes with no solid default, by medium (`tools` for tool brushes).
public let BRUSH_PREVIEW_FALLBACKS: [String: (light: String, dark: String)] = [
    "dry": ("#3f3f46", "#e4e4e7"),
    "ink": ("#1e293b", "#e2e8f0"),
    "paint": ("#1d4ed8", "#93c5fd"),
    "spray": ("#0f766e", "#5eead4"),
    "other": ("#334155", "#cbd5e1"),
    "tools": ("#475569", "#cbd5e1"),
]

/// `brushPreviewsOnDark`: a brush that gives off light previews on dark paper, unless it is a
/// multiply brush (a highlighter, a tint on paper).
public func brushPreviewsOnDark(_ brush: Brush) -> Bool {
    let amount = { (p: String) in brush.path(p)?.numberValue ?? 0 }
    return (amount("light.amount") > 0 || amount("fluorescence.amount") > 0 || amount("culture.glow") > 0) && brush.path("tip.blend")?.stringValue != "multiply"
}

/// `brushPreviewStrength`: how much of its colour a brush lays in one pass, roughly.
public func brushPreviewStrength(_ brush: Brush) -> Double {
    let opacity = brush.path("tip.opacity")?.numberValue ?? 1
    let flow = brush.path("tip.flow")?.numberValue ?? 1
    let grain = brush.path("behaviour.grain")?.numberValue ?? 0
    return JS.max(0.25, JS.min(1, 0.85 * opacity * (0.6 + 0.4 * flow) * (1 - 0.3 * grain)))
}

/// `BrushPreviewColours`: the background (#rrggbb), the stroke colour that reads on it and the background's scheme.
public struct BrushPreviewColours: Equatable, Sendable {
    public var background: String
    public var color: String
    /// `light` or `dark`: which side of a light / dark colour was used.
    public var scheme: String
}

/// `isDualColor`: an object with string `light` and `dark`.
private func isDualColour(_ v: JSONValue) -> Bool {
    guard let o = v.objectValue else { return false }
    return o["light"]?.stringValue != nil && o["dark"]?.stringValue != nil
}

/// `brushPreviewColours` (`brushes/preview.ts`): the background and stroke colour for a preview of
/// `brush` on `paper` (#rrggbb, default white) for `profile`. The brush's default colour resolved
/// for the background, else a colour for its medium, shifted in lightness until it reads at
/// `BRUSH_PREVIEW_MIN_CONTRAST`; a highlighter's own colour is kept.
public func brushPreviewColours(_ brush: Brush, paper: String? = nil, profile: BrushHostProfile = PAINT_PROFILE, keepPaper: Bool = false) -> BrushPreviewColours {
    let multiply = brush.path("tip.blend")?.stringValue == "multiply"
    var background = profile.light == "full" && brushPreviewsOnDark(brush) ? BRUSH_PREVIEW_DARK_PAPER : (brushColourHex(.string(paper ?? "#ffffff"), "light") ?? "#ffffff")
    if !keepPaper && multiply && cssRelativeLuminance(parseCssColor(background)!) < 0.18 { background = "#ffffff" }
    let bg = parseCssColor(background)!
    let scheme = cssRelativeLuminance(bg) < 0.18 ? "dark" : "light"
    let own = brush["kind"]?.stringValue == "mark" ? brush.path("colour.default") : nil
    let ownHex = own.flatMap { $0.stringValue != nil || isDualColour($0) ? brushColourHex($0, scheme) : nil }
    if let ownHex, multiply, (brush.path("light.amount")?.numberValue ?? 0) > 0, scheme == "light" {
        return BrushPreviewColours(background: background, color: ownHex, scheme: scheme)
    }
    let group = brush["kind"]?.stringValue == "tool" ? "tools" : (brush["medium"]?.stringValue ?? "other")
    let fallback = BRUSH_PREVIEW_FALLBACKS[group] ?? BRUSH_PREVIEW_FALLBACKS["other"]!
    let color = ownHex ?? (scheme == "dark" ? fallback.dark : fallback.light)
    // Judged as laid down: the colour at the brush's strength over the background.
    let alpha = brushPreviewStrength(brush)
    func reads(_ c: CssRgba) -> Bool {
        let laid = CssRgba(r: c.r * alpha + bg.r * (1 - alpha), g: c.g * alpha + bg.g * (1 - alpha), b: c.b * alpha + bg.b * (1 - alpha), a: 1)
        return cssContrastRatio(laid, bg) >= BRUSH_PREVIEW_MIN_CONTRAST
    }
    let fg = parseCssColor(color)!
    if reads(fg) { return BrushPreviewColours(background: background, color: color, scheme: scheme) }
    // Shift the lightness away from the background (keeping hue and chroma) until it reads.
    let lch = cssOklabToOklch(cssRgbToOklab(fg))
    let step = scheme == "dark" ? 0.01 : -0.01
    var l = lch.l + step
    while l >= 0 && l <= 1 {
        let hex = cssFormatHex(cssToSrgbGamut(cssOklchToRgb(l, lch.c, lch.h, fg.a)))
        if reads(parseCssColor(hex)!) { return BrushPreviewColours(background: background, color: hex, scheme: scheme) }
        l += step
    }
    return BrushPreviewColours(background: background, color: scheme == "dark" ? "#ffffff" : "#000000", scheme: scheme)
}
