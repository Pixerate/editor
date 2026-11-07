import Foundation
import PixerateCore
import PixerateRaster

/**
 * Ferrofluid paint (`paint-editor/ferro.ts`): a per-layer liquid ferrofluid channel (`doc.ferro`,
 * one byte 0..255 per pixel in layer space, like `doc.light`) and document-space magnets
 * (`doc.magnets`).
 *
 * Where the analytical dipole magnetic field `|B|` exceeds the critical threshold `Bc` and
 * `ferro > 0`, the liquid rises into a hexagonal Rosensweig spike relief field whose spacing
 * follows the capillary wavelength, whose amplitude scales as `sqrt(1 - Bc / |B|) * ferro`, and
 * whose peaks tilt along `B`. Adding or moving a magnet runs deterministic advection steps on
 * `doc.ferro` so the liquid gathers toward the magnets.
 *
 * At render time, the spike height combines with `doc.thick` height and defaults to a dark,
 * glossy metallic material where `ferro > 0`, so `lightTile` shades the spikes with the canvas
 * lighting. `cure_ferrofluid` bakes the current spikes into `doc.thick` and clears `doc.ferro`.
 */

/// Ferrofluid settings of a brush (`PaintBrush.ferro`).
public struct FerroSettings: Equatable, Sendable {
    public var amount = 0.0
    public var wavelength = 16.0
    public var threshold = 0.12

    public init(amount: Double = 0.0, wavelength: Double = 16.0, threshold: Double = 0.12) {
        self.amount = amount
        self.wavelength = wavelength
        self.threshold = threshold
    }

    public var json: JSONValue {
        ["amount": .number(amount), "wavelength": .number(wavelength), "threshold": .number(threshold)]
    }
}

public let DEFAULT_FERRO = FerroSettings()

public func normalizeFerro(_ raw: JSONObject?, _ base: FerroSettings = DEFAULT_FERRO) -> FerroSettings {
    func num(_ v: JSONValue?, _ fb: Double) -> Double { v?.finite ?? fb }
    func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { Swift.min(hi, Swift.max(lo, v)) }
    let r = raw ?? [:]
    return FerroSettings(
        amount: clamp(num(r["amount"], base.amount), 0, 1),
        wavelength: clamp(num(r["wavelength"], base.wavelength), 4, 64),
        threshold: clamp(num(r["threshold"], base.threshold), 0, 1)
    )
}

/// A dipole magnet on the canvas (document pixel coordinates).
public struct PaintMagnet: Equatable, Sendable {
    public var id: String
    public var x: Double
    public var y: Double
    /// Dipole strength and polarity (-1 .. 1).
    public var strength: Double
    /// Characteristic dipole falloff radius in canvas pixels (8 .. 2000).
    public var radius: Double

    public init(id: String, x: Double, y: Double, strength: Double = DEFAULT_MAGNET_STRENGTH, radius: Double = DEFAULT_MAGNET_RADIUS) {
        self.id = id
        self.x = x
        self.y = y
        self.strength = strength
        self.radius = radius
    }

    public var json: JSONValue {
        ["id": .string(id), "x": .number(x), "y": .number(y), "strength": .number(strength), "radius": .number(radius)]
    }
}

public let DEFAULT_MAGNET_STRENGTH = 0.75
public let DEFAULT_MAGNET_RADIUS = 72.0

/// Dark carrier fluid sRGB colour (`#111827`) for advected ferrofluid outside existing pigment.
public let FERRO_CARRIER_RGB: (Int, Int, Int) = (17, 24, 39)
/// Default glossy metallic material for ferrofluid (`gloss ≈ 0.88`, `metallic ≈ 0.65`, `rim ≈ 0.25`).
public let FERRO_DEFAULT_GLOSS = 224
public let FERRO_DEFAULT_METALLIC = 166
public let FERRO_DEFAULT_RIM = 64

private let SQRT3_HALF = 0.8660254037844386

/// Validates and normalizes a magnet; throws a descriptive `PaintEditorError` when a field is out of range.
public func normalizeMagnet(
    id: String,
    x xIn: Double?,
    y yIn: Double?,
    strength strengthIn: Double? = nil,
    radius radiusIn: Double? = nil,
    base: PaintMagnet? = nil
) throws -> PaintMagnet {
    let x = xIn ?? base?.x ?? .nan
    let y = yIn ?? base?.y ?? .nan
    let strength = strengthIn ?? base?.strength ?? DEFAULT_MAGNET_STRENGTH
    let radius = radiusIn ?? base?.radius ?? DEFAULT_MAGNET_RADIUS
    if !x.isFinite {
        throw PaintEditorError("x \(jsText(x)) is not a finite coordinate; pass a number in canvas pixels.")
    }
    if !y.isFinite {
        throw PaintEditorError("y \(jsText(y)) is not a finite coordinate; pass a number in canvas pixels.")
    }
    if !strength.isFinite || strength < -1 || strength > 1 {
        throw PaintEditorError("strength \(jsText(strength)) is out of range; use -1..1.")
    }
    if !radius.isFinite || radius < 8 || radius > 2000 {
        throw PaintEditorError("radius \(jsText(radius)) is out of range; use 8..2000 px.")
    }
    return PaintMagnet(id: id, x: x, y: y, strength: strength, radius: radius)
}

