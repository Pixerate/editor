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
    /// UV-fluorescent ink: the layer's 4-channel fluorescence surface before the stroke.
    var fluor: TiledSurface? = nil
    /// Thermochromic ink: the layer's 4-channel thermochromic surface before the stroke.
    var thermo: TiledSurface? = nil
    /// Ferrofluid paint: the layer's liquid ferrofluid channel before the stroke; a grey twin of the stroke paints it.
    var ferro: TiledSurface? = nil
    /// Effect paint: the effect (recorded with the stroke) and its rendered pixels.
    var effect: (source: PaintEffectPaint, pixels: EffectPaintPixels)? = nil
    /// Sticker brushes: the number of the first sticker id (`st<n>`) the spray makes.
    var stickerNextId: Int? = nil
    /// Sticker brushes: art cache for provider stickers (beyond `editor:<id>`).
    var stickerArt: StickerArtLookup? = nil
    /// Sticker brushes: variant (`"light"` | `"dark"`) to look up for a sticker ref.
    var stickerVariant: ((String) -> String)? = nil
    /// Wet brushes: the driver that applies the stroke to the wet layer, and the layer's current pixels (the wet layer's display).
    var wet: (driver: WetStrokeDriver, surface: () -> TiledSurface)? = nil
    /// Impasto brushes: the layer's thick-paint channels before the stroke.
    var thick: ThickChannels? = nil
    /// Non-impasto brushes (such as vortex) on a layer that already has impasto relief: the layer's thick channels before the stroke.
    var relief: ThickChannels? = nil
    /// Non-impasto brushes with `iridescence` (or an eraser on a layer with film): the layer's film before the stroke.
    var film: TiledSurface? = nil
    /// The art of image sources, for stamp tips and tip grain.
    var stampArt: StampArtLookup? = nil
    /// Antimatter brushes: every visible layer that supplies fuel (and is edited if editable).
    var antimatter: [AntimatterTarget]? = nil
    /// Scraper brushes: the driver that cuts down through visible paint layers.
    var scraper: ScraperStrokeDriver? = nil
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
    /// Wet brushes: the paint is wet (it keeps moving until it dries).
    public var wet: Bool?
    /// Biopaint brushes: how many spores the stroke seeded onto the layer.
    public var culture: Int?
    /// Antimatter brushes: blast, spark, fuel and layer summary.
    public var antimatter: AntimatterStats?
    /// Sticker brushes: provider stickers the stroke skipped because their art was not cached yet.
    public var skippedStickers: [String]?
    /// Vortex brushes: the classified stroke shape and peak displacement in pixels.
    public var vortex: VortexStrokeSummary?
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
    private let dry: CoverageStroke?
    private var wet: PaintDabStroke?
    private var spray: StickerSpray?
    private var wetDriver: WetStrokeDriver?
    private var thickDriver: ThickStrokeDriver?
    private var antimatter: AntimatterStrokeDriver?
    private var scraperDriver: ScraperStrokeDriver?
    private var vortexDriver: VortexStrokeDriver?
    private var filmBuffer: FilmBuffer?
    private let apply: StrokeApply
    private(set) var bounds: RasterRect?
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
    /// UV-fluorescent ink: the stroke's twin over the 4-channel fluorescence surface.
    private var fluorTwin: PaintStrokeSession?
    /// Thermochromic ink: the stroke's twin over the 4-channel thermochromic surface.
    private var thermoTwin: PaintStrokeSession?
    private let thermoBefore: TiledSurface?
    private let invisibleDaylight: Bool
    /// Ferrofluid paint: the stroke's twin over the ferrofluid channel.
    private var ferroTwin: PaintStrokeSession?
    /// The tiles shown while the stroke is painted (`currentSurface`), and the keys changed since.
    private var shown: OrderedMap<TileKey, Tile>?
    private var stale: [TileKey] = []
    private var staleSet = Set<TileKey>()

    /// Sticker brushes: the stickers the stroke sprayed, or nil.
    var sprayedStickers: [Sticker]? { spray.flatMap { $0.stickers.isEmpty ? nil : $0.stickers } }
    /// Sticker brushes: provider stickers the stroke skipped because their art was not cached yet.
    var skippedStickers: [String]? { spray.flatMap { $0.skipped.isEmpty ? nil : $0.skipped } }

    /// Antimatter brushes: the per-layer outputs after `end()`, or nil.
    var antimatterOutputs: [AntimatterLayerOutput]? { antimatter?.layerOutputs() }

    /// Antimatter brushes: the driver instance, or nil.
    var antimatterDriver: AntimatterStrokeDriver? { antimatter }

    /// Light paint: the layer's light channel after the stroke, or nil when the stroke has no twin.
    var lightChannel: TiledSurface? { lightTwin?.surfaceAfter.map(shadowToLight) }

    /// Whether the stroke paints the layer's light channel too (a light twin).
    var hasLightTwin: Bool { lightTwin != nil }

    /// Everywhere the stroke's marks and its light twin's reached, whether or not they changed a
    /// pixel (`result.bounds` is nil when nothing changed): where a stroke layer redraws the stroke.
    func reach() -> RasterRect? {
        guard let twin = lightTwin?.reach() else { return bounds }
        return unionRect(bounds, twin)
    }

    /// UV-fluorescent ink: the layer's fluorescence surface after the stroke, or nil.
    var fluorChannel: TiledSurface? {
        guard let twin = fluorTwin else { return nil }
        return twin.surfaceAfter ?? initValues.fluor
    }

    /// Thermochromic ink: the layer's thermochromic surface after the stroke, or nil.
    var thermoChannel: TiledSurface? {
        guard let twin = thermoTwin else { return nil }
        guard let after = twin.surfaceAfter else { return thermoBefore }
        if let hc = initValues.brush.thermochromic.hotColor {
            return finalizeThermoStroke(after, thermoBefore ?? emptyThermo(), hexToRgb8(hc), initValues.brush.thermochromic.threshold)
        }
        return after
    }
    /// Ferrofluid paint: the layer's ferrofluid channel after the stroke, or nil when the stroke has no twin.
    var ferroChannel: TiledSurface? { ferroTwin?.surfaceAfter.map(shadowToFerro) }

    /// Ferrofluid paint while the stroke is open.
    func currentFerro() -> TiledSurface? { ferroTwin.map { shadowToFerro($0.currentSurface()) } }

    init(_ i: StrokeSessionInit) throws {
        initValues = i
        layerId = i.layerId
        base = i.surface
        let brush = i.brush
        thermoBefore = i.thermo
        invisibleDaylight = brush.fluorescence.amount > 0 && brush.fluorescence.invisible && i.wet == nil && brush.engine != "sticker" && brush.engine != "antimatter" && brush.engine != "eraser" && brush.engine != "blender" && brush.engine != "smudge"
        if let light = i.light, i.wet == nil, i.brush.engine != "sticker", i.brush.engine != "antimatter" {
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
            t.effect = i.effect.map { ($0.source, greyPixels($0.pixels, grey)) }
            t.light = nil
            t.fluor = nil
            t.thermo = nil
            t.ferro = nil
            t.thick = nil
            t.relief = nil
            t.stickerNextId = nil
            t.film = nil
            lightTwin = try PaintStrokeSession(t)
        }
        if let fluor = i.fluor, i.wet == nil, i.brush.engine != "sticker", i.brush.engine != "antimatter" {
            var t = i
            t.surface = fluor
            t.lockTransparency = false
            t.brush = fluorTwinBrush(brush)
            t.inputFilter = nil
            t.light = nil
            t.fluor = nil
            t.thermo = nil
            t.ferro = nil
            t.thick = nil
            t.relief = nil
            t.stickerNextId = nil
            fluorTwin = try PaintStrokeSession(t)
        }
        if let thermo = i.thermo, i.wet == nil, i.brush.engine != "sticker", i.brush.engine != "antimatter" {
            let hotHex = brush.thermochromic.hotColor ?? i.colorHex
            let hotRgb = hexToRgb8(hotHex)
            var t = i
            t.surface = thermo
            t.lockTransparency = false
            t.brush = thermoTwinBrush(brush)
            t.color = [hotRgb[0], hotRgb[1], hotRgb[2], 255]
            t.colorHex = hotHex
            t.secondary = [hotRgb[0], hotRgb[2].self == hotRgb[2] ? hotRgb[1] : hotRgb[1], hotRgb[2], 255]
            t.inputFilter = nil
            t.mixerLoad = MixerLoad(
                reservoir: i.mixerLoad.reservoir != nil ? [Double(hotRgb[0]) / 255, Double(hotRgb[1]) / 255, Double(hotRgb[2]) / 255] : nil,
                amount: i.mixerLoad.amount,
                pickup: nil
            )
            t.paint = nil
            t.effect = nil
            t.light = nil
            t.fluor = nil
            t.thermo = nil
            t.ferro = nil
            t.thick = nil
            t.relief = nil
            t.stickerNextId = nil
            thermoTwin = try PaintStrokeSession(t)
        }
        if let ferro = i.ferro, i.wet == nil, i.brush.engine != "sticker", i.brush.engine != "antimatter" {
            // The twin paints the ferrofluid as grey at the brush's ferro amount (see `ferro.ts`).
            let grey = Int(JS.round(brush.ferro.amount * 255))
            let g = Double(grey) / 255
            let hex = "#" + String(repeating: String(grey, radix: 16).leftPad(2), count: 3)
            var t = i
            t.surface = ferroToShadow(ferro)
            t.lockTransparency = false
            t.brush = ferroTwinBrush(brush)
            t.color = [grey, grey, grey, 255]
            t.colorHex = hex
            t.secondary = [grey, grey, grey, 255]
            t.inputFilter = nil
            t.mixerLoad = MixerLoad(reservoir: i.mixerLoad.reservoir != nil ? [g, g, g] : nil, amount: i.mixerLoad.amount, pickup: nil)
            t.paint = i.paint.map { p in var q = p; q.stops = p.stops.map { var st = $0; st.color = hex; return st }; return q }
            t.effect = i.effect.map { ($0.source, greyPixels($0.pixels, grey)) }
            t.light = nil
            t.ferro = nil
            t.fluor = nil
            t.thermo = nil
            t.thick = nil
            t.relief = nil
            t.film = nil
            ferroTwin = try PaintStrokeSession(t)
        }
        apply = StrokeApply(mode: brush.engine == "eraser" ? .erase : .paint, color: i.color, background: i.background, opacity: brush.tip.opacity, blend: brush.tip.blend, lockTransparency: i.lockTransparency, selection: i.selection, offset: i.offset)
        if invisibleDaylight {
            dry = nil
            return
        }
        let copies = i.copies.isEmpty ? [IDENTITY_COPY] : i.copies
        if let f = i.film {
            filmBuffer = FilmBuffer(f, i.offset, i.selection)
        }
        if let s = i.scraper {
            dry = nil
            scraperDriver = s
            return
        }
        if let w = i.wet {
            dry = nil
            wetDriver = w.driver
            return
        }
        if let ch = i.thick {
            dry = nil
            thickDriver = ThickStrokeDriver(ThickStrokeInit(brush: brush, target: self, channels: ch, color: i.color.prefix(3).map { Double($0) / 255 }, load: i.mixerLoad, seed: i.seed, copies: copies, paint: i.paint, effect: i.effect?.pixels))
            return
        }
        if brush.engine == "vortex" {
            dry = nil
            vortexDriver = VortexStrokeDriver(VortexStrokeDriverInit(
                brush: brush,
                base: i.surface,
                offset: i.offset,
                lockTransparency: i.lockTransparency,
                selection: i.selection,
                color: i.color,
                background: i.background,
                grain: i.grain,
                paperDepth: i.paperDepth,
                seed: i.seed,
                copies: copies,
                paint: i.paint,
                effect: i.effect?.pixels,
                stampArt: i.stampArt,
                relief: i.relief ?? i.film.map { ThickChannels(height: emptySurface(1, 0), material: emptySurface(4, 0), film: $0) }
            ))
            filmBuffer = nil
            return
        }
        if brush.engine == "sticker" {
            dry = nil
            spray = StickerSpray(brush: brush, target: self, color: i.colorHex, seed: i.seed, copies: copies, nextId: i.stickerNextId ?? 1, paint: i.paint, effect: i.effect?.pixels, art: i.stickerArt, variant: i.stickerVariant)
            return
        }
        if brush.engine == "antimatter" {
            dry = nil
            let targets = i.antimatter ?? [
                AntimatterTarget(
                    id: i.layerId,
                    editable: true,
                    lockTransparency: i.lockTransparency,
                    opacity: 1,
                    offset: i.offset,
                    base: i.surface,
                    baseLight: i.light,
                    baseThick: i.thick
                )
            ]
            antimatter = AntimatterStrokeDriver(AntimatterStrokeInit(
                activeLayerId: i.layerId,
                targets: targets,
                brush: brush,
                color: i.color,
                seed: i.seed,
                copies: copies,
                selection: i.selection,
                paint: i.paint,
                effect: i.effect?.pixels
            ))
            return
        }
        let dabByDab = brush.engine == "mixer" || brush.engine == "blender" || brush.engine == "smudge" || usesPaintExchange(brush, i.paint != nil)
        if dabByDab {
            dry = nil
        } else if brush.engine == "dab" || brush.engine == "eraser" {
            dry = DryStroke(brush, grain: i.grain, paperDepth: i.paperDepth, seed: i.seed, copies: copies, effect: i.effect?.pixels, stampArt: i.stampArt)
        } else if brush.engine == "particle" || brush.engine == "bristle" {
            let m: MarkStroke = brush.engine == "particle"
                ? ParticleStroke(brush, grain: i.grain, paperDepth: i.paperDepth, seed: i.seed, copies: copies, paint: i.paint)
                : BristleStroke(brush, grain: i.grain, paperDepth: i.paperDepth, seed: i.seed, copies: copies, paint: i.paint)
            m.effect = i.effect?.pixels
            m.stampArt = i.stampArt
            dry = m
        } else {
            throw UnportedBrushError(message: "The \(brush.name) brush paints with the \(brush.engine) engine, which the Swift paint editor does not paint with yet.")
        }
        if dabByDab {
            wet = PaintDabStroke(brush, target: self, load: i.mixerLoad, grain: i.grain, paperDepth: i.paperDepth, seed: i.seed, copies: copies, paint: i.paint, effect: i.effect?.pixels, stampArt: i.stampArt)
        }
        if let fb = filmBuffer {
            dry?.film = fb
            wet?.film = fb
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

    /// Impasto strokes: the layer's thick-paint channels with the stroke so far.
    func thickChannels() -> ThickChannels? { thickDriver?.channels() ?? vortexDriver?.reliefChannels() }

    /// Dry vortex strokes: the driver, to move per-layer masks (biopaint occupancy) with the paint.
    func vortexWarp() -> VortexStrokeDriver? { vortexDriver?.preWarpSurface() != nil ? vortexDriver : nil }

    /// Vortex strokes: the view-only winding animation (final field, keyframes, pre-ink surface, duration).
    func windingAnimation() -> VortexWindingAnimation? {
        vortexDriver?.windingAnimation()
    }

    /// Non-impasto strokes that write or erase thin film: the layer's film surface so far.
    func filmChannel() -> TiledSurface? { filmBuffer?.surface() }

    /// Adds raw pen samples (document pixels); returns the rectangles they painted.
    @discardableResult
    func push(_ pts: [PenPoint]) throws -> [RasterRect] {
        if closed || pts.isEmpty { return [] }
        let filtered = initValues.inputFilter.map { pts.map($0) } ?? pts
        points += filtered
        if let s = scraperDriver {
            let rects = s.push(filtered)
            for r in rects { bounds = unionRect(bounds, r) }
            return rects
        }
        if let w = wetDriver {
            let rects = try w.push(filtered)
            for r in rects { bounds = unionRect(bounds, r) }
            return rects
        }
        if let am = antimatter {
            let rects = am.push(filtered)
            for r in rects { bounds = unionRect(bounds, r) }
            return rects
        }
        try lightTwin?.push(filtered)
        try ferroTwin?.push(filtered)
        let fRects = try fluorTwin?.push(filtered) ?? []
        _ = try thermoTwin?.push(filtered)
        if invisibleDaylight {
            for r in fRects { bounds = unionRect(bounds, r) }
            return fRects
        }
        let rects = dry != nil ? dry!.push(filtered) : thickDriver != nil ? thickDriver!.push(filtered) : vortexDriver != nil ? vortexDriver!.push(filtered) : spray != nil ? spray!.push(filtered) : wet!.push(filtered)
        update(rects)
        markStale(rects)
        return rects
    }

    /// Notes the tiles `rects` (document pixels) touched, for `currentSurface`.
    private func markStale(_ rects: [RasterRect]) {
        let off = initValues.offset
        for r in rects {
            // Once per tile: a push lays many dabs on the same tiles.
            for t in tilesInRect(RasterRect(x: r.x - off.x, y: r.y - off.y, width: r.width, height: r.height)) where staleSet.insert(tileKey(t.tx, t.ty)).inserted { stale.append(tileKey(t.tx, t.ty)) }
        }
    }

    /**
     * The layer's pixels as painted so far, for drawing the stroke while it is painted. Tiles the
     * stroke has not changed since the last call stay the same objects, so a tile-caching
     * compositor redraws only the changed ones.
     */
    func currentSurface() -> TiledSurface {
        if let am = antimatter {
            return am.layerOutputs().first(where: { $0.id == layerId })?.surface ?? base
        }
        var tiles = shown ?? base.tiles
        for key in stale {
            guard let t = live[key], touchedSet.contains(key) else { continue }
            if let tile = finishTile(t.data, base.channels, base.defaultValue) { tiles.set(key, tile) } else { _ = tiles.delete(key) }
        }
        stale = []
        staleSet = []
        shown = tiles
        return TiledSurface(channels: base.channels, tiles: tiles, defaultValue: base.defaultValue)
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
        if let s = scraperDriver {
            for r in s.finish() { bounds = unionRect(bounds, r) }
            closed = true
            let changed = s.hasChanges
            surfaceAfter = changed ? (s.liveSurfaces()[layerId] ?? base) : nil
            let r = PaintStrokeResult(layerId: layerId, bounds: changed ? bounds : nil, dabs: s.dabCount, strokeId: nil)
            result = r
            return r
        }
        if let w = wetDriver {
            for r in try w.finish() { bounds = unionRect(bounds, r) }
            closed = true
            let changed = w.dabCount > 0
            surfaceAfter = changed ? initValues.wet!.surface() : nil
            var r = PaintStrokeResult(layerId: layerId, bounds: changed ? w.bounds : nil, dabs: w.dabCount, strokeId: nil)
            r.wet = true
            if let carried = w.load { r.mixerLoad = initValues.brush.behavior.dirty ? carried : cleanMixer(carried) }
            if let vs = w.vortexSummary { r.vortex = vs }
            result = r
            return r
        }
        if let v = vortexDriver {
            let vEnd = v.finish()
            if let vb = vEnd.bounds { bounds = unionRect(bounds, vb) }
            closed = true
            if let twin = lightTwin, twin.open { _ = try twin.end() }
            if let twin = ferroTwin, twin.open { _ = try twin.end() }
            let fEnd = try fluorTwin.flatMap { $0.open ? try $0.end() : $0.result }
            let tEnd = try thermoTwin.flatMap { $0.open ? try $0.end() : $0.result }
            if let fb = fEnd?.bounds { bounds = unionRect(bounds, fb) }
            if let tb = tEnd?.bounds { bounds = unionRect(bounds, tb) }
            let twinChanged =
                lightTwin?.surfaceAfter != nil ||
                ferroTwin?.surfaceAfter != nil ||
                fluorTwin?.surfaceAfter != nil ||
                thermoTwin?.surfaceAfter != nil
            let changed = vEnd.surface != nil || twinChanged
            surfaceAfter = vEnd.surface ?? (twinChanged ? base : nil)
            let vs = v.vortexResult()
            let r = PaintStrokeResult(
                layerId: layerId,
                bounds: changed ? bounds : nil,
                dabs: changed ? Swift.max(1, v.dabCount) : 0,
                strokeId: nil,
                vortex: VortexStrokeSummary(shape: vs.shape, maxDisplacement: changed ? vs.maxDisplacement : 0)
            )
            result = r
            return r
        }
        if let am = antimatter {
            for r in am.finish() { bounds = unionRect(bounds, r) }
            closed = true
            let stats = am.stats()
            let changed = stats.blasts > 0 && !stats.layers.isEmpty
            let activeOut = am.layerOutputs().first(where: { $0.id == layerId })
            surfaceAfter = changed ? (activeOut?.surface ?? base) : nil
            let r = PaintStrokeResult(layerId: layerId, bounds: changed ? am.bounds : nil, dabs: am.dabCount, strokeId: nil, antimatter: stats)
            result = r
            return r
        }
        if !invisibleDaylight {
            update(dry != nil ? dry!.finish() : thickDriver != nil ? thickDriver!.finish() : spray != nil ? spray!.finish() : wet!.finish())
        }
        closed = true
        if let twin = lightTwin, twin.open { _ = try twin.end() }
        if let twin = ferroTwin, twin.open { _ = try twin.end() }
        let fEnd = try fluorTwin.flatMap { $0.open ? try $0.end() : $0.result }
        let tEnd = try thermoTwin.flatMap { $0.open ? try $0.end() : $0.result }
        if invisibleDaylight {
            if let fb = fEnd?.bounds { bounds = unionRect(bounds, fb) }
            let changed = fluorTwin?.surfaceAfter != nil
            surfaceAfter = changed ? base : nil
            let r = PaintStrokeResult(layerId: layerId, bounds: changed ? bounds : nil, dabs: fEnd?.dabs ?? 0, strokeId: nil)
            result = r
            return r
        }
        if let fb = fEnd?.bounds { bounds = unionRect(bounds, fb) }
        if let tb = tEnd?.bounds { bounds = unionRect(bounds, tb) }
        let ch = base.channels
        var tiles = base.tiles
        var changed = false
        for key in touched {
            let tile = finishTile(live[key]!.data, ch, base.defaultValue)
            let prev = base.tiles.get(key)
            if let tile { tiles.set(key, tile) } else { _ = tiles.delete(key) }
            if !sameTile(prev, tile) { changed = true }
        }
        // An impasto stroke can change only the relief (a knife on dry colour).
        if let t = thickDriver, t.dabCount > 0 { changed = true }
        if fluorTwin?.surfaceAfter != nil || thermoTwin?.surfaceAfter != nil { changed = true }
        surfaceAfter = changed ? TiledSurface(channels: ch, tiles: tiles, defaultValue: base.defaultValue) : nil
        let dabs = dry?.dabCount ?? thickDriver?.dabCount ?? spray?.dabCount ?? wet!.dabCount
        var r = PaintStrokeResult(layerId: layerId, bounds: changed ? bounds : nil, dabs: dabs, strokeId: nil)
        if let carried = wet?.load ?? thickDriver?.load { r.mixerLoad = initValues.brush.behavior.dirty ? carried : cleanMixer(carried) }
        if let skipped = skippedStickers { r.skippedStickers = skipped }
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
    // The palette knife carries no paint.
    if brush.engine == "impasto" { return brush.loadsColor ? MixerLoad(reservoir: color, amount: 1, pickup: brush.behavior.dirty ? current.pickup : nil) : EMPTY_MIXER_LOAD }
    if brush.engine == "wet" { return (brush.wet.tool == "paint" || (brush.wet.tool == "vortex" && brushVortex(brush).ink > 0)) ? MixerLoad(reservoir: color, amount: 1, pickup: brush.behavior.dirty ? current.pickup : nil) : EMPTY_MIXER_LOAD }
    if usesPaintExchange(brush) { return MixerLoad(reservoir: color, amount: 1, pickup: brush.behavior.dirty ? current.pickup : nil) }
    return EMPTY_MIXER_LOAD
}
