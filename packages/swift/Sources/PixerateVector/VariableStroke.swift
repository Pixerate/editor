import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// The outline of a variable-width stroke (`vector/varstroke.ts`), as a clean filled Bézier path.
// Each subpath is flattened finely enough for the width to vary smoothly; the stroke is the
// boundary that trapezoids per flattened segment, wedges at bends and caps add up to
// (`variableStrokeRings`), normalised with the polygon boolean and refitted with cubics.
// `Math.*` goes through `JS` (V8's fdlibm), so the rings match the TS bit for bit.

/// `VariableStrokeOptions`.
public struct VariableStrokeOptions {
    /// Stroke width: a side scale of 1 reaches half of it from the centre line.
    public var width: Double
    public var profile: [VectorWidthPoint]
    /// Joins at the path's own corners (default `miter`); bends inside curves are always round.
    public var join: StrokeJoin?
    /// Default `butt`.
    public var cap: StrokeCap?
    /// Default 4 (as SVG).
    public var miterLimit: Double?
    /// Dash pattern (as SVG); the profile still runs along the whole subpath.
    public var dash: [Double]?
    public var dashOffset: Double?
    /// Largest distance of the result from the exact outline (default 0.05).
    public var tolerance: Double?

    public init(width: Double, profile: [VectorWidthPoint], join: StrokeJoin? = nil, cap: StrokeCap? = nil, miterLimit: Double? = nil, dash: [Double]? = nil, dashOffset: Double? = nil, tolerance: Double? = nil) {
        self.width = width
        self.profile = profile
        self.join = join
        self.cap = cap
        self.miterLimit = miterLimit
        self.dash = dash
        self.dashOffset = dashOffset
        self.tolerance = tolerance
    }
}

/// Width samples per subpath at least (so the width varies smoothly along long straight runs).
private let SAMPLES_PER_SUBPATH = 128.0
/// The most dashes one subpath makes.
private let MAX_DASHES = 5000

private typealias P = PathPoint

@inline(__always) private func along(_ p: P, _ v: P, _ k: Double) -> P { P(p[0] + v[0] * k, p[1] + v[1] * k) }
@inline(__always) private func lerp(_ a: P, _ b: P, _ u: Double) -> P { P(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u) }
private func unitOf(_ v: P) -> P {
    let l = JS.hypot(v[0], v[1])
    return l > 0 ? P(v[0] / l, v[1] / l) : P(1, 0)
}
/// The left normal of a direction on screen (y down): `(dy, −dx)`.
@inline(__always) private func leftNormal(_ d: P) -> P { P(d[1], -d[0]) }

/// A flattened subpath: points, their arc lengths, and which are the path's own vertices.
private struct Poly {
    var pts: [P]
    var s: [Double]
    var corner: [Bool]
    var closed: Bool
}

private func flatten(_ segments: [BezierSegment], _ closed: Bool, _ tol: Double) -> Poly? {
    var pts: [P] = []
    var corner: [Bool] = []
    func push(_ p: P, _ isCorner: Bool) {
        if let last = pts.last, dist(last, p) <= 1e-9 {
            corner[corner.count - 1] = corner[corner.count - 1] || isCorner
            return
        }
        pts.append(p)
        corner.append(isCorner)
    }
    for seg in segments {
        var flat = flattenChain([seg], tol)
        // flattenChain drops a closing duplicate; segments that end where they start keep it.
        if dist(seg[0], seg[seg.count - 1]) <= 1e-12 && flat.count > 1 { flat.append(seg[seg.count - 1]) }
        for (i, p) in flat.enumerated() { push(p, i == 0 || i == flat.count - 1) }
    }
    if closed && pts.count > 2 && dist(pts[0], pts[pts.count - 1]) > 1e-9 { push(pts[0], true) }
    if pts.count < 2 { return nil }
    // Subdivide so no piece is longer than the width sampling step.
    var total = 0.0
    for i in 1..<pts.count { total += dist(pts[i - 1], pts[i]) }
    if !(total > 0) { return nil }
    let step = JS.max(total / SAMPLES_PER_SUBPATH, tol)
    var fine: [P] = [pts[0]]
    var fineCorner: [Bool] = [corner[0]]
    for i in 1..<pts.count {
        let n = JS.max(1, JS.ceil(dist(pts[i - 1], pts[i]) / step))
        var k = 1.0
        while k <= n {
            fine.append(k == n ? pts[i] : lerp(pts[i - 1], pts[i], k / n))
            fineCorner.append(k == n ? corner[i] : false)
            k += 1
        }
    }
    var s = [0.0]
    for i in 1..<fine.count { s.append(s[i - 1] + dist(fine[i - 1], fine[i])) }
    return Poly(pts: fine, s: s, corner: fineCorner, closed: closed)
}

