import Foundation
import PixerateCore
import PixerateRaster

/**
 * Backlit paper (`paint-editor/backlight.ts`): the paper as a light source behind the paint (a
 * lightbox, stained glass). The light that makes it through the paint is drawn as one Linear Dodge
 * (Add) layer, "Backlight", at the top of the stack, with a soft spill where it comes through
 * paint. Per pixel the light starts as `backlight × backlightColor` (linear), a little stronger in
 * the paper's valleys, and passes through each visible pixel layer from the bottom up: paint is a
 * film over the paper (transparent glazes let their colour through, alpha above the least the
 * colour needs hides), thick paint blocks by its height (clarity lets some through), and layer
 * opacity mixes towards no change. See the TS file for the model.
 */

/// Default backlight colour: warm white, like a lightbox.
public let DEFAULT_BACKLIGHT_COLOR = "#fff1d6"
/// Spill of the light that comes through paint, at backlight 1.
let BACKLIGHT_SPILL = LightSpill(radius: 24, strength: 1.5)
/// Thick paint this high (0..255) blocks the backlight completely.
private let BLOCK_HEIGHT = 96.0
/// How much brighter the light is in the paper's deepest valleys (at grain depth 1).
private let VALLEY_GAIN = 0.35
/// The id of backlit paper's light layer in renders.
let BACKLIGHT_LAYER_ID = "__backlight"

/// One visible pixel layer as the backlight reads it, bottom first.
struct BacklitLayer {
    var surface: TiledSurface
    var offset: LayerOffset
    /// Effective opacity (its groups' opacities multiplied in).
    var opacity: Double
    var thick: ThickChannels?
}

private let LIN: [Double] = (0..<256).map { colourToLinear(Double($0) / 255) }

/// The least alpha a film value `e` needs over paper value `p` (bytes).
private func needAlphaBacklight(_ e: Double, _ p: Double) -> Double {
    if e < p { return 1 - e / p }
    if e > p { return (e - p) / (255 - p) }
    return 0
}

/// The tiles of `surface` a document rectangle overlaps, for a layer at `offset` (cache keys).
private func tilesUnder(_ surface: TiledSurface?, _ rect: RasterRect, _ offset: LayerOffset, _ out: inout [ObjectIdentifier?]) {
    guard let surface else {
        out.append(nil)
        return
    }
    // Only tiles in the surface range (as `tilesInRect`): a far-off offset finds none, never another tile.
    let x0 = Swift.max(Int(JS.floor(Double(rect.x - offset.x) / Double(TILE))), MIN_TILE), y0 = Swift.max(Int(JS.floor(Double(rect.y - offset.y) / Double(TILE))), MIN_TILE)
    let x1 = Swift.min(Int(JS.floor(Double(rect.x - offset.x + rect.width - 1) / Double(TILE))), MAX_TILE), y1 = Swift.min(Int(JS.floor(Double(rect.y - offset.y + rect.height - 1) / Double(TILE))), MAX_TILE)
    if x0 > x1 || y0 > y1 { return }
    for ty in y0...y1 { for tx in x0...x1 { out.append(surface.tiles.get(tileKey(tx, ty)).map(ObjectIdentifier.init)) } }
}

/// The backlight of one paper over some layers: the light added, the colour that came through paint and how much paint (for the spill).
struct BacklightSurfaces {
    var light: TiledSurface
    var color: TiledSurface
    var painted: TiledSurface
}

/// Computes and caches the backlight per 256 px document tile (`BacklightCache`).
final class BacklightCache {
    private var tiles: [TileKey: (refs: [ObjectIdentifier?], light: Tile?, color: Tile?, painted: Tile?)] = [:]
    private var key = ""
    private var spillOf: (color: Int, painted: Int, out: TiledSurface?)?
    private var out: (parts: [ObjectIdentifier], surface: TiledSurface)?

