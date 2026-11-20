import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/**
 * Every stroke selectable, whatever the layer (#902, `paint-editor-stroke-tails.test.ts`): a pixel
 * layer keeps the strokes painted on it since its last flattening point editable over the pixels
 * under them, with the stroke log edited to match, so replays, saves and the agent tools all see
 * the edited strokes.
 */
final class PaintStrokeTailsTests: XCTestCase {
    private func editor() throws -> PaintEditorController { try PaintEditorController(width: 260, height: 200, paperPreset: "smooth") }

    private func wave(_ y: Double, _ n: Int = 30, _ x0: Double = 20) -> [PenPoint] {
        (0..<n).map { i in PenPoint(x: x0 + Double(i) * 7, y: y + sin(Double(i) / 3) * 12, pressure: 0.4 + 0.6 * sin(Double(i) / Double(n - 1) * .pi)) }
    }

    private func down(_ x: Double) -> [PenPoint] {
        (0..<20).map { i in PenPoint(x: x + sin(Double(i) / 2) * 6, y: 10 + Double(i) * 9, pressure: 0.8) }
    }

    @discardableResult
    private func paint(_ c: PaintEditorController, _ points: [PenPoint], _ brushId: String, _ color: String? = nil, seed: Int, layerId: String? = nil) throws -> String {
        try XCTUnwrap(c.paintStroke(PaintStrokeInit(layerId: layerId, color: color, brushId: brushId, seed: seed), points: points).strokeId)
    }

    private func pixels(_ c: PaintEditorController) -> [UInt8] { c.compositePixels().data }

    /// A pixel layer flattened by a smudge over an ink stroke, then strokes of every redrawable kind on top.
    private func painted() throws -> (c: PaintEditorController, layer: String, under: String, smudge: String, tail: [String]) {
        let c = try editor()
        let layer = try XCTUnwrap(c.doc.activeLayerId)
        let under = try paint(c, wave(80), "ink-pen", "#0f172a", seed: 1)
        let smudge = try paint(c, down(110), "smudge", seed: 2)
        let tail = [
            try paint(c, wave(50), "hair-strands", "#2563eb", seed: 3),
            try paint(c, wave(100), "ink-pen", "#dc2626", seed: 5),
            try paint(c, wave(150), "bristle-round", "#16a34a", seed: 7),
            try paint(c, down(60), "eraser-soft", seed: 8),
            try paint(c, wave(120, 20, 60), "pencil-hb", "#f59e0b", seed: 9),
        ]
        return (c, layer, under, smudge, tail)
    }

    private func ids(_ c: PaintEditorController, _ layer: String) -> [String]? { c.editableStrokes(layer)?.map(\.id) }

    func testKeepsTheStrokesSinceTheLastFlatteningPointEditableAndRedrawsThemToTheSamePixels() throws {
        let (c, layer, under, smudge, tail) = try painted()
        XCTAssertEqual(ids(c, layer), tail)
        XCTAssertFalse(c.isStrokeEditable(under))
        XCTAssertFalse(c.isStrokeEditable(smudge))
        XCTAssertThrowsError(try c.updateStroke(under, brushId: nil, brushChanges: nil, color: "#000000", paint: nil, seed: nil)) {
            XCTAssertTrue("\($0)".hasPrefix("Stroke \"\(under)\" can't be edited: Painted before its layer was last flattened"), "\($0)")
        }
        // An edit that changes nothing redraws exactly what was painted.
        let before = pixels(c)
        let was = try XCTUnwrap(c.getLayer(layer)?.surface)
        _ = try c.updateStroke(tail[1], brushId: nil, brushChanges: nil, color: nil, paint: nil, seed: 5)
        XCTAssertFalse(c.getLayer(layer)?.surface === was)
        XCTAssertEqual(pixels(c), before)
    }

