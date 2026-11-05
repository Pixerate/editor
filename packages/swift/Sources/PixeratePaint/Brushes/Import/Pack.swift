import Foundation
import PixerateCore

/**
 * Brush packs people already own, read into facet brushes and image sources
 * (`brushes/import/pack.ts`):
 *
 * - Photoshop `.abr`: each sampled tip becomes an image source and a stamp-tip brush (named and
 *   spaced as its preset says, where the file says it); each computed tip a round or flat brush.
 * - Procreate `.brush` and `.brushset` (ZIP archives): each brush's `Shape.png` becomes its image
 *   tip and `Grain.png` its tip grain (Procreate's sources are white on black), with the name and
 *   spacing from `Brush.archive`.
 *
 * What a pack has that the facet model doesn't map is listed in `unsupported`, and licence or
 * terms files inside the pack are kept as `licence` notes and on every source. Nothing here writes
 * to a library: `importBrushPack` hands the brushes and sources to `BrushLibrary.importFile`.
 */

public let BRUSH_PACK_FORMATS = ["abr", "brush", "brushset"]
/// Largest pack read, bytes.
public let MAX_BRUSH_PACK_BYTES = 64 * 1024 * 1024
/// Most brushes taken from one pack.
public let MAX_PACK_BRUSHES = 300

public struct BrushPack {
    public var format: String
    public var brushes: [Brush] = []
    public var sources: [BrushSource] = []
    /// What was not imported or not mapped, in words.
    public var unsupported: [String] = []
    /// Licence and terms notes: the one given, then any found in the pack.
    public var licence: [String] = []
}

