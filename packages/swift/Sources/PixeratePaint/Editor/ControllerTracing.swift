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

/// The handlers of the tracing and reference image tools (`guide-tools.ts`).
func paintTracingHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    var h: [String: PaintToolHandler] = [:]
    h["set_tracing_image"] = { a in tracingInfo(try c.setTracingImage(a)) }
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
