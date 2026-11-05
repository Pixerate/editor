import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// The vector editor's commands (`createVectorCommands` in `vector/commands.ts`): what agents run
// with `run_command`, palettes list and shortcuts trigger. Every command's metadata (label,
// group, keywords, description, params schema, shortcut, read-only flag) comes from the contract
// (`commands.json`); this file adds each command's `enabled` check and its `run`. Commands whose
// `run` is not ported yet are listed with their TS enablement and fail with a "not ported yet"
// message (#624).

/// A command's run: the controller and the validated params, returning the result (nil for `undefined`).
typealias VectorCommandRun = (VectorEditorController, JSONObject) throws -> JSONValue?

/// Commands enabled when `ids` are given or something is selected (`enabledFor` in TS).
private let ENABLED_FOR: Set<String> = [
    "vector.setStyle", "vector.setGradient", "vector.addFill", "vector.addStroke", "vector.setBlendMode", "vector.addFilter", "vector.makeClippingMask",
    "vector.makeOpacityMask", "vector.setMaskOptions", "vector.releaseMask", "vector.createOutlines", "vector.makeSymbol", "vector.setInstanceOptions",
    "vector.detachInstance", "vector.frameSelection", "vector.setResizing", "vector.setConnector", "vector.setMeshGradient", "vector.setFreeformGradient",
    "vector.releaseSymmetry", "vector.addBrushstroke", "vector.attachToPerspective", "vector.setLens", "vector.removeLens", "vector.setWidthProfile",
    "vector.outlineStroke", "vector.distort", "vector.skew", "vector.envelope", "vector.transform", "vector.delete", "vector.addEffect",
    "vector.expandAppearance", "vector.group", "vector.ungroup", "vector.removeRedundantPoints",
]

/**
 * Palette and agent commands for a vector editor (`createVectorCommands`): list, select, add
 * shapes and paths, style, transform, align, arrange, group, boolean operations, Pathfinder, path
 * editing and SVG export. Register them in a `CommandRegistry` whose context is the controller
 * and whose history is `controller.history`; agents get them through `createCommandToolProvider`.
 * Failures throw sentences, which the registry returns as `{ ok: false, code: 'failed', message }`.
 */
public func createVectorCommands(_ controller: VectorEditorController) throws -> [CommandSpec<VectorEditorController>] {
    let runs = vectorCommandRuns()
    return try VectorContracts.commands().map { c in
        let enabled: ((VectorEditorController, JSONObject?) throws -> CommandAvailability)?
        if ENABLED_FOR.contains(c.id) {
            enabled = { ctl, params in
                if let ids = params?["ids"]?.arrayValue, !ids.isEmpty { return .enabled }
                return ctl.selection.isEmpty ? "Nothing is selected." : .enabled
            }
        } else if c.id == "vector.exitSymbolEdit" {
            // not ported yet: symbol editing (#624); no symbol can be in isolation mode.
            enabled = { _, _ in "No symbol is being edited." }
        } else {
            enabled = nil
        }
        let id = c.id
        let run: VectorCommandRun = runs[id] ?? { _, _ in throw VectorEditorError("\(id) is not ported to Swift yet (#624).") }
        return CommandSpec<VectorEditorController>(
            id: c.id, label: c.label, group: c.group, keywords: c.keywords, description: c.description,
            params: c.params, shortcut: c.shortcut.map { CommandShortcut($0) }, scope: c.scope,
            undoable: c.undoable, readOnly: c.readOnly, hidden: c.hidden, enabled: enabled,
            run: { _, params in try run(controller, params) }
        )
    }
}

// MARK: - Params

/// Typed reads of a command's (already validated) params.
struct VectorParams {
    let o: JSONObject
    init(_ o: JSONObject) { self.o = o }

    func has(_ k: String) -> Bool { o[k] != nil }
    func num(_ k: String) -> Double? { o[k]?.numberValue }
    func int(_ k: String) -> Int? { o[k]?.numberValue.map { Int($0) } }
    func str(_ k: String) -> String? { o[k]?.stringValue }
    func bool(_ k: String) -> Bool? { o[k]?.boolValue }
    func strings(_ k: String) -> [String]? { o[k]?.arrayValue?.compactMap(\.stringValue) }
    /// `[[x, y], …]` as points.
    func pointList(_ k: String) -> [Vec2]? {
        o[k]?.arrayValue?.map { p in Vec2(p.arrayValue?[0].numberValue ?? .nan, p.arrayValue?[1].numberValue ?? .nan) }
    }
    /// `{ x, y }`.
    func point(_ k: String) -> Vec2? { Vec2(json: o[k]) }
    /// `[{ nodeId, subpath, index }, …]`.
    func anchorRefs(_ k: String) -> [VectorAnchorRef]? {
        o[k]?.arrayValue?.map { r in VectorAnchorRef(nodeId: r["nodeId"]?.stringValue ?? "", subpath: Int(r["subpath"]?.numberValue ?? 0), index: Int(r["index"]?.numberValue ?? 0)) }
    }
}

private func fail(_ message: String) -> VectorEditorError { VectorEditorError(message) }

private func check(_ result: VectorActionResult) throws {
    if !result.ok { throw fail(result.message ?? "The command failed.") }
}

/// The ids a command acts on: `ids`, else the selection (`ids` in TS).
private func targetIds(_ c: VectorEditorController, _ p: VectorParams) throws -> [String] {
    let list = p.strings("ids") ?? c.selection
    for id in list where c.getNode(id) == nil { throw fail("There is no node \"\(id)\".") }
    if list.isEmpty { throw fail("Nothing is selected; pass ids.") }
    return list
}

/// Checks a `parentId` (a group to add into) and turns it into add options.
private func parentOf(_ c: VectorEditorController, _ parentId: String?) throws -> AddVectorNodeOptions {
    guard let parentId else { return AddVectorNodeOptions() }
    if c.getNode(parentId)?.isGroup != true { throw fail("\"\(parentId)\" is not a group to add into.") }
    return AddVectorNodeOptions(parentId: parentId)
}

