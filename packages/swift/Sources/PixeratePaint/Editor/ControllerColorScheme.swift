import Foundation
import PixerateCore
import PixerateRaster

/**
 * Dual-colour paint in the viewer's colour scheme (#718, #720; the colour-scheme sections of
 * `controller.ts`). A stroke painted in a light / dark pair (`RecordedStroke.dualColor`) shows in
 * the side of `setColorScheme`, and only the view changes: the document, history and saved file
 * never depend on who is looking.
 *
 * - **Stroke layers** keep each dual-colour stroke drawn in its light side in the document; the
 *   view draws the scheme's side instead (`schemeSurface`, one cached surface per layer).
 * - **Pixel layers** keep the side they were painted in. Their view is a replay of the stroke log
 *   with each pair in the scheme's side (`SchemeReplay.swift`), built in the background; a layer
 *   holding pixels the log doesn't have (`PaintDocumentState.unlogged`) keeps its colours.
 */

/// A stroke layer's view in the colour scheme: drawn for `scheme` from the strokes `list` (their keys) over the document surface `base`.
struct SchemeView {
    let scheme: String
    let list: [Int]
    let base: TiledSurface
    let surface: TiledSurface
}

/// What `schemeNeeds` finds: layers the scheme's replay shows (in stroke order), layers kept with why, and every layer with dual-colour strokes.
struct SchemeNeeds {
    var replay: [String] = []
    var kept = OrderedMap<String, String>()
    var dual = Set<String>()
}

/// One layer with dual-colour strokes in `PaintEditorController.colorSchemeView()`.
public struct PaintColorSchemeLayer: Equatable, Sendable {
    public var layerId: String
    public var name: String
    /**
     * `strokes`: a stroke layer, redrawn from its strokes in the scheme's side. `document`: its pixels
     * are already in the scheme's side. `replay`: rebuilt from the stroke log in the scheme's side.
     * `kept`: it holds pixels the stroke log doesn't have, so it keeps the side it was painted in.
     */
    public var view: String
    /// `replay` only: building (the layer shows its own pixels until then), ready or failed.
    public var state: String?
    /// `kept` and a failed `replay`: why.
    public var reason: String?

    public var json: JSONValue {
        var o: JSONObject = ["layerId": .string(layerId), "name": .string(name), "view": .string(view)]
        if let state { o["state"] = .string(state) }
        if let reason { o["reason"] = .string(reason) }
        return .object(o)
    }
}

/// How the document's dual-colour paint shows in the colour scheme (view only: never saved or undone).
public struct PaintColorSchemeView: Equatable, Sendable {
    public var scheme: String
    /// The replay of the stroke log in the scheme: `none` (no pixel layer needs one), `building`, `ready` or `failed`.
    public var replayState: String
    /// Items of the log repainted so far, and in the log.
    public var items: Int
    public var total: Int
    /// Why the replay failed.
    public var error: String?
    /// Each layer with dual-colour strokes, top first.
    public var layers: [PaintColorSchemeLayer]

    public var json: JSONValue {
        [
            "scheme": .string(scheme),
            "replay": ["state": .string(replayState), "items": .number(Double(items)), "total": .number(Double(total)), "error": error.map { .string($0) } ?? .null],
            "layers": .array(layers.map(\.json)),
        ]
    }
}

/// A replay editor's state after an item (`replayCheckpoint`); `lost` when its wet snapshot was dropped for memory.
final class ReplayCheckpoint {
    let doc: PaintDocumentState
    private(set) var wet: WetSnapshot?
    let tilt: WetTilt
    let settings: OrderedMap<String, WetLayerSettings>
    let clock: Int
    private(set) var lost = false

    init(doc: PaintDocumentState, wet: WetSnapshot?, tilt: WetTilt, settings: OrderedMap<String, WetLayerSettings>, clock: Int) {
        self.doc = doc
        self.wet = wet
        self.tilt = tilt
        self.settings = settings
        self.clock = clock
    }

