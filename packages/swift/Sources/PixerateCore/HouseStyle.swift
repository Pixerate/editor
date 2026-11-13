import Foundation

// The one-skill, one-layer part of `createStyleResolver` (`tools/style.ts`) that every Swift
// domain's house style uses: profile loading and validation, and merging a profile over the one
// derived from the brand. Multi-layer merging (locks, required layers, skill state) is not ported.

/// `resolveTokens` with no token source: every `{ "$token": ... }` is an error and resolves to
/// `undefined` (`nil`). An `undefined` array item becomes `null`, its path kept in `undefinedPaths` so
/// the schema message can say `undefined`; an `undefined` object member is dropped (the TS validator
/// skips it, and `required` treats it as missing).
private func resolveStyleTokens(_ value: JSONValue, _ path: String, _ pointer: String, _ errors: inout [String], _ undefinedPaths: inout Set<String>) -> JSONValue? {
    switch value {
    case .array(let items):
        return .array(items.enumerated().map { i, v in
            if let r = resolveStyleTokens(v, "\(path)[\(i)]", "\(pointer)/\(i)", &errors, &undefinedPaths) { return r }
            undefinedPaths.insert("\(pointer)/\(i)")
            return .null
        })
    case .object(let obj):
        if obj.contains("$token") {
            let token = obj["$token"]
            let mode = obj["mode"]
            let tokenOk: Bool = { if case .string(let s)? = token { return !s.isEmpty }; return false }()
            let modeOk: Bool = { if mode == nil { return true }; if case .string? = mode { return true }; return false }()
            if !tokenOk || !modeOk || obj.keys.contains(where: { $0 != "$token" && $0 != "mode" }) {
                errors.append("\(path.isEmpty ? "profile" : path): a token reference is { \"$token\": \"<variable name or id>\", \"mode\"?: \"<mode>\" }.")
                return nil
            }
            errors.append("\(path.isEmpty ? "profile" : path): \"\(token!.stringValue!)\" is a token reference, but this host has no design tokens to resolve it.")
            return nil
        }
        var out = JSONObject()
        for (k, v) in obj {
            if let r = resolveStyleTokens(v, path.isEmpty ? k : "\(path).\(k)", "\(pointer)/\(k)", &errors, &undefinedPaths) { out[k] = r }
        }
        return .object(out)
    default:
        return value
    }
}

private func styleSchemaErrors(_ value: JSONValue, _ schema: JSONValue, _ undefinedPaths: Set<String>, pointerPrefix: String = "") -> [SchemaValidationError] {
    validateJSONSchema(value, schema).map { e in
        guard undefinedPaths.contains(pointerPrefix + e.path), e.message.hasSuffix(", got null.") else { return e }
        return SchemaValidationError(path: e.path, message: String(e.message.dropLast("null.".count)) + "undefined.")
    }
}

/// `checkListErrors`: problems with a profile's `checks` list, against `checks` (the chart's, or the
/// shared checks for `brand.json`).
private func styleCheckListErrors(_ list: JSONValue?, _ undefinedPaths: Set<String>, checks: [(id: String, schema: JSONValue)]) -> [String] {
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
        guard let id, !id.isEmpty, !undefinedPaths.contains("/checks/\(i)") else {
            errors.append("checks[\(i)]: expected a check id or { \"id\": ..., options }.")
            continue
        }
        guard case .object(var options) = entry, let check = checks.first(where: { $0.id == id }) else { continue }
        options["id"] = Optional<JSONValue>.none
        for e in styleSchemaErrors(.object(options), check.schema, undefinedPaths, pointerPrefix: "/checks/\(i)") {
            errors.append("checks[\(i)] (\(id))\(e.path): \(e.message)")
        }
    }
    return errors
}


/// Loads a style skill's `brand.json` as `createStyleResolver` does: its `checks` list is
/// validated against the shared checks.
public func loadBrandProfile(_ raw: JSONValue, file: String = "brand.json") -> (profile: JSONObject?, error: String?) {
    loadStyleProfile(raw, file: file, schema: BRAND_PROFILE_SCHEMA, checks: SHARED_STYLE_CHECK_OPTIONS)
}

/// Loads one profile file of a style skill as `createStyleResolver` does: `$token` references (left
/// out with an issue, as there is no token source), the profile against `schema` and its `checks`
/// list against `checks` (each check's `optionsSchema`). The profile, or why it is left out.
public func loadStyleProfile(_ raw: JSONValue, file: String, schema: JSONValue, checks: [(id: String, schema: JSONValue)]) -> (profile: JSONObject?, error: String?) {
    guard case .object(var parsed) = stripPrototypeKeys(raw) else { return (nil, "\(file) must hold a JSON object.") }
    // Editors read "$schema" for completion; it is not part of the profile.
    if case .string? = parsed["$schema"] { parsed["$schema"] = Optional<JSONValue>.none }
    var errors: [String] = []
    var undefinedPaths = Set<String>()
    // A root `{ "$token": ... }` resolves to a value or to nothing, never to a profile object: the
    // profile is left out with the reason, as `createStyleResolver` does (#768).
    // With no token source here, it always resolves to nothing and an error says why.
    guard case .object(let resolved)? = resolveStyleTokens(.object(parsed), "", "", &errors, &undefinedPaths) else {
        return (nil, "\(file) is left out: \(errors.joined(separator: " "))")
    }
    var rest = resolved
    rest["checks"] = Optional<JSONValue>.none
    errors += styleSchemaErrors(.object(rest), schema, undefinedPaths).map { "\($0.path.isEmpty ? "(profile)" : $0.path): \($0.message)" }
    errors += styleCheckListErrors(resolved["checks"], undefinedPaths, checks: checks)
    if !errors.isEmpty { return (nil, "\(file) is left out: \(errors.joined(separator: " "))") }
    return (resolved, nil)
}

