import Foundation

// The style resolver (#890), a port of `createStyleResolver` (`tools/style.ts`): house-style
// skills in layers (org, workspace, user, …) merged per domain, with locked and required layers,
// skill state (on / off, order, one-of-a-kind groups, scopes), `extends` inheritance, `$token`
// references, profiles in frontmatter, the brand every domain reads and file limits. Messages,
// orders and results are the TS core's; `domains/style` in `@pixerate/conformance` checks them.
//
// Not ported: profile versions and migrations, `choose` and the authoring kit
// (`checkStyleSkill`, `saveStyleSkill`, `removeStyleSkill`). Stores are synchronous.

// MARK: - Stores and layers

/// One entry of `StyleStore.list`: a skill name and the state the store records for it
/// (`enabled`, `order`, `group`, `scope`), as JSON.
public struct StyleStoreEntry: Sendable {
    public var name: String
    public var state: JSONObject
    public init(name: String, state: JSONObject = JSONObject()) {
        self.name = name
        self.state = state
    }
}

/// Where one layer's style skills live (`StyleStore`). Hosts implement it over their own storage
/// (a folder, a database); `MemoryStyleStore` holds skills in memory.
public protocol StyleStore: AnyObject {
    /// Skill names with their state. An entry whose `SKILL.md` this store lacks only carries state.
    func list() -> [StyleStoreEntry]
    /// A file of a skill (`SKILL.md`, `rich-text.json`, `references/x.md`), or nil.
    func read(_ name: String, _ file: String) -> String?
    /// Every file of a skill, relative to its folder.
    func files(_ name: String) -> [String]
    /// Calls `listener` when the store's skills or state change.
    func subscribe(_ listener: @escaping () -> Void) -> Cancellable?
}

extension StyleStore {
    public func subscribe(_ listener: @escaping () -> Void) -> Cancellable? { nil }
}

/// A style store in memory (`memoryStyleStore`): files keyed `<skill>/<file>` and state per skill.
public final class MemoryStyleStore: StyleStore {
    private var skills: [String: [String: String]] = [:]
    private var states: [String: JSONObject]
    private var listeners: [UUID: () -> Void] = [:]

    public init(files: [String: String] = [:], state: [String: JSONObject] = [:]) {
        states = state
        for (path, text) in files {
            var p = path.replacingOccurrences(of: "\\", with: "/")
            if p.hasPrefix("./") { p.removeFirst(2) } else if p.hasPrefix("/") { p.removeFirst() }
            let parts = p.components(separatedBy: "/")
            guard parts.count > 1, !parts[0].isEmpty else { continue }
            skills[parts[0], default: [:]][parts.dropFirst().joined(separator: "/")] = text
        }
    }

    public func list() -> [StyleStoreEntry] {
        Set(skills.keys).union(states.keys).sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }.map { StyleStoreEntry(name: $0, state: states[$0] ?? JSONObject()) }
    }

    public func read(_ name: String, _ file: String) -> String? { skills[name]?[file] }

    public func files(_ name: String) -> [String] {
        (skills[name].map { Array($0.keys) } ?? []).sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
    }

    public func subscribe(_ listener: @escaping () -> Void) -> Cancellable? {
        let id = UUID()
        listeners[id] = listener
        return Cancellable { [weak self] in self?.listeners[id] = nil }
    }

    /// Replaces a skill's files.
    public func set(_ name: String, _ files: [String: String]) {
        skills[name] = files
        listeners.values.forEach { $0() }
    }

    /// Records (or with nil, clears) state for a skill.
    public func setState(_ name: String, _ state: JSONObject?) {
        states[name] = state
        listeners.values.forEach { $0() }
    }

    /// Deletes a skill's files and state.
    public func remove(_ name: String) {
        skills[name] = nil
        states[name] = nil
        listeners.values.forEach { $0() }
    }
}

/// A layer of style skills, from general (first) to specific (last).
public struct StyleLayer {
    /// `org`, `workspace`, `user`, …: shown to agents as where a rule came from.
    public var id: String
    public var store: StyleStore
    /// Later layers cannot replace this layer's skills or change the profile fields it sets.
    public var locked: Bool
    /// Later layers cannot switch this layer's skills off.
    public var required: Bool

    public init(id: String, store: StyleStore, locked: Bool = false, required: Bool = false) {
        self.id = id
        self.store = store
        self.locked = locked
        self.required = required
    }
}

// MARK: - Domains and tokens

/// An editor domain a style skill can target, as the resolver needs it.
public struct StyleDomainSpec: @unchecked Sendable {
    public var id: String
    public var title: String
    /// The profile schema (the `checks` property is validated separately).
    public var profileSchema: JSONValue
    /// The checks a profile can turn on, with their options schemas (nil: no options).
    public var checks: [(id: String, options: JSONValue?)]
    /// The profile the domain derives from a brand (`themeFromBrand`).
    public var themeFromBrand: ((JSONObject) -> JSONObject)?
    /// What `get_style_schema` returns: the `<style_domain>` text and the structured result.
    public var schemaResult: (text: String, structured: JSONObject)?

