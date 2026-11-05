// Portions after effectcraft's crates/path/src/trace.rs (MIT OR Apache-2.0, © ArtCraft Team and
// contributors) by way of packages/core/src/vector/trace.ts. See THIRD_PARTY_NOTICES.md.

import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Image tracing (`vector/trace.ts`): raster pixels to vector paths. Marching squares over the
// samples at pixel centres (crossings interpolated along each cell edge, saddles resolved by the
// cell's mean, the field padded with "outside" so every contour closes), Ramer–Douglas–Peucker
// simplification to the tolerance, loops below the minimum area dropped and each loop's nesting
// depth counted (holes have odd depth), then `fitCubics` (corner roundness sets which turns stay
// sharp). Colour tracing quantises the image (median cut) and traces each colour stacked. Ported
// operation for operation: the threshold field is a `Float32Array` in the TS, so its samples are
// rounded to `Float` here; every sort is the stable `jsSorted`.

/// RGBA pixels, row by row, 8 bits a channel (`VectorTracePixels`).
public struct VectorTracePixels: Sendable {
    public var width: Int
    public var height: Int
    public var data: [UInt8]

    public init(width: Int, height: Int, data: [UInt8]) {
        self.width = width
        self.height = height
        self.data = data
    }
}

/// How to trace (`VectorTraceOptions`).
public struct VectorTraceOptions: Sendable {
    /// `threshold` (default): one colour where the image is dark (or opaque); `color`: a stacked path per colour.
    public var mode: String?
    /// Threshold mode: `luminance` (dark is inside, default) or `alpha` (opaque is inside).
    public var channel: String?
    /// Threshold mode: inside where darkness (or alpha) is at least this, 0–1 (default 0.5).
    public var threshold: Double?
    /// Threshold mode: the traced shape's fill (default black).
    public var color: String?
    /// Colour mode: how many colours (2–32, default 6).
    public var colors: Double?
    /// How far (pixels) the outline may stray from the pixels (default 1).
    public var tolerance: Double?
    /// Shapes smaller than this many square pixels are dropped (default 10).
    public var minArea: Double?
    /// 0: straight sides and sharp corners; 1: as smooth as the outline allows (default 0.5).
    public var cornerRoundness: Double?
    /// Give hard pixel edges their square corners back (default false).
    public var squareCorners: Bool?

    public init(mode: String? = nil, channel: String? = nil, threshold: Double? = nil, color: String? = nil, colors: Double? = nil, tolerance: Double? = nil, minArea: Double? = nil,
                cornerRoundness: Double? = nil, squareCorners: Bool? = nil) {
        self.mode = mode
        self.channel = channel
        self.threshold = threshold
        self.color = color
        self.colors = colors
        self.tolerance = tolerance
        self.minArea = minArea
        self.cornerRoundness = cornerRoundness
        self.squareCorners = squareCorners
    }
}

/// An error of the image tools, with the TS message.
public struct VectorImageError: Error, CustomStringConvertible, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// The most pixels traced (`VECTOR_TRACE_MAX_PIXELS`).
public let VECTOR_TRACE_MAX_PIXELS = 4_000_000

private struct TraceLoop {
    var raw: [PathPoint]
    var simple: [PathPoint]
    var area: Double
    var depth: Int
}

private func signedArea(_ p: [PathPoint]) -> Double {
    var a = 0.0
    for i in p.indices {
        let p0 = p[i]
        let p1 = p[(i + 1) % p.count]
        a += p0.x * p1.y - p1.x * p0.y
    }
    return a / 2
}

