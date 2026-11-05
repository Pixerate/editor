import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// What nodes draw as (`vector/appearance.ts`): path effect stacks, live boolean groups (their
// operands folded bottom to top into one shape in the bottom operand's style), mask groups (their
// contents clipped by the mask, `Mask.swift`), lenses (`Lens.swift`), envelopes (`Warp.swift`) and
// symmetry groups (`Symmetry.swift`). The Extrude and Bevel effects, text, instances and frames
// throw `VectorNotPorted` (#624).

/// A shape a node draws (`VectorAppearanceShape`): the path whose style paints it, its outline in
/// the node's own space, an opacity factor and a draw-order key.
public struct VectorAppearanceShape {
    public var source: VectorNode
    public var path: BezierPath
    public var opacity: Double
    public var order: [Int]
}

/// How operand `child` of a live boolean group combines with the operands below it.
func vectorOperandOperation(_ group: VectorNode, _ child: VectorNode) -> String {
    child["booleanOperation"]?.stringValue ?? group["liveBoolean"]?.stringValue ?? "union"
}

private let PATH_OPS: [String: PathBooleanOperation] = ["union": .union, "subtract": .difference, "intersect": .intersection, "exclude": .xor]

/// One operand of a live boolean: its outline (group space), fill rule and operation.
struct VectorBooleanOperand {
    var path: BezierPath
    var fillRule: PolygonFillRule
    var operation: String
}

/// The result of folding `operands` bottom to top (`foldVectorBooleanOperands`, without its cache).
/// Invalid geometry gives an empty path.
func foldVectorBooleanOperands(_ operands: [VectorBooleanOperand]) throws -> BezierPath {
    if operands.isEmpty { return [] }
    if operands.count == 1 { return operands[0].path }
    var acc = operands[0].path
    var accRule = operands[0].fillRule
    for o in operands.dropFirst() {
        let r = try pathBoolean(PATH_OPS[o.operation] ?? .union, [PathOperand(.commands(acc), fillRule: accRule), PathOperand(.commands(o.path), fillRule: o.fillRule)])
        if r.report.error != nil { return [] }
        acc = r.path
        accRule = .nonzero
    }
    return acc
}

private func fillRuleOf(_ node: VectorNode) -> PolygonFillRule { PolygonFillRule(rawValue: node.fillRule ?? "nonzero") ?? .nonzero }

/// `compareOrder`: element by element, then the shorter first.
private func compareOrder(_ a: [Int], _ b: [Int]) -> Double {
    for i in 0 ..< Swift.min(a.count, b.count) where a[i] != b[i] { return Double(a[i] - b[i]) }
    return Double(a.count - b.count)
}

/// The shapes of a child in its parent's space (hidden children have none), ordered by its index.
func vectorChildAppearanceShapes(_ child: VectorNode, _ index: Int) throws -> [VectorAppearanceShape] {
    if !child.isVisible { return [] }
    if child.isInstance { throw VectorNotPorted("the appearance of instances") }
    let m = child.transform
    let k = child.opacity ?? 1
    return try vectorAppearanceShapes(child).map { s in
        VectorAppearanceShape(source: s.source, path: m.map { !isIdentityMatrix($0) ? transformBezierPath(.commands(s.path), $0.tuple) : s.path } ?? s.path, opacity: s.opacity * k, order: [index] + s.order)
    }
}

/// A live boolean group's result: its operands folded, in the bottom operand's style.
private func liveBooleanShapes(_ group: VectorNode) throws -> [VectorAppearanceShape] {
    var operands: [VectorBooleanOperand] = []
    var source: VectorNode?
    for (i, child) in group.children.enumerated() {
        let shapes = try vectorChildAppearanceShapes(child, i)
        if shapes.isEmpty { continue }
        if source == nil { source = shapes[0].source }
        let path = shapes.count == 1 ? shapes[0].path : try pathBoolean(.union, shapes.map { PathOperand(.commands($0.path), fillRule: fillRuleOf($0.source)) }).path
        let rule = shapes.count == 1 ? fillRuleOf(shapes[0].source) : .nonzero
        operands.append(VectorBooleanOperand(path: path, fillRule: rule, operation: vectorOperandOperation(group, child)))
    }
    guard let source else { return [] }
    return [VectorAppearanceShape(source: source, path: try foldVectorBooleanOperands(operands), opacity: 1, order: [0])]
}

/// What a node's effect stack starts from: its own outline, its live boolean result or its children's shapes.
private func baseShapes(_ node: VectorNode) throws -> [VectorAppearanceShape] {
    if node.isPath { return [VectorAppearanceShape(source: node, path: subpathsToBezier(node.subpaths), opacity: 1, order: [])] }
    if node.isText || node.isInstance { throw VectorNotPorted("the appearance of \(node.typeName) nodes") }
    if truthy(node["liveBoolean"]) { return try liveBooleanShapes(node) }
    // A mask group's effects act on its contents (the mask stays as it is).
    if isVectorMaskGroup(node) { return try node.children.enumerated().flatMap { i, c in i == 0 ? [] : try vectorChildAppearanceShapes(c, i) } }
    return try node.children.enumerated().flatMap { i, c in try vectorChildAppearanceShapes(c, i) }
}

