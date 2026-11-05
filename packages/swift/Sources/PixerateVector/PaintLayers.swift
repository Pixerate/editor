import Foundation
import PixerateCore
import PixerateGeometry

// Fill and stroke stacks (`vector/paintLayers.ts`): several paints per path, each with its own
// opacity, blend mode and visibility, and each stroke with its own settings. The stacks live in
// `fills` / `strokes`, bottom to top; `fill` / `stroke` (and the stroke settings) mirror their top
// layers. Layers are JSON objects (`{ paint, opacity?, blendMode?, visible?, …settings }`), so
// their key order is the TS order. Brushstroke layers throw `VectorNotPorted` (#624).

/// The stroke settings each stroke layer has of its own (`VECTOR_STROKE_SETTING_KEYS`).
public let VECTOR_STROKE_SETTING_KEYS = ["strokeWidth", "strokeLinecap", "strokeLinejoin", "strokeDasharray", "strokeAlign", "startArrow", "endArrow", "arrowAlign", "startArrowScale", "endArrowScale", "strokeWidthProfile"]

/// `VECTOR_BLEND_MODES`.
public let VECTOR_BLEND_MODES = ["normal", "darken", "multiply", "color-burn", "lighten", "screen", "color-dodge", "linear-dodge", "overlay", "soft-light", "hard-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"]

/// `VECTOR_ARROWHEADS`.
public let VECTOR_ARROWHEADS = ["triangle", "arrow", "open", "circle", "square", "bar"]

public func isVectorBlendMode(_ value: JSONValue?) -> Bool {
    guard let s = value?.stringValue else { return false }
    return VECTOR_BLEND_MODES.contains(s)
}

/// A blend mode as a CSS `mix-blend-mode` value, or nil for `normal` (`vectorBlendModeCss`).
public func vectorBlendModeCss(_ mode: JSONValue?) -> String? {
    guard let m = mode?.stringValue, m != "normal", VECTOR_BLEND_MODES.contains(m) else { return nil }
    return m == "linear-dodge" ? "plus-lighter" : m
}

/// A CSS `mix-blend-mode` value back to a blend mode (`vectorBlendModeFromCss`).
public func vectorBlendModeFromCss(_ value: String?) -> String? {
    let v = (value ?? "").jsTrimmed.jsLowercased
    if v == "plus-lighter" { return "linear-dodge" }
    return VECTOR_BLEND_MODES.contains(v) ? v : nil
}

/// `JSON.stringify(v ?? null)`.
@inline(__always) private func json(_ v: JSONValue?) -> String { (v ?? .null).stringified() }

/// A layer the shorthand alone can say: full opacity, normal blending, visible, a plain paint.
public func isPlainVectorPaintLayer(_ layer: JSONObject) -> Bool {
    (layer["opacity"]?.numberValue ?? 1) >= 1 && (layer["blendMode"]?.stringValue ?? "normal") == "normal" && layer["visible"] != .bool(false)
        && (layer["kind"]?.stringValue ?? "paint") == "paint"
}

/// Whether a layer is drawn: visible, a plain paint, a paint that draws something, above zero opacity.
public func isDrawnVectorPaintLayer(_ layer: JSONObject) -> Bool {
    layer["visible"] != .bool(false) && (layer["kind"]?.stringValue ?? "paint") == "paint" && hasPaint(layer["paint"]) && (layer["opacity"]?.numberValue ?? 1) > 0
}

private func layers(_ v: JSONValue?) -> [JSONObject]? {
    v?.arrayValue?.map { $0.objectValue ?? JSONObject() }
}

/// The fill stack, bottom to top: `fills`, or the one layer `fill` makes.
public func vectorFills(_ node: VectorNode) -> [JSONObject] {
    if let list = layers(node["fills"]) { return list }
    return hasPaint(node.fill) ? [JSONObject([("paint", node.fill!)])] : []
}

