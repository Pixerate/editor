import Foundation
import PixerateCore

/**
 * Paint hints (`EffectPaintHint` in `effects/types.ts`, helpers in `effects/helpers.ts`): how a
 * provider suggests an effect is painted with. A provider whose capabilities set `paintHints`
 * gives one to every effect that suits paint, and editors then offer only those as paint.
 */

/// How an effect follows a stroke when painted with (`EFFECT_PAINT_MAPS`).
public let EFFECT_PAINT_MAPS = ["path", "stroke", "canvas"]
/// What a `stroke` strip does past its end (`EFFECT_PAINT_REPEATS`).
public let EFFECT_PAINT_REPEATS = ["repeat", "mirror", "clamp"]
/// Most colour controls a paint hint names.
public let EFFECT_PAINT_MAX_COLORS = 2

/// An effect's paint hint (`EffectPaintHint`): read from its `paint` JSON.
public struct EffectPaintHint: Equatable, Sendable {
    /// `path`, `stroke` or `canvas`.
    public var map: String
    /// Up to two colour controls for the brush's main and second colours, main first.
    public var colors: [String]
    /// Control values over the defaults when painting.
    public var values: JSONObject
    /// Whether a stroke keeps playing the effect.
    public var live: Bool
    /// For `stroke`: past the strip's end (nil: `mirror`).
    public var `repeat`: String?
    /// A suggested brush width (px).
    public var size: Double?

    public init(map: String, colors: [String] = [], values: JSONObject = [:], live: Bool = false, `repeat`: String? = nil, size: Double? = nil) {
        self.map = map
        self.colors = colors
        self.values = values
        self.live = live
        self.repeat = `repeat`
        self.size = size
    }

    /// The hint in a valid shape, or nil (`effectPaintHintShapeProblems` says why).
    public init?(json: JSONValue?) {
        guard let json, effectPaintHintShapeProblems(json).isEmpty, let o = json.objectValue, let map = o["map"]?.stringValue else { return nil }
        self.init(map: map, colors: (o["colors"]?.arrayValue ?? []).compactMap(\.stringValue), values: o["values"]?.objectValue ?? [:], live: o["live"]?.boolValue ?? false, `repeat`: o["repeat"]?.stringValue, size: o["size"]?.numberValue)
    }
}

extension EffectDescription {
    /// Its paint hint (`paint`), or nil when it has none or it is malformed.
    public var paint: EffectPaintHint? { EffectPaintHint(json: json["paint"]) }
}

/// Whether effect paint should offer `e` (`effectSuitsPaint`): always, unless the provider declares `paintHints`, when only hinted effects do.
public func effectSuitsPaint(_ e: EffectDescription, capabilities: JSONObject?) -> Bool {
    capabilities?["paintHints"]?.boolValue != true || e.json["paint"] != nil
}

/// Problems with the shape of a paint hint (`effectPaintHintShapeProblems`), not checked against controls.
public func effectPaintHintShapeProblems(_ raw: JSONValue) -> [String] {
    guard let o = raw.objectValue else { return ["paint must be an object { map, colors?, values?, live?, repeat?, size? }"] }
    var out: [String] = []
    let known = ["map", "colors", "values", "live", "repeat", "size"]
    for k in o.keys where !known.contains(k) { out.append("paint.\(k) is not a paint hint field (map, colors, values, live, repeat, size)") }
    if !EFFECT_PAINT_MAPS.contains(o["map"]?.stringValue ?? "\u{0}") || o["map"]?.stringValue == nil { out.append("paint.map must be \(EFFECT_PAINT_MAPS.map { "\"\($0)\"" }.joined(separator: ", "))") }
    if let c = o["colors"] {
        let names = c.arrayValue?.compactMap(\.stringValue)
        if c.arrayValue == nil || names!.count != c.arrayValue!.count || names!.contains(where: \.isEmpty) { out.append("paint.colors must be a list of colour control names") }
        else if names!.count > EFFECT_PAINT_MAX_COLORS { out.append("paint.colors names \(names!.count) controls; at most \(EFFECT_PAINT_MAX_COLORS) (the main colour, then the second)") }
        else if Set(names!).count != names!.count { out.append("paint.colors names a control twice") }
    }
    if let v = o["values"], v.objectValue == nil { out.append("paint.values must be an object of control values") }
    if let l = o["live"], l.boolValue == nil { out.append("paint.live must be true or false") }
    if let r = o["repeat"], !EFFECT_PAINT_REPEATS.contains(r.stringValue ?? "\u{0}") { out.append("paint.repeat must be \(EFFECT_PAINT_REPEATS.map { "\"\($0)\"" }.joined(separator: ", "))") }
    if let s = o["size"], !(s.numberValue.map { $0.isFinite && $0 > 0 } ?? false) { out.append("paint.size must be a brush width in px above 0") }
    return out
}

/// Problems with a paint hint against an effect's controls (`effectPaintHintProblems`): empty when `paint` is nil.
public func effectPaintHintProblems(_ d: EffectDescription, paint: JSONValue?) -> [String] {
    guard let paint else { return [] }
    let shape = effectPaintHintShapeProblems(paint)
    if !shape.isEmpty { return shape }
    let o = paint.objectValue!
    var out: [String] = []
    let controls = d.controls["properties"]?.objectValue ?? [:]
    for c in (o["colors"]?.arrayValue ?? []).compactMap(\.stringValue) {
        if controls[c] == nil { out.append("paint.colors names \"\(c)\", which is not a control") }
        else if !effectValueErrors(d, [c: .string("#000000")]).isEmpty { out.append("paint.colors names \"\(c)\", which does not take a \"#rrggbb\" colour") }
    }
    for e in effectValueErrors(d, o["values"]?.objectValue) { out.append("paint.values \(e.path): \(e.message)") }
    if o["map"]?.stringValue == "path" && pathControlsOf(d).isEmpty { out.append("paint.map is \"path\", but no control takes a path (format \"svg-path\"); use \"stroke\" or \"canvas\"") }
    return out
}

/// An effect's own paint hint against its controls.
public func effectPaintHintProblems(_ d: EffectDescription) -> [String] { effectPaintHintProblems(d, paint: d.json["paint"]) }

/// `d` with `paint` as its paint hint JSON (none when nil).
func withPaintHint(_ d: EffectDescription, _ paint: JSONValue?) -> EffectDescription {
    var o = d.json
    o["paint"] = paint
    return EffectDescription(o)
}
