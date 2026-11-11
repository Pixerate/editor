import Foundation
import PixerateCore
import PixerateRaster

/**
 * The brush library's agent tools (`brushes/tools.ts`) for a paint editor
 * (`createPaintBrushLibraryToolProvider`): list, describe, check, export, preview (a test stroke
 * painted by this editor), create, update, duplicate, remove and import.
 */

/// A test stroke across a thumbnail: a wave, its pressure rising then falling.
func thumbnailStroke(_ width: Int, _ height: Int) -> [PenPoint] {
    var pts: [PenPoint] = []
    let n = 64
    let mx = Double(width) * 0.1, my = Double(height) * 0.5
    for i in 0...n {
        let t = Double(i) / Double(n)
        let pressure = t < 0.5 ? 0.15 + 1.7 * t : 1 - 1.4 * (t - 0.5)
        pts.append(PenPoint(x: mx + (Double(width) - 2 * mx) * t, y: my - JS.sin(t * Double.pi * 2) * Double(height) * 0.22, pressure: pressure, t: Double(i * 12)))
    }
    return pts
}

/// One small wet world reused for wet brush thumbnails (by size).
private let thumbWorld = Locked<WetWorld?>(nil)

/// A wet brush's test stroke: laid on a wet layer (over a wet band of colour for the tools that move paint), shown as painted, before any time passes.
private func paintWetTestStroke(_ brush: PaintBrush, _ paper: PaperSettings, _ color: String, _ width: Int, _ height: Int) throws -> TiledSurface {
    try thumbWorld.with { cached in
        let w: WetWorld
        if let c = cached, c.width == width, c.height == height {
            c.setPaper(wetPaperInput(paper))
            w = c
        } else {
            w = try WetWorld(width: width, height: height, paper: wetPaperInput(paper))
            cached = w
        }
        if w.hasLane("thumb") { try w.removeLane("thumb") }
        try w.ensureLane("thumb")
        let c8 = hexToRgb8(color)
        let rgb = [Double(c8[0]) / 255, Double(c8[1]) / 255, Double(c8[2]) / 255]
        if brush.wet.tool != "paint" && brush.wet.tool != "water" {
            // Wet paint to work in: the colour over ochre, as for the dry brushes that move paint.
            let half = Int(JS.ceil(Double(height) / 2))
            try w.paint("thumb", RasterRect(x: 0, y: 0, width: width, height: half), nil, water: 0.4, pigment: pigmentOf(rgb, 0).map { $0 * 0.05 })
            try w.paint("thumb", RasterRect(x: 0, y: half, width: width, height: height - half), nil, water: 0.4, pigment: pigmentOf([232.0 / 255, 196.0 / 255, 64.0 / 255], 0).map { $0 * 0.05 })
        }
        let film = brush.iridescence != nil && brush.wet.tool == "paint" ? FilmBuffer(emptySurface(4, 0)) : nil
        let driver = WetStrokeDriver(WetStrokeInit(
            world: w, laneId: "thumb", brush: brush, color: rgb, load: brushLoadForStroke(brush, EMPTY_MIXER_LOAD, rgb), grain: paperGrain(paper),
            paperDepth: paper.depth, paperColor: hexToRgb8(paper.color), seed: 7, copies: [IDENTITY_COPY], mask: nil, paint: nil, effect: nil, film: film
        ))
        _ = try driver.push(thumbnailStroke(width, height))
        _ = try driver.finish()
        // Blowing and vortex only show once the water has moved.
        if brush.wet.tool == "blow" || brush.wet.tool == "vortex" { w.step(brush.wet.tool == "vortex" ? 12 : 4) }
        let surf = try w.display("thumb").surface
        if let film {
            var ch = emptyThickChannels()
            ch.film = film.surface()
            return LitCache().lit(surf, ch, DEFAULT_LIGHTING)
        }
        return surf
    }
}

