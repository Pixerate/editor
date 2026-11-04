// Portions ported from photocraft/crates/paint/src/symmetry.rs (MIT OR Apache-2.0, © ArtCraft Team and
// contributors) by way of packages/core/src/paint-editor/guides.ts. See THIRD_PARTY_NOTICES.md.

import Foundation
import PixerateCore
import PixerateRaster

/**
 * Painting guides (`paint-editor/guides.ts` and `stencils.ts`): mirror and kaleidoscope symmetry
 * (every stroke paints its copies), perspective vanishing points strokes snap to, a tracing image
 * under the paint, reference images, and stencils that guide (rulers, arcs) or mask (lines,
 * shapes) strokes.
 */

public let SYMMETRY_MODES = ["off", "vertical", "horizontal", "dual", "diagonal", "kaleidoscope"]
public let MAX_COORDINATE = 1_000_000.0

public struct Point2: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
    var json: JSONValue { pointJSON(x, y) }
    init?(json: JSONValue?) {
        guard let o = json?.objectValue, let x = o["x"]?.finite, let y = o["y"]?.finite else { return nil }
        self.init(x: x, y: y)
    }
}

public struct SymmetryGuide: Equatable, Sendable {
    public var mode = "off"
    public var center: Point2
    public var rotation = 0.0
    public var segments = 6
    public var mirror = true

    var json: JSONObject { ["mode": .string(mode), "center": center.json, "rotation": .number(rotation), "segments": .number(Double(segments)), "mirror": .bool(mirror)] }
}

public struct PerspectiveGuide: Equatable, Sendable {
    public var enabled = false
    public var points: [Point2] = []
    public var snap = true
    var json: JSONObject { ["enabled": .bool(enabled), "points": .array(points.map(\.json)), "snap": .bool(snap)] }
}

public struct GuideRect: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    var json: JSONValue { ["x": .number(x), "y": .number(y), "width": .number(width), "height": .number(height)] }
}

public struct TracingImage: Equatable, Sendable {
    /// PNG data URL.
    public var src: String
    public var width: Int
    public var height: Int
    public var rect: GuideRect
    public var opacity: Double
    public var visible: Bool
    public var sampleColors: Bool
    var json: JSONObject { ["src": .string(src), "width": .number(Double(width)), "height": .number(Double(height)), "rect": rect.json, "opacity": .number(opacity), "visible": .bool(visible), "sampleColors": .bool(sampleColors)] }
}

public struct ReferenceImage: Equatable, Sendable {
    public var id: String
    public var name: String
    public var src: String
    public var width: Int
    public var height: Int
    public var x: Double
    public var y: Double
    public var displayWidth: Double
    public var visible: Bool
    var json: JSONObject { ["id": .string(id), "name": .string(name), "src": .string(src), "width": .number(Double(width)), "height": .number(Double(height)), "x": .number(x), "y": .number(y), "displayWidth": .number(displayWidth), "visible": .bool(visible)] }
}

public struct PaintGuides: Equatable, Sendable {
    public var symmetry: SymmetryGuide
    public var perspective = PerspectiveGuide()
    public var tracing: TracingImage?
    public var references: [ReferenceImage] = []
    public var stencils: [Stencil] = []

    var json: JSONObject {
        ["symmetry": .object(symmetry.json), "perspective": .object(perspective.json), "tracing": tracing.map { .object($0.json) } ?? .null, "references": .array(references.map { .object($0.json) }), "stencils": .array(stencils.map { .object($0.json) })]
    }
}

func defaultGuides(_ canvas: PaintCanvas) -> PaintGuides {
    PaintGuides(symmetry: SymmetryGuide(center: Point2(x: Double(canvas.width) / 2, y: Double(canvas.height) / 2)))
}

private func coord(_ v: JSONValue?, _ d: Double) -> Double {
    guard let n = v?.finite, abs(n) <= MAX_COORDINATE else { return d }
    return n
}

func normalizeSymmetry(_ r: JSONObject, _ base: SymmetryGuide) -> SymmetryGuide {
    let c = r["center"]?.objectValue ?? [:]
    var out = base
    if let m = r["mode"]?.stringValue, SYMMETRY_MODES.contains(m) { out.mode = m }
    out.center = Point2(x: coord(c["x"], base.center.x), y: coord(c["y"], base.center.y))
    if let rot = r["rotation"]?.finite { out.rotation = (rot.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) }
    if let s = r["segments"]?.finite { out.segments = Int(Swift.min(32, Swift.max(2, JS.round(s)))) }
    if let m = r["mirror"]?.boolValue { out.mirror = m }
    return out
}

