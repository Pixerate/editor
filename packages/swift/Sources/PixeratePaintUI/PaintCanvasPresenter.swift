import CoreGraphics
import Foundation
import PixeratePaint
import PixerateRaster

/// One tile of the canvas as an image, for drawing at `rect` (document pixels).
public struct PaintCanvasTile {
    public let tx: Int
    public let ty: Int
    /// Where to draw `image`: the tile, plus `PaintCanvasPresenter.overlap` pixels of the tiles to its right and below.
    public let rect: CGRect
    public let image: CGImage
}

/**
 * Keeps a document-sized bitmap in step with the controller, tile by tile
 * (`PaintCanvasPresenter` in `paint-editor/ui.ts`): it composites with a compositor of its own
 * (whose per-tile cache makes unchanged tiles free) and copies only the tiles that changed into
 * the bitmap, premultiplying them for CoreGraphics.
 *
 * The bitmap is BGRA (premultiplied first, 32-bit little endian), the layout the GPU takes as is,
 * so drawing never converts channels. A view draws `tiles()`: each tile is its own image, rebuilt
 * only when its pixels change, so a stroke uploads the few tiles it touches instead of the whole
 * canvas every frame. Each tile image reaches `overlap` pixels into its right and lower
 * neighbours (drawn after it), so the edges of adjacent tiles never show a seam when the view is
 * scaled or turned.
 */
@MainActor
public final class PaintCanvasPresenter {
    /// How far each tile image reaches into its right and lower neighbours (pixels).
    public static let overlap = 2

    private let controller: PaintEditorController
    private let compositor = createPaintCompositor()
    private var pixels: [UInt8] = []
    private var size = (width: 0, height: 0)
    private var drawn = Set<TileKey>()
    private var tileImages: [TileKey: PaintCanvasTile] = [:]
    private var order: [TileKey] = []
    private var cached: CGImage?
    private var renderedVersion = -1
    /// Tiles copied by the last `render`.
    public private(set) var lastTilesDrawn = 0

    private static let space = CGColorSpace(name: CGColorSpace.sRGB)!
    private static let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)

    public init(controller: PaintEditorController) {
        self.controller = controller
    }

    /// Brings the bitmap up to date; returns the tiles drawn.
    @discardableResult
    public func render() -> Int {
        let c = controller.doc.canvas
        if c.width != size.width || c.height != size.height || pixels.isEmpty {
            size = (c.width, c.height)
            pixels = [UInt8](repeating: 0, count: Swift.max(1, c.width * c.height * 4))
            drawn = []
            tileImages = [:]
            order = []
            for t in tilesInRect(RasterRect(x: 0, y: 0, width: c.width, height: c.height)) { order.append(tileKey(t.tx, t.ty)) }
        }
        let w = c.width, h = c.height
        var count = 0
        var changedTiles: [(tx: Int, ty: Int)] = []
        pixels.withUnsafeMutableBufferPointer { buf in
            let base = buf.baseAddress!
            controller.compositeTiles(using: compositor) { tx, ty, data, changed in
                let key = tileKey(tx, ty)
                if !changed && drawn.contains(key) { return }
                drawn.insert(key)
                count += 1
                changedTiles.append((tx, ty))
                let ox = tx * TILE, oy = ty * TILE
                let cw = Swift.min(TILE, w - ox), ch = Swift.min(TILE, h - oy)
                data.withUnsafeBufferPointer { src in
                    guard let srcPtr = src.baseAddress else { return }
                    for y in 0..<ch {
                        var s = (y * TILE) * 4
                        var d = ((oy + y) * w + ox) * 4
                        for _ in 0..<cw {
                            // RGBA straight → BGRA premultiplied.
                            let a = UInt16(srcPtr[s + 3])
                            if a == 255 {
                                base[d] = srcPtr[s + 2]; base[d + 1] = srcPtr[s + 1]; base[d + 2] = srcPtr[s]; base[d + 3] = 255
                            } else if a == 0 {
                                base[d] = 0; base[d + 1] = 0; base[d + 2] = 0; base[d + 3] = 0
                            } else {
                                base[d] = UInt8((UInt16(srcPtr[s + 2]) * a + 127) / 255)
                                base[d + 1] = UInt8((UInt16(srcPtr[s + 1]) * a + 127) / 255)
                                base[d + 2] = UInt8((UInt16(srcPtr[s]) * a + 127) / 255)
                                base[d + 3] = UInt8(a)
                            }
                            s += 4
                            d += 4
                        }
                    }
                }
            }
        }
        lastTilesDrawn = count
        if count > 0 {
            cached = nil
            // A tile's image holds the edges of its right and lower neighbours too.
            var rebuild: [TileKey: (tx: Int, ty: Int)] = [:]
            for (tx, ty) in changedTiles {
                for (x, y) in [(tx, ty), (tx - 1, ty), (tx, ty - 1), (tx - 1, ty - 1)] where x >= 0 && y >= 0 { rebuild[tileKey(x, y)] = (x, y) }
            }
            for (key, t) in rebuild where drawn.contains(key) {
                if let tile = makeTile(t.tx, t.ty) { tileImages[key] = tile }
            }
        }
        return count
    }

    /// Tile (tx, ty) of the bitmap as an image, with `overlap` pixels of its neighbours.
    private func makeTile(_ tx: Int, _ ty: Int) -> PaintCanvasTile? {
        let w = size.width, h = size.height
        let ox = tx * TILE, oy = ty * TILE
        let cw = Swift.min(TILE + Self.overlap, w - ox), ch = Swift.min(TILE + Self.overlap, h - oy)
        guard cw > 0, ch > 0 else { return nil }
        let row = cw * 4
        var data = Data(count: row * ch)
        data.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) in
            pixels.withUnsafeBytes { src in
                for y in 0..<ch {
                    dst.baseAddress!.advanced(by: y * row).copyMemory(from: src.baseAddress!.advanced(by: ((oy + y) * w + ox) * 4), byteCount: row)
                }
            }
        }
        guard let provider = CGDataProvider(data: data as CFData),
              let image = CGImage(width: cw, height: ch, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: row, space: Self.space, bitmapInfo: Self.bitmapInfo, provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
        else { return nil }
        return PaintCanvasTile(tx: tx, ty: ty, rect: CGRect(x: ox, y: oy, width: cw, height: ch), image: image)
    }

    private func refresh() {
        if renderedVersion != controller.version || pixels.isEmpty {
            renderedVersion = controller.version
            render()
        }
    }

    /**
     * The canvas as tile images, brought up to date when the editor changed since the last call,
     * in the order to draw them (rows top to bottom, each left to right). Unchanged tiles are the
     * same image objects as last time, so the GPU keeps their textures.
     */
    public func tiles() -> [PaintCanvasTile] {
        refresh()
        return order.compactMap { tileImages[$0] }
    }

    /// The canvas as one image, brought up to date when the editor changed since the last call. Copies the whole bitmap: draw `tiles()` instead.
    public func image() -> CGImage? {
        refresh()
        if cached == nil, !pixels.isEmpty {
            let w = size.width, h = size.height
            guard let provider = CGDataProvider(data: Data(pixels) as CFData) else { return nil }
            cached = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4, space: Self.space, bitmapInfo: Self.bitmapInfo, provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
        }
        return cached
    }
}