    /// Drops the wet snapshot (over the memory budget). The TS core only flags it and keeps the
    /// snapshot referenced; nothing restores a lost checkpoint, so letting it go changes no result.
    func lose() {
        lost = true
        wet = nil
    }
}

/// A light / dark pair as #rrggbb each (`dualHex`), or nil when `value` is not one (`{ light, dark }` with a string each).
func dualHex(_ value: JSONValue?) -> PaintDualColor? {
    guard let o = value?.objectValue, let light = o["light"]?.stringValue, let dark = o["dark"]?.stringValue else { return nil }
    guard let l = dualSideHex(light, "light"), let d = dualSideHex(dark, "dark") else { return nil }
    return PaintDualColor(light: l, dark: d)
}

/// `brushColourHex(value, scheme)` for a string: the CSS colour (or `light-dark()` side) as #rrggbb.
private func dualSideHex(_ value: String, _ scheme: String) -> String? {
    guard let pair = normalizeCssDualColor(.string(value)) else { return nil }
    let css = scheme == "dark" ? pair.dark : pair.light
    return css.hasPrefix("#") && css.count >= 7 ? String(css.prefix(7)).lowercased() : nil
}

/// Layers a replay can paint into: visible and unlocked (what is shown is the document's own visibility).
func replayableLayers(_ layers: [PaintLayer]) -> [PaintLayer] {
    layers.map { l in
        if let children = l.children { return l.copy(visible: true, locks: .some(nil)).withChildren(replayableLayers(children)) }
        return l.copy(visible: true, locks: .some(nil))
    }
}

/// The saved `unlogged` extension: layer id → the change, for pixel layers that exist (nil when none).
func readUnlogged(_ raw: JSONValue?, _ layers: [PaintLayer]) -> OrderedMap<String, String>? {
    guard let o = raw?.objectValue else { return nil }
    var out = OrderedMap<String, String>()
    for (id, why) in o {
        if let reason = why.stringValue, findLayer(layers, id)?.layer.isPixel == true { out.set(id, reason) }
    }
    return out.isEmpty ? nil : out
}

private func sameUnlogged(_ a: OrderedMap<String, String>?, _ b: OrderedMap<String, String>?) -> Bool {
    let x = a ?? OrderedMap(), y = b ?? OrderedMap()
    return x.keys == y.keys && x.values == y.values
}

extension PaintEditorController {
    // MARK: - The scheme

    /// The colour scheme light / dark colours resolve for (`state.colorScheme`).
    public var currentColorScheme: String { colorScheme }

    /// The paint colour's light / dark pair for a stroke with `brushId`, when the colour came from one (a brush's own or default colour, or `setColor`).
    func dualPaint(_ brushId: String?) -> PaintDualColor? {
        let spec = brushId.map { findEntry($0)?.spec } ?? brushSpec
        if let s = spec, s.path("colour.own") == .bool(true), let d = s.path("colour.default") { return dualHex(d) }
        return brushColour.flatMap(dualHex)
    }

    // MARK: - Stroke layers in the colour scheme (#718)

    /// A stroke as the scheme shows it: itself, or (a dual-colour stroke) a copy in the scheme's side.
    func schemeStroke(_ st: RecordedStroke, _ scheme: String) -> RecordedStroke {
        guard let want = st.dualColor?.side(scheme), want != st.color else { return st }
        if let had = schemeCopies[st.key], had.scheme == scheme { return had.stroke }
        var out = st
        out.key = newStrokeKey()
        out.color = want
        // A Mixer Brush replays from its load, which follows the stroke's colour (as `updateStroke` gives it).
        if st.load != nil {
            let load = brushLoadForStroke(st.brush, EMPTY_MIXER_LOAD, hexToRgb8(want).map { Double($0) / 255 })
            out.load = load.reservoir != nil || load.pickup != nil ? load : nil
        }
        schemeCopies[st.key] = (scheme, out)
        return out
    }

