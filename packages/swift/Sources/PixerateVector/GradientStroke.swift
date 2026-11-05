import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Gradients laid along or across a stroke (`strokeMode: 'along' | 'across'`) as a `<pattern>` of
// slices (`vector/gradientStroke.ts`, after vectorcraft's `stroke/gradient.rs`). Each subpath is
// flattened and cut into one slice per flattened segment, reaching past everything the stroke
// paints there. Gentle turns share a rib on the bisector; a sharp corner gets square ribs and a
// patch in the corner's colour, and open ends get patches in the end colours.

/// Largest stretch of a rib on a turn's bisector before the corner gets a patch.
private let SHARP = 1.25
/// Flattening tolerance (node units).
private let TOLERANCE = 0.2
/// How far each slice reaches into the next (node units).
private let OVERLAP = 0.5

@inline(__always) private func add(_ a: Vec2, _ b: Vec2) -> Vec2 { Vec2(a.x + b.x, a.y + b.y) }
@inline(__always) private func sub(_ a: Vec2, _ b: Vec2) -> Vec2 { Vec2(a.x - b.x, a.y - b.y) }
@inline(__always) private func scale(_ a: Vec2, _ k: Double) -> Vec2 { Vec2(a.x * k, a.y * k) }
/// Left of direction `d` looking along it on screen (y down).
@inline(__always) private func left(_ d: Vec2) -> Vec2 { Vec2(d.y, -d.x) }
private func unit(_ v: Vec2) -> Vec2 {
    let l = JS.hypot(v.x, v.y)
    return l > 1e-12 ? Vec2(v.x / l, v.y / l) : Vec2(1, 0)
}

/// A cross-section of the strip: from `l` (left of the path) through the path to `r`.
private struct Rib {
    var l: Vec2
    var r: Vec2
}

/// The flattened subpaths of a path (node space) and whether each is closed.
private func flattenedSubpaths(_ node: VectorNode) -> [(pts: [Vec2], closed: Bool)] {
    var out: [(pts: [Vec2], closed: Bool)] = []
    for contour in pathToContours(.commands(subpathsToBezier(node.subpaths))) {
        let segs = closeContour(contour)
        if segs.isEmpty { continue }
        let ring = flattenChain(segs, TOLERANCE).map { Vec2($0[0], $0[1]) }
        var pts: [Vec2] = []
        for (i, q) in ring.enumerated() where i == 0 || JS.hypot(q.x - ring[i - 1].x, q.y - ring[i - 1].y) > 1e-9 { pts.append(q) }
        if contour.closed && pts.count > 2 && JS.hypot(pts[0].x - pts[pts.count - 1].x, pts[0].y - pts[pts.count - 1].y) < 1e-9 { pts.removeLast() }
        if pts.count >= 2 { out.append((pts, contour.closed && pts.count > 2)) }
    }
    return out
}

/// Shoelace area (positive: clockwise on screen, y down).
private func signedArea(_ pts: [Vec2]) -> Double {
    var a = 0.0
    for i in pts.indices {
        let p = pts[i]
        let q = pts[(i + 1) % pts.count]
        a += p.x * q.y - q.x * p.y
    }
    return a / 2
}

