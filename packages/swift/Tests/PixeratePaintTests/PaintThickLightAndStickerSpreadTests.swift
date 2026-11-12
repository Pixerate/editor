import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// Thick paint whose stroke also paints light (glow gel, or any thick brush on a layer that holds
/// light), and the spacing that spreads large stickers out along the path.
final class PaintThickLightAndStickerSpreadTests: XCTestCase {
    private func wave(_ y: Double) -> [PenPoint] {
        (0..<24).map { i in PenPoint(x: 20 + Double(i) * 12, y: y + 20 * sin(Double(i) / 4), pressure: 0.7) }
    }

    private func paint(_ c: PaintEditorController, _ brushId: String, _ y: Double) throws {
        _ = try c.setBrushFacets([:], id: brushId)
        let s = try c.beginStroke()
        s.push(wave(y))
        _ = try s.end()
    }

    private func litLight(_ c: PaintEditorController) -> Int {
        guard let id = c.doc.activeLayerId, let l = c.doc.light?.get(id) else { return 0 }
        return readRegion(l, RasterRect(x: 0, y: 0, width: 320, height: 200)).filter { $0 > 0 }.count
    }

    func testGlowGelPaintsThickPaintAndLight() throws {
        let c = try PaintEditorController(width: 320, height: 200)
        try paint(c, "glow-gel", 100)
        XCTAssertEqual(c.doc.strokes.count, 1)
        XCTAssertGreaterThan(litLight(c), 0, "glow gel lights the layer")
        XCTAssertNotNil(c.doc.thick?.get(c.doc.activeLayerId ?? ""), "glow gel lays thick paint")
    }

    func testThickBrushPaintsOnALayerThatHoldsLight() throws {
        let c = try PaintEditorController(width: 320, height: 200)
        try paint(c, "glow-wash", 60)
        XCTAssertGreaterThan(litLight(c), 0)
        for id in ["impasto-brush", "scarab-lacquer", "metallic-paint"] {
            XCTAssertNoThrow(try paint(c, id, 140), id)
        }
        XCTAssertEqual(c.doc.strokes.count, 4)
    }

    func testStickerSpacingEasesTowardTheLargeSpacing() {
        XCTAssertEqual(stickerSpacing(density: 0.35, size: 24), 1 / 1.4, accuracy: 1e-9)
        XCTAssertEqual(stickerSpacing(density: 0.35, size: STICKER_REACH), 1 / 1.4, accuracy: 1e-9)
        XCTAssertEqual(stickerSpacing(density: 0.35, size: STICKER_SPREAD_SIZE), STICKER_LARGE_SPACING, accuracy: 1e-9)
        XCTAssertEqual(stickerSpacing(density: 0.35, size: 1000), STICKER_LARGE_SPACING, accuracy: 1e-9)
        let mid = stickerSpacing(density: 0.35, size: 160)
        XCTAssertGreaterThan(mid, 1 / 1.4)
        XCTAssertLessThan(mid, STICKER_LARGE_SPACING)
        XCTAssertEqual(stickerSpacing(density: 0.1, size: 1000), 2.5, accuracy: 1e-9)
    }
}
