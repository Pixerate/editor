import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// Erasers and light on stroke layers (#720): the layer's pixels and light are its strokes drawn
/// again, so they match the same strokes painted one by one on a pixel layer after every edit.
final class PaintStrokeLayerEraserLightTests: XCTestCase {
    private let w = 160, h = 120
    private var size: (Double, Double) { (Double(w), Double(h)) }

    private func wave(_ y: Double, _ n: Int = 20) -> [PenPoint] {
        (0..<n).map { i in PenPoint(x: 10 + Double(i) * 7, y: y + sin(Double(i) / 3) * 10, pressure: 0.4 + 0.6 * sin(Double(i) / Double(n - 1) * .pi)) }
    }

    private func down(_ x: Double, _ n: Int = 14) -> [PenPoint] {
        (0..<n).map { i in PenPoint(x: x, y: 5 + Double(i) * 8, pressure: 0.9) }
    }

    private func light(_ c: PaintEditorController, _ layerId: String) -> [UInt8] {
        guard let l = c.doc.light?.get(layerId) else { return [UInt8](repeating: 0, count: w * h) }
        return readRegion(l, RasterRect(x: 0, y: 0, width: w, height: h))
    }

    /// The stroke layer's strokes painted one by one on a pixel layer of a new editor.
    private func pixelPaint(_ strokes: [RecordedStroke]) throws -> (pixels: [UInt8], light: [UInt8]) {
        let d = try PaintEditorController(width: size.0, height: size.1)
        let layer = try d.addLayer()
        for s in strokes {
            var i = PaintStrokeInit(layerId: layer.id, color: s.color, seed: s.seed, copies: s.copies ?? [], load: s.load)
            i.fixedBrush = s.brush
            _ = try d.paintStroke(i, points: s.points)
        }
        return (d.compositePixels().data, light(d, layer.id))
    }

    private func expectRedrawn(_ c: PaintEditorController, _ layerId: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let ref = try pixelPaint(c.doc.liveStrokes?.get(layerId) ?? [])
        XCTAssertEqual(light(c, layerId), ref.light, "light", file: file, line: line)
        XCTAssertEqual(c.compositePixels().data, ref.pixels, "pixels", file: file, line: line)
    }

    private func paint(_ c: PaintEditorController, _ brushId: String, _ color: String?, _ seed: Int, _ points: [PenPoint]) throws -> String {
        var i = PaintStrokeInit(color: color, seed: seed)
        i.brushId = brushId
        return try c.paintStroke(i, points: points).strokeId!
    }

    func testAnEraserOnAStrokeLayerIsRedrawnAfterEditsUnderAndOfIt() throws {
        let c = try PaintEditorController(width: size.0, height: size.1)
        let layer = try c.addLayer(type: "strokes")
        let a = try paint(c, "ink-pen", "#dc2626", 1, wave(40))
        let b = try paint(c, "hair-strands", "#2563eb", 2, wave(85))
        let e = try paint(c, "eraser-soft", nil, 3, down(70))
        XCTAssertEqual(c.doc.liveStrokes?.get(layer.id)?.map { $0.brush.engine }, ["dab", "particle", "eraser"])
        try expectRedrawn(c, layer.id)
        _ = try c.updateStroke(a, brushId: nil, brushChanges: nil, color: "#16a34a", paint: nil, seed: 9)
        try expectRedrawn(c, layer.id)
        _ = try c.editStrokePoints(e, points: nil, transform: ["dx": 30])
        try expectRedrawn(c, layer.id)
        _ = try c.removeStrokes([a])
        _ = try c.editStrokePoints(b, points: nil, transform: ["dy": -40])
        try expectRedrawn(c, layer.id)
    }

    func testLightOnAStrokeLayerComesAndGoesWithItsStrokes() throws {
        let c = try PaintEditorController(width: size.0, height: size.1)
        let layer = try c.addLayer(type: "strokes")
        let neon = try paint(c, "neon-marker", "#22d3ee", 1, wave(40))
        let hl = try paint(c, "highlighter", "#fff200", 2, wave(80))
        let pen = try paint(c, "ink-pen", "#111827", 3, down(50))
        let e = try paint(c, "eraser-soft", nil, 4, down(110))
        XCTAssertNotNil(c.doc.light?.get(layer.id))
        try expectRedrawn(c, layer.id)
        _ = try c.editStrokePoints(neon, points: nil, transform: ["dy": 30])
        try expectRedrawn(c, layer.id)
        _ = try c.reorderStroke(pen, 0)
        try expectRedrawn(c, layer.id)
        _ = try c.editStrokePoints(e, points: down(70), transform: nil)
        try expectRedrawn(c, layer.id)
        _ = try c.removeStrokes([neon, hl])
        XCTAssertNil(c.doc.light?.get(layer.id), "no stroke lays light, so the layer has none")
        try expectRedrawn(c, layer.id)
        _ = c.undo()
        XCTAssertNotNil(c.doc.light?.get(layer.id))
        try expectRedrawn(c, layer.id)
    }

    func testErasersCannotBeBred() throws {
        let c = try PaintEditorController(width: size.0, height: size.1)
        let eraser = try XCTUnwrap(c.getBrush("eraser-soft"))
        XCTAssertNil(liveStrokeRefusal(eraser), "a stroke layer takes erasers")
        XCTAssertEqual(evolutionStrokeRefusal(eraser), "The Soft eraser brush erases, and a bred stroke is suggested on a layer of its own where there is nothing to erase; breed painted strokes instead.")
        XCTAssertNil(liveStrokeRefusal(try XCTUnwrap(c.getBrush("neon-marker"))), "a stroke layer takes light")
    }
}
