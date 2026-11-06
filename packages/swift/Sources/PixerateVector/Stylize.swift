import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Bitmap-to-vector stylise (`vector/stylize.ts`): a picture turned into stylised vector art, one
// shape per cell of a grid: `mosaic` tiles, `halftone` dots on a turned grid, `lowPoly` triangles of
// a jittered grid and `hatch` engraving lines. Colours are reduced to a palette (median cut, as
// Image Trace does) and the shapes of one colour share a compound path. Results are in pixel units,
// bottom to top. The palette input is a `Uint8ClampedArray` in the TS, so its stores round half to
// even (`JS.u8c`); the low-poly jitter is the TS's own `Math.imul` hash, ported on `UInt32`.

/// `VECTOR_STYLIZE_STYLES`.
public let VECTOR_STYLIZE_STYLES = ["mosaic", "halftone", "lowPoly", "hatch"]
/// `VECTOR_STYLIZE_LABELS`.
public let VECTOR_STYLIZE_LABELS: [String: String] = ["mosaic": "Mosaic", "halftone": "Halftone", "lowPoly": "Low Poly", "hatch": "Engraving"]
/// The most shapes a style may draw (`VECTOR_STYLIZE_MAX_SHAPES`).
public let VECTOR_STYLIZE_MAX_SHAPES = 60_000

/// Options of the styles, each using the ones that apply to it (`VectorStylizeOptions`).
public struct VectorStylizeOptions: Sendable {
    /// Cell size in pixels (default 12; hatch 6, halftone 8, low poly 24).
    public var cell: Double?
    /// Palette size, 2–32 (default 12; low poly 16).
    public var colors: Double?
    /// Mosaic: `square` (default) or `circle` tiles.
    public var shape: String?
    /// Mosaic: gap between tiles as a fraction of the cell, 0–0.9 (default 0.1).
    public var gap: Double?
    /// Halftone and hatch: the grid's turn in degrees (default 45).
    public var angle: Double?
    /// Halftone and hatch: one ink colour (default black).
    public var color: String?
    /// Halftone: `color: null`, keep the picture's colours.
    public var colorNull: Bool
    /// Low poly: how far grid points wander, as a fraction of the cell, 0–0.5 (default 0.35).
    public var jitter: Double?
    /// Low poly: seed of the wandering (default 1).
    public var seed: Double?

    public init(cell: Double? = nil, colors: Double? = nil, shape: String? = nil, gap: Double? = nil, angle: Double? = nil, color: String? = nil, colorNull: Bool = false,
                jitter: Double? = nil, seed: Double? = nil) {
        self.cell = cell
        self.colors = colors
        self.shape = shape
        self.gap = gap
        self.angle = angle
        self.color = color
        self.colorNull = colorNull
        self.jitter = jitter
        self.seed = seed
    }
}

/// `[r, g, b, a]`, unrounded.
private typealias Rgba = [Double]

/// The average colour around (cx, cy) in a box `size` wide, sampling at most 5 × 5 pixels.
private func sampleBox(_ px: VectorTracePixels, _ cx: Double, _ cy: Double, _ size: Double) -> Rgba {
    let (w, h, d) = (px.width, px.height, px.data)
    let n = Int(JS.max(1, JS.min(5, JS.round(size))))
    var s: Rgba = [0, 0, 0, 0]
    var count = 0
    for j in 0 ..< n {
        for i in 0 ..< n {
            let xf = JS.floor(cx - size / 2 + ((Double(i) + 0.5) * size) / Double(n))
            let yf = JS.floor(cy - size / 2 + ((Double(j) + 0.5) * size) / Double(n))
            if !(xf >= 0 && yf >= 0 && xf < Double(w) && yf < Double(h)) { continue }
            let k = (Int(yf) * w + Int(xf)) * 4
            let a = Double(d[k + 3])
            // Colour weighted by alpha, so transparent edges do not darken it.
            s[0] += Double(d[k]) * a
            s[1] += Double(d[k + 1]) * a
            s[2] += Double(d[k + 2]) * a
            s[3] += a
            count += 1
        }
    }
    if count == 0 || s[3] <= 0 { return [0, 0, 0, 0] }
    return [s[0] / s[3], s[1] / s[3], s[2] / s[3], s[3] / Double(count)]
}

