import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// Change notifications and live strokes (`subscribe`, `beginStroke`), which canvas views use.
final class PaintLiveStrokeTests: XCTestCase {
    private let points = [PenPoint(x: 20, y: 30, pressure: 0.4), PenPoint(x: 60, y: 50, pressure: 0.8), PenPoint(x: 110, y: 40, pressure: 0.6), PenPoint(x: 140, y: 90, pressure: 1)]

    func testListenersHearChangesOnceAGroupEndsAndNeverDuringAPreview() throws {
        let c = try PaintEditorController(width: 128, height: 128)
        var heard = 0
        let sub = c.subscribe { heard += 1 }
        _ = try c.setColor("#ff0000")
        XCTAssertGreaterThan(heard, 0)
        var n = heard
        try c.group("Two layers") {
            _ = try c.addLayer()
            _ = try c.addLayer()
            XCTAssertEqual(heard, n, "nothing while the group runs")
        }
        XCTAssertEqual(heard, n + 1, "once at the group's end")
        n = heard
        _ = try c.previewPaint { id in _ = try c.paintStroke(PaintStrokeInit(layerId: id, seed: 1), points: self.points) }
        XCTAssertEqual(heard, n, "a preview changes nothing listeners can see")
        _ = c.undo()
        XCTAssertGreaterThan(heard, n)
        n = heard
        sub.cancel()
        _ = c.redo()
        XCTAssertEqual(heard, n)
    }

    func testALiveStrokeInBatchesPaintsWhatPaintStrokeDoes() throws {
        let a = try PaintEditorController(width: 160, height: 120)
        let b = try PaintEditorController(width: 160, height: 120)
        var i = PaintStrokeInit(seed: 11)
        i.snapToPerspective = false
        let live = try a.beginStroke(i)
        XCTAssertThrowsError(try a.beginStroke()) { XCTAssertEqual("\($0)", "A stroke is in progress; end or cancel it before starting another.") }
        XCTAssertThrowsError(try a.paintStroke(PaintStrokeInit(), points: points))
        XCTAssertNil(a.undo(), "undo waits for the stroke")
        for p in points { live.push([p]) }
        let shown = a.compositePixels().data
        let result = try live.end()
        XCTAssertThrowsError(try live.end()) { XCTAssertEqual("\($0)", "This stroke has already ended.") }
        let direct = try b.paintStroke(PaintStrokeInit(seed: 11), points: points)
        XCTAssertEqual(result.bounds, direct.bounds)
        XCTAssertEqual(result.dabs, direct.dabs)
        XCTAssertEqual(a.compositePixels().data, b.compositePixels().data)
        XCTAssertNotEqual(shown, try PaintEditorController(width: 160, height: 120).compositePixels().data, "the open stroke showed its paint before it ended")
        XCTAssertEqual(a.undoLabel, b.undoLabel)
        XCTAssertEqual(a.strokes.first?.points, b.strokes.first?.points)
    }

    func testCancellingALiveStrokeLeavesNoTrace() throws {
        let c = try PaintEditorController(width: 96, height: 96)
        let blank = c.compositePixels().data
        let live = try c.beginStroke(PaintStrokeInit(seed: 2))
        live.push(points)
        XCTAssertNotEqual(c.compositePixels().data, blank)
        live.cancel()
        XCTAssertNil(c.activeStroke)
        XCTAssertEqual(c.compositePixels().data, blank)
        XCTAssertNil(c.undoLabel)
        XCTAssertTrue(c.strokes.isEmpty)
    }

