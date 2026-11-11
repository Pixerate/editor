import Foundation
import PixerateCore
import PixerateRaster

/**
 * Live stroke layers (`paint-editor/live-strokes.ts` and the controller's live stroke section): a
 * paint layer whose pixels are always drawn from its recorded strokes, so a stroke's brush,
 * colour, paint, seed and points can be changed after it is painted.
 */

/// Why a brush can't paint on a live stroke layer, or nil when it can.
func liveStrokeRefusal(_ brush: PaintBrush) -> String? {
    switch brush.engine {
    case "wet": return "The \(brush.name) brush paints wet media, which a stroke layer can't redraw (the paint depends on the simulation's history); paint it on a pixel layer (add_layer)."
    case "impasto": return "The \(brush.name) brush paints thick paint with relief, which a stroke layer doesn't keep; paint it on a pixel layer (add_layer)."
    case "sticker": return "The \(brush.name) brush sprays stickers, which are their own objects; spray them on an empty pixel layer (add_layer)."
    case "antimatter": return "The \(brush.name) brush detonates across every visible layer, which a stroke layer can't redraw; paint it on a pixel layer (add_layer)."
    case "eraser": return "Erasers don't paint on a stroke layer; delete strokes instead (remove_strokes), or rasterize the layer first (rasterize_stroke_layer)."
    case "scraper": return "The \(brush.name) brush scrapes down through pixel layers, so it can't paint on a stroke layer; rasterize the layer first (rasterize_stroke_layer) or scrape on a pixel layer."
    case "blender", "smudge", "vortex": return "The \(brush.name) brush moves the paint under it, so it can't be redrawn on its own; rasterize the layer first (rasterize_stroke_layer) or blend on a pixel layer."
    default: break
    }
    if brush.mutation != nil { return "The \(brush.name) brush paints mutation strokes (which fade when an agent reads them), so it can't paint on a stroke layer; paint on a pixel layer (add_layer), or set mutation to null (set_brush)." }
    if brush.light.amount > 0 { return "The \(brush.name) brush lays light, which a stroke layer doesn't redraw yet; paint light on a pixel layer (add_layer), or set light.amount to 0 (set_brush)." }
    if brush.fluorescence.amount > 0 { return "The \(brush.name) brush paints UV-fluorescent ink, which a stroke layer doesn't redraw yet; paint it on a pixel layer (add_layer), or set fluorescence.amount to 0 (set_brush)." }
    if brush.thermochromic.hotColor != nil { return "The \(brush.name) brush paints thermochromic ink, which a stroke layer doesn't redraw yet; paint it on a pixel layer (add_layer), or remove thermochromic (set_brush)." }
    if brush.ferro.amount > 0 { return "The \(brush.name) brush lays liquid ferrofluid, which a stroke layer doesn't redraw; paint ferrofluid on a pixel layer (add_layer), or set ferro.amount to 0 (set_brush)." }
    if brush.culture != nil { return "The \(brush.name) brush seeds a living mycelial culture (which grows into the layer's pixels), so it can't paint on a stroke layer; paint on a pixel layer (add_layer), or set culture to null (set_brush)." }
    if brush.behavior.pickup > 0 { return "The \(brush.name) brush picks up the paint under it (pickup \(jsText(brush.behavior.pickup))), so it can't be redrawn on its own; set behavior.pickup to 0 (set_brush) or paint on a pixel layer." }
    return nil
}

