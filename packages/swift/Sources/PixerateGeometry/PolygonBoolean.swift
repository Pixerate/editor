import Foundation
import PixerateRaster

// Polygon boolean operations (`canvas/polygonBoolean.ts`): overlay + winding classification on
// multi-polygons with holes. See the TS module for the algorithm.

/// A closed ring of points. The closing point may be repeated or omitted.
public typealias PolygonRing = [PathPoint]
/// A polygon: the outer ring followed by its holes.
public typealias PolygonWithHoles = [PolygonRing]
/// A set of polygons.
public typealias MultiPolygon = [PolygonWithHoles]

/// Boolean operations. `xor` is Freeform's Exclude.
public enum PolygonBooleanOperation: String, Sendable, CaseIterable {
    case union, intersection, difference, xor
}

/// An operand: a multi-polygon, or a raw ring set read with a fill rule (ring orientation is
/// significant for `nonzero`).
public enum PolygonInput: Sendable {
    case multi(MultiPolygon)
    case operand(rings: [PolygonRing], fillRule: PolygonFillRule?)
}

public struct PolygonBooleanOptions: Sendable {
    /// Distance below which points are treated as equal (default 1e-9 × the largest coordinate).
    public var epsilon: Double?
    public init(epsilon: Double? = nil) { self.epsilon = epsilon }
}

/// One region of `dividePolygons`, with the indices of the operands that cover it.
public struct PolygonPiece: Sendable {
    public var polygon: PolygonWithHoles
    public var operands: [Int]
}

// MARK: - Basic measures

/// Signed shoelace area of a ring (positive when counter-clockwise in a y-up frame).
public func ringSignedArea(_ ring: [PathPoint]) -> Double {
    var sum = 0.0
    let n = ring.count
    for i in 0..<n {
        let p1 = ring[i]
        let p2 = ring[(i + 1) % n]
        sum += p1[0] * p2[1] - p2[0] * p1[1]
    }
    return sum / 2
}

/// Area of a polygon (outer ring minus holes).
public func polygonArea(_ polygon: PolygonWithHoles) -> Double {
    if polygon.isEmpty { return 0 }
    var area = abs(ringSignedArea(polygon[0]))
    for i in 1..<polygon.count { area -= abs(ringSignedArea(polygon[i])) }
    return area
}

/// Total area of a multi-polygon (holes subtracted).
public func multiPolygonArea(_ multi: MultiPolygon) -> Double {
    var total = 0.0
    for polygon in multi { total += polygonArea(polygon) }
    return total
}

/// Axis-aligned bounds of a ring list, or `nil` when empty.
public func multiPolygonBounds(_ rings: [PolygonRing]) -> PathBounds? {
    var minX = Double.infinity, minY = Double.infinity
    var maxX = -Double.infinity, maxY = -Double.infinity
    for ring in rings {
        for p in ring {
            let x = p[0], y = p[1]
            if x < minX { minX = x }
            if y < minY { minY = y }
            if x > maxX { maxX = x }
            if y > maxY { maxY = y }
        }
    }
    return minX == .infinity ? nil : PathBounds(minX: minX, minY: minY, maxX: maxX, maxY: maxY)
}

/// Axis-aligned bounds of a multi-polygon, or `nil` when empty.
public func multiPolygonBounds(_ multi: MultiPolygon) -> PathBounds? {
    multiPolygonBounds(multi.flatMap { $0 })
}

/// Whether a point is inside a ring set under a fill rule. Points exactly on an edge may
/// report either side.
public func pointInRings(_ point: PathPoint, _ rings: [[PathPoint]], _ fillRule: PolygonFillRule = .nonzero) -> Bool {
    let px = point[0], py = point[1]
    var winding = 0
    for ring in rings {
        let n = ring.count
        for i in 0..<n {
            let ax = ring[i][0], ay = ring[i][1]
            let bx = ring[(i + 1) % n][0], by = ring[(i + 1) % n][1]
            if ay <= py && by > py {
                if ax + ((py - ay) / (by - ay)) * (bx - ax) > px { winding += 1 }
            } else if by <= py && ay > py {
                if ax + ((py - ay) / (by - ay)) * (bx - ax) > px { winding -= 1 }
            }
        }
    }
    return fillRule == .evenodd ? (winding & 1) == 1 : winding != 0
}

