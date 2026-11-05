import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Gradient meshes and freeform gradients (`vector/shading.ts`): paints that are not a function of
// one parameter, drawn as SVG patterns of small flat tiles. Meshes are lattices of Coons patches
// whose sides are Catmull-Rom curves through the points, coloured by blending each patch's
// corners. Freeform gradients follow vectorcraft's `Field::sample`: each point paints a disc of
// pure colour of its spread and blends into the others by inverse-square distance from the disc's
// edge; a line is a Catmull-Rom curve whose pieces each act as a source.
//
// Paints stay JSON (`{ type: "mesh", rows, columns, points, colors, opacities? }` and
// `{ type: "freeform", points: [{ x, y, color, opacity?, spread? }], lines? }`), as in documents.

/// The most rows or columns a mesh has (`VECTOR_MESH_MAX`).
public let VECTOR_MESH_MAX = 32

@inline(__always) private func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }

/// A colour's channels with its alpha times `opacity` (unreadable colours are black).
private func rgbaOf(_ color: JSONValue?, _ opacity: Double = 1) -> VectorRgba {
    let c = color?.stringValue.flatMap(parseVectorColor) ?? [0, 0, 0, 1]
    return [c[0], c[1], c[2], c[3] * opacity]
}

private func hex2(_ v: Double) -> String {
    let n = Int(JS.round(Swift.min(1, Swift.max(0, v)) * 255))
    return (n < 16 ? "0" : "") + String(n, radix: 16)
}

/// A CSS colour for straight-alpha channels: `#rrggbb`, or `rgba()` when not opaque (`vectorRgbaToCss`).
public func vectorRgbaToCss(_ c: VectorRgba) -> String {
    if c[3] >= 0.9995 { return "#\(hex2(c[0]))\(hex2(c[1]))\(hex2(c[2]))" }
    func ch(_ v: Double) -> String { JSONValue.jsNumber(JS.round(Swift.min(1, Swift.max(0, v)) * 255)) }
    let a = JS.round(Swift.max(0, c[3]) * 1000) / 1000
    return "rgba(\(ch(c[0])),\(ch(c[1])),\(ch(c[2])),\(JSONValue.jsNumber(a)))"
}

private func pointOf(_ p: JSONValue?) -> Vec2 { Vec2(p?["x"]?.numberValue ?? .nan, p?["y"]?.numberValue ?? .nan) }

/// `x` / `y` of a point as JSON.
private func xy(_ p: Vec2) -> JSONValue { .object(JSONObject([("x", .number(p.x)), ("y", .number(p.y))])) }

// MARK: - Meshes

/// A mesh over `bounds` with `rows` × `columns` patches, its points evenly spread
/// (`createVectorMeshGradient`). Colours come from `colors` row by row, or the four `corners`
/// (top-left, top-right, bottom-right, bottom-left) blended across, or white.
public func createVectorMeshGradient(_ bounds: VectorBounds, _ rows: Double, _ columns: Double, colors: [String]? = nil, corners: [String]? = nil) -> JSONObject {
    let r = Int(Swift.min(Double(VECTOR_MESH_MAX), Swift.max(1, JS.round(rows))))
    let c = Int(Swift.min(Double(VECTOR_MESH_MAX), Swift.max(1, JS.round(columns))))
    var points: [JSONValue] = []
    var out: [JSONValue] = []
    let cornerColours = corners?.map { rgbaOf(.string($0)) }
    for i in 0 ... r {
        for j in 0 ... c {
            points.append(xy(Vec2(bounds.x + (bounds.width * Double(j)) / Double(c), bounds.y + (bounds.height * Double(i)) / Double(r))))
            let k = i * (c + 1) + j
            if let colors, k < colors.count, !colors[k].isEmpty {
                out.append(.string(colors[k]))
            } else if let cc = cornerColours {
                let u = Double(j) / Double(c)
                let v = Double(i) / Double(r)
                let top = (0 ..< 4).map { lerp(cc[0][$0], cc[1][$0], u) }
                let bottom = (0 ..< 4).map { lerp(cc[3][$0], cc[2][$0], u) }
                out.append(.string(vectorRgbaToCss((0 ..< 4).map { lerp(top[$0], bottom[$0], v) })))
            } else {
                out.append("#ffffff")
            }
        }
    }
    return JSONObject([("type", "mesh"), ("rows", .number(Double(r))), ("columns", .number(Double(c))), ("points", .array(points)), ("colors", .array(out))])
}

