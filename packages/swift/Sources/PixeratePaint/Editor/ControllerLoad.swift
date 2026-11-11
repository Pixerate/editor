import Foundation
import PixerateCore
import PixerateRaster

/**
 * Opening saved paintings (`loadJSON` and `adopt` in `controller.ts`, with the extension readers
 * of `readThick`, `readWet`, `readGuides` and `readMixingPad`). Opening clears the history. What
 * cannot be read is left out and reported, in the TS core's words; the rest loads.
 */
extension PaintEditorController {
    /// Opens a saved painting (`toJSON`'s shape, assets inline), clearing the history. Returns what could not be read.
    @discardableResult
    public func loadJSON(_ raw: JSONValue) throws -> [String] {
        if liveStroke != nil { throw PaintEditorError("A stroke is in progress; end or cancel it before opening a document.") }
        let loaded: LoadedPaintDocument
        do {
            loaded = try deserializePaintDocument(raw)
        } catch {
            throw PaintEditorError(errorMessage(error))
        }
        return adopt(loaded)
    }

    private func adopt(_ loaded: LoadedPaintDocument) -> [String] {
        var problems = loaded.problems
        culturePreview = nil
        culturePaused = false
        extensions = loaded.extensions
        readWet(loaded.wet, &problems)
        readMixingPad(loaded.mixingPad, &problems)
        readGuides(loaded.guides, loaded.state, &problems)
        if let list = loaded.swatches?.arrayValue { swatches = list.compactMap(readSwatch) }
        for s in loaded.state.strokes { bumpStrokeCounter(s.id) }
        undoStack = []
        redoStack = []
        resetMutations()
        // An open `group` stays open (as in TS): opening records no step, and the group ends as usual.
        wetOp = nil
        pendingWetEvents = []
        paintedBounds = [:]
        stencilCache = nil
        clearBlastAnimation()
        let state = readExtensions(loaded.state, loaded.extensions, &problems)
        nextMagnetId = 1
        for m in state.magnets ?? [] {
            if let n = idNumber(m.id, "mag"), n >= nextMagnetId { nextMagnetId = n + 1 }
        }
        for (_, list) in state.liveStrokes ?? OrderedMap() { for s in list { bumpStrokeCounter(s.id) } }
        for k in ["layerChannels", "light", "lightSpill", "ferro", "magnets", "lighting", "stickers", "liveStrokes", "brushSources", "effectLayers", "paperEffect", "authoredEffects", "fluor", "thermo", "heat", "uvLight", "age", "cultures"] {
            extensions[k] = nil
        }
        viewCompositor = createPaintCompositor()
        setDocSilently(state)
        emit()
        // Provider stickers keep their saved pixels; their art loads now so they can be edited.
        let refs = (state.stickers ?? OrderedMap()).values.flatMap { $0.map(\.ref) }
        if refs.contains(where: { editorStampOf($0) == nil }) { try? prepareStickers(refs) }
        notifyDocumentReplaced()
        return problems
    }

    /// `n` of an id `<prefix><n>` (`/^prefix(\d+)$/`), or nil.
    private func idNumber(_ id: String, _ prefix: String) -> Int? {
        guard id.hasPrefix(prefix) else { return nil }
        let digits = id.dropFirst(prefix.count)
        guard !digits.isEmpty, digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        return Int(digits)
    }

    private func bumpStrokeCounter(_ id: String) {
        if let n = idNumber(id, "s"), n >= strokeCounter { strokeCounter = n + 1 }
    }

    /// Wet settings by layer and the tilt (`readWet`). Wet paint itself is saved dry.
    private func readWet(_ raw: JSONValue?, _ problems: inout [String]) {
        wet.reset()
        guard let r = raw?.objectValue else { return }
        let t = r["tilt"]?.objectValue ?? JSONObject()
        _ = wet.setTilt(angle: t["angle"]?.numberValue, direction: t["direction"]?.numberValue)
        guard let layers = r["layers"]?.objectValue else { return }
        for (id, v) in layers {
            guard let x = v.objectValue else {
                problems.append("wet.layers[\"\(id)\"] is not wet settings; skipped.")
                continue
            }
            let ghost = readWetGhost(x["ghost"])
            let livePatterns: LivePatternsSettings? = {
                switch x["livePatterns"] {
                case nil, .null?, .bool(false)?, .number(0)?: return nil
                case .string(let s)? where s.isEmpty: return nil
                default: return normalizeLivePatterns(x["livePatterns"]?.objectValue ?? JSONObject())
                }
            }()
            wet.settings.set(id, WetLayerSettings(params: normalizeWetParams(x["params"]?.objectValue ?? JSONObject()), flow: normalizeFlow(x["flow"]?.objectValue ?? JSONObject()), livePatterns: livePatterns, ghost: ghost))
            if let livePatterns { _ = wet.patternFieldOf(id).configure(livePatterns) }
        }
    }

