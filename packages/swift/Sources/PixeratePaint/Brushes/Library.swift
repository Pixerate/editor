import Foundation
import PixerateContracts
import PixerateCore
import PixerateRaster

/**
 * The brush library (`brushes/library.ts`): the built-in presets plus saved brushes, listed,
 * saved, duplicated, removed, exported and imported as facet brushes. The presets are the brushes
 * contracts' `presets.json` (what `BRUSH_PRESETS` exports), so they cannot drift from the TS core.
 * Storage is in memory: hosts persist brushes with `exportFile` / `importFile`.
 */

/// The built-in presets, in library order, as facet brushes.
public let BRUSH_PRESETS: [Brush] = {
    guard let list = try? JSONValue.parse(ConformanceContracts.data("domains/brushes/presets.json")).arrayValue else { return [] }
    return list.compactMap(\.objectValue)
}()

public struct BrushLibraryError: Error, LocalizedError {
    public enum Code: String, Sendable { case unknownBrush = "unknown_brush", unknownSource = "unknown_source", builtin, exists, invalid }
    public let code: Code
    public let message: String
    public init(_ code: Code, _ message: String) {
        self.code = code
        self.message = message
    }
    public var errorDescription: String? { message }
}

public struct BrushLibraryEntry: Sendable {
    public var brush: Brush
    public var builtin: Bool
}

public struct BrushFilter {
    public var kind: String?
    public var medium: String?
    /// Marks of this family (`resolveFamily`).
    public var family: String?
    public var variety: String?
    public var tool: String?
    public var tag: String?
    public var text: String?
    public var source: String?
    public init(kind: String? = nil, medium: String? = nil, family: String? = nil, variety: String? = nil, tool: String? = nil, tag: String? = nil, text: String? = nil, source: String? = nil) {
        self.kind = kind
        self.medium = medium
        self.family = family
        self.variety = variety
        self.tool = tool
        self.tag = tag
        self.text = text
        self.source = source
    }
}

/// Lowercase words of letters and digits (`/[^\p{L}\p{N}]+/u`).
func brushWords(_ s: String) -> [String] {
    var out: [String] = []
    var cur = ""
    for ch in s.lowercased() {
        if ch.unicodeScalars.allSatisfy({ CharacterSet.letters.contains($0) || CharacterSet.decimalDigits.contains($0) }) { cur.append(ch) } else if !cur.isEmpty {
            out.append(cur)
            cur = ""
        }
    }
    if !cur.isEmpty { out.append(cur) }
    return out
}

private func matches(_ entry: BrushLibraryEntry, _ f: BrushFilter) -> Bool {
    let b = entry.brush
    if let s = f.source, (s == "builtin") != entry.builtin { return false }
    if let k = f.kind, b["kind"]?.stringValue != k { return false }
    if let m = f.medium, b["medium"]?.stringValue != m { return false }
    if let v = f.variety, b["variety"]?.stringValue != v { return false }
    if let t = f.tool, b["tool"]?.stringValue != t { return false }
    if let fam = f.family, resolveFamily(b) != fam { return false }
    let tags = (b["tags"]?.arrayValue ?? []).compactMap(\.stringValue)
    if let t = f.tag, !tags.contains(t) { return false }
    if let q = f.text {
        let fields: [String] = ["id", "name", "description", "variety", "medium", "tool"].map { b[$0]?.stringValue ?? "" }
        let parts = fields + tags
        let text = brushWords(parts.joined(separator: " "))
        if !brushWords(q).allSatisfy({ w in text.contains { $0.hasPrefix(w) } }) { return false }
    }
    return true
}

