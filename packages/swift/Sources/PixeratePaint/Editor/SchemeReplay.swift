import Foundation
import PixerateCore
import PixerateRaster
import PixerateGeometry

/**
 * Pixel layers in the viewer's colour scheme, rebuilt from the stroke log (#720;
 * `paint-editor/scheme-replay.ts`).
 *
 * A pixel layer keeps the side of a dual colour (`RecordedStroke.dualColor`) it was painted in:
 * wet paint can't be redrawn one stroke at a time, because every stroke mixes with what the
 * simulation did before it. The scheme's view of such a layer is a replay instead: every recorded
 * stroke and event repainted into a headless editor (`createReplayTarget`), each dual-colour stroke
 * in the scheme's side, so the simulation mixes the dark sides the way it mixed the light ones.
 *
 * - **Built lazily, off the drawing path.** The replay runs one item at a time with the host let in
 *   between (and every few wet steps); until it has caught up, the layer shows its own pixels. The
 *   TS replay runs itself on timers; here a host runs it (`runSchemeReplay` from a view's clock, or
 *   `colorSchemeViewReady`), so without one nothing changes until asked: the same `wait` semantics.
 * - **Kept current, not rebuilt.** Once built it follows the document: new strokes and events are
 *   repainted as they are logged, a live stroke is mirrored point by point at the clocks it was
 *   applied at (wet ones), and the simulation is stepped to the editor's clock. A full replay is only
 *   needed on load or a scheme switch.
 * - **Undo** rolls the replay back to a checkpoint (the replay editor's document and wet simulation
 *   after an item) and repaints from there, so undo / redo never shows the other scheme's pixels.
 * - **View only.** Nothing here changes the document, the history or what is saved.
 */

/// What a scheme replay reads from the editor it shows (`SchemeReplayHost`).
struct SchemeReplayHost {
    /// The editor's document.
    var document: () -> PaintDocumentState
    /// The editor's wet clock (steps).
    var clock: () -> Int
    /// The stroke being painted as recorded so far (a wet stroke: the points applied, with their clocks), or nil when there is none.
    var liveStroke: () -> (stroke: RecordedStroke, wet: Bool, follow: Bool)?
    /// A stroke as the scheme shows it (a dual-colour stroke in the scheme's side).
    var inScheme: (RecordedStroke) -> RecordedStroke
    /// A fresh, empty replay editor for the document as it is now.
    var createTarget: () throws -> PaintEditorController
    /// The editor's pixel layers that are missing from the target are added to it, empty.
    var addMissingLayers: (PaintEditorController) -> Void
    /// Whether the target was made for another canvas or paper than the editor has now.
    var stale: (PaintEditorController) -> Bool
    /// The view changed in these rectangles (nil: anywhere); only called while the view is shown.
    var changed: ([RasterRect]?) -> Void
    /// Bytes of wet simulation snapshots the checkpoints may keep.
    var memory: () -> Int
    /// Lets the host in between two pieces of work (`setTimeout(0)` in TS).
    var yieldToHost: () async -> Void
}

/// Steps of catch-up (or of a replayed stroke) between two looks at the host.
private let STEP_CHUNK = 2
/// Points of a replayed wet stroke between two looks at the host.
private let POINT_CHUNK = 8
/// Checkpoints kept at most (the oldest go first).
private let MAX_CHECKPOINTS = 64

/// Which stroke a live stroke is, before and after it is logged (`strokeKey`).
private func liveStrokeKey(_ st: RecordedStroke) -> String {
    let p = st.points.first
    return "\(st.layerId)|\(st.seed)|\(st.brush.id)|\(p.map { jsText($0.x) } ?? "undefined"),\(p.map { jsText($0.y) } ?? "undefined")"
}

