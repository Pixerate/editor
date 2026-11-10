import Foundation
import PixerateCore
import PixerateRaster

/**
 * Provider effects in the paint editor (`paint-editor/effects.ts` and the controller's provider
 * effect section):
 *
 * - **Effect paper**: a generator drawn over the paper, under the paint (multiplied by default).
 * - **Effect layers**: pixel layers drawn by a generator, overlay or title effect, which keep it.
 * - **Effect fills**: an effect composited onto a layer's pixels.
 * - **Light on dried paint**: a filter run on a layer's paint and baked in.
 * - **Effect paint**: brushes take each pixel's colour from an effect (`EffectPaint.swift`).
 *
 * Effects render asynchronously; each change renders first and commits after (one undo step).
 */

/// The places of the paint editor and the uses each takes (`PAINT_EFFECT_PLACES`).
public let PAINT_EFFECT_PLACES: [String: [String]] = [
    "paper": ["generator"], "layer": ["generator", "overlay", "title"], "fill": ["generator", "overlay", "title"],
    "light": ["filter"], "paint": ["generator", "overlay", "title"],
]

private let PLACE_WORDS: [String: String] = [
    "paper": "effect paper takes generator effects",
    "layer": "an effect layer takes generator, overlay or title effects",
    "fill": "an effect fill takes generator, overlay or title effects",
    "light": "light on dried paint takes filter effects",
    "paint": "effect paint takes generator, overlay or title effects",
]

/// Refuses an effect that cannot go in `place`, saying what to use instead (`checkPaintEffectPlace`).
func checkPaintEffectPlace(_ d: EffectDescription, _ place: String) throws {
    let allowed = PAINT_EFFECT_PLACES[place] ?? []
    if d.kind != "motion" && d.kind != "vector" && d.uses.contains(where: allowed.contains) { return }
    var instead = ""
    if d.uses.contains("filter") && place == "paint" { instead = "; paint with a generator, overlay or title effect, or run the filter on the painted layer with apply_effect" } else if d.uses.contains("filter") && place != "light" { instead = "; run it on a layer's dried paint with apply_effect instead" } else if place == "light" && d.uses.contains(where: PAINT_EFFECT_PLACES["layer"]!.contains) { instead = "; add it as an effect layer (add_effect_layer) or fill a layer with it (fill_layer_with_effect) instead" } else if place == "paper" && d.uses.contains(where: { $0 == "overlay" || $0 == "title" }) { instead = "; add it as an effect layer with add_effect_layer instead" }
    let what = d.uses.isEmpty ? d.kind : d.uses.joined(separator: " / ")
    throw EffectError.unsupported("\"\(d.id)\" (\(d.name)) is a \(what) effect, and \(PLACE_WORDS[place] ?? place)\(instead).", d.id)
}

/// The provider effect a layer or the paper is drawn from (`PaintEffectSource`).
public struct PaintEffectSource: Equatable, Sendable {
    public var effect: String
    public var provider: String?
    public var name: String?
    /// Every control value.
    public var values: JSONObject
    /// Which moment of an animated effect, in ms (missing: 0).
    public var time: Double?

    public var json: JSONObject {
        var o: JSONObject = ["effect": .string(effect)]
        if let provider, !provider.isEmpty { o["provider"] = .string(provider) }
        if let name, !name.isEmpty { o["name"] = .string(name) }
        o["values"] = .object(values)
        if let time, time != 0 { o["time"] = .number(time) }
        return o
    }
}

/// Blend modes effect paper draws with.
public let PAPER_EFFECT_BLENDS = ["multiply", "normal", "overlay", "soft-light", "screen", "color"]

/// Effect paper: its effect, how it is drawn over the sheet, and its rendered pixels (`PaintPaperEffect`).
public struct PaintPaperEffect {
    public var source: PaintEffectSource
    public var opacity: Double
    public var blend: String
    public var image: ImageNodeImage
    /// Changes whenever the pixels change (render caches key on it).
    public var version: Double

    /// As tools report it: the source, opacity and blend (no pixels).
    public var json: JSONObject {
        var o = source.json
        o["opacity"] = .number(opacity)
        o["blend"] = .string(blend)
        return o
    }
}

private let paperEffectVersion = Locked(1.0)
func nextPaperEffectVersion() -> Double { paperEffectVersion.with { v in defer { v += 1 }; return v } }

