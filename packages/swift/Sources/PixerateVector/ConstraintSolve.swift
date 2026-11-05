import Foundation
import PixerateCore
import PixerateRaster

// The constraint solver over a vector document (`vector/constraints/solve.ts`): anchors, handles,
// segments and circles referenced by constraints become a parameter vector (document space),
// each constraint becomes residual equations, and the damped minimum-norm Gauss–Newton solver
// (`ConstraintLM.swift`) drives them to zero per connected component, moving geometry as little
// as possible and what was just edited least.
//
// Ported operation for operation in the TS order (`JS.hypot`, `JS.atan2`, `JS.max` where the TS
// calls `Math.*`), because the solve is iterative: the parameter order, the residual rows and every
// rounding decide where it stops. Constraints and parameters stay JSON in the document; the
// solver reads them as `VectorConstraint`s and writes new ones in the TS key order.

/// Solver iterations.
private let MAX_ITER = 200
/// Constraints tried one by one when locating a conflict.
private let MAX_CONFLICT_PROBES = 48
/// Most constraints one document may hold.
public let VECTOR_MAX_CONSTRAINTS = 2000

/// Every constraint kind (`VECTOR_CONSTRAINT_KINDS`).
public let VECTOR_CONSTRAINT_KINDS = ["coincident", "collinear", "concentric", "fix", "parallel", "perpendicular", "horizontal", "vertical", "tangent", "smooth", "symmetric", "equal", "distance", "angle", "radius", "diameter"]

/// Kinds that take a value (`VECTOR_DIMENSIONAL_KINDS`).
public let VECTOR_DIMENSIONAL_KINDS: Set<String> = ["distance", "angle", "radius", "diameter"]

/// Why a constraint cannot be added or solved (`VectorConstraintError`), with the constraints involved.
public struct VectorConstraintError: Error, CustomStringConvertible, Sendable {
    public let message: String
    /// Constraints involved (conflicting or duplicated), when known.
    public let ids: [String]
    public init(_ message: String, _ ids: [String] = []) {
        self.message = message
        self.ids = ids
    }
    public var description: String { message }
}

/// A thrown error's message, as `e instanceof Error ? e.message : String(e)` reads it.
func constraintErrorMessage(_ error: Error) -> String {
    switch error {
    case let e as VectorConstraintError: return e.message
    case let e as VectorExprError: return e.message
    case let e as VectorEditorError: return e.message
    default: return "\(error)"
    }
}

/// `String(n)` in JavaScript (`NaN` and `Infinity` spelt out).
func jsString(_ n: Double) -> String {
    if n.isNaN { return "NaN" }
    if n.isInfinite { return n < 0 ? "-Infinity" : "Infinity" }
    return JSONValue.jsNumber(n)
}

/// `Math.sign(n) || 1`.
@inline(__always) private func signOr1(_ n: Double) -> Double { n > 0 ? 1 : n < 0 ? -1 : 1 }

// MARK: - Constraints as data

/// What a constraint refers to (`VectorGeomRef`): an anchor of a path (by its `id`), one of its
/// handles, the segment from it to the next anchor, or the path as a circle.
public struct VectorGeomRef: Equatable, Sendable {
    public var nodeId: String
    /// The anchor's id (nil when absent or empty, which the TS treats alike).
    public var anchor: String?
    /// `in` or `out`: the handle instead of the anchor point.
    public var handle: String?
    public var segment: Bool
    public var circle: Bool

    public init(nodeId: String, anchor: String? = nil, handle: String? = nil, segment: Bool = false, circle: Bool = false) {
        self.nodeId = nodeId
        self.anchor = anchor
        self.handle = handle
        self.segment = segment
        self.circle = circle
    }

    init(json: JSONValue) {
        nodeId = json["nodeId"]?.stringValue ?? ""
        let a = json["anchor"]?.stringValue
        anchor = a?.isEmpty == false ? a : nil
        let h = json["handle"]?.stringValue
        handle = h?.isEmpty == false ? h : nil
        segment = truthy(json["segment"])
        circle = truthy(json["circle"])
    }

    /// `{ nodeId, anchor?, handle?, segment?, circle? }`.
    public var json: JSONValue {
        var o = JSONObject([("nodeId", .string(nodeId))])
        if let anchor { o["anchor"] = .string(anchor) }
        if let handle { o["handle"] = .string(handle) }
        if segment { o["segment"] = true }
        if circle { o["circle"] = true }
        return .object(o)
    }
}

/// A constraint kept by the document (`VectorConstraint`), read from its JSON (kept in `json`).
public struct VectorConstraint: Equatable, Sendable {
    public var json: JSONObject
    public var id: String
    public var kind: String
    public var refs: [VectorGeomRef]
    /// Dimensional constraints: the value as an expression.
    public var value: String?
    /// Dimensional constraints: a name other expressions can use.
    public var name: String?
    /// `distance`: `aligned` (nil), `horizontal` or `vertical`.
    public var axis: String?

    public init(json: JSONObject) {
        self.json = json
        id = json["id"]?.stringValue ?? ""
        kind = json["kind"]?.stringValue ?? ""
        refs = (json["refs"]?.arrayValue ?? []).map { VectorGeomRef(json: $0) }
        switch json["value"] {
        case .string(let s)?: value = s
        case .number(let n)?: value = jsString(n)
        default: value = nil
        }
        name = json["name"]?.stringValue
        axis = json["axis"]?.stringValue
    }

    /// `c.name` as a JavaScript condition (present and not empty).
    var hasName: Bool { !(name ?? "").isEmpty }
}

/// The document's constraints (`doc.constraints ?? []`).
public func vectorConstraints(_ doc: VectorDocument) -> [VectorConstraint] {
    (doc["constraints"]?.arrayValue ?? []).map { VectorConstraint(json: $0.objectValue ?? JSONObject()) }
}

/// The document's named parameters as `(name, value)` (`doc.parameters ?? []`).
func vectorParameters(_ doc: VectorDocument) -> [(name: String, value: String)] {
    (doc["parameters"]?.arrayValue ?? []).map { p in (p["name"]?.stringValue ?? "", p["value"]?.stringValue ?? "") }
}

/// The document with `list` as its constraints (`{ ...doc, constraints: list }`).
func withVectorConstraints(_ doc: VectorDocument, _ list: [VectorConstraint]) -> VectorDocument {
    var d = doc
    d["constraints"] = .array(list.map { .object($0.json) })
    return d
}

// MARK: - Locating references

struct ConstraintLocated {
    var node: VectorNode
    /// Node space → document.
    var world: VectorMatrix
}

