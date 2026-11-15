import Foundation
import PixerateCore
import PixerateRaster

/// The most pixels per side of an imported image.
public let MAX_IMAGE_SIDE = 8192

/// RGBA pixels of an image.
public struct PixelImage {
    public var width: Int
    public var height: Int
    public var data: [UInt8]
}

/// The tracing image and reference images (`controller.ts`, guides section): editor state, not undo steps.
extension PaintEditorController {
    /// An image from a PNG (base64 or data URL), stored as a PNG data URL.
    private func importImage(_ png: String?, _ what: String) throws -> (src: String, pixels: PixelImage) {
        guard let png = png?.trimmingCharacters(in: .whitespacesAndNewlines), !png.isEmpty else { throw PaintEditorError("\(what): pass png (a PNG as base64 or a data URL) or pixels.") }
        let pixels = try decodeImage(png.hasPrefix("data:") ? png : "data:image/png;base64,\(png)", what)
        if pixels.width > MAX_IMAGE_SIDE || pixels.height > MAX_IMAGE_SIDE { throw PaintEditorError("\(what) is \(pixels.width)×\(pixels.height); the limit is \(MAX_IMAGE_SIDE) px per side.") }
        return (pngDataUrl(pixels.width, pixels.height, pixels.data), pixels)
    }

    func decodeImage(_ src: String, _ what: String = "Image") throws -> PixelImage {
        guard let parsed = parseDataUrl(src) else { throw PaintEditorError("\(what) is not a data URL or base64 PNG.") }
        do {
            let png = try decodePng(parsed.bytes)
            return PixelImage(width: png.width, height: png.height, data: png.data)
        } catch {
            throw PaintEditorError("\(what) could not be decoded as a PNG (\(error)); decode other formats in the browser and pass pixels.")
        }
    }

    /**
     * Places an image (a photo to paint over, a scan, a reference) on a new pixel layer above the
     * active one (or `aboveId`), scaled to fit the canvas (`contain`, the default) or fill it
     * (`cover`), centred. Its pixels become ordinary paint on that layer. One undo step.
     */
    public func placeImage(png: String?, name: String? = nil, fit fitIn: String? = nil, aboveId: String? = nil) throws -> PaintLayerInfo {
        let fit = fitIn ?? "contain"
        if fit != "contain" && fit != "cover" { throw PaintEditorError("fit \"\(fit)\" is not one of contain, cover.") }
        let (_, pixels) = try importImage(png, "The image")
        let width = doc.canvas.width, height = doc.canvas.height
        let kx = Double(width) / Double(pixels.width), ky = Double(height) / Double(pixels.height)
        let k = fit == "cover" ? Swift.max(kx, ky) : Swift.min(kx, ky)
        let w = Swift.max(1, Int(JS.round(Double(pixels.width) * k)))
        let h = Swift.max(1, Int(JS.round(Double(pixels.height) * k)))
        let x = Int(JS.round(Double(width - w) / 2))
        let y = Int(JS.round(Double(height - h) / 2))
        let scaled = resampleImage(pixels, w, h)
        let cx = Swift.max(0, x), cy = Swift.max(0, y)
        let cw = Swift.min(width, x + w) - cx, ch = Swift.min(height, y + h) - cy
        var crop = [UInt8](repeating: 0, count: cw * ch * 4)
        for row in 0..<ch {
            let from = ((cy - y + row) * w + (cx - x)) * 4
            crop.replaceSubrange(row * cw * 4..<(row + 1) * cw * 4, with: scaled.data[from..<from + cw * 4])
        }
        let count = flattenLayers(doc.layers).count
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let layer = createPaintLayer(trimmed.isEmpty ? "Image \(count + 1)" : trimmed)
            .withSurface(surfaceFromPixels(width: cw, height: ch, data: crop, channels: 4, x: cx, y: cy))
        var parent: String? = nil
        var index: Int? = nil
        if let above = aboveId ?? doc.activeLayerId {
            guard let loc = findLayer(doc.layers, above) else { throw PaintEditorError("Unknown layer \"\(above)\". Call list_layers for the ids.") }
            parent = loc.parent?.id
            index = loc.index + 1
        }
        let layers = insertLayer(doc.layers, layer, parent, index)
        commit("Place image", doc.with { d in
            d.layers = layers
            d.activeLayerId = layer.id
        })
        return describeLayer(layer)
    }

