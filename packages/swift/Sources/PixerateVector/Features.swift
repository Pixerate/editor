import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// The parts of the vector features the core geometry needs: which nodes have a live appearance
// (`appearance.ts`, `frames.ts`, `mask.ts`, `lens.ts`, `symmetry.ts`), and how paints, width
// profiles, symmetry settings and frames follow a transform baked into a node (`gradient.ts`,
// `shading.ts`, `width.ts`, `symmetry.ts`, `frames.ts`). Paints, profiles and settings are JSON,
// changed the way the TS spreads its objects.

public let VECTOR_GRADIENT_TYPES = ["linear", "radial", "conic", "reflected", "diamond"]
public let VECTOR_MASK_TYPES = ["clip", "alpha", "luminance"]
public let VECTOR_LENS_TYPES = ["transparency", "magnify", "fisheye", "brighten", "invert", "tintedGrayscale", "colorAdd", "colorLimit", "heatMap", "wireframe"]
public let VECTOR_EFFECT_TYPES = ["trim", "roundCorners", "puckerBloat", "twist", "zigzag", "wiggle", "offset", "merge", "repeater", "envelope", "contour", "blockShadow", "extrude", "bevel"]

// MARK: - Node kinds

/// A frame: a group with `frame`, and not a blend, live boolean or mask group.
public func isVectorFrame(_ node: VectorNode?) -> Bool {
    guard let node, node.isGroup else { return false }
    return truthy(node["frame"]) && !truthy(node["blend"]) && !truthy(node["liveBoolean"]) && !truthy(node["mask"])
}

/// A mask group: a group with a known `mask` type, at least one child, and not a blend or live boolean.
public func isVectorMaskGroup(_ node: VectorNode?) -> Bool {
    guard let node, node.isGroup, truthy(node["mask"]) else { return false }
    guard let t = node["mask"]?["type"]?.stringValue, VECTOR_MASK_TYPES.contains(t) else { return false }
    return !truthy(node["blend"]) && !truthy(node["liveBoolean"]) && !node.children.isEmpty
}

/// A mask group whose mask child is visible.
public func isVectorMaskActive(_ node: VectorNode?) -> Bool {
    guard let node, isVectorMaskGroup(node) else { return false }
    return node.children[0].isVisible
}

/// A path whose `lens` has a known type.
public func isVectorLens(_ node: VectorNode?) -> Bool {
    guard let node, node.isPath, truthy(node["lens"]) else { return false }
    guard let t = node["lens"]?["type"]?.stringValue else { return false }
    return VECTOR_LENS_TYPES.contains(t)
}

/// A live symmetry group (not a blend, live boolean, mask group or frame).
public func isVectorSymmetryGroup(_ node: VectorNode?) -> Bool {
    guard let node, node.isGroup else { return false }
    return truthy(node["symmetry"]) && !truthy(node["blend"]) && !truthy(node["liveBoolean"]) && !truthy(node["mask"]) && !truthy(node["frame"])
}

/// A live boolean group.
public func isVectorLiveBoolean(_ node: VectorNode?) -> Bool {
    guard let node else { return false }
    return node.isGroup && truthy(node["liveBoolean"])
}

/// An effect that takes part: enabled and of a known type.
private func isEnabledEffect(_ e: JSONValue) -> Bool {
    guard let t = e["type"]?.stringValue else { return false }
    return e["enabled"] != .bool(false) && VECTOR_EFFECT_TYPES.contains(t)
}

/// Whether the node draws something other than its stored geometry (`hasOwnVectorAppearance`):
/// text, instances, live booleans, frames, symmetry groups, lenses and enabled path effects.
public func hasOwnVectorAppearance(_ node: VectorNode) -> Bool {
    if node.isText || node.isInstance || isVectorLiveBoolean(node) || isVectorFrame(node) || isVectorSymmetryGroup(node) || isVectorLens(node) { return true }
    return node["effects"]?.arrayValue?.contains(where: isEnabledEffect) ?? false
}

/// Whether the node or anything inside it has a live appearance.
public func hasVectorAppearance(_ node: VectorNode) -> Bool {
    hasOwnVectorAppearance(node) || (node.isGroup && node.children.contains(where: hasVectorAppearance))
}

// MARK: - Paints

/// True when the paint draws something (not absent, `null`, `'none'`, `'transparent'` or empty).
public func hasPaint(_ paint: JSONValue?) -> Bool {
    switch paint {
    case .none, .some(.null): return false
    case .some(.string(let s)):
        let p = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return p != "" && p != "none" && p != "transparent"
    default: return true
    }
}

