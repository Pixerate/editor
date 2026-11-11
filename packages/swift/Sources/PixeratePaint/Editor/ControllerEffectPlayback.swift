import Foundation
import PixerateCore
import PixerateRaster

/**
 * Live effect paint in the view, and the painting at a moment of its live effects
 * (`showEffectTime`, `playEffects`, `withEffectTime` and `renderAnimationFrame` in `controller.ts`).
 *
 * Frames are view state, never the document: the document stays the undo, save and replay state,
 * and each frame depends on a clock. A frame goes into `effectFrames` with the committed surface it
 * was drawn from, so it is dropped as soon as that surface changes (`effectFrameLayers`). Exports at
 * a moment draw the frame into `frameOverride` for the length of one call.
 */

/// An effect paint's frame `t` ms on from its own time (`framePaint`).
func liveEffectFrame(_ p: PaintEffectPaint, _ t: Double) -> PaintEffectPaint {
    var f = p
    f.time += t
    return f
}

/**
 * Plays live effect paint on the caller's clock (`playEffects` in `controller.ts`): the editor view
 * calls `tick(now:)` every frame with the time in ms and awaits it, so one frame renders at a time.
 * It shows a frame at most `fps` times a second (`setEffectPlayback`), and waits while paused,
 * while a stroke is painted, or when nothing is live. Pausing holds the moment shown; playing
 * again carries on from it.
 */
public final class PaintEffectPlayer {
    private weak var controller: PaintEditorController?
    private var started: Double
    private var last = -Double.infinity
    public private(set) var stopped = false

    init(_ controller: PaintEditorController, now: Double) {
        self.controller = controller
        started = now - controller.effectTime
    }

    /// Shows the live effects at `now` (ms) when a frame is due. Returns true when a frame was shown.
    @discardableResult
    public func tick(now: Double) async -> Bool {
        guard !stopped, let c = controller else { return false }
        let (playing, fps) = c.effectPlayback
        if !playing { started = now - c.effectTime }
        if !playing || c.liveStroke != nil || now - last < 1000 / Double(fps) - 1 || c.liveEffects().layers.isEmpty { return false }
        last = now
        // A frame that could not render (no provider) is tried again on the next tick.
        return (try? await c.showEffectTime(Swift.max(0, now - started))) ?? false
    }

    /// Stops playback; the view keeps the last frame until the document changes.
    public func stop() { stopped = true }
}

extension PaintEditorController {
    /// Live effect playback as the view and `set_effect_playback` report it: playing, the frame rate cap and the moment shown (ms).
    public var effectPlaybackState: (playing: Bool, fps: Int, time: Double) { (effectPlayback.playing, effectPlayback.fps, effectTime) }

    func checkEffectMoment(_ time: Double) throws {
        if !(time.isFinite && time >= 0) { throw PaintEditorError("time \(jsText(time)) is not a moment of the effect; use 0 or more milliseconds.") }
    }

    /// The layers with each stroke layer's live effect frame in place of its committed pixels, while those are what the frame was drawn from.
    func effectFrameLayers(_ layers: [PaintLayer]) -> [PaintLayer] {
        if effectFrames.isEmpty { return layers }
        var out = layers
        for id in effectFrames.keys.sorted() {
            let f = effectFrames[id]!
            guard let l = findLayer(out, id)?.layer, l.isPixel, l.pixelSurface === f.base else { continue }
            out = mapLayer(out, id) { $0.withSurface(f.surface) }
        }
        return out
    }

    /// Where a stroke layer's live strokes may paint at any frame: what they painted, and their reach.
    private func liveEffectAreas(_ strokes: [RecordedStroke]) -> [RasterRect] {
        strokes.filter { $0.effect?.live == true }.flatMap { st -> [RasterRect] in
            var out = [liveStrokeBounds(st)]
            if let b = paintedBounds[st.key] ?? nil { out.append(b) }
            return out
        }
    }

    /// Every stroke layer with live effects drawn at `time` ms (each live stroke at its own time plus `time`); renders the frames first.
    private func liveSurfacesAt(_ time: Double) async throws -> [String: TiledSurface] {
        let (layers, sources) = liveEffects()
        if layers.isEmpty { return [:] }
        try await prepareEffectPaints(sources.map { framePaint($0, time) })
        var out: [String: TiledSurface] = [:]
        liveEffectAt = time
        defer { liveEffectAt = nil }
        for (id, strokes) in layers {
            guard let l = findLayer(doc.layers, id)?.layer else { continue }
            out[id] = try drawLiveStrokes(l, strokes).surface
        }
        return out
    }

    /**
     * Shows the live effects at `time` ms in the view (`showEffectTime`): renders their frames, then
     * draws the stroke layers that play them again. Nothing in the document changes. Returns false
     * when the document changed or a stroke began while the frames rendered (the next frame
     * catches up).
     */
    @discardableResult
    public func showEffectTime(_ time: Double) async throws -> Bool {
        try checkEffectMoment(time)
        let (layers, sources) = liveEffects()
        let before = doc
        // Authored effect renders are timed for the live frame budget (`noteLiveFrame`).
        timingLiveFrames = true
        do {
            defer { timingLiveFrames = false }
            try await prepareEffectPaints(sources.map { framePaint($0, time) })
        }
        // Frames drawn on the GPU are for this view frame only: exports and replays render on the CPU.
        defer { dropGPUFrames() }
        if doc !== before || liveStroke != nil { return false }
        var next: [String: (base: TiledSurface, surface: TiledSurface)] = [:]
        var dirty: [RasterRect] = []
        liveEffectAt = time
        defer { liveEffectAt = nil }
        for (id, strokes) in layers {
            guard let l = findLayer(doc.layers, id)?.layer, l.isPixel else { continue }
            next[id] = (l.pixelSurface, try drawLiveStrokes(l, strokes).surface)
            dirty += liveEffectAreas(strokes)
        }
        // A layer that stopped playing goes back to its committed pixels: redraw everywhere.
        let cleared = effectFrames.keys.contains { next[$0] == nil }
        effectFrames = next
        effectTime = time
        emittingViewFrame = true
        defer { emittingViewFrame = false }
        emit(cleared || dirty.isEmpty ? nil : dirty)
        return true
    }

    /// Drops the effect paint renders the GPU drew for a view frame.
    func dropGPUFrames() {
        for k in gpuFrameKeys { _ = effectPaintPixels.delete(k) }
        gpuFrameKeys = []
    }

    /**
     * Starts live effect playback on the caller's clock (`playEffects`): the editor view calls the
     * returned player's `tick(now:)` every frame (ms) and `stop()` when it goes away.
     */
    public func playEffects(now: Double) -> PaintEffectPlayer { PaintEffectPlayer(self, now: now) }

    /**
     * Runs `fn` with the painting as it is `time` ms into its live effects (`withEffectTime`): for
     * exports at a moment. Nothing in the document changes; without live effects `fn` sees the
     * painting as it is.
     */
    public func withEffectTime<T>(_ time: Double, _ fn: () throws -> T) async throws -> T {
        try checkEffectMoment(time)
        let surfaces = try await liveSurfacesAt(time)
        let was = frameOverride
        frameOverride = surfaces
        defer { frameOverride = was }
        return try fn()
    }

    /// The painting composited `time` ms into its live effects, like `compositePixels` (`renderAnimationFrame`). Nothing in the document changes.
    public func renderAnimationFrame(_ time: Double, paper: Bool? = nil) async throws -> (width: Int, height: Int, data: [UInt8]) {
        try await withEffectTime(time) { compositePixels(paper: paper) }
    }
}
