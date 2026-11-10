import Foundation
import PixerateCore
import PixerateRaster

/**
 * Painting time machine (`paint-editor/age.ts`, `paint-editor/scraper.ts`, `paint-editor/time-machine-tools.ts`):
 * - Non-destructive ageing preview (`set_age`, `get_age`): hue-dependent pigment fading, yellowed
 *   varnish absorption, seeded Voronoi / stress craquelure cracks that carve relief height into
 *   `lightTile` so cracks catch raking light, and low-frequency gallery dust grain; committed with `bake_age`.
 * - X-ray radiograph view (`render_xray`, `set_xray_view`) revealing buried and hidden layers
 *   (pentimento) with `density = opacity * (thickHeight + lightnessWeight)`, and historical states (`strokes: k`).
 * - Scraper brush engine (`marks.kind: "scraper"`, preset `paint-scraper`) that cuts down through
 *   the visible unlocked paint stack layer by layer.
 */

/// Document ageing preview settings (`0..500` years).
public struct PaintAgeSettings: Equatable, Sendable {
    /// Simulated age in years (0..500, default 0).
    public var years: Double
    /// Yellowing varnish absorption over the painting (0..1, default 0.5).
    public var varnish: Double
    /// Seeded Voronoi / stress craquelure crack network (0..1, default 0.5).
    public var cracks: Double
    /// Hue-dependent pigment lightfastness fading (0..1, default 0.5).
    public var fading: Double
    /// Low-frequency gallery dust grain (0..1, default 0.3).
    public var dust: Double
    /// Deterministic craquelure and dust seed (whole number >= 0, default 1).
    public var seed: Int

    public init(years: Double = 0, varnish: Double = 0.5, cracks: Double = 0.5, fading: Double = 0.5, dust: Double = 0.3, seed: Int = 1) {
        self.years = years
        self.varnish = varnish
        self.cracks = cracks
        self.fading = fading
        self.dust = dust
        self.seed = seed
    }

    public var json: JSONValue {
        [
            "years": .number(years),
            "varnish": .number(varnish),
            "cracks": .number(cracks),
            "fading": .number(fading),
            "dust": .number(dust),
            "seed": .number(Double(seed)),
        ]
    }
}

public let DEFAULT_AGE = PaintAgeSettings()

/// Whether ageing has a visible effect.
public func isAgeActive(_ age: PaintAgeSettings?) -> Bool {
    guard let age, age.years > 0 else { return false }
    return age.varnish > 0 || age.cracks > 0 || age.fading > 0 || age.dust > 0
}

/// Cache key for an `age` configuration.
public func ageKey(_ age: PaintAgeSettings?) -> String {
    guard let age, isAgeActive(age) else { return "" }
    return "\(jsText(age.years))|\(jsText(age.varnish))|\(jsText(age.cracks))|\(jsText(age.fading))|\(jsText(age.dust))|\(age.seed)"
}

/// Validates partial age settings, throwing a `PaintEditorError` when any field is out of range.
public func validateAgeInput(_ input: JSONObject) throws {
    if let v = input["years"] {
        guard let n = v.finite, n >= 0 && n <= 500 else {
            throw PaintEditorError("years \(v.numberValue.map(jsText) ?? "NaN") is out of range; use 0..500.")
        }
    }
    for k in ["varnish", "cracks", "fading", "dust"] {
        if let v = input[k] {
            guard let n = v.finite, n >= 0 && n <= 1 else {
                throw PaintEditorError("\(k) \(v.numberValue.map(jsText) ?? "NaN") is out of range; use 0..1.")
            }
        }
    }
    if let v = input["seed"] {
        guard let n = v.finite, JS.floor(n) == n, n >= 0 && n <= 2_147_483_647 else {
            throw PaintEditorError("seed \(v.numberValue.map(jsText) ?? "NaN") must be a whole number 0..2147483647.")
        }
    }
}

/// Normalizes age settings into valid ranges, filling missing fields from `base`.
public func normalizeAge(_ input: JSONObject? = nil, _ base: PaintAgeSettings = DEFAULT_AGE) -> PaintAgeSettings {
    func num(_ v: JSONValue?, _ d: Double) -> Double { v?.finite ?? d }
    func clamp01(_ v: Double) -> Double { Swift.min(1, Swift.max(0, JS.round(v * 1000) / 1000)) }
    let r = input ?? [:]
    let years = Swift.min(500, Swift.max(0, JS.round(num(r["years"], base.years) * 100) / 100))
    let seedRaw = Int(JS.round(num(r["seed"], Double(base.seed))))
    let seed = Swift.min(2_147_483_647, Swift.max(0, seedRaw))
    return PaintAgeSettings(
        years: years,
        varnish: clamp01(num(r["varnish"], base.varnish)),
        cracks: clamp01(num(r["cracks"], base.cracks)),
        fading: clamp01(num(r["fading"], base.fading)),
        dust: clamp01(num(r["dust"], base.dust)),
        seed: seed
    )
}

/// Deterministic lightfastness fugitive table by hue every 30° (`0..360°`).
public let HUE_LIGHTFASTNESS_FUGITIVE: [Double] = [
    1.0,  // 0°   red (fastest fading)
    0.66, // 30°  orange-red
    0.5,  // 60°  yellow
    0.38, // 90°  yellow-green
    0.24, // 120° green
    0.2,  // 150° blue-green
    0.22, // 180° cyan
    0.16, // 210° cerulean / cobalt blue (most lightfast)
    0.2,  // 240° ultramarine blue
    0.82, // 270° blue-violet
    0.98, // 300° violet / magenta (fastest fading)
    0.95, // 330° crimson-rose (fastest fading)
]

