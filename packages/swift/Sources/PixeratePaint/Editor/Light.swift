import Foundation
import PixerateCore
import PixerateRaster

/**
 * Light paint (`paint-editor/light.ts`): a layer's light channel, one byte per pixel in layer space
 * (0 none .. 255 full), laid by a grey twin of each stroke of a brush with `light.amount`. The
 * paint glows where its light is (its colour brightened in linear light), and the light spills
 * onto what is around it as a blurred Linear Dodge (Add) pass above the layer.
 *
 * This port draws light from dry brushes; thick paint's rim and clarity (and wet light) are #545.
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

/// The paint brightened where it has light (dry light paint: no rim or clarity).
func glowSurface(_ color: TiledSurface, _ light: TiledSurface?) -> TiledSurface {
    guard let light, !light.tiles.isEmpty else { return color }
    var out = color.tiles
    for (key, tile) in color.tiles {
        guard let l = light.tiles.get(key) else { continue }
        let ld = l.data
        var d = tile.data
        for i in 0..<(TILE * TILE) {
            let j = i * 4
            if d[j + 3] == 0 { continue }
            let g = ld[i] != 0 ? Double(ld[i]) / 255 : 0
            if g > 0 {
                for ch in 0..<3 { d[j + ch] = JS.u8c(JS.round(colourFromLinear(Swift.min(1, colourToLinear(Double(d[j + ch]) / 255) * (1 + GLOW * g))) * 255)) }
            }
        }
        out.set(key, Tile(data: d, uniform: nil))
    }
    return TiledSurface(channels: 4, tiles: out, defaultValue: color.defaultValue)
}

private func boxBlur(_ p: inout [Float], _ w: Int, _ h: Int, _ r: Int) {
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

/// The light a layer spills around it, as a Linear Dodge (Add) surface, or nil.
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
    var e = [[Float](repeating: 0, count: w * h), [Float](repeating: 0, count: w * h), [Float](repeating: 0, count: w * h)]
    for y in 0..<region.height {
        for x in 0..<region.width {
            let i = y * region.width + x
            let l = lit[i]
            if l == 0 { continue }
            let j = i * 4
            let k = ((Double(l) / 255) * (Double(col[j + 3]) / 255)) / Double(f * f)
            let cell = (y / f) * w + x / f
            for ch in 0..<3 { e[ch][cell] = Float(Double(e[ch][cell]) + colourToLinear(Double(col[j + ch]) / 255) * k) }
        }
    }
    // Three box blurs ≈ a Gaussian with σ ≈ radius / 2.
    let box = Swift.max(1, Int(JS.round(spill.radius / Double(f) / 2.5)))
    for ch in 0..<3 { for _ in 0..<3 { boxBlur(&e[ch], w, h, box) } }
    var out = [UInt8](repeating: 0, count: region.width * region.height * 4)
    for y in 0..<region.height {
        for x in 0..<region.width {
            let fx = Swift.min(Double(w - 1), Swift.max(0, (Double(x) + 0.5) / Double(f) - 0.5))
            let fy = Swift.min(Double(h - 1), Swift.max(0, (Double(y) + 0.5) / Double(f) - 0.5))
            let x0 = Int(JS.floor(fx)), y0 = Int(JS.floor(fy))
            let x1 = Swift.min(w - 1, x0 + 1), y1 = Swift.min(h - 1, y0 + 1)
            let tx = fx - Double(x0), ty = fy - Double(y0)
            let add = e.map { p -> Double in
                let v = (Double(p[y0 * w + x0]) * (1 - tx) + Double(p[y0 * w + x1]) * tx) * (1 - ty) + (Double(p[y1 * w + x0]) * (1 - tx) + Double(p[y1 * w + x1]) * tx) * ty
                return Swift.min(1, colourFromLinear(Swift.min(1, v * spill.strength)))
            }
            let a = Swift.max(add[0], add[1], add[2])
            if a <= 1.0 / 255 { continue }
            let o = (y * region.width + x) * 4
            out[o] = JS.u8c(JS.round((add[0] / a) * 255))
            out[o + 1] = JS.u8c(JS.round((add[1] / a) * 255))
            out[o + 2] = JS.u8c(JS.round((add[2] / a) * 255))
            out[o + 3] = JS.u8c(JS.round(a * 255))
        }
    }
    return surfaceFromPixels(width: region.width, height: region.height, data: out, channels: 4, x: region.x, y: region.y)
}

/// A light channel as saved (`{ rect, light }`, a grey PNG data URL), or nil when it has no light.
func lightToJSON(_ light: TiledSurface) -> JSONValue? {
    guard let b = lightInfo(light).bounds else { return nil }
    return ["rect": b.json, "light": .string(pngDataUrl(b.width, b.height, readRegion(light, b), 1))]
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