/// The anchors a command acts on: `refs` (checked), else the selected anchors.
private func anchorsOf(_ c: VectorEditorController, _ refs: [VectorAnchorRef]?) throws -> [VectorAnchorRef] {
    guard let refs else { return c.anchors }
    for r in refs {
        guard let node = c.getNode(r.nodeId), node.isPath, node.subpaths.indices.contains(r.subpath), node.subpaths[r.subpath].anchors.indices.contains(r.index) else {
            throw fail("There is no anchor \(r.index) on subpath \(r.subpath) of \"\(r.nodeId)\".")
        }
    }
    return refs
}

/// The style fields of `STYLE_PROPS`, in its order (`pickStyle`).
private let STYLE_PROPS = ["fills", "strokes", "fill", "stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin", "strokeDasharray", "strokeAlign", "startArrow", "endArrow", "arrowAlign", "startArrowScale", "endArrowScale", "strokeWidthProfile", "fillRule"]

/// A paint from untrusted params (`checkPaint`): a colour or null as given, a gradient sanitised.
private func checkPaint(_ paint: JSONValue?, _ where_: String) throws -> JSONValue? {
    guard let paint, paint.objectValue != nil else { return paint }
    if let t = paint["type"]?.stringValue, t == "mesh" || t == "freeform" {
        // not ported yet: mesh and freeform gradients (sanitizeVectorShadedPaint) (#624)
        throw VectorNotPorted("mesh and freeform gradients")
    }
    guard let g = sanitizeVectorGradient(paint) else { throw fail("\(where_) is not a valid gradient: give a type and at least one stop { offset, color }.") }
    return .object(g)
}

/// The style fields of `params` (`pickStyle`), with their paints and stack layers checked.
private func pickStyle(_ params: JSONObject) throws -> JSONObject {
    var out = JSONObject()
    for key in STYLE_PROPS { if let v = params[key] { out[key] = v } }
    for key in ["fill", "stroke"] { if out[key] != nil { out[key] = try checkPaint(out[key], key) } }
    for key in ["fills", "strokes"] {
        guard let stack = out[key]?.arrayValue else { continue }
        for (i, l) in stack.enumerated() {
            guard let layer = l.objectValue else { throw fail("\(key)[\(i)] must be a layer object { paint, … }.") }
            _ = try checkPaint(layer["paint"], "\(key)[\(i)].paint")
            if let mode = layer["blendMode"], !isVectorBlendMode(mode) {
                throw fail("\(key)[\(i)].blendMode \"\(mode.stringValue ?? mode.stringified())\" is not one of: \(VECTOR_BLEND_MODES.joined(separator: ", ")).")
            }
        }
    }
    return out
}

private func ok() -> JSONValue { ["ok": true] }

private func idList(_ ids: [String]) -> JSONValue { .array(ids.map { .string($0) }) }

// MARK: - Listing

extension VectorEditorController {
    /// `vector.list`: every node (depth first) with bounds, rotation, style, path data and selection.
    func listing() throws -> JSONValue {
        var out: [JSONValue] = []
        func visit(_ nodes: [VectorNode], _ depth: Int) throws {
            for n in nodes {
                let parent = vectorParentMatrix(doc.nodes, n.id) ?? IDENTITY_MATRIX
                let b = try vectorNodeBounds(n, parent)
                var o = JSONObject([("id", .string(n.id)), ("type", .string(n.typeName))])
                if let name = n.name, !name.isEmpty { o["name"] = .string(name) }
                o["depth"] = .number(Double(depth))
                o["rotation"] = .number(round2(vectorNodeRotation(n, parent)))
                o["bounds"] = b.map { .object(JSONObject([("x", .number(round2($0.x))), ("y", .number(round2($0.y))), ("width", .number(round2($0.width))), ("height", .number(round2($0.height)))])) } ?? .null
                o["visible"] = .bool(n.isVisible)
                o["locked"] = .bool(n.isLocked)
                o["selected"] = .bool(selection.contains(n.id))
                if n.isPath {
                    o["fill"] = n.fill ?? .null
                    o["stroke"] = n.stroke ?? .null
                    o["strokeWidth"] = .number(n.strokeWidth ?? 1)
                    o["d"] = .string(vectorPathData(n, precision: 2))
                } else if n.isGroup {
                    o["children"] = .number(Double(n.children.count))
                } else {
                    // not ported yet: text and instances (#624)
                    throw VectorNotPorted("listing \(n.typeName) nodes")
                }
                // not ported yet: blend summaries (#624)
                if n.isGroup && truthy(n["blend"]) { throw VectorNotPorted("listing blend groups") }
                if truthy(n["blendStep"]) { o["blendStep"] = true }
                if let e = n["effects"], let c = e.arrayValue?.count, c > 0 { o["effects"] = e }
                if n.isGroup && truthy(n["liveBoolean"]) { o["liveBoolean"] = n["liveBoolean"] }
                if truthy(n["booleanOperation"]) { o["booleanOperation"] = n["booleanOperation"] }
                if n.isPath, let f = n["fills"], f.arrayValue != nil { o["fills"] = f }
                if n.isPath, let s = n["strokes"], s.arrayValue != nil { o["strokes"] = s }
                if let m = n["blendMode"]?.stringValue, !m.isEmpty, m != "normal" { o["blendMode"] = .string(m) }
                if let f = n["filters"], let c = f.arrayValue?.count, c > 0 { o["filters"] = f }
                if let mask = vectorMaskSummary(n) { o["mask"] = mask }
                if isVectorFrame(n) { o["frameRect"] = n["frame"] }
                if truthy(n["resizing"]) { o["resizing"] = n["resizing"] }
                if n.isPath && truthy(n["connector"]) { o["connector"] = n["connector"] }
                if n.isGroup && truthy(n["symmetry"]) { o["symmetry"] = n["symmetry"] }
                if n.isPath && truthy(n["lens"]) { o["lens"] = n["lens"] }
                out.append(.object(o))
                if n.isGroup { try visit(n.children, depth + 1) }
            }
        }
        try visit(doc.nodes, 0)
        return .object(JSONObject([("width", .number(doc.width)), ("height", .number(doc.height)), ("nodes", .array(out)), ("selection", idList(selection)), ("tool", .string(tool))]))
    }

