import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Warp geometry for envelope distortion (`geom/warp.ts` and the envelope helpers of
// `vector/warp.ts`): preset warp styles and editable Bézier meshes, both forward maps from a
// source box onto the node's space. Presets are one bicubic patch whose 4 × 4 control grid follows
// the bend; meshes are grids of bicubic patches, split exactly by de Casteljau.
//
// Ported from ArtCraft (MIT OR Apache-2.0, © ArtCraft Team and contributors; see
// THIRD_PARTY_NOTICES.md): photocraft `crates/geom/src/warp.rs`. The arcs use `JS.sin` / `JS.cos`
// and Foundation's `tan` (V8's is not ported), so presets compare within the trig tolerance.
// The interactive mesh edits (`dragWarpMeshPoint`, `pullWarpMesh`, `warpMeshParamAt`, the edit
// points and grid curves) belong to the Envelope tool, which is not ported.

/// A grid of bicubic Bézier patches (`WarpMesh`): patch boundaries `us` / `vs` (box fractions,
/// 0 to 1) and `(3·columns + 1) × (3·rows + 1)` control points, row by row.
public struct VectorWarpMesh: Equatable, Sendable {
    public var us: [Double]
    public var vs: [Double]
    public var points: [Vec2]

    public init(us: [Double], vs: [Double], points: [Vec2]) {
        self.us = us
        self.vs = vs
        self.points = points
    }

    /// `{ us, vs, points }`.
    public var json: JSONValue {
        .object(JSONObject([("us", .array(us.map { .number($0) })), ("vs", .array(vs.map { .number($0) })), ("points", .array(points.map(\.json)))]))
    }

    /// A mesh from JSON when it is well formed (`isValidWarpMesh`), else nil.
    public init?(json: JSONValue?) {
        guard isValidVectorMesh(json), let o = json?.objectValue else { return nil }
        us = o["us"]!.arrayValue!.map { $0.numberValue! }
        vs = o["vs"]!.arrayValue!.map { $0.numberValue! }
        points = o["points"]!.arrayValue!.map { Vec2(json: $0)! }
    }
}

/// Labels of the fifteen presets (`WARP_STYLE_LABELS`).
public let VECTOR_WARP_STYLE_LABELS: [String: String] = [
    "arc": "Arc", "arcLower": "Arc Lower", "arcUpper": "Arc Upper", "arch": "Arch", "bulge": "Bulge", "shellLower": "Shell Lower", "shellUpper": "Shell Upper",
    "flag": "Flag", "wave": "Wave", "fish": "Fish", "rise": "Rise", "fisheye": "Fisheye", "inflate": "Inflate", "squeeze": "Squeeze", "twist": "Twist",
]

private typealias P = (Double, Double)
/// A single patch's control grid, `[row][column]`, in box units (0–1, y down).
private typealias Grid = [[P]]

/// The rest grid (no warp).
private func restGrid() -> Grid { (0 ..< 4).map { j in (0 ..< 4).map { i in (Double(i) / 3, Double(j) / 3) } } }

/// A horizontal edge at height `y` bent into a circular arc of `|b|·π` that keeps its chord,
/// bowing up when `up == (b > 0)`; `h` is the box's height over its width.
private func edgeArc(_ y: Double, _ b: Double, _ up: Bool, _ h: Double) -> [P] {
    if abs(b) < 1e-9 { return (0 ..< 4).map { i in (Double(i) / 3, y) } }
    let th = abs(b) * Double.pi
    let k = (((4.0 / 3) * Foundation.tan(th / 4)) * 0.5) / JS.sin(th / 2)
    let s: Double = (b > 0) == up ? -1 : 1
    let c = JS.cos(th / 2)
    let n = JS.sin(th / 2)
    let dy = (s * k * n) / h
    return [(0, y), (k * c, y + dy), (1 - k * c, y + dy), (1, y)]
}

/// Arc: every row is a circular arc of `|b|·π` around one centre (`arcGrid`).
private func arcGrid(_ b: Double, _ h: Double) -> Grid {
    if abs(b) < 1e-9 { return restGrid() }
    let up = b > 0
    let th = abs(b) * Double.pi
    let r = 0.5 / JS.sin(th / 2)
    let k = (4.0 / 3) * Foundation.tan(th / 4)
    let s: Double = up ? -1 : 1
    let cy = up ? h + r * JS.cos(th / 2) : -r * JS.cos(th / 2)
    return (0 ..< 4).map { j in
        let v = Double(j) / 3
        let big = r + h * (up ? 1 - v : v)
        func at(_ a: Double) -> P { (0.5 + big * JS.sin(a), cy + s * big * JS.cos(a)) }
        func tangent(_ a: Double) -> P { (JS.cos(a), -s * JS.sin(a)) }
        let p0 = at(-th / 2)
        let p3 = at(th / 2)
        let t0 = tangent(-th / 2)
        let t1 = tangent(th / 2)
        let l = k * big
        let pts: [P] = [p0, (p0.0 + l * t0.0, p0.1 + l * t0.1), (p3.0 - l * t1.0, p3.1 - l * t1.1), p3]
        return pts.map { ($0.0, $0.1 / h) }
    }
}

/// Rows blended from `top` to `bottom`.
private func blendRows(_ top: [P], _ bottom: [P]) -> Grid {
    (0 ..< 4).map { j in
        let t = Double(j) / 3
        return (0 ..< 4).map { i in (top[i].0 + (bottom[i].0 - top[i].0) * t, top[i].1 + (bottom[i].1 - top[i].1) * t) }
    }
}

private let INNER: [(Int, Int, Double, Double)] = [(1, 1, -1, -1), (1, 2, 1, -1), (2, 1, -1, 1), (2, 2, 1, 1)]

/// A preset as a Bézier control grid (rows of `[x, y]` in box units, y down; `warpPresetGrid`).
/// `b`, `hd`, `vd` are the bend and distortions as fractions (−1…1); `aspect` is height over width.
public func vectorWarpPresetGrid(_ style: String, _ b: Double, _ hdIn: Double, _ vdIn: Double, _ vertical: Bool, _ aspect: Double) -> [[[Double]]] {
    let h = vertical ? 1 / aspect : aspect
    var hd = hdIn
    var vd = vdIn
    if vertical { swap(&hd, &vd) }
    var g = restGrid()
    switch style {
    case "arc": g = arcGrid(b, h)
    case "arch": g = (0 ..< 4).map { j in edgeArc(Double(j) / 3, b, true, h) }
    case "bulge": g = blendRows(edgeArc(0, b, true, h), edgeArc(1, b, false, h))
    case "arcLower": g = blendRows(g[0], edgeArc(1, b, false, h))
    case "arcUpper": g = blendRows(edgeArc(0, b, true, h), g[3])
    case "shellLower":
        let a = arcGrid(-b, h)
        g[3] = a[3]
        g[2][0] = a[2][0]
        g[2][3] = a[2][3]
    case "shellUpper":
        let a = arcGrid(b, h)
        g[0] = a[0]
        g[1][0] = a[1][0]
        g[1][3] = a[1][3]
    case "flag":
        for j in 0 ..< 4 {
            g[j][1].1 -= 2 * b
            g[j][2].1 += 2 * b
        }
    case "wave":
        for j in 1 ..< 3 {
            g[j][1].1 += (4.0 / 3) * b
            g[j][2].1 -= (4.0 / 3) * b
        }
    case "fish":
        for (j, f) in [-2, -2.0 / 3, 2.0 / 3, 2].enumerated() {
            g[j][1].1 += f * b
            g[j][2].1 -= f * b
        }
    case "rise":
        for j in 0 ..< 4 {
            g[j][0].1 += 2 * b
            g[j][1].1 += 2 * b
        }
    case "fisheye":
        for (j, i, dx, dy) in INNER {
            g[j][i].0 += (dx * 2 * b) / 3
            g[j][i].1 += (dy * 2 * b) / 3
        }
    case "inflate", "squeeze":
        let s: Double = style == "inflate" ? 1 : -1
        for i in 1 ..< 3 { g[0][i].1 -= b / 3 }
        for i in 1 ..< 3 { g[3][i].1 += b / 3 }
        for j in 1 ..< 3 {
            g[j][0].0 -= (s * b) / 3
            g[j][3].0 += (s * b) / 3
        }
        for (j, i, dx, dy) in INNER {
            g[j][i].0 += (s * dx * b) / 9
            g[j][i].1 += (dy * b) / 9
        }
    case "twist":
        let a = abs(b)
        if b >= 0 {
            g[1][1].0 += a
            g[1][2].1 += a
            g[2][1].1 -= a
            g[2][2].0 -= a
        } else {
            g[1][1].1 += a
            g[1][2].0 -= a
            g[2][1].0 += a
            g[2][2].1 -= a
        }
    default: break
    }
    // Vertical distortion: the top and bottom rows scale about their end points' midpoint (by
    // 1 ∓ vd) and the middle rows follow by the blend of those two moves.
    if vd != 0 {
        func moved(_ row: [P], _ s: Double) -> [P] {
            let m: P = ((row[0].0 + row[3].0) / 2, (row[0].1 + row[3].1) / 2)
            return row.map { p in (m.0 + (p.0 - m.0) * s - p.0, m.1 + (p.1 - m.1) * s - p.1) }
        }
        let d0 = moved(g[0], 1 - vd)
        let d3 = moved(g[3], 1 + vd)
        for j in 0 ..< 4 {
            let t = Double(j) / 3
            for i in 0 ..< 4 {
                g[j][i].0 += d0[i].0 + (d3[i].0 - d0[i].0) * t
                g[j][i].1 += d0[i].1 + (d3[i].1 - d0[i].1) * t
            }
        }
    }
    // Horizontal distortion: each column scales about its end points' midpoint by 1 + hd·(2i/3 − 1).
    if hd != 0 {
        for i in 0 ..< 4 {
            let s = 1 + hd * ((2 * Double(i)) / 3 - 1)
            let m: P = ((g[0][i].0 + g[3][i].0) / 2, (g[0][i].1 + g[3][i].1) / 2)
            for j in 0 ..< 4 { g[j][i] = (m.0 + (g[j][i].0 - m.0) * s, m.1 + (g[j][i].1 - m.1) * s) }
        }
    }
    // Vertical orientation: the same grid with the axes swapped.
    if vertical {
        let t = g
        g = (0 ..< 4).map { j in (0 ..< 4).map { i in (t[i][j].1, t[i][j].0) } }
    }
    return g.map { row in row.map { [$0.0, $0.1] } }
}

private func bernstein(_ t: Double) -> [Double] {
    let s = 1 - t
    return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t]
}

