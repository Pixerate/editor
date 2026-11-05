import Foundation
import PixerateCore
import PixerateRaster

/**
 * Brush sources (`brushes/sources.ts`): the images a brush is made from, as Procreate's Shape and
 * Grain sources. A source is a grey mask (255 paints, or is a grain peak; 0 is empty) kept as a
 * greyscale PNG `data:` URL, so a library file or a saved painting carries its bytes alongside the
 * brushes that name it.
 *
 * - A stamp tip lays a source with the ref `source:<id>` in `tip.stamps`, the same way it lays a
 *   sticker: shaped dabs, sprays and particle dots all take it.
 * - `tip.grain.source` takes `source:<id>` as a grain texture (or one of the built-in grain
 *   patterns).
 */

/// The ref prefix of a brush source: `source:<id>`.
public let BRUSH_SOURCE_PROVIDER = "source"
/// Longest side a source is kept at (px); larger images are scaled down when added.
public let MAX_BRUSH_SOURCE_SIZE = 512
/// Largest image `makeBrushSource` decodes (pixels).
public let MAX_BRUSH_SOURCE_INPUT_PIXELS = 4096 * 4096
/// Most sources one library keeps.
public let MAX_BRUSH_SOURCES = 500
public let BRUSH_SOURCE_CHANNELS = ["auto", "alpha", "darkness", "lightness"]

/// A stored source.
public struct BrushSource: Equatable, Sendable {
    public var id: String
    public var name: String
    public var width: Int
    public var height: Int
    /// The mask: a greyscale PNG `data:` URL, 255 paints.
    public var image: String
    public var licence: String?
    public var origin: String?

    public init(id: String, name: String, width: Int, height: Int, image: String, licence: String? = nil, origin: String? = nil) {
        self.id = id
        self.name = name
        self.width = width
        self.height = height
        self.image = image
        self.licence = licence
        self.origin = origin
    }

    /// The stored form (as library files and saved paintings carry it).
    public var json: JSONValue {
        var o: JSONObject = ["id": .string(id), "name": .string(name), "width": .number(Double(width)), "height": .number(Double(height)), "image": .string(image)]
        if let licence { o["licence"] = .string(licence) }
        if let origin { o["origin"] = .string(origin) }
        return .object(o)
    }

    /// The list form: without the image, with its ref.
    public var summary: JSONObject {
        var o: JSONObject = ["id": .string(id), "name": .string(name), "width": .number(Double(width)), "height": .number(Double(height))]
        if let licence { o["licence"] = .string(licence) }
        if let origin { o["origin"] = .string(origin) }
        o["ref"] = .string(brushSourceRef(id))
        return o
    }
}

/// What `makeBrushSource` reads.
public struct BrushSourceInput: Sendable {
    public var id: String?
    public var name: String
    /// A PNG as a `data:image/png;base64,…` URL (or empty, with `bytes`).
    public var image: String
    /// The PNG's bytes, read instead of `image` when given.
    public var bytes: [UInt8]?
    public var channel: String?
    public var invert: Bool
    public var licence: String?
    public var origin: String?

    public init(id: String? = nil, name: String, image: String = "", bytes: [UInt8]? = nil, channel: String? = nil, invert: Bool = false, licence: String? = nil, origin: String? = nil) {
        self.id = id
        self.name = name
        self.image = image
        self.bytes = bytes
        self.channel = channel
        self.invert = invert
        self.licence = licence
        self.origin = origin
    }
}

/// A refusal; the message says what to do instead.
public struct BrushSourceError: Error, LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public func brushSourceRef(_ id: String) -> String { "\(BRUSH_SOURCE_PROVIDER):\(id)" }

/// Whether a stamp or grain ref names a brush source.
public func isBrushSourceRef(_ ref: String) -> Bool { ref.hasPrefix("\(BRUSH_SOURCE_PROVIDER):") }

/// The source id of a `source:<id>` ref, or nil for any other ref.
public func brushSourceIdOf(_ ref: String) -> String? {
    isBrushSourceRef(ref) ? String(ref.dropFirst(BRUSH_SOURCE_PROVIDER.count + 1)) : nil
}

/// The ids of the sources a facet brush lays or textures with (its stamp tip and its grain).
public func brushSourceIds(_ brush: Brush) -> [String] {
    var refs = (brush.path("tip.stamps")?.arrayValue ?? []).compactMap(\.stringValue)
    if let g = brush.path("tip.grain.source")?.stringValue { refs.append(g) }
    var out: [String] = []
    for id in refs.compactMap(brushSourceIdOf) where !out.contains(id) { out.append(id) }
    return out
}

/// An id from a name: lowercase words joined by dashes.
public func brushSourceIdFromName(_ name: String) -> String {
    let dashed = name.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
    let trimmed = dashed.replacingOccurrences(of: "^-+|-+$", with: "", options: .regularExpression)
    let id = String(trimmed.prefix(60))
    return id.isEmpty ? "source" : id
}

private func text(_ v: String?, _ max: Int) -> String? {
    guard let t = v?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
    return String(t.prefix(max))
}

