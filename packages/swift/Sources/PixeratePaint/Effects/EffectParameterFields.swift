import Foundation
import PixerateCore

/**
 An effect's controls as parameter fields (`effects/ui.ts`: `effectControlField`,
 `effectParameterFields`, `isEffectFontControl`), as the JSON `ParameterField` objects the TS core
 builds (same keys, same order), so `effect_authoring_describe` returns the same `controls`.
 */

/// A font family a font control offers, and its category (`FontSummary.family` / `.category`).
public struct EffectFieldFont: Equatable, Sendable {
    public var family: String
    public var category: String
    public init(family: String, category: String) {
        self.family = family
        self.category = category
    }
}

/// The TS core's `SYSTEM_FONT_CATALOG` families and categories, in its order.
public let SYSTEM_FONT_FAMILIES: [EffectFieldFont] = [
    ("Arial", "sans-serif"), ("Helvetica", "sans-serif"), ("Helvetica Neue", "sans-serif"), ("Segoe UI", "sans-serif"), ("Roboto", "sans-serif"), ("Verdana", "sans-serif"),
    ("Tahoma", "sans-serif"), ("Trebuchet MS", "sans-serif"), ("Calibri", "sans-serif"), ("Candara", "sans-serif"), ("Optima", "sans-serif"), ("Gill Sans", "sans-serif"),
    ("Avenir", "sans-serif"), ("Avenir Next", "sans-serif"), ("Futura", "sans-serif"), ("Century Gothic", "sans-serif"), ("Noto Sans", "sans-serif"), ("DejaVu Sans", "sans-serif"),
    ("Liberation Sans", "sans-serif"), ("Ubuntu", "sans-serif"), ("Cantarell", "sans-serif"), ("Georgia", "serif"), ("Times New Roman", "serif"), ("Times", "serif"),
    ("Cambria", "serif"), ("Constantia", "serif"), ("Sitka Text", "serif"), ("Charter", "serif"), ("Iowan Old Style", "serif"), ("Palatino", "serif"), ("Palatino Linotype", "serif"),
    ("Baskerville", "serif"), ("Hoefler Text", "serif"), ("Garamond", "serif"), ("Book Antiqua", "serif"), ("Noto Serif", "serif"), ("DejaVu Serif", "serif"),
    ("Liberation Serif", "serif"), ("Menlo", "monospace"), ("Monaco", "monospace"), ("SF Mono", "monospace"), ("Consolas", "monospace"), ("Cascadia Code", "monospace"),
    ("Cascadia Mono", "monospace"), ("Courier New", "monospace"), ("Lucida Console", "monospace"), ("DejaVu Sans Mono", "monospace"), ("Liberation Mono", "monospace"),
    ("Ubuntu Mono", "monospace"), ("Droid Sans Mono", "monospace"), ("Impact", "display"), ("Copperplate", "display"), ("Rockwell", "display"), ("Didot", "display"),
    ("Bodoni 72", "display"), ("Arial Black", "display"), ("Comic Sans MS", "handwriting"), ("Segoe Print", "handwriting"), ("Segoe Script", "handwriting"),
    ("Bradley Hand", "handwriting"), ("Brush Script MT", "handwriting"), ("Snell Roundhand", "handwriting"), ("Noteworthy", "handwriting"),
].map { EffectFieldFont(family: $0.0, category: $0.1) }

/// Whether `s` is `#rrggbb` or `#rrggbbaa` (any case).
func isHexColour(_ s: String) -> Bool {
    let u = Array(s.utf8)
    guard u.count == 7 || u.count == 9, u[0] == 0x23 else { return false }
    return u.dropFirst().allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x46) || ($0 >= 0x61 && $0 <= 0x66) }
}

/// The schema's type: the first non-null of a list, or the string.
private func typeOf(_ s: JSONObject) -> String? {
    if let list = s["type"]?.arrayValue { return list.compactMap(\.stringValue).first { $0 != "null" } }
    return s["type"]?.stringValue
}

/// The JSON Schema type a value has (nil for none).
private func jsonTypeOf(_ v: JSONValue?) -> String? {
    switch v {
    case .array?: return "array"
    case .string?: return "string"
    case .bool?: return "boolean"
    case .number?: return "number"
    default: return nil
    }
}

/// JavaScript truthiness of a schema keyword's value.
private func truthy(_ v: JSONValue?) -> Bool {
    switch v {
    case nil, .null?: return false
    case .bool(let b)?: return b
    case .number(let n)?: return n != 0 && !n.isNaN
    case .string(let s)?: return !s.isEmpty
    default: return true
    }
}

