import CoreGraphics
import CoreText
import PixerateCore
import PixerateGeometry
import PixerateVector
import XCTest
@testable import PixerateVectorUI

/// The CoreGraphics scene drawer and the CoreText shaper.
final class VectorDrawingTests: XCTestCase {
    override func tearDown() {
        // Back to the metric shaper the conformance tests expect.
        setVectorTextShaper(nil)
        super.tearDown()
    }

    /// The RGBA bytes of the pixel at (x, y), y down.
    private func pixel(_ image: CGImage, _ x: Int, _ y: Int) -> [UInt8] {
        let ctx = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        let data = ctx.data!.assumingMemoryBound(to: UInt8.self)
        let i: Int = (y * image.width + x) * 4
        return [data[i], data[i + 1], data[i + 2], data[i + 3]]
    }

    func testParsesCSSColours() {
        let red = parseCSSColor("#ff0000")!.components!
        XCTAssertEqual(red, [1, 0, 0, 1])
        let half = parseCSSColor("rgba(0, 255, 0, 0.5)")!.components!
        XCTAssertEqual(half, [0, 1, 0, 0.5])
        XCTAssertEqual(parseCSSColor("#0f08")!.components!.map { (c: CGFloat) -> Double in (Double(c) * 255).rounded() }, [0, 255, 0, 136])
        XCTAssertNil(parseCSSColor("url(#x)"))
        XCTAssertEqual(vectorHex(parseCSSColor("#12abef")!), "#12abef")
        XCTAssertEqual(vectorHex(parseCSSColor("#12abef80")!), "#12abef80")
    }

    func testDrawsFillsStrokesGradientsAndTheArtboard() throws {
        let c = try VectorEditorController(document: VectorDocument(width: 100, height: 100))
        _ = try c.addShape(VectorShapeInput(kind: "rect", x: 10, y: 10, width: 30, height: 30, style: ["fill": "#ff0000", "stroke": .null]))
        _ = try c.addShape(VectorShapeInput(kind: "rect", x: 60, y: 10, width: 30, height: 30, style: ["fill": .null, "stroke": "#0000ff", "strokeWidth": 6]))
        let g = try c.addShape(VectorShapeInput(kind: "rect", x: 10, y: 60, width: 80, height: 30, style: ["stroke": .null]))
        _ = c.setGradient(["type": "linear", "angle": 90, "stops": [["offset": 0, "color": "#000000"], ["offset": 1, "color": "#ffffff"]]], ids: [g])
        let scene = try c.sceneRenderData()
        let image = try XCTUnwrap(VectorSceneDrawer.image(scene, width: 100, height: 100))
        XCTAssertEqual(pixel(image, 25, 25), [255, 0, 0, 255])
        // The hollow square's middle shows the white artboard; its edge is blue.
        XCTAssertEqual(pixel(image, 75, 25), [255, 255, 255, 255])
        XCTAssertEqual(pixel(image, 60, 25), [0, 0, 255, 255])
        // Left to right, dark to light.
        let left = pixel(image, 14, 75)
        let right = pixel(image, 86, 75)
        XCTAssertLessThan(left[0], 60)
        XCTAssertGreaterThan(right[0], 195)
    }

    func testDrawsTheDocumentTransformAndOpacity() throws {
        let c = try VectorEditorController(document: VectorDocument(width: 50, height: 50))
        let id = try c.addShape(VectorShapeInput(kind: "rect", x: 0, y: 0, width: 50, height: 50, style: ["fill": "#000000", "stroke": .null]))
        _ = try c.setStyle(["opacity": 0.5], ids: [id])
        c.setViewport(x: 10, y: 10, zoom: 2)
        let image = try XCTUnwrap(VectorSceneDrawer.image(try c.sceneRenderData(), width: 120, height: 120))
        XCTAssertEqual(pixel(image, 5, 5)[3], 0)
        let mid = pixel(image, 100, 100)
        XCTAssertEqual(mid[3], 255)
        XCTAssertEqual(Double(mid[0]), 128, accuracy: 2)
    }

    func testCoreTextShaperMeasuresAndOutlines() {
        let shaper = CoreTextVectorShaper()
        let font = TextFont(family: "sans-serif", weight: 400, italic: false, size: 20)
        let carets = shaper.measure(Array("Hello".utf16), font)
        XCTAssertEqual(carets.count, 6)
        XCTAssertEqual(carets[0], 0)
        for i in 1..<carets.count { XCTAssertGreaterThan(carets[i], carets[i - 1]) }
        let bold = shaper.measure(Array("Hello".utf16), TextFont(family: "sans-serif", weight: 700, italic: false, size: 20))
        XCTAssertGreaterThan(bold[5], carets[5])
        let m = shaper.metrics(font)
        XCTAssertGreaterThan(m.ascent, 10)
        XCTAssertGreaterThan(m.descent, 1)
        XCTAssertTrue(shaper.resolve(font).available)
        XCTAssertFalse(shaper.resolve(TextFont(family: "No Such Family Anywhere", weight: 400, italic: false, size: 20)).available)
        XCTAssertTrue(shaper.hasOutlines)
        let outline = shaper.outline(Array("H".utf16), font, x: 100, y: 50, vertical: false) ?? []
        XCTAssertFalse(outline.isEmpty)
        // Outlines sit on the baseline at (x, y), y down: above the baseline is smaller y.
        let b = bezierPathBounds(.commands(outline))!
        XCTAssertGreaterThanOrEqual(b.minX, 100)
        XCTAssertLessThanOrEqual(b.maxY, 50.5)
        XCTAssertLessThan(b.minY, 40)
        XCTAssertTrue(shaper.families()?.contains("sans-serif") == true)
    }

    func testTextDrawsAsOutlinesWithTheCoreTextShaper() throws {
        setVectorTextShaper(CoreTextVectorShaper())
        let c = try VectorEditorController(document: VectorDocument(width: 200, height: 100))
        _ = try c.addText(VectorTextInput(text: "Hi", x: 10, y: 60, font: ["fontFamily": "sans-serif", "fontSize": 48]))
        let scene = try c.sceneRenderData()
        let node = try XCTUnwrap(scene["nodes"]?.arrayValue?.first)
        XCTAssertEqual(node["kind"]?.stringValue, "path")
        XCTAssertFalse((node["d"]?.stringValue ?? "").isEmpty)
        let image = try XCTUnwrap(VectorSceneDrawer.image(scene, width: 200, height: 100))
        // Some of the glyphs' pixels are dark.
        var dark = 0
        for x in stride(from: 10, to: 90, by: 2) {
            for y in stride(from: 20, to: 62, by: 2) where pixel(image, x, y)[0] < 128 { dark += 1 }
        }
        XCTAssertGreaterThan(dark, 20)
    }
}