/// The clock an item happens at (nil: it doesn't depend on the clock).
private func itemClock(_ item: ReplayItem) -> Int? {
    switch item {
    case .wet(let e): return e.clock
    case .stroke(let st):
        if st.brush.engine == "wet", let steps = st.steps, let first = steps.first { return first }
        return nil
    case .paint: return nil
    }
}

/// The stroke a scheme replay mirrors while the editor paints it.
private final class LiveMirror {
    let key: String
    let session: PaintLiveStroke
    let wet: Bool
    var pushed = 0

    init(key: String, session: PaintLiveStroke, wet: Bool) {
        self.key = key
        self.session = session
        self.wet = wet
    }
}

final class SchemeReplay {
    /// `building`, `ready` or `failed`.
    private(set) var state = "building"
    /// Why the replay failed (`state: "failed"`).
    private(set) var error: String?
    let scheme: String
    private let host: SchemeReplayHost
    private var target: PaintEditorController
    private var unsubscribe: () -> Void = {}
    /// The strokes and events repainted so far (the keys of the log's objects, in order).
    private var applied: [Int] = []
    private var checkpoints: [(count: Int, cp: ReplayCheckpoint)] = []
    private var live: LiveMirror?
    /// A live stroke that could not be followed (the view shows it when it is logged).
    private var skipKey: String?
    private var running = false
    /// Kicked, and not run since (the TS replay would be running).
    private var pending = false
    private var again = false
    private var disposed = false
    private var options = ReplayItemOptions()

    init(scheme: String, host: SchemeReplayHost) throws {
        self.scheme = scheme
        self.host = host
        target = try host.createTarget()
        options = ReplayItemOptions(wetChunk: STEP_CHUNK, onWetSteps: { await host.yieldToHost() }, pointChunk: POINT_CHUNK, onPoints: { await host.yieldToHost() })
        subscribe(target)
    }

    deinit { unsubscribe() }

    /// How far the replay is: items repainted and items in the log.
    var progress: (items: Int, total: Int) {
        let d = host.document()
        return (applied.count, d.strokes.count + (d.paintEvents?.count ?? 0) + (d.wetEvents?.count ?? 0))
    }

    /// Whether the replay has work to do (kicked, or running).
    var hasWork: Bool { !disposed && state != "failed" && (pending || running) }

    /// The layer as the scheme shows it (with a mirrored live stroke), or nil before it is ready.
    func surface(_ layerId: String) -> TiledSurface? {
        state == "ready" ? target.viewLayerSurface(layerId) : nil
    }

    /// The layer as the scheme shows it with its wet paint dried (what exports see), or nil before it is ready.
    func bakedSurface(_ layerId: String) -> TiledSurface? {
        if state != "ready" { return nil }
        let baked = live != nil ? nil : target.wet.bakedSurface(layerId)
        return baked ?? target.viewLayerSurface(layerId)
    }

    /// Looks at the editor again (call after every change): there is work to do, run by `whenIdle`.
    func kick() {
        if disposed || state == "failed" { return }
        if running {
            again = true
            return
        }
        again = false
        pending = true
    }

    /**
     * Runs the replay until it has nothing left to do (caught up with the editor, or failed),
     * letting the host in between pieces of work; while another caller runs it, waits for that.
     */
    func whenIdle() async {
        while !disposed {
            if running {
                await host.yieldToHost()
                continue
            }
            if !pending { return }
            pending = false
            again = false
            running = true
            await run()
            running = false
            if again { kick() }
        }
    }

    /**
     * What the TS replay does in the microtask after a kick, before any painting: a stale target
     * starts over, and an undone or edited log rolls back to a checkpoint.
     */
    func settle() {
        if disposed || running || !pending || state == "failed" { return }
        do {
            if host.stale(target) {
                try restart()
                return
            }
            let p = matchedPrefix()
            if p < applied.count { try rollback(p, Int.max) }
        } catch {
            fail(error)
        }
    }

    func dispose() {
        if disposed { return }
        disposed = true
        unsubscribe()
        unsubscribe = {}
    }