    func testEditsMovesReordersAndRemovesThemAsTheStrokesWouldHavePaintedOneUndoStepEach() throws {
        let (c, layer, _, _, tail) = try painted()
        let before = pixels(c)
        _ = try c.updateStroke(tail[0], brushId: nil, brushChanges: nil, color: "#9333ea", paint: nil, seed: 11)
        _ = try c.editStrokePoints(tail[2], points: nil, transform: ["dx": 10, "dy": -20, "rotate": 15])
        XCTAssertEqual(try c.reorderStroke(tail[1], 0), [tail[1], tail[0], tail[2], tail[3], tail[4]])
        XCTAssertEqual(try c.removeStrokes([tail[4]])["removed"], .array([.string(tail[4])]))
        let now = try XCTUnwrap(c.editableStrokes(layer))
        XCTAssertEqual(now.map(\.id), [tail[1], tail[0], tail[2], tail[3]])
        let d = try editor()
        try paint(d, wave(80), "ink-pen", "#0f172a", seed: 1)
        try paint(d, down(110), "smudge", seed: 2)
        for s in now {
            var i = PaintStrokeInit(color: s.color, seed: s.seed, load: s.load)
            i.fixedBrush = s.brush
            _ = try d.paintStroke(i, points: s.points)
        }
        XCTAssertEqual(pixels(c), pixels(d))
        // The log holds the edited strokes in their new order, without the removed one.
        XCTAssertEqual(c.strokes.dropFirst(2).map(\.id), now.map(\.id))
        XCTAssertEqual(c.strokes.first { $0.id == tail[0] }?.color, "#9333ea")
        for _ in 0..<4 { _ = c.undo() }
        XCTAssertEqual(pixels(c), before)
        XCTAssertEqual(ids(c, layer), tail)
        _ = c.redo()
        XCTAssertEqual(c.editableStrokes(layer)?.first?.color, "#9333ea")
    }

    func testEndsAtAnythingThatCantBeRedrawnAndStartsAgainOverThePixelsAfterIt() throws {
        let c = try editor()
        let layer = try XCTUnwrap(c.doc.activeLayerId)
        let a = try paint(c, wave(50), "ink-pen", "#2563eb", seed: 1)
        XCTAssertEqual(ids(c, layer), [a])
        _ = try c.fillRegion(x: 100, y: 100, color: "#fde68a")
        XCTAssertEqual(ids(c, layer), [])
        let b = try paint(c, wave(100), "ink-pen", "#dc2626", seed: 2)
        XCTAssertEqual(ids(c, layer), [b])
        // A layer change outside the strokes (a move) bakes them too.
        _ = try c.transformLayer(layerId: layer, translateX: 5)
        XCTAssertEqual(ids(c, layer), [])
        XCTAssertFalse(c.isStrokeEditable(a) || c.isStrokeEditable(b))
        // Locked layers don't start one.
        let other = try c.addLayer(name: "Locked").id
        _ = try c.updateLayer(other, ["locks": ["transparency": true]])
        _ = try c.paintStroke(PaintStrokeInit(layerId: other, color: "#16a34a", brushId: "ink-pen", seed: 3), points: wave(60))
        XCTAssertEqual(ids(c, other), [])
    }

    func testKeepsTheLogInOrderWhenStrokesAreRemovedBetweenEventsOnOtherLayers() async throws {
        let c = try editor()
        let ink = try XCTUnwrap(c.doc.activeLayerId)
        let a = try paint(c, wave(50), "ink-pen", "#2563eb", seed: 1)
        let other = try c.addLayer(name: "Other").id
        _ = try c.fillLayer(layerId: other, color: "#fef3c7")
        try c.setActiveLayer(ink)
        try paint(c, wave(110), "hair-strands", "#dc2626", seed: 2)
        _ = try c.removeStrokes([a])
        XCTAssertEqual(c.doc.paintEvents?.last?.at, 0)
        let t = try c.createReplayTarget(scale: 1)
        try await c.replayPainting(into: t, scale: 1)
        XCTAssertEqual(t.compositePixels().data, pixels(c))
    }

