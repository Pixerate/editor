import Foundation
import PixerateCore
import PixerateRaster

/**
 * Reading saved paint documents (`paint-editor/serialize.ts` `deserializePaintDocument`, and the
 * pixel and group layers of `image-editor/layers/serialize.ts` `deserializeLayers`). Layers, masks
 * and effects are read leniently: what cannot be read is dropped and reported in `problems`, with
 * the TS core's wording, and the rest still loads.
 */

/// What `deserializePaintDocument` read: the document and the fields the controller reads itself.
struct LoadedPaintDocument {
    var state: PaintDocumentState
    /// Top-level fields this reader does not know, kept and written back (`documentExtensions`).
    var extensions: JSONObject
    var guides: JSONValue?
    var swatches: JSONValue?
    var mixingPad: JSONValue?
    var wet: JSONValue?
    var problems: [String]
}

/// Fields `readDocument` reads itself; every other top-level field is an extension.
private let KNOWN_FIELDS: Set<String> = ["format", "version", "width", "height", "dpi", "paper", "layers", "assets", "activeLayerId", "strokes", "guides", "swatches", "mixingPad", "wet", "wetEvents", "paintEvents", "origin"]

/// Top-level fields with no PNGs of their own (`NO_EXTENSION_PNGS`): the rest may refer to `asset:<id>`.
let NO_EXTENSION_PNGS: Set<String> = ["format", "version", "width", "height", "dpi", "paper", "layers", "assets", "activeLayerId", "strokes", "wetEvents", "paintEvents", "origin"]

/// How an extension field refers to a PNG in `assets` (`EXTENSION_ASSET_REF`).
let EXTENSION_ASSET_REF = "asset:"

/// A value as JavaScript's template literals print it (`${value}`), for messages.
func jsTemplate(_ v: JSONValue?) -> String {
    switch v {
    case nil: return "undefined"
    case .null?: return "null"
    case .string(let s)?: return s
    case .bool(let b)?: return b ? "true" : "false"
    case .number(let n)?: return jsText(n)
    case .array(let a)?: return a.map { $0 == .null ? "" : jsTemplate($0) }.joined(separator: ",")
    case .object?: return "[object Object]"
    }
}

/// JavaScript truthiness of a saved value (`if (r.deep)`); a missing value is falsy.
func jsTruthy(_ v: JSONValue?) -> Bool {
    switch v {
    case nil, .null?: return false
    case .bool(let b)?: return b
    case .number(let n)?: return n != 0 && !n.isNaN
    case .string(let s)?: return !s.isEmpty
    case .array?, .object?: return true
    }
}

/// `JSON.stringify(value)` for messages (`undefined` when missing).
func jsStringify(_ v: JSONValue?) -> String { v.map { $0.stringified() } ?? "undefined" }

/// `num`: a finite number clamped to lo...hi, else the fallback.
private func num(_ v: JSONValue?, _ lo: Double, _ hi: Double, _ fallback: Double) -> Double {
    if case .number(let n)? = v, n.isFinite { return Swift.min(hi, Swift.max(lo, n)) }
    return fallback
}

/// Decodes a PNG data URL into pixels of `channels` bytes each (`decodePngDataUrl`).
func decodePngDataUrl(_ url: String, channels: Int) throws -> (width: Int, height: Int, data: [UInt8]) {
    guard let parsed = parseDataUrl(url) else { throw PngError("Asset is not a data URL.") }
    let png = try decodePng(parsed.bytes, keepGray: channels == 1)
    if png.channels == channels { return (png.width, png.height, png.data) }
    if channels == 1 {
        // An RGBA PNG used as a mask: its luminance, alpha-weighted.
        var out = [UInt8](repeating: 0, count: png.width * png.height)
        var i = 0
        for p in 0..<out.count {
            let lum = 0.299 * Double(png.data[i]) + 0.587 * Double(png.data[i + 1]) + 0.114 * Double(png.data[i + 2])
            out[p] = UInt8(clamping: Int(JS.round(lum * Double(png.data[i + 3]) / 255)))
            i += 4
        }
        return (png.width, png.height, out)
    }
    var out = [UInt8](repeating: 0, count: png.width * png.height * 4)
    for p in 0..<(png.width * png.height) {
        out[p * 4] = png.data[p]
        out[p * 4 + 1] = png.data[p]
        out[p * 4 + 2] = png.data[p]
        out[p * 4 + 3] = 255
    }
    return (png.width, png.height, out)
}