/// "Closest: a, b, c. " for an unknown id, or "".
public func closestIds(_ id: String, _ ids: [String], max: Int = 3) -> String {
    let stem = Array(id.lowercased().utf16)
    let stemText = id.lowercased()
    let stemWords = brushWords(stemText)
    func score(_ c: String) -> Int {
        let cu = Array(c.utf16)
        var n = 0
        while n < Swift.min(cu.count, stem.count) && cu[n] == stem[n] { n += 1 }
        return n + (c.contains(stemText) || stemText.contains(c) ? 4 : 0) + brushWords(c).filter { stemWords.contains($0) }.count * 3
    }
    let scored = ids.map { ($0, score($0)) }.filter { $0.1 >= 3 }
    // A stable sort, as JavaScript's.
    let near = scored.enumerated().sorted { a, b in a.element.1 != b.element.1 ? a.element.1 > b.element.1 : a.offset < b.offset }.prefix(max).map(\.element.0)
    return near.isEmpty ? "" : "Closest: \(near.joined(separator: ", ")). "
}

private func isV1(_ item: JSONObject) -> Bool { item["engine"] != nil || item["category"] != nil || item["kind"] == nil }

/// Brushes read from a library file (version 1 or 2) or a bare array of brushes.
public func parseBrushLibrary(_ rawIn: JSONValue, _ problems: inout [String]) throws -> [Brush] {
    var raw = rawIn
    if let s = raw.stringValue {
        guard let parsed = try? JSONValue.parse(s) else { throw BrushLibraryError(.invalid, "Not a brush library: the text is not JSON.") }
        raw = parsed
    }
    let file = raw.objectValue
    guard let items = raw.arrayValue ?? file?["brushes"]?.arrayValue else {
        throw BrushLibraryError(.invalid, "Not a brush library: expected {\"format\":\"pixerate-brushes\",\"version\":2,\"brushes\":[...]} or an array of brushes.")
    }
    if let v = file?["version"], v != 1, v != 2 {
        throw BrushLibraryError(.invalid, "Brush library version \(v.stringified()) is not supported; this library reads versions 1 and 2.")
    }
    let v1File = file?["version"] == 1
    var out: [Brush] = []
    for (i, item) in items.enumerated() {
        let at = "brushes[\(i)]"
        guard let o = item.objectValue else { problems.append("\(at) is not an object; skipped."); continue }
        guard let id = o["id"]?.stringValue, isBrushId(id) else { problems.append("\(at) has no valid id (lowercase letters, digits and dashes); skipped."); continue }
        guard let name = o["name"]?.stringValue, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { problems.append("\(at) (\"\(id)\") has no name; skipped."); continue }
        let rest = o.without("builtin")
        var own: [String] = []
        do {
            let input: JSONValue = v1File || isV1(rest) ? .object(migrateBrushV1(normalizePaintBrush(rest))) : .object(rest)
            out.append(try normalizeBrushSpec(input, &own))
        } catch {
            own.append("\(error.localizedDescription) Skipped.")
        }
        problems += own.map { "\(at) (\"\(id)\"): \($0)" }
    }
    return out
}

/// The image sources of a library file (`sources`), each checked; bad ones are skipped and reported.
public func parseBrushLibrarySources(_ raw: JSONValue, _ problems: inout [String]) -> [BrushSource] {
    guard let file = raw.objectValue, let list = file["sources"] else { return [] }
    guard let items = list.arrayValue else {
        problems.append("sources is not a list; skipped.")
        return []
    }
    return items.enumerated().compactMap { readBrushSource($0.element, "sources[\($0.offset)]", &problems) }
}

public struct AddBrushSourceResult {
    /// The source as stored.
    public var source: BrushSource
    /// What reading the image changed (the channel picked, scaling).
    public var problems: [String]
    /// It replaced a source of the same id.
    public var replaced: Bool
}

public struct SaveBrushResult {
    public var brush: Brush
    public var problems: [String]
    public var replaced: Bool
}

public struct ImportBrushesResult {
    public var added: [String] = []
    public var replaced: [String] = []
    public var skipped: [String] = []
    public var problems: [String] = []
    /// Image sources added or replaced (nil when there were none).
    public var sources: [String]? = nil
}

/// The brush library: presets plus user brushes and image sources (in memory).
public final class BrushLibrary {
    private let presets: [Brush]
    private let builtinIds: Set<String>
    private var user: [Brush] = []
    private var sources: [BrushSource] = []
    private var listeners: [UUID: () -> Void] = [:]

