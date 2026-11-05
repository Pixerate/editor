import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Path editing on subpaths in a node's own space (`vector/pathEdit.ts`): anchor deletion that
// keeps the shape, segment bending, Curvature-tool anchor moves, cutting at anchors (Scissors),
// Join, Remove Redundant Points and Smooth.

private let EPS = 1e-9

private func unitOf(_ x: Double, _ y: Double) -> PathPoint? {
    let l = JS.hypot(x, y)
    return l > 1e-12 && l.isFinite ? PathPoint(x / l, y / l) : nil
}

/// Segment `i` as four control points (a line has its controls at the thirds of its chord).
private func cubicOf(_ sp: VectorSubpath, _ i: Int) -> [PathPoint] {
    let s = subpathSegment(sp, i)
    if s.count == 4 { return s }
    let a = s[0], b = s[1]
    return [a, PathPoint(a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3), PathPoint(a[0] + (2 * (b[0] - a[0])) / 3, a[1] + (2 * (b[1] - a[1])) / 3), b]
}

private func isLine(_ sp: VectorSubpath, _ i: Int) -> Bool { subpathSegment(sp, i).count == 2 }

/// Direction the curve leaves `c[0]`.
private func startTangent(_ c: [PathPoint]) -> PathPoint {
    for k in 1 ..< 4 { if let u = unitOf(c[k][0] - c[0][0], c[k][1] - c[0][1]) { return u } }
    return PathPoint(1, 0)
}

/// Direction the curve arrives at `c[3]`.
private func endTangent(_ c: [PathPoint]) -> PathPoint {
    for k in stride(from: 2, through: 0, by: -1) { if let u = unitOf(c[3][0] - c[k][0], c[3][1] - c[k][1]) { return u } }
    return PathPoint(1, 0)
}

/// `n + 1` points of a cubic at even parameters (`withStart` false skips the first).
private func sample(_ c: [PathPoint], _ n: Int, _ out: inout [PathPoint], _ withStart: Bool) {
    for i in (withStart ? 0 : 1) ... n { out.append(segmentPoint(c, Double(i) / Double(n))) }
}

private func onAnchor(_ a: VectorAnchor, _ h: Vec2?) -> Bool {
    guard let h else { return true }
    return abs(h.x - a.x) < EPS && abs(h.y - a.y) < EPS
}

/// Drops handles that sit on their anchor and sets the type the handles show (`tidy`).
func tidyAnchor(_ a: VectorAnchor, keepType: Bool = true) -> VectorAnchor {
    var next = cloneAnchor(a)
    if onAnchor(next, next.in) { next.in = nil }
    if onAnchor(next, next.out) { next.out = nil }
    let shown = inferAnchorType(next).rawValue
    let type: String
    if keepType, let t = a.rawTypeName, !t.isEmpty {
        type = t == "symmetric" && shown != "symmetric" ? (shown == "corner" ? "corner" : "smooth") : t == "smooth" && shown == "corner" ? "corner" : t
    } else {
        type = shown
    }
    if type == "corner" { next.type = nil } else { next["type"] = .string(type) }
    return next
}

/// An anchor with its `in` / `out` handle removed (`{ ...a, in: null }`).
private func without(_ a: VectorAnchor, in hin: Bool = false, out hout: Bool = false) -> VectorAnchor {
    var b = a
    if hin { b.in = nil }
    if hout { b.out = nil }
    return b
}

/// Index of the anchor before / after `i` (round the start of a closed subpath), or -1.
private func neighbours(_ sp: VectorSubpath, _ i: Int) -> [Int] {
    let n = sp.anchors.count
    let wrap = sp.closed && n > 1
    return [i > 0 ? i - 1 : wrap ? n - 1 : -1, i < n - 1 ? i + 1 : wrap ? 0 : -1]
}

// MARK: - Deleting anchors without changing the shape

