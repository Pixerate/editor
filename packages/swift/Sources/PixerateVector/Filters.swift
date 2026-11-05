import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Visual filters of vector nodes (`vector/filters.ts`): drop shadow, inner shadow, outer and
// inner glow, layer blur and feather, drawn as one SVG `<filter>` per node. Filters are JSON
// objects (`{ id, type, params, enabled? }`) in the TS key order.

/// `VECTOR_FILTER_TYPES`.
public let VECTOR_FILTER_TYPES = ["dropShadow", "innerShadow", "outerGlow", "innerGlow", "layerBlur", "feather"]

/// Default parameters of each filter type (`VECTOR_FILTER_DEFAULTS`).
public let VECTOR_FILTER_DEFAULTS: [String: JSONObject] = [
    "dropShadow": JSONObject([("color", "#000000"), ("opacity", 0.25), ("offsetX", 0), ("offsetY", 4), ("blur", 4), ("spread", 0)]),
    "innerShadow": JSONObject([("color", "#000000"), ("opacity", 0.25), ("offsetX", 0), ("offsetY", 4), ("blur", 4), ("spread", 0)]),
    "outerGlow": JSONObject([("color", "#ffffbe"), ("opacity", 0.75), ("blur", 10), ("spread", 0)]),
    "innerGlow": JSONObject([("color", "#ffffbe"), ("opacity", 0.75), ("blur", 10), ("spread", 0)]),
    "layerBlur": JSONObject([("radius", 4)]),
    "feather": JSONObject([("radius", 8)]),
]

/// `VECTOR_FILTER_LABELS`.
public let VECTOR_FILTER_LABELS = ["dropShadow": "Drop Shadow", "innerShadow": "Inner Shadow", "outerGlow": "Outer Glow", "innerGlow": "Inner Glow", "layerBlur": "Layer Blur", "feather": "Feather"]

/// How a panel edits one effect or filter parameter (`VectorEffectParamSpec`).
public struct VectorParamSpec: Sendable {
    public enum Kind: String, Sendable { case number, vec2, boolean, select, color }
    public var key: String
    public var label: String
    public var kind: Kind
    public var min: Double?
    public var max: Double?
    public var step: Double?
    public var options: [String]

    public static func number(_ key: String, _ label: String, min: Double? = nil, max: Double? = nil, step: Double) -> VectorParamSpec {
        VectorParamSpec(key: key, label: label, kind: .number, min: min, max: max, step: step, options: [])
    }
    public static func vec2(_ key: String, _ label: String) -> VectorParamSpec { VectorParamSpec(key: key, label: label, kind: .vec2, options: []) }
    public static func boolean(_ key: String, _ label: String) -> VectorParamSpec { VectorParamSpec(key: key, label: label, kind: .boolean, options: []) }
    public static func select(_ key: String, _ label: String, _ options: [String]) -> VectorParamSpec { VectorParamSpec(key: key, label: label, kind: .select, options: options) }
    public static func color(_ key: String, _ label: String) -> VectorParamSpec { VectorParamSpec(key: key, label: label, kind: .color, options: []) }
}

private let SHADOW_SPECS: [VectorParamSpec] = [
    .color("color", "Color"),
    .number("opacity", "Opacity", min: 0, max: 1, step: 0.01),
    .number("offsetX", "X", min: -1000, max: 1000, step: 1),
    .number("offsetY", "Y", min: -1000, max: 1000, step: 1),
    .number("blur", "Blur", min: 0, max: 500, step: 1),
    .number("spread", "Spread", min: 0, max: 500, step: 1),
]
private let GLOW_SPECS = SHADOW_SPECS.filter { $0.key != "offsetX" && $0.key != "offsetY" }
private func choke(_ specs: [VectorParamSpec]) -> [VectorParamSpec] {
    specs.map { s in
        var c = s
        if s.key == "spread" { c.label = "Choke" }
        return c
    }
}

