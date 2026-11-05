import Foundation
import PixerateRaster

// Diagonal hatching: the Shape Builder's mesh highlight over a face (`canvas/pathops/hatch.ts`).
//
// Ported from vectorcraft-main/crates/tools/src/builder.rs (`hatch`). MIT OR Apache-2.0,
// © ArtCraft Team and contributors. See THIRD_PARTY_NOTICES.md.

/// `HatchOptions`.
public struct HatchOptions: Sendable {
    /// Distance between the lines, in the path's units (default 4).
    public var gap: Double?
    /// Most lines drawn: past it the gap widens (default 400).
    public var maxLines: Double?
    public init(gap: Double? = nil, maxLines: Double? = nil) {
        self.gap = gap
        self.maxLines = maxLines
    }
}

/// `Math.SQRT1_2`.
private let SQRT1_2 = 0.7071067811865476

/// 45° hatch lines filling `path` (non-zero and even-odd agree for simple faces; crossings are
/// paired in order, as even-odd does), `gap` apart. Each line is its own `M`/`L` pair, clipped to
/// the path. Empty for a path with no area.
public func hatchPath(_ path: BezierPathInput, _ options: HatchOptions = .init()) -> BezierPath {
    var out: BezierPath = []
    guard let b = bezierPathBounds(path) else { return out }
    if b.maxX - b.minX <= 0 || b.maxY - b.minY <= 0 { return out }
    let want = jmax(options.gap ?? 4, 1e-3)
    // Rotated by -45° the hatch lines are horizontal scanlines.
    let s = SQRT1_2
    func rot(_ p: Point) -> Point { Point((p[0] + p[1]) * s, (p[1] - p[0]) * s) }
    func unrot(_ x: Double, _ y: Double) -> (x: Double, y: Double) { ((x - y) * s, (x + y) * s) }
    var edges: [(Point, Point)] = []
    for contour in pathToContours(path) {
        let pts = flattenChain(closeContour(contour, true), want * 0.1).map(rot)
        for i in 0..<pts.count {
            let p = pts[i]
            let q = pts[(i + 1) % pts.count]
            if p[0] != q[0] || p[1] != q[1] { edges.append((p, q)) }
        }
    }
    var y0 = Double.infinity
    var y1 = -Double.infinity
    for (p, q) in edges {
        y0 = jmin(y0, p[1], q[1])
        y1 = jmax(y1, p[1], q[1])
    }
    if !(y1 > y0) { return out }
    let gap = jmax(want, (y1 - y0) / jmax(1, options.maxLines ?? 400), 1e-6)
    var xs: [Double] = []
    var y = JS.floor(y0 / gap) * gap + gap / 2
    while y < y1 {
        xs.removeAll(keepingCapacity: true)
        for (p, q) in edges where (p[1] <= y) != (q[1] <= y) { xs.append(p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0])) }
        xs.jsSort { m, n in m - n }
        var i = 0
        while i + 1 < xs.count {
            let a = unrot(xs[i], y)
            let c = unrot(xs[i + 1], y)
            out.append(.M(x: a.x, y: a.y))
            out.append(.L(x: c.x, y: c.y))
            i += 2
        }
        y += gap
    }
    return out
}
