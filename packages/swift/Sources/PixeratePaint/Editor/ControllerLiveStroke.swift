import Foundation
import PixerateCore
import PixerateRaster

/// How many changes `dirtySince` remembers.
private let MAX_DIRTY_LOG = 256

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
    /// A path-mapped effect's preview: the stroke so far painted from the effect rendered along the
    /// path drawn so far (`renderPreview()`), shown instead of `session` once a render has landed.
    private var preview: PaintStrokeSession?
    /// The path render the preview last asked for, and the one it got.
    private var previewKey: String?
    private var previewRendering = false
    private var previewLanded: (key: String, pixels: EffectPaintPixels)?
    /// What the editor shows while the stroke is open.
    var shown: PaintStrokeSession { preview ?? session }

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
    /// The live vortex guide (`vortexGuideSegments`) for the samples so far, with every symmetry copy.
    public var vortexGuides: [(from: Point2, to: Point2, kind: String)] {
        vortexGuideSegments(session.points, session.initValues.brush, session.initValues.copies)
    }

    /// Adds pen samples and redraws the layer with them.
    public func push(_ points: [PenPoint]) {
        guard open, !points.isEmpty else { return }
        // A push that fails part way may have painted anywhere it reached.
        let had = session.points.count
        let rects = try? session.push(points)
        if let preview { _ = try? preview.push(Array(session.points[had...])) }
        if isWet {
            // The wet layer's display is the layer's pixels: show it (not an undo step).
            let beforeVersion = controller?.version
            controller?.wet.syncDisplaysGpu()
            if controller?.version == beforeVersion {
                controller?.emit(rects)
            }
        } else {
            // Only where the dabs landed changed.
            controller?.emit(rects)
        }
    }

    /// The paint `end()` paints the stroke again with: a path-mapped effect's whole path isn't
    /// known until now, so the live stroke was a preview (`renderPreview()`). Nil when it already
    /// painted with its path.
    private var pathPaint: PaintEffectPaint? {
        guard let c = controller, !isWet, let e = session.initValues.effect?.source, e.map?.by == "path", !session.points.isEmpty else { return nil }
        let p = c.strokeEffectWithPath(e, session.points)
        return p.key == e.key ? nil : p
    }

    /// Whether `renderPath()` has to be awaited before `end()`: the stroke's path render isn't there,
    /// and its renderer can't draw it synchronously.
    public var needsPathRender: Bool {
        guard let c = controller, let p = pathPaint else { return false }
        if previewLanded?.key == p.key { return false }
        return (c.effectPaintImage(p) ?? c.renderEffectPaintSync(p)) == nil
    }

    /// Renders the stroke's path so `end()` can paint with it. The stroke stays open until then.
    public func renderPath() async throws {
        guard let c = controller, let p = pathPaint else { return }
        if let landed = previewLanded, landed.key == p.key {
            c.cacheEffectPaintImage(p, landed.pixels)
            return
        }
        try await c.prepareEffectPaints([p])
    }

    /// Whether the effect shown while drawing is behind the path drawn so far (a path-mapped effect,
    /// `map: { by: 'path' }`): `renderPreview()` brings it up to date. False while one renders.
    public var needsPathPreview: Bool {
        guard open, !previewRendering, let p = pathPaint else { return false }
        return p.key != previewKey
    }

    /**
     * Renders the effect along the path drawn so far and paints the stroke again with it, so the
     * effect follows the pen while it draws (`previewPathStroke` in `controller.ts`). One at a time:
     * call it again when it returns while `needsPathPreview`. A failed render leaves the preview as
     * it was; `renderPath()` (or `end()`) reports it.
     */
    public func renderPreview() async {
        guard needsPathPreview, let c = controller, let p = pathPaint, let source = session.initValues.effect?.source else { return }
        let key = p.key
        previewKey = key
        previewRendering = true
        defer { previewRendering = false }
        let pixels: EffectPaintPixels
        if let have = c.effectPaintImage(p) { pixels = have } else {
            guard let made = try? await c.renderEffectPaintPixels(p) else { return }
            pixels = made
        }
        previewLanded = (key, pixels)
        guard open else { return }
        var reInit = session.initValues
        reInit.effect = (source, pixels)
        // The samples are snapped already.
        reInit.inputFilter = nil
        guard let re = try? PaintStrokeSession(reInit) else { return }
        re.maskStencils = session.maskStencils
        let rects = (try? re.push(session.points)) ?? []
        let was = shown.bounds
        preview = re
        c.emit(was.map { rects + [$0] } ?? rects)
    }

    /// Ends the stroke: one undo step (none when no pixel changed). Throws, leaving the stroke open,
    /// when `needsPathRender`.
    @discardableResult
    public func end() throws -> PaintStrokeResult {
        guard let c = controller, c.liveStroke === self else { throw PaintEditorError("This stroke has already ended.") }
        var pathEffect: (source: PaintEffectPaint, pixels: EffectPaintPixels)?
        if let p = pathPaint {
            if let landed = previewLanded, landed.key == p.key { c.cacheEffectPaintImage(p, landed.pixels) }
            guard let pixels = c.effectPaintImage(p) ?? c.renderEffectPaintSync(p) else {
                throw PaintEditorError("The effect paint \"\(p.effect)\" is not rendered along this stroke; await renderPath() before ending it.")
            }
            pathEffect = (p, pixels)
        }
        c.liveStroke = nil
        let current = c.doc
        let before = isWet || c.tempLayerTargets[layerId] != nil ? beforeDoc : current
        let run: (doc: PaintDocumentState, result: PaintStrokeResult, brush: PaintBrush)
        do {
            var finalSession = session
            if let pathEffect {
                var reInit = session.initValues
                reInit.effect = pathEffect
                reInit.inputFilter = nil
                let re = try PaintStrokeSession(reInit)
                re.maskStencils = session.maskStencils
                _ = try re.push(session.points)
                finalSession = re
            }
            run = try c.endStroke(current, finalSession)
        } catch {
            c.wetOp = nil
            c.wet.driver = nil
            c.emit()
            throw error
        }
        if let load = run.result.mixerLoad { c.keepLoad(run.brush, load) }
        if run.doc !== current || c.wetOp != nil {
            c.commit("\(run.brush.name) stroke", c.withWetEvents(run.doc), before: before)
            if let sid = run.result.strokeId, let stroke = c.doc.strokes.last(where: { $0.id == sid }) {
                c.recordMutationStroke(stroke, run.result.bounds)
            }
        } else {
            c.emit()
        }
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
        } else if c.tempLayerTargets[layerId] != nil {
            c.doc = c.doc.with { $0.layers = beforeDoc.layers }
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

    /// `dirty`: where the rendered canvas changed (document pixels), or nil for anywhere.
    func emit(_ dirty: [RasterRect]? = nil) {
        if previewing || grouping != nil { return }
        version += 1
        dirtyLog.append((version, dirty))
        if dirtyLog.count > MAX_DIRTY_LOG { dirtyLog.removeFirst(dirtyLog.count - MAX_DIRTY_LOG) }
        for l in Array(listeners.values) { l() }
    }

    /**
     * Where the canvas changed after `version` (`takeDirty` in `controller.ts`, kept per view):
     * the rectangles of the changes since, or nil when one of them may have changed anything, is
     * no longer in the log, or nothing was emitted since.
     */
    func dirtySince(_ since: Int) -> [RasterRect]? {
        if since >= version { return nil }
        guard let first = dirtyLog.first, first.version <= since + 1 else { return nil }
        var out: [RasterRect] = []
        for entry in dirtyLog where entry.version > since {
            guard let rects = entry.rects else { return nil }
            out += rects
        }
        return out
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
        let c = compositor ?? viewCompositor
        let id = ObjectIdentifier(c)
        // Changed tiles recomposite only where the canvas changed since this compositor's last call.
        let dirty = compositedVersions[id].flatMap(dirtySince)
        compositedVersions[id] = version
        c.compositeTiles(renderLayers(view: true), rect, sources(), onTile, CompositeCallOptions(checkpointLayerId: liveStroke?.layerId ?? doc.activeLayerId, dirty: dirty.map { $0.map(DirtyRect.init) }))
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
     * smudge, wet, impasto, particle, bristle, sticker, scraper), stamp tips included, unless it lays a
     * sticker from a host's sticker library, which has no art here. A brush picker leaves those out.
     */
    public func canPaint(_ brush: PaintBrush) -> Bool {
        // Editor stamps and image sources have their art here; a host's library stickers don't.
        brushStickerRefs(brush).isEmpty && ["dab", "eraser", "mixer", "blender", "smudge", "wet", "impasto", "particle", "bristle", "sticker", "antimatter", "scraper", "vortex"].contains(brush.engine)
    }

    // MARK: - Colour

    /// Swaps the paint and second colours (`swapColors`).
    public func swapColors() {
        let c = color
        color = secondaryColor
        secondaryColor = c
    }
}
