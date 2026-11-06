import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Vector path geometry (`vector/geometry.ts`): anchors and handles to Bézier paths and back,
// bounds, affine transforms, anchor edits and shape factories, for plain paths and groups.
// Where the TS reaches into a feature that is not ported yet, the Swift throws `VectorNotPorted`
// (see the `// not ported yet` comments).

private let EPS = 1e-9

@inline(__always) private func handleOf(_ a: VectorAnchor, _ h: Vec2?) -> Vec2 { h ?? Vec2(a.x, a.y) }
@inline(__always) private func isOnAnchor(_ a: VectorAnchor, _ h: Vec2?) -> Bool {
    guard let h else { return true }
    return abs(h.x - a.x) < EPS && abs(h.y - a.y) < EPS
}

// MARK: - Clones

/// `cloneAnchor`: `{ x, y, in?, out?, type? (not corner), corner?, id? }` (unknown members dropped).
public func cloneAnchor(_ a: VectorAnchor) -> VectorAnchor {
    var c = VectorAnchor(x: a.x, y: a.y, in: a.in.map { Vec2($0.x, $0.y) }, out: a.out.map { Vec2($0.x, $0.y) })
    if let t = a.rawTypeName, !t.isEmpty, t != "corner" { c["type"] = .string(t) }
    if let corner = a.corner { c.corner = corner }
    if let id = a.id, !id.isEmpty { c.id = id }
    return c
}

/// `cloneSubpath`: `{ anchors, closed }` with cloned anchors.
public func cloneSubpath(_ s: VectorSubpath) -> VectorSubpath { VectorSubpath(anchors: s.anchors.map(cloneAnchor), closed: s.closed) }

/// A JSON copy, as `JSON.parse(JSON.stringify(v))`: non-finite numbers become `null`.
func jsonCopy(_ v: JSONValue) -> JSONValue {
    switch v {
    case .number(let n): return n.isFinite ? v : .null
    case .array(let a): return .array(a.map(jsonCopy))
    case .object(let o):
        var out = JSONObject()
        for (k, x) in o { out[k] = jsonCopy(x) }
        return .object(out)
    default: return v
    }
}

/// A deep copy of a node (ids kept), through JSON as the TS makes it.
public func cloneVectorNode(_ node: VectorNode) throws -> VectorNode { try VectorNode(json: jsonCopy(node.toJSON())) }

public func cloneVectorDocument(_ doc: VectorDocument) throws -> VectorDocument { try VectorDocument(json: jsonCopy(doc.toJSON())) }

// MARK: - Anchors ↔ Bézier

/// Number of segments of a subpath (a closed one has a segment from the last anchor back to the first).
public func subpathSegmentCount(_ sp: VectorSubpath) -> Int {
    let n = sp.anchors.count
    if n < 2 { return 0 }
    return sp.closed ? n : n - 1
}

/// Control points of segment `i` of a subpath: 2 for a line, 4 for a cubic.
public func subpathSegment(_ sp: VectorSubpath, _ i: Int) -> BezierSegment {
    let a = sp.anchors[i]
    let b = sp.anchors[(i + 1) % sp.anchors.count]
    if isOnAnchor(a, a.out) && isOnAnchor(b, b.in) { return [PathPoint(a.x, a.y), PathPoint(b.x, b.y)] }
    let c1 = handleOf(a, a.out)
    let c2 = handleOf(b, b.in)
    return [PathPoint(a.x, a.y), PathPoint(c1.x, c1.y), PathPoint(c2.x, c2.y), PathPoint(b.x, b.y)]
}

/// Absolute `M` / `L` / `C` / `Z` commands of subpaths, with live corners cut
/// (`expandVectorCorners`). Pass `corners: false` for the stored anchors as they are.
public func subpathsToBezier(_ subpaths: [VectorSubpath], corners: Bool = true) -> BezierPath {
    var out: BezierPath = []
    for sp in corners ? expandVectorCorners(subpaths) : subpaths {
        if sp.anchors.isEmpty { continue }
        let first = sp.anchors[0]
        out.append(.M(x: first.x, y: first.y))
        let count = subpathSegmentCount(sp)
        for i in 0 ..< count {
            let seg = subpathSegment(sp, i)
            if sp.closed && i == count - 1 && seg.count == 2 { break } // `Z` draws the closing line.
            if seg.count == 2 { out.append(.L(x: seg[1][0], y: seg[1][1])) }
            else { out.append(.C(x1: seg[1][0], y1: seg[1][1], x2: seg[2][0], y2: seg[2][1], x: seg[3][0], y: seg[3][1])) }
        }
        if sp.closed { out.append(.Z) }
    }
    return out
}

