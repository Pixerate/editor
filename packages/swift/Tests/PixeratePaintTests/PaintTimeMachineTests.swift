import Foundation
import PixerateCore
import XCTest
@testable import PixeratePaint

/// Time machine rules the conformance scenarios don't reach (`bake_age` while a stroke is live).
final class PaintTimeMachineTests: XCTestCase {
    private let points = [PenPoint(x: 10, y: 30, pressure: 0.8), PenPoint(x: 50, y: 30, pressure: 0.8)]

    func testBakeAgeRefusesWhileAStrokeIsInProgress() throws {
        let c = try PaintEditorController(width: 64, height: 64)
        _ = try c.paintStroke(PaintStrokeInit(seed: 1), points: points)
        _ = try c.setAge(["years": .number(200)])
        let live = try c.beginStroke(PaintStrokeInit(seed: 2))
        live.push(points)
        XCTAssertThrowsError(try c.bakeAge()) { XCTAssertEqual("\($0)", "A stroke is in progress; end or cancel it before baking ageing.") }
        live.cancel()
        XCTAssertNoThrow(try c.bakeAge())
    }

    func testUndoAndRedoOfAnotherStepKeepTheCurrentAge() throws {
        let c = try PaintEditorController(width: 64, height: 64)
        _ = try c.paintStroke(PaintStrokeInit(seed: 1), points: points)
        _ = try c.setAge(["years": .number(300)])
        _ = c.undo()
        XCTAssertEqual(c.getAge().years, 300)
        XCTAssertEqual(c.doc.age?.years, 300)
        _ = c.redo()
        XCTAssertEqual(c.getAge().years, 300)
        XCTAssertEqual(c.doc.age?.years, 300)
    }
}
