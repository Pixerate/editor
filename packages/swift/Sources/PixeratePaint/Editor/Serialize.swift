import Foundation
import PixerateCore
import PixerateRaster

/**
 * Saved paint documents (`paint-editor/serialize.ts`): JSON plus PNG assets. Layers go through
 * the image editor's layer serializer (pixel layers and groups stored as both editors store them,
 * each pixel layer cropped to its content as a PNG data URL), with the paper as plain settings.
 * `createPaintEditorDocument` wraps it in the `pixerate.editor-document` envelope with every image
 * kept out of the JSON as a content-addressed asset reference (`persistence/assets.ts`).
 */

public let PAINT_FORMAT = "pixerate-paint"
/// 2: recorded strokes keep facet brushes (version 1 documents, with flat engine brushes, still load).
public let PAINT_SCHEMA_VERSION = 2

/// Asset ids → data URLs, as `serializeLayers` collects them.
struct SerializeContext {
    var assets = JSONObject()

    mutating func addAsset(_ url: String, _ hint: String) -> String {
        var id = hint
        var n = 2
        while let existing = assets[id], existing != .string(url) {
            id = "\(hint)-\(n)"
            n += 1
        }
        assets[id] = .string(url)
        return id
    }
}

private let encodedCache = Locked([Int: (url: String, x: Int, y: Int)?]())

/// A surface's pixels over its content as a PNG data URL and where they go, or nil when it is empty.
func encodeSurface(_ surface: TiledSurface) -> (url: String, x: Int, y: Int)? {
    if let hit = encodedCache.with({ $0[surface.id] }) { return hit }
    var out: (url: String, x: Int, y: Int)? = nil
    if let b = contentBounds(surface) {
        let data = readRegion(surface, b)
        out = (pngDataUrl(b.width, b.height, data, surface.channels), b.x, b.y)
    }
    encodedCache.with { cache in
        if cache.count > 256 { cache.removeAll() }
        cache[surface.id] = .some(out)
    }
    return out
}

private func serializeMask(_ mask: RasterMask, _ hint: String, _ ctx: inout SerializeContext) -> JSONObject {
    var out: JSONObject = ["defaultValue": .number(Double(mask.defaultValue))]
    if let source = mask.source {
        out["source"] = source
    } else if let enc = encodeSurface(mask.surface) {
        out["asset"] = .string(ctx.addAsset(enc.url, hint))
        out["x"] = .number(Double(enc.x))
        out["y"] = .number(Double(enc.y))
    }
    if let d = mask.density, d != 1 { out["density"] = .number(d) }
    if let f = mask.feather, f != 0 { out["feather"] = .number(f) }
    if mask.enabled == false { out["enabled"] = false }
    if mask.linked == false { out["linked"] = false }
    return out
}

private func serializeLayer(_ layer: RasterLayer, _ ctx: inout SerializeContext, _ effects: (RasterLayer) -> JSONValue?) -> JSONValue {
    var out: JSONObject = ["id": .string(layer.id), "name": .string(layer.name), "visible": .bool(layer.visible), "opacity": .number(layer.opacity), "blend": .string(layer.blend.rawValue)]
    if layer.clipped { out["clipped"] = true }
    if let mask = layer.mask { out["mask"] = .object(serializeMask(mask, "\(layer.id)-mask", &ctx)) }
    let locks = locksJSON(layer.locks)
    if locks.contains(where: { $0.value == .bool(true) }) { out["locks"] = .object(locks) }
    if let e = effects(layer) { out["effects"] = e }
    if let edge = layer.edge { out["edge"] = edge.json }
    switch layer.content {
    case .pixel(let surface, let offset, let fill):
        out["type"] = "pixel"
        out["offset"] = pointJSON(Double(offset.x), Double(offset.y))
        if let enc = encodeSurface(surface) {
            out["asset"] = .string(ctx.addAsset(enc.url, layer.id))
            out["x"] = .number(Double(enc.x))
            out["y"] = .number(Double(enc.y))
        }
        if let fill, fill != 1 { out["fillOpacity"] = .number(fill) }
    case .group(let children, let collapsed):
        out["type"] = "group"
        out["children"] = .array(children.map { serializeLayer($0, &ctx, effects) })
        if collapsed == true { out["collapsed"] = true }
    }
    return .object(out)
}

/// The layer tree as stored, and its assets (asset id → PNG data URL).
func serializeLayers(_ layers: [RasterLayer], effects: (RasterLayer) -> JSONValue? = { _ in nil }) -> (layers: [JSONValue], assets: JSONObject) {
    var ctx = SerializeContext()
    let out = layers.map { serializeLayer($0, &ctx, effects) }
    return (out, ctx.assets)
}

// MARK: - Asset references (`persistence/assets.ts`)

/// cyrb53: a fast, well-mixed 53-bit string hash (content addressing, not security).
func hash53(_ text: String) -> UInt64 {
    @inline(__always) func imul(_ a: UInt32, _ b: UInt32) -> UInt32 { a &* b }
    var h1: UInt32 = 0xDEAD_BEEF
    var h2: UInt32 = 0x41C6_CE57
    for c in text.utf16 {
        h1 = imul(h1 ^ UInt32(c), 2_654_435_761)
        h2 = imul(h2 ^ UInt32(c), 1_597_334_677)
    }
    h1 = imul(h1 ^ (h1 >> 16), 2_246_822_507) ^ imul(h2 ^ (h2 >> 13), 3_266_489_909)
    h2 = imul(h2 ^ (h2 >> 16), 2_246_822_507) ^ imul(h1 ^ (h1 >> 13), 3_266_489_909)
    return 4_294_967_296 * UInt64(2_097_151 & h2) + UInt64(h1)
}

/// Whether a string is inline binary data worth keeping out of the document.
func isInlineAsset(_ value: String) -> Bool {
    if value.hasPrefix("data:") { return value.utf16.count >= 512 }
    return value.utf16.count >= 4096 && value.range(of: "^[A-Za-z0-9+/=\\r\\n]+$", options: .regularExpression) != nil
}

/// Inline binary data kept out of an editor document: `put` returns the content's reference.
final class EditorAssetRegistry {
    private var byRef: [String: String] = [:]
    private var byData: [String: String] = [:]

    func put(_ data: String) -> String {
        if let known = byData[data] { return known }
        let base = "pixerate-asset:\(String(data.utf16.count, radix: 36))-\(String(hash53(data), radix: 36))"
        var ref = base
        var n = 1
        while let existing = byRef[ref], existing != data {
            ref = "\(base)~\(n)"
            n += 1
        }
        byRef[ref] = data
        byData[data] = ref
        return ref
    }
}

/// A copy of `value` with every inline asset string replaced by its reference.
func externalizeAssets(_ value: JSONValue, _ registry: EditorAssetRegistry) -> JSONValue {
    switch value {
    case .string(let s): return isInlineAsset(s) ? .string(registry.put(s)) : value
    case .array(let a): return .array(a.map { externalizeAssets($0, registry) })
    case .object(let o):
        var out = JSONObject()
        for (k, v) in o { out[k] = externalizeAssets(v, registry) }
        return .object(out)
    default: return value
    }
}
