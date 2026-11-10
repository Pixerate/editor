import Foundation
import PixerateCore
import PixerateRaster

/// The most stickers one `addStickers` call places.
private let MAX_ADD_STICKERS = 500

/**
 * Sticker layers (the controller's sticker section): stickers placed exactly or sprayed by sticker
 * brushes stay editable objects; the layer's pixels are drawn from its list, and every change is
 * one undo step that redraws only the tiles it touches. Only the editor's own stickers are drawn.
 */
extension PaintEditorController {
    /// The sticker library: the editor's own stamps by default, or the provider set via `setStickersProvider`.
    public var stickerLibrary: EditorStickers { editorStickerLibrary }

    /// The active sticker provider (`editorStickers()` unless set via `setStickersProvider`).
    public var stickersProvider: any StickerProvider { stickers.provider }

    /// Sets the sticker library (`nil` goes back to the editor's own stamps); loaded art is forgotten.
    public func setStickersProvider(_ provider: (any StickerProvider)?) {
        stickers.set(provider)
        stickerArt.clear()
        emit([])
    }

    /// Loads and rasterises the art of `refs` (provider stickers; editor stamps need none) so sprays and placements can draw them.
    public func prepareStickers(_ refs: [String]) throws {
        var unique: [String] = []
        for r in refs {
            let norm = try readStickerRef(r)
            if editorStampOf(norm) == nil && !unique.contains(norm) { unique.append(norm) }
        }
        defer { if !unique.isEmpty { emit([]) } }
        do {
            for r in unique {
                _ = try stickerArt.ensure(stickers.provider, r, rasterize: rasterizeSticker, dark: colorScheme == "dark")
            }
        } catch let e as StickerError {
            throw PaintEditorError(e.message)
        } catch {
            throw PaintEditorError(error.localizedDescription)
        }
    }

    /// Whether a sticker's art is ready to draw in the variant the colour scheme picks: `ready`, `failed` (with why) or `none`.
    public func stickerArtStatus(_ ref: String) throws -> (status: String, error: String?) {
        let r = try readStickerRef(ref)
        return stickerArt.status(r, stickerArt.variantFor(r, dark: colorScheme == "dark"))
    }

    func readStickerRef(_ ref: String) throws -> String {
        do {
            let p = try parseStickerRefStrict(ref)
            return "\(p.provider):\(p.id)"
        } catch let e as StickerError {
            throw PaintEditorError(e.message)
        }
    }

    func withStickerVariant(_ s: Sticker) -> Sticker {
        var out = s
        let v = editorStampOf(s.ref) != nil ? "light" : stickerArt.variantFor(s.ref, dark: colorScheme == "dark")
        out.variant = v == "dark" ? "dark" : nil
        return out
    }

    /// The next free sticker number (ids `st<n>` are unique across the document).
    func nextStickerNumber(_ d: PaintDocumentState? = nil) -> Int {
        var n = 0
        for (_, list) in (d ?? doc).stickers ?? OrderedMap() {
            for st in list {
                if st.id.hasPrefix("st"), let k = Int(st.id.dropFirst(2)), st.id.dropFirst(2).allSatisfy(\.isNumber) { n = Swift.max(n, k) }
            }
        }
        return n + 1
    }

    private func pixelLayerFor(_ layerId: String?, _ what: String) throws -> PaintLayer {
        guard let id = layerId ?? doc.activeLayerId else { throw PaintEditorError("There is no active layer to \(what); pass layerId (list_layers).") }
        let l = try requireLayer(id)
        if !l.isPixel { throw PaintEditorError("Layer \"\(l.name)\" is a group; \(what) a pixel layer inside it.") }
        return l
    }

    private func stickerLayer(_ layerId: String?) throws -> (layer: PaintLayer, stickers: [Sticker]) {
        let l = try pixelLayerFor(layerId, "edit the stickers of")
        guard let stickers = doc.stickers?.get(l.id) else { throw PaintEditorError("Layer \"\(l.name)\" has no stickers; spray some with a sticker brush (sticker-stars; list_brush_presets lists them).") }
        return (l, stickers)
    }

    /// A layer's stickers, bottom first.
    public func listStickers(_ layerId: String? = nil) throws -> [Sticker] {
        guard let id = layerId ?? doc.activeLayerId else { return [] }
        _ = try requireLayer(id)
        return doc.stickers?.get(id) ?? []
    }