/// Reading context: the assets (id → PNG data URL) and the problems found so far.
struct LayerReadContext {
    var assets: JSONObject
    var problems: [String] = []
    /// What `paintLayersOnly` reports, in tree order: it runs after every layer is read, so these follow `problems`.
    var paintOnly: [String] = []
}

private func readSurface(_ ref: JSONValue?, _ x: JSONValue?, _ y: JSONValue?, channels: Int, defaultValue: Int, _ ctx: inout LayerReadContext, _ what: String) -> TiledSurface {
    guard case .string(let id)? = ref, !id.isEmpty else { return emptySurface(channels, defaultValue) }
    guard case .string(let url)? = ctx.assets[id] else {
        ctx.problems.append("\(what): asset \"\(id)\" is missing")
        return emptySurface(channels, defaultValue)
    }
    do {
        let px = try decodePngDataUrl(url, channels: channels)
        let left = Int(JS.round(num(x, -1e7, 1e7, 0)))
        let top = Int(JS.round(num(y, -1e7, 1e7, 0)))
        // `surfaceFromSavedPixels`: a layer past the surface range is refused (#852).
        if px.width > 0 && px.height > 0 {
            try checkSurfaceRange(x: Double(left), xEnd: Double(left + px.width), y: Double(top), yEnd: Double(top + px.height))
        }
        return surfaceFromPixels(width: px.width, height: px.height, data: px.data, channels: channels, x: left, y: top, defaultValue: defaultValue)
    } catch {
        ctx.problems.append("\(what): asset \"\(id)\" could not be decoded (\(errorMessage(error)))")
        return emptySurface(channels, defaultValue)
    }
}

/// An error's message as the TS core shows `(e as Error).message`.
func errorMessage(_ e: Error) -> String {
    if let p = e as? PngError { return p.message }
    if let p = e as? PaintEditorError { return p.message }
    if let c = e as? CustomStringConvertible { return c.description }
    return e.localizedDescription
}

/// The default values of a parametric depth mask (`DEFAULT_DEPTH_MASK_VALUES`).
private let DEFAULT_DEPTH_MASK_VALUES: JSONObject = ["enabled": false, "maskSource": .null, "mode": "threshold", "depthRange": [0, 255], "softness": 10, "invert": false]

private func readMask(_ raw: JSONValue?, _ ctx: inout LayerReadContext, _ what: String) -> RasterMask? {
    guard let r = raw?.objectValue else { return nil }
    let defaultValue = r["defaultValue"] == .number(255) ? 255 : 0
    let source = r["source"].flatMap { v -> JSONValue? in
        switch v {
        case .null, .bool(false), .number(0): return nil
        case .string(let s) where s.isEmpty: return nil
        default: return v
        }
    }
    var mask = RasterMask(
        surface: source != nil ? emptySurface(1, 255) : readSurface(r["asset"], r["x"], r["y"], channels: 1, defaultValue: defaultValue, &ctx, "\(what) mask"),
        defaultValue: source != nil ? 255 : defaultValue
    )
    if case .number(let d)? = r["density"], d != 1 { mask.density = num(r["density"], 0, 1, 1) }
    if case .number(let f)? = r["feather"], f > 0 { mask.feather = num(r["feather"], 0, 1000, 0) }
    if r["enabled"] == .bool(false) { mask.enabled = false }
    if r["linked"] == .bool(false) { mask.linked = false }
    if jsTruthy(r["deep"]) && source == nil { mask.surface = decodeDeepSurface(mask.surface, r["deep"], &ctx.problems, "\(what) mask") }
    if let s = source?.objectValue {
        var merged = DEFAULT_DEPTH_MASK_VALUES
        for (k, v) in s { merged[k] = v }
        mask.source = .object(merged)
    }
    return mask
}

/// Stored edge colour, amounts clamped to 0..1 (`readEdgeColor`); nil when nothing is on.
private func readEdgeColor(_ raw: JSONValue?) -> LayerEdgeColor? {
    guard let r = raw?.objectValue else { return nil }
    var out = LayerEdgeColor()
    func amount(_ k: String) -> Double? {
        if case .number(let v)? = r[k], v.isFinite, v > 0 { return Swift.min(1, v) }
        return nil
    }
    out.decontaminate = amount("decontaminate")
    out.despill = amount("despill")
    out.ambient = amount("ambient")
    if let c = r["ambientColor"]?.arrayValue, c.count == 3, c.allSatisfy({ ($0.numberValue ?? .nan).isFinite }) {
        out.ambientColor = c.map { Swift.min(255, Swift.max(0, JS.round($0.numberValue!))) }
    }
    return out.decontaminate != nil || out.despill != nil || out.ambient != nil || out.ambientColor != nil ? out : nil
}