    func testALiveStrokeRedrawsAViewOnlyWhereItPaintedAndMatchesAFullComposite() throws {
        let c = try PaintEditorController(width: 600, height: 400)
        let compositor = createPaintCompositor()
        var shown = [UInt8](repeating: 0, count: 600 * 400 * 4)
        func draw() {
            c.compositeTiles(using: compositor) { tx, ty, data, changed in
                guard changed else { return }
                for y in 0..<TILE where ty * TILE + y < 400 {
                    for x in 0..<TILE where tx * TILE + x < 600 {
                        for k in 0..<4 { shown[((ty * TILE + y) * 600 + tx * TILE + x) * 4 + k] = data[(y * TILE + x) * 4 + k] }
                    }
                }
            }
        }
        draw()
        let since = c.version
        XCTAssertNil(c.dirtySince(since), "nothing changed since")
        var i = PaintStrokeInit(seed: 5)
        i.snapToPerspective = false
        let live = try c.beginStroke(i)
        XCTAssertEqual(c.dirtySince(since), nil, "beginning a stroke may change anything")
        draw()
        // Across tile corners, a batch at a time, drawing after each.
        let path = [PenPoint(x: 200, y: 200, pressure: 0.5), PenPoint(x: 250, y: 240, pressure: 0.7), PenPoint(x: 270, y: 270, pressure: 0.9), PenPoint(x: 330, y: 250, pressure: 0.6), PenPoint(x: 520, y: 300, pressure: 1)]
        var painted: [RasterRect] = []
        for p in path {
            let before = c.version
            live.push([p])
            painted += try XCTUnwrap(c.dirtySince(before), "a dab stroke says where it painted")
            draw()
        }
        XCTAssertFalse(painted.isEmpty)
        XCTAssertEqual(shown, c.compositePixels(wet: "display").data, "the view drawn from dirty rectangles is the full composite")
        // Anything else redraws everything.
        let before = c.version
        _ = try c.setColor("#336699")
        XCTAssertNil(c.dirtySince(before))
        try live.end()
        draw()
        XCTAssertEqual(shown, c.compositePixels(wet: "display").data)
    }

    func testALiveWetStrokeRecompositesOnlyTouchedTilesOnPush() throws {
        let c = try PaintEditorController(width: 1024, height: 1024, brushId: "watercolor-round", color: "#1e5aa8")
        // Seed wet paint across 4 tiles so the wet lane already has multiple active tiles.
        _ = try c.paintStroke(PaintStrokeInit(seed: 1), points: [
            PenPoint(x: 100, y: 100, pressure: 0.8),
            PenPoint(x: 400, y: 100, pressure: 0.8),
            PenPoint(x: 400, y: 400, pressure: 0.8),
            PenPoint(x: 100, y: 400, pressure: 0.8),
        ])
        _ = c.wet.advance(2)
        let view = createPaintCompositor()
        c.compositeTiles(using: view) { _, _, _, _ in }

        var i = PaintStrokeInit(seed: 9)
        i.snapToPerspective = false
        let live = try c.beginStroke(i)
        c.compositeTiles(using: view) { _, _, _, _ in }

        // Pushing a dab inside tile (0, 0) must only mark and recomposite tile (0, 0), not all 4 active wet tiles.
        let before = c.version
        live.push([PenPoint(x: 80, y: 80, pressure: 0.7), PenPoint(x: 95, y: 95, pressure: 0.7)])
        let dirty = try XCTUnwrap(c.dirtySince(before))
        XCTAssertFalse(dirty.isEmpty)
        var changedTiles = 0
        c.compositeTiles(using: view) { _, _, _, changed in
            if changed { changedTiles += 1 }
        }
        XCTAssertEqual(changedTiles, 1, "pushing a wet dab in tile (0, 0) recomposites only that tile, not every active tile in the wet lane")
        try live.end()
    }

    func testViewMathsAndPenInput() {
        let canvas = PaintCanvas(width: 200, height: 100, dpi: 72)
        var view = PaintView()
        view.zoom = 2
        view.rotation = 90
        view.panX = 10
        let s = documentToScreen(view, canvas, viewport: 400, 300, 50, 20)
        let d = screenToDocument(view, canvas, viewport: 400, 300, s.x, s.y)
        XCTAssertEqual(d.x, 50, accuracy: 1e-9)
        XCTAssertEqual(d.y, 20, accuracy: 1e-9)
        // Mice paint at full pressure; pens bring theirs, their lean turned with the view.
        XCTAssertEqual(pointerToPenPoint(PaintPointerSample(pointerType: "mouse", pressure: 0.5), 1, 2).pressure, 1)
        let p = pointerToPenPoint(PaintPointerSample(pointerType: "pen", pressure: 0.25, altitudeAngle: 0.8, azimuthAngle: 2), 1, 2, view: view)
        XCTAssertEqual(p.pressure, 0.25)
        XCTAssertEqual(p.altitude, 0.8)
        XCTAssertEqual(p.azimuth!, 2 - Double.pi / 2, accuracy: 1e-12)
        XCTAssertTrue(isPalmTouch(Point2(x: 120, y: 130), Point2(x: 100, y: 100), hand: "right"))
        XCTAssertFalse(isPalmTouch(Point2(x: 20, y: 130), Point2(x: 100, y: 100), hand: "right"))
        XCTAssertEqual(fitZoom(canvas, viewport: 448, 300), 2)
    }

