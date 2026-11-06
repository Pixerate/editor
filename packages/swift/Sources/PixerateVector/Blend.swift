import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Morphing between vector paths (`vector/blend.ts`): bring two shapes to matching anchors, then
// compute in-betweens.
//
// Portions ported from effectcraft-main/crates/path/src/interp.rs, vectorcraft-main/crates/doc/src/blend.rs
// and deckcraft-main/crates/geom/src/morph.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors).
// See THIRD_PARTY_NOTICES.md.
//
// - Contours pair up in order; one without a partner grows out of (or shrinks into) a point at the
//   same place relative to the other shape's box. Lines become cubics with handles at thirds.
// - Anchors are inserted by arc length with de Casteljau splits, spread over the segments in
//   proportion to their length (largest remainder).
// - The closed side of each pair turns to the cyclic start that costs least: what the best-fit
//   rotation leaves over, a little for the turn, plus the χ² distance of log-polar shape-context
//   histograms; the winding is chosen once for all contours.
// - In-betweens follow the best-fit rotation and scale (Procrustes) with the leftover blended in
//   linearly. Colours mix in OKLab, gradients of one style resample their stops to a common set.
//
// The trig goes through `JS.*` (V8's fdlibm), so results compare within the trig tolerance.
// The path keyframe tracks (`evaluateVectorPathKeyframes`) belong to the animation editor and are
// not ported.

/// How a morph is made (`VectorMorphOptions`).
public struct VectorMorphOptions {
    /// Move anchors in straight lines instead of following the best-fit rotation and scale.
    public var linear: Bool = false
    /// 0–1: how much the rotation-aware path outweighs the straight one (default 1).
    public var rigidity: Double?
    /// Fewest segments each contour pair gets (default 16).
    public var minSegments: Double?
    /// At most this far apart along the longer contour, when set.
    public var spacing: Double?
    /// Most segments a contour pair gets (default 400).
    public var maxSegments: Double?
    /// Search the start anchor of closed contours (default true).
    public var matchStart: Bool = true
    /// Compare shape-context histograms when choosing starts (default true).
    public var shapeContext: Bool = true
    /// The anchor each shape's first subpath starts from.
    public var starts: (Int?, Int?)?
    /// Id of the in-between (default: the first shape's id).
    public var id: String?

    public init(linear: Bool = false, rigidity: Double? = nil, minSegments: Double? = nil, spacing: Double? = nil, maxSegments: Double? = nil, matchStart: Bool = true, shapeContext: Bool = true, starts: (Int?, Int?)? = nil, id: String? = nil) {
        self.linear = linear
        self.rigidity = rigidity
        self.minSegments = minSegments
        self.spacing = spacing
        self.maxSegments = maxSegments
        self.matchStart = matchStart
        self.shapeContext = shapeContext
        self.starts = starts
        self.id = id
    }
}

/// Two shapes prepared once; `at(t)` interpolates (0 = `a`, 1 = `b`).
public struct VectorMorph {
    public let at: (Double) throws -> VectorNode
}

// MARK: - Point helpers

@inline(__always) private func lerpN(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }
@inline(__always) private func lerpP(_ a: PathPoint, _ b: PathPoint, _ t: Double) -> PathPoint { PathPoint(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) }
@inline(__always) private func toP(_ x: Double, _ y: Double) -> PathPoint { PathPoint(x, y) }
@inline(__always) private func mapP(_ m: VectorMatrix, _ p: PathPoint) -> PathPoint { PathPoint(m.a * p[0] + m.c * p[1] + m.e, m.b * p[0] + m.d * p[1] + m.f) }

// MARK: - Contours

/// A subpath as cubics: a start anchor, then three points (handle, handle, anchor) per segment.
/// A closed contour's last point repeats its first (`VectorMorphContour`).
public struct VectorMorphContour: Equatable {
    public var closed: Bool
    public var pts: [PathPoint]
    public init(closed: Bool, pts: [PathPoint]) {
        self.closed = closed
        self.pts = pts
    }
}

@inline(__always) private func curvesOf(_ c: VectorMorphContour) -> Int { max(0, (c.pts.count - 1) / 3) }

/// A subpath mapped by `m` as cubics (lines with handles at thirds), or nil when empty (`subpathToMorphContour`).
public func subpathToMorphContour(_ sp: VectorSubpath, _ m: VectorMatrix = IDENTITY_MATRIX) -> VectorMorphContour? {
    let n = sp.anchors.count
    if n == 0 { return nil }
    let first = mapP(m, toP(sp.anchors[0].x, sp.anchors[0].y))
    var pts: [PathPoint] = [first]
    let count = n < 2 ? 0 : sp.closed ? n : n - 1
    for i in 0 ..< count {
        let a = sp.anchors[i]
        let b = sp.anchors[(i + 1) % n]
        let pa = toP(a.x, a.y)
        let pb = toP(b.x, b.y)
        let straight = (a.out == nil || (a.out!.x == a.x && a.out!.y == a.y)) && (b.in == nil || (b.in!.x == b.x && b.in!.y == b.y))
        let c1 = straight ? lerpP(pa, pb, 1.0 / 3) : toP((a.out ?? Vec2(a.x, a.y)).x, (a.out ?? Vec2(a.x, a.y)).y)
        let c2 = straight ? lerpP(pa, pb, 2.0 / 3) : toP((b.in ?? Vec2(b.x, b.y)).x, (b.in ?? Vec2(b.x, b.y)).y)
        pts.append(mapP(m, c1))
        pts.append(mapP(m, c2))
        pts.append(i == count - 1 && sp.closed ? first : mapP(m, pb))
    }
    return VectorMorphContour(closed: sp.closed && count > 0, pts: pts)
}

/// Whether the cubic's handles lie on its chord (it draws a straight line).
private func isStraight(_ p0: PathPoint, _ p1: PathPoint, _ p2: PathPoint, _ p3: PathPoint) -> Bool {
    let dx = p3[0] - p0[0]
    let dy = p3[1] - p0[1]
    let len = JS.hypot(dx, dy)
    let tol = JS.max(1e-7, len * 1e-7)
    if len < 1e-12 { return JS.hypot(p1[0] - p0[0], p1[1] - p0[1]) < tol && JS.hypot(p2[0] - p0[0], p2[1] - p0[1]) < tol }
    func off(_ p: PathPoint) -> Double { abs((p[0] - p0[0]) * dy - (p[1] - p0[1]) * dx) / len }
    func along(_ p: PathPoint) -> Double { ((p[0] - p0[0]) * dx + (p[1] - p0[1]) * dy) / (len * len) }
    let u1 = along(p1)
    let u2 = along(p2)
    return off(p1) < tol && off(p2) < tol && u1 >= -1e-9 && u1 <= 1 + 1e-9 && u2 >= -1e-9 && u2 <= 1 + 1e-9
}