/// The value of `f` with the least error for an argument in [a, b], by a golden-section search.
private func goldenMin(_ f: (Double) -> (curve: CubicSegment, error: Double), _ aIn: Double, _ bIn: Double) -> (curve: CubicSegment, error: Double) {
    let R = 0.618033988749895
    var a = aIn, b = bIn
    var x1 = b - R * (b - a)
    var x2 = a + R * (b - a)
    var f1 = f(x1)
    var f2 = f(x2)
    for _ in 0 ..< 40 {
        if f1.error < f2.error || f2.error.isNaN {
            b = x2
            x2 = x1
            f2 = f1
            x1 = b - R * (b - a)
            f1 = f(x1)
        } else {
            a = x1
            x1 = x2
            f1 = f2
            x2 = a + R * (b - a)
            f2 = f(x2)
        }
    }
    return f1.error <= f2.error ? f1 : f2
}

/// One cubic through `pts` (`N + 1` samples of a left curve then `N` of a right one), searching
/// where it passes their joint.
private func fitAcross(_ pts: [PathPoint], _ N: Int, _ t0: PathPoint, _ t1: PathPoint) -> (curve: CubicSegment, error: Double) {
    goldenMin({ k in
        var u: [Double] = []
        for i in 0 ... N { u.append((k * Double(i)) / Double(N)) }
        for i in 1 ... N { u.append(k + ((1 - k) * Double(i)) / Double(N)) }
        return fitCubicWithTangents(pts, u, t0, t1)
    }, 0, 1)
}

/// Removes anchor `index` without opening the path (`removeAnchorKeepingShape`).
public func removeAnchorKeepingShape(_ sp: VectorSubpath, _ index: Int) -> VectorSubpath {
    var anchors = sp.anchors.map(cloneAnchor)
    let n = anchors.count
    if index < 0 || index >= n { return VectorSubpath(anchors: anchors, closed: sp.closed) }
    if (sp.closed || (index > 0 && index < n - 1)) && n >= 3 {
        let pi = (index + n - 1) % n
        let ni = (index + 1) % n
        if !(isLine(sp, pi) && isLine(sp, index)) {
            let left = cubicOf(sp, pi)
            let right = cubicOf(sp, index)
            let N = 16
            var pts: [PathPoint] = []
            sample(left, N, &pts, true)
            sample(right, N, &pts, false)
            let curve = fitAcross(pts, N, startTangent(left), endTangent(right)).curve
            if [curve.p1, curve.p2].allSatisfy({ $0[0].isFinite && $0[1].isFinite }) {
                var p = anchors[pi]
                p.out = Vec2(curve.p1[0], curve.p1[1])
                anchors[pi] = tidyAnchor(p)
                var q = anchors[ni]
                q.in = Vec2(curve.p2[0], curve.p2[1])
                anchors[ni] = tidyAnchor(q)
            }
        }
    }
    anchors.remove(at: index)
    var closed = sp.closed
    if !closed && !anchors.isEmpty {
        // A new end has nothing beyond it.
        anchors[0] = tidyAnchor(without(anchors[0], in: true))
        let last = anchors.count - 1
        anchors[last] = tidyAnchor(without(anchors[last], out: true))
    }
    if anchors.count < 3 { closed = closed && anchors.count == 2 && anchors.contains { $0.in != nil || $0.out != nil } }
    return VectorSubpath(anchors: anchors, closed: closed)
}

/// Removes several anchors of a subpath, keeping the shape.
public func removeAnchorsKeepingShape(_ sp: VectorSubpath, _ indices: [Int]) -> VectorSubpath {
    var seen = Set<Int>()
    let order = indices.filter { seen.insert($0).inserted && $0 >= 0 && $0 < sp.anchors.count }.sorted(by: >)
    return order.reduce(VectorSubpath(anchors: sp.anchors.map(cloneAnchor), closed: sp.closed)) { removeAnchorKeepingShape($0, $1) }
}

// MARK: - Bending

