import Foundation
import PixerateCore
import PixerateRaster

/**
 * View-only vortex winding animations (`marks.duration`, `vortexAnimations` in `controller.ts`).
 *
 * A vortex stroke commits its final pixels at once (tools, saving, export and `pickColor` see
 * them). When its brush has `duration > 0`, the canvas view then winds the layer from the pre-warp
 * surface (with the stroke's ink) to those pixels over `duration` seconds, blending neighbouring
 * keyframes of the integration (`vortexWindingField`) so the paint follows its arcs. The last frame
 * is exactly the committed surface. An animation is dropped as soon as its layer's document surface
 * changes (undo, redo, another stroke), so it never shows stale pixels.
 *
 * Nothing plays without a clock: the view shows an animation only once `stepVortexAnimations`
 * has run (the editor view calls it every frame, next to the wet clock). Headless callers see the
 * committed pixels.
 */
final class VortexPlayback {
    struct Animation {
        /// The committed layer surface the animation ends on (stale once the layer's surface is another).
        let base: TiledSurface
        /// The frame the view shows now.
        var surface: TiledSurface
        let preInkSurface: TiledSurface
        let frames: [DisplacementField]
        let offset: LayerOffset
        let lockTransparency: Bool
        let selection: PaintSelection?
        let bounds: RasterRect?
        let durationMs: Double
        var startAt: Double?
    }

    /// The winding the last ended stroke session left, until its stroke is committed.
    struct Pending {
        let strokeId: String
        let layerId: String
        let offset: LayerOffset
        let lockTransparency: Bool
        let selection: PaintSelection?
        let animation: VortexWindingAnimation
    }

    /// Animations by layer id, in the order they were queued.
    var animations: [(layerId: String, animation: Animation)] = []
    var pending: Pending?
    /// Whether a clock has stepped the animations (until then the view shows committed pixels).
    var clocked = false
}

extension PaintEditorController {
    /// Called by `endStroke` when a session has a winding animation for the stroke it recorded.
    func noteVortexAnimation(_ session: PaintStrokeSession, strokeId: String) {
        guard let anim = session.windingAnimation() else {
            vortexPlayback.pending = nil
            return
        }
        vortexPlayback.pending = VortexPlayback.Pending(strokeId: strokeId, layerId: session.layerId, offset: session.offset, lockTransparency: session.lockTransparency, selection: session.selection, animation: anim)
    }

    /// After a stroke committed: queues the winding its session left (`queueVortexAnimation`), if it is this stroke's.
    func queueVortexAnimation(after result: PaintStrokeResult) {
        guard let p = vortexPlayback.pending else { return }
        vortexPlayback.pending = nil
        guard p.strokeId == result.strokeId, !previewing, p.animation.duration > 0 else { return }
        let durationMs = JS.round(p.animation.duration * 1000)
        guard durationMs > 0, let l = findLayer(doc.layers, p.layerId)?.layer, l.isPixel, let committed = l.surface else { return }
        let a = VortexPlayback.Animation(
            base: committed, surface: p.animation.preInkSurface, preInkSurface: p.animation.preInkSurface,
            frames: p.animation.frames, offset: p.offset, lockTransparency: p.lockTransparency, selection: p.selection,
            bounds: result.bounds, durationMs: durationMs, startAt: nil
        )
        vortexPlayback.animations.removeAll { $0.layerId == p.layerId }
        vortexPlayback.animations.append((p.layerId, a))
        // The commit redrew the committed pixels; a running clock shows the first frame instead.
        if vortexPlayback.clocked { emit(result.bounds.map { [$0] }) }
    }

    /// Whether any layer has a view-only vortex winding animation in flight (stale ones are dropped).
    public func hasActiveVortexAnimations() -> Bool {
        if vortexPlayback.animations.isEmpty { return false }
        vortexPlayback.animations.removeAll { entry in
            guard let l = findLayer(doc.layers, entry.layerId)?.layer, l.isPixel, let s = l.surface else { return true }
            return s !== entry.animation.base
        }
        return !vortexPlayback.animations.isEmpty
    }

    /// The layers winding a vortex now (a growing culture waits for them, as in TS).
    public func vortexAnimatingLayerIds() -> Set<String> {
        hasActiveVortexAnimations() ? Set(vortexPlayback.animations.map(\.layerId)) : []
    }

    /**
     * Advances view-only vortex winding animations to `now` (ms; an animation starts at the first
     * step after its stroke). Returns true when any animation stepped; emits where they redrew.
     * The editor view calls it every frame while no stroke is open.
     */
    @discardableResult
    public func stepVortexAnimations(_ now: Double) -> Bool {
        vortexPlayback.clocked = true
        if !hasActiveVortexAnimations() { return false }
        var dirty: [RasterRect] = []
        var anyChanged = false
        var kept: [(layerId: String, animation: VortexPlayback.Animation)] = []
        for (id, var v) in vortexPlayback.animations {
            if v.startAt == nil { v.startAt = now }
            let elapsed = Swift.max(0, now - v.startAt!)
            if elapsed >= v.durationMs {
                if let b = v.bounds { dirty.append(b) }
                anyChanged = true
                continue
            }
            let u = Swift.max(0, Swift.min(1, elapsed / v.durationMs))
            let t = u * u * (3 - 2 * u)
            // Between the keyframes around t, so the paint winds along its arcs (scaling the final
            // field would slide it along chords).
            if let field = vortexWindingField(v.frames, t) {
                let options = WarpSurfaceOptions(offset: v.offset, selection: v.selection, lockTransparency: v.lockTransparency)
                v.surface = v.preInkSurface.channels == 4
                    ? warpTiledSurfaceRgba(v.preInkSurface, field, options).surface
                    : warpTiledSurfaceChannel(v.preInkSurface, field, options).surface
            } else {
                v.surface = v.preInkSurface
            }
            if let b = v.bounds { dirty.append(b) }
            anyChanged = true
            kept.append((id, v))
        }
        vortexPlayback.animations = kept
        if anyChanged { emit(dirty.isEmpty ? nil : dirty) }
        return anyChanged
    }

    /// The frame a layer's winding animation shows now, or nil when it isn't winding (headless checks).
    public func vortexAnimationSurface(_ layerId: String) -> TiledSurface? {
        guard hasActiveVortexAnimations() else { return nil }
        return vortexPlayback.animations.first { $0.layerId == layerId }?.animation.surface
    }

    /// `layers` with the winding frames in place of their layers' surfaces (the view, `animatedView`).
    func vortexViewLayers(_ layers: [PaintLayer]) -> (layers: [PaintLayer], winding: Bool) {
        guard vortexPlayback.clocked, liveStroke == nil, hasActiveVortexAnimations() else { return (layers, false) }
        var out = layers
        var winding = false
        for (id, v) in vortexPlayback.animations {
            guard let l = findLayer(out, id)?.layer, l.isPixel, l.surface === v.base else { continue }
            out = mapLayer(out, id) { $0.withSurface(v.surface) }
            winding = true
        }
        return (out, winding)
    }
}