/// A saved effect source (`readPaintEffectSource`), or nil when it is not one.
func readPaintEffectSource(_ raw: JSONValue?) -> PaintEffectSource? {
    guard let r = raw?.objectValue, let effect = r["effect"]?.stringValue, !effect.isEmpty,
          let values = r["values"]?.objectValue else { return nil }
    var time: Double? = nil
    if let t = r["time"]?.numberValue, t > 0 { time = t }
    return PaintEffectSource(effect: effect, provider: r["provider"]?.stringValue, name: r["name"]?.stringValue, values: values, time: time)
}

/// Reads saved effect paper for a `width × height` canvas (`paperEffectFromJSON`; throws saying what is wrong).
func paperEffectFromJSON(_ raw: JSONValue, width: Int, height: Int) throws -> PaintPaperEffect {
    guard let source = readPaintEffectSource(raw), let r = raw.objectValue else { throw PaintEditorError("it is not an effect (effect id and values)") }
    guard let png = r["png"]?.stringValue, let parsed = parseDataUrl(png) else { throw PaintEditorError("its pixels are missing") }
    let image = try decodePng(parsed.bytes)
    if image.width != width || image.height != height {
        throw PaintEditorError("its pixels are \(image.width)×\(image.height), not the canvas size \(width)×\(height)")
    }
    var opacity = 1.0
    if let o = r["opacity"]?.numberValue, o >= 0, o <= 1 { opacity = o }
    let b = r["blend"]?.stringValue
    let blend = b.map { PAPER_EFFECT_BLENDS.contains($0) } == true ? b! : "multiply"
    return PaintPaperEffect(source: source, opacity: opacity, blend: blend, image: ImageNodeImage(width: width, height: height, data: image.data), version: nextPaperEffectVersion())
}

/// Over-composites `top` onto `base` at `opacity` (`overPixels`).
func overPixels(_ base: [UInt8], _ top: [UInt8], _ opacity: Double = 1) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: base.count)
    for i in stride(from: 0, to: out.count, by: 4) {
        let ta = (Double(top[i + 3]) / 255) * opacity
        let ba = Double(base[i + 3]) / 255
        let a = ta + ba * (1 - ta)
        out[i + 3] = JS.u8c(JS.round(a * 255))
        if a > 0 { for c in 0..<3 { out[i + c] = JS.u8c((Double(top[i + c]) * ta + Double(base[i + c]) * ba * (1 - ta)) / a) } }
    }
    return out
}

/// Mixes `after` back towards `before` by `1 - amount`, keeping `before`'s alpha (`mixPixels`).
func mixPixels(_ before: [UInt8], _ after: [UInt8], _ amount: Double) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: before.count)
    for i in stride(from: 0, to: out.count, by: 4) {
        for c in 0..<3 { out[i + c] = JS.u8c(Double(before[i + c]) + (Double(after[i + c]) - Double(before[i + c])) * amount) }
        out[i + 3] = before[i + 3]
    }
    return out
}

public let PAPER_EFFECT_NODE_ID = "__paper_effect"

/// The most live effects (distinct sources) a document plays at once.
public let MAX_LIVE_EFFECT_SOURCES = 8

extension PaintEditorController {
    // MARK: - Provider

    /// Registers (or with nil removes) the effects provider. Not an edit: no undo step.
    public func setEffectsProvider(_ provider: EffectProvider?) { effectsProvider = provider }

    func requireEffectsProvider() throws -> EffectProvider {
        guard let p = effectsProvider else { throw EffectError("no_provider", "No effects provider is registered with this editor. The host must call setEffectsProvider(provider) first.") }
        return p
    }

    /// The provider's description of an effect, checked for `place`.
    public func describeEffect(_ effect: String, place: String? = nil) async throws -> EffectDescription {
        let d = try await requireEffectsProvider().describe(effect)
        let paths = pathControlsOf(d)
        if let first = paths.first { effectPathControls[d.id] = first }
        if let place { try checkPaintEffectPlace(d, place) }
        return d
    }

    /// Renders one effect at `width × height` and checks the size.
    func renderEffect(_ provider: EffectProvider, _ id: String, _ width: Int, _ height: Int, _ request: EffectRenderRequest) async throws -> EffectPixels {
        let r = try provider.createRenderer(id, width: width, height: height)
        defer { r.dispose() }
        let out = try await r.render(request)
        if out.width != width || out.height != height || out.data.count != width * height * 4 {
            throw PaintEditorError("The effect \"\(id)\" returned \(out.width)×\(out.height) pixels for a \(width)×\(height) canvas.")
        }
        return out
    }

