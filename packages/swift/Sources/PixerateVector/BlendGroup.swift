import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Live blend groups (`vector/blendGroup.ts`): a group whose `blend` is set keeps its key shapes as
// children and regenerates the in-betweens (`blendStep` children, locked) whenever a key or the
// options change. Steps follow the straight lines between the keys' centres, or a replaced spine.
//
// Portions ported from vectorcraft-main/crates/doc/src/blend.rs (MIT OR Apache-2.0, © ArtCraft
// Team and contributors). See THIRD_PARTY_NOTICES.md.
//
// The TS caches steps per key object and morphs per key pair; Swift nodes are values, so the
// controller keeps a cache keyed by the blend's id and compares keys and options by value
// (`VectorBlendCache`), which gives the same children.

public let DEFAULT_VECTOR_BLEND_STEPS = 5.0
public let DEFAULT_VECTOR_BLEND_DISTANCE = 20.0
/// Most steps between two keys.
public let VECTOR_BLEND_MAX_STEPS = 1000.0
/// Most steps smooth colour makes between two keys.
public let VECTOR_BLEND_MAX_SMOOTH_STEPS = 256.0
/// The blend spacings (`VECTOR_BLEND_SPACINGS`).
public let VECTOR_BLEND_SPACINGS = ["steps", "distance", "smoothColor"]

/// Whether a node is a live blend group.
public func isVectorBlendGroup(_ node: VectorNode?) -> Bool {
    guard let node else { return false }
    return node.isGroup && truthy(node["blend"])
}

/// The keys of a blend group (its children that are not generated steps), in stacking order.
public func vectorBlendKeys(_ group: VectorNode) -> [VectorNode] { group.children.filter { !truthy($0["blendStep"]) } }

/// The full options of a blend, defaults filled in (`resolveVectorBlendOptions`):
/// `{ spacing, steps, distance, orientToSpine, linear }`.
public func resolveVectorBlendOptions(_ options: JSONValue?) -> JSONObject {
    func given(_ k: String) -> JSONValue? {
        guard let v = options?[k], v != .null else { return nil }
        return v
    }
    return JSONObject([
        ("spacing", given("spacing") ?? "steps"),
        ("steps", given("steps") ?? .number(DEFAULT_VECTOR_BLEND_STEPS)),
        ("distance", given("distance") ?? .number(DEFAULT_VECTOR_BLEND_DISTANCE)),
        ("orientToSpine", given("orientToSpine") ?? false),
        ("linear", given("linear") ?? false),
    ])
}

// MARK: - Step counts

private func paintColors(_ p: JSONValue?) -> [JSONValue] {
    if let s = p?.stringValue { return [.string(s)] }
    guard let o = p?.objectValue else { return [] }
    if o["type"] == "mesh" { return o["colors"]?.arrayValue ?? [] }
    if o["type"] == "freeform" { return (o["points"]?.arrayValue ?? []).map { $0["color"] ?? .null } }
    return (o["stops"]?.arrayValue ?? []).map { $0["color"] ?? .null }
}

/// Largest channel difference (0–1) between the colours of two shapes' fills and strokes (`vectorBlendColorDistance`).
public func vectorBlendColorDistance(_ a: VectorNode, _ b: VectorNode) -> Double {
    guard let pa = collectPathNodes(a).first, let pb = collectPathNodes(b).first else { return 0 }
    var d = 0.0
    for key in ["fill", "stroke"] {
        let ca = paintColors(pa[key])
        let cb = paintColors(pb[key])
        for (i, c) in ca.enumerated() {
            guard let other = i < cb.count ? cb[i] : cb.first else { continue }
            guard let x = c.stringValue.flatMap(parseVectorColor), let y = other.stringValue.flatMap(parseVectorColor) else { continue }
            d = JS.max(d, JS.max(JS.max(abs(x[0] - y[0]), abs(x[1] - y[1])), JS.max(abs(x[2] - y[2]), abs(x[3] - y[3]))))
        }
    }
    return d
}

private func centreOf(_ n: VectorNode) throws -> PathPoint {
    guard let b = try vectorNodeBounds(n) else { return PathPoint(0, 0) }
    return PathPoint(b.x + b.width / 2, b.y + b.height / 2)
}