    /// A stroke layer's surface in the scheme, or nil when the document's pixels already show it.
    /// (The TS core redraws only the strokes that changed since; this port redraws the layer whole,
    /// as its stroke layers always do.)
    func schemeSurface(_ layer: PaintLayer, _ list: [RecordedStroke]) -> TiledSurface? {
        let scheme = colorScheme
        if !list.contains(where: { st in st.dualColor.map { $0.side(scheme) != st.color } ?? false }) {
            schemeViews[layer.id] = nil
            return nil
        }
        let keys = list.map(\.key)
        if let had = schemeViews[layer.id], had.scheme == scheme, had.list == keys, had.base === layer.pixelSurface { return had.surface }
        let view = list.map { schemeStroke($0, scheme) }
        guard let surface = try? drawLiveStrokes(layer, view).surface else { return nil }
        schemeViews[layer.id] = SchemeView(scheme: scheme, list: keys, base: layer.pixelSurface, surface: surface)
        return surface
    }

    /**
     * `layers` with each stroke layer that holds dual-colour strokes shown in the scheme, and each
     * pixel layer whose dual-colour paint the scheme's replay shows (once it is ready).
     */
    func schemeLayers(_ layers: [PaintLayer]) -> [PaintLayer] {
        var out = layers
        for (id, list) in doc.liveStrokes ?? OrderedMap() {
            guard let l = findLayer(out, id)?.layer, l.isPixel else { continue }
            if let surface = schemeSurface(l, list) { out = mapLayer(out, id) { _ in l.withSurface(surface) } }
        }
        if let replay = shownSchemeReplay() {
            for id in schemeNeeds().replay {
                guard let l = findLayer(out, id)?.layer, l.isPixel else { continue }
                if let surface = replay.surface(id) { out = mapLayer(out, id) { _ in l.withSurface(surface) } }
            }
        }
        pruneSchemeCopies()
        return out
    }

    /// Forgets scheme copies of strokes the document no longer has (`schemeCopies` is a `WeakMap` in TS).
    private func pruneSchemeCopies() {
        let live = (doc.liveStrokes ?? OrderedMap()).values.reduce(0) { $0 + $1.count }
        if schemeCopies.count <= 2 * (live + doc.strokes.count) + 64 { return }
        var keep = Set(doc.strokes.map(\.key))
        for list in (doc.liveStrokes ?? OrderedMap()).values { for st in list { keep.insert(st.key) } }
        schemeCopies = schemeCopies.filter { keep.contains($0.key) }
    }

    // MARK: - Pixel layers in the colour scheme: replayed from the stroke log (#720)

    /**
     * Which pixel layers hold dual-colour strokes painted in the other scheme's side: `replay` (the
     * scheme's replay shows them) or `kept` (pixels the stroke log doesn't have, with the change that
     * put them there). `dual`: every layer with a dual-colour stroke.
     */
    func schemeNeeds() -> SchemeNeeds {
        let d = doc
        let scheme = colorScheme
        if let c = schemeNeedsCache, c.doc === d, c.scheme == scheme { return c.value }
        let other = scheme == "dark" ? "light" : "dark"
        var value = SchemeNeeds()
        var inReplay = Set<String>()
        for st in d.strokes {
            guard let dual = st.dualColor else { continue }
            value.dual.insert(st.layerId)
            // Stroke layers redraw from their strokes; a stroke in neither side (edited) follows no scheme.
            if d.liveStrokes?.get(st.layerId) != nil || st.color == dual.side(scheme) || st.color != dual.side(other) { continue }
            if inReplay.contains(st.layerId) || value.kept.has(st.layerId) { continue }
            if findLayer(d.layers, st.layerId)?.layer.isPixel != true { continue }
            if let why = d.unlogged?.get(st.layerId) {
                value.kept.set(st.layerId, why)
            } else {
                value.replay.append(st.layerId)
                inReplay.insert(st.layerId)
            }
        }
        schemeNeedsCache = (d, scheme, value)
        return value
    }