private func pointInPoly(_ p: PathPoint, _ poly: [PathPoint]) -> Bool {
    var inside = false
    var j = poly.count - 1
    for i in poly.indices {
        let (xi, yi) = (poly[i].x, poly[i].y)
        let (xj, yj) = (poly[j].x, poly[j].y)
        if (yi > p.y) != (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi { inside.toggle() }
        j = i
    }
    return inside
}

/**
 * Marching squares over `field` (`w × h`, row by row, sample (x, y) at pixel centre (x + 0.5,
 * y + 0.5)): the closed contours where the field reaches `threshold`, in pixel coordinates
 * (`vectorTraceContours`).
 */
public func vectorTraceContours(_ field: [Double], _ w: Int, _ h: Int, _ threshold: Double) -> [[PathPoint]] {
    let gw = w + 2
    let gh = h + 2
    func val(_ i: Int, _ j: Int) -> Double { i == 0 || j == 0 || i > w || j > h ? -.infinity : field[(j - 1) * w + (i - 1)] }
    func inside(_ i: Int, _ j: Int) -> Bool { val(i, j) >= threshold }
    func pos(_ i: Int, _ j: Int) -> PathPoint { PathPoint(Double(i) - 0.5, Double(j) - 0.5) }
    func cross(_ a: (Int, Int), _ b: (Int, Int)) -> PathPoint {
        let va = val(a.0, a.1)
        let vb = val(b.0, b.1)
        let t: Double
        if va.isFinite && vb.isFinite && abs(vb - va) > 1e-12 { t = JS.min(1, JS.max(0, (threshold - va) / (vb - va))) }
        // One side is padding: the crossing sits half a pixel out.
        else if va.isFinite { t = va >= threshold ? 0.5 : 0 }
        else { t = vb >= threshold ? 0.5 : 1 }
        let pa = pos(a.0, a.1)
        let pb = pos(b.0, b.1)
        return PathPoint(pa.x + (pb.x - pa.x) * t, pa.y + (pb.y - pa.y) * t)
    }
    func hid(_ i: Int, _ j: Int) -> Int { 2 * (j * gw + i) }
    func vid(_ i: Int, _ j: Int) -> Int { 2 * (j * gw + i) + 1 }
    var next: [Int: Int] = [:]
    var point: [Int: PathPoint] = [:]
    for j in 0 ..< gh - 1 {
        for i in 0 ..< gw - 1 {
            let tl = inside(i, j)
            let tr = inside(i + 1, j)
            let br = inside(i + 1, j + 1)
            let bl = inside(i, j + 1)
            let code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0)
            if code == 0 || code == 15 { continue }
            let top = hid(i, j)
            let bottom = hid(i, j + 1)
            let left = vid(i, j)
            let right = vid(i + 1, j)
            func seg(_ a: Int, _ b: Int) { next[a] = b }
            func mean() -> Double { (val(i, j) + val(i + 1, j) + val(i + 1, j + 1) + val(i, j + 1)) / 4 }
            switch code {
            case 1: seg(left, bottom)
            case 2: seg(bottom, right)
            case 3: seg(left, right)
            case 4: seg(right, top)
            case 5:
                if mean() >= threshold {
                    seg(left, top)
                    seg(right, bottom)
                } else {
                    seg(left, bottom)
                    seg(right, top)
                }
            case 6: seg(bottom, top)
            case 7: seg(left, top)
            case 8: seg(top, left)
            case 9: seg(top, bottom)
            case 10:
                if mean() >= threshold {
                    seg(top, right)
                    seg(bottom, left)
                } else {
                    seg(top, left)
                    seg(bottom, right)
                }
            case 11: seg(top, right)
            case 12: seg(right, left)
            case 13: seg(right, bottom)
            case 14: seg(bottom, left)
            default: break
            }
            let edges: [(Int, (Int, Int), (Int, Int))] = [
                (top, (i, j), (i + 1, j)),
                (bottom, (i, j + 1), (i + 1, j + 1)),
                (left, (i, j), (i, j + 1)),
                (right, (i + 1, j), (i + 1, j + 1)),
            ]
            for (e, a, b) in edges where inside(a.0, a.1) != inside(b.0, b.1) && point[e] == nil { point[e] = cross(a, b) }
        }
    }
    var out: [[PathPoint]] = []
    for start in next.keys.sorted() {
        if next[start] == nil { continue }
        var poly: [PathPoint] = []
        var e = start
        while true {
            guard let n = next[e] else { break }
            next[e] = nil
            if let p = point[e] { poly.append(p) }
            e = n
            if e == start { break }
        }
        if poly.count >= 3 { out.append(poly) }
    }
    return out
}

