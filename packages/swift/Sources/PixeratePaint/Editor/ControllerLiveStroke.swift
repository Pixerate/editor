import Foundation
import PixerateCore
import PixerateRaster

/**
 * A stroke painted from pointer input (`beginStroke` in `paint-editor/controller.ts`): `push` raw
 * pen samples (document pixels) as they arrive, then `end()` (one undo step) or `cancel()`. While
 * it is open the editor draws the layer with the stroke so far.
 */
public final class PaintLiveStroke {
    private weak var controller: PaintEditorController?
    let session: PaintStrokeSession
    public let layerId: String
    /// The document when the stroke began (a wet stroke changes the layer's pixels as it goes).
    private let beforeDoc: PaintDocumentState

    init(_ controller: PaintEditorController, _ session: PaintStrokeSession, before: PaintDocumentState) {
        self.controller = controller
        self.session = session
        layerId = session.layerId
        beforeDoc = before
    }

    /// Whether the stroke paints wet media (its layer shows the wet simulation as it goes).
    public var isWet: Bool { session.initValues.wet != nil }

    /// Whether samples can still be pushed.
    public var open: Bool { session.open && controller?.liveStroke === self }
    /// The raw samples so far (after perspective and stencil snapping).
    public var points: [PenPoint] { session.points }
    /// The brush and colour the stroke paints with.
    public var brush: PaintBrush { session.initValues.brush }
    public var color: String { session.initValues.colorHex }

    /// Adds pen samples and redraws the layer with them.
    public func push(_ points: [PenPoint]) {
        guard open, !points.isEmpty else { return }
        try? session.push(points)
        // The wet layer's display is the layer's pixels: show it (not an undo step).
        if isWet { controller?.wet.syncDisplays() }
        controller?.emit()
    }

    /// Ends the stroke: one undo step (none when no pixel changed).
    @discardableResult
    public func end() throws -> PaintStrokeResult {
        guard let c = controller, c.liveStroke === self else { throw PaintEditorError("This stroke has already ended.") }
        c.liveStroke = nil
        let current = c.doc
        let before = isWet ? beforeDoc : current
        let run: (doc: PaintDocumentState, result: PaintStrokeResult, brush: PaintBrush)
        do { run = try c.endStroke(current, session) } catch {
            c.wetOp = nil
            c.wet.driver = nil
            c.emit()
            throw error
        }
        if let load = run.result.mixerLoad { c.keepLoad(run.brush, load) }
        if run.doc !== current || c.wetOp != nil { c.commit("\(run.brush.name) stroke", c.withWetEvents(run.doc), before: before) } else { c.emit() }
        return run.result
    }

    /// Drops the stroke: the layer goes back to how it was and nothing is recorded.
    public func cancel() {
        guard let c = controller, c.liveStroke === self else { return }
        c.liveStroke = nil
        if isWet {
            // Put the wet paint back as it was before the stroke.
            c.wet.driver = nil
            let snap = c.wetOp?.before
            c.wetOp = nil
            c.pendingWetEvents = []
            try? c.wet.restore(snap)
            c.doc = c.doc.with { $0.layers = beforeDoc.layers }
            c.wet.syncDisplays()
        }
        c.emit()
    }
}

extension PaintEditorController {
    // MARK: - State and events

    /**
     * Calls `listener` after every change to the editor: the document, history, brush, colours,
     * view, guides and live strokes (each sample pushed). Not called while a `group` runs (once
     * at its end) or while `previewPaint` paints. Returns the handle that stops it.
     */
    public func subscribe(_ listener: @escaping () -> Void) -> Cancellable {
        let id = UUID()
        listeners[id] = listener
        return Cancellable { [weak self] in self?.listeners[id] = nil }
    }

    func emit() {
        if previewing || grouping != nil { return }
        version += 1
        for l in Array(listeners.values) { l() }
    }

    // MARK: - Live strokes

    /// The stroke being painted from pointer input, or nil.
    public var activeStroke: PaintLiveStroke? { liveStroke }

    /// Why the editor can't start something now (a stroke is open), or nil.
    public func busyReason() -> String? {
        liveStroke != nil ? "A stroke is in progress; end or cancel it first." : nil
    }

    /**
     * Starts a live stroke for pointer input. Snaps to the perspective guide unless
     * `snapToPerspective` is false; `start` (where the pen went down) picks the colour from the
     * tracing image when it samples colours.
     */
    public func beginStroke(_ initIn: PaintStrokeInit = PaintStrokeInit()) throws -> PaintLiveStroke {
        if liveStroke != nil { throw PaintEditorError("A stroke is in progress; end or cancel it before starting another.") }
        var i = initIn
        if i.snapToPerspective == nil { i.snapToPerspective = true }
        let before = doc
        let session: PaintStrokeSession
        do { session = try sessionFor(doc, i) } catch {
            wetOp = nil
            throw error
        }
        let stroke = PaintLiveStroke(self, session, before: before)
        liveStroke = stroke
        emit()
        return stroke
    }

    // MARK: - Drawing

    /**
     * Composites the canvas (paper, layers, light and the live stroke) tile by tile with the
     * editor's view compositor (or `compositor`: one per view, since "changed" is relative to the
     * compositor's last call), for a canvas view: `onTile` gets each tile's TILE × TILE RGBA
     * (straight alpha) and whether it changed since the last call.
     */
    public func compositeTiles(using compositor: RasterCompositor<ViewLayer, BasicRasterSources>? = nil, _ onTile: (_ tx: Int, _ ty: Int, _ data: [UInt8], _ changed: Bool) -> Void) {
        let rect = RasterRect(x: 0, y: 0, width: doc.canvas.width, height: doc.canvas.height)
        (compositor ?? viewCompositor).compositeTiles(renderLayers(), rect, sources(), onTile, CompositeCallOptions(checkpointLayerId: doc.activeLayerId))
    }

    /// Where a stroke of a stroke layer painted (document pixels), for drawing its pick box; nil when unknown.
    public func liveStrokeArea(_ id: String) -> RasterRect? {
        guard let s = (doc.liveStrokes ?? OrderedMap()).values.flatMap({ $0 }).first(where: { $0.id == id }) else { return nil }
        return strokeArea(s)
    }

    // MARK: - Brushes

    /// The library's brushes as the engine paints them (`state.brushes`), in library order.
    public var brushes: [PaintBrush] { brushEntries.map(\.brush) }

    /**
     * Whether this port paints with `brush`: every engine (dab, eraser, Mixer Brush, blender,
     * smudge, wet, impasto, particle, bristle, sticker), stamp tips included, unless it lays a
     * sticker from a host's sticker library, which has no art here. A brush picker leaves those out.
     */
    public func canPaint(_ brush: PaintBrush) -> Bool {
        // Editor stamps and image sources have their art here; a host's library stickers don't.
        brushStickerRefs(brush).isEmpty && ["dab", "eraser", "mixer", "blender", "smudge", "wet", "impasto", "particle", "bristle", "sticker"].contains(brush.engine)
    }

    // MARK: - Colour

    /// Swaps the paint and second colours (`swapColors`).
    public func swapColors() {
        let c = color
        color = secondaryColor
        secondaryColor = c
    }
}
