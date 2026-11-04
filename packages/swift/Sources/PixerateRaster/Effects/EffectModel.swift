// Portions ported from photocraft-main/crates/doc/src/effects.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import Foundation
import PixerateCore

/**
 * Layer effects (Photoshop's layer styles) as data: drop and inner shadows, outer and inner
 * glows, bevel & emboss, satin, colour / gradient / pattern overlays and strokes. Rendering lives
 * in `EffectRender.swift`. The port of `raster/effects/model.ts`.
 *
 * Angles are in degrees, counter-clockwise from 3 o'clock, and give the direction the light
 * comes *from* (Photoshop's convention). Sizes and distances are in pixels, opacities and
 * percentages in 0..1, colours are `#rrggbb`.
 *
 * Effects are typed values here; `json` / `init(json:)` convert them to and from the TS objects
 * (the shape agents, documents and PSD mapping use), and validation works on that JSON with the
 * TS messages.
 */

/// A point or offset (`{ x, y }`).
public struct EffectPoint: Equatable, Hashable, Sendable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/// One point of a contour curve (input → output, both 0..1).
public struct ContourPoint: Equatable, Hashable, Sendable {
    public var input: Double
    public var output: Double
    /// The curve bends sharply here instead of passing smoothly through (Photoshop's corner point).
    public var corner: Bool?
    public init(input: Double, output: Double, corner: Bool? = nil) {
        self.input = input
        self.output = output
        self.corner = corner
    }
}

/// A transfer curve applied to an effect's coverage. Missing on an effect = linear.
public struct EffectContour: Equatable, Hashable, Sendable {
    public var name: String
    public var points: [ContourPoint]
    public init(name: String, points: [ContourPoint]) {
        self.name = name
        self.points = points
    }
}

public enum GradientStyle: String, Sendable, CaseIterable {
    case linear, radial, angle, reflected, diamond
}

public struct GradientColorStop: Equatable, Hashable, Sendable {
    /// 0..1 along the gradient.
    public var position: Double
    public var color: String
    public init(position: Double, color: String) {
        self.position = position
        self.color = color
    }
}

public struct GradientOpacityStop: Equatable, Hashable, Sendable {
    public var position: Double
    /// 0..1
    public var opacity: Double
    public init(position: Double, opacity: Double) {
        self.position = position
        self.opacity = opacity
    }
}

/// A gradient as overlays, gradient strokes and gradient glows paint it.
public struct EffectGradient: Equatable, Hashable, Sendable {
    public var stops: [GradientColorStop]
    /// Missing or empty: opaque.
    public var opacityStops: [GradientOpacityStop]?
    public var style: GradientStyle
    /// Degrees (90 = bottom to top).
    public var angle: Double
    /// 1 = 100 %.
    public var scale: Double
    public var reverse: Bool
    /// Align with the layer's bounds (else the canvas).
    public var align: Bool
    /// Centre offset as a fraction of the bounds.
    public var offset: EffectPoint
    public init(stops: [GradientColorStop], opacityStops: [GradientOpacityStop]? = nil, style: GradientStyle, angle: Double, scale: Double, reverse: Bool, align: Bool, offset: EffectPoint) {
        self.stops = stops
        self.opacityStops = opacityStops
        self.style = style
        self.angle = angle
        self.scale = scale
        self.reverse = reverse
        self.align = align
        self.offset = offset
    }
}

/// A pattern reference: the id of a document or built-in pattern (see `builtinPatternIds`).
public struct EffectPatternRef: Equatable, Hashable, Sendable {
    public var patternId: String
    /// Display name (PSD keeps it beside the id).
    public var name: String?
    /// 1 = 100 %.
    public var scale: Double
    /// Rotation in degrees (counter-clockwise).
    public var angle: Double?
    /// Tile from the layer's top-left ("Link with Layer", default) instead of the canvas origin.
    public var link: Bool?
    /// Origin offset in pixels.
    public var phase: EffectPoint?
    public init(patternId: String, name: String? = nil, scale: Double, angle: Double? = nil, link: Bool? = nil, phase: EffectPoint? = nil) {
        self.patternId = patternId
        self.name = name
        self.scale = scale
        self.angle = angle
        self.link = link
        self.phase = phase
    }
}

/// What a stroke or glow paints with.
public enum EffectFill: Equatable, Hashable, Sendable {
    case color(String)
    case gradient(EffectGradient)
    case pattern(EffectPatternRef)

    public var type: String {
        switch self {
        case .color: return "color"
        case .gradient: return "gradient"
        case .pattern: return "pattern"
        }
    }
}

public struct DropShadowEffect: Equatable, Hashable, Sendable {
    public var id: String
    public var enabled: Bool
    public var blend: BlendMode
    public var opacity: Double
    public var color: String
    public var angle: Double
    public var useGlobalLight: Bool
    public var distance: Double
    /// 0..1 of the size grown solid before the blur.
    public var spread: Double
    public var size: Double
    public var contour: EffectContour?
    public var antiAlias: Bool
    public var noise: Double
    /// The layer hides the shadow beneath its see-through fill ("Layer Knocks Out Drop Shadow").
    public var knocksOut: Bool
}

public struct InnerShadowEffect: Equatable, Hashable, Sendable {
    public var id: String
    public var enabled: Bool
    public var blend: BlendMode
    public var opacity: Double
    public var color: String
    public var angle: Double
    public var useGlobalLight: Bool
    public var distance: Double
    /// 0..1 of the size shrunk solid before the blur.
    public var choke: Double
    public var size: Double
    public var contour: EffectContour?
    public var antiAlias: Bool
    public var noise: Double
}

public enum GlowTechnique: String, Sendable {
    case softer, precise
}

public struct OuterGlowEffect: Equatable, Hashable, Sendable {
    public var id: String
    public var enabled: Bool
    public var blend: BlendMode
    public var opacity: Double
    /// Colour or gradient.
    public var fill: EffectFill
    public var technique: GlowTechnique
    public var spread: Double
    public var size: Double
    public var contour: EffectContour?
    public var antiAlias: Bool
    /// 0..1 (default 0.5): the part of the glow the contour spans.
    public var range: Double
    /// 0..1, varies a gradient glow's colours. Stored only (not rendered).
    public var jitter: Double
    public var noise: Double
}

public struct InnerGlowEffect: Equatable, Hashable, Sendable {
    public var id: String
    public var enabled: Bool
    public var blend: BlendMode
    public var opacity: Double
    public var fill: EffectFill
    public var technique: GlowTechnique
    public var choke: Double
    public var size: Double
    public var contour: EffectContour?
    public var antiAlias: Bool
    public var range: Double
    public var jitter: Double
    public var noise: Double
    /// Glow from the edge inwards (default) or from the centre outwards: `edge` or `center`.
    public var source: String
}

public enum BevelStyle: String, Sendable {
    case innerBevel = "inner-bevel"
    case outerBevel = "outer-bevel"
    case emboss
    case pillowEmboss = "pillow-emboss"
    case strokeEmboss = "stroke-emboss"
}