/// A contour with each half-pixel diagonal between an axis-aligned run and a perpendicular one
/// replaced by the corner where the two runs meet (`squareContourCorners`).
private func squareContourCorners(_ ring: [PathPoint]) -> [PathPoint] {
    let n = ring.count
    if n < 4 { return ring }
    func eq(_ u: Double, _ v: Double) -> Bool { abs(u - v) < 1e-9 }
    var out: [PathPoint] = []
    // `out[0] === ring[0]` in the TS: whether the first point was kept as it is (not a new corner).
    var firstIsRing0 = false
    var i = 0
    while i < n {
        let a = ring[i]
        let b = ring[(i + 1) % n]
        let p = ring[(i - 1 + n) % n]
        let q = ring[(i + 2) % n]
        // About half a pixel each way (a threshold off 0.5 moves the crossing a little).
        let diagonal = abs(abs(b.x - a.x) - 0.5) < 0.02 && abs(abs(b.y - a.y) - 0.5) < 0.02
        // The last pair wraps onto the first point: only when that point was kept as it is.
        let wraps = i == n - 1
        var corner: PathPoint?
        if diagonal && (!wraps || (!out.isEmpty && firstIsRing0)) {
            if eq(p.y, a.y) && !eq(p.x, a.x) && eq(q.x, b.x) && !eq(q.y, b.y) { corner = PathPoint(b.x, a.y) }
            else if eq(p.x, a.x) && !eq(p.y, a.y) && eq(q.y, b.y) && !eq(q.x, b.x) { corner = PathPoint(a.x, b.y) }
        }
        guard let corner else {
            if out.isEmpty && i == 0 { firstIsRing0 = true }
            out.append(a)
            i += 1
            continue
        }
        out.append(corner)
        // The pair's second point is consumed.
        if wraps { out.removeFirst() } else { i += 1 }
        i += 1
    }
    if out.count < 3 { return ring }
    // Start at a turn: simplification keeps the first point, which would otherwise sit mid-edge.
    let m = out.count
    for k in 0 ..< m {
        let p = out[(k - 1 + m) % m]
        let a = out[k]
        let q = out[(k + 1) % m]
        if abs((a.x - p.x) * (q.y - a.y) - (a.y - p.y) * (q.x - a.x)) > 1e-6 { return k != 0 ? Array(out[k...]) + Array(out[..<k]) : out }
    }
    return out
}

/// The loops of a field, simplified, filtered by area and given their nesting depth (outermost first).
private func loopsOf(_ field: [Double], _ w: Int, _ h: Int, _ threshold: Double, _ tolerance: Double, _ minArea: Double, _ square: Bool) -> [TraceLoop] {
    var loops: [TraceLoop] = []
    for contour in vectorTraceContours(field, w, h, threshold) {
        let raw = square ? squareContourCorners(contour) : contour
        let area = signedArea(raw)
        if abs(area) < JS.max(0, minArea) { continue }
        let simple = simplifyRing(raw, JS.max(0.01, tolerance))
        if simple.count < 3 { continue }
        loops.append(TraceLoop(raw: raw, simple: simple, area: area, depth: 0))
    }
    let depths = loops.indices.map { li in
        loops.indices.filter { oi in oi != li && abs(loops[oi].area) > abs(loops[li].area) && pointInPoly(loops[li].simple[0], loops[oi].simple) }.count
    }
    for k in loops.indices { loops[k].depth = depths[k] }
    return jsSorted(loops) { a, b in a.depth != b.depth ? Double(a.depth - b.depth) : abs(b.area) - abs(a.area) }
}

