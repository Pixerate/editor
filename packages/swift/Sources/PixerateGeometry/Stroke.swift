import Foundation
import PixerateRaster

// Offset Path and Outline Stroke on Bézier paths (`canvas/pathops/stroke.ts`).
//
// The stroker offsets every segment by ± half the width (lines exactly, curves by cubic
// approximations refined until they stay within `tolerance` of the true offset), joins the
// pieces (miter with a miter limit, round or bevel on the outer side of a turn; through the
// vertex on the inner side) and adds caps (butt, round, square) to open subpaths. Dashes
// follow arc length, restart on every subpath and join across the start of a closed
// subpath. The raw outline overlaps itself, so it is filled with the non-zero rule and
// normalised with the curve boolean engine.
//
// When the stroke is wider than a curve's radius of curvature the inner offset turns inside
// out and its loops cancel winding, leaving holes that are really covered. Every face of
// the true result is bounded by the arrangement, so a face is spurious exactly when a point
// deep inside it is closer to the path than the offset distance (holes when growing,
// islands when insetting); such faces are dropped.
//
// Portions ported from vectorcraft-main/crates/pathops/src/offset.rs,
// vectorcraft-main/crates/pathops/src/boolean.rs (`try_merge`) and
// vectorcraft-main/crates/effects/src/stroke/dash.rs (MIT OR Apache-2.0, © ArtCraft Team
// and contributors). See THIRD_PARTY_NOTICES.md.

/// Line join (as SVG `stroke-linejoin`).
public enum StrokeJoin: String, Sendable {
    case miter, round, bevel
}

/// Line cap (as SVG `stroke-linecap`).
public enum StrokeCap: String, Sendable {
    case butt, round, square
}

/// `OutlineStrokeOptions` (extends `PathOpsOptions`: its fields pass through to the boolean engine).
public struct OutlineStrokeOptions {
    /// Stroke width. Non-positive or non-finite widths give an empty result.
    public var width: Double
    /// Default `miter` (as SVG).
    public var join: StrokeJoin?
    /// Default `butt` (as SVG).
    public var cap: StrokeCap?
    /// Miter length / stroke width above which a miter join is bevelled (default 4, as SVG).
    public var miterLimit: Double?
    /// Dash pattern (as SVG `stroke-dasharray`); odd patterns repeat twice.
    public var dash: [Double]?
    /// Distance into the dash pattern at the start of each subpath (as `stroke-dashoffset`).
    public var dashOffset: Double?
    /// Maximum distance between the approximated and the true offset curve (default 0.01).
    public var tolerance: Double?
    /// `PathOpsOptions.epsilon`.
    public var epsilon: Double?
    /// `PathOpsOptions.fallback`.
    public var fallback: Bool?
    /// `PathOpsOptions.fallbackTolerance`.
    public var fallbackTolerance: Double?
    /// `PathOpsOptions.onFallback`.
    public var onFallback: ((String) -> Void)?
    /// `PathOpsOptions.subdivisionBudget`.
    public var subdivisionBudget: Double?

    public init(
        width: Double, join: StrokeJoin? = nil, cap: StrokeCap? = nil, miterLimit: Double? = nil,
        dash: [Double]? = nil, dashOffset: Double? = nil, tolerance: Double? = nil,
        epsilon: Double? = nil, fallback: Bool? = nil, fallbackTolerance: Double? = nil,
        onFallback: ((String) -> Void)? = nil, subdivisionBudget: Double? = nil
    ) {
        self.width = width
        self.join = join
        self.cap = cap
        self.miterLimit = miterLimit
        self.dash = dash
        self.dashOffset = dashOffset
        self.tolerance = tolerance
        self.epsilon = epsilon
        self.fallback = fallback
        self.fallbackTolerance = fallbackTolerance
        self.onFallback = onFallback
        self.subdivisionBudget = subdivisionBudget
    }

    /// The `PathOpsOptions` part.
    public var pathOps: PathOpsOptions {
        PathOpsOptions(epsilon: epsilon, fallback: fallback, fallbackTolerance: fallbackTolerance, onFallback: onFallback, subdivisionBudget: subdivisionBudget)
    }
}