/// Whether the effect takes part (enabled and of a known type).
private func isEnabledEffect(_ e: JSONValue) -> Bool {
    guard let t = e["type"]?.stringValue else { return false }
    return e["enabled"] != .bool(false) && VECTOR_EFFECT_TYPES.contains(t)
}

/// What a node draws as: shapes in its own space (its `transform` and opacity not applied), bottom
/// to top, with its effects and those of everything inside it applied (`vectorAppearanceShapes`).
/// A mask group draws its contents clipped by its mask; a lens its own shape (what it shows is
/// drawn by `vectorLensDrawn`).
public func vectorAppearanceShapes(_ node: VectorNode) throws -> [VectorAppearanceShape] {
    // not ported yet: instances and frames (#624)
    if node.isInstance || isVectorFrame(node) { throw VectorNotPorted("the appearance of \(node.typeName) nodes with frames") }
    // A symmetry group draws as its children and their copies.
    if isVectorSymmetryGroup(node) { return try vectorAppearanceShapes(try vectorSymmetryDrawn(node)) }
    let out = isVectorMaskGroup(node) ? try vectorMaskedShapes(node) : try applyVectorEffects(try baseShapes(node), node["effects"]?.arrayValue)
    return jsSorted(out) { compareOrder($0.order, $1.order) }
}

/// Everything a node draws as one path in its own space (`vectorAppearanceOutline`).
public func vectorAppearanceOutline(_ node: VectorNode) throws -> BezierPath {
    if node.isPath && !hasOwnVectorAppearance(node) { return subpathsToBezier(node.subpaths) }
    return try vectorAppearanceShapes(node).flatMap(\.path)
}

/// Members a shape's source keeps as its style (`shapeNode` drops the rest).
private let SHAPE_NODE_DROPPED: Set<String> = ["id", "type", "subpaths", "transform", "effects", "booleanOperation", "blendStep", "locked", "visible", "opacity", "blendMode", "filters"]

/// A shape as a plain path node in `source`'s style.
private func shapeNode(_ shape: VectorAppearanceShape, _ id: String) -> VectorNode {
    var props = JSONObject()
    for k in shape.source.keys where !SHAPE_NODE_DROPPED.contains(k) { props[k] = shape.source[k] }
    props["id"] = .string(id)
    props["type"] = "path"
    var node = VectorNode(props: props, subpaths: bezierToSubpaths(.commands(shape.path)))
    if shape.opacity < 1 { node.opacity = shape.opacity }
    return node
}

/// The node's own placement and state, kept by its expanded form (`placement`).
private func placement(_ node: VectorNode, into props: inout JSONObject) {
    if let name = node["name"] { props["name"] = name }
    if truthy(node["transform"]) { props["transform"] = node["transform"] }
    if node["visible"] == .bool(false) { props["visible"] = false }
    if truthy(node["locked"]) { props["locked"] = true }
    if truthy(node["blendStep"]) { props["blendStep"] = true }
    if truthy(node["booleanOperation"]) { props["booleanOperation"] = node["booleanOperation"] }
    if truthy(node["blendMode"]) { props["blendMode"] = node["blendMode"] }
    if let n = arrayLength(node["filters"]), n > 0 { props["filters"] = node["filters"] }
}

/// What a node draws as, one plain path per shape (ids `<id>~fx<n>`).
public func vectorAppearanceNodes(_ node: VectorNode) throws -> [VectorNode] {
    try vectorAppearanceShapes(node).enumerated().map { k, s in shapeNode(s, "\(node.id)~fx\(k)") }
}

/// The node as plain geometry: live booleans evaluated into paths (the node itself when nothing
/// inside it is live; `expandVectorAppearance`).
public func expandVectorAppearance(_ node: VectorNode) throws -> VectorNode {
    if !hasVectorAppearance(node) { return node }
    // not ported yet: instances and frames (#624)
    if node.isInstance || isVectorFrame(node) { throw VectorNotPorted("expanding \(node.typeName) nodes with frames") }
    if isVectorSymmetryGroup(node) {
        let drawn = try vectorSymmetryDrawn(node)
        return hasVectorAppearance(drawn) ? try expandVectorAppearance(drawn) : drawn
    }
    if isVectorLens(node) {
        // A lens draws its changed backdrop; its bounds and hits stay its own shape (vectorAppearanceShapes).
        let drawn = try vectorLensDrawn(node)
        return hasVectorAppearance(drawn) ? try expandVectorAppearance(drawn) : drawn
    }
    if !hasOwnVectorAppearance(node) {
        var group = node
        group.children = try node.children.map(expandVectorAppearance)
        return group
    }
    if isVectorMaskGroup(node) {
        // A mask group keeps its mask; its effects act on the contents, wrapped in a group of their own.
        var group = node
        let effects = node["effects"]
        group["effects"] = Optional<JSONValue>.none
        let mask = node.children[0]
        let contents = Array(node.children.dropFirst())
        var wrapperProps = JSONObject([("id", .string("\(node.id)~content")), ("type", "group")])
        if let effects { wrapperProps["effects"] = effects }
        let wrapper = VectorNode(props: wrapperProps, children: contents)
        group.children = [try expandVectorAppearance(mask)] + (contents.isEmpty ? [] : [try expandVectorAppearance(wrapper)])
        return group
    }
    let shapes = try vectorAppearanceShapes(node)
    if node.isPath && shapes.count == 1 {
        let one = shapes[0]
        var rest = node
        rest["effects"] = Optional<JSONValue>.none
        rest["opacity"] = Optional<JSONValue>.none
        let opacity = (node.opacity ?? 1) * one.opacity
        rest.subpaths = bezierToSubpaths(.commands(one.path))
        if opacity < 1 { rest.opacity = opacity }
        return rest
    }
    if node.isText { throw VectorNotPorted("expanding text") }
    var props = JSONObject([("id", .string(node.id)), ("type", "group")])
    placement(node, into: &props)
    if let o = node["opacity"] { props["opacity"] = o }
    return VectorNode(props: props, children: try vectorAppearanceNodes(node))
}

