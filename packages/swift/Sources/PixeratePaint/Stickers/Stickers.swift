import Foundation
import PixerateCore
import PixerateRaster

/**
 * Stickers (`stickers/editor.ts`, `stickers/helpers.ts`, `paint-editor/stickers.ts`): the
 * editor's own sticker library (nine procedural stamps with outlines and thumbnails), stickers as
 * editable objects on a sticker layer (drawn whole from their list, picked by shape), and the
 * sticker spray of sticker brushes. Pixels match the TS core.
 *
 * Host sticker libraries draw from art loaded through `StickerArtCache` (PNG decoded here, SVG
 * through a host rasteriser); `renderStickerStamp` renders one stamp as the canvas draws it.
 */

// MARK: - The editor's sticker library

private let BOX = 100.0
private let GRID = 128
private let SHAPE_SEED = 7
public let EDITOR_STICKERS_ID = "editor"
public let DEFAULT_STICKER_PAGE = 24
public let MAX_STICKER_PAGE = 100

private struct StampMeta { let name, category: String; let tags: [String]; let colour, description: String }
private let META: [String: StampMeta] = [
    "dot": StampMeta(name: "Dot", category: "shapes", tags: ["circle", "round", "spot"], colour: "#2563eb", description: "A round dot."),
    "star": StampMeta(name: "Star", category: "shapes", tags: ["five-pointed", "favourite", "rating"], colour: "#f59e0b", description: "A five-pointed star, one point up."),
    "heart": StampMeta(name: "Heart", category: "shapes", tags: ["love", "like"], colour: "#e11d48", description: "A heart."),
    "leaf": StampMeta(name: "Leaf", category: "nature", tags: ["plant", "green"], colour: "#16a34a", description: "A pointed leaf with a midrib."),
    "flower": StampMeta(name: "Flower", category: "nature", tags: ["petals", "blossom"], colour: "#db2777", description: "A five-petal flower."),
    "confetti": StampMeta(name: "Confetti", category: "party", tags: ["celebration", "rectangle"], colour: "#7c3aed", description: "A small strip of confetti."),
    "splat": StampMeta(name: "Splat", category: "party", tags: ["paint", "splash", "blob"], colour: "#0891b2", description: "A paint splat with drops."),
    "sparkle": StampMeta(name: "Sparkle", category: "party", tags: ["twinkle", "shine", "glint"], colour: "#eab308", description: "A four-pointed twinkle."),
    "ring": StampMeta(name: "Ring", category: "shapes", tags: ["circle", "outline", "hoop"], colour: "#0f766e", description: "A ring."),
]

/// What went wrong with a sticker (`StickerError`).
public struct StickerError: Error, LocalizedError, CustomStringConvertible {
    public let code: String
    public let message: String
    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
    public var errorDescription: String? { message }
    public var description: String { message }
}

// MARK: - Sticker provider contract (`stickers/types.ts`, `stickers/helpers.ts`, `stickers/combine.ts`, `stickers/fake.ts`)

public let STICKER_VARIANTS = ["light", "dark"]
public let STICKER_ART_SIZE = 256

/// How a sticker's art may be used (`StickerLicence`).
public struct StickerLicence: Equatable, Sendable {
    public var spdx: String?
    public var name: String
    public var attribution: String?
    public var url: String?
    public var commercial: Bool

    public init(spdx: String? = nil, name: String, attribution: String? = nil, url: String? = nil, commercial: Bool) {
        self.spdx = spdx
        self.name = name
        self.attribution = attribution
        self.url = url
        self.commercial = commercial
    }

    public var json: JSONObject {
        var o: JSONObject = ["name": .string(name), "commercial": .bool(commercial)]
        if let spdx { o["spdx"] = .string(spdx) }
        if let attribution { o["attribution"] = .string(attribution) }
        if let url { o["url"] = .string(url) }
        return o
    }
}

/// A themed set of stickers within one provider (`StickerCollection`).
public struct StickerCollection: Equatable, Sendable {
    public var id: String
    public var name: String
    public var description: String?
    public var count: Int

    public init(id: String, name: String, description: String? = nil, count: Int) {
        self.id = id
        self.name = name
        self.description = description
        self.count = count
    }

    public var json: JSONObject {
        var o: JSONObject = ["id": .string(id), "name": .string(name), "count": .number(Double(count))]
        if let description { o["description"] = .string(description) }
        return o
    }
}

/// A sticker in a list or search result (`StickerSummary`).
public struct StickerSummary: Equatable, Sendable {
    public var id: String
    public var name: String
    public var category: String
    public var tags: [String]?
    public var description: String?
    public var width: Double
    public var height: Double
    public var thumbnail: String?
    public var formats: [String]
    public var licence: StickerLicence
    public var tintable: Bool
    public var aiGenerated: Bool?
    public var variants: [String]?
    public var collection: String?
    public var animated: Bool?
    public var frameCount: Int?
    public var frameDelay: Double?

    public init(
        id: String, name: String, category: String, tags: [String]? = nil, description: String? = nil,
        width: Double, height: Double, thumbnail: String? = nil, formats: [String], licence: StickerLicence,
        tintable: Bool, aiGenerated: Bool? = nil, variants: [String]? = nil, collection: String? = nil,
        animated: Bool? = nil, frameCount: Int? = nil, frameDelay: Double? = nil
    ) {
        self.id = id
        self.name = name
        self.category = category
        self.tags = tags
        self.description = description
        self.width = width
        self.height = height
        self.thumbnail = thumbnail
        self.formats = formats
        self.licence = licence
        self.tintable = tintable
        self.aiGenerated = aiGenerated
        self.variants = variants
        self.collection = collection
        self.animated = animated
        self.frameCount = frameCount
        self.frameDelay = frameDelay
    }

    public var json: JSONObject {
        var o: JSONObject = [
            "id": .string(id), "name": .string(name), "category": .string(category),
            "width": .number(width), "height": .number(height),
            "formats": .array(formats.map { .string($0) }),
            "licence": .object(licence.json), "tintable": .bool(tintable),
        ]
        if let tags { o["tags"] = .array(tags.map { .string($0) }) }
        if let description { o["description"] = .string(description) }
        if let thumbnail { o["thumbnail"] = .string(thumbnail) }
        if let aiGenerated { o["aiGenerated"] = .bool(aiGenerated) }
        if let variants { o["variants"] = .array(variants.map { .string($0) }) }
        if let collection { o["collection"] = .string(collection) }
        if let animated { o["animated"] = .bool(animated) }
        if let frameCount { o["frameCount"] = .number(Double(frameCount)) }
        if let frameDelay { o["frameDelay"] = .number(frameDelay) }
        return o
    }
}

/// Everything about one sticker (`StickerDescription`).
public struct StickerDescription: Equatable, Sendable {
    public var summary: StickerSummary
    public var silhouette: String?
    public var colours: [String]?

    public init(summary: StickerSummary, silhouette: String? = nil, colours: [String]? = nil) {
        self.summary = summary
        self.silhouette = silhouette
        self.colours = colours
    }

    public var id: String { get { summary.id } set { summary.id = newValue } }
    public var name: String { summary.name }
    public var category: String { summary.category }
    public var tags: [String]? { summary.tags }
    public var description: String? { summary.description }
    public var width: Double { summary.width }
    public var height: Double { summary.height }
    public var thumbnail: String? { summary.thumbnail }
    public var formats: [String] { summary.formats }
    public var licence: StickerLicence { summary.licence }
    public var tintable: Bool { summary.tintable }
    public var aiGenerated: Bool? { summary.aiGenerated }
    public var variants: [String]? { summary.variants }
    public var collection: String? { get { summary.collection } set { summary.collection = newValue } }
    public var animated: Bool? { summary.animated }
    public var frameCount: Int? { summary.frameCount }
    public var frameDelay: Double? { summary.frameDelay }

    public var json: JSONObject {
        var o = summary.json
        if let silhouette { o["silhouette"] = .string(silhouette) }
        if let colours { o["colours"] = .array(colours.map { .string($0) }) }
        return o
    }
}

/// A sticker's art (`StickerAsset`). Native Swift providers may also return decoded `.rgba` bytes directly.
public enum StickerAsset: Equatable, Sendable {
    case svg(svg: String, silhouette: String? = nil)
    case image(url: String, width: Int, height: Int)
    case rgba(width: Int, height: Int, data: [UInt8])
}

/// One page of results (`StickerPage`).
public struct StickerPage: Equatable, Sendable {
    public var items: [StickerSummary]
    public var total: Int
    public var next: String?

    public init(items: [StickerSummary], total: Int, next: String? = nil) {
        self.items = items
        self.total = total
        self.next = next
    }
}

public struct StickerSearchOptions: Equatable, Sendable {
    public var category: String?
    public var collection: String?
    public var tags: [String]?
    public var limit: Int?
    public var after: String?
    public var commercial: Bool?

    public init(category: String? = nil, collection: String? = nil, tags: [String]? = nil, limit: Int? = nil, after: String? = nil, commercial: Bool? = nil) {
        self.category = category
        self.collection = collection
        self.tags = tags
        self.limit = limit
        self.after = after
        self.commercial = commercial
    }
}

public struct StickerLoadOptions: Equatable, Sendable {
    public var format: String?
    public var size: Int?
    public var colour: String?
    public var variant: String?
    public var frame: Int?

    public init(format: String? = nil, size: Int? = nil, colour: String? = nil, variant: String? = nil, frame: Int? = nil) {
        self.format = format
        self.size = size
        self.colour = colour
        self.variant = variant
        self.frame = frame
    }
}

public struct StickerProviderCapabilities: Equatable, Sendable {
    public var supportsSearch: Bool
    public var supportsSvg: Bool
    public var supportsRaster: Bool
    public var maxSize: Int?

    public init(supportsSearch: Bool, supportsSvg: Bool, supportsRaster: Bool, maxSize: Int? = nil) {
        self.supportsSearch = supportsSearch
        self.supportsSvg = supportsSvg
        self.supportsRaster = supportsRaster
        self.maxSize = maxSize
    }
}