public func emptyFerro() -> TiledSurface { emptySurface(1) }

private func fullTile(_ t: Tile, _ channels: Int) -> [UInt8] {
    if t.data.count == TILE * TILE * channels { return t.data }
    let u = t.uniform ?? 0
    if channels == 1 { return [UInt8](repeating: UInt8(u & 255), count: TILE * TILE) }
    var out = [UInt8](repeating: 0, count: TILE * TILE * 4)
    let b0 = UInt8((u >> 24) & 255), b1 = UInt8((u >> 16) & 255), b2 = UInt8((u >> 8) & 255), b3 = UInt8(u & 255)
    for i in stride(from: 0, to: out.count, by: 4) {
        out[i] = b0; out[i + 1] = b1; out[i + 2] = b2; out[i + 3] = b3
    }
    return out
}

/// The ferrofluid channel as grey paint for a stroke's twin: white, with alpha = ferro.
public func ferroToShadow(_ ferro: TiledSurface) -> TiledSurface {
    var tiles = OrderedMap<TileKey, Tile>()
    for (key, tile) in ferro.tiles {
        let f = fullTile(tile, 1)
        var d = [UInt8](repeating: 0, count: TILE * TILE * 4)
        var j = 0
        for i in 0..<f.count {
            if f[i] != 0 {
                d[j] = 255; d[j + 1] = 255; d[j + 2] = 255; d[j + 3] = f[i]
            }
            j += 4
        }
        if let t = finishTile(d, 4, 0) { tiles.set(key, t) }
    }
    return TiledSurface(channels: 4, tiles: tiles, defaultValue: 0)
}

/// A twin's grey paint back as ferrofluid: grey × alpha.
public func shadowToFerro(_ shadow: TiledSurface) -> TiledSurface {
    var tiles = OrderedMap<TileKey, Tile>()
    for (key, tile) in shadow.tiles {
        let s = fullTile(tile, 4)
        var d = [UInt8](repeating: 0, count: TILE * TILE)
        var j = 0
        for i in 0..<d.count {
            if s[j + 3] != 0 {
                let grey = (Double(s[j]) + Double(s[j + 1]) + Double(s[j + 2])) / 3
                d[i] = JS.u8c(JS.round((grey * Double(s[j + 3])) / 255))
            }
            j += 4
        }
        if let t = finishTile(d, 1, 0) { tiles.set(key, t) }
    }
    return TiledSurface(channels: 1, tiles: tiles, defaultValue: 0)
}

/// The brush a stroke's ferrofluid twin paints with: same geometry, normal blend, RGB mixing.
public func ferroTwinBrush(_ brush: PaintBrush) -> PaintBrush {
    var tip = brush.tip.json.objectValue!
    tip["blend"] = "normal"
    var behavior = brush.behavior.json.objectValue!
    behavior["mixing"] = "rgb"
    var raw: JSONObject = ["tip": .object(tip), "behavior": .object(behavior), "paint": .null]
    let full = brush.json()
    if brush.engine == "mixer", var m = full["mixer"]?.objectValue { m["mixing"] = "rgb"; raw["mixer"] = .object(m) }
    if brush.engine == "blender", var m = full["blender"]?.objectValue { m["mixing"] = "rgb"; raw["blender"] = .object(m) }
    if brush.engine == "smudge", var m = full["smudge"]?.objectValue { m["mixing"] = "rgb"; raw["smudge"] = .object(m) }
    return normalizePaintBrush(raw, brush)
}

/// Ferrofluid scaled by `k` (0..1), e.g. under a fill that covers it.
public func scaleFerro(_ ferro: TiledSurface, _ k: Double) -> TiledSurface {
    if k >= 1 { return ferro }
    var tiles = OrderedMap<TileKey, Tile>()
    if k > 0 {
        for (key, tile) in ferro.tiles {
            let d = fullTile(tile, 1).map { JS.u8c(JS.round(Double($0) * k)) }
            if let t = finishTile(d, 1, 0) { tiles.set(key, t) }
        }
    }
    return TiledSurface(channels: 1, tiles: tiles, defaultValue: 0)
}