    /// The backlight for `layers` (bottom first) on `paper`, or nil when the paper has no backlight.
    func surface(_ paper: PaperSettings, _ grain: PaperGrain, _ width: Int, _ height: Int, _ layers: [BacklitLayer]) -> BacklightSurfaces? {
        let amount = paper.backlight ?? 0
        if !(amount > 0) { return nil }
        let k = "\(amount)|\(paper.backlightColor ?? DEFAULT_BACKLIGHT_COLOR)|\(paper.color)|\(paper.depth)|\(grain.flat)|\(width)x\(height)|" + layers.map { "\($0.opacity),\($0.offset.x),\($0.offset.y),\($0.surface.channels)" }.joined(separator: ";")
        if k != key {
            tiles = [:]
            key = k
        }
        var light = OrderedMap<TileKey, Tile>(), color = OrderedMap<TileKey, Tile>(), painted = OrderedMap<TileKey, Tile>()
        let tilesX = Int(JS.ceil(Double(width) / Double(TILE))), tilesY = Int(JS.ceil(Double(height) / Double(TILE)))
        for ty in 0..<tilesY {
            for tx in 0..<tilesX {
                let rect = RasterRect(x: tx * TILE, y: ty * TILE, width: Swift.min(TILE, width - tx * TILE), height: Swift.min(TILE, height - ty * TILE))
                var refs: [ObjectIdentifier?] = []
                for l in layers {
                    tilesUnder(l.surface, rect, l.offset, &refs)
                    tilesUnder(l.thick?.height, rect, l.offset, &refs)
                    tilesUnder(l.thick?.material, rect, l.offset, &refs)
                }
                let tk = tileKey(tx, ty)
                var r = tiles[tk]
                if r == nil || r!.refs != refs {
                    let c = computeBacklightTile(paper, grain, amount, rect, layers)
                    r = (refs, c.light, c.color, c.painted)
                    tiles[tk] = r
                }
                if let t = r!.light { light.set(tk, t) }
                if let t = r!.color { color.set(tk, t) }
                if let t = r!.painted { painted.set(tk, t) }
            }
        }
        return BacklightSurfaces(light: TiledSurface(channels: 4, tiles: light, defaultValue: 0), color: TiledSurface(channels: 4, tiles: color, defaultValue: 0), painted: TiledSurface(channels: 1, tiles: painted, defaultValue: 0))
    }

    /// The full Backlight layer: the light through the paint plus the spill of the light through the committed paint.
    func layer(_ current: BacklightSurfaces, _ committed: BacklightSurfaces?, _ amount: Double) -> TiledSurface {
        var spill: TiledSurface? = nil
        if let committed {
            if let s = spillOf, s.color == committed.color.id, s.painted == committed.painted.id { spill = s.out } else {
                spill = computeSpill(committed.color, committed.painted, LightSpill(radius: BACKLIGHT_SPILL.radius, strength: BACKLIGHT_SPILL.strength * amount))
                spillOf = (committed.color.id, committed.painted.id, spill)
            }
        }
        guard let spill else { return current.light }
        let parts = (current.light.tiles.values + spill.tiles.values).map(ObjectIdentifier.init)
        if let o = out, o.parts == parts { return o.surface }
        var keys = current.light.tiles.keys
        for k in spill.tiles.keys where !current.light.tiles.has(k) { keys.append(k) }
        var tiles = OrderedMap<TileKey, Tile>()
        for key in keys {
            let a = current.light.tiles.get(key), b = spill.tiles.get(key)
            let t: Tile? = a == nil ? b : b == nil ? a : addBacklightTiles(a!, b!)
            if let t { tiles.set(key, t) }
        }
        let surface = TiledSurface(channels: 4, tiles: tiles, defaultValue: 0)
        out = (parts, surface)
        return surface
    }
}

