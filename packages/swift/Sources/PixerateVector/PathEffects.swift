import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Path operators of live path effects (`vector/pathEffects.ts`): each maps a list of paths to a
// list of the same length (one per shape above the operator), except `mergePaths`, which combines
// them into one, and `repeatPaths`, which makes copies. Paths are in the space of the node the
// effect belongs to. Ported from ArtCraft's effectcraft `crates/path/src/ops.rs` through the TS.

private let EPS = 1e-9

/// One subpath as cubic or line segments (quadratics raised), the closing line included.
private struct Sub {
    var segs: [BezierSegment]
    var closed: Bool
}

private func degenerate(_ s: BezierSegment) -> Bool {
    s.allSatisfy { abs($0[0] - s[0][0]) < EPS && abs($0[1] - s[0][1]) < EPS }
}

private func raise(_ seg: BezierSegment) -> BezierSegment {
    if seg.count != 3 { return seg }
    let p0 = seg[0], p1 = seg[1], p2 = seg[2]
    return [p0, PathPoint(p0[0] + (2.0 / 3) * (p1[0] - p0[0]), p0[1] + (2.0 / 3) * (p1[1] - p0[1])), PathPoint(p2[0] + (2.0 / 3) * (p1[0] - p2[0]), p2[1] + (2.0 / 3) * (p1[1] - p2[1])), p2]
}

/// The path's subpaths with at least one segment (a closed one's closing line included).
private func subsOf(_ path: BezierPath) -> [Sub] {
    pathToContours(.commands(path))
        .map { c in Sub(segs: closeContour(c).filter { !degenerate($0) }.map(raise), closed: c.closed) }
        .filter { !$0.segs.isEmpty }
}

private func subsToPath(_ subs: [Sub]) -> BezierPath {
    contoursToPath(subs.map { BezierContour(segments: $0.segs, closed: $0.closed) })
}

/// `unit` of `pathEffects.ts` (null below 1e-12).
private func unitOf(_ x: Double, _ y: Double) -> PathPoint? {
    let l = JS.hypot(x, y)
    return l > 1e-12 && l.isFinite ? PathPoint(x / l, y / l) : nil
}

/// Direction a segment leaves its start in (robust at a handle on its anchor).
private func startTangent(_ s: BezierSegment) -> PathPoint {
    for i in 1 ..< s.count {
        if let u = unitOf(s[i][0] - s[0][0], s[i][1] - s[0][1]) { return u }
    }
    return PathPoint(1, 0)
}

/// Direction a segment arrives at its end in.
private func endTangent(_ s: BezierSegment) -> PathPoint {
    let end = s[s.count - 1]
    var i = s.count - 2
    while i >= 0 {
        if let u = unitOf(end[0] - s[i][0], end[1] - s[i][1]) { return u }
        i -= 1
    }
    return PathPoint(1, 0)
}

private func tangentAt(_ s: BezierSegment, _ t: Double) -> PathPoint {
    if t <= 1e-9 { return startTangent(s) }
    if t >= 1 - 1e-9 { return endTangent(s) }
    let d = segmentDerivative(s, t)
    return unitOf(d[0], d[1]) ?? startTangent(s)
}

@inline(__always) private func perp(_ v: PathPoint) -> PathPoint { PathPoint(-v[1], v[0]) }

/// Total arc length of a path (closing lines included).
public func effectPathLength(_ path: BezierPath) -> Double {
    var total = 0.0
    for s in subsOf(path) { for seg in s.segs { total += segmentLength(seg) } }
    return total
}

/// Number of on-curve points of a path (a closed subpath's start counted once).
public func effectPathVertexCount(_ path: BezierPath) -> Int {
    subsOf(path).reduce(0) { $0 + $1.segs.count + ($1.closed ? 0 : 1) }
}

// MARK: - Trim Paths

/// A path measured for trimming: its segments end to end and their lengths.
private struct Measured {
    let segs: [BezierSegment]
    let lens: [Double]
    let total: Double

    init(_ path: BezierPath) {
        segs = subsOf(path).flatMap(\.segs)
        lens = segs.map { segmentLength($0) }
        total = lens.reduce(0, +)
    }

