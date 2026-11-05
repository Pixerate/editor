import Foundation
import PixerateRaster

// Curve-preserving boolean operations (`canvas/pathops/boolean.ts`): monotone pieces split at
// every crossing by subdivision, coincident pieces merged, winding classification by rays, and
// rings traced and rebuilt as exact sub-curves of the inputs. Falls back to `polygonBoolean`.

// MARK: - Public types

/// Boolean operations (same names as `polygonBoolean`). `xor` is Exclude.
public typealias PathBooleanOperation = PolygonBooleanOperation

/// A path with the fill rule it is read with (default `nonzero`). A bare path converts to one.
public struct PathOperand: Sendable, ExpressibleByStringLiteral {
    public var path: BezierPathInput
    public var fillRule: PolygonFillRule?
    public init(_ path: BezierPathInput, fillRule: PolygonFillRule? = nil) {
        self.path = path
        self.fillRule = fillRule
    }
    public init(stringLiteral value: String) { self.init(.svg(value)) }
}

public struct PathOpsOptions {
    /// Distance below which points are treated as equal (default 1e-9 × the largest coordinate).
    public var epsilon: Double?
    /// Fall back to the polygon engine when the curve engine fails (default `true`).
    public var fallback: Bool?
    /// Flattening tolerance used by the polygon fallback (default 0.05).
    public var fallbackTolerance: Double?
    /// Called with the reason whenever the polygon fallback is used.
    public var onFallback: ((String) -> Void)?
    /// Work budget of the curve–curve intersection search (default 20,000).
    public var subdivisionBudget: Double?

    public init(
        epsilon: Double? = nil, fallback: Bool? = nil, fallbackTolerance: Double? = nil,
        onFallback: ((String) -> Void)? = nil, subdivisionBudget: Double? = nil
    ) {
        self.epsilon = epsilon
        self.fallback = fallback
        self.fallbackTolerance = fallbackTolerance
        self.onFallback = onFallback
        self.subdivisionBudget = subdivisionBudget
    }
}

/// Which engine produced a result.
public enum PathOpsEngine: String, Sendable {
    case curve, polygon
}

/// Which engine produced a result, and why the curve engine was not used.
public struct PathOpsReport: Equatable, Sendable {
    public var engine: PathOpsEngine
    public var fallbackReason: String?
    /// Set when the input cannot be processed at all (non-finite coordinates); the result is empty.
    public var error: String?
    public init(engine: PathOpsEngine, fallbackReason: String? = nil, error: String? = nil) {
        self.engine = engine
        self.fallbackReason = fallbackReason
        self.error = error
    }
}

public struct PathBooleanResult: Sendable {
    public var path: BezierPath
    public var report: PathOpsReport
}

/// One region of `dividePaths`, with the indices of the operands that cover it.
public struct PathPiece: Sendable {
    public var path: BezierPath
    public var operands: [Int]
}

public struct DividePathsResult: Sendable {
    public var pieces: [PathPiece]
    public var report: PathOpsReport
}

/// Raised by the curve engine when it cannot produce a reliable arrangement.
public struct PathOpsError: Error, CustomStringConvertible, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

// MARK: - Operands

private struct NormalizedOperand {
    var chains: [[BezierSegment]]
    var fillRule: PolygonFillRule
}

private func normalizeOperand(_ input: PathOperand) throws -> NormalizedOperand {
    var chains: [[BezierSegment]] = []
    for contour in pathToContours(input.path) {
        let chain = closeContour(contour, true)
        if chain.isEmpty { continue }
        for seg in chain {
            for p in seg where !p[0].isFinite || !p[1].isFinite { throw PathOpsError(NON_FINITE) }
        }
        chains.append(chain)
    }
    return NormalizedOperand(chains: chains, fillRule: input.fillRule ?? .nonzero)
}

private func scaleOf(_ operandChains: [[[BezierSegment]]]) -> Double {
    var max = 0.0
    for chains in operandChains {
        for chain in chains {
            for seg in chain {
                for p in seg { max = jmax(max, abs(p[0]), abs(p[1])) }
            }
        }
    }
    return jmax(1, max)
}

// MARK: - Arrangement data

private struct Vertex {
    var id: Int
    var x: Double
    var y: Double
    var p: PathPoint
    static func === (a: Vertex, b: Vertex) -> Bool { a.id == b.id }
    static func !== (a: Vertex, b: Vertex) -> Bool { a.id != b.id }
}

private struct CellKey: Hashable {
    var x: Double
    var y: Double
}

/// Merges points closer than `eps` (grid hash with neighbour lookup).
private final class VertexPool {
    var vertices: [Vertex] = []
    private var cells: [CellKey: [Int]] = [:]
    private let eps: Double
    init(_ eps: Double) { self.eps = eps }

    func get(_ x: Double, _ y: Double) -> Vertex {
        let cx = JS.floor(x / eps)
        let cy = JS.floor(y / eps)
        var best: Vertex?
        var bestDist = Double.infinity
        for dx in -1...1 {
            for dy in -1...1 {
                guard let ids = cells[CellKey(x: cx + Double(dx), y: cy + Double(dy))] else { continue }
                for id in ids {
                    let v = vertices[id]
                    let d = hypot(v.x - x, v.y - y)
                    if d <= eps && d < bestDist {
                        best = v
                        bestDist = d
                    }
                }
            }
        }
        if let best { return best }
        let vertex = Vertex(id: vertices.count, x: x, y: y, p: Point(x, y))
        vertices.append(vertex)
        cells[CellKey(x: cx, y: cy), default: []].append(vertex.id)
        return vertex
    }
}

private struct Source {
    var seg: BezierSegment
    var line: Bool
}

private struct Hull {
    var minX: Double
    var maxX: Double
    var minY: Double
    var maxY: Double
}

private final class Piece {
    var pts: [PathPoint]
    var a: Vertex
    var b: Vertex
    var operand: Int
    var src: Int
    /// Source parameters at `a` and `b` (`s0 < s1`).
    var s0: Double
    var s1: Double
    var dirty = true
    var minX: Double
    var maxX: Double
    var minY: Double
    var maxY: Double

    init(pts: [PathPoint], a: Vertex, b: Vertex, operand: Int, src: Int, s0: Double, s1: Double, hull h: Hull) {
        self.pts = pts
        self.a = a
        self.b = b
        self.operand = operand
        self.src = src
        self.s0 = s0
        self.s1 = s1
        minX = h.minX
        maxX = h.maxX
        minY = h.minY
        maxY = h.maxY
    }
}

private func hull(_ pts: [PathPoint]) -> Hull {
    var minX = Double.infinity
    var maxX = -Double.infinity
    var minY = Double.infinity
    var maxY = -Double.infinity
    for p in pts {
        let x = p[0], y = p[1]
        if x < minX { minX = x }
        if x > maxX { maxX = x }
        if y < minY { minY = y }
        if y > maxY { maxY = y }
    }
    return Hull(minX: minX, maxX: maxX, minY: minY, maxY: maxY)
}