    /// The scheme's replay when it is ready to show, else nil (the layers show their own pixels).
    func shownSchemeReplay() -> SchemeReplay? {
        guard let r = schemeReplay, r.state == "ready", r.scheme == colorScheme, !schemeNeeds().replay.isEmpty else { return nil }
        return r
    }

    /// Starts, follows or drops the scheme's replay after a change (`emit`).
    func syncSchemeReplay() {
        if replayTarget || previewing { return }
        var r = schemeReplay
        if let had = r, had.scheme != colorScheme {
            had.dispose()
            schemeReplay = nil
            r = nil
        }
        // A replay that isn't needed now pauses (it catches up if dual-colour paint needs it again).
        if schemeNeeds().replay.isEmpty { return }
        if r == nil {
            do {
                r = try SchemeReplay(scheme: colorScheme, host: schemeReplayHost(colorScheme))
            } catch {
                return
            }
            schemeReplay = r
        }
        r?.kick()
    }

    private func schemeReplayHost(_ scheme: String) -> SchemeReplayHost {
        SchemeReplayHost(
            document: { [unowned self] in doc },
            clock: { [unowned self] in wet.world?.clock ?? 0 },
            liveStroke: { [unowned self] in liveStrokeRecord() },
            inScheme: { [unowned self] st in schemeStroke(st, scheme) },
            createTarget: { [unowned self] in
                let t = try createReplayTarget(scale: 1)
                t.setDocSilently(t.doc.with { $0.layers = replayableLayers($0.layers) })
                t.replayPaper = doc.paper
                return t
            },
            addMissingLayers: { [unowned self] t in
                let have = Set(flattenLayers(t.doc.layers).map(\.id))
                let missing = flattenLayers(doc.layers).filter { $0.isPixel && !have.contains($0.id) }
                if missing.isEmpty { return }
                let added = replayableLayers(missing.map { $0.withSurface(emptySurface(4), offset: LayerOffset(x: 0, y: 0)) })
                t.setDocSilently(t.doc.with { $0.layers = t.doc.layers + added })
            },
            stale: { [unowned self] t in
                t.doc.canvas.width != doc.canvas.width || t.doc.canvas.height != doc.canvas.height || t.replayPaper != doc.paper
            },
            changed: { [unowned self] rects in emit(rects) },
            memory: { [unowned self] in wet.undoMemory },
            yieldToHost: { [unowned self] in await schemeReplayYield() }
        )
    }

    /**
     * The stroke being painted as recorded so far, for a scheme replay to follow: a wet stroke's
     * points that the simulation has applied, with their clocks. `follow` is false for strokes that
     * can't be followed point by point (antimatter, scrapers, stickers, path-mapped effects): those
     * are repainted once they are logged.
     */
    func liveStrokeRecord() -> (stroke: RecordedStroke, wet: Bool, follow: Bool)? {
        guard let s = liveStroke?.session, !s.points.isEmpty else { return nil }
        let i = s.initValues
        let follow = i.antimatter == nil && i.scraper == nil && i.brush.engine != "sticker" && i.effect?.source.map?.by != "path"
        return (recordOf(s, ""), i.wet != nil, follow)
    }