/// A contour back to a subpath, `m` mapping it out of the morph's space (`morphContourToSubpath`).
/// Straight cubics become lines; anchors inside a straight run are dropped.
public func morphContourToSubpath(_ c: VectorMorphContour, _ m: VectorMatrix = IDENTITY_MATRIX, closed closedIn: Bool? = nil) -> VectorSubpath {
    let closed = closedIn ?? c.closed
    let pts = isIdentityMatrix(m) ? c.pts : c.pts.map { mapP(m, $0) }
    let curves = curvesOf(c)
    // A closed contour drops its repeated last anchor; one opened mid-morph keeps it.
    let dropLast = closed && c.closed && curves > 0
    let count = dropLast ? curves : curves + 1
    var anchors: [VectorAnchor] = (0 ..< count).map { k in VectorAnchor(x: pts[3 * k][0], y: pts[3 * k][1]) }
    for k in 0 ..< curves {
        let p0 = pts[3 * k], p1 = pts[3 * k + 1], p2 = pts[3 * k + 2], p3 = pts[3 * k + 3]
        if isStraight(p0, p1, p2, p3) { continue }
        anchors[k].out = Vec2(p1[0], p1[1])
        anchors[(k + 1) % count].in = Vec2(p2[0], p2[1])
    }
    for i in anchors.indices {
        let type = inferAnchorType(anchors[i])
        if type != .corner { anchors[i].type = type }
    }
    let isClosed = closed && curves > 0
    return VectorSubpath(anchors: dropCollinear(anchors, isClosed), closed: isClosed)
}

/// Anchors without the ones that sit inside a straight run (no handles, in line with both neighbours).
private func dropCollinear(_ anchors: [VectorAnchor], _ closed: Bool) -> [VectorAnchor] {
    var out = anchors
    let min = closed ? 3 : 2
    var i = closed ? 0 : 1
    while out.count > min && i < out.count - (closed ? 0 : 1) {
        let n = out.count
        let a = out[(i - 1 + n) % n]
        let b = out[i]
        let c = out[(i + 1) % n]
        let plain = b.in == nil && b.out == nil && a.out == nil && c.in == nil
        let ux = b.x - a.x
        let uy = b.y - a.y
        let vx = c.x - b.x
        let vy = c.y - b.y
        let len = JS.hypot(ux, uy) + JS.hypot(vx, vy)
        if plain && abs(ux * vy - uy * vx) <= 1e-9 * JS.max(1, len * len) && ux * vx + uy * vy >= 0 { out.remove(at: i) } else { i += 1 }
    }
    return out
}

private func segOf(_ c: VectorMorphContour, _ k: Int) -> BezierSegment { Array(c.pts[(3 * k) ..< min(c.pts.count, 3 * k + 4)]) }

/**
 * Exactly the same outline with `segments` cubics (at least as many as it has), the new anchors
 * spread over its segments in proportion to their arc length (largest remainder) and each segment
 * split into pieces of equal arc length (`refineMorphContour`). Also returns where each original
 * anchor went.
 */
public func refineMorphContour(_ c: VectorMorphContour, _ segments: Int) -> (contour: VectorMorphContour, anchors: [Int]) {
    let have = curvesOf(c)
    if have == 0 { return (VectorMorphContour(closed: c.closed, pts: [PathPoint](repeating: c.pts[0], count: 1 + 3 * segments)), [0]) }
    let identity = Array(0 ..< (c.closed ? have : have + 1))
    if have >= segments { return (c, identity) }
    let segs = (0 ..< have).map { segOf(c, $0) }
    let lens = segs.map { segmentLength($0) }
    let sum = lens.reduce(0, +)
    let extra = Double(segments - have)
    let want = lens.map { sum > 1e-12 ? ($0 / sum) * extra : extra / Double(have) }
    var parts = want.map { 1 + Int(JS.floor($0)) }
    var left = segments - parts.reduce(0, +)
    // Remainders that differ by rounding noise tie, so congruent shapes split alike.
    let frac = want.map { $0 - JS.floor($0) }
    let order = jsSorted(Array(parts.indices)) { (a: Int, b: Int) -> Double in
        let d = frac[b] - frac[a]
        return abs(d) > 1e-9 ? d : Double(a - b)
    }
    var i = 0
    while left > 0 {
        parts[order[i]] += 1
        i = (i + 1) % order.count
        left -= 1
    }
    var pts: [PathPoint] = [c.pts[0]]
    var anchors = [0]
    var at = 0
    for (k, seg) in segs.enumerated() {
        let pieces = parts[k]
        var rest = seg
        var t0 = 0.0
        if pieces > 1 {
            for j in 1 ..< pieces {
                let t = segmentParamAtLength(seg, (lens[k] * Double(j)) / Double(pieces), lens[k])
                let span = 1 - t0
                let u = JS.min(1, JS.max(0, (t - t0) / (span != 0 && !span.isNaN ? span : 1)))
                let (l, r) = splitSegment(rest, u)
                pts += [l[1], l[2], l[3]]
                rest = r
                t0 = t
            }
        }
        pts += [rest[1], rest[2], k == have - 1 && c.closed ? c.pts[0] : rest[3]]
        at += pieces
        if k < have - 1 || !c.closed { anchors.append(at) }
    }
    return (VectorMorphContour(closed: c.closed, pts: pts), anchors)
}

/// The same contour run backwards (a closed one keeps its start anchor).
public func reverseMorphContour(_ c: VectorMorphContour) -> VectorMorphContour { VectorMorphContour(closed: c.closed, pts: c.pts.reversed()) }

/// A closed contour starting at anchor `s` (deckcraft's `turn`).
public func turnMorphContour(_ c: VectorMorphContour, _ s: Int) -> VectorMorphContour {
    let n = curvesOf(c)
    if !c.closed || n == 0 { return c }
    let k = ((s % n) + n) % n
    if k == 0 { return c }
    let body = Array(c.pts.dropFirst())
    return VectorMorphContour(closed: true, pts: [c.pts[3 * k]] + Array(body[(3 * k)...]) + Array(body[..<(3 * k)]))
}

/// Anchor positions of a contour (a closed one without its repeated end).
private func anchorPoints(_ c: VectorMorphContour) -> [PathPoint] {
    let n = curvesOf(c)
    let count = c.closed ? n : n + 1
    return (0 ..< max(1, count)).map { c.pts[3 * $0] }
}

/// Signed area of a contour's anchor polygon.
private func polygonArea(_ pts: [PathPoint]) -> Double {
    var s = 0.0
    for i in pts.indices {
        let a = pts[i]
        let b = pts[(i + 1) % pts.count]
        s += a[0] * b[1] - b[0] * a[1]
    }
    return s / 2
}