// MARK: - Effect definitions

private func vec(_ x: Double, _ y: Double) -> JSONValue { .object(JSONObject([("x", .number(x)), ("y", .number(y))])) }

/// Default parameters of each effect type (`VECTOR_EFFECT_DEFAULTS`), in the TS key order.
public let VECTOR_EFFECT_DEFAULTS: [String: JSONObject] = [
    "trim": JSONObject([("start", 0), ("end", 50), ("offset", 0), ("mode", "simultaneous")]),
    "roundCorners": JSONObject([("radius", 10)]),
    "puckerBloat": JSONObject([("amount", 30)]),
    "twist": JSONObject([("angle", 45), ("center", vec(0, 0))]),
    "zigzag": JSONObject([("size", 5), ("ridges", 4), ("smooth", false)]),
    "wiggle": JSONObject([("size", 5), ("detail", 6), ("smooth", true), ("speed", 2), ("correlation", 50), ("phase", 0), ("seed", 1), ("time", 0)]),
    "offset": JSONObject([("amount", 5), ("join", "miter"), ("miterLimit", 4), ("copies", 1), ("copyOffset", 0)]),
    "merge": JSONObject([("mode", "add")]),
    "repeater": JSONObject([
        ("copies", 3), ("offset", 0), ("position", vec(100, 0)), ("anchor", vec(0, 0)), ("rotation", 0), ("scale", vec(100, 100)),
        ("startOpacity", 100), ("endOpacity", 100), ("composite", "below"),
    ]),
    "envelope": JSONObject([("style", "arc"), ("bend", 50), ("horizontal", 0), ("vertical", 0), ("orientation", "horizontal"), ("rows", 2), ("columns", 2), ("mesh", .null)]),
    "contour": JSONObject([("direction", "inside"), ("steps", 4), ("offset", 6), ("join", "round"), ("miterLimit", 4), ("fillColor", "#ffffff"), ("strokeColor", .null), ("acceleration", 0)]),
    "blockShadow": JSONObject([("angle", 45), ("distance", 20), ("color", "#1e293b"), ("opacity", 100), ("endOpacity", 100)]),
    "extrude": JSONObject([("mode", "parallel"), ("angle", 45), ("depth", 30), ("vanishingPoint", vec(0, -300)), ("toward", 30), ("color", .null), ("lightAngle", -135), ("shading", 60)]),
    "bevel": JSONObject([("width", 8), ("lightAngle", -135), ("shading", 60), ("color", .null)]),
]

/// `VECTOR_EFFECT_LABELS`.
public let VECTOR_EFFECT_LABELS = [
    "trim": "Trim Paths", "roundCorners": "Round Corners", "puckerBloat": "Pucker & Bloat", "twist": "Twist", "zigzag": "Zig Zag", "wiggle": "Wiggle Paths",
    "offset": "Offset Paths", "merge": "Merge Paths", "repeater": "Repeater", "envelope": "Envelope", "contour": "Contour", "blockShadow": "Block Shadow",
    "extrude": "Extrude", "bevel": "Bevel",
]

/// The warp styles of the Envelope effect (`VECTOR_WARP_STYLES`).
public let VECTOR_WARP_STYLES = ["arc", "arcLower", "arcUpper", "arch", "bulge", "shellLower", "shellUpper", "flag", "wave", "fish", "rise", "fisheye", "inflate", "squeeze", "twist"]

private let JOINS = ["miter", "round", "bevel"]

