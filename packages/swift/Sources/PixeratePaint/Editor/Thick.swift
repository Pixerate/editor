import Foundation
import PixerateCore
import PixerateRaster

/**
 * Thick paint (impasto, `paint-editor/thick.ts`): a pixel layer can carry a **height** map (0..255)
 * and a **material** map (R gloss, G metallic, B rim, A opacity for clarity), lit at render time
 * from `PaintLighting`: a normal from the height's slope, diffuse light and a Blinn-Phong
 * highlight, tinted by the paint where it is metallic. The layer's own pixels stay the paint's
 * colour, so relighting never repaints anything.
 *
 * Impasto strokes (`ThickStrokeDriver`) lay colour through the shared pick-up / mix exchange and
 * raise the height: `brush` with bristle ridges, `tube` in domed blobs, `knife` scraping the relief
 * flat while it smears the paint, `roller` as a stippled band, `gloop` as a glossy round bead.
 */

/// A layer's thick-paint channels (layer space, like its pixels).
public struct ThickChannels {
    /// Height 0..255 per pixel (1 channel).
    public var height: TiledSurface
    /// Material per pixel (4 channels): R gloss, G metallic, B rim, A opacity (255 solid; 0 no material).
    public var material: TiledSurface
    /// Thin-film iridescence per pixel (4 channels): R thickness (100..1000 nm), G IOR (1.2..2.0), B unused, A film amount.
    public var film: TiledSurface

    public init(height: TiledSurface, material: TiledSurface, film: TiledSurface = emptySurface(4, 0)) {
        self.height = height
        self.material = material
        self.film = film
    }
}

public func emptyThickChannels() -> ThickChannels {
    ThickChannels(height: emptySurface(1, 0), material: emptySurface(4, 0), film: emptySurface(4, 0))
}

/// Whether a layer's thick channels carry any relief or thin-film coat.
public func hasThickChannels(_ ch: ThickChannels?) -> Bool {
    guard let ch else { return false }
    return !ch.height.tiles.isEmpty || !ch.film.tiles.isEmpty
}

/// Viewer tilt for thin-film iridescence and specular highlights (`-1..1` on each axis; `{ 0, 0 }` is straight-on).
public struct PaintViewTilt: Equatable, Sendable {
    public var x: Double = 0
    public var y: Double = 0

    public init(x: Double = 0, y: Double = 0) {
        self.x = x
        self.y = y
    }

    public var json: JSONValue { ["x": .number(x), "y": .number(y)] }
}

public let DEFAULT_VIEW_TILT = PaintViewTilt()

/// View tilt with both axes clamped into `-1..1`; missing fields come from `base`.
public func normalizeViewTilt(x: Double?, y: Double?, _ base: PaintViewTilt = DEFAULT_VIEW_TILT) -> PaintViewTilt {
    func num(_ v: Double?, _ d: Double) -> Double { v.flatMap { $0.isFinite ? $0 : nil } ?? d }
    return PaintViewTilt(
        x: Swift.min(1, Swift.max(-1, num(x, base.x))),
        y: Swift.min(1, Swift.max(-1, num(y, base.y)))
    )
}

public let DEFAULT_LIGHTING = PaintLighting()