/// Whether a point is inside a multi-polygon (holes excluded).
public func pointInMultiPolygon(_ point: PathPoint, _ multi: MultiPolygon) -> Bool {
    multi.contains { pointInRings(point, $0, .evenodd) }
}

// MARK: - Operand normalisation

private func cleanRing(_ ring: [PathPoint]) -> [PathPoint] {
    var out: [PathPoint] = []
    for p in ring {
        if !p[0].isFinite || !p[1].isFinite { continue }
        if let last = out.last, last[0] == p[0], last[1] == p[1] { continue }
        out.append(Point(p[0], p[1]))
    }
    while out.count > 1 {
        let first = out[0], last = out[out.count - 1]
        if first[0] == last[0] && first[1] == last[1] { out.removeLast() } else { break }
    }
    return out
}

private struct NormalizedOperand {
    var rings: [[PathPoint]]
    var fillRule: PolygonFillRule
}

/// Multi-polygons are re-oriented (outer rings positive, holes negative) and filled with
/// `nonzero`, so overlapping polygons in one operand behave as their union.
private func normalizeInput(_ input: PolygonInput) -> NormalizedOperand {
    switch input {
    case .operand(let rings, let fillRule):
        return NormalizedOperand(rings: rings.map(cleanRing).filter { $0.count >= 3 }, fillRule: fillRule ?? .nonzero)
    case .multi(let multi):
        var rings: [[PathPoint]] = []
        for polygon in multi {
            for (index, raw) in polygon.enumerated() {
                let ring = cleanRing(raw)
                if ring.count < 3 { continue }
                let area = ringSignedArea(ring)
                if area == 0 { continue }
                let wantPositive = index == 0
                rings.append((area > 0) == wantPositive ? ring : ring.reversed())
            }
        }
        return NormalizedOperand(rings: rings, fillRule: .nonzero)
    }
}

// MARK: - Overlay

private struct Vertex {
    var id: Int
    var x: Double
    var y: Double
}

private struct CellKey: Hashable {
    var x: Double
    var y: Double
}

/// Merges points closer than `eps` (grid hash with neighbour lookup).
private final class PointPool {
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
        let vertex = Vertex(id: vertices.count, x: x, y: y)
        vertices.append(vertex)
        cells[CellKey(x: cx, y: cy), default: []].append(vertex.id)
        return vertex
    }
}

private struct RawSegment {
    var a: Vertex
    var b: Vertex
    var operand: Int
}

private struct Splits {
    var segment: RawSegment
    var points = OrderedMap<Int, (t: Double, v: Vertex)>()
}

/// Projection parameter of `p` on `a→b` and its distance to the segment line.
private func project(_ a: Vertex, _ b: Vertex, _ p: Vertex) -> (t: Double, dist: Double) {
    let dx = b.x - a.x
    let dy = b.y - a.y
    let len2 = dx * dx + dy * dy
    let t = len2 == 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
    let cx = a.x + t * dx
    let cy = a.y + t * dy
    return (t, hypot(p.x - cx, p.y - cy))
}

private func addSplit(_ splits: inout Splits, _ t: Double, _ v: Vertex) {
    let a = splits.segment.a, b = splits.segment.b
    if v.id == a.id || v.id == b.id { return }
    if !splits.points.has(v.id) { splits.points[v.id] = (t, v) }
}

private struct SegmentBox {
    var i: Int
    var minX: Double
    var maxX: Double
    var minY: Double
    var maxY: Double
}

