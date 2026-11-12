import PixerateCore
import PixeratePaint
import XCTest
@testable import PixeratePaintUI

/// The Specialty tab and the brush panel's specialty guide (`SpecialtyPanel`, `SpecialtyGuideCard`).
@MainActor
final class PaintSpecialtyModelTests: XCTestCase {
    func testSpecialtyTabSitsAfterPaperAndLightsUpWhileSpecialtyPaintIsInPlay() throws {
        let model = try PaintEditorModel(controller: PaintEditorController(width: 120, height: 80))
        XCTAssertEqual(Array(model.tabs.prefix(3)), [.color, .paper, .specialty])
        XCTAssertEqual(PaintPanelTab.specialty.label, "Specialty")
        XCTAssertFalse(model.specialtyInPlay)
        XCTAssertTrue(model.specialtyGuides.isEmpty)
        XCTAssertEqual(model.specialtyPicks.map(\.id), ["ferrofluid", "uv-marker", "thermo-ink", "soap-film", "ghost-wash", "mutation-wash", "turing-wash"])
        model.selectBrush("soap-film")
        XCTAssertTrue(model.specialtyInPlay)
        XCTAssertTrue(model.isSpecialtyBrush("soap-film"))
        XCTAssertFalse(model.isSpecialtyBrush("pencil-6b"))
    }

    func testGuideActionsSetTheCanvasUp() throws {
        let model = try PaintEditorModel(controller: PaintEditorController(width: 120, height: 80))
        model.selectBrush("uv-marker")
        var guide = try XCTUnwrap(model.specialtyGuides.first)
        XCTAssertEqual(guide.kind, "fluorescence")
        XCTAssertFalse(guide.ready)
        XCTAssertEqual(guide.actions.map(\.id), ["uv-on"])
        model.runSpecialtyAction(guide.actions[0])
        XCTAssertTrue(model.uvLight.on)
        guide = try XCTUnwrap(model.specialtyGuides.first)
        XCTAssertEqual(guide.status, "UV blacklight is on (100%)")

        model.selectBrush("thermo-ink")
        model.warmCanvas()
        XCTAssertTrue(try XCTUnwrap(model.specialtyGuides.first).ready)
        model.clearHeat()

        model.selectBrush("ferrofluid")
        let add = try XCTUnwrap(model.specialtyGuides.first?.actions.first)
        XCTAssertEqual(add.arguments, ["x": 60, "y": 40])
        model.runSpecialtyAction(add)
        XCTAssertEqual(model.magnets.count, 1)
        XCTAssertNil(model.error)
    }
}