/// Box-filters a grey mask down to fit `max` on its longest side (unchanged when it already fits).
private func fit(_ width: Int, _ height: Int, _ mask: [UInt8], _ max: Int) -> (width: Int, height: Int, mask: [UInt8]) {
    let scale = Swift.min(1, Double(max) / Double(Swift.max(width, height)))
    if scale >= 1 { return (width, height, mask) }
    let w = Swift.max(1, Int(JS.round(Double(width) * scale)))
    let h = Swift.max(1, Int(JS.round(Double(height) * scale)))
    var out = [UInt8](repeating: 0, count: w * h)
    for y in 0..<h {
        let y0 = (y * height) / h
        let y1 = Swift.max(y0 + 1, ((y + 1) * height) / h)
        for x in 0..<w {
            let x0 = (x * width) / w
            let x1 = Swift.max(x0 + 1, ((x + 1) * width) / w)
            var sum = 0
            for yy in y0..<y1 { for xx in x0..<x1 { sum += Int(mask[yy * width + xx]) } }
            out[y * w + x] = UInt8(JS.round(Double(sum) / Double((y1 - y0) * (x1 - x0))))
        }
    }
    return (w, h, out)
}

/**
 * A source from a grey mask (255 paints), scaled to fit `MAX_BRUSH_SOURCE_SIZE`. Importers use it
 * for tips they have decoded themselves. Throws when the mask is empty or the wrong size.
 */
public func brushSourceFromMask(id: String, name: String, licence: String? = nil, origin: String? = nil, _ width: Int, _ height: Int, _ mask: [UInt8]) throws -> BrushSource {
    if !isBrushId(id) { throw BrushSourceError("Source id \(JSONValue.string(id).stringified()) is not valid: use lowercase letters, digits and dashes (up to 64).") }
    if !(width > 0 && height > 0) || mask.count != width * height { throw BrushSourceError("The mask is not width × height bytes.") }
    if !mask.contains(where: { $0 > 0 }) { throw BrushSourceError("\"\(name)\" has no marks: every pixel is empty. Pick another channel (alpha, darkness or lightness) or set invert.") }
    let f = fit(width, height, mask, MAX_BRUSH_SOURCE_SIZE)
    return BrushSource(id: id, name: text(name, 80) ?? id, width: f.width, height: f.height, image: pngDataUrl(f.width, f.height, f.mask, 1), licence: text(licence, 2000), origin: text(origin, 200))
}

/**
 * A source from an uploaded image: its marks read from `channel` (`auto`: the transparency when
 * the image has any, else the dark parts), inverted when asked, scaled to fit. Throws when the
 * image is not a PNG, too large, or empty in that channel; `problems` hears what was changed.
 */
public func makeBrushSource(_ input: BrushSourceInput, _ problems: inout [String]) throws -> BrushSource {
    guard let name = text(input.name, 80) else { throw BrushSourceError("A brush source needs a name.") }
    let id = input.id ?? brushSourceIdFromName(name)
    if !isBrushId(id) { throw BrushSourceError("Source id \(JSONValue.string(id).stringified()) is not valid: use lowercase letters, digits and dashes (up to 64), starting with a letter or digit.") }
    guard let bytes = input.bytes ?? parseDataUrl(input.image)?.bytes else { throw BrushSourceError("image must be a data: URL (data:image/png;base64,…) or PNG bytes.") }
    let png: DecodedPng
    do { png = try decodePng(bytes, maxPixels: MAX_BRUSH_SOURCE_INPUT_PIXELS) } catch {
        throw BrushSourceError("The image can't be read as a PNG (\((error as? PngError)?.message ?? error.localizedDescription)); convert it to PNG, at most \(MAX_BRUSH_SOURCE_INPUT_PIXELS) pixels.")
    }
    let width = png.width, height = png.height, data = png.data
    let n = width * height
    var channel = input.channel ?? "auto"
    if channel == "auto" {
        var transparent = false
        for i in 0..<n where data[i * 4 + 3] < 250 { transparent = true; break }
        channel = transparent ? "alpha" : "darkness"
        problems.append("channel auto read the marks from \(channel == "alpha" ? "the transparency" : "the dark parts (dark marks on a light background)").")
    }
    var mask = [UInt8](repeating: 0, count: n)
    for i in 0..<n {
        let a = Double(data[i * 4 + 3])
        // Luminance of the colour over white, so transparent pixels read as paper.
        let lum = (0.2126 * Double(data[i * 4]) + 0.7152 * Double(data[i * 4 + 1]) + 0.0722 * Double(data[i * 4 + 2])) * (a / 255) + 255 * (1 - a / 255)
        let v = channel == "alpha" ? a : channel == "darkness" ? 255 - lum : lum
        mask[i] = UInt8(Swift.min(255, Swift.max(0, JS.round(input.invert ? 255 - v : v))))
    }
    let source = try brushSourceFromMask(id: id, name: name, licence: input.licence, origin: input.origin, width, height, mask)
    if source.width != width { problems.append("The image was scaled from \(width)×\(height) to \(source.width)×\(source.height) (sources are kept at most \(MAX_BRUSH_SOURCE_SIZE) px).") }
    return source
}