/// A Catmull-Rom cubic through `p1` to `p2` (neighbours `p0`, `p3`): its four control points.
private func catmull(_ p0: Vec2, _ p1: Vec2, _ p2: Vec2, _ p3: Vec2) -> [Vec2] {
    [p1, Vec2(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6), Vec2(p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6), p2]
}

private func cubicAt(_ c: [Vec2], _ t: Double) -> Vec2 {
    let s = 1 - t
    let a = s * s * s
    let b = 3 * s * s * t
    let d = 3 * s * t * t
    let e = t * t * t
    return Vec2(a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x, a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y)
}

/// A mesh read once for sampling.
private struct Mesh {
    var rows: Int
    var columns: Int
    var points: [Vec2]
    var colors: [JSONValue]
    var opacities: [JSONValue]?

    /// Nil when the arrays do not match rows × columns (`meshOk`).
    init?(_ m: JSONObject) {
        let rows = m["rows"]?.numberValue ?? .nan
        let columns = m["columns"]?.numberValue ?? .nan
        let points = m["points"]?.arrayValue ?? []
        let colors = m["colors"]?.arrayValue ?? []
        let n = (rows + 1) * (columns + 1)
        guard rows >= 1, columns >= 1, Double(points.count) == n, Double(colors.count) == n else { return nil }
        self.rows = Int(rows)
        self.columns = Int(columns)
        self.points = points.map(pointOf)
        self.colors = colors
        opacities = m["opacities"]?.arrayValue
    }

    /// The lattice point at row `r`, column `c`, extended by one point past each edge in a
    /// straight line (`meshLattice`).
    func P(_ r: Int, _ c: Int) -> Vec2 {
        func ext(_ a: Vec2, _ b: Vec2) -> Vec2 { Vec2(2 * a.x - b.x, 2 * a.y - b.y) }
        if r < 0 { return ext(P(0, c), P(1, c)) }
        if r > rows { return ext(P(rows, c), P(rows - 1, c)) }
        if c < 0 { return ext(at(r, 0), at(r, 1)) }
        if c > columns { return ext(at(r, columns), at(r, columns - 1)) }
        return at(r, c)
    }

    private func at(_ r: Int, _ c: Int) -> Vec2 {
        let k = r * (columns + 1) + c
        return points.indices.contains(k) ? points[k] : Vec2(.nan, .nan)
    }

    func pointAt(_ i: Int, _ j: Int, _ u: Double, _ v: Double) -> Vec2 {
        // The patch's sides: Catmull-Rom curves along its rows and columns of the lattice.
        let top = catmull(P(i, j - 1), P(i, j), P(i, j + 1), P(i, j + 2))
        let bottom = catmull(P(i + 1, j - 1), P(i + 1, j), P(i + 1, j + 1), P(i + 1, j + 2))
        let left = catmull(P(i - 1, j), P(i, j), P(i + 1, j), P(i + 2, j))
        let right = catmull(P(i - 1, j + 1), P(i, j + 1), P(i + 1, j + 1), P(i + 2, j + 1))
        let t = cubicAt(top, u)
        let b = cubicAt(bottom, u)
        let l = cubicAt(left, v)
        let r = cubicAt(right, v)
        let (p00, p01, p11, p10) = (P(i, j), P(i, j + 1), P(i + 1, j + 1), P(i + 1, j))
        // Coons: the two ruled surfaces minus the bilinear one.
        let blx = (1 - u) * (1 - v) * p00.x + u * (1 - v) * p01.x + u * v * p11.x + (1 - u) * v * p10.x
        let bly = (1 - u) * (1 - v) * p00.y + u * (1 - v) * p01.y + u * v * p11.y + (1 - u) * v * p10.y
        return Vec2((1 - v) * t.x + v * b.x + (1 - u) * l.x + u * r.x - blx, (1 - v) * t.y + v * b.y + (1 - u) * l.y + u * r.y - bly)
    }