    /// The top-most sticker under a point (document pixels), or nil.
    public func stickerAt(_ layerId: String?, _ x: Double, _ y: Double) throws -> Sticker? {
        if !x.isFinite || !y.isFinite { throw PaintEditorError("x and y must be numbers of document pixels.") }
        guard let id = layerId ?? doc.activeLayerId else { return nil }
        _ = try requireLayer(id)
        return PixeratePaint.stickerAt(doc.stickers?.get(id) ?? [], x, y, stickerArt.get)
    }

    /// Refuses to redraw stickers whose art has not loaded yet, naming them.
    private func requireStickerArt(_ list: [Sticker]) throws {
        var missing: [String] = []
        for s in list where stickerStamp(s) == nil && stickerArt.get(s.ref, s.variant) == nil {
            if !missing.contains(s.ref) { missing.append(s.ref) }
        }
        if !missing.isEmpty {
            for s in list where stickerStamp(s) == nil && stickerArt.get(s.ref, s.variant) == nil {
                _ = try? stickerArt.ensure(stickers.provider, s.ref, rasterize: rasterizeSticker, dark: s.variant == "dark")
                if colorScheme == "dark" {
                    _ = try? stickerArt.ensure(stickers.provider, s.ref, rasterize: rasterizeSticker, dark: true)
                }
            }
            throw PaintEditorError("The art for \(missing.map { "\"\($0)\"" }.joined(separator: ", ")) has not loaded yet; it is loading now (prepareStickers), so try again when it has.")
        }
    }

    /// Replaces a layer's stickers and redraws its pixels (one undo step); with `dirty`, only the tiles under those rects.
    private func commitStickers(_ label: String, _ layer: PaintLayer, _ stickers: [Sticker], dirty: [RasterRect]? = nil) throws {
        if isLayerLocked(layer.locks, .pixels) { throw PaintEditorError("Layer \"\(layer.name)\" has its pixels locked; unlock it first.") }
        try requireStickerArt(stickers)
        let partial = dirty != nil && layer.pixelOffset.x == 0 && layer.pixelOffset.y == 0
        let surface = partial ? stickerSurface(stickers, base: layer.pixelSurface, dirty: dirty, art: stickerArt.get) : stickerSurface(stickers, art: stickerArt.get)
        let next = doc.with { o in
            o.layers = mapLayer(doc.layers, layer.id) { $0.withSurface(surface, offset: LayerOffset(x: 0, y: 0)) }
            var t = o.stickers ?? OrderedMap()
            t.set(layer.id, stickers)
            o.stickers = t
        }
        commit(label, withPaintEvent(next, kind: "stickers", layerId: layer.id, data: ["stickers": .array(stickers.map { .object($0.json) })]))
    }

    private func readStickerUpdate(_ u: JSONObject) throws -> JSONObject { try normalizeStickerUpdate(u) }

    /// Moves, turns, resizes, recolours or restamps one sticker (one undo step). Returns it.
    public func updateSticker(_ layerId: String?, _ id: String, _ update: JSONObject) throws -> Sticker {
        let (layer, stickers) = try stickerLayer(layerId)
        guard let i = stickers.firstIndex(where: { $0.id == id }) else { throw PaintEditorError("Layer \"\(layer.name)\" has no sticker \"\(id)\". Call list_stickers for the ids.") }
        let u = try readStickerUpdate(update)
        let applied = stickers[i].applying(u)
        let next = u["ref"] != nil ? withStickerVariant(applied) : applied
        try commitStickers("Edit sticker", layer, stickers.enumerated().map { $0.offset == i ? next : $0.element }, dirty: [stickerRect(stickers[i]), stickerRect(next)])
        return next
    }

    /// Places stickers exactly (one undo step), on top of a sticker layer or onto an empty layer. Returns the new stickers.
    public func addStickers(_ layerId: String?, _ input: [JSONObject]) throws -> [Sticker] {
        let layer = try pixelLayerFor(layerId, "add stickers to")
        if input.isEmpty { throw PaintEditorError("Pass at least one sticker (ref, x, y).") }
        if input.count > MAX_ADD_STICKERS { throw PaintEditorError("At most \(MAX_ADD_STICKERS) stickers per call; split them over several calls.") }
        let existing = doc.stickers?.get(layer.id) ?? []
        if existing.isEmpty && contentBounds(layer.pixelSurface) != nil { throw PaintEditorError("Layer \"\(layer.name)\" already has paint; add stickers to an empty layer (add_layer) or a sticker layer so they stay editable.") }
        var n = nextStickerNumber()
        let added: [Sticker] = try input.enumerated().map { i, raw in
            if raw["ref"] == nil && raw["stamp"] == nil { throw PaintEditorError("Sticker \(i) needs ref (a sticker ref from find_stickers, e.g. \"editor:star\").") }
            for k in ["x", "y"] where raw[k] == nil { throw PaintEditorError("Sticker \(i) needs \(k).") }
            let u: JSONObject
            do { u = try readStickerUpdate(raw.without("seed")) } catch let e as PaintEditorError { throw PaintEditorError("Sticker \(i): \(e.message)") }
            if let sd = raw["seed"]?.numberValue, sd.rounded() != sd { throw PaintEditorError("Sticker \(i): seed must be a whole number.") }
            let id = n
            n += 1
            let seed = raw["seed"]?.numberValue.map { Int($0) } ?? Int(PixerateRandom.mix32(UInt32(truncatingIfNeeded: id &* 0x9E37_79B1)) & 0x7FFF_FFFF)
            let base = Sticker(id: "st\(id)", ref: "", stamp: nil, x: 0, y: 0, size: 48, rotation: 0, color: color, opacity: 1, seed: seed)
            return withStickerVariant(base.applying(u))
        }
        try commitStickers("Add stickers", layer, existing + added, dirty: existing.isEmpty ? nil : added.map(stickerRect))
        return added
    }

    /// Brings stickers to the top (`front`) or bottom of their layer (one undo step). Returns the new order.
    public func arrangeStickers(_ layerId: String?, _ ids: [String], _ to: String) throws -> [String] {
        let (layer, stickers) = try stickerLayer(layerId)
        for id in ids where !stickers.contains(where: { $0.id == id }) { throw PaintEditorError("Layer \"\(layer.name)\" has no sticker \"\(id)\". Call list_stickers for the ids.") }
        let picked = stickers.filter { ids.contains($0.id) }
        let rest = stickers.filter { !ids.contains($0.id) }
        let next = to == "front" ? rest + picked : picked + rest
        try commitStickers("Arrange stickers", layer, next, dirty: picked.map(stickerRect))
        return next.map(\.id)
    }

    /// Deletes stickers (`ids`, or all on the layer) (one undo step). Returns the ids removed.
    public func removeStickers(_ layerId: String?, _ ids: [String]?) throws -> [String] {
        let (layer, stickers) = try stickerLayer(layerId)
        if let ids { for id in ids where !stickers.contains(where: { $0.id == id }) { throw PaintEditorError("Layer \"\(layer.name)\" has no sticker \"\(id)\". Call list_stickers for the ids.") } }
        let removed = ids ?? stickers.map(\.id)
        try commitStickers("Remove stickers", layer, stickers.filter { !removed.contains($0.id) }, dirty: ids != nil ? stickers.filter { removed.contains($0.id) }.map(stickerRect) : nil)
        return removed
    }

    /// Sets a layer's stickers (replays).
    func replaceStickers(_ layerId: String, _ stickers: [Sticker]) throws {
        let l = try pixelLayerFor(layerId, "set the stickers of")
        try commitStickers("Stickers", l, stickers)
    }

    /// The document extension entry of sticker layers (`stickers`).
    func stickersJSON(_ d: PaintDocumentState) -> JSONObject {
        var o = JSONObject()
        for (id, list) in d.stickers ?? OrderedMap() where !list.isEmpty && findLayer(d.layers, id) != nil { o[id] = .array(list.map { .object($0.json) }) }
        return o.isEmpty ? [:] : ["stickers": .object(o)]
    }
}