/// A loop as a closed subpath: a polygon at roundness 0, else cubics fitted within the tolerance.
private func loopSubpath(_ l: TraceLoop, _ tolerance: Double, _ roundness: Double) -> VectorSubpath {
    let polygon = VectorSubpath(closed: true, anchors: l.simple.map { VectorAnchor(x: $0.x, y: $0.y) })
    if roundness <= 0 { return polygon }
    // The rounder, the larger a turn must be to stay a corner.
    let cornerAngleDeg = 25 + roundness * 125
    let cubics = fitCubics(l.raw, JS.max(0.05, tolerance), FitCubicsOptions(cornerAngleDeg: cornerAngleDeg, closed: true))
    if cubics.isEmpty { return polygon }
    let anchors = cubics.indices.map { k -> VectorAnchor in
        let c = cubics[k]
        let prev = cubics[(k - 1 + cubics.count) % cubics.count]
        return VectorAnchor(x: c.p0.x, y: c.p0.y, in: Vec2(prev.p2.x, prev.p2.y), out: Vec2(c.p1.x, c.p1.y))
    }
    return VectorSubpath(closed: true, anchors: anchors)
}

/// The subpaths of a field's outline (holes included; fill even-odd), in its pixel coordinates (`traceField`).
public func traceField(_ field: [Double], _ w: Int, _ h: Int, _ threshold: Double, _ o: VectorTraceOptions) -> [VectorSubpath] {
    let tolerance = o.tolerance ?? 1
    let roundness = JS.min(1, JS.max(0, o.cornerRoundness ?? 0.5))
    return loopsOf(field, w, h, threshold, tolerance, o.minArea ?? 10, o.squareCorners == true).map { loopSubpath($0, tolerance, roundness) }
}

/// The palette of the opaque pixels quantised to `count` colours (median cut on RGB), each pixel's
/// palette index (−1 for transparent pixels) and how many pixels each colour got
/// (`quantizeVectorTraceColors`).
public func quantizeVectorTraceColors(_ pixels: VectorTracePixels, _ count: Int) -> (palette: [[Double]], index: [Int16], counts: [Int]) {
    let n = pixels.width * pixels.height
    let d = pixels.data
    var opaque: [Int] = []
    for i in 0 ..< n where d[i * 4 + 3] >= 128 { opaque.append(i) }
    var boxes: [[Int]] = opaque.isEmpty ? [] : [opaque]
    func range(_ box: [Int], _ c: Int) -> Int {
        var lo = 255
        var hi = 0
        for i in box {
            let v = Int(d[i * 4 + c])
            if v < lo { lo = v }
            if v > hi { hi = v }
        }
        return hi - lo
    }
    while boxes.count < count {
        // Split the box with the widest channel range at its median.
        var best = -1
        var bestRange = 0
        var bestC = 0
        for (k, b) in boxes.enumerated() {
            if b.count < 2 { continue }
            for c in 0 ..< 3 {
                let r = range(b, c)
                if r > bestRange {
                    bestRange = r
                    best = k
                    bestC = c
                }
            }
        }
        if best < 0 { break }
        let box = jsSorted(boxes[best]) { a, b in Double(d[a * 4 + bestC]) - Double(d[b * 4 + bestC]) }
        // At the median, moved to where the channel's value changes so equal colours stay together.
        func key(_ k: Int) -> UInt8 { d[box[k] * 4 + bestC] }
        let v = key(box.count >> 1)
        var mid = box.indices.first { key($0) >= v } ?? -1
        if mid <= 0 { mid = box.indices.first { key($0) > v } ?? -1 }
        // `slice(0, -1)` / `slice(-1)` as JavaScript reads them (never reached: the range is above 0).
        let cut = mid < 0 ? box.count + mid : mid
        boxes.replaceSubrange(best ... best, with: [Array(box[..<cut]), Array(box[cut...])])
    }
    let palette = boxes.map { b -> [Double] in
        var s = [0.0, 0.0, 0.0]
        for i in b { for c in 0 ..< 3 { s[c] += Double(d[i * 4 + c]) } }
        let len = Double(b.count)
        return [JS.round(s[0] / len), JS.round(s[1] / len), JS.round(s[2] / len)]
    }
    var index = [Int16](repeating: -1, count: n)
    var counts = palette.map { _ in 0 }
    for i in opaque {
        var best = 0
        var bestD = Double.infinity
        for (k, p) in palette.enumerated() {
            let dr = Double(d[i * 4]) - p[0], dg = Double(d[i * 4 + 1]) - p[1], db = Double(d[i * 4 + 2]) - p[2]
            let dd = dr * dr + dg * dg + db * db
            if dd < bestD {
                bestD = dd
                best = k
            }
        }
        index[i] = Int16(best)
        counts[best] += 1
    }
    return (palette, index, counts)
}

