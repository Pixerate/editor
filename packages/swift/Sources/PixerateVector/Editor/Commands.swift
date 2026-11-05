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

/// The style fields of `params` (`pickStyle`), with their paints checked.
private func pickStyle(_ params: JSONObject) throws -> JSONObject {
    var out = JSONObject()
    for key in STYLE_PROPS { if let v = params[key] { out[key] = v } }
    for key in ["fill", "stroke"] {
        // not ported yet: gradients and shaded paints (sanitizeVectorGradient) (#624)
        if out[key]?.objectValue != nil { throw VectorNotPorted("gradient paints") }
    }
    if out["fills"] != nil || out["strokes"] != nil { throw VectorNotPorted("fill and stroke stacks") }
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
                // not ported yet: blends and mask summaries (#624)
                if n.isGroup && truthy(n["blend"]) { throw VectorNotPorted("listing blend groups") }
                if isVectorMaskGroup(n) { throw VectorNotPorted("listing mask groups") }
                if truthy(n["blendStep"]) { o["blendStep"] = true }
                if let e = n["effects"], let c = e.arrayValue?.count, c > 0 { o["effects"] = e }
                if n.isGroup && truthy(n["liveBoolean"]) { o["liveBoolean"] = n["liveBoolean"] }
                if truthy(n["booleanOperation"]) { o["booleanOperation"] = n["booleanOperation"] }
                if n.isPath, let f = n["fills"], f.arrayValue != nil { o["fills"] = f }
                if n.isPath, let s = n["strokes"], s.arrayValue != nil { o["strokes"] = s }
                if let m = n["blendMode"]?.stringValue, !m.isEmpty, m != "normal" { o["blendMode"] = .string(m) }
                if let f = n["filters"], let c = f.arrayValue?.count, c > 0 { o["filters"] = f }
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
        // not ported yet: gradient paints and stacks given to a new shape (#624)
        _ = try pickStyle(params)
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
    return r
}