private func darkness(_ c: Rgba) -> Double { (1 - (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255) * (c[3] / 255) }

private func hex(_ c: [Double]) -> String { vectorTraceHex(c.prefix(3).map { JS.min(255, JS.max(0, $0)) }) }

/// Colours of shapes reduced to a palette: each shape's palette index (−1: left out), and the palette.
private func paletteOf(_ colors: [Rgba], _ count: Double) -> (palette: [String], index: [Int16]) {
    var data = [UInt8](repeating: 0, count: colors.count * 4)
    for (i, c) in colors.enumerated() { for k in 0 ..< 4 { data[i * 4 + k] = JS.u8c(c[k]) } }
    let q = quantizeVectorTraceColors(VectorTracePixels(width: colors.count, height: 1, data: data), Int(JS.min(32, JS.max(2, JS.round(count)))))
    return (q.palette.map(hex), q.index)
}

private func styledNode(_ id: String, _ name: String, _ fill: String, _ subpaths: [VectorSubpath]) -> VectorNode {
    VectorNode(props: JSONObject([("id", .string(id)), ("type", "path"), ("name", .string(name)), ("fill", .string(fill)), ("stroke", .null)]), subpaths: subpaths)
}

/// One compound path per palette colour holding its shapes (most shapes at the bottom).
private func byColour(_ shapes: [[VectorSubpath]], _ palette: [String], _ index: [Int16], _ name: String) -> [VectorNode] {
    var groups = palette.map { _ in [VectorSubpath]() }
    for (i, s) in shapes.enumerated() where index[i] >= 0 { groups[Int(index[i])] += s }
    let kept = jsSorted(groups.indices.filter { !groups[$0].isEmpty }) { a, b in Double(groups[b].count - groups[a].count) }
    return kept.enumerated().map { n, k in styledNode("stylize-\(n)", "\(name) \(palette[k])", palette[k], groups[k]) }
}

private func check(_ px: VectorTracePixels, _ cell: Double) throws {
    let (w, h) = (px.width, px.height)
    if !(w > 0 && h > 0) || px.data.count < w * h * 4 { throw VectorImageError("The image has no pixels (or fewer than width × height × 4 values).") }
    if w * h > VECTOR_TRACE_MAX_PIXELS { throw VectorImageError("The image has \(w * h) pixels; scale it down to at most \(VECTOR_TRACE_MAX_PIXELS).") }
    if !(cell >= 1) { throw VectorImageError("cell must be at least 1 pixel.") }
}

private func tooMany(_ count: Double) throws {
    if count > Double(VECTOR_STYLIZE_MAX_SHAPES) { throw VectorImageError("That would draw about \(jsString(count)) shapes (at most \(VECTOR_STYLIZE_MAX_SHAPES)): use a larger cell.") }
}

private struct GridPoint {
    var x: Double, y: Double, row: Int, col: Int
}

/// The points of a grid turned by `angle` degrees that cover the image, `cell` apart.
private func turnedGrid(_ wi: Int, _ hi: Int, _ cell: Double, _ angle: Double) throws -> [GridPoint] {
    let (w, h) = (Double(wi), Double(hi))
    let a = (angle * Double.pi) / 180
    let c = JS.cos(a)
    let s = JS.sin(a)
    let cx = w / 2
    let cy = h / 2
    let reachD = JS.ceil(JS.hypot(w, h) / 2 / cell) + 1
    try tooMany(JS.pow(2 * reachD + 1, 2) * 0.7)
    let reach = Int(reachD)
    var out: [GridPoint] = []
    for j in -reach ... reach {
        for i in -reach ... reach {
            let x = cx + (Double(i) * c - Double(j) * s) * cell
            let y = cy + (Double(i) * s + Double(j) * c) * cell
            if x < -cell || y < -cell || x > w + cell || y > h + cell { continue }
            out.append(GridPoint(x: x, y: y, row: j, col: i))
        }
    }
    return out
}

/// Mosaic tiles: one square or circle per cell, coloured by the palette (`vectorMosaic`).
public func vectorMosaic(_ px: VectorTracePixels, _ o: VectorStylizeOptions = VectorStylizeOptions()) throws -> [VectorNode] {
    let cell = o.cell ?? 12
    try check(px, cell)
    let cols = Int(JS.ceil(Double(px.width) / cell))
    let rows = Int(JS.ceil(Double(px.height) / cell))
    try tooMany(Double(cols * rows))
    let gap = JS.min(0.9, JS.max(0, o.gap ?? 0.1)) * cell
    var colors: [Rgba] = []
    var shapes: [[VectorSubpath]] = []
    for r in 0 ..< rows {
        for c in 0 ..< cols {
            let color = sampleBox(px, (Double(c) + 0.5) * cell, (Double(r) + 0.5) * cell, cell)
            if color[3] < 128 { continue }
            let box = VectorBounds(x: Double(c) * cell + gap / 2, y: Double(r) * cell + gap / 2, width: cell - gap, height: cell - gap)
            colors.append(color)
            shapes.append([o.shape == "circle" ? ellipseSubpath(box) : rectSubpath(box)])
        }
    }
    if shapes.isEmpty { return [] }
    let (palette, index) = paletteOf(colors, o.colors ?? 12)
    return byColour(shapes, palette, index, "Mosaic")
}

/// Halftone dots: one per cell of a turned grid, its area following the darkness there (`vectorHalftone`).
public func vectorHalftone(_ px: VectorTracePixels, _ o: VectorStylizeOptions = VectorStylizeOptions()) throws -> [VectorNode] {
    let cell = o.cell ?? 8
    try check(px, cell)
    var colors: [Rgba] = []
    var shapes: [[VectorSubpath]] = []
    for p in try turnedGrid(px.width, px.height, cell, o.angle ?? 45) {
        if p.x < 0 || p.y < 0 || p.x >= Double(px.width) || p.y >= Double(px.height) { continue }
        let color = sampleBox(px, p.x, p.y, cell)
        // A dot's area follows the darkness; full darkness just touches its neighbours diagonally.
        let r = (cell / 2.0.squareRoot()) * darkness(color).squareRoot()
        if r < cell * 0.04 { continue }
        colors.append(color)
        shapes.append([ellipseSubpath(VectorBounds(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r))])
    }
    if shapes.isEmpty { return [] }
    if o.colorNull {
        let (palette, index) = paletteOf(colors, o.colors ?? 12)
        return byColour(shapes, palette, index, "Halftone")
    }
    return [styledNode("stylize-0", "Halftone", o.color ?? "#000000", shapes.flatMap { $0 })]
}

/// A hash of three integers to 0…1 (`hash01`: `Math.imul` on 32-bit integers).
private func hash01(_ a: Int, _ b: Int, _ seed: Double) -> Double {
    let ua = UInt32(truncatingIfNeeded: a), ub = UInt32(truncatingIfNeeded: b)
    let us = JS.u32(seed)
    var h = ((ua ^ 0x9E37_79B9) &* 0x85EB_CA6B) ^ ((ub ^ 0xC2B2_AE35) &* 0x27D4_EB2F) ^ (us &* 0x1656_67B1)
    h ^= h >> 15
    h = h &* 0x2C1B_3C6D
    h ^= h >> 12
    return Double(h) / 0xFFFF_FFFF
}

/// Low-poly triangles: a jittered grid split into triangles, each in the colour under it (`vectorLowPoly`).
public func vectorLowPoly(_ px: VectorTracePixels, _ o: VectorStylizeOptions = VectorStylizeOptions()) throws -> [VectorNode] {
    let cell = o.cell ?? 24
    try check(px, cell)
    let cols = Int(JS.max(1, JS.round(Double(px.width) / cell)))
    let rows = Int(JS.max(1, JS.round(Double(px.height) / cell)))
    try tooMany(Double(cols * rows * 2))
    let sx = Double(px.width) / Double(cols)
    let sy = Double(px.height) / Double(rows)
    let jitter = JS.min(0.5, JS.max(0, o.jitter ?? 0.35))
    let seed = JS.round(o.seed ?? 1)
    // Points on the image's edges stay on them.
    func pt(_ c: Int, _ r: Int) -> Vec2 {
        let jx = c == 0 || c == cols ? 0 : (hash01(c, r, seed) * 2 - 1) * jitter * sx
        let jy = r == 0 || r == rows ? 0 : (hash01(c, r, seed + 7919) * 2 - 1) * jitter * sy
        return Vec2(Double(c) * sx + jx, Double(r) * sy + jy)
    }
    var colors: [Rgba] = []
    var shapes: [[VectorSubpath]] = []
    func tri(_ a: Vec2, _ b: Vec2, _ c: Vec2) {
        let cx = (a.x + b.x + c.x) / 3
        let cy = (a.y + b.y + c.y) / 3
        let color = sampleBox(px, cx, cy, JS.min(sx, sy) * 0.6)
        if color[3] < 128 { return }
        colors.append(color)
        shapes.append([VectorSubpath(closed: true, anchors: [a, b, c].map { VectorAnchor(x: $0.x, y: $0.y) })])
    }
    for r in 0 ..< rows {
        for c in 0 ..< cols {
            let p00 = pt(c, r)
            let p10 = pt(c + 1, r)
            let p01 = pt(c, r + 1)
            let p11 = pt(c + 1, r + 1)
            // Alternate the diagonal so the triangles do not all lean one way.
            if (r + c) % 2 != 0 {
                tri(p00, p10, p11)
                tri(p00, p11, p01)
            } else {
                tri(p00, p10, p01)
                tri(p10, p11, p01)
            }
        }
    }
    if shapes.isEmpty { return [] }
    let (palette, index) = paletteOf(colors, o.colors ?? 16)
    // A hairline in the fill colour closes the seams between neighbouring colours.
    return byColour(shapes, palette, index, "Low Poly").map { n in
        var next = n
        next["stroke"] = n.fill
        next["strokeWidth"] = 0.5
        next["strokeLinejoin"] = "round"
        return next
    }
}

/// Engraving: lines along a turned grid that swell where the picture is dark and break where it is light (`vectorHatch`).
public func vectorHatch(_ px: VectorTracePixels, _ o: VectorStylizeOptions = VectorStylizeOptions()) throws -> [VectorNode] {
    let cell = o.cell ?? 6
    try check(px, cell)
    let a = ((o.angle ?? 45) * Double.pi) / 180
    let dir = Vec2(JS.cos(a), JS.sin(a))
    let nrm = Vec2(-dir.y, dir.x)
    let pts = try turnedGrid(px.width, px.height, cell, o.angle ?? 45)
    var rowOrder: [Int] = []
    var rows: [Int: [GridPoint]] = [:]
    for p in pts {
        if rows[p.row] == nil { rowOrder.append(p.row) }
        rows[p.row, default: []].append(p)
    }
    var subpaths: [VectorSubpath] = []
    let min = cell * 0.04
    for row in rowOrder {
        let list = jsSorted(rows[row]!) { p, q in Double(p.col - q.col) }
        // Runs of points dark enough to draw become ribbons: the half-width either side of the line.
        var run: [(x: Double, y: Double, t: Double)] = []
        func flush() {
            if run.count >= 2 {
                let top = run.map { VectorAnchor(x: $0.x + nrm.x * $0.t, y: $0.y + nrm.y * $0.t) }
                let bottom = run.map { VectorAnchor(x: $0.x - nrm.x * $0.t, y: $0.y - nrm.y * $0.t) }.reversed()
                subpaths.append(VectorSubpath(closed: true, anchors: top + bottom))
            }
            run = []
        }
        for p in list {
            let inside = p.x >= 0 && p.y >= 0 && p.x < Double(px.width) && p.y < Double(px.height)
            let t = inside ? cell * 0.45 * darkness(sampleBox(px, p.x, p.y, cell)) : 0
            if t < min {
                // Taper the end: the line closes at this point.
                if !run.isEmpty { run.append((p.x, p.y, 0)) }
                flush()
                continue
            }
            // A ribbon starts from a point (tapered start).
            if run.isEmpty { run.append((p.x - dir.x * cell, p.y - dir.y * cell, 0)) }
            run.append((p.x, p.y, t))
        }
        flush()
    }
    if subpaths.isEmpty { return [] }
    try tooMany(Double(subpaths.count))
    return [styledNode("stylize-0", "Hatch", o.color ?? "#000000", subpaths)]
}

/// Stylises pixels with `style` (`stylizeVectorImage`).
public func stylizeVectorImage(_ px: VectorTracePixels, _ style: String, _ options: VectorStylizeOptions = VectorStylizeOptions()) throws -> [VectorNode] {
    switch style {
    case "mosaic": return try vectorMosaic(px, options)
    case "halftone": return try vectorHalftone(px, options)
    case "lowPoly": return try vectorLowPoly(px, options)
    case "hatch": return try vectorHatch(px, options)
    default: return []
    }
}