@inline(__always) func lerpVec2(_ a: Vec2, _ b: Vec2, _ t: Double) -> Vec2 { Vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) }

/// De Casteljau split of a cubic at `t`: 7 points (left 0..3, right 3..6).
private func splitCubic(_ p: ArraySlice<Vec2>, _ t: Double) -> [Vec2] {
    let p = Array(p)
    let a = lerpVec2(p[0], p[1], t)
    let b = lerpVec2(p[1], p[2], t)
    let c = lerpVec2(p[2], p[3], t)
    let d = lerpVec2(a, b, t)
    let e = lerpVec2(b, c, t)
    return [p[0], a, d, lerpVec2(d, e, t), e, c, p[3]]
}

/// Inverse of the Bernstein interpolation matrix at t = 0, ⅓, ⅔, 1.
private let BERN_INV: [[Double]] = [[1, 0, 0, 0], [-5.0 / 6, 3, -1.5, 1.0 / 3], [1.0 / 3, -1.5, 3, -5.0 / 6], [0, 0, 0, 1]]

/// `pct`: a percentage as a fraction clamped to −1…1 (0 when it is not a finite number).
private func pct(_ v: JSONValue?) -> Double {
    guard let n = v?.numberValue, n.isFinite else { return 0 }
    return JS.min(1, JS.max(-1, n / 100))
}

