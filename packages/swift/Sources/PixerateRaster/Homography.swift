import Foundation

/**
 * Perspective (projective) maps between quadrilaterals, the maths `transformSurface` resamples
 * through. The port of `geom/homography.ts` (which `raster/transform.ts` imports). Pure maths;
 * degenerate or non-finite input gives `nil` instead of NaNs.
 *
 * Ported from ArtCraft (MIT OR Apache-2.0, © ArtCraft Team and contributors; see
 * THIRD_PARTY_NOTICES.md): pdfcraft `crates/geom/src/perspective.rs` and photocraft
 * `crates/algo/src/transform.rs`.
 */

/// A point.
public struct Vec2: Equatable, Hashable, Sendable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/// A box with fractional edges (`geom` `Box`).
public struct Box: Equatable, Hashable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
    public init(_ r: RasterRect) { self.init(x: Double(r.x), y: Double(r.y), width: Double(r.width), height: Double(r.height)) }
}

/// A row-major 3 × 3 projective map (source → destination, column vectors).
public typealias Homography = [Double]

/// An affine matrix in SVG order `[a, b, c, d, e, f]`.
public typealias AffineMatrix = [Double]

public let IDENTITY_HOMOGRAPHY: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/**
 * Gaussian elimination with partial pivoting on an 8×8 system (the 9th column of each row is the
 * right-hand side). Nil when the system is singular.
 */
public func solve8(_ rows: [[Double]]) -> [Double]? {
    var m = rows
    for col in 0..<8 {
        var pivot = col
        for r in (col + 1)..<8 where Swift.abs(m[r][col]) > Swift.abs(m[pivot][col]) { pivot = r }
        if !(Swift.abs(m[pivot][col]) >= 1e-12) { return nil }
        m.swapAt(col, pivot)
        let p = m[col]
        for r in 0..<8 where r != col {
            let f = m[r][col] / p[col]
            if f != 0 { for k in 0..<9 { m[r][k] -= f * p[k] } }
        }
    }
    var out: [Double] = []
    for i in 0..<8 {
        let v = m[i][8] / m[i][i]
        if !v.isFinite { return nil }
        out.append(v)
    }
    return out
}

/// The image of `p`, or nil where the map sends it to infinity.
public func applyHomography(_ h: Homography, _ p: Vec2) -> Vec2? {
    let w = h[6] * p.x + h[7] * p.y + h[8]
    if !w.isFinite || Swift.abs(w) < 1e-12 { return nil }
    let x = (h[0] * p.x + h[1] * p.y + h[2]) / w
    let y = (h[3] * p.x + h[4] * p.y + h[5]) / w
    return x.isFinite && y.isFinite ? Vec2(x: x, y: y) : nil
}

/// The homogeneous `w` of `p`: its sign is the side of the horizon `p` maps to (0 on it).
public func homographyW(_ h: Homography, _ p: Vec2) -> Double {
    h[6] * p.x + h[7] * p.y + h[8]
}

private func finite(_ p: Vec2) -> Bool { p.x.isFinite && p.y.isFinite }

/**
 * The projective map that takes each of `from` to the point at the same index of `to`. Nil when
 * three of either set are collinear or a coordinate is not finite.
 */