/// `OffsetPathOptions` (extends `PathOpsOptions`: its fields pass through to the boolean engine).
public struct OffsetPathOptions {
    /// Corner style of the grown / shrunk outline (default `miter`).
    public var join: StrokeJoin?
    /// Miter limit (default 4).
    public var miterLimit: Double?
    /// Fill rule of the input (default `nonzero`).
    public var fillRule: PolygonFillRule?
    /// Maximum distance between the approximated and the true offset curve (default 0.01).
    public var tolerance: Double?
    /// `PathOpsOptions.epsilon`.
    public var epsilon: Double?
    /// `PathOpsOptions.fallback`.
    public var fallback: Bool?
    /// `PathOpsOptions.fallbackTolerance`.
    public var fallbackTolerance: Double?
    /// `PathOpsOptions.onFallback`.
    public var onFallback: ((String) -> Void)?
    /// `PathOpsOptions.subdivisionBudget`.
    public var subdivisionBudget: Double?

    public init(
        join: StrokeJoin? = nil, miterLimit: Double? = nil, fillRule: PolygonFillRule? = nil, tolerance: Double? = nil,
        epsilon: Double? = nil, fallback: Bool? = nil, fallbackTolerance: Double? = nil,
        onFallback: ((String) -> Void)? = nil, subdivisionBudget: Double? = nil
    ) {
        self.join = join
        self.miterLimit = miterLimit
        self.fillRule = fillRule
        self.tolerance = tolerance
        self.epsilon = epsilon
        self.fallback = fallback
        self.fallbackTolerance = fallbackTolerance
        self.onFallback = onFallback
        self.subdivisionBudget = subdivisionBudget
    }

    /// The `PathOpsOptions` part.
    public var pathOps: PathOpsOptions {
        PathOpsOptions(epsilon: epsilon, fallback: fallback, fallbackTolerance: fallbackTolerance, onFallback: onFallback, subdivisionBudget: subdivisionBudget)
    }
}

private let DEFAULT_TOLERANCE = 0.01

@inline(__always) private func normal(_ t: Point) -> Point { Point(-t[1], t[0]) }

/// A quadratic raised to a cubic (other segments copied).
private func raise(_ seg: BezierSegment) -> [Point] {
    if seg.count != 3 { return seg }
    let p0 = seg[0], p1 = seg[1], p2 = seg[2]
    return [
        p0,
        Point(p0[0] + (2.0 / 3.0) * (p1[0] - p0[0]), p0[1] + (2.0 / 3.0) * (p1[1] - p0[1])),
        Point(p2[0] + (2.0 / 3.0) * (p1[0] - p2[0]), p2[1] + (2.0 / 3.0) * (p1[1] - p2[1])),
        p2,
    ]
}

private func isDegenerate(_ seg: BezierSegment, _ tol: Double) -> Bool {
    seg.allSatisfy { dist($0, seg[0]) <= tol }
}

// MARK: - Offsetting segments

private let OFFSET_SAMPLES: [Double] = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]

/// Appends cubic / line approximations of the curve offset by `d` (left in a y-up frame).
private func offsetSegment(_ seg: BezierSegment, _ d: Double, _ tol: Double, _ out: inout [[Point]], _ depth: Int = 0) {
    if seg.count == 2 {
        let n = normal(segmentTangent(seg, 0))
        out.append([add(seg[0], scale(n, d)), add(seg[1], scale(n, d))])
        return
    }
    let c = raise(seg)
    let t0 = segmentTangent(c, 0)
    let t1 = segmentTangent(c, 1)
    let q0 = add(c[0], scale(normal(t0), d))
    let q3 = add(c[3], scale(normal(t1), d))
    let k0 = segmentCurvature(c, 0)
    let k1 = segmentCurvature(c, 1)
    let f0 = k0.isFinite ? 1 - d * k0 : 1
    let f1 = k1.isFinite ? 1 - d * k1 : 1
    let q1 = add(q0, scale(sub(c[1], c[0]), f0))
    let q2 = add(q3, scale(sub(c[2], c[3]), f1))
    let approx: [Point] = [q0, q1, q2, q3]
    if depth < 10 {
        var err = 0.0
        for t in OFFSET_SAMPLES {
            let target = add(segmentPoint(c, t), scale(normal(segmentTangent(c, t)), d))
            err = jmax(err, segmentNearest(approx, target).distance)
            if err > tol { break }
        }
        // The approximation must not wander off either: check its midpoint against the curve.
        if err <= tol {
            let m = segmentPoint(approx, 0.5)
            let back = segmentNearest(c, m).distance
            err = jmax(err, abs(back - abs(d)))
        }
        if err > tol {
            let (a, b) = splitSegment(c, 0.5)
            offsetSegment(a, d, tol, &out, depth + 1)
            offsetSegment(b, d, tol, &out, depth + 1)
            return
        }
    }
    out.append(approx)
}