/// Stored effects, read leniently (`deserializeEffects`).
private func deserializeEffects(_ raw: JSONValue?) -> LayerEffects? {
    guard let r = raw?.objectValue else { return nil }
    var psd: EffectsPsdBlock?
    if let p = r["psd"]?.objectValue, let key = p["key"]?.stringValue, let data = p["data"]?.stringValue {
        psd = (try? base64ToBytes(data)).map { EffectsPsdBlock(key: key, data: $0) }
    }
    return normalizeLayerEffects(.object(r.without("psd")), psd: psd)
}

/// The image editor's layer kinds the paint editor does not have.
private let IMAGE_ONLY_TYPES: Set<String> = ["adjustment", "smart"]

/// The adjustment layer kinds the image editor reads (`ADJUSTMENT_KINDS`).
private let ADJUSTMENT_KINDS: Set<String> = ["curves", "levels", "hueSaturation", "vibrance", "colorBalance", "blackWhite", "photoFilter", "invert", "posterize", "threshold"]

/// The longest effect animation a layer keeps, in milliseconds (`MAX_EFFECT_ANIMATION_MS`).
private let MAX_EFFECT_ANIMATION_MS = 60_000.0

/// A value an effect takes (`isEffectValue`): a string, boolean, finite number or list of finite numbers.
private func isEffectValue(_ v: JSONValue) -> Bool {
    switch v {
    case .string, .bool: return true
    case .number(let n): return n.isFinite
    case .array(let a): return a.allSatisfy { ($0.numberValue ?? .nan).isFinite }
    default: return false
    }
}

/// A pixel layer's effect generator as the image editor reads it (`readEffectRef` plus `time` and `animate`), or nil.
func readGenerator(_ raw: JSONValue?) -> JSONObject? {
    guard let r = raw?.objectValue, case .string(let effect)? = r["effect"], !effect.isEmpty else { return nil }
    var values = JSONObject()
    if let v = r["values"]?.objectValue { for (k, x) in v where isEffectValue(x) { values[k] = x } }
    // `Object.entries` of an array: its indices.
    if let list = r["values"]?.arrayValue { for (i, x) in list.enumerated() where isEffectValue(x) { values[String(i)] = x } }
    var out: JSONObject = ["effect": .string(effect)]
    if case .string? = r["provider"] { out["provider"] = r["provider"] }
    if case .string? = r["name"] { out["name"] = r["name"] }
    out["values"] = .object(values)
    if case .number(let t)? = r["time"], t > 0 { out["time"] = .number(t) }
    if case .number(let d)? = r["animate"]?.objectValue?["duration"], d.isFinite, d > 0 { out["animate"] = ["duration": .number(Swift.min(d, MAX_EFFECT_ANIMATION_MS))] }
    return out
}

/**
 * Puts saved deep (16- or 32-bit) samples into `surface`, the 8-bit rendering read from the PNG
 * (`decodeDeepSurface`): `{ depth, x, y, width, height, data }`, little-endian samples deflated
 * and base64-encoded. Data that cannot be read leaves the surface 8-bit and is reported.
 */
