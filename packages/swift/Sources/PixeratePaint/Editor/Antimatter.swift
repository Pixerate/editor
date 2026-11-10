import Foundation
import PixerateCore
import PixerateRaster

/**
 * Antimatter paint (`paint-editor/antimatter.ts`): animated blasts that detonate where the brush
 * touches paint across any visible layer, inverting colours in the core, removing alpha, burning a
 * soot ring around the crater, denting thick relief, clearing core light, and throwing white-hot
 * ballistic sparks on the active layer.
 */

private let COVERAGE_STEPS = 4096.0

/// One detonation along an antimatter stroke.
public struct AntimatterBlast {
    public var index: Int
    public var x: Double
    public var y: Double
    public var radius: Double
    public var tipSize: Double
    public var tipOpacity: Double
    public var fuel: Double
    public var seed: Int
    public var color: (Int, Int, Int)
    public var lightAmount: Double
    public var sparkCount: Int
    public var t: Double
}

/// Summary returned on `PaintStrokeResult.antimatter`.
public struct AntimatterStats: Equatable, Sendable {
    public var blasts: Int
    public var sparks: Int
    public var fuel: Double
    public var layers: [String]
    public var skippedLayers: [String]

    public var json: JSONValue {
        [
            "blasts": .number(Double(blasts)),
            "sparks": .number(Double(sparks)),
            "fuel": .number(fuel),
            "layers": .array(layers.map { .string($0) }),
            "skippedLayers": .array(skippedLayers.map { .string($0) }),
        ]
    }
}

/// One visible layer that supplies fuel to the antimatter stroke (and is edited if `editable`).
public struct AntimatterTarget {
    public var id: String
    public var editable: Bool
    public var lockTransparency: Bool
    public var opacity: Double
    public var offset: LayerOffset
    public var base: TiledSurface
    public var baseLight: TiledSurface?
    public var baseThick: ThickChannels?
}

/// Per-layer output surfaces produced by `AntimatterStrokeDriver`.
public struct AntimatterLayerOutput {
    public var id: String
    public var surface: TiledSurface
    public var light: TiledSurface?
    public var thick: ThickChannels?
    public var changed: Bool
}

public struct AntimatterStrokeInit {
    public var activeLayerId: String
    public var targets: [AntimatterTarget]
    public var brush: PaintBrush
    public var color: [Int]
    public var seed: Int
    var copies: [StrokeCopy]
    public var selection: PaintSelection?
    public var paint: PaintGradientSource?
    public var effect: EffectPaintPixels?
}

private func sameTile(_ a: Tile?, _ b: Tile?) -> Bool {
    if a == nil && b == nil { return true }
    guard let a, let b else { return false }
    return a.data == b.data
}

/// Smooth 2D value noise in `0..1` using only `JS.floor` and `PixerateRandom.hash2`.
func blastNoise2D(_ ux: Double, _ uy: Double, _ salt: Int) -> Double {
    let x0 = JS.floor(ux)
    let y0 = JS.floor(uy)
    let fx = ux - x0
    let fy = uy - y0
    let tx = fx * fx * (3 - 2 * fx)
    let ty = fy * fy * (3 - 2 * fy)
    let ix0 = Int(x0)
    let iy0 = Int(y0)
    let n00 = PixerateRandom.hash2(ix0, iy0, salt)
    let n10 = PixerateRandom.hash2(ix0 + 1, iy0, salt)
    let n01 = PixerateRandom.hash2(ix0, iy0 + 1, salt)
    let n11 = PixerateRandom.hash2(ix0 + 1, iy0 + 1, salt)
    let a = n00 + (n10 - n00) * tx
    let b = n01 + (n11 - n01) * tx
    return a + (b - a) * ty
}

private func srgbToLinear(_ v: Double) -> Double {
    if v == 0 { return 0 }
    let sign: Double = v < 0 ? -1 : 1
    let a = abs(v)
    return sign * (a <= 0.04045 ? a / 12.92 : JS.pow((a + 0.055) / 1.055, 2.4))
}

private func linearToSrgb(_ v: Double) -> Double {
    if v == 0 { return 0 }
    let sign: Double = v < 0 ? -1 : 1
    let a = abs(v)
    return sign * (a <= 0.0031308 ? 12.92 * a : 1.055 * JS.pow(a, 1.0 / 2.4) - 0.055)
}