// MARK: - Correspondence

/// Centroid and RMS radius.
private func frame(_ v: [PathPoint]) -> (c: PathPoint, r: Double) {
    let n = Double(max(1, v.count))
    var cx = 0.0
    var cy = 0.0
    for p in v {
        cx += p[0]
        cy += p[1]
    }
    cx /= n
    cy /= n
    var s = 0.0
    for p in v { s += (p[0] - cx) * (p[0] - cx) + (p[1] - cy) * (p[1] - cy) }
    return (PathPoint(cx, cy), JS.max(1e-9, JS.sqrt(s / n)))
}

private let RBINS = 5
private let ABINS = 12
/// Weight of the turn a start implies: among starts that fit equally well, the least turning wins.
private let TURN_WEIGHT = 0.1
private let TWO_PI = 2 * Double.pi

/// Log-polar shape-context histograms of every point (distances by the RMS radius, angles from
/// the contour's direction at the point).
private func shapeContexts(_ v: [PathPoint], _ closed: Bool) -> [[Double]] {
    let r = frame(v).r
    let n = v.count
    return v.enumerated().map { i, p in
        let prev = v[closed ? (i - 1 + n) % n : max(0, i - 1)]
        let next = v[closed ? (i + 1) % n : min(n - 1, i + 1)]
        let dir = JS.atan2(next[1] - prev[1], next[0] - prev[0])
        var h = [Double](repeating: 0, count: RBINS * ABINS)
        var total = 0.0
        for j in 0 ..< n where i != j {
            let dx = v[j][0] - p[0]
            let dy = v[j][1] - p[1]
            let d = JS.hypot(dx, dy) / r
            // log radius in [1/8, 2] → five bins.
            let lr = ((JS.log2(JS.max(d, 1e-6)) + 3) / 4) * Double(RBINS)
            if !(lr >= 0 && lr < Double(RBINS)) { continue }
            var ang = JS.atan2(dy, dx) - dir
            ang = (ang.truncatingRemainder(dividingBy: TWO_PI) + TWO_PI).truncatingRemainder(dividingBy: TWO_PI)
            h[Int(JS.floor(lr)) * ABINS + min(ABINS - 1, Int(JS.floor((ang / TWO_PI) * Double(ABINS))))] += 1
            total += 1
        }
        if total > 0 { for k in h.indices { h[k] /= total } }
        return h
    }
}

private func chi2(_ a: [Double], _ b: [Double]) -> Double {
    var s = 0.0
    for k in a.indices {
        let t = a[k] + b[k]
        if t > 1e-12 { s += ((a[k] - b[k]) * (a[k] - b[k])) / t }
    }
    return s / 2
}

/// The cyclic start of the closed `free` contour that matches `fixed` best, and its cost (`bestStart`).
private func bestStart(_ fixed: VectorMorphContour, _ free: VectorMorphContour, _ useShapeContext: Bool) -> (start: Int, cost: Double) {
    let fa = anchorPoints(fixed)
    let ga = anchorPoints(free)
    let n = ga.count
    let ff = frame(fa)
    let gf = frame(ga)
    let fn = fa.map { PathPoint(($0[0] - ff.c[0]) / ff.r, ($0[1] - ff.c[1]) / ff.r) }
    let gn = ga.map { PathPoint(($0[0] - gf.c[0]) / gf.r, ($0[1] - gf.c[1]) / gf.r) }
    let fsc = useShapeContext ? shapeContexts(fa, fixed.closed) : nil
    let gsc = useShapeContext ? shapeContexts(ga, free.closed) : nil
    let m = Double(max(1, fn.count))
    func cost(_ s: Int) -> Double {
        var dot = 0.0
        var cross = 0.0
        var sc = 0.0
        for i in fn.indices {
            let j = free.closed ? (i + s) % n : i
            let p = fn[i]
            // `gn[j]` past the end is `undefined` in the TS: NaN arithmetic.
            let q = j < gn.count ? gn[j] : PathPoint(.nan, .nan)
            dot += p[0] * q[0] + p[1] * q[1]
            cross += p[0] * q[1] - p[1] * q[0]
            if let fsc, let gsc { sc += j < gsc.count ? chi2(fsc[i], gsc[j]) : .nan }
        }
        // Unit RMS on both sides: what the best rotation and scale leave over, as a fraction.
        let residual = JS.max(0, 1 - (dot * dot + cross * cross) / (m * m))
        let turn = 1 - JS.cos(JS.atan2(cross, dot))
        return residual + TURN_WEIGHT * turn + sc / m
    }
    if !free.closed { return (0, cost(0)) }
    // Long contours: every few starts first, then the neighbours of the best.
    let stride = n > 96 ? Int(JS.ceil(Double(n) / 48)) : 1
    var best = (start: 0, cost: Double.infinity)
    var s = 0
    while s < n {
        let c = cost(s)
        if c < best.cost - 1e-12 { best = (s, c) }
        s += stride
    }
    if stride > 1 {
        let s0 = best.start
        for d in 1 ..< stride {
            for s in [(s0 + d) % n, (s0 - d + n) % n] {
                let c = cost(s)
                if c < best.cost - 1e-12 { best = (s, c) }
            }
        }
    }
    return best
}

