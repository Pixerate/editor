import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// The scene render data of a vector editor (`getVectorSceneRenderData` in `vector/render.ts`): the
// document-space paths, groups and paint servers React and Svelte draw as SVG, as JSON with the TS
// field names. Ported for what the controller holds now: paths and groups, transforms, opacity,
// blend modes, colour, gradient, mesh and freeform paints (see `Gradient.swift`, `Shading.swift`), paint stacks, live booleans and instances (as their drawn art).
// Frames draw as clip groups (their clip as render data), text as SVG text spans placed character by
// character (or, with an outline shaper, as its outlines). Inverted clips and opacity masks
// that are on, stroke parts (inside / outside
// alignment, arrowheads, width profiles), brushstroke layers, lenses and the viewport culling
// options (`viewportSize`, `lod`) throw `VectorNotPorted` (#624). The overlay and the panels'
// data are not ported: no scenario compares them.

/// The view onto the document (`VectorViewport`): screen = document × zoom + (x, y).
public struct VectorViewport: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var zoom: Double

    public init(x: Double = 0, y: Double = 0, zoom: Double = 1) {
        self.x = x
        self.y = y
        self.zoom = zoom
    }
}

/// `Math.round(n * 100) / 100` as a JS string.
private func fmt(_ n: Double) -> String {
    let v = JS.round(n * 100) / 100
    return v == 0 ? "0" : JSONValue.jsNumber(v)
}

/// `matrix(a b c d e f)`, each rounded to 6 decimals (`fmtMatrix` of `render.ts`).
private func fmtMatrix(_ m: VectorMatrix) -> String {
    let parts = [m.a, m.b, m.c, m.d, m.e, m.f].map { n -> String in
        let v = JS.round(n * 1e6) / 1e6
        return v == 0 ? "0" : JSONValue.jsNumber(v)
    }
    return "matrix(\(parts.joined(separator: " ")))"
}

/// Whether a path's stroke needs more than one element (`vectorStrokeSvgParts` returns parts).
private func checkStrokeParts(_ node: VectorNode) throws {
    // not ported yet: stroke parts (vectorStrokeParts: alignment, arrowheads, width profiles) (#624)
    if hasPaint(node.stroke) && hasStrokeExtras(node) { throw VectorNotPorted("drawing aligned, arrowed or profiled strokes") }
}

/// Renders nodes into render data, collecting paint servers and filters as the TS does.
private struct SceneRenderer {
    var defs: [VectorPaintDef] = []
    var filters: [VectorRenderFilter] = []
    let prefix: String

    /// The blend mode and filter of a node (`nodeFinish`); its filter goes to `filters`.
    mutating func finish(_ node: VectorNode, into o: inout JSONObject) throws {
        if let blend = vectorBlendModeCss(node["blendMode"]) { o["blendMode"] = .string(blend) }
        if let filter = try vectorNodeFilterSvg(node, "\(prefix)filter-\(node.id)") {
            filters.append(filter)
            o["filter"] = .string("url(#\(filter.id))")
        }
    }

    /// The SVG line attributes of a (layer) node's stroke (`lineStyle`).
    func lineStyle(_ node: VectorNode, into o: inout JSONObject) {
        o["strokeWidth"] = .number(node.strokeWidth ?? 1)
        if let cap = node["strokeLinecap"]?.stringValue, !cap.isEmpty { o["strokeLinecap"] = .string(cap) }
        if let join = node["strokeLinejoin"]?.stringValue, !join.isEmpty { o["strokeLinejoin"] = .string(join) }
        if let dash = node["strokeDasharray"]?.arrayValue, !dash.isEmpty {
            o["strokeDasharray"] = .string(dash.map { $0.numberValue.map(JSONValue.jsNumber) ?? $0.stringValue ?? "" }.joined(separator: " "))
        }
    }

    /// The drawn layers of a path's stacks (`renderLayers`).
    mutating func layers(_ node: VectorNode) throws -> [JSONObject] {
        var out: [JSONObject] = []
        for l in vectorPaintLayerNodes(node) {
            if l.kind == "stroke", l.layer["kind"] == "brushstroke", l.layer["visible"] != .bool(false), (l.layer["opacity"]?.numberValue ?? 1) > 0 {
                // not ported yet: brushstroke images (vectorBrushstrokeImages) (#624)
                throw VectorNotPorted("drawing brushstrokes")
            }
            if !l.drawn { continue }
            let paint = vectorPaintToSvg(l.layer["paint"], "\(prefix)\(l.kind)-\(node.id)-\(l.index)", node: l.node, role: l.kind)
            defs += paint.defs
            var o = JSONObject([("kind", .string(l.kind)), ("index", .number(Double(l.index))), ("opacity", .number(l.layer["opacity"]?.numberValue ?? 1))])
            if let blend = vectorBlendModeCss(l.layer["blendMode"]) { o["blendMode"] = .string(blend) }
            if l.kind == "fill" {
                o["fill"] = .string(paint.value)
                o["stroke"] = "none"
                o["strokeWidth"] = 0
            } else {
                try checkStrokeParts(l.node)
                o["fill"] = "none"
                o["stroke"] = .string(paint.value)
                lineStyle(l.node, into: &o)
            }
            out.append(o)
        }
        return out
    }

