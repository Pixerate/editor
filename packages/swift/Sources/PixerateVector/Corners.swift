import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Live corners (`vector/corners.ts`): a radius stored on an anchor, drawn as a round, inverted
// or chamfered cut when the path is turned into curves. `expandVectorCorners` is the one place
// the cut geometry is made; `subpathsToBezier` calls it.

private let EPS = 1e-9
/// Sides closer than this to straight on (or folded back), as the sine of their angle, make no corner.
private let MIN_SINE = 1e-6

@inline(__always) private func sub(_ a: Vec2, _ b: Vec2) -> Vec2 { Vec2(a.x - b.x, a.y - b.y) }
@inline(__always) private func add(_ a: Vec2, _ b: Vec2) -> Vec2 { Vec2(a.x + b.x, a.y + b.y) }
@inline(__always) private func mul(_ a: Vec2, _ k: Double) -> Vec2 { Vec2(a.x * k, a.y * k) }
@inline(__always) private func dot(_ a: Vec2, _ b: Vec2) -> Double { a.x * b.x + a.y * b.y }
@inline(__always) private func cross(_ a: Vec2, _ b: Vec2) -> Double { a.x * b.y - a.y * b.x }
@inline(__always) private func len(_ a: Vec2) -> Double { JS.hypot(a.x, a.y) }
@inline(__always) private func pt(_ p: Vec2) -> PathPoint { PathPoint(p.x, p.y) }
@inline(__always) private func pt(_ a: VectorAnchor) -> PathPoint { PathPoint(a.x, a.y) }
@inline(__always) private func vec(_ p: PathPoint) -> Vec2 { Vec2(p[0], p[1]) }
@inline(__always) private func onAnchor(_ a: VectorAnchor, _ h: Vec2?) -> Bool {
    guard let h else { return true }
    return abs(h.x - a.x) < EPS && abs(h.y - a.y) < EPS
}

/// A side of a corner: the segment from the corner's anchor to a neighbour, as a cubic leaving the corner.
private struct Side {
    let curve: [PathPoint]
    let straight: Bool
    let length: Double

    init(_ a: VectorAnchor, _ h1: Vec2?, _ h2: Vec2?, _ b: VectorAnchor) {
        straight = onAnchor(a, h1) && onAnchor(b, h2)
        curve = straight ? [pt(a), pt(b)] : [pt(a), h1.map(pt) ?? pt(a), h2.map(pt) ?? pt(b), pt(b)]
        length = straight ? JS.hypot(b.x - a.x, b.y - a.y) : segmentLength(curve)
    }

    /// Unit direction the side leaves the corner in.
    func direction() -> Vec2? {
        let p0 = vec(curve[0])
        for q in curve.dropFirst() {
            let d = sub(vec(q), p0)
            let l = len(d)
            if l > EPS { return mul(d, 1 / l) }
        }
        return nil
    }

    /// The point `s` along the side from the corner: its parameter, position and direction.
    func at(_ s: Double, _ u: Vec2) -> (t: Double, p: Vec2, dir: Vec2) {
        if straight {
            let t = length > EPS ? JS.min(1, JS.max(0, s / length)) : 0
            return (t, add(vec(curve[0]), mul(u, s)), u)
        }
        let t = segmentParamAtLength(curve, s, length)
        let d = vec(segmentDerivative(curve, t))
        let l = len(d)
        return (t, vec(segmentPoint(curve, t)), l > EPS ? mul(d, 1 / l) : u)
    }
}

/// A corner a live radius can cut (`VectorCornerInfo`), in the path node's own space.
public struct VectorCornerInfo: Equatable, Sendable {
    public var subpath: Int
    public var index: Int
    /// Where the sides meet.
    public var at: Vec2
    /// Unit directions the sides leave the corner in: towards the previous anchor, then the next.
    public var u: Vec2
    public var v: Vec2
    /// The sides' lengths (along curves).
    public var lu: Double
    public var lv: Double
    /// Cosine and sine of the angle between the sides.
    public var cos: Double
    public var sin: Double
    /// The angle between the sides in degrees.
    public var angle: Double
    /// The largest radius that fits.
    public var maxRadius: Double
}

private struct CornerData {
    var info: VectorCornerInfo
    var sideU: Side
    var sideV: Side
}

