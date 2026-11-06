import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Lens objects (`vector/lens.ts`): a path with `lens` set shows what is drawn below it changed,
// inside its outline. It draws as a clip group whose mask is its own outline and whose contents
// are the backdrop changed by the lens, then its own fill and stroke on top. The backdrop
// (`lensView`, the nodes drawn before the lens in its parent's space) is derived:
// `resolveVectorLenses` brings it up to date after every edit and `stripVectorLensViews` removes
// it from saved documents. It is stored as the nodes' JSON.

/// `VECTOR_LENS_LABELS`.
public let VECTOR_LENS_LABELS = [
    "transparency": "Transparency", "magnify": "Magnify", "fisheye": "Fish Eye", "brighten": "Brighten", "invert": "Invert",
    "tintedGrayscale": "Tinted Grayscale", "colorAdd": "Color Add", "colorLimit": "Color Limit", "heatMap": "Heat Map", "wireframe": "Wireframe",
]

/// A lens type's amount range, default amount and default colour (`VECTOR_LENS_SPECS`).
public struct VectorLensSpec: Sendable {
    public var min: Double
    public var max: Double
    public var amount: Double
    public var color: String?
    public var unit: String
}

public let VECTOR_LENS_SPECS: [String: VectorLensSpec] = [
    "transparency": VectorLensSpec(min: 0, max: 100, amount: 50, color: nil, unit: "percent see-through"),
    "magnify": VectorLensSpec(min: 1, max: 20, amount: 2, color: nil, unit: "times"),
    "fisheye": VectorLensSpec(min: -100, max: 100, amount: 50, color: nil, unit: "percent, negative pinches"),
    "brighten": VectorLensSpec(min: -100, max: 100, amount: 40, color: nil, unit: "percent, negative darkens"),
    "invert": VectorLensSpec(min: 0, max: 100, amount: 100, color: nil, unit: "percent strength"),
    "tintedGrayscale": VectorLensSpec(min: 0, max: 100, amount: 100, color: "#b45309", unit: "percent strength"),
    "colorAdd": VectorLensSpec(min: 0, max: 100, amount: 50, color: "#ff0000", unit: "percent of the colour added"),
    "colorLimit": VectorLensSpec(min: 0, max: 100, amount: 100, color: "#22c55e", unit: "percent strength"),
    "heatMap": VectorLensSpec(min: 0, max: 100, amount: 0, color: nil, unit: "percent the palette is turned"),
    "wireframe": VectorLensSpec(min: 0, max: 100, amount: 100, color: "#0f172a", unit: "percent outline opacity"),
]

/// Lens settings from untrusted data; nil when invalid. Missing values take the type's defaults (`sanitizeVectorLens`).
public func sanitizeVectorLens(_ value: JSONValue?) -> JSONObject? {
    guard let r = value?.objectValue, let type = r["type"]?.stringValue, let spec = VECTOR_LENS_SPECS[type] else { return nil }
    let given = r["amount"]?.numberValue
    let amount = given.map { $0.isFinite ? JS.min(spec.max, JS.max(spec.min, $0)) : spec.amount } ?? spec.amount
    var out = JSONObject([("type", .string(type)), ("amount", .number(amount))])
    if let def = spec.color {
        let c = r["color"]?.stringValue
        out["color"] = .string(c.flatMap { parseVectorColor($0) != nil ? $0 : nil } ?? def)
    }
    return out
}

// MARK: - Colour

private func hex2(_ v: Double) -> String {
    let n = Int(JS.round(JS.min(1, JS.max(0, v)) * 255))
    return (n < 16 ? "0" : "") + String(n, radix: 16)
}

private func formatRgba(_ c: [Double]) -> String {
    if c[3] >= 1 { return "#\(hex2(c[0]))\(hex2(c[1]))\(hex2(c[2]))" }
    return "rgba(\(JSONValue.jsNumber(JS.round(c[0] * 255))), \(JSONValue.jsNumber(JS.round(c[1] * 255))), \(JSONValue.jsNumber(JS.round(c[2] * 255))), \(JSONValue.jsNumber(JS.round(c[3] * 1000) / 1000)))"
}

private func luma(_ c: [Double]) -> Double { 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
private func mix(_ a: [Double], _ b: [Double], _ t: Double) -> [Double] { [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3]] }

private let HEAT: [(Double, String)] = [(0, "#1e1b4b"), (0.25, "#2563eb"), (0.5, "#22c55e"), (0.7, "#facc15"), (0.85, "#f97316"), (1, "#dc2626")]