    /// A text node drawn as SVG text (no glyph outlines here; `renderText`).
    mutating func text(_ node: VectorNode) throws -> JSONObject {
        let geometry = vectorTextGeometryNode(node)
        var layers: [JSONObject] = []
        let nodes = vectorPaintLayerNodes(geometry)
        let topFill = nodes.lastIndex { $0.kind == "fill" && $0.drawn }
        for (i, l) in nodes.enumerated() where l.drawn {
            let paint = vectorPaintToSvg(l.layer["paint"], "\(prefix)\(l.kind)-\(node.id)-\(l.index)", node: l.node, role: l.kind)
            defs += paint.defs
            var o = JSONObject([("kind", .string(l.kind)), ("opacity", .number(l.layer["opacity"]?.numberValue ?? 1))])
            if let blend = vectorBlendModeCss(l.layer["blendMode"]) { o["blendMode"] = .string(blend) }
            if l.kind == "fill" {
                o["fill"] = .string(paint.value)
                o["stroke"] = "none"
                o["strokeWidth"] = 0
                if i == topFill { o["runFills"] = true }
            } else {
                o["fill"] = "none"
                o["stroke"] = .string(paint.value)
                o["strokeWidth"] = .number(l.node.strokeWidth ?? 1)
                if let join = l.node["strokeLinejoin"]?.stringValue, !join.isEmpty { o["strokeLinejoin"] = .string(join) }
                if let dash = l.node["strokeDasharray"]?.arrayValue, !dash.isEmpty {
                    o["strokeDasharray"] = .string(dash.map { $0.numberValue.map(jsString) ?? $0.stringValue ?? "" }.joined(separator: " "))
                }
            }
            layers.append(o)
        }
        // Runs with their own fill paint the top fill (or are the only fill when the node has none).
        let spans = vectorTextSpans(node).enumerated().map { i, sp -> JSONObject in
            var fill: String?
            if let f = sp.fill {
                let paint = vectorPaintToSvg(f, "\(prefix)run-\(node.id)-\(i)", node: geometry)
                defs += paint.defs
                fill = paint.value
            }
            return vectorTextSpanSvg(sp, fill)
        }
        if topFill == nil && spans.contains(where: { truthy($0["fill"]) }) {
            layers.insert(JSONObject([("kind", "fill"), ("fill", "none"), ("stroke", "none"), ("strokeWidth", 0), ("opacity", 1), ("runFills", true)]), at: 0)
        }
        var o = JSONObject([("kind", "text"), ("id", .string(node.id))])
        if truthy(node["transform"]), let t = node.transform { o["transform"] = .string(fmtMatrix(t)) }
        o["opacity"] = .number(node.opacity ?? 1)
        try finish(node, into: &o)
        o["layers"] = .array(layers.map { .object($0) })
        o["spans"] = .array(spans.map { .object($0) })
        return o
    }

    /// One node as render data, or nil when hidden (`renderNodeFresh`).
    mutating func node(_ stored: VectorNode) throws -> JSONValue? {
        if !stored.isVisible { return nil }
        // Text without glyph outlines draws as SVG text; with them it draws as its outlines below.
        if stored.isText && !vectorTextHasOutlines() { return .object(try text(stored)) }
        let node = try expandVectorAppearance(stored)
        var o = JSONObject([("id", .string(node.id))])
        if truthy(node["transform"]), let t = node.transform { o["transform"] = .string(fmtMatrix(t)) }
        o["opacity"] = .number(node.opacity ?? 1)
        if node.isGroup {
            o["kind"] = "group"
            try finish(node, into: &o)
            var list = node.children
            if isVectorMaskGroup(node) {
                if let mask = try renderMask(node, prefix) { o["mask"] = mask }
                // A mask group without a working mask draws its contents whole.
                list = Array(list.dropFirst())
            }
            o["children"] = .array(try list.compactMap { try self.node($0) })
            return .object(o)
        }
        if !node.isPath { throw VectorNotPorted("drawing \(node.typeName) nodes") }
        o["kind"] = "path"
        o["d"] = .string(vectorPathData(node))
        o["fillRule"] = .string(node.fillRule ?? "nonzero")
        try finish(node, into: &o)
        if needsVectorPaintLayers(node) {
            let layers = try self.layers(node)
            let fill = layers.last { $0["kind"] == "fill" }
            let stroke = layers.last { $0["kind"] == "stroke" }
            o["fill"] = fill?["fill"] ?? "none"
            o["stroke"] = stroke?["stroke"] ?? "none"
            o["strokeWidth"] = stroke?["strokeWidth"] ?? .number(node.strokeWidth ?? 1)
            for key in ["strokeLinecap", "strokeLinejoin", "strokeDasharray"] { if let v = stroke?[key] { o[key] = v } }
            o["layers"] = .array(layers.map { .object($0) })
            return .object(o)
        }
        let fill = vectorPaintToSvg(node.fill, "\(prefix)fill-\(node.id)", node: node)
        let stroke = vectorPaintToSvg(node.stroke, "\(prefix)stroke-\(node.id)", node: node, role: "stroke")
        defs += fill.defs + stroke.defs
        if stroke.value != "none" { try checkStrokeParts(node) }
        o["fill"] = .string(fill.value)
        o["stroke"] = .string(stroke.value)
        lineStyle(node, into: &o)
        return .object(o)
    }
}