/// Number of in-betweens between two keys `length` apart along the spine (`vectorBlendStepCount`).
public func vectorBlendStepCount(_ a: VectorNode, _ b: VectorNode, _ options: JSONValue?, _ length: Double) throws -> Int {
    let o = resolveVectorBlendOptions(options)
    switch o["spacing"]?.stringValue {
    case "distance":
        let d = JS.max(0.01, o["distance"]?.numberValue ?? .nan)
        return Int(JS.min(VECTOR_BLEND_MAX_STEPS, JS.max(0, JS.round(length / d) - 1)))
    case "smoothColor":
        let cd = vectorBlendColorDistance(a, b)
        if cd > 1.0 / 255 { return Int(JS.min(VECTOR_BLEND_MAX_SMOOTH_STEPS, JS.max(1, JS.ceil((cd * 255) / 2)))) }
        // Same colours: base the count on how far the shapes are apart.
        var dist = length
        if let ba = try vectorNodeBounds(a), let bb = try vectorNodeBounds(b) {
            dist = JS.max(JS.max(abs(ba.x - bb.x), abs(ba.y - bb.y)), JS.max(abs(ba.x + ba.width - bb.x - bb.width), abs(ba.y + ba.height - bb.y - bb.height)))
        }
        return Int(JS.min(VECTOR_BLEND_MAX_SMOOTH_STEPS, JS.max(1, JS.ceil(dist / 2))))
    default:
        let steps = o["steps"]?.numberValue ?? .nan
        return Int(JS.min(VECTOR_BLEND_MAX_STEPS, JS.max(1, JS.round(steps.isFinite ? steps : DEFAULT_VECTOR_BLEND_STEPS))))
    }
}

// MARK: - Spine

/// A subpath flattened to a polyline with cumulative arc lengths and tangent angles (`VectorBlendRail`).
public struct VectorBlendRail: Equatable {
    public var pts: [PathPoint]
    public var cum: [Double]
    public var angles: [Double]
    public var total: Double
    public var closed: Bool
}

/// Flattens a spine subpath (32 samples per curve). Nil with fewer than two distinct points (`vectorBlendRail`).
public func vectorBlendRail(_ sp: VectorSubpath) -> VectorBlendRail? {
    var pts: [PathPoint] = []
    var angles: [Double] = []
    func push(_ p: PathPoint, _ tangent: PathPoint) {
        if let last = pts.last, JS.hypot(p[0] - last[0], p[1] - last[1]) < 1e-9 { return }
        pts.append(p)
        angles.append(JS.atan2(tangent[1], tangent[0]))
    }
    let count = subpathSegmentCount(sp)
    for i in 0 ..< count {
        let seg = subpathSegment(sp, i)
        let samples = seg.count == 2 ? 1 : 32
        if i == 0 { push(seg[0], segmentTangent(seg, 0)) }
        for k in 1 ... samples { push(segmentPoint(seg, Double(k) / Double(samples)), segmentTangent(seg, Double(k) / Double(samples))) }
    }
    if pts.count < 2 { return nil }
    var cum = [0.0]
    for i in 1 ..< pts.count { cum.append(cum[i - 1] + JS.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])) }
    return VectorBlendRail(pts: pts, cum: cum, angles: angles, total: cum[cum.count - 1], closed: sp.closed)
}

/// Point and direction (radians) at arc length `s` (clamped; a closed rail wraps; `vectorBlendRailAt`).
public func vectorBlendRailAt(_ rail: VectorBlendRail, _ s: Double) -> (point: PathPoint, angle: Double) {
    var len = s.isFinite ? s : 0
    if rail.closed && rail.total > 0 { len = (len.truncatingRemainder(dividingBy: rail.total) + rail.total).truncatingRemainder(dividingBy: rail.total) }
    len = JS.min(rail.total, JS.max(0, len))
    var lo = 0
    var hi = rail.cum.count - 1
    while hi - lo > 1 {
        let mid = (lo + hi) >> 1
        if rail.cum[mid] <= len { lo = mid } else { hi = mid }
    }
    let span = rail.cum[hi] - rail.cum[lo]
    let u = span > 1e-12 ? (len - rail.cum[lo]) / span : 0
    let a = rail.pts[lo]
    let b = rail.pts[hi]
    return (PathPoint(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u), JS.atan2(b[1] - a[1], b[0] - a[0]))
}