/// Bends segment `segment` so the curve passes through `p` at parameter `t` (clamped to 0.05–0.95).
public func bendSubpathSegment(_ sp: VectorSubpath, _ segment: Int, _ t: Double, _ p: Vec2) -> VectorSubpath {
    var anchors = sp.anchors.map(cloneAnchor)
    let n = anchors.count
    if segment < 0 || segment >= subpathSegmentCount(sp) || !t.isFinite || !p.x.isFinite || !p.y.isFinite { return VectorSubpath(anchors: anchors, closed: sp.closed) }
    let tc = JS.min(0.95, JS.max(0.05, t))
    let ia = segment
    let ib = (segment + 1) % n
    let a = anchors[ia]
    let b = anchors[ib]
    let k = 3 * tc * (1 - tc)
    let ox = (p.x - (a.x + (b.x - a.x) * tc)) / k
    let oy = (p.y - (a.y + (b.y - a.y) * tc)) / k
    let c1 = Vec2(a.x + (b.x - a.x) / 3 + ox, a.y + (b.y - a.y) / 3 + oy)
    let c2 = Vec2(b.x + (a.x - b.x) / 3 + ox, b.y + (a.y - b.y) / 3 + oy)
    anchors[ia] = moveAnchorHandle(a, .out, c1)
    anchors[ib] = moveAnchorHandle(b, .in, c2)
    return VectorSubpath(anchors: anchors, closed: sp.closed)
}

/// Moves anchor `index` to `q` the way the Curvature tool drags a point (`curvatureMoveAnchor`).
public func curvatureMoveAnchor(_ sp: VectorSubpath, _ index: Int, _ q: Vec2) -> VectorSubpath {
    var anchors = sp.anchors.map(cloneAnchor)
    guard sp.anchors.indices.contains(index) else { return VectorSubpath(anchors: anchors, closed: sp.closed) }
    let a = sp.anchors[index]
    var own: [Vec2?] = [
        a.in != nil && !onAnchor(a, a.in) ? Vec2(a.in!.x - a.x, a.in!.y - a.y) : nil,
        a.out != nil && !onAnchor(a, a.out) ? Vec2(a.out!.x - a.x, a.out!.y - a.y) : nil,
    ]
    var ends: [Vec2?] = [nil, nil]
    for (side, j) in neighbours(sp, index).enumerated() {
        if j < 0 || j == index { continue }
        var b = anchors[j]
        let old = JS.hypot(a.x - b.x, a.y - b.y)
        let s = old > 1e-9 ? JS.hypot(q.x - b.x, q.y - b.y) / old : 1
        if side == 0 {
            if let h = b.out { b.out = Vec2(b.x + (h.x - b.x) * s, b.y + (h.y - b.y) * s) }
        } else {
            if let h = b.in { b.in = Vec2(b.x + (h.x - b.x) * s, b.y + (h.y - b.y) * s) }
        }
        anchors[j] = b
        if let o = own[side] { own[side] = Vec2(o.x * s, o.y * s) }
        ends[side] = Vec2(b.x, b.y)
    }
    var moved = VectorAnchor(x: q.x, y: q.y)
    if let o = own[0] { moved.in = Vec2(q.x + o.x, q.y + o.y) }
    if let o = own[1] { moved.out = Vec2(q.x + o.x, q.y + o.y) }
    if let t = a.rawTypeName, !t.isEmpty { moved["type"] = .string(t) }
    if let c = a.corner { moved.corner = c }
    if let id = a.id, !id.isEmpty { moved.id = id }
    if let t = a.rawTypeName, !t.isEmpty, t != "corner", let prev = ends[0], let next = ends[1] {
        let dx = next.x - prev.x
        let dy = next.y - prev.y
        let l = JS.hypot(dx, dy)
        if l > 1e-9 {
            func len(_ h: Vec2?, _ to: Vec2) -> Double { h.map { JS.hypot($0.x, $0.y) } ?? JS.hypot(q.x - to.x, q.y - to.y) / 3 }
            var li = len(own[0], prev)
            var lo = len(own[1], next)
            if t == "symmetric" {
                li = (li + lo) / 2
                lo = li
            }
            moved.in = Vec2(q.x - (dx * li) / l, q.y - (dy * li) / l)
            moved.out = Vec2(q.x + (dx * lo) / l, q.y + (dy * lo) / l)
        }
    }
    anchors[index] = moved
    return VectorSubpath(anchors: anchors, closed: sp.closed)
}