    func testPathMappedEffectPaintPassesStrokeCentrelineAndRefusesEffectsWithoutPathControls() async throws {
        var calls: [(id: String, width: Int, height: Int, values: JSONObject?)] = []
        let provider = FakeEffectProvider { id, w, h, req in
            calls.append((id, w, h, req.values))
        }
        let c = try PaintEditorController(width: 80, height: 60, brushId: "ink-pen")
        c.setEffectsProvider(provider)

        // Effects without a path control refuse by: "path".
        do {
            _ = try await c.setEffectPaint("fake.gradient", map: ["by": "path"])
            XCTFail("Expected fake.gradient to refuse by: \"path\"")
        } catch {
            XCTAssertTrue("\(error)".contains("has no path control"))
            XCTAssertTrue("\(error)".contains("by: \"stroke\""))
            XCTAssertTrue("\(error)".contains("by: \"canvas\""))
        }

        // fake.trail has a format: "svg-path" control and accepts by: "path".
        let ep = try await c.setEffectPaint("fake.trail", values: ["color": "#e11d48", "width": 14], map: ["by": "path"])
        XCTAssertEqual(ep.map, PaintEffectStrokeMap(by: "path"))
        XCTAssertEqual(ep.json["map"], ["by": "path"])

        _ = try c.setBrushFacets(["tip": ["size": 12, "hardness": 1, "opacity": 1, "flow": 1], "behaviour": ["grain": 0]])
        calls.removeAll()
        let r = try c.paintStroke(PaintStrokeInit(seed: 1), points: [
            PenPoint(x: 10, y: 20, pressure: 1),
            PenPoint(x: 40, y: 20, pressure: 1),
            PenPoint(x: 70, y: 20, pressure: 1),
        ])
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls[0].id, "fake.trail")
        XCTAssertEqual(calls[0].width, 80)
        XCTAssertEqual(calls[0].height, 60)
        XCTAssertEqual(calls[0].values?["path"], [10, 20, 40, 20, 70, 20])
        XCTAssertEqual( try c.pickColor(40, 20, layerId: r.layerId)["color"], "#e11d48")
        XCTAssertEqual( try c.pickColor(40, 50, layerId: r.layerId)["alpha"], 0)

        // Replay shifts the path control points in canvas pixels.
        calls.removeAll()
        _ = try c.replayStrokes(ReplayOptions(strokeIds: [r.strokeId!], dy: 25))
        XCTAssertEqual(calls.last?.values?["path"], [10, 45, 40, 45, 70, 45])
        XCTAssertEqual(try c.pickColor(40, 45, layerId: r.layerId)["color"], "#e11d48")