/// Moves the end points of a segment onto two vertices, dragging the handles along.
private func snapEnds(_ pts: [PathPoint], _ a: PathPoint, _ b: PathPoint) -> [PathPoint] {
    let n = pts.count
    if n == 2 { return [a, b] }
    let d0 = sub(a, pts[0])
    let d1 = sub(b, pts[n - 1])
    if n == 3 {
        return [a, Point(pts[1][0] + (d0[0] + d1[0]) / 2, pts[1][1] + (d0[1] + d1[1]) / 2), b]
    }
    return [a, Point(pts[1][0] + d0[0], pts[1][1] + d0[1]), Point(pts[2][0] + d1[0], pts[2][1] + d1[1]), b]
}

private func makePiece(_ pts: [PathPoint], _ a: Vertex, _ b: Vertex, _ operand: Int, _ src: Int, _ s0: Double, _ s1: Double) -> Piece {
    let snapped = snapEnds(pts, a.p, b.p)
    return Piece(pts: snapped, a: a, b: b, operand: operand, src: src, s0: s0, s1: s1, hull: hull(snapped))
}

// MARK: - Intersections

private struct PairEvent {
    var tp: Double
    var tq: Double
    var point: PathPoint
    /// Set for shared end points and end points lying on the other piece.
    var anchor = false
    /// Shared vertex: nothing to split.
    var shared = false
}

private final class IntersectContext {
    var eps: Double
    var leaves = 0
    var budget: Double
    init(eps: Double, budget: Double) {
        self.eps = eps
        self.budget = budget
    }
}

private let NON_FINITE = "non-finite coordinates"

private func flatness(_ pts: [PathPoint]) -> Double {
    if pts.count == 2 { return 0 }
    let a = pts[0]
    let b = pts[pts.count - 1]
    let chord = sub(b, a)
    let len = hypot(chord[0], chord[1])
    var worst = 0.0
    for i in 1..<(pts.count - 1) {
        let v = sub(pts[i], a)
        let d = len > 0 ? abs(cross(chord, v)) / len : hypot(v[0], v[1])
        let along = len > 0 ? dot(chord, v) / len : 0
        let over = jmax(0, -along, along - len)
        worst = jmax(worst, d, over)
    }
    return worst
}

private func split2(_ pts: [PathPoint]) -> ([PathPoint], [PathPoint]) {
    let n = pts.count
    func mid(_ p: PathPoint, _ q: PathPoint) -> PathPoint { Point((p[0] + q[0]) / 2, (p[1] + q[1]) / 2) }
    if n == 2 {
        let m = mid(pts[0], pts[1])
        return ([pts[0], m], [m, pts[1]])
    }
    if n == 3 {
        let a = mid(pts[0], pts[1])
        let b = mid(pts[1], pts[2])
        let m = mid(a, b)
        return ([pts[0], a, m], [m, b, pts[2]])
    }
    let a = mid(pts[0], pts[1])
    let b = mid(pts[1], pts[2])
    let c = mid(pts[2], pts[3])
    let ab = mid(a, b)
    let bc = mid(b, c)
    let m = mid(ab, bc)
    return ([pts[0], a, ab, m], [m, bc, c, pts[3]])
}

/// Closest points of two segments: parameters and distance.
private func closestSegmentPoints(_ a0: PathPoint, _ a1: PathPoint, _ b0: PathPoint, _ b1: PathPoint) -> (s: Double, u: Double, d: Double) {
    let d1 = sub(a1, a0)
    let d2 = sub(b1, b0)
    let r = sub(a0, b0)
    let a = dot(d1, d1)
    let e = dot(d2, d2)
    let f = dot(d2, r)
    var s = 0.0
    var u = 0.0
    if a <= 1e-300 && e <= 1e-300 { return (0, 0, dist(a0, b0)) }
    if a <= 1e-300 {
        u = jmax(0, jmin(1, f / e))
    } else {
        let c = dot(d1, r)
        if e <= 1e-300 {
            s = jmax(0, jmin(1, -c / a))
        } else {
            let b = dot(d1, d2)
            let denom = a * e - b * b
            s = denom > 0 ? jmax(0, jmin(1, (b * f - c * e) / denom)) : 0
            u = (b * s + f) / e
            if u < 0 {
                u = 0
                s = jmax(0, jmin(1, -c / a))
            } else if u > 1 {
                u = 1
                s = jmax(0, jmin(1, (b - c) / a))
            }
        }
    }
    let pa = Point(a0[0] + d1[0] * s, a0[1] + d1[1] * s)
    let pb = Point(b0[0] + d2[0] * u, b0[1] + d2[1] * u)
    return (s, u, dist(pa, pb))
}

/// Newton polishing of P(s) = Q(u). Returns the best parameters found.
private func polish(_ P: [PathPoint], _ Q: [PathPoint], _ sIn: Double, _ uIn: Double) -> (s: Double, u: Double, d: Double) {
    var s = sIn
    var u = uIn
    var best = (s: s, u: u, d: dist(segmentPoint(P, s), segmentPoint(Q, u)))
    var i = 0
    while i < 10 && best.d > 0 {
        defer { i += 1 }
        let f = sub(segmentPoint(P, s), segmentPoint(Q, u))
        let dp = segmentDerivative(P, s)
        let dq = segmentDerivative(Q, u)
        // Solve [dp, -dq] [ds, du]^T = -f
        let det = cross(dp, Point(-dq[0], -dq[1]))
        if !(abs(det) > 1e-300) { break }
        let ds = cross(Point(-f[0], -f[1]), Point(-dq[0], -dq[1])) / det
        let du = cross(dp, Point(-f[0], -f[1])) / det
        s = jmax(0, jmin(1, s + ds))
        u = jmax(0, jmin(1, u + du))
        let d = dist(segmentPoint(P, s), segmentPoint(Q, u))
        if d < best.d { best = (s, u, d) } else { break }
    }
    return best
}