/// Lighting with every field in range; missing fields from `base`.
public func normalizeLighting(azimuth: Double?, elevation: Double?, relief: Double?, _ base: PaintLighting = DEFAULT_LIGHTING) -> PaintLighting {
    func num(_ v: Double?, _ d: Double) -> Double { v.flatMap { $0.isFinite ? $0 : nil } ?? d }
    var l = PaintLighting()
    l.azimuth = (num(azimuth, base.azimuth).truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
    l.elevation = Swift.min(90, Swift.max(5, num(elevation, base.elevation)))
    l.relief = Swift.min(1, Swift.max(0, num(relief, base.relief)))
    return l
}

/// Height in pixels of the full 0..255 range, for the slopes.
private let RELIEF_PX = 7.0
private let AMBIENT = 0.38

/// Light vector (towards the light) for a lighting.
private func lightVector(_ l: PaintLighting) -> (Double, Double, Double) {
    let az = (l.azimuth * Double.pi) / 180
    let el = (l.elevation * Double.pi) / 180
    return (JS.cos(el) * JS.sin(az), -JS.cos(el) * JS.cos(az), JS.sin(el))
}

/// Unit view vector (towards the viewer) from `viewTilt`.
private func viewVector(_ v: PaintViewTilt) -> (Double, Double, Double) {
    let vx = v.x * 1.25
    let vy = v.y * 1.25
    let vz = 1.0
    let len = JS.hypot(vx, vy, vz)
    return (vx / len, vy / len, vz / len)
}

/// Representative R, G, B wavelengths in nanometres for two-beam thin-film interference.
private let FILM_WAVELENGTHS = (630.0, 532.0, 465.0)

/**
 * Two-beam thin-film interference reflectance (`0..1` linear RGB) for an optical path difference
 * `opd = 2 · n · d · cos(θ_t)` in nanometres, with a half-wave phase flip at the air–film boundary:
 * `R(λ) = 0.5 - 0.5 · cos(2π · opd / λ)`.
 */
public func thinFilmRgb(_ opd: Double) -> (Double, Double, Double) {
    let twoPi = 2 * Double.pi * opd
    return (
        0.5 - 0.5 * JS.cos(twoPi / FILM_WAVELENGTHS.0),
        0.5 - 0.5 * JS.cos(twoPi / FILM_WAVELENGTHS.1),
        0.5 - 0.5 * JS.cos(twoPi / FILM_WAVELENGTHS.2)
    )
}

/**
 * One tile of a thick layer lit (`lightTile`): `color` (RGBA, straight), the height, material and
 * thin-film channels of the tile, and the height of its neighbours for the slopes at the border.
 * Returns a new RGBA tile.
 */
func lightTile(_ color: [UInt8], _ height: [UInt8]?, _ heightAround: (Int, Int) -> [UInt8]?, _ material: [UInt8]?, _ light: PaintLighting, _ film: [UInt8]? = nil, _ viewTilt: PaintViewTilt = DEFAULT_VIEW_TILT) -> [UInt8] {
    var out = color
    let hasHeight = height != nil && light.relief > 0
    if !hasHeight && film == nil { return out }
    let (lx, ly, lz) = lightVector(light)
    let (vx, vy, vz) = viewVector(viewTilt)
    let hl = JS.hypot(lx + vx, ly + vy, lz + vz)
    let hx = hl > 1e-9 ? (lx + vx) / hl : 0
    let hy = hl > 1e-9 ? (ly + vy) / hl : 0
    let hz = hl > 1e-9 ? (lz + vz) / hl : 1
    let k = (RELIEF_PX / 255) * light.relief * 2
    let flatDiffuse = AMBIENT + (1 - AMBIENT) * lz
    var around: [Int: [UInt8]?] = [:]
    func read(_ x: Int, _ y: Int) -> Double {
        guard let height else { return 0 }
        if x >= 0 && y >= 0 && x < TILE && y < TILE { return Double(height[y * TILE + x]) }
        let dx = x < 0 ? -1 : x >= TILE ? 1 : 0
        let dy = y < 0 ? -1 : y >= TILE ? 1 : 0
        let key = (dy + 1) * 3 + dx + 1
        if around[key] == nil { around[key] = .some(heightAround(dx, dy)) }
        guard let t = around[key]! else { return 0 }
        return Double(t[(y - dy * TILE) * TILE + (x - dx * TILE)])
    }
    for y in 0..<TILE {
        for x in 0..<TILE {
            let p = y * TILE + x
            let i = p * 4
            if color[i + 3] == 0 { continue }
            let fa = film.map { Double($0[i + 3]) / 255 } ?? 0
            let h: UInt8 = hasHeight ? height![p] : 0
            let gx = hasHeight ? (read(x + 1, y) - read(x - 1, y)) * 0.5 : 0
            let gy = hasHeight ? (read(x, y + 1) - read(x, y - 1)) * 0.5 : 0
            let hasSlope = hasHeight && (h != 0 || gx != 0 || gy != 0)
            if !hasSlope && fa <= 0 { continue }
            var nx = 0.0, ny = 0.0, nz = 1.0
            if hasSlope {
                nx = -gx * k
                ny = -gy * k
                let nl = JS.hypot(nx, ny, 1)
                nx /= nl
                ny /= nl
                nz = 1 / nl
            }
            var filmRgb: (Double, Double, Double)? = nil
            if fa > 0, let film {
                let d = 100 + (Double(film[i]) / 255) * 900
                let ior = 1.2 + (Double(film[i + 1]) / 255) * 0.8
                let nh = Swift.max(0, nx * hx + ny * hy + nz * hz)
                let nv = Swift.max(0, nx * vx + ny * vy + nz * vz)
                let cosThetaI = Swift.max(0, Swift.min(1, nh * nv))
                let sin2ThetaT = (1 - cosThetaI * cosThetaI) / (ior * ior)
                let cosThetaT = Swift.max(0, 1 - sin2ThetaT).squareRoot()
                let opd = 2 * ior * d * cosThetaT
                filmRgb = thinFilmRgb(opd)
            }
            let gloss = material.map { Double($0[i]) / 255 } ?? 0.3
            let metal = material.map { Double($0[i + 1]) / 255 } ?? 0
            var shade = 1.0
            var spec = 0.0
            if hasSlope {
                let diffuse = Swift.max(0, nx * lx + ny * ly + nz * lz)
                shade = (AMBIENT + (1 - AMBIENT) * diffuse) / flatDiffuse
                let shininess = 6 + 90 * gloss
                let nh = Swift.max(0, nx * hx + ny * hy + nz * hz)
                // Only slopes catch a highlight: subtract what a flat surface would show.
                spec = Swift.max(0, JS.pow(nh, shininess) - JS.pow(hz, shininess)) * (0.25 + 0.75 * gloss) * light.relief
            }
            let fArr: [Double]? = filmRgb.map { [$0.0, $0.1, $0.2] }
            for c in 0..<3 {
                let a = SRGB_TO_LINEAR[Int(color[i + c])]
                let fc = fArr?[c] ?? a
                if hasSlope {
                    let tint = metal * a + (1 - metal)
                    let diff = fa > 0 ? a * (1 - fa * 0.75) + fc * fa * (0.45 + 0.55 * a) : a
                    let specTint = fa > 0 ? tint * (1 - fa) + fc * fa : tint
                    let v = diff * shade * (1 - 0.35 * metal) + spec * specTint * (1 + metal)
                    out[i + c] = UInt8(linearToSrgb8(v))
                } else {
                    let v = a * (1 - fa * 0.75) + fc * fa * (0.45 + 0.55 * a)
                    out[i + c] = UInt8(linearToSrgb8(v))
                }
            }
        }
    }
    return out
}

private func expandTile(_ t: Tile, _ channels: Int) -> [UInt8] {
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

/// Cache of lit tiles for one layer, by the identity of their inputs (`LitCache`).
final class LitCache {
    private var tiles: [TileKey: (inputs: [ObjectIdentifier?], light: PaintLighting, viewTilt: PaintViewTilt, ferroKey: String, tile: Tile)] = [:]

    /// The layer's pixels lit (tiles without relief, thin film or ferrofluid nearby are the colour tiles themselves).
    /// Without ferrofluid this is the thick-paint / thin-film pass; with it, `litFerro` (see `thick.ts`).
    func lit(_ color: TiledSurface, _ ch: ThickChannels, _ light: PaintLighting, _ viewTilt: PaintViewTilt = DEFAULT_VIEW_TILT, _ ferro: FerroLayerInput? = nil, _ age: PaintAgeSettings? = nil, _ layerCount: Int = 1, _ offset: LayerOffset = LayerOffset(x: 0, y: 0)) -> TiledSurface {
        if let ferro, !ferro.surface.tiles.isEmpty { return litFerro(color, ch, light, viewTilt, ferro) }
        let hasCracks = age != nil && isAgeActive(age!) && age!.cracks > 0 && light.relief > 0
        let hasHeight = (!ch.height.tiles.isEmpty || hasCracks) && light.relief > 0
        let hasFilm = !ch.film.tiles.isEmpty
        if !hasHeight && !hasFilm { return color }
        let ck = hasCracks ? "\(ageKey(age!))|\(layerCount)|\(offset.x),\(offset.y)" : ""
        var out = color.tiles
        var keys = Set<TileKey>()
        for (key, tile) in color.tiles {
            keys.insert(key)
            let (tx, ty) = tileCoord(key)
            func around(_ dx: Int, _ dy: Int) -> Tile? { hasHeight ? ch.height.tiles.get(tileKey(tx + dx, ty + dy)) : nil }
            let f = ch.film.tiles.get(key)
            var any = f != nil || hasCracks
            if hasHeight && !any {
                for dy in -1...1 where !any { for dx in -1...1 where !any { if around(dx, dy) != nil { any = true } } }
            }
            if !any { continue }
            let m = hasHeight ? ch.material.tiles.get(key) : nil
            var inputs: [ObjectIdentifier?] = [ObjectIdentifier(tile), m.map(ObjectIdentifier.init), f.map(ObjectIdentifier.init)]
            for dy in -1...1 {
                for dx in -1...1 {
                    inputs.append(around(dx, dy).map(ObjectIdentifier.init))
                    if hasCracks { inputs.append(color.tiles.get(tileKey(tx + dx, ty + dy)).map(ObjectIdentifier.init)) }
                }
            }
            if let cached = tiles[key], cached.inputs == inputs, cached.light == light, cached.viewTilt == viewTilt, cached.ferroKey == ck {
                out.set(key, cached.tile)
                continue
            }
            let cd = expandTile(tile, 4)
            func heightTileAt(_ ntx: Int, _ nty: Int) -> [UInt8]? {
                let nk = tileKey(ntx, nty)
                let ht = ch.height.tiles.get(nk)
                let baseH = ht.map { expandTile($0, 1) }
                if !hasCracks { return baseH }
                let ct: [UInt8]? = ntx == tx && nty == ty ? cd : color.tiles.get(nk).map { expandTile($0, 4) }
                return carveAgeCrackHeightTile(ct, baseH, ntx, nty, offset, age!, layerCount)
            }
            let hd = hasHeight ? heightTileAt(tx, ty) : nil
            let data = lightTile(cd, hd, { dx, dy in heightTileAt(tx + dx, ty + dy) }, m.map { expandTile($0, 4) }, light, f.map { expandTile($0, 4) }, viewTilt)
            let litTile = Tile(data: data, uniform: nil)
            tiles[key] = (inputs, light, viewTilt, ck, litTile)
            out.set(key, litTile)
        }
        for key in Array(tiles.keys) where !keys.contains(key) { tiles[key] = nil }
        return TiledSurface(channels: 4, tiles: out, defaultValue: color.defaultValue)
    }

    /// The ferrofluid lighting pass: carrier colour, gloss / metal material and (near magnets) spike
    /// heights blended into the thick relief, lit even when `light.relief` is 0; a thin film on the
    /// same layer still colours the lit tiles.
    private func litFerro(_ color: TiledSurface, _ ch: ThickChannels, _ light: PaintLighting, _ viewTilt: PaintViewTilt, _ ferro: FerroLayerInput) -> TiledSurface {
        let hasFerroSpikes = !ferro.magnets.isEmpty
        let fk = ferroCacheKey(ferro)
        var out = color.tiles
        var keys = OrderedMap<TileKey, Bool>()
        for k in color.tiles.keys { keys.set(k, true) }
        for k in ferro.surface.tiles.keys { keys.set(k, true) }
        for (key, _) in keys {
            let tile = color.tiles.get(key)
            let (tx, ty) = tileCoord(key)
            func aroundH(_ dx: Int, _ dy: Int) -> Tile? { ch.height.tiles.get(tileKey(tx + dx, ty + dy)) }
            func aroundF(_ dx: Int, _ dy: Int) -> Tile? { ferro.surface.tiles.get(tileKey(tx + dx, ty + dy)) }
            let film = ch.film.tiles.get(key)
            var any = film != nil
            for dy in -1...1 where !any {
                for dx in -1...1 where !any {
                    if aroundH(dx, dy) != nil || aroundF(dx, dy) != nil { any = true }
                }
            }
            if !any { continue }
            let m = ch.material.tiles.get(key)
            let f = ferro.surface.tiles.get(key)
            if tile == nil && f == nil { continue }
            var inputs: [ObjectIdentifier?] = [tile.map(ObjectIdentifier.init), m.map(ObjectIdentifier.init), film.map(ObjectIdentifier.init)]
            for dy in -1...1 { for dx in -1...1 { inputs.append(aroundH(dx, dy).map(ObjectIdentifier.init)) } }
            for dy in -1...1 { for dx in -1...1 { inputs.append(aroundF(dx, dy).map(ObjectIdentifier.init)) } }
            if let cached = tiles[key], cached.inputs == inputs, cached.light == light, cached.viewTilt == viewTilt, cached.ferroKey == fk {
                out.set(key, cached.tile)
                continue
            }

            var cd = tile.map { expandTile($0, 4) } ?? [UInt8](repeating: 0, count: TILE * TILE * 4)
            var md = m.map { expandTile($0, 4) }
            if let f {
                let fd = expandTile(f, 1)
                var mBuf = md ?? [UInt8](repeating: 0, count: TILE * TILE * 4)
                for p in 0..<fd.count {
                    let fb = Int(fd[p])
                    if fb == 0 { continue }
                    let i = p * 4
                    if Int(cd[i + 3]) < fb {
                        let a0 = Double(cd[i + 3]) / Double(fb)
                        cd[i] = JS.u8c(JS.round(Double(cd[i]) * a0 + Double(FERRO_CARRIER_RGB.0) * (1.0 - a0)))
                        cd[i + 1] = JS.u8c(JS.round(Double(cd[i + 1]) * a0 + Double(FERRO_CARRIER_RGB.1) * (1.0 - a0)))
                        cd[i + 2] = JS.u8c(JS.round(Double(cd[i + 2]) * a0 + Double(FERRO_CARRIER_RGB.2) * (1.0 - a0)))
                        cd[i + 3] = UInt8(fb)
                    }
                    let w = Double(fb) / 255.0
                    mBuf[i] = UInt8(Swift.max(Int(mBuf[i]), Int(JS.round(Double(FERRO_DEFAULT_GLOSS) * w))))
                    mBuf[i + 1] = UInt8(Swift.max(Int(mBuf[i + 1]), Int(JS.round(Double(FERRO_DEFAULT_METALLIC) * w))))
                    mBuf[i + 2] = UInt8(Swift.max(Int(mBuf[i + 2]), Int(JS.round(Double(FERRO_DEFAULT_RIM) * w))))
                    if mBuf[i + 3] == 0 { mBuf[i + 3] = 255 }
                }
                md = mBuf
            }

            func buildHeightTile(_ ntx: Int, _ nty: Int) -> [UInt8]? {
                let nkey = tileKey(ntx, nty)
                let ht = ch.height.tiles.get(nkey)
                let ft = hasFerroSpikes ? ferro.surface.tiles.get(nkey) : nil
                if ht == nil && ft == nil { return nil }
                guard let ft else { return expandTile(ht!, 1) }
                var outH = ht.map { expandTile($0, 1) } ?? [UInt8](repeating: 0, count: TILE * TILE)
                let fData = expandTile(ft, 1)
                let ox = Double(ntx * TILE + ferro.offset.x) + 0.5
                let oy = Double(nty * TILE + ferro.offset.y) + 0.5
                var p = 0
                for py in 0..<TILE {
                    let docY = oy + Double(py)
                    for px in 0..<TILE {
                        let fb = Int(fData[p])
                        if fb != 0 {
                            let hs = ferroSpikeHeightAt(ox + Double(px), docY, fb, ferro.magnets, ferro.settings)
                            if hs > 0 { outH[p] = UInt8(Swift.min(255, Int(outH[p]) + hs)) }
                        }
                        p += 1
                    }
                }
                return outH
            }

            let hd = buildHeightTile(tx, ty)
            let data = lightTile(cd, hd, { dx, dy in buildHeightTile(tx + dx, ty + dy) }, md, light, film.map { expandTile($0, 4) }, viewTilt)
            let litTile = Tile(data: data, uniform: nil)
            tiles[key] = (inputs, light, viewTilt, fk, litTile)
            out.set(key, litTile)
        }
        for key in Array(tiles.keys) where !keys.has(key) { tiles[key] = nil }
        return TiledSurface(channels: 4, tiles: out, defaultValue: color.defaultValue)
    }
}

/**
 * Live thin-film buffer (`FilmBuffer`) for a stroke: deposits or erases the 4-channel film map
 * (R thickness 100..1000 nm → 0..255, G IOR 1.2..2.0 → 0..255, B 0, A film amount 0..255) in
 * layer space and builds a `TiledSurface`.
 */
public final class FilmBuffer {
    private var tiles = OrderedMap<TileKey, ByteTile>()
    private let base: TiledSurface
    private let offset: LayerOffset
    private let mask: PaintSelection?

    public init(_ base: TiledSurface, _ offset: LayerOffset = LayerOffset(x: 0, y: 0), _ mask: PaintSelection? = nil) {
        self.base = base
        self.offset = offset
        self.mask = mask
    }

    public var changed: Bool { !tiles.isEmpty }

    private func tile(_ tx: Int, _ ty: Int) -> ByteTile {
        let key = tileKey(tx, ty)
        if let t = tiles.get(key) { return t }
        let t = ByteTile(base.tiles.get(key)?.data ?? [UInt8](repeating: 0, count: TILE * TILE * 4))
        tiles.set(key, t)
        return t
    }

    private func maskAt(_ wx: Int, _ wy: Int) -> Double {
        guard let m = mask else { return 1 }
        return wx >= 0 && wy >= 0 && wx < m.width && wy < m.height ? Double(m.data[wy * m.width + wx]) / 255 : 0
    }

    /// Deposits a dab's thin-film coat over `rect` (document pixels) with coverage `cov` and weight `opacity`.
    public func deposit(_ rect: RasterRect, _ cov: [Float], _ opacity: Double, _ pressure: Double, _ ir: IridescenceSettings) {
        if !(opacity > 0) { return }
        let pr = pressure.isFinite ? pressure : 0.5
        let nm = Swift.min(1000, Swift.max(100, ir.thickness * (1 + ir.pressureToThickness * (pr - 0.5) * 2)))
        let rVal = JS.round(((nm - 100) / 900) * 255)
        let gVal = JS.round(((ir.ior - 1.2) / 0.8) * 255)
        let off = offset
        var p = 0
        for yy in 0..<rect.height {
            for xx in 0..<rect.width {
                defer { p += 1 }
                let wx = rect.x + xx, wy = rect.y + yy
                let c = Swift.min(1, Double(cov[p]) * opacity * maskAt(wx, wy))
                if !(c > 0) { continue }
                let lx = wx - off.x, ly = wy - off.y
                let t = tile(lx >> 8, ly >> 8)
                let i = ((ly & 255) * TILE + (lx & 255)) * 4
                let a0 = Double(t.data[i + 3]) / 255
                let a1 = a0 + c * (1 - a0)
                let w = a1 > 0 ? c / a1 : 1
                t.data[i] = JS.u8c(JS.round(Double(t.data[i]) + (rVal - Double(t.data[i])) * w))
                t.data[i + 1] = JS.u8c(JS.round(Double(t.data[i + 1]) + (gVal - Double(t.data[i + 1])) * w))
                t.data[i + 2] = 0
                t.data[i + 3] = JS.u8c(JS.round(a1 * 255))
            }
        }
    }

    /// Erases the thin-film coat over `rect` (document pixels) with coverage `cov` and weight `opacity`.
    public func erase(_ rect: RasterRect, _ cov: [Float], _ opacity: Double) {
        if !(opacity > 0) { return }
        let off = offset
        var p = 0
        for yy in 0..<rect.height {
            for xx in 0..<rect.width {
                defer { p += 1 }
                let wx = rect.x + xx, wy = rect.y + yy
                let c = Swift.min(1, Double(cov[p]) * opacity * maskAt(wx, wy))
                if !(c > 0) { continue }
                let lx = wx - off.x, ly = wy - off.y
                let key = tileKey(lx >> 8, ly >> 8)
                if !tiles.has(key) && !base.tiles.has(key) { continue }
                let t = tile(lx >> 8, ly >> 8)
                let i = ((ly & 255) * TILE + (lx & 255)) * 4
                if t.data[i + 3] == 0 { continue }
                let a1 = JS.u8c(JS.round(Double(t.data[i + 3]) * (1 - c)))
                t.data[i + 3] = a1
                if a1 == 0 {
                    t.data[i] = 0
                    t.data[i + 1] = 0
                    t.data[i + 2] = 0
                }
            }
        }
    }

    public func surface() -> TiledSurface {
        if tiles.isEmpty { return base }
        var out = base.tiles
        for (k, d) in tiles {
            if let t = finishTile(d.data, 4, 0) { out.set(k, t) } else { _ = out.delete(k) }
        }
        return TiledSurface(channels: 4, tiles: out, defaultValue: 0)
    }
}

struct ThickStrokeInit {
    var brush: PaintBrush
    /// Where the colour goes (the session's live tiles).
    var target: PaintTileTarget
    /// The layer's channels before the stroke.
    var channels: ThickChannels
    /// Paint colour, sRGB 0..1.
    var color: [Double]
    var load: MixerLoad
    var seed: Int
    var copies: [StrokeCopy]
    var paint: PaintGradientSource?
    var effect: EffectPaintPixels?
}

private final class ThickCopyState {
    let walker: PenDabWalker
    let exchange: PaintExchange
    let smudge: SmudgeTip?
    /// Height patch carried by the knife.
    var carried: [Float]?
    var amount = 1.0
    init(walker: PenDabWalker, exchange: PaintExchange, smudge: SmudgeTip?) {
        self.walker = walker
        self.exchange = exchange
        self.smudge = smudge
    }
}

/// One impasto stroke: colour through the exchange, height and material into live channel tiles.
final class ThickStrokeDriver {
    var dabCount = 0
    let initValues: ThickStrokeInit
    private let smoother: PenSmoother
    private let states: [ThickCopyState]
    private let medium: TileMedium
    private let copies: [StrokeCopy]
    private let sampler: PaintGradientSampler?
    private var height = OrderedMap<TileKey, ByteTile>()
    private var material = OrderedMap<TileKey, ByteTile>()
    private let film: FilmBuffer?
    private var paintColor = [0.0, 0.0, 0.0]
    private var centre = [0.0, 0.0, 0.0]
    private var lastRaw: PenPoint?
    private var lastFed: PenPoint?

    init(_ i: ThickStrokeInit) {
        initValues = i
        let b = i.brush
        smoother = PenSmoother(b.tip.smoothing, b.pressureSmoothing)
        copies = i.copies.isEmpty ? [IDENTITY_COPY] : i.copies
        let rates = exchangeRates(b.behavior.pickup, b.behavior.mix, 1, b.behavior.mixing)
        states = copies.enumerated().map { k, c in
            ThickCopyState(
                walker: PenDabWalker(b, Int(Int32(truncatingIfNeeded: i.seed + k * 7919)), c.linear),
                exchange: PaintExchange(rates, i.load),
                smudge: b.impasto.tool == "knife" ? SmudgeTip(SmudgeSettings(strength: 0.85, length: 0.6 + 0.38 * b.impasto.drag, mixing: b.behavior.mixing), b.tip.size * 1.2) : nil
            )
        }
        medium = TileMedium(i.target, blend: nil)
        film = b.iridescence != nil ? FilmBuffer(i.channels.film, i.target.offset, i.target.selection) : nil
        if var g = i.paint {
            if g.map.by == "across-tip" { g.map = PaintGradientMapping(by: "distance", length: 300, repeat: "mirror") }
            sampler = PaintGradientSampler(g, seed: i.seed)
        } else {
            sampler = nil
        }
    }

    /// What copy 0 carries after the dabs so far.
    var load: MixerLoad { states[0].exchange.load }

    /// The channels with the stroke so far.
    func channels() -> ThickChannels {
        var h = initValues.channels.height.tiles
        var m = initValues.channels.material.tiles
        for (k, d) in height { if let t = finishTile(d.data, 1, 0) { h.set(k, t) } else { _ = h.delete(k) } }
        for (k, d) in material { if let t = finishTile(d.data, 4, 0) { m.set(k, t) } else { _ = m.delete(k) } }
        return ThickChannels(height: TiledSurface(channels: 1, tiles: h, defaultValue: 0), material: TiledSurface(channels: 4, tiles: m, defaultValue: 0), film: film?.surface() ?? initValues.channels.film)
    }

    private func heightTile(_ tx: Int, _ ty: Int, _ write: Bool) -> [UInt8]? {
        let key = tileKey(tx, ty)
        if let t = height.get(key) { return t.data }
        let base = initValues.channels.height.tiles.get(key)
        if !write { return base?.data }
        let t = ByteTile(base?.data ?? [UInt8](repeating: 0, count: TILE * TILE))
        height.set(key, t)
        return t.data
    }

    private func materialTile(_ tx: Int, _ ty: Int) -> ByteTile {
        let key = tileKey(tx, ty)
        if let t = material.get(key) { return t }
        let t = ByteTile(initValues.channels.material.tiles.get(key)?.data ?? [UInt8](repeating: 0, count: TILE * TILE * 4))
        material.set(key, t)
        return t
    }

    private func getH(_ x: Int, _ y: Int) -> Double {
        guard let t = heightTile(x >> 8, y >> 8, false) else { return 0 }
        return Double(t[(y & 255) * TILE + (x & 255)])
    }

    private func setH(_ x: Int, _ y: Int, _ v: Double) {
        _ = heightTile(x >> 8, y >> 8, true)
        height.get(tileKey(x >> 8, y >> 8))!.data[(y & 255) * TILE + (x & 255)] = JS.u8c(v)
    }

    func push(_ points: [PenPoint]) -> [RasterRect] {
        var rects: [RasterRect] = []
        for raw in points {
            lastRaw = raw
            let p = smoother.push(raw)
            lastFed = p
            for (k, c) in copies.enumerated() {
                var dabs: [PenDab] = []
                states[k].walker.push(c.map(p), &dabs)
                applyDabs(k, dabs, &rects)
            }
        }
        return rects
    }

    func finish() -> [RasterRect] {
        var rects: [RasterRect] = []
        for (k, c) in copies.enumerated() {
            var dabs: [PenDab] = []
            if let raw = lastRaw, let fed = lastFed, raw.x != fed.x || raw.y != fed.y {
                var q = raw
                q.pressure = fed.pressure
                states[k].walker.push(c.map(q), &dabs)
            }
            states[k].walker.finish(&dabs)
            applyDabs(k, dabs, &rects)
        }
        return rects
    }

    private func applyDabs(_ copy: Int, _ dabs: [PenDab], _ rects: inout [RasterRect]) {
        for d in dabs {
            let rect = dabRect(d.dab, initValues.brush.tip.hardness)
            if rect.width <= 0 || rect.height <= 0 { continue }
            dab(copy, d, rect)
            rects.append(rect)
            dabCount += 1
        }
    }

    private func dab(_ copy: Int, _ d: PenDab, _ rect: RasterRect) {
        let b = initValues.brush
        let im = b.impasto
        let st = states[copy]
        let n = rect.width * rect.height
        var tip = [Float](repeating: 0, count: n)
        var flat = d.dab
        flat.alpha = 1
        rasterizeDab(flat, b.tip.hardness, rect, &tip)
        if let sel = initValues.target.selection {
            var p = 0
            for yy in 0..<rect.height {
                for xx in 0..<rect.width {
                    let mx = rect.x + xx, my = rect.y + yy
                    if tip[p] > 0 { tip[p] = Float(Double(tip[p]) * (mx >= 0 && my >= 0 && mx < sel.width && my < sel.height ? Double(sel.data[my * sel.width + mx]) / 255 : 0)) }
                    p += 1
                }
            }
        }
        let off = initValues.target.offset
        let k = Swift.min(1, d.dab.alpha * d.dab.opacity * b.tip.opacity) * st.amount
        let nxs = JS.sin(d.direction)
        let nys = JS.cos(d.direction)
        let r = Swift.max(0.5, d.dab.radius)

        if im.tool == "knife" {
            st.smudge!.dab(medium, SmudgeDab(x: d.dab.x, y: d.dab.y, radius: d.dab.radius, opacity: k), rect, tip)
            knifeHeight(st, d, rect, tip, k, im.drag)
            paintMaterial(rect, tip, k * 0.6, im.gloss, im.metallic, im.rim, im.clarity)
            if let ir = b.iridescence { film?.deposit(rect, tip, k * 0.6, d.pressure, ir) }
            return
        }
        let thick = im.thickness * (1 - 0.8 * im.thinner)
        // The paint runs out along the stroke (a knife carries none, so it never runs out).
        st.amount *= 1 - 0.06 * (1 - im.load)
        let ex = st.exchange
        var flow = 1.0
        let effect = initValues.effect
        if let effect {
            let px = Int(JS.floor(d.dab.x)), py = Int(JS.floor(d.dab.y))
            if effect.map != nil || (px >= 0 && py >= 0 && px < effect.width && py < effect.height) { centre = sampleEffectAt(effect, d.dab.x, d.dab.y, EffectDabPlace(d)).rgb }
            ex.setReservoirColor(centre[0], centre[1], centre[2])
        } else if let sampler {
            let g = sampler.dab(d.params)
            ex.setReservoirColor(g.rgb[0], g.rgb[1], g.rgb[2])
            flow = g.alpha
        }
        ex.pickUp(medium.sample(rect, tip))
        let total = ex.paint(&paintColor)
        ex.drain()
        let dep = Swift.min(1, total) * k * (1 - 0.5 * im.thinner) * flow
        if dep > 0 {
            let boost = im.tool == "roller" || im.tool == "gloop" || im.tool == "tube" ? 1.6 : 1.1
            var cov = tip.map { $0 > 0 ? Float(Swift.min(1, Double($0) * boost)) : 0 }
            var field: [Float]? = nil
            if let effect {
                var f = [Float](repeating: 0, count: n * 3)
                effectDabField(effect, rect, &cov, centre, paintColor, &f, 0, d)
                field = f
            }
            medium.deposit(rect, cov, dep, paintColor, ex.paintPigment, field)
        }
        // Height.
        let seed = initValues.seed
        var p = 0
        for yy in 0..<rect.height {
            for xx in 0..<rect.width {
                defer { p += 1 }
                let c = Double(tip[p])
                if c <= 0 { continue }
                let dx = rect.x + xx, dy = rect.y + yy
                let lx = dx - off.x, ly = dy - off.y
                let u = ((Double(dx) + 0.5 - d.dab.x) * nxs + (Double(dy) + 0.5 - d.dab.y) * nys) / r
                let h0 = getH(lx, ly)
                var h = h0
                let full = 255 * thick * k
                switch im.tool {
                case "brush":
                    // Bristle ridges along the stroke: stripes across the tip, with a little noise.
                    let ridge = 0.6 + 0.4 * JS.sin(u * 9 + PixerateRandom.hash2(Int(JS.round(u * 6)), 3, seed) * 6.28) + 0.15 * (PixerateRandom.hash2(lx, ly, seed) - 0.5)
                    let target = full * c * ridge
                    h = Swift.max(h0 * (1 - 0.25 * c * im.drag), Swift.min(255, h0 * 0.35 + target))
                case "tube":
                    let dome = Swift.max(0, c).squareRoot()
                    h = Swift.max(h0, Swift.min(255, full * dome * 1.1))
                case "gloop":
                    let au = Swift.min(1, Swift.abs(u))
                    let dome = Swift.max(0, 1 - au * au).squareRoot()
                    h = Swift.max(h0, Swift.min(255, full * dome * (c > 0.2 ? 1 : c * 5)))
                case "roller":
                    let stipple = 0.75 + 0.5 * PixerateRandom.hash2(lx >> 1, ly >> 1, seed)
                    h = h0 + (Swift.min(255, full * 0.6 * stipple) - h0) * Swift.min(1, c * 1.5)
                default:
                    break
                }
                setH(lx, ly, JS.round(Swift.max(0, Swift.min(255, h))))
            }
        }
        paintMaterial(rect, tip, k, im.gloss * (1 - 0.3 * im.thinner), im.metallic, im.rim, im.clarity)
        if let ir = b.iridescence { film?.deposit(rect, tip, k, d.pressure, ir) }
    }

    /// The knife: flattens the relief under it and carries some of it along.
    private func knifeHeight(_ st: ThickCopyState, _ d: PenDab, _ rect: RasterRect, _ tip: [Float], _ k: Double, _ drag: Double) {
        let off = initValues.target.offset
        let w = rect.width
        let n = w * rect.height
        var cur = [Float](repeating: 0, count: n)
        var p = 0
        for yy in 0..<rect.height { for xx in 0..<w { cur[p] = Float(getH(rect.x + xx - off.x, rect.y + yy - off.y)); p += 1 } }
        let carried = st.carried.flatMap { $0.count == n ? $0 : nil }
        var next = [Float](repeating: 0, count: n)
        p = 0
        for yy in 0..<rect.height {
            for xx in 0..<w {
                defer { p += 1 }
                let c = Double(tip[p]) * k
                if c <= 0 {
                    next[p] = cur[p]
                    continue
                }
                let flat = Double(cur[p]) * (1 - 0.85 * c)
                let laid = carried.map { Double($0[p]) * drag * c } ?? 0
                let v = Swift.max(flat, Swift.min(255, flat * 0.5 + laid))
                next[p] = Float(v)
                setH(rect.x + xx - off.x, rect.y + yy - off.y, JS.round(v))
            }
        }
        var pick = [Float](repeating: 0, count: n)
        for q in 0..<n { pick[q] = Float(Swift.max(0, Double(cur[q]) - Double(next[q])) + (carried.map { Double($0[q]) * (1 - drag) * 0.5 } ?? 0)) }
        st.carried = pick
    }

    /// Material: R gloss, G metallic, B rim (0..255), A opacity for clarity (255 solid .. 1 clearest; 0 is no material).
    private func paintMaterial(_ rect: RasterRect, _ tip: [Float], _ k: Double, _ gloss: Double, _ metal: Double, _ rim: Double, _ clarity: Double) {
        let opacity = 255 - clarity * 254
        let off = initValues.target.offset
        var p = 0
        for yy in 0..<rect.height {
            for xx in 0..<rect.width {
                defer { p += 1 }
                let c = Swift.min(1, Double(tip[p]) * k)
                if c <= 0 { continue }
                let lx = rect.x + xx - off.x, ly = rect.y + yy - off.y
                let t = materialTile(lx >> 8, ly >> 8)
                let i = ((ly & 255) * TILE + (lx & 255)) * 4
                let t0 = Double(t.data[i]), t1 = Double(t.data[i + 1]), t2 = Double(t.data[i + 2])
                t.data[i] = JS.u8c(JS.round(t0 + (gloss * 255 - t0) * c))
                t.data[i + 1] = JS.u8c(JS.round(t1 + (metal * 255 - t1) * c))
                t.data[i + 2] = JS.u8c(JS.round(t2 + (rim * 255 - t2) * c))
                let a = t.data[i + 3] != 0 ? Double(t.data[i + 3]) : 255
                t.data[i + 3] = JS.u8c(Swift.max(1, JS.round(a + (opacity - a) * c)))
            }
        }
    }
}

/// Height and thin-film statistics of a layer's relief (for tools).
func reliefInfo(_ ch: ThickChannels) -> (bounds: RasterRect?, maxHeight: Int, tiles: Int) {
    var mx = 0
    for (_, t) in ch.height.tiles {
        if let u = t.uniform { mx = Swift.max(mx, Int(u & 255)) } else { for v in t.data where Int(v) > mx { mx = Int(v) } }
    }
    return (
        bounds: unionRectOpt(ch.height.bounds, ch.film.bounds),
        maxHeight: mx,
        tiles: ch.height.tiles.isEmpty ? ch.film.tiles.count : ch.height.tiles.count
    )
}

/// Channels → saved form (`{ rect, height, material, film? }`, PNG data URLs), or nil when there is no relief or film.
func thickToJSON(_ ch: ThickChannels) -> JSONValue? {
    guard let b = unionRectOpt(ch.height.bounds, ch.film.bounds) else { return nil }
    var out: JSONObject = [
        "rect": b.json,
        "height": .string(pngDataUrl(b.width, b.height, readRegion(ch.height, b), 1)),
        "material": .string(pngDataUrl(b.width, b.height, readRegion(ch.material, b), 4)),
    ]
    if ch.film.bounds != nil {
        out["film"] = .string(pngDataUrl(b.width, b.height, readRegion(ch.film, b), 4))
    }
    return .object(out)
}

/// `Number(v)` of a saved value (ToNumber): null 0, booleans 0 / 1, strings and arrays through their text, objects NaN.
func jsToNumber(_ v: JSONValue) -> Double {
    switch v {
    case .null: return 0
    case .bool(let b): return b ? 1 : 0
    case .number(let n): return n
    case .string(let s): return s.jsToNumber
    case .array: return jsTemplate(v).jsToNumber
    case .object: return .nan
    }
}

/// One coordinate of a saved channel's `rect` as `surfaceFromPixels(…, rect.x, rect.y)` uses it
/// unchecked: where it starts (`Number(x)`) and where `x + width` ends (a string, array or object
/// concatenates: `"1" + 2` is `"12"`). A missing coordinate is the parameter's default, 0.
private func savedCoordinate(_ v: JSONValue?, _ size: Int) -> (start: Double, end: Double) {
    guard let v else { return (0, Double(size)) }
    switch v {
    case .string, .array, .object: return (jsToNumber(v), (jsTemplate(v) + jsText(Double(size))).jsToNumber)
    default:
        let n = jsToNumber(v)
        return (n, n + Double(size))
    }
}

/// `subarray`'s relative index: truncated toward zero (NaN 0), counted from the end when negative, clamped to `count`.
private func relativeIndex(_ v: Double, _ count: Int) -> Int {
    let t = v.isNaN ? 0 : v.rounded(.towardZero)
    if t < 0 { return Int(Swift.max(Double(count) + t, 0)) }
    return Int(Swift.min(t, Double(count)))
}

/**
 * `surfaceFromPixels(pixels, channels, rect.x, rect.y)` with a saved channel's `rect` read as the
 * TS core reads it, unchecked (`writeRegion` in doubles): a missing or `null` coordinate is 0, a
 * boolean 0 or 1, a fractional one writes at the offsets typed-array `set` truncates to, a string
 * concatenates, and NaN writes nothing. Throws "offset is out of bounds" where `set` would.
 */
func surfaceAtSavedRect(_ rect: JSONValue?, width w: Int, height h: Int, data: [UInt8], channels ch: Int) throws -> TiledSurface {
    let r = rect?.objectValue
    let (x, xEnd) = savedCoordinate(r?["x"], w)
    let (y, yEnd) = savedCoordinate(r?["y"], h)
    return try surfaceAtCoordinates(x: x, xEnd: xEnd, y: y, yEnd: yEnd, width: w, height: h, data: data, channels: ch)
}

/// `writeRegion(emptySurface(ch), { x, y, width, height }, data)` in doubles, with `rect.x + width` given as `xEnd`.
func surfaceAtCoordinates(x: Double, xEnd: Double, y: Double, yEnd: Double, width w: Int, height h: Int, data: [UInt8], channels ch: Int) throws -> TiledSurface {
    let surface = emptySurface(ch, 0)
    if w <= 0 || h <= 0 { return surface }
    let T = Double(TILE)
    let tx0 = JS.floor(x / T), ty0 = JS.floor(y / T)
    let tx1 = JS.floor((xEnd - 1) / T), ty1 = JS.floor((yEnd - 1) / T)
    // Tile keys are exact in doubles up to here (`tileKey`); TS goes on past it with rounded keys.
    let limit = 1e10
    if Swift.abs(tx0) > limit || Swift.abs(tx1) > limit || Swift.abs(ty0) > limit || Swift.abs(ty1) > limit {
        throw PaintEditorError("the channel lies too far off the canvas to read")
    }
    let draft = SurfaceDraft(surface)
    let tilePixels = TILE * TILE
    var ty = ty0
    while ty <= ty1 {
        var tx = tx0
        while tx <= tx1 {
            let ox = tx * T, oy = ty * T
            let x0 = JS.max(x, ox), y0 = JS.max(y, oy)
            let x1 = JS.min(xEnd, ox + T), y1 = JS.min(yEnd, oy + T)
            let full = x0 == ox && y0 == oy && x1 == ox + T && y1 == oy + T
            let buf = full ? TileBuffer([UInt8](repeating: 0, count: tilePixels * ch)) : draft.tile(Int(tx), Int(ty))
            let span = (x1 - x0) * Double(ch)
            var yy = y0
            while yy < y1 {
                let s = ((yy - y) * Double(w) + (x0 - x)) * Double(ch)
                let d = ((yy - oy) * T + (x0 - ox)) * Double(ch)
                let begin = relativeIndex(s, data.count)
                let end = relativeIndex(s + span, data.count)
                let count = Swift.max(end - begin, 0)
                let offset = d.isNaN ? 0 : d.rounded(.towardZero)
                if offset < 0 || Double(count) + offset > Double(buf.data.count) { throw PaintEditorError("offset is out of bounds") }
                let o = Int(offset)
                for k in 0 ..< count { buf.data[o + k] = data[begin + k] }
                yy += 1
            }
            if full { draft.replace(Int(tx), Int(ty), buf.data) }
            tx += 1
        }
        ty += 1
    }
    return draft.commit()
}

/// Saved form → channels (`thickFromJSON`); throws a sentence when it cannot be read.
func thickFromJSON(_ raw: JSONValue) throws -> ThickChannels {
    guard let r = raw.objectValue, jsTruthy(r["rect"]),
          let heightUrl = r["height"]?.stringValue, let materialUrl = r["material"]?.stringValue
    else { throw PaintEditorError("not saved thick-paint channels") }
    func decode(_ url: String, _ gray: Bool) throws -> DecodedPng {
        guard let parsed = parseDataUrl(url) else { throw PaintEditorError("a channel is not a PNG data URL") }
        return try decodePng(parsed.bytes, keepGray: gray)
    }
    let h = try decode(heightUrl, true)
    let m = try decode(materialUrl, false)
    let hd = h.channels == 1 ? h.data : (0..<(h.width * h.height)).map { h.data[$0 * 4] }
    var film = emptySurface(4, 0)
    if let filmUrl = r["film"]?.stringValue {
        let f = try decode(filmUrl, false)
        film = try surfaceAtSavedRect(r["rect"], width: f.width, height: f.height, data: f.data, channels: 4)
    }
    return ThickChannels(
        height: try surfaceAtSavedRect(r["rect"], width: h.width, height: h.height, data: hd, channels: 1),
        material: try surfaceAtSavedRect(r["rect"], width: m.width, height: m.height, data: m.data, channels: 4),
        film: film
    )
}

/// How far a bead's surface faces the viewer (0 edge-on .. 1 facing), from the height around a pixel.
private func facing(_ h: [UInt8], _ x: Int, _ y: Int) -> Double {
    func at(_ xx: Int, _ yy: Int) -> Double { Double(h[Swift.min(TILE - 1, Swift.max(0, yy)) * TILE + Swift.min(TILE - 1, Swift.max(0, xx))]) }
    let k = 7.0 / 255
    let dx = ((at(x + 1, y) - at(x - 1, y)) / 2) * k
    let dy = ((at(x, y + 1) - at(x, y - 1)) / 2) * k
    return 1 / JS.hypot(dx, dy, 1)
}

/// Whether a material tile has clear paint (opacity between 1 and 254).
private func clearMaterial(_ m: Tile?) -> Bool {
    guard let m else { return false }
    if let u = m.uniform { return (u & 255) > 0 && (u & 255) < 255 }
    var i = 3
    while i < m.data.count {
        if m.data[i] > 0 && m.data[i] < 255 { return true }
        i += 4
    }
    return false
}

/**
 * Glow, rim and clarity over a layer's (lit) colour, tile by tile (`LightCache.glow`). Tiles with no
 * light and no clear thick paint are the colour tiles themselves.
 */
func glowSurface(_ color: TiledSurface, _ light: TiledSurface?, _ thick: ThickChannels?) -> TiledSurface {
    if (light?.tiles.isEmpty ?? true) && !(thick.map { $0.material.tiles.values.contains(where: clearMaterial) } ?? false) { return color }
    var out = color.tiles
    for (key, tile) in color.tiles {
        let l = light?.tiles.get(key)
        let m = thick?.material.tiles.get(key)
        let h = thick?.height.tiles.get(key)
        if l == nil && !clearMaterial(m) { continue }
        let ld = l?.data, md = m?.data, hd = h?.data
        var d = tile.data
        var i = 0
        for y in 0..<TILE {
            for x in 0..<TILE {
                defer { i += 1 }
                let j = i * 4
                if d[j + 3] == 0 { continue }
                let rim = md.map { Double($0[j + 2]) / 255 } ?? 0
                let opacity = md.flatMap { $0[j + 3] != 0 ? Double($0[j + 3]) : nil } ?? 255
                let f = (rim > 0 || opacity < 255) && hd != nil ? facing(hd!, x, y) : 1
                let g = ld != nil && ld![i] != 0 ? (Double(ld![i]) / 255) * (1 - rim + rim * 2 * JS.pow(1 - f, 3)) : 0
                if g > 0 {
                    for ch in 0..<3 { d[j + ch] = JS.u8c(JS.round(colourFromLinear(Swift.min(1, colourToLinear(Double(d[j + ch]) / 255) * (1 + GLOW * g))) * 255)) }
                }
                // Clarity: the middle of a bead (facing the viewer) turns clear; its edges stay solid.
                if opacity < 255 { d[j + 3] = JS.u8c(JS.round(Double(d[j + 3]) * (1 - ((255 - opacity) / 254) * f))) }
            }
        }
        out.set(key, Tile(data: d, uniform: nil))
    }
    return TiledSurface(channels: 4, tiles: out, defaultValue: color.defaultValue)
}