/**
 * A preset as one Bézier patch over `bounds` (`warpPresetMesh`), or nil when it changes nothing
 * (an unknown style, all-zero amounts, or an empty box). `preset` holds `style`, `bend`,
 * `horizontal`, `vertical` (percent) and `orientation`.
 */
public func vectorWarpPresetMesh(_ preset: JSONObject, _ bounds: VectorBounds) -> VectorWarpMesh? {
    guard let style = preset["style"]?.stringValue, VECTOR_WARP_STYLES.contains(style) else { return nil }
    let (x, y, w, h) = (bounds.x, bounds.y, bounds.width, bounds.height)
    if !(w > 0 && h > 0) { return nil }
    let b = pct(preset["bend"])
    let hd = pct(preset["horizontal"])
    let vd = pct(preset["vertical"])
    if b == 0 && hd == 0 && vd == 0 { return nil }
    let grid = vectorWarpPresetGrid(style, b, hd, vd, preset["orientation"] == "vertical", h / w)
    return VectorWarpMesh(us: [0, 1], vs: [0, 1], points: grid.flatMap { $0 }.map { Vec2(x + $0[0] * w, y + $0[1] * h) })
}

/// Control points per row.
public func vectorMeshColumns(_ m: VectorWarpMesh) -> Int { 3 * (m.us.count - 1) + 1 }
/// Control point rows.
public func vectorMeshRows(_ m: VectorWarpMesh) -> Int { 3 * (m.vs.count - 1) + 1 }