/// Ferrofluid of an upper layer merged down onto the one below (both in lower layer's space).
public func mergeFerro(_ lower: TiledSurface?, _ upper: TiledSurface?, _ upperColor: TiledSurface) -> TiledSurface? {
    guard let upper, !upper.tiles.isEmpty else { return lower }
    var keys: [TileKey] = []
    for k in lower?.tiles.keys ?? [] { keys.append(k) }
    for k in upper.tiles.keys where !keys.contains(k) { keys.append(k) }
    var tiles = OrderedMap<TileKey, Tile>()
    for key in keys {
        let l = lower?.tiles.get(key).map { fullTile($0, 1) }
        let u = upper.tiles.get(key).map { fullTile($0, 1) }
        let c = upperColor.tiles.get(key).map { fullTile($0, 4) }
        var d = [UInt8](repeating: 0, count: TILE * TILE)
        for i in 0..<d.count {
            let uf = Double(u?[i] ?? 0)
            let ca = Double(c?[i * 4 + 3] ?? 0)
            let a = Swift.max(ca, uf) / 255
            d[i] = JS.u8c(Swift.min(255, JS.round(uf + Double(l?[i] ?? 0) * (1 - a))))
        }
        if let t = finishTile(d, 1, 0) { tiles.set(key, t) }
    }
    return TiledSurface(channels: 1, tiles: tiles, defaultValue: 0)
}

public struct FerroFieldSample: Equatable, Sendable {
    public var bx: Double
    public var by: Double
    public var bz: Double
    public var magnitude: Double
}

/// Analytical 3D magnetic dipole field `B = (bx, by, bz)` at canvas point `(x, y)` from a set of dipole magnets.
public func ferroFieldAt(_ x: Double, _ y: Double, _ magnets: [PaintMagnet]) -> FerroFieldSample {
    var bx = 0.0
    var by = 0.0
    var bz = 0.0
    for m in magnets {
        if m.strength == 0 { continue }
        let invR = 1.0 / Swift.max(8.0, m.radius)
        let u = (x - m.x) * invR
        let v = (y - m.y) * invR
        let r2 = u * u + v * v
        let s = 1.0 + r2
        let d = 1.0 / (s * s * JS.sqrt(s))
        bx += m.strength * 1.5 * u * d
        by += m.strength * 1.5 * v * d
        bz += m.strength * (1.0 - 0.5 * r2) * d
    }
    let magnitude = JS.hypot(bx, by, bz)
    return FerroFieldSample(bx: bx, by: by, bz: bz, magnitude: magnitude)
}

@inline(__always)
private func hexWave(_ px: Double, _ py: Double, _ k: Double) -> Double {
    let c0 = JS.cos(k * px)
    let c1 = JS.cos(k * (-0.5 * px + SQRT3_HALF * py))
    let c2 = JS.cos(k * (-0.5 * px - SQRT3_HALF * py))
    return (c0 + c1 + c2 + 1.5) / 4.5
}

/**
 * Hexagonal Rosensweig instability spike height (0..255) at canvas coordinate `(x, y)` for a pixel
 * with liquid ferrofluid byte `ferroByte` (0..255).
 */
public func ferroSpikeHeightAt(
    _ x: Double,
    _ y: Double,
    _ ferroByte: Int,
    _ magnets: [PaintMagnet],
    _ settings: FerroSettings = DEFAULT_FERRO
) -> Int {
    if ferroByte <= 0 || magnets.isEmpty { return 0 }
    let field = ferroFieldAt(x, y, magnets)
    let bc = Swift.max(0.01, settings.threshold)
    if field.magnitude <= bc { return 0 }
    let amp = JS.sqrt(1.0 - bc / field.magnitude) * (Double(ferroByte) / 255.0)
    let wl = Swift.max(4.0, settings.wavelength)
    let k = (2.0 * Double.pi) / wl
    let w0 = hexWave(x, y, k)
    let sz = field.bz < 0 ? -1.0 : 1.0
    let tx = (sz * field.bx) / field.magnitude
    let ty = (sz * field.by) / field.magnitude
    let shift = 0.32 * wl * amp * w0
    let w = Swift.max(0.0, hexWave(x - tx * shift, y - ty * shift, k))
    let profile = 0.15 + 0.85 * w * JS.sqrt(w)
    return Swift.min(255, Swift.max(1, Int(JS.round(255.0 * amp * profile))))
}

/**
 * Runs deterministic mass-gathering advection steps on a layer's `ferro` surface toward `magnets`.
 * Each step transports liquid ferrofluid along the dipole attraction field via bilinear splatting.
 */