public enum BevelTechnique: String, Sendable {
    case smooth
    case chiselHard = "chisel-hard"
    case chiselSoft = "chisel-soft"
}

/// The Contour element of Bevel & Emboss: shapes the bevel's height profile.
public struct BevelContour: Equatable, Hashable, Sendable {
    public var contour: EffectContour
    /// 0..1 (default 0.5). Stored only.
    public var range: Double
    public var antiAlias: Bool
}

/// The Texture element of Bevel & Emboss: a pattern's luminance added to the height.
public struct BevelTexture: Equatable, Hashable, Sendable {
    public var pattern: EffectPatternRef
    /// -10..10 (1 = +100 %); negative carves the pattern in.
    public var depth: Double
    public var invert: Bool
}

public struct BevelEmbossEffect: Equatable, Hashable, Sendable {
    public var id: String
    public var enabled: Bool
    public var style: BevelStyle
    public var technique: BevelTechnique
    /// 0..10 (1 = 100 %).
    public var depth: Double
    /// `up` or `down`.
    public var direction: String
    public var size: Double
    public var soften: Double
    public var angle: Double
    /// Light altitude in degrees (0..90).
    public var altitude: Double
    public var useGlobalLight: Bool
    public var glossContour: EffectContour?
    public var highlightColor: String
    public var highlightBlend: BlendMode
    public var highlightOpacity: Double
    public var shadowColor: String
    public var shadowBlend: BlendMode
    public var shadowOpacity: Double
    /// Contour element (shapes the bevel's height profile), or missing when off.
    public var contourElement: BevelContour?
    /// Texture element, or missing when off.
    public var texture: BevelTexture?
}

public struct SatinEffect: Equatable, Hashable, Sendable {
    public var id: String
    public var enabled: Bool
    public var blend: BlendMode
    public var opacity: Double
    public var color: String
    public var angle: Double
    public var distance: Double
    public var size: Double
    public var contour: EffectContour?
    public var antiAlias: Bool
    public var invert: Bool
}

public struct ColorOverlayEffect: Equatable, Hashable, Sendable {
    public var id: String
    public var enabled: Bool
    public var blend: BlendMode
    public var opacity: Double
    public var color: String
}

public struct GradientOverlayEffect: Equatable, Hashable, Sendable {
    public var id: String
    public var enabled: Bool
    public var blend: BlendMode
    public var opacity: Double
    public var gradient: EffectGradient
    public var dither: Bool
}

public struct PatternOverlayEffect: Equatable, Hashable, Sendable {
    public var id: String
    public var enabled: Bool
    public var blend: BlendMode
    public var opacity: Double
    public var pattern: EffectPatternRef
}

public enum StrokePosition: String, Sendable {
    case outside, inside, center
}

public struct StrokeEffect: Equatable, Hashable, Sendable {
    public var id: String
    public var enabled: Bool
    public var blend: BlendMode
    public var opacity: Double
    public var size: Double
    public var position: StrokePosition
    public var fill: EffectFill
}

public enum LayerEffectKind: String, Sendable, CaseIterable {
    case dropShadow = "drop-shadow"
    case innerShadow = "inner-shadow"
    case outerGlow = "outer-glow"
    case innerGlow = "inner-glow"
    case bevelEmboss = "bevel-emboss"
    case satin
    case colorOverlay = "color-overlay"
    case gradientOverlay = "gradient-overlay"
    case patternOverlay = "pattern-overlay"
    case stroke
}

/// One layer effect. Several of the same kind are allowed; the first listed of a kind is on top.
public enum LayerEffect: Equatable, Hashable, Sendable {
    case dropShadow(DropShadowEffect)
    case innerShadow(InnerShadowEffect)
    case outerGlow(OuterGlowEffect)
    case innerGlow(InnerGlowEffect)
    case bevelEmboss(BevelEmbossEffect)
    case satin(SatinEffect)
    case colorOverlay(ColorOverlayEffect)
    case gradientOverlay(GradientOverlayEffect)
    case patternOverlay(PatternOverlayEffect)
    case stroke(StrokeEffect)

    public var kind: LayerEffectKind {
        switch self {
        case .dropShadow: return .dropShadow
        case .innerShadow: return .innerShadow
        case .outerGlow: return .outerGlow
        case .innerGlow: return .innerGlow
        case .bevelEmboss: return .bevelEmboss
        case .satin: return .satin
        case .colorOverlay: return .colorOverlay
        case .gradientOverlay: return .gradientOverlay
        case .patternOverlay: return .patternOverlay
        case .stroke: return .stroke
        }
    }

    public var id: String {
        switch self {
        case .dropShadow(let e): return e.id
        case .innerShadow(let e): return e.id
        case .outerGlow(let e): return e.id
        case .innerGlow(let e): return e.id
        case .bevelEmboss(let e): return e.id
        case .satin(let e): return e.id
        case .colorOverlay(let e): return e.id
        case .gradientOverlay(let e): return e.id
        case .patternOverlay(let e): return e.id
        case .stroke(let e): return e.id
        }
    }

    public var enabled: Bool {
        switch self {
        case .dropShadow(let e): return e.enabled
        case .innerShadow(let e): return e.enabled
        case .outerGlow(let e): return e.enabled
        case .innerGlow(let e): return e.enabled
        case .bevelEmboss(let e): return e.enabled
        case .satin(let e): return e.enabled
        case .colorOverlay(let e): return e.enabled
        case .gradientOverlay(let e): return e.enabled
        case .patternOverlay(let e): return e.enabled
        case .stroke(let e): return e.enabled
        }
    }

    /// Blend mode and opacity (every kind but bevel & emboss), else `nil`.
    public var blended: (blend: BlendMode, opacity: Double)? {
        switch self {
        case .dropShadow(let e): return (e.blend, e.opacity)
        case .innerShadow(let e): return (e.blend, e.opacity)
        case .outerGlow(let e): return (e.blend, e.opacity)
        case .innerGlow(let e): return (e.blend, e.opacity)
        case .bevelEmboss: return nil
        case .satin(let e): return (e.blend, e.opacity)
        case .colorOverlay(let e): return (e.blend, e.opacity)
        case .gradientOverlay(let e): return (e.blend, e.opacity)
        case .patternOverlay(let e): return (e.blend, e.opacity)
        case .stroke(let e): return (e.blend, e.opacity)
        }
    }
}

/// A layer's effects: the master switch, Layer Style › Scale Effects and the effect list.
public struct LayerEffects: Equatable, Hashable, Sendable {
    /// The master switch ("effects on"); `false` keeps the effects but renders none.
    public var enabled: Bool
    /// Scale Effects: multiplies every size, distance and pattern scale (1 = 100 %; missing = 1).
    public var scale: Double?
    public var items: [LayerEffect]
    /**
     * The PSD block the effects were read from (`lfx2`, `lfxs` or `lmfx`), kept so export writes it
     * back verbatim while the effects still map to the same values.
     */
    public var psd: EffectsPsdBlock?
    public init(enabled: Bool, scale: Double? = nil, items: [LayerEffect], psd: EffectsPsdBlock? = nil) {
        self.enabled = enabled
        self.scale = scale
        self.items = items
        self.psd = psd
    }
}

