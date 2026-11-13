import Foundation

// A port of `tools/brand.ts` and the shared check option schemas in `tools/style-surface.ts`:
// the `brand.json` a style skill can hold beside its domain profiles, read by every domain.

/// `BRAND_COLOR_ROLES`: each colour role with the names it is looked up by, in order.
public let BRAND_COLOR_ROLES: [(role: String, names: [String])] = [
    ("primary", ["primary", "brand", "accent1", "accent"]),
    ("secondary", ["secondary", "accent2"]),
    ("accent", ["accent", "tertiary", "accent3", "accent2"]),
    ("background", ["background", "bg", "lt1", "surface"]),
    ("surface", ["surface", "lt2", "background", "lt1"]),
    ("text", ["text", "foreground", "fg", "dk1"]),
    ("mutedText", ["mutedText", "muted", "secondaryText", "dk2"]),
    ("border", ["border", "line", "outline", "dk2"]),
    ("positive", ["positive", "success", "good"]),
    ("negative", ["negative", "error", "danger", "bad"]),
    ("link", ["link", "hlink"]),
]

/// The colour a brand gives `role`, through its fallback names, or `nil`.
public func brandColor(_ brand: JSONObject?, _ role: String) -> String? {
    guard let colors = brand?["colors"]?.objectValue,
          let names = BRAND_COLOR_ROLES.first(where: { $0.role == role })?.names else { return nil }
    for name in names {
        if let value = colors[name]?.stringValue, !value.isEmpty { return value }
    }
    return nil
}

/// Every role the brand gives a colour, in role order.
public func brandColors(_ brand: JSONObject?) -> [(role: String, color: String)] {
    BRAND_COLOR_ROLES.compactMap { entry in brandColor(brand, entry.role).map { (role: entry.role, color: $0) } }
}

private let BRAND_SERIES_SLOTS = ["primary", "secondary", "accent", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"]

/// The brand's ordered palette: `palette` when it has one, else the series colours it names
/// (`primary`, `secondary`, `accent`, then `accent1`…`accent6`), without repeats.
public func brandPalette(_ brand: JSONObject?) -> [String] {
    if let palette = brand?["palette"]?.arrayValue, !palette.isEmpty {
        return palette.compactMap { $0.stringValue }.filter { !$0.isEmpty }
    }
    guard let colors = brand?["colors"]?.objectValue else { return [] }
    var seen = Set<String>()
    var out: [String] = []
    func add(_ value: String?) {
        guard let value, !value.isEmpty else { return }
        let key = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if seen.insert(key).inserted { out.append(value) }
    }
    add(brandColor(brand, "primary"))
    add(brandColor(brand, "secondary"))
    add(brandColor(brand, "accent"))
    for slot in BRAND_SERIES_SLOTS { add(colors[slot]?.stringValue) }
    return out
}

/// The font families the brand names (heading, body, mono), without repeats.
public func brandFonts(_ brand: JSONObject?) -> [String] {
    guard let fonts = brand?["fonts"]?.objectValue else { return [] }
    var out: [String] = []
    for key in ["heading", "body", "mono"] {
        if let f = fonts[key]?.stringValue, !f.isEmpty, !out.contains(f) { out.append(f) }
    }
    return out
}

private func brandSchema(_ json: String) -> JSONValue { try! JSONValue.parse(json) }

private let BRAND_COLOR = #"{"type":"string","minLength":1}"#

/// `BRAND_PROFILE_SCHEMA` (descriptions left out: validation does not read them).
public let BRAND_PROFILE_SCHEMA: JSONValue = brandSchema("""
{"type":"object","properties":{
"name":{"type":"string","minLength":1},
"colors":{"type":"object","additionalProperties":\(BRAND_COLOR)},
"palette":{"type":"array","items":\(BRAND_COLOR),"minItems":1},
"fonts":{"type":"object","properties":{"heading":{"type":"string","minLength":1},"body":{"type":"string","minLength":1},"mono":{"type":"string","minLength":1}},"additionalProperties":false},
"logo":{"type":"object","properties":{"svg":{"type":"string","minLength":1},"aspect":{"type":"number","exclusiveMinimum":0}},"additionalProperties":false}
},"additionalProperties":false}
""")

/// The `optionsSchema` of each shared check (`SHARED_STYLE_CHECKS` order), which a brand's
/// `checks` list is validated against.
public let SHARED_STYLE_CHECK_OPTIONS: [(id: String, schema: JSONValue)] = [
    ("palette-only", brandSchema(#"{"type":"object","properties":{"tolerance":{"type":"number","minimum":0,"maximum":20},"allowNeutrals":{"type":"boolean"}},"additionalProperties":false}"#)),
    ("min-contrast", brandSchema(#"{"type":"object","properties":{"ratio":{"type":"number","minimum":1,"maximum":21},"largeRatio":{"type":"number","minimum":1,"maximum":21}},"additionalProperties":false}"#)),
    ("distinguishable", brandSchema(#"{"type":"object","properties":{"minDistance":{"type":"number","minimum":1,"maximum":50}},"additionalProperties":false}"#)),
    ("fonts-allowed", brandSchema(#"{"type":"object","properties":{"fonts":{"type":"array","items":{"type":"string","minLength":1},"minItems":1}},"additionalProperties":false}"#)),
]

/// `strings` in `style-surface.ts`: a non-empty array of strings, else `nil`.
public func styleStrings(_ value: JSONValue?) -> [String]? {
    guard let items = value?.arrayValue, !items.isEmpty else { return nil }
    let out = items.compactMap { $0.stringValue }
    return out.count == items.count ? out : nil
}
