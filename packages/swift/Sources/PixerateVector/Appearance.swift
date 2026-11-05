import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// What nodes draw as (`vector/appearance.ts`), for live boolean groups: their operands folded
// bottom to top into one shape in the bottom operand's style. Path effects, text, instances,
// frames, symmetry groups, lenses and mask groups throw `VectorNotPorted` (#624).

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
    if isVectorMaskGroup(node) { throw VectorNotPorted("the appearance of mask groups") }
    return try node.children.enumerated().flatMap { i, c in try vectorChildAppearanceShapes(c, i) }
}

/// Whether the effect takes part (enabled and of a known type).
private func isEnabledEffect(_ e: JSONValue) -> Bool {
    guard let t = e["type"]?.stringValue else { return false }
    return e["enabled"] != .bool(false) && VECTOR_EFFECT_TYPES.contains(t)
}

/// What a node draws as: shapes in its own space, bottom to top (`vectorAppearanceShapes`).
public func vectorAppearanceShapes(_ node: VectorNode) throws -> [VectorAppearanceShape] {
    if node.isInstance || isVectorFrame(node) || isVectorSymmetryGroup(node) || isVectorMaskGroup(node) || isVectorLens(node) {
        throw VectorNotPorted("the appearance of \(node.typeName) nodes with frames, symmetry, masks or lenses")
    }
    // not ported yet: path effects (applyVectorEffects) (#624)
    if node["effects"]?.arrayValue?.contains(where: isEnabledEffect) == true { throw VectorNotPorted("path effects (applyVectorEffects)") }
    return jsSorted(try baseShapes(node)) { compareOrder($0.order, $1.order) }
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
    if node.isInstance || isVectorFrame(node) || isVectorSymmetryGroup(node) || isVectorLens(node) {
        throw VectorNotPorted("expanding \(node.typeName) nodes with frames, symmetry or lenses")
    }
    if !hasOwnVectorAppearance(node) {
        var group = node
        group.children = try node.children.map(expandVectorAppearance)
        return group
    }
    if isVectorMaskGroup(node) { throw VectorNotPorted("expanding mask groups") }
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