/// The stroke settings a style gives its shorthand stroke (only those set), from a node or layer.
public func vectorStrokeSettings(_ get: (String) -> JSONValue?) -> JSONObject {
    var out = JSONObject()
    for key in VECTOR_STROKE_SETTING_KEYS {
        if let v = get(key), v != .null { out[key] = v }
    }
    return out
}

/// The stroke stack, bottom to top: `strokes`, or the one layer `stroke` and the settings make.
public func vectorStrokes(_ node: VectorNode) -> [JSONObject] {
    if let list = layers(node["strokes"]) { return list }
    guard hasPaint(node.stroke) else { return [] }
    var layer = JSONObject([("paint", node.stroke!)])
    for (k, v) in vectorStrokeSettings({ node[$0] }) { layer[k] = v }
    return [layer]
}

/// Whether a node stores a stack (`hasVectorPaintStacks`).
public func hasVectorPaintStacks(_ node: VectorNode) -> Bool {
    node["fills"]?.arrayValue != nil || node["strokes"]?.arrayValue != nil
}

/// The node with `fills` as its fill stack, stored canonically (`withVectorFills`).
public func withVectorFills(_ node: VectorNode, _ fills: [JSONObject]) -> VectorNode {
    var next = node
    if fills.isEmpty || (fills.count == 1 && isPlainVectorPaintLayer(fills[0])) {
        next["fills"] = Optional<JSONValue>.none
        next["fill"] = fills.first?["paint"] ?? .null
        return next
    }
    next["fills"] = .array(fills.map { .object($0) })
    next["fill"] = fills[fills.count - 1]["paint"] ?? .null
    return next
}

/// The node with `strokes` as its stroke stack, stored canonically (`withVectorStrokes`).
public func withVectorStrokes(_ node: VectorNode, _ strokes: [JSONObject]) -> VectorNode {
    var next = node
    guard let top = strokes.last else {
        // The settings stay, for a stroke added later through the shorthand.
        next["strokes"] = Optional<JSONValue>.none
        next["stroke"] = .null
        return next
    }
    for key in VECTOR_STROKE_SETTING_KEYS { next[key] = Optional<JSONValue>.none }
    for (k, v) in vectorStrokeSettings({ top[$0] }) { next[k] = v }
    next["stroke"] = top["paint"] ?? .null
    if strokes.count == 1 && isPlainVectorPaintLayer(top) { next["strokes"] = Optional<JSONValue>.none }
    else { next["strokes"] = .array(strokes.map { .object($0) }) }
    return next
}

/// The stroke fields of `node` that differ from what its top stroke layer says.
private func strokeShorthandDiff(_ node: VectorNode, _ top: JSONObject?) -> [String] {
    var out: [String] = []
    if json(node.stroke) != json(top?["paint"]) { out.append("stroke") }
    for key in VECTOR_STROKE_SETTING_KEYS where json(node[key]) != json(top?[key]) { out.append(key) }
    return out
}

