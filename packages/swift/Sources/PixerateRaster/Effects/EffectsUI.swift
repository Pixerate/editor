import Foundation
import PixerateCore

/**
 * The layer effects section's view model, shared by the panels: whether a layer can take effects,
 * its effect rows, the menu of kinds to add, and per effect a flat list of controls (sliders,
 * colours, toggles, choices) with how a change maps to `updateLayerEffect`. The port of
 * `raster/effects/ui.ts`.
 */

/// What the effects section reads of a layer (image and paint layers both fit).
public struct LayerEffectsTarget {
    public var id: String
    public var type: String
    public var effects: LayerEffects?
    public var locks: LayerLocks?
    public init(id: String, type: String, effects: LayerEffects? = nil, locks: LayerLocks? = nil) {
        self.id = id
        self.type = type
        self.effects = effects
        self.locks = locks
    }
}

/**
 * What the layer effects panels need of an editor: the image and paint editor controllers both
 * provide it, so both show the same panel.
 */
public protocol LayerEffectsController: AnyObject {
    func subscribe(_ listener: @escaping () -> Void) -> () -> Void
    func getLayer(_ id: String) -> LayerEffectsTarget?
    func getActiveLayer() -> LayerEffectsTarget?
    func getLayerEffects(_ id: String) -> LayerEffects
    func getDocumentPatterns() -> [EffectPattern]
    /// Returns the new effect's id.
    func addLayerEffect(_ id: String, _ kind: LayerEffectKind, _ settings: JSONObject?, _ index: Int?) throws -> String
    func updateLayerEffect(_ id: String, _ effectId: String, _ changes: JSONObject, _ commitToHistory: Bool) throws
    func removeLayerEffect(_ id: String, _ effectId: String) throws
    func setLayerEffectsEnabled(_ id: String, _ enabled: Bool, _ scale: Double?, _ commitToHistory: Bool) throws
}

public struct LayerEffectRow: Equatable {
    public var id: String
    public var kind: LayerEffectKind
    public var label: String
    public var enabled: Bool
}

public struct LayerEffectsPanelModel: Equatable {
    /// Whether the layer can carry effects (adjustment layers cannot; a fully locked layer refuses changes).
    public var available: Bool
    /// Why not, when unavailable or read-only.
    public var reason: String?
    public var readOnly: Bool
    public var enabled: Bool
    /// Scale Effects, 1 = 100 %.
    public var scale: Double
    public var rows: [LayerEffectRow]
}

/// The effects section for `layer`.
public func layerEffectsPanel(_ layer: LayerEffectsTarget?) -> LayerEffectsPanelModel {
    guard let layer else {
        return LayerEffectsPanelModel(available: false, reason: "Select a layer to add a layer style.", readOnly: true, enabled: true, scale: 1, rows: [])
    }
    if layer.type == "adjustment" {
        return LayerEffectsPanelModel(available: false, reason: "Adjustment layers cannot have a layer style.", readOnly: true, enabled: true, scale: 1, rows: [])
    }
    let fx = layer.effects
    let readOnly = layer.locks?.all == true
    return LayerEffectsPanelModel(
        available: true,
        reason: readOnly ? "The layer is locked; unlock it to change its layer style." : nil,
        readOnly: readOnly,
        enabled: fx?.enabled ?? true,
        scale: fx?.scale ?? 1,
        rows: (fx?.items ?? []).map { LayerEffectRow(id: $0.id, kind: $0.kind, label: layerEffectLabel($0.kind), enabled: $0.enabled) }
    )
}

/// The fx badge of a layer row: `on` (effects render), `off` (effects but switched off), or `nil`.
public func layerEffectsBadge(_ effects: LayerEffects?) -> String? {
    guard let effects, !effects.items.isEmpty else { return nil }
    return hasActiveEffects(effects) ? "on" : "off"
}

/// The kinds the "Add effect" menu offers, in the Layer Style dialog's order.
public let LAYER_EFFECT_MENU: [(kind: LayerEffectKind, label: String)] = LAYER_EFFECT_KINDS.map { ($0, layerEffectLabel($0)) }

public struct EffectControlOption: Equatable, Sendable {
    public var value: String
    public var label: String
}

public enum EffectControl: Equatable {
    /// A slider; `percent`: shown and edited as percent (value × 100).
    case range(key: String, label: String, min: Double, max: Double, step: Double, value: Double, percent: Bool, unit: String?)
    case color(key: String, label: String, value: String)
    case checkbox(key: String, label: String, value: Bool)
    case select(key: String, label: String, value: String, options: [EffectControlOption])