    /// Appends the part between lengths `sa` and `sb`, continuing the last piece when this one
    /// starts where it ends (across the start of a closed path).
    func append(_ sa: Double, _ sb: Double, _ out: inout [Sub]) {
        for piece in trimSegments(segs, sa, sb, lens) {
            if degenerate(piece) { continue }
            if let lastSub = out.last, let lastSeg = lastSub.segs.last, let end = lastSeg.last, JS.hypot(end[0] - piece[0][0], end[1] - piece[0][1]) <= 1e-6 {
                out[out.count - 1].segs.append(piece)
            } else {
                out.append(Sub(segs: [piece], closed: false))
            }
        }
    }
}

/// The fractions of the length a trim keeps, or nil when it keeps everything.
public func trimIntervals(_ start: Double, _ end: Double, _ offsetDegrees: Double) -> [(Double, Double)]? {
    var s = start / 100
    var e = end / 100
    if !s.isFinite || !e.isFinite { return nil }
    if s > e { swap(&s, &e) }
    s = JS.min(1, JS.max(0, s))
    e = JS.min(1, JS.max(0, e))
    if e - s >= 1 - 1e-9 { return nil }
    if e - s <= 1e-9 { return [] }
    let off = offsetDegrees.isFinite ? ((offsetDegrees / 360).truncatingRemainder(dividingBy: 1) + 1).truncatingRemainder(dividingBy: 1) : 0
    s += off
    e += off
    if e <= 1 { return [(s, e)] }
    if s >= 1 { return [(s - 1, e - 1)] }
    return [(s, 1), (0, e - 1)]
}

/// Trim Paths, simultaneously: every path trimmed by the same fractions of its own length.
public func trimPaths(_ paths: [BezierPath], _ start: Double, _ end: Double, _ offsetDegrees: Double = 0) -> [BezierPath] {
    guard let iv = trimIntervals(start, end, offsetDegrees) else { return paths }
    return paths.map { p in
        let m = Measured(p)
        var out: [Sub] = []
        if m.total > 0 { for (a, b) in iv { m.append(a * m.total, b * m.total, &out) } }
        return subsToPath(out)
    }
}

/// Trim Paths, individually: the paths laid end to end in stacking order and trimmed as one length.
public func trimPathsIndividually(_ paths: [BezierPath], _ start: Double, _ end: Double, _ offsetDegrees: Double = 0) -> [BezierPath] {
    guard let iv = trimIntervals(start, end, offsetDegrees) else { return paths }
    let ms = paths.map { Measured($0) }
    let total = ms.reduce(0) { $0 + $1.total }
    var base = 0.0
    return ms.map { m in
        var out: [Sub] = []
        for (a, b) in iv {
            let la = JS.max(0, a * total - base)
            let lb = JS.min(m.total, b * total - base)
            if lb > la { m.append(la, lb, &out) }
        }
        base += m.total
        return subsToPath(out)
    }
}

// MARK: - Pucker & Bloat

/// Pucker & Bloat (`amount` in percent, −100 to 100): bloat moves the points towards the mean of
/// a path's points and pushes the handles away; pucker does the opposite.
public func puckerBloatPaths(_ paths: [BezierPath], _ amount: Double) -> [BezierPath] {
    let a = amount / 100
    if a == 0 || !a.isFinite { return paths }
    return paths.map { p in
        var verts: [Vec2] = []
        for c in p {
            switch c {
            case let .M(x, y), let .L(x, y), let .Q(_, _, x, y), let .C(_, _, _, _, x, y), let .A(_, _, _, _, _, x, y): verts.append(Vec2(x, y))
            case .Z: break
            }
        }
        if verts.isEmpty { return p }
        let cx = verts.reduce(0) { $0 + $1.x } / Double(verts.count)
        let cy = verts.reduce(0) { $0 + $1.y } / Double(verts.count)
        func mv(_ x: Double, _ y: Double) -> Vec2 { Vec2(x + (cx - x) * a, y + (cy - y) * a) }
        func mvh(_ x: Double, _ y: Double) -> Vec2 { Vec2(x + (x - cx) * a, y + (y - cy) * a) }
        var out: BezierPath = []
        var prev = Vec2(0, 0)
        var start = Vec2(0, 0)
        func curve(_ c1: Vec2, _ c2: Vec2, _ q: Vec2) {
            let h1 = mvh(c1.x, c1.y)
            let h2 = mvh(c2.x, c2.y)
            let e = mv(q.x, q.y)
            out.append(.C(x1: h1.x, y1: h1.y, x2: h2.x, y2: h2.y, x: e.x, y: e.y))
        }
        for c in p {
            switch c {
            case let .M(x, y):
                let e = mv(x, y)
                out.append(.M(x: e.x, y: e.y))
                prev = Vec2(x, y)
                start = prev
            case let .L(x, y):
                curve(prev, Vec2(x, y), Vec2(x, y))
                prev = Vec2(x, y)
            case let .Q(x1, y1, x, y):
                let c1 = Vec2(prev.x + (2.0 / 3) * (x1 - prev.x), prev.y + (2.0 / 3) * (y1 - prev.y))
                let c2 = Vec2(x + (2.0 / 3) * (x1 - x), y + (2.0 / 3) * (y1 - y))
                curve(c1, c2, Vec2(x, y))
                prev = Vec2(x, y)
            case let .C(x1, y1, x2, y2, x, y):
                curve(Vec2(x1, y1), Vec2(x2, y2), Vec2(x, y))
                prev = Vec2(x, y)
            case .Z:
                // The implicit closing line becomes a curve too.
                if JS.hypot(prev.x - start.x, prev.y - start.y) > EPS { curve(prev, start, start) }
                out.append(.Z)
                prev = start
            case .A:
                break
            }
        }
        return out
    }
}