/// One pass: splits every segment at crossings / touches with other segments.
private func splitPass(_ segments: [RawSegment], _ pool: PointPool, _ eps: Double) -> (segments: [RawSegment], changed: Bool) {
    let order = jsSorted(
        segments.enumerated().map { i, s in
            SegmentBox(i: i, minX: jmin(s.a.x, s.b.x), maxX: jmax(s.a.x, s.b.x), minY: jmin(s.a.y, s.b.y), maxY: jmax(s.a.y, s.b.y))
        }
    ) { p, q in p.minX - q.minX }
    var splits = segments.map { Splits(segment: $0) }

    for oi in 0..<order.count {
        let bi = order[oi]
        let s1 = segments[bi.i]
        var oj = oi + 1
        while oj < order.count {
            defer { oj += 1 }
            let bj = order[oj]
            if bj.minX > bi.maxX + eps { break }
            if bj.minY > bi.maxY + eps || bj.maxY < bi.minY - eps { continue }
            let s2 = segments[bj.i]
            let sharedA = s1.a.id == s2.a.id || s1.a.id == s2.b.id
            let sharedB = s1.b.id == s2.a.id || s1.b.id == s2.b.id
            if sharedA && sharedB { continue } // identical (or reversed) segment

            var touched = false
            // Endpoints of one segment lying on the other: T-junctions and collinear overlaps.
            for (seg, other, index) in [(s1, s2, bi.i), (s2, s1, bj.i)] {
                for p in [other.a, other.b] {
                    if p.id == seg.a.id || p.id == seg.b.id { continue }
                    let (t, dist) = project(seg.a, seg.b, p)
                    let len = hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y)
                    if dist <= eps && t * len > eps && (1 - t) * len > eps {
                        addSplit(&splits[index], t, p)
                        touched = true
                    }
                }
            }
            if touched { continue }

            // Proper crossing.
            let d1x = s1.b.x - s1.a.x
            let d1y = s1.b.y - s1.a.y
            let d2x = s2.b.x - s2.a.x
            let d2y = s2.b.y - s2.a.y
            let denom = d1x * d2y - d1y * d2x
            let len1 = hypot(d1x, d1y)
            let len2 = hypot(d2x, d2y)
            if abs(denom) <= 1e-12 * len1 * len2 { continue } // parallel
            let ex = s2.a.x - s1.a.x
            let ey = s2.a.y - s1.a.y
            let t = (ex * d2y - ey * d2x) / denom
            let u = (ex * d1y - ey * d1x) / denom
            let tolT = eps / len1
            let tolU = eps / len2
            if t < -tolT || t > 1 + tolT || u < -tolU || u > 1 + tolU { continue }
            if sharedA || sharedB { continue } // they meet at the shared endpoint only
            let v = pool.get(s1.a.x + t * d1x, s1.a.y + t * d1y)
            addSplit(&splits[bi.i], project(s1.a, s1.b, v).t, v)
            addSplit(&splits[bj.i], project(s2.a, s2.b, v).t, v)
        }
    }

    var changed = false
    var out: [RawSegment] = []
    for split in splits {
        let segment = split.segment
        if split.points.count == 0 {
            out.append(segment)
            continue
        }
        changed = true
        let ordered = jsSorted(split.points.values) { p, q in p.t - q.t }
        var prev = segment.a
        for (_, v) in ordered {
            if v.id != prev.id { out.append(RawSegment(a: prev, b: v, operand: segment.operand)) }
            prev = v
        }
        if prev.id != segment.b.id { out.append(RawSegment(a: prev, b: segment.b, operand: segment.operand)) }
    }
    return (out, changed)
}

private struct OverlayEdge {
    var a: Vertex
    var b: Vertex
    /// Signed multiplicity per operand (+1 per edge running a→b, −1 per edge running b→a).
    var mult: [Int]
}

private struct Overlay {
    var edges: [OverlayEdge]
    /// Winding number per operand on the right of each edge.
    var right: [[Int]]
    /// Winding number per operand on the left of each edge.
    var left: [[Int]]
    var fillRules: [PolygonFillRule]
    var eps: Double
}

private func defaultEpsilon(_ operands: [NormalizedOperand]) -> Double {
    var max = 0.0
    for op in operands {
        for ring in op.rings {
            for p in ring {
                let m = jmax(abs(p[0]), abs(p[1]))
                if m > max { max = m }
            }
        }
    }
    return jmax(1e-9, max * 1e-9)
}

private struct EdgeKey: Hashable {
    var a: Int
    var b: Int
}