/// A mask group's mask as render data (`renderMask` and `vectorMaskRenderData`), or nil while it is
/// off. Ported for clipping masks that are not inverted (what frames draw with); inverted clips and
/// opacity masks throw `VectorNotPorted` (#624).
private func renderMask(_ group: VectorNode, _ idPrefix: String) throws -> JSONValue? {
    if !isVectorMaskActive(group) || group.children.count < 2 { return nil }
    let type = group["mask"]?["type"]?.stringValue ?? "clip"
    let invert = truthy(group["mask"]?["invert"])
    // not ported yet: inverted clips and opacity masks (vectorMaskContentBounds, invertFilter) (#624)
    if type != "clip" || invert { throw VectorNotPorted("drawing \(invert ? "inverted " : "")\(type) masks") }
    let clip: [JSONValue] = try vectorMaskRegion(group).map { s in
        .object(JSONObject([("d", .string(bezierPathToSvg(.commands(s.path), BezierPathToSvgOptions(precision: 3)))), ("clipRule", .string(s.fillRule.rawValue))]))
    }
    return .object(JSONObject([("type", "clip"), ("invert", false), ("id", .string("\(idPrefix)mask-\(group.id)")), ("clip", .array(clip))]))
}

/// Whether nodes hold a lens anywhere.
private func hasLens(_ nodes: [VectorNode]) -> Bool {
    nodes.contains { isVectorLens($0) || ($0.isGroup && hasLens($0.children)) }
}

/**
 * The document layer as render data (`getVectorSceneRenderData` with no `viewportSize`): render
 * the nodes inside `<g transform={transform}>` and `defs` in a `<defs>` block. `idPrefix` prefixes
 * the ids of defs and filters (default `ve-`).
 */
public func getVectorSceneRenderData(_ document: VectorDocument, viewport: VectorViewport = VectorViewport(), idPrefix: String = "ve-") throws -> JSONValue {
    try vectorSceneRender(document, viewport: viewport, idPrefix: idPrefix).data
}

/// The render data with its paint servers typed (the PDF writer fills from them).
func vectorSceneRender(_ document: VectorDocument, viewport: VectorViewport = VectorViewport(), idPrefix: String = "ve-") throws -> (data: JSONValue, defs: [VectorPaintDef]) {
    // not ported yet: lens backdrops (resolveVectorLenses) (#624).
    if hasLens(document.nodes) { throw VectorNotPorted("drawing lenses") }
    let document = resolveVectorMasterPages(document)
    var renderer = SceneRenderer(prefix: idPrefix)
    let nodes = try document.nodes.compactMap { try renderer.node($0) }
    var o = JSONObject([
        ("stats", .object(JSONObject([("nodes", .number(Double(document.nodes.count))), ("culled", 0), ("collapsed", 0)]))),
        ("transform", .string("translate(\(fmt(viewport.x)) \(fmt(viewport.y))) scale(\(JSONValue.jsNumber(viewport.zoom)))")),
        ("width", .number(document.width)),
        ("height", .number(document.height)),
    ])
    if let bg = document.background, !bg.isEmpty { o["background"] = .string(bg) }
    o["defs"] = .array(renderer.defs.map(\.json))
    o["filters"] = .array(renderer.filters.map(\.json))
    o["nodes"] = .array(nodes)
    return (.object(o), renderer.defs)
}

extension VectorEditorController {
    /// The scene the canvases draw (`getVectorSceneRenderData(controller.getState())`).
    public func sceneRenderData(idPrefix: String = "ve-") throws -> JSONValue {
        try getVectorSceneRenderData(doc, viewport: viewport, idPrefix: idPrefix)
    }
}