    /// The selection box of the selected roots (`state.selectionFrame`).
    public func selectionFrame() throws -> VectorSelectionFrame? { try frameOf(selectedRoots()) }
}

// MARK: - Runs

private func vectorCommandRuns() -> [String: VectorCommandRun] {
    var r: [String: VectorCommandRun] = [:]

    // Listing, selection, tools and settings

    r["vector.list"] = { c, _ in try c.listing() }
    r["vector.select"] = { c, params in
        let p = VectorParams(params)
        let ids = p.strings("ids") ?? []
        for id in ids where c.getNode(id) == nil { throw fail("There is no node \"\(id)\".") }
        if ids.isEmpty && p.bool("add") != true { c.clearSelection() } else { c.select(ids, add: p.bool("add") ?? false) }
        return ["selection": idList(c.selection)]
    }
    r["vector.setTool"] = { c, params in
        let tool = VectorParams(params).str("tool") ?? ""
        c.setTool(tool)
        return ["tool": .string(tool)]
    }
    r["vector.setEditing"] = { c, params in
        var patch = JSONObject()
        for key in ["keepShapeOnDelete", "curvatureMoves", "pencilSmoothing", "recognizeShapes", "eraserSize", "pencilPressure", "distortMode", "distortSize", "distortStrength"] {
            if let v = params[key] { patch[key] = v }
        }
        c.setEditing(patch)
        return ["editing": .object(c.editing)]
    }
    r["vector.exportSvg"] = { c, params in
        ["svg": .string(try c.toSvg(precision: VectorParams(params).int("precision")))]
    }
    r["vector.importSvg"] = { c, params in
        let p = VectorParams(params)
        let svg = p.str("svg") ?? ""
        try check(p.bool("replace") == true ? c.loadSvg(svg) : c.importSvg(svg))
        return .object(JSONObject([("nodes", .number(Double(c.document.nodes.count))), ("selection", idList(c.selection))]))
    }

    // Adding and styling

    r["vector.addShape"] = { c, params in
        let p = VectorParams(params)
        var style = JSONObject()
        for key in VECTOR_STYLE_KEYS { if let v = params[key] { style[key] = v } }
        let input = VectorShapeInput(kind: p.str("kind") ?? "", x: p.num("x") ?? 0, y: p.num("y") ?? 0, width: p.num("width") ?? 0, height: p.num("height") ?? 0,
                                     cornerRadius: p.num("cornerRadius"), cornerKind: p.str("cornerKind"), sides: p.num("sides"), points: p.num("points"),
                                     innerRatio: p.num("innerRatio"), name: p.str("name"), style: style)
        return ["id": .string(try c.addShape(input, parentOf(c, p.str("parentId"))))]
    }
    r["vector.addPath"] = { c, params in
        let p = VectorParams(params)
        let style = try pickStyle(params)
        let name = p.str("name").flatMap { $0.isEmpty ? nil : $0 }
        let id = try c.addPath(p.str("d") ?? "", style: style, name: name, parentOf(c, p.str("parentId")))
        if let node = c.getNode(id), node.isPath, node.subpaths.isEmpty {
            c.undo()
            throw fail("The path data has no points.")
        }
        return ["id": .string(id)]
    }
    r["vector.setStyle"] = { c, params in
        let style = try pickStyle(params)
        if style.isEmpty { throw fail("Pass at least one style property.") }
        try check(c.setStyle(style, ids: targetIds(c, VectorParams(params))))
        return ok()
    }
    r["vector.setGradient"] = { c, params in
        var patch = params
        patch["ids"] = Optional<JSONValue>.none
        patch["target"] = Optional<JSONValue>.none
        let target = params["target"]?.stringValue ?? "fill"
        if let t = patch["type"], !(t.stringValue.map(VECTOR_GRADIENT_TYPES.contains) ?? false) { throw fail("Unknown gradient type \"\(t.stringValue ?? t.stringified())\".") }
        if let stops = patch["stops"], (stops.arrayValue?.isEmpty ?? true) { throw fail("stops needs at least one { offset, color }.") }
        let p = VectorParams(params)
        try check(c.setGradient(patch, ids: targetIds(c, p), target: target))
        let id = try targetIds(c, p).first
        var out = JSONObject([("ok", true)])
        if let id, let node = c.getNode(id), node.isPath, let g = node[target] { out["gradient"] = g }
        return .object(out)
    }
    r["vector.rename"] = { c, params in
        let p = VectorParams(params)
        try check(c.rename(p.str("id") ?? "", p.str("name") ?? ""))
        return .object(JSONObject([("id", .string(p.str("id") ?? "")), ("name", .string(p.str("name") ?? ""))]))
    }
    r["vector.delete"] = { c, params in
        try check(c.removeNodes(targetIds(c, VectorParams(params))))
        return ok()
    }

    // Transforms

    r["vector.transform"] = { c, params in
        let p = VectorParams(params)
        let target = try targetIds(c, p)
        let dx = p.num("dx") ?? 0, dy = p.num("dy") ?? 0
        if dx != 0 || dy != 0 { try check(c.translate(dx, dy, ids: target)) }
        if p.has("sx") || p.has("sy") { try check(c.scale(p.num("sx") ?? 1, p.num("sy") ?? p.num("sx") ?? 1, ids: target)) }
        if let rot = p.num("rotate"), rot != 0, !rot.isNaN { try check(c.rotate(rot, ids: target)) }
        if let angle = p.num("angle") { try check(c.setRotation(angle, ids: target)) }
        return ok()
    }
    r["vector.skew"] = { c, params in
        let p = VectorParams(params)
        try check(c.skew(p.num("ax") ?? 0, p.num("ay") ?? 0, ids: targetIds(c, p), origin: p.point("origin")))
        return ok()
    }
    r["vector.distort"] = { c, params in
        let p = VectorParams(params)
        let corners = (params["corners"]?.arrayValue ?? []).map { Vec2(json: $0) ?? Vec2(.nan, .nan) }
        try check(c.distort(corners, ids: targetIds(c, p), tolerance: p.num("tolerance")))
        let frame = try c.selectionFrame()
        return .object(JSONObject([("ok", true), ("bounds", frame.map { .object(JSONObject([("x", .number($0.x)), ("y", .number($0.y)), ("width", .number($0.width)), ("height", .number($0.height))])) } ?? .null)]))
    }
    r["vector.align"] = { c, params in
        let p = VectorParams(params)
        try check(c.align(p.str("edge") ?? "", ids: targetIds(c, p), to: p.str("to")))
        return ok()
    }
    r["vector.distribute"] = { c, params in
        let p = VectorParams(params)
        try check(c.distribute(p.str("direction") ?? "", ids: targetIds(c, p)))
        return ok()
    }

    // Structure

    r["vector.arrange"] = { c, params in
        let p = VectorParams(params)
        try check(c.arrange(p.str("order") ?? "", ids: targetIds(c, p)))
        return ok()
    }
    r["vector.moveLayer"] = { c, params in
        let p = VectorParams(params)
        let parent: String?? = params["parentId"].map { $0.stringValue }
        try check(c.moveNode(p.str("id") ?? "", parentId: parent, index: p.num("index")))
        return ok()
    }
    r["vector.group"] = { c, params in
        let p = VectorParams(params)
        guard let id = try c.group(ids: targetIds(c, p), name: p.str("name")) else { throw fail("Only nodes that share a parent can be grouped.") }
        return ["id": .string(id)]
    }
    r["vector.ungroup"] = { c, params in
        try check(c.ungroup(ids: targetIds(c, VectorParams(params))))
        return ["selection": idList(c.selection)]
    }

    // Booleans, Pathfinder, Shape Builder and the paint bucket

    r["vector.boolean"] = { c, params in
        let p = VectorParams(params)
        let live = p.bool("live") ?? false
        guard let id = try c.booleanOp(p.str("operation") ?? "", ids: targetIds(c, p), live: live) else {
            throw fail(live ? "Select two or more nodes with one parent, a live boolean group or its operands." : "Select at least two overlapping paths (the result was empty).")
        }
        return ["id": .string(id)]
    }
    r["vector.pathfinder"] = { c, params in
        let p = VectorParams(params)
        let op = p.str("operation") ?? ""
        if PathfinderOperation(rawValue: op) == nil { throw fail("Unknown Pathfinder operation \"\(op)\".") }
        let created = try c.pathfinder(op, ids: targetIds(c, p))
        if created.isEmpty { throw fail("Nothing came out: select paths that overlap (two or more, except for divide and outline).") }
        return .object(JSONObject([("ids", idList(created)), ("selection", idList(c.selection))]))
    }
    r["vector.shapeBuilderFaces"] = { c, params in
        ["faces": .array(try c.getShapeBuilderFaces(ids: targetIds(c, VectorParams(params))))]
    }
    r["vector.shapeBuilder"] = { c, params in
        let p = VectorParams(params)
        let result = try c.shapeBuilder(p.pointList("points") ?? [], ids: targetIds(c, p), erase: p.bool("erase") ?? false, tolerance: p.num("tolerance"))
        if !result.ok { throw fail(result.message ?? "The command failed.") }
        return .object(JSONObject([("merged", result.merged.map { .string($0) } ?? .null), ("faces", .number(Double(result.faces))), ("lines", .number(Double(result.lines))), ("edges", .number(Double(result.edges)))]))
    }
    r["vector.fillRegion"] = { c, params in
        let p = VectorParams(params)
        let point = params["point"]?.arrayValue ?? []
        guard let id = try c.fillRegion(Vec2(point[0].numberValue ?? .nan, point[1].numberValue ?? .nan), gap: p.num("gap")) else { throw fail("No closed region surrounds that point.") }
        return ["id": .string(id)]
    }

    // Path editing

    r["vector.moveAnchor"] = { c, params in
        let p = VectorParams(params)
        let ref = VectorAnchorRef(nodeId: p.str("nodeId") ?? "", subpath: p.int("subpath") ?? 0, index: p.int("index") ?? 0)
        try check(c.moveAnchor(ref, Vec2(p.num("x") ?? 0, p.num("y") ?? 0), curvature: p.bool("curvature")))
        return ok()
    }
    r["vector.bendSegment"] = { c, params in
        let p = VectorParams(params)
        let ref = VectorSegmentRef(nodeId: p.str("nodeId") ?? "", subpath: p.int("subpath") ?? 0, segment: p.int("segment") ?? 0)
        try check(c.bendSegment(ref, Vec2(p.num("x") ?? 0, p.num("y") ?? 0), t: p.num("t") ?? 0.5))
        return ok()
    }
    r["vector.deleteAnchors"] = { c, params in
        let p = VectorParams(params)
        try check(c.deleteAnchors(anchorsOf(c, p.anchorRefs("anchors")), keepShape: p.bool("keepShape")))
        return ok()
    }
    r["vector.join"] = { c, params in
        let p = VectorParams(params)
        try check(c.joinPaths(ids: p.has("ids") ? targetIds(c, p) : nil, tolerance: p.num("tolerance")))
        return ["selection": idList(c.selection)]
    }
    r["vector.average"] = { c, params in
        let p = VectorParams(params)
        try check(c.averageAnchors(p.str("axis") ?? "both", anchorsOf(c, p.anchorRefs("anchors"))))
        return ok()
    }
    r["vector.removeRedundantPoints"] = { c, params in
        let p = VectorParams(params)
        try check(c.removeRedundantPoints(ids: p.has("ids") ? targetIds(c, p) : nil, tolerance: p.num("tolerance")))
        return ok()
    }
    r["vector.smooth"] = { c, params in
        let p = VectorParams(params)
        try check(c.smoothPaths(ids: p.has("ids") ? targetIds(c, p) : nil, amount: p.num("amount"), refs: p.anchorRefs("anchors")))
        return ok()
    }
    r["vector.cut"] = { c, params in
        let p = VectorParams(params)
        if let nodeId = p.str("nodeId") {
            if c.getNode(nodeId) == nil { throw fail("There is no node \"\(nodeId)\".") }
            guard let x = p.num("x"), let y = p.num("y") else { throw fail("Pass x and y with nodeId.") }
            guard let created = try c.cutPathAt(nodeId, Vec2(x, y)) else { throw fail("Nothing to cut there (the end of an open path, or a locked path).") }
            return ["ids": idList(created)]
        }
        try check(c.cutAtAnchors(anchorsOf(c, p.anchorRefs("anchors"))))
        return ["ids": idList(c.selection)]
    }
    r["vector.knife"] = { c, params in
        let p = VectorParams(params)
        let created = try c.knife(p.pointList("points") ?? [], ids: p.has("ids") ? targetIds(c, p) : nil)
        if created.isEmpty { throw fail("The knife did not cross any closed path from edge to edge.") }
        return ["ids": idList(created)]
    }
    r["vector.erase"] = { c, params in
        let p = VectorParams(params)
        let changed = try c.erase(p.pointList("points") ?? [], ids: p.has("ids") ? targetIds(c, p) : nil, size: p.num("size"))
        if changed.isEmpty { throw fail("The eraser did not touch any path.") }
        return ["ids": idList(changed.filter { c.getNode($0) != nil })]
    }
    for mode in VECTOR_DISTORT_BRUSH_MODES {
        r["vector.\(mode)Brush"] = { c, params in
            let p = VectorParams(params)
            let (result, ids) = try c.distortBrush(mode, p.pointList("points") ?? [], ids: p.strings("ids"), radius: p.num("radius"), strength: p.num("strength"), angle: p.num("angle"), seed: p.num("seed"))
            try check(result)
            return ["ids": idList(ids ?? [])]
        }
    }
    r["vector.addPathByDimensions"] = { c, params in
        let p = VectorParams(params)
        let start = p.point("start") ?? Vec2(.nan, .nan)
        let (id, anchors) = try c.addPathByDimensions(start: start, steps: params["steps"]?.arrayValue ?? [], closed: p.bool("closed") ?? false, name: p.str("name"))
        return .object(JSONObject([("id", .string(id)), ("anchors", .array(anchors.map(\.json)))]))
    }
    vectorAppearanceRuns(&r)
    vectorStrokeRuns(&r)
    return r
}