/// The paint server of a gradient along or across the stroke of `node` (in its own space): a
/// pattern whose id is `id` (`vectorStrokeGradientDefs`). `area` defaults to the path's box
/// padded by the stroke's reach.
public func vectorStrokeGradientDefs(_ g: JSONObject, _ id: String, _ node: VectorNode, bounds: VectorBounds? = nil, area areaIn: VectorBounds? = nil, precision: Int? = nil) -> [VectorPaintDef] {
    let precision = precision ?? 3
    let across = g["strokeMode"] == "across"
    let expanded = expandVectorGradientStops(g)
    let reach = vectorStrokeReach(node) + 1
    let area = areaIn ?? vectorGradientArea(bounds.map { padBounds($0, reach) })
    let width = node.strokeWidth ?? 1
    let align = node["strokeAlign"]?.stringValue ?? "center"
    let profile = strokeWidthProfileOf(node)
    var gradients: [SvgGradientDef] = []
    var patches: [(d: String, fill: String)] = []
    var slices: [(d: String, fill: String)] = []
    var counter = 0
    func solid(_ pts: [Vec2], _ t: Double) {
        var s = spanVectorGradientStops(g, t, t, expanded)[0]
        s.offset = 0
        let gid = "\(id)-p\(counter)"
        counter += 1
        // A one-stop gradient keeps the stop's opacity (a fill colour would need fill-opacity).
        gradients.append(SvgGradientDef(id: gid, type: "linear", attrs: JSONObject([("gradientUnits", "userSpaceOnUse"), ("x1", 0), ("y1", 0), ("x2", 1), ("y2", 0)]), stops: toSvgStops([s])))
        patches.append((polygonD(pts, precision), "url(#\(gid))"))
    }
    func disc(_ c: Vec2, _ r: Double) -> [Vec2] {
        (0 ..< 16).map { k in add(c, scale(Vec2(JS.cos((Double(k) * Double.pi) / 8), JS.sin((Double(k) * Double.pi) / 8)), r)) }
    }

    for (pts, closed) in flattenedSubpaths(node) {
        let n = pts.count
        let segCount = closed ? n : n - 1
        var dirs: [Vec2] = []
        var lengths: [Double] = [0]
        for i in 0 ..< segCount {
            let a = pts[i]
            let b = pts[(i + 1) % n]
            dirs.append(unit(sub(b, a)))
            lengths.append(lengths[i] + JS.hypot(b.x - a.x, b.y - a.y))
        }
        let total = lengths[segCount]
        if !(total > 1e-9) { continue }
        func tAt(_ i: Int) -> Double { lengths[i] / total }
        // Inside / outside strokes show one side: the right of a clockwise outline is its inside.
        let clockwise = closed && signedArea(pts) > 0
        let visibleLeft: Bool? = align == "center" || !closed ? nil : align == "inside" ? !clockwise : clockwise

        // Ribs at each vertex: `before` ends the slice arriving, `after` starts the one leaving.
        var ribs: [(before: Rib, after: Rib)] = []
        for i in 0 ..< n {
            let p = pts[i]
            let din: Vec2? = i > 0 || closed ? dirs[(i - 1 + segCount) % segCount] : nil
            let dout: Vec2? = i < segCount ? dirs[i] : nil
            func square(_ d: Vec2) -> Rib { Rib(l: add(p, scale(left(d), reach)), r: sub(p, scale(left(d), reach))) }
            guard let din, let dout else {
                let rib = square((din ?? dout)!)
                ribs.append((rib, rib))
                continue
            }
            let nin = left(din)
            let nout = left(dout)
            let den = 1 + nin.x * nout.x + nin.y * nout.y
            let stretch = den > 1e-12 ? Foundation.sqrt(2 / den) : .infinity
            if stretch <= SHARP {
                let m = scale(add(nin, nout), reach / den)
                let rib = Rib(l: add(p, m), r: sub(p, m))
                ribs.append((rib, rib))
            } else {
                ribs.append((square(din), square(dout)))
                solid(disc(p, reach * 1.5), tAt(i))
            }
        }
        if !closed {
            // Caps and arrowheads beyond the ends paint the end colours.
            let d0 = dirs[0]
            let d1 = dirs[segCount - 1]
            func cap(_ p: Vec2, _ d: Vec2) -> [Vec2] {
                [add(p, scale(left(d), reach)), add(add(p, scale(d, reach)), scale(left(d), reach)), sub(add(p, scale(d, reach)), scale(left(d), reach)), sub(p, scale(left(d), reach))]
            }
            solid(cap(pts[0], scale(d0, -1)), 0)
            solid(cap(pts[n - 1], d1), 1)
        }
        for i in 0 ..< segCount {
            let j = (i + 1) % n
            let a = pts[i]
            let b = pts[j]
            let d = dirs[i]
            let from = ribs[i].after
            let to = ribs[j].before
            let ext = scale(d, OVERLAP)
            let quad = [from.l, add(to.l, ext), add(to.r, ext), from.r]
            let gid = "\(id)-s\(counter)"
            counter += 1
            let t0 = tAt(i)
            let t1 = closed && i == segCount - 1 ? 1 : tAt(i + 1)
            if !across {
                let attrs = JSONObject([("gradientUnits", "userSpaceOnUse"), ("x1", .string(gradientFmt(a.x, 4))), ("y1", .string(gradientFmt(a.y, 4))), ("x2", .string(gradientFmt(b.x, 4))), ("y2", .string(gradientFmt(b.y, 4)))])
                gradients.append(SvgGradientDef(id: gid, type: "linear", attrs: attrs, stops: toSvgStops(spanVectorGradientStops(g, t0, t1, expanded))))
            } else {
                let mid = scale(add(a, b), 0.5)
                let side = widthProfileAt(profile, (t0 + t1) / 2)
                let nrm = left(d)
                let reachL = visibleLeft == nil ? (width / 2) * side.left : visibleLeft! ? width * side.left : 0
                let reachR = visibleLeft == nil ? (width / 2) * side.right : visibleLeft! ? 0 : width * side.right
                let p0 = add(mid, scale(nrm, reachL))
                let p1 = sub(mid, scale(nrm, reachR))
                let attrs = JSONObject([("gradientUnits", "userSpaceOnUse"), ("x1", .string(gradientFmt(p0.x, 4))), ("y1", .string(gradientFmt(p0.y, 4))), ("x2", .string(gradientFmt(p1.x, 4))), ("y2", .string(gradientFmt(p1.y, 4)))])
                gradients.append(SvgGradientDef(id: gid, type: "linear", attrs: attrs, stops: toSvgStops(expanded)))
            }
            slices.append((polygonD(quad, precision), "url(#\(gid))"))
        }
    }
    return [.pattern(VectorSvgPatternDef(id: id, attrs: patternAttrs(area), gradients: gradients, tiles: patches + slices))]
}