private func cornerOf(_ sp: VectorSubpath, _ s: Int, _ i: Int) -> CornerData? {
    let n = sp.anchors.count
    if n < 2 || (!sp.closed && (i == 0 || i == n - 1)) { return nil }
    if n == 2 && sp.closed { return nil }
    let a = sp.anchors[i]
    if a.type == .smooth || a.type == .symmetric { return nil }
    let prev = sp.anchors[(i - 1 + n) % n]
    let next = sp.anchors[(i + 1) % n]
    let sideU = Side(a, a.in, prev.out, prev)
    let sideV = Side(a, a.out, next.in, next)
    guard let u = sideU.direction(), let v = sideV.direction() else { return nil }
    let lu = sideU.length
    let lv = sideV.length
    if !(lu > EPS && lv > EPS) || !lu.isFinite || !lv.isFinite { return nil }
    let cos = JS.max(-1, JS.min(1, dot(u, v)))
    let sin = abs(cross(u, v))
    if sin <= MIN_SINE { return nil }
    let info = VectorCornerInfo(
        subpath: s, index: i, at: Vec2(a.x, a.y), u: u, v: v, lu: lu, lv: lv, cos: cos, sin: sin,
        angle: (JS.atan2(sin, cos) * 180) / Double.pi,
        maxRadius: ((JS.min(lu, lv) / 2) * sin) / (1 + cos)
    )
    return CornerData(info: info, sideU: sideU, sideV: sideV)
}

/// The corner at anchor `index` of a subpath, or nil when the anchor makes none.
public func vectorCornerAt(_ sp: VectorSubpath, _ index: Int, _ subpath: Int = 0) -> VectorCornerInfo? {
    cornerOf(sp, subpath, index)?.info
}

/// Every corner of the subpaths that a live radius can cut, in anchor order.
public func vectorCorners(_ subpaths: [VectorSubpath]) -> [VectorCornerInfo] {
    var out: [VectorCornerInfo] = []
    for (s, sp) in subpaths.enumerated() {
        for i in 0 ..< sp.anchors.count {
            if let c = cornerOf(sp, s, i) { out.append(c.info) }
        }
    }
    return out
}

/// How far from the corner a round cut of radius `r` meets each side: r / tan(angle / 2).
public func cornerSetback(_ c: VectorCornerInfo, _ r: Double) -> Double { (r * (1 + c.cos)) / c.sin }

/// `radius` clamped to what the corner can draw (0 for negative or non-finite radii).
public func fitCornerRadius(_ c: VectorCornerInfo, _ radius: Double) -> Double {
    radius.isFinite ? JS.min(JS.max(0, radius), c.maxRadius) : 0
}

/// The point `k` along the corner's bisector, measured in (u + v).
public func cornerBisectorPoint(_ c: VectorCornerInfo, _ k: Double) -> Vec2 { add(c.at, mul(add(c.u, c.v), k)) }

/// How much the radius grows when the round cut's centre moves by `d`.
public func cornerRadiusChange(_ c: VectorCornerInfo, _ d: Vec2) -> Double { (dot(d, add(c.u, c.v)) * c.sin) / (2 + 2 * c.cos) }

/// Handle length per unit radius of a cubic arc spanning the angle whose cosine is `cos`.
private func arcHandle(_ cosIn: Double) -> Double {
    let c = JS.max(-1, JS.min(1, cosIn))
    let sinHalf = JS.sqrt(JS.max(0, (1 - c) / 2))
    let cosHalf = JS.sqrt(JS.max(0, (1 + c) / 2))
    return ((4.0 / 3.0) * sinHalf) / (1 + cosHalf)
}

/// The unit direction square to unit `a`, on `b`'s side.
private func squareTo(_ a: Vec2, _ b: Vec2) -> Vec2 {
    let w = sub(b, mul(a, dot(a, b)))
    let l = len(w)
    return l > EPS ? mul(w, 1 / l) : Vec2(0, 0)
}

private struct Cut {
    var tu: Double
    var tv: Double
    var start: Vec2
    var out: Vec2?
    var `in`: Vec2?
    var end: Vec2
    var inner: [VectorAnchor] = []
}