    func testReplaysTheEditedStrokes() async throws {
        let (c, _, _, _, tail) = try painted()
        _ = try c.updateStroke(tail[1], brushId: "pencil-hb", brushChanges: nil, color: "#7c3aed", paint: nil, seed: nil)
        _ = try c.removeStrokes([tail[3]])
        let t = try c.createReplayTarget(scale: 1)
        try await c.replayPainting(into: t, scale: 1)
        XCTAssertEqual(t.compositePixels().data, pixels(c))
    }

    func testSavesAndOpensThemEditableAfterTheLoadAndDropsThemWhenTheLogIsNotSaved() throws {
        let (c, layer, _, _, tail) = try painted()
        let json = c.toJSON()
        XCTAssertEqual(json["strokeTails"]?.objectValue?.keys.map { $0 }, [layer])
        let d = try editor()
        XCTAssertEqual(try d.loadJSON(.object(json)), [])
        XCTAssertEqual(ids(d, layer), tail)
        XCTAssertEqual(pixels(d), pixels(c))
        _ = try c.updateStroke(tail[2], brushId: nil, brushChanges: nil, color: "#0891b2", paint: nil, seed: nil)
        _ = try d.updateStroke(tail[2], brushId: nil, brushChanges: nil, color: "#0891b2", paint: nil, seed: nil)
        XCTAssertEqual(pixels(d), pixels(c))
        // Saved again unchanged: the same file.
        let e = try editor()
        _ = try e.loadJSON(.object(d.toJSON()))
        XCTAssertEqual(JSONValue.object(e.toJSON()), JSONValue.object(d.toJSON()))
        // Without the stroke log the ids name nothing: the strokes load baked.
        XCTAssertNil(c.toJSON(strokes: false)["strokeTails"])
        // A tail naming a stroke the log doesn't have is reported, not trusted.
        var bad = json
        var tails = try XCTUnwrap(bad["strokeTails"]?.objectValue)
        var t = try XCTUnwrap(tails[layer]?.objectValue)
        t["ids"] = .array((t["ids"]?.arrayValue ?? []) + [.string("s999")])
        tails[layer] = .object(t)
        bad["strokeTails"] = .object(tails)
        let f = try editor()
        let problems = try f.loadJSON(.object(bad))
        XCTAssertEqual(problems, ["The editable strokes of layer \"\(layer)\" could not be read (stroke \"s999\" is not in the stroke log on that layer); its strokes load baked into its pixels."])
        XCTAssertEqual(ids(f, layer), [])
    }

    func testPicksTheStrokeUnderAPointOnAPixelLayer() throws {
        let (c, layer, _, _, tail) = try painted()
        let s = try XCTUnwrap(c.editableStrokes(layer)?.first { $0.id == tail[2] })
        let p = s.points[s.points.count / 2]
        XCTAssertEqual(try c.liveStrokeAt(layer, p.x, p.y)?.id, tail[2])
        XCTAssertNil(try c.liveStrokeAt(layer, 255, 2))
    }

    func testAPixelLayerStrokeStaysEditableUntilTheLayerIsFlattened() throws {
        // `paint-editor-live-strokes.test.ts`: a baked stroke says why it can't be edited.
        let c = try PaintEditorController(width: 256, height: 256)
        let baked = try paint(c, wave(80), "ink-pen", seed: 1)
        XCTAssertTrue(c.isStrokeEditable(baked))
        try paint(c, wave(80), "smudge", seed: 2)
        XCTAssertThrowsError(try c.updateStroke(baked, brushId: nil, brushChanges: nil, color: nil, paint: nil, seed: 1)) {
            XCTAssertTrue("\($0)".contains("can't be edited: Painted before its layer was last flattened"), "\($0)")
        }
    }