/// The editable parameters of each effect type, in panel order (`VECTOR_EFFECT_PARAM_SPECS`).
public let VECTOR_EFFECT_PARAM_SPECS: [String: [VectorParamSpec]] = [
    "trim": [.number("start", "Start %", min: 0, max: 100, step: 1), .number("end", "End %", min: 0, max: 100, step: 1), .number("offset", "Offset °", min: -360, max: 360, step: 1), .select("mode", "Paths", ["simultaneous", "individual"])],
    "roundCorners": [.number("radius", "Radius", min: 0, max: 200, step: 1)],
    "puckerBloat": [.number("amount", "Amount %", min: -100, max: 100, step: 1)],
    "twist": [.number("angle", "Angle °", min: -720, max: 720, step: 1), .vec2("center", "Centre")],
    "zigzag": [.number("size", "Size", min: 0, max: 100, step: 0.5), .number("ridges", "Ridges", min: 0, max: 50, step: 1), .boolean("smooth", "Smooth")],
    "wiggle": [
        .number("size", "Size", min: 0, max: 100, step: 0.5), .number("detail", "Detail", min: 0, max: 50, step: 1), .boolean("smooth", "Smooth"),
        .number("correlation", "Correlation %", min: 0, max: 100, step: 1), .number("speed", "Speed", min: 0, step: 0.1), .number("phase", "Phase °", step: 1),
        .number("time", "Time (s)", min: 0, max: 10, step: 0.05), .number("seed", "Seed", step: 1),
    ],
    "offset": [.number("amount", "Amount", min: -100, max: 100, step: 0.5), .select("join", "Join", JOINS), .number("miterLimit", "Miter limit", min: 1, step: 0.5), .number("copies", "Copies", min: 1, max: 20, step: 1), .number("copyOffset", "Copy offset", step: 0.5)],
    "merge": [.select("mode", "Mode", ["merge", "add", "subtract", "intersect", "exclude"])],
    "contour": [
        .select("direction", "Direction", ["inside", "outside", "center"]), .number("steps", "Steps", min: 1, max: 200, step: 1), .number("offset", "Offset", min: 0.1, max: 200, step: 0.5),
        .color("fillColor", "Fill to"), .color("strokeColor", "Stroke to"), .number("acceleration", "Acceleration", min: -100, max: 100, step: 1), .select("join", "Join", JOINS),
    ],
    "blockShadow": [.number("angle", "Angle °", min: -360, max: 360, step: 1), .number("distance", "Distance", min: 0, max: 2000, step: 1), .color("color", "Colour"), .number("opacity", "Opacity %", min: 0, max: 100, step: 1), .number("endOpacity", "End opacity %", min: 0, max: 100, step: 1)],
    "extrude": [
        .select("mode", "Mode", ["parallel", "perspective"]), .number("angle", "Angle °", min: -360, max: 360, step: 1), .number("depth", "Depth", min: 0, max: 2000, step: 1), .vec2("vanishingPoint", "Vanishing point"),
        .number("toward", "Toward VP %", min: 0, max: 100, step: 1), .color("color", "Colour"), .number("lightAngle", "Light °", min: -360, max: 360, step: 1), .number("shading", "Shading %", min: 0, max: 100, step: 1),
    ],
    "bevel": [.number("width", "Width", min: 0, max: 500, step: 0.5), .number("lightAngle", "Light °", min: -360, max: 360, step: 1), .number("shading", "Shading %", min: 0, max: 100, step: 1), .color("color", "Colour")],
    "repeater": [
        .number("copies", "Copies", min: 0, max: 50, step: 0.1), .number("offset", "Offset", min: -10, max: 10, step: 0.1), .vec2("position", "Position"), .vec2("anchor", "Anchor"),
        .number("rotation", "Rotation °", min: -360, max: 360, step: 1), .vec2("scale", "Scale %"), .number("startOpacity", "Start opacity %", min: 0, max: 100, step: 1),
        .number("endOpacity", "End opacity %", min: 0, max: 100, step: 1), .select("composite", "Copies", ["below", "above"]),
    ],
    "envelope": [
        .select("style", "Warp", VECTOR_WARP_STYLES + ["mesh"]), .number("bend", "Bend %", min: -100, max: 100, step: 1), .number("horizontal", "Horizontal distortion %", min: -100, max: 100, step: 1),
        .number("vertical", "Vertical distortion %", min: -100, max: 100, step: 1), .select("orientation", "Orientation", ["horizontal", "vertical"]),
        .number("rows", "Mesh rows", min: 1, max: 16, step: 1), .number("columns", "Mesh columns", min: 1, max: 16, step: 1),
    ],
]

private func isVec2(_ v: JSONValue) -> Bool {
    guard let x = v["x"]?.numberValue, let y = v["y"]?.numberValue else { return false }
    return x.isFinite && y.isFinite
}

