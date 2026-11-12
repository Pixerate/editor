import Foundation
import PixerateCore
import PixerateRaster

/**
 * An uncommitted run of live culture growth (`culturePreview` in `controller.ts`): the document
 * before the run, the one it showed last, and the `culture-grow` events it grew, by layer in the
 * order the layers first grew. Commits as one undo step ("Culture growth") when something
 * interrupts it (`flushCulturePreview`).
 */
final class CulturePreview {
    let base: PaintDocumentState
    var shown: PaintDocumentState
    var events: OrderedMap<String, CultureGrowEventData>
    init(base: PaintDocumentState, shown: PaintDocumentState, events: OrderedMap<String, CultureGrowEventData>) {
        self.base = base
        self.shown = shown
        self.events = events
    }
}

/**
 * Live biopaint growth on a clock (`playCultures` in `controller.ts`): call `tick(now:)` every frame
 * with the time in ms. It grows at `CULTURE_TICKS_PER_SECOND` times the culture speed, waits while
 * paused, during a stroke, a group or a preview, and skips layers mid-animation (`animatingLayerIds`).
 * Each uninterrupted run commits as one undo step when a stroke, command, undo, redo or save
 * interrupts it, or when `stop()` is called.
 */
public final class PaintCulturePlayer {
    private weak var controller: PaintEditorController?
    private var last: Double
    private var accumTicks = 0.0
    public private(set) var stopped = false

    init(_ controller: PaintEditorController, now: Double) {
        self.controller = controller
        last = now
    }

    /// Advances growth to `now` (ms). Returns true when the colonies grew this frame.
    @discardableResult
    public func tick(now: Double) -> Bool {
        guard !stopped, let c = controller else { return false }
        let dt = Swift.max(0, Swift.min(0.25, (now - last) / 1000))
        last = now
        return c.stepLiveCultures(dt: dt, accumTicks: &accumTicks)
    }

    /// Whether growth since the last commit is waiting to be committed (a run is going on).
    public var hasPendingRun: Bool { controller?.culturePreview != nil }

    /// Stops playback and commits the run so far as one undo step.
    public func stop() {
        if stopped { return }
        stopped = true
        controller?.flushCulturePreview()
    }
}

extension PaintEditorController {
    /**
     * Starts live mycelial growth driven by the caller's clock (`playCultures`): the editor view
     * calls the returned player's `tick(now:)` every frame (ms) and `stop()` when it goes away.
     */
    public func playCultures(now: Double) -> PaintCulturePlayer {
        PaintCulturePlayer(self, now: now)
    }

    /**
     * Layers mid-animation that live growth must not touch now (TS `playCultures` skips
     * `vortexAnimations` and `blastLayers`): growing would change their pixels and cut the
     * animation short. `cultureGrowthHolds` adds any other registered sources (tests use it).
     */
    func animatingLayerIds() -> Set<String> {
        var out = blastAnimatingLayerIds.union(vortexAnimatingLayerIds())
        for source in cultureGrowthHolds.values { out.formUnion(source()) }
        return out
    }

    /// One frame of live growth (`tick` in TS `playCultures`).
    func stepLiveCultures(dt: Double, accumTicks: inout Double) -> Bool {
        if culturePaused || liveStroke != nil || grouping != nil || previewing { return false }
        let held = animatingLayerIds()
        let wetIds = wet.wetLayerIds()
        let targetIds = flattenLayers(doc.layers).compactMap { l -> String? in
            guard l.isPixel,
                  l.visible,
                  !isLayerLocked(l.locks, .pixels),
                  doc.liveStrokes?.get(l.id) == nil,
                  doc.effectLayers?.get(l.id) == nil,
                  !wetIds.contains(l.id),
                  let c = doc.cultures?.get(l.id),
                  !c.tips.isEmpty,
                  c.status == "growing",
                  !held.contains(l.id) else { return nil }
            return l.id
        }
        if targetIds.isEmpty {
            if culturePreview != nil {
                flushCulturePreview()
                emit([])
            }
            return false
        }
        accumTicks += dt * Double(CULTURE_TICKS_PER_SECOND) * cultureSpeed
        let steps = Swift.min(8, Int(JS.floor(accumTicks)))
        if steps < 1 { return false }
        accumTicks -= Double(steps)
        let current = culturePreview.flatMap { $0.shown === doc ? $0 : nil }
        let base = current?.base ?? doc
        var events = current?.events ?? OrderedMap()
        let (nextDoc, _, stepped, dirty) = stepCulturesInternal(targetIds, steps, summaries: false)
        if nextDoc === doc { return false }
        for (lid, ev) in stepped {
            if var cur = events.get(lid) {
                cur.steps += ev.steps
                cur.fades += ev.fades
                cur.segments += ev.segments
                events.set(lid, cur)
            } else {
                events.set(lid, ev)
            }
        }
        setDocSilently(nextDoc)
        culturePreview = CulturePreview(base: base, shown: nextDoc, events: events)
        emit(dirty.isEmpty ? nil : dirty)
        return true
    }

    /// The shown document with live growth's pending `culture-grow` events, for replays (commits nothing).
    func withCulturePreviewEvents() -> PaintDocumentState {
        guard let pv = culturePreview, pv.shown === doc, pv.shown !== pv.base else { return doc }
        var d = pv.shown
        for (layerId, data) in pv.events where data.steps > 0 || !data.segments.isEmpty || !data.fades.isEmpty {
            d = withPaintEvent(d, kind: "culture-grow", layerId: layerId, data: data.json)
        }
        return d
    }

    /// Commits an uninterrupted run of live culture growth as a single undo step ("Culture growth") before another operation runs.
    func flushCulturePreview() {
        guard let pv = culturePreview else { return }
        if pv.shown !== doc || pv.shown === pv.base {
            culturePreview = nil
            return
        }
        let d = withCulturePreviewEvents()
        culturePreview = nil
        undoStack.append(HistoryEntry(label: "Culture growth", before: pv.base, after: d))
        if undoStack.count > historyLimit { undoStack.removeFirst() }
        redoStack = []
        doc = d
    }

    /**
     * Flushes live culture growth before a change that was built from the live document, and
     * carries the flushed `culture-grow` events into it: otherwise `next` (built from the preview)
     * would replace the flushed document and drop the events replay needs (`flushCultureInto`).
     */
    func flushCultureInto(_ next: PaintDocumentState, before: PaintDocumentState) -> (next: PaintDocumentState, before: PaintDocumentState) {
        let shown = doc
        flushCulturePreview()
        if doc === shown { return (next, before) }
        let flushed = doc
        let baseCount = shown.paintEvents?.count ?? 0
        let added = Array((flushed.paintEvents ?? []).dropFirst(baseCount))
        var out = next
        if next !== shown && !added.isEmpty {
            let own = next.paintEvents ?? []
            out = next.with { $0.paintEvents = Array(own.prefix(baseCount)) + added + Array(own.dropFirst(baseCount)) }
        } else if next === shown {
            out = flushed
        }
        return (out, before === shown ? flushed : before)
    }

    /**
     * Replaces the document without an undo step (wet paint flowing) and keeps a live growth run
     * going: the run's shown document moves to `next`, so the next growth tick (or a flush) does not
     * take the replaced document for an interruption and drop the run's replay events.
     */
    func setDocSilentlyKeepingGrowth(_ next: PaintDocumentState) {
        if let pv = culturePreview, pv.shown === doc { pv.shown = next }
        setDocSilently(next)
    }
}
