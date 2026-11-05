import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Perspective grids (drawing in perspective, `vector/perspective.ts`): one projective map per plane
// from the vanishing points; its columns are the plane's two directions (toward a vanishing point,
// or a fixed direction for a point at infinity) and the origin. Plane coordinates are document
// units at the origin, x right and y up as seen there. The grid is JSON on the document
// (`perspective`: `{ vanishingPoints, origin, gridSize?, extent?, visible? }`).

/// Every perspective plane name (`VECTOR_PERSPECTIVE_PLANES`).
public let VECTOR_PERSPECTIVE_PLANES = ["floor", "left", "right", "side", "front"]

private func points(_ grid: JSONObject) -> [Vec2] { (grid["vanishingPoints"]?.arrayValue ?? []).compactMap { Vec2(json: $0) } }

/// The planes a grid with this many vanishing points has.
public func vectorPerspectivePlanes(_ grid: JSONObject) -> [String] {
    (grid["vanishingPoints"]?.arrayValue?.count ?? 0) <= 1 ? ["floor", "side", "front"] : ["floor", "left", "right"]
}

/// Reads a perspective grid from untrusted data; nil when invalid.
public func sanitizeVectorPerspective(_ value: JSONValue?) -> JSONObject? {
    guard let r = value?.objectValue else { return nil }
    func point(_ v: JSONValue?) -> Vec2? {
        guard let o = v?.objectValue, let x = o["x"]?.numberValue, let y = o["y"]?.numberValue, x.isFinite, y.isFinite else { return nil }
        return Vec2(x, y)
    }
    guard let list = r["vanishingPoints"]?.arrayValue, (1 ... 3).contains(list.count), let origin = point(r["origin"]) else { return nil }
    let vps = list.compactMap(point)
    if vps.count != list.count { return nil }
    // A vanishing point on the origin has no direction.
    if vps.contains(where: { JS.hypot($0.x - origin.x, $0.y - origin.y) < 1e-6 }) { return nil }
    var out = JSONObject([("vanishingPoints", .array(vps.map(\.json))), ("origin", origin.json)])
    if let g = r["gridSize"]?.numberValue, g > 0, g.isFinite { out["gridSize"] = .number(JS.min(1000, g)) }
    if let e = r["extent"]?.numberValue, e.isFinite { out["extent"] = .number(JS.min(100, JS.max(1, JS.round(e)))) }
    if r["visible"] == .bool(false) { out["visible"] = false }
    return out
}

/// The homogeneous direction column toward `vp`, one document unit long on screen at the origin,
/// signed by `want` (`right` or `up`).
private func towards(_ o: Vec2, _ vp: Vec2, _ want: String) -> [Double] {
    let d = JS.hypot(vp.x - o.x, vp.y - o.y)
    var a = 1 / d
    // Its screen direction at the origin is a·(vp − o): make it point right (or up).
    if want == "right" ? vp.x - o.x < 0 : vp.y - o.y > 0 { a = -a }
    return [a * vp.x, a * vp.y, a]
}

/// The projective map from plane coordinates to the document for `plane` of the grid; nil for a
/// plane the grid does not have. Columns: the plane's x direction, its y direction, the origin.
public func vectorPerspectivePlaneMap(_ grid: JSONObject, _ plane: String) -> [Double]? {
    if !vectorPerspectivePlanes(grid).contains(plane) { return nil }
    guard let o = Vec2(json: grid["origin"]) else { return nil }
    let vps = points(grid)
    guard let v1 = vps.first else { return nil }
    let v2 = vps.count > 1 ? vps[1] : nil
    let v3 = vps.count > 2 ? vps[2] : nil
    let right: [Double] = [1, 0, 0]
    let up: [Double] = v3.map { towards(o, $0, "up") } ?? [0, -1, 0]
    let x: [Double]
    let y: [Double]
    if vps.count <= 1 {
        if plane == "floor" { (x, y) = (right, towards(o, v1, "up")) }
        else if plane == "side" { (x, y) = (towards(o, v1, "right"), up) }
        else { (x, y) = (right, up) }
    } else if plane == "floor" { (x, y) = (towards(o, v2!, "right"), towards(o, v1, "up")) }
    else if plane == "left" { (x, y) = (towards(o, v1, "right"), up) }
    else { (x, y) = (towards(o, v2!, "right"), up) }
    return [x[0], y[0], o.x, x[1], y[1], o.y, x[2], y[2], 1]
}