// MARK: - Round Corners

/// Round Corners: every corner gets a circular arc of `radius`, shrunk to fit short sides.
public func roundCornerPaths(_ paths: [BezierPath], _ radius: Double) -> [BezierPath] {
    if !(radius > 0) || !radius.isFinite { return paths }
    return paths.map { p in subpathsToBezier(bezierToSubpaths(.commands(p)).map { setSubpathCorners($0, radius) }) }
}

// MARK: - Offset Paths

/// Offset Paths: grows (positive `amount`) or shrinks every path with the given join; `copies`
/// copies, copy i offset by `amount · (i + 1 + copyOffset)`, all in one path.
public func offsetPaths(_ paths: [BezierPath], _ amount: Double, _ join: String = "miter", _ miterLimit: Double = 4, _ copies: Double = 1, _ copyOffset: Double = 0) throws -> [BezierPath] {
    let n = Int(JS.min(1000, JS.max(1, JS.round(copies.isFinite ? copies : 1))))
    return try paths.map { p in
        var out: BezierPath = []
        for i in 0 ..< n {
            out += try offsetPath(.commands(p), amount * (Double(i) + 1 + copyOffset), OffsetPathOptions(join: StrokeJoin(rawValue: join), miterLimit: miterLimit))
        }
        return out
    }
}

/// The area a path covers when it slides `dx, dy`: the path, its moved copy and the band every
/// (flattened) edge sweeps, united into one path.
public func sweepPath(_ path: BezierPath, _ dx: Double, _ dy: Double, _ fillRule: PolygonFillRule = .nonzero, _ tolerance: Double = 0.25) throws -> BezierPath {
    if path.isEmpty { return [] }
    if !dx.isFinite || !dy.isFinite || JS.hypot(dx, dy) < 1e-9 { return path }
    var bands: BezierPath = []
    for contour in pathToContours(.commands(path)) {
        let ring = flattenChain(closeContour(contour, true), JS.max(1e-3, tolerance))
        for i in 0 ..< ring.count {
            var p = ring[i]
            var q = ring[(i + 1) % ring.count]
            let turn = (q[0] - p[0]) * dy - (q[1] - p[1]) * dx
            if abs(turn) < 1e-9 { continue }
            if turn < 0 { swap(&p, &q) }
            bands += [.M(x: p[0], y: p[1]), .L(x: q[0], y: q[1]), .L(x: q[0] + dx, y: q[1] + dy), .L(x: p[0] + dx, y: p[1] + dy), .Z]
        }
    }
    let moved = transformBezierPath(.commands(path), (1, 0, 0, 1, dx, dy))
    var operands = [PathOperand(.commands(path), fillRule: fillRule), PathOperand(.commands(moved), fillRule: fillRule)]
    if !bands.isEmpty { operands.append(PathOperand(.commands(bands), fillRule: .nonzero)) }
    return try pathBoolean(.union, operands).path
}

// MARK: - Twist

