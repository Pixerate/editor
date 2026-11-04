import CoreGraphics
import Foundation
import PixeratePaint
import PixerateRaster

/**
 * Keeps a document-sized bitmap in step with the controller, tile by tile
 * (`PaintCanvasPresenter` in `paint-editor/ui.ts`): it composites with a compositor of its own
 * (whose per-tile cache makes unchanged tiles free) and copies only the tiles that changed into
 * the bitmap, premultiplying them for CoreGraphics.
 */
@MainActor
public final class PaintCanvasPresenter {
    private let controller: PaintEditorController
    private let compositor = createPaintCompositor()
    private var context: CGContext?
    private var size = (width: 0, height: 0)
    private var drawn = Set<TileKey>()
    private var cached: CGImage?
    private var renderedVersion = -1
    /// Tiles copied by the last `render`.
    public private(set) var lastTilesDrawn = 0

    public init(controller: PaintEditorController) {
        self.controller = controller
    }

    /// Brings the bitmap up to date; returns the tiles drawn.
    @discardableResult
    public func render() -> Int {
        let c = controller.doc.canvas
        if c.width != size.width || c.height != size.height || context == nil {
            size = (c.width, c.height)
            context = CGContext(data: nil, width: c.width, height: c.height, bitsPerComponent: 8, bytesPerRow: c.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            drawn = []
        }
        guard let ctx = context, let base = ctx.data?.assumingMemoryBound(to: UInt8.self) else { return 0 }
        let w = c.width, h = c.height
        var count = 0
        controller.compositeTiles(using: compositor) { tx, ty, data, changed in
            let key = tileKey(tx, ty)
            if !changed && drawn.contains(key) { return }
            drawn.insert(key)
            count += 1
            let ox = tx * TILE, oy = ty * TILE
            let cw = Swift.min(TILE, w - ox), ch = Swift.min(TILE, h - oy)
            data.withUnsafeBufferPointer { src in
                for y in 0..<ch {
                    var s = (y * TILE) * 4
                    var d = ((oy + y) * w + ox) * 4
                    for _ in 0..<cw {
                        let a = UInt16(src[s + 3])
                        if a == 255 {
                            base[d] = src[s]; base[d + 1] = src[s + 1]; base[d + 2] = src[s + 2]; base[d + 3] = 255
                        } else {
                            base[d] = UInt8((UInt16(src[s]) * a + 127) / 255)
                            base[d + 1] = UInt8((UInt16(src[s + 1]) * a + 127) / 255)
                            base[d + 2] = UInt8((UInt16(src[s + 2]) * a + 127) / 255)
                            base[d + 3] = UInt8(a)
                        }
                        s += 4
                        d += 4
                    }
                }
            }
        }
        lastTilesDrawn = count
        if count > 0 || cached == nil { cached = ctx.makeImage() }
        return count
    }

    /// The canvas as an image, brought up to date when the editor changed since the last call.
    public func image() -> CGImage? {
        if renderedVersion != controller.version || cached == nil {
            renderedVersion = controller.version
            render()
        }
        return cached
    }
}