    private func renderEffectCanvas(_ d: EffectDescription, _ values: JSONObject, _ time: Double? = nil) async throws -> EffectPixels {
        try await renderEffect(try requireEffectsProvider(), d.id, doc.canvas.width, doc.canvas.height, EffectRenderRequest(time: time ?? 0, values: values))
    }

    /// Values over `base` (`null` resets a control to its default), checked against the effect's controls.
    func effectValues(_ d: EffectDescription, _ base: JSONObject, _ changes: JSONObject?) throws -> JSONObject {
        var merged = base
        var given = JSONObject()
        let names = d.controlNames
        for (k, v) in changes ?? [:] {
            if !names.contains(k) { throw PaintEditorError("\"\(k)\" is not a control of \"\(d.id)\"; its controls are \(names.isEmpty ? "none" : names.joined(separator: ", ")) (describe_effect).") }
            if v == .null { merged[k] = d.defaults[k] ?? Optional<JSONValue>.none } else { given[k] = v }
        }
        var dj = d.json
        dj["defaults"] = .object(merged)
        let resolved = try resolveEffectValues(EffectDescription(dj), given)
        var out = merged
        for (k, v) in resolved { out[k] = v }
        return out
    }

    private func sourceOf(_ d: EffectDescription, _ values: JSONObject, _ time: Double?) throws -> PaintEffectSource {
        PaintEffectSource(effect: d.id, provider: try requireEffectsProvider().id, name: d.name, values: values, time: time.flatMap { $0 != 0 ? $0 : nil })
    }

    private func checkTime(_ time: Double?) throws {
        if let t = time, !(t.isFinite && t >= 0) { throw PaintEditorError("time \(jsText(t)) is not a moment of the effect; use 0 or more milliseconds.") }
    }

    private func checkOpacity(_ o: Double?) throws {
        if let o, !(o >= 0 && o <= 1) { throw PaintEditorError("opacity \(jsText(o)) is out of range; use 0..1.") }
    }

    /// A pixel layer that takes effect pixels: unlocked, visible, not a stroke layer.
    private func effectTarget(_ layerId: String?, _ what: String) throws -> PaintLayer {
        let l = try paintTarget(layerId, what)
        if doc.stickers?.get(l.id)?.isEmpty == false { throw PaintEditorError("Layer \"\(l.name)\" is a sticker layer; \(what) another layer (add_layer).") }
        if doc.liveStrokes?.get(l.id) != nil { throw PaintEditorError("Layer \"\(l.name)\" is a stroke layer (its pixels are drawn from its strokes); \(what) another layer (add_layer), or rasterize it first (rasterize_stroke_layer).") }
        return l
    }

    private func sameLayerAfterRender(_ before: PaintLayer) throws -> PaintLayer {
        guard let now = getLayer(before.id), now.isPixel else { throw PaintEditorError("Layer \"\(before.name)\" was removed while the effect rendered.") }
        if now.pixelSurface !== before.pixelSurface || now.pixelOffset != before.pixelOffset { throw PaintEditorError("Layer \"\(before.name)\" changed while the effect rendered; apply the effect again.") }
        return now
    }

    private func canvasRectOf(_ l: PaintLayer) -> RasterRect {
        RasterRect(x: -l.pixelOffset.x, y: -l.pixelOffset.y, width: doc.canvas.width, height: doc.canvas.height)
    }

    // MARK: - Effect layers and paper

    /// Every effect layer (top first) with its effect.
    public func listEffectLayers() -> [(layerId: String, name: String, source: PaintEffectSource)] {
        guard let map = doc.effectLayers else { return [] }
        return listLayers().compactMap { l in map.get(l.id).map { (l.id, l.name, $0) } }
    }

    /// The effect a layer is drawn from, or nil for other layers.
    public func getEffectLayer(_ layerId: String) -> PaintEffectSource? {
        findLayer(doc.layers, layerId) != nil ? doc.effectLayers?.get(layerId) : nil
    }

    /// The effect paper (as tools report it), or nil.
    public func getPaperEffect() -> PaintPaperEffect? { doc.paperEffect }

    /// The effect paper as a compositor layer (one object per effect paper, so caches hold).
    func paperEffectNode(_ p: PaintPaperEffect) -> ViewLayer {
        ViewLayer(kind: .image(p.image, version: p.version), id: PAPER_EFFECT_NODE_ID, name: "Effect paper", opacity: p.opacity, blend: GroupBlendMode(rawValue: p.blend) ?? .mode(.multiply))
    }