/// Hue in degrees `0..360` from sRGB `0..1` channels (`0` when achromatic).
public func rgbHueDegrees(_ r: Double, _ g: Double, _ b: Double) -> Double {
    let maxC = Swift.max(r, Swift.max(g, b))
    let minC = Swift.min(r, Swift.min(g, b))
    let d = maxC - minC
    if d <= 1e-6 { return 0 }
    var h = 0.0
    if maxC == r {
        h = ((g - b) / d).truncatingRemainder(dividingBy: 6)
    } else if maxC == g {
        h = (b - r) / d + 2
    } else {
        h = (r - g) / d + 4
    }
    h *= 60
    return h < 0 ? h + 360 : h
}

/// Fugitive fading rate (`0.16..1.0`) for an sRGB `0..1` colour, interpolated from `HUE_LIGHTFASTNESS_FUGITIVE`.
public func hueFugitiveRate(_ r: Double, _ g: Double, _ b: Double) -> Double {
    let hue = rgbHueDegrees(r, g, b)
    let pos = (hue / 30).truncatingRemainder(dividingBy: 12)
    let fl = JS.floor(pos)
    let i0 = ((Int(fl) % 12) + 12) % 12
    let i1 = (i0 + 1) % 12
    let frac = pos - fl
    return HUE_LIGHTFASTNESS_FUGITIVE[i0] * (1 - frac) + HUE_LIGHTFASTNESS_FUGITIVE[i1] * frac
}

/// Smooth 2D value noise in `0..1` at continuous coordinates `(u, v)`.
private func valueNoise2D(_ u: Double, _ v: Double, _ seed: Int) -> Double {
    let x0 = JS.floor(u)
    let y0 = JS.floor(v)
    let fx = u - x0
    let fy = v - y0
    let sx = fx * fx * (3 - 2 * fx)
    let sy = fy * fy * (3 - 2 * fy)
    let ix = Int(x0), iy = Int(y0)
    let n00 = PixerateRandom.hash2(ix, iy, seed)
    let n10 = PixerateRandom.hash2(ix + 1, iy, seed)
    let n01 = PixerateRandom.hash2(ix, iy + 1, seed)
    let n11 = PixerateRandom.hash2(ix + 1, iy + 1, seed)
    return (n00 * (1 - sx) + n10 * sx) * (1 - sy) + (n01 * (1 - sx) + n11 * sx) * sy
}

/// Voronoi cell-edge ridge distance (`d2 - d1`, in cell units) at `(u, v)`.
private func voronoiEdge(_ u: Double, _ v: Double, _ seed: Int) -> Double {
    let gx = Int(JS.floor(u))
    let gy = Int(JS.floor(v))
    var d1 = 1e9
    var d2 = 1e9
    for dy in -1...1 {
        for dx in -1...1 {
            let cx = gx + dx
            let cy = gy + dy
            let px = Double(cx) + 0.15 + 0.7 * PixerateRandom.hash2(cx, cy, seed)
            let py = Double(cy) + 0.15 + 0.7 * PixerateRandom.hash2(cx, cy, seed + 1013)
            let dist = JS.hypot(u - px, v - py)
            if dist < d1 {
                d2 = d1
                d1 = dist
            } else if dist < d2 {
                d2 = dist
            }
        }
    }
    return d2 - d1
}

/// Seeded Voronoi / stress craquelure intensity (`0..1`) at document pixel `(wx, wy)`.
public func craquelureAt(_ wx: Double, _ wy: Double, _ seed: Int, _ layerCount: Int, _ thickHeight: Double) -> Double {
    let layers = Double(Swift.max(1, Swift.min(8, layerCount)))
    let h = Swift.max(0, Swift.min(1, thickHeight))
    let stress = Swift.min(1, (layers - 1) * 0.22 + h * 0.75)
    let cellSize = Swift.max(7, 22 - (layers - 1) * 2.2 - h * 6)
    let warpX = (valueNoise2D(wx / 24, wy / 24, seed + 307) - 0.5) * 0.35
    let warpY = (valueNoise2D(wx / 24, wy / 24, seed + 613) - 0.5) * 0.35
    let ePrimary = voronoiEdge(wx / cellSize + warpX, wy / cellSize + warpY, seed)
    let widthPrimary = 0.085 + 0.065 * stress
    var crack = ePrimary < widthPrimary ? 1 - ePrimary / widthPrimary : 0
    if stress > 0.05 {
        let fineSize = cellSize * 0.48
        let eFine = voronoiEdge(wx / fineSize - warpY, wy / fineSize + warpX, seed + 2029)
        let widthFine = (0.065 + 0.055 * stress) * stress
        if eFine < widthFine {
            let fineCrack = (1 - eFine / widthFine) * (0.45 + 0.55 * stress)
            if fineCrack > crack { crack = fineCrack }
        }
    }
    return crack > 0 ? Swift.min(1, crack * crack * (1.2 - 0.2 * crack)) : 0
}

/// Low-frequency gallery dust grain (`0..1`) at document pixel `(wx, wy)`.
public func dustAt(_ wx: Double, _ wy: Double, _ seed: Int) -> Double {
    let coarse = valueNoise2D(wx / 18, wy / 18, seed + 4099)
    let medium = valueNoise2D(wx / 5, wy / 5, seed + 8191)
    let speck = PixerateRandom.hash2(Int(JS.floor(wx)), Int(JS.floor(wy)), seed + 12289)
    return Swift.min(1, Swift.max(0, 0.58 * coarse + 0.32 * medium + (speck > 0.92 ? (speck - 0.92) * 2.5 : 0)))
}