private func boundsOfPoints(_ pts: [PathPoint]) -> VectorBounds? {
    if pts.isEmpty { return nil }
    var x0 = Double.infinity, y0 = Double.infinity, x1 = -Double.infinity, y1 = -Double.infinity
    for p in pts {
        x0 = JS.min(x0, p[0])
        y0 = JS.min(y0, p[1])
        x1 = JS.max(x1, p[0])
        y1 = JS.max(y1, p[1])
    }
    return VectorBounds(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
}

/// The spot a contour without partner grows from: the same place relative to the other shape's box.
private func placeIn(_ c: VectorMorphContour, _ from: VectorBounds?, _ to: VectorBounds?) -> PathPoint {
    let b = unionBounds([boundsOfPoints(c.pts)])
    let p = b.map { PathPoint($0.x + $0.width / 2, $0.y + $0.height / 2) } ?? c.pts[0]
    guard let from, let to else { return p }
    let fx = from.width > 0 ? (p[0] - from.x) / from.width : 0.5
    let fy = from.height > 0 ? (p[1] - from.y) / from.height : 0.5
    return PathPoint(to.x + to.width * fx, to.y + to.height * fy)
}

/// Two shapes' contours with matching structure (`VectorMorphCorrespondence`).
public struct VectorMorphCorrespondence {
    public var a: [VectorMorphContour]
    public var b: [VectorMorphContour]
    /// Whether `b` runs backwards relative to its stored direction.
    public var reversed: Bool
}

/// Gives two lists of contours the same structure with matching anchors (`correspondMorphContours`).
public func correspondMorphContours(_ a: [VectorMorphContour], _ b: [VectorMorphContour], _ options: VectorMorphOptions = VectorMorphOptions()) -> VectorMorphCorrespondence {
    let minSeg = Int(JS.max(1, JS.round(options.minSegments ?? 16)))
    let maxSeg = Int(JS.max(Double(minSeg), JS.round(options.maxSegments ?? 400)))
    let spacing = options.spacing.flatMap { $0 > 0 ? $0 : nil }
    let useSC = options.shapeContext
    let match = options.matchStart
    let ba = boundsOfPoints(a.flatMap(\.pts))
    let bb = boundsOfPoints(b.flatMap(\.pts))
    func contourLength(_ c: VectorMorphContour) -> Double {
        var l = 0.0
        for k in 0 ..< curvesOf(c) { l += segmentLength(segOf(c, k)) }
        return l
    }
    struct Pair {
        var x: VectorMorphContour
        var y: VectorMorphContour
        var point: Bool
        var startX: Int?
        var startY: Int?
    }
    var pairs: [Pair] = []
    let sa = options.starts?.0
    let sb = options.starts?.1
    for k in 0 ..< max(a.count, b.count) {
        let ca = k < a.count ? a[k] : nil
        let cb = k < b.count ? b[k] : nil
        let explicitA = k == 0 ? sa : nil
        let explicitB = k == 0 ? sb : nil
        let counts = [ca.map(curvesOf) ?? 0, cb.map(curvesOf) ?? 0]
        let longest = JS.max(ca.map(contourLength) ?? 0, cb.map(contourLength) ?? 0)
        var n = max(counts[0], counts[1], minSeg, spacing.map { Int(JS.ceil(longest / $0)) } ?? 0)
        n = max(counts[0], counts[1], min(n, maxSeg))
        func point(_ c: VectorMorphContour, _ from: VectorBounds?, _ to: VectorBounds?) -> VectorMorphContour {
            let p = placeIn(c, from, to)
            return VectorMorphContour(closed: c.closed, pts: [PathPoint](repeating: p, count: 1 + 3 * n))
        }
        if let ca, let cb {
            let ra = refineMorphContour(ca, n)
            let rb = refineMorphContour(cb, n)
            var pair = Pair(x: ra.contour, y: rb.contour, point: false, startX: nil, startY: nil)
            if let e = explicitA { pair.startX = e >= 0 && e < ra.anchors.count ? ra.anchors[e] : nil }
            if let e = explicitB { pair.startY = e == rb.anchors.count - 1 && !cb.closed ? -1 : (e >= 0 && e < rb.anchors.count ? rb.anchors[e] : nil) }
            if let e = explicitA, !ca.closed, e == ra.anchors.count - 1, e > 0 { pair.startX = -1 }
            pairs.append(pair)
        } else if let ca {
            pairs.append(Pair(x: refineMorphContour(ca, n).contour, y: point(ca, ba, bb), point: true, startX: nil, startY: nil))
        } else if let cb {
            pairs.append(Pair(x: point(cb, bb, ba), y: refineMorphContour(cb, n).contour, point: true, startX: nil, startY: nil))
        }
    }
    // Explicit starts: closed contours turn to the clicked anchor; an open one clicked at its end runs backwards.
    func startAt(_ c: VectorMorphContour, _ s: Int?) -> VectorMorphContour {
        guard let s else { return c }
        if s == -1 { return reverseMorphContour(c) }
        return c.closed ? turnMorphContour(c, s) : c
    }
    let explicit = !pairs.isEmpty && (pairs[0].startX != nil || pairs[0].startY != nil)
    // Winding: closed shapes keep the same turning direction, judged on the first pair of closed
    // contours; open paths take whichever direction costs less, unless a click fixed it.
    let ref = pairs.first { !$0.point && $0.x.closed && $0.y.closed }
    let fixedBack: Bool? = ref.map { r in
        let ax = polygonArea(anchorPoints(r.x))
        let ay = polygonArea(anchorPoints(r.y))
        return jsSign(ax) != jsSign(ay) && abs(ay) > 1e-12
    } ?? (explicit ? false : nil)
    var best: (xs: [VectorMorphContour], ys: [VectorMorphContour], cost: Double, back: Bool)?
    for back in fixedBack.map({ [$0] }) ?? [false, true] {
        var xs: [VectorMorphContour] = []
        var ys: [VectorMorphContour] = []
        var cost = 0.0
        for (k, p) in pairs.enumerated() {
            var x = k == 0 ? startAt(p.x, p.startX) : p.x
            var y = k == 0 ? startAt(p.y, p.startY) : p.y
            if back { y = reverseMorphContour(y) }
            if p.point {
                xs.append(x)
                ys.append(y)
                continue
            }
            let pinned = k == 0 && explicit
            // The closed side turns: `b` when it is closed, else `a`.
            let turnX = !y.closed && x.closed
            if match && !pinned && (y.closed || turnX) {
                let r = turnX ? bestStart(y, x, useSC) : bestStart(x, y, useSC)
                if turnX { x = turnMorphContour(x, r.start) } else { y = turnMorphContour(y, r.start) }
                cost += r.cost
            } else {
                cost += bestStart(x, VectorMorphContour(closed: false, pts: y.pts), useSC).cost
            }
            xs.append(x)
            ys.append(y)
        }
        if best == nil || cost < best!.cost - 1e-9 { best = (xs, ys, cost, back) }
    }
    guard let best else { return VectorMorphCorrespondence(a: [], b: [], reversed: false) }
    return VectorMorphCorrespondence(a: best.xs, b: best.ys, reversed: best.back)
}

/// `Math.sign` (NaN stays NaN, ±0 keeps its sign; compared with `!==`, so -0 equals 0).
private func jsSign(_ v: Double) -> Double { v.isNaN ? .nan : v > 0 ? 1 : v < 0 ? -1 : 0 }

// MARK: - In-betweens

/// The similarity (rotation θ, scale s, centroids) that best maps `a`'s anchors onto `b`'s.
struct VectorMorphSimilarity {
    var ca: PathPoint
    var cb: PathPoint
    var theta: Double
    var s: Double
}

private func procrustes(_ a: [VectorMorphContour], _ b: [VectorMorphContour]) -> VectorMorphSimilarity {
    let pa = a.flatMap(anchorPoints)
    let pb = b.flatMap(anchorPoints)
    let ca = frame(pa).c
    let cb = frame(pb).c
    var ss = 0.0
    var dot = 0.0
    var cross = 0.0
    for i in 0 ..< min(pa.count, pb.count) {
        let p = PathPoint(pa[i][0] - ca[0], pa[i][1] - ca[1])
        let q = PathPoint(pb[i][0] - cb[0], pb[i][1] - cb[1])
        ss += p[0] * p[0] + p[1] * p[1]
        dot += p[0] * q[0] + p[1] * q[1]
        cross += p[0] * q[1] - p[1] * q[0]
    }
    return VectorMorphSimilarity(ca: ca, cb: cb, theta: JS.atan2(cross, dot), s: ss > 1e-12 ? JS.hypot(dot, cross) / ss : 1)
}

/// Corresponded contours at `u` (`interpolateMorphContours`): each point carried by the similarity
/// interpolated to `u`, plus `u` of what the full similarity leaves over, blended with the
/// straight path by `rigidity`.
func interpolateMorphContours(_ a: [VectorMorphContour], _ b: [VectorMorphContour], _ u: Double, linear: Bool = false, rigidity: Double? = nil, similarity: VectorMorphSimilarity? = nil) -> [VectorMorphContour] {
    let w = linear ? 0 : JS.min(1, JS.max(0, rigidity ?? 1))
    let sim = w > 0 ? (similarity ?? procrustes(a, b)) : nil
    func rot(_ p: PathPoint, _ ang: Double, _ k: Double) -> PathPoint {
        let c = JS.cos(ang)
        let s = JS.sin(ang)
        return PathPoint(k * (c * p[0] - s * p[1]), k * (s * p[0] + c * p[1]))
    }
    let thetaU = sim.map { $0.theta * u } ?? 0
    let sU = sim.map { JS.pow(JS.max(1e-9, $0.s), u) } ?? 1
    let cU = sim.map { lerpP($0.ca, $0.cb, u) } ?? PathPoint(0, 0)
    return a.enumerated().map { k, ca in
        let cb = b[k]
        let pts = ca.pts.enumerated().map { i, p -> PathPoint in
            let q = i < cb.pts.count ? cb.pts[i] : p
            let linearP = lerpP(p, q, u)
            guard let sim else { return linearP }
            let d = PathPoint(p[0] - sim.ca[0], p[1] - sim.ca[1])
            let full = rot(d, sim.theta, sim.s)
            let resid = PathPoint(q[0] - (full[0] + sim.cb[0]), q[1] - (full[1] + sim.cb[1]))
            let part = rot(d, thetaU, sU)
            let rigid = PathPoint(part[0] + cU[0] + resid[0] * u, part[1] + cU[1] + resid[1] * u)
            return lerpP(linearP, rigid, w)
        }
        return VectorMorphContour(closed: ca.closed && cb.closed, pts: pts)
    }
}

// MARK: - Transforms

/// Interpolates two rigid matrices as a rotation (the shorter way round) plus a translation
/// (`interpolateRigidMatrix`). Scale and skew interpolate linearly in the rotated frame.
public func interpolateRigidMatrix(_ a: VectorMatrix, _ b: VectorMatrix, _ t: Double) -> VectorMatrix {
    func decompose(_ m: VectorMatrix) -> (e: Double, f: Double, ang: Double, sx: Double, sh: Double, sy: Double) {
        let sx = JS.hypot(m.a, m.b)
        let ang = sx > 1e-12 ? JS.atan2(m.b, m.a) : 0
        let c = JS.cos(ang)
        let s = JS.sin(ang)
        return (m.e, m.f, ang, sx, c * m.c + s * m.d, -s * m.c + c * m.d)
    }
    let p = decompose(a)
    let q = decompose(b)
    var turn = q.ang - p.ang
    turn = (((turn + Double.pi).truncatingRemainder(dividingBy: TWO_PI) + TWO_PI).truncatingRemainder(dividingBy: TWO_PI)) - Double.pi
    let ang = p.ang + turn * t
    let sx = lerpN(p.sx, q.sx, t)
    let sh = lerpN(p.sh, q.sh, t)
    let sy = lerpN(p.sy, q.sy, t)
    let c = JS.cos(ang)
    let s = JS.sin(ang)
    return VectorMatrix(c * sx, s * sx, c * sh - s * sy, s * sh + c * sy, lerpN(p.e, q.e, t), lerpN(p.f, q.f, t))
}

// MARK: - Paint

/// Two colours mixed in OKLab with premultiplied alpha (`mixColorsOklab` of `animation/color.ts`),
/// or nil when either is not a readable colour.
func mixColorsOklab(_ from: String, _ to: String, _ t: Double) -> String? {
    guard let x = parseVectorColor(from), let y = parseVectorColor(to) else { return nil }
    let a = vectorRgbToOklab(x[0], x[1], x[2]), aa = x[3]
    let b = vectorRgbToOklab(y[0], y[1], y[2]), ba = y[3]
    let alpha = aa + (ba - aa) * t
    func premul(_ k: Int) -> Double { a[k] * aa + (b[k] * ba - a[k] * aa) * t }
    let lab = alpha <= 1e-9 ? [a[0] + (b[0] - a[0]) * t, 0, 0] : [premul(0) / alpha, premul(1) / alpha, premul(2) / alpha]
    let rgb = vectorOklabToRgb(lab[0], lab[1], lab[2])
    return vectorRgbaToHex(rgb[0], rgb[1], rgb[2], alpha <= 1e-9 ? 0 : alpha)
}

/// `#rrggbb`, or `#rrggbbaa` when not opaque, from 0–1 channels (`rgbaToHex`).
func vectorRgbaToHex(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> String {
    func byte(_ v: Double) -> Int { Int(JS.round(JS.min(1, JS.max(0, v)) * 255)) }
    func hex2(_ n: Int) -> String { (n < 16 ? "0" : "") + String(n, radix: 16) }
    let head = "#\(hex2(byte(r)))\(hex2(byte(g)))\(hex2(byte(b)))"
    let alpha = byte(a)
    return alpha == 255 ? head : head + hex2(alpha)
}

/// Two colours mixed in OKLab (premultiplied alpha); unreadable colours switch halfway (`interpolateVectorColor`).
public func interpolateVectorColor(_ a: String, _ b: String, _ t: Double) -> String {
    if t <= 0 { return a }
    if t >= 1 { return b }
    return mixColorsOklab(a, b, t) ?? (t < 0.5 ? a : b)
}

/// A gradient's stops resampled at `offsets`, each painting what the gradient paints there (`resampleGradientStops`).
public func resampleGradientStops(_ g: JSONObject, _ offsets: [Double]) -> [JSONObject] {
    offsets.map { offset in
        let s = sampleVectorGradient(g, offset)
        var o = JSONObject([("offset", .number(offset)), ("color", .string(s.color))])
        if s.opacity < 1 { o["opacity"] = .number(JS.round(s.opacity * 1e4) / 1e4) }
        return o
    }
}

private func lerpAngle(_ a: Double, _ b: Double, _ t: Double) -> Double {
    let d = (((b - a + 180).truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)) - 180
    return a + d * t
}

private func lerpPoint(_ a: Vec2, _ b: Vec2, _ t: Double) -> Vec2 { Vec2(lerpN(a.x, b.x, t), lerpN(a.y, b.y, t)) }

private func sameColourModel(_ a: JSONObject, _ b: JSONObject) -> Bool {
    (a["interpolation"]?.stringValue ?? "srgb") == (b["interpolation"]?.stringValue ?? "srgb") && (a["smoothness"]?.numberValue ?? 0) == (b["smoothness"]?.numberValue ?? 0)
}

/// Stops of two gradients mixed: stop by stop when they match, else resampled to a common set.
private func lerpStops(_ a: JSONObject, _ b: JSONObject, _ t: Double) -> (stops: [JSONObject], resampled: Bool) {
    var stopsA = sortedVectorGradientStops(a)
    var stopsB = sortedVectorGradientStops(b)
    let resampled = stopsA.count != stopsB.count || !sameColourModel(a, b)
    if resampled {
        // Where either gradient bends (its own stops and the extra stops its midpoints and colour space need).
        let offs = (expandVectorGradientStops(a).map(\.offset) + expandVectorGradientStops(b).map(\.offset) + stopsA.map { $0["offset"]!.numberValue! } + stopsB.map { $0["offset"]!.numberValue! })
            .filter(\.isFinite).sorted()
        var common: [Double] = []
        for (i, o) in offs.enumerated() where i == 0 || o - offs[i - 1] > 1e-4 { common.append(o) }
        stopsA = resampleGradientStops(a, common)
        stopsB = resampleGradientStops(b, common)
    }
    let stops = stopsA.enumerated().map { i, x -> JSONObject in
        let y = stopsB[i]
        let opacity = lerpN(x["opacity"]?.numberValue ?? 1, y["opacity"]?.numberValue ?? 1, t)
        var stop = JSONObject([("offset", .number(lerpN(x["offset"]!.numberValue!, y["offset"]!.numberValue!, t))), ("color", .string(interpolateVectorColor(x["color"]!.stringValue!, y["color"]!.stringValue!, t)))])
        if opacity < 1 { stop["opacity"] = .number(opacity) }
        let mid = lerpN(x["midpoint"]?.numberValue ?? 0.5, y["midpoint"]?.numberValue ?? 0.5, t)
        if abs(mid - 0.5) > 1e-6 { stop["midpoint"] = .number(mid) }
        return stop
    }
    return (stops, resampled)
}

/// Two gradients of one style mixed (`lerpGradient`): stops, then the placement. Nil for different styles.
private func lerpGradient(_ a: JSONObject, _ b: JSONObject, _ t: Double) -> JSONObject? {
    let type = a["type"]?.stringValue ?? ""
    if type != b["type"]?.stringValue { return nil }
    let (stops, resampled) = lerpStops(a, b, t)
    let near = t < 0.5 ? a : b
    var out = JSONObject([("type", .string(type)), ("stops", .array(stops.map { .object($0) }))])
    if !resampled {
        if let i = a["interpolation"]?.stringValue, !i.isEmpty, i != "srgb" { out["interpolation"] = .string(i) }
        if truthy(a["smoothness"]) { out["smoothness"] = a["smoothness"] }
    }
    if let s = near["spread"]?.stringValue, !s.isEmpty, s != "pad" { out["spread"] = .string(s) }
    if let s = near["strokeMode"]?.stringValue, !s.isEmpty, s != "within" { out["strokeMode"] = .string(s) }
    let ea = hasExplicitGradientGeometry(a)
    let eb = hasExplicitGradientGeometry(b)
    let lineLike = type == "linear" || type == "reflected"
    if !ea && !eb {
        if a["angle"] != nil || b["angle"] != nil || lineLike {
            let fallback: Double = lineLike ? 180 : 90
            out["angle"] = .number(lerpAngle(a["angle"]?.numberValue ?? fallback, b["angle"]?.numberValue ?? fallback, t))
        }
        if !lineLike {
            out["cx"] = .number(lerpN(a["cx"]?.numberValue ?? 0.5, b["cx"]?.numberValue ?? 0.5, t))
            out["cy"] = .number(lerpN(a["cy"]?.numberValue ?? 0.5, b["cy"]?.numberValue ?? 0.5, t))
            out["r"] = .number(lerpN(a["r"]?.numberValue ?? 0.5, b["r"]?.numberValue ?? 0.5, t))
        }
        return out
    }
    let pa = vectorGradientPoints(a)
    let pb = vectorGradientPoints(b)
    if pa.userSpace != pb.userSpace {
        var src = explicitVectorGradient(near)
        src["stops"] = out["stops"]
        if let i = out["interpolation"] { src["interpolation"] = i }
        if let s = out["smoothness"] { src["smoothness"] = s }
        return src
    }
    out["start"] = lerpPoint(pa.start, pb.start, t).json
    out["end"] = lerpPoint(pa.end, pb.end, t).json
    out["width"] = lerpPoint(pa.width, pb.width, t).json
    out["units"] = .string(pa.userSpace ? "userSpaceOnUse" : "objectBoundingBox")
    if type == "radial" {
        if pa.focal != nil || pb.focal != nil { out["focal"] = lerpPoint(pa.focal ?? pa.start, pb.focal ?? pb.start, t).json }
        let fr = lerpN(pa.focalRadius, pb.focalRadius, t)
        if fr > 0 { out["focalRadius"] = .number(fr) }
    }
    return out
}

/// A gradient shaped like `like` painting one colour (or nothing).
private func solidLike(_ color: String?, _ like: JSONObject) -> JSONObject {
    var out = like
    out["stops"] = .array((like["stops"]?.arrayValue ?? []).map { s in
        let offset = s["offset"] ?? .null
        if let color { return .object(JSONObject([("offset", offset), ("color", .string(color))])) }
        return .object(JSONObject([("offset", offset), ("color", s["color"] ?? .null), ("opacity", 0)]))
    })
    return out
}

/// Interpolates paints (`interpolateVectorPaint`): colours in OKLab, gradients of one kind with
/// their stops resampled, a colour and a gradient through a gradient of that colour, a missing
/// paint fading from transparent. Different kinds switch halfway. Nil is `undefined`.
public func interpolateVectorPaint(_ a: JSONValue?, _ b: JSONValue?, _ t: Double) -> JSONValue? {
    if t <= 0 { return a }
    if t >= 1 { return b }
    let pa = hasPaint(a)
    let pb = hasPaint(b)
    if !pa && !pb { return t < 0.5 ? a : b }
    if let x = a?.stringValue, pa, let y = b?.stringValue, pb { return .string(interpolateVectorColor(x, y, t)) }
    if !pa, let y = b?.stringValue { return .string(interpolateVectorColor("transparent", y, t)) }
    if !pb, let x = a?.stringValue { return .string(interpolateVectorColor(x, "transparent", t)) }
    let ga = pa && isVectorGradient(a) ? a?.objectValue : nil
    let gb = pb && isVectorGradient(b) ? b?.objectValue : nil
    if let ga, let gb { return lerpGradient(ga, gb, t).map { .object($0) } ?? (t < 0.5 ? a : b) }
    if let gb { return lerpGradient(solidLike(pa ? a?.stringValue : nil, gb), gb, t).map { .object($0) } ?? b }
    if let ga { return lerpGradient(ga, solidLike(pb ? b?.stringValue : nil, ga), t).map { .object($0) } ?? a }
    return t < 0.5 ? a : b
}

private func widthPoints(_ v: JSONValue?) -> [VectorWidthPoint]? {
    v?.arrayValue?.map { p in VectorWidthPoint(t: p["t"]?.numberValue ?? .nan, left: p["left"]?.numberValue ?? .nan, right: p["right"]?.numberValue ?? .nan) }
}

/// Width profiles at every position either has a point (no profile is uniform; `interpolateWidthProfiles`).
public func interpolateWidthProfiles(_ a: [VectorWidthPoint]?, _ b: [VectorWidthPoint]?, _ t: Double) -> [VectorWidthPoint]? {
    if (a ?? []).isEmpty && (b ?? []).isEmpty { return nil }
    let at = ((a ?? []).map(\.t) + (b ?? []).map(\.t) + [0, 1]).sorted { $0 < $1 }
    var ts: [Double] = []
    for (i, v) in at.enumerated() where i == 0 || v - at[i - 1] > 1e-6 { ts.append(v) }
    return ts.map { pos in
        let x = widthProfileAt(a, pos)
        let y = widthProfileAt(b, pos)
        return VectorWidthPoint(t: pos, left: lerpN(x.left, y.left, t), right: lerpN(x.right, y.right, t))
    }
}

/// Dash patterns: equal lengths mix; a solid stroke counts as the other's pattern with its gaps closed.
private func lerpDashes(_ a: [Double]?, _ b: [Double]?, _ t: Double) -> [Double]? {
    func dashed(_ d: [Double]?) -> Bool { !(d ?? []).isEmpty && d!.contains { $0 > 0 } }
    if !dashed(a) && !dashed(b) { return t < 0.5 ? a : b }
    func even(_ p: [Double]) -> [Double] { p.count % 2 == 1 ? p + p : p }
    func solid(_ p: [Double]) -> [Double] {
        let e = even(p)
        var out: [Double] = []
        for i in stride(from: 0, to: e.count, by: 2) { out += [e[i] + e[i + 1], 0] }
        return out
    }
    let x = dashed(a) ? even(a!) : solid(b!)
    let y = dashed(b) ? even(b!) : solid(a!)
    if x.count != y.count { return t < 0.5 ? a : b }
    return x.enumerated().map { i, v in lerpN(v, y[i], t) }
}

private let SWITCHED_KEYS = ["strokeLinecap", "strokeLinejoin", "fillRule", "strokeAlign", "startArrow", "endArrow", "arrowAlign"]

/// Interpolated style of two paths (`interpolateVectorStyle`): paints, stroke width, dashes,
/// arrowhead scales and width profiles mix; caps, joins, the fill rule, alignment and arrowheads
/// switch halfway. Styles are JSON objects of `VectorStyle` fields.
public func interpolateVectorStyle(_ a: JSONObject, _ b: JSONObject, _ t: Double) -> JSONObject {
    let near = t < 0.5 ? a : b
    var out = JSONObject()
    if let fill = interpolateVectorPaint(a["fill"], b["fill"], t) { out["fill"] = fill }
    if let stroke = interpolateVectorPaint(a["stroke"], b["stroke"], t) { out["stroke"] = stroke }
    if a["strokeWidth"] != nil || b["strokeWidth"] != nil { out["strokeWidth"] = .number(lerpN(a["strokeWidth"]?.numberValue ?? 1, b["strokeWidth"]?.numberValue ?? 1, t)) }
    for key in SWITCHED_KEYS { if let v = near[key], v != .null { out[key] = v } }
    for key in ["startArrowScale", "endArrowScale"] where a[key] != nil || b[key] != nil {
        out[key] = .number(lerpN(a[key]?.numberValue ?? 1, b[key]?.numberValue ?? 1, t))
    }
    func dashes(_ v: JSONValue?) -> [Double]? { v?.arrayValue?.map { $0.numberValue ?? .nan } }
    if let dash = lerpDashes(dashes(a["strokeDasharray"]), dashes(b["strokeDasharray"]), t), !dash.isEmpty { out["strokeDasharray"] = .array(dash.map { .number($0) }) }
    if let profile = interpolateWidthProfiles(widthPoints(a["strokeWidthProfile"]), widthPoints(b["strokeWidthProfile"]), t) { out["strokeWidthProfile"] = .array(profile.map(\.json)) }
    return out
}

/// A path's style as seen running backwards: arrowheads swap ends and width profiles reverse.
private func reversedStyle(_ s: JSONObject) -> JSONObject {
    var out = s
    out["startArrow"] = s["endArrow"]
    out["endArrow"] = s["startArrow"]
    out["startArrowScale"] = s["endArrowScale"]
    out["endArrowScale"] = s["startArrowScale"]
    if let p = widthPoints(s["strokeWidthProfile"]), !p.isEmpty { out["strokeWidthProfile"] = .array(reverseWidthProfile(p).map(\.json)) }
    return out
}

private let STYLE_KEYS = ["fill", "stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin", "strokeDasharray", "fillRule", "strokeAlign", "startArrow", "endArrow", "arrowAlign", "startArrowScale", "endArrowScale", "strokeWidthProfile"]

private func styleOf(_ n: VectorNode) -> JSONObject {
    var out = JSONObject()
    for k in STYLE_KEYS { if let v = n[k] { out[k] = v } }
    return out
}

// MARK: - Path and node morphs

private func contoursOf(_ node: VectorNode, _ m: VectorMatrix) -> [VectorMorphContour] {
    expandVectorCorners(node.subpaths).compactMap { subpathToMorphContour($0, m) }
}

/// Two paths (each placed by `ma` / `mb` into a common space) prepared for interpolation.
private func preparePathMorph(_ a: VectorNode, _ b: VectorNode, _ options: VectorMorphOptions, _ maIn: VectorMatrix? = nil, _ mbIn: VectorMatrix? = nil) -> (Double) -> VectorNode {
    let ma = maIn ?? nodeMatrix(a)
    let mb = mbIn ?? nodeMatrix(b)
    let corr = correspondMorphContours(contoursOf(a, ma), contoursOf(b, mb), options)
    let sim = procrustes(corr.a, corr.b)
    let styleA = styleOf(a)
    let styleB = corr.reversed ? reversedStyle(styleOf(b)) : styleOf(b)
    let rigid = !isIdentityMatrix(ma) || !isIdentityMatrix(mb)
    let id = options.id ?? a.id
    return { t in
        let contours = interpolateMorphContours(corr.a, corr.b, t, linear: options.linear, rigidity: options.rigidity, similarity: sim)
        let m = rigid ? interpolateRigidMatrix(ma, mb, t) : IDENTITY_MATRIX
        let back = rigid ? invertMatrix(m) : IDENTITY_MATRIX
        let subpaths = contours.enumerated().map { k, c -> VectorSubpath in
            // A pair of one closed and one open contour is open in between and takes each key's state at the ends.
            let closed = t <= 0 ? corr.a[k].closed : t >= 1 ? corr.b[k].closed : corr.a[k].closed && corr.b[k].closed
            return morphContourToSubpath(VectorMorphContour(closed: corr.a[k].closed && corr.b[k].closed, pts: c.pts), back, closed: closed)
        }
        var props = JSONObject([("id", .string(id)), ("type", "path"), ("subpaths", .null)])
        for (k, v) in interpolateVectorStyle(styleA, styleB, t) { props[k] = v }
        var node = VectorNode(props: props, subpaths: subpaths)
        let opacity = lerpN(a.opacity ?? 1, b.opacity ?? 1, t)
        if opacity < 1 { node.opacity = opacity }
        if rigid && !isIdentityMatrix(m) { node.transform = m }
        return node
    }
}

/// Path nodes of a subtree with their matrices into the subtree's parent space.
private func flattenPaths(_ node: VectorNode, _ parent: VectorMatrix = IDENTITY_MATRIX) throws -> [(path: VectorNode, m: VectorMatrix, opacity: Double)] {
    let m = multiplyMatrices(nodeMatrix(node), parent)
    if node.isPath { return [(node, m, 1)] }
    // Instances blend as their art.
    if node.isInstance { return try flattenPaths(try expandVectorAppearance(node), parent) }
    // not ported yet: text blends as its glyphs (#624)
    if node.isText { throw VectorNotPorted("blending \(node.typeName) nodes") }
    let o = node.opacity ?? 1
    return try node.children.filter(\.isVisible).flatMap { try flattenPaths($0, m) }.map { ($0.path, $0.m, $0.opacity * o) }
}

/// Bounds of a path placed by `m`.
private func placedBounds(_ path: VectorNode, _ m: VectorMatrix) -> VectorBounds? { boundsOfPoints(contoursOf(path, m).flatMap(\.pts)) }

/// A copy of `path` shrunk to the point that matches it in the other shape's box (placed by the identity).
private func collapsedPath(_ path: VectorNode, _ m: VectorMatrix, _ from: VectorBounds?, _ to: VectorBounds?) -> VectorNode {
    let own = placedBounds(path, m)
    let c = own.map { PathPoint($0.x + $0.width / 2, $0.y + $0.height / 2) } ?? PathPoint(0, 0)
    let fx = from.map { $0.width > 0 ? (c[0] - $0.x) / $0.width : 0.5 } ?? 0.5
    let fy = from.map { $0.height > 0 ? (c[1] - $0.y) / $0.height : 0.5 } ?? 0.5
    let p = to.map { Vec2($0.x + $0.width * fx, $0.y + $0.height * fy) } ?? Vec2(c[0], c[1])
    var rest = path
    rest["transform"] = Optional<JSONValue>.none
    rest.subpaths = path.subpaths.map { sp in VectorSubpath(closed: sp.closed, anchors: sp.anchors.map { _ in VectorAnchor(x: p.x, y: p.y) }) }
    return rest
}

/**
 * Prepares two shapes for interpolation (`createVectorMorph`). Two paths morph directly; with a
 * group on either side the paths inside pair up in stacking order and those without a partner
 * grow out of a point. Shapes are blended in their parent's space.
 */
public func createVectorMorph(_ a: VectorNode, _ b: VectorNode, _ options: VectorMorphOptions = VectorMorphOptions()) throws -> VectorMorph {
    if a.isPath && b.isPath {
        let at = preparePathMorph(a, b, options)
        return VectorMorph(at: at)
    }
    let pa = try flattenPaths(a)
    let pb = try flattenPaths(b)
    let ba = unionBounds(pa.map { placedBounds($0.path, $0.m) })
    let bb = unionBounds(pb.map { placedBounds($0.path, $0.m) })
    let id = options.id ?? a.id
    var parts: [(Double) -> VectorNode] = []
    var opacities: [(Double, Double)] = []
    for i in 0 ..< max(pa.count, pb.count) {
        let x = i < pa.count ? pa[i] : nil
        let y = i < pb.count ? pb[i] : nil
        var sub = options
        sub.id = "\(id)-\(i)"
        sub.starts = nil
        if let x, let y {
            parts.append(preparePathMorph(x.path, y.path, sub, x.m, y.m))
            opacities.append((x.opacity, y.opacity))
        } else if let x {
            parts.append(preparePathMorph(x.path, collapsedPath(x.path, x.m, ba, bb), sub, x.m, IDENTITY_MATRIX))
            opacities.append((x.opacity, x.opacity))
        } else if let y {
            parts.append(preparePathMorph(collapsedPath(y.path, y.m, bb, ba), y.path, sub, IDENTITY_MATRIX, y.m))
            opacities.append((y.opacity, y.opacity))
        }
    }
    return VectorMorph { t in
        let children = parts.enumerated().map { i, p -> VectorNode in
            var n = p(t)
            let o = lerpN(opacities[i].0, opacities[i].1, t) * (n.opacity ?? 1)
            if o < 1 { n.opacity = o } else { n["opacity"] = Optional<JSONValue>.none }
            return n
        }
        return VectorNode(props: JSONObject([("id", .string(id)), ("type", "group")]), children: children)
    }
}

/// The in-between of two shapes at `t` (0 = `a`, 1 = `b`; `interpolateVectorPaths`).
public func interpolateVectorPaths(_ a: VectorNode, _ b: VectorNode, _ t: Double, _ options: VectorMorphOptions = VectorMorphOptions()) throws -> VectorNode {
    try createVectorMorph(a, b, options).at(t)
}