    /// Puts an image under the paint to trace over: view only, never in exports.
    public func setTracingImage(_ a: JSONObject) throws -> TracingImage {
        let (src, pixels) = try importImage(a["png"]?.stringValue, "The tracing image")
        let w = Double(doc.canvas.width), h = Double(doc.canvas.height)
        let k = Swift.min(w / Double(pixels.width), h / Double(pixels.height))
        let fit = GuideRect(x: (w - Double(pixels.width) * k) / 2, y: (h - Double(pixels.height) * k) / 2, width: Double(pixels.width) * k, height: Double(pixels.height) * k)
        let tracing = TracingImage(src: src, width: pixels.width, height: pixels.height, rect: fit, opacity: 0.35, visible: true, sampleColors: false)
        var update = a
        if update["rect"] == nil { update["rect"] = fit.json }
        return try updateTracing(update, base: tracing)
    }

    /// Changes the tracing image's opacity, visibility, placement or colour sampling.
    public func updateTracing(_ update: JSONObject, base: TracingImage? = nil) throws -> TracingImage {
        guard var t = base ?? guides.tracing else { throw PaintEditorError("There is no tracing image; set one with set_tracing_image first.") }
        if let o = update["opacity"]?.numberValue, !(o >= 0 && o <= 1) { throw PaintEditorError("opacity \(jsText(o)) is out of range; use 0..1.") }
        if let r = update["rect"]?.objectValue, !((r["width"]?.numberValue ?? 0) > 0 && (r["height"]?.numberValue ?? 0) > 0) { throw PaintEditorError("rect needs a width and height above 0.") }
        if let o = update["opacity"]?.numberValue { t.opacity = o }
        if let v = update["visible"]?.boolValue { t.visible = v }
        if let s = update["sampleColors"]?.boolValue { t.sampleColors = s }
        if let r = update["rect"]?.objectValue { t.rect = GuideRect(x: r["x"]?.numberValue ?? 0, y: r["y"]?.numberValue ?? 0, width: r["width"]?.numberValue ?? 0, height: r["height"]?.numberValue ?? 0) }
        guides.tracing = t
        return t
    }

    public func clearTracingImage() { guides.tracing = nil }

    /// The tracing image's colour at a document pixel, or nil outside it or where it is clear.
    func sampleTracingColor(_ x: Double, _ y: Double) throws -> String? {
        guard let t = guides.tracing else { return nil }
        let src = try decodeImage(t.src)
        let u = Int(JS.floor(((x - t.rect.x) / t.rect.width) * Double(src.width)))
        let v = Int(JS.floor(((y - t.rect.y) / t.rect.height) * Double(src.height)))
        if u < 0 || v < 0 || u >= src.width || v >= src.height { return nil }
        let i = (v * src.width + u) * 4
        if src.data[i + 3] == 0 { return nil }
        return rgbToHex(Double(src.data[i]), Double(src.data[i + 1]), Double(src.data[i + 2]))
    }