/// The sticker provider contract (`StickerProvider` in `stickers/types.ts`).
public protocol StickerProvider: Sendable {
    var id: String { get }
    var name: String { get }
    var version: String? { get }
    var capabilities: StickerProviderCapabilities { get }
    var namespaced: Bool { get }
    func list(_ options: StickerSearchOptions) throws -> StickerPage
    func search(_ query: String, _ options: StickerSearchOptions) throws -> StickerPage
    func describe(_ id: String) throws -> StickerDescription?
    func load(_ id: String, _ options: StickerLoadOptions) throws -> StickerAsset
    func categories() throws -> [(id: String, name: String, count: Int)]?
    func collections() throws -> [StickerCollection]?
}

public extension StickerProvider {
    var version: String? { nil }
    var namespaced: Bool { false }
    func categories() throws -> [(id: String, name: String, count: Int)]? { nil }
    func collections() throws -> [StickerCollection]? { nil }
}

/// Checks search options, throwing a `StickerError` that names the bad one (`checkStickerSearchOptions`).
public func checkStickerSearchOptions(_ options: StickerSearchOptions = StickerSearchOptions()) throws {
    if let limit = options.limit, !(limit >= 1 && limit <= MAX_STICKER_PAGE) {
        throw StickerError("invalid_argument", "limit must be a whole number from 1 to \(MAX_STICKER_PAGE), got \(limit).")
    }
    if let after = options.after, after.range(of: "^\\d+$", options: .regularExpression) == nil {
        throw StickerError("invalid_argument", "after \"\(after)\" is not a cursor from this provider; pass the next value of the previous page.")
    }
}

private func stickerWords(_ s: String) -> [String] {
    s.lowercased().components(separatedBy: CharacterSet.letters.union(.decimalDigits).inverted).filter { !$0.isEmpty }
}

/// One page of `items` filtered by `options` and `query` (`stickerPage`).
public func stickerPage(_ items: [StickerSummary], _ options: StickerSearchOptions = StickerSearchOptions(), query: String = "") throws -> StickerPage {
    try checkStickerSearchOptions(options)
    let q = stickerWords(query)
    let tags = (options.tags ?? []).map { $0.lowercased() }
    let matches = items.filter { s in
        if let cat = options.category, s.category != cat { return false }
        if let col = options.collection, s.collection != col { return false }
        if !tags.isEmpty && !tags.allSatisfy({ t in (s.tags ?? []).contains { $0.lowercased() == t } }) { return false }
        if options.commercial == true && !s.licence.commercial { return false }
        if q.isEmpty { return true }
        let text = Set(stickerWords(([s.name, s.category, s.description ?? ""] + (s.tags ?? [])).joined(separator: " ")))
        return q.allSatisfy { w in text.contains { $0.hasPrefix(w) } }
    }
    let start = options.after.flatMap { Int($0) } ?? 0
    let limit = options.limit ?? DEFAULT_STICKER_PAGE
    let page = Array(matches.dropFirst(start).prefix(limit))
    return StickerPage(items: page, total: matches.count, next: start + limit < matches.count ? String(start + limit) : nil)
}

/// The variants a sticker has (`light` always, first; `stickerVariantsOf`).
public func stickerVariantsOf(_ variants: [String]?) -> [String] {
    STICKER_VARIANTS.filter { $0 == "light" || (variants?.contains($0) == true) }
}

/// Checks `load`'s variant against the sticker's (`checkStickerVariant`).
public func checkStickerVariant(_ s: StickerSummary, _ variant: String?) throws -> String {
    let v = variant ?? "light"
    let has = stickerVariantsOf(s.variants)
    if !has.contains(v) {
        throw StickerError("unsupported_variant", "Sticker \"\(s.id)\" has no \"\(v)\" variant; it has \(has.joined(separator: ", ")).")
    }
    return v
}

/// Checks `load`'s frame against the sticker's `frameCount` (`checkStickerFrame`).
public func checkStickerFrame(_ s: StickerSummary, _ frame: Int?) throws -> Int {
    let f = frame ?? 0
    let count = (s.animated == true) ? Swift.max(1, s.frameCount ?? 1) : 1
    if f < 0 || f >= count {
        throw StickerError("invalid_argument", "Sticker \"\(s.id)\" has \(count) frame(s) (0..\(count - 1)), got frame \(f).")
    }
    return f
}

/// The variant to show on a dark or light background (`stickerVariantFor`).
public func stickerVariantFor(_ variants: [String]?, dark: Bool) -> String {
    dark && (variants?.contains("dark") == true) ? "dark" : "light"
}

/// The collections of an in-memory catalogue with their counts (`stickerCollections`).
public func stickerCollections(_ items: [StickerSummary], _ names: [String: (name: String, description: String?)] = [:]) -> [StickerCollection] {
    var order: [String] = []
    var counts: [String: Int] = [:]
    for s in items {
        guard let c = s.collection else { continue }
        if counts[c] == nil { order.append(c) }
        counts[c, default: 0] += 1
    }
    return order.map { id in
        let meta = names[id]
        return StickerCollection(id: id, name: meta?.name ?? id, description: meta?.description, count: counts[id] ?? 0)
    }
}

/// The ref of a sticker `id` listed by `provider` (`stickerRefOf`).
public func stickerRefOf(_ provider: any StickerProvider, _ id: String) -> String {
    provider.namespaced ? id : "\(provider.id):\(id)"
}

/// The id to pass to `provider` for `ref`, or nil when the ref names another provider (`stickerIdFor`).
public func stickerIdFor(_ provider: any StickerProvider, _ ref: String) throws -> String? {
    let p = try parseStickerRefStrict(ref)
    if provider.namespaced { return "\(p.provider):\(p.id)" }
    return p.provider == provider.id ? p.id : nil
}

/// Holds an editor's sticker provider (`StickersSlot`).
public final class StickersSlot: @unchecked Sendable {
    public let fallback: any StickerProvider
    private var current: (any StickerProvider)?
    private var listeners: [UUID: (any StickerProvider) -> Void] = [:]

    public init(_ initial: (any StickerProvider)? = nil, fallback: any StickerProvider = EditorStickers()) {
        self.fallback = fallback
        self.current = initial
    }

    public var provider: any StickerProvider { current ?? fallback }

    public func set(_ next: (any StickerProvider)?) {
        current = next
        let p = provider
        for fn in listeners.values { fn(p) }
    }

    @discardableResult
    public func subscribe(_ fn: @escaping (any StickerProvider) -> Void) -> () -> Void {
        let id = UUID()
        listeners[id] = fn
        return { [weak self] in self?.listeners.removeValue(forKey: id) }
    }
}

/// A stamp's outline as SVG path data in its 100 × 100 box (marching squares, then simplified; `stampOutline`).
public func stampOutline(_ kind: String) -> String {
    let n = GRID
    var f = [Float](repeating: 0, count: (n + 1) * (n + 1))
    for j in 0...n { for i in 0...n { f[j * (n + 1) + i] = Float(stampCoverage(kind, (Double(i) / Double(n)) * 2 - 1, (Double(j) / Double(n)) * 2 - 1, SHAPE_SEED) - 0.5) } }
    func at(_ i: Int, _ j: Int) -> Double { Double(f[j * (n + 1) + i]) }
    var points: [String: (Double, Double)] = [:]
    func point(_ key: String, _ i0: Int, _ j0: Int, _ i1: Int, _ j1: Int) -> String {
        if points[key] == nil {
            let a = at(i0, j0), b = at(i1, j1)
            let t = a / (a - b)
            points[key] = (((Double(i0) + Double(i1 - i0) * t) / Double(n)) * BOX, ((Double(j0) + Double(j1 - j0) * t) / Double(n)) * BOX)
        }
        return key
    }
    var next = OrderedMap<String, String>()
    for j in 0..<n {
        for i in 0..<n {
            let tl = at(i, j) > 0 ? 1 : 0, tr = at(i + 1, j) > 0 ? 1 : 0, br = at(i + 1, j + 1) > 0 ? 1 : 0, bl = at(i, j + 1) > 0 ? 1 : 0
            let code = (tl << 3) | (tr << 2) | (br << 1) | bl
            if code == 0 || code == 15 { continue }
            func top() -> String { point("h\(i),\(j)", i, j, i + 1, j) }
            func right() -> String { point("v\(i + 1),\(j)", i + 1, j, i + 1, j + 1) }
            func bottom() -> String { point("h\(i),\(j + 1)", i, j + 1, i + 1, j + 1) }
            func left() -> String { point("v\(i),\(j)", i, j, i, j + 1) }
            func seg(_ a: String, _ b: String) { next.set(a, b) }
            let centre = at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1) > 0
            switch code {
            case 1: seg(left(), bottom())
            case 2: seg(bottom(), right())
            case 3: seg(left(), right())
            case 4: seg(right(), top())
            case 5: if centre { seg(left(), top()); seg(right(), bottom()) } else { seg(left(), bottom()); seg(right(), top()) }
            case 6: seg(bottom(), top())
            case 7: seg(left(), top())
            case 8: seg(top(), left())
            case 9: seg(top(), bottom())
            case 10: if centre { seg(top(), right()); seg(bottom(), left()) } else { seg(top(), left()); seg(bottom(), right()) }
            case 11: seg(top(), right())
            case 12: seg(right(), left())
            case 13: seg(right(), bottom())
            case 14: seg(bottom(), left())
            default: break
            }
        }
    }
    var loops: [[(Double, Double)]] = []
    var seen = Set<String>()
    for start in next.keys {
        if seen.contains(start) { continue }
        var loop: [(Double, Double)] = []
        var k: String? = start
        while let key = k, !seen.contains(key) {
            seen.insert(key)
            loop.append(points[key]!)
            k = next.get(key)
        }
        if loop.count >= 3 { loops.append(simplifyLoop(loop, 0.12)) }
    }
    func fmt(_ v: Double) -> String { jsText(JS.round(v * 100) / 100) }
    return loops.map { l in "M" + l.map { "\(fmt($0.0)) \(fmt($0.1))" }.joined(separator: "L") + "Z" }.joined()
}

