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

extension PaintEditorController {
    /**
     The document as JSON with each PNG (layers and extension fields alike) stored in `store` once,
     by content (`toJSONExternal`): `assets` maps asset ids to the store's references, and extension
     fields refer to their PNGs as `asset:<id>`. Reopen it with `loadJSONAsync(_:store:)`.
     */
    public func toJSONExternal(_ store: PaintAssetStore, strokes withStrokes: Bool = true) async throws -> JSONObject {
        var out = toJSON(strokes: withStrokes)
        var assets = try await externalizeLayerAssets(out["assets"]?.objectValue ?? JSONObject(), store)
        for key in out.keys where !NO_EXTENSION_PNGS.contains(key) {
            out[key] = try await externalizePngs(out[key] ?? .null, &assets, store)
        }
        out["assets"] = .object(assets)
        return out
    }
}
