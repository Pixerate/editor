import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Live symmetry groups (`vector/symmetry.ts`): children drawn with their mirrored or rotated
// copies. The copies are not stored: they are the group's appearance, rebuilt from its children.
//
// The mirror modes and axes follow photocraft's `crates/paint/src/symmetry.rs` (MIT OR Apache-2.0,
// © ArtCraft Team and contributors; see THIRD_PARTY_NOTICES.md). Radial symmetry is ours. The TS
// caches the drawn group per node object; the Swift builds it each time it is asked.

/// The symmetry modes (`VECTOR_SYMMETRY_MODES`).
public let VECTOR_SYMMETRY_MODES = ["vertical", "horizontal", "dual", "diagonal", "radial"]

/// Labels for the symmetry pickers (`VECTOR_SYMMETRY_MODE_LABELS`).
public let VECTOR_SYMMETRY_MODE_LABELS = ["vertical": "Mirror left / right", "horizontal": "Mirror top / bottom", "dual": "Four quarters", "diagonal": "Mirror diagonally", "radial": "Radial"]

@inline(__always) private func rad(_ deg: Double) -> Double { (deg * Double.pi) / 180 }
@inline(__always) private func exact(_ v: Double) -> Double { abs(v) < 1e-12 ? 0 : v }

private func around(_ c: Vec2, _ m: VectorMatrix) -> VectorMatrix {
    multiplyMatrices(multiplyMatrices(VectorMatrix(1, 0, 0, 1, -c.x, -c.y), m), VectorMatrix(1, 0, 0, 1, c.x, c.y))
}

/// The reflection across the line through `c` at `deg` degrees (clockwise, y down).
private func reflect(_ c: Vec2, _ deg: Double) -> VectorMatrix {
    let a = 2 * rad(deg)
    return around(c, VectorMatrix(exact(JS.cos(a)), exact(JS.sin(a)), exact(JS.sin(a)), exact(-JS.cos(a)), 0, 0))
}

private func turn(_ c: Vec2, _ deg: Double) -> VectorMatrix {
    around(c, VectorMatrix(exact(JS.cos(rad(deg))), exact(JS.sin(rad(deg))), exact(-JS.sin(rad(deg))), exact(JS.cos(rad(deg))), 0, 0))
}

/// The directions (degrees) of the mirror axes of a mode before rotation.
private let AXIS: [String: [Double]] = ["horizontal": [0], "vertical": [90], "diagonal": [45], "dual": [90, 0]]

private func centerOf(_ s: JSONObject) -> Vec2 { Vec2(s["center"]?["x"]?.numberValue ?? .nan, s["center"]?["y"]?.numberValue ?? .nan) }

/// Radial copies clamped to 2–64 (default 6).
private func radialCount(_ s: JSONObject) -> Int { Int(JS.min(64, JS.max(2, JS.round(s["copies"]?.numberValue ?? 6)))) }

/// The copies a symmetry makes, as matrices in the group's space (the original not included; `vectorSymmetryMatrices`).
public func vectorSymmetryMatrices(_ s: JSONObject) -> [VectorMatrix] {
    let c = centerOf(s)
    let r = s["rotation"]?.numberValue ?? 0
    let mode = s["mode"]?.stringValue ?? ""
    if mode == "radial" {
        let n = radialCount(s)
        var out: [VectorMatrix] = []
        for k in 1 ..< n { out.append(turn(c, (360 * Double(k)) / Double(n))) }
        // Kaleidoscope: the reflections across the n axes through the centre.
        if s["mirror"] == .bool(true) { for k in 0 ..< n { out.append(reflect(c, r + (180 * Double(k)) / Double(n))) } }
        return out
    }
    let axes = (AXIS[mode] ?? []).map { reflect(c, $0 + r) }
    // Dual: both mirrors and the half turn between them.
    return mode == "dual" ? axes + [turn(c, 180)] : axes
}

/// A node with its ids (and its children's) made unique for copy `k`.
private func renamed(_ node: VectorNode, _ k: Int) -> VectorNode {
    var n = node
    n.id = "\(node.id)~sym\(k)"
    if n.isGroup { n.children = node.children.map { renamed($0, k) } }
    return n
}

/// The symmetry group as a plain group (`vectorSymmetryDrawn`): its children, then each copy of
/// them (ids `<id>~sym<k>`, locked). Same id, transform and appearance.
public func vectorSymmetryDrawn(_ node: VectorNode) throws -> VectorNode {
    let symmetry = node["symmetry"]?.objectValue ?? JSONObject()
    var group = node
    group["symmetry"] = Optional<JSONValue>.none
    var copies: [VectorNode] = []
    for (k, m) in vectorSymmetryMatrices(symmetry).enumerated() {
        for c in node.children {
            var copy = renamed(try transformVectorNode(c, m), k + 1)
            copy["locked"] = true
            copies.append(copy)
        }
    }
    group.children = node.children + copies
    return group
}

/// The symmetry's axes for display (`vectorSymmetryAxes`): each mirror line (or radial spoke)
/// clipped to `box`, in the group's space.
public func vectorSymmetryAxes(_ s: JSONObject, _ box: VectorBounds) -> [(Vec2, Vec2)] {
    let r = s["rotation"]?.numberValue ?? 0
    let mode = s["mode"]?.stringValue ?? ""
    let c = centerOf(s)
    let dirs: [Double] = mode == "radial" ? (0 ..< radialCount(s)).map { r - 90 + (360 * Double($0)) / Double(radialCount(s)) } : (AXIS[mode] ?? []).map { $0 + r }
    var out: [(Vec2, Vec2)] = []
    for deg in dirs {
        let d = Vec2(JS.cos(rad(deg)), JS.sin(rad(deg)))
        var lo = mode == "radial" ? 0 : -Double.infinity
        var hi = Double.infinity
        var inside = true
        for (o, dv, mn, mx) in [(c.x, d.x, box.x, box.x + box.width), (c.y, d.y, box.y, box.y + box.height)] {
            if abs(dv) < 1e-12 {
                if o < mn || o > mx { inside = false }
            } else {
                let a = (mn - o) / dv
                let b = (mx - o) / dv
                lo = JS.max(lo, JS.min(a, b))
                hi = JS.min(hi, JS.max(a, b))
            }
        }
        if inside && lo.isFinite && hi.isFinite && hi > lo { out.append((Vec2(c.x + lo * d.x, c.y + lo * d.y), Vec2(c.x + hi * d.x, c.y + hi * d.y))) }
    }
    return out
}

/// Symmetry settings from untrusted data (JSON, agent input, SVG import), or nil (`sanitizeVectorSymmetry`):
/// `{ mode, center, rotation?, copies?, mirror? }`.
public func sanitizeVectorSymmetry(_ value: JSONValue?) -> JSONObject? {
    guard let r = value?.objectValue, let mode = r["mode"]?.stringValue, VECTOR_SYMMETRY_MODES.contains(mode) else { return nil }
    guard let x = r["center"]?["x"]?.numberValue, let y = r["center"]?["y"]?.numberValue, x.isFinite, y.isFinite else { return nil }
    var out = JSONObject([("mode", .string(mode)), ("center", Vec2(x, y).json)])
    if let rot = r["rotation"]?.numberValue, rot.isFinite, rot.truncatingRemainder(dividingBy: 360) != 0 {
        out["rotation"] = .number((rot.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360))
    }
    if mode == "radial" {
        if let copies = r["copies"]?.numberValue, copies.isFinite { out["copies"] = .number(JS.min(64, JS.max(2, JS.round(copies)))) }
        if r["mirror"] == .bool(true) { out["mirror"] = true }
    }
    return out
}