/// Appends a circular arc (center, radius, start angle, sweep) as cubics, at most 90° each.
private func pushArc(_ out: inout [[Point]], _ center: Point, _ radius: Double, _ start: Double, _ sweep: Double, _ from: Point, _ to: Point) {
    // A Double count: NaN draws nothing, as `i < NaN` in the TS.
    let n = jmax(1, JS.ceil(abs(sweep) / (PI / 2) - 1e-9))
    let step = sweep / n
    let k = (4.0 / 3.0) * jtan(step / 4)
    var prev = from
    var i = 0.0
    while i < n {
        let a0 = start + step * i
        let a1 = a0 + step
        let c0 = JS.cos(a0)
        let s0 = JS.sin(a0)
        let c1 = JS.cos(a1)
        let s1 = JS.sin(a1)
        let end: Point = i == n - 1 ? to : Point(center[0] + radius * c1, center[1] + radius * s1)
        out.append([
            prev,
            Point(center[0] + radius * (c0 - k * s0), center[1] + radius * (s0 + k * c0)),
            Point(center[0] + radius * (c1 + k * s1), center[1] + radius * (s1 - k * c1)),
            end,
        ])
        prev = end
        i += 1
    }
}

private func lineTo(_ out: inout [[Point]], _ from: Point, _ to: Point) {
    if !samePoint(from, to) { out.append([from, to]) }
}

private struct JoinStyle {
    var join: StrokeJoin
    var miterLimit: Double
}

/// Joins the offset at vertex `p` from the incoming tangent `tin` to the outgoing `tout`.
private func addJoin(_ out: inout [[Point]], _ p: Point, _ tin: Point, _ tout: Point, _ d: Double, _ style: JoinStyle) {
    let from = add(p, scale(normal(tin), d))
    let to = add(p, scale(normal(tout), d))
    let turn = cross(tin, tout)
    let cos = dot(tin, tout)
    if abs(turn) < 1e-9 && cos > 0 {
        lineTo(&out, from, to)
        return
    }
    let reversal = abs(turn) < 1e-9 && cos < 0
    let inner = !reversal && (turn > 0) == (d > 0)
    if inner {
        lineTo(&out, from, p)
        lineTo(&out, p, to)
        return
    }
    let theta = reversal ? (d > 0 ? -PI : PI) : JS.atan2(turn, cos)
    if style.join == .round {
        let v = sub(from, p)
        pushArc(&out, p, abs(d), JS.atan2(v[1], v[0]), theta, from, to)
        return
    }
    if style.join == .miter && !reversal {
        // Miter length / width = 1 / sin(φ / 2), φ the angle between the segments.
        let phi = PI - abs(theta)
        let ratio = 1 / jmax(JS.sin(phi / 2), 1e-12)
        if ratio <= style.miterLimit {
            let nin = normal(tin)
            let nout = normal(tout)
            let s = d / (1 + dot(nin, nout))
            let miter = add(p, scale(add(nin, nout), s))
            lineTo(&out, from, miter)
            lineTo(&out, miter, to)
            return
        }
    }
    lineTo(&out, from, to)
}