/// Arc-length intervals that are "on" for a dash pattern on a path `len` long (effectcraft `dash_intervals`).
public func dashIntervals(_ pattern: [Double], _ offset: Double, _ len: Double) -> [(Double, Double)] {
    var pat = pattern.map { $0.isFinite ? JS.max(0, $0) : 0 }
    if pat.count % 2 == 1 { pat += pat }
    let period = pat.reduce(0, +)
    if pat.count < 2 || !(period > 1e-9) || !(len > 0) { return [(0, len)] }
    let o = offset.isFinite ? offset : 0
    var pos = (o.truncatingRemainder(dividingBy: period) + period).truncatingRemainder(dividingBy: period)
    var idx = 0
    while pos >= pat[idx] {
        pos -= pat[idx]
        idx = (idx + 1) % pat.count
    }
    var out: [(Double, Double)] = []
    var s = 0.0
    var guardCount = 0
    while s < len && guardCount < MAX_DASHES * pat.count {
        guardCount += 1
        let e = JS.min(s + pat[idx] - pos, len)
        if idx % 2 == 0 && e >= s { out.append((s, e)) }
        s += pat[idx] - pos
        pos = 0
        idx = (idx + 1) % pat.count
    }
    return out
}

/// The point at arc length `t` of a polyline and the index of the segment it lies on.
private func at(_ poly: Poly, _ t: Double) -> (P, Int) {
    var i = 1
    while i < poly.pts.count - 1 && poly.s[i] <= t { i += 1 }
    let a = poly.s[i - 1]
    let b = poly.s[i]
    let u = b > a ? JS.min(JS.max((t - a) / (b - a), 0), 1) : 0
    return (lerp(poly.pts[i - 1], poly.pts[i], u), i)
}

/// Points of an arc around `c` from angle `a0` turning by `sweep`, radius going from `r0` to `r1` (ends excluded).
private func arcPoints(_ c: P, _ a0: Double, _ sweep: Double, _ r0: Double, _ r1: Double, _ tol: Double) -> [P] {
    let r = JS.max(r0, r1)
    if !(r > tol * 0.5) || !sweep.isFinite { return [] }
    // `Math.acos` is V8's (`JS.acos`); only the whole number of steps depends on it.
    let stepAngle = 2 * JS.acos(JS.min(JS.max(1 - tol / r, -1), 1))
    let n = JS.min(128, JS.max(2, JS.ceil(abs(sweep) / JS.max(stepAngle, 1e-3))))
    var out: [P] = []
    var k = 1.0
    while k < n {
        let f = k / n
        let a = a0 + sweep * f
        let rr = r0 + (r1 - r0) * f
        out.append(P(c[0] + JS.cos(a) * rr, c[1] + JS.sin(a) * rr))
        k += 1
    }
    return out
}

/// Where segments `a0 → a1` and `b0 → b1` cross, if they do (strictly inside `b`, anywhere past the start of `a`).
private func crossing(_ a0: P, _ a1: P, _ b0: P, _ b1: P) -> P? {
    let r = sub(a1, a0)
    let q = sub(b1, b0)
    let den = r[0] * q[1] - r[1] * q[0]
    if abs(den) < 1e-12 { return nil }
    let w = sub(b0, a0)
    let t = (w[0] * q[1] - w[1] * q[0]) / den
    let u = (w[0] * r[1] - w[1] * r[0]) / den
    return t > 1e-9 && t <= 1 && u >= 0 && u < 1 - 1e-9 ? P(a0[0] + r[0] * t, a0[1] + r[1] * t) : nil
}

