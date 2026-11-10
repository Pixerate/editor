import Foundation
import PixerateContracts
import PixerateCore
import PixerateRaster

/**
 * `normalizeBrushSpec` (`brushes/normalize.ts`): a brush with every given field checked against
 * the brush JSON Schema (`brush.schema.json` of the brushes contracts). It stays sparse: numbers
 * are clamped into range, integers rounded, unknown fields, bad values and facets the brush does
 * not use are dropped, and each change is reported in `problems`. Only an id, name or kind it
 * cannot make sense of throws.
 */

public let BRUSH_KINDS = ["mark", "tool"]
public let BRUSH_TOOLS = ["eraser", "blender", "smudge", "water", "dryer", "blow", "blot", "wet-blend", "wet-drag"]
/// The tools that work on the wet layer.
public let WET_BRUSH_TOOLS = ["water", "dryer", "blow", "blot", "wet-blend", "wet-drag"]
public let MAX_BRUSH_PALETTE = 16

/// A brush that cannot be read (bad id, name or kind).
public struct BrushSpecError: Error, LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// The brush JSON Schema of the brushes contracts.
public enum BrushSchema {
    public static let schema: JSONObject = {
        (try? JSONValue.parse(ConformanceContracts.data("domains/brushes/brush.schema.json")))?.objectValue ?? [:]
    }()
    static var properties: JSONObject { schema["properties"]?.objectValue ?? [:] }
    /// The marks schemas by kind.
    static let marks: [String: JSONObject] = {
        var out: [String: JSONObject] = [:]
        for s in properties["marks"]?.objectValue?["oneOf"]?.arrayValue ?? [] {
            if let o = s.objectValue, let k = o["properties"]?.objectValue?["kind"]?.objectValue?["const"]?.stringValue { out[k] = o }
        }
        return out
    }()
    /// The colour kinds a brush paint can be (solid, light / dark, gradient, effect).
    static var paint: [JSONValue] { properties["colour"]?.objectValue?["properties"]?.objectValue?["default"]?.objectValue?["anyOf"]?.arrayValue ?? [] }
}

/// A number as a JS template string prints it (`undefined` when missing).
func jsText(_ v: Double?) -> String {
    guard let v else { return "undefined" }
    if v.isNaN { return "NaN" }
    return JSONValue.number(v).stringified()
}

private func matches(_ s: String, _ pattern: String) -> Bool {
    s.range(of: pattern, options: .regularExpression) != nil
}