/// A thumbnail of a brush: a test stroke on the paper (`paint-editor/thumbnails.ts`). `stampArt` draws image tips and image tip grain.
func renderBrushThumbnail(_ brush: PaintBrush, paper: PaperSettings, width w: Int?, height h: Int?, color: String, stampArt: StampArtLookup? = nil) throws -> (width: Int, height: Int, data: [UInt8]) {
    let width = Swift.max(16, Swift.min(512, w ?? 160))
    let height = Swift.max(16, Swift.min(512, h ?? 48))
    // Fit the tip in the thumbnail: big brushes are drawn smaller.
    let maxSize = Double(height) * 0.42
    let b = brush.tip.size > maxSize ? normalizePaintBrush(["tip": .object(brush.tip.json.objectValue!.merging(["size": .number(maxSize)]))], brush) : brush
    let rgb = hexToRgb8(color)
    let rgba = rgb + [255]
    var surface = emptySurface(4)
    let bytes = { (c: [Int]) in c.map { UInt8($0) } }
    if b.engine == "eraser" || b.engine == "scraper" {
        surface = fillRect(surface, RasterRect(x: 0, y: 0, width: width, height: height), bytes(rgba))
    } else if b.engine == "wet" {
        // the wet layer draws its own band
    } else if b.engine == "blender" || b.engine == "smudge" || b.engine == "antimatter" || b.engine == "vortex" || (b.engine == "mixer" && !b.loadsColor) || b.behavior.pickup > 0 {
        let half = Int(JS.ceil(Double(height) / 2))
        surface = fillRect(surface, RasterRect(x: 0, y: 0, width: width, height: half), bytes(rgba))
        surface = fillRect(surface, RasterRect(x: 0, y: half, width: width, height: height - half), [232, 196, 64, 255])
    }
    var light: TiledSurface? = nil
    if b.engine == "wet" {
        surface = try paintWetTestStroke(b, paper, color, width, height)
    } else {
        var i = StrokeSessionInit(
            layerId: "thumbnail", surface: surface, offset: LayerOffset(x: 0, y: 0), lockTransparency: false, brush: b, color: rgba,
            background: hexToRgb8(paper.color) + [255], grain: paperGrain(paper), paperDepth: paper.depth, seed: 7, colorHex: color,
            affineCopies: [], copies: [IDENTITY_COPY], mixerLoad: brushLoadForStroke(b, EMPTY_MIXER_LOAD, rgb.map { Double($0) / 255 }), secondary: nil, selection: nil, paint: nil
        )
        if b.engine == "impasto" { i.thick = emptyThickChannels() }
        else if b.iridescence != nil { i.film = emptySurface(4, 0) }
        if b.engine == "scraper" {
            let thumbLayer = RasterLayer(id: "thumbnail", name: "thumbnail", content: .pixel(surface: surface, offset: LayerOffset(x: 0, y: 0), fillOpacity: nil))
            i.scraper = ScraperStrokeDriver(ScraperStrokeInit(brush: b, seed: 7, copies: [IDENTITY_COPY], selection: nil, inputFilter: nil), scrapeLayers: [thumbLayer], thickMap: nil)
        }
        i.stampArt = stampArt
        if b.light.amount > 0 && b.engine != "sticker" { i.light = emptyLight() }
        let session = try PaintStrokeSession(i)
        let pts = thumbnailStroke(width, height)
        try session.push(pts)
        _ = try session.end()
        let beforeCulture = surface
        surface = session.surfaceAfter ?? surface
        let thick = session.thickChannels() ?? session.filmChannel().map { ThickChannels(height: emptySurface(1, 0), material: emptySurface(4, 0), film: $0) }
        light = session.lightChannel
        if let c = b.culture {
            let seeded = seedCultureFromStroke(
                points: pts.map { Point2(x: $0.x, y: $0.y) },
                brushSize: b.tip.size,
                color: [rgb[0], rgb[1], rgb[2]],
                culture: c,
                strokeSeed: 7,
                beforeSurface: beforeCulture,
                afterSurface: surface,
                canvasWidth: width,
                canvasHeight: height
            )
            let grown = stepLayerCulture(
                culture: seeded.culture,
                surface: surface,
                lightSurface: light ?? (c.glow > 0 ? emptyLight() : nil),
                paperSeed: paper.seed,
                paperDepthPermille: Int(JS.round(paper.depth * 1000)),
                canvasWidth: width,
                canvasHeight: height,
                steps: 24
            )
            surface = grown.surface
            if let gl = grown.lightSurface, !gl.tiles.isEmpty { light = gl }
        }
        // Thick paint is shown lit, and light paint glowing, as on the canvas.
        let lit = thick.map { LitCache().lit(surface, $0, DEFAULT_LIGHTING) } ?? surface
        surface = light != nil || thick != nil ? glowSurface(lit, light, thick) : lit
    }
    let layer = RasterLayer(id: "thumbnail", name: "thumbnail", content: .pixel(surface: surface, offset: LayerOffset(x: 0, y: 0), fillOpacity: nil))
    // Light paint reads on dark paper, with its spill; a multiply light brush (a highlighter) is a tint on paper.
    var shown = paper
    if light != nil && b.tip.blend != .multiply { shown.color = "#141414" }
    var layers = [ViewLayer.paper(shown), ViewLayer(layer)]
    if let light, let spill = computeSpill(surface, light, LightSpill(radius: Swift.max(4, Double(height) / 6), strength: 1)) {
        layers.append(ViewLayer(RasterLayer(id: "thumbnail-light", name: "light", visible: true, opacity: 1, blend: .mode(.linearDodge), content: .pixel(surface: spill, offset: LayerOffset(x: 0, y: 0), fillOpacity: nil))))
    }
    let data = createPaintCompositor().composite(layers, RasterRect(x: 0, y: 0, width: width, height: height), BasicRasterSources(width: width, height: height))
    return (width, height, data)
}