    public init(presets: [Brush] = BRUSH_PRESETS) {
        self.presets = presets
        builtinIds = Set(presets.compactMap { $0["id"]?.stringValue })
    }

    private func notify() { for l in listeners.values { l() } }

    private func entries() -> [BrushLibraryEntry] {
        presets.map { BrushLibraryEntry(brush: $0, builtin: true) } + user.map { BrushLibraryEntry(brush: $0, builtin: false) }
    }

    public func subscribe(_ listener: @escaping () -> Void) -> Cancellable {
        let id = UUID()
        listeners[id] = listener
        return Cancellable { [weak self] in self?.listeners[id] = nil }
    }

    public func list(_ filter: BrushFilter = BrushFilter()) -> [BrushLibraryEntry] {
        entries().filter { matches($0, filter) }
    }

    public func get(_ id: String) -> BrushLibraryEntry? {
        entries().first { $0.brush["id"]?.stringValue == id }
    }

    public func isBuiltin(_ id: String) -> Bool { builtinIds.contains(id) }

    private func find(_ id: String) throws -> BrushLibraryEntry {
        if let e = get(id) { return e }
        throw BrushLibraryError(.unknownBrush, "No brush \"\(id)\". \(closestIds(id, entries().compactMap { $0.brush["id"]?.stringValue }))list_brush_presets lists them.")
    }

    private func refuseBuiltin(_ id: String, _ what: String) throws {
        if builtinIds.contains(id) { throw BrushLibraryError(.builtin, "\"\(id)\" is a built-in brush and can't be \(what); duplicate it first (duplicate_brush) and change the copy.") }
    }

    private func freeId(_ base: String) -> String {
        let taken = Set(entries().compactMap { $0.brush["id"]?.stringValue })
        let stem = String(base.prefix(58))
        var n = 1
        while true {
            let id = n == 1 ? "\(stem)-copy" : "\(stem)-copy-\(n)"
            if !taken.contains(id) { return id }
            n += 1
        }
    }

    private func saveLocked(_ raw: JSONValue, _ overwrite: Bool) throws -> SaveBrushResult {
        var problems: [String] = []
        let brush: Brush
        do { brush = try normalizeBrushSpec(raw, &problems) } catch { throw BrushLibraryError(.invalid, error.localizedDescription) }
        let id = brush["id"]!.stringValue!
        try refuseBuiltin(id, "overwritten")
        let at = user.firstIndex { $0["id"]?.stringValue == id }
        if at != nil && !overwrite { throw BrushLibraryError(.exists, "A brush \"\(id)\" exists already; pick another id, or update it (update_brush).") }
        if let at { user[at] = brush } else { user.append(brush) }
        return SaveBrushResult(brush: brush, problems: problems, replaced: at != nil)
    }

    public func save(_ brush: JSONValue, overwrite: Bool = false) throws -> SaveBrushResult {
        let r = try saveLocked(brush, overwrite)
        notify()
        return r
    }

    public func remove(_ id: String) throws -> Bool {
        try refuseBuiltin(id, "removed")
        guard user.contains(where: { $0["id"]?.stringValue == id }) else { return false }
        user.removeAll { $0["id"]?.stringValue == id }
        notify()
        return true
    }

    public func duplicate(_ id: String, newId: String? = nil, name: String? = nil) throws -> Brush {
        let brush = try find(id).brush
        var copy = brush
        copy["id"] = .string(newId ?? freeId(id))
        copy["name"] = .string(name ?? String("\(brush["name"]?.stringValue ?? "") copy".prefix(80)))
        let saved = try saveLocked(.object(copy), false).brush
        notify()
        return saved
    }

    public func exportFile(_ ids: [String]? = nil) throws -> JSONObject {
        let brushes = try ids.map { try $0.map { try find($0).brush } } ?? user
        var file: JSONObject = ["format": "pixerate-brushes", "version": 2, "brushes": .array(brushes.map { .object($0) })]
        let used = Set(brushes.flatMap(brushSourceIds))
        let withSources = sources.filter { used.contains($0.id) }
        if !withSources.isEmpty { file["sources"] = .array(withSources.map(\.json)) }
        return file
    }

