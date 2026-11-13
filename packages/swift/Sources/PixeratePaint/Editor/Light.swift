import Foundation
import PixerateCore
import PixerateRaster

/**
 * Light paint (`paint-editor/light.ts`): a layer's light channel, one byte per pixel in layer space
 * (0 none .. 255 full), laid by a grey twin of each stroke of a brush with `light.amount`. The
 * paint glows where its light is (its colour brightened in linear light), and the light spills
 * onto what is around it as a blurred Linear Dodge (Add) pass above the layer.
 *
 */

/// How much the light brightens the paint (linear light × (1 + GLOW × light)).
public let GLOW = 1.5

/// How far a layer's light spills (px; 0 off) and how strongly (0..2).
public struct LightSpill: Equatable, Sendable {
    public var radius: Double
    public var strength: Double
}

public let DEFAULT_LIGHT_SPILL = LightSpill(radius: 24, strength: 1)

/// An empty light channel.
public func emptyLight() -> TiledSurface { emptySurface(1, 0) }

/// `Math.sign(v) * …`: the colour package's sRGB ↔ linear conversions (`color/convert.ts`).
func colourToLinear(_ v: Double) -> Double {
    let sign: Double = v > 0 ? 1 : v < 0 ? -1 : 0
    let a = abs(v)
    return sign * (a <= 0.04045 ? a / 12.92 : JS.pow((a + 0.055) / 1.055, 2.4))
}

func colourFromLinear(_ v: Double) -> Double {
    let sign: Double = v > 0 ? 1 : v < 0 ? -1 : 0
    let a = abs(v)
    return sign * (a <= 0.0031308 ? 12.92 * a : 1.055 * JS.pow(a, 1 / 2.4) - 0.055)
}

/// A light channel as white paint of that alpha (what the stroke twin paints over).
func lightToShadow(_ light: TiledSurface) -> TiledSurface {
    var tiles = OrderedMap<TileKey, Tile>()
    for (key, tile) in light.tiles {
        let l = tile.data
        var d = [UInt8](repeating: 0, count: TILE * TILE * 4)
        var j = 0
        for i in 0..<l.count {
            if l[i] != 0 {
                d[j] = 255
                d[j + 1] = 255
                d[j + 2] = 255
                d[j + 3] = l[i]
            }
            j += 4
        }
        if let t = finishTile(d, 4, 0) { tiles.set(key, t) }
    }
    return TiledSurface(channels: 4, tiles: tiles, defaultValue: 0)
}

/// What the twin painted, back as a light channel: grey × alpha.
func shadowToLight(_ shadow: TiledSurface) -> TiledSurface {
    var tiles = OrderedMap<TileKey, Tile>()
    for (key, tile) in shadow.tiles {
        let s = tile.data
        var d = [UInt8](repeating: 0, count: TILE * TILE)
        var j = 0
        for i in 0..<d.count {
            if s[j + 3] != 0 { d[i] = JS.u8c(JS.round((((Double(s[j]) + Double(s[j + 1]) + Double(s[j + 2])) / 3) * Double(s[j + 3])) / 255)) }
            j += 4
        }
        if let t = finishTile(d, 1, 0) { tiles.set(key, t) }
    }
    return TiledSurface(channels: 1, tiles: tiles, defaultValue: 0)
}

/// The brush a stroke's light twin paints with: plain blending, RGB mixing, no gradient.
func lightTwinBrush(_ brush: PaintBrush) -> PaintBrush {
    var tip = brush.tip.json.objectValue!
    tip["blend"] = "normal"
    tip["pressureOpacity"] = .bool(brush.tip.pressureOpacity || brush.light.pressure)
    var behavior = brush.behavior.json.objectValue!
    behavior["mixing"] = "rgb"
    var raw: JSONObject = ["tip": .object(tip), "behavior": .object(behavior), "paint": .null]
    let full = brush.json()
    if brush.engine == "mixer", var m = full["mixer"]?.objectValue { m["mixing"] = "rgb"; raw["mixer"] = .object(m) }
    if brush.engine == "blender", var m = full["blender"]?.objectValue { m["mixing"] = "rgb"; raw["blender"] = .object(m) }
    if brush.engine == "smudge", var m = full["smudge"]?.objectValue { m["mixing"] = "rgb"; raw["smudge"] = .object(m) }
    return normalizePaintBrush(raw, brush)
}

/// Where a light channel has light and its brightest value.
func lightInfo(_ light: TiledSurface?) -> (bounds: RasterRect?, peak: Int) {
    guard let light else { return (nil, 0) }
    var peak = 0
    for (_, t) in light.tiles {
        if let u = t.uniform { peak = Swift.max(peak, Int(u & 255)) } else { for v in t.data where Int(v) > peak { peak = Int(v) } }
    }
    return (peak > 0 ? light.bounds : nil, peak)
}

