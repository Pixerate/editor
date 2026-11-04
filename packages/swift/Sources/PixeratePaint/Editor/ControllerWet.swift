import Foundation
import PixerateCore
import PixerateRaster

/**
 * Wet media, thick paint and light in the controller (`controller.ts`, "Wet media", "Thick paint
 * and light", "Light paint"), with their agent tools (`wet-tools.ts`, `thick-tools.ts`). Settings
 * (wet parameters, flow maps, tilt, lighting, spill) are saved with the document but are not undo
 * steps; drying, wetting the paper, clearing light and flattening relief are.
 */

/// An operation that changes wet paint: the simulation before it (for undo).
struct WetOperation {
    var before: WetSnapshot?
}

/// Checks and fills a spill change; throws a sentence naming the bad field.
func normalizeLightSpill(radius: Double?, strength: Double?, _ base: LightSpill = DEFAULT_LIGHT_SPILL) throws -> LightSpill {
    let radius = radius ?? base.radius
    let strength = strength ?? base.strength
    if !(radius.isFinite && radius >= 0 && radius <= 512) { throw PaintEditorError("radius \(jsText(radius)) is out of range; use 0..512 px (0 turns spill off).") }
    if !(strength.isFinite && strength >= 0 && strength <= 2) { throw PaintEditorError("strength \(jsText(strength)) is out of range; use 0..2.") }
    return LightSpill(radius: radius, strength: strength)
}

extension LightSpill {
    var json: JSONValue { ["radius": .number(radius), "strength": .number(strength)] }
}

extension PaintEditorController {
    // MARK: - Wet history

    /// Keeps the wet snapshots in history within the wet undo memory, dropping the oldest.
    func trimWetHistory() {
        var seen = Set<ObjectIdentifier>()
        var bytes = 0
        for e in Array(undoStack.reversed()) + Array(redoStack.reversed()) {
            guard let w = e.wet, !w.lost else { continue }
            for snap in [w.before, w.after] {
                if let snap, !seen.contains(ObjectIdentifier(snap)) {
                    seen.insert(ObjectIdentifier(snap))
                    bytes += snap.bytes
                }
            }
            if bytes > wet.undoMemory { e.wet = (nil, nil, true) }
        }
    }

    /// Starts an operation that changes wet paint: keeps the simulation as it is now for undo.
    func beginWetOp() {
        if wetOp == nil { wetOp = WetOperation(before: wet.snapshot()) }
    }

    /// Before a non-wet change to layers that hold wet paint: dries them first, in the same undo step. Returns the ids dried.
    @discardableResult
    func dryLayersFirst(_ ids: [String]) -> [String] {
        let wetIds = ids.filter { wet.wetLayerIds().contains($0) }
        if wetIds.isEmpty { return [] }
        beginWetOp()
        for id in wetIds { _ = try? wet.dry(id) }
        logWet("dry", layerId: wetIds.joined(separator: ","))
        return wetIds
    }

    /// Records a wet event (for replays) for the document being built.
    func logWet(_ kind: String, layerId: String? = nil, data: JSONValue? = nil, at: Int? = nil) {
        pendingWetEvents.append(WetEvent(clock: wet.world?.clock ?? 0, at: at ?? doc.strokes.count, kind: kind, layerId: layerId, data: data))
    }

    /// The document with the pending wet events appended.
    func withWetEvents(_ d: PaintDocumentState) -> PaintDocumentState {
        if pendingWetEvents.isEmpty { return d }
        let events = (d.wetEvents ?? []) + pendingWetEvents
        pendingWetEvents = []
        return d.with { $0.wetEvents = events }
    }

    /// Records a settings change as a wet event (not an undo step).
    private func recordWetSetting(_ kind: String, layerId: String? = nil, data: JSONValue) {
        let d = doc
        doc = d.with { $0.wetEvents = (d.wetEvents ?? []) + [WetEvent(clock: wet.world?.clock ?? 0, at: d.strokes.count, kind: kind, layerId: layerId, data: data)] }
    }