/// Twist: turns the paths about `center` by an angle growing with the distance from it, up to
/// `angle` degrees at the farthest point.
public func twistPaths(_ paths: [BezierPath], _ angle: Double, _ center: Vec2) -> [BezierPath] {
    var rmax = 0.0
    for p in paths {
        for c in p {
            switch c {
            case let .M(x, y), let .L(x, y), let .Q(_, _, x, y), let .C(_, _, _, _, x, y), let .A(_, _, _, _, _, x, y): rmax = JS.max(rmax, JS.hypot(x - center.x, y - center.y))
            case .Z: break
            }
        }
    }
    let a = (angle * Double.pi) / 180
    if a == 0 || rmax <= 1e-9 || !a.isFinite { return paths }
    let k = a / rmax
    func rot(_ v: PathPoint, _ th: Double) -> PathPoint {
        let s = JS.sin(th)
        let co = JS.cos(th)
        return PathPoint(v[0] * co - v[1] * s, v[0] * s + v[1] * co)
    }
    func map(_ p: PathPoint) -> PathPoint {
        let v = PathPoint(p[0] - center.x, p[1] - center.y)
        let r = rot(v, k * JS.hypot(v[0], v[1]))
        return PathPoint(center.x + r[0], center.y + r[1])
    }
    func jac(_ p: PathPoint, _ dv: PathPoint) -> PathPoint {
        let v = PathPoint(p[0] - center.x, p[1] - center.y)
        let r = JS.hypot(v[0], v[1])
        var w = dv
        if r > 1e-12 {
            let f = (k * (v[0] * dv[0] + v[1] * dv[1])) / r
            w = PathPoint(dv[0] - v[1] * f, dv[1] + v[0] * f)
        }
        return rot(w, k * r)
    }
    return paths.map { p in
        var out: [Sub] = []
        for sub in subsOf(p) {
            var segs: [BezierSegment] = []
            for seg in sub.segs {
                let cubic = seg.count == 2 ? [seg[0], seg[0], seg[1], seg[1]] : seg
                let len = segmentLength(seg)
                let m = Int(JS.min(64, JS.max(1, ((abs(a) * len) / rmax / 0.15 + len / 50).rounded(.up))))
                for i in 0 ..< m {
                    let q = subSegment(cubic, Double(i) / Double(m), Double(i + 1) / Double(m))
                    let p0 = map(q[0])
                    let p3 = map(q[3])
                    let h1 = jac(q[0], PathPoint(q[1][0] - q[0][0], q[1][1] - q[0][1]))
                    let h2 = jac(q[3], PathPoint(q[2][0] - q[3][0], q[2][1] - q[3][1]))
                    segs.append([p0, PathPoint(p0[0] + h1[0], p0[1] + h1[1]), PathPoint(p3[0] + h2[0], p3[1] + h2[1]), p3])
                }
            }
            out.append(Sub(segs: segs, closed: sub.closed))
        }
        return subsToPath(out)
    }
}

// MARK: - Resampling (Zig Zag, Wiggle Paths)

private struct Sample {
    var p: PathPoint
    var tan: PathPoint
    /// Length of the piece before / after this sample.
    var lenPrev: Double
    var lenNext: Double
}

/// Splits every segment into `m` pieces of equal arc length. Original points get the average of
/// their incoming and outgoing directions (so a corner's normal is its bisector).
private func resample(_ sub: Sub, _ m: Int) -> [Sample] {
    let segs = sub.segs
    let n = segs.count
    let lens = segs.map { segmentLength($0) }
    var out: [Sample] = []
    for j in 0 ..< n {
        let piece = lens[j] / Double(m)
        for k in 0 ..< m {
            if k == 0 {
                let tout = startTangent(segs[j])
                let prev: Int? = sub.closed || j > 0 ? (j + n - 1) % n : nil
                var tan = tout
                if let prev {
                    let tin = endTangent(segs[prev])
                    tan = unitOf(tin[0] + tout[0], tin[1] + tout[1]) ?? tout
                }
                out.append(Sample(p: segs[j][0], tan: tan, lenPrev: prev == nil ? 0 : lens[prev!] / Double(m), lenNext: piece))
            } else {
                let t = segmentParamAtLength(segs[j], piece * Double(k), lens[j])
                out.append(Sample(p: segmentPoint(segs[j], t), tan: tangentAt(segs[j], t), lenPrev: piece, lenNext: piece))
            }
        }
    }
    if !sub.closed {
        let last = segs[n - 1]
        out.append(Sample(p: last[last.count - 1], tan: endTangent(last), lenPrev: lens[n - 1] / Double(m), lenNext: 0))
    }
    return out
}