/// One side of a segment chain offset by `d`, with joins; closed chains join their ends too.
private func offsetChain(_ segs: [BezierSegment], _ d: Double, _ closed: Bool, _ style: JoinStyle, _ tol: Double) -> [[Point]] {
    var out: [[Point]] = []
    func pen() -> Point? {
        guard let last = out.last else { return nil }
        return last[last.count - 1]
    }
    for i in 0..<segs.count {
        if i > 0 { addJoin(&out, segs[i][0], segmentTangent(segs[i - 1], 1), segmentTangent(segs[i], 0), d, style) }
        var pieces: [[Point]] = []
        offsetSegment(segs[i], d, tol, &pieces)
        for piece in pieces {
            if let at = pen(), !samePoint(at, piece[0]) { lineTo(&out, at, piece[0]) }
            out.append(piece)
        }
    }
    if closed && segs.count > 0 {
        let last = segs[segs.count - 1]
        addJoin(&out, segs[0][0], segmentTangent(last, 1), segmentTangent(segs[0], 0), d, style)
        if let at = pen(), out.count > 0, !samePoint(at, out[0][0]) { lineTo(&out, at, out[0][0]) }
    }
    return out
}

private func reverseChain(_ chain: [[Point]]) -> [[Point]] {
    chain.map { Array($0.reversed()) }.reversed()
}

private func addCap(_ out: inout [[Point]], _ p: Point, _ t: Point, _ h: Double, _ cap: StrokeCap) {
    // From p + h·n (left) round the end to p − h·n (right), t pointing out of the stroke.
    let n = normal(t)
    let from = add(p, scale(n, h))
    let to = add(p, scale(n, -h))
    if cap == .round {
        pushArc(&out, p, h, JS.atan2(n[1], n[0]), -PI, from, to)
    } else if cap == .square {
        let a = add(from, scale(t, h))
        let b = add(to, scale(t, h))
        lineTo(&out, from, a)
        lineTo(&out, a, b)
        lineTo(&out, b, to)
    } else {
        lineTo(&out, from, to)
    }
}

/// Closed outline rings painting a dot (zero-length dash or subpath) with a cap.
private func dotRings(_ p: Point, _ t: Point, _ h: Double, _ cap: StrokeCap) -> [[[Point]]] {
    if cap == .butt { return [] }
    var ring: [[Point]] = []
    addCap(&ring, p, t, h, cap)
    addCap(&ring, p, Point(-t[0], -t[1]), h, cap)
    return [ring]
}

private struct StrokeStyle {
    var join: JoinStyle
    var cap: StrokeCap
}

/// Raw outline rings (overlapping, to be filled with `nonzero`) of one subpath.
private func strokeContour(_ contour: BezierContour, _ h: Double, _ style: StrokeStyle, _ tol: Double) -> [[[Point]]] {
    let tiny = jmax(1e-12, tol * 1e-6)
    let all = contour.closed ? closeContour(contour) : contour.segments
    let segs = all.filter { !isDegenerate($0, tiny) }
    if segs.isEmpty {
        guard let first = contour.segments.first, let p = first.first else { return [] }
        return dotRings(p, Point(1, 0), h, style.cap)
    }
    if contour.closed {
        let left = offsetChain(segs, h, true, style.join, tol)
        let right = offsetChain(segs, -h, true, style.join, tol)
        return [left, reverseChain(right)]
    }
    let left = offsetChain(segs, h, false, style.join, tol)
    let right = reverseChain(offsetChain(segs, -h, false, style.join, tol))
    var ring: [[Point]] = left
    let last = segs[segs.count - 1]
    addCap(&ring, last[last.count - 1], segmentTangent(last, 1), h, style.cap)
    func joinTo(_ p: Point) {
        let tail = ring[ring.count - 1]
        let at = tail[tail.count - 1]
        lineTo(&ring, at, p)
    }
    if right.count > 0 { joinTo(right[0][0]) }
    ring.append(contentsOf: right)
    let first = segs[0]
    let t0 = segmentTangent(first, 0)
    addCap(&ring, first[0], Point(-t0[0], -t0[1]), h, style.cap)
    if ring.count > 0 { joinTo(ring[0][0]) }
    return [ring]
}