public struct BrushPackError: Error, LocalizedError {
    public let message: String
    init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// The first `n` UTF-16 units of a string (JavaScript's `slice(0, n)`).
private func jsPrefix(_ s: String, _ n: Int) -> String {
    let u = s.utf16
    if u.count <= n { return s }
    return String(decoding: Array(u.prefix(n)), as: UTF16.self)
}

private func replacing(_ s: String, _ pattern: String, _ with: String, caseInsensitive: Bool = false) -> String {
    s.replacingOccurrences(of: pattern, with: with, options: caseInsensitive ? [.regularExpression, .caseInsensitive] : .regularExpression)
}

private func slug(_ s: String, _ max: Int = 40) -> String {
    let dashed = replacing(replacing(s.lowercased(), "[^a-z0-9]+", "-"), "^-+|-+$", "")
    return replacing(jsPrefix(dashed, max), "-+$", "")
}

private func stem(_ fileName: String) -> String { replacing(replacing(fileName, "^.*[\\\\/]", ""), "\\.[a-z0-9]+$", "", caseInsensitive: true) }

private func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { Swift.min(hi, Swift.max(lo, v)) }

/// The format of a pack: as given, by its extension, or by its contents.
public func brushPackFormat(_ bytes: [UInt8], _ fileName: String, _ format: String? = nil) throws -> String {
    if let format { return format }
    if let r = fileName.range(of: "\\.([a-zA-Z]+)$", options: .regularExpression) {
        let ext = fileName[r].dropFirst().lowercased()
        if BRUSH_PACK_FORMATS.contains(ext) { return ext }
    }
    if isZip(bytes) { return "brushset" }
    if bytes.count >= 2 && [1, 2, 6, 7, 10].contains(Int(bytes[0]) << 8 | Int(bytes[1])) { return "abr" }
    throw BrushPackError("\"\(fileName)\" is not a brush pack this reads: give a .abr (Photoshop), .brush or .brushset (Procreate) file.")
}

/// Ids unique within the pack.
private final class IdMaker {
    private let prefix: String
    private var used = Set<String>()
    init(_ prefix: String) { self.prefix = prefix }
    func make(_ name: String) -> String {
        let s = slug(name, 20)
        let base = replacing(jsPrefix("\(prefix)-\(s.isEmpty ? "brush" : s)", 58), "-+$", "")
        var id = base
        var n = 2
        while used.contains(id) || !isBrushId(id) {
            id = "\(base)-\(n)"
            n += 1
        }
        used.insert(id)
        return id
    }
}

/// Text of a licence file in a pack (UTF-8, or RTF with its control words dropped), at most 4000 characters.
private func licenceText(_ name: String, _ bytes: [UInt8]) -> String? {
    var text = String(decoding: bytes.prefix(64 * 1024), as: UTF8.self)
    if name.range(of: "\\.rtf$", options: [.regularExpression, .caseInsensitive]) != nil { text = replacing(text, "\\\\[a-z]+-?\\d* ?|[{}]", "", caseInsensitive: true) }
    text = replacing(replacing(replacing(text, "\\r\\n?", "\n"), "[^\\S\\n]+", " "), "\\n{3,}", "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : "\(stem(name)): \(jsPrefix(text, 4000))"
}

private let LICENCE_FILE = "(^|/)[^/]*(licen[cs]e|terms|eula|readme|copyright)[^/]*\\.(txt|md|rtf)$"

private func readAbrPack(_ bytes: [UInt8], _ name: String, _ prefix: String, _ licence: String?, _ pack: inout BrushPack) throws {
    let file = try readAbr(bytes)
    pack.unsupported += file.unsupported
    let ids = IdMaker(prefix)
    for (i, tip) in file.tips.prefix(MAX_PACK_BRUSHES).enumerated() {
        let label = tip.name ?? "\(name) \(i + 1)"
        let brushId = ids.make(tip.name ?? String(i + 1))
        let base: Brush = ["id": .string(brushId), "name": .string(jsPrefix(label, 80)), "kind": "mark", "tags": ["imported"], "description": .string("Imported from \(name).abr.")]
        var brush = base
        switch tip {
        case .computed(_, let diameter, let roundness, let angle, let hardness, let spacing):
            brush["tip"] = ["shape": .string(roundness < 1 ? "flat" : "round"), "size": .number(diameter), "hardness": .number(hardness), "spacing": .number(spacing), "roundness": .number(roundness), "angle": .number(angle)]
            pack.brushes.append(brush)
        case .sampled(_, let width, let height, let mask, let spacing):
            do {
                let source = try brushSourceFromMask(id: "\(brushId)-shape", name: label, licence: licence, origin: "\(name).abr", width, height, mask)
                pack.sources.append(source)
                brush["tip"] = ["shape": "stamp", "size": .number(clamp(Double(Swift.max(width, height)), 1, 2500)), "spacing": .number(spacing ?? 0.25), "stamps": [.string(brushSourceRef(source.id))]]
                pack.brushes.append(brush)
            } catch {
                pack.unsupported.append("\"\(label)\": \(error.localizedDescription)")
            }
        }
    }
    if file.tips.count > MAX_PACK_BRUSHES { pack.unsupported.append("Only the first \(MAX_PACK_BRUSHES) of \(file.tips.count) tips were imported.") }
}

private func readProcreatePack(_ bytes: [UInt8], _ name: String, _ prefix: String, _ licence: String?, _ pack: inout BrushPack) throws {
    let entries: [ZipEntry]
    do { entries = try readZip(bytes) } catch { throw BrushPackError("\"\(name)\" can't be read as a Procreate brush pack: \(error.localizedDescription)") }
    var byName: [String: ZipEntry] = [:]
    for e in entries { byName[e.name] = e }
    // Licence and terms files found in the pack, after the licence given.
    var found: [String] = []
    for e in entries where e.name.range(of: LICENCE_FILE, options: [.regularExpression, .caseInsensitive]) != nil && e.size <= 1024 * 1024 {
        if let text = licenceText(e.name, try e.read()) { found.append(text) }
    }
    pack.licence += found
    let terms = found.isEmpty ? nil : jsPrefix(found.joined(separator: "\n\n"), 2000)
    let dirs = entries.filter { $0.name.range(of: "(^|/)Brush\\.archive$", options: .regularExpression) != nil }.map { String($0.name.dropLast("Brush.archive".count)) }
    if dirs.isEmpty { throw BrushPackError("\"\(name)\" has no Procreate brushes (no Brush.archive inside).") }
    let ids = IdMaker(prefix)
    let sourceLicence = [licence, terms].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
    for (i, dir) in dirs.prefix(MAX_PACK_BRUSHES).enumerated() {
        var settings: [String: PlistValue]? = nil
        if let archive = try? byName["\(dir)Brush.archive"]!.read(), isBinaryPlist(archive), let plist = try? readBinaryPlist(archive) { settings = keyedArchiveRoot(plist) }
        let own = settings?["name"]?.stringValue.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 }
        let label = jsPrefix(own ?? (dirs.count == 1 ? name : "\(name) \(i + 1)"), 80)
        let brushId = ids.make(own ?? String(i + 1))
        let trimmedDir = replacing(dir, "/$", "")
        let place = "\(name)\(dir.isEmpty ? "" : "/\(trimmedDir)")"
        func source(_ file: String, _ kind: String) -> BrushSource? {
            guard let e = byName["\(dir)\(file)"] else { return nil }
            do {
                var problems: [String] = []
                let s = try makeBrushSource(BrushSourceInput(id: "\(brushId)-\(kind)", name: "\(label) \(kind)", bytes: try e.read(), channel: "lightness", licence: sourceLicence.isEmpty ? nil : sourceLicence, origin: "\(place)/\(file)"), &problems)
                pack.sources.append(s)
                return s
            } catch {
                pack.unsupported.append("\"\(label)\" \(kind): \(error.localizedDescription)")
                return nil
            }
        }
        let shape = source("Shape.png", "shape")
        let grain = source("Grain.png", "grain")
        var tip: JSONObject = ["shape": .string(shape != nil ? "stamp" : "round"), "size": 40]
        if let plot = settings?["plotSpacing"]?.numberValue, plot > 0 { tip["spacing"] = .number(clamp(plot, 0.01, 10)) }
        if let shape { tip["stamps"] = [.string(brushSourceRef(shape.id))] }
        if let grain { tip["grain"] = ["source": .string(brushSourceRef(grain.id)), "mode": "moving"] }
        pack.brushes.append(["id": .string(brushId), "name": .string(label), "kind": "mark", "tags": ["imported", "procreate"], "description": .string("Imported from \(name)."), "tip": .object(tip)])
        if settings == nil { pack.unsupported.append("\"\(label)\": its Brush.archive could not be read; the brush takes its name from the file and default settings.") }
    }
    if dirs.count > MAX_PACK_BRUSHES { pack.unsupported.append("Only the first \(MAX_PACK_BRUSHES) of \(dirs.count) brushes were imported.") }
    pack.unsupported.append("Procreate settings other than the name, shape, grain and spacing (dynamics, Apple Pencil curves, taper, wet mix, colour dynamics, rendering modes) are not mapped.")
}

/**
 * The brushes and sources of a pack. `fileName` names the brushes and ids and picks the format by
 * its extension; `prefix` (default from the file name) prefixes the ids; `licence` is kept with
 * every source. Throws a `BrushPackError` when nothing can be read from it.
 */
public func readBrushPack(_ bytes: [UInt8], fileName: String, format: String? = nil, prefix: String? = nil, licence: String? = nil) throws -> BrushPack {
    if bytes.count > MAX_BRUSH_PACK_BYTES { throw BrushPackError("\"\(fileName)\" is \(bytes.count) bytes; packs over \(MAX_BRUSH_PACK_BYTES) bytes are not read.") }
    let format = try brushPackFormat(bytes, fileName, format)
    let s = stem(fileName)
    let name = s.isEmpty ? "Brushes" : s
    let p = slug(prefix ?? name)
    let given = licence.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : jsPrefix($0, 2000) }
    var pack = BrushPack(format: format, licence: given.map { [$0] } ?? [])
    do {
        if format == "abr" { try readAbrPack(bytes, name, p.isEmpty ? "pack" : p, given, &pack) } else { try readProcreatePack(bytes, name, p.isEmpty ? "pack" : p, given, &pack) }
    } catch let e as BrushPackError {
        throw e
    } catch {
        throw BrushPackError("\"\(fileName)\" can't be read: \(error.localizedDescription)")
    }
    if pack.brushes.isEmpty { throw BrushPackError("\"\(fileName)\" has no brushes that can be imported. \(pack.unsupported.joined(separator: " "))".trimmingCharacters(in: .whitespaces)) }
    return pack
}

