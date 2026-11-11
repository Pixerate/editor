import Foundation
import PixerateCore
import PixerateRaster

/**
 * Authored effects in a painting (`paint-editor/authored-effects.ts`): effects written at run time
 * (by a person or an agent) and kept in the document with their source, values, keyframes and
 * presets, so they can be used as paint, paper, effect layers and fills like a provider's catalog
 * effects, and replay on any machine without the author's session or provider. Their ids are
 * `authored.<name>`; an id never changes what it draws (saving again makes a new id), so strokes
 * painted with it keep their look.
 *
 * Pixel expression effects (`sourceLanguage: "pixel"`) render with this package's own evaluator
 * (`PixelCPURenderer`). Other documents (a provider's raw shader source) render through the
 * provider that wrote them, and only when the host allows raw shader source (`rawShaders`).
 */

/// Prefix of every authored effect id.
public let AUTHORED_PREFIX = "authored."
/// The provider id recorded with authored effects.
public let AUTHORED_PROVIDER_ID = "authored"

/**
 * What a host lets authored effects do (`AuthoredEffectsPolicy`):
 * - `off`: authored effects in documents are kept but not drawn, and nothing can be authored.
 * - `replay` (default): they are drawn, but nothing new can be authored, saved or removed.
 * - `author`: effects can be written, saved into the painting and removed.
 */
public enum AuthoredEffectsPolicy: String, CaseIterable, Sendable {
    case off, replay, author

    /// A policy by name; throws the TS core's message for anything else.
    public static func parse(_ raw: String) throws -> AuthoredEffectsPolicy {
        guard let p = AuthoredEffectsPolicy(rawValue: raw) else {
            throw PaintEditorError("authoredEffects \"\(raw)\" is not a policy; use \(allCases.map(\.rawValue).joined(separator: ", ")).")
        }
        return p
    }
}

/// Budgets that keep authored effects from stalling the editor (`AuthoredEffectLimits`); nil takes the default.
public struct AuthoredEffectLimits: Equatable, Sendable {
    /// Longest source in UTF-16 code units (default 65536).
    public var maxSourceLength: Int?
    /// Most work per pixel, in expression steps (default 1024).
    public var maxCost: Int?
    /// Side of the square trial render an effect must pass before it is saved (default 64).
    public var trialSize: Int?
    /// Most ms the trial render may take (default 100).
    public var trialRenderMs: Double?
    /// Most ms one live frame of an authored effect may take; two slow frames in a row freeze it (default 50).
    public var liveFrameMs: Double?

    public init(maxSourceLength: Int? = nil, maxCost: Int? = nil, trialSize: Int? = nil, trialRenderMs: Double? = nil, liveFrameMs: Double? = nil) {
        self.maxSourceLength = maxSourceLength
        self.maxCost = maxCost
        self.trialSize = trialSize
        self.trialRenderMs = trialRenderMs
        self.liveFrameMs = liveFrameMs
    }

    /// These limits over the defaults (`AUTHORED_DEFAULT_LIMITS`).
    var resolved: ResolvedAuthoredLimits {
        ResolvedAuthoredLimits(pixel: PixelLimits(maxSourceLength: maxSourceLength ?? 65536, maxCost: maxCost ?? 1024), trialSize: trialSize ?? 64, trialRenderMs: trialRenderMs ?? 100, liveFrameMs: liveFrameMs ?? 50)
    }
}

struct ResolvedAuthoredLimits: Equatable, Sendable {
    var pixel: PixelLimits
    var trialSize: Int
    var trialRenderMs: Double
    var liveFrameMs: Double
}

/// One authored effect in a painting (`PaintAuthoredEffect`).
public struct PaintAuthoredEffect: Equatable, Sendable {
    public var id: String
    public var name: String
    /// The saved authoring document as JSON (`EffectAuthoringDocument`: source, language, values, keyframes, presets, timing), kept as it was read.
    public var document: JSONObject

    public init(id: String, name: String, document: JSONObject) {
        self.id = id
        self.name = name
        self.document = document
    }

    /// `pixel`, `glsl`, … or nil.
    public var sourceLanguage: String? { document["sourceLanguage"]?.stringValue }
    public var providerId: String { document["providerId"]?.stringValue ?? "" }
    /// Whether it is written in pixel expressions (drawn by this package).
    public var isPixel: Bool { isPixelDocument(document) }