    public var key: String {
        switch self {
        case .range(let k, _, _, _, _, _, _, _), .color(let k, _, _), .checkbox(let k, _, _), .select(let k, _, _, _): return k
        }
    }

    /// The control as the TS object.
    public var json: JSONValue {
        switch self {
        case let .range(key, label, min, max, step, value, percent, unit):
            var o = JSONObject([("key", .string(key)), ("label", .string(label)), ("type", "range"), ("min", .number(min)), ("max", .number(max)), ("step", .number(step)), ("value", .number(value))])
            if percent { o["percent"] = true }
            if let unit { o["unit"] = .string(unit) }
            return .object(o)
        case let .color(key, label, value):
            return .object(JSONObject([("key", .string(key)), ("label", .string(label)), ("type", "color"), ("value", .string(value))]))
        case let .checkbox(key, label, value):
            return .object(JSONObject([("key", .string(key)), ("label", .string(label)), ("type", "checkbox"), ("value", .bool(value))]))
        case let .select(key, label, value, options):
            return .object(JSONObject([("key", .string(key)), ("label", .string(label)), ("type", "select"), ("value", .string(value)), ("options", .array(options.map { .object(JSONObject([("value", .string($0.value)), ("label", .string($0.label))])) }))]))
        }
    }
}

private let BLENDS: [EffectControlOption] = BLEND_MODES.filter { $0.id != .pigment }.map { EffectControlOption(value: $0.id.rawValue, label: $0.label) }
private func opt(_ pairs: [(String, String)]) -> [EffectControlOption] { pairs.map { EffectControlOption(value: $0.0, label: $0.1) } }

private func patternOptions(_ patterns: [EffectPattern]) -> [EffectControlOption] {
    patterns.map { EffectControlOption(value: $0.id, label: $0.name.isEmpty ? $0.id : $0.name) } + builtinPatternIds().map { EffectControlOption(value: $0, label: builtinPattern($0)!.name) }
}

/// Reads a dotted path (`fill.color`, `gradient.stops.last.color`).
private func getPath(_ o: JSONValue?, _ path: String) -> JSONValue? {
    var v = o
    for p in path.split(separator: ".", omittingEmptySubsequences: false).map(String.init) {
        guard let cur = v, cur != .null else { return nil }
        if let a = cur.arrayValue {
            let i = p == "last" ? a.count - 1 : Int(p) ?? -1
            v = i >= 0 && i < a.count ? a[i] : nil
        } else {
            v = cur.objectValue?[p]
        }
    }
    return v
}

/// A copy of `o` with `path` set to `value` (arrays and objects copied along the path).
private func setPath(_ o: JSONValue?, _ parts: [String], _ value: JSONValue) -> JSONValue {
    guard let p = parts.first else { return value }
    let rest = Array(parts.dropFirst())
    if var a = o?.arrayValue {
        let i = p == "last" ? a.count - 1 : Int(p) ?? 0
        while a.count <= i { a.append(.null) }
        a[i] = setPath(a[i], rest, value)
        return .array(a)
    }
    var r = o?.objectValue ?? JSONObject()
    r[p] = setPath(r[p], rest, value)
    return .object(r)
}

private func fillControls(_ f: EffectFill, _ allowPattern: Bool, _ patterns: [EffectPattern]) -> [EffectControl] {
    let types = allowPattern ? opt([("color", "Color"), ("gradient", "Gradient"), ("pattern", "Pattern")]) : opt([("color", "Color"), ("gradient", "Gradient")])
    var out: [EffectControl] = [.select(key: "fill.type", label: "Fill", value: f.type, options: types)]
    switch f {
    case .color(let c): out.append(.color(key: "fill.color", label: "Color", value: c))
    case .gradient(let g): out += gradientControls("fill.gradient", g)
    case .pattern(let p):
        out.append(.select(key: "fill.patternId", label: "Pattern", value: p.patternId, options: patternOptions(patterns)))
        out.append(.range(key: "fill.scale", label: "Scale", min: 0.01, max: 10, step: 0.01, value: p.scale, percent: true, unit: "%"))
    }
    return out
}