    /**
     * How each layer with dual-colour strokes shows them in the colour scheme: `strokes` (a stroke
     * layer, redrawn from its strokes), `document` (its pixels are already in the scheme's side),
     * `replay` (pixels rebuilt from the stroke log in the scheme's side; `state` building, ready or
     * failed) or `kept` (it holds pixels the stroke log doesn't have, so it keeps the side it was
     * painted in; `reason` says why). View only: nothing here is saved or undone.
     */
    public func colorSchemeView() -> PaintColorSchemeView {
        let needs = schemeNeeds()
        let r: SchemeReplay? = !needs.replay.isEmpty && schemeReplay?.scheme == colorScheme ? schemeReplay : nil
        var layers: [PaintColorSchemeLayer] = []
        for l in flattenLayers(doc.layers).reversed() {
            if !l.isPixel || !needs.dual.contains(l.id) { continue }
            if doc.liveStrokes?.get(l.id) != nil {
                layers.append(PaintColorSchemeLayer(layerId: l.id, name: l.name, view: "strokes"))
            } else if needs.replay.contains(l.id) {
                let failed = r?.state == "failed"
                layers.append(PaintColorSchemeLayer(layerId: l.id, name: l.name, view: "replay", state: r?.state ?? "building", reason: failed ? "The replay failed: \(r!.error ?? "")" : nil))
            } else if let why = needs.kept.get(l.id) {
                let reason = "It holds pixels the stroke log doesn't have (from \"\(why)\"), so a replay can't rebuild it: it keeps the side of each dual colour it was painted in. Paint dual-colour strokes on a new layer (or a stroke layer) to have them follow the scheme."
                layers.append(PaintColorSchemeLayer(layerId: l.id, name: l.name, view: "kept", reason: reason))
            } else {
                layers.append(PaintColorSchemeLayer(layerId: l.id, name: l.name, view: "document"))
            }
        }
        if let r {
            let p = r.progress
            return PaintColorSchemeView(scheme: colorScheme, replayState: r.state, items: p.items, total: p.total, error: r.error, layers: layers)
        }
        return PaintColorSchemeView(scheme: colorScheme, replayState: "none", items: 0, total: 0, error: nil, layers: layers)
    }

    /**
     * `colorSchemeView()` once the scheme's replay has caught up (at once when there is none). It
     * runs the replay here (yielding between pieces of work) when nothing else is running it.
     */
    public func colorSchemeViewReady() async -> PaintColorSchemeView {
        while true {
            guard !schemeNeeds().replay.isEmpty, let r = schemeReplay else { break }
            await r.whenIdle()
            if r === schemeReplay && r.state != "building" { break }
            if r === schemeReplay { r.kick() }
        }
        return colorSchemeView()
    }

    /// Whether the scheme's replay has work to do (a host's clock then calls `runSchemeReplay`).
    public var schemeReplayPending: Bool { schemeReplay?.hasWork ?? false }

    /**
     * Runs the scheme's replay until it has caught up, letting the host in between pieces of work
     * (a canvas view runs it from a task on its clock; see `PaintEditorModel.runSchemeReplayClock`).
     */
    public func runSchemeReplay() async {
        await schemeReplay?.whenIdle()
    }

    /**
     * What the TS core's replay does in the microtask after a change, before the next tool call:
     * a replay that went stale (another canvas or paper) starts over, and one whose log was undone
     * or edited rolls back to a checkpoint, so the view never shows what the document no longer has.
     */
    func settleSchemeReplay() {
        schemeReplay?.settle()
    }

    /// Lets the host in during a replay: at most `schemeReplayFrameMs` of work at a time, then a pause until the next frame.
    func schemeReplayYield() async {
        schemeReplayYieldObserver?()
        guard let budget = schemeReplayFrameMs else {
            await Task.yield()
            return
        }
        let now = Date().timeIntervalSinceReferenceDate * 1000
        if now - schemeReplaySliceStart < budget {
            await Task.yield()
            return
        }
        try? await Task.sleep(nanoseconds: 8_000_000)
        schemeReplaySliceStart = Date().timeIntervalSinceReferenceDate * 1000
    }

    // MARK: - The replay editor's side

    /// A replay editor's state after an item, for a scheme replay to come back to (undo).
    func replayCheckpoint() -> ReplayCheckpoint {
        ReplayCheckpoint(doc: doc, wet: wet.snapshot(), tilt: wet.tilt, settings: wet.settings, clock: wet.world?.clock ?? 0)
    }

    /// Puts a `replayCheckpoint` back. False when it can't (mid-stroke, or its clock can't be restored).
    func restoreReplayCheckpoint(_ cp: ReplayCheckpoint) -> Bool {
        if liveStroke != nil { return false }
        setDocSilently(cp.doc)
        try? wet.restore(cp.wet)
        _ = wet.setTilt(angle: cp.tilt.angle, direction: cp.tilt.direction)
        wet.settings = cp.settings
        if let w = wet.world, w.clock != cp.clock, w.laneIds().isEmpty { w.setClock(cp.clock) }
        emit()
        return (wet.world?.clock ?? 0) == cp.clock
    }

