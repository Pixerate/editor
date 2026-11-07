import Foundation
import PixerateCore
import PixerateRaster

/**
 * Provider effects (`effects/types.ts`, `helpers.ts`, `errors.ts`): the interface an effects
 * provider implements (a catalog of effects described by JSON Schema controls, and renderers that
 * draw them into pixels), the errors it throws, and the helpers editors and providers share
 * (value validation, catalog search, tags). Effects themselves come from the host: the editor
 * draws whatever its provider renders. `FakeEffectProvider` is a small deterministic one.
 *
 * Descriptions and summaries are JSON objects with the TS core's fields (`id`, `name`, `kind`,
 * `category`, `uses`, `description`, `tags`, `transparent`, `loop`, `duration`, and for a
 * description `controls`, `defaults`, `presets`, `inputs`), so tool results match it.
 */

/// What went wrong in an effects provider (`EffectError`); `code` is `unknown_effect`, `invalid_values`, `unsupported`, `disposed` or `no_provider`.
public struct EffectError: Error, LocalizedError {
    public let code: String
    public let message: String
    public let effectId: String?
    public init(_ code: String, _ message: String, effectId: String? = nil) {
        self.code = code
        self.message = message
        self.effectId = effectId
    }
    public var errorDescription: String? { message }

    /// `UnknownEffectError`.
    public static func unknown(_ id: String, in provider: String? = nil) -> EffectError {
        EffectError("unknown_effect", "Unknown effect \"\(id)\"\(provider.map { " in \($0)" } ?? ""). Call search_effects or list() for valid ids.", effectId: id)
    }

    /// `EffectUnsupportedError`.
    public static func unsupported(_ message: String, _ id: String? = nil) -> EffectError { EffectError("unsupported", message, effectId: id) }
}

/// An effect's catalog entry or full description, as JSON with the TS core's fields.
public struct EffectDescription: Sendable {
    public let json: JSONObject
    public init(_ json: JSONObject) { self.json = json }

    public var id: String { json["id"]?.stringValue ?? "" }
    public var name: String { json["name"]?.stringValue ?? id }
    /// `shader`, `vector`, `motion`, `camera` or `timing`.
    public var kind: String { json["kind"]?.stringValue ?? "shader" }
    public var category: String { json["category"]?.stringValue ?? "" }
    /// What it is for: `filter`, `transition`, `generator`, `overlay`, `title`, `motion`, …
    public var uses: [String] { (json["uses"]?.arrayValue ?? []).compactMap(\.stringValue) }
    public var tags: [String] { (json["tags"]?.arrayValue ?? []).compactMap(\.stringValue) }
    public var duration: Double? { json["duration"]?.numberValue }
    /// The controls as a JSON Schema object.
    public var controls: JSONObject { json["controls"]?.objectValue ?? ["type": "object", "properties": .object([:])] }
    public var controlNames: [String] { (controls["properties"]?.objectValue ?? [:]).keys }
    public var defaults: JSONObject { json["defaults"]?.objectValue ?? [:] }
    /// Inputs: `[{ name, kind, description, required }]`.
    public var inputs: [JSONObject] { (json["inputs"]?.arrayValue ?? []).compactMap(\.objectValue) }

    /// The summary part (`EffectSummary`): the description without controls, defaults, presets and inputs.
    public var summary: EffectDescription {
        var o = json
        for k in ["controls", "defaults", "presets", "inputs"] { o[k] = Optional<JSONValue>.none }
        return EffectDescription(o)
    }
}

/// Straight-alpha 8-bit RGBA pixels (`EffectPixels`).
public struct EffectPixels: Sendable {
    public var width: Int
    public var height: Int
    public var data: [UInt8]
    public init(width: Int, height: Int, data: [UInt8]? = nil) {
        self.width = width
        self.height = height
        self.data = data ?? [UInt8](repeating: 0, count: Swift.max(0, width * height * 4))
    }
}

/// One frame to render (`EffectRenderRequest`).
public struct EffectRenderRequest: Sendable {
    /// Ms into the effect.
    public var time: Double
    /// Control values over the effect's defaults.
    public var values: JSONObject?
    /// Image inputs by name (a filter's `source`).
    public var inputs: [String: EffectPixels]
    /// A transition's progress 0..1.
    public var progress: Double?
    /// Where the effect applies (its alpha).
    public var mask: EffectPixels?
    public init(time: Double = 0, values: JSONObject? = nil, inputs: [String: EffectPixels] = [:], progress: Double? = nil, mask: EffectPixels? = nil) {
        self.time = time
        self.values = values
        self.inputs = inputs
        self.progress = progress
        self.mask = mask
    }
}