public struct EffectsPsdBlock: Equatable, Hashable, Sendable {
    public var key: String
    public var data: [UInt8]
    public init(key: String, data: [UInt8]) {
        self.key = key
        self.data = data
    }
}

/// The document-wide light that effects with `useGlobalLight` use.
public struct GlobalLight: Equatable, Hashable, Sendable {
    /// Degrees.
    public var angle: Double
    /// Degrees.
    public var altitude: Double
    public init(angle: Double, altitude: Double) {
        self.angle = angle
        self.altitude = altitude
    }
}

public let DEFAULT_GLOBAL_LIGHT = GlobalLight(angle: 120, altitude: 30)

/// Every effect kind, in the order the Layer Style dialog lists them.
public let LAYER_EFFECT_KINDS: [LayerEffectKind] = [.bevelEmboss, .stroke, .innerShadow, .innerGlow, .satin, .colorOverlay, .gradientOverlay, .patternOverlay, .outerGlow, .dropShadow]

private let LABELS: [LayerEffectKind: String] = [
    .dropShadow: "Drop Shadow",
    .innerShadow: "Inner Shadow",
    .outerGlow: "Outer Glow",
    .innerGlow: "Inner Glow",
    .bevelEmboss: "Bevel & Emboss",
    .satin: "Satin",
    .colorOverlay: "Color Overlay",
    .gradientOverlay: "Gradient Overlay",
    .patternOverlay: "Pattern Overlay",
    .stroke: "Stroke",
]

public func layerEffectLabel(_ kind: LayerEffectKind) -> String { LABELS[kind]! }

public func isLayerEffectKind(_ value: String?) -> Bool {
    value.flatMap { LayerEffectKind(rawValue: $0) } != nil
}

/// Photoshop's default black-to-white linear gradient.
public func defaultEffectGradient() -> EffectGradient {
    EffectGradient(
        stops: [GradientColorStop(position: 0, color: "#000000"), GradientColorStop(position: 1, color: "#ffffff")],
        style: .linear, angle: 90, scale: 1, reverse: false, align: true, offset: EffectPoint(x: 0, y: 0)
    )
}

private let fxCounter = Locked(0)

/// A fresh effect id.
public func newEffectId() -> String {
    let ms = Int64((Date().timeIntervalSince1970 * 1000).rounded(.down))
    let n = fxCounter.with { c -> Int in
        c += 1
        return c
    }
    return "fx_\(String(ms, radix: 36))_\(String(n, radix: 36))"
}

/// An effect of `kind` with Photoshop's default settings.
public func defaultLayerEffect(_ kind: LayerEffectKind, _ id: String = newEffectId()) -> LayerEffect {
    switch kind {
    case .dropShadow:
        return .dropShadow(DropShadowEffect(id: id, enabled: true, blend: .multiply, opacity: 0.75, color: "#000000", angle: 120, useGlobalLight: true, distance: 5, spread: 0, size: 5, contour: nil, antiAlias: false, noise: 0, knocksOut: true))
    case .innerShadow:
        return .innerShadow(InnerShadowEffect(id: id, enabled: true, blend: .multiply, opacity: 0.75, color: "#000000", angle: 120, useGlobalLight: true, distance: 5, choke: 0, size: 5, contour: nil, antiAlias: false, noise: 0))
    case .outerGlow:
        return .outerGlow(OuterGlowEffect(id: id, enabled: true, blend: .screen, opacity: 0.75, fill: .color("#ffffbe"), technique: .softer, spread: 0, size: 5, contour: nil, antiAlias: false, range: 0.5, jitter: 0, noise: 0))
    case .innerGlow:
        return .innerGlow(InnerGlowEffect(id: id, enabled: true, blend: .screen, opacity: 0.75, fill: .color("#ffffbe"), technique: .softer, choke: 0, size: 5, contour: nil, antiAlias: false, range: 0.5, jitter: 0, noise: 0, source: "edge"))
    case .bevelEmboss:
        return .bevelEmboss(BevelEmbossEffect(id: id, enabled: true, style: .innerBevel, technique: .smooth, depth: 1, direction: "up", size: 5, soften: 0, angle: 120, altitude: 30, useGlobalLight: true, glossContour: nil, highlightColor: "#ffffff", highlightBlend: .screen, highlightOpacity: 0.75, shadowColor: "#000000", shadowBlend: .multiply, shadowOpacity: 0.75, contourElement: nil, texture: nil))
    case .satin:
        return .satin(SatinEffect(id: id, enabled: true, blend: .multiply, opacity: 0.5, color: "#000000", angle: 19, distance: 11, size: 14, contour: nil, antiAlias: true, invert: true))
    case .colorOverlay:
        return .colorOverlay(ColorOverlayEffect(id: id, enabled: true, blend: .normal, opacity: 1, color: "#ff0000"))
    case .gradientOverlay:
        return .gradientOverlay(GradientOverlayEffect(id: id, enabled: true, blend: .normal, opacity: 1, gradient: defaultEffectGradient(), dither: false))
    case .patternOverlay:
        return .patternOverlay(PatternOverlayEffect(id: id, enabled: true, blend: .normal, opacity: 1, pattern: EffectPatternRef(patternId: "checker", name: "Checker", scale: 1, angle: 0, link: true, phase: EffectPoint(x: 0, y: 0))))
    case .stroke:
        return .stroke(StrokeEffect(id: id, enabled: true, blend: .normal, opacity: 1, size: 3, position: .outside, fill: .color("#000000")))
    }
}

/// True when the master switch is on and at least one effect is enabled.
public func hasActiveEffects(_ effects: LayerEffects?) -> Bool {
    guard let effects else { return false }
    return effects.enabled && effects.items.contains { $0.enabled }
}

/// Maximum distance (px) an effect is rendered from the layer's shape.
public let MAX_EFFECT_REACH = 512.0

/// How far (px, before Scale Effects) one effect paints beyond or into the layer's shape.
public func effectReach(_ e: LayerEffect) -> Double {
    switch e {
    case .dropShadow(let s): return s.distance + s.size
    case .innerShadow(let s): return s.distance + s.size
    case .outerGlow(let g): return g.size + 1
    case .innerGlow(let g): return g.size + 1
    case .stroke(let s): return s.size
    case .satin(let s): return JS.max(1, s.distance) + s.size
    case .bevelEmboss(let b):
        if b.technique == .smooth { return b.size + b.soften + 1 }
        // Chiselled heights read the nearest edge up to size + 2 px away and its normal one px past
        // that; chisel-soft and soften then blur them (tents of radius up to width + 1) and the
        // lighting reads one px around. The margin patches effect maps, so it must cover all of it.
        let size = JS.max(b.size, 1)
        let chiselSoft = b.technique == .chiselSoft ? JS.max(size / 4, 1) + 1 : 0
        return size + 3 + chiselSoft + b.soften + 1 + 1
    default: return 0
    }
}

