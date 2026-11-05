import Foundation
import PixerateCore
import PixeratePaint
import PixerateRaster

// Brushstrokes on vector paths (`vector/brushstroke.ts`): a stroke layer of kind `brushstroke`
// paints the path with a natural-media brush from the paint editor's library. This port has the
// data side: the brushes the vector profile admits (`vector.listBrushes`), the brushstroke
// settings stored in a layer (`sanitizeVectorBrushstroke`), their checks, default colours and
// reach. Drawing one (`vectorBrushstrokeImages`) runs the raster brush engine over the path, which
// is not ported yet: render data and SVG export of brushstrokes throw `VectorNotPorted` (#624).

/// The largest brushstroke seed.
public let VECTOR_BRUSHSTROKE_MAX_SEED = 2147483647.0

/// The presets `VECTOR_PROFILE` admits, as the engine paints them (`PRESETS`).
private let PRESETS: [PaintBrush] = BRUSH_PRESETS.filter { checkBrush($0, VECTOR_PROFILE).ok }.map { resolveBrush($0, builtin: true) }

/// Whether a brush's engine paints vector brushstrokes: dry dab brushes, wet paint, the Mixer Brush, smudge and blender.
func isVectorBrushstrokeEngine(_ brush: PaintBrush) -> Bool {
    brush.engine == "dab" || vectorMediaEngine(brush) != nil
}

/// `wet`, `mixer`, `smudge` or `blender` for the brushes that need the media engines, else nil (`vectorMediaEngine`).
func vectorMediaEngine(_ brush: PaintBrush) -> String? {
    if brush.engine == "wet" { return brush.wet.tool == "paint" ? "wet" : nil }
    return ["mixer", "smudge", "blender"].contains(brush.engine) ? brush.engine : nil
}

/// A saved brush the vector profile admits, normalised, or nil (`admitted`).
private func admitted(_ spec: JSONValue?) -> JSONObject? {
    guard let spec else { return nil }
    var problems: [String] = []
    guard let brush = try? normalizeBrushSpec(spec, &problems) else { return nil }
    return checkBrush(brush, VECTOR_PROFILE).ok && isVectorBrushstrokeEngine(resolveBrush(brush)) ? brush : nil
}

/// One brush a brushstroke can use, as `vector.listBrushes` lists it.
public struct VectorBrushstrokeBrushInfo: Sendable {
    public var id: String
    public var name: String
    public var category: String
    /// The brush's own diameter in document units.
    public var size: Double
    /// A preset (not a saved brush).
    public var builtin: Bool
}

/// The brushes a brushstroke can use (`vectorBrushstrokeBrushes`): the presets `VECTOR_PROFILE`
/// admits, then the saved brushes given (facet brushes, e.g. a brush library's) it admits.
public func vectorBrushstrokeBrushes(_ user: [JSONObject] = []) -> [VectorBrushstrokeBrushInfo] {
    var out = PRESETS
    for raw in user {
        if let brush = admitted(.object(raw)), let id = brush["id"]?.stringValue, !out.contains(where: { $0.id == id }) { out.append(resolveBrush(brush)) }
    }
    return out.map { b in VectorBrushstrokeBrushInfo(id: b.id, name: b.name, category: b.category, size: b.tip.size, builtin: isVectorBrushstrokePreset(b.id)) }
}

/// Whether `id` is a preset brushstroke brush (`vectorBrushstrokeBrush(id) !== null`).
public func isVectorBrushstrokePreset(_ id: String) -> Bool { PRESETS.contains { $0.id == id } }

/// The engine brush a brushstroke paints with: its embedded saved brush, else the preset; nil when neither renders.
private func brushOf(_ brush: JSONObject) -> PaintBrush? {
    let id = brush["brushId"]?.stringValue
    if let spec = brush["spec"], spec != .null {
        guard let saved = admitted(spec), saved["id"]?.stringValue == id else { return nil }
        return resolveBrush(saved)
    }
    return PRESETS.first { $0.id == id }
}

private func brushIssues(_ b: JSONObject) -> String {
    let reasons = checkBrush(b, VECTOR_PROFILE).issues.filter { $0.severity == "error" }.map { "\($0.reason) \($0.fix)" }.joined(separator: " ")
    return reasons.isEmpty ? "its engine does not paint brushstrokes." : reasons
}

