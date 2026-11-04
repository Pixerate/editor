import Foundation
import PixerateCore
import PixerateRaster

/**
 * A stroke on one pixel layer (`paint-editor/stroke.ts`). Points arrive with `push`; `end()`
 * commits it.
 *
 * - Dab and eraser brushes: the coverage is cumulative, so each update recomposites the touched
 *   region from the pre-stroke tile (`applyStrokeToTile` with `into` and `region`).
 * - Dab-by-dab brushes (`PaintDabStroke`: the Mixer Brush, blender, smudge, and dab brushes that
 *   pick up paint or paint a gradient): dabs read what earlier dabs laid down, so they paint into
 *   live tile copies.
 */

struct StrokeSessionInit {
    var layerId: String
    var surface: TiledSurface
    var offset: LayerOffset
    var lockTransparency: Bool
    var brush: PaintBrush
    /// Paint colour 0..255 RGBA.
    var color: [Int]
    /// What the eraser paints on a transparency-locked layer (the paper colour).
    var background: [Int]
    var grain: PaperGrain?
    var paperDepth: Double
    var seed: Int
    /// The paint colour as #rrggbb (recorded with the stroke).
    var colorHex: String
    /// The stroke's extra copies as affine maps (recorded); `copies` holds all of them as engine copies.
    var affineCopies: [Affine]
    var copies: [StrokeCopy]
    var mixerLoad: MixerLoad
    var secondary: [Int]?
    var selection: PaintSelection?
    /// Applied to each raw sample before it is painted and recorded (perspective and stencil snapping).
    var inputFilter: ((PenPoint) -> PenPoint)?
    /// Gradient paint (resolved: concrete colours), or nil for the one colour.
    var paint: PaintGradientSource?
    /// Light paint: the layer's light channel before the stroke; a grey twin of the stroke paints it.
    var light: TiledSurface? = nil
}

public struct PaintStrokeResult {
    public var layerId: String
    /// Document rectangle the stroke touched, or nil when no pixel changed.
    public var bounds: RasterRect?
    public var dabs: Int
    /// Id of the recorded stroke, or nil when nothing changed.
    public var strokeId: String?
    /// Brushes that pick up paint: what the brush carries after the stroke.
    public var mixerLoad: MixerLoad?
}

private func sameTile(_ a: Tile?, _ b: Tile?) -> Bool {
    guard let a, let b else { return a == nil && b == nil }
    if a === b { return true }
    if a.uniform != nil || b.uniform != nil { return a.uniform == b.uniform }
    return a.data == b.data
}

/// A live tile of the session: its bytes (written in place by dab-by-dab brushes).
private final class LiveTile {
    let tile: ByteTile
    init(_ data: [UInt8]) { tile = ByteTile(data) }
}

final class PaintStrokeSession: PaintTileTarget {
    let layerId: String
    let initValues: StrokeSessionInit
    /// The raw input so far (what a replay feeds back in).
    private(set) var points: [PenPoint] = []
    private let base: TiledSurface
    /// Base tiles as read-only byte tiles (made on demand) and the stroke's written tiles.
    private var live: [TileKey: ByteTile] = [:]
    private var touched: [TileKey] = []
    private var touchedSet: Set<TileKey> = []
    private let dry: DryStroke?
    private var wet: PaintDabStroke?
    private let apply: StrokeApply
    private var bounds: RasterRect?
    private var closed = false
    var result: PaintStrokeResult?
    /// The mask stencils this stroke was painted with when they are not the editor's (replays).
    var maskStencils: [Stencil]?
    /// The new pixels after `end`, or nil when nothing changed.
    private(set) var surfaceAfter: TiledSurface?

    var offset: LayerOffset { initValues.offset }
    var lockTransparency: Bool { initValues.lockTransparency }
    var selection: PaintSelection? { initValues.selection }

    /// Light paint: the stroke's twin over the light channel.
    private var lightTwin: PaintStrokeSession?

