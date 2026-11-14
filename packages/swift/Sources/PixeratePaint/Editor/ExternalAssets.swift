import Foundation
import PixerateCore
import PixerateRaster

/**
 External asset stores (`ImageEditorAssetStore` / `PaintAssetStore`, `serializeLayersExternal`,
 `serializePaintDocumentExternal`, `resolveExternalAssets` and `deserializePaintDocumentAsync`):
 a saved painting whose PNGs live outside the JSON, in a store the host provides, with the same
 references, asset ids and problems as the TS core.
 */

/**
 Where a host keeps a painting's PNGs outside the JSON (`PaintAssetStore`): `put` stores a PNG and
 returns a reference (a URL, a key) that `get` resolves later. Each PNG is put once per store (by
 content), so keep the same store object across saves.
 */
public protocol PaintAssetStore: AnyObject {
    /// Stores PNG bytes; `id` is the asset id in the document, `width` and `height` the PNG's size.
    func put(_ png: [UInt8], id: String, width: Int, height: Int) async throws -> String
    /// The PNG bytes of a reference `put` returned.
    func get(_ ref: String) async throws -> [UInt8]
}

/// Layer PNGs already stored, by store: data URL → the store's reference (`externalRefs`).
private let externalRefs = WeakObjectMap<[String: String]>()
/// Extension PNGs already stored, by store: data URL → the store's reference (`storedPngs`).
private let storedPngs = WeakObjectMap<[String: String]>()

private let PNG_DATA_URL = "data:image/png;base64,"

/// A big-endian `u32` at `o`, or 0 past the end (as JavaScript reads `undefined` bytes).
private func pngU32(_ b: [UInt8], _ o: Int) -> Int {
    if b.count < o + 4 { return 0 }
    let hi: UInt32 = (UInt32(b[o]) << 24) | (UInt32(b[o + 1]) << 16)
    let lo: UInt32 = (UInt32(b[o + 2]) << 8) | UInt32(b[o + 3])
    return Int(hi | lo)
}

/// FNV-1a of a string's UTF-16 code units, as 8 hex digits (an extension PNG's asset id).
func fnv1a(_ text: String) -> String {
    var h: UInt32 = 0x811C_9DC5
    for c in text.utf16 {
        h ^= UInt32(c)
        h = h &* 0x0100_0193
    }
    return String(h, radix: 16).leftPad(8)
}

/// The store's reference for `url` (put once per store and content) or a thrown error.
private func storeRef(_ cache: WeakObjectMap<[String: String]>, _ store: PaintAssetStore, _ url: String, _ put: () async throws -> String, _ id: String) async throws -> String {
    if let known = cache.with(store, default: { [:] }, { $0[url] }) { return known }
    let ref = try await put()
    if ref.isEmpty { throw PaintEditorError("The asset store returned no reference for \"\(id)\".") }
    cache.with(store, default: { [:] }) { $0[url] = ref }
    return ref
}

/// `assets` (asset id → PNG data URL) with each PNG put in `store` once, by content (`serializeLayersExternal`).
func externalizeLayerAssets(_ assets: JSONObject, _ store: PaintAssetStore) async throws -> JSONObject {
    var out = JSONObject()
    for (id, value) in assets {
        guard case .string(let url) = value else { continue }
        let ref = try await storeRef(externalRefs, store, url, {
            let bytes = parseDataUrl(url)?.bytes ?? []
            return try await store.put(bytes, id: id, width: pngU32(bytes, 16), height: pngU32(bytes, 20))
        }, id)
        out[id] = .string(ref)
    }
    return out
}

/// `value` with each PNG data URL in it put in `store` and replaced by `asset:<id>` (the id added to `assets`).
func externalizePngs(_ value: JSONValue, _ assets: inout JSONObject, _ store: PaintAssetStore) async throws -> JSONValue {
    switch value {
    case .string(let s):
        if !s.hasPrefix(PNG_DATA_URL) { return value }
        let id = "ext-\(fnv1a(s))-\(String(s.utf16.count, radix: 36))"
        if !jsTruthy(assets[id]) {
            guard let parsed = parseDataUrl(s) else { return value }
            let b = parsed.bytes
            let ref = try await storeRef(storedPngs, store, s, {
                try await store.put(b, id: id, width: b.count >= 24 ? pngU32(b, 16) : 0, height: b.count >= 24 ? pngU32(b, 20) : 0)
            }, id)
            assets[id] = .string(ref)
        }
        return .string(EXTENSION_ASSET_REF + id)
    case .array(let a):
        var out: [JSONValue] = []
        for v in a { out.append(try await externalizePngs(v, &assets, store)) }
        return .array(out)
    case .object(let o):
        var out = JSONObject()
        for (k, v) in o { out[k] = try await externalizePngs(v, &assets, store) }
        return .object(out)
    default:
        return value
    }
}