/// Search filters (`EffectSearchOptions`).
public struct EffectSearchOptions: Sendable {
    public var kind: String?
    public var category: String?
    public var use: String?
    public var tags: [String]?
    public var accepts: [String]?
    public var limit: Int?
    public init(kind: String? = nil, category: String? = nil, use: String? = nil, tags: [String]? = nil, accepts: [String]? = nil, limit: Int? = nil) {
        self.kind = kind
        self.category = category
        self.use = use
        self.tags = tags
        self.accepts = accepts
        self.limit = limit
    }
}

/// Draws one effect at a fixed size (`EffectRenderer`).
public protocol EffectRenderer: AnyObject {
    var effectId: String { get }
    var width: Int { get }
    var height: Int { get }
    func render(_ request: EffectRenderRequest) async throws -> EffectPixels
    func dispose()
}

/// An effect renderer that can also render synchronously on the caller's thread (`SyncEffectRenderer`).
public protocol SyncEffectRenderer: EffectRenderer {
    func renderSync(_ request: EffectRenderRequest) throws -> EffectPixels
}

/**
 * An effects provider (`EffectProvider`): its catalog (`list`, `search`, `describe`) and renderers.
 * Editors call it from the main actor; a provider that renders elsewhere (Metal, a worker) awaits
 * inside `render`.
 */
public protocol EffectProvider: AnyObject {
    var id: String { get }
    var name: String { get }
    /// What it can do (`supportsMask`, `supportsFloat`, `maxSize`, …), as the TS core reports it.
    var capabilities: JSONObject { get }
    func list(_ options: EffectSearchOptions) async throws -> [EffectDescription]
    func search(_ query: String, _ options: EffectSearchOptions) async throws -> [EffectDescription]
    func describe(_ id: String) async throws -> EffectDescription
    func createRenderer(_ id: String, width: Int, height: Int) throws -> EffectRenderer
}

extension EffectProvider {
    public func list() async throws -> [EffectDescription] { try await list(EffectSearchOptions()) }
}

/// One animated element of a vector effect's picture (`EffectSvgAnimation`): the element's id and its attribute keyframes.
public typealias EffectSvgAnimation = JSONObject

/// What a vector or motion effect gives back (`EffectVectorMotion`): SVG markup and how it animates.
public struct EffectVectorMotion: Sendable {
    public var svg: String
    /// `{ id, delay?, ms, attrs }` per animated element.
    public var animate: [EffectSvgAnimation]
    /// Length of one play (ms).
    public var duration: Double
    public var loop: Bool
    /// Ms held on the last frame before looping.
    public var hold: Double?
    public init(svg: String, animate: [EffectSvgAnimation] = [], duration: Double, loop: Bool, hold: Double? = nil) {
        self.svg = svg
        self.animate = animate
        self.duration = duration
        self.loop = loop
        self.hold = hold
    }
}

/// What a vector or motion effect is applied to (`EffectVectorTarget`): SVG markup, optionally with the ids of the elements to animate (default: all).
public struct EffectVectorTarget: Sendable {
    public var svg: String
    public var nodeIds: [String]?
    public init(svg: String, nodeIds: [String]? = nil) {
        self.svg = svg
        self.nodeIds = nodeIds
    }
}

/**
 * A provider with vector effects (`EffectProvider.applyVectorEffect`, `capabilities.supportsVector`):
 * a `vector` effect brings its own picture, a `motion` effect animates the target's. Unknown ids
 * throw `unknown_effect`, invalid values `invalid_values`, other kinds `unsupported`.
 */
public protocol VectorEffectProvider: EffectProvider {
    func applyVectorEffect(_ id: String, target: EffectVectorTarget, values: JSONObject?) async throws -> EffectVectorMotion
}

// MARK: - Helpers

/// Problems with `values` against an effect's control schema (partial values are fine).
public func effectValueErrors(_ d: EffectDescription, _ values: JSONObject?) -> [SchemaValidationError] {
    guard let values else { return [] }
    var schema = d.controls
    schema["required"] = []
    return validateJSONSchema(.object(values), .object(schema))
}

/// `values` over the effect's defaults, validated against its controls (`resolveEffectValues`); throws naming every bad control.
public func resolveEffectValues(_ d: EffectDescription, _ values: JSONObject?) throws -> JSONObject {
    let errors = effectValueErrors(d, values)
    if !errors.isEmpty {
        let lines = errors.map { "- \($0.path.isEmpty ? "/" : $0.path): \($0.message)" }.joined(separator: "\n")
        throw EffectError("invalid_values", "Invalid values for effect \"\(d.id)\":\n\(lines)", effectId: d.id)
    }
    var out = d.defaults
    for (k, v) in values ?? [:] { out[k] = v }
    return out
}