/**
 * Pixels an effect stack can reach beyond the layer's shape (its enabled effects, scaled), plus
 * a little slack. 0 when no effect is active. Dirty areas and tile signatures grow by this.
 */
public func effectsMargin(_ effects: LayerEffects?) -> Int {
    guard let effects, hasActiveEffects(effects) else { return 0 }
    let scale = effectsScale(effects)
    var m = 0.0
    for e in effects.items where e.enabled {
        let r = effectReach(e) * scale
        if r.isFinite { m = JS.max(m, r) }
    }
    return Int(JS.ceil(JS.min(JS.max(m, 0), MAX_EFFECT_REACH))) + 2
}

/// Scale Effects as a usable factor (missing or invalid = 1).
public func effectsScale(_ effects: LayerEffects) -> Double {
    if let s = effects.scale, s.isFinite, s > 0 { return s }
    return 1
}

/// `effect` with its sizes, distances and pattern scales multiplied by `s` (Scale Effects).
public func scaleLayerEffect(_ e: LayerEffect, _ s: Double) -> LayerEffect {
    if s == 1 { return e }
    func pattern(_ p: EffectPatternRef) -> EffectPatternRef {
        var p = p
        p.scale = p.scale * s
        return p
    }
    func fill(_ f: EffectFill) -> EffectFill {
        if case .pattern(let p) = f { return .pattern(pattern(p)) }
        return f
    }
    switch e {
    case .dropShadow(var x):
        x.distance *= s
        x.size *= s
        return .dropShadow(x)
    case .innerShadow(var x):
        x.distance *= s
        x.size *= s
        return .innerShadow(x)
    case .satin(var x):
        x.distance *= s
        x.size *= s
        return .satin(x)
    case .outerGlow(var x):
        x.size *= s
        return .outerGlow(x)
    case .innerGlow(var x):
        x.size *= s
        return .innerGlow(x)
    case .stroke(var x):
        x.size *= s
        x.fill = fill(x.fill)
        return .stroke(x)
    case .patternOverlay(var x):
        x.pattern = pattern(x.pattern)
        return .patternOverlay(x)
    case .bevelEmboss(var x):
        x.size *= s
        x.soften *= s
        if var t = x.texture {
            t.pattern = pattern(t.pattern)
            x.texture = t
        }
        return .bevelEmboss(x)
    default:
        return e
    }
}

/// `#rrggbb` (or `#rgb`, `rrggbb`) as 0..1 RGB, or `nil`.
public func parseEffectColor(_ value: String?) -> [Double]? {
    guard var h = value?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
    if h.hasPrefix("#") { h.removeFirst() }
    let isHex = { (s: String) in s.unicodeScalars.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) || ("A"..."F").contains($0) } }
    if h.unicodeScalars.count == 3 && isHex(h) { h = h.map { "\($0)\($0)" }.joined() }
    guard h.unicodeScalars.count == 6, isHex(h) else { return nil }
    let chars = Array(h)
    return (0..<3).map { Double(Int(String(chars[$0 * 2...$0 * 2 + 1]), radix: 16)!) / 255 }
}

/// 0..1 RGB as `#rrggbb`.
public func effectColorHex(_ rgb: [Double]) -> String {
    let c = { (v: Double) -> String in
        let s = String(Int(JS.round(JS.max(0, JS.min(1, v)) * 255)), radix: 16)
        return s.count < 2 ? "0" + s : s
    }
    return "#\(c(rgb[0]))\(c(rgb[1]))\(c(rgb[2]))"
}

// MARK: - Validation (agents, JSON and PSD all go through here)

public struct LayerEffectError: Error, CustomStringConvertible, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

private func fail(_ path: String, _ msg: String) -> LayerEffectError { LayerEffectError("\(path): \(msg)") }

/// `JSON.stringify` of a value that may be missing (`undefined` prints as such in a template).
private func jsonText(_ v: JSONValue?) -> String { v.map { $0.stringified() } ?? "undefined" }

private func num(_ r: JSONObject, _ key: String, _ path: String, _ min: Double, _ max: Double) throws {
    guard case .number(let v)? = r[key], v.isFinite else {
        throw fail("\(path).\(key)", "must be a number from \(formatNumber(min)) to \(formatNumber(max)).")
    }
    if v < min || v > max { throw fail("\(path).\(key)", "\(formatNumber(v)) is out of range (\(formatNumber(min)) to \(formatNumber(max))).") }
}

private func bool(_ r: JSONObject, _ key: String, _ path: String) throws {
    guard case .bool? = r[key] else { throw fail("\(path).\(key)", "must be true or false.") }
}

private func color(_ r: JSONObject, _ key: String, _ path: String) throws {
    if parseEffectColor(r[key]?.stringValue) == nil { throw fail("\(path).\(key)", "must be a colour like \"#ff8800\" (got \(jsonText(r[key]))).") }
}

private func oneOf(_ r: JSONObject, _ key: String, _ path: String, _ values: [String]) throws {
    guard let s = r[key]?.stringValue, values.contains(s) else { throw fail("\(path).\(key)", "must be one of \(values.joined(separator: ", ")).") }
}

private func blend(_ r: JSONObject, _ key: String, _ path: String) throws {
    if !isBlendMode(r[key]?.stringValue) { throw fail("\(path).\(key)", "must be a blend mode such as normal, multiply or screen (got \(jsonText(r[key]))).") }
    // Pigment mixing is not a B(Cb, Cs) mode, and effects paint through one.
    if r[key]?.stringValue == "pigment" { throw fail("\(path).\(key)", "pigment is a layer blend mode only; effects cannot use it.") }
}

private func objectOf(_ v: JSONValue?) -> JSONObject? {
    if case .object(let o)? = v { return o }
    return nil
}

/// JavaScript truthiness of a JSON value.
private func truthy(_ v: JSONValue?) -> Bool {
    switch v {
    case nil, .null?: return false
    case .bool(let b)?: return b
    case .number(let n)?: return n != 0 && !n.isNaN
    case .string(let s)?: return !s.isEmpty
    default: return true
    }
}

private func contour(_ v: JSONValue?, _ path: String) throws {
    guard let v else { return }
    guard truthy(v), let c = objectOf(v) ?? (v.arrayValue != nil ? JSONObject() : nil) else { throw fail(path, "must be an object { name, points }.") }
    if c["name"]?.stringValue == nil { throw fail("\(path).name", "must be a string.") }
    guard let points = c["points"]?.arrayValue, points.count >= 2 else { throw fail("\(path).points", "needs at least 2 points { input, output } from 0 to 1.") }
    for (i, p) in points.enumerated() {
        guard truthy(p), let o = objectOf(p) ?? (p.arrayValue != nil ? JSONObject() : nil) else { throw fail("\(path).points[\(i)]", "must be { input, output }.") }
        try num(o, "input", "\(path).points[\(i)]", 0, 1)
        try num(o, "output", "\(path).points[\(i)]", 0, 1)
        if o["corner"] != nil { try bool(o, "corner", "\(path).points[\(i)]") }
    }
}