/// The rings of a variable-width stroke in the path's own space (`variableStrokeRings`); filled
/// with the non-zero rule they are the stroke. A closed subpath gives two rings, an open run one.
public func variableStrokeRings(_ path: BezierPath, _ options: VariableStrokeOptions) -> [[PathPoint]] {
    let half = options.width / 2
    if !(half > 0) || !half.isFinite { return [] }
    let tol = (options.tolerance ?? 0) > 0 ? options.tolerance! : 0.05
    let join = options.join ?? .miter
    let cap = options.cap ?? .butt
    let miterLimit = (options.miterLimit ?? 0) >= 1 ? options.miterLimit! : 4
    var rings: [[P]] = []
    func push(_ out: inout [P], _ p: P) {
        if let last = out.last, !(dist(last, p) > 1e-12) { return }
        out.append(p)
    }
    for contour in pathToContours(.commands(path)) {
        if contour.segments.isEmpty { continue }
        // Chords of the offsets lose area on the outer side of a curve; a quarter of the tolerance keeps that well inside it.
        guard let poly = flatten(contour.segments, contour.closed, JS.min(tol, half) / 4) else { continue }
        let len = poly.s[poly.s.count - 1]
        func sides(_ s: Double) -> (Double, Double) {
            let w = widthProfileAt(options.profile, s / len)
            return (w.left * half, w.right * half)
        }
        let intervals: [(Double, Double)] = options.dash?.contains(where: { $0 > 0 }) == true ? dashIntervals(options.dash!, options.dashOffset ?? 0, len) : [(0, len)]
        let whole = intervals.count == 1 && intervals[0].0 <= 0 && intervals[0].1 >= len
        for (a, b) in intervals {
            let (pa, ia) = at(poly, a)
            let (pb, ib) = at(poly, b)
            var pts: [(p: P, s: Double, corner: Bool)] = [(pa, a, poly.corner[0] && a <= 0)]
            if ia < ib { for i in ia..<ib { pts.append((poly.pts[i], poly.s[i], poly.corner[i])) } }
            pts.append((pb, b, false))
            let run = pts.enumerated().filter { i, q in i == 0 || dist(q.p, pts[i - 1].p) > 1e-9 }.map(\.element)
            if run.count < 2 {
                // A zero-length dash: only its caps show.
                let (l, r) = sides(a)
                let w = (l + r) / 2
                if cap == .round && w > 0 { rings.append([P(pa[0] + w, pa[1])] + arcPoints(pa, 0, 2 * Double.pi, w, w, tol)) }
                continue
            }
            let closed = whole && poly.closed
            let m = run.count - 1
            var dirs: [P] = []
            for i in 0..<m { dirs.append(unitOf(sub(run[i + 1].p, run[i].p))) }
            let normals = dirs.map(leftNormal)
            let w = run.map { sides($0.s) }
            func wk(_ i: Int, _ k: Int) -> Double { k == 0 ? w[i].0 : w[i].1 }

            /// One side (`sigma` +1 left, −1 right) along the run, joins included.
            func side(_ sigma: Double) -> [P] {
                let k = sigma > 0 ? 0 : 1
                func S(_ i: Int) -> P { along(run[i].p, normals[i], sigma * wk(i, k)) }
                func E(_ i: Int) -> P { along(run[i + 1].p, normals[i], sigma * wk(i + 1, k)) }
                var out: [P] = [S(0)]
                for i in 0..<m {
                    let seam = i == m - 1
                    if seam && !closed {
                        push(&out, E(i))
                        break
                    }
                    let j = seam ? 0 : i + 1
                    let p = run[i + 1].p
                    let d0 = dirs[i]
                    let d1 = dirs[j]
                    let cross = d0[0] * d1[1] - d0[1] * d1[0]
                    let dot = d0[0] * d1[0] + d0[1] * d1[1]
                    let r0 = wk(i + 1, k)
                    let r1 = wk(j, k)
                    let e = E(i)
                    let st = S(j)
                    if abs(cross) < 1e-12 && dot > 0 {
                        push(&out, e)
                        if !seam { push(&out, st) }
                        continue
                    }
                    let uturn = abs(cross) < 1e-12
                    // Turning right on screen puts the left side outside the bend (a U-turn: the left side).
                    let outer = uturn ? sigma > 0 : cross * sigma > 0
                    if !outer {
                        let x = seam ? nil : crossing(out[out.count - 1], e, st, E(j))
                        if let x { push(&out, x) } else {
                            push(&out, e)
                            push(&out, p)
                            if !seam { push(&out, st) }
                        }
                        continue
                    }
                    push(&out, e)
                    let theta = uturn ? Double.pi : JS.atan2(cross, dot)
                    let r = (r0 + r1) / 2
                    let kind: StrokeJoin = run[i + 1].corner || (seam && poly.corner[0]) ? join : .round
                    if r > 1e-9 {
                        if kind == .round {
                            if r * (1 - JS.cos(abs(theta) / 2)) > tol * 0.25 {
                                for q in arcPoints(p, JS.atan2(e[1] - p[1], e[0] - p[0]), theta, r0, r1, tol) { push(&out, q) }
                            }
                        } else if kind == .miter {
                            let halfCos = JS.cos(theta / 2)
                            let bis = P(normals[i][0] + normals[j][0], normals[i][1] + normals[j][1])
                            let bl = JS.hypot(bis[0], bis[1])
                            if halfCos > 1e-6 && 1 / halfCos <= miterLimit && bl > 1e-9 { push(&out, along(p, bis, (sigma * r) / halfCos / bl)) }
                        }
                    }
                    if !seam { push(&out, st) }
                }
                if closed && out.count > 1 && dist(out[0], out[out.count - 1]) <= 1e-12 { out.removeLast() }
                return out
            }
            let left = side(1)
            let right = side(-1)
            if closed {
                rings.append(left)
                rings.append(right.reversed())
                continue
            }
            // Caps: round or square around each end, from one side to the other.
            func capPoints(_ atStart: Bool) -> [P] {
                if cap == .butt { return [] }
                let i = atStart ? 0 : m
                let d = atStart ? dirs[0] : dirs[m - 1]
                let (l, r) = w[i]
                if !(l + r > 1e-9) { return [] }
                let p = run[i].p
                let n = leftNormal(d)
                let L = along(p, n, l)
                let R = along(p, n, -r)
                if cap == .round {
                    // Half a turn around the outside: right side to left at the start, left to right at the end.
                    let a0 = JS.atan2(d[1], d[0]) + (atStart ? Double.pi / 2 : -Double.pi / 2)
                    return arcPoints(p, a0, Double.pi, atStart ? r : l, atStart ? l : r, tol)
                }
                let ext = (l + r) / 2
                let o = atStart ? P(-d[0], -d[1]) : d
                return atStart ? [along(R, o, ext), along(L, o, ext)] : [along(L, o, ext), along(R, o, ext)]
            }
            var ring: [P] = []
            for q in left + capPoints(false) + right.reversed() + capPoints(true) { push(&ring, q) }
            if ring.count > 2 { rings.append(ring) }
        }
    }
    return rings
}