// MARK: - Scissors

/// Cuts a subpath at the anchors `at` (`cutSubpathAt`).
public func cutSubpathAt(_ sp: VectorSubpath, _ at: [Int]) -> [VectorSubpath] {
    let n = sp.anchors.count
    var seen = Set<Int>()
    let cuts = at.filter { seen.insert($0).inserted && $0 >= 0 && $0 < n && (sp.closed || ($0 > 0 && $0 < n - 1)) }.sorted()
    if cuts.isEmpty || n < 2 { return [VectorSubpath(anchors: sp.anchors.map(cloneAnchor), closed: sp.closed)] }
    let first = cuts[0]
    let run: [VectorAnchor] = sp.closed ? (0 ... n).map { sp.anchors[(first + $0) % n] } : sp.anchors
    let cutSet = Set(sp.closed ? cuts.map { ($0 - first + n) % n } + [n] : cuts)
    var pieces: [VectorSubpath] = []
    var cur: [VectorAnchor] = []
    for (i, a) in run.enumerated() {
        if !cutSet.contains(i) {
            cur.append(cloneAnchor(a))
            continue
        }
        if !cur.isEmpty {
            cur.append(tidyAnchor(without(a, out: true), keepType: false))
            pieces.append(VectorSubpath(anchors: cur, closed: false))
            cur = []
        }
        if i < n { cur.append(tidyAnchor(without(a, in: true), keepType: false)) }
    }
    if cur.count > 1 { pieces.append(VectorSubpath(anchors: cur, closed: false)) }
    return pieces
}

/// Cuts a subpath at parameter `t` of segment `segment` (`splitSubpathAt`).
public func splitSubpathAt(_ sp: VectorSubpath, _ segment: Int, _ t: Double, _ endTolerance: Double = 1e-6) -> [VectorSubpath] {
    let n = sp.anchors.count
    if segment < 0 || segment >= subpathSegmentCount(sp) { return [VectorSubpath(anchors: sp.anchors.map(cloneAnchor), closed: sp.closed)] }
    if t <= endTolerance { return cutSubpathAt(sp, [segment]) }
    if t >= 1 - endTolerance { return cutSubpathAt(sp, [(segment + 1) % n]) }
    let (subpath, index) = insertAnchor(sp, segment, t)
    return cutSubpathAt(subpath, [index])
}

// MARK: - Join

private func endOf(_ sp: VectorSubpath, _ last: Bool) -> VectorAnchor { sp.anchors[last ? sp.anchors.count - 1 : 0] }
private func dist(_ a: VectorAnchor, _ b: VectorAnchor) -> Double { JS.hypot(a.x - b.x, a.y - b.y) }

private func reversed(_ sp: VectorSubpath) -> VectorSubpath {
    VectorSubpath(closed: sp.closed, anchors: sp.anchors.reversed().map { a in
        var next = VectorAnchor(x: a.x, y: a.y)
        if let h = a.out { next.in = h }
        if let h = a.in { next.out = h }
        if let t = a.rawTypeName, !t.isEmpty { next["type"] = .string(t) }
        if let c = a.corner { next.corner = c }
        if let id = a.id, !id.isEmpty { next.id = id }
        return next
    })
}

