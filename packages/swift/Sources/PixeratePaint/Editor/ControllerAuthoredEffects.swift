import Foundation
import PixerateCore
import PixerateRaster

/// Where an authored effect is used (`authoredEffectUses`): by strokes, the effect paint, the effect paper and effect layers.
public struct AuthoredEffectUses: Equatable, Sendable {
    public var strokes: Int
    public var paint: Bool
    public var paper: Bool
    public var layers: [String]

    public var json: JSONValue {
        ["strokes": .number(Double(strokes)), "paint": .bool(paint), "paper": .bool(paper), "layers": .array(layers.map { .string($0) })]
    }
}

/// One of the painting's authored effects as `list_authored_effects` reports it.
public struct AuthoredEffectInfo: Sendable {
    public var id: String
    public var name: String
    /// The source language (`pixel`, `glsl`, …), or nil.
    public var language: String?
    /// The controls that can be set where it is used.
    public var controls: [String]
    /// The keyframed controls (they follow the effect's time).
    public var animated: [String]
    /// The saved duration (ms) and loop, as saved.
    public var duration: JSONValue?
    public var loop: JSONValue?
    public var uses: AuthoredEffectUses
    /// Why it can't draw here (the policy, raw shader source, a stopped live playback), or nil.
    public var problem: String?

    public var json: JSONObject {
        var o: JSONObject = ["id": .string(id), "name": .string(name), "language": language.map { .string($0) } ?? .null, "controls": .array(controls.map { .string($0) }), "animated": .array(animated.map { .string($0) })]
        if let duration { o["duration"] = duration }
        if let loop { o["loop"] = loop }
        o["uses"] = uses.json
        if let problem { o["problem"] = .string(problem) }
        return o
    }
}

/**
 * Authored effects in the paint editor (the controller's "Authored effects" section in
 * `controller.ts`): the provider of the painting's authored effects, the catalog the effect tools
 * search, the one effect authoring session, saving (after a trial render), listing and removing,
 * and the live frame budget.
 */
extension PaintEditorController {
    /// The painting's authored effects (`authored.<name>` id → effect), or an empty map.
    public var authoredEffects: OrderedMap<String, PaintAuthoredEffect> { doc.authoredEffects ?? OrderedMap() }

    /// The painting's authored effects as a provider (`authored.*` ids), made anew when they change.
    func authoredProvider() -> AuthoredEffectsProvider {
        let of = doc.authoredEffects
        if let c = authoredCache, sameAuthoredEffects(c.of, of) { return c.provider }
        authoredCache?.provider.dispose()
        let p = AuthoredEffectsProvider(of ?? OrderedMap(), policy: authoredPolicy, rawShaders: rawShaders, host: { [weak self] in self?.effectsProvider }, limits: authoredLimits)
        authoredCache = (of, p)
        return p
    }

    /// The provider that draws `effect`: the painting's authored effects, or the registered provider.
    func providerFor(_ effect: String) throws -> EffectProvider {
        isAuthoredEffectId(effect) ? authoredProvider() : try requireEffectsProvider()
    }

    /**
     * What the effect tools search and describe with (`effectsCatalog`): the registered provider (its
     * id, name and capabilities) with the painting's authored effects added. Nil with neither.
     */
    public var effectsCatalog: EffectProvider? {
        let host = effectsProvider
        let authored = authoredProvider()
        let has = !(doc.authoredEffects?.isEmpty ?? true)
        if let c = catalogCache, c.host === host, c.authored === authored, c.has == has { return c.catalog }
        let catalog: EffectProvider? = host == nil && !has ? nil : AuthoredEffectsCatalog(host: host, authored: authored, hasAuthored: has)
        catalogCache = (host, authored, has, catalog)
        return catalog
    }

    /// A live frame of `p` at `t` ms on: authored effects whose live playback was stopped stay at their own time.
    func framePaint(_ p: PaintEffectPaint, _ t: Double) -> PaintEffectPaint {
        frozenAuthored[p.effect] != nil ? p : liveEffectFrame(p, t)
    }

    /// Two live frames of an authored effect over budget in a row stop its live playback.
    func noteLiveFrame(_ effect: String, _ ms: Double) {
        if !timingLiveFrames || !isAuthoredEffectId(effect) || frozenAuthored[effect] != nil { return }
        if ms < authoredLimits.liveFrameMs {
            slowAuthoredFrames[effect] = nil
            return
        }
        let n = (slowAuthoredFrames[effect] ?? 0) + 1
        slowAuthoredFrames[effect] = n
        if n >= 2 {
            frozenAuthored[effect] = "live playback stopped: frames took \(jsText(JS.round(ms))) ms, over the \(jsText(authoredLimits.liveFrameMs)) ms budget; strokes keep the frame they were painted with"
        }
    }