/// A value read against `schema`, or nil when it cannot be used.
private func read(_ value: JSONValue, _ schema: JSONObject, _ path: String, _ problems: inout [String]) -> JSONValue? {
    if let c = schema["const"] {
        if value == c { return value }
        problems.append("\(path) must be \(c.stringified()); dropped.")
        return nil
    }
    let types = schema["type"]?.arrayValue?.compactMap(\.stringValue)
    if types?.contains("null") == true && value == .null { return .null }
    let schemaType = schema["type"]?.stringValue ?? types?.first { $0 != "null" }
    switch schemaType {
    case "number", "integer":
        guard let raw = value.finite else {
            problems.append("\(path) must be a number; dropped.")
            return nil
        }
        let integer = schemaType == "integer"
        var n = integer ? JS.round(raw) : raw
        let lo = schema["minimum"]?.numberValue, hi = schema["maximum"]?.numberValue
        if let lo, n < lo { n = lo }
        if let hi, n > hi { n = hi }
        if n != raw { problems.append("\(path) \(jsText(raw)) is out of range (\(jsText(lo))..\(jsText(hi))\(integer ? ", whole" : "")); set to \(jsText(n)).") }
        return .number(n)
    case "boolean":
        if case .bool = value { return value }
        problems.append("\(path) must be true or false; dropped.")
        return nil
    case "string":
        let options = schema["enum"]?.arrayValue?.compactMap(\.stringValue)
        var ok = false
        if let s = value.stringValue {
            ok = (options.map { $0.contains(s) } ?? true) && (schema["pattern"]?.stringValue.map { matches(s, $0) } ?? true) && s.utf16.count >= Int(schema["minLength"]?.numberValue ?? 0)
        }
        if !ok {
            problems.append("\(path) \(value.stringified()) is not valid\(options.map { "; use one of \($0.joined(separator: ", "))" } ?? ""); dropped.")
            return nil
        }
        if schema["pattern"]?.stringValue == "^#[0-9a-fA-F]{6}$" { return .string(value.stringValue!.lowercased()) }
        if let max = schema["maxLength"]?.numberValue { return .string(String(value.stringValue!.prefix(Int(max)))) }
        return value
    case "array":
        guard let list = value.arrayValue else {
            problems.append("\(path) must be a list; dropped.")
            return nil
        }
        var items: [JSONValue] = []
        for (i, v) in list.enumerated() {
            if let itemSchema = schema["items"]?.objectValue {
                if let r = read(v, itemSchema, "\(path)[\(i)]", &problems) { items.append(r) }
            } else {
                items.append(v)
            }
        }
        if schema["uniqueItems"] == .bool(true) {
            var unique: [JSONValue] = []
            for v in items where !unique.contains(v) { unique.append(v) }
            items = unique
        }
        if let max = schema["maxItems"]?.numberValue, items.count > Int(max) {
            problems.append("\(path) has more than \(jsText(max)) items; the rest were dropped.")
            items = Array(items.prefix(Int(max)))
        }
        if let min = schema["minItems"]?.numberValue, items.count < Int(min) {
            problems.append("\(path) needs at least \(jsText(min)) valid item(s); dropped.")
            return nil
        }
        return .array(items)
    case "object":
        return readObject(value, schema, path, &problems).map { .object($0) }
    default:
        return value
    }
}

private func readObject(_ value: JSONValue, _ schema: JSONObject, _ path: String, _ problems: inout [String]) -> JSONObject? {
    guard let o = value.objectValue else {
        problems.append("\(path) must be an object; dropped.")
        return nil
    }
    var out = JSONObject()
    let props = schema["properties"]?.objectValue
    for (key, v) in o {
        guard let child = props?[key]?.objectValue else {
            problems.append("\(path).\(key) is not a brush field; dropped.")
            continue
        }
        if let r = read(v, child, "\(path).\(key)", &problems) { out[key] = r }
    }
    return out
}

private let SOLID = #"^(#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$"#

/// A colour, or nil when it is none of the colour kinds.
private func readPaint(_ value: JSONValue, _ path: String, _ problems: inout [String]) -> JSONValue? {
    if let s = value.stringValue {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if matches(t, SOLID) { return .string(t.lowercased()) }
    } else if let o = value.objectValue, o["type"] == "gradient" {
        if case .gradient(let g)? = readPaintSource(value) { return g.json }
    } else if let o = value.objectValue, o["type"] == "effect" {
        let schemas = BrushSchema.paint
        if schemas.count > 3, validateJSONSchema(value, schemas[3]).isEmpty { return value }
    } else if let o = value.objectValue, let l = o["light"]?.stringValue, let d = o["dark"]?.stringValue, o.count == 2 {
        let lt = l.trimmingCharacters(in: .whitespacesAndNewlines), dt = d.trimmingCharacters(in: .whitespacesAndNewlines)
        if matches(lt, SOLID) && matches(dt, SOLID) { return ["light": .string(lt.lowercased()), "dark": .string(dt.lowercased())] }
    }
    problems.append("\(path) is not a colour (#rrggbb, #rrggbbaa, rgba(), { light, dark }, a gradient or effect paint); dropped.")
    return nil
}

/// The facet order of a hand-written brush.
let BRUSH_KEY_ORDER = ["id", "name", "description", "tags", "kind", "medium", "variety", "tool", "tip", "marks", "dynamics", "behaviour", "ghost", "mutation", "light", "fluorescence", "thermochromic", "iridescence", "ferro", "culture", "motion", "colour", "livePatterns"]