public func advectFerro(
    _ ferro: TiledSurface,
    _ magnets: [PaintMagnet],
    _ offset: LayerOffset = LayerOffset(x: 0, y: 0),
    steps: Int = 4
) -> TiledSurface {
    if ferro.tiles.isEmpty || magnets.isEmpty || steps <= 0 { return ferro }
    guard let b = ferro.bounds else { return ferro }
    guard magnets.contains(where: { $0.strength != 0 }) else { return ferro }

    let pad = Swift.min(32, Swift.max(8, steps * 4))
    let rect = RasterRect(x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad)
    let w = rect.width
    let h = rect.height
    let raw = readRegion(ferro, rect)
    var cur = [Double](repeating: 0, count: w * h)
    for i in 0..<raw.count { cur[i] = Double(raw[i]) }

    var vx = [Double](repeating: 0, count: w * h)
    var vy = [Double](repeating: 0, count: w * h)
    for gy in 0..<h {
        let docY = Double(rect.y + gy + offset.y) + 0.5
        for gx in 0..<w {
            let docX = Double(rect.x + gx + offset.x) + 0.5
            var fx = 0.0
            var fy = 0.0
            for m in magnets {
                if m.strength == 0 { continue }
                let dx = m.x - docX
                let dy = m.y - docY
                let r = JS.hypot(dx, dy)
                if r <= 1e-6 { continue }
                let R = Swift.max(8.0, m.radius)
                let u = r / R
                let s = 1.0 + u * u
                let damp = Swift.min(1.0, r * 0.5)
                let pull = (Swift.abs(m.strength) * damp * 1.5) / (s * JS.sqrt(s))
                fx += (dx / r) * pull
                fy += (dy / r) * pull
            }
            let mag = JS.hypot(fx, fy)
            if mag > 2.5 {
                let scale = 2.5 / mag
                fx *= scale
                fy *= scale
            }
            let idx = gy * w + gx
            vx[idx] = fx
            vy[idx] = fy
        }
    }

    for _ in 0..<steps {
        var next = [Double](repeating: 0, count: w * h)
        for gy in 0..<h {
            for gx in 0..<w {
                let idx = gy * w + gx
                let val = cur[idx]
                if val <= 0 { continue }
                let nx = Swift.min(Double(w - 1), Swift.max(0.0, Double(gx) + vx[idx]))
                let ny = Swift.min(Double(h - 1), Swift.max(0.0, Double(gy) + vy[idx]))
                let x0 = Int(JS.floor(nx))
                let y0 = Int(JS.floor(ny))
                let x1 = Swift.min(w - 1, x0 + 1)
                let y1 = Swift.min(h - 1, y0 + 1)
                let tx = nx - Double(x0)
                let ty = ny - Double(y0)
                next[y0 * w + x0] += val * (1.0 - tx) * (1.0 - ty)
                next[y0 * w + x1] += val * tx * (1.0 - ty)
                next[y1 * w + x0] += val * (1.0 - tx) * ty
                next[y1 * w + x1] += val * tx * ty
            }
        }
        for i in 0..<next.count {
            cur[i] = Swift.min(255.0, next[i])
        }
    }

    var out = [UInt8](repeating: 0, count: w * h)
    for i in 0..<out.count {
        out[i] = JS.u8c(Swift.min(255.0, Swift.max(0.0, JS.round(cur[i]))))
    }
    return surfaceFromPixels(width: w, height: h, data: out, channels: 1, x: rect.x, y: rect.y)
}

public struct FerroStats {
    public var bounds: RasterRect?
    public var peak: Int
    public var liquidPixels: Int
    public var maxSpikeHeight: Int
    public var spikePixels: Int
    public var magnetCount: Int
}

/// Inspects a layer's liquid ferrofluid channel and active Rosensweig spike relief under `magnets`.
public func ferroInfo(
    _ ferro: TiledSurface?,
    _ magnets: [PaintMagnet] = [],
    _ settings: FerroSettings = DEFAULT_FERRO,
    _ offset: LayerOffset = LayerOffset(x: 0, y: 0)
) -> FerroStats {
    guard let ferro, !ferro.tiles.isEmpty else {
        return FerroStats(bounds: nil, peak: 0, liquidPixels: 0, maxSpikeHeight: 0, spikePixels: 0, magnetCount: magnets.count)
    }
    var peak = 0
    var liquidPixels = 0
    var maxSpikeHeight = 0
    var spikePixels = 0
    for (key, tile) in ferro.tiles {
        let tx = (key % 65536) - 32768
        let ty = key / 65536 - 32768
        let d = fullTile(tile, 1)
        var i = 0
        for y in 0..<TILE {
            let docY = Double(ty * TILE + y + offset.y) + 0.5
            for x in 0..<TILE {
                let fb = Int(d[i])
                i += 1
                if fb == 0 { continue }
                liquidPixels += 1
                if fb > peak { peak = fb }
                if !magnets.isEmpty {
                    let docX = Double(tx * TILE + x + offset.x) + 0.5
                    let hs = ferroSpikeHeightAt(docX, docY, fb, magnets, settings)
                    if hs > 0 {
                        spikePixels += 1
                        if hs > maxSpikeHeight { maxSpikeHeight = hs }
                    }
                }
            }
        }
    }
    return FerroStats(
        bounds: peak > 0 ? ferro.bounds : nil,
        peak: peak,
        liquidPixels: liquidPixels,
        maxSpikeHeight: maxSpikeHeight,
        spikePixels: spikePixels,
        magnetCount: magnets.count
    )
}

public struct FerroLayerInput {
    public var surface: TiledSurface
    public var magnets: [PaintMagnet]
    public var settings: FerroSettings
    public var offset: LayerOffset