/// SVG path data (`d`) of subpaths.
public func vectorPathData(_ subpaths: [VectorSubpath], precision: Int = 3) -> String {
    bezierPathToSvg(.commands(subpathsToBezier(subpaths)), BezierPathToSvgOptions(precision: precision))
}

/// SVG path data (`d`) of a path node.
public func vectorPathData(_ node: VectorNode, precision: Int = 3) -> String { vectorPathData(node.subpaths, precision: precision) }

/// Infers the anchor type from its handles.
public func inferAnchorType(_ a: VectorAnchor) -> VectorAnchorType {
    if isOnAnchor(a, a.in) || isOnAnchor(a, a.out) { return .corner }
    let hin = a.in!, hout = a.out!
    let ix = hin.x - a.x
    let iy = hin.y - a.y
    let ox = hout.x - a.x
    let oy = hout.y - a.y
    let li = JS.hypot(ix, iy)
    let lo = JS.hypot(ox, oy)
    let cross = (ix * oy - iy * ox) / (li * lo)
    let dot = (ix * ox + iy * oy) / (li * lo)
    if abs(cross) > 1e-3 || dot > 0 { return .corner }
    return abs(li - lo) <= 1e-3 * JS.max(li, lo) ? .symmetric : .smooth
}

/// Converts SVG path data or Bézier commands to editable subpaths. Quadratics and arcs become
/// cubics, a closing anchor that repeats the first one is merged into it, and each anchor's type
/// is inferred from its handles.
public func bezierToSubpaths(_ input: BezierPathInput) -> [VectorSubpath] {
    let path = toBezierPath(input)
    var out: [VectorSubpath] = []
    var current: Int?
    for cmd in path {
        switch cmd {
        case let .M(x, y):
            out.append(VectorSubpath(anchors: [VectorAnchor(x: x, y: y)], closed: false))
            current = out.count - 1
        case let .L(x, y):
            out[current!].anchors.append(VectorAnchor(x: x, y: y))
        case let .Q(x1, y1, x, y):
            let c = current!
            let k = out[c].anchors.count - 1
            let p0 = out[c].anchors[k]
            out[c].anchors[k].out = Vec2(p0.x + (2.0 / 3.0) * (x1 - p0.x), p0.y + (2.0 / 3.0) * (y1 - p0.y))
            out[c].anchors.append(VectorAnchor(x: x, y: y, in: Vec2(x + (2.0 / 3.0) * (x1 - x), y + (2.0 / 3.0) * (y1 - y))))
        case let .C(x1, y1, x2, y2, x, y):
            let c = current!
            out[c].anchors[out[c].anchors.count - 1].out = Vec2(x1, y1)
            out[c].anchors.append(VectorAnchor(x: x, y: y, in: Vec2(x2, y2)))
        case .Z:
            guard let c = current else { break }
            out[c].closed = true
            let anchors = out[c].anchors
            if anchors.count > 1 {
                let first = anchors[0]
                let end = anchors[anchors.count - 1]
                if abs(end.x - first.x) < 1e-7 && abs(end.y - first.y) < 1e-7 {
                    if let hin = end.in { out[c].anchors[0].in = hin }
                    out[c].anchors.removeLast()
                }
            }
            current = nil
        case .A:
            break
        }
    }
    for s in out.indices {
        for i in out[s].anchors.indices {
            var a = out[s].anchors[i]
            if isOnAnchor(a, a.in) { a.in = nil }
            if isOnAnchor(a, a.out) { a.out = nil }
            let type = inferAnchorType(a)
            if type != .corner { a.type = type }
            out[s].anchors[i] = a
        }
    }
    return out.filter { !$0.anchors.isEmpty }
}

// MARK: - Tree helpers

/// Calls `fn` for every node, depth first, parents before children.
public func walkVectorNodes(_ nodes: [VectorNode], _ fn: (_ node: VectorNode, _ parent: VectorNode?, _ depth: Int) -> Void) {
    func visit(_ list: [VectorNode], _ parent: VectorNode?, _ depth: Int) {
        for node in list {
            fn(node, parent, depth)
            if node.isGroup { visit(node.children, node, depth + 1) }
        }
    }
    visit(nodes, nil, 0)
}