    func colorAt(_ i: Int, _ j: Int, _ u: Double, _ v: Double) -> VectorRgba {
        let cols = columns + 1
        func C(_ r: Int, _ c: Int) -> VectorRgba {
            let k = r * cols + c
            let op = opacities.flatMap { $0.indices.contains(k) ? $0[k] : nil }
            return rgbaOf(colors.indices.contains(k) ? colors[k] : nil, op.flatMap { $0 == .null ? nil : ($0.numberValue ?? .nan) } ?? 1)
        }
        let a = C(i, j)
        let b = C(i, j + 1)
        let c = C(i + 1, j + 1)
        let d = C(i + 1, j)
        return (0 ..< 4).map { k in (1 - u) * (1 - v) * a[k] + u * (1 - v) * b[k] + u * v * c[k] + (1 - u) * v * d[k] }
    }
}

/// The point of the mesh's surface at patch (i, j), parameters (u, v) 0–1 (`vectorMeshPointAt`).
public func vectorMeshPointAt(_ m: JSONObject, _ i: Int, _ j: Int, _ u: Double, _ v: Double) -> Vec2? {
    Mesh(m)?.pointAt(i, j, u, v)
}

/// The mesh's colour (straight alpha) at patch (i, j), parameters (u, v) (`vectorMeshColorAt`).
public func vectorMeshColorAt(_ m: JSONObject, _ i: Int, _ j: Int, _ u: Double, _ v: Double) -> VectorRgba? {
    Mesh(m)?.colorAt(i, j, u, v)
}

/// The mesh's lattice curves for drawing its lines (`vectorMeshLines`): per row and per column of
/// points, the cubic of each patch side.
public func vectorMeshLines(_ m: JSONObject) -> (rows: [[[Vec2]]], columns: [[[Vec2]]])? {
    guard let mesh = Mesh(m) else { return nil }
    let P = mesh.P
    let rows = (0 ... mesh.rows).map { i in (0 ..< mesh.columns).map { j in catmull(P(i, j - 1), P(i, j), P(i, j + 1), P(i, j + 2)) } }
    let columns = (0 ... mesh.columns).map { j in (0 ..< mesh.rows).map { i in catmull(P(i - 1, j), P(i, j), P(i + 1, j), P(i + 2, j)) } }
    return (rows, columns)
}

// MARK: - Freeform gradients

/// Pieces each line segment is tessellated into for sampling.
private let LINE_STEPS = 16

/// A colour source of a freeform field.
public struct VectorFreeformSource: Equatable, Sendable {
    var x: Double
    var y: Double
    var c: VectorRgba
    var radius: Double
}

private func lerpSource(_ a: VectorFreeformSource, _ b: VectorFreeformSource, _ t: Double) -> VectorFreeformSource {
    VectorFreeformSource(x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), c: (0 ..< 4).map { lerp(a.c[$0], b.c[$0], t) }, radius: lerp(a.radius, b.radius, t))
}

/// The length freeform spreads are fractions of: half the longer side of the box (`vectorFreeformSpreadScale`).
public func vectorFreeformSpreadScale(_ bounds: VectorBounds) -> Double { Swift.max(abs(bounds.width), abs(bounds.height)) / 2 }

/// A whole-number index into a list of `count`, or nil.
private func indexOf(_ v: JSONValue, _ count: Int) -> Int? {
    guard let n = v.numberValue, n.isFinite, n == n.rounded(), n >= 0, n < Double(count) else { return nil }
    return Int(n)
}

/// The cubic segments of line `line` of a freeform gradient, a Catmull-Rom curve through its
/// points; empty for a line naming a missing point (`vectorFreeformLineSegments`).
public func vectorFreeformLineSegments(_ f: JSONObject, _ line: Int) -> [[Vec2]] {
    guard let lines = f["lines"]?.arrayValue, lines.indices.contains(line), let ix = lines[line].arrayValue else { return [] }
    let points = f["points"]?.arrayValue ?? []
    var pts: [Vec2] = []
    for i in ix {
        guard let k = indexOf(i, points.count), points[k] != .null else { return [] }
        pts.append(pointOf(points[k]))
    }
    let n = pts.count
    var out: [[Vec2]] = []
    var i = 0
    while i + 1 < n {
        out.append(catmull(pts[Swift.max(0, i - 1)], pts[i], pts[i + 1], pts[Swift.min(n - 1, i + 2)]))
        i += 1
    }
    return out
}

/// A freeform gradient ready to sample many spots (`VectorFreeformField`).
public struct VectorFreeformField: Sendable {
    var points: [VectorFreeformSource]
    var pieces: [(a: VectorFreeformSource, b: VectorFreeformSource, share: Double)]
    var eps: Double
}