private func locateNodes(_ doc: VectorDocument) -> [String: ConstraintLocated] {
    var out: [String: ConstraintLocated] = [:]
    func visit(_ list: [VectorNode], _ parent: VectorMatrix) {
        for n in list {
            let m = n.transform.map { multiplyMatrices($0, parent) } ?? parent
            if n.isPath { out[n.id] = ConstraintLocated(node: n, world: m) }
            else if n.isGroup { visit(n.children, m) }
        }
    }
    visit(doc.nodes, IDENTITY_MATRIX)
    return out
}

/// Subpath and index of the anchor with `id` in a path, or nil (`findVectorAnchorById`).
public func findVectorAnchorById(_ node: VectorNode, _ id: String) -> (subpath: Int, index: Int)? {
    for (s, sp) in node.subpaths.enumerated() {
        if let i = sp.anchors.firstIndex(where: { $0.id == id }) { return (s, i) }
    }
    return nil
}

// MARK: - Vectors

@inline(__always) private func sub(_ a: Vec2, _ b: Vec2) -> Vec2 { Vec2(a.x - b.x, a.y - b.y) }
@inline(__always) private func len(_ v: Vec2) -> Double { JS.hypot(v.x, v.y) }
@inline(__always) private func cross(_ a: Vec2, _ b: Vec2) -> Double { a.x * b.y - a.y * b.x }
@inline(__always) private func dot(_ a: Vec2, _ b: Vec2) -> Double { a.x * b.x + a.y * b.y }
@inline(__always) private func unit(_ v: Vec2) -> Vec2 {
    let l = len(v)
    return l > 1e-12 ? Vec2(v.x / l, v.y / l) : v
}
private func wrap(_ a: Double) -> Double {
    let r = (((a + Double.pi).truncatingRemainder(dividingBy: 2 * Double.pi) + 2 * Double.pi).truncatingRemainder(dividingBy: 2 * Double.pi)) - Double.pi
    return r.isFinite ? r : 0
}

/// The round closed path's centre and radius (document space), or nil when it is not round (`vectorPathCircle`).
public func vectorPathCircle(_ node: VectorNode, _ world: VectorMatrix = IDENTITY_MATRIX) -> (c: Vec2, r: Double)? {
    guard let sp = node.subpaths.first, sp.closed, sp.anchors.count >= 3 else { return nil }
    let pts = sp.anchors.map { applyMatrix(world, Vec2($0.x, $0.y)) }
    var sx = 0.0, sy = 0.0
    for p in pts { sx = sx + p.x }
    for p in pts { sy = sy + p.y }
    let c = Vec2(sx / Double(pts.count), sy / Double(pts.count))
    let ds = pts.map { len(sub($0, c)) }
    var sr = 0.0
    for d in ds { sr = sr + d }
    let r = sr / Double(ds.count)
    if !(r > 1e-9) || ds.contains(where: { Swift.abs($0 - r) > r * 0.05 }) { return nil }
    // The middle of every segment too (a polygon's corners lie on a circle, its sides do not).
    let n = sp.anchors.count
    for i in 0 ..< n {
        let a = sp.anchors[i]
        let b = sp.anchors[(i + 1) % n]
        let p1 = a.out ?? Vec2(a.x, a.y)
        let p2 = b.in ?? Vec2(b.x, b.y)
        let mid = applyMatrix(world, Vec2((a.x + 3 * p1.x + 3 * p2.x + b.x) / 8, (a.y + 3 * p1.y + 3 * p2.y + b.y) / 8))
        if Swift.abs(len(sub(mid, c)) - r) > r * 0.05 { return nil }
    }
    return (c, r)
}

// MARK: - Model: parameters

private struct PointSlot {
    var nodeId: String
    var subpath: Int
    var index: Int
    /// `anchor`, `in` or `out`.
    var part: String
    var off: Int
}

private struct CircleSlot {
    var nodeId: String
    var off: Int
    /// Centre and radius the path had (document space).
    var c0: Vec2
    var r0: Double
}

private enum Slot {
    case point(PointSlot)
    case circle(CircleSlot)

    var nodeId: String {
        switch self {
        case let .point(p): p.nodeId
        case let .circle(c): c.nodeId
        }
    }

    var off: Int {
        switch self {
        case let .point(p): p.off
        case let .circle(c): c.off
        }
    }

    var isCircle: Bool { if case .circle = self { true } else { false } }
}

/// The point a slot part reads: the anchor, or its handle (the anchor when it has none).
private func partPoint(_ a: VectorAnchor, _ part: String) -> Vec2 {
    switch part {
    case "in": a.in ?? Vec2(a.x, a.y)
    case "out": a.out ?? Vec2(a.x, a.y)
    default: Vec2(a.x, a.y)
    }
}

private final class Model {
    var x0: [Double] = []
    /// Slots in allocation order (a JS `Map`).
    var slotKeys: [String] = []
    var slots: [String: Slot] = [:]
    let located: [String: ConstraintLocated]

    init(_ located: [String: ConstraintLocated]) { self.located = located }

    var orderedSlots: [Slot] { slotKeys.map { slots[$0]! } }

    private func anchorOf(_ ref: VectorGeomRef) -> (loc: ConstraintLocated, subpath: Int, index: Int)? {
        guard let loc = located[ref.nodeId], let id = ref.anchor, let at = findVectorAnchorById(loc.node, id) else { return nil }
        return (loc, at.subpath, at.index)
    }

    private func put(_ key: String, _ slot: Slot) {
        slotKeys.append(key)
        slots[key] = slot
    }

    /// The slot of a point of a path (anchor or handle), allocating it.
    func pointSlot(_ loc: ConstraintLocated, _ subpath: Int, _ index: Int, _ part: String) -> PointSlot? {
        guard loc.node.subpaths.indices.contains(subpath), loc.node.subpaths[subpath].anchors.indices.contains(index) else { return nil }
        let a = loc.node.subpaths[subpath].anchors[index]
        let key = "\(loc.node.id)#\(subpath):\(index)#\(part)"
        if case let .point(hit)? = slots[key] { return hit }
        let d = applyMatrix(loc.world, partPoint(a, part))
        let slot = PointSlot(nodeId: loc.node.id, subpath: subpath, index: index, part: part, off: x0.count)
        x0.append(d.x)
        x0.append(d.y)
        put(key, .point(slot))
        return slot
    }

