import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// SVG export and import (`vectorDocumentToSvg` and `parseVectorSvg` in `vector/svg.ts`).
//
// Export writes plain paths and groups with colour and gradient paints (linear and radial, see
// `Gradient.swift`), paint stacks, live corners, live booleans (drawn shapes plus the hidden
// source), transforms, opacity, visibility, blend modes and filters.
// Stroke parts (inside / outside alignment, arrowheads, width profiles), masks,
// frames, text, instances, symbols, blends, shading, connectors, generated art,
// lenses and brushstrokes throw `VectorNotPorted` (#624).

private func escapeAttr(_ value: String) -> String {
    value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
}

/// `data-vector-corners`: the live corners of subpaths as `subpath.index:radius[:kind]`.
func vectorCornersAttribute(_ subpaths: [VectorSubpath], _ precision: Int = 3) -> String {
    var out: [String] = []
    for (s, sp) in subpaths.enumerated() {
        for (i, a) in sp.anchors.enumerated() {
            guard let c = a.corner, let r = c.radius, r > 0 else { continue }
            let kind = c.kindName.flatMap { $0.isEmpty || $0 == "round" ? nil : ":\($0)" } ?? ""
            out.append("\(s).\(i):\(formatNumber(r, precision))\(kind)")
        }
    }
    return out.joined(separator: " ")
}

/// Whether the stroke needs more than one element (`hasStrokeExtras`).
func hasStrokeExtras(_ node: VectorNode) -> Bool {
    let align = node["strokeAlign"]?.stringValue ?? "center"
    return align != "center" || truthy(node["startArrow"]) || truthy(node["endArrow"]) || (node["strokeWidthProfile"]?.arrayValue?.isEmpty == false)
}

/// A paint server's markup (`paintDefMarkup`): the first def of a gradient carries
/// `data-vector-gradient` (the gradient as JSON) so import restores what SVG cannot say.
private func paintDefMarkup(_ def: VectorPaintDef, _ gradient: JSONValue?) -> String {
    let tag = def.type == "radial" ? "radialGradient" : "linearGradient"
    let attrs = def.attrs.map { k, v in " \(k)=\"\(escapeAttr(v.stringValue ?? v.numberValue.map(JSONValue.jsNumber) ?? v.stringified()))\"" }.joined()
    let extra = gradient.map { " data-vector-gradient=\"\(escapeAttr($0.stringified()))\"" } ?? ""
    let stops = def.stops.map { s in
        "<stop offset=\"\(s.offset)\" stop-color=\"\(escapeAttr(s.stopColor))\"\(s.stopOpacity.map { " stop-opacity=\"\(JSONValue.jsNumber($0))\"" } ?? "")/>"
    }.joined()
    return "<\(tag) id=\"\(escapeAttr(def.id))\"\(attrs)\(extra)>\(stops)</\(tag)>"
}

/// Markup of a paint's defs, the gradient's data attribute on the first (`paintMarkup`).
private func paintMarkup(_ paint: JSONValue?, _ defs: [VectorPaintDef]) -> [String] {
    defs.enumerated().map { i, d in paintDefMarkup(d, i == 0 && isVectorGradient(paint) ? paint : nil) }
}

/// Members a live path's hidden source leaves out (they stay on the live group).
private let LIVE_SOURCE_DROPPED = ["effects", "transform", "opacity", "visible", "booleanOperation", "blendStep", "blendMode", "filters", "lens", "lensView"]

