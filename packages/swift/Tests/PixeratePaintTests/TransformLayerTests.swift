import Foundation
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// `transformLayer` / `transform_layer` (paint-editor-transform-layer.test.ts).
final class TransformLayerTests: XCTestCase {
    /// A 2 × 2 PNG: red, green / blue, white.
    private let quad = Data(encodePng(2, 2, [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])).base64EncodedString()

    private func px(_ c: PaintEditorController, _ id: String, _ x: Int, _ y: Int) -> [Int] {
        readPixel(findLayer(c.doc.layers, id)!.layer.pixelSurface, x, y)
    }

    func testMovesScalesRotatesAndFlips() throws {
        let c = try PaintEditorController(width: 120, height: 80)
        let id = try c.placeImage(png: quad).id
        XCTAssertEqual(try c.transformLayer(translateX: 10, translateY: -5).bounds, RasterRect(x: 30, y: -5, width: 80, height: 80))
        XCTAssertEqual(px(c, id, 35, 5), [255, 0, 0, 255])
        XCTAssertEqual(c.undoLabel, "Transform layer")
        _ = c.undo()
        XCTAssertEqual(try c.transformLayer(scaleX: 0.5, scaleY: 0.5).bounds, RasterRect(x: 40, y: 20, width: 40, height: 40))
        _ = c.undo()
        _ = try c.transformLayer(rotation: 90)
        XCTAssertEqual(px(c, id, 95, 5), [255, 0, 0, 255])
        XCTAssertEqual(px(c, id, 25, 5), [0, 0, 255, 255])
        _ = c.undo()
        _ = try c.transformLayer(scaleX: -1)
        XCTAssertEqual(px(c, id, 95, 5), [255, 0, 0, 255])
        XCTAssertThrowsError(try c.transformLayer(scaleX: 0)) { XCTAssertEqual("\($0)", "scaleX 0 is out of range; use 0.01..64 (negative flips).") }
    }
}