private func smoothCut(_ cd: CornerData, _ radius: Double, _ smoothing: Double) -> Cut? {
    let c = cd.info
    let turn = Double.pi - Foundation.acos(JS.max(-1, JS.min(1, c.cos)))
    let t = cornerSetback(c, radius)
    let room = JS.min(c.lu, c.lv) / 2
    var s = JS.max(0, JS.min(1, smoothing))
    if (1 + s) * t > room { s = JS.max(0, JS.min(s, room / t - 1)) }
    let beta = (turn * s) / 2
    if !(beta > 1e-6) || !(t > EPS) { return nil }
    let p = JS.min((1 + s) * t, room)
    let qa = radius * Foundation.tan(beta / 2)
    let q = t - qa
    func side(_ u: Vec2, _ v: Vec2) -> (e: Vec2, c1: Vec2, q: Vec2, a: Vec2) {
        let n = squareTo(u, v)
        let e = add(c.at, mul(u, p))
        let c1 = add(c.at, mul(u, (p + 2 * q) / 3))
        let qp = add(c.at, mul(u, q))
        let a = add(sub(qp, mul(u, qa * JS.cos(beta))), mul(n, qa * JS.sin(beta)))
        return (e, c1, qp, a)
    }
    let U = side(c.u, c.v)
    let V = side(c.v, c.u)
    let sweep = turn * (1 - s)
    let h = radius * (4.0 / 3.0) * Foundation.tan(sweep / 4)
    let tanU = sub(U.a, U.q)
    let tanV = sub(V.a, V.q)
    let lu = jsOr(len(tanU), 1)
    let lv = jsOr(len(tanV), 1)
    let arcOut = add(U.a, mul(tanU, h / lu))
    let arcIn = add(V.a, mul(tanV, h / lv))
    let tu = cd.sideU.at(p, c.u).t
    let tv = cd.sideV.at(p, c.v).t
    return Cut(
        tu: tu, tv: tv, start: U.e, out: U.c1, in: V.c1, end: V.e,
        inner: [VectorAnchor(x: U.a.x, y: U.a.y, in: U.q, out: arcOut), VectorAnchor(x: V.a.x, y: V.a.y, in: arcIn, out: V.q)]
    )
}

/// `a || b` for numbers: `b` when `a` is 0 or NaN.
@inline(__always) func jsOr(_ a: Double, _ b: Double) -> Double { a != 0 && !a.isNaN ? a : b }

private func cutCorner(_ cd: CornerData, _ radius: Double, _ kind: String, _ smoothing: Double) -> Cut? {
    let c = cd.info
    let s = JS.min(cornerSetback(c, radius), JS.min(c.lu, c.lv) / 2)
    if !(s > EPS) { return nil }
    let a = cd.sideU.at(s, c.u)
    let b = cd.sideV.at(s, c.v)
    if kind == "chamfer" { return Cut(tu: a.t, tv: b.t, start: a.p, out: nil, in: nil, end: b.p) }
    if kind == "inverted" {
        let h = s * arcHandle(dot(a.dir, b.dir))
        return Cut(tu: a.t, tv: b.t, start: a.p, out: add(a.p, mul(squareTo(a.dir, b.dir), h)), in: add(b.p, mul(squareTo(b.dir, a.dir), h)), end: b.p)
    }
    if smoothing > 0 && cd.sideU.straight && cd.sideV.straight {
        if let smooth = smoothCut(cd, radius, smoothing) { return smooth }
    }
    let d1 = mul(a.dir, -1)
    let d2 = mul(b.dir, -1)
    let turn = Foundation.acos(JS.max(-1, JS.min(1, -dot(d1, d2))))
    let chord = len(sub(b.p, a.p))
    let k = turn < 1e-9 ? chord / 3 : (((4.0 / 3.0) * Foundation.tan(turn / 4) * chord) / (2 * JS.sin(turn / 2)))
    if !k.isFinite { return nil }
    return Cut(tu: a.t, tv: b.t, start: a.p, out: add(a.p, mul(d1, k)), in: add(b.p, mul(d2, k)), end: b.p)
}

private func radiusOf(_ a: VectorAnchor) -> Double {
    guard let r = a.corner?.radius, r > 0, r.isFinite else { return 0 }
    return r
}

/// True when any anchor of the subpaths has a live corner radius.
public func hasVectorCorners(_ subpaths: [VectorSubpath]) -> Bool {
    subpaths.contains { sp in sp.anchors.contains { radiusOf($0) > 0 } }
}

private func withHandles(_ aIn: VectorAnchor, _ hin: Vec2?, _ hout: Vec2?) -> VectorAnchor {
    var a = aIn
    if let hin, !onAnchor(a, hin) { a.in = Vec2(hin.x, hin.y) }
    if let hout, !onAnchor(a, hout) { a.out = Vec2(hout.x, hout.y) }
    return a
}

private func plain(_ a: VectorAnchor) -> VectorAnchor {
    if !a.keys.contains("corner") { return a }
    var b = a
    b.corner = nil
    return b
}