    /// The mixing pad and the pads kept by name (`readMixingPad`).
    private func readMixingPad(_ raw: JSONValue?, _ problems: inout [String]) {
        savedPads = []
        nextPadId = 1
        pad.clear()
        guard let raw, raw != .null else { return }
        let r = raw.objectValue ?? JSONObject()
        if case .string(let current)? = r["current"] {
            do {
                try pad.fromPng(current)
            } catch {
                problems.append("The mixing pad could not be read (\(errorMessage(error))); it starts empty.")
            }
        }
        if let saved = r["saved"]?.arrayValue {
            for (i, p) in saved.enumerated() {
                guard let x = p.objectValue, case .string(let png)? = x["png"], case .string(let name)? = x["name"] else {
                    problems.append("mixingPad.saved[\(i)] is not a saved pad; skipped.")
                    continue
                }
                let id: String = {
                    if case .string(let s)? = x["id"], idNumber(s, "pad") != nil { return s }
                    return "pad\(nextPadId)"
                }()
                if let n = idNumber(id, "pad"), n >= nextPadId { nextPadId = n + 1 }
                savedPads.append(SavedMixingPad(id: id, name: name, png: png))
            }
        }
    }

    /// Symmetry, perspective, the tracing and reference images and stencils (`readGuides`).
    private func readGuides(_ raw: JSONValue?, _ state: PaintDocumentState, _ problems: inout [String]) {
        let base = defaultGuides(state.canvas)
        guides = base
        guard let r = raw?.objectValue else { return }
        var g = base
        g.symmetry = normalizeSymmetry(r["symmetry"]?.objectValue ?? JSONObject(), base.symmetry)
        do {
            g.perspective = try normalizePerspective(r["perspective"]?.objectValue ?? JSONObject(), base.perspective)
        } catch {
            problems.append("Perspective guide: \(errorMessage(error))")
        }
        if let t = r["tracing"]?.objectValue, case .string(let src)? = t["src"] {
            do {
                let px = try decodeImage(src, "The tracing image")
                let rect: GuideRect = {
                    if let rr = t["rect"]?.objectValue, let w = rr["width"]?.numberValue, let h = rr["height"]?.numberValue, w > 0, h > 0 {
                        return GuideRect(x: rr["x"]?.numberValue ?? 0, y: rr["y"]?.numberValue ?? 0, width: w, height: h)
                    }
                    return GuideRect(x: 0, y: 0, width: Double(state.canvas.width), height: Double(state.canvas.height))
                }()
                let opacity: Double = { if case .number(let o)? = t["opacity"] { return Swift.min(1, Swift.max(0, o)) }; return 0.35 }()
                g.tracing = TracingImage(src: src, width: px.width, height: px.height, rect: rect, opacity: opacity, visible: t["visible"] != .bool(false), sampleColors: t["sampleColors"] == .bool(true))
            } catch {
                problems.append(errorMessage(error))
            }
        }
        if let refs = r["references"]?.arrayValue {
            for ref in refs {
                guard let o = ref.objectValue, case .string(let src)? = o["src"], case .string(let id)? = o["id"] else { continue }
                do {
                    let px = try decodeImage(src, "Reference \"\(jsTemplate(o["name"]))\"")
                    let name: String = { if let n = o["name"], n != .null { return jsTemplate(n) }; return id }()
                    func number(_ k: String, _ d: Double) -> Double {
                        let v = jsNumber(o[k])
                        return v.isNaN || v == 0 ? d : v
                    }
                    g.references.append(ReferenceImage(id: id, name: name, src: src, width: px.width, height: px.height, x: number("x", 0), y: number("y", 0), displayWidth: number("displayWidth", 240), visible: o["visible"] != .bool(false)))
                    if let n = idNumber(id, "ref"), n >= nextReferenceId { nextReferenceId = n + 1 }
                } catch {
                    problems.append(errorMessage(error))
                }
            }
        }
        if let stencils = r["stencils"]?.arrayValue {
            g.stencils = []
            for (i, raw) in stencils.enumerated() {
                do {
                    let id: String = {
                        if case .string(let s)? = raw.objectValue?["id"], idNumber(s, "stencil") != nil { return s }
                        return "stencil\(nextStencilId)"
                    }()
                    g.stencils.append(try normalizeStencil(raw.objectValue ?? JSONObject(), id))
                    if let n = idNumber(id, "stencil"), n >= nextStencilId { nextStencilId = n + 1 }
                } catch {
                    problems.append("Stencil \(i + 1): \(errorMessage(error))")
                }
            }
        }
        guides = g
    }

