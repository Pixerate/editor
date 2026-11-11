import Foundation
import PixerateCore

/**
 * The agent tools for provider effects shared by every editor that takes an `EffectProvider`
 * (`effects/tools.ts`, `createEffectToolProvider`): `search_effects`, `describe_effect`,
 * `list_applied_effects`, `apply_effect`, `update_effect` and `remove_effect`. An editor supplies
 * an `EffectToolHost` (what its targets are and how to change them, one undo step each) and adds
 * tools of its own beside these handlers. Tool definitions come from the editor's contracts.
 *
 * Without a provider the read tools say so (and `list_applied_effects` still lists what a document
 * holds), and the write tools refuse with the reason; on a read-only surface the write tools
 * refuse with the host's reason.
 */

/// A tool handler: the arguments in, the JSON result out.
public typealias EffectToolHandler = (JSONObject) async throws -> JSONValue

/// An error an effect tool throws, its message what the model reads.
public struct EffectToolError: Error, LocalizedError, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// What the read tools say when no provider is registered.
public let NO_EFFECTS_PROVIDER = "No effects provider is registered with this editor, so there are no effects to search, describe or apply. The host app must register one (setEffectsProvider); effects already in the document are kept and shown as placeholders."

/// Most tags `search_effects` lists from its matches.
private let TAG_LIMIT = 40

/// What an editor gives the shared effect tools (`EffectToolHost`).
public struct EffectToolHost {
    /// The uses `apply_effect` takes on a target.
    public var applyUses: [String]
    /// `apply_effect` also takes any effect with a picture input.
    public var applyImageInputs: Bool
    /// The current provider, or nil.
    public var provider: () -> EffectProvider?
    /// Why edits are refused now (read-only), or nil.
    public var readOnlyReason: () -> String?
    /// Every target with effects, or one target (throws for an unknown id): `[{ target, name?, effects }]`.
    public var list: (_ target: String?) throws -> [JSONObject]
    /// Arguments `update_effect` takes on this editor besides the shared ones.
    public var updateOptions: [String]
    /// Whether a `search_effects` `place` (the editor's own places) takes an effect (`searchPlaces.offered`); nil when it has none.
    public var searchPlaceOffered: ((EffectDescription, String, EffectProvider) -> Bool)?
    /// Adds an effect: `args` holds the given `values`, `index`, `enabled`, `opacity` (and host options).
    public var apply: (_ target: String, _ effect: String, _ args: JSONObject) async throws -> JSONValue
    public var update: (_ target: String, _ instance: String, _ changes: JSONObject) async throws -> JSONValue
    public var remove: (_ target: String, _ instance: String) async throws -> JSONValue

    public init(applyUses: [String], applyImageInputs: Bool = false, provider: @escaping () -> EffectProvider?, readOnlyReason: @escaping () -> String? = { nil }, list: @escaping (String?) throws -> [JSONObject], updateOptions: [String] = [],
                searchPlaceOffered: ((EffectDescription, String, EffectProvider) -> Bool)? = nil,
                apply: @escaping (String, String, JSONObject) async throws -> JSONValue, update: @escaping (String, String, JSONObject) async throws -> JSONValue, remove: @escaping (String, String) async throws -> JSONValue) {
        self.searchPlaceOffered = searchPlaceOffered
        self.applyUses = applyUses
        self.applyImageInputs = applyImageInputs
        self.provider = provider
        self.readOnlyReason = readOnlyReason
        self.list = list
        self.updateOptions = updateOptions
        self.apply = apply
        self.update = update
        self.remove = remove
    }
}

/// A catalog entry as the tools return it (`summaryOut`).
public func effectSummaryJSON(_ e: EffectDescription) -> JSONObject {
    let j = e.json
    var o: JSONObject = ["id": .string(e.id), "name": .string(e.name), "kind": .string(e.kind), "category": .string(e.category), "uses": .array(e.uses.map { .string($0) })]
    if let d = j["description"]?.stringValue, !d.isEmpty { o["description"] = .string(d) }
    if !e.tags.isEmpty { o["tags"] = .array(e.tags.map { .string($0) }) }
    o["transparent"] = j["transparent"] ?? false
    o["loop"] = j["loop"] ?? false
    if let d = j["duration"] { o["duration"] = d }
    if let c = j["camera"] { o["camera"] = c }
    if let a = j["accepts"]?.arrayValue, !a.isEmpty { o["accepts"] = .array(a) }
    if let p = j["paint"] { o["paint"] = p }
    return o
}

/// Catalog tags close to an unknown one (`nearestTags`).
private func nearestTags(_ tag: String, _ known: [(tag: String, count: Int)]) -> [String] {
    let t = normaliseEffectTag(tag)
    let stem = String(t.prefix(4))
    return known.filter { $0.tag.contains(t) || t.contains($0.tag) || (stem.count == 4 && $0.tag.hasPrefix(stem)) }.prefix(5).map(\.tag)
}

private func tagsJSON(_ tags: [(tag: String, count: Int)]) -> JSONValue { .array(tags.map { ["tag": .string($0.tag), "count": .number(Double($0.count))] }) }

