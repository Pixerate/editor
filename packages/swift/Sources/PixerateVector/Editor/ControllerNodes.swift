import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

/// A shape for `addShape` (`VectorShapeInput`): kind, box, shape options and the style fields
/// given (`style`, in the order the caller gave them).
public struct VectorShapeInput: Sendable {
    /// `rect`, `ellipse`, `polygon`, `star` or `line`.
    public var kind: String
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    /// Live corner radius of a rectangle, polygon or star (default: the editor default).
    public var cornerRadius: Double?
    public var cornerKind: String?
    public var sides: Double?
    public var points: Double?
    public var innerRatio: Double?
    public var name: String?
    /// Style fields (`VECTOR_STYLE_KEYS`) given for this shape.
    public var style: JSONObject

    public init(kind: String, x: Double, y: Double, width: Double, height: Double, cornerRadius: Double? = nil, cornerKind: String? = nil, sides: Double? = nil, points: Double? = nil, innerRatio: Double? = nil, name: String? = nil, style: JSONObject = JSONObject()) {
        self.kind = kind
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.cornerRadius = cornerRadius
        self.cornerKind = cornerKind
        self.sides = sides
        self.points = points
        self.innerRatio = innerRatio
        self.name = name
        self.style = style
    }
}

private let SHAPE_NAMES = ["rect": "Rectangle", "ellipse": "Ellipse", "polygon": "Polygon", "star": "Star", "line": "Line"]

extension VectorEditorController {
    // MARK: Adding nodes

    /// Adds a node (ids are kept unless taken). Returns its id.
    @discardableResult
    public func addNode(_ node: VectorNode, _ options: AddVectorNodeOptions = AddVectorNodeOptions()) throws -> String {
        var clash = false
        walkVectorNodes([node]) { n, _, _ in if getNode(n.id) != nil { clash = true } }
        let next = clash ? try freshIds(node) : try cloneVectorNode(node)
        change(options.label ?? "Add \(next.isGroup ? "Group" : (next.name ?? "Path"))") {
            func insert(_ list: [VectorNode]) -> [VectorNode] {
                // `splice(index ?? length, 0, next)`: negative counts from the end, past the end appends.
                var copy = list
                var at = options.index ?? copy.count
                if at < 0 { at = Swift.max(0, copy.count + at) }
                copy.insert(next, at: Swift.min(at, copy.count))
                return copy
            }
            if let parentId = options.parentId {
                setDoc(mapTree(doc.nodes) { n in
                    guard n.id == parentId, n.isGroup else { return n }
                    var g = n
                    g.children = insert(n.children)
                    return g
                })
            } else {
                setDoc(insert(doc.nodes))
            }
            if options.select {
                selection = [next.id]
                anchors = []
            }
        }
        return next.id
    }

    /// Builds a path node for a shape with the current defaults (not added).
    public func createShapeNode(_ input: VectorShapeInput) throws -> VectorNode {
        let b = VectorBounds(x: input.x, y: input.y, width: input.width, height: input.height)
        var subpath: VectorSubpath
        switch input.kind {
        case "rect": subpath = rectSubpath(b)
        case "ellipse": subpath = ellipseSubpath(b)
        case "polygon": subpath = polygonSubpath(b, input.sides ?? defaults["polygonSides"]!.numberValue!)
        case "star": subpath = starSubpath(b, input.points ?? defaults["starPoints"]!.numberValue!, input.innerRatio ?? defaults["starInnerRatio"]!.numberValue!)
        case "line": subpath = lineSubpath(Vec2(b.x, b.y), Vec2(b.x + b.width, b.y + b.height))
        default: throw VectorEditorError("Unknown shape kind \"\(input.kind)\".")
        }
        let radius = input.cornerRadius ?? defaults["cornerRadius"]?.numberValue ?? 0
        let kind = input.cornerKind ?? defaults["cornerKind"]?.stringValue
        // Live corners: the shape keeps its sharp anchors, so the radius stays editable.
        if (input.kind == "rect" || input.kind == "polygon" || input.kind == "star") && radius > 0 { subpath = setSubpathCorners(subpath, radius, kind) }
        let style = try styleFor(open: input.kind == "line")
        var own = JSONObject()
        for key in VECTOR_STYLE_KEYS { if let v = input.style[key] { own[key] = v } }
        var props = JSONObject([("id", .string(newId())), ("type", "path"), ("name", .string(input.name ?? SHAPE_NAMES[input.kind]!))])
        for (k, v) in style { props[k] = v }
        // Given style edits the defaults' top layers; given stacks replace theirs.
        return try withStyle(VectorNode(props: props, subpaths: [subpath]), own)
    }

    /// Adds a shape drawn with the current defaults. Returns its id.
    @discardableResult
    public func addShape(_ input: VectorShapeInput, _ options: AddVectorNodeOptions = AddVectorNodeOptions()) throws -> String {
        let node = try createShapeNode(input)
        var o = options
        if o.label == nil { o.label = "Add \(node.name ?? "")" }
        return try addNode(node, o)
    }

