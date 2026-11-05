import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Knife and eraser on Bézier paths (`vector/pathCut.ts`), built on the curve booleans and
// `outlineStroke`: the knife cuts filled regions along a polyline with no gap, the eraser
// removes a round-capped stroke's area from fills and cuts outlines where they pass under it.

// MARK: - Faces: an outer loop with its holes

private final class Loop {
    var segs: [BezierSegment]
    /// Which segments came from a knife chord (not sampled for containment).
    var chord: [Bool]
    init(segs: [BezierSegment], chord: [Bool]) {
        self.segs = segs
        self.chord = chord
    }
    var area: Double { contourSignedArea(segs) }
}

private struct Face {
    var loops: [Loop]
}

/// A point on the loop that is not on a chord.
private func loopSample(_ l: Loop) -> PathPoint {
    let k = l.chord.firstIndex(of: false) ?? 0
    return segmentPoint(l.segs[k], 0.5)
}

private func contains(_ l: Loop, _ p: PathPoint) -> Bool { windingNumber([l.segs], p) != 0 }

private func sign(_ x: Double) -> Double { x > 0 ? 1 : x < 0 ? -1 : x }

/// Groups non-crossing loops into faces: loops turning like the largest one are outlines, the
/// others holes of the smallest outline around them.
private func groupFaces(_ loops: [Loop]) -> [Face] {
    let usable = loops.filter { !$0.segs.isEmpty && abs($0.area) > 1e-12 }
    if usable.isEmpty { return [] }
    let largest = usable.dropFirst().reduce(usable[0]) { a, b in abs(b.area) > abs(a.area) ? b : a }
    let s = sign(largest.area)
    let outers = jsSorted(usable.filter { sign($0.area) == s }) { abs($0.area) - abs($1.area) }
    var faces: [ObjectIdentifier: Face] = [:]
    for o in outers { faces[ObjectIdentifier(o)] = Face(loops: [o]) }
    for hole in usable where sign(hole.area) != s {
        let p = loopSample(hole)
        if let parent = outers.first(where: { abs($0.area) > abs(hole.area) && contains($0, p) }) { faces[ObjectIdentifier(parent)]!.loops.append(hole) }
    }
    return outers.reversed().map { faces[ObjectIdentifier($0)]! }
}

private func faceToPath(_ face: Face) -> BezierPath {
    contoursToPath(face.loops.map { BezierContour(segments: $0.segs, closed: true) })
}

/// Simple, consistently oriented faces of a filled path.
private func facesOf(_ path: BezierPathInput, _ fillRule: PolygonFillRule) throws -> [Face] {
    let normalized = try normalizeBezierPath(path, fillRule)
    let loops = pathToContours(.commands(normalized)).map { c -> Loop in
        let segs = closeContour(c, true)
        return Loop(segs: segs, chord: segs.map { _ in false })
    }
    return groupFaces(loops)
}

/// One path per face (an outline with its holes) of a filled path, largest first.
func splitIntoFaces(_ path: BezierPathInput, _ fillRule: PolygonFillRule = .nonzero) throws -> [BezierPath] {
    try facesOf(path, fillRule).map(faceToPath)
}

// MARK: - Line × segment crossings

/// Real roots in [0, 1] of `a·t³ + b·t² + c·t + d` (monotone pieces, bisection).
private func rootsInUnit(_ a: Double, _ b: Double, _ c: Double, _ d: Double, _ scale: Double) -> [Double] {
    func f(_ t: Double) -> Double { ((a * t + b) * t + c) * t + d }
    let tol = 1e-12 * JS.max(1, scale)
    var cuts = [0.0]
    let qa = 3 * a
    let qb = 2 * b
    if abs(qa) > 1e-18 {
        let disc = qb * qb - 4 * qa * c
        if disc >= 0 {
            let r = disc.squareRoot()
            for t in jsSorted([(-qb - r) / (2 * qa), (-qb + r) / (2 * qa)], { $0 - $1 }) where t > 0 && t < 1 { cuts.append(t) }
        }
    } else if abs(qb) > 1e-18 {
        let t = -c / qb
        if t > 0 && t < 1 { cuts.append(t) }
    }
    cuts.append(1)
    var roots: [Double] = []
    func push(_ t: Double) {
        if !roots.contains(where: { abs($0 - t) < 1e-9 }) { roots.append(t) }
    }
    for i in 0 ..< (cuts.count - 1) {
        var lo = cuts[i]
        var hi = cuts[i + 1]
        var flo = f(lo)
        let fhi = f(hi)
        if abs(flo) <= tol { push(lo) }
        if abs(fhi) <= tol { push(hi) }
        if flo * fhi >= 0 { continue }
        for _ in 0 ..< 80 {
            let m = (lo + hi) / 2
            let fm = f(m)
            if fm == 0 {
                lo = m
                hi = m
                break
            }
            if fm * flo < 0 {
                hi = m
            } else {
                lo = m
                flo = fm
            }
        }
        push((lo + hi) / 2)
    }
    return jsSorted(roots) { $0 - $1 }
}