func decodeDeepSurface(_ surface: TiledSurface, _ raw: JSONValue?, _ problems: inout [String], _ label: String) -> TiledSurface {
    // `!d || typeof d !== 'object'`: an array is an object too (and has no depth).
    let d: JSONObject
    switch raw {
    case .object(let o)?: d = o
    case .array?: d = [:]
    default: return surface
    }
    do {
        // `d.width > 0 && d.height > 0` compare numbers, so a text, boolean or one-element-array size passes.
        guard case .number(let depthValue)? = d["depth"], depthValue == 16 || depthValue == 32,
              let rawWidth = d["width"], let rawHeight = d["height"],
              jsToNumber(rawWidth) > 0, jsToNumber(rawHeight) > 0,
              case .number(let x)? = d["x"], x.isFinite, x.rounded(.towardZero) == x,
              case .number(let y)? = d["y"], y.isFinite, y.rounded(.towardZero) == y,
              case .string(let text)? = d["data"]
        else { throw PaintEditorError("malformed") }
        let width = jsToNumber(rawWidth), height = jsToNumber(rawHeight)
        let channels = Double(surface.channels)
        let n: Double = width * height * channels
        let size = depthValue == 16 ? 2 : 4
        let byteCount: Double = n * Double(size)
        // Only a whole sample count can match the inflated length and read every sample (`getUint16` /
        // `getFloat32` past the end throws for a fractional one).
        guard n.rounded(.towardZero) == n, byteCount <= 9_007_199_254_740_992 else { throw PaintEditorError("wrong length") }
        let bytes = try inflate(try base64ToBytes(text), maxOutput: Int(byteCount))
        if Double(bytes.count) != byteCount { throw PaintEditorError("wrong length") }
        let count = Int(n)
        let samples: DeepSamples
        if size == 2 {
            samples = .u16((0 ..< count).map { (i: Int) -> UInt16 in
                let lo: UInt16 = UInt16(bytes[2 * i])
                let hi: UInt16 = UInt16(bytes[2 * i + 1])
                return lo | (hi << 8)
            })
        } else {
            // Typed steps: one long `|`/`<<` chain hits the type-checker time limit on CI.
            samples = .f32((0 ..< count).map { (i: Int) -> Float in
                let b0: UInt32 = UInt32(bytes[4 * i])
                let b1: UInt32 = UInt32(bytes[4 * i + 1]) << 8
                let b2: UInt32 = UInt32(bytes[4 * i + 2]) << 16
                let b3: UInt32 = UInt32(bytes[4 * i + 3]) << 24
                return Float(bitPattern: b0 | b1 | b2 | b3)
            })
        }
        // `{ x: d.x, y: d.y, width: d.width, height: d.height }` as `writeDeepRegion` reads it.
        let xEnd = jsPlus(x, rawWidth)
        let yEnd = jsPlus(y, rawHeight)
        return try writeDeepRegionUnchecked(surface, x: x, y: y, width: width, height: height, xEnd: xEnd, yEnd: yEnd, samples)
    } catch {
        problems.append("\(label): its \(jsTemplate(d["depth"]))-bit samples could not be read, so it was opened at 8 bits")
        return surface
    }
}

/// `x + v` for a number `x` and a saved value: a string or array concatenates (`6 + "2"` is `"62"`), read back as `Number()`.
private func jsPlus(_ x: Double, _ v: JSONValue) -> Double {
    switch v {
    case .string, .array, .object: return (jsText(x) + jsTemplate(v)).jsToNumber
    default: return x + jsToNumber(v)
    }
}