    /// The image sources brushes lay (`tip.stamps` `source:<id>`) or texture with (`tip.grain.source`), in the order added.
    public func listSources() -> [BrushSource] { sources }

    public func getSource(_ id: String) -> BrushSource? { sources.first { $0.id == id } }

    /// Adds or replaces sources in one go; returns the ids that changed, and what was skipped in `problems`.
    private func putSources(_ incoming: [BrushSource], _ overwrite: Bool, _ problems: inout [String]) -> [String] {
        var changed: [String] = []
        for src in incoming {
            if let at = sources.firstIndex(where: { $0.id == src.id }) {
                if sources[at].image == src.image { continue }
                if overwrite {
                    sources[at] = src
                    changed.append(src.id)
                } else {
                    problems.append("Source \"\(src.id)\" exists already with another image; skipped (pass overwrite to replace it).")
                }
            } else if sources.count >= MAX_BRUSH_SOURCES {
                problems.append("Source \"\(src.id)\" skipped: the library holds at most \(MAX_BRUSH_SOURCES) sources.")
            } else {
                sources.append(src)
                changed.append(src.id)
            }
        }
        return changed
    }

    /**
     * Stores an image source made from an uploaded image (`makeBrushSource`). Without an id it gets
     * one from its name; a taken id is refused unless `overwrite`.
     */
    public func addSource(_ input: BrushSourceInput, overwrite: Bool = false) throws -> AddBrushSourceResult {
        var given = input
        if given.id == nil {
            let stem = brushSourceIdFromName(given.name)
            var id = stem
            var n = 2
            while sources.contains(where: { $0.id == id }) {
                id = "\(stem)-\(n)"
                n += 1
            }
            given.id = id
        }
        var problems: [String] = []
        let source: BrushSource
        do { source = try makeBrushSource(given, &problems) } catch { throw BrushLibraryError(.invalid, error.localizedDescription) }
        return try storeSource(source, overwrite: overwrite, problems: problems)
    }

    /// Stores a source as it is stored (a library file's, an importer's).
    public func addSource(_ source: BrushSource, overwrite: Bool = false) throws -> AddBrushSourceResult {
        try storeSource(source, overwrite: overwrite, problems: [])
    }

    private func storeSource(_ source: BrushSource, overwrite: Bool, problems: [String]) throws -> AddBrushSourceResult {
        let at = sources.firstIndex { $0.id == source.id }
        if at != nil && !overwrite { throw BrushLibraryError(.exists, "A source \"\(source.id)\" exists already; pick another id, or pass overwrite to replace its image (brushes using it change too).") }
        if at == nil && sources.count >= MAX_BRUSH_SOURCES { throw BrushLibraryError(.invalid, "The library holds at most \(MAX_BRUSH_SOURCES) sources.") }
        if let at { sources[at] = source } else { sources.append(source) }
        notify()
        return AddBrushSourceResult(source: source, problems: problems, replaced: at != nil)
    }

    public func importFile(_ rawIn: JSONValue, overwrite: Bool = false) throws -> ImportBrushesResult {
        var problems: [String] = []
        let raw = rawIn.stringValue.flatMap { try? JSONValue.parse($0) } ?? rawIn
        let incoming = try parseBrushLibrary(raw, &problems)
        var result = ImportBrushesResult()
        // Sources first, so the brushes that name them can paint as soon as they are listed.
        let fileSources = parseBrushLibrarySources(raw, &problems)
        let changedSources = fileSources.isEmpty ? [] : putSources(fileSources, overwrite, &problems)
        if !changedSources.isEmpty { result.sources = changedSources }
        var brushes = user
        for brush in incoming {
            let id = brush["id"]!.stringValue!
            if builtinIds.contains(id) {
                result.skipped.append(id)
                problems.append("\"\(id)\" is a built-in brush id; skipped (rename it to import it).")
                continue
            }
            if let at = brushes.firstIndex(where: { $0["id"]?.stringValue == id }) {
                if overwrite {
                    brushes[at] = brush
                    result.replaced.append(id)
                } else {
                    result.skipped.append(id)
                    problems.append("\"\(id)\" exists already; skipped (pass overwrite to replace it).")
                }
            } else {
                brushes.append(brush)
                result.added.append(id)
            }
        }
        result.problems = problems
        if !result.added.isEmpty || !result.replaced.isEmpty { user = brushes }
        if !result.added.isEmpty || !result.replaced.isEmpty || !changedSources.isEmpty { notify() }
        return result
    }
}