/// Reflection across the line through `c` in direction angle `a` (radians, clockwise with y down).
private func reflectAbout(_ c: Point2, _ a: Double) -> Affine {
    let dx = JS.cos(a), dy = JS.sin(a)
    let m00 = 2 * dx * dx - 1, m01 = 2 * dx * dy, m11 = 2 * dy * dy - 1
    return [m00, m01, m01, m11, c.x - (m00 * c.x + m01 * c.y), c.y - (m01 * c.x + m11 * c.y)]
}

/// Rotation by `a` radians (clockwise with y down) about `c`.
private func rotateAbout(_ c: Point2, _ a: Double) -> Affine {
    let cos = JS.cos(a), sin = JS.sin(a)
    return [cos, -sin, sin, cos, c.x - (cos * c.x - sin * c.y), c.y - (sin * c.x + cos * c.y)]
}

private func rad(_ deg: Double) -> Double { (deg * Double.pi) / 180 }

/// The axis directions of a mirror mode (radians).
func symmetryAxisAngles(_ g: SymmetryGuide) -> [Double] {
    if g.mode == "off" { return [] }
    if g.mode == "kaleidoscope" { return (0..<g.segments).map { rad(g.rotation) + (Double($0) * Double.pi) / Double(g.segments) } }
    let initial = g.mode == "horizontal" ? 0.0 : g.mode == "diagonal" ? 45 : 90
    let a = rad(initial + g.rotation)
    return g.mode == "dual" ? [a, a + Double.pi / 2] : [a]
}

/// The extra copies a stroke paints under the symmetry guide, as affine maps.
func symmetryCopies(_ g: SymmetryGuide) -> [Affine] {
    let c = g.center
    switch g.mode {
    case "vertical", "horizontal", "diagonal":
        return symmetryAxisAngles(g).map { reflectAbout(c, $0) }
    case "dual":
        let a = symmetryAxisAngles(g)
        return [reflectAbout(c, a[0]), reflectAbout(c, a[1]), rotateAbout(c, Double.pi)]
    case "kaleidoscope":
        var out: [Affine] = []
        let n = g.segments
        for k in 1..<Swift.max(1, n) { out.append(rotateAbout(c, (2 * Double.pi * Double(k)) / Double(n))) }
        if g.mirror {
            let first = reflectAbout(c, rad(g.rotation))
            for k in 0..<n { out.append(composeAffine(rotateAbout(c, (2 * Double.pi * Double(k)) / Double(n)), first)) }
        }
        return out
    default:
        return []
    }
}

func normalizePerspective(_ r: JSONObject, _ base: PerspectiveGuide) throws -> PerspectiveGuide {
    var points = base.points
    if let list = r["points"]?.arrayValue {
        if list.count > 3 { throw PaintEditorError("A perspective guide has one to three vanishing points; got \(list.count).") }
        points = try list.enumerated().map { i, p in
            let q = p.objectValue ?? [:]
            guard let x = q["x"]?.finite, let y = q["y"]?.finite, abs(x) <= MAX_COORDINATE, abs(y) <= MAX_COORDINATE else {
                throw PaintEditorError("points[\(i)] needs finite x and y within ±\(Int(MAX_COORDINATE)) document pixels.")
            }
            return Point2(x: x, y: y)
        }
    }
    let enabled = r["enabled"]?.boolValue ?? base.enabled
    if enabled && points.isEmpty { throw PaintEditorError("An enabled perspective guide needs at least one vanishing point; pass points.") }
    return PerspectiveGuide(enabled: enabled, points: points, snap: r["snap"]?.boolValue ?? base.snap)
}

/// The line families a perspective guide snaps to at `p`: unit directions.
private func perspectiveDirections(_ g: PerspectiveGuide, _ p: Point2) -> [Point2] {
    var out: [Point2] = []
    for v in g.points {
        let dx = v.x - p.x, dy = v.y - p.y
        let len = JS.hypot(dx, dy)
        if len > 1e-6 { out.append(Point2(x: dx / len, y: dy / len)) }
    }
    if g.points.count <= 2 { out.append(Point2(x: 0, y: 1)) }
    if g.points.count <= 1 { out.append(Point2(x: 1, y: 0)) }
    return out
}

