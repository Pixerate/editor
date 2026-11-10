import Foundation
import PixerateCore
import PixerateRaster

/**
 * Smart inks (`paint-editor/heat.ts`): UV-fluorescent ink (`doc.fluor[layerId]` + `uvLight`) and
 * thermochromic ink (`doc.thermo[layerId]` + `doc.heat`).
 */

/// View / document UV blacklight setting.
public struct UvLightSettings: Equatable, Sendable {
    public var on: Bool = false
    public var strength: Double = 1
    public var ambient: Double = 0.15

    public init(on: Bool = false, strength: Double = 1, ambient: Double = 0.15) {
        self.on = on
        self.strength = strength
        self.ambient = ambient
    }

    public var json: JSONValue {
        ["on": .bool(on), "strength": .number(strength), "ambient": .number(ambient)]
    }
}

public let DEFAULT_UV_LIGHT = UvLightSettings(on: false, strength: 1, ambient: 0.15)

public func normalizeUvLight(on: Bool? = nil, strength: Double? = nil, ambient: Double? = nil, _ base: UvLightSettings = DEFAULT_UV_LIGHT) -> UvLightSettings {
    func num(_ v: Double?, _ d: Double) -> Double { v.flatMap { $0.isFinite ? $0 : nil } ?? d }
    return UvLightSettings(
        on: on ?? base.on,
        strength: Swift.min(2, Swift.max(0, num(strength, base.strength))),
        ambient: Swift.min(1, Swift.max(0, num(ambient, base.ambient)))
    )
}

/// The paper dimmed to `uv.ambient` while the UV blacklight is on.
public func uvPaper(_ paper: PaperSettings, _ uv: UvLightSettings) -> PaperSettings {
    if !uv.on || uv.ambient >= 1 { return paper }
    let rgb = hexToRgb8(paper.color)
    func toHex(_ v: Int) -> String { String(Int(JS.round(Swift.min(255, Swift.max(0, Double(v) * uv.ambient)))), radix: 16).leftPad(2) }
    var next = paper
    next.color = "#\(toHex(rgb[0]))\(toHex(rgb[1]))\(toHex(rgb[2]))"
    return next
}

public func emptyFluor() -> TiledSurface { emptySurface(4, 0) }
public func emptyThermo() -> TiledSurface { emptySurface(4, 0) }

private func expand4(_ t: Tile) -> [UInt8] {
    if t.data.count == TILE * TILE * 4 { return t.data }
    var out = [UInt8](repeating: 0, count: TILE * TILE * 4)
    let u = t.uniform ?? 0
    let b0 = UInt8((u >> 24) & 255)
    let b1 = UInt8((u >> 16) & 255)
    let b2 = UInt8((u >> 8) & 255)
    let b3 = UInt8(u & 255)
    var i = 0
    while i < out.count {
        out[i] = b0; out[i + 1] = b1; out[i + 2] = b2; out[i + 3] = b3
        i += 4
    }
    return out
}

/// Twin brush that writes or moves the per-layer 4-channel fluorescence surface (`doc.fluor[id]`).
func fluorTwinBrush(_ brush: PaintBrush) -> PaintBrush {
    let f = brush.fluorescence.amount
    var base = brush
    base.light = DEFAULT_LIGHT
    base.fluorescence = DEFAULT_FLUORESCENCE
    base.thermochromic = DEFAULT_THERMOCHROMIC
    base.tip.blend = .normal
    if brush.engine == "eraser" || brush.engine == "smudge" || brush.engine == "blender" || brush.engine == "vortex" { return base }
    let move = brush.engine == "impasto" ? (brush.impasto.tool == "knife" ? "smudge" : "dab") : brush.engine
    if f > 0 {
        var tip = base.tip.json.objectValue!
        tip["opacity"] = .number(brush.tip.opacity * f)
        tip["blend"] = "normal"
        return normalizePaintBrush(["engine": .string(move), "tip": .object(tip)], base)
    }
    if brush.engine == "mixer" || brush.behavior.pickup > 0 || (brush.engine == "impasto" && brush.impasto.tool == "knife") {
        return normalizePaintBrush(["engine": .string(move)], base)
    }
    var tip = base.tip.json.objectValue!
    tip["opacity"] = .number(brush.tip.opacity)
    return normalizePaintBrush(["engine": "eraser", "tip": .object(tip), "paint": .null], base)
}