    private func subscribe(_ t: PaintEditorController) {
        let off = t.subscribe { [weak self, unowned t] in
            guard let self else { return }
            let dirty = t.dirtyLog.last?.rects
            if self.state == "ready" && !self.disposed && self.target === t { self.host.changed(dirty) }
        }
        unsubscribe = { off.cancel() }
    }

    private func fail(_ e: Error) {
        if disposed { return }
        state = "failed"
        error = errorMessage(e)
        host.changed(nil)
    }

    private func run() async {
        do {
            while !disposed {
                again = false
                if !(try await step()) { return }
                await host.yieldToHost()
            }
        } catch {
            fail(error)
        }
    }

    /// How many items of the log the replay has repainted as they are now.
    private func matchedPrefix() -> Int {
        let items = replayItems(host.document())
        var p = 0
        while p < applied.count && p < items.count && items[p].key == applied[p] { p += 1 }
        return p
    }

    /// One piece of work (an item, a stretch of steps, a few live points). False when caught up.
    private func step() async throws -> Bool {
        if host.stale(target) {
            try restart()
            return true
        }
        let items = replayItems(host.document())
        var p = 0
        while p < applied.count && p < items.count && items[p].key == applied[p] { p += 1 }
        // Undone or edited: back to the last checkpoint the log still agrees with.
        if p < applied.count {
            try rollback(p, Int.max)
            return true
        }
        if p < items.count {
            let item = items[p]
            if let live {
                if case .stroke(let st) = item, live.key == liveStrokeKey(st) {
                    if live.wet {
                        try await finishLive(host.inScheme(st))
                        applied.append(item.key)
                        checkpoint()
                        return true
                    }
                    // A dry stroke is painted again as recorded (one change, so the view never shows it missing).
                    self.live = nil
                    live.session.cancel()
                } else {
                    cancelLive()
                    return true
                }
            }
            if let at = itemClock(item), clock() > at {
                try rollback(p, at)
                return true
            }
            try await apply(item)
            return true
        }
        let now = host.liveStroke()
        if try await followLive(now) { return true }
        let editorClock = host.clock()
        // A wet stroke holds the clock at its last point (a replay ends it there; one that isn't
        // followed replays from its first point once it is logged).
        let liveWet: Bool = live?.wet ?? false
        var unfollowedWet = false
        if let now { unfollowedWet = now.wet && !now.follow }
        let holding: Bool = liveWet || unfollowedWet
        if clock() < editorClock && !holding {
            if try await advanceReplayClock(target, Swift.min(editorClock, clock() + STEP_CHUNK)) > 0 { return true }
        }
        if state == "building" {
            state = "ready"
            host.changed(nil)
        }
        return false
    }

    private func clock() -> Int {
        target.wet.world?.clock ?? 0
    }

    private func apply(_ item: ReplayItem) async throws {
        host.addMissingLayers(target)
        var it = item
        switch item {
        case .stroke(let recorded):
            let st = host.inScheme(recorded)
            if let e = st.effect, e.map?.by != "path" { try await target.prepareEffectPaints([e]) }
            it = .stroke(st)
        case .paint(let e) where e.kind == "live-strokes":
            // A stroke layer in the replay holds its strokes in the scheme's side (what it rasterizes to).
            if let strokes = e.strokes {
                var shown = e
                shown.strokes = strokes.map(host.inScheme)
                it = .paint(shown)
            }
        default:
            break
        }
        try await replayItem(target, it, options)
        applied.append(item.key)
        checkpoint()
    }

    private func checkpoint() {
        target.forgetHistory()
        checkpoints.append((applied.count, target.replayCheckpoint()))
        if checkpoints.count > MAX_CHECKPOINTS { checkpoints.removeFirst() }
        // Within the memory budget, newest first: older checkpoints lose their wet snapshots.
        var bytes = 0
        let budget = host.memory()
        for i in stride(from: checkpoints.count - 1, through: 0, by: -1) {
            let cp = checkpoints[i].cp
            if cp.lost { continue }
            bytes += cp.wet?.bytes ?? 0
            if bytes > budget { cp.lose() }
        }
    }