    public init(surface: TiledSurface, magnets: [PaintMagnet], settings: FerroSettings, offset: LayerOffset) {
        self.surface = surface
        self.magnets = magnets
        self.settings = settings
        self.offset = offset
    }
}

public func ferroCacheKey(_ ferro: FerroLayerInput?) -> String {
    guard let ferro, !ferro.surface.tiles.isEmpty else { return "" }
    let mKey = ferro.magnets
        .map { String(format: "%@:%.2f,%.2f,%.3f,%.1f", $0.id, $0.x, $0.y, $0.strength, $0.radius) }
        .joined(separator: ";")
    let s = ferro.settings
    return String(format: "%d,%d|%.2f,%.3f|%@", ferro.offset.x, ferro.offset.y, s.wavelength, s.threshold, mKey)
}

/// Bakes a layer's liquid ferrofluid and active Rosensweig spikes into permanent `ThickChannels` for `cure_ferrofluid`.
public func bakeFerroIntoThick(
    _ color: TiledSurface,
    _ ferro: TiledSurface,
    _ thick: ThickChannels?,
    _ magnets: [PaintMagnet],
    _ settings: FerroSettings = DEFAULT_FERRO,
    _ offset: LayerOffset = LayerOffset(x: 0, y: 0)
) -> (color: TiledSurface, thick: ThickChannels, maxSpikeHeight: Int, spikePixels: Int, curedPixels: Int) {
    let baseThick = thick ?? emptyThickChannels()
    if ferro.tiles.isEmpty {
        return (color, baseThick, 0, 0, 0)
    }
    var colorTiles = color.tiles
    var heightTiles = baseThick.height.tiles
    var materialTiles = baseThick.material.tiles
    var maxSpikeHeight = 0
    var spikePixels = 0
    var curedPixels = 0

    for (key, fTile) in ferro.tiles {
        let tx = (key % 65536) - 32768
        let ty = key / 65536 - 32768
        let fd = fullTile(fTile, 1)
        var cd = colorTiles.get(key).map { fullTile($0, 4) } ?? [UInt8](repeating: 0, count: TILE * TILE * 4)
        var hd = heightTiles.get(key).map { fullTile($0, 1) } ?? [UInt8](repeating: 0, count: TILE * TILE)
        var md = materialTiles.get(key).map { fullTile($0, 4) } ?? [UInt8](repeating: 0, count: TILE * TILE * 4)

        var changedColor = false
        var changedHeight = false
        var changedMaterial = false

        var p = 0
        for y in 0..<TILE {
            let docY = Double(ty * TILE + y + offset.y) + 0.5
            for x in 0..<TILE {
                let fb = Int(fd[p])
                if fb == 0 {
                    p += 1
                    continue
                }
                curedPixels += 1
                let i = p * 4
                if Int(cd[i + 3]) < fb {
                    let a0 = Double(cd[i + 3]) / Double(fb)
                    cd[i] = JS.u8c(JS.round(Double(cd[i]) * a0 + Double(FERRO_CARRIER_RGB.0) * (1.0 - a0)))
                    cd[i + 1] = JS.u8c(JS.round(Double(cd[i + 1]) * a0 + Double(FERRO_CARRIER_RGB.1) * (1.0 - a0)))
                    cd[i + 2] = JS.u8c(JS.round(Double(cd[i + 2]) * a0 + Double(FERRO_CARRIER_RGB.2) * (1.0 - a0)))
                    cd[i + 3] = UInt8(fb)
                    changedColor = true
                }
                let docX = Double(tx * TILE + x + offset.x) + 0.5
                let hs = !magnets.isEmpty ? ferroSpikeHeightAt(docX, docY, fb, magnets, settings) : 0
                if hs > 0 {
                    spikePixels += 1
                    if hs > maxSpikeHeight { maxSpikeHeight = hs }
                }
                let bead = Swift.max(hs, Int(JS.round((Double(fb) * 28.0) / 255.0)))
                let nh = UInt8(Swift.min(255, Int(hd[p]) + bead))
                if nh != hd[p] {
                    hd[p] = nh
                    changedHeight = true
                }
                let w = Double(fb) / 255.0
                let ng = UInt8(Swift.max(Int(md[i]), Int(JS.round(Double(FERRO_DEFAULT_GLOSS) * w))))
                let nm = UInt8(Swift.max(Int(md[i + 1]), Int(JS.round(Double(FERRO_DEFAULT_METALLIC) * w))))
                let nr = UInt8(Swift.max(Int(md[i + 2]), Int(JS.round(Double(FERRO_DEFAULT_RIM) * w))))
                let na: UInt8 = md[i + 3] != 0 ? md[i + 3] : 255
                if ng != md[i] || nm != md[i + 1] || nr != md[i + 2] || na != md[i + 3] {
                    md[i] = ng
                    md[i + 1] = nm
                    md[i + 2] = nr
                    md[i + 3] = na
                    changedMaterial = true
                }
                p += 1
            }
        }

        if changedColor, let ct = finishTile(cd, 4, 0) { colorTiles.set(key, ct) }
        if changedHeight, let ht = finishTile(hd, 1, 0) { heightTiles.set(key, ht) }
        if changedMaterial, let mt = finishTile(md, 4, 0) { materialTiles.set(key, mt) }
    }

    return (
        color: TiledSurface(channels: 4, tiles: colorTiles, defaultValue: color.defaultValue),
        thick: ThickChannels(
            height: TiledSurface(channels: 1, tiles: heightTiles, defaultValue: 0),
            material: TiledSurface(channels: 4, tiles: materialTiles, defaultValue: 0)
        ),
        maxSpikeHeight: maxSpikeHeight,
        spikePixels: spikePixels,
        curedPixels: curedPixels
    )
}