/// Twin brush that writes or moves the per-layer 4-channel thermochromic surface (`doc.thermo[id]`).
func thermoTwinBrush(_ brush: PaintBrush) -> PaintBrush {
    let active = brush.thermochromic.hotColor != nil
    var base = brush
    base.light = DEFAULT_LIGHT
    base.fluorescence = DEFAULT_FLUORESCENCE
    base.thermochromic = DEFAULT_THERMOCHROMIC
    base.paint = nil
    base.tip.blend = .normal
    if brush.engine == "eraser" || brush.engine == "smudge" || brush.engine == "blender" || brush.engine == "vortex" { return base }
    let move = brush.engine == "impasto" ? (brush.impasto.tool == "knife" ? "smudge" : "dab") : brush.engine
    if active {
        var behavior = base.behavior.json.objectValue!
        behavior["pickup"] = 0
        return normalizePaintBrush(["engine": .string(move), "behavior": .object(behavior)], base)
    }
    if brush.engine == "mixer" || brush.behavior.pickup > 0 || (brush.engine == "impasto" && brush.impasto.tool == "knife") {
        return normalizePaintBrush(["engine": .string(move)], base)
    }
    var tip = base.tip.json.objectValue!
    tip["opacity"] = .number(brush.tip.opacity)
    return normalizePaintBrush(["engine": "eraser", "tip": .object(tip)], base)
}

/// Encodes `threshold` (`0.05..0.95`) into channel 3 (`1..255`) of a thermochromic surface after a twin stroke.
func finalizeThermoStroke(_ twinOut: TiledSurface, _ before: TiledSurface, _ hotRgb: [Int], _ threshold: Double) -> TiledSurface {
    let thByte = UInt8(Swift.max(1, Swift.min(255, Int(JS.round(threshold * 255)))))
    var out = before.tiles
    var keys = before.tiles.keys
    for k in twinOut.tiles.keys where !keys.contains(k) { keys.append(k) }
    for key in keys {
        let afterTile = twinOut.tiles.get(key)
        let beforeTile = before.tiles.get(key)
        if let a = afterTile, let b = beforeTile, a === b { continue }
        guard let afterTile else {
            _ = out.delete(key)
            continue
        }
        let aData = expand4(afterTile)
        let bData = beforeTile.map(expand4)
        var dst = [UInt8](repeating: 0, count: TILE * TILE * 4)
        var i = 0
        while i < dst.count {
            defer { i += 4 }
            let cov = Double(aData[i + 3]) / 255
            let prevTh = bData?[i + 3] ?? 0
            if cov <= 0 && prevTh == 0 { continue }
            if prevTh == 0 {
                dst[i] = UInt8(hotRgb[0])
                dst[i + 1] = UInt8(hotRgb[1])
                dst[i + 2] = UInt8(hotRgb[2])
                dst[i + 3] = thByte
            } else if cov <= 0, let bData {
                dst[i] = bData[i]
                dst[i + 1] = bData[i + 1]
                dst[i + 2] = bData[i + 2]
                dst[i + 3] = prevTh
            } else if let bData {
                dst[i] = JS.u8c(JS.round(Double(bData[i]) * (1 - cov) + Double(hotRgb[0]) * cov))
                dst[i + 1] = JS.u8c(JS.round(Double(bData[i + 1]) * (1 - cov) + Double(hotRgb[1]) * cov))
                dst[i + 2] = JS.u8c(JS.round(Double(bData[i + 2]) * (1 - cov) + Double(hotRgb[2]) * cov))
                dst[i + 3] = UInt8(Swift.max(1, Int(JS.round(Double(prevTh) * (1 - cov) + Double(thByte) * cov))))
            }
        }
        if let ft = finishTile(dst, 4, 0) { out.set(key, ft) } else { _ = out.delete(key) }
    }
    return TiledSurface(channels: 4, tiles: out, defaultValue: 0)
}