    func wetLayer(_ layerId: String?, _ what: String) throws -> PaintLayer {
        guard let id = layerId ?? doc.activeLayerId else { throw PaintEditorError("There is no active layer to \(what); pass layerId (list_layers).") }
        let l = try requireLayer(id)
        if !l.isPixel { throw PaintEditorError("Layer \"\(l.name)\" is a group; \(what) a pixel layer inside it.") }
        return l
    }

    func checkRect(_ raw: JSONValue?) throws -> RasterRect? {
        guard let o = raw?.objectValue else { return nil }
        let v = [o["x"]?.numberValue, o["y"]?.numberValue, o["width"]?.numberValue, o["height"]?.numberValue]
        guard let x = v[0], let y = v[1], let w = v[2], let h = v[3], x.isFinite, y.isFinite, w.isFinite, h.isFinite, w > 0, h > 0 else {
            throw PaintEditorError("rect needs finite x, y and a width and height above 0 (document pixels).")
        }
        let r = RasterRect(x: Int(JS.floor(x)), y: Int(JS.floor(y)), width: Int(JS.ceil(w)), height: Int(JS.ceil(h)))
        let cw = doc.canvas.width, ch = doc.canvas.height
        if r.x >= cw || r.y >= ch || r.x + r.width <= 0 || r.y + r.height <= 0 { throw PaintEditorError("rect is outside the \(cw)×\(ch) canvas.") }
        return r
    }

    // MARK: - Wet media

    /// Wet media as panels show it (`getState().wet`).
    public var wetStateInfo: JSONObject {
        [
            "layerIds": .array(wet.wetLayerIds().map { .string($0) }), "wet": .bool(wet.isWet()), "paused": .bool(wet.paused), "overlay": .bool(wet.overlay),
            "instantDry": .bool(wet.instantDry), "speed": .number(wet.speed), "clock": .number(Double(wet.world?.clock ?? 0)), "tilt": wet.tilt.json,
            "gpu": .string(wet.gpuMode), "gpuActive": false,
        ]
    }

    /// Wet media as panels and tools show it, with each wet layer's state.
    public func wetState() -> JSONObject {
        var o = wetStateInfo
        o["layers"] = .array(wet.wetLayerIds().map { wet.info($0).json })
        let backend = wet.backend()
        o["backend"] = backend?.json ?? .null
        o["message"] = backend?.message.map { .string($0) } ?? .null
        o["engine"] = wet.engineInfo().json
        return o
    }

    /// One layer's wet settings and state.
    public func wetLayerInfo(_ layerId: String? = nil) throws -> WetLayerInfo {
        wet.info(try wetLayer(layerId, "read the wet paint of").id)
    }

    /**
     * Lets wet paint flow with the wall clock: call every frame with the time in ms. Steps at the
     * wet speed unless paused. Returns the steps run (the view redraws the tiles that changed).
     */
    @discardableResult
    public func tickWet(_ now: Double) -> Int {
        if liveStroke != nil { return 0 }
        return wet.tick(now)
    }

    /// Lets the CPU engine run alone (`off`) or allows a GPU engine (`auto`; this port has none). Not an undo step.
    public func setWetEngine(gpu: String?, minTiles: Int?) throws -> WetEngineInfo {
        let g = gpu ?? wet.gpuMode
        if !WET_GPU_MODES.contains(g) { throw PaintEditorError("gpu must be auto or off, not \(JSONValue.string(g).stringified()).") }
        if let m = minTiles, !(m >= 1 && m <= 1024) { throw PaintEditorError("minTiles \(m) is out of range; use 1..1024 tiles of 256 px.") }
        let info = wet.setGpu(g, minTiles: minTiles)
        emit()
        return info
    }

    /// Lets the paint flow for `steps` simulation steps now (or `seconds` at the wet speed). Not an undo step.
    public func advanceWet(steps: Int?, seconds: Double?) throws -> JSONObject {
        let n = steps ?? Int(JS.round((seconds ?? 1) * wet.speed))
        if !(n >= 0 && n <= 100000) { throw PaintEditorError("steps \(n) is out of range; use 0..100000 (or seconds).") }
        let run = wet.advance(n)
        emit()
        let st = wetState()
        return ["steps": .number(Double(run)), "clock": st["clock"]!, "stillWet": st["wet"]!, "layers": st["layers"]!]
    }

