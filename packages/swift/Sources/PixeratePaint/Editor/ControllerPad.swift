import Foundation
import PixerateCore
import PixerateRaster

/// Whether `s` is exactly `#` and six hex digits (`/^#[0-9a-f]{6}$/i`; ICU's `$` would also pass a trailing newline).
private func isExactHex6(_ s: String) -> Bool {
    let u = Array(s.utf16)
    return u.count == 7 && u[0] == 0x23 && u[1...].allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x46) || ($0 >= 0x61 && $0 <= 0x66) }
}

/// A swatch read from JSON (`readSwatch`), or nil when it is not one (a gradient swatch keeps its gradient).
func readSwatch(_ raw: JSONValue) -> Swatch? {
    guard let r = raw.objectValue else { return nil }
    var gradient: PaintGradientSource? = nil
    if case .gradient(let g)? = readPaintSource(r["paint"]) { gradient = g }
    let color: String
    if let c = r["color"]?.stringValue, isExactHex6(c) {
        color = c.lowercased()
    } else if let g = gradient, let first = g.stops.first?.color {
        // `paintSourceColor` with its default colours.
        color = first == "paint" ? "#000000" : first == "secondary" ? "#ffffff" : first
    } else {
        return nil
    }
    var out = Swatch(color: color)
    if let n = r["name"]?.stringValue {
        let t = n.jsTrimmed
        if !t.isEmpty { out.name = String(decoding: Array(t.utf16.prefix(80)), as: UTF16.self) }
    }
    out.paint = gradient
    return out
}

/// Swatches and the mixing pad (`controller.ts`): editor state, not undo steps.
extension PaintEditorController {
    /// Adds a swatch: a colour, or a paint source (a gradient swatch holds its gradient).
    public func addSwatch(_ color: JSONValue, name: String?) throws -> [Swatch] {
        swatches.append(try makeSwatch(color, name))
        return swatches
    }

    private func makeSwatch(_ color: JSONValue, _ name: String?) throws -> Swatch {
        let p: PaintSource = color.stringValue != nil ? .color(try parseColor(color)) : try readStrokePaintPublic(color)
        var out: Swatch
        switch p {
        case .color(let c): out = Swatch(color: c)
        case .gradient(let g):
            let first = g.stops[0].color
            out = Swatch(color: first == "paint" ? self.color : first == "secondary" ? secondaryColor : first)
            out.paint = g
        }
        if let n = name?.trimmingCharacters(in: .whitespacesAndNewlines), !n.isEmpty { out.name = n }
        return out
    }

    func readStrokePaintPublic(_ raw: JSONValue) throws -> PaintSource {
        do { return try parsePaintSource(raw) } catch let e as PaintSourceError { throw PaintEditorError(e.message) }
    }

    public func removeSwatch(_ index: Int) throws -> [Swatch] {
        if index < 0 || index >= swatches.count { throw PaintEditorError("index \(index) is out of range; there are \(swatches.count) swatches (0-based).") }
        swatches.remove(at: index)
        return swatches
    }

    /// Paints (`paint`) or smears with the palette knife (`knife`) on the mixing pad, in pad pixels.
    public func mixingPadStroke(_ points: [PenPoint], tool: String?, color c: String?, size: Double?) throws -> RasterRect? {
        let color = try c.map { try parseColor(.string($0)) } ?? self.color
        if let size, !(size >= 1 && size <= 200) { throw PaintEditorError("size \(jsText(size)) is out of range; use 1..200 px.") }
        return try pad.stroke(points, tool: tool ?? "paint", color: color, size: size)
    }

    /// Picks the mixed colour on the pad; with `setColor` it becomes the paint colour.
    public func mixingPadPick(_ x: Double, _ y: Double, radius: Double?, setColor: Bool?) throws -> String? {
        let c = try pad.pick(x, y, radius ?? 3)
        if let c, setColor == true { _ = try self.setColor(c) }
        return c
    }

    /// Mixes paints on the pad like a painter (see `MixingPad.mix`).
    public func mixOnPad(_ paints: [JSONValue], x: Double?, y: Double?, radius: Double?, passes: Int?, clear: Bool?, setColor: Bool?) throws -> JSONObject {
        let parsed = try paints.enumerated().map { i, p in (color: try parseColor(p.objectValue?["color"], "paints[\(i)].color"), parts: p.objectValue?["parts"]?.numberValue ?? .nan) }
        let r = try pad.mix(parsed, x: x, y: y, radius: radius, passes: passes, clear: clear)
        let color = r.color ?? parsed[0].color
        if setColor == true { _ = try self.setColor(color) }
        return ["color": .string(color), "bounds": r.bounds.json]
    }

    /// Keeps the mixing pad as it is now under `name` (saved with the document).
    public func saveMixingPad(_ name: String?) throws -> JSONObject {
        if pad.empty { throw PaintEditorError("The mixing pad is empty; put paint on it (mixing_pad_stroke or mix_on_pad) before saving it.") }
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let label = String((!trimmed.isEmpty ? trimmed : "Pad \(nextPadId)").prefix(80))
        let p = SavedMixingPad(id: "pad\(nextPadId)", name: label, png: pad.toPng())
        nextPadId += 1
        savedPads.append(p)
        return ["id": .string(p.id), "name": .string(p.name)]
    }