/// Scales the alpha channel of a 4-channel RGBA surface (`fluor`) by `k` (0..1).
func scaleFluor(_ surface: TiledSurface, _ k: Double) -> TiledSurface {
    if k <= 0 || surface.tiles.isEmpty { return emptyFluor() }
    if k >= 1 { return TiledSurface(channels: 4, tiles: surface.tiles, defaultValue: 0) }
    var tiles = OrderedMap<TileKey, Tile>()
    for (key, tile) in surface.tiles {
        var dst = expand4(tile)
        var i = 3
        while i < dst.count {
            dst[i] = JS.u8c(JS.round(Double(dst[i]) * k))
            i += 4
        }
        if let ft = finishTile(dst, 4, 0) { tiles.set(key, ft) }
    }
    return TiledSurface(channels: 4, tiles: tiles, defaultValue: 0)
}

/// Merges two 4-channel surfaces (`above` over `below`) when merging layers down.
func mergeFourChannel(_ below: TiledSurface?, _ above: TiledSurface?) -> TiledSurface? {
    let bEmpty = below?.tiles.isEmpty ?? true
    let aEmpty = above?.tiles.isEmpty ?? true
    if bEmpty && aEmpty { return nil }
    if bEmpty { return TiledSurface(channels: 4, tiles: above!.tiles, defaultValue: 0) }
    if aEmpty { return TiledSurface(channels: 4, tiles: below!.tiles, defaultValue: 0) }
    var keys = below!.tiles.keys
    for k in above!.tiles.keys where !keys.contains(k) { keys.append(k) }
    var tiles = OrderedMap<TileKey, Tile>()
    for key in keys {
        let b = below!.tiles.get(key)
        let a = above!.tiles.get(key)
        guard let a else {
            if let b { tiles.set(key, b) }
            continue
        }
        guard let b else {
            tiles.set(key, a)
            continue
        }
        let bd = expand4(b)
        let ad = expand4(a)
        var dst = [UInt8](repeating: 0, count: TILE * TILE * 4)
        var i = 0
        while i < dst.count {
            defer { i += 4 }
            let sa = Double(ad[i + 3]) / 255
            let da = Double(bd[i + 3]) / 255
            let oa = sa + da * (1 - sa)
            if oa <= 0 { continue }
            for c in 0..<3 {
                dst[i + c] = JS.u8c(JS.round((Double(ad[i + c]) * sa + Double(bd[i + c]) * da * (1 - sa)) / oa))
            }
            dst[i + 3] = JS.u8c(JS.round(oa * 255))
        }
        if let ft = finishTile(dst, 4, 0) { tiles.set(key, ft) }
    }
    return tiles.isEmpty ? nil : TiledSurface(channels: 4, tiles: tiles, defaultValue: 0)
}

private func fluorIntensitySurface(_ fluor: TiledSurface) -> TiledSurface {
    var tiles = OrderedMap<TileKey, Tile>()
    for (key, tile) in fluor.tiles {
        let src = expand4(tile)
        var dst = [UInt8](repeating: 0, count: TILE * TILE)
        for p in 0..<(TILE * TILE) { dst[p] = src[p * 4 + 3] }
        if let ft = finishTile(dst, 1, 0) { tiles.set(key, ft) }
    }
    return TiledSurface(channels: 1, tiles: tiles, defaultValue: 0)
}