func orderedBrush(_ brush: JSONObject) -> Brush {
    var out = Brush()
    for k in BRUSH_KEY_ORDER { if let v = brush[k] { out[k] = v } }
    return out
}

/**
 * A brush with every given field in range (see the file comment). Throws `BrushSpecError` when
 * the id, name or kind cannot be used; every other fix is reported in `problems`.
 */
public func normalizeBrushSpec(_ rawValue: JSONValue, _ problems: inout [String]) throws -> Brush {
    guard let raw = rawValue.objectValue else { throw BrushSpecError("A brush must be an object with id, name, kind and tip.") }
    guard let id = raw["id"]?.stringValue, isBrushId(id) else {
        throw BrushSpecError("Brush id \(raw["id"].map { $0.stringified() } ?? "undefined") is not valid: use lowercase letters, digits and dashes (up to 64), starting with a letter or digit.")
    }
    let name = raw["name"]?.stringValue.map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80)) } ?? ""
    if name.isEmpty { throw BrushSpecError("Brush \"\(id)\" needs a name.") }
    let tool = raw["tool"]?.stringValue.flatMap { BRUSH_TOOLS.contains($0) ? $0 : nil }
    if let t = raw["tool"], tool == nil { problems.append("tool \(t.stringified()) is not a tool; use one of \(BRUSH_TOOLS.joined(separator: ", ")).") }
    let kind: String
    if let k = raw["kind"]?.stringValue, k == "mark" || k == "tool" { kind = k } else if raw["kind"] == nil { kind = tool != nil ? "tool" : "mark" } else {
        throw BrushSpecError("Brush \"\(id)\" kind \(raw["kind"]!.stringified()) is not valid: use mark (lays a material) or tool (works on paint already down).")
    }
    if kind == "tool" && tool == nil { throw BrushSpecError("Brush \"\(id)\" is a tool and needs tool: one of \(BRUSH_TOOLS.joined(separator: ", ")).") }

    let rawColour = raw["colour"]
    let rawMarks = raw["marks"]
    let rawFerro = raw["ferro"]
    var rest = raw.without("colour", "marks", "ferro", "kind", "id", "name", "tool")
    if let fl = rest["fluorescence"]?.finite { rest["fluorescence"] = ["amount": .number(fl)] }
    var out = readObject(.object(rest), BrushSchema.schema, "brush", &problems) ?? [:]
    if var th = out["thermochromic"]?.objectValue, let hc = th["hotColor"]?.stringValue {
        th["hotColor"] = .string(hc.lowercased())
        out["thermochromic"] = .object(th)
    }
    var brush: JSONObject = ["id": .string(id), "name": .string(name)]
    for (k, v) in out { brush[k] = v }
    brush["kind"] = .string(kind)
    if let tool { brush["tool"] = .string(tool) }
    brush["tip"] = out["tip"] ?? ["shape": "round"]

    if out["tip"] == nil { problems.append("tip is missing; a round tip is used.") }
    var tip = brush["tip"]!.objectValue!
    if tip["shape"] == nil {
        problems.append("tip.shape is missing; round is used.")
        tip["shape"] = "round"
    }
    brush["tip"] = .object(tip)

    if let rawMarks {
        let k = rawMarks.objectValue?["kind"]
        if let ks = k?.stringValue, let schema = BrushSchema.marks[ks] {
            brush["marks"] = readObject(rawMarks, schema, "brush.marks", &problems).map { .object($0) }
        } else {
            problems.append("marks.kind \(k.map { $0.stringified() } ?? "undefined") is not valid; use continuous, scatter, particles, objects, antimatter, scraper or vortex. marks dropped.")
        }
    }

    if let rawColour {
        var colourSchema = BrushSchema.properties["colour"]?.objectValue ?? [:]
        let own = colourSchema["properties"]?.objectValue?["own"] ?? ["type": "boolean"]
        colourSchema["properties"] = ["own": own, "default": [:], "palette": [:]]
        if let c = readObject(rawColour, colourSchema, "brush.colour", &problems) {
            var colour = JSONObject()
            if let d = c["default"], let p = readPaint(d, "brush.colour.default", &problems) { colour["default"] = p }
            if let palette = c["palette"] {
                if let list = palette.arrayValue {
                    var read: [JSONValue] = []
                    for (i, p) in list.enumerated() { if let v = readPaint(p, "brush.colour.palette[\(i)]", &problems) { read.append(v) } }
                    if read.count > MAX_BRUSH_PALETTE { problems.append("brush.colour.palette has more than \(MAX_BRUSH_PALETTE) colours; the rest were dropped.") }
                    colour["palette"] = .array(Array(read.prefix(MAX_BRUSH_PALETTE)))
                } else {
                    problems.append("brush.colour.palette must be a list; dropped.")
                }
            }
            if let o = c["own"]?.boolValue { colour["own"] = .bool(o) }
            brush["colour"] = .object(colour)
        }
    }

    if let rawFerro {
        let ferroObj: JSONValue = rawFerro.numberValue != nil ? ["amount": rawFerro] : rawFerro
        let ferroSchema = BrushSchema.properties["ferro"]?.objectValue ?? [:]
        if let f = readObject(ferroObj, ferroSchema, "brush.ferro", &problems), !f.isEmpty {
            brush["ferro"] = .object(f)
        }
    }

    // Facets the brush does not use are not stored.
    func drop(_ what: String, _ why: String) { problems.append("\(what) dropped: \(why).") }
    if kind == "mark" && brush["tool"] != nil {
        drop("tool", "a mark brush has no tool (set kind to tool)")
        brush["tool"] = nil
    }
    if kind == "tool" {
        if brush["medium"] != nil {
            drop("medium", "tools lay no medium")
            brush["medium"] = nil
        }
        if brush["marks"] != nil {
            drop("marks", "tools lay no marks")
            brush["marks"] = nil
        }
        if brush["ferro"] != nil {
            drop("ferro", "tools lay no ferrofluid")
            brush["ferro"] = nil
        }
        if brush["iridescence"] != nil {
            drop("iridescence", "tools lay no film")
            brush["iridescence"] = nil
        }
        if brush["culture"] != nil {
            drop("culture", "tools lay no spores")
            brush["culture"] = nil
        }
    }
    if brush["iridescence"] != nil, let marksKind = brush.path("marks.kind")?.stringValue, marksKind == "objects" || marksKind == "antimatter" {
        drop("iridescence", marksKind == "antimatter" ? "antimatter marks detonate paint, not film" : "object marks are stickers, not film")
        brush["iridescence"] = nil
    }
    if brush.path("marks.kind")?.stringValue == "objects" && brush["culture"] != nil {
        drop("culture", "object marks are stickers, not living ink")
        brush["culture"] = nil
    }
    tip = brush["tip"]!.objectValue!
    var behaviour = brush["behaviour"]?.objectValue
    if brush.path("marks.kind")?.stringValue == "scatter" {
        let surface = behaviour?["surface"]?.stringValue
        let why: String? = tip["shape"] == "bristle" ? "bristle tips lay their own marks" : (surface == "wet" || surface == "thick") ? "\(surface!) paint is not sprayed" : behaviour?["exchange"]?.objectValue?["reservoir"] != nil ? "the Mixer Brush is not sprayed" : nil
        if let why {
            drop("marks", why)
            brush["marks"] = nil
        }
    }
    if brush.path("marks.kind")?.stringValue == "objects" && tip["shape"] != "stamp" {
        problems.append("marks objects lay stamps: tip.shape set to stamp.")
        tip["shape"] = "stamp"
    }
    if tip["bristle"] != nil && tip["shape"] != "bristle" {
        drop("tip.bristle", "only bristle tips have a tuft")
        tip["bristle"] = nil
    }
    if tip["stamps"] != nil && tip["shape"] != "stamp" {
        drop("tip.stamps", "only stamp tips lay stamps")
        tip["stamps"] = nil
    }
    if let stamps = tip["stamps"]?.arrayValue {
        // Stamps are sticker refs, or image sources of the brush library, except as objects: each object mark stays a sticker.
        var refs = stamps.compactMap { $0.stringValue.flatMap(normalizeStickerRef) }
        if brush.path("marks.kind") == "objects" && refs.contains(where: isBrushSourceRef) {
            problems.append("tip.stamps: image sources (source:…) dropped: objects marks lay stickers; use continuous, scatter or particles marks for an image tip.")
            refs = refs.filter { !isBrushSourceRef($0) }
        }
        if !refs.isEmpty { tip["stamps"] = .array(refs.map { .string($0) }) } else {
            drop("tip.stamps", "none of the stamps can be laid")
            tip["stamps"] = nil
        }
    }
    if let grain = tip["grain"]?.objectValue {
        // Tip grain textures dabs: not bristles, particles or objects, nor the wet and thick engines, which lay their own marks.
        let surface = behaviour?["surface"]?.stringValue
        let marks = brush.path("marks.kind")?.stringValue
        let why: String? = grain["source"]?.stringValue == nil
            ? "it needs a source (a grain pattern or source:<id>)"
            : tip["shape"] == "bristle"
            ? "bristle tips lay their own marks"
            : marks == "particles" || marks == "objects" || marks == "antimatter" || marks == "scraper" || marks == "vortex"
            ? "\(marks!) marks are not dabs"
            : surface == "wet" || surface == "thick"
            ? "\(surface!) paint lays its own texture"
            : kind == "tool" && WET_BRUSH_TOOLS.contains(brush["tool"]?.stringValue ?? "")
            ? "the wet tools work on the wet layer"
            : nil
        if let why {
            drop("tip.grain", why)
            tip["grain"] = nil
        }
    }
    brush["tip"] = .object(tip)
    if var b = behaviour {
        let toolName = brush["tool"]?.stringValue
        let wetTool = kind == "tool" && WET_BRUSH_TOOLS.contains(toolName ?? "")
        if kind == "tool" && b["surface"] != nil {
            drop("behaviour.surface", "a tool works on the surface it finds")
            b["surface"] = nil
        }
        if b["wet"] != nil && b["surface"] != "wet" && !wetTool {
            drop("behaviour.wet", "it needs surface wet or a wet tool")
            b["wet"] = nil
        }
        if b["thick"] != nil && b["surface"] != "thick" {
            drop("behaviour.thick", "it needs surface thick")
            b["thick"] = nil
        }
        if b["strength"] != nil && !(kind == "tool" && toolName != "eraser") {
            drop("behaviour.strength", "only the blender, smudge and wet tools have a strength")
            b["strength"] = nil
        }
        if b["distance"] != nil && toolName != "blender" {
            drop("behaviour.distance", "only the blender has a blend distance")
            b["distance"] = nil
        }
        if b["length"] != nil && toolName != "smudge" {
            drop("behaviour.length", "only the smudge tool has a drag length")
            b["length"] = nil
        }
        let marksKind = brush.path("marks.kind")?.stringValue
        if b["exchange"] != nil && kind == "tool" && !wetTool {
            drop("behaviour.exchange", "the \(toolName ?? "undefined") does not pick paint up")
            b["exchange"] = nil
        } else if b["exchange"] != nil && (marksKind == "particles" || marksKind == "objects" || marksKind == "antimatter" || marksKind == "scraper" || marksKind == "vortex" || tip["shape"] == "bristle") {
            drop("behaviour.exchange", "particle, object, antimatter, scraper, vortex and bristle marks do not pick paint up")
            b["exchange"] = nil
        }
        behaviour = b
        brush["behaviour"] = .object(b)
    }
    if brush["livePatterns"] != nil && (kind != "mark" || behaviour?["surface"] != "wet") {
        drop("livePatterns", "it needs a wet mark brush (kind mark and behaviour.surface wet)")
        brush["livePatterns"] = nil
    }
    if brush["ghost"] != nil {
        if kind == "tool" || behaviour?["surface"]?.stringValue != "wet" {
            drop("ghost", "it needs a mark brush with behaviour.surface wet")
            brush["ghost"] = nil
        } else {
            if brush["light"] != nil {
                drop("light", "ghost paint uses the wet light channel as its tracer")
                brush["light"] = nil
            }
            if var b = behaviour, b["exchange"] != nil {
                drop("behaviour.exchange", "ghost paint does not pick paint up")
                b["exchange"] = nil
                behaviour = b
                brush["behaviour"] = .object(b)
            }
        }
    }
    if brush["mutation"] != nil {
        let marksKind = brush.path("marks.kind")?.stringValue
        if kind == "tool" || marksKind == "objects" || marksKind == "antimatter" || marksKind == "vortex" || behaviour?["exchange"]?.objectValue?["reservoir"] != nil {
            drop("mutation", "it needs a wet or dry mark brush (not a tool, sticker, antimatter, vortex or Mixer Brush)")
            brush["mutation"] = nil
        } else {
            if behaviour?["surface"]?.stringValue == "wet" && brush["light"] != nil {
                drop("light", "mutation wet paint uses ghost paint, which uses the wet light channel as its tracer")
                brush["light"] = nil
            }
            if var b = behaviour, b["exchange"] != nil {
                drop("behaviour.exchange", "mutation paint does not pick paint up")
                b["exchange"] = nil
                behaviour = b
                brush["behaviour"] = .object(b)
            }
        }
    }
    return orderedBrush(brush)
}