private func ringsToPath(_ rings: [[[Point]]]) -> BezierPath {
    contoursToPath(rings.filter { !$0.isEmpty }.map { BezierContour(segments: $0, closed: true) })
}

// MARK: - Dashes

/// More dashes than this draws the line solid (a tiny pattern on a long path).
private let MAX_DASHES = 200_000.0
private let MIN_ENTRY = 1e-6

/// Dashes of a path: open subpaths and zero-length dots.
public struct DashedPath: Sendable {
    /// A zero-length dash: where it sits and the path direction there.
    public struct Dot: Equatable, Sendable {
        public var point: PathPoint
        public var tangent: PathPoint
        public init(point: PathPoint, tangent: PathPoint) {
            self.point = point
            self.tangent = tangent
        }
    }

    /// The dashes, as open subpaths.
    public var contours: [BezierContour]
    /// Zero-length dashes.
    public var dots: [Dot]
    public init(contours: [BezierContour], dots: [Dot]) {
        self.contours = contours
        self.dots = dots
    }
}

private struct DashChain {
    var segs: [BezierSegment]
    var lengths: [Double]
    var total: Double
    var closed: Bool
}

private struct DashSpan {
    var from: Double
    var to: Double
}

/// Applies a dash pattern (SVG `stroke-dasharray` / `stroke-dashoffset` semantics) to the
/// subpaths. Returns `nil` when the pattern is invalid (negative or non-finite entries),
/// has no positive entry, or would make more than 200,000 dashes: the line is solid.
public func dashContours(_ contours: [BezierContour], _ pattern: [Double], _ offset: Double = 0) -> DashedPath? {
    if pattern.isEmpty || pattern.contains(where: { !$0.isFinite || $0 < 0 }) || !offset.isFinite { return nil }
    if !pattern.contains(where: { $0 > MIN_ENTRY }) { return nil }
    let pat = pattern.count % 2 == 1 ? pattern + pattern : pattern
    let period = pat.reduce(0.0) { $0 + $1 }
    let chains = contours.map { c -> DashChain in
        let segs = closeContour(c)
        let lengths = segs.map { segmentLength($0) }
        return DashChain(segs: segs, lengths: lengths, total: lengths.reduce(0.0) { $0 + $1 }, closed: c.closed)
    }
    let totalLength = chains.reduce(0.0) { $0 + $1.total }
    if (totalLength / period) * Double(pat.count) > MAX_DASHES { return nil }
    // JS `%` is a truncating remainder.
    var off = (offset.truncatingRemainder(dividingBy: period) + period).truncatingRemainder(dividingBy: period)
    var ix0 = 0
    while off > pat[ix0] {
        off -= pat[ix0]
        ix0 = (ix0 + 1) % pat.count
    }
    var out = DashedPath(contours: [], dots: [])
    for chain in chains {
        if chain.segs.isEmpty || !(chain.total > 0) { continue }
        var ix = ix0
        var rem = pat[ix0] - off
        var pos = 0.0
        var dashes: [DashSpan] = []
        var guardCount = 0.0
        while pos < chain.total {
            let g = guardCount
            guardCount += 1
            if !(g < MAX_DASHES * 2) { break }
            let step = jmin(rem, chain.total - pos)
            let on = ix % 2 == 0
            if on { dashes.append(DashSpan(from: pos, to: pos + step)) }
            pos += step
            rem -= step
            if rem <= 1e-12 {
                ix = (ix + 1) % pat.count
                rem = pat[ix]
            }
        }
        // A closed subpath's last dash runs on into its first one.
        if chain.closed && dashes.count > 1 {
            let first = dashes[0]
            let last = dashes[dashes.count - 1]
            if first.from <= 1e-9 && last.to >= chain.total - 1e-9 && first.to > first.from && last.to > last.from {
                dashes.removeLast()
                let tail = trimSegments(chain.segs, last.from, chain.total, chain.lengths)
                let head = trimSegments(chain.segs, 0, first.to, chain.lengths)
                dashes.removeFirst()
                out.contours.append(BezierContour(segments: tail + head, closed: false))
            }
        }
        for dash in dashes {
            if dash.to - dash.from <= 1e-12 {
                out.dots.append(locate(chain.segs, chain.lengths, dash.from))
                continue
            }
            let segments = trimSegments(chain.segs, dash.from, dash.to, chain.lengths)
            if segments.count > 0 { out.contours.append(BezierContour(segments: segments, closed: false)) }
        }
    }
    return out
}