/// The editable parameters of each filter type, in panel order (`VECTOR_FILTER_PARAM_SPECS`).
public let VECTOR_FILTER_PARAM_SPECS: [String: [VectorParamSpec]] = [
    "dropShadow": SHADOW_SPECS,
    "innerShadow": choke(SHADOW_SPECS),
    "outerGlow": GLOW_SPECS,
    "innerGlow": choke(GLOW_SPECS),
    "layerBlur": [.number("radius", "Radius", min: 0, max: 500, step: 1)],
    "feather": [.number("radius", "Radius", min: 0, max: 500, step: 1)],
]

public func isVectorFilterType(_ value: JSONValue?) -> Bool {
    guard let s = value?.stringValue else { return false }
    return VECTOR_FILTER_TYPES.contains(s)
}

/// Filter parameters with defaults (or `base`) filled in; values of the wrong type are dropped,
/// numbers clamped to their range, unknown keys ignored. Nil for an unknown type
/// (`normalizeVectorFilterParams`).
public func normalizeVectorFilterParams(_ type: String, _ params: JSONObject?, _ base: JSONObject? = nil) -> JSONObject? {
    guard var out = VECTOR_FILTER_DEFAULTS[type], let specs = VECTOR_FILTER_PARAM_SPECS[type] else { return nil }
    for (k, v) in base ?? JSONObject() { out[k] = v }
    for spec in specs {
        guard let v = params?[spec.key] else { continue }
        if spec.kind == .number, let n = v.numberValue, n.isFinite {
            out[spec.key] = .number(JS.min(spec.max ?? .infinity, JS.max(spec.min ?? -.infinity, n)))
        } else if spec.kind == .color, let s = v.stringValue, !s.jsTrimmed.isEmpty {
            out[spec.key] = .string(s.jsTrimmed)
        }
    }
    return out
}

/// The parameter keys a filter type takes (`vectorFilterParamKeys`).
public func vectorFilterParamKeys(_ type: String) -> [String] { (VECTOR_FILTER_PARAM_SPECS[type] ?? []).map(\.key) }

/// A new filter of `type` (defaults merged with `params`), or nil for an unknown type (`createVectorFilter`).
public func createVectorFilter(_ type: String, _ id: String, _ params: JSONObject? = nil) -> JSONObject? {
    guard let p = normalizeVectorFilterParams(type, params) else { return nil }
    return JSONObject([("id", .string(id)), ("type", .string(type)), ("params", .object(p))])
}

/// Filters from untrusted data: unknown types and malformed entries dropped, parameters
/// normalized, ids made unique (`sanitizeVectorFilters`).
public func sanitizeVectorFilters(_ value: JSONValue?) -> [JSONObject] {
    guard let list = value?.arrayValue else { return [] }
    var out: [JSONObject] = []
    var used = Set<String>()
    for raw in list {
        guard let r = raw.objectValue, isVectorFilterType(r["type"]), let type = r["type"]?.stringValue else { continue }
        var id = ""
        if let s = r["id"]?.stringValue, !s.isEmpty, !used.contains(s) { id = s }
        var k = out.count + 1
        while id.isEmpty {
            if !used.contains("filter\(k)") { id = "filter\(k)" }
            k += 1
        }
        used.insert(id)
        var filter = createVectorFilter(type, id, r["params"]?.objectValue ?? JSONObject())!
        if r["enabled"] == .bool(false) { filter["enabled"] = false }
        out.append(filter)
    }
    return out
}

/// Whether a filter draws something (enabled, known, with a visible result).
private func drawsFilter(_ f: JSONValue) -> Bool {
    guard f["enabled"] != .bool(false), let type = f["type"]?.stringValue, VECTOR_FILTER_TYPES.contains(type) else { return false }
    let params = f["params"]
    if type == "layerBlur" || type == "feather" { return (params?["radius"]?.numberValue ?? .nan) > 0 }
    return (params?["opacity"]?.numberValue ?? .nan) > 0
}