public func homographyFromPoints(_ from: [Vec2], _ to: [Vec2]) -> Homography? {
    if from.count != 4 || to.count != 4 || !(from + to).allSatisfy(finite) { return nil }
    var rows: [[Double]] = []
    for i in 0..<4 {
        let x = from[i].x, y = from[i].y
        let u = to[i].x, v = to[i].y
        rows.append([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
        rows.append([0, 0, 0, x, y, 1, -v * x, -v * y, v])
    }
    guard let h = solve8(rows) else { return nil }
    let out: Homography = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]
    // Collinear points can leave a solvable but singular system: check the map really takes the
    // four points where they should go.
    for i in 0..<4 {
        let q = to[i]
        let scale = 1 + JS.max(Swift.abs(q.x), Swift.abs(q.y))
        guard let r = applyHomography(out, from[i]), Swift.abs(r.x - q.x) <= 1e-6 * scale, Swift.abs(r.y - q.y) <= 1e-6 * scale else { return nil }
    }
    return out
}

/**
 * Whether `h` maps the whole convex quad `quad` without sending any of it through infinity (the
 * denominator keeps one sign over it): what a usable distortion needs.
 */
public func homographyKeepsQuad(_ h: Homography, _ quad: [Vec2]) -> Bool {
    let ws = quad.map { h[6] * $0.x + h[7] * $0.y + h[8] }
    return ws.allSatisfy { $0 > 1e-9 } || ws.allSatisfy { $0 < -1e-9 }
}

/**
 * The four corners in reading order for a y-down space: top-left, top-right, bottom-right,
 * bottom-left, whatever order they come in. Nil unless they form a convex quadrilateral with a
 * non-negligible area.
 */
public func orderQuad(_ points: [Vec2]) -> [Vec2]? {
    if points.count != 4 || !points.allSatisfy(finite) { return nil }
    let cx = points.reduce(0) { $0 + $1.x } / 4
    let cy = points.reduce(0) { $0 + $1.y } / 4
    // Ascending angle about the centre is clockwise on screen (y down).
    let q = points.enumerated().sorted { a, b in
        let d = JS.atan2(a.element.y - cy, a.element.x - cx) - JS.atan2(b.element.y - cy, b.element.x - cx)
        return d != 0 ? d < 0 : a.offset < b.offset
    }.map(\.element)
    var first = 0
    for i in 1..<4 where q[i].x + q[i].y < q[first].x + q[first].y { first = i }
    let ordered = Array(q[first...] + q[..<first])
    let cross = { (o: Vec2, a: Vec2, b: Vec2) in (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x) }
    let turns = (0..<4).map { cross(ordered[$0], ordered[($0 + 1) % 4], ordered[($0 + 2) % 4]) }
    let area = turns.reduce(0, +) / 2
    let xs = ordered.map(\.x)
    let ys = ordered.map(\.y)
    let size = JS.max(xs.max()! - xs.min()!, ys.max()! - ys.min()!)
    let convex = turns.allSatisfy { $0 > 1e-9 * size * size }
    return convex && area > 1e-6 * size * size ? ordered : nil
}

/// `a` then `b` (apply `a` first).
public func multiplyHomographies(_ a: Homography, _ b: Homography) -> Homography {
    // Row-major column-vector maps: (b ∘ a) = B · A.
    var r = [Double](repeating: 0, count: 9)
    for i in 0..<3 { for j in 0..<3 { r[i * 3 + j] = b[i * 3] * a[j] + b[i * 3 + 1] * a[3 + j] + b[i * 3 + 2] * a[6 + j] } }
    return r
}

/// The inverse map, or nil for a singular one.
public func invertHomography(_ m: Homography) -> Homography? {
    let c = [
        m[4] * m[8] - m[5] * m[7],
        m[2] * m[7] - m[1] * m[8],
        m[1] * m[5] - m[2] * m[4],
        m[5] * m[6] - m[3] * m[8],
        m[0] * m[8] - m[2] * m[6],
        m[2] * m[3] - m[0] * m[5],
        m[3] * m[7] - m[4] * m[6],
        m[1] * m[6] - m[0] * m[7],
        m[0] * m[4] - m[1] * m[3],
    ]
    let det = m[0] * c[0] + m[1] * c[3] + m[2] * c[6]
    if !(Swift.abs(det) >= 1e-12) || !det.isFinite { return nil }
    return c.map { $0 / det }
}

/// An affine matrix (SVG order) as a homography.
public func homographyFromAffine(_ m: AffineMatrix) -> Homography {
    [m[0], m[2], m[4], m[1], m[3], m[5], 0, 0, 1]
}

/// The affine matrix of `h` when it is affine (no perspective part), else nil.
public func affineFromHomography(_ h: Homography, _ eps: Double = 1e-12) -> AffineMatrix? {
    if Swift.abs(h[6]) > eps * Swift.abs(h[8]) || Swift.abs(h[7]) > eps * Swift.abs(h[8]) || h[8] == 0 || h[8].isNaN { return nil }
    let w = h[8]
    return [h[0] / w, h[3] / w, h[1] / w, h[4] / w, h[2] / w, h[5] / w]
}

public func isIdentityHomography(_ h: Homography, _ eps: Double = 1e-9) -> Bool {
    let w = h[8]
    if Swift.abs(w) < 1e-12 { return false }
    for i in 0..<8 where Swift.abs(h[i] / w - IDENTITY_HOMOGRAPHY[i]) > eps { return false }
    // NaN compares false above, as in JS.
    return true
}

/// Unit square → quad (corners (0,0), (1,0), (1,1), (0,1) to TL, TR, BR, BL); nil when degenerate.
private func squareToQuad(_ q: [Vec2]) -> Homography? {
    let p0 = q[0], p1 = q[1], p2 = q[2], p3 = q[3]
    let sx = p0.x - p1.x + p2.x - p3.x
    let sy = p0.y - p1.y + p2.y - p3.y
    if Swift.abs(sx) < 1e-12 && Swift.abs(sy) < 1e-12 {
        return [p1.x - p0.x, p3.x - p0.x, p0.x, p1.y - p0.y, p3.y - p0.y, p0.y, 0, 0, 1]
    }
    let dx1 = p1.x - p2.x
    let dx2 = p3.x - p2.x
    let dy1 = p1.y - p2.y
    let dy2 = p3.y - p2.y
    let den = dx1 * dy2 - dx2 * dy1
    if Swift.abs(den) < 1e-12 { return nil }
    let g = (sx * dy2 - dx2 * sy) / den
    let h = (dx1 * sy - sx * dy1) / den
    return [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y, g, h, 1]
}

/**
 * The map taking box `r`'s corners onto `quad` (TL, TR, BR, BL), exact for parallelograms (then
 * affine). Nil for an empty box, a non-finite or degenerate quad, or a singular result.
 */
public func rectToQuad(_ r: Box, _ quad: [Vec2]) -> Homography? {
    if !(r.width > 0 && r.height > 0) || quad.count != 4 || !quad.allSatisfy(finite) { return nil }
    let toUnit: Homography = [1 / r.width, 0, -r.x / r.width, 0, 1 / r.height, -r.y / r.height, 0, 0, 1]
    guard let sq = squareToQuad(quad) else { return nil }
    let h = multiplyHomographies(toUnit, sq)
    return invertHomography(h) != nil ? h : nil
}

/// Box `r`'s corners as a quad (TL, TR, BR, BL).
public func boxQuad(_ r: Box) -> [Vec2] {
    [Vec2(x: r.x, y: r.y), Vec2(x: r.x + r.width, y: r.y), Vec2(x: r.x + r.width, y: r.y + r.height), Vec2(x: r.x, y: r.y + r.height)]
}

/// Approximate linear scale of the map near `p` (square root of the Jacobian determinant).
public func homographyLocalScale(_ h: Homography, _ p: Vec2) -> Double {
    let e = 0.5
    guard let a = applyHomography(h, Vec2(x: p.x - e, y: p.y)), let b = applyHomography(h, Vec2(x: p.x + e, y: p.y)),
          let c = applyHomography(h, Vec2(x: p.x, y: p.y - e)), let d = applyHomography(h, Vec2(x: p.x, y: p.y + e)) else { return 0 }
    let jx = Vec2(x: b.x - a.x, y: b.y - a.y)
    let jy = Vec2(x: d.x - c.x, y: d.y - c.y)
    return Swift.abs(jx.x * jy.y - jx.y * jy.x).squareRoot()
}

/**
 * The side of the horizon (+1 or −1) most of box `r`'s corners map to (the centre's on a tie). A
 * Distort dragged past the horizon maps the rest of the source to the far side, where it would
 * show as a mirrored copy wrapped round infinity; resampling keeps to this side, as Photoshop does.
 */
public func homographyFrontSide(_ h: Homography, _ r: Box) -> Int {
    let ahead = boxQuad(r).filter { homographyW(h, $0) > 0 }.count
    if ahead >= 3 { return 1 }
    if ahead <= 1 { return -1 }
    return homographyW(h, Vec2(x: r.x + r.width / 2, y: r.y + r.height / 2)) >= 0 ? 1 : -1
}

/// Most pixels a side of a warped result may span (±2²⁰), as photocraft clamps.
private let OUTPUT_LIMIT = Double(1 << 20)

/**
 * The integer box a warp of box `r` through `h` fills: the warped corners plus a pixel for filter
 * support, each side clamped to ±2²⁰. Nil when a corner maps to infinity or `h` is singular.
 */
public func warpOutputBounds(_ r: Box, _ h: Homography) -> RasterRect? {
    if !(r.width > 0 && r.height > 0) || invertHomography(h) == nil { return nil }
    let corners = boxQuad(r).compactMap { applyHomography(h, $0) }
    if corners.count != 4 { return nil }
    return cornerBounds(corners)
}

/// The integer box around `corners`, grown by a pixel and clamped to ±2²⁰.
public func cornerBounds(_ corners: [Vec2]) -> RasterRect {
    let lim = OUTPUT_LIMIT
    let xs = corners.map(\.x)
    let ys = corners.map(\.y)
    let minOf = { (v: [Double]) in v.reduce(Double.infinity) { JS.min($0, $1) } }
    let maxOf = { (v: [Double]) in v.reduce(-Double.infinity) { JS.max($0, $1) } }
    let x0 = Int(JS.floor(JS.max(-lim, minOf(xs)))) - 1
    let y0 = Int(JS.floor(JS.max(-lim, minOf(ys)))) - 1
    let x1 = Int(JS.ceil(JS.min(lim, maxOf(xs)))) + 1
    let y1 = Int(JS.ceil(JS.min(lim, maxOf(ys)))) + 1
    return RasterRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
}

/**
 * Whether `q` (TL, TR, BR, BL) is strictly convex with every corner turn above ~0.06°, wound
 * clockwise on screen (y down), finite and at least 1 px² in area.
 */
public func isConvexQuad(_ q: [Vec2]) -> Bool {
    if q.count != 4 || !q.allSatisfy(finite) { return false }
    var area2 = 0.0
    for i in 0..<4 {
        let a = q[i]
        let b = q[(i + 1) % 4]
        let c = q[(i + 2) % 4]
        let e1 = Vec2(x: b.x - a.x, y: b.y - a.y)
        let e2 = Vec2(x: c.x - b.x, y: c.y - b.y)
        let cross = e1.x * e2.y - e1.y * e2.x
        if !(cross > 1e-3 * JS.hypot(e1.x, e1.y) * JS.hypot(e2.x, e2.y)) { return false }
        area2 += a.x * b.y - b.x * a.y
    }
    return area2.isFinite && area2 >= 2
}
