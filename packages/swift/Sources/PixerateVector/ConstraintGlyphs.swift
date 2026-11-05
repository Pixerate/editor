import Foundation
import PixerateCore
import PixerateRaster

// Where to draw constraint glyphs (document space), the constraints panel's data and the
// constraints the current selection allows (`vector/constraints/glyphs.ts`), as the JSON React
// and Svelte read. The Swift port has no overlay yet, so these are data for a panel or a host.

/// Short glyphs per kind (`VECTOR_CONSTRAINT_GLYPHS`).
public let VECTOR_CONSTRAINT_GLYPHS: [String: String] = [
    "coincident": "●", "collinear": "≡", "concentric": "◎", "fix": "⚓", "parallel": "∥", "perpendicular": "⊥", "horizontal": "H", "vertical": "V",
    "tangent": "T", "smooth": "G2", "symmetric": "⇹", "equal": "=", "distance": "↔", "angle": "∠", "radius": "R", "diameter": "Ø",
]

/// Labels per kind (`VECTOR_CONSTRAINT_LABELS`).
public let VECTOR_CONSTRAINT_LABELS: [String: String] = [
    "coincident": "Coincident", "collinear": "Collinear", "concentric": "Concentric", "fix": "Fix", "parallel": "Parallel", "perpendicular": "Perpendicular",
    "horizontal": "Horizontal", "vertical": "Vertical", "tangent": "Tangent", "smooth": "Smooth (G2)", "symmetric": "Symmetric", "equal": "Equal",
    "distance": "Distance", "angle": "Angle", "radius": "Radius", "diameter": "Diameter",
]

private func worlds(_ doc: VectorDocument) -> [String: (node: VectorNode, world: VectorMatrix)] {
    var out: [String: (node: VectorNode, world: VectorMatrix)] = [:]
    func visit(_ list: [VectorNode], _ parent: VectorMatrix) {
        for n in list {
            let m = n.transform.map { multiplyMatrices($0, parent) } ?? parent
            if n.isPath { out[n.id] = (n, m) }
            else if n.isGroup { visit(n.children, m) }
        }
    }
    visit(doc.nodes, IDENTITY_MATRIX)
    return out
}

/// The document-space points a reference stands for (a point, a segment's ends, a circle's centre).
private func refPoints(_ ref: VectorGeomRef, _ located: [String: (node: VectorNode, world: VectorMatrix)]) -> [Vec2] {
    guard let loc = located[ref.nodeId] else { return [] }
    if ref.circle { return vectorPathCircle(loc.node, loc.world).map { [$0.c] } ?? [] }
    guard let anchor = ref.anchor, let at = findVectorAnchorById(loc.node, anchor) else { return [] }
    let sp = loc.node.subpaths[at.subpath]
    let a = sp.anchors[at.index]
    let p = ref.handle == "in" ? (a.in ?? Vec2(a.x, a.y)) : ref.handle == "out" ? (a.out ?? Vec2(a.x, a.y)) : Vec2(a.x, a.y)
    let first = applyMatrix(loc.world, p)
    if !ref.segment { return [first] }
    let next = sp.anchors[(at.index + 1) % sp.anchors.count]
    return [first, applyMatrix(loc.world, Vec2(next.x, next.y))]
}

/// Glyphs of the constraints that touch `nodeIds` (all when nil), document space
/// (`vectorConstraintGlyphs`): `[{ id, kind, label, at, points, dimension, satisfied }]`.
public func vectorConstraintGlyphs(_ doc: VectorDocument, _ nodeIds: Set<String>? = nil) -> [JSONValue] {
    let cons = vectorConstraints(doc).filter { c in nodeIds == nil || c.refs.contains { nodeIds!.contains($0.nodeId) } }
    if cons.isEmpty { return [] }
    let located = worlds(doc)
    let residuals = vectorConstraintResiduals(doc)
    let env = vectorConstraintEnv(doc)
    let scale = JS.max(JS.max(doc.width, doc.height), 1)
    return cons.compactMap { c -> JSONValue? in
        let groups = c.refs.map { refPoints($0, located) }
        let points = groups.flatMap { $0 }
        if points.isEmpty { return nil }
        let mids = groups.compactMap { g -> Vec2? in g.count == 2 ? Vec2((g[0].x + g[1].x) / 2, (g[0].y + g[1].y) / 2) : g.first }
        var sx = 0.0, sy = 0.0
        for p in mids { sx = sx + p.x }
        for p in mids { sy = sy + p.y }
        let at = Vec2(sx / Double(mids.count), sy / Double(mids.count))
        var label = VECTOR_CONSTRAINT_GLYPHS[c.kind] ?? "undefined"
        if VECTOR_DIMENSIONAL_KINDS.contains(c.kind) {
            let v = try? vectorConstraintValue(env, c)
            let shown = v.map { "\(jsString(JS.round($0 * 100) / 100))\(c.kind == "angle" ? "°" : "")" } ?? "?"
            label = "\(c.name ?? label) = \(shown)"
        }
        let r = residuals[c.id] ?? nil
        let dimension: JSONValue = c.kind == "distance" && points.count == 2 ? .object(JSONObject([("a", points[0].json), ("b", points[1].json)])) : .null
        return .object(JSONObject([
            ("id", .string(c.id)), ("kind", .string(c.kind)), ("label", .string(label)), ("at", at.json), ("points", .array(points.map(\.json))),
            ("dimension", dimension), ("satisfied", .bool(r.map { $0 <= 1e-6 * scale } ?? false)),
        ]))
    }
}