/// Whether JSON is a well-formed mesh (`isValidWarpMesh`): knots from 0 to 1 increasing, the right
/// number of finite points.
public func isValidVectorMesh(_ value: JSONValue?) -> Bool {
    guard let o = value?.objectValue else { return false }
    func knots(_ k: JSONValue?) -> [Double]? {
        guard let list = k?.arrayValue, list.count >= 2, list.count <= 65 else { return nil }
        let n = list.compactMap(\.numberValue)
        guard n.count == list.count, n[0] == 0, n[n.count - 1] == 1 else { return nil }
        for i in 1 ..< n.count where !(n[i] > n[i - 1]) { return nil }
        return n
    }
    guard let us = knots(o["us"]), let vs = knots(o["vs"]), let points = o["points"]?.arrayValue else { return false }
    return points.count == (3 * (us.count - 1) + 1) * (3 * (vs.count - 1) + 1) && points.allSatisfy { p in
        guard let x = p["x"]?.numberValue, let y = p["y"]?.numberValue else { return false }
        return x.isFinite && y.isFinite
    }
}

/// Fits a mesh with patch boundaries `us` / `vs` to the map `f` (box fractions → output) by
/// interpolating it at each patch's thirds (`fitWarpMesh`). Exact for bicubic maps.
public func fitVectorMesh(_ f: (Double, Double) -> Vec2, _ us: [Double], _ vs: [Double]) -> VectorWarpMesh {
    let pc = us.count - 1
    let pr = vs.count - 1
    let nx = 3 * pc + 1
    var points = [Vec2](repeating: Vec2(0, 0), count: (3 * pr + 1) * nx)
    for pj in 0 ..< pr {
        for pi in 0 ..< pc {
            let s: [[Vec2]] = (0 ..< 4).map { j in
                (0 ..< 4).map { i in f(us[pi] + ((us[pi + 1] - us[pi]) * Double(i)) / 3, vs[pj] + ((vs[pj + 1] - vs[pj]) * Double(j)) / 3) }
            }
            for j in 0 ..< 4 {
                for i in 0 ..< 4 {
                    var x = 0.0
                    var y = 0.0
                    for a in 0 ..< 4 {
                        for b in 0 ..< 4 {
                            let k = BERN_INV[j][a] * BERN_INV[i][b]
                            x += k * s[a][b].x
                            y += k * s[a][b].y
                        }
                    }
                    points[(3 * pj + j) * nx + 3 * pi + i] = Vec2(x, y)
                }
            }
        }
    }
    return VectorWarpMesh(us: us, vs: vs, points: points)
}

/// `n + 1` evenly spaced knots from 0 to 1.
func evenKnots(_ n: Int) -> [Double] { (0 ... n).map { Double($0) / Double(n) } }
/// A patch count rounded and clamped to 1–64.
func clampMeshCount(_ n: Double) -> Int { Int(JS.min(64, JS.max(1, JS.round(n.isFinite ? n : 1)))) }