/// A stroke's extent in document pixels: its points and symmetry copies, padded by the brush.
func liveStrokeBounds(_ stroke: RecordedStroke) -> RasterRect {
    var x0 = Double.infinity, y0 = Double.infinity, x1 = -Double.infinity, y1 = -Double.infinity
    for m in [nil] + (stroke.copies ?? []).map(Optional.some) {
        for p in stroke.points {
            let q: (x: Double, y: Double) = m.map { applyAffine($0, p.x, p.y) } ?? (p.x, p.y)
            x0 = Swift.min(x0, q.x)
            y0 = Swift.min(y0, q.y)
            x1 = Swift.max(x1, q.x)
            y1 = Swift.max(y1, q.y)
        }
    }
    let particle = stroke.brush.engine == "particle" ? stroke.brush.particle : nil
    let wave = particle.map { Swift.max($0["waveAmplitude"]?.numberValue ?? 0, $0["kind"] == "fuzzy" ? 0.12 : 0) } ?? 0
    let pad = stroke.brush.tip.size * (particle != nil ? 2 + wave : 1) + 2
    return RasterRect(x: Int(JS.floor(x0 - pad)), y: Int(JS.floor(y0 - pad)), width: Int(JS.ceil(x1 - x0 + 2 * pad)), height: Int(JS.ceil(y1 - y0 + 2 * pad)))
}

extension PaintEditorController {
    private func pixelLayer(_ layerId: String?, _ what: String) throws -> PaintLayer {
        guard let id = layerId ?? doc.activeLayerId else { throw PaintEditorError("There is no active layer to \(what); pass layerId (list_layers).") }
        guard let l = getLayer(id) else { throw PaintEditorError("Unknown layer \"\(id)\". Call list_layers for the ids.") }
        if !l.isPixel { throw PaintEditorError("Layer \"\(l.name)\" is a group; \(what) a pixel layer inside it.") }
        return l
    }

    private func liveStrokeLayer(_ layerId: String?, _ what: String) throws -> (layer: PaintLayer, strokes: [RecordedStroke]) {
        let l = try pixelLayer(layerId, what)
        guard let strokes = doc.liveStrokes?.get(l.id) else { throw PaintEditorError("Layer \"\(l.name)\" is not a stroke layer; add one with add_layer {type: \"strokes\"} (or convert_to_stroke_layer on an empty layer), then paint on it.") }
        return (l, strokes)
    }

    /// Makes an empty pixel layer a live stroke layer (one undo step).
    public func convertToLiveStrokes(_ layerId: String?) throws -> PaintLayerInfo {
        let l = try paintTarget(layerId, "convert")
        if doc.liveStrokes?.get(l.id) != nil { return describeLayer(l) }
        if doc.stickers?.get(l.id)?.isEmpty == false { throw PaintEditorError("Layer \"\(l.name)\" is a sticker layer; add a stroke layer instead (add_layer {type: \"strokes\"}).") }
        if contentBounds(l.pixelSurface) != nil { throw PaintEditorError("Layer \"\(l.name)\" already has paint, which isn't kept as strokes; convert an empty layer or add a stroke layer (add_layer {type: \"strokes\"}).") }
        commit("Convert to stroke layer", doc.with { d in
            var live = d.liveStrokes ?? OrderedMap()
            live.set(l.id, [])
            d.liveStrokes = live
        })
        return describeLayer(getLayer(l.id)!)
    }

    /// The stroke layer holding a live stroke, and where.
    private func findLiveStroke(_ id: String) throws -> (layer: PaintLayer, strokes: [RecordedStroke], index: Int) {
        for (layerId, strokes) in doc.liveStrokes ?? OrderedMap() {
            if let index = strokes.firstIndex(where: { $0.id == id }), let layer = getLayer(layerId), layer.isPixel { return (layer, strokes, index) }
        }
        let baked = doc.strokes.contains { $0.id == id }
        throw PaintEditorError(baked
            ? "Stroke \"\(id)\" was painted on a pixel layer, so its pixels are baked; only strokes on a stroke layer can be edited (list_strokes {live: true}). Replay it onto a stroke layer (replay_strokes layerId) to edit the copy."
            : "Unknown stroke \"\(id)\". Call list_strokes {live: true} for the ids of editable strokes.")
    }

