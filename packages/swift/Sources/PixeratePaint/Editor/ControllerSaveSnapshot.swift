import Foundation
import PixerateCore
import PixerateRaster

/**
 * A save taken in two steps, so an app can keep its main thread free: `saveSnapshot` reads the
 * document where it lives (cheap: the JSON tree and the pixels to encode, copied on write), and
 * `document()` / `thumbnailPng()` do the slow PNG encoding on any thread, in parallel.
 * `document()` is exactly what `toJSON(strokeLog:)` would have returned when the snapshot was taken.
 */
public struct PaintSaveSnapshot: Sendable {
    /// The document with a placeholder for each PNG still to encode.
    let pending: JSONObject
    let encodes: PendingEncodes
    let thumbnail: (width: Int, height: Int, data: [UInt8])?
    let thumbnailSize: (width: Int, height: Int)?

    /// PNGs the snapshot put off encoding.
    public var pendingPngCount: Int { encodes.pngs.count }

    /// The saved document, as `toJSON(strokeLog:)` returns it. Encodes every PNG: call it off the main thread.
    public func document() -> JSONObject {
        encodes.resolve(pending)
    }

    /// The thumbnail asked for in `saveSnapshot(thumbnailMaxSide:)` as PNG bytes, as `exportPng(scale:)`
    /// returns them; nil when none was asked for. Call it off the main thread.
    public func thumbnailPng() -> [UInt8]? {
        guard let full = thumbnail, let size = thumbnailSize else { return nil }
        if size.width == full.width, size.height == full.height { return encodePng(full.width, full.height, full.data) }
        return encodePng(size.width, size.height, downsampleRgba(full.data, full.width, full.height, Double(size.width), Double(size.height)))
    }
}

extension PaintEditorController {
    /**
     * A snapshot to save from (`PaintSaveSnapshot`): the document as `toJSON(strokeLog:)` saves it,
     * with its PNGs left to encode later, and optionally the composite for a thumbnail whose longest
     * side is at most `thumbnailMaxSide` pixels (as `exportPng(scale:)`, never upscaled). Take it
     * where the controller is used; encode it anywhere.
     */
    public func saveSnapshot(strokeLog: StrokeLogOption = .all, thumbnailMaxSide: Double? = nil) -> PaintSaveSnapshot {
        let (json, encodes) = PngDeferral.run { toJSON(strokeLog: strokeLog) }
        var thumbnail: (width: Int, height: Int, data: [UInt8])?
        var size: (width: Int, height: Int)?
        if let maxSide = thumbnailMaxSide, maxSide > 0 {
            let full = compositePixels()
            let s = Swift.min(1, maxSide / Double(Swift.max(1, Swift.max(full.width, full.height))))
            thumbnail = full
            size = s == 1
                ? (full.width, full.height)
                : (Swift.max(1, Int(JS.round(Double(full.width) * s))), Swift.max(1, Int(JS.round(Double(full.height) * s))))
        }
        return PaintSaveSnapshot(pending: json, encodes: encodes, thumbnail: thumbnail, thumbnailSize: size)
    }
}