/// The record a stop or offset is read as (`s as Rec`: non-objects have no fields).
private func rec(_ v: JSONValue?) -> JSONObject { objectOf(v) ?? JSONObject() }

public func validateEffectGradient(_ v: JSONValue?, _ path: String) throws {
    guard truthy(v), let g = objectOf(v) ?? (v?.arrayValue != nil ? JSONObject() : nil) else { throw fail(path, "must be a gradient object.") }
    guard let stops = g["stops"]?.arrayValue, stops.count >= 1 else { throw fail("\(path).stops", "needs at least one stop { position, color }.") }
    for (i, s) in stops.enumerated() {
        try num(rec(s), "position", "\(path).stops[\(i)]", 0, 1)
        try color(rec(s), "color", "\(path).stops[\(i)]")
    }
    if let os = g["opacityStops"] {
        guard let list = os.arrayValue else { throw fail("\(path).opacityStops", "must be a list of { position, opacity }.") }
        for (i, s) in list.enumerated() {
            try num(rec(s), "position", "\(path).opacityStops[\(i)]", 0, 1)
            try num(rec(s), "opacity", "\(path).opacityStops[\(i)]", 0, 1)
        }
    }
    try oneOf(g, "style", path, ["linear", "radial", "angle", "reflected", "diamond"])
    try num(g, "angle", path, -360, 360)
    try num(g, "scale", path, 0.1, 1.5)
    try bool(g, "reverse", path)
    try bool(g, "align", path)
    guard truthy(g["offset"]), let o = objectOf(g["offset"]) ?? (g["offset"]?.arrayValue != nil ? JSONObject() : nil) else {
        throw fail("\(path).offset", "must be { x, y } (fractions of the bounds).")
    }
    try num(o, "x", "\(path).offset", -1, 1)
    try num(o, "y", "\(path).offset", -1, 1)
}

private func patternRef(_ r: JSONObject, _ path: String) throws {
    guard let id = r["patternId"]?.stringValue, !id.isEmpty else {
        throw fail("\(path).patternId", "must be a pattern id (a built-in pattern such as \"checker\", or one from list_layer_effects.patterns).")
    }
    try num(r, "scale", path, 0.01, 10)
    if r["angle"] != nil { try num(r, "angle", path, -360, 360) }
    if r["link"] != nil { try bool(r, "link", path) }
    if let phase = r["phase"] {
        guard truthy(phase), let p = objectOf(phase) ?? (phase.arrayValue != nil ? JSONObject() : nil) else { throw fail("\(path).phase", "must be { x, y } in pixels.") }
        try num(p, "x", "\(path).phase", -1e6, 1e6)
        try num(p, "y", "\(path).phase", -1e6, 1e6)
    }
}

private func fillCheck(_ v: JSONValue?, _ path: String, _ allowPattern: Bool) throws {
    guard truthy(v), let f = objectOf(v) ?? (v?.arrayValue != nil ? JSONObject() : nil) else {
        throw fail(path, "must be { type: \"color\", color } or { type: \"gradient\", gradient }" + (allowPattern ? " or { type: \"pattern\", patternId, scale }." : "."))
    }
    let type = f["type"]?.stringValue
    if type == "color" { try color(f, "color", path) }
    else if type == "gradient" { try validateEffectGradient(f["gradient"], "\(path).gradient") }
    else if type == "pattern" && allowPattern { try patternRef(f, path) }
    else { throw fail("\(path).type", allowPattern ? "must be color, gradient or pattern." : "must be color or gradient (glows cannot use a pattern).") }
}

private let OPTIONAL_FIELDS: [LayerEffectKind: [String]] = [
    .dropShadow: ["contour"],
    .innerShadow: ["contour"],
    .outerGlow: ["contour"],
    .innerGlow: ["contour"],
    .satin: ["contour"],
    .bevelEmboss: ["glossContour", "contourElement", "texture"],
]

/// Every field an effect of `kind` has (required and optional), including `id` and `kind`.
public func layerEffectFields(_ kind: LayerEffectKind) -> [String] {
    (defaultLayerEffect(kind, "x").json.objectValue?.keys ?? []) + (OPTIONAL_FIELDS[kind] ?? [])
}

/**
 * Checks a complete effect (every field of its kind present and in range). Throws a
 * `LayerEffectError` naming the first wrong field and how to fix it.
 */
public func validateLayerEffect(_ v: JSONValue?, _ path: String = "effect") throws {
    guard truthy(v), let e = objectOf(v) ?? (v?.arrayValue != nil ? JSONObject() : nil) else { throw fail(path, "must be an object.") }
    guard let kindName = e["kind"]?.stringValue, let kind = LayerEffectKind(rawValue: kindName) else {
        throw fail("\(path).kind", "must be one of \(LAYER_EFFECT_KINDS.map(\.rawValue).joined(separator: ", ")).")
    }
    guard let id = e["id"]?.stringValue, !id.isEmpty else { throw fail("\(path).id", "must be a non-empty string.") }
    try bool(e, "enabled", path)
    let allowed = layerEffectFields(kind)
    for k in e.keys where !allowed.contains(k) {
        throw fail("\(path).\(k)", "not a setting of \(kind.rawValue). Its settings are \(allowed.filter { $0 != "id" && $0 != "kind" }.joined(separator: ", ")).")
    }
    if kind != .bevelEmboss {
        try blend(e, "blend", path)
        try num(e, "opacity", path, 0, 1)
    }
    switch kind {
    case .dropShadow, .innerShadow:
        try color(e, "color", path)
        try num(e, "angle", path, -360, 360)
        try bool(e, "useGlobalLight", path)
        try num(e, "distance", path, 0, 30000)
        try num(e, kind == .dropShadow ? "spread" : "choke", path, 0, 1)
        try num(e, "size", path, 0, 250)
        try contour(e["contour"], "\(path).contour")
        try bool(e, "antiAlias", path)
        try num(e, "noise", path, 0, 1)
        if kind == .dropShadow { try bool(e, "knocksOut", path) }
    case .outerGlow, .innerGlow:
        try fillCheck(e["fill"], "\(path).fill", false)
        try oneOf(e, "technique", path, ["softer", "precise"])
        try num(e, kind == .outerGlow ? "spread" : "choke", path, 0, 1)
        try num(e, "size", path, 0, 250)
        try contour(e["contour"], "\(path).contour")
        try bool(e, "antiAlias", path)
        try num(e, "range", path, 0.01, 1)
        try num(e, "jitter", path, 0, 1)
        try num(e, "noise", path, 0, 1)
        if kind == .innerGlow { try oneOf(e, "source", path, ["edge", "center"]) }
    case .bevelEmboss:
        try oneOf(e, "style", path, ["inner-bevel", "outer-bevel", "emboss", "pillow-emboss", "stroke-emboss"])
        try oneOf(e, "technique", path, ["smooth", "chisel-hard", "chisel-soft"])
        try num(e, "depth", path, 0, 10)
        try oneOf(e, "direction", path, ["up", "down"])
        try num(e, "size", path, 0, 250)
        try num(e, "soften", path, 0, 16)
        try num(e, "angle", path, -360, 360)
        try num(e, "altitude", path, 0, 90)
        try bool(e, "useGlobalLight", path)
        try contour(e["glossContour"], "\(path).glossContour")
        try color(e, "highlightColor", path)
        try blend(e, "highlightBlend", path)
        try num(e, "highlightOpacity", path, 0, 1)
        try color(e, "shadowColor", path)
        try blend(e, "shadowBlend", path)
        try num(e, "shadowOpacity", path, 0, 1)
        if let ce = e["contourElement"] {
            guard truthy(ce), let c = objectOf(ce) ?? (ce.arrayValue != nil ? JSONObject() : nil) else { throw fail("\(path).contourElement", "must be { contour, range, antiAlias } or left out.") }
            try contour(c["contour"], "\(path).contourElement.contour")
            try num(c, "range", "\(path).contourElement", 0, 1)
            try bool(c, "antiAlias", "\(path).contourElement")
        }
        if let tv = e["texture"] {
            guard truthy(tv), let t = objectOf(tv) ?? (tv.arrayValue != nil ? JSONObject() : nil) else { throw fail("\(path).texture", "must be { patternId, scale, depth, invert } or left out.") }
            try patternRef(t, "\(path).texture")
            try num(t, "depth", "\(path).texture", -10, 10)
            try bool(t, "invert", "\(path).texture")
        }
    case .satin:
        try color(e, "color", path)
        try num(e, "angle", path, -360, 360)
        try num(e, "distance", path, 0, 250)
        try num(e, "size", path, 0, 250)
        try contour(e["contour"], "\(path).contour")
        try bool(e, "antiAlias", path)
        try bool(e, "invert", path)
    case .colorOverlay:
        try color(e, "color", path)
    case .gradientOverlay:
        try validateEffectGradient(e["gradient"], "\(path).gradient")
        try bool(e, "dither", path)
    case .patternOverlay:
        try patternRef(e, path)
    case .stroke:
        try num(e, "size", path, 0, 250)
        try oneOf(e, "position", path, ["outside", "inside", "center"])
        try fillCheck(e["fill"], "\(path).fill", true)
    }
}