/// The document as SVG markup (`vectorDocumentToSvg`), `precision` decimals (default 3).
/// `idPrefix` prefixes paint server ids (default `vg-`).
public func vectorDocumentToSvg(_ doc: VectorDocument, precision: Int? = nil, pretty: Bool = true, includeHidden: Bool = false, background: Bool = true, idPrefix: String = "vg-") throws -> String {
    let precision = precision ?? 3
    let prefix = idPrefix
    var defs: [String] = []
    var lines: [String] = []
    func num(_ n: Double) -> String { formatNumber(n, precision) }
    func indent(_ depth: Int) -> String { pretty ? String(repeating: "  ", count: depth) : "" }

    func common(_ node: VectorNode) throws -> String {
        var out = " id=\"\(escapeAttr(node.id))\""
        if let t = node.transform, truthy(node["transform"]) { out += " transform=\"matrix(\([t.a, t.b, t.c, t.d, t.e, t.f].map { formatNumber($0, 6) }.joined(separator: " ")))\"" }
        if let o = node.opacity, o < 1 { out += " opacity=\"\(num(o))\"" }
        if !node.isVisible { out += " display=\"none\"" }
        if truthy(node["blendStep"]) { out += " data-vector-blend-step=\"\"" }
        if let op = node["booleanOperation"]?.stringValue, !op.isEmpty { out += " data-vector-boolean-operation=\"\(op)\"" }
        if truthy(node["resizing"]) { out += " data-vector-resizing=\"\(escapeAttr(node["resizing"]!.stringified()))\"" }
        // not ported yet: blends, shading, connectors, generated art, lenses (#624)
        for key in ["blend", "connector", "generation", "lens"] where truthy(node[key]) { throw VectorNotPorted("exporting \(key) to SVG") }
        if node.isPath && isVectorShadedPaint(node.fill) { throw VectorNotPorted("exporting shaded paints to SVG") }
        if let blend = vectorBlendModeCss(node["blendMode"]) { out += " style=\"mix-blend-mode:\(blend)\"" }
        if let filters = node["filters"], let n = arrayLength(filters), n > 0 {
            let data = " data-vector-filters=\"\(escapeAttr(filters.stringified()))\""
            if let filter = try vectorNodeFilterSvg(node, "\(prefix)filter-\(node.id)") {
                defs.append(vectorFilterMarkup(filter, data))
                out += " filter=\"url(#\(escapeAttr(filter.id)))\""
            } else {
                out += data
            }
        }
        return out
    }

    /// Opacity and blend mode of one paint layer, as attributes.
    func layerAttrs(_ layer: JSONObject) -> String {
        var out = ""
        if let o = layer["opacity"]?.numberValue, o < 1 { out += " opacity=\"\(num(o))\"" }
        if let blend = vectorBlendModeCss(layer["blendMode"]) { out += " style=\"mix-blend-mode:\(blend)\"" }
        return out
    }

    func lineAttrs(_ node: VectorNode, _ stroke: String, _ width: Double) -> String {
        var out = " stroke=\"\(escapeAttr(stroke))\" stroke-width=\"\(num(width))\""
        if let cap = node["strokeLinecap"]?.stringValue, !cap.isEmpty, cap != "butt" { out += " stroke-linecap=\"\(cap)\"" }
        if let join = node["strokeLinejoin"]?.stringValue, !join.isEmpty, join != "miter" { out += " stroke-linejoin=\"\(join)\"" }
        if let dash = node["strokeDasharray"]?.arrayValue, !dash.isEmpty { out += " stroke-dasharray=\"\(dash.map { num($0.numberValue ?? .nan) }.joined(separator: " "))\"" }
        return out
    }

    /// `data-vector-d` / `data-vector-corners` of a path with live corners ("" without).
    func liveCorners(_ node: VectorNode) -> String {
        let corners = vectorCornersAttribute(node.subpaths, precision)
        return corners.isEmpty ? "" : " data-vector-d=\"\(bezierPathToSvg(.commands(subpathsToBezier(node.subpaths, corners: false)), BezierPathToSvgOptions(precision: precision)))\" data-vector-corners=\"\(corners)\""
    }

    func checkStroke(_ node: VectorNode, _ stroke: String) throws {
        // not ported yet: stroke parts (vectorStrokeSvgParts, strokePartLines) (#624)
        if stroke != "none" && hasStrokeExtras(node) { throw VectorNotPorted("exporting aligned, arrowed or profiled strokes to SVG") }
    }

    /// A path painted through its stacks: a `<g data-vector-path>` carrying the stacks (JSON),
    /// holding each drawn layer bottom to top (`emitStacked`).
    func emitStacked(_ node: VectorNode, _ depth: Int) throws {
        let d = vectorPathData(node, precision: precision)
        let rule = node.fillRule == "evenodd" ? " fill-rule=\"evenodd\"" : ""
        let stack = { (list: [JSONObject]) in escapeAttr(JSONValue.array(list.map { .object($0) }).stringified()) }
        var data = " data-vector-path=\"\" data-vector-fills=\"\(stack(vectorFills(node)))\" data-vector-strokes=\"\(stack(vectorStrokes(node)))\""
        if node.fillRule == "evenodd" { data += " data-vector-fill-rule=\"evenodd\"" }
        lines.append("\(indent(depth))<g\(try common(node))\(data)>")
        let layers = try vectorPaintLayerNodes(node).filter { l in
            if l.kind == "stroke", l.layer["kind"] == "brushstroke", l.layer["visible"] != .bool(false) {
                // not ported yet: brushstroke images (vectorBrushstrokeImages) (#624)
                throw VectorNotPorted("exporting brushstrokes to SVG")
            }
            return l.drawn
        }
        var geometry = liveCorners(node)
        if !layers.contains(where: { $0.kind == "fill" }) {
            lines.append("\(indent(depth + 1))<path data-vector-part=\"fill\" d=\"\(d)\" fill=\"none\"\(rule)\(geometry)/>")
            geometry = ""
        }
        for l in layers {
            let paint = try vectorPaintToSvg(l.layer["paint"], "\(prefix)\(l.kind)-\(node.id)-\(l.index)", node: l.node, role: l.kind)
            defs += paintMarkup(l.layer["paint"], paint.defs)
            let attrs = " data-vector-layer=\"\(l.index)\"\(layerAttrs(l.layer))"
            if l.kind == "fill" {
                lines.append("\(indent(depth + 1))<path data-vector-part=\"fill\"\(attrs) d=\"\(d)\" fill=\"\(escapeAttr(paint.value))\"\(rule)\(geometry)/>")
                geometry = ""
                continue
            }
            try checkStroke(l.node, paint.value)
            lines.append("\(indent(depth + 1))<path data-vector-part=\"stroke\"\(attrs) d=\"\(d)\" fill=\"none\"\(lineAttrs(l.node, paint.value, l.node.strokeWidth ?? 1))/>")
        }
        lines.append("\(indent(depth))</g>")
    }

    func emit(_ node: VectorNode, _ depth: Int) throws {
        if !node.isVisible && !includeHidden { return }
        try emitNode(node, depth)
    }

    func emitNode(_ node: VectorNode, _ depth: Int) throws {
        // not ported yet: frames, masks, instances, text and lenses (#624)
        if isVectorFrame(node) || isVectorMaskGroup(node) || node.isInstance || node.isText || isVectorLens(node) {
            throw VectorNotPorted("exporting \(node.typeName) nodes with frames, masks or lenses to SVG")
        }
        if hasOwnVectorAppearance(node) {
            // Live: what it draws, then the editable source (hidden) for import.
            var live = JSONObject([("kind", .string(node.typeName))])
            if let e = node["effects"], arrayLength(e).map({ $0 > 0 }) == true { live["effects"] = e }
            if node.isGroup, truthy(node["liveBoolean"]) { live["liveBoolean"] = node["liveBoolean"]! }
            if node.isGroup, truthy(node["symmetry"]) { live["symmetry"] = node["symmetry"]! }
            lines.append("\(indent(depth))<g\(try common(node)) data-vector-live=\"\(escapeAttr(JSONValue.object(live).stringified()))\">")
            lines.append("\(indent(depth + 1))<g data-vector-part=\"appearance\">")
            for shape in try vectorAppearanceNodes(node) { try emit(shape, depth + 2) }
            lines.append("\(indent(depth + 1))</g>")
            lines.append("\(indent(depth + 1))<g data-vector-part=\"source\" display=\"none\">")
            if node.isPath {
                var source = node
                for key in LIVE_SOURCE_DROPPED { source[key] = Optional<JSONValue>.none }
                source.id = "\(node.id)~src"
                try emit(source, depth + 2)
            } else {
                for child in node.children { try emit(child, depth + 2) }
            }
            lines.append("\(indent(depth + 1))</g>")
            lines.append("\(indent(depth))</g>")
            return
        }
        if node.isGroup {
            lines.append("\(indent(depth))<g\(try common(node))>")
            for child in node.children { try emit(child, depth + 1) }
            lines.append("\(indent(depth))</g>")
            return
        }
        if needsVectorPaintLayers(node) {
            try emitStacked(node, depth)
            return
        }
        let fill = try vectorPaintToSvg(node.fill, "\(prefix)fill-\(node.id)", node: node)
        let stroke = try vectorPaintToSvg(node.stroke, "\(prefix)stroke-\(node.id)", node: node, role: "stroke")
        defs += paintMarkup(node.fill, fill.defs) + paintMarkup(node.stroke, stroke.defs)
        try checkStroke(node, stroke.value)
        let d = vectorPathData(node, precision: precision)
        let fillAttrs = " fill=\"\(escapeAttr(fill.value))\"\(node.fillRule == "evenodd" ? " fill-rule=\"evenodd\"" : "")"
        lines.append("\(indent(depth))<path\(try common(node)) d=\"\(d)\"\(fillAttrs)\(stroke.value != "none" ? lineAttrs(node, stroke.value, node.strokeWidth ?? 1) : "")\(liveCorners(node))/>")
    }

    for node in doc.nodes { try emit(node, 1) }
    // not ported yet: symbols (#624)
    if let symbols = doc.symbols, !symbols.isEmpty { throw VectorNotPorted("exporting symbols to SVG") }
    let w = num(doc.width)
    let h = num(doc.height)
    var out = ["<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"\(w)\" height=\"\(h)\" viewBox=\"0 0 \(w) \(h)\">"]
    if !defs.isEmpty { out.append("\(indent(1))<defs>\(defs.joined())</defs>") }
    if let bg = doc.background, background, hasPaint(.string(bg)) { out.append("\(indent(1))<rect width=\"\(w)\" height=\"\(h)\" fill=\"\(escapeAttr(bg))\"/>") }
    out += lines
    out.append("</svg>")
    return out.joined(separator: pretty ? "\n" : "")
}

extension VectorEditorController {
    /// The document as SVG markup (`toSvg`).
    public func toSvg(precision: Int? = nil) throws -> String { try vectorDocumentToSvg(doc, precision: precision) }
}