private func gradientControls(_ prefix: String, _ g: EffectGradient) -> [EffectControl] {
    [
        .color(key: "\(prefix).stops.0.color", label: "Start colour", value: g.stops.first?.color ?? "#000000"),
        .color(key: "\(prefix).stops.last.color", label: "End colour", value: g.stops.last?.color ?? "#ffffff"),
        .select(key: "\(prefix).style", label: "Style", value: g.style.rawValue, options: opt([("linear", "Linear"), ("radial", "Radial"), ("angle", "Angle"), ("reflected", "Reflected"), ("diamond", "Diamond")])),
        .range(key: "\(prefix).angle", label: "Angle", min: -180, max: 180, step: 1, value: g.angle, percent: false, unit: "°"),
        .range(key: "\(prefix).scale", label: "Scale", min: 0.1, max: 1.5, step: 0.01, value: g.scale, percent: true, unit: "%"),
        .checkbox(key: "\(prefix).reverse", label: "Reverse", value: g.reverse),
        .checkbox(key: "\(prefix).align", label: "Align with layer", value: g.align),
    ]
}

private func px(_ key: String, _ label: String, _ value: Double, _ max: Double = 250) -> EffectControl {
    .range(key: key, label: label, min: 0, max: max, step: 1, value: value, percent: false, unit: "px")
}
private func pct(_ key: String, _ label: String, _ value: Double, _ min: Double = 0, _ max: Double = 1) -> EffectControl {
    .range(key: key, label: label, min: min, max: max, step: 0.01, value: value, percent: true, unit: "%")
}
private func deg(_ key: String, _ label: String, _ value: Double, _ min: Double = -180, _ max: Double = 180) -> EffectControl {
    .range(key: key, label: label, min: min, max: max, step: 1, value: value, percent: false, unit: "°")
}

/**
 * The controls for one effect, in the Layer Style dialog's order. `patterns` are the document's
 * patterns (the built-in ones are always offered).
 */
public func layerEffectControls(_ e: LayerEffect, _ patterns: [EffectPattern] = []) -> [EffectControl] {
    let blended: [EffectControl] = e.blended.map { [.select(key: "blend", label: "Blend mode", value: $0.blend.rawValue, options: BLENDS), pct("opacity", "Opacity", $0.opacity)] } ?? []
    switch e {
    case .dropShadow(let x):
        return blended + [.color(key: "color", label: "Color", value: x.color), .checkbox(key: "useGlobalLight", label: "Use global light", value: x.useGlobalLight), deg("angle", "Angle", x.angle), px("distance", "Distance", x.distance, 500), pct("spread", "Spread", x.spread), px("size", "Size", x.size), pct("noise", "Noise", x.noise), .checkbox(key: "knocksOut", label: "Layer knocks out shadow", value: x.knocksOut)]
    case .innerShadow(let x):
        return blended + [.color(key: "color", label: "Color", value: x.color), .checkbox(key: "useGlobalLight", label: "Use global light", value: x.useGlobalLight), deg("angle", "Angle", x.angle), px("distance", "Distance", x.distance, 500), pct("choke", "Choke", x.choke), px("size", "Size", x.size), pct("noise", "Noise", x.noise)]
    case .outerGlow(let x):
        return blended + fillControls(x.fill, false, patterns) + [.select(key: "technique", label: "Technique", value: x.technique.rawValue, options: opt([("softer", "Softer"), ("precise", "Precise")])), pct("spread", "Spread", x.spread), px("size", "Size", x.size), pct("range", "Range", x.range, 0.01, 1), pct("noise", "Noise", x.noise)]
    case .innerGlow(let x):
        return blended + fillControls(x.fill, false, patterns) + [.select(key: "technique", label: "Technique", value: x.technique.rawValue, options: opt([("softer", "Softer"), ("precise", "Precise")])), .select(key: "source", label: "Source", value: x.source, options: opt([("edge", "Edge"), ("center", "Center")])), pct("choke", "Choke", x.choke), px("size", "Size", x.size), pct("range", "Range", x.range, 0.01, 1), pct("noise", "Noise", x.noise)]
    case .bevelEmboss(let x):
        return [
            .select(key: "style", label: "Style", value: x.style.rawValue, options: opt([("inner-bevel", "Inner Bevel"), ("outer-bevel", "Outer Bevel"), ("emboss", "Emboss"), ("pillow-emboss", "Pillow Emboss"), ("stroke-emboss", "Stroke Emboss")])),
            .select(key: "technique", label: "Technique", value: x.technique.rawValue, options: opt([("smooth", "Smooth"), ("chisel-hard", "Chisel Hard"), ("chisel-soft", "Chisel Soft")])),
            pct("depth", "Depth", x.depth, 0, 10),
            .select(key: "direction", label: "Direction", value: x.direction, options: opt([("up", "Up"), ("down", "Down")])),
            px("size", "Size", x.size),
            px("soften", "Soften", x.soften, 16),
            .checkbox(key: "useGlobalLight", label: "Use global light", value: x.useGlobalLight),
            deg("angle", "Angle", x.angle),
            deg("altitude", "Altitude", x.altitude, 0, 90),
            .color(key: "highlightColor", label: "Highlight", value: x.highlightColor),
            .select(key: "highlightBlend", label: "Highlight mode", value: x.highlightBlend.rawValue, options: BLENDS),
            pct("highlightOpacity", "Highlight opacity", x.highlightOpacity),
            .color(key: "shadowColor", label: "Shadow", value: x.shadowColor),
            .select(key: "shadowBlend", label: "Shadow mode", value: x.shadowBlend.rawValue, options: BLENDS),
            pct("shadowOpacity", "Shadow opacity", x.shadowOpacity),
        ]
    case .satin(let x):
        return blended + [.color(key: "color", label: "Color", value: x.color), deg("angle", "Angle", x.angle), px("distance", "Distance", x.distance), px("size", "Size", x.size), .checkbox(key: "invert", label: "Invert", value: x.invert)]
    case .colorOverlay(let x):
        return blended + [.color(key: "color", label: "Color", value: x.color)]
    case .gradientOverlay(let x):
        return blended + gradientControls("gradient", x.gradient)
    case .patternOverlay(let x):
        return blended + [.select(key: "patternId", label: "Pattern", value: x.pattern.patternId, options: patternOptions(patterns)), pct("scale", "Scale", x.pattern.scale, 0.01, 10), deg("angle", "Angle", x.pattern.angle ?? 0), .checkbox(key: "link", label: "Link with layer", value: x.pattern.link ?? true)]
    case .stroke(let x):
        return blended + [px("size", "Size", x.size), .select(key: "position", label: "Position", value: x.position.rawValue, options: opt([("outside", "Outside"), ("inside", "Inside"), ("center", "Center")]))] + fillControls(x.fill, true, patterns)
    }
}