func ferroToJSON(_ ferro: TiledSurface, _ settings: FerroSettings? = nil) -> JSONValue? {
    guard let b = ferroInfo(ferro).bounds else { return nil }
    var out: JSONObject = ["rect": b.json, "ferro": .string(pngDataUrl(b.width, b.height, readRegion(ferro, b), 1))]
    if let settings {
        if settings.wavelength != DEFAULT_FERRO.wavelength { out["wavelength"] = .number(settings.wavelength) }
        if settings.threshold != DEFAULT_FERRO.threshold { out["threshold"] = .number(settings.threshold) }
    }
    return .object(out)
}

func ferroFromJSON(_ raw: JSONValue) throws -> (surface: TiledSurface, settings: FerroSettings) {
    guard let r = raw.objectValue, let rect = r["rect"]?.objectValue, let url = r["ferro"]?.stringValue,
          let x = rect["x"]?.numberValue, let y = rect["y"]?.numberValue
    else { throw PaintEditorError("not a saved ferrofluid channel") }
    guard let parsed = parseDataUrl(url) else { throw PaintEditorError("the ferrofluid channel is not a PNG data URL") }
    let img = try decodePng(parsed.bytes, keepGray: true)
    let data = img.channels == 1 ? img.data : (0..<(img.width * img.height)).map { img.data[$0 * 4] }
    let surface = surfaceFromPixels(width: img.width, height: img.height, data: data, channels: 1, x: Int(x), y: Int(y))
    var sRaw = JSONObject()
    sRaw["amount"] = .number(0)
    if let w = r["wavelength"] { sRaw["wavelength"] = w }
    if let t = r["threshold"] { sRaw["threshold"] = t }
    return (surface, normalizeFerro(sRaw))
}

func magnetsFromJSON(_ raw: JSONValue?) -> [PaintMagnet] {
    guard let arr = raw?.arrayValue else { return [] }
    var out: [PaintMagnet] = []
    for item in arr {
        guard let o = item.objectValue, let id = o["id"]?.stringValue, !id.isEmpty,
              let x = o["x"]?.numberValue, let y = o["y"]?.numberValue else { continue }
        if let m = try? normalizeMagnet(id: id, x: x, y: y, strength: o["strength"]?.numberValue, radius: o["radius"]?.numberValue) {
            out.append(m)
        }
    }
    return out
}

extension PaintDocumentState {
    func settingFerro(_ layerId: String, _ next: TiledSurface?, settings: FerroSettings? = nil) {
        guard let next else { return }
        var f = ferro ?? OrderedMap()
        if !next.tiles.isEmpty {
            f.set(layerId, next)
            if let settings {
                var fs = ferroSettings ?? OrderedMap()
                fs.set(layerId, FerroSettings(amount: settings.amount, wavelength: settings.wavelength, threshold: settings.threshold))
                ferroSettings = fs
            }
        } else {
            _ = f.delete(layerId)
            if var fs = ferroSettings {
                _ = fs.delete(layerId)
                ferroSettings = fs.isEmpty ? nil : fs
            }
        }
        ferro = f.isEmpty ? nil : f
    }

    func removingFerro(_ ids: [String]) {
        if var f = ferro, ids.contains(where: { f.has($0) }) {
            for id in ids { _ = f.delete(id) }
            ferro = f.isEmpty ? nil : f
        }
        if var fs = ferroSettings, ids.contains(where: { fs.has($0) }) {
            for id in ids { _ = fs.delete(id) }
            ferroSettings = fs.isEmpty ? nil : fs
        }
    }
}

// MARK: - Controller Ferrofluid & Magnets

extension PaintEditorController {
    func advectDocumentFerro(_ d: PaintDocumentState, _ magnets: [PaintMagnet], steps: Int = 4) -> OrderedMap<String, TiledSurface>? {
        guard let f = d.ferro else { return nil }
        if magnets.isEmpty { return f }
        var out = OrderedMap<String, TiledSurface>()
        for (id, surf) in f {
            if let l = findLayer(d.layers, id)?.layer, l.isPixel, !surf.tiles.isEmpty {
                let next = advectFerro(surf, magnets, l.pixelOffset, steps: steps)
                if !next.tiles.isEmpty { out.set(id, next) }
            } else if !surf.tiles.isEmpty {
                out.set(id, surf)
            }
        }
        return out.isEmpty ? nil : out
    }