/// One subpath with its corners cut; `sources[i]` is the stored anchor each output anchor comes from.
public func expandVectorCornersOf(_ sp: VectorSubpath, _ subpath: Int = 0) -> (subpath: VectorSubpath, sources: [Int]) {
    let n = sp.anchors.count
    let cuts: [Cut?] = sp.anchors.enumerated().map { i, a in
        let r = radiusOf(a)
        if r == 0 { return nil }
        guard let c = cornerOf(sp, subpath, i) else { return nil }
        let fitted = fitCornerRadius(c.info, r)
        return fitted > EPS ? cutCorner(c, fitted, a.corner?.kindName ?? "round", a.corner?.smoothing ?? 0) : nil
    }
    if !cuts.contains(where: { $0 != nil }) {
        return (VectorSubpath(closed: sp.closed, anchors: sp.anchors.map(plain)), Array(0 ..< n))
    }
    // Each segment from anchor j trimmed to what the cuts at its ends leave: its handles, or nil
    // when it is untouched (nil handles inside: a straight segment).
    let trimmed: [(out: Vec2?, in: Vec2?)?] = sp.anchors.enumerated().map { j, a in
        let k = (j + 1) % n
        if k == 0 && !sp.closed { return nil }
        let b = sp.anchors[k]
        let from = cuts[j]
        let to = cuts[k]
        if from == nil && to == nil { return nil }
        if onAnchor(a, a.out) && onAnchor(b, b.in) { return (nil, nil) }
        let s0 = from?.tv ?? 0
        let s1 = to.map { 1 - $0.tu } ?? 1
        let seg: [PathPoint] = [pt(a), a.out.map(pt) ?? pt(a), b.in.map(pt) ?? pt(b), pt(b)]
        let part = subSegment(seg, s0, JS.max(s0, s1))
        return (vec(part[1]), vec(part[2]))
    }
    var anchors: [VectorAnchor] = []
    var sources: [Int] = []
    var closing: VectorAnchor?
    func handleIn(_ i: Int, _ a: VectorAnchor) -> Vec2? {
        if let t = trimmed[(i - 1 + n) % n] { return t.in }
        return a.in
    }
    func handleOut(_ i: Int, _ a: VectorAnchor) -> Vec2? {
        if let t = trimmed[i] { return t.out }
        return a.out
    }
    for (i, a) in sp.anchors.enumerated() {
        guard let c = cuts[i] else {
            var base = VectorAnchor(x: a.x, y: a.y)
            if let t = a.rawTypeName { base["type"] = .string(t) }
            anchors.append(withHandles(base, handleIn(i, a), handleOut(i, a)))
            sources.append(i)
            continue
        }
        let start = withHandles(VectorAnchor(x: c.start.x, y: c.start.y), handleIn(i, a), c.out)
        let end = withHandles(VectorAnchor(x: c.end.x, y: c.end.y), c.in, handleOut(i, a))
        if i == 0 && sp.closed {
            closing = start
        } else {
            anchors.append(start)
            sources.append(i)
        }
        for inner in c.inner {
            anchors.append(inner)
            sources.append(i)
        }
        anchors.append(end)
        sources.append(i)
    }
    if let closing {
        anchors.append(closing)
        sources.append(0)
    }
    return (VectorSubpath(closed: sp.closed, anchors: anchors), sources)
}

/// The subpaths with every live corner cut (round, inverted or chamfer). Subpaths without
/// corners come back unchanged.
public func expandVectorCorners(_ subpaths: [VectorSubpath]) -> [VectorSubpath] {
    if !hasVectorCorners(subpaths) { return subpaths }
    return subpaths.enumerated().map { s, sp in sp.anchors.contains { radiusOf($0) > 0 } ? expandVectorCornersOf(sp, s).subpath : sp }
}

/// Sets (or clears, with radius 0) the live corner of an anchor. `kind` keeps the anchor's own
/// kind when omitted.
public func setAnchorCorner(_ a: VectorAnchor, _ radius: Double, _ kind: String? = nil, _ smoothing: Double? = nil) -> VectorAnchor {
    let corner = a.corner
    var rest = a
    rest.corner = nil
    let r = radius.isFinite ? JS.max(0, radius) : 0
    let k = kind ?? corner?.kindName
    let s = JS.max(0, JS.min(1, smoothing ?? corner?.smoothing ?? 0))
    if r <= 0 && (kind == nil || kind == "") { return rest }
    rest.corner = VectorCorner(radius: r, kind: (k != nil && k != "" && k != "round") ? k : nil, smoothing: s > 0 ? s : nil)
    return rest
}

/// The next corner kind (round → inverted → chamfer).
public func nextVectorCornerKind(_ kind: VectorCornerKind?) -> VectorCornerKind {
    kind == .inverted ? .chamfer : kind == .chamfer ? .round : .inverted
}

/// Every anchor of a subpath given the same live corner (radius 0 clears them).
public func setSubpathCorners(_ sp: VectorSubpath, _ radius: Double, _ kind: String? = nil, _ smoothing: Double? = nil) -> VectorSubpath {
    VectorSubpath(closed: sp.closed, anchors: sp.anchors.map { setAnchorCorner($0, radius, kind, smoothing) })
}
