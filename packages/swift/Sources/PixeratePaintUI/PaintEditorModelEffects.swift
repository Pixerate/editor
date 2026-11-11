import Foundation
import PixerateCore
import PixeratePaint

/// Where the effects panel puts an effect, and the uses each place takes (`BROWSERS` in `PaintEffectsPanel`).
public enum PaintEffectPlace: String, CaseIterable, Identifiable, Sendable {
    case paper, layer, fill, light, paint
    public var id: String { rawValue }
    /// The button that opens the browser.
    public var label: String {
        switch self {
        case .paper: return "Paper…"
        case .layer: return "Layer…"
        case .fill: return "Fill…"
        case .light: return "Light…"
        case .paint: return "Paint…"
        }
    }
    /// The browser's title.
    public var title: String {
        switch self {
        case .paper: return "Effect paper"
        case .layer: return "Effect layer"
        case .fill: return "Fill the layer"
        case .light: return "Light on the paint"
        case .paint: return "Paint with an effect"
        }
    }
    /// The effect uses this place takes (`PAINT_EFFECT_PLACES`).
    public var uses: [String] { PAINT_EFFECT_PLACES[rawValue] ?? [] }
    /// Whether it needs the active layer to be a pixel layer.
    public var needsPixelLayer: Bool { self == .fill || self == .light }
}

/// What plays live (`getAnimation`): the stroke layers, live strokes and distinct effects.
public struct PaintLiveAnimation: Equatable, Sendable {
    public var layerIds: [String]
    public var strokes: Int
    public var sources: Int
}

/**
 * Provider effects in the editor view (`PaintEffectsPanel`'s handlers): effect paper, effect
 * layers, effect fills, light baked onto dried paint, effect paint for the brush, and live effect
 * playback. Every action is the controller call the matching agent tool makes; each change that
 * renders shows `effectsBusy` meanwhile and reports a failure in `error`.
 */
extension PaintEditorModel {
    /**
     * The effects the panel offers (`controller.effectsCatalog`): the registered provider with the
     * painting's authored effects, or nil with neither (the Effects tab is shown only with one).
     */
    public var effectsProvider: EffectProvider? { track(); return controller.effectsCatalog }

    /// The painting's authored effects (written at run time and kept in the painting), with where each is used.
    public func authoredEffects() async -> [AuthoredEffectInfo] { track(); return await controller.listAuthoredEffects() }

    /// The side panel tabs: the Effects tab only while there are effects to offer (a provider, or authored effects).
    public var tabs: [PaintPanelTab] { effectsProvider != nil ? PaintPanelTab.allCases : PaintPanelTab.allCases.filter { $0 != .providerEffects } }

    /// The effect paper (its source, opacity and blend), or nil.
    public var paperEffect: PaintPaperEffect? { track(); return controller.getPaperEffect() }

    /// The effect paint the brush paints with (or the one rendering), or nil.
    public var effectPaint: PaintEffectPaint? { track(); return controller.getEffectPaint() }

    /// Whether the effect paint is still rendering.
    public var effectPaintRendering: Bool { track(); return controller.effectPaintRendering }

    /// The effect the active layer is drawn from, or nil when it is not an effect layer.
    public var activeEffectLayer: PaintEffectSource? { activeLayer.flatMap { controller.getEffectLayer($0.id) } }

    /// What plays live, or nil when no stroke plays a live effect.
    public var liveAnimation: PaintLiveAnimation? {
        track()
        guard let a = controller.getAnimation().objectValue else { return nil }
        return PaintLiveAnimation(
            layerIds: (a["layerIds"]?.arrayValue ?? []).compactMap(\.stringValue),
            strokes: Int(a["strokes"]?.numberValue ?? 0),
            sources: Int(a["sources"]?.numberValue ?? 0)
        )
    }

    /// Live effect playback: playing, the frame rate cap, and the moment shown (ms).
    public var effectPlayback: (playing: Bool, fps: Int, time: Double) { track(); return controller.effectPlaybackState }

    /// Runs a change that renders, showing `effectsBusy` and reporting a failure in `error`.
    @discardableResult
    func runEffect(_ work: () async throws -> Void) async -> Bool {
        error = nil
        effectsBusy = true
        defer { effectsBusy = false }
        do {
            try await work()
            return true
        } catch {
            self.error = "\(error)"
            return false
        }
    }