/// The sticker tools of the paint editor (`sticker-tools.ts`, `stickers/tools.ts`).
func paintStickerHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    var h: [String: PaintToolHandler] = [:]
    func agentSummary(_ p: any StickerProvider, _ s: JSONObject) -> JSONValue {
        var o: JSONObject = ["ref": .string(stickerRefOf(p, s["id"]?.stringValue ?? ""))]
        for (k, v) in s where k != "id" && k != "thumbnail" { o[k] = v }
        return .object(o)
    }
    h["find_stickers"] = { a in
        let p = c.stickersProvider
        let categories = try p.categories()
        if let cat = a["category"]?.stringValue, let categories, !categories.contains(where: { $0.id == cat }) {
            throw StickerError("invalid_argument", "No category \"\(cat)\" in \"\(p.name)\"; categories: \(categories.map(\.id).joined(separator: ", ")).")
        }
        let collections = try p.collections()
        if let col = a["collection"]?.stringValue {
            guard let collections, !collections.isEmpty else {
                throw StickerError("invalid_argument", "\"\(p.name)\" has no collections; leave collection out.")
            }
            if !collections.contains(where: { $0.id == col }) {
                throw StickerError("invalid_argument", "No collection \"\(col)\" in \"\(p.name)\"; collections: \(collections.map(\.id).joined(separator: ", ")).")
            }
        }
        let opts = StickerSearchOptions(
            category: a["category"]?.stringValue,
            collection: a["collection"]?.stringValue,
            tags: a["tags"]?.arrayValue?.compactMap(\.stringValue),
            limit: a["limit"]?.numberValue.map { Int($0) },
            after: a["after"]?.stringValue,
            commercial: a["commercial"]?.boolValue == true ? true : nil
        )
        let q = (a["query"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !q.isEmpty && !p.capabilities.supportsSearch {
            throw StickerError("invalid_argument", "\"\(p.name)\" can't search; leave query out and filter by category instead.")
        }
        let page = try q.isEmpty ? p.list(opts) : p.search(q, opts)
        var o: JSONObject = [
            "provider": .string(p.id),
            "items": .array(page.items.map { agentSummary(p, $0.json) }),
            "total": .number(Double(page.total)),
        ]
        if let next = page.next { o["next"] = .string(next) }
        if let categories {
            o["categories"] = .array(categories.map { ["id": .string($0.id), "name": .string($0.name), "count": .number(Double($0.count))] })
        }
        if let collections, !collections.isEmpty {
            o["collections"] = .array(collections.map { .object($0.json) })
        }
        return .object(o)
    }
    h["describe_sticker"] = { a in
        let p = c.stickersProvider
        let d = try describeStickerRef(p, a["ref"]?.stringValue ?? "")
        return agentSummary(p, d.json)
    }
    h["list_stickers"] = { a in
        let layerId = a["layerId"]?.stringValue
        return ["layerId": (layerId ?? c.doc.activeLayerId).map { .string($0) } ?? .null, "stickers": .array(try c.listStickers(layerId).map { .object($0.json) })]
    }
    h["sticker_at"] = { a in
        let layerId = a["layerId"]?.stringValue
        let s = try c.stickerAt(layerId, a["x"]?.numberValue ?? .nan, a["y"]?.numberValue ?? .nan)
        return ["layerId": (layerId ?? c.doc.activeLayerId).map { .string($0) } ?? .null, "sticker": s.map { .object($0.json) } ?? .null]
    }
    h["add_stickers"] = { a in
        let layerId = a["layerId"]?.stringValue
        let list = (a["stickers"]?.arrayValue ?? []).map { $0.objectValue ?? [:] }
        for (i, x) in list.enumerated() where x["ref"] == nil && x["stamp"] == nil { throw PaintEditorError("Sticker \(i) needs ref (a sticker ref from find_stickers, e.g. \"editor:star\").") }
        try c.prepareStickers(list.map { $0["ref"]?.stringValue ?? "editor:\($0["stamp"]?.stringValue ?? "")" })
        return ["layerId": (layerId ?? c.doc.activeLayerId).map { .string($0) } ?? .null, "stickers": .array(try c.addStickers(layerId, list).map { .object($0.json) })]
    }
    h["update_sticker"] = { a in
        // The layer's stickers are redrawn, so every one needs its art (and a new ref too).
        let refs = try c.listStickers(a["layerId"]?.stringValue).map(\.ref)
        try c.prepareStickers(a["ref"]?.stringValue.map { refs + [$0] } ?? refs)
        return .object(try c.updateSticker(a["layerId"]?.stringValue, a["id"]?.stringValue ?? "", a.without("layerId").without("id")).json)
    }
    h["arrange_stickers"] = { a in
        try c.prepareStickers(try c.listStickers(a["layerId"]?.stringValue).map(\.ref))
        return ["order": .array(try c.arrangeStickers(a["layerId"]?.stringValue, (a["ids"]?.arrayValue ?? []).compactMap(\.stringValue), a["to"]?.stringValue ?? "front").map { .string($0) })]
    }
    h["remove_stickers"] = { a in
        try c.prepareStickers(try c.listStickers(a["layerId"]?.stringValue).map(\.ref))
        return ["removed": .array(try c.removeStickers(a["layerId"]?.stringValue, a["ids"]?.arrayValue?.compactMap(\.stringValue)).map { .string($0) })]
    }
    return h
}