    func testWithTailLogFillsTheTailsPlacesInTheNewOrderAndMovesLaterEventsDown() throws {
        let brush = try XCTUnwrap(try editor().brushes.first)
        func st(_ id: String) -> RecordedStroke { RecordedStroke(id: id, layerId: "a", brush: brush, color: "#000000", points: [PenPoint(x: 0, y: 0)], seed: 0) }
        let doc = PaintDocumentState(canvas: PaintCanvas(width: 8, height: 8, dpi: 300), paper: normalizePaper([:]), layers: [], activeLayerId: nil, strokes: ["x", "t1", "y", "t2", "t3"].map(st))
        doc.wetEvents = [WetEvent(clock: 0, at: 2, kind: "dry"), WetEvent(clock: 0, at: 4, kind: "dry")]
        doc.paintEvents = [PaintEvent(at: 1, kind: "fill", layerId: "b"), PaintEvent(at: 5, kind: "fill", layerId: "b")]
        let r = withTailLog(doc, ["t1", "t2", "t3"], [st("t3"), st("t1")])
        XCTAssertEqual(r.strokes.map(\.id), ["x", "t3", "y", "t1"])
        XCTAssertEqual(r.wetEvents?.map(\.at), [2, 3])
        XCTAssertEqual(r.paintEvents?.map(\.at), [1, 4])
    }

    func testListsThemLiveSaysWhyTheOthersAreNotAndEditsThemThroughTheTools() async throws {
        let (c, layer, under, _, tail) = try painted()
        let reg = ToolRegistry()
        _ = try reg.register(createPaintEditorToolProvider(c))
        func strokes(_ r: McpToolResult) -> [JSONObject] { r.structuredContent?["strokes"]?.arrayValue?.compactMap(\.objectValue) ?? [] }
        func error(_ r: McpToolResult) -> String? {
            guard r.isError else { return nil }
            if case .text(let t)? = r.content.first { return t }
            return "\(r.content)"
        }
        var r = await reg.callTool("list_strokes", ["live": true, "layerId": .string(layer)])
        XCTAssertNil(error(r))
        XCTAssertEqual(strokes(r).map { $0["id"]?.stringValue }, tail)
        r = await reg.callTool("list_strokes", ["layerId": .string(layer)])
        let first = try XCTUnwrap(strokes(r).first { $0["id"]?.stringValue == under })
        XCTAssertEqual(first["live"], false)
        XCTAssertEqual(first["notEditable"], .string(BAKED_STROKE_REASON))
        let top = try XCTUnwrap(strokes(r).first { $0["id"]?.stringValue == tail[0] })
        XCTAssertEqual(top["live"], true)
        XCTAssertNil(top["notEditable"])
        r = await reg.callTool("update_stroke", ["id": .string(tail[0]), "color": "#16a34a", "brush": ["marks": ["kind": "particles", "count": 5]]])
        XCTAssertNil(error(r))
        XCTAssertEqual(r.structuredContent?["stroke"]?["id"], .string(tail[0]))
        XCTAssertEqual(r.structuredContent?["stroke"]?["color"], "#16a34a")
        XCTAssertEqual(r.structuredContent?["stroke"]?["live"], true)
        r = await reg.callTool("update_stroke", ["id": .string(under), "color": "#16a34a"])
        XCTAssertTrue(error(r)?.contains("can't be edited") == true)
        r = await reg.callTool("update_stroke", ["id": .string(under), "brush": ["tip": ["size": 4]]])
        XCTAssertTrue(error(r)?.contains("can't be edited now. Call list_strokes {live: true}") == true, error(r) ?? "no error")
        r = await reg.callTool("remove_strokes", ["ids": [.string(tail[1]), .string(under)]])
        XCTAssertTrue(error(r)?.contains("can't be edited") == true)
        XCTAssertEqual(c.editableStrokes(layer)?.count, 5)
        let s = try XCTUnwrap(c.editableStrokes(layer)?[2])
        let p = s.points[s.points.count / 2]
        r = await reg.callTool("stroke_at", ["layerId": .string(layer), "x": .number(p.x), "y": .number(p.y)])
        XCTAssertEqual(r.structuredContent?["stroke"]?["id"], .string(s.id))
        XCTAssertEqual(r.structuredContent?["stroke"]?["live"], true)
        r = await reg.callTool("remove_strokes", ["ids": [.string(tail[1])]])
        XCTAssertNil(error(r))
        XCTAssertEqual(r.structuredContent?["removed"], .array([.string(tail[1])]))
    }
}