/// A brush library entry as `list_brush_presets` lists it.
func brushSummary(_ e: BrushLibraryEntry, withCheck: Bool) -> JSONValue {
    let b = e.brush
    let engine = resolveEngine(b)
    var o: JSONObject = ["id": b["id"] ?? .null, "name": b["name"] ?? .null, "builtin": .bool(e.builtin), "kind": b["kind"] ?? .null]
    if let m = b["medium"] { o["medium"] = m }
    if let v = b["variety"] { o["variety"] = v }
    if let t = b["tool"] { o["tool"] = t }
    o["category"] = .string(resolveCategory(b, engine))
    if let family = resolveFamily(b, engine) { o["family"] = .string(family) }
    o["engine"] = .string(engine)
    o["tip"] = b.path("tip.shape") ?? .null
    if let s = b.path("tip.size") { o["size"] = s }
    o["marks"] = b.path("marks.kind") ?? "continuous"
    o["surface"] = b.path("behaviour.surface") ?? "dry"
    if let l = b.path("light.amount"), l != 0 { o["light"] = l }
    if let f = b.path("ferro.amount"), f != 0 { o["ferro"] = f }
    if let tags = b["tags"]?.arrayValue, !tags.isEmpty { o["tags"] = .array(tags) }
    if withCheck { o["renderable"] = .bool(checkBrush(b, PAINT_PROFILE).ok) }
    return .object(o)
}

