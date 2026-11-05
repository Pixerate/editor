import Foundation
import PixerateRaster

// Port of `canvas/curveFit.ts`: least-squares cubic Bézier fitting of point sequences
// (Schneider-style), with corners kept by a turning-angle test.

/// One cubic Bézier segment.
public struct CubicSegment: Equatable, Sendable {
    public var p0: PathPoint
    public var p1: PathPoint
    public var p2: PathPoint
    public var p3: PathPoint
    public init(p0: PathPoint, p1: PathPoint, p2: PathPoint, p3: PathPoint) {
        self.p0 = p0
        self.p1 = p1
        self.p2 = p2
        self.p3 = p3
    }
}

/// `FitCubicsOptions`.
public struct FitCubicsOptions: Sendable {
    /// Vertices turning by more than this many degrees stay sharp corners (default 30).
    public var cornerAngleDeg: Double?
    /// Treat the points as a closed ring.
    public var closed: Bool?
    public init(cornerAngleDeg: Double? = nil, closed: Bool? = nil) {
        self.cornerAngleDeg = cornerAngleDeg
        self.closed = closed
    }
}

/// `FitPathDataOptions`.
public struct FitPathDataOptions: Sendable {
    /// Corner threshold in degrees (default 30).
    public var cornerAngleDeg: Double?
    /// Closed ring (default `true` in `fitPathData`).
    public var closed: Bool?
    /// Fitting tolerance in path units (default 0.5).
    public var tolerance: Double?
    /// Decimal places (default 3).
    public var precision: Double?
    /// Added to every point before formatting.
    public var offset: (x: Double, y: Double)?
    /// Keep the polyline when fitting would not make the path lighter (default `true`).
    public var noWorse: Bool?
    public init(
        cornerAngleDeg: Double? = nil, closed: Bool? = nil, tolerance: Double? = nil, precision: Double? = nil,
        offset: (x: Double, y: Double)? = nil, noWorse: Bool? = nil
    ) {
        self.cornerAngleDeg = cornerAngleDeg
        self.closed = closed
        self.tolerance = tolerance
        self.precision = precision
        self.offset = offset
        self.noWorse = noWorse
    }
}

/// `cubicsToPathData`'s options.
public struct CubicsToPathDataOptions: Sendable {
    public var precision: Double?
    public var offset: (x: Double, y: Double)?
    public var closed: Bool?
    public var straightTolerance: Double?
    public init(precision: Double? = nil, offset: (x: Double, y: Double)? = nil, closed: Bool? = nil, straightTolerance: Double? = nil) {
        self.precision = precision
        self.offset = offset
        self.closed = closed
        self.straightTolerance = straightTolerance
    }
}

/// Maximum Newton reparameterisation rounds per fit.
private let MAX_REPARAM = 6

private typealias Vec = PathPoint

// `sub`, `dot` and `dist` are Bezier.swift's (the same arithmetic as the TS here).

/// `add(a, v, s)`: `a + v * s`.
@inline(__always) private func addScaled(_ a: Point, _ v: Vec, _ s: Double) -> Vec { Vec(a[0] + v[0] * s, a[1] + v[1] * s) }

/// `unit` (curveFit's: lengths up to 1e-12 count as zero, unlike Bezier.swift's `unit`).
private func fitUnit(_ v: Vec) -> Vec? {
    let l = hypot(v[0], v[1])
    return l > 1e-12 && l.isFinite ? Vec(v[0] / l, v[1] / l) : nil
}

private func evalCubic(_ c: CubicSegment, _ t: Double) -> Vec {
    let s = 1 - t
    let b0 = s * s * s
    let b1 = 3 * s * s * t
    let b2 = 3 * s * t * t
    let b3 = t * t * t
    let x: Double = b0 * c.p0[0] + b1 * c.p1[0] + b2 * c.p2[0] + b3 * c.p3[0]
    let y: Double = b0 * c.p0[1] + b1 * c.p1[1] + b2 * c.p2[1] + b3 * c.p3[1]
    return Vec(x, y)
}

/// Evaluates a cubic segment at `t` ∈ [0, 1].
public func cubicPointAt(_ c: CubicSegment, _ t: Double) -> PathPoint { evalCubic(c, t) }

private func dedup(_ points: [Point]) -> [Point] {
    var out: [Point] = []
    for p in points {
        if !p[0].isFinite || !p[1].isFinite { continue }
        if out.isEmpty || dist(out[out.count - 1], p) > 1e-12 { out.append(p) }
    }
    return out
}