/// Ramer–Douglas–Peucker on a closed loop (`simplify`).
private func simplifyLoop(_ loop: [(Double, Double)], _ eps: Double) -> [(Double, Double)] {
    if loop.count < 8 { return loop }
    var keep = [Bool](repeating: false, count: loop.count)
    func rdp(_ a: Int, _ b: Int) {
        let (ax, ay) = loop[a], (bx, by) = loop[b]
        let h = JS.hypot(bx - ax, by - ay)
        let len = h != 0 ? h : 1e-9
        var worst = -1
        var far = 0.0
        if a + 1 < b {
            for i in (a + 1)..<b {
                let d = abs((bx - ax) * (ay - loop[i].1) - (ax - loop[i].0) * (by - ay)) / len
                if d > far {
                    far = d
                    worst = i
                }
            }
        }
        if worst != -1 && far > eps {
            keep[worst] = true
            rdp(a, worst)
            rdp(worst, b)
        }
    }
    let mid = loop.count / 2
    keep[0] = true
    keep[mid] = true
    rdp(0, mid)
    rdp(mid, loop.count - 1)
    keep[loop.count - 1] = true
    return loop.enumerated().filter { keep[$0.offset] }.map(\.element)
}

/// A stamp as `size × size` RGBA in `colour` (`stampPixels`).
public func stampPixels(_ kind: String, _ size: Int, _ colour: String) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: size * size * 4)
    let n = Int(colour.dropFirst(), radix: 16) ?? 0
    let ss = size <= 128 ? 3 : 2
    for y in 0..<size {
        for x in 0..<size {
            var c = 0.0
            for sy in 0..<ss { for sx in 0..<ss { c += stampCoverage(kind, ((Double(x) + (Double(sx) + 0.5) / Double(ss)) / Double(size)) * 2 - 1, ((Double(y) + (Double(sy) + 0.5) / Double(ss)) / Double(size)) * 2 - 1, SHAPE_SEED) } }
            let a = JS.round((c / Double(ss * ss)) * 255)
            if a == 0 { continue }
            let i = (y * size + x) * 4
            out[i] = UInt8((n >> 16) & 255)
            out[i + 1] = UInt8((n >> 8) & 255)
            out[i + 2] = UInt8(n & 255)
            out[i + 3] = JS.u8c(a)
        }
    }
    return out
}

/**
 * The editor's own sticker library (`editorStickers`): the nine stamps, with their outline
 * (`silhouette`), dominant colour and a 48 px thumbnail.
 */
public final class EditorStickers: StickerProvider, @unchecked Sendable {
    public let id = EDITOR_STICKERS_ID
    public let name = "Editor stickers"
    public let version: String? = "1"
    public let capabilities = StickerProviderCapabilities(supportsSearch: true, supportsSvg: true, supportsRaster: true, maxSize: 1024)
    private var outlines: [String: String] = [:]
    private var thumbs: [String: String] = [:]
    public init() {}

    private func outline(_ k: String) -> String {
        if let o = outlines[k] { return o }
        let o = stampOutline(k)
        outlines[k] = o
        return o
    }

    public func stickerSummary(_ k: String) -> StickerSummary {
        let m = META[k]!
        if thumbs[k] == nil { thumbs[k] = pngDataUrl(48, 48, stampPixels(k, 48, m.colour)) }
        return StickerSummary(
            id: k, name: m.name, category: m.category, tags: m.tags, description: m.description,
            width: BOX, height: BOX, thumbnail: thumbs[k]!, formats: ["svg", "png"],
            licence: StickerLicence(spdx: "MIT", name: "MIT", commercial: true), tintable: true
        )
    }

    /// A sticker's summary as JSON (`summary`).
    public func summary(_ k: String) -> JSONObject { stickerSummary(k).json }

    public func list(_ options: StickerSearchOptions = StickerSearchOptions()) throws -> StickerPage {
        try stickerPage(STAMP_KINDS.map(stickerSummary), options)
    }

    public func search(_ query: String, _ options: StickerSearchOptions = StickerSearchOptions()) throws -> StickerPage {
        try stickerPage(STAMP_KINDS.map(stickerSummary), options, query: query)
    }

    public func describe(_ id: String) throws -> StickerDescription? {
        guard STAMP_KINDS.contains(id) else { return nil }
        return StickerDescription(summary: stickerSummary(id), silhouette: outline(id), colours: [META[id]!.colour])
    }

    public func categories() throws -> [(id: String, name: String, count: Int)]? {
        var cats: [String] = []
        for k in STAMP_KINDS where !cats.contains(META[k]!.category) { cats.append(META[k]!.category) }
        return cats.map { c in (id: c, name: String(c.prefix(1)).uppercased() + c.dropFirst(), count: STAMP_KINDS.filter { META[$0]!.category == c }.count) }
    }

    public func load(_ id: String, _ options: StickerLoadOptions = StickerLoadOptions()) throws -> StickerAsset {
        guard STAMP_KINDS.contains(id) else {
            throw StickerError("unknown_sticker", "The editor has no sticker \"\(id)\"; its stickers are \(STAMP_KINDS.joined(separator: ", ")).")
        }
        let s = stickerSummary(id)
        _ = try checkStickerVariant(s, options.variant)
        _ = try checkStickerFrame(s, options.frame)
        let colour = options.colour ?? META[id]!.colour
        if colour.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) == nil {
            throw StickerError("invalid_argument", "colour \"\(colour)\" must be #rrggbb.")
        }
        if options.format == "png" {
            let size = options.size ?? 256
            if !(size >= 8 && size <= 1024) {
                throw StickerError("invalid_argument", "size must be a whole number of px from 8 to 1024, got \(size).")
            }
            return .image(url: pngDataUrl(size, size, stampPixels(id, size, colour.lowercased())), width: size, height: size)
        }
        if let f = options.format, f != "svg" {
            throw StickerError("unsupported_format", "format must be svg or png, got \"\(f)\".")
        }
        let d = outline(id)
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 \(Int(BOX)) \(Int(BOX))\" width=\"\(Int(BOX))\" height=\"\(Int(BOX))\"><path fill=\"\(colour.lowercased())\" fill-rule=\"evenodd\" d=\"\(d)\"/></svg>"
        return .svg(svg: svg, silhouette: d)
    }
}

public func editorStickers() -> EditorStickers { EditorStickers() }

// MARK: - Combining providers (`stickers/combine.ts`)

/// Combines multiple `StickerProvider` instances into one namespaced provider (`combineStickerProviders`).
public func combineStickerProviders(_ providers: [any StickerProvider], id: String = "stickers", name: String? = nil) throws -> any StickerProvider {
    let ids = providers.map(\.id)
    if let dup = ids.enumerated().first(where: { i, x in ids[..<i].contains(x) })?.element {
        throw StickerError("invalid_argument", "Two sticker providers have the id \"\(dup)\"; give each a unique id.")
    }
    return CombinedStickerProvider(providers: providers, id: id, name: name ?? providers.map(\.name).joined(separator: " + "))
}

private final class CombinedStickerProvider: StickerProvider, @unchecked Sendable {
    let providers: [any StickerProvider]
    let id: String
    let name: String
    let namespaced = true
    let capabilities: StickerProviderCapabilities
    private let byId: [String: any StickerProvider]

    init(providers: [any StickerProvider], id: String, name: String) {
        self.providers = providers
        self.id = id
        self.name = name
        var map: [String: any StickerProvider] = [:]
        for p in providers { map[p.id] = p }
        self.byId = map
        let maxSize: Int? = providers.allSatisfy({ $0.capabilities.maxSize != nil }) ? providers.compactMap(\.capabilities.maxSize).max() : nil
        self.capabilities = StickerProviderCapabilities(
            supportsSearch: providers.contains { $0.capabilities.supportsSearch },
            supportsSvg: providers.contains { $0.capabilities.supportsSvg },
            supportsRaster: providers.contains { $0.capabilities.supportsRaster },
            maxSize: maxSize
        )
    }

    private func owner(_ ref: String) throws -> (p: any StickerProvider, id: String) {
        let parsed = try parseStickerRefStrict(ref)
        guard let p = byId[parsed.provider] else {
            let names = providers.map(\.id).joined(separator: ", ")
            throw StickerError("unknown_provider", "No sticker provider \"\(parsed.provider)\"; the providers are \(names.isEmpty ? "none" : names).")
        }
        return (p, parsed.id)
    }

    private func collectionOf(_ p: any StickerProvider, _ c: String) -> String {
        p.namespaced ? c : "\(p.id):\(c)"
    }

    private func prefix(_ p: any StickerProvider, _ s: StickerSummary) -> StickerSummary {
        var out = s
        out.id = stickerRefOf(p, s.id)
        if let c = s.collection { out.collection = collectionOf(p, c) }
        return out
    }

    private func collectionOwner(_ c: String) throws -> (p: any StickerProvider, collection: String) {
        guard let i = c.firstIndex(of: ":"), i > c.startIndex, let p = byId[String(c[..<i])] else {
            throw StickerError("invalid_argument", "No collection \"\(c)\"; collections here are \"provider:collection\" (collections() lists them).")
        }
        return (p, p.namespaced ? c : String(c[c.index(after: i)...]))
    }

    private func runPage(_ query: String?, _ o: StickerSearchOptions) throws -> StickerPage {
        let limit = o.limit ?? DEFAULT_STICKER_PAGE
        try checkStickerSearchOptions(StickerSearchOptions(limit: limit))
        let only = try o.collection.map(collectionOwner)
        var i = 0
        var inner: String?
        if let after = o.after {
            guard let pipe = after.firstIndex(of: "|"), let idx = Int(after[..<pipe]), idx >= 0, idx < providers.count else {
                throw StickerError("invalid_argument", "after \"\(after)\" is not a cursor from this provider; pass the next value of the previous page.")
            }
            i = idx
            let rest = String(after[after.index(after: pipe)...])
            inner = rest.isEmpty ? nil : rest
        }
        func get(_ p: any StickerProvider, _ opts: StickerSearchOptions) throws -> StickerPage {
            if let only, only.p.id != p.id { return StickerPage(items: [], total: 0) }
            var sub = opts
            sub.collection = only?.collection
            return try query == nil ? p.list(sub) : p.search(query!, sub)
        }
        var baseOpts = o
        baseOpts.after = nil
        baseOpts.collection = nil
        var total = 0
        for p in providers {
            var one = baseOpts
            one.limit = 1
            total += try get(p, one).total
        }
        var items: [StickerSummary] = []
        var next: String?
        while i < providers.count && items.count < limit {
            let p = providers[i]
            var sub = baseOpts
            sub.limit = limit - items.count
            sub.after = inner
            let res = try get(p, sub)
            items.append(contentsOf: res.items.map { prefix(p, $0) })
            if let rNext = res.next, !res.items.isEmpty {
                inner = rNext
                if items.count >= limit { next = "\(i)|\(rNext)" }
                continue
            }
            i += 1
            inner = nil
        }
        if next == nil && items.count >= limit && i < providers.count { next = "\(i)|" }
        return StickerPage(items: items, total: total, next: next)
    }