    private func checkPaperBlend(_ b: String?) throws {
        if let b, !PAPER_EFFECT_BLENDS.contains(b) { throw PaintEditorError("Unknown effect paper blend \"\(b)\"; use \(PAPER_EFFECT_BLENDS.joined(separator: ", ")).") }
    }

    /// Sets the effect paper (nil removes it). One undo step. Returns the effect paper, or nil.
    public func setPaperEffect(_ effect: String?, values: JSONObject? = nil, opacity: Double? = nil, blend: String? = nil, time: Double? = nil) async throws -> PaintPaperEffect? {
        guard let effect else {
            if doc.paperEffect == nil { return nil }
            commit("Remove effect paper", doc.with { $0.paperEffect = nil })
            return nil
        }
        try checkOpacity(opacity)
        try checkTime(time)
        try checkPaperBlend(blend)
        let d = try await describeEffect(effect, place: "paper")
        let vals = try effectValues(d, d.defaults, values)
        let pixels = try await renderEffectCanvas(d, vals, time)
        let was = doc.paperEffect
        let p = PaintPaperEffect(source: try sourceOf(d, vals, time), opacity: opacity ?? was?.opacity ?? 1, blend: blend ?? was?.blend ?? "multiply", image: ImageNodeImage(width: pixels.width, height: pixels.height, data: pixels.data), version: nextPaperEffectVersion())
        commit("Effect paper", doc.with { $0.paperEffect = p })
        return p
    }

    /// Changes the effect paper: new values or time draw it again; opacity and blend only change how it is drawn. One undo step.
    public func updatePaperEffect(values: JSONObject? = nil, opacity: Double? = nil, blend: String? = nil, time: Double? = nil) async throws -> PaintPaperEffect {
        guard let was = doc.paperEffect else { throw PaintEditorError("There is no effect paper; set one with set_paper_effect.") }
        try checkOpacity(opacity)
        try checkTime(time)
        try checkPaperBlend(blend)
        var next = was
        if let opacity { next.opacity = opacity }
        if let blend { next.blend = blend }
        if values != nil || time != nil || was.image.width != doc.canvas.width || was.image.height != doc.canvas.height {
            let d = try await describeEffect(was.source.effect, place: "paper")
            let vals = try effectValues(d, was.source.values, values)
            let t = time ?? was.source.time ?? 0
            let pixels = try await renderEffectCanvas(d, vals, t)
            if doc.paperEffect?.version != was.version { throw PaintEditorError("The effect paper changed while it rendered; change it again.") }
            next.source = try sourceOf(d, vals, t)
            next.image = ImageNodeImage(width: pixels.width, height: pixels.height, data: pixels.data)
            next.version = nextPaperEffectVersion()
        }
        commit("Effect paper", doc.with { $0.paperEffect = next })
        return next
    }

    /// Adds an effect layer above the active layer (or `aboveId`) and makes it active. One undo step.
    public func addEffectLayer(_ effect: String, values: JSONObject? = nil, name: String? = nil, aboveId: String? = nil, opacity: Double? = nil, blend: String? = nil, time: Double? = nil) async throws -> (layer: PaintLayerInfo, source: PaintEffectSource) {
        try checkOpacity(opacity)
        try checkTime(time)
        if let blend, !isBlendMode(blend) { throw PaintEditorError("Unknown blend mode \"\(blend)\". Call get_canvas_info for the blend modes.") }
        if let aboveId { _ = try requireLayer(aboveId) }
        let d = try await describeEffect(effect, place: "layer")
        let vals = try effectValues(d, d.defaults, values)
        let pixels = try await renderEffectCanvas(d, vals, time)
        let above = aboveId ?? doc.activeLayerId
        let loc = above.flatMap { findLayer(doc.layers, $0) }
        if aboveId != nil && loc == nil { throw PaintEditorError("Layer \"\(aboveId!)\" was removed while the effect rendered.") }
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let base = createPaintLayer(trimmed.isEmpty ? d.name : trimmed)
        let layer = base.copy(opacity: opacity ?? 1, blend: .mode(BlendMode(rawValue: blend ?? "normal") ?? .normal)).withSurface(surfaceFromPixels(width: pixels.width, height: pixels.height, data: pixels.data))
        let layers = insertLayer(doc.layers, layer, loc?.parent?.id, loc.map { $0.index + 1 })
        let source = try sourceOf(d, vals, time)
        commit("Add effect layer", doc.with { o in
            o.layers = layers
            o.activeLayerId = layer.id
            var m = o.effectLayers ?? OrderedMap()
            m.set(layer.id, source)
            o.effectLayers = m
        })
        return (describeLayer(layer), source)
    }