/// The filters of a node that draw (`activeVectorFilters`).
func activeVectorFilters(_ node: VectorNode) -> [JSONValue] {
    (node["filters"]?.arrayValue ?? []).filter(drawsFilter)
}

/// How far filters can paint past what a node draws, in its own units (`vectorFilterReach`).
public func vectorFilterReach(_ filters: [JSONValue]) -> Double {
    var outer = 0.0
    var blur = 0.0
    for f in filters {
        func p(_ k: String) -> Double { f["params"]?[k]?.numberValue ?? .nan }
        switch f["type"]?.stringValue {
        case "dropShadow", "innerShadow":
            outer = JS.max(outer, JS.max(abs(p("offsetX")), abs(p("offsetY"))) + p("blur") * 1.5 + p("spread"))
        case "outerGlow", "innerGlow":
            outer = JS.max(outer, p("blur") * 1.5 + p("spread"))
        case "layerBlur":
            blur += p("radius") * 1.5
        default: break
        }
    }
    return outer + blur
}

/// One SVG filter primitive as data (`VectorFilterPrimitive`): a tag, its attributes (strings or
/// numbers, in order) and children.
public struct VectorFilterPrimitive: Equatable, Sendable {
    public var tag: String
    public var attrs: JSONObject
    public var children: [VectorFilterPrimitive]?

    public var json: JSONValue {
        var o = JSONObject([("tag", .string(tag)), ("attrs", .object(attrs))])
        if let children { o["children"] = .array(children.map(\.json)) }
        return .object(o)
    }
}

/// A node's filter as data (`VectorRenderFilter`): the region in the node's own space and the primitives.
public struct VectorRenderFilter: Equatable, Sendable {
    public var id: String
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public var primitives: [VectorFilterPrimitive]

    public var json: JSONValue {
        .object(JSONObject([("id", .string(id)), ("x", .number(x)), ("y", .number(y)), ("width", .number(width)), ("height", .number(height)), ("primitives", .array(primitives.map(\.json)))]))
    }
}

@inline(__always) private func round3(_ n: Double) -> Double { JS.round(n * 1000) / 1000 }

private func fe(_ tag: String, _ attrs: [(String, JSONValue)], _ children: [VectorFilterPrimitive]? = nil) -> VectorFilterPrimitive {
    VectorFilterPrimitive(tag: tag, attrs: JSONObject(attrs), children: children)
}