    func list(_ options: StickerSearchOptions) throws -> StickerPage { try runPage(nil, options) }
    func search(_ query: String, _ options: StickerSearchOptions) throws -> StickerPage { try runPage(query, options) }

    func describe(_ ref: String) throws -> StickerDescription? {
        guard let o = try? owner(ref), var d = try o.p.describe(o.id) else { return nil }
        d.summary = prefix(o.p, d.summary)
        return d
    }

    func load(_ ref: String, _ options: StickerLoadOptions) throws -> StickerAsset {
        let o = try owner(ref)
        return try o.p.load(o.id, options)
    }

    func categories() throws -> [(id: String, name: String, count: Int)]? {
        var order: [String] = []
        var names: [String: String] = [:]
        var counts: [String: Int] = [:]
        for p in providers {
            for c in (try p.categories()) ?? [] {
                if counts[c.id] == nil {
                    order.append(c.id)
                    names[c.id] = c.name
                }
                counts[c.id, default: 0] += c.count
            }
        }
        return order.map { (id: $0, name: names[$0] ?? $0, count: counts[$0] ?? 0) }
    }

    func collections() throws -> [StickerCollection]? {
        var out: [StickerCollection] = []
        for p in providers {
            for var c in (try p.collections()) ?? [] {
                c.id = collectionOf(p, c.id)
                out.append(c)
            }
        }
        return out
    }
}

// MARK: - Fake sticker provider (`stickers/fake.ts`)

public struct FakeStickerProviderOptions: Sendable {
    public var id: String = "fake"
    public var failIds: [String] = []
    public init(id: String = "fake", failIds: [String] = []) {
        self.id = id
        self.failIds = failIds
    }
}

public func createFakeStickerProvider(_ options: FakeStickerProviderOptions = FakeStickerProviderOptions()) -> any StickerProvider {
    FakeStickerProvider(options)
}

private final class FakeStickerProvider: StickerProvider, @unchecked Sendable {
    struct Item {
        let id, name, category: String
        let tags: [String]
        let shape: String
        let colours: (String, String)
        let commercial: Bool
        let collection: String?
        let aiGenerated: Bool
        let animated: Bool
        let frameCount: Int?
        let frameDelay: Double?
    }

    static let catalogue: [Item] = {
        var out: [Item] = []
        let weathers = [("sun", "#f59e0b"), ("moon", "#64748b"), ("cloud", "#94a3b8"), ("rain", "#2563eb"), ("snow", "#e0f2fe"), ("wind", "#14b8a6")]
        for (w, col) in weathers {
            out.append(Item(
                id: "weather-\(w)", name: String(w.prefix(1)).uppercased() + w.dropFirst(), category: "weather", tags: ["weather", w],
                shape: "badge", colours: (col, "#ffffff"), commercial: true, collection: "outdoors", aiGenerated: true,
                animated: w == "wind", frameCount: w == "wind" ? 4 : nil, frameDelay: w == "wind" ? 100 : nil
            ))
        }
        let fruits = [("apple", "#dc2626"), ("pear", "#84cc16"), ("cherry", "#be123c"), ("lemon", "#facc15"), ("grape", "#7c3aed")]
        for (f, col) in fruits {
            out.append(Item(
                id: "fruit-\(f)", name: String(f.prefix(1)).uppercased() + f.dropFirst(), category: "food", tags: ["fruit", f],
                shape: "tile", colours: (col, "#166534"), commercial: true, collection: "kitchen", aiGenerated: false,
                animated: false, frameCount: nil, frameDelay: nil
            ))
        }
        let badges = [("new", "#16a34a"), ("sale", "#dc2626"), ("hot", "#ea580c"), ("free", "#0891b2")]
        for (b, col) in badges {
            out.append(Item(
                id: "badge-\(b)", name: "\(String(b.prefix(1)).uppercased() + b.dropFirst()) badge", category: "badges", tags: ["badge", "label", b],
                shape: "badge", colours: (col, "#ffffff"), commercial: true, collection: "shop", aiGenerated: false,
                animated: false, frameCount: nil, frameDelay: nil
            ))
        }
        out.append(Item(
            id: "art-sketch", name: "Sketch", category: "art", tags: ["drawing", "non-commercial"],
            shape: "tile", colours: ("#1f2937", "#fde68a"), commercial: false, collection: nil, aiGenerated: false,
            animated: false, frameCount: nil, frameDelay: nil
        ))
        return out
    }()

    static let collectionMeta: [String: (name: String, description: String?)] = [
        "outdoors": ("Outdoors", "Weather, AI-generated."),
        "kitchen": ("Kitchen", "Fruit tiles with dark variants."),
        "shop": ("Shop", "Tintable sale badges."),
    ]
    static let notchFrames: [(Double, Double)] = [(45, 45), (55, 35), (35, 55), (25, 45)]

    let options: FakeStickerProviderOptions
    let id: String
    let name = "Fake stickers"
    let version: String? = "1"
    let capabilities = StickerProviderCapabilities(supportsSearch: true, supportsSvg: true, supportsRaster: true, maxSize: 512)
    private let summaries: [StickerSummary]

    init(_ options: FakeStickerProviderOptions) {
        self.options = options
        self.id = options.id
        self.summaries = Self.catalogue.map(Self.summaryOf)
    }

    private static func summaryOf(_ s: Item) -> StickerSummary {
        StickerSummary(
            id: s.id, name: s.name, category: s.category, tags: s.tags,
            description: s.shape == "badge" ? "A flat badge (tintable)." : "A two-colour tile.",
            width: 120, height: 120, formats: ["svg", "png"],
            licence: s.commercial ? StickerLicence(spdx: "CC0-1.0", name: "CC0 1.0", commercial: true) : StickerLicence(spdx: "CC-BY-NC-4.0", name: "CC BY-NC 4.0", attribution: "Fake Artist", commercial: false),
            tintable: s.shape == "badge",
            aiGenerated: s.aiGenerated ? true : nil,
            variants: s.shape == "tile" ? ["light", "dark"] : nil,
            collection: s.collection,
            animated: s.animated ? true : nil,
            frameCount: s.frameCount,
            frameDelay: s.frameDelay
        )
    }

    func list(_ o: StickerSearchOptions) throws -> StickerPage { try stickerPage(summaries, o) }
    func search(_ q: String, _ o: StickerSearchOptions) throws -> StickerPage { try stickerPage(summaries, o, query: q) }

    func describe(_ id: String) throws -> StickerDescription? {
        guard let s = Self.catalogue.first(where: { $0.id == id }) else { return nil }
        return StickerDescription(
            summary: Self.summaryOf(s),
            silhouette: s.shape == "badge" ? "M60 6A54 54 0 1 1 59.9 6Z" : "M10 10H110V110H10Z",
            colours: s.shape == "badge" ? [s.colours.0] : [s.colours.0, s.colours.1]
        )
    }

    func collections() throws -> [StickerCollection]? {
        stickerCollections(summaries, Self.collectionMeta)
    }

    func categories() throws -> [(id: String, name: String, count: Int)]? {
        var cats: [String] = []
        for s in Self.catalogue where !cats.contains(s.category) { cats.append(s.category) }
        return cats.map { c in (id: c, name: c, count: Self.catalogue.filter { $0.category == c }.count) }
    }

    func load(_ id: String, _ o: StickerLoadOptions) throws -> StickerAsset {
        guard let s = Self.catalogue.first(where: { $0.id == id }) else {
            throw StickerError("unknown_sticker", "No fake sticker \"\(id)\".")
        }
        if options.failIds.contains(id) {
            throw StickerError("load_failed", "The fake sticker \"\(id)\" failed to load (failIds).")
        }
        let summary = Self.summaryOf(s)
        let variant = try checkStickerVariant(summary, o.variant)
        let frame = try checkStickerFrame(summary, o.frame)
        let fill = s.shape == "badge" && o.colour != nil ? o.colour!.lowercased() : s.colours.0
        let bottom = s.colours.0
        let top = variant == "dark" ? "#f8fafc" : s.colours.1
        let (nx, ny) = Self.notchFrames[frame % Self.notchFrames.count]
        if o.format == "png" {
            let size = o.size ?? 128
            if !(size >= 8 && size <= 512) {
                throw StickerError("invalid_argument", "size must be 8..512 px, got \(size).")
            }
            var out = [UInt8](repeating: 0, count: size * size * 4)
            func hexBytes(_ c: String) -> [UInt8] { hexToRgb8(c).map(UInt8.init) }
            let fillRgb = hexBytes(fill), topRgb = hexBytes(top), botRgb = hexBytes(bottom)
            for y in 0..<size {
                for x in 0..<size {
                    let u = ((Double(x) + 0.5) / Double(size)) * 120
                    let v = ((Double(y) + 0.5) / Double(size)) * 120
                    var rgb: [UInt8]?
                    if s.shape == "badge" {
                        let inDisc = JS.hypot(u - 60, v - 60) <= 54
                        let inNotch = u >= nx && u <= nx + 30 && v >= ny && v <= ny + 30
                        if inDisc && !inNotch { rgb = fillRgb }
                    } else if u >= 10 && u <= 110 && v >= 10 && v <= 110 {
                        rgb = v < 60 ? topRgb : botRgb
                    }
                    guard let rgb else { continue }
                    let i = (y * size + x) * 4
                    out[i] = rgb[0]; out[i + 1] = rgb[1]; out[i + 2] = rgb[2]; out[i + 3] = 255
                }
            }
            return .image(url: pngDataUrl(size, size, out), width: size, height: size)
        }
        if s.shape == "badge" {
            return .svg(svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 120\" width=\"120\" height=\"120\"><path fill=\"\(fill)\" fill-rule=\"evenodd\" d=\"M60 6A54 54 0 1 1 59.9 6ZM\(Int(nx)) \(Int(ny))H\(Int(nx + 30))V\(Int(ny + 30))H\(Int(nx))Z\"/></svg>")
        }
        return .svg(svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 120\" width=\"120\" height=\"120\"><rect x=\"10\" y=\"10\" width=\"100\" height=\"100\" fill=\"\(bottom)\"/><rect x=\"10\" y=\"10\" width=\"100\" height=\"50\" fill=\"\(top)\"/></svg>")
    }
}