/// Applies the four ageing effects to a single sRGB `0..1` pixel at document coordinate `(wx, wy)`.
public func agePixel(
    _ rIn: Double,
    _ gIn: Double,
    _ bIn: Double,
    _ wx: Double,
    _ wy: Double,
    _ age: PaintAgeSettings,
    _ layerCount: Int,
    _ thickHeight: Double
) -> (Double, Double, Double) {
    let timeFactor = Swift.min(1.35, age.years / 300)
    if timeFactor <= 0 { return (rIn, gIn, bIn) }
    var r = rIn
    var g = gIn
    var b = bIn

    if age.fading > 0 {
        let maxC = Swift.max(r, Swift.max(g, b))
        let minC = Swift.min(r, Swift.min(g, b))
        let chroma = maxC - minC
        let fugitive = hueFugitiveRate(r, g, b)
        let fadeAmt = Swift.min(0.88, timeFactor * age.fading * fugitive * (0.35 + 0.65 * chroma))
        let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
        let bleachR = lum * 0.82 + 0.165
        let bleachG = lum * 0.82 + 0.158
        let bleachB = lum * 0.82 + 0.145
        r += (bleachR - r) * fadeAmt
        g += (bleachG - g) * fadeAmt
        b += (bleachB - b) * fadeAmt
    }

    if age.varnish > 0 {
        let vAmt = Swift.min(1, timeFactor * age.varnish)
        r = r * (1 - 0.07 * vAmt) + 0.045 * vAmt
        g = g * (1 - 0.21 * vAmt) + 0.032 * vAmt
        b = b * (1 - 0.52 * vAmt) + 0.008 * vAmt
    }

    if age.cracks > 0 {
        let crackRaw = craquelureAt(wx, wy, age.seed, layerCount, thickHeight)
        if crackRaw > 0 {
            let cAmt = Swift.min(0.85, crackRaw * Swift.min(1, timeFactor * age.cracks))
            r = r * (1 - cAmt) + 0.12 * cAmt
            g = g * (1 - cAmt) + 0.085 * cAmt
            b = b * (1 - cAmt) + 0.055 * cAmt
        }
    }

    if age.dust > 0 {
        let dNoise = dustAt(wx, wy, age.seed)
        let dAmt = Swift.min(0.65, timeFactor * age.dust * (0.32 + 0.68 * dNoise))
        r += (0.72 - r) * dAmt
        g += (0.69 - g) * dAmt
        b += (0.63 - b) * dAmt
    }

    return (
        Swift.min(1, Swift.max(0, r)),
        Swift.min(1, Swift.max(0, g)),
        Swift.min(1, Swift.max(0, b))
    )
}

/// Carves craquelure crack channels into a 256×256 height tile before `lightTile` runs, so crack edges catch raking light.
public func carveAgeCrackHeightTile(
    _ colorData: [UInt8]?,
    _ baseHeightData: [UInt8]?,
    _ tx: Int,
    _ ty: Int,
    _ offset: LayerOffset,
    _ age: PaintAgeSettings,
    _ layerCount: Int
) -> [UInt8]? {
    if !isAgeActive(age) || age.cracks <= 0 { return baseHeightData }
    if colorData == nil && baseHeightData == nil { return nil }
    let timeFactor = Swift.min(1.35, age.years / 300)
    let strength = Swift.min(1, timeFactor * age.cracks)
    if strength <= 0 { return baseHeightData }
    var out = [UInt8](repeating: 0, count: TILE * TILE)
    let ox = tx * TILE + offset.x
    let oy = ty * TILE + offset.y
    var any = false
    var p = 0
    for y in 0..<TILE {
        let wy = Double(oy + y)
        for x in 0..<TILE {
            let a = colorData != nil ? Int(colorData![p * 4 + 3]) : 0
            let h0 = baseHeightData != nil ? Int(baseHeightData![p]) : 0
            if a == 0 && h0 == 0 {
                p += 1
                continue
            }
            let filmH = Swift.max(h0, Int(JS.round(Double(a * 56) / 255)))
            let crack = craquelureAt(Double(ox + x), wy, age.seed, layerCount, Double(h0) / 255)
            let drop = crack > 0 ? Int(JS.round(crack * strength * Double(Swift.min(filmH, 160)))) : 0
            let h1 = Swift.max(0, filmH - drop)
            out[p] = UInt8(h1)
            if h1 != 0 { any = true }
            p += 1
        }
    }
    return any ? out : baseHeightData
}

/// Ages one 256×256 RGBA tile of a paint layer on its own (the editor ages the composite: `ageCompositeRegion`).
public func ageTile(
    _ colorData: [UInt8],
    _ heightData: [UInt8]?,
    _ tx: Int,
    _ ty: Int,
    _ offset: LayerOffset,
    _ age: PaintAgeSettings,
    _ layerCount: Int
) -> [UInt8] {
    var out = colorData
    if !isAgeActive(age) { return out }
    let ox = tx * TILE + offset.x
    let oy = ty * TILE + offset.y
    var p = 0
    for y in 0..<TILE {
        let wy = Double(oy + y)
        for x in 0..<TILE {
            let i = p * 4
            let a = colorData[i + 3]
            if a == 0 {
                p += 1
                continue
            }
            let hNorm = heightData != nil ? Double(heightData![p]) / 255 : 0
            let (r, g, b) = agePixel(
                Double(colorData[i]) / 255,
                Double(colorData[i + 1]) / 255,
                Double(colorData[i + 2]) / 255,
                Double(ox + x),
                wy,
                age,
                layerCount,
                hNorm
            )
            out[i] = JS.u8c(r * 255)
            out[i + 1] = JS.u8c(g * 255)
            out[i + 2] = JS.u8c(b * 255)
            p += 1
        }
    }
    return out
}

