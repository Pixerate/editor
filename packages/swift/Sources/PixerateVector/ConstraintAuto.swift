import Foundation
import PixerateCore
import PixerateRaster

// Auto-constrain (`vector/constraints/auto.ts`): constraints a sketch already nearly satisfies,
// inferred within tolerances and added one by one (refused ones skipped), most important first:
// coincident points of different paths, concentric and tangent circles, a segment tangent to a
// circle, horizontal and vertical segments, collinear, perpendicular (connected) and parallel
// segment pairs, equal lengths and radii.

/// Inference tolerances and kinds (`VectorInferOptions`).
public struct VectorInferOptions: Sendable {
    /// Document units (default 0.5).
    public var distanceTolerance: Double?
    /// Degrees (default 1).
    public var angleTolerance: Double?
    /// Kinds to infer (default all of them).
    public var kinds: [String]?

    public init(distanceTolerance: Double? = nil, angleTolerance: Double? = nil, kinds: [String]? = nil) {
        self.distanceTolerance = distanceTolerance
        self.angleTolerance = angleTolerance
        self.kinds = kinds
    }
}

/// Most candidates returned.
private let MAX_CANDIDATES = 2000

/// Whether `id` is `a` followed by ASCII digits (`/^a\d+$/`).
private func isNumberedAnchorId(_ id: String) -> Bool {
    let u = Array(id.utf8)
    return u.count > 1 && u[0] == 0x61 && u.dropFirst().allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
}

private func hasId(_ a: VectorAnchor) -> Bool { !(a.id ?? "").isEmpty }

/// The path with every anchor given a stable id (`a1`, `a2`, …; existing ids kept; `withVectorAnchorIds`).
public func withVectorAnchorIds(_ node: VectorNode) -> VectorNode {
    if node.subpaths.allSatisfy({ $0.anchors.allSatisfy(hasId) }) { return node }
    var n = 0.0
    for sp in node.subpaths { for a in sp.anchors { if let id = a.id, isNumberedAnchorId(id) { n = JS.max(n, String(id.dropFirst()).jsToNumber) } } }
    var used = Set(node.subpaths.flatMap { $0.anchors.compactMap { hasId($0) ? $0.id : nil } })
    func next() -> String {
        n += 1
        var id = "a\(jsString(n))"
        while used.contains(id) {
            n += 1
            id = "a\(jsString(n))"
        }
        used.insert(id)
        return id
    }
    var out = node
    for s in out.subpaths.indices {
        for i in out.subpaths[s].anchors.indices where !hasId(out.subpaths[s].anchors[i]) {
            out.subpaths[s].anchors[i].id = next()
        }
    }
    return out
}

/// The document with every anchor of the paths `ids` (all paths when nil) given an id (`withVectorDocumentAnchorIds`).
public func withVectorDocumentAnchorIds(_ doc: VectorDocument, _ ids: Set<String>? = nil) -> VectorDocument {
    var changed = false
    func map(_ list: [VectorNode]) -> [VectorNode] {
        list.map { n in
            if n.isPath && (ids == nil || ids!.contains(n.id)) {
                let next = withVectorAnchorIds(n)
                if next != n { changed = true }
                return next
            }
            if n.isGroup {
                let children = map(n.children)
                if children != n.children {
                    var g = n
                    g.children = children
                    return g
                }
            }
            return n
        }
    }
    let nodes = map(doc.nodes)
    if !changed { return doc }
    var out = doc
    out.nodes = nodes
    return out
}

private struct Geo {
    var points: [(ref: VectorGeomRef, p: Vec2)] = []
    var lines: [(ref: VectorGeomRef, a: Vec2, b: Vec2)] = []
    var circles: [(ref: VectorGeomRef, c: Vec2, r: Double)] = []
}