// MARK: - Patches (`brushes/patch.ts`)

/// The facets a patch can remove (`unset`), back to the engine's defaults.
public let UNSETTABLE_BRUSH_FACETS = ["description", "tags", "medium", "variety", "marks", "dynamics", "behaviour", "ghost", "mutation", "light", "fluorescence", "thermochromic", "iridescence", "ferro", "culture", "motion", "colour", "livePatterns"]

/// `base` with `patch` laid over it: objects merge, everything else (lists included) is replaced. Marks of another kind replace the marks.
public func mergeBrushPatch(_ base: JSONObject, _ patch: JSONObject, _ path: String = "") -> JSONObject {
    var out = base
    for (k, rawV) in patch {
        if path.isEmpty && (k == "culture" || k == "mutation" || k == "ghost") && rawV == .null {
            out[k] = nil
            continue
        }
        let v: JSONValue = (path.isEmpty && k == "ferro" && rawV.numberValue != nil) ? ["amount": rawV] : rawV
        let rawOld = out[k]
        let old: JSONValue? = (path.isEmpty && k == "ferro" && rawOld?.numberValue != nil) ? ["amount": rawOld!] : rawOld
        let replaceMarks = path.isEmpty && k == "marks" && old?.objectValue != nil && v.objectValue != nil && old!.objectValue!["kind"] != v.objectValue!["kind"]
        if let vo = v.objectValue, let oo = old?.objectValue, !replaceMarks {
            out[k] = .object(mergeBrushPatch(oo, vo, "\(path)\(k)."))
        } else {
            out[k] = v
        }
    }
    return out
}

/// Leaf paths whose values differ between two brushes (dot paths; lists compare whole).
public func changedBrushPaths(_ a: JSONValue?, _ b: JSONValue?, _ path: String = "") -> [String] {
    if let ao = a?.objectValue, let bo = b?.objectValue {
        var keys: [String] = []
        for k in ao.keys + bo.keys where !keys.contains(k) { keys.append(k) }
        return keys.flatMap { changedBrushPaths(ao[$0], bo[$0], path.isEmpty ? $0 : "\(path).\($0)") }
    }
    return a == b ? [] : [path]
}