    func circleSlot(_ nodeId: String) -> CircleSlot? {
        let key = "\(nodeId)#circle"
        if case let .circle(hit)? = slots[key] { return hit }
        guard let loc = located[nodeId], let circle = vectorPathCircle(loc.node, loc.world) else { return nil }
        let slot = CircleSlot(nodeId: nodeId, off: x0.count, c0: circle.c, r0: circle.r)
        x0.append(circle.c.x)
        x0.append(circle.c.y)
        x0.append(circle.r)
        put(key, .circle(slot))
        return slot
    }

    /// A point: an anchor, a handle, or a circle's centre. Returns its x index (y is next).
    func point(_ ref: VectorGeomRef) -> Int? {
        if ref.circle { return circleSlot(ref.nodeId)?.off }
        if ref.segment { return nil }
        guard let at = anchorOf(ref) else { return nil }
        return pointSlot(at.loc, at.subpath, at.index, ref.handle ?? "anchor")?.off
    }

    /// A segment's end points (anchor and next anchor) as x indices.
    func line(_ ref: VectorGeomRef) -> (Int, Int)? {
        if !ref.segment { return nil }
        guard let at = anchorOf(ref) else { return nil }
        let sp = at.loc.node.subpaths[at.subpath]
        let next = at.index + 1 < sp.anchors.count ? at.index + 1 : sp.closed ? 0 : -1
        if next < 0 || next == at.index { return nil }
        let a = pointSlot(at.loc, at.subpath, at.index, "anchor")
        let b = pointSlot(at.loc, at.subpath, next, "anchor")
        guard let a, let b else { return nil }
        return (a.off, b.off)
    }

    /// A circle's centre x index (y, then r follow).
    func circle(_ ref: VectorGeomRef) -> Int? {
        ref.circle ? circleSlot(ref.nodeId)?.off : nil
    }

    /// The two cubic segments meeting at an anchor, as x indices of their control points
    /// (incoming: previous anchor, its out handle, this anchor's in handle, this anchor; outgoing:
    /// this anchor, its out handle, the next anchor's in handle, the next anchor). Nil at an open end.
    func joint(_ ref: VectorGeomRef) -> (inc: [Int], out: [Int])? {
        let found = anchorOf(ref)
        guard let at = found, !ref.segment, ref.handle == nil else { return nil }
        let sp = at.loc.node.subpaths[at.subpath]
        let n = sp.anchors.count
        let prev = at.index > 0 ? at.index - 1 : sp.closed ? n - 1 : -1
        let next = at.index + 1 < n ? at.index + 1 : sp.closed ? 0 : -1
        if prev < 0 || next < 0 || n < 2 { return nil }
        func s(_ i: Int, _ p: String) -> Int { pointSlot(at.loc, at.subpath, i, p)!.off }
        let inc = [s(prev, "anchor"), s(prev, "out"), s(at.index, "in"), s(at.index, "anchor")]
        let out = [s(at.index, "anchor"), s(at.index, "out"), s(next, "in"), s(next, "anchor")]
        return (inc, out)
    }

    /// Parameter indices a Fix of `ref` locks.
    func lockIndices(_ ref: VectorGeomRef) -> [Int] {
        if let c = circle(ref) { return [c, c + 1, c + 2] }
        if let l = line(ref) { return [l.0, l.0 + 1, l.1, l.1 + 1] }
        guard let p = point(ref) else { return [] }
        return [p, p + 1]
    }