/**
 Turns external asset references back into PNG data URLs through `store.get` (data URLs pass
 through), so the document loads like an inline one (`resolveExternalAssets`). References that
 fail are reported in `problems` and left out.
 */
func resolveExternalAssets(_ assets: JSONObject, _ store: PaintAssetStore?, _ problems: inout [String]) async throws -> JSONObject {
    var out = JSONObject()
    for (id, value) in assets {
        // `ref.startsWith` of a value that is not a string throws in the TS core.
        guard case .string(let ref) = value else { throw PaintEditorError("ref.startsWith is not a function") }
        if ref.hasPrefix("data:") {
            out[id] = value
            continue
        }
        guard let store else {
            problems.append("Asset \"\(id)\" is external (\(ref)) and no asset store was given.")
            continue
        }
        do {
            let bytes = try await store.get(ref)
            out[id] = .string("data:image/png;base64,\(bytesToBase64(bytes))")
        } catch {
            problems.append("Asset \"\(id)\" (\(ref)) could not be fetched: \(errorMessage(error))")
        }
    }
    return out
}

// MARK: - The stroke log a save writes

/**
 Which recorded strokes a save writes (`StrokeLogOption`): `.all` the whole stroke log (`true`),
 `.none` none (`false`), or `.replay` only what the colour-scheme replay needs: the log when a pixel
 layer (not a stroke layer) holds a light / dark stroke, else none. In it a stroke also on a stroke
 layer, unchanged, is written as `{ liveStroke: id, layerId }`; loading puts the stroke back.
 */
public enum StrokeLogOption: Sendable, Equatable {
    case all, none, replay
}

/**
 * Whether a save with `option` keeps the stroke log (the whole log, even an empty one): `.all`
 * does, `.none` doesn't, `.replay` only when a pixel layer holds a light / dark stroke
 * (`savesStrokeLog`). Marks of pixels the log doesn't have are only complete next to it.
 */
func savesStrokeLog(_ d: PaintDocumentState, _ option: StrokeLogOption) -> Bool {
    switch option {
    case .all: return true
    case .none: return false
    case .replay: return savedStrokeLog(d, option) != nil
    }
}

/// The stroke log as `option` saves it, or `nil` for none (`savedStrokeLog`).
func savedStrokeLog(_ d: PaintDocumentState, _ option: StrokeLogOption) -> JSONValue? {
    if option == .none || d.strokes.isEmpty { return nil }
    if option == .all { return .array(d.strokes.map(strokeToJSON)) }
    // The stroke layers' strokes as the save writes them (`liveStrokes`).
    var live: [String: [JSONValue]] = [:]
    for (id, list) in d.liveStrokes ?? OrderedMap() where findLayer(d.layers, id) != nil { live[id] = list.map(strokeToJSON) }
    // A replay rebuilds pixel layers only: without a light / dark stroke on one, no replay needs the log.
    let needed = d.strokes.contains { st in st.dualColor != nil && live[st.layerId] == nil && findLayer(d.layers, st.layerId)?.layer.isPixel == true }
    if !needed { return nil }
    var out: [JSONValue] = []
    for st in d.strokes {
        let json = strokeToJSON(st)
        if let list = live[st.layerId], list.first(where: { $0["id"] == .string(st.id) }) == json {
            out.append(["liveStroke": .string(st.id), "layerId": .string(st.layerId)])
        } else {
            out.append(json)
        }
    }
    return .array(out)
}

// MARK: - Stroke data in the asset store

/// Lists a save with an asset store keeps in the store as JSON (`STROKE_DATA_FIELDS`), besides each `liveStrokes` list.
let STROKE_DATA_FIELDS = ["strokes", "wetEvents", "paintEvents"]

/// The most items in one run of a chunked list (`STROKE_CHUNK_SIZE`).
public let STROKE_CHUNK_SIZE = 16