/// A stored layer (`deserializeLayer`), keeping the paint editor's kinds (`paintLayersOnly`).
/// Throws where the TS core's reading throws (an annotation the image editor cannot migrate).
private func deserializeLayer(_ raw: JSONValue, _ ctx: inout LayerReadContext) throws -> PaintLayer? {
    guard let r = raw.objectValue else { return nil }
    let id: String = { if case .string(let s)? = r["id"], !s.isEmpty { return s }; return newPaintLayerId() }()
    let name = r["name"]?.stringValue ?? ""
    let label = "Layer \"\(name.isEmpty ? id : name)\""
    let edge = readEdgeColor(r["edge"])
    let mask = readMask(r["mask"], &ctx, label)
    var vectorMask: JSONObject?
    if let vm = r["vectorMask"], vm.objectValue != nil || vm.arrayValue != nil, r["type"] != .string("shape") {
        do {
            vectorMask = try readVectorMask(vm)
        } catch {
            ctx.problems.append("The vector mask of layer \"\(name.isEmpty ? id : name)\" could not be read (\(errorMessage(error))); it was left out.")
        }
    }
    var locks: LayerLocks?
    if let l = r["locks"]?.objectValue {
        var out = LayerLocks()
        if l["pixels"] == .bool(true) { out.pixels = true }
        if l["transparency"] == .bool(true) { out.transparency = true }
        if l["position"] == .bool(true) { out.position = true }
        if l["all"] == .bool(true) { out.all = true }
        if out != LayerLocks() { locks = out }
    }
    let effects = r["type"] == .string("adjustment") ? nil : deserializeEffects(r["effects"])
    let visible = r["visible"] != .bool(false)
    let opacity = num(r["opacity"], 0, 1, 1)
    let clipped = r["clipped"] == .bool(true)
    let type = r["type"]?.stringValue
    switch type {
    case "pixel":
        let isDocumentSource = r["source"] == .string("document")
        var surface = isDocumentSource ? emptySurface(4) : readSurface(r["asset"], r["x"], r["y"], channels: 4, defaultValue: 0, &ctx, label)
        if !isDocumentSource && jsTruthy(r["deep"]) { surface = decodeDeepSurface(surface, r["deep"], &ctx.problems, label) }
        let offset = r["offset"]?.objectValue
        var fill: Double?
        if case .number(let f)? = r["fillOpacity"], f != 1 { fill = num(r["fillOpacity"], 0, 1, 1) }
        if let filters = r["filters"]?.arrayValue, filters.contains(where: { o in
            guard let k = o.objectValue?["kind"]?.stringValue else { return false }
            return k == "blur" || k == "develop"
        }) {
            ctx.paintOnly.append("Layer \"\(name)\": its filters are an image editor feature and were dropped.")
        }
        if isDocumentSource { ctx.paintOnly.append("Layer \"\(name)\" refers to an image editor source image; it loads empty.") }
        return RasterLayer(
            id: id, name: name, visible: visible, opacity: opacity, blend: .mode(normalizeBlendMode(r["blend"]?.stringValue)), clipped: clipped,
            mask: mask, locks: locks, effects: effects, edge: edge, generator: readGenerator(r["generator"]), vectorMask: vectorMask,
            content: .pixel(surface: surface, offset: LayerOffset(x: Int(JS.round(num(offset?["x"], -1e7, 1e7, 0))), y: Int(JS.round(num(offset?["y"], -1e7, 1e7, 0)))), fillOpacity: fill)
        )
    case "group":
        let children = try (r["children"]?.arrayValue ?? []).compactMap { try deserializeLayer($0, &ctx) }
        let b = r["blend"]?.stringValue
        let blend: GroupBlendMode = b == "pass-through" ? .passThrough : isBlendMode(b) ? .mode(normalizeBlendMode(b)) : .passThrough
        return RasterLayer(
            id: id, name: name, visible: visible, opacity: opacity, blend: blend, clipped: clipped, mask: mask, locks: locks, effects: effects, edge: edge, vectorMask: vectorMask,
            content: .group(children: children, collapsed: r["collapsed"] == .bool(true) ? true : nil)
        )
    case "adjustment" where !(r["kind"]?.stringValue.map(ADJUSTMENT_KINDS.contains) ?? false):
        // `normalizeAdjustmentLayer` refuses a kind it does not know before `paintLayersOnly` sees the layer.
        ctx.problems.append("\(label): unknown adjustment kind \"\(jsTemplate(r["kind"]))\"")
        return nil
    case "annotation":
        guard let a = r["annotation"]?.objectValue, case .string? = a["type"] else {
            ctx.problems.append("\(label): annotation is missing")
            return nil
        }
        // Pen, rectangle, ellipse, line, arrow and text annotations load as shape and type layers (`annotationLayerFor`);
        // one whose fields can't be drawn (a pen without points, a text that is not a string) is left out.
        let migrated: String
        do {
            migrated = try migratedAnnotationType(a)
        } catch {
            ctx.problems.append("\(label): the annotation could not be read (\(errorMessage(error)))")
            return nil
        }
        ctx.paintOnly.append("Layer \"\(name)\" is an image editor \(migrated) layer, which the paint editor does not have; it was left out.")
        return nil
    case "shape":
        if let problem = shapeLayerProblem(r) {
            ctx.problems.append("\(label): the shape could not be read (\(problem))")
            return nil
        }
        ctx.paintOnly.append("Layer \"\(name)\" is an image editor shape layer, which the paint editor does not have; it was left out.")
        return nil
    case "type":
        if let problem = typeLayerProblem(r) {
            ctx.problems.append("\(label): the text could not be read (\(problem))")
            return nil
        }
        // Its stored pixels are read (and reported) before the paint editor leaves it out.
        if case .string? = r["asset"] { _ = readSurface(r["asset"], r["x"], r["y"], channels: 4, defaultValue: 0, &ctx, label) }
        ctx.paintOnly.append("Layer \"\(name)\" is an image editor type layer, which the paint editor does not have; it was left out.")
        return nil
    case "smart":
        // A paint document has no smart object contents table, so `readContents` finds none.
        if case .string(let contents)? = r["contents"] { ctx.problems.append("Smart object contents \"\(contents)\" are missing") }
        ctx.problems.append("\(label): its smart object contents are missing; the layer was dropped")
        return nil
    default:
        if let type, IMAGE_ONLY_TYPES.contains(type) {
            ctx.paintOnly.append("Layer \"\(name)\" is an image editor \(type) layer, which the paint editor does not have; it was left out.")
        } else {
            ctx.problems.append("\(label): unknown layer type \"\(jsTemplate(r["type"]))\"")
        }
        return nil
    }
}