    /// Dries wet paint at once (one undo step), on one layer or all, optionally only inside `rect`.
    public func dryPaint(layerId: String? = nil, rect rawRect: JSONValue? = nil) throws -> JSONObject {
        if liveStroke != nil { throw PaintEditorError("A stroke is in progress; end or cancel it before drying.") }
        if let layerId { _ = try wetLayer(layerId, "dry") }
        let rect = try checkRect(rawRect)
        let ids = layerId.map { id in wet.wetLayerIds().filter { $0 == id } } ?? wet.wetLayerIds()
        if ids.isEmpty { return ["dried": [], "stillWet": .bool(wet.isWet())] }
        let before = doc
        beginWetOp()
        var dried: [JSONValue] = []
        for id in ids { for d in try wet.dry(id, rect) { dried.append(["layerId": .string(d.layerId), "bounds": rectJSON(d.bounds)]) } }
        logWet("dry", layerId: layerId, data: rect.map { $0.json })
        commit("Dry paint", withWetEvents(doc), before: before)
        return ["dried": .array(dried), "stillWet": .bool(wet.isWet())]
    }

    /// Pre-wets the paper over `rect` (default the canvas) by `amount` 0..1 on a layer (one undo step).
    public func wetPaper(layerId: String? = nil, rect rawRect: JSONValue? = nil, amount amountIn: Double? = nil) throws -> JSONObject {
        if liveStroke != nil { throw PaintEditorError("A stroke is in progress; end or cancel it before wetting the paper.") }
        let l = try wetLayer(layerId, "wet the paper of")
        if isLayerLocked(l.locks, .pixels) { throw PaintEditorError("Layer \"\(l.name)\" has its pixels locked; unlock it first.") }
        let amount = amountIn ?? 1
        if !(amount > 0 && amount <= 1) { throw PaintEditorError("amount \(jsText(amount)) is out of range; use above 0 up to 1.") }
        let rect = try checkRect(rawRect) ?? RasterRect(x: 0, y: 0, width: doc.canvas.width, height: doc.canvas.height)
        if !wet.wetLayerIds().contains(l.id) && wet.wetLayerIds().count >= MAX_WET_LANES { throw PaintEditorError("At most \(MAX_WET_LANES) layers can hold wet paint at once; dry one first (dry_paint).") }
        let before = doc
        beginWetOp()
        let world = try wet.ensureLane(l.id)
        try world.wetPaper(l.id, rect, nil, amount: amount)
        wet.syncDisplays()
        logWet("wet-paper", layerId: l.id, data: ["rect": rect.json, "amount": .number(amount)])
        commit("Wet paper", withWetEvents(doc), before: before)
        return ["layerId": .string(l.id), "rect": rect.json, "wet": .bool(wet.isWet(l.id))]
    }

    /// A layer in the wet world (`ensureLane`), with its pixels moved into canvas space first.
    func moveIntoCanvasSpace(_ l: PaintLayer, medium: String? = nil) throws -> WetWorld {
        if !wet.wetLayerIds().contains(l.id), l.pixelOffset.x != 0 || l.pixelOffset.y != 0 {
            let moved = l.withSurface(translateSurface(l.pixelSurface, Double(l.pixelOffset.x), Double(l.pixelOffset.y)), offset: LayerOffset(x: 0, y: 0))
            doc = doc.with { $0.layers = mapLayer(doc.layers, l.id) { _ in moved } }
        }
        return try wet.ensureLane(l.id, medium)
    }

    /// Changes a layer's wet settings. Saved with the document, not an undo step.
    public func setWetParams(_ layerId: String?, _ update: JSONObject) throws -> WetParams {
        let l = try wetLayer(layerId, "change the wet settings of")
        let params = try wet.setParams(l.id, update)
        recordWetSetting("params", layerId: l.id, data: params.json)
        emit()
        return params
    }

    /// Sets a layer's flow map. Saved with the document, not an undo step.
    public func setFlowMap(_ layerId: String?, _ update: JSONObject) throws -> WetFlowSpec {
        let l = try wetLayer(layerId, "set the flow map of")
        let flow = try wet.setFlow(l.id, update)
        recordWetSetting("flow", layerId: l.id, data: flow.json)
        emit()
        return flow
    }