/// The colour field of a freeform gradient on a box whose spread scale is `scale` (`vectorFreeformField`).
public func vectorFreeformField(_ f: JSONObject, _ scale: Double) -> VectorFreeformField {
    let raw = f["points"]?.arrayValue ?? []
    let points = raw.map { p -> VectorFreeformSource in
        let q = pointOf(p)
        let opacity = p["opacity"].flatMap { $0 == .null ? nil : ($0.numberValue ?? .nan) } ?? 1
        let spread = p["spread"].flatMap { $0 == .null ? nil : ($0.numberValue ?? .nan) } ?? 0
        return VectorFreeformSource(x: q.x, y: q.y, c: rgbaOf(p["color"], opacity), radius: Swift.min(1, Swift.max(0, spread)) * scale)
    }
    var pieces: [(a: VectorFreeformSource, b: VectorFreeformSource, share: Double)] = []
    for (l, line) in (f["lines"]?.arrayValue ?? []).enumerated() {
        var v: [VectorFreeformSource] = []
        let ix = line.arrayValue ?? []
        for (s, c) in vectorFreeformLineSegments(f, l).enumerated() {
            let a = points[indexOf(ix[s], points.count)!]
            let b = points[indexOf(ix[s + 1], points.count)!]
            for k in (s == 0 ? 0 : 1) ... LINE_STEPS {
                let t = Double(k) / Double(LINE_STEPS)
                let at = cubicAt(c, t)
                var src = lerpSource(a, b, t)
                src.x = at.x
                src.y = at.y
                v.append(src)
            }
        }
        var len = 0.0
        for k in v.indices.dropFirst() { len += JS.hypot(v[k].x - v[k - 1].x, v[k].y - v[k - 1].y) }
        let n = Double(Swift.max(1, v.count - 1))
        for k in v.indices.dropFirst() {
            let d = JS.hypot(v[k].x - v[k - 1].x, v[k].y - v[k - 1].y)
            pieces.append((v[k - 1], v[k], len > 0 ? d / len : 1 / n))
        }
    }
    return VectorFreeformField(points: points, pieces: pieces, eps: 1e-9 * (abs(scale) + 1))
}

/// The freeform field's colour at `p` (straight alpha, 0–1) (`sampleVectorFreeform`).
public func sampleVectorFreeform(_ field: VectorFreeformField, _ p: Vec2) -> VectorRgba {
    var discW = 0.0, farW = 0.0
    var disc: [Double] = [0, 0, 0, 0]
    var far: [Double] = [0, 0, 0, 0]
    func add(_ d: Double, _ s: VectorFreeformSource, _ share: Double) {
        if d < s.radius || d <= field.eps {
            // The deeper inside a disc, the stronger: weights fade to nothing at its edge.
            let w = (s.radius - d + field.eps) * share
            discW += w
            for k in 0 ..< 4 { disc[k] += w * s.c[k] }
        } else {
            let e = d - s.radius
            let w = share / (e * e)
            farW += w
            for k in 0 ..< 4 { far[k] += w * s.c[k] }
        }
    }
    for s in field.points { add(JS.hypot(s.x - p.x, s.y - p.y), s, 1) }
    for piece in field.pieces {
        let vx = piece.b.x - piece.a.x
        let vy = piece.b.y - piece.a.y
        let l2 = vx * vx + vy * vy
        let t = l2 > 0 ? Swift.min(1, Swift.max(0, ((p.x - piece.a.x) * vx + (p.y - piece.a.y) * vy) / l2)) : 0
        let s = lerpSource(piece.a, piece.b, t)
        add(JS.hypot(s.x - p.x, s.y - p.y), s, piece.share)
    }
    let (w, c) = discW > 0 ? (discW, disc) : (farW, far)
    if !(w > 0 && w.isFinite) { return [0, 0, 0, 0] }
    return c.map { $0 / w }
}

