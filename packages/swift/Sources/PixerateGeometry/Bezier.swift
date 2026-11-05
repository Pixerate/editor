import Foundation
import PixerateRaster

// The Bézier path model (`canvas/pathops/bezier.ts`): conversion from SVG path data (arcs become
// cubics), segment maths (evaluation, splitting, extrema, nearest point), exact areas, winding
// numbers and arc-length utilities.

// MARK: - Vector helpers

@inline(__always) public func sub(_ a: PathPoint, _ b: PathPoint) -> PathPoint { Point(a[0] - b[0], a[1] - b[1]) }
@inline(__always) public func add(_ a: PathPoint, _ b: PathPoint) -> PathPoint { Point(a[0] + b[0], a[1] + b[1]) }
@inline(__always) public func scale(_ a: PathPoint, _ s: Double) -> PathPoint { Point(a[0] * s, a[1] * s) }
@inline(__always) public func dot(_ a: PathPoint, _ b: PathPoint) -> Double { a[0] * b[0] + a[1] * b[1] }
@inline(__always) public func cross(_ a: PathPoint, _ b: PathPoint) -> Double { a[0] * b[1] - a[1] * b[0] }
@inline(__always) public func dist(_ a: PathPoint, _ b: PathPoint) -> Double { hypot(a[0] - b[0], a[1] - b[1]) }
@inline(__always) public func lerp(_ a: PathPoint, _ b: PathPoint, _ t: Double) -> PathPoint {
    Point(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
}
@inline(__always) public func samePoint(_ a: PathPoint, _ b: PathPoint) -> Bool { a[0] == b[0] && a[1] == b[1] }

public func unit(_ v: PathPoint) -> PathPoint? {
    let l = hypot(v[0], v[1])
    return l > 0 && l.isFinite ? Point(v[0] / l, v[1] / l) : nil
}

// MARK: - Segment maths

/// Point at parameter `t`.
public func segmentPoint(_ seg: BezierSegment, _ t: Double) -> PathPoint {
    let n = seg.count
    if n == 2 { return lerp(seg[0], seg[1], t) }
    let mt = 1 - t
    if n == 3 {
        let a = mt * mt
        let b = 2 * mt * t
        let c = t * t
        return Point(a * seg[0][0] + b * seg[1][0] + c * seg[2][0], a * seg[0][1] + b * seg[1][1] + c * seg[2][1])
    }
    let a = mt * mt * mt
    let b = 3 * mt * mt * t
    let c = 3 * mt * t * t
    let d = t * t * t
    return Point(
        a * seg[0][0] + b * seg[1][0] + c * seg[2][0] + d * seg[3][0],
        a * seg[0][1] + b * seg[1][1] + c * seg[2][1] + d * seg[3][1]
    )
}

/// First derivative at `t`.
public func segmentDerivative(_ seg: BezierSegment, _ t: Double) -> PathPoint {
    let n = seg.count
    if n == 2 { return sub(seg[1], seg[0]) }
    if n == 3 {
        let a = sub(seg[1], seg[0])
        let b = sub(seg[2], seg[1])
        return Point(2 * ((1 - t) * a[0] + t * b[0]), 2 * ((1 - t) * a[1] + t * b[1]))
    }
    let a = sub(seg[1], seg[0])
    let b = sub(seg[2], seg[1])
    let c = sub(seg[3], seg[2])
    let mt = 1 - t
    return Point(
        3 * (mt * mt * a[0] + 2 * mt * t * b[0] + t * t * c[0]),
        3 * (mt * mt * a[1] + 2 * mt * t * b[1] + t * t * c[1])
    )
}

/// Second derivative at `t`.
public func segmentSecondDerivative(_ seg: BezierSegment, _ t: Double) -> PathPoint {
    let n = seg.count
    if n == 2 { return Point(0, 0) }
    if n == 3 { return Point(2 * (seg[2][0] - 2 * seg[1][0] + seg[0][0]), 2 * (seg[2][1] - 2 * seg[1][1] + seg[0][1])) }
    let a = Point(seg[2][0] - 2 * seg[1][0] + seg[0][0], seg[2][1] - 2 * seg[1][1] + seg[0][1])
    let b = Point(seg[3][0] - 2 * seg[2][0] + seg[1][0], seg[3][1] - 2 * seg[2][1] + seg[1][1])
    return Point(6 * ((1 - t) * a[0] + t * b[0]), 6 * ((1 - t) * a[1] + t * b[1]))
}

/// Unit tangent at `t`. Where the derivative vanishes the direction a hair further along is
/// used, and the chord as the last resort.
public func segmentTangent(_ seg: BezierSegment, _ t: Double) -> PathPoint {
    if let d = unit(segmentDerivative(seg, t)) { return d }
    let h = t < 0.5 ? jmin(1, t + 1e-6) : jmax(0, t - 1e-6)
    if let e = unit(segmentDerivative(seg, h)) { return e }
    return unit(sub(seg[seg.count - 1], seg[0])) ?? Point(1, 0)
}

/// Signed curvature at `t` (positive when turning counter-clockwise in a y-up frame).
public func segmentCurvature(_ seg: BezierSegment, _ t: Double) -> Double {
    if seg.count == 2 { return 0 }
    var d = segmentDerivative(seg, t)
    var tt = t
    if hypot(d[0], d[1]) < 1e-12 {
        tt = t < 0.5 ? jmin(1, t + 1e-6) : jmax(0, t - 1e-6)
        d = segmentDerivative(seg, tt)
    }
    let dd = segmentSecondDerivative(seg, tt)
    let len = hypot(d[0], d[1])
    if !(len > 0) { return 0 }
    return cross(d, dd) / (len * len * len)
}

/// Splits a segment at `t` (de Casteljau).
public func splitSegment(_ seg: BezierSegment, _ t: Double) -> (BezierSegment, BezierSegment) {
    let n = seg.count
    if n == 2 {
        let m = lerp(seg[0], seg[1], t)
        return ([seg[0], m], [m, seg[1]])
    }
    if n == 3 {
        let a = lerp(seg[0], seg[1], t)
        let b = lerp(seg[1], seg[2], t)
        let m = lerp(a, b, t)
        return ([seg[0], a, m], [m, b, seg[2]])
    }
    let a = lerp(seg[0], seg[1], t)
    let b = lerp(seg[1], seg[2], t)
    let c = lerp(seg[2], seg[3], t)
    let ab = lerp(a, b, t)
    let bc = lerp(b, c, t)
    let m = lerp(ab, bc, t)
    return ([seg[0], a, ab, m], [m, bc, c, seg[3]])
}

/// The part of a segment between `t0` and `t1` (reversed when `t1 < t0`).
public func subSegment(_ seg: BezierSegment, _ t0: Double, _ t1: Double) -> BezierSegment {
    if t1 < t0 { return subSegment(seg, t1, t0).reversed() }
    if t0 <= 0 && t1 >= 1 { return seg }
    var s = seg
    if t1 < 1 { s = splitSegment(s, t1).0 }
    if t0 > 0 { s = splitSegment(s, t1 > 0 ? t0 / t1 : 0).1 }
    return s
}

/// Whether every control point lies within `tol` of the chord.
public func isStraightSegment(_ seg: BezierSegment, _ tol: Double) -> Bool {
    if seg.count == 2 { return true }
    let a = seg[0]
    let b = seg[seg.count - 1]
    let chord = sub(b, a)
    let len = hypot(chord[0], chord[1])
    for i in 1..<(seg.count - 1) {
        let v = sub(seg[i], a)
        if len == 0 {
            if hypot(v[0], v[1]) > tol { return false }
            continue
        }
        if abs(cross(chord, v)) / len > tol { return false }
        let along = dot(chord, v) / len
        if along < -tol || along > len + tol { return false }
    }
    return true
}

/// Real roots in the open interval (0, 1) of `a t² + b t + c`.
private func quadraticRoots(_ a: Double, _ b: Double, _ c: Double, _ out: inout [Double]) {
    func push(_ t: Double) { if t > 1e-12 && t < 1 - 1e-12 { out.append(t) } }
    let scaleAbs = jmax(abs(a), abs(b), abs(c))
    if scaleAbs == 0 { return }
    if abs(a) <= 1e-12 * scaleAbs {
        if b != 0 { push(-c / b) }
        return
    }
    let disc = b * b - 4 * a * c
    if disc < 0 { return }
    let sq = JS.sqrt(disc)
    let q = -0.5 * (b + (b >= 0 ? sq : -sq))
    push(q / a)
    if q != 0 { push(c / q) }
}

/// Parameters in (0, 1) where the segment's `axis` coordinate has a local extremum.
public func segmentExtrema(_ seg: BezierSegment, _ axis: Int) -> [Double] {
    var out: [Double] = []
    if seg.count == 3 {
        let d = seg[0][axis] - 2 * seg[1][axis] + seg[2][axis]
        if d != 0 {
            let t = (seg[0][axis] - seg[1][axis]) / d
            if t > 1e-12 && t < 1 - 1e-12 { out.append(t) }
        }
    } else if seg.count == 4 {
        let p0 = seg[0][axis]
        let p1 = seg[1][axis]
        let p2 = seg[2][axis]
        let p3 = seg[3][axis]
        // B'(t)/3 = a t² + b t + c
        let a = -p0 + 3 * p1 - 3 * p2 + p3
        let b = 2 * (p0 - 2 * p1 + p2)
        let c = p1 - p0
        quadraticRoots(a, b, c, &out)
    }
    return jsSorted(out) { x, y in x - y }
}

/// Exact axis-aligned bounds of a segment.
public func segmentBounds(_ seg: BezierSegment) -> PathBounds {
    let a = seg[0]
    let b = seg[seg.count - 1]
    var minX = jmin(a[0], b[0])
    var maxX = jmax(a[0], b[0])
    var minY = jmin(a[1], b[1])
    var maxY = jmax(a[1], b[1])
    for axis in [0, 1] {
        for t in segmentExtrema(seg, axis) {
            let p = segmentPoint(seg, t)
            if axis == 0 {
                minX = jmin(minX, p[0])
                maxX = jmax(maxX, p[0])
            } else {
                minY = jmin(minY, p[1])
                maxY = jmax(maxY, p[1])
            }
        }
    }
    return PathBounds(minX: minX, minY: minY, maxX: maxX, maxY: maxY)
}

/// Parameters splitting the segment into pieces monotone in x and y.
public func monotoneParams(_ seg: BezierSegment) -> [Double] {
    if seg.count == 2 { return [] }
    let ts = jsSorted(segmentExtrema(seg, 0) + segmentExtrema(seg, 1)) { a, b in a - b }
    var out: [Double] = []
    for t in ts where out.isEmpty || t - out[out.count - 1] > 1e-9 { out.append(t) }
    return out
}

/// Signed area swept by the segment relative to the origin (½ ∫ x dy − y dx), exact by
/// 3-point Gauss–Legendre.
public func segmentAreaTerm(_ seg: BezierSegment) -> Double {
    if seg.count == 2 { return (seg[0][0] * seg[1][1] - seg[1][0] * seg[0][1]) / 2 }
    let nodes = [-JS.sqrt(3.0 / 5), 0, JS.sqrt(3.0 / 5)]
    let weights = [5.0 / 9, 8.0 / 9, 5.0 / 9]
    var sum = 0.0
    for i in 0..<3 {
        let t = (nodes[i] + 1) / 2
        let p = segmentPoint(seg, t)
        let d = segmentDerivative(seg, t)
        sum += weights[i] * (p[0] * d[1] - p[1] * d[0])
    }
    // ½ for the area, ½ for mapping [-1, 1] onto [0, 1].
    return sum / 4
}

// Gauss–Legendre nodes / weights (order 8) on [-1, 1].
private let GL_X: [Double] = [
    -0.9602898564975363, -0.7966664774136267, -0.525532409916329, -0.1834346424956498, 0.1834346424956498,
    0.525532409916329, 0.7966664774136267, 0.9602898564975363,
]
private let GL_W: [Double] = [
    0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.362683783378362, 0.362683783378362,
    0.3137066458778873, 0.2223810344533745, 0.1012285362903763,
]

private func glLength(_ seg: BezierSegment, _ t0: Double, _ t1: Double) -> Double {
    let half = (t1 - t0) / 2
    let mid = (t0 + t1) / 2
    var sum = 0.0
    for i in 0..<GL_X.count {
        let d = segmentDerivative(seg, mid + half * GL_X[i])
        sum += GL_W[i] * hypot(d[0], d[1])
    }
    return sum * half
}

private func adaptiveLength(_ seg: BezierSegment, _ t0: Double, _ t1: Double, _ whole: Double, _ tol: Double, _ depth: Int) -> Double {
    let m = (t0 + t1) / 2
    let left = glLength(seg, t0, m)
    let right = glLength(seg, m, t1)
    if depth >= 18 || abs(left + right - whole) <= tol { return left + right }
    return adaptiveLength(seg, t0, m, left, tol / 2, depth + 1) + adaptiveLength(seg, m, t1, right, tol / 2, depth + 1)
}

/// Arc length of the segment between `t0` and `t1` (default the whole segment).
public func segmentLength(_ seg: BezierSegment, _ t0: Double = 0, _ t1: Double = 1, _ tolerance: Double = 1e-9) -> Double {
    if t1 < t0 { return segmentLength(seg, t1, t0, tolerance) }
    if seg.count == 2 { return dist(seg[0], seg[1]) * (t1 - t0) }
    let whole = glLength(seg, t0, t1)
    return adaptiveLength(seg, t0, t1, whole, jmax(tolerance, whole * 1e-12), 0)
}

/// Parameter at arc length `length` from the segment start (clamped to [0, 1]).
public func segmentParamAtLength(_ seg: BezierSegment, _ length: Double, _ totalIn: Double? = nil) -> Double {
    let total = totalIn ?? segmentLength(seg)
    if !(total > 0) || length <= 0 { return 0 }
    if length >= total { return 1 }
    if seg.count == 2 { return length / total }
    var lo = 0.0
    var hi = 1.0
    var t = length / total
    for _ in 0..<40 {
        let err = segmentLength(seg, 0, t) - length
        if abs(err) <= 1e-10 * jmax(1, total) { break }
        if err > 0 { hi = t } else { lo = t }
        let d = segmentDerivative(seg, t)
        let speed = hypot(d[0], d[1])
        var next = speed > 0 ? t - err / speed : (lo + hi) / 2
        if !(next > lo && next < hi) { next = (lo + hi) / 2 }
        t = next
    }
    return t
}

/// Nearest point of the segment to `p`: the parameter and the distance.
public func segmentNearest(_ seg: BezierSegment, _ p: PathPoint) -> (t: Double, distance: Double) {
    if seg.count == 2 {
        let d = sub(seg[1], seg[0])
        let len2 = dot(d, d)
        let t = len2 == 0 ? 0 : jmax(0, jmin(1, dot(sub(p, seg[0]), d) / len2))
        return (t, dist(p, segmentPoint(seg, t)))
    }
    let samples = 16
    var best = (t: 0.0, distance: dist(p, seg[0]))
    var candidates: [Double] = []
    var prev = Double.infinity
    var prevT = 0.0
    var descending = false
    for i in 0...samples {
        let t = Double(i) / Double(samples)
        let d = dist(p, segmentPoint(seg, t))
        if d < best.distance { best = (t, d) }
        if i > 0 && d > prev && descending { candidates.append(prevT) }
        descending = d < prev
        prev = d
        prevT = t
    }
    candidates.append(best.t)
    candidates.append(1)
    for start in candidates {
        var t = start
        for _ in 0..<12 {
            let q = segmentPoint(seg, t)
            let d1 = segmentDerivative(seg, t)
            let d2 = segmentSecondDerivative(seg, t)
            let diff = sub(q, p)
            let f = dot(diff, d1)
            let fp = dot(d1, d1) + dot(diff, d2)
            if !(abs(fp) > 1e-300) { break }
            let next = jmax(0, jmin(1, t - f / fp))
            if abs(next - t) < 1e-14 {
                t = next
                break
            }
            t = next
        }
        let d = dist(p, segmentPoint(seg, t))
        if d < best.distance { best = (t, d) }
    }
    return best
}

// MARK: - Arcs

/// Converts an SVG elliptical arc (SVG 1.1 F.6.5) to cubic segments, at most 90° each.
public func arcToCubics(
    _ from: PathPoint, rx rxIn: Double, ry ryIn: Double, rotation: Double, largeArc: Bool, sweep: Bool, x: Double, y: Double
) -> [BezierSegment] {
    let x0 = from[0], y0 = from[1]
    if x0 == x && y0 == y { return [] }
    var rx = abs(rxIn)
    var ry = abs(ryIn)
    if rx == 0 || ry == 0 { return [[from, Point(x, y)]] }
    let phi = (rotation * PI) / 180
    let cos = JS.cos(phi)
    let sin = JS.sin(phi)
    let dx = (x0 - x) / 2
    let dy = (y0 - y) / 2
    let x1p = cos * dx + sin * dy
    let y1p = -sin * dx + cos * dy
    let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lambda > 1 {
        let s = JS.sqrt(lambda)
        rx *= s
        ry *= s
    }
    let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    var coef = den == 0 ? 0 : JS.sqrt(jmax(0, num / den))
    if largeArc == sweep { coef = -coef }
    let cxp = (coef * rx * y1p) / ry
    let cyp = (-coef * ry * x1p) / rx
    let cx = cos * cxp - sin * cyp + (x0 + x) / 2
    let cy = sin * cxp + cos * cyp + (y0 + y) / 2
    func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double { JS.atan2(ux * vy - uy * vx, ux * vx + uy * vy) }
    let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    var delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if !sweep && delta > 0 { delta -= 2 * PI } else if sweep && delta < 0 { delta += 2 * PI }
    let n = Int(jmax(1, JS.ceil(abs(delta) / (PI / 2) - 1e-9)))
    let step = delta / Double(n)
    let k = (4.0 / 3) * jtan(step / 4)
    func map(_ ux: Double, _ uy: Double) -> PathPoint {
        let ex = rx * ux
        let ey = ry * uy
        return Point(cos * ex - sin * ey + cx, sin * ex + cos * ey + cy)
    }
    var out: [BezierSegment] = []
    var prev = from
    for i in 0..<n {
        let a0 = theta1 + step * Double(i)
        let a1 = a0 + step
        let c0 = JS.cos(a0)
        let s0 = JS.sin(a0)
        let c1 = JS.cos(a1)
        let s1 = JS.sin(a1)
        let end = i == n - 1 ? Point(x, y) : map(c1, s1)
        out.append([prev, map(c0 - k * s0, s0 + k * c0), map(c1 + k * s1, s1 - k * c1), end])
        prev = end
    }
    return out
}

// MARK: - Conversions

/// Converts SVG path data or parsed commands to a `BezierPath` (absolute `M` / `L` / `Q` /
/// `C` / `Z`); elliptical arcs become cubic Béziers (at most 90° each).
public func toBezierPath(_ input: BezierPathInput) -> BezierPath {
    let commands: [PathCommand]
    switch input {
    case .svg(let d): commands = parseSvgPath(d)
    case .commands(let list): commands = list
    }
    var out: BezierPath = []
    var current = Point(0, 0)
    var start = Point(0, 0)
    var open = false
    func ensureMove() {
        if !open {
            out.append(.M(x: start[0], y: start[1]))
            current = start
            open = true
        }
    }
    for cmd in commands {
        switch cmd {
        case let .M(x, y):
            start = Point(x, y)
            current = start
            out.append(.M(x: x, y: y))
            open = true
        case let .L(x, y):
            ensureMove()
            out.append(.L(x: x, y: y))
            current = Point(x, y)
        case let .Q(x1, y1, x, y):
            ensureMove()
            out.append(.Q(x1: x1, y1: y1, x: x, y: y))
            current = Point(x, y)
        case let .C(x1, y1, x2, y2, x, y):
            ensureMove()
            out.append(.C(x1: x1, y1: y1, x2: x2, y2: y2, x: x, y: y))
            current = Point(x, y)
        case let .A(rx, ry, rotation, largeArc, sweep, x, y):
            ensureMove()
            for c in arcToCubics(current, rx: rx, ry: ry, rotation: rotation, largeArc: largeArc, sweep: sweep, x: x, y: y) {
                if c.count == 2 {
                    out.append(.L(x: c[1][0], y: c[1][1]))
                } else {
                    out.append(.C(x1: c[1][0], y1: c[1][1], x2: c[2][0], y2: c[2][1], x: c[3][0], y: c[3][1]))
                }
            }
            current = Point(x, y)
        case .Z:
            if open { out.append(.Z) }
            open = false
            current = start
        }
    }
    _ = current
    return out
}

/// Splits a path into contours of segments. Zero-length segments are dropped.
public func pathToContours(_ input: BezierPathInput) -> [BezierContour] {
    let path = toBezierPath(input)
    var contours: [BezierContour] = []
    // Index of the open contour in `contours` (the TS keeps a reference to it).
    var current: Int?
    var pen = Point(0, 0)
    var start = Point(0, 0)
    func push(_ seg: BezierSegment) {
        if current == nil {
            contours.append(BezierContour(segments: [], closed: false))
            current = contours.count - 1
        }
        if seg.allSatisfy({ samePoint($0, seg[0]) }) { return }
        contours[current!].segments.append(seg)
    }
    for cmd in path {
        switch cmd {
        case let .M(x, y):
            start = Point(x, y)
            pen = start
            contours.append(BezierContour(segments: [], closed: false))
            current = contours.count - 1
        case let .L(x, y):
            push([pen, Point(x, y)])
            pen = Point(x, y)
        case let .Q(x1, y1, x, y):
            push([pen, Point(x1, y1), Point(x, y)])
            pen = Point(x, y)
        case let .C(x1, y1, x2, y2, x, y):
            push([pen, Point(x1, y1), Point(x2, y2), Point(x, y)])
            pen = Point(x, y)
        case .Z:
            if let c = current { contours[c].closed = true }
            current = nil
            pen = start
        case .A:
            break
        }
    }
    return contours
}

/// Builds a path from contours (a closed contour's closing line is left to `Z`).
public func contoursToPath(_ contours: [BezierContour]) -> BezierPath {
    var out: BezierPath = []
    for contour in contours {
        let segs = contour.segments
        if segs.isEmpty { continue }
        out.append(.M(x: segs[0][0][0], y: segs[0][0][1]))
        var count = segs.count
        if contour.closed && count > 1 {
            let last = segs[count - 1]
            if last.count == 2 && samePoint(last[1], segs[0][0]) { count -= 1 }
        }
        for i in 0..<count {
            let s = segs[i]
            let end = s[s.count - 1]
            if s.count == 2 {
                out.append(.L(x: end[0], y: end[1]))
            } else if s.count == 3 {
                out.append(.Q(x1: s[1][0], y1: s[1][1], x: end[0], y: end[1]))
            } else {
                out.append(.C(x1: s[1][0], y1: s[1][1], x2: s[2][0], y2: s[2][1], x: end[0], y: end[1]))
            }
        }
        if contour.closed { out.append(.Z) }
    }
    return out
}

public struct BezierPathToSvgOptions: Sendable {
    /// Decimal places (default 3).
    public var precision: Int?
    /// Added to every point before formatting.
    public var offset: PathPoint?
    public init(precision: Int? = nil, offset: PathPoint? = nil) {
        self.precision = precision
        self.offset = offset
    }
}

/// Writes a path as compact SVG path data.
public func bezierPathToSvg(_ input: BezierPathInput, _ options: BezierPathToSvgOptions = .init()) -> String {
    let path = toBezierPath(input)
    let precision = options.precision ?? 3
    let dx = options.offset?[0] ?? 0
    let dy = options.offset?[1] ?? 0
    func fx(_ n: Double) -> String { formatNumber(n + dx, precision) }
    func fy(_ n: Double) -> String { formatNumber(n + dy, precision) }
    var d = ""
    for c in path {
        switch c {
        case let .M(x, y): d += "M\(fx(x)) \(fy(y))"
        case let .L(x, y): d += "L\(fx(x)) \(fy(y))"
        case let .Q(x1, y1, x, y): d += "Q\(fx(x1)) \(fy(y1)) \(fx(x)) \(fy(y))"
        case let .C(x1, y1, x2, y2, x, y): d += "C\(fx(x1)) \(fy(y1)) \(fx(x2)) \(fy(y2)) \(fx(x)) \(fy(y))"
        case .Z: d += "Z"
        case .A: break
        }
    }
    return d
}

/// 2D affine matrix `[a, b, c, d, e, f]` mapping `(x, y)` to `(a x + c y + e, b x + d y + f)`.
public typealias AffineMatrix = (Double, Double, Double, Double, Double, Double)

/// Applies an affine transform to every point (exact for Bézier curves).
public func transformBezierPath(_ input: BezierPathInput, _ m: AffineMatrix) -> BezierPath {
    let (a, b, c, d, e, f) = m
    func X(_ x: Double, _ y: Double) -> Double { a * x + c * y + e }
    func Y(_ x: Double, _ y: Double) -> Double { b * x + d * y + f }
    return toBezierPath(input).map { cmd in
        switch cmd {
        case let .M(x, y): return .M(x: X(x, y), y: Y(x, y))
        case let .L(x, y): return .L(x: X(x, y), y: Y(x, y))
        case let .Q(x1, y1, x, y): return .Q(x1: X(x1, y1), y1: Y(x1, y1), x: X(x, y), y: Y(x, y))
        case let .C(x1, y1, x2, y2, x, y):
            return .C(x1: X(x1, y1), y1: Y(x1, y1), x2: X(x2, y2), y2: Y(x2, y2), x: X(x, y), y: Y(x, y))
        default: return cmd
        }
    }
}

/// Number of drawing segments (`L` / `Q` / `C`, plus the closing line of `Z` when it has length).
public func countPathSegments(_ input: BezierPathInput) -> (lines: Int, quads: Int, cubics: Int) {
    var out = (lines: 0, quads: 0, cubics: 0)
    for contour in pathToContours(input) {
        for s in closeContour(contour) {
            if s.count == 2 { out.lines += 1 } else if s.count == 3 { out.quads += 1 } else { out.cubics += 1 }
        }
    }
    return out
}

/// The contour's segments, with the closing line added when the contour is closed (or filled).
public func closeContour(_ contour: BezierContour, _ force: Bool = false) -> [BezierSegment] {
    let segs = contour.segments
    if segs.isEmpty { return [] }
    if !contour.closed && !force { return segs }
    let first = segs[0][0]
    let lastSeg = segs[segs.count - 1]
    let last = lastSeg[lastSeg.count - 1]
    return samePoint(first, last) ? segs : segs + [[last, first]]
}

// MARK: - Measures

/// Exact bounds of a path, or `nil` when it has no points.
public func bezierPathBounds(_ input: BezierPathInput) -> PathBounds? {
    var minX = Double.infinity
    var minY = Double.infinity
    var maxX = -Double.infinity
    var maxY = -Double.infinity
    let path = toBezierPath(input)
    var pen: PathPoint?
    for contour in pathToContours(.commands(path)) {
        for s in contour.segments {
            let b = segmentBounds(s)
            minX = jmin(minX, b.minX)
            minY = jmin(minY, b.minY)
            maxX = jmax(maxX, b.maxX)
            maxY = jmax(maxY, b.maxY)
        }
    }
    for c in path {
        if case let .M(x, y) = c { pen = Point(x, y) }
        if let pen {
            minX = jmin(minX, pen[0])
            minY = jmin(minY, pen[1])
            maxX = jmax(maxX, pen[0])
            maxY = jmax(maxY, pen[1])
        }
    }
    return minX == .infinity ? nil : PathBounds(minX: minX, minY: minY, maxX: maxX, maxY: maxY)
}

/// Signed area of the path as drawn: every subpath closed, contributions summed.
public func bezierPathSignedArea(_ input: BezierPathInput) -> Double {
    var sum = 0.0
    for contour in pathToContours(input) { sum += contourSignedArea(closeContour(contour, true)) }
    return sum
}

/// Signed area of a closed chain of segments.
public func contourSignedArea(_ segs: [BezierSegment]) -> Double {
    var sum = 0.0
    for s in segs { sum += segmentAreaTerm(s) }
    return sum
}

/// Arc length of a path (closing lines of closed subpaths included).
public func bezierPathLength(_ input: BezierPathInput) -> Double {
    var total = 0.0
    for contour in pathToContours(input) {
        for s in closeContour(contour) { total += segmentLength(s) }
    }
    return total
}

/// Point, unit tangent and angle (radians) at an arc length along the path.
public struct PathPointAtLength: Equatable, Sendable {
    public var point: PathPoint
    public var tangent: PathPoint
    public var angle: Double
    /// Subpath index.
    public var contour: Int
    /// Segment index within the subpath (closing line last).
    public var segment: Int
    /// Parameter within the segment.
    public var t: Double
}

/// The point at arc length `length` from the start of the path (clamped to the path).
public func bezierPathPointAtLength(_ input: BezierPathInput, _ length: Double) -> PathPointAtLength? {
    let contours = pathToContours(input)
    var remaining = jmax(0, length)
    var last: PathPointAtLength?
    for ci in 0..<contours.count {
        let segs = closeContour(contours[ci])
        for si in 0..<segs.count {
            let s = segs[si]
            let len = segmentLength(s)
            if remaining <= len {
                let t = segmentParamAtLength(s, remaining, len)
                let tangent = segmentTangent(s, t)
                return PathPointAtLength(point: segmentPoint(s, t), tangent: tangent, angle: JS.atan2(tangent[1], tangent[0]), contour: ci, segment: si, t: t)
            }
            remaining -= len
            let tangent = segmentTangent(s, 1)
            last = PathPointAtLength(point: s[s.count - 1], tangent: tangent, angle: JS.atan2(tangent[1], tangent[0]), contour: ci, segment: si, t: 1)
        }
    }
    return last
}

/// The part of a segment chain between arc lengths `from` and `to` as new segments.
public func trimSegments(_ segs: [BezierSegment], _ from: Double, _ to: Double, _ lengths: [Double]? = nil) -> [BezierSegment] {
    let lens = lengths ?? segs.map { segmentLength($0) }
    var out: [BezierSegment] = []
    var at = 0.0
    for i in 0..<segs.count {
        let len = lens[i]
        let s0 = at
        let s1 = at + len
        at = s1
        if s1 <= from || s0 >= to || len <= 0 { continue }
        let t0 = from > s0 ? segmentParamAtLength(segs[i], from - s0, len) : 0
        let t1 = to < s1 ? segmentParamAtLength(segs[i], to - s0, len) : 1
        if t1 > t0 { out.append(subSegment(segs[i], t0, t1)) }
    }
    return out
}

// MARK: - Winding numbers

/// Parameter where a monotone segment reaches `value` on `axis` (it must span it).
public func solveMonotone(_ seg: BezierSegment, _ axis: Int, _ value: Double) -> Double {
    let a = seg[0][axis]
    let b = seg[seg.count - 1][axis]
    if seg.count == 2 { return b == a ? 0 : (value - a) / (b - a) }
    let increasing = b > a
    var lo = 0.0
    var hi = 1.0
    var t = b == a ? 0.5 : jmax(0, jmin(1, (value - a) / (b - a)))
    for _ in 0..<60 {
        let v = segmentPoint(seg, t)[axis] - value
        if v == 0 { return t }
        if (v > 0) == increasing { hi = t } else { lo = t }
        let d = segmentDerivative(seg, t)[axis]
        var next = d != 0 ? t - v / d : (lo + hi) / 2
        if !(next > lo && next < hi) { next = (lo + hi) / 2 }
        if abs(next - t) < 1e-15 { return next }
        t = next
    }
    return t
}

/// Splits segments at their y extrema (pieces monotone in y).
private func yMonotonePieces(_ segs: [BezierSegment]) -> [BezierSegment] {
    var out: [BezierSegment] = []
    for s in segs {
        if s.count == 2 {
            out.append(s)
            continue
        }
        var prev = 0.0
        for t in segmentExtrema(s, 1) + [1] {
            out.append(subSegment(s, prev, t))
            prev = t
        }
    }
    return out
}

/// Winding number of a set of closed segment chains around `point` (ray to +x, half-open
/// crossing rule).
public func windingNumber(_ chains: [[BezierSegment]], _ point: PathPoint) -> Int {
    let px = point[0], py = point[1]
    var winding = 0
    for chain in chains {
        for s in yMonotonePieces(chain) {
            let ay = s[0][1]
            let by = s[s.count - 1][1]
            var dir = 0
            if ay <= py && by > py { dir = 1 } else if by <= py && ay > py { dir = -1 } else { continue }
            var minX = Double.infinity
            var maxX = -Double.infinity
            for p in s {
                if p[0] < minX { minX = p[0] }
                if p[0] > maxX { maxX = p[0] }
            }
            if minX > px {
                winding += dir
                continue
            }
            if maxX <= px { continue }
            let t = solveMonotone(s, 1, py)
            if segmentPoint(s, t)[0] > px { winding += dir }
        }
    }
    return winding
}

/// Whether `point` is inside the filled path (every subpath closed for filling).
public func pointInBezierPath(_ input: BezierPathInput, _ point: PathPoint, _ fillRule: PolygonFillRule = .nonzero) -> Bool {
    let chains = pathToContours(input).map { closeContour($0, true) }
    let w = windingNumber(chains, point)
    return fillRule == .evenodd ? (w & 1) == 1 : w != 0
}

/// Distance from `point` to the path outline (closing lines of closed subpaths included).
public func distanceToBezierPath(_ input: BezierPathInput, _ point: PathPoint) -> Double {
    distanceToBezierPath(pathToContours(input), point)
}

/// Distance from `point` to the contours' outline.
public func distanceToBezierPath(_ contours: [BezierContour], _ point: PathPoint) -> Double {
    var best = Double.infinity
    for contour in contours {
        for s in closeContour(contour) {
            // Skip segments whose control hull is farther than the best distance so far.
            var minX = Double.infinity
            var minY = Double.infinity
            var maxX = -Double.infinity
            var maxY = -Double.infinity
            for p in s {
                minX = jmin(minX, p[0])
                minY = jmin(minY, p[1])
                maxX = jmax(maxX, p[0])
                maxY = jmax(maxY, p[1])
            }
            let dx = jmax(minX - point[0], 0, point[0] - maxX)
            let dy = jmax(minY - point[1], 0, point[1] - maxY)
            if hypot(dx, dy) >= best { continue }
            best = jmin(best, segmentNearest(s, point).distance)
        }
    }
    return best
}

/// Flattens a closed chain into a polygon ring (for classification only).
public func flattenChain(_ segs: [BezierSegment], _ tolerance: Double) -> [PathPoint] {
    var out: [PathPoint] = []
    for s in segs {
        if out.isEmpty { out.append(s[0]) }
        if s.count == 2 {
            out.append(s[1])
            continue
        }
        var dd = 0.0
        var i = 0
        while i + 2 < s.count {
            dd = jmax(dd, hypot(s[i][0] - 2 * s[i + 1][0] + s[i + 2][0], s[i][1] - 2 * s[i + 1][1] + s[i + 2][1]))
            i += 1
        }
        let deg = Double(s.count - 1)
        // NaN (a zero tolerance on a straight curve) adds no points, as `k <= NaN` in the TS.
        let n = jmax(1, jmin(256, JS.ceil(JS.sqrt((deg * (deg - 1) * dd) / (8 * tolerance)))))
        var k = 1.0
        while k <= n {
            out.append(segmentPoint(s, k / n))
            k += 1
        }
    }
    if out.count > 1 && samePoint(out[0], out[out.count - 1]) { out.removeLast() }
    return out
}