// MARK: - The paint editor's side of the library (`paint-editor/brush-library.ts`)

/// A library brush as the paint editor keeps it: its facets and the engine form it paints with.
public struct LibraryBrush: Sendable {
    public var spec: Brush
    public var brush: PaintBrush
    public var builtin: Bool
}

func libraryBrush(_ spec: Brush, _ builtin: Bool, _ resolved: PaintBrush? = nil) -> LibraryBrush {
    var brush = resolved.map(renormalized) ?? resolveBrush(spec)
    brush.builtin = builtin ? true : nil
    return LibraryBrush(spec: spec, brush: brush, builtin: builtin)
}

/// The built-in presets, paired with the engine brushes they resolve to.
let builtinLibraryBrushes: [LibraryBrush] = BRUSH_PRESETS.map { libraryBrush($0, true) }

/// The engine brush without what doesn't change how it paints (the library category, built-in).
private func paints(_ b: PaintBrush) -> JSONObject { b.json(builtin: false).without("category") }

/**
 * The facet brush an engine brush edited by its settings amounts to (`migrateBrushV1`), keeping
 * what the engine doesn't read from the brush it was edited from.
 */
func brushSpecOf(_ next: PaintBrush, _ from: Brush) -> Brush {
    let plain = migrateBrushV1(next)
    var out = plain
    if let d = from["description"] { out["description"] = d }
    if let tags = from["tags"]?.arrayValue, !tags.isEmpty { out["tags"] = .array(tags) }
    if out["kind"] == "mark" && from["kind"] == "mark" {
        if let m = from["medium"] { out["medium"] = m }
        if let v = from["variety"] { out["variety"] = v }
    }
    var colour = from["colour"]?.objectValue ?? [:]
    if let d = plain.path("colour.default") { colour["default"] = d } else if colour["default"]?.objectValue?["type"] == "gradient" { colour["default"] = nil }
    if !colour.isEmpty { out["colour"] = .object(colour) } else { out["colour"] = nil }
    if (out.path("light.amount")?.numberValue ?? 0) > 0, from.path("light.spill") != nil || from.path("light.glow") != nil {
        var light = out["light"]?.objectValue ?? [:]
        if let s = from.path("light.spill") { light["spill"] = s }
        if let g = from.path("light.glow") { light["glow"] = g }
        out["light"] = .object(light)
    }
    if from.path("motion.live") != nil || from.path("motion.fps") != nil {
        var motion = out["motion"]?.objectValue ?? [:]
        if let l = from.path("motion.live") { motion["live"] = l }
        if let f = from.path("motion.fps") { motion["fps"] = f }
        out["motion"] = .object(motion)
    }
    var ignored: [String] = []
    if let hinted = try? normalizeBrushSpec(.object(orderedBrush(out)), &ignored), paints(resolveBrush(hinted)) == paints(resolveBrush(plain)) { return hinted }
    return plain
}

/// The engine settings `next` changes on `base`, as `normalizePaintBrush(changes, base)` takes them (lists whole).
func engineChanges(_ base: PaintBrush, _ next: PaintBrush) -> JSONObject {
    func diff(_ a: JSONValue?, _ b: JSONValue) -> JSONValue? {
        if let ao = a?.objectValue, let bo = b.objectValue {
            var out = JSONObject()
            for (k, v) in bo { if let d = diff(ao[k], v) { out[k] = d } }
            return out.isEmpty ? .none : .some(.object(out))
        }
        return a == b ? .none : .some(b)
    }
    var out = (diff(.object(base.json()), .object(next.json()))?.objectValue ?? [:]).without("id", "builtin")
    if base.iridescence != nil && next.iridescence == nil { out["iridescence"] = .null }
    return out
}