/// The points a first freeform gradient gets on a shape with box `b`: a 2 × n grid, each moved to
/// the nearest spot `inside` the shape when its place is not, coloured along `colors`
/// (`autoVectorFreeformGradient`).
public func autoVectorFreeformGradient(_ b: VectorBounds, _ colors: [String], inside: (Vec2) -> Bool = { _ in true }) -> JSONObject {
    let w = Swift.max(b.width, 1e-9)
    let h = Swift.max(b.height, 1e-9)
    let long = Int(Swift.min(4, Swift.max(2, JS.round((2 * Swift.max(w, h)) / Swift.min(w, h)))))
    let (cols, rows) = w >= h ? (long, 2) : (2, long)
    func cell(_ i: Int, _ n: Int) -> Double { (Double(i) + 0.5) / Double(n) }
    var targets: [Vec2] = []
    // Row by row, every other row backwards: neighbours in the list are neighbours on the art.
    for j in 0 ..< rows { for k in 0 ..< cols { targets.append(Vec2(b.x + cell(j % 2 == 0 ? k : cols - 1 - k, cols) * w, b.y + cell(j, rows) * h)) } }
    let GRID = 24
    var candidates: [Vec2] = []
    for k in 0 ..< GRID * GRID {
        let p = Vec2(b.x + cell(k % GRID, GRID) * w, b.y + cell(k / GRID, GRID) * h)
        if inside(p) { candidates.append(p) }
    }
    let apart = Swift.min(w, h) * 0.15
    var placed: [Vec2] = []
    for t in targets {
        var at = t
        if !inside(t) {
            var best: Vec2?
            var bestD = Double.infinity
            for c in candidates {
                if !placed.allSatisfy({ JS.hypot($0.x - c.x, $0.y - c.y) >= apart }) { continue }
                let d = JS.hypot(c.x - t.x, c.y - t.y)
                if d < bestD {
                    best = c
                    bestD = d
                }
            }
            at = best ?? t
        }
        placed.append(at)
    }
    let palette = colors.isEmpty ? ["#ffffff", "#000000"] : colors
    let n = placed.count
    func colorAt(_ k: Int) -> String {
        if palette.count == 1 { return palette[0] }
        let t = (Double(k) / Double(Swift.max(1, n - 1))) * Double(palette.count - 1)
        let i = Swift.min(palette.count - 2, Int(Foundation.floor(t)))
        let a = rgbaOf(.string(palette[i]))
        let c = rgbaOf(.string(palette[i + 1]))
        return vectorRgbaToCss((0 ..< 4).map { lerp(a[$0], c[$0], t - Double(i)) })
    }
    let points: [JSONValue] = placed.enumerated().map { k, p in .object(JSONObject([("x", .number(p.x)), ("y", .number(p.y)), ("color", .string(colorAt(k)))])) }
    return JSONObject([("type", "freeform"), ("points", .array(points))])
}

// MARK: - Rendering

private func quadD(_ pts: [Vec2], _ precision: Int) -> String {
    "M" + pts.map { "\(gradientFmt($0.x, precision)) \(gradientFmt($0.y, precision))" }.joined(separator: "L") + "Z"
}