/// A new fill of `type`, keeping the colour where it can.
private func fillOfType(_ current: EffectFill?, _ type: String, _ patterns: [EffectPattern]) -> EffectFill {
    if type == "gradient" { return .gradient(defaultEffectGradient()) }
    if type == "pattern" { return .pattern(EffectPatternRef(patternId: patterns.first?.id ?? "checker", scale: 1)) }
    if case .color(let c)? = current { return .color(c) }
    return .color("#000000")
}

/// The JavaScript `String(value)` of a control value.
private func stringOf(_ v: JSONValue) -> String {
    switch v {
    case .string(let s): return s
    case .null: return "null"
    default: return v.stringified()
    }
}

/**
 * The `updateLayerEffect` settings for setting control `key` of `effect` to `value` (a nested
 * object such as `fill` or `gradient` is replaced whole, with the one field changed). Values are
 * in the effect's own units (fractions for percent controls).
 */
public func effectControlChange(_ effect: LayerEffect, _ key: String, _ value: JSONValue, _ patterns: [EffectPattern] = []) -> JSONObject {
    let parts = key.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    let top = parts[0]
    let rest = Array(parts.dropFirst())
    let json = effect.json
    let currentFill: EffectFill? = {
        switch effect {
        case .outerGlow(let x): return x.fill
        case .innerGlow(let x): return x.fill
        case .stroke(let x): return x.fill
        default: return nil
        }
    }()
    if top == "fill" && rest.first == "type" { return JSONObject([("fill", fillOfType(currentFill, stringOf(value), patterns).json)]) }
    if top == "patternId" && rest.isEmpty {
        if let name = patternOptions(patterns).first(where: { .string($0.value) == value })?.label { return JSONObject([("patternId", value), ("name", .string(name))]) }
        return JSONObject([("patternId", value)])
    }
    if rest.isEmpty { return JSONObject([(top, value)]) }
    // A pattern name follows its id.
    if top == "fill" && rest.first == "patternId" {
        var fill = json["fill"]?.objectValue ?? JSONObject()
        fill["patternId"] = value
        if let name = patternOptions(patterns).first(where: { .string($0.value) == value })?.label { fill["name"] = .string(name) }
        return JSONObject([("fill", .object(fill))])
    }
    return JSONObject([(top, setPath(getPath(json, top), rest, value))])
}