// MARK: - Appearance, effects, masks and lenses

/// `FILL_LAYER_PROPS` keys, then `STROKE_SETTING_PROPS` keys (`FILL_KEYS`, `STROKE_KEYS`).
private let FILL_KEYS = ["paint", "opacity", "blendMode", "visible"]
private let STROKE_KEYS = FILL_KEYS + VECTOR_STROKE_SETTING_KEYS

/// A path node or a sentence saying it is not one (`pathOf`).
private func pathOf(_ c: VectorEditorController, _ id: String) throws -> VectorNode {
    guard let n = c.getNode(id) else { throw fail("There is no node \"\(id)\". Call vector.list for ids.") }
    if !n.isPath { throw fail("\"\(id)\" is a group; fills and strokes belong to paths (pass a path id, or use ids on vector.addFill / vector.addStroke for every path inside).") }
    return n
}

/// Checks that path `id` has layer `index` in its `kind` stack (`layerIndex`).
private func layerIndex(_ c: VectorEditorController, _ id: String, _ kind: String, _ index: Double?) throws -> Int {
    let path = try pathOf(c, id)
    let stack = kind == "fill" ? vectorFills(path) : vectorStrokes(path)
    let i = index ?? .nan
    if !(i.rounded() == i && i.isFinite) || !(i >= 0 && Int(i) < stack.count) {
        throw fail("index \(index.map(JSONValue.jsNumber) ?? "undefined") is out of range: \"\(id)\" has \(stack.count) \(kind)\(stack.count == 1 ? "" : "s") (0 is the bottom). Read them with vector.getAppearance.")
    }
    return Int(i)
}