/// Whether a control picks a font family: a string schema with `format: "font"` or `"x-pixerate-control": "font"`.
public func isEffectFontControl(_ schema: JSONObject) -> Bool {
    typeOf(schema) == "string" && (schema["format"]?.stringValue == "font" || schema["x-pixerate-control"]?.stringValue == "font")
}

/// One control as a parameter field (`effectControlField`), or nil for a control no field can edit.
public func effectControlField(_ name: String, _ schema: JSONObject, _ fallback: JSONValue?, fonts: [EffectFieldFont] = SYSTEM_FONT_FAMILIES) -> JSONObject? {
    var f: JSONObject = ["id": .string(name)]
    if truthy(schema["title"]) { f["label"] = schema["title"] }
    if truthy(schema["description"]) { f["description"] = schema["description"] }
    let schemaDefault = schema["default"]
    let def: JSONValue? = schemaDefault == nil || schemaDefault == .null ? fallback : schemaDefault
    let anyOf = (schema["anyOf"]?.arrayValue ?? []).map { $0.objectValue ?? [:] }
    let type = typeOf(schema) ?? anyOf.first(where: { typeOf($0) == jsonTypeOf(def) }).flatMap(typeOf)
    if let list = schema["enum"]?.arrayValue, !list.isEmpty {
        let options = list.filter { $0.stringValue != nil || $0.numberValue != nil }
        f["type"] = "choice"
        f["options"] = .array(options)
        if case .string? = def { f["default"] = def } else if case .number? = def { f["default"] = def } else if let first = options.first { f["default"] = first }
        f["control"] = .string(options.count <= 4 ? "segmented" : "select")
        return f
    }
    if type == "number" || type == "integer" {
        let lo = schema["minimum"] ?? schema["exclusiveMinimum"]
        let hi = schema["maximum"] ?? schema["exclusiveMaximum"]
        f["type"] = .string(type == "integer" ? "int" : "number")
        if case .number? = def { f["default"] = def } else { f["default"] = lo ?? 0 }
        if let lo { f["min"] = lo }
        if let hi { f["max"] = hi }
        if truthy(schema["multipleOf"]) { f["step"] = schema["multipleOf"] }
        return f
    }
    if type == "boolean" {
        f["type"] = "boolean"
        f["default"] = .bool(def == .bool(true))
        return f
    }
    if isEffectFontControl(schema) {
        var opts: [(value: String, label: String, description: String)] = fonts.map { ($0.family, $0.family, $0.category) }
        let current: String = { if let s = def?.stringValue, !s.isEmpty { return s }; return opts.first?.value ?? "sans-serif" }()
        if !opts.contains(where: { $0.value.lowercased() == current.lowercased() }) { opts.insert((current, current, "current"), at: 0) }
        f["type"] = "choice"
        f["options"] = .array(opts.map { ["value": .string($0.value), "label": .string($0.label), "description": .string($0.description)] })
        f["default"] = .string(opts.first { $0.value.lowercased() == current.lowercased() }!.value)
        f["control"] = "select"
        return f
    }
    if type == "string" {
        if let s = def?.stringValue, isHexColour(s) {
            f["type"] = "color"
            f["alpha"] = .bool(s.utf16.count == 9)
            f["default"] = .string(s)
            return f
        }
        f["type"] = "text"
        f["default"] = .string(def?.stringValue ?? "")
        if truthy(schema["maxLength"]) { f["maxLength"] = schema["maxLength"] }
        return f
    }
    if type == "array", let a = def?.arrayValue, a.count >= 2, a.count <= 4, a.allSatisfy({ $0.numberValue != nil }) {
        let own = schema["items"].flatMap { $0 == .null ? nil : $0 }
        let items = own.map { $0.objectValue ?? [:] } ?? anyOf.first(where: { typeOf($0) == "array" })?["items"]?.objectValue ?? [:]
        f["type"] = "vector"
        f["size"] = .number(Double(a.count))
        f["default"] = .array(a)
        if let lo = items["minimum"] { f["min"] = lo }
        if let hi = items["maximum"] { f["max"] = hi }
        return f
    }
    return nil
}

/// An effect's controls as parameter fields, in schema order (controls no field can edit are left out).
public func effectParameterFields(_ description: EffectDescription, fonts: [EffectFieldFont] = SYSTEM_FONT_FAMILIES) -> [JSONObject] {
    let props = description.controls["properties"]?.objectValue ?? [:]
    let defaults = description.defaults
    return props.compactMap { name, schema in effectControlField(name, schema.objectValue ?? [:], defaults[name], fonts: fonts) }
}