public func computeUvSpill(_ fluor: TiledSurface, _ strength: Double) -> TiledSurface? {
    if fluor.tiles.isEmpty || strength <= 0 { return nil }
    let intensity = fluorIntensitySurface(fluor)
    if intensity.tiles.isEmpty { return nil }
    return computeSpill(fluor, intensity, LightSpill(radius: 20, strength: Swift.min(2, 0.9 * strength)))
}

/// Tile cache for UV blacklight rendering on one layer.
public final class UvCache {
    private var tiles: [TileKey: (cId: ObjectIdentifier?, fId: ObjectIdentifier?, uv: UvLightSettings, tile: Tile)] = [:]
    private var spillCache: (fluorId: ObjectIdentifier, strength: Double, surface: TiledSurface?)?

    public init() {}

    public func render(_ color: TiledSurface, _ fluor: TiledSurface?, _ uv: UvLightSettings) -> TiledSurface {
        if !uv.on { return color }
        var keys = color.tiles.keys
        if let fluor {
            for k in fluor.tiles.keys where !keys.contains(k) { keys.append(k) }
        }
        var out = OrderedMap<TileKey, Tile>()
        let keySet = Set(keys)
        for key in keys {
            let cTile = color.tiles.get(key)
            let fTile = fluor?.tiles.get(key)
            if cTile == nil && (fTile == nil || uv.strength <= 0) { continue }
            let cId = cTile.map(ObjectIdentifier.init)
            let fId = fTile.map(ObjectIdentifier.init)
            if let cached = tiles[key], cached.cId == cId, cached.fId == fId, cached.uv == uv {
                out.set(key, cached.tile)
                continue
            }
            let cd = cTile.map(expand4)
            let fd = (fTile != nil && uv.strength > 0) ? expand4(fTile!) : nil
            var dst = [UInt8](repeating: 0, count: TILE * TILE * 4)
            let amb = uv.ambient
            let str = uv.strength
            var i = 0
            while i < dst.count {
                defer { i += 4 }
                let ca = cd?[i + 3] ?? 0
                let fa = fd?[i + 3] ?? 0
                if ca == 0 && fa == 0 { continue }
                let fGain = (Double(fa) / 255) * str
                let fCov = Swift.min(1, fGain)
                for c in 0..<3 {
                    let baseLin = ca > 0 ? SRGB_TO_LINEAR[Int(cd![i + c])] * amb : 0
                    let emLin = fa > 0 ? SRGB_TO_LINEAR[Int(fd![i + c])] * (1 + 1.15 * fGain) : 0
                    dst[i + c] = UInt8(linearToSrgb8(baseLin * (1 - fCov * 0.5) + emLin * fCov))
                }
                dst[i + 3] = UInt8(Swift.min(255, Swift.max(Int(ca), Int(JS.round(Double(fa) * Swift.min(1, str))))))
            }
            if let ft = finishTile(dst, 4, 0) {
                tiles[key] = (cId, fId, uv, ft)
                out.set(key, ft)
            }
        }
        for k in Array(tiles.keys) where !keySet.contains(k) { tiles[k] = nil }
        return TiledSurface(channels: 4, tiles: out, defaultValue: color.defaultValue)
    }

    public func spill(_ fluor: TiledSurface, _ uv: UvLightSettings) -> TiledSurface? {
        if !uv.on || uv.strength <= 0 || fluor.tiles.isEmpty { return nil }
        let fid = ObjectIdentifier(fluor)
        if let sc = spillCache, sc.fluorId == fid, sc.strength == uv.strength { return sc.surface }
        let s = computeUvSpill(fluor, uv.strength)
        spillCache = (fid, uv.strength, s)
        return s
    }
}

public let HEAT_SCALE = 4
public let HEAT_DIFFUSION = 0.18
public let HEAT_COOLING = 0.03
public let HEAT_DRY_THRESHOLD = 0.5

public final class HeatField {
    public var width: Int
    public var height: Int
    public var gridWidth: Int
    public var gridHeight: Int
    public var cells: [Double]
    public var max: Double
    public var revision: Int