private struct LineHit {
    var s: Double
    var t: Double
    var point: PathPoint
}

/// Where the line `p → q` crosses a segment: `s` on the line (0–1), `t` on the segment.
private func lineHits(_ p: PathPoint, _ q: PathPoint, _ seg: BezierSegment) -> [LineHit] {
    let dx = q[0] - p[0]
    let dy = q[1] - p[1]
    let len2 = dx * dx + dy * dy
    if len2 < 1e-24 { return [] }
    func h(_ pt: PathPoint) -> Double { (pt[0] - p[0]) * -dy + (pt[1] - p[1]) * dx }
    let coeffs: [Double]
    if seg.count == 2 {
        coeffs = [0, 0, h(seg[1]) - h(seg[0]), h(seg[0])]
    } else {
        let hs = seg.map(h)
        let (h0, h1, h2, h3) = (hs[0], hs[1], hs[2], hs[3])
        coeffs = [-h0 + 3 * h1 - 3 * h2 + h3, 3 * h0 - 6 * h1 + 3 * h2, -3 * h0 + 3 * h1, h0]
    }
    if coeffs.allSatisfy({ abs($0) < 1e-12 * JS.max(1, len2) }) { return [] }
    let scale = len2.squareRoot() * seg.reduce(1) { JS.max($0, abs($1[0]) + abs($1[1])) }
    var out: [LineHit] = []
    for t in rootsInUnit(coeffs[0], coeffs[1], coeffs[2], coeffs[3], scale) {
        let point = segmentPoint(seg, t)
        let s = ((point[0] - p[0]) * dx + (point[1] - p[1]) * dy) / len2
        if s >= -1e-9 && s <= 1 + 1e-9 { out.append(LineHit(s: JS.min(1, JS.max(0, s)), t: t, point: point)) }
    }
    return out
}

// MARK: - Knife

private struct Hit {
    var s: Double
    var loop: Int
    var seg: Int
    var t: Double
    var point: PathPoint
}

private func near(_ a: PathPoint, _ b: PathPoint, _ eps: Double) -> Bool { abs(a[0] - b[0]) <= eps && abs(a[1] - b[1]) <= eps }
private func degenerate(_ seg: BezierSegment, _ eps: Double) -> Bool { seg.allSatisfy { near($0, seg[0], eps) } }

/// The loop's pieces from (seg a, t a) forward to (seg b, t b).
private func arc(_ l: Loop, _ a: (seg: Int, t: Double), _ b: (seg: Int, t: Double), _ eps: Double) -> (segs: [BezierSegment], chord: [Bool]) {
    let n = l.segs.count
    var segs: [BezierSegment] = []
    var chord: [Bool] = []
    func push(_ k: Int, _ t0: Double, _ t1: Double) {
        let piece = t0 <= 0 && t1 >= 1 ? l.segs[k] : subSegment(l.segs[k], t0, t1)
        if !degenerate(piece, eps) {
            segs.append(piece)
            chord.append(l.chord[k])
        }
    }
    if a.seg == b.seg && b.t >= a.t + 1e-12 {
        push(a.seg, a.t, b.t)
        return (segs, chord)
    }
    push(a.seg, a.t, 1)
    var k = (a.seg + 1) % n
    while k != b.seg {
        push(k, 0, 1)
        k = (k + 1) % n
    }
    push(b.seg, 0, b.t)
    return (segs, chord)
}