/// The spine of a blend in the group's space and where along it each key sits (`vectorBlendSpine`):
/// the replaced spine (keys spread evenly by arc length) or the straight lines between the keys' centres.
public func vectorBlendSpine(_ group: VectorNode) throws -> (spine: VectorSubpath, rail: VectorBlendRail, stops: [Double], replaced: Bool)? {
    let keys = vectorBlendKeys(group)
    if keys.count < 2 { return nil }
    if let raw = group["blend"]?["spine"], truthy(raw), let stored = try? VectorSubpath(json: raw), stored.anchors.count >= 2, let rail = vectorBlendRail(stored) {
        let end = rail.closed ? rail.total * (1 - 1 / Double(keys.count)) : rail.total
        return (stored, rail, keys.indices.map { (end * Double($0)) / Double(keys.count - 1) }, true)
    }
    let centres = try keys.map(centreOf)
    let spine = VectorSubpath(closed: false, anchors: centres.map { VectorAnchor(x: $0[0], y: $0[1]) })
    var stops = [0.0]
    for i in 1 ..< centres.count { stops.append(stops[i - 1] + JS.hypot(centres[i][0] - centres[i - 1][0], centres[i][1] - centres[i - 1][1])) }
    let rail = vectorBlendRail(spine) ?? VectorBlendRail(pts: centres, cum: stops, angles: centres.map { _ in 0 }, total: stops[stops.count - 1], closed: false)
    return (spine, rail, stops, false)
}

/// Where each key of a blend should sit: its stop on the spine (`vectorBlendKeyTargets`).
public func vectorBlendKeyTargets(_ group: VectorNode) throws -> [PathPoint] {
    guard let s = try vectorBlendSpine(group) else { return [] }
    return s.stops.map { vectorBlendRailAt(s.rail, $0).point }
}

// MARK: - Generating steps

private func morphFor(_ a: VectorNode, _ b: VectorNode, _ blend: JSONValue?) throws -> VectorMorph {
    func start(_ id: String) -> Int? { blend?["starts"]?[id]?.numberValue.map { Int($0) } }
    return try createVectorMorph(a, b, VectorMorphOptions(linear: truthy(blend?["linear"]), starts: (start(a.id), start(b.id))))
}

private func wrapAngle(_ a: Double) -> Double { JS.atan2(JS.sin(a), JS.cos(a)) }

/// A step marked as generated: locked, flagged, ids derived from `id`.
private func asStep(_ node: VectorNode, _ id: String) -> VectorNode {
    func rename(_ n: VectorNode, _ nid: String) -> VectorNode {
        var c = n
        c.id = nid
        if n.isGroup { c.children = n.children.enumerated().map { i, k in rename(k, "\(nid).\(i)") } }
        return c
    }
    var step = rename(node, id)
    step["blendStep"] = true
    step["locked"] = true
    return step
}

/// A blend group's children with fresh steps: each key followed by the in-betweens to the next,
/// bottom to top (`generateVectorBlendChildren`). Groups with fewer than two keys keep just their keys.
public func generateVectorBlendChildren(_ group: VectorNode) throws -> [VectorNode] {
    let keys = vectorBlendKeys(group)
    let blend = group["blend"]
    if !truthy(blend) || keys.count < 2 { return keys }
    guard let spine = try vectorBlendSpine(group) else { return keys }
    var out: [VectorNode] = []
    var counter = 0
    for (i, a) in keys.enumerated() {
        out.append(a)
        if i + 1 >= keys.count { continue }
        let b = keys[i + 1]
        let s0 = spine.stops[i]
        let s1 = spine.stops[i + 1]
        let n = try vectorBlendStepCount(a, b, blend, abs(s1 - s0))
        let morph = try morphFor(a, b, blend)
        let p0 = vectorBlendRailAt(spine.rail, s0)
        let p1 = vectorBlendRailAt(spine.rail, s1)
        if n < 1 { continue }
        for j in 1 ... n {
            let t = Double(j) / Double(n + 1)
            var step = try morph.at(t)
            if spine.replaced {
                let p = vectorBlendRailAt(spine.rail, s0 + (s1 - s0) * t)
                let dx = p.point[0] - (p0.point[0] + (p1.point[0] - p0.point[0]) * t)
                let dy = p.point[1] - (p0.point[1] + (p1.point[1] - p0.point[1]) * t)
                // The TS compares with the shared IDENTITY_MATRIX object: `moved` says whether `m` is a new matrix.
                var moved = JS.hypot(dx, dy) > 1e-9
                var m = moved ? translateMatrix(dx, dy) : IDENTITY_MATRIX
                if truthy(blend?["orientToSpine"]) {
                    let turn = wrapAngle(p.angle - (p0.angle + wrapAngle(p1.angle - p0.angle) * t))
                    if abs(turn) > 1e-9 {
                        let c = try centreOf(step)
                        let origin = Vec2(c[0] + m.e, c[1] + m.f)
                        m = multiplyMatrices(m, rotateMatrix((turn * 180) / Double.pi, origin))
                        moved = true
                    }
                }
                if moved { step = try transformVectorNode(step, m) }
            }
            counter += 1
            out.append(asStep(step, "\(group.id)~\(counter)"))
        }
    }
    return out
}

