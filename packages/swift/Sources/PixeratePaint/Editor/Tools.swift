import Foundation
import PixerateCore
import PixerateRaster

/**
 * Agent tools for the paint editor (`paint-editor/tools.ts`) and the brush library
 * (`brushes/tools.ts`). Definitions (names, titles, descriptions, strict `inputSchema`s and
 * annotations) come from the paint contracts (`tools.json`), so they match the TS core's; this
 * file holds the handlers. Only tools this port implements are registered: a tool it does not
 * have yet is "unknown" rather than wrong.
 */

typealias PaintToolHandler = (JSONObject) async throws -> JSONValue

/// The hex of a load colour, or null.
private func loadHex(_ c: [Double]?) -> JSONValue {
    guard let c else { return .null }
    return .string("#" + c.prefix(3).map { String(Int(JS.round(Swift.min(1, Swift.max(0, $0)) * 255)), radix: 16).leftPad(2) }.joined())
}

/// What the brush carries, as tools report it.
func loadResult(_ load: MixerLoad) -> JSONValue {
    ["reservoir": loadHex(load.reservoir), "amount": .number(round3(load.amount)), "pickup": loadHex(load.pickup)]
}

private func strokeResultJSON(_ r: PaintStrokeResult) -> JSONValue {
    var o: JSONObject = ["layerId": .string(r.layerId), "bounds": rectJSON(r.bounds), "dabs": .number(Double(r.dabs)), "strokeId": r.strokeId.map { .string($0) } ?? .null]
    if let load = r.mixerLoad { o["mixerLoad"] = loadResult(load) }
    return .object(o)
}