/// Line segments through `points`.
private func polySegs(_ points: [PathPoint], _ eps: Double) -> [BezierSegment] {
    var out: [BezierSegment] = []
    for i in 1 ..< Swift.max(1, points.count) where !near(points[i - 1], points[i], eps) { out.append([points[i - 1], points[i]]) }
    return out
}

/// Cuts the filled path along the open polyline `knife` (`knifePath`): one path per resulting
/// face, or nil when the knife crossed nothing from edge to edge.
func knifePath(_ path: BezierPathInput, _ fillRule: PolygonFillRule, _ knife: [PathPoint]) throws -> [BezierPath]? {
    let pts = knife.filter { $0[0].isFinite && $0[1].isFinite }
    if pts.count < 2 { return nil }
    var faces = try facesOf(path, fillRule)
    if faces.isEmpty { return nil }
    let b = bezierPathBounds(path)
    let size = b.map { JS.max(JS.max($0.maxX - $0.minX, $0.maxY - $0.minY), 1) } ?? 1
    let eps = size * 1e-9
    var cursor = -Double.infinity
    var cuts = 0
    for _ in 0 ..< 512 {
        var best: (face: Int, from: Hit, to: Hit)?
        for (fi, face) in faces.enumerated() {
            var hits: [Hit] = []
            for m in 0 ..< (pts.count - 1) {
                if Double(m + 1) < cursor - 1e-9 { continue }
                let kb = (minX: JS.min(pts[m][0], pts[m + 1][0]), maxX: JS.max(pts[m][0], pts[m + 1][0]), minY: JS.min(pts[m][1], pts[m + 1][1]), maxY: JS.max(pts[m][1], pts[m + 1][1]))
                for (li, l) in face.loops.enumerated() {
                    for (si, seg) in l.segs.enumerated() {
                        let sb = segmentBounds(seg)
                        if sb.maxX < kb.minX - eps || sb.minX > kb.maxX + eps || sb.maxY < kb.minY - eps || sb.minY > kb.maxY + eps { continue }
                        for h in lineHits(pts[m], pts[m + 1], seg) {
                            let s = Double(m) + h.s
                            if s >= cursor - 1e-9 { hits.append(Hit(s: s, loop: li, seg: si, t: h.t, point: h.point)) }
                        }
                    }
                }
            }
            hits = jsSorted(hits) { $0.s - $1.s }
            var unique: [Hit] = []
            for (i, h) in hits.enumerated() where i == 0 || h.s - hits[i - 1].s > 1e-9 || !near(h.point, hits[i - 1].point, eps * 10) { unique.append(h) }
            func inside(_ s: Double) -> Bool {
                let m = Swift.min(pts.count - 2, Int(JS.floor(s)))
                let u = s - Double(m)
                let q = PathPoint(pts[m][0] + (pts[m + 1][0] - pts[m][0]) * u, pts[m][1] + (pts[m + 1][1] - pts[m][1]) * u)
                return windingNumber(face.loops.map(\.segs), q) != 0
            }
            if unique.count >= 2 {
                for i in 0 ..< (unique.count - 1) {
                    let from = unique[i]
                    let to = unique[i + 1]
                    if near(from.point, to.point, eps * 10) || !inside((from.s + to.s) / 2) { continue }
                    if best == nil || from.s < best!.from.s { best = (fi, from, to) }
                    break
                }
            }
        }
        guard let found = best else { break }
        let (fi, from, to) = found
        let face = faces[fi]
        var corners: [PathPoint] = [from.point]
        var m = Int(JS.floor(from.s)) + 1
        while Double(m) <= to.s - 1e-12 && m < pts.count {
            if Double(m) > from.s { corners.append(pts[m]) }
            m += 1
        }
        corners.append(to.point)
        let forward = polySegs(corners, eps)
        let back = polySegs(corners.reversed(), eps)
        let la = face.loops[from.loop]
        var loops = face.loops.enumerated().filter { $0.offset != from.loop && $0.offset != to.loop }.map(\.element)
        if from.loop == to.loop {
            let ab = arc(la, (from.seg, from.t), (to.seg, to.t), eps)
            let ba = arc(la, (to.seg, to.t), (from.seg, from.t), eps)
            loops.append(Loop(segs: ab.segs + back, chord: ab.chord + back.map { _ in true }))
            loops.append(Loop(segs: ba.segs + forward, chord: ba.chord + forward.map { _ in true }))
        } else {
            let lb = face.loops[to.loop]
            let roundA = arc(la, (from.seg, from.t), (from.seg, from.t), eps)
            let roundB = arc(lb, (to.seg, to.t), (to.seg, to.t), eps)
            loops.append(Loop(segs: roundA.segs + forward + roundB.segs + back, chord: roundA.chord + forward.map { _ in true } + roundB.chord + back.map { _ in true }))
        }
        faces = Array(faces[..<fi]) + groupFaces(loops) + Array(faces[(fi + 1)...])
        cursor = to.s
        cuts += 1
    }
    return cuts > 0 ? faces.map(faceToPath) : nil
}