/// A light channel scaled by `k` (a fill over the paint covers its light).
func scaleLight(_ light: TiledSurface, _ k: Double) -> TiledSurface {
    if k >= 1 { return light }
    var tiles = OrderedMap<TileKey, Tile>()
    if k > 0 {
        for (key, tile) in light.tiles {
            if let t = finishTile(tile.data.map { JS.u8c(JS.round(Double($0) * k)) }, 1, 0) { tiles.set(key, t) }
        }
    }
    return TiledSurface(channels: 1, tiles: tiles, defaultValue: 0)
}

private func boxBlur(_ p: UnsafeMutablePointer<Float>, _ w: Int, _ h: Int, _ r: Int) {
    var tmp = [Float](repeating: 0, count: Swift.max(w, h))
    let n = Double(2 * r + 1)
    for y in 0..<h {
        var sum = 0.0
        for k in -r...r { sum += Double(p[y * w + Swift.min(w - 1, Swift.max(0, k))]) }
        for x in 0..<w {
            tmp[x] = Float(sum / n)
            sum += Double(p[y * w + Swift.min(w - 1, x + r + 1)]) - Double(p[y * w + Swift.max(0, x - r)])
        }
        for x in 0..<w { p[y * w + x] = tmp[x] }
    }
    for x in 0..<w {
        var sum = 0.0
        for k in -r...r { sum += Double(p[Swift.min(h - 1, Swift.max(0, k)) * w + x]) }
        for y in 0..<h {
            tmp[y] = Float(sum / n)
            sum += Double(p[Swift.min(h - 1, y + r + 1) * w + x]) - Double(p[Swift.max(0, y - r) * w + x])
        }
        for y in 0..<h { p[y * w + x] = tmp[y] }
    }
}

/// `colourToLinear(b / 255)` for every byte.
private let byteToLinear: [Double] = (0..<256).map { colourToLinear(Double($0) / 255) }

/**
 * The light a layer spills around it, as a Linear Dodge (Add) surface, or nil.
 *
 * The three passes run on every core, each over items that do not share a result: the energy by
 * rows of reduced cells (a cell takes pixels from its own row of cells only, in the same order),
 * the blur by colour channel, and the picture by pixel row. Pixels whose four reduced cells hold no
 * energy are skipped: they add nothing (`colourFromLinear(0)` is 0).
 */
func computeSpill(_ color: TiledSurface, _ light: TiledSurface?, _ spill: LightSpill) -> TiledSurface? {
    guard let light, let b = lightInfo(light).bounds, spill.radius > 0, spill.strength > 0 else { return nil }
    let r = Int(JS.ceil(spill.radius))
    let region = RasterRect(x: b.x - r, y: b.y - r, width: b.width + 2 * r, height: b.height + 2 * r)
    let col = readRegion(color, region)
    let lit = readRegion(light, region)
    // Reduced resolution: the blur is wide and smooth, so a few pixels per cell are enough.
    let f = Swift.max(1, Int(JS.floor(spill.radius / 6)))
    let w = Int(JS.ceil(Double(region.width) / Double(f)))
    let h = Int(JS.ceil(Double(region.height) / Double(f)))
    let rw = region.width, rh = region.height
    let cells = w * h
    // The three channels' energy, one after the other.
    var e = [Float](repeating: 0, count: cells * 3)
    var out = [UInt8](repeating: 0, count: rw * rh * 4)
    let strength = spill.strength
    let toLinear = byteToLinear
    // Three box blurs ≈ a Gaussian with σ ≈ radius / 2.
    let box = Swift.max(1, Int(JS.round(spill.radius / Double(f) / 2.5)))
    // Where each pixel column samples the reduced cells.
    var colX0 = [Int](repeating: 0, count: rw), colX1 = [Int](repeating: 0, count: rw), colT = [Double](repeating: 0, count: rw)
    for x in 0..<rw {
        let fx = Swift.min(Double(w - 1), Swift.max(0, (Double(x) + 0.5) / Double(f) - 0.5))
        let x0 = Int(JS.floor(fx))
        colX0[x] = x0
        colX1[x] = Swift.min(w - 1, x0 + 1)
        colT[x] = fx - Double(x0)
    }
    e.withUnsafeMutableBufferPointer { eb in
        out.withUnsafeMutableBufferPointer { ob in
            nonisolated(unsafe) let e = eb.baseAddress!
            nonisolated(unsafe) let o = ob.baseAddress!
            paintParallel(h) { cy in
                for y in (cy * f)..<Swift.min(rh, (cy + 1) * f) {
                    for x in 0..<rw {
                        let i = y * rw + x
                        let l = lit[i]
                        if l == 0 { continue }
                        let j = i * 4
                        let k = ((Double(l) / 255) * (Double(col[j + 3]) / 255)) / Double(f * f)
                        let cell = cy * w + x / f
                        for ch in 0..<3 { e[ch * cells + cell] = Float(Double(e[ch * cells + cell]) + toLinear[Int(col[j + ch])] * k) }
                    }
                }
            }
            paintParallel(3) { ch in for _ in 0..<3 { boxBlur(e + ch * cells, w, h, box) } }
            let e0 = e, e1 = e + cells, e2 = e + 2 * cells
            paintParallel(rh) { y in
                let fy = Swift.min(Double(h - 1), Swift.max(0, (Double(y) + 0.5) / Double(f) - 0.5))
                let y0 = Int(JS.floor(fy))
                let y1 = Swift.min(h - 1, y0 + 1)
                let ty = fy - Double(y0)
                for x in 0..<rw {
                    let x0 = colX0[x], x1 = colX1[x]
                    let tx = colT[x]
                    let a00 = y0 * w + x0, a01 = y0 * w + x1, a10 = y1 * w + x0, a11 = y1 * w + x1
                    if e0[a00] == 0 && e0[a01] == 0 && e0[a10] == 0 && e0[a11] == 0
                        && e1[a00] == 0 && e1[a01] == 0 && e1[a10] == 0 && e1[a11] == 0
                        && e2[a00] == 0 && e2[a01] == 0 && e2[a10] == 0 && e2[a11] == 0 { continue }
                    func add(_ p: UnsafeMutablePointer<Float>) -> Double {
                        let v = (Double(p[a00]) * (1 - tx) + Double(p[a01]) * tx) * (1 - ty) + (Double(p[a10]) * (1 - tx) + Double(p[a11]) * tx) * ty
                        return Swift.min(1, colourFromLinear(Swift.min(1, v * strength)))
                    }
                    let add0 = add(e0), add1 = add(e1), add2 = add(e2)
                    let a = Swift.max(add0, add1, add2)
                    if a <= 1.0 / 255 { continue }
                    let p = (y * rw + x) * 4
                    o[p] = JS.u8c(JS.round((add0 / a) * 255))
                    o[p + 1] = JS.u8c(JS.round((add1 / a) * 255))
                    o[p + 2] = JS.u8c(JS.round((add2 / a) * 255))
                    o[p + 3] = JS.u8c(JS.round(a * 255))
                }
            }
        }
    }
    return surfaceFromPixels(width: rw, height: rh, data: out, channels: 4, x: region.x, y: region.y)
}