    /// Back to the newest checkpoint at or before item `count` and clock `clock`; a fresh replay when there is none.
    private func rollback(_ count: Int, _ clock: Int) throws {
        if live != nil { cancelLive() }
        for i in stride(from: checkpoints.count - 1, through: 0, by: -1) {
            let c = checkpoints[i]
            if c.count > count || c.cp.clock > clock || c.cp.lost { continue }
            if !target.restoreReplayCheckpoint(c.cp) { break }
            applied.removeLast(applied.count - c.count)
            checkpoints.removeLast(checkpoints.count - (i + 1))
            if state == "ready" { host.changed(nil) }
            return
        }
        try restart()
    }

    /// Starts over in a fresh replay editor; the layers show their own pixels until it has caught up.
    private func restart() throws {
        if live != nil { cancelLive() }
        let wasReady = state == "ready"
        state = "building"
        unsubscribe()
        unsubscribe = {}
        applied = []
        checkpoints = []
        skipKey = nil
        target = try host.createTarget()
        subscribe(target)
        if wasReady { host.changed(nil) }
    }

    /// Mirrors the stroke being painted: begins it, then pushes the points applied since the last look.
    private func followLive(_ now: (stroke: RecordedStroke, wet: Bool, follow: Bool)?) async throws -> Bool {
        var gone = true
        if let now, let live { gone = liveStrokeKey(now.stroke) != live.key }
        if self.live != nil && gone {
            // Cancelled (a stroke that ended is logged, and `step` finishes it first).
            cancelLive()
            return true
        }
        guard let now, now.follow, !now.stroke.points.isEmpty else { return false }
        let key = liveStrokeKey(now.stroke)
        if key == skipKey { return false }
        let st = host.inScheme(now.stroke)
        let target = self.target
        if live == nil {
            if now.wet {
                // Not applied yet: the simulation may still step up to the editor's clock (points land later).
                guard let steps = st.steps, let first = steps.first else { return false }
                if clock() > first {
                    try rollback(applied.count, first)
                    return true
                }
                try await advanceReplayClock(target, first, options)
            }
            host.addMissingLayers(target)
            var i = replayStrokeInit(st)
            i.start = Point2(x: st.points[0].x, y: st.points[0].y)
            do {
                let session = try target.beginStroke(i)
                live = LiveMirror(key: key, session: session, wet: now.wet)
            } catch {
                skipKey = key
                return false
            }
            return true
        }
        return try await pushLive(st)
    }

    /// Pushes the points of `st` the mirrored stroke hasn't had (a wet stroke's at their clocks).
    private func pushLive(_ st: RecordedStroke) async throws -> Bool {
        guard let live else { return false }
        let n = live.wet ? Swift.min(st.steps?.count ?? 0, st.points.count) : st.points.count
        if live.pushed >= n { return false }
        if live.wet {
            let steps = st.steps ?? []
            for i in live.pushed..<n {
                try await advanceReplayClock(target, steps[i], options)
                if self.live !== live { return true }
                live.session.push([st.points[i]])
                live.pushed = i + 1
            }
        } else {
            live.session.push(Array(st.points[live.pushed..<n]))
            live.pushed = n
        }
        return true
    }

    /// The editor's stroke was logged: the mirrored wet stroke takes its last points and ends.
    private func finishLive(_ st: RecordedStroke) async throws {
        guard let live else { return }
        _ = try await pushLive(st)
        self.live = nil
        try finishReplayStroke(target, live.session)
    }

    private func cancelLive() {
        guard let live else { return }
        self.live = nil
        if live.session.open { live.session.cancel() }
    }
}