    /// Changes a live stroke's brush, colour, paint or seed, and redraws its layer (one undo step).
    public func updateStroke(_ id: String, brushId: String?, brushChanges: JSONObject?, color: String?, paint: JSONValue?, seed: Double?) throws -> (stroke: RecordedStroke, bounds: RasterRect) {
        let (layer, strokes, index) = try findLiveStroke(id)
        let was = strokes[index]
        var brush = was.brush
        if let brushId {
            let b = try requireEntry(brushId).brush
            brush = normalizePaintBrush(["tip": .object(b.tip.json.objectValue!.merging(["size": .number(was.brush.tip.size)]))], b)
        }
        if let changes = brushChanges {
            var raw = changes
            raw["id"] = .string(brush.id)
            brush = normalizePaintBrush(raw, brush)
        }
        if let why = liveStrokeRefusal(brush) { throw PaintEditorError(why) }
        var next = was
        next.key = newStrokeKey()
        brush.builtin = nil
        next.brush = brush
        if let seed {
            if !(seed.rounded() == seed && seed >= 0) { throw PaintEditorError("seed \(jsText(seed)) must be a whole number of 0 or more.") }
            next.seed = Int(seed)
        }
        if let color {
            next.color = try parseColor(.string(color))
            next.paint = nil
            next.effect = nil
        }
        if let paint {
            if paint == .null {
                next.paint = nil
                next.effect = nil
            } else if isPaintEffectPaint(paint) {
                guard var e = readPaintEffectPaint(paint) else { throw PaintEditorError("The effect \"\(paint.objectValue?["effect"]?.stringValue ?? "")\" is not rendered yet; render it first (prepareEffectPaints; the update_stroke tool does this).") }
                e = strokeEffectWithPath(e, next.points)
                guard (effectPaintImage(e) ?? renderEffectPaintSync(e)) != nil else { throw PaintEditorError("The effect \"\(paint.objectValue?["effect"]?.stringValue ?? "")\" is not rendered yet; render it first (prepareEffectPaints; the update_stroke tool does this).") }
                next.paint = nil
                next.effect = e
            } else {
                next.effect = nil
                switch try readStrokePaintPublic(paint) {
                case .color(let c):
                    next.color = c
                    next.paint = nil
                case .gradient(let g): next.paint = g
                }
            }
        }
        // A Mixer Brush replays from its load: give it one that follows the stroke's own colour.
        let load = brushLoadForStroke(brush, EMPTY_MIXER_LOAD, hexToRgb8(next.color).map { Double($0) / 255 })
        next.load = load.reservoir != nil || load.pickup != nil ? load : nil
        let list = strokes.enumerated().map { $0.offset == index ? next : $0.element }
        let area0 = strokeArea(was)
        commit("Edit stroke", try withLiveStrokes(doc, layer, list))
        return (next, unionRectOpt(area0, strokeArea(next)) ?? RasterRect(x: 0, y: 0, width: 0, height: 0))
    }

    /// Replaces a live stroke's points, or moves, scales, rotates or flips them, and redraws its layer.
    public func editStrokePoints(_ id: String, points: [PenPoint]?, transform: JSONObject?) throws -> (stroke: RecordedStroke, bounds: RasterRect) {
        if (points == nil) == (transform == nil) { throw PaintEditorError("Pass either points (the new pen samples) or transform (dx, dy, scale, rotate, flipX), not both.") }
        let (layer, strokes, index) = try findLiveStroke(id)
        let was = strokes[index]
        var next: RecordedStroke
        if let points {
            next = was
            next.key = newStrokeKey()
            next.points = try checkPoints(points)
            if let e = was.effect, e.map?.by == "path" {
                next.effect = strokeEffectWithPath(e, next.points)
            }
        } else {
            let t = transform!
            if let s = t["scale"]?.numberValue, !(s > 0 && s <= 20) { throw PaintEditorError("scale \(jsText(s)) is out of range; use above 0 up to 20.") }
            let b = strokeBounds(was.points)
            let o = t["origin"]?.objectValue
            let v = ReplayOptions(strokeIds: [], dx: t["dx"]?.numberValue, dy: t["dy"]?.numberValue, scale: t["scale"]?.numberValue, rotate: t["rotate"]?.numberValue, flipX: t["flipX"]?.boolValue)
            let m = variationAffine(v, o.map { ($0["x"]?.numberValue ?? 0, $0["y"]?.numberValue ?? 0) } ?? (b.x + b.width / 2, b.y + b.height / 2))
            next = varyStroke(was, m)
            next.stencils = was.stencils
        }
        let list = strokes.enumerated().map { $0.offset == index ? next : $0.element }
        let area0 = strokeArea(was)
        commit("Edit stroke points", try withLiveStrokes(doc, layer, list))
        return (next, unionRectOpt(area0, strokeArea(next)) ?? RasterRect(x: 0, y: 0, width: 0, height: 0))
    }