    public init(width: Int, height: Int, gridWidth: Int, gridHeight: Int, cells: [Double], max: Double = 0, revision: Int = 0) {
        self.width = width
        self.height = height
        self.gridWidth = gridWidth
        self.gridHeight = gridHeight
        self.cells = cells
        self.max = max
        self.revision = revision
    }
}

public struct HeatSample: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var temperature: Double

    public var json: JSONValue {
        ["x": .number(x), "y": .number(y), "temperature": .number(temperature)]
    }
}

public struct HeatStats: Equatable, Sendable {
    public var max: Double
    public var mean: Double
    public var hotCells: Int
    public var bounds: RasterRect?

    public var json: JSONObject {
        ["max": .number(max), "mean": .number(mean), "hotCells": .number(Double(hotCells)), "bounds": rectJSON(bounds)]
    }
}

public func createHeatField(_ width: Int, _ height: Int) -> HeatField {
    let gw = Swift.max(1, Int(JS.ceil(Double(width) / Double(HEAT_SCALE))))
    let gh = Swift.max(1, Int(JS.ceil(Double(height) / Double(HEAT_SCALE))))
    return HeatField(width: width, height: height, gridWidth: gw, gridHeight: gh, cells: [Double](repeating: 0, count: gw * gh), max: 0, revision: 0)
}

public func cloneHeatField(_ field: HeatField) -> HeatField {
    HeatField(width: field.width, height: field.height, gridWidth: field.gridWidth, gridHeight: field.gridHeight, cells: field.cells, max: field.max, revision: field.revision)
}