/// Inverts an 8-bit sRGB colour in OKLab space by flipping lightness `1 - L` and hue `(-a, -b)`.
func invertOklab8(_ r: Double, _ g: Double, _ b: Double) -> (Double, Double, Double) {
    let lr = srgbToLinear(r / 255)
    let lg = srgbToLinear(g / 255)
    let lb = srgbToLinear(b / 255)
    let l1 = JS.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
    let m1 = JS.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
    let s1 = JS.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
    let labL = 1 - (0.2104542553 * l1 + 0.7936177850 * m1 - 0.0040720468 * s1)
    let labA = -(1.9779984951 * l1 - 2.4285922050 * m1 + 0.4505937099 * s1)
    let labB = -(0.0259040371 * l1 + 0.7827717662 * m1 - 0.8086757660 * s1)
    let l_ = labL + 0.3963377774 * labA + 0.2158037573 * labB
    let m_ = labL - 0.1055613458 * labA - 0.0638541728 * labB
    let s_ = labL - 0.0894841775 * labA - 1.2914855480 * labB
    let l = l_ * l_ * l_
    let m = m_ * m_ * m_
    let s = s_ * s_ * s_
    let outR = linearToSrgb(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)
    let outG = linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)
    let outB = linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
    return (
        Swift.min(255, Swift.max(0, JS.round(outR * 255))),
        Swift.min(255, Swift.max(0, JS.round(outG * 255))),
        Swift.min(255, Swift.max(0, JS.round(outB * 255)))
    )
}

/// Core (`0..1`) and soot-ring (`0..1`) weights for a heat value `h` in `0..1`.
func heatProfile(_ h: Double) -> (core: Double, ring: Double) {
    if h <= 0 { return (0, 0) }
    let coreT = Swift.min(1, Swift.max(0, (h - 0.32) / 0.5))
    let core = coreT * coreT * (3 - 2 * coreT)
    let ringIn = Swift.min(1, Swift.max(0, h / 0.35))
    let ringOut = Swift.min(1, Swift.max(0, (0.82 - h) / 0.47))
    let ring = ringIn * ringOut * (3 - 2 * ringIn) * (3 - 2 * ringOut)
    return (core, ring)
}

private final class AntimatterCopyState {
    let walker: PenDabWalker
    let seed: Int
    var blastCount = 0
    var firedAny = false
    var travel = 0.0
    var fuelSum = 0.0
    var fuelDabs = 0
    var lastPos: (x: Double, y: Double)? = nil

    init(walker: PenDabWalker, seed: Int) {
        self.walker = walker
        self.seed = seed
    }
}

public final class AntimatterStrokeDriver {
    public var dabCount = 0
    public var bounds: RasterRect? = nil
    public private(set) var blasts: [AntimatterBlast] = []
    public let initValues: AntimatterStrokeInit
    private let smoother: PenSmoother
    private let copies: [StrokeCopy]
    private let states: [AntimatterCopyState]
    private let sampler: PaintGradientSampler?
    private var heat: [TileKey: [Float]] = [:]
    private var heatOrder: [TileKey] = []
    private var heatCoords: [TileKey: (tx: Int, ty: Int)] = [:]
    private var tipBuf: [Float] = []
    private var lastRaw: PenPoint? = nil
    private var lastFed: PenPoint? = nil
    private var totalFuel = 0.0
    private var reachedSkipped: Set<String> = []
    private var editedIds: Set<String> = []
    private var outputs: [String: AntimatterLayerOutput] = [:]

    public init(_ initValues: AntimatterStrokeInit) {
        self.initValues = initValues
        let brush = initValues.brush
        smoother = PenSmoother(brush.tip.smoothing, brush.pressureSmoothing)
        copies = initValues.copies.isEmpty ? [IDENTITY_COPY] : initValues.copies
        states = copies.enumerated().map { i, c in
            let seed = Int(Int32(truncatingIfNeeded: initValues.seed + i * 9973))
            return AntimatterCopyState(walker: PenDabWalker(brush, seed, c.linear), seed: seed)
        }
        if var g = initValues.paint {
            if g.map.by == "across-tip" {
                g.map = PaintGradientMapping(by: "distance", length: 300, repeat: "mirror")
            }
            sampler = PaintGradientSampler(g, seed: initValues.seed)
        } else {
            sampler = nil
        }
    }

    public func push(_ points: [PenPoint]) -> [RasterRect] {
        var rects: [RasterRect] = []
        for raw in points {
            lastRaw = raw
            let p = smoother.push(raw)
            lastFed = p
            let tNow = (raw.t?.isFinite == true) ? raw.t! : 0
            for (i, c) in copies.enumerated() {
                var dabs: [PenDab] = []
                states[i].walker.push(c.map(p), &dabs)
                processDabs(i, dabs, tNow, &rects)
            }
        }
        if !rects.isEmpty { recompositeAll() }
        return rects
    }