/**
 * Applies `changes` to `effect` and validates the result. `kind` and `id` cannot change. Nested
 * objects (`fill`, `gradient`, `contour`, `texture`, `phase`, `offset`) are replaced whole; `null`
 * removes an optional one (`contour`, `glossContour`, bevel `contour` / `texture`).
 */
public func mergeLayerEffect(_ effect: LayerEffect, _ changes: JSONObject) throws -> LayerEffect {
    if let k = changes["kind"], k != .string(effect.kind.rawValue) { throw LayerEffectError("kind cannot change (\(effect.kind.rawValue)); remove the effect and add a new one.") }
    if let i = changes["id"], i != .string(effect.id) { throw LayerEffectError("id cannot change.") }
    var next = effect.json.objectValue ?? JSONObject()
    for (k, v) in changes {
        if v == .null { next[k] = Optional<JSONValue>.none } else { next[k] = v }
    }
    try validateLayerEffect(.object(next))
    return try LayerEffect(json: .object(next))
}

/// A layer's effects with `items` validated; throws on the first bad effect.
public func validateLayerEffects(_ v: JSONValue?) throws {
    guard truthy(v), let r = objectOf(v) ?? (v?.arrayValue != nil ? JSONObject() : nil) else { throw fail("effects", "must be { enabled, items }.") }
    try bool(r, "enabled", "effects")
    if r["scale"] != nil { try num(r, "scale", "effects", 0.01, 10) }
    guard let items = r["items"]?.arrayValue else { throw fail("effects.items", "must be a list.") }
    var ids = Set<String>()
    for (i, e) in items.enumerated() {
        try validateLayerEffect(e, "effects.items[\(i)]")
        let id = e["id"]!.stringValue!
        if ids.contains(id) { throw fail("effects.items[\(i)].id", "duplicate id \(id).") }
        ids.insert(id)
    }
}

/**
 * Reads effects from JSON leniently: invalid effects are dropped (so one bad entry does not lose
 * a document), and missing optional fields take their defaults. `nil` when nothing usable.
 */
public func normalizeLayerEffects(_ raw: JSONValue?, psd: EffectsPsdBlock? = nil) -> LayerEffects? {
    guard truthy(raw), let r = objectOf(raw) ?? (raw?.arrayValue != nil ? JSONObject() : nil) else { return nil }
    var items: [LayerEffect] = []
    var ids = Set<String>()
    if let list = r["items"]?.arrayValue {
        for it in list {
            guard let o = objectOf(it), let kindName = o["kind"]?.stringValue, let kind = LayerEffectKind(rawValue: kindName) else { continue }
            var merged = defaultLayerEffect(kind).json.objectValue ?? JSONObject()
            for (k, v) in o { merged[k] = v }
            if case .string(let id)? = merged["id"], !id.isEmpty, !ids.contains(id) {} else { merged["id"] = .string(newEffectId()) }
            guard (try? validateLayerEffect(.object(merged))) != nil, let effect = try? LayerEffect(json: .object(merged)) else { continue }
            ids.insert(effect.id)
            items.append(effect)
        }
    }
    var out = LayerEffects(enabled: r["enabled"] != .bool(false), items: items)
    if case .number(let s)? = r["scale"], s.isFinite, s > 0, s != 1 { out.scale = s }
    // The PSD block is binary: JSON cannot carry it, so the caller passes it.
    if let psd { out.psd = psd }
    return items.isEmpty && out.psd == nil ? nil : out
}

/// Effects without ids or the PSD block, for comparing what two effect stacks render.
public func effectsFingerprint(_ effects: LayerEffects?) -> String {
    guard let effects else { return "" }
    let items: [JSONValue] = effects.items.map { e in
        var o = e.json.objectValue ?? JSONObject()
        o["id"] = Optional<JSONValue>.none
        return .object(o)
    }
    return stableStringify(.array([.bool(effects.enabled), .number(effectsScale(effects)), .array(items)]))
}

/// JSON with object keys sorted, so key order never matters.
private func stableStringify(_ v: JSONValue) -> String {
    switch v {
    case .array(let a): return "[\(a.map(stableStringify).joined(separator: ","))]"
    case .object(let o):
        let keys = o.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
        return "{\(keys.map { "\(JSONValue.string($0).stringified()):\(stableStringify(o[$0]!))" }.joined(separator: ","))}"
    default: return v.stringified()
    }
}

// MARK: - JSON

extension EffectPoint {
    var json: JSONValue { .object(JSONObject([("x", .number(x)), ("y", .number(y))])) }
    init(json: JSONValue?) {
        self.init(x: json?["x"]?.numberValue ?? 0, y: json?["y"]?.numberValue ?? 0)
    }
}