/// The shared effect tools' handlers by name, for an editor's contract provider (`createEffectToolProvider`).
public func effectToolHandlers(_ host: EffectToolHost) -> [String: EffectToolHandler] {
    func requireProvider() throws -> EffectProvider {
        guard let p = host.provider() else { throw EffectToolError(NO_EFFECTS_PROVIDER) }
        return p
    }
    func writable() throws -> EffectProvider {
        if let reason = host.readOnlyReason() { throw EffectToolError(reason) }
        return try requireProvider()
    }
    var h: [String: EffectToolHandler] = [:]
    h["search_effects"] = { a in
        guard let p = host.provider() else { return ["available": false, "reason": .string(NO_EFFECTS_PROVIDER), "effects": [], "total": 0] }
        let tags = a["tags"]?.arrayValue?.compactMap(\.stringValue)
        let accepts = a["accepts"]?.arrayValue?.compactMap(\.stringValue)
        // Filtered here too: a provider with its own search may not know tags.
        var found = try await p.search(a["query"]?.stringValue ?? "", EffectSearchOptions(kind: a["kind"]?.stringValue, category: a["category"]?.stringValue, use: a["use"]?.stringValue, tags: tags, accepts: accepts?.isEmpty == false ? accepts : nil)).filter { hasEffectTags($0, tags) }
        // Filtered here too: a provider that does not fill in accepts is asked for its controls.
        if accepts?.contains("path") == true {
            var kept: [EffectDescription] = []
            for e in found {
                if let acc = e.json["accepts"]?.arrayValue?.compactMap(\.stringValue) {
                    if accepts!.allSatisfy(acc.contains) { kept.append(e) }
                } else if kept.count < 200, !pathControlsOf(try await p.describe(e.id)).isEmpty { kept.append(e) }
            }
            found = kept
        }
        if let place = a["place"]?.stringValue, let offered = host.searchPlaceOffered { found = found.filter { offered($0, place, p) } }
        let limit = Int(a["limit"]?.numberValue ?? 20)
        var out: JSONObject = [
            "available": true, "provider": ["id": .string(p.id), "name": .string(p.name), "capabilities": .object(p.capabilities)],
            "effects": .array(found.prefix(limit).map { .object(effectSummaryJSON($0)) }), "total": .number(Double(found.count)), "tags": tagsJSON(Array(countEffectTags(found).prefix(TAG_LIMIT))),
        ]
        if let tags, !tags.isEmpty, found.isEmpty {
            let known = countEffectTags(try await p.list())
            let have = Set(known.map(\.tag))
            let unknown = tags.filter { !have.contains(normaliseEffectTag($0)) }
            if !unknown.isEmpty { out["unknownTags"] = .array(unknown.map { ["tag": .string($0), "nearest": .array(nearestTags($0, known).map { .string($0) })] }) }
        }
        return .object(out)
    }
    h["describe_effect"] = { a in
        guard let p = host.provider() else { return ["available": false, "reason": .string(NO_EFFECTS_PROVIDER)] }
        let d = try await p.describe(a["effect"]?.stringValue ?? "")
        var o: JSONObject = ["available": true]
        for (k, v) in effectSummaryJSON(d) { o[k] = v }
        o["controls"] = d.json["controls"] ?? Optional<JSONValue>.none
        o["defaults"] = d.json["defaults"] ?? Optional<JSONValue>.none
        o["presets"] = d.json["presets"] ?? Optional<JSONValue>.none
        o["inputs"] = d.json["inputs"] ?? Optional<JSONValue>.none
        o["appliesHere"] = .bool(effectOffered(d, host.applyUses) || (host.applyImageInputs && d.kind != "motion" && layerImageInput(d) != nil))
        let paths = pathControlsOf(d)
        if !paths.isEmpty { o["pathControls"] = .array(paths.map { .string($0) }) }
        return .object(o)
    }
    h["list_applied_effects"] = { a in
        let p = host.provider()
        let known = Set(try await p?.list().map(\.id) ?? [])
        func unavailable(_ e: JSONObject) -> String? {
            guard let p else { return nil }
            if let ep = e["provider"]?.stringValue, !ep.isEmpty, ep != p.id { return "It comes from the \"\(ep)\" provider, but \"\(p.id)\" (\(p.name)) is registered: register \"\(ep)\" again, or remove it and apply one from search_effects." }
            let id = e["effect"]?.stringValue ?? ""
            return known.contains(id) ? nil : "\(p.name) has no effect \"\(id)\": remove it and apply one from search_effects."
        }
        let targets: [JSONValue] = try host.list(a["target"]?.stringValue).map { t in
            var t = t
            t["effects"] = .array((t["effects"]?.arrayValue ?? []).map { ev in
                var e = ev.objectValue ?? [:]
                let why = unavailable(e)
                e["available"] = .bool(p != nil && why == nil)
                if let why { e["reason"] = .string(why) }
                return .object(e)
            })
            return .object(t)
        }
        var o: JSONObject = ["provider": p.map { ["id": .string($0.id), "name": .string($0.name)] } ?? .null]
        if p == nil { o["reason"] = .string(NO_EFFECTS_PROVIDER) }
        o["targets"] = .array(targets)
        return .object(o)
    }
    h["apply_effect"] = { a in
        _ = try writable()
        var args = JSONObject()
        for k in ["values", "index", "enabled", "opacity"] { args[k] = a[k] }
        return try await host.apply(a["target"]?.stringValue ?? "", a["effect"]?.stringValue ?? "", args)
    }
    h["update_effect"] = { a in
        _ = try writable()
        let options = host.updateOptions.filter { a[$0] != nil }
        if a["values"] == nil && a["enabled"] == nil && a["opacity"] == nil && a["index"] == nil && options.isEmpty {
            throw EffectToolError("Give at least one of \((["values", "enabled", "opacity", "index"] + host.updateOptions).joined(separator: ", ")) to change.")
        }
        var changes = JSONObject()
        for k in options + ["values", "enabled", "opacity", "index"] { changes[k] = a[k] }
        return try await host.update(a["target"]?.stringValue ?? "", a["effect"]?.stringValue ?? "", changes)
    }
    h["remove_effect"] = { a in
        _ = try writable()
        return try await host.remove(a["target"]?.stringValue ?? "", a["effect"]?.stringValue ?? "")
    }
    return h
}