private func collect(_ doc: VectorDocument, _ ids: Set<String>?) -> Geo {
    var g = Geo()
    func visit(_ list: [VectorNode], _ parent: VectorMatrix, _ inside: Bool) {
        for n in list {
            let m = n.transform.map { multiplyMatrices($0, parent) } ?? parent
            let picked = inside || ids == nil || ids!.contains(n.id)
            if n.isGroup { visit(n.children, m, picked) }
            if !n.isPath || !picked { continue }
            if let circle = vectorPathCircle(n, m), n.subpaths.count == 1 {
                g.circles.append((VectorGeomRef(nodeId: n.id, circle: true), circle.c, circle.r))
                continue
            }
            for sp in n.subpaths {
                let pts = sp.anchors.map { applyMatrix(m, Vec2($0.x, $0.y)) }
                for (i, a) in sp.anchors.enumerated() { g.points.append((VectorGeomRef(nodeId: n.id, anchor: a.id), pts[i])) }
                let segs = sp.closed ? sp.anchors.count : sp.anchors.count - 1
                if segs > 0 {
                    for i in 0 ..< segs {
                        let a = sp.anchors[i]
                        let b = sp.anchors[(i + 1) % sp.anchors.count]
                        // Straight segments only (no handles off their anchors).
                        let straight = (a.out.map { $0.x == a.x && $0.y == a.y } ?? true) && (b.in.map { $0.x == b.x && $0.y == b.y } ?? true)
                        if straight && sp.anchors.count > 1 { g.lines.append((VectorGeomRef(nodeId: n.id, anchor: a.id, segment: true), pts[i], pts[(i + 1) % pts.count])) }
                    }
                }
            }
        }
    }
    visit(doc.nodes, IDENTITY_MATRIX, false)
    if g.points.count > 1000 { g.points.removeSubrange(1000...) }
    if g.lines.count > 1000 { g.lines.removeSubrange(1000...) }
    if g.circles.count > 1000 { g.circles.removeSubrange(1000...) }
    return g
}

@inline(__always) private func dist(_ a: Vec2, _ b: Vec2) -> Double { JS.hypot(a.x - b.x, a.y - b.y) }

/// Acute angle between two directions, radians in [0, π/2].
private func angleBetween(_ u: Vec2, _ v: Vec2) -> Double {
    let a = Swift.abs(JS.atan2(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y))
    return a > Double.pi / 2 ? Double.pi - a : a
}

private func lineDist(_ a: Vec2, _ b: Vec2, _ p: Vec2) -> Double {
    let l = dist(a, b)
    return l > 1e-12 ? Swift.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / l : dist(a, p)
}