extension EffectContour {
    public var json: JSONValue {
        .object(JSONObject([
            ("name", .string(name)),
            ("points", .array(points.map { p in
                var o = JSONObject([("input", .number(p.input)), ("output", .number(p.output))])
                if let c = p.corner { o["corner"] = .bool(c) }
                return .object(o)
            })),
        ]))
    }
    public init?(json: JSONValue?) {
        guard let json, let o = json.objectValue else { return nil }
        self.init(name: o["name"]?.stringValue ?? "", points: (o["points"]?.arrayValue ?? []).map {
            ContourPoint(input: $0["input"]?.numberValue ?? 0, output: $0["output"]?.numberValue ?? 0, corner: $0["corner"]?.boolValue)
        })
    }
}

extension EffectGradient {
    public var json: JSONValue {
        var o = JSONObject([("stops", .array(stops.map { .object(JSONObject([("position", .number($0.position)), ("color", .string($0.color))])) }))])
        if let os = opacityStops { o["opacityStops"] = .array(os.map { .object(JSONObject([("position", .number($0.position)), ("opacity", .number($0.opacity))])) }) }
        o["style"] = .string(style.rawValue)
        o["angle"] = .number(angle)
        o["scale"] = .number(scale)
        o["reverse"] = .bool(reverse)
        o["align"] = .bool(align)
        o["offset"] = offset.json
        return .object(o)
    }
    public init(json: JSONValue?) {
        self.init(
            stops: (json?["stops"]?.arrayValue ?? []).map { GradientColorStop(position: $0["position"]?.numberValue ?? 0, color: $0["color"]?.stringValue ?? "#000000") },
            opacityStops: json?["opacityStops"]?.arrayValue.map { $0.map { GradientOpacityStop(position: $0["position"]?.numberValue ?? 0, opacity: $0["opacity"]?.numberValue ?? 1) } },
            style: GradientStyle(rawValue: json?["style"]?.stringValue ?? "") ?? .linear,
            angle: json?["angle"]?.numberValue ?? 90,
            scale: json?["scale"]?.numberValue ?? 1,
            reverse: json?["reverse"]?.boolValue ?? false,
            align: json?["align"]?.boolValue ?? true,
            offset: EffectPoint(json: json?["offset"])
        )
    }
}

extension EffectPatternRef {
    /// The fields of a pattern reference, in order (merged into the object that carries it).
    var fields: [(String, JSONValue)] {
        var f: [(String, JSONValue)] = [("patternId", .string(patternId))]
        if let name { f.append(("name", .string(name))) }
        f.append(("scale", .number(scale)))
        if let angle { f.append(("angle", .number(angle))) }
        if let link { f.append(("link", .bool(link))) }
        if let phase { f.append(("phase", phase.json)) }
        return f
    }
    init(json: JSONValue?) {
        self.init(
            patternId: json?["patternId"]?.stringValue ?? "",
            name: json?["name"]?.stringValue,
            scale: json?["scale"]?.numberValue ?? 1,
            angle: json?["angle"]?.numberValue,
            link: json?["link"]?.boolValue,
            phase: json?["phase"].map { EffectPoint(json: $0) }
        )
    }
}

extension EffectFill {
    public var json: JSONValue {
        switch self {
        case .color(let c): return .object(JSONObject([("type", "color"), ("color", .string(c))]))
        case .gradient(let g): return .object(JSONObject([("type", "gradient"), ("gradient", g.json)]))
        case .pattern(let p): return .object(JSONObject([("type", "pattern")] + p.fields))
        }
    }
    public init(json: JSONValue?) {
        switch json?["type"]?.stringValue {
        case "gradient": self = .gradient(EffectGradient(json: json?["gradient"]))
        case "pattern": self = .pattern(EffectPatternRef(json: json))
        default: self = .color(json?["color"]?.stringValue ?? "#000000")
        }
    }
}

extension LayerEffect {
    /// The effect as the TS object (fields in the order `defaultLayerEffect` lists them, optional
    /// ones after).
    public var json: JSONValue {
        var f: [(String, JSONValue)] = [("id", .string(id)), ("enabled", .bool(enabled)), ("kind", .string(kind.rawValue))]
        func contour(_ c: EffectContour?) { if let c { f.append(("contour", c.json)) } }
        switch self {
        case .dropShadow(let e):
            f += [("blend", .string(e.blend.rawValue)), ("opacity", .number(e.opacity)), ("color", .string(e.color)), ("angle", .number(e.angle)), ("useGlobalLight", .bool(e.useGlobalLight)), ("distance", .number(e.distance)), ("spread", .number(e.spread)), ("size", .number(e.size)), ("antiAlias", .bool(e.antiAlias)), ("noise", .number(e.noise)), ("knocksOut", .bool(e.knocksOut))]
            contour(e.contour)
        case .innerShadow(let e):
            f += [("blend", .string(e.blend.rawValue)), ("opacity", .number(e.opacity)), ("color", .string(e.color)), ("angle", .number(e.angle)), ("useGlobalLight", .bool(e.useGlobalLight)), ("distance", .number(e.distance)), ("choke", .number(e.choke)), ("size", .number(e.size)), ("antiAlias", .bool(e.antiAlias)), ("noise", .number(e.noise))]
            contour(e.contour)
        case .outerGlow(let e):
            f += [("blend", .string(e.blend.rawValue)), ("opacity", .number(e.opacity)), ("fill", e.fill.json), ("technique", .string(e.technique.rawValue)), ("spread", .number(e.spread)), ("size", .number(e.size)), ("antiAlias", .bool(e.antiAlias)), ("range", .number(e.range)), ("jitter", .number(e.jitter)), ("noise", .number(e.noise))]
            contour(e.contour)
        case .innerGlow(let e):
            f += [("blend", .string(e.blend.rawValue)), ("opacity", .number(e.opacity)), ("fill", e.fill.json), ("technique", .string(e.technique.rawValue)), ("choke", .number(e.choke)), ("size", .number(e.size)), ("antiAlias", .bool(e.antiAlias)), ("range", .number(e.range)), ("jitter", .number(e.jitter)), ("noise", .number(e.noise)), ("source", .string(e.source))]
            contour(e.contour)
        case .bevelEmboss(let e):
            f += [("style", .string(e.style.rawValue)), ("technique", .string(e.technique.rawValue)), ("depth", .number(e.depth)), ("direction", .string(e.direction)), ("size", .number(e.size)), ("soften", .number(e.soften)), ("angle", .number(e.angle)), ("altitude", .number(e.altitude)), ("useGlobalLight", .bool(e.useGlobalLight)), ("highlightColor", .string(e.highlightColor)), ("highlightBlend", .string(e.highlightBlend.rawValue)), ("highlightOpacity", .number(e.highlightOpacity)), ("shadowColor", .string(e.shadowColor)), ("shadowBlend", .string(e.shadowBlend.rawValue)), ("shadowOpacity", .number(e.shadowOpacity))]
            if let g = e.glossContour { f.append(("glossContour", g.json)) }
            if let c = e.contourElement { f.append(("contourElement", .object(JSONObject([("contour", c.contour.json), ("range", .number(c.range)), ("antiAlias", .bool(c.antiAlias))])))) }
            if let t = e.texture { f.append(("texture", .object(JSONObject(t.pattern.fields + [("depth", .number(t.depth)), ("invert", .bool(t.invert))])))) }
        case .satin(let e):
            f += [("blend", .string(e.blend.rawValue)), ("opacity", .number(e.opacity)), ("color", .string(e.color)), ("angle", .number(e.angle)), ("distance", .number(e.distance)), ("size", .number(e.size)), ("antiAlias", .bool(e.antiAlias)), ("invert", .bool(e.invert))]
            contour(e.contour)
        case .colorOverlay(let e):
            f += [("blend", .string(e.blend.rawValue)), ("opacity", .number(e.opacity)), ("color", .string(e.color))]
        case .gradientOverlay(let e):
            f += [("blend", .string(e.blend.rawValue)), ("opacity", .number(e.opacity)), ("gradient", e.gradient.json), ("dither", .bool(e.dither))]
        case .patternOverlay(let e):
            f += [("blend", .string(e.blend.rawValue)), ("opacity", .number(e.opacity))] + e.pattern.fields
        case .stroke(let e):
            f += [("blend", .string(e.blend.rawValue)), ("opacity", .number(e.opacity)), ("size", .number(e.size)), ("position", .string(e.position.rawValue)), ("fill", e.fill.json)]
        }
        return .object(JSONObject(f))
    }