    /// Lists the magnets on the canvas.
    public func listMagnets() -> [PaintMagnet] {
        doc.magnets ?? []
    }

    /// Places a dipole magnet on the canvas and advects liquid ferrofluid toward it (one undo step).
    public func addMagnet(x: Double, y: Double, strength: Double? = nil, radius: Double? = nil) throws -> PaintMagnet {
        if liveStroke != nil { throw PaintEditorError("A stroke is in progress; end or cancel it before adding a magnet.") }
        let existing = doc.magnets ?? []
        let usedIds = Set(existing.map(\.id))
        while usedIds.contains("mag\(nextMagnetId)") { nextMagnetId += 1 }
        let id = "mag\(nextMagnetId)"
        nextMagnetId += 1
        let magnet = try normalizeMagnet(id: id, x: x, y: y, strength: strength, radius: radius)
        let magnets = existing + [magnet]
        let ferro = advectDocumentFerro(doc, magnets, steps: 4)
        let nextDoc = withPaintEvent(doc.with { d in
            d.magnets = magnets
            if d.ferro != nil { d.ferro = ferro }
        }, kind: "magnets", layerId: "", data: ["magnets": .array(magnets.map(\.json)), "advect": true])
        commit("Add magnet", nextDoc)
        return magnet
    }

    /// Moves or retunes a magnet and advects liquid ferrofluid toward the magnets (one undo step).
    public func updateMagnet(_ id: String, x: Double? = nil, y: Double? = nil, strength: Double? = nil, radius: Double? = nil) throws -> PaintMagnet {
        if liveStroke != nil { throw PaintEditorError("A stroke is in progress; end or cancel it before updating a magnet.") }
        if x == nil && y == nil && strength == nil && radius == nil {
            throw PaintEditorError("Pass at least one change: x, y, strength or radius.")
        }
        let existing = doc.magnets ?? []
        guard let idx = existing.firstIndex(where: { $0.id == id }) else {
            throw PaintEditorError("Unknown magnet \"\(id)\". Call list_magnets for the ids.")
        }
        let current = existing[idx]
        let magnet = try normalizeMagnet(
            id: id,
            x: x ?? current.x,
            y: y ?? current.y,
            strength: strength ?? current.strength,
            radius: radius ?? current.radius,
            base: current
        )
        let magnets = existing.enumerated().map { $0.offset == idx ? magnet : $0.element }
        let ferro = advectDocumentFerro(doc, magnets, steps: 4)
        let nextDoc = withPaintEvent(doc.with { d in
            d.magnets = magnets
            if d.ferro != nil { d.ferro = ferro }
        }, kind: "magnets", layerId: "", data: ["magnets": .array(magnets.map(\.json)), "advect": true])
        commit("Update magnet", nextDoc)
        return magnet
    }

    /// Removes magnets by id, or all magnets when `ids` is omitted or empty (one undo step). Returns the removed ids.
    public func removeMagnets(_ ids: [String]? = nil) throws -> [String] {
        if liveStroke != nil { throw PaintEditorError("A stroke is in progress; end or cancel it before removing magnets.") }
        let existing = doc.magnets ?? []
        if let ids, !ids.isEmpty {
            for id in ids where !existing.contains(where: { $0.id == id }) {
                throw PaintEditorError("Unknown magnet \"\(id)\". Call list_magnets for the ids.")
            }
        }
        let removed = (ids?.isEmpty == false) ? ids! : existing.map(\.id)
        if removed.isEmpty { return [] }
        let next = existing.filter { !removed.contains($0.id) }
        let nextDoc = withPaintEvent(doc.with { d in
            d.magnets = next.isEmpty ? nil : next
        }, kind: "magnets", layerId: "", data: ["magnets": .array(next.map(\.json)), "advect": false])
        commit("Remove magnets", nextDoc)
        return removed
    }

    /// Replaces the canvas magnets (used by replay).
    func replaceMagnets(_ magnets: [PaintMagnet], advect: Bool = false) throws {
        let next = try magnets.map { try normalizeMagnet(id: $0.id, x: $0.x, y: $0.y, strength: $0.strength, radius: $0.radius) }
        let ferro = advect ? advectDocumentFerro(doc, next, steps: 4) : doc.ferro
        commit("Magnets", doc.with { d in
            d.magnets = next.isEmpty ? nil : next
            if d.ferro != nil { d.ferro = ferro }
        })
    }