    /// Adds a floating reference image to look at and pick colours from.
    public func addReferenceImage(_ a: JSONObject) throws -> ReferenceImage {
        let (src, pixels) = try importImage(a["png"]?.stringValue, "The reference image")
        let n = guides.references.count
        let name = a["name"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let ref = ReferenceImage(
            id: "ref\(nextReferenceId)", name: name.isEmpty ? "Reference \(n + 1)" : name, src: src, width: pixels.width, height: pixels.height,
            x: a["x"]?.numberValue ?? Double(16 + n * 24), y: a["y"]?.numberValue ?? Double(16 + n * 24),
            displayWidth: a["displayWidth"]?.numberValue ?? Double(Swift.min(240, pixels.width)), visible: true
        )
        nextReferenceId += 1
        guides.references.append(ref)
        return ref
    }

    private func requireReference(_ id: String) throws -> ReferenceImage {
        guard let r = guides.references.first(where: { $0.id == id }) else { throw PaintEditorError("Unknown reference image \"\(id)\". Call list_reference_images for the ids.") }
        return r
    }

    /// Moves, resizes, renames, shows or hides a reference image.
    public func updateReferenceImage(_ id: String, _ u: JSONObject) throws -> ReferenceImage {
        var r = try requireReference(id)
        if let w = u["displayWidth"]?.numberValue, !(w >= 16 && w <= 4096) { throw PaintEditorError("displayWidth \(jsText(w)) is out of range; use 16..4096.") }
        if let v = u["name"]?.stringValue { r.name = v }
        if let v = u["x"]?.numberValue { r.x = v }
        if let v = u["y"]?.numberValue { r.y = v }
        if let v = u["displayWidth"]?.numberValue { r.displayWidth = v }
        if let v = u["visible"]?.boolValue { r.visible = v }
        guides.references = guides.references.map { $0.id == id ? r : $0 }
        return r
    }

    public func removeReferenceImage(_ id: String) throws {
        _ = try requireReference(id)
        guides.references.removeAll { $0.id == id }
    }

    /// The colour of a reference image at its pixel (x, y).
    public func pickReferenceColor(_ id: String, _ x: Double, _ y: Double) throws -> String {
        let r = try requireReference(id)
        let px = try decodeImage(r.src)
        let u = JS.floor(x), v = JS.floor(y)
        if !(u >= 0 && v >= 0 && u < Double(px.width) && v < Double(px.height)) { throw PaintEditorError("(\(jsText(x)), \(jsText(y))) is outside reference \"\(r.name)\" (\(px.width)×\(px.height)); use its own pixel coordinates.") }
        let i = (Int(v) * px.width + Int(u)) * 4
        return rgbToHex(Double(px.data[i]), Double(px.data[i + 1]), Double(px.data[i + 2]))
    }
}

/**
 * `image` resampled to `width × height` (straight RGBA): bilinear on premultiplied colour, so clear
 * pixels don't darken the edges, averaging a box of samples when shrinking by more than 2× (`resampleImage`, controller.ts).
 */
public func resampleImage(_ image: PixelImage, _ width: Int, _ height: Int) -> PixelImage {
    let sw = image.width, sh = image.height, src = image.data
    var out = [UInt8](repeating: 0, count: width * height * 4)
    let sx = Double(sw) / Double(width), sy = Double(sh) / Double(height)
    let nx = max(1, Int(JS.floor(sx / 2))), ny = max(1, Int(JS.floor(sy / 2)))
    for oy in 0..<height {
        for ox in 0..<width {
            var r = 0.0, g = 0.0, b = 0.0, a = 0.0
            for j in 0..<ny {
                for i in 0..<nx {
                    let fx = (Double(ox) + (Double(i) + 0.5) / Double(nx)) * sx - 0.5
                    let fy = (Double(oy) + (Double(j) + 0.5) / Double(ny)) * sy - 0.5
                    let x0 = Int(JS.floor(fx)), y0 = Int(JS.floor(fy))
                    let tx = fx - Double(x0), ty = fy - Double(y0)
                    func tap(_ px: Int, _ py: Int, _ wt: Double) {
                        let o = (min(sh - 1, max(0, py)) * sw + min(sw - 1, max(0, px))) * 4
                        let al = Double(src[o + 3]) * wt
                        r += Double(src[o]) * al
                        g += Double(src[o + 1]) * al
                        b += Double(src[o + 2]) * al
                        a += al
                    }
                    tap(x0, y0, (1 - tx) * (1 - ty))
                    tap(x0 + 1, y0, tx * (1 - ty))
                    tap(x0, y0 + 1, (1 - tx) * ty)
                    tap(x0 + 1, y0 + 1, tx * ty)
                }
            }
            let k = (oy * width + ox) * 4
            if a > 0 {
                out[k] = UInt8(clamping: Int(JS.round(r / a)))
                out[k + 1] = UInt8(clamping: Int(JS.round(g / a)))
                out[k + 2] = UInt8(clamping: Int(JS.round(b / a)))
                out[k + 3] = UInt8(clamping: Int(JS.round(a / Double(nx * ny))))
            }
        }
    }
    return PixelImage(width: width, height: height, data: out)
}

/// The handlers of the tracing and reference image tools (`guide-tools.ts`), and `place_image` (`tools.ts`).
func paintTracingHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    var h: [String: PaintToolHandler] = [:]
    h["set_tracing_image"] = { a in tracingInfo(try c.setTracingImage(a)) }
    h["place_image"] = { a in try c.placeImage(png: a["png"]?.stringValue, name: a["name"]?.stringValue, fit: a["fit"]?.stringValue, aboveId: a["aboveId"]?.stringValue).json }
    h["update_tracing_image"] = { a in tracingInfo(try c.updateTracing(a)) }
    h["clear_tracing_image"] = { _ in
        c.clearTracingImage()
        return ["tracing": .null]
    }
    h["add_reference_image"] = { a in refInfo(try c.addReferenceImage(a)) }
    h["list_reference_images"] = { _ in ["references": .array(c.guides.references.map(refInfo))] }
    h["update_reference_image"] = { a in refInfo(try c.updateReferenceImage(a["id"]?.stringValue ?? "", a.without("id"))) }
    h["remove_reference_image"] = { a in
        let id = a["id"]?.stringValue ?? ""
        try c.removeReferenceImage(id)
        return ["removed": .string(id)]
    }
    h["pick_reference_color"] = { a in
        let color = try c.pickReferenceColor(a["id"]?.stringValue ?? "", a["x"]?.numberValue ?? 0, a["y"]?.numberValue ?? 0)
        if a["setColor"] == .bool(true) { _ = try c.setColor(color) }
        return ["color": .string(color)]
    }
    return h
}