/// `{ id, fills }` or `{ id, strokes }` (`stackResult`).
private func stackResult(_ c: VectorEditorController, _ id: String, _ kind: String) throws -> JSONValue {
    let path = try pathOf(c, id)
    let stack = kind == "fill" ? vectorFills(path) : vectorStrokes(path)
    return .object(JSONObject([("id", .string(id)), (kind == "fill" ? "fills" : "strokes", .array(stack.map { .object($0) }))]))
}

/// The layer fields of `params`, the paint checked (`layerPatchOf`).
private func layerPatchOf(_ params: JSONObject, _ keys: [String]) throws -> JSONObject {
    var out = JSONObject()
    for key in keys { if let v = params[key] { out[key] = key == "paint" ? try checkPaint(v, "paint") ?? .null : v } }
    return out
}

/// The paths and text inside `ids` (groups give every one inside; instances none; `pathsUnder`).
private func pathsUnder(_ c: VectorEditorController, _ ids: [String]) -> [String] {
    var out: [String] = []
    func walk(_ n: VectorNode) {
        if n.isGroup { n.children.forEach(walk) } else if !n.isInstance { out.append(n.id) }
    }
    for id in ids { if let n = c.getNode(id) { walk(n) } }
    return out
}

/// Fails unless every key of `params` is a parameter of filter `type` (`checkFilterParams`).
private func checkFilterParams(_ type: String, _ params: JSONObject?) throws {
    let allowed = vectorFilterParamKeys(type)
    for key in params?.keys ?? [] where !allowed.contains(key) { throw fail("\(type) has no parameter \"\(key)\"; it takes \(allowed.joined(separator: ", ")).") }
}