    private func requireAuthoring(_ what: String) throws {
        if authoredPolicy != .author {
            throw PaintEditorError("This editor doesn't allow authoring effects (authoredEffects: \"\(authoredPolicy.rawValue)\"), so it can't \(what). Authored effects already in the painting \(authoredPolicy == .off ? "are not drawn either" : "still draw"); use the provider's effects (search_effects) instead.")
        }
    }

    /// The open effect authoring session, or nil.
    public var authoringSession: EffectAuthoringSession? { authoring?.session }

    /// What the open authoring session was opened from (a template, an authored effect or a provider effect id), or nil.
    public var authoringFrom: String? { authoring?.from }

    /// Calls `listener` when an authoring session opens or closes.
    public func subscribeAuthoring(_ listener: @escaping () -> Void) -> Cancellable {
        let id = UUID()
        authoringListeners[id] = listener
        return Cancellable { [weak self] in self?.authoringListeners[id] = nil }
    }

    private func setAuthoring(_ next: (session: EffectAuthoringSession, from: String)?) {
        authoring = next
        for l in Array(authoringListeners.values) { l() }
        emit([])
    }

    /**
     * Opens an effect for authoring: a pixel expression template (`pixel.blank`, `pixel.rings`,
     * `pixel.clouds`; source editing), one of the painting's authored effects (a copy: saving makes
     * a new id), or the registered provider's effect when it supports authoring (values, keyframes
     * and presets). One session at a time. Not an undo step.
     */
    @discardableResult
    public func openEffectAuthoring(_ effect: String) async throws -> EffectAuthoringSession {
        try requireAuthoring("open an effect for authoring")
        if effect.isEmpty { throw PaintEditorError("effect is missing; pass a template (pixel.blank, pixel.rings, pixel.clouds), an authored effect id (list_authored_effects) or a provider effect id.") }
        if let a = authoring {
            throw PaintEditorError("An effect is already open for authoring (\(a.session.getState().name), from \"\(a.from)\"); save it (save_authored_effect) or close it (close_effect_authoring) first.")
        }
        let pixel = PixelEffectProvider(limits: authoredLimits.pixel)
        let session: EffectAuthoringSession
        if effect.hasPrefix("pixel.") {
            if pixelTemplate(effect) == nil { throw PaintEditorError("There is no template \"\(effect)\"; the templates are \(PIXEL_TEMPLATES.map(\.id).joined(separator: ", ")).") }
            session = try await pixel.openAuthoring(.effect(effect))
        } else if isAuthoredEffectId(effect) {
            guard let e = doc.authoredEffects?.get(effect) else {
                throw PaintEditorError("The painting has no authored effect \"\(effect)\"; it has \(authoredIdsText()) (list_authored_effects).")
            }
            if e.isPixel {
                session = try await pixel.openAuthoring(.document(.object(e.document)))
            } else {
                guard rawShaders, let host = effectsProvider as? AuthoringEffectProvider, host.id == e.providerId else {
                    throw PaintEditorError("\"\(effect)\" is written in \(e.sourceLanguage ?? "a provider format") for \"\(e.providerId)\"; it opens only with that provider registered and rawShaders allowed.")
                }
                session = try await host.openAuthoring(.document(.object(e.document)))
            }
        } else {
            let host = try requireEffectsProvider()
            guard let a = host as? AuthoringEffectProvider, host.capabilities["supportsAuthoring"] == .bool(true) else {
                throw PaintEditorError("The provider \"\(host.id)\" can't open effects for authoring; start from a template instead (pixel.blank, pixel.rings, pixel.clouds).")
            }
            session = try await a.openAuthoring(.effect(effect))
        }
        setAuthoring((session, effect))
        return session
    }

    private func authoredIdsText() -> String {
        let ids = doc.authoredEffects?.keys ?? []
        return ids.isEmpty ? "none" : ids.joined(separator: ", ")
    }

    /// Closes the authoring session without saving (nothing in the painting changes). Returns its name, or nil when none was open.
    @discardableResult
    public func closeEffectAuthoring() -> String? {
        guard let a = authoring else { return nil }
        let name = a.session.getState().name
        a.session.dispose()
        setAuthoring(nil)
        return name
    }