/// Ages a paper tile over `(x0, y0, width, height)`.
public func agePaperTile(
    _ tile: [UInt8],
    _ x0: Int,
    _ y0: Int,
    _ width: Int,
    _ height: Int,
    _ age: PaintAgeSettings
) -> [UInt8] {
    if !isAgeActive(age) { return tile }
    var out = tile
    var p = 0
    for y in 0..<height {
        let wy = Double(y0 + y)
        for x in 0..<width {
            let i = p * 4
            let (r, g, b) = agePixel(
                Double(tile[i]) / 255,
                Double(tile[i + 1]) / 255,
                Double(tile[i + 2]) / 255,
                Double(x0 + x),
                wy,
                age,
                1,
                0
            )
            out[i] = JS.u8c(r * 255)
            out[i + 1] = JS.u8c(g * 255)
            out[i + 2] = JS.u8c(b * 255)
            p += 1
        }
    }
    return out
}

/// A painted layer as the composite ageing pass reads it: its alpha marks paint, its thick height feeds the cracks.
public struct AgeFieldLayer {
    /// The layer's RGBA pixels (only alpha is read).
    public var surface: TiledSurface
    /// The layer's thick paint height (one channel, `0..255`), when it has impasto.
    public var height: TiledSurface?
    /// Where the layer sits on the canvas.
    public var offset: LayerOffset

    public init(surface: TiledSurface, height: TiledSurface? = nil, offset: LayerOffset) {
        self.surface = surface
        self.height = height
        self.offset = offset
    }
}

/**
 * The time machine's single ageing pass over the composite (`ageCompositeRegion`): ages
 * straight-alpha RGBA `data` (`rect.width × rect.height`, document pixels `rect`) in place. Where
 * any `layers` pixel is painted the craquelure uses `layerCount` and the tallest thick height there;
 * bare ground (paper) ages as one layer with no impasto. Transparent pixels are left alone.
 */
public func ageCompositeRegion(
    _ data: inout [UInt8],
    _ rect: RasterRect,
    _ age: PaintAgeSettings,
    _ layers: [AgeFieldLayer],
    _ layerCount: Int
) {
    if !isAgeActive(age) { return }
    let n = rect.width * rect.height
    var covered = [Bool](repeating: false, count: n)
    var tallest = [UInt8](repeating: 0, count: n)
    for l in layers {
        let r = RasterRect(x: rect.x - l.offset.x, y: rect.y - l.offset.y, width: rect.width, height: rect.height)
        let color = readRegion(l.surface, r)
        let height = l.height.map { readRegion($0, r) }
        for p in 0..<n where color[p * 4 + 3] != 0 {
            covered[p] = true
            if let height, height[p] > tallest[p] { tallest[p] = height[p] }
        }
    }
    var p = 0
    for y in 0..<rect.height {
        let wy = Double(rect.y + y)
        for x in 0..<rect.width {
            let i = p * 4
            if data[i + 3] != 0 {
                let paint = covered[p]
                let (r, g, b) = agePixel(
                    Double(data[i]) / 255,
                    Double(data[i + 1]) / 255,
                    Double(data[i + 2]) / 255,
                    Double(rect.x + x),
                    wy,
                    age,
                    paint ? layerCount : 1,
                    paint ? Double(tallest[p]) / 255 : 0
                )
                // Math.round, as the TypeScript pass stores them.
                data[i] = UInt8(JS.round(r * 255))
                data[i + 1] = UInt8(JS.round(g * 255))
                data[i + 2] = UInt8(JS.round(b * 255))
            }
            p += 1
        }
    }
}

public struct XrayResult: Sendable {
    public var width: Int
    public var height: Int
    public var data: [UInt8]
    public var strokes: Int
    public var totalStrokes: Int
    public var layerCount: Int
    public var hiddenLayerCount: Int
    public var maxDensity: Double
    public var meanDensity: Double
}

/// Composites every pixel layer (hidden ones included) into an X-ray radiograph.
public func renderXrayPixels(
    _ width: Int,
    _ height: Int,
    _ layers: [PaintLayer],
    _ thick: OrderedMap<String, ThickChannels>?,
    _ strokes: Int = 0,
    _ totalStrokes: Int = 0
) -> XrayResult {
    let pixelLayers = flattenLayers(layers).filter(\.isPixel)
    let hiddenLayerCount = pixelLayers.filter { !$0.visible }.count
    var out = [UInt8](repeating: 0, count: width * height * 4)
    var maxDensity = 0.0
    var sumDensity = 0.0
    let totalPixels = width * height

    for y in 0..<height {
        for x in 0..<width {
            var density = 0.0
            for l in pixelLayers {
                let op = Swift.max(0, Swift.min(1, l.opacity))
                if op <= 0 { continue }
                let lx = x - l.pixelOffset.x
                let ly = y - l.pixelOffset.y
                let rgba = readPixel(l.pixelSurface, lx, ly)
                let a = Double(rgba[3]) / 255
                let hSurf = thick?.get(l.id)?.height
                let h = hSurf != nil ? Double(readPixel(hSurf!, lx, ly)[0]) / 255 : 0
                if a <= 0 && h <= 0 { continue }
                let r = Double(rgba[0]) / 255
                let g = Double(rgba[1]) / 255
                let b = Double(rgba[2]) / 255
                let lightnessWeight = 0.22 + 0.78 * (0.2126 * r + 0.7152 * g + 0.0722 * b)
                density += op * (h + a * lightnessWeight)
            }
            if density > maxDensity { maxDensity = density }
            sumDensity += density
            let d = 1 - JS.exp(-density * 1.25)
            let idx = (y * width + x) * 4
            out[idx] = JS.u8c(10 + 235 * JS.pow(d, 1.12))
            out[idx + 1] = JS.u8c(14 + 236 * d)
            out[idx + 2] = JS.u8c(20 + 235 * JS.pow(d, 0.88))
            out[idx + 3] = 255
        }
    }

    return XrayResult(
        width: width,
        height: height,
        data: out,
        strokes: strokes,
        totalStrokes: totalStrokes,
        layerCount: pixelLayers.count,
        hiddenLayerCount: hiddenLayerCount,
        maxDensity: JS.round(maxDensity * 1000) / 1000,
        meanDensity: totalPixels > 0 ? JS.round((sumDensity / Double(totalPixels)) * 1000) / 1000 : 0
    )
}