    /// Drops the undo history (a replay editor keeps checkpoints of its own instead).
    func forgetHistory() {
        undoStack = []
        redoStack = []
    }

    /// A pixel layer's surface as the view shows it (with the live stroke), or nil.
    func viewLayerSurface(_ layerId: String) -> TiledSurface? {
        guard let l = findLayer(currentLayers(), layerId)?.layer, l.isPixel else { return nil }
        return l.pixelSurface
    }

    // MARK: - Pixels the stroke log doesn't have

    /**
     * `next` with the pixel layers this change wrote without logging it (`PaintDocumentState.unlogged`):
     * a layer whose pixels or offset changed, or a new layer with pixels, that none of the strokes and
     * events this change logged names. A clear empties a layer, so it is replayable again.
     */
    func withUnlogged(_ label: String, _ next: PaintDocumentState, base: PaintDocumentState) -> PaintDocumentState {
        let sameLayers = next.layers.count == base.layers.count && zip(next.layers, base.layers).allSatisfy { $0 === $1 }
        if sameLayers && sameUnlogged(next.unlogged, base.unlogged) { return next }
        var logged = Set<String>()
        var all = false
        var cleared = Set<String>()
        let oldStrokes = Set(base.strokes.map(\.key))
        for st in next.strokes where !oldStrokes.contains(st.key) {
            logged.insert(st.layerId)
            for id in st.scrapeLayerIds ?? [] { logged.insert(id) }
            for id in st.targets ?? [] { logged.insert(id) }
        }
        let oldPaint = Set((base.paintEvents ?? []).map(\.key))
        for e in next.paintEvents ?? [] where !oldPaint.contains(e.key) {
            logged.insert(e.layerId)
            if e.kind == "clear" { cleared.insert(e.layerId) }
        }
        let oldWet = Set((base.wetEvents ?? []).map(\.key))
        for e in next.wetEvents ?? [] where !oldWet.contains(e.key) && !preludeDry.contains(e.key) {
            guard let ids = e.layerId, !ids.isEmpty else {
                all = true
                continue
            }
            for id in ids.split(separator: ",", omittingEmptySubsequences: false) { logged.insert(String(id)) }
        }
        var was: [String: PaintLayer] = [:]
        for l in flattenLayers(base.layers) where l.isPixel { was[l.id] = l }
        var unlogged = next.unlogged
        var changedAny = false
        func set(_ id: String, _ reason: String?) {
            if unlogged?.get(id) == reason { return }
            var copy = unlogged ?? OrderedMap()
            if let reason { copy.set(id, reason) } else { copy.delete(id) }
            unlogged = copy.isEmpty ? nil : copy
            changedAny = true
        }
        var present = Set<String>()
        for l in flattenLayers(next.layers) where l.isPixel {
            present.insert(l.id)
            if cleared.contains(l.id) {
                set(l.id, nil)
                continue
            }
            // Stroke and sticker layers are drawn from their own data.
            if next.liveStrokes?.get(l.id) != nil || next.stickers?.get(l.id) != nil || unlogged?.get(l.id) != nil { continue }
            let changed: Bool
            if let b = was[l.id] {
                changed = b.pixelSurface !== l.pixelSurface || b.pixelOffset.x != l.pixelOffset.x || b.pixelOffset.y != l.pixelOffset.y
            } else {
                changed = !l.pixelSurface.tiles.isEmpty
            }
            if changed && !all && !logged.contains(l.id) { set(l.id, label) }
        }
        for id in unlogged?.keys ?? [] where !present.contains(id) { set(id, nil) }
        if !changedAny { return next }
        let out = unlogged
        return next.with { $0.unlogged = out }
    }
}