/// `#rrggbb` from 0–255 channels (`Math.round(v).toString(16)`).
func vectorTraceHex(_ c: [Double]) -> String {
    "#" + c.prefix(3).map { v -> String in
        let r = JS.round(v)
        if !r.isFinite { return jsString(r) }
        let s = String(Int(r), radix: 16)
        return s.count < 2 ? "0" + s : s
    }.joined()
}

/// A traced path node: `{ id, type: 'path', name, fill, stroke: null, fillRule: 'evenodd', subpaths }`.
private func tracedNode(_ id: String, _ name: String, _ fill: String, _ subpaths: [VectorSubpath]) -> VectorNode {
    VectorNode(props: JSONObject([("id", .string(id)), ("type", "path"), ("name", .string(name)), ("fill", .string(fill)), ("stroke", .null), ("fillRule", "evenodd")]), subpaths: subpaths)
}

/**
 * Traces pixels into path nodes in pixel units (one pixel = one unit, the image's top-left at the
 * origin), bottom to top: one compound path in threshold mode, a stacked path per colour in colour
 * mode (most common colour at the bottom). Ids are `trace-<n>` (`traceVectorImage`).
 */
public func traceVectorImage(_ pixels: VectorTracePixels, _ options: VectorTraceOptions = VectorTraceOptions()) throws -> [VectorNode] {
    let (w, h, data) = (pixels.width, pixels.height, pixels.data)
    if !(w > 0 && h > 0) || data.count < w * h * 4 { throw VectorImageError("The image has no pixels (or fewer than width × height × 4 values).") }
    if w * h > VECTOR_TRACE_MAX_PIXELS { throw VectorImageError("The image has \(w * h) pixels; scale it down to at most \(VECTOR_TRACE_MAX_PIXELS) to trace it.") }
    let n = w * h
    if (options.mode ?? "threshold") == "threshold" {
        var field = [Double](repeating: 0, count: n)
        let byAlpha = options.channel == "alpha"
        for i in 0 ..< n {
            let a = Double(data[i * 4 + 3]) / 255
            // Darkness over white: transparent pixels count as white (a Float32Array store).
            let v = byAlpha ? a : a * (1 - (0.2126 * Double(data[i * 4]) + 0.7152 * Double(data[i * 4 + 1]) + 0.0722 * Double(data[i * 4 + 2])) / 255)
            field[i] = Double(Float(v))
        }
        let subpaths = traceField(field, w, h, JS.min(1, JS.max(0, options.threshold ?? 0.5)), options)
        return subpaths.isEmpty ? [] : [tracedNode("trace-1", "Trace", options.color ?? "#000000", subpaths)]
    }
    let count = Int(JS.min(32, JS.max(2, JS.round(options.colors ?? 6))))
    let q = quantizeVectorTraceColors(pixels, count)
    // Most common colour first (bottom); each layer covers its colour and every one above it.
    let order = jsSorted(q.palette.indices.filter { q.counts[$0] > 0 }) { a, b in Double(q.counts[b] - q.counts[a]) }
    var rank: [Int: Int] = [:]
    for (r, k) in order.enumerated() { rank[k] = r }
    var out: [VectorNode] = []
    for (r, k) in order.enumerated() {
        var field = [Double](repeating: 0, count: n)
        for i in 0 ..< n {
            let ix = Int(q.index[i])
            field[i] = ix >= 0 && rank[ix]! >= r ? 1 : 0
        }
        let subpaths = traceField(field, w, h, 0.5, options)
        if !subpaths.isEmpty {
            let hex = vectorTraceHex(q.palette[k])
            out.append(tracedNode("trace-\(out.count + 1)", hex, hex, subpaths))
        }
    }
    return out
}