    /// Reads a layer's liquid ferrofluid coverage and active Rosensweig spike relief under the canvas magnets.
    public func getFerrofluid(_ layerId: String? = nil) throws -> JSONObject {
        let l = try wetLayer(layerId, "read the ferrofluid of")
        let settings = doc.ferroSettings?.get(l.id) ?? DEFAULT_FERRO
        let magnets = doc.magnets ?? []
        let info = ferroInfo(doc.ferro?.get(l.id), magnets, settings, l.pixelOffset)
        let bounds = info.bounds.map { RasterRect(x: $0.x + l.pixelOffset.x, y: $0.y + l.pixelOffset.y, width: $0.width, height: $0.height) }
        return [
            "layerId": .string(l.id),
            "ferro": .bool(info.peak > 0),
            "bounds": rectJSON(bounds),
            "peak": .number(Double(info.peak)),
            "coverage": .number(Double(info.liquidPixels)),
            "activeSpikeArea": .number(Double(info.spikePixels)),
            "maxSpikeHeight": .number(Double(info.maxSpikeHeight)),
            "magnetCount": .number(Double(info.magnetCount)),
            "wavelength": .number(settings.wavelength),
            "threshold": .number(settings.threshold),
        ]
    }

    /// Cures a layer's liquid ferrofluid: bakes the current Rosensweig spikes and glossy metallic material into `doc.thick` and clears `doc.ferro` (one undo step).
    public func cureFerrofluid(_ layerId: String? = nil) throws -> JSONObject {
        if liveStroke != nil { throw PaintEditorError("A stroke is in progress; end or cancel it before curing ferrofluid.") }
        let l = try paintTarget(layerId, "cure the ferrofluid of")
        guard let fSurf = doc.ferro?.get(l.id), !fSurf.tiles.isEmpty else {
            return [
                "layerId": .string(l.id),
                "cured": false,
                "bounds": .null,
                "maxSpikeHeight": 0,
                "activeSpikeArea": 0,
            ]
        }
        let settings = doc.ferroSettings?.get(l.id) ?? DEFAULT_FERRO
        let magnets = doc.magnets ?? []
        let fb = ferroInfo(fSurf, magnets, settings, l.pixelOffset).bounds
        let bounds = fb.map { RasterRect(x: $0.x + l.pixelOffset.x, y: $0.y + l.pixelOffset.y, width: $0.width, height: $0.height) }
        let baked = bakeFerroIntoThick(l.pixelSurface, fSurf, doc.thick?.get(l.id), magnets, settings, l.pixelOffset)
        let nextDoc = withPaintEvent(doc.with { d in
            d.layers = mapLayer(doc.layers, l.id) { $0.withSurface(baked.color) }
            var thick = d.thick ?? OrderedMap()
            thick.set(l.id, baked.thick)
            d.thick = thick
            d.removingFerro([l.id])
        }, kind: "cure-ferrofluid", layerId: l.id)
        commit("Cure ferrofluid", nextDoc)
        return [
            "layerId": .string(l.id),
            "cured": true,
            "bounds": rectJSON(bounds),
            "maxSpikeHeight": .number(Double(baked.maxSpikeHeight)),
            "activeSpikeArea": .number(Double(baked.spikePixels)),
        ]
    }

    /// Ferrofluid channels and magnets as saved (`ferro`, `magnets`).
    func ferroJSON() -> JSONObject {
        var out = JSONObject()
        if let ferro = doc.ferro {
            var ext = JSONObject()
            for (id, f) in ferro where findLayer(doc.layers, id) != nil {
                if let saved = ferroToJSON(f, doc.ferroSettings?.get(id)) { ext[id] = saved }
            }
            if !ext.isEmpty { out["ferro"] = .object(ext) }
        }
        if let magnets = doc.magnets, !magnets.isEmpty {
            out["magnets"] = .array(magnets.map(\.json))
        }
        return out
    }
}

/// The handlers of the ferrofluid and magnet tools (`ferro-tools.ts`).
func paintFerroHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    var h: [String: PaintToolHandler] = [:]
    h["add_magnet"] = { a in
        let x = try AddMagnetArguments(a)
        return try c.addMagnet(x: x.x, y: x.y, strength: x.strength, radius: x.radius).json
    }
    h["update_magnet"] = { a in
        let x = try UpdateMagnetArguments(a)
        return try c.updateMagnet(x.id, x: x.x, y: x.y, strength: x.strength, radius: x.radius).json
    }
    h["remove_magnets"] = { a in
        let x = try RemoveMagnetsArguments(a)
        return ["removed": .array(try c.removeMagnets(x.ids).map { .string($0) })]
    }
    h["list_magnets"] = { _ in
        ["magnets": .array(c.listMagnets().map(\.json))]
    }
    h["get_ferrofluid"] = { a in
        let x = try GetFerrofluidArguments(a)
        return .object(try c.getFerrofluid(x.layerId))
    }
    h["cure_ferrofluid"] = { a in
        let x = try CureFerrofluidArguments(a)
        return .object(try c.cureFerrofluid(x.layerId))
    }
    return h
}