/// Effect parameters with defaults (or `base`) filled in and invalid values dropped (unknown keys
/// go too). Nil for an unknown type (`normalizeVectorEffectParams`). An envelope keeps a valid
/// mesh only in the `mesh` style, resized to its rows and columns (a given mesh sets them).
public func normalizeVectorEffectParams(_ type: String, _ params: JSONObject?, _ base: JSONObject? = nil) throws -> JSONObject? {
    guard var out = VECTOR_EFFECT_DEFAULTS[type], let specs = VECTOR_EFFECT_PARAM_SPECS[type] else { return nil }
    for (k, v) in base ?? JSONObject() { out[k] = v }
    for spec in specs {
        guard let v = params?[spec.key] else { continue }
        switch spec.kind {
        case .number:
            if let n = v.numberValue, n.isFinite { out[spec.key] = .number(JS.min(spec.max ?? .infinity, JS.max(spec.min ?? -.infinity, n))) }
        case .boolean:
            if let b = v.boolValue { out[spec.key] = .bool(b) }
        case .vec2:
            if isVec2(v) { out[spec.key] = vec(v["x"]!.numberValue!, v["y"]!.numberValue!) }
        case .select:
            if let s = v.stringValue, spec.options.contains(s) { out[spec.key] = v }
        case .color:
            if v == .null || (v.stringValue.map { parseVectorColor($0) != nil } ?? false) { out[spec.key] = v }
        }
    }
    if type == "envelope" {
        out["rows"] = .number(JS.round(out["rows"]?.numberValue ?? .nan))
        out["columns"] = .number(JS.round(out["columns"]?.numberValue ?? .nan))
        let given = params?["mesh"]
        var mesh: VectorWarpMesh? = given != nil ? VectorWarpMesh(json: given) : VectorWarpMesh(json: out["mesh"])
        if out["style"] != "mesh" { mesh = nil }
        if let m = mesh, given != nil {
            out["columns"] = .number(Double(m.us.count - 1))
            out["rows"] = .number(Double(m.vs.count - 1))
        } else if let m = mesh {
            mesh = resizeVectorMesh(m, out["columns"]?.numberValue ?? .nan, out["rows"]?.numberValue ?? .nan)
        }
        out["mesh"] = mesh?.json ?? .null
    }
    return out
}

/// A new effect of `type` (defaults merged with `params`), or nil for an unknown type (`createVectorEffect`).
public func createVectorEffect(_ type: String, _ id: String, _ params: JSONObject? = nil) throws -> JSONObject? {
    guard let p = try normalizeVectorEffectParams(type, params) else { return nil }
    return JSONObject([("id", .string(id)), ("type", .string(type)), ("params", .object(p))])
}

/// The node's effects that take part (`activeVectorEffects`).
public func activeVectorEffects(_ node: VectorNode) -> [JSONValue] {
    node["effects"]?.arrayValue?.filter(isEnabledEffect) ?? []
}

/// Effects from untrusted data: unknown types and malformed entries dropped, parameters
/// normalized, ids made unique (`sanitizeVectorEffects`).
public func sanitizeVectorEffects(_ value: JSONValue?) throws -> [JSONObject] {
    guard let list = value?.arrayValue else { return [] }
    var out: [JSONObject] = []
    var used = Set<String>()
    for raw in list {
        guard let r = raw.objectValue, let type = r["type"]?.stringValue, VECTOR_EFFECT_DEFAULTS[type] != nil else { continue }
        var id = ""
        if let s = r["id"]?.stringValue, !s.isEmpty, !used.contains(s) { id = s }
        var k = out.count + 1
        while id.isEmpty {
            if !used.contains("fx\(k)") { id = "fx\(k)" }
            k += 1
        }
        used.insert(id)
        var effect = try createVectorEffect(type, id, r["params"]?.objectValue ?? JSONObject())!
        if r["enabled"] == .bool(false) { effect["enabled"] = false }
        out.append(effect)
    }
    return out
}

/// Effect parameters carried through a linear map baked into a node's geometry
/// (`transformVectorEffects`): offsets and positions move with it, angles turn the other way when
/// it mirrors. An envelope mesh maps like the geometry; a preset follows a move or a scale by
/// itself, and a skew or a mirror turns it into the mesh it stands for over `node`'s contents.
public func transformVectorEffects(_ effects: [JSONValue], _ m: VectorMatrix, _ node: VectorNode? = nil) throws -> [JSONValue] {
    func lin(_ v: JSONValue?) -> JSONValue {
        let x = v?["x"]?.numberValue ?? .nan, y = v?["y"]?.numberValue ?? .nan
        return vec(m.a * x + m.c * y, m.b * x + m.d * y)
    }
    let full = { (v: Vec2) in applyMatrix(m, v) }
    let mirror: Double = m.a * m.d - m.b * m.c < 0 ? -1 : 1
    let axisScale = abs(m.b) < 1e-12 && abs(m.c) < 1e-12 && m.a > 0 && m.d > 0
    return try effects.map { e in
        guard var o = e.objectValue, var params = o["params"]?.objectValue else { return e }
        switch o["type"]?.stringValue {
        case "envelope":
            if params["style"] == "mesh" {
                guard let mesh = VectorWarpMesh(json: params["mesh"]) else { return e }
                params["mesh"] = mapVectorMeshPoints(mesh, full).json
                break
            }
            guard !axisScale, let node, let id = o["id"]?.stringValue else { return e }
            guard let bounds = try vectorEffectInputBounds(node, id), vectorEnvelopeMap(params, bounds) != nil else { return e }
            let mesh = mapVectorMeshPoints(vectorEnvelopeMesh(params, bounds), full)
            params["style"] = "mesh"
            params["mesh"] = mesh.json
        case "twist":
            params["center"] = lin(params["center"])
            params["angle"] = .number((params["angle"]?.numberValue ?? .nan) * mirror)
        case "repeater":
            params["position"] = lin(params["position"])
            params["anchor"] = lin(params["anchor"])
            params["rotation"] = .number((params["rotation"]?.numberValue ?? .nan) * mirror)
        default:
            return e
        }
        o["params"] = .object(params)
        return .object(o)
    }
}