private func heatAt(_ t: Double) -> [Double] {
    let u = (t.truncatingRemainder(dividingBy: 1) + 1).truncatingRemainder(dividingBy: 1)
    for i in 1 ..< HEAT.count where u <= HEAT[i].0 {
        let a = parseVectorColor(HEAT[i - 1].1)!
        let b = parseVectorColor(HEAT[i].1)!
        let k = (u - HEAT[i - 1].0) / (HEAT[i].0 - HEAT[i - 1].0)
        return (0 ..< 3).map { a[$0] + (b[$0] - a[$0]) * k }
    }
    return Array(parseVectorColor(HEAT[HEAT.count - 1].1)!.prefix(3))
}

/// How a colour lens changes one colour (0–1 channels), or nil for lenses that do not recolour (`vectorLensColorMap`).
public func vectorLensColorMap(_ lens: JSONObject) -> (([Double]) -> [Double])? {
    let tint = parseVectorColor(lens["color"]?.stringValue ?? "#000000") ?? [0, 0, 0, 1]
    let amount = lens["amount"]?.numberValue ?? .nan
    let s = JS.min(1, JS.max(0, amount / 100))
    switch lens["type"]?.stringValue {
    case "brighten":
        let a = JS.min(1, JS.max(-1, amount / 100))
        return { c in a >= 0 ? mix(c, [1, 1, 1], a) : mix(c, [0, 0, 0], -a) }
    case "invert":
        return { c in mix(c, [1 - c[0], 1 - c[1], 1 - c[2]], s) }
    case "tintedGrayscale":
        return { c in
            // Dark to black, middle grey to the tint, light to white.
            let l = luma(c)
            let dark: [Double] = [tint[0] * 2 * l, tint[1] * 2 * l, tint[2] * 2 * l]
            let light: [Double] = (0 ..< 3).map { k in tint[k] + (1 - tint[k]) * (2 * l - 1) }
            return mix(c, l < 0.5 ? dark : light, s)
        }
    case "colorAdd":
        return { c in [JS.min(1, c[0] + tint[0] * s), JS.min(1, c[1] + tint[1] * s), JS.min(1, c[2] + tint[2] * s), c[3]] }
    case "colorLimit":
        return { c in [c[0] * (1 - s + s * tint[0]), c[1] * (1 - s + s * tint[1]), c[2] * (1 - s + s * tint[2]), c[3]] }
    case "heatMap":
        return { c in heatAt(luma(c) + amount / 100) + [c[3]] }
    default:
        return nil
    }
}

/// A paint with every colour in it (solid, gradient stops, mesh and freeform colours) passed through `f` (`mapVectorPaintColors`).
public func mapVectorPaintColors(_ paint: JSONValue?, _ f: ([Double]) -> [Double]) -> JSONValue? {
    func one(_ color: String) -> String { parseVectorColor(color).map { formatRgba(f($0)) } ?? color }
    guard let paint, paint != .null, paint != "none" else { return paint }
    if let s = paint.stringValue { return .string(one(s)) }
    guard var out = paint.objectValue else { return paint }
    if let stops = out["stops"]?.arrayValue {
        out["stops"] = .array(stops.map { s in
            guard var o = s.objectValue else { return s }
            o["color"] = .string(one(o["color"]?.stringValue ?? "undefined"))
            return .object(o)
        })
    }
    if let colors = out["colors"]?.arrayValue { out["colors"] = .array(colors.map { c in c.stringValue.map { .string(one($0)) } ?? c }) }
    if let points = out["points"]?.arrayValue {
        out["points"] = .array(points.map { q in
            guard var o = q.objectValue, let c = o["color"]?.stringValue else { return q }
            o["color"] = .string(one(c))
            return .object(o)
        })
    }
    return .object(out)
}

// MARK: - Drawing

/// Members a lens content shape drops (`STYLE_OFF` and the source's own state).
private let SHAPE_PATH_DROPPED = ["id", "subpaths", "booleanOperation", "blendStep", "locked", "visible", "effects", "transform", "opacity", "blendMode", "filters", "lens", "lensView", "connector"]

/// A shape as a plain path node in its source's style (`shapePath`); `extra` members (nil removes) last.
private func shapePath(_ shape: VectorAppearanceShape, _ id: String, _ path: BezierPath, _ extra: [(String, JSONValue?)] = []) -> VectorNode {
    var props = JSONObject()
    for k in shape.source.keys where !SHAPE_PATH_DROPPED.contains(k) { props[k] = shape.source[k] }
    props["id"] = .string(id)
    props["type"] = "path"
    var node = VectorNode(props: props, subpaths: bezierToSubpaths(.commands(path)))
    if shape.opacity < 1 { node.opacity = shape.opacity }
    for (k, v) in extra { node[k] = v }
    return node
}