/// Finds a node by id anywhere in the tree.
public func findVectorNode(_ nodes: [VectorNode], _ id: String) -> VectorNode? {
    for node in nodes {
        if node.id == id { return node }
        if node.isGroup, let found = findVectorNode(node.children, id) { return found }
    }
    return nil
}

/// Where a node is (`locateVectorNode`): the indices from the root list down to it (the last is
/// its index in its list), and its parent group.
public struct VectorNodeLocation: Equatable, Sendable {
    /// Root index, then child indices; `path.last` is `index`.
    public var path: [Int]
    public var index: Int { path[path.count - 1] }
    /// The group that holds it, or nil for a top-level node.
    public var parent: VectorNode?
}

/// The list that contains node `id` and its index there, as a path of indices.
public func locateVectorNode(_ nodes: [VectorNode], _ id: String) -> VectorNodeLocation? {
    func search(_ list: [VectorNode], _ parent: VectorNode?, _ prefix: [Int]) -> VectorNodeLocation? {
        for (i, node) in list.enumerated() {
            if node.id == id { return VectorNodeLocation(path: prefix + [i], parent: parent) }
            if node.isGroup, let found = search(node.children, node, prefix + [i]) { return found }
        }
        return nil
    }
    return search(nodes, nil, [])
}

extension Array where Element == VectorNode {
    /// The node at an index path (`VectorNodeLocation.path`).
    public subscript(path path: [Int]) -> VectorNode {
        get {
            var node = self[path[0]]
            for i in path.dropFirst() { node = node.children[i] }
            return node
        }
        set {
            if path.count == 1 { self[path[0]] = newValue; return }
            self[path[0]].children[path: [Int](path.dropFirst())] = newValue
        }
    }
}

/// Every node that paints with fills and strokes in the subtree: paths and text.
public func collectPaintedNodes(_ node: VectorNode) -> [VectorNode] {
    var out: [VectorNode] = []
    walkVectorNodes([node]) { n, _, _ in if n.isPath || n.isText { out.append(n) } }
    return out
}

/// Every path node in the subtree (a path node itself, or a group's descendants).
public func collectPathNodes(_ node: VectorNode) -> [VectorNode] {
    if node.isPath { return [node] }
    if node.isText || node.isInstance { return [] }
    var out: [VectorNode] = []
    walkVectorNodes(node.children) { n, _, _ in if n.isPath { out.append(n) } }
    return out
}

// MARK: - Bounds

/// The node's local → parent matrix (identity when it has no `transform`).
public func nodeMatrix(_ node: VectorNode) -> VectorMatrix { node.transform ?? IDENTITY_MATRIX }

/// A path node's outline in the space `parent` maps to, as drawn: live corners cut and path
/// effects applied (`effects: false`: the stored path only).
public func vectorPathWorldBezier(_ node: VectorNode, _ parent: VectorMatrix = IDENTITY_MATRIX, effects: Bool = true) throws -> BezierPath {
    let m = multiplyMatrices(nodeMatrix(node), parent)
    let path = !effects || !hasOwnVectorAppearance(node) ? subpathsToBezier(node.subpaths) : try vectorAppearanceOutline(node)
    return isIdentityMatrix(m) ? path : transformBezierPath(.commands(path), m.tuple)
}

private func boundsOf(_ b: PathBounds) -> VectorBounds { VectorBounds(x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY) }

/// Geometric bounds of a node (stroke width not included) in the space `parent` maps to (by
/// default its parent's space). Nil when the node has no points. Frames are bounded by their
/// rectangle (and their children when they do not clip).
public func vectorNodeBounds(_ node: VectorNode, _ parent: VectorMatrix = IDENTITY_MATRIX) throws -> VectorBounds? {
    if isVectorFrame(node), let frame = node.frame {
        let m = multiplyMatrices(nodeMatrix(node), parent)
        let rect = bezierPathBounds(.commands(transformBezierPath(.commands(subpathsToBezier(vectorFrameRectPath(frame))), m.tuple)))!
        let box = boundsOf(rect)
        if frame["clip"] == .bool(false) { return unionBounds([box] + (try node.children.map { try vectorNodeBounds($0, m) })) }
        return box
    }
    if isVectorMaskActive(node) {
        let m = multiplyMatrices(nodeMatrix(node), parent)
        let shapes = try vectorAppearanceShapes(node).flatMap { isIdentityMatrix(m) ? $0.path : transformBezierPath(.commands($0.path), m.tuple) }
        return bezierPathBounds(.commands(shapes)).map(boundsOf)
    }
    // Live booleans as drawn (`expandVectorAppearance` throws for the live features not ported yet).
    let node = try expandVectorAppearance(node)
    if node.isGroup {
        let m = multiplyMatrices(nodeMatrix(node), parent)
        return unionBounds(try node.children.map { try vectorNodeBounds($0, m) })
    }
    guard node.isPath else { throw VectorNotPorted("bounds of \(node.typeName) nodes") }
    guard let b = bezierPathBounds(.commands(try vectorPathWorldBezier(node, parent))) else { return nil }
    return boundsOf(b)
}