/// Chord-length parameters (0 to 1), one per point.
private func chordParams(_ pts: [Point]) -> [Double] {
    var u: [Double] = [0]
    var acc = 0.0
    for i in 1..<max(pts.count, 1) {
        acc += dist(pts[i - 1], pts[i])
        u.append(acc)
    }
    return acc > 0 ? u.map { $0 / acc } : u
}

/// Solves the 2×2 normal equations for the handle lengths along the fixed tangents.
private func generate(_ pts: [Point], _ u: [Double], _ t0: Vec, _ t1: Vec) -> CubicSegment {
    let p0 = pts[0]
    let p3 = pts[pts.count - 1]
    let dirIn = Vec(-t1[0], -t1[1])
    var c00 = 0.0
    var c01 = 0.0
    var c11 = 0.0
    var x0 = 0.0
    var x1 = 0.0
    for i in 0..<pts.count {
        let t = u[i]
        let s = 1 - t
        let b0 = s * s * s
        let b1 = 3 * s * s * t
        let b2 = 3 * s * t * t
        let b3 = t * t * t
        let a0 = Vec(t0[0] * b1, t0[1] * b1)
        let a1 = Vec(dirIn[0] * b2, dirIn[1] * b2)
        c00 += dot(a0, a0)
        c01 += dot(a0, a1)
        c11 += dot(a1, a1)
        let tx: Double = pts[i][0] - (p0[0] * (b0 + b1) + p3[0] * (b2 + b3))
        let ty: Double = pts[i][1] - (p0[1] * (b0 + b1) + p3[1] * (b2 + b3))
        let tmp = Vec(tx, ty)
        x0 += dot(a0, tmp)
        x1 += dot(a1, tmp)
    }
    let det = c00 * c11 - c01 * c01
    let seg = dist(p0, p3)
    let eps = 1e-6 * seg
    var al = seg / 3
    var ar = seg / 3
    if abs(det) > 1e-12 {
        al = (x0 * c11 - x1 * c01) / det
        ar = (c00 * x1 - c01 * x0) / det
    }
    if !al.isFinite || !ar.isFinite || al < eps || ar < eps {
        al = seg / 3
        ar = seg / 3
    }
    // Guard against wild handles on nearly degenerate data.
    let cap = seg * 4 + 1e-9
    al = jmin(al, cap)
    ar = jmin(ar, cap)
    return CubicSegment(p0: p0, p1: addScaled(p0, t0, al), p2: addScaled(p3, dirIn, ar), p3: p3)
}

/// Largest distance between a point and the curve at its parameter, and that point's index.
private func maxError(_ pts: [Point], _ c: CubicSegment, _ u: [Double]) -> (Double, Int) {
    var e = 0.0
    var idx = pts.count >> 1
    for i in 0..<pts.count {
        let d = dist(evalCubic(c, u[i]), pts[i])
        if d > e {
            e = d
            idx = i
        }
    }
    return (e, idx)
}

/// One Newton–Raphson step towards the parameter of the point on `c` nearest `p`.
private func newton(_ c: CubicSegment, _ p: Point, _ t: Double) -> Double {
    let s = 1 - t
    let q = evalCubic(c, t)
    let d1x: Double = 3 * (s * s * (c.p1[0] - c.p0[0]) + 2 * s * t * (c.p2[0] - c.p1[0]) + t * t * (c.p3[0] - c.p2[0]))
    let d1y: Double = 3 * (s * s * (c.p1[1] - c.p0[1]) + 2 * s * t * (c.p2[1] - c.p1[1]) + t * t * (c.p3[1] - c.p2[1]))
    let d2x: Double = 6 * (s * (c.p2[0] - 2 * c.p1[0] + c.p0[0]) + t * (c.p3[0] - 2 * c.p2[0] + c.p1[0]))
    let d2y: Double = 6 * (s * (c.p2[1] - 2 * c.p1[1] + c.p0[1]) + t * (c.p3[1] - 2 * c.p2[1] + c.p1[1]))
    let d1 = Vec(d1x, d1y)
    let d2 = Vec(d2x, d2y)
    let diff = Vec(q[0] - p[0], q[1] - p[1])
    let num = dot(diff, d1)
    let den = dot(d1, d1) + dot(diff, d2)
    if abs(den) < 1e-12 { return t }
    let nt = t - num / den
    return nt.isFinite ? jmin(1, jmax(0, nt)) : t
}