    /// Draws an effect layer again with new values or time, replacing its pixels. One undo step.
    public func updateEffectLayer(_ layerId: String, values: JSONObject? = nil, time: Double? = nil) async throws -> PaintEffectSource {
        guard let was = getEffectLayer(layerId) else { throw PaintEditorError("\"\(layerId)\" is not an effect layer; add one with add_effect_layer.") }
        try checkTime(time)
        let l = try effectTarget(layerId, "draw the effect on")
        let d = try await describeEffect(was.effect, place: "layer")
        let vals = try effectValues(d, was.values, values)
        let t = time ?? was.time ?? 0
        let pixels = try await renderEffectCanvas(d, vals, t)
        guard let now = getLayer(l.id), now.isPixel else { throw PaintEditorError("Layer \"\(l.name)\" was removed while the effect rendered.") }
        let source = try sourceOf(d, vals, t)
        commit("Effect layer", doc.with { o in
            o.layers = mapLayer(doc.layers, now.id) { $0.withSurface(surfaceFromPixels(width: pixels.width, height: pixels.height, data: pixels.data), offset: LayerOffset(x: 0, y: 0)) }
            var m = o.effectLayers ?? OrderedMap()
            m.set(now.id, source)
            o.effectLayers = m
        })
        return source
    }

    /// Turns an effect layer into a plain pixel layer, keeping its pixels (one undo step).
    public func rasterizeEffectLayer(_ layerId: String) throws -> PaintLayerInfo {
        if getEffectLayer(layerId) == nil { throw PaintEditorError("\"\(layerId)\" is not an effect layer; list_applied_effects lists them.") }
        commit("Rasterize effect layer", doc.with { o in
            var m = o.effectLayers ?? OrderedMap()
            _ = m.delete(layerId)
            o.effectLayers = m.isEmpty ? nil : m
        })
        return describeLayer(try requireLayer(layerId))
    }

    /// Composites an effect onto a layer's pixels at `opacity` (only where painted with `lockTransparency`). One undo step.
    public func fillLayerWithEffect(_ effect: String, layerId: String? = nil, values: JSONObject? = nil, opacity: Double? = nil, lockTransparency: Bool? = nil, time: Double? = nil) async throws -> (layerId: String, source: PaintEffectSource) {
        try checkOpacity(opacity)
        try checkTime(time)
        let l = try effectTarget(layerId, "fill")
        let d = try await describeEffect(effect, place: "fill")
        let vals = try effectValues(d, d.defaults, values)
        let pixels = try await renderEffectCanvas(d, vals, time)
        let now = try sameLayerAfterRender(l)
        let rect = canvasRectOf(now)
        let before = readRegion(now.pixelSurface, rect)
        var after = overPixels(before, pixels.data, opacity ?? 1)
        if lockTransparency == true || isLayerLocked(now.locks, .transparency) { after = mixPixels(before, after, 1) }
        let surface = writeRegion(now.pixelSurface, rect, after)
        commit("Effect fill", doc.with { $0.layers = mapLayer(doc.layers, now.id) { $0.withSurface(surface) } })
        return (now.id, try sourceOf(d, vals, time))
    }

