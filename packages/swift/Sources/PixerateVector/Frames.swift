import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Frames (artboards) and their children's resizing constraints (`vector/frames.ts`). A frame is a
// group with `frame` set (`isVectorFrame`, `vectorFrameRect`, `vectorFrameRectPath` and
// `vectorFrameChildMatrix` live in `Features.swift`, which the core geometry needs). It draws
// through `vectorFrameDrawn`, an equivalent clip group (or a plain group without the clip), so
// rendering, masks and export reuse the mask group machinery.

/// The horizontal resizing constraints (`VECTOR_HORIZONTAL_RESIZING`).
public let VECTOR_HORIZONTAL_RESIZING = ["left", "right", "leftRight", "center", "scale"]
/// The vertical resizing constraints (`VECTOR_VERTICAL_RESIZING`).
public let VECTOR_VERTICAL_RESIZING = ["top", "bottom", "topBottom", "center", "scale"]

/// Whether a frame's `fill` draws (`fill !== undefined && fill !== null && fill !== 'none'`).
func vectorFrameHasFill(_ frame: JSONObject) -> Bool {
    guard let fill = frame["fill"] else { return false }
    return fill != .null && fill != .string("none")
}

/// A page's drawn master art (`masterArt`, kept as the nodes' JSON), or nil.
func vectorFrameMasterArt(_ node: VectorNode) -> [VectorNode]? {
    guard let list = node["masterArt"]?.arrayValue else { return nil }
    return list.compactMap { try? VectorNode(json: $0) }
}

/// The frame as an equivalent plain group (`vectorFrameDrawn`): a clip group (`mask: clip`) whose
/// mask is the frame's rectangle (`<id>~frame-clip`), then its fill (`<id>~frame-fill`), a page's
/// master art and its children; without the clip, a group of the fill, master art and children.
/// Same id, transform and appearance.
public func vectorFrameDrawn(_ node: VectorNode) -> VectorNode {
    guard let frame = node.frame else { return node }
    var group = node
    group["frame"] = Optional<JSONValue>.none
    group["masterArt"] = Optional<JSONValue>.none
    let rect = vectorFrameRectPath(frame)
    // A page draws its master page's art under its own.
    let below = vectorFrameMasterArt(node) ?? []
    let fill: [VectorNode] = vectorFrameHasFill(frame)
        ? [VectorNode(props: JSONObject([("id", .string("\(node.id)~frame-fill")), ("type", "path"), ("fill", frame["fill"]!), ("stroke", .null)]), subpaths: rect)]
        : []
    if frame["clip"] == .bool(false) {
        group.children = fill + below + node.children
        return group
    }
    group["mask"] = .object(JSONObject([("type", "clip")]))
    let clip = VectorNode(props: JSONObject([("id", .string("\(node.id)~frame-clip")), ("type", "path"), ("fill", "#000000"), ("stroke", .null)]), subpaths: rect)
    group.children = [clip] + fill + below + node.children
    return group
}

/// Whether `p` (in the frame's own space) lies in its rectangle, within `tolerance`.
public func vectorFrameContains(_ frame: JSONObject, _ p: Vec2, _ tolerance: Double = 0) -> Bool {
    let r = vectorFrameRect(frame)
    return p.x >= r.x - tolerance && p.x <= r.x + r.width + tolerance && p.y >= r.y - tolerance && p.y <= r.y + r.height + tolerance
}

private func finite(_ v: JSONValue?) -> Double? {
    guard let n = v?.numberValue, n.isFinite else { return nil }
    return n
}

/// Reads a frame from untrusted data (JSON, agent input, SVG import), or nil.
public func sanitizeVectorFrame(_ value: JSONValue?) -> JSONObject? {
    guard let r = value?.objectValue else { return nil }
    guard let x = finite(r["x"]), let y = finite(r["y"]), let w = finite(r["width"]), let h = finite(r["height"]), w >= 0, h >= 0 else { return nil }
    var out = JSONObject([("x", .number(x)), ("y", .number(y)), ("width", .number(w)), ("height", .number(h))])
    if let fill = r["fill"] {
        if fill.stringValue != nil || fill.objectValue != nil { out["fill"] = fill }
    }
    if r["clip"] == .bool(false) { out["clip"] = false }
    if r["master"] == .bool(true) { out["master"] = true }
    if let m = r["masterId"]?.stringValue, !m.isEmpty { out["masterId"] = .string(m) }
    return out
}

/// Reads resizing constraints from untrusted data, or nil (unknown values dropped).
public func sanitizeVectorResizing(_ value: JSONValue?) -> JSONObject? {
    guard let r = value?.objectValue else { return nil }
    var out = JSONObject()
    if let h = r["horizontal"]?.stringValue, VECTOR_HORIZONTAL_RESIZING.contains(h) { out["horizontal"] = .string(h) }
    if let v = r["vertical"]?.stringValue, VECTOR_VERTICAL_RESIZING.contains(v) { out["vertical"] = .string(v) }
    return out.isEmpty ? nil : out
}

/// Labels for the resizing constraint pickers.
public let VECTOR_HORIZONTAL_RESIZING_LABELS: [String: String] = ["left": "Left", "right": "Right", "leftRight": "Left & right", "center": "Centre", "scale": "Scale"]
public let VECTOR_VERTICAL_RESIZING_LABELS: [String: String] = ["top": "Top", "bottom": "Bottom", "topBottom": "Top & bottom", "center": "Centre", "scale": "Scale"]

/// Whether `inner` lies wholly in `outer` (false for a missing box).
public func vectorBoundsInside(_ inner: VectorBounds?, _ outer: VectorBounds) -> Bool {
    guard let inner else { return false }
    return inner.x >= outer.x - 1e-9 && inner.y >= outer.y - 1e-9 && inner.x + inner.width <= outer.x + outer.width + 1e-9 && inner.y + inner.height <= outer.y + outer.height + 1e-9
}

/// Top-level frames of a document (its artboards), bottom to top.
public func vectorArtboards(_ nodes: [VectorNode]) -> [VectorNode] { nodes.filter(isVectorFrame) }

/// A document of one frame on its own, sized to the frame with the frame's corner at the origin
/// (its rotation undone), for exporting an artboard (`vectorFrameDocument`). Symbols and the page
/// background are carried over. Nil when `id` is not a frame.
public func vectorFrameDocument(_ doc: VectorDocument, _ id: String) -> VectorDocument? {
    guard let node = findVectorNode(doc.nodes, id), isVectorFrame(node), let frame = node.frame else { return nil }
    var rest = node
    rest["transform"] = Optional<JSONValue>.none
    let r = vectorFrameRect(frame)
    // `x || y`: a non-zero (and not NaN) corner moves.
    if (r.x != 0 && !r.x.isNaN) || (r.y != 0 && !r.y.isNaN) { rest["transform"] = VectorMatrix(1, 0, 0, 1, -r.x, -r.y).json }
    var out = VectorDocument(width: r.width, height: r.height)
    if let bg = doc.background, !bg.isEmpty { out.background = bg }
    out.nodes = [rest]
    if let symbols = doc.symbols, !symbols.isEmpty { out.symbols = symbols }
    return out
}