/// The handlers of the brush library provider's tools, by name.
func brushLibraryHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    let library = c.brushLibrary
    let profile = PAINT_PROFILE
    func entry(_ id: String) throws -> BrushLibraryEntry {
        if let e = library.get(id) { return e }
        throw BrushLibraryError(.unknownBrush, "No brush \"\(id)\". \(closestIds(id, library.list().compactMap { $0.brush["id"]?.stringValue }))list_brush_presets lists them.")
    }
    func hostOf(_ id: String?) throws -> BrushHostProfile {
        guard let id else { return profile }
        guard let p = BRUSH_HOST_PROFILES.first(where: { $0.id == id }) else { throw BrushLibraryError(.invalid, "No host \"\(id)\"; use one of: \(BRUSH_HOST_PROFILES.map(\.id).joined(separator: ", ")).") }
        return p
    }
    /// `checkBrush`, plus the image sources it names checked against the library.
    func checkFor(_ brush: Brush, _ p: BrushHostProfile) -> BrushCheck {
        var issues = checkBrush(brush, p).issues
        var refs = (brush.path("tip.stamps")?.arrayValue ?? []).compactMap(\.stringValue).map { ("tip.stamps", $0) }
        if let g = brush.path("tip.grain.source")?.stringValue { refs.append(("tip.grain.source", g)) }
        for (facet, ref) in refs {
            guard let id = brushSourceIdOf(ref), library.getSource(id) == nil else { continue }
            let reason = "There is no image source \"\(id)\" in the brush library. \(closestIds(id, library.listSources().map(\.id)))".trimmingCharacters(in: .whitespaces)
            issues.append(BrushIssue(facet: facet, severity: "error", reason: reason, fix: "Add it with add_brush_source, or use a ref list_brush_sources lists."))
        }
        return BrushCheck(ok: !issues.contains { $0.severity == "error" }, issues: issues)
    }
    /// With `original` (an update), what it already had that this host can't use is kept, not refused.
    func store(_ raw: JSONObject, _ overwrite: Bool, original: Brush? = nil) throws -> (brush: Brush, problems: [String], check: BrushCheck, kept: [BrushIssue]) {
        var problems: [String] = []
        let brush: Brush
        do { brush = try normalizeBrushSpec(.object(raw), &problems) } catch { throw BrushLibraryError(.invalid, error.localizedDescription) }
        let had = Set((original.map { checkFor($0, profile).issues } ?? []).filter { $0.severity == "error" }.map(\.facet))
        let all = checkFor(brush, profile)
        let kept = all.issues.filter { $0.severity == "error" && had.contains($0.facet) }
        let issues = all.issues.filter { i in !kept.contains { $0.facet == i.facet && $0.severity == i.severity } }
        let check = BrushCheck(ok: !issues.contains { $0.severity == "error" }, issues: issues)
        if !check.ok {
            let errors = check.issues.filter { $0.severity == "error" }.map { "\($0.facet): \($0.reason) \($0.fix)" }.joined(separator: " ")
            throw BrushLibraryError(.invalid, "\(profile.name) can't use this brush: \(errors) (check_brush lists every issue; nothing was saved.)")
        }
        let saved = try library.save(.object(brush), overwrite: overwrite)
        return (saved.brush, problems, check, kept)
    }
    func warnings(_ check: BrushCheck) -> JSONValue { .array(check.issues.filter { $0.severity == "warning" }.map(\.json)) }

    var h: [String: PaintToolHandler] = [:]
    h["list_brush_presets"] = { a in
        let source = a["source"]?.stringValue == "all" ? nil : a["source"]?.stringValue
        let found = library.list(BrushFilter(kind: a["kind"]?.stringValue, medium: a["medium"]?.stringValue, family: a["family"]?.stringValue, variety: a["variety"]?.stringValue, tool: a["tool"]?.stringValue, tag: a["tag"]?.stringValue, text: a["text"]?.stringValue, source: source)).filter { a["all"] == .bool(true) || checkBrush($0.brush, profile).ok }
        let offset = Int(a["offset"]?.numberValue ?? 0)
        let page = found.dropFirst(offset).prefix(Int(a["limit"]?.numberValue ?? 100))
        return ["host": .string(profile.id), "total": .number(Double(found.count)), "brushes": .array(page.map { brushSummary($0, withCheck: a["all"] == .bool(true)) })]
    }
    h["describe_brush"] = { a in
        let e = try entry(a["id"]?.stringValue ?? "")
        let engine = resolveEngine(e.brush)
        var out: JSONObject = ["brush": .object(e.brush), "builtin": .bool(e.builtin), "engine": .string(engine), "category": .string(resolveCategory(e.brush, engine)), "check": .object(checkBrush(e.brush, profile).json)]
        if let family = resolveFamily(e.brush, engine) { out["family"] = .string(family) }
        return .object(out)
    }
    h["check_brush"] = { a in
        if (a["id"] == nil) == (a["brush"] == nil) { throw BrushLibraryError(.invalid, "Give either id (a library brush) or brush (a spec), not both or neither.") }
        let p = try hostOf(a["host"]?.stringValue)
        var problems: [String] = []
        let b: Brush
        if let id = a["id"]?.stringValue { b = try entry(id).brush } else {
            do { b = try normalizeBrushSpec(a["brush"]!, &problems) } catch { throw BrushLibraryError(.invalid, error.localizedDescription) }
        }
        let result = checkFor(b, p)
        var o: JSONObject = ["host": .string(p.id)]
        for (k, v) in result.json { o[k] = v }
        if !problems.isEmpty { o["problems"] = .array(problems.map { .string($0) }) }
        if !result.ok { o["degraded"] = .object(degrade(b, p)) }
        return .object(o)
    }
    h["export_brushes"] = { a in ["file": .object(try library.exportFile(a["ids"]?.arrayValue?.compactMap(\.stringValue)))] }
    h["create_brush"] = { a in
        let spec = a.without("basedOn")
        let id = spec["id"]?.stringValue ?? ""
        if library.isBuiltin(id) { throw BrushLibraryError(.builtin, "\"\(id)\" is a built-in brush id; pick another id (or basedOn \"\(id)\" with a new id).") }
        if library.get(id) != nil { throw BrushLibraryError(.exists, "A brush \"\(id)\" exists already; pick another id, or change it with update_brush.") }
        let base = try a["basedOn"]?.stringValue.map { try entry($0).brush }
        let raw = base.map { mergeBrushPatch($0, spec) } ?? spec
        let saved = try store(raw, false)
        return ["id": saved.brush["id"] ?? .null, "brush": .object(saved.brush), "engine": .string(resolveEngine(saved.brush)), "problems": .array(saved.problems.map { .string($0) }), "warnings": warnings(saved.check)]
    }
    h["update_brush"] = { a in
        let id = a["id"]?.stringValue ?? ""
        let e = try entry(id)
        if e.builtin { throw BrushLibraryError(.builtin, "\"\(id)\" is a built-in brush and can't be changed; duplicate_brush makes a copy you can change.") }
        var base = e.brush
        for k in a["unset"]?.arrayValue?.compactMap(\.stringValue) ?? [] { base[k] = nil }
        var patch = a.without("id", "unset")
        patch["id"] = .string(id)
        let saved = try store(mergeBrushPatch(base, patch), true, original: e.brush)
        var result: JSONObject = ["id": .string(id), "brush": .object(saved.brush), "changed": .array(changedBrushPaths(.object(e.brush), .object(saved.brush)).map { .string($0) }), "problems": .array(saved.problems.map { .string($0) }), "warnings": warnings(saved.check)]
        if !saved.kept.isEmpty { result["kept"] = .array(saved.kept.map(\.json)) }
        return .object(result)
    }
    h["duplicate_brush"] = { a in
        let brush = try library.duplicate(a["id"]?.stringValue ?? "", newId: a["newId"]?.stringValue, name: a["name"]?.stringValue)
        return ["id": brush["id"] ?? .null, "brush": .object(brush)]
    }
    h["remove_brush"] = { a in
        let id = a["id"]?.stringValue ?? ""
        _ = try entry(id)
        _ = try library.remove(id)
        return ["removed": .string(id)]
    }
    h["import_brushes"] = { a in
        let r = try library.importFile(a["file"] ?? .null, overwrite: a["overwrite"] == .bool(true))
        var o: JSONObject = ["added": .array(r.added.map { .string($0) }), "replaced": .array(r.replaced.map { .string($0) }), "skipped": .array(r.skipped.map { .string($0) }), "problems": .array(r.problems.map { .string($0) })]
        if let sources = r.sources { o["sources"] = .array(sources.map { .string($0) }) }
        return .object(o)
    }
    h["list_brush_sources"] = { a in
        let brushes = library.list(BrushFilter(source: "user")).map(\.brush)
        func wordsOf(_ v: String) -> [String] { v.lowercased().components(separatedBy: CharacterSet.letters.union(.decimalDigits).inverted).filter { !$0.isEmpty } }
        let want = a["text"]?.stringValue.map(wordsOf) ?? []
        let found = library.listSources().filter { x in
            let have = wordsOf([x.id, x.name, x.origin ?? ""].joined(separator: " "))
            return want.allSatisfy { w in have.contains { $0.hasPrefix(w) } }
        }
        let start = Int(a["offset"]?.numberValue ?? 0)
        let page = found.dropFirst(start).prefix(Int(a["limit"]?.numberValue ?? 100))
        return ["total": .number(Double(found.count)), "sources": .array(page.map { x in
            var o = x.summary
            o["usedBy"] = .array(brushes.filter { brushSourceIds($0).contains(x.id) }.compactMap { $0["id"] })
            return .object(o)
        })]
    }
    h["import_brush_pack"] = { a in
        let text = (a["file"]?.stringValue ?? "").replacingOccurrences(of: "^data:[^,]*,", with: "", options: .regularExpression)
        let bytes: [UInt8]
        do { bytes = try base64ToBytes(text) } catch { throw BrushLibraryError(.invalid, "file is not base64: pass the pack's bytes as base64 (a data: URL works too).") }
        let r: ImportBrushPackResult
        do {
            r = try importBrushPack(library, bytes, fileName: a["fileName"]?.stringValue ?? "", format: a["format"]?.stringValue, prefix: a["prefix"]?.stringValue, licence: a["licence"]?.stringValue, overwrite: a["overwrite"] == .bool(true))
        } catch let e as BrushLibraryError {
            throw e
        } catch {
            throw BrushLibraryError(.invalid, "\(error.localizedDescription) Nothing was imported.")
        }
        let strings = { (v: [String]) in JSONValue.array(v.map { .string($0) }) }
        return [
            "format": .string(r.format),
            "brushes": .array(r.brushes.map { b in ["id": .string(b.id), "name": .string(b.name), "renderable": .bool(library.get(b.id).map { checkBrush($0.brush, profile).ok } ?? false)] }),
            "sources": strings(r.sources), "skipped": strings(r.skipped), "unsupported": strings(r.unsupported), "licence": strings(r.licence), "problems": strings(r.problems),
        ]
    }
    h["add_brush_source"] = { a in
        let input = BrushSourceInput(id: a["id"]?.stringValue, name: a["name"]?.stringValue ?? "", image: a["image"]?.stringValue ?? "", channel: a["channel"]?.stringValue, invert: a["invert"]?.boolValue ?? false, licence: a["licence"]?.stringValue, origin: a["origin"]?.stringValue)
        let r = try library.addSource(input, overwrite: a["overwrite"] == .bool(true))
        return ["id": .string(r.source.id), "ref": .string(brushSourceRef(r.source.id)), "width": .number(Double(r.source.width)), "height": .number(Double(r.source.height)), "problems": .array(r.problems.map { .string($0) }), "replaced": .bool(r.replaced)]
    }
    return h
}