    /// Deletes live strokes (one undo step).
    public func removeStrokes(_ ids: [String]) throws -> JSONObject {
        if ids.isEmpty { throw PaintEditorError("Pass at least one stroke id (list_strokes {live: true}).") }
        let found = try ids.map { try findLiveStroke($0) }
        var d = doc
        var bounds: RasterRect? = nil
        var layers: [(String, PaintLayer)] = []
        for f in found where !layers.contains(where: { $0.0 == f.layer.id }) { layers.append((f.layer.id, f.layer)) }
        for (layerId, layer) in layers {
            let current = d.liveStrokes?.get(layerId) ?? []
            for x in current where ids.contains(x.id) { bounds = unionRectOpt(bounds, strokeArea(x)) }
            d = try withLiveStrokes(d, layer, current.filter { !ids.contains($0.id) })
        }
        commit(ids.count == 1 ? "Remove stroke" : "Remove strokes", d)
        return ["removed": .array(ids.map { .string($0) }), "bounds": rectJSON(bounds)]
    }

    /// Moves a live stroke to `index` in its layer (0 = bottom) and redraws (one undo step).
    public func reorderStroke(_ id: String, _ index: Int) throws -> [String] {
        let (layer, strokes, from) = try findLiveStroke(id)
        if index < 0 || index >= strokes.count { throw PaintEditorError("index \(index) is out of range; the layer has \(strokes.count) strokes, so use 0..\(strokes.count - 1) (0 = bottom).") }
        var list = strokes
        let moved = list.remove(at: from)
        list.insert(moved, at: index)
        if from != index { commit("Reorder stroke", try withLiveStrokes(doc, layer, list)) }
        return list.map(\.id)
    }

    /// Turns a stroke layer into a plain pixel layer with the same pixels (one undo step).
    public func rasterizeLiveStrokes(_ layerId: String?) throws -> PaintLayerInfo {
        let (layer, _) = try liveStrokeLayer(layerId, "rasterize")
        commit("Rasterize stroke layer", withPaintEvent(doc.with { d in
            var live = d.liveStrokes!
            _ = live.delete(layer.id)
            d.liveStrokes = live.isEmpty ? nil : live
        }, kind: "live-strokes", layerId: layer.id, data: ["rasterized": true]))
        return describeLayer(getLayer(layer.id)!)
    }

    /// The top-most stroke of a stroke layer that painted the pixel at (x, y), or nil.
    public func liveStrokeAt(_ layerId: String?, _ x: Double, _ y: Double) throws -> RecordedStroke? {
        let (layer, strokes) = try liveStrokeLayer(layerId, "pick a stroke on")
        let plain = layer.copy(visible: true, locks: .some(nil)).withSurface(layer.pixelSurface, offset: LayerOffset(x: 0, y: 0))
        let base = doc.with { $0.liveStrokes = nil }
        let px = Int(JS.floor(x)), py = Int(JS.floor(y))
        for i in stride(from: strokes.count - 1, through: 0, by: -1) {
            guard let area = strokeArea(strokes[i]), px >= area.x, py >= area.y, px < area.x + area.width, py < area.y + area.height else { continue }
            let drawn = try drawLiveStroke(base, plain, emptySurface(4), strokes[i]).surface
            if readPixel(drawn, px, py)[3] > 24 { return strokes[i] }
        }
        return nil
    }

    /// Where a stroke painted: as learnt when it was painted or drawn, else an estimate from its points and brush.
    func strokeArea(_ s: RecordedStroke) -> RasterRect? {
        if let known = paintedBounds[s.key] { return known }
        return liveStrokeBounds(s)
    }