// MARK: - Sticker art cache (`paint-editor/sticker-art.ts`)

/// Rasterised sticker art (straight RGBA) and whether to recolour it (`StickerArt`).
public final class StickerArt: @unchecked Sendable {
    public let width: Int
    public let height: Int
    public let data: [UInt8]
    public let tintable: Bool
    public let frames: [[UInt8]]?
    public let frameDelay: Double?
    public lazy var stampArt: StampArt = {
        var alpha = [UInt8](repeating: 0, count: width * height)
        for i in 0..<(width * height) { alpha[i] = data[i * 4 + 3] }
        return StampArt(width: width, height: height, alpha: alpha)
    }()

    public init(width: Int, height: Int, data: [UInt8], tintable: Bool, frames: [[UInt8]]? = nil, frameDelay: Double? = nil) {
        self.width = width
        self.height = height
        self.data = data
        self.tintable = tintable
        self.frames = frames
        self.frameDelay = frameDelay
    }
}

public typealias StickerArtLookup = (String, String?) -> StickerArt?
public typealias StickerRasterizer = @Sendable (StickerAsset, Int) throws -> (width: Int, height: Int, data: [UInt8])

public let defaultStickerRasterizer: StickerRasterizer = { asset, _ in
    switch asset {
    case .rgba(let width, let height, let data):
        return (width, height, data)
    case .image(let url, _, _):
        if let parsed = parseDataUrl(url), parsed.mime == "image/png" {
            let png = try decodePng(parsed.bytes)
            return (png.width, png.height, png.data)
        }
        throw StickerError("unsupported_format", "This environment can't draw non-PNG sticker art; pass rasterizeSticker in the paint editor's options (or use a provider that offers png).")
    case .svg:
        throw StickerError("unsupported_format", "This environment can't draw SVG sticker art; pass rasterizeSticker in the paint editor's options (or use a provider that offers png).")
    }
}

/// Every ref the provider lists (up to `cap`), for "did you mean" refusals (`knownRefs`).
func knownStickerRefs(_ provider: any StickerProvider, cap: Int = 500) throws -> [String] {
    var refs: [String] = []
    var after: String?
    while refs.count < cap {
        let page = try provider.list(StickerSearchOptions(limit: MAX_STICKER_PAGE, after: after))
        refs.append(contentsOf: page.items.map { stickerRefOf(provider, $0.id) })
        guard let next = page.next, !page.items.isEmpty else { break }
        after = next
    }
    return refs
}

/// Looks up `ref` in `provider`, refusing an unknown or foreign ref with the closest ones it has (`describeStickerRef`).
public func describeStickerRef(_ provider: any StickerProvider, _ ref: String) throws -> StickerDescription {
    let parsed = try parseStickerRefStrict(ref)
    if let id = try stickerIdFor(provider, ref), let found = try provider.describe(id) {
        return found
    }
    let near = closestStickerRefs(ref, (try? knownStickerRefs(provider)) ?? [])
    let id = try stickerIdFor(provider, ref)
    let wher = id == nil && !provider.namespaced ? " The sticker library is \"\(provider.id)\", not \"\(parsed.provider)\"." : ""
    throw StickerError("unknown_sticker", "No sticker \"\(ref)\".\(wher) Closest: \(near.isEmpty ? "none" : near.joined(separator: ", ")); find_stickers lists them.")
}

/// Loaded sticker art by ref and variant, with the state of each load (`StickerArtCache`).
public final class StickerArtCache: @unchecked Sendable {
    private enum Entry {
        case ready(StickerArt)
        case failed(String)
    }

    private var entries: [String: Entry] = [:]
    private var variants: [String: [String]] = [:]

    public init() {}

    private static func key(_ ref: String, _ variant: String? = nil) -> String {
        variant == "dark" ? "\(ref)#dark" : ref
    }

    public func get(_ ref: String, _ variant: String? = nil) -> StickerArt? {
        if case .ready(let art)? = entries[Self.key(ref, variant)] { return art }
        return nil
    }

    public func variantFor(_ ref: String, dark: Bool) -> String {
        dark && (variants[ref]?.contains("dark") == true) ? "dark" : "light"
    }

    public func status(_ ref: String, _ variant: String? = nil) -> (status: String, error: String?) {
        if editorStampOf(ref) != nil { return ("ready", nil) }
        guard let e = entries[Self.key(ref, variant)] else { return ("none", nil) }
        switch e {
        case .ready: return ("ready", nil)
        case .failed(let err): return ("failed", err)
        }
    }

    @discardableResult
    public func ensure(_ provider: any StickerProvider, _ ref: String, rasterize: StickerRasterizer = defaultStickerRasterizer, dark: Bool = false) throws -> StickerArt? {
        if editorStampOf(ref) != nil { return nil }
        let d: StickerDescription
        do {
            d = try describeStickerRef(provider, ref)
        } catch {
            let msg = (error as? StickerError)?.message ?? error.localizedDescription
            entries[Self.key(ref)] = .failed(msg)
            throw error
        }
        variants[ref] = d.variants ?? ["light"]
        let variant = stickerVariantFor(d.variants, dark: dark)
        let key = Self.key(ref, variant)
        if case .ready(let art)? = entries[key] { return art }
        do {
            let id = try stickerIdFor(provider, ref)!
            let max = provider.capabilities.maxSize ?? STICKER_ART_SIZE
            let size = Swift.min(STICKER_ART_SIZE, max)
            let v: String? = variant == "dark" ? "dark" : nil
            let format = d.formats.contains("png") ? "png" : (d.formats.first ?? "svg")
            let asset = try provider.load(id, StickerLoadOptions(format: format, size: size, variant: v))
            let px = try rasterize(asset, size)
            if !(px.width > 0 && px.height > 0) || px.data.count != px.width * px.height * 4 {
                throw StickerError("load_failed", "The art for \"\(ref)\" came back empty or the wrong size.")
            }
            let count = (d.animated == true && (d.frameCount ?? 1) > 1) ? d.frameCount! : 1
            if count <= 1 {
                let art = StickerArt(width: px.width, height: px.height, data: px.data, tintable: d.tintable)
                entries[key] = .ready(art)
                return art
            }
            var frames: [[UInt8]] = [px.data]
            for f in 1..<count {
                let fa = try provider.load(id, StickerLoadOptions(format: format, size: size, variant: v, frame: f))
                let fpx = try rasterize(fa, size)
                if fpx.width != px.width || fpx.height != px.height || fpx.data.count != px.data.count {
                    throw StickerError("load_failed", "Frame \(f) of \"\(ref)\" has size \(fpx.width)×\(fpx.height), expected \(px.width)×\(px.height).")
                }
                frames.append(fpx.data)
            }
            let art = StickerArt(width: px.width, height: px.height, data: px.data, tintable: d.tintable, frames: frames, frameDelay: d.frameDelay ?? 100)
            entries[key] = .ready(art)
            return art
        } catch {
            let msg = (error as? StickerError)?.message ?? error.localizedDescription
            entries[key] = .failed(msg)
            throw error
        }
    }

    public func clear() {
        entries.removeAll()
        variants.removeAll()
    }
}

/// The pixels drawn for animation frame `frame` of `art` (`stickerArtFrame`): the frame wrapped to
/// the art's frame count (negative frames count back from the last, so -1 is the last frame), or
/// `art.data` when the art is static or `frame` is nil. The canvas (`sampleArt`) and
/// `renderStickerStamp` both choose frames here.
public func stickerArtFrame(_ art: StickerArt, _ frame: Int?) -> [UInt8] {
    guard let frame, let frames = art.frames, !frames.isEmpty else { return art.data }
    return frames[((frame % frames.count) + frames.count) % frames.count]
}

/// The colour a sample of sticker art is drawn in, 0...1 RGB (`tintStickerArt`): tintable art
/// becomes a flat silhouette in the paint colour `tint`, shaped only by the art's alpha; other art
/// keeps its own colour. The canvas (`drawSticker`) and `renderStickerStamp` both tint here.
public func tintStickerArt(_ art: StickerArt, _ sample: (r: Double, g: Double, b: Double, a: Double), _ tint: [Double]) -> (r: Double, g: Double, b: Double) {
    art.tintable ? (tint[0], tint[1], tint[2]) : (sample.r, sample.g, sample.b)
}

/// Bilinear RGBA sample of `art` at (x, y) in its pixels (straight alpha, colour weighted by alpha; `sampleArt`), in frame `frame` (`stickerArtFrame`).
public func sampleArt(_ art: StickerArt, _ x: Double, _ y: Double, frame: Int? = nil) -> (r: Double, g: Double, b: Double, a: Double) {
    let w = art.width, h = art.height
    let data = stickerArtFrame(art, frame)
    let fx = x - 0.5, fy = y - 0.5
    let x0 = Int(JS.floor(fx)), y0 = Int(JS.floor(fy))
    let tx = fx - Double(x0), ty = fy - Double(y0)
    var r = 0.0, g = 0.0, b = 0.0, a = 0.0
    for k in 0..<4 {
        let xx = x0 + (k & 1)
        let yy = y0 + (k >> 1)
        if xx < 0 || yy < 0 || xx >= w || yy >= h { continue }
        let wgt = (k & 1 != 0 ? tx : 1 - tx) * (k >> 1 != 0 ? ty : 1 - ty)
        let i = (yy * w + xx) * 4
        let al = Double(data[i + 3]) * wgt
        r += Double(data[i]) * al
        g += Double(data[i + 1]) * al
        b += Double(data[i + 2]) * al
        a += al
    }
    return (a > 0 ? r / a / 255 : 0, a > 0 ? g / a / 255 : 0, a > 0 ? b / a / 255 : 0, a / 255)
}