private func distToSegment(_ px: Double, _ py: Double, _ ax: Double, _ ay: Double, _ bx: Double, _ by: Double) -> Double {
    let dx = bx - ax
    let dy = by - ay
    let len2 = dx * dx + dy * dy
    if len2 <= 1e-9 { return JS.hypot(px - ax, py - ay) }
    let t = Swift.min(1, Swift.max(0, ((px - ax) * dx + (py - ay) * dy) / len2))
    return JS.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

public func heatStats(_ field: HeatField?) -> HeatStats {
    guard let field else { return HeatStats(max: 0, mean: 0, hotCells: 0, bounds: nil) }
    var max = 0.0
    var sum = 0.0
    var hot = 0
    let n = field.cells.count
    for v in field.cells {
        if v > max { max = v }
        sum += v
        if v >= 0.05 { hot += 1 }
    }
    field.max = round3(max)
    return HeatStats(
        max: field.max,
        mean: n > 0 ? round3(sum / Double(n)) : 0,
        hotCells: hot,
        bounds: hot > 0 ? hotCellsBounds(field, 0.05) : nil
    )
}

public func hotCellsBounds(_ field: HeatField, _ threshold: Double = HEAT_DRY_THRESHOLD) -> RasterRect? {
    var x0 = field.gridWidth
    var y0 = field.gridHeight
    var x1 = -1
    var y1 = -1
    for cy in 0..<field.gridHeight {
        for cx in 0..<field.gridWidth {
            if field.cells[cy * field.gridWidth + cx] >= threshold {
                if cx < x0 { x0 = cx }
                if cy < y0 { y0 = cy }
                if cx > x1 { x1 = cx }
                if cy > y1 { y1 = cy }
            }
        }
    }
    if x1 < x0 { return nil }
    let rx = x0 * HEAT_SCALE
    let ry = y0 * HEAT_SCALE
    let rw = Swift.min(field.width - rx, (x1 - x0 + 1) * HEAT_SCALE)
    let rh = Swift.min(field.height - ry, (y1 - y0 + 1) * HEAT_SCALE)
    return rw > 0 && rh > 0 ? RasterRect(x: rx, y: ry, width: rw, height: rh) : nil
}

public func paintHeatField(_ field: HeatField, _ points: [Point2], radius: Double = 32, temperature: Double = 0.85) -> (bounds: RasterRect, stats: HeatStats) {
    let r = Swift.min(512, Swift.max(1, radius))
    let temp = Swift.min(1, Swift.max(0, temperature))
    let gw = field.gridWidth
    let gh = field.gridHeight
    var minCx = gw
    var minCy = gh
    var maxCx = -1
    var maxCy = -1
    let segCount = Swift.max(1, points.count - 1)
    for s in 0..<segCount {
        let a = points[s]
        let b = points[Swift.min(points.count - 1, s + 1)]
        let x0 = Swift.max(0, Int(JS.floor((Swift.min(a.x, b.x) - r) / Double(HEAT_SCALE))))
        let y0 = Swift.max(0, Int(JS.floor((Swift.min(a.y, b.y) - r) / Double(HEAT_SCALE))))
        let x1 = Swift.min(gw - 1, Int(JS.ceil((Swift.max(a.x, b.x) + r) / Double(HEAT_SCALE))))
        let y1 = Swift.min(gh - 1, Int(JS.ceil((Swift.max(a.y, b.y) + r) / Double(HEAT_SCALE))))
        if y0 <= y1 && x0 <= x1 {
            for cy in y0...y1 {
                let gy = (Double(cy) + 0.5) * Double(HEAT_SCALE)
                for cx in x0...x1 {
                    let gx = (Double(cx) + 0.5) * Double(HEAT_SCALE)
                    let d = distToSegment(gx, gy, a.x, a.y, b.x, b.y)
                    if d >= r { continue }
                    let u = 1 - d / r
                    let w = u * u * (3 - 2 * u)
                    let idx = cy * gw + cx
                    let cur = field.cells[idx]
                    let next = cur + (temp - cur) * w
                    field.cells[idx] = next < 1e-4 ? 0 : Swift.min(1, Swift.max(0, next))
                    if cx < minCx { minCx = cx }
                    if cy < minCy { minCy = cy }
                    if cx > maxCx { maxCx = cx }
                    if cy > maxCy { maxCy = cy }
                }
            }
        }
    }
    field.revision += 1
    let bounds: RasterRect
    if maxCx >= minCx {
        bounds = RasterRect(
            x: minCx * HEAT_SCALE,
            y: minCy * HEAT_SCALE,
            width: Swift.min(field.width - minCx * HEAT_SCALE, (maxCx - minCx + 1) * HEAT_SCALE),
            height: Swift.min(field.height - minCy * HEAT_SCALE, (maxCy - minCy + 1) * HEAT_SCALE)
        )
    } else {
        bounds = RasterRect(x: 0, y: 0, width: 0, height: 0)
    }
    return (bounds, heatStats(field))
}

public func advanceHeatField(_ field: HeatField, steps: Int = 10) -> HeatStats {
    let n = Swift.min(1000, Swift.max(1, steps))
    let gw = field.gridWidth
    let gh = field.gridHeight
    var src = field.cells
    var dst = [Double](repeating: 0, count: src.count)
    let decay = 1 - HEAT_COOLING
    for _ in 0..<n {
        for y in 0..<gh {
            let yUp = Swift.max(0, y - 1) * gw
            let yCur = y * gw
            let yDn = Swift.min(gh - 1, y + 1) * gw
            for x in 0..<gw {
                let xL = Swift.max(0, x - 1)
                let xR = Swift.min(gw - 1, x + 1)
                let c = src[yCur + x]
                let avg = (src[yCur + xL] + src[yCur + xR] + src[yUp + x] + src[yDn + x]) * 0.25
                let v = (c + HEAT_DIFFUSION * (avg - c)) * decay
                dst[yCur + x] = v < 1e-4 ? 0 : v
            }
        }
        swap(&src, &dst)
    }
    field.cells = src
    field.revision += 1
    return heatStats(field)
}

public func clearHeatField(_ field: HeatField) -> Bool {
    var had = false
    for i in 0..<field.cells.count where field.cells[i] > 0 {
        had = true
        field.cells[i] = 0
    }
    field.max = 0
    if had { field.revision += 1 }
    return had
}

public func sampleHeatAt(_ field: HeatField, _ x: Double, _ y: Double) -> Double {
    let gx = x / Double(HEAT_SCALE) - 0.5
    let gy = y / Double(HEAT_SCALE) - 0.5
    let gw = field.gridWidth
    let gh = field.gridHeight
    let x0 = Swift.max(0, Swift.min(gw - 1, Int(JS.floor(gx))))
    let y0 = Swift.max(0, Swift.min(gh - 1, Int(JS.floor(gy))))
    let x1 = Swift.max(0, Swift.min(gw - 1, x0 + 1))
    let y1 = Swift.max(0, Swift.min(gh - 1, y0 + 1))
    let fx = Swift.min(1, Swift.max(0, gx - JS.floor(gx)))
    let fy = Swift.min(1, Swift.max(0, gy - JS.floor(gy)))
    let c00 = field.cells[y0 * gw + x0]
    let c10 = field.cells[y0 * gw + x1]
    let c01 = field.cells[y1 * gw + x0]
    let c11 = field.cells[y1 * gw + x1]
    let top = c00 * (1 - fx) + c10 * fx
    let bot = c01 * (1 - fx) + c11 * fx
    return top * (1 - fy) + bot * fy
}

public func shiftHeatField(_ field: HeatField, _ dx: Int, _ dy: Int, _ newWidth: Int, _ newHeight: Int) -> HeatField {
    let next = createHeatField(newWidth, newHeight)
    for cy in 0..<next.gridHeight {
        let docY = (Double(cy) + 0.5) * Double(HEAT_SCALE) - Double(dy)
        if docY < 0 || docY >= Double(field.height) { continue }
        for cx in 0..<next.gridWidth {
            let docX = (Double(cx) + 0.5) * Double(HEAT_SCALE) - Double(dx)
            if docX < 0 || docX >= Double(field.width) { continue }
            next.cells[cy * next.gridWidth + cx] = sampleHeatAt(field, docX, docY)
        }
    }
    next.revision = field.revision + 1
    _ = heatStats(next)
    return next
}

/// Tile cache for thermochromic colour shifting on one layer.
public final class ThermoCache {
    private var tiles: [TileKey: (cId: ObjectIdentifier, tId: ObjectIdentifier, ox: Int, oy: Int, rev: Int, tile: Tile)] = [:]

    public init() {}

    public func render(_ color: TiledSurface, _ thermo: TiledSurface?, _ offset: LayerOffset, _ heat: HeatField) -> TiledSurface {
        guard let thermo, !thermo.tiles.isEmpty else { return color }
        guard heat.cells.contains(where: { $0 > 0 }) else { return color }
        var out = color.tiles
        let keySet = Set(color.tiles.keys)
        for (key, cTile) in color.tiles {
            guard let tTile = thermo.tiles.get(key) else { continue }
            let cId = ObjectIdentifier(cTile)
            let tId = ObjectIdentifier(tTile)
            if let cached = tiles[key], cached.cId == cId, cached.tId == tId, cached.ox == offset.x, cached.oy == offset.y, cached.rev == heat.revision {
                out.set(key, cached.tile)
                continue
            }
            let (tx, ty) = tileCoord(key)
            let cd = expand4(cTile)
            let td = expand4(tTile)
            var dst = cd
            let band = 0.12
            for y in 0..<TILE {
                let docY = Double(ty * TILE + y + offset.y) + 0.5
                for x in 0..<TILE {
                    let i = (y * TILE + x) * 4
                    let ca = cd[i + 3]
                    let thByte = td[i + 3]
                    if ca == 0 || thByte == 0 { continue }
                    let docX = Double(tx * TILE + x + offset.x) + 0.5
                    let temp = sampleHeatAt(heat, docX, docY)
                    if temp <= 0 { continue }
                    let threshold = Double(thByte) / 255
                    let u = Swift.min(1, Swift.max(0, (temp - (threshold - band)) / (2 * band)))
                    let t = u * u * (3 - 2 * u)
                    if t <= 0 { continue }
                    dst[i] = JS.u8c(JS.round(Double(cd[i]) * (1 - t) + Double(td[i]) * t))
                    dst[i + 1] = JS.u8c(JS.round(Double(cd[i + 1]) * (1 - t) + Double(td[i + 1]) * t))
                    dst[i + 2] = JS.u8c(JS.round(Double(cd[i + 2]) * (1 - t) + Double(td[i + 2]) * t))
                }
            }
            let shaded = Tile(data: dst, uniform: nil)
            tiles[key] = (cId, tId, offset.x, offset.y, heat.revision, shaded)
            out.set(key, shaded)
        }
        for k in Array(tiles.keys) where !keySet.contains(k) { tiles[k] = nil }
        return TiledSurface(channels: 4, tiles: out, defaultValue: color.defaultValue)
    }
}

func fluorToJSON(_ fluor: TiledSurface?) -> JSONValue? {
    guard let fluor, let b = fluor.bounds else { return nil }
    return ["rect": b.json, "fluor": .string(pngDataUrl(b.width, b.height, readRegion(fluor, b), 4))]
}

func thermoToJSON(_ thermo: TiledSurface?) -> JSONValue? {
    guard let thermo, let b = thermo.bounds else { return nil }
    return ["rect": b.json, "thermo": .string(pngDataUrl(b.width, b.height, readRegion(thermo, b), 4))]
}

func heatToJSON(_ field: HeatField?) -> JSONValue? {
    guard let field, field.cells.contains(where: { $0 > 0 }) else { return nil }
    return [
        "gridWidth": .number(Double(field.gridWidth)),
        "gridHeight": .number(Double(field.gridHeight)),
        "cells": .array(field.cells.map { .number(JS.round($0 * 10000) / 10000) }),
    ]
}

func heatFromJSON(_ raw: JSONValue?, width: Int, height: Int) -> HeatField? {
    guard let r = raw?.objectValue,
          let gw = r["gridWidth"]?.finite.map({ Int(JS.round($0)) }),
          let gh = r["gridHeight"]?.finite.map({ Int(JS.round($0)) }),
          let cells = r["cells"]?.arrayValue else {
        return nil
    }
    let field = createHeatField(width, height)
    if gw == field.gridWidth && gh == field.gridHeight && cells.count == field.cells.count {
        for i in 0..<field.cells.count {
            let v = cells[i].finite ?? 0
            field.cells[i] = Swift.min(1, Swift.max(0, v))
        }
        field.revision = 1
        _ = heatStats(field)
    }
    return field
}

extension PaintDocumentState {
    func settingFluor(_ layerId: String, _ next: TiledSurface?) {
        guard let next else { return }
        var out = fluor ?? OrderedMap()
        if !next.tiles.isEmpty { out.set(layerId, next) } else { _ = out.delete(layerId) }
        fluor = out
    }

    func removingFluor(_ ids: [String]) {
        guard var f = fluor, ids.contains(where: { f.has($0) }) else { return }
        for id in ids { _ = f.delete(id) }
        fluor = f
    }

    func settingThermo(_ layerId: String, _ next: TiledSurface?) {
        guard let next else { return }
        var out = thermo ?? OrderedMap()
        if !next.tiles.isEmpty { out.set(layerId, next) } else { _ = out.delete(layerId) }
        thermo = out
    }

    func removingThermo(_ ids: [String]) {
        guard var t = thermo, ids.contains(where: { t.has($0) }) else { return }
        for id in ids { _ = t.delete(id) }
        thermo = t
    }
}