/// The backlight tile `a` (opaque, its colour the light added) plus a spill tile `b`, as an opaque added-light tile.
private func addBacklightTiles(_ a: Tile, _ b: Tile) -> Tile? {
    let x = a.data, y = b.data
    var out = [UInt8](repeating: 0, count: TILE * TILE * 4)
    var i = 0
    while i < out.count {
        defer { i += 4 }
        let ay = Double(y[i + 3]) / 255
        let r = Double(x[i]) + Double(y[i]) * ay
        let g = Double(x[i + 1]) + Double(y[i + 1]) * ay
        let bl = Double(x[i + 2]) + Double(y[i + 2]) * ay
        if r < 0.5 && g < 0.5 && bl < 0.5 { continue }
        out[i] = JS.u8c(JS.round(r))
        out[i + 1] = JS.u8c(JS.round(g))
        out[i + 2] = JS.u8c(JS.round(bl))
        out[i + 3] = 255
    }
    return finishTile(out, 4, 0)
}

/// One document tile of backlight.
private func computeBacklightTile(_ paper: PaperSettings, _ grain: PaperGrain, _ amount: Double, _ rect: RasterRect, _ layers: [BacklitLayer]) -> (light: Tile?, color: Tile?, painted: Tile?) {
    let n = rect.width * rect.height
    let pb = hexToRgb8(paper.color).map(Double.init)
    let pl = pb.map { Swift.max(1e-4, LIN[Int($0)]) }
    let c = hexToRgb8(paper.backlightColor ?? DEFAULT_BACKLIGHT_COLOR)
    var t0 = [Float](repeating: Float(amount * LIN[c[0]]), count: n)
    var t1 = [Float](repeating: Float(amount * LIN[c[1]]), count: n)
    var t2 = [Float](repeating: Float(amount * LIN[c[2]]), count: n)
    // Thinner paper in the valleys lets a little more light through.
    let depth = grain.flat ? 0 : paper.depth
    if depth > 0 {
        var i = 0
        for y in 0..<rect.height {
            for x in 0..<rect.width {
                let g = 1 + VALLEY_GAIN * depth * (0.5 - grain.at(Double(rect.x + x) + 0.5, Double(rect.y + y) + 0.5))
                t0[i] = Float(Double(t0[i]) * g)
                t1[i] = Float(Double(t1[i]) * g)
                t2[i] = Float(Double(t2[i]) * g)
                i += 1
            }
        }
    }
    var clear = [Float](repeating: 1, count: n)
    for l in layers {
        let lr = RasterRect(x: rect.x - l.offset.x, y: rect.y - l.offset.y, width: rect.width, height: rect.height)
        if l.surface.tiles.isEmpty { continue }
        let px = readRegion(l.surface, lr)
        let h = l.thick.flatMap { $0.height.tiles.isEmpty ? nil : readRegion($0.height, lr) }
        let m = h != nil ? l.thick.flatMap { $0.material.tiles.isEmpty ? nil : readRegion($0.material, lr) } : nil
        let op = l.opacity
        for i in 0..<n {
            let a8 = px[i * 4 + 3]
            let hi = h?[i] ?? 0
            if a8 == 0 && hi == 0 { continue }
            let a = Double(a8) / 255
            var aMin = 0.0
            var tr = [1.0, 1.0, 1.0]
            for ch in 0..<3 {
                let e = a * Double(px[i * 4 + ch]) + (1 - a) * pb[ch]
                aMin = Swift.max(aMin, needAlphaBacklight(e, pb[ch]))
                tr[ch] = Swift.min(1, LIN[Int(JS.round(e))] / pl[ch])
            }
            let hide = aMin < 1 && a > aMin ? (a - aMin) / (1 - aMin) : 0
            var k = 1 - hide
            if hi != 0 {
                // Thick paint blocks by its height; clarity (material A) lets some through.
                let ma = m.map { Double($0[i * 4 + 3]) } ?? 0
                let clarity = ma != 0 ? (255 - ma) / 254 : 0
                k *= 1 - Swift.min(1, Double(hi) / BLOCK_HEIGHT) * (1 - clarity)
            }
            t0[i] = Float(Double(t0[i]) * (1 - op + op * tr[0] * k))
            t1[i] = Float(Double(t1[i]) * (1 - op + op * tr[1] * k))
            t2[i] = Float(Double(t2[i]) * (1 - op + op * tr[2] * k))
            clear[i] = Float(Double(clear[i]) * (1 - op * Swift.max(a, hi != 0 ? 1 : 0)))
        }
    }
    var light = [UInt8](repeating: 0, count: TILE * TILE * 4)
    var color = [UInt8](repeating: 0, count: TILE * TILE * 4)
    var painted = [UInt8](repeating: 0, count: TILE * TILE)
    var i = 0
    for y in 0..<rect.height {
        for x in 0..<rect.width {
            defer { i += 1 }
            let o = (y * TILE + x) * 4
            let add = [Swift.min(1, Double(t0[i])), Swift.min(1, Double(t1[i])), Swift.min(1, Double(t2[i]))]
            let mx = Swift.max(add[0], add[1], add[2])
            if mx > 0.5 / 255 {
                light[o] = JS.u8c(JS.round(add[0] * 255))
                light[o + 1] = JS.u8c(JS.round(add[1] * 255))
                light[o + 2] = JS.u8c(JS.round(add[2] * 255))
                light[o + 3] = 255
            }
            let pv = JS.round((1 - Double(clear[i])) * 255)
            if pv != 0 && mx > 0.5 / 255 {
                // The spill reads colour as sRGB and spreads it in linear light.
                painted[y * TILE + x] = JS.u8c(pv)
                color[o] = JS.u8c(JS.round(colourFromLinear(add[0]) * 255))
                color[o + 1] = JS.u8c(JS.round(colourFromLinear(add[1]) * 255))
                color[o + 2] = JS.u8c(JS.round(colourFromLinear(add[2]) * 255))
                color[o + 3] = 255
            }
        }
    }
    return (finishTile(light, 4, 0), finishTile(color, 4, 0), finishTile(painted, 1, 0))
}