    func liveStrokeById(_ id: String) -> RecordedStroke? {
        for (_, strokes) in doc.liveStrokes ?? OrderedMap() {
            if let s = strokes.first(where: { $0.id == id }) { return s }
        }
        return nil
    }

    /// The path-mapped paint a point edit of a stroke will paint with, or nil.
    private func editStrokePointsEffect(_ id: String, points: [PenPoint]?, transform: JSONObject?) -> PaintEffectPaint? {
        guard let stroke = liveStrokeById(id), let e = stroke.effect, e.map?.by == "path" else { return nil }
        if let points, !points.isEmpty { return strokeEffectWithPath(e, points) }
        guard let t = transform else { return nil }
        let b = strokeBounds(stroke.points)
        let o = t["origin"]?.objectValue
        let origin: (Double, Double) = o.map { ($0["x"]?.numberValue ?? 0, $0["y"]?.numberValue ?? 0) } ?? (b.x + b.width / 2, b.y + b.height / 2)
        let v = ReplayOptions(strokeIds: [], dx: t["dx"]?.numberValue, dy: t["dy"]?.numberValue, scale: t["scale"]?.numberValue, rotate: t["rotate"]?.numberValue, flipX: t["flipX"]?.boolValue)
        return varyStroke(stroke, variationAffine(v, origin)).effect
    }

    /// Renders a path-mapped stroke's new path, which `editStrokePoints` needs (it is synchronous).
    public func prepareEditStrokePointsEffect(_ id: String, points: [PenPoint]?, transform: JSONObject?) async throws {
        if let p = editStrokePointsEffect(id, points: points, transform: transform) { try await prepareEffectPaints([p]) }
    }

    /// Whether `prepareEditStrokePointsEffect` has to be awaited before this edit can run.
    public func strokeEditNeedsRender(_ id: String, points: [PenPoint]?, transform: JSONObject?) -> Bool {
        guard let p = editStrokePointsEffect(id, points: points, transform: transform) else { return false }
        return (effectPaintImage(p) ?? renderEffectPaintSync(p)) == nil
    }

    private func withLiveStrokes(_ d: PaintDocumentState, _ layer: PaintLayer, _ list: [RecordedStroke]) throws -> PaintDocumentState {
        if isLayerLocked(layer.locks, .pixels) { throw PaintEditorError("Layer \"\(layer.name)\" has its pixels locked; unlock it (update_layer locks) first.") }
        let current = findLayer(d.layers, layer.id)?.layer ?? layer
        let drawn = try drawLiveStrokes(current, list)
        let next = d.with { o in
            o.layers = mapLayer(d.layers, layer.id) { $0.withSurface(drawn.surface, offset: LayerOffset(x: 0, y: 0)) }
            var live = o.liveStrokes ?? OrderedMap()
            live.set(layer.id, list)
            o.liveStrokes = live
            let prev = o.thick?.get(layer.id) ?? emptyThickChannels()
            let ch = ThickChannels(height: prev.height, material: prev.material, film: drawn.film)
            if hasThickChannels(ch) {
                var t = o.thick ?? OrderedMap()
                t.set(layer.id, ch)
                o.thick = t
            } else if !prev.film.tiles.isEmpty {
                o.removingThick([layer.id])
            }
        }
        return withPaintEvent(next, kind: "live-strokes", layerId: layer.id, data: ["strokes": .array(list.map(recordedStrokeJSON))], strokes: list)
    }

    /// Sets a stroke layer's strokes (a replay's `live-strokes` event); `nil` rasterizes it.
    func replaceLiveStrokes(_ layerId: String, _ strokes: [RecordedStroke]?) throws {
        let l = try pixelLayer(layerId, "set the strokes of")
        guard let strokes else {
            commit("Rasterize stroke layer", doc.with { d in
                var live = d.liveStrokes ?? OrderedMap()
                _ = live.delete(l.id)
                d.liveStrokes = live.isEmpty ? nil : live
            })
            return
        }
        commit("Strokes", try withLiveStrokes(doc, l, strokes.map { var s = $0; s.layerId = l.id; return s }))
    }