    public func finish() -> [RasterRect] {
        var rects: [RasterRect] = []
        let tNow = (lastRaw?.t?.isFinite == true) ? lastRaw!.t! : 0
        for (i, c) in copies.enumerated() {
            var dabs: [PenDab] = []
            if let raw = lastRaw, let fed = lastFed, raw.x != fed.x || raw.y != fed.y {
                var q = raw
                q.pressure = fed.pressure
                states[i].walker.push(c.map(q), &dabs)
            }
            states[i].walker.finish(&dabs)
            processDabs(i, dabs, tNow, &rects)
        }
        if !rects.isEmpty { recompositeAll() }
        return rects
    }

    private func processDabs(_ copyIdx: Int, _ dabs: [PenDab], _ tNow: Double, _ rects: inout [RasterRect]) {
        let st = states[copyIdx]
        let settings = initValues.brush.antimatter
        for d in dabs {
            dabCount += 1
            let stepDist = st.lastPos.map { JS.hypot(d.dab.x - $0.x, d.dab.y - $0.y) / Swift.max(1, d.dab.radius * 2) } ?? 0
            st.lastPos = (d.dab.x, d.dab.y)
            let dabFuel = measureFuel(d)
            if !st.firedAny {
                if dabFuel >= settings.threshold && dabFuel > 0 {
                    st.firedAny = true
                    st.travel = 0
                    st.fuelSum = 0
                    st.fuelDabs = 0
                    rects.append(fireBlast(st, d, dabFuel, tNow))
                }
                continue
            }
            st.travel += stepDist
            if dabFuel > 0 {
                st.fuelSum += dabFuel
                st.fuelDabs += 1
            }
            if st.travel >= settings.blastSpacing {
                let meanFuel = st.fuelDabs > 0 ? st.fuelSum / Double(st.fuelDabs) : dabFuel
                if meanFuel >= settings.threshold && meanFuel > 0 && dabFuel > 0 {
                    st.travel = 0
                    st.fuelSum = 0
                    st.fuelDabs = 0
                    rects.append(fireBlast(st, d, Swift.min(1, meanFuel), tNow))
                } else if dabFuel < settings.threshold {
                    st.fuelSum = 0
                    st.fuelDabs = 0
                }
            }
        }
    }

    private func measureFuel(_ d: PenDab) -> Double {
        let rect = dabRect(d.dab, initValues.brush.tip.hardness)
        if rect.width <= 0 || rect.height <= 0 { return 0 }
        let n = rect.width * rect.height
        var flat = d.dab
        flat.alpha = 1
        var tip = [Float](repeating: 0, count: n)
        rasterizeDab(flat, initValues.brush.tip.hardness, rect, &tip)
        let mask = initValues.selection
        let targets = initValues.targets
        var sum = 0.0
        var activePixels = 0
        var k = 0
        for yy in 0..<rect.height {
            let py = rect.y + yy
            for xx in 0..<rect.width {
                var rawC = Double(tip[k])
                k += 1
                if rawC <= 0 { continue }
                let px = rect.x + xx
                if let mask {
                    rawC *= (px >= 0 && py >= 0 && px < mask.width && py < mask.height) ? Double(mask.data[py * mask.width + px]) / 255 : 0
                }
                let c = JS.round(rawC * COVERAGE_STEPS) / COVERAGE_STEPS
                if c <= 0 { continue }
                activePixels += 1
                var prod = 1.0
                for t in targets where t.opacity > 0 {
                    let lx = px - t.offset.x
                    let ly = py - t.offset.y
                    let tx = Int(JS.floor(Double(lx) / Double(TILE)))
                    let ty = Int(JS.floor(Double(ly) / Double(TILE)))
                    guard let tile = t.base.tiles.get(tileKey(tx, ty)) else { continue }
                    let ox = lx - tx * TILE
                    let oy = ly - ty * TILE
                    let a = Double(tile.data[(oy * TILE + ox) * 4 + 3]) / 255
                    if a > 0 { prod *= 1 - a * t.opacity }
                }
                let combinedAlpha = 1 - prod
                if combinedAlpha > 0 { sum += c * combinedAlpha }
            }
        }
        if activePixels == 0 || sum <= 0 { return 0 }
        return JS.round((sum / Double(activePixels)) * COVERAGE_STEPS) / COVERAGE_STEPS
    }