/// Why a brush id can't paint a brushstroke (with the ids that can), or nil when it can
/// (`vectorBrushstrokeBrushError`). `user` are the saved brushes on offer.
public func vectorBrushstrokeBrushError(_ id: String, _ user: [JSONObject] = []) -> String? {
    if isVectorBrushstrokePreset(id) { return nil }
    let ids = vectorBrushstrokeBrushes(user).map(\.id).joined(separator: ", ")
    if let saved = user.first(where: { $0["id"]?.stringValue == id }) {
        return admitted(.object(saved)) != nil ? nil : "Brush \"\(id)\" (\(saved["name"]?.stringValue ?? "")) can't paint a brushstroke: \(brushIssues(saved)) Use one of: \(ids)."
    }
    if let preset = BRUSH_PRESETS.first(where: { $0["id"]?.stringValue == id }) {
        return "Brush \"\(id)\" (\(preset["name"]?.stringValue ?? "")) can't paint a brushstroke: \(brushIssues(preset)) Use one of: \(ids)."
    }
    return "Unknown brush \"\(id)\". \(closestIds(id, vectorBrushstrokeBrushes(user).map(\.id)))Use one of: \(ids) (vector.listBrushes lists them)."
}

/// The default colour of brush `id` (a preset, else a saved brush of `user`) as a hex colour for
/// `scheme`, or nil when it has none (`vectorBrushstrokeDefaultColour`).
public func vectorBrushstrokeDefaultColour(_ id: String, _ user: [JSONObject] = [], scheme: String = "light") -> String? {
    guard let brush = BRUSH_PRESETS.first(where: { $0["id"]?.stringValue == id }) ?? user.first(where: { $0["id"]?.stringValue == id }) else { return nil }
    guard let value = brush["colour"]?["default"] else { return nil }
    return brushColourHex(value, scheme)
}

/// Mappings that need timed samples, which vector paths don't have.
private let TIMED_MAPPINGS = ["velocity", "time"]

/// What is wrong with a brushstroke's gradient `paint`, or nil when it is valid (`vectorBrushstrokePaintError`).
public func vectorBrushstrokePaintError(_ paint: JSONValue?) -> String? {
    let source: PaintSource
    do { source = try parsePaintSource(paint, at: "paint") } catch { return (error as? PaintSourceError)?.message ?? "\(error)" }
    if case .gradient(let g) = source, TIMED_MAPPINGS.contains(g.map.by) {
        return "paint.map.by \"\(g.map.by)\" needs timed samples, which vector paths do not have; use distance, pressure, tilt, direction, across-tip or random."
    }
    return nil
}

/// Brushstroke paint from untrusted data (a stored layer), with its defaults; nil when it is not valid paint.
public func readVectorBrushstrokePaint(_ value: JSONValue?) -> JSONValue? {
    guard let value, value != .null, vectorBrushstrokePaintError(value) == nil else { return nil }
    return readPaintSource(value)?.json
}

private func finite(_ v: JSONValue?) -> Double? { v?.numberValue.flatMap { $0.isFinite ? $0 : nil } }
private func sanitizeSeed(_ v: JSONValue?) -> Double? { finite(v).map { JS.min(VECTOR_BRUSHSTROKE_MAX_SEED, JS.max(0, JS.round($0))) } }
private func isSeed(_ v: JSONValue?) -> Bool {
    guard let n = v?.numberValue, n.isFinite, n.rounded(.towardZero) == n else { return false }
    return n >= 0 && n <= VECTOR_BRUSHSTROKE_MAX_SEED
}

/// Paper settings from untrusted data; nil when there are none (`sanitizeVectorBrushstrokePaper`).
public func sanitizeVectorBrushstrokePaper(_ value: JSONValue?) -> JSONObject? {
    guard let r = value?.objectValue else { return nil }
    var out = JSONObject()
    if let p = r["pattern"]?.stringValue, GRAIN_PATTERNS.contains(p) { out["pattern"] = .string(p) }
    if let seed = sanitizeSeed(r["seed"]) { out["seed"] = .number(seed) }
    if let s = finite(r["scale"]), s > 0 { out["scale"] = .number(JS.min(8, JS.max(0.25, s))) }
    if let d = finite(r["depth"]) { out["depth"] = .number(JS.min(1, JS.max(0, d))) }
    return out.isEmpty ? nil : out
}