    /// Its keyframes by control, in the saved order.
    public var tracks: EffectTracks {
        var t = EffectTracks()
        for (k, kfs) in document["tracks"]?.objectValue ?? [:] { t[k] = (kfs.arrayValue ?? []).compactMap { EffectKeyframe(json: $0) } }
        return t
    }

    /// Controls with keyframes: they animate with the effect's time and can't be set where it is used.
    public var animatedControls: [String] {
        (document["tracks"]?.objectValue ?? [:]).filter { ($0.value.arrayValue?.count ?? 0) > 0 }.map(\.key)
    }

    /// The control values at `time` ms (`authoringValuesAt`).
    func valuesAt(_ time: Double) -> JSONObject {
        authoringValuesAt(values: document["values"]?.objectValue ?? [:], tracks: tracks, duration: document["duration"]?.numberValue ?? .nan, loop: document["loop"]?.boolValue ?? false, time)
    }
}

/// Whether an effect id is an authored effect's.
public func isAuthoredEffectId(_ id: String) -> Bool { id.hasPrefix(AUTHORED_PREFIX) }

/// A new id for `name` that `taken` doesn't have (`authored.rings`, `authored.rings-2`, …).
public func authoredEffectId(_ name: String, taken: (String) -> Bool) -> String {
    var slug = ""
    var dash = false
    for u in name.lowercased().unicodeScalars {
        if (u >= "a" && u <= "z") || (u >= "0" && u <= "9") {
            if dash && !slug.isEmpty { slug.append("-") }
            dash = false
            slug.unicodeScalars.append(u)
        } else {
            dash = true
        }
    }
    // Dashes at either end are trimmed before `.slice(0, 40)`, so a cut may still end in one, as in TS.
    slug = String(slug.prefix(40))
    if slug.isEmpty { slug = "effect" }
    var id = AUTHORED_PREFIX + slug
    var n = 2
    while taken(id) {
        id = "\(AUTHORED_PREFIX)\(slug)-\(n)"
        n += 1
    }
    return id
}

/// Authored effects as saved in the painting's JSON, or nil without any (`authoredEffectsToJSON`).
func authoredEffectsToJSON(_ map: OrderedMap<String, PaintAuthoredEffect>?) -> JSONObject? {
    guard let map, !map.isEmpty else { return nil }
    var out = JSONObject()
    for (id, e) in map { out[id] = ["name": .string(e.name), "document": .object(e.document)] }
    return out
}

/// Authored effects read back from JSON, and what could not be read (`readAuthoredEffects`).
func readAuthoredEffects(_ raw: JSONValue?) -> (effects: OrderedMap<String, PaintAuthoredEffect>, problems: [String]) {
    var effects = OrderedMap<String, PaintAuthoredEffect>()
    var problems: [String] = []
    guard let raw else { return (effects, problems) }
    guard let o = raw.objectValue else { return (effects, ["The authored effects could not be read; they were dropped."]) }
    for (id, v) in o {
        let e = v.objectValue
        guard isAuthoredEffectId(id), let e, let name = e["name"]?.stringValue, let doc = e["document"]?.objectValue, doc["version"] == .number(1), doc["providerId"]?.stringValue != nil else {
            problems.append("The authored effect \"\(id)\" could not be read; it was dropped (paint that uses it shows a placeholder).")
            continue
        }
        effects.set(id, PaintAuthoredEffect(id: id, name: name, document: doc))
    }
    return (effects, problems)
}

/// Two maps of authored effects hold the same effects in the same order.
func sameAuthoredEffects(_ a: OrderedMap<String, PaintAuthoredEffect>?, _ b: OrderedMap<String, PaintAuthoredEffect>?) -> Bool {
    let ak = a?.keys ?? [], bk = b?.keys ?? []
    return ak == bk && ak.allSatisfy { a?.get($0) == b?.get($0) }
}