    public init(id: String, title: String, profileSchema: JSONValue, checks: [(id: String, options: JSONValue?)], themeFromBrand: ((JSONObject) -> JSONObject)? = nil, schemaResult: (text: String, structured: JSONObject)? = nil) {
        self.id = id
        self.title = title
        self.profileSchema = profileSchema
        self.checks = checks
        self.themeFromBrand = themeFromBrand
        self.schemaResult = schemaResult
    }

    /**
     * A domain from an entry of `domains/style/domains.json` in `@pixerate/conformance` (what
     * `get_style_schema` returns for it in the TS core), with the domain's `themeFromBrand`.
     */
    public init(contract: JSONValue, themeFromBrand: ((JSONObject) -> JSONObject)? = nil) throws {
        guard let id = contract["id"]?.stringValue, let title = contract["title"]?.stringValue, let structured = contract["structuredContent"]?.objectValue else {
            throw ToolHandlerError("A style domain contract needs id, title and structuredContent.")
        }
        self.init(
            id: id,
            title: title,
            profileSchema: structured["schema"] ?? .object(JSONObject()),
            checks: (structured["checks"]?.arrayValue ?? []).compactMap { c in c["id"]?.stringValue.map { (id: $0, options: c["options"]) } },
            themeFromBrand: themeFromBrand,
            schemaResult: contract["text"]?.stringValue.map { (text: $0, structured: structured) }
        )
    }

    /// The `brand` pseudo-domain (`brand.json`), which every resolver includes.
    public static let brand = StyleDomainSpec(id: "brand", title: "Brand", profileSchema: BRAND_PROFILE_SCHEMA, checks: SHARED_STYLE_CHECK_OPTIONS.map { (id: $0.id, options: $0.schema) })
}

/// Resolves `{ "$token": …, "mode"? }` references in profiles (`StyleTokenSource`).
public protocol StyleTokenSource: AnyObject {
    /// The value, or an error saying why the reference does not resolve.
    func resolve(token: String, mode: String?) -> Result<JSONValue, ToolHandlerError>
}

/// File limits (`StyleLimits`). Files outside them are left out with an issue.
public struct StyleLimits: Sendable {
    public var maxFileBytes = 256 * 1024
    public var maxFiles = 200
    public var maxDepth = 4
    public init() {}
}

/// The most skills an `extends` chain may pass through.
public let MAX_STYLE_INHERITANCE_DEPTH = 8

private let STYLE_SKILL_NAME = JSRegex("^[a-z0-9][a-z0-9-]{0,63}$")
private let STYLE_TEXT_FILE = JSRegex("\\.(md|txt|json|jsonl|ya?ml|toml|csv|tsv|xml|html|css|svg)$", ignoreCase: true)
private let DRIVE = JSRegex("^[A-Za-z]:")
private let PATH_CHARS = JSRegex("^[A-Za-z0-9._/-]+$")

/// Why `path` cannot be a file of a style skill, or nil when it can (`styleFilePathProblem`).
public func styleFilePathProblem(_ path: String, limits: StyleLimits = StyleLimits()) -> String? {
    if path.isEmpty || path.hasPrefix("/") || DRIVE.test(path) { return "\"\(path)\" is not a path inside the skill folder." }
    if path.contains("\\") { return "\"\(path)\" uses backslashes; use / between folders." }
    let parts = path.components(separatedBy: "/")
    if parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) { return "\"\(path)\" must not contain empty, \".\" or \"..\" parts." }
    if parts.contains(where: { $0.hasPrefix(".") }) { return "\"\(path)\" is hidden; hidden files are left out." }
    if !PATH_CHARS.test(path) { return "\"\(path)\" may use only letters, digits, \".\", \"-\", \"_\" and \"/\"." }
    if parts.count - 1 > limits.maxDepth { return "\"\(path)\" is nested more than \(limits.maxDepth) folders deep." }
    if !STYLE_TEXT_FILE.test(path) { return "\"\(path)\" is not a text file type agents can read (md, json, yaml, svg, ...)." }
    return nil
}

private func utf8Bytes(_ text: String) -> Int { text.utf8.count }
/// `Math.round(bytes / 1024)` KB.
private func kb(_ bytes: Int) -> String { "\(Int((Double(bytes) / 1024 + 0.5).rounded(.down))) KB" }

// MARK: - Resolved results

/// A style skill as the resolver lists it (`StyleSkillInfo`), in the TS key order.
public struct StyleSkillInfo: Sendable {
    public var name: String
    public var description: String
    public var layer: String
    public var domains: [String] = []
    public var profiles: [String] = []
    public var enabled: Bool
    public var order: Double
    public var group: String?
    public var scope: [String]?
    public var issues: [String]
    public var inherits: [String]?
    /// Set for a grouped skill by `list`: whether it is the one that applies.
    public var chosen: Bool?

