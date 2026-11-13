import PixerateCore
import PixeratePaint
import XCTest

/// Control labels for the effect panels (`humanizeParameterId`, `parameterLabel` in the TS core).
final class EffectControlLabelTests: XCTestCase {
    func testIdsReadAsWords() {
        XCTAssertEqual(humanizeParameterId("uFlowSpeed"), "Flow speed")
        XCTAssertEqual(humanizeParameterId("flow_speed"), "Flow speed")
        XCTAssertEqual(humanizeParameterId("flowSpeed"), "Flow speed")
        XCTAssertEqual(humanizeParameterId("uBackgroundAlpha"), "Background alpha")
        XCTAssertEqual(humanizeParameterId("soft-light"), "Soft light")
        XCTAssertEqual(humanizeParameterId("layer2Blend"), "Layer2 blend")
        XCTAssertEqual(humanizeParameterId("usage"), "Usage", "a leading u is dropped only before a capital")
        XCTAssertEqual(humanizeParameterId("u"), "U")
        XCTAssertEqual(humanizeParameterId(""), "")
    }

    func testASchemaTitleWinsOverTheName() {
        XCTAssertEqual(effectControlLabel("uScale", ["title": "Cell size"]), "Cell size")
        XCTAssertEqual(effectControlLabel("uScale", ["title": ""]), "Scale")
        XCTAssertEqual(effectControlLabel("uScale", [:]), "Scale")
    }
}