    /// Draws one stroke onto `surface` of a plain copy of the layer; returns the result and the area it painted.
    private func drawLiveStroke(_ d: PaintDocumentState, _ plain: PaintLayer, _ surface: TiledSurface, _ st: RecordedStroke, _ film: TiledSurface = emptySurface(4, 0)) throws -> (surface: TiledSurface, film: TiledSurface, bounds: RasterRect?) {
        var i = PaintStrokeInit(layerId: plain.id, color: st.color, seed: st.seed, copies: st.copies ?? [], load: st.load)
        i.fixedBrush = st.brush
        // At a moment of live effects (`liveEffectAt`), a live stroke paints that frame of its effect.
        if let at = liveEffectAt, let e = st.effect, e.live { i.paint = liveEffectFrame(e, at).json } else { i.paint = st.effect?.json ?? st.paint?.json }
        i.snapToPerspective = false
        i.stencils = false
        i.maskStencils = st.stencils ?? []
        let baseDoc = d.with { o in
            o.layers = mapLayer(d.layers, plain.id) { _ in plain.withSurface(surface) }
            if !film.tiles.isEmpty || st.brush.iridescence != nil {
                var t = o.thick ?? OrderedMap()
                let prev = t.get(plain.id) ?? emptyThickChannels()
                t.set(plain.id, ThickChannels(height: prev.height, material: prev.material, film: film))
                o.thick = t
            }
        }
        let session = try sessionFor(baseDoc, i)
        try session.push(st.points)
        let result = try session.end()
        // Only ever grown.
        let had = paintedBounds[st.key] ?? nil
        paintedBounds[st.key] = .some(had != nil && result.bounds != nil ? unionRect(had!, result.bounds!) : (result.bounds ?? had))
        return (session.surfaceAfter ?? surface, session.filmChannel() ?? film, result.bounds)
    }

    /// A stroke layer's pixels drawn from its strokes, bottom first (every stroke drawn again).
    func drawLiveStrokes(_ layer: PaintLayer, _ list: [RecordedStroke]) throws -> (surface: TiledSurface, film: TiledSurface) {
        let plain = layer.copy(visible: true, locks: .some(nil)).withSurface(layer.pixelSurface, offset: LayerOffset(x: 0, y: 0))
        let base = doc.with { $0.liveStrokes = nil }
        var surface = emptySurface(4)
        var film = emptySurface(4, 0)
        for st in list {
            let r = try drawLiveStroke(base, plain, surface, st, film)
            surface = r.surface
            film = r.film
        }
        return (surface, film)
    }
}

/// A stroke as tools return it: its points (or how many), bounds and whether it is live (editable).
func strokeSummary(_ s: RecordedStroke, withPoints: Bool, live: Bool) -> JSONValue {
    let xs = s.points.map(\.x), ys = s.points.map(\.y)
    let pad = s.brush.tip.size / 2
    let minX = xs.min() ?? .nan, maxX = xs.max() ?? .nan, minY = ys.min() ?? .nan, maxY = ys.max() ?? .nan
    return [
        "id": .string(s.id), "layerId": .string(s.layerId), "brushId": .string(s.brush.id), "brushName": .string(s.brush.name), "color": .string(s.color),
        "points": withPoints ? .array(s.points.map(\.json)) : .number(Double(s.points.count)),
        "seed": .number(Double(s.seed)), "copies": .number(Double(s.copies?.count ?? 0)), "live": .bool(live),
        "bounds": ["x": .number(JS.floor(minX - pad)), "y": .number(JS.floor(minY - pad)), "width": .number(JS.ceil(maxX - minX + 2 * pad)), "height": .number(JS.ceil(maxY - minY + 2 * pad))],
    ]
}