// MARK: - Eraser

/// The area a round eraser of diameter `width` covers along `points` (a disc for one point).
func eraserRegion(_ points: [PathPoint], _ width: Double) throws -> BezierPath {
    let pts = points.filter { $0[0].isFinite && $0[1].isFinite }
    let r = width / 2
    if pts.isEmpty || !(r > 0) { return [] }
    let moved = pts.contains { !near($0, pts[0], 1e-9) }
    if !moved {
        let (cx, cy) = (pts[0][0], pts[0][1])
        let k = r * 0.5522847498307936
        return [
            .M(x: cx, y: cy - r),
            .C(x1: cx + k, y1: cy - r, x2: cx + r, y2: cy - k, x: cx + r, y: cy),
            .C(x1: cx + r, y1: cy + k, x2: cx + k, y2: cy + r, x: cx, y: cy + r),
            .C(x1: cx - k, y1: cy + r, x2: cx - r, y2: cy + k, x: cx - r, y: cy),
            .C(x1: cx - r, y1: cy - k, x2: cx - k, y2: cy - r, x: cx, y: cy - r),
            .Z,
        ]
    }
    let line: BezierPath = [.M(x: pts[0][0], y: pts[0][1])] + pts.dropFirst().map { .L(x: $0[0], y: $0[1]) }
    return try outlineStroke(.commands(line), OutlineStrokeOptions(width: width, join: .round, cap: .round))
}

/// A filled path with `region` removed: one path per remaining face, or nil when the region does
/// not overlap the fill.
func eraseFromFill(_ path: BezierPathInput, _ fillRule: PolygonFillRule, _ region: BezierPathInput) throws -> [BezierPath]? {
    let overlap = try pathBoolean(.intersection, [PathOperand(path, fillRule: fillRule), PathOperand(region)]).path
    if !pathToContours(.commands(overlap)).contains(where: { abs(contourSignedArea(closeContour($0, true))) > 1e-9 }) { return nil }
    let rest = try pathBoolean(.difference, [PathOperand(path, fillRule: fillRule), PathOperand(region)]).path
    return try splitIntoFaces(.commands(rest))
}