        // Very long strokes (> MAX_EFFECT_PATH_POINTS = 256) are simplified rather than refused.
        calls.removeAll()
        let manyPoints = (0..<400).map { i in PenPoint(x: 4 + (Double(i) / 399) * 72, y: 30, pressure: 1) }
        _ = try c.paintStroke(PaintStrokeInit(seed: 2), points: manyPoints)
        let pathArr = try XCTUnwrap(calls.last?.values?["path"]?.arrayValue)
        XCTAssertEqual(pathArr.count, MAX_EFFECT_PATH_POINTS * 2)
        XCTAssertEqual(pathArr[0], 4)
        XCTAssertEqual(pathArr[1], 30)
        XCTAssertEqual(pathArr[pathArr.count - 2], 76)
        XCTAssertEqual(pathArr[pathArr.count - 1], 30)
    }

    func testHandPaintedPathStrokesPaintAlongTheirPathOnEitherKindOfProvider() async throws {
        for provider: EffectProvider in [FakeEffectProvider(), AsyncOnlyProvider()] {
            let c = try PaintEditorController(width: 96, height: 64, brushId: "ink-pen")
            c.setEffectsProvider(provider)
            _ = try await c.setEffectPaint("fake.trail", values: ["color": "#ff0000", "width": 12], map: ["by": "path"])
            _ = try c.setBrushFacets(["tip": ["size": 24, "hardness": 1, "opacity": 1, "flow": 1], "behaviour": ["grain": 0]])
            let s = try c.beginStroke()
            s.push([PenPoint(x: 20, y: 4, pressure: 1), PenPoint(x: 20, y: 60, pressure: 1)])
            if provider is AsyncOnlyProvider {
                XCTAssertTrue(s.needsPathRender)
                XCTAssertThrowsError(try s.end()) { XCTAssertTrue("\($0)".contains("await renderPath()")) }
                XCTAssertTrue(s.open)
                try await s.renderPath()
            }
            XCTAssertFalse(s.needsPathRender)
            let r = try s.end()
            // On the path, away from the line across the middle (y = 32) that fake.trail draws with no path.
            XCTAssertEqual(try c.pickColor(20, 10, layerId: r.layerId)["color"], "#ff0000")
            XCTAssertEqual(try c.pickColor(30, 32, layerId: r.layerId)["alpha"], 0)
            XCTAssertEqual(c.doc.strokes.count, 1)
            XCTAssertEqual(c.doc.strokes[0].effect?.values["path"], [20, 4, 20, 60])
        }
    }

    func testAHandPaintedPathStrokeShowsTheEffectAlongThePathSoFarWhileItIsDrawn() async throws {
        var renders = 0
        let c = try PaintEditorController(width: 96, height: 64, brushId: "ink-pen")
        c.setEffectsProvider(AsyncOnlyProvider { renders += 1 })
        _ = try await c.setEffectPaint("fake.trail", values: ["color": "#ff0000", "width": 12], map: ["by": "path"])
        _ = try c.setBrushFacets(["tip": ["size": 24, "hardness": 1, "opacity": 1, "flow": 1], "behaviour": ["grain": 0]])
        let s = try c.beginStroke()
        // The live layer's alpha at a point.
        func shown(_ x: Int, _ y: Int) -> Int {
            guard let l = findLayer(c.currentLayers(), s.layerId)?.layer else { return -1 }
            return readPixel(l.pixelSurface, x, y)[3]
        }
        s.push([PenPoint(x: 20, y: 4, pressure: 1), PenPoint(x: 20, y: 30, pressure: 1)])
        // Until a render along the path lands, the stroke shows the no-path picture.
        XCTAssertEqual(shown(20, 10), 0)
        XCTAssertTrue(s.needsPathPreview)
        await s.renderPreview()
        XCTAssertFalse(s.needsPathPreview)
        XCTAssertEqual(shown(20, 10), 255)
        XCTAssertEqual(c.doc.strokes.count, 0)
        // New samples paint into the preview, and the next render takes the longer path.
        s.push([PenPoint(x: 20, y: 60, pressure: 1), PenPoint(x: 70, y: 60, pressure: 1)])
        XCTAssertTrue(s.needsPathPreview)
        await s.renderPreview()
        XCTAssertEqual(shown(20, 50), 255)
        // The preview rendered the whole path: the stroke ends without another render.
        let before = renders
        XCTAssertFalse(s.needsPathRender)
        let r = try s.end()
        XCTAssertEqual(renders, before)
        XCTAssertEqual(try c.pickColor(20, 10, layerId: r.layerId)["color"], "#ff0000")
        XCTAssertEqual(try c.pickColor(50, 60, layerId: r.layerId)["color"], "#ff0000")
        XCTAssertEqual(try c.pickColor(40, 32, layerId: r.layerId)["alpha"], 0)
        XCTAssertEqual(c.doc.strokes.count, 1)
    }

    func testPathStrokesRefuseAMissingRenderAndWetBrushesByHand() async throws {
        let c = try PaintEditorController(width: 96, height: 64, brushId: "ink-pen")
        c.setEffectsProvider(AsyncOnlyProvider())
        _ = try await c.setEffectPaint("fake.trail", values: ["color": "#ff0000", "width": 12], map: ["by": "path"])
        let points = [PenPoint(x: 20, y: 4, pressure: 1), PenPoint(x: 20, y: 60, pressure: 1)]
        XCTAssertThrowsError(try c.paintStroke(PaintStrokeInit(seed: 1), points: points)) { XCTAssertTrue("\($0)".contains("prepareStrokePathEffect")) }
        XCTAssertThrowsError(try c.beginStroke(PaintStrokeInit(brushId: "watercolor-round"))) { XCTAssertTrue("\($0)".contains("wet media")) }
    }

    func testAStrokeLayerKeepsARenderForEveryPathStroke() async throws {
        var renders = 0
        let c = try PaintEditorController(width: 96, height: 64, brushId: "ink-pen")
        c.setEffectsProvider(FakeEffectProvider { _, _, _, _ in renders += 1 })
        _ = try await c.setEffectPaint("fake.trail", values: ["color": "#ff0000", "width": 12], map: ["by": "path"])
        _ = try c.addLayer(type: "strokes")
        var ids: [String] = []
        for i in 0..<10 {
            let x = Double(8 + i * 8)
            ids.append(try c.paintStroke(PaintStrokeInit(seed: i), points: [PenPoint(x: x, y: 4, pressure: 1), PenPoint(x: x, y: 60, pressure: 1)]).strokeId!)
        }
        let painted = renders
        _ = try c.updateStroke(ids[0], brushId: nil, brushChanges: nil, color: nil, paint: nil, seed: 7)
        XCTAssertEqual(renders, painted)
    }
}