/// The SVG filter for `filters` over a node whose drawing covers `bounds` (its own space, strokes
/// included), or nil when none of them draws (`vectorFilterSvg`).
public func vectorFilterSvg(_ filters: [JSONValue], _ id: String, _ bounds: VectorBounds?) -> VectorRenderFilter? {
    let active = filters.filter(drawsFilter)
    guard !active.isEmpty, let bounds else { return nil }
    var primitives: [VectorFilterPrimitive] = []
    var body = "SourceGraphic"
    var n = 0
    func name(_ part: String) -> String { "\(part)\(n)" }
    func num(_ f: JSONValue, _ k: String) -> Double { f["params"]?[k]?.numberValue ?? .nan }
    func color(_ f: JSONValue) -> JSONValue { f["params"]?["color"] ?? .null }
    // Inner shadows and glows, over the body and clipped to the silhouette.
    for f in active {
        let type = f["type"]!.stringValue!
        if type != "innerShadow" && type != "innerGlow" { continue }
        n += 1
        primitives.append(fe("feComponentTransfer", [("in", "SourceAlpha"), ("result", .string(name("inv")))], [fe("feFuncA", [("type", "table"), ("tableValues", "1 0")])]))
        var last = name("inv")
        if type == "innerShadow" && (num(f, "offsetX") != 0 || num(f, "offsetY") != 0) {
            primitives.append(fe("feOffset", [("in", .string(last)), ("dx", .number(round3(num(f, "offsetX")))), ("dy", .number(round3(num(f, "offsetY")))), ("result", .string(name("off")))]))
            last = name("off")
        }
        if num(f, "spread") > 0 {
            primitives.append(fe("feMorphology", [("in", .string(last)), ("operator", "dilate"), ("radius", .number(round3(num(f, "spread")))), ("result", .string(name("grow")))]))
            last = name("grow")
        }
        if num(f, "blur") > 0 {
            primitives.append(fe("feGaussianBlur", [("in", .string(last)), ("stdDeviation", .number(round3(num(f, "blur") / 2))), ("result", .string(name("blur")))]))
            last = name("blur")
        }
        primitives.append(fe("feFlood", [("flood-color", color(f)), ("flood-opacity", .number(round3(num(f, "opacity")))), ("result", .string(name("color")))]))
        primitives.append(fe("feComposite", [("in", .string(name("color"))), ("in2", .string(last)), ("operator", "in"), ("result", .string(name("tint")))]))
        primitives.append(fe("feComposite", [("in", .string(name("tint"))), ("in2", "SourceAlpha"), ("operator", "in"), ("result", .string(name("inner")))]))
        primitives.append(fe("feComposite", [("in", .string(name("inner"))), ("in2", .string(body)), ("operator", "over"), ("result", .string(name("body")))]))
        body = name("body")
    }
    // Feather: keep the body where the eroded, blurred silhouette is.
    for f in active where f["type"] == "feather" {
        n += 1
        let r = num(f, "radius")
        primitives.append(fe("feMorphology", [("in", "SourceAlpha"), ("operator", "erode"), ("radius", .number(round3(r / 2))), ("result", .string(name("core")))]))
        primitives.append(fe("feGaussianBlur", [("in", .string(name("core"))), ("stdDeviation", .number(round3(r / 4))), ("result", .string(name("fade")))]))
        primitives.append(fe("feComposite", [("in", .string(body)), ("in2", .string(name("fade"))), ("operator", "in"), ("result", .string(name("body")))]))
        body = name("body")
    }
    // Drop shadows and outer glows, under the body.
    var under: [String] = []
    for f in active {
        let type = f["type"]!.stringValue!
        if type != "dropShadow" && type != "outerGlow" { continue }
        n += 1
        var last = "SourceAlpha"
        if num(f, "spread") > 0 {
            primitives.append(fe("feMorphology", [("in", .string(last)), ("operator", "dilate"), ("radius", .number(round3(num(f, "spread")))), ("result", .string(name("grow")))]))
            last = name("grow")
        }
        if num(f, "blur") > 0 {
            primitives.append(fe("feGaussianBlur", [("in", .string(last)), ("stdDeviation", .number(round3(num(f, "blur") / 2))), ("result", .string(name("blur")))]))
            last = name("blur")
        }
        if type == "dropShadow" && (num(f, "offsetX") != 0 || num(f, "offsetY") != 0) {
            primitives.append(fe("feOffset", [("in", .string(last)), ("dx", .number(round3(num(f, "offsetX")))), ("dy", .number(round3(num(f, "offsetY")))), ("result", .string(name("off")))]))
            last = name("off")
        }
        primitives.append(fe("feFlood", [("flood-color", color(f)), ("flood-opacity", .number(round3(num(f, "opacity")))), ("result", .string(name("color")))]))
        primitives.append(fe("feComposite", [("in", .string(name("color"))), ("in2", .string(last)), ("operator", "in"), ("result", .string(name("shadow")))]))
        under.append(name("shadow"))
    }
    if !under.isEmpty {
        n += 1
        primitives.append(fe("feMerge", [("result", .string(name("merged")))], (under + [body]).map { fe("feMergeNode", [("in", .string($0))]) }))
        body = name("merged")
    }
    // Layer blurs, over everything.
    for f in active where f["type"] == "layerBlur" {
        n += 1
        primitives.append(fe("feGaussianBlur", [("in", .string(body)), ("stdDeviation", .number(round3(num(f, "radius") / 2))), ("result", .string(name("body")))]))
        body = name("body")
    }
    // The last primitive is the filter's result; make sure it is the body.
    if primitives.last?.attrs["result"] != .string(body) { primitives.append(fe("feMerge", [], [fe("feMergeNode", [("in", .string(body))])])) }
    let pad = vectorFilterReach(active) + 2
    return VectorRenderFilter(id: id, x: round3(bounds.x - pad), y: round3(bounds.y - pad), width: round3(bounds.width + 2 * pad), height: round3(bounds.height + 2 * pad), primitives: primitives)
}

