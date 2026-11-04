import Foundation
import PixerateCore
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
}