/// The handlers of the stroke tools this port implements.
func paintStrokeHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    var h: [String: PaintToolHandler] = [:]
    h["get_live_stroke"] = { _ in ["live": false] }
    h["list_strokes"] = { a in
        let layerId = a["layerId"]?.stringValue
        if let layerId, c.getLayer(layerId) == nil { throw PaintEditorError("Unknown layer \"\(layerId)\". Call list_layers for the ids.") }
        let liveAll = (c.doc.liveStrokes ?? OrderedMap()).values.flatMap { $0 }
        let liveKeys = Set(liveAll.map(\.key))
        let live = a["live"] == .bool(true)
        var all = live ? liveAll : c.doc.strokes
        if let layerId { all = all.filter { $0.layerId == layerId } }
        let ids = a["ids"]?.arrayValue?.compactMap(\.stringValue)
        let picked = ids.map { ids in all.filter { ids.contains($0.id) } } ?? Array(all.suffix(Int(a["last"]?.numberValue ?? 100)))
        if let ids { for id in ids where !all.contains(where: { $0.id == id }) { throw PaintEditorError("Unknown stroke \"\(id)\". Call list_strokes without ids for the ids.") } }
        return ["total": .number(Double(all.count)), "strokes": .array(picked.map { strokeSummary($0, withPoints: ids != nil, live: live ? true : liveKeys.contains($0.key)) })]
    }
    h["stroke_at"] = { a in
        let s = try c.liveStrokeAt(a["layerId"]?.stringValue, a["x"]?.numberValue ?? .nan, a["y"]?.numberValue ?? .nan)
        return ["stroke": s.map { strokeSummary($0, withPoints: false, live: true) } ?? .null]
    }
    h["update_stroke"] = { a in
        let id = a["id"]?.stringValue ?? ""
        let update = a.without("id")
        if update.isEmpty { throw PaintEditorError("Pass at least one change: brushId, brush, color, paint or seed.") }
        var changes: JSONObject? = nil
        if let patch = update["brush"]?.objectValue {
            guard let stroke = c.liveStrokeById(id) else { throw PaintEditorError("Unknown stroke \"\(id)\" on a stroke layer. Call list_strokes {live: true} for the ids.") }
            if let bid = update["brushId"]?.stringValue { changes = try c.brushChanges(patch, from: bid) } else { changes = try c.brushChanges(patch, fromBrush: stroke.brush) }
        }
        if let paint = update["paint"], isPaintEffectPaint(paint), var e = readPaintEffectPaint(paint) {
            if let stroke = c.liveStrokeById(id) { e = c.strokeEffectWithPath(e, stroke.points) }
            try await c.prepareEffectPaints([e])
        }
        let r = try c.updateStroke(id, brushId: update["brushId"]?.stringValue, brushChanges: changes, color: update["color"]?.stringValue, paint: update["paint"], seed: update["seed"]?.numberValue)
        return ["stroke": strokeSummary(r.stroke, withPoints: false, live: true), "bounds": r.bounds.json]
    }
    h["edit_stroke_points"] = { a in
        let id = a["id"]?.stringValue ?? ""
        let points = a["points"]?.arrayValue?.compactMap(PenPoint.init(json:))
        let transform = a["transform"]?.objectValue
        try await c.prepareEditStrokePointsEffect(id, points: points, transform: transform)
        let r = try c.editStrokePoints(id, points: points, transform: transform)
        return ["stroke": strokeSummary(r.stroke, withPoints: true, live: true), "bounds": r.bounds.json]
    }
    h["reorder_stroke"] = { a in ["order": .array(try c.reorderStroke(a["id"]?.stringValue ?? "", Int(a["index"]?.numberValue ?? 0)).map { .string($0) })] }
    h["remove_strokes"] = { a in .object(try c.removeStrokes(a["ids"]?.arrayValue?.compactMap(\.stringValue) ?? [])) }
    h["convert_to_stroke_layer"] = { a in try c.convertToLiveStrokes(a["layerId"]?.stringValue).json }
    h["rasterize_stroke_layer"] = { a in try c.rasterizeLiveStrokes(a["layerId"]?.stringValue).json }
    return h
}
