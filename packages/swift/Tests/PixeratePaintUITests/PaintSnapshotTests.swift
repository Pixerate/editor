#if os(macOS)
import Foundation
import ImageIO
import PixeratePaint
import SwiftUI
import UniformTypeIdentifiers
import XCTest
@testable import PixeratePaintUI

/// Renders the editor with `ImageRenderer` and keeps the PNGs (paths printed) under the test's temporary directory.
@MainActor
final class PaintSnapshotTests: XCTestCase {
    private func snapshotDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("PixeratePaintUITests", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func writePNG(_ image: CGImage, _ name: String) throws -> URL {
        let url = try snapshotDir().appendingPathComponent(name)
        let dest = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(dest, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        print("SNAPSHOT \(url.path)")
        return url
    }

    /// RGBA bytes of an image (premultiplied, sRGB).
    private func pixels(_ image: CGImage) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: image.width * image.height * 4)
        out.withUnsafeMutableBytes { buf in
            let ctx = CGContext(data: buf.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        return out
    }

    private func paintedModel() throws -> PaintEditorModel {
        let model = try PaintEditorModel(controller: PaintEditorController(width: 512, height: 384))
        let c = model.controller
        _ = try c.setColor("#1d4ed8")
        _ = try c.setBrushFacets(["tip": ["size": 24]])
        _ = try c.paintStroke(PaintStrokeInit(seed: 7), points: (0...40).map { i in PenPoint(x: 60 + Double(i) * 10, y: 190 + sin(Double(i) / 5) * 90, pressure: 0.4 + Double(i % 10) / 20) })
        _ = try c.setColor("#dc2626")
        _ = try c.paintStroke(PaintStrokeInit(seed: 8), points: [PenPoint(x: 120, y: 80), PenPoint(x: 260, y: 140), PenPoint(x: 400, y: 70)])
        _ = c.setSymmetry(["mode": "vertical", "center": ["x": 256, "y": 192]])
        return model
    }

    func testCanvasSnapshot() throws {
        let model = try paintedModel()
        model.viewport = (640, 480)
        model.fitView()
        // Without pointer input: ImageRenderer draws AppKit views (the input view) as placeholders.
        let renderer = ImageRenderer(content: PaintCanvasView(model: model, interactive: false).frame(width: 640, height: 480))
        renderer.scale = 1
        let image = try XCTUnwrap(renderer.cgImage)
        _ = try writePNG(image, "paint-canvas.png")
        XCTAssertEqual(image.width, 640)
        XCTAssertEqual(image.height, 480)
        let px = pixels(image)
        // Not blank: the grey surround, the paper and both strokes are there.
        var colours = Set<UInt32>()
        for i in stride(from: 0, to: px.count, by: 4) { colours.insert(UInt32(px[i]) << 16 | UInt32(px[i + 1]) << 8 | UInt32(px[i + 2])) }
        XCTAssertGreaterThan(colours.count, 50)
        let centre = (420 * 640 + 360) * 4
        XCTAssertGreaterThan(px[centre + 0], 150, "the paper is light")
        let corner = (5 * 640 + 5) * 4
        XCTAssertLessThan(px[corner], 80, "the surround is dark")
        let blueish = stride(from: 0, to: px.count, by: 4).contains { px[$0 + 2] > 150 && px[$0] < 80 }
        let reddish = stride(from: 0, to: px.count, by: 4).contains { px[$0] > 150 && px[$0 + 2] < 80 && px[$0 + 1] < 80 }
        XCTAssertTrue(blueish && reddish, "both strokes are drawn")
    }
}
#endif