/// Steps cached per blend id, reused while the keys and options are the same (the TS caches them
/// per key object). Owned by a controller.
final class VectorBlendCache {
    private var entries: [String: (blend: JSONValue?, keys: [VectorNode], children: [VectorNode])] = [:]

    func children(_ group: VectorNode) throws -> [VectorNode] {
        let keys = vectorBlendKeys(group)
        if let hit = entries[group.id], hit.blend == group["blend"], hit.keys == keys { return hit.children }
        let children = try generateVectorBlendChildren(group)
        entries[group.id] = (group["blend"], keys, children)
        return children
    }
}

/// Nodes with every blend group's steps brought up to date, nested blends first (`refreshVectorBlends`).
func refreshVectorBlends(_ nodes: [VectorNode], _ cache: VectorBlendCache = VectorBlendCache()) throws -> [VectorNode] {
    try nodes.map { n in
        guard n.isGroup else { return n }
        var next = n
        let inner = try refreshVectorBlends(n.children, cache)
        if inner != n.children { next.children = inner }
        if truthy(next["blend"]) {
            let children = try cache.children(next)
            if children != next.children { next.children = children }
        }
        return next
    }
}

/// A step or key with the generated flags dropped and fresh ids.
private func plain(_ node: VectorNode, _ newId: () -> String) -> VectorNode {
    var n = node
    n["blendStep"] = Optional<JSONValue>.none
    n["locked"] = Optional<JSONValue>.none
    n.id = newId()
    if n.isGroup { n.children = n.children.map { plain($0, newId) } }
    return n
}

/// Expand: the blend as a plain group of its keys and steps, the steps with fresh ids (`expandVectorBlend`).
public func expandVectorBlend(_ group: VectorNode, _ newId: () -> String) -> VectorNode {
    var g = group
    g["blend"] = Optional<JSONValue>.none
    g.children = group.children.map { truthy($0["blendStep"]) ? plain($0, newId) : $0 }
    return g
}

/// Release: the blend's keys in the group's parent space (its transform and opacity applied),
/// followed by the replaced spine as an unpainted path when there is one (`releaseVectorBlend`).
public func releaseVectorBlend(_ group: VectorNode, _ newId: () -> String) throws -> [VectorNode] {
    let m = nodeMatrix(group)
    let transformed = truthy(group["transform"])
    let opacity = group.opacity
    let keys: [VectorNode] = try vectorBlendKeys(group).map { c in
        var k = transformed ? try transformVectorNode(c, m) : c
        if let opacity, opacity < 1 { k.opacity = (k.opacity ?? 1) * opacity }
        return k
    }
    guard let raw = group["blend"]?["spine"], truthy(raw), let spine = try? VectorSubpath(json: raw), spine.anchors.count >= 2 else { return keys }
    let path = VectorNode(
        props: JSONObject([("id", .string(newId())), ("type", "path"), ("name", "Spine"), ("fill", .null), ("stroke", .null)]),
        subpaths: [VectorSubpath(closed: spine.closed, anchors: spine.anchors)]
    )
    return keys + [transformed ? try transformVectorNode(path, m) : path]
}