private func locate(_ segs: [BezierSegment], _ lengths: [Double], _ at: Double) -> DashedPath.Dot {
    var acc = 0.0
    for i in 0..<segs.count {
        if at <= acc + lengths[i] || i == segs.count - 1 {
            let piece = trimSegments([segs[i]], 0, jmax(0, at - acc), [lengths[i]])
            let t: Double = piece.count > 0 ? 1 : 0
            let point = piece.count > 0 ? piece[piece.count - 1][piece[piece.count - 1].count - 1] : segs[i][0]
            let tangent = segmentTangent(piece.count > 0 ? piece[piece.count - 1] : segs[i], t)
            return DashedPath.Dot(point: point, tangent: tangent)
        }
        acc += lengths[i]
    }
    return DashedPath.Dot(point: segs[0][0], tangent: segmentTangent(segs[0], 0))
}

// MARK: - Result cleanup

private let DEEP_ROWS: [Double] = [0.5, 0.3, 0.7, 0.15, 0.85]

/// A point deep inside a face (ring plus its direct child rings): the middle of its widest span.
private func deepPoint(_ rings: [[BezierSegment]]) -> Point? {
    var minX = Double.infinity
    var minY = Double.infinity
    var maxX = -Double.infinity
    var maxY = -Double.infinity
    for seg in rings[0] {
        for p in seg {
            minX = jmin(minX, p[0])
            maxX = jmax(maxX, p[0])
            minY = jmin(minY, p[1])
            maxY = jmax(maxY, p[1])
        }
    }
    let w = maxX - minX
    let h = maxY - minY
    if !(w > 0 && h > 0) { return nil }
    let tolerance = jmax(1e-6, 0.002 * jmin(w, h))
    let polys = rings.map { flattenChain($0, tolerance) }
    var best: (span: Double, p: Point)? = nil
    for f in DEEP_ROWS {
        let y = minY + h * f
        var xs: [Double] = []
        for poly in polys {
            for i in 0..<poly.count {
                let a = poly[i]
                let b = poly[(i + 1) % poly.count]
                if (a[1] <= y) != (b[1] <= y) { xs.append(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) }
            }
        }
        xs.jsSort { p, q in p - q }
        var i = 0
        while i + 1 < xs.count {
            let span = xs[i + 1] - xs[i]
            if best == nil || span > best!.span { best = (span, Point((xs[i] + xs[i + 1]) / 2, y)) }
            i += 2
        }
    }
    return best?.p
}

/// Keeps the faces that `spurious` does not flag (a flagged face drops its descendants too).
private func dropSpurious(_ rings: [NestedRing], _ spurious: ([[BezierSegment]], NestedRing) -> Bool) -> BezierPath {
    var children = rings.map { _ in [Int]() }
    for (i, r) in rings.enumerated() where r.parent >= 0 { children[r.parent].append(i) }
    let marked = rings.enumerated().map { i, r in spurious([r.segments] + children[i].map { rings[$0].segments }, r) }
    func hasMarkedAncestor(_ i: Int) -> Bool {
        var k = i
        while k >= 0 {
            if marked[k] { return true }
            k = rings[k].parent
        }
        return false
    }
    return nestedRingsToPath(rings) { !hasMarkedAncestor($0) }
}