/// A gradient paint (any style) with a `stops` array.
public func isVectorGradient(_ paint: JSONValue?) -> Bool {
    guard let o = paint?.objectValue, let t = o["type"]?.stringValue else { return false }
    return VECTOR_GRADIENT_TYPES.contains(t) && o["stops"]?.arrayValue != nil
}

public func isVectorMeshGradient(_ paint: JSONValue?) -> Bool {
    guard let o = paint?.objectValue else { return false }
    return o["type"] == .string("mesh") && o["points"]?.arrayValue != nil
}

public func isVectorFreeformGradient(_ paint: JSONValue?) -> Bool {
    guard let o = paint?.objectValue else { return false }
    return o["type"] == .string("freeform") && o["points"]?.arrayValue != nil
}

/// A mesh or freeform gradient.
public func isVectorShadedPaint(_ paint: JSONValue?) -> Bool { isVectorMeshGradient(paint) || isVectorFreeformGradient(paint) }

/// `p.x` / `p.y` read as JS numbers (`undefined` arithmetic gives NaN).
private func coord(_ p: JSONValue?, _ key: String) -> Double { p?[key]?.numberValue ?? .nan }

private func finitePoint(_ p: JSONValue?) -> Bool {
    guard let x = p?["x"]?.numberValue, let y = p?["y"]?.numberValue else { return false }
    return x.isFinite && y.isFinite
}

/// `gradient.ts`'s exact identity test.
private func isExactIdentity(_ m: VectorMatrix) -> Bool { m.a == 1 && m.b == 0 && m.c == 0 && m.d == 1 && m.e == 0 && m.f == 0 }

/// A gradient after its node's geometry is mapped by `m`: a `userSpaceOnUse` gradient's points
/// map too; a box gradient follows the box and is unchanged.
public func transformVectorGradient(_ g: JSONObject, _ m: VectorMatrix) -> JSONObject {
    let explicit = finitePoint(g["start"]) && finitePoint(g["end"])
    if !explicit || g["units"] != .string("userSpaceOnUse") || isExactIdentity(m) { return g }
    let start = Vec2(coord(g["start"], "x"), coord(g["start"], "y"))
    let end = Vec2(coord(g["end"], "x"), coord(g["end"], "y"))
    let width = finitePoint(g["width"]) ? Vec2(coord(g["width"], "x"), coord(g["width"], "y")) : Vec2(start.x + -(end.y - start.y), start.y + (end.x - start.x))
    let focal = g["type"] == .string("radial") && finitePoint(g["focal"]) ? Vec2(coord(g["focal"], "x"), coord(g["focal"], "y")) : nil
    var out = g
    out["start"] = applyMatrix(m, start).json
    out["end"] = applyMatrix(m, end).json
    out["width"] = applyMatrix(m, width).json
    if let focal { out["focal"] = applyMatrix(m, focal).json }
    return out
}

/// A mesh or freeform paint moved by `m` (it lives in the node's own space).
public func transformVectorShadedPaint(_ paint: JSONObject, _ m: VectorMatrix) -> JSONObject {
    var out = paint
    let points = paint["points"]?.arrayValue ?? []
    if isVectorMeshGradient(.object(paint)) {
        out["points"] = .array(points.map { applyMatrix(m, Vec2(coord($0, "x"), coord($0, "y"))).json })
    } else {
        out["points"] = .array(points.map { p in
            let q = applyMatrix(m, Vec2(coord(p, "x"), coord(p, "y")))
            var o = p.objectValue ?? JSONObject()
            o["x"] = .number(q.x)
            o["y"] = .number(q.y)
            return .object(o)
        })
    }
    return out
}

/// A paint after its node's geometry is mapped by `m` (colours unchanged).
public func transformVectorPaint(_ paint: JSONValue?, _ m: VectorMatrix) -> JSONValue? {
    if isVectorShadedPaint(paint), let o = paint?.objectValue { return .object(transformVectorShadedPaint(o, m)) }
    if isVectorGradient(paint), let o = paint?.objectValue { return .object(transformVectorGradient(o, m)) }
    return paint
}

// MARK: - Width profiles and symmetry

/// The profile of a mirrored path: each point `{ t, left: right, right: left }`.
public func mirrorWidthProfile(_ points: [JSONValue]) -> [JSONValue] {
    points.map { p in
        var o = JSONObject()
        if let t = p["t"] { o["t"] = t }
        if let r = p["right"] { o["left"] = r }
        if let l = p["left"] { o["right"] = l }
        return .object(o)
    }
}