/// A mesh or freeform paint as an SVG `<pattern>` of small flat tiles in the painted element's
/// user space (`vectorShadedSvgDefs`). `bounds` is the shape's box in its own space, `area` what
/// the pattern covers (default `bounds` padded by 1), `meshCells` cells per mesh patch side
/// (default 8), `freeformCells` strips across a freeform gradient's longer side (default 96).
public func vectorShadedSvgDefs(_ paint: JSONObject, _ id: String, bounds: VectorBounds? = nil, area areaIn: VectorBounds? = nil, meshCells: Double? = nil, freeformCells: Double? = nil, precision: Int? = nil) -> [VectorPaintDef] {
    let precision = precision ?? 3
    let area = areaIn ?? bounds.map { padBounds($0, 1) } ?? VectorBounds(x: 0, y: 0, width: 1, height: 1)
    var tiles: [(d: String, fill: String)] = []
    var gradients: [SvgGradientDef] = []
    let points = paint["points"]?.arrayValue ?? []
    if isVectorMeshGradient(.object(paint)) {
        if let mesh = Mesh(paint) {
            let k = Int(Swift.max(1, Swift.min(32, JS.round(meshCells ?? 8))))
            for i in 0 ..< mesh.rows {
                for j in 0 ..< mesh.columns {
                    let grid = (0 ... k).map { a in (0 ... k).map { b in mesh.pointAt(i, j, Double(b) / Double(k), Double(a) / Double(k)) } }
                    for a in 0 ..< k {
                        for b in 0 ..< k {
                            let c = mesh.colorAt(i, j, (Double(b) + 0.5) / Double(k), (Double(a) + 0.5) / Double(k))
                            if c[3] <= 0.0005 { continue }
                            // Grown a little past its right and bottom edges, over the cells drawn after it.
                            let q = [grid[a][b], grid[a][b + 1], grid[a + 1][b + 1], grid[a + 1][b]]
                            let cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4
                            let cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4
                            tiles.append((quadD(q.map { Vec2(cx + ($0.x - cx) * 1.12, cy + ($0.y - cy) * 1.12) }, precision), vectorRgbaToCss(c)))
                        }
                    }
                }
            }
        }
    } else if let bounds, !points.isEmpty {
        // Horizontal strips, each a linear gradient through the field sampled across it.
        let field = vectorFreeformField(paint, vectorFreeformSpreadScale(bounds))
        let n = Swift.max(2, Swift.min(256, JS.round(freeformCells ?? 96)))
        let side = Swift.max(area.width, area.height, 1e-9)
        let rows = Int(Swift.max(2, Foundation.ceil((n * area.height) / side)))
        let samples = Int(Swift.max(2, Swift.min(96, Foundation.ceil((n * area.width) / side) + 1)))
        let ch = area.height / Double(rows)
        for r in 0 ..< rows {
            let y = area.y + Double(r) * ch
            var stops: [SvgGradientStop] = []
            for k in 0 ..< samples {
                let t = Double(k) / Double(samples - 1)
                let c = sampleVectorFreeform(field, Vec2(area.x + t * area.width, y + ch / 2))
                let opaque = vectorRgbaToCss([c[0], c[1], c[2], 1])
                stops.append(SvgGradientStop(offset: "\(gradientFmt(t * 100, 3))%", stopColor: opaque, stopOpacity: c[3] < 0.9995 ? JS.round(Swift.max(0, c[3]) * 1000) / 1000 : nil))
            }
            let gid = "\(id)-r\(r)"
            let attrs = JSONObject([("gradientUnits", "userSpaceOnUse"), ("x1", .string(gradientFmt(area.x, precision))), ("y1", "0"), ("x2", .string(gradientFmt(area.x + area.width, precision))), ("y2", "0")])
            gradients.append(SvgGradientDef(id: gid, type: "linear", attrs: attrs, stops: stops))
            // Each strip reaches a quarter into the next, so no seam shows between them.
            let h = r < rows - 1 ? ch * 1.25 : ch
            tiles.append((quadD([Vec2(area.x, y), Vec2(area.x + area.width, y), Vec2(area.x + area.width, y + h), Vec2(area.x, y + h)], precision), "url(#\(gid))"))
        }
    }
    return [.pattern(VectorSvgPatternDef(id: id, attrs: patternAttrs(area), gradients: gradients, tiles: tiles))]
}

// MARK: - Transforms, sanitizing and editing

/// A mesh or freeform paint with every point mapped by `f` (`mapVectorShadedPaint`): mesh points
/// become `{ x, y }`, freeform points keep their other fields.
public func mapVectorShadedPaint(_ paint: JSONObject, _ f: (Vec2) -> Vec2) -> JSONObject {
    var out = paint
    let points = paint["points"]?.arrayValue ?? []
    if isVectorMeshGradient(.object(paint)) {
        out["points"] = .array(points.map { xy(f(pointOf($0))) })
    } else {
        out["points"] = .array(points.map { p in
            let q = f(pointOf(p))
            var o = p.objectValue ?? JSONObject()
            o["x"] = .number(q.x)
            o["y"] = .number(q.y)
            return .object(o)
        })
    }
    return out
}

/// A mesh or freeform paint moved by `m` (it lives in the node's own space).
public func transformVectorShadedPaint(_ paint: JSONObject, _ m: VectorMatrix) -> JSONObject {
    mapVectorShadedPaint(paint) { applyMatrix(m, $0) }
}

private func finiteNumber(_ v: JSONValue?) -> Double? { v?.numberValue.flatMap { $0.isFinite ? $0 : nil } }

/// A colour string `parseVectorColor` reads, as given.
private func colourString(_ v: JSONValue?) -> String? { v?.stringValue.flatMap { parseVectorColor($0) != nil ? $0 : nil } }