    /// The document with every slot's parameters from `x` written back into the paths.
    func writeBack(_ doc: VectorDocument, _ x: [Double]) -> VectorDocument {
        var byNodeKeys: [String] = []
        var byNode: [String: [Slot]] = [:]
        for s in orderedSlots {
            if byNode[s.nodeId] == nil { byNodeKeys.append(s.nodeId) }
            byNode[s.nodeId, default: []].append(s)
        }
        var changed: [String: VectorNode] = [:]
        for nodeId in byNodeKeys {
            let slots = byNode[nodeId]!
            let loc = located[nodeId]!
            let inv = invertMatrix(loc.world)
            func toLocal(_ p: Vec2) -> Vec2 { applyMatrix(inv, p) }
            var subpaths = loc.node.subpaths
            let circle: CircleSlot? = slots.lazy.compactMap { if case let .circle(c) = $0 { c } else { nil } }.first
            if let circle {
                let c = Vec2(x[circle.off], x[circle.off + 1])
                let k = x[circle.off + 2] / circle.r0
                func map(_ p: Vec2) -> Vec2 {
                    toLocal(Vec2(c.x + (applyMatrix(loc.world, p).x - circle.c0.x) * k, c.y + (applyMatrix(loc.world, p).y - circle.c0.y) * k))
                }
                for s in subpaths.indices {
                    for i in subpaths[s].anchors.indices {
                        var a = subpaths[s].anchors[i]
                        let q = map(Vec2(a.x, a.y))
                        a.x = q.x
                        a.y = q.y
                        if let h = a.in { a.in = map(h) }
                        if let h = a.out { a.out = map(h) }
                        subpaths[s].anchors[i] = a
                    }
                }
            }
            let points: [PointSlot] = slots.compactMap { if case let .point(p) = $0 { p } else { nil } }
            if !points.isEmpty {
                for si in subpaths.indices where points.contains(where: { $0.subpath == si }) {
                    for ai in subpaths[si].anchors.indices {
                        let mine = points.filter { $0.subpath == si && $0.index == ai }
                        if mine.isEmpty { continue }
                        let a = subpaths[si].anchors[ai]
                        var next = a
                        if let anchorSlot = mine.first(where: { $0.part == "anchor" }) {
                            let q = toLocal(Vec2(x[anchorSlot.off], x[anchorSlot.off + 1]))
                            let dx = q.x - a.x
                            let dy = q.y - a.y
                            next.x = q.x
                            next.y = q.y
                            // Handles that are not parameters move with their anchor.
                            if let h = a.in, !mine.contains(where: { $0.part == "in" }) { next.in = Vec2(h.x + dx, h.y + dy) }
                            if let h = a.out, !mine.contains(where: { $0.part == "out" }) { next.out = Vec2(h.x + dx, h.y + dy) }
                        }
                        for part in ["in", "out"] {
                            guard let h = mine.first(where: { $0.part == part }) else { continue }
                            let q = toLocal(Vec2(x[h.off], x[h.off + 1]))
                            let keep = !(JS.hypot(q.x - next.x, q.y - next.y) < 1e-9)
                            if part == "in" { next.in = keep ? q : nil } else { next.out = keep ? q : nil }
                        }
                        subpaths[si].anchors[ai] = next
                    }
                }
            }
            if circle != nil || !points.isEmpty {
                var n = loc.node
                n.subpaths = subpaths
                changed[nodeId] = n
            }
        }
        if changed.isEmpty { return doc }
        func map(_ list: [VectorNode]) -> [VectorNode] {
            list.map { n in
                if let c = changed[n.id] { return c }
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
        var out = doc
        out.nodes = map(doc.nodes)
        return out
    }
}

// MARK: - Residuals

/// A constraint interpreted against a model (`Built`).
private struct Built {
    var id: String
    var kind: String
    var refs: [VectorGeomRef]
    var rows: Int
    /// Fix: parameters locked instead of rows.
    var locks: [Int]
    var eval: ResidualFn
    /// The current value of a dimensional constraint (degrees for angles).
    var measure: (([Double]) -> Double)?
}

@inline(__always) private func pt(_ x: [Double], _ i: Int) -> Vec2 { Vec2(x[i], x[i + 1]) }

/// A cubic's curvature at its start: (2/3)·cross(P1 − P0, P2 − P1) / |P1 − P0|³.
private func startCurvature(_ p0: Vec2, _ p1: Vec2, _ p2: Vec2) -> Double {
    let d = sub(p1, p0)
    let l = len(d)
    return l > 1e-9 ? ((2.0 / 3.0) * cross(d, sub(p2, p1))) / (l * l * l) : 0
}

/// Interprets a constraint against the model (allocating its parameters), deciding orientations
/// from the starting geometry. Throws a `VectorConstraintError` saying what references it needs.
private func interpret(_ c: VectorConstraint, _ m: Model, _ target: Double) throws -> Built {
    let refs = c.refs
    let n = refs.count
    func need(_ what: String) -> VectorConstraintError { VectorConstraintError("\(c.kind) needs \(what).", [c.id]) }
    func P(_ i: Int) -> Int? { i < n ? m.point(refs[i]) : nil }
    func L(_ i: Int) -> (Int, Int)? { i < n ? m.line(refs[i]) : nil }
    func C(_ i: Int) -> Int? { i < n ? m.circle(refs[i]) : nil }
    func rowsOf(_ rows: Int, _ f: @escaping ResidualFn, _ measure: (([Double]) -> Double)? = nil) -> Built {
        Built(id: c.id, kind: c.kind, refs: refs, rows: rows, locks: [], eval: f, measure: measure)
    }
    func lineDir(_ x: [Double], _ l: (Int, Int)) -> Vec2 { sub(pt(x, l.1), pt(x, l.0)) }
    switch c.kind {
    case "fix":
        if n == 0 { throw need("one or more references") }
        let locks = refs.flatMap { m.lockIndices($0) }
        if locks.count < refs.count * 2 { throw need("anchors, segments or circles that exist") }
        return Built(id: c.id, kind: c.kind, refs: refs, rows: 0, locks: locks, eval: { _, _ in }, measure: nil)
    case "coincident":
        if n != 2 { throw need("two references") }
        let a = P(0)
        let b = P(1)
        if let a, let b { return rowsOf(2) { x, out in out.append(x[a] - x[b]); out.append(x[a + 1] - x[b + 1]) } }
        for (pi, li) in [(0, 1), (1, 0)] {
            let p = P(pi)
            let l = L(li)
            if let p, let l { return rowsOf(1) { x, out in out.append(cross(unit(lineDir(x, l)), sub(pt(x, p), pt(x, l.0)))) } }
            let ci = C(li)
            if let p, let ci, !refs[pi].circle { return rowsOf(1) { x, out in out.append(len(sub(pt(x, p), pt(x, ci))) - x[ci + 2]) } }
        }
        throw need("two points, a point and a segment, or a point and a circle")
    case "collinear":
        let a = L(0)
        let b = L(1)
        guard n == 2, let a, let b else { throw need("two segments") }
        return rowsOf(2) { x, out in
            let d = unit(lineDir(x, a))
            out.append(cross(d, sub(pt(x, b.0), pt(x, a.0))))
            out.append(cross(d, sub(pt(x, b.1), pt(x, a.0))))
        }
    case "concentric":
        if n != 2 { throw need("two circles, or a circle and a point") }
        let a = C(0) ?? P(0)
        let b = C(1) ?? P(1)
        guard let a, let b, !(C(0) == nil && C(1) == nil) else { throw need("two circles, or a circle and a point") }
        return rowsOf(2) { x, out in out.append(x[a] - x[b]); out.append(x[a + 1] - x[b + 1]) }
    case "parallel", "perpendicular":
        let a = L(0)
        let b = L(1)
        guard n == 2, let a, let b else { throw need("two segments") }
        let parallel = c.kind == "parallel"
        // In length units (the second segment's), so the tolerance means the same as for points.
        return rowsOf(1) { x, out in
            let u = unit(lineDir(x, a))
            let v = lineDir(x, b)
            out.append(parallel ? cross(u, v) : dot(u, v))
        }
    case "horizontal", "vertical":
        let axis = c.kind == "horizontal" ? 1 : 0
        let l = n == 1 ? L(0) : nil
        if let l { return rowsOf(1) { x, out in out.append(x[l.1 + axis] - x[l.0 + axis]) } }
        let a = P(0)
        let b = P(1)
        if n == 2, let a, let b { return rowsOf(1) { x, out in out.append(x[b + axis] - x[a + axis]) } }
        throw need("a segment or two points")
    case "tangent":
        if n == 1 {
            guard let j = m.joint(refs[0]) else { throw need("an anchor with a segment on each side, a segment and a circle, or two circles") }
            // The handles point away from each other through the anchor (in the out handle's length).
            return rowsOf(1) { x, out in out.append(cross(unit(sub(pt(x, j.inc[3]), pt(x, j.inc[2]))), sub(pt(x, j.out[1]), pt(x, j.out[0])))) }
        }
        if n != 2 { throw need("a segment and a circle, two circles, or one anchor") }
        for (li, ci) in [(0, 1), (1, 0)] {
            let l = L(li)
            let cc = C(ci)
            if let l, let cc {
                let x0 = m.x0
                let sign = signOr1(cross(unit(lineDir(x0, l)), sub(pt(x0, cc), pt(x0, l.0))))
                return rowsOf(1) { x, out in out.append(sign * cross(unit(lineDir(x, l)), sub(pt(x, cc), pt(x, l.0))) - x[cc + 2]) }
            }
        }
        let a = C(0)
        let b = C(1)
        if let a, let b {
            let x0 = m.x0
            let d0 = len(sub(pt(x0, a), pt(x0, b)))
            let inside = d0 < JS.max(x0[a + 2], x0[b + 2])
            return rowsOf(1) { x, out in out.append(len(sub(pt(x, a), pt(x, b))) - (inside ? Swift.abs(x[a + 2] - x[b + 2]) : x[a + 2] + x[b + 2])) }
        }
        throw need("a segment and a circle, two circles, or one anchor")
    case "smooth":
        guard n == 1, let j = m.joint(refs[0]) else { throw need("one anchor with a segment on each side") }
        let x0 = m.x0
        let scale = JS.max(1, len(sub(pt(x0, j.inc[0]), pt(x0, j.out[3]))))
        return rowsOf(2) { x, out in
            let p1 = pt(x, j.inc[1]), p2 = pt(x, j.inc[2]), p3 = pt(x, j.inc[3])
            let q0 = pt(x, j.out[0]), q1 = pt(x, j.out[1]), q2 = pt(x, j.out[2])
            out.append(cross(unit(sub(p3, p2)), sub(q1, q0)))
            // Curvature where the incoming cubic ends (its reverse's start) and where the outgoing starts.
            let kin = -startCurvature(p3, p2, p1)
            let kout = startCurvature(q0, q1, q2)
            out.append((kin - kout) * scale)
        }
    case "symmetric":
        let a = P(0)
        let b = P(1)
        let l = L(2)
        guard n == 3, let a, let b, let l else { throw need("two points and a segment (the axis)") }
        return rowsOf(2) { x, out in
            let d = unit(lineDir(x, l))
            let p = pt(x, a)
            let q = pt(x, b)
            let mid = Vec2((p.x + q.x) / 2, (p.y + q.y) / 2)
            out.append(cross(d, sub(mid, pt(x, l.0))))
            out.append(dot(d, sub(q, p)))
        }
    case "equal":
        if n != 2 { throw need("two segments or two circles") }
        let la = L(0)
        let lb = L(1)
        if let la, let lb { return rowsOf(1) { x, out in out.append(len(lineDir(x, la)) - len(lineDir(x, lb))) } }
        let ca = C(0)
        let cb = C(1)
        if let ca, let cb { return rowsOf(1) { x, out in out.append(x[ca + 2] - x[cb + 2]) } }
        throw need("two segments or two circles")
    case "distance":
        let axis = c.axis ?? "aligned"
        var a: Int?
        var b: Int?
        if n == 1 {
            if let l = L(0) {
                a = l.0
                b = l.1
            }
        } else if n == 2 {
            a = P(0)
            b = P(1)
            let l = a == nil ? L(0) : L(1)
            let p = a == nil ? P(1) : P(0)
            if a == nil || b == nil, let l, let p, axis == "aligned" {
                let x0 = m.x0
                let sign = signOr1(cross(unit(lineDir(x0, l)), sub(pt(x0, p), pt(x0, l.0))))
                let f: ([Double]) -> Double = { x in sign * cross(unit(lineDir(x, l)), sub(pt(x, p), pt(x, l.0))) }
                return rowsOf(1, { x, out in out.append(f(x) - target) }, f)
            }
        }
        guard let a, let b else { throw need("a segment, two points, or a point and a segment") }
        if axis == "aligned" {
            let f: ([Double]) -> Double = { x in len(sub(pt(x, b), pt(x, a))) }
            return rowsOf(1, { x, out in out.append(f(x) - target) }, f)
        }
        let k = axis == "horizontal" ? 0 : 1
        let sign = signOr1(m.x0[b + k] - m.x0[a + k])
        let f: ([Double]) -> Double = { x in sign * (x[b + k] - x[a + k]) }
        return rowsOf(1, { x, out in out.append(f(x) - target) }, f)
    case "angle":
        let a = L(0)
        let b = L(1)
        guard n == 2, let a, let b else { throw need("two segments") }
        func ang(_ x: [Double]) -> Double {
            let u = lineDir(x, a)
            let v = lineDir(x, b)
            return JS.atan2(cross(u, v), dot(u, v))
        }
        let x0 = m.x0
        let sign = signOr1(ang(x0))
        let rad = (target * Double.pi) / 180
        // Radians times the segments' size: an arc length, like the other rows.
        let size = JS.max(1, (len(lineDir(x0, a)) + len(lineDir(x0, b))) / 2)
        return rowsOf(1, { x, out in out.append(wrap(ang(x) - sign * rad) * size) }, { x in (Swift.abs(ang(x)) * 180) / Double.pi })
    case "radius", "diameter":
        guard n == 1, let cc = C(0) else { throw need("one circle (a round closed path)") }
        let k: Double = c.kind == "radius" ? 1 : 2
        if !(target > 0) { throw VectorConstraintError("\(c.kind) must be positive, got \(jsString(target)).", [c.id]) }
        let f: ([Double]) -> Double = { x in k * x[cc + 2] }
        return rowsOf(1, { x, out in out.append(f(x) - target) }, f)
    default:
        throw need("a known kind")
    }
}

// MARK: - Parameters and values

/// The expression environment: the document's parameters and named dimensional constraints (`vectorConstraintEnv`).
public func vectorConstraintEnv(_ doc: VectorDocument) -> VectorExprEnv {
    let env = VectorExprEnv()
    for p in vectorParameters(doc) { env.set(p.name, p.value) }
    for c in vectorConstraints(doc) where c.hasName && c.value != nil && VECTOR_DIMENSIONAL_KINDS.contains(c.kind) { env.set(c.name!, c.value!) }
    return env
}

/// The value of a dimensional constraint (degrees for angles; `vectorConstraintValue`).
public func vectorConstraintValue(_ env: VectorExprEnv, _ c: VectorConstraint) throws -> Double {
    guard let value = c.value, !value.isEmpty else { throw VectorConstraintError("\(c.kind) needs a value.", [c.id]) }
    do {
        return try c.hasName && env.has(c.name!) ? env.value(c.name!) : env.eval(value)
    } catch {
        throw VectorConstraintError("\(c.name ?? c.kind): \(constraintErrorMessage(error))", [c.id])
    }
}

// MARK: - Components

private final class Comp {
    let model: Model
    let built: [Built]
    let weights: [Double]
    let tol: Double

    init(_ model: Model, _ built: [Built], _ weights: [Double], _ tol: Double) {
        self.model = model
        self.built = built
        self.weights = weights
        self.tol = tol
    }

    func free(_ skip: Int? = nil) -> [Int] {
        var locked = Set<Int>()
        for (i, b) in built.enumerated() where i != skip { for j in b.locks { locked.insert(j) } }
        return model.x0.indices.filter { !locked.contains($0) }
    }

    func rows(_ skip: Int? = nil) -> Int {
        var s = 0
        for (i, b) in built.enumerated() { s += i == skip ? 0 : b.rows }
        return s
    }

    func evalFn(_ skip: Int? = nil) -> ResidualFn {
        let built = built
        return { x, out in
            for (i, b) in built.enumerated() where i != skip { b.eval(x, &out) }
        }
    }

    func run(_ skip: Int? = nil) throws -> ConstraintSolveOutcome {
        let free = free(skip)
        let rows = rows(skip)
        if rows > CONSTRAINT_MAX_ROWS || Double(rows) * Double(rows) * Double(free.count) > 4e8 { throw VectorConstraintError("The constraint system is too large to solve.") }
        return constraintSolveLm(evalFn(skip), model.x0, free, weights, tol, MAX_ITER)
    }

    /// Constraint ids in conflict: each one whose removal makes the rest solvable.
    func conflicts(_ failed: [Double]) -> [String] {
        var ids: [String] = []
        if built.count <= MAX_CONFLICT_PROBES {
            for (i, b) in built.enumerated() {
                if let o = try? run(i), o.converged { ids.append(b.id) }
            }
        }
        if ids.isEmpty {
            for b in built {
                var out: [Double] = []
                b.eval(failed, &out)
                if constraintMaxAbs(out) > tol * 10 { ids.append(b.id) }
            }
        }
        return ids
    }
}

private func scaleTol(_ x: [Double]) -> Double {
    var m = 1.0
    for v in x { m = JS.max(m, Swift.abs(v)) }
    return 1e-9 * m
}

/// A key per thing a reference touches (for grouping constraints into components).
private func refKeys(_ r: VectorGeomRef) -> [String] {
    r.circle ? ["\(r.nodeId)#circle"] : ["\(r.nodeId)#\(r.anchor ?? "")"]
}

private func components(_ cons: [VectorConstraint]) -> [[VectorConstraint]] {
    var parent = Array(cons.indices)
    func find(_ start: Int) -> Int {
        var i = start
        while parent[i] != i {
            parent[i] = parent[parent[i]]
            i = parent[i]
        }
        return i
    }
    var owner: [String: Int] = [:]
    for (i, c) in cons.enumerated() {
        // A joint (tangent / smooth at an anchor) and a node's circle reach the whole path.
        let keys = c.refs.flatMap { r in c.kind == "tangent" || c.kind == "smooth" || r.circle ? [r.nodeId] : refKeys(r) + (r.segment ? [r.nodeId] : []) }
        for k in keys + c.refs.map(\.nodeId) {
            if let j = owner[k] {
                let fi = find(i)
                parent[fi] = find(j)
            } else {
                owner[k] = i
            }
        }
    }
    var order: [Int] = []
    var groups: [Int: [VectorConstraint]] = [:]
    for (i, c) in cons.enumerated() {
        let r = find(i)
        if groups[r] == nil { order.append(r) }
        groups[r, default: []].append(c)
    }
    return order.map { groups[$0]! }
}

/// Builds the component systems. `previous` is the last solved document: parameters that differ
/// from it were just edited and get a heavy weight, so the solve moves them least.
private func build(_ doc: VectorDocument, _ cons: [VectorConstraint], _ previous: VectorDocument?) -> (comps: [Comp], skipped: [(id: String, message: String)]) {
    let located = locateNodes(doc)
    let before = previous.map(locateNodes)
    let env = vectorConstraintEnv(doc)
    var skipped: [(id: String, message: String)] = []
    var comps: [Comp] = []
    for group in components(cons) {
        let model = Model(located)
        var built: [Built] = []
        for c in group {
            do {
                let target = VECTOR_DIMENSIONAL_KINDS.contains(c.kind) ? try vectorConstraintValue(env, c) : 0
                built.append(try interpret(c, model, target))
            } catch {
                skipped.append((c.id, constraintErrorMessage(error)))
            }
        }
        if built.isEmpty { continue }
        var weights = model.x0.map { _ in 1.0 }
        if let before {
            // The same slots measured in the previous document: what moved since was just edited.
            let prev = Model(before)
            for slot in model.orderedSlots {
                var off: Int?
                switch slot {
                case let .circle(s): off = prev.circleSlot(s.nodeId)?.off
                case let .point(s):
                    if let loc = before[s.nodeId], loc.node.subpaths.indices.contains(s.subpath), loc.node.subpaths[s.subpath].anchors.indices.contains(s.index) {
                        off = prev.pointSlot(loc, s.subpath, s.index, s.part)?.off
                    }
                }
                let k = slot.isCircle ? 3 : 2
                for i in 0 ..< k {
                    let j = slot.off + i
                    if off == nil || Swift.abs(prev.x0[off! + i] - model.x0[j]) > 1e-9 { weights[j] = 1e6 }
                }
            }
        }
        comps.append(Comp(model, built, weights, scaleTol(model.x0)))
    }
    return (comps, skipped)
}

// MARK: - Public API

/// What a solve did (`VectorSolveResult`).
public struct VectorSolveResult {
    /// The document with the solved geometry (equal to the input when nothing moved).
    public var document: VectorDocument
    /// Every component converged (every constraint holds).
    public var converged: Bool
    /// Constraints in conflict where a component did not converge.
    public var conflicts: [String]
    /// Constraints that could not be interpreted (and were ignored), with the reason.
    public var skipped: [(id: String, message: String)]
}

/// Solves the document's constraints and writes the geometry back (`solveVectorConstraints`).
/// `previous` (the last solved document) marks what was just edited, which moves least. A
/// component that cannot be solved is left with its best compromise and reported in `conflicts`.
public func solveVectorConstraints(_ doc: VectorDocument, _ previous: VectorDocument? = nil) -> VectorSolveResult {
    let cons = Array(vectorConstraints(doc).prefix(VECTOR_MAX_CONSTRAINTS))
    if cons.isEmpty { return VectorSolveResult(document: doc, converged: true, conflicts: [], skipped: []) }
    let (comps, skipped) = build(doc, cons, previous)
    var out = doc
    var converged = true
    var conflicts: [String] = []
    for comp in comps {
        let o: ConstraintSolveOutcome
        do {
            o = try comp.run()
        } catch {
            converged = false
            conflicts += comp.built.map(\.id)
            continue
        }
        if !o.converged {
            converged = false
            conflicts += comp.conflicts(o.x)
        }
        // Nothing moved: keep the document.
        if o.x.indices.contains(where: { Swift.abs(o.x[$0] - comp.model.x0[$0]) > 1e-12 }) { out = comp.model.writeBack(out, o.x) }
    }
    return VectorSolveResult(document: out, converged: converged, conflicts: conflicts, skipped: skipped)
}

/// The largest residual of each constraint at the current geometry (nil when it cannot be
/// interpreted; `vectorConstraintResiduals`).
public func vectorConstraintResiduals(_ doc: VectorDocument) -> [String: Double?] {
    var out: [String: Double?] = [:]
    let env = vectorConstraintEnv(doc)
    let located = locateNodes(doc)
    for c in vectorConstraints(doc) {
        do {
            let model = Model(located)
            let target = VECTOR_DIMENSIONAL_KINDS.contains(c.kind) ? try vectorConstraintValue(env, c) : 0
            let b = try interpret(c, model, target)
            var r: [Double] = []
            b.eval(model.x0, &r)
            out[c.id] = .some(constraintMaxAbs(r))
        } catch {
            out[c.id] = .some(nil)
        }
    }
    return out
}

/// The current value of a dimensional constraint's references (degrees for angles; `measureVectorConstraint`).
public func measureVectorConstraint(_ doc: VectorDocument, kind: String, refs: [VectorGeomRef], axis: String? = nil, id: String = "") throws -> Double {
    let model = Model(locateNodes(doc))
    var json = JSONObject([("id", .string(id)), ("kind", .string(kind)), ("refs", .array(refs.map(\.json)))])
    if let axis { json["axis"] = .string(axis) }
    json["value"] = "1"
    let b = try interpret(VectorConstraint(json: json), model, 1)
    guard let measure = b.measure else { throw VectorConstraintError("\(kind) has no value to measure.") }
    return measure(model.x0)
}

/// Checks a constraint's references against the document (throws with what is needed; `validateVectorConstraint`).
public func validateVectorConstraint(_ doc: VectorDocument, _ c: VectorConstraint) throws {
    for r in c.refs {
        guard let loc = locateNodes(doc)[r.nodeId] else { throw VectorConstraintError("There is no path \"\(r.nodeId)\" (constraints refer to paths, not groups or text).", [c.id]) }
        if let a = r.anchor, findVectorAnchorById(loc.node, a) == nil { throw VectorConstraintError("Path \"\(r.nodeId)\" has no anchor \"\(a)\".", [c.id]) }
        if r.circle && vectorPathCircle(loc.node, loc.world) == nil { throw VectorConstraintError("Path \"\(r.nodeId)\" is not round enough to be a circle.", [c.id]) }
    }
    _ = try interpret(c, Model(locateNodes(doc)), VECTOR_DIMENSIONAL_KINDS.contains(c.kind) ? 1 : 0)
}

/// Next free name for a dimensional constraint (`d1`, `ang2`, `rad1`, `dia1`; `nextVectorConstraintName`).
public func nextVectorConstraintName(_ doc: VectorDocument, _ kind: String) -> String {
    let prefix = kind == "angle" ? "ang" : kind == "radius" ? "rad" : kind == "diameter" ? "dia" : "d"
    let used = Set(vectorParameters(doc).map(\.name) + vectorConstraints(doc).map { $0.name ?? "" })
    var i = 1
    while used.contains("\(prefix)\(i)") { i += 1 }
    return "\(prefix)\(i)"
}

/// Adds a constraint to the document (`addVectorConstraint`): names and measures a dimensional one
/// without a value, refuses one that conflicts with the others or duplicates them
/// (over-constrains), solves and returns the new document. Throws a `VectorConstraintError`
/// naming the constraints involved. `input` is the constraint's JSON (`{ id, kind, refs, … }`).
public func addVectorConstraint(_ doc: VectorDocument, _ input: JSONObject) throws -> VectorDocument {
    let existing = vectorConstraints(doc)
    if existing.count >= VECTOR_MAX_CONSTRAINTS { throw VectorConstraintError("Too many constraints.") }
    var cj = input
    var c = VectorConstraint(json: cj)
    try validateVectorConstraint(doc, c)
    if VECTOR_DIMENSIONAL_KINDS.contains(c.kind) {
        let name = c.name ?? nextVectorConstraintName(doc, c.kind)
        if !isValidVectorParameterName(name) { throw VectorConstraintError("\"\(name)\" is not a valid name: a letter or _ then letters, digits or _.") }
        if vectorParameters(doc).contains(where: { $0.name == name }) || existing.contains(where: { $0.name == name }) { throw VectorConstraintError("The name \"\(name)\" is already used.") }
        // The new values are computed from `c` before the spread writes them.
        let trimmed = c.value?.jsTrimmed ?? ""
        let value = !trimmed.isEmpty ? trimmed : formatVectorValue(try measureVectorConstraint(doc, kind: c.kind, refs: c.refs, axis: c.axis, id: c.id))
        cj["name"] = .string(name)
        cj["value"] = .string(value)
    } else {
        remove(&cj, "name")
        remove(&cj, "value")
    }
    c = VectorConstraint(json: cj)
    let all = existing + [c]
    let trial = withVectorConstraints(doc, all)
    let (comps, skipped) = build(trial, all, nil)
    if let own = skipped.first(where: { $0.id == c.id }) { throw VectorConstraintError(own.message, [c.id]) }
    guard let comp = comps.first(where: { $0.built.contains { $0.id == c.id } }) else { throw VectorConstraintError("The constraint could not be interpreted.", [c.id]) }
    let o = try comp.run()
    func quoted(_ ids: [String]) -> String { ids.map { "\"\($0)\"" }.joined(separator: ", ") }
    if !o.converged {
        let ids = comp.conflicts(o.x).filter { $0 != c.id }
        throw VectorConstraintError("The constraint conflicts with \(ids.isEmpty ? "the existing constraints" : quoted(ids)).", [c.id] + ids)
    }
    let pos = comp.built.firstIndex { $0.id == c.id }!
    let nb = comp.built[pos]
    if nb.rows > 0 {
        // The new rows must raise the rank, or they only repeat what is already there.
        let free = comp.free()
        let others = comp.built.filter { $0.id != c.id }
        let ordered = others + [nb]
        let f: ResidualFn = { x, out in for b in ordered { b.eval(x, &out) } }
        let rowsAll = ordered.reduce(0) { $0 + $1.rows }
        let rowsOld = rowsAll - nb.rows
        let jac = constraintJacobian(f, o.x, free, rowsAll)
        if constraintRankQr(jac, rowsAll, free.count) < constraintRankQr(Array(jac[0 ..< rowsOld * free.count]), rowsOld, free.count) + nb.rows {
            let mine = Set(nb.refs.map(\.nodeId))
            let ids = others.filter { $0.refs.contains { mine.contains($0.nodeId) } }.map(\.id)
            throw VectorConstraintError("The constraint would over-constrain the geometry (redundant with \(ids.isEmpty ? "existing constraints" : quoted(ids))).", [c.id] + ids)
        }
    } else if !nb.locks.isEmpty {
        let before = comp.free(pos)
        let after = Set(comp.free())
        let locked = before.enumerated().filter { !after.contains($0.element) }.map(\.offset)
        let rowsOld = comp.rows(pos)
        let nf = before.count
        var jac = constraintJacobian(comp.evalFn(pos), o.x, before, rowsOld)
        let rOld = constraintRankQr(jac, rowsOld, nf)
        for k in locked { for col in 0 ..< nf { jac.append(col == k ? 1 : 0) } }
        if locked.isEmpty || constraintRankQr(jac, rowsOld + locked.count, nf) < rOld + locked.count {
            let mine = Set(nb.refs.map(\.nodeId))
            let ids = comp.built.filter { $0.id != c.id && $0.refs.contains { mine.contains($0.nodeId) } }.map(\.id)
            throw VectorConstraintError("The Fix would over-constrain the geometry (redundant with \(ids.isEmpty ? "existing constraints" : quoted(ids))).", [c.id] + ids)
        }
    }
    return comp.model.writeBack(trial, o.x)
}

/// Degrees of freedom the constraints leave (`VectorDofReport`).
public struct VectorDofReport: Equatable, Sendable {
    public struct NodeEntry: Equatable, Sendable {
        public var nodeId: String
        public var params: Int
        public var dof: Int?
        public var status: String
    }
    /// Remaining degrees of freedom (nil when too large to analyse).
    public var dof: Int?
    /// `unconstrained`, `under`, `fully`, `over` or `unknown`.
    public var status: String
    /// Equations that only repeat others.
    public var redundant: Int
    public var constraints: Int
    /// Per constrained path: its parameters and remaining freedom.
    public var nodes: [NodeEntry]
    public var message: String

    /// `{ dof, status, redundant, constraints, nodes, message }`.
    public var json: JSONValue {
        let nodes: [JSONValue] = self.nodes.map { e in
            .object(JSONObject([("nodeId", .string(e.nodeId)), ("params", .number(Double(e.params))), ("dof", e.dof.map { .number(Double($0)) } ?? .null), ("status", .string(e.status))]))
        }
        return .object(JSONObject([
            ("dof", dof.map { .number(Double($0)) } ?? .null), ("status", .string(status)), ("redundant", .number(Double(redundant))),
            ("constraints", .number(Double(constraints))), ("nodes", .array(nodes)), ("message", .string(message)),
        ]))
    }
}

/// Degrees of freedom the constraints leave (QR rank of the Jacobian per component; per path by
/// null space; `vectorConstraintDof`).
public func vectorConstraintDof(_ doc: VectorDocument) -> VectorDofReport {
    let cons = vectorConstraints(doc)
    if cons.isEmpty { return VectorDofReport(dof: 0, status: "unconstrained", redundant: 0, constraints: 0, nodes: [], message: "No constraints") }
    let (comps, _) = build(doc, cons, nil)
    var total: Int? = 0
    var redundant = 0
    var count = 0
    var nodeKeys: [String] = []
    var nodes: [String: (params: Int, dof: Int?, over: Bool)] = [:]
    for comp in comps {
        let free = comp.free()
        let rows = comp.rows()
        count += comp.built.count
        let nf = free.count
        if rows > CONSTRAINT_MAX_ROWS {
            total = nil
            continue
        }
        let jac = constraintJacobian(comp.evalFn(), comp.model.x0, free, rows)
        let (rank, basis) = constraintNullSpace(jac, rows, nf)
        let red = Swift.max(0, rows - rank)
        redundant += red
        if let t = total { total = t + nf - Swift.min(rank, nf) }
        for slot in comp.model.orderedSlots {
            let k = slot.isCircle ? 3 : 2
            var cols: [Int] = []
            for (c, j) in free.enumerated() where j >= slot.off && j < slot.off + k { cols.append(c) }
            if nodes[slot.nodeId] == nil { nodeKeys.append(slot.nodeId) }
            var e = nodes[slot.nodeId] ?? (0, 0, false)
            e.params += k
            if let d = e.dof { e.dof = d + (!cols.isEmpty && !basis.isEmpty ? constraintQr(basis.map { v in cols.map { v[$0] } }, 0, 1e-6).rank : 0) }
            e.over = e.over || red > 0
            nodes[slot.nodeId] = e
        }
    }
    let status = redundant > 0 ? "over" : total == nil ? "unknown" : total == 0 ? "fully" : "under"
    func plural(_ n: Int, _ one: String, _ many: String) -> String { "\(n) \(n == 1 ? one : many)" }
    let message: String
    if status == "over" { message = "Over-constrained: \(plural(redundant, "redundant equation", "redundant equations"))" }
    else if status == "fully" { message = "Fully constrained" }
    else if let t = total { message = "\(plural(t, "degree of freedom", "degrees of freedom")) remaining" }
    else { message = "Too large to analyse" }
    let entries = nodeKeys.map { id -> VectorDofReport.NodeEntry in
        let e = nodes[id]!
        return VectorDofReport.NodeEntry(nodeId: id, params: e.params, dof: e.dof, status: e.over ? "over" : e.dof == 0 ? "fully" : e.dof == nil ? "unknown" : "under")
    }
    return VectorDofReport(dof: total, status: status, redundant: redundant, constraints: count, nodes: entries, message: message)
}

/// Constraints whose references are gone (deleted paths or anchors) or no longer fit, removed
/// (`purgeVectorConstraints`).
public func purgeVectorConstraints(_ doc: VectorDocument) -> (document: VectorDocument, removed: [String]) {
    let cons = vectorConstraints(doc)
    if cons.isEmpty { return (doc, []) }
    let located = locateNodes(doc)
    var removed: [String] = []
    let kept = cons.filter { c in
        let ok = c.refs.allSatisfy { r in
            guard let loc = located[r.nodeId] else { return false }
            guard let anchor = r.anchor else { return !r.circle || vectorPathCircle(loc.node, loc.world) != nil }
            guard let at = findVectorAnchorById(loc.node, anchor) else { return false }
            // A segment needs the anchor after it.
            let sp = loc.node.subpaths[at.subpath]
            return !r.segment || (sp.anchors.count > 1 && (at.index + 1 < sp.anchors.count || sp.closed))
        }
        if !ok { removed.append(c.id) }
        return ok
    }
    return removed.isEmpty ? (doc, removed) : (withVectorConstraints(doc, kept), removed)
}