private func escapeFilterAttr(_ value: String) -> String {
    value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
}

/// `String(v)` of an attribute value.
private func attrText(_ v: JSONValue) -> String { v.stringValue ?? v.numberValue.map(JSONValue.jsNumber) ?? v.stringified() }

private func primitiveMarkup(_ p: VectorFilterPrimitive) -> String {
    let attrs = p.attrs.map { k, v in " \(k)=\"\(escapeFilterAttr(attrText(v)))\"" }.joined()
    if let children = p.children, !children.isEmpty { return "<\(p.tag)\(attrs)>\(children.map(primitiveMarkup).joined())</\(p.tag)>" }
    return "<\(p.tag)\(attrs)/>"
}

/// A render filter as SVG markup (`vectorFilterMarkup`; `extra` is added to the `<filter>` element's attributes).
public func vectorFilterMarkup(_ filter: VectorRenderFilter, _ extra: String = "") -> String {
    "<filter id=\"\(escapeFilterAttr(filter.id))\" filterUnits=\"userSpaceOnUse\" x=\"\(JSONValue.jsNumber(filter.x))\" y=\"\(JSONValue.jsNumber(filter.y))\" width=\"\(JSONValue.jsNumber(filter.width))\" height=\"\(JSONValue.jsNumber(filter.height))\" color-interpolation-filters=\"sRGB\"\(extra)>\(filter.primitives.map(primitiveMarkup).joined())</filter>"
}

// MARK: - Node filters

/// The furthest any drawn stroke layer of a path reaches (`vectorStrokeStackReach`); a brushstroke
/// reaches half its brush size past the path.
func vectorStrokeStackReach(_ node: VectorNode) throws -> Double {
    var reach = 0.0
    for l in vectorPaintLayerNodes(node) where l.kind == "stroke" {
        if l.drawn { reach = JS.max(reach, vectorStrokeReach(l.node)) }
        else if l.layer["visible"] != .bool(false) { reach = JS.max(reach, vectorBrushstrokeReach(l.layer)) }
    }
    return reach
}

/// The box a node paints in its own space, strokes included (`vectorNodeLocalPaintBounds`).
func vectorNodeLocalPaintBounds(_ node: VectorNode) throws -> VectorBounds? {
    let drawn = try expandVectorAppearance(node)
    func reach(_ n: VectorNode) throws -> Double {
        if n.isPath { return try vectorStrokeStackReach(n) }
        if n.isText || n.isInstance { return try reach(try expandVectorAppearance(n)) }
        return try n.children.reduce(0) { JS.max($0, try reach($1)) }
    }
    let box = drawn.isPath ? vectorPathLocalBounds(drawn) : unionBounds(try drawn.children.filter(\.isVisible).map { try vectorNodeBounds($0, IDENTITY_MATRIX) })
    guard let b = box else { return nil }
    let pad = try reach(drawn)
    return VectorBounds(x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad)
}

/// A node's filter as render data with id `id`, or nil when none draws (`vectorNodeFilterSvg`).
public func vectorNodeFilterSvg(_ node: VectorNode, _ id: String) throws -> VectorRenderFilter? {
    guard let n = arrayLength(node["filters"]), n > 0 else { return nil }
    let active = activeVectorFilters(node)
    return active.isEmpty ? nil : vectorFilterSvg(active, id, try vectorNodeLocalPaintBounds(node))
}