/// A description without its keyframed controls; their saved values become defaults for the rest (`asUsed`).
private func authoredAsUsed(_ d: EffectDescription, _ entry: PaintAuthoredEffect) -> EffectDescription {
    let doc = entry.document
    let animated = Set(entry.animatedControls)
    var properties = JSONObject()
    var defaults = JSONObject()
    let docValues = doc["values"]?.objectValue
    for (name, schema) in d.controls["properties"]?.objectValue ?? [:] where !animated.contains(name) {
        properties[name] = schema
        let saved = docValues?[name].flatMap { $0 == .null ? nil : $0 }
        if let v = saved ?? d.defaults[name] { defaults[name] = v }
    }
    let presets: [JSONValue] = (doc["presets"]?.arrayValue ?? []).map { p in
        guard var o = p.objectValue else { return p }
        var values = JSONObject()
        for (k, v) in o["values"]?.objectValue ?? [:] where properties.contains(k) { values[k] = v }
        o["values"] = .object(values)
        return .object(o)
    }
    var o = d.json
    o["id"] = .string(entry.id)
    o["name"] = .string(entry.name)
    o["category"] = "authored"
    o["tags"] = .array(["authored"] + (entry.isPixel ? ["pixel"] : []))
    if o["description"] == nil || o["description"] == .null { o["description"] = "An effect authored in this painting." }
    o["loop"] = doc["loop"] ?? Optional<JSONValue>.none
    o["duration"] = doc["duration"] ?? Optional<JSONValue>.none
    var controls = d.controls
    controls["properties"] = .object(properties)
    o["controls"] = .object(controls)
    o["defaults"] = .object(defaults)
    o["presets"] = .array(presets)
    // The document's paint hint, while the controls left here still fit it.
    o["paint"] = Optional<JSONValue>.none
    if let paint = doc["paint"], effectPaintHintProblems(EffectDescription(o), paint: paint).isEmpty { o["paint"] = paint }
    return EffectDescription(o)
}

private let AUTHORED_CAPABILITIES: JSONObject = [
    "supportsWorker": false, "supportsFloat": false, "supportsMask": false, "supportsHostImages": false, "supportsVector": false, "supportsAuthoring": false, "maxSize": 8192,
]

/// The control values an authored effect renders with at `time`: keyframed controls follow the document's tracks.
private func authoredValues(_ e: PaintAuthoredEffect, _ d: EffectDescription, _ time: Double, _ given: JSONObject?) -> JSONObject {
    let at = e.valuesAt(time)
    var v = at
    for (k, x) in d.defaults { v[k] = x }
    for (k, x) in given ?? [:] { v[k] = x }
    for name in e.animatedControls { v[name] = at[name] ?? Optional<JSONValue>.none }
    return v
}

/// A pixel authored effect's renderer: the keyframed values at each request's time, then the inner renderer.
final class AuthoredSyncRenderer: SyncEffectRenderer {
    let inner: SyncEffectRenderer
    let entry: PaintAuthoredEffect
    let used: EffectDescription
    var effectId: String { entry.id }
    var width: Int { inner.width }
    var height: Int { inner.height }

    init(_ inner: SyncEffectRenderer, _ entry: PaintAuthoredEffect, _ used: EffectDescription) {
        self.inner = inner
        self.entry = entry
        self.used = used
    }

    private func request(_ r: EffectRenderRequest) -> EffectRenderRequest {
        var x = r
        x.values = authoredValues(entry, used, r.time, r.values)
        return x
    }

    func renderSync(_ r: EffectRenderRequest) throws -> EffectPixels { try inner.renderSync(request(r)) }
    func render(_ r: EffectRenderRequest) async throws -> EffectPixels { try inner.renderSync(request(r)) }
    func dispose() { inner.dispose() }
}

/// A raw shader authored effect's renderer: opens the provider's session on the first render.
final class AuthoredSessionRenderer: EffectRenderer {
    let entry: PaintAuthoredEffect
    let width: Int
    let height: Int
    var effectId: String { entry.id }
    private let open: () async throws -> EffectAuthoringSession
    private var inner: EffectRenderer?
    private var used: EffectDescription?
    private var disposed = false

    init(_ entry: PaintAuthoredEffect, width: Int, height: Int, open: @escaping () async throws -> EffectAuthoringSession) {
        self.entry = entry
        self.width = width
        self.height = height
        self.open = open
    }

    func render(_ r: EffectRenderRequest) async throws -> EffectPixels {
        if disposed { throw EffectError("disposed", "The renderer for \"\(effectId)\" was disposed. Create a new renderer.", effectId: effectId) }
        if inner == nil {
            let s = try await open()
            used = authoredAsUsed(s.getState().description, entry)
            inner = try await s.createPreview(width: width, height: height)
        }
        var x = r
        x.values = authoredValues(entry, used!, r.time, r.values)
        return try await inner!.render(x)
    }