/// A stored layer tree (`deserializeLayers` + `paintLayersOnly`); repeated ids get new ones.
func deserializePaintLayers(_ raw: JSONValue?, _ ctx: inout LayerReadContext) throws -> [PaintLayer] {
    guard let list = raw?.arrayValue else { return [] }
    var seen = Set<String>()
    func dedupe(_ layers: [PaintLayer]) -> [PaintLayer] {
        layers.map { l in
            var next = l
            if seen.contains(l.id) {
                next = RasterLayer(id: newPaintLayerId(), name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, clipped: l.clipped, mask: l.mask, locks: l.locks, effects: l.effects, edge: l.edge, temporary: l.temporary, generator: l.generator, vectorMask: l.vectorMask, content: l.content)
            }
            seen.insert(next.id)
            if let children = next.children { next = next.withChildren(dedupe(children)) }
            return next
        }
    }
    let out = dedupe(try list.compactMap { try deserializeLayer($0, &ctx) })
    ctx.problems += ctx.paintOnly
    ctx.paintOnly = []
    return out
}

/// `value` with each `asset:<id>` string replaced by that asset's data URL (`inlinePngs`); the ids used go in `used`.
private func inlinePngs(_ value: JSONValue, _ assets: JSONObject, _ problems: inout [String], _ field: String, _ used: inout Set<String>) -> JSONValue {
    switch value {
    case .string(let s) where s.hasPrefix(EXTENSION_ASSET_REF):
        let id = String(s.dropFirst(EXTENSION_ASSET_REF.count))
        if case .string(let url)? = assets[id], url.hasPrefix("data:") {
            used.insert(id)
            return .string(url)
        }
        let msg = "\"\(field)\" refers to asset \"\(id)\", which could not be read; that part loads empty."
        if !problems.contains(msg) { problems.append(msg) }
        return value
    case .array(let a):
        return .array(a.map { inlinePngs($0, assets, &problems, field, &used) })
    case .object(let o):
        var out = JSONObject()
        for (k, v) in o { out[k] = inlinePngs(v, assets, &problems, field, &used) }
        return .object(out)
    default:
        return value
    }
}

/// Whether `s` is a stroke log entry referring to a stroke layer's stroke (`isStrokeLogReference`).
private func isStrokeLogReference(_ s: JSONValue) -> Bool {
    guard let o = s.objectValue, o["liveStroke"]?.stringValue != nil, o["layerId"]?.stringValue != nil else { return false }
    return !o.contains("points")
}

/**
 `strokes` with each `{ liveStroke, layerId }` replaced by that stroke from `liveStrokes`
 (`resolveStrokeLog`); one that is not there is reported and left out.
 */
private func resolveStrokeLog(_ strokes: JSONValue, _ liveStrokes: JSONValue?, _ problems: inout [String]) -> JSONValue {
    guard let list = strokes.arrayValue, list.contains(where: isStrokeLogReference) else { return strokes }
    let live = liveStrokes?.objectValue ?? JSONObject()
    var out: [JSONValue] = []
    for (i, s) in list.enumerated() {
        guard isStrokeLogReference(s), let id = s["liveStroke"]?.stringValue, let layerId = s["layerId"]?.stringValue else {
            out.append(s)
            continue
        }
        if let found = live[layerId]?.arrayValue?.first(where: { $0.objectValue?["id"] == .string(id) }) {
            out.append(found)
        } else {
            problems.append("strokes[\(i)] refers to stroke \"\(id)\" of stroke layer \"\(layerId)\", which the document does not have; skipped.")
        }
    }
    return .array(out)
}