/// Whether `loadStyleProfile` leaves the file out before reading its fields (it is not a JSON object,
/// or is a `{ "$token": ... }` reference). `createStyleResolver` reports these while it reads a
/// skill's files, before the field errors of any of its files.
public func styleProfileFailsAtRoot(_ raw: JSONValue) -> Bool {
    guard case .object(var parsed) = stripPrototypeKeys(raw) else { return true }
    if case .string? = parsed["$schema"] { parsed["$schema"] = Optional<JSONValue>.none }
    return parsed.contains("$token")
}

/// `chartStyleFromBrand`: the chart profile a brand gives, its palette and a theme from its colour
/// roles (background, surface, text, muted text, border for grid and axis, positive, negative) and
/// body font.


/// `mergeProfile` for one unlocked layer: objects merge field by field, anything else replaces.
public func mergeStyleProfile(_ target: inout JSONObject, _ value: JSONObject) {
    for (key, next) in value {
        if case .object(let nextObj) = next {
            var inner = target[key]?.objectValue ?? JSONObject()
            mergeStyleProfile(&inner, nextObj)
            target[key] = .object(inner)
        } else {
            target[key] = next
        }
    }
}


/**
 * A domain's resolved house style for one `layer` holding one skill (the conformance hosts'
 * setup): the skill's `<domain>.json` and `brand.json`, as `resolve` merges them. The domain
 * starts from what it derives from the brand (`themeFromBrand`), its own profile merges over
 * that, and the brand's checks run after the profile's own (`runStyleChecks`).
 */
public final class HouseStyle: @unchecked Sendable {
    /// The merged profile.
    public var profile: JSONObject
    /// The layer that set the profile's `checks` (`style.sources.checks`), named on findings.
    public var layer: String?
    /// The skill's `brand.json`, when it has a valid, non-empty one.
    public var brand: JSONObject?
    /// The layer that set the brand's `checks` (`style.sources['$brand.checks']`).
    public var brandLayer: String?
    /// `style.issues`: why a file or the derived profile is left out.
    public var issues: [JSONValue]
    /// Whether a style skill applies (`style.skills.length > 0`).
    public var hasSkills: Bool

    /// No house style.
    public init() {
        profile = JSONObject()
        issues = []
        hasSkills = false
    }

    /**
     * `skill` in `layer`, with `profileJson` as its `<domain>.json` and `brandJson` as its
     * `brand.json` (either may be absent). `schema` is the domain's `profileSchema`, `checks` the
     * option schemas its `checks` list is validated against (`styleChecksOf`).
     */
    public init(
        domain: String,
        skill: String,
        layer: String,
        profileJson: JSONValue?,
        brandJson: JSONValue?,
        schema: JSONValue,
        checks: [(id: String, schema: JSONValue)],
        themeFromBrand: ((JSONObject) -> JSONObject)? = nil
    ) {
        var issues: [JSONValue] = []
        func issue(_ message: String) {
            issues.append(.object(JSONObject([("skill", .string(skill)), ("layer", .string(layer)), ("message", .string(message))])))
        }
        // Profiles load in domain order: the domain's, then the brand (added last).
        var own: JSONObject?
        if let profileJson {
            let loaded = loadStyleProfile(profileJson, file: "\(domain).json", schema: schema, checks: checks)
            if let error = loaded.error { issue(error) }
            own = loaded.profile
        }
        var brand: JSONObject?
        if let brandJson {
            let loaded = loadBrandProfile(brandJson)
            if let error = loaded.error { issue(error) }
            if let p = loaded.profile, !p.isEmpty { brand = p }
        }
        var profile = JSONObject()
        if let brand, let themeFromBrand {
            let derived = themeFromBrand(brand)
            let errors = validateJSONSchema(.object(derived), schema).map { "\($0.path.isEmpty ? "(profile)" : $0.path): \($0.message)" }
            if errors.isEmpty {
                profile = derived
            } else {
                issues.append(.object(JSONObject([("message", .string("The \(domain) style derived from the brand is left out: \(errors.joined(separator: " "))"))])))
            }
        }
        if let own { mergeStyleProfile(&profile, own) }
        self.profile = profile
        self.layer = own?["checks"] != nil ? layer : nil
        self.brand = brand
        self.brandLayer = brand?["checks"] != nil ? layer : nil
        self.issues = issues
        self.hasSkills = true
    }
}