    func dispose() {
        disposed = true
        inner?.dispose()
    }
}

/**
 * The painting's authored effects as an effects provider (id `authored`), so every place that
 * draws a provider effect can draw them (`createAuthoredEffectsProvider`). Made anew whenever the
 * authored effects change.
 */
public final class AuthoredEffectsProvider: EffectProvider {
    public let id = AUTHORED_PROVIDER_ID
    public let name = "Authored effects"
    public let capabilities: JSONObject = AUTHORED_CAPABILITIES
    public let effects: OrderedMap<String, PaintAuthoredEffect>
    let policy: AuthoredEffectsPolicy
    let rawShaders: Bool
    let host: () -> EffectProvider?
    let limits: ResolvedAuthoredLimits
    private var sessions: [String: EffectAuthoringSession] = [:]

    init(_ effects: OrderedMap<String, PaintAuthoredEffect>, policy: AuthoredEffectsPolicy, rawShaders: Bool, host: @escaping () -> EffectProvider?, limits: ResolvedAuthoredLimits) {
        self.effects = effects
        self.policy = policy
        self.rawShaders = rawShaders
        self.host = host
        self.limits = limits
    }

    func entryOf(_ id: String) throws -> PaintAuthoredEffect {
        guard let e = effects.get(id) else {
            let ids = effects.keys
            throw EffectError.unknown(id, in: "this painting's authored effects (\(ids.isEmpty ? "none" : ids.joined(separator: ", ")); list_authored_effects lists them)")
        }
        if policy == .off { throw EffectError.unsupported("Authored effects are turned off in this editor (authoredEffects: \"off\"), so \"\(id)\" (\(e.name)) is not drawn.", id) }
        return e
    }

    /// The provider that draws a raw shader document, refusing as the TS core does.
    private func rawHost(_ e: PaintAuthoredEffect) throws -> AuthoringEffectProvider {
        let lang = e.sourceLanguage ?? "no source"
        if !rawShaders {
            throw EffectError.unsupported("\"\(e.id)\" (\(e.name)) is written in \(lang) for the provider \"\(e.providerId)\"; this editor draws only pixel expression effects (raw shader source needs rawShaders: true).", e.id)
        }
        let h = host()
        guard let h, h.id == e.providerId, let a = h as? AuthoringEffectProvider else {
            throw EffectError.unsupported("\"\(e.id)\" (\(e.name)) needs the provider \"\(e.providerId)\" with authoring; \(h.map { "the registered provider is \"\($0.id)\"" } ?? "no provider is registered").", e.id)
        }
        return a
    }

    private func rawSession(_ e: PaintAuthoredEffect) async throws -> EffectAuthoringSession {
        let h = try rawHost(e)
        if let s = sessions[e.id] { return s }
        let s = try await h.openAuthoring(.document(.object(e.document)))
        sessions[e.id] = s
        return s
    }

    /// A pixel document's compiled program and description as used (sync).
    private func pixel(_ e: PaintAuthoredEffect) throws -> (program: PixelProgram, description: EffectDescription, used: EffectDescription) {
        let r = describePixelSource(e.document["source"]?.stringValue ?? "", meta: PixelEffectMeta(id: e.id, name: e.name), limits: limits.pixel)
        guard let d = r.description, let p = r.program else { throw EffectError.unsupported("\"\(e.id)\" (\(e.name)) doesn't compile: \(pixelIssueText(r.issues)).", e.id) }
        return (p, d, authoredAsUsed(d, e))
    }

    public func describe(_ id: String) async throws -> EffectDescription {
        let e = try entryOf(id)
        if e.isPixel { return try pixel(e).used }
        return authoredAsUsed(try await rawSession(e).getState().description, e)
    }

    private func summaries() async -> [EffectDescription] {
        var out: [EffectDescription] = []
        // Not drawable here (policy, raw source, a broken document): list_authored_effects says why.
        for id in effects.keys { if let d = try? await describe(id) { out.append(d.summary) } }
        return out
    }

    public func list(_ options: EffectSearchOptions) async throws -> [EffectDescription] { searchEffectSummaries(await summaries(), "", options) }
    public func search(_ query: String, _ options: EffectSearchOptions) async throws -> [EffectDescription] { searchEffectSummaries(await summaries(), query, options) }

    public func createRenderer(_ id: String, width: Int, height: Int) throws -> EffectRenderer {
        try createRenderer(id, width: width, height: height, gpu: false)
    }

    /// A renderer; `gpu` draws a pixel expression effect with Metal when the device has it (falling back to the CPU).
    func createRenderer(_ id: String, width: Int, height: Int, gpu: Bool) throws -> EffectRenderer {
        let e = try entryOf(id)
        if e.isPixel {
            let p = try pixel(e)
            var inner: SyncEffectRenderer = PixelCPURenderer(program: p.program, description: p.description, width: width, height: height)
            #if canImport(Metal)
            if gpu, PixelGPU.isAvailable, let m = try? PixelMetalRenderer(program: p.program, description: p.description, width: width, height: height) { inner = m }
            #endif
            return AuthoredSyncRenderer(inner, e, p.used)
        }
        _ = try rawHost(e)
        return AuthoredSessionRenderer(e, width: width, height: height) { [weak self] in
            guard let self else { throw EffectError("disposed", "The authored effects changed; render \"\(id)\" again.", effectId: id) }
            return try await self.rawSession(e)
        }
    }

    /// Disposes the raw shader sessions it opened.
    public func dispose() {
        for s in sessions.values { s.dispose() }
        sessions = [:]
    }
}