/// The backdrop of a lens (`lensView`) as nodes.
private func lensViewNodes(_ node: VectorNode) throws -> [VectorNode] {
    try (node["lensView"]?.arrayValue ?? []).map { try VectorNode(json: $0) }
}

/// What a lens draws, in its own space (`vectorLensDrawn`): a clip group with the lens outline as
/// the mask and the changed backdrop as contents, then the lens's own fill and stroke.
public func vectorLensDrawn(_ node: VectorNode) throws -> VectorNode {
    guard let lens = node["lens"]?.objectValue, let type = lens["type"]?.stringValue else { return node }
    let amount = lens["amount"]?.numberValue ?? .nan
    let own = subpathsToBezier(node.subpaths)
    var children: [VectorNode] = []
    if let box = bezierPathBounds(.commands(own)), type != "transparency" {
        let c = Vec2((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2)
        let inv: VectorMatrix? = node.transform.flatMap { truthy(node["transform"]) && !isIdentityMatrix($0) ? invertMatrix($0) : nil }
        // What can show through: magnify reaches only the middle 1/k of the lens.
        let k = type == "magnify" ? JS.max(1, amount) : 1
        let reach = (minX: c.x - (c.x - box.minX) / k, maxX: c.x + (box.maxX - c.x) / k, minY: c.y - (c.y - box.minY) / k, maxY: c.y + (box.maxY - c.y) / k)
        var map: ((BezierPath) -> BezierPath)?
        if type == "magnify" {
            let m = VectorMatrix(k, 0, 0, k, c.x * (1 - k), c.y * (1 - k))
            map = { transformBezierPath(.commands($0), m.tuple) }
        } else if type == "fisheye" {
            let a = JS.min(100, JS.max(-100, amount))
            let gamma = a >= 0 ? 1 / (1 + a / 25) : 1 - a / 25
            let rx = JS.max(1e-9, (box.maxX - box.minX) / 2)
            let ry = JS.max(1e-9, (box.maxY - box.minY) / 2)
            let warp: (Vec2) -> Vec2 = { p in
                let dx = (p.x - c.x) / rx
                let dy = (p.y - c.y) / ry
                let u = JS.hypot(dx, dy)
                if u >= 1 || u < 1e-12 { return p }
                let f = pow(u, gamma) / u
                return Vec2(c.x + dx * f * rx, c.y + dy * f * ry)
            }
            map = { mapBezierPath($0, warp, 0.25) }
        }
        let recolour = vectorLensColorMap(lens)
        let wire: String? = type == "wireframe" ? (lens["color"]?.stringValue ?? "#000000") : nil
        var contents: [VectorNode] = []
        for (i, below) in try lensViewNodes(node).enumerated() {
            for shape in try vectorChildAppearanceShapes(below, i) {
                let path = inv.map { transformBezierPath(.commands(shape.path), $0.tuple) } ?? shape.path
                guard let b = bezierPathBounds(.commands(path)), !(b.maxX < reach.minX || b.minX > reach.maxX || b.maxY < reach.minY || b.minY > reach.maxY) else { continue }
                let id = "\(node.id)~lens\(contents.count)"
                let changed = map?(path) ?? path
                if let wire {
                    contents.append(shapePath(shape, id, changed, [
                        ("fill", .null), ("fills", nil), ("stroke", .string(wire)), ("strokes", nil), ("strokeWidth", 1), ("strokeAlign", nil),
                        ("strokeDasharray", nil), ("strokeWidthProfile", nil), ("opacity", .number(JS.min(1, JS.max(0, amount / 100)))),
                    ]))
                } else if let recolour {
                    func layers(_ v: JSONValue?) -> JSONValue? {
                        v?.arrayValue.map { list in .array(list.map { l in
                            guard var o = l.objectValue else { return l }
                            o["paint"] = mapVectorPaintColors(o["paint"], recolour) ?? .null
                            return .object(o)
                        }) }
                    }
                    var extra: [(String, JSONValue?)] = [("fill", mapVectorPaintColors(shape.source.fill, recolour) ?? .null), ("stroke", mapVectorPaintColors(shape.source.stroke, recolour) ?? .null)]
                    if let fills = layers(shape.source["fills"]) { extra.append(("fills", fills)) }
                    if let strokes = layers(shape.source["strokes"]) { extra.append(("strokes", strokes)) }
                    contents.append(shapePath(shape, id, changed, extra))
                } else {
                    contents.append(shapePath(shape, id, changed))
                }
            }
        }
        if !contents.isEmpty {
            var outline = JSONObject([("id", .string("\(node.id)~lens-clip")), ("type", "path"), ("subpaths", .null), ("fill", "#000000"), ("stroke", .null)])
            if let rule = node["fillRule"], truthy(rule) { outline["fillRule"] = rule }
            let clip = VectorNode(props: outline, subpaths: node.subpaths)
            children.append(VectorNode(props: JSONObject([("id", .string("\(node.id)~lens-view")), ("type", "group"), ("mask", ["type": "clip"])]), children: [clip] + contents))
        }
    }
    // The lens's own fill: see-through for a transparency lens, otherwise there to be hit only.
    var style = node
    for k in ["lens", "lensView", "transform", "opacity", "effects", "blendMode", "filters"] { style[k] = Optional<JSONValue>.none }
    let fillOpacity = type == "transparency" ? 1 - JS.min(100, JS.max(0, amount)) / 100 : 0
    var fill = style
    fill.id = "\(node.id)~lens-fill"
    fill["stroke"] = .null
    fill["strokes"] = Optional<JSONValue>.none
    fill.opacity = fillOpacity
    children.append(fill)
    let stroked = (arrayLength(node["strokes"]) ?? 0) > 0 || hasStrokePaint(node.stroke)
    if stroked {
        var stroke = style
        stroke.id = "\(node.id)~lens-stroke"
        stroke["fill"] = .null
        stroke["fills"] = Optional<JSONValue>.none
        children.append(stroke)
    }
    var props = JSONObject([("id", .string(node.id)), ("type", "group")])
    if let name = node["name"] { props["name"] = name }
    if truthy(node["transform"]) { props["transform"] = node["transform"] }
    if let o = node["opacity"] { props["opacity"] = o }
    if truthy(node["blendMode"]) { props["blendMode"] = node["blendMode"] }
    if let n = arrayLength(node["filters"]), n > 0 { props["filters"] = node["filters"] }
    return VectorNode(props: props, children: children)
}

/// `node.stroke != null && node.stroke !== 'none'`.
private func hasStrokePaint(_ paint: JSONValue?) -> Bool {
    guard let paint, paint != .null else { return false }
    return paint != "none"
}

// MARK: - Backdrops

/// Whether any node in the tree is a lens.
func hasVectorLens(_ nodes: [VectorNode]) -> Bool {
    nodes.contains { isVectorLens($0) || ($0.isGroup && hasVectorLens($0.children)) }
}

/// The document with every lens's `lensView` up to date (`resolveVectorLenses`): what is drawn
/// before it, in its parent's space (outer levels wrapped in a group with the inverse of the
/// parents' transforms). The document is returned unchanged when no backdrop changed. Backdrops
/// compare by value: the TS keeps node objects and compares them by identity.
public func resolveVectorLenses(_ doc: VectorDocument) -> VectorDocument {
    if !hasVectorLens(doc.nodes) { return doc }
    var changed = false
    func walk(_ list: [VectorNode], _ outer: [VectorNode], _ depth: Int) -> [VectorNode] {
        var below = outer
        var out: [VectorNode] = []
        for n in list {
            var next = n
            if isVectorLens(n) {
                let view = JSONValue.array(below.map { $0.toJSON() })
                if n["lensView"] != view { next["lensView"] = view }
            } else if n.isGroup && hasVectorLens(n.children) {
                // Inside the group, what is below is seen through the inverse of its transform.
                let m: VectorMatrix? = n.transform.flatMap { truthy(n["transform"]) && !isIdentityMatrix($0) ? invertMatrix($0) : nil }
                let inner: [VectorNode] = below.isEmpty ? [] : (m.map { [VectorNode(props: JSONObject([("id", .string("\(n.id):\(depth)~below")), ("type", "group"), ("transform", $0.json)]), children: below)] } ?? below)
                let children = walk(n.children, inner, depth + 1)
                if children != n.children { next.children = children }
            }
            if next != n { changed = true }
            below.append(next)
            out.append(next)
        }
        return out
    }
    let nodes = walk(doc.nodes, [], 0)
    if !changed { return doc }
    var out = doc
    out.nodes = nodes
    return out
}

/// The document without lens backdrops (what is saved; `stripVectorLensViews`).
public func stripVectorLensViews(_ doc: VectorDocument) -> VectorDocument {
    if !hasVectorLens(doc.nodes) { return doc }
    func strip(_ list: [VectorNode]) -> [VectorNode] {
        list.map { n in
            var c = n
            if n.isPath && n.has("lensView") { c["lensView"] = Optional<JSONValue>.none }
            if n.isGroup { c.children = strip(n.children) }
            return c
        }
    }
    var out = doc
    out.nodes = strip(doc.nodes)
    return out
}