/// A light channel as saved (`{ rect, light }`, a grey PNG data URL), or nil when it has no light.
func lightToJSON(_ light: TiledSurface) -> JSONValue? {
    guard let b = lightInfo(light).bounds else { return nil }
    return ["rect": b.json, "light": .string(pngDataUrl(b.width, b.height, readRegion(light, b), 1))]
}

/// Saved form → light channel (`lightFromJSON`); throws a sentence when it cannot be read.
func lightFromJSON(_ raw: JSONValue) throws -> TiledSurface {
    guard let r = raw.objectValue, jsTruthy(r["rect"]), let url = r["light"]?.stringValue
    else { throw PaintEditorError("not a saved light channel") }
    guard let parsed = parseDataUrl(url) else { throw PaintEditorError("the light is not a PNG data URL") }
    let img = try decodePng(parsed.bytes, keepGray: true)
    let data = img.channels == 1 ? img.data : (0..<(img.width * img.height)).map { img.data[$0 * 4] }
    return try surfaceAtSavedRect(r["rect"], width: img.width, height: img.height, data: data, channels: 1)
}

/// The upper layer's light over the lower's (where the upper paint is transparent), for merging down.
func mergeLight(_ lower: TiledSurface?, _ upper: TiledSurface?, _ upperColor: TiledSurface) -> TiledSurface? {
    guard let upper, !upper.tiles.isEmpty else { return lower }
    var keys: [TileKey] = lower?.tiles.keys ?? []
    for k in upper.tiles.keys where !keys.contains(k) { keys.append(k) }
    var tiles = OrderedMap<TileKey, Tile>()
    for key in keys {
        let l = lower?.tiles.get(key)?.data
        let u = upper.tiles.get(key)?.data
        let c = upperColor.tiles.get(key)?.data
        var d = [UInt8](repeating: 0, count: TILE * TILE)
        for i in 0..<d.count {
            let a = c.map { Double($0[i * 4 + 3]) / 255 } ?? 0
            d[i] = JS.u8c(JS.round(Double(u?[i] ?? 0) + Double(l?[i] ?? 0) * (1 - a)))
        }
        if let t = finishTile(d, 1, 0) { tiles.set(key, t) }
    }
    return TiledSurface(channels: 1, tiles: tiles, defaultValue: 0)
}

extension PaintDocumentState {
    /// The document's light with one layer's set (removed when it is empty); unchanged for nil.
    func settingLight(_ layerId: String, _ next: TiledSurface?) {
        guard let next else { return }
        var out = light ?? OrderedMap()
        if !next.tiles.isEmpty { out.set(layerId, next) } else { _ = out.delete(layerId) }
        light = out
    }

    /// The document's stickers without these layers.
    func removingStickers(_ ids: [String]) {
        guard var t = stickers, ids.contains(where: { t.has($0) }) else { return }
        for id in ids { _ = t.delete(id) }
        stickers = t
    }

    /// The document's light without these layers.
    func removingLight(_ ids: [String]) {
        guard var l = light, ids.contains(where: { l.has($0) }) else { return }
        for id in ids { _ = l.delete(id) }
        light = l
    }
}