/**
 * The provider the paint tools search and describe with (`withAuthoredEffects`): the editor's
 * provider, with the painting's authored effects added to its lists and routed by id. It keeps the
 * editor provider's id, name and capabilities.
 */
public final class AuthoredEffectsCatalog: EffectProvider {
    /// The editor's provider, or nil.
    public let host: EffectProvider?
    public let authored: AuthoredEffectsProvider
    private let hasAuthored: Bool

    init(host: EffectProvider?, authored: AuthoredEffectsProvider, hasAuthored: Bool) {
        self.host = host
        self.authored = authored
        self.hasAuthored = hasAuthored
    }

    public var id: String { host?.id ?? AUTHORED_PROVIDER_ID }
    public var name: String { host?.name ?? "Authored effects" }
    public var capabilities: JSONObject { host?.capabilities ?? AUTHORED_CAPABILITIES }

    public func list(_ options: EffectSearchOptions) async throws -> [EffectDescription] {
        let base = try await host?.list(options) ?? []
        return base + (hasAuthored ? try await authored.list(options) : [])
    }

    public func search(_ query: String, _ options: EffectSearchOptions) async throws -> [EffectDescription] {
        let base = try await host?.search(query, options) ?? []
        return base + (hasAuthored ? try await authored.search(query, options) : [])
    }

    public func describe(_ id: String) async throws -> EffectDescription {
        if isAuthoredEffectId(id) || host == nil { return try await authored.describe(id) }
        return try await host!.describe(id)
    }

    public func createRenderer(_ id: String, width: Int, height: Int) throws -> EffectRenderer {
        if isAuthoredEffectId(id) || host == nil { return try authored.createRenderer(id, width: width, height: height) }
        return try host!.createRenderer(id, width: width, height: height)
    }
}

/// The time now in ms, for budgets (`authoredNow`).
func authoredNow() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e6 }

/// Renders `trialSize`² once and times it: the check an effect passes before it is saved (`trialRender`).
func authoredTrialRender(_ provider: AuthoredEffectsProvider, _ id: String, _ limits: ResolvedAuthoredLimits) async throws -> (ms: Double, problem: String?) {
    let size = limits.trialSize
    let r = try provider.createRenderer(id, width: size, height: size)
    defer { r.dispose() }
    let t0 = authoredNow()
    let out: EffectPixels
    if let sync = r as? SyncEffectRenderer { out = try sync.renderSync(EffectRenderRequest(time: 0)) } else { out = try await r.render(EffectRenderRequest(time: 0)) }
    let ms = authoredNow() - t0
    if out.data.count != size * size * 4 { return (ms, "the trial render returned the wrong number of pixels") }
    if ms >= limits.trialRenderMs {
        return (ms, "a \(size)×\(size) trial render took \(jsText(JS.round(ms))) ms; the limit is \(jsText(limits.trialRenderMs)) ms. Simplify the effect (fewer noise calls, more let sharing)")
    }
    return (ms, nil)
}