/**
 * A stored source read back (from a library file or a saved painting), or nil with the reason in
 * `problems`. The image is checked for its form, not decoded.
 */
public func readBrushSource(_ raw: JSONValue, _ at: String, _ problems: inout [String]) -> BrushSource? {
    guard let r = raw.objectValue else { problems.append("\(at) is not a brush source; skipped."); return nil }
    guard let id = r["id"]?.stringValue, isBrushId(id) else { problems.append("\(at) has no valid id; skipped."); return nil }
    func size(_ v: JSONValue?) -> Int? {
        guard let n = v?.numberValue, n == n.rounded(), n >= 1, n <= Double(MAX_BRUSH_SOURCE_SIZE) else { return nil }
        return Int(n)
    }
    guard let width = size(r["width"]), let height = size(r["height"]) else { problems.append("\(at) (\"\(id)\") has no valid width and height (1..\(MAX_BRUSH_SOURCE_SIZE)); skipped."); return nil }
    guard let image = r["image"]?.stringValue, image.range(of: "^data:image/png;base64,[A-Za-z0-9+/]+=*$", options: .regularExpression) != nil else {
        problems.append("\(at) (\"\(id)\") has no PNG data: URL image; skipped.")
        return nil
    }
    return BrushSource(id: id, name: text(r["name"]?.stringValue, 80) ?? id, width: width, height: height, image: image, licence: text(r["licence"]?.stringValue, 2000), origin: text(r["origin"]?.stringValue, 200))
}

/// A decoded source: one byte per pixel, 255 paints.
public struct DecodedBrushSource: Sendable {
    public var width: Int
    public var height: Int
    public var mask: [UInt8]
}

private let decodedSources = Locked(OrderedMap<String, DecodedBrushSource>())

/// The source's mask, decoded once per image. Throws when the image is not a valid PNG.
public func decodeBrushSource(_ image: String) throws -> DecodedBrushSource {
    if let hit = decodedSources.with({ $0.get(image) }) { return hit }
    guard let parsed = parseDataUrl(image) else { throw BrushSourceError("The source image is not a data: URL.") }
    let png = try decodePng(parsed.bytes, keepGray: true, maxPixels: MAX_BRUSH_SOURCE_SIZE * MAX_BRUSH_SOURCE_SIZE)
    var mask: [UInt8]
    if png.channels == 1 {
        mask = png.data
    } else {
        // A source written by another tool in RGBA: its red channel, as `brushSourceFromMask` writes grey.
        mask = [UInt8](repeating: 0, count: png.width * png.height)
        for i in 0..<mask.count { mask[i] = UInt8(JS.round(Double(png.data[i * 4]) * Double(png.data[i * 4 + 3]) / 255)) }
    }
    let out = DecodedBrushSource(width: png.width, height: png.height, mask: mask)
    decodedSources.with { cache in
        if cache.count > 256, let first = cache.first { _ = cache.delete(first.key) }
        cache.set(image, out)
    }
    return out
}

/**
 * Brush sources the paint engine draws with (`paint-editor/brush-source-art.ts`): the brush
 * library's and the open painting's, by id. A stamp tip `source:<id>` and an image tip grain both
 * read the source's mask; each mask is decoded the first time it is drawn.
 */
public final class BrushSourceArtCache {
    private var sources = OrderedMap<String, BrushSource>()
    private var art: [String: StampArt?] = [:]

    public init() {}

    /// Adds or replaces sources (a replaced image is decoded again).
    public func set(_ list: [BrushSource]) {
        for s in list {
            if let was = sources.get(s.id), was.image == s.image { continue }
            sources.set(s.id, s)
            art[s.id] = nil
        }
    }

    public func source(_ id: String) -> BrushSource? { sources.get(id) }

    public func all() -> [BrushSource] { sources.values }

    /// The art of a `source:<id>` ref, or nil when the source is unknown or its image can't be read.
    public func get(_ ref: String) -> StampArt? {
        guard let id = brushSourceIdOf(ref) else { return nil }
        if let hit = art[id] { return hit }
        guard let s = sources.get(id) else { return nil }
        let a = (try? decodeBrushSource(s.image)).map { StampArt(width: $0.width, height: $0.height, alpha: $0.mask) }
        art[id] = .some(a)
        return a
    }
}

/// The ids of the sources an engine brush draws with: its stamp tip, its tip grain and its particle stamps.
func engineBrushSourceIds(_ brush: PaintBrush) -> [String] {
    var refs: [String] = []
    if let s = brush.stamp { refs.append(s) }
    if let g = brush.tipGrain?.source { refs.append(g) }
    refs += (brush.particle["dotTextures"]?.arrayValue ?? []).compactMap(\.stringValue)
    var out: [String] = []
    for id in refs.compactMap(brushSourceIdOf) where !out.contains(id) { out.append(id) }
    return out
}
