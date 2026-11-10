import Foundation
import PixerateCore
@testable import PixeratePaint
import XCTest
@testable import PixeratePaintUI

/// The editor view's culture clock (`runCultureClock`, #731) grows colonies live and commits the run when it ends.
@MainActor
final class PaintCultureClockTests: XCTestCase {
    func testTheCultureClockGrowsLiveAndCommitsOneStepWhenItStops() async throws {
        let model = try PaintEditorModel(controller: PaintEditorController(width: 128, height: 128))
        let c = model.controller
        _ = try c.paintStroke(PaintStrokeInit(brushId: "mycelial-ink", seed: 5), points: [PenPoint(x: 30, y: 60), PenPoint(x: 70, y: 60)])
        let strokeLabel = c.undoLabel
        let clock = Task { await model.runCultureClock() }
        try await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertGreaterThan(c.getCultures().layers[0].tick, 0)
        // Still one run: nothing committed while it grows.
        XCTAssertEqual(c.undoLabel, strokeLabel)
        clock.cancel()
        await clock.value
        XCTAssertEqual(c.undoLabel, "Culture growth")
        XCTAssertTrue((c.doc.paintEvents ?? []).contains { $0.kind == "culture-grow" })

        // Paused: the clock leaves the colony alone.
        model.setCulturePaused(true)
        let paused = c.doc
        let again = Task { await model.runCultureClock() }
        try await Task.sleep(nanoseconds: 150_000_000)
        again.cancel()
        await again.value
        XCTAssertTrue(c.doc === paused)
    }

    /// A replaced document is caught up by the model (`onDocumentReplaced`), not only on the view's mount.
    func testTheModelCatchesUpCulturesWhenTheDocumentIsReplaced() throws {
        let c = try PaintEditorController(width: 128, height: 128)
        let model = try PaintEditorModel(controller: c)
        var replaced: [Int] = []
        let handle = c.onDocumentReplaced { replaced.append(c.doc.canvas.width) }
        _ = try c.newCanvas(width: 96, height: 96, dpi: nil, paper: nil)
        XCTAssertEqual(replaced, [96])
        handle.cancel()
        _ = try c.newCanvas(width: 80, height: 80, dpi: nil, paper: nil)
        XCTAssertEqual(replaced, [96])

        // A growWhileClosed painting last grown ten seconds ago, as an opened file would be.
        _ = try c.paintStroke(PaintStrokeInit(brushId: "mycelial-ink", seed: 61), points: [PenPoint(x: 30, y: 60), PenPoint(x: 70, y: 60)])
        _ = c.setCultureOptions(growWhileClosed: true)
        let tenSecondsAgo = Date().timeIntervalSince1970 * 1000 - 10_000
        c.doc = c.doc.with { $0.lastGrownAt = tenSecondsAgo }
        XCTAssertGreaterThan(c.getCultures().pendingCatchUpTicks, 0)
        c.notifyDocumentReplaced()
        XCTAssertEqual(c.undoLabel, "Growth while closed")
        XCTAssertEqual(c.getCultures().pendingCatchUpTicks, 0)
        XCTAssertNil(model.error)
    }
}