/// Join: open subpaths joined nearest endpoints first into one open subpath; a single open subpath is closed (`joinSubpaths`).
public func joinSubpaths(_ subpaths: [VectorSubpath], _ tolerance: Double) -> [VectorSubpath] {
    var closed: [VectorSubpath] = []
    var open: [VectorSubpath] = []
    for sp in subpaths {
        let copy = VectorSubpath(anchors: sp.anchors.map(cloneAnchor), closed: sp.closed)
        if sp.closed || sp.anchors.count < 2 {
            if !sp.anchors.isEmpty { closed.append(copy) }
        } else {
            open.append(copy)
        }
    }
    if open.count == 1 {
        var sp = open[0]
        let first = sp.anchors[0]
        let last = sp.anchors[sp.anchors.count - 1]
        if sp.anchors.count > 2 && dist(first, last) <= tolerance {
            sp.anchors.removeLast()
            var f = first
            f.in = last.in
            sp.anchors[0] = tidyAnchor(f, keepType: false)
        } else {
            sp.anchors[0] = tidyAnchor(without(first, in: true), keepType: false)
            sp.anchors[sp.anchors.count - 1] = tidyAnchor(without(sp.anchors[sp.anchors.count - 1], out: true), keepType: false)
        }
        sp.closed = true
        return closed + [sp]
    }
    while open.count > 1 {
        var best = (d: Double.infinity, i: 0, j: 1, ei: true, ej: false)
        for i in 0 ..< open.count {
            for j in (i + 1) ..< open.count {
                for ei in [false, true] {
                    for ej in [false, true] {
                        let d = dist(endOf(open[i], ei), endOf(open[j], ej))
                        if d < best.d { best = (d, i, j, ei, ej) }
                    }
                }
            }
        }
        var a = open[best.i]
        var b = open[best.j]
        open.remove(at: best.j)
        if !best.ei { a = reversed(a) }
        if best.ej { b = reversed(b) }
        var anchors = a.anchors
        if best.d <= tolerance {
            let head = b.anchors[0]
            var l = anchors[anchors.count - 1]
            l.out = head.out
            anchors[anchors.count - 1] = tidyAnchor(l, keepType: false)
            anchors += b.anchors.dropFirst()
        } else {
            anchors[anchors.count - 1] = tidyAnchor(without(anchors[anchors.count - 1], out: true), keepType: false)
            anchors.append(tidyAnchor(without(b.anchors[0], in: true), keepType: false))
            anchors += b.anchors.dropFirst()
        }
        open[best.i > best.j ? best.i - 1 : best.i] = VectorSubpath(anchors: anchors, closed: false)
    }
    return closed + open
}

// MARK: - Smooth and Remove Redundant Points

/// Smooth: pulls handles towards Catmull-Rom-like tangents by `amount` (`smoothSubpath`).
public func smoothSubpath(_ sp: VectorSubpath, _ amount: Double = 1, only: Set<Int>? = nil) -> VectorSubpath {
    let t = JS.min(1, JS.max(0, amount))
    let orig = sp.anchors
    let n = orig.count
    var anchors = orig.map(cloneAnchor)
    if n < 3 || t == 0 { return VectorSubpath(anchors: anchors, closed: sp.closed) }
    for i in 0 ..< n {
        if !sp.closed && (i == 0 || i == n - 1) { continue }
        if let only, !only.contains(i) { continue }
        let prev = orig[(i + n - 1) % n]
        let next = orig[(i + 1) % n]
        let p = orig[i]
        guard let dir = unitOf(next.x - prev.x, next.y - prev.y) else { continue }
        let li = dist(p, prev) / 3
        let lo = dist(p, next) / 3
        let hin = p.in ?? Vec2(p.x, p.y)
        let hout = p.out ?? Vec2(p.x, p.y)
        func target(_ h: Vec2, _ x: Double, _ y: Double) -> Vec2 { Vec2(h.x + (x - h.x) * t, h.y + (y - h.y) * t) }
        anchors[i] = tidyAnchor(VectorAnchor(x: p.x, y: p.y, in: target(hin, p.x - dir[0] * li, p.y - dir[1] * li), out: target(hout, p.x + dir[0] * lo, p.y + dir[1] * lo)), keepType: false)
    }
    return VectorSubpath(anchors: anchors, closed: sp.closed)
}

private struct Seg {
    var c: [PathPoint]
    var line: Bool
}

private func segsOf(_ sp: VectorSubpath) -> [Seg] {
    (0 ..< subpathSegmentCount(sp)).map { i in
        let s = subpathSegment(sp, i)
        return Seg(c: s, line: s.count == 2)
    }
}

/// `${x},${y}` as JavaScript writes the numbers.
private func pointKey(_ x: Double, _ y: Double) -> String { "\(JSONValue.jsNumber(x)),\(JSONValue.jsNumber(y))" }