    /// Light paint: the layer's light channel after the stroke, or nil when the stroke has no twin.
    var lightChannel: TiledSurface? { lightTwin?.surfaceAfter.map(shadowToLight) }

    init(_ i: StrokeSessionInit) throws {
        initValues = i
        layerId = i.layerId
        base = i.surface
        let brush = i.brush
        if let light = i.light {
            // The twin paints the light as grey at the brush's light amount (see `light.ts`).
            let grey = Int(JS.round(brush.light.amount * 255))
            let g = Double(grey) / 255
            let hex = "#" + String(repeating: String(grey, radix: 16).leftPad(2), count: 3)
            var t = i
            t.surface = lightToShadow(light)
            t.lockTransparency = false
            t.brush = lightTwinBrush(brush)
            t.color = [grey, grey, grey, 255]
            t.colorHex = hex
            t.secondary = [grey, grey, grey, 255]
            t.inputFilter = nil
            t.mixerLoad = MixerLoad(reservoir: i.mixerLoad.reservoir != nil ? [g, g, g] : nil, amount: i.mixerLoad.amount, pickup: nil)
            t.paint = i.paint.map { p in var q = p; q.stops = p.stops.map { var st = $0; st.color = hex; return st }; return q }
            t.light = nil
            lightTwin = try PaintStrokeSession(t)
        }
        apply = StrokeApply(mode: brush.engine == "eraser" ? .erase : .paint, color: i.color, background: i.background, opacity: brush.tip.opacity, blend: brush.tip.blend, lockTransparency: i.lockTransparency, selection: i.selection, offset: i.offset)
        let copies = i.copies.isEmpty ? [IDENTITY_COPY] : i.copies
        if brush.stamp != nil { throw UnportedBrushError(message: "The \(brush.name) brush has a stamp tip, which the Swift paint editor does not draw yet.") }
        let dabByDab = brush.engine == "mixer" || brush.engine == "blender" || brush.engine == "smudge" || usesPaintExchange(brush, i.paint != nil)
        if dabByDab {
            dry = nil
        } else if brush.engine == "dab" || brush.engine == "eraser" {
            dry = DryStroke(brush, grain: i.grain, paperDepth: i.paperDepth, seed: i.seed, copies: copies)
        } else {
            throw UnportedBrushError(message: "The \(brush.name) brush paints with the \(brush.engine) engine, which the Swift paint editor does not paint with yet.")
        }
        if dabByDab {
            wet = PaintDabStroke(brush, target: self, load: i.mixerLoad, grain: i.grain, paperDepth: i.paperDepth, seed: i.seed, copies: copies, paint: i.paint)
        }
    }

    // MARK: PaintTileTarget

    func readTile(_ tx: Int, _ ty: Int) -> ByteTile? {
        let key = tileKey(tx, ty)
        if let t = live[key] { return t }
        guard let t = base.tiles.get(key) else { return nil }
        let bt = ByteTile(t.data)
        live[key] = bt
        return bt
    }

    func writeTile(_ tx: Int, _ ty: Int) -> ByteTile {
        let key = tileKey(tx, ty)
        if !touchedSet.contains(key) {
            let src = base.tiles.get(key)?.data ?? defaultTile()
            live[key] = ByteTile(src)
            touchedSet.insert(key)
            touched.append(key)
        }
        return live[key]!
    }

    private func defaultTile() -> [UInt8] {
        [UInt8](repeating: UInt8(truncatingIfNeeded: base.defaultValue), count: TILE * TILE * base.channels)
    }

    // MARK: Painting

    var open: Bool { !closed }

    /// Adds raw pen samples (document pixels).
    func push(_ pts: [PenPoint]) {
        if closed || pts.isEmpty { return }
        let filtered = initValues.inputFilter.map { pts.map($0) } ?? pts
        points += filtered
        lightTwin?.push(filtered)
        update(dry != nil ? dry!.push(filtered) : wet!.push(filtered))
    }