/// The handlers of the editor provider's tools, by name.
func paintEditorHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    var h: [String: PaintToolHandler] = [:]

    // --- Canvas

    h["get_canvas_info"] = { _ in
        let d = c.doc
        let origin = d.origin ?? LayerOffset(x: 0, y: 0)
        return [
            "width": .number(Double(d.canvas.width)), "height": .number(Double(d.canvas.height)), "dpi": .number(d.canvas.dpi),
            "origin": pointJSON(Double(origin.x), Double(origin.y)),
            "bounds": RasterRect(x: 0, y: 0, width: d.canvas.width, height: d.canvas.height).json,
            "paper": ["preset": .string(d.paper.preset), "name": .string(d.paper.name), "color": .string(d.paper.color), "depth": .number(d.paper.depth)],
            "activeLayerId": d.activeLayerId.map { .string($0) } ?? .null,
            "layerCount": .number(Double(c.listLayers().count)),
            "brushId": .string(c.brush.id), "color": .string(c.color), "secondaryColor": .string(c.secondaryColor),
            "view": ["zoom": .number(c.view.zoom), "rotation": .number(c.view.rotation), "mirror": .bool(c.view.mirror)],
            "hand": .string(c.hand), "strokes": .number(Double(d.strokes.count)),
            "undo": c.undoLabel.map { .string($0) } ?? .null, "redo": c.redoLabel.map { .string($0) } ?? .null,
            "blendModes": .array(BLEND_MODES.map { .string($0.id.rawValue) }),
            "wet": false,
            "lighting": c.lighting.json,
        ]
    }
    h["new_canvas"] = { a in
        let x = try NewCanvasArguments(a)
        let d = try c.newCanvas(width: x.width, height: x.height, dpi: x.dpi, paper: x.paper)
        return ["width": .number(Double(d.canvas.width)), "height": .number(Double(d.canvas.height)), "dpi": .number(d.canvas.dpi), "paper": .string(d.paper.preset), "layerId": d.activeLayerId.map { .string($0) } ?? .null]
    }
    h["set_canvas"] = { a in
        let x = try SetCanvasArguments(a)
        return try c.setCanvas(width: x.width, height: x.height, dpi: x.dpi).json
    }
    h["extend_canvas"] = { a in
        let x = try ExtendCanvasArguments(a)
        return .object(try c.extendCanvas(left: x.left, top: x.top, right: x.right, bottom: x.bottom))
    }

    // --- Paper

    h["list_papers"] = { _ in
        [
            "papers": .array(PAPER_LIBRARY.map { p in
                ["id": .string(p.preset), "name": .string(p.name), "family": .string(p.family), "pattern": .string(p.pattern), "color": .string(p.color), "depth": .number(p.depth), "absorption": .number(p.absorption), "permeability": .number(p.permeability), "roughness": .number(p.roughness)]
            }),
            "families": .array(PAPER_FAMILIES.map { .string($0) }),
            "patterns": .array(GRAIN_PATTERNS.map { .string($0) }),
        ]
    }
    h["get_paper"] = { _ in .object(c.doc.paper.json) }
    h["set_paper"] = { a in .object(try c.setPaper(a).json) }

    // --- Layers

    h["list_layers"] = { _ in ["layers": .array(c.listLayers().map(\.json)), "activeLayerId": c.doc.activeLayerId.map { .string($0) } ?? .null] }
    h["add_layer"] = { a in
        let parent: String?? = a.contains("parentId") ? .some(a["parentId"]?.stringValue) : nil
        return try c.addLayer(name: a["name"]?.stringValue, type: a["type"]?.stringValue, aboveId: a["aboveId"]?.stringValue, parentId: parent).json
    }
    h["update_layer"] = { a in try c.updateLayer(a["layerId"]?.stringValue ?? "", a.without("layerId")).json }
    h["list_blend_modes"] = { _ in
        ["modes": .array(BLEND_MODES.map { m in
            var o: JSONObject = ["id": .string(m.id.rawValue), "label": .string(m.label), "group": .string(m.painterly ? "painterly" : m.id == .pigment ? "pigment" : "standard")]
            if let d = m.description { o["description"] = .string(d) }
            o["psd"] = .string(standardBlendMode(m.id).rawValue)
            return .object(o)
        })]
    }
    h["set_active_layer"] = { a in
        let id = a["layerId"]?.stringValue ?? ""
        try c.setActiveLayer(id)
        return c.describeLayer(c.getLayer(id)!).json
    }
    h["remove_layer"] = { a in .object(try c.removeLayer(a["layerId"]?.stringValue ?? "")) }
    h["duplicate_layer"] = { a in try c.duplicateLayer(a["layerId"]?.stringValue ?? "").json }
    h["move_layer"] = { a in
        let parent: String?? = a.contains("parentId") ? .some(a["parentId"]?.stringValue) : nil
        return try c.moveLayer(a["layerId"]?.stringValue ?? "", Int(a["index"]?.numberValue ?? 0), parentId: parent).json
    }
    h["merge_layer_down"] = { a in try c.mergeDown(a["layerId"]?.stringValue ?? "").json }
    h["fill_layer"] = { a in
        .object(try c.fillLayer(layerId: a["layerId"]?.stringValue, color: a["color"]?.stringValue, opacity: a["opacity"]?.numberValue, grain: a["grain"]?.numberValue, pressure: a["pressure"]?.numberValue, blend: a["blend"]?.stringValue))
    }
    h["clear_layer"] = { a in .object(try c.clearLayer(a["layerId"]?.stringValue)) }

    // --- Brushes

    h["get_brush"] = { a in
        let id = a["id"]?.stringValue
        guard let b = id == nil ? c.brush : c.getBrush(id!) else {
            _ = try c.setBrushFacets([:], id: id)
            throw PaintEditorError("Unknown brush \"\(id ?? "")\".")
        }
        return ["brush": .object(c.getBrushSpec(id) ?? [:]), "engine": .string(b.engine), "category": .string(b.category), "builtin": .bool(b.builtin == true), "strokePaint": b.paint?.json ?? c.paint.json]
    }
    h["set_brush"] = { a in
        let unset = a["unset"]?.arrayValue?.compactMap(\.stringValue) ?? []
        let r = try c.setBrushFacets(a.without("id", "unset"), id: a["id"]?.stringValue, unset: unset)
        return ["brush": .object(r.spec), "engine": .string(r.brush.engine), "problems": .array(r.problems.map { .string($0) })]
    }

    // --- Colour and the Mixer Brush

    h["set_color"] = { a in
        let color = a["color"]?.stringValue, secondary = a["secondaryColor"]?.stringValue, locked = a["locked"]?.boolValue
        if color == nil && secondary == nil && locked == nil { throw PaintEditorError("Pass color, secondaryColor or locked.") }
        if let color { _ = try c.setColor(color) }
        if let secondary { _ = try c.setSecondaryColor(secondary) }
        if let locked { c.setColorLocked(locked) }
        return ["color": .string(c.color), "secondaryColor": .string(c.secondaryColor), "locked": .bool(c.colorLocked)]
    }
    h["set_paint"] = { a in
        let p = try c.setPaint(a["paint"] ?? .null)
        return ["paint": p.json, "color": .string(c.color), "secondaryColor": .string(c.secondaryColor)]
    }
    h["pick_color"] = { a in
        .object(try c.pickColor(a["x"]?.numberValue ?? 0, a["y"]?.numberValue ?? 0, layerId: a["layerId"]?.stringValue))
    }
    h["get_mixer_brush"] = { _ in loadResult(c.mixerLoad) }
    h["load_mixer_brush"] = { a in loadResult(try c.loadMixerBrush(a["color"]?.stringValue)) }
    h["clean_mixer_brush"] = { a in loadResult(c.cleanMixerBrush(a["emptyReservoir"] == .bool(true))) }

    // --- Painting

    h["paint_stroke"] = { a in
        let x = try PaintStrokeArguments(a)
        let changes = try x.brush.map { try c.brushChanges($0.objectValue ?? [:], from: x.brushId) }
        let points = x.points.compactMap(PenPoint.init(json:))
        var i = PaintStrokeInit(layerId: x.layerId, color: x.color, paint: x.paint, brushId: x.brushId, brush: changes, seed: x.seed)
        i.snapToPerspective = x.snapToPerspective
        return strokeResultJSON(try c.paintStroke(i, points: points))
    }

    h["stroke_path"] = { a in
        let x = try StrokePathArguments(a)
        let changes = try x.brush.map { try c.brushChanges($0.objectValue ?? [:], from: x.brushId) }
        let i = PaintStrokeInit(layerId: x.layerId, color: x.color, paint: x.paint, brushId: x.brushId, brush: changes, seed: x.seed)
        return .object(try c.strokePath(x.path, spacing: x.spacing, pressure: x.pressure, i))
    }
    h["replay_strokes"] = { a in
        let o = a["origin"]?.objectValue
        let opts = ReplayOptions(
            strokeIds: a["strokeIds"]?.arrayValue?.compactMap(\.stringValue) ?? [], dx: a["dx"]?.numberValue, dy: a["dy"]?.numberValue,
            scale: a["scale"]?.numberValue, rotate: a["rotate"]?.numberValue, flipX: a["flipX"]?.boolValue,
            origin: o.map { ($0["x"]?.numberValue ?? 0, $0["y"]?.numberValue ?? 0) }, pressureScale: a["pressureScale"]?.numberValue,
            layerId: a["layerId"]?.stringValue, color: a["color"]?.stringValue, brushId: a["brushId"]?.stringValue,
            repeatCount: a["repeat"]?.numberValue.map { Int($0) }
        )
        return .object(try c.replayStrokes(opts))
    }

    // --- View, hand, history

    h["set_hand"] = { a in ["hand": .string(try c.setHand(a["hand"]?.stringValue ?? ""))] }
    h["undo_paint"] = { _ in
        let undone = c.undo()
        return ["undone": undone.map { .string($0) } ?? .null, "nextUndo": c.undoLabel.map { .string($0) } ?? .null, "nextRedo": c.redoLabel.map { .string($0) } ?? .null]
    }
    h["redo_paint"] = { _ in
        let redone = c.redo()
        return ["redone": redone.map { .string($0) } ?? .null, "nextUndo": c.undoLabel.map { .string($0) } ?? .null, "nextRedo": c.redoLabel.map { .string($0) } ?? .null]
    }
    return h
}