private func filtersResult(_ c: VectorEditorController, _ id: String) -> JSONValue {
    .object(JSONObject([("id", .string(id)), ("filters", c.getNode(id)?["filters"] ?? .array([]))]))
}

/// The filter `filterId` of node `nodeId`, or a sentence listing the ones it has (`filterOf`).
private func filterOf(_ c: VectorEditorController, _ nodeId: String, _ filterId: String) throws -> JSONValue {
    guard let node = c.getNode(nodeId) else { throw fail("There is no node \"\(nodeId)\".") }
    let list = node["filters"]?.arrayValue ?? []
    if let f = list.first(where: { $0["id"]?.stringValue == filterId }) { return f }
    let has = list.map { "\"\($0["id"]?.stringValue ?? "")\" (\($0["type"]?.stringValue ?? ""))" }.joined(separator: ", ")
    throw fail("Node \"\(nodeId)\" has no filter \"\(filterId)\"; it has \(has.isEmpty ? "none" : has).")
}

/// `{ id, mask }` of a mask group (`maskResult`).
private func maskResult(_ c: VectorEditorController, _ id: String) throws -> JSONValue {
    guard let mask = vectorMaskSummary(c.getNode(id)) else { throw fail("\"\(id)\" is not a mask group.") }
    return .object(JSONObject([("id", .string(id)), ("mask", mask)]))
}

/// Checks the objects a mask is made of before anything changes (`maskInputs`).
private func maskInputs(_ c: VectorEditorController, _ p: VectorParams) throws -> [String] {
    var list: [String] = []
    for id in try targetIds(c, p) where !list.contains(id) { list.append(id) }
    if list.count < 2 { throw fail("Masking needs at least two objects (the mask and what it masks); got \(list.count). Pass ids, or select more.") }
    for id in list where c.getNode(id)!.isLocked { throw fail("\"\(id)\" is locked; ask the user to unlock it, or leave it out of ids.") }
    if let maskId = p.str("maskId"), !list.contains(maskId) { throw fail("maskId \"\(maskId)\" must be one of ids (\(list.map { "\"\($0)\"" }.joined(separator: ", "))).") }
    return list
}

/// The mask groups among `ids` (default: the selection), or a sentence (`maskTargets` of the commands).
private func maskTargets(_ c: VectorEditorController, _ p: VectorParams) throws -> [String] {
    let list = try targetIds(c, p)
    let groups = list.compactMap { c.getNode($0) }.filter { isVectorMaskGroup($0) }
    if groups.isEmpty { throw fail("None of \(list.map { "\"\($0)\"" }.joined(separator: ", ")) is a mask group. Mask groups have a `mask` in vector.list; make one with vector.makeClippingMask or vector.makeOpacityMask.") }
    return groups.map(\.id)
}

private func appearanceOf(_ c: VectorEditorController, _ id: String) throws -> JSONValue {
    guard let n = c.getNode(id) else { throw fail("There is no node \"\(id)\".") }
    var o = JSONObject([("id", .string(n.id)), ("type", .string(n.typeName))])
    if n.isPath {
        o["fills"] = .array(vectorFills(n).map { .object($0) })
        o["strokes"] = .array(vectorStrokes(n).map { .object($0) })
        o["fillRule"] = .string(n.fillRule ?? "nonzero")
    }
    o["blendMode"] = n["blendMode"] ?? "normal"
    o["opacity"] = .number(n.opacity ?? 1)
    o["filters"] = n["filters"] ?? .array([])
    return .object(o)
}