/// Renders like a GPU provider: results only ever arrive later, and there is no `renderSync`.
private final class AsyncOnlyProvider: EffectProvider {
    private let fake = FakeEffectProvider()
    private let onRender: () -> Void
    init(onRender: @escaping () -> Void = {}) { self.onRender = onRender }
    var id: String { fake.id }
    var name: String { fake.name }
    var capabilities: JSONObject { fake.capabilities }
    func list(_ options: EffectSearchOptions) async throws -> [EffectDescription] { try await fake.list(options) }
    func search(_ query: String, _ options: EffectSearchOptions) async throws -> [EffectDescription] { try await fake.search(query, options) }
    func describe(_ id: String) async throws -> EffectDescription { try await fake.describe(id) }
    func createRenderer(_ id: String, width: Int, height: Int) throws -> EffectRenderer {
        AsyncOnlyRenderer(try fake.createRenderer(id, width: width, height: height), onRender)
    }
}

private final class AsyncOnlyRenderer: EffectRenderer {
    private let inner: EffectRenderer
    private let onRender: () -> Void
    init(_ inner: EffectRenderer, _ onRender: @escaping () -> Void) {
        self.inner = inner
        self.onRender = onRender
    }
    var effectId: String { inner.effectId }
    var width: Int { inner.width }
    var height: Int { inner.height }
    func render(_ request: EffectRenderRequest) async throws -> EffectPixels {
        await Task.yield()
        onRender()
        return try await inner.render(request)
    }
    func dispose() { inner.dispose() }

    func testTheVortexGuideDrawsEverySymmetryCopy() throws {
        let c = try PaintEditorController(width: 128, height: 128)
        let one = try c.beginStroke(PaintStrokeInit(brushId: "vortex", seed: 1))
        one.push([PenPoint(x: 40, y: 64, pressure: 1)])
        let single = one.vortexGuides.count
        XCTAssertGreaterThan(single, 0)
        one.cancel()
        _ = c.setSymmetry(["enabled": true, "mode": "vertical", "centerX": 64, "centerY": 64])
        let two = try c.beginStroke(PaintStrokeInit(brushId: "vortex", seed: 1))
        two.push([PenPoint(x: 40, y: 64, pressure: 1)])
        XCTAssertEqual(two.vortexGuides.count, 2 * single)
        two.cancel()
    }
}