private func buildOverlay(_ inputs: [PolygonInput], _ options: PolygonBooleanOptions) -> Overlay {
    let operands = inputs.map(normalizeInput)
    let eps = (options.epsilon ?? 0) > 0 ? options.epsilon! : defaultEpsilon(operands)
    let pool = PointPool(eps)
    var segments: [RawSegment] = []
    for (operand, op) in operands.enumerated() {
        for ring in op.rings {
            let verts = ring.map { pool.get($0[0], $0[1]) }
            for i in 0..<verts.count {
                let a = verts[i]
                let b = verts[(i + 1) % verts.count]
                if a.id != b.id { segments.append(RawSegment(a: a, b: b, operand: operand)) }
            }
        }
    }

    for _ in 0..<8 {
        let result = splitPass(segments, pool, eps)
        segments = result.segments
        if !result.changed { break }
    }

    // Merge coincident segments.
    let count = operands.count
    var byKey = OrderedMap<EdgeKey, OverlayEdge>()
    for s in segments {
        let forward = s.a.id < s.b.id
        let a = forward ? s.a : s.b
        let b = forward ? s.b : s.a
        let key = EdgeKey(a: a.id, b: b.id)
        if !byKey.has(key) { byKey[key] = OverlayEdge(a: a, b: b, mult: Array(repeating: 0, count: count)) }
        byKey.modify(key) { $0.mult[s.operand] += forward ? 1 : -1 }
    }
    let edges = byKey.values.filter { $0.mult.contains { $0 != 0 } }

    var right: [[Int]] = []
    var left: [[Int]] = []
    // Rays only meet edges whose span on the ray's axis covers the ray: index the edges in bands
    // along each of the two axes rays run across, so each ray tests one band, not every edge.
    let bandCount = Int(jmax(1, jmin(4096, JS.ceil(JS.sqrt(Double(edges.count))))))
    func bandIndex(_ horizontal: Bool) -> (Double) -> [Int] {
        let lo = { (e: OverlayEdge) in horizontal ? jmin(-e.a.x, -e.b.x) : jmin(e.a.y, e.b.y) }
        let hi = { (e: OverlayEdge) in horizontal ? jmax(-e.a.x, -e.b.x) : jmax(e.a.y, e.b.y) }
        var min = Double.infinity
        var max = -Double.infinity
        for e in edges {
            min = jmin(min, lo(e))
            max = jmax(max, hi(e))
        }
        let size = max > min ? (max - min) / Double(bandCount) : 1
        let band = { (v: Double) in Int(jmin(Double(bandCount - 1), jmax(0, JS.floor((v - min) / size)))) }
        var bands: [[Int]] = Array(repeating: [], count: bandCount)
        for (j, e) in edges.enumerated() {
            var k = band(lo(e))
            while k <= band(hi(e)) {
                bands[k].append(j)
                k += 1
            }
        }
        return { v in bands[band(v)] }
    }
    var bandsFor: [Bool: (Double) -> [Int]] = [:]
    for i in 0..<edges.count {
        let edge = edges[i]
        // Cast the ray across the edge rather than along it: rotating by −90° keeps windings
        // and turns a mostly horizontal edge into a mostly vertical one.
        let horizontal = abs(edge.b.y - edge.a.y) < abs(edge.b.x - edge.a.x)
        let tx = { (v: Vertex) in horizontal ? v.y : v.x }
        let ty = { (v: Vertex) in horizontal ? -v.x : v.y }
        let ax = tx(edge.a)
        let ay = ty(edge.a)
        let bx = tx(edge.b)
        let by = ty(edge.b)
        let mx = (ax + bx) / 2
        let my = (ay + by) / 2
        var winding = Array(repeating: 0, count: count)
        if bandsFor[horizontal] == nil { bandsFor[horizontal] = bandIndex(horizontal) }
        for j in bandsFor[horizontal]!(my) {
            if j == i { continue }
            let other = edges[j]
            let oax = tx(other.a)
            let oay = ty(other.a)
            let obx = tx(other.b)
            let oby = ty(other.b)
            var dir = 0
            if oay <= my && oby > my { dir = 1 } else if oby <= my && oay > my { dir = -1 } else { continue }
            let x = oax + ((my - oay) / (oby - oay)) * (obx - oax)
            if x <= mx { continue }
            for k in 0..<count where other.mult[k] != 0 { winding[k] += dir * other.mult[k] }
        }
        // The ray starts just past the midpoint on the +x side, which is the right of the
        // edge when it points up (dy > 0) and its left otherwise.
        let sideIsRight = by > ay
        let r = sideIsRight ? winding : winding.enumerated().map { k, w in w - edge.mult[k] }
        right.append(r)
        left.append(r.enumerated().map { k, w in w + edge.mult[k] })
    }
    return Overlay(edges: edges, right: right, left: left, fillRules: operands.map(\.fillRule), eps: eps)
}