/// Constraints the selected anchors (direct tool) or paths allow, with their references ready for
/// `addConstraint` (`vectorConstraintActions`): `[{ kind, label, refs, dimensional }]`.
public func vectorConstraintActions(_ doc: VectorDocument, anchors selected: [VectorAnchorRef], nodes: [String]) -> [JSONValue] {
    let located = worlds(doc)
    func act(_ kind: String, _ refs: [JSONValue]) -> JSONValue {
        .object(JSONObject([("kind", .string(kind)), ("label", .string(VECTOR_CONSTRAINT_LABELS[kind]!)), ("refs", .array(refs)), ("dimensional", .bool(VECTOR_DIMENSIONAL_KINDS.contains(kind)))]))
    }
    let anchors = selected.filter { r in
        guard let node = located[r.nodeId]?.node, node.subpaths.indices.contains(r.subpath) else { return false }
        return node.subpaths[r.subpath].anchors.indices.contains(r.index)
    }
    if !anchors.isEmpty {
        func neighbours(_ a: VectorAnchorRef, _ b: VectorAnchorRef) -> VectorAnchorRef? {
            if a.nodeId != b.nodeId || a.subpath != b.subpath { return nil }
            let sp = located[a.nodeId]!.node.subpaths[a.subpath]
            let n = sp.anchors.count
            if b.index == a.index + 1 || (sp.closed && a.index == n - 1 && b.index == 0) { return a }
            if a.index == b.index + 1 || (sp.closed && b.index == n - 1 && a.index == 0) { return b }
            return nil
        }
        func pointRef(_ r: VectorAnchorRef) -> JSONObject { JSONObject([("nodeId", .string(r.nodeId)), ("subpath", .number(Double(r.subpath))), ("index", .number(Double(r.index)))]) }
        func segRef(_ r: VectorAnchorRef) -> JSONValue {
            var o = pointRef(r)
            o["segment"] = true
            return .object(o)
        }
        func point(_ r: VectorAnchorRef) -> JSONValue { .object(pointRef(r)) }
        if anchors.count == 1 { return [act("fix", [point(anchors[0])]), act("tangent", [point(anchors[0])]), act("smooth", [point(anchors[0])])] }
        if anchors.count == 2 {
            if let start = neighbours(anchors[0], anchors[1]) { return ["horizontal", "vertical", "distance", "fix"].map { act($0, [segRef(start)]) } }
            return ["coincident", "horizontal", "vertical", "distance"].map { act($0, anchors.map(point)) }
        }
        if anchors.count == 3 {
            for i in 0 ..< 3 {
                let others = anchors.enumerated().filter { $0.offset != i }.map(\.element)
                if let start = neighbours(others[0], others[1]) { return [act("coincident", [point(anchors[i]), segRef(start)]), act("distance", [point(anchors[i]), segRef(start)])] }
            }
            return []
        }
        if anchors.count == 4 {
            for (i, j, k, l) in [(0, 1, 2, 3), (0, 2, 1, 3), (0, 3, 1, 2)] {
                if let s1 = neighbours(anchors[i], anchors[j]), let s2 = neighbours(anchors[k], anchors[l]) {
                    return ["parallel", "perpendicular", "equal", "collinear", "angle"].map { act($0, [segRef(s1), segRef(s2)]) }
                }
            }
        }
        return []
    }
    let circles = nodes.filter { id in located[id].map { vectorPathCircle($0.node, $0.world) != nil } ?? false }
    func circleRef(_ id: String) -> JSONValue { .object(JSONObject([("nodeId", .string(id)), ("circle", true)])) }
    if circles.count == 1 && nodes.count == 1 { return ["radius", "diameter", "fix"].map { act($0, [circleRef(circles[0])]) } }
    if circles.count == 2 && nodes.count == 2 { return ["concentric", "equal", "tangent"].map { act($0, circles.map(circleRef)) } }
    return []
}

/// The constraints panel (`vectorConstraintPanel`): degrees of freedom, constraints of the
/// selection (all without one), actions and parameters, as `{ dof, constraints, actions, parameters }`.
public func vectorConstraintPanel(_ doc: VectorDocument, anchors: [VectorAnchorRef], nodes: [String], conflicts: [String] = []) -> JSONValue {
    var touched = Set(nodes)
    for a in anchors { touched.insert(a.nodeId) }
    var glyphs: [String: JSONValue] = [:]
    for g in vectorConstraintGlyphs(doc, touched.isEmpty ? nil : touched) { glyphs[g["id"]!.stringValue!] = g }
    let env = vectorConstraintEnv(doc)
    let list = vectorConstraints(doc).filter { glyphs[$0.id] != nil }
    let constraints: [JSONValue] = list.map { c in
        var o = JSONObject([("id", .string(c.id)), ("kind", .string(c.kind)), ("label", .string(VECTOR_CONSTRAINT_LABELS[c.kind] ?? "undefined"))])
        if c.hasName { o["name"] = .string(c.name!) }
        if let v = c.value { o["value"] = .string(v) }
        o["satisfied"] = glyphs[c.id]?["satisfied"] ?? false
        o["conflict"] = .bool(conflicts.contains(c.id))
        return .object(o)
    }
    let parameters: [JSONValue] = vectorParameters(doc).map { p in
        do {
            let v = try env.value(p.name)
            return .object(JSONObject([("name", .string(p.name)), ("value", .string(p.value)), ("result", .number(v)), ("error", .null)]))
        } catch {
            return .object(JSONObject([("name", .string(p.name)), ("value", .string(p.value)), ("result", .null), ("error", .string(constraintErrorMessage(error)))]))
        }
    }
    return .object(JSONObject([
        ("dof", vectorConstraintDof(doc).json), ("constraints", .array(constraints)), ("actions", .array(vectorConstraintActions(doc, anchors: anchors, nodes: nodes))), ("parameters", .array(parameters)),
    ]))
}