/// How far the pen must move before a stroke chooses its perspective line (document pixels).
let SNAP_DECIDE_DISTANCE = 6.0

/// Snaps one stroke to a perspective guide (see `guides.ts`).
final class PerspectiveSnapper {
    private let guide: PerspectiveGuide
    private var start: Point2?
    private var dir: Point2?
    private var decided = false

    init(_ guide: PerspectiveGuide) { self.guide = guide }

    func snap(_ p: PenPoint) -> PenPoint {
        if !guide.enabled || !guide.snap || guide.points.isEmpty { return p }
        guard let s = start else {
            start = Point2(x: p.x, y: p.y)
            return p
        }
        if !decided {
            let dx = p.x - s.x, dy = p.y - s.y
            let len = JS.hypot(dx, dy)
            if len < SNAP_DECIDE_DISTANCE {
                var q = p
                q.x = s.x
                q.y = s.y
                return q
            }
            var best: Point2? = nil
            var bestDot = -1.0
            for d in perspectiveDirections(guide, s) {
                let dot = abs((dx * d.x + dy * d.y) / len)
                if dot > bestDot {
                    bestDot = dot
                    best = d
                }
            }
            dir = best
            decided = best != nil
            if best == nil { return p }
        }
        let d = dir!
        let t = (p.x - s.x) * d.x + (p.y - s.y) * d.y
        var q = p
        q.x = s.x + d.x * t
        q.y = s.y + d.y * t
        return q
    }
}

// MARK: - Stencils (`stencils.ts`)

public let STENCIL_KINDS = ["ruler", "arc", "line", "shape"]
public let STENCIL_SHAPES = ["rect", "ellipse", "polygon"]

public struct Stencil: Equatable, Sendable {
    public var id: String
    public var kind: String
    public var mode: String
    public var enabled: Bool
    public var from: Point2?
    public var to: Point2?
    public var center: Point2?
    public var radius: Double?
    public var startAngle: Double?
    public var endAngle: Double?
    public var shape: String?
    public var rect: GuideRect?
    public var points: [Point2]?
    public var invert: Bool
    public var snap: Double
    public var feather: Double

    var json: JSONObject {
        var o: JSONObject = ["id": .string(id), "kind": .string(kind), "mode": .string(mode), "enabled": .bool(enabled), "invert": .bool(invert), "snap": .number(snap), "feather": .number(feather)]
        if let from { o["from"] = from.json }
        if let to { o["to"] = to.json }
        if let center { o["center"] = center.json }
        if let radius { o["radius"] = .number(radius) }
        if let startAngle { o["startAngle"] = .number(startAngle) }
        if let endAngle { o["endAngle"] = .number(endAngle) }
        if let shape { o["shape"] = .string(shape) }
        if let rect { o["rect"] = rect.json }
        if let points { o["points"] = .array(points.map(\.json)) }
        return o
    }
}