/// Prefix of a stroke data asset id (`STROKE_CHUNK_PREFIX`): `json-<53-bit hash, 14 hex digits>-<text length in base 36>`.
public let STROKE_CHUNK_PREFIX = "json-"

/// Stroke data runs already stored, by store: run id → the store's reference (`storedChunks`).
private let storedChunks = WeakObjectMap<[String: String]>()

/**
 The run lengths a list of `n` items is cut into (`strokeChunkRuns`): full runs of
 `STROKE_CHUNK_SIZE`, then the rest as powers of two, largest first. One more item at the end
 changes only the last run.
 */
public func strokeChunkRuns(_ n: Int) -> [Int] {
    var out = [Int](repeating: STROKE_CHUNK_SIZE, count: n / STROKE_CHUNK_SIZE)
    let rest = n % STROKE_CHUNK_SIZE
    var bit = STROKE_CHUNK_SIZE >> 1
    while bit >= 1 {
        if rest & bit != 0 { out.append(bit) }
        bit >>= 1
    }
    return out
}

/// cyrb53 of a string's UTF-16 code units, as 14 hex digits (`hash53`).
func hash53(_ text: String) -> String {
    var h1: UInt32 = 0xDEAD_BEEF
    var h2: UInt32 = 0x41C6_CE57
    for c in text.utf16 {
        h1 = (h1 ^ UInt32(c)) &* 2_654_435_761
        h2 = (h2 ^ UInt32(c)) &* 1_597_334_677
    }
    h1 = (h1 ^ (h1 >> 16)) &* 2_246_822_507
    h1 ^= (h2 ^ (h2 >> 13)) &* 3_266_489_909
    h2 = (h2 ^ (h2 >> 16)) &* 2_246_822_507
    h2 ^= (h1 ^ (h1 >> 13)) &* 3_266_489_909
    let value: UInt64 = (UInt64(h2 & 0x1F_FFFF) << 32) | UInt64(h1)
    return String(value, radix: 16).leftPad(14)
}

/// The asset id of a run's JSON text, its content address (`strokeChunkId`).
public func strokeChunkId(_ text: String) -> String {
    "\(STROKE_CHUNK_PREFIX)\(hash53(text))-\(String(text.utf16.count, radix: 36))"
}

/// `JSON.stringify` with each object's keys sorted by UTF-16 code units (`canonicalJSON`), so equal items give equal text.
public func canonicalJSON(_ value: JSONValue) -> String {
    switch value {
    case .array(let items):
        return "[" + items.map(canonicalJSON).joined(separator: ",") + "]"
    case .object(let o):
        let keys = o.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
        let parts: [String] = keys.map { (k: String) -> String in
            JSONValue.string(k).stringified() + ":" + canonicalJSON(o[k] ?? .null)
        }
        return "{" + parts.joined(separator: ",") + "}"
    default:
        return value.stringified()
    }
}

/// `list` cut into runs (`strokeChunkRuns`), each put in `store` once as JSON, by content (`externalizeList`).
private func externalizeList(_ list: [JSONValue], _ assets: inout JSONObject, _ store: PaintAssetStore) async throws -> JSONValue {
    var chunks: [JSONValue] = []
    var at = 0
    for n in strokeChunkRuns(list.count) {
        let text = canonicalJSON(.array(Array(list[at..<(at + n)])))
        at += n
        let id = strokeChunkId(text)
        chunks.append(.string(id))
        if jsTruthy(assets[id]) { continue }
        let ref = try await storeRef(storedChunks, store, id, {
            try await store.put(Array(text.utf8), id: id, width: 0, height: 0)
        }, id)
        assets[id] = .string(ref)
    }
    return ["chunks": .array(chunks)]
}

/// `out` with its stroke log, events and stroke layers' strokes put in `store` as chunked lists (`externalizeStrokeData`).
private func externalizeStrokeData(_ out: inout JSONObject, _ assets: inout JSONObject, _ store: PaintAssetStore) async throws {
    for key in STROKE_DATA_FIELDS {
        if let list = out[key]?.arrayValue, !list.isEmpty { out[key] = try await externalizeList(list, &assets, store) }
    }
    if let live = out["liveStrokes"]?.objectValue {
        var next = JSONObject()
        for (id, value) in live {
            if let list = value.arrayValue, !list.isEmpty {
                next[id] = try await externalizeList(list, &assets, store)
            } else {
                next[id] = value
            }
        }
        out["liveStrokes"] = .object(next)
    }
}