/// The parts of a subpath's outline outside `region`, as open subpaths that keep the original
/// curves exactly; nil when the outline does not enter the region (`eraseFromOutline`).
func eraseFromOutline(_ sp: VectorSubpath, _ region: BezierPathInput) -> [VectorSubpath]? {
    let regionSegs = pathToContours(region).flatMap { closeContour($0, true) }
    if regionSegs.isEmpty { return nil }
    let count = subpathSegmentCount(sp)
    guard let rb = bezierPathBounds(region), count > 0 else { return nil }
    func removed(_ p: PathPoint) -> Bool { pointInBezierPath(region, p, .nonzero) }
    var runs: [[(seg: Int, t0: Double, t1: Double)]] = []
    var cur: [(seg: Int, t0: Double, t1: Double)] = []
    var any = false
    for i in 0 ..< count {
        let seg = subpathSegment(sp, i)
        let sb = segmentBounds(seg)
        var ts = [0.0, 1.0]
        if !(sb.maxX < rb.minX || sb.minX > rb.maxX || sb.maxY < rb.minY || sb.minY > rb.maxY) {
            for r in regionSegs {
                let b = segmentBounds(r)
                if b.maxX < sb.minX || b.minX > sb.maxX || b.maxY < sb.minY || b.minY > sb.maxY { continue }
                for hit in segmentIntersections(seg, r) where hit.ta > 1e-9 && hit.ta < 1 - 1e-9 { ts.append(hit.ta) }
            }
        }
        ts = jsSorted(ts) { $0 - $1 }
        for k in 0 ..< (ts.count - 1) {
            let t0 = ts[k]
            let t1 = ts[k + 1]
            if t1 - t0 < 1e-9 { continue }
            if removed(segmentPoint(seg, (t0 + t1) / 2)) {
                any = true
                if !cur.isEmpty { runs.append(cur) }
                cur = []
            } else {
                cur.append((i, t0, t1))
            }
        }
    }
    if !cur.isEmpty { runs.append(cur) }
    if !any { return nil }
    if sp.closed && runs.count >= 2 {
        let first = runs[0][0]
        let lastRun = runs[runs.count - 1]
        let last = lastRun[lastRun.count - 1]
        if first.seg == 0 && first.t0 == 0 && last.seg == count - 1 && last.t1 == 1 {
            let head = runs.removeFirst()
            runs[runs.count - 1] += head
        }
    }
    var out: [VectorSubpath] = []
    for run in runs {
        var anchors: [VectorAnchor] = []
        for piece in run {
            let c = subSegment(subpathSegment(sp, piece.seg), piece.t0, piece.t1)
            let line = c.count == 2
            let start = c[0]
            let end = c[c.count - 1]
            if anchors.isEmpty { anchors.append(VectorAnchor(x: start[0], y: start[1])) }
            if !line { anchors[anchors.count - 1].out = Vec2(c[1][0], c[1][1]) }
            var next = VectorAnchor(x: end[0], y: end[1])
            if !line { next.in = Vec2(c[2][0], c[2][1]) }
            anchors.append(next)
        }
        if anchors.count < 2 { continue }
        for i in anchors.indices {
            let type = inferAnchorType(anchors[i])
            if type != .corner { anchors[i].type = type }
        }
        out.append(VectorSubpath(anchors: anchors, closed: false))
    }
    return out
}

/// Bounds of a point list (`polylineBounds`).
func polylineBounds(_ points: [Vec2], _ pad: Double = 0) -> VectorBounds? {
    if points.isEmpty { return nil }
    var minX = Double.infinity, minY = Double.infinity, maxX = -Double.infinity, maxY = -Double.infinity
    for p in points {
        minX = JS.min(minX, p.x)
        minY = JS.min(minY, p.y)
        maxX = JS.max(maxX, p.x)
        maxY = JS.max(maxY, p.y)
    }
    return VectorBounds(x: minX - pad, y: minY - pad, width: maxX - minX + 2 * pad, height: maxY - minY + 2 * pad)
}

/// Ramer–Douglas–Peucker reduction of a polyline, keeping both ends (`simplifyPolyline`).
func simplifyPolyline(_ points: [PathPoint], _ tolerance: Double) -> [PathPoint] {
    let n = points.count
    if n < 3 { return points }
    var keep = [Bool](repeating: false, count: n)
    keep[0] = true
    keep[n - 1] = true
    var stack: [(Int, Int)] = [(0, n - 1)]
    while let (a, b) = stack.popLast() {
        let ax = points[a][0], ay = points[a][1]
        let dx = points[b][0] - ax
        let dy = points[b][1] - ay
        let len = JS.hypot(dx, dy)
        var far = -1
        var farD = 0.0
        if a + 1 < b {
            for i in (a + 1) ..< b {
                let px = points[i][0], py = points[i][1]
                let d = len < 1e-12 ? JS.hypot(px - ax, py - ay) : abs((px - ax) * dy - (py - ay) * dx) / len
                if d > farD {
                    farD = d
                    far = i
                }
            }
        }
        if far >= 0 && farD > tolerance {
            keep[far] = true
            stack.append((a, far))
            stack.append((far, b))
        }
    }
    return points.enumerated().filter { keep[$0.offset] }.map(\.element)
}
