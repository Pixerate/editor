import Foundation
import PixerateCore
import PixerateRaster

/// What `previewPaint` painted: where, the layer's pixels there and the picture with them.
public struct PaintPreview {
    public var bounds: RasterRect?
    public var pixels: [UInt8]
    public var composite: [UInt8]
}

extension PaintEditorController {
    /**
     * Runs `fn` as one undo step named `label`: every change it makes is undone together. Nested
     * groups join the outer one. If `fn` throws, its changes are put back and nothing is recorded.
     */
    public func group<T>(_ label: String, _ fn: () throws -> T) throws -> T {
        if grouping != nil { return try fn() }
        let before = doc
        grouping = (label, before, false)
        let result: T
        do {
            result = try fn()
        } catch {
            grouping = nil
            doc = before
            throw error
        }
        let g = grouping!
        grouping = nil
        if g.changed && doc !== before {
            undoStack.append(HistoryEntry(label: label, before: before, after: doc))
            if undoStack.count > historyLimit { undoStack.removeFirst() }
            redoStack = []
        }
        // Listeners hear the group once, at its end.
        emit()
        return result
    }

    /**
     * What `fn` would paint, without changing anything: it runs on a new empty layer (above
     * `aboveId`, or at the bottom), and the layer's pixels and the picture with them come back while
     * the document, history and counters stay as they were.
     */
    public func previewPaint(aboveId: String? = nil, bottom: Bool = false, _ fn: (String) throws -> Void) throws -> PaintPreview {
        if previewing { throw PaintEditorError("A preview is already running.") }
        let saved = (doc: doc, undo: undoStack, redo: redoStack, strokeCounter: strokeCounter, seedCounter: seedCounter, mixerLoad: mixerLoad)
        previewing = true
        defer {
            doc = saved.doc
            undoStack = saved.undo
            redoStack = saved.redo
            strokeCounter = saved.strokeCounter
            seedCounter = saved.seedCounter
            mixerLoad = saved.mixerLoad
            previewing = false
        }
        let layer = try addLayer(name: "Preview", aboveId: aboveId)
        if bottom { _ = try moveLayer(layer.id, 0, parentId: .some(nil)) }
        try fn(layer.id)
        guard let found = getLayer(layer.id), found.isPixel, let b = contentBounds(found.pixelSurface) else { return PaintPreview(bounds: nil, pixels: [], composite: []) }
        let x0 = Swift.max(0, b.x), y0 = Swift.max(0, b.y)
        let x1 = Swift.min(doc.canvas.width, b.x + b.width), y1 = Swift.min(doc.canvas.height, b.y + b.height)
        guard x1 > x0, y1 > y0 else { return PaintPreview(bounds: nil, pixels: [], composite: []) }
        let box = RasterRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
        let composite = createPaintCompositor().composite(renderLayers(), box, BasicRasterSources(width: doc.canvas.width, height: doc.canvas.height))
        return PaintPreview(bounds: box, pixels: readRegion(found.pixelSurface, box), composite: composite)
    }
}