    /**
     * Saves the open session's effect into the painting under a new `authored.<name>` id, after a
     * trial render within budget: the source must compile now. One undo step. The session stays
     * open, so it can be changed and saved again (as another id). Returns the effect and the trial
     * render's ms.
     */
    @discardableResult
    public func saveAuthoredEffect(name nameIn: String? = nil) async throws -> (effect: PaintAuthoredEffect, trialMs: Double) {
        try requireAuthoring("save an authored effect")
        guard let a = authoring else { throw PaintEditorError("No effect is open for authoring; open one with open_effect_authoring (e.g. pixel.blank), write it, then save it.") }
        if let n = nameIn, n.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw PaintEditorError("name must be a non-empty string.") }
        let state = a.session.getState()
        if state.compiled == false {
            let errors = state.issues.filter { $0.severity == "error" }.map { i in i.line.map { "line \($0): \(i.message)" } ?? i.message }
            throw PaintEditorError("The effect doesn't compile, so it can't be saved: \(errors.joined(separator: "; ")). Fix the source (effect_authoring_set_source) and save again.")
        }
        var document = a.session.exportDocument().json
        if !isPixelDocument(document) && !rawShaders {
            throw PaintEditorError("\"\(state.name)\" isn't written in pixel expressions; only pixel expression effects can be saved here (raw shader source needs rawShaders: true). Start from a template (pixel.blank).")
        }
        let name = (nameIn ?? state.name).trimmingCharacters(in: .whitespacesAndNewlines)
        let existing = doc.authoredEffects ?? OrderedMap()
        let id = authoredEffectId(name) { existing.has($0) }
        document["name"] = .string(name)
        let entry = PaintAuthoredEffect(id: id, name: name, document: document)
        var next = existing
        next.set(id, entry)
        let provider = AuthoredEffectsProvider(next, policy: authoredPolicy, rawShaders: rawShaders, host: { [weak self] in self?.effectsProvider }, limits: authoredLimits)
        defer { provider.dispose() }
        let trial: (ms: Double, problem: String?)
        do {
            trial = try await authoredTrialRender(provider, id, authoredLimits)
        } catch {
            throw PaintEditorError("\"\(name)\" failed its trial render (\(errorMessage(error))), so it was not saved.")
        }
        if let problem = trial.problem { throw PaintEditorError("\"\(name)\" was not saved: \(problem).") }
        commit("Save authored effect", doc.with { $0.authoredEffects = next })
        return (entry, trial.ms)
    }

    /// Where an authored effect is used: by strokes, the effect paint, the effect paper and effect layers.
    public func authoredEffectUses(_ id: String) -> AuthoredEffectUses {
        var strokes = 0
        for st in doc.strokes where st.effect?.effect == id { strokes += 1 }
        for list in (doc.liveStrokes ?? OrderedMap()).values { for st in list where st.effect?.effect == id { strokes += 1 } }
        let paint = (effectPaintPending ?? effectPaint)?.effect == id
        let paper = doc.paperEffect?.source.effect == id
        let layers = (doc.effectLayers ?? OrderedMap()).keys.filter { doc.effectLayers?.get($0)?.effect == id }
        return AuthoredEffectUses(strokes: strokes, paint: paint, paper: paper, layers: layers)
    }

    /// The painting's authored effects, with where each is used and anything stopping it from drawing.
    public func listAuthoredEffects() async -> [AuthoredEffectInfo] {
        var out: [AuthoredEffectInfo] = []
        for e in authoredEffects.values {
            var controls: [String] = []
            var problem = frozenAuthored[e.id]
            do {
                controls = try await authoredProvider().describe(e.id).controlNames
            } catch {
                problem = errorMessage(error)
            }
            out.append(AuthoredEffectInfo(id: e.id, name: e.name, language: e.sourceLanguage, controls: controls, animated: e.animatedControls, duration: e.document["duration"], loop: e.document["loop"], uses: authoredEffectUses(e.id), problem: problem))
        }
        return out
    }

    /// Removes an authored effect the painting no longer uses (refused, saying where, while it is). One undo step.
    @discardableResult
    public func removeAuthoredEffect(_ id: String) throws -> (removed: String, name: String) {
        try requireAuthoring("remove an authored effect")
        guard let e = doc.authoredEffects?.get(id) else { throw PaintEditorError("The painting has no authored effect \"\(id)\"; it has \(authoredIdsText()) (list_authored_effects).") }
        let u = authoredEffectUses(id)
        var whereUsed: [String] = []
        if u.strokes > 0 { whereUsed.append("\(u.strokes) stroke\(u.strokes == 1 ? "" : "s")") }
        if u.paint { whereUsed.append("the effect paint") }
        if u.paper { whereUsed.append("the effect paper") }
        whereUsed += u.layers.map { "effect layer \"\($0)\"" }
        if !whereUsed.isEmpty { throw PaintEditorError("\"\(id)\" (\(e.name)) is still used by \(whereUsed.joined(separator: ", ")); remove those first (or rasterize the layers), then remove it.") }
        var rest = doc.authoredEffects!
        _ = rest.delete(id)
        commit("Remove authored effect", doc.with { $0.authoredEffects = rest.isEmpty ? nil : rest })
        return (id, e.name)
    }
}