    public var json: JSONValue {
        var o = JSONObject([
            ("name", .string(name)), ("description", .string(description)), ("layer", .string(layer)),
            ("domains", .array(domains.map { .string($0) })), ("profiles", .array(profiles.map { .string($0) })),
            ("enabled", .bool(enabled)), ("order", .number(order)),
        ])
        if let group { o["group"] = .string(group) }
        if let scope { o["scope"] = .array(scope.map { .string($0) }) }
        o["issues"] = .array(issues.map { .string($0) })
        if let inherits { o["inherits"] = .array(inherits.map { .string($0) }) }
        if let chosen { o["chosen"] = .bool(chosen) }
        return .object(o)
    }
}

/// A skill's prose as it applies to one domain.
public struct ResolvedStyleSkill: Sendable {
    public var name: String
    public var description: String
    public var layer: String
    /// The `SKILL.md` body without frontmatter, trimmed.
    public var body: String
    public var inherits: [String]?
}

/// An issue: what is left out of a style and why (`StyleIssue`).
public struct StyleIssue: Sendable {
    public var skill: String?
    public var layer: String?
    public var message: String

    public var json: JSONValue {
        var o = JSONObject()
        if let skill { o["skill"] = .string(skill) }
        if let layer { o["layer"] = .string(layer) }
        o["message"] = .string(message)
        return .object(o)
    }
}

/// Everything that applies to one domain, merged (`ResolvedStyle`).
public struct ResolvedStyle: Sendable {
    public var domain: String
    /// Applicable skills, general to specific.
    public var skills: [ResolvedStyleSkill]
    /// The merged profile, with `$token` references replaced by their values.
    public var profile: JSONObject
    /// Which layer set each profile field (`<layer> (brand)`, `<layer> (from <base>)`, `$brand.checks`).
    public var sources: JSONObject
    public var issues: [StyleIssue]
    /// The merged brand that applies, if any skill has one.
    public var brand: JSONObject?
}

extension HouseStyle {
    /// The house style a domain's check tools run with, from a resolved style: the profile, the
    /// layers that set its `checks` and the brand's, the brand and the issues.
    public convenience init(resolved style: ResolvedStyle) {
        self.init()
        profile = style.profile
        layer = style.sources["checks"]?.stringValue
        brand = style.brand
        brandLayer = style.sources["$brand.checks"]?.stringValue
        issues = style.issues.map(\.json)
        hasSkills = !style.skills.isEmpty
    }
}

// MARK: - Merging

/// Merges `value` over `target` (objects field by field), recording which skill set each leaf (`inheritMerge`).
private func inheritMerge(_ target: inout JSONObject, _ value: JSONObject, _ origins: inout JSONObject, _ who: String, _ prefix: String = "") {
    for (key, next) in value {
        if isUnsafeStyleKey(key) { continue }
        let path = prefix.isEmpty ? key : "\(prefix).\(key)"
        if case .object(let nextObj) = next {
            var inner: JSONObject
            if case .object(let existing)? = target[key] {
                inner = existing
            } else {
                inner = JSONObject()
                origins[path] = nil
            }
            inheritMerge(&inner, nextObj, &origins, who, path)
            target[key] = .object(inner)
        } else {
            target[key] = next
            for p in origins.keys where p.hasPrefix("\(path).") { origins[p] = nil }
            origins[path] = .string(who)
        }
    }
}

private func isUnsafeStyleKey(_ key: String) -> Bool { key == "__proto__" || key == "constructor" || key == "prototype" }

/// Merges `value` into `target`, recording sources and refusing locked fields (`mergeProfile`).
private func mergeProfile(_ target: inout JSONObject, _ value: JSONObject, layer: StyleLayer, skill: String, sources: inout JSONObject, locked: inout [(path: String, layer: String)], issues: inout [StyleIssue], prefix: String = "") {
    for (key, next) in value {
        if isUnsafeStyleKey(key) { continue }
        let path = prefix.isEmpty ? key : "\(prefix).\(key)"
        let lockedBy = locked.first { $0.path == path || path.hasPrefix("\($0.path).") || $0.path.hasPrefix("\(path).") }
        if case .object(let nextObj) = next {
            var inner: JSONObject
            if case .object(let existing)? = target[key] {
                inner = existing
            } else {
                if let lockedBy, lockedBy.layer != layer.id, target[key] != nil {
                    issues.append(StyleIssue(skill: skill, layer: layer.id, message: "\"\(path)\" is locked by the \(lockedBy.layer) layer, so this skill's value is ignored."))
                    continue
                }
                inner = JSONObject()
                sources[path] = nil
            }
            mergeProfile(&inner, nextObj, layer: layer, skill: skill, sources: &sources, locked: &locked, issues: &issues, prefix: path)
            target[key] = .object(inner)
            continue
        }
        if let lockedBy, lockedBy.layer != layer.id {
            if target[key] != next { issues.append(StyleIssue(skill: skill, layer: layer.id, message: "\"\(path)\" is locked by the \(lockedBy.layer) layer, so this skill's value is ignored.")) }
            continue
        }
        target[key] = next
        for p in sources.keys where p.hasPrefix("\(path).") { sources[p] = nil }
        sources[path] = .string(layer.id)
        if layer.locked { locked.append((path, layer.id)) }
    }
}