/// Refs closest to `wanted` by edit distance (ties alphabetical; `closestStickerRefs`).
func closestStickerRefs(_ wanted: String, _ candidates: [String], _ n: Int = 3) -> [String] {
    let w = Array(wanted.lowercased().utf16)
    func dist(_ b: [UInt16]) -> Int {
        var d = Array(0...b.count)
        for i in 1...Swift.max(1, w.count) where !w.isEmpty {
            var prev = d[0]
            d[0] = i
            for j in stride(from: 1, through: b.count, by: 1) {
                let tmp = d[j]
                d[j] = Swift.min(d[j] + 1, d[j - 1] + 1, prev + (w[i - 1] == b[j - 1] ? 0 : 1))
                prev = tmp
            }
        }
        return w.isEmpty ? b.count : d[b.count]
    }
    return candidates.map { ($0, dist(Array($0.lowercased().utf16))) }.sorted { $0.1 != $1.1 ? $0.1 < $1.1 : $0.0 < $1.0 }.prefix(n).map(\.0)
}

/// Parses a ref strictly (`parseStickerRef` in `stickers/helpers.ts`), throwing what is wrong.
func parseStickerRefStrict(_ ref: String) throws -> (provider: String, id: String) {
    if ref.isEmpty { throw StickerError("invalid_argument", "A sticker ref is a \"provider:id\" string, e.g. \"editor:star\" (find_stickers lists them).") }
    guard let i = ref.firstIndex(of: ":") else {
        if STAMP_KINDS.contains(ref) { return (EDITOR_STICKERS_ID, ref) }
        throw StickerError("invalid_argument", "\"\(ref)\" is not a sticker ref; refs are \"provider:id\" (e.g. \"editor:\(STAMP_KINDS[1])\"); find_stickers lists them.")
    }
    if i == ref.startIndex || ref.index(after: i) == ref.endIndex { throw StickerError("invalid_argument", "\"\(ref)\" is not a sticker ref; refs are \"provider:id\".") }
    return (String(ref[..<i]), String(ref[ref.index(after: i)...]))
}

// MARK: - Stickers on a layer

/// A placed sticker: an object on a sticker layer (`Sticker`).
public struct Sticker: Equatable, Sendable {
    public var id: String
    public var ref: String
    /// The editor stamp, for editor stickers.
    public var stamp: String?
    /// Centre in document pixels.
    public var x: Double
    public var y: Double
    /// Diameter in pixels.
    public var size: Double
    /// Degrees clockwise.
    public var rotation: Double
    public var color: String
    public var opacity: Double
    public var seed: Int
    /// `dark` when drawn in its sticker's dark variant; nil for light art.
    public var variant: String? = nil
    /// 0-based animation frame index when the sticker is animated; nil when 0 or static.
    public var frame: Int? = nil

    public init(
        id: String, ref: String, stamp: String? = nil, x: Double, y: Double, size: Double,
        rotation: Double, color: String, opacity: Double, seed: Int, variant: String? = nil, frame: Int? = nil
    ) {
        self.id = id
        self.ref = ref
        self.stamp = stamp
        self.x = x
        self.y = y
        self.size = size
        self.rotation = rotation
        self.color = color
        self.opacity = opacity
        self.seed = seed
        self.variant = variant
        self.frame = frame
    }

    public var json: JSONObject {
        var o: JSONObject = ["id": .string(id), "ref": .string(ref)]
        if let stamp { o["stamp"] = .string(stamp) }
        o["x"] = .number(x); o["y"] = .number(y); o["size"] = .number(size); o["rotation"] = .number(rotation)
        o["color"] = .string(color); o["opacity"] = .number(opacity); o["seed"] = .number(Double(seed))
        if let variant, variant == "dark" { o["variant"] = .string(variant) }
        if let frame, frame > 0 { o["frame"] = .number(Double(frame)) }
        return o
    }
}

private func hexRgb(_ hex: String) -> [Double] {
    let n = Int(hex.dropFirst().prefix(6), radix: 16) ?? 0
    return [Double((n >> 16) & 255) / 255, Double((n >> 8) & 255) / 255, Double(n & 255) / 255]
}

/// The pixel rectangle a sticker can touch (`stickerRect`).
public func stickerRect(_ s: Sticker) -> RasterRect {
    let r = s.size / 2 + 1
    let x0 = Int(JS.floor(s.x - r)), y0 = Int(JS.floor(s.y - r))
    return RasterRect(x: x0, y: y0, width: Int(JS.ceil(s.x + r)) - x0, height: Int(JS.ceil(s.y + r)) - y0)
}

/// The editor stamp a sticker draws, or nil for another library's sticker (`stickerStamp`).
func stickerStamp(_ s: Sticker) -> String? {
    if !s.ref.isEmpty { return editorStampOf(s.ref) }
    return s.stamp.flatMap { STAMP_KINDS.contains($0) ? $0 : nil }
}

/// Draws a provider sticker from its art (`drawArtSticker`).
private func drawArtSticker(_ medium: TileMedium, _ s: Sticker, _ art: StickerArt) -> RasterRect {
    let rect = stickerRect(s)
    let n = rect.width * rect.height
    var cov = [Float](repeating: 0, count: n)
    var field = [Float](repeating: 0, count: n * 3)
    let a = (s.rotation * Double.pi) / 180
    let ca = JS.cos(a), sa = JS.sin(a)
    let scale = Double(Swift.max(art.width, art.height)) / s.size
    let rgb = hexRgb(s.color)
    var p = 0
    for yy in 0..<rect.height {
        for xx in 0..<rect.width {
            defer { p += 1 }
            let dx = Double(rect.x + xx) + 0.5 - s.x
            let dy = Double(rect.y + yy) + 0.5 - s.y
            let ax = (dx * ca + dy * sa) * scale + Double(art.width) / 2
            let ay = (-dx * sa + dy * ca) * scale + Double(art.height) / 2
            if ax < -1 || ay < -1 || ax > Double(art.width) + 1 || ay > Double(art.height) + 1 { continue }
            let px = sampleArt(art, ax, ay, frame: s.frame)
            if !(px.a > 0) { continue }
            cov[p] = Float(px.a)
            let c = tintStickerArt(art, px, rgb)
            field[p * 3] = Float(c.r)
            field[p * 3 + 1] = Float(c.g)
            field[p * 3 + 2] = Float(c.b)
        }
    }
    medium.deposit(rect, cov, s.opacity, rgb, nil, field)
    return rect
}

/// The sticker `renderStickerStamp` draws: centred in a `size` px box at (0, 0), full opacity.
private func stampSticker(_ ref: String, colour: String, size: Int, frame: Int, rotation: Double) -> Sticker {
    let hex = colour.utf8.count == 7 && colour.hasPrefix("#") && colour.dropFirst().allSatisfy(\.isHexDigit) ? colour.lowercased() : "#000000"
    let half = Double(size) / 2
    return Sticker(
        id: "stamp", ref: ref, stamp: editorStampOf(ref), x: half, y: half, size: Double(size),
        rotation: rotation.isFinite ? rotation : 0, color: hex, opacity: 1, seed: 0, frame: frame != 0 ? frame : nil
    )
}

/// Draws one sticker through the sticker layer's own redraw (`stickerSurface`) and reads its `size` px box.
private func stampPixels(_ s: Sticker, _ size: Int, _ art: StickerArtLookup?) -> (width: Int, height: Int, data: [UInt8]) {
    let surface = stickerSurface([s], art: art)
    return (size, size, readRegion(surface, RasterRect(x: 0, y: 0, width: size, height: size)))
}

/// One sticker stamp exactly as the paint canvas draws it (`renderStickerStamp`), for previews (a
/// swatch, a stroke preview, a sticker picker): `size × size` straight RGBA of a sticker of diameter
/// `size` centred in the box at full opacity, drawn by the canvas's own code (`drawSticker` through
/// `stickerSurface`), so tinting, frame choice and sampling can't drift from what a stroke paints.
///
/// - Tint: tintable art is a flat silhouette in `colour` (`#rrggbb`, any case), shaped by the
///   art's alpha; other art keeps its own pixels and ignores `colour`. A colour that isn't
///   `#rrggbb` draws black.
/// - Fit: the art's longest side spans `size`, centred, sampled bilinearly from the art.
/// - Frame: wrapped to the art's frame count (negative frames count back from the last, so -1 is
///   the last); static art has one frame.
/// - Rotation: degrees clockwise about the centre, as `Sticker.rotation`; non-finite is 0. The
///   output stays `size × size`, so the corners of turned art are cut off, as the canvas cuts them
///   at the sticker's box. (The canvas's box has one more pixel on each side, which only bilinear
///   bleed of art drawn larger than its own pixels or the corners of turned art reach; the stamp
///   leaves that ring out.)
/// - `size <= 0` gives `(0, 0, [])`.
/// - A pixel of the stamp equals the canvas pixel of a sticker centred at
///   (x + size / 2, y + size / 2) for whole x, y. The TS core's `renderStickerStamp` gives the same bytes.
public func renderStickerStamp(_ art: StickerArt, colour: String, size: Int, frame: Int = 0, rotation: Double = 0) -> (width: Int, height: Int, data: [UInt8]) {
    guard size > 0 else { return (0, 0, []) }
    return stampPixels(stampSticker("stamp:art", colour: colour, size: size, frame: frame, rotation: rotation), size) { _, _ in art }
}

/// `renderStickerStamp` for a sticker ref from `provider` (`renderStickerStampFrom`), loading its
/// art through `StickerArtCache.ensure` (pass the paint editor's cache to share loads; unknown refs
/// and failed loads throw the cache's errors). `dark` loads the sticker's dark variant when it has
/// one. An editor stamp (`editor:star`) draws the editor's procedural stamp in `colour` with
/// texture seed 0; its shading noise is keyed on canvas pixels, so it matches a canvas sticker at
/// the same position.
public func renderStickerStamp(
    _ provider: any StickerProvider, ref: String, colour: String, size: Int, frame: Int = 0, rotation: Double = 0,
    cache: StickerArtCache = StickerArtCache(), rasterize: StickerRasterizer = defaultStickerRasterizer, dark: Bool = false
) throws -> (width: Int, height: Int, data: [UInt8]) {
    let art = try cache.ensure(provider, ref, rasterize: rasterize, dark: dark)
    guard size > 0 else { return (0, 0, []) }
    if let art { return renderStickerStamp(art, colour: colour, size: size, frame: frame, rotation: rotation) }
    let parsed = try parseStickerRefStrict(ref)
    return stampPixels(stampSticker("\(parsed.provider):\(parsed.id)", colour: colour, size: size, frame: frame, rotation: rotation), size, nil)
}