private func insideFlags(_ windings: [Int], _ fillRules: [PolygonFillRule]) -> [Bool] {
    windings.enumerated().map { k, w in fillRules[k] == .evenodd ? (w & 1) == 1 : w != 0 }
}

// MARK: - Ring extraction

private struct DirectedEdge {
    var from: Vertex
    var to: Vertex
    var angle: Double
}

/// Traces the kept directed edges (result on the left) into rings.
private func traceRings(_ directed: [DirectedEdge]) -> [[Vertex]] {
    var outgoing: [Int: [Int]] = [:]
    for (index, e) in directed.enumerated() { outgoing[e.from.id, default: []].append(index) }
    let TWO_PI = PI * 2
    func next(_ incoming: DirectedEdge) -> Int? {
        guard let candidates = outgoing[incoming.to.id] else { return nil }
        let back = JS.atan2(incoming.from.y - incoming.to.y, incoming.from.x - incoming.to.x)
        var best: Int?
        var bestTurn = Double.infinity
        for c in candidates {
            // Clockwise sweep from the reversed incoming edge: the first hit is the sharpest
            // left turn, which keeps the result region on the left and splits rings at
            // vertices they merely touch.
            var turn = back - directed[c].angle
            turn -= JS.floor(turn / TWO_PI) * TWO_PI
            if turn <= 1e-15 { turn = TWO_PI }
            if turn < bestTurn {
                bestTurn = turn
                best = c
            }
        }
        return best
    }

    var used = Array(repeating: false, count: directed.count)
    var rings: [[Vertex]] = []
    for start in 0..<directed.count {
        if used[start] { continue }
        var ring: [Vertex] = []
        var edge: Int? = start
        var guardCount = directed.count + 1
        while let e = edge, !used[e], guardCount > 0 {
            guardCount -= 1
            used[e] = true
            ring.append(directed[e].from)
            edge = next(directed[e])
        }
        if ring.count >= 3 { rings.append(ring) }
    }
    return rings
}

/// Removes vertices that lie on the straight line between their neighbours.
private func removeCollinear(_ ring: [PathPoint], _ eps: Double) -> [PathPoint] {
    var points = ring
    var changed = true
    while changed && points.count > 3 {
        changed = false
        var out: [PathPoint] = []
        let n = points.count
        for i in 0..<n {
            let prev = out.last ?? points[(i - 1 + n) % n]
            let cur = points[i]
            let nxt = points[(i + 1) % n]
            let dx = nxt[0] - prev[0]
            let dy = nxt[1] - prev[1]
            let len = hypot(dx, dy)
            let cross = (cur[0] - prev[0]) * dy - (cur[1] - prev[1]) * dx
            let dot = (cur[0] - prev[0]) * dx + (cur[1] - prev[1]) * dy
            if len > 0 && abs(cross) / len <= eps && dot > 0 && dot < len * len {
                changed = true
                continue
            }
            out.append(cur)
        }
        if out.count < 3 { return out }
        points = out
    }
    return points
}