/// Records `source` for every leaf field of `value` (`recordSources`).
private func recordSources(_ value: JSONObject, _ source: String, _ sources: inout JSONObject, _ prefix: String = "") {
    for (key, next) in value {
        let path = prefix.isEmpty ? key : "\(prefix).\(key)"
        if case .object(let o) = next, !o.isEmpty { recordSources(o, source, &sources, path) } else { sources[path] = .string(source) }
    }
}

/// Replaces `{ "$token": … }` objects with their values (`resolveTokens`); nil is `undefined`.
private func resolveTokens(_ value: JSONValue, _ tokens: StyleTokenSource?, _ path: String, _ errors: inout [String]) -> JSONValue? {
    switch value {
    case .array(let items):
        // `undefined` in an array becomes `null` when the profile is read again; the schema reports it.
        return .array(items.enumerated().map { i, v in resolveTokens(v, tokens, "\(path)[\(i)]", &errors) ?? .null })
    case .object(let obj):
        let at = path.isEmpty ? "profile" : path
        if obj.contains("$token") {
            let token = obj["$token"]?.stringValue ?? ""
            let mode = obj["mode"]
            let modeOk: Bool = { if mode == nil { return true }; if case .string? = mode { return true }; return false }()
            if obj["$token"]?.stringValue == nil || token.isEmpty || !modeOk || obj.keys.contains(where: { $0 != "$token" && $0 != "mode" }) {
                errors.append("\(at): a token reference is { \"$token\": \"<variable name or id>\", \"mode\"?: \"<mode>\" }.")
                return nil
            }
            guard let tokens else {
                errors.append("\(at): \"\(token)\" is a token reference, but this host has no design tokens to resolve it.")
                return nil
            }
            let m = mode?.stringValue
            switch tokens.resolve(token: token, mode: m?.isEmpty == false ? m : nil) {
            case .success(let v): return v
            case .failure(let e):
                errors.append("\(at): \(e.message)")
                return nil
            }
        }
        var out = JSONObject()
        for (k, v) in obj {
            if let r = resolveTokens(v, tokens, path.isEmpty ? k : "\(path).\(k)", &errors) { out[k] = r }
        }
        return .object(out)
    default:
        return value
    }
}

private let NO_OPTIONS: JSONValue = ["type": "object", "properties": .object(JSONObject()), "additionalProperties": false]

/// Problems with a profile's `checks` list (`checkListErrors`).
private func checkListErrors(_ list: JSONValue?, _ domain: StyleDomainSpec) -> [String] {
    guard let list else { return [] }
    guard case .array(let entries) = list else { return ["checks: expected a list of check ids or { \"id\": ..., options } objects."] }
    var errors: [String] = []
    for (i, entry) in entries.enumerated() {
        let id: String?
        switch entry {
        case .string(let s): id = s
        case .object(let o): id = o["id"]?.stringValue
        default: id = nil
        }
        guard let id, !id.isEmpty else {
            errors.append("checks[\(i)]: expected a check id or { \"id\": ..., options }.")
            continue
        }
        guard case .object(var options) = entry, let check = domain.checks.first(where: { $0.id == id }) else { continue }
        options["id"] = nil
        for e in validateJSONSchema(.object(options), check.options ?? NO_OPTIONS) { errors.append("checks[\(i)] (\(id))\(e.path): \(e.message)") }
    }
    return errors
}

// MARK: - The resolver

private struct LoadedSkill {
    var info: StyleSkillInfo
    var layerIndex: Int
    var body: String
    var profiles: [(domain: String, profile: JSONObject)] = []
    var applies: [String]
    var inherited: [String: JSONObject] = [:]

    func profile(_ domain: String) -> JSONObject? { profiles.first { $0.domain == domain }?.profile }
}

private struct OwnProfile {
    var profile: JSONObject
    var label: String
    var errors: [String]
}

private struct ReadSkill {
    var skill: LoadedSkill
    var own: [(domain: String, copy: OwnProfile)]
    var base: String?
    func copy(_ domain: String) -> OwnProfile? { own.first { $0.domain == domain }?.copy }
}

/// Merges house-style layers per domain (`createStyleResolver`). Reads go to the stores on every call.
public final class StyleResolver {
    public let layers: [StyleLayer]
    public let domains: [StyleDomainSpec]
    public let tokens: StyleTokenSource?
    public let limits: StyleLimits

