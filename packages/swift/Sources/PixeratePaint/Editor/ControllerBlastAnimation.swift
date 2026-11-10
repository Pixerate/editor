import Foundation
import PixerateCore
import PixerateRaster

/**
 * The antimatter blast expansion animation (`controller.ts`: `startBlastAnimation`,
 * `stepBlastAnimation`, `clearBlastAnimation`, `blastLayers` / `animatedLight` / `animatedThick`).
 *
 * An antimatter stroke commits every blast at once. With `antimatter.duration > 0` the view then
 * plays each blast expanding from its birth time: frames from the stroke's heat field at the
 * clock's time (`AntimatterStrokeDriver.renderAtTime`), laid over the committed layers while the
 * document is still the one the stroke committed. The animation is view only: the document never
 * changes, the last frame is the committed pixels, and undo, redo, a new canvas or a new stroke
 * clears it. Nothing plays until a clock ticks it (`tickBlastAnimation`, the editor view's clock),
 * so headless agents and exports see the committed painting.
 */

/// The animation in flight and the frame it shows (editor state, never saved).
final class BlastAnimationState {
    /// The driver of the stroke that just ended, until the commit starts its animation.
    var pending: AntimatterStrokeDriver?
    var active: ActiveBlastAnimation?
    /// Frame surfaces by layer id, with the committed surface each one stands in for.
    var layers: [String: (base: TiledSurface, surface: TiledSurface)] = [:]
    /// Frame light by layer id (`.some(nil)`: no light at this frame).
    var light: [String: TiledSurface?] = [:]
    /// Frame relief by layer id.
    var thick: [String: ThickChannels] = [:]
}

struct ActiveBlastAnimation {
    var driver: AntimatterStrokeDriver
    var committedDoc: PaintDocumentState
    var dirty: RasterRect?
    var ticked: Bool
}

extension PaintEditorController {
    /// Whether an antimatter blast animation is playing (or waiting for its first tick).
    public var hasActiveBlastAnimation: Bool { blastAnimation.active != nil }

    /// The layers the blast animation is showing frames of (live growth waits on these, as in TS `playCultures`).
    public var blastAnimatingLayerIds: Set<String> { Set(blastAnimation.layers.keys) }

    /// Called by `endStroke` for an antimatter stroke: the commit that follows starts its animation.
    func noteAntimatterDriver(_ driver: AntimatterStrokeDriver?) {
        blastAnimation.pending = driver
    }

    /// After an antimatter stroke is committed: starts its blast animation when the brush has a duration and the stroke fired.
    func startPendingBlastAnimation(_ dirty: RasterRect?) {
        guard let driver = blastAnimation.pending else { return }
        blastAnimation.pending = nil
        guard driver.initValues.brush.antimatter.duration > 0, driver.hasBlasts() else { return }
        clearBlastAnimation()
        // Birth times are rebased onto the clock at the first tick (`playEffects` in TS rebases when it starts).
        blastAnimation.active = ActiveBlastAnimation(driver: driver, committedDoc: doc, dirty: dirty, ticked: false)
    }

    /**
     * Shows the blast animation at `now` (ms on the caller's clock). The first tick puts the blasts'
     * birth times on that clock, so the animation starts at its first frame. Returns true when the
     * view changed. Waits while a stroke is painted; ends (showing the committed pixels) when every
     * blast has finished or the document changed.
     */
    @discardableResult
    public func tickBlastAnimation(_ now: Double) -> Bool {
        guard var anim = blastAnimation.active else { return false }
        if liveStroke != nil { return false }
        if doc !== anim.committedDoc {
            clearBlastAnimation()
            return false
        }
        if !anim.ticked {
            anim.driver.rebaseTime(now)
            anim.ticked = true
            blastAnimation.active = anim
        }
        let frame = anim.driver.renderAtTime(now)
        if !frame.active {
            clearBlastAnimation(emitDirty: true)
            return true
        }
        var nextLayers: [String: (base: TiledSurface, surface: TiledSurface)] = [:]
        var nextLight: [String: TiledSurface?] = [:]
        var nextThick: [String: ThickChannels] = [:]
        var targets: [String: AntimatterTarget] = [:]
        for t in anim.driver.initValues.targets { targets[t.id] = t }
        for out in frame.outputs {
            guard let committed = findLayer(doc.layers, out.id)?.layer, committed.isPixel else { continue }
            nextLayers[out.id] = (committed.pixelSurface, out.surface)
            // nil: the frame leaves that channel as it was before the stroke (not as committed, which has every blast in it).
            let tgt = targets[out.id]
            let light = out.light ?? tgt?.baseLight
            if light != nil || doc.light?.get(out.id) != nil { nextLight[out.id] = .some(light) }
            if let thick = out.thick ?? tgt?.baseThick { nextThick[out.id] = thick }
        }
        blastAnimation.layers = nextLayers
        blastAnimation.light = nextLight
        blastAnimation.thick = nextThick
        emit(anim.dirty.map { [$0] })
        return true
    }

    /// Stops the blast animation (undo, redo, a new canvas or stroke); `emitDirty` redraws where it played.
    func clearBlastAnimation(emitDirty: Bool = false) {
        blastAnimation.pending = nil
        guard let anim = blastAnimation.active else { return }
        blastAnimation.active = nil
        blastAnimation.layers = [:]
        blastAnimation.light = [:]
        blastAnimation.thick = [:]
        if emitDirty { emit(anim.dirty.map { [$0] }) }
    }

    /// Whether the blast frames apply: the document is still the one the stroke committed.
    private var showsBlastFrames: Bool {
        guard let anim = blastAnimation.active else { return false }
        return doc === anim.committedDoc && !blastAnimation.layers.isEmpty
    }

    /// `layers` with the blast frames in place of the committed surfaces they stand in for (`animatedView`).
    func blastFrameLayers(_ layers: [PaintLayer]) -> [PaintLayer] {
        guard showsBlastFrames else { return layers }
        var out = layers
        for (id, frame) in blastAnimation.layers.sorted(by: { $0.key < $1.key }) {
            guard let l = findLayer(out, id)?.layer, l.isPixel, l.pixelSurface === frame.base else { continue }
            out = mapLayer(out, id) { $0.withSurface(frame.surface) }
        }
        return out
    }

    /// The layer ids whose light or relief the blast frame overrides.
    var blastChannelLayerIds: [String] {
        guard showsBlastFrames else { return [] }
        return Array(Set(blastAnimation.light.keys).union(blastAnimation.thick.keys)).sorted()
    }

    /// The light the view shows for `id`: the blast frame's when it has one, else `fallback`.
    func blastViewLight(_ id: String, _ fallback: TiledSurface?) -> TiledSurface? {
        guard showsBlastFrames, let l = blastAnimation.light[id] else { return fallback }
        return l
    }

    /// The relief the view shows for `id`: the blast frame's when it has one, else `fallback`.
    func blastViewThick(_ id: String, _ fallback: ThickChannels?) -> ThickChannels? {
        guard showsBlastFrames, let t = blastAnimation.thick[id] else { return fallback }
        return t
    }
}