/// Merges runs of tangent-continuous curve segments that one cubic fits within `tolerance`
/// (the stroker's many small offset pieces), keeping corners.
private func mergeSmoothRuns(_ path: BezierPath, _ tolerance: Double) -> BezierPath {
    func smooth(_ a: BezierSegment, _ b: BezierSegment) -> Bool {
        if a.count != 4 || b.count != 4 { return false }
        let ta = segmentTangent(a, 1)
        let tb = segmentTangent(b, 0)
        return dot(ta, tb) > 0.9998 && abs(cross(ta, tb)) < 0.02
    }
    let contours = pathToContours(.commands(path)).map { contour -> BezierContour in
        let segs = closeContour(contour, true).map { $0.count == 3 ? raise($0) : $0 }
        let n = segs.count
        if n < 2 { return BezierContour(segments: segs, closed: true) }
        var start = 0
        for k in 0..<n where !smooth(segs[(k + n - 1) % n], segs[k]) {
            start = k
            break
        }
        let ordered = Array(segs[start...]) + Array(segs[..<start])
        var out: [BezierSegment] = []
        var i = 0
        while i < ordered.count {
            var current = ordered[i]
            var j = i + 1
            while j < ordered.count && smooth(ordered[j - 1], ordered[j]) {
                let run = Array(ordered[i...j])
                var pts: [Point] = []
                for (k, s) in run.enumerated() {
                    var q = k == 0 ? 0 : 1
                    while q <= 12 {
                        pts.append(segmentPoint(s, Double(q) / 12))
                        q += 1
                    }
                }
                let fit = fitCubicRun(pts, tolerance, segmentTangent(run[0], 0), segmentTangent(run[run.count - 1], 1))
                if fit.count != 1 { break }
                let c = fit[0]
                current = [run[0][0], c.p1, c.p2, run[run.count - 1][3]]
                j += 1
            }
            out.append(current)
            i = j
        }
        return BezierContour(segments: out, closed: true)
    }
    return contoursToPath(contours)
}

// MARK: - Public operations

private func joinStyle(_ join: StrokeJoin?, _ miterLimit: Double?) -> JoinStyle {
    JoinStyle(
        join: join ?? .miter,
        miterLimit: miterLimit != nil && miterLimit!.isFinite ? jmax(1, miterLimit!) : 4
    )
}

/// `options.tolerance && options.tolerance > 0 ? options.tolerance : DEFAULT_TOLERANCE`.
private func toleranceOf(_ tolerance: Double?) -> Double {
    if let t = tolerance, t > 0 { return t }
    return DEFAULT_TOLERANCE
}

/// The raw (overlapping) outline of a stroke as closed subpaths to fill with `nonzero`.
/// `outlineStroke` normalises it; this is useful for previews.
public func strokeOutlineRings(_ input: BezierPathInput, _ options: OutlineStrokeOptions) -> BezierPath {
    let h = options.width / 2
    if !(h > 0) || !h.isFinite { return [] }
    let tol = toleranceOf(options.tolerance)
    let style = StrokeStyle(join: joinStyle(options.join, options.miterLimit), cap: options.cap ?? .butt)
    var contours = pathToContours(input)
    var rings: [[[Point]]] = []
    if let dash = options.dash, dash.count > 0 {
        if let dashed = dashContours(contours, dash, options.dashOffset ?? 0) {
            contours = dashed.contours
            for dot in dashed.dots { rings.append(contentsOf: dotRings(dot.point, dot.tangent, h, style.cap)) }
        }
    }
    for contour in contours { rings.append(contentsOf: strokeContour(contour, h, style, tol)) }
    return ringsToPath(rings)
}

/// Whether any coordinate of a non-`Z` command is non-finite (`Object.values(c)` in the TS).
private func hasNonFinite(_ c: PathCommand) -> Bool {
    switch c {
    case let .M(x, y), let .L(x, y): return !x.isFinite || !y.isFinite
    case let .Q(x1, y1, x, y): return ![x1, y1, x, y].allSatisfy { $0.isFinite }
    case let .C(x1, y1, x2, y2, x, y): return ![x1, y1, x2, y2, x, y].allSatisfy { $0.isFinite }
    case let .A(rx, ry, rotation, _, _, x, y): return ![rx, ry, rotation, x, y].allSatisfy { $0.isFinite }
    case .Z: return false
    }
}