/// The brush library's `preview_brush` (an image and its size).
func brushLibraryContentHandlers(_ c: PaintEditorController) -> [String: (JSONObject) async throws -> ToolOutput] {
    var h: [String: (JSONObject) async throws -> ToolOutput] = [:]
    h["preview_brush"] = { a in
        let id = a["id"]?.stringValue ?? ""
        guard let e = c.brushLibrary.get(id) else {
            throw BrushLibraryError(.unknownBrush, "No brush \"\(id)\". \(closestIds(id, c.brushLibrary.list().compactMap { $0.brush["id"]?.stringValue }))list_brush_presets lists them.")
        }
        var own: String? = nil
        if let d = e.brush.path("colour.default")?.stringValue, d.range(of: "^#[0-9a-fA-F]{6}", options: .regularExpression) != nil { own = String(d.prefix(7)) }
        let w = a["width"]?.numberValue.map { Int($0) } ?? 256
        let h = a["height"]?.numberValue.map { Int($0) } ?? 96
        let color = (a["color"]?.stringValue ?? own ?? "#1f2937").lowercased()
        // Image tips and grain are drawn from the library's sources.
        let sources = BrushSourceArtCache()
        sources.set(brushSourceIds(e.brush).compactMap { c.brushLibrary.getSource($0) })
        let img = try renderBrushThumbnail(resolveBrush(e.brush), paper: c.doc.paper, width: w, height: h, color: color, stampArt: sources.get)
        return .result(McpToolResult(content: [.image(data: bytesToBase64(encodePng(img.width, img.height, img.data)), mimeType: "image/png")], structuredContent: ["id": .string(id), "width": .number(Double(w)), "height": .number(Double(h))]))
    }
    return h
}