    private func requirePad(_ id: String) throws -> SavedMixingPad {
        guard let p = savedPads.first(where: { $0.id == id }) else { throw PaintEditorError("Unknown mixing pad \"\(id)\". Call list_mixing_pads for the ids.") }
        return p
    }

    public func loadMixingPad(_ id: String) throws -> JSONObject {
        let p = try requirePad(id)
        try pad.fromPng(p.png)
        return ["id": .string(p.id), "name": .string(p.name)]
    }

    public func removeMixingPad(_ id: String) throws -> JSONObject {
        let p = try requirePad(id)
        savedPads.removeAll { $0.id == id }
        return ["id": .string(p.id), "name": .string(p.name)]
    }

    /// The mixing pad as saved (`{ current?, saved }`), or nil when there is nothing to save.
    func mixingPadJSON() -> JSONValue? {
        if pad.empty && savedPads.isEmpty { return nil }
        var o = JSONObject()
        if !pad.empty { o["current"] = .string(pad.toPng()) }
        o["saved"] = .array(savedPads.map { ["id": .string($0.id), "name": .string($0.name), "png": .string($0.png)] })
        return .object(o)
    }
}

/// The handlers of the swatch and mixing pad tools (`guide-tools.ts`) this port implements.
func paintPadHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    var h: [String: PaintToolHandler] = [:]
    let list = { (s: [Swatch]) -> JSONValue in
        .array(s.enumerated().map { i, sw in var o = sw.json.objectValue!; o["index"] = .number(Double(i)); return .object(o) })
    }
    h["list_swatches"] = { _ in ["swatches": list(c.swatches)] }
    h["add_swatch"] = { a in
        if (a["color"] == nil) == (a["paint"] == nil) { throw PaintEditorError("Give color (#rrggbb) or paint (a colour or gradient), not both and not neither.") }
        return ["swatches": list(try c.addSwatch(a["paint"] ?? a["color"]!, name: a["name"]?.stringValue))]
    }
    h["remove_swatch"] = { a in ["swatches": list(try c.removeSwatch(Int(a["index"]?.numberValue ?? -1)))] }
    h["mixing_pad_stroke"] = { a in
        let points = (a["points"]?.arrayValue ?? []).compactMap(PenPoint.init(json:))
        return ["bounds": rectJSON(try c.mixingPadStroke(points, tool: a["tool"]?.stringValue, color: a["color"]?.stringValue, size: a["size"]?.numberValue))]
    }
    h["pick_mixing_pad_color"] = { a in
        ["color": try c.mixingPadPick(a["x"]?.numberValue ?? 0, a["y"]?.numberValue ?? 0, radius: a["radius"]?.numberValue, setColor: a["setColor"]?.boolValue).map { .string($0) } ?? .null]
    }
    h["clear_mixing_pad"] = { _ in
        c.pad.clear()
        return ["cleared": true]
    }
    h["mix_on_pad"] = { a in
        .object(try c.mixOnPad(a["paints"]?.arrayValue ?? [], x: a["x"]?.numberValue, y: a["y"]?.numberValue, radius: a["radius"]?.numberValue, passes: a["passes"]?.numberValue.map { Int($0) }, clear: a["clear"]?.boolValue, setColor: a["setColor"]?.boolValue))
    }
    h["save_mixing_pad"] = { a in .object(try c.saveMixingPad(a["name"]?.stringValue)) }
    h["list_mixing_pads"] = { _ in ["pads": .array(c.savedPads.map { ["id": .string($0.id), "name": .string($0.name)] })] }
    h["load_mixing_pad"] = { a in .object(try c.loadMixingPad(a["id"]?.stringValue ?? "")) }
    h["remove_mixing_pad"] = { a in .object(try c.removeMixingPad(a["id"]?.stringValue ?? "")) }
    return h
}

/// Tools that return content blocks rather than JSON (images with a caption).
func paintContentHandlers(_ c: PaintEditorController) -> [String: (JSONObject) async throws -> ToolOutput] {
    var h: [String: (JSONObject) async throws -> ToolOutput] = [:]
    h["render_mixing_pad"] = { _ in
        let p = c.pad
        return .result(McpToolResult(content: [.image(data: bytesToBase64(encodePng(p.width, p.height, p.pixels())), mimeType: "image/png"), .text("Mixing pad \(p.width)×\(p.height)")]))
    }
    h["render_preview"] = { a in
        let ids = a["layerIds"]?.arrayValue?.compactMap(\.stringValue)
        if let ids { for id in ids where c.getLayer(id) == nil { throw PaintEditorError("Unknown layer \"\(id)\". Call list_layers for the ids.") } }
        let img = c.renderPreview(maxSide: a["maxSide"]?.numberValue ?? 512, layerIds: ids, paper: a["paper"]?.boolValue)
        return .result(McpToolResult(content: [.image(data: bytesToBase64(encodePng(img.width, img.height, img.data)), mimeType: "image/png"), .text("Preview \(img.width)×\(img.height)")]))
    }
    return h
}