    /// `domains` gets the brand appended unless it has one. Throws for two layers with one id.
    public init(layers: [StyleLayer], domains: [StyleDomainSpec], tokens: StyleTokenSource? = nil, limits: StyleLimits = StyleLimits()) throws {
        var seen = Set<String>()
        for layer in layers {
            if seen.contains(layer.id) { throw ToolHandlerError("Two style layers are called \"\(layer.id)\"; give each layer its own id.") }
            seen.insert(layer.id)
        }
        self.layers = layers
        self.domains = domains.contains { $0.id == "brand" } ? domains : domains + [.brand]
        self.tokens = tokens
        self.limits = limits
    }

    public var domainIds: [String] { domains.map(\.id) }

    func requireDomain(_ id: String) throws -> StyleDomainSpec {
        guard let d = domains.first(where: { $0.id == id }) else {
            let list = domainIds.map { "\"\($0)\"" }.joined(separator: ", ")
            throw ToolHandlerError("There is no house-style domain \"\(id)\"; expected one of \(list.isEmpty ? "(none registered)" : list).")
        }
        return d
    }

    private func load() -> (skills: [LoadedSkill], issues: [StyleIssue]) {
        var issues: [StyleIssue] = []
        let entries = layers.map { $0.store.list() }
        var names: [String] = []
        for list in entries { for e in list where !names.contains(e.name) { names.append(e.name) } }
        var read: [ReadSkill] = []
        for name in names {
            if !STYLE_SKILL_NAME.test(name) {
                issues.append(StyleIssue(skill: name, layer: nil, message: "\"\(name)\" is not a valid skill name (lowercase letters, digits and hyphens, at most 64)."))
                continue
            }
            var copies: [(index: Int, text: String)] = layers.enumerated().compactMap { i, l in l.store.read(name, "SKILL.md").map { (i, $0) } }
            if copies.isEmpty { continue }
            let oversized = copies.filter { utf8Bytes($0.text) > limits.maxFileBytes }
            if !oversized.isEmpty {
                for c in oversized { issues.append(StyleIssue(skill: name, layer: layers[c.index].id, message: "SKILL.md is \(kb(utf8Bytes(c.text))), over the \(kb(limits.maxFileBytes)) limit, so this copy is left out.")) }
                copies = copies.filter { c in !oversized.contains { $0.index == c.index } }
                if copies.isEmpty { continue }
            }
            let winner = copies.first { layers[$0.index].locked } ?? copies[copies.count - 1]
            let layer = layers[winner.index]
            var skillIssues: [String] = []
            for c in copies where c.index > winner.index { skillIssues.append("The \(layers[c.index].id) layer's copy is ignored: the \(layer.id) layer is locked.") }
            var enabled = true
            var order: Double = 0
            let fm = parseFrontmatter(winner.text)
            if let error = fm.error { skillIssues.append("SKILL.md \(error)") }
            var group: String? = fm.error != nil ? frontmatterField(winner.text, "group") : fm.data["group"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
            var scope: [String]?
            for i in layers.indices {
                guard let entry = entries[i].first(where: { $0.name == name }) else { continue }
                let state = entry.state
                if i == winner.index, let o = state["order"]?.numberValue { order = o }
                if let g = state["group"]?.stringValue, !g.isEmpty { group = g }
                if case .array(let s)? = state["scope"] { scope = s.compactMap(\.stringValue) }
                guard case .bool(let on)? = state["enabled"] else { continue }
                if layer.required && i != winner.index {
                    if !on { skillIssues.append("The \(layers[i].id) layer cannot switch it off: the \(layer.id) layer requires it.") }
                    continue
                }
                enabled = on
            }
            let legacy = parseSkillFrontmatter(winner.text)
            let description = fm.error != nil ? (legacy.description ?? "") : (fm.data["description"]?.stringValue ?? "")
            let named = fm.error != nil ? parseStyleDomains(winner.text) : styleDomainsOf(fm.data["domains"])
            var applies: [String] = []
            for d in named ?? domainIds {
                if domainIds.contains(d) { if !applies.contains(d) { applies.append(d) } }
                else { skillIssues.append("It names an unknown domain \"\(d)\"; the domains here are \(domainIds.joined(separator: ", ")).") }
            }
            // `extends: <skill>` builds this skill's profiles on another's.
            let extendsValue: JSONValue? = fm.error != nil ? frontmatterField(winner.text, "extends").map { .string($0) } : fm.data["extends"]
            var base: String?
            if let extendsValue, extendsValue != .null, extendsValue != .string("null") {
                if case .string(let s) = extendsValue, STYLE_SKILL_NAME.test(s) { base = s }
                else { skillIssues.append("\"extends\" must be the name of another style skill (or null), not \(extendsValue.stringified()); its profiles are read without a base.") }
            }
            var own: [(domain: String, copy: OwnProfile)] = []
            for domain in domains {
                let fileRaw = layer.store.read(name, "\(domain.id).json")
                let inFrontmatter: JSONObject? = fm.error == nil ? fm.data[domain.id]?.objectValue : nil
                if fileRaw == nil && inFrontmatter == nil { continue }
                let file = fileRaw != nil ? "\(domain.id).json" : "The frontmatter \"\(domain.id)\" profile"
                if fileRaw != nil && inFrontmatter != nil { skillIssues.append("The frontmatter \"\(domain.id)\" profile is ignored: \(domain.id).json is used.") }
                if let fileRaw, utf8Bytes(fileRaw) > limits.maxFileBytes {
                    skillIssues.append("\(file) is \(kb(utf8Bytes(fileRaw))), over the \(kb(limits.maxFileBytes)) limit, so it is left out.")
                    continue
                }
                if domain.id == "brand" { if !applies.contains("brand") { applies.append("brand") } }
                else if !applies.contains(domain.id) {
                    skillIssues.append("\(file) is left out: the skill's domains do not include \(domain.id).")
                    continue
                }
                let parsed: JSONValue
                if let fileRaw {
                    do { parsed = stripPrototypeKeys(try JSONValue.parse(fileRaw)) } catch {
                        skillIssues.append("\(file) is not valid JSON: \(error)")
                        continue
                    }
                } else {
                    parsed = .object(inFrontmatter!)
                }
                guard case .object(var obj) = parsed else {
                    skillIssues.append("\(file) must hold a JSON object.")
                    continue
                }
                if case .string? = obj["$schema"] { obj["$schema"] = nil }
                var errors: [String] = []
                let resolved = resolveTokens(.object(obj), tokens, "", &errors)
                guard case .object(let profile)? = resolved else {
                    skillIssues.append(errors.isEmpty ? "\(file) must hold a JSON object; its token reference resolves to \(resolved?.stringified() ?? "undefined")." : "\(file) is left out: \(errors.joined(separator: " "))")
                    continue
                }
                own.append((domain.id, OwnProfile(profile: profile, label: file, errors: errors)))
            }
            let info = StyleSkillInfo(name: name, description: description, layer: layer.id, enabled: enabled, order: order, group: group, scope: scope, issues: skillIssues)
            read.append(ReadSkill(skill: LoadedSkill(info: info, layerIndex: winner.index, body: legacy.body.jsTrimmed, applies: applies), own: own, base: base))
        }

        // Inheritance: each skill's profiles merge over its base chain's, then are validated whole.
        let byName = Dictionary(read.map { ($0.skill.info.name, $0) }, uniquingKeysWith: { a, _ in a })
        for index in read.indices {
            var r = read[index]
            let name = r.skill.info.name
            var chain: [String] = []
            var problem: String?
            var at = r
            while let base = at.base {
                let path = ([name] + chain + [base]).joined(separator: " → ")
                if base == name || chain.contains(base) {
                    problem = "\"extends\" goes round in a circle: \(path)."
                    break
                }
                guard let next = byName[base] else {
                    let others = read.map(\.skill.info.name).filter { $0 != name }
                    problem = "it extends \"\(base)\", which no layer holds\(others.isEmpty ? "" : "; the skills are \(others.map { "\"\($0)\"" }.joined(separator: ", "))")."
                    break
                }
                if chain.count >= MAX_STYLE_INHERITANCE_DEPTH {
                    problem = "\"extends\" goes more than \(MAX_STYLE_INHERITANCE_DEPTH) skills deep: \(path)."
                    break
                }
                chain.append(base)
                at = next
            }
            if !chain.isEmpty { r.skill.info.inherits = chain }
            if let problem {
                r.skill.info.issues.append("Its profiles are left out: \(problem)")
                r.skill.info.domains = r.skill.applies
                read[index] = r
                continue
            }
            let levels = chain.reversed().map { byName[$0]! } + [r]
            let ids = Set(levels.flatMap { $0.own.map(\.domain) })
            for domain in domains where ids.contains(domain.id) {
                let fromBase = r.copy(domain.id) == nil
                if domain.id == "brand" { if !r.skill.applies.contains("brand") { r.skill.applies.append("brand") } }
                else if fromBase && !r.skill.applies.contains(domain.id) { continue }
                var profile = JSONObject()
                var origins = JSONObject()
                for level in levels { if let copy = level.copy(domain.id) { inheritMerge(&profile, copy.profile, &origins, level.skill.info.name) } }
                let label = r.copy(domain.id)?.label ?? "The \(domain.id) profile inherited from \"\(levels.first { $0.copy(domain.id) != nil }!.skill.info.name)\""
                var rest = profile
                rest["checks"] = nil
                let errors = (r.copy(domain.id)?.errors ?? [])
                    + validateJSONSchema(.object(rest), domain.profileSchema).map { "\($0.path.isEmpty ? "(profile)" : $0.path): \($0.message)" }
                    + checkListErrors(profile["checks"], domain)
                if !errors.isEmpty {
                    r.skill.info.issues.append("\(label) is left out: \(errors.joined(separator: " "))")
                    continue
                }
                r.skill.profiles.append((domain.id, profile))
                var inherited = JSONObject()
                for (path, who) in origins where who.stringValue != name { inherited[path] = who }
                if !inherited.isEmpty { r.skill.inherited[domain.id] = inherited }
            }
            r.skill.info.domains = r.skill.applies
            r.skill.info.profiles = r.skill.profiles.map(\.domain)
            read[index] = r
        }
        let skills = read.map(\.skill).sorted { a, b in
            if a.layerIndex != b.layerIndex { return a.layerIndex < b.layerIndex }
            if a.info.order != b.info.order { return a.info.order < b.info.order }
            return Array(a.info.name.utf16).lexicographicallyPrecedes(Array(b.info.name.utf16))
        }
        return (skills, issues)
    }

    private func inScope(_ info: StyleSkillInfo, _ scope: String?) -> Bool { info.scope == nil || (scope != nil && info.scope!.contains(scope!)) }

    /// The skills that apply in `scope`: switched on, in scope, and the first switched on of their group.
    private func active(_ skills: [LoadedSkill], _ scope: String?) -> Set<String> {
        var out = Set<String>()
        var taken = Set<String>()
        for s in skills {
            guard s.info.enabled, inScope(s.info, scope) else { continue }
            if let g = s.info.group {
                if taken.contains(g) { continue }
                taken.insert(g)
            }
            out.insert(s.info.name)
        }
        return out
    }

    /// Every style skill across layers (switched-off ones too), general to specific (`list`).
    public func list(domain: String? = nil, scope: String? = nil) throws -> [StyleSkillInfo] {
        if let domain { _ = try requireDomain(domain) }
        let skills = load().skills
        let applying = active(skills, scope)
        return skills.filter { s in (domain == nil || s.applies.contains(domain!)) && (scope == nil || inScope(s.info, scope)) }.map { s in
            var info = s.info
            if info.group != nil { info.chosen = applying.contains(info.name) }
            return info
        }
    }

    /// The resolved style for a domain (`resolve`). Throws for an unknown domain.
    public func resolve(_ domainId: String, scope: String? = nil) throws -> ResolvedStyle {
        let domain = try requireDomain(domainId)
        let (skills, loadIssues) = load()
        let applying = active(skills, scope)
        var issues = loadIssues
        var profile = JSONObject()
        var sources = JSONObject()
        var locked: [(path: String, layer: String)] = []
        var brand = JSONObject()
        var brandSources = JSONObject()
        var brandLocked: [(path: String, layer: String)] = []
        var brandLayer: String?
        var applied: [ResolvedStyleSkill] = []
        var own: [(skill: LoadedSkill, profile: JSONObject)] = []
        for skill in skills {
            guard skill.applies.contains(domainId), inScope(skill.info, scope) else { continue }
            for message in skill.info.issues { issues.append(StyleIssue(skill: skill.info.name, layer: skill.info.layer, message: message)) }
            guard applying.contains(skill.info.name) else { continue }
            applied.append(ResolvedStyleSkill(name: skill.info.name, description: skill.info.description, layer: skill.info.layer, body: skill.body, inherits: skill.info.inherits))
            if let brandProfile = skill.profile("brand"), domainId != "brand" {
                mergeProfile(&brand, brandProfile, layer: layers[skill.layerIndex], skill: skill.info.name, sources: &brandSources, locked: &brandLocked, issues: &issues)
                brandLayer = skill.info.layer
            }
            if let p = skill.profile(domainId) { own.append((skill, p)) }
        }
        let hasBrand = !brand.isEmpty
        if hasBrand, let themeFromBrand = domain.themeFromBrand {
            let derived = stripPrototypeKeys(.object(themeFromBrand(brand))).objectValue ?? JSONObject()
            let errors = validateJSONSchema(.object(derived), domain.profileSchema).map { "\($0.path.isEmpty ? "(profile)" : $0.path): \($0.message)" }
            if !errors.isEmpty {
                issues.append(StyleIssue(skill: nil, layer: nil, message: "The \(domainId) style derived from the brand is left out: \(errors.joined(separator: " "))"))
            } else {
                for (k, v) in derived { profile[k] = v }
                recordSources(derived, "\(brandLayer ?? "undefined") (brand)", &sources)
            }
        }
        for (skill, domainProfile) in own {
            let layer = layers[skill.layerIndex]
            mergeProfile(&profile, domainProfile, layer: layer, skill: skill.info.name, sources: &sources, locked: &locked, issues: &issues)
            for (path, base) in skill.inherited[domainId] ?? JSONObject() where sources[path]?.stringValue == layer.id {
                sources[path] = .string("\(layer.id) (from \(base.stringValue ?? ""))")
            }
        }
        if hasBrand, let checks = brandSources["checks"] { sources["$brand.checks"] = checks }
        return ResolvedStyle(domain: domainId, skills: applied, profile: profile, sources: sources, issues: issues, brand: hasBrand ? brand : nil)
    }

    private func winnerLayer(_ name: String) -> StyleLayer? {
        let copies = layers.indices.filter { layers[$0].store.read(name, "SKILL.md") != nil }
        guard let last = copies.last else { return nil }
        return layers[copies.first { layers[$0].locked } ?? last]
    }

    /// A file of the skill copy in use (`readFile`). Throws for a path a skill cannot hold or an oversized file.
    public func readFile(_ name: String, _ file: String) throws -> String? {
        guard let layer = winnerLayer(name) else { return nil }
        if file != "SKILL.md", let problem = styleFilePathProblem(file, limits: limits) { throw ToolHandlerError("\(problem) Read one of the files get_style_file lists.") }
        let text = layer.store.read(name, file)
        if let text, utf8Bytes(text) > limits.maxFileBytes {
            throw ToolHandlerError("\"\(file)\" is \(kb(utf8Bytes(text))), over the \(kb(limits.maxFileBytes)) limit for a style file, so it is not offered.")
        }
        return text
    }

    /// Files of the skill copy in use (nil for an unknown skill).
    public func files(_ name: String) -> [String]? {
        guard let layer = winnerLayer(name) else { return nil }
        let all = layer.store.files(name).map { f -> String in
            var p = f
            if p.hasPrefix("./") { p.removeFirst(2) } else if p.hasPrefix("/") { p.removeFirst() }
            return p
        }
        return Array(all.filter { $0 == "SKILL.md" || styleFilePathProblem($0, limits: limits) == nil }.prefix(limits.maxFiles))
    }

    /// Calls `listener` when a store changes.
    public func subscribe(_ listener: @escaping () -> Void) -> Cancellable {
        let offs = layers.compactMap { $0.store.subscribe(listener) }
        return Cancellable { offs.forEach { $0.cancel() } }
    }
}

// MARK: - Rendering

private let STYLE_BLOCK = try! NSRegularExpression(pattern: "<(/?)(style_skill|style_catalog|style_domain)", options: [.caseInsensitive])

/// Escapes the tags house-style text is wrapped in, so text cannot close or open one (`escapeStyleBlocks`).
public func escapeStyleBlocks(_ text: String) -> String {
    STYLE_BLOCK.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: (text as NSString).length), withTemplate: "&lt;$1$2")
}