// MARK: - Envelopes

/**
 * The envelope's mesh over `bounds` (the paths' combined bounds), in the node's space
 * (`vectorEnvelopeMesh`): its own mesh, the flat mesh of `columns × rows` patches, or a preset
 * split exactly into that many patches.
 */
public func vectorEnvelopeMesh(_ params: JSONObject, _ bounds: VectorBounds) -> VectorWarpMesh {
    let columns = params["columns"]?.numberValue ?? .nan
    let rows = params["rows"]?.numberValue ?? .nan
    if params["style"] == "mesh" { return VectorWarpMesh(json: params["mesh"]) ?? vectorIdentityMesh(bounds, columns, rows) }
    guard let preset = vectorWarpPresetMesh(params, bounds) else { return vectorIdentityMesh(bounds, columns, rows) }
    return resizeVectorMesh(preset, columns, rows)
}

/// The envelope as a map of the node's space over `bounds`, or nil when it changes nothing (or the
/// box is empty; `vectorEnvelopeMap`).
public func vectorEnvelopeMap(_ params: JSONObject, _ bounds: VectorBounds?) -> ((Vec2) -> Vec2)? {
    guard let bounds, bounds.width > 0 && bounds.height > 0 else { return nil }
    guard let mesh = params["style"] == "mesh" ? VectorWarpMesh(json: params["mesh"]) : vectorWarpPresetMesh(params, bounds) else { return nil }
    let (x, y, width, height) = (bounds.x, bounds.y, bounds.width, bounds.height)
    return { p in evalVectorMesh(mesh, (p.x - x) / width, (p.y - y) / height) }
}

/// Combined bounds of paths (`pathsBounds`).
private func pathsBounds(_ paths: [BezierPath]) -> VectorBounds? {
    var minX = Double.infinity, minY = Double.infinity, maxX = -Double.infinity, maxY = -Double.infinity
    for p in paths {
        guard let b = bezierPathBounds(.commands(p)) else { continue }
        minX = JS.min(minX, b.minX)
        minY = JS.min(minY, b.minY)
        maxX = JS.max(maxX, b.maxX)
        maxY = JS.max(maxY, b.maxY)
    }
    return minX <= maxX ? VectorBounds(x: minX, y: minY, width: maxX - minX, height: maxY - minY) : nil
}

/// The paths through an envelope, each mapped adaptively within a tolerance relative to their size (`envelopePaths`).
private func envelopePaths(_ paths: [BezierPath], _ params: JSONObject) -> [BezierPath] {
    let bounds = pathsBounds(paths)
    guard let f = vectorEnvelopeMap(params, bounds), let bounds else { return paths }
    let tol = JS.min(0.25, JS.max(0.01, JS.hypot(bounds.width, bounds.height) / 2000))
    return paths.map { $0.isEmpty ? $0 : mapBezierPath($0, f, tol) }
}

/// The paths entering effect `effectId` of the node's stack (those above it applied), in the
/// node's own space (`vectorEffectInputPaths`).
public func vectorEffectInputPaths(_ node: VectorNode, _ effectId: String) throws -> [BezierPath]? {
    let list = node["effects"]?.arrayValue ?? []
    guard let i = list.firstIndex(where: { $0["id"]?.stringValue == effectId }) else { return nil }
    return try applyVectorEffects(try baseShapes(node), Array(list[..<i])).map(\.path)
}

/// The box effect `effectId` (an envelope) bends: the combined bounds of the paths entering it, in
/// the node's own space (`vectorEffectInputBounds`).
public func vectorEffectInputBounds(_ node: VectorNode, _ effectId: String) throws -> VectorBounds? {
    try vectorEffectInputPaths(node, effectId).flatMap(pathsBounds)
}

/// The node's first enabled envelope effect, or nil (`vectorNodeEnvelope`).
public func vectorNodeEnvelope(_ node: VectorNode?) -> JSONObject? {
    node?["effects"]?.arrayValue?.first { $0["type"] == "envelope" && $0["enabled"] != .bool(false) }?.objectValue
}