/// The outline of a variable-width stroke of `path` (side widths from `profile`), as a clean
/// Bézier path: overlaps removed, outer rings and holes, each refitted with cubics to within
/// `tolerance` of the exact outline (`variableStrokeOutline`). Fill it with the non-zero rule.
public func variableStrokeOutline(_ path: BezierPath, _ options: VariableStrokeOptions) -> BezierPath {
    let pieces = variableStrokeRings(path, options)
    if pieces.isEmpty { return [] }
    let tol = (options.tolerance ?? 0) > 0 ? options.tolerance! : 0.05
    let polygons = polygonBoolean(.union, [.operand(rings: pieces, fillRule: .nonzero)])
    var out: BezierPath = []
    for polygon in polygons {
        for ring in polygon {
            if ring.count < 3 { continue }
            let cubics = fitCubics(ring, tol, FitCubicsOptions(cornerAngleDeg: 25, closed: true))
            if cubics.isEmpty { continue }
            out.append(.M(x: cubics[0].p0[0], y: cubics[0].p0[1]))
            for (i, c) in cubics.enumerated() {
                if isStraightCubic(c, tol * 0.02) {
                    if i < cubics.count - 1 { out.append(.L(x: c.p3[0], y: c.p3[1])) }
                } else {
                    out.append(.C(x1: c.p1[0], y1: c.p1[1], x2: c.p2[0], y2: c.p2[1], x: c.p3[0], y: c.p3[1]))
                }
            }
            out.append(.Z)
        }
    }
    return out
}