/// The identity mesh over `bounds` with `columns × rows` patches (`identityWarpMesh`).
public func vectorIdentityMesh(_ bounds: VectorBounds, _ columns: Double = 1, _ rows: Double = 1) -> VectorWarpMesh {
    fitVectorMesh({ s, t in Vec2(bounds.x + s * bounds.width, bounds.y + t * bounds.height) }, evenKnots(clampMeshCount(columns)), evenKnots(clampMeshCount(rows)))
}

/// The patch holding box fraction `s` and the parameter inside it. Outside 0–1 the end patches
/// extrapolate (see GOTCHAS: warp meshes must extrapolate outside their box).
private func locate(_ knots: [Double], _ s: Double) -> (Int, Double) {
    let n = knots.count - 1
    var i = 0
    while i + 1 < n && s > knots[i + 1] { i += 1 }
    let w = knots[i + 1] - knots[i]
    return (i, w > 0 ? (s - knots[i]) / w : 0)
}

/// The surface at box fractions `(s, t)` (`evalWarpMesh`).
public func evalVectorMesh(_ m: VectorWarpMesh, _ s: Double, _ t: Double) -> Vec2 {
    let (pi, a) = locate(m.us, s)
    let (pj, b) = locate(m.vs, t)
    let ba = bernstein(a)
    let bb = bernstein(b)
    let nx = vectorMeshColumns(m)
    var x = 0.0
    var y = 0.0
    for j in 0 ..< 4 {
        for i in 0 ..< 4 {
            let p = m.points[(3 * pj + j) * nx + 3 * pi + i]
            let k = ba[i] * bb[j]
            x += p.x * k
            y += p.y * k
        }
    }
    return Vec2(x, y)
}

private func transposeMesh(_ m: VectorWarpMesh) -> VectorWarpMesh {
    let nx = vectorMeshColumns(m)
    let ny = vectorMeshRows(m)
    var points = [Vec2](repeating: Vec2(0, 0), count: nx * ny)
    for j in 0 ..< ny { for i in 0 ..< nx { points[i * ny + j] = m.points[j * nx + i] } }
    return VectorWarpMesh(us: m.vs, vs: m.us, points: points)
}

/// The mesh with the patch column holding `s` split at `s` (exact; `splitWarpMeshU`). Nil when
/// `s` is on or too close to a boundary.
public func splitVectorMeshU(_ m: VectorWarpMesh, _ s: Double) -> VectorWarpMesh? {
    let (pi, a) = locate(m.us, s)
    if !(a >= 0.01 && a <= 0.99) { return nil }
    let nx = vectorMeshColumns(m)
    let ny = vectorMeshRows(m)
    var points: [Vec2] = []
    for j in 0 ..< ny {
        let row = m.points[(j * nx) ..< ((j + 1) * nx)]
        let base = row.startIndex
        points += row[base ..< base + 3 * pi]
        points += splitCubic(row[(base + 3 * pi) ..< (base + 3 * pi + 4)], a)
        points += row[(base + 3 * pi + 4)...]
    }
    var us = m.us
    us.insert(JS.min(1, JS.max(0, s)), at: pi + 1)
    return VectorWarpMesh(us: us, vs: m.vs, points: points)
}

/// The mesh with the patch row holding `t` split at `t` (exact; `splitWarpMeshV`).
public func splitVectorMeshV(_ m: VectorWarpMesh, _ t: Double) -> VectorWarpMesh? {
    splitVectorMeshU(transposeMesh(m), t).map(transposeMesh)
}

/// Every control point through `f` (exact for affine maps; `mapWarpMeshPoints`).
public func mapVectorMeshPoints(_ m: VectorWarpMesh, _ f: (Vec2) -> Vec2) -> VectorWarpMesh {
    VectorWarpMesh(us: m.us, vs: m.vs, points: m.points.map(f))
}