    /// The document extensions the controller reads into the document and its settings (`readThick`).
    private func readExtensions(_ stateIn: PaintDocumentState, _ ext: JSONObject, _ problems: inout [String]) -> PaintDocumentState {
        var state = stateIn
        if let list = ext["brushSources"]?.arrayValue {
            brushSources.set(list.enumerated().compactMap { i, x in readBrushSource(x, "brushSources[\(i)]", &problems) })
        }
        let l = ext["lighting"]?.objectValue ?? JSONObject()
        lighting = normalizeLighting(azimuth: l["azimuth"]?.numberValue, elevation: l["elevation"]?.numberValue, relief: l["relief"]?.numberValue, DEFAULT_LIGHTING)
        let uv = ext["uvLight"]?.objectValue ?? JSONObject()
        uvLight = normalizeUvLight(on: uv["on"]?.boolValue, strength: uv["strength"]?.numberValue, ambient: uv["ambient"]?.numberValue, DEFAULT_UV_LIGHT)
        age = normalizeAge(ext["age"]?.objectValue ?? state.age?.json.objectValue, DEFAULT_AGE)
        if age != DEFAULT_AGE { state = state.with { $0.age = self.age } }
        litCaches.removeAll()
        uvCaches.removeAll()
        thermoCaches.removeAll()
        xrayNodeCache = nil
        if let raw = ext["stickers"]?.objectValue {
            var stickers = OrderedMap<String, [Sticker]>()
            for (id, value) in raw {
                guard findLayer(state.layers, id) != nil, let list = value.arrayValue else { continue }
                let ok = list.compactMap(readSavedSticker)
                if ok.count != list.count { problems.append("Some stickers of layer \"\(id)\" could not be read; they were dropped.") }
                stickers.set(id, ok)
            }
            if !stickers.isEmpty { state = state.with { $0.stickers = stickers } }
        }
        if let raw = ext["liveStrokes"]?.objectValue {
            var live = OrderedMap<String, [RecordedStroke]>()
            for (id, value) in raw {
                guard findLayer(state.layers, id)?.layer.isPixel == true, let list = value.arrayValue else { continue }
                let ok = list.compactMap(normalizeBrushStroke).map { s -> RecordedStroke in
                    var x = s
                    x.layerId = id
                    return x
                }
                if ok.count != list.count { problems.append("Some strokes of stroke layer \"\(id)\" could not be read; they were dropped (the layer's pixels are kept until a stroke is edited).") }
                live.set(id, ok)
            }
            if !live.isEmpty { state = state.with { $0.liveStrokes = live } }
        }
        if let raw = ext["authoredEffects"] {
            let read = readAuthoredEffects(raw)
            problems += read.problems
            if !read.effects.isEmpty { state = state.with { $0.authoredEffects = read.effects } }
        }
        if let raw = ext["effectLayers"]?.objectValue {
            var effectLayers = OrderedMap<String, PaintEffectSource>()
            for (id, v) in raw {
                guard findLayer(state.layers, id)?.layer.isPixel == true else { continue }
                if let source = readPaintEffectSource(v) { effectLayers.set(id, source) } else { problems.append("The effect of layer \"\(id)\" could not be read; it loads as a plain layer.") }
            }
            if !effectLayers.isEmpty { state = state.with { $0.effectLayers = effectLayers } }
        }
        if let raw = ext["paperEffect"] {
            do {
                let effect = try paperEffectFromJSON(raw, width: state.canvas.width, height: state.canvas.height)
                state = state.with { $0.paperEffect = effect }
            } catch {
                problems.append("The effect paper could not be read (\(errorMessage(error))); the plain paper shows.")
            }
        }
        lightSpills = [:]
        if let raw = ext["lightSpill"]?.objectValue {
            for (id, v) in raw {
                do {
                    let o = v.objectValue ?? JSONObject()
                    if findLayer(state.layers, id) != nil { lightSpills[id] = try normalizeLightSpill(radius: o["radius"]?.numberValue, strength: o["strength"]?.numberValue) }
                } catch {
                    problems.append("The light spill of layer \"\(id)\" could not be read; it takes the defaults.")
                }
            }
        }
        func channels(_ key: String, _ what: String, _ without: String, _ read: (JSONValue) throws -> TiledSurface) -> OrderedMap<String, TiledSurface>? {
            guard let raw = ext[key]?.objectValue else { return nil }
            var out = OrderedMap<String, TiledSurface>()
            for (id, v) in raw {
                guard findLayer(state.layers, id)?.layer.isPixel == true else { continue }
                do {
                    out.set(id, try read(v))
                } catch {
                    problems.append("The \(what) of layer \"\(id)\" could not be read (\(errorMessage(error))); it loads \(without).")
                }
            }
            return out.isEmpty ? nil : out
        }
        if let light = channels("light", "light paint", "without light", lightFromJSON) { state = state.with { $0.light = light } }
        if let fluor = channels("fluor", "fluorescent ink", "without fluorescence", fluorFromJSON) { state = state.with { $0.fluor = fluor } }
        if let thermo = channels("thermo", "thermochromic ink", "without thermochromic shift", thermoFromJSON) { state = state.with { $0.thermo = thermo } }
        if let raw = ext["heat"] {
            if let heat = heatFromJSON(raw, width: state.canvas.width, height: state.canvas.height) { state = state.with { $0.heat = heat } } else { problems.append("The heat field could not be read; the canvas loads cool.") }
        }
        if let raw = ext["ferro"]?.objectValue {
            var ferro = OrderedMap<String, TiledSurface>()
            var settings = OrderedMap<String, FerroSettings>()
            for (id, v) in raw {
                guard findLayer(state.layers, id)?.layer.isPixel == true else { continue }
                do {
                    let loaded = try ferroFromJSON(v)
                    ferro.set(id, loaded.surface)
                    settings.set(id, loaded.settings)
                } catch {
                    problems.append("The ferrofluid of layer \"\(id)\" could not be read (\(errorMessage(error))); it loads without ferrofluid.")
                }
            }
            if !ferro.isEmpty { state = state.with { $0.ferro = ferro; $0.ferroSettings = settings } }
        }
        if let raw = ext["magnets"] {
            let magnets = magnetsFromJSON(raw)
            if !magnets.isEmpty { state = state.with { $0.magnets = magnets } }
        }
        if let raw = ext["cultures"] {
            let valid = Set(flattenLayers(state.layers).filter(\.isPixel).map(\.id))
            let c = culturesExtensionFromJSON(raw, validLayerIds: valid, problems: &problems)
            if c.cultures != nil || c.growWhileClosed != nil || c.lastGrownAt != nil {
                state = state.with { s in
                    s.cultures = c.cultures
                    s.growWhileClosed = c.growWhileClosed
                    s.lastGrownAt = c.lastGrownAt
                }
            }
        }
        guard let raw = ext["layerChannels"]?.objectValue else { return state }
        var thick = OrderedMap<String, ThickChannels>()
        for (id, v) in raw {
            guard findLayer(state.layers, id) != nil else { continue }
            do {
                thick.set(id, try thickFromJSON(v))
            } catch {
                problems.append("The thick paint of layer \"\(id)\" could not be read (\(errorMessage(error))); it loads flat.")
            }
        }
        return thick.isEmpty ? state : state.with { $0.thick = thick }
    }
}

