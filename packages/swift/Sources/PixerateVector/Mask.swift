import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Masks and clipping (`vector/mask.ts`). A group with `mask` set is a mask group: its first
// (bottom) child is the mask and the children above it (the contents) show only where the mask
// lets them: `clip` by the mask's outline, `alpha` / `luminance` by where it paints. Geometry
// uses the masked result: the contents' shapes clipped by the mask's region with the booleans,
// open paths cut where they cross it. The render data of masks and hit-testing through them
// (`vectorMaskRenderData`, `vectorMaskContains`) are not ported yet (#624).

public func isVectorMaskType(_ value: JSONValue?) -> Bool {
    guard let s = value?.stringValue else { return false }
    return VECTOR_MASK_TYPES.contains(s)
}

/// Mask settings from untrusted data, or nil (`sanitizeVectorMask`).
public func sanitizeVectorMask(_ value: JSONValue?) -> JSONObject? {
    guard let r = value?.objectValue, isVectorMaskType(r["type"]) else { return nil }
    return r["invert"] == .bool(true) ? JSONObject([("type", r["type"]!), ("invert", true)]) : JSONObject([("type", r["type"]!)])
}

/// A mask group's mask (its first child), or nil (`vectorMaskSource`).
public func vectorMaskSource(_ node: VectorNode?) -> VectorNode? { isVectorMaskGroup(node) ? node!.children[0] : nil }

/// The children a mask group masks (all but the first); a plain group's children (`vectorMaskContents`).
public func vectorMaskContents(_ group: VectorNode) -> [VectorNode] { isVectorMaskGroup(group) ? Array(group.children.dropFirst()) : group.children }

/// The mask group whose mask is `id`, or nil (`vectorMaskOwner`).
public func vectorMaskOwner(_ nodes: [VectorNode], _ id: String) -> VectorNode? {
    for n in nodes where n.isGroup {
        if isVectorMaskGroup(n) && n.children[0].id == id { return n }
        if let inner = vectorMaskOwner(n.children, id) { return inner }
    }
    return nil
}

/// What agents and panels read about a mask group (`vectorMaskSummary`): `{ type, invert, maskId,
/// contents, enabled }`, or nil for any other node.
public func vectorMaskSummary(_ node: VectorNode?) -> JSONValue? {
    guard let node, isVectorMaskGroup(node) else { return nil }
    return .object(JSONObject([
        ("type", node["mask"]?["type"] ?? .null),
        ("invert", .bool(truthy(node["mask"]?["invert"]))),
        ("maskId", .string(node.children[0].id)),
        ("contents", .array(node.children.dropFirst().map { .string($0.id) })),
        ("enabled", .bool(node.children[0].isVisible)),
    ]))
}

// MARK: - Regions

/// One shape of a mask's region: a path (in the mask group's own space) and the rule that fills it.
public struct VectorMaskRegionShape {
    public var path: BezierPath
    public var fillRule: PolygonFillRule
}

private func place(_ path: BezierPath, _ m: VectorMatrix) -> BezierPath { isIdentityMatrix(m) ? path : transformBezierPath(.commands(path), m.tuple) }

private func ruleOf(_ node: VectorNode) -> PolygonFillRule { node.fillRule == "evenodd" ? .evenodd : .nonzero }

private func regionOfPath(_ path: BezierPath, _ style: VectorNode, _ type: String, _ m: VectorMatrix) throws -> [VectorMaskRegionShape] {
    if path.isEmpty { return [] }
    let fillRule = ruleOf(style)
    if type == "clip" { return [VectorMaskRegionShape(path: place(path, m), fillRule: fillRule)] }
    var out: [VectorMaskRegionShape] = []
    var filled = false
    for l in vectorPaintLayerNodes(style) where l.drawn {
        if l.kind == "fill" {
            if !filled { out.append(VectorMaskRegionShape(path: place(path, m), fillRule: fillRule)) }
            filled = true
        } else if (l.node.strokeWidth ?? 1) > 0 {
            let area = try vectorStrokeOutlinePath(path, l.node)
            if !area.isEmpty { out.append(VectorMaskRegionShape(path: place(area, m), fillRule: .nonzero)) }
        }
    }
    return out
}

/// The area `node` covers as a mask of `type`, in the space `parent` maps it to
/// (`vectorMaskRegionShapes`): for a clip, the outline of every visible path inside it; for an
/// opacity mask, where it paints. `isSelf` counts the node even when hidden (the mask itself).
public func vectorMaskRegionShapes(_ node: VectorNode, _ type: String, _ parent: VectorMatrix = IDENTITY_MATRIX, isSelf: Bool = true) throws -> [VectorMaskRegionShape] {
    if !isSelf && !node.isVisible { return [] }
    // not ported yet: frames (vectorFrameDrawn) (#624)
    if isVectorFrame(node) { throw VectorNotPorted("frames as masks") }
    let m = multiplyMatrices(nodeMatrix(node), parent)
    if isVectorMaskActive(node) || (node.isGroup && (arrayLength(node["effects"]) ?? 0) > 0) {
        // Drawn as shapes: a nested mask's masked result, or a group's effects applied.
        return try vectorAppearanceShapes(node).flatMap { try regionOfPath($0.path, $0.source, type, m) }
    }
    let drawn = try expandVectorAppearance(node)
    if drawn.isGroup {
        let inner = multiplyMatrices(nodeMatrix(drawn), parent)
        return try drawn.children.flatMap { try vectorMaskRegionShapes($0, type, inner, isSelf: false) }
    }
    return try regionOfPath(subpathsToBezier(drawn.subpaths), drawn, type, m)
}