public struct ImportBrushPackResult {
    public var format: String
    /// The brushes added or replaced.
    public var brushes: [(id: String, name: String)]
    /// The image sources added or replaced.
    public var sources: [String]
    /// Brush ids already in the library (or built in), left as they were.
    public var skipped: [String]
    public var unsupported: [String]
    public var licence: [String]
    /// What normalising the brushes changed.
    public var problems: [String]
}

/// Reads a pack (`readBrushPack`) and adds its brushes and sources to `library` in one import; saved ids are skipped unless `overwrite`.
public func importBrushPack(_ library: BrushLibrary, _ bytes: [UInt8], fileName: String, format: String? = nil, prefix: String? = nil, licence: String? = nil, overwrite: Bool = false) throws -> ImportBrushPackResult {
    let pack = try readBrushPack(bytes, fileName: fileName, format: format, prefix: prefix, licence: licence)
    let r = try library.importFile(["format": "pixerate-brushes", "version": 2, "brushes": .array(pack.brushes.map { .object($0) }), "sources": .array(pack.sources.map(\.json))], overwrite: overwrite)
    let done = Set(r.added + r.replaced)
    let brushes = pack.brushes.compactMap { b -> (id: String, name: String)? in
        guard let id = b["id"]?.stringValue, done.contains(id) else { return nil }
        return (id, b["name"]?.stringValue ?? "")
    }
    return ImportBrushPackResult(format: pack.format, brushes: brushes, sources: r.sources ?? [], skipped: r.skipped, unsupported: pack.unsupported, licence: pack.licence, problems: r.problems)
}