/// Displaced samples as corner (polyline) or smooth (tangent-aligned cubic) points.
private func emit(_ samples: [Sample], _ disp: [PathPoint], _ closed: Bool, _ smooth: Bool, _ handle: Double) -> Sub? {
    let n = samples.count
    if n == 0 { return nil }
    func pt(_ i: Int) -> PathPoint { PathPoint(samples[i].p[0] + disp[i][0], samples[i].p[1] + disp[i][1]) }
    var segs: [BezierSegment] = []
    let count = closed ? n : n - 1
    for i in 0 ..< Swift.max(0, count) {
        let j = (i + 1) % n
        let a = samples[i]
        let b = samples[j]
        let p = pt(i)
        let q = pt(j)
        if smooth {
            segs.append([p, PathPoint(p[0] + a.tan[0] * a.lenNext * handle, p[1] + a.tan[1] * a.lenNext * handle), PathPoint(q[0] - b.tan[0] * b.lenPrev * handle, q[1] - b.tan[1] * b.lenPrev * handle), q])
        } else {
            segs.append([p, q])
        }
    }
    if segs.isEmpty { return nil }
    return Sub(segs: segs, closed: closed)
}

/// Zig Zag: every segment gets `ridges` ridges, its points pushed alternately `size` to either side.
public func zigzagPaths(_ paths: [BezierPath], _ size: Double, _ ridges: Double, _ smooth: Bool = false) -> [BezierPath] {
    let m = Int(JS.min(1000, JS.max(0, JS.round(ridges.isFinite ? ridges : 0)))) + 1
    return paths.map { p in
        var out: [Sub] = []
        for sub in subsOf(p) {
            let s = resample(sub, m)
            let disp = s.enumerated().map { i, x -> PathPoint in
                let n = perp(x.tan)
                let d = i % 2 == 0 ? size : -size
                return PathPoint(n[0] * d, n[1] * d)
            }
            if let e = emit(s, disp, sub.closed, smooth, 0.36) { out.append(e) }
        }
        return subsToPath(out)
    }
}

// MARK: - Wiggle Paths

private func splitmix(_ x0: UInt64) -> UInt64 {
    let x = x0 &+ 0x9e37_79b9_7f4a_7c15
    var z = x
    z = (z ^ (z >> 30)) &* 0xbf58_476d_1ce4_e5b9
    z = (z ^ (z >> 27)) &* 0x94d0_49bb_1331_11eb
    return z ^ (z >> 31)
}

/// `BigInt.asUintN(64, BigInt(t))` for an integral `t`.
private func u64(_ t: Double) -> UInt64 {
    if t >= 0 { return t < 18_446_744_073_709_551_616 ? UInt64(t) : UInt64(t.truncatingRemainder(dividingBy: 18_446_744_073_709_551_616)) }
    let m = (-t).truncatingRemainder(dividingBy: 18_446_744_073_709_551_616)
    return 0 &- UInt64(m)
}

/// Deterministic hash → [−1, 1].
private func hash(_ seed: UInt64, _ idx: UInt64, _ t: Double) -> Double {
    let h = splitmix(splitmix(splitmix(seed) ^ idx) ^ u64(t))
    return (Double(h >> 11) / 9_007_199_254_740_992) * 2 - 1
}

/// Smooth 1D value noise in [−1, 1]: Catmull-Rom through hashed lattice values (C1 in time).
private func noise(_ seed: UInt64, _ idx: UInt64, _ t: Double) -> Double {
    let i = JS.floor(t)
    let f = t - i
    let p0 = hash(seed, idx, i - 1)
    let p1 = hash(seed, idx, i)
    let p2 = hash(seed, idx, i + 1)
    let p3 = hash(seed, idx, i + 2)
    let v = 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f)
    return JS.min(1, JS.max(-1, v))
}

/// Wiggle Paths parameters (`VectorEffectParamsMap['wiggle']`).
public struct VectorWiggleParams {
    public var size: Double
    public var detail: Double
    public var smooth: Bool
    public var speed: Double
    public var correlation: Double
    public var phase: Double
    public var seed: Double
    public var time: Double
}