/// The smallest box around all non-nil boxes, or nil.
public func unionBounds(_ list: [VectorBounds?]) -> VectorBounds? {
    var minX = Double.infinity
    var minY = Double.infinity
    var maxX = -Double.infinity
    var maxY = -Double.infinity
    for case let b? in list {
        minX = JS.min(minX, b.x)
        minY = JS.min(minY, b.y)
        maxX = JS.max(maxX, b.x + b.width)
        maxY = JS.max(maxY, b.y + b.height)
    }
    if minX == .infinity { return nil }
    return VectorBounds(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
}

/// True when two boxes overlap (touching counts).
public func boundsIntersect(_ a: VectorBounds, _ b: VectorBounds) -> Bool {
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
}

/// A box from two corners in any order.
public func boundsFromPoints(_ a: Vec2, _ b: Vec2) -> VectorBounds {
    VectorBounds(x: JS.min(a.x, b.x), y: JS.min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
}

/// The closest point on a segment of a path (`nearestSegment`).
public struct NearestSegment: Equatable, Sendable {
    public var subpath: Int
    public var segment: Int
    /// Curve parameter 0–1 on the segment.
    public var t: Double
    public var point: Vec2
    public var distance: Double
}

/// The closest point on any segment of a path node (`p` and the result in the node's own space).
public func nearestSegment(_ node: VectorNode, _ p: Vec2) -> NearestSegment? {
    var best: NearestSegment?
    for (s, sp) in node.subpaths.enumerated() {
        let count = subpathSegmentCount(sp)
        for i in 0 ..< count {
            let seg = subpathSegment(sp, i)
            let hit = segmentNearest(seg, PathPoint(p.x, p.y))
            if best == nil || hit.distance < best!.distance {
                let q = segmentPoint(seg, hit.t)
                best = NearestSegment(subpath: s, segment: i, t: hit.t, point: Vec2(q[0], q[1]), distance: hit.distance)
            }
        }
    }
    return best
}

// MARK: - Affine transforms

private func mapAnchor(_ a: VectorAnchor, _ m: VectorMatrix) -> VectorAnchor {
    let p = applyMatrix(m, Vec2(a.x, a.y))
    var next = VectorAnchor(x: p.x, y: p.y)
    if let h = a.in { next.in = applyMatrix(m, h) }
    if let h = a.out { next.out = applyMatrix(m, h) }
    if let t = a.rawTypeName, !t.isEmpty { next["type"] = .string(t) }
    if let c = a.corner { next.corner = c }
    if let id = a.id, !id.isEmpty { next.id = id }
    return next
}

/// Every anchor and handle mapped through `m` (the node's own `transform` is untouched).
private func bakeIntoGeometry(_ nodeIn: VectorNode, _ m: VectorMatrix) throws -> VectorNode {
    if isIdentityMatrix(m) { return nodeIn }
    var node = nodeIn
    if let effects = node["effects"]?.arrayValue, !effects.isEmpty { node["effects"] = .array(try transformVectorEffects(effects, m, nodeIn)) }
    if isVectorFrame(node) { return try bakeFrame(node, m) }
    if node.isGroup {
        node.children = try node.children.map { try transformVectorNode($0, m) }
        // A blend's replaced spine lives in the group's space too.
        if let blend = node["blend"]?.objectValue, truthy(blend["spine"]), let spineJSON = blend["spine"] {
            let spine = try VectorSubpath(json: spineJSON)
            var b = blend
            b["spine"] = VectorSubpath(closed: spine.closed, anchors: spine.anchors.map { mapAnchor($0, m) }).toJSON()
            node["blend"] = .object(b)
            return node
        }
        // A symmetry's centre and axes live in the group's space too.
        if truthy(node["symmetry"]), let s = node["symmetry"]?.objectValue { node["symmetry"] = .object(transformVectorSymmetry(s, m)) }
        return node
    }
    // Text: its frame maps and its font sizes scale (`bakeVectorTextGeometry`); paints as for paths.
    if node.isText { node = bakeVectorTextGeometry(node, m) }
    // A mirror swaps the sides of a variable-width stroke (the path still runs the same way).
    let flips = m.a * m.d - m.b * m.c < 0
    func layer(_ l: JSONValue) -> JSONValue {
        guard var o = l.objectValue else { return l }
        if isVectorGradient(o["paint"]) || isVectorShadedPaint(o["paint"]) { o["paint"] = transformVectorPaint(o["paint"], m) }
        if flips, let profile = o["strokeWidthProfile"]?.arrayValue, !profile.isEmpty { o["strokeWidthProfile"] = .array(mirrorWidthProfile(profile)) }
        return .object(o)
    }
    if flips, let profile = node["strokeWidthProfile"]?.arrayValue, !profile.isEmpty { node["strokeWidthProfile"] = .array(mirrorWidthProfile(profile)) }
    // Gradients in the node's own space move with its geometry.
    if isVectorGradient(node.fill) || isVectorShadedPaint(node.fill) { node.fill = transformVectorPaint(node.fill, m) }
    if isVectorGradient(node.stroke) || isVectorShadedPaint(node.stroke) { node.stroke = transformVectorPaint(node.stroke, m) }
    if let fills = node["fills"]?.arrayValue { node["fills"] = .array(fills.map(layer)) }
    if let strokes = node["strokes"]?.arrayValue { node["strokes"] = .array(strokes.map(layer)) }
    if node.isPath {
        node.subpaths = node.subpaths.map { sp in VectorSubpath(closed: sp.closed, anchors: sp.anchors.map { mapAnchor($0, m) }) }
    }
    return node
}

/// A frame resized by `m` (in its own space): its rectangle maps through `m` and its children
/// follow their `resizing` constraints. A skew, rotation or mirror scales every child instead.
private func bakeFrame(_ nodeIn: VectorNode, _ m: VectorMatrix) throws -> VectorNode {
    var node = nodeIn
    let fromJSON = node.frame!
    let from = vectorFrameRect(fromJSON)
    let r = bezierPathBounds(.commands(transformBezierPath(.commands(subpathsToBezier(vectorFrameRectPath(fromJSON))), m.tuple)))!
    var toJSON = fromJSON
    toJSON["x"] = .number(r.minX)
    toJSON["y"] = .number(r.minY)
    toJSON["width"] = .number(r.maxX - r.minX)
    toJSON["height"] = .number(r.maxY - r.minY)
    let to = vectorFrameRect(toJSON)
    let axisAligned = abs(m.b) < 1e-12 && abs(m.c) < 1e-12 && m.a > 0 && m.d > 0
    if !axisAligned {
        node["frame"] = .object(toJSON)
        node.children = try node.children.map { try transformVectorNode($0, m) }
        return node
    }
    let children: [VectorNode] = try node.children.map { cIn in
        var c = cIn
        if c.isText && !c.has("transform"), let f = c.frame, f["kind"] == .string("area") {
            let box = vectorFrameRect(f)
            let cm = vectorFrameChildMatrix(c["resizing"], box, from, to)
            var nf = f
            nf["x"] = .number(cm.a * box.x + cm.e)
            nf["y"] = .number(cm.d * box.y + cm.f)
            nf["width"] = .number(box.width * cm.a)
            nf["height"] = .number(box.height * cm.d)
            c["frame"] = .object(nf)
            return c
        }
        guard let box = try vectorNodeBounds(c) else { return try transformVectorNode(c, translateMatrix(to.x - from.x, to.y - from.y)) }
        let cm = vectorFrameChildMatrix(c["resizing"], box, from, to)
        if c.isText {
            let cx = box.x + box.width / 2
            let cy = box.y + box.height / 2
            return try transformVectorNode(c, translateMatrix(cm.a * cx + cm.e - cx, cm.d * cy + cm.f - cy))
        }
        return try transformVectorNode(c, cm)
    }
    node["frame"] = .object(toJSON)
    node.children = children
    return node
}

/// A copy of the node moved by `m`, given in its parent's space. Rotation and translation go to
/// its rigid `transform`; scale and skew are baked into its anchors (or its children).
public func transformVectorNode(_ node: VectorNode, _ m: VectorMatrix) throws -> VectorNode {
    let total = multiplyMatrices(nodeMatrix(node), m)
    var rest = node
    rest["transform"] = Optional<JSONValue>.none
    // An instance keeps the whole matrix: its art is drawn through it.
    if node.isInstance {
        if !isIdentityMatrix(total) { rest.transform = total }
        return rest
    }
    let (rigid, residual) = decomposeRigid(total)
    var baked = try bakeIntoGeometry(rest, residual)
    if !isIdentityMatrix(rigid) { baked.transform = rigid }
    return baked
}

/// The node's rotation in degrees (from its `transform` and its ancestors' when `parent` is given).
public func vectorNodeRotation(_ node: VectorNode, _ parent: VectorMatrix = IDENTITY_MATRIX) -> Double {
    matrixRotation(multiplyMatrices(nodeMatrix(node), parent))
}

/// The local → document matrix of node `id` (ancestors' transforms included), or nil.
public func vectorWorldMatrix(_ nodes: [VectorNode], _ id: String) -> VectorMatrix? {
    func search(_ list: [VectorNode], _ parent: VectorMatrix) -> VectorMatrix? {
        for n in list {
            let m = multiplyMatrices(nodeMatrix(n), parent)
            if n.id == id { return m }
            if n.isGroup, let found = search(n.children, m) { return found }
        }
        return nil
    }
    return search(nodes, IDENTITY_MATRIX)
}

/// The parent space → document matrix of node `id` (identity for top-level nodes), or nil.
public func vectorParentMatrix(_ nodes: [VectorNode], _ id: String) -> VectorMatrix? {
    guard let node = findVectorNode(nodes, id), let world = vectorWorldMatrix(nodes, id) else { return nil }
    return multiplyMatrices(invertMatrix(nodeMatrix(node)), world)
}

// MARK: - Anchor editing

/// Moves an anchor and its handles by (dx, dy).
public func translateAnchor(_ a: VectorAnchor, _ dx: Double, _ dy: Double) -> VectorAnchor {
    var next = cloneAnchor(a)
    next.x += dx
    next.y += dy
    if let h = next.in { next.in = Vec2(h.x + dx, h.y + dy) }
    if let h = next.out { next.out = Vec2(h.x + dx, h.y + dy) }
    return next
}

/// Which handle of an anchor.
public enum VectorHandleSide: String, Sendable {
    case `in`, out
}

/// Moves one handle to `pos`, keeping the other in line for `smooth` anchors and mirrored for
/// `symmetric` ones. With `breakHandles` the anchor becomes a `corner` and only this handle moves.
public func moveAnchorHandle(_ a: VectorAnchor, _ side: VectorHandleSide, _ pos: Vec2, _ breakHandles: Bool = false) -> VectorAnchor {
    var next = cloneAnchor(a)
    func set(_ s: VectorHandleSide, _ v: Vec2?) {
        if s == .in { next.in = v } else { next.out = v }
    }
    set(side, Vec2(pos.x, pos.y))
    let other: VectorHandleSide = side == .in ? .out : .in
    let type = breakHandles ? "corner" : (a.rawTypeName ?? "corner")
    if breakHandles { next.type = nil }
    let dx = pos.x - a.x
    let dy = pos.y - a.y
    let len = JS.hypot(dx, dy)
    if type == "symmetric" {
        set(other, Vec2(a.x - dx, a.y - dy))
    } else if type == "smooth" && len > EPS {
        let o = other == .in ? a.in : a.out
        let olen = o.map { JS.hypot($0.x - a.x, $0.y - a.y) } ?? len
        set(other, Vec2(a.x - (dx / len) * olen, a.y - (dy / len) * olen))
    }
    if isOnAnchor(next, next.in) { next.in = nil }
    if isOnAnchor(next, next.out) { next.out = nil }
    return next
}

/// Converts anchor `index` of a subpath. `corner` removes both handles; `smooth` and
/// `symmetric` keep existing handles in line, or add handles a third of the way to the
/// neighbours along the line between them.
public func convertAnchor(_ sp: VectorSubpath, _ index: Int, _ type: VectorAnchorType) -> VectorSubpath {
    var anchors = sp.anchors.map(cloneAnchor)
    guard anchors.indices.contains(index) else { return VectorSubpath(anchors: anchors, closed: sp.closed) }
    var a = anchors[index]
    if type == .corner {
        a.in = nil
        a.out = nil
        a.type = nil
        anchors[index] = a
        return VectorSubpath(anchors: anchors, closed: sp.closed)
    }
    let n = anchors.count
    let prev: VectorAnchor? = index > 0 ? anchors[index - 1] : sp.closed ? anchors[n - 1] : nil
    let next: VectorAnchor? = index < n - 1 ? anchors[index + 1] : sp.closed ? anchors[0] : nil
    var dir: Vec2?
    if !isOnAnchor(a, a.out) { dir = Vec2(a.out!.x - a.x, a.out!.y - a.y) }
    else if !isOnAnchor(a, a.in) { dir = Vec2(a.x - a.in!.x, a.y - a.in!.y) }
    else if let prev, let next { dir = Vec2(next.x - prev.x, next.y - prev.y) }
    else if let next { dir = Vec2(next.x - a.x, next.y - a.y) }
    else if let prev { dir = Vec2(a.x - prev.x, a.y - prev.y) }
    guard let d = dir, !(JS.hypot(d.x, d.y) < EPS) else { return VectorSubpath(anchors: anchors, closed: sp.closed) }
    let dl = JS.hypot(d.x, d.y)
    let ux = d.x / dl
    let uy = d.y / dl
    var lenIn: Double
    var lenOut: Double
    if let h = a.in, !isOnAnchor(a, h) { lenIn = JS.hypot(h.x - a.x, h.y - a.y) } else { lenIn = prev.map { JS.hypot($0.x - a.x, $0.y - a.y) / 3 } ?? 0 }
    if let h = a.out, !isOnAnchor(a, h) { lenOut = JS.hypot(h.x - a.x, h.y - a.y) } else { lenOut = next.map { JS.hypot($0.x - a.x, $0.y - a.y) / 3 } ?? 0 }
    if type == .symmetric {
        lenIn = jsOr((lenIn + lenOut) / 2, JS.max(lenIn, lenOut))
        lenOut = lenIn
    }
    if lenIn > EPS { a.in = Vec2(a.x - ux * lenIn, a.y - uy * lenIn) }
    if lenOut > EPS { a.out = Vec2(a.x + ux * lenOut, a.y + uy * lenOut) }
    a.type = type
    anchors[index] = a
    return VectorSubpath(anchors: anchors, closed: sp.closed)
}

/// Inserts an anchor on segment `segment` at parameter `t` without changing the curve's shape.
/// Returns the new subpath and the new anchor's index.
public func insertAnchor(_ sp: VectorSubpath, _ segment: Int, _ t: Double) -> (subpath: VectorSubpath, index: Int) {
    var anchors = sp.anchors.map(cloneAnchor)
    let n = anchors.count
    let ia = segment
    let ib = (segment + 1) % n
    let seg = subpathSegment(sp, segment)
    let (left, right) = splitSegment(seg, t)
    let mid = left[left.count - 1]
    var anchor = VectorAnchor(x: mid[0], y: mid[1])
    if seg.count == 4 {
        anchors[ia].out = Vec2(left[1][0], left[1][1])
        anchor.in = Vec2(left[2][0], left[2][1])
        anchor.out = Vec2(right[1][0], right[1][1])
        anchor.type = .smooth
        anchors[ib].in = Vec2(right[2][0], right[2][1])
        for k in [ia, ib] where isOnAnchor(anchors[k], anchors[k].in) { anchors[k].in = nil }
        for k in [ia, ib] where isOnAnchor(anchors[k], anchors[k].out) { anchors[k].out = nil }
    }
    let index = segment + 1
    anchors.insert(anchor, at: index)
    return (VectorSubpath(anchors: anchors, closed: sp.closed), index)
}

/// Removes anchors from a subpath (callers drop subpaths left too short).
public func removeAnchors(_ sp: VectorSubpath, _ indices: [Int]) -> VectorSubpath {
    let drop = Set(indices)
    return VectorSubpath(anchors: sp.anchors.enumerated().filter { !drop.contains($0.offset) }.map { cloneAnchor($0.element) }, closed: sp.closed)
}

/// Reverses a subpath's direction (handles swap sides).
public func reverseSubpath(_ sp: VectorSubpath) -> VectorSubpath {
    let anchors = sp.anchors.reversed().map { a -> VectorAnchor in
        var next = VectorAnchor(x: a.x, y: a.y)
        if let h = a.out { next.in = h }
        if let h = a.in { next.out = h }
        if let t = a.rawTypeName, !t.isEmpty { next["type"] = .string(t) }
        if let c = a.corner { next.corner = c }
        if let id = a.id, !id.isEmpty { next.id = id }
        return next
    }
    return VectorSubpath(anchors: anchors, closed: sp.closed)
}

// MARK: - Shape factories

/// A loop bound from a JS number (a NaN bound runs no iterations).
private func jsCount(_ n: Double) -> Int { n.isFinite ? Int(n) : 0 }

/// Handle length that makes a cubic approximate a quarter circle.
public let KAPPA = 0.5522847498307936

/// A rectangle. A `radius` becomes a live corner on each of its four anchors.
public func rectSubpath(_ b: VectorBounds, _ radius: Double = 0, _ kind: String? = nil) -> VectorSubpath {
    let (x, y, w, h) = (b.x, b.y, b.width, b.height)
    let sp = VectorSubpath(anchors: [VectorAnchor(x: x, y: y), VectorAnchor(x: x + w, y: y), VectorAnchor(x: x + w, y: y + h), VectorAnchor(x: x, y: y + h)], closed: true)
    return radius > 0 ? setSubpathCorners(sp, radius, kind) : sp
}

/// An ellipse inscribed in a box (four symmetric anchors).
public func ellipseSubpath(_ b: VectorBounds) -> VectorSubpath {
    let rx = b.width / 2
    let ry = b.height / 2
    let cx = b.x + rx
    let cy = b.y + ry
    let kx = rx * KAPPA
    let ky = ry * KAPPA
    return VectorSubpath(closed: true, anchors: [
        VectorAnchor(x: cx, y: cy - ry, in: Vec2(cx - kx, cy - ry), out: Vec2(cx + kx, cy - ry), type: .symmetric),
        VectorAnchor(x: cx + rx, y: cy, in: Vec2(cx + rx, cy - ky), out: Vec2(cx + rx, cy + ky), type: .symmetric),
        VectorAnchor(x: cx, y: cy + ry, in: Vec2(cx + kx, cy + ry), out: Vec2(cx - kx, cy + ry), type: .symmetric),
        VectorAnchor(x: cx - rx, y: cy, in: Vec2(cx - rx, cy + ky), out: Vec2(cx - rx, cy - ky), type: .symmetric),
    ])
}

/// A regular polygon inscribed in a box, first vertex at the top.
public func polygonSubpath(_ b: VectorBounds, _ sides: Double = 6) -> VectorSubpath {
    let n = jsCount(JS.max(3, JS.round(sides)))
    let cx = b.x + b.width / 2
    let cy = b.y + b.height / 2
    var anchors: [VectorAnchor] = []
    for i in 0 ..< n {
        let t = -Double.pi / 2 + (Double(i) * 2 * Double.pi) / Double(n)
        anchors.append(VectorAnchor(x: cx + (JS.cos(t) * b.width) / 2, y: cy + (JS.sin(t) * b.height) / 2))
    }
    return VectorSubpath(anchors: anchors, closed: true)
}

/// A star inscribed in a box, first point at the top. `innerRatio` is inner / outer radius.
public func starSubpath(_ b: VectorBounds, _ points: Double = 5, _ innerRatio: Double = 0.5) -> VectorSubpath {
    let n = jsCount(JS.max(3, JS.round(points)))
    let cx = b.x + b.width / 2
    let cy = b.y + b.height / 2
    var anchors: [VectorAnchor] = []
    for i in 0 ..< n * 2 {
        let t = -Double.pi / 2 + (Double(i) * Double.pi) / Double(n)
        let r = i % 2 == 0 ? 1 : innerRatio
        anchors.append(VectorAnchor(x: cx + (JS.cos(t) * r * b.width) / 2, y: cy + (JS.sin(t) * r * b.height) / 2))
    }
    return VectorSubpath(anchors: anchors, closed: true)
}

/// A straight open line.
public func lineSubpath(_ a: Vec2, _ b: Vec2) -> VectorSubpath {
    VectorSubpath(anchors: [VectorAnchor(x: a.x, y: a.y), VectorAnchor(x: b.x, y: b.y)], closed: false)
}

/// Rounds every coordinate to `precision` decimals.
public func roundSubpaths(_ subpaths: [VectorSubpath], _ precision: Int = 3) -> [VectorSubpath] {
    let f = JS.pow(10, Double(precision))
    func r(_ n: Double) -> Double { JS.round(n * f) / f }
    return subpaths.map { sp in
        VectorSubpath(closed: sp.closed, anchors: sp.anchors.map { a in
            var c = cloneAnchor(a)
            c.x = r(a.x)
            c.y = r(a.y)
            if let h = a.in { c.in = Vec2(r(h.x), r(h.y)) }
            if let h = a.out { c.out = Vec2(r(h.x), r(h.y)) }
            return c
        })
    }
}
