import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Connectors glued to objects (`vector/connectors.ts`): connection sites, routing and rerouting
// after every edit. An end is glued to a site of another object (a side's middle or the centre of
// its own bounds, through its rotation); the connector is routed again whenever what it is glued to
// changes, and glue to an object that no longer exists is dropped, the end staying where it was.
// Straight, elbow and curved routes; elbows leave and enter along the sides' normals (a gap out
// first) and curves take their handles along them. The Connector tool's target picking
// (`vectorConnectorTargetAt`, which hit-tests) and the panel data are not ported.

/// The connector sides (`VECTOR_CONNECTOR_SIDES`).
public let VECTOR_CONNECTOR_SIDES = ["auto", "top", "right", "bottom", "left", "center"]
/// The connector routes (`VECTOR_CONNECTOR_ROUTES`).
public let VECTOR_CONNECTOR_ROUTES = ["straight", "elbow", "curved"]

/// Labels for the connector pickers.
public let VECTOR_CONNECTOR_ROUTE_LABELS: [String: String] = ["straight": "Straight", "elbow": "Elbow", "curved": "Curved"]
public let VECTOR_CONNECTOR_SIDE_LABELS: [String: String] = ["auto": "Auto", "top": "Top", "right": "Right", "bottom": "Bottom", "left": "Left", "center": "Centre"]

/// A connection site in document space: where an end meets the object, and the side's outward normal.
public struct VectorConnectionSite: Equatable, Sendable {
    public var side: String
    public var x: Double
    public var y: Double
    /// Unit outward normal (zero for the centre).
    public var nx: Double
    public var ny: Double

    public var json: JSONValue {
        .object(JSONObject([("side", .string(side)), ("x", .number(x)), ("y", .number(y)), ("nx", .number(nx)), ("ny", .number(ny))]))
    }
}

private let SIDES = ["top", "right", "bottom", "left", "center"]

/// Whether the node is a connector path.
public func isVectorConnector(_ node: VectorNode?) -> Bool {
    guard let node else { return false }
    return node.isPath && truthy(node["connector"])
}

/// The connection sites of node `id` in document space, in the order top, right, bottom, left,
/// centre: the middles of its own (unrotated) bounds' sides, through its rotation and its
/// ancestors'. Empty for a connector, a hidden node or one without extent.
public func vectorConnectionSites(_ nodes: [VectorNode], _ id: String) throws -> [VectorConnectionSite] {
    guard let node = findVectorNode(nodes, id), !isVectorConnector(node), node.isVisible else { return [] }
    guard let world = vectorWorldMatrix(nodes, id) else { return [] }
    var own = node
    own["transform"] = Optional<JSONValue>.none
    guard let b = try vectorNodeBounds(own) else { return [] }
    // The node's own space → document (its transform included; `own` was measured without it).
    let cx = b.x + b.width / 2
    let cy = b.y + b.height / 2
    let local: [String: (Vec2, Vec2)] = [
        "top": (Vec2(cx, b.y), Vec2(0, -1)),
        "right": (Vec2(b.x + b.width, cy), Vec2(1, 0)),
        "bottom": (Vec2(cx, b.y + b.height), Vec2(0, 1)),
        "left": (Vec2(b.x, cy), Vec2(-1, 0)),
        "center": (Vec2(cx, cy), Vec2(0, 0)),
    ]
    return SIDES.map { side in
        let (p, n) = local[side]!
        let q = applyMatrix(world, p)
        let m = applyMatrixLinear(world, n)
        let len = JS.hypot(m.x, m.y)
        return VectorConnectionSite(side: side, x: q.x, y: q.y, nx: len > 1e-12 ? m.x / len : 0, ny: len > 1e-12 ? m.y / len : 0)
    }
}

/// The site of `sites` nearest `p` (document space) within `radius`, or nil.
public func nearestVectorConnectionSite(_ sites: [VectorConnectionSite], _ p: Vec2, _ radius: Double = .infinity) -> VectorConnectionSite? {
    var best: VectorConnectionSite?
    var bestD = radius
    for s in sites {
        let d = JS.hypot(s.x - p.x, s.y - p.y)
        if d <= bestD {
            best = s
            bestD = d
        }
    }
    return best
}

/// The site of an `auto` end: the side whose normal faces `toward` most (the nearer one on a tie).
private func facingSite(_ sites: [VectorConnectionSite], _ toward: Vec2) -> VectorConnectionSite {
    var best = sites[0]
    var score = -Double.infinity
    for s in sites where s.side != "center" {
        let dx = toward.x - s.x
        let dy = toward.y - s.y
        let h = JS.hypot(dx, dy)
        let len = h != 0 && !h.isNaN ? h : 1
        let v = (s.nx * dx + s.ny * dy) / len - len * 1e-9
        if v > score {
            score = v
            best = s
        }
    }
    return best
}