private func assemble(_ rings: [[Vertex]], _ eps: Double) -> MultiPolygon {
    var outers: [(ring: [PathPoint], area: Double)] = []
    var holes: [(ring: [PathPoint], area: Double)] = []
    let minArea = eps * eps
    for vertices in rings {
        let ring = removeCollinear(vertices.map { Point($0.x, $0.y) }, eps)
        if ring.count < 3 { continue }
        let area = ringSignedArea(ring)
        if abs(area) <= minArea { continue }
        if area > 0 { outers.append((ring, abs(area))) } else { holes.append((ring, abs(area))) }
    }
    outers.jsSort { a, b in b.area - a.area }
    var polygons: [PolygonWithHoles] = outers.map { [$0.ring] }
    for hole in holes {
        // Sample the midpoint of a hole edge: overlay edges are unique, so it is not on an
        // outer ring's boundary.
        let p = hole.ring[0], q = hole.ring[1]
        let sample = Point((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
        var owner = -1
        var i = outers.count - 1
        while i >= 0 {
            // Iterating smallest-first finds the tightest container.
            if outers[i].area >= hole.area && pointInRings(sample, [outers[i].ring], .evenodd) {
                owner = i
                break
            }
            i -= 1
        }
        if owner >= 0 { polygons[owner].append(hole.ring) }
    }
    return polygons
}

private func extract(_ overlay: Overlay, _ isInside: ([Bool]) -> Bool) -> MultiPolygon {
    var directed: [DirectedEdge] = []
    for (i, edge) in overlay.edges.enumerated() {
        let l = isInside(insideFlags(overlay.left[i], overlay.fillRules))
        let r = isInside(insideFlags(overlay.right[i], overlay.fillRules))
        if l == r { continue }
        let (from, to) = l ? (edge.a, edge.b) : (edge.b, edge.a)
        directed.append(DirectedEdge(from: from, to: to, angle: JS.atan2(to.y - from.y, to.x - from.x)))
    }
    return assemble(traceRings(directed), overlay.eps)
}

private func predicate(_ operation: PolygonBooleanOperation) -> ([Bool]) -> Bool {
    switch operation {
    case .union: return { f in f.contains(true) }
    case .intersection: return { f in !f.isEmpty && f.allSatisfy { $0 } }
    case .difference: return { f in f.first == true && !f.dropFirst().contains(true) }
    case .xor: return { f in f.filter { $0 }.count % 2 == 1 }
    }
}

// MARK: - Public operations

/// Applies a boolean operation to any number of operands (`union`: covered by any;
/// `intersection`: by every; `difference`: the first minus the others; `xor`: by an odd
/// number). Outer rings have a positive signed area, holes a negative one.
public func polygonBoolean(_ operation: PolygonBooleanOperation, _ operands: [PolygonInput], _ options: PolygonBooleanOptions = .init()) -> MultiPolygon {
    if operands.isEmpty { return [] }
    return extract(buildOverlay(operands, options), predicate(operation))
}

public func unionPolygons(_ a: PolygonInput, _ b: PolygonInput, _ options: PolygonBooleanOptions = .init()) -> MultiPolygon {
    polygonBoolean(.union, [a, b], options)
}
public func intersectPolygons(_ a: PolygonInput, _ b: PolygonInput, _ options: PolygonBooleanOptions = .init()) -> MultiPolygon {
    polygonBoolean(.intersection, [a, b], options)
}
public func subtractPolygons(_ a: PolygonInput, _ b: PolygonInput, _ options: PolygonBooleanOptions = .init()) -> MultiPolygon {
    polygonBoolean(.difference, [a, b], options)
}
public func xorPolygons(_ a: PolygonInput, _ b: PolygonInput, _ options: PolygonBooleanOptions = .init()) -> MultiPolygon {
    polygonBoolean(.xor, [a, b], options)
}

/// Splits the overlay of the operands into its distinct regions (Freeform's Divide). Pieces
/// are ordered by their operand set, then by size (largest first).
public func dividePolygons(_ operands: [PolygonInput], _ options: PolygonBooleanOptions = .init()) -> [PolygonPiece] {
    if operands.isEmpty { return [] }
    let overlay = buildOverlay(operands, options)
    var signatures = OrderedMap<String, [Int]>()
    func note(_ windings: [Int]) {
        let flags = insideFlags(windings, overlay.fillRules)
        if !flags.contains(true) { return }
        let key = String(flags.map { $0 ? "1" : "0" })
        if !signatures.has(key) { signatures[key] = flags.enumerated().compactMap { k, f in f ? k : nil } }
    }
    for i in overlay.edges.indices {
        note(overlay.left[i])
        note(overlay.right[i])
    }
    var pieces: [PolygonPiece] = []
    for key in signatures.keys.sorted() {
        var polygons = extract(overlay) { flags in String(flags.map { $0 ? "1" : "0" }) == key }
        polygons.jsSort { a, b in polygonArea(b) - polygonArea(a) }
        for polygon in polygons { pieces.append(PolygonPiece(polygon: polygon, operands: signatures[key]!)) }
    }
    return pieces
}