    /// Adds a path from SVG path data. Returns its id.
    @discardableResult
    public func addPath(_ d: String, style: JSONObject = JSONObject(), name: String? = nil, _ options: AddVectorNodeOptions = AddVectorNodeOptions()) throws -> String {
        let subpaths = bezierToSubpaths(.svg(d))
        var props = JSONObject([("id", .string(newId())), ("type", "path"), ("name", .string(name ?? "Path"))])
        for (k, v) in try styleFor(open: false) { props[k] = v }
        let node = try withStyle(VectorNode(props: props, subpaths: subpaths), style)
        var o = options
        if o.label == nil { o.label = "Add Path" }
        return try addNode(node, o)
    }

    /// The style a new shape gets from the defaults (`styleFor`).
    func styleFor(open: Bool) throws -> JSONObject {
        let d = defaults
        var out = JSONObject([("fill", open ? .null : (d["fill"] ?? .null)), ("stroke", d["stroke"] ?? .null), ("strokeWidth", d["strokeWidth"] ?? 1)])
        if truthy(d["strokeLinecap"]) { out["strokeLinecap"] = d["strokeLinecap"] }
        if truthy(d["strokeLinejoin"]) { out["strokeLinejoin"] = d["strokeLinejoin"] }
        if truthy(d["strokeDasharray"]) { out["strokeDasharray"] = d["strokeDasharray"] }
        if truthy(d["fillRule"]) { out["fillRule"] = d["fillRule"] }
        if truthy(d["strokeAlign"]), d["strokeAlign"] != "center" { out["strokeAlign"] = d["strokeAlign"] }
        for key in ["startArrow", "endArrow", "arrowAlign", "startArrowScale", "endArrowScale"] where truthy(d[key]) { out[key] = d[key] }
        // not ported yet: default width profiles and paint stacks (#624)
        if let n = arrayLength(d["strokeWidthProfile"]), n > 0 { throw VectorNotPorted("default width profiles") }
        if d["fills"]?.arrayValue != nil || d["strokes"]?.arrayValue != nil { throw VectorNotPorted("default fill and stroke stacks") }
        return out
    }

    // MARK: Style

    /// Applies style (and opacity) to the selected (or given) nodes; groups pass it to every path inside.
    @discardableResult
    public func setStyle(_ style: JSONObject, ids: [String]? = nil, label: String? = nil) throws -> VectorActionResult {
        var targets: [String] = []
        for id in ids ?? selection {
            guard let node = getNode(id) else { return .failure("There is no node \"\(id)\".") }
            for p in collectPaintedNodes(node) where !targets.contains(p.id) { targets.append(p.id) }
        }
        if targets.isEmpty { return .failure("Nothing is selected.") }
        try change(label ?? "Change Style") {
            setDoc(try mapTree(doc.nodes) { n in targets.contains(n.id) ? try withStyle(n, style) : n })
        }
        return .success
    }

    /// Merges `patch` into a node (`updateNode`).
    @discardableResult
    public func updateNode(_ id: String, _ patch: JSONObject, label: String? = nil) throws -> VectorActionResult {
        guard var node = getNode(id) else { return .failure("There is no node \"\(id)\".") }
        for (k, v) in patch where k != "id" && k != "type" { node[k] = v }
        try change(label ?? "Edit Node") { try replaceNode(id, node) }
        return .success
    }

    @discardableResult
    public func rename(_ id: String, _ name: String) throws -> VectorActionResult {
        try updateNode(id, ["name": .string(name)], label: "Rename")
    }

    /// Removes nodes by id.
    @discardableResult
    public func removeNodes(_ ids: [String], label: String? = nil) throws -> VectorActionResult {
        let drop = Set(ids.filter { getNode($0) != nil })
        if drop.isEmpty { return .failure("Nothing to delete.") }
        change(label ?? "Delete") {
            // Deleting a mask releases its group (the next child must not become the mask).
            setDoc(mapTree(doc.nodes) { n in
                if drop.contains(n.id) { return nil }
                if isVectorMaskGroup(n), drop.contains(n.children[0].id) {
                    var g = n
                    g["mask"] = .null
                    return g
                }
                return n
            })
            selection = selection.filter { !drop.contains($0) && getNode($0) != nil }
            anchors = anchors.filter { getAnchor(doc, $0) != nil }
            if let e = editingId, getNode(e) == nil { editingId = nil }
            if let p = pen, getNode(p.nodeId) == nil { pen = nil }
        }
        return .success
    }
}

/// A style applied to a path (`withStyle`); a `null` (or empty) width profile removes it.
func withStyle(_ node: VectorNode, _ style: JSONObject) throws -> VectorNode {
    // not ported yet: whole fill and stroke stacks (sanitizeVectorFills / withVectorFills) (#624)
    if style["fills"] != nil || style["strokes"] != nil { throw VectorNotPorted("fill and stroke stacks") }
    var next = node
    for (k, v) in style { next[k] = v }
    if style.contains("strokeWidthProfile") {
        // not ported yet: width profiles (sanitizeWidthProfile) (#624)
        if let p = style["strokeWidthProfile"]?.arrayValue, !p.isEmpty { throw VectorNotPorted("width profiles") }
        next["strokeWidthProfile"] = Optional<JSONValue>.none
    }
    // Shorthands edit the top layer of a stack; whole stacks given replace them.
    return normalizeVectorPaintStacks(next, prefer: "shorthand")
}