/// A node with its stacks and shorthands reconciled and stored canonically (the node itself when
/// they already are; `normalizeVectorPaintStacks`). `prefer: "stack"` (loading) re-derives the
/// shorthand; `"shorthand"` (after an edit) reads a shorthand that disagrees with its top layer as
/// an edit of that layer.
public func normalizeVectorPaintStacks(_ node: VectorNode, prefer: String = "shorthand") -> VectorNode {
    if !hasVectorPaintStacks(node) {
        if !node.has("fills") && !node.has("strokes") { return node }
        // `fills: null` / `strokes: null`: no stack.
        var next = node
        next["fills"] = Optional<JSONValue>.none
        next["strokes"] = Optional<JSONValue>.none
        return next
    }
    var next = node
    if let stack = layers(node["fills"]) {
        var fills = stack
        let top = fills.last
        if prefer == "shorthand" && json(node.fill) != json(top?["paint"]) {
            if !hasPaint(node.fill) { fills = [] }
            else if var t = top {
                t["paint"] = node.fill!
                fills = Array(fills.dropLast()) + [t]
            } else { fills = [JSONObject([("paint", node.fill!)])] }
        }
        next = withVectorFills(next, fills)
    }
    if let stack = layers(node["strokes"]) {
        var strokes = stack
        let top = strokes.last
        let diff = prefer == "shorthand" ? strokeShorthandDiff(node, top) : []
        if !diff.isEmpty {
            if diff.contains("stroke") && !hasPaint(node.stroke) { strokes = [] }
            else {
                var layer = top ?? JSONObject([("paint", node.stroke ?? .null)])
                for key in diff {
                    if key == "stroke" { layer["paint"] = node.stroke ?? .null }
                    else if node[key] == nil || node[key] == .null { layer[key] = Optional<JSONValue>.none }
                    else { layer[key] = node[key]! }
                }
                strokes = top != nil ? Array(strokes.dropLast()) + [layer] : [layer]
            }
        }
        next = withVectorStrokes(next, strokes)
    }
    let keys = ["fill", "fills", "stroke", "strokes"] + VECTOR_STROKE_SETTING_KEYS
    let same = keys.allSatisfy { k in next.has(k) == node.has(k) && json(next[k]) == json(node[k]) }
    return same ? node : next
}

// MARK: - Sanitizing

private func sanitizePaint(_ value: JSONValue?) throws -> JSONValue {
    guard let value, value != .null else { return .null }
    if case .string = value { return value }
    // not ported yet: mesh and freeform gradients (sanitizeVectorShadedPaint) (#624)
    if let t = value["type"]?.stringValue, t == "mesh" || t == "freeform" { throw VectorNotPorted("mesh and freeform gradients") }
    return sanitizeVectorGradient(value).map { .object($0) } ?? .null
}

private func sanitizeLayerBase(_ raw: JSONObject) throws -> JSONObject {
    var out = JSONObject([("paint", try sanitizePaint(raw["paint"]))])
    if let o = raw["opacity"]?.numberValue, o.isFinite, o < 1 { out["opacity"] = .number(Swift.max(0, o)) }
    if isVectorBlendMode(raw["blendMode"]), raw["blendMode"] != "normal" { out["blendMode"] = raw["blendMode"]! }
    if raw["visible"] == .bool(false) { out["visible"] = false }
    return out
}

/// A fill stack from untrusted data (`sanitizeVectorFills`): malformed layers are dropped.
public func sanitizeVectorFills(_ value: JSONValue?) throws -> [JSONObject] {
    guard let list = value?.arrayValue else { return [] }
    return try list.compactMap(\.objectValue).map(sanitizeLayerBase)
}

/// Stroke settings from untrusted data (`sanitizeVectorStrokeSettings`).
public func sanitizeVectorStrokeSettings(_ raw: JSONObject) throws -> JSONObject {
    var out = JSONObject()
    func num(_ v: JSONValue?) -> Double? { v?.numberValue.flatMap { $0.isFinite ? $0 : nil } }
    if let w = num(raw["strokeWidth"]), w >= 0 { out["strokeWidth"] = .number(w) }
    if let v = raw["strokeLinecap"]?.stringValue, ["butt", "round", "square"].contains(v) { out["strokeLinecap"] = .string(v) }
    if let v = raw["strokeLinejoin"]?.stringValue, ["miter", "round", "bevel"].contains(v) { out["strokeLinejoin"] = .string(v) }
    if let list = raw["strokeDasharray"]?.arrayValue {
        let dash = list.compactMap(\.numberValue).filter { $0.isFinite && $0 >= 0 }
        if !dash.isEmpty && dash.contains(where: { $0 > 0 }) { out["strokeDasharray"] = .array(dash.map { .number($0) }) }
    }
    if let v = raw["strokeAlign"]?.stringValue, ["center", "inside", "outside"].contains(v) { out["strokeAlign"] = .string(v) }
    for key in ["startArrow", "endArrow"] { if let v = raw[key]?.stringValue, VECTOR_ARROWHEADS.contains(v) { out[key] = .string(v) } }
    if let v = raw["arrowAlign"]?.stringValue, ["extend", "tip"].contains(v) { out["arrowAlign"] = .string(v) }
    for key in ["startArrowScale", "endArrowScale"] { if let n = num(raw[key]), n > 0 { out[key] = .number(n) } }
    // not ported yet: width profiles (sanitizeWidthProfile) (#624)
    if let p = raw["strokeWidthProfile"]?.arrayValue, !p.isEmpty { throw VectorNotPorted("width profiles") }
    return out
}