private func vectorAppearanceRuns(_ r: inout [String: VectorCommandRun]) {
    r["vector.getAppearance"] = { c, params in try appearanceOf(c, VectorParams(params).str("id") ?? "") }
    for kind in ["fill", "stroke"] {
        let Kind = kind == "fill" ? "Fill" : "Stroke"
        let keys = kind == "fill" ? FILL_KEYS : STROKE_KEYS
        r["vector.add\(Kind)"] = { c, params in
            let p = VectorParams(params)
            let targets = try targetIds(c, p)
            try check(c.addPaintLayer(kind, layerPatchOf(params, keys), ids: targets, index: p.num("index")))
            return ["nodes": .array(try pathsUnder(c, targets).map { try stackResult(c, $0, kind) })]
        }
        r["vector.update\(Kind)"] = { c, params in
            let p = VectorParams(params)
            let nodeId = p.str("nodeId") ?? ""
            let index = try layerIndex(c, nodeId, kind, p.num("index"))
            let patch = try layerPatchOf(params, keys)
            if patch.isEmpty { throw fail("Pass at least one of: \(keys.joined(separator: ", ")).") }
            try check(c.updatePaintLayer(kind, index, patch, ids: [nodeId]))
            return try stackResult(c, nodeId, kind)
        }
        r["vector.remove\(Kind)"] = { c, params in
            let p = VectorParams(params)
            let nodeId = p.str("nodeId") ?? ""
            let index = try layerIndex(c, nodeId, kind, p.num("index"))
            try check(c.removePaintLayer(kind, index, ids: [nodeId]))
            return try stackResult(c, nodeId, kind)
        }
        r["vector.move\(Kind)"] = { c, params in
            let p = VectorParams(params)
            let nodeId = p.str("nodeId") ?? ""
            let index = try layerIndex(c, nodeId, kind, p.num("index"))
            try check(c.movePaintLayer(kind, index, p.num("to") ?? 0, ids: [nodeId]))
            return try stackResult(c, nodeId, kind)
        }
    }
    r["vector.setBlendMode"] = { c, params in
        let p = VectorParams(params)
        let targets = try targetIds(c, p)
        try check(c.setBlendMode(p.str("blendMode") ?? "", ids: targets))
        return ["nodes": .array(targets.map { id in .object(JSONObject([("id", .string(id)), ("blendMode", c.getNode(id)?["blendMode"] ?? "normal")])) })]
    }
    r["vector.addFilter"] = { c, params in
        let p = VectorParams(params)
        let type = p.str("type") ?? ""
        if !VECTOR_FILTER_TYPES.contains(type) { throw fail("Unknown filter type \"\(type)\"; use one of \(VECTOR_FILTER_TYPES.joined(separator: ", ")).") }
        let fp = params["params"]?.objectValue
        try checkFilterParams(type, fp)
        let targets = try targetIds(c, p)
        let created = c.addFilter(type, ids: targets, params: fp, index: p.num("index"))
        if created.isEmpty { throw fail("Nothing to add the filter to (blend steps take no filters).") }
        return ["nodes": .array(targets.enumerated().map { i, id in
            var o = JSONObject([("filterId", i < created.count ? .string(created[i]) : .null)])
            for (k, v) in filtersResult(c, id).objectValue! { o[k] = v }
            return .object(o)
        })]
    }
    r["vector.updateFilter"] = { c, params in
        let p = VectorParams(params)
        let nodeId = p.str("nodeId") ?? "", filterId = p.str("filterId") ?? ""
        let filter = try filterOf(c, nodeId, filterId)
        let fp = params["params"]?.objectValue
        try checkFilterParams(filter["type"]?.stringValue ?? "", fp)
        if fp == nil && p.bool("enabled") == nil { throw fail("Pass params or enabled.") }
        try check(c.updateFilter(nodeId, filterId, params: fp, enabled: p.bool("enabled")))
        return filtersResult(c, nodeId)
    }
    r["vector.removeFilter"] = { c, params in
        let p = VectorParams(params)
        let nodeId = p.str("nodeId") ?? "", filterId = p.str("filterId") ?? ""
        _ = try filterOf(c, nodeId, filterId)
        try check(c.removeFilter(nodeId, filterId))
        return filtersResult(c, nodeId)
    }
    r["vector.moveFilter"] = { c, params in
        let p = VectorParams(params)
        let nodeId = p.str("nodeId") ?? "", filterId = p.str("filterId") ?? ""
        _ = try filterOf(c, nodeId, filterId)
        try check(c.moveFilter(nodeId, filterId, p.num("index") ?? 0))
        return filtersResult(c, nodeId)
    }
    r["vector.addEffect"] = { c, params in
        let p = VectorParams(params)
        let type = p.str("type") ?? ""
        if !VECTOR_EFFECT_TYPES.contains(type) { throw fail("Unknown effect type \"\(type)\".") }
        let targets = try targetIds(c, p)
        let created = try c.addEffect(type, ids: targets, params: params["params"]?.objectValue, index: p.num("index"))
        if created.isEmpty { throw fail("Nothing to add the effect to.") }
        return ["effects": .array(targets.enumerated().map { i, id in .object(JSONObject([("nodeId", .string(id)), ("effectId", i < created.count ? .string(created[i]) : .null)])) })]
    }
    r["vector.updateEffect"] = { c, params in
        let p = VectorParams(params)
        let nodeId = p.str("nodeId") ?? "", effectId = p.str("effectId") ?? ""
        let ep = params["params"]?.objectValue
        if ep != nil || p.bool("enabled") != nil { try check(c.updateEffect(nodeId, effectId, params: ep, enabled: p.bool("enabled"))) }
        if let index = p.num("index") { try check(c.moveEffect(nodeId, effectId, index)) }
        return ["effects": c.getNode(nodeId)?["effects"] ?? .array([])]
    }
    r["vector.removeEffect"] = { c, params in
        let p = VectorParams(params)
        try check(c.removeEffect(p.str("nodeId") ?? "", p.str("effectId") ?? ""))
        return ok()
    }
    r["vector.expandAppearance"] = { c, params in
        let expanded = try c.expandAppearance(ids: targetIds(c, VectorParams(params)))
        if expanded.isEmpty { throw fail("Nothing selected has path effects or a live boolean.") }
        return ["ids": idList(expanded)]
    }
    for (command, fixed) in [("vector.makeClippingMask", "clip"), ("vector.makeOpacityMask", nil)] as [(String, String?)] {
        r[command] = { c, params in
            let p = VectorParams(params)
            let list = try maskInputs(c, p)
            let maskId = p.str("maskId").flatMap { $0.isEmpty ? nil : $0 }
            let result = c.makeMask(fixed ?? p.str("type") ?? "luminance", ids: list, maskId: maskId, invert: p.bool("invert") ?? false)
            guard result.ok, let id = result.id else { throw fail(result.message ?? "The command failed.") }
            return try maskResult(c, id)
        }
    }
    r["vector.setMaskOptions"] = { c, params in
        let p = VectorParams(params)
        if !p.has("type") && !p.has("invert") && !p.has("enabled") { throw fail("Pass at least one of type, invert, enabled.") }
        let groups = try maskTargets(c, p)
        try check(c.setMaskOptions(type: p.str("type").flatMap { $0.isEmpty ? nil : $0 }, invert: p.bool("invert"), enabled: p.bool("enabled"), ids: groups))
        return ["groups": .array(try groups.map { try maskResult(c, $0) })]
    }
    r["vector.releaseMask"] = { c, params in
        let groups = try maskTargets(c, VectorParams(params))
        return ["ids": idList(try c.releaseMask(ids: groups))]
    }
    r["vector.setLens"] = { c, params in
        var patch = params
        patch["ids"] = Optional<JSONValue>.none
        if patch.isEmpty { throw fail("Pass at least one of type, amount, color.") }
        let (result, lenses) = c.setLens(patch, ids: VectorParams(params).strings("ids"))
        try check(result)
        return ["lenses": .array(lenses.map { .object(JSONObject([("id", .string($0.id)), ("lens", $0.lens.map { .object($0) } ?? .null)])) })]
    }
    r["vector.removeLens"] = { c, params in
        let (result, lenses) = c.setLens(nil, ids: VectorParams(params).strings("ids"))
        try check(result)
        return ["ids": idList(lenses.map(\.id))]
    }
}

