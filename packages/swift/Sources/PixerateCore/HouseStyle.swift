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
    guard case .object = stripPrototypeKeys(raw) else { return (nil, "\(file) must hold a JSON object.") }
    var errors: [String] = []
    var undefinedPaths = Set<String>()
    // A root `{ "$token": ... }` resolves to a value or to nothing, never to a profile object: the
    // profile is left out with the reason, as `createStyleResolver` does (#768).
    // With no token source here, it always resolves to nothing and an error says why.
    guard case .object(let resolved)? = resolveStyleTokens(stripPrototypeKeys(raw), "", "", &errors, &undefinedPaths) else {
        return (nil, "\(file) is left out: \(errors.joined(separator: " "))")
    }
    var rest = resolved
    rest["checks"] = Optional<JSONValue>.none
    errors += styleSchemaErrors(.object(rest), schema, undefinedPaths).map { "\($0.path.isEmpty ? "(profile)" : $0.path): \($0.message)" }
    errors += styleCheckListErrors(resolved["checks"], undefinedPaths, checks: checks)
    if !errors.isEmpty { return (nil, "\(file) is left out: \(errors.joined(separator: " "))") }
    return (resolved, nil)
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