/// The chunk ids of a chunked list (`{ chunks: [...] }`), or `nil` when `value` is not one.
private func chunkIds(_ value: JSONValue?) -> [JSONValue]? {
    guard let o = value?.objectValue, let ids = o["chunks"]?.arrayValue else { return nil }
    return ids
}

/// The text of an asset's data URL, whatever media type it is labelled with (`chunkText`).
private func chunkText(_ url: JSONValue?) -> String? {
    guard case .string(let s)? = url, s.hasPrefix("data:"), let parsed = parseDataUrl(s) else { return nil }
    return String(bytes: parsed.bytes, encoding: .utf8)
}

/// The items of a chunked list, its runs read from `assets` in order (`inlineList`); a run that can't be read is reported and left out.
private func inlineList(_ ids: [JSONValue], _ assets: JSONObject, _ problems: inout [String], _ field: String, _ used: inout Set<String>) -> JSONValue {
    var out: [JSONValue] = []
    for idValue in ids {
        if case .string(let id) = idValue, let text = chunkText(assets[id]), let items = (try? JSONValue.parse(text))?.arrayValue {
            used.insert(id)
            out += items
            continue
        }
        let msg = "\"\(field)\" refers to stroke data asset \"\(jsTemplate(idValue))\", which could not be read; what it holds is left out."
        if !problems.contains(msg) { problems.append(msg) }
    }
    return .array(out)
}

/// `r` with its chunked lists (stroke log, events, stroke layers' strokes) read back from `assets` (`inlineStrokeData`).
func inlineStrokeData(_ r: JSONObject, _ assets: JSONObject, _ problems: inout [String], _ used: inout Set<String>) -> JSONObject {
    var out = r
    for key in STROKE_DATA_FIELDS {
        if let ids = chunkIds(out[key]) { out[key] = inlineList(ids, assets, &problems, key, &used) }
    }
    if let live = out["liveStrokes"]?.objectValue, live.contains(where: { chunkIds($0.value) != nil }) {
        var next = JSONObject()
        for (id, value) in live {
            if let ids = chunkIds(value) {
                next[id] = inlineList(ids, assets, &problems, "liveStrokes.\(id)", &used)
            } else {
                next[id] = value
            }
        }
        out["liveStrokes"] = .object(next)
    }
    return out
}

/**
 Records the stroke data runs read from `store` as stored when their text still has the id it was
 saved under (`rememberStrokeChunks`), so the next save to the same store object uploads only runs
 that changed.
 */
func rememberStrokeChunks(_ refs: JSONObject, _ assets: JSONObject, _ store: PaintAssetStore) {
    for (id, value) in refs where id.hasPrefix(STROKE_CHUNK_PREFIX) {
        guard case .string(let ref) = value, !ref.hasPrefix("data:"), let text = chunkText(assets[id]), strokeChunkId(text) == id else { continue }
        storedChunks.with(store, default: { [:] }) { $0[id] = ref }
    }
}

extension PaintEditorController {
    /**
     The document as JSON with each PNG (layers and extension fields alike) stored in `store` once,
     by content (`toJSONExternal`): `assets` maps asset ids to the store's references, and extension
     fields refer to their PNGs as `asset:<id>`. The stroke data (stroke log, wet and paint events,
     stroke layers' strokes) is stored as runs of JSON (`{ chunks: [id] }`, cut by
     `strokeChunkRuns`), so the document stays small and a save after one more stroke stores one
     new run. Reopen it with `loadJSONAsync(_:store:)`.
     */
    public func toJSONExternal(_ store: PaintAssetStore, strokes withStrokes: Bool = true) async throws -> JSONObject {
        try await toJSONExternal(store, strokeLog: withStrokes ? .all : .none)
    }

    /// `toJSONExternal` saving the stroke log as `strokeLog` says (`.replay`: only what the colour-scheme replay needs).
    public func toJSONExternal(_ store: PaintAssetStore, strokeLog: StrokeLogOption) async throws -> JSONObject {
        var out = toJSON(strokeLog: strokeLog)
        var assets = try await externalizeLayerAssets(out["assets"]?.objectValue ?? JSONObject(), store)
        for key in out.keys where !NO_EXTENSION_PNGS.contains(key) {
            out[key] = try await externalizePngs(out[key] ?? .null, &assets, store)
        }
        try await externalizeStrokeData(&out, &assets, store)
        out["assets"] = .object(assets)
        return out
    }
}
