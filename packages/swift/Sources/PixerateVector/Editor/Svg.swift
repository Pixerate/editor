import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// SVG export (`vectorDocumentToSvg` in `vector/svg.ts`) for documents of plain paths and groups:
// colour paints, live corners, transforms, opacity and visibility. Gradients, paint stacks, stroke
// parts (alignment, arrowheads, width profiles), filters, blend modes, masks, frames, text,
// instances and live appearances throw `VectorNotPorted` (#624).

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

/// The CSS name of a blend mode, or nil for normal (`vectorBlendModeCss`).
private func blendModeCss(_ mode: JSONValue?) -> String? {
    guard let m = mode?.stringValue, !m.isEmpty, m != "normal" else { return nil }
    return m == "linear-dodge" ? "plus-lighter" : m
}

/// The document as SVG markup (`vectorDocumentToSvg`), `precision` decimals (default 3).
public func vectorDocumentToSvg(_ doc: VectorDocument, precision: Int? = nil, pretty: Bool = true, includeHidden: Bool = false) throws -> String {
    let precision = precision ?? 3
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
        // not ported yet: blends, shading, connectors, generated art, lenses, filters (#624)
        for key in ["blend", "connector", "generation", "lens"] where truthy(node[key]) { throw VectorNotPorted("exporting \(key) to SVG") }
        if isVectorShadedPaint(node.fill) { throw VectorNotPorted("exporting shaded paints to SVG") }
        if let blend = blendModeCss(node["blendMode"]) { out += " style=\"mix-blend-mode:\(blend)\"" }
        if let n = arrayLength(node["filters"]), n > 0 { throw VectorNotPorted("exporting filters to SVG") }
        return out
    }

    func paintValue(_ paint: JSONValue?) throws -> String {
        if !hasPaint(paint) { return "none" }
        if let s = paint?.stringValue { return s }
        // not ported yet: gradients (vectorGradientSvgDefs) (#624)
        if isVectorGradient(paint) || isVectorShadedPaint(paint) { throw VectorNotPorted("exporting gradients to SVG") }
        return "none"
    }

    func lineAttrs(_ node: VectorNode, _ stroke: String, _ width: Double) -> String {
        var out = " stroke=\"\(escapeAttr(stroke))\" stroke-width=\"\(num(width))\""
        if let cap = node["strokeLinecap"]?.stringValue, !cap.isEmpty, cap != "butt" { out += " stroke-linecap=\"\(cap)\"" }
        if let join = node["strokeLinejoin"]?.stringValue, !join.isEmpty, join != "miter" { out += " stroke-linejoin=\"\(join)\"" }
        if let dash = node["strokeDasharray"]?.arrayValue, !dash.isEmpty { out += " stroke-dasharray=\"\(dash.map { num($0.numberValue ?? .nan) }.joined(separator: " "))\"" }
        return out
    }

    func emit(_ node: VectorNode, _ depth: Int) throws {
        if !node.isVisible && !includeHidden { return }
        try emitNode(node, depth)
    }

    func emitNode(_ node: VectorNode, _ depth: Int) throws {
        // not ported yet: frames, masks, instances, text and live appearances (#624)
        if isVectorFrame(node) || isVectorMaskGroup(node) || node.isInstance || node.isText || hasOwnVectorAppearance(node) {
            throw VectorNotPorted("exporting \(node.typeName) nodes with a live appearance to SVG")
        }
        if node.isGroup {
            lines.append("\(indent(depth))<g\(try common(node))>")
            for child in node.children { try emit(child, depth + 1) }
            lines.append("\(indent(depth))</g>")
            return
        }
        // not ported yet: paint stacks and stroke parts (#624)
        if node["fills"]?.arrayValue != nil || node["strokes"]?.arrayValue != nil { throw VectorNotPorted("exporting paint stacks to SVG") }
        let fill = try paintValue(node.fill)
        let stroke = try paintValue(node.stroke)
        if stroke != "none" && hasStrokeExtras(node) { throw VectorNotPorted("exporting aligned, arrowed or profiled strokes to SVG") }
        let d = vectorPathData(node, precision: precision)
        let corners = vectorCornersAttribute(node.subpaths, precision)
        let live = corners.isEmpty ? "" : " data-vector-d=\"\(bezierPathToSvg(.commands(subpathsToBezier(node.subpaths, corners: false)), BezierPathToSvgOptions(precision: precision)))\" data-vector-corners=\"\(corners)\""
        let fillAttrs = " fill=\"\(escapeAttr(fill))\"\(node.fillRule == "evenodd" ? " fill-rule=\"evenodd\"" : "")"
        lines.append("\(indent(depth))<path\(try common(node)) d=\"\(d)\"\(fillAttrs)\(stroke != "none" ? lineAttrs(node, stroke, node.strokeWidth ?? 1) : "")\(live)/>")
    }

    for node in doc.nodes { try emit(node, 1) }
    // not ported yet: symbols (#624)
    if let symbols = doc.symbols, !symbols.isEmpty { throw VectorNotPorted("exporting symbols to SVG") }
    let w = num(doc.width)
    let h = num(doc.height)
    var out = ["<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"\(w)\" height=\"\(h)\" viewBox=\"0 0 \(w) \(h)\">"]
    if let bg = doc.background, hasPaint(.string(bg)) { out.append("\(indent(1))<rect width=\"\(w)\" height=\"\(h)\" fill=\"\(escapeAttr(bg))\"/>") }
    out += lines
    out.append("</svg>")
    return out.joined(separator: pretty ? "\n" : "")
}

extension VectorEditorController {
    /// The document as SVG markup (`toSvg`).
    public func toSvg(precision: Int? = nil) throws -> String { try vectorDocumentToSvg(doc, precision: precision) }
}