/// Draws one sticker into a medium; returns the rectangle it touched (`drawSticker`).
@discardableResult
func drawSticker(_ medium: TileMedium, _ s: Sticker, _ art: StickerArtLookup? = nil) -> RasterRect {
    guard let kind = stickerStamp(s) else {
        if let a = art?(s.ref, s.variant) { return drawArtSticker(medium, s, a) }
        return stickerRect(s)
    }
    let rect = stickerRect(s)
    let n = rect.width * rect.height
    var cov = [Float](repeating: 0, count: n)
    var field = [Float](repeating: 0, count: n * 3)
    let rad = s.size / 2
    let a = (s.rotation * Double.pi) / 180
    let ca = JS.cos(a), sa = JS.sin(a)
    let rgb = hexRgb(s.color)
    var p = 0
    for yy in 0..<rect.height {
        for xx in 0..<rect.width {
            defer { p += 1 }
            let px = rect.x + xx
            let dx = Double(px) + 0.5 - s.x
            let dy = Double(rect.y + yy) + 0.5 - s.y
            let u = (dx * ca + dy * sa) / rad
            let v = (-dx * sa + dy * ca) / rad
            if u < -1.05 || u > 1.05 || v < -1.05 || v > 1.05 { continue }
            var c = 0.0
            for k in 0..<4 { c += stampCoverage(kind, u + (Double(k & 1) - 0.5) / rad / 2, v + (Double(k >> 1) - 0.5) / rad / 2, s.seed) }
            c /= 4
            if c <= 0 { continue }
            cov[p] = Float(c)
            let shade = 1 + 0.12 * (-(u + v) / 2) + 0.06 * (PixerateRandom.hash2(px, rect.y + yy, s.seed) - 0.5)
            for k in 0..<3 { field[p * 3 + k] = Float(Swift.min(1, Swift.max(0, rgb[k] * shade))) }
        }
    }
    medium.deposit(rect, cov, s.opacity, rgb, nil, field)
    return rect
}

private func signedPow(_ v: Double, _ e: Double) -> Double { JS.pow(v, e) }
private func srgbToLinearSigned(_ v: Double) -> Double {
    let sign: Double = v > 0 ? 1 : v < 0 ? -1 : 0
    let a = abs(v)
    return sign * (a <= 0.04045 ? a / 12.92 : signedPow((a + 0.055) / 1.055, 2.4))
}
private func linearToSrgbSigned(_ v: Double) -> Double {
    let sign: Double = v > 0 ? 1 : v < 0 ? -1 : 0
    let a = abs(v)
    return sign * (a <= 0.0031308 ? 12.92 * a : 1.055 * signedPow(a, 1 / 2.4) - 0.055)
}