    /// Tilts the canvas. Saved with the document, not an undo step.
    public func setCanvasTilt(angle: Double?, direction: Double?) throws -> WetTilt {
        if let a = angle, !(a >= 0 && a <= 90) { throw PaintEditorError("angle \(jsText(a)) is out of range; use 0 (flat) .. 90 (upright) degrees.") }
        let tilt = wet.setTilt(angle: angle, direction: direction)
        recordWetSetting("tilt", data: tilt.json)
        emit()
        return tilt
    }

    /// Stops (or restarts) time: paused paint stays wet. Editor state.
    @discardableResult
    public func setWetPaused(_ paused: Bool) -> Bool {
        wet.paused = paused
        emit()
        return paused
    }

    /// Simulation steps per second while time runs (1..2000; default 120). Editor state.
    @discardableResult
    public func setWetSpeed(_ speed: Double) throws -> Double {
        if !(speed >= 1 && speed <= 2000) { throw PaintEditorError("speed \(jsText(speed)) is out of range; use 1..2000 steps per second.") }
        wet.speed = speed
        emit()
        return speed
    }

    /// Wet strokes dry as soon as they end (each stroke still one undo step). Editor state.
    @discardableResult
    public func setInstantDry(_ on: Bool) -> Bool {
        wet.instantDry = on
        emit()
        return on
    }

    /// Shows or hides the water overlay (view only).
    @discardableResult
    public func setWaterOverlay(_ visible: Bool) -> Bool {
        wet.overlay = visible
        emit()
        return visible
    }

    /// The water overlay's tiles over a document rectangle (RGBA, view only).
    public func waterOverlayTiles(_ rect: RasterRect) -> [(tx: Int, ty: Int, data: [UInt8])] { wet.waterOverlay(rect) }

    /// The layers with every wet layer dried where it is (what saving and exporting see).
    func driedLayers(_ layers: [PaintLayer]) -> [PaintLayer] {
        let ids = wet.wetLayerIds()
        if ids.isEmpty { return layers }
        var out = layers
        for id in ids {
            if let baked = wet.bakedSurface(id), findLayer(out, id) != nil { out = mapLayer(out, id) { $0.withSurface(baked) } }
        }
        return out
    }

    /// Wet settings saved with the document (nil when they are all defaults).
    func wetJSON() -> JSONValue? {
        var layers = JSONObject()
        for (id, s) in wet.settings where findLayer(doc.layers, id) != nil { layers[id] = ["params": s.params.json, "flow": s.flow.json] }
        if layers.isEmpty && wet.tilt.angle == 0 { return nil }
        return ["tilt": wet.tilt.json, "layers": .object(layers)]
    }

    // MARK: - Light paint

    /// A layer's light paint: whether it has any, where (document pixels), its brightest value and its spill.
    public func lightOf(_ layerId: String? = nil) throws -> JSONObject {
        let l = try wetLayer(layerId, "read the light of")
        let info = lightInfo(doc.light?.get(l.id))
        let bounds = info.bounds.map { RasterRect(x: $0.x + l.pixelOffset.x, y: $0.y + l.pixelOffset.y, width: $0.width, height: $0.height) }
        return ["layerId": .string(l.id), "hasLight": .bool(info.peak > 0), "bounds": rectJSON(bounds), "peak": .number(Double(info.peak)), "spill": (lightSpills[l.id] ?? DEFAULT_LIGHT_SPILL).json]
    }

    /// How far a layer's light spills and how strongly. Saved with the document, not an undo step.
    public func setLightSpill(_ layerId: String?, radius: Double?, strength: Double?) throws -> LightSpill {
        let l = try wetLayer(layerId, "set the light spill of")
        let spill = try normalizeLightSpill(radius: radius, strength: strength, lightSpills[l.id] ?? DEFAULT_LIGHT_SPILL)
        lightSpills[l.id] = spill
        emit()
        return spill
    }