// MARK: - Scraper brush engine (`paint-editor/scraper.ts`)

struct ScraperStrokeInit {
    var brush: PaintBrush
    var seed: Int
    var copies: [StrokeCopy]
    var selection: PaintSelection?
    var inputFilter: ((PenPoint) -> PenPoint)?
}

private final class LayerScratch {
    let layer: PaintLayer
    var colorTiles: OrderedMap<TileKey, ByteTile> = OrderedMap()
    var heightTiles: OrderedMap<TileKey, ByteTile> = OrderedMap()
    let baseThick: ThickChannels
    var touched = false

    init(layer: PaintLayer, baseThick: ThickChannels) {
        self.layer = layer
        self.baseThick = baseThick
    }
}

private func expandScraperTile(_ t: Tile, _ channels: Int) -> [UInt8] {
    if t.data.count == TILE * TILE * channels { return t.data }
    let u = t.uniform ?? 0
    if channels == 1 { return [UInt8](repeating: UInt8(u & 255), count: TILE * TILE) }
    var out = [UInt8](repeating: 0, count: TILE * TILE * 4)
    let r = UInt8((u >> 24) & 255), g = UInt8((u >> 16) & 255), b = UInt8((u >> 8) & 255), a = UInt8(u & 255)
    var i = 0
    while i < out.count {
        out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a
        i += 4
    }
    return out
}

/// Collects the top-to-bottom stack of visible pixel layers that a scraper stroke can cut through.
public func collectScrapeableLayers(_ doc: PaintDocumentState) -> (layers: [PaintLayer], stoppedAtLocked: PaintLayer?) {
    var result: [PaintLayer] = []
    var stoppedAtLocked: PaintLayer? = nil

    func isLocked(_ l: PaintLayer) -> Bool {
        isLayerLocked(l.locks, .all) || isLayerLocked(l.locks, .pixels) || isLayerLocked(l.locks, .transparency)
    }

    func walk(_ list: [PaintLayer]) -> Bool {
        for l in list.reversed() {
            if !l.visible { continue }
            if isLocked(l) {
                stoppedAtLocked = l
                return false
            }
            if let children = l.children {
                if !walk(children) { return false }
            } else if l.isPixel {
                if doc.liveStrokes?.get(l.id) != nil || !(doc.stickers?.get(l.id)?.isEmpty ?? true) {
                    stoppedAtLocked = l
                    return false
                }
                result.append(l)
            }
        }
        return true
    }

    _ = walk(doc.layers)
    return (result, stoppedAtLocked)
}

/// The pixel layers a recorded scraper stroke cut through (`RecordedStroke.scrapeLayerIds`, top to
/// bottom), as they are in `doc`. Replays use these instead of `collectScrapeableLayers`, so a replay
/// that shows and unlocks every layer cuts only what the live stroke cut. Ids that are gone or no
/// longer plain pixel layers are skipped.
public func scrapeLayersByIds(_ doc: PaintDocumentState, _ ids: [String]) -> [PaintLayer] {
    ids.compactMap { id -> PaintLayer? in
        guard let l = findLayer(doc.layers, id)?.layer, l.isPixel, l.children == nil else { return nil }
        if doc.liveStrokes?.get(l.id) != nil || !(doc.stickers?.get(l.id)?.isEmpty ?? true) { return nil }
        return l
    }
}

/// Driver that scrapes through `doc`'s visible unlocked pixel layers from top to bottom.
public final class ScraperStrokeDriver {
    public var dabCount = 0
    let initValues: ScraperStrokeInit
    /// The layers this stroke cuts through, top to bottom (recorded with the stroke).
    public let layerIds: [String]
    private let smoother: PenSmoother
    private let walkers: [PenDabWalker]
    private let copies: [StrokeCopy]
    private let stack: [LayerScratch]
    private var lastRaw: PenPoint?
    private var lastFed: PenPoint?
    public var bounds: RasterRect?

    init(_ i: ScraperStrokeInit, scrapeLayers: [PaintLayer], thickMap: OrderedMap<String, ThickChannels>?) {
        initValues = i
        layerIds = scrapeLayers.map(\.id)
        let b = i.brush
        smoother = PenSmoother(b.tip.smoothing, b.pressureSmoothing)
        copies = i.copies.isEmpty ? [IDENTITY_COPY] : i.copies
        walkers = copies.enumerated().map { k, c in
            PenDabWalker(b, Int(Int32(truncatingIfNeeded: i.seed + k * 7919)), c.linear)
        }
        stack = scrapeLayers.map { layer in
            LayerScratch(layer: layer, baseThick: thickMap?.get(layer.id) ?? emptyThickChannels())
        }
    }