    private func fireBlast(_ st: AntimatterCopyState, _ d: PenDab, _ fuel: Double, _ tNow: Double) -> RasterRect {
        let brush = initValues.brush
        let settings = brush.antimatter
        let blastIndex = st.blastCount
        st.blastCount += 1
        let tipRadius = Swift.max(1, d.dab.radius)
        let fuelScale = 0.55 + 0.65 * fuel.squareRoot()
        let jitter = 0.88 + 0.24 * PixerateRandom.rand01(st.seed, blastIndex, 17)
        let radius = Swift.max(2, tipRadius * settings.blastRadius * fuelScale * jitter)
        var sparkRgb = (initValues.color[0], initValues.color[1], initValues.color[2])
        var flow = 1.0
        if let effect = initValues.effect {
            let e = sampleEffectAt(effect, d.dab.x, d.dab.y, EffectDabPlace(d))
            sparkRgb = (Int(JS.round(e.rgb[0] * 255)), Int(JS.round(e.rgb[1] * 255)), Int(JS.round(e.rgb[2] * 255)))
            flow = e.alpha
        } else if let sampler {
            let g = sampler.dab(d.params)
            sparkRgb = (Int(JS.round(g.rgb[0] * 255)), Int(JS.round(g.rgb[1] * 255)), Int(JS.round(g.rgb[2] * 255)))
            flow = g.alpha
        }
        let tipOpacity = Swift.min(1, d.dab.alpha * d.dab.opacity * brush.tip.opacity * flow)
        let lightAmount = brush.light.amount * (brush.light.pressure ? d.pressure : 1)
        let sparkCount = settings.sparks > 0 ? Swift.max(1, Int(JS.round(settings.sparks * (6 + 10 * fuel)))) : 0
        let blast = AntimatterBlast(
            index: blastIndex,
            x: d.dab.x,
            y: d.dab.y,
            radius: radius,
            tipSize: d.dab.radius * 2,
            tipOpacity: tipOpacity,
            fuel: fuel,
            seed: st.seed,
            color: sparkRgb,
            lightAmount: lightAmount,
            sparkCount: sparkCount,
            t: tNow
        )
        blasts.append(blast)
        totalFuel += fuel
        let rect = writeBlastToHeat(blast, &heat, &heatOrder, &heatCoords, 1)
        bounds = unionRect(bounds, rect)
        return rect
    }

    private func writeBlastToHeat(
        _ b: AntimatterBlast,
        _ heatMap: inout [TileKey: [Float]],
        _ order: inout [TileKey],
        _ coordMap: inout [TileKey: (tx: Int, ty: Int)],
        _ progress: Double
    ) -> RasterRect {
        let expand = 1 - (1 - progress) * (1 - progress)
        let effRadius = b.radius * (0.2 + 0.8 * expand)
        let maxR = JS.ceil(effRadius * 1.22)
        let x0 = Int(JS.floor(b.x - maxR))
        let y0 = Int(JS.floor(b.y - maxR))
        let x1 = Int(JS.ceil(b.x + maxR))
        let y1 = Int(JS.ceil(b.y + maxR))
        let salt = Int(Int32(truncatingIfNeeded: b.seed + b.index * 4099))
        let mask = initValues.selection
        let targets = initValues.targets
        for py in y0...y1 {
            let dy = Double(py) + 0.5 - b.y
            if abs(dy) > effRadius * 1.2 { continue }
            for px in x0...x1 {
                let dx = Double(px) + 0.5 - b.x
                let dist = JS.hypot(dx, dy)
                if dist > effRadius * 1.2 { continue }
                var maskA = 1.0
                if let mask {
                    if px < 0 || py < 0 || px >= mask.width || py >= mask.height { continue }
                    maskA = Double(mask.data[py * mask.width + px]) / 255
                    if maskA <= 0 { continue }
                }
                let rNorm = dist / effRadius
                let n = blastNoise2D((dx / effRadius) * 2.5, (dy / effRadius) * 2.5, salt) - 0.5
                let rWarped = rNorm + n * 0.22 * Swift.min(1, rNorm * 1.5)
                if rWarped >= 1 { continue }
                let t = 1 - rWarped
                let h = Float(t * t * (3 - 2 * t) * b.tipOpacity * maskA)
                if h <= 0 { continue }
                let tx = Int(JS.floor(Double(px) / Double(TILE)))
                let ty = Int(JS.floor(Double(py) / Double(TILE)))
                let key = tileKey(tx, ty)
                if heatMap[key] == nil {
                    heatMap[key] = [Float](repeating: 0, count: TILE * TILE)
                    order.append(key)
                    coordMap[key] = (tx, ty)
                }
                let idx = (py - ty * TILE) * TILE + (px - tx * TILE)
                if h > heatMap[key]![idx] {
                    heatMap[key]![idx] = h
                }
                if progress >= 1 {
                    for tgt in targets {
                        if tgt.editable || reachedSkipped.contains(tgt.id) { continue }
                        let lx = px - tgt.offset.x
                        let ly = py - tgt.offset.y
                        let ltx = Int(JS.floor(Double(lx) / Double(TILE)))
                        let lty = Int(JS.floor(Double(ly) / Double(TILE)))
                        if let lt = tgt.base.tiles.get(tileKey(ltx, lty)), lt.data[((ly - lty * TILE) * TILE + (lx - ltx * TILE)) * 4 + 3] > 0 {
                            reachedSkipped.insert(tgt.id)
                        }
                    }
                }
            }
        }
        let sparkPad = b.sparkCount > 0 ? JS.ceil(b.tipSize * initValues.brush.antimatter.sparkReach * 1.3 + 4) : 0
        let reachR = Swift.max(maxR, JS.ceil(b.radius * 0.6 + sparkPad))
        return RasterRect(
            x: Int(JS.floor(b.x - reachR)),
            y: Int(JS.floor(b.y - reachR)),
            width: Int(JS.ceil(reachR * 2)) + 1,
            height: Int(JS.ceil(reachR * 2)) + 1
        )
    }