/// Candidate constraints the paths `ids` (default all) nearly satisfy, most important first, as
/// `{ id: "auto-<n>", kind, refs }` (`inferVectorConstraints`). Their anchors need ids
/// (`withVectorDocumentAnchorIds`).
public func inferVectorConstraints(_ doc: VectorDocument, _ ids: [String]? = nil, _ options: VectorInferOptions = VectorInferOptions()) -> [VectorConstraint] {
    let tol = JS.max(0, options.distanceTolerance ?? 0.5)
    let atol = (JS.max(0, JS.min(45, options.angleTolerance ?? 1)) * Double.pi) / 180
    func allow(_ k: String) -> Bool { options.kinds.map { $0.contains(k) } ?? true }
    let g = collect(doc, ids.map(Set.init))
    var out: [VectorConstraint] = []
    func push(_ kind: String, _ refs: [VectorGeomRef]) {
        if out.count < MAX_CANDIDATES && allow(kind) {
            out.append(VectorConstraint(json: JSONObject([("id", .string("auto-\(out.count + 1)")), ("kind", .string(kind)), ("refs", .array(refs.map(\.json)))])))
        }
    }
    for i in g.points.indices {
        for j in g.points.indices where j > i {
            let a = g.points[i]
            let b = g.points[j]
            if a.ref.nodeId != b.ref.nodeId && dist(a.p, b.p) <= tol { push("coincident", [a.ref, b.ref]) }
        }
    }
    for i in g.circles.indices {
        for j in g.circles.indices where j > i {
            let a = g.circles[i]
            let b = g.circles[j]
            let d = dist(a.c, b.c)
            if d <= tol { push("concentric", [a.ref, b.ref]) }
            else if Swift.abs(d - (a.r + b.r)) <= tol || Swift.abs(d - Swift.abs(a.r - b.r)) <= tol { push("tangent", [a.ref, b.ref]) }
        }
    }
    for l in g.lines {
        for c in g.circles {
            if l.ref.nodeId == c.ref.nodeId { continue }
            let d = Vec2(l.b.x - l.a.x, l.b.y - l.a.y)
            let ll = d.x * d.x + d.y * d.y
            let t = ll > 0 ? ((c.c.x - l.a.x) * d.x + (c.c.y - l.a.y) * d.y) / ll : -1
            if Swift.abs(lineDist(l.a, l.b, c.c) - c.r) <= tol && t >= -1e-9 && t <= 1 + 1e-9 && ll.squareRoot() > tol { push("tangent", [l.ref, c.ref]) }
        }
    }
    for l in g.lines {
        let d = Vec2(l.b.x - l.a.x, l.b.y - l.a.y)
        if JS.hypot(d.x, d.y) <= tol { continue }
        if angleBetween(d, Vec2(1, 0)) <= atol { push("horizontal", [l.ref]) }
        else if angleBetween(d, Vec2(0, 1)) <= atol { push("vertical", [l.ref]) }
    }
    func connected(_ a: (ref: VectorGeomRef, a: Vec2, b: Vec2), _ b: (ref: VectorGeomRef, a: Vec2, b: Vec2)) -> Bool {
        [b.a, b.b].contains { p in dist(p, a.a) <= tol || dist(p, a.b) <= tol }
    }
    var parallel: [[VectorGeomRef]] = []
    var equal: [[VectorGeomRef]] = []
    for i in g.lines.indices {
        for j in g.lines.indices where j > i {
            let a = g.lines[i]
            let b = g.lines[j]
            let d1 = Vec2(a.b.x - a.a.x, a.b.y - a.a.y)
            let d2 = Vec2(b.b.x - b.a.x, b.b.y - b.a.y)
            let l1 = JS.hypot(d1.x, d1.y)
            let l2 = JS.hypot(d2.x, d2.y)
            if l1 <= tol || l2 <= tol { continue }
            let ang = angleBetween(d1, d2)
            if ang <= atol {
                if lineDist(a.a, a.b, b.a) <= tol && lineDist(a.a, a.b, b.b) <= tol { push("collinear", [a.ref, b.ref]) }
                else { parallel.append([a.ref, b.ref]) }
            } else if Swift.abs(Double.pi / 2 - ang) <= atol && connected(a, b) { push("perpendicular", [a.ref, b.ref]) }
            if Swift.abs(l1 - l2) <= tol { equal.append([a.ref, b.ref]) }
        }
    }
    for p in parallel { push("parallel", p) }
    for p in equal { push("equal", p) }
    for i in g.circles.indices {
        for j in g.circles.indices where j > i {
            if Swift.abs(g.circles[i].r - g.circles[j].r) <= tol { push("equal", [g.circles[i].ref, g.circles[j].ref]) }
        }
    }
    return out
}

/// Auto-constrain (`autoConstrainVector`): anchors of the paths given ids, the inferred
/// constraints added one by one with `newId` ids (each solved; refused ones, redundant or
/// conflicting, skipped). Returns the document and the constraints added.
public func autoConstrainVector(_ doc: VectorDocument, _ ids: [String]?, _ newId: () -> String, _ options: VectorInferOptions = VectorInferOptions()) throws -> (document: VectorDocument, added: [VectorConstraint]) {
    var d = withVectorDocumentAnchorIds(doc, ids.map(Set.init))
    var added: [VectorConstraint] = []
    for candidate in inferVectorConstraints(d, ids, options) {
        var c = candidate.json
        c["id"] = .string(newId())
        do {
            d = try addVectorConstraint(d, c)
            added.append(vectorConstraints(d).last!)
        } catch is VectorConstraintError {
            continue
        }
    }
    return (d, added)
}