/// A mesh or freeform paint from untrusted input (agent commands, SVG data attributes), or nil
/// when it is malformed (`sanitizeVectorShadedPaint`).
public func sanitizeVectorShadedPaint(_ input: JSONValue?) -> JSONObject? {
    guard let r = input?.objectValue else { return nil }
    if r["type"] == "mesh" {
        guard let rows = finiteNumber(r["rows"]), let columns = finiteNumber(r["columns"]), rows >= 1, columns >= 1,
              rows <= Double(VECTOR_MESH_MAX), columns <= Double(VECTOR_MESH_MAX), rows == rows.rounded(), columns == columns.rounded() else { return nil }
        let n = Int((rows + 1) * (columns + 1))
        guard let rawPoints = r["points"]?.arrayValue, let rawColors = r["colors"]?.arrayValue, rawPoints.count == n, rawColors.count == n else { return nil }
        var points: [JSONValue] = []
        for p in rawPoints {
            guard let x = finiteNumber(p["x"]), let y = finiteNumber(p["y"]), p.objectValue != nil else { return nil }
            points.append(xy(Vec2(x, y)))
        }
        var colors: [JSONValue] = []
        for c in rawColors {
            guard let k = colourString(c) else { return nil }
            colors.append(.string(k))
        }
        var out = JSONObject([("type", "mesh"), ("rows", .number(rows)), ("columns", .number(columns)), ("points", .array(points)), ("colors", .array(colors))])
        if let ops = r["opacities"]?.arrayValue, ops.count == n, ops.allSatisfy({ finiteNumber($0) != nil }) {
            out["opacities"] = .array(ops.map { .number(Swift.min(1, Swift.max(0, $0.numberValue!))) })
        }
        return out
    }
    if r["type"] == "freeform" {
        guard let raw = r["points"]?.arrayValue, !raw.isEmpty else { return nil }
        var points: [JSONValue] = []
        for p in raw {
            guard p.objectValue != nil, let x = finiteNumber(p["x"]), let y = finiteNumber(p["y"]), let c = colourString(p["color"]) else { return nil }
            var o = JSONObject([("x", .number(x)), ("y", .number(y)), ("color", .string(c))])
            if let op = finiteNumber(p["opacity"]), op < 1 { o["opacity"] = .number(Swift.max(0, op)) }
            if let s = finiteNumber(p["spread"]), s > 0 { o["spread"] = .number(Swift.min(1, s)) }
            points.append(.object(o))
        }
        var out = JSONObject([("type", "freeform"), ("points", .array(points))])
        if let rawLines = r["lines"]?.arrayValue {
            let lines = rawLines.filter { l in
                guard let ix = l.arrayValue, ix.count >= 2 else { return false }
                guard ix.allSatisfy({ indexOf($0, points.count) != nil }) else { return false }
                return ix.indices.dropFirst().allSatisfy { ix[$0].numberValue != ix[$0 - 1].numberValue }
            }
            if !lines.isEmpty { out["lines"] = .array(lines) }
        }
        return out
    }
    return nil
}

/// A freeform gradient with point `index` removed (lines through it close up; lines left with
/// one point go), or nil when it is the last point (`removeVectorFreeformPoint`).
public func removeVectorFreeformPoint(_ f: JSONObject, _ index: Int) -> JSONObject? {
    let points = f["points"]?.arrayValue ?? []
    if index < 0 || index >= points.count || points.count <= 1 { return nil }
    let kept = points.enumerated().filter { $0.offset != index }.map(\.element)
    let lines: [JSONValue] = (f["lines"]?.arrayValue ?? []).compactMap { l in
        let mapped = (l.arrayValue ?? []).compactMap(\.numberValue).filter { $0 != Double(index) }.map { $0 > Double(index) ? $0 - 1 : $0 }
        let closed = mapped.enumerated().filter { $0.offset == 0 || $0.element != mapped[$0.offset - 1] }.map(\.element)
        return closed.count >= 2 ? .array(closed.map { .number($0) }) : nil
    }
    var out = JSONObject([("type", "freeform"), ("points", .array(kept))])
    if !lines.isEmpty { out["lines"] = .array(lines) }
    return out
}

/// The point of a mesh or freeform paint nearest `p` within `radius`: its index, or -1
/// (`nearestVectorShadingPoint`).
public func nearestVectorShadingPoint(_ paint: JSONObject, _ p: Vec2, _ radius: Double) -> Int {
    var best = -1
    var bestD = radius
    for (k, q) in (paint["points"]?.arrayValue ?? []).enumerated() {
        let pt = pointOf(q)
        let d = JS.hypot(pt.x - p.x, pt.y - p.y)
        if d <= bestD {
            best = k
            bestD = d
        }
    }
    return best
}