/// A colour moved a little in OKLCH lightness and hue, kept in gamut (`jitterColor`).
func jitterColor(_ hex: String, _ amount: Double, _ seed: Int, _ i: Int) -> String {
    let c = hexRgb(hex)
    let lr = srgbToLinearSigned(c[0]), lg = srgbToLinearSigned(c[1]), lb = srgbToLinearSigned(c[2])
    let l_ = JS.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
    let m_ = JS.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
    let s_ = JS.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
    let L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
    let A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
    let B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
    let chroma = JS.hypot(A, B)
    var hue = 0.0
    if chroma >= 1e-6 {
        hue = (JS.atan2(B, A) * 180) / Double.pi
        if hue < 0 { hue += 360 }
        if hue >= 360 { hue -= 360 }
    }
    let l = Swift.min(1, Swift.max(0, L + (PixerateRandom.rand01(seed, i, 61) - 0.5) * amount * 0.3))
    let h = hue + (PixerateRandom.rand01(seed, i, 63) - 0.5) * amount * 80
    func at(_ ch: Double) -> [Double] {
        let rad = (h * Double.pi) / 180
        let a = ch * JS.cos(rad), b = ch * JS.sin(rad)
        let l3 = JS.pow(l + 0.3963377774 * a + 0.2158037573 * b, 3)
        let m3 = JS.pow(l - 0.1055613458 * a - 0.0638541728 * b, 3)
        let s3 = JS.pow(l - 0.0894841775 * a - 1.291485548 * b, 3)
        return [
            linearToSrgbSigned(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
            linearToSrgbSigned(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
            linearToSrgbSigned(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
        ]
    }
    func inGamut(_ o: [Double]) -> Bool { o.allSatisfy { $0 >= -1e-4 && $0 <= 1 + 1e-4 } }
    var out = at(chroma)
    if !inGamut(out) {
        var lo = 0.0, hi = chroma
        for _ in 0..<12 {
            let mid = (lo + hi) / 2
            if inGamut(at(mid)) { lo = mid } else { hi = mid }
        }
        out = at(lo)
    }
    return "#" + out.map { String(Int(JS.round(Swift.min(1, Swift.max(0, $0)) * 255)), radix: 16).leftPad(2) }.joined()
}

/// A sticker layer's pixels drawn from its stickers (`stickerSurface`); with `dirty`, only those tiles are redrawn over `base`.
func stickerSurface(_ stickers: [Sticker], base: TiledSurface? = nil, dirty: [RasterRect]? = nil, art: StickerArtLookup? = nil) -> TiledSurface {
    final class Target: PaintTileTarget {
        var live: [TileKey: ByteTile] = [:]
        var order: [TileKey] = []
        let only: Set<TileKey>?
        init(_ only: Set<TileKey>?) { self.only = only }
        let offset = LayerOffset(x: 0, y: 0)
        let lockTransparency = false
        let selection: PaintSelection? = nil
        func readTile(_ tx: Int, _ ty: Int) -> ByteTile? { live[tileKey(tx, ty)] }
        func writeTile(_ tx: Int, _ ty: Int) -> ByteTile {
            let k = tileKey(tx, ty)
            if let only, !only.contains(k) { return ByteTile([UInt8](repeating: 0, count: TILE * TILE * 4)) }
            if let t = live[k] { return t }
            let t = ByteTile([UInt8](repeating: 0, count: TILE * TILE * 4))
            live[k] = t
            order.append(k)
            return t
        }
    }
    let only: Set<TileKey>? = base != nil && dirty != nil ? Set(dirty!.flatMap { tilesInRect($0).map { tileKey($0.tx, $0.ty) } }) : nil
    let target = Target(only)
    let medium = TileMedium(target, blend: nil)
    for s in stickers where only == nil || tilesInRect(stickerRect(s)).contains(where: { only!.contains(tileKey($0.tx, $0.ty)) }) { drawSticker(medium, s, art) }
    var tiles = OrderedMap<TileKey, Tile>()
    if let only, let base { for (k, t) in base.tiles where !only.contains(k) { tiles.set(k, t) } }
    for k in target.order { if let t = finishTile(target.live[k]!.data, 4, 0) { tiles.set(k, t) } }
    return TiledSurface(channels: 4, tiles: tiles, defaultValue: 0)
}

/// The top-most sticker under a point, by its stamp's shape (`stickerAt`).
func stickerAt(_ stickers: [Sticker], _ x: Double, _ y: Double, _ art: StickerArtLookup? = nil) -> Sticker? {
    for s in stickers.reversed() {
        let rad = s.size / 2
        let a = (s.rotation * Double.pi) / 180
        let dx = x - s.x, dy = y - s.y
        let u = (dx * JS.cos(a) + dy * JS.sin(a)) / rad
        let v = (-dx * JS.sin(a) + dy * JS.cos(a)) / rad
        if abs(u) > 1.05 || abs(v) > 1.05 { continue }
        if s.size < 16 { return s }
        if let kind = stickerStamp(s) {
            if stampCoverage(kind, u, v, s.seed) > 0.25 { return s }
            continue
        }
        guard let pic = art?(s.ref, s.variant) else { return s }
        let scale = Double(Swift.max(pic.width, pic.height)) / 2
        if sampleArt(pic, u * scale + Double(pic.width) / 2, v * scale + Double(pic.height) / 2, frame: s.frame).a > 0.25 { return s }
    }
    return nil
}

/// A checked partial sticker (`normalizeStickerUpdate`); throws what is wrong.
func normalizeStickerUpdate(_ u: JSONObject) throws -> JSONObject {
    var out = JSONObject()
    if u["ref"] != nil && u["stamp"] != nil { throw PaintEditorError("Give ref or stamp, not both (stamp is the older name for an editor stamp).") }
    if let st = u["stamp"] {
        guard let s = st.stringValue, STAMP_KINDS.contains(s) else { throw PaintEditorError("stamp \(st.stringified()) is not a stamp; use \(STAMP_KINDS.joined(separator: ", ")), or ref for any sticker (find_stickers).") }
        out["ref"] = .string("editor:\(s)")
        out["stamp"] = .string(s)
    }
    if let r = u["ref"] {
        let p: (provider: String, id: String)
        do { p = try parseStickerRefStrict(r.stringValue ?? "") } catch let e as StickerError { throw PaintEditorError(e.message) }
        let ref = "\(p.provider):\(p.id)"
        out["ref"] = .string(ref)
        out["stamp"] = editorStampOf(ref).map { .string($0) } ?? .null
    }
    for k in ["x", "y"] {
        if let v = u[k] {
            guard let n = v.numberValue, n.isFinite else { throw PaintEditorError("\(k) must be a number of pixels.") }
            out[k] = .number(n)
        }
    }
    if let v = u["size"] {
        guard let n = v.numberValue, n >= 2 && n <= 2048 else { throw PaintEditorError("size \(v.stringified()) is out of range; use 2..2048 px.") }
        out["size"] = .number(n)
    }
    if let v = u["rotation"] {
        guard let n = v.numberValue, n.isFinite else { throw PaintEditorError("rotation must be degrees.") }
        out["rotation"] = .number(n)
    }
    if let v = u["color"] {
        guard let s = v.stringValue, s.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil else { throw PaintEditorError("color \(v.stringified()) must be #rrggbb.") }
        out["color"] = .string(s.lowercased())
    }
    if let v = u["opacity"] {
        guard let n = v.numberValue, n >= 0 && n <= 1 else { throw PaintEditorError("opacity \(v.stringified()) is out of range; use 0..1.") }
        out["opacity"] = .number(n)
    }
    if let v = u["frame"] {
        guard let n = v.numberValue, n.isFinite, n.rounded() == n, n >= 0 else {
            throw PaintEditorError("frame \(v.stringified()) must be a whole number >= 0.")
        }
        out["frame"] = .number(n)
    }
    return out
}

extension Sticker {
    /// A sticker as saved (`json`), or nil when it is not one.
    init?(json: JSONValue) {
        guard let o = json.objectValue, let id = o["id"]?.stringValue, let x = o["x"]?.numberValue, let y = o["y"]?.numberValue else { return nil }
        let variant = o["variant"]?.stringValue == "dark" ? "dark" : nil
        // A frame is saved only past the first (`frame` 0 is left out); anything else is not a frame.
        let frame = o["frame"]?.numberValue.flatMap { $0.isFinite && $0.rounded() == $0 && $0 > 0 ? Int($0) : nil }
        self.init(
            id: id,
            ref: o["ref"]?.stringValue ?? o["stamp"]?.stringValue.map { "editor:\($0)" } ?? "",
            stamp: o["stamp"]?.stringValue,
            x: x, y: y,
            size: o["size"]?.numberValue ?? 48,
            rotation: o["rotation"]?.numberValue ?? 0,
            color: o["color"]?.stringValue ?? "#000000",
            opacity: o["opacity"]?.numberValue ?? 1,
            seed: Int(o["seed"]?.numberValue ?? 0),
            variant: variant,
            frame: frame
        )
    }

    /// The sticker with a checked update applied (`stamp: null` clears the stamp).
    func applying(_ u: JSONObject) -> Sticker {
        var s = self
        if let r = u["ref"]?.stringValue { s.ref = r }
        if let st = u["stamp"] { s.stamp = st.stringValue }
        if let v = u["x"]?.numberValue { s.x = v }
        if let v = u["y"]?.numberValue { s.y = v }
        if let v = u["size"]?.numberValue { s.size = v }
        if let v = u["rotation"]?.numberValue { s.rotation = v }
        if let v = u["color"]?.stringValue { s.color = v }
        if let v = u["opacity"]?.numberValue { s.opacity = v }
        if let v = u["frame"]?.numberValue { s.frame = v > 0 ? Int(v) : nil }
        return s
    }
}

/**
 * A placed sticker with its animation frame checked against its art (`stickerWithFrame`): frame 0
 * is left out (the saved form), and a frame past the art's last is refused naming how many it has.
 * Editor stamps and static art have one frame; art that has not loaded passes unchecked (the
 * redraw refuses it until it has).
 */
func stickerWithFrame(_ s: Sticker, _ art: StickerArt?) throws -> Sticker {
    var out = s
    guard let frame = s.frame, frame != 0 else { out.frame = nil; return out }
    if frame < 0 { throw PaintEditorError("frame \(frame) must be a whole number >= 0.") }
    if stickerStamp(s) == nil && art == nil { return out }
    let count = (art?.frames?.count ?? 1) > 1 ? art!.frames!.count : 1
    if frame >= count {
        throw PaintEditorError(count > 1 ? "\"\(s.ref)\" has \(count) frames, so frame is 0..\(count - 1); got \(frame)." : "\"\(s.ref)\" is not animated, so its only frame is 0; got \(frame) (describe_sticker says whether a sticker is animated and its frameCount).")
    }
    return out
}

// MARK: - Sticker spray

/// The stickers a sticker brush sprays along a stroke (`StickerSpray`).
final class StickerSpray {
    var dabCount = 0
    private(set) var stickers: [Sticker] = []
    private(set) var skipped: [String] = []
    private let brush: PaintBrush
    private let color: String
    private let seed: Int
    private let paint: PaintGradientSource?
    private let effect: EffectPaintPixels?
    private let art: StickerArtLookup?
    private let variant: ((String) -> String)?
    private let smoother: PenSmoother
    private let walkers: [PenDabWalker]
    private let copies: [StrokeCopy]
    private let medium: TileMedium
    private var lastRaw: PenPoint?
    private var lastFed: PenPoint?
    private var nextNumber: Int
    private var sampler: PaintGradientSampler?
    private let stamps: [String]
    private let density, sizeJitter, rotationJitter, scatter, colorJitter: Double
    private let frameMode: String

    init(
        brush: PaintBrush, target: PaintTileTarget, color: String, seed: Int, copies: [StrokeCopy],
        nextId: Int, paint: PaintGradientSource?, effect: EffectPaintPixels?,
        art: StickerArtLookup? = nil, variant: ((String) -> String)? = nil
    ) {
        self.brush = brush
        self.color = color
        self.seed = seed
        self.paint = paint
        self.effect = effect
        self.art = art
        self.variant = variant
        let st = brush.sticker
        stamps = (st["stamps"]?.arrayValue ?? []).compactMap(\.stringValue)
        density = st["density"]?.numberValue ?? 0.4
        sizeJitter = st["sizeJitter"]?.numberValue ?? 0
        rotationJitter = st["rotationJitter"]?.numberValue ?? 0
        scatter = st["scatter"]?.numberValue ?? 0
        colorJitter = st["colorJitter"]?.numberValue ?? 0
        frameMode = st["frameMode"]?.stringValue == "random" ? "random" : "perform"
        smoother = PenSmoother(brush.tip.smoothing, brush.pressureSmoothing)
        self.copies = copies.isEmpty ? [IDENTITY_COPY] : copies
        // One walked dab per sticker: spacing from the density.
        var walk = brush
        walk.tip.spacing = Swift.max(0.05, 1 / Swift.max(0.05, density * 4))
        walk.dynamics.scatter = 0
        walk.dynamics.sizeJitter = 0
        walk.dynamics.angleJitter = 0
        walkers = self.copies.enumerated().map { i, c in PenDabWalker(walk, Int(Int32(truncatingIfNeeded: seed + i * 7919)), c.linear) }
        medium = TileMedium(target, blend: nil)
        nextNumber = nextId
    }

    func push(_ points: [PenPoint]) -> [RasterRect] {
        var rects: [RasterRect] = []
        for raw in points {
            lastRaw = raw
            let p = smoother.push(raw)
            lastFed = p
            for (i, c) in copies.enumerated() {
                var dabs: [PenDab] = []
                walkers[i].push(c.map(p), &dabs)
                for d in dabs { drop(d, &rects) }
            }
        }
        return rects
    }

    func finish() -> [RasterRect] {
        var rects: [RasterRect] = []
        for (i, c) in copies.enumerated() {
            var dabs: [PenDab] = []
            if let raw = lastRaw, let fed = lastFed, raw.x != fed.x || raw.y != fed.y {
                var q = raw
                q.pressure = fed.pressure
                walkers[i].push(c.map(q), &dabs)
            }
            walkers[i].finish(&dabs)
            for d in dabs { drop(d, &rects) }
        }
        return rects
    }

    private func drop(_ d: PenDab, _ rects: inout [RasterRect]) {
        let i = nextNumber
        let r = d.dab.radius
        let size = r * 2 * (1 - sizeJitter * 0.7 * PixerateRandom.rand01(seed, i, 51))
        let off = scatter * r * 2
        let a = PixerateRandom.rand01(seed, i, 53) * Double.pi * 2
        let dist = PixerateRandom.rand01(seed, i, 55) * off
        let base = colorAt(d, JS.cos(a) * dist, JS.sin(a) * dist)
        if !(base.alpha > 0) {
            nextNumber += 1
            return
        }
        let pick = Int(JS.floor(PixerateRandom.rand01(seed, i, 57) * Double(stamps.count)))
        let ref = pick < stamps.count ? stamps[pick] : "editor:dot"
        let stamp = editorStampOf(ref)
        let v = stamp != nil ? "light" : (variant?(ref) ?? "light")
        let pic = stamp != nil ? nil : art?(ref, v)
        if stamp == nil && pic == nil {
            if !skipped.contains(ref) { skipped.append(ref) }
            nextNumber += 1
            return
        }
        let frameCount = (pic?.frames?.count ?? 1) > 1 ? pic!.frames!.count : 1
        let frame: Int
        if frameCount > 1 {
            if frameMode == "random" {
                frame = Int(JS.floor(PixerateRandom.rand01(seed, i, 67) * Double(frameCount))) % frameCount
            } else {
                let elapsed = Swift.max(0, d.time ?? 0)
                let delay = Swift.max(1, pic?.frameDelay ?? 100)
                frame = Int(JS.floor(elapsed / delay)) % frameCount
            }
        } else {
            frame = 0
        }
        let sticker = Sticker(
            id: "st\(nextNumber)", ref: ref, stamp: stamp,
            x: JS.round((d.dab.x + JS.cos(a) * dist) * 100) / 100, y: JS.round((d.dab.y + JS.sin(a) * dist) * 100) / 100,
            size: Swift.max(2, JS.round(size * 10) / 10),
            rotation: JS.round(((-d.dab.angle * 180) / Double.pi + (PixerateRandom.rand01(seed, i, 59) * 2 - 1) * 180 * rotationJitter) * 10) / 10,
            color: colorJitter > 0 ? jitterColor(base.color, colorJitter, seed, i) : base.color,
            opacity: JS.round(Swift.min(1, d.dab.opacity * brush.tip.opacity * base.alpha) * 1000) / 1000,
            seed: Int(JS.floor(PixerateRandom.rand01(seed, i, 65) * 1e9)),
            variant: v == "dark" ? "dark" : nil,
            frame: frame > 0 ? frame : nil
        )
        nextNumber += 1
        stickers.append(sticker)
        rects.append(drawSticker(medium, sticker, art))
        dabCount += 1
    }

    private func colorAt(_ d: PenDab, _ dx: Double, _ dy: Double) -> (color: String, alpha: Double) {
        func hex(_ rgb: [Double]) -> String { "#" + rgb.map { String(Int(JS.round(Swift.min(1, Swift.max(0, $0)) * 255)), radix: 16).leftPad(2) }.joined() }
        if let effect {
            let e = sampleEffectAt(effect, d.dab.x + dx, d.dab.y + dy, EffectDabPlace(d))
            return (hex(e.rgb), e.alpha)
        }
        guard let g = paint else { return (color, 1) }
        if sampler == nil { sampler = PaintGradientSampler(g, seed: seed) }
        let s = g.map.by == "across-tip"
            ? sampler!.sample(((dx * JS.sin(d.direction) + dy * JS.cos(d.direction)) / Swift.max(0.5, d.dab.radius) + 1) / 2)
            : sampler!.dab(d.params)
        return (hex(s.rgb), s.alpha)
    }
}