private func escapeAttribute(_ value: String) -> String {
    value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "<", with: "&lt;")
}

/// A resolved style as text for a model (`renderStyle`): a `<style_skill>` block per skill and the merged profile.
public func renderStyle(_ style: ResolvedStyle) -> String {
    if style.skills.isEmpty { return "No house style applies to \(style.domain)." }
    let blocks = style.skills.map { "<style_skill name=\"\(escapeAttribute($0.name))\" layer=\"\(escapeAttribute($0.layer))\">\n\(escapeStyleBlocks($0.body))\n</style_skill>" }
    func json(_ v: JSONValue) -> String { escapeStyleBlocks(v.stringified(space: 2)) }
    let profile = style.profile.isEmpty ? "" : "\n\nMerged \(style.domain) profile:\n\(json(.object(style.profile)))"
    let brand = style.brand.map { "\n\nBrand (brand.json; place the logo as given, never redraw it):\n\(json(.object($0)))" } ?? ""
    return blocks.joined(separator: "\n\n") + profile + brand
}

/// The colours and fonts the house style offers for one domain, in picker order (`styleSwatches`).
public func styleSwatches(profile: JSONObject, brand: JSONObject?) -> JSONValue {
    var seen = Set<String>()
    var colors: [JSONValue] = []
    func add(_ color: JSONValue?, _ label: String) {
        guard case .string(let c)? = color, !c.isEmpty else { return }
        let key = c.jsTrimmed.jsLowercased
        if seen.contains(key) { return }
        seen.insert(key)
        colors.append(["color": .string(c), "label": .string(label)])
    }
    for (i, c) in (profile["palette"]?.arrayValue ?? []).enumerated() { add(c, "palette \(i + 1)") }
    for (i, c) in brandPalette(brand).enumerated() { add(.string(c), "brand \(i + 1)") }
    for (role, c) in brandColors(brand) { add(.string(c), role) }
    let profileFonts = (profile["fonts"]?.arrayValue ?? []).compactMap(\.stringValue)
    let themeFont = profile["theme"]?.objectValue?["fontFamily"]?.stringValue.map { [$0] } ?? []
    func first(_ f: String) -> String {
        var s = (f.components(separatedBy: ",").first ?? "").jsTrimmed
        if s.count >= 2, let q = s.first, q == "'" || q == "\"", s.last == q { s = String(s.dropFirst().dropLast()) }
        return s.jsLowercased
    }
    var fonts: [String] = []
    for f in profileFonts + brandFonts(brand) + themeFont where !fonts.contains(where: { first($0) == first(f) }) { fonts.append(f) }
    return ["colors": .array(colors), "fonts": .array(fonts.map { .string($0) })]
}