/// Where point `p` lies relative to the stroke's centre line (`nearestStrokePosition`): the
/// nearest point's contour, its position `t` by length (0–1), the distance and the side.
public struct VectorStrokePosition: Sendable {
    public var contour: Int
    public var t: Double
    public var distance: Double
    /// `left` or `right`, looking along the path on screen.
    public var side: String
    public var point: PathPoint
    public var tangent: PathPoint
    public var length: Double
}

public func nearestStrokePosition(_ path: BezierPath, _ p: PathPoint, only: Int? = nil) -> VectorStrokePosition? {
    var best: VectorStrokePosition?
    for (ci, c) in pathToContours(.commands(path)).enumerated() {
        if c.segments.isEmpty || (only != nil && ci != only) { continue }
        let lengths = c.segments.map { segmentLength($0) }
        let total = lengths.reduce(0, +)
        if !(total > 0) { continue }
        var acc = 0.0
        for (si, seg) in c.segments.enumerated() {
            let near = segmentNearest(seg, p)
            if best == nil || near.distance < best!.distance {
                let s = acc + segmentLength(seg, 0, near.t)
                let tan = segmentTangent(seg, near.t)
                let pt = seg.count == 2 ? lerp(seg[0], seg[1], near.t) : evalSeg(seg, near.t)
                let n = leftNormal(tan)
                let side = (p[0] - pt[0]) * n[0] + (p[1] - pt[1]) * n[1] >= 0 ? "left" : "right"
                best = VectorStrokePosition(contour: ci, t: JS.min(JS.max(s / total, 0), 1), distance: near.distance, side: side, point: pt, tangent: tan, length: total)
            }
            acc += lengths[si]
        }
    }
    return best
}

/// de Casteljau.
private func evalSeg(_ seg: BezierSegment, _ t: Double) -> P {
    var pts = seg
    while pts.count > 1 { pts = (1..<pts.count).map { lerp(pts[$0 - 1], pts[$0], t) } }
    return pts[0]
}

/// The point and unit tangent at position `t` (0–1 by length) of contour `index` of `path` (`strokePositionPoint`).
public func strokePositionPoint(_ path: BezierPath, _ index: Int, _ t: Double) -> (point: PathPoint, tangent: PathPoint)? {
    let contours = pathToContours(.commands(path))
    guard contours.indices.contains(index), !contours[index].segments.isEmpty else { return nil }
    let c = contours[index]
    let lengths = c.segments.map { segmentLength($0) }
    let total = lengths.reduce(0, +)
    var want = JS.min(JS.max(t, 0), 1) * total
    for i in 0..<c.segments.count {
        let seg = c.segments[i]
        if want <= lengths[i] + 1e-12 || i == c.segments.count - 1 {
            // Bisect the parameter for the remaining length.
            var lo = 0.0
            var hi = 1.0
            let target = JS.min(want, lengths[i])
            for _ in 0..<40 {
                let mid = (lo + hi) / 2
                if segmentLength(seg, 0, mid) < target { lo = mid } else { hi = mid }
            }
            let u = (lo + hi) / 2
            return (evalSeg(seg, u), segmentTangent(seg, u))
        }
        want -= lengths[i]
    }
    return nil
}