/// Best single cubic through `pts` with the given unit end tangents, starting from parameters
/// `u`: the curve, its max error and the index of the worst point.
private func fitSingleFrom(_ pts: [Point], _ u: [Double], _ t0: Vec, _ t1: Vec) -> (CubicSegment, Double, Int) {
    var best = generate(pts, u, t0, t1)
    var (bestErr, bestSplit) = maxError(pts, best, u)
    var params = u
    for _ in 0..<MAX_REPARAM {
        for i in 0..<params.count { params[i] = newton(best, pts[i], params[i]) }
        let c = generate(pts, params, t0, t1)
        let (e, s) = maxError(pts, c, params)
        if e < bestErr {
            best = c
            bestErr = e
            bestSplit = s
        } else {
            break
        }
    }
    return (best, bestErr, bestSplit)
}

/// The best single cubic from the first to the last of `points`, leaving along the unit tangent
/// `t0` and arriving along `t1` (forward), from parameters `params` (refined by Newton steps).
public func fitCubicWithTangents(_ points: [PathPoint], _ params: [Double], _ t0: PathPoint, _ t1: PathPoint) -> (curve: CubicSegment, error: Double) {
    let (curve, error, _) = fitSingleFrom(points, params, t0, t1)
    return (curve, error)
}

private func fitRec(_ pts: [Point], _ t0: Vec, _ t1: Vec, _ tol: Double, _ out: inout [CubicSegment], _ depth: Int) {
    let n = pts.count
    if n == 2 {
        let d = dist(pts[0], pts[1]) / 3
        out.append(CubicSegment(p0: pts[0], p1: addScaled(pts[0], t0, d), p2: addScaled(pts[1], t1, -d), p3: pts[1]))
        return
    }
    let (c, err, splitAt) = fitSingleFrom(pts, chordParams(pts), t0, t1)
    if err <= tol || depth > 40 {
        out.append(c)
        return
    }
    // Split at the worst point with a centre tangent estimated from its neighbours.
    let split = min(n - 2, max(1, splitAt))
    let tc = fitUnit(sub(pts[split + 1], pts[split - 1])) ?? t0
    fitRec(Array(pts[0..<(split + 1)]), t0, tc, tol, &out, depth + 1)
    fitRec(Array(pts[split...]), tc, t1, tol, &out, depth + 1)
}

/// Unit tangent at `a` from the parabola through `a`, `b`, `c` (chord-length parameters).
private func tangentFrom(_ a: Point, _ b: Point, _ c: Point?) -> Vec? {
    let chord = fitUnit(sub(b, a))
    guard let c else { return chord }
    let d1 = dist(a, b)
    let d2 = dist(b, c)
    if !(d1 > 0) || !(d2 > 0) { return chord }
    let ka = -(2 * d1 + d2) / (d1 * (d1 + d2))
    let kb = (d1 + d2) / (d1 * d2)
    let kc = -d1 / (d2 * (d1 + d2))
    let ex: Double = ka * a[0] + kb * b[0] + kc * c[0]
    let ey: Double = ka * a[1] + kb * b[1] + kc * c[1]
    let est = fitUnit(Vec(ex, ey))
    // Fall back to the chord when the estimate swings too far (noisy or sharp data).
    if let est, let chord, dot(est, chord) > JS.cos(PI / 4) { return est }
    return chord
}

/// Fits a G1-continuous chain of cubics through `points` (an open run) with the unit tangents
/// `t0` (leaving the first point) and `t1` (arriving at the last, forward), estimated when nil.
public func fitCubicRun(_ points: [PathPoint], _ tolerance: Double, _ t0: PathPoint? = nil, _ t1: PathPoint? = nil) -> [CubicSegment] {
    let pts = dedup(points)
    var out: [CubicSegment] = []
    if pts.count < 2 { return out }
    let n = pts.count
    let start = t0.flatMap { fitUnit($0) } ?? tangentFrom(pts[0], pts[1], n > 2 ? pts[2] : nil) ?? Vec(1, 0)
    let back = tangentFrom(pts[n - 1], pts[n - 2], n >= 3 ? pts[n - 3] : nil)
    let end = t1.flatMap { fitUnit($0) } ?? (back.map { Vec(-$0[0], -$0[1]) } ?? Vec(1, 0))
    fitRec(pts, start, end, jmax(tolerance, 1e-9), &out, 0)
    return out
}