    private func recompositeAll() {
        outputs.removeAll()
        editedIds.removeAll()
        let built = buildOutputs(heat, heatOrder, heatCoords) { _ in 1 }
        for out in built {
            outputs[out.id] = out
            if out.changed { editedIds.insert(out.id) }
        }
    }

    private func buildOutputs(
        _ heatMap: [TileKey: [Float]],
        _ order: [TileKey],
        _ coordMap: [TileKey: (tx: Int, ty: Int)],
        _ progressOf: (AntimatterBlast) -> Double
    ) -> [AntimatterLayerOutput] {
        let settings = initValues.brush.antimatter
        let activeId = initValues.activeLayerId
        var outList: [AntimatterLayerOutput] = []
        for tgt in initValues.targets where tgt.editable {
            let isActive = tgt.id == activeId
            let offX = tgt.offset.x
            let offY = tgt.offset.y
            var tiles = tgt.base.tiles
            var lightTiles = tgt.baseLight?.tiles ?? OrderedMap()
            let heightTiles = tgt.baseThick?.height.tiles
            var touchedTiles: [TileKey: [UInt8]] = [:]
            var touchedOrder: [TileKey] = []
            var touchedLight: [TileKey: [UInt8]] = [:]
            var touchedLightOrder: [TileKey] = []
            var touchedHeight: [TileKey: [UInt8]] = [:]
            var touchedHeightOrder: [TileKey] = []

            func ensureLayerTile(_ ltx: Int, _ lty: Int) -> TileKey {
                let lk = tileKey(ltx, lty)
                if touchedTiles[lk] == nil {
                    touchedTiles[lk] = tgt.base.tiles.get(lk)?.data ?? [UInt8](repeating: 0, count: TILE * TILE * 4)
                    touchedOrder.append(lk)
                }
                return lk
            }
            func ensureLightTile(_ ltx: Int, _ lty: Int) -> TileKey {
                let lk = tileKey(ltx, lty)
                if touchedLight[lk] == nil {
                    touchedLight[lk] = tgt.baseLight?.tiles.get(lk)?.data ?? [UInt8](repeating: 0, count: TILE * TILE)
                    touchedLightOrder.append(lk)
                }
                return lk
            }
            func ensureHeightTile(_ ltx: Int, _ lty: Int) -> TileKey {
                let lk = tileKey(ltx, lty)
                if touchedHeight[lk] == nil {
                    touchedHeight[lk] = tgt.baseThick?.height.tiles.get(lk)?.data ?? [UInt8](repeating: 0, count: TILE * TILE)
                    touchedHeightOrder.append(lk)
                }
                return lk
            }

            for hk in order {
                guard let hData = heatMap[hk], let (dtx, dty) = coordMap[hk] else { continue }
                let docOx = dtx * TILE
                let docOy = dty * TILE
                for oy in 0..<TILE {
                    let py = docOy + oy
                    let ly = py - offY
                    let lty = Int(JS.floor(Double(ly) / Double(TILE)))
                    let loy = ly - lty * TILE
                    for ox in 0..<TILE {
                        let h = Double(hData[oy * TILE + ox])
                        if h <= 0 { continue }
                        let px = docOx + ox
                        let lx = px - offX
                        let ltx = Int(JS.floor(Double(lx) / Double(TILE)))
                        let lox = lx - ltx * TILE
                        let lk = tileKey(ltx, lty)
                        let lIdx = loy * TILE + lox
                        let pIdx = lIdx * 4
                        let srcTile = tgt.base.tiles.get(lk)
                        let a0 = srcTile.map { Int($0.data[pIdx + 3]) } ?? 0
                        let (core, ring) = heatProfile(h)
                        if a0 > 0 || (isActive && !tgt.lockTransparency && ring * settings.scorch > 0) {
                            let tk = ensureLayerTile(ltx, lty)
                            var r = Double(srcTile.map { Int($0.data[pIdx]) } ?? 0)
                            var g = Double(srcTile.map { Int($0.data[pIdx + 1]) } ?? 0)
                            var b = Double(srcTile.map { Int($0.data[pIdx + 2]) } ?? 0)
                            var a = a0
                            let aNorm = Double(a0) / 255
                            if a0 > 0 {
                                let invAmt = core * settings.invert
                                if invAmt > 0 {
                                    let (ir, ig, ib): (Double, Double, Double) = settings.invertMode == "oklab" ? invertOklab8(r, g, b) : (255 - r, 255 - g, 255 - b)
                                    r = r + (ir - r) * invAmt
                                    g = g + (ig - g) * invAmt
                                    b = b + (ib - b) * invAmt
                                }
                                let scorchAmt = ring * settings.scorch
                                if scorchAmt > 0 {
                                    let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
                                    let desat = Swift.min(1, scorchAmt * 0.85)
                                    let sr = r + (lum * 0.85 + 2.7 - r) * desat
                                    let sg = g + (lum * 0.85 + 2.1 - g) * desat
                                    let sb = b + (lum * 0.85 + 1.8 - b) * desat
                                    let keep = 1 - scorchAmt * 0.78
                                    r = sr * keep
                                    g = sg * keep
                                    b = sb * keep
                                }
                                if !tgt.lockTransparency && settings.annihilate > 0 && core > 0 {
                                    a = Int(JS.round(Double(a0) * (1 - core * settings.annihilate)))
                                    if a <= 0 { r = 0; g = 0; b = 0; a = 0 }
                                }
                            }
                            if isActive && !tgt.lockTransparency && ring * settings.scorch > 0 && a < 255 {
                                let sootA = Int(JS.round(ring * settings.scorch * 96 * (1 - aNorm)))
                                if sootA > 0 {
                                    let sa = Double(sootA) / 255
                                    let da = Double(a) / 255
                                    let outA = da + sa * (1 - da)
                                    if outA > 0 {
                                        r = (r * da + 20 * sa * (1 - da)) / outA
                                        g = (g * da + 16 * sa * (1 - da)) / outA
                                        b = (b * da + 14 * sa * (1 - da)) / outA
                                        a = Int(JS.round(outA * 255))
                                    }
                                }
                            }
                            touchedTiles[tk]![pIdx] = UInt8(Swift.min(255, Swift.max(0, Int(JS.round(r)))))
                            touchedTiles[tk]![pIdx + 1] = UInt8(Swift.min(255, Swift.max(0, Int(JS.round(g)))))
                            touchedTiles[tk]![pIdx + 2] = UInt8(Swift.min(255, Swift.max(0, Int(JS.round(b)))))
                            touchedTiles[tk]![pIdx + 3] = UInt8(Swift.min(255, Swift.max(0, a)))
                        }
                        if let baseLight = tgt.baseLight, core > 0 {
                            let l0 = baseLight.tiles.get(lk).map { Int($0.data[lIdx]) } ?? 0
                            if l0 > 0 {
                                let ltk = ensureLightTile(ltx, lty)
                                touchedLight[ltk]![lIdx] = UInt8(Swift.min(255, Swift.max(0, Int(JS.round(Double(l0) * (1 - core))))))
                            }
                        }
                        if let baseThick = tgt.baseThick, settings.crater > 0 && (core > 0 || ring > 0) {
                            let h0 = baseThick.height.tiles.get(lk).map { Int($0.data[lIdx]) } ?? 0
                            if h0 > 0 || a0 > 0 {
                                let htk = ensureHeightTile(ltx, lty)
                                let aNorm = Double(a0) / 255
                                let nextH = Int(JS.round(
                                    Double(h0) * (1 - core * settings.crater * 0.85) -
                                    core * settings.crater * 40 +
                                    ring * settings.crater * 72 * aNorm
                                ))
                                touchedHeight[htk]![lIdx] = UInt8(Swift.min(255, Swift.max(0, nextH)))
                            }
                        }
                    }
                }
            }

            if isActive {
                drawActiveExtras(tgt, &touchedTiles, &touchedOrder, &touchedLight, &touchedLightOrder, progressOf)
            }

            var changed = false
            for lk in touchedOrder {
                let ft = finishTile(touchedTiles[lk]!, 4, 0)
                let prev = tgt.base.tiles.get(lk)
                if let ft { tiles.set(lk, ft) } else { _ = tiles.delete(lk) }
                if !sameTile(prev, ft) { changed = true }
            }
            var lightOut: TiledSurface? = nil
            var lightChanged = false
            for lk in touchedLightOrder {
                let ft = finishTile(touchedLight[lk]!, 1, 0)
                let prev = tgt.baseLight?.tiles.get(lk)
                if let ft { lightTiles.set(lk, ft) } else { _ = lightTiles.delete(lk) }
                if !sameTile(prev, ft) { lightChanged = true }
            }
            if lightChanged {
                changed = true
                lightOut = TiledSurface(channels: 1, tiles: lightTiles, defaultValue: 0)
            }
            var thickOut: ThickChannels? = nil
            if var hTiles = heightTiles, let baseThick = tgt.baseThick {
                var heightChanged = false
                for lk in touchedHeightOrder {
                    let ft = finishTile(touchedHeight[lk]!, 1, 0)
                    let prev = baseThick.height.tiles.get(lk)
                    if let ft { hTiles.set(lk, ft) } else { _ = hTiles.delete(lk) }
                    if !sameTile(prev, ft) { heightChanged = true }
                }
                if heightChanged {
                    changed = true
                    thickOut = ThickChannels(height: TiledSurface(channels: 1, tiles: hTiles, defaultValue: 0), material: baseThick.material, film: baseThick.film)
                }
            }
            outList.append(AntimatterLayerOutput(
                id: tgt.id,
                surface: changed ? TiledSurface(channels: 4, tiles: tiles, defaultValue: 0) : tgt.base,
                light: lightOut,
                thick: thickOut,
                changed: changed
            ))
        }
        return outList
    }