    /// The provider's and the painting's authored effects that `place` takes, matching `query` when it is not empty (`EffectsBrowser`).
    public func effects(for place: PaintEffectPlace, query: String = "") async -> [EffectDescription] {
        guard let provider = controller.effectsCatalog else { return [] }
        do {
            let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
            var found: [EffectDescription] = []
            for use in place.uses {
                let some = q.isEmpty ? try await provider.list(EffectSearchOptions(use: use)) : try await provider.search(q, EffectSearchOptions(use: use))
                for d in some where !found.contains(where: { $0.id == d.id }) { found.append(d) }
            }
            // Vector and motion effects draw no pixels, so no place in a painting takes them (`checkPaintEffectPlace`).
            return found.filter { effectOffered($0, place.uses) && $0.kind != "vector" && $0.kind != "motion" }
        } catch {
            self.error = "\(error)"
            return []
        }
    }

    /// The provider's description of an effect (its controls and defaults), or nil with the reason in `error`.
    public func describeProviderEffect(_ id: String) async -> EffectDescription? {
        do { return try await controller.describeEffect(id) } catch {
            self.error = "\(error)"
            return nil
        }
    }

    /// Puts an effect in `place`: the effect paper, a new effect layer, a fill or light on the active layer, or the brush's paint. One undo step (the paint is editor state).
    public func pickEffect(_ id: String, for place: PaintEffectPlace) async {
        let active = activeLayer?.id
        await runEffect {
            switch place {
            case .paper: _ = try await controller.setPaperEffect(id)
            case .layer: _ = try await controller.addEffectLayer(id)
            case .fill: _ = try await controller.fillLayerWithEffect(id)
            case .light: _ = try await controller.applyLightEffect(active, id)
            case .paint: _ = try await controller.setEffectPaint(id)
            }
        }
    }

    /// Changes the effect paper: new control values draw it again; opacity and blend change how it is drawn. One undo step.
    public func updatePaperEffect(values: JSONObject? = nil, opacity: Double? = nil, blend: String? = nil) async {
        await runEffect { _ = try await controller.updatePaperEffect(values: values, opacity: opacity, blend: blend) }
    }

    /// Removes the effect paper (one undo step).
    public func removePaperEffect() async {
        await runEffect { _ = try await controller.setPaperEffect(nil) }
    }

    /// Paints with the effect paint again with some of it changed, the rest kept: control values (merged), placement (`map`: `{ by: "canvas" | "stroke" | "path", … }`) or live.
    public func repaintEffect(values: JSONObject? = nil, map: JSONValue? = nil, live: Bool? = nil) async {
        guard let p = controller.getEffectPaint() else { return }
        var merged = p.values
        for (k, v) in values ?? [:] { merged[k] = v }
        await runEffect { _ = try await controller.setEffectPaint(p.effect, values: merged, time: p.time, map: map ?? p.map?.json, live: live ?? p.live) }
    }

    /// Stops painting with the effect: brushes paint the colour again.
    public func stopEffectPaint() { attempt { _ = try controller.setColor(controller.color) } }

    /// Draws the active effect layer again with new control values (one undo step).
    public func updateEffectLayer(values: JSONObject) async {
        guard let id = activeLayer?.id else { return }
        await runEffect { _ = try await controller.updateEffectLayer(id, values: values) }
    }

    /// Keeps the active effect layer's pixels as a plain layer (one undo step).
    public func rasterizeEffectLayer() {
        guard let id = activeLayer?.id else { return }
        attempt { _ = try controller.rasterizeEffectLayer(id) }
    }

    /// Plays or pauses live effect paint, or caps its frame rate (1…60); not an undo step.
    public func setEffectPlayback(playing: Bool? = nil, fps: Int? = nil) {
        attempt { _ = try controller.setEffectPlayback(playing: playing, fps: fps.map(Double.init)) }
    }

    /**
     * Plays live effect paint in the view (`playEffects`) until the task is cancelled (the editor
     * view runs it): a frame at most `fps` times a second, one render at a time, idle while paused,
     * while a stroke is painted, or when nothing is live. Frames are view only; the document,
     * undo and saving see the paint as it was painted.
     */
    public func runEffectClock() async {
        func nowMs() -> Double { Date().timeIntervalSinceReferenceDate * 1000 }
        let player = controller.playEffects(now: nowMs())
        while !Task.isCancelled {
            // Frames redraw the canvas, not the panels (`emittingViewFrame`).
            await player.tick(now: nowMs())
            try? await Task.sleep(nanoseconds: 16_000_000)
        }
        player.stop()
    }
}