extension PaintEditorController {
    /// Visible pixel layers bottom first, as the backlight reads them (group opacities multiplied in).
    func backlitLayers(_ layers: [PaintLayer], committed: Bool, liveThick: (layerId: String, channels: ThickChannels)?, opacity: Double = 1) -> [BacklitLayer] {
        var out: [BacklitLayer] = []
        for l in layers where l.visible {
            if let children = l.children { out += backlitLayers(children, committed: committed, liveThick: liveThick, opacity: opacity * l.opacity) } else if l.isPixel {
                let thick = !committed && liveThick?.layerId == l.id ? liveThick!.channels : committed ? doc.thick?.get(l.id) : blastViewThick(l.id, doc.thick?.get(l.id))
                out.append(BacklitLayer(surface: l.pixelSurface, offset: l.pixelOffset, opacity: opacity * l.opacity, thick: thick))
            }
        }
        return out
    }

    /// Backlit paper as a Linear Dodge (Add) layer for the top of the stack; nil when the paper has no backlight.
    func backlightLayer(_ base: [PaintLayer], baseIsCommitted: Bool, liveThick: (layerId: String, channels: ThickChannels)?) -> PaintLayer? {
        let paper = doc.paper
        let amount = paper.backlight ?? 0
        if !(amount > 0) { return nil }
        let c = doc.canvas
        let grain = paperGrain(paper)
        guard let current = backlightView.surface(paper, grain, c.width, c.height, backlitLayers(base, committed: false, liveThick: liveThick)) else { return nil }
        let committed = baseIsCommitted ? current : backlightCommitted.surface(paper, grain, c.width, c.height, backlitLayers(doc.layers, committed: true, liveThick: nil))
        let surface = backlightView.layer(current, committed, amount)
        return RasterLayer(id: BACKLIGHT_LAYER_ID, name: "Backlight", visible: true, opacity: 1, blend: .mode(.linearDodge), content: .pixel(surface: surface, offset: LayerOffset(x: 0, y: 0), fillOpacity: nil))
    }
}