/// A routed end: its point and the direction the line leaves it (zero when it has none).
public struct VectorRoutedEnd: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var nx: Double
    public var ny: Double
    public var glued: Bool

    public init(x: Double, y: Double, nx: Double, ny: Double, glued: Bool) {
        self.x = x
        self.y = y
        self.nx = nx
        self.ny = ny
        self.glued = glued
    }
}

/// `a.nx || a.ny` (a non-zero, non-NaN normal).
private func hasNormal(_ e: VectorRoutedEnd) -> Bool { (e.nx != 0 && !e.nx.isNaN) || (e.ny != 0 && !e.ny.isNaN) }

/// The connector's current end points in document space (its first and last anchors).
private func storedEnds(_ node: VectorNode, _ world: VectorMatrix) -> (Vec2, Vec2)? {
    guard let sp = node.subpaths.first, let a = sp.anchors.first, let b = sp.anchors.last else { return nil }
    return (applyMatrix(world, Vec2(a.x, a.y)), applyMatrix(world, Vec2(b.x, b.y)))
}

/// Unit vector along the dominant axis of `v` (right when zero).
private func axis(_ v: Vec2) -> Vec2 {
    if abs(v.x) >= abs(v.y) { return Vec2(v.x < 0 ? -1 : 1, 0) }
    return Vec2(0, v.y < 0 ? -1 : 1)
}

/// Removes repeated points and middle points of straight runs.
private func tidy(_ points: [Vec2]) -> [Vec2] {
    var out: [Vec2] = []
    for p in points {
        if let last = out.last, JS.hypot(p.x - last.x, p.y - last.y) < 1e-9 { continue }
        out.append(p)
    }
    var i = out.count - 2
    while i >= 1 {
        let a = out[i - 1], b = out[i], c = out[i + 1]
        if abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) < 1e-9 { out.remove(at: i) }
        i -= 1
    }
    return out
}

/// The elbow route's points between two ends (document space).
private func elbowPoints(_ a: VectorRoutedEnd, _ b: VectorRoutedEnd, _ gap: Double) -> [Vec2] {
    let na = a.glued && hasNormal(a) ? axis(Vec2(a.nx, a.ny)) : axis(Vec2(b.x - a.x, b.y - a.y))
    let nb = b.glued && hasNormal(b) ? axis(Vec2(b.nx, b.ny)) : axis(Vec2(a.x - b.x, a.y - b.y))
    let s = Vec2(a.x + na.x * (a.glued ? gap : 0), a.y + na.y * (a.glued ? gap : 0))
    let e = Vec2(b.x + nb.x * (b.glued ? gap : 0), b.y + nb.y * (b.glued ? gap : 0))
    let ha = na.x != 0
    let hb = nb.x != 0
    var mid: [Vec2]
    if ha && hb {
        // Out and in sideways: across through the middle, or round the middle when that would turn back.
        let mx = (s.x + e.x) / 2
        mid = (mx - s.x) * na.x >= 0 && (mx - e.x) * nb.x >= 0 ? [Vec2(mx, s.y), Vec2(mx, e.y)] : [Vec2(s.x, (s.y + e.y) / 2), Vec2(e.x, (s.y + e.y) / 2)]
    } else if !ha && !hb {
        let my = (s.y + e.y) / 2
        mid = (my - s.y) * na.y >= 0 && (my - e.y) * nb.y >= 0 ? [Vec2(s.x, my), Vec2(e.x, my)] : [Vec2((s.x + e.x) / 2, s.y), Vec2((s.x + e.x) / 2, e.y)]
    } else if ha {
        mid = [Vec2(e.x, s.y)]
    } else {
        mid = [Vec2(s.x, e.y)]
    }
    return tidy([Vec2(a.x, a.y), s] + mid + [e, Vec2(b.x, b.y)])
}