private func segsToSubpath(_ segs: [Seg], _ closed: Bool, _ types: [String: String]) -> VectorSubpath? {
    if segs.isEmpty { return nil }
    var anchors: [VectorAnchor] = []
    func at(_ p: PathPoint) -> VectorAnchor { VectorAnchor(x: p[0], y: p[1]) }
    anchors.append(at(segs[0].c[0]))
    for s in segs {
        let end = s.c[s.c.count - 1]
        if !s.line { anchors[anchors.count - 1].out = Vec2(s.c[1][0], s.c[1][1]) }
        var next = at(end)
        if !s.line { next.in = Vec2(s.c[2][0], s.c[2][1]) }
        anchors.append(next)
    }
    if closed {
        let last = anchors.removeLast()
        if let h = last.in { anchors[0].in = h }
    }
    let typed = anchors.map { a -> VectorAnchor in
        if let type = types[pointKey(a.x, a.y)] {
            var b = a
            b["type"] = .string(type)
            return tidyAnchor(b, keepType: true)
        }
        return tidyAnchor(a, keepType: false)
    }
    return VectorSubpath(anchors: typed, closed: closed)
}

private func isZeroSeg(_ s: Seg) -> Bool { s.c.allSatisfy { abs($0[0] - s.c[0][0]) < 1e-9 && abs($0[1] - s.c[0][1]) < 1e-9 } }

private func mergePair(_ a: Seg, _ b: Seg, _ tol: Double) -> Seg? {
    let a0 = a.c[0]
    let a3 = a.c[a.c.count - 1]
    let b3 = b.c[b.c.count - 1]
    if a.line && b.line {
        let cx = b3[0] - a0[0]
        let cy = b3[1] - a0[1]
        let len = JS.hypot(cx, cy)
        if len < 1e-12 { return nil }
        let mx = a3[0] - a0[0]
        let my = a3[1] - a0[1]
        let along = (mx * cx + my * cy) / len
        return abs((mx * cy - my * cx) / len) <= tol && along >= 0 && along <= len ? Seg(c: [a0, b3], line: true) : nil
    }
    let ca = a.line ? [a0, a0, a3, a3] : a.c
    let cb = b.line ? [a3, a3, b3, b3] : b.c
    let ta = endTangent(ca)
    let tb = startTangent(cb)
    if ta[0] * tb[0] + ta[1] * tb[1] < 0.99 { return nil }
    var pts: [PathPoint] = []
    sample(ca, 16, &pts, true)
    sample(cb, 16, &pts, false)
    let (curve, error) = fitAcross(pts, 16, startTangent(ca), endTangent(cb))
    return error <= tol ? Seg(c: [curve.p0, curve.p1, curve.p2, curve.p3], line: false) : nil
}

/// Remove Redundant Points: drops anchors that can go without changing the shape by more than `tolerance`.
public func removeRedundantSubpathPoints(_ sp: VectorSubpath, _ tolerance: Double) -> VectorSubpath {
    let tol = JS.max(tolerance, 1e-9)
    var types: [String: String] = [:]
    for a in sp.anchors { if let t = a.rawTypeName, !t.isEmpty { types[pointKey(a.x, a.y)] = t } }
    var segs = segsOf(sp).filter { !isZeroSeg($0) }
    if segs.isEmpty { return VectorSubpath(anchors: sp.anchors.map(cloneAnchor), closed: sp.closed) }
    let minSegs = sp.closed ? 2 : 1
    var changed = true
    while changed && segs.count > minSegs {
        changed = false
        let n = segs.count
        let joints = sp.closed ? n : n - 1
        for j in 0 ..< joints {
            let (i0, i1) = sp.closed ? ((j + n - 1) % n, j) : (j, j + 1)
            guard let m = mergePair(segs[i0], segs[i1], tol) else { continue }
            segs[i0] = m
            segs.remove(at: i1)
            if sp.closed && i1 == 0 { segs.insert(segs.removeLast(), at: 0) }
            changed = true
            break
        }
    }
    return segsToSubpath(segs, sp.closed, types) ?? VectorSubpath(anchors: sp.anchors.map(cloneAnchor), closed: sp.closed)
}