/// The mesh with `columns × rows` patches over the same surface (`resizeWarpMesh`): split exactly
/// when its knots are a subset of the new even ones, otherwise refitted.
public func resizeVectorMesh(_ m: VectorWarpMesh, _ columns: Double, _ rows: Double) -> VectorWarpMesh {
    let cols = clampMeshCount(columns)
    let rws = clampMeshCount(rows)
    if m.us.count - 1 == cols && m.vs.count - 1 == rws { return m }
    let us = evenKnots(cols)
    let vs = evenKnots(rws)
    func has(_ list: [Double], _ v: Double) -> Bool { list.contains { abs($0 - v) < 1e-12 } }
    if m.us.allSatisfy({ has(us, $0) }) && m.vs.allSatisfy({ has(vs, $0) }) {
        var out = m
        for u in us where !has(out.us, u) { out = splitVectorMeshU(out, u) ?? out }
        for v in vs where !has(out.vs, v) { out = splitVectorMeshV(out, v) ?? out }
        return out
    }
    return fitVectorMesh({ s, t in evalVectorMesh(m, s, t) }, us, vs)
}

/// Bounding box of the control points (the surface lies inside it; `warpMeshControlBounds`).
public func vectorMeshControlBounds(_ m: VectorWarpMesh) -> VectorBounds {
    var minX = Double.infinity, minY = Double.infinity, maxX = -Double.infinity, maxY = -Double.infinity
    for p in m.points {
        minX = JS.min(minX, p.x)
        minY = JS.min(minY, p.y)
        maxX = JS.max(maxX, p.x)
        maxY = JS.max(maxY, p.y)
    }
    return VectorBounds(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
}

// MARK: - Envelope from an outline (`vector/warp.ts`)

/// Points along a polyline by fraction of its length.
private func polylineAt(_ pts: [Vec2]) -> (Double) -> Vec2 {
    var acc = [0.0]
    for i in 1 ..< max(1, pts.count) { acc.append(acc[i - 1] + JS.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)) }
    let total = acc[acc.count - 1]
    return { u in
        if !(total > 0) { return pts[0] }
        let L = JS.min(1, JS.max(0, u)) * total
        var i = 1
        while i < acc.count - 1 && acc[i] < L { i += 1 }
        let seg = acc[i] - acc[i - 1]
        return lerpVec2(pts[i - 1], pts[i], seg > 0 ? (L - acc[i - 1]) / seg : 0)
    }
}

private func sampleSubpath(_ sp: VectorSubpath, _ per: Int = 24) -> [Vec2] {
    let n = sp.anchors.count
    var out: [Vec2] = []
    for i in 0 ..< n {
        let a = sp.anchors[i]
        let b = sp.anchors[(i + 1) % n]
        let c = [Vec2(a.x, a.y), a.out ?? Vec2(a.x, a.y), b.in ?? Vec2(b.x, b.y), Vec2(b.x, b.y)]
        for k in 0 ..< per {
            let t = Double(k) / Double(per)
            let ab = lerpVec2(c[0], c[1], t)
            let bc = lerpVec2(c[1], c[2], t)
            let cd = lerpVec2(c[2], c[3], t)
            out.append(lerpVec2(lerpVec2(ab, bc, t), lerpVec2(bc, cd, t), t))
        }
    }
    return out
}

/**
 * A mesh whose border follows a closed outline (Make with Top Object; `vectorMeshFromOutline`):
 * the outline is cut into four sides at the points nearest its bounding box's corners, and the
 * interior is the Coons patch of those sides, fitted with `columns × rows` patches. Nil for an
 * open or degenerate outline.
 */