/// Turning angle in degrees between the directions `a`→`b` and `b`→`c`.
private func turnDeg(_ a: Point, _ b: Point, _ c: Point) -> Double {
    guard let u = fitUnit(sub(b, a)), let v = fitUnit(sub(c, b)) else { return 0 }
    return (jacos(jmin(1, jmax(-1, dot(u, v)))) * 180) / PI
}

/// Corner vertices of a polyline (turn measured to the nearest neighbours at least `span` away;
/// only the sharpest vertex of a neighbourhood kept; open end points excluded).
private func findCorners(_ pts: [Point], _ closed: Bool, _ cornerAngle: Double, _ span: Double) -> [Int] {
    let n = pts.count
    let at = { (i: Int) -> Point in pts[closed ? ((i % n) + n) % n : i] }
    let reach = { (i: Int, step: Int) -> Int? in
        var k = 1
        while !closed || k < n {
            let j = i + step * k
            if !closed && (j < 0 || j >= n) { return k > 1 ? j - step : nil }
            if dist(at(j), pts[i]) >= span { return j }
            k += 1
        }
        return nil
    }
    var turns = [Double](repeating: 0, count: n)
    var windows: [(Int, Int)] = []
    for i in 0..<n {
        windows.append((i, i))
        if !closed && (i == 0 || i == n - 1) { continue }
        guard let prev = reach(i, -1), let next = reach(i, 1) else { continue }
        windows[i] = (prev, next)
        turns[i] = turnDeg(at(prev), pts[i], at(next))
    }
    var corners: [Int] = []
    for i in 0..<n {
        if !(turns[i] > cornerAngle) { continue }
        let (lo, hi) = windows[i]
        var sharpest = true
        var j = lo
        while j <= hi && sharpest {
            defer { j += 1 }
            let k = closed ? ((j % n) + n) % n : j
            if k == i || dist(pts[k], pts[i]) >= span { continue }
            if turns[k] > turns[i] || (turns[k] == turns[i] && k < i) { sharpest = false }
        }
        if sharpest { corners.append(i) }
    }
    return corners
}

