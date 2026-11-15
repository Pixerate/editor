import Foundation
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// `placeImage` / `place_image` (paint-editor-place-image.test.ts).
final class PlaceImageTests: XCTestCase {
    /// A 2 × 2 PNG: red, green / blue, white.
    private let quad = Data(encodePng(2, 2, [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])).base64EncodedString()

    func testFitsTheImageOnANewActiveLayerInOneUndoStep() throws {
        let c = try PaintEditorController(width: 120, height: 80)
        let before = c.listLayers().count
        let layer = try c.placeImage(png: quad, name: "Photo")
        XCTAssertEqual(layer.name, "Photo")
        XCTAssertEqual(c.doc.activeLayerId, layer.id)
        XCTAssertEqual(layer.bounds, RasterRect(x: 20, y: 0, width: 80, height: 80))
        XCTAssertEqual(c.undoLabel, "Place image")
        _ = c.undo()
        XCTAssertEqual(c.listLayers().count, before)
        XCTAssertEqual(try c.placeImage(png: quad, fit: "cover").bounds, RasterRect(x: 0, y: 0, width: 120, height: 80))
        XCTAssertThrowsError(try c.placeImage(png: quad, fit: "stretch")) { XCTAssertEqual("\($0)", "fit \"stretch\" is not one of contain, cover.") }
    }

    func testResamplesOnPremultipliedColour() {
        let out = resampleImage(PixelImage(width: 2, height: 1, data: [255, 0, 0, 255, 0, 0, 0, 0]), 8, 1)
        for x in 0..<8 where out.data[x * 4 + 3] > 0 { XCTAssertEqual(Array(out.data[x * 4..<x * 4 + 3]), [255, 0, 0]) }
    }
}