    public func push(_ points: [PenPoint]) -> [RasterRect] {
        var rects: [RasterRect] = []
        for rawIn in points {
            let raw = initValues.inputFilter.map { $0(rawIn) } ?? rawIn
            lastRaw = raw
            let p = smoother.push(raw)
            lastFed = p
            for (k, c) in copies.enumerated() {
                var dabs: [PenDab] = []
                walkers[k].push(c.map(p), &dabs)
                applyDabs(dabs, &rects)
            }
        }
        return rects
    }

    public func finish() -> [RasterRect] {
        var rects: [RasterRect] = []
        for (k, c) in copies.enumerated() {
            var dabs: [PenDab] = []
            if let raw = lastRaw, let fed = lastFed, raw.x != fed.x || raw.y != fed.y {
                var q = raw
                q.pressure = fed.pressure
                walkers[k].push(c.map(q), &dabs)
            }
            walkers[k].finish(&dabs)
            applyDabs(dabs, &rects)
        }
        return rects
    }

    private func applyDabs(_ dabs: [PenDab], _ rects: inout [RasterRect]) {
        let hardness = Swift.max(initValues.brush.tip.hardness, initValues.brush.scraper.sharpness)
        for d in dabs {
            let rect = dabRect(d.dab, hardness)
            if rect.width <= 0 || rect.height <= 0 { continue }
            dab(d, rect, hardness)
            rects.append(rect)
            bounds = unionRect(bounds, rect)
            dabCount += 1
        }
    }

    private func getColorTile(_ entry: LayerScratch, _ key: TileKey, _ write: Bool) -> ByteTile? {
        if let existing = entry.colorTiles.get(key) { return existing }
        guard let base = entry.layer.pixelSurface.tiles.get(key) else { return nil }
        let expanded = expandScraperTile(base, 4)
        if !write { return ByteTile(expanded) }
        let copy = ByteTile(expanded)
        entry.colorTiles.set(key, copy)
        entry.touched = true
        return copy
    }

    private func getHeightTile(_ entry: LayerScratch, _ key: TileKey, _ write: Bool) -> ByteTile? {
        if let existing = entry.heightTiles.get(key) { return existing }
        guard let base = entry.baseThick.height.tiles.get(key) else { return nil }
        let expanded = expandScraperTile(base, 1)
        if !write { return ByteTile(expanded) }
        let copy = ByteTile(expanded)
        entry.heightTiles.set(key, copy)
        entry.touched = true
        return copy
    }

    private func dab(_ d: PenDab, _ rect: RasterRect, _ hardness: Double) {
        if stack.isEmpty { return }
        let b = initValues.brush
        let depth = b.scraper.depth
        let sharpness = b.scraper.sharpness
        let dabOpacity = Swift.min(1, d.dab.alpha * d.dab.opacity * b.tip.opacity)
        if depth <= 0 || dabOpacity <= 0 { return }

        let n = rect.width * rect.height
        var tip = [Float](repeating: 0, count: n)
        var flat = d.dab
        flat.alpha = 1
        rasterizeDab(flat, hardness, rect, &tip)
        let sel = initValues.selection
        let edge = Swift.max(0.08, 1 - 0.88 * sharpness)

        var p = 0
        for yy in 0..<rect.height {
            let wy = rect.y + yy
            for xx in 0..<rect.width {
                var cov = Double(tip[p])
                p += 1
                if cov <= 0 { continue }
                let wx = rect.x + xx
                if let sel {
                    let m = wx >= 0 && wy >= 0 && wx < sel.width && wy < sel.height ? Double(sel.data[wy * sel.width + wx]) / 255 : 0
                    cov *= m
                    if cov <= 0 { continue }
                }
                let shaped = Swift.min(1, cov / edge)
                var rem = shaped * dabOpacity * depth
                if rem <= 1e-6 { continue }

                for entry in stack {
                    if rem <= 1e-6 { break }
                    let lx = wx - entry.layer.pixelOffset.x
                    let ly = wy - entry.layer.pixelOffset.y
                    let key = tileKey(lx >> 8, ly >> 8)
                    let cRead = getColorTile(entry, key, false)
                    let hRead = getHeightTile(entry, key, false)
                    if cRead == nil && hRead == nil { continue }
                    let pi = (ly & 255) * TILE + (lx & 255)
                    let a0 = cRead != nil ? Double(cRead!.data[pi * 4 + 3]) / 255 : 0
                    let h0 = hRead != nil ? Double(hRead!.data[pi]) / 255 : 0
                    if a0 <= 0 && h0 <= 0 { continue }

                    let present = Swift.max(a0, h0)
                    let take = Swift.min(present, rem)
                    rem -= take
                    let keep = present > 0 ? Swift.max(0, (present - take) / present) : 0

                    if a0 > 0 {
                        let cWrite = getColorTile(entry, key, true)!
                        let idx = pi * 4
                        // Math.round first (half up), as TS does, not the clamped store's half-to-even.
                        let a1 = JS.u8c(JS.round(a0 * 255 * keep))
                        cWrite.data[idx + 3] = a1
                        if a1 == 0 {
                            cWrite.data[idx] = 0
                            cWrite.data[idx + 1] = 0
                            cWrite.data[idx + 2] = 0
                        }
                    }
                    if h0 > 0 {
                        let hWrite = getHeightTile(entry, key, true)!
                        hWrite.data[pi] = JS.u8c(JS.round(h0 * 255 * keep))
                    }
                }
            }
        }
    }

    public var hasChanges: Bool { stack.contains(where: \.touched) }