    private func update(_ rects: [RasterRect]) {
        if rects.isEmpty { return }
        for r in rects { bounds = unionRect(bounds, r) }
        guard let dry else { return }
        let ch = base.channels
        let off = initValues.offset
        var order: [TileKey] = []
        var regions: [TileKey: (tx: Int, ty: Int, r: RasterRect)] = [:]
        for r in rects {
            for t in tilesInRect(RasterRect(x: r.x - off.x, y: r.y - off.y, width: r.width, height: r.height)) {
                let key = tileKey(t.tx, t.ty)
                if let cur = regions[key] { regions[key] = (t.tx, t.ty, unionRect(cur.r, r)) } else {
                    regions[key] = (t.tx, t.ty, r)
                    order.append(key)
                }
            }
        }
        for key in order {
            let (tx, ty, r) = regions[key]!
            let src = base.tiles.get(key)?.data ?? defaultTile()
            let prev = touchedSet.contains(key) ? live[key]?.data : nil
            if !touchedSet.contains(key) {
                touchedSet.insert(key)
                touched.append(key)
            }
            let data = prev != nil ? applyStrokeToTile(dry.coverage, src, ch, tx, ty, apply, into: prev, region: r) : applyStrokeToTile(dry.coverage, src, ch, tx, ty, apply)
            live[key] = ByteTile(data)
        }
    }

    /// Ends the stroke and returns what changed.
    func end() throws -> PaintStrokeResult {
        if closed { throw PaintEditorError("This stroke has already ended.") }
        update(dry != nil ? dry!.finish() : wet!.finish())
        closed = true
        if let twin = lightTwin, twin.open { _ = try twin.end() }
        let ch = base.channels
        var tiles = base.tiles
        var changed = false
        for key in touched {
            let tile = finishTile(live[key]!.data, ch, base.defaultValue)
            let prev = base.tiles.get(key)
            if let tile { tiles.set(key, tile) } else { _ = tiles.delete(key) }
            if !sameTile(prev, tile) { changed = true }
        }
        surfaceAfter = changed ? TiledSurface(channels: ch, tiles: tiles, defaultValue: base.defaultValue) : nil
        let dabs = dry?.dabCount ?? wet!.dabCount
        var r = PaintStrokeResult(layerId: layerId, bounds: changed ? bounds : nil, dabs: dabs, strokeId: nil)
        if let carried = wet?.load { r.mixerLoad = initValues.brush.behavior.dirty ? carried : cleanMixer(carried) }
        result = r
        return r
    }
}

/// The Mixer Brush load a stroke starts with.
func mixerLoadForStroke(_ brush: PaintBrush, _ current: MixerLoad, _ color: [Double]) -> MixerLoad {
    if !brush.loadsColor { return MixerLoad(reservoir: nil, amount: 0, pickup: brush.mixer.cleanEachStroke ? nil : current.pickup) }
    if brush.mixer.loadEachStroke || current.reservoir == nil { return loadMixer(current, color) }
    return current
}

/**
 * What any brush carries at the start of a stroke: the Mixer Brush as `mixerLoadForStroke`; a
 * wet-capable dab brush the paint colour, full, plus the carried paint when it is dirty; other
 * brushes nothing.
 */
func brushLoadForStroke(_ brush: PaintBrush, _ current: MixerLoad, _ color: [Double]) -> MixerLoad {
    if brush.engine == "mixer" { return mixerLoadForStroke(brush, current, color) }
    if brush.engine == "impasto" { return MixerLoad(reservoir: color, amount: 1, pickup: brush.behavior.dirty ? current.pickup : nil) }
    if brush.engine == "wet" { return brush.wet.tool == "paint" ? MixerLoad(reservoir: color, amount: 1, pickup: brush.behavior.dirty ? current.pickup : nil) : EMPTY_MIXER_LOAD }
    if usesPaintExchange(brush) { return MixerLoad(reservoir: color, amount: 1, pickup: brush.behavior.dirty ? current.pickup : nil) }
    return EMPTY_MIXER_LOAD
}