/// Wiggle Paths: subdivides the paths (`detail` points per segment) and moves every point by
/// smooth noise of up to `size`. The same parameters always give the same result.
public func wigglePaths(_ paths: [BezierPath], _ w: VectorWiggleParams) -> [BezierPath] {
    if w.size == 0 || !w.size.isFinite { return paths }
    let m = Int(JS.min(1000, JS.max(0, JS.round(w.detail.isFinite ? w.detail : 0)))) + 1
    let seed = u64(JS.round(w.seed.isFinite ? w.seed : 0))
    let t = (w.time.isFinite ? w.time : 0) * (w.speed.isFinite ? w.speed : 0) + (w.phase.isFinite ? w.phase : 0) / 360
    let corr = JS.min(1, JS.max(0, (w.correlation.isFinite ? w.correlation : 0) / 100))
    let sx = noise(seed, UInt64.max, t)
    let sy = noise(seed, UInt64.max - 1, t)
    var idx = 0
    return paths.map { p in
        var out: [Sub] = []
        for sub in subsOf(p) {
            let s = resample(sub, m)
            let disp = s.map { _ -> PathPoint in
                let i = UInt64(idx)
                let ox = noise(seed, i &* 2, t + Double(idx) * 0.37)
                let oy = noise(seed, i &* 2 &+ 1, t + Double(idx) * 0.61)
                idx += 1
                return PathPoint((sx * corr + ox * (1 - corr)) * w.size, (sy * corr + oy * (1 - corr)) * w.size)
            }
            if let e = emit(s, disp, sub.closed, w.smooth, 1.0 / 3) { out.append(e) }
        }
        return subsToPath(out)
    }
}

// MARK: - Merge Paths

private let MERGE_OPS: [String: PathBooleanOperation] = ["add": .union, "subtract": .difference, "intersect": .intersection, "exclude": .xor]

/// Merge Paths: the paths (in stacking order, each filled non-zero) combined into one path.
public func mergePaths(_ paths: [BezierPath], _ mode: String = "merge") throws -> BezierPath {
    guard mode != "merge", let op = MERGE_OPS[mode] else { return paths.flatMap { $0 } }
    let inputs = paths.filter { !$0.isEmpty }.map { PathOperand(.commands($0), fillRule: .nonzero) }
    if inputs.isEmpty { return [] }
    return try pathBoolean(op, inputs).path
}

// MARK: - Repeater

/// One copy a repeater makes: its transform (node space) and opacity factor.
public struct VectorRepeaterCopy {
    /// Copy number (0 is the original).
    public var index: Int
    public var matrix: VectorMatrix
    public var opacity: Double
}

/// The copies of a repeater around `pivot` (node space), in copy order (`vectorRepeaterCopies`).
/// `r` is the repeater's params object.
public func vectorRepeaterCopies(_ r: JSONObject, _ pivot: Vec2) -> [VectorRepeaterCopy] {
    func num(_ k: String) -> Double? { r[k]?.numberValue }
    func vec(_ k: String, _ c: String) -> Double? { r[k]?[c]?.numberValue }
    let raw = num("copies") ?? .nan
    let copies = JS.max(0, raw.isFinite ? JS.min(raw, 1000) : 0)
    let n = Int(copies.rounded(.up))
    let offset = (num("offset") ?? .nan).isFinite ? num("offset")! : 0
    let so = (num("startOpacity") ?? 100) / 100
    let eo = (num("endOpacity") ?? 100) / 100
    let fract = copies - JS.floor(copies)
    var out: [VectorRepeaterCopy] = []
    for i in 0 ..< n {
        let k = Double(i) + offset
        var m = translateMatrix(-pivot.x, -pivot.y)
        m = multiplyMatrices(m, scaleMatrix(pow((vec("scale", "x") ?? 100) / 100, k), pow((vec("scale", "y") ?? 100) / 100, k)))
        m = multiplyMatrices(m, rotateMatrix((num("rotation") ?? 0) * k))
        m = multiplyMatrices(m, translateMatrix(pivot.x + (vec("position", "x") ?? 0) * k, pivot.y + (vec("position", "y") ?? 0) * k))
        let t = n > 1 ? Double(i) / Double(n - 1) : 0
        let partial = i + 1 == n && fract > 0 ? fract : 1
        out.append(VectorRepeaterCopy(index: i, matrix: m, opacity: JS.min(1, JS.max(0, (so + (eo - so) * t) * partial))))
    }
    return out
}

/// Each path repeated by `vectorRepeaterCopies` (copy order, the original first).
public func repeatPaths(_ paths: [BezierPath], _ r: JSONObject, _ pivot: Vec2) -> [(copy: VectorRepeaterCopy, paths: [BezierPath])] {
    vectorRepeaterCopies(r, pivot).map { copy in (copy, paths.map { transformBezierPath(.commands($0), copy.matrix.tuple) }) }
}

/// The middle of the paths' bounds (the origin when they are empty).
public func pathsCenter(_ paths: [BezierPath]) -> Vec2 {
    guard let b = bezierPathBounds(.commands(paths.flatMap { $0 })) else { return Vec2(0, 0) }
    return Vec2((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2)
}