    public func liveSurfaces() -> [String: TiledSurface] {
        var out: [String: TiledSurface] = [:]
        for entry in stack {
            if !entry.touched || entry.colorTiles.isEmpty { continue }
            var tiles = entry.layer.pixelSurface.tiles
            for (k, bt) in entry.colorTiles {
                tiles.set(k, Tile(data: bt.data, uniform: nil))
            }
            out[entry.layer.id] = TiledSurface(channels: 4, tiles: tiles, defaultValue: 0)
        }
        return out
    }

    public func commitToDocument(_ baseDoc: PaintDocumentState) -> (doc: PaintDocumentState, bounds: RasterRect?, scrapedLayerIds: [String]) {
        var layers = baseDoc.layers
        var nextThick = baseDoc.thick ?? OrderedMap()
        var scrapedLayerIds: [String] = []

        for entry in stack {
            if !entry.touched { continue }
            scrapedLayerIds.append(entry.layer.id)
            if !entry.colorTiles.isEmpty {
                var tiles = entry.layer.pixelSurface.tiles
                for (k, bt) in entry.colorTiles {
                    if let finished = finishTile(bt.data, 4, 0) { tiles.set(k, finished) } else { _ = tiles.delete(k) }
                }
                let surface = TiledSurface(channels: 4, tiles: tiles, defaultValue: 0)
                layers = mapLayer(layers, entry.layer.id) { $0.withSurface(surface) }
            }
            if !entry.heightTiles.isEmpty {
                var hTiles = entry.baseThick.height.tiles
                for (k, bt) in entry.heightTiles {
                    if let finished = finishTile(bt.data, 1, 0) { hTiles.set(k, finished) } else { _ = hTiles.delete(k) }
                }
                let ch = ThickChannels(
                    height: TiledSurface(channels: 1, tiles: hTiles, defaultValue: 0),
                    material: entry.baseThick.material,
                    film: entry.baseThick.film
                )
                if hasThickChannels(ch) { nextThick.set(entry.layer.id, ch) } else { _ = nextThick.delete(entry.layer.id) }
            }
        }

        if scrapedLayerIds.isEmpty {
            return (baseDoc, bounds, scrapedLayerIds)
        }
        let nextDoc = baseDoc.with {
            $0.layers = layers
            $0.thick = nextThick.isEmpty ? nil : nextThick
        }
        return (nextDoc, bounds, scrapedLayerIds)
    }
}

// MARK: - PaintEditorController Time Machine

extension PaintEditorController {
    /// `d` carrying the editor's current ageing settings (none when they are the defaults).
    func withAge(_ d: PaintDocumentState) -> PaintDocumentState {
        let want: PaintAgeSettings? = age != DEFAULT_AGE ? age : nil
        return d.age == want ? d : d.with { $0.age = want }
    }

    /// Reads the document's non-destructive ageing preview settings (`get_age`).
    public func getAge() -> PaintAgeSettings { age }

    /// Sets the non-destructive ageing preview (`set_age`). Saved with the document, not an undo step.
    @discardableResult
    public func setAge(_ update: JSONObject) throws -> PaintAgeSettings {
        try validateAgeInput(update)
        // Live growth commits first: the new document would otherwise drop its pending replay events.
        flushCulturePreview()
        age = normalizeAge(update, age)
        doc = withAge(doc)
        return age
    }

    /// Commits the current aged look into a new pixel layer at the top of the stack and resets `years` to 0 (`bake_age`, one undo step).
    public func bakeAge(name: String? = nil) throws -> (layer: PaintLayerInfo, age: PaintAgeSettings, bounds: RasterRect?) {
        // The TS core also refuses while wet paint is mid-step (`requireWetIdle`); the Swift wet simulation steps synchronously, so there is no such state here.
        if liveStroke != nil { throw PaintEditorError("A stroke is in progress; end or cancel it before baking ageing.") }
        if !isAgeActive(age) {
            throw PaintEditorError("Ageing is off (years is 0 or all effects are 0); call set_age with years above 0 before baking.")
        }
        let before = doc
        let bakedAge = age
        let agedPixels = compositePixels(paper: false, wet: "dried", age: true)
        let surface = surfaceFromPixels(width: agedPixels.width, height: agedPixels.height, data: agedPixels.data, channels: 4)
        let bounds = contentBounds(surface)
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let label = !trimmed.isEmpty ? trimmed : "Aged (\(Int(JS.round(bakedAge.years))) yr)"
        let newLayer = createPaintLayer(label).withSurface(surface)
        var nextAge = age
        nextAge.years = 0
        age = nextAge
        let hasAge = nextAge != DEFAULT_AGE
        let nextDoc = doc.with {
            $0.layers = doc.layers + [newLayer]
            $0.activeLayerId = newLayer.id
            $0.age = hasAge ? nextAge : nil
        }
        commit("Bake age", nextDoc, before: before)
        let info = listLayers().first { $0.id == newLayer.id }!
        return (info, bakedAge, bounds)
    }

    /// Whether the X-ray radiograph view is switched on in the viewport.
    public func getXrayView() -> Bool { xrayView }

    /// Switches the X-ray radiograph view on or off in the viewport (`set_xray_view`).
    @discardableResult
    public func setXrayView(_ on: Bool) -> Bool {
        if xrayView == on { return on }
        xrayView = on
        return on
    }