/// The connector's path in document space, from routed ends (`vectorConnectorWorldAnchors`).
/// `gap` defaults to 16, `radius` to 0.
public func vectorConnectorWorldAnchors(_ a: VectorRoutedEnd, _ b: VectorRoutedEnd, _ route: String, radius: Double? = nil, gap: Double? = nil) -> [VectorAnchor] {
    let gap = gap ?? 16
    if route == "elbow" {
        let pts = elbowPoints(a, b, gap)
        let r = radius ?? 0
        return pts.enumerated().map { i, p in
            r > 0 && i > 0 && i < pts.count - 1 ? VectorAnchor(x: p.x, y: p.y, corner: VectorCorner(radius: r)) : VectorAnchor(x: p.x, y: p.y)
        }
    }
    if route == "curved" {
        let d = JS.hypot(b.x - a.x, b.y - a.y)
        let k = JS.max(d * 0.4, gap)
        let na = a.glued && hasNormal(a) ? Vec2(a.nx, a.ny) : axis(Vec2(b.x - a.x, b.y - a.y))
        let nb = b.glued && hasNormal(b) ? Vec2(b.nx, b.ny) : axis(Vec2(a.x - b.x, a.y - b.y))
        return [
            VectorAnchor(x: a.x, y: a.y, out: Vec2(a.x + na.x * k, a.y + na.y * k)),
            VectorAnchor(x: b.x, y: b.y, in: Vec2(b.x + nb.x * k, b.y + nb.y * k)),
        ]
    }
    return [VectorAnchor(x: a.x, y: a.y), VectorAnchor(x: b.x, y: b.y)]
}

/// A glued end's object id and side (`VectorConnectorEnd`), or nil for a free (or invalid) end.
private func endOf(_ e: JSONValue?) -> (nodeId: String, side: String?)? {
    guard truthy(e), let id = e?["nodeId"]?.stringValue else { return nil }
    return (id, e?["side"]?.stringValue)
}

/// Resolves one end: its site (an `auto` one facing `toward`), or nil when its object is gone.
private func resolveEnd(_ nodes: [VectorNode], _ end: (nodeId: String, side: String?), _ toward: Vec2) throws -> VectorConnectionSite? {
    let sites = try vectorConnectionSites(nodes, end.nodeId)
    if sites.isEmpty { return nil }
    let side = end.side ?? "auto"
    return side == "auto" ? facingSite(sites, toward) : sites.first { $0.side == side }
}

/// What routing a connector gives: its new subpaths (own space), the resolved sides of its glued
/// ends (nil when not glued), and which glued ends lost their object.
public struct VectorConnectorRouting: Equatable, Sendable {
    public var subpaths: [VectorSubpath]
    public var startSide: String?
    public var endSide: String?
    public var droppedStart: Bool
    public var droppedEnd: Bool
}

/// Routes connector `id` of `nodes` from where its ends are glued (or stored), or nil when it is
/// not a connector (`routeVectorConnector`).
public func routeVectorConnector(_ nodes: [VectorNode], _ id: String) throws -> VectorConnectorRouting? {
    guard let node = findVectorNode(nodes, id), isVectorConnector(node), let world = vectorWorldMatrix(nodes, id) else { return nil }
    let c = node["connector"]
    let stored = storedEnds(node, world) ?? (Vec2(0, 0), Vec2(0, 0))
    func glue(_ e: JSONValue?) -> (nodeId: String, side: String?)? {
        guard let g = endOf(e), g.nodeId != id else { return nil }
        return g
    }
    let startGlue = glue(c?["start"])
    let endGlue = glue(c?["end"])
    // Reference points for `auto` sides: the other end's object centre, or its stored point.
    func centre(_ e: (nodeId: String, side: String?)?, _ fallback: Vec2) throws -> Vec2 {
        guard let e else { return fallback }
        let sites = try vectorConnectionSites(nodes, e.nodeId)
        return sites.isEmpty ? fallback : Vec2(sites[4].x, sites[4].y)
    }
    let s = try startGlue.flatMap { try resolveEnd(nodes, $0, try centre(endGlue, stored.1)) }
    let e = try endGlue.flatMap { try resolveEnd(nodes, $0, s.map { Vec2($0.x, $0.y) } ?? (try centre(startGlue, stored.0))) }
    let a = s.map { VectorRoutedEnd(x: $0.x, y: $0.y, nx: $0.nx, ny: $0.ny, glued: true) } ?? VectorRoutedEnd(x: stored.0.x, y: stored.0.y, nx: 0, ny: 0, glued: false)
    let b = e.map { VectorRoutedEnd(x: $0.x, y: $0.y, nx: $0.nx, ny: $0.ny, glued: true) } ?? VectorRoutedEnd(x: stored.1.x, y: stored.1.y, nx: 0, ny: 0, glued: false)
    let anchors = vectorConnectorWorldAnchors(a, b, c?["route"]?.stringValue ?? "straight", radius: c?["radius"]?.numberValue, gap: c?["gap"]?.numberValue)
    let back = invertMatrix(world)
    let identity = isIdentityMatrix(back)
    func toLocal(_ p: Vec2) -> Vec2 { identity ? p : applyMatrix(back, p) }
    let local = anchors.map { an -> VectorAnchor in
        var out = an
        let p = toLocal(Vec2(an.x, an.y))
        out.x = p.x
        out.y = p.y
        if let h = an.in { out.in = toLocal(h) }
        if let h = an.out { out.out = toLocal(h) }
        return out
    }
    return VectorConnectorRouting(
        subpaths: [VectorSubpath(closed: false, anchors: local)],
        startSide: s?.side, endSide: e?.side,
        droppedStart: startGlue != nil && s == nil, droppedEnd: endGlue != nil && e == nil
    )
}