    /// An effect from its TS object. Validate it first (`validateLayerEffect`): this reads what is
    /// there and throws only for an unknown kind.
    public init(json: JSONValue) throws {
        guard let kind = LayerEffectKind(rawValue: json["kind"]?.stringValue ?? "") else { throw LayerEffectError("effect.kind: must be one of \(LAYER_EFFECT_KINDS.map(\.rawValue).joined(separator: ", ")).") }
        let id = json["id"]?.stringValue ?? ""
        let enabled = json["enabled"]?.boolValue ?? true
        let n = { (k: String) in json[k]?.numberValue ?? 0 }
        let b = { (k: String) in json[k]?.boolValue ?? false }
        let s = { (k: String) in json[k]?.stringValue ?? "" }
        let mode = { (k: String) in BlendMode(rawValue: json[k]?.stringValue ?? "") ?? .normal }
        let contour = EffectContour(json: json["contour"])
        switch kind {
        case .dropShadow:
            self = .dropShadow(DropShadowEffect(id: id, enabled: enabled, blend: mode("blend"), opacity: n("opacity"), color: s("color"), angle: n("angle"), useGlobalLight: b("useGlobalLight"), distance: n("distance"), spread: n("spread"), size: n("size"), contour: contour, antiAlias: b("antiAlias"), noise: n("noise"), knocksOut: b("knocksOut")))
        case .innerShadow:
            self = .innerShadow(InnerShadowEffect(id: id, enabled: enabled, blend: mode("blend"), opacity: n("opacity"), color: s("color"), angle: n("angle"), useGlobalLight: b("useGlobalLight"), distance: n("distance"), choke: n("choke"), size: n("size"), contour: contour, antiAlias: b("antiAlias"), noise: n("noise")))
        case .outerGlow:
            self = .outerGlow(OuterGlowEffect(id: id, enabled: enabled, blend: mode("blend"), opacity: n("opacity"), fill: EffectFill(json: json["fill"]), technique: GlowTechnique(rawValue: s("technique")) ?? .softer, spread: n("spread"), size: n("size"), contour: contour, antiAlias: b("antiAlias"), range: n("range"), jitter: n("jitter"), noise: n("noise")))
        case .innerGlow:
            self = .innerGlow(InnerGlowEffect(id: id, enabled: enabled, blend: mode("blend"), opacity: n("opacity"), fill: EffectFill(json: json["fill"]), technique: GlowTechnique(rawValue: s("technique")) ?? .softer, choke: n("choke"), size: n("size"), contour: contour, antiAlias: b("antiAlias"), range: n("range"), jitter: n("jitter"), noise: n("noise"), source: s("source")))
        case .bevelEmboss:
            let ce = json["contourElement"].flatMap { c -> BevelContour? in
                guard let contour = EffectContour(json: c["contour"]) else { return nil }
                return BevelContour(contour: contour, range: c["range"]?.numberValue ?? 0.5, antiAlias: c["antiAlias"]?.boolValue ?? false)
            }
            let tex = json["texture"].map { t in BevelTexture(pattern: EffectPatternRef(json: t), depth: t["depth"]?.numberValue ?? 1, invert: t["invert"]?.boolValue ?? false) }
            self = .bevelEmboss(BevelEmbossEffect(id: id, enabled: enabled, style: BevelStyle(rawValue: s("style")) ?? .innerBevel, technique: BevelTechnique(rawValue: s("technique")) ?? .smooth, depth: n("depth"), direction: s("direction"), size: n("size"), soften: n("soften"), angle: n("angle"), altitude: n("altitude"), useGlobalLight: b("useGlobalLight"), glossContour: EffectContour(json: json["glossContour"]), highlightColor: s("highlightColor"), highlightBlend: mode("highlightBlend"), highlightOpacity: n("highlightOpacity"), shadowColor: s("shadowColor"), shadowBlend: mode("shadowBlend"), shadowOpacity: n("shadowOpacity"), contourElement: ce, texture: tex))
        case .satin:
            self = .satin(SatinEffect(id: id, enabled: enabled, blend: mode("blend"), opacity: n("opacity"), color: s("color"), angle: n("angle"), distance: n("distance"), size: n("size"), contour: contour, antiAlias: b("antiAlias"), invert: b("invert")))
        case .colorOverlay:
            self = .colorOverlay(ColorOverlayEffect(id: id, enabled: enabled, blend: mode("blend"), opacity: n("opacity"), color: s("color")))
        case .gradientOverlay:
            self = .gradientOverlay(GradientOverlayEffect(id: id, enabled: enabled, blend: mode("blend"), opacity: n("opacity"), gradient: EffectGradient(json: json["gradient"]), dither: b("dither")))
        case .patternOverlay:
            self = .patternOverlay(PatternOverlayEffect(id: id, enabled: enabled, blend: mode("blend"), opacity: n("opacity"), pattern: EffectPatternRef(json: json)))
        case .stroke:
            self = .stroke(StrokeEffect(id: id, enabled: enabled, blend: mode("blend"), opacity: n("opacity"), size: n("size"), position: StrokePosition(rawValue: s("position")) ?? .outside, fill: EffectFill(json: json["fill"])))
        }
    }
}

extension LayerEffects {
    /// The effects as the TS object (without the binary PSD block).
    public var json: JSONValue {
        var o = JSONObject([("enabled", .bool(enabled))])
        if let scale { o["scale"] = .number(scale) }
        o["items"] = .array(items.map(\.json))
        return .object(o)
    }
}