    private func drawActiveExtras(
        _ tgt: AntimatterTarget,
        _ touchedTiles: inout [TileKey: [UInt8]],
        _ touchedOrder: inout [TileKey],
        _ touchedLight: inout [TileKey: [UInt8]],
        _ touchedLightOrder: inout [TileKey],
        _ progressOf: (AntimatterBlast) -> Double
    ) {
        let selection = initValues.selection
        let reachFactor = initValues.brush.antimatter.sparkReach
        let offX = tgt.offset.x
        let offY = tgt.offset.y

        func blendPixel(_ px: Int, _ py: Int, _ sr: Double, _ sg: Double, _ sb: Double, _ sa: Double, _ lightVal: Double) {
            if sa <= 0 { return }
            var maskA = 1.0
            if let selection {
                if px < 0 || py < 0 || px >= selection.width || py >= selection.height { return }
                maskA = Double(selection.data[py * selection.width + px]) / 255
                if maskA <= 0 { return }
            }
            let lx = px - offX
            let ly = py - offY
            let ltx = Int(JS.floor(Double(lx) / Double(TILE)))
            let lty = Int(JS.floor(Double(ly) / Double(TILE)))
            let lox = lx - ltx * TILE
            let loy = ly - lty * TILE
            let lIdx = loy * TILE + lox
            let pIdx = lIdx * 4
            let lk = tileKey(ltx, lty)
            if touchedTiles[lk] == nil {
                touchedTiles[lk] = tgt.base.tiles.get(lk)?.data ?? [UInt8](repeating: 0, count: TILE * TILE * 4)
                touchedOrder.append(lk)
            }
            let da = Double(touchedTiles[lk]![pIdx + 3]) / 255
            if tgt.lockTransparency && da <= 0 { return }
            let srcA = Swift.min(1, sa * maskA)
            let outA = tgt.lockTransparency ? da : da + srcA * (1 - da)
            if outA <= 0 { return }
            let w = tgt.lockTransparency ? srcA : srcA / outA
            let dr = Double(touchedTiles[lk]![pIdx])
            let dg = Double(touchedTiles[lk]![pIdx + 1])
            let db = Double(touchedTiles[lk]![pIdx + 2])
            touchedTiles[lk]![pIdx] = UInt8(Swift.min(255, Swift.max(0, Int(JS.round(dr * (1 - w) + sr * w)))))
            touchedTiles[lk]![pIdx + 1] = UInt8(Swift.min(255, Swift.max(0, Int(JS.round(dg * (1 - w) + sg * w)))))
            touchedTiles[lk]![pIdx + 2] = UInt8(Swift.min(255, Swift.max(0, Int(JS.round(db * (1 - w) + sb * w)))))
            if !tgt.lockTransparency {
                touchedTiles[lk]![pIdx + 3] = UInt8(Swift.min(255, Swift.max(0, Int(JS.round(outA * 255)))))
            }
            if lightVal > 0 {
                if touchedLight[lk] == nil {
                    touchedLight[lk] = tgt.baseLight?.tiles.get(lk)?.data ?? [UInt8](repeating: 0, count: TILE * TILE)
                    touchedLightOrder.append(lk)
                }
                let curL = Int(touchedLight[lk]![lIdx])
                let nextL = Swift.min(255, curL + Int(JS.round(lightVal * maskA * 255)))
                if nextL > curL {
                    touchedLight[lk]![lIdx] = UInt8(nextL)
                }
            }
        }

        for b in blasts {
            let progress = Swift.max(0, Swift.min(1, progressOf(b)))
            if progress <= 0 { continue }
            let seed = b.seed
            let bi = b.index
            let cr = Double(b.color.0), cg = Double(b.color.1), cb = Double(b.color.2)
            let baseAlpha = b.tipOpacity

            for si in 0..<b.sparkCount {
                let angle = PixerateRandom.rand01(seed, bi * 64 + si, 31) * Double.pi * 2
                let speed = 0.45 + 0.85 * PixerateRandom.rand01(seed, bi * 64 + si, 37)
                let curve = (PixerateRandom.rand01(seed, bi * 64 + si, 41) - 0.5) * 0.45
                let dist = b.tipSize * reachFactor * speed * progress
                let startR = b.radius * (0.2 + 0.25 * PixerateRandom.rand01(seed, bi * 64 + si, 43))
                let steps = Swift.max(2, Int(JS.ceil(dist * 1.5)))
                let ux = JS.round(JS.cos(angle) * 65536) / 65536
                let uy = JS.round(JS.sin(angle) * 65536) / 65536
                let nx = -uy
                let ny = ux
                for st in 0...steps {
                    let u = Double(st) / Double(steps)
                    let d = startR + u * dist
                    let bend = curve * u * u * dist * 0.35
                    let sx = Int(JS.round(b.x + ux * d + nx * bend))
                    let sy = Int(JS.round(b.y + uy * d + ny * bend))
                    let cool = Swift.min(1, u * 1.15)
                    let sr = 255 + (cr - 255) * cool
                    let sg = 252 + (cg - 252) * cool
                    let sb = 240 + (cb - 240) * cool
                    let fade = (1 - u * 0.72) * baseAlpha
                    let lightHit = b.lightAmount > 0 ? b.lightAmount * (1 - u * 0.65) : 0
                    blendPixel(sx, sy, sr, sg, sb, fade, lightHit)
                }
            }
        }
    }

    public func layerOutputs() -> [AntimatterLayerOutput] {
        var list: [AntimatterLayerOutput] = []
        for tgt in initValues.targets where tgt.editable {
            if let out = outputs[tgt.id] { list.append(out) }
        }
        return list
    }

    public func stats() -> AntimatterStats {
        var layers: [String] = []
        var skippedLayers: [String] = []
        for tgt in initValues.targets {
            if tgt.editable {
                if editedIds.contains(tgt.id) { layers.append(tgt.id) }
            } else if reachedSkipped.contains(tgt.id) {
                skippedLayers.append(tgt.id)
            }
        }
        let sparks = blasts.reduce(0) { $0 + $1.sparkCount }
        return AntimatterStats(
            blasts: blasts.count,
            sparks: sparks,
            fuel: JS.round(totalFuel * 10000) / 10000,
            layers: layers,
            skippedLayers: skippedLayers
        )
    }
}