private func intersectSubdivided(
    _ P: [PathPoint], _ p0: Double, _ p1: Double, _ Q: [PathPoint], _ q0: Double, _ q1: Double,
    _ fullP: [PathPoint], _ fullQ: [PathPoint], _ ctx: IntersectContext, _ out: inout [PairEvent], _ depth: Int
) throws {
    let hp = hull(P)
    let hq = hull(Q)
    let e = ctx.eps
    if hp.minX > hq.maxX + e || hq.minX > hp.maxX + e || hp.minY > hq.maxY + e || hq.minY > hp.maxY + e { return }
    let fp = flatness(P)
    let fq = flatness(Q)
    let flatTol = e * 0.5
    if (fp <= flatTol && fq <= flatTol) || depth >= 52 {
        ctx.leaves += 1
        if Double(ctx.leaves) > ctx.budget { throw PathOpsError("curve intersection did not converge") }
        let a0 = P[0]
        let a1 = P[P.count - 1]
        let b0 = Q[0]
        let b1 = Q[Q.count - 1]
        let d1 = sub(a1, a0)
        let d2 = sub(b1, b0)
        let denom = cross(d1, d2)
        var s = 0.0
        var u = 0.0
        var hit = false
        let l1 = hypot(d1[0], d1[1])
        let l2 = hypot(d2[0], d2[1])
        if abs(denom) > 1e-12 * l1 * l2 {
            let r = sub(b0, a0)
            s = cross(r, d2) / denom
            u = cross(r, d1) / denom
            let ts = l1 > 0 ? e / l1 : 1
            let tu = l2 > 0 ? e / l2 : 1
            hit = s >= -ts && s <= 1 + ts && u >= -tu && u <= 1 + tu
        }
        if !hit {
            // No crossing of the chords: a touch when they come within epsilon.
            let c = closestSegmentPoints(a0, a1, b0, b1)
            if c.d > e { return }
            s = c.s
            u = c.u
        }
        s = jmax(0, jmin(1, s))
        u = jmax(0, jmin(1, u))
        let best = polish(fullP, fullQ, p0 + (p1 - p0) * s, q0 + (q1 - q0) * u)
        if best.d > e * 2 { return }
        let a = segmentPoint(fullP, best.s)
        let b = segmentPoint(fullQ, best.u)
        out.append(PairEvent(tp: best.s, tq: best.u, point: Point((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)))
        return
    }
    let splitP = fp > flatTol
    let splitQ = fq > flatTol
    let pm = (p0 + p1) / 2
    let qm = (q0 + q1) / 2
    if splitP && splitQ {
        let (pa, pb) = split2(P)
        let (qa, qb) = split2(Q)
        try intersectSubdivided(pa, p0, pm, qa, q0, qm, fullP, fullQ, ctx, &out, depth + 1)
        try intersectSubdivided(pa, p0, pm, qb, qm, q1, fullP, fullQ, ctx, &out, depth + 1)
        try intersectSubdivided(pb, pm, p1, qa, q0, qm, fullP, fullQ, ctx, &out, depth + 1)
        try intersectSubdivided(pb, pm, p1, qb, qm, q1, fullP, fullQ, ctx, &out, depth + 1)
    } else if splitP {
        let (pa, pb) = split2(P)
        try intersectSubdivided(pa, p0, pm, Q, q0, q1, fullP, fullQ, ctx, &out, depth + 1)
        try intersectSubdivided(pb, pm, p1, Q, q0, q1, fullP, fullQ, ctx, &out, depth + 1)
    } else {
        let (qa, qb) = split2(Q)
        try intersectSubdivided(P, p0, p1, qa, q0, qm, fullP, fullQ, ctx, &out, depth + 1)
        try intersectSubdivided(P, p0, p1, qb, qm, q1, fullP, fullQ, ctx, &out, depth + 1)
    }
}

/// A crossing or touch of two segments: the parameter on each and the point.
public struct SegmentIntersection: Equatable, Sendable {
    public var ta: Double
    public var tb: Double
    public var point: PathPoint
}

/// Every point where two segments cross or touch, by the subdivision search the boolean
/// operations use. Hits closer than `epsilon` (default 1e-9 of the segments' size) are one.
public func segmentIntersections(_ a: BezierSegment, _ b: BezierSegment, epsilon: Double? = nil, budget: Double? = nil) -> [SegmentIntersection] {
    var size = 1.0
    for p in a + b { size = jmax(size, abs(p[0]), abs(p[1])) }
    let eps = epsilon ?? size * 1e-9
    var found: [PairEvent] = []
    let ctx = IntersectContext(eps: eps, budget: budget ?? 4096)
    do {
        try intersectSubdivided(a, 0, 1, b, 0, 1, a, b, ctx, &found, 0)
    } catch {}
    var out: [SegmentIntersection] = []
    for ev in jsSorted(found, { x, y in x.tp - y.tp }) {
        if out.contains(where: { dist($0.point, ev.point) <= eps * 4 }) { continue }
        out.append(SegmentIntersection(ta: ev.tp, tb: ev.tq, point: ev.point))
    }
    return out
}

private func nearestOn(_ piece: Piece, _ p: PathPoint, _ eps: Double) -> (t: Double, distance: Double)? {
    if p[0] < piece.minX - eps || p[0] > piece.maxX + eps || p[1] < piece.minY - eps || p[1] > piece.maxY + eps { return nil }
    return segmentNearest(piece.pts, p)
}

/// Whether the two pieces stay within `tol` of each other between two events.
private func staysClose(_ P: Piece, _ Q: Piece, _ e1: PairEvent, _ e2: PairEvent, _ tol: Double) -> Bool {
    for f in [0.25, 0.5, 0.75] {
        let tp = e1.tp + (e2.tp - e1.tp) * f
        let q = segmentNearest(Q.pts, segmentPoint(P.pts, tp))
        if q.distance > tol { return false }
    }
    return true
}

/// `x || y` on numbers: `y` when `x` is 0 or NaN.
@inline(__always) private func or(_ x: Double, _ y: @autoclosure () -> Double) -> Double { x != 0 && !x.isNaN ? x : y() }

private func pairEvents(_ P: Piece, _ Q: Piece, _ ctx: IntersectContext) throws -> [PairEvent] {
    let eps = ctx.eps
    var anchors: [PairEvent] = []
    // Shared vertices.
    for (va, tp) in [(P.a, 0.0), (P.b, 1.0)] {
        if va === Q.a {
            anchors.append(PairEvent(tp: tp, tq: 0, point: va.p, anchor: true, shared: true))
        } else if va === Q.b {
            anchors.append(PairEvent(tp: tp, tq: 1, point: va.p, anchor: true, shared: true))
        }
    }
    // End points lying on the other piece (T-junctions, overlaps).
    for (v, tq) in [(Q.a, 0.0), (Q.b, 1.0)] {
        if v === P.a || v === P.b { continue }
        if let near = nearestOn(P, v.p, eps), near.distance <= eps { anchors.append(PairEvent(tp: near.t, tq: tq, point: v.p, anchor: true)) }
    }
    for (v, tp) in [(P.a, 0.0), (P.b, 1.0)] {
        if v === Q.a || v === Q.b { continue }
        if let near = nearestOn(Q, v.p, eps), near.distance <= eps { anchors.append(PairEvent(tp: tp, tq: near.t, point: v.p, anchor: true)) }
    }

    // Coincident overlap: two anchors with the pieces running together between them.
    if anchors.count >= 2 {
        let sorted = jsSorted(anchors) { x, y in x.tp - y.tp }
        let first = sorted[0]
        let last = sorted[sorted.count - 1]
        if dist(first.point, last.point) > eps && staysClose(P, Q, first, last, eps * 4) {
            return anchors.filter { !$0.shared }
        }
    }

    var found: [PairEvent] = []
    if P.pts.count == 2 && Q.pts.count == 2 {
        let a0 = P.pts[0]
        let d1 = sub(P.pts[1], a0)
        let b0 = Q.pts[0]
        let d2 = sub(Q.pts[1], b0)
        let denom = cross(d1, d2)
        let l1 = hypot(d1[0], d1[1])
        let l2 = hypot(d2[0], d2[1])
        if abs(denom) > 1e-12 * l1 * l2 {
            let r = sub(b0, a0)
            let s = cross(r, d2) / denom
            let u = cross(r, d1) / denom
            let ts = eps / l1
            let tu = eps / l2
            if s >= -ts && s <= 1 + ts && u >= -tu && u <= 1 + tu {
                let sc = jmax(0, jmin(1, s))
                let uc = jmax(0, jmin(1, u))
                found.append(PairEvent(tp: sc, tq: uc, point: Point(a0[0] + d1[0] * sc, a0[1] + d1[1] * sc)))
            }
        }
    } else {
        ctx.leaves = 0
        try intersectSubdivided(P.pts, 0, 1, Q.pts, 0, 1, P.pts, Q.pts, ctx, &found, 0)
    }
    if found.isEmpty { return anchors.filter { !$0.shared } }

    // Cluster hits along tangencies: consecutive events between which the pieces never
    // separate by more than a few epsilon are one contact.
    let all = jsSorted(anchors + found) { x, y in or(x.tp - y.tp, x.tq - y.tq) }
    var clusters: [[PairEvent]] = []
    for ev in all {
        if let prev = clusters.last?.last, dist(prev.point, ev.point) <= eps * 2 || staysClose(P, Q, prev, ev, eps * 2) {
            clusters[clusters.count - 1].append(ev)
        } else {
            clusters.append([ev])
        }
    }
    var out: [PairEvent] = []
    for cluster in clusters {
        if cluster.contains(where: \.shared) { continue }
        out.append(cluster.first(where: \.anchor) ?? cluster[cluster.count / 2])
    }
    return out
}

private struct SplitPoint {
    var t: Double
    var v: Vertex
}

private func addSplit(_ map: inout [ObjectIdentifier: [SplitPoint]], _ piece: Piece, _ t: Double, _ v: Vertex) {
    if v === piece.a || v === piece.b { return }
    map[ObjectIdentifier(piece), default: []].append(SplitPoint(t: t, v: v))
}

/// Resolves an event to a vertex, preferring the pieces' own end points.
private func eventVertex(_ P: Piece, _ Q: Piece, _ ev: PairEvent, _ pool: VertexPool, _ eps: Double) -> Vertex {
    for v in [P.a, P.b, Q.a, Q.b] where dist(v.p, ev.point) <= eps { return v }
    return pool.get(ev.point[0], ev.point[1])
}

private func splitPass(_ pieces: [Piece], _ pool: VertexPool, _ ctx: IntersectContext) throws -> (pieces: [Piece], changed: Bool) {
    let eps = ctx.eps
    let order = jsSorted(Array(pieces.indices)) { i, j in pieces[i].minX - pieces[j].minX }
    var splits: [ObjectIdentifier: [SplitPoint]] = [:]
    for oi in 0..<order.count {
        let P = pieces[order[oi]]
        var oj = oi + 1
        while oj < order.count {
            defer { oj += 1 }
            let Q = pieces[order[oj]]
            if Q.minX > P.maxX + eps { break }
            if !P.dirty && !Q.dirty { continue }
            if Q.minY > P.maxY + eps || Q.maxY < P.minY - eps { continue }
            if P.a === Q.a && P.b === Q.b && P.pts.count == 2 && Q.pts.count == 2 { continue }
            if P.a === Q.b && P.b === Q.a && P.pts.count == 2 && Q.pts.count == 2 { continue }
            for ev in try pairEvents(P, Q, ctx) {
                let v = eventVertex(P, Q, ev, pool, eps)
                addSplit(&splits, P, ev.tp, v)
                addSplit(&splits, Q, ev.tq, v)
            }
        }
    }
    for p in pieces { p.dirty = false }
    if splits.isEmpty { return (pieces, false) }
    var out: [Piece] = []
    for piece in pieces {
        guard let unsorted = splits[ObjectIdentifier(piece)] else {
            out.append(piece)
            continue
        }
        let list = jsSorted(unsorted) { x, y in x.t - y.t }
        var prevT = 0.0
        var prevV = piece.a
        let range = piece.s1 - piece.s0
        var seen = Set<Int>()
        for sp in list {
            let t = sp.t, v = sp.v
            if seen.contains(v.id) || t <= 0 || t >= 1 { continue }
            seen.insert(v.id)
            // emit(t, v)
            if v === prevV || t <= prevT { continue }
            let pts = subSegment(piece.pts, prevT, t)
            out.append(makePiece(pts, prevV, v, piece.operand, piece.src, piece.s0 + range * prevT, piece.s0 + range * t))
            prevT = t
            prevV = v
        }
        if prevV !== piece.b {
            let pts = subSegment(piece.pts, prevT, 1)
            out.append(makePiece(pts, prevV, piece.b, piece.operand, piece.src, piece.s0 + range * prevT, piece.s1))
        }
    }
    return (out, true)
}

// MARK: - Edges and classification

private final class Edge {
    var a: Vertex
    var b: Vertex
    /// Control points from `a` to `b`.
    var pts: [PathPoint]
    var mult: [Int]
    var src: Int
    /// Source parameters at `a` and at `b`.
    var sa: Double
    var sb: Double
    var minX: Double
    var maxX: Double
    var minY: Double
    var maxY: Double

    init(a: Vertex, b: Vertex, pts: [PathPoint], mult: [Int], src: Int, sa: Double, sb: Double) {
        self.a = a
        self.b = b
        self.pts = pts
        self.mult = mult
        self.src = src
        self.sa = sa
        self.sb = sb
        let h = hull(pts)
        minX = h.minX
        maxX = h.maxX
        minY = h.minY
        maxY = h.maxY
    }
}

private struct Arrangement {
    var edges: [Edge]
    var left: [[Int]]
    var right: [[Int]]
    var fillRules: [PolygonFillRule]
    var sources: [Source]
    var eps: Double
    var scale: Double
}

/// Cuts every chain of every operand into monotone pieces and splits them where they meet.
private func splitChains(
    _ operandChains: [[[BezierSegment]]], _ options: PathOpsOptions
) throws -> (pieces: [Piece], pool: VertexPool, sources: [Source], eps: Double, scale: Double) {
    let scale = scaleOf(operandChains)
    let eps = (options.epsilon ?? 0) > 0 ? options.epsilon! : 1e-9 * scale
    let pool = VertexPool(eps)
    var sources: [Source] = []
    var pieces: [Piece] = []
    for (operand, chains) in operandChains.enumerated() {
        for chain in chains {
            for raw in chain {
                let straight = raw.count > 2 && isStraightSegment(raw, eps * 0.01)
                let seg: BezierSegment = straight ? [raw[0], raw[raw.count - 1]] : raw
                let src = sources.count
                sources.append(Source(seg: seg, line: seg.count == 2))
                let ts = [0] + monotoneParams(seg) + [1]
                var i = 0
                while i + 1 < ts.count {
                    defer { i += 1 }
                    let pts = subSegment(seg, ts[i], ts[i + 1])
                    let a = pool.get(pts[0][0], pts[0][1])
                    let b = pool.get(pts[pts.count - 1][0], pts[pts.count - 1][1])
                    if a === b { continue }
                    pieces.append(makePiece(pts, a, b, operand, src, ts[i], ts[i + 1]))
                }
            }
        }
    }

    let ctx = IntersectContext(eps: eps, budget: options.subdivisionBudget ?? 20000)
    var settled = false
    for _ in 0..<6 {
        let result = try splitPass(pieces, pool, ctx)
        pieces = result.pieces
        if !result.changed {
            settled = true
            break
        }
    }
    if !settled { throw PathOpsError("intersections did not settle") }
    return (pieces, pool, sources, eps, scale)
}

/// Whether two pieces between the same two vertices (`pts` in the same direction) coincide.
private func samePiece(_ e: [PathPoint], _ pts: [PathPoint], _ eps: Double) -> Bool {
    if e.count == 2 && pts.count == 2 { return true }
    return segmentNearest(e, segmentPoint(pts, 0.5)).distance <= eps * 4 && segmentNearest(pts, segmentPoint(e, 0.5)).distance <= eps * 4
}

private struct PairKey: Hashable {
    var a: Int
    var b: Int
}

private func buildArrangement(_ inputs: [PathOperand], _ options: PathOpsOptions) throws -> Arrangement {
    let operands = try inputs.map(normalizeOperand)
    let (pieces, _, sources, eps, scale) = try splitChains(operands.map(\.chains), options)

    // Merge coincident pieces.
    let count = operands.count
    var groups: [PairKey: [Edge]] = [:]
    var edges: [Edge] = []
    for piece in pieces {
        let forward = piece.a.id < piece.b.id
        let a = forward ? piece.a : piece.b
        let b = forward ? piece.b : piece.a
        let pts = forward ? piece.pts : piece.pts.reversed()
        let key = PairKey(a: a.id, b: b.id)
        let group = groups[key] ?? []
        var edge = group.first { samePiece($0.pts, pts, eps) }
        if edge == nil {
            let created = Edge(
                a: a, b: b, pts: pts, mult: Array(repeating: 0, count: count), src: piece.src,
                sa: forward ? piece.s0 : piece.s1, sb: forward ? piece.s1 : piece.s0
            )
            groups[key] = group + [created]
            edges.append(created)
            edge = created
        }
        edge!.mult[piece.operand] += forward ? 1 : -1
    }
    let live = edges.filter { $0.mult.contains { $0 != 0 } }

    // Winding numbers on both sides of every edge. Rays only meet edges whose y range (x
    // range for vertical rays) holds the ray, so edges are bucketed into bands on each axis.
    let byY = BandIndex(live, { $0.minY }, { $0.maxY })
    let byX = BandIndex(live, { $0.minX }, { $0.maxX })
    var right: [[Int]] = []
    var left: [[Int]] = []
    for i in 0..<live.count {
        let edge = live[i]
        let mid = segmentPoint(edge.pts, 0.5)
        let tan = segmentTangent(edge.pts, 0.5)
        let horizontal = abs(tan[1]) < abs(tan[0])
        var winding = Array(repeating: 0, count: count)
        let mx = mid[0], my = mid[1]
        for j in horizontal ? byX.at(mx) : byY.at(my) {
            if j == i { continue }
            let o = live[j]
            var dir = 0
            if !horizontal {
                // Ray towards +x.
                if o.maxX <= mx { continue }
                let ay = o.a.y
                let by = o.b.y
                if ay <= my && by > my { dir = 1 } else if by <= my && ay > my { dir = -1 } else { continue }
                if o.minX <= mx {
                    let t = solveMonotone(o.pts, 1, my)
                    if !(segmentPoint(o.pts, t)[0] > mx) { continue }
                }
            } else {
                // Ray towards +y, in the frame rotated by −90° ((x, y) → (y, −x)).
                if o.maxY <= my { continue }
                let ax = o.a.x
                let bx = o.b.x
                if bx < mx && mx <= ax { dir = 1 } else if ax < mx && mx <= bx { dir = -1 } else { continue }
                if o.minY <= my {
                    let t = solveMonotone(o.pts, 0, mx)
                    if !(segmentPoint(o.pts, t)[1] > my) { continue }
                }
            }
            for k in 0..<count where o.mult[k] != 0 { winding[k] += dir * o.mult[k] }
        }
        let sideIsRight = horizontal ? edge.b.x < edge.a.x : edge.b.y > edge.a.y
        let r = sideIsRight ? winding : winding.enumerated().map { k, w in w - edge.mult[k] }
        right.append(r)
        left.append(r.enumerated().map { k, w in w + edge.mult[k] })
    }
    return Arrangement(edges: live, left: left, right: right, fillRules: operands.map(\.fillRule), sources: sources, eps: eps, scale: scale)
}

/// Edge indices bucketed into equal bands of one coordinate.
private struct BandIndex {
    private var bands: [[Int]]
    private let min: Double
    private let size: Double

    init(_ edges: [Edge], _ lo: (Edge) -> Double, _ hi: (Edge) -> Double) {
        var min = Double.infinity
        var max = -Double.infinity
        for e in edges {
            min = jmin(min, lo(e))
            max = jmax(max, hi(e))
        }
        let count = Int(jmax(1, jmin(4096, JS.ceil(JS.sqrt(Double(edges.count)) * 2))))
        self.min = min
        size = max > min ? (max - min) / Double(count) : 1
        bands = Array(repeating: [], count: count)
        for (i, e) in edges.enumerated() {
            let from = index(lo(e))
            let to = index(hi(e))
            var b = from
            while b <= to {
                bands[b].append(i)
                b += 1
            }
        }
    }

    private func index(_ v: Double) -> Int {
        let k = JS.floor((v - min) / size)
        return Int(jmax(0, jmin(Double(bands.count - 1), k.isFinite ? k : 0)))
    }

    func at(_ v: Double) -> [Int] { bands[index(v)] }
}

private func insideFlags(_ windings: [Int], _ fillRules: [PolygonFillRule]) -> [Bool] {
    windings.enumerated().map { k, w in fillRules[k] == .evenodd ? (w & 1) == 1 : w != 0 }
}

// MARK: - Tracing and reconstruction

private struct DirectedEdge {
    var from: Vertex
    var to: Vertex
    var pts: [PathPoint]
    var src: Int
    var sFrom: Double
    var sTo: Double
    var outAngle: Double
    var backAngle: Double
    var length: Double
}

private let TWO_PI = PI * 2
private let TIE = 1e-3

private func directed(_ edge: Edge, _ forward: Bool) -> DirectedEdge {
    let pts = forward ? edge.pts : edge.pts.reversed()
    let out = segmentTangent(pts, 0)
    let end = segmentTangent(pts, 1)
    return DirectedEdge(
        from: forward ? edge.a : edge.b,
        to: forward ? edge.b : edge.a,
        pts: pts,
        src: edge.src,
        sFrom: forward ? edge.sa : edge.sb,
        sTo: forward ? edge.sb : edge.sa,
        outAngle: JS.atan2(out[1], out[0]),
        backAngle: JS.atan2(-end[1], -end[0]),
        length: dist(pts[0], pts[pts.count - 1]) + (pts.count > 2 ? flatness(pts) : 0)
    )
}

/// Angle of the chord from the start of `pts` to the point at fraction `t` (by parameter).
private func chordAngle(_ pts: [PathPoint], _ t: Double) -> Double {
    let p = segmentPoint(pts, t)
    return JS.atan2(p[1] - pts[0][1], p[0] - pts[0][0])
}

private func mod2pi(_ a: Double) -> Double {
    let r = a - JS.floor(a / TWO_PI) * TWO_PI
    return r >= TWO_PI ? 0 : r
}

/// Traces the kept directed edges (result on the left) into rings (as indices into `edges`).
private func traceRings(_ edges: [DirectedEdge], _ scale: Double) throws -> [[Int]] {
    var outgoing: [Int: [Int]] = [:]
    for (index, e) in edges.enumerated() { outgoing[e.from.id, default: []].append(index) }
    var used = Array(repeating: false, count: edges.count)
    var start = -1
    func next(_ incomingIndex: Int) -> Int? {
        let incoming = edges[incomingIndex]
        guard let all = outgoing[incoming.to.id] else { return nil }
        let candidates = all.filter { !used[$0] || $0 == start }
        if candidates.isEmpty { return nil }
        if candidates.count == 1 { return candidates[0] }
        var turns = candidates.map { mod2pi(incoming.backAngle - edges[$0].outAngle) }
        func tied(_ x: Double) -> Bool { x < TIE || x > TWO_PI - TIE }
        var ambiguous = turns.contains(where: tied)
        if !ambiguous {
            let sorted = jsSorted(turns) { a, b in a - b }
            for i in 1..<sorted.count where sorted[i] - sorted[i - 1] < TIE { ambiguous = true }
        }
        if ambiguous {
            // Tangent directions tie (tangent curves): compare chords a short way along each
            // curve instead, which separates curves by their curvature.
            let back: [PathPoint] = incoming.pts.reversed()
            var delta = jmin([incoming.length] + candidates.map { edges[$0].length })
            delta = jmin(delta * 0.25, scale * 0.02)
            func frac(_ e: DirectedEdge) -> Double { jmin(1, jmax(1e-6, delta / jmax(e.length, 1e-300))) }
            let backChord = chordAngle(back, frac(incoming))
            for i in 0..<candidates.count {
                turns[i] = mod2pi(backChord - chordAngle(edges[candidates[i]].pts, frac(edges[candidates[i]])))
                if turns[i] < 1e-12 { turns[i] = TWO_PI }
            }
        } else {
            for i in 0..<turns.count where turns[i] < 1e-15 { turns[i] = TWO_PI }
        }
        var best = 0
        for i in 1..<candidates.count where turns[i] < turns[best] { best = i }
        return candidates[best]
    }

    var rings: [[Int]] = []
    for first in 0..<edges.count {
        if used[first] { continue }
        start = first
        var ring: [Int] = []
        var edge: Int? = first
        var guardCount = edges.count + 1
        var closed = false
        while let e = edge, guardCount > 0 {
            guardCount -= 1
            used[e] = true
            ring.append(e)
            edge = next(e)
            if edge == first {
                closed = true
                break
            }
        }
        if !closed { throw PathOpsError("result outline does not close") }
        rings.append(ring)
    }
    return rings
}

private func mergeable(_ a: DirectedEdge, _ b: DirectedEdge, _ eps: Double) -> Bool {
    if a.src == b.src && abs(a.sTo - b.sFrom) < 1e-9 && (a.sTo - a.sFrom > 0) == (b.sTo - b.sFrom > 0) { return true }
    if a.pts.count == 2 && b.pts.count == 2 {
        // Collinear lines from different sources (e.g. shared rectangle sides).
        let p = a.pts[0]
        let q = b.pts[1]
        let m = a.pts[1]
        let chord = sub(q, p)
        let len = hypot(chord[0], chord[1])
        if len == 0 { return false }
        let off = abs(cross(chord, sub(m, p))) / len
        let along = dot(chord, sub(m, p))
        return off <= eps && along > 0 && along < len * len
    }
    return false
}

/// Rebuilds a ring as segments: pieces of one source become one exact sub-curve.
private func rebuildRing(_ ring: [DirectedEdge], _ sources: [Source], _ eps: Double) -> [BezierSegment] {
    let n = ring.count
    var startIndex = 0
    for k in 0..<n where !mergeable(ring[(k + n - 1) % n], ring[k], eps) {
        startIndex = k
        break
    }
    let ordered = Array(ring[startIndex...]) + Array(ring[..<startIndex])
    var out: [BezierSegment] = []
    var i = 0
    while i < ordered.count {
        let first = ordered[i]
        var j = i + 1
        while j < ordered.count && mergeable(ordered[j - 1], ordered[j], eps) { j += 1 }
        let last = ordered[j - 1]
        if j - i == 1 {
            out.append(first.pts)
        } else if first.pts.count == 2 && ordered[i..<j].allSatisfy({ $0.pts.count == 2 }) {
            out.append([first.from.p, last.to.p])
        } else {
            let source = sources[first.src]
            out.append(snapEnds(subSegment(source.seg, first.sFrom, last.sTo), first.from.p, last.to.p))
        }
        i = j
    }
    return out
}

private struct Ring {
    var segs: [BezierSegment]
    var area: Double
}

private func extractRings(_ arr: Arrangement, _ isInside: ([Bool]) -> Bool) throws -> [Ring] {
    var kept: [DirectedEdge] = []
    for (i, edge) in arr.edges.enumerated() {
        let l = isInside(insideFlags(arr.left[i], arr.fillRules))
        let r = isInside(insideFlags(arr.right[i], arr.fillRules))
        if l == r { continue }
        kept.append(directed(edge, l))
    }
    var rings: [Ring] = []
    let sliver = jmax(arr.eps * 10, 1e-7 * arr.scale)
    for ring in try traceRings(kept, arr.scale) {
        let segs = rebuildRing(ring.map { kept[$0] }, arr.sources, arr.eps)
        let area = contourSignedArea(segs)
        var perimeter = 0.0
        for s in segs { perimeter += s.count == 2 ? dist(s[0], s[1]) : segmentLength(s, 0, 1, 1e-6) }
        if !(perimeter > 0) || (2 * abs(area)) / perimeter < sliver { continue }
        rings.append(Ring(segs: segs, area: area))
    }
    return rings
}

/// A point inside the region just left of a ring (for hole assignment).
private func ringSample(_ ring: Ring) -> PathPoint {
    // The midpoint of the longest segment: never a vertex shared with another ring.
    var best = ring.segs[0]
    var bestLen = -1.0
    for s in ring.segs {
        let l = dist(s[0], s[s.count - 1])
        if l > bestLen {
            best = s
            bestLen = l
        }
    }
    return segmentPoint(best, 0.5)
}

/// Groups rings into outer rings with their holes (counter-clockwise outers in a y-up frame).
private func groupRings(_ rings: [Ring]) -> [[Ring]] {
    let outers = jsSorted(rings.filter { $0.area > 0 }) { a, b in b.area - a.area }
    let holes = rings.filter { $0.area < 0 }
    var groups: [[Ring]] = outers.map { [$0] }
    for hole in holes {
        let sample = ringSample(hole)
        var i = outers.count - 1
        while i >= 0 {
            if outers[i].area >= -hole.area && windingNumber([outers[i].segs], sample) != 0 {
                groups[i].append(hole)
                break
            }
            i -= 1
        }
    }
    return groups
}

private func ringsToPath(_ rings: [Ring]) -> BezierPath {
    contoursToPath(rings.map { BezierContour(segments: $0.segs, closed: true) })
}

private func predicate(_ operation: PathBooleanOperation) -> ([Bool]) -> Bool {
    switch operation {
    case .union: return { f in f.contains(true) }
    case .intersection: return { f in !f.isEmpty && f.allSatisfy { $0 } }
    case .difference: return { f in f.first == true && !f.dropFirst().contains(true) }
    case .xor: return { f in f.filter { $0 }.count % 2 == 1 }
    }
}

// MARK: - Polygon fallback

private func flattenOperand(_ input: PathOperand, _ tolerance: Double) -> PolygonInput {
    let rings = pathToContours(input.path)
        .map { flattenChain(closeContour($0, true), tolerance) }
        .filter { r in r.count >= 3 && r.allSatisfy { $0[0].isFinite && $0[1].isFinite } }
    return .operand(rings: rings, fillRule: input.fillRule ?? .nonzero)
}

private func multiToPath(_ multi: MultiPolygon, _ tolerance: Double) -> BezierPath {
    if multi.isEmpty { return [] }
    return toBezierPath(.svg(polygonToSvgPath(multi, PolygonToPathOptions(precision: 9, curves: .fit, curveTolerance: tolerance))))
}

private func reasonOf(_ error: Error) -> String {
    (error as? PathOpsError)?.message ?? String(describing: error)
}

// MARK: - Public operations

/// Applies a boolean operation to any number of path operands, keeping curves (`union`,
/// `intersection`, `difference`: the first minus the others, `xor`). Open subpaths are closed
/// for filling. Non-finite input gives an empty path (`error`); with `fallback: false` a
/// failure of the curve engine throws a `PathOpsError`.
public func pathBoolean(_ operation: PathBooleanOperation, _ operands: [PathOperand], _ options: PathOpsOptions = .init()) throws -> PathBooleanResult {
    if operands.isEmpty { return PathBooleanResult(path: [], report: .init(engine: .curve)) }
    do {
        let arr = try buildArrangement(operands, options)
        return PathBooleanResult(path: ringsToPath(try extractRings(arr, predicate(operation))), report: .init(engine: .curve))
    } catch {
        let reason = reasonOf(error)
        if reason == NON_FINITE { return PathBooleanResult(path: [], report: .init(engine: .curve, error: reason)) }
        if options.fallback == false { throw error }
        options.onFallback?(reason)
        let tolerance = options.fallbackTolerance ?? 0.05
        let multi = polygonBoolean(operation, operands.map { flattenOperand($0, tolerance) }, PolygonBooleanOptions(epsilon: options.epsilon))
        return PathBooleanResult(path: multiToPath(multi, tolerance), report: .init(engine: .polygon, fallbackReason: reason))
    }
}

/// `pathBoolean` with the fallback on (it never throws then).
private func fallbackBoolean(_ operation: PathBooleanOperation, _ operands: [PathOperand], _ options: PathOpsOptions?) -> BezierPath {
    var o = options ?? .init()
    if o.fallback == false { o.fallback = nil }
    return (try? pathBoolean(operation, operands, o))?.path ?? []
}

public func unitePaths(_ a: PathOperand, _ b: PathOperand, _ options: PathOpsOptions? = nil) -> BezierPath { fallbackBoolean(.union, [a, b], options) }
public func intersectPaths(_ a: PathOperand, _ b: PathOperand, _ options: PathOpsOptions? = nil) -> BezierPath { fallbackBoolean(.intersection, [a, b], options) }
public func subtractPaths(_ a: PathOperand, _ b: PathOperand, _ options: PathOpsOptions? = nil) -> BezierPath { fallbackBoolean(.difference, [a, b], options) }
public func excludePaths(_ a: PathOperand, _ b: PathOperand, _ options: PathOpsOptions? = nil) -> BezierPath { fallbackBoolean(.xor, [a, b], options) }

/// Splits the arrangement of the operands into its regions (Divide). Pieces are ordered by
/// operand set, then by area (largest first).
public func dividePaths(_ operands: [PathOperand], _ options: PathOpsOptions = .init()) throws -> DividePathsResult {
    if operands.isEmpty { return DividePathsResult(pieces: [], report: .init(engine: .curve)) }
    do {
        let arr = try buildArrangement(operands, options)
        var signatures = OrderedMap<String, [Int]>()
        func note(_ windings: [Int]) {
            let flags = insideFlags(windings, arr.fillRules)
            if !flags.contains(true) { return }
            let key = String(flags.map { $0 ? "1" : "0" })
            if !signatures.has(key) { signatures[key] = flags.enumerated().compactMap { k, f in f ? k : nil } }
        }
        for i in arr.edges.indices {
            note(arr.left[i])
            note(arr.right[i])
        }
        var pieces: [PathPiece] = []
        for key in signatures.keys.sorted() {
            let rings = try extractRings(arr) { flags in String(flags.map { $0 ? "1" : "0" }) == key }
            let groups = jsSorted(groupRings(rings)) { a, b in b[0].area - a[0].area }
            for group in groups { pieces.append(PathPiece(path: ringsToPath(group), operands: signatures[key]!)) }
        }
        return DividePathsResult(pieces: pieces, report: .init(engine: .curve))
    } catch {
        let reason = reasonOf(error)
        if reason == NON_FINITE { return DividePathsResult(pieces: [], report: .init(engine: .curve, error: reason)) }
        if options.fallback == false { throw error }
        options.onFallback?(reason)
        let tolerance = options.fallbackTolerance ?? 0.05
        let pieces = dividePolygons(operands.map { flattenOperand($0, tolerance) }, PolygonBooleanOptions(epsilon: options.epsilon))
            .map { PathPiece(path: multiToPath([$0.polygon], tolerance), operands: $0.operands) }
        return DividePathsResult(pieces: pieces, report: .init(engine: .polygon, fallbackReason: reason))
    }
}

/// Resolves self-intersections and overlaps of one filled path into simple, consistently
/// oriented subpaths under its fill rule.
public func normalizeBezierPath(_ path: BezierPathInput, _ fillRule: PolygonFillRule = .nonzero, _ options: PathOpsOptions = .init()) throws -> BezierPath {
    try pathBoolean(.union, [PathOperand(path, fillRule: fillRule)], options).path
}

/// Filled area of a path under its fill rule (overlaps counted once; exact for curves).
public func bezierPathArea(_ path: BezierPathInput, _ fillRule: PolygonFillRule = .nonzero, _ options: PathOpsOptions = .init()) throws -> Double {
    let normalized = try normalizeBezierPath(path, fillRule, options)
    var sum = 0.0
    for contour in pathToContours(.commands(normalized)) { sum += contourSignedArea(closeContour(contour, true)) }
    return abs(sum)
}

/// Normalised rings of a filled path with their nesting. `parent` is the index of the
/// smallest enclosing ring.
public struct NestedRing: Sendable {
    public var segments: [BezierSegment]
    public var area: Double
    public var parent: Int
}

/// Internal: rings of a boolean result with their containment tree.
public func pathBooleanRings(_ operation: PathBooleanOperation, _ operands: [PathOperand], _ options: PathOpsOptions = .init()) throws -> [NestedRing] {
    try pathBooleanRings(predicate(operation), operands, options)
}

/// Internal: rings of a boolean selection with their containment tree.
public func pathBooleanRings(_ isInside: ([Bool]) -> Bool, _ operands: [PathOperand], _ options: PathOpsOptions = .init()) throws -> [NestedRing] {
    let arr = try buildArrangement(operands, options)
    let rings = try extractRings(arr, isInside)
    let order = jsSorted(Array(rings.indices)) { a, b in abs(rings[a].area) - abs(rings[b].area) }
    return rings.enumerated().map { i, ring in
        let sample = ringSample(ring)
        var parent = -1
        for j in order {
            if j == i || abs(rings[j].area) <= abs(ring.area) { continue }
            if windingNumber([rings[j].segs], sample) != 0 {
                parent = j
                break
            }
        }
        return NestedRing(segments: ring.segs, area: ring.area, parent: parent)
    }
}

/// Contours of nested rings, keeping the ones `keep` accepts.
public func nestedRingsToPath(_ rings: [NestedRing], _ keep: (Int) -> Bool = { _ in true }) -> BezierPath {
    var contours: [BezierContour] = []
    for (i, r) in rings.enumerated() where keep(i) { contours.append(BezierContour(segments: r.segments, closed: true)) }
    return contoursToPath(contours)
}

// MARK: - Planar split

/// One edge of `planarSplit`: a piece of an input segment between two vertices.
public struct PlanarSplitEdge: Sendable {
    /// Vertex indices at the start and end of `pts`.
    public var a: Int
    public var b: Int
    /// Control points from vertex `a` to vertex `b`.
    public var pts: [PathPoint]
    /// Inputs whose chains run along this edge, ascending.
    public var operands: [Int]
    /// The source segment it is a piece of and its parameters there at `a` and `b`.
    public var src: Int
    public var sa: Double
    public var sb: Double
}

public struct PlanarSplitResult: Sendable {
    public var vertices: [PathPoint]
    public var edges: [PlanarSplitEdge]
    /// The input segments, as `src` refers to them.
    public var sources: [BezierSegment]
    public var eps: Double
    public var scale: Double
}

/// The chains of every input (open or closed, as given) split wherever they cross or touch
/// each other or themselves. Coincident pieces become one edge listing every input along it.
/// Throws a `PathOpsError` when the search does not settle or the input is not finite.
public func planarSplit(_ inputs: [[[BezierSegment]]], _ options: PathOpsOptions = .init()) throws -> PlanarSplitResult {
    for chains in inputs {
        for chain in chains {
            for seg in chain {
                for p in seg where !p[0].isFinite || !p[1].isFinite { throw PathOpsError(NON_FINITE) }
            }
        }
    }
    let (pieces, pool, sources, eps, scale) = try splitChains(inputs, options)
    var groups: [PairKey: [Int]] = [:]
    var edges: [PlanarSplitEdge] = []
    for piece in pieces {
        let forward = piece.a.id < piece.b.id
        let a = forward ? piece.a : piece.b
        let b = forward ? piece.b : piece.a
        let pts = forward ? piece.pts : piece.pts.reversed()
        let key = PairKey(a: a.id, b: b.id)
        let group = groups[key] ?? []
        if let index = group.first(where: { samePiece(edges[$0].pts, pts, eps) }) {
            if !edges[index].operands.contains(piece.operand) {
                edges[index].operands = jsSorted(edges[index].operands + [piece.operand]) { x, y in Double(x - y) }
            }
            continue
        }
        groups[key] = group + [edges.count]
        edges.append(PlanarSplitEdge(
            a: a.id, b: b.id, pts: pts, operands: [piece.operand], src: piece.src,
            sa: forward ? piece.s0 : piece.s1, sb: forward ? piece.s1 : piece.s0
        ))
    }
    return PlanarSplitResult(vertices: pool.vertices.map(\.p), edges: edges, sources: sources.map(\.seg), eps: eps, scale: scale)
}

/// Result of `pathBooleanSelect`: per selector, its connected parts.
public struct PathSelectResult: Sendable {
    public var parts: [[BezierPath]]
    public var report: PathOpsReport
}

/// Several boolean selections over one arrangement of the operands. A selector gets the
/// ascending indices of the operands covering an area and keeps the area when it returns
/// true. Each selection comes back as its connected parts, largest first.
public func pathBooleanSelect(_ operands: [PathOperand], _ selectors: [([Int]) -> Bool], _ options: PathOpsOptions = .init()) throws -> PathSelectResult {
    if operands.isEmpty { return PathSelectResult(parts: selectors.map { _ in [] }, report: .init(engine: .curve)) }
    func covering(_ flags: [Bool]) -> [Int] { flags.enumerated().compactMap { k, f in f ? k : nil } }
    do {
        let arr = try buildArrangement(operands, options)
        let parts = try selectors.map { select in
            let rings = try extractRings(arr) { flags in select(covering(flags)) }
            return jsSorted(groupRings(rings)) { a, b in b[0].area - a[0].area }.map(ringsToPath)
        }
        return PathSelectResult(parts: parts, report: .init(engine: .curve))
    } catch {
        let reason = reasonOf(error)
        if reason == NON_FINITE { return PathSelectResult(parts: selectors.map { _ in [] }, report: .init(engine: .curve, error: reason)) }
        if options.fallback == false { throw error }
        options.onFallback?(reason)
        let tolerance = options.fallbackTolerance ?? 0.05
        let pieces = dividePolygons(operands.map { flattenOperand($0, tolerance) }, PolygonBooleanOptions(epsilon: options.epsilon))
        let parts = selectors.map { select -> [BezierPath] in
            let picked = pieces.filter { select($0.operands) }
            if picked.isEmpty { return [] }
            let multi = polygonBoolean(.union, [.multi(picked.map(\.polygon))], PolygonBooleanOptions(epsilon: options.epsilon))
            return multi.map { multiToPath([$0], tolerance) }
        }
        return PathSelectResult(parts: parts, report: .init(engine: .polygon, fallbackReason: reason))
    }
}