private func near(_ a: Double, _ b: Double) -> Bool { abs(a - b) < 1e-9 }
private func samePoint(_ a: Vec2?, _ b: Vec2?) -> Bool {
    guard let a, let b else { return a == nil && b == nil }
    return near(a.x, b.x) && near(a.y, b.y)
}

private func sameSubpaths(_ a: [VectorSubpath], _ b: [VectorSubpath]) -> Bool {
    if a.count != b.count { return false }
    return zip(a, b).allSatisfy { sp, o in
        sp.closed == o.closed && sp.anchors.count == o.anchors.count && zip(sp.anchors, o.anchors).allSatisfy { p, q in
            samePoint(Vec2(p.x, p.y), Vec2(q.x, q.y)) && samePoint(p.in, q.in) && samePoint(p.out, q.out) && (p.corner?.radius ?? 0) == (q.corner?.radius ?? 0)
        }
    }
}

/// The document's nodes with every connector routed again (glue to objects that no longer exist
/// dropped); the same nodes when nothing moved (`rerouteVectorConnectors`). A connector whose ends
/// the port cannot measure yet (art with effects it does not draw, such as Extrude) keeps its geometry.
public func rerouteVectorConnectors(_ nodes: [VectorNode]) -> [VectorNode] {
    var ids: [String] = []
    walkVectorNodes(nodes) { n, _, _ in
        if isVectorConnector(n), truthy(n["connector"]?["start"]) || truthy(n["connector"]?["end"]) { ids.append(n.id) }
    }
    if ids.isEmpty { return nodes }
    var next: [String: VectorNode] = [:]
    for id in ids {
        guard let node = findVectorNode(nodes, id), let r = try? routeVectorConnector(nodes, id) else { continue }
        let changed = !sameSubpaths(node.subpaths, r.subpaths)
        if !changed && !r.droppedStart && !r.droppedEnd { continue }
        var connector = node["connector"]?.objectValue ?? JSONObject()
        if r.droppedStart { remove(&connector, "start") }
        if r.droppedEnd { remove(&connector, "end") }
        var n = node
        if changed { n.subpaths = r.subpaths }
        n["connector"] = .object(connector)
        next[id] = n
    }
    if next.isEmpty { return nodes }
    func map(_ list: [VectorNode]) -> [VectorNode] {
        list.map { n in
            if let hit = next[n.id] { return hit }
            if n.isGroup {
                let children = map(n.children)
                if children != n.children {
                    var g = n
                    g.children = children
                    return g
                }
            }
            return n
        }
    }
    return map(nodes)
}

/// Reads connector settings from untrusted data (JSON, SVG import), or nil.
public func sanitizeVectorConnector(_ value: JSONValue?) -> JSONObject? {
    guard let r = value?.objectValue else { return nil }
    func end(_ v: JSONValue?) -> JSONValue? {
        guard let e = v?.objectValue, let id = e["nodeId"]?.stringValue, !id.isEmpty else { return nil }
        if let side = e["side"]?.stringValue, VECTOR_CONNECTOR_SIDES.contains(side), side != "auto" {
            return .object(JSONObject([("nodeId", .string(id)), ("side", .string(side))]))
        }
        return .object(JSONObject([("nodeId", .string(id))]))
    }
    var out = JSONObject()
    if let s = end(r["start"]) { out["start"] = s }
    if let f = end(r["end"]) { out["end"] = f }
    if let route = r["route"]?.stringValue, VECTOR_CONNECTOR_ROUTES.contains(route), route != "straight" { out["route"] = .string(route) }
    if let radius = r["radius"]?.numberValue, radius.isFinite, radius > 0 { out["radius"] = .number(radius) }
    if let gap = r["gap"]?.numberValue, gap.isFinite, gap >= 0 { out["gap"] = .number(gap) }
    return out
}