/// What is wrong with a brushstroke's `seed` or `paper`, or nil when they are valid or absent
/// (`vectorBrushstrokeCharacterError`).
public func vectorBrushstrokeCharacterError(seed: JSONValue?, paper: JSONValue?) -> String? {
    let max = JSONValue.jsNumber(VECTOR_BRUSHSTROKE_MAX_SEED)
    if let seed, !isSeed(seed) { return "seed must be an integer from 0 to \(max)." }
    guard let paper, paper != .null else { return nil }
    guard let r = paper.objectValue else { return "paper must be an object { pattern, seed, scale, depth } or null for no grain." }
    let extra = r.keys.filter { !["pattern", "seed", "scale", "depth"].contains($0) }
    if !extra.isEmpty { return "paper has unknown field \(extra.map { "\"\($0)\"" }.joined(separator: ", ")): use pattern, seed, scale, depth." }
    if let p = r["pattern"], !(p.stringValue.map(GRAIN_PATTERNS.contains) ?? false) {
        return "Unknown paper pattern \"\(p.stringValue ?? p.stringified())\": use one of \(GRAIN_PATTERNS.joined(separator: ", "))."
    }
    if let s = r["seed"], !isSeed(s) { return "paper.seed must be an integer from 0 to \(max)." }
    if let s = r["scale"], !(finite(s).map { $0 >= 0.25 && $0 <= 8 } ?? false) { return "paper.scale must be from 0.25 to 8 (1 is the pattern's natural size)." }
    if let d = r["depth"], !(finite(d).map { $0 >= 0 && $0 <= 1 } ?? false) { return "paper.depth must be from 0 to 1." }
    return nil
}

/// Brushstroke settings from untrusted data, or nil when the brush is unknown
/// (`sanitizeVectorBrushstroke`): `{ brushId, spec?, size?, pressure?, seed?, paint?, paper? }`. A
/// saved brush is taken from `spec` (a stored layer) or from `user` and kept in `spec`.
public func sanitizeVectorBrushstroke(_ value: JSONValue?, _ user: [JSONObject] = []) -> JSONObject? {
    guard let r = value?.objectValue, let brushId = r["brushId"]?.stringValue else { return nil }
    var out = JSONObject([("brushId", .string(brushId))])
    if !isVectorBrushstrokePreset(brushId) {
        let raw = r["spec"] ?? user.first { $0["id"]?.stringValue == brushId }.map { .object($0) }
        guard let spec = admitted(raw), spec["id"]?.stringValue == brushId else { return nil }
        out["spec"] = .object(spec)
    }
    if let size = finite(r["size"]), size > 0 { out["size"] = .number(JS.min(500, size)) }
    if let list = r["pressure"]?.arrayValue {
        let p = list.compactMap { finite($0) }.map { JS.min(1, JS.max(0, $0)) }
        if !p.isEmpty { out["pressure"] = .array(p.prefix(64).map { .number($0) }) }
    }
    if let seed = sanitizeSeed(r["seed"]) { out["seed"] = .number(seed) }
    if let paint = readVectorBrushstrokePaint(r["paint"]) { out["paint"] = paint }
    if r["paper"] == .null { out["paper"] = .null } else if let paper = sanitizeVectorBrushstrokePaper(r["paper"]) { out["paper"] = .object(paper) }
    return out
}

/// A brushstroke stroke layer: kind `brushstroke` with a known brush (`isVectorBrushstrokeLayer`).
public func isVectorBrushstrokeLayer(_ layer: JSONObject) -> Bool {
    guard layer["kind"] == "brushstroke", let brush = layer["brush"]?.objectValue else { return false }
    return brushOf(brush) != nil
}

/// How far a brushstroke layer reaches past the path: half its brush size (`vectorBrushstrokeReach`).
public func vectorBrushstrokeReach(_ layer: JSONObject) -> Double {
    guard isVectorBrushstrokeLayer(layer), let brush = layer["brush"]?.objectValue else { return 0 }
    return (brush["size"]?.numberValue ?? brushOf(brush)!.tip.size) / 2
}