    /// Renders a read-only X-ray radiograph of the painting (`render_xray`).
    public func renderXray(strokes: Int? = nil, maxSide maxSideIn: Int? = nil) async throws -> XrayResult {
        let maxSide = maxSideIn ?? 512
        if maxSide < 16 || maxSide > 2048 {
            throw PaintEditorError("maxSide \(maxSide) is out of range; use a whole number 16..2048.")
        }
        let totalStrokes = doc.strokes.count
        if let strokes {
            if strokes < 0 || strokes > totalStrokes {
                throw PaintEditorError("strokes \(strokes) is out of range; the painting has \(totalStrokes) recorded strokes, so use 0..\(totalStrokes).")
            }
            let target = try createReplayTarget(scale: 1)
            let hiddenIds = Set(flattenLayers(doc.layers).filter { !$0.visible }.map(\.id))
            func unlockAll(_ list: [PaintLayer]) -> [PaintLayer] {
                list.map { l in
                    let u = l.copy(visible: true, locks: .some(nil))
                    return u.children.map { u.withChildren(unlockAll($0)) } ?? u
                }
            }
            func restoreVis(_ list: [PaintLayer]) -> [PaintLayer] {
                list.map { l in
                    let r = l.copy(visible: !hiddenIds.contains(l.id))
                    return r.children.map { r.withChildren(restoreVis($0)) } ?? r
                }
            }
            target.doc = target.doc.with { $0.layers = unlockAll(target.doc.layers) }
            try await replayPainting(into: target, scale: 1, maxStrokes: strokes)
            let dried = restoreVis(target.driedLayers(target.doc.layers))
            let full = renderXrayPixels(target.doc.canvas.width, target.doc.canvas.height, dried, target.doc.thick, strokes, totalStrokes)
            return scaleXray(full, maxSide)
        }
        let dried = driedLayers(currentLayers())
        let full = renderXrayPixels(doc.canvas.width, doc.canvas.height, dried, doc.thick, totalStrokes, totalStrokes)
        return scaleXray(full, maxSide)
    }

    private func scaleXray(_ full: XrayResult, _ maxSide: Int) -> XrayResult {
        let k = Swift.min(1, Double(maxSide) / Double(Swift.max(full.width, full.height)))
        if k >= 1 { return full }
        let w = Swift.max(1, Int(JS.round(Double(full.width) * k)))
        let h = Swift.max(1, Int(JS.round(Double(full.height) * k)))
        var out = full
        out.width = w
        out.height = h
        out.data = downsampleRgba(full.data, full.width, full.height, Double(w), Double(h))
        return out
    }

    func xrayNode(_ base: [PaintLayer]) -> ViewLayer {
        if let c = xrayNodeCache, c.version == version { return c.node }
        let x = renderXrayPixels(doc.canvas.width, doc.canvas.height, base, doc.thick, doc.strokes.count, doc.strokes.count)
        let node = ViewLayer(
            kind: .image(ImageNodeImage(width: x.width, height: x.height, data: x.data), version: Double(version)),
            id: XRAY_NODE_ID,
            name: "X-ray",
            visible: true,
            opacity: 1,
            blend: .mode(.normal)
        )
        xrayNodeCache = (version, node)
        return node
    }
}

func paintTimeMachineHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    var h: [String: PaintToolHandler] = [:]
    h["set_age"] = { a in
        let age = try c.setAge(a)
        return ["age": age.json, "active": .bool(isAgeActive(age))]
    }
    h["get_age"] = { _ in
        let age = c.getAge()
        return ["age": age.json, "active": .bool(isAgeActive(age)), "xrayView": .bool(c.getXrayView())]
    }
    h["bake_age"] = { a in
        let name: String?
        if let n = a["name"] {
            guard let s = n.stringValue else { throw PaintEditorError("name must be a string.") }
            name = s
        } else {
            name = nil
        }
        let r = try c.bakeAge(name: name)
        return ["layer": r.layer.json, "age": r.age.json, "bounds": rectJSON(r.bounds)]
    }
    h["set_xray_view"] = { a in
        guard let on = a["on"]?.boolValue else { throw PaintEditorError("on must be true or false.") }
        return ["xrayView": .bool(c.setXrayView(on))]
    }
    return h
}

func paintTimeMachineContentHandlers(_ c: PaintEditorController) -> [String: (JSONObject) async throws -> ToolOutput] {
    var h: [String: (JSONObject) async throws -> ToolOutput] = [:]
    h["render_xray"] = { a in
        var strokes: Int? = nil
        if let sVal = a["strokes"] {
            guard let n = sVal.finite, JS.floor(n) == n else {
                throw PaintEditorError("strokes \(sVal.numberValue.map(jsText) ?? "NaN") is out of range; the painting has \(c.doc.strokes.count) recorded strokes, so use 0..\(c.doc.strokes.count).")
            }
            strokes = Int(n)
        }
        var maxSide: Int? = nil
        if let mVal = a["maxSide"] {
            guard let n = mVal.finite, JS.floor(n) == n else {
                throw PaintEditorError("maxSide \(mVal.numberValue.map(jsText) ?? "NaN") is out of range; use a whole number 16..2048.")
            }
            maxSide = Int(n)
        }
        let x = try await c.renderXray(strokes: strokes, maxSide: maxSide)
        let bytes = encodePng(x.width, x.height, x.data)
        let info: JSONObject = [
            "width": .number(Double(x.width)),
            "height": .number(Double(x.height)),
            "strokes": .number(Double(x.strokes)),
            "totalStrokes": .number(Double(x.totalStrokes)),
            "layerCount": .number(Double(x.layerCount)),
            "hiddenLayerCount": .number(Double(x.hiddenLayerCount)),
            "maxDensity": .number(x.maxDensity),
            "meanDensity": .number(x.meanDensity),
        ]
        return .result(McpToolResult(content: [
            .image(data: bytesToBase64(bytes), mimeType: "image/png"),
            .text(JSONValue.object(info).stringified()),
        ]))
    }
    return h
}