/// Outline Stroke: the filled area painted by stroking `path`, as one clean path (overlaps
/// removed, consistently oriented). Joins, caps, miter limit and dashes follow SVG. Throws
/// a `PathOpsError` only with `fallback: false`.
public func outlineStroke(_ input: BezierPathInput, _ options: OutlineStrokeOptions) throws -> BezierPath {
    let h = options.width / 2
    if !(h > 0) || !h.isFinite { return [] }
    // The TS guards this with try/catch; the Swift conversion does not throw.
    let source = contoursToPath(pathToContours(input))
    if source.contains(where: hasNonFinite) { return [] }
    let raw = strokeOutlineRings(.commands(source), options)
    if raw.isEmpty { return [] }
    let tol = toleranceOf(options.tolerance)
    let sourceContours = pathToContours(.commands(source))
    let operand = PathOperand(.commands(raw), fillRule: .nonzero)
    let pathOps = options.pathOps
    do {
        let rings = try pathBooleanRings(.union, [operand], pathOps)
        let cleaned = dropSpurious(rings) { face, ring in
            if ring.area >= 0 { return false }
            guard let p = deepPoint(face) else { return false }
            return distanceToBezierPath(sourceContours, p) < h * (1 - 1e-4) - 1e-6
        }
        return mergeSmoothRuns(cleaned, tol)
    } catch {
        return try pathBoolean(.union, [operand], pathOps).path
    }
}

/// Offset Path: grows (`distance > 0`) or shrinks (`distance < 0`) the filled area by
/// `distance`. Closed subpaths are a filled region (read with `fillRule`); open subpaths are
/// outlined with a stroke of width `2·|distance|` and butt caps (when growing). Loops of the
/// offset curves are removed. Throws a `PathOpsError` only with `fallback: false`.
public func offsetPath(_ input: BezierPathInput, _ distance: Double, _ options: OffsetPathOptions = .init()) throws -> BezierPath {
    if !distance.isFinite { return [] }
    let contours = pathToContours(input)
    if contours.contains(where: { $0.segments.contains(where: { $0.contains(where: { !$0[0].isFinite || !$0[1].isFinite }) }) }) { return [] }
    let closed = contours.filter { $0.closed && $0.segments.count > 0 }
    let open = contours.filter { !$0.closed && $0.segments.count > 0 }
    let fillRule = options.fillRule ?? .nonzero
    let fill = PathOperand(.commands(contoursToPath(closed)), fillRule: fillRule)
    let d = abs(distance)
    let tol = toleranceOf(options.tolerance)
    let pathOps = options.pathOps
    if d == 0 { return try pathBoolean(.union, [fill], pathOps).path }
    let strokeOptions = OutlineStrokeOptions(width: 2 * d, join: options.join ?? .miter, cap: .butt, miterLimit: options.miterLimit, tolerance: tol)
    let ring = PathOperand(.commands(strokeOutlineRings(.commands(contoursToPath(closed)), strokeOptions)), fillRule: .nonzero)
    let openRing = PathOperand(
        .commands(distance > 0 ? strokeOutlineRings(.commands(contoursToPath(open)), strokeOptions) : []),
        fillRule: .nonzero
    )
    let grow = distance > 0
    let operands = [fill, ring, openRing]
    do {
        let isInside: ([Bool]) -> Bool = grow ? { m in m[0] || m[1] || m[2] } : { m in m[0] && !m[1] }
        let rings = try pathBooleanRings(isInside, operands, pathOps)
        let sourceContours = contours
        let cleaned = dropSpurious(rings) { face, r in
            if grow ? r.area >= 0 : r.area <= 0 { return false }
            guard let p = deepPoint(face) else { return false }
            return distanceToBezierPath(sourceContours, p) < d * (1 - 1e-4) - 1e-6
        }
        return mergeSmoothRuns(cleaned, tol)
    } catch {
        return grow
            ? try pathBoolean(.union, operands, pathOps).path
            : try pathBoolean(.difference, [fill, ring], pathOps).path
    }
}