/// The run's vertices plus extra samples along edges much longer than its typical edge.
private func densify(_ run: [Point]) -> [Point] {
    if run.count < 3 { return run }
    var lengths: [Double] = []
    for i in 1..<run.count { lengths.append(dist(run[i - 1], run[i])) }
    let sorted = jsSorted(lengths) { $0 - $1 }
    let median = sorted[sorted.count >> 1]
    if !(median > 0) { return run }
    var out: [Point] = [run[0]]
    for i in 1..<run.count {
        let len = lengths[i - 1]
        if len > 2 * median {
            let steps = jmin(64, JS.ceil(len / median))
            let a = run[i - 1]
            let b = run[i]
            var k = 1.0
            while k < steps {
                let t = k / steps
                out.append(Point(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
                k += 1
            }
        }
        out.append(run[i])
    }
    return out
}

/// Fits cubic Bézier segments to a polyline (`closed` for a ring), keeping vertices that turn
/// by more than `cornerAngleDeg` (default 30°) as sharp corners; every point within `tolerance`.
public func fitCubics(_ points: [PathPoint], _ tolerance: Double, _ options: FitCubicsOptions = FitCubicsOptions()) -> [CubicSegment] {
    var pts = dedup(points)
    let closed = options.closed == true
    if closed && pts.count > 1 && dist(pts[0], pts[pts.count - 1]) <= 1e-12 { pts.removeLast() }
    if pts.count < 2 { return [] }
    let tol = jmax(tolerance, 1e-6)
    let cornerAngle = options.cornerAngleDeg ?? 30
    let n = pts.count
    let span = 4 * tol

    if !closed || n < 3 {
        let corners = [0] + (n > 2 ? findCorners(pts, false, cornerAngle, span) : []) + [n - 1]
        var out: [CubicSegment] = []
        for k in 1..<corners.count {
            let run = Array(pts[corners[k - 1]...corners[k]])
            out += fitCubicRun(densify(run), tol)
        }
        if closed && n == 2 { out += fitCubicRun([pts[1], pts[0]], tol) }
        return out
    }

    let corners = findCorners(pts, true, cornerAngle, span)
    if corners.isEmpty {
        // Smooth ring: start anywhere, with the same tangent leaving and arriving.
        let ring = pts + [pts[0]]
        let t = fitUnit(sub(pts[1], pts[n - 1])) ?? Vec(1, 0)
        return fitCubicRun(densify(ring), tol, t, t)
    }
    var out: [CubicSegment] = []
    for k in 0..<corners.count {
        let from = corners[k]
        let to = corners[(k + 1) % corners.count]
        var run: [Point] = []
        var i = from
        while true {
            run.append(pts[i])
            if run.count > 1 && i == to { break }
            i = (i + 1) % n
        }
        out += fitCubicRun(densify(run), tol)
    }
    return out
}

/// Whether a cubic is (within `tol`) the straight line from `p0` to `p3`.
public func isStraightCubic(_ c: CubicSegment, _ tol: Double) -> Bool {
    let chord = sub(c.p3, c.p0)
    let len = hypot(chord[0], chord[1])
    if len < 1e-12 { return dist(c.p1, c.p0) <= tol && dist(c.p2, c.p0) <= tol }
    let dir = Vec(chord[0] / len, chord[1] / len)
    return [c.p1, c.p2].allSatisfy { h in
        let v = sub(h, c.p0)
        let along = dot(v, dir)
        let across = abs(v[0] * dir[1] - v[1] * dir[0])
        return across <= tol && along >= -tol && along <= len + tol
    }
}

/// SVG `d` for fitted segments (`L` for straight ones, `C` otherwise).
public func cubicsToPathData(_ segments: [CubicSegment], _ options: CubicsToPathDataOptions = CubicsToPathDataOptions()) -> String {
    if segments.isEmpty { return "" }
    let precision = options.precision ?? 3
    let f = { (n: Double) in formatNumber(n, precision) }
    let dx = options.offset?.x ?? 0
    let dy = options.offset?.y ?? 0
    let pt = { (p: Point) in "\(f(p[0] + dx)) \(f(p[1] + dy))" }
    let straight = options.straightTolerance ?? 1e-3
    let closed = options.closed == true
    var d = "M\(pt(segments[0].p0))"
    for (i, c) in segments.enumerated() {
        let last = closed && i == segments.count - 1
        if isStraightCubic(c, straight) {
            if !last { d += "L\(pt(c.p3))" }
        } else {
            d += "C\(pt(c.p1)) \(pt(c.p2)) \(pt(c.p3))"
        }
    }
    return closed ? "\(d)Z" : d
}

private func polylineToPathData(_ points: [Point], _ closed: Bool, _ options: FitPathDataOptions) -> String {
    if points.count < 2 { return "" }
    let precision = options.precision ?? 3
    let f = { (n: Double) in formatNumber(n, precision) }
    let dx = options.offset?.x ?? 0
    let dy = options.offset?.y ?? 0
    var d = "M\(f(points[0][0] + dx)) \(f(points[0][1] + dy))"
    for i in 1..<points.count { d += "L\(f(points[i][0] + dx)) \(f(points[i][1] + dy))" }
    return closed ? "\(d)Z" : d
}

/// Fits smooth curves to a polygon ring (closed by default) and returns SVG path data with `C`
/// curves for smooth stretches, `L` lines for straight ones and sharp corners kept.
public func fitPathData(_ ring: [PathPoint], _ options: FitPathDataOptions = FitPathDataOptions()) -> String {
    let closed = options.closed ?? true
    let tolerance = options.tolerance ?? 0.5
    let pts = dedup(ring)
    let segments = fitCubics(pts, tolerance, FitCubicsOptions(cornerAngleDeg: options.cornerAngleDeg, closed: closed))
    if segments.isEmpty { return "" }
    let edges = closed ? pts.count : pts.count - 1
    if options.noWorse != false {
        let straight = segments.filter { isStraightCubic($0, tolerance * 0.02) }.count
        // Fitting only pays off when it removes vertices.
        if segments.count >= edges && straight == segments.count { return polylineToPathData(pts, closed, options) }
        if segments.count > edges { return polylineToPathData(pts, closed, options) }
    }
    return cubicsToPathData(segments, CubicsToPathDataOptions(
        precision: options.precision,
        offset: options.offset,
        closed: closed,
        straightTolerance: tolerance * 0.02
    ))
}

/// Smooths a freehand stroke into an open SVG path of cubic curves (`tolerance` default 1).
/// `options.closed` is ignored.
public func fitFreehandPath(_ points: [PathPoint], _ options: FitPathDataOptions = FitPathDataOptions()) -> String {
    var o = options
    o.tolerance = options.tolerance ?? 1
    o.closed = false
    return fitPathData(points, o)
}