/// The editable mesh of a node's envelope (its own mesh, or the preset or flat mesh it stands for)
/// with the box it bends, in the node's own space; nil without an envelope or contents (`vectorEnvelopeFrame`).
public func vectorEnvelopeFrame(_ node: VectorNode, _ effectId: String? = nil) throws -> (effectId: String, bounds: VectorBounds, mesh: VectorWarpMesh)? {
    let e = effectId.map { id in node["effects"]?.arrayValue?.first { $0["id"]?.stringValue == id }?.objectValue } ?? vectorNodeEnvelope(node)
    guard let e, e["type"] == "envelope", let id = e["id"]?.stringValue else { return nil }
    guard let bounds = try vectorEffectInputBounds(node, id), bounds.width > 0 && bounds.height > 0 else { return nil }
    return (id, bounds, vectorEnvelopeMesh(e["params"]?.objectValue ?? JSONObject(), bounds))
}

// MARK: - The effect stack

/// Every path operator maps the shapes' paths one to one (`mapPaths`).
private func mapPaths(_ shapes: [VectorAppearanceShape], _ fn: ([BezierPath]) throws -> [BezierPath]) rethrows -> [VectorAppearanceShape] {
    let out = try fn(shapes.map(\.path))
    return shapes.enumerated().map { i, s in
        var c = s
        c.path = i < out.count ? out[i] : []
        return c
    }
}

private func addVec(_ a: Vec2, _ b: JSONValue?) -> Vec2 { Vec2(a.x + (b?["x"]?.numberValue ?? 0), a.y + (b?["y"]?.numberValue ?? 0)) }

/// A paint blended toward `to` by `t` (only solid colours blend; gradients and a null `to` keep it).
private func blendPaint(_ from: JSONValue?, _ to: JSONValue?, _ t: Double) -> JSONValue? {
    guard let toColor = to?.stringValue, let fromColor = from?.stringValue else { return from }
    guard let a = parseVectorColor(fromColor), let b = parseVectorColor(toColor) else { return from }
    func h(_ v: Double) -> String {
        let n = Int(JS.round(JS.min(1, JS.max(0, v)) * 255))
        return (n < 16 ? "0" : "") + String(n, radix: 16)
    }
    let m = (0 ..< 3).map { k in a[k] + (b[k] - a[k]) * t }
    return .string("#\(h(m[0]))\(h(m[1]))\(h(m[2]))")
}

/// A shape source with only a solid fill and stroke (`{ ...source, fill, stroke, fills: undefined, strokes: undefined }`).
private func restyled(_ source: VectorNode, fill: JSONValue?, stroke: JSONValue?) -> VectorNode {
    var s = source
    s["fill"] = fill ?? .null
    s["stroke"] = stroke ?? .null
    s["fills"] = Optional<JSONValue>.none
    s["strokes"] = Optional<JSONValue>.none
    return s
}

/// The contour steps of each shape (`contourShapes`): offset copies `offset` apart, their colours
/// blended toward the end colours, drawn over the shape inside and under it outside.
private func contourShapes(_ shapes: [VectorAppearanceShape], _ c: JSONObject) throws -> [VectorAppearanceShape] {
    func num(_ k: String) -> Double { c[k]?.numberValue ?? .nan }
    var out: [VectorAppearanceShape] = []
    let step = JS.max(0.01, num("offset"))
    let outside = c["direction"] == "outside"
    for s in shapes {
        var n = Int(JS.min(200, JS.max(1, JS.round(num("steps")))))
        if c["direction"] == "center" {
            if let b = bezierPathBounds(.commands(s.path)) {
                n = Int(JS.min(200, JS.max(1, JS.ceil(JS.min(b.maxX - b.minX, b.maxY - b.minY) / 2 / step))))
            } else {
                n = 0
            }
        }
        // The original: on top outside, at the bottom inside.
        var original = s
        original.order = [outside ? n : 0] + s.order
        out.append(original)
        // Colour progress per step, bunched by the acceleration.
        let power = pow(2, JS.min(100, JS.max(-100, num("acceleration"))) / 50)
        if n < 1 { continue }
        for k in 1 ... n {
            let path = try offsetPaths([s.path], (outside ? 1 : -1) * step * Double(k), c["join"]?.stringValue ?? "round", num("miterLimit"), 1, 0).first ?? []
            if path.isEmpty { break }
            let t = pow(Double(k) / Double(n), power)
            let source = restyled(s.source, fill: blendPaint(s.source.fill, c["fillColor"], t), stroke: blendPaint(s.source.stroke, c["strokeColor"], t))
            out.append(VectorAppearanceShape(source: source, path: path, opacity: s.opacity, order: [outside ? n - k : k] + s.order))
        }
    }
    return out
}