/**
 * A sticker as a saved document stores it, or nil when it can't be read (`readThick`): older
 * documents name an editor stamp (`stamp: "star"`), newer ones a ref (`ref: "editor:star"`); a
 * frame is kept only past the first, and a dark variant only on provider stickers.
 */
func readSavedSticker(_ raw: JSONValue) -> Sticker? {
    guard var o = raw.objectValue, case .string? = o["id"], case .number(let x)? = o["x"], x.isFinite, case .number(let y)? = o["y"], y.isFinite, case .number(let size)? = o["size"], size > 0 else { return nil }
    let refIn = o["ref"] ?? o["stamp"]
    guard case .string(let refText)? = refIn, let ref = normalizeStickerRef(refText) else { return nil }
    let stamp = editorStampOf(ref)
    let variant = o["variant"]
    o["stamp"] = nil
    o["variant"] = nil
    o["ref"] = .string(ref)
    if let stamp { o["stamp"] = .string(stamp) }
    if variant == .string("dark") && stamp == nil { o["variant"] = "dark" }
    if case .number(let f)? = o["frame"], f.rounded() == f, f > 0 {} else { o["frame"] = nil }
    return Sticker(json: .object(o))
}

/// `Number(value)` for a JSON value (NaN when it is not a number or numeric string).
private func jsNumber(_ v: JSONValue?) -> Double {
    switch v {
    case .number(let n)?: return n
    case .bool(let b)?: return b ? 1 : 0
    case .null?: return 0
    case .string(let s)?:
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? 0 : Double(t) ?? .nan
    default: return .nan
    }
}