    /// Takes a layer's light away; its paint keeps its colour. One undo step.
    public func clearLight(_ layerId: String? = nil) throws -> JSONObject {
        if liveStroke != nil { throw PaintEditorError("A stroke is in progress; end or cancel it before clearing light.") }
        let l = try paintTarget(layerId, "clear the light of")
        // Wet light lives in the simulation: the paint dries first (in the same undo step).
        if wet.bakedLight(l.id) != nil { dryLayersFirst([l.id]) }
        guard doc.light?.get(l.id) != nil else { return ["layerId": .string(l.id), "cleared": false] }
        commit("Clear light", doc.with { $0.removingLight([l.id]) })
        return ["layerId": .string(l.id), "cleared": true]
    }

    // MARK: - Thick paint

    /// Moves the light (thick paint and metallic paper are relit). Saved with the document, not an undo step.
    public func setLighting(azimuth: Double?, elevation: Double?, relief: Double?) throws -> PaintLighting {
        if let e = elevation, !(e >= 5 && e <= 90) { throw PaintEditorError("elevation \(jsText(e)) is out of range; use 5..90 degrees.") }
        if let r = relief, !(r >= 0 && r <= 1) { throw PaintEditorError("relief \(jsText(r)) is out of range; use 0..1.") }
        lighting = normalizeLighting(azimuth: azimuth, elevation: elevation, relief: relief, lighting)
        return lighting
    }

    /// A layer's relief: where it is, its highest point (0..255); nil when it has none.
    public func reliefOf(_ layerId: String? = nil) throws -> (layerId: String, bounds: RasterRect?, maxHeight: Int)? {
        guard let id = layerId ?? doc.activeLayerId else { return nil }
        _ = try requireLayer(id)
        guard let ch = doc.thick?.get(id) else { return nil }
        let r = reliefInfo(ch)
        return (id, r.bounds, r.maxHeight)
    }

    /// Flattens a layer's thick paint (its colour stays; the relief and material go). One undo step.
    public func flattenRelief(_ layerId: String? = nil) throws -> JSONObject {
        if liveStroke != nil { throw PaintEditorError("A stroke is in progress; end or cancel it before flattening.") }
        let l = try paintTarget(layerId, "flatten")
        guard doc.thick?.get(l.id) != nil else { return ["layerId": .string(l.id), "flattened": false] }
        commit("Flatten relief", withPaintEvent(doc.with { $0.removingThick([l.id]) }, kind: "flatten", layerId: l.id))
        return ["layerId": .string(l.id), "flattened": true]
    }

    /// The layers with thick paint lit (each thick layer's pixels replaced by its lit tiles).
    func litLayers(_ layers: [PaintLayer], liveThick: (layerId: String, channels: ThickChannels)? = nil) -> [PaintLayer] {
        let thick = doc.thick
        if thick == nil && liveThick == nil { return layers }
        var ids = thick?.keys ?? []
        if let live = liveThick, !ids.contains(live.layerId) { ids.append(live.layerId) }
        var out = layers
        for id in ids {
            guard let ch = liveThick?.layerId == id ? liveThick!.channels : thick?.get(id), let l = findLayer(out, id)?.layer, l.isPixel else { continue }
            let cache = litCaches[id] ?? LitCache()
            litCaches[id] = cache
            let lit = cache.lit(l.pixelSurface, ch, lighting)
            if lit !== l.pixelSurface { out = mapLayer(out, id) { $0.withSurface(lit) } }
        }
        return out
    }

    /// Thick-paint channels and lighting as saved (`layerChannels`, `lighting`), and light spills (`lightSpill`).
    func thickJSON() -> JSONObject {
        var out = JSONObject()
        var channels = JSONObject()
        for (id, ch) in doc.thick ?? OrderedMap() where findLayer(doc.layers, id) != nil {
            if let saved = thickToJSON(ch) { channels[id] = saved }
        }
        if !channels.isEmpty { out["layerChannels"] = .object(channels) }
        var spills = JSONObject()
        for (id, s) in lightSpills.sorted(by: { $0.key < $1.key }) where findLayer(doc.layers, id) != nil { spills[id] = s.json }
        if !spills.isEmpty { out["lightSpill"] = .object(spills) }
        if lighting != DEFAULT_LIGHTING { out["lighting"] = lighting.json }
        return out
    }
}