/// Maps flat art onto a plane: a document point `q` is read as plane coordinates relative to the
/// origin (`q.x − origin.x` right, `origin.y − q.y` up) and placed on the plane. Nil where the point
/// would fall behind the viewer.
public func vectorPerspectiveFlatToPlane(_ grid: JSONObject, _ plane: String) -> ((Vec2) -> Vec2?)? {
    guard let h = vectorPerspectivePlaneMap(grid, plane), let o = Vec2(json: grid["origin"]) else { return nil }
    return { q in
        let u = q.x - o.x
        let v = o.y - q.y
        let w = h[6] * u + h[7] * v + h[8]
        if !(w > 1e-6) { return nil }
        return applyHomography(h, Vec2(u, v))
    }
}

/// The inverse of `vectorPerspectiveFlatToPlane`: where on the flat art a document point on the
/// plane comes from.
public func vectorPerspectivePlaneToFlat(_ grid: JSONObject, _ plane: String) -> ((Vec2) -> Vec2?)? {
    guard let h = vectorPerspectivePlaneMap(grid, plane), let inv = invertHomography(h), let o = Vec2(json: grid["origin"]) else { return nil }
    return { q in
        guard let f = applyHomography(inv, q) else { return nil }
        // Only points in front of the viewer (the side of the plane the grid draws).
        let w = h[6] * f.x + h[7] * f.y + h[8]
        if !(w > 1e-6) { return nil }
        return Vec2(o.x + f.x, o.y - f.y)
    }
}

/// A flat path laid onto a plane (curves re-fitted where the projection bends them), or nil when
/// part of it would fall behind the viewer (beyond the plane's horizon).
public func vectorPerspectiveMapPath(_ grid: JSONObject, _ plane: String, _ path: BezierPath) -> BezierPath? {
    guard let f = vectorPerspectiveFlatToPlane(grid, plane) else { return nil }
    var behind = false
    let out = mapBezierPath(path, { q in
        guard let r = f(q) else {
            behind = true
            return q
        }
        return r
    }, 0.1)
    return behind ? nil : out
}

/// The grid lines of a plane, in document space: lines of constant x and of constant y every
/// `gridSize` out to `extent` cells on each side of the origin (only the parts in front of the
/// viewer; lines running behind it are cut where they near the horizon).
public func vectorPerspectiveGridLines(_ grid: JSONObject, _ plane: String) -> [(a: Vec2, b: Vec2)] {
    guard let h = vectorPerspectivePlaneMap(grid, plane) else { return [] }
    let g = grid["gridSize"]?.numberValue ?? 20
    let n = grid["extent"]?.numberValue ?? 12
    let max = n * g
    // The floor and the front run both ways from the origin; walls rise from the ground.
    func lo(_ axis: String) -> Double { axis == "y" && plane != "floor" ? 0 : -max }
    func w(_ u: Double, _ v: Double) -> Double { h[6] * u + h[7] * v + h[8] }
    func at(_ u: Double, _ v: Double) -> Vec2? { applyHomography(h, Vec2(u, v)) }
    // Clip a line's parameter range to where it stays clearly in front (w ≥ 0.05).
    func segment(_ u0: Double, _ v0: Double, _ u1: Double, _ v1: Double) -> (a: Vec2, b: Vec2)? {
        let wa = w(u0, v0)
        let wb = w(u1, v1)
        let min = 0.05
        if wa < min && wb < min { return nil }
        var t0 = 0.0
        var t1 = 1.0
        if wa < min { t0 = (min - wa) / (wb - wa) }
        if wb < min { t1 = (min - wa) / (wb - wa) }
        guard let a = at(u0 + (u1 - u0) * t0, v0 + (v1 - v0) * t0), let b = at(u0 + (u1 - u0) * t1, v0 + (v1 - v0) * t1) else { return nil }
        return (a, b)
    }
    var out: [(a: Vec2, b: Vec2)] = []
    var k = lo("x") / g
    while k <= n {
        if let s = segment(k * g, lo("y"), k * g, max) { out.append(s) }
        k += 1
    }
    k = lo("y") / g
    while k <= n {
        if let s = segment(lo("x"), k * g, max, k * g) { out.append(s) }
        k += 1
    }
    return out
}

/// A starting grid for a page `width × height`: the horizon a third of the way down, the origin
/// near the bottom middle; 1 point in the middle of the horizon, 2 beyond the page's sides, and a
/// third far below the page (a bird's eye view).
public func vectorPerspectivePreset(_ points: Int, _ width: Double, _ height: Double) -> JSONObject {
    let horizon = height * 0.35
    let origin = Vec2(width / 2, height * 0.8)
    var vps = points == 1 ? [Vec2(width / 2, horizon)] : [Vec2(-width * 0.3, horizon), Vec2(width * 1.3, horizon)]
    if points == 3 { vps.append(Vec2(width / 2, height * 3)) }
    return JSONObject([
        ("vanishingPoints", .array(vps.map(\.json))), ("origin", origin.json),
        ("gridSize", .number(JS.max(4, JS.round(JS.min(width, height) / 20)))), ("extent", 12),
    ])
}
