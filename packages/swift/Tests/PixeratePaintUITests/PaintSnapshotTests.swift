#if os(macOS)
import Foundation
import ImageIO
import PixeratePaint
import PixerateRaster
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

    func testPlaceImageOnLargeSheetTilesLayerView() throws {
        let model = try PaintEditorModel(controller: PaintEditorController(width: 2880, height: 1800))
        // Smooth spatial gradient (no step edges) so interpolation differences stay <= 2,
        // while any tile flip or shift produces large errors across tile boundaries.
        let w = 1024, h = 1024
        var rgba = [UInt8](repeating: 0, count: w * h * 4)
        for y in 0..<h {
            for x in 0..<w {
                let i = (y * w + x) * 4
                rgba[i] = UInt8(x * 255 / (w - 1))
                rgba[i + 1] = UInt8(y * 255 / (h - 1))
                rgba[i + 2] = UInt8(((x + y) * 255) / (w + h - 2))
                rgba[i + 3] = 255
            }
        }
        let png = Data(encodePng(w, h, rgba)).base64EncodedString()
        let placed = try model.controller.placeImage(png: png)
        XCTAssertEqual(placed.bounds, RasterRect(x: 540, y: 0, width: 1800, height: 1800))

        let vw = 1200, vh = 800
        model.viewport = (Double(vw), Double(vh))
        model.fitView()
        let m = paintViewMatrix(model.view, model.canvas, viewport: Double(vw), Double(vh))
        let t = CGAffineTransform(a: m[0], b: m[2], c: m[1], d: m[3], tx: m[4], ty: m[5])

        let presenter = PaintCanvasPresenter(controller: model.controller)
        let tiles = presenter.tiles()
        let fullImage = try XCTUnwrap(presenter.image())

        // Reference: draw fullImage with transform `t` in top-down coordinates.
        var refBytes = [UInt8](repeating: 0, count: vw * vh * 4)
        refBytes.withUnsafeMutableBytes { buf in
            let ctx = CGContext(
                data: buf.baseAddress, width: vw, height: vh, bitsPerComponent: 8, bytesPerRow: vw * 4,
                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )!
            ctx.translateBy(x: 0, y: CGFloat(vh))
            ctx.scaleBy(x: 1, y: -1)
            ctx.concatenate(t)
            ctx.translateBy(x: 0, y: CGFloat(fullImage.height))
            ctx.scaleBy(x: 1, y: -1)
            ctx.draw(fullImage, in: CGRect(x: 0, y: 0, width: fullImage.width, height: fullImage.height))
        }

        // Actual: PaintTilesLayerView hosted in an NSView/NSWindow or rendered via its layer.
        let tilesView = PaintTilesLayerView()
        tilesView.frame = CGRect(x: 0, y: 0, width: vw, height: vh)
        tilesView.update(PaintTilesView(tiles: tiles, transform: t, smooth: model.view.zoom < 2))
        tilesView.layoutSubtreeIfNeeded()

        var layerBytes = [UInt8](repeating: 0, count: vw * vh * 4)
        layerBytes.withUnsafeMutableBytes { buf in
            let ctx = CGContext(
                data: buf.baseAddress, width: vw, height: vh, bitsPerComponent: 8, bytesPerRow: vw * 4,
                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )!
            // Render the AppKit layer hierarchy from top-down.
            ctx.translateBy(x: 0, y: CGFloat(vh))
            ctx.scaleBy(x: 1, y: -1)
            tilesView.layer!.render(in: ctx)
        }

        // Also write PNGs to inspect if needed.
        if let refProvider = CGDataProvider(data: Data(refBytes) as CFData),
           let refImg = CGImage(width: vw, height: vh, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: vw * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: refProvider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) {
            _ = try writePNG(refImg, "place-image-ref.png")
        }
        if let layProvider = CGDataProvider(data: Data(layerBytes) as CFData),
           let layImg = CGImage(width: vw, height: vh, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: vw * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: layProvider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) {
            _ = try writePNG(layImg, "place-image-layer.png")
        }

        // Compare pixels inside the placed image across multiple tile rows.
        var maxDiff = 0
        var diffCount = 0
        for sy in stride(from: 100, to: 700, by: 20) {
            for sx in stride(from: 300, to: 900, by: 20) {
                let i = (sy * vw + sx) * 4
                let dr = abs(Int(refBytes[i]) - Int(layerBytes[i]))
                let dg = abs(Int(refBytes[i + 1]) - Int(layerBytes[i + 1]))
                let db = abs(Int(refBytes[i + 2]) - Int(layerBytes[i + 2]))
                let d = max(dr, dg, db)
                if d > maxDiff { maxDiff = d }
                if d > 4 { diffCount += 1 }
            }
        }
        XCTAssertEqual(diffCount, 0, "maxDiff=\(maxDiff)")
    }
}
#endif
