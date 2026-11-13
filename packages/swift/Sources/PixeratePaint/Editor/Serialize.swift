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

private let deepCache = Locked([Int: JSONValue?]())

/**
 * A deep (16- or 32-bit) surface's samples over its content (`encodeDeepSurface`): `{ depth, x, y,
 * width, height, data }`, little-endian samples deflated and base64-encoded; nil for 8-bit surfaces.
 */
func encodeDeepSurface(_ surface: TiledSurface) -> JSONValue? {
    if let hit = deepCache.with({ $0[surface.id] }) { return hit }
    var out: JSONValue? = nil
    let depth = surfaceDepth(surface)
    if depth != 8, let b = contentBounds(surface) {
        var bytes: [UInt8] = []
        switch readDeepRegion(surface, b, depth) {
        case .u16(let samples):
            bytes.reserveCapacity(samples.count * 2)
            for v in samples { bytes.append(UInt8(v & 0xFF)); bytes.append(UInt8(v >> 8)) }
        case .f32(let samples):
            bytes.reserveCapacity(samples.count * 4)
            for v in samples {
                let bits = v.bitPattern
                bytes.append(UInt8(bits & 0xFF)); bytes.append(UInt8((bits >> 8) & 0xFF)); bytes.append(UInt8((bits >> 16) & 0xFF)); bytes.append(UInt8(bits >> 24))
            }
        }
        let o: JSONObject = ["depth": .number(Double(depth)), "x": .number(Double(b.x)), "y": .number(Double(b.y)), "width": .number(Double(b.width)), "height": .number(Double(b.height)), "data": .string(bytesToBase64(deflate(bytes)))]
        out = .object(o)
    }
    deepCache.with { cache in
        if cache.count > 64 { cache.removeAll() }
        cache[surface.id] = .some(out)
    }
    return out
}

private func serializeMask(_ mask: RasterMask, _ hint: String, _ ctx: inout SerializeContext) -> JSONObject {
    var out: JSONObject = ["defaultValue": .number(Double(mask.defaultValue))]
    if let source = mask.source {
        out["source"] = source
    } else {
        if let enc = encodeSurface(mask.surface) {
            out["asset"] = .string(ctx.addAsset(enc.url, hint))
            out["x"] = .number(Double(enc.x))
            out["y"] = .number(Double(enc.y))
        }
        if let deep = encodeDeepSurface(mask.surface) { out["deep"] = deep }
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
    if let e = layer.effects { out["effects"] = serializeEffects(e) } else if let e = effects(layer) { out["effects"] = e }
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
        if let generator = layer.generator { out["generator"] = .object(generator) }
        if let deep = encodeDeepSurface(surface) { out["deep"] = deep }
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
