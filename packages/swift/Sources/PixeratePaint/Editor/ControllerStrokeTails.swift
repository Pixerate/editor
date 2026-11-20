import Foundation
import PixerateCore
import PixerateRaster

/**
 * Editable strokes on pixel layers (#902): the controller's side of `StrokeTails.swift` (the TS
 * controller's "Editable strokes on pixel layers" section).
 */
extension PaintEditorController {
    /// The logged strokes by id (the last of an id, as a `Map` built from the log keeps).
    private func loggedById(_ d: PaintDocumentState) -> [String: RecordedStroke] {
        var m: [String: RecordedStroke] = [:]
        m.reserveCapacity(d.strokes.count)
        for s in d.strokes { m[s.id] = s }
        return m
    }

    /**
     * A pixel layer's stroke tail when it still holds: the layer's pixels and light are what the tail
     * last drew (`top`, by identity), at offset 0, with no wet paint flowing on it and every stroke in the log.
     */
    func validTail(_ d: PaintDocumentState, _ layerId: String) -> StrokeTail? {
        guard let t = d.strokeTails?.get(layerId), let l = findLayer(d.layers, layerId)?.layer, l.isPixel,
              let surface = l.surface, surface === t.top, d.light?.get(layerId) === t.topLight,
              l.pixelOffset.x == 0, l.pixelOffset.y == 0 else { return nil }
        if d.liveStrokes?.get(layerId) != nil || d.stickers?.get(layerId)?.isEmpty == false || wet.wetLayerIds().contains(layerId) { return nil }
        let logged = loggedById(d)
        return t.ids.allSatisfy({ logged[$0]?.layerId == layerId }) ? t : nil
    }

    /// A tail's strokes from the log, bottom first.
    func tailStrokes(_ d: PaintDocumentState, _ tail: StrokeTail) -> [RecordedStroke] {
        let logged = loggedById(d)
        return tail.ids.compactMap { logged[$0] }
    }

    /**
     * Whether a stroke just painted on a pixel layer can be redrawn exactly from the pixels under it:
     * what a stroke layer takes (`liveStrokeRefusal`), and nothing else on the layer it could read or
     * write (relief, film, ferrofluid, fluorescent or thermochromic ink, stickers, cultures, wet paint,
     * live effect paint), on an unlocked layer at offset 0.
     */
    private func tailEligible(_ prev: PaintDocumentState, _ s: PaintStrokeSession, _ stroke: RecordedStroke) -> Bool {
        let id = s.layerId
        let i = s.initValues
        let brush = i.brush
        guard let l = findLayer(prev.layers, id)?.layer, l.isPixel else { return false }
        if liveStrokeRefusal(brush) != nil || brush.iridescence != nil || i.wet != nil || i.scraper != nil { return false }
        if l.pixelOffset.x != 0 || l.pixelOffset.y != 0 || isLayerLocked(l.locks, .pixels) || isLayerLocked(l.locks, .transparency) || tempLayerTargets[id] != nil { return false }
        if prev.liveStrokes?.get(id) != nil || prev.stickers?.get(id)?.isEmpty == false || prev.effectLayers?.get(id) != nil || prev.cultures?.get(id) != nil { return false }
        if prev.thick?.get(id) != nil || prev.ferro?.get(id) != nil || prev.fluor?.get(id) != nil || prev.thermo?.get(id) != nil || wet.wetLayerIds().contains(id) { return false }
        if s.thickChannels() != nil || s.ferroChannel != nil || s.fluorChannel != nil || s.thermoChannel != nil || s.sprayedStickers != nil { return false }
        return stroke.effect?.live != true
    }

    /**
     * `next` (the document after `stroke`, painted on `prev`) with the layer's stroke tail extended
     * by the stroke, started over the layer's pixels before it, or dropped when it can't be redrawn.
     */
    func withTailStroke(_ prev: PaintDocumentState, _ next: PaintDocumentState, _ s: PaintStrokeSession, _ stroke: RecordedStroke) -> PaintDocumentState {
        let id = s.layerId
        guard let after = findLayer(next.layers, id)?.layer, after.isPixel, next.liveStrokes?.get(id) == nil else { return next }
        if !tailEligible(prev, s, stroke) {
            guard next.strokeTails?.get(id) != nil else { return next }
            return next.with { o in
                var t = o.strokeTails!
                _ = t.delete(id)
                o.strokeTails = t.isEmpty ? nil : t
            }
        }
        guard let before = findLayer(prev.layers, id)?.layer else { return next }
        let top = after.pixelSurface, topLight = next.light?.get(id)
        let tail = validTail(prev, id).map { $0.with(ids: $0.ids + [stroke.id], top: top, topLight: topLight) }
            ?? StrokeTail(base: before.pixelSurface, baseLight: prev.light?.get(id), ids: [stroke.id], top: top, topLight: topLight)
        return next.with { o in
            var t = o.strokeTails ?? OrderedMap()
            t.set(id, tail)
            o.strokeTails = t
        }
    }