extension PaintDocumentState {
    /// The document's thick paint without these layers.
    func removingThick(_ ids: [String]) {
        guard var t = thick, ids.contains(where: { t.has($0) }) else { return }
        for id in ids { _ = t.delete(id) }
        thick = t
    }
}

/// The handlers of the wet, thick and light tools.
func paintWetHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    var h: [String: PaintToolHandler] = [:]
    let stillWet = { JSONValue.bool(c.wet.isWet()) }
    h["get_wet_paint"] = { _ in .object(c.wetState()) }
    h["advance_wet_paint"] = { a in
        let x = try AdvanceWetPaintArguments(a)
        return .object(try c.advanceWet(steps: x.steps, seconds: x.seconds))
    }
    h["dry_paint"] = { a in
        let x = try DryPaintArguments(a)
        return .object(try c.dryPaint(layerId: x.layerId, rect: x.rect))
    }
    h["wet_paper"] = { a in
        let x = try WetPaperArguments(a)
        return .object(try c.wetPaper(layerId: x.layerId, rect: x.rect, amount: x.amount))
    }
    h["set_wet_settings"] = { a in
        let layerId = a["layerId"]?.stringValue
        let params = try c.setWetParams(layerId, a.without("layerId"))
        return ["layerId": layerId.map { .string($0) } ?? c.doc.activeLayerId.map { .string($0) } ?? .null, "params": params.json, "stillWet": stillWet()]
    }
    h["set_flow_map"] = { a in
        let layerId = a["layerId"]?.stringValue
        let flow = try c.setFlowMap(layerId, a.without("layerId"))
        return ["layerId": layerId.map { .string($0) } ?? c.doc.activeLayerId.map { .string($0) } ?? .null, "flow": flow.json, "stillWet": stillWet()]
    }
    h["set_canvas_tilt"] = { a in
        let x = try SetCanvasTiltArguments(a)
        return ["tilt": try c.setCanvasTilt(angle: x.angle, direction: x.direction).json, "stillWet": stillWet()]
    }
    h["pause_wet_paint"] = { a in
        let x = try PauseWetPaintArguments(a)
        c.setWetPaused(x.paused)
        if let s = x.speed { try c.setWetSpeed(s) }
        return ["paused": .bool(c.wet.paused), "speed": .number(c.wet.speed), "stillWet": stillWet()]
    }
    h["set_wet_engine"] = { a in
        let x = try SetWetEngineArguments(a)
        return ["engine": try c.setWetEngine(gpu: x.gpu.rawValue, minTiles: x.minTiles).json]
    }
    h["set_water_overlay"] = { a in
        let x = try SetWaterOverlayArguments(a)
        return ["visible": .bool(c.setWaterOverlay(x.visible)), "stillWet": stillWet()]
    }
    // Thick paint and light (`thick-tools.ts`).
    h["get_light"] = { a in .object(try c.lightOf(try GetLightArguments(a).layerId)) }
    h["set_light_spill"] = { a in
        let x = try SetLightSpillArguments(a)
        return try c.setLightSpill(x.layerId, radius: x.radius, strength: x.strength).json
    }
    h["clear_light"] = { a in .object(try c.clearLight(try ClearLightArguments(a).layerId)) }
    h["set_lighting"] = { a in
        let x = try SetLightingArguments(a)
        return try c.setLighting(azimuth: x.azimuth, elevation: x.elevation, relief: x.relief).json
    }
    h["get_relief"] = { a in
        let r = try c.reliefOf(try GetReliefArguments(a).layerId)
        return ["relief": r.map { ["layerId": .string($0.layerId), "bounds": rectJSON($0.bounds), "maxHeight": .number(Double($0.maxHeight))] } ?? .null, "lighting": c.lighting.json]
    }
    h["flatten_relief"] = { a in .object(try c.flattenRelief(try FlattenReliefArguments(a).layerId)) }
    h["set_instant_dry"] = { a in ["instantDry": .bool(c.setInstantDry(a["on"]?.boolValue ?? false))] }
    return h
}