/// A provider of the contract's tools that this port implements.
func contractProvider(_ id: String, _ handlers: [String: PaintToolHandler], content: [String: (JSONObject) async throws -> ToolOutput] = [:]) throws -> AgentToolProvider {
    guard let contract = try PaintContracts.toolProviders().first(where: { $0.id == id }) else { throw ContractError("tools.json has no provider \(id).") }
    let tools: [AgentTool] = contract.tools.compactMap { def in
        if let raw = content[def.name] {
            return AgentTool(name: def.name, title: def.title, description: def.description, inputSchema: def.inputSchema, outputSchema: def.outputSchema, annotations: def.annotations) { args, _ in try await raw(args) }
        }
        guard let handler = handlers[def.name] else { return nil }
        return AgentTool(name: def.name, title: def.title, description: def.description, inputSchema: def.inputSchema, outputSchema: def.outputSchema, annotations: def.annotations) { args, _ in
            .value(try await handler(args))
        }
    }
    return AgentToolProvider(id: id, title: contract.title, skill: contract.skill, tools: tools)
}

/// The paint editor's tools (`createPaintEditorToolProvider`): the ones this port implements.
public func createPaintEditorToolProvider(_ controller: PaintEditorController) throws -> AgentToolProvider {
    let handlers = paintEditorHandlers(controller).merging(paintGuideHandlers(controller)) { a, _ in a }.merging(paintPadHandlers(controller)) { a, _ in a }.merging(paintTracingHandlers(controller)) { a, _ in a }.merging(paintStrokeHandlers(controller)) { a, _ in a }.merging(paintEffectHandlers(controller)) { a, _ in a }
    return try contractProvider("paint-editor", handlers, content: paintContentHandlers(controller))
}

/// The brush library's tools for a paint editor (`createPaintBrushLibraryToolProvider`): the ones this port implements.
public func createPaintBrushLibraryToolProvider(_ controller: PaintEditorController) throws -> AgentToolProvider {
    try contractProvider("brushes", brushLibraryHandlers(controller), content: brushLibraryContentHandlers(controller))
}