public func vectorMeshFromOutline(_ sp: VectorSubpath, _ columns: Double = 4, _ rows: Double = 4) -> VectorWarpMesh? {
    if !sp.closed || sp.anchors.count < 2 { return nil }
    var ring = sampleSubpath(sp)
    let xs = ring.map(\.x)
    let ys = ring.map(\.y)
    let box = (x0: xs.reduce(.infinity) { JS.min($0, $1) }, y0: ys.reduce(.infinity) { JS.min($0, $1) }, x1: xs.reduce(-.infinity) { JS.max($0, $1) }, y1: ys.reduce(-.infinity) { JS.max($0, $1) })
    if !(box.x1 - box.x0 > 1e-9 && box.y1 - box.y0 > 1e-9) { return nil }
    func nearest(_ c: Vec2) -> Int {
        var best = 0
        for i in 1 ..< ring.count where JS.hypot(ring[i].x - c.x, ring[i].y - c.y) < JS.hypot(ring[best].x - c.x, ring[best].y - c.y) { best = i }
        return best
    }
    func cornersOf() -> [Int] { [Vec2(box.x0, box.y0), Vec2(box.x1, box.y0), Vec2(box.x1, box.y1), Vec2(box.x0, box.y1)].map(nearest) }
    var c = cornersOf()
    let n = ring.count
    func fwd(_ from: Int, _ to: Int) -> Int { (to - from + n) % n }
    // Clockwise on screen: top-left, top-right, bottom-right, bottom-left in walking order.
    if !(fwd(c[0], c[1]) < fwd(c[0], c[2]) && fwd(c[0], c[2]) < fwd(c[0], c[3])) {
        ring.reverse()
        c = cornersOf()
        if !(fwd(c[0], c[1]) < fwd(c[0], c[2]) && fwd(c[0], c[2]) < fwd(c[0], c[3])) { return nil }
    }
    if Set(c).count < 4 { return nil }
    func walk(_ from: Int, _ to: Int) -> [Vec2] {
        var out: [Vec2] = []
        var i = from
        while true {
            out.append(ring[i])
            if i == to { break }
            i = (i + 1) % n
        }
        return out
    }
    let top = polylineAt(walk(c[0], c[1]))
    let right = polylineAt(walk(c[1], c[2]))
    let bottomLR = polylineAt(walk(c[2], c[3]).reversed())
    let leftTB = polylineAt(walk(c[3], c[0]).reversed())
    let p00 = top(0), p10 = top(1), p01 = bottomLR(0), p11 = bottomLR(1)
    func coons(_ s: Double, _ t: Double) -> Vec2 {
        let T = top(s), B = bottomLR(s), L = leftTB(t), R = right(t)
        return Vec2(
            (1 - t) * T.x + t * B.x + (1 - s) * L.x + s * R.x - ((1 - s) * (1 - t) * p00.x + s * (1 - t) * p10.x + (1 - s) * t * p01.x + s * t * p11.x),
            (1 - t) * T.y + t * B.y + (1 - s) * L.y + s * R.y - ((1 - s) * (1 - t) * p00.y + s * (1 - t) * p10.y + (1 - s) * t * p01.y + s * t * p11.y)
        )
    }
    return fitVectorMesh(coons, evenKnots(clampMeshCount(columns)), evenKnots(clampMeshCount(rows)))
}

/// The mesh's border as one closed subpath, clockwise from the top-left corner (what Release
/// gives back as the envelope's shape; `vectorMeshOutline`).
public func vectorMeshOutline(_ m: VectorWarpMesh) -> VectorSubpath {
    let nx = vectorMeshColumns(m)
    let ny = vectorMeshRows(m)
    func pt(_ i: Int, _ j: Int) -> Vec2 { m.points[j * nx + i] }
    var runs: [[Vec2]] = []
    for i in stride(from: 0, to: nx - 3, by: 3) { runs.append([pt(i, 0), pt(i + 1, 0), pt(i + 2, 0), pt(i + 3, 0)]) }
    for j in stride(from: 0, to: ny - 3, by: 3) { runs.append([pt(nx - 1, j), pt(nx - 1, j + 1), pt(nx - 1, j + 2), pt(nx - 1, j + 3)]) }
    for i in stride(from: nx - 1, to: 2, by: -3) { runs.append([pt(i, ny - 1), pt(i - 1, ny - 1), pt(i - 2, ny - 1), pt(i - 3, ny - 1)]) }
    for j in stride(from: ny - 1, to: 2, by: -3) { runs.append([pt(0, j), pt(0, j - 1), pt(0, j - 2), pt(0, j - 3)]) }
    let anchors = runs.enumerated().map { k, r -> VectorAnchor in
        let prev = runs[(k + runs.count - 1) % runs.count]
        return VectorAnchor(x: r[0].x, y: r[0].y, in: prev[2], out: r[1])
    }
    return VectorSubpath(closed: true, anchors: anchors)
}