    /// Runs a filter on a layer's dried paint and bakes it in at `amount` (0..1). One undo step.
    public func applyLightEffect(_ layerId: String?, _ effect: String, values: JSONObject? = nil, amount amountIn: Double? = nil, time: Double? = nil) async throws -> (layerId: String, source: PaintEffectSource, amount: Double) {
        let amount = amountIn ?? 1
        if !(amount >= 0 && amount <= 1) { throw PaintEditorError("amount \(jsText(amount)) is out of range; use 0..1.") }
        try checkTime(time)
        let l = try effectTarget(layerId, "light")
        if contentBounds(l.pixelSurface) == nil { throw PaintEditorError("Layer \"\(l.name)\" has no paint to light; paint on it first, or add an effect layer (add_effect_layer).") }
        let d = try await describeEffect(effect, place: "light")
        let vals = try effectValues(d, d.defaults, values)
        let rect = canvasRectOf(l)
        let before = readRegion(l.pixelSurface, rect)
        let images = d.inputs.filter { $0["kind"]?.stringValue == "image" }
        let heightInput = images.first { ($0["name"]?.stringValue ?? "").range(of: "^(height|depth|relief)$", options: [.regularExpression, .caseInsensitive]) != nil }?["name"]?.stringValue
        let sourceName = images.first { $0["name"]?.stringValue != heightInput }?["name"]?.stringValue ?? "source"
        let out = try await renderEffect(try requireEffectsProvider(), d.id, rect.width, rect.height, EffectRenderRequest(time: time ?? 0, values: vals, inputs: [sourceName: EffectPixels(width: rect.width, height: rect.height, data: before)]))
        let now = try sameLayerAfterRender(l)
        let surface = writeRegion(now.pixelSurface, rect, mixPixels(before, out.data, amount))
        commit("Light effect", doc.with { $0.layers = mapLayer(doc.layers, now.id) { $0.withSurface(surface) } })
        return (now.id, try sourceOf(d, vals, time), amount)
    }

    // MARK: - Effect paint

    /// At most this many rendered effect paints are kept (each is canvas-sized), more only while
    /// something needs them all: a replay's batch, and the path-mapped strokes on stroke layers,
    /// which each have a render of their own and are redrawn synchronously.
    static var effectPaintCacheSize: Int { 6 }

    func trimEffectPaints() {
        var live = 0
        for list in (doc.liveStrokes ?? OrderedMap()).values { live += list.filter { $0.effect?.map?.by == "path" }.count }
        // One more than the live strokes, for the editor's own paint.
        let limit = Swift.max(Self.effectPaintCacheSize, effectPaintBatch, live + 1)
        while effectPaintPixels.count > limit, let first = effectPaintPixels.keys.first { _ = effectPaintPixels.delete(first) }
    }

    func clearEffectPaint() {
        effectPaint = nil
        effectPaintPending = nil
        paintEpoch += 1
    }

    /// The effect paint strokes use (or the one rendering), or nil.
    public func getEffectPaint() -> PaintEffectPaint? { effectPaintPending ?? effectPaint }

    /// Whether the effect paint is still rendering.
    public var effectPaintRendering: Bool { effectPaintPending != nil }

    /// Paints with a provider effect: rendered once, then strokes take each pixel's colour from it. Editor state, not an undo step.
    public func setEffectPaint(_ effect: String, values: JSONObject? = nil, time: Double? = nil, map rawMap: JSONValue? = nil, live: Bool? = nil) async throws -> PaintEffectPaint {
        if effect.isEmpty { throw PaintEditorError("effect is missing; pass an effect id from search_effects (use generator, overlay or title).") }
        try checkTime(time)
        let map = try readEffectStrokeMap(rawMap)
        paintEpoch += 1
        let epoch = paintEpoch
        let d = try await describeEffect(effect, place: "paint")
        if map?.by == "path" && pathControlsOf(d).isEmpty {
            throw PaintEditorError("Effect \"\(d.id)\" has no path control (format \"svg-path\"); use by: \"stroke\" (bent along each stroke) or by: \"canvas\" (fixed to the canvas).")
        }
        let vals = try effectValues(d, d.defaults, values)
        func changed() -> PaintEditorError { PaintEditorError("The paint changed while \"\(d.name)\" rendered (set_color, set_paint or another set_effect_paint); call set_effect_paint again to paint with it.") }
        if epoch != paintEpoch { throw changed() }
        let paint = PaintEffectPaint(effect: d.id, provider: try requireEffectsProvider().id, values: vals, time: time ?? 0, map: map, live: live == true)
        effectPaintPending = paint
        emit()
        do { _ = try await renderEffectPaint(paint) } catch {
            if effectPaintPending == paint {
                effectPaintPending = nil
                emit()
            }
            throw error
        }
        if effectPaintPending != paint || epoch != paintEpoch { throw changed() }
        effectPaintPending = nil
        effectPaint = paint
        gradient = nil
        emit()
        return paint
    }

    /// The rendered pixels of an effect paint at the current canvas size, or nil.
    func effectPaintImage(_ p: PaintEffectPaint) -> EffectPaintPixels? {
        let key = p.key
        guard let img = effectPaintPixels.get(key) else { return nil }
        let size = p.size(doc.canvas)
        if img.width != size.width || img.height != size.height { return nil }
        _ = effectPaintPixels.delete(key)
        effectPaintPixels.set(key, img)
        return img
    }