/// The region of a mask group's mask in the group's own space, not inverted (`vectorMaskRegion`).
public func vectorMaskRegion(_ group: VectorNode) throws -> [VectorMaskRegionShape] {
    try vectorMaskRegionShapes(group.children[0], group["mask"]?["type"]?.stringValue ?? "clip")
}

/// The mask's region as one clean path (a boolean union; `vectorMaskRegionPath`).
public func vectorMaskRegionPath(_ group: VectorNode) throws -> BezierPath {
    let shapes = try vectorMaskRegion(group)
    if shapes.isEmpty { return [] }
    if shapes.count == 1 && shapes[0].fillRule == .nonzero { return shapes[0].path }
    return try pathBoolean(.union, shapes.map { PathOperand(.commands($0.path), fillRule: $0.fillRule) }).path
}

// MARK: - Masked shapes

/// A path's open subpaths cut by the region (kept inside it, or outside when inverted).
private func clipOpen(_ path: BezierPath, _ region: BezierPath, _ invert: Bool) -> BezierPath {
    var out: BezierPath = []
    for sp in bezierToSubpaths(.commands(path)) {
        if let pieces = eraseFromOutline(sp, .commands(region), keep: invert ? "outside" : "inside") {
            out += subpathsToBezier(pieces)
        } else {
            // The outline never crosses the region's edge, so it is all in or all out.
            let inside = sp.anchors.first.map { pointInBezierPath(.commands(region), PathPoint($0.x, $0.y), .nonzero) } ?? false
            if inside != invert { out += subpathsToBezier([sp]) }
        }
    }
    return out
}

/// A shape's path clipped by the mask's region: booleans for its closed contours, cuts for its open ones.
private func clipShapePath(_ path: BezierPath, _ fillRule: PolygonFillRule, _ region: BezierPath, _ invert: Bool) throws -> BezierPath {
    let subpaths = bezierToSubpaths(.commands(path))
    let closed = subpaths.filter(\.closed)
    let open = subpaths.filter { !$0.closed }
    var out: BezierPath = []
    if !closed.isEmpty {
        let operands = [PathOperand(.commands(subpathsToBezier(closed)), fillRule: fillRule), PathOperand(.commands(region), fillRule: .nonzero)]
        if !region.isEmpty { out += try pathBoolean(invert ? .difference : .intersection, operands).path }
        else if invert { out += subpathsToBezier(closed) }
    }
    if !open.isEmpty {
        if !region.isEmpty { out += clipOpen(subpathsToBezier(open), region, invert) }
        else if invert { out += subpathsToBezier(open) }
    }
    return out
}

/// What a mask group draws as shapes in its own space (`vectorMaskedShapes`): its contents'
/// shapes (their own effects applied, then the group's), each clipped by the mask's region.
public func vectorMaskedShapes(_ group: VectorNode) throws -> [VectorAppearanceShape] {
    let contents = try group.children.enumerated().flatMap { i, c in i == 0 ? [] : try vectorChildAppearanceShapes(c, i) }
    let shapes = try applyVectorEffects(contents, group["effects"]?.arrayValue)
    if !isVectorMaskActive(group) { return shapes }
    let region = try vectorMaskRegionPath(group)
    let invert = truthy(group["mask"]?["invert"])
    var out: [VectorAppearanceShape] = []
    for s in shapes {
        let path = try clipShapePath(s.path, ruleOf(s.source), region, invert)
        if path.isEmpty { continue }
        // Keep the shape's evaluated paths in the clip's clean nonzero form.
        var shape = s
        shape.path = path
        if s.source.fillRule == "evenodd" { shape.source.fillRule = "nonzero" }
        out.append(shape)
    }
    return out
}

/// The node with every working mask group inside it replaced by a plain group of its masked
/// shapes (ids `<group id>~fx<n>`, placement kept; `vectorMaskedGeometry`).
public func vectorMaskedGeometry(_ node: VectorNode) throws -> VectorNode {
    if !node.isGroup { return node }
    if isVectorMaskActive(node) {
        var props = JSONObject([("id", .string(node.id)), ("type", "group")])
        if truthy(node["transform"]) { props["transform"] = node["transform"] }
        if let o = node["opacity"] { props["opacity"] = o }
        if !node.isVisible { props["visible"] = false }
        if node.isLocked { props["locked"] = true }
        return VectorNode(props: props, children: try vectorAppearanceNodes(node))
    }
    var changed = false
    let children = try node.children.map { c -> VectorNode in
        let next = try vectorMaskedGeometry(c)
        if next != c { changed = true }
        return next
    }
    if !changed { return node }
    var g = node
    g.children = children
    return g
}

/// Bounds of a mask group's masked result in its own space (stroke widths not included), or nil
/// (`vectorMaskedLocalBounds`).
public func vectorMaskedLocalBounds(_ group: VectorNode) throws -> VectorBounds? {
    guard let b = bezierPathBounds(.commands(try vectorAppearanceShapes(group).flatMap(\.path))) else { return nil }
    return VectorBounds(x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY)
}