/// The symmetry settings carried through a map baked into the group: its centre moves, its axes
/// turn with a rotation and flip with a mirror.
public func transformVectorSymmetry(_ s: JSONObject, _ m: VectorMatrix) -> JSONObject {
    let cx = coord(s["center"], "x")
    let cy = coord(s["center"], "y")
    let center = Vec2(m.a * cx + m.c * cy + m.e, m.b * cx + m.d * cy + m.f)
    let det = m.a * m.d - m.b * m.c
    let angle = (JS.atan2(m.b, m.a) * 180) / Double.pi
    let own = s["rotation"]?.numberValue ?? 0
    let rotation = det < 0 ? -own + 2 * angle : own + angle
    let norm = (rotation.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
    var out = s
    out["center"] = center.json
    if abs(norm) > 1e-9 && abs(norm - 360) > 1e-9 { out["rotation"] = .number(norm) } else { remove(&out, "rotation") }
    return out
}

// MARK: - Frames

/// A frame's rectangle, from its JSON (`x`, `y`, `width`, `height`).
public func vectorFrameRect(_ frame: JSONObject) -> VectorBounds {
    VectorBounds(x: frame["x"]?.numberValue ?? .nan, y: frame["y"]?.numberValue ?? .nan, width: frame["width"]?.numberValue ?? .nan, height: frame["height"]?.numberValue ?? .nan)
}

/// The frame's rectangle as a closed four-anchor path (in the frame's own space).
public func vectorFrameRectPath(_ frame: JSONObject) -> [VectorSubpath] {
    let r = vectorFrameRect(frame)
    let (x, y, w, h) = (r.x, r.y, r.width, r.height)
    return [VectorSubpath(closed: true, anchors: [VectorAnchor(x: x, y: y), VectorAnchor(x: x + w, y: y), VectorAnchor(x: x + w, y: y + h), VectorAnchor(x: x, y: y + h)])]
}

private enum Axis { case start, end, both, center, scale }

private func axisRule(_ name: String?, horizontal: Bool) -> Axis {
    switch name ?? (horizontal ? "left" : "top") {
    case "left" where horizontal, "top" where !horizontal: .start
    case "right" where horizontal, "bottom" where !horizontal: .end
    case "leftRight" where horizontal, "topBottom" where !horizontal: .both
    case "center": .center
    case "scale": .scale
    default: .start
    }
}

/// Where a child's span [a0, a1] goes when its frame's span [f0, f1] becomes [g0, g1].
private func placeSpan(_ rule: Axis, _ a0: Double, _ a1: Double, _ f0: Double, _ f1: Double, _ g0: Double, _ g1: Double) -> (Double, Double) {
    let size = a1 - a0
    switch rule {
    case .start: return (g0 + (a0 - f0), g0 + (a1 - f0))
    case .end: return (g1 - (f1 - a0), g1 - (f1 - a1))
    case .both:
        let b0 = g0 + (a0 - f0)
        return (b0, JS.max(b0 + JS.min(size, 1e-3), g1 - (f1 - a1)))
    case .center:
        let c = (g0 + g1) / 2 + ((a0 + a1) / 2 - (f0 + f1) / 2)
        return (c - size / 2, c + size / 2)
    case .scale:
        let k = f1 - f0 > 1e-9 ? (g1 - g0) / (f1 - f0) : 1
        return (g0 + (a0 - f0) * k, g0 + (a1 - f0) * k)
    }
}

/// The matrix (in the frame's own space) that takes a child with bounds `box` from frame rectangle
/// `from` to `to` by the child's `resizing` constraints.
public func vectorFrameChildMatrix(_ resizing: JSONValue?, _ box: VectorBounds, _ from: VectorBounds, _ to: VectorBounds) -> VectorMatrix {
    let h = axisRule(resizing?["horizontal"]?.stringValue, horizontal: true)
    let v = axisRule(resizing?["vertical"]?.stringValue, horizontal: false)
    let (x0, x1) = placeSpan(h, box.x, box.x + box.width, from.x, from.x + from.width, to.x, to.x + to.width)
    let (y0, y1) = placeSpan(v, box.y, box.y + box.height, from.y, from.y + from.height, to.y, to.y + to.height)
    let sx = box.width > 1e-9 ? (x1 - x0) / box.width : 1
    let sy = box.height > 1e-9 ? (y1 - y0) / box.height : 1
    return VectorMatrix(sx, 0, 0, sy, x0 - sx * box.x, y0 - sy * box.y)
}