    /**
     * The document with a pixel layer's tail strokes set to `list` (an edit of the tail: changed,
     * reordered or fewer strokes), its pixels and light redrawn from the tail's base and the log
     * edited to match (`withTailLog`).
     */
    func withTailStrokes(_ d: PaintDocumentState, _ layer: PaintLayer, _ tail: StrokeTail, _ list: [RecordedStroke]) throws -> PaintDocumentState {
        if isLayerLocked(layer.locks, .pixels) { throw PaintEditorError("Layer \"\(layer.name)\" has its pixels locked; unlock it (update_layer locks) first.") }
        let current = findLayer(d.layers, layer.id)?.layer ?? layer
        let lit = tail.baseLight != nil || list.contains { $0.brush.light.amount > 0 }
        let drawn = try drawLiveStrokes(current, list, light: lit, base: (tail.base, tail.baseLight))
        var light = d.light ?? OrderedMap()
        if let l = drawn.light, !l.tiles.isEmpty { light.set(layer.id, l) } else { _ = light.delete(layer.id) }
        let keepLight = d.light != nil || drawn.light.map { !$0.tiles.isEmpty } == true
        let next = tail.with(ids: list.map(\.id), top: drawn.surface, topLight: keepLight ? light.get(layer.id) : nil)
        let log = withTailLog(d, tail.ids, list)
        return d.with { o in
            o.strokes = log.strokes
            o.wetEvents = log.wetEvents
            o.paintEvents = log.paintEvents
            o.layers = mapLayer(d.layers, layer.id) { $0.withSurface(drawn.surface) }
            if keepLight { o.light = light }
            var t = o.strokeTails ?? OrderedMap()
            t.set(layer.id, next)
            o.strokeTails = t
        }
    }

    /// A layer's new stroke list with its redrawn pixels: a pixel layer's tail, else a stroke layer's strokes (`commitLiveStrokes`).
    func withEditedStrokes(_ d: PaintDocumentState, _ layer: PaintLayer, _ list: [RecordedStroke]) throws -> PaintDocumentState {
        if d.liveStrokes?.get(layer.id) == nil, let tail = validTail(d, layer.id) { return try withTailStrokes(d, layer, tail, list) }
        return try withLiveStrokes(d, layer, list)
    }

    /**
     * The strokes of a layer that can be edited now (`updateStroke` and the rest), bottom first: a
     * stroke layer's strokes, or a pixel layer's strokes since it was last flattened (`[]` when there
     * are none). nil for a layer that holds no strokes (a sticker or vector layer, or no layer).
     */
    public func editableStrokes(_ layerId: String? = nil) -> [RecordedStroke]? {
        guard let id = layerId ?? doc.activeLayerId, let l = findLayer(doc.layers, id)?.layer, l.isPixel else { return nil }
        if doc.stickers?.get(id)?.isEmpty == false { return nil }
        if let live = doc.liveStrokes?.get(id) { return live }
        return validTail(doc, id).map { tailStrokes(doc, $0) } ?? []
    }

    /// Every stroke that can be edited now (`editableStrokes` of each layer), top layer's last.
    public func allEditableStrokes() -> [RecordedStroke] {
        flattenLayers(doc.layers).filter(\.isPixel).flatMap { editableStrokes($0.id) ?? [] }
    }

    /// An editable stroke by id, or nil when it can't be edited now.
    public func editableStroke(_ id: String) -> RecordedStroke? {
        guard let f = try? findLiveStroke(id) else { return nil }
        return f.strokes[f.index]
    }

    /// Whether a stroke (by id) can be edited now: on a stroke layer, or painted on a pixel layer since it was last flattened.
    public func isStrokeEditable(_ id: String) -> Bool { (try? findLiveStroke(id)) != nil }
}