private let PIXELLESS_KINDS = ["motion", "camera", "timing"]

/// Whether an editor offering `uses` should offer `e` (`effectOffered`).
public func effectOffered(_ e: EffectDescription, _ uses: [String]?) -> Bool {
    let pixelless = PIXELLESS_KINDS.contains(e.kind)
    guard let uses else { return !pixelless }
    if pixelless && !uses.contains(e.kind) { return false }
    return e.uses.contains { uses.contains($0) }
}

/// A tag as tags are compared: trimmed, lower case, spaces, underscores and hyphens as single hyphens.
public func normaliseEffectTag(_ tag: String) -> String {
    tag.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().replacingOccurrences(of: "[\\s_-]+", with: "-", options: .regularExpression)
}

/// Whether the effect carries every one of `tags`.
public func hasEffectTags(_ e: EffectDescription, _ tags: [String]?) -> Bool {
    guard let tags, !tags.isEmpty else { return true }
    let own = Set(e.tags.map(normaliseEffectTag))
    return tags.allSatisfy { own.contains(normaliseEffectTag($0)) }
}

/// The tags of `effects` with how many carry each, the most used first (ties alphabetical).
public func countEffectTags(_ effects: [EffectDescription]) -> [(tag: String, count: Int)] {
    var counts: [(String, Int)] = []
    for e in effects {
        var seen = Set<String>()
        for t in e.tags.map(normaliseEffectTag) where !t.isEmpty && seen.insert(t).inserted {
            if let i = counts.firstIndex(where: { $0.0 == t }) { counts[i].1 += 1 } else { counts.append((t, 1)) }
        }
    }
    return counts.sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0 < $1.0 }.map { (tag: $0.0, count: $0.1) }
}

/// The controls that draw along a path given at run time (`format: "svg-path"`).
public func pathControlsOf(_ d: EffectDescription) -> [String] {
    func isPath(_ s: JSONValue?) -> Bool {
        guard let o = s?.objectValue else { return false }
        if o["format"]?.stringValue == "svg-path" { return true }
        return ((o["anyOf"]?.arrayValue ?? []) + (o["oneOf"]?.arrayValue ?? [])).contains { isPath($0) }
    }
    let props = d.controls["properties"]?.objectValue ?? [:]
    return props.keys.filter { isPath(props[$0]) }
}

/// The image input an editor feeds a layer to (`layerImageInput`), or nil.
public func layerImageInput(_ d: EffectDescription) -> String? {
    let images = d.inputs.filter { $0["kind"]?.stringValue == "image" }
    return (images.first { $0["name"]?.stringValue == "source" } ?? images.first { $0["required"] == .bool(true) } ?? images.first)?["name"]?.stringValue
}

/// Filters a catalog and ranks it against `query` (`searchEffectSummaries`).
public func searchEffectSummaries(_ catalog: [EffectDescription], _ query: String = "", _ o: EffectSearchOptions = EffectSearchOptions()) -> [EffectDescription] {
    let words = query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
    var scored: [(e: EffectDescription, score: Int, i: Int)] = []
    for (i, e) in catalog.enumerated() {
        if let k = o.kind, e.kind != k { continue }
        if let c = o.category, e.category != c { continue }
        if let u = o.use, !e.uses.contains(u) { continue }
        if !hasEffectTags(e, o.tags) { continue }
        if let a = o.accepts, !a.isEmpty {
            let acc = (e.json["accepts"]?.arrayValue ?? []).compactMap(\.stringValue)
            if !a.allSatisfy(acc.contains) { continue }
        }
        let name = e.name.lowercased()
        let hay = ([e.id, e.name, e.category] + e.tags + [e.json["description"]?.stringValue ?? ""]).joined(separator: " ").lowercased()
        var score = 0
        var ok = true
        for w in words {
            if !hay.contains(w) { ok = false; break }
            score += name.hasPrefix(w) ? 3 : name.contains(w) ? 2 : 1
        }
        if ok { scored.append((e, score, i)) }
    }
    scored.sort { $0.score != $1.score ? $0.score > $1.score : $0.i < $1.i }
    let out = scored.map(\.e)
    if let limit = o.limit { return Array(out.prefix(Swift.max(0, limit))) }
    return out
}