/// A stroke stack from untrusted data (`sanitizeVectorStrokes`). Layers of a kind this version
/// does not know are kept as they are.
public func sanitizeVectorStrokes(_ value: JSONValue?) throws -> [JSONObject] {
    guard let list = value?.arrayValue else { return [] }
    return try list.compactMap(\.objectValue).map { raw in
        // not ported yet: brushstroke layers (sanitizeVectorBrushstroke) (#624)
        if raw["kind"] == "brushstroke" { throw VectorNotPorted("brushstroke layers") }
        if let kind = raw["kind"], kind != "paint" { return raw }
        var out = try sanitizeLayerBase(raw)
        for (k, v) in try sanitizeVectorStrokeSettings(raw) { out[k] = v }
        return out
    }
}

// MARK: - Layer nodes

/// One layer of a path's paint as a plain path node (`VectorPaintLayerNode`).
public struct VectorPaintLayerNode {
    /// `fill` or `stroke`.
    public var kind: String
    /// Index in its stack, bottom to top.
    public var index: Int
    public var layer: JSONObject
    /// The path with only this fill, or only this stroke and its settings (no stacks).
    public var node: VectorNode
    /// Visible, a plain paint, painting something, above zero opacity.
    public var drawn: Bool
}

/// Every fill then every stroke of a path, bottom to top, each as the path painted by that layer
/// alone (`vectorPaintLayerNodes`).
public func vectorPaintLayerNodes(_ node: VectorNode) -> [VectorPaintLayerNode] {
    var plain = node
    plain["fills"] = Optional<JSONValue>.none
    plain["strokes"] = Optional<JSONValue>.none
    for key in VECTOR_STROKE_SETTING_KEYS { plain[key] = Optional<JSONValue>.none }
    var out: [VectorPaintLayerNode] = []
    for (i, layer) in vectorFills(node).enumerated() {
        var n = plain
        n["fill"] = layer["paint"] ?? .null
        n["stroke"] = .null
        out.append(VectorPaintLayerNode(kind: "fill", index: i, layer: layer, node: n, drawn: isDrawnVectorPaintLayer(layer)))
    }
    for (i, layer) in vectorStrokes(node).enumerated() {
        var n = plain
        n["fill"] = .null
        if (layer["kind"]?.stringValue ?? "paint") == "paint" { for (k, v) in vectorStrokeSettings({ layer[$0] }) { n[k] = v } }
        n["stroke"] = layer["paint"] ?? .null
        out.append(VectorPaintLayerNode(kind: "stroke", index: i, layer: layer, node: n, drawn: isDrawnVectorPaintLayer(layer)))
    }
    return out
}

/// Whether a path draws through its stacks rather than one fill and one stroke (`needsVectorPaintLayers`).
public func needsVectorPaintLayers(_ node: VectorNode) -> Bool {
    if !hasVectorPaintStacks(node) { return false }
    let fills = vectorFills(node)
    let strokes = vectorStrokes(node)
    return fills.count > 1 || strokes.count > 1 || fills.contains { !isPlainVectorPaintLayer($0) } || strokes.contains { !isPlainVectorPaintLayer($0) }
}