/// Reads a saved document with inline assets (`deserializePaintDocument`). Throws when it is not a paint document at all.
func deserializePaintDocument(_ raw: JSONValue) throws -> LoadedPaintDocument {
    guard let r = raw.objectValue else { throw PaintEditorError("Not a paint document: expected a JSON object.") }
    if r["format"] != .string(PAINT_FORMAT) { throw PaintEditorError("Not a paint document: format is \(jsStringify(r["format"])), expected \"\(PAINT_FORMAT)\".") }
    guard case .number(let version)? = r["version"], version <= Double(PAINT_SCHEMA_VERSION) else {
        throw PaintEditorError("Paint document version \(jsStringify(r["version"])) is newer than this editor reads (\(PAINT_SCHEMA_VERSION)); update @pixerate/editor.")
    }
    var problems: [String] = []
    let rawAssets = r["assets"]?.objectValue ?? JSONObject()
    var used = Set<String>()
    // Stroke data saved with an asset store is in runs of JSON (`{ chunks }`): the lists come back first.
    let unchunked = inlineStrokeData(r, rawAssets, &problems, &used)
    var inlined = JSONObject()
    for (k, v) in unchunked { inlined[k] = NO_EXTENSION_PNGS.contains(k) ? v : inlinePngs(v, rawAssets, &problems, k, &used) }
    // A log saved with `.replay` refers to strokes kept on stroke layers.
    if let strokes = inlined["strokes"] { inlined["strokes"] = resolveStrokeLog(strokes, inlined["liveStrokes"], &problems) }
    var assets = JSONObject()
    for (id, v) in rawAssets where !used.contains(id) { assets[id] = v }
    return try readDocument(inlined, assets, problems)
}

private func readDocument(_ r: JSONObject, _ assets: JSONObject, _ problemsIn: [String]) throws -> LoadedPaintDocument {
    var ctx = LayerReadContext(assets: assets, problems: problemsIn)
    let canvas = try normalizeCanvas(width: r["width"]?.numberValue, height: r["height"]?.numberValue, dpi: r["dpi"]?.numberValue)
    let paper = normalizePaper(r["paper"]?.objectValue ?? JSONObject())
    let layers = try deserializePaintLayers(r["layers"], &ctx)
    var problems = ctx.problems
    let pixelIds = flattenLayers(layers).filter(\.isPixel).map(\.id)
    let activeLayerId: String? = {
        if case .string(let wanted)? = r["activeLayerId"], findLayer(layers, wanted) != nil { return wanted }
        return pixelIds.last
    }()
    var strokes: [RecordedStroke] = []
    if let list = r["strokes"]?.arrayValue {
        for (i, s) in list.enumerated() {
            if let stroke = normalizeBrushStroke(s) { strokes.append(stroke) } else { problems.append("strokes[\(i)] is not a recorded stroke; skipped.") }
        }
    }
    let state = PaintDocumentState(canvas: canvas, paper: paper, layers: layers, activeLayerId: activeLayerId, strokes: strokes)
    let wetEvents = (r["wetEvents"]?.arrayValue ?? []).compactMap(WetEvent.init(json:))
    if !wetEvents.isEmpty { state.wetEvents = wetEvents }
    let paintEvents = (r["paintEvents"]?.arrayValue ?? []).compactMap(PaintEvent.init(json:))
    if !paintEvents.isEmpty { state.paintEvents = paintEvents }
    if let raw = r["cultures"] {
        let parsed = culturesExtensionFromJSON(raw, validLayerIds: Set(pixelIds), problems: &problems)
        if let c = parsed.cultures { state.cultures = c }
        if let g = parsed.growWhileClosed { state.growWhileClosed = g }
        if let t = parsed.lastGrownAt { state.lastGrownAt = t }
    }
    if let o = r["origin"]?.objectValue, case .number(let x)? = o["x"], case .number(let y)? = o["y"], x.isFinite, y.isFinite, x != 0 || y != 0 {
        state.origin = LayerOffset(x: Int(JS.round(x)), y: Int(JS.round(y)))
    }
    var extensions = JSONObject()
    for (k, v) in r where !KNOWN_FIELDS.contains(k) { extensions[k] = v }
    return LoadedPaintDocument(state: state, extensions: extensions, guides: r["guides"], swatches: r["swatches"], mixingPad: r["mixingPad"], wet: r["wet"], problems: problems)
}