/// A stencil with every field in range; throws a sentence naming what is missing.
func normalizeStencil(_ raw: JSONObject, _ id: String, _ base: Stencil? = nil) throws -> Stencil {
    guard let kind = raw["kind"]?.stringValue.flatMap({ STENCIL_KINDS.contains($0) ? $0 : nil }) ?? base?.kind else {
        throw PaintEditorError("kind \(raw["kind"].map { $0.stringified() } ?? "undefined") is not a stencil; use \(STENCIL_KINDS.joined(separator: ", ")).")
    }
    let modeRaw = raw["mode"]?.stringValue
    var s = Stencil(
        id: id, kind: kind,
        mode: modeRaw == "guide" || modeRaw == "mask" ? modeRaw! : (base?.mode ?? (kind == "ruler" || kind == "arc" ? "guide" : "mask")),
        enabled: raw["enabled"]?.boolValue ?? base?.enabled ?? true,
        invert: raw["invert"]?.boolValue ?? base?.invert ?? false,
        snap: raw["snap"]?.finite.map { Swift.min(400, Swift.max(1, $0)) } ?? base?.snap ?? 40,
        feather: raw["feather"]?.finite.map { Swift.min(100, Swift.max(0, $0)) } ?? base?.feather ?? 1
    )
    if kind == "ruler" || kind == "line" {
        s.from = Point2(json: raw["from"]) ?? base?.from
        s.to = Point2(json: raw["to"]) ?? base?.to
        guard let f = s.from, let t = s.to else { throw PaintEditorError("A \(kind) needs from and to points ({x, y} in document pixels).") }
        if JS.hypot(t.x - f.x, t.y - f.y) < 1 { throw PaintEditorError("A \(kind)'s from and to must be at least 1 px apart.") }
    } else if kind == "arc" {
        s.center = Point2(json: raw["center"]) ?? base?.center
        s.radius = raw["radius"]?.finite ?? base?.radius
        guard s.center != nil, (s.radius ?? 0) > 0 else { throw PaintEditorError("An arc needs a center ({x, y}) and a radius above 0.") }
        s.startAngle = raw["startAngle"]?.finite ?? base?.startAngle ?? 0
        s.endAngle = raw["endAngle"]?.finite ?? base?.endAngle ?? 360
    } else {
        s.shape = raw["shape"]?.stringValue.flatMap { STENCIL_SHAPES.contains($0) ? $0 : nil } ?? base?.shape ?? "rect"
        if s.shape == "polygon" {
            let pts = raw["points"]?.arrayValue.map { $0.compactMap { Point2(json: $0) } } ?? base?.points
            guard let pts, pts.count >= 3 else { throw PaintEditorError("A polygon stencil needs at least 3 points.") }
            s.points = pts
        } else {
            var rect = base?.rect
            if let r = raw["rect"]?.objectValue {
                rect = nil
                if let x = r["x"]?.finite, let y = r["y"]?.finite, let w = r["width"]?.numberValue, let h = r["height"]?.numberValue, w > 0, h > 0 { rect = GuideRect(x: x, y: y, width: w, height: h) }
            }
            guard let rect else { throw PaintEditorError("A \(s.shape!) stencil needs rect {x, y, width, height} with a width and height above 0.") }
            s.rect = rect
        }
    }
    return s
}

/// The outline of a stencil as a polyline (document pixels).
func stencilOutline(_ s: Stencil) -> [Point2] {
    if s.kind == "ruler" || s.kind == "line" { return [s.from!, s.to!] }
    if s.kind == "arc" {
        let a0 = (s.startAngle! * Double.pi) / 180, a1 = (s.endAngle! * Double.pi) / 180
        let n = Swift.max(8, Int(JS.ceil(abs(a1 - a0) * Swift.max(8, s.radius! / 4))))
        return (0...n).map { i in
            let a = a0 + ((a1 - a0) * Double(i)) / Double(n)
            return Point2(x: s.center!.x + JS.cos(a) * s.radius!, y: s.center!.y + JS.sin(a) * s.radius!)
        }
    }
    if s.shape == "polygon" { return s.points! + [s.points![0]] }
    let r = s.rect!
    if s.shape == "rect" { return [Point2(x: r.x, y: r.y), Point2(x: r.x + r.width, y: r.y), Point2(x: r.x + r.width, y: r.y + r.height), Point2(x: r.x, y: r.y + r.height), Point2(x: r.x, y: r.y)] }
    let n = 96
    return (0...n).map { i in
        let a = (Double(i) / Double(n)) * Double.pi * 2
        return Point2(x: r.x + r.width / 2 + (JS.cos(a) * r.width) / 2, y: r.y + r.height / 2 + (JS.sin(a) * r.height) / 2)
    }
}

private func nearestOnPolyline(_ line: [Point2], _ p: Point2) -> (point: Point2, distance: Double) {
    var best = (point: line[0], distance: Double.infinity)
    var i = 0
    while i + 1 < line.count {
        let a = line[i], b = line[i + 1]
        let dx = b.x - a.x, dy = b.y - a.y
        let l2 = dx * dx + dy * dy
        let len2 = l2 == 0 ? 1 : l2
        let t = Swift.min(1, Swift.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
        let q = Point2(x: a.x + dx * t, y: a.y + dy * t)
        let d = JS.hypot(p.x - q.x, p.y - q.y)
        if d < best.distance { best = (q, d) }
        i += 1
    }
    return best
}

private func nearestOnStencil(_ s: Stencil, _ p: Point2) -> (point: Point2, distance: Double) {
    if s.kind == "ruler" || s.kind == "line" {
        let a = s.from!
        let dx = s.to!.x - a.x, dy = s.to!.y - a.y
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)
        let q = Point2(x: a.x + dx * t, y: a.y + dy * t)
        return (q, JS.hypot(p.x - q.x, p.y - q.y))
    }
    if s.kind == "arc", abs(s.endAngle! - s.startAngle!) >= 360 {
        let c = s.center!
        let ang = JS.atan2(p.y - c.y, p.x - c.x)
        let q = Point2(x: c.x + JS.cos(ang) * s.radius!, y: c.y + JS.sin(ang) * s.radius!)
        return (q, JS.hypot(p.x - q.x, p.y - q.y))
    }
    return nearestOnPolyline(stencilOutline(s), p)
}