    /// Renders an effect paint into the cache (nothing when it is there already).
    func renderEffectPaint(_ p: PaintEffectPaint) async throws -> EffectPaintPixels {
        if let have = effectPaintImage(p) { return have }
        return cacheEffectPaintImage(p, try await renderEffectPaintPixels(p))
    }

    @discardableResult
    func cacheEffectPaintImage(_ p: PaintEffectPaint, _ img: EffectPaintPixels) -> EffectPaintPixels {
        effectPaintPixels.set(p.key, img)
        trimEffectPaints()
        return img
    }

    /// Renders an effect paint at the canvas size without keeping it.
    func renderEffectPaintPixels(_ p: PaintEffectPaint) async throws -> EffectPaintPixels {
        let what = "the effect \"\(p.effect)\"\(p.provider.isEmpty ? "" : " from provider \"\(p.provider)\"")"
        guard let provider = effectsProvider else { throw PaintEditorError("Effect paint needs \(what), but no effects provider is registered; register it (setEffectsProvider) and try again.") }
        if !p.provider.isEmpty && provider.id != p.provider { throw PaintEditorError("Effect paint needs \(what), but the registered provider is \"\(provider.id)\"; register \"\(p.provider)\" (setEffectsProvider) and try again.") }
        let size = p.size(doc.canvas)
        let pixels: EffectPixels
        do { pixels = try await renderEffect(provider, p.effect, size.width, size.height, EffectRenderRequest(time: p.time, values: p.values)) } catch {
            throw PaintEditorError("Effect paint could not render \(what): \(error.localizedDescription)")
        }
        return EffectPaintPixels(width: size.width, height: size.height, data: pixels.data, map: p.map?.by == "stroke" ? p.map : nil)
    }

    /// Renders an effect paint synchronously when its provider supports synchronous rendering (`SyncEffectRenderer`).
    func renderEffectPaintSync(_ p: PaintEffectPaint) -> EffectPaintPixels? {
        if let have = effectPaintImage(p) { return have }
        guard let provider = effectsProvider, p.provider.isEmpty || provider.id == p.provider else { return nil }
        let size = p.size(doc.canvas)
        guard let made = try? provider.createRenderer(p.effect, width: size.width, height: size.height) else { return nil }
        defer { made.dispose() }
        guard let r = made as? SyncEffectRenderer else { return nil }
        guard let pixels = try? r.renderSync(EffectRenderRequest(time: p.time, values: p.values)),
              pixels.width == size.width, pixels.height == size.height, pixels.data.count == size.width * size.height * 4 else { return nil }
        let img = EffectPaintPixels(width: size.width, height: size.height, data: pixels.data, map: p.map?.by == "stroke" ? p.map : nil)
        effectPaintPixels.set(p.key, img)
        trimEffectPaints()
        return img
    }

    func strokeEffectWithPath(_ source: PaintEffectPaint, _ points: [PenPoint]?) -> PaintEffectPaint {
        guard source.map?.by == "path", let points, !points.isEmpty else { return source }
        return withStrokePath(source, points, control: effectPathControls[source.effect])
    }

    /// Renders a path-mapped effect paint with `points` as its path control, so a synchronous stroke has its pixels ready.
    public func prepareStrokePathEffect(_ i: PaintStrokeInit, _ points: [PenPoint]) async throws {
        guard !points.isEmpty else { return }
        let b = (try? strokeBrush(i)) ?? brush
        if !brushTakesPaint(b) { return }
        let raw: PaintEffectPaint?
        if let p = i.paint {
            raw = isPaintEffectPaint(p) ? readPaintEffectPaint(p) : nil
        } else if i.color == nil && b.paint == nil {
            raw = effectPaint
        } else {
            raw = nil
        }
        guard let raw, raw.map?.by == "path" else { return }
        if effectPathControls[raw.effect] == nil, let d = try? await effectsProvider?.describe(raw.effect) {
            if let first = pathControlsOf(d).first { effectPathControls[d.id] = first }
        }
        _ = try await renderEffectPaint(strokeEffectWithPath(raw, points))
    }

    /// Renders effect paints that are not rendered yet (strokes and replays need them first).
    public func prepareEffectPaints(_ paints: [PaintEffectPaint]) async throws {
        effectPaintBatch = Set(paints.map(\.key)).count
        var seen = Set<String>()
        for p in paints where seen.insert(p.key).inserted { _ = try await renderEffectPaint(p) }
    }

    /// The effect paint a stroke paints with and its pixels, or nil (`strokeEffect`).
    func strokeEffect(_ i: PaintStrokeInit, _ brush: PaintBrush) throws -> (source: PaintEffectPaint, pixels: EffectPaintPixels)? {
        if !brushTakesPaint(brush) { return nil }
        var source: PaintEffectPaint?
        if let p = i.paint {
            if !isPaintEffectPaint(p) { return nil }
            guard let s = readPaintEffectPaint(p) else { throw PaintEditorError("The stroke's effect paint needs an effect id and values (getEffectPaint returns one).") }
            source = s
        } else if i.color == nil && brush.paint == nil {
            if let pending = effectPaintPending { throw PaintEditorError("The effect paint \"\(pending.effect)\" is still rendering; wait for set_effect_paint to finish, then paint.") }
            source = effectPaint
        }
        guard var source else { return nil }
        source = strokeEffectWithPath(source, i.points)
        guard let pixels = effectPaintImage(source) ?? renderEffectPaintSync(source) else {
            throw PaintEditorError("The effect paint \"\(source.effect)\"\(source.provider.isEmpty ? "" : " from provider \"\(source.provider)\"") is not rendered at this canvas size; call \(source.map?.by == "path" ? "prepareStrokePathEffect (the paint_stroke tool does this) or prepareEditStrokePointsEffect" : "set_effect_paint (or prepareEffectPaints)") first.")
        }
        return (source, pixels)
    }

    // MARK: - Live effect playback

    /// Stroke layers with live effect strokes, and the distinct live sources.
    func liveEffects(_ d: PaintDocumentState? = nil) -> (layers: [(id: String, strokes: [RecordedStroke])], sources: [PaintEffectPaint]) {
        let d = d ?? doc
        var layers: [(id: String, strokes: [RecordedStroke])] = []
        var sources: [PaintEffectPaint] = []
        for (id, strokes) in d.liveStrokes ?? OrderedMap() {
            let live = strokes.filter { $0.effect?.live == true }
            guard let l = findLayer(d.layers, id)?.layer, l.isPixel, !live.isEmpty else { continue }
            layers.append((id, strokes))
            for st in live where !sources.contains(where: { $0.key == st.effect!.key }) { sources.append(st.effect!) }
        }
        return (layers, sources)
    }

    /// What plays: the live effect strokes and their layers, or nil when nothing does.
    public func getAnimation() -> JSONValue {
        let (layers, sources) = liveEffects()
        if layers.isEmpty { return .null }
        return ["layerIds": .array(layers.map { .string($0.id) }), "strokes": .number(Double(layers.reduce(0) { $0 + $1.strokes.filter { $0.effect?.live == true }.count })), "sources": .number(Double(sources.count))]
    }

    /**
     * Plays or pauses live effect paint and caps its frame rate (1..60); a setting left out keeps
     * its value. Editor state, not an undo step.
     */
    public func setEffectPlayback(playing: Bool? = nil, fps: Double? = nil) throws -> JSONObject {
        if let fps, !(fps == fps.rounded() && fps >= 1 && fps <= 60) { throw PaintEditorError("fps \(jsText(fps)) is out of range; use a whole number 1..60.") }
        effectPlayback = (playing ?? effectPlayback.playing, fps.map { Int($0) } ?? effectPlayback.fps)
        emit()
        return ["playing": .bool(effectPlayback.playing), "fps": .number(Double(effectPlayback.fps)), "time": .number(effectTime)]
    }

    // MARK: - Saving

    /// The document extension entries of provider effects (`effectLayers`, `paperEffect`).
    func providerEffectsJSON(_ d: PaintDocumentState) -> JSONObject {
        var out = JSONObject()
        if let map = d.effectLayers {
            var o = JSONObject()
            for (id, s) in map where findLayer(d.layers, id)?.layer.isPixel == true { o[id] = .object(s.json) }
            if !o.isEmpty { out["effectLayers"] = .object(o) }
        }
        if let p = d.paperEffect {
            var o = p.source.json
            o["opacity"] = .number(p.opacity)
            o["blend"] = .string(p.blend)
            o["png"] = .string(pngDataUrl(p.image.width, p.image.height, p.image.data))
            out["paperEffect"] = .object(o)
        }
        return out
    }
}