/// The block shadow of each shape (`blockShadowShapes`): the shape swept `distance` along `angle`,
/// filled with the shadow colour (a gradient toward `endOpacity` when it fades), under every shape.
private func blockShadowShapes(_ shapes: [VectorAppearanceShape], _ b: JSONObject) throws -> [VectorAppearanceShape] {
    func num(_ k: String) -> Double { b[k]?.numberValue ?? .nan }
    let rad = (num("angle") * Double.pi) / 180
    let u = Vec2(JS.cos(rad), JS.sin(rad))
    let distance = JS.max(0, num("distance"))
    var shadows: [VectorAppearanceShape] = []
    for s in shapes {
        let ownFill = s.source.fill?.stringValue.flatMap { $0 != "none" ? $0 : nil }
        let color = b["color"]?.stringValue ?? ownFill ?? "#000000"
        let path = try sweepPath(s.path, u.x * distance, u.y * distance, s.source.fillRule == "evenodd" ? .evenodd : .nonzero)
        guard !path.isEmpty, let box = bezierPathBounds(.commands(s.path)) else { continue }
        var fill: JSONValue = .string(color)
        let near = JS.min(100, JS.max(0, num("opacity")))
        let far = JS.min(100, JS.max(0, num("endOpacity")))
        let top = JS.max(near, far)
        if near != far && distance > 0 {
            // From the near side of the shape to the far end of the shadow.
            let along = [box.minX * u.x + box.minY * u.y, box.maxX * u.x + box.minY * u.y, box.minX * u.x + box.maxY * u.y, box.maxX * u.x + box.maxY * u.y]
            let t0 = along.reduce(Double.infinity) { JS.min($0, $1) }
            let t1 = along.reduce(-Double.infinity) { JS.max($0, $1) } + distance
            let c = Vec2((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2)
            let k = c.x * u.x + c.y * u.y
            fill = .object(JSONObject([
                ("type", "linear"), ("units", "userSpaceOnUse"),
                ("start", Vec2(c.x + u.x * (t0 - k), c.y + u.y * (t0 - k)).json), ("end", Vec2(c.x + u.x * (t1 - k), c.y + u.y * (t1 - k)).json),
                ("stops", [["offset": 0, "color": .string(color), "opacity": .number(near / top)], ["offset": 1, "color": .string(color), "opacity": .number(far / top)]]),
            ]))
        }
        var source = restyled(s.source, fill: fill, stroke: .null)
        source["fillRule"] = "nonzero"
        shadows.append(VectorAppearanceShape(source: source, path: path, opacity: (s.opacity * top) / 100, order: [0] + s.order))
    }
    return shadows + shapes.map { s in
        var c = s
        c.order = [1] + s.order
        return c
    }
}

/// Applies an effect stack to shapes, top to bottom (disabled effects skipped; `applyVectorEffects`).
public func applyVectorEffects(_ shapes: [VectorAppearanceShape], _ effects: [JSONValue]?) throws -> [VectorAppearanceShape] {
    var list = shapes
    for e in effects ?? [] {
        if !isEnabledEffect(e) || list.isEmpty { continue }
        let p = e["params"]?.objectValue ?? JSONObject()
        func num(_ k: String) -> Double { p[k]?.numberValue ?? .nan }
        switch e["type"]?.stringValue {
        case "trim":
            let individual = p["mode"] == "individual"
            list = mapPaths(list) { individual ? trimPathsIndividually($0, num("start"), num("end"), num("offset")) : trimPaths($0, num("start"), num("end"), num("offset")) }
        case "roundCorners":
            list = mapPaths(list) { roundCornerPaths($0, num("radius")) }
        case "puckerBloat":
            list = mapPaths(list) { puckerBloatPaths($0, num("amount")) }
        case "twist":
            list = mapPaths(list) { twistPaths($0, num("angle"), addVec(pathsCenter($0), p["center"])) }
        case "zigzag":
            list = mapPaths(list) { zigzagPaths($0, num("size"), num("ridges"), p["smooth"]?.boolValue ?? false) }
        case "wiggle":
            let w = VectorWiggleParams(size: num("size"), detail: num("detail"), smooth: p["smooth"]?.boolValue ?? false, speed: num("speed"), correlation: num("correlation"), phase: num("phase"), seed: num("seed"), time: num("time"))
            list = mapPaths(list) { wigglePaths($0, w) }
        case "offset":
            list = try mapPaths(list) { try offsetPaths($0, num("amount"), p["join"]?.stringValue ?? "miter", num("miterLimit"), num("copies"), num("copyOffset")) }
        case "merge":
            var first = list[0]
            first.path = try mergePaths(list.map(\.path), p["mode"]?.stringValue ?? "merge")
            list = [first]
        case "contour":
            list = try contourShapes(list, p)
        case "blockShadow":
            list = try blockShadowShapes(list, p)
        case "envelope":
            list = mapPaths(list) { envelopePaths($0, p) }
        case "repeater":
            let copies = repeatPaths(list.map(\.path), p, addVec(pathsCenter(list.map(\.path)), p["anchor"]))
            let n = copies.count
            var next: [VectorAppearanceShape] = []
            for (copy, paths) in copies {
                // Below: each copy draws under the one before it (the original on top).
                let rank = p["composite"] == "above" ? copy.index : n - 1 - copy.index
                for (i, s) in list.enumerated() { next.append(VectorAppearanceShape(source: s.source, path: paths[i], opacity: s.opacity * copy.opacity, order: [rank] + s.order)) }
            }
            list = next
        case let type?:
            // not ported yet: Extrude and Bevel (#624)
            throw VectorNotPorted("the \(VECTOR_EFFECT_LABELS[type] ?? type) effect")
        case nil:
            break
        }
    }
    return list
}