/// Snaps a stroke to the guide stencils: the first point picks the nearest guide within its `snap` distance.
final class StencilSnapper {
    private let stencils: [Stencil]
    private var chosen = false
    private var guide: Stencil?

    init(_ stencils: [Stencil]) { self.stencils = stencils }

    func snap(_ p: PenPoint) -> PenPoint {
        let pt = Point2(x: p.x, y: p.y)
        if !chosen {
            var best: (s: Stencil, d: Double)? = nil
            for s in stencils where s.enabled && s.mode == "guide" {
                let d = nearestOnStencil(s, pt).distance
                if d <= s.snap && (best == nil || d < best!.d) { best = (s, d) }
            }
            guide = best?.s
            chosen = true
        }
        guard let guide else { return p }
        let q = nearestOnStencil(guide, pt).point
        var out = p
        out.x = q.x
        out.y = q.y
        return out
    }
}

/// Signed distance to a mask stencil's edge: positive where paint may land.
private func maskDistance(_ s: Stencil, _ x: Double, _ y: Double) -> Double {
    var d: Double
    if s.kind == "ruler" || s.kind == "line" {
        let dx = s.to!.x - s.from!.x, dy = s.to!.y - s.from!.y
        let len = JS.hypot(dx, dy)
        d = ((x - s.from!.x) * dy - (y - s.from!.y) * dx) / len
    } else if s.kind == "arc" {
        d = s.radius! - JS.hypot(x - s.center!.x, y - s.center!.y)
    } else if s.shape == "rect" {
        let r = s.rect!
        d = Swift.min(x - r.x, r.x + r.width - x, y - r.y, r.y + r.height - y)
    } else if s.shape == "ellipse" {
        let r = s.rect!
        let rx = r.width / 2, ry = r.height / 2
        let nx = (x - r.x - rx) / rx, ny = (y - r.y - ry) / ry
        let k = JS.hypot(nx, ny)
        d = (1 - k) * Swift.min(rx, ry)
    } else {
        let pts = s.points!
        var inside = false
        var j = pts.count - 1
        for i in 0..<pts.count {
            let a = pts[i], b = pts[j]
            if (a.y > y) != (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x { inside = !inside }
            j = i
        }
        let e = nearestOnPolyline(pts + [pts[0]], Point2(x: x, y: y)).distance
        d = inside ? e : -e
    }
    return s.invert ? -d : d
}

/// The combined coverage of the enabled mask stencils over a canvas (0..255 per pixel), or nil.
func stencilMask(_ stencils: [Stencil], _ width: Int, _ height: Int) -> PaintSelection? {
    let masks = stencils.filter { $0.enabled && $0.mode == "mask" }
    if masks.isEmpty { return nil }
    var data = [UInt8](repeating: 0, count: width * height)
    for y in 0..<height {
        for x in 0..<width {
            var cov = 1.0
            for s in masks {
                let f = Swift.max(0.5, s.feather)
                let d = maskDistance(s, Double(x) + 0.5, Double(y) + 0.5)
                cov = Swift.min(cov, Swift.min(1, Swift.max(0, d / (2 * f) + 0.5)))
                if cov <= 0 { break }
            }
            data[y * width + x] = JS.u8(JS.round(cov * 255))
        }
    }
    return PaintSelection(width: width, height: height, data: data)
}

/// A stencil moved by (dx, dy) document pixels.
func translateStencil(_ s: Stencil, _ dx: Double, _ dy: Double) -> Stencil {
    var o = s
    let p = { (q: Point2?) in q.map { Point2(x: $0.x + dx, y: $0.y + dy) } }
    o.from = p(s.from)
    o.to = p(s.to)
    o.center = p(s.center)
    if let r = s.rect { o.rect = GuideRect(x: r.x + dx, y: r.y + dy, width: r.width, height: r.height) }
    o.points = s.points?.map { Point2(x: $0.x + dx, y: $0.y + dy) }
    return o
}