// MARK: - Strokes, corners and brushstrokes

/// `{ ok, points }`: the profile of path `id` after a width edit.
private func profileResult(_ c: VectorEditorController, _ id: String?) -> JSONValue {
    let node = id.flatMap { c.getNode($0) }
    let points = node?.isPath == true ? (node?["strokeWidthProfile"] ?? .array([])) : .array([])
    return .object(JSONObject([("ok", true), ("points", points)]))
}

/// `{ colorScheme, colorLocked }`.
private func brushColourResult(_ c: VectorEditorController) -> JSONValue {
    .object(JSONObject([("colorScheme", .string(c.colorScheme)), ("colorLocked", .bool(c.colorLocked))]))
}

private func vectorStrokeRuns(_ r: inout [String: VectorCommandRun]) {
    r["vector.setCorners"] = { c, params in
        let p = VectorParams(params)
        let refs = try p.anchorRefs("anchors").map { try anchorsOf(c, $0) }
        let ids = p.has("ids") ? try targetIds(c, p) : nil
        let kind = p.str("kind")
        if let radius = p.num("radius") { try check(c.setCornerRadius(radius, kind: kind, smoothing: p.num("smoothing"), refs: refs, ids: ids)) }
        else if let kind, !kind.isEmpty { try check(c.setCornerKind(kind, refs: refs, ids: ids)) }
        if !p.has("radius"), let smoothing = p.num("smoothing") { try check(c.setCornerSmoothing(smoothing, refs: refs, ids: ids)) }
        if !p.has("radius") && (kind ?? "").isEmpty && !p.has("smoothing") { throw fail("Pass `radius`, `kind` and / or `smoothing`.") }
        return ok()
    }
    r["vector.setWidthProfile"] = { c, params in
        let p = VectorParams(params)
        let ids = try targetIds(c, p)
        let taper = params["taper"]?.objectValue
        let wave = params["wave"]?.objectValue
        if let preset = p.str("preset"), !preset.isEmpty { try check(c.setWidthProfile(preset: preset, ids: ids)) }
        else if let points = params["points"] { try check(c.setWidthProfile(points: points, ids: ids)) }
        else if taper != nil || wave != nil { try check(c.setWidthProfile(taper: taper.map(VectorTaperOptions.init(json:)), wave: wave.map(VectorWaveOptions.init(json:)), ids: ids)) }
        else { throw fail("Pass `preset`, `points`, `taper` or `wave`.") }
        return profileResult(c, ids.first)
    }
    r["vector.setWidthPoint"] = { c, params in
        let p = VectorParams(params)
        guard let id = p.str("id"), !id.isEmpty else { throw fail("Pass the path `id`.") }
        try check(c.setWidthPoint(id, index: p.int("index"), t: p.num("t"), left: p.num("left"), right: p.num("right")))
        return profileResult(c, id)
    }
    r["vector.outlineStroke"] = { c, params in
        let p = VectorParams(params)
        let created = try c.outlineStroke(ids: p.has("ids") ? try targetIds(c, p) : nil)
        if created.isEmpty { throw fail("No selected path has a stroke.") }
        return ["ids": idList(created)]
    }
    r["vector.listBrushes"] = { c, _ in
        let brushes: [JSONValue] = vectorBrushstrokeBrushes().map { b in
            .object(JSONObject([("id", .string(b.id)), ("name", .string(b.name)), ("category", .string(b.category)), ("size", .number(b.size)), ("builtin", .bool(b.builtin))]))
        }
        var out = JSONObject([("brushes", .array(brushes))])
        for (k, v) in brushColourResult(c).objectValue! { out[k] = v }
        return .object(out)
    }
    r["vector.addBrushstroke"] = { c, params in
        let p = VectorParams(params)
        let targets = p.strings("ids") ?? c.selection
        var brush = JSONObject([("brushId", params["brushId"] ?? .null)])
        for key in ["size", "pressure", "seed", "paper", "paint"] { if let v = params[key] { brush[key] = v } }
        try check(c.addBrushstroke(brush, ids: p.strings("ids"), index: p.num("index"), color: p.str("color").flatMap { $0.isEmpty ? nil : $0 }, keepColour: p.bool("keepColour") == true, opacity: p.num("opacity")))
        var paths: [JSONValue] = []
        for id in targets where c.getNode(id)?.isPath == true { paths.append(try stackResult(c, id, "stroke")) }
        return ["paths": .array(paths)]
    }
    r["vector.setBrushstroke"] = { c, params in
        let p = VectorParams(params)
        let id = p.str("id") ?? ""
        var patch = params
        remove(&patch, "id")
        remove(&patch, "index")
        if patch.isEmpty { throw fail("Pass at least one of brushId, size, pressure, color, opacity, seed, paper, paint.") }
        let index = try layerIndex(c, id, "stroke", p.num("index"))
        try check(c.setBrushstroke(index, patch, ids: [id]))
        return try stackResult(c, id, "stroke")
    }
    r["vector.setColorLocked"] = { c, params in
        c.setColorLocked(VectorParams(params).bool("locked") == true)
        return brushColourResult(c)
    }
    r["vector.setColorScheme"] = { c, params in
        c.setColorScheme(VectorParams(params).str("scheme") ?? "light")
        return brushColourResult(c)
    }
}
